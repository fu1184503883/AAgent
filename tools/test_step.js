// 自检：node tools/test_step.js  → 解析 tools/samples/*.step，核对面/实例/参数
const fs = require('fs');
const path = require('path');
const S = require('../step_import.js');

const dir = path.join(__dirname, 'samples');
const files = fs.readdirSync(dir).filter(f => /\.(step|stp)$/i.test(f));

let bad = 0;
for (const f of files) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  try {
    const p = S.buildPart(text, f);
    const cls = {};
    p.instances.forEach(i => { cls[i.cls] = (cls[i.cls] || 0) + 1; });
    console.log(`\n== ${f}`);
    console.log(`   faces=${p.faces.length} tris=${p.triangles} edges=${p.edges.length} ` +
      `size=${p.size_mm.join('x')} unit=${p.diag.unit_mm}ms=${p.diag.ms}`);
    console.log(`   instances=${p.instances.length} ${JSON.stringify(cls)}`);
    console.log(`   warnings=${p.diag.warnings.length ? p.diag.warnings.join(' / ') : '(none)'}`);
    if (p.diag.skipped.length) console.log(`   skipped: ${p.diag.skipped.join(' / ')}`);
    p.instances.forEach(i => console.log(`   ${i.key} ${i.cls} faces=${i.faces} bottom=${i.bottom} ` +
      `${i.params.map(x => x[0] + ':' + x[1]).join(' ')}`));
    const types = {};
    p.faces.forEach(x => { types[x.type] = (types[x.type] || 0) + 1; });
    console.log('   types', JSON.stringify(types));
    if (!p.faces.length || !p.triangles) bad++;
  } catch (e) {
    bad++;
    console.log(`\n== ${f}\n   FAIL ${e.message}\n${e.stack.split('\n').slice(1, 4).join('\n')}`);
  }
}
console.log(bad ? `\nFAILED ${bad}` : '\nALL OK');
process.exit(bad ? 1 : 0);
