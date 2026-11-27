// 调试圆柱面三角化：UV 多边形面积 vs 输出三角面 3D 面积
const fs = require('fs');
const path = require('path');
const S = require(path.join(__dirname, '..', 'step_import.js'));

const file = process.argv[2] || 'plate_hole.step';
const text = fs.readFileSync(path.join(__dirname, 'samples', file), 'utf8');
const doc = new S._internals.Doc(S._internals.parseDoc(text));

const ctx = { warn: (m) => console.log('  WARN', m), skip: (m) => console.log('  SKIP', m) };
let n = 0;
for (const [fid, ent] of doc.e) {
  if (ent.type !== 'ADVANCED_FACE' && ent.type !== 'FACE_SURFACE') continue;
  const s = doc.ref(ent.args[2]);
  if (!s || s.type !== 'CYLINDRICAL_SURFACE') continue;
  const t0 = Date.now();
  const f = S._internals.tessFace(doc, fid, ent, ctx);
  if (!f) { console.log('face', fid, '-> null'); continue; }
  n++;
  console.log(`--- face #${fid} ${f.kind} area=${f.area.toFixed(2)} tris=${f.tris} r=${f.radius} arc=${f.arcDeg && f.arcDeg.toFixed(1)} (${Date.now() - t0}ms)`);
  console.log('  3D边界环点数:', f.loops.map(l => l.pts.length).join(','));
  console.log('  UV环点数:', f._uv.map(l => l.uv.length).join(','));
  for (let li = 0; li < f._uv.length; li++) {
    const uv = f._uv[li].uv;
    let a2 = 0;
    for (let i = 0; i < uv.length; i++) { const a = uv[i], b = uv[(i + 1) % uv.length]; a2 += a[0] * b[1] - b[0] * a[1]; }
    const us = uv.map(p => p[0]), vs = uv.map(p => p[1]);
    let mx = 0, at = -1;
    for (let i = 1; i < uv.length; i++) { const d = Math.hypot(uv[i][0] - uv[i - 1][0], uv[i][1] - uv[i - 1][1]); if (d > mx) { mx = d; at = i; } }
    console.log(`  环${li}: area2=${(a2 / 2).toFixed(3)} u∈[${Math.min(...us).toFixed(2)},${Math.max(...us).toFixed(2)}] v∈[${Math.min(...vs).toFixed(2)},${Math.max(...vs).toFixed(2)}] 最大步长=${mx.toFixed(3)}@${at}`);
  }
  // 用输出三角面片复算面积，并与 r*uvArea 比较
  let sum3D = 0;
  const per = [];
  for (let i = 0; i + 9 <= f.pos.length; i += 9) {
    const P = [[f.pos[i], f.pos[i + 1], f.pos[i + 2]], [f.pos[i + 3], f.pos[i + 4], f.pos[i + 5]], [f.pos[i + 6], f.pos[i + 7], f.pos[i + 8]]];
    const e1 = P[1].map((v, k) => v - P[0][k]), e2 = P[2].map((v, k) => v - P[0][k]);
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const a3 = Math.hypot(...cr) / 2;
    sum3D += a3;
    per.push({ i: i / 9, a3 });
  }
  console.log('  Σ3D(pos复算)=', sum3D.toFixed(2), ' 报告area=', f.area.toFixed(2), ' 期望(r*uv)=', (f._uv.reduce((acc, l) => acc + Math.abs((() => { let a2 = 0; const uv = l.uv; for (let i = 0; i < uv.length; i++) { const a = uv[i], b = uv[(i + 1) % uv.length]; a2 += a[0] * b[1] - b[0] * a[1]; } return a2 / 2; })()), 0) * f.radius).toFixed(2));
  // 检查三角形顶点是否都在圆柱面上（半径误差）
  let maxRerr = 0, maxV = 0, minV = 1e9;
  for (let i = 0; i + 2 < f.pos.length; i += 3) {
    const p = [f.pos[i], f.pos[i + 1], f.pos[i + 2]];
    const d = [p[0] - f.axis_pt[0], p[1] - f.axis_pt[1], p[2] - f.axis_pt[2]];
    const ax = f.axis;
    const par = d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2];
    const rad = Math.hypot(d[0] - ax[0] * par, d[1] - ax[1] * par, d[2] - ax[2] * par);
    maxRerr = Math.max(maxRerr, Math.abs(rad - f.radius));
    maxV = Math.max(maxV, par); minV = Math.min(minV, par);
  }
  console.log(`  顶点半径最大偏差=${maxRerr.toFixed(4)} 轴向范围=[${minV.toFixed(3)}, ${maxV.toFixed(3)}]`);
  const bad = per.filter(p => p.a3 > 5).sort((a, b) => b.a3 - a.a3).slice(0, 8);
  console.log('  大三角:', bad.map(p => `#${p.i}:${p.a3.toFixed(2)}`).join(' '));
}
console.log('圆柱面个数:', n);

