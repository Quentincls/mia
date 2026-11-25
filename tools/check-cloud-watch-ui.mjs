// La veille des modèles en ligne VUE dans une Mia de test cachée (SPEC §23.8) : un faux Higgsfield local (console,
// dash et l'appel gratuit qui vérifie une clé), une Mia lancée par cet outil avec ses propres données, jamais celle
// de Quentin. Il relie un faux compte, demande un coup d'œil, regarde la ligne de l'accueil, ouvre la liste,
// installe un modèle, vérifie que le catalogue de l'écran le connaît aussitôt avec « Nouveau », que les Réglages ont
// l'interrupteur, en français puis en anglais, sans erreur dans la page. Captures dans _dev/captures-veille.
//
//   node tools/check-cloud-watch-ui.mjs [--keep]      (--keep : laisse la Mia de test ouverte, son numéro est dit)
//
// Aucun appel à Higgsfield, aucun crédit, aucune carte graphique. La Mia de test est arrêtée par son numéro de
// processus à la fin. Code de sortie : 0 tout est bon, 1 des contrôles en échec, 2 l'outil n'a pas pu travailler.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '_dev', 'captures-veille');
const KEEP = process.argv.includes('--keep');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const CDP_PORT = 9431;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok    ${name}`); return true; }
  failures.push(name);
  console.log(`  ÉCHEC ${name}${detail !== undefined ? ` : ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  return false;
};

// ── le faux Higgsfield ────────────────────────────────────────────────────────────────────────────────────
const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'catalog', 'cloud-higgsfield.json'), 'utf8'));
const known = shipped.families.map((f) => Object.values(f.workflows[0].endpoints)[0]).slice(0, 24);
let n = 0;
const rec = (slug, title, variant, min = 0.05, output = 'video') =>
  `{id:"00000000-0000-4000-8000-${String(++n).padStart(12, '0')}",slug:"${slug}",title:"${title}",variant_title:"${variant}",output_type:"${output}",availability_state:"available",input_types:["text"],price_range:{min_amount:${min},max_amount:${min * 2},unit:"sec",currency:"USD"}}`;
const md = (title, schema) => [`# ${title}`, '', '## Using this model', '', 'Short cinematic clips.', '', '## Pricing', '', 'n/a', '',
  '### Input JSON Schema', '', '```json', JSON.stringify(schema), '```', '', '## Output', ''].join('\n');
