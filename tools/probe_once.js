// 单次导入探针：等真正跑完（含网络），把界面上的口径全抓回来
// 用法: node tools/probe_once.js <file.stp> [超时秒]
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0; const pending = new Map();
    ws.onopen = () => resolve({
      call(method, params = {}) {
        return new Promise((res, rej) => {
          const mid = ++id; pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      close() { ws.close(); }
    });
    ws.onerror = () => reject(new Error('ws error'));
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    };
  });
}

(async () => {
  const file = process.argv[2];
  const limit = parseInt(process.argv[3] || '240', 10);
  if (!file) { console.log('用法: node tools/probe_once.js <file.stp> [超时秒]'); process.exit(1); }

  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const t = list.find(x => x.type === 'page');
  const c = await connect(t.webSocketDebuggerUrl);
  const ev = async expr => {
    const r = await c.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.text || '');
    return r.result && r.result.value;
  };
  await c.call('Page.enable'); await c.call('Runtime.enable'); await c.call('DOM.enable');
  await c.call('Page.navigate', { url: 'http://127.0.0.1:8765/index.html' });
  await sleep(3200);
  await ev(`window.__err=[];window.onerror=(m,s,l)=>{window.__err.push(m+' @'+l)};1`);

  const snap = () => ev(`JSON.stringify({
    badge: document.getElementById('badgeTx').textContent,
    faces: document.getElementById('mFace').textContent,
    tris: document.getElementById('mTri').textContent,
    edges: document.getElementById('mEdge').textContent,
    inst: document.getElementById('tabN').textContent,
    infer: document.getElementById('mInfer').textContent,
    inferTitle: document.getElementById('mInfer').title,
    note: (document.getElementById('impNote')||{}).innerHTML ? document.getElementById('impNote').innerText.replace(/\\s+/g,' ').slice(0,400) : '',
    steps: Array.from(document.querySelectorAll('#steps .step')).map(s=>s.innerText.replace(/\\s+/g,' ').trim()),
    overlay: (document.getElementById('imp')||{style:{}}).style.display,
    err: (window.__err||[]).slice(0,4),
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize/1048576).toFixed(1) : 0
  })`);

  const root = await c.call('DOM.getDocument');
  const node = await c.call('DOM.querySelector', { nodeId: root.root.nodeId, selector: '#fileStep' });
  const t0 = Date.now();
  await c.call('DOM.setFileInputFiles', { files: [path.resolve(file)], nodeId: node.nodeId });

  let done = false, j = null;
  for (let i = 0; i < limit; i++) {
    await sleep(1000);
    try { j = JSON.parse(await snap()); } catch (e) { continue; }
    const ov = (j.overlay || '').trim();
    if ((ov === 'none' || ov === '') && j.faces && !/^0$/.test(j.faces.trim())) { done = true; break; }
    if (i % 10 === 9) process.stdout.write('  …' + (i + 1) + 's\n');
  }
  // 等流水线动画走完
  await sleep(3500);
  const fin = JSON.parse(await snap());
  console.log(`\n== ${path.basename(file)}  ${done ? '完成' : '超时'}  墙钟 ${((Date.now()-t0)/1000).toFixed(1)} s\n`);
  console.log(JSON.stringify(fin, null, 2));
  const fs = require('fs');
  const shot = await c.call('Page.captureScreenshot', { format: 'png' });
  const out = path.resolve(__dirname, '..', 'shots', 'probe_' + path.basename(file).replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5]+/g, '_') + '.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('截图 ' + out);
  c.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
