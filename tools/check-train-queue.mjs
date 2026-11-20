// La rangée « Entraînement LoRA » de la file des calculs VUE dans une Mia de test, sans GPU : le faux outil
// (MIA_TRAIN_FAKE=1) fait vivre un entraînement, l'outil pilote la fenêtre par CDP sur une planche ouverte et
// contrôle, en français puis en anglais : la pastille repliée, la rangée en tête (nom, modèle, pourcentage,
// heure de fin, barre), rien de coupé ni de Windows, la croix (la question « Arrêter… », puis « Continuer »), le
// clic qui ouvre l'écran d'entraînement ; puis l'arrêt (la rangée dit « ARRÊTÉ · n » quelques secondes, et la file
// disparaît). Captures : <dossier>\file-fr.png, file-en.png (file ouverte pendant l'entraînement).
//
//   node tools/check-train-queue.mjs <port CDP> [--out <dossier>]
//
// À lancer UNIQUEMENT sur une Mia de test, données neuves :
//   MIA_HEADLESS=1  MIA_NO_GPU=1  MIA_TRAIN_FAKE=1  MIA_USERDATA=<dossier neuf>  MIA_PROJECTS_ROOT=<dossier neuf>
//   node_modules\electron\dist\electron.exe . --remote-debugging-port=<port>
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
  console.error('usage : node tools/check-train-queue.mjs <port CDP> [--out <dossier>]');
  process.exit(2);
}
const OUT = path.resolve(opt('--out', path.join(ROOT, '_dev', 'captures-train', 'lot6')));
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

