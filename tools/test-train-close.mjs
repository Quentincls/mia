// Fermer Mia pendant un entraînement (CONCEPTION-entrainement §2.6, §4 point 9, cas de test 16), VU dans une Mia de test
// sans GPU : le faux outil (MIA_TRAIN_FAKE=1) fait vivre un entraînement, l'outil pilote la fenêtre par CDP.
//
//   node tools/test-train-close.mjs <port CDP> --userdata <le MIA_USERDATA de cette Mia>
//
// À lancer UNIQUEMENT sur une Mia de test neuve :
//   MIA_HEADLESS=1  MIA_NO_GPU=1  MIA_TRAIN_FAKE=1  MIA_USERDATA=<dossier neuf>  MIA_PROJECTS_ROOT=<dossier neuf>
//   node_modules\electron\dist\electron.exe . --remote-debugging-port=<port>
// Contrôles : la boîte s'affiche (fr), la fenêtre reste ouverte au-delà des 2 s, l'entraînement continue ; « Rester »
// annule ; sans réponse (délai raccourci ici), la page répond elle-même « Rester » et la boîte reste ; « Arrêter et
// quitter » affiche « ÉCRITURE DU POINT DE CONTRÔLE… » et attend l'outil (ici sourd : ignoreControl) ; « Quitter sans
// attendre » ferme Mia et l'entraînement est classé « interrompu ». CETTE MIA SE FERME À LA FIN.
// Code de sortie : 0 tout est bon, 1 des contrôles en échec, 2 l'outil n'a pas pu travailler.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
const port = Number(args.find((a) => /^\d+$/.test(a)));
const ud = args.includes('--userdata') ? path.resolve(args[args.indexOf('--userdata') + 1]) : null;
if (!Number.isInteger(port) || !ud) { console.error('usage : node tools/test-train-close.mjs <port CDP> --userdata <dossier>'); process.exit(2); }
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

// ── un jeu de 12 images légendées (PNG fabriqués ici) ──
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
const target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) || list.find((t) => t.type === 'page');
if (!target) { console.error('Aucune page Mia sur ce port.'); process.exit(2); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 0;
let gone = false;
const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
ws.onclose = () => { gone = true; for (const f of pend.values()) f({ error: { message: 'fermé' } }); pend.clear(); };
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('connexion CDP refusée')); });
const send = (method, params = {}, ms = 30000) => new Promise((resolve, reject) => {
  if (gone) { reject(new Error('fermé')); return; }
  const i = ++msgId;
  const t = setTimeout(() => { pend.delete(i); reject(new Error(`CDP : pas de réponse à ${method}`)); }, ms);
  pend.set(i, (d) => { clearTimeout(t); resolve(d); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
async function ev(expr, ms = 30000) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, ms);
  if (r.error) throw new Error(r.error.message);
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'évaluation');
  return r.result?.result?.value;
}
async function until(expr, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await ev(expr).catch(() => null); if (v) return v; await sleep(120); }
  return null;
}
const T = (call) => ev(`window.mia.train.${call}`);
const box = () => ev(`(() => { const b = document.querySelector('.trq'); if (!b || !b.isConnected) return null; return { text: b.textContent.replace(/\\s+/g, ' ').trim(), buttons: [...b.querySelectorAll('button')].map((x) => x.dataset.trq) }; })()`);
const click = (k) => ev(`(() => { const b = document.querySelector('.trq button[data-trq="${k}"]'); if (!b) return false; b.click(); return true; })()`);
const stateOf = (id) => T(`get(${J(id)})`).then((s) => s.state);

