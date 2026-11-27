// 用 CDP 把任意 STEP 塞进页面，截图 + 读状态
// 用法: node tools/import_one.js <file.step> [更多...]
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
  const files = process.argv.slice(2);
  if (!files.length) { console.log('用法: node tools/import_one.js <file.step> [...]'); process.exit(1); }
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const t = list.find(x => x.type === 'page' && x.url.includes('aagnet-demo'));
  if (!t) { console.log('no page target（先启动带 --remote-debugging-port=9222 的 Chrome 并打开 index.html）'); process.exit(1); }
  const c = await connect(t.webSocketDebuggerUrl);
  await c.call('Page.enable'); await c.call('Runtime.enable'); await c.call('DOM.enable');
  await c.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await c.call('Page.reload', { ignoreCache: true });
  await sleep(2500);

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
      note: document.getElementById('impNote').textContent,
      err: document.getElementById('dbg') ? document.getElementById('dbg').textContent.slice(0,600) : ''
    })`);

  const root = await c.call('DOM.getDocument');
  const node = await c.call('DOM.querySelector', { nodeId: root.root.nodeId, selector: '#fileStep' });

  for (const f of files) {
    const abs = path.resolve(f);
    const t0 = Date.now();
    await c.call('DOM.setFileInputFiles', { files: [abs], nodeId: node.nodeId });
    await sleep(3000);
    console.log(`\n== ${path.basename(f)}  (${Date.now() - t0} ms 往返)\n`, await state());
    const r = await c.call('Page.captureScreenshot', { format: 'png' });
    const out = path.join(OUT, 'one_' + path.basename(f).replace(/\.[^.]+$/, '') + '.png');
    fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
    console.log('  截图', out);
  }
  console.log('\npage errors:', await ev("document.getElementById('dbg') ? document.getElementById('dbg').textContent : '(none)'"));
  c.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
