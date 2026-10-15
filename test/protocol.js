const WebSocket = require('ws');
const http = require('http');
const B = 'ws://localhost:3123/ws?room=testroom1';
const open = (id, name) => new Promise((res) => { const ws = new WebSocket(`${B}&id=${id}&name=${name}`); ws.msgs = []; ws.on('message', (d) => ws.msgs.push(JSON.parse(d))); ws.on('open', () => res(ws)); ws.on('close', (c) => (ws.closedCode = c)); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const last = (ws, t) => [...ws.msgs].reverse().find((m) => m.t === t);
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
(async () => {
  // tiny upstream "debrid" server to exercise the range proxy
  const body = Buffer.alloc(1000, 7);
  const up = http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d+)?/.exec(req.headers.range || '');
    if (m) { const a = +m[1], b = m[2] ? +m[2] : 999; res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${a}-${b}/1000`, 'Content-Length': b - a + 1 }); return res.end(body.subarray(a, b + 1)); }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': 1000 }); res.end(body);
  }).listen(3124);

  // --- room capacity: up to 6 people, a 7th is rejected ---
  const a = await open('aaaaaaaa', 'Abhi'), b = await open('bbbbbbbb', 'Her');
  const c = await open('cccccccc', 'Third'), d = await open('dddddddd', 'Fourth');
  const e = await open('eeeeeeee', 'Fifth'), f = await open('ffffffff', 'Sixth');
  await wait(150);
  ok(last(a, 'peers')?.peers.length === 6, 'all 6 room members see each other');
  const seventh = await open('gggggggg', 'Seventh'); await wait(100);
  ok(seventh.msgs.some((m) => m.t === 'full') && seventh.closedCode === 4001, 'seventh person rejected');

  // --- rtc signalling is point-to-point, not broadcast, now that rooms can hold more than 2 ---
  a.send(JSON.stringify({ t: 'rtc', to: 'cccccccc', description: { type: 'offer', sdp: 'x' } })); await wait(100);
  ok(last(c, 'rtc')?.fromId === 'aaaaaaaa', 'rtc reaches the intended target');
  ok(!last(b, 'rtc') && !last(d, 'rtc') && !last(e, 'rtc') && !last(f, 'rtc'), 'rtc is not broadcast to everyone else in the room');

  // Trim back to 3 people for the rest: sync/chat/holds already broadcast to everyone but the
  // sender regardless of room size, so a 3-way is enough to confirm that still holds.
  d.close(); e.close(); f.close(); await wait(100);

  a.send(JSON.stringify({ t: 'load', url: 'http://localhost:3124/movie.mp4', title: 'Test', proxy: true })); await wait(100);
  ok(last(b, 'state')?.state.url.endsWith('movie.mp4') && last(b, 'state').state.paused, 'partner gets loaded movie, paused');
  ok(last(c, 'state')?.state.url.endsWith('movie.mp4'), 'a third room member gets it too');
  a.send(JSON.stringify({ t: 'ctl', action: 'play', pos: 10 })); await wait(100);
  const s = last(b, 'state').state; ok(!s.paused && s.pos === 10, 'play at 10s reaches partner');
  b.send(JSON.stringify({ t: 'buffering', on: true })); await wait(100);
  const h = last(a, 'state'); ok(h.state.paused && h.state.autoPaused && h.holds[0] === 'Her' && h.state.pos >= 10, 'partner buffering auto-pauses everyone');
  b.send(JSON.stringify({ t: 'buffering', on: false })); await wait(100);
  ok(!last(a, 'state').state.paused, 'resumes for everyone when buffering ends');
  b.send(JSON.stringify({ t: 'chat', text: 'hi ❤️' })); await wait(100);
  ok(last(a, 'chat')?.text === 'hi ❤️' && last(a, 'chat').from === 'Her', 'chat delivered');
  ok(last(c, 'chat')?.text === 'hi ❤️', 'chat delivered to the whole room, not just one other person');
  let r = await fetch('http://localhost:3123/stream/testroom1', { headers: { Range: 'bytes=100-199' } });
  ok(r.status === 206 && r.headers.get('content-range') === 'bytes 100-199/1000' && (await r.arrayBuffer()).byteLength === 100, 'proxy forwards range requests');
  r = await fetch('http://localhost:3123/stream/otherroom'); ok(r.status === 404, 'proxy refuses rooms without a movie');
  // reconnect with same id replaces old socket (phone back from background)
  const b2 = await open('bbbbbbbb', 'Her'); await wait(150);
  ok(b2.msgs[0].t === 'welcome' && b2.msgs[0].peers.length === 3 && b2.msgs[0].history.length === 1, 'reconnect restores room, history, no duplicate');
  b2.close(); c.close(); await wait(100);
  ok(last(a, 'peers').peers.length === 1 && last(a, 'peers').left === 'Third', 'leave is announced');
  for (const p of ['/', '/r/testroom1', '/share?url=x', '/app.js', '/manifest.webmanifest', '/icon-192.png', '/api/ice']) {
    const res = await fetch('http://localhost:3123' + p); ok(res.status === 200, `GET ${p} -> ${res.status}`);
  }
  ok((await fetch('http://localhost:3123/../server.js')).status !== 200, 'no path traversal');
  a.close(); up.close(); setTimeout(() => process.exit(), 100);
})();
