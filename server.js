'use strict';
// Together — a two-person watch party. Each viewer streams the video directly
// (full quality); only play/pause/seek, chat and call signalling go through here.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_MEMBERS = 2;
const ROOM_TTL_MS = 12 * 60 * 60 * 1000; // forget empty rooms after 12h

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const ASSET_LINKS = [{
  relation: ['delegate_permission/common.handle_all_urls'],
  target: {
    namespace: 'android_app',
    package_name: 'io.github.abhishekcs194.together',
    sha256_cert_fingerprints: ['15:75:58:53:51:03:E5:E6:A6:43:1D:24:4A:0E:E6:41:91:7E:7B:ED:6F:83:2D:40:23:9C:2F:E0:BE:F2:19:D3'],
  },
}];

/** @type {Map<string, Room>} */
const rooms = new Map();

function newRoom(id) {
  return {
    id,
    members: new Map(), // clientId -> { ws, name }
    state: { url: '', title: '', proxy: false, source: null, loadedBy: '', loadedById: '', paused: true, pos: 0, at: Date.now(), seq: 0, autoPaused: false },
    holds: new Set(), // clientIds currently buffering
    history: [], // last chat messages
    emptySince: Date.now(),
  };
}

function getRoom(id) {
  let room = rooms.get(id);
  if (!room) rooms.set(id, (room = newRoom(id)));
  return room;
}

function expectedPos(s, now = Date.now()) {
  return s.paused ? s.pos : s.pos + (now - s.at) / 1000;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptId) {
  for (const [id, m] of room.members) if (id !== exceptId) send(m.ws, msg);
}

function peerList(room) {
  return [...room.members].map(([id, m]) => ({ id, name: m.name }));
}

function nameOf(room, id) {
  return room.members.get(id)?.name || 'Someone';
}

function setState(room, patch, by) {
  room.state = { ...room.state, ...patch, at: Date.now(), seq: room.state.seq + 1 };
  broadcast(room, { t: 'state', state: room.state, by, holds: holdNames(room) });
}

function holdNames(room) {
  return [...room.holds].map((id) => nameOf(room, id));
}

// When anyone is buffering, freeze playback for everyone; resume once all are ready.
function updateHolds(room, by) {
  const s = room.state;
  if (room.holds.size && !s.paused) {
    setState(room, { paused: true, pos: expectedPos(s), autoPaused: true }, by);
  } else if (!room.holds.size && s.paused && s.autoPaused) {
    setState(room, { paused: false, autoPaused: false }, by);
  } else {
    broadcast(room, { t: 'holds', holds: holdNames(room) });
  }
}

// What was picked from the catalogue, so each phone can fetch the same file from its own debrid account.
function cleanSource(src) {
  if (!src || typeof src !== 'object') return null;
  const str = (v, n = 200) => (v == null ? '' : String(v).slice(0, n));
  const id = str(src.id, 60);
  if (!/^tt\d+(:\d+:\d+)?$/.test(id)) return null;
  return {
    type: src.type === 'series' ? 'series' : 'movie',
    id,
    infoHash: /^[a-f0-9]{40}$/i.test(src.infoHash) ? src.infoHash.toLowerCase() : '',
    fileIdx: Number.isInteger(src.fileIdx) ? src.fileIdx : null,
    filename: str(src.filename, 300),
    bingeGroup: str(src.bingeGroup),
    poster: /^https:\/\//.test(src.poster) ? str(src.poster, 500) : '',
  };
}

function handle(ws, room, me, msg) {
  switch (msg.t) {
    case 'ping':
      return send(ws, { t: 'pong', c: msg.c, s: Date.now() });

    case 'load': {
      const url = String(msg.url || '').trim();
      if (!/^https?:\/\//i.test(url)) return send(ws, { t: 'error', message: 'That does not look like a stream link.' });
      room.holds.clear();
      return setState(room, {
        url,
        title: String(msg.title || '').slice(0, 200),
        proxy: !!msg.proxy,
        source: cleanSource(msg.source),
        loadedBy: nameOf(room, me),
        loadedById: me,
        paused: true,
        pos: 0,
        autoPaused: false,
      }, me);
    }

    case 'ctl': {
      const pos = Math.max(0, Number(msg.pos) || 0);
      // Someone is still loading: start automatically once everyone is ready.
      if (msg.action === 'play') return setState(room, { paused: !!room.holds.size, pos, autoPaused: !!room.holds.size }, me);
      if (msg.action === 'pause') return setState(room, { paused: true, pos, autoPaused: false }, me);
      if (msg.action === 'seek') return setState(room, { pos }, me);
      return;
    }

    case 'buffering':
      if (msg.on) room.holds.add(me);
      else room.holds.delete(me);
      return updateHolds(room, me);

    case 'chat': {
      const text = String(msg.text || '').slice(0, 1000).trim();
      if (!text) return;
      const entry = { t: 'chat', from: nameOf(room, me), fromId: me, text, ts: Date.now() };
      room.history.push(entry);
      if (room.history.length > 100) room.history.shift();
      return broadcast(room, entry);
    }

    case 'react':
      return broadcast(room, { t: 'react', emoji: String(msg.emoji || '').slice(0, 16), fromId: me });

    case 'rtc': // WebRTC signalling: relay to the other person
    case 'call':
      return broadcast(room, { ...msg, fromId: me }, me);

    case 'playerError':
      return broadcast(room, { t: 'playerError', from: nameOf(room, me), message: String(msg.message || '').slice(0, 300) }, me);
  }
}

// --- HTTP ---------------------------------------------------------------

async function iceServers() {
  const stun = { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] };
  const { CF_TURN_KEY_ID, CF_TURN_API_TOKEN, TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL } = process.env;
  if (CF_TURN_KEY_ID && CF_TURN_API_TOKEN) {
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${CF_TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }),
      });
      if (r.ok) {
        const data = await r.json();
        const list = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
        return [stun, ...list.filter(Boolean)];
      }
      console.error('Cloudflare TURN credentials failed:', r.status);
    } catch (err) {
      console.error('Cloudflare TURN credentials failed:', err.message);
    }
  }
  if (TURN_URLS) {
    return [stun, { urls: TURN_URLS.split(',').map((u) => u.trim()), username: TURN_USERNAME, credential: TURN_CREDENTIAL }];
  }
  return [stun];
}

