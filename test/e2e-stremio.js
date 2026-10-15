// Stremio sign-in flows against the stand-in API: link code (his phone), email/password (her phone),
// addons from the account, Continue watching + resume, per-account streaming, sign-out.
const W = require('ws');
const fs = require('fs');
const OUT = require('path').join(__dirname, 'out', 'stremio');
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, msg, extra = '') => { console.log((c ? 'PASS ' : 'FAIL ') + msg + (c ? '' : `  ${extra}`)); if (!c) process.exitCode = 1; };
async function page(url, cdp) {
  const t = await (await fetch(`${cdp}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new W(t.webSocketDebuggerUrl); await new Promise((r) => ws.on('open', r));
  let id = 0; const pending = new Map(); const errors = [];
  ws.on('message', (d) => { const m = JSON.parse(d); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description?.split('\n')[0]); if (pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  const call = (method, params) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const nav = async (u) => { await call('Page.navigate', { url: u }); await wait(1300); };
  await nav(url);
  const run = async (e) => { const r = await call('Runtime.evaluate', { expression: `(async () => { ${e} })()`, awaitPromise: true, returnByValue: true }); if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r?.result?.value; };
  const until = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run(`return !!(${expr})`)) return true; await wait(250); } return false; };
  const shot = async (name) => { await call('Page.bringToFront'); await wait(400); fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64')); };
  return { run, until, shot, nav, errors, close: () => fetch(`${cdp}/json/close/${t.id}`) };
}
const fresh = `localStorage.clear(); localStorage.setItem('tg.stremioApi','http://localhost:3131/api'); localStorage.setItem('tg.stremioLink','http://localhost:3131/link');`;

(async () => {
  const room = 'st' + Date.now().toString(36);
  const a = await page(`http://localhost:3123/r/${room}`, 'http://127.0.0.1:9333');
  const b = await page(`http://127.0.0.1:3123/r/${room}`, 'http://127.0.0.1:9334');
  await a.run(fresh); await b.run(fresh);
  await a.nav(`http://localhost:3123/r/${room}`); await b.nav(`http://127.0.0.1:3123/r/${room}`);
  await a.run(`$('#nameInput').value='Abhi'; $('#joinBtn').click();`);
  await b.run(`$('#nameInput').value='Riya'; $('#joinBtn').click();`);
  await a.until(`$('#presenceText').textContent === 'Riya is here'`);

  // --- His phone: sign in with the link code
  await a.run(`$('#emptyLoadBtn').click();`);
  ok(await a.run(`return !$('#view-setup').hidden && !$('#acctSignedOut').hidden`), 'not signed in → browse opens on Account');
  await a.shot('1-account');
  await a.run(`$('#linkStart').click();`);
  ok(await a.until(`!$('#linkBox').hidden && $('#linkUrl').textContent.startsWith('link.stremio.com/')`), 'link code shown');
  await a.shot('2-link-code');
  ok(await a.until(`Stremio.signedIn && !$('#view-search').hidden`, 15000), 'approving the code signs him in and returns to Search');
  const addons = await a.run(`return Stremio.addons.map(x => x.name).join(', ')`);
  ok(addons === 'Torrentio RD (userA)', 'only real stream addons kept (no Cinemeta/subtitles/on-device server)', addons);
  ok((await a.run(`return Stremio.rows.map(r => r.title).join(' | ')`)) === 'Popular · Movies | Popular · Series', 'catalogue rows from his addons (required-filter ones skipped)', await a.run(`return Stremio.rows.map(r => r.title).join(' | ')`));

  // --- Home rows
  ok(await a.until(`[...document.querySelectorAll('.home-row h4')].map(h => h.textContent).join('|').startsWith('Continue watching|Your library')`), 'home shows Continue watching + Your library');
  ok(await a.until(`document.querySelectorAll('.home-row')[0]?.querySelectorAll('.card-item').length === 2`), 'continue watching has the 2 half-watched items');
  ok(await a.until(`document.querySelectorAll('.home-row')[1]?.querySelectorAll('.card-item').length === 3`), 'library has 3 saved items (removed one hidden)');
  ok(await a.until(`document.querySelectorAll('.home-row')[2]?.querySelectorAll('.card-item').length > 5`, 10000), 'popular row loaded from Cinemeta');
  await a.until(`[...document.querySelectorAll('.home-row img')].slice(0,6).every(i => i.complete)`, 6000);
  await a.shot('3-home');

  // --- Continue watching → resume
  await a.run(`document.querySelectorAll('.home-row')[0].querySelectorAll('.card-item')[1].click();`); // Before Sunrise (older lastWatched → second)
  ok(await a.until(`document.querySelectorAll('#view-streams .stream').length === 3`), 'streams from his account addon');
  await a.run(`document.querySelector('#view-streams .stream').click();`);
  ok(await a.until(`state?.source?.id === 'tt0112471' && Math.abs(state.pos - 60) < 0.5`), 'loads Before Sunrise at 1:00 (where he left off)', await a.run(`return JSON.stringify({id: state?.source?.id, pos: state?.pos})`));

  // --- Her phone: email/password
  await b.run(`openLoad();`);
  await b.run(`$('#pwLogin').open = true; $('#pwEmail').value='riya@example.com'; $('#pwPass').value='nope'; $('#pwForm').requestSubmit();`);
  ok(await b.until(`!$('#pwError').hidden && $('#pwError').textContent === 'Wrong email or password'`), 'wrong password → clear error');
  await b.shot('4-password-error');
  await b.run(`$('#pwPass').value='pw-ok'; $('#pwForm').requestSubmit();`);
  ok(await b.until(`Stremio.signedIn && Stremio.addons[0]?.name === 'Torrentio RD (userB)'`), 'her password sign-in brings HER addons');
  ok((await b.run(`return $('#pwPass').value`)) === '', 'password field cleared after sign-in');
  ok(!(await b.run(`return Object.keys(localStorage).some(k => /pass/i.test(k) || localStorage.getItem(k) === 'pw-ok')`)), 'password is not stored anywhere');
  await b.run(`$('#browse').close();`);

  // --- Next pick resolves through her own account
  await a.run(`openLoad(); $('.tabs [data-tab=search]').click();`);
  await a.until(`document.querySelectorAll('.home-row')[0]?.querySelectorAll('.card-item').length === 2`);
  await a.run(`document.querySelectorAll('.home-row')[0].querySelectorAll('.card-item')[0].click();`); // Breaking Bad → S1E3 focused
  ok(await a.until(`[...document.querySelectorAll('#view-series .row-btn.on')].some(r => r.textContent.startsWith('3.'))`), 'series opens on the episode he was on (S1E3)');
  await a.run(`[...document.querySelectorAll('#view-series .row-btn')].find(r => r.textContent.startsWith('3.')).click();`);
  await a.until(`document.querySelectorAll('#view-streams .stream').length === 3`);
  await a.run(`document.querySelector('#view-streams .stream').click();`);
  ok(await a.until(`state?.source?.id === 'tt0903747:1:3' && Math.abs(state.pos - 40) < 0.5`), 'episode resumes at 0:40');
  ok(await b.until(`video.src.includes('/userBKEY/')`, 10000), 'her phone streams it through her own account', await b.run(`return video.src`));
  ok((await b.run(`return $('#toast').textContent`)).includes('your own Stremio addons'), 'she is told it uses her own Stremio addons', await b.run(`return $('#toast').textContent`));

  // --- Sign out
  await b.run(`openLoad(); $('.tabs [data-tab=setup]').click(); $('#acctSignOut').click();`);
  ok(await b.until(`!Stremio.signedIn && !hasSources() && !localStorage.getItem('tg.stremioKey')`), 'sign out removes the key and addons from her phone');
  ok(!(await a.run(`return JSON.stringify(state)`)).includes('key-'), 'no Stremio auth key ever appears in room state');
  ok(a.errors.length === 0 && b.errors.length === 0, 'no page errors', JSON.stringify([...a.errors, ...b.errors]));
  await a.close(); await b.close(); process.exit();
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
