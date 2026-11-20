// L'écran « Entraînements » VU dans une Mia de test, sans GPU : le faux outil (MIA_TRAIN_FAKE=1) fait vivre de
// vrais entraînements, l'outil pilote la fenêtre par CDP, contrôle ce qui est affiché (textes, boutons, états,
// navigation de retour, rien qui déborde, rien de Windows) en français puis en anglais, et garde les captures à
// 1280, 1635 et 1920 px de large : la liste, le brouillon, l'instrument en cours, un essai en cours, la pause, la
// fin, une erreur — plus l'attente du chargement, l'arrêt et sa confirmation, une erreur écrite par l'outil lui-même.
// Il relit aussi l'ordre et les heures d'ÉVÈNEMENTS, la taille des dossiers, les vignettes produites par le faux
// outil (sombres, nuancées, différentes) et la bande des essais (pas de tuile coupée).
//
//   node tools/check-train-screen.mjs <port CDP> [--out <dossier>] [--lang fr,en] [--no-shots]
//
// À lancer UNIQUEMENT sur une Mia de test :
//   MIA_HEADLESS=1  MIA_NO_GPU=1  MIA_TRAIN_FAKE=1  MIA_USERDATA=<dossier neuf>  MIA_PROJECTS_ROOT=<dossier neuf>
//   node_modules\electron\dist\electron.exe . --remote-debugging-port=<port>
// L'outil refuse une Mia dont les données sont celles de tous les jours, et une Mia sans faux outil. Il crée des
// entraînements dans <userData>\training et n'en supprime aucun (rien ne va à la corbeille de Windows) : un dossier
// de données neuf à chaque passage. Le même entraînement long traverse le changement de langue (la fenêtre se
// recharge, l'entraînement continue dans le processus principal) : c'est aussi le cas « rechargement de la fenêtre ».
// Code de sortie : 0 tout est bon, 1 des contrôles en échec, 2 l'outil n'a pas pu travailler.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const port = Number(args.find((a) => /^\d+$/.test(a)));
if (!Number.isInteger(port) || port <= 0) {
  console.error('usage : node tools/check-train-screen.mjs <port CDP> [--out <dossier>] [--lang fr,en] [--no-shots]');
  process.exit(2);
}
const OUT = path.resolve(opt('--out', path.join(ROOT, '_dev', 'captures-train')));
const LANGS = [...new Set(opt('--lang', 'fr,en').split(',').map((s) => s.trim()).filter((l) => l === 'fr' || l === 'en'))];
const SHOTS = !args.includes('--no-shots');
const SIZES = [[1280, 800], [1635, 920], [1920, 1080]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => JSON.stringify(v);
const log = (...a) => console.log(...a);

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; return true; }
  failures.push(name);
  console.log(`  ÉCHEC  ${name}${detail !== undefined ? `\n         ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  return false;
}

// ── images du jeu : des PNG fabriqués ici, sans dépendance ───────────────
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(w, h, px) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) { const [r, g, b] = px(x / w, y / h); raw.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3); }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** Relit un PNG 8 bits (gris ou RVB, sans entrelacement, filtres ligne à ligne) → { w, h, ch, rows } ; null sinon. */
function readPng(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  if (buf.length < 33 || buf.readUInt32BE(12) !== 0x49484452) return null;
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20), depth = buf[24], type = buf[25], lace = buf[28];
  const ch = type === 2 ? 3 : type === 0 ? 1 : 0;
  if (depth !== 8 || !ch || lace) return null;
  const idat = [];
  for (let p = 8; p + 8 <= buf.length;) {
    const len = buf.readUInt32BE(p), kind = buf.toString('latin1', p + 4, p + 8);
    if (kind === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const rows = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
      line[x] = (line[x] + pred) & 0xff;
    }
    rows.push(line);
    prev = line;
  }
  return { w, h, ch, rows };
}
/** Luminance moyenne, écart type et maximum (0…255) d'une image relue par readPng. */
function lumaStats({ w, h, ch, rows }) {
  let sum = 0, sq = 0, max = 0;
  for (const line of rows) for (let x = 0; x < w; x++) {
    const l = ch === 3 ? 0.2126 * line[x * 3] + 0.7152 * line[x * 3 + 1] + 0.0722 * line[x * 3 + 2] : line[x];
    sum += l; sq += l * l; if (l > max) max = l;
  }
  const n = w * h, mean = sum / n;
  return { w, h, mean: Math.round(mean), std: Math.round(Math.sqrt(Math.max(0, sq / n - mean * mean))), max: Math.round(max) };
}
/** Un faux portrait : un fond sombre, une tache claire, une teinte par image (sobre, pour que les captures se lisent). */
function portrait(k) {
  const hue = (k * 47) % 360;
  const cx = 0.35 + ((k * 13) % 30) / 100;
  const cy = 0.38 + ((k * 7) % 20) / 100;
  return (x, y) => {
    const d = Math.hypot(x - cx, (y - cy) * 1.25);
    const l = Math.max(0, 1 - d * 2.2);
    const base = 22 + 26 * y;
    const t = (o) => Math.round(Math.min(255, base + l * (120 + 70 * Math.cos(((hue + o) * Math.PI) / 180))));
    return [t(0), t(120), t(240)];
  };
}
function makeSet(dir, { n, captions = n, small = 0, tiny = 0, other = 0, prefix = 'rosa' }) {
  fs.mkdirSync(dir, { recursive: true });
  const scenes = ['seated by a window, soft light', 'walking in the rain at night', 'close-up, looking away', 'in a kitchen, morning light', 'on a train, reflections on the glass',
    'in a field at dusk', 'reading at a desk, lamp light', 'laughing, outdoors, backlit'];
  const off = [...prefix].reduce((a, c) => a + c.charCodeAt(0), 0) % 13;      // chaque jeu a ses teintes (les vignettes de la liste diffèrent)
  for (let k = 1; k <= n; k++) {
    const isSmall = k > n - small;
    const [w, h] = isSmall ? [48, 96] : (k % 3 === 0 ? [192, 128] : [128, 192]);
    const name = `${prefix}_${String(k).padStart(2, '0')}`;
    fs.writeFileSync(path.join(dir, `${name}.png`), png(w, h, portrait(k + off)));
    if (k <= captions) fs.writeFileSync(path.join(dir, `${name}.txt`), `${scenes[k % scenes.length]}, 35mm film still`, 'utf8');
  }
  for (let k = 1; k <= tiny; k++) fs.writeFileSync(path.join(dir, `vignette_${k}.png`), png(20, 20, portrait(90 + k)));
  for (let k = 1; k <= other; k++) fs.writeFileSync(path.join(dir, `notes_${k}.gif`), 'GIF89a pas une image lisible');
  return dir;
}

// ── CDP ───────────────────────────────────────────────────────────────
let list;
try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch {
  console.error(`Aucune Mia pilotable sur le port ${port} (--remote-debugging-port).`);
  process.exit(2);
}
const target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) || list.find((t) => t.type === 'page');
if (!target) { console.error('Aucune page Mia sur ce port.'); process.exit(2); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 0;
const pend = new Map();
const pageErrors = [];
let casting = false;
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  // screencast : chaque image acquittée, sinon Chromium cesse d'en envoyer (et de peindre)
  else if (d.method === 'Page.screencastFrame') ws.send(JSON.stringify({ id: ++msgId, method: 'Page.screencastFrameAck', params: { sessionId: d.params.sessionId } }));
  else if (d.method === 'Runtime.exceptionThrown') pageErrors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') pageErrors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
};
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('connexion CDP refusée')); });
const send = (method, params = {}, ms = 60000) => new Promise((resolve, reject) => {
  const i = ++msgId;
  const t = setTimeout(() => { pend.delete(i); reject(new Error(`CDP : pas de réponse à ${method}`)); }, ms);
  pend.set(i, (d) => { clearTimeout(t); resolve(d); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
async function ev(expr, ms = 90000) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, ms);
  if (r.error) throw new Error(r.error.message);
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || 'évaluation');
  return r.result?.result?.value;
}
await send('Runtime.enable');
await send('Page.enable');
async function screencast(on) {
  if (casting) { try { await send('Page.stopScreencast', {}, 3000); } catch { /* page partie */ } casting = false; }
  if (on) { await send('Page.startScreencast', { format: 'jpeg', quality: 5, maxWidth: 200, everyNthFrame: 1 }); casting = true; }
}
const settle = (ms = 150) => ev(`new Promise((r) => { let n = 0; const t = setTimeout(r, 500); const f = () => { if (++n >= 2) { clearTimeout(t); r(1); } else requestAnimationFrame(f); }; requestAnimationFrame(f); })`).then(() => sleep(ms));
async function setViewport(w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await settle(250);
}
async function until(expr, ms = 30000, every = 150) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await ev(expr, 8000); } catch { /* la page se recharge */ }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(every);
  }
}

