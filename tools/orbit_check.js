// 验证 3D 视图的旋转 / 平移 / 缩放手感：用 CDP 真发鼠标事件，逐步截图
// 用法: node tools/orbit_check.js
const fs = require('fs');
const path = require('path');
const OUT = path.resolve(__dirname, '..', 'shots');
const PAGE = 'file:///C:/Users/kenven/Desktop/Tecwin/AAgent/index.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  fs.mkdirSync(OUT, { recursive: true });
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const t = list.find(x => x.type === 'page');
  if (!t) { console.log('no page target'); process.exit(1); }
  const c = await connect(t.webSocketDebuggerUrl);
  await c.call('Page.enable');
  await c.call('Runtime.enable');
  await c.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await c.call('Page.navigate', { url: PAGE });
  await sleep(4200);

  const ev = async expr => {
    const r = await c.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.text || '');
    return r.result && r.result.value;
  };
  const shot = async name => {
    const r = await c.call('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT, name);
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  };
  const size = async n => (await fs.promises.stat(path.join(OUT, n))).size;

  const rect = await ev(`(()=>{const r=document.getElementById('gl').getBoundingClientRect();
    return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});})()`);
  if (process.argv[2]) {
    const root = await c.call('DOM.getDocument');
    const node = await c.call('DOM.querySelector', { nodeId: root.root.nodeId, selector: '#fileStep' });
    await c.call('DOM.setFileInputFiles', { files: [path.resolve(process.argv[2])], nodeId: node.nodeId });
    await sleep(3800);
    console.log('已导入', path.basename(process.argv[2]), '→', await ev("document.getElementById('mName').textContent"));
  }
  const R = JSON.parse(rect);
  const cx = Math.round(R.x + R.w/2), cy = Math.round(R.y + R.h/2);
  console.log('canvas', JSON.stringify(R), '中心', cx, cy);

  async function drag(from, to, button, steps, mods) {
    const btn = button === 1 ? 'middle' : (button === 2 ? 'right' : 'left');
    const buttons = button === 1 ? 4 : (button === 2 ? 2 : 1);
    const base = { button: btn, buttons, modifiers: mods || 0 };
    await c.call('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', x: from[0], y: from[1], clickCount: 1 }, base));
    for (let i = 1; i <= steps; i++) {
      const x = from[0] + (to[0]-from[0]) * i/steps, y = from[1] + (to[1]-from[1]) * i/steps;
      await c.call('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved', x, y }, base));
      await sleep(18);
    }
    await c.call('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased', x: to[0], y: to[1], buttons: 0, clickCount: 1 }, base));
    await sleep(900);
  }
  async function wheel(x, y, dy) {
    await c.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
    await sleep(500);
  }

  console.log('\n1) 初始 iso');
  await shot('orbit_1_iso.png');

  console.log('2) 左键向下拖 320px（旧实现到 77° 就卡住）');
  await drag([cx, cy-160], [cx, cy+160], 0, 20);
  await shot('orbit_2_tilt.png');

  console.log('3) 继续往下拖 420px（要能翻到底面）');
  await drag([cx, cy-210], [cx, cy+210], 0, 24);
  await shot('orbit_3_bottom.png');

  console.log('4) 中键拖 260px（平移）');
  await drag([cx, cy], [cx+260, cy-60], 1, 16);
  await shot('orbit_4_pan.png');

  console.log('5) 光标偏左处滚轮放大（朝光标缩放）');
  await wheel(cx-220, cy-40, -300);
  await wheel(cx-220, cy-40, -300);
  await shot('orbit_5_zoom.png');

  console.log('6) Shift+左键绕光标旋转');
  await drag([cx-220, cy-40], [cx-220+120, cy-40+90], 0, 14, 8);
  await shot('orbit_6_anchor.png');

  console.log('7) 双击复位');
  await c.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 2 });
  await c.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 2 });
  await sleep(900);
  await shot('orbit_7_reset.png');

  const files = ['orbit_1_iso.png','orbit_2_tilt.png','orbit_3_bottom.png','orbit_4_pan.png','orbit_5_zoom.png','orbit_6_anchor.png','orbit_7_reset.png'];
  console.log('\n各步截图字节数（全相同说明视图根本没动）:');
  for (const f of files) console.log('  ', f, await size(f));

  console.log('\npage errors:', await ev("document.getElementById('dbg') ? document.getElementById('dbg').textContent.slice(0,400) : '(none)'"));
  c.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
