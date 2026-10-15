'use strict';
// Catalogue (Stremio's Cinemeta) + streams from this phone's own Stremio addon (e.g. Torrentio with debrid).
// Everything is fetched by the phone itself: Torrentio blocks cloud servers, and each person should
// stream through their own debrid account from their own IP.

const CINEMETA = 'https://v3-cinemeta.strem.io';

async function getJson(url, ms = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'timed out' : err.message);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- the phone's addon ----------
const Addon = {
  get base() { return store.get('tg.addon', ''); },
  get name() { return store.get('tg.addonName', ''); },
  async connect(input) {
    const base = normalizeAddonUrl(input);
    const manifest = await getJson(`${base}/manifest.json`).catch((err) => { throw new Error(`Couldn’t reach that addon (${err.message})`); });
    const hasStreams = (manifest.resources || []).some((r) => r === 'stream' || r?.name === 'stream');
    if (!hasStreams) throw new Error('That addon doesn’t provide streams.');
    store.set('tg.addon', base);
    store.set('tg.addonName', manifest.name || 'Addon');
    ownCache.clear();
    return manifest;
  },
  disconnect() {
    store.set('tg.addon', '');
    store.set('tg.addonName', '');
    ownCache.clear();
  },
};

// Accepts what Torrentio's "Copy link" gives (https://…/manifest.json or stremio://…/manifest.json).
function normalizeAddonUrl(input) {
  let u = String(input || '').trim().replace(/^stremio:\/\//i, 'https://');
  u = u.replace(/\/manifest\.json.*$/i, '').replace(/\/configure\/?$/i, '').replace(/\/+$/, '');
  const localDev = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(`${u}/`);
  if (!/^https:\/\/[^/]+/i.test(u) && !localDev) throw new Error('Paste the full link that starts with https:// or stremio://');
  return u;
}

// ---------- catalogue ----------
async function searchCatalog(query) {
  const q = encodeURIComponent(query.trim());
  const [movies, series] = await Promise.allSettled([
    getJson(`${CINEMETA}/catalog/movie/top/search=${q}.json`),
    getJson(`${CINEMETA}/catalog/series/top/search=${q}.json`),
  ]);
  if (movies.status === 'rejected' && series.status === 'rejected') throw new Error(`Search failed (${movies.reason.message})`);
  const pick = (r, type) => (r.status === 'fulfilled' ? r.value.metas || [] : []).map((m) => ({ ...m, type }));
  // Interleave so the best match of either kind shows up first.
  const a = pick(movies, 'movie'), b = pick(series, 'series'), out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]) out.push(a[i]);
    if (b[i]) out.push(b[i]);
  }
  return out.filter((m) => /^tt\d+$/.test(m.id));
}

async function seriesMeta(imdbId) {
  const { meta } = await getJson(`${CINEMETA}/meta/series/${imdbId}.json`);
  const videos = (meta.videos || [])
    .filter((v) => Number.isInteger(v.season) && Number.isInteger(v.number ?? v.episode))
    .map((v) => ({ season: v.season, episode: v.number ?? v.episode, name: v.name || v.title || '', released: v.released || v.firstAired || '' }))
    .sort((x, y) => (x.season || 999) - (y.season || 999) || x.episode - y.episode); // specials (season 0) last
  return { ...meta, videos };
}

async function fetchStreams(type, id, base = Addon.base) {
  if (!base) throw new Error('No addon connected');
  const { streams = [] } = await getJson(`${base}/stream/${type}/${id}.json`, 30000).catch((err) => {
    throw new Error(`Torrentio didn’t answer (${err.message}). Try again in a moment.`);
  });
  return streams;
}