// ── ce que l'outil pose dans la page ─────────────────────────────────────
const PAGE = `(() => {
const view = () => document.getElementById('view-train');
const vis = (n) => { if (!n || !n.isConnected) return false; const r = n.getBoundingClientRect(); if (r.width < 0.5 || r.height < 0.5) return false; const cs = getComputedStyle(n); return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05; };
const own = (n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join('').trim();
const sel = (n) => { const c = typeof n.className === 'string' ? n.className.trim().split(/\\s+/).filter(Boolean).slice(0, 3).join('.') : ''; return n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (c ? '.' + c : ''); };
/** L'ancêtre qui rogne ou fait défiler (le cadre dans lequel l'élément doit tenir). */
function frame(n) {
  for (let p = n.parentElement; p; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (/(auto|scroll|hidden|clip)/.test(cs.overflowX + cs.overflowY) || p.id === 'view-train') return p;
  }
  return document.documentElement;
}
/** Défauts de mise en page dans la vue et la barre de titre : hors écran, hors cadre, coupé, ellipse, chevauchement. */
function scan() {
  const out = [];
  const W = window.innerWidth, H = window.innerHeight;
  const roots = [view(), document.getElementById('tb-actions'), document.getElementById('modal-root')].filter(Boolean);
  const SCROLLERS = '.tr-form, .tr-thumbs, .tr-cks, .tr-ev-flow, .tr-tiles, .tr-log-body, #view-train';
  for (const root of roots) {
    for (const n of root.querySelectorAll('*')) {
      if (!vis(n) || n.closest('svg') || n.tagName === 'CANVAS') continue;
      const r = n.getBoundingClientRect();
      const text = own(n);
      const inScroll = n.closest('.tr-form, .tr-thumbs, .tr-cks, .tr-ev-flow, .tr-tiles, .tr-log-body');
      const fr = frame(n);
      const f = fr.getBoundingClientRect();
      const cs = getComputedStyle(n);
      // a) hors de la fenêtre (ce qui est dans une zone qui défile a le droit d'en sortir)
      if (!inScroll && cs.position !== 'fixed' && (r.right > W + 0.5 || r.left < -0.5 || (root !== view() && r.bottom > H + 0.5))) out.push({ kind: 'hors écran', sel: sel(n), text: text.slice(0, 60), r: [r.left, r.right, W].map(Math.round) });
      // b) plus large que son cadre, à l'horizontale (un texte qui pousse sa rangée)
      else if (!inScroll && fr !== document.documentElement && !fr.matches(SCROLLERS) && (r.right > f.right + 1 || r.left < f.left - 1) && cs.position !== 'absolute') out.push({ kind: 'hors cadre', sel: sel(n), cadre: sel(fr), text: text.slice(0, 60), r: [Math.round(r.right), Math.round(f.right)] });
      // c) texte rogné
      if (text && n.scrollWidth > n.clientWidth + 1 && /(hidden|clip)/.test(cs.overflowX)) {
        if (cs.textOverflow === 'ellipsis') {
          const strict = n.matches('.btn, .btn *, .kicker.tr-c-part, .tr-stat-k, .tr-ck-text, .tr-row-state, .tr-row-base, .tr-row-kind, .tr-row-size, .tr-row-date, .seg-opt, .seg-opt *, .tr-chip-txt, .tr-cell-right, .tr-why');
          out.push({ kind: strict ? 'ellipse' : 'ellipse (admise)', sel: sel(n), text: text.slice(0, 80), w: [n.clientWidth, n.scrollWidth] });
        } else out.push({ kind: 'coupé', sel: sel(n), text: text.slice(0, 80), w: [n.clientWidth, n.scrollWidth] });
      }
    }
  }
  // d) frères d'une même rangée qui se recouvrent
  for (const rowEl of (view() || document).querySelectorAll('.tr-head, .tr-foot, .tr-actions, .tr-acts-left, .tr-acts-mid, .tr-c-line, .tr-stat, .tr-ck, .tr-row, .tr-set-head, .tr-cap-head, .tr-cell-head, .tr-ev-head, .tr-prop, .tr-done, .tr-notice, .tr-steps')) {
    if (!vis(rowEl)) continue;
    const kids = [...rowEl.children].filter(vis).filter((k) => getComputedStyle(k).position !== 'absolute');
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
      const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 1 && oy > 1) out.push({ kind: 'chevauche', sel: sel(kids[i]) + ' / ' + sel(kids[j]), dans: sel(rowEl), text: (kids[i].textContent || '').trim().slice(0, 40) + ' | ' + (kids[j].textContent || '').trim().slice(0, 40) });
    }
  }
  // e) la vue défile-t-elle ?
  const v = view();
  const scrolls = v && vis(v) ? { y: v.scrollHeight > v.clientHeight + 1, x: v.scrollWidth > v.clientWidth + 1 } : { y: false, x: false };
  return { found: out, scrolls };
}
/** Rien de Windows : ni <select>, ni attribut title, ni commandes vidéo natives ; un seul bouton primaire. */
function house() {
  const v = view();
  const all = [v, document.getElementById('titlebar'), document.getElementById('modal-root')].filter(Boolean);
  const q = (s) => all.flatMap((r) => [...r.querySelectorAll(s)]).filter(vis);
  return {
    selects: q('select').length,
    titles: q('[title]').map(sel),
    videoControls: q('video[controls]').length,
    primary: v ? [...v.querySelectorAll('.btn-primary')].filter(vis).map((b) => b.textContent.trim()) : [],
    shiny: v ? [...v.querySelectorAll('.btn-primary.shiny')].filter(vis).length : 0
  };
}
/** La bande des essais : elle tient, ou elle défile par tuiles entières — aucune tuile coupée au bord, rien sous la barre de défilement, la tuile choisie en vue. */
function tiles() {
  const box = (view() || document).querySelector('.tr-tiles');
  if (!box || !vis(box)) return null;
  const b = box.getBoundingClientRect();
  const left = b.left + box.clientLeft, right = left + box.clientWidth, bottom = b.top + box.clientTop + box.clientHeight;
  const kids = [...box.children];
  const rects = kids.map((k) => k.getBoundingClientRect());
  const shown = rects.filter((r) => r.right > left + 1 && r.left < right - 1);
  const cut = shown.filter((r) => r.left < left - 1 || r.right > right + 1).map((r) => [Math.round(r.left), Math.round(r.right), Math.round(left), Math.round(right)]);
  const cur = kids.findIndex((k) => k.classList.contains('running')) >= 0 ? kids.findIndex((k) => k.classList.contains('running')) : kids.findIndex((k) => k.classList.contains('on'));
  const curIn = cur < 0 || (rects[cur].left >= left - 1 && rects[cur].right <= right + 1);
  // « défile » = une barre de défilement est là (elle prend de la hauteur : la boîte n'a pas de bordure)
  return { n: kids.length, shown: shown.length, scroll: box.offsetHeight - box.clientHeight > 0, cut, under: rects.every((r) => r.bottom <= bottom + 0.5), curIn, w: rects[0] ? Math.round(rects[0].width) : 0 };
}
const txt = (s) => { const n = (view() || document).querySelector(s); return n && vis(n) ? n.textContent.replace(/\\s+/g, ' ').trim() : null; };
const all = (s) => [...(view() || document).querySelectorAll(s)].filter(vis).map((n) => n.textContent.replace(/\\s+/g, ' ').trim());
const snap = () => ({
  view: window.__mia.state.view, lang: document.documentElement.lang,
  chip: (document.querySelector('#tb-train .tr-chip-txt') || {}).textContent || null,
  chipClass: (document.getElementById('tb-train') || {}).className || '',
  chipGauge: !!document.querySelector('#tb-train .tr-chip-gauge:not([hidden])'),
  title: txt('.tr-title'), crumbs: all('.tr-head .tr-link'), c: all('.tr-c-part'), cSub: txt('.tr-c-sub'), cErr: !!(view() || document).querySelector('.tr-c.err'),
  bar: ((view() || document).querySelector('.tr-bar') || {}).className || null,
  acts: [...(view() || document).querySelectorAll('.tr-acts-left .btn')].filter(vis).map((b) => ({ id: b.dataset.act, text: b.textContent.trim(), off: b.classList.contains('is-disabled') })),
  why: all('.tr-why'), rows: all('.tr-row').length, rowStates: all('.tr-row-state'),
  tiles: all('.tr-tile').length, tilesHave: [...(view() || document).querySelectorAll('.tr-tile.have')].length, running: !!(view() || document).querySelector('.tr-tile.running'),
  big: (() => { const b = (view() || document).querySelector('.tr-big > img, .tr-big > video'); return b ? b.tagName.toLowerCase() : null; })(),
  cks: all('.tr-ck-text'), events: all('.tr-ev-x'), stats: all('.tr-stat').map((s) => s), meta: txt('.tr-meta'), by: txt('.tr-by'),
  lossRight: txt('.tr-loss .tr-cell-right'), samplesRight: txt('.tr-samples .tr-cell-right'),
  activeTab: !!document.querySelector('#tb-tabs .tb-tab.active, #tb-tabs .tb-tab.on, #tb-tabs [aria-selected="true"]'),
  screen: window.__mia.app.openTrain ? null : 'pas de openTrain'
});
/** ÉVÈNEMENTS d'un entraînement : les lignes calculées (traintext.js) en ordre de temps, dans une fenêtre d'heures plausible, et l'écran les montre dans cet ordre, avec ces heures. */
async function events(id, L) {
  const X = await import(new URL('js/ui/traintext.js', location.href).href);
  const s = await window.mia.train.get(id);
  const lines = X.eventLines(L, s);
  const ats = lines.map((e) => e.at);
  const stamps = (s.events || []).map((e) => +e.t).filter((t) => t > 0);
  const lo = Math.min(...stamps, ...((s.notes || []).map((n) => +n.at).filter((t) => t > 0))) - 2000;
  const hi = Date.now() + 2000;
  const shownT = [...document.querySelectorAll('#view-train .tr-ev')].filter(vis).map((n) => ((n.querySelector('.tr-ev-t') || {}).textContent || ''));
  const shownX = [...document.querySelectorAll('#view-train .tr-ev-x')].filter(vis).map((n) => n.textContent);
  return {
    sorted: ats.every((a, i) => i === 0 || a >= ats[i - 1]),
    inRange: ats.every((a) => a >= lo && a <= hi),
    // ce que l'écran montre est le début de ce qui vient d'être relu (pendant un entraînement, une ligne a pu arriver depuis)
    sameOnScreen: shownX.length > 0 && (X.isActive(s) ? shownX.length <= lines.length : shownX.length === lines.length)
      && shownX.join('|') === lines.slice(0, shownX.length).map((e) => e.text).join('|') && shownT.join('|') === lines.slice(0, shownX.length).map((e) => X.clock(L, e.at)).join('|'),
    texts: lines.map((e) => X.clock(L, e.at) + ' ' + e.text)
  };
}
/** Ce qui flotte au-dessus des vues (cartes de proposition, demandes d'un assistant) et recouvre un texte de l'écran. */
function covered() {
  const fixed = [...document.querySelectorAll('.gl-stack > *, .gl-side > *')].filter(vis);
  const out = [];
  for (const n of (view() || document).querySelectorAll('*')) {
    if (!vis(n) || !own(n)) continue;
    const r = n.getBoundingClientRect();
    for (const f of fixed) {
      const b = f.getBoundingClientRect();
      if (Math.min(b.right, r.right) - Math.max(b.left, r.left) > 1 && Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top) > 1) { out.push({ sous: sel(f), texte: own(n).slice(0, 40) }); break; }
    }
  }
  return out;
}
/** Une proposition d'assistant dessinée comme si le pont l'avait posée (greenlight.js, même module que l'application). */
async function propose(id, on) {
  const g = await import(new URL('js/ui/greenlight.js', location.href).href);
  const s = await window.mia.train.get(id);
  g.proposeTraining({ ...s, proposal: on ? { by: 'Claude', at: Date.now(), resume: s.state !== 'pret' } : null });
  return 1;
}
const cards = () => [...document.querySelectorAll('.gl-train, .gl-train-chip')].filter(vis).map((c) => ({ id: c.dataset.training, r: c.getBoundingClientRect().toJSON(), text: c.textContent.trim().slice(0, 120),
  cut: [...c.querySelectorAll('*')].some((x) => own(x) && x.scrollWidth > x.clientWidth + 1 && getComputedStyle(x).textOverflow !== 'ellipsis' && /(hidden|clip)/.test(getComputedStyle(x).overflowX)) }));
window.__tcs = { scan, house, snap, vis, txt, all, tiles, events, covered, propose, cards };
return 'ok';
})()`;

