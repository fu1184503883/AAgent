// AAGNet 浏览器移植版的 Node 测试台
// 用法: node tools/nn_test.js <file.step> [more.step ...]
//      node tools/nn_test.js --convex tools/samples/box.step     # 只看凸凹判定
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

const args = process.argv.slice(2);
const convexOnly = args[0] === '--convex';
const files = convexOnly ? args.slice(1) : args;

for (const f of files) {
  const abs = path.isAbsolute(f) ? f : path.resolve(f);
  const text = fs.readFileSync(abs, 'utf8');
  const name = path.basename(abs);
  const t0 = Date.now();
  let part;
  try {
    part = S.buildPart(text, name);
  } catch (e) {
    console.log(`\n== ${name}  解析失败: ${e.message}`);
    continue;
  }
  console.log(`\n== ${name}  面 ${part.faces.length}  三角面 ${part.triangles}  size ${part.size_mm.join('x')}  ${Date.now() - t0}ms`);

  if (convexOnly) {
    const rec = part.nn;
    if (!rec) { console.log('  (没有 NN 结果)'); continue; }
    continue;
  }

  const nn = part.nn;
  if (!nn) { console.log('  ! 没有 NN 结果（模型没加载？）', JSON.stringify(part.diag.warnings)); continue; }
  if (nn.error) { console.log('  ! NN 异常:', nn.error); continue; }

  const clsCount = {};
  for (let i = 0; i < nn.N; i++) {
    const c = nn.classes[nn.faceClass[i]];
    clsCount[c] = (clsCount[c] || 0) + 1;
  }
  console.log(`  gAAG: N=${nn.N} E=${nn.E} 构图 ${nn.msGraph}ms  前向 ${nn.msFwd}ms  proposals=${nn.proposals}`);
  console.log('  面级类别:', Object.entries(clsCount).map(([k, v]) => `${k}×${v}`).join('  '));
  if (!nn.instances.length) console.log('  实例: 无');
  for (const it of nn.instances) {
    console.log(`  实例 ${it.key} ${it.cls}(${it.en}) faces=${JSON.stringify(it.faces)} conf=${it.conf} bottom=${it.bottom}`, it.params.map(p => p[1]).join(' '));
  }
}
