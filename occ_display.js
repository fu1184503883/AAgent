/* OCC（OpenCASCADE）显示网格
 * ---------------------------------------------------------------------------
 * 用 occt-import-js（OCCT 官方内核编译成的 WebAssembly）在浏览器里做 STEP
 * 三角化，替换自有三角化生成的显示网格 —— 效果和 OCC 的 BRepMesh 一致。
 *
 * 分工：
 *   - B-Rep 拓扑、面属性、gAAG、AAGNet 推理：仍然走 step_import.js 的结果；
 *   - 只有「显示用的三角形 + 逐顶点法线」换成 OCC 的。
 *   - OCC 的 brep_faces 分组（每个 B-Rep 面一段三角形）用「重心 + 面积 +
 *     包围盒 + 法线」对齐到我们的 face id，保证拾取/着色/筛选都对得上。
 *
 * 离线约束：wasm 不 fetch（file:// 下会被浏览器拦），而是由
 * vendor/occt-wasm-b64.js 以 base64 形式内嵌，走 Module.wasmBinary 注入。
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OCC_DISPLAY = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  var instPromise = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = root.document.createElement('script');
      s.src = src; s.async = false;
      s.onload = function () { resolve(true); };
      s.onerror = function () { reject(new Error(src + ' 加载失败')); };
      root.document.head.appendChild(s);
    });
  }

  function b64ToU8(b64) {
    var s = atob(b64);
    var u8 = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }

  /* 惰性加载：b64 wasm → 胶水脚本 → 实例化。失败向上抛，调用方回落到自有网格。 */
  function ensure() {
    if (instPromise) return instPromise;
    instPromise = (async function () {
      if (typeof root.occtimportjs !== 'function') {
        // 先载入 wasm 的 base64（约 10 MB），再载入胶水脚本，避免胶水自己去 fetch
        await loadScript('vendor/occt-wasm-b64.js');
        await loadScript('vendor/occt-import-js.js');
      }
      if (typeof root.occtimportjs !== 'function') throw new Error('occt-import-js 未加载');
      var opts = {};
      if (root.OCC_WASM_B64) opts.wasmBinary = b64ToU8(root.OCC_WASM_B64);
      else opts.locateFile = function (n) { return 'vendor/' + n; };
      return await root.occtimportjs(opts);
    })().catch(function (e) { instPromise = null; throw e; });
    return instPromise;
  }

  function triAreaNormal(P, a, b, c) {
    var ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    var vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    return { nx: nx, ny: ny, nz: nz, a: Math.sqrt(nx * nx + ny * ny + nz * nz) * 0.5 };
  }

  /* 把 OCC 结果并进来：
   *   part: step_import.buildPart 的返回值（要带 _norm）
   *   occt: occtimportjs() 的实例
   * 返回 { pos, nrm, fids, tris, ms, match }；失败抛异常。 */
  function nowMs() {
    return (typeof performance !== 'undefined' ? performance.now() : Date.now());
  }

  function readStep(occt, text, defl) {
    var bytes = new TextEncoder().encode(text);
    var res = occt.ReadStepFile(bytes, {
      linearUnit: 'millimeter',
      linearDeflectionType: 'absolute_value',
      linearDeflection: defl,
      angularDeflection: 0.5
    });
    if (!res || !res.success || !res.meshes || !res.meshes.length) throw new Error('OCC 读取失败');
    return res;
  }

  /* 我们面的最小描述（可结构化克隆，worker 传参也用这个） */
  function faceListOf(part) {
    var ours = [];
    for (var fi = 0; fi < part.faces.length; fi++) {
      var f = part.faces[fi];
      var bmin = f.bbox_min, bmax = f.bbox_max;
      ours.push({
        id: f.id, c: f.centroid, a: f.area, n: f.normal,
        bb: Math.hypot(bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2])
      });
    }
    return ours;
  }

  /* 串行路径：读 STEP + 网格化 + 匹配装配 */
  function merge(part, text, occt, opts) {
    opts = opts || {};
    /* 离面容差：小件固定 0.05 mm；很大的件按对角线放宽（≈4e-5×对角线），
     * 免得 5 米的装配/蒙皮把三角面数顶到千万级。 */
    var defl = opts.defl || Math.max(0.05, (part._norm && part._norm.diag ? part._norm.diag * 4e-5 : 0.05));
    var t0 = nowMs();
    var res = readStep(occt, text, defl);
    var out = matchAndAssemble(res, faceListOf(part), part._norm);
    out.ms = Math.round(nowMs() - t0);
    return out;
  }

  /* 匹配 + 装配：worker 里也走这里（res 是 ReadStepFile 的返回值） */
  function matchAndAssemble(res, ours, norm) {
    var t0 = nowMs();
    var center = norm.center, diag = norm.diag;

    /* ---- 1. OCC 每个 brep face 分组的描述（重心/面积/包围盒/法线，均归一化） ---- */
    var groups = [];
    for (var mi = 0; mi < res.meshes.length; mi++) {
      var m = res.meshes[mi];
      var pos = m.attributes.position.array;
      var idx = m.index.array;
      for (var gi = 0; gi < m.brep_faces.length; gi++) {
        var bf = m.brep_faces[gi];
        var cx = 0, cy = 0, cz = 0, area = 0;
        var mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
        var nx0 = 0, ny0 = 0, nz0 = 0;
        for (var t = bf.first; t <= bf.last; t++) {
          var ia = idx[t * 3] * 3, ib = idx[t * 3 + 1] * 3, ic = idx[t * 3 + 2] * 3;
          var tn = triAreaNormal(pos, ia, ib, ic);
          if (tn.a <= 0) continue;
          area += tn.a;
          var gx = (pos[ia] + pos[ib] + pos[ic]) / 3, gy = (pos[ia + 1] + pos[ib + 1] + pos[ic + 1]) / 3, gz = (pos[ia + 2] + pos[ib + 2] + pos[ic + 2]) / 3;
          cx += gx * tn.a; cy += gy * tn.a; cz += gz * tn.a;
          nx0 += tn.nx; ny0 += tn.ny; nz0 += tn.nz;
          for (var kk = 0; kk < 3; kk++) {
            var vi = idx[t * 3 + kk] * 3;
            var px = pos[vi], py = pos[vi + 1], pz = pos[vi + 2];
            if (px < mnx) mnx = px; if (px > mxx) mxx = px;
            if (py < mny) mny = py; if (py > mxy) mxy = py;
            if (pz < mnz) mnz = pz; if (pz > mxz) mxz = pz;
          }
        }
        if (area <= 0) { groups.push(null); continue; }
        var nl = Math.sqrt(nx0 * nx0 + ny0 * ny0 + nz0 * nz0) || 1;
        groups.push({
          mi: mi, gi: gi, bf: bf,
          c: [(cx / area - center[0]) / diag, (cy / area - center[1]) / diag, (cz / area - center[2]) / diag],
          a: area / (diag * diag),
          n: [nx0 / nl, ny0 / nl, nz0 / nl],
          bb: (Math.hypot(mxx - mnx, mxy - mny, mxz - mnz)) / diag
        });
      }
    }

    /* ---- 2. 面序匹配：重心距离 + 面积比 + 包围盒 + 法线，全局贪心 ---- */
    var COST_LIMIT = 0.004;      // 归一化距离^2 上限（≈ 5% 对角线）
    /* 单个 (组, 面) 的匹配代价：重心距离为主，面积比 / 包围盒 / 法线做区分。
     * 这个件的层叠双面很多「同重心不同层」的面，只靠重心会配错，面积和
     * 包围盒把它们分开。 */
    function pairCost(G, O) {
      var dx = G.c[0] - O.c[0], dy = G.c[1] - O.c[1], dz = G.c[2] - O.c[2];
      var d2 = dx * dx + dy * dy + dz * dz;
      var ar = Math.max(G.a, O.a) / Math.max(1e-12, Math.min(G.a, O.a));
      var dbb = Math.abs(G.bb - O.bb);
      var dot = Math.abs(G.n[0] * O.n[0] + G.n[1] * O.n[1] + G.n[2] * O.n[2]);
      return Math.sqrt(d2) * 1000 + Math.log(ar) * 0.6 + dbb * 500 + (1 - dot) * 0.8 + (ar > 2 ? 4 : 0);
    }
    var topCands = [];           // 每组的候选面（供 2-opt 交换用）
    var cands = [];
    for (var g = 0; g < groups.length; g++) {
      var G = groups[g];
      topCands.push([]);
      if (!G) continue;
      var best = [];
      for (var o = 0; o < ours.length; o++) {
        var O = ours[o];
        var dx = G.c[0] - O.c[0], dy = G.c[1] - O.c[1], dz = G.c[2] - O.c[2];
        if (dx * dx + dy * dy + dz * dz > COST_LIMIT) continue;
        best.push({ o: o, cost: pairCost(G, O) });
      }
      best.sort(function (p, q) { return p.cost - q.cost; });
      for (var b = 0; b < Math.min(6, best.length); b++) {
        topCands[g].push(best[b].o);
        if (b < 3) cands.push({ g: g, o: best[b].o, cost: best[b].cost });
      }
    }
    cands.sort(function (p, q) { return p.cost - q.cost; });
    var map = new Int32Array(groups.length).fill(-1);
    var usedO = new Int8Array(ours.length);
    for (var ci = 0; ci < cands.length; ci++) {
      var cd = cands[ci];
      if (map[cd.g] >= 0 || usedO[cd.o]) continue;
      map[cd.g] = cd.o; usedO[cd.o] = 1;
    }
    /* 2-opt 交换：把「配错了但候选列表里有正主」的对儿换回来 */
    var owner = new Int32Array(ours.length).fill(-1);
    for (var g0 = 0; g0 < groups.length; g0++) if (map[g0] >= 0) owner[map[g0]] = g0;
    for (var round = 0; round < 4; round++) {
      var improved = false;
      for (var g1 = 0; g1 < groups.length; g1++) {
        var G1 = groups[g1];
        if (!G1 || map[g1] < 0 || !topCands[g1].length) continue;
        var cur = map[g1];
        for (var k1 = 0; k1 < topCands[g1].length; k1++) {
          var o1 = topCands[g1][k1];
          if (o1 === cur) continue;
          var h = owner[o1];
          if (h < 0 || h === g1 || !groups[h]) continue;
          var oh = map[h];
          var d0 = pairCost(G1, ours[cur]) + pairCost(groups[h], ours[oh]);
          var d1 = pairCost(G1, ours[o1]) + pairCost(groups[h], ours[cur]);
          if (d1 < d0 - 1e-9) {
            map[g1] = o1; owner[o1] = g1;
            map[h] = cur; owner[cur] = h;
            cur = o1; improved = true;
            break;
          }
        }
      }
      if (!improved) break;
    }
    var leftover = 0;
    for (var g2 = 0; g2 < groups.length; g2++) {
      if (!groups[g2] || map[g2] >= 0) continue;
      var bd = Infinity, bo = -1;
      for (var o2 = 0; o2 < ours.length; o2++) {
        if (usedO[o2]) continue;
        var ex = groups[g2].c[0] - ours[o2].c[0], ey = groups[g2].c[1] - ours[o2].c[1], ez = groups[g2].c[2] - ours[o2].c[2];
        var e2 = ex * ex + ey * ey + ez * ez;
        if (e2 < bd) { bd = e2; bo = o2; }
      }
      map[g2] = bo; if (bo >= 0) { usedO[bo] = 1; leftover++; }
    }
    var dsum = [];
    for (var g3 = 0; g3 < groups.length; g3++) {
      if (!groups[g3] || map[g3] < 0) continue;
      var q = groups[g3].c, w = ours[map[g3]].c;
      dsum.push(Math.hypot(q[0] - w[0], q[1] - w[1], q[2] - w[2]) * diag);
    }
    dsum.sort(function (a, b) { return a - b; });
    var match = {
      matched: dsum.length, total: groups.length, leftover: leftover,
      p50: dsum[Math.floor(dsum.length * 0.5)] || 0,
      p90: dsum[Math.floor(dsum.length * 0.9)] || 0,
      max: dsum[dsum.length - 1] || 0
    };

    /* ---- 3. 展开成页面的 _pos/_nrm/faceids（每三角形 9 个 float） ---- */
    var nTri = 0;
    for (var mi2 = 0; mi2 < res.meshes.length; mi2++) nTri += res.meshes[mi2].index.array.length / 3;
    var posOut = new Float32Array(nTri * 9);
    var nrmOut = new Float32Array(nTri * 9);
    var fidOut = new Int32Array(nTri);
    /* (mesh, group) -> 我们的 face id，避免逐面线性搜索 */
    var fidByGroup = new Map();
    for (var gm = 0; gm < groups.length; gm++) {
      if (!groups[gm] || map[gm] < 0) continue;
      fidByGroup.set(groups[gm].mi + ':' + groups[gm].gi, ours[map[gm]].id);
    }
    var w2 = 0;
    for (var mi3 = 0; mi3 < res.meshes.length; mi3++) {
      var mm = res.meshes[mi3];
      var P = mm.attributes.position.array, N = mm.attributes.normal ? mm.attributes.normal.array : null, IX = mm.index.array;
      var triFace = new Int32Array(IX.length / 3).fill(-1);
      for (var gi2 = 0; gi2 < mm.brep_faces.length; gi2++) {
        var bg = mm.brep_faces[gi2];
        var fid = fidByGroup.has(mi3 + ':' + gi2) ? fidByGroup.get(mi3 + ':' + gi2) : -1;
        for (var tt = bg.first; tt <= bg.last; tt++) triFace[tt] = fid;
      }
      for (var t2 = 0; t2 < IX.length / 3; t2++) {
        fidOut[w2] = triFace[t2];
        for (var k2 = 0; k2 < 3; k2++) {
          var vi2 = IX[t2 * 3 + k2];
          posOut[w2 * 9 + k2 * 3] = (P[vi2 * 3] - center[0]) / diag;
          posOut[w2 * 9 + k2 * 3 + 1] = (P[vi2 * 3 + 1] - center[1]) / diag;
          posOut[w2 * 9 + k2 * 3 + 2] = (P[vi2 * 3 + 2] - center[2]) / diag;
          if (N) {
            nrmOut[w2 * 9 + k2 * 3] = N[vi2 * 3];
            nrmOut[w2 * 9 + k2 * 3 + 1] = N[vi2 * 3 + 1];
            nrmOut[w2 * 9 + k2 * 3 + 2] = N[vi2 * 3 + 2];
          } else {
            nrmOut[w2 * 9 + k2 * 3] = 0; nrmOut[w2 * 9 + k2 * 3 + 1] = 0; nrmOut[w2 * 9 + k2 * 3 + 2] = 1;
          }
        }
        w2++;
      }
    }
    return { pos: posOut, nrm: nrmOut, fids: fidOut, tris: w2, ms: Math.round(nowMs() - t0), match: match };
  }

  /* 并行路径（http/https）：OCC 在 Web Worker 里读 STEP + 网格化，主线程同时跑
   * 自有解析，最后把面描述发过去做匹配装配。file:// 下浏览器不允许 Worker，
   * 调用方回落到 ensure()+merge() 串行路径。 */
  function begin(text, opts) {
    if (typeof Worker === 'undefined' || typeof TextEncoder === 'undefined') return null;
    var w;
    try { w = new Worker('vendor/occ-worker.js'); } catch (e) { return null; }
    var bytes = new TextEncoder().encode(text);
    var defl = (opts && opts.defl) || 0.05;
    var job = { worker: w, meshedMs: 0 };
    job.result = new Promise(function (resolve, reject) {
      w.onmessage = function (ev) {
        var d = ev.data || {};
        if (d.type === 'meshed') { job.meshedMs = d.ms; return; }
        if (d.type === 'done') {
          try { w.terminate(); } catch (_) {}
          resolve({
            pos: new Float32Array(d.pos), nrm: new Float32Array(d.nrm),
            fids: new Int32Array(d.fids), tris: d.tris, ms: d.ms, match: d.match
          });
          return;
        }
        if (d.type === 'error') {
          try { w.terminate(); } catch (_) {}
          reject(new Error(d.error || 'OCC worker 出错'));
        }
      };
      w.onerror = function (e) {
        try { w.terminate(); } catch (_) {}
        reject(new Error('OCC worker 出错：' + (e && e.message ? e.message : 'unknown')));
      };
    });
    job.sendFaces = function (part) {
      try { w.postMessage({ type: 'faces', faces: faceListOf(part), norm: part._norm }); } catch (e) {}
    };
    w.postMessage({ type: 'start', step: bytes.buffer, defl: defl }, [bytes.buffer]);
    return job;
  }

  return { ensure: ensure, merge: merge, begin: begin, matchAndAssemble: matchAndAssemble, faceListOf: faceListOf };
});
