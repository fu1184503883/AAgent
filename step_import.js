/*!
 * step_import.js — 本地 STEP(ISO 10303-21) 读取 · 轻量 B-Rep 三角化 · 规则特征识别
 * 供 aagnet-demo 的「导入本地 STP」使用：零依赖、可 file:// 直接跑。
 *
 * 支持：AP203 / AP214 / AP242 文本 STEP；平面 / 圆柱 / 圆锥 / 球 / 环面 / B 样条曲面；
 *      直线 / 圆 / 椭圆 / B 样条 / 折线 / 裁剪曲线作边界；外环 + 内环（孔）。
 * 限制：只取几何，不做 pcurve 精确裁剪、不展开装配实例（MAPPED_ITEM）；
 *      识别仍是「规则启发式」，与样例数据的口径一致，不是网络输出。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AAG_STEP = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  /* =============================================================== 0. 基础工具 */
  var PI2 = Math.PI * 2;

  function num(v, d) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (v && v.a && v.a.length && typeof v.a[0] === 'number') return v.a[0];
    return d;
  }
  function boolVal(v, dflt) {
    if (v === true || v === false) return v;
    if (v && v.e) return v.e === 'T';
    return dflt;
  }
  function refId(v) {
    if (v && typeof v === 'object' && typeof v.r === 'number') return v.r;
    if (typeof v === 'number') return v;
    return null;
  }
  function wrapPi(a) {
    a = a % PI2;
    if (a > Math.PI) a -= PI2;
    if (a < -Math.PI) a += PI2;
    return a;
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function vlen(a) { return Math.sqrt(dot(a, a)); }
  function nrm(a) {
    var l = vlen(a);
    return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
  }
  function perpTo(z) {
    var a = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    var r = cross(z, a);
    if (vlen(r) < 1e-9) r = cross(z, [0, 0, 1]);
    return nrm(r);
  }

  /* ================================================== 1. ISO-10303-21 文本解析 */
  function scanStatements(text) {
    var out = [], n = text.length, i = 0;
    while (i < n) {
      var c = text.charCodeAt(i);
      if (c === 47 && text.charCodeAt(i + 1) === 42) {          // /* 注释 */
        var ce = text.indexOf('*/', i + 2);
        i = ce < 0 ? n : ce + 2;
        continue;
      }
      if (c === 35) {                                            // '#'
        var j = i + 1;
        while (j < n && text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) j++;
        if (j > i + 1) {
          var k = j;
          while (k < n && /\s/.test(text[k])) k++;
          if (text[k] === '=') {
            var p = k + 1, depth = 0, inStr = false;
            for (; p < n; p++) {
              var ch = text[p];
              if (inStr) {
                if (ch === "'") { if (text[p + 1] === "'") p++; else inStr = false; }
                continue;
              }
              if (ch === "'") { inStr = true; continue; }
              if (ch === '(') depth++;
              else if (ch === ')') { if (depth > 0) depth--; }
              else if (ch === ';' && depth === 0) break;
            }
            out.push({ id: +text.slice(i + 1, j), body: text.slice(k + 1, p) });
            i = p + 1;
            continue;
          }
        }
        i = j;
        continue;
      }
      i++;
    }
    return out;
  }

  function parseInstanceBody(body) {
    var pos = 0, L = body.length;
    function ws() { while (pos < L && /\s/.test(body[pos])) pos++; }
    function readIdent() {
      var s = pos;
      while (pos < L && /[A-Za-z0-9_\-]/.test(body[pos])) pos++;
      return body.slice(s, pos).toUpperCase();
    }
    function readVal() {
      ws();
      var c = body[pos];
      if (c === '#') {
        pos++;
        var s = pos;
        while (pos < L && body[pos] >= '0' && body[pos] <= '9') pos++;
        return { r: +body.slice(s, pos) };
      }
      if (c === "'") {
        pos++;
        var out = '';
        while (pos < L) {
          var ch = body[pos];
          if (ch === "'") {
            if (body[pos + 1] === "'") { out += "'"; pos += 2; continue; }
            pos++; break;
          }
          out += ch; pos++;
        }
        return out;
      }
      if (c === '(') {
        pos++;
        var arr = [];
        ws();
        if (body[pos] === ')') { pos++; return arr; }
        for (;;) {
          arr.push(readVal());
          ws();
          if (body[pos] === ',') { pos++; continue; }
          if (body[pos] === ')') { pos++; break; }
          if (pos >= L) break;
          pos++;                                   // 容错：跳过意外字符
        }
        return arr;
      }
      if (c === '$') { pos++; return null; }
      if (c === '*') { pos++; return { star: true }; }
      if (c === '.') {
        if (/[0-9]/.test(body[pos + 1] || '')) {   // .5 之类的实数
          var m0 = /^[+-]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(body.slice(pos));
          if (m0) { pos += m0[0].length; return +m0[0]; }
        }
        pos++;
        var s2 = pos;
        while (pos < L && body[pos] !== '.') pos++;
        var ev = body.slice(s2, pos).toUpperCase();
        pos++;
        return { e: ev };
      }
      if (/[A-Za-z_]/.test(c)) {                   // 类型化参数，如 LENGTH_MEASURE(1.0)
        var nm = readIdent();
        ws();
        if (body[pos] === '(') return { t: nm, a: readVal() };
        return { t: nm };
      }
      var m = /^[+-]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(body.slice(pos));
      if (m) { pos += m[0].length; return +m[0]; }
      pos++;
      return null;
    }

    var parts = [];
    ws();
    if (body[pos] === '(') {                       // 复合实体 (A(..)B(..))
      pos++;
      for (;;) {
        ws();
        if (pos >= L || body[pos] === ')') { pos++; break; }
        var nm2 = readIdent();
        if (!nm2) break;
        ws();
        var a2 = body[pos] === '(' ? readVal() : [];
        parts.push({ name: nm2, args: a2 || [] });
      }
      if (!parts.length) return { type: 'UNKNOWN', args: [], parts: [] };
      return { type: parts[0].name, args: parts[0].args, parts: parts };
    }
    var type = readIdent();
    ws();
    var args = body[pos] === '(' ? readVal() : [];
    return { type: type, args: args || [], parts: [{ name: type, args: args || [] }] };
  }

  function parseDoc(text) {
    var stmts = scanStatements(text);
    if (!stmts.length) throw new Error('没有找到 STEP 实体（#序号=…;），可能不是文本格式的 STEP');
    var e = new Map(), all = [], byType = new Map();
    for (var i = 0; i < stmts.length; i++) {
      var ent = parseInstanceBody(stmts[i].body);
      ent.id = stmts[i].id;
      e.set(ent.id, ent);
      all.push(ent.id);
      /* 注意去重：普通实体的 parts[0].name 和 ent.type 是同一个名字，
       * 不去重会让 byType 里每条实体登记两次（面数、形态统计都会翻倍）。 */
      var names = [ent.type];
      if (ent.parts) for (var p = 0; p < ent.parts.length; p++) {
        if (ent.parts[p].name !== ent.type) names.push(ent.parts[p].name);
      }
      for (var q = 0; q < names.length; q++) {
        var n2 = names[q];
        if (!byType.has(n2)) byType.set(n2, []);
        byType.get(n2).push(ent.id);
      }
    }
    return { e: e, all: all, byType: byType };
  }

  function Doc(d) {
    this.d = d;
    this.e = d.e;
  }
  Doc.prototype.ref = function (v) {
    var id = refId(v);
    return id === null ? null : (this.e.get(id) || null);
  };
  Doc.prototype.part = function (ent, name) {
    if (!ent) return null;
    if (ent.type === name) return ent.args;
    if (ent.parts) for (var i = 0; i < ent.parts.length; i++) if (ent.parts[i].name === name) return ent.parts[i].args;
    return null;
  };

  /* ============================================================ 2. 几何取值 */
  function pointOf(doc, v) {
    var ent = doc.ref(v);
    if (!ent) return [0, 0, 0];
    if (ent.type === 'VERTEX_POINT') ent = doc.ref(ent.args[1]);      // 顶点 → 坐标点
    if (!ent) return [0, 0, 0];
    var a = ent.args[1] || [];
    return [num(a[0], 0), num(a[1], 0), num(a[2], 0)];
  }
  function dirOf(doc, v) {
    var ent = doc.ref(v);
    if (!ent) return [0, 0, 1];
    var a = ent.args[1] || [];
    return nrm([num(a[0], 0), num(a[1], 1), num(a[2], 0)]);
  }
  function axis2(doc, v) {
    var ent = doc.ref(v);
    var o = [0, 0, 0], z = [0, 0, 1], xr = null;
    if (ent) {
      if (ent.type === 'AXIS2_PLACEMENT_3D') {
        o = pointOf(doc, ent.args[1]);
        if (ent.args[2]) z = dirOf(doc, ent.args[2]);
        if (ent.args[3]) xr = dirOf(doc, ent.args[3]);
      } else if (ent.type === 'AXIS2_PLACEMENT_2D') {
        var p2 = pointOf(doc, ent.args[1]);
        o = [p2[0], p2[1], 0];
        if (ent.args[2]) xr = dirOf(doc, ent.args[2]);
      } else if (ent.type === 'AXIS1_PLACEMENT') {
        o = pointOf(doc, ent.args[1]);
        if (ent.args[2]) z = dirOf(doc, ent.args[2]);
      }
    }
    z = nrm(z);
    var x;
    if (xr) {
      var t = sub(xr, mul(z, dot(xr, z)));
      x = vlen(t) > 1e-9 ? nrm(t) : perpTo(z);
    } else {
      x = perpTo(z);
    }
    var y = nrm(cross(z, x));
    return { o: o, z: z, x: x, y: y };
  }

  /* ============================================================== 3. 曲面 */
  function makeSurface(doc, v, ctx) {
    var ent = doc.ref(v);
    if (!ent) return null;
    var t = ent.type, a = ent.args;

    if (t === 'PLANE') {
      var pl = axis2(doc, a[1]);
      return {
        kind: 'Plane', periodU: false, normal: pl.z, frame: pl,
        evalUV: function (u, vv) { return add(pl.o, add(mul(pl.x, u), mul(pl.y, vv))); },
        uvOf: function (p) { var d = sub(p, pl.o); return [dot(d, pl.x), dot(d, pl.y)]; },
        normalAt: function () { return pl.z; }
      };
    }
    if (t === 'CYLINDRICAL_SURFACE') {
      var c1 = axis2(doc, a[1]), r1 = num(a[2], 1);
      return {
        kind: 'Cylinder', periodU: true, radius: r1, axis: c1.z, axisPt: c1.o,
        evalUV: function (u, vv) {
          return add(c1.o, add(mul(c1.x, r1 * Math.cos(u)), add(mul(c1.y, r1 * Math.sin(u)), mul(c1.z, vv))));
        },
        uvOf: function (p) { var d = sub(p, c1.o); return [Math.atan2(dot(d, c1.y), dot(d, c1.x)), dot(d, c1.z)]; },
        normalAt: function (u) {
          return nrm(add(mul(c1.x, Math.cos(u)), mul(c1.y, Math.sin(u))));
        }
      };
    }
    if (t === 'CONICAL_SURFACE') {
      var c2 = axis2(doc, a[1]), r2 = num(a[2], 1), ang = num(a[3], Math.PI / 4);
      var tn = Math.tan(ang);
      return {
        kind: 'Cone', periodU: true, radius: r2, axis: c2.z, axisPt: c2.o, halfAngle: ang,
        evalUV: function (u, vv) {
          var rr = r2 + vv * tn;
          return add(c2.o, add(mul(c2.x, rr * Math.cos(u)), add(mul(c2.y, rr * Math.sin(u)), mul(c2.z, vv))));
        },
        uvOf: function (p) { var d = sub(p, c2.o); return [Math.atan2(dot(d, c2.y), dot(d, c2.x)), dot(d, c2.z)]; },
        normalAt: function (u) {
          var rad = add(mul(c2.x, Math.cos(u)), mul(c2.y, Math.sin(u)));
          return nrm(sub(mul(rad, Math.cos(ang)), mul(c2.z, Math.sin(ang))));
        }
      };
    }
    if (t === 'SPHERICAL_SURFACE') {
      var c3 = axis2(doc, a[1]), r3 = num(a[2], 1);
      return {
        kind: 'Sphere', periodU: true, radius: r3,
        evalUV: function (u, vv) {
          var cv = Math.cos(vv);
          return add(c3.o, mul(add(add(mul(c3.x, cv * Math.cos(u)), mul(c3.y, cv * Math.sin(u))), mul(c3.z, Math.sin(vv))), r3));
        },
        uvOf: function (p) {
          var d = sub(p, c3.o);
          return [Math.atan2(dot(d, c3.y), dot(d, c3.x)), Math.asin(clamp(dot(d, c3.z) / (r3 || 1), -1, 1))];
        },
        normalAt: function (u, vv) {
          var cv = Math.cos(vv);
          return nrm(add(add(mul(c3.x, cv * Math.cos(u)), mul(c3.y, cv * Math.sin(u))), mul(c3.z, Math.sin(vv))));
        }
      };
    }
    if (t === 'TOROIDAL_SURFACE') {
      var c4 = axis2(doc, a[1]), R4 = num(a[2], 1), r4 = num(a[3], 0.2);
      return {
        kind: 'Torus', periodU: true, periodV: true, radius: r4,
        evalUV: function (u, vv) {
          var rr = R4 + r4 * Math.cos(vv);
          return add(c4.o, add(mul(add(mul(c4.x, Math.cos(u)), mul(c4.y, Math.sin(u))), rr), mul(c4.z, r4 * Math.sin(vv))));
        },
        uvOf: function (p) {
          var d = sub(p, c4.o);
          return [Math.atan2(dot(d, c4.y), dot(d, c4.x)),
                  Math.atan2(dot(d, c4.z), Math.hypot(dot(d, c4.x), dot(d, c4.y)) - R4)];
        },
        normalAt: function (u, vv) {
          var rad = add(mul(c4.x, Math.cos(u)), mul(c4.y, Math.sin(u)));
          return nrm(add(mul(rad, Math.cos(vv)), mul(c4.z, Math.sin(vv))));
        }
      };
    }
    if (t === 'B_SPLINE_SURFACE_WITH_KNOTS' || t === 'RATIONAL_B_SPLINE_SURFACE' ||
        t === 'B_SPLINE_SURFACE' ||
        (ent.parts && ent.parts.length > 1 && doc.part(ent, 'B_SPLINE_SURFACE'))) {
      var bs = bsSurface(doc, ent);
      if (bs) return bs;
    }
    if (ctx) ctx.warn('曲面类型 ' + t + ' 未支持，按边界近似成平面显示');
    return { kind: 'Fallback', periodU: false };
  }

  /* --------------------------------------------------------- B 样条曲面 */
  function expandKnots(mults, knots, p, nCps) {
    var U = [];
    var ms = mults || [], ks = knots || [];
    for (var i = 0; i < ms.length; i++) {
      var mk = Math.round(num(ms[i], 0));
      for (var k = 0; k < mk; k++) U.push(num(ks[i], 0));
    }
    var need = nCps + p + 1;
    while (U.length < need) U.push(U.length ? U[U.length - 1] : 0);
    if (U.length > need) U = U.slice(0, need);
    return U;
  }

  function findSpan(U, p, n, u) {
    if (u >= U[n + 1]) return n;
    if (u <= U[p]) return p;
    var lo = p, hi = n + 1, mid = (lo + hi) >> 1, guard = 0;
    while ((u < U[mid] || u >= U[mid + 1]) && guard++ < 200) {
      if (u < U[mid]) hi = mid; else lo = mid;
      mid = (lo + hi) >> 1;
      if (mid >= hi) break;
    }
    return mid;
  }

  /* 基函数求值：热点中的热点。曲面 p(u,v) 每算一个点要调两次，牛顿每步调五次，
   * 45 MB 片体上合计上亿次。原实现每次 new 三个数组 —— 光分配和 GC 就占掉大半时间。
   * 改成模块级暂存（按需扩容、不跨调用保留语义），两套缓冲供 u/v 同时使用。 */
  var BF_N = [null, null], BF_L = [null, null], BF_R = [null, null], BF_SIZE = 0;
  function basisBuf(slot, p) {
    if (p + 1 > BF_SIZE) {
      BF_SIZE = p + 1 + 8;
      BF_N[0] = new Float64Array(BF_SIZE); BF_L[0] = new Float64Array(BF_SIZE); BF_R[0] = new Float64Array(BF_SIZE);
      BF_N[1] = new Float64Array(BF_SIZE); BF_L[1] = new Float64Array(BF_SIZE); BF_R[1] = new Float64Array(BF_SIZE);
    }
    return slot;
  }
  function basisFuns(i, u, p, U, slot) {
    var s = basisBuf(slot || 0, p);
    var N = BF_N[s], left = BF_L[s], right = BF_R[s];
    for (var z = 0; z <= p; z++) { N[z] = 0; left[z] = 0; right[z] = 0; }
    N[0] = 1;
    for (var j = 1; j <= p; j++) {
      left[j] = u - U[i + 1 - j];
      right[j] = U[i + j] - u;
      var saved = 0;
      for (var r = 0; r < j; r++) {
        var den = right[r + 1] + left[j - r];
        var tmp = den !== 0 ? N[r] / den : 0;
        N[r] = saved + right[r + 1] * tmp;
        saved = left[j - r] * tmp;
      }
      N[j] = saved;
    }
    return N;
  }

  function bsSurface(doc, ent) {
    var base = null, knt = null, rat = null;
    if (ent.parts && ent.parts.length > 1) {
      base = doc.part(ent, 'B_SPLINE_SURFACE');
      knt = doc.part(ent, 'B_SPLINE_SURFACE_WITH_KNOTS');
      rat = doc.part(ent, 'RATIONAL_B_SPLINE_SURFACE');
    } else {
      var a = ent.args;
      var o = (typeof a[0] === 'string') ? 1 : 0;
      base = a.slice(o);
      if (ent.type === 'B_SPLINE_SURFACE_WITH_KNOTS') knt = a.slice(o + 7);
      if (ent.type === 'RATIONAL_B_SPLINE_SURFACE') rat = [a[a.length - 1]];
    }
    if (!base) return null;
    var pu = Math.round(num(base[0], 3)), pv = Math.round(num(base[1], 3));
    var cpsRefs = base[2];
    if (!cpsRefs || !cpsRefs.length || !cpsRefs[0]) return null;
    var grid = [], weights = null;
    for (var i = 0; i < cpsRefs.length; i++) {
      var row = [];
      var r = cpsRefs[i] || [];
      for (var j = 0; j < r.length; j++) row.push(pointOf(doc, r[j]));
      grid.push(row);
    }
    var nu = grid.length, nv = grid[0].length;
    if (!nu || !nv || !knt) return null;
    if (rat && rat[0]) {
      weights = [];
      for (var wi = 0; wi < rat[0].length; wi++) {
        var wrow = [];
        var src = rat[0][wi] || [];
        for (var wj = 0; wj < src.length; wj++) wrow.push(num(src[wj], 1));
        weights.push(wrow);
      }
    }
    var U = expandKnots(knt[0], knt[2], pu, nu);
    var V = expandKnots(knt[1], knt[3], pv, nv);
    var u0 = U[pu], u1 = U[nu], v0 = V[pv], v1 = V[nv];

    var lastIu = -1, lastIv = -1;
    function spanU(u) {
      var i = lastIu;
      if (i >= pu && i < nu && U[i] <= u && u < U[i + 1]) return i;
      lastIu = findSpan(U, pu, nu - 1, u);
      return lastIu;
    }
    function spanV(vv) {
      var i = lastIv;
      if (i >= pv && i < nv && V[i] <= vv && vv < V[i + 1]) return i;
      lastIv = findSpan(V, pv, nv - 1, vv);
      return lastIv;
    }

    function pt(u, vv) {
      u = clamp(u, u0, u1);
      vv = clamp(vv, v0, v1);
      var iu = spanU(u), iv = spanV(vv);
      var Nu = basisFuns(iu, u, pu, U, 0), Nv = basisFuns(iv, vv, pv, V, 1);
      var sx = 0, sy = 0, sz = 0, sw = 0;
      for (var a2 = 0; a2 <= pu; a2++) {
        for (var b2 = 0; b2 <= pv; b2++) {
          var ci = iu - pu + a2, cj = iv - pv + b2;
          if (ci < 0 || ci >= nu || cj < 0 || cj >= nv) continue;
          var w = weights ? (weights[ci][cj] || 1) : 1;
          var ww = Nu[a2] * Nv[b2] * w;
          var P = grid[ci][cj];
          sx += P[0] * ww; sy += P[1] * ww; sz += P[2] * ww; sw += ww;
        }
      }
      if (Math.abs(sw) < 1e-12) return null;
      return [sx / sw, sy / sw, sz / sw];
    }

    /* 逆映射（3D → uv）。整条链上最贵的一步：每个环点都要算一次。
     * 旧实现每次都在 21×21 参数网格上做全局粗搜（单点 441 次曲面求值），
     * 可这张网格对同一张曲面上的**所有点**是同一张 —— 每个点重算一遍纯属浪费。
     * 45 MB 的 CATIA 片体（4518 面 / 124 万个环点）因此要跑 173 s。
     * 现在按面缓存一次粗搜表（441 次求值），每个点只做「扫表找最近格点 + 牛顿」，
     * 起点与旧实现逐字相同，所以结果只差浮点噪声，不是换了算法。 */
    var scaleR = 1;
    for (var gi = 0; gi < nu; gi++) {
      for (var gj = 0; gj < nv; gj++) {
        var gp = grid[gi][gj];
        if (gp) scaleR = Math.max(scaleR, Math.abs(gp[0]), Math.abs(gp[1]), Math.abs(gp[2]));
      }
    }
    var TOL2 = Math.pow(scaleR * 1e-10, 2);

    function newton(u, vv, p, iters) {
      for (var it = 0; it < iters; it++) {
        var S0 = pt(u, vv);
        if (!S0) return null;
        var fx = S0[0] - p[0], fy = S0[1] - p[1], fz = S0[2] - p[2];
        var e2 = fx * fx + fy * fy + fz * fz;
        if (e2 <= TOL2) return { uv: [u, vv], err2: e2 };    // 已收敛，别再白算导数
        var du = (u1 - u0) * 1e-3 + 1e-9, dv = (v1 - v0) * 1e-3 + 1e-9;
        var Pu1 = pt(u + du, vv) || S0, Pu0 = pt(u - du, vv) || S0;
        var Pv1 = pt(u, vv + dv) || S0, Pv0 = pt(u, vv - dv) || S0;
        var Su = [(Pu1[0] - Pu0[0]) / (2 * du), (Pu1[1] - Pu0[1]) / (2 * du), (Pu1[2] - Pu0[2]) / (2 * du)];
        var Sv = [(Pv1[0] - Pv0[0]) / (2 * dv), (Pv1[1] - Pv0[1]) / (2 * dv), (Pv1[2] - Pv0[2]) / (2 * dv)];
        var A11 = Su[0] * Su[0] + Su[1] * Su[1] + Su[2] * Su[2];
        var A12 = Su[0] * Sv[0] + Su[1] * Sv[1] + Su[2] * Sv[2];
        var A22 = Sv[0] * Sv[0] + Sv[1] * Sv[1] + Sv[2] * Sv[2];
        var b1 = -(Su[0] * fx + Su[1] * fy + Su[2] * fz);
        var b2 = -(Sv[0] * fx + Sv[1] * fy + Sv[2] * fz);
        var det = A11 * A22 - A12 * A12;
        if (Math.abs(det) < 1e-16) break;
        var dU = (b1 * A22 - A12 * b2) / det, dV = (A11 * b2 - A12 * b1) / det;
        u = clamp(u + dU, u0, u1);
        vv = clamp(vv + dV, v0, v1);
        if (Math.abs(dU) < 1e-9 && Math.abs(dV) < 1e-9) break;
      }
      var Se = pt(u, vv);
      if (!Se) return null;
      var ex = Se[0] - p[0], ey = Se[1] - p[1], ez = Se[2] - p[2];
      return { uv: [u, vv], err2: ex * ex + ey * ey + ez * ez };
    }

    /* 粗搜表：参数域 21×21 采样，懒建，一张面只建一次 */
    var coarse = null;
    function coarseGrid() {
      if (coarse) return coarse;
      var NU = 20, NV = 20, arr = [];
      for (var a3 = 0; a3 <= NU; a3++) {
        var uu = u0 + (u1 - u0) * a3 / NU;
        for (var b3 = 0; b3 <= NV; b3++) {
          var vv = v0 + (v1 - v0) * b3 / NV;
          var S = pt(uu, vv);
          if (S) arr.push(uu, vv, S[0], S[1], S[2]);
        }
      }
      coarse = arr;
      return coarse;
    }

    function uvOf(p) {
      var g = coarseGrid(), best = 0, bd = Infinity;
      /* 扫表：每格一次距离比较（不调曲面），比重算 441 次求值便宜两个数量级 */
      for (var k = 0; k < g.length; k += 5) {
        var dx = g[k + 2] - p[0], dy = g[k + 3] - p[1], dz = g[k + 4] - p[2];
        var d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bd) { bd = d2; best = k; }
      }
      var cu = g[best], cv = g[best + 1];
      var r = newton(cu, cv, p, 6);
      return r ? r.uv : [cu, cv];
    }

    function normalAt(u, vv) {
      var du = (u1 - u0) * 1e-3 + 1e-9, dv = (v1 - v0) * 1e-3 + 1e-9;
      var S0 = pt(u, vv);
      if (!S0) return [0, 0, 1];
      var Su = sub(pt(u + du, vv) || S0, pt(u - du, vv) || S0);
      var Sv = sub(pt(u, vv + dv) || S0, pt(u, vv - dv) || S0);
      var nn = cross(Su, Sv);
      return vlen(nn) > 1e-12 ? nrm(nn) : [0, 0, 1];
    }

    return { kind: 'BSpline', periodU: false, rational: !!weights, evalUV: pt, uvOf: uvOf, normalAt: normalAt };
  }

  /* ============================================================== 4. 曲线采样 */
  function circleParams(doc, ent) {
    var pl = axis2(doc, ent.args[1]);
    return { pl: pl, r: num(ent.args[2], 1) };
  }
  function angleOn(pl, p, r) {
    var d = sub(p, pl.o);
    var x = dot(d, pl.x), y = dot(d, pl.y);
    return Math.atan2(y, x);
  }

  function sampleCurve(doc, curveEnt, pStart, pEnd, dirSign, ctx) {
    if (!curveEnt) return null;
    var t = curveEnt.type;
    if (t === 'SURFACE_CURVE' || t === 'SEAM_CURVE' || t === 'INTERSECTION_CURVE') {
      return sampleCurve(doc, doc.ref(curveEnt.args[1]), pStart, pEnd, dirSign, ctx);
    }
    if (t === 'TRIMMED_CURVE') {
      var basis = doc.ref(curveEnt.args[1]);
      var dense = sampleCurve(doc, basis, pStart, pEnd, 1, ctx);
      if (!dense || dense.length < 2) return null;
      // 用密集采样 + 最近点截取，兼容 trim 参数不完整的情况
      var dense2 = sampleFull(doc, basis, ctx);
      if (dense2 && dense2.length > 3) dense = subPolyline(dense2, pStart, pEnd);
      return dense;
    }
    if (t === 'LINE') {
      return [pStart.slice(), pEnd.slice()];
    }
    if (t === 'CIRCLE' || t === 'ELLIPSE') {
      var cp = circleParams(doc, curveEnt);
      var ra = cp.r, rb = cp.r;
      if (t === 'ELLIPSE') { ra = num(curveEnt.args[2], 1); rb = num(curveEnt.args[3], 1); }
      var a0 = angleOn(cp.pl, pStart, ra);
      var a1 = angleOn(cp.pl, pEnd, ra);
      var closed = vlen(sub(pStart, pEnd)) < (Math.abs(ra) * 1e-6 + 1e-7);
      var da;
      if (closed) da = (dirSign < 0 ? -1 : 1) * PI2;
      else {
        da = wrapPi(a1 - a0);
        if (dirSign < 0) da = da > 0 ? da - PI2 : da;         // 取反方向最近到达
        else da = da < 0 ? da + PI2 : da;
        if (Math.abs(da) < 1e-9) da = (dirSign < 0 ? -1 : 1) * PI2;
      }
      var steps = Math.max(4, Math.min(96, Math.ceil(Math.abs(da) / (Math.PI / 36))));
      var pts = [];
      for (var i = 0; i <= steps; i++) {
        var ang = a0 + da * i / steps;
        pts.push(add(cp.pl.o, add(mul(cp.pl.x, ra * Math.cos(ang)), mul(cp.pl.y, rb * Math.sin(ang)))));
      }
      pts[0] = pStart.slice();
      pts[pts.length - 1] = pEnd.slice();
      // 恰好 180° 的弧在无 pcurve 时方向不可判定，标记后由 readLoop 用环路几何裁决
      pts.ambiguous = !closed && Math.abs(Math.abs(da) - Math.PI) < 1e-6;
      return pts;
    }
    if (t === 'POLYLINE') {
      var lst = curveEnt.args[1] || [], out = [];
      for (var q = 0; q < lst.length; q++) out.push(pointOf(doc, lst[q]));
      if (out.length && vlen(sub(out[0], pStart)) > vlen(sub(out[out.length - 1], pStart))) out.reverse();
      out[0] = pStart.slice(); out[out.length - 1] = pEnd.slice();
      return out;
    }
    if (t === 'B_SPLINE_CURVE_WITH_KNOTS' || t === 'RATIONAL_B_SPLINE_CURVE' || t === 'B_SPLINE_CURVE' ||
        (curveEnt.parts && curveEnt.parts.length > 1)) {
      var sp = sampleBSplineCurve(doc, curveEnt, pStart, pEnd);
      if (sp) return sp;
    }
    if (t === 'COMPOSITE_CURVE') {
      var segs = curveEnt.args[1] || [], acc = [];
      for (var s = 0; s < segs.length; s++) {
        var sc = doc.ref(segs[s]);
        if (!sc) continue;
        var seg = sampleCurve(doc, doc.ref(sc.args[1]), pointOf(doc, sc.args[2] || null), pointOf(doc, sc.args[3] || null), 1, ctx);
        if (!seg) continue;
        for (var k = acc.length ? 1 : 0; k < seg.length; k++) acc.push(seg[k]);
      }
      if (acc.length) { acc[0] = pStart.slice(); acc[acc.length - 1] = pEnd.slice(); return acc; }
    }
    if (ctx) ctx.warn('曲线类型 ' + t + ' 未支持，按弦线处理');
    return [pStart.slice(), pEnd.slice()];
  }

  function sampleBSplineCurve(doc, ent, pStart, pEnd) {
    var base = null, knt = null, rat = null;
    if (ent.parts && ent.parts.length > 1) {
      base = doc.part(ent, 'B_SPLINE_CURVE');
      knt = doc.part(ent, 'B_SPLINE_CURVE_WITH_KNOTS');
      rat = doc.part(ent, 'RATIONAL_B_SPLINE_CURVE');
    } else {
      var a = ent.args, o = (typeof a[0] === 'string') ? 1 : 0;
      base = a.slice(o);
      if (ent.type === 'B_SPLINE_CURVE_WITH_KNOTS') knt = a.slice(o + 5);
      if (ent.type === 'RATIONAL_B_SPLINE_CURVE') rat = [a[a.length - 1]];
    }
    if (!base) return null;
    var p = Math.round(num(base[0], 3));
    var cpsRefs = base[1] || [];
    var cps = [], ws = null;
    for (var i = 0; i < cpsRefs.length; i++) cps.push(pointOf(doc, cpsRefs[i]));
    if (cps.length < 2 || !knt) return null;
    if (rat && rat[0]) {
      ws = [];
      for (var j = 0; j < rat[0].length; j++) ws.push(num(rat[0][j], 1));
    }
    var U = expandKnots(knt[0], knt[1], p, cps.length);
    var t0 = U[p], t1 = U[cps.length];
    var n = clamp(cps.length * 8, 8, 240);
    var pts = [];
    for (var q = 0; q <= n; q++) {
      var t = t0 + (t1 - t0) * q / n;
      var span = findSpan(U, p, cps.length - 1, t);
      var N = basisFuns(span, t, p, U);
      var sx = 0, sy = 0, sz = 0, sw = 0;
      for (var k2 = 0; k2 <= p; k2++) {
        var ci = span - p + k2;
        if (ci < 0 || ci >= cps.length) continue;
        var w = ws ? (ws[ci] || 1) : 1;
        var ww = N[k2] * w;
        sx += cps[ci][0] * ww; sy += cps[ci][1] * ww; sz += cps[ci][2] * ww; sw += ww;
      }
      if (Math.abs(sw) < 1e-12) continue;
      pts.push([sx / sw, sy / sw, sz / sw]);
    }
    if (pts.length < 2) return null;
    // 端点对齐真实顶点，保证环连续
    if (vlen(sub(pts[0], pStart)) > vlen(sub(pts[pts.length - 1], pStart))) pts.reverse();
    pts[0] = pStart.slice();
    pts[pts.length - 1] = pEnd.slice();
    return pts;
  }

  function sampleFull(doc, ent, ctx) {
    var t = ent && ent.type;
    if (t === 'CIRCLE') {
      var cp = circleParams(doc, ent);
      var pts = [];
      for (var i = 0; i <= 72; i++) {
        var a = PI2 * i / 72;
        pts.push(add(cp.pl.o, add(mul(cp.pl.x, cp.r * Math.cos(a)), mul(cp.pl.y, cp.r * Math.sin(a)))));
      }
      return pts;
    }
    if (t === 'B_SPLINE_CURVE_WITH_KNOTS' || t === 'B_SPLINE_CURVE' || (ent.parts && ent.parts.length > 1)) {
      return sampleBSplineCurve(doc, ent, [0, 0, 0], [0, 0, 0]);
    }
    return null;
  }

  function subPolyline(pts, pStart, pEnd) {
    var i0 = nearestIdx(pts, pStart), i1 = nearestIdx(pts, pEnd);
    var out;
    if (i0 <= i1) out = pts.slice(i0, i1 + 1);
    else out = pts.slice(i1, i0 + 1).reverse();
    out[0] = pStart.slice(); out[out.length - 1] = pEnd.slice();
    return out;
  }
  function nearestIdx(pts, p) {
    var bi = 0, bd = Infinity;
    for (var i = 0; i < pts.length; i++) {
      var d = (pts[i][0] - p[0]) * (pts[i][0] - p[0]) + (pts[i][1] - p[1]) * (pts[i][1] - p[1]) + (pts[i][2] - p[2]) * (pts[i][2] - p[2]);
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  }

  /* ======================================================== 5. 环与面三角化 */
  /* 曲线类别：对齐 OCC 的 GeomAbs_CurveType 口径（AAGNet 边属性要用） */
  function curveKind(doc, ent) {
    var guard = 0;
    while (ent && guard++ < 8) {
      var t = ent.type;
      if (t === 'SURFACE_CURVE' || t === 'SEAM_CURVE' || t === 'INTERSECTION_CURVE' ||
          t === 'TRIMMED_CURVE') {
        ent = doc.ref(ent.args[1]);
        continue;
      }
      if (t === 'COMPOSITE_CURVE') {
        var sg = ent.args[1] || [];
        var e0 = sg.length ? doc.ref(sg[0]) : null;
        if (e0 && e0.type === 'COMPOSITE_CURVE_SEGMENT') e0 = doc.ref(e0.args[2]);
        ent = e0;
        continue;
      }
      break;
    }
    if (!ent) return { type: 'OTHER', rational: false };
    var kind = 'OTHER';
    if (doc.part(ent, 'LINE')) kind = 'LINE';
    else if (doc.part(ent, 'CIRCLE')) kind = 'CIRCLE';
    else if (doc.part(ent, 'ELLIPSE')) kind = 'ELLIPSE';
    else if (doc.part(ent, 'B_SPLINE_CURVE')) kind = 'BSPLINE';
    else if (doc.part(ent, 'BEZIER_CURVE')) kind = 'BEZIER';
    else if (doc.part(ent, 'POLYLINE')) kind = 'POLYLINE';
    var rational = !!doc.part(ent, 'RATIONAL_B_SPLINE_CURVE');
    return { type: kind, rational: rational };
  }

  function readLoop(doc, loopRef, ctx) {
    var ent = doc.ref(loopRef);
    if (!ent) return null;
    if (ent.type === 'POLY_LOOP') {
      var ps = ent.args[1] || [], p0 = [];
      for (var i = 0; i < ps.length; i++) p0.push(pointOf(doc, ps[i]));
      return p0.length >= 3 ? { pts: p0, segs: [] } : null;
    }
    var oes = ent.args[1] || [];
    var pieces = [];
    for (var q = 0; q < oes.length; q++) {
      var oe = doc.ref(oes[q]);
      if (!oe) continue;
      var ec = doc.ref(oe.args[3]);
      if (!ec) continue;
      var v1 = pointOf(doc, ec.args[1]), v2 = pointOf(doc, ec.args[2]);
      var oOriented = boolVal(oe.args[4], true);
      var same = boolVal(ec.args[4], true);
      var dirSign = (same === oOriented) ? 1 : -1;
      var pA = oOriented ? v1 : v2, pB = oOriented ? v2 : v1;
      var cache = ctx.arcCache;
      var ck = ec.id;
      var poly = null, alt = null, cached = cache ? cache.get(ck) : null;
      if (cached) {
        poly = cached.sign === dirSign ? cached.poly.slice() : cached.poly.slice().reverse();
      } else {
        poly = sampleCurve(doc, doc.ref(ec.args[3]), pA, pB, dirSign, ctx);
        if (!poly || poly.length < 2) continue;
        if (poly.ambiguous) {
          alt = sampleCurve(doc, doc.ref(ec.args[3]), pA, pB, -dirSign, ctx);
          if (alt && !alt.ambiguous) alt = null;
        }
      }
      if (!poly || poly.length < 2) continue;
      pieces.push({ poly: poly, alt: alt, id: ck, sign: dirSign,
                    curve: curveKind(doc, doc.ref(ec.args[3])),
                    closed: vlen(sub(v1, v2)) < 1e-7 });
    }
    if (!pieces.length) return null;

    // 恰好 180° 的圆弧方向不可判定：取「弧中点更靠近环路质心（不含待定弧）」的一侧，
    // 并把结论按边缓存，保证相邻面用同一段折线。
    var anyAlt = false;
    for (var z = 0; z < pieces.length; z++) if (pieces[z].alt) { anyAlt = true; break; }
    if (anyAlt) {
      var c = [0, 0, 0], n = 0;
      for (var a1 = 0; a1 < pieces.length; a1++) {
        if (pieces[a1].alt) continue;
        var pl = pieces[a1].poly;
        for (var a2 = 0; a2 < pl.length; a2++) { c = add(c, pl[a2]); n++; }
      }
      if (!n) {
        for (var b1 = 0; b1 < pieces.length; b1++) {
          var pl2 = pieces[b1].poly;
          for (var b2 = 0; b2 < pl2.length; b2++) { c = add(c, pl2[b2]); n++; }
        }
      }
      c = mul(c, 1 / Math.max(n, 1));
      for (var a3 = 0; a3 < pieces.length; a3++) {
        var pc = pieces[a3];
        if (!pc.alt) continue;
        var m1 = pc.poly[(pc.poly.length - 1) >> 1], m2 = pc.alt[(pc.alt.length - 1) >> 1];
        if (vlen(sub(m2, c)) + 1e-9 < vlen(sub(m1, c))) pc.poly = pc.alt;
      }
      if (cache) for (var a4 = 0; a4 < pieces.length; a4++) {
        if (pieces[a4].alt) cache.set(pieces[a4].id, { poly: pieces[a4].poly, sign: pieces[a4].sign });
      }
    }

    var pts = [], segs = [];
    for (var w = 0; w < pieces.length; w++) {
      var py = pieces[w].poly;
      var a = py[0], b = py[py.length - 1];
      var L = 0;
      for (var m = 1; m < py.length; m++) L += vlen(sub(py[m], py[m - 1]));
      segs.push({ key: edgeKey(a, b), len: L, pts: py,
                  curve: pieces[w].curve, closed: pieces[w].closed });
      var from = 0;
      if (pts.length && vlen(sub(pts[pts.length - 1], py[0])) < 1e-7) from = 1;
      for (var k = from; k < py.length; k++) pts.push(py[k]);
      if (pts.length > 6000) break;
    }
    // 环路是闭合的：末点与首点重合时去掉，避免退化三角形
    while (pts.length > 3 && vlen(sub(pts[0], pts[pts.length - 1])) < 1e-7) pts.pop();
    return pts.length >= 3 ? { pts: pts, segs: segs } : null;
  }

  function q(v) { return Math.round(v * 1e4) / 1e4; }
  function edgeKey(a, b) {
    var ka = q(a[0]) + ',' + q(a[1]) + ',' + q(a[2]);
    var kb = q(b[0]) + ',' + q(b[1]) + ',' + q(b[2]);
    return ka < kb ? ka + '|' + kb : kb + '|' + ka;
  }

  function area2(uv) {
    var s = 0;
    for (var i = 0; i < uv.length; i++) {
      var a = uv[i], b = uv[(i + 1) % uv.length];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return s * 0.5;
  }

  function toUV(surf, pts, seed0) {
    var uv = [], pu = null, pv = null, seed = seed0 || null;
    for (var i = 0; i < pts.length; i++) {
      var r = surf.uvOf(pts[i], seed);
      if (!r || !isFinite(r[0]) || !isFinite(r[1])) return null;
      var u = r[0], v = r[1];
      if (surf.periodU && pu !== null) u = pu + wrapPi(u - pu);
      if (surf.periodV && pv !== null) v = pv + wrapPi(v - pv);
      uv.push([u, v]); pu = u; pv = v; seed = [u, v];
    }
    return uv;
  }

  function meanUV(uv) {
    var su = 0, sv = 0;
    for (var i = 0; i < uv.length; i++) { su += uv[i][0]; sv += uv[i][1]; }
    return [su / uv.length, sv / uv.length];
  }

  function bridgeHole(outer, hole) {
    var hi = 0;
    for (var i = 1; i < hole.length; i++) if (hole[i][0] > hole[hi][0]) hi = i;
    var h = hole[hi];
    var bestX = Infinity, bestEdge = -1;
    for (var e = 0; e < outer.length; e++) {
      var a = outer[e], b = outer[(e + 1) % outer.length];
      if ((a[1] > h[1]) === (b[1] > h[1])) continue;
      var t = (h[1] - a[1]) / (b[1] - a[1]);
      var x = a[0] + (b[0] - a[0]) * t;
      if (x >= h[0] - 1e-12 && x < bestX) { bestX = x; bestEdge = e; }
    }
    if (bestEdge < 0) return outer;
    var a2 = outer[bestEdge], b2 = outer[(bestEdge + 1) % outer.length];
    var vi = a2[0] > b2[0] ? bestEdge : (bestEdge + 1) % outer.length;
    var ring = hole.slice(hi).concat(hole.slice(0, hi));
    var res = outer.slice(0, vi + 1).concat(ring).concat([ring[0]]).concat(outer.slice(vi));
    return res;
  }

  function triIn(a, b, c, p) {
    // 与三角形顶点重合的点不算「在内」（孔桥接会产生重合顶点）
    function same(p1, p2) { return Math.abs(p1[0] - p2[0]) < 1e-12 && Math.abs(p1[1] - p2[1]) < 1e-12; }
    if (same(p, a) || same(p, b) || same(p, c)) return false;
    function s2(p1, p2, p3) { return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]); }
    var d1 = s2(p, a, b), d2 = s2(p, b, c), d3 = s2(p, c, a);
    var neg = (d1 < -1e-12) || (d2 < -1e-12) || (d3 < -1e-12);
    var pos = (d1 > 1e-12) || (d2 > 1e-12) || (d3 > 1e-12);
    return !(neg && pos);
  }

  function earClip(poly) {
    var n = poly.length, tris = [];
    if (n < 3) return tris;
    var idx = [];
    for (var i = 0; i < n; i++) idx.push(i);
    var guard = 0, limit = n * n + 64;
    while (idx.length > 3 && guard++ < limit) {
      // 选「形状质量最好」的耳朵，而不是「面积最小」的：
      // 圆柱/圆锥/球面的参数域常是长条，按面积最小剪会切出跨大段参数（曲率被弦拉直）的
      // 细长三角——UV 面积很小、3D 面积却很大，导致面积统计偏大、法线乱、视觉破面。
      // 质量指标 4√3·A/ΣL²：等边=1，退化→0；同质量时取面积较小者，收敛更稳。
      var bestK = -1, bestQ = -1, bestA = Infinity;
      var m = idx.length;
      for (var k = 0; k < m; k++) {
        var i0 = idx[(k - 1 + m) % m], i1 = idx[k], i2 = idx[(k + 1) % m];
        var a = poly[i0], b = poly[i1], c = poly[i2];
        var cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if (cr <= 1e-13) continue;
        var ar = cr * 0.5;
        var s1 = (a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]);
        var s2 = (b[0] - c[0]) * (b[0] - c[0]) + (b[1] - c[1]) * (b[1] - c[1]);
        var s3 = (c[0] - a[0]) * (c[0] - a[0]) + (c[1] - a[1]) * (c[1] - a[1]);
        var sums = s1 + s2 + s3;
        var qa = sums > 1e-20 ? 6.928203230275509 * ar / sums : 0;
        if (qa < bestQ - 1e-12) continue;
        if (qa <= bestQ + 1e-12 && ar >= bestA) continue;
        var ok = true;
        /* 包含判定前先过包围盒：绝大多数顶点远离这只耳朵，跳过它们不改结果（triIn 本来就返回 false） */
        var bx0 = a[0] < b[0] ? (a[0] < c[0] ? a[0] : c[0]) : (b[0] < c[0] ? b[0] : c[0]);
        var bx1 = a[0] > b[0] ? (a[0] > c[0] ? a[0] : c[0]) : (b[0] > c[0] ? b[0] : c[0]);
        var by0 = a[1] < b[1] ? (a[1] < c[1] ? a[1] : c[1]) : (b[1] < c[1] ? b[1] : c[1]);
        var by1 = a[1] > b[1] ? (a[1] > c[1] ? a[1] : c[1]) : (b[1] > c[1] ? b[1] : c[1]);
        for (var j = 0; j < m; j++) {
          var mm = idx[j];
          if (mm === i0 || mm === i1 || mm === i2) continue;
          var qq = poly[mm];
          if (qq[0] < bx0 || qq[0] > bx1 || qq[1] < by0 || qq[1] > by1) continue;
          if (triIn(a, b, c, qq)) { ok = false; break; }
        }
        if (!ok) continue;
        bestK = k; bestQ = qa; bestA = ar;
        if (qa > 0.75) break; // 已经足够接近等边，不再找
      }
      if (bestK < 0) break;
      var j0 = idx[(bestK - 1 + idx.length) % idx.length];
      var j1 = idx[bestK];
      var j2 = idx[(bestK + 1) % idx.length];
      tris.push([poly[j0], poly[j1], poly[j2]]);
      idx.splice(bestK, 1);
    }
    if (idx.length === 3) tris.push([poly[idx[0]], poly[idx[1]], poly[idx[2]]]);
    else if (idx.length > 3) {
      for (var t = 1; t + 1 < idx.length; t++) tris.push([poly[idx[0]], poly[idx[t]], poly[idx[t + 1]]]);
    }
    return tris;
  }

  function triangulate(loopsUV) {
    if (!loopsUV.length) return [];
    var outer = null, holes = [];
    for (var i = 0; i < loopsUV.length; i++) {
      var lp = loopsUV[i];
      if (!outer && (lp.outer || loopsUV.length === 1)) outer = lp;
    }
    if (!outer) {
      var bestA = -1;
      for (var j = 0; j < loopsUV.length; j++) {
        var ar = Math.abs(area2(loopsUV[j].uv));
        if (ar > bestA) { bestA = ar; outer = loopsUV[j]; }
      }
    }
    for (var k = 0; k < loopsUV.length; k++) if (loopsUV[k] !== outer) holes.push(loopsUV[k]);

    var oUV = outer.uv.slice();
    if (area2(oUV) < 0) oUV.reverse();
    var holeUVs = [];
    for (var h = 0; h < holes.length; h++) {
      var hu = holes[h].uv.slice();
      if (area2(hu) > 0) hu.reverse();
      holeUVs.push(hu);
    }
    holeUVs.sort(function (A, B) {
      var ma = 0, mb = 0;
      for (var t = 0; t < A.length; t++) ma = Math.max(ma, A[t][0]);
      for (var t2 = 0; t2 < B.length; t2++) mb = Math.max(mb, B[t2][0]);
      return mb - ma;
    });
    var poly = oUV;
    for (var q2 = 0; q2 < holeUVs.length; q2++) poly = bridgeHole(poly, holeUVs[q2]);
    return earClip(poly);
  }

  /* ---------------------------------------------------------------- 3.9 网格细分
   * 耳切只在边界点之间连三角：一张曲面片内部一个采样点都没有，整个圆柱面
   * 可能就是一个跨度 90° 的平面三角形。着色出来是棱面，轮廓也是折线。
   *
   * 这里在 uv 域做自适应 1→4 细分，两条判据：
   *   sagitta —— 重心处真实曲面点到三角形平面的距离（弦高误差，决定曲面看起来光不光）
   *   maxLen  —— 3D 边长上限（保证三角形不被拉成细长条，明暗过渡才不会跳）
   * 平面直接返回：平面上细分没有任何视觉收益，纯烧顶点。
   *
   * 预算按面给（buildPart 按总面数分摊），到顶就停止细分但没有丢弃 ——
   * 宁可局部精度低一点，也不能让 4500 面的件把浏览器顶死。 */
  function refineTris(surf, tris, tol, maxLen, budget, maxDepth) {
    if (!tris.length || surf.kind === 'Plane') return tris;
    var out = [], stack = [];
    for (var i = 0; i < tris.length; i++) stack.push([tris[i], 0]);

    /* 顶点求值缓存：1→4 时每个子三角形都在复用父三角形的中点，
     * 同一条边被两个三角形共享 —— 不缓存的话曲面求值次数翻四倍。
     * key 用两个双精度数的 toString：同一对 (u,v) 一定得到同一个字符串，
     * 中点 (a+b)/2 在相邻两边上也一定是同一个双精度值，命中率接近 100%。 */
    var memo = new Map();
    function ev(uv) {
      var k = uv[0] + '|' + uv[1];
      var p = memo.get(k);
      if (p === undefined) { p = surf.evalUV(uv[0], uv[1]); memo.set(k, p); }
      return p;
    }
    function midUV(a, b) { return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5]; }
    function d2(a, b) { var x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2]; return x * x + y * y + z * z; }

    var tol2 = tol * tol, maxLen2 = maxLen * maxLen;
    while (stack.length) {
      var item = stack.pop(), t = item[0], d = item[1];
      if (d >= maxDepth || out.length >= budget) { out.push(t); continue; }
      var A = ev(t[0]), B = ev(t[1]), C = ev(t[2]);
      if (!A || !B || !C) { out.push(t); continue; }

      var split = false;
      /* 边长先判：一次比较就能挡掉绝大多数已经够小的三角形，不用去求重心 */
      if (d2(A, B) > maxLen2 || d2(B, C) > maxLen2 || d2(C, A) > maxLen2) split = true;
      if (!split) {
        var ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
        var vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
        var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        var nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (nl > 1e-16) {
          nx /= nl; ny /= nl; nz /= nl;
          var G = ev([(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3]);
          if (G) {
            var dd = (G[0] - A[0]) * nx + (G[1] - A[1]) * ny + (G[2] - A[2]) * nz;
            if (dd * dd > tol2) split = true;
          }
        }
      }
      if (!split) { out.push(t); continue; }

      var m01 = midUV(t[0], t[1]), m12 = midUV(t[1], t[2]), m20 = midUV(t[2], t[0]);
      stack.push([[t[0], m01, m20], d + 1]);
      stack.push([[m01, t[1], m12], d + 1]);
      stack.push([[m20, m12, t[2]], d + 1]);
      stack.push([[m01, m12, m20], d + 1]);
    }
    return out;
  }

  /* 全局尺度：拿 CARTESIAN_POINT 的包围盒对角线当「单位」。
   * 细分容差与目标边长都按它的比例给，这样 20 mm 的小板和 2 m 的蒙皮
   * 都能得到疏密相当的网格，不用为每个件手调参数。 */
  function estimateScale(doc) {
    var arr = doc.d.byType.get('CARTESIAN_POINT') || [];
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < arr.length; i++) {
      var e = doc.e.get(arr[i]);
      var c = e && e.args[1];
      if (!c || c.length < 3) continue;
      var x = +c[0], y = +c[1], z = +c[2];
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
      if (x < mn[0]) mn[0] = x; if (x > mx[0]) mx[0] = x;
      if (y < mn[1]) mn[1] = y; if (y > mx[1]) mx[1] = y;
      if (z < mn[2]) mn[2] = z; if (z > mx[2]) mx[2] = z;
    }
    var dg = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
    return dg > 0 && isFinite(dg) ? dg : 1;
  }

  function tessFace(doc, fid, fe, ctx) {
    var surf = makeSurface(doc, fe.args[2], ctx);
    if (!surf) { ctx.skip('面 #' + fid + '：曲面无法解析'); return null; }
    var same = boolVal(fe.args[3], true);
    var boundRefs = fe.args[1] || [];
    var raw = [];
    for (var i = 0; i < boundRefs.length; i++) {
      var b = doc.ref(boundRefs[i]);
      if (!b) continue;
      var lp = readLoop(doc, b.args[1], ctx);
      if (!lp) continue;
      raw.push({ pts: lp.pts, segs: lp.segs, outer: (b.type === 'FACE_OUTER_BOUND') });
    }
    if (!raw.length) { ctx.skip('面 #' + fid + '：没有可用边界环'); return null; }

    if (surf.kind === 'Fallback') {
      var outer0 = raw[0].pts;
      var nn = newell(outer0);
      var oo = outer0[0];
      surf = {
        kind: 'Plane', periodU: false, normal: nn, approx: true,
        evalUV: function (u, v) { return add(oo, add(mul(perpTo(nn), u), mul(cross(nn, perpTo(nn)), v))); },
        uvOf: function (p) { var d = sub(p, oo); var X = perpTo(nn), Y = cross(nn, X); return [dot(d, X), dot(d, Y)]; },
        normalAt: function () { return nn; }
      };
      ctx.warn('有 ' + 1 + ' 个面按平面近似（原始曲面类型未支持）');
    }

    var loopsUV = [], seedUV = null;
    for (var r = 0; r < raw.length; r++) {
      var uv = toUV(surf, raw[r].pts, seedUV);
      if (!uv || uv.length < 3) continue;
      seedUV = uv[0];              // 下一个环的第一点从本环起点起跳：孔与外环通常挨着
      loopsUV.push({ uv: uv, outer: raw[r].outer });
    }
    if (!loopsUV.length) { ctx.skip('面 #' + fid + '：参数域映射失败'); return null; }

    // 内环对齐到外环的参数分支
    if (surf.periodU || surf.periodV) {
      var base = meanUV(loopsUV[0].uv);
      for (var s = 1; s < loopsUV.length; s++) {
        var mc = meanUV(loopsUV[s].uv);
        if (surf.periodU) {
          var kk = Math.round((base[0] - mc[0]) / PI2);
          if (kk) for (var t3 = 0; t3 < loopsUV[s].uv.length; t3++) loopsUV[s].uv[t3][0] += kk * PI2;
        }
        if (surf.periodV) {
          var k2 = Math.round((base[1] - mc[1]) / PI2);
          if (k2) for (var t4 = 0; t4 < loopsUV[s].uv.length; t4++) loopsUV[s].uv[t4][1] += k2 * PI2;
        }
      }
    }

    var tris = triangulate(loopsUV);
    if (!tris.length) { ctx.skip('面 #' + fid + '：三角化失败（' + loopsUV.length + ' 环）'); return null; }

    /* 小面直接跳过：弦高不会超过边长本身，面比容差还小的时候拆它没有意义。
     * 这一步只看边界点的包围盒，不调曲面求值 —— 大件上能省掉绝大多数判定
     * （4518 个面里需要细分的不到十分之一，逐个跑 refineTris 纯属白烧 4 秒）。 */
    var needRefine = false;
    if (surf.kind !== 'Plane' && isFinite(ctx.tol) && ctx.tol > 0) {
      var lo0 = [Infinity, Infinity, Infinity], hi0 = [-Infinity, -Infinity, -Infinity];
      for (var rb = 0; rb < raw.length; rb++) {
        var bp = raw[rb].pts;
        for (var bi = 0; bi < bp.length; bi++) {
          for (var bc = 0; bc < 3; bc++) {
            if (bp[bi][bc] < lo0[bc]) lo0[bc] = bp[bi][bc];
            if (bp[bi][bc] > hi0[bc]) hi0[bc] = bp[bi][bc];
          }
        }
      }
      var fdiag = Math.hypot(hi0[0] - lo0[0], hi0[1] - lo0[1], hi0[2] - lo0[2]);
      needRefine = fdiag > ctx.tol * 8;
    }

    /* 渲染精度：按弦高误差把曲面补密。平面跳过，每面有三角形预算。 */
    if (needRefine) {
      tris = refineTris(surf, tris, ctx.tol, ctx.maxLen, ctx.faceBudget, 4);
    }

    var pos = [], verts = [], uvs = [], area = 0, cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0;
    var bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
    var count = 0;
    for (var q3 = 0; q3 < tris.length; q3++) {
      var tri = tris[q3];
      var P = [surf.evalUV(tri[0][0], tri[0][1]), surf.evalUV(tri[1][0], tri[1][1]), surf.evalUV(tri[2][0], tri[2][1])];
      if (!P[0] || !P[1] || !P[2]) continue;
      var bad = false;
      for (var u2 = 0; u2 < 3; u2++) {
        if (!isFinite(P[u2][0]) || !isFinite(P[u2][1]) || !isFinite(P[u2][2])) { bad = true; break; }
      }
      if (bad) continue;
      var e1 = sub(P[1], P[0]), e2 = sub(P[2], P[0]);
      var cr2 = cross(e1, e2);
      var aTri = vlen(cr2) * 0.5;
      if (aTri < 1e-12) continue;
      /* 带孔的面先桥接再耳切，桥接后的多边形是弱简单多边形，耳切偶尔会切出
       * 反向的耳朵（自交）：这些三角形与别的三角形重叠，若按 |三角形| 直接累加，
       * 面积会被重复计数（曾出现 7328 mm² 的面，真值 2534 —— 偏大 2.9 倍，
       * 直接把这个面的 area 特征推到 +9σ）。外环在 triangulate 里已统一成
       * 正向，所以这里用「uv 面积符号」当权重累加，重叠部分自然抵消，
       * 收敛到 外环 − 内环 的真值；渲染的三角形一个不少，视觉不变。 */
      var sgn = ((tri[1][0] - tri[0][0]) * (tri[2][1] - tri[0][1]) -
                 (tri[2][0] - tri[0][0]) * (tri[1][1] - tri[0][1])) >= 0 ? 1 : -1;
      var cen = [(P[0][0] + P[1][0] + P[2][0]) / 3, (P[0][1] + P[1][1] + P[2][1]) / 3, (P[0][2] + P[1][2] + P[2][2]) / 3];
      var w3 = aTri * sgn;
      area += w3;
      cx += cen[0] * w3; cy += cen[1] * w3; cz += cen[2] * w3;
      var un = mul(cr2, 1 / (aTri * 2));   // 单位几何法线：仅用于面法线 / 凸凹特征
      nx += un[0] * w3; ny += un[1] * w3; nz += un[2] * w3;
      for (var w = 0; w < 3; w++) {
        pos.push(P[w][0], P[w][1], P[w][2]);
        verts.push(P[w]);
        uvs.push(tri[w]);
        for (var d2 = 0; d2 < 3; d2++) {
          if (P[w][d2] < bmin[d2]) bmin[d2] = P[w][d2];
          if (P[w][d2] > bmax[d2]) bmax[d2] = P[w][d2];
        }
      }
      count++;
    }
    if (!count || Math.abs(area) <= 1e-12) { ctx.skip('面 #' + fid + '：面积为 0'); return null; }
    if (area < 0) { area = -area; cx = -cx; cy = -cy; cz = -cz; nx = -nx; ny = -ny; nz = -nz; }

    var ctr = [cx / area, cy / area, cz / area];
    var normal;
    if (surf.kind === 'Plane') {
      normal = surf.normal.slice();
    } else if (surf.kind === 'Cylinder' || surf.kind === 'Cone') {
      var uu = surf.uvOf(ctr);
      normal = surf.normalAt ? surf.normalAt(uu[0]) : nrm([nx, ny, nz]);
    } else {
      normal = nrm([nx, ny, nz]);
    }
    if (!same) normal = mul(normal, -1);

    /* 逐顶点法线：给渲染端做 Gouraud 插值，曲面才显得连续光滑。
     * 只给面法线的话，细分得再密也是一块块小平面（每块一个色）。
     *
     * 分两类曲面，各有各的坑：
     *   ① 解析曲面（Plane/Cylinder/Cone/Sphere/Torus）：normalAt 是解析式
     *      （圆柱就是 cos(u)x + sin(u)y 的径向），方向物理正确、绕整圈连续。
     *      直接用它，符号统一对齐到面法线 normal 即可 —— normal 对圆柱/圆锥
     *      是质心那一个角度的径向，与各点径向点积 = cos(Δu)，半圈内恒正，
     *      不会把孔壁翻进材料里。
     *   ② B 样条（kind==='BSpline'）：normalAt 是 ∂P/∂u × ∂P/∂v 的数值差分，
     *      参数域折叠处符号会突变。若用它再逐三角形对齐符号，共享顶点上的
     *      法线就会断裂（实测座椅件 2762 个面 180° 散布，着色明显条带/分块）。
     *      改用「面内共享顶点聚合叉积」smooth normal：三角形先按面参考翻正
     *      （消除折叠面里缠绕正负混杂的互相抵消），共享顶点累加未归一化的叉积
     *      （长度=2×面积，面积天然当权重），最后归一化 —— 法线在共享顶点
     *      必然连续，杜绝 180° 散布。
     * 叉积只用于「法线」，不碰顶点顺序，area 的 uv 符号权重、gAAG 属性、
     * 网络判定全部不受影响。 */
    var nrms = [];
    if (surf.kind === 'Plane' || !verts.length) {
      for (var nv = 0; nv < verts.length; nv++) nrms.push(normal[0], normal[1], normal[2]);
    } else if (surf.kind !== 'BSpline') {
      /* 解析曲面（Cylinder/Cone/Sphere/Torus）：normalAt 是解析式（圆柱就是
       * cos(u)x + sin(u)y 的径向），方向物理正确、绕整圈连续。符号只需定
       * **一次全局方向**（朝外还是朝内），用 same 标志（STEP 的 SAME_SENSE）
       * 就够了 —— 不能逐顶点跟面法线 normal 点积：normal 对圆柱只是质心那
       * 一个角度的径向，绕半圈点积从 +1 变到 -1，会把一半孔壁翻进材料里。
       * 面法线 normal 本身也是「质心 normalAt × same」，所以这里直接
       * normalAt × (same?1:-1) 与它方向全局一致。 */
      var nCache = new Map();
      var sg = same ? 1 : -1;
      for (var nv2 = 0; nv2 < uvs.length; nv2++) {
        var uvq = uvs[nv2], nk = uvq[0] + '|' + uvq[1];
        var nnv = nCache.get(nk);
        if (!nnv) {
          nnv = surf.normalAt(uvq[0], uvq[1]) || normal;
          nCache.set(nk, nnv);
        }
        nrms.push(nnv[0] * sg, nnv[1] * sg, nnv[2] * sg);
      }
    } else {
      /* B 样条：聚合叉积 smooth normal。
       * 关键：累加**未归一化的叉积**（叉积长度 = 2×三角形面积），面积天然当权重。
       * 折叠面的耳切会产生大量「顶点几乎重合」的退化细长三角，它们的叉积方向
       * 是数值噪声（三个点近似共线，叉积方向随机）；若先归一化成单位向量再累加，
       * 这些噪声三角形和正常三角形等权，会把邻域法线搅乱（实测座椅件 7.5% 三角形
       * 出现 30°~180° 的法线突变，着色就是明显的分块/条带）。用面积加权后，
       * 退化三角形面积趋近 0，贡献自动消失，只剩正常三角形的平滑法线。 */
      var nAcc = new Map();
      var nRef = null;
      for (var q4 = 0; q4 + 2 < verts.length; q4 += 3) {
        var a = verts[q4], b = verts[q4 + 1], c = verts[q4 + 2];
        var cr = cross(sub(b, a), sub(c, a));     // 叉积，长度 = 2×面积
        var cl = vlen(cr);
        if (cl < 1e-12) continue;
        if (!nRef) { nRef = [cr[0] / cl, cr[1] / cl, cr[2] / cl]; }
        else if (cr[0] * nRef[0] + cr[1] * nRef[1] + cr[2] * nRef[2] < 0) cr = mul(cr, -1);
        for (var w2 = 0; w2 < 3; w2++) {
          var vv = verts[q4 + w2];
          var key = vv[0] + '|' + vv[1] + '|' + vv[2];
          var acc2 = nAcc.get(key);
          if (!acc2) { acc2 = [0, 0, 0]; nAcc.set(key, acc2); }
          acc2[0] += cr[0]; acc2[1] += cr[1]; acc2[2] += cr[2];   // 累加原始叉积（面积加权）
        }
      }
      /* 关键：把整面法线统一到几何朝向 normal（已含 same 校正）。
       * 上面 nRef 用的是「面内第一个三角形」的叉积方向，跟 STEP 的 same_sense
       * 几何定向无关 —— 相邻两个 B 样条 patch 可能一个朝外、一个朝内，符号随机。
       * shader 是 abs() 双面光照，abs 只消除「单面内朝前/朝后」的差异，消不掉
       * 「相邻面符号相反」造成的相对明暗差，于是出现粉/绿双色、接缝、连续面里
       * 突兀一块异色。所以输出前用 normal 点积判一次整面符号，把 B 样条面也
       * 对齐到跟解析曲面一致的正确外侧。 */
      var bgDot = 0;
      var nKeys = [];
      for (var nv3 = 0; nv3 < verts.length; nv3++) {
        var v3 = verts[nv3];
        var key3 = v3[0] + '|' + v3[1] + '|' + v3[2];
        var acc3 = nAcc.get(key3);
        if (!acc3) continue;
        nKeys.push([nv3, acc3]);
        bgDot += acc3[0] * normal[0] + acc3[1] * normal[1] + acc3[2] * normal[2];
      }
      var bg = bgDot < 0 ? -1 : 1;
      var nrmLookup = new Map();
      for (var nk2 = 0; nk2 < nKeys.length; nk2++) {
        var item = nKeys[nk2];
        var acc3 = item[1];
        var al = vlen(acc3);
        var nx3, ny3, nz3;
        if (al < 1e-12) { nx3 = normal[0]; ny3 = normal[1]; nz3 = normal[2]; }
        else { nx3 = acc3[0] / al * bg; ny3 = acc3[1] / al * bg; nz3 = acc3[2] / al * bg; }
        nrmLookup.set(item[0], [nx3, ny3, nz3]);
      }
      for (var nv4 = 0; nv4 < verts.length; nv4++) {
        var got = nrmLookup.get(nv4);
        if (!got) { nrms.push(normal[0], normal[1], normal[2]); continue; }
        nrms.push(got[0], got[1], got[2]);
      }
    }

    /* 环向校正：凸凹判定要「材料在左」的走向。
     * 面 A 的裁剪域就是它的材料面片。沿边界走一圈时「材料在左」= 相对外法向逆时针；
     * 注意内环（孔/型腔口）反过来：存盘时内环与外环同向（都是 CCW），
     * 而材料在环的外侧，所以真正「材料在左」要走成 CW。
     * 这就是下面 outer 这一项的作用 —— 少了它，所有孔/型腔口边的凸凹整体判反。 */
    for (var wr = 0; wr < raw.length; wr++) {
      var lpPts = raw[wr].pts;
      if (!lpPts || lpPts.length < 3) continue;
      var nw = newell(lpPts);
      var nl = vlen(nw);
      var cosw = nl > 1e-14 ? dot(nw, normal) / nl : 0;
      var windOK = Math.abs(cosw) > 0.5;
      var flipT = ((cosw > 0) === !!raw[wr].outer) ? 1 : -1;
      var sgs = raw[wr].segs || [];
      for (var ws = 0; ws < sgs.length; ws++) { sgs[ws].flipT = flipT; sgs[ws].windOK = windOK; }
    }

    // 圆柱面的包角：判断「整圈孔壁」还是「局部弧面（缺口 / 槽端）」
    var arcDeg = null;
    if (surf.kind === 'Cylinder' || surf.kind === 'Cone' || surf.kind === 'Torus') {
      var angs = [];
      for (var vi = 0; vi < verts.length; vi++) {
        var a = surf.uvOf(verts[vi]);
        if (a && isFinite(a[0])) angs.push(a[0]);
      }
      if (angs.length > 2) {
        angs.sort(function (p1, p2) { return p1 - p2; });
        var maxGap = 0;
        for (var ai = 0; ai < angs.length; ai++) {
          var nx2 = (ai + 1 < angs.length) ? angs[ai + 1] : angs[0] + PI2;
          var g2 = nx2 - angs[ai];
          if (g2 > maxGap) maxGap = g2;
        }
        arcDeg = (PI2 - maxGap) * 180 / Math.PI;
      }
    }

    return {
      step_id: fid,
      pos: pos, nrm: nrms, verts: verts, area: area, tris: count,
      centroid: ctr, bbox_min: bmin, bbox_max: bmax,
      normal: normal,
      radius: (surf.kind === 'Cylinder' || surf.kind === 'Cone') ? Math.abs(surf.radius) : null,
      axis: surf.axis || null,
      axis_pt: surf.axisPt || null,
      arcDeg: arcDeg,
      kind: surf.kind,
      surf: surf, same: same,
      loops: raw,
      _uv: loopsUV, _tris: tris
    };
  }

  function newell(pts) {
    var n = [0, 0, 0];
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length];
      n[0] += (a[1] - b[1]) * (a[2] + b[2]);
      n[1] += (a[2] - b[2]) * (a[0] + b[0]);
      n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    return nrm(n);
  }

  /* ====================================================== 6. 单位与实体收集 */
  function unitToMM(doc) {
    var ids = doc.d.all;
    for (var i = 0; i < ids.length; i++) {
      var ent = doc.e.get(ids[i]);
      var si = doc.part(ent, 'SI_UNIT');
      if (si) {
        var prefix = si[0] && si[0].e ? si[0].e : '';
        var base = si[1] && si[1].e ? si[1].e : 'METRE';
        if (base === 'METRE') {
          var f = { MILLI: 1, CENTI: 10, DECI: 100, KILO: 1e6, MICRO: 1e-3, NANO: 1e-6 }[prefix];
          return typeof f === 'number' ? f : 1000;
        }
      }
    }
    for (var j = 0; j < ids.length; j++) {
      var e2 = doc.e.get(ids[j]);
      if (e2.type === 'CONVERSION_BASED_UNIT') {
        var nm = String(e2.args[0] || '').toUpperCase();
        if (nm.indexOf('INCH') >= 0) return 25.4;
        if (nm.indexOf('FOOT') >= 0) return 304.8;
      }
    }
    return 1;
  }

  /* 面类型只用于显示与规则命中判断；AAGNet 用的是 kind 原值，两者不要混 */
  function kindLabel(k) {
    if (k === 'Plane' || k === 'Cylinder' || k === 'Cone' || k === 'Sphere' || k === 'Torus') return k;
    if (k === 'BSpline') return 'BSpline';
    return 'Other';
  }

  /* 模型形态：实体（MANIFOLD_SOLID_BREP / CLOSED_SHELL）还是片体（SHELL_BASED_SURFACE_MODEL）。
   * CATIA 的复材蒙皮、曲面设计件经常是纯片体，这类件没有「实体内部」，
   * 机加工特征识别（孔/腔/台阶）本身就不成立，AAGNet 也不该硬跑。 */
  function modelShape(doc) {
    function n(t) { var a = doc.d.byType.get(t); return a ? a.length : 0; }
    return {
      solids: n('MANIFOLD_SOLID_BREP'),
      closedShells: n('CLOSED_SHELL'),
      surfaceModels: n('SHELL_BASED_SURFACE_MODEL'),
      openShells: n('OPEN_SHELL')
    };
  }

  function collectFaceIds(doc) {
    var out = [], seen = new Set();
    function push(id) { if (id !== null && !seen.has(id)) { seen.add(id); out.push(id); } }
    var solids = doc.d.byType.get('MANIFOLD_SOLID_BREP') || [];
    for (var i = 0; i < solids.length; i++) {
      var s = doc.e.get(solids[i]);
      var shell = doc.ref(s.args[1]);
      if (!shell) continue;
      var fl = shell.args[1] || [];
      for (var k = 0; k < fl.length; k++) push(refId(fl[k]));
    }
    if (!out.length) {
      var alt = ['ADVANCED_FACE', 'FACE_SURFACE'];
      for (var a = 0; a < alt.length; a++) {
        var arr = doc.d.byType.get(alt[a]) || [];
        for (var b = 0; b < arr.length; b++) push(arr[b]);
      }
    }
    return out;
  }

  /* =========================================================== 7. 规则识别 */
  var UP = [0, 0, 1];

  function f1(x) { var s = x.toFixed(1); return s === '-0.0' ? '0.0' : s; }

  function buildInstances(faces, pairs, pairLen, toMM) {
    var byId = new Map();
    faces.forEach(function (f) { byId.set(f.id, f); });
    var inst = [];
    var holeFloor = new Set();     // 已被认作「孔底」的平面，不再重复算成型腔/台阶

    /* ---- 孔：同轴同径的「整圈」圆柱聚类（局部弧面不算孔壁）---- */
    var cyls = faces.filter(function (f) {
      return f.type === 'Cylinder' && f.radius > 0 && (f.arcDeg === null || f.arcDeg === undefined || f.arcDeg > 330);
    });
    var groups = [];
    cyls.forEach(function (f) {
      for (var g = 0; g < groups.length; g++) {
        var a = groups[g][0];
        if (Math.abs(a.radius - f.radius) / Math.max(a.radius, f.radius) > 0.05) continue;
        if (Math.abs(dot(a.axis, f.axis)) < 0.97) continue;
        var w = sub(f.axis_pt, a.axis_pt);
        var d = vlen(cross(w, a.axis));
        if (d / Math.max(a.radius, 1e-9) > 0.12) continue;
        groups[g].push(f);
        return;
      }
      groups.push([f]);
    });

    groups.forEach(function (g, gi) {
      var r = 0, ax = [0, 0, 0];
      g.forEach(function (f) { r += f.radius; ax = add(ax, f.axis); });
      r /= g.length;
      ax = nrm(ax);
      var ids = g.map(function (f) { return f.id; });
      var h0 = Infinity, h1 = -Infinity;
      g.forEach(function (f) {
        f.verts.forEach(function (p) {
          var t = dot(p, ax);
          if (t < h0) h0 = t;
          if (t > h1) h1 = t;
        });
      });
      if (!isFinite(h0) || !isFinite(h1)) return;
      var caps = [];
      pairs.forEach(function (pr) {
        var a = pr[0], b = pr[1];
        var inA = ids.indexOf(a) >= 0, inB = ids.indexOf(b) >= 0;
        if (!inA && !inB) return;
        var other = inA ? b : a;
        var fb = byId.get(other);
        if (!fb || fb.type !== 'Plane') return;
        if (Math.abs(dot(fb.normal, ax)) < 0.9) return;
        // 只有「单环 + 面积≈πr²」的平面才是封住孔底的盖板；
        // 顶面那种「外轮廓 + 孔」的环形面有两个环，是通过口而不是盖板。
        if (!fb.loops || fb.loops.length !== 1) return;
        if (Math.abs(fb.area / (Math.PI * r * r) - 1) > 0.2) return;
        var rel = dot(fb.centroid, ax);                 // 与 h0/h1 同一坐标系（沿轴绝对投影）
        if (rel < h0 - 1e-3 || rel > h1 + 1e-3) return;
        caps.push(other);
      });
      caps = caps.filter(function (v, i, arr) { return arr.indexOf(v) === i; });
      var cls = caps.length ? '盲孔' : '通孔';
      var bottom = (cls === '盲孔' && caps.length) ? caps[0] : null;
      if (bottom !== null) holeFloor.add(bottom);
      var depth = (h1 - h0) * toMM;
      var ctr = [0, 0, 0];
      g.forEach(function (f) { ctr = add(ctr, f.centroid); });
      ctr = mul(ctr, 1 / g.length);
      inst.push({
        key: 'H' + (gi + 1), cls: cls, faces: ids.slice(), bottom: bottom,
        conf: cls === '通孔' ? 0.97 : 0.95,
        params: [
          ['直径', 'Φ' + (2 * r * toMM).toFixed(1) + ' mm'],
          [cls === '盲孔' ? '深度' : '壁厚', depth.toFixed(1) + ' mm'],
          ['位置', 'X' + f1(ctr[0] * toMM) + '  Y' + f1(ctr[1] * toMM)]
        ],
        depth_mm: depth, dia_mm: 2 * r * toMM
      });
    });

    /* ---- 型腔 / 槽 / 台阶：朝上的平面 + 从它升起的墙 ---- */
    var topZ = -Infinity, pmin = [Infinity, Infinity, Infinity], pmax = [-Infinity, -Infinity, -Infinity];
    faces.forEach(function (f) {
      f.verts.forEach(function (p) {
        if (p[2] > topZ) topZ = p[2];
        for (var i = 0; i < 3; i++) {
          if (p[i] < pmin[i]) pmin[i] = p[i];
          if (p[i] > pmax[i]) pmax[i] = p[i];
        }
      });
    });
    var ext = [Math.max(pmax[0] - pmin[0], 1e-9), Math.max(pmax[1] - pmin[1], 1e-9), Math.max(pmax[2] - pmin[2], 1e-9)];

    var adj = new Map();
    pairs.forEach(function (pr) {
      if (!adj.has(pr[0])) adj.set(pr[0], []);
      if (!adj.has(pr[1])) adj.set(pr[1], []);
      adj.get(pr[0]).push(pr[1]);
      adj.get(pr[1]).push(pr[0]);
    });

    var cands = [];
    faces.forEach(function (f) {
      if (f.type !== 'Plane') return;
      if (holeFloor.has(f.id)) return;        // 已是某盲孔的孔底
      if (dot(f.normal, UP) < 0.75) return;
      var zc = f.centroid[2];
      if (zc > topZ - 0.02) return;
      var walls = [];
      (adj.get(f.id) || []).forEach(function (other) {
        var fb = byId.get(other);
        if (!fb) return;
        if (fb.centroid[2] - zc <= 0.012) return;
        if (Math.abs(dot(fb.normal, UP)) >= 0.6) return;
        if (fb.bbox_min[2] < zc - 0.02) return;
        walls.push(other);
      });
      if (walls.length) cands.push({ bottom: f.id, walls: walls });
    });

    var claims = new Map();
    cands.forEach(function (c, ci) {
      c.walls.forEach(function (w) {
        var key = Math.min(c.bottom, w) + ':' + Math.max(c.bottom, w);
        var L = pairLen.get(key) || 0;
        if (!claims.has(w) || L > claims.get(w)[1]) claims.set(w, [ci, L]);
      });
    });
    cands.forEach(function (c, ci) {
      c.assigned = [];
      claims.forEach(function (v, w) { if (v[0] === ci) c.assigned.push(w); });
    });

    cands.forEach(function (c) {
      var f = byId.get(c.bottom);
      var bmin = f.bbox_min, bmax = f.bbox_max;
      var span = [Math.abs(bmax[0] - bmin[0]), Math.abs(bmax[1] - bmin[1])];
      var longSide = Math.max(span[0], span[1]) * toMM;
      var shortSide = Math.min(span[0], span[1]) * toMM;
      var depthN = topZ - f.centroid[2];
      var dirs = new Set();
      c.assigned.forEach(function (w) {
        var fb = byId.get(w);
        if (!fb) return;
        var dx = fb.centroid[0] - f.centroid[0], dy = fb.centroid[1] - f.centroid[1];
        var L2 = Math.hypot(dx, dy);
        if (L2 < 1e-9) return;
        dirs.add(Math.round(dx / L2 * 10) / 10 + '|' + Math.round(dy / L2 * 10) / 10);
      });
      var rxy = [span[0] / ext[0], span[1] / ext[1]];
      var cls;
      if (Math.min(rxy[0], rxy[1]) > 0.78 && depthN < 0.55 * ext[2]) cls = '台阶';
      else if (dirs.size >= 3) cls = '型腔';
      else if (c.assigned.length >= 2 && longSide > 2 * Math.max(shortSide, 1e-6)) cls = '槽';
      else cls = '台阶';
      inst.push({
        key: 'R' + f.id, cls: cls,
        faces: [f.id].concat(c.assigned),
        bottom: f.id,
        conf: cls === '型腔' ? 0.93 : 0.91,
        params: [
          ['宽', shortSide.toFixed(1) + ' mm'],
          ['长', longSide.toFixed(1) + ' mm'],
          ['深', (depthN * toMM).toFixed(1) + ' mm']
        ],
        depth_mm: depthN * toMM, dia_mm: null
      });
    });

    inst.forEach(function (it, i) {
      it.id = i;
      it.faces = it.faces.filter(function (v, k, a) { return a.indexOf(v) === k; }).sort(function (a, b) { return a - b; });
    });
    return inst;
  }

  /* ============================================================ 8. 组装输出 */
  function b64FromBytes(bytes) {
    var CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var out = [], i = 0, n = bytes.length;
    for (; i + 2 < n; i += 3) {
      var b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      out.push(CH[b0 >> 2], CH[((b0 & 3) << 4) | (b1 >> 4)], CH[((b1 & 15) << 2) | (b2 >> 6)], CH[b2 & 63]);
    }
    var left = n - i;
    if (left === 1) {
      var c0 = bytes[i];
      out.push(CH[c0 >> 2], CH[(c0 & 3) << 4], '==');
    } else if (left === 2) {
      var d0 = bytes[i], d1 = bytes[i + 1];
      out.push(CH[d0 >> 2], CH[((d0 & 3) << 4) | (d1 >> 4)], CH[(d1 & 15) << 2], '=');
    }
    return out.join('');
  }

  function buildPart(text, fileName, opts) {
    opts = opts || {};
    var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (typeof text !== 'string' || text.length < 32) throw new Error('文件内容为空或无法读取');
    if (text.length > 80 * 1024 * 1024) throw new Error('文件超过 80 MB，请先在 CAD 中简化模型');

    var warnings = [], warned = {};
    function warn(msg) {
      if (warned[msg]) return;
      warned[msg] = 1;
      if (warnings.length < 12) warnings.push(msg);
    }
    var skipped = [];
    function skip(msg) { if (skipped.length < 10) skipped.push(msg); }

    var d = parseDoc(text);
    var doc = new Doc(d);
    var unit = unitToMM(doc);
    var ctx = { warn: warn, skip: skip, arcCache: new Map() };

    var faceIds = collectFaceIds(doc);
    if (!faceIds.length) throw new Error('没有找到 B-Rep 面（ADVANCED_FACE）。该文件可能只含曲面/线框，或不是 AP203/214/242 实体模型');

    /* ---- 细分容差 ----
     * 主判据是弦高（sagitta）：曲面偏离直弦多少算「看得出是折的」。
     * 解析曲面（圆柱/圆锥/球/环）本来就被曲线采样切得够密 —— 96 段的孔壁
     * 在 60 mm 的件上弦高只有 3 µm，再细分纯属浪费；真正需要补的是
     * B 样条：它一个面可能就跨大半张蒙皮，内部一个采样点都没有。
     *
     * 边长上限放得很宽（对角线/30），只用来切掉极端的细长条：
     * 收紧要到 /110 的话，圆柱面那条 10 mm 高的母线会被 1→4 均匀
     * 细分 4 次，短边跟着一起碎，一个孔壁能烧掉 12000 个三角形。 */
    var scale0 = estimateScale(doc);
    var tq = (opts.tess === undefined || opts.tess === null) ? 1 : +opts.tess;
    if (!isFinite(tq) || tq < 0) tq = 1;
    /* tq=0 关细分；tq=2 是「精细」档（容差减半），给单个零件的汇报截图用 */
    ctx.tol = tq > 0 ? scale0 / (1600 * tq) : Infinity;
    /* maxLen 只做极端保护（半个模型对角线）：Gouraud 下细长三角形不会露馅，
     * 拿它当「网格要均匀」的硬指标反而会把圆柱母线切碎，白白多出十倍三角形。 */
    ctx.maxLen = tq > 0 ? scale0 * 0.5 : Infinity;
    /* 单面上限不能卡太低：7~8 个面的小件里，孔壁一张面就能吃掉两三千个三角形，
     * 预算封在 2400 的话 tol/maxLen 再怎么调都不生效（实测 tess=1/2/3 结果完全一样）。 */
    ctx.faceBudget = Math.max(120, Math.min(12000, Math.round(4000000 * Math.max(1, Math.min(2, tq)) / Math.max(1, faceIds.length))));


    var faces = [], allPos = [], allNrm = [], allFid = [];
    // 平面优先：180° 弧的方向裁决由平面面给出，再让曲面面复用（按边缓存）
    var planarFirst = [], others = [];
    for (var oi = 0; oi < faceIds.length; oi++) {
      var of = doc.e.get(faceIds[oi]);
      var os = of ? doc.ref(of.args[2]) : null;
      (os && os.type === 'PLANE' ? planarFirst : others).push(faceIds[oi]);
    }
    var ordered = planarFirst.concat(others);
    for (var i = 0; i < ordered.length; i++) {
      var fe = doc.e.get(ordered[i]);
      if (!fe) continue;
      var rec = tessFace(doc, ordered[i], fe, ctx);
      if (!rec) continue;
      rec.id = faces.length;
      faces.push(rec);
      for (var k = 0; k < rec.pos.length; k += 9) {
        allPos.push(rec.pos[k], rec.pos[k + 1], rec.pos[k + 2],
                    rec.pos[k + 3], rec.pos[k + 4], rec.pos[k + 5],
                    rec.pos[k + 6], rec.pos[k + 7], rec.pos[k + 8]);
        allNrm.push(rec.nrm[k], rec.nrm[k + 1], rec.nrm[k + 2],
                    rec.nrm[k + 3], rec.nrm[k + 4], rec.nrm[k + 5],
                    rec.nrm[k + 6], rec.nrm[k + 7], rec.nrm[k + 8]);
        allFid.push(rec.id);
      }
    }
    if (!faces.length) throw new Error('面三角化全部失败（' + skipped[0] + '）。该文件的曲面类型暂未支持');

    /* ---- 归一化：居中 + 除以包围盒对角线（与 data.js 口径一致）---- */
    var bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
    for (var v = 0; v < allPos.length; v += 3) {
      for (var c = 0; c < 3; c++) {
        var val = allPos[v + c];
        if (val < bmin[c]) bmin[c] = val;
        if (val > bmax[c]) bmax[c] = val;
      }
    }
    var center = [(bmin[0] + bmax[0]) / 2, (bmin[1] + bmax[1]) / 2, (bmin[2] + bmax[2]) / 2];
    var diag = Math.hypot(bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]) || 1;
    var toMM = diag * unit;

    /* ---- AAGNet 推理（浏览器内；没加载模型或失败就退回规则识别，不影响导入）---- */
    var nn = null;
    var GB = (typeof window !== 'undefined') ? window : null;
    /* 网络只在「机加工实体」上跑。片体（复材蒙皮、曲面件）没有实体内部，
     * 孔/腔/台阶的定义都不成立；自由曲面占比过高时特征向量也整体落在训练分布之外。
     * 这两种情况硬跑会吐出一堆看起来很像结果的垃圾（这个 46 MB 的 CATIA 蒙皮上给了 44 个
     * 假实例、1789 个面被标成「圆角」），不如明确说「跳过」并给出原因。 */
    var shape = modelShape(doc);
    var analytic = 0;
    for (var ai2 = 0; ai2 < faces.length; ai2++) {
      var kk = faces[ai2].kind;
      if (kk === 'Plane' || kk === 'Cylinder' || kk === 'Cone' || kk === 'Sphere' || kk === 'Torus') analytic++;
    }
    var analyticShare = faces.length ? analytic / faces.length : 0;
    /* 域外只做标注，不再拦截：AAGNet 一律照跑，结果标成「参考」。
     * 之前的做法是直接跳过，界面上就只剩几何、什么特征都没有 —— 用户要的是结果，
     * 不是替用户决定「这个件不值得算」。 */
    var netCaveat = '';
    if (!shape.solids && !shape.closedShells) {
      netCaveat = '曲面片体（' + shape.surfaceModels + ' 个 SHELL_BASED_SURFACE_MODEL、0 个封闭实体）：'
                + '孔/型腔/台阶的语义依赖实体内部，网络输出的语义与实例仅供参考';
    } else if (analyticShare < 0.2) {
      netCaveat = '解析面只占 ' + Math.round(analyticShare * 100) + '%、其余为自由曲面，'
                + '属于 AAGNet 训练域外，结果仅供参考';
    }
    if (GB && GB.AAG_MODEL && GB.AAG_MODEL.ready() && GB.AAG_REC && GB.AAG_REC.recognize) {
      try {
        nn = GB.AAG_REC.recognize(faces, {
          center: center,
          maxExt: Math.max(bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]) || 1,
          unit: unit
        });
        if (nn && netCaveat) nn.caveat = netCaveat;
      } catch (e) {
        nn = { error: (e && e.message) ? e.message : String(e) };
      }
    }

    var positions = new Float32Array(allPos.length);
    for (var w = 0; w < allPos.length; w += 3) {
      positions[w] = (allPos[w] - center[0]) / diag;
      positions[w + 1] = (allPos[w + 1] - center[1]) / diag;
      positions[w + 2] = (allPos[w + 2] - center[2]) / diag;
    }
    var faceids = new Int32Array(allFid.length);
    for (var fi = 0; fi < allFid.length; fi++) faceids[fi] = allFid[fi];

    /* 法线是方向，不做居中/缩放（归一化只动位置）。 */
    var normals = new Float32Array(allNrm.length);
    for (var wn = 0; wn < allNrm.length; wn++) normals[wn] = allNrm[wn];

    /* ---- 面属性（归一化空间）---- */
    // 调试出口要在归一化「之前」留快照：下面的 forEach 会就地改写 area/centroid/verts/radius，
    // 直接持有 faces 引用的话，事后拿到的是被除过 diag 的值。
    var rawSnap = null;
    if (opts.raw) {
      rawSnap = {
        faces: faces.map(function (f) { var c = {}; for (var q in f) c[q] = f[q]; return c; }),
        center: center,
        maxExt: Math.max(bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]) || 1,
        diag: diag, unit: unit
      };
    }
    faces.forEach(function (f) {
      f.centroid = [(f.centroid[0] - center[0]) / diag, (f.centroid[1] - center[1]) / diag, (f.centroid[2] - center[2]) / diag];
      f.bbox_min = [(f.bbox_min[0] - center[0]) / diag, (f.bbox_min[1] - center[1]) / diag, (f.bbox_min[2] - center[2]) / diag];
      f.bbox_max = [(f.bbox_max[0] - center[0]) / diag, (f.bbox_max[1] - center[1]) / diag, (f.bbox_max[2] - center[2]) / diag];
      f.verts = f.verts.map(function (p) {
        return [(p[0] - center[0]) / diag, (p[1] - center[1]) / diag, (p[2] - center[2]) / diag];
      });
      f.area = f.area / (diag * diag);
      if (f.radius) f.radius = f.radius / diag;
      if (f.axis_pt) f.axis_pt = [(f.axis_pt[0] - center[0]) / diag, (f.axis_pt[1] - center[1]) / diag, (f.axis_pt[2] - center[2]) / diag];
      f.type = kindLabel(f.kind);
    });

    /* ---- 邻接（按共享边的端点键）---- */
    var edgeMap = new Map();
    faces.forEach(function (f) {
      f.loops.forEach(function (lp) {
        lp.segs.forEach(function (sg) {
          if (!edgeMap.has(sg.key)) edgeMap.set(sg.key, { faces: new Set(), len: sg.len });
          var e = edgeMap.get(sg.key);
          e.faces.add(f.id);
          e.len = Math.max(e.len, sg.len);
        });
      });
    });
    var pairMap = new Map(), pairLen = new Map();
    edgeMap.forEach(function (e) {
      var arr = Array.from(e.faces);
      if (arr.length < 2) return;
      for (var i = 0; i < arr.length; i++) {
        for (var j = i + 1; j < arr.length; j++) {
          if (arr[i] === arr[j]) continue;
          var key = Math.min(arr[i], arr[j]) + ':' + Math.max(arr[i], arr[j]);
          if (!pairMap.has(key)) pairMap.set(key, [Math.min(arr[i], arr[j]), Math.max(arr[i], arr[j])]);
          pairLen.set(key, (pairLen.get(key) || 0) + e.len);
        }
      }
    });
    var pairs = Array.from(pairMap.values()).sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });

    var instances = buildInstances(faces, pairs, pairLen, toMM);

    var base = String(fileName || 'model.stp').replace(/^.*[\\\/]/, '');
    var part0 = {
      name: base.replace(/\.[^.]+$/, ''),
      source: base,
      triangles: allFid.length,
      faces: faces.map(function (f) {
        return {
          id: f.id,
          type: f.type,
          area: Math.round(f.area * 1e6) / 1e6,
          tris: f.tris,
          centroid: f.centroid.map(r4),
          bbox_min: f.bbox_min.map(r4),
          bbox_max: f.bbox_max.map(r4),
          normal: f.normal.map(r4),
          spread: f.kind === 'Plane' ? 0 : 90,
          radius: f.radius === null || f.radius === undefined ? null : r4(f.radius),
          axis: f.axis ? f.axis.map(r4) : null,
          axis_pt: f.axis_pt ? f.axis_pt.map(r4) : null
        };
      }),
      instances: instances,
      edges: pairs,
      size_mm: [(bmax[0] - bmin[0]) * unit, (bmax[1] - bmin[1]) * unit, (bmax[2] - bmin[2]) * unit].map(function (x) { return Math.round(x * 10) / 10; }),
      bbox: [bmin.map(r3), bmax.map(r3)],
      /* 直接挂 Float32Array，不再绕 base64。
       * 4518 面 / 152 万三角时，base64 要走「4 字符/字节 push 进数组再 join」，
       * 光那一个数组就是 7300 万个元素：几十秒时间 + 600 MB 堆，纯属白烧。
       * 渲染端 decodePart 会复制一份再做 Z-up→Y-up，不会二次变换。 */
      _pos: positions,
      _nrm: normals,
      faceids: Array.prototype.slice.call(faceids),
      imported: true,
      nn: nn,
      diag: {
        file: base,
        bytes: text.length,
        unit_mm: unit,
        faces: faces.length,
        skipped: skipped,
        warnings: warnings,
        instances: instances.length,
        edges: pairs.length,
        shape: shape,
        analyticShare: Math.round(analyticShare * 1000) / 1000,
        tris: faces.reduce(function (a, f) { return a + f.tris; }, 0),
        netCaveat: netCaveat,
        ms: Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0))
      }
    };
    if (part0.size_mm[0] > 1e5 && unit === 1) warn('模型尺寸 ' + Math.round(part0.size_mm[0]) + ' mm 偏大，确认文件单位是否为毫米');
    if (opts.raw) part0._raw = rawSnap;
    return part0;
  }

  function r3(x) { return Math.round(x * 1000) / 1000; }
  function r4(x) { return Math.round(x * 1e4) / 1e4; }

  return {
    version: '1.0',
    buildPart: buildPart,
    _internals: {
      parseDoc: parseDoc, Doc: Doc, tessFace: tessFace, collectFaceIds: collectFaceIds,
      unitToMM: unitToMM, buildInstances: buildInstances,
      readLoop: readLoop, toUV: toUV, triangulate: triangulate, earClip: earClip, area2: area2
    }
  };
});
