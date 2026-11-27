// 用 CDP 走一遍「导入本地 STP」：设置 file input → 等待解析 → 截图 + 读状态
const fs = require('fs');
const path = require('path');
const OUT = path.resolve(__dirname, '..', 'shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function targets() {
  const res = await fetch('http://127.0.0.1:9222/json/list');
  return res.json();
}
function connect(url) {
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
  const t = (await targets()).find(x => x.type === 'page' && x.url.includes('index.html'));
  if (!t) { console.log('no page target'); process.exit(1); }
  const c = await connect(t.webSocketDebuggerUrl);
  await c.call('Page.enable');
  await c.call('Runtime.enable');
  await c.call('DOM.enable');
  await c.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await c.call('Page.reload', { ignoreCache: true });
  await sleep(2500);

  const ev = async expr => {
    const r = await c.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.text || '');
    return r.result && r.result.value;
  };
  const shot = async name => {
    const r = await c.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  };
  const state = () => ev(`JSON.stringify({
      parts: (window.AAG_DEMO||[]).length,
      chips: [...document.querySelectorAll('#parts .chip')].map(b=>b.textContent.trim()),
      name: document.getElementById('mName').textContent,
      file: document.getElementById('mFile').textContent,
      faces: document.getElementById('mFace').textContent,
      tris: document.getElementById('mTri').textContent,
      edges: document.getElementById('mEdge').textContent,
      size: document.getElementById('mSize').textContent,
      inst: document.getElementById('tabN').textContent,
      badge: document.getElementById('badgeTx').textContent,
      note: document.getElementById('impNote').textContent,
      flow: document.getElementById('flowState').textContent,
      err: document.getElementById('dbg') ? document.getElementById('dbg').textContent.slice(0,400) : ''
    })`);

  console.log('base:', await state());
  await shot('imp_0_base.png');

  const root = await c.call('DOM.getDocument');
  const node = await c.call('DOM.querySelector', { nodeId: root.root.nodeId, selector: '#fileStep' });
  console.log('input nodeId', node.nodeId);

  for (const f of ['plate_hole.step', 'plate_blind.step', 'plate_pocket.step', 'plate_notch.step']) {
    const abs = path.join(__dirname, 'samples', f);
    await c.call('DOM.setFileInputFiles', { files: [abs], nodeId: node.nodeId });
    await sleep(2600);
    console.log(`\n== ${f}\n`, await state());
    await shot('imp_' + f.replace('.step', '') + '.png');
  }

  // 切回样例件 A，检查徽标恢复
  await ev("document.querySelectorAll('#parts .chip')[0].click()");
  await sleep(1500);
  console.log('\nback to A:', await state());
  await shot('imp_back_A.png');

  console.log('\npage errors:', await ev("document.getElementById('dbg') ? document.getElementById('dbg').textContent : '(none)'"));
  c.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
