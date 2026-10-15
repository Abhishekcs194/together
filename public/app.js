'use strict';
const $ = (s) => document.querySelector(s);

// ---------- small helpers ----------
const store = {
  get(k, d = null) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
function randomId(bytes = 12) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function fmt(t) {
  if (!Number.isFinite(t)) t = 0;
  t = Math.floor(t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
}
let toastTimer;
function toast(text, ms = 2600) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

const clientId = store.get('tg.id') || (() => { const id = randomId(); store.set('tg.id', id); return id; })();
const video = $('#video');

// ---------- routing: /, /r/<room>, /share?url=… ----------
let roomId = null;
const path = location.pathname;
if (path.startsWith('/r/')) roomId = path.slice(3).replace(/[^\w-]/g, '');
if (path === '/share') {
  // Android share sheet → our app. Find a link in whatever was shared.
  const q = new URLSearchParams(location.search);
  const found = [q.get('url'), q.get('text'), q.get('title')].join(' ').match(/https?:\/\/\S+/);
  if (found) store.set('tg.pending', found[0]);
  roomId = store.get('tg.lastRoom');
}

$('#nameInput').value = store.get('tg.name', '');
if (roomId) $('#joinBtn').textContent = 'Join the room';

$('#homeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#nameInput').value.trim();
  if (!name) return;
  store.set('tg.name', name);
  const code = $('#codeInput').value.trim();
  if (code) roomId = code.replace(/^.*\/r\//, '').replace(/[^\w-]/g, '');
  if (!roomId) roomId = (await (await fetch('/api/new-room')).json()).id;
  history.replaceState(null, '', `/r/${roomId}`);
  store.set('tg.lastRoom', roomId);
  enterRoom(name);
});

// ---------- connection ----------
let ws, myName, retry = 0, leaving = false, joined = false;
let state = null, holds = [], peers = [];
let clockOffset = 0, bestRtt = Infinity;
const serverNow = () => Date.now() + clockOffset;

function enterRoom(name) {
  myName = name;
  $('#home').hidden = true;
  $('#room').hidden = false;
  connect();
  setInterval(tick, 1000);
  setInterval(ping, 10000);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?room=${roomId}&id=${clientId}&name=${encodeURIComponent(myName)}`);
  ws.onopen = () => { retry = 0; for (let i = 0; i < 4; i++) setTimeout(ping, i * 400); };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = (e) => {
    if (e.code === 4001 || leaving) return;
    setPresence();
    $('#presenceText').textContent = 'Reconnecting…';
    setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
  };
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && joined && ws?.readyState === WebSocket.CLOSED) { retry = 0; connect(); }
});

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function ping() { send({ t: 'ping', c: Date.now() }); }

function onMessage(m) {
  switch (m.t) {
    case 'welcome':
      joined = true;
      peers = m.peers;
      setPresence();
      if (!$('#messages').children.length) m.history.forEach((h) => addChat(h, true));
      holds = m.holds;
      applyState(m.state, null);
      maybeLoadPending();
      break;
    case 'full':
      leaving = true;
      alertScreen('This room already has two people in it.');
      break;
    case 'pong': {
      const now = Date.now(), rtt = now - m.c;
      if (rtt <= bestRtt * 1.5) { // keep the most trustworthy (lowest-latency) samples
        bestRtt = Math.min(bestRtt, rtt);
        clockOffset = m.s + rtt / 2 - now;
      }
      break;
    }
    case 'peers': {
      const hadPartner = !!partner();
      peers = m.peers;
      setPresence();
      if (m.joined && m.joined !== myName) sysChat(`${m.joined} joined`);
      if (m.left) {
        sysChat(`${m.left} left`);
        if (hadPartner && !partner()) endCall(false);
      }
      break;
    }
    case 'state': {
      holds = m.holds;
      const prev = state;
      applyState(m.state, m.by);
      if (m.by && m.by !== clientId) describeChange(prev, m.state, m.by);
      break;
    }
    case 'holds': holds = m.holds; showNotice(); break;
    case 'chat': addChat(m); break;
    case 'react': floatEmoji(m.emoji); navigator.vibrate?.(25); break;
    case 'rtc': onRtc(m).catch((err) => console.warn('rtc', err)); break;
    case 'call': onCallSignal(m); break;
    case 'playerError': toast(`${m.from}’s player: ${m.message}`, 6000); break;
    case 'error': toast(m.message); break;
  }
}

function partner() { return peers.find((p) => p.id !== clientId); }
function nameOfId(id) { return peers.find((p) => p.id === id)?.name || 'Your partner'; }

function setPresence() {
  const p = partner();
  const online = ws?.readyState === WebSocket.OPEN;
  $('#presenceDot').classList.toggle('on', !!p && online);
  $('#presenceText').textContent = p ? `${p.name} is here` : 'Waiting for your partner · tap to invite';
}

$('#inviteBtn').addEventListener('click', async () => {
  const link = `${location.origin}/r/${roomId}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'Watch with me', url: link }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(link); toast('Invite link copied'); } catch { prompt('Invite link', link); }
});

