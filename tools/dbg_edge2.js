// 统计边属性里「没算出来」的比例，并定位原因
global.window = global;
const path = require('path');
const fs = require('fs');
const S = require(path.join(__dirname, '..', 'step_import.js'));
const REC = require(path.join(__dirname, '..', 'aagnet_recognize.js'));

const files = process.argv.slice(2);
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const p = S.buildPart(text, path.basename(f), { raw: true });
  const faces = p._raw.faces;
  const edges = REC._internals.collectEdges(faces);
  const cv = { 0: 0, 1: 0, 2: 0, 3: 0 };
  const ct = {};
  let noSeg = 0, noUV = 0, open = 0;
  for (const e of edges) {
    if (e.faces.length < 2) { open++; continue; }
    const c = REC._internals.convexity(e, faces);
    cv[c]++;
    const t = (e.segs[0].curve && e.segs[0].curve.type) || 'OTHER';
    ct[t] = (ct[t] || 0) + 1;
    if (!e.segs || e.segs.length < 2) noSeg++;
    // uvOf 失败计数
    const A = faces[e.faces[0]];
    const pts = e.segs[0].pts;
    const mid = pts.length === 2 ? [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2, (pts[0][2] + pts[1][2]) / 2] : pts[pts.length >> 1];
    if (!A.surf.uvOf || !A.surf.uvOf(mid)) noUV++;
  }
  console.log(`\n== ${path.basename(f)}  边 ${edges.length}（开边 ${open}）`);
  console.log(`  凸凹: ${JSON.stringify(cv)}   segs<2: ${noSeg}   uvOf 失败: ${noUV}`);
  console.log(`  曲线: ${JSON.stringify(ct)}`);
}
