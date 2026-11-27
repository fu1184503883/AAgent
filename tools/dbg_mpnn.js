// node_convs.0 内部逐算子定位 NaN
global.window = global;
const path = require('path');
const S = require(path.join(__dirname, '..', 'step_import.js'));
const MOD = require(path.join(__dirname, '..', 'aagnet_model.js'));
const REC = require(path.join(__dirname, '..', 'aagnet_recognize.js'));
require(path.join(__dirname, '..', 'aagnet_weights.js'));
global.AAG_MODEL = MOD;
global.AAG_REC = REC;
MOD.load(global.AAG_W);

const file = process.argv[2] || 'tools/samples/plate_hole.step';
const text = require('fs').readFileSync(path.resolve(file), 'utf8');
const part = S.buildPart(text, path.basename(file), { raw: true });
const raw = part._raw;
const g = REC.buildGAAG(raw.faces, { center: raw.center, maxExt: raw.maxExt });
const I = MOD._internals;
const N = g.N, E = g.edges.length, D = 128;
const L = 'graph_encoder.node_convs.0';

function rows(tag, a, dim) {
  const out = [];
  for (let r = 0; r < N; r++) {
    let bad = 0, mn = Infinity, mx = -Infinity, s = 0;
    for (let c = 0; c < dim; c++) {
      const v = a[r * dim + c];
      if (!isFinite(v)) { bad++; continue; }
      if (v < mn) mn = v; if (v > mx) mx = v; s += v;
    }
    out.push(`#${r}${bad ? '!' + bad : ''}[${mn.toFixed(2)},${mx.toFixed(2)}~${(s / dim).toFixed(2)}]`);
  }
  console.log(`${tag.padEnd(14)} ${out.join(' ')}`);
}

// 输入 h
const ha0 = I.linear(g.fa, N, 10, I.T('node_attr_encoder.0.weight'), I.T('node_attr_encoder.0.bias'), 64);
const ha = I.layerNorm(ha0, N, 64, I.T('node_attr_encoder.1.weight'), I.T('node_attr_encoder.1.bias'));
const hg = I.gridEncode(g.grid, N);
rows('grid_emb', hg, 64);
const h = new Float32Array(N * D);
for (let i = 0; i < N; i++) {
  h.set(ha.subarray(i * 64, (i + 1) * 64), i * D);
  h.set(hg.subarray(i * 64, (i + 1) * 64), i * D + 64);
}
rows('h', h, D);

const he = I.layerNorm(
  I.linear(g.ea, E, 12, I.T('edge_attr_encoder.0.weight'), I.T('edge_attr_encoder.0.bias'), 64),
  E, 64, I.T('edge_attr_encoder.1.weight'), I.T('edge_attr_encoder.1.bias'));
// 边向量也看看
{
  let bad = 0;
  for (let i = 0; i < he.length; i++) if (!isFinite(he[i])) bad++;
  console.log('he 非有限:', bad, '/', he.length);
}

const x1 = I.layerNorm(h, N, D, I.T(L + '.norm1.weight'), I.T(L + '.norm1.bias'));
rows('norm1', x1, D);
const x2 = I.pnaConv(x1, he, N, g.edges, E, L);
rows('pnaConv', x2, D);

// 手工看 pnaConv 的中间量
{
  const M = I.T(L + '.conv.M.weight').d, Mb = I.T(L + '.conv.M.bias').d;
  const U = I.T(L + '.conv.U.weight').d, Ub = I.T(L + '.conv.U.bias').d;
  const mdim = 320, edim = 64;
  const f = new Float32Array(mdim);
  const sum = new Float32Array(N * D), mx = new Float32Array(N * D);
  const seen = new Uint8Array(N);
  let msgBad = 0, msgMin = Infinity, msgMax = -Infinity;
  for (let e = 0; e < E; e++) {
    const s = g.edges[e][0], d = g.edges[e][1];
    for (let i = 0; i < D; i++) { f[i] = x1[s * D + i]; f[D + i] = x1[d * D + i]; }
    for (let k = 0; k < edim; k++) f[2 * D + k] = he[e * edim + k];
    for (let o = 0; o < D; o++) {
      let acc = Mb[o];
      for (let t = 0; t < mdim; t++) acc += M[o * mdim + t] * f[t];
      if (!isFinite(acc)) msgBad++;
      if (acc < msgMin) msgMin = acc; if (acc > msgMax) msgMax = acc;
      if (!seen[d]) mx[d * D + o] = acc; else if (acc > mx[d * D + o]) mx[d * D + o] = acc;
      sum[d * D + o] += acc;
    }
    seen[d] = 1;
  }
  console.log(`msg 非有限=${msgBad}  range=[${msgMin.toFixed(2)},${msgMax.toFixed(2)}]`);
  rows('sum', sum, D);
  rows('max', mx, D);
  // U
  const uin = new Float32Array(D * 3), out = new Float32Array(N * D);
  for (let n = 0; n < N; n++) {
    for (let i = 0; i < D; i++) { uin[i] = x1[n * D + i]; uin[D + i] = sum[n * D + i]; uin[2 * D + i] = mx[n * D + i]; }
    for (let o = 0; o < D; o++) {
      let a = Ub[o];
      for (let t = 0; t < D * 3; t++) a += U[o * D * 3 + t] * uin[t];
      out[n * D + o] = a * Math.sqrt(1 / N);
    }
  }
  rows('U*', out, D);
  // BN 统计量
  const mu = I.T(L + '.conv.norm_drop.0.running_mean').d, va = I.T(L + '.conv.norm_drop.0.running_var').d;
  let z = 0, mnv = Infinity;
  for (let c = 0; c < D; c++) { if (va[c] === 0) z++; if (va[c] < mnv) mnv = va[c]; }
  console.log(`BN running_var 最小值=${mnv}  零通道=${z}`);
}