async function waitReady(lang, ms = 45000) {
  const ok = await until(`(() => !!(document.readyState === 'complete' && window.__mia && window.__mia.app && window.__mia.app.home && window.__mia.app.editor && window.__mia.app.openTrain && document.getElementById('tb-train') && ${lang ? `document.documentElement.lang === ${J(lang)}` : 'true'}))()`, ms, 400);
  if (!ok) throw new Error(`la fenêtre n'est pas revenue (langue ${lang || '?'})`);
  await sleep(1200);
  await screencast(true);
  await ev(PAGE);
}
async function setLang(lang) {
  const cur = await ev('document.documentElement.lang');
  if (cur === lang) return false;
  await ev(`(async () => { const m = await import(new URL('js/i18n.js', location.href).href); setTimeout(() => m.setLang(${J(lang)}), 0); return 1; })()`);
  await sleep(1200);
  await waitReady(lang);
  return true;
}

const T = (call) => ev(`window.mia.train.${call}`);
const snap = () => ev('window.__tcs.snap()');
const getState = (id) => ev(`window.mia.train.get(${J(id)}).then((s) => ({ state: s.state, phase: s.phase, step: s.step, steps: s.steps, pause: s.pause, pending: s.pending, samples: s.samples.length, checkpoints: s.checkpoints.length, error: s.error, seen: s.seen, ok: s.ok }))`);
const waitState = (id, test, ms = 60000) => until(`window.mia.train.get(${J(id)}).then((s) => (${test}) ? ({ state: s.state, step: s.step, phase: s.phase }) : null)`, ms, 120);

const shots = [];
/** La page telle qu'elle est, aux trois largeurs : capture, mesure des débordements, règles de la maison. */
async function look(name, lang, { sizes = SIZES, noScroll = true, primary = null, allowEllipsis = [] } = {}) {
  for (const [w, h] of sizes) {
    await setViewport(w, h);
    const res = await ev('({ scan: window.__tcs.scan(), house: window.__tcs.house(), covered: window.__tcs.covered() })');
    const bad = res.scan.found.filter((f) => f.kind !== 'ellipse (admise)' && !allowEllipsis.some((a) => f.kind === 'ellipse' && f.sel.includes(a)));
    check(`${lang} · ${name} · ${w} px : rien ne déborde, ne se chevauche ni n’est coupé`, bad.length === 0, bad.slice(0, 6));
    check(`${lang} · ${name} · ${w} px : aucune carte flottante ne recouvre un texte de l’écran`, res.covered.length === 0, res.covered.slice(0, 6));
    if (noScroll) check(`${lang} · ${name} · ${w} × ${h} : la page tient dans la fenêtre sans défiler`, !res.scan.scrolls.y && !res.scan.scrolls.x, res.scan.scrolls);
    check(`${lang} · ${name} · ${w} px : aucun <select>, aucun attribut title, aucune commande vidéo native`, res.house.selects === 0 && res.house.titles.length === 0 && res.house.videoControls === 0, res.house);
    if (primary != null) check(`${lang} · ${name} · ${w} px : ${primary} bouton primaire`, res.house.primary.length === primary, res.house.primary);
    const tl = await ev('window.__tcs.tiles()');
    if (tl) check(`${lang} · ${name} · ${w} px : bande des essais (${tl.n} tuiles${tl.scroll ? `, ${tl.shown} en vue, défile` : ''}) sans tuile coupée ni sous la barre, la tuile choisie en vue`, tl.cut.length === 0 && tl.under && tl.curIn && tl.w >= 50 && tl.scroll === (tl.shown < tl.n), tl);
    if (SHOTS) {
      const file = path.join(OUT, `${lang}_${name}_${w}.png`);
      const r = await send('Page.captureScreenshot', { format: 'png' }, 20000);
      if (r.result?.data) { fs.writeFileSync(file, Buffer.from(r.result.data, 'base64')); shots.push(file); }
      else check(`${lang} · ${name} · ${w} px : capture prise`, false, r.error);
    }
  }
}

const WORDS = {
  fr: {
    rest: 'ENTRAÎNER', list: 'Entraînements', newLora: 'Nouveau LoRA', home: '‹ Accueil', crumb: '‹ Entraînements', start: 'Lancer l’entraînement', del: 'Supprimer le brouillon',
    training: 'ENTRAÎNEMENT', stepWord: 'PAS', left: 'RESTE', ends: 'FIN VERS', last: 'DERNIER PAS IL Y A', sample: 'ESSAI DU PAS', render: 'DU RENDU', resumesIn: 'REPREND DANS',
    paused: 'GPU RENDU · NE REPREND PAS SEUL', pauseAt: 'EN PAUSE AU PAS', done: 'FINI ·', error: 'ERREUR AU PAS', oom: 'Mémoire GPU pleine.', stopped: 'ARRÊTÉ AU PAS', load: 'CHARGEMENT DU MODÈLE', loadSub: 'Mia peut ralentir',
    bPause: 'Pause', bStop: 'Arrêter…', bResume: 'Reprendre', bResumeFrom: 'Reprendre depuis le pas', bLog: 'Voir le journal de l’outil', bTrash: 'Mettre à la corbeille',
    chipPaused: 'EN PAUSE', chipSample: 'ESSAI', chipDone: 'FINI', chipError: 'ERREUR', rowDraft: 'BROUILLON', rowDone: 'FINI ·', rowError: 'ERREUR', rowRun: 'EN COURS',
    noName: 'Donne un nom', fewImages: 'Ajoute au moins 10 images', noTrigger: 'Donne un mot déclencheur', noCaption: 'images sans légende', small: 'images trop petites', tiny: 'écartée', skipped: 'ignoré',
    estimate: 'SI LANCÉ MAINTENANT', stopTitle: 'Arrêter l’entraînement de', stopBody: 'Un point de contrôle est écrit ; tu pourras reprendre.', keep: 'Continuer', stop: 'Arrêter',
    prepared: 'PRÉPARÉ PAR CLAUDE', written: 'ÉCRITE PAR CLAUDE', watching: 'CLAUDE REGARDE', note: 'Claude : visage stable', filed: 'est dans Mes LoRA', mean: 'MOY. 100 PAS', inLoras: 'DANS MES LORA', add: 'Mettre dans Mes LoRA',
    untried: 'Pas encore essayé sur cette machine', images: 'IMAGES', back: '‹ Retour à ',
    oomWhy: 'L’outil a demandé plus de mémoire que la carte n’en avait de libre.', oomEvent: 'Erreur au pas 229 : Mémoire GPU pleine.', toolLog: 'Journal de l’outil',
    toolStopped: 'L’outil s’est arrêté (code', toolWhy: 'Ses dernières lignes sont dans le journal de l’outil.', toolEvent: /^Erreur au pas \d+ : L’outil s’est arrêté \(code 1\)\.$/,
    evPaused: 'Pause au pas', evStopped: 'Arrêt au pas', tryBoard: 'Essayer sur une planche', testBoard: 'Essai Aida', tryNoLora: 'n’est pas encore dans la liste des LoRA'
  },
  en: {
    rest: 'TRAIN', list: 'Trainings', newLora: 'New LoRA', home: '‹ Home', crumb: '‹ Trainings', start: 'Start training', del: 'Delete draft',
    training: 'TRAINING', stepWord: 'STEP', left: 'LEFT', ends: 'ENDS AROUND', last: 'LAST STEP', sample: 'SAMPLE AT STEP', render: 'RENDER STEP', resumesIn: 'RESUMES IN',
    paused: 'GPU RELEASED · DOES NOT RESUME BY ITSELF', pauseAt: 'PAUSED AT STEP', done: 'DONE ·', error: 'ERROR AT STEP', oom: 'GPU memory full.', stopped: 'STOPPED AT STEP', load: 'LOADING THE MODEL', loadSub: 'Mia may slow down',
    bPause: 'Pause', bStop: 'Stop…', bResume: 'Resume', bResumeFrom: 'Resume from step', bLog: 'Show tool log', bTrash: 'Move to Recycle Bin',
    chipPaused: 'PAUSED', chipSample: 'SAMPLE', chipDone: 'DONE', chipError: 'ERROR', rowDraft: 'DRAFT', rowDone: 'DONE ·', rowError: 'ERROR', rowRun: 'RUNNING',
    noName: 'Give it a name', fewImages: 'Add at least 10 images', noTrigger: 'Give a trigger word', noCaption: 'images without a caption', small: 'images too small', tiny: 'left out', skipped: 'skipped',
    estimate: 'IF STARTED NOW', stopTitle: 'Stop training', stopBody: 'A checkpoint is written; you can resume.', keep: 'Keep training', stop: 'Stop',
    prepared: 'PREPARED BY CLAUDE', written: 'WRITTEN BY CLAUDE', watching: 'CLAUDE IS WATCHING', note: 'Claude: visage stable', filed: 'is in My LoRAs', mean: '100-STEP MEAN', inLoras: 'IN MY LORAS', add: 'Add to My LoRAs',
    untried: 'Not tried on this machine yet', images: 'IMAGES', back: '‹ Back to ',
    oomWhy: 'The tool asked for more memory than the card had free.', oomEvent: 'Error at step 229: GPU memory full.', toolLog: 'Tool log',
    toolStopped: 'The tool stopped (code', toolWhy: 'Its last lines are in the tool log.', toolEvent: /^Error at step \d+: The tool stopped \(code 1\)\.$/,
    evPaused: 'Paused at step', evStopped: 'Stopped at step', tryBoard: 'Try it on a board', testBoard: 'Aida test', tryNoLora: 'is not in the list of LoRAs yet'
  }
};

const ids = {};          // rosa, aida, atelier, lena, port

async function open(id) {
  await ev(`(window.__mia.app.openTrain(${J(id)}), 1)`);
  await until(`window.__mia.state.view === 'train' && !!document.querySelector('#view-train .tr')`, 15000);
  if (id) await until(`!!document.querySelector('#view-train .tr-title') && document.querySelector('#view-train .tr-title').textContent.length > 0`, 15000);
  await settle(400);
}

