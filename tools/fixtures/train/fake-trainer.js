'use strict';
// Faux outil d'entraînement de Mia : aucun Python, aucun GPU, aucune dépendance.
//
//   <binaire de Mia en mode Node> fake-trainer.js --dir <dossier de l'entraînement> --run <n> --token <t> [--resume <pas>]
//
// Il parle exactement le protocole du dossier d'entraînement (electron\trainer.js) :
//   events.jsonl   une ligne JSON par évènement : caps, phase, resumed, sample_step, sample, checkpoint, stopped (avec why :
//                  'stop' | 'pause' | 'alive'), done, error
//   metrics.jsonl  une ligne par pas : {run, s, loss, lr, dt, t}
//   control\       pause, stop, alive (écrits par Mia) ; adapter.json {pid, token, t} (réécrit ici, hors de la boucle des pas)
// Il n'écrit JAMAIS train.json (il le lit seulement), et il écrit sur sa sortie à chaque pas : Mia lui donne un fichier
// (log.txt), pas un tuyau, donc il continue d'écrire et s'arrête proprement même si Mia a disparu.
//
// Réglages : train.json → settings.fake
//   msPerStep (50), encodeMs, loadMs, sampleMs, sampleKind ('image' | 'video'), sampleSteps (5),
//   sampleSize ([8, 8]) : largeur et hauteur des essais en image (un portrait sombre, d'une teinte par entraînement)
//   failAt + failCode ('oom' | 'ram' | 'disk' | 'missing' | 'tool' | 'takeover' | 'version')   échec à ce pas (0 = pendant le chargement)
//   noSampleStep      essai sans évènement sample_step (comme ai-toolkit)
//   hangAt            ne plus rien écrire à partir de ce pas (outil figé)
//   crashAt           sortie brutale à ce pas, en laissant un .tmp_step_* derrière soi
//   truncateAt        le point de contrôle de ce pas est écrit tronqué
//   refuseResume      à la reprise, « repartir de zéro » : la garde de l'adaptateur répond error code:"resume"
//   ignoreControl     ne répond ni à pause ni à stop
//   onRun (1)         numéro du lancement auquel failAt / hangAt / crashAt / truncateAt s'appliquent
//   heartbeatMs (20000), aliveCheckMs (5000), aliveStaleMs (180000), aliveRecheckMs (45000), aliveForceMs (900000),
//   jumpMs (60000)    cadences de la veille (raccourcies par les bancs)

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const argv = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const DIR = path.resolve(opt('--dir', '.'));
const RUN = Number(opt('--run', '1')) || 1;
const TOKEN = String(opt('--token', ''));
const RESUME = Number(opt('--resume', '0')) || 0;

const CONTROL = path.join(DIR, 'control');
const OUT = path.join(DIR, 'out');
const EVENTS = path.join(DIR, 'events.jsonl');
const METRICS = path.join(DIR, 'metrics.jsonl');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (o) => fs.appendFileSync(EVENTS, JSON.stringify(o) + '\n', 'utf8');
const say = (line) => process.stdout.write(line + '\n');
const pad = (n, w) => String(n).padStart(w, '0');

let doc;
try {
  doc = JSON.parse(fs.readFileSync(path.join(DIR, 'train.json'), 'utf8'));
} catch (e) {
  process.stderr.write(`fake-trainer: train.json illisible dans ${DIR} : ${e.message}\n`);
  process.exit(2);
}
const S = doc.settings || {};
const F = S.fake || {};
const STEPS = Math.max(1, Number(doc.steps) || 20);
const SAVE_EVERY = Math.max(1, Number(S.saveEvery) || 250);
const SAMPLE_EVERY = Math.max(0, Number(S.sampleEvery) || 0);
const MS = Number.isFinite(+F.msPerStep) ? +F.msPerStep : 50;
const LR = Number(S.lr) || 1e-4;
const armed = RUN === (Number(F.onRun) || 1);
const at = (k) => (armed && Number.isInteger(F[k]) ? F[k] : null);

// ---------------------------------------------------------------- veille : adapter.json et alive, hors de la boucle des pas
let pauseWanted = false;
let lastTick = Date.now();
let staleSeen = null;       // {mtime, at} : première lecture d'un alive trop vieux
let aliveLostAt = null;
const HEART = Number(F.heartbeatMs) || 20000;
const A_CHECK = Number(F.aliveCheckMs) || 5000;
const A_STALE = Number(F.aliveStaleMs) || 180000;
const A_RECHECK = Number(F.aliveRecheckMs) || 45000;
const A_FORCE = Number(F.aliveForceMs) || 900000;
const JUMP = Number(F.jumpMs) || 60000;