function alertScreen(text) {
  $('#room').hidden = true;
  $('#home').hidden = false;
  $('#homeForm').hidden = true;
  $('.brand p').textContent = text;
}

// ---------- playback sync ----------
let lastHardSeek = 0, buffering = false, bufTimer, autoplayBlocked = false, loadedUrl = '';

function expected() {
  if (!state) return 0;
  const t = state.paused ? state.pos : state.pos + (serverNow() - state.at) / 1000;
  return video.duration ? Math.min(t, video.duration - 0.05) : t;
}

function applyState(s, by) {
  const prev = state;
  state = s;
  if (s.url + s.proxy !== loadedUrl) {
    loadedUrl = s.url + s.proxy;
    noAudioWarned = false;
    loadSource(s);
    document.title = s.title ? `${s.title} · Together` : 'Together';
    $('#nowTitle').textContent = s.title || '';
    setupMediaSession();
    Subs.load(s.source);
  }
  $('#empty').hidden = !!s.url;
  $('#nextBtn').hidden = s.source?.type !== 'series';
  updatePlayIcon();
  showNotice();
  sync(prev?.seq !== s.seq);
  keepAwake(!s.paused);
}

// Work out what this phone should actually play. If it has its own addon, fetch the same file through
// its own debrid account; otherwise play the link the other person picked.
let sourceSeq = 0;
async function loadSource(s) {
  const seq = ++sourceSeq;
  video.removeAttribute('src');
  video.load();
  buffering = false; // the server forgets everyone's buffering state when a new video loads
  if (!s.url) return;
  setBuffering(true, true); // hold playback for both until this phone has the video ready
  let src = s.url, how = 'direct';
  if (s.proxy) {
    src = `/stream/${roomId}?v=${s.seq}`;
  } else if (s.loadedById === clientId) {
    how = 'mine';
  } else if (s.source && Addon.base) {
    showNotice('Getting the same file from your own account…');
    try {
      const own = await resolveOwn(s.source);
      if (own) { src = own; how = 'own'; } else how = 'notfound';
    } catch {
      how = 'notfound';
    }
  } else if (s.source || /\/resolve\/|real-debrid|alldebrid|premiumize|debrid-link|torbox/i.test(s.url)) {
    how = 'shared';
  }
  if (seq !== sourceSeq) return;
  showNotice();
  const picked = s.loadedById !== clientId ? `${s.loadedBy} picked ${s.title || 'something'}. ` : '';
  if (how === 'own') toast(`${picked}Streaming from your own ${Addon.name || 'addon'}`, 4000);
  else if (how === 'notfound') toast(`${picked}Your addon doesn’t have this exact file, so this phone is playing ${s.loadedBy}’s link instead`, 6000);
  else if (how === 'shared') toast(`${picked}Playing ${s.loadedBy}’s debrid link. Connect your own Torrentio in Setup to keep their account safe.`, 7000);
  else if (picked) toast(picked.trim());
  video.src = src;
  video.load();
}

