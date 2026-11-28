/* OCC 三角化 Worker
 * ---------------------------------------------------------------------------
 * 主线程跑自有 STEP 解析（面属性 / gAAG / 网络）的同时，这个 worker 并行做
 * OpenCASCADE 的读入 + 网格化。主线程解析完成后把面的最小描述发过来，
 * worker 里完成「面分组 → face id 匹配 → 装配 _pos/_nrm/fids」，再把结果
 * 以 Transferable 交回主线程（零拷贝）。
 *
 * 只在 http(s) 下可用；file:// 页面浏览器禁止 Worker，调用方回落串行路径。
 */
self.importScripts('occt-wasm-b64.js', 'occt-import-js.js', '../occ_display.js');

var occtP = null;
var res = null;
var pendingFaces = null;
var t0 = 0;
var defl = 0.05;

function nowMs() { return Date.now(); }

function getOcct(ok, fail) {
  if (occtP) return ok();
  try {
    var b64 = self.OCC_WASM_B64;
    if (!b64) throw new Error('occt-wasm-b64.js 未加载');
    var s = self.atob(b64);
    var u8 = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    self.occtimportjs({ wasmBinary: u8 }).then(function (o) { occtP = o; ok(); }, fail);
  } catch (e) { fail(e); }
}

function doMatch(d) {
  try {
    var out = self.OCC_DISPLAY.matchAndAssemble(res, d.faces, d.norm);
    self.postMessage({
      type: 'done',
      pos: out.pos, nrm: out.nrm, fids: out.fids,
      tris: out.tris, ms: nowMs() - t0, match: out.match
    }, [out.pos.buffer, out.nrm.buffer, out.fids.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', error: String((err && err.message) || err) });
  }
}

self.onmessage = function (e) {
  var d = e.data || {};
  if (d.type === 'start') {
    t0 = nowMs();
    defl = d.defl || 0.05;
    var step = d.step;
    getOcct(function () {
      try {
        res = occtP.ReadStepFile(new Uint8Array(step), {
          linearUnit: 'millimeter',
          linearDeflectionType: 'absolute_value',
          linearDeflection: defl,
          angularDeflection: 0.5
        });
        if (!res || !res.success || !res.meshes || !res.meshes.length) throw new Error('OCC 读取失败');
        self.postMessage({ type: 'meshed', ms: nowMs() - t0 });
        if (pendingFaces) { var pf = pendingFaces; pendingFaces = null; doMatch(pf); }
      } catch (err) {
        self.postMessage({ type: 'error', error: String((err && err.message) || err) });
      }
    }, function (err) {
      self.postMessage({ type: 'error', error: 'OCC wasm 初始化失败：' + String((err && err.message) || err) });
    });
  } else if (d.type === 'faces') {
    if (!res) { pendingFaces = d; return; }
    doMatch(d);
  }
};