function heartbeat() {
  try {
    const tmp = path.join(CONTROL, 'adapter.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, token: TOKEN, t: Date.now() }), 'utf8');
    fs.renameSync(tmp, path.join(CONTROL, 'adapter.json'));
  } catch { /* le prochain battement réessaie */ }
}

function watchAlive() {
  const now = Date.now();
  if (now - lastTick > JUMP + A_CHECK) { staleSeen = null; aliveLostAt = null; lastTick = now; return; }   // sortie de veille
  lastTick = now;
  let mtime = 0;
  try { mtime = fs.statSync(path.join(CONTROL, 'alive')).mtimeMs; } catch { mtime = 0; }
  if (now - mtime <= A_STALE) { staleSeen = null; aliveLostAt = null; return; }
  if (aliveLostAt === null) aliveLostAt = now;
  if (now - aliveLostAt > A_FORCE) {
    say('fake-trainer: Mia ne donne plus signe de vie, sortie forcée');
    process.exit(3);
  }
  if (!staleSeen || staleSeen.mtime !== mtime) { staleSeen = { mtime, at: now }; return; }
  // deux lectures espacées du même fichier inchangé : Mia est partie, on s'arrête au prochain pas
  if (now - staleSeen.at >= A_RECHECK && !F.ignoreControl) pauseWanted = true;
}

// ---------------------------------------------------------------- fichiers produits
/** Un .safetensors d'environ 1 Ko, cohérent : 8 octets de longueur, en-tête JSON, puis les données annoncées. */
function safetensors(step, truncated) {
  const dataLen = 512;
  let head = JSON.stringify({ __metadata__: { step: String(step), tool: 'fake' }, 'lora.weight': { dtype: 'F32', shape: [dataLen / 4], data_offsets: [0, dataLen] } });
  head += ' '.repeat(Math.max(0, 504 - Buffer.byteLength(head)));
  const h = Buffer.from(head, 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(h.length), 0);
  const data = Buffer.alloc(truncated ? dataLen / 2 : dataLen, step % 251);
  return Buffer.concat([len, h, data]);
}

const ckName = (step) => `step_${pad(step, 5)}`;
const ckDir = (step) => path.join(OUT, 'checkpoints', ckName(step));
const hasCheckpoint = (step) => fs.existsSync(path.join(ckDir(step), 'weights.safetensors'));

function saveCheckpoint(step, { truncated = false } = {}) {
  const base = path.join(OUT, 'checkpoints');
  const tmp = path.join(base, `.tmp_${ckName(step)}`);
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'weights.safetensors'), safetensors(step, truncated));
  fs.writeFileSync(path.join(tmp, 'state.pt'), `state ${step}`);
  fs.writeFileSync(path.join(tmp, 'metadata.json'), JSON.stringify({ step, run: RUN }));
  fs.renameSync(tmp, ckDir(step));
  const file = `out/checkpoints/${ckName(step)}/weights.safetensors`;
  emit({ e: 'checkpoint', step, file, sizeMB: Math.round((fs.statSync(path.join(DIR, file)).size / 1048576) * 1000) / 1000 });
  say(`checkpoint ${step} -> ${file}`);
}

