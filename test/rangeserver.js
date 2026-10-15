// Test-only: serves one video file with HTTP range support, like a debrid CDN.
const fs = require('fs'), http = require('http');
const file = process.argv[2], size = fs.statSync(file).size;
http.createServer((req, res) => {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (!m) { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size, 'Accept-Ranges': 'bytes' }); return fs.createReadStream(file).pipe(res); }
  const a = +m[1], b = m[2] ? +m[2] : size - 1;
  res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file, { start: a, end: b }).pipe(res);
}).listen(3125);
