// 用散度定理检查整体的面法向是否一致朝外：V = (1/3)∮ p·n dA，应当为正
// 用法: node tools/check_orient.js <a.step> [b.step ...]
global.window = global;
const path = require('path');
const fs = require('fs');
const S = require(path.join(__dirname, '..', 'step_import.js'));

for (const f of process.argv.slice(2)) {
  const text = fs.readFileSync(f, 'utf8');
  const p = S.buildPart(text, path.basename(f), { raw: true });
  const faces = p._raw.faces;
  let V = 0, Vabs = 0;
  const per = [];
  for (const fc of faces) {
    // pos 是三角形顶点序列，每 9 个一组
    const pos = fc.pos;
    let vol = 0;
    for (let i = 0; i + 8 < pos.length; i += 9) {
      const a = [pos[i], pos[i + 1], pos[i + 2]];
      const b = [pos[i + 3], pos[i + 4], pos[i + 5]];
      const c = [pos[i + 6], pos[i + 7], pos[i + 8]];
      // 有符号四面体体积 a·(b×c)/6，相对原点
      vol += (a[0] * (b[1] * c[2] - b[2] * c[1])
        - a[1] * (b[0] * c[2] - b[2] * c[0])
        + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
    per.push({ id: fc.id, kind: fc.kind, same: fc.same, vol });
    V += vol;
    Vabs += Math.abs(vol);
  }
  const diag = Math.cbrt(Math.abs(Vabs) || 1);
  console.log(`\n== ${path.basename(f)}  面 ${faces.length}`);
  console.log(`  有符号体积 V=${V.toFixed(1)}  绝对值合计 ${Vabs.toFixed(1)}  比值 ${(V / (Vabs || 1)).toFixed(3)}`);
  // 每个面的体积贡献符号（负贡献说明该面朝内）
  const neg = per.filter(x => x.vol < -1e-9);
  console.log(`  面贡献为负的: ${neg.length} 个 ${neg.slice(0, 8).map(x => `#${x.id}(${x.kind},same=${x.same},${x.vol.toFixed(0)})`).join(' ')}`);
}
