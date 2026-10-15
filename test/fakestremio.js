// Test-only stand-in for api.strem.io + link.stremio.com, same request/response shapes.
const http = require('http');
const users = {}; // authKey -> user
const links = {}; // code -> { polls, key }
const mf = (name, base, extra = {}) => ({ transportUrl: `${base}/manifest.json`, transportName: 'http', flags: {}, manifest: { id: name, name, version: '1.0.0', resources: ['stream'], types: ['movie', 'series'], idPrefixes: ['tt'], catalogs: [], ...extra } });
const collection = (who) => [
  { transportUrl: 'https://v3-cinemeta.strem.io/manifest.json', flags: { official: true, protected: true }, manifest: { id: 'com.linvo.cinemeta', name: 'Cinemeta', resources: ['catalog', 'meta', 'addon_catalog'], types: ['movie', 'series'], idPrefixes: ['tt'],
    catalogs: [{ type: 'movie', id: 'top', name: 'Popular', extra: [{ name: 'search' }, { name: 'skip' }] }, { type: 'movie', id: 'year', name: 'New', extraRequired: ['genre'], extra: [{ name: 'genre', isRequired: true }] }, { type: 'series', id: 'top', name: 'Popular', extra: [{ name: 'skip' }] }] } },
  mf(`Torrentio RD (${who})`, `http://localhost:3130/${who}`),
  { transportUrl: 'http://127.0.0.1:11470/local-addon/manifest.json', manifest: { id: 'local', name: 'Local Files', resources: ['stream'], types: ['movie'] } }, // only works inside Stremio; must be skipped? (http localhost is allowed for dev — 127.0.0.1:11470 nothing listens)
  { transportUrl: 'https://opensubtitles-v3.strem.io/manifest.json', manifest: { id: 'os', name: 'OpenSubtitles v3', resources: ['subtitles'], types: ['movie', 'series'] } },
];
const now = Date.now();
const library = [
  { _id: 'tt0112471', type: 'movie', name: 'Before Sunrise', poster: 'https://images.metahub.space/poster/medium/tt0112471/img', removed: false, temp: false, _mtime: new Date(now - 86400e3).toISOString(), state: { lastWatched: new Date(now - 3600e3).toISOString(), timeOffset: 60000, duration: 120000, video_id: 'tt0112471' } },
  { _id: 'tt0903747', type: 'series', name: 'Breaking Bad', poster: 'https://images.metahub.space/poster/medium/tt0903747/img', removed: false, temp: false, _mtime: new Date(now - 2 * 86400e3).toISOString(), state: { lastWatched: new Date(now - 60e3).toISOString(), timeOffset: 40000, duration: 100000, video_id: 'tt0903747:1:3' } },
  { _id: 'tt0381681', type: 'movie', name: 'Before Sunset', poster: 'https://images.metahub.space/poster/medium/tt0381681/img', removed: false, temp: false, _mtime: new Date(now).toISOString(), state: { timeOffset: 0, duration: 0 } },
  { _id: 'tt9999999', type: 'movie', name: 'Removed one', removed: true, temp: false, state: {} },
];
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.end();
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/link/create') { const code = Math.random().toString(36).slice(2, 6).toUpperCase(); links[code] = { polls: 0 }; return send({ success: true, code, link: `https://link.stremio.com/${code}`, result: { success: true, code, link: `https://link.stremio.com/${code}` } }); }
    if (url.pathname === '/link/read') {
      const l = links[url.searchParams.get('code')];
      if (!l || ++l.polls < 3) return send({ result: null, error: { code: 101, message: 'Invalid or expired token' } }); // pending
      const key = 'key-abhi'; users[key] = { email: 'abhi@example.com', who: 'userA' };
      return send({ result: { authKey: key } });
    }
    const m = url.pathname.match(/^\/api\/(\w+)$/);
    const b = body ? JSON.parse(body) : {};
    if (!m) { res.writeHead(404); return res.end(); }
    const u = users[b.authKey];
    switch (m[1]) {
      case 'login':
        if (b.password !== 'pw-ok') return send({ error: { code: 3, message: 'Wrong passphrase', wrongPass: true } });
        users['key-riya'] = { email: b.email, who: 'userB' };
        return send({ result: { authKey: 'key-riya', user: { email: b.email } } });
      case 'getUser': return u ? send({ result: { email: u.email } }) : send({ error: { code: 1, message: 'Session does not exist' } });
      case 'addonCollectionGet': return u ? send({ result: { addons: collection(u.who), lastModified: new Date().toISOString() } }) : send({ error: { code: 1, message: 'Session does not exist' } });
      case 'datastoreGet': return u ? send({ result: library }) : send({ error: { code: 1, message: 'Session does not exist' } });
      case 'logout': delete users[b.authKey]; return send({ result: { success: true } });
    }
    send({ error: { code: 0, message: 'unknown' } });
  });
}).listen(3131);
