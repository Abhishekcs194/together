// Drives two headless Chrome pages (fake camera/mic) through a video call via the DevTools protocol.
const W = require('ws');
const CDP = 'http://127.0.0.1:9333';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };

async function page(url) {
  const t = await (await fetch(`${CDP}/json/new?${url}`, { method: 'PUT' })).json();
  const ws = new W(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  let id = 0; const pending = new Map();
  ws.on('message', (d) => { const m = JSON.parse(d); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const call = (method, params) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const run = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description));
    return r.result?.result?.value;
  };
  return { run, close: () => fetch(`${CDP}/json/close/${t.id}`) };
}

// With the mesh call model there's one RTCPeerConnection and one call tile per remote peer
// (keyed by id); in this 2-person test there's exactly one of each, so grab "the" one.
const status = `return {
  conn: [...pcs.values()][0]?.pc.connectionState, local: !!localStream, bubble: !document.querySelector('#bubble').hidden,
  novideo: document.querySelector('#bubbleTiles .tile')?.classList.contains('novideo') ?? null,
  remoteW: document.querySelector('#bubbleTiles .tile video')?.videoWidth,
  remoteTracks: [...(document.querySelector('#bubbleTiles .tile video')?.srcObject?.getTracks() || [])].map(t => t.kind + ':' + t.readyState).join(','),
  callbar: !document.querySelector('#callbar').hidden, toast: document.querySelector('#toast').textContent };`;

(async () => {
  const room = 'calltest' + Date.now().toString(36);
  const a = await page(`http://localhost:3123/r/${room}`);
  const b = await page(`http://127.0.0.1:3123/r/${room}`);
  await wait(1500);
  await a.run(`document.querySelector('#nameInput').value='Abhi'; document.querySelector('#joinBtn').click();`);
  await b.run(`document.querySelector('#nameInput').value='Her'; document.querySelector('#joinBtn').click();`);
  await wait(1500);
  ok((await a.run(`return document.querySelector('#presenceText').textContent`)) === 'Her is here', 'both in room');

  await a.run(`await startCall();`);
  await wait(4000);
  let sa = await a.run(status), sb = await b.run(status);
  console.log('  A after start:', JSON.stringify(sa)); console.log('  B after start:', JSON.stringify(sb));
  ok(sa.conn === 'connected' && sb.conn === 'connected', 'peer connection established');
  ok(sb.remoteW > 0 && sb.bubble && !sb.novideo, 'her phone shows his camera');
  ok(/started a call/.test(sb.toast), 'she is told a call started');

  await b.run(`await startCall();`);
  await wait(4000);
  sa = await a.run(status); sb = await b.run(status);
  console.log('  A after join:', JSON.stringify(sa)); console.log('  B after join:', JSON.stringify(sb));
  ok(sa.remoteW > 0 && !sa.novideo && sa.remoteTracks.includes('audio:live'), 'his phone shows her camera + audio');
  ok(sb.remoteW > 0 && sb.remoteTracks.includes('audio:live'), 'she still sees/hears him');

  await b.run(`document.querySelector('#camBtn').click();`);
  await wait(2500);
  sa = await a.run(status);
  ok(sa.novideo, 'when she turns camera off, bubble shows her initial');
  await b.run(`document.querySelector('#camBtn').click();`);

  await b.run(`document.querySelector('#hangBtn').click();`);
  await wait(1500);
  sa = await a.run(status); sb = await b.run(status);
  ok(!sa.local && !sa.bubble && !sb.local && !sb.bubble, 'hang up ends the call on both phones');

  await b.run(`await startCall();`);
  await wait(4000);
  sa = await a.run(status);
  ok(sa.conn === 'connected' && sa.remoteW > 0, 'can call again after hanging up');

  await a.close(); await b.close();
  process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
