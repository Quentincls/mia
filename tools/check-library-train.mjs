// La bibliothèque VUE dans une Mia de test, côté LoRA entraînés dans Mia (CONCEPTION-entrainement §2.6, §4.6, cas 23
// et 24) : le bouton « Entraîner un LoRA » de l'en-tête de « Mes LoRA », la mention « ENTRAÎNÉ ICI · 300 PAS », les
// étapes intermédiaires repliées sous leur LoRA final, les menus « Voir l'entraînement » et « Retirer de Mes LoRA ».
// En français puis en anglais ; captures bibliotheque-fr.png, bibliotheque-en.png, bibliotheque-menu-fr.png.
//
//   node tools/check-library-train.mjs <port CDP> [--out <dossier>]
//
// À lancer UNIQUEMENT sur une Mia de test, avec le faux outil :
//   MIA_HEADLESS=1  MIA_NO_GPU=1  MIA_TRAIN_FAKE=1  MIA_USERDATA=<dossier neuf>  MIA_PROJECTS_ROOT=<dossier neuf>
//   node_modules\electron\dist\electron.exe . --remote-debugging-port=<port>
// L'outil refuse une Mia dont les données sont celles de tous les jours, une Mia sans faux outil, et une Mia qui a déjà
// des entraînements. Il fait deux faux entraînements (quelques secondes), range leurs points dans <userData>\loras-mia
// (la place des LoRA d'une Mia de test, electron/trainer.js lorasDir) et y remplace chaque fichier rangé par un faux
// LoRA lisible par le scanner (le faux outil écrit 1 Ko, que le scanner ne prend pas pour un LoRA) ; dans les fiches,
// seule la base passe de « fake » à « ltx25 » (le faux modèle n'est celui de personne). Rien ne va à la
// corbeille de Windows : la question « Retirer de Mes LoRA » est posée puis refusée — le retrait lui-même est vérifié
// par tools/test-scanner.js, avec une corbeille de banc.
// Code de sortie : 0 tout est bon, 1 des contrôles en échec, 2 l'outil n'a pas pu travailler.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def = null) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def; };
const port = Number(args.find((a) => /^\d+$/.test(a)));
if (!Number.isInteger(port) || port <= 0) { console.error('usage : node tools/check-library-train.mjs <port CDP> [--out <dossier>]'); process.exit(2); }
const OUT = path.resolve(opt('--out', path.join(ROOT, '_dev', 'captures-train', 'lot6')));
const W = 1440, H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => JSON.stringify(v);

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok     ${name}`); return true; }
  failures.push(name);
  console.log(`  ÉCHEC  ${name}${detail !== undefined ? `\n         ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 600)}` : ''}`);
  return false;
}

// ── fichiers du décor ────────────────────────────────────────────────
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(w, h, k) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([30 + ((x * k) % 90), 30 + ((y * 3) % 60), 40 + k * 7], y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function makeSet(dir, n) {
  fs.mkdirSync(dir, { recursive: true });
  for (let k = 1; k <= n; k++) {
    fs.writeFileSync(path.join(dir, `img_${String(k).padStart(2, '0')}.png`), png(128, 192, k));
    fs.writeFileSync(path.join(dir, `img_${String(k).padStart(2, '0')}.txt`), 'seated by a window, soft light', 'utf8');
  }
  return dir;
}
/** Un faux LoRA LTX (clés diffusers, largeur 4096, rang 16) : celui de tools/test-scanner.js, plus de 1 Mo. */
function fakeLora(file, fill) {
  const tensors = {};
  let off = 0;
  const add = (name, shape) => { const n = shape.reduce((a, b) => a * b, 1) * 2; tensors[name] = { dtype: 'BF16', shape, data_offsets: [off, off + n] }; off += n; };
  for (let b = 0; b < 2; b++) for (const at of ['attn1', 'attn2']) for (const pr of ['to_q', 'to_k']) {
    add(`diffusion_model.transformer_blocks.${b}.${at}.${pr}.lora_A.weight`, [16, 4096]);
    add(`diffusion_model.transformer_blocks.${b}.${at}.${pr}.lora_B.weight`, [4096, 16]);
  }
  const header = Buffer.from(JSON.stringify({ __metadata__: {}, ...tensors }));
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(header.length));
  // le fichier rangé est un lien physique vers le point de l'entraînement : on le délie avant d'écrire (le point garde le sien)
  try { fs.unlinkSync(file); } catch { /* pas encore là */ }
  fs.writeFileSync(file, Buffer.concat([len, header, Buffer.alloc(off, fill)]));
}

// ── CDP ───────────────────────────────────────────────────────────────
let list;
try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { console.error(`Aucune Mia pilotable sur le port ${port}.`); process.exit(2); }
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
// une fenêtre cachée ne peint pas sans screencast : chaque image est acquittée
async function screencast(on) {
  if (casting) { try { await send('Page.stopScreencast', {}, 3000); } catch { /* page partie */ } casting = false; }
  if (on) { await send('Page.startScreencast', { format: 'jpeg', quality: 5, maxWidth: 200, everyNthFrame: 1 }); casting = true; }
}
const settle = (ms = 200) => ev(`new Promise((r) => { let n = 0; const t = setTimeout(r, 500); const f = () => { if (++n >= 2) { clearTimeout(t); r(1); } else requestAnimationFrame(f); }; requestAnimationFrame(f); })`).then(() => sleep(ms));
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
async function shot(name) {
  const file = path.join(OUT, name);
  const r = await send('Page.captureScreenshot', { format: 'png' }, 20000);
  if (r.result?.data) { fs.writeFileSync(file, Buffer.from(r.result.data, 'base64')); console.log(`  capture : ${file}`); return file; }
  check(`capture ${name}`, false, r.error);
  return null;
}
async function mouse(x, y, button = 'left') {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : button, buttons: type === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0, clickCount: 1 });
  }
}
async function key(k) {
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: k === 'Escape' ? 27 : 0 });
}

// ── ce que l'outil pose dans la page ─────────────────────────────────────
const PAGE = `(() => {
const lib = () => document.getElementById('library');
const vis = (n) => { if (!n || !n.isConnected) return false; const r = n.getBoundingClientRect(); if (r.width < 0.5 || r.height < 0.5) return false; const cs = getComputedStyle(n); return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05; };
const text = (n) => (n ? n.textContent.replace(/\\s+/g, ' ').trim() : null);
const sel = (n) => n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\\s+/).slice(0, 3).join('.') : '');
const sec = () => lib().querySelector('.lib-sec-loras');
const rowOf = (name) => [...sec().querySelectorAll('.lib-row')].find((r) => text(r.querySelector('.lib-name')) === name) || null;
function snap() {
  const s = sec();
  if (!s) return null;
  const rows = [...s.querySelectorAll('.lib-row')].filter(vis).map((r) => ({
    name: text(r.querySelector('.lib-name')),
    sub: text(r.querySelector('.lib-row-sub')),
    badge: text(r.querySelector('.lib-trained')),
    badgeShown: r.querySelector('.lib-trained') ? getComputedStyle(r.querySelector('.lib-trained')).textTransform : null,
    nested: !!r.closest('.lib-steps'), id: r.dataset.id }));
  return {
    head: text(s.querySelector('.lib-sec-headrow .lib-sec-title')), train: text(s.querySelector('.lib-sec-headrow .lib-train')),
    stepsToggle: [...s.querySelectorAll('.lib-steps-toggle')].filter(vis).map(text),
    oldToggle: [...s.querySelectorAll('.lib-sub-toggle:not(.lib-steps-toggle)')].filter(vis).map(text),
    rows, add: text(s.querySelector('.lib-sec-actions .btn'))
  };
}
/** Défauts de mise en page dans la section : rogné, hors cadre, frères qui se chevauchent ; règles de la maison. */
function scan() {
  const out = [];
  const s = sec();
  for (const n of s.querySelectorAll('*')) {
    if (!vis(n) || n.closest('svg')) continue;
    const cs = getComputedStyle(n);
    const own = [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join('').trim();
    if (own && n.scrollWidth > n.clientWidth + 1 && /(hidden|clip)/.test(cs.overflowX) && !n.matches('.lib-desc')) out.push({ kind: 'coupé', sel: sel(n), text: own.slice(0, 60) });
  }
  const sr = s.getBoundingClientRect();
  for (const row of s.querySelectorAll('.lib-sec-headrow, .lib-row-top, .lib-row')) {
    if (!vis(row)) continue;
    const r = row.getBoundingClientRect();
    if (r.right > sr.right + 1) out.push({ kind: 'hors cadre', sel: sel(row) });
    const kids = [...row.children].filter(vis);
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
      const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) out.push({ kind: 'chevauche', sel: sel(kids[i]) + ' / ' + sel(kids[j]) });
    }
  }
  const roots = [lib(), document.getElementById('contextmenu'), document.getElementById('modal-root')].filter(Boolean);
  const q = (x) => roots.flatMap((r) => [...r.querySelectorAll(x)]).filter(vis);
  return { found: out, selects: q('select').length, titles: q('[title]').map(sel) };
}
function menu() { const m = document.getElementById('contextmenu'); return m && !m.hidden ? [...m.querySelectorAll('.ctx-label')].map(text) : []; }
function modal() { const m = document.querySelector('.modal-scrim'); return m ? { title: text(m.querySelector('h2')), body: text(m.querySelector('p')), buttons: [...m.querySelectorAll('.btn')].map(text) } : null; }
function toasts() { return [...document.querySelectorAll('#toasts .toast-msg')].map(text); }
window.__lib = { snap, scan, rowOf, menu, modal, toasts, text, vis };
return 'ok';
})()`;

async function waitReady(lang, ms = 45000) {
  const ok = await until(`(() => !!(document.readyState === 'complete' && window.__mia && window.__mia.app && window.mia && window.mia.train && ${lang ? `document.documentElement.lang === ${J(lang)}` : 'true'}))()`, ms, 400);
  if (!ok) throw new Error(`la fenêtre n'est pas revenue (langue ${lang || '?'})`);
  await sleep(1200);
  await screencast(true);
  await ev(PAGE);
}
async function setLang(lang) {
  const cur = await ev('document.documentElement.lang');
  if (cur === lang) return;
  await ev(`(async () => { const m = await import(new URL('js/i18n.js', location.href).href); setTimeout(() => m.setLang(${J(lang)}), 0); return 1; })()`);
  await sleep(1200);
  await waitReady(lang);
}
const LIB = `import(new URL('js/ui/library.js', location.href).href)`;
async function openLib() {
  await ev(`${LIB}.then((m) => { m.openLibrary({}); return 1; })`);
  await until(`!!document.querySelector('#library .lib-sec-loras .lib-row')`, 15000);
  await ev(`(document.querySelector('#library .lib-sec-loras').scrollIntoView({ block: 'start' }), 1)`);
  await settle(450);
}
const closeLib = () => ev(`${LIB}.then((m) => { m.closeLibrary(); return 1; })`).then(() => settle(400));

