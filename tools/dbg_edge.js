// 逐边打印凸凹判定依据
global.window = global;
const path = require('path');
const S = require(path.join(__dirname, '..', 'step_import.js'));
const REC = require(path.join(__dirname, '..', 'aagnet_recognize.js'));

const file = process.argv[2] || 'tools/samples/box.step';
const text = require('fs').readFileSync(path.resolve(file), 'utf8');
const part = S.buildPart(text, path.basename(file), { raw: true });
const faces = part._raw.faces;
console.log(`${path.basename(file)}  面 ${faces.length}`);
faces.forEach(f => console.log(`  面#${f.id} ${f.kind} same=${f.same} n=[${f.normal.map(x => x.toFixed(2))}] arc=${f.arcDeg === null ? '-' : f.arcDeg.toFixed(0)}`));

const edges = REC._internals.collectEdges(faces);
console.log(`\n边 ${edges.length} 条`);
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function vlen(a) { return Math.hypot(a[0], a[1], a[2]); }
function nrm(a) { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

edges.forEach((e, i) => {
  if (e.faces.length < 2) { console.log(`  [${i}] 开边 ${e.key}`); return; }
  const cv = REC._internals.convexity(e, faces);
  const kinds = e.faces.map(fi => faces[fi].kind[0] + fi).join('-');
  // 打印每个 seg 的 flipT/windOK
  const segInfo = e.segs.map((sg, k) => `seg${k}(f${e.faces[k]}) flip=${sg.flipT} wind=${sg.windOK ? 1 : 0} pts=${sg.pts.length}`).join(' ');
  // 环信息：outer 标记 + Newell 与面外法向的 cos
  const lp0 = faces[e.faces[0]].loops;
  const ring = (lp0 || []).map(lp => {
    const nw = (function (pts) {
      let n = [0, 0, 0];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        n[0] += (a[1] - b[1]) * (a[2] + b[2]);
        n[1] += (a[2] - b[2]) * (a[0] + b[0]);
        n[2] += (a[0] - b[0]) * (a[1] + b[1]);
      }
      return nrm(n);
    })(lp.pts);
    return `${lp.outer ? 'OUT' : 'IN'}(${lp.pts.length})cos=${dot(nw, faces[e.faces[0]].normal).toFixed(2)}`;
  }).join(' ');
  // 手工复算
  let dbg = '';
  const A = faces[e.faces[0]], B = faces[e.faces[1]];
  const sg0 = e.segs[0], pts = sg0.pts;
  if (pts.length >= 2) {
    const mid = pts.length === 2 ? [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2, (pts[0][2] + pts[1][2]) / 2] : pts[pts.length >> 1];
    let t = pts.length === 2 ? sub(pts[1], pts[0]) : sub(pts[(pts.length >> 1) + 1] || pts[pts.length - 1], pts[(pts.length >> 1) - 1] || pts[0]);
    if (sg0.flipT < 0) t = [-t[0], -t[1], -t[2]];
    t = nrm(t);
    const uvA = A.surf.uvOf(mid), uvB = B.surf.uvOf(mid);
    const nA = uvA ? (() => { const n = A.surf.normalAt(uvA[0], uvA[1]); const l = vlen(n) || 1; const m = [n[0] / l, n[1] / l, n[2] / l]; return A.same ? m : [-m[0], -m[1], -m[2]]; })() : null;
    const nB = uvB ? (() => { const n = B.surf.normalAt(uvB[0], uvB[1]); const l = vlen(n) || 1; const m = [n[0] / l, n[1] / l, n[2] / l]; return B.same ? m : [-m[0], -m[1], -m[2]]; })() : null;
    if (nA && nB) {
      const s = dot(cross(nA, nB), t);
      dbg = ` s=${s.toFixed(3)} nA=[${nA.map(x => x.toFixed(2))}] nB=[${nB.map(x => x.toFixed(2))}] t=[${t.map(x => x.toFixed(2))}]`;
    }
  }
  const lbl = ['?', '凸', '凹', '光滑'][cv];
  console.log(`  [${i}] ${kinds} -> ${cv}${lbl}  ${segInfo}${dbg}\n        环: ${ring}`);
});