// ---------- reading a stream ----------
const hashOf = (s) => (s.infoHash || (s.url || '').match(/\b[a-f0-9]{40}\b/i)?.[0] || '').toLowerCase();
const fileIdxOf = (s) => (Number.isInteger(s.fileIdx) ? s.fileIdx : Number((s.url || '').match(/\/[a-f0-9]{40}\/[^/]+\/(\d+)\//i)?.[1] ?? NaN));

// Browsers silently drop these audio formats, so the movie plays with no sound.
const BAD_AUDIO = /\b(DTS(?:[-. ]?(?:HD|X|ES|MA))?|TRUE-?HD|ATMOS|DDP(?:\s?\d\.\d)?|DD\+|E-?AC-?3|AC-?3|DD[\s.]?[1-7]\.[01]|DOLBY ?DIGITAL)\b/i;
const GOOD_AUDIO = /\b(AAC(?:[\s.]?\d\.\d)?|OPUS|MP3)\b|\bYTS\b|\[YTS/i;

function describeStream(s) {
  const nameLines = (s.name || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const titleLines = (s.title || s.description || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const filename = s.behaviorHints?.filename || '';
  const text = [s.name, s.title, s.description, filename].join(' ');
  const metaLine = titleLines.find((l) => /💾|👤|⚙️/.test(l)) || '';
  const debridTag = (s.name || '').match(/\[([A-Z]{2,3})(\+| download)\]/);
  return {
    quality: (nameLines[1] || nameLines[0] || '').replace(/torrentio/i, '').trim() || '—',
    label: titleLines.find((l) => l !== metaLine) || filename || 'Stream',
    size: metaLine.match(/💾\s*([\d.,]+\s*[KMGT]B)/)?.[1] || '',
    seeds: metaLine.match(/👤\s*(\d+)/)?.[1] || '',
    site: metaLine.match(/⚙️\s*(.+)$/)?.[1]?.trim() || '',
    cached: debridTag ? debridTag[2] === '+' : null,
    service: debridTag?.[1] || '',
    audio: BAD_AUDIO.test(text) ? 'bad' : GOOD_AUDIO.test(text) ? 'ok' : 'unknown',
    audioName: text.match(BAD_AUDIO)?.[1]?.toUpperCase() || '',
    hevc: /\b(HEVC|[xh]\.?265)\b/i.test(text),
    av1: /\bAV1\b/i.test(text),
    hdr: /\b(HDR(10\+?)?|DV|DoVi|Dolby ?Vision)\b/i.test(text),
    playable: !!s.url,
  };
}

// Streams likely to play with sound in a phone browser go first; otherwise keep the addon's order.
function rankStreams(streams) {
  const score = (d) => (d.playable ? 0 : 100) + (d.audio === 'ok' ? 0 : d.audio === 'unknown' ? 1 : 3) + (d.av1 ? 2 : 0) + (d.cached === false ? 4 : 0);
  return streams
    .map((s, i) => ({ s, d: describeStream(s), i }))
    .sort((x, y) => score(x.d) - score(y.d) || x.i - y.i);
}

// What we tell the room about a picked stream, so the other phone can find the same file.
function sourceOf(stream, ctx) {
  return {
    type: ctx.type,
    id: ctx.id,
    infoHash: hashOf(stream),
    fileIdx: Number.isFinite(fileIdxOf(stream)) ? fileIdxOf(stream) : null,
    filename: stream.behaviorHints?.filename || '',
    bingeGroup: stream.behaviorHints?.bingeGroup || '',
    poster: ctx.poster || '',
  };
}

// Find the same file through this phone's own addon/debrid account.
const ownCache = new Map();
async function resolveOwn(src) {
  const base = Addon.base;
  if (!base || !src?.id) return null;
  const key = `${base}|${src.id}|${src.infoHash}|${src.filename}`;
  if (!ownCache.has(key)) {
    ownCache.set(key, (async () => {
      const streams = (await fetchStreams(src.type, src.id, base)).filter((s) => s.url);
      const sameHash = src.infoHash ? streams.filter((s) => hashOf(s) === src.infoHash) : [];
      const match =
        sameHash.find((s) => src.fileIdx == null || fileIdxOf(s) === src.fileIdx || !Number.isFinite(fileIdxOf(s))) ||
        sameHash[0] ||
        (src.filename && streams.find((s) => s.behaviorHints?.filename === src.filename));
      return match?.url || null;
    })().catch((err) => { ownCache.delete(key); throw err; }));
  }
  return ownCache.get(key);
}

// Next episode, preferring the same release group (same quality/encoder), like Stremio's binge-watching.
async function nextEpisode(src) {
  const [imdb, season, episode] = src.id.split(':');
  const meta = await seriesMeta(imdb);
  const eps = meta.videos.filter((v) => v.season > 0);
  const i = eps.findIndex((v) => v.season === Number(season) && v.episode === Number(episode));
  const next = i >= 0 ? eps[i + 1] : null;
  if (!next) return { meta, next: null };
  const id = `${imdb}:${next.season}:${next.episode}`;
  const streams = await fetchStreams('series', id);
  const same = src.bingeGroup && streams.find((s) => s.url && s.behaviorHints?.bingeGroup === src.bingeGroup);
  return { meta, next, id, stream: same || null };
}

function episodeTitle(metaName, v) {
  return `${metaName} · S${v.season}E${v.episode}${v.name ? ` · ${v.name}` : ''}`;
}
