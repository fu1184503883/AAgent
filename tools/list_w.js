// 打印 aagnet_weights.js 里所有张量的名字与形状
global.window = global;
require('../aagnet_weights.js');
var W = global.AAG_W;
var keys = Object.keys(W.idx);
console.log('参数张量数:', keys.length, ' 元素总数:', W.n);
var byGroup = {};
keys.forEach(function (k) {
  var g = k.split('.')[0];
  (byGroup[g] = byGroup[g] || []).push(k + '  ' + JSON.stringify(W.idx[k].slice(1)));
});
Object.keys(byGroup).forEach(function (g) {
  console.log('\n### ' + g);
  byGroup[g].forEach(function (s) { console.log('  ' + s); });
});
