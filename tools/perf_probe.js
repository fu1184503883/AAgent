// 量化「大件导入」的时间与内存代价：连续导入两次同一文件，再单独压 b64 编码器
// 用法: node tools/perf_probe.js <file.stp> [url]
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
    ws.onerror = e => reject(new Error('ws error'));
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    };
  });
}

const MB = n => (n / 1048576).toFixed(1) + ' MB';

(async () => {
  const file = process.argv[2];
  const url = process.argv[3] || 'http://127.0.0.1:8765/index.html';
  if (!file) { console.log('用法: node tools/perf_probe.js <file.stp> [url]'); process.exit(1); }

  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const t = list.find(x => x.type === 'page');
  if (!t) { console.log('no page target'); process.exit(1); }
  const c = await connect(t.webSocketDebuggerUrl);
  const ev = async expr => {
    const r = await c.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.text || '');
    return r.result && r.result.value;
  };

  await c.call('Page.enable'); await c.call('Runtime.enable'); await c.call('DOM.enable');
  await c.call('Page.navigate', { url });
  await sleep(3000);
  await ev(`window.__err=[];window.onerror=(m,s,l)=>{window.__err.push(m+' @'+l)};1`);

  const mem = () => ev(`performance.memory?performance.memory.usedJSHeapSize:0`);
  const ttl = () => ev(`performance.memory?performance.memory.totalJSHeapSize:0`);
  const st = () => ev(`JSON.stringify({
      name: document.getElementById('mName').textContent,
      faces: document.getElementById('mFace').textContent,
      tris: document.getElementById('mTri').textContent,
      badge: document.getElementById('badgeTx').textContent,
      inst: document.getElementById('tabN').textContent,
      overlay: (document.getElementById('imp')||{style:{}}).style.display,
      note: (document.getElementById('impNote')||{}).textContent ? document.getElementById('impNote').textContent.slice(0,300) : '',
      chips: (window.PARTS? PARTS.length : -1),
      err: (window.__err||[]).slice(0,3)
    })`);

  const root = await c.call('DOM.getDocument');
  const node = await c.call('DOM.querySelector', { nodeId: root.root.nodeId, selector: '#fileStep' });
  const abs = path.resolve(file);

  console.log('页面就绪 · 堆 ' + MB(await mem()));

  async function once(tag) {
    await ev(`document.getElementById('fileStep').value=''; 1`);
    const m0 = await mem();
    const t0 = Date.now();
    await c.call('DOM.setFileInputFiles', { files: [abs], nodeId: node.nodeId });
    let done = false, j = null;
    for (let i = 0; i < 200; i++) {
      await sleep(1000);
      const s = await st();
      try { j = JSON.parse(s); } catch (e) { continue; }
      const ov = (j.overlay || '').trim();
      if ((ov === 'none' || ov === '') && j.faces && !/^0$/.test(j.faces.trim())) { done = true; break; }
      if (i % 5 === 0) process.stdout.write('  …' + (i + 1) + 's\n');
    }
    const dt = (Date.now() - t0) / 1000;
    const m1 = await mem();
    console.log(`\n[${tag}] ${done ? '完成' : '超时'} · 墙钟 ${dt.toFixed(1)} s · 堆 ${MB(m0)} → ${MB(m1)}`);
    console.log('  ' + JSON.stringify(j));
    return { dt, j, m1 };
  }

  const a = await once('第 1 次');
  await sleep(1200);
  const b = await once('第 2 次');

  // b64 编码器单独压测：与导入时同样大小的字节
  const n = 54722160;
  const bench = await ev(`(() => {
    const n = ${n}, bytes = new Uint8Array(n);
    for (let i = 0; i < n; i += 997) bytes[i] = i & 255;
    const CH='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const m0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
    const t0 = performance.now();
    const out = []; let i = 0;
    for (; i + 2 < n; i += 3){ const b0=bytes[i],b1=bytes[i+1],b2=bytes[i+2];
      out.push(CH[b0>>2],CH[((b0&3)<<4)|(b1>>4)],CH[((b1&15)<<2)|(b2>>6)],CH[b2&63]); }
    const s = out.join('');
    const t1 = performance.now();
    const m1 = performance.memory ? performance.memory.usedJSHeapSize : 0;
    return JSON.stringify({ ms: Math.round(t1-t0), heapUpMB: +((m1-m0)/1048576).toFixed(1),
      base64MB: +(s.length/1048576).toFixed(1), arrLen: out.length });
  })()`);
  console.log('\n[b64 编码器 · 54.7 MB 输入]\n  ' + bench);

  console.log('\n页面错误: ' + JSON.stringify(await ev(`window.__err||[]`)));
  c.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
