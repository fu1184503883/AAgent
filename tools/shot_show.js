// Clean marketing shots: no hover, no selection, default semantic view.
const fs = require('fs');
const path = require('path');
const OUT = path.resolve(__dirname, '..', 'shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function connect(url){
  return new Promise((resolve, reject)=>{
    const ws = new WebSocket(url);
    let id = 0; const pending = new Map();
    ws.onopen = ()=> resolve({
      call(method, params={}){ return new Promise((res, rej)=>{ const mid = ++id; pending.set(mid, {res, rej}); ws.send(JSON.stringify({id:mid, method, params})); }); },
      close(){ ws.close(); }
    });
    ws.onerror = e=>reject(e);
    ws.onmessage = ev=>{ const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)){ const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  });
}

(async ()=>{
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const t = list.find(x=>x.type==='page' && x.url.includes('aagnet-demo'));
  if (!t){ console.log('no page', list.map(x=>x.url)); process.exit(1); }
  const c = await connect(t.webSocketDebuggerUrl);
  await c.call('Page.enable'); await c.call('Runtime.enable');
  await c.call('Emulation.setDeviceMetricsOverride', {width:1600, height:1000, deviceScaleFactor:1, mobile:false});
  await c.call('Page.reload', {ignoreCache:true});
  await sleep(3200);
  const ev = async e => (await c.call('Runtime.evaluate', {expression:e, returnByValue:true, awaitPromise:true})).result.value;
  const shot = async n => { const r = await c.call('Page.captureScreenshot', {format:'png'}); fs.writeFileSync(path.join(OUT, n), Buffer.from(r.data,'base64')); console.log('shot', n); };

  await shot('show_A_semantic.png');

  await ev("document.querySelector('[data-mode=\"instance\"]').click()");
  await sleep(600); await shot('show_A_instance.png');

  await ev("document.querySelector('[data-mode=\"semantic\"]').click(); document.querySelector('[data-pane=\"proc\"]').click()");
  await sleep(600); await shot('show_A_proc.png');

  await ev("document.querySelector('[data-pane=\"feat\"]').click(); document.querySelectorAll('#parts .chip')[2].click()");
  await sleep(4200); await shot('show_C_semantic.png');

  await ev("document.querySelectorAll('#parts .chip')[1].click()");
  await sleep(3200); await shot('show_B_semantic.png');

  console.log('errors:', await ev("document.getElementById('dbg') ? document.getElementById('dbg').textContent : '(none)'"));
  c.close();
})().catch(e=>{ console.error('FAIL', e); process.exit(1); });