try {
  // une Mia de test, neuve, avec le faux outil
  await until(`!!(window.mia && window.mia.train)`, 45000);
  const opts = await T('options()').catch(() => null);
  if (!opts || !(opts.bases || []).some((b) => b.id === 'fake')) throw new Error('cette Mia n’a pas le faux outil : MIA_TRAIN_FAKE=1');
  if ((await T('list()')).length) throw new Error('cette Mia a déjà des entraînements : un MIA_USERDATA neuf');
  await ev(`window.mia.prefs ? window.mia.prefs.set({ lang: 'fr' }).catch(() => 0) : 0`).catch(() => 0);

  const set = path.join(ud, '..', 'jeu-fermeture');
  fs.mkdirSync(set, { recursive: true });
  for (let k = 1; k <= 12; k++) {
    fs.writeFileSync(path.join(set, `img_${k}.png`), png(128, 192, k));
    fs.writeFileSync(path.join(set, `img_${k}.txt`), `a portrait, number ${k}`, 'utf8');
  }
  const r = await T(`create(${J({ name: 'Rosa', base: 'fake', kind: 'character', trigger: 'rsa woman', fake: { msPerStep: 40, encodeMs: 100, loadMs: 100, ignoreControl: true } })})`);
  const id = r.id;
  await T(`update(${J(id)}, ${J({ steps: 100000, settings: { saveEvery: 100, sampleEvery: 0 } })})`);
  await T(`addImages(${J(id)}, ${J([set])})`);
  await until(`window.mia.train.get(${J(id)}).then((s) => !s.importing)`, 60000);
  const st = await T(`start(${J(id)})`);
  check('décor : l’entraînement part (faux outil)', st && st.ok !== false, st);
  check('décor : en cours', !!(await until(`window.mia.train.get(${J(id)}).then((s) => s.state === 'entrainement')`, 60000)));

  // 1. fermer : la boîte, et rien ne ferme au-delà des 2 s du silence
  await ev('setTimeout(() => window.mia.win.close(), 0), 1');
  const b1 = await until(`(() => { const b = document.querySelector('.trq'); return b && b.textContent; })()`, 5000);
  check('× pendant un entraînement : la boîte maison s’affiche', !!b1);
  await sleep(3500);
  const b2 = await box();
  check('… texte en français, nom et pas, boutons « Rester » et « Arrêter et quitter »', b2 && /^Fermer Mia\s?Un entraînement est en cours \(Rosa, pas[\d\s]+\/\s100\s000\)\./.test(b2.text) && /Quitter l’arrête au pas courant/.test(b2.text) && /Rester/.test(b2.text) && /Arrêter et quitter/.test(b2.text) && J(b2.buttons) === J(['stay', 'stopQuit']), b2);
  check('… 3,5 s plus tard Mia est toujours ouverte, l’entraînement continue', !gone && (await stateOf(id)) === 'entrainement');

  // 2. « Rester »
  await click('stay');
  await sleep(900);
  check('« Rester » : la boîte se ferme, l’entraînement continue', !(await box()) && (await stateOf(id)) === 'entrainement');
  await ev('setTimeout(() => window.mia.win.close(), 0), 1');
  check('… et fermer à nouveau repose la question (la fermeture a bien été annulée)', !!(await until(`!!document.querySelector('.trq')`, 5000)));
  await click('stay');
  await sleep(900);

  // 3. sans réponse : la page répond elle-même « Rester » (délai raccourci, la boîte reste)
  const auto = await ev(`(async () => {
    const m = await import('./js/ui/trainclose.js');
    const got = [];
    m.askTrainingClose({ name: 'Rosa', step: 5, steps: 10 }, (a) => got.push(a), { askMs: 300 });
    await new Promise((r) => setTimeout(r, 700));
    const shown = !!document.querySelector('.trq');
    document.querySelector('.trq button[data-trq="stay"]').click();
    await new Promise((r) => setTimeout(r, 900));
    return { got, shown, after: !!document.querySelector('.trq') };
  })()`);
  check('sans réponse : {cancel:true} envoyé une seule fois, la boîte reste affichée', auto && J(auto.got) === J([{ cancel: true }]) && auto.shown === true && auto.after === false, auto);

  // 4. « Arrêter et quitter » (outil sourd : Mia attend), puis « Quitter sans attendre »
  await ev('setTimeout(() => window.mia.win.close(), 0), 1');
  await until(`!!document.querySelector('.trq')`, 5000);
  await click('stopQuit');
  await sleep(1500);
  const b4 = await box();
  check('« Arrêter et quitter » : « ÉCRITURE DU POINT DE CONTRÔLE… » et « Quitter sans attendre », Mia attend l’outil', b4 && /ÉCRITURE DU POINT DE CONTRÔLE…/.test(b4.text) && J(b4.buttons) === J(['now']) && !gone, b4);
  await click('now').catch(() => false);
  const t0 = Date.now();
  while (!gone && Date.now() - t0 < 20000) await sleep(100);
  check('« Quitter sans attendre » : Mia se ferme', gone);
  await sleep(1500);
  const tj = path.join(ud, 'training', id, 'train.json');
  let disk = null;
  try { disk = JSON.parse(fs.readFileSync(tj, 'utf8')); } catch { /* listed below */ }
  if (!disk) {
    // le dossier de l'entraînement porte peut-être un autre nom : le chercher
    const root = path.join(ud, 'training');
    for (const n of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      try { const d = JSON.parse(fs.readFileSync(path.join(root, n, 'train.json'), 'utf8')); if (d.name === 'Rosa') disk = d; } catch { /* next */ }
    }
  }
  check('… et l’entraînement est classé « interrompu »', disk && disk.state === 'interrompu', disk && disk.state);
} catch (e) {
  console.error(`L’outil n’a pas pu travailler : ${e.message}`);
  process.exit(2);
}
try { ws.close(); } catch { /* gone */ }
console.log(`\n${passed} contrôles réussis, ${failures.length} en échec.`);
process.exit(failures.length ? 1 : 0);
