'use strict';
// Subtitles from Stremio's OpenSubtitles addon, chosen per person (not synced: each of you picks your own).

const SUBS_ADDON = 'https://opensubtitles-v3.strem.io';
const LANG_NAMES = {
  eng: 'English', fre: 'French', fra: 'French', ger: 'German', deu: 'German', spa: 'Spanish', ita: 'Italian',
  por: 'Portuguese', pob: 'Portuguese (BR)', dut: 'Dutch', nld: 'Dutch', hin: 'Hindi', ara: 'Arabic', tur: 'Turkish',
  rus: 'Russian', chi: 'Chinese', zho: 'Chinese', zht: 'Chinese (Trad.)', jpn: 'Japanese', kor: 'Korean', pol: 'Polish',
  swe: 'Swedish', nor: 'Norwegian', dan: 'Danish', fin: 'Finnish', gre: 'Greek', ell: 'Greek', heb: 'Hebrew',
  hun: 'Hungarian', cze: 'Czech', ces: 'Czech', rum: 'Romanian', ron: 'Romanian', bul: 'Bulgarian', srp: 'Serbian',
  hrv: 'Croatian', slv: 'Slovenian', ukr: 'Ukrainian', vie: 'Vietnamese', tha: 'Thai', ind: 'Indonesian',
  may: 'Malay', msa: 'Malay', per: 'Persian', fas: 'Persian', ben: 'Bengali', tam: 'Tamil', tel: 'Telugu', urd: 'Urdu',
  est: 'Estonian', lit: 'Lithuanian', lav: 'Latvian', slo: 'Slovak', slk: 'Slovak', ice: 'Icelandic', isl: 'Icelandic',
  cat: 'Catalan', glg: 'Galician', baq: 'Basque', eus: 'Basque', mac: 'Macedonian', mkd: 'Macedonian', alb: 'Albanian',
  sqi: 'Albanian', bos: 'Bosnian', arm: 'Armenian', hye: 'Armenian', geo: 'Georgian', kat: 'Georgian', mal: 'Malayalam',
  kan: 'Kannada', mar: 'Marathi', guj: 'Gujarati', pan: 'Punjabi', nep: 'Nepali', sin: 'Sinhala', khm: 'Khmer',
  bur: 'Burmese', mya: 'Burmese', tgl: 'Tagalog', fil: 'Filipino', swa: 'Swahili', afr: 'Afrikaans', epo: 'Esperanto',
  spn: 'Spanish (LatAm)', ea: 'Spanish (LatAm)', pb: 'Portuguese (BR)', ze: 'Chinese (bilingual)', mne: 'Montenegrin',
};
const langName = (code) => LANG_NAMES[code] || (code || '?').toUpperCase();

