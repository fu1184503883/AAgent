// 凸凹判定对照：现有的「沿边切向 + 叉积符号」法 vs 几何法（探针点落在另一面平面的哪一侧）
// 用法: node tools/cmp_convex.js <a.step> [b.step ...]
global.window = global;
const fs = require('fs');
const path = require('path');
const S = require(path.join(__dirname, '..', 'step_import.js'));
const REC = require(path.join(__dirname, '..', 'aagnet_recognize.js'));
const I = REC._internals;

function len(a) { return Math.hypot(a[0], a[1], a[2]); }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

function normalAt(f, p) {
  const s = f.surf;
  const uv = s.uvOf(p);
  if (!uv) return null;
  const n = s.normalAt(uv[0], uv[1]);
  if (!n) return null;
  const o = norm(n);
  return f.same ? o : [-o[0], -o[1], -o[2]];
}

// 几何法：在面 f 上从 p 往「面内部」挪一点点，得到探针点
function probe(f, p, deltaFrac) {
  const s = f.surf;
  const uv = s.uvOf(p);
  if (!uv) return null;
  const loops = f._uv || [];
  let su = 0, sv = 0, cnt = 0, u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
  for (const L of loops) {
    for (const q of L.uv) {
      su += q[0]; sv += q[1]; cnt++;
      u0 = Math.min(u0, q[0]); u1 = Math.max(u1, q[0]);
      v0 = Math.min(v0, q[1]); v1 = Math.max(v1, q[1]);
    }
  }
  if (!cnt) return null;
  const cu = su / cnt, cv = sv / cnt;
  let du = cu - uv[0], dv = cv - uv[1];
  const l = Math.hypot(du, dv);
  if (!(l > 1e-12)) return null;
  const d = Math.max(u1 - u0, v1 - v0) * deltaFrac;
  return s.evalUV(uv[0] + du / l * d, uv[1] + dv / l * d);
}

// gl = 1 凸 / 2 凹 / 3 光滑(夹角<5°) / 0 失败
function convexGeom(A, B, p, nA, nB) {
  if (dot(nA, nB) > Math.cos(0.0872664626)) return 3;
  const qB = probe(B, p, 2e-3);
  const qA = probe(A, p, 2e-3);
  let va = 0, vb = 0, na = 0, nb = 0;
  if (qB) { const t = dot(nA, sub(qB, p)); if (t < 0) va++; else na++; }
  if (qA) { const t = dot(nB, sub(qA, p)); if (t < 0) vb++; else nb++; }
  const cv = va + vb, cc = na + nb;
  if (!cv && !cc) return 0;
  return cv >= cc ? 1 : 2;
}

const files = process.argv.slice(2);
for (const f of files) {
  const part = S.buildPart(fs.readFileSync(path.resolve(f), 'utf8'), path.basename(f), { raw: true });
  const faces = part._raw.faces;
  const edges = I.collectEdges(faces);
  let agree = 0, dis = 0, fail = 0;
  const tab = [0, 0, 0, 0];
  const pairs = [];
  for (const e of edges) {
    if (e.faces.length < 2) continue;
    const A = faces[e.faces[0]], B = faces[e.faces[1]];
    const sg = e.segs[0];
    const pts = sg.pts;
    const p = pts.length === 2
      ? [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2, (pts[0][2] + pts[1][2]) / 2]
      : pts[Math.floor(pts.length / 2)];
    const nA = normalAt(A, p), nB = normalAt(B, p);
    if (!nA || !nB) { fail++; continue; }
    const old = I.convexity(e, faces);
    const now = convexGeom(A, B, p, nA, nB);
    if (!now) { fail++; continue; }
    tab[now]++;
    if (old === now) agree++;
    else { dis++; pairs.push([e.faces, A.kind + '/' + B.kind, old, now]); }
  }
  console.log(`\n== ${path.basename(f)} 边 ${edges.filter(e => e.faces.length >= 2).length}`);
  console.log(`  一致 ${agree}  不一致 ${dis}  无法判定 ${fail}`);
  console.log(`  几何法分布: 凸 ${tab[1]}  凹 ${tab[2]}  光滑 ${tab[3]}`);
  if (dis) {
    for (const [fc, kk, o, n2] of pairs.slice(0, 20)) {
      console.log(`   face ${JSON.stringify(fc)} ${kk}  旧=${['?', '凸', '凹', '光'][o]} 新=${['?', '凸', '凹', '光'][n2]}`);
    }
  }
}
