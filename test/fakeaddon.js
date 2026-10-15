// Test-only stand-in for Torrentio+debrid: same response format, two "accounts" (/userA, /userB).
const http = require('http'), crypto = require('crypto');
const h = (s) => crypto.createHash('sha1').update(s).digest('hex');
http.createServer((req, res) => {
  const m = req.url.match(/^\/(user\w)\/(manifest\.json|stream\/(movie|series)\/([^/]+)\.json)$/);
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!m) { res.writeHead(404); return res.end(); }
  const [, user, what, type, rawId] = m;
  if (what === 'manifest.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ id: 'fake.torrentio', name: `Torrentio RD (${user})`, resources: ['stream'], types: ['movie', 'series'] })); }
  const id = decodeURIComponent(rawId);
  const mk = (n, name, title, group, file) => ({
    name, title, url: `http://localhost:3125/resolve/realdebrid/${user}KEY/${h(id + n)}/null/0/${file}`,
    behaviorHints: { bingeGroup: group, filename: file },
  });
  const streams = [
    mk(1, '[RD+] Torrentio\n4k HDR', 'Title 2160p BluRay HDR10 HEVC DTS-HD MA 7.1-GRP\n👤 31 💾 41.2 GB ⚙️ TorrentGalaxy', 'torrentio|4k|BluRay|hevc', 'title.2160p.mkv'),
    mk(2, '[RD download] Torrentio\n720p', 'Title 720p WEB x264 DD5.1\n👤 4 💾 900 MB ⚙️ 1337x', 'torrentio|720p|WEB|h264', 'title.720p.mkv'),
    mk(3, '[RD+] Torrentio\n1080p', 'Title.1080p.WEB-DL.AAC2.0.H.264-NTb\n👤 210 💾 2.3 GB ⚙️ ThePirateBay', 'torrentio|1080p|WEB-DL|h264', 'title.1080p.mp4'),
  ];
  // userB's account answers slowly, like a real addon on mobile data.
  setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ streams })); }, user === 'userB' ? 2500 : 300);
}).listen(3130);