// ── images du jeu (PNG fabriqués ici, sans dépendance) ───────────────
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
function makeSet(dir, n) {
  fs.mkdirSync(dir, { recursive: true });
  for (let k = 1; k <= n; k++) {
    const name = `rosa_${String(k).padStart(2, '0')}`;
    const hue = (k * 47) % 360;
    fs.writeFileSync(path.join(dir, `${name}.png`), png(128, 192, (x, y) => {
      const l = Math.max(0, 1 - Math.hypot(x - 0.5, (y - 0.4) * 1.25) * 2.2);
      const t = (o) => Math.round(Math.min(255, 22 + 26 * y + l * (120 + 70 * Math.cos(((hue + o) * Math.PI) / 180))));
      return [t(0), t(120), t(240)];
    }));
    fs.writeFileSync(path.join(dir, `${name}.txt`), 'seated by a window, soft light, 35mm film still', 'utf8');
  }
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
async function waitReady(lang, ms = 45000) {
  const ok = await until(`(() => !!(document.readyState === 'complete' && window.__mia && window.__mia.app && window.__mia.app.home && window.__mia.app.editor && document.getElementById('tb-train') && ${lang ? `document.documentElement.lang === ${J(lang)}` : 'true'}))()`, ms, 400);
  if (!ok) throw new Error(`la fenêtre n'est pas revenue (langue ${lang || '?'})`);
  await sleep(1200);
  await screencast(true);
}
async function setLang(lang) {
  if ((await ev('document.documentElement.lang')) === lang) return;
  await ev(`(async () => { const m = await import(new URL('js/i18n.js', location.href).href); setTimeout(() => m.setLang(${J(lang)}), 0); return 1; })()`);
  await sleep(1200);
  await waitReady(lang);
}
const T = (call) => ev(`window.mia.train.${call}`);
const waitState = (id, test, ms = 60000) => until(`window.mia.train.get(${J(id)}).then((s) => (${test}) ? ({ state: s.state, step: s.step }) : null)`, ms, 150);
async function clickAt(sel) {
  const r = await ev(`(() => { const n = document.querySelector(${J(sel)}); if (!n) return null; const b = n.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  if (!r) return false;
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  return true;
}

/** Ce que la file montre. */
const SNAP = `(() => {
  const q = document.getElementById('queue');
  const row = q && q.querySelector('.q-train');
  const cut = (n) => !!n && n.scrollWidth > n.clientWidth + 1;
  const pill = q && q.querySelector('.q-pill');
  return {
    view: window.__mia.state.view, hidden: !q || q.hidden,
    pill: pill ? pill.innerText.replace(/\\s+/g, ' ').trim() : null, pillName: (q && q.querySelector('.q-sum-name') || {}).textContent || null,
    pillSt: (q && q.querySelector('.q-sum-st') || {}).textContent || null, pillBar: !!(q && q.querySelector('.q-pill > .q-bar.on')),
    open: !!(q && q.querySelector('.q-panel:not([hidden])')),
    first: !!(row && row.parentNode.firstElementChild === row),
    label: row ? row.querySelector('.q-label').textContent : null, sub: row ? row.querySelector('.q-sub').textContent : null,
    st: row ? row.querySelector('.q-st').textContent : null, stShown: row ? row.querySelector('.q-st').innerText : null,
    tone: row ? row.querySelector('.q-st').dataset.tone : null, cls: row ? row.className : null,
    bar: row ? !!row.querySelector('.q-bar.on') : null, fill: row ? (row.querySelector('.q-bar > i') || {}).style?.transform || '' : null,
    cross: !!(row && row.querySelector('.q-x')), crossTip: row && row.querySelector('.q-x') ? row.querySelector('.q-x').dataset.tip : null,
    cutLabel: cut(row && row.querySelector('.q-label')), cutSt: cut(row && row.querySelector('.q-st')), cutSub: cut(row && row.querySelector('.q-sub')),
    selects: document.querySelectorAll('select').length, titles: [...document.querySelectorAll('[title]')].map((n) => n.tagName + ':' + n.getAttribute('title')).slice(0, 5),
    modal: (() => { const m = document.querySelector('.modal h2'); return m ? { title: m.textContent, body: (document.querySelector('.modal p') || {}).textContent || '' } : null; })()
  };
})()`;
const snap = () => ev(SNAP);

const WORDS = {
  fr: { board: 'Planche 3', label: 'Entraînement LoRA · Rosa', model: 'Faux modèle (test)', run: /^\d+ % · fin vers \d{1,2} h \d{2}$/, pill: 'LoRA · Rosa',
    cross: 'Arrêter l’entraînement…', ask: /^Arrêter l’entraînement de Rosa au pas [\d  ]+ \?$/, keep: 'Continuer', stopped: /^ARRÊTÉ · [\d  ]+$/ },
  en: { board: 'Board 3', label: 'LoRA training · Rosa', model: 'Fake model (test)', run: /^\d+% · ends around \d{2}:\d{2}$/, pill: 'LoRA · Rosa',
    cross: 'Stop the training…', ask: /^Stop training Rosa at step [\d,]+\?$/, keep: 'Keep training', stopped: /^STOPPED · [\d,]+$/ }
};

async function onBoard(lang, projectId) {
  if (projectId) await ev(`window.__mia.app.openProject(${J(projectId)}).then(() => 1)`);
  return until(`window.__mia.state.view === 'board' && window.__mia.state.project && window.__mia.state.project.id === ${J(projectId)}`, 15000);
}

async function lookQueue(lang, id) {
  const W = WORDS[lang];
  await settle(300);
  let s = await until(`(() => { const s = ${SNAP}; return !s.hidden && s.pillName ? s : null; })()`, 10000);
  check(`${lang} · file : visible sur la planche pendant l’entraînement`, !!s && !s.hidden, s);
  if (!s) return;
  check(`${lang} · pastille repliée : « ${W.pill} · … » et sa barre`, s.pillName === W.pill && W.run.test(s.pillSt) && s.pillBar, s);
  // juste après un rechargement de la fenêtre, un premier clic peut tomber avant que la file l'écoute : un second essai
  for (let k = 0; k < 2 && !s.open; k++) {
    await clickAt('#queue .q-pill');
    await until(`!!document.querySelector('#queue .q-panel:not([hidden])')`, 3000);
    await settle(400);
    s = await snap();
  }
  check(`${lang} · file ouverte : la rangée de l’entraînement en tête`, s.open && s.first, s);
  check(`${lang} · rangée : « ${W.label} »`, s.label === W.label, s.label);
  check(`${lang} · rangée : sous-ligne « ${W.model} »`, s.sub === W.model, s.sub);
  check(`${lang} · rangée : état « n % · ${lang === 'fr' ? 'fin vers h' : 'ends around hh:mm'} », en clair (live)`, W.run.test(s.st) && s.tone === 'live' && s.cls.includes('is-running'), s);
  check(`${lang} · rangée : barre de progression`, s.bar && /^scaleX\(0\.\d+\)$/.test(s.fill), s.fill);
  check(`${lang} · rangée : croix « ${W.cross} »`, s.cross && s.crossTip === W.cross, s.crossTip);
  check(`${lang} · rangée : rien de coupé (nom, modèle, état)`, !s.cutLabel && !s.cutSt && !s.cutSub, s);
  check(`${lang} · aucun <select>, aucun attribut title`, s.selects === 0 && s.titles.length === 0, s.titles);
  fs.mkdirSync(OUT, { recursive: true });
  const r = await send('Page.captureScreenshot', { format: 'png' }, 20000);
  if (r.result?.data) { fs.writeFileSync(path.join(OUT, `file-${lang}.png`), Buffer.from(r.result.data, 'base64')); log(`  capture : ${path.join(OUT, `file-${lang}.png`)}`); }
  else check(`${lang} · capture prise`, false, r.error);

  // la croix : la question de l'écran, puis « Continuer » — l'entraînement continue
  await clickAt('#queue .q-train .q-x');
  const m = await until(`(() => { const m = document.querySelector('.modal h2'); return m ? { title: m.textContent, body: (document.querySelector('.modal p') || {}).textContent || '', buttons: [...document.querySelectorAll('.modal button')].map((b) => b.textContent.trim()) } : null; })()`, 6000);
  check(`${lang} · croix : la question « Arrêter… » (pas courant)`, !!m && W.ask.test(m.title) && m.body.length > 0, m);
  check(`${lang} · croix : [${W.keep}] proposé`, !!m && m.buttons.includes(W.keep), m && m.buttons);
  await ev(`(() => { const b = [...document.querySelectorAll('.modal button')].find((x) => x.textContent.trim() === ${J(W.keep)}); b && b.click(); return 1; })()`);
  await until(`!document.querySelector('.modal h2')`, 5000);
  await sleep(600);
  const st = await T(`get(${J(id)})`);
  check(`${lang} · « ${W.keep} » : l’entraînement continue`, st && (st.state === 'entrainement' || st.state === 'essai') && !st.pending, st && { state: st.state, pending: st.pending });

  // clic sur la rangée : l'écran de l'entraînement, sur Rosa
  await clickAt('#queue .q-train .q-label');
  check(`${lang} · clic sur la rangée : l’écran de l’entraînement, sur Rosa`, !!(await until(`window.__mia.state.view === 'train' && (document.querySelector('#view-train .tr-run .tr-title') || {}).textContent === 'Rosa'`, 8000)));
}

let code = 0;
let firstLang = null;
try {
  await screencast(true);
  await waitReady(null);
  const info = await ev('window.mia.app.info()');
  const realData = process.env.APPDATA ? path.join(process.env.APPDATA, 'Mia', 'data') : null;
  if (!info?.dataDir || (realData && path.resolve(info.dataDir).toLowerCase() === path.resolve(realData).toLowerCase())) {
    throw new Error('cette Mia utilise les données de tous les jours : lancer une instance de test (MIA_USERDATA, MIA_PROJECTS_ROOT)');
  }
  const opts = await T('options()');
  if (!opts || !(opts.bases || []).some((b) => b.id === 'fake')) throw new Error('cette Mia n’a pas le faux outil d’entraînement : la lancer avec MIA_TRAIN_FAKE=1');
  if ((await T('list()')).some((s) => s.state !== 'pret' && s.state !== 'fini' && s.state !== 'annule')) throw new Error('cette Mia a déjà un entraînement en cours : repartir d’un dossier de données neuf');
  await ev(`(async () => { await window.mia.prefs.set({ welcomeLater: Date.now() }); const w = document.getElementById('welcome'); if (w) w.remove(); return 1; })()`);
  firstLang = await ev('document.documentElement.lang');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  await setLang('fr');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const set = makeSet(path.join(path.dirname(info.dataDir), 'jeu-file'), 12);
  const r = await T(`create(${J({ name: 'Rosa', base: 'fake', kind: 'character', trigger: 'rsa woman', fake: { msPerStep: 150, encodeMs: 300, loadMs: 600, sampleMs: 300 } })})`);
  if (!r || r.ok === false) throw new Error(`création refusée : ${r && r.error}`);
  const id = r.id;
  await T(`update(${J(id)}, ${J({ steps: 2500, settings: { saveEvery: 500, sampleEvery: 0 } })})`);
  await T(`addImages(${J(id)}, ${J([set])})`);
  await until(`window.mia.train.get(${J(id)}).then((s) => !s.importing)`, 60000);
  const project = await ev(`window.__mia.app.createProject({ name: ${J(WORDS.fr.board)} }).then((p) => p && p.id)`);
  if (!(await onBoard('fr', project))) throw new Error('la planche ne s’ouvre pas');
  let s = await snap();
  check('fr · au repos : la file est cachée', s.hidden, s);
  const go = await T(`start(${J(id)})`);
  if (!go || go.ok === false) throw new Error(`départ refusé : ${go && (go.error || go.code)}`);
  check('fr · en cours : atteint le pas 200', !!(await waitState(id, `s.state === 'entrainement' && s.step >= 200`, 90000)));
  log('fr : la file…');
  await lookQueue('fr', id);

  log('en : rechargement de la fenêtre pendant l’entraînement…');
  await setLang('en');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  if (!(await onBoard('en', project))) throw new Error('la planche ne se rouvre pas');
  await lookQueue('en', id);

  // l'arrêt, puis la file qui se vide
  await ev(`window.__mia.app.leaveTrain()`);
  await onBoard('en', project);
  await T(`control(${J(id)}, 'stop')`);
  check('en · arrêt : l’entraînement est rangé « arrêté »', !!(await waitState(id, `s.state === 'annule'`, 60000)));
  s = await until(`(() => { const s = ${SNAP}; return s.st && /^STOPPED/.test(s.stShown || '') ? s : null; })()`, 8000);
  check('en · arrêt : la rangée dit « STOPPED · n », sans croix ni barre, quelques secondes', !!s && WORDS.en.stopped.test(s.stShown) && !s.cross && !s.bar, s);
  check('en · arrêt : puis la file disparaît (rien d’autre ne tourne)', !!(await until(`document.getElementById('queue').hidden`, 25000, 400)));
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
console.log(`\n${passed} contrôles bons, ${failures.length} en échec`);
process.exit(code || (failures.length ? 1 : 0));
