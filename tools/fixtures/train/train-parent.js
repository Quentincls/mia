'use strict';
// Un « Mia » réduit à son service d'entraînement, dans un processus à lui : tools\test-trainer.js le lance, attend
// que le faux outil entraîne, puis tue CE SEUL processus (taskkill /PID sans /T), comme un vrai plantage de Mia —
// pas un dispose() dans le même processus. Le faux outil doit survivre (il n'est pas dans le « job » du parent) et
// un service relancé sur les mêmes données doit le reprendre en main (CONCEPTION-entrainement §4.5-8b, cas 14).
//
//   node train-parent.js --mia <racine de Mia> --ud <userData> --lock <verrou du banc> --set <dossier d'images>
//                        --out <fichier info.json> [--steps 400] [--at 12] [--fake <json>]
//
// Écrit <out> : {pid, id, toolPid, step} dès que l'outil a passé le pas --at ; puis attend d'être tué.

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt; };
const MIA = path.resolve(opt('--mia', path.join(__dirname, '..', '..', '..')));
const UD = path.resolve(opt('--ud'));
const LOCK = path.resolve(opt('--lock'));
const SET = path.resolve(opt('--set'));
const OUT = path.resolve(opt('--out'));
const STEPS = Number(opt('--steps', '400')) || 400;
const AT = Number(opt('--at', '12')) || 12;
const FAKE = JSON.parse(opt('--fake', '{}'));

process.env.MIA_TRAIN_FAKE = '1';
delete process.env.MIA_NO_GPU;
delete process.env.MIA_USERDATA;
process.env.MIA_NO_LAB = '1';

const { register } = require(path.join(MIA, 'electron', 'trainer.js'));
const ctx = {
  ipcMain: { handle: () => {} },
  send: () => {},
  paths: { root: MIA, data: path.join(UD, 'data'), userData: UD },
  prefs: { get: () => ({ lang: 'fr', engineRoot: path.dirname(path.dirname(LOCK)) }), onChange: () => {} },
  logger: () => () => {},
  engine: null,
  trainOpts: {
    lockPath: LOCK,
    timing: { tickMs: 25, pushMs: 40, aliveMs: 100, retryMs: 120, renewMs: 150, stopMs: 1500, stopSampleMs: 9000, quitMs: 1500, warnMinMs: 600000, warnPaces: 0, killMinMs: 2700000, killPaces: 0 },
    queueIdle: () => true,
    freeBytes: () => 500 * 1024 ** 3,
    commitGB: async () => 64,
    toolsDir: path.join(UD, 'outils'),
    learnFake: true
  }
};

(async () => {
  fs.mkdirSync(UD, { recursive: true });
  const t = register(ctx);
  const r = t.create({ name: 'Plantage réel', base: 'fake', kind: 'character', trigger: 'rsa woman', fake: { msPerStep: 25, ...FAKE } });
  if (!r.ok) throw new Error(`création refusée : ${r.error}`);
  t.update(r.id, { steps: STEPS, settings: { saveEvery: 10, sampleEvery: 0 } });
  t.addImages(r.id, [SET]);
  await t.importIdle(r.id);
  const st = await t.start(r.id);
  if (!st.ok) throw new Error(`départ refusé : ${st.error}`);
  const t0 = Date.now();
  for (;;) {
    const it = t.item(r.id);
    if (it && it.live && it.live.pid && it.doc.state === 'entrainement' && it.doc.step >= AT) {
      fs.writeFileSync(OUT, JSON.stringify({ pid: process.pid, id: r.id, toolPid: it.live.pid, step: it.doc.step }), 'utf8');
      break;
    }
    if (Date.now() - t0 > 30000) throw new Error(`l'outil n'a pas atteint le pas ${AT} (état ${it && it.doc.state})`);
    await new Promise((res) => setTimeout(res, 20));
  }
  setInterval(() => {}, 60000);                      // vivant jusqu'à ce que le banc le tue
})().catch((e) => {
  try { fs.writeFileSync(OUT, JSON.stringify({ error: String(e && e.message) }), 'utf8'); } catch { /* rien */ }
  process.exit(1);
});