/** Un nom de 40 caractères (§10, cas 33) : la puce, la ligne de la liste, l'instrument, la carte de proposition. */
const LONG = 'Portrait de Rosabella Marinière Longue 2';
async function longName(lang, withChip) {
  const W = WORDS[lang];
  if (withChip) {
    await ev(`(window.__mia.app.goHome(), 1)`);
    await until(`window.__mia.state.view === 'home'`, 8000);
    const chip = await until(`(() => { const t = (document.querySelector('#tb-train .tr-chip-txt') || {}).textContent || ''; return t.startsWith('LORA · PORTRAIT DE RO') ? t : null; })()`, 8000);
    check(`${lang} · nom de 40 caractères : la puce le coupe proprement (« ${chip} »)`, chip === `LORA · PORTRAIT DE RO… · ${W.chipDone}`, chip);
    await look('nom-long-puce', lang, { noScroll: false });
    // la carte de proposition, avec ce nom, sur l'accueil : entière, dans la fenêtre, aux trois largeurs
    await ev(`window.__tcs.propose(${J(ids.long)}, true)`);
    for (const [w, h] of SIZES) {
      await setViewport(w, h);
      const c = (await ev('window.__tcs.cards()')).find((x) => x.id === ids.long);
      check(`${lang} · nom de 40 caractères · ${w} px : la carte de proposition tient, rien de coupé`, !!c && c.r.left >= 0 && c.r.right <= w && !c.cut && c.text.includes(LONG.slice(0, 20)), c);
      if (SHOTS && w === SIZES[0][0]) { const r = await send('Page.captureScreenshot', { format: 'png' }, 20000); if (r.result?.data) { const f = path.join(OUT, `${lang}_nom-long-carte_${w}.png`); fs.writeFileSync(f, Buffer.from(r.result.data, 'base64')); shots.push(f); } }
    }
    await ev(`window.__tcs.propose(${J(ids.long)}, false)`);
  }
  await open(ids.long);
  const s = await snap();
  check(`${lang} · nom de 40 caractères : titre de l’instrument`, s.title === LONG, s.title);
  await look('nom-long', lang, { primary: 0 });
  await open(null);
  const row = await ev(`(() => { const r = [...document.querySelectorAll('#view-train .tr-row')].find((x) => x.dataset.id === ${J(ids.long)}); if (!r) return null; const n = r.querySelector('.tr-row-name'); return { text: n.textContent, cut: n.scrollWidth > n.clientWidth + 1, base: r.querySelector('.tr-row-base').getBoundingClientRect().left >= n.getBoundingClientRect().right - 1 }; })()`);
  check(`${lang} · nom de 40 caractères : ligne de la liste lisible (nom puis modèle, sans chevauchement)`, !!row && row.text === LONG && row.base, row);
}

/** Les entraînements du décor : un fini, un en erreur, un arrêté, un brouillon incomplet — et Rosa, prête à partir. */
async function setup(imgs) {
  // des essais en image de vraie taille (192 × 256) : la liste et l'instrument les montrent comme de vrais essais
  const fake = (o) => ({ msPerStep: 8, encodeMs: 200, loadMs: 300, sampleMs: 300, sampleSize: [192, 256], ...o });
  const make = async (o, set, extra = {}) => {
    const r = await T(`create(${J(o)})`);
    if (!r || r.ok === false) throw new Error(`création refusée : ${r && r.error}`);
    if (Object.keys(extra).length) await T(`update(${J(r.id)}, ${J(extra)})`);
    if (set) {
      await T(`addImages(${J(r.id)}, ${J([set])})`);
      await until(`window.mia.train.get(${J(r.id)}).then((s) => !s.importing)`, 60000);
    }
    return r.id;
  };
  // un nom de 40 caractères, fini (avant Aida : c'est Aida, plus récente, que la puce montre d'abord)
  ids.long = await make({ name: LONG, base: 'fake', kind: 'character', trigger: 'prt long', fake: fake({}) }, imgs.full, { steps: 200, settings: { saveEvery: 100, sampleEvery: 100 } });
  let r = await T(`start(${J(ids.long)})`);
  check('décor : le nom de 40 caractères va au bout', LONG.length === 40 && !!(await waitState(ids.long, `s.state === 'fini'`, 60000)), await getState(ids.long));
  // Aida : fini (300 pas, 3 essais, 3 points)
  ids.aida = await make({ name: 'Aida', base: 'fake', kind: 'character', trigger: 'aida woman', fake: fake({}) }, imgs.full, { steps: 300, settings: { saveEvery: 100, sampleEvery: 100 } });
  r = await T(`start(${J(ids.aida)})`);
  check('décor : Aida démarre (faux outil)', r && r.ok !== false, r);
  check('décor : Aida va au bout', !!(await waitState(ids.aida, `s.state === 'fini'`, 60000)), await getState(ids.aida));
  // Quai : l'outil signale lui-même une erreur (sa ligne brute va au journal, l'écran dit une phrase propre)
  ids.quai = await make({ name: 'Quai', base: 'fake', kind: 'place', trigger: 'qai dock', fake: fake({ failAt: 140, failCode: 'tool' }) }, imgs.full, { steps: 400, settings: { saveEvery: 100, sampleEvery: 100 } });
  r = await T(`start(${J(ids.quai)})`);
  check('décor : Quai finit en erreur (erreur signalée par l’outil)', !!(await waitState(ids.quai, `s.state === 'erreur'`, 60000)), await getState(ids.quai));
  // Atelier : erreur « mémoire GPU pleine » au pas 230, un point au pas 200
  ids.atelier = await make({ name: 'Atelier', base: 'fake', kind: 'place', trigger: 'atl studio', fake: fake({ failAt: 230, failCode: 'oom' }) }, imgs.full, { steps: 1500, settings: { saveEvery: 100, sampleEvery: 100 } });
  r = await T(`start(${J(ids.atelier)})`);
  check('décor : Atelier finit en erreur', !!(await waitState(ids.atelier, `s.state === 'erreur'`, 60000)), await getState(ids.atelier));
  // Port : arrêté au vol par « Arrêter… » (plus tard, par l'écran)
  ids.port = await make({ name: 'Port de nuit', base: 'fake', kind: 'style', trigger: 'prt night', fake: fake({ msPerStep: 25 }) }, imgs.full, { steps: 2000, settings: { saveEvery: 100, sampleEvery: 0 } });
  // Lena : brouillon incomplet (légendes manquantes, images trop petites, fichiers écartés), préparé par un assistant
  ids.lena = await make({ name: 'Lena', base: 'fake', kind: 'character', trigger: 'lna woman', by: 'Claude' }, imgs.partial);
  await T(`setCaption(${J(ids.lena)}, 'lena_02.png', 'standing on a pier at dawn, wind in her hair, 35mm film still', 'Claude')`);
  // Rosa : 32 images légendées, 2 500 pas ; elle traversera le changement de langue
  ids.rosa = await make({ name: 'Rosa', base: 'fake', kind: 'character', trigger: 'rsa woman', fake: { msPerStep: 60, encodeMs: 900, loadMs: 3500, sampleMs: 9000, sampleSteps: 25, sampleKind: 'video' } }, imgs.rosa, { steps: 2500 });
}

