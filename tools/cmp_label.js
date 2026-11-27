// 用 AAGNet 仓库自带的带标注样本做逐面比对
// 用法: node tools/cmp_label.js <file.step> <labels.json>
//   labels.json 形如 [[name, {seg:{}, inst:[[]], bottom:{}}], ...]（取第一条）
const fs = require('fs');
const path = require('path');

global.window = global;
const S = require(path.join(__dirname, '..', 'step_import.js'));
const MOD = require(path.join(__dirname, '..', 'aagnet_model.js'));
const REC = require(path.join(__dirname, '..', 'aagnet_recognize.js'));
require(path.join(__dirname, '..', 'aagnet_weights.js'));
global.AAG_MODEL = MOD;
global.AAG_REC = REC;
MOD.load(global.AAG_W);

const [file, labFile] = process.argv.slice(2);
if (!file || !labFile) {
  console.log('用法: node tools/cmp_label.js <file.step> <labels.json>');
  process.exit(1);
}
let raw = JSON.parse(fs.readFileSync(path.resolve(labFile), 'utf8'));
if (Array.isArray(raw) && Array.isArray(raw[0]) && typeof raw[0][0] === 'string') raw = raw[0];
const name = raw[0], lab = raw[1];
const segLab = lab.seg, botLab = lab.bottom, instLab = lab.inst;

const text = fs.readFileSync(path.resolve(file), 'utf8');
const part = S.buildPart(text, path.basename(file));
const nn = part.nn;
if (!nn || nn.error) { console.log('NN 异常', nn && nn.error); process.exit(1); }

console.log(`== ${path.basename(file)}  label=${name}  面 ${nn.N}  标注面 ${Object.keys(segLab).length}`);
console.log(`   构图 ${nn.msGraph}ms  前向 ${nn.msFwd}ms  E=${nn.E}  proposals=${nn.proposals}`);

// ---- 逐面 seg 对比 ----
const cls = nn.classes;
const idOf = {};
cls.forEach((c, i) => { if (!(c in idOf)) idOf[c] = i; });
// 标注类名 -> 我方下标（用 en 名对齐）
const enOf = {};
for (let i = 0; i < cls.length; i++) enOf[cls[i]] = nn.faceClass ? i : i;

console.log('\n面  | 标注(类名/id)        | 我方 argmax          | p     | 标注概率 | top3');
let hit = 0, tot = 0;
const conf = {}; // 标注类 -> [总, 对]
for (let i = 0; i < nn.N; i++) {
  const t = segLab[String(i)];
  if (t === undefined) continue;
  tot++;
  const p = nn.segProb ? nn.segProb.subarray(i * 25, i * 25 + 25) : null;
  const my = nn.faceClass[i];
  const myName = cls[my];
  let pt = null, top3 = [];
  if (p) {
    pt = p[t] !== undefined ? p[t] : null;
    const arr = [];
    for (let k = 0; k < p.length; k++) arr.push([k, p[k]]);
    top3 = arr.sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => `${cls[k]}:${v.toFixed(3)}`);
  }
  const ok = t === my;
  if (ok) hit++;
  conf[t] = conf[t] || [0, 0];
  conf[t][0]++;
  if (ok) conf[t][1]++;
  console.log(
    `${String(i).padStart(2)}  | ${(cls[t] + '/' + t).padEnd(20)} | ${(myName + '/' + my).padEnd(20)} | ` +
    `${p ? (p[my] !== undefined ? p[my].toFixed(3) : '  -  ') : '  -  '} | ` +
    `${pt === null ? '  -  ' : pt.toFixed(3)}    | ${top3.join(' ')}`);
}
console.log(`\nseg 面级命中 ${hit}/${tot} = ${(100 * hit / tot).toFixed(1)}%`);
console.log('按类:', Object.entries(conf).map(([k, v]) => `${cls[k]}#${k} ${v[1]}/${v[0]}`).join('   '));

// ---- 混淆统计 ----
const mat = {};
for (let i = 0; i < nn.N; i++) {
  const t = segLab[String(i)]; if (t === undefined) continue;
  const k = `${t}->${nn.faceClass[i]}`;
  mat[k] = (mat[k] || 0) + 1;
}
console.log('混淆 标注->预测:', Object.entries(mat).map(([k, v]) => `${k}×${v}`).join('  '));

// ---- 实例对比 ----
const labInst = [];
{
  const seen = new Set();
  for (let i = 0; i < instLab.length; i++) {
    const grp = [];
    for (let j = 0; j < instLab[i].length; j++) if (instLab[i][j]) grp.push(j);
    const key = grp.join(',');
    if (grp.length && !seen.has(key)) { seen.add(key); labInst.push(grp); }
  }
}
console.log('\n标注实例:', labInst.map(g => `[${g}]`).join(' '));
console.log('我方实例:', nn.instances.length ? nn.instances.map(it => `[${it.faces}]${it.cls}`).join(' ') : '无');

// ---- 类别分布对比（不看面号，只看各类面数）----
function hist(arr) { const m = {}; for (const c of arr) m[c] = (m[c] || 0) + 1; return m; }
const labHist = hist(Object.values(segLab));
const myHist = hist(Array.from(nn.faceClass));
const keyset = new Set([...Object.keys(labHist), ...Object.keys(myHist)]);
const same = [...keyset].every(k => (labHist[k] || 0) === (myHist[k] || 0));
console.log('\n类别面数分布（不受面号排列影响）：');
console.log('  标注:', [...keyset].sort((a, b) => a - b).map(k => `${cls[k]}#${k}×${labHist[k] || 0}`).join('  '));
console.log('  我方:', [...keyset].sort((a, b) => a - b).map(k => `${cls[k]}#${k}×${myHist[k] || 0}`).join('  '));
console.log('  分布是否完全一致:', same ? '一致' : '不一致');

// ---- bottom 对比 ----
const botL = Object.keys(botLab).filter(k => botLab[k]).map(Number).sort((a, b) => a - b);
const botO = [];
for (let i = 0; i < nn.N; i++) if (nn.bottomMask[i]) botO.push(i);
console.log('\n标注 bottom:', JSON.stringify(botL), ' 我方 bottom:', JSON.stringify(botO));
