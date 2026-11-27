// 把 gAAG 数据导出成二进制 + JSON 元信息，供 tools/ref_forward.py 做参考前向
// 用法: node tools/dump_graph.js <file.step> [out前缀]
global.window = global;
const fs = require('fs');
const path = require('path');
const S = require(path.join(__dirname, '..', 'step_import.js'));
const REC = require(path.join(__dirname, '..', 'aagnet_recognize.js'));

const file = process.argv[2];
if (!file) { console.log('用法: node tools/dump_graph.js <file.step> [out前缀]'); process.exit(1); }
const base = process.argv[3] || path.join(__dirname, 'out', path.basename(file).replace(/\.[^.]+$/, ''));
fs.mkdirSync(path.dirname(base), { recursive: true });

const text = fs.readFileSync(path.resolve(file), 'utf8');
const part = S.buildPart(text, path.basename(file), { raw: true });
const raw = part._raw;
const g = REC.buildGAAG(raw.faces, { center: raw.center, maxExt: raw.maxExt });

fs.writeFileSync(base + '.meta.json', JSON.stringify({
  file: path.basename(file), N: g.N, E: g.edges.length, edges: g.edges,
  pairCount: g.pairCount, faceKinds: raw.faces.map(f => f.kind)
}));
fs.writeFileSync(base + '.fa.bin', Buffer.from(g.fa.buffer));
fs.writeFileSync(base + '.grid.bin', Buffer.from(g.grid.buffer));
fs.writeFileSync(base + '.ea.bin', Buffer.from(g.ea.buffer));

// 同时跑一遍 JS 前向，用于和 numpy 参考实现逐值比对
const MOD = require(path.join(__dirname, '..', 'aagnet_model.js'));
require(path.join(__dirname, '..', 'aagnet_weights.js'));
MOD.load(global.AAG_W);
const out = MOD.forward(Object.assign({}, g, { debug: 2 }));
fs.writeFileSync(base + '.js.json', JSON.stringify({
  seg: Array.from(out.seg), inst: Array.from(out.inst), bottom: Array.from(out.bottom),
  dbg: Object.fromEntries(Object.entries(out.dbg).map(([k, v]) => [k, Array.from(v)]))
}));
console.log(`N=${g.N} E=${g.edges.length} (对 ${g.pairCount})  fa=${g.fa.length} grid=${g.grid.length} ea=${g.ea.length}`);
console.log('写出', base + '.*');
