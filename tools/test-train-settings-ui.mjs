// Réglages → Entraînement (CONCEPTION-entrainement §2.6, §4.2), VU dans une Mia de test sans GPU : l'outil pilote la
// fenêtre par CDP, en français puis en anglais.
//
//   node tools/test-train-settings-ui.mjs <port CDP> --userdata <le MIA_USERDATA de cette Mia> [--shots <dossier>]
//
// À lancer UNIQUEMENT sur une Mia de test neuve :
//   MIA_HEADLESS=1  MIA_NO_GPU=1  MIA_TRAIN_FAKE=1  MIA_USERDATA=<dossier neuf>  MIA_PROJECTS_ROOT=<dossier neuf>
//   node_modules\electron\dist\electron.exe . --remote-debugging-port=<port>
// Contrôles : la section « Entraînement » (dossier des entraînements, outils et leur état) ; un dossier d'outils tapé
// est détecté (LTX prêt · ltx-trainer 1.6.2, version non validée, introuvable) ; « Par défaut » ; un dossier des
// entraînements refusé (dans les projets, chemin relatif) ou accepté sans être créé ; champ bloqué pendant un
// entraînement ; mêmes contrôles en anglais ; aucun <select>, aucun title=, rien ne dépasse. Les outils factices sont
// de simples fichiers vides créés à côté du dossier de données : aucun Python n'est lancé. La langue revient au
// français à la fin. Code de sortie : 0 tout est bon, 1 des contrôles en échec, 2 l'outil n'a pas pu travailler.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
const port = Number(args.find((a) => /^\d+$/.test(a)));
const opt = (k) => (args.includes(k) ? path.resolve(args[args.indexOf(k) + 1]) : null);
const ud = opt('--userdata');
const shots = opt('--shots');
if (!Number.isInteger(port) || !ud) { console.error('usage : node tools/test-train-settings-ui.mjs <port CDP> --userdata <dossier> [--shots <dossier>]'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => JSON.stringify(v);
let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok    ${name}`); return true; }
  failures.push(name);
  console.log(`  ÉCHEC ${name}${detail !== undefined ? ` → ${JSON.stringify(detail)}` : ''}`);
  return false;
}

// ── fixtures : des dossiers d'outils factices (fichiers vides) et un petit jeu d'images ──
const BENCH = path.join(ud, '..', 'reglages-banc');
function fakeTools(dir, { ltx = '1.6.2', aitk = false } = {}) {
  fs.mkdirSync(path.join(dir, 'venv-ltx', 'Scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'venv-ltx', 'Scripts', 'python.exe'), '');
  fs.mkdirSync(path.join(dir, 'venv-ltx', 'Lib', 'site-packages', `ltx_trainer-${ltx}.dist-info`), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'LTX-2', 'packages', 'ltx-trainer', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'LTX-2', 'packages', 'ltx-trainer', 'scripts', 'preprocess.py'), '');
  if (aitk) {
    fs.mkdirSync(path.join(dir, 'venv-aitk', 'Scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'venv-aitk', 'Scripts', 'python.exe'), '');
    fs.mkdirSync(path.join(dir, 'src', 'ai-toolkit'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'ai-toolkit', 'run.py'), '');
  }
  return dir;
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(w, h, k) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([(x * 3 + k * 20) & 255, (y * 2) & 255, (k * 40) & 255], y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ── CDP ──
let list;
try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { console.error(`Aucune Mia sur le port ${port}.`); process.exit(2); }
let target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) || list.find((t) => t.type === 'page');
if (!target) { console.error('Aucune page Mia sur ce port.'); process.exit(2); }
let ws = null;
let msgId = 0;
const pend = new Map();
async function connect() {
  const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  target = l.find((t) => t.type === 'page' && /index\.html/.test(t.url)) || l.find((t) => t.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  ws.onclose = () => { for (const f of pend.values()) f({ error: { message: 'fermé' } }); pend.clear(); };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('connexion CDP refusée')); });
}
const send = (method, params = {}, ms = 30000) => new Promise((resolve, reject) => {
  const i = ++msgId;
  const t = setTimeout(() => { pend.delete(i); reject(new Error(`CDP : pas de réponse à ${method}`)); }, ms);
  pend.set(i, (d) => { clearTimeout(t); resolve(d); });
  try { ws.send(JSON.stringify({ id: i, method, params })); } catch (e) { clearTimeout(t); pend.delete(i); reject(e); }
});
async function ev(expr, ms = 30000) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, ms);
  if (r.error) throw new Error(r.error.message);
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'évaluation');
  return r.result?.result?.value;
}
async function until(expr, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await ev(expr).catch(() => null); if (v) return v; await sleep(120); }
  return null;
}
const ready = (lang) => until(`(() => document.readyState === 'complete' && !!(window.mia && window.mia.train && document.getElementById('tb-settings')) && document.documentElement.lang === ${J(lang)})()`, 45000);

async function setLang(lang) {
  if ((await ev('document.documentElement.lang')) === lang) return;
  await ev(`(async () => { const m = await import(new URL('js/i18n.js', location.href).href); setTimeout(() => m.setLang(${J(lang)}), 0); return 1; })()`).catch(() => 0);
  await sleep(1500);
  for (let k = 0; k < 40; k++) {
    try { try { ws.close(); } catch { /* gone */ } await connect(); if (await ready(lang)) return; } catch { /* the window is rebuilding */ }
    await sleep(500);
  }
  throw new Error(`la fenêtre n’est pas revenue en ${lang}`);
}

const openSettings = () => ev(`(async () => { const m = await import(new URL('js/ui/settings.js', location.href).href); m.openSettings({ section: 'train' }); return 1; })()`);
const closeSettings = () => ev(`(() => { const b = document.querySelector('.settings .set-close'); if (b) b.click(); return !!b; })()`);
/** What the section shows: its title, its rows (name, field, buttons, note), the tool lines, the former folders. */
const read = () => ev(`(() => {
  const box = document.querySelector('.modal.settings, .settings');
  const sec = box && box.querySelector('.set-train-sec');
  if (!sec) return null;
  const row = (k) => {
    const r = box.querySelector('.set-row[data-train="' + k + '"]');
    if (!r) return null;
    const f = r.querySelector('input.tf');
    return {
      name: r.querySelector('.set-name').textContent, hint: r.querySelector('.set-hint').textContent, value: f.value,
      disabled: f.disabled, note: r.querySelector('.set-train-note').textContent,
      buttons: [...r.querySelectorAll('.set-ctl .btn')].filter((b) => !b.hidden).map((b) => b.textContent.trim() || 'icone')
    };
  };
  return {
    title: sec.textContent, root: row('trainRoot'), tools: row('trainTools'),
    lines: [...box.querySelectorAll('.set-tools .set-tool')].map((l) => ({ id: l.dataset.tool || null, on: l.classList.contains('on'), text: l.querySelector('.set-tool-text').textContent, path: (l.querySelector('.set-path') || {}).textContent || '' }))
  };
})()`);
const type = (k, v) => ev(`(() => { const f = document.querySelector('.settings .set-row[data-train="${k}"] input.tf'); f.focus(); f.value = ${J(v)}; f.dispatchEvent(new Event('change')); f.blur(); return 1; })()`);
const clickDefault = (k) => ev(`(() => { const b = [...document.querySelectorAll('.settings .set-row[data-train="${k}"] .set-ctl .btn')].find((x) => !x.hidden && /Par défaut|Default/.test(x.textContent)); if (!b) return false; b.click(); return true; })()`);
const prefs = () => ev('window.mia.prefs.get()');
const lastToast = () => ev(`(() => { const t = [...document.querySelectorAll('#toasts .toast-msg')]; return t.length ? t[t.length - 1].textContent : ''; })()`);
const lineOf = (s, id) => (s && s.lines.find((l) => l.id === id)) || null;
/** House rules of the dialog: no <select>, no title=, nothing sticking out of the box or cut in the section. */
const house = () => ev(`(() => {
  const box = document.querySelector('.settings');
  const b = box.getBoundingClientRect();
  const sec = box.querySelector('.set-train-sec');
  const nodes = [];
  for (let n = sec; n && !(n !== sec && n.classList && n.classList.contains('set-sec')); n = n.nextElementSibling) nodes.push(n);
  const out = [];
  for (const n of nodes) for (const e of [n, ...n.querySelectorAll('*')]) {
    const r = e.getBoundingClientRect();
    if (!r.width) continue;
    if (r.right > b.right + 0.5 || r.left < b.left - 0.5) out.push('dépasse : ' + (e.className || e.tagName));
    const cut = e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible';
    // a path (and a typed path) is cut from the left on purpose, the full path in a tip; nothing else may be cut
    if (cut && !e.matches('.set-path, .set-path *, input.tf')) out.push('coupé : ' + (e.className || e.tagName) + ' « ' + e.textContent.slice(0, 60) + ' »');
  }
  return { selects: box.querySelectorAll('select').length, titles: box.querySelectorAll('[title]').length, scrollX: box.scrollWidth > box.clientWidth + 1, bad: out };
})()`);

async function screenshot(name) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await ev(`(() => { const s = document.querySelector('.settings .set-train-sec'); if (s) s.scrollIntoView({ block: 'start' }); return 1; })()`);
  await sleep(450);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result) { fs.writeFileSync(path.join(shots, name), Buffer.from(r.result.data, 'base64')); console.log(`  capture : ${path.join(shots, name)}`); }
  else check(`capture ${name}`, false, r.error);
}

const W = {
  fr: {
    sec: 'Entraînement', root: 'Dossier des entraînements', tools: 'Outils d’entraînement', def: 'Par défaut', browse: 'Parcourir…',
    test: /^Instance de test : ses entraînements restent dans ses propres données\. · [\d\s,]+ Go libres$/,
    fake: 'Faux outil (test) : prêt · 1.0.0', ltxOk: 'LTX : prêt · ltx-trainer 1.6.2', aitkOk: 'Qwen / Flux : prêt · pas encore essayé sur cette machine',
    ltx17: 'LTX : version 1.7.0 non validée', ltxMissing: 'LTX : introuvable', aitkMissing: 'Qwen / Flux : introuvable', isDefault: 'Emplacement par défaut',
    inProjects: /ne peut pas être dans le dossier des projets/, badPath: /n’est pas un chemin de dossier complet/, busy: /^Un entraînement est en cours \(Rosa\) : le dossier ne peut pas changer\.$/
  },
  en: {
    sec: 'Training', root: 'Trainings folder', tools: 'Training tools', def: 'Default', browse: 'Browse…',
    test: /^Test instance: its trainings stay in its own data folder\. · [\d.,]+ GB free$/,
    fake: 'Fake tool (test): ready · 1.0.0', ltxOk: 'LTX: ready · ltx-trainer 1.6.2', aitkOk: 'Qwen / Flux: ready · not tried on this machine yet',
    ltx17: 'LTX: version 1.7.0 not validated', ltxMissing: 'LTX: not found', aitkMissing: 'Qwen / Flux: not found', isDefault: 'Default place',
    inProjects: /cannot be inside the projects folder/, badPath: /is not a full folder path/, busy: /^A training is running \(Rosa\): the folder cannot change\.$/
  }
};

async function round(lang) {
  const w = W[lang];
  await openSettings();
  const s0 = await until(`(() => document.querySelectorAll('.settings .set-tools .set-tool[data-tool]').length ? 1 : 0)()`, 15000);
  check(`${lang} · Réglages : la section « ${w.sec} » s’affiche avec l’état des outils`, !!s0);
  let s = await read();
  check(`${lang} · titres : « ${w.root} », « ${w.tools} »`, s && s.title === w.sec && s.root.name === w.root && s.tools.name === w.tools, s && [s.title, s.root.name, s.tools.name]);
  check(`${lang} · dossier des entraînements : champ, « ${w.browse} », dossier (pas de « ${w.def} » tant que rien n’est choisi)`, s.root.buttons.join('|') === `${w.browse}|icone` && !s.root.disabled, s.root.buttons);
  check(`${lang} · instance de test : le dossier en service est dit, avec la place libre`, w.test.test(s.root.note) && s.root.value === path.join(ud, 'training'), [s.root.note, s.root.value]);
  check(`${lang} · le faux outil de cette instance : « ${w.fake} »`, lineOf(s, 'fake')?.text === w.fake && lineOf(s, 'fake')?.on === true, s.lines);
  check(`${lang} · LTX et Qwen / Flux : une ligne chacun`, !!lineOf(s, 'ltx') && !!lineOf(s, 'aitk'), s.lines);

  // un dossier d'outils tapé (Entrée) : la détection suit, rien n'est lancé
  const ok = fakeTools(path.join(BENCH, `outils-${lang}`), { ltx: '1.6.2', aitk: true });
  await type('trainTools', ok);
  s = await until(`(async () => { const p = await window.mia.prefs.get(); return p.trainTools === ${J(ok)} ? 1 : 0; })()`, 8000) && await until(`(() => { const l = document.querySelector('.settings .set-tool[data-tool="ltx"]'); return l && l.classList.contains('on') ? 1 : 0; })()`, 8000) && await read();
  check(`${lang} · dossier d’outils choisi : « ${w.ltxOk} »`, s && lineOf(s, 'ltx')?.text === w.ltxOk && lineOf(s, 'ltx')?.on, s && s.lines);
  check(`${lang} · … « ${w.aitkOk} »`, s && lineOf(s, 'aitk')?.text === w.aitkOk, s && s.lines);
  check(`${lang} · … gardé dans les réglages, « ${w.def} » apparaît`, s && s.tools.value === ok && s.tools.buttons.includes(w.def), s && s.tools);
  await screenshot(`reglages-${lang}.png`);
  const h = await house();
  check(`${lang} · aucun <select>, aucun attribut title, rien ne dépasse ni n’est coupé`, h.selects === 0 && h.titles === 0 && !h.scrollX && h.bad.length === 0, h);

  const v17 = fakeTools(path.join(BENCH, `outils17-${lang}`), { ltx: '1.7.0' });
  await type('trainTools', v17);
  await until(`(async () => { const p = await window.mia.prefs.get(); return p.trainTools === ${J(v17)} ? 1 : 0; })()`, 8000);
  await until(`(() => { const l = document.querySelector('.settings .set-tool[data-tool="ltx"]'); return l && !l.classList.contains('on') ? 1 : 0; })()`, 8000);
  s = await read();
  check(`${lang} · ltx-trainer 1.7.0 : « ${w.ltx17} »`, s && lineOf(s, 'ltx')?.text === w.ltx17 && !lineOf(s, 'ltx')?.on, s && s.lines);
  check(`${lang} · … ai-toolkit absent : « ${w.aitkMissing} » avec le chemin qui manque`, s && lineOf(s, 'aitk')?.text === w.aitkMissing && /venv-aitk$/.test(lineOf(s, 'aitk')?.path || ''), s && s.lines);
  await clickDefault('trainTools');
  await until(`(async () => (await window.mia.prefs.get()).trainTools === '' ? 1 : 0)()`, 8000);
  await sleep(300);
  s = await read();
  check(`${lang} · « ${w.def} » : réglage vidé, bouton retiré, « ${w.isDefault} »`, (await prefs()).trainTools === '' && !s.tools.buttons.includes(w.def) && s.tools.note === w.isDefault, s.tools);

  // le dossier des entraînements : refusé dans les projets, refusé relatif, accepté ailleurs sans être créé
  const proj = (await ev('window.mia.app.info()'))?.projectsRoot || (await prefs()).projectsRoot;
  const before = (await prefs()).trainRoot;
  await type('trainRoot', path.join(proj, 'LoRA'));
  await sleep(600);
  check(`${lang} · un dossier dans les projets : refusé avec la phrase du magasin, champ remis`, w.inProjects.test(await lastToast()) && (await prefs()).trainRoot === before && (await read()).root.value === path.join(ud, 'training'), await lastToast());
  await type('trainRoot', 'entrainements');
  await sleep(400);
  check(`${lang} · un chemin relatif : refusé`, w.badPath.test(await lastToast()) && (await prefs()).trainRoot === before);
  const chosen = path.join(BENCH, `choisi-${lang}`, 'entrainements');
  await type('trainRoot', chosen);
  await until(`(async () => (await window.mia.prefs.get()).trainRoot === ${J(chosen)} ? 1 : 0)()`, 8000);
  await sleep(300);
  s = await read();
  check(`${lang} · un dossier ailleurs : gardé, « ${w.def} » apparaît, dossier non créé`, s.root.value === chosen && s.root.buttons.includes(w.def) && !fs.existsSync(chosen), s.root);
  check(`${lang} · … cette instance de test garde ses entraînements chez elle (et le dit)`, w.test.test(s.root.note), s.root.note);
  await clickDefault('trainRoot');
  await until(`(async () => (await window.mia.prefs.get()).trainRoot === '' ? 1 : 0)()`, 8000);
  check(`${lang} · « ${w.def} » : retour à l’emplacement par défaut`, (await prefs()).trainRoot === '');
  await closeSettings();
  await sleep(400);
}

try {
  await connect();
  if (!(await until(`!!(window.mia && window.mia.train && document.getElementById('tb-settings'))`, 45000))) throw new Error('la fenêtre de Mia n’est pas prête');
  const o = await ev('window.mia.train.options()');
  if (!o || !(o.bases || []).some((b) => b.id === 'fake')) throw new Error('cette Mia n’a pas le faux outil : MIA_TRAIN_FAKE=1');
  if (!o.folders || !o.folders.test) throw new Error('cette Mia n’est pas une instance de test (MIA_USERDATA)');
  fs.mkdirSync(BENCH, { recursive: true });
  await setLang('fr');

  await round('fr');

  // pendant un entraînement, le dossier des entraînements ne peut pas changer : le champ le dit et se bloque
  const set = path.join(BENCH, 'jeu');
  fs.mkdirSync(set, { recursive: true });
  for (let k = 1; k <= 12; k++) { fs.writeFileSync(path.join(set, `img_${k}.png`), png(96, 96, k)); fs.writeFileSync(path.join(set, `img_${k}.txt`), `a portrait, number ${k}`); }
  const T = (call) => ev(`window.mia.train.${call}`);
  const r = await T(`create(${J({ name: 'Rosa', base: 'fake', kind: 'character', trigger: 'rsa woman', fake: { msPerStep: 30, encodeMs: 50, loadMs: 50 } })})`);
  await T(`update(${J(r.id)}, ${J({ steps: 100000, settings: { saveEvery: 1000, sampleEvery: 0 } })})`);
  await T(`addImages(${J(r.id)}, ${J([set])})`);
  await until(`window.mia.train.get(${J(r.id)}).then((s) => !s.importing)`, 60000);
  const st = await T(`start(${J(r.id)})`);
  check('décor : un entraînement du faux outil part', st && st.ok !== false, st);
  check('décor : il est en cours', !!(await until(`window.mia.train.get(${J(r.id)}).then((s) => s.state === 'entrainement')`, 60000)));
  for (const lang of ['fr', 'en']) {
    if (lang === 'en') await setLang('en');
    await openSettings();
    await until(`(() => document.querySelectorAll('.settings .set-tools .set-tool[data-tool]').length ? 1 : 0)()`, 15000);
    const s = await read();
    check(`${lang} · entraînement en cours : champ et boutons bloqués, la raison est dite`, s.root.disabled && W[lang].busy.test(s.root.note), s.root);
    const b4 = (await prefs()).trainRoot;
    await ev(`(() => { const f = document.querySelector('.settings .set-row[data-train="trainRoot"] input.tf'); f.disabled = false; f.value = ${J(path.join(BENCH, 'pendant'))}; f.dispatchEvent(new Event('change')); return 1; })()`);
    await sleep(600);
    check(`${lang} · … et même forcé, rien ne change`, (await prefs()).trainRoot === b4);
    await closeSettings();
    await sleep(300);
  }
  await T(`control(${J(r.id)}, 'stop')`);
  await until(`window.mia.train.get(${J(r.id)}).then((s) => !['attente', 'preparation', 'entrainement', 'essai'].includes(s.state))`, 60000);

  await round('en');
  await setLang('fr');
} catch (e) {
  console.error(`L’outil n’a pas pu travailler : ${e.message}`);
  process.exit(2);
}
try { ws.close(); } catch { /* gone */ }
console.log(`\n${passed} contrôles réussis, ${failures.length} en échec.`);
process.exit(failures.length ? 1 : 0);