const WORDS = {
  fr: { own: 'Entraîné par toi.', forLtx: 'pour LTX 2.5', group: 'Mes LoRA', train: 'Entraîner un LoRA', badge: 'Entraîné ici · 300 pas', steps1: '1 étape intermédiaire', step100: /^Rosa · étape 100$/, old1: '1 étape sans son LoRA final',
    atelier: /^Atelier · étape 200$/, show: 'Voir l’entraînement', remove: 'Retirer de Mes LoRA', removeTitle: 'Retirer « Rosa · étape 100 » de Mes LoRA ?',
    removeBody: 'Le fichier et sa fiche vont à la corbeille de Windows. Le point de contrôle reste dans l’entraînement : tu pourras le remettre dans Mes LoRA.',
    removeAlone: 'Le fichier et sa fiche vont à la corbeille de Windows. Son entraînement n’est plus dans Mia : ce fichier en est la seule copie.',
    cancel: 'Annuler', ok: 'Mettre à la corbeille', gone: 'L’entraînement de ce LoRA n’est plus dans Mia.', origin: 'Entraîné dans Mia', training: 'Entraînement' },
  en: { own: 'Trained by you.', forLtx: 'for LTX 2.5', group: 'My LoRAs', train: 'Train a LoRA', badge: 'Trained here · 300 steps', steps1: '1 intermediate step', step100: /^Rosa · step 100$/, old1: '1 step without its final LoRA',
    atelier: /^Atelier · step 200$/, show: 'Show training', remove: 'Remove from My LoRAs', removeTitle: 'Remove “Rosa · step 100” from My LoRAs?',
    removeBody: 'The file and its card go to the Windows Recycle Bin. The checkpoint stays in the training: you can put it back in My LoRAs.',
    removeAlone: 'The file and its card go to the Windows Recycle Bin. Its training is no longer in Mia: this file is its only copy.',
    cancel: 'Cancel', ok: 'Move to Recycle Bin', gone: 'This LoRA’s training is no longer in Mia.', origin: 'Trained in Mia', training: 'Training' }
};