function sync(force) {
  if (!state?.url || video.readyState < 1 || video.seeking) return;
  const target = expected();
  const drift = video.currentTime - target;
  if (state.paused) {
    if (!video.paused) video.pause();
    video.playbackRate = 1;
    if (Math.abs(drift) > 0.25) video.currentTime = target;
    return;
  }
  if (video.duration && target >= video.duration - 0.3) { // the movie is over; don't restart it
    if (!video.paused && !video.ended) video.pause();
    video.playbackRate = 1;
    return;
  }
  const now = performance.now();
  if (Math.abs(drift) > 1.5 || (force && Math.abs(drift) > 0.5)) {
    if (force || now - lastHardSeek > 3000) {
      lastHardSeek = now;
      video.currentTime = target;
    }
    video.playbackRate = 1;
  } else if (Math.abs(drift) > 0.15) {
    video.playbackRate = drift > 0 ? 0.94 : 1.06; // nudge gently instead of jumping
  } else {
    video.playbackRate = 1;
  }
  if (video.paused) {
    video.play().then(() => { autoplayBlocked = false; $('#tapSync').hidden = true; }).catch((err) => {
      if (err.name === 'NotAllowedError') { autoplayBlocked = true; $('#tapSync').hidden = false; }
    });
  }
}

$('#tapSync').addEventListener('click', () => {
  $('#tapSync').hidden = true;
  autoplayBlocked = false;
  sync(true);
});

function tick() {
  sync(false);
  if (buffering && video.readyState >= 3) setBuffering(false);
  updateTime();
  checkAudio();
}

function setBuffering(on, loading = false) {
  clearTimeout(bufTimer);
  if (on === buffering) return;
  buffering = on;
  send({ t: 'buffering', on, loading });
}
video.addEventListener('waiting', () => {
  clearTimeout(bufTimer);
  bufTimer = setTimeout(() => {
    if (state && !state.paused && video.readyState < 3) setBuffering(true);
  }, 700);
});
for (const ev of ['canplay', 'playing']) video.addEventListener(ev, () => setBuffering(false));
video.addEventListener('loadedmetadata', () => { $('#seek').max = video.duration || 0; sync(true); });
video.addEventListener('seeked', () => sync(false));
video.addEventListener('error', () => {
  if (!state?.url || !video.getAttribute('src')) return;
  setBuffering(false);
  const code = video.error?.code;
  const msg = code === 4
    ? 'this phone can’t play this file. Pick another stream (MP4, H.264, AAC are safest).'
    : 'the stream failed to load. The link may have expired. Load it again.';
  toast(`Couldn’t play: ${msg}`, 7000);
  send({ t: 'playerError', message: msg });
});

// Browsers silently skip AC3/DTS/EAC3 audio tracks. Catch that, since a silent movie is the worst failure.
let noAudioWarned = false, playingSince = 0;
video.addEventListener('playing', () => { playingSince = performance.now(); });
function checkAudio() {
  if (noAudioWarned || video.paused || !('webkitAudioDecodedByteCount' in video)) return;
  if (performance.now() - playingSince > 5000 && video.currentTime > 3 && video.webkitAudioDecodedByteCount === 0) {
    noAudioWarned = true;
    const msg = 'no sound: this stream’s audio format isn’t supported in the browser (usually AC3/DTS). Pick a stream with AAC audio.';
    toast(`Heads up: ${msg}`, 9000);
    send({ t: 'playerError', message: msg });
  }
}

function describeChange(prev, s, by) {
  const who = nameOfId(by);
  if (!prev || prev.url !== s.url) return; // loadSource() announces new videos
  if (s.autoPaused || prev.autoPaused) return;
  if (prev.paused !== s.paused) return toast(s.paused ? `${who} paused` : `${who} pressed play`);
  if (Math.abs(prev.pos - s.pos) > 2 || prev.paused === s.paused) toast(`${who} jumped to ${fmt(s.pos)}`);
}

let noticeText = '';
function showNotice(text) {
  if (text !== undefined) noticeText = text;
  const el = $('#notice');
  const others = holds.filter((n) => n !== myName);
  if (noticeText) {
    el.textContent = noticeText;
    el.hidden = false;
  } else if (state?.autoPaused && holds.length) {
    el.textContent = others.length ? `Waiting for ${others.join(', ')} to buffer…` : 'Buffering…';
    el.hidden = false;
  } else el.hidden = true;
}

// ---------- controls (custom, so we always know a change came from a person) ----------
function control(action, pos) {
  pos = Math.max(0, Math.min(pos, (video.duration || Infinity) - 0.05));
  send({ t: 'ctl', action, pos });
  // Apply right away so it feels instant; the server echo confirms it.
  const patch = action === 'seek' ? { pos } : { paused: action === 'pause', pos, autoPaused: false };
  applyState({ ...state, ...patch, at: serverNow() }, clientId);
  sync(true);
}

