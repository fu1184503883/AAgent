// Quick screenshot of a given part index: node tools/shot_part.js 1 out.png
const fs = require('fs');
const path = require('path');
const OUT = path.resolve(__dirname, '..', 'shots');
const idx = Number(process.argv[2] || 0);
const name = process.argv[3] || ('part' + idx);

async function main(){
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const t = list.find(x=>x.type==='page' && x.url.includes('aagnet-demo'));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id=0; const pend=new Map();
  await new Promise(r=>ws.onopen=r);
  ws.onmessage = ev=>{ const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id);} };
  const call=(method,params={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method,params}));});
  const ev=async e=>(await call('Runtime.evaluate',{expression:e,returnByValue:true})).result.value;
  await call('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
  await ev(`document.querySelectorAll('#parts .chip')[${idx}].click()`);
  await new Promise(r=>setTimeout(r,2200));
  const s = await call('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(OUT,name+'.png'), Buffer.from(s.data,'base64'));
  console.log('saved', name, await ev("document.getElementById('mName').textContent"));
  ws.close();
}
main().catch(e=>{console.error(e);process.exit(1);});
