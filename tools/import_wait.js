// 把任意 STEP 塞进页面，等到导入真正结束（大文件要等几十秒），截图 + 读状态
// 用法: node tools/import_wait.js <file.step> [超时秒数]
const fs = require('fs');
const path = require('path');
const OUT = path.resolve(__dirname, '..', 'shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      call(method, params = {}) {
        return new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      close() { ws.close(); }
    });
    ws.onerror = e => reject(e);
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    };
  });
}

(async () => {
  const file = process.argv[2];
  const limit = parseInt(process.argv[3] || '180', 10);
  if (!file) { console.log('用法: node tools/import_wait.js <file.step> [超时秒]'); process.exit(1); }
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const t = list.find(x => x.type === 'page' && x.url.includes('index.html'));
  if (!t) { console.log('no page target'); process.exit(1); }
  const c = await connect(t.webSocketDebuggerUrl);
  await c.call('Page.enable'); await c.call('Runtime.enable'); await c.call('DOM.enable');
  await c.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await c.call('Page.reload', { ignoreCache: true });
  await sleep(2600);

  const ev = async expr => {
    const r = await c.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.text || '');
    return r.result && r.result.value;
  };
  const state = () => ev(`JSON.stringify({
      name: document.getElementById('mName').textContent,
      faces: document.getElementById('mFace').textContent,
      tris: document.getElementById('mTri').textContent,
      size: document.getElementById('mSize').textContent,
      inst: document.getElementById('tabN').textContent,
      badge: document.getElementById('badgeTx').textContent,
      note: document.getElementById('impNote').textContent.slice(0,420),
      overlay: (document.getElementById('imp')||{}).style ? document.getElementById('imp').style.display : '?'
    })`);

  const root = await c.call('DOM.getDocument');
  const node = await c.call('DOM.querySelector', { nodeId: root.root.nodeId, selector: '#fileStep' });

  const abs = path.resolve(file);
  const t0 = Date.now();
  await c.call('DOM.setFileInputFiles', { files: [abs], nodeId: node.nodeId });

  // 轮询：等 mFace 变成非 0 且导入遮罩收起
  let last = '';
  for (let i = 0; i < limit * 2; i++) {
    await sleep(1000);
    const st = await state();
    if (st !== last) { last = st; }
    try {
      const j = JSON.parse(st);
      const done = (j.overlay === 'none' || j.overlay === '') && j.faces && !/^0$/.test(j.faces.trim());
      if (done) break;
    } catch (e) { /* ignore */ }
  }
  console.log(`\n== ${path.basename(file)}  用时 ${((Date.now() - t0) / 1000).toFixed(1)} s\n`, await state());
  const r = await c.call('Page.captureScreenshot', { format: 'png' });
  const out = path.join(OUT, 'big_' + path.basename(file).replace(/\.[^.]+$/, '').replace(/\s+/g, '_') + '.png');
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log('  截图', out);
  console.log('page errors:', await ev("document.getElementById('dbg') ? document.getElementById('dbg').textContent.slice(0,800) : '(none)'"));
  c.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