async function listAndDraft(lang) {
  const W = WORDS[lang];
  // ── la liste
  await open(null);
  let s = await snap();
  check(`${lang} · liste : la vue « Entraînements » est affichée, onglet de planche éteint`, s.view === 'train' && s.title === W.list && !s.activeTab, s);
  check(`${lang} · liste : « ‹ Accueil » en tête (aucune planche quittée)`, s.crumbs[0] === W.home, s.crumbs);
  check(`${lang} · liste : une ligne par entraînement, avec son état`, s.rows >= 5 && s.rowStates.some((x) => x.startsWith(W.rowDone)) && s.rowStates.includes(W.rowError) && s.rowStates.includes(W.rowDraft), s.rowStates);
  check(`${lang} · liste : vignette, taille et date sur les lignes`, await ev(`(() => { const r = [...document.querySelectorAll('#view-train .tr-row')]; return r.some((x) => x.querySelector('.tr-row-thumb img')) && r.every((x) => /\\d/.test((x.querySelector('.tr-row-date') || {}).textContent || '')) && r.some((x) => /\\d/.test((x.querySelector('.tr-row-size') || {}).textContent || '')); })()`));
  check(`${lang} · liste : point « non vu » sur l’erreur pas encore ouverte`, await ev(`!!document.querySelector('#view-train .tr-row .tr-dot.on.err')`) || lang !== LANGS[0]);
  // la taille de chaque dossier est mesurée (jamais « 0 MO » pour un dossier qui pèse quelque chose)
  const sizes = await ev(`[...document.querySelectorAll('#view-train .tr-row')].map((r) => ({ id: r.dataset.id, size: (r.querySelector('.tr-row-size') || {}).textContent || '' }))`);
  check(`${lang} · liste : une taille mesurée sur chaque ligne, aucune à zéro`, sizes.length >= 6 && sizes.every((x) => /^\d[\d  ,.]* (KO|MO|GO|KB|MB|GB)$/.test(x.size) && !/^0 /.test(x.size)), sizes);
  const aidaSize = (sizes.find((x) => x.id === ids.aida) || {}).size || '';
  const lenaSize = (sizes.find((x) => x.id === ids.lena) || {}).size || '';
  const kb = (t) => { const m = /^([\d  ,.]+) (KO|MO|GO|KB|MB|GB)$/.exec(t); if (!m) return 0; const n = parseFloat(m[1].replace(/[  ]/g, '').replace(lang === 'fr' ? ',' : /,/g, lang === 'fr' ? '.' : '')); return n * ({ KO: 1, KB: 1, MO: 1024, MB: 1024, GO: 1048576, GB: 1048576 })[m[2]]; };
  check(`${lang} · liste : Aida finie (images, essais, points) pèse plus que le brouillon Lena (« ${aidaSize} » > « ${lenaSize} »)`, kb(aidaSize) > kb(lenaSize), [aidaSize, lenaSize]);
  // pas de grand trou entre le nom et le modèle
  const gaps = await ev(`[...document.querySelectorAll('#view-train .tr-row')].map((r) => Math.round(r.querySelector('.tr-row-base').getBoundingClientRect().left - r.querySelector('.tr-row-name').getBoundingClientRect().left))`);
  check(`${lang} · liste : le modèle suit le nom de près (${Math.max(...gaps)} px au plus du début du nom)`, gaps.every((g) => g > 100 && g <= 300), gaps);
  // la vignette d'un entraînement fini est son dernier essai : une image sombre et nuancée, pas un aplat clair ;
  // les essais diffèrent d'un pas à l'autre et d'un entraînement à l'autre
  if (lang === LANGS[0]) {
    const rows = await T('list()');
    const thumbOf = (id) => (rows.find((x) => x.id === id) || {}).thumb || '';
    const st = (file) => { const px = readPng(file); return px ? lumaStats(px) : null; };
    const aidaThumb = st(thumbOf(ids.aida));
    check('liste : vignette d’Aida (son dernier essai) sombre et nuancée, pas un aplat', !!aidaThumb && aidaThumb.mean > 8 && aidaThumb.mean < 110 && aidaThumb.std > 10 && aidaThumb.max < 250, aidaThumb);
    const sampleDir = path.dirname(thumbOf(ids.aida));
    const own = fs.existsSync(sampleDir) ? fs.readdirSync(sampleDir).filter((f) => f.endsWith('.png')).sort().map((f) => fs.readFileSync(path.join(sampleDir, f)).toString('base64')) : [];
    const other = thumbOf(ids.quai) && thumbOf(ids.quai).endsWith('.png') ? fs.readFileSync(thumbOf(ids.quai)).toString('base64') : null;
    check('liste : les essais d’Aida diffèrent entre eux, et de ceux de Quai', own.length === 3 && new Set(own).size === 3 && !!other && !own.includes(other), { aida: own.length, quai: !!other });
  }
  // l'heure d'une ligne s'écrit comme une heure (« 1 h 16 »), pas en capitales comme une durée (« 1 H 16 »)
  const dates = await ev(`[...document.querySelectorAll('#view-train .tr-row-date')].map((n) => n.innerText)`);
  check(`${lang} · liste : l’heure des lignes reste « ${lang === 'fr' ? '19/11 · 1 h 16' : '19/11 · 01:16'} » (pas de capitales)`, dates.length > 0 && dates.every((d) => (lang === 'fr' ? /^\d\d\/\d\d · \d{1,2} h \d\d$/ : /^\d\d\/\d\d · \d\d:\d\d$/).test(d.replace(/[\u00a0\u202f]/g, ' '))), dates);
  await look('liste', lang, { primary: 1 });
  // « Nouveau LoRA » puis retour sans rien remplir : aucun brouillon vide ne reste dans la liste
  {
    const n0 = (await T('list()')).length;
    await ev(`([...document.querySelectorAll('#view-train .tr-head .btn')].find((b) => b.textContent.trim() === ${J(W.newLora)}).click(), 1)`);
    await until(`!!document.querySelector('#view-train .tr-draft')`, 8000);
    const made = await ev(`window.__mia.app.openTrain && document.getElementById('view-train').dataset.training`);
    await settle(300);
    await ev(`([...document.querySelectorAll('#view-train .tr-head .tr-link')].find((b) => b.textContent === ${J(W.crumb)}).click(), 1)`);
    await until(`!!document.querySelector('#view-train .tr-list')`, 8000);
    const gone = await until(`window.mia.train.list().then((l) => l.length === ${n0} && !l.some((x) => x.id === ${J(made)}))`, 8000);
    await settle(300);
    check(`${lang} · « ${W.newLora} » puis retour sans rien remplir : pas de brouillon vide laissé dans la liste`, !!made && !!gone && (await snap()).rows === n0, { made, n0, rows: (await snap()).rows });
  }
  // menu maison au clic droit (la fenêtre est mise à sa taille d'abord : un redimensionnement ferme tout menu)
  await setViewport(1280, 800);
  await ev(`(() => { const r = document.querySelector('#view-train .tr-row'); const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 200, clientY: b.top + 20 })); return 1; })()`);
  await settle(200);
  const menu = await ev(`[...document.querySelectorAll('#contextmenu .ctx-item')].map((n) => n.textContent.trim())`);
  check(`${lang} · liste : menu maison (dossier, dupliquer, corbeille)`, Array.isArray(menu) && menu.length === 3, menu);
  if (SHOTS) { const r = await send('Page.captureScreenshot', { format: 'png' }, 20000); if (r.result?.data) { const f = path.join(OUT, `${lang}_liste-menu_1280.png`); fs.writeFileSync(f, Buffer.from(r.result.data, 'base64')); shots.push(f); } }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await settle(200);
  check(`${lang} · liste : Échap ferme d’abord le menu, la vue reste`, (await ev(`window.__mia.state.view`)) === 'train' && (await ev(`document.getElementById('contextmenu').hidden`)) === true);

  // ── le brouillon incomplet (Lena)
  await open(ids.lena);
  await ev(`(() => { const t = document.querySelector('#view-train .tr-thumb[data-name="lena_02.png"]'); if (t) t.click(); return 1; })()`);
  await settle(300);
  s = await snap();
  const d = await ev(`(() => { const v = document.getElementById('view-train'); const q = (x) => [...v.querySelectorAll(x)].filter(window.__tcs.vis); return {
    labels: q('.tr-form > .tr-f > .tr-f-label').map((n) => n.textContent), go: (v.querySelector('.tr-foot .btn-primary') || {}).textContent, goOff: !!v.querySelector('.tr-foot .btn-primary.is-disabled'),
    why: (v.querySelector('.tr-why') || {}).textContent, notices: q('.tr-notice').map((n) => n.textContent), count: (v.querySelector('.tr-set-count') || {}).textContent, thumbs: q('.tr-thumb').length,
    dots: q('.tr-thumb-dot').length, smalls: q('.tr-thumb-small').length, capBy: (v.querySelector('.tr-cap-by') || {}).textContent, capName: (v.querySelector('.tr-cap-name') || {}).textContent, cap: (v.querySelector('.tr-cap textarea') || {}).value,
    models: q('.tr-choice-opt').map((n) => ({ t: n.textContent, off: n.classList.contains('off'), tip: n.dataset.tip || '' })), by: (v.querySelector('.tr-by') || {}).textContent, estimate: (v.querySelector('.tr-estimate') || {}).textContent, del: q('.tr-foot .btn-ghost').map((n) => n.textContent)
  }; })()`);
  check(`${lang} · brouillon : fil d’Ariane « ‹ Accueil » puis « ‹ Entraînements », titre = nom`, s.crumbs[0] === W.home && s.crumbs[1] === W.crumb && s.title === 'Lena', s);
  check(`${lang} · brouillon : six réglages visibles, le reste sous « Avancés » replié`, d.labels.length === 6 && (await ev(`document.querySelector('#view-train .tr-adv-body').hidden`)) === true, d.labels);
  check(`${lang} · brouillon : « ${W.prepared} »`, (d.by || '').includes(W.prepared), d.by);
  check(`${lang} · brouillon : compteur d’images et de légendes`, /12 images · 9 (légendes|captions)/.test(d.count || ''), d.count);
  check(`${lang} · brouillon : repères « sans légende » (3) et « trop petite » (2) sur les vignettes`, d.thumbs === 12 && d.dots === 3 && d.smalls === 2, d);
  check(`${lang} · brouillon : phrases du jeu (sans légende, trop petites, écartée, ignoré)`, [W.noCaption, W.small, W.tiny, W.skipped].every((w) => d.notices.some((n) => n.includes(w))), d.notices);
  check(`${lang} · brouillon : bouton éteint, raison à sa droite (« 3 ${W.noCaption} »)`, d.goOff && d.go === W.start && (d.why || '').includes(W.noCaption), d);
  check(`${lang} · brouillon : légende de l’image choisie, « ${W.written} »`, d.capName === 'lena_02.png' && (d.cap || '').startsWith('standing on a pier') && d.capBy === W.written, d);
  check(`${lang} · brouillon : Qwen-Image 2.1 grisé, raison en info-bulle maison`, d.models.some((m) => m.t.includes('Qwen-Image 2.1') && m.off && m.tip === W.untried) && d.models.some((m) => m.t.includes('LTX 2.5')), d.models);
  check(`${lang} · brouillon : « ${W.del} »`, d.del.includes(W.del), d.del);
  await look('brouillon', lang, { primary: 1 });
  await proposalPass(lang, ids.lena, 'brouillon', 1);
  // « trop petites » : un clic sur la phrase n'affiche qu'elles
  await ev(`(() => { const b = document.querySelector('#view-train .tr-notice.n-small .tr-link'); if (b) b.click(); return 1; })()`);
  await settle(250);
  check(`${lang} · brouillon : clic sur « trop petites » → elles seules`, (await ev(`[...document.querySelectorAll('#view-train .tr-thumb')].length`)) === 2);
  await ev(`(() => { const b = document.querySelector('#view-train .tr-notice.n-small .tr-link'); if (b) b.click(); return 1; })()`);
  // « Avancés » ouvert
  await ev(`(document.querySelector('#view-train .tr-adv').click(), 1)`);
  await settle(250);
  check(`${lang} · brouillon : « Avancés » montre rang, taux, tailles, point, essai, consignes`, (await ev(`[...document.querySelectorAll('#view-train .tr-adv-body .tr-f-label')].filter(window.__tcs.vis).length`)) === 6);
  await look('brouillon-avances', lang, { sizes: [SIZES[0]], primary: 1 });
  await ev(`(document.querySelector('#view-train .tr-adv').click(), 1)`);

  // ── le brouillon prêt (Rosa) : estimation à droite du bouton
  if ((await getState(ids.rosa)).state === 'pret') {
    await open(ids.rosa);
    const r = await ev(`(() => { const v = document.getElementById('view-train'); return { off: !!v.querySelector('.tr-foot .btn-primary.is-disabled'), why: (v.querySelector('.tr-why') || {}).textContent, est: (v.querySelector('.tr-estimate') || {}).textContent, count: (v.querySelector('.tr-set-count') || {}).textContent }; })()`);
    check(`${lang} · brouillon prêt : bouton allumé, « ≈ … · … ${W.estimate} »`, !r.off && /^≈ /.test(r.why || '') && (r.why || '').includes(W.estimate), r);
    check(`${lang} · brouillon prêt : durée estimée sous la durée`, /^≈ /.test(r.est || ''), r.est);
    await look('brouillon-pret', lang, { sizes: [SIZES[0]], primary: 1 });
  }
}

/**
 * Une proposition de Claude pour l'entraînement affiché : sa carte ne se pose pas sur son propre écran (le bandeau et
 * le pied y portent déjà la décision) — rien ne recouvre ÉVÈNEMENTS ni les images, aux trois largeurs ; hors de
 * l'écran, la carte revient, entière. Puis la proposition est retirée et l'écran rouvert.
 */
async function proposalPass(lang, id, name, primary) {
  await ev(`window.__tcs.propose(${J(id)}, true)`);
  await settle(300);
  const on = await ev('window.__tcs.cards()');
  check(`${lang} · ${name} avec une proposition de Claude : aucune carte sur son propre écran`, !on.some((c) => c.id === id), on);
  await look(`${name}-proposition`, lang, { primary });
  await ev(`(window.__mia.app.goHome(), 1)`);
  await until(`window.__mia.state.view === 'home'`, 8000);
  await settle(400);
  const off = await ev('window.__tcs.cards()');
  const W0 = await ev('window.innerWidth');
  const mine = off.find((c) => c.id === id);
  check(`${lang} · ${name} : hors de l’écran, la carte revient, entière`, !!mine && mine.r.left >= 0 && mine.r.right <= W0 && !mine.cut, off);
  await ev(`window.__tcs.propose(${J(id)}, false)`);
  await open(id);
}

/** Les boutons visibles qui ouvrent le journal de l'outil (un seul attendu). */
const logButtons = (W) => ev(`[...document.querySelectorAll('#view-train .tr-actions .btn')].filter(window.__tcs.vis).map((b) => b.textContent.trim()).filter((t) => t === ${J(W.bLog)} || t === ${J(W.toolLog)})`);

