'use strict';
// Signing in to the person's own Stremio account, straight from the phone to Stremio's API.
// The auth key stays in this phone's storage; it is never sent to the Together server or the room.

const Stremio = (() => {
  // Overridable for local testing only.
  const API = store.get('tg.stremioApi', '') || 'https://api.strem.io/api';
  const LINK = store.get('tg.stremioLink', '') || 'https://link.stremio.com/api';

  async function call(method, body) {
    const r = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (data.error) {
      const err = new Error(data.error.message || 'Stremio said no');
      err.code = data.error.code;
      throw err;
    }
    if (!r.ok) throw new Error(`Stremio API error ${r.status}`);
    return data.result;
  }

  const authKey = () => store.get('tg.stremioKey', '');

  function saveSession(key, user) {
    store.set('tg.stremioKey', key);
    store.set('tg.stremioUser', user?.email || user?.fbId || 'Stremio account');
  }

  async function afterLogin(key, user) {
    if (!user) user = await call('getUser', { type: 'GetUser', authKey: key }).catch(() => null);
    saveSession(key, user);
    await refreshAddons();
    ownCache.clear();
  }

  // Only addons we can call from a browser and that give streams for IMDb ids (tt…).
  function streamAddons(collection) {
    return (collection || [])
      .filter((a) => usableAddonUrl(a.transportUrl) && !/:11470\//.test(a.transportUrl)) // skip Stremio's on-device server
      .filter((a) => (a.manifest?.resources || []).some((r) => {
        if (r === 'stream') return !a.manifest.idPrefixes || a.manifest.idPrefixes.some((p) => 'tt'.startsWith(p) || p.startsWith('tt'));
        if (r?.name !== 'stream') return false;
        const prefixes = r.idPrefixes || a.manifest.idPrefixes;
        return !prefixes || prefixes.some((p) => p.startsWith('tt') || 'tt'.startsWith(p));
      }))
      .map((a) => ({ name: a.manifest.name || 'Addon', base: a.transportUrl.replace(/\/manifest\.json.*$/i, '') }));
  }

  // Catalogues (rows like "Popular movies") that need no extra input and use IMDb ids.
  function catalogRows(collection) {
    const rows = [];
    for (const a of collection || []) {
      if (!usableAddonUrl(a.transportUrl)) continue;
      const base = a.transportUrl.replace(/\/manifest\.json.*$/i, '');
      for (const c of a.manifest?.catalogs || []) {
        if (!['movie', 'series'].includes(c.type)) continue;
        const extras = c.extra || [];
        if (extras.some((e) => e.isRequired) || (c.extraRequired || []).length) continue;
        rows.push({ title: `${c.name || c.id} · ${c.type === 'movie' ? 'Movies' : 'Series'}`, url: `${base}/catalog/${c.type}/${c.id}.json`, type: c.type, addon: a.manifest.name });
      }
    }
    return rows;
  }

  async function refreshAddons() {
    const result = await call('addonCollectionGet', { type: 'AddonCollectionGet', authKey: authKey(), update: true });
    const collection = result?.addons || [];
    store.set('tg.stremioAddons', JSON.stringify(streamAddons(collection)));
    store.set('tg.stremioRows', JSON.stringify(catalogRows(collection).slice(0, 8)));
    return collection;
  }

  const json = (k) => { try { return JSON.parse(store.get(k, '[]')) || []; } catch { return []; } };

  return {
    get signedIn() { return !!authKey(); },
    get user() { return store.get('tg.stremioUser', ''); },
    get addons() { return authKey() ? json('tg.stremioAddons') : []; },
    get rows() { return authKey() ? json('tg.stremioRows') : []; },

    async loginWithPassword(email, password) {
      const res = await call('login', { type: 'Login', email, password, facebook: false }).catch((err) => {
        throw new Error(err.code === 3 || /pass/i.test(err.message) ? 'Wrong email or password' : err.message);
      });
      await afterLogin(res.authKey, res.user);
    },

    // Same flow as Stremio's TV app: show a short link, the person approves it where they're signed in.
    async startLink() {
      const r = await fetch(`${LINK}/create?type=Create`);
      const data = await r.json();
      const res = data.result || data;
      if (!res?.code) throw new Error('Couldn’t get a sign-in code from Stremio');
      return { code: res.code, link: res.link || `https://link.stremio.com/${res.code}` };
    },
    // Resolves with true once approved; keeps waiting while the code is pending.
    async waitForLink(code, isCancelled, timeoutMs = 10 * 60 * 1000) {
      const t0 = Date.now();
      while (!isCancelled()) {
        if (Date.now() - t0 > timeoutMs) throw new Error('That code expired. Try again.');
        try {
          const r = await fetch(`${LINK}/read?type=Read&code=${encodeURIComponent(code)}`);
          const data = await r.json();
          const key = data.result?.authKey;
          if (key) {
            await afterLogin(key, data.result.user);
            return true;
          }
        } catch {}
        await new Promise((res) => setTimeout(res, 2500));
      }
      return false;
    },

    async signOut() {
      const key = authKey();
      for (const k of ['tg.stremioKey', 'tg.stremioUser', 'tg.stremioAddons', 'tg.stremioRows']) store.set(k, '');
      ownCache.clear();
      if (key) call('logout', { type: 'Logout', authKey: key }).catch(() => {});
    },

    refreshAddons: () => (authKey() ? refreshAddons().catch(() => null) : null),

    // Stremio's library: what's saved, and what's half-watched ("Continue watching").
    async library() {
      const items = await call('datastoreGet', { type: 'DatastoreGet', authKey: authKey(), collection: 'libraryItem', ids: [], all: true });
      const list = (Array.isArray(items) ? items : []).filter((i) => /^tt\d+$/.test(i._id) && ['movie', 'series'].includes(i.type));
      const lastWatched = (i) => Date.parse(i.state?.lastWatched || 0) || 0;
      const continueWatching = list
        .filter((i) => i.state?.timeOffset > 0 && (!i.removed || i.temp) && i.state?.duration && i.state.timeOffset < i.state.duration * 0.95)
        .sort((a, b) => lastWatched(b) - lastWatched(a));
      const saved = list.filter((i) => !i.removed && !i.temp).sort((a, b) => (Date.parse(b._mtime) || 0) - (Date.parse(a._mtime) || 0));
      return { continueWatching, saved };
    },
  };
})();
