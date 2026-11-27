/* AAGNet 的 gAAG 构建 + 后处理（纯 JS）
 * ---------------------------------------------------------------------------
 * 对齐 AAGNet-main/dataset/AAGExtractor.py 的口径：
 *   面属性（10 维）= 5 个曲面 one-hot + 面积 + 有理 NURBS 标志 + 质心 xyz
 *   面 UV 网格     = 7×5×5（点 xyz / 法向 xyz / 裁剪掩码）
 *   边属性（12 维）= 凹/凸/光滑 + 长度 + 圆/闭/椭圆/两对 NURBS/直线（含重复项，照抄 all.json）
 * 坐标先缩放到单位盒 [-1,1]^3（等价 occwl 的 scale_to_unit_box：2/max_extent，质心归零）。
 * 图照 occwl.face_adjacency 的 nx.DiGraph：每对相邻面存正反两条有向边，
 * DGL 的 update_all 只沿入边聚合。
 * 后处理照 utils/qt5_visualization.py：实例邻接阈值 0.5、按行收集、类别按面 logits 求和投票、
 * 24=stock 丢弃、bottom 阈值 0.5。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AAG_REC = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var CLASSES = ['chamfer', 'through_hole', 'triangular_passage', 'rectangular_passage', '6sides_passage',
    'triangular_through_slot', 'rectangular_through_slot', 'circular_through_slot',
    'rectangular_through_step', '2sides_through_step', 'slanted_through_step', 'Oring', 'blind_hole',
    'triangular_pocket', 'rectangular_pocket', '6sides_pocket', 'circular_end_pocket',
    'rectangular_blind_slot', 'v_circular_end_blind_slot', 'h_circular_end_blind_slot',
    'triangular_blind_step', 'circular_blind_step', 'rectangular_blind_step', 'round', 'stock'];

  var LABELS = ['倒角', '通孔', '三角通道', '矩形通道', '六边通道',
    '三角通槽', '矩形通槽', '圆弧通槽',
    '矩形通台阶', '双侧通台阶', '斜向通台阶', 'O 形圈槽', '盲孔',
    '三角型腔', '矩型腔', '六边型腔', '圆头型腔',
    '矩形盲槽', '竖圆头盲槽', '横圆头盲槽',
    '三角盲台阶', '圆弧盲台阶', '矩形盲台阶', '圆面/圆角', '毛坯面'];

  /* 与 tools/features.py 同一套桶，工艺预填/图例还要用 */
  var BUCKET = {
    through_hole: '孔', blind_hole: '孔', chamfer: '倒角', Oring: '槽', round: '圆角',
    stock: '毛坯'
  };

  /* 25 类 → 页面上的 8 个色桶（顺序与 CLASSES 一一对应）。
   * 页面只认这几个桶，网络给的是细类；两者都保留，卡片显示细类、着色用桶。 */
  var BUCKET_OF = [
    '倒角',        // 0  chamfer
    '通孔', '通孔', '通孔', '通孔',   // 1 through_hole / 2 三角通道 / 3 矩形通道 / 4 六边通道
    '槽', '槽', '槽',              // 5 三角通槽 / 6 矩形通槽 / 7 圆弧通槽
    '台阶', '台阶', '台阶',          // 8 矩形通台阶 / 9 双侧通台阶 / 10 斜向通台阶
    '槽',                         // 11 Oring
    '盲孔',                       // 12 blind_hole
    '型腔', '型腔', '型腔', '型腔',    // 13 三角型腔 / 14 矩型腔 / 15 六边型腔 / 16 圆头型腔
    '槽', '槽', '槽',              // 17 矩形盲槽 / 18 竖圆头盲槽 / 19 横圆头盲槽
    '台阶', '台阶', '台阶',          // 20 三角盲台阶 / 21 圆弧盲台阶 / 22 矩形盲台阶
    '圆角',                        // 23 round
    '毛坯'                         // 24 stock
  ];

  var PI = Math.PI, SM_ANG = 0.0872664626;    // 5°，与 AAGExtractor 的 angle_tol_rads 一致
  var COS5 = Math.cos(SM_ANG);

  /* 训练集统计量，逐字抄自 AAGNet-main/weights/attr_stat.json。
   * 面/边属性在送进网络前必须按 (x-mean)/std 标准化（utils/data_utils.py: standardization），
   * 少这一步网络输入整个分布偏移，输出会退化成「全 stock、0 实例」。
   * 原实现里 std < 1e-8 会被替换成 1（sphere 那一维就是 0）。 */
  var MF = [0.8859442349534624, 0.10986849777884584, 0.0019160473233649396, 0.0, 0.0016610062870854995,
    0.48359422499865773, 0.0003186540430188848, -0.003223478360784732, -0.0037115890805575606, -0.0013649688687564377];
  var SF = [0.317878982481224, 0.3127257759984791, 0.043730722449905966, 0.0, 0.04072158328413781,
    0.7642076544724773, 0.017848039181680667, 0.4512724768710965, 0.4494607374313992, 0.4499260886852193];
  var ME = [0.3035324745623818, 0.6593215194179672, 0.03714600601965091, 0.5527907644976456, 0.08814176698439265,
    0.03561724680968134, 0.006790021504123327, 0.0012543484588946557, 0.0001538861660565648, 0.9035944284280141,
    0.0012543484588946557, 0.0001538861660565648];
  var SE = [0.45978311343984707, 0.47393739404082746, 0.18911948670587872, 0.5869569768002859, 0.283500962760162,
    0.18533391093098678, 0.08212135599951025, 0.03539456270087981, 0.0124041317759619, 0.29514663700542115,
    0.03539456270087981, 0.0124041317759619];

  function statArray(dst, raw, n, dim, mean, sd) {
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < dim; c++) {
        var s = sd[c];
        if (!(Math.abs(s) > 1e-8)) s = 1;
        dst[r * dim + c] = (raw[r * dim + c] - mean[c]) / s;
      }
    }
  }

  /* ------------------------------------------------------------ 向量小工具 */
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function vlen(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); }
  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }

  function surfNormal(f, u, v) {
    var s = f.surf;
    var n = s && s.normalAt ? s.normalAt(u, v) : null;
    if (!n) return null;
    var l = vlen(n);
    if (!(l > 1e-12)) return null;
    var out = [n[0] / l, n[1] / l, n[2] / l];
    return f.same ? out : [-out[0], -out[1], -out[2]];
  }

  function normalAtPoint(f, p) {
    var s = f.surf;
    if (!s || !s.uvOf) return null;
    var uv = s.uvOf(p);
    if (!uv || !isFinite(uv[0]) || !isFinite(uv[1])) return null;
    return surfNormal(f, uv[0], uv[1]);
  }

  /* -------------------------------------------------------- 点在裁剪域内（UV） */
  /* 返回 0=外、1=内、2=边界上。occwl 的 mask = (visibility_status==IN | ==ON)，
   * 所以「正好落在边界上」必须算进掩码 —— 5×5 采样里 u_max / v_max 那一行一列
   * 天然落在边界上，判成「外」会把整行整列抹掉。 */
  function ptClass(poly, x, y, tol) {
    var n = poly.length, inside = false, dmin = Infinity;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
      var dx = xj - xi, dy = yj - yi, l2 = dx * dx + dy * dy;
      var t = l2 > 1e-30 ? ((x - xi) * dx + (y - yi) * dy) / l2 : 0;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      var ex = x - (xi + t * dx), ey = y - (yi + t * dy);
      var d2 = ex * ex + ey * ey;
      if (d2 < dmin) dmin = d2;
    }
    if (dmin <= tol * tol) return 2;
    return inside ? 1 : 0;
  }

  function inPoly(poly, x, y) {
    return ptClass(poly, x, y, 0) === 1;
  }

  function loopSpan(poly) {
    var u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (var i = 0; i < poly.length; i++) {
      if (poly[i][0] < u0) u0 = poly[i][0];
      if (poly[i][0] > u1) u1 = poly[i][0];
      if (poly[i][1] < v0) v0 = poly[i][1];
      if (poly[i][1] > v1) v1 = poly[i][1];
    }
    return Math.max(u1 - u0, v1 - v0, 1e-12);
  }

  function inTrim(loopsUV, u, v) {
    var outer = null, holes = [];
    for (var i = 0; i < loopsUV.length; i++) {
      if (loopsUV[i].outer && !outer) outer = loopsUV[i];
      else holes.push(loopsUV[i]);
    }
    if (!outer) {
      if (!loopsUV.length) return 0;
      outer = loopsUV[0];
      holes = loopsUV.slice(1);
    }
    var tol = loopSpan(outer.uv) * 1e-7;
    // 严格对齐 occwl：Face.inside(uv) → BRepTopAdaptor_FClass2d.Perform(uv) == TopAbs_IN
    // 只有「严格落在裁剪域内部」才算 1：外环上（ON）→ 0，内环上（ON）或内环里（OUT）→ 0。
    // 5×5 网格的 u/v 端点正好压在 uv 包围盒边界上，所以矩形面必然是
    // 「外圈一圈 0、中间 3×3 为 1」，网络认识的是这个图案，不是恒为 1。
    if (ptClass(outer.uv, u, v, tol) !== 1) return 0;
    for (var h = 0; h < holes.length; h++) {
      if (ptClass(holes[h].uv, u, v, tol) !== 0) return 0;
    }
    return 1;
  }

  /* ------------------------------------------------------------- 面 UV 网格 */
  var NU = 5, NV = 5;

  function faceGrid(f, box, out, base) {
    var loops = f._uv;
    if (!loops || !loops.length) return;
    var umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    for (var l = 0; l < loops.length; l++) {
      var uv = loops[l].uv;
      for (var i = 0; i < uv.length; i++) {
        if (uv[i][0] < umin) umin = uv[i][0];
        if (uv[i][0] > umax) umax = uv[i][0];
        if (uv[i][1] < vmin) vmin = uv[i][1];
        if (uv[i][1] > vmax) vmax = uv[i][1];
      }
    }
    if (!isFinite(umin) || !(umax > umin)) { umax = umin + 1e-6; umin -= 1e-6; }
    if (!isFinite(vmin) || !(vmax > vmin)) { vmax = vmin + 1e-6; vmin -= 1e-6; }
    /* 周期方向：OCC 的 BRepTools.UVBounds 对「绕满一圈」的面给的是一个周期的宽度，
     * 而我们沿环解绕（toUV 逐点累加 2π）时，接缝边会被多绕出去，
     * u 跨度可能变成 4π。这里按「跨度 ≥ 一个周期就取一个周期宽」收敛回去，
     * 否则 5 个采样点全部落在同一条母线（接缝）上，掩码整片为 0。
     * 部分圆弧（跨度 < 2π）保持裁剪域原样，与 OCC 一致。 */
    var PER = Math.PI * 2;
    if (f.surf && f.surf.periodU && (umax - umin) > PER - 1e-6) umax = umin + PER;
    if (f.surf && f.surf.periodV && (vmax - vmin) > PER - 1e-6) vmax = vmin + PER;
    var s = box.s, c = box.c;
    var stride = NU * NV;
    // occwl.uvgrid: 面是 REVERSED 时整个网格沿 u 反向（reverse_order_with_face）
    var rev = !f.same;
    for (var a = 0; a < NU; a++) {
      var t = (NU === 1) ? 0 : a / (NU - 1);
      var u = rev ? (umax - (umax - umin) * t) : (umin + (umax - umin) * t);
      for (var b = 0; b < NV; b++) {
        var v = vmin + (vmax - vmin) * b / (NV - 1);
        var P = f.surf.evalUV(u, v);
        var n = surfNormal(f, u, v) || [0, 0, 1];
        var g = base + a * NV + b;          // base 已是「该面通道 0 的起点」
        if (P) {
          out[g] = (P[0] - c[0]) * s;
          out[stride + g] = (P[1] - c[1]) * s;
          out[2 * stride + g] = (P[2] - c[2]) * s;
        }
        out[3 * stride + g] = n[0];
        out[4 * stride + g] = n[1];
        out[5 * stride + g] = n[2];
        out[6 * stride + g] = inTrim(loops, u, v);
      }
    }
  }

  /* --------------------------------------------------------------- 边收集 */
  function collectEdges(faces) {
    var map = new Map();
    for (var fi = 0; fi < faces.length; fi++) {
      var loops = faces[fi].loops || [];
      for (var li = 0; li < loops.length; li++) {
        var segs = loops[li].segs || [];
        for (var si = 0; si < segs.length; si++) {
          var sg = segs[si];
          if (!sg.key) continue;
          var e = map.get(sg.key);
          if (!e) { e = { key: sg.key, faces: [], segs: [] }; map.set(sg.key, e); }
          if (e.faces.indexOf(fi) < 0) { e.faces.push(fi); e.segs.push(sg); }
        }
      }
    }
    return Array.from(map.values());
  }

  /* 在面 f 上，从边上的点 p 往「面内部」挪一小步，返回探针点。
   * 方向取 p 的参数点指向该面所有环参数点的质心方向，步长 = 参数跨度 × frac。
   * 这么小的步长不会跨过别的特征，但足够让数值稳定。 */
  function probeInward(f, p, frac) {
    var s = f.surf;
    if (!s || !s.uvOf || !s.evalUV) return null;
    var uv = s.uvOf(p);
    if (!uv || !isFinite(uv[0]) || !isFinite(uv[1])) return null;
    var loops = f._uv || [];
    var su = 0, sv = 0, cnt = 0;
    var u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (var l = 0; l < loops.length; l++) {
      var q = loops[l].uv || [];
      for (var i = 0; i < q.length; i++) {
        su += q[i][0]; sv += q[i][1]; cnt++;
        if (q[i][0] < u0) u0 = q[i][0];
        if (q[i][0] > u1) u1 = q[i][0];
        if (q[i][1] < v0) v0 = q[i][1];
        if (q[i][1] > v1) v1 = q[i][1];
      }
    }
    if (!cnt) return null;
    var du = su / cnt - uv[0], dv = sv / cnt - uv[1];
    var l2 = Math.sqrt(du * du + dv * dv);
    if (!(l2 > 1e-12)) return null;
    var d = Math.max(u1 - u0, v1 - v0) * (frac || 2e-3);
    return s.evalUV(uv[0] + du / l2 * d, uv[1] + dv / l2 * d);
  }

  /* 凸凹判定（对齐 occwl EdgeDataExtractor.edge_convexity 的语义）：
   *   1) 光滑：各采样点两面法向点积的**均值** > cos(5°)
   *   2) 否则：凸 ⟺ 二面角 < 180°
   * 判定 2) 不用切向符号（那要求先判对「哪一侧是左面」，一旦 A/B 取反结论就翻），
   * 改用几何探针：在 A 上取边上一点 p 的外法向 nA，在 B 上取贴着边、往面内挪
   * 一小步的点 qB —— 凸边时 B 会往 A 的「内侧」塌，dot(nA, qB−p) < 0；
   * 凹边则 > 0。两侧各投一票，多数票定论。完全orientation-free。 */
  function convexity(e, faces) {
    if (e.faces.length < 2 || !e.segs || e.segs.length < 2) return 0;   // 开边：occwl 也给 0
    var A = faces[e.faces[0]], B = faces[e.faces[1]];
    var pts = (e.segs[0] && e.segs[0].pts) || [];
    if (!A || !B || pts.length < 2) return 0;

    var samples = [];
    if (pts.length === 2) {
      samples.push([(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2, (pts[0][2] + pts[1][2]) / 2]);
    } else {
      var step = Math.max(1, Math.floor((pts.length - 1) / 4));
      for (var i = 1; i + 1 < pts.length; i += step) samples.push(pts[i]);
      if (!samples.length) samples.push(pts[Math.floor(pts.length / 2)]);
    }

    var dotSum = 0, nd = 0, nv = 0, nc = 0;
    for (var k = 0; k < samples.length; k++) {
      var p = samples[k];
      var nA = normalAtPoint(A, p), nB = normalAtPoint(B, p);
      if (!nA || !nB) continue;
      dotSum += dot(nA, nB); nd++;
      var qB = probeInward(B, p, 2e-3), qA = probeInward(A, p, 2e-3);
      if (qB) { var w1 = sub(qB, p); if (dot(nA, w1) < 0) nv++; else nc++; }
      if (qA) { var w2 = sub(qA, p); if (dot(nB, w2) < 0) nv++; else nc++; }
    }
    if (!nd) return 0;
    if (dotSum / nd > COS5) return 3;                  // 光滑
    if (!nv && !nc) return 0;
    return nv >= nc ? 1 : 2;                           // 1 凸 / 2 凹
  }

  function edgeAttr(e, faces, box) {
    var at = new Float32Array(12);
    var cv = convexity(e, faces);
    at[0] = cv === 2 ? 1 : 0;
    at[1] = cv === 1 ? 1 : 0;
    at[2] = cv === 3 ? 1 : 0;
    var sg0 = (e.segs && e.segs[0]) || {};
    at[3] = (sg0.len || 0) * box.s;
    var ct = (sg0.curve && sg0.curve.type) || 'OTHER';
    var rat = !!(sg0.curve && sg0.curve.rational);
    at[4] = ct === 'CIRCLE' ? 1 : 0;
    at[5] = sg0.closed ? 1 : 0;
    at[6] = ct === 'ELLIPSE' ? 1 : 0;
    var bs = ct === 'BSPLINE';
    at[7] = (bs && !rat) ? 1 : 0;
    at[8] = (bs && rat) ? 1 : 0;
    at[9] = ct === 'LINE' ? 1 : 0;
    at[10] = at[7];
    at[11] = at[8];
    return at;
  }

  /* 复刻 utils/data_utils.py: center_and_scale_uvgrid ——
   * 只按「裁剪域内」(mask==1) 的采样点求包围盒，中心归零、2/max_extent 缩放；
   * 法向与 mask 通道不动。occwl 已经把实体缩放到单位盒，这里做的是第二轮微调。 */
  function centerScaleGrid(grid, N) {
    var stride = NU * NV;
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    var any = false;
    for (var n = 0; n < N; n++) {
      var fb = n * 7 * stride;
      for (var j = 0; j < stride; j++) {
        if (grid[fb + 6 * stride + j] !== 1) continue;
        any = true;
        for (var k = 0; k < 3; k++) {
          var v = grid[fb + k * stride + j];
          if (!isFinite(v)) continue;
          if (v < mn[k]) mn[k] = v;
          if (v > mx[k]) mx[k] = v;
        }
      }
    }
    if (!any) return;
    var c = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
    var ext = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
    var sc = ext > 1e-12 ? 2 / ext : 1;
    for (var n2 = 0; n2 < N; n2++) {
      var gb = n2 * 7 * stride;
      for (var k2 = 0; k2 < 3; k2++) {
        for (var i2 = 0; i2 < stride; i2++) {
          var o = gb + k2 * stride + i2;
          grid[o] = (grid[o] - c[k2]) * sc;
        }
      }
    }
  }

  function edges2Count(allEdges) {
    var c = 0;
    for (var i = 0; i < allEdges.length; i++) if (allEdges[i].faces.length >= 2) c += 2;
    return c;
  }

  /* ------------------------------------------------------------ 构建 gAAG */
  function buildGAAG(faces, ubox) {
    var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var N = faces.length;
    var maxExt = ubox.maxExt || 1;
    var box = { s: 2 / maxExt, c: ubox.center };
    var cn = box.c, s = box.s;

    var fa = new Float32Array(N * 10);
    var grid = new Float32Array(N * 7 * NU * NV);
    var units = ubox.unit || 1;
    var perFace = [];

    for (var i = 0; i < N; i++) {
      var f = faces[i];
      var k = f.kind || 'Plane';
      fa[i * 10 + 0] = k === 'Plane' ? 1 : 0;
      fa[i * 10 + 1] = k === 'Cylinder' ? 1 : 0;
      fa[i * 10 + 2] = k === 'Cone' ? 1 : 0;
      fa[i * 10 + 3] = k === 'Sphere' ? 1 : 0;
      fa[i * 10 + 4] = k === 'Torus' ? 1 : 0;
      fa[i * 10 + 5] = (f.area || 0) * s * s;
      fa[i * 10 + 6] = (f.surf && f.surf.rational) ? 1 : 0;
      fa[i * 10 + 7] = (f.centroid[0] - cn[0]) * s;
      fa[i * 10 + 8] = (f.centroid[1] - cn[1]) * s;
      fa[i * 10 + 9] = (f.centroid[2] - cn[2]) * s;
      faceGrid(f, box, grid, i * 7 * NU * NV);
      perFace.push({
        radius_mm: f.radius ? Math.abs(f.radius) * units : null,
        kind: k, area_mm2: (f.area || 0) * units * units
      });
    }
    // 网格按推理端设置不再二次居中缩放（infer_speed_test.py: self.center_and_scale = False）
    if (ubox.centerScale) centerScaleGrid(grid, N);
    // 标准化前的原始属性也留着：可以拿 attr_stat.json 的 mean/std 反查特征口径是否跑偏
    var faRaw = fa.slice();
    var faN = new Float32Array(N * 10);
    statArray(faN, fa, N, 10, MF, SF);
    fa = faN;

    var allEdges = collectEdges(faces);

    /* occwl 的 face_adjacency 建的是 nx.DiGraph，每对相邻面写两条有向边：
     *   graph.add_edge(left, right, edge=e); graph.add_edge(right, left, edge=e.reversed)
     * 两条边的属性值相同（凸凹、长度、曲线类型都与方向无关）。
     * DGL 的 update_all 只沿入边聚合，所以「双向」不是可有可无的冗余 ——
     * 少了反向边，每个面的邻居消息总量直接减半，输出会系统性偏移。 */
    var ea2 = new Float32Array(edges2Count(allEdges) * 12);
    var eaRaw = new Float32Array(edges2Count(allEdges) * 12);
    var edges = [];
    var k2 = 0;
    for (var e = 0; e < allEdges.length; e++) {
      var rec = allEdges[e];
      if (rec.faces.length < 2) continue;             // 开边/缝合边：occwl 直接跳过
      var at = edgeAttr(rec, faces, box);
      statArray(ea2.subarray(k2 * 12, k2 * 12 + 12), at, 1, 12, ME, SE);
      eaRaw.set(at, k2 * 12);                         // 两条有向边写同一份原始属性
      var u = Math.min(rec.faces[0], rec.faces[1]);
      var v = Math.max(rec.faces[0], rec.faces[1]);
      edges.push([u, v]);
      k2++;
      statArray(ea2.subarray(k2 * 12, k2 * 12 + 12), at, 1, 12, ME, SE);
      eaRaw.set(at, k2 * 12);
      edges.push([v, u]);
      k2++;
    }

    return {
      N: N, edges: edges, fa: fa, grid: grid, ea: ea2, box: box, perFace: perFace,
      faRaw: faRaw, eaRaw: eaRaw,
      edgeCount: edges.length, edgeTotal: allEdges.length,
      pairCount: edges.length >> 1,
      msGraph: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0)
    };
  }

  /* ------------------------------------------------------------- 后处理 */
  function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

  function softmax(logits, n, dim) {
    var out = new Float32Array(n * dim);
    for (var r = 0; r < n; r++) {
      var mx = -Infinity, i;
      for (i = 0; i < dim; i++) if (logits[r * dim + i] > mx) mx = logits[r * dim + i];
      var sum = 0;
      for (i = 0; i < dim; i++) sum += Math.exp(logits[r * dim + i] - mx);
      for (i = 0; i < dim; i++) out[r * dim + i] = Math.exp(logits[r * dim + i] - mx) / sum;
    }
    return out;
  }

  function postprocess(out, faces, g, opts) {
    var N = out.N;
    var TH_INST = (opts && opts.instThres) || 0.5;
    var TH_BOT = (opts && opts.bottomThres) || 0.5;

    var prob = softmax(out.seg, N, 25);

    var adj = new Float32Array(N * N);
    for (var i = 0; i < N * N; i++) adj[i] = sigmoid(out.inst[i]);

    var bots = [];
    for (var b = 0; b < N; b++) if (sigmoid(out.bottom[b]) > TH_BOT) bots.push(b);

    // 按行收集 proposal（照 qt5_visualization 的 used_flags 逻辑，行自身不标记 used）
    var used = new Uint8Array(N);
    var props = [];
    for (var r = 0; r < N; r++) {
      if (used[r]) continue;
      var rowSum = 0;
      for (var c = 0; c < N; c++) if (adj[r * N + c] > TH_INST) rowSum++;
      if (!rowSum) continue;                       // 无连接 → 毛坯面
      var prop = [];
      for (var c2 = 0; c2 < N; c2++) {
        if (used[c2]) continue;
        if (adj[r * N + c2] > TH_INST) { prop.push(c2); used[c2] = 1; }
      }
      if (prop.length) props.push(prop);
    }

    // 每个 proposal 投票定类别
    var insts = [];
    for (var p = 0; p < props.length; p++) {
      var inst = props[p];
      var sum = new Float32Array(25);
      for (var q = 0; q < inst.length; q++) {
        for (var k = 0; k < 25; k++) sum[k] += out.seg[inst[q] * 25 + k];
      }
      var cls = 0;
      for (var k2 = 1; k2 < 25; k2++) if (sum[k2] > sum[cls]) cls = k2;
      if (cls === 24) continue;                    // stock 丢弃

      var groups;
      if (cls === 1 && inst.length > 1) {
        // 通孔：同一实例里的面必须同轴，否则拆开（原文用质心差做代理，这里用轴向，更准）
        groups = splitByAxis(inst, faces);
      } else {
        groups = [inst];
      }
      for (var gi = 0; gi < groups.length; gi++) {
        insts.push(makeInstance(groups[gi], cls, prob, faces, bots, g));
      }
    }

    // 未归入任何实例的面：单独记类别（用于语义着色），不进实例列表
    var faceClass = new Int32Array(N); faceClass.fill(-1);
    var faceConf = new Float32Array(N);
    for (var i2 = 0; i2 < N; i2++) {
      var mx = 0;
      for (var k3 = 1; k3 < 25; k3++) if (prob[i2 * 25 + k3] > prob[i2 * 25 + mx]) mx = k3;
      faceClass[i2] = mx;
      faceConf[i2] = prob[i2 * 25 + mx];
    }

    insts.sort(function (A, B) { return A.faces[0] - B.faces[0]; });
    insts.forEach(function (it, idx) { it.key = 'N' + (idx + 1); it.id = idx; });

    var bottomMask = new Uint8Array(N);
    bots.forEach(function (i3) { bottomMask[i3] = 1; });

    return {
      instances: insts,
      faceClass: faceClass,
      faceConf: faceConf,
      segProb: prob,                 // N×25 softmax，逐面类别概率（调试/校验用）
      propFaces: props,              // 原始 proposal（未按轴拆分），对齐参考实现
      bottomMask: bottomMask,
      proposals: props.length,
      msFwd: out.ms,
      N: N, E: g.edgeCount, pairs: g.pairCount, edgeTotal: g.edgeTotal,
      msGraph: g.msGraph,
      classes: CLASSES, labels: LABELS, bucket: BUCKET, bucketOf: BUCKET_OF
    };
  }

  function splitByAxis(inst, faces) {
    var groups = [], usedF = [];
    for (var i = 0; i < inst.length; i++) {
      var f = faces[inst[i]];
      var ax = f.axis;
      if (!ax) { groups.push([inst[i]]); continue; }
      var placed = false;
      for (var g2 = 0; g2 < groups.length; g2++) {
        var g0 = faces[groups[g2][0]];
        if (!g0 || !g0.axis) continue;
        var d = Math.abs(dot(g0.axis, ax));
        if (d < 0.99) continue;
        var w = sub(f.axis_pt || [0, 0, 0], g0.axis_pt || [0, 0, 0]);
        var off = vlen(cross(w, ax));
        if (off > (g0.radius || 1e-6) * 0.5 + 1e-6) continue;
        groups[g2].push(inst[i]);
        placed = true;
        break;
      }
      if (!placed) groups.push([inst[i]]);
    }
    return groups;
  }

  function makeInstance(inst, cls, prob, faces, bots, g) {
    var conf = 0;
    for (var i = 0; i < inst.length; i++) conf += prob[inst[i] * 25 + cls];
    conf /= inst.length;

    var bottoms = inst.filter(function (i2) { return bots.indexOf(i2) >= 0; });
    var params = [['面数', inst.length + ' 面']];
    // 孔类：把半径/深度按几何反算贴出来（网络只给类别，尺寸来自 B-Rep）
    if ((cls === 1 || cls === 12) && g && g.perFace) {
      var r = 0, n = 0;
      for (var j = 0; j < inst.length; j++) {
        var rf = g.perFace[inst[j]].radius_mm;
        if (rf) { r += rf; n++; }
      }
      if (n) params.push(['直径', 'Φ' + (2 * r / n).toFixed(1) + ' mm']);
    }
    return {
      key: '', cls: LABELS[cls], en: CLASSES[cls], clsId: cls,
      bucket: BUCKET_OF[cls] || '毛坯',
      faces: inst.slice(), bottom: bottoms.length ? bottoms[0] : null,
      conf: Math.round(conf * 1000) / 1000,
      params: params,
      depth_mm: null, dia_mm: null,
      bottomFaces: bottoms
    };
  }

  /* --------------------------------------------------------------- 入口 */
  function recognize(faces, ubox) {
    var M = (typeof window !== 'undefined') ? window.AAG_MODEL : (typeof AAG_MODEL !== 'undefined' ? AAG_MODEL : null);
    if (!M) throw new Error('模型未加载');
    if (!M.ready()) {
      var W = (typeof window !== 'undefined') ? window.AAG_W : (typeof AAG_W !== 'undefined' ? AAG_W : null);
      if (!W) throw new Error('权重未加载（aagnet_weights.js）');
      M.load(W);
    }
    var g = buildGAAG(faces, ubox);
    if (g.N < 1) throw new Error('没有面');
    var out = M.forward(g);
    return postprocess(out, faces, g);
  }

  return {
    version: '1.0',
    recognize: recognize,
    buildGAAG: buildGAAG,
    postprocess: postprocess,
    CLASSES: CLASSES, LABELS: LABELS, BUCKET: BUCKET, BUCKET_OF: BUCKET_OF,
    _internals: {
      collectEdges: collectEdges, convexity: convexity, inTrim: inTrim,
      faceGrid: faceGrid, softmax: softmax, LABELS: LABELS
    }
  };
});