$('#playBtn').addEventListener('click', () => {
  if (!state?.url) return openLoad();
  control(state.paused ? 'play' : 'pause', video.currentTime);
});
$('#back10').addEventListener('click', () => state?.url && control('seek', expected() - 10));
$('#fwd10').addEventListener('click', () => state?.url && control('seek', expected() + 10));
let scrubbing = false;
$('#seek').addEventListener('input', () => { scrubbing = true; updateTime(Number($('#seek').value)); });
$('#seek').addEventListener('change', () => { scrubbing = false; control('seek', Number($('#seek').value)); });

function updatePlayIcon() {
  const playing = state && !state.paused;
  $('#playIcon').setAttribute('d', playing ? 'M6 4h4v16H6zM14 4h4v16h-4z' : 'M7 4l13 8-13 8z');
  $('#playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
}
function updateTime(at) {
  const t = at ?? video.currentTime;
  if (!scrubbing) $('#seek').value = t;
  $('#time').textContent = `${fmt(t)} / ${fmt(video.duration)}`;
}

// Hide controls while the movie plays; tap the picture to bring them back.
let idleTimer;
function wake() {
  $('#stage').classList.remove('idle');
  $('#room').classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (state && !state.paused && !scrubbing) { $('#stage').classList.add('idle'); $('#room').classList.add('idle'); }
  }, 3500);
}
$('#stage').addEventListener('pointerdown', wake);
video.addEventListener('play', wake);

$('#fsBtn').addEventListener('click', async () => {
  if (document.fullscreenElement) return document.exitFullscreen();
  const room = $('#room');
  try {
    if (room.requestFullscreen) await room.requestFullscreen({ navigationUI: 'hide' });
    else return video.webkitEnterFullscreen?.(); // iPhone: only the video itself can go fullscreen
    await screen.orientation?.lock?.('landscape').catch(() => {});
  } catch {}
});
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) screen.orientation?.unlock?.();
  layoutForOrientation();
});

// Landscape: movie fills the screen and chat becomes a toggleable side panel.
const landscape = matchMedia('(orientation: landscape) and (max-height: 600px)');
function layoutForOrientation() {
  $('#chatToggle').hidden = !landscape.matches;
  if (!landscape.matches) $('#room').classList.remove('chat-open');
}
landscape.addEventListener('change', layoutForOrientation);
layoutForOrientation();
$('#chatToggle').addEventListener('click', () => {
  $('#room').classList.toggle('chat-open');
  $('#unread').hidden = true;
});

$('#nextBtn').addEventListener('click', async () => {
  const src = state?.source;
  if (src?.type !== 'series') return;
  if (!Addon.base) return toast('Connect your Torrentio in Setup to pick episodes');
  toast('Finding the next episode…');
  try {
    const { meta, next, id, stream } = await nextEpisode(src);
    if (!next) return toast('That was the last episode');
    if (stream) return send({ t: 'load', url: stream.url, title: episodeTitle(meta.name, next), proxy: false, source: sourceOf(stream, { type: 'series', id, poster: meta.poster }) });
    // No stream from the same release; let them choose.
    Browse.open('search');
    Browse.openStreams({ type: 'series', id, title: episodeTitle(meta.name, next), poster: meta.poster });
  } catch (err) {
    toast(err.message);
  }
});

// Keep the screen on during the movie.
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock?.request('screen');
      wakeLock?.addEventListener('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => keepAwake(state && !state.paused));

// Lock-screen / headset buttons control playback for both of you.
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const poster = state?.source?.poster;
  navigator.mediaSession.metadata = new MediaMetadata({ title: state?.title || 'Together', artist: 'Watching together', artwork: poster ? [{ src: poster }] : [] });
  navigator.mediaSession.setActionHandler('play', () => state?.url && control('play', video.currentTime));
  navigator.mediaSession.setActionHandler('pause', () => state?.url && control('pause', video.currentTime));
}

