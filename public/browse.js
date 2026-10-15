'use strict';
// The "Find something to watch" sheet: Search → (Seasons/Episodes) → Streams, plus Paste link and Setup tabs.

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
  return n;
};

const Browse = (() => {
  const dlg = $('#browse');
  const stack = []; // view history for the back button
  let searchSeq = 0;

  function show(view, title, push = true) {
    const currentView = [...dlg.querySelectorAll('.view')].find((v) => !v.hidden)?.id;
    if (push && currentView && currentView !== `view-${view}`) stack.push({ view: currentView.slice(5), title: $('#browseTitle').textContent });
    for (const v of dlg.querySelectorAll('.view')) v.hidden = v.id !== `view-${view}`;
    $('#browseTitle').textContent = title;
    $('#browseBack').hidden = !stack.length;
    for (const t of dlg.querySelectorAll('.tabs button')) t.classList.toggle('on', t.dataset.tab === view);
    $('.tabs').hidden = !['search', 'paste', 'setup'].includes(view);
  }
  function tab(view) {
    stack.length = 0;
    const titles = { search: 'Find something to watch', paste: 'Paste a link', setup: 'Setup' };
    show(view, titles[view], false);
    if (view === 'setup') renderSetup();
    if (view === 'paste') preparePaste();
    if (view === 'search') setTimeout(() => $('#searchInput').focus(), 50);
  }

  function open(view = Addon.base ? 'search' : 'setup') {
    if (!dlg.open) dlg.showModal();
    tab(view);
  }

  $('#browseClose').addEventListener('click', () => dlg.close());
  $('#browseBack').addEventListener('click', () => {
    const prev = stack.pop();
    if (prev) show(prev.view, prev.title, false);
  });
  for (const t of dlg.querySelectorAll('.tabs button')) t.addEventListener('click', () => tab(t.dataset.tab));

  const status = (container, text, cls = 'muted') => container.replaceChildren(el('p', { class: `status ${cls}` }, text));

  // ---------- search ----------
  $('#searchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('#searchInput').value.trim();
    if (!q) return;
    $('#searchInput').blur();
    const seq = ++searchSeq;
    const box = $('#results');
    status(box, 'Searching…');
    try {
      const metas = await searchCatalog(q);
      if (seq !== searchSeq) return;
      if (!metas.length) return status(box, `Nothing found for “${q}”.`);
      box.replaceChildren(...metas.slice(0, 30).map(card));
    } catch (err) {
      status(box, err.message, 'warn');
    }
  });

  function card(m) {
    return el('button', { class: 'card-item', type: 'button', onclick: () => (m.type === 'series' ? openSeries(m) : openStreams({ type: 'movie', id: m.id, title: `${m.name}${m.releaseInfo ? ` (${m.releaseInfo})` : ''}`, poster: m.poster })) },
      el('div', { class: 'poster' }, m.poster ? el('img', { src: m.poster, alt: '', loading: 'lazy' }) : el('span', {}, m.name.slice(0, 1))),
      el('span', { class: 'card-title' }, m.name),
      el('span', { class: 'card-sub' }, [m.releaseInfo, m.type === 'series' ? 'Series' : 'Movie'].filter(Boolean).join(' · ')),
    );
  }

  // ---------- series ----------
  async function openSeries(m, focus) {
    show('series', m.name);
    const box = $('#view-series');
    status(box, 'Loading episodes…');
    try {
      const meta = await seriesMeta(m.id);
      const seasons = [...new Set(meta.videos.map((v) => v.season))];
      const start = focus?.season ?? store.get(`tg.season.${m.id}`, null) ?? seasons.find((s) => s > 0) ?? seasons[0];
      const pills = el('div', { class: 'pills' });
      const list = el('div', { class: 'list' });
      const pick = (season) => {
        store.set(`tg.season.${m.id}`, season);
        for (const p of pills.children) p.classList.toggle('on', Number(p.dataset.season) === season);
        list.replaceChildren(...meta.videos.filter((v) => v.season === season).map((v) =>
          el('button', { class: 'row-btn' + (focus && focus.season === v.season && focus.episode === v.episode ? ' on' : ''), type: 'button', onclick: () => openStreams({ type: 'series', id: `${m.id}:${v.season}:${v.episode}`, title: episodeTitle(meta.name, v), poster: meta.poster }) },
            el('span', {}, `${v.episode}. ${v.name || `Episode ${v.episode}`}`),
            v.released ? el('small', {}, new Date(v.released).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })) : null,
          )));
      };
      pills.append(...seasons.map((s) => el('button', { class: 'pill', type: 'button', 'data-season': s, onclick: () => pick(s) }, s === 0 ? 'Specials' : `Season ${s}`)));
      box.replaceChildren(pills, list);
      pick(Number(start));
      pills.querySelector('.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
    } catch (err) {
      status(box, `Couldn’t load episodes (${err.message})`, 'warn');
    }
  }

  // ---------- streams ----------
  async function openStreams(ctx) {
    show('streams', ctx.title);
    const box = $('#view-streams');
    if (!Addon.base) {
      return box.replaceChildren(el('div', { class: 'callout' },
        el('p', {}, 'To see streams, connect your Torrentio (with your debrid) in Setup. It takes a minute and stays on this phone.'),
        el('button', { class: 'primary', type: 'button', onclick: () => tab('setup') }, 'Open setup')));
    }
    status(box, `Asking ${Addon.name || 'your addon'}…`);
    try {
      const ranked = rankStreams(await fetchStreams(ctx.type, ctx.id));
      if (!ranked.length) return status(box, 'No streams found for this one.');
      const playable = ranked.filter((r) => r.d.playable);
      box.replaceChildren(
        ...[playable.length ? null : el('p', { class: 'status warn' }, 'These streams have no direct link. In Torrentio’s setup, pick your debrid service and paste its API key, then reconnect it here.'),
        el('p', { class: 'hint' }, 'Sorted so streams that play with sound in a browser come first.'),
        el('div', { class: 'list' }, ranked.map(({ s, d }) => streamRow(s, d, ctx)))].filter(Boolean),
      );
    } catch (err) {
      status(box, err.message, 'warn');
    }
  }

  function streamRow(s, d, ctx) {
    const chips = [
      d.cached === true && el('span', { class: 'chip-s good' }, `Cached ${d.service}`),
      d.cached === false && el('span', { class: 'chip-s' }, 'Not cached · slow start'),
      d.audio === 'ok' && el('span', { class: 'chip-s good' }, 'Sound OK'),
      d.audio === 'bad' && el('span', { class: 'chip-s bad' }, `${d.audioName || 'Audio'} · may be silent`),
      d.hevc && el('span', { class: 'chip-s' }, 'HEVC'),
      d.av1 && el('span', { class: 'chip-s bad' }, 'AV1'),
      d.hdr && el('span', { class: 'chip-s' }, 'HDR'),
    ];
    return el('button', { class: 'stream', type: 'button', disabled: !d.playable, onclick: () => pickStream(s, ctx) },
      el('span', { class: 'q' }, d.quality),
      el('span', { class: 'body' },
        el('span', { class: 'fname' }, d.label),
        el('span', { class: 'meta' }, [d.size && `💾 ${d.size}`, d.seeds && `👤 ${d.seeds}`, d.site].filter(Boolean).join('  ·  ')),
        el('span', { class: 'chips' }, chips)),
    );
  }

  function pickStream(s, ctx) {
    send({ t: 'load', url: s.url, title: ctx.title, proxy: false, source: sourceOf(s, ctx) });
    dlg.close();
  }

  // ---------- paste ----------
  function preparePaste() {
    checkUrl();
    if ($('#urlInput').value) return;
    navigator.clipboard?.readText?.().then((t) => {
      if (/^https?:\/\//.test(t.trim()) && !$('#urlInput').value) { $('#urlInput').value = t.trim(); checkUrl(); }
    }).catch(() => {});
  }

  // ---------- setup ----------
  function renderSetup() {
    const connected = !!Addon.base;
    $('#addonStatus').textContent = connected ? `Connected: ${Addon.name}` : 'Not connected yet';
    $('#addonStatus').className = connected ? 'ok-text' : 'muted';
    $('#addonRemove').hidden = !connected;
    $('#addonInput').value = '';
    $('#addonError').hidden = true;
  }
  $('#addonForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#addonSave');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      const m = await Addon.connect($('#addonInput').value);
      toast(`Connected ${m.name || 'addon'}`);
      tab('search');
    } catch (err) {
      $('#addonError').textContent = err.message;
      $('#addonError').hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
  });
  $('#addonRemove').addEventListener('click', () => { Addon.disconnect(); renderSetup(); toast('Disconnected'); });

  return { open, openSeries, openStreams, tab };
})();