/** Un PNG RVB 8 bits valide (signature, IHDR, IDAT, IEND, sommes de contrôle) ; px(x, y) → [r, v, b], x et y dans 0…1. */
function png(w, h, px) {
  const table = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(td), 0);
    return Buffer.concat([len, td, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;      // 8 bits, RVB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;                                                        // filtre 0 sur chaque ligne
    for (let x = 0; x < w; x++) raw.set(px(x / w, y / h), y * (w * 3 + 1) + 1 + x * 3);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** La taille des essais en image : 8 × 8 par défaut (les bancs du service relisent ce format), [l, h] par sampleSize. */
const SAMPLE_SIZE = Array.isArray(F.sampleSize) && F.sampleSize.length === 2
  ? F.sampleSize.map((v) => Math.max(8, Math.min(1024, Math.round(Number(v) || 8))))
  : [8, 8];

/** Un nombre tiré du nom de l'entraînement : chaque entraînement a sa teinte, ses essais restent dans la même famille. */
const SEED = (() => { let h = 2166136261; for (const ch of String(doc.name || doc.id || DIR)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; })();
const hash = (a, b) => { const x = Math.sin(a * 127.1 + b * 311.7 + (SEED % 997)) * 43758.5453; return x - Math.floor(x); };

/**
 * L'image d'un essai : un portrait sombre et vraisemblable (fond presque noir, une silhouette éclairée de côté),
 * d'une teinte propre à l'entraînement, qui varie d'un essai à l'autre et se précise au fil des pas (moins de bruit,
 * contour plus net) — jamais un aplat, jamais une image claire qui saute aux yeux dans la liste.
 */
function sampleImage(step) {
  const [SW, SH] = SAMPLE_SIZE;
  const p = Math.max(0, Math.min(1, step / STEPS));
  const hue = ((SEED % 360) + 18 * Math.sin(step / 137) + 360) % 360;   // une famille de teintes par entraînement
  const tint = (o) => 0.55 + 0.45 * Math.cos(((hue + o) * Math.PI) / 180);
  const cx = 0.5 + 0.07 * Math.sin(SEED + step / 97);
  const cy = 0.4 + 0.03 * Math.cos(step / 53);
  const soft = 0.16 - 0.1 * p;                       // un contour qui se précise
  const grain = 30 * (1 - p) + 6;                   // un bruit qui s'efface
  const lx = 0.25 + 0.5 * hash(step, 1);            // la lumière vient d'un côté, différent à chaque essai
  return png(SW, SH, (x, y) => {
    const head = Math.hypot((x - cx) / 0.17, (y - cy) / 0.21);
    const body = Math.hypot((x - cx) / 0.36, (y - 1.02) / 0.34);
    const inside = Math.max(0, Math.min(1, (1 - Math.min(head, body)) / soft + 0.5));
    const light = 0.35 + 0.65 * Math.max(0, 1 - Math.hypot(x - lx, y - 0.25) * 1.3);
    const n = (hash(Math.floor(x * SW), Math.floor(y * SH) + step) - 0.5) * grain;
    const bg = 10 + 16 * (1 - y);
    const c = (o) => Math.max(0, Math.min(255, Math.round(bg + inside * light * (40 + 110 * tint(o)) + n)));
    return [c(0), c(120), c(240)];
  });
}

async function sample(step) {
  const t0 = Date.now();
  emit({ e: 'phase', phase: 'sample', t: t0 });
  const total = Math.max(1, Number(F.sampleSteps) || 5);
  const each = Math.max(0, (Number(F.sampleMs) || 0) / total);
  for (let n = 1; n <= total; n++) {
    await sleep(each);
    // ai-toolkit ne publie que « Generating images - i/n » : pas de sample_step (python\train\mia_train_aitk.py)
    if (!F.noSampleStep) emit({ e: 'sample_step', i: 1, of: 1, n, total });
  }
  const dir = path.join(OUT, 'samples');
  fs.mkdirSync(dir, { recursive: true });
  const mp4 = path.join(__dirname, 'sample.mp4');
  const video = F.sampleKind === 'video' && fs.existsSync(mp4);
  const name = `step_${pad(step, 6)}_1.${video ? 'mp4' : 'png'}`;
  if (video) {
    // une copie garde la date de sa source : l'essai est daté de maintenant, comme un fichier que l'outil vient d'écrire
    fs.copyFileSync(mp4, path.join(dir, name));
    const now = new Date();
    try { fs.utimesSync(path.join(dir, name), now, now); } catch { /* la date reste celle de la source */ }
  } else fs.writeFileSync(path.join(dir, name), sampleImage(step));
  emit({ e: 'sample', step, i: 1, file: `out/samples/${name}`, kind: video ? 'video' : 'image', sec: Math.round((Date.now() - t0) / 10) / 100 });
  say(`sample ${step} -> out/samples/${name}`);
  emit({ e: 'phase', phase: 'train', t: Date.now() });
}

/** Perte décroissante avec un bruit reproductible (le même pas donne toujours la même valeur). */
function lossAt(s) {
  const x = Math.sin(s * 12.9898) * 43758.5453;
  const noise = (x - Math.floor(x) - 0.5) * 0.12;
  return Math.round((0.1 + 0.9 * Math.exp((-3 * s) / STEPS) + noise * Math.exp((-1.5 * s) / STEPS)) * 10000) / 10000;
}

function fail(code, step) {
  const lines = {
    oom: 'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB.',
    ram: 'OSError: [WinError 1455] The paging file is too small for this operation to complete.',
    disk: 'OSError: [Errno 28] No space left on device',
    missing: 'FileNotFoundError: [Errno 2] No such file or directory: \'models/absent.safetensors\''
  };
  if (lines[code]) {
    say('Traceback (most recent call last):');
    say('  File "fake-trainer.js", line 1, in <module>');
    say(lines[code]);
  } else if (code === 'takeover' || code === 'version') {
    // le champ « why » des adaptateurs (python\train\mia_train_common.py)
    emit({ e: 'error', code: 'tool', why: code, message: `faux outil : échec « ${code} » demandé au pas ${step}` });
    say(`fake-trainer: échec « ${code} » demandé au pas ${step}`);
  } else {
    emit({ e: 'error', code: 'tool', message: `faux outil : échec demandé au pas ${step}` });
    say(`fake-trainer: échec demandé au pas ${step}`);
  }
  process.exit(1);
}

function stopNow(step, why) {
  if (step > 0 && !hasCheckpoint(step)) saveCheckpoint(step);
  // why : 'stop' (control\stop), 'pause' (control\pause) ou 'alive' (Mia ne donne plus signe de vie)
  emit({ e: 'stopped', step, saved: step > 0 && hasCheckpoint(step), why });
  say(`stopped at step ${step} (${why})`);
  process.exit(0);
}

/** Ce que Mia demande, comme Watch.asked() des adaptateurs : 'stop', 'pause', 'alive' (Mia partie), ou null. */
function asked() {
  if (F.ignoreControl) return null;
  if (fs.existsSync(path.join(CONTROL, 'stop'))) return 'stop';
  if (fs.existsSync(path.join(CONTROL, 'pause'))) return 'pause';
  return pauseWanted ? 'alive' : null;
}

// ---------------------------------------------------------------- déroulé
(async () => {
  fs.mkdirSync(CONTROL, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  heartbeat();
  setInterval(heartbeat, HEART);
  setInterval(watchAlive, A_CHECK);

  emit({ e: 'caps', tool: 'fake-trainer 1.0.0', saveNow: true, run: RUN });
  say(`fake-trainer run ${RUN}${RESUME ? ` (reprise du pas ${RESUME})` : ''} : ${STEPS} pas`);

  const images = Math.max(1, Number(doc.dataset && doc.dataset.count) || 1);
  emit({ e: 'phase', phase: 'check', t: Date.now() });
  await sleep(Math.min(50, MS));
  const encodeEach = Math.max(0, (Number(F.encodeMs) || 0) / images);
  for (let n = 1; n <= images; n++) {
    emit({ e: 'phase', phase: 'encode', n, of: images, t: Date.now() });
    if (encodeEach) await sleep(encodeEach);
  }
  emit({ e: 'phase', phase: 'load', t: Date.now() });
  await sleep(Number(F.loadMs) || 0);
  if (at('failAt') === 0) fail(F.failCode, 0);

  let start = 0;
  if (RESUME > 0) {
    if (F.refuseResume || !hasCheckpoint(RESUME)) {
      // l'outil serait reparti de zéro en silence : l'adaptateur le voit avant le premier pas et n'écrase rien
      emit({ e: 'error', code: 'resume', message: `reprise demandée au pas ${RESUME}, l'outil repart de 0` });
      say(`fake-trainer: reprise refusée (pas ${RESUME})`);
      process.exit(1);
    }
    start = RESUME;
    emit({ e: 'resumed', step: RESUME });
  }
  emit({ e: 'phase', phase: 'train', t: Date.now() });

  for (let s = start + 1; s <= STEPS; s++) {
    const t0 = Date.now();
    if (at('hangAt') === s) { say(`fake-trainer: figé au pas ${s}`); await new Promise(() => {}); }
    await sleep(MS);
    if (at('failAt') === s) fail(F.failCode, s);
    if (at('crashAt') === s) {
      const tmp = path.join(OUT, 'checkpoints', `.tmp_${ckName(s)}`);
      fs.mkdirSync(tmp, { recursive: true });
      fs.writeFileSync(path.join(tmp, 'weights.safetensors'), 'coupé');
      say('Traceback (most recent call last):');
      say('  File "fake-trainer.js", line 1, in <module>');
      say(`RuntimeError: plantage simulé au pas ${s}`);
      process.exit(7);
    }
    const dt = (Date.now() - t0) / 1000;
    const loss = lossAt(s);
    fs.appendFileSync(METRICS, JSON.stringify({ run: RUN, s, loss, lr: LR, dt: Math.round(dt * 1000) / 1000, t: Date.now() }) + '\n', 'utf8');
    say(`step ${s}/${STEPS} loss=${loss}`);
    { const why = asked(); if (why) stopNow(s, why); }
    if (s % SAVE_EVERY === 0 || at('truncateAt') === s) {
      emit({ e: 'phase', phase: 'save', t: Date.now() });
      saveCheckpoint(s, { truncated: at('truncateAt') === s });
      emit({ e: 'phase', phase: 'train', t: Date.now() });
    }
    if (SAMPLE_EVERY > 0 && s % SAMPLE_EVERY === 0) {
      await sample(s);
      const why = asked();
      if (why) stopNow(s, why);                // pause ou arrêt demandés pendant l'essai : pris après l'essai
    }
  }

  if (!hasCheckpoint(STEPS)) saveCheckpoint(STEPS);     // le dernier pas n'est pas toujours sur la cadence
  emit({ e: 'done', step: STEPS, peakVramGB: 0 });
  say('done');
  process.exit(0);
})().catch((e) => {
  try { emit({ e: 'error', code: 'tool', message: String(e && e.message) }); } catch { /* disque plein */ }
  process.stderr.write(`fake-trainer: ${e && e.stack}\n`);
  process.exit(1);
});
