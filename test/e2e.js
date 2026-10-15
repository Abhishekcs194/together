// End-to-end: browse → pick → each phone resolves its own debrid link → play, subtitles, next episode, fallbacks.
const W = require('ws');
const fs = require('fs');
const CDP = 'http://127.0.0.1:9333';
const OUT = require('path').join(__dirname, 'out', 'e2e');
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, msg, extra = '') => { console.log((c ? 'PASS ' : 'FAIL ') + msg + (c ? '' : `  ${extra}`)); if (!c) process.exitCode = 1; };

async function page(url, width, height, cdp = CDP) {
  const t = await (await fetch(`${cdp}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new W(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  let id = 0; const pending = new Map();
  ws.on('message', (d) => { const m = JSON.parse(d); if (pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  const call = (method, params) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
  await call('Page.navigate', { url });
  await wait(1200);
  const run = async (e) => {
    const r = await call('Runtime.evaluate', { expression: `(async () => { ${e} })()`, awaitPromise: true, returnByValue: true });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r?.result?.value;
  };
  const until = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run(`return !!(${expr})`)) return true; await wait(250); } return false; };
  const shot = async (name) => { await call('Page.bringToFront'); await wait(400); fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64')); };
  return { run, until, shot, close: () => fetch(`${cdp}/json/close/${t.id}`) };
}

(async () => {
  const room = 'e2e' + Date.now().toString(36);
  const a = await page(`http://localhost:3123/r/${room}`, 390, 844);
  const b = await page(`http://127.0.0.1:3123/r/${room}`, 390, 844, 'http://127.0.0.1:9334');
  await a.run(`$('#nameInput').value='Abhi'; $('#joinBtn').click();`);
  await b.run(`$('#nameInput').value='Riya'; $('#joinBtn').click();`);
  await a.until(`$('#presenceText').textContent === 'Riya is here'`);

  // --- Setup: opening browse with no addon lands on Setup
  await a.run(`$('#emptyLoadBtn').click();`);
  ok(await a.run(`return !$('#view-setup').hidden`), 'no addon yet → browse opens on Setup');
  await a.shot('1-setup');
  ok((await a.run(`return normalizeAddonUrl('stremio://torrentio.strem.fun/realdebrid=KEY/manifest.json')`)) === 'https://torrentio.strem.fun/realdebrid=KEY', 'stremio:// copy-link format understood');
  await a.run(`$('#addonInput').value='http://localhost:3130/userA/manifest.json'; $('#addonForm').requestSubmit();`);
  ok(await a.until(`!$('#view-search').hidden`), 'addon connected through Setup → Search');
  ok((await a.run(`return Addon.name`)) === 'Torrentio RD (userA)', 'addon name stored');
  await b.run(`localStorage.setItem('tg.addon','http://localhost:3130/userB'); localStorage.setItem('tg.addonName','Torrentio RD (userB)');`);

  // --- Search (real Cinemeta)
  await a.run(`$('#searchInput').value='before sunrise'; $('#searchForm').requestSubmit();`);
  ok(await a.until(`document.querySelectorAll('#results .card-item').length > 3`), 'real catalogue search shows results');
  await a.until(`[...document.querySelectorAll('#results img')].every(i => i.complete)`, 6000);
  await a.shot('2-search');
  await a.run(`[...document.querySelectorAll('#results .card-item')].find(c => c.textContent.includes('Before Sunrise') && c.textContent.includes('1995')).click();`);
  ok(await a.until(`document.querySelectorAll('#view-streams .stream').length === 3`), 'streams listed for the movie');
  const order = await a.run(`return [...document.querySelectorAll('#view-streams .stream .q')].map(q => q.textContent).join(',')`);
  ok(order === '1080p,4k HDR,720p', 'AAC+cached first; uncached bad-audio last', order);
  ok(await a.run(`return $('#view-streams').textContent.includes('DTS-HD · may be silent')`), 'DTS stream flagged as possibly silent', await a.run(`return $('#view-streams').textContent.slice(0,400)`));
  await a.shot('3-streams');
  await a.run(`document.querySelector('#view-streams .stream').click();`);
  ok(await a.until(`state?.title === 'Before Sunrise (1995)'`), 'picking a stream loads it for the room');

  // --- Each phone streams through its own account
  ok(await a.until(`video.src.includes('/userAKEY/')`), "his phone plays his own link");
  ok(await b.until(`video.src.includes('/userBKEY/')`, 10000), "her phone resolved the same file through HER account", await b.run(`return video.src`));
  const sameFile = await a.run(`return video.src.split('/')[6]`) === await b.run(`return video.src.split('/')[6]`);
  ok(sameFile, 'both phones play the same torrent hash');
  ok((await b.run(`return $('#toast').textContent`)).includes('your own'), 'she is told it streams from her own account');

  // --- Play waits for the slower phone
  await b.run(`$('#browse').open && $('#browse').close();`);
  const rid = await a.run(`return roomId`);
  // load a different movie, press play immediately while B (slow addon) is still resolving
  await a.run(`send({t:'load', url:'http://localhost:3125/resolve/realdebrid/userAKEY/${'f'.repeat(40)}/null/0/x.mp4', title:'Hold test', proxy:false, source:{type:'movie', id:'tt0381681', infoHash:'${'f'.repeat(40)}', fileIdx:0, filename:'x.mp4'}});`);
  await wait(300);
  await a.run(`control('play', 5);`);
  await wait(500);
  const held = await a.run(`return { paused: state.paused, auto: state.autoPaused, notice: $('#notice').textContent }`);
  ok(held.paused && held.auto && /Riya/.test(held.notice), 'play is held while her phone is still loading', JSON.stringify(held));
  // B has no file with that hash in its addon → falls back to his link and says so
  ok(await b.until(`$('#toast').textContent.includes('doesn’t have this exact file')`, 8000), 'when her addon lacks the file she falls back to his link, with a notice');
  ok(await a.until(`!state.paused`, 10000), 'playback starts by itself once both are ready');
  await wait(2000);
  const drift = Math.abs(await a.run(`return video.currentTime - expected()`)) + Math.abs(await b.run(`return video.currentTime - expected()`));
  ok(drift < 0.6, `both playing in sync (combined drift ${drift.toFixed(2)}s)`);

  // --- Subtitles (real OpenSubtitles addon; Before Sunset tt0381681)
  ok(await b.until(`!$('#ccBtn').hidden`, 10000), 'subtitles button appears when subtitles exist');
  await b.run(`$('#ccBtn').click();`);
  await b.until(`document.querySelectorAll('#subFiles .row-btn').length > 0`, 5000);
  await b.shot('4-subs');
  await b.run(`[...document.querySelectorAll('#subLangs .pill')].find(p => p.textContent === 'English')?.click(); await new Promise(r=>setTimeout(r,200)); document.querySelector('#subFiles .row-btn').click();`);
  ok(await b.until(`[...video.textTracks].some(t => t.mode === 'showing' && t.cues?.length > 50)`, 10000), 'English subtitles load as cues on her phone');
  const first = await b.run(`return [...video.textTracks].find(t => t.mode==='showing').cues[0].startTime`);
  await b.run(`$('#subLater').click();`);
  const after = await b.run(`return [...video.textTracks].find(t => t.mode==='showing').cues[0].startTime`);
  ok(Math.abs(after - first - 0.5) < 0.01, 'timing nudge shifts subtitles by 0.5s');
  ok(!(await a.run(`return [...video.textTracks].some(t => t.mode === 'showing')`)), 'his phone is unaffected (subtitles are per person)');
  await b.run(`$('#subsDialog').close();`);

  // --- Series + next episode (real Cinemeta metadata)
  await a.run(`openLoad(); $('.tabs [data-tab=search]').click(); $('#searchInput').value='breaking bad'; $('#searchForm').requestSubmit();`);
  await a.until(`document.querySelectorAll('#results .card-item').length > 0`);
  await a.run(`[...document.querySelectorAll('#results .card-item')].find(c => c.textContent.includes('Breaking Bad') && c.textContent.includes('Series')).click();`);
  ok(await a.until(`document.querySelectorAll('#view-series .row-btn').length >= 7`), 'season 1 episodes listed');
  await a.shot('5-episodes');
  await a.run(`document.querySelector('#view-series .row-btn').click();`);
  await a.until(`document.querySelectorAll('#view-streams .stream').length === 3`);
  await a.run(`document.querySelector('#view-streams .stream').click();`);
  ok(await a.until(`state?.source?.id === 'tt0903747:1:1' && !$('#nextBtn').hidden`), 'episode loads; Next episode button shown');
  await b.until(`video.src.includes('/userBKEY/')`, 8000);
  await a.run(`$('#nextBtn').click();`);
  ok(await a.until(`state?.source?.id === 'tt0903747:1:2'`, 10000), 'Next episode loads S1E2');
  ok((await a.run(`return state.source.bingeGroup`)) === 'torrentio|1080p|WEB-DL|h264', 'next episode keeps the same release group');
  ok((await a.run(`return state.title`)).startsWith('Breaking Bad · S1E2'), 'next episode title', await a.run(`return state.title`));

  // --- Her phone without an addon: plays his link with a warning
  await b.run(`Addon.disconnect();`);
  await a.run(`$('#nextBtn').click();`);
  await a.until(`state?.source?.id === 'tt0903747:1:3'`, 10000);
  ok(await b.until(`video.src.includes('/userAKEY/')`, 6000), 'without her own addon she plays his link');
  ok((await b.run(`return $('#toast').textContent`)).includes('keep their account safe'), 'and is warned about account sharing');

  await a.run(`wake();`); await b.run(`wake();`);
  await a.shot('6-playing');
  await a.close(); await b.close();
  process.exit();
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