// ---------- loading a movie ----------
function openLoad(prefill = '') {
  if (prefill) {
    $('#urlInput').value = prefill;
    $('#titleInput').value = '';
    return Browse.open('paste');
  }
  Browse.open();
}
$('#loadBtn').addEventListener('click', () => openLoad());
$('#emptyLoadBtn').addEventListener('click', () => openLoad());
$('#urlInput').addEventListener('input', checkUrl);

function checkUrl() {
  const warn = $('#urlWarn');
  let host = '';
  try { host = new URL($('#urlInput').value).hostname; } catch {}
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    warn.textContent = 'This link points at your own phone (Stremio’s local server), so your partner can’t open it. Use a debrid stream link instead.';
    warn.hidden = false;
  } else warn.hidden = true;
}

$('#loadForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('#urlInput').value.trim();
  let title = $('#titleInput').value.trim();
  if (!title) {
    try { title = decodeURIComponent(new URL(url).pathname.split('/').pop()).replace(/\.\w{2,4}$/, '').replace(/[._]+/g, ' '); } catch {}
  }
  send({ t: 'load', url, title, proxy: $('#proxyInput').checked });
  store.set('tg.proxy', $('#proxyInput').checked ? '1' : '0');
  $('#urlInput').value = '';
  $('#browse').close();
});
$('#proxyInput').checked = store.get('tg.proxy', '0') === '1';

function maybeLoadPending() {
  const pending = store.get('tg.pending');
  if (!pending) return;
  store.set('tg.pending', '');
  openLoad(pending);
}

// ---------- chat & reactions ----------
function addChat(m, fromHistory = false) {
  const li = document.createElement('li');
  li.textContent = m.text;
  if (m.fromId === clientId) li.className = 'mine';
  pushMessage(li);
  if (!fromHistory && m.fromId !== clientId && landscape.matches && !$('#room').classList.contains('chat-open')) {
    $('#unread').hidden = false;
    toast(`${m.from}: ${m.text}`, 3500);
  }
}
function sysChat(text) {
  const li = document.createElement('li');
  li.className = 'sys';
  li.textContent = text;
  pushMessage(li);
}
function pushMessage(li) {
  const list = $('#messages');
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  list.append(li);
  if (nearBottom) list.scrollTop = list.scrollHeight;
}
$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#chatInput').value.trim();
  if (!text) return;
  send({ t: 'chat', text });
  $('#chatInput').value = '';
});
$('#reactions').addEventListener('click', (e) => {
  const emoji = e.target.closest('button')?.textContent;
  if (!emoji) return;
  floatEmoji(emoji);
  send({ t: 'react', emoji });
});
function floatEmoji(emoji) {
  const el = document.createElement('span');
  el.className = 'floater';
  el.textContent = emoji;
  el.style.left = `${10 + Math.random() * 75}%`;
  $('#floaters').append(el);
  setTimeout(() => el.remove(), 2700);
}

// ---------- voice / video call (WebRTC, phone to phone) ----------
let pcPromise = null, pc = null, localStream = null, camSender = null, makingOffer = false, ignoreOffer = false, iceCache = null;

async function getPc() {
  if (pcPromise) return pcPromise;
  pcPromise = (async () => {
    iceCache ??= (await (await fetch('/api/ice')).json()).iceServers;
    pc = new RTCPeerConnection({ iceServers: iceCache });
    pc.onicecandidate = ({ candidate }) => candidate && send({ t: 'rtc', candidate });
    pc.onnegotiationneeded = async () => {
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        send({ t: 'rtc', description: pc.localDescription });
      } catch (err) { console.warn(err); } finally { makingOffer = false; }
    };
    pc.ontrack = ({ track, streams }) => {
      const pv = $('#partnerVideo');
      pv.srcObject = streams[0] || new MediaStream([track]);
      pv.play().catch(() => {});
      track.onmute = track.onunmute = track.onended = updateBubble;
      showBubble();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce();
      if (pc.connectionState === 'connected') updateBubble();
    };
    return pc;
  })();
  return pcPromise;
}

// "Perfect negotiation": either side can add or remove media without the offers colliding.
const polite = () => clientId < (partner()?.id || '');
async function onRtc({ description, candidate }) {
  const pc = await getPc();
  if (description) {
    const collision = description.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
    ignoreOffer = !polite() && collision;
    if (ignoreOffer) return;
    await pc.setRemoteDescription(description);
    if (description.type === 'offer') {
      await pc.setLocalDescription();
      send({ t: 'rtc', description: pc.localDescription });
    }
  } else if (candidate) {
    try { await pc.addIceCandidate(candidate); } catch (err) { if (!ignoreOffer) console.warn(err); }
  }
}

