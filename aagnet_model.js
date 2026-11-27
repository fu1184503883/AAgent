/* AAGNet 前向传播（纯 JS，无依赖）
 * ---------------------------------------------------------------------------
 * 与 AAGNet-main/models 严格对齐：
 *   AAGNetSegmentor(arch='AAGNetGraphEncoder', node_attr_dim=10, edge_attr_dim=12,
 *                   node_attr_emb=64, edge_attr_emb=64, node_grid_dim=7, node_grid_emb=64,
 *                   edge_grid_dim=0, num_layers=3, delta=2, mlp_ratio=2, conv_on_edge=False)
 * 权重由 tools/pth2js.py 从 weights/weight_on_MFInstseg.pth 转换（0.4364 M 参数）。
 *
 * 两点容易踩的坑，已按实际权重实现：
 *   1) NodeMPNN 里 `MLP(2, node_dim, node_dim*ratio, node_dim, nn.LayerNorm, nn.Mish)` 是
 *      位置传参，nn.Mish 落到 last_norm 上，所以那层 MLP 的激活是 **ReLU**（不是 Mish），
 *      同时多出一个 post_norm。其余头用关键字传参，才是 Mish。
 *   2) PNA 的 scalers 只有一个 identity，源码里 scaler 循环被注释掉了，
 *      所以 h_neigh 只有 [sum, max] 两段（2×128），U 的输入是 3×128=384。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AAG_MODEL = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var F = null;           // 全部参数拼成的 Float32Array
  var IDX = null;         // name -> [offset, ...shape]
  var CACHE = {};

  /* ---------------------------------------------------------------- 权重 */
  function b64ToF32(b64) {
    var s, u8, i;
    if (typeof atob === 'function') {
      s = atob(b64);
      u8 = new Uint8Array(s.length);
      for (i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    } else {
      var buf = Buffer.from(b64, 'base64');
      u8 = new Uint8Array(buf);
    }
    return new Float32Array(u8.buffer, u8.byteOffset, u8.length >> 2);
  }

  function load(w) {
    if (F) return true;
    if (!w || !w.b64) return false;
    F = b64ToF32(w.b64);
    IDX = w.idx || {};
    return true;
  }

  function ready() { return !!F; }

  function T(name) {
    if (CACHE[name]) return CACHE[name];
    var meta = IDX[name];
    if (!meta) throw new Error('权重缺失: ' + name);
    var off = meta[0], shape = meta.slice(1);
    var n = 1;
    for (var i = 0; i < shape.length; i++) n *= shape[i];
    var t = { d: F.subarray(off, off + n), shape: shape, n: n };
    CACHE[name] = t;
    return t;
  }

  /* ---------------------------------------------------------------- 基础算子 */
  function mish(x) {
    // x * tanh(softplus(x))
    if (x > 20) return x;
    var sp = Math.log(1 + Math.exp(x));
    var e = Math.exp(2 * sp);
    return x * (e - 1) / (e + 1);
  }

  /* out[n*no + o] = b[o] + Σ_i W[o*ni + i] * x[n*ni + i] */
  function linear(x, n, ni, wt, bt, no) {
    var W = wt.d, out = new Float32Array(n * no), bias = bt ? bt.d : null;
    for (var r = 0; r < n; r++) {
      var xo = r * ni, oo = r * no;
      for (var o = 0; o < no; o++) {
        var wq = o * ni, s = bias ? bias[o] : 0;
        for (var i = 0; i < ni; i++) s += W[wq + i] * x[xo + i];
        out[oo + o] = s;
      }
    }
    return out;
  }

  function layerNorm(x, n, dim, wt, bt, eps) {
    eps = eps || 1e-5;
    var g = wt.d, b = bt.d, out = new Float32Array(n * dim);
    for (var r = 0; r < n; r++) {
      var o = r * dim, s = 0, i;
      for (i = 0; i < dim; i++) s += x[o + i];
      var m = s / dim, v = 0;
      for (i = 0; i < dim; i++) { var d = x[o + i] - m; v += d * d; }
      v /= dim;
      var inv = 1 / Math.sqrt(v + eps);
      for (i = 0; i < dim; i++) out[o + i] = (x[o + i] - m) * inv * g[i] + b[i];
    }
    return out;
  }

  /* BatchNorm：
   *   (N,C)            → dim=C，spatial=1
   *   (1,C,H,W) 展平    → dim=C*H*W，spatial=H*W
   * 通道号必须按 `floor((i % dim) / spatial)` 取，写成 `i % C` 会在 NCHW 下全错。 */
  function batchNorm(x, n, dim, wt, bt, mean, varr, eps, spatial) {
    eps = eps || 1e-5;
    spatial = spatial || 1;
    var out = new Float32Array(n * dim), g = wt.d, b = bt.d, mu = mean.d, va = varr.d;
    for (var r = 0; r < n; r++) {
      var o = r * dim;
      for (var i = 0; i < dim; i++) {
        var c = Math.floor(i / spatial);
        out[o + i] = (x[o + i] - mu[c]) / Math.sqrt(va[c] + eps) * g[c] + b[c];
      }
    }
    return out;
  }

  function actInPlace(x, kind) {
    for (var i = 0; i < x.length; i++) {
      var v = x[i];
      x[i] = kind === 'mish' ? mish(v) : (v > 0 ? v : 0);
    }
    return x;
  }

  function scaleVec(x, n, dim, wt) {
    var s = wt.d, out = new Float32Array(n * dim);
    for (var r = 0; r < n; r++) {
      var o = r * dim;
      for (var i = 0; i < dim; i++) out[o + i] = x[o + i] * s[i];
    }
    return out;
  }

  /* a*ka + b*kb（ka/kb 是「逐通道」的 scale 向量，长度 = dim，不是展平长度） */
  function addScaled(a, b, ka, kb) {
    var out = new Float32Array(a.length);
    var la = ka.length, lb = kb.length;
    for (var i = 0; i < a.length; i++) out[i] = a[i] * ka[i % la] + b[i] * kb[i % lb];
    return out;
  }

  /* MLP：num_layers 个 Linear，隐层 LN + act，最后可选 post_norm
   * 注意 num_layers==1 时 PyTorch 侧用的是 self.linear（不是 linears.0），键名不同 */
  function mlp(x, n, dims, P, act, lastNorm) {
    if (dims.length === 2) {
      var wa = T(P + 'linear.weight');
      var ba = IDX[P + 'linear.bias'] ? T(P + 'linear.bias') : null;
      var o = linear(x, n, dims[0], wa, ba, dims[1]);
      return lastNorm ? layerNorm(o, n, dims[1], T(P + 'post_norm.weight'), T(P + 'post_norm.bias')) : o;
    }
    var h = x;
    for (var L = 0; L < dims.length - 1; L++) {
      var w = T(P + 'linears.' + L + '.weight');
      var b = IDX[P + 'linears.' + L + '.bias'] ? T(P + 'linears.' + L + '.bias') : null;
      h = linear(h, n, dims[L], w, b, dims[L + 1]);
      // 只有非最后一层才有 norm
      if (L < dims.length - 2) {
        if (IDX[P + 'norms.' + L + '.weight']) {
          h = layerNorm(h, n, dims[L + 1], T(P + 'norms.' + L + '.weight'), T(P + 'norms.' + L + '.bias'));
        }
        actInPlace(h, act);
      }
    }
    if (lastNorm) h = layerNorm(h, n, dims[dims.length - 1], T(P + 'post_norm.weight'), T(P + 'post_norm.bias'));
    return h;
  }

  /* ------------------------------------------------- 面 UV 网格编码器（Conv2d 3×3 + BN + Mish + GAP） */
  var GU = 5, GV = 5;

  function conv3x3(src, inC, outC, wt, bt, act) {
    var W = wt.d, b = bt.d;
    var out = new Float32Array(outC * GU * GV);
    for (var oc = 0; oc < outC; oc++) {
      var base = oc * inC * 9;
      for (var y = 0; y < GU; y++) {
        for (var x = 0; x < GV; x++) {
          var acc = b[oc];
          for (var ic = 0; ic < inC; ic++) {
            var wb = base + ic * 9, sb = ic * GU * GV;
            for (var ky = -1; ky <= 1; ky++) {
              var yy = y + ky;
              if (yy < 0 || yy >= GU) continue;
              for (var kx = -1; kx <= 1; kx++) {
                var xx = x + kx;
                if (xx < 0 || xx >= GV) continue;
                acc += W[wb + (ky + 1) * 3 + (kx + 1)] * src[sb + yy * GV + xx];
              }
            }
          }
          out[oc * GU * GV + y * GV + x] = acc;
        }
      }
    }
    return out;
  }

  function gridEncode(grid, N) {
    // grid: Float32Array(N * 7 * 5 * 5)
    var out = new Float32Array(N * 64);
    var chan = GU * GV;
    for (var n = 0; n < N; n++) {
      var src = grid.subarray(n * 7 * chan, (n + 1) * 7 * chan);
      var s = conv3x3(src, 7, 16, T('node_grid_encoder.0.weight'), T('node_grid_encoder.0.bias'));
      s = batchNorm(s, 1, 16 * chan, T('node_grid_encoder.1.weight'), T('node_grid_encoder.1.bias'),
                    T('node_grid_encoder.1.running_mean'), T('node_grid_encoder.1.running_var'), 1e-5, chan);
      actInPlace(s, 'mish');
      s = conv3x3(s, 16, 32, T('node_grid_encoder.3.weight'), T('node_grid_encoder.3.bias'));
      s = batchNorm(s, 1, 32 * chan, T('node_grid_encoder.4.weight'), T('node_grid_encoder.4.bias'),
                    T('node_grid_encoder.4.running_mean'), T('node_grid_encoder.4.running_var'), 1e-5, chan);
      actInPlace(s, 'mish');
      s = conv3x3(s, 32, 64, T('node_grid_encoder.6.weight'), T('node_grid_encoder.6.bias'));
      s = batchNorm(s, 1, 64 * chan, T('node_grid_encoder.7.weight'), T('node_grid_encoder.7.bias'),
                    T('node_grid_encoder.7.running_mean'), T('node_grid_encoder.7.running_var'), 1e-5, chan);
      actInPlace(s, 'mish');
      // AdaptiveAvgPool2d(1)
      for (var c = 0; c < 64; c++) {
        var t = 0;
        for (var k = 0; k < chan; k++) t += s[c * chan + k];
        out[n * 64 + c] = t / chan;
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ PNA 塔
   * msg_e = M·[h_src; h_dst; a_e]         (M: 128×320)
   * h_n   = [Σ_{e→n} msg_e ; max_{e→n} msg_e]   (256)
   * out_n = BN( U·[x_n; h_n] * sqrt(1/N) )      (U: 128×384)
   */
  function pnaConv(x, he, N, edges, E, L) {
    var M = T(L + '.conv.M.weight').d, Mb = T(L + '.conv.M.bias').d;
    var U = T(L + '.conv.U.weight').d, Ub = T(L + '.conv.U.bias').d;
    var dim = 128, edim = 64, mdim = dim * 2 + edim;   // 320
    var sum = new Float32Array(N * dim);
    var max = new Float32Array(N * dim);
    var seen = new Uint8Array(N);
    var f = new Float32Array(mdim);
    for (var e = 0; e < E; e++) {
      var s = edges[e][0], d = edges[e][1];
      var so = s * dim, to = d * dim, ao = e * edim;
      for (var i = 0; i < dim; i++) { f[i] = x[so + i]; f[dim + i] = x[to + i]; }
      for (var k = 0; k < edim; k++) f[dim * 2 + k] = he[ao + k];
      // msg = M·f + Mb
      var dbase = d * dim;
      for (var o = 0; o < dim; o++) {
        var wq = o * mdim, acc = Mb[o];
        for (var t = 0; t < mdim; t++) acc += M[wq + t] * f[t];
        if (!seen[d]) { max[dbase + o] = acc; }
        else if (acc > max[dbase + o]) max[dbase + o] = acc;
        sum[dbase + o] += acc;
      }
      seen[d] = 1;
    }
    // U·[x; sum; max] * sqrt(1/N) + BN
    var sNorm = Math.sqrt(1 / N);
    var out = new Float32Array(N * dim);
    var uin = new Float32Array(dim * 3);
    for (var n = 0; n < N; n++) {
      for (var i2 = 0; i2 < dim; i2++) {
        uin[i2] = x[n * dim + i2];
        uin[dim + i2] = sum[n * dim + i2];
        uin[dim * 2 + i2] = max[n * dim + i2];
      }
      for (var o2 = 0; o2 < dim; o2++) {
        var w2 = o2 * dim * 3, a2 = Ub[o2];
        for (var t2 = 0; t2 < dim * 3; t2++) a2 += U[w2 + t2] * uin[t2];
        out[n * dim + o2] = a2 * sNorm;
      }
    }
    return batchNorm(out, N, dim, T(L + '.conv.norm_drop.0.weight'), T(L + '.conv.norm_drop.0.bias'),
                     T(L + '.conv.norm_drop.0.running_mean'), T(L + '.conv.norm_drop.0.running_var'));
  }

  function nodeMPNN(h, he, N, edges, E, L) {
    // h = h*res1 + layer1 * conv(norm1(h), he)
    var x = layerNorm(h, N, 128, T(L + '.norm1.weight'), T(L + '.norm1.bias'));
    x = pnaConv(x, he, N, edges, E, L);
    var h1 = addScaled(h, x, T(L + '.res_scale1.scale').d, T(L + '.layer_scale1.scale').d);
    // h = h1*res2 + layer2 * mlp(norm2(h1))   （这一层是 ReLU，见文件头说明）
    var y = layerNorm(h1, N, 128, T(L + '.norm2.weight'), T(L + '.norm2.bias'));
    y = mlp(y, N, [128, 256, 128], L + '.mlp.', 'relu', true);
    return addScaled(h1, y, T(L + '.res_scale2.scale').d, T(L + '.layer_scale2.scale').d);
  }

  /* --------------------------------------------------------------- 前向入口
   * g = { N, edges:[[s,d],...], fa:Float32Array(N*10), grid:Float32Array(N*7*5*5), ea:Float32Array(E*12) }
   * 返回 { seg:Float32Array(N*25), inst:Float32Array(N*N), bottom:Float32Array(N), ms }
   */
  function forward(g) {
    if (!F) throw new Error('权重未加载');
    var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var N = g.N, E = g.edges.length;
    var stages = [];
    function st(name, arr) {
      if (!g.debug) return;
      var mn = Infinity, mx = -Infinity, sum = 0, nan = 0;
      for (var i = 0; i < arr.length; i++) {
        var v = arr[i];
        if (!isFinite(v)) { nan++; continue; }
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        sum += v;
      }
      stages.push({ name: name, min: +mn.toFixed(4), max: +mx.toFixed(4), mean: +(sum / Math.max(arr.length - nan, 1)).toFixed(4), nan: nan });
    }

    // 1. 面属性 + UV 网格
    st('input:fa', g.fa); st('input:grid', g.grid); st('input:ea', g.ea);
    var ha = linear(g.fa, N, 10, T('node_attr_encoder.0.weight'), T('node_attr_encoder.0.bias'), 64);
    st('face_attr_linear', ha);
    ha = layerNorm(ha, N, 64, T('node_attr_encoder.1.weight'), T('node_attr_encoder.1.bias'));
    st('face_attr_ln', ha);
    var hg = gridEncode(g.grid, N);
    st('grid_emb', hg);
    var h = new Float32Array(N * 128);
    for (var i = 0; i < N; i++) {
      h.set(ha.subarray(i * 64, (i + 1) * 64), i * 128);
      h.set(hg.subarray(i * 64, (i + 1) * 64), i * 128 + 64);
    }
    var D2 = (g.debug === 2) ? { ha: ha, hg: hg, h0: h.slice() } : null;

    // 2. 边属性
    var he = linear(g.ea, E, 12, T('edge_attr_encoder.0.weight'), T('edge_attr_encoder.0.bias'), 64);
    if (E) he = layerNorm(he, E, 64, T('edge_attr_encoder.1.weight'), T('edge_attr_encoder.1.bias'));
    st('edge_emb', he);

    // 3. 图编码：第 1 层用 node_convs.0，之后 num_layers-1 层共享 node_convs.1
    st('node_emb', h);
    h = nodeMPNN(h, he, N, g.edges, E, 'graph_encoder.node_convs.0');
    st('after_layer0', h);
    if (D2) D2.h1 = h.slice();
    for (var L = 0; L < 2; L++) { h = nodeMPNN(h, he, N, g.edges, E, 'graph_encoder.node_convs.1'); st('after_layer' + (L + 1), h); }
    if (D2) { D2.he = he; D2.h3 = h.slice(); }

    // 4. 逐面 / 全局嵌入
    var local = layerNorm(h, N, 128, T('graph_encoder.post_norm.weight'), T('graph_encoder.post_norm.bias'));
    var mean = new Float32Array(128);
    for (var n2 = 0; n2 < N; n2++) for (var c = 0; c < 128; c++) mean[c] += local[n2 * 128 + c] / N;
    var global = mlp(mean, 1, [128, 128], 'graph_encoder.linear.', 'relu', true);
    if (D2) { D2.local = local.slice(); D2.mean = mean.slice(); D2.global = global.slice(); }

    var lg = new Float32Array(N * 256);
    for (var n3 = 0; n3 < N; n3++) {
      lg.set(local.subarray(n3 * 128, (n3 + 1) * 128), n3 * 256);
      lg.set(global, n3 * 256 + 128);
    }

    // 5. 三个头
    st('local', local); st('global', global); st('lg', lg);
    var seg = mlp(lg, N, [256, 64, 25], 'seg_head.', 'mish', false);
    st('seg_logits', seg);
    var bottom = mlp(lg, N, [256, 64, 1], 'bottom_head.', 'mish', false);
    var q = mlp(lg, N, [256, 64, 64], 'inst_head.Wq.', 'mish', true);
    var k = mlp(lg, N, [256, 64, 64], 'inst_head.Wk.', 'mish', true);
    var inst = new Float32Array(N * N);
    for (var a = 0; a < N; a++) {
      for (var b = 0; b < N; b++) {
        var s2 = 0, oa = a * 64, ob = b * 64;
        for (var c2 = 0; c2 < 64; c2++) s2 += q[oa + c2] * k[ob + c2];
        inst[a * N + b] = s2;
      }
    }

    return {
      seg: seg, inst: inst, bottom: bottom, N: N, stages: stages,
      dbg: D2,
      ms: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0)
    };
  }

  return {
    version: '1.0',
    load: load, ready: ready, forward: forward,
    classes: function () { return null; },
    _internals: {
      linear: linear, layerNorm: layerNorm, batchNorm: batchNorm, mish: mish,
      mlp: mlp, T: T, pnaConv: pnaConv, nodeMPNN: nodeMPNN, gridEncode: gridEncode,
      conv3x3: conv3x3, addScaled: addScaled, actInPlace: actInPlace
    }
  };
});