// Streams the room's current video through this server, so the debrid service
// sees a single IP. Only the room's own URL can be fetched (not an open proxy).
async function proxy(req, res, roomId) {
  const room = rooms.get(roomId);
  if (!room?.state.url || !room.state.proxy) {
    res.writeHead(404).end();
    return;
  }
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  try {
    const headers = { 'User-Agent': 'Mozilla/5.0 Together' };
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(room.state.url, { headers, redirect: 'follow', signal: controller.signal });
    const out = {
      'Content-Type': upstream.headers.get('content-type') || 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };
    for (const h of ['content-length', 'content-range']) {
      const v = upstream.headers.get(h);
      if (v) out[h] = v;
    }
    res.writeHead(upstream.status, out);
    if (!upstream.body || req.method === 'HEAD') return res.end();
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
  } catch (err) {
    if (err.name !== 'AbortError') console.error('proxy:', err.message);
    if (!res.headersSent) res.writeHead(502).end();
    else res.destroy();
  }
}

function serveStatic(req, res, pathname) {
  // Room links (/r/abc) and the Android share target (/share) are the app shell.
  if (pathname === '/' || pathname.startsWith('/r/') || pathname === '/share') pathname = '/index.html';
  const file = path.join(PUBLIC, path.normalize(pathname));
  if (!file.startsWith(PUBLIC)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end('Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/api/ice') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ iceServers: await iceServers() }));
  }
  if (pathname === '/api/new-room') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ id: crypto.randomBytes(6).toString('base64url') }));
  }
  if (pathname === '/healthz') return res.writeHead(200).end('ok');
  if (pathname === '/.well-known/assetlinks.json') {
    // Lets the Android app (a Trusted Web Activity) open this site full-screen, without Chrome's URL bar.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(ASSET_LINKS));
  }
  const m = pathname.match(/^\/stream\/([\w-]{4,40})$/);
  if (m) return proxy(req, res, m[1]);
  serveStatic(req, res, pathname);
});

// --- WebSocket ----------------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://x').searchParams;
  const roomId = params.get('room') || '';
  const me = params.get('id') || '';
  const name = (params.get('name') || 'Guest').slice(0, 30);
  if (!/^[\w-]{4,40}$/.test(roomId) || !/^[\w-]{6,64}$/.test(me)) return ws.close(4000, 'bad request');

  const room = getRoom(roomId);
  // Same person reconnecting (e.g. phone came back from background): replace the old socket.
  const old = room.members.get(me);
  if (old) {
    old.replaced = true;
    old.ws.terminate();
  } else if (room.members.size >= MAX_MEMBERS) {
    send(ws, { t: 'full' });
    return ws.close(4001, 'room full');
  }

  const member = { ws, name };
  room.members.set(me, member);
  room.emptySince = 0;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  send(ws, { t: 'welcome', you: me, peers: peerList(room), state: room.state, holds: holdNames(room), history: room.history, now: Date.now() });
  broadcast(room, { t: 'peers', peers: peerList(room), joined: name }, me);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    handle(ws, room, me, msg);
  });

  ws.on('close', () => {
    if (room.members.get(me) !== member) return; // already replaced by a reconnect
    room.members.delete(me);
    if (room.holds.delete(me)) updateHolds(room, me);
    broadcast(room, { t: 'peers', peers: peerList(room), left: name });
    if (!room.members.size) room.emptySince = Date.now();
  });
});

// Drop dead sockets (phones that lost signal) and stale rooms.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) ws.terminate();
    else {
      ws.isAlive = false;
      ws.ping();
    }
  }
  const now = Date.now();
  for (const [id, room] of rooms) if (room.emptySince && now - room.emptySince > ROOM_TTL_MS) rooms.delete(id);
}, 15000);

server.listen(PORT, () => console.log(`Together listening on http://localhost:${PORT}`));