async function startCall() {
  if (!partner()) return toast('Your partner needs to be in the room first');
  if (localStream) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      // Small, low-frame-rate camera so the call never competes with the movie for bandwidth.
      video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 640 }, frameRate: { ideal: 20, max: 24 } },
    });
  } catch {
    try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {
      return toast('Microphone permission is needed for the call');
    }
  }
  const pc = await getPc();
  for (const track of localStream.getTracks()) {
    const sender = pc.addTrack(track, localStream);
    if (track.kind === 'video') camSender = sender;
  }
  $('#selfVideo').srcObject = localStream;
  $('#selfVideo').hidden = !localStream.getVideoTracks().length;
  $('#callbar').hidden = false;
  $('#callBtn').classList.add('on');
  setToggle('#micBtn', true);
  setToggle('#camBtn', !!localStream.getVideoTracks().length);
  send({ t: 'call', action: 'start' });
  showBubble();
}

function endCall(notify = true) {
  if (notify) send({ t: 'call', action: 'end' });
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  camSender = null;
  pc?.close();
  pc = null;
  pcPromise = null;
  makingOffer = ignoreOffer = false;
  $('#partnerVideo').srcObject = null;
  $('#selfVideo').srcObject = null;
  $('#bubble').hidden = true;
  $('#callbar').hidden = true;
  $('#callBtn').classList.remove('on');
}

let callPromptShown = false, partnerCamOff = false;
function onCallSignal(m) {
  if (m.action === 'start') partnerCamOff = false;
  if (m.action === 'start' && !localStream) {
    if (callPromptShown) return;
    callPromptShown = true;
    toast(`${nameOfId(m.fromId)} started a call · tap the camera button to join`, 6000);
    $('#callBtn').classList.add('on');
    navigator.vibrate?.([60, 80, 60]);
    setTimeout(() => (callPromptShown = false), 6000);
  } else if (m.action === 'cam') {
    partnerCamOff = !m.on;
    updateBubble();
  } else if (m.action === 'end') {
    if (pc || localStream) toast(`${nameOfId(m.fromId)} ended the call`);
    endCall(false);
  }
}

$('#callBtn').addEventListener('click', () => (localStream ? endCall() : startCall()));
$('#hangBtn').addEventListener('click', () => endCall());
$('#micBtn').addEventListener('click', () => {
  const t = localStream?.getAudioTracks()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  setToggle('#micBtn', t.enabled);
});
$('#camBtn').addEventListener('click', () => {
  const t = localStream?.getVideoTracks()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  setToggle('#camBtn', t.enabled);
  $('#selfVideo').hidden = !t.enabled;
  // Stop sending video entirely (saves bandwidth for the movie) and tell the other phone.
  camSender?.replaceTrack(t.enabled ? t : null);
  send({ t: 'call', action: 'cam', on: t.enabled });
});
function setToggle(sel, on) {
  $(sel).classList.toggle('off', !on);
}

function showBubble() {
  $('#partnerInitial').textContent = (partner()?.name || '?').slice(0, 1).toUpperCase();
  $('#bubble').hidden = false;
  updateBubble();
}
function updateBubble() {
  const s = $('#partnerVideo').srcObject;
  const live = !partnerCamOff && s?.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted);
  $('#bubble').classList.toggle('novideo', !live);
}

// Drag the bubble anywhere; a quick tap toggles its size.
(() => {
  const b = $('#bubble');
  let start = null;
  b.addEventListener('pointerdown', (e) => {
    const r = b.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, moved: false };
    b.setPointerCapture(e.pointerId);
  });
  b.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) start.moved = true;
    if (!start.moved) return;
    const left = Math.min(Math.max(0, start.left + dx), innerWidth - b.offsetWidth);
    const top = Math.min(Math.max(0, start.top + dy), innerHeight - b.offsetHeight);
    Object.assign(b.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
  });
  b.addEventListener('pointerup', () => {
    if (start && !start.moved) b.classList.toggle('large');
    start = null;
  });
})();

// ---------- install / share target ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
