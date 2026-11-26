// Heads-up QA driver over CDP: clicks through the demo and saves screenshots.
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '..', 'shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function targets(){
  const res = await fetch('http://127.0.0.1:9222/json/list');
  return res.json();
}

function connect(url){
  return new Promise((resolve, reject)=>{
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onopen = ()=> resolve({
      call(method, params={}){
        return new Promise((res, rej)=>{
          const mid = ++id;
          pending.set(mid, {res, rej});
          ws.send(JSON.stringify({id: mid, method, params}));
        });
      },
      close(){ ws.close(); }
    });
    ws.onerror = e=> reject(e);
    ws.onmessage = ev=>{
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)){
        const {res, rej} = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    };
  });
}

(async ()=>{
  const list = await targets();
  const t = list.find(x=>x.type==='page' && x.url.includes('aagnet-demo'));
  if (!t) { console.log('no page target', list.map(x=>x.url)); process.exit(1); }
  const c = await connect(t.webSocketDebuggerUrl);
  await c.call('Page.enable');
  await c.call('Runtime.enable');
  await c.call('Page.reload', {ignoreCache: true});
  await sleep(3000);

  const ev = async (expr)=> {
    const r = await c.call('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
    return r.result && r.result.value;
  };
  const shot = async (name)=>{
    const r = await c.call('Page.captureScreenshot', {format:'png'});
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
    console.log('shot', name);
  };

  // viewport
  await c.call('Emulation.setDeviceMetricsOverride', {width:1600, height:1000, deviceScaleFactor:1, mobile:false});
  await sleep(400);

  const dbg = await ev("document.getElementById('dbg') ? document.getElementById('dbg').textContent : ''");
  console.log('errors:', dbg || '(none)');
  const state = await ev("JSON.stringify({parts: (window.AAG_DEMO||[]).length, faces: AAG_DEMO[0].faces.length, inst: AAG_DEMO[0].instances.length})");
  console.log('state', state);

  await shot('qa_semantic.png');

  // hover center of viewport to test picking
  const rect = await ev("(()=>{const r=document.getElementById('gl').getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height})})()");
  const R = JSON.parse(rect);
  const cx = R.x + R.w*0.52, cy = R.y + R.h*0.55;
  await c.call('Input.dispatchMouseEvent', {type:'mouseMoved', x:cx, y:cy, button:'none'});
  await sleep(700);
  console.log('hover hud:', await ev("JSON.stringify({f:document.getElementById('hFace').textContent,t:document.getElementById('hType').textContent,feat:document.getElementById('hFeat').textContent})"));
  await shot('qa_hover.png');

  // select instance 3 from list
  await ev("document.querySelector('.feat[data-i=\"3\"]').click()");
  await sleep(700);
  await shot('qa_select.png');

  // instance view
  await ev("document.querySelector('[data-mode=\"instance\"]').click()");
  await sleep(700);
  await shot('qa_instance.png');

  // bottom faces view
  await ev("document.querySelector('[data-mode=\"bottom\"]').click()");
  await sleep(700);
  await shot('qa_bottom.png');

  // face segmentation view
  await ev("document.querySelector('[data-mode=\"face\"]').click()");
  await sleep(700);
  await shot('qa_face.png');

  // process tab
  await ev("document.querySelector('[data-pane=\"proc\"]').click()");
  await sleep(700);
  await shot('qa_proc.png');

  // data tab
  await ev("document.querySelector('[data-pane=\"data\"]').click()");
  await sleep(600);
  await shot('qa_data.png');

  // run pipeline
  await ev("document.querySelector('[data-pane=\"feat\"]').click(); document.querySelector('[data-mode=\"semantic\"]').click(); document.getElementById('btnRun').click()");
  await sleep(2400);
  await shot('qa_run.png');
  console.log('flow:', await ev("document.getElementById('flowState').textContent"));
  console.log('errors:', await ev("document.getElementById('dbg') ? document.getElementById('dbg').textContent : '(none)'"));

  // switch to part C
  await ev("document.querySelectorAll('#parts .chip')[2].click()");
  await sleep(1800);
  await shot('qa_partC.png');
  console.log('C:', await ev("JSON.stringify({faces:AAG_DEMO[2].faces.length, inst:AAG_DEMO[2].instances.length, name:document.getElementById('mName').textContent})"));

  c.close();
})().catch(e=>{ console.error('QA FAIL', e); process.exit(1); });
