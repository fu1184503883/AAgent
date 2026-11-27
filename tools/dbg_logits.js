// 打印 seg/inst/bottom 原始 logits 统计
// 用法: node tools/dbg_logits.js <file.step>
const fs = require('fs');
const path = require('path');
global.window = global;
const S = require(path.join(__dirname, '..', 'step_import.js'));
const REC = require(path.join(__dirname, '..', 'aagnet_recognize.js'));
const MOD = require(path.join(__dirname, '..', 'aagnet_model.js'));
require(path.join(__dirname, '..', 'aagnet_weights.js'));
MOD.load(global.AAG_W);

const file = process.argv[2];
const part = S.buildPart(fs.readFileSync(path.resolve(file), 'utf8'), path.basename(file), { raw: true });
const raw = part._raw;
const g = REC.buildGAAG(raw.faces, { center: raw.center, maxExt: raw.maxExt });
const out = MOD.forward(g);

const N = g.N;
function stat(name, arr, per) {
  const v = Array.from(arr);
  const mn = Math.min(...v), mx = Math.max(...v);
  let s = 0; for (const x of v) s += x;
  console.log(`${name}: n=${v.length} min=${mn.toFixed(3)} max=${mx.toFixed(3)} mean=${(s / v.length).toFixed(3)}`);
  if (per) {
    for (let i = 0; i < N; i++) {
      console.log(`  f${String(i).padStart(2)} ${v.slice(i * per, i * per + per).map(x => x.toFixed(2)).join(' ')}`);
    }
  }
}
stat('seg logits', out.seg);
stat('bottom logits', out.bottom, 1);
stat('inst logits', out.inst);
console.log('dbg keys', Object.keys(out.dbg || {}));
for (const [k, v] of Object.entries(out.dbg || {})) stat('  dbg.' + k, v);