const T2V = { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' }, duration: { type: 'integer', enum: [5, 10] }, resolution: { type: 'string', enum: ['720p', '1080p'] }, generate_audio: { type: 'boolean' } } };
const I2V = { ...T2V, required: ['prompt', 'image_url'], properties: { ...T2V.properties, image_url: { type: 'string' } } };
const T2I = { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' }, resolution: { type: 'string', enum: ['1k', '2k', '4k'] } } };
const site = {
  '/sitemap.xml': `<urlset>${[...known, 'nova/reel-2/text-to-video', 'lumen/still-3/text-to-image'].map((x) => `<loc>https://x/models/${x}/playground</loc>`).join('')}</urlset>`,
  '/explore': `<html>${known.map((x) => rec(x, 'Known', 'V')).join(',')}</html>`,
  '/explore/video': '<html></html>', '/explore/image': '<html></html>',
  '/models/nova/reel-2/text-to-video/playground': `<html>${rec('nova/reel-2/text-to-video', 'Nova Reel 2', 'Text to Video', 0.03)}${rec('nova/reel-2/image-to-video', 'Nova Reel 2', 'Image to Video', 0.04)}<a href="/models/nova/reel-2/image-to-video/playground">i</a></html>`,
  '/models/nova/reel-2/image-to-video/playground': `<html>${rec('nova/reel-2/image-to-video', 'Nova Reel 2', 'Image to Video', 0.04)}</html>`,
  '/models/lumen/still-3/text-to-image/playground': `<html>${rec('lumen/still-3/text-to-image', 'Lumen Still 3', 'Text to Image', 0.02, 'image')}</html>`,
  '/dash/nova/reel-2/text-to-video/llms.txt': md('Nova Reel 2', T2V),
  '/dash/nova/reel-2/image-to-video/llms.txt': md('Nova Reel 2', I2V),
  '/dash/lumen/still-3/text-to-image/llms.txt': md('Lumen Still 3', T2I),
};
for (const x of known) site[`/models/${x}/playground`] = `<html>${rec(x, 'Known', 'V')}</html>`;
const hits = [];
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  hits.push(u);
  // la vérification gratuite d'une clé : une demande qui n'existe pas → 404 = clé acceptée
  if (/^\/requests\/.+\/status$/.test(u)) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"detail":"not found"}'); return; }
  if (site[u] == null) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(site[u]);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ── la Mia de test ────────────────────────────────────────────────────────────────────────────────────────
if (!fs.existsSync(ELECTRON)) { console.error(`Electron introuvable : ${ELECTRON}`); process.exit(2); }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-veille-'));
const env = {
  ...process.env, MIA_HEADLESS: '1', MIA_USERDATA: path.join(TMP, 'user'), MIA_PROJECTS_ROOT: path.join(TMP, 'projets'), MIA_NO_GPU: '1',
  MIA_HF_BASE: base, MIA_HF_CONSOLE: base, MIA_HF_DASH: `${base}/dash`, MIA_WATCH_DELAY_MS: '600000',
  MIA_SKIP_MODULES: 'scanner,installer,trainer,bridge', MIA_BRIDGE_FILE: path.join(TMP, 'bridge.json'),
};
delete env.MIA_BRIDGE_MIRROR;
fs.mkdirSync(env.MIA_PROJECTS_ROOT, { recursive: true });
const mia = spawn(ELECTRON, [ROOT, `--remote-debugging-port=${CDP_PORT}`], { env, stdio: 'ignore', windowsHide: true });
console.log(`· Mia de test lancée (processus ${mia.pid}), données dans ${TMP}`);
const stop = () => {
  if (KEEP) { console.log(`· Mia de test laissée ouverte : processus ${mia.pid}, CDP ${CDP_PORT}`); return; }
  try { execFileSync('taskkill', ['/PID', String(mia.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* déjà partie */ }
  server.close();
};

let ws;
const pend = new Map();
const pageErrors = [];
let msgId = 0;
const send = (method, params = {}, ms = 60000) => new Promise((resolve, reject) => {
  const i = ++msgId;
  const t = setTimeout(() => { pend.delete(i); reject(new Error(`CDP : pas de réponse à ${method}`)); }, ms);
  pend.set(i, (d) => { clearTimeout(t); resolve(d); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
async function ev(expr, ms = 60000) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, ms);
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
}
async function until(expr, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    try { if (await ev(expr)) return true; } catch { /* pas encore */ }
    if (Date.now() - t0 > ms) return false;
    await sleep(150);
  }
}
async function shot(name) {
  fs.mkdirSync(OUT, { recursive: true });
  const r = await send('Page.captureScreenshot', { format: 'png' }, 20000);
  if (r.result?.data) fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
}
async function connect() {
  const t0 = Date.now();
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (target) {
        ws = new WebSocket(target.webSocketDebuggerUrl);
        ws.onmessage = (m) => {
          const d = JSON.parse(m.data);
          if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
          else if (d.method === 'Runtime.exceptionThrown') pageErrors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
          else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') pageErrors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
        };
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('CDP refusé')); });
        await send('Runtime.enable');
        await send('Page.enable');
        await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        return;
      }
    } catch { /* pas encore */ }
    if (Date.now() - t0 > 60000) throw new Error('la Mia de test ne répond pas sur CDP');
    await sleep(400);
  }
}
const visibleText = (sel) => `(() => { const n = document.querySelector(${JSON.stringify(sel)}); return n && n.offsetParent !== null ? n.textContent : ''; })()`;
const click = (sel) => ev(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return false; n.click(); return true; })()`);

async function scene(lang) {
  console.log(`\n${lang === 'fr' ? 'Français' : 'Anglais'}`);
  const line = await until(`!!document.querySelector('.home-watch') && !document.querySelector('.home-watch').hidden`, 15000);
  check(`${lang} : la ligne de l’accueil apparaît`, line);
  const txt = await ev(visibleText('.home-watch .home-banner-msg'));
  check(`${lang} : elle compte les modèles nouveaux`, lang === 'fr' ? /^2 nouveaux modèles en ligne chez Higgsfield$/.test(txt) : /^2 new online models at Higgsfield$/.test(txt), txt);
  await shot(`${lang}_accueil`);
  await click('.home-watch .btn');
  check(`${lang} : « Voir » ouvre la liste`, await until(`document.querySelectorAll('.watch-row').length === 2`, 5000));
  const rows = await ev(`[...document.querySelectorAll('.watch-row')].map((r) => r.innerText)`);
  check(`${lang} : chaque ligne dit le nom, ce qu’il fait et le prix`, rows.some((r) => /Nova Reel 2/.test(r) && (lang === 'fr' ? /dès\s≈\s0,03\s\$\s\/\ss/.test(r) : /from\s≈\s\$0\.03\s\/\ss/.test(r))), rows);
  const over = await ev(`[...document.querySelectorAll('.watch-row, .watch-row *')].filter((n) => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflow !== 'visible').length`);
  check(`${lang} : rien ne déborde`, over === 0, over);
  await shot(`${lang}_liste`);
}

let code = 0;
try {
  await connect();
  check('la page de Mia est prête', await until(`!!window.mia && !!document.querySelector('#view-home')`, 30000));
  const linked = await ev(`window.mia.cloud.setKey('test-id:test-secret').then((r) => r.ok)`);
  check('un faux compte est relié (faux Higgsfield local)', linked);
  const w0 = await ev(`window.mia.cloud.watch()`);
  check('la veille démarre allumée et sans rien', w0 && w0.off === false && w0.pending.length === 0 && w0.linked === true, w0);
  const w1 = await ev(`window.mia.cloud.watchCheck()`);
  check('un coup d’œil trouve 2 familles (vidéo et image)', w1 && w1.pending.length === 2, w1 && w1.pending.map((p) => p.key));
  check('aucun appel à l’API de calcul', !hits.some((h) => /^\/(?!requests\/)(?!dash\/)(?!models\/)(?!sitemap)(?!explore)/.test(h)), hits.filter((h) => !/^\/(dash|models|sitemap|explore|requests)/.test(h)));
  await scene('fr');

  // installer le premier depuis la liste
  await ev(`(() => { const r = [...document.querySelectorAll('.watch-row')].find((x) => /Nova Reel 2/.test(x.innerText)); r.querySelector('.watch-acts .btn').click(); return true; })()`);
  check('installer : la liste garde l’autre', await until(`document.querySelectorAll('.watch-row').length === 1`, 8000));
  check('installer : un message le dit', await until(`[...document.querySelectorAll('.toast')].some((t) => /Nova Reel 2 installé/.test(t.textContent))`, 5000));
  await shot('fr_installe');
  const cat = await ev(`window.mia.cloud.catalog().then((c) => { const f = c.families.find((x) => x.key === 'hf:nova-reel-2'); return f && { fresh: !!f.fresh, wf: f.workflows.map((w) => w.id), desc: f.desc }; })`);
  check('le moteur connaît Nova Reel 2, marqué nouveau', cat && cat.fresh && cat.wf.length === 2, cat);
  const screen = await ev(`import(new URL('js/nodes/profiles.js', location.href)).then((m) => { const f = m.cloudCatalog().families.find((x) => x.key === 'hf:nova-reel-2'); return !!f && !!f.fresh; })`);
  check('l’écran le connaît aussitôt, sans recharger', screen);
  await ev(`document.querySelector('.watch-modal')?.closest('.modal-scrim')?.click(); true`);
  await sleep(400);
  const line = await ev(visibleText('.home-watch .home-banner-msg'));
  check('la ligne de l’accueil passe à 1', /^1 nouveau modèle en ligne/.test(line), line);

  // Réglages : l'interrupteur et « Regarder maintenant »
  await ev(`import(new URL('js/ui/settings.js', location.href)).then((m) => { m.openSettings({ section: 'cloud' }); return true; })`);
  check('Réglages : la ligne « Repérer les nouveaux modèles » est là', await until(`[...document.querySelectorAll('.set-cloud .set-name')].some((n) => n.textContent === 'Repérer les nouveaux modèles' && n.offsetParent)`, 8000));
  await sleep(500);
  await shot('fr_reglages');
  const last = await ev(`[...document.querySelectorAll('.set-cloud .set-hint')].map((n) => n.textContent).join(' | ')`);
  check('Réglages : la date du dernier coup d’œil', /Dernier coup d’œil/.test(last), last);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);

  // anglais : la fenêtre de TEST se recharge dans l'autre langue
  await ev(`window.mia.prefs.set({ lang: 'en' }).then(() => true)`);
  await sleep(300);
  await ev(`location.reload(); true`).catch(() => {});
  await sleep(1500);
  ws.close();
  await connect();
  await until(`!!window.mia && !!document.querySelector('#view-home')`, 30000);
  // l'autre famille reste proposée ; on la fait revenir à 2 en ignorant rien : on regarde ce qui reste (1)
  const en = await until(`!!document.querySelector('.home-watch') && !document.querySelector('.home-watch').hidden`, 15000);
  check('en : la ligne de l’accueil est là', en);
  const etxt = await ev(visibleText('.home-watch .home-banner-msg'));
  check('en : texte anglais', /^1 new online model at Higgsfield$/.test(etxt), etxt);
  await click('.home-watch .btn');
  await until(`document.querySelectorAll('.watch-row').length === 1`, 5000);
  const erow = await ev(`document.querySelector('.watch-row')?.innerText || ''`);
  check('en : la ligne de la liste en anglais', /Lumen Still 3/.test(erow) && /New model/i.test(erow) && /Image from text/.test(erow) && /from ≈/.test(erow), erow);
  await shot('en_liste');
  // ignorer : la ligne de l'accueil disparaît
  await ev(`document.querySelector('.watch-row .btn-ghost').click(); true`);
  check('ignorer : la ligne de l’accueil disparaît', await until(`document.querySelector('.home-watch').hidden`, 5000));
  await shot('en_accueil_vide');
  check('aucune erreur dans la page', !pageErrors.length, pageErrors.slice(0, 3));
} catch (e) {
  console.error(`L'outil n'a pas pu travailler : ${e.message}`);
  code = 2;
} finally {
  try { ws && ws.close(); } catch { /* rien */ }
  stop();
}
console.log(`\n${passed} contrôles réussis, ${failures.length} échec(s). Captures : ${OUT}`);
process.exit(code || (failures.length ? 1 : 0));
