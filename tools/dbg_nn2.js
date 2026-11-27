// 逐阶段定位 NaN：打印每个 stage 的 NaN 行分布
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
const faces = raw.faces;
console.log(`面数 ${faces.length}  center=${JSON.stringify(raw.center)} maxExt=${raw.maxExt}`);

const g = REC.buildGAAG(faces, { center: raw.center, maxExt: raw.maxExt });
console.log(`N=${g.N} E=${g.edges.length}  边总数=${g.edgeTotal}  开边=${g.edgeTotal - g.edgeCount}`);
console.log('edges', JSON.stringify(g.edges));

let gz = 0;
for (let i = 0; i < g.grid.length; i++) if (g.grid[i] !== 0) gz++;
console.log(`grid 非零 ${gz}/${g.grid.length}`);
console.log('fa[0..9]', Array.from(g.fa.slice(0, 10)).map(x => +x.toFixed(3)).join(' '));
console.log('ea[0..11]', Array.from(g.ea.slice(0, 12)).map(x => +x.toFixed(3)).join(' '));

const I = MOD._internals;
const N = g.N, E = g.edges.length;

const out = MOD.forward(Object.assign({}, g, { debug: true }));
console.log('\n=== stages ===');
out.stages.forEach(s => console.log(`  ${s.name.padEnd(20)} min=${String(s.min).padStart(10)} max=${String(s.max).padStart(10)} mean=${String(s.mean).padStart(10)} nan=${s.nan}`));

function dump(tag, a, n, dim) {
  const bad = [];
  for (let r = 0; r < n; r++) {
    let b = 0;
    for (let c = 0; c < dim; c++) if (!isFinite(a[r * dim + c])) b++;
    if (b) bad.push(`#${r}(${b}/${dim})`);
  }
  console.log(`[${tag}] len=${a.length} 坏行/段=${bad.length} ${bad.slice(0, 12).join(' ')}`);
}
dump('local', out.local || [], 0, 1);

// 逐层手工复刻
const h0 = new Float32Array(N * 128);
const ha0 = I.linear(g.fa, N, 10, I.T('node_attr_encoder.0.weight'), I.T('node_attr_encoder.0.bias'), 64);
const ha = I.layerNorm(ha0, N, 64, I.T('node_attr_encoder.1.weight'), I.T('node_attr_encoder.1.bias'));
// grid 编码走的是模块内私有函数，借 forward 的中间量不可得：这里先只查属性分支
for (let i = 0; i < N; i++) h0.set(ha.subarray(i * 64, (i + 1) * 64), i * 128);
dump('h(attr only, 后半截=0)', h0, N, 128);

// 检查所有张量是否含非有限值
const badT = [];
Object.keys(global.AAG_W.idx).forEach(k => {
  const t = I.T(k).d;
  for (let i = 0; i < t.length; i++) if (!isFinite(t[i])) { badT.push(k + ' @' + i + '=' + t[i]); break; }
});
console.log('\n含非有限值的张量:', badT.length ? badT.join('\n  ') : '无');