const ids = {};
const files = {};

/** Deux faux entraînements finis ; Rosa range son point final (de lui-même) et le pas 100, Atelier seulement le pas 200. */
async function setup(dataDir) {
  const set = makeSet(path.join(path.dirname(dataDir), 'jeu-bibliotheque'), 12);
  const fake = { msPerStep: 6, encodeMs: 150, loadMs: 200, sampleMs: 150 };
  for (const [k, o] of [['rosa', { name: 'Rosa', kind: 'character', trigger: 'rsa woman' }], ['atelier', { name: 'Atelier', kind: 'place', trigger: 'atl studio' }]]) {
    const r = await ev(`window.mia.train.create(${J({ ...o, base: 'fake', fake })})`);
    if (!r || r.ok === false) throw new Error(`création refusée : ${r && r.error}`);
    ids[k] = r.id;
    await ev(`window.mia.train.update(${J(r.id)}, ${J({ steps: 300, settings: { saveEvery: 100, sampleEvery: 0 } })})`);
    await ev(`window.mia.train.addImages(${J(r.id)}, ${J([set])})`);
    await until(`window.mia.train.get(${J(r.id)}).then((s) => !s.importing)`, 60000);
    const st = await ev(`window.mia.train.start(${J(r.id)})`);
    check(`décor : ${o.name} démarre (faux outil)`, st && st.ok !== false, st);
    check(`décor : ${o.name} va au bout`, !!(await until(`window.mia.train.get(${J(r.id)}).then((s) => s.state === 'fini')`, 90000, 300)));
  }
  const fin = await ev(`window.mia.train.addToLoras(${J(ids.rosa)})`);
  const mid = await ev(`window.mia.train.addToLoras(${J(ids.rosa)}, 100)`);
  const atl = await ev(`window.mia.train.addToLoras(${J(ids.atelier)}, 200)`);
  check('décor : les points sont rangés dans Mes LoRA (<userData>\\loras-mia)', fin?.file && mid?.file && atl?.file && [fin, mid, atl].every((x) => /loras-mia/i.test(x.file)), { fin, mid, atl });
  files.final = fin.file; files.mid = mid.file; files.atelier = atl.file;
  // un LoRA dont l'entraînement n'est plus dans Mia (fiche d'un entraînement inconnu)
  files.orphan = path.join(path.dirname(fin.file), 'Mara_fake_00300.safetensors');
  fs.writeFileSync(files.orphan.replace(/\.safetensors$/, '.mia.json'), JSON.stringify({ name: 'Mara', kind: 'character', trigger: 'mra woman',
    training: { id: 't_disparu', base: 'fake', tool: 'fake 1.0.0', steps: 300, step: 300, images: 12, rank: 32, date: '2026-11-19' } }, null, 1));
  let fill = 20;
  for (const f of [files.final, files.mid, files.atelier, files.orphan]) fakeLora(f, fill++);
  // le faux modèle « fake » n'est le modèle de personne : les fiches disent LTX 2.5, comme après un vrai entraînement
  // LTX (le reste de la fiche est celui qu'a écrit le service) ; la LoRA, ambiguë sans LTX-2 installé, est alors pour LTX 2.5
  for (const f of [files.final, files.mid, files.atelier, files.orphan]) {
    const cf = f.replace(/\.safetensors$/, '.mia.json');
    const c = JSON.parse(fs.readFileSync(cf, 'utf8'));
    check(`décor : la fiche ${path.basename(cf)} porte nom, genre, mot déclencheur et entraînement`, typeof c.name === 'string' && !!c.kind && !!c.trigger && c.training && c.training.steps === 300, c);
    c.training.base = 'ltx25';
    fs.writeFileSync(cf, JSON.stringify(c, null, 1));
  }
  const inv = await ev(`window.mia.models.scan({ queue: true }).then((i) => i.models.filter((m) => m.trainedHere).map((m) => m.label.fr))`);
  check('décor : le scanner voit les quatre LoRA rangés', Array.isArray(inv) && inv.length === 4, inv);
  await until(`(window.__mia.state.inventory?.models || []).filter((m) => m.trainedHere).length === 4`, 15000);
}