const Subs = (() => {
  let list = [], current = null, cues = [], offset = 0, forId = '', track = null;

  function srtTime(t) {
    const m = t.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0').slice(0, 3)) / 1000 : NaN;
  }
  function parseSrt(text) {
    const out = [];
    for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
      const lines = block.split('\n');
      const i = lines.findIndex((l) => l.includes('-->'));
      if (i < 0) continue;
      const [a, b] = lines[i].split('-->');
      const start = srtTime(a), end = srtTime(b);
      // Keep simple formatting; drop tags browsers would show literally ({\an8}, <font>).
      const body = lines.slice(i + 1).join('\n').replace(/\{\\[^}]*\}/g, '').replace(/<\/?font[^>]*>/gi, '').trim();
      if (Number.isFinite(start) && Number.isFinite(end) && body) out.push({ start, end, text: body });
    }
    return out;
  }

  function ensureTrack() {
    if (!track) track = video.addTextTrack('subtitles', 'Subtitles', 'und');
    return track;
  }
  function render() {
    const t = ensureTrack();
    for (const c of [...(t.cues || [])]) t.removeCue(c);
    if (!current) { t.mode = 'disabled'; return; }
    for (const c of cues) t.addCue(new VTTCue(Math.max(0, c.start + offset), Math.max(0, c.end + offset), c.text));
    t.mode = 'showing';
  }

  return {
    get list() { return list; },
    get current() { return current; },
    get offset() { return offset; },
    langs() {
      const pref = store.get('tg.subLang', 'eng');
      const codes = [...new Set(list.map((s) => s.lang))];
      return codes.sort((a, b) => (b === pref) - (a === pref) || (b === 'eng') - (a === 'eng') || langName(a).localeCompare(langName(b)));
    },
    async load(source) {
      const id = source?.id || '';
      if (id === forId) return;
      forId = id; list = []; current = null; cues = []; offset = 0;
      render();
      if (!id) return;
      try {
        const data = await getJson(`${SUBS_ADDON}/subtitles/${source.type}/${id}.json`);
        if (forId !== id) return;
        list = (data.subtitles || []).filter((s) => /^https:\/\//.test(s.url));
        const pref = store.get('tg.subLang', '');
        const auto = pref && pref !== 'off' && list.find((s) => s.lang === pref);
        if (auto) await this.choose(auto, true);
      } catch {}
      updateCcButton();
    },
    async choose(sub, quiet = false) {
      try {
        const r = await fetch(sub.url);
        if (!r.ok) throw new Error();
        cues = parseSrt(await r.text());
        current = sub;
        store.set('tg.subLang', sub.lang);
        render();
        if (!quiet) toast(`${langName(sub.lang)} subtitles on`);
      } catch {
        toast('Couldn’t load those subtitles, try another');
      }
      updateCcButton();
    },
    off() {
      current = null;
      store.set('tg.subLang', 'off');
      render();
      updateCcButton();
    },
    nudge(delta) {
      offset = Math.round((offset + delta) * 10) / 10;
      render();
    },
  };
})();

// ---------- subtitle picker ----------
function updateCcButton() {
  const btn = $('#ccBtn');
  btn.hidden = !Subs.list.length;
  btn.classList.toggle('on', !!Subs.current);
}

function openSubs() {
  renderSubs(Subs.current?.lang || Subs.langs()[0]);
  $('#subsDialog').showModal();
}

function renderSubs(lang) {
  const langsEl = $('#subLangs');
  langsEl.replaceChildren(
    ...[['off', 'Off'], ...Subs.langs().map((c) => [c, langName(c)])].map(([code, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      // Filled = what's showing now; outlined = the language whose files are listed below.
      const showing = code === 'off' ? !Subs.current : Subs.current?.lang === code;
      b.className = 'pill' + (showing ? ' on' : code === lang ? ' sel' : '');
      b.textContent = label;
      b.onclick = () => (code === 'off' ? (Subs.off(), renderSubs(null)) : renderSubs(code));
      return b;
    }),
  );
  const files = lang ? Subs.list.filter((s) => s.lang === lang).slice(0, 8) : [];
  $('#subFiles').replaceChildren(
    ...files.map((s, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'row-btn' + (Subs.current?.id === s.id ? ' on' : '');
      b.textContent = `Option ${i + 1}`;
      const small = document.createElement('small');
      small.textContent = s.subtitleFileName || '';
      b.append(small);
      b.onclick = async () => { await Subs.choose(s); renderSubs(lang); };
      return b;
    }),
  );
  $('#subOffset').textContent = `${Subs.offset > 0 ? '+' : ''}${Subs.offset.toFixed(1)}s`;
}

$('#ccBtn').addEventListener('click', openSubs);
$('#subsClose').addEventListener('click', () => $('#subsDialog').close());
$('#subEarlier').addEventListener('click', () => { Subs.nudge(-0.5); $('#subOffset').textContent = `${Subs.offset > 0 ? '+' : ''}${Subs.offset.toFixed(1)}s`; });
$('#subLater').addEventListener('click', () => { Subs.nudge(0.5); $('#subOffset').textContent = `${Subs.offset > 0 ? '+' : ''}${Subs.offset.toFixed(1)}s`; });