async function errorPage(lang) {
  const W = WORDS[lang];
  // Quai : l'outil a écrit lui-même son erreur ; ÉVÈNEMENTS dit une phrase propre, le journal garde la ligne brute
  await open(ids.quai);
  let s = await snap();
  check(`${lang} · erreur de l’outil : « ${W.toolStopped} … » puis « ${W.toolWhy} »`, s.cErr && (s.cSub || '').startsWith(W.toolStopped) && (s.cSub || '').endsWith(`140. ${W.toolWhy}`), s.cSub);
  check(`${lang} · erreur de l’outil : la dernière ligne d’ÉVÈNEMENTS est l’erreur, propre (« ${s.events[s.events.length - 1]} »)`, W.toolEvent.test(s.events[s.events.length - 1] || '') && !s.events.some((e) => /faux outil|échec demandé|Traceback/.test(e)), s.events);
  let evs = await ev(`window.__tcs.events(${J(ids.quai)}, ${J(lang)})`);
  check(`${lang} · erreur de l’outil : ÉVÈNEMENTS dans l’ordre du temps, heures plausibles, l’écran montre cet ordre`, evs.sorted && evs.inRange && evs.sameOnScreen, evs);
  await ev(`(document.querySelector('#view-train [data-act="log"]').click(), 1)`);
  await until(`!document.querySelector('#view-train .tr-log').hidden && document.querySelector('#view-train .tr-log-body').textContent.length > 20`, 6000);
  check(`${lang} · erreur de l’outil : la ligne brute est dans le journal de l’outil`, /échec demandé au pas 140/.test((await ev(`document.querySelector('#view-train .tr-log-body').textContent`)) || ''));
  await look('erreur-outil', lang, { sizes: [SIZES[0]], primary: 0 });
  await ev(`(document.querySelector('#view-train [data-act="log"]').click(), 1)`);
  check(`${lang} · erreur de l’outil : « ${W.bLog} » referme le journal`, !!(await until(`document.querySelector('#view-train .tr-log').hidden`, 3000)));

  await open(ids.atelier);
  s = await snap();
  check(`${lang} · erreur : « ${W.error} 229 » (le dernier pas écrit avant l’échec), filet rouge, phrase « ${W.oom} » suivie de son explication`, s.cErr && (s.c[0] || '').startsWith(W.error) && s.c[0].includes('229') && (s.cSub || '').startsWith(`${W.oom} ${W.oomWhy}`), s);
  check(`${lang} · erreur : [${W.bLog}] et [${W.bResumeFrom} 200]`, s.acts.length === 2 && s.acts[0].text === W.bLog && s.acts[1].text === `${W.bResumeFrom} 200`, s.acts);
  const lb = await logButtons(W);
  check(`${lang} · erreur : un seul bouton pour le journal de l’outil`, lb.length === 1 && lb[0] === W.bLog, lb);
  check(`${lang} · erreur : l’erreur est dans ÉVÈNEMENTS, en dernier (« ${W.oomEvent} »)`, s.events[s.events.length - 1] === W.oomEvent, s.events);
  evs = await ev(`window.__tcs.events(${J(ids.atelier)}, ${J(lang)})`);
  check(`${lang} · erreur : ÉVÈNEMENTS dans l’ordre du temps, heures plausibles, l’écran montre cet ordre`, evs.sorted && evs.inRange && evs.sameOnScreen, evs);
  check(`${lang} · erreur : la puce « ERREUR » s’éteint une fois l’écran ouvert`, !!(await until(`!(document.querySelector('#tb-train .tr-chip-txt').textContent || '').includes(${J(W.chipError)})`, 6000)), (await snap()).chip);
  await look('erreur', lang, { primary: 0 });
  // le journal de l'outil : tiroir bas, Échap le ferme sans quitter la vue
  await ev(`(document.querySelector('#view-train [data-act="log"]').click(), 1)`);
  await until(`!document.querySelector('#view-train .tr-log').hidden && document.querySelector('#view-train .tr-log-body').textContent.length > 20`, 6000);
  const logText = await ev(`document.querySelector('#view-train .tr-log-body').textContent`);
  check(`${lang} · erreur : « Journal de l’outil » montre la sortie de l’outil`, /faux outil|fake|pas \d+|step/i.test(logText || ''), (logText || '').slice(-200));
  await look('erreur-journal', lang, { sizes: [SIZES[0]], primary: 0 });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await settle(200);
  check(`${lang} · erreur : Échap ferme le journal, la vue reste`, (await ev(`document.querySelector('#view-train .tr-log').hidden`)) === true && (await ev(`window.__mia.state.view`)) === 'train');
}

async function donePage(lang, id, name, big = 'img') {
  const W = WORDS[lang];
  await open(id);
  const s = await snap();
  check(`${lang} · fin : « ${W.done} … »`, (s.c[0] || '').startsWith(W.done), s.c);
  check(`${lang} · fin : « ${name} ${W.filed} … » et un point « ${W.inLoras} »`, ((await ev(`(document.querySelector('#view-train .tr-done-text') || {}).textContent || ''`)) || '').includes(`${name} ${W.filed}`) && (await ev(`[...document.querySelectorAll('#view-train .tr-ck-added')].length`)) >= 1);
  check(`${lang} · fin : aucun bouton d’arrêt ni de pause ; « ${W.add} » sur les autres points`, s.acts.length === 0 && (await ev(`[...document.querySelectorAll('#view-train .tr-ck .btn')].some((b) => b.textContent === ${J(W.add)})`)), s.acts);
  check(`${lang} · fin : tous les essais sont là, le dernier en grand`, s.tiles > 0 && s.tilesHave === s.tiles && s.big === big, s);
  check(`${lang} · fin : la courbe a sa moyenne (« ${W.mean} »)`, (s.lossRight || '').includes(W.mean), s.lossRight);
  const evs = await ev(`window.__tcs.events(${J(id)}, ${J(lang)})`);
  check(`${lang} · fin : ÉVÈNEMENTS dans l’ordre du temps, heures plausibles, l’écran montre cet ordre`, evs.sorted && evs.inRange && evs.sameOnScreen, evs);
  check(`${lang} · fin : aucune durée « (0 s) » dans ÉVÈNEMENTS`, !s.events.some((e) => /\(0 s\)/.test(e)), s.events);
  await look('fin', lang, { primary: 0 });
  // le mot déclencheur, guillemets compris, n'est jamais coupé sur deux lignes (c'est ce qu'on recopie), à toutes les largeurs
  for (const [w, h] of SIZES) {
    await setViewport(w, h);
    const tg = await ev(`(() => { const n = document.querySelector('#view-train .tr-done-text .tr-nowrap'); if (!n) return null; const r = document.createRange(); r.selectNodeContents(n); const lines = new Set([...r.getClientRects()].map((x) => Math.round(x.top))); return { text: n.textContent, lines: lines.size }; })()`);
    check(`${lang} · fin · ${w} px : le mot déclencheur tient sur une ligne (« ${tg && tg.text} »)`, !!tg && tg.lines === 1 && tg.text.includes(id === ids.rosa ? 'rsa woman' : 'aida woman'), tg);
  }
}

/**
 * « Essayer sur une planche » : la planche s'ouvre (ou « Essai Aida » est créée) avec UN bloc de génération, la consigne =
 * le mot déclencheur ; le modèle suit la famille de la base (la base de test n'en a pas : celui par défaut) ; un LoRA
 * que l'inventaire ne connaît pas encore → le bloc est posé quand même et un message le dit ; connu → choisi.
 */