async function pass(lang, { menuShot }) {
  const L = WORDS[lang];
  console.log(`\n# ${lang}`);
  await openLib();
  let s = await ev('window.__lib.snap()');
  check(`${lang} · en-tête de « ${L.group} » : bouton « ${L.train} »`, s && s.head === L.group && s.train === L.train, s);
  const rosa = s.rows.find((r) => r.name === 'Rosa');
  check(`${lang} · Rosa : mention « ${L.badge} » (affichée en capitales)`, rosa && rosa.badge === L.badge && rosa.badgeShown === 'uppercase', rosa);
  check(`${lang} · Rosa : « ${L.forLtx} » (la base de sa fiche)`, rosa && (rosa.sub || '').includes(L.forLtx), rosa);
  check(`${lang} · Mara (entraînement disparu) : mention aussi`, s.rows.some((r) => r.name === 'Mara' && r.badge === L.badge), s.rows);
  check(`${lang} · étape de Rosa repliée sous Rosa : « ${L.steps1} »`, s.stepsToggle.length === 1 && s.stepsToggle[0] === L.steps1 && !s.rows.some((r) => L.step100.test(r.name)), s);
  check(`${lang} · étape sans son LoRA final (Atelier) : dans le pli commun d’avant, « ${L.old1} »`, s.oldToggle.length === 1 && s.oldToggle[0] === L.old1, s.oldToggle);
  // dépliage des étapes de Rosa
  await ev(`(document.querySelector('#library .lib-steps-toggle').click(), 1)`);
  await settle(300);
  s = await ev('window.__lib.snap()');
  const step = s.rows.find((r) => L.step100.test(r.name || ''));
  check(`${lang} · dépliée : « Rosa · ${lang === 'fr' ? 'étape' : 'step'} 100 », en retrait sous Rosa, avec sa mention`, step && step.nested && /100/.test(step.badge || ''), s.rows);
  // détail de Rosa : origine et entraînement
  await ev(`(window.__lib.rowOf('Rosa').click(), 1)`);
  await settle(300);
  const det = await ev(`(() => { const d = document.querySelector('#library .lib-detail'); if (!d) return null; const kv = {}; d.querySelectorAll('.lib-kv').forEach((k) => { kv[window.__lib.text(k.querySelector('.lib-k'))] = window.__lib.text(k.querySelector('.lib-v')); }); return { kv, acts: [...d.querySelectorAll('.lib-actions .btn')].map(window.__lib.text) }; })()`);
  check(`${lang} · détail : origine « ${L.origin} », ligne « ${L.training} », boutons « ${L.show} » et « ${L.remove} »`,
    det && Object.values(det.kv).includes(L.origin) && /300/.test(det.kv[L.training] || '') && det.acts.includes(L.show) && det.acts.includes(L.remove), det);
  check(`${lang} · détail : licence « ${L.own} »`, det && Object.values(det.kv).includes(L.own), det && det.kv);
  const sc = await ev('window.__lib.scan()');
  check(`${lang} · rien n’est rogné ni ne se chevauche ; aucun <select>, aucun attribut title`, sc.found.length === 0 && sc.selects === 0 && sc.titles.length === 0, sc);
  await ev(`(document.querySelector('#library .lib-sec-loras').scrollIntoView({ block: 'start' }), 1)`);
  await settle(300);
  await shot(`bibliotheque-${lang}.png`);

  // menu du clic droit sur l'étape de Rosa
  const at = await ev(`(() => { const r = [...document.querySelectorAll('#library .lib-steps .lib-row')][0].getBoundingClientRect(); return [Math.round(r.left + 60), Math.round(r.top + r.height / 2)]; })()`);
  await mouse(at[0], at[1], 'right');
  await settle(300);
  const items = await ev('window.__lib.menu()');
  check(`${lang} · clic droit : « ${L.show} » et « ${L.remove} » (en dernier)`, items.includes(L.show) && items[items.length - 1] === L.remove, items);
  const sc2 = await ev('window.__lib.scan()');
  check(`${lang} · menu : aucun attribut title`, sc2.titles.length === 0, sc2.titles);
  if (menuShot) await shot(menuShot);
  // « Retirer de Mes LoRA » : la question, puis « Annuler » — rien ne bouge
  await ev(`(() => { const it = [...document.querySelectorAll('#contextmenu .ctx-label')].find((n) => window.__lib.text(n) === ${J(L.remove)}); it.closest('[role="menuitem"], .ctx-item, button, div').click(); return 1; })()`);
  const mo = await until(`window.__lib.modal()`, 8000);
  check(`${lang} · retirer : la question d’abord (« ${L.removeTitle} »)`, mo && mo.title === L.removeTitle && mo.body === L.removeBody && mo.buttons.includes(L.cancel) && mo.buttons.includes(L.ok), mo);
  await ev(`(() => { [...document.querySelectorAll('.modal-scrim .btn')].find((b) => window.__lib.text(b) === ${J(L.cancel)}).click(); return 1; })()`);
  await until(`!window.__lib.modal()`, 5000);
  await sleep(500);
  const still = await ev(`window.mia.train.get(${J(ids.rosa)}).then((s) => (s.checkpoints.find((c) => c.step === 100) || {}).added)`);
  check(`${lang} · retirer puis « ${L.cancel} » : le fichier, sa fiche et « Dans Mes LoRA » restent`, fs.existsSync(files.mid) && fs.existsSync(files.mid.replace(/\.safetensors$/, '.mia.json')) && !!still, still);
  // c'est l'entraînement qui a rangé CE fichier : « Mettre à la corbeille » passerait par lui (train.removeFromLoras)
  check(`${lang} · retirer l’étape de Rosa passerait par l’entraînement (il a rangé ce fichier)`, !!still && path.resolve(still.file).toLowerCase() === path.resolve(files.mid).toLowerCase(), still);
  // l'orphelin : la question dit que ce fichier est la seule copie ; « Voir l'entraînement » le dit aussi
  const ao = await ev(`(() => { const r = window.__lib.rowOf('Mara').getBoundingClientRect(); return [Math.round(r.left + 60), Math.round(r.top + r.height / 2)]; })()`);
  await mouse(ao[0], ao[1], 'right');
  await settle(250);
  await ev(`(() => { const it = [...document.querySelectorAll('#contextmenu .ctx-label')].find((n) => window.__lib.text(n) === ${J(L.remove)}); it.closest('[role="menuitem"], .ctx-item, button, div').click(); return 1; })()`);
  const mo2 = await until(`window.__lib.modal()`, 8000);
  check(`${lang} · retirer un LoRA dont l’entraînement a disparu : « …${L.removeAlone.slice(-40)} »`, mo2 && mo2.body === L.removeAlone, mo2);
  await ev(`(() => { [...document.querySelectorAll('.modal-scrim .btn')].find((b) => window.__lib.text(b) === ${J(L.cancel)}).click(); return 1; })()`);
  await until(`!window.__lib.modal()`, 5000);
  check(`${lang} · « ${L.cancel} » : le fichier de Mara reste`, fs.existsSync(files.orphan));
  await mouse(ao[0], ao[1], 'right');
  await settle(250);
  await ev(`(() => { const it = [...document.querySelectorAll('#contextmenu .ctx-label')].find((n) => window.__lib.text(n) === ${J(L.show)}); it.closest('[role="menuitem"], .ctx-item, button, div').click(); return 1; })()`);
  check(`${lang} · « ${L.show} » d’un entraînement disparu : « ${L.gone} »`, !!(await until(`window.__lib.toasts().includes(${J(L.gone)})`, 6000)), await ev('window.__lib.toasts()'));
  // « Voir l'entraînement » de Rosa : l'écran des entraînements, sur Rosa
  await ev(`(() => { const d = document.querySelector('#library .lib-detail'); [...d.querySelectorAll('.lib-actions .btn')].find((b) => window.__lib.text(b) === ${J(L.show)}).click(); return 1; })()`);
  check(`${lang} · « ${L.show} » : l’écran des entraînements s’ouvre sur Rosa, la bibliothèque se ferme`,
    !!(await until(`window.__mia.state.view === 'train' && (document.querySelector('#view-train .tr-title') || {}).textContent === 'Rosa' && document.getElementById('library').hidden`, 10000)));
  await ev(`(window.__mia.app.goHome(), 1)`);
  await until(`window.__mia.state.view === 'home'`, 8000);
  // « Entraîner un LoRA » : un brouillon neuf, à l'écran
  const before = (await ev('window.mia.train.list()')).length;
  await openLib();
  await ev(`(document.querySelector('#library .lib-train').click(), 1)`);
  check(`${lang} · « ${L.train} » : un nouveau brouillon, l’écran des entraînements dessus`,
    !!(await until(`window.__mia.state.view === 'train' && !!document.querySelector('#view-train .tr-draft, #view-train [data-mode="draft"], #view-train .tr-form') && document.getElementById('library').hidden`, 10000))
    && (await ev('window.mia.train.list()')).length === before + 1);
  await ev(`(window.__mia.app.goHome(), 1)`);
  await until(`window.__mia.state.view === 'home'`, 8000);
}

