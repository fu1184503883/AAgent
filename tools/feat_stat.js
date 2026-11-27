// 特征口径体检：把手算的原始面/边属性分布，和训练集统计量 attr_stat.json 放一起比
// 用法: node tools/feat_stat.js <a.step> [b.step ...]
global.window = global;
const path = require('path');
const fs = require('fs');
const S = require(path.join(__dirname, '..', 'step_import.js'));
const REC = require(path.join(__dirname, '..', 'aagnet_recognize.js'));

// 抄自 AAGNet-main/weights/attr_stat.json
const MF = [0.8859442349534624, 0.10986849777884584, 0.0019160473233649396, 0.0, 0.0016610062870854995,
  0.48359422499865773, 0.0003186540430188848, -0.003223478360784732, -0.0037115890805575606, -0.0013649688687564377];
const SF = [0.317878982481224, 0.3127257759984791, 0.043730722449905966, 0.0, 0.04072158328413781,
  0.7642076544724773, 0.017848039181680667, 0.4512724768710965, 0.4494607374313992, 0.4499260886852193];
const ME = [0.3035324745623818, 0.6593215194179672, 0.03714600601965091, 0.5527907644976456, 0.08814176698439265,
  0.03561724680968134, 0.006790021504123327, 0.0012543484588946557, 0.0001538861660565648, 0.9035944284280141,
  0.0012543484588946557, 0.0001538861660565648];
const SE = [0.45978311343984707, 0.47393739404082746, 0.18911948670587872, 0.5869569768002859, 0.283500962760162,
  0.18533391093098678, 0.08212135599951025, 0.03539456270087981, 0.0124041317759619, 0.29514663700542115,
  0.03539456270087981, 0.0124041317759619];

const FACE_NAMES = ['plane', 'cyl', 'cone', 'sphere', 'torus', 'area', 'rational', 'cx', 'cy', 'cz'];
const EDGE_NAMES = ['concave', 'convex', 'smooth', 'len', 'circle', 'closed', 'ellipse',
  'bspline', 'rat_bspline', 'line', 'bspline2', 'rat_bspline2'];

const files = process.argv.slice(2);
const faRows = [], eaRows = [];
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const p = S.buildPart(text, path.basename(f), { raw: true });
  const g = REC.buildGAAG(p._raw.faces, { center: p._raw.center, maxExt: p._raw.maxExt });
  for (let i = 0; i < g.N; i++) faRows.push(Array.from(g.faRaw.subarray(i * 10, i * 10 + 10)));
  for (let i = 0; i < g.eaRaw.length / 12; i++) eaRows.push(Array.from(g.eaRaw.subarray(i * 12, i * 12 + 12)));
}

function stat(rows, names, refMean, refStd, title) {
  console.log(`\n=== ${title}（${rows.length} 行）`);
  console.log('  idx  name          mean(ours)  mean(ref)   std(ours)   std(ref)   离均值差/参考std');
  names.forEach((nm, k) => {
    const col = rows.map(r => r[k]);
    const m = col.reduce((a, b) => a + b, 0) / col.length;
    const v = Math.sqrt(col.reduce((a, b) => a + (b - m) * (b - m), 0) / col.length);
    const sd = refStd[k] > 1e-8 ? refStd[k] : 1;
    const z = (m - refMean[k]) / sd;
    const flag = Math.abs(z) > 1.5 ? '  <<<' : '';
    console.log(`  ${String(k).padStart(3)}  ${nm.padEnd(12)} ${m.toFixed(4).padStart(10)} ${refMean[k].toFixed(4).padStart(10)} ${v.toFixed(4).padStart(11)} ${refStd[k].toFixed(4).padStart(10)}   ${z.toFixed(2).padStart(7)}${flag}`);
  });
}
stat(faRows, FACE_NAMES, MF, SF, '面属性');
stat(eaRows, EDGE_NAMES, ME, SE, '边属性');