async function tryBoard(lang, id, name, trigger) {
  const W = WORDS[lang];
  await setViewport(...SIZES[0]);
  const nodes = () => ev(`(() => { const g = window.__mia.app.editor && window.__mia.app.editor.getGraph && window.__mia.app.editor.getGraph(); return g ? g.nodes.map((n) => ({ id: n.id, type: n.type, params: n.params || {} })) : null; })()`);
  await ev(`(() => { const b = [...document.querySelectorAll('#view-train .tr-done .btn')].find((x) => x.textContent.trim() === ${J(W.tryBoard)}); if (b) b.click(); return !!b; })()`);
  const onBoard = await until(`window.__mia.state.view === 'board' && !!window.__mia.state.project`, 15000);
  await settle(600);
  const board = await ev(`window.__mia.state.project && window.__mia.state.project.name`);
  const n1 = await nodes();
  const gen = (n1 || []).filter((n) => n.type === 'gen');
  const toast = await until(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).find((t) => t.includes(${J(W.tryNoLora)})) || null`, 6000);
  check(`${lang} · « ${W.tryBoard} » : la planche « ${W.testBoard} » s’ouvre avec UN bloc de génération, consigne « ${trigger} »`, !!onBoard && board === W.testBoard && gen.length === 1 && gen[0].params.prompt === trigger, { board, n1 });
  check(`${lang} · … le LoRA n’est pas encore dans l’inventaire : bloc posé sans lui, et un message le dit`, !!gen[0] && (!gen[0].params.lora || gen[0].params.lora === 'none') && !!toast, { lora: gen[0] && gen[0].params.lora, toast });
  check(`${lang} · … base sans famille (faux modèle) : le modèle par défaut du bloc`, !!gen[0] && gen[0].params.model === 'fam:ltx', gen[0] && gen[0].params.model);
  // une base Qwen (famille qwen21), et un LoRA que l'inventaire connaît : modèle et LoRA posés
  const file = await ev(`window.mia.train.get(${J(id)}).then((s) => s.lora && s.lora.file)`);
  await ev(`(() => { const inv = window.__mia.state.inventory || { models: [] }; inv.models = [...(inv.models || []).filter((m) => m.id !== 'lora-essai-banc'), { id: 'lora-essai-banc', path: ${J(file)}, kind: 'lora', name: 'Aida' }]; window.__mia.state.inventory = inv; return 1; })()`);
  await ev(`window.__mia.app.tryLora({ name: ${J(name)}, trigger: ${J(trigger)}, file: ${J(file)}, family: 'qwen21', testName: ${J(W.testBoard)} })`);
  await settle(400);
  const n2 = (await nodes()).filter((n) => n.type === 'gen' && !gen.some((g) => g.id === n.id));
  check(`${lang} · … base Qwen et LoRA connu : bloc « fam:qwen21 » avec le LoRA choisi`, n2.length === 1 && n2[0].params.model === 'fam:qwen21' && n2[0].params.lora === 'lora-essai-banc' && n2[0].params.prompt === trigger, n2);
  if (SHOTS) { const r = await send('Page.captureScreenshot', { format: 'png' }, 20000); if (r.result?.data) { const f = path.join(OUT, `${lang}_essai-planche_1280.png`); fs.writeFileSync(f, Buffer.from(r.result.data, 'base64')); shots.push(f); } }
  await ev(`(() => { const inv = window.__mia.state.inventory; if (inv && inv.models) inv.models = inv.models.filter((m) => m.id !== 'lora-essai-banc'); return 1; })()`);
  await ev(`(window.__mia.app.goHome(), 1)`);
  await until(`window.__mia.state.view === 'home'`, 8000);
}

async function stopPage(lang) {
  const W = WORDS[lang];
  // Port de nuit : lancé depuis son brouillon par le bouton, arrêté par « Arrêter… » et sa confirmation maison
  await open(ids.port);
  await ev(`(document.querySelector('#view-train .tr-foot .btn-primary').click(), 1)`);
  check(`${lang} · départ par le bouton : l’écran passe du brouillon à l’instrument`, !!(await until(`!!document.querySelector('#view-train .tr-run')`, 10000)));
  await waitState(ids.port, `s.state === 'entrainement' && s.step > 60`, 30000);
  await settle(300);
  await ev(`(document.querySelector('#view-train [data-act="stop"]').click(), 1)`);
  await until(`!!document.querySelector('#modal-root .modal')`, 5000);
  const m = await ev(`(() => { const b = document.querySelector('#modal-root .modal'); return { h: b.querySelector('h2').textContent, p: (b.querySelector('p') || {}).textContent || '', btns: [...b.querySelectorAll('.btn')].map((x) => x.textContent) }; })()`);
  check(`${lang} · « Arrêter… » : confirmation maison (titre avec le pas, point de contrôle, [${W.keep}] [${W.stop}])`, m.h.startsWith(W.stopTitle) && m.h.includes('Port de nuit') && /\d/.test(m.h) && m.p.startsWith(W.stopBody) && m.btns.join('|') === `${W.keep}|${W.stop}`, m);
  await look('arret-confirmation', lang, { sizes: [SIZES[0]], noScroll: false });
  await ev(`([...document.querySelectorAll('#modal-root .modal .btn')].pop().click(), 1)`);
  check(`${lang} · « Arrêter » : point au pas courant, état « arrêté »`, !!(await waitState(ids.port, `s.state === 'annule'`, 20000)), await getState(ids.port));
  await until(`(document.querySelector('#view-train .tr-c-part') || {}).textContent.startsWith(${J(W.stopped)})`, 6000);
  const s = await snap();
  check(`${lang} · arrêté : « ${W.stopped} … », [${W.bResumeFrom} …] et [${W.bTrash}]`, (s.c[0] || '').startsWith(W.stopped) && s.acts.length === 2 && s.acts[0].text.startsWith(W.bResumeFrom) && s.acts[1].text === W.bTrash, s);
  await look('arrete', lang, { sizes: [SIZES[0]], primary: 0 });
}

/** Rosa en français : attente du chargement, en cours, essai, pause. */
async function rosaFirstHalf(lang) {
  const W = WORDS[lang];
  await open(ids.rosa);
  await ev(`(document.querySelector('#view-train .tr-foot .btn-primary').click(), 1)`);
  // préparation : chargement du modèle (barre indéterminée, phrase d'attente)
  check(`${lang} · chargement : atteint`, !!(await waitState(ids.rosa, `s.state === 'preparation' && s.phase === 'load'`, 20000)));
  await until(`(document.querySelector('#view-train .tr-c-part') || {}).textContent.startsWith(${J(W.load)})`, 5000);
  let s = await snap();
  check(`${lang} · chargement : « ${W.load} », barre indéterminée, « ${W.loadSub}… », seul [${W.bStop}]`, (s.c[0] || '').startsWith(W.load) && (s.bar || '').includes('b-indeterminate') && (s.cSub || '').startsWith(W.loadSub) && s.acts.length === 1 && s.acts[0].text === W.bStop, s);
  // aucun pas encore : rien à droite de PERTE (jamais « 0,000 ${W.mean} »), et l'assistant lit null, pas 0
  const lossNow = await ev(`window.mia.train.get(${J(ids.rosa)}).then((g) => ({ mean: g.loss.mean100, steps: g.curve.length, right: (document.querySelector('#view-train .tr-loss .tr-cell-right') || {}).textContent }))`);
  check(`${lang} · chargement : rien à droite de PERTE, loss.mean100 null (pas « 0,000 ${W.mean} »)`, lossNow.steps > 0 || (lossNow.mean === null && !lossNow.right), lossNow);
  await look('chargement', lang, { sizes: [SIZES[0]], primary: 0 });
  // en cours, après le premier essai (pas 500) et deux points
  check(`${lang} · en cours : atteint le pas 560`, !!(await waitState(ids.rosa, `s.state === 'entrainement' && s.step >= 560`, 120000)), await getState(ids.rosa));
  await ev(`window.mia.train.note(${J(ids.rosa)}, { text: 'visage stable', by: 'Claude' })`);
  await ev(`window.mia.train.get(${J(ids.rosa)}, { watch: 'Claude' })`);
  await ev(`window.mia.train.addToLoras(${J(ids.rosa)}, 250)`);
  await settle(1300);
  s = await snap();
  check(`${lang} · en cours : ligne d’état « ${W.training} · ${W.stepWord} n / 2 500 · % · ${W.left} · ${W.ends} · ${W.last} »`,
    s.c[0] === W.training && new RegExp(`^${W.stepWord} \\d`).test(s.c[1] || '') && /2[\s,. ]500$/.test(s.c[1] || '') && /%$/.test(s.c[2] || '') && s.c.some((x) => x.includes(W.left)) && s.c.some((x) => x.startsWith(W.ends)) && s.c.some((x) => x.includes(W.last)), s.c);
  check(`${lang} · en cours : barre de progression, [${W.bPause}] [${W.bStop}]`, (s.bar || '').includes('b-progress') && s.acts.map((a) => a.text).join('|') === `${W.bPause}|${W.bStop}` && s.acts.every((a) => !a.off), s);
  check(`${lang} · en cours : puce « LORA · ROSA n % » avec sa jauge`, /^LORA · ROSA \d+/.test(s.chip || '') && s.chip.includes('%') && s.chipGauge, s.chip);
  check(`${lang} · en cours : en-tête « FAUX MODÈLE · PERSONNAGE · « rsa woman » · 32 IMAGES »`, (s.meta || '').includes('rsa woman') && (s.meta || '').includes(`32 ${W.images}`), s.meta);
  check(`${lang} · en cours : « ${W.watching} · … »`, (s.by || '').includes(W.watching), s.by);
  check(`${lang} · en cours : essais 1 / 5, un essai (vidéo) en grand, tuiles à venir`, s.samplesRight === '1 / 5' && s.tiles === 5 && s.tilesHave === 1 && s.big === 'video', s);
  const vid = await until(`(() => { const v = document.querySelector('#view-train .tr-big > video'); const p = document.querySelector('#view-train .tr-big > .media-ctl.pl'); return v && p && v.readyState >= 2 ? { controls: v.controls, muted: v.muted, loop: v.loop, paused: v.paused, w: v.videoWidth } : null; })()`, 8000);
  check(`${lang} · en cours : l’essai vidéo joue muet et en boucle, avec la pastille de lecture de Mia, sans commandes natives`, !!vid && vid.controls === false && vid.muted === true && vid.loop === true && vid.w > 0, vid);
  check(`${lang} · en cours : points de contrôle listés, le pas 250 « ${W.inLoras} »`, s.cks.length >= 2 && (await ev(`[...document.querySelectorAll('#view-train .tr-ck')].some((l) => l.textContent.includes('250') && l.querySelector('.tr-ck-added'))`)), s.cks);
  check(`${lang} · en cours : évènements (encodage, chargement, point, essai, note signée)`, s.events.length >= 5 && s.events.includes(W.note), s.events);
  check(`${lang} · en cours : filtre des évènements Tout / Mia / Claude`, (await ev(`[...document.querySelectorAll('#view-train .tr-ev-head .seg-opt')].map((n) => n.textContent).join('|')`)) === (lang === 'fr' ? 'Tout|Mia|Claude' : 'All|Mia|Claude'));
  const evs = await ev(`window.__tcs.events(${J(ids.rosa)}, ${J(lang)})`);
  check(`${lang} · en cours : ÉVÈNEMENTS dans un seul ordre (le temps), heures plausibles — l’essai vidéo n’a pas l’heure de son fichier source`, evs.sorted && evs.inRange && evs.sameOnScreen, evs);
  const lb = await logButtons(W);
  check(`${lang} · en cours : un seul bouton « ${W.toolLog} »`, lb.length === 1 && lb[0] === W.toolLog, lb);
  const evT = await ev(`[...document.querySelectorAll('#view-train .tr-ev-t')].map((n) => n.innerText)`);
  check(`${lang} · en cours : les heures d’ÉVÈNEMENTS restent « ${lang === 'fr' ? '1 h 17' : '01:17'} » (pas de capitales)`, evT.length > 0 && evT.every((t) => (lang === 'fr' ? /^\d{1,2} h \d\d$/ : /^\d\d:\d\d$/).test(t.replace(/[\u00a0\u202f]/g, ' '))), evT);
  await look('en-cours', lang, { primary: 0 });
  // navigation : Échap ramène d'où l'on vient, l'entraînement continue, la puce reste ; un clic sur la puce y revient
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  check(`${lang} · Échap : retour à l’accueil, la puce continue d’afficher l’entraînement`, !!(await until(`window.__mia.state.view === 'home'`, 8000)) && /^LORA · ROSA/.test((await snap()).chip || ''));
  await ev(`(document.getElementById('tb-train').click(), 1)`);
  check(`${lang} · clic sur la puce : l’instrument de l’entraînement actif`, !!(await until(`window.__mia.state.view === 'train' && (document.querySelector('#view-train .tr-run .tr-title') || {}).textContent === 'Rosa'`, 8000)));
  // essai en cours (pas 1 000)
  check(`${lang} · essai : atteint`, !!(await waitState(ids.rosa, `s.state === 'essai' && s.sampleStep && s.sampleStep.n >= 2`, 120000)), await getState(ids.rosa));
  await settle(700);
  s = await snap();
  check(`${lang} · essai : « ${W.sample} 1 000 · … ${W.render} … », barre figée, tuile en cours`, (s.c[0] || '').startsWith(W.sample) && s.c[0].includes(W.render) && (s.bar || '').includes('b-frozen') && s.running, s);
  check(`${lang} · essai : « ${W.resumesIn} ≈ … » et puce « LORA · ROSA · ${W.chipSample} »`, s.c.some((x) => x.startsWith(W.resumesIn)) && (s.chip || '').endsWith(W.chipSample), s);
  await look('essai', lang, { primary: 0 });
  // la fin de l'essai, suivie de près : la durée disparaît sous une seconde, jamais « ≈ 0 S »
  const zero = await until(`(() => { const p = [...document.querySelectorAll('#view-train .tr-c-part')].map((n) => n.textContent); if (p.some((t) => /≈ 0 S$/.test(t))) return 'zéro'; return p[0] && !p[0].startsWith(${J(W.sample)}) ? 'fini' : null; })()`, 30000, 50);
  check(`${lang} · essai : jusqu’à sa fin, jamais « ${W.resumesIn} ≈ 0 S »`, zero === 'fini', zero);
  // pause : par le bouton de l'écran, après l'essai
  await waitState(ids.rosa, `s.state === 'entrainement' && s.step >= 1030`, 60000);
  await ev(`(document.querySelector('#view-train [data-act="pause"]').click(), 1)`);
  check(`${lang} · pause : atteinte par le bouton`, !!(await waitState(ids.rosa, `s.state === 'pause'`, 30000)), await getState(ids.rosa));
  await pausePage(lang);
}

async function pausePage(lang) {
  const W = WORDS[lang];
  await until(`(document.querySelector('#view-train .tr-c-part') || {}).textContent.startsWith(${J(W.pauseAt)})`, 8000);
  await settle(400);
  const s = await snap();
  check(`${lang} · pause : « ${W.pauseAt} … · ${W.paused} », barre grise`, (s.c[0] || '').startsWith(W.pauseAt) && s.c[0].endsWith(W.paused) && (s.bar || '').includes('b-paused'), s);
  check(`${lang} · pause : [${W.bResume}] [${W.bStop}], puce « LORA · ROSA · ${W.chipPaused} »`, s.acts.map((a) => a.text).join('|') === `${W.bResume}|${W.bStop}` && (s.chip || '').endsWith(W.chipPaused), s);
  // ÉVÈNEMENTS dit « Pause au pas … », comme la ligne C — jamais « Arrêt au pas » pour une pause
  check(`${lang} · pause : ÉVÈNEMENTS se termine par « ${W.evPaused} … », sans « ${W.evStopped} »`, s.events.some((e) => e.startsWith(W.evPaused)) && !s.events.some((e) => e.startsWith(W.evStopped)), s.events.slice(-4));
  await look('pause', lang, { primary: 0 });
  await proposalPass(lang, ids.rosa, 'pause', 0);
}

/** Rosa en anglais : la fenêtre a été rechargée pendant la pause ; reprise, en cours, essai, fin. */
async function rosaSecondHalf(lang) {
  const W = WORDS[lang];
  await open(ids.rosa);
  await pausePage(lang);
  await ev(`(document.querySelector('#view-train [data-act="resume"]').click(), 1)`);
  check(`${lang} · reprise par le bouton : repart du point de contrôle`, !!(await waitState(ids.rosa, `s.state === 'entrainement' && s.step > s.resumedFrom && s.resumedFrom >= 1000`, 60000)), await getState(ids.rosa));
  await waitState(ids.rosa, `s.state === 'entrainement' && s.step >= 1180`, 60000);
  await settle(1200);
  let s = await snap();
  check(`${lang} · en cours : ligne d’état complète`, s.c[0] === W.training && s.c.some((x) => x.includes(W.left)) && s.c.some((x) => x.startsWith(W.ends)) && s.c.some((x) => x.includes(W.last)), s.c);
  check(`${lang} · en cours : la courbe et les essais sont revenus après le rechargement de la fenêtre`, s.tilesHave >= 2 && s.big === 'video' && s.cks.length >= 4 && s.events.includes(W.note), s);
  await look('en-cours', lang, { primary: 0 });
  check(`${lang} · essai : atteint`, !!(await waitState(ids.rosa, `s.state === 'essai' && s.sampleStep && s.sampleStep.n >= 2`, 120000)), await getState(ids.rosa));
  await settle(700);
  s = await snap();
  check(`${lang} · essai : « ${W.sample} 1,500 · ${W.render} … »`, (s.c[0] || '').startsWith(W.sample) && s.c[0].includes(W.render) && s.running, s.c);
  await look('essai', lang, { primary: 0 });
  // la fin : la puce dit FINI tant que l'écran n'a pas été rouvert
  await ev(`(window.__mia.app.goHome(), 1)`);
  check(`${lang} · fin : Rosa va au bout`, !!(await waitState(ids.rosa, `s.state === 'fini'`, 240000)), await getState(ids.rosa));
  check(`${lang} · fin : puce « LORA · ROSA · ${W.chipDone} » tant que l’écran n’est pas ouvert`, !!(await until(`(document.querySelector('#tb-train .tr-chip-txt').textContent || '').endsWith(${J(W.chipDone)})`, 8000)), (await snap()).chip);
  await ev(`(document.getElementById('tb-train').click(), 1)`);
  await until(`window.__mia.state.view === 'train' && (document.querySelector('#view-train .tr-run .tr-title') || {}).textContent === 'Rosa'`, 8000);
  await donePage(lang, ids.rosa, 'Rosa', 'video');
  check(`${lang} · fin : puce revenue à « ${W.rest} » une fois l’écran ouvert`, !!(await until(`document.querySelector('#tb-train .tr-chip-txt').textContent === ${J(W.rest)}`, 8000)), (await snap()).chip);
}

/** Retour à la planche quittée : « ‹ Retour à … », l'onglet se rallume. */
async function backToBoard(lang) {
  const W = WORDS[lang];
  const made = await ev(`window.__mia.app.createProject({ name: 'Planche 3' }).then((r) => r && r.id)`);
  check(`${lang} · retour : une planche est ouverte`, !!made && (await ev(`window.__mia.state.view`)) === 'board');
  await ev(`(document.getElementById('tb-train').click(), 1)`);
  await until(`window.__mia.state.view === 'train'`, 8000);
  await settle(300);
  let s = await snap();
  check(`${lang} · retour : « ${W.back}Planche 3 » en tête, onglet de la planche éteint`, s.crumbs[0] === `${W.back}Planche 3` && !s.activeTab, s);
  await look('liste-depuis-planche', lang, { sizes: [SIZES[0]], primary: 1 });
  await ev(`(document.querySelector('#view-train .tr-head .tr-link').click(), 1)`);
  check(`${lang} · retour : le lien ramène à la planche`, !!(await until(`window.__mia.state.view === 'board' && window.__mia.state.project && window.__mia.state.project.id === ${J(made)}`, 10000)));
  await ev(`(window.__mia.app.goHome(), 1)`);
  await until(`window.__mia.state.view === 'home'`, 8000);
}

// ── déroulé ───────────────────────────────────────────────────────────
let code = 0;
let firstLang = null;
try {
  fs.mkdirSync(OUT, { recursive: true });
  await screencast(true);
  await waitReady(null);
  const info = await ev('window.mia.app.info()');
  const realData = process.env.APPDATA ? path.join(process.env.APPDATA, 'Mia', 'data') : null;
  if (!info?.dataDir || (realData && path.resolve(info.dataDir).toLowerCase() === path.resolve(realData).toLowerCase())) {
    throw new Error('cette Mia utilise les données de tous les jours : lancer une instance de test (MIA_USERDATA, MIA_PROJECTS_ROOT)');
  }
  const opts = await T('options()');
  if (!opts || !(opts.bases || []).some((b) => b.id === 'fake')) throw new Error('cette Mia n’a pas le faux outil d’entraînement : la lancer avec MIA_TRAIN_FAKE=1');
  if ((await T('list()')).length) throw new Error('cette Mia a déjà des entraînements : repartir d’un dossier de données neuf (MIA_USERDATA)');
  await ev(`(async () => { await window.mia.prefs.set({ welcomeLater: Date.now() }); const w = document.getElementById('welcome'); if (w) w.remove(); return 1; })()`);
  firstLang = await ev('document.documentElement.lang');
  log(`Mia ${info.version} · port ${port} · langues ${LANGS.join(', ')} · captures : ${OUT}`);

  // le jeu d'images, à côté des données de test (jamais dans le dépôt ni dans le profil)
  const setRoot = path.join(path.dirname(info.dataDir), 'jeu-de-test');
  const imgs = {
    full: makeSet(path.join(setRoot, 'douze'), { n: 12, prefix: 'img' }),
    rosa: makeSet(path.join(setRoot, 'rosa'), { n: 32, prefix: 'rosa' }),
    partial: makeSet(path.join(setRoot, 'lena'), { n: 12, captions: 9, small: 2, tiny: 1, other: 2, prefix: 'lena' })
  };

  const [l1, l2] = [LANGS[0], LANGS[1] || null];
  await setLang(l1);
  await setViewport(...SIZES[0]);
  let s = await snap();
  check(`${l1} · repos : la puce dit « ${WORDS[l1].rest} », sans jauge`, s.chip === WORDS[l1].rest && !s.chipGauge, s.chip);
  await open(null);
  check(`${l1} · liste vide : la phrase d’accueil`, /Glisse un dossier|Drop a folder/.test((await ev(`(document.querySelector('#view-train .tr-empty-list') || {}).textContent || ''`)) || ''));
  await look('liste-vide', l1, { sizes: [SIZES[0]], primary: 1 });
  log('décor…');
  await setup(imgs);
  s = await snap();
  check(`${l1} · puce : « LORA · ATELIER · ${WORDS[l1].chipError} » (erreur pas encore vue), en rouge`, (s.chip || '') === `LORA · ATELIER · ${WORDS[l1].chipError}` && s.chipClass.includes('err'), s);
  log(`${l1} : liste et brouillon…`);
  await listAndDraft(l1);
  log(`${l1} : erreur, fin, arrêt…`);
  await errorPage(l1);
  s = await snap();
  check(`${l1} · puce : « LORA · AIDA · ${WORDS[l1].chipDone} » (fini pas encore vu)`, (s.chip || '') === `LORA · AIDA · ${WORDS[l1].chipDone}`, s.chip);
  await donePage(l1, ids.aida, 'Aida');
  await tryBoard(l1, ids.aida, 'Aida', 'aida woman');
  await longName(l1, true);
  await stopPage(l1);
  await backToBoard(l1);
  log(`${l1} : Rosa — chargement, en cours, essai, pause…`);
  await rosaFirstHalf(l1);
  if (l2) {
    log(`${l2} : rechargement de la fenêtre pendant la pause…`);
    await setLang(l2);
    await setViewport(...SIZES[0]);
    s = await snap();
    check(`${l2} · rechargement de la fenêtre : la puce retrouve l’entraînement en pause`, (s.chip || '') === `LORA · ROSA · ${WORDS[l2].chipPaused}`, s.chip);
    await listAndDraft(l2);
    await errorPage(l2);
    await longName(l2, false);
    log(`${l2} : Rosa — pause, reprise, en cours, essai, fin…`);
    await rosaSecondHalf(l2);
  } else {
    await ev(`window.mia.train.control(${J(ids.rosa)}, 'stop')`);
  }
  check('aucune erreur dans la console de la page', pageErrors.length === 0, pageErrors.slice(0, 5));
} catch (err) {
  console.error(`\nL'outil n'a pas pu aller au bout : ${err.message}`);
  code = 2;
} finally {
  try { await send('Emulation.clearDeviceMetricsOverride', {}, 3000); } catch { /* page partie */ }
  try { if (firstLang && firstLang !== (await ev('document.documentElement.lang'))) await setLang(firstLang); } catch { /* idem */ }
  try { await screencast(false); } catch { /* idem */ }
  ws.close();
}
console.log(`\n${passed} contrôles réussis, ${failures.length} en échec${SHOTS ? ` · ${shots.length} captures dans ${OUT}` : ''}`);
if (failures.length) { console.log('En échec :'); for (const f of failures) console.log('  - ' + f); }
process.exit(code || (failures.length ? 1 : 0));