let code = 0;
let firstLang = null;
try {
  fs.mkdirSync(OUT, { recursive: true });
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await screencast(true);
  await waitReady(null);
  const info = await ev('window.mia.app.info()');
  const realData = process.env.APPDATA ? path.join(process.env.APPDATA, 'Mia', 'data') : null;
  if (!info?.dataDir || (realData && path.resolve(info.dataDir).toLowerCase() === path.resolve(realData).toLowerCase())) {
    throw new Error('cette Mia utilise les données de tous les jours : lancer une instance de test (MIA_USERDATA, MIA_PROJECTS_ROOT)');
  }
  const opts = await ev('window.mia.train.options()');
  if (!opts || !(opts.bases || []).some((b) => b.id === 'fake')) throw new Error('cette Mia n’a pas le faux outil d’entraînement : la lancer avec MIA_TRAIN_FAKE=1');
  if ((await ev('window.mia.train.list()')).length) throw new Error('cette Mia a déjà des entraînements : repartir d’un dossier de données neuf (MIA_USERDATA)');
  await ev(`(async () => { await window.mia.prefs.set({ welcomeLater: Date.now() }); const w = document.getElementById('welcome'); if (w) w.remove(); return 1; })()`);
  firstLang = await ev('document.documentElement.lang');
  console.log(`Mia ${info.version} · port ${port} · captures : ${OUT}`);
  await setLang('fr');
  await setup(info.dataDir);
  await pass('fr', { menuShot: 'bibliotheque-menu-fr.png' });
  await setLang('en');
  await pass('en', { menuShot: null });
  check('aucune erreur dans la page', pageErrors.length === 0, pageErrors.slice(0, 5));
} catch (e) {
  console.error('\nL’outil n’a pas pu travailler :', e.message);
  code = 2;
} finally {
  try { if (firstLang && firstLang !== (await ev('document.documentElement.lang'))) await setLang(firstLang); } catch { /* fenêtre partie */ }
  try { await screencast(false); } catch { /* idem */ }
  try { await send('Emulation.clearDeviceMetricsOverride'); } catch { /* idem */ }
  ws.close();
}
console.log(`\n${passed}/${passed + failures.length} contrôles réussis${failures.length ? ` — ${failures.length} ÉCHEC(S)` : ''}`);
process.exit(code || (failures.length ? 1 : 0));
