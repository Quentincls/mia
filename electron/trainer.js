'use strict';
/**
 * Mia — training a LoRA: the service of the main process (SPEC « Entraîner un LoRA »).
 *
 * It keeps the list of trainings, prepares their image sets, starts ONE tool at a time, reads what the tool
 * writes, and files the finished LoRA. No screen here and no GPU work: the tool does the computing.
 *
 * THE TRAINING FOLDER IS THE TRUTH. <trainRoot>\<id>\ :
 *   train.json            the record — written by Mia only (.tmp then rename); paths RELATIVE to the folder
 *   dataset\              0001.png (hard link, else a copy) + 0001.txt (ALWAYS a copy) + dataset.json
 *   out\                  what the tool writes (out\ecartes\ : checkpoints refused at resume, put aside)
 *   control\              pause, stop, alive (Mia) · adapter.json {pid, token, t} (the adapter)
 *   events.jsonl          one line per event (the adapter) — Mia never writes it
 *   metrics.jsonl         one line per step (the adapter) — Mia never writes it
 *   log.txt               the tool's raw output: Mia hands the tool this FILE, never a pipe, so a tool that
 *                         outlives Mia can still write and stop cleanly
 *
 * PROTOCOL, the same for every tool (electron\train\*.js describe them; tools\fixtures\train\fake-trainer.js is
 * the reference implementation). Times `t` are milliseconds since 1970.
 *   <adapter> --dir <folder> --run <n> --token <t> [--resume <step>]
 *   events.jsonl
 *     {"e":"caps","tool":"ltx-trainer 1.6.2","saveNow":true,"run":3}       first line of every launch
 *     {"e":"phase","phase":"check"|"encode"|"load"|"train"|"sample"|"save","n":12,"of":32,"t":…}
 *     {"e":"resumed","step":1250}
 *     {"e":"sample_step","i":1,"of":1,"n":14,"total":25}
 *     {"e":"sample","step":1000,"i":1,"file":"out/…","kind":"video"|"image","sec":182}
 *     {"e":"checkpoint","step":1000,"file":"out/…","sizeMB":327}
 *     {"e":"stopped","step":1250,"saved":true,"why":"pause"}   why: "stop" | "pause" | "alive" (Mia gone)
 *     {"e":"done","step":2500,"peakVramGB":46.4}
 *     {"e":"error","code":"oom"|"ram"|"disk"|"missing"|"resume"|"tool"|"hang","message":"…"}
 *   metrics.jsonl   {"run":3,"s":1240,"loss":0.4123,"lr":1e-4,"dt":5.81,"t":…}
 *     For one step the last line wins; a launch that resumed at step N (or restarted at 0) makes every line of
 *     an earlier launch with s > N forgotten.
 *   control\pause, control\stop   the adapter writes a checkpoint at the current step, emits `stopped`, exits 0
 *   control\alive                 rewritten by Mia every 20 s; an adapter that sees it too old stops by itself
 *   control\adapter.json          rewritten by the adapter every 20 s, outside its step loop
 *
 * States (train.json.state): pret · attente · preparation · entrainement · essai · pause · fini · erreur ·
 * annule · interrompu. ACTIVE = attente, preparation, entrainement, essai, and a pause that resumes by itself
 * (« Laisser passer », pause.reason "pass"). One active training at a time.
 *
 * Test instances (MIA_USERDATA or MIA_TRAIN_FAKE=1): trainings live in <userData>\training and LoRAs are filed in
 * <userData>\loras-mia, never in the engine. Mia only lists and touches trainings whose owner.userData is its own.
 *
 * ctx.trainOpts: test hooks only (temporary lock path, short delays, fake clock…), never set by main.js.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFile } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const places = require('./places');
const { createGpuLock, pidAlive } = require('./engine/gpulock');
const { killTree } = require('./engine/pyrun');
const { safetensorsComplete } = require('./train/common');

const TOOLS = { ltx: require('./train/ltx'), aitk: require('./train/aitk'), fake: require('./train/fake') };

const RUNNING = new Set(['preparation', 'entrainement', 'essai']);
const RESUMABLE = new Set(['pause', 'annule', 'interrompu', 'erreur']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const KINDS = ['character', 'place', 'style'];
const TASKKILL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const GB = 1024 ** 3;

/** Delays, in ms. The benches shorten them through ctx.trainOpts.timing. */
const TIMING = {
  tickMs: 1000,            // the files are read every second
  pushMs: 1000,            // one train:event per second at most
  aliveMs: 20000,          // control\alive
  retryMs: 15000,          // GPU held by someone else: try again
  renewMs: 300000,         // the lock is rewritten every 5 min…
  lockMaxMin: 30,          // …with min(time left, 30) minutes: an orphan lock falls within 70 min
  stopMs: 120000,          // « Arrêter » : the tool has this long to write its checkpoint (training)
  stopSampleMs: 360000,    // …or until the running sample ends, 6 min at most
  stopExitMs: { aitk: 30000 }, // …plus the time the adapter itself gives the tool to leave after its own 120 s (python\train\mia_train_aitk.py)
  quitMs: 60000,           // closing Mia: one minute in training
  warnMinMs: 600000,       // « SANS NOUVELLE » at max(10 min, 20 × pace) without a new step
  warnPaces: 20,
  killMinMs: 2700000,      // given up at max(45 min, 100 × pace) in training…
  killPaces: 100,
  sampleKillMs: 1800000,   // …30 min for a sample…
  loadKillMs: 1800000,     // …30 min for the preparation (check, encode, load)
  jumpMs: 60000,           // the clock jumped (the PC slept): every counter starts again
  adoptMaxAgeMs: 60000,    // at startup: an adapter.json older than this means the tool is gone
  noteMs: 60000,           // one note a minute per assistant
  memWaitMs: 10000,        // Mia's ComfyUI stopped for a training: the commit memory is measured again for 10 s at most…
  memPollMs: 1000          // …once a second
};

const STR = {
  unknown: { fr: 'Entraînement introuvable.', en: 'Training not found.' },
  unknownBase: { fr: 'Modèle inconnu : {id}', en: 'Unknown model: {id}' },
  notDraft: { fr: 'Cet entraînement n’est plus un brouillon.', en: 'This training is no longer a draft.' },
  notResumable: { fr: 'Cet entraînement ne peut pas être repris dans cet état.', en: 'This training cannot be resumed in this state.' },
  notRunning: { fr: 'Cet entraînement n’est pas en cours.', en: 'This training is not running.' },
  badAction: { fr: 'Action inconnue : {a}', en: 'Unknown action: {a}' },
  importBusy: { fr: 'L’import des images est en cours.', en: 'The images are still being imported.' },
  noName: { fr: 'Donne un nom', en: 'Give it a name' },
  fewImages: { fr: 'Ajoute au moins {n} images', en: 'Add at least {n} images' },
  noTrigger: { fr: 'Donne un mot déclencheur', en: 'Give a trigger word' },
  noCaption: { fr: '{n} images sans légende', en: '{n} images without a caption' },
  otherActive: { fr: 'Un autre entraînement est en cours', en: 'Another training is running' },
  disk: { fr: 'Place disque insuffisante : {a} Go nécessaires, {b} Go libres', en: 'Not enough disk space: {a} GB needed, {b} GB free' },
  memory: {
    fr: 'Mémoire Windows insuffisante pour charger le modèle : {a} Go disponibles, {n} nécessaires. Ferme des applications ou agrandis le fichier d’échange.',
    en: 'Not enough Windows memory to load the model: {a} GB available, {n} needed. Close applications or enlarge the page file.'
  },
  weights: { fr: 'Poids de base absents : {list}', en: 'Base weights missing: {list}' },
  tool: { fr: 'Outil d’entraînement introuvable : {path}', en: 'Training tool not found: {path}' },
  version: { fr: '{tool} : version {v} non validée', en: '{tool}: version {v} not validated' },
  untried: { fr: 'Pas encore essayé sur cette machine', en: 'Not tried on this machine yet' },
  nogpu: { fr: 'GPU désactivé dans cette instance de test (MIA_NO_GPU=1).', en: 'GPU disabled in this test instance (MIA_NO_GPU=1).' },
  noEngine: { fr: places.noEngine('fr'), en: places.noEngine('en') },
  proposalChanged: { fr: 'Le brouillon a changé depuis la proposition : elle est annulée.', en: 'The draft changed since the suggestion: it is cancelled.' },
  noProposal: { fr: 'Aucune proposition en attente pour cet entraînement.', en: 'No suggestion is waiting for this training.' },
  activeNoRemove: {
    fr: 'Un entraînement en cours ne peut pas aller à la corbeille : arrête-le d’abord.',
    en: 'A running training cannot go to the Recycle Bin: stop it first.'
  },
  trashFailed: { fr: 'Impossible de mettre « {name} » à la corbeille.', en: 'Could not move “{name}” to the Recycle Bin.' },
  noCheckpoint: { fr: 'Aucun point de contrôle au pas {step}.', en: 'No checkpoint at step {step}.' },
  badCheckpoint: { fr: 'Le point de contrôle du pas {step} est incomplet.', en: 'The checkpoint of step {step} is incomplete.' },
  notInLoras: { fr: 'Ce point de contrôle n’est pas dans Mes LoRA.', en: 'This checkpoint is not in My LoRAs.' },
  noLoras: { fr: 'Dossier des LoRA du moteur introuvable : {path}', en: 'The engine’s LoRA folder was not found: {path}' },
  fileFailed: { fr: 'Écriture impossible dans {dir} ({msg}).', en: 'Could not write in {dir} ({msg}).' },
  rootUnreachable: { fr: 'Le dossier des entraînements est inaccessible : {dir}', en: 'The trainings folder cannot be reached: {dir}' },
  noteEmpty: { fr: 'La note est vide.', en: 'The note is empty.' },
  noteLong: { fr: 'Une note fait 280 caractères au plus.', en: 'A note is 280 characters at most.' },
  noteRate: { fr: 'Une note par minute au plus.', en: 'One note a minute at most.' },
  noteMax: { fr: '40 notes au plus par entraînement.', en: '40 notes at most per training.' },
  notMissing: { fr: 'Le dossier de cet entraînement est déjà connu.', en: 'The folder of this training is already known.' },
  locateWrong: { fr: 'Ce dossier n’est pas celui de cet entraînement.', en: 'This folder is not the one of this training.' },
  noImage: { fr: 'Image introuvable dans le jeu : {name}', en: 'Image not found in the set: {name}' },
  // why a training ended in error (train.json.error.message)
  e_oom: { fr: 'Mémoire GPU pleine.', en: 'GPU memory full.' },
  e_ram: { fr: 'Mémoire Windows insuffisante pendant le chargement.', en: 'Not enough Windows memory while loading.' },
  e_disk: { fr: 'Disque plein.', en: 'Disk full.' },
  e_missing: { fr: 'Le fichier de poids {f} est introuvable.', en: 'Weights file {f} not found.' },
  e_resume: { fr: 'La reprise a été refusée par l’outil : rien n’a été écrasé.', en: 'The tool refused to resume: nothing was overwritten.' },
  e_hang: { fr: 'L’outil ne répondait plus depuis {n} min : arrêté au pas {a}.', en: 'The tool had stopped responding for {n} min: stopped at step {a}.' },
  e_spawn: { fr: 'Impossible de lancer l’outil : {line}', en: 'Could not start the tool: {line}' },
  e_tool: { fr: 'L’outil s’est arrêté (code {c}) : {line}', en: 'The tool stopped (code {c}): {line}' },
  e_toolNoLine: { fr: 'L’outil s’est arrêté (code {c}).', en: 'The tool stopped (code {c}).' },
  e_takeover: { fr: 'L’outil n’a pas pris le pilotage de Mia.', en: 'The tool did not take Mia’s control.' },
  e_version: { fr: 'Version de l’outil LTX non reconnue (attendue : ltx-trainer 1.6.2).', en: 'Unrecognised LTX tool version (expected: ltx-trainer 1.6.2).' },
  // the card kept beside a filed LoRA (<name>.mia.json)
  advice: {
    fr: 'Entraîné dans Mia sur {base}, {steps} pas, {images} images. Mets « {trigger} » dans la consigne.',
    en: 'Trained in Mia on {base}, {steps} steps, {images} images. Put “{trigger}” in the prompt.'
  },
  adviceStep: {
    fr: 'Étape {step} d’un entraînement dans Mia sur {base} ({steps} pas prévus, {images} images). Mets « {trigger} » dans la consigne.',
    en: 'Step {step} of a training in Mia on {base} ({steps} steps planned, {images} images). Put “{trigger}” in the prompt.'
  }
};

const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
const both = (key, vars) => ({ fr: fill(STR[key].fr, vars), en: fill(STR[key].en, vars) });
const fmtInt = (n, lang) => Math.round(+n || 0).toLocaleString(lang === 'en' ? 'en-US' : 'fr-FR');
const fmtGB = (n, lang) => (Math.round((+n || 0) * 10) / 10).toLocaleString(lang === 'en' ? 'en-US' : 'fr-FR', { maximumFractionDigits: 1 });
const sameDir = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const posix = (p) => String(p || '').split(path.sep).join('/');
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const median = (list) => {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** null, undefined and '' stay null (+null is 0: a mean of no step must not read as a loss of 0); 0 stays 0. */
const round = (v, d = 1) => (v == null || v === '' || !Number.isFinite(+v) ? null : Math.round(+v * 10 ** d) / 10 ** d);
/** « 2026-11-19 » : the day on this PC's clock (toISOString would give the UTC day — the day before, just after midnight in France). */
const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Same rule as scanner.js (cleanFileStem): a safe file name for models\loras\mia, without accents nor path. */
function cleanStem(stem, fallback = 'lora') {
  return String(stem || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+|[._]+$/g, '').slice(0, 80) || fallback;
}

/** Same sorting as pyrun.js (meaningfulLine): the last line of a log worth showing to a human. */
function meaningfulLine(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l || /^(\^|~|File "|Traceback|During handling)/.test(l)) continue;
    return l.slice(0, 300);
  }
  return '';
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function readJSON(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/** The last lines of a text file, without reading it whole (a tool's log grows for hours). */
function tailLines(file, max = 200, bytes = 65536) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (len < size) lines.shift();                       // the first one is cut
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.slice(-max);
  } catch {
    return [];
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } }
  }
}

function freeBytesOf(dir) {
  try {
    let d = dir;
    while (d && !fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
    const s = fs.statfsSync(d);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

async function dirBytes(dir) {
  let total = 0;
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirBytes(abs);
    else { try { total += (await fsp.stat(abs)).size; } catch { /* gone meanwhile */ } }
  }
  return total;
}

/**
 * Windows' commit memory still available (RAM + page file), in GB — what decides whether a 39 GB model can be
 * loaded on a 32 GB PC. Read from the performance classes (their names are not translated, unlike the counters).
 * → a number, or null when Windows does not answer (the start is then not refused on that ground).
 */
function commitAvailableGB() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const cmd = '$m = Get-CimInstance Win32_PerfRawData_PerfOS_Memory; \'{0} {1}\' -f $m.CommitLimit, $m.CommittedBytes';
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { windowsHide: true, timeout: 15000 }, (err, stdout) => {
        const m = /(\d+)\s+(\d+)/.exec(String(stdout || ''));
        if (err || !m) return resolve(null);
        resolve(Math.max(0, Math.round(((+m[1] - +m[2]) / GB) * 10) / 10));
      });
  });
}

// ---------------------------------------------------------------- images: size and orientation, read once
/** {w, h} as the image is SHOWN (EXIF orientation applied), or null when the file is not a readable image. */
function imageSize(buf) {
  try {
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      return w > 0 && h > 0 ? { w, h } : null;
    }
    if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
      const kind = buf.toString('latin1', 12, 16);
      if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') {
        const b = buf.subarray(21, 25);
        return { w: 1 + (((b[1] & 0x3f) << 8) | b[0]), h: 1 + (((b[3] & 0x0f) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6)) };
      }
      if (kind === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      return null;
    }
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      let turned = false;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xff) { i++; continue; }
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (marker === 0xe1 && buf.toString('latin1', i + 4, i + 10) === 'Exif\0\0') {
          const o = exifOrientation(buf.subarray(i + 10, i + 2 + len));
          turned = o >= 5 && o <= 8;
        }
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const h = buf.readUInt16BE(i + 5);
          const w = buf.readUInt16BE(i + 7);
          if (!(w > 0 && h > 0)) return null;
          return turned ? { w: h, h: w } : { w, h };
        }
        if (marker === 0xda) return null;                 // image data without a frame header before it
        i += 2 + len;
      }
      return null;
    }
  } catch { /* truncated header */ }
  return null;
}

function exifOrientation(tiff) {
  try {
    const le = tiff.toString('latin1', 0, 2) === 'II';
    const u16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
    const u32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
    const ifd = u32(4);
    const n = u16(ifd);
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + k * 12;
      if (u16(e) === 0x0112) return u16(e + 8);
    }
  } catch { /* damaged EXIF: as if absent */ }
  return 1;
}

function readImageSize(file) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(Math.min(size, 262144));
    fs.readSync(fd, head, 0, head.length, 0);
    let dim = imageSize(head);
    if (!dim && head.length < size && head[0] === 0xff && head[1] === 0xd8) {   // a JPEG with a big profile first
      const all = Buffer.alloc(Math.min(size, 64 * 1024 * 1024));
      fs.readSync(fd, all, 0, all.length, 0);
      dim = imageSize(all);
    }
    return dim ? { ...dim, bytes: size } : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } }
  }
}

/** A caption file → clean text (UTF-8 without BOM; UTF-16 with a BOM is read too). '' = no caption. */
function readCaption(file) {
  try {
    const b = fs.readFileSync(file);
    let s;
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) s = b.subarray(2).toString('utf16le');
    else s = b.toString('utf8').replace(/^\uFEFF/, '');
    return s.replace(/\r\n?/g, '\n').trim();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- the GPU door used when there is no engine
/**
 * Takes the engine folder's shared lock (gpulock.js) for the length of a training: min(time left, 30) minutes,
 * rewritten every 5 minutes. Without a lock file (the fake tool, no engine) there is nothing to take.
 * In Mia the engine's own door is used instead (Engine.holdGpu and adoptGpu, see gate()): it also waits for Mia's
 * local jobs and holds its queue back. This one remains for a service built without an engine (benches).
 */
function createLockGate({ lockFile, cfg, log }) {
  const sleep = (ms, signal) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
  function handle(lock, label, minutes, file) {
    const timer = setInterval(() => {
      const r = lock.renew(label, minutes(), file);
      if (!r.ok) log('lock renew refused', r.info ? `(${r.info.qui})` : r.error && r.error.message);
    }, cfg.renewMs);
    if (timer.unref) timer.unref();
    // abandon: stop rewriting the lock without removing it (what a crash of Mia leaves behind; used by the benches)
    return { file, release: () => { clearInterval(timer); return lock.release(label, file); }, abandon: () => clearInterval(timer) };
  }
  return {
    async hold({ label, minutes, signal, onWait }) {
      const file = lockFile();
      if (!file) return { file: null, release: () => false };
      const lock = createGpuLock({ lockPath: file });
      for (;;) {
        if (signal && signal.aborted) return null;
        const r = lock.take(label, minutes(), file);
        if (r.ok) return handle(lock, label, minutes, file);
        if (typeof onWait === 'function') onWait(r.info.qui || '?', r.info.depuis || '');
        await sleep(cfg.retryMs, signal);
      }
    },
    /** After a restart of Mia: the lock of the training that is still running, taken back under the same label. */
    adopt({ label, minutes }) {
      const file = lockFile();
      if (!file) return { file: null, release: () => false };
      const lock = createGpuLock({ lockPath: file });
      try {
        const r = lock.take(label, minutes(), file);
        return r.ok ? handle(lock, label, minutes, file) : null;
      } catch {
        return null;
      }
    }
  };
}

// ---------------------------------------------------------------- the service
class Trainer {
  constructor(ctx) {
    this.ctx = ctx;
    this.opts = ctx.trainOpts || {};
    this.cfg = { ...TIMING, ...(this.opts.timing || {}) };
    this.now = typeof this.opts.now === 'function' ? this.opts.now : () => Date.now();
    this.log = typeof ctx.logger === 'function' ? ctx.logger('trainer') : () => {};
    this.items = new Map();          // id → {id, dir, doc, missing, live, dataset, files, importing, queue, dirty, sizeAt, sizeMB}
    this.prefs = {};
    this.timer = null;
    this.catalog = null;
    this.ready = Promise.resolve();
    this.listeners = new Set();      // onChange: the engine (what may start beside a training) and main.js (taskbar, sleep)
    this.briefMemo = null;
  }

  /**
   * A « by » that comes from the page is an assistant's name relayed by presence.js, never Quentin nor Mia:
   * « user » (or nothing given explicitly but an empty string) and « Mia » become « Assistant ». Quentin's own clicks
   * carry no « by » at all and stay « user ». Only the main process may sign as Mia (automatic resume, final LoRA).
   */
  static pageBy(v) {
    const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40);
    if (!s || /^(user|mia)$/i.test(s)) return 'Assistant';
    return s;
  }

  static pageArgs(name, args) {
    const out = args.slice();
    if (name === 'setCaption') { if (out.length > 3 && out[3] !== undefined) out[3] = Trainer.pageBy(out[3]); return out; }
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      if (a && typeof a === 'object' && !Array.isArray(a) && Object.prototype.hasOwnProperty.call(a, 'by')) out[i] = { ...a, by: Trainer.pageBy(a.by) };
    }
    return out;
  }

  // ------------------------------------------------------------ install
  install() {
    const h = (name, fn) => this.ctx.ipcMain.handle(`train:${name}`, async (_e, ...args) => {
      try {
        await this.ready;
        await this.refreshPrefs();
        return await fn.apply(this, Trainer.pageArgs(name, args));
      } catch (e) {
        this.log(`${name} failed:`, e && e.stack ? e.stack : e);
        return { ok: false, error: String((e && e.message) || e) };
      }
    });
    h('options', this.options);
    h('list', this.list);
    h('get', this.get);
    h('create', this.create);
    h('update', this.update);
    h('addImages', this.addImages);
    h('removeImage', this.removeImage);
    h('setCaption', this.setCaption);
    h('start', this.start);
    h('control', this.control);
    h('addToLoras', this.addToLoras);
    h('removeFromLoras', this.removeFromLoras);
    h('note', this.note);
    h('remove', this.remove);
    h('reveal', this.reveal);
    h('locate', this.locate);
    h('seen', this.seen);

    // the engine's door knows the training through this service: its status, what may run beside it, the last net at quit
    const engine = this.ctx.engine;
    if (engine && typeof engine.attachTrainer === 'function') engine.attachTrainer(this);

    // prefs are read synchronously in Mia (store.getPrefs), so the trainings found running are taken back in hand
    // — and their GPU lock with them — before anything else can take an orphan lock away
    const boot = (p) => {
      this.prefs = p || {};
      try { this.scan(); this.reconcile(); } catch (e) { this.log('startup scan failed:', e && e.stack ? e.stack : e); }   // the channels answer anyway
    };
    let p = null;
    try { p = this.ctx.prefs.get(); } catch (e) { this.log('prefs:', e.message); }
    if (p && typeof p.then === 'function') this.ready = p.then(boot).catch((e) => this.log('boot failed:', e.message));
    else boot(p);
    if (this.ctx.prefs && typeof this.ctx.prefs.onChange === 'function') {
      this.ctx.prefs.onChange((next, changed) => {
        this.prefs = next || this.prefs;
        if (changed && (changed.has('trainRoot') || changed.has('trainRoots') || changed.has('engineRoot'))) { this.scan(); this.push(null); }
      });
    }
    return this;
  }

  async refreshPrefs() {
    try {
      const p = await this.ctx.prefs.get();
      if (p) this.prefs = p;
    } catch { /* keep the last ones */ }
  }

  lang() { return this.prefs && this.prefs.lang === 'en' ? 'en' : 'fr'; }
  tr(key, vars) { return fill(STR[key][this.lang()], vars); }
  fail(code, vars) { return { ok: false, code, error: this.tr(code, vars) }; }

  // ------------------------------------------------------------ places
  userData() { return (this.ctx.paths && (this.ctx.paths.userData || (this.ctx.paths.data && path.dirname(this.ctx.paths.data)))) || ''; }
  dataDir() { return (this.ctx.paths && this.ctx.paths.data) || path.join(this.userData(), 'data'); }
  miaRoot() { return (this.ctx.paths && this.ctx.paths.root) || path.resolve(__dirname, '..'); }
  engineRoot() { return places.engineRoot(this.prefs); }
  isTest() { return places.trainingIsTest(); }
  trainRoot() { return places.trainingRoot(this.prefs, this.userData()); }
  roots() { return places.trainingRoots(this.prefs, this.userData()); }
  toolsDir() { return this.opts.toolsDir || places.trainingTools(this.prefs); }
  /** Where a finished LoRA goes: the engine's models\loras\mia — or <userData>\loras-mia in a test instance. */
  lorasDir() {
    if (this.isTest()) return path.join(this.userData(), 'loras-mia');
    const r = this.engineRoot();
    return r ? path.join(r, 'models', 'loras', 'mia') : '';
  }
  indexFile() { return path.join(this.dataDir(), 'trainings.json'); }
  timingsFile() { return path.join(this.dataDir(), 'train-timings.json'); }

  // ------------------------------------------------------------ catalog and tools
  loadCatalog() {
    if (this.catalog) return this.catalog;
    const j = readJSON(path.join(this.miaRoot(), 'src', 'catalog', 'train-bases.json')) || {};
    this.catalog = {
      minImages: Number(j.minImages) || 10,
      adviseImages: Number(j.adviseImages) || 20,
      samplePrompts: j.samplePrompts || {},
      bases: Array.isArray(j.bases) ? j.bases : []
    };
    return this.catalog;
  }

  bases() {
    const list = this.loadCatalog().bases.filter((b) => b && b.enabled && TOOLS[b.tool]);
    return TOOLS.fake.enabled() ? [...list, TOOLS.fake.BASE] : list;
  }

  base(id) { return this.bases().find((b) => b.id === id) || null; }

  /** Read once, then kept in memory (asked at every refresh of the screen; this Mia is its only writer). */
  timings() {
    if (!this.learned) {
      const j = readJSON(this.timingsFile());
      this.learned = j && typeof j === 'object' && !Array.isArray(j) ? j : {};
    }
    return this.learned;
  }

  /** What Mia knows about a base's speed: learned on this PC first, else the catalog's measures. */
  measuredOf(base) {
    const learned = this.timings()[base.id] || {};
    const out = { ...(base.measured || {}) };
    for (const [k, v] of Object.entries(learned)) if (Number.isFinite(+v) && +v > 0) out[k] = +v;
    return out;
  }

  /** Is this base usable now? → {ready, why:{code, fr, en}|null, missing:[{file, sizeGB}], version} */
  baseState(base) {
    const tool = TOOLS[base.tool];
    const why = (code, vars) => ({ code, ...both(code, vars) });
    if (!base.tried) return { ready: false, why: why('untried'), missing: [], version: null };
    if (tool.gpu && process.env.MIA_NO_GPU === '1') return { ready: false, why: why('nogpu'), missing: [], version: null };
    const toolsDir = this.toolsDir();
    if (tool.gpu && !toolsDir) return { ready: false, why: why('noEngine'), missing: [], version: null };   // nowhere to look for the tools
    const d = tool.detect({ toolsDir, root: this.miaRoot(), toolVersion: base.toolVersion });
    if (!d.ok) {
      if (d.why && d.why.code === 'version') return { ready: false, why: why('version', { tool: base.tool === 'ltx' ? 'LTX' : tool.label, v: d.why.version }), missing: [], version: d.version };
      return { ready: false, why: why('tool', { path: (d.why && d.why.path) || this.toolsDir() }), missing: [], version: d.version };
    }
    const missing = [];
    if (base.weights && base.weights.length) {
      const er = this.engineRoot();
      if (!er) return { ready: false, why: why('noEngine'), missing: [], version: d.version };
      for (const w of base.weights) {
        if (!fs.existsSync(path.join(er, 'models', w.dir, w.file))) missing.push({ file: w.file, sizeGB: w.sizeGB });
      }
    }
    if (missing.length) {
      const list = (lang) => missing.map((m) => `${m.file} (${fmtGB(m.sizeGB, lang)} ${lang === 'en' ? 'GB' : 'Go'})`).join(', ');
      return {
        ready: false,
        why: { code: 'weights', fr: fill(STR.weights.fr, { list: list('fr') }), en: fill(STR.weights.en, { list: list('en') }) },
        missing,
        version: d.version
      };
    }
    return { ready: true, why: null, missing: [], version: d.version };
  }

  // ------------------------------------------------------------ list on disk
  /** Read every training of the trainings folders (and of the index: a folder that vanished stays listed). */
  scan() {
    const mine = this.userData();
    const found = new Map();
    for (const root of this.roots()) {
      let names = [];
      try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const e of names) {
        if (!e.isDirectory()) continue;
        const dir = path.join(root, e.name);
        const doc = readJSON(path.join(dir, 'train.json'));
        if (doc && doc.id && !found.has(doc.id)) found.set(doc.id, { dir, doc });
      }
    }
    const index = readJSON(this.indexFile());
    const known = index && Array.isArray(index.items) ? index.items : [];
    for (const k of known) {
      if (!k || !k.id || found.has(k.id)) continue;
      const doc = k.dir ? readJSON(path.join(k.dir, 'train.json')) : null;
      if (doc && doc.id === k.id) found.set(k.id, { dir: k.dir, doc });
      else found.set(k.id, { dir: k.dir || '', doc: null, ghost: k });
    }
    for (const [id, f] of found) {
      const cur = this.items.get(id);
      // already known: Mia is the only writer of train.json, so memory is never behind the disk
      if (cur && !cur.missing) { if (!f.doc && !cur.live && !fs.existsSync(cur.dir)) cur.missing = true; continue; }
      if (f.doc && !(f.doc.owner && sameDir(f.doc.owner.userData, mine))) continue;     // another Mia's training
      if (f.doc && cur) {                                             // a missing folder is back
        cur.dir = f.dir;
        cur.doc = this.normalize(f.doc);
        cur.missing = false;
        cur.dataset = null;
        cur.proto = null;
      } else if (f.doc) {
        this.items.set(id, { id, dir: f.dir, doc: this.normalize(f.doc), missing: false });
      } else if (!cur) {
        const g = f.ghost;
        this.items.set(id, { id, dir: g.dir || '', missing: true, doc: this.normalize({ id, name: g.name || id, base: g.base || '', state: g.state || 'pret', by: { who: 'user', at: g.at || 0 } }) });
      }
    }
    for (const [id, it] of [...this.items]) {
      if (found.has(id) || it.live) continue;
      if (it.missing || fs.existsSync(path.join(it.dir, 'train.json'))) continue;      // listed as missing, or elsewhere but there
      it.missing = true;
    }
  }

  writeIndex() {
    const items = [...this.items.values()].map((it) => ({ id: it.id, dir: it.dir, name: it.doc.name, base: it.doc.base, state: it.doc.state, at: it.doc.by && it.doc.by.at }));
    try {
      fs.mkdirSync(this.dataDir(), { recursive: true });
      writeAtomic(this.indexFile(), JSON.stringify({ v: 1, items }, null, 1));
    } catch (e) {
      this.log('index write failed:', e.message);
    }
  }

  /** A train.json read from disk, with every field the code relies on. */
  normalize(d) {
    const doc = { ...d };
    doc.v = 1;
    doc.name = typeof doc.name === 'string' ? doc.name : '';
    doc.slug = doc.slug || cleanStem(doc.name);
    doc.kind = KINDS.includes(doc.kind) ? doc.kind : 'character';
    doc.trigger = typeof doc.trigger === 'string' ? doc.trigger : '';
    doc.by = doc.by && typeof doc.by === 'object' ? doc.by : { who: 'user', at: 0 };
    doc.state = typeof doc.state === 'string' ? doc.state : 'pret';
    doc.run = Number.isInteger(doc.run) ? doc.run : 0;
    doc.step = Number.isFinite(+doc.step) ? +doc.step : 0;
    doc.steps = Number.isFinite(+doc.steps) ? +doc.steps : 0;
    doc.settings = doc.settings && typeof doc.settings === 'object' ? doc.settings : {};
    doc.dataset = doc.dataset && typeof doc.dataset === 'object' ? doc.dataset : { count: 0, captions: 0, source: '', small: 0, skipped: [] };
    if (!Array.isArray(doc.dataset.skipped)) doc.dataset.skipped = [];
    doc.measured = doc.measured && typeof doc.measured === 'object' ? doc.measured : {};
    for (const k of ['checkpoints', 'samples', 'notes']) if (!Array.isArray(doc[k])) doc[k] = [];
    for (const k of ['proposal', 'lastWatch', 'proc', 'pause', 'error', 'filed']) if (doc[k] === undefined) doc[k] = null;
    doc.seen = doc.seen !== false;
    return doc;
  }

  item(id) { return this.items.get(String(id || '')) || null; }

  /** train.json on disk, now if possible; on a full disk the state stays in memory and the tick tries again. */
  save(item) {
    if (!item || item.missing) return false;
    try {
      writeAtomic(path.join(item.dir, 'train.json'), JSON.stringify(item.doc, null, 1));
      item.dirty = false;
      return true;
    } catch (e) {
      item.dirty = true;
      this.ensureTimer();
      this.log(`train.json of ${item.id} not written (${e.code || e.message}): kept in memory`);
      return false;
    }
  }

  isActive(item) {
    const d = item.doc;
    return d.state === 'attente' || RUNNING.has(d.state) || (d.state === 'pause' && !!d.pause && d.pause.reason === 'pass');
  }

  active() {
    for (const it of this.items.values()) if (!it.missing && this.isActive(it)) return it;
    return null;
  }

  // ------------------------------------------------------------ events to the window
  /** One train:event per second and per training at most; `now` for what must not wait (a state change). */
  push(item, now = false) {
    for (const fn of this.listeners) { try { fn(item ? item.id : null); } catch (e) { this.log('onChange listener:', e.message); } }
    if (typeof this.ctx.send !== 'function') return;
    if (!item) { try { this.ctx.send('train:event', { id: null, list: true }); } catch { /* window gone */ } return; }
    const t = Date.now();
    if (!now && item.pushedAt && t - item.pushedAt < this.cfg.pushMs) { item.pushLate = true; return; }
    item.pushedAt = t;
    item.pushLate = false;
    try { this.ctx.send('train:event', { id: item.id, summary: this.summary(item) }); } catch { /* window gone */ }
  }

  /** fn(id | null) at every change of a training (null: the list changed). → unsubscribe. Main process only. */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * The active training in a few fields, for the engine's status (statusNow().training), the queue's waiting
   * message, the taskbar and the bridge: {id, name, base, state, phase, pause, step, steps, progress, endAt,
   * peakVramGB} | null.
   * Asked often: computed once per step (the end time reads the tool's files).
   */
  brief() {
    const item = this.active();
    if (!item) { this.briefMemo = null; return null; }
    const d = item.doc;
    const key = `${item.id}|${d.state}|${d.phase || ''}|${d.pause ? d.pause.reason : ''}|${d.step}|${d.steps}|${d.name}`;
    const m = this.briefMemo;
    if (m && m.key === key && Date.now() - m.at < 5000) return m.value;
    // its known peak of GPU memory (this training's, else what this PC or the catalog measured for its base): the
    // engine never counts less than that beside it (SPEC §8.7), a reading between two steps can be lower
    const base = this.base(d.base);
    const peak = d.measured && d.measured.peakVramGB > 0 ? d.measured.peakVramGB : (base ? this.measuredOf(base).peakVramGB : null);
    const value = {
      id: item.id, name: d.name, base: d.base, state: d.state, phase: d.phase || null, pause: d.pause ? d.pause.reason : null,
      step: d.step, steps: d.steps, progress: d.steps > 0 ? Math.max(0, Math.min(1, d.step / d.steps)) : 0,
      endAt: this.eta(item).endAt, peakVramGB: Number(peak) > 0 ? Number(peak) : null
    };
    this.briefMemo = { key, at: Date.now(), value };
    return value;
  }

  // ------------------------------------------------------------ what a training looks like, for the window and the bridge
  summary(item) {
    const d = item.doc;
    const live = item.live;
    const eta = this.eta(item);
    return {
      id: item.id,
      name: d.name,
      base: d.base,
      kind: d.kind,
      state: d.state,
      phase: d.phase || null,
      pause: d.pause || null,
      step: d.step,
      steps: d.steps,
      progress: d.steps > 0 ? Math.max(0, Math.min(1, d.step / d.steps)) : 0,
      endAt: eta.endAt,
      seen: d.seen,
      missing: !!item.missing,
      at: (d.by && d.by.at) || 0,
      startedAt: d.startedAt || null,
      endedAt: d.endedAt || null,
      sizeMB: item.sizeMB != null ? item.sizeMB : null,
      proposal: d.proposal ? { by: d.proposal.by, at: d.proposal.at, resume: !!d.proposal.resume } : null,
      wait: live && live.wait ? live.wait : null,
      pending: live && live.want ? live.want : null,
      silent: !!(live && live.warn),
      importing: item.importing || null,
      images: d.dataset.count,
      thumb: this.thumbOf(item),
      error: d.error ? { code: d.error.code, message: d.error.message } : null,
      // the final LoRA could not be filed (folder, disk…): the end block says why and offers to try again
      filed: d.filed && d.filed.ok === false ? { ok: false, code: d.filed.code, message: d.filed.message, at: d.filed.at } : null
    };
  }

  /** A picture for the list of trainings: the last image sample, else the first image of the set. Absolute path, or null. */
  thumbOf(item) {
    if (item.missing) return null;
    const d = item.doc;
    for (let i = d.samples.length - 1; i >= 0; i--) if (d.samples[i].kind === 'image') return path.join(item.dir, d.samples[i].file);
    if (!d.dataset.count) return null;
    const first = this.loadDataset(item)[0];
    return first ? path.join(item.dir, 'dataset', first.file) : null;
  }

  /** The valid points of the curve: for one step the last line wins, a resumed launch forgets what it abandons. */
  curve(item) {
    this.readProtocol(item);
    const p = item.proto;
    if (p.curveAt === p.version) return p.curve;
    const valid = (m) => !p.resumes.some((r) => r.run > m.run && m.s > r.step);
    const byStep = new Map();
    for (const m of p.metrics) if (valid(m)) byStep.set(m.s, m);
    p.curve = [...byStep.values()].sort((a, b) => a.s - b.s);
    p.curveAt = p.version;
    return p.curve;
  }

  /** Seconds per step: the median of the last 20 steps, without those where a sample or a checkpoint took place. */
  pace(item) {
    const d = item.doc;
    const skip = new Set([...d.checkpoints.map((c) => c.step), ...d.samples.map((s) => s.step)]);
    const dts = this.curve(item).filter((m) => m.run === d.run && !skip.has(m.s) && Number.isFinite(m.dt)).slice(-20).map((m) => m.dt);
    const med = median(dts);
    if (med != null) return med;
    const base = this.base(d.base);
    const known = base ? this.measuredOf(base).sPerStep : null;
    return d.measured.sPerStep || known || null;
  }

  samplesLeft(item, from) {
    const d = item.doc;
    const every = Number(d.settings.sampleEvery) || 0;
    if (!every || !d.steps) return 0;
    return Math.max(0, Math.floor(d.steps / every) - Math.floor((from || 0) / every));
  }

  /** {seconds, endAt}: steps left × pace + samples left × the measured length of a sample (+ preparation before the first step). */
  eta(item) {
    const d = item.doc;
    if (!d.steps || d.state === 'fini') return { seconds: null, endAt: null };
    const pace = this.pace(item);
    if (!pace) return { seconds: null, endAt: null };
    const base = this.base(d.base);
    const m = base ? this.measuredOf(base) : {};
    const sampleSec = d.measured.sampleSec || m.sampleSec || 0;
    let seconds = Math.max(0, d.steps - d.step) * pace + this.samplesLeft(item, d.step) * sampleSec;
    if (d.state === 'pret' || d.state === 'attente' || d.state === 'preparation') {
      seconds += (m.loadSec || 0) + (d.run > 0 || d.state !== 'pret' ? 0 : (m.encodeSecPerImage || 0) * d.dataset.count);
    }
    seconds = Math.round(seconds);
    return { seconds, endAt: RUNNING.has(d.state) || d.state === 'attente' || d.state === 'pret' ? this.now() + seconds * 1000 : null };
  }

  /** Disk needed to start (or resume from `from`), in bytes: checkpoints to come + cache + a reserve. */
  diskNeed(item, from = 0) {
    const d = item.doc;
    const base = this.base(d.base);
    if (!base) return 0;
    const m = this.measuredOf(base);
    const ckMB = d.measured.checkpointMB || m.checkpointMB || 0;
    const every = Math.max(1, Number(d.settings.saveEvery) || 250);
    const left = Math.ceil(Math.max(0, d.steps - from) / every) + 1;
    const cacheMB = d.run > 0 ? 0 : ((base.disk && base.disk.cacheMBPerImage) || 0) * d.dataset.count;
    return Math.round((left * ckMB + cacheMB) * 1048576 + ((base.disk && base.disk.reserveGB) || 0) * GB);
  }

  freeBytes(dir) { return typeof this.opts.freeBytes === 'function' ? this.opts.freeBytes(dir) : freeBytesOf(dir); }

  /**
   * Why this training cannot start now — the same checks at EVERY departure (button, card, resume, automatic
   * resume). → null when it can, else {code, vars}. The Windows memory check, slower, is done by start() only.
   */
  blocker(item, { resume = false, from = 0 } = {}) {
    const d = item.doc;
    const cat = this.loadCatalog();
    if (item.importing) return { code: 'importBusy' };
    if (!d.name.trim()) return { code: 'noName' };
    if (d.dataset.count < cat.minImages) return { code: 'fewImages', vars: { n: cat.minImages } };
    if (!d.trigger.trim()) return { code: 'noTrigger' };
    if (d.dataset.captions < d.dataset.count) return { code: 'noCaption', vars: { n: d.dataset.count - d.dataset.captions } };
    const other = this.active();
    if (other && other !== item) return { code: 'otherActive' };
    // a departure already accepted, still awaiting the Windows memory check: it counts as active (two quick « Lancer »)
    if (this.starting && this.starting !== item) return { code: 'otherActive' };
    const base = this.base(d.base);
    if (!base) return { code: 'unknownBase', vars: { id: d.base } };
    const st = this.baseState(base);
    if (!st.ready) return { code: st.why.code, text: st.why };
    const need = this.diskNeed(item, resume ? from : 0);
    const free = this.freeBytes(item.dir);
    if (free != null && free < need) return { code: 'disk', vars: { a: fmtGB(need / GB, this.lang()), b: fmtGB(free / GB, this.lang()) } };
    const er = this.engineRoot();
    if (er && !this.isTest() && path.parse(path.resolve(er)).root.toLowerCase() !== path.parse(path.resolve(item.dir)).root.toLowerCase()) {
      const m = this.measuredOf(base);
      const one = (d.measured.checkpointMB || m.checkpointMB || 0) * 1048576;
      const efree = this.freeBytes(er);
      if (efree != null && efree < one) return { code: 'disk', vars: { a: fmtGB(one / GB, this.lang()), b: fmtGB(efree / GB, this.lang()) } };
    }
    return null;
  }

  blockerText(b) {
    if (!b) return null;
    if (b.text) return b.text[this.lang()];
    return this.tr(b.code, b.vars);
  }

  /** The whole state of one training (train:get, and the bridge's train_status). Paths are absolute here. */
  status(item) {
    const d = item.doc;
    const live = item.live;
    const abs = (f) => (f ? (path.isAbsolute(f) ? f : path.join(item.dir, f)) : null);
    const points = item.missing ? [] : this.curve(item);
    const mine = points.filter((m) => Number.isFinite(m.loss));
    const last = mine.length ? mine[mine.length - 1] : null;
    const tail = mine.slice(-100).map((m) => m.loss);
    const mean100 = tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : null;
    const prev = mine.slice(-200, -100).map((m) => m.loss);
    const prevMean = prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : null;
    const p = item.proto || {};
    const eta = this.eta(item);
    const every = Number(d.settings.sampleEvery) || 0;
    const nextSampleAt = every && d.step < d.steps ? Math.min(d.steps, (Math.floor(d.step / every) + 1) * every) : null;
    const lastAdded = [...d.checkpoints].reverse().find((c) => c.added);
    const blocker = d.state === 'pret' ? this.blocker(item) : null;
    const base = this.base(d.base);
    // the curve handed to the window: 2,000 points at most
    const stride = Math.max(1, Math.ceil(points.length / 2000));
    const curve = points.filter((_, i) => i % stride === 0 || i === points.length - 1).map((m) => ({ s: m.s, loss: m.loss, lr: m.lr, t: m.t }));
    return {
      ...this.summary(item),
      ok: true,
      trainingId: item.id,
      dir: item.dir,
      trigger: d.trigger,
      baseLabel: base ? base.label : null,
      media: base ? base.media : null,
      by: d.by,
      startedBy: d.startedBy || null,
      proposedBy: d.proposedBy || null,
      proposalEnd: d.proposalEnd || null,
      lastWatch: d.lastWatch,
      run: d.run,
      resumedFrom: d.resumedFrom || 0,
      settings: d.settings,
      dataset: d.dataset,
      measured: d.measured,
      ready: d.state === 'pret' ? !blocker : null,
      why: blocker ? this.blockerText(blocker) : null,
      whyCode: blocker ? blocker.code : null,
      phaseN: live && live.phaseN != null ? live.phaseN : null,
      phaseOf: live && live.phaseOf != null ? live.phaseOf : null,
      sampleStep: live && live.sampleStep ? live.sampleStep : null,
      loss: { last: last ? last.loss : null, mean100: round(mean100, 4), min: mine.length ? mine.reduce((a, m) => Math.min(a, m.loss), Infinity) : null, trend: mean100 != null && prevMean != null ? round(mean100 - prevMean, 4) : null },
      pace: { sPerStep: round(this.pace(item), 2) },
      eta,
      estimate: this.estimate(item),
      lastNewsS: live && live.newsAt ? Math.max(0, Math.round((this.now() - live.newsAt) / 1000)) : null,
      silentKillS: live && live.warn ? Math.round(this.silenceLimits(item).kill / 1000) : null,
      memory: { vramGB: null, peakVramGB: d.measured.peakVramGB != null ? d.measured.peakVramGB : null, ramFreeGB: round(os.freemem() / GB, 1), ramTotalGB: round(os.totalmem() / GB, 0) },
      checkpoints: d.checkpoints.map((c) => ({ ...c, file: abs(c.file) })),
      samples: d.samples.map((s) => ({ ...s, file: abs(s.file), prompt: (d.settings.samplePrompts || [])[(s.i || 1) - 1] || '' })),
      nextSampleAt,
      waitingJobs: this.gateWaiting(),
      notes: d.notes,
      events: (p.events || []).slice(-500),
      curve,
      logTail: item.missing ? [] : tailLines(path.join(item.dir, 'log.txt'), 20),
      lora: lastAdded ? { file: lastAdded.added.file, comfyName: lastAdded.added.comfyName, trigger: d.trigger, step: lastAdded.step } : null
    };
  }

  /** Before the start: steps × pace + samples × sample + load + encode. seconds is null when nothing was ever measured. */
  estimate(item) {
    const d = item.doc;
    const base = this.base(d.base);
    if (!base) return { seconds: null, endAt: null, diskGB: null, vramGB: null, measured: false };
    const m = this.measuredOf(base);
    const diskGB = round(this.diskNeed(item) / GB, 1);
    if (!m.sPerStep) return { seconds: null, endAt: null, diskGB, vramGB: m.peakVramGB || null, measured: false };
    const seconds = Math.round(d.steps * m.sPerStep + this.samplesLeft(item, 0) * (m.sampleSec || 0) + (m.loadSec || 0) + (m.encodeSecPerImage || 0) * d.dataset.count);
    return { seconds, endAt: this.now() + seconds * 1000, diskGB, vramGB: m.peakVramGB || null, measured: true };
  }

  // ------------------------------------------------------------ channels: reading
  options() {
    const cat = this.loadCatalog();
    const act = this.active();
    const root = this.trainRoot();
    const free = this.freeBytes(root);
    const toolsDir = this.toolsDir();
    const tools = {};
    for (const [id, t] of Object.entries(TOOLS)) {
      if (id === 'fake' && !t.enabled()) continue;
      const b = this.loadCatalog().bases.find((x) => x.tool === id && x.enabled) || (id === 'fake' ? t.BASE : null);
      const d = t.gpu && !toolsDir ? { ok: false, version: null, why: { code: 'tool', path: '' } }
        : t.detect({ toolsDir, root: this.miaRoot(), toolVersion: b ? b.toolVersion : null });
      tools[id] = { label: t.label, ok: d.ok, version: d.version, why: d.why };
    }
    return {
      ok: true,
      minImages: cat.minImages,
      adviseImages: cat.adviseImages,
      samplePrompts: cat.samplePrompts,
      bases: this.bases().map((b) => {
        const st = this.baseState(b);
        const m = this.measuredOf(b);
        return {
          id: b.id, label: b.label, media: b.media, tool: b.tool, minSide: b.minSide,
          family: b.family || null,            // the model family of a generation block (« Essayer sur une planche »)
          loadGB: ((b.weights || []).find((w) => w.role === 'model') || {}).sizeGB || null,   // « CHARGEMENT DU MODÈLE · 39 GO »
          ready: st.ready, why: st.why, missing: st.missing,
          defaults: b.defaults, lengths: b.lengths,
          estimate: { sPerStep: m.sPerStep || null, sampleSec: m.sampleSec || null, vramGB: m.peakVramGB || null, measured: !!m.sPerStep }
        };
      }),
      disk: { root, freeGB: free == null ? null : round(free / GB, 1) },
      toolsDir,
      tools,
      // Réglages → Entraînement : the folders in use, what '' (the default place) would give, the former trainings
      // folders still listed, and whether this is a test instance (its trainings stay in its own data folder)
      folders: {
        root,
        roots: this.roots(),
        defaultRoot: places.trainingRoot({ ...this.prefs, trainRoot: '' }, this.userData()),
        tools: toolsDir,
        defaultTools: places.trainingTools({ ...this.prefs, trainTools: '' }),
        test: this.isTest()
      },
      lorasDir: this.lorasDir(),
      active: act ? { trainingId: act.id, name: act.doc.name, state: act.doc.state, step: act.doc.step, steps: act.doc.steps } : null
    };
  }

  async list() {
    this.scan();
    const t = Date.now();
    await Promise.all([...this.items.values()].map(async (it) => {
      // measured again after 30 s, or as soon as what fills the folder changed (images, samples, checkpoints, the end)
      const d = it.doc || {};
      const key = [d.state, (d.dataset || {}).count, (d.samples || []).length, (d.checkpoints || []).length, it.importing ? 1 : 0].join('|');
      if (it.missing || (it.sizeAt && t - it.sizeAt < 30000 && it.sizeKey === key)) return;
      it.sizeMB = Math.round(((await dirBytes(it.dir)) / 1048576) * 1000) / 1000;      // a small draft weighs less than 1 MB
      it.sizeAt = Date.now();
      it.sizeKey = key;
    }));
    return [...this.items.values()].map((it) => this.summary(it)).sort((a, b) => (b.at || 0) - (a.at || 0));
  }

  get(id, o = {}) {
    const item = id ? this.item(id) : (this.active() || this.latest());
    if (!item) return this.fail('unknown');
    if (o && o.watch) { item.doc.lastWatch = { by: String(o.watch).slice(0, 40), at: this.now() }; this.save(item); this.push(item); }
    const out = this.status(item);
    if (o && o.dataset && !item.missing) out.images = this.loadDataset(item).map((e) => this.imageView(item, e));
    // « Journal de l’outil » : the last lines of log.txt, 200 at most (the plain state carries 20)
    if (o && o.log) out.log = item.missing ? [] : tailLines(path.join(item.dir, 'log.txt'), Math.max(1, Math.min(200, Math.round(+o.log) || 200)));
    return out;
  }

  latest() {
    let best = null;
    for (const it of this.items.values()) if (!best || ((it.doc.by && it.doc.by.at) || 0) > ((best.doc.by && best.doc.by.at) || 0)) best = it;
    return best;
  }

  imageView(item, e) {
    const base = this.base(item.doc.base);
    const min = base ? base.minSide : 0;
    return {
      n: e.n,
      original: e.original,
      file: path.join(item.dir, 'dataset', e.file),
      w: e.w,
      h: e.h,
      small: Math.min(e.w, e.h) < min,
      caption: e.captionBy ? readCaption(path.join(item.dir, 'dataset', e.file.replace(/\.[^.]+$/, '.txt'))) : '',
      captionBy: e.captionBy || null
    };
  }

  // ------------------------------------------------------------ draft
  /** Settings a fresh draft gets from its base. */
  defaultsOf(base, kind, trigger) {
    const cat = this.loadCatalog();
    const d = base.defaults || {};
    const tpl = cat.samplePrompts[kind] || '{trigger}';
    return {
      rank: d.rank, lr: d.lr, batch: d.batch, optimizer: d.optimizer, resolutions: d.resolutions,
      saveEvery: d.saveEvery, sampleEvery: d.sampleEvery,
      samplePrompts: [fill(tpl, { trigger: trigger || '' }).replace(/^[,\s]+|[,\s]+$/g, '')],
      promptAuto: true,
      triggerOnly: false
    };
  }

  create(o = {}) {
    // {from: id} — « Dupliquer en brouillon » : the same settings and the same set, nothing of what was computed
    const src = o.from ? this.item(o.from) : null;
    if (o.from && (!src || src.missing)) return this.fail('unknown');
    if (src && src.importing) return this.fail('importBusy');
    const base = this.base(src ? src.doc.base : o.base) || this.bases().find((b) => this.baseState(b).ready) || this.bases()[0];
    if (!base) return this.fail('unknownBase', { id: o.base || '?' });
    const name = String(o.name || (src ? src.doc.name : '') || '').trim().slice(0, 80);
    const kind = KINDS.includes(o.kind) ? o.kind : (src ? src.doc.kind : 'character');
    const trigger = String(o.trigger || (src ? src.doc.trigger : '') || '').trim().slice(0, 80);
    const root = this.trainRoot();
    const at = this.now();
    const d = new Date(at);
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
    const stem = `t_${stamp}_${cleanStem(name).toLowerCase().slice(0, 40)}`;
    let id = stem;
    for (let k = 2; this.items.has(id) || fs.existsSync(path.join(root, id)); k++) id = `${stem}-${k}`;
    const dir = path.join(root, id);
    try {
      fs.mkdirSync(path.join(dir, 'dataset'), { recursive: true });
    } catch (e) {
      // a removable disk unplugged since the setting, a file where the folder should be, no right to write…
      this.log(`create: ${dir} (${(e && e.code) || (e && e.message)})`);
      return { ...this.fail('rootUnreachable', { dir: root }), message: both('rootUnreachable', { dir: root }) };
    }
    const who = String(o.by || 'user').slice(0, 40);
    const doc = this.normalize({
      v: 1, id, name, slug: cleanStem(name), base: base.id, tool: base.tool, kind, trigger,
      by: { who, at }, startedBy: null, proposal: null, lastWatch: null, seen: true,
      owner: { miaPid: process.pid, userData: this.userData() }, proc: null, run: 0,
      state: 'pret', phase: null, pause: null, step: 0, steps: base.lengths.normal, resumedFrom: 0, startedAt: null, endedAt: null,
      settings: this.defaultsOf(base, kind, trigger),
      dataset: { count: 0, captions: 0, source: '', small: 0, skipped: [] },
      measured: {}, checkpoints: [], samples: [], notes: [], error: null
    });
    if (base.id === 'fake' && o.fake && typeof o.fake === 'object') doc.settings.fake = o.fake;
    const item = { id, dir, doc, missing: false, dataset: [] };
    if (src) {
      // the same model: its settings too; a model no longer offered here: the set and its captions all the same,
      // with the settings of the model chosen instead (never the whole set dropped in silence)
      if (src.doc.base === base.id) {
        doc.steps = src.doc.steps;
        doc.settings = JSON.parse(JSON.stringify(src.doc.settings));
      } else this.log(`duplicate of ${src.id}: model ${src.doc.base} not offered here, ${base.id} instead`);
      doc.dataset.source = src.doc.dataset.source || '';
      // the set: images linked (else copied), captions always copied — the original training keeps its own files
      for (const e of this.loadDataset(src)) {
        const cap = e.file.replace(/\.[^.]+$/, '.txt');
        const from = path.join(src.dir, 'dataset');
        try {
          try { fs.linkSync(path.join(from, e.file), path.join(dir, 'dataset', e.file)); } catch { fs.copyFileSync(path.join(from, e.file), path.join(dir, 'dataset', e.file)); }
          if (e.captionBy && fs.existsSync(path.join(from, cap))) fs.copyFileSync(path.join(from, cap), path.join(dir, 'dataset', cap));
          item.dataset.push({ ...e });
        } catch (err) {
          this.log(`duplicate of ${src.id}: ${e.file} not copied (${err.code || err.message})`);
        }
      }
      this.saveDataset(item);
    }
    this.items.set(id, item);
    this.save(item);
    this.writeIndex();
    this.push(null);
    return { ok: true, id, trainingId: id, dir, state: 'pret' };
  }

  /** Any change to a draft cancels a pending suggestion: what would start is no longer what was suggested. */
  touched(item) {
    const d = item.doc;
    d.edited = true;                          // no longer the empty draft « Nouveau LoRA » left as it was made
    if (d.proposal) { d.proposal = null; d.proposalEnd = { state: 'changed', at: this.now() }; }
    this.save(item);
    this.push(item, true);
  }

  update(id, patch = {}) {
    const item = this.item(id);
    if (!item || item.missing) return this.fail('unknown');
    const d = item.doc;
    // answering a suggestion is allowed in any state: « Refuser » ends it, « Plus tard » keeps it
    if (patch && patch.proposal === null) {
      if (d.proposal) { d.proposal = null; d.proposalEnd = { state: 'declined', at: this.now() }; this.save(item); this.push(item, true); }
      return { ok: true, proposal: null };
    }
    if (d.state !== 'pret') return this.fail('notDraft');
    let changed = false;
    const set = (k, v) => { if (JSON.stringify(d[k]) !== JSON.stringify(v)) { d[k] = v; changed = true; } };
    const setS = (k, v) => { if (JSON.stringify(d.settings[k]) !== JSON.stringify(v)) { d.settings[k] = v; changed = true; } };
    if (typeof patch.base === 'string' && patch.base !== d.base) {
      const base = this.base(patch.base);
      if (!base) return this.fail('unknownBase', { id: patch.base });
      const keepPrompts = d.settings.promptAuto ? null : d.settings.samplePrompts;
      d.base = base.id;
      d.tool = base.tool;
      d.steps = base.lengths.normal;
      d.settings = { ...this.defaultsOf(base, d.kind, d.trigger), ...(keepPrompts ? { samplePrompts: keepPrompts, promptAuto: false } : {}), triggerOnly: !!d.settings.triggerOnly };
      this.saveDataset(item);                 // « too small » depends on the model: counted again
      changed = true;
    }
    const base = this.base(d.base);
    if (typeof patch.name === 'string') { set('name', patch.name.trim().slice(0, 80)); d.slug = cleanStem(d.name); }
    if (KINDS.includes(patch.kind)) set('kind', patch.kind);
    if (typeof patch.trigger === 'string') set('trigger', patch.trigger.trim().slice(0, 80));
    if (typeof patch.length === 'string' && base && base.lengths[patch.length]) set('steps', base.lengths[patch.length]);
    if (patch.steps != null && Number.isFinite(+patch.steps)) set('steps', Math.max(1, Math.min(100000, Math.round(+patch.steps))));
    const s = patch.settings && typeof patch.settings === 'object' ? patch.settings : {};
    if (s.rank != null && Number.isFinite(+s.rank)) setS('rank', Math.max(1, Math.min(256, Math.round(+s.rank))));
    if (s.lr != null && Number.isFinite(+s.lr)) setS('lr', Math.max(1e-6, Math.min(1e-2, +s.lr)));
    if (s.saveEvery != null && Number.isFinite(+s.saveEvery)) setS('saveEvery', Math.max(1, Math.round(+s.saveEvery)));
    if (s.sampleEvery != null && Number.isFinite(+s.sampleEvery)) setS('sampleEvery', Math.max(0, Math.round(+s.sampleEvery)));
    if (Array.isArray(s.resolutions) && s.resolutions.length) setS('resolutions', s.resolutions);
    if (Array.isArray(s.samplePrompts)) {
      setS('samplePrompts', s.samplePrompts.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 1000)).slice(0, 4));
      d.settings.promptAuto = false;
    }
    if (d.base === 'fake' && s.fake && typeof s.fake === 'object') setS('fake', s.fake);
    if (d.settings.promptAuto && base) {
      const tpl = this.loadCatalog().samplePrompts[d.kind] || '{trigger}';
      setS('samplePrompts', [fill(tpl, { trigger: d.trigger }).replace(/^[,\s]+|[,\s]+$/g, '')]);
    }
    // « Mot déclencheur seul » : the images without a caption get the trigger word as their caption (in the copy,
    // never beside the original); these captions follow the trigger word when it changes
    if (patch.triggerOnly === true || patch.triggerOnly === false) setS('triggerOnly', patch.triggerOnly);
    if (this.syncTriggerCaptions(item)) changed = true;
    if (changed) this.touched(item);
    this.writeIndex();
    return { ok: true, ...this.status(item) };
  }

  // ------------------------------------------------------------ the image set
  loadDataset(item) {
    if (item.dataset) return item.dataset;
    const j = readJSON(path.join(item.dir, 'dataset', 'dataset.json'));
    item.dataset = Array.isArray(j) ? j : (j && Array.isArray(j.images) ? j.images : []);
    return item.dataset;
  }

  saveDataset(item) {
    const list = this.loadDataset(item);
    const d = item.doc;
    const base = this.base(d.base);
    const min = base ? base.minSide : 0;
    fs.mkdirSync(path.join(item.dir, 'dataset'), { recursive: true });
    writeAtomic(path.join(item.dir, 'dataset', 'dataset.json'), JSON.stringify(list, null, 1));
    d.dataset.count = list.length;
    d.dataset.captions = list.filter((e) => e.captionBy).length;
    d.dataset.small = list.filter((e) => Math.min(e.w, e.h) < min).length;
  }

  /** Write (or remove, when empty) the caption of one image — always in the training's own copy. */
  writeCaption(item, e, text, by) {
    const file = path.join(item.dir, 'dataset', e.file.replace(/\.[^.]+$/, '.txt'));
    const clean = String(text || '').replace(/\r\n?/g, '\n').trim();
    if (!clean) {
      try { fs.rmSync(file, { force: true }); } catch { /* absent */ }
      e.captionBy = null;
      e.capSha = null;
      return;
    }
    writeAtomic(file, clean);                 // .tmp then rename: never writes through a link
    e.captionBy = by;
    e.capSha = sha1(clean);
  }

  /** Captions that are « the trigger word alone » : created, refreshed or removed. → true when something changed. */
  syncTriggerCaptions(item) {
    const d = item.doc;
    const list = this.loadDataset(item);
    const want = !!d.settings.triggerOnly && !!d.trigger.trim();
    let changed = false;
    for (const e of list) {
      if (e.captionBy === 'trigger' && (!want || e.capSha !== sha1(d.trigger.trim()))) {
        this.writeCaption(item, e, want ? d.trigger : '', 'trigger');
        changed = true;
      } else if (!e.captionBy && want) {
        this.writeCaption(item, e, d.trigger, 'trigger');
        changed = true;
      }
    }
    if (changed) this.saveDataset(item);
    return changed;
  }

  /**
   * Add images (files or folders) to a draft. Returns at once; the import goes on in the main process and
   * publishes « IMPORT n / total ». Images are hard-linked (else copied); captions (.txt of the same name) are
   * always copied, so nothing Mia writes ever reaches the originals.
   */
  addImages(id, paths) {
    const item = this.item(id);
    if (!item || item.missing) return this.fail('unknown');
    if (item.doc.state !== 'pret') return this.fail('notDraft');
    const files = [];
    const other = [];
    let source = '';
    for (const p of (Array.isArray(paths) ? paths : [paths])) {
      if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
      let st = null;
      // gone (a folder moved, a disk unplugged): said by its path, apart from the files that could not be read
      try { st = fs.statSync(p); } catch { other.push({ original: path.basename(p) || p, why: 'missing', path: p }); continue; }
      let list = [p];
      if (st.isDirectory()) {                              // a folder: its own files, not its subfolders
        try { list = fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(p, e.name)).sort(); } catch { list = []; }
      }
      if (!source) source = st.isDirectory() ? p : path.dirname(p);
      for (const f of list) {
        const ext = path.extname(f).toLowerCase();
        if (IMAGE_EXT.has(ext)) files.push(f);
        else if (ext !== '.txt' && path.basename(f).toLowerCase() !== 'dataset.json') other.push({ original: path.basename(f), why: 'format' });
      }
    }
    const total = files.length;
    item.importing = { n: (item.importing && item.importing.n) || 0, total: ((item.importing && item.importing.total) || 0) + total };
    item.importJobs = (item.importJobs || 0) + 1;
    item.queue = (item.queue || Promise.resolve()).then(() => this.importFiles(item, files, other, source))
      .catch((e) => this.log(`import into ${item.id} failed:`, e.message))
      .then(() => {
        item.importJobs--;
        if (item.importJobs <= 0) item.importing = null;
        this.touched(item);
      });
    this.push(item, true);
    return { ok: true, importing: true, total, trainingId: item.id };
  }

  /** Resolves when no import is running for this training (the bridge waits on it, and the benches). */
  async importIdle(id) {
    const item = this.item(id);
    if (item && item.queue) await item.queue;
    return item ? { ok: true, dataset: item.doc.dataset } : this.fail('unknown');
  }

  async importFiles(item, files, other, source) {
    const d = item.doc;
    const list = this.loadDataset(item);
    const base = this.base(d.base);
    const min = base ? base.minSide : 0;
    const dsDir = path.join(item.dir, 'dataset');
    fs.mkdirSync(dsDir, { recursive: true });
    const skipped = [...other];
    const names = new Set(list.map((e) => e.original.toLowerCase()));
    let next = list.reduce((m, e) => Math.max(m, e.n), 0) + 1;
    let k = 0;
    for (const src of files) {
      k++;
      if (item.importing) item.importing.n++;
      if (k % 8 === 0) { this.push(item); await new Promise((r) => setImmediate(r)); }
      const original = path.basename(src);
      if (names.has(original.toLowerCase())) { skipped.push({ original, why: 'duplicate' }); continue; }
      const dim = readImageSize(src);
      if (!dim) { skipped.push({ original, why: 'unreadable' }); continue; }
      if (Math.min(dim.w, dim.h) < min / 2) { skipped.push({ original, why: 'tiny' }); continue; }
      const ext = path.extname(src).toLowerCase();
      const file = `${String(next).padStart(4, '0')}${ext}`;
      const dst = path.join(dsDir, file);
      let linked = true;
      try {
        fs.rmSync(dst, { force: true });
        fs.linkSync(src, dst);
      } catch {
        linked = false;
        try {
          fs.copyFileSync(src, `${dst}.tmp`);
          fs.renameSync(`${dst}.tmp`, dst);
        } catch (e) {
          skipped.push({ original, why: 'unreadable' });
          this.log(`import: ${original} not copied (${e.code || e.message})`);
          continue;
        }
      }
      const e = { n: next, file, original, src, w: dim.w, h: dim.h, bytes: dim.bytes, linked, captionBy: null, capSha: null };
      const cap = readCaption(src.replace(/\.[^.\\/]+$/, '.txt'));
      if (cap) this.writeCaption(item, e, cap, 'file');
      list.push(e);
      names.add(original.toLowerCase());
      next++;
    }
    if (!d.dataset.source && source) d.dataset.source = source;
    d.dataset.skipped = [...d.dataset.skipped, ...skipped].slice(-300);
    this.syncTriggerCaptions(item);
    this.saveDataset(item);
  }

  findImage(item, name) {
    const key = String(name || '').toLowerCase();
    return this.loadDataset(item).find((e) => e.original.toLowerCase() === key || e.file.toLowerCase() === key) || null;
  }

  removeImage(id, name) {
    const item = this.item(id);
    if (!item || item.missing) return this.fail('unknown');
    if (item.doc.state !== 'pret') return this.fail('notDraft');
    if (item.importing) return this.fail('importBusy');
    const names = Array.isArray(name) ? name : [name];
    const list = this.loadDataset(item);
    let removed = 0;
    for (const nm of names) {
      const e = this.findImage(item, nm);
      if (!e) continue;
      // removing a hard link never touches the original file
      for (const f of [e.file, e.file.replace(/\.[^.]+$/, '.txt')]) { try { fs.rmSync(path.join(item.dir, 'dataset', f), { force: true }); } catch { /* absent */ } }
      list.splice(list.indexOf(e), 1);
      removed++;
    }
    if (!removed) return this.fail('noImage', { name: names[0] });
    this.saveDataset(item);
    this.touched(item);
    return { ok: true, removed, dataset: item.doc.dataset };
  }

  setCaption(id, name, text, by = 'user') {
    const item = this.item(id);
    if (!item || item.missing) return this.fail('unknown');
    if (item.doc.state !== 'pret') return this.fail('notDraft');
    if (item.importing) return this.fail('importBusy');
    const e = this.findImage(item, name);
    if (!e) return this.fail('noImage', { name });
    this.writeCaption(item, e, text, String(by || 'user').slice(0, 40));
    this.syncTriggerCaptions(item);
    this.saveDataset(item);
    this.touched(item);
    return { ok: true, captionBy: e.captionBy, dataset: item.doc.dataset };
  }

  // ------------------------------------------------------------ suggestion of an assistant
  /** What a suggestion is about: the settings and the set. A different digest at the click = the draft changed. */
  digest(item) {
    const d = item.doc;
    return sha1(JSON.stringify([d.name, d.base, d.kind, d.trigger, d.steps, d.settings, d.step,
      this.loadDataset(item).map((e) => [e.original, e.bytes, e.capSha])]));
  }

  /** An assistant suggests starting (or resuming): nothing starts, train.json.proposal carries the card. */
  propose(id, o = {}) {
    const item = this.item(id);
    if (!item || item.missing) return this.fail('unknown');
    const resume = !!o.resume;
    const d = item.doc;
    if (!resume && d.state !== 'pret') return this.fail('notDraft');
    if (resume && !RESUMABLE.has(d.state)) return this.fail('notResumable');
    d.proposal = { by: String(o.by || 'assistant').slice(0, 40), at: this.now(), resume, digest: this.digest(item) };
    d.proposalEnd = null;
    this.save(item);
    this.push(item, true);
    return { ok: true, awaitingUser: true, trainingId: item.id };
  }

  // ------------------------------------------------------------ the GPU door
  /**
   * {hold({label, minutes(), signal, onWait(who, since)}) → Promise<{release()}|null>, adopt({label, minutes()}) → {release()}|null}
   * The engine's door when it has one (Engine.holdGpu, and Engine.adoptGpu for a tool taken back in hand at startup);
   * else — and for adopt when the engine has no adoptGpu — the lock file taken directly.
   */
  gate() {
    if (this.opts.gate) return this.opts.gate;
    if (!this.lockGate) {
      this.lockGate = createLockGate({ cfg: this.cfg, log: this.log, lockFile: () => this.lockFile() });
    }
    const engine = this.ctx.engine;
    if (engine && typeof engine.holdGpu === 'function') {
      // lockFile: the lock to take — null for a tool without GPU (the fake one): only Mia's own queue is held then
      return {
        hold: (o) => engine.holdGpu({ ...o, lockFile: this.lockFile() }),
        adopt: (o) => (typeof engine.adoptGpu === 'function' ? engine.adoptGpu({ ...o, lockFile: this.lockFile() }) : this.lockGate.adopt(o))
      };
    }
    return this.lockGate;
  }

  /** The lock file of the training that is starting: none for the fake tool (unless a bench gives one), none without an engine. */
  lockFile() {
    const lp = this.opts.lockPath;
    if (lp) return typeof lp === 'function' ? lp() : lp;
    const it = this.holder;
    const tool = it ? TOOLS[it.doc.tool] : null;
    const er = this.engineRoot();
    return tool && tool.gpu && er ? path.join(er, 'runtime', 'gpu.lock') : null;
  }

  /** Is Mia's own queue of local jobs empty? (« Laisser passer » resumes when it is.) */
  queueIdle() {
    if (typeof this.opts.queueIdle === 'function') return !!this.opts.queueIdle();
    const engine = this.ctx.engine;
    if (engine && typeof engine.localIdle === 'function') return !!engine.localIdle();
    return !(engine && engine.jobs instanceof Map && engine.jobs.size > 0);
  }

  gateWaiting() {
    if (typeof this.opts.waitingJobs === 'function') return this.opts.waitingJobs();
    const engine = this.ctx.engine;
    if (engine && typeof engine.waitingForGpu === 'function') return engine.waitingForGpu();
    return 0;
  }

  lockLabel(item) {
    const base = this.base(item.doc.base);
    return `Mia : Entraînement LoRA ${item.doc.name} (${base ? base.label.fr : item.doc.base})`;
  }

  /** Minutes written in the lock: min(time left, 30) — the real end is in the status, not in the lock. */
  lockMinutes(item) {
    const s = this.eta(item).seconds;
    const max = this.cfg.lockMaxMin;
    return s == null ? max : Math.max(1, Math.min(max, Math.ceil(s / 60)));
  }

  // ------------------------------------------------------------ start, resume
  /**
   * Start a draft, or resume ({resume:true}) from the last verified checkpoint. {proposal:true}: the click on an
   * assistant's card — refused when the draft changed since. Always a gesture of the user in the window.
   */
  async start(id, o = {}) {
    const item = this.item(id);
    if (!item || item.missing) return this.fail('unknown');
    const d = item.doc;
    let resume = !!o.resume;
    if (o.proposal) {
      if (!d.proposal) return this.fail('noProposal');
      if (d.proposal.digest !== this.digest(item)) { this.touched(item); return this.fail('proposalChanged'); }
      resume = !!d.proposal.resume;
    }
    if (!resume && d.state !== 'pret') return this.fail('notDraft');
    if (resume && !RESUMABLE.has(d.state)) return this.fail('notResumable');
    if (item.starting) return { ok: true, state: d.state };
    item.starting = true;
    try {
      const from = resume ? this.pickCheckpoint(item, { dryRun: true }) : 0;
      const b = this.blocker(item, { resume, from });
      if (b) return { ok: false, code: b.code, error: this.blockerText(b) };
      this.starting = item;                    // reserved before any await: a second start() is refused (otherActive)
      const base = this.base(d.base);
      if (base.needCommitGB > 0) {
        let avail = await this.commitGB();
        // the ComfyUI this Mia launched may be what holds the memory: stopped (when it computes nothing), measured again
        if (avail != null && avail < base.needCommitGB && (await this.freeComfyMemory())) avail = await this.commitAfterFree(base.needCommitGB);
        if (avail != null && avail < base.needCommitGB) return this.fail('memory', { a: fmtGB(avail, this.lang()), n: base.needCommitGB });
      }
      const resumeFrom = resume ? this.pickCheckpoint(item) : 0;
      const by = String(o.by || 'user').slice(0, 40);
      if (d.proposal) { d.proposedBy = d.proposal.by; d.proposal = null; d.proposalEnd = { state: 'started', at: this.now() }; }
      d.startedBy = by;
      d.owner = { miaPid: process.pid, userData: this.userData() };
      if (!resume || !d.startedAt) d.startedAt = this.now();
      item.prev = { state: d.state, pause: d.pause, error: d.error, step: d.step, endedAt: d.endedAt };
      d.state = 'attente';
      d.phase = null;
      d.pause = null;
      d.error = null;
      d.endedAt = null;
      d.seen = true;
      d.resumedFrom = resumeFrom;
      if (resume) d.step = resumeFrom;
      this.act(item, resume ? 'resume' : 'start', by);
      item.live = this.newLive(item);
      this.save(item);
      this.writeIndex();
      this.push(item, true);
      this.ensureTimer();
      this.acquire(item, resumeFrom);
      return { ok: true, started: true, state: 'attente', resumeFrom, trainingId: item.id };
    } finally {
      item.starting = false;
      if (this.starting === item) this.starting = null;
    }
  }

  /** Windows' commit memory available now, in GB (null when unknown). */
  commitGB() {
    return typeof this.opts.commitGB === 'function' ? this.opts.commitGB() : commitAvailableGB();
  }

  /** Ask the engine to stop the ComfyUI Mia launched (§4.4). → true when it did. */
  async freeComfyMemory() {
    const engine = this.ctx.engine;
    if (!engine || typeof engine.freeMemoryForTraining !== 'function') return false;
    try { const r = await engine.freeMemoryForTraining(); return !!(r && r.stopped); } catch (e) { this.log('freeMemoryForTraining:', e && e.message); return false; }
  }

  /** After ComfyUI was stopped Windows gives its memory back within seconds: measured again until it is enough, 10 s at most. */
  async commitAfterFree(need) {
    const until = Date.now() + (this.cfg.memWaitMs != null ? this.cfg.memWaitMs : 10000);
    let avail = await this.commitGB();
    while (avail != null && avail < need && Date.now() < until) {
      await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(20, this.cfg.memPollMs || 1000))));
      avail = await this.commitGB();
    }
    return avail;
  }

  newLive(item) {
    return {
      child: null, pid: null, token: null, hold: null, abort: new AbortController(), wait: null,
      exited: null, done: null, stopped: null, toolError: null, killedFor: null,
      want: null, pauseReason: null, deadline: 0,
      phaseN: null, phaseOf: null, sampleStep: null, sampleAt: 0, loadAt: 0,
      newsAt: this.now(), phaseAt: this.now(), lastTickAt: this.now(), aliveAt: 0, warn: false, ramLowGB: null,
      id: item.id
    };
  }

  /** A line of ÉVÈNEMENTS made by Mia or by someone's gesture (the adapter's own events are in events.jsonl). */
  act(item, act, by, text = '') {
    const d = item.doc;
    d.notes.push({ by: by || 'user', step: d.step, text, at: this.now(), act });
    if (d.notes.length > 400) d.notes.splice(0, d.notes.length - 400);
  }

  /**
   * The engine started a local job beside the active training (« Générer pendant un entraînement », SPEC §8.7): one
   * line in ÉVÈNEMENTS, « Calcul à côté : Portrait » / “Job alongside: Portrait”. → true when written.
   */
  noteBeside(label) {
    const item = this.active();
    if (!item || item.missing || !item.live) return false;
    this.act(item, 'beside', 'Mia', String(label || '').trim().slice(0, 80));
    this.save(item);
    this.push(item, true);
    return true;
  }

  async acquire(item, resumeFrom) {
    const live = item.live;
    if (!this.holder || this.holder === item || !this.holder.live) this.holder = item;
    let hold = null;
    const base = this.base(item.doc.base);
    try {
      hold = await this.gate().hold({
        label: this.lockLabel(item),
        minutes: () => this.lockMinutes(item),
        signal: live.abort.signal,
        onWait: (who, since) => { live.wait = { who, since }; this.push(item, true); },
        // lock in hand, the engine stops its own ComfyUI if the model still lacks commit memory (§4.4)
        needCommitGB: base && base.needCommitGB > 0 ? base.needCommitGB : 0,
        commitGB: () => this.commitGB()
      });
    } catch (e) {
      this.log(`GPU lock for ${item.id}:`, e.message);
      if (item.live !== live) return;
      if (e && e.code === 'holdBusy') {
        // another training of this Mia already holds the GPU: a refusal (back to where it was), not a tool error
        live.abort.abort();
        item.live = null;
        if (this.holder === item) this.holder = null;
        Object.assign(item.doc, item.prev || { state: 'pret' });
        this.save(item);
        this.writeIndex();
        this.push(item, true);
        return;
      }
      this.endInError(item, 'tool', { key: 'e_spawn', vars: { line: e.message } });
      return;
    }
    if (item.live !== live || live.abort.signal.aborted || !hold) {       // stopped while waiting
      if (hold) hold.release();
      return;
    }
    live.hold = hold;
    live.wait = null;
    try {
      this.launch(item, resumeFrom);
    } catch (e) {
      this.log(`launch of ${item.id} failed:`, e.message);
      this.endInError(item, 'tool', { key: 'e_spawn', vars: { line: e.message } });
    }
  }

  /**
   * Start the adapter: its output goes to log.txt through a file handle — no pipe ties the tool to Mia. `detached`:
   * outside libuv's kill-on-close job, so a crash of Mia does not kill the tool on the spot — its own watch of
   * control\alive pauses it with a checkpoint, and a Mia started again takes it back in hand (§4.5-8b). Stopping
   * still works: killTree and taskkill /T follow the process tree, not the job. Not unref'd: while Mia lives, the
   * service sees the tool end. Every sub-process of the adapters is started with CREATE_NO_WINDOW (no console).
   */
  launch(item, resumeFrom) {
    const d = item.doc;
    const live = item.live;
    const tool = TOOLS[d.tool];
    const control = path.join(item.dir, 'control');
    fs.mkdirSync(control, { recursive: true });
    fs.mkdirSync(path.join(item.dir, 'out'), { recursive: true });
    for (const f of ['pause', 'stop', 'adapter.json']) fs.rmSync(path.join(control, f), { force: true });
    this.writeAlive(item);
    d.run += 1;
    const token = crypto.randomBytes(8).toString('hex');
    const cmd = tool.command({ dir: item.dir, run: d.run, token, resumeFrom, toolsDir: this.toolsDir(), root: this.miaRoot(), engineRoot: this.engineRoot() });
    const fd = fs.openSync(path.join(item.dir, 'log.txt'), 'a');
    let child;
    try {
      fs.writeSync(fd, `\n---- Mia : lancement ${d.run}${resumeFrom ? `, reprise du pas ${resumeFrom}` : ''}, ${new Date().toISOString()} ----\n`);
      child = spawn(cmd.exe, cmd.args, { cwd: cmd.cwd, env: { ...process.env, ...cmd.env }, stdio: ['ignore', fd, fd], windowsHide: true, detached: true });
    } finally {
      fs.closeSync(fd);                       // the child has its own copy of the handle
    }
    live.child = child;
    live.pid = child.pid || null;
    live.token = token;
    child.on('error', (e) => { live.exited = live.exited || { code: null, spawnError: e.message }; });
    child.on('exit', (code) => { live.exited = live.exited || { code }; });
    d.proc = { pid: live.pid, startedAt: this.now(), token };
    d.state = 'preparation';
    d.phase = 'check';
    live.newsAt = live.phaseAt = this.now();
    this.save(item);
    this.push(item, true);
  }

  writeAlive(item) {
    try {
      fs.writeFileSync(path.join(item.dir, 'control', 'alive'), String(Date.now()), 'utf8');
      if (item.live) item.live.aliveAt = this.now();
    } catch { /* the next tick tries again */ }
  }

  // ------------------------------------------------------------ reading what the tool writes
  /** Read the lines added to events.jsonl and metrics.jsonl since last time. → true when something came. */
  readProtocol(item) {
    if (!item.proto) {
      item.proto = {
        ev: { pos: 0, rest: '', dec: new StringDecoder('utf8') }, mt: { pos: 0, rest: '', dec: new StringDecoder('utf8') },
        events: [], metrics: [], resumes: [], version: 0, curveAt: -1, curve: [],
        endOf: null           // {run, ev}: the `done` or `stopped` that ended a launch, kept even when no tool is in hand
      };
    }
    if (item.missing) return false;
    const p = item.proto;
    const read = (name, st) => {
      const file = path.join(item.dir, name);
      let fd = null;
      try {
        const size = fs.statSync(file).size;
        if (size < st.pos) { st.pos = 0; st.rest = ''; st.dec = new StringDecoder('utf8'); }
        if (size === st.pos) return [];
        const buf = Buffer.alloc(size - st.pos);
        fd = fs.openSync(file, 'r');
        const n = fs.readSync(fd, buf, 0, buf.length, st.pos);
        st.pos += n;
        const lines = (st.rest + st.dec.write(buf.subarray(0, n))).split('\n');
        st.rest = lines.pop();
        const out = [];
        for (const l of lines) {
          if (!l.trim()) continue;
          try { const j = JSON.parse(l); if (j && typeof j === 'object') out.push(j); } catch { /* a damaged line is skipped */ }
        }
        return out;
      } catch {
        return [];
      } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } }
      }
    };
    const events = read('events.jsonl', p.ev);
    const metrics = read('metrics.jsonl', p.mt);
    for (const ev of events) this.applyEvent(item, ev);
    for (const m of metrics) {
      if (!Number.isFinite(+m.s)) continue;
      const line = { run: Number.isInteger(m.run) ? m.run : 1, s: +m.s, loss: Number.isFinite(+m.loss) ? +m.loss : null, lr: Number.isFinite(+m.lr) ? +m.lr : null, dt: Number.isFinite(+m.dt) ? +m.dt : null, t: +m.t || 0 };
      p.metrics.push(line);
      if (item.live && line.run === item.doc.run && RUNNING.has(item.doc.state)) item.doc.step = line.s;
    }
    if (!events.length && !metrics.length) return false;
    p.version++;
    const live = item.live;
    if (live && live.pid) {                              // whoever read them (the tick, or the window asking for the state)
      live.newsAt = this.now();
      if (live.warn) { live.warn = false; item.moved = true; }
    }
    return true;
  }

  /** One line of events.jsonl. The record (checkpoints, samples) follows always; the state only while the tool is in hand. */
  applyEvent(item, ev) {
    const p = item.proto;
    const d = item.doc;
    if (ev.e === 'caps') {
      p.runSeen = Number.isInteger(ev.run) ? ev.run : (p.runSeen || 0) + 1;
      p.resumes.push({ run: p.runSeen, step: 0 });           // until `resumed` says otherwise, a launch restarts at 0
      p.endOf = null;
    }
    // how the last launch ended, whoever reads it: Mia's startup (reconcile) needs it for a tool that ended meanwhile
    if (ev.e === 'done' || ev.e === 'stopped') p.endOf = { run: p.runSeen || 0, ev };
    // the file holds every launch since the first one: only the lines of the launch in hand move the state
    const live = item.live && item.live.pid && p.runSeen === d.run ? item.live : null;
    if (ev.e !== 'sample_step') p.events.push(ev);
    if (p.events.length > 2000) p.events.splice(0, p.events.length - 2000);
    switch (ev.e) {
      case 'caps':
        if (live && ev.tool) d.toolName = String(ev.tool).slice(0, 80);
        break;
      case 'resumed':
        if (p.resumes.length) p.resumes[p.resumes.length - 1].step = +ev.step || 0;
        break;
      case 'phase':
        if (!live) break;
        if (ev.phase === 'train' && d.phase === 'load' && live.loadAt) d.measured.loadSec = round((this.now() - live.loadAt) / 1000, 1);
        if (ev.phase === 'load' && d.phase !== 'load') live.loadAt = this.now();
        if (ev.phase === 'sample' && d.phase !== 'sample') live.sampleAt = this.now();
        if (ev.phase !== d.phase) live.phaseAt = this.now();
        d.phase = ev.phase;
        live.phaseN = ev.n != null ? +ev.n : null;
        live.phaseOf = ev.of != null ? +ev.of : null;
        if (ev.phase !== 'sample') live.sampleStep = null;
        {
          const state = ev.phase === 'sample' ? 'essai' : (ev.phase === 'train' || ev.phase === 'save' ? 'entrainement' : 'preparation');
          if (state !== d.state) { d.state = state; item.moved = true; }
        }
        break;
      case 'sample_step':
        if (live) live.sampleStep = { i: +ev.i || 1, of: +ev.of || 1, n: +ev.n || 0, total: +ev.total || 0 };
        break;
      case 'sample': {
        const file = this.relFile(item, ev.file);
        if (!live && !fs.existsSync(path.join(item.dir, file))) break;      // replayed after a restart, and gone since
        const s = { step: +ev.step || 0, i: +ev.i || 1, file, kind: ev.kind === 'video' ? 'video' : 'image', sec: Number.isFinite(+ev.sec) ? +ev.sec : null, at: 0 };
        const k = d.samples.findIndex((x) => x.step === s.step && x.i === s.i);
        s.at = this.fileTime(item, file, ev, live, k >= 0 ? d.samples[k] : null);
        if (k >= 0) d.samples[k] = s; else d.samples.push(s);
        d.samples.sort((a, b) => a.step - b.step || a.i - b.i);
        if (s.sec) d.measured.sampleSec = s.sec;
        if (live) live.sampleStep = null;
        break;
      }
      case 'checkpoint': {
        const file = this.relFile(item, ev.file);
        if (!live && !fs.existsSync(path.join(item.dir, file))) break;      // replayed after a restart: put aside or replaced since
        const c = { step: +ev.step || 0, file, sizeMB: Number.isFinite(+ev.sizeMB) ? +ev.sizeMB : null, at: 0, added: null };
        const k = d.checkpoints.findIndex((x) => x.step === c.step);
        c.at = this.fileTime(item, file, ev, live, k >= 0 ? d.checkpoints[k] : null);
        if (k >= 0) d.checkpoints[k] = { ...c, added: d.checkpoints[k].added || null }; else d.checkpoints.push(c);
        d.checkpoints.sort((a, b) => a.step - b.step);
        if (c.sizeMB) d.measured.checkpointMB = c.sizeMB;
        if (live) this.diskGuard(item);
        break;
      }
      case 'stopped': if (live) live.stopped = ev; break;
      case 'done':
        if (live) live.done = ev;
        if (Number.isFinite(+ev.peakVramGB) && +ev.peakVramGB > 0) d.measured.peakVramGB = +ev.peakVramGB;
        break;
      case 'error': if (live) live.toolError = ev; break;
      default: break;
    }
    item.dirty = true;
  }

  relFile(item, f) {
    const s = String(f || '');
    return posix(path.isAbsolute(s) ? path.relative(item.dir, s) : s);
  }

  /** When a sample or a checkpoint was written: the tool's own time when the line has one, the reading's time while the
   *  tool is in hand (a file the tool copied keeps the date of its source), the time already on record for the same
   *  file when the lines are read again after a restart, the file's date last. */
  fileTime(item, relPath, ev = null, live = null, had = null) {
    if (ev && +ev.t > 0) return Math.round(+ev.t);
    if (live) return this.now();
    if (had && had.file === relPath && +had.at > 0) return +had.at;
    try { return Math.round(fs.statSync(path.join(item.dir, relPath)).mtimeMs); } catch { return this.now(); }
  }

  /** After each checkpoint: under twice a checkpoint's size left, pause BEFORE the next one (reason "disk"). */
  diskGuard(item) {
    const d = item.doc;
    const live = item.live;
    if (!live || live.want || !RUNNING.has(d.state)) return;
    const free = this.freeBytes(item.dir);
    const one = (d.measured.checkpointMB || 0) * 1048576;
    if (free == null || !one || free >= 2 * one) return;
    this.log(`${item.id}: disk almost full (${Math.round(free / 1048576)} MB left): pause`);
    this.askPause(item, 'disk');
    this.act(item, 'pause', 'Mia');
  }

  // ------------------------------------------------------------ the tick
  ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.cfg.tickMs);
  }

  tick() {
    let busy = false;
    for (const item of this.items.values()) {
      if (item.missing) continue;
      try {
        if (item.live) this.poll(item);
        else if (item.doc.state === 'pause' && item.doc.pause && item.doc.pause.reason === 'pass') this.passCheck(item);
      } catch (e) {
        this.log(`tick ${item.id}:`, e && e.stack ? e.stack : e);
      }
      if (item.dirty) this.save(item);
      if (item.pushLate) this.push(item);
      if (item.live || item.dirty || this.isActive(item)) busy = true;
    }
    if (!busy && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** How long the tool may stay silent now: {warn, kill} in ms (warn is null outside the training steps). */
  silenceLimits(item) {
    const d = item.doc;
    const c = this.cfg;
    if (d.state === 'essai') return { warn: null, kill: c.sampleKillMs };
    if (d.state === 'preparation') return { warn: null, kill: c.loadKillMs };
    const pace = (this.pace(item) || 0) * 1000;
    return { warn: Math.max(c.warnMinMs, c.warnPaces * pace), kill: Math.max(c.killMinMs, c.killPaces * pace) };
  }

  poll(item) {
    const d = item.doc;
    const live = item.live;
    const now = this.now();
    // the clock jumped (the PC slept): nobody was silent, nobody is late — every counter starts again
    const gap = now - live.lastTickAt;
    if (gap > this.cfg.jumpMs || gap < 0) {
      live.newsAt = live.phaseAt = now;
      live.warn = false;
      live.aliveAt = 0;
      if (live.deadline) live.deadline += gap > 0 ? gap : 0;
      this.log(`${item.id}: clock jump of ${Math.round(gap / 1000)} s, counters reset`);
    }
    live.lastTickAt = now;
    if (!live.pid && live.exited) { this.finalize(item); return; }    // the tool could not even be started
    if (!live.pid) return;                                            // still waiting for the GPU
    if (now - live.aliveAt >= this.cfg.aliveMs) this.writeAlive(item);
    this.readProtocol(item);
    if (item.moved) { item.moved = false; this.save(item); this.push(item, true); } else this.push(item);
    if (!live.child && !live.exited && !pidAlive(live.pid)) live.exited = { code: null };   // a tool taken back in hand
    if (live.exited) { this.readProtocol(item); this.finalize(item); return; }
    const ram = os.freemem() / GB;
    if (d.phase === 'load') live.ramLowGB = live.ramLowGB == null ? ram : Math.min(live.ramLowGB, ram);

    // a pause, a stop or a quit that the tool does not honour in time
    if (live.want && live.deadline && now > live.deadline && !live.killedFor) {
      this.log(`${item.id}: no answer to « ${live.want} » in time, the tool is stopped`);
      this.kill(item, live.want === 'quit' ? 'quit' : 'stop');
      return;
    }
    // a frozen tool
    const lim = this.silenceLimits(item);
    const quiet = now - Math.max(live.newsAt, d.state === 'entrainement' ? 0 : live.phaseAt);
    if (!live.killedFor && quiet > lim.kill) {
      live.hangMin = Math.max(1, Math.round(quiet / 60000));
      this.log(`${item.id}: silent for ${Math.round(quiet / 1000)} s, given up`);
      this.kill(item, 'hang');
      return;
    }
    if (lim.warn != null && quiet > lim.warn && !live.warn) { live.warn = true; this.push(item, true); }
  }

  kill(item, why) {
    const live = item.live;
    if (!live || live.killedFor) return;
    live.killedFor = why;
    if (live.pid) killTree(live.pid).then(() => { if (!live.child) live.exited = live.exited || { code: null }; });
    else live.exited = { code: null };
  }

  // ------------------------------------------------------------ the end of a launch
  release(item) {
    const live = item.live;
    if (live && live.hold) { try { live.hold.release(); } catch { /* not ours any more */ } live.hold = null; }
    if (this.holder === item) this.holder = null;
  }

  finalize(item) {
    const d = item.doc;
    const live = item.live;
    const tool = TOOLS[d.tool];
    this.release(item);
    for (const f of ['pause', 'stop']) { try { fs.rmSync(path.join(item.dir, 'control', f), { force: true }); } catch { /* absent */ } }
    d.proc = null;
    d.phase = null;
    d.endedAt = this.now();
    item.live = null;
    const lastPoint = () => {
      const ok = this.diskCheckpoints(item).filter((c) => tool.verify(item.dir, c));
      return ok.length ? ok[ok.length - 1].step : 0;
    };
    if (live.done) {
      this.finished(item, live.done);
    } else if (live.stopped) {
      const saved = live.stopped.saved !== false;
      d.step = saved ? (+live.stopped.step || d.step) : lastPoint();
      if (live.want === 'stop') { d.state = 'annule'; d.pause = null; }
      else if (!saved) { d.state = 'interrompu'; d.pause = null; }
      else { d.state = 'pause'; d.pause = { reason: live.want === 'quit' ? 'user' : (live.pauseReason || 'user') }; }
    } else if (live.killedFor === 'stop') {
      d.state = 'annule';
      d.pause = null;
      d.step = lastPoint();
    } else if (live.killedFor === 'quit') {
      d.state = 'interrompu';
      d.pause = null;
    } else if (live.killedFor === 'hang') {
      d.state = 'erreur';
      d.seen = false;
      d.error = { code: 'hang', message: both('e_hang', { n: live.hangMin || 1, a: fmtInt(d.step, 'fr') }), logTail: tailLines(path.join(item.dir, 'log.txt'), 20) };
      d.error.message.en = fill(STR.e_hang.en, { n: live.hangMin || 1, a: fmtInt(d.step, 'en') });
    } else {
      d.state = 'erreur';
      d.seen = false;
      d.error = this.classify(item, live);
    }
    if (d.state === 'annule' || d.state === 'erreur' || d.state === 'interrompu') {
      try { tool.cleanTmp(item.dir); } catch { /* next time */ }
    }
    this.save(item);
    this.writeIndex();
    this.push(item, true);
    if (typeof this.opts.onEnd === 'function') { try { this.opts.onEnd(item.id, d.state); } catch { /* a bench's hook */ } }
    for (const w of item.waiters || []) w(d.state);
    item.waiters = [];
    if (d.state === 'pause' && d.pause.reason === 'pass') this.ensureTimer();
  }

  /**
   * `done`: fini, measures learned, the last checkpoint filed in Mes LoRA. Filing may fail (folder unreachable, disk
   * full, a refused write): the training is still « fini », the failure is kept in train.json.filed and shown in the
   * end block with « Mettre dans Mes LoRA » to try again — and everything after (save, push, waiters) always runs.
   */
  finished(item, done) {
    const d = item.doc;
    d.state = 'fini';
    d.step = +done.step || d.steps;
    d.pause = null;
    d.seen = false;
    try { this.learn(item); } catch (e) { this.log(`${item.id}: timings not learned:`, e && e.message); }
    let r;
    try {
      r = this.addToLoras(item.id, d.step, { by: 'Mia' });
    } catch (e) {
      this.log(`${item.id}: final LoRA not filed:`, e && e.stack ? e.stack : e);
      r = { ok: false, code: 'fileFailed', message: both('fileFailed', { dir: this.lorasDir() || '?', msg: String((e && (e.code || e.message)) || e) }) };
    }
    if (r.ok) { d.filed = null; return; }
    const message = r.message || { fr: String(r.error || '?'), en: String(r.error || '?') };
    d.filed = { ok: false, code: r.code || 'fileFailed', message, at: this.now() };
    this.log(`${item.id}: final LoRA not filed: ${message.en}`);
  }

  /** Why the tool stopped without `done` nor `stopped`. → train.json.error */
  classify(item, live) {
    const d = item.doc;
    let lines = tailLines(path.join(item.dir, 'log.txt'), 60);
    // only what THIS launch wrote: an earlier launch's « CUDA out of memory » must not explain today's stop
    for (let i = lines.length - 1; i >= 0; i--) { if (/^---- Mia :/.test(lines[i])) { lines = lines.slice(i + 1); break; } }
    const text = lines.join('\n');
    const logTail = lines.slice(-20);
    const code = live.exited ? live.exited.code : null;
    const out = (c, key, vars) => ({ code: c, message: both(key, vars), logTail });
    if (live.exited && live.exited.spawnError) return out('tool', 'e_spawn', { line: live.exited.spawnError });
    if (live.toolError) {
      const c = String(live.toolError.code || 'tool');
      if (STR[`e_${c}`] && c !== 'tool' && c !== 'missing' && c !== 'hang') return out(c, `e_${c}`);
      if (c === 'missing') return out('missing', 'e_missing', { f: String(live.toolError.message || '?').slice(0, 200) });
      // the adapters' « why » (python\train\mia_train_common.py): two of them have their own sentence in both languages
      const w = String(live.toolError.why || '');
      if (w === 'takeover' || w === 'version') return out(w, `e_${w}`);
      return out('tool', 'e_tool', { c: code == null ? '?' : code, line: String(live.toolError.message || '').slice(0, 300) });
    }
    const free = this.freeBytes(item.dir);
    if (free != null && free < GB) return out('disk', 'e_disk');                 // measured, without reading the log
    if (/No space left on device/i.test(text)) return out('disk', 'e_disk');
    if (/CUDA out of memory/i.test(text)) return out('oom', 'e_oom');
    if (/WinError 1455|paging file|not enough memory|bad allocation|\bMemoryError\b/i.test(text)) return out('ram', 'e_ram');
    const miss = /(?:FileNotFoundError|No such file or directory)[^\n]*?['"]([^'"\n]+)['"]/i.exec(text);
    if (miss) return out('missing', 'e_missing', { f: path.basename(miss[1]) });
    // the tool vanished while loading, without a Python trace, with Windows out of memory at the last reading
    if (live.ramLowGB != null && live.ramLowGB < 1 && !/Traceback/.test(text) && !this.curve(item).some((m) => m.run === d.run)) return out('ram', 'e_ram');
    const line = meaningfulLine(lines);
    return line ? out('tool', 'e_tool', { c: code == null ? '?' : code, line }) : out('tool', 'e_toolNoLine', { c: code == null ? '?' : code });
  }

  endInError(item, code, { key, vars }) {
    const d = item.doc;
    this.release(item);
    item.live = null;
    d.proc = null;
    d.state = 'erreur';
    d.seen = false;
    d.endedAt = this.now();
    d.error = { code, message: both(key, vars), logTail: [] };
    this.save(item);
    this.push(item, true);
    for (const w of item.waiters || []) w(d.state);
    item.waiters = [];
  }

  /** What this PC taught about a base (pace, sample, load, peak memory, checkpoint size): <data>\train-timings.json */
  learn(item) {
    const d = item.doc;
    const pace = this.pace(item);
    if (pace) d.measured.sPerStep = round(pace, 3);
    if (d.base === 'fake' && !this.opts.learnFake) return;
    try {
      const all = this.timings();
      const cur = all[d.base] || {};
      for (const k of ['sPerStep', 'sampleSec', 'loadSec', 'peakVramGB', 'checkpointMB']) if (d.measured[k] > 0) cur[k] = d.measured[k];
      cur.at = this.now();
      all[d.base] = cur;
      fs.mkdirSync(this.dataDir(), { recursive: true });
      writeAtomic(this.timingsFile(), JSON.stringify(all, null, 1));
    } catch (e) {
      this.log('timings not written:', e.message);
    }
  }

  // ------------------------------------------------------------ pause, let through, stop
  askPause(item, reason) {
    const live = item.live;
    try { fs.writeFileSync(path.join(item.dir, 'control', 'pause'), String(Date.now()), 'utf8'); } catch (e) { this.log('control\\pause:', e.message); }
    live.want = 'pause';
    live.pauseReason = reason;
    live.deadline = 0;                                  // a pause is never forced: « Arrêter » is there for that
    this.push(item, true);
  }

  /**
   * control(id, action, {by}) — pause · pass (« Laisser passer ») · resumeNow · stop · stopNow.
   * pause and stop both leave a checkpoint at the current step; during a sample they take effect after it.
   */
  async control(id, action, o = {}) {
    const item = this.item(id);
    if (!item || item.missing) return this.fail('unknown');
    const d = item.doc;
    const live = item.live;
    const by = String((o && o.by) || 'user').slice(0, 40);
    const running = !!live && RUNNING.has(d.state);
    switch (action) {
      case 'pause':
      case 'pass':
        if (!running || d.state === 'preparation') return this.fail('notRunning');
        if (live.want === 'stop' || live.want === 'quit') return { ok: true, pending: live.want, state: d.state };   // a stop already asked wins
        this.askPause(item, action === 'pass' ? 'pass' : 'user');
        this.act(item, action, by);
        this.save(item);
        return { ok: true, pending: 'pause', state: d.state };
      case 'resumeNow':
        if (!(d.state === 'pause' && d.pause)) return this.fail('notResumable');
        return this.start(id, { resume: true, by });
      case 'stop':
      case 'stopNow': {
        if (!(live && d.state === 'attente') && !running && !RESUMABLE.has(d.state)) return this.fail('notRunning');
        this.act(item, 'stop', by);
        if (live && d.state === 'attente') {                 // nothing started: back to where it was
          live.abort.abort();
          this.release(item);
          item.live = null;
          Object.assign(d, item.prev || { state: 'pret' });
          this.save(item);
          this.push(item, true);
          return { ok: true, state: d.state };
        }
        if (running) {
          const silent = live.warn || d.state === 'preparation';
          if (action === 'stopNow' || silent) { live.want = 'stop'; this.kill(item, 'stop'); return { ok: true, pending: 'stop', state: d.state }; }
          try { fs.writeFileSync(path.join(item.dir, 'control', 'stop'), String(Date.now()), 'utf8'); } catch (e) { this.log('control\\stop:', e.message); }
          live.want = 'stop';
          live.deadline = this.now() + (d.state === 'essai' ? this.cfg.stopSampleMs : this.cfg.stopMs) + ((this.cfg.stopExitMs || {})[d.tool] || 0);
          this.save(item);
          this.push(item, true);
          return { ok: true, pending: 'stop', state: d.state };
        }
        // paused, interrupted…: filed as stopped, still resumable
        d.state = 'annule';
        d.pause = null;
        d.seen = true;
        this.save(item);
        this.writeIndex();
        this.push(item, true);
        return { ok: true, state: d.state };
      }
      default:
        return this.fail('badAction', { a: String(action) });
    }
  }

  /** « Laisser passer » : as soon as Mia's own queue is empty, the training starts again from its checkpoint. */
  passCheck(item) {
    if (item.starting || !this.queueIdle()) return;
    this.start(item.id, { resume: true, by: 'Mia' }).then((r) => {
      if (r && !r.ok) {                                     // refused (disk…): it becomes a plain pause, with the reason
        item.doc.pause = { reason: r.code === 'disk' ? 'disk' : 'user' };
        this.save(item);
        this.push(item, true);
      }
    }).catch((e) => this.log(`automatic resume of ${item.id}:`, e.message));
  }

  // ------------------------------------------------------------ checkpoints, resume
  diskCheckpoints(item) {
    try { return TOOLS[item.doc.tool].checkpoints(item.dir, item.doc); } catch { return []; }
  }

  /**
   * The step to resume from: the last checkpoint that is complete. Anything invalid or later than it is moved to
   * out\ecartes\ (the tools pick the most recent file without checking it). dryRun: only tell the step.
   */
  pickCheckpoint(item, { dryRun = false } = {}) {
    const d = item.doc;
    const tool = TOOLS[d.tool];
    const all = this.diskCheckpoints(item);
    let pick = null;
    for (let i = all.length - 1; i >= 0; i--) { if (tool.verify(item.dir, all[i])) { pick = all[i]; break; } }
    if (dryRun) return pick ? pick.step : 0;
    const aside = all.filter((c) => !pick || c.step > pick.step);
    if (aside.length) {
      const dst = path.join(item.dir, 'out', 'ecartes');
      fs.mkdirSync(dst, { recursive: true });
      for (const c of aside) {
        const from = path.join(item.dir, c.unit);
        let to = path.join(dst, `run${d.run}_${path.basename(c.unit)}`);
        for (let k = 2; fs.existsSync(to); k++) to = path.join(dst, `run${d.run}_${k}_${path.basename(c.unit)}`);
        try { fs.renameSync(from, to); } catch (e) { this.log(`${item.id}: ${c.unit} not moved aside (${e.code || e.message})`); continue; }
        const k = d.checkpoints.findIndex((x) => x.step === c.step);
        if (k >= 0 && !d.checkpoints[k].added) d.checkpoints.splice(k, 1);
        else if (k >= 0) d.checkpoints[k].file = posix(path.relative(item.dir, path.join(to, path.relative(path.join(item.dir, c.unit), path.join(item.dir, c.file)))));
      }
    }
    try { tool.cleanTmp(item.dir); } catch { /* next time */ }
    return pick ? pick.step : 0;
  }

  // ------------------------------------------------------------ at Mia's startup
  /**
   * Trainings found active (Mia crashed, or was killed). A tool still alive with the right token is taken back in
   * hand — its lock first, under the same label; anything else is filed as interrupted. Nothing restarts by itself.
   */
  reconcile() {
    for (const item of this.items.values()) {
      if (item.missing || item.live) continue;
      const d = item.doc;
      if (d.state === 'pause' && d.pause && d.pause.reason === 'pass') {       // was waiting to resume by itself
        d.pause = { reason: 'user' };
        this.save(item);
        continue;
      }
      if (d.state === 'attente') {
        d.state = d.run > 0 ? 'interrompu' : 'pret';
        d.proc = null;
        this.save(item);
        continue;
      }
      if (!RUNNING.has(d.state)) continue;
      // the adapter rewrites this file every 20 s (.tmp then rename): a reading that falls on the rename is tried again
      let a = null;
      for (let k = 0; k < 3 && !a; k++) {
        a = readJSON(path.join(item.dir, 'control', 'adapter.json'));
        if (!a && k < 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
      }
      const fresh = a && d.proc && a.token === d.proc.token && Number.isInteger(a.pid) && pidAlive(a.pid)
        && Math.abs(Date.now() - (+a.t || 0)) <= this.cfg.adoptMaxAgeMs;
      if (fresh) {
        this.holder = item;
        // in hand BEFORE anything reads the tool's files (the lock's minutes read them): their lines move the state
        item.live = { ...this.newLive(item), pid: a.pid, token: a.token };
        const hold = this.gate().adopt({ label: this.lockLabel(item), minutes: () => this.lockMinutes(item) });
        if (hold) {
          item.live.hold = hold;
          d.owner = { miaPid: process.pid, userData: this.userData() };
          this.writeAlive(item);
          this.readProtocol(item);
          this.save(item);
          this.ensureTimer();
          this.log(`${item.id}: tool ${a.pid} still running, taken back in hand at step ${d.step}`);
          continue;
        }
        this.holder = null;
        item.live = null;
        this.log(`${item.id}: the GPU lock could not be taken back, the tool is stopped`);
        try { spawnSync(TASKKILL, ['/PID', String(a.pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }); } catch { /* gone */ }
      }
      if (this.endedAway(item)) continue;
      this.interrupted(item);
    }
  }

  /**
   * The tool of the last launch ended while no Mia was there to read it (Mia crashed, or restarted at that moment):
   * its own last word in events.jsonl decides, as if Mia had been there. `done` with its final checkpoint verified →
   * fini, measures learned, LoRA filed, not seen yet; `stopped` with its checkpoint → pause (or « annule » for a stop
   * that was asked); anything else → false, and the caller files it as interrupted. Only a line of THIS launch counts.
   */
  endedAway(item) {
    const d = item.doc;
    const tool = TOOLS[d.tool];
    if (!tool) return false;
    this.readProtocol(item);
    const end = item.proto && item.proto.endOf && item.proto.endOf.run === d.run ? item.proto.endOf.ev : null;
    if (!end) return false;
    const verified = (step) => this.diskCheckpoints(item).some((c) => c.step === step && tool.verify(item.dir, c));
    if (end.e === 'done') {
      if (!verified(+end.step || d.steps)) return false;
    } else if (end.e !== 'stopped' || end.saved === false || !verified(+end.step)) return false;
    for (const f of ['pause', 'stop']) { try { fs.rmSync(path.join(item.dir, 'control', f), { force: true }); } catch { /* absent */ } }
    d.proc = null;
    d.phase = null;
    d.endedAt = this.now();
    if (end.e === 'done') this.finished(item, end);
    else {
      d.step = +end.step;
      if (end.why === 'stop') { d.state = 'annule'; d.pause = null; try { tool.cleanTmp(item.dir); } catch { /* next time */ } }
      else { d.state = 'pause'; d.pause = { reason: 'user' }; }
    }
    this.save(item);
    this.writeIndex();
    this.push(item, true);
    this.log(`${item.id}: the tool ended while Mia was away (${end.e}${end.why ? `, ${end.why}` : ''}), filed as « ${d.state} » at step ${d.step}`);
    return true;
  }

  /** Filed as interrupted, at the last step the tool wrote. */
  interrupted(item) {
    const d = item.doc;
    const pts = this.curve(item).filter((m) => m.run === d.run);
    if (pts.length) d.step = pts[pts.length - 1].s;
    d.state = 'interrompu';
    d.pause = null;
    d.proc = null;
    d.phase = null;
    d.seen = false;
    d.endedAt = this.now();
    try { TOOLS[d.tool].cleanTmp(item.dir); } catch { /* next time */ }
    this.save(item);
  }

  // ------------------------------------------------------------ Mia closes
  /**
   * Called on every way out of Mia. A training in its steps gets control\pause and one minute to write its
   * checkpoint (a running sample: until it ends, 6 min at most); waiting or preparing, it is stopped at once.
   * {now:true}: « Quitter sans attendre ». → resolves when no tool of Mia is left running.
   */
  stopForQuit(o = {}) {
    const waits = [];
    for (const item of this.items.values()) {
      const d = item.doc;
      const live = item.live;
      if (d.state === 'pause' && d.pause && d.pause.reason === 'pass') { d.pause = { reason: 'user' }; this.save(item); continue; }
      if (!live) continue;
      if (d.state === 'attente') {
        live.abort.abort();
        this.release(item);
        item.live = null;
        Object.assign(d, item.prev || { state: 'pret' });
        this.save(item);
        continue;
      }
      waits.push(new Promise((resolve) => { (item.waiters = item.waiters || []).push(resolve); }));
      if ((o && o.now) || d.state === 'preparation' || live.warn) { live.want = 'quit'; this.kill(item, 'quit'); continue; }
      if (live.want !== 'quit') {
        try { fs.writeFileSync(path.join(item.dir, 'control', 'pause'), String(Date.now()), 'utf8'); } catch { /* the deadline kills */ }
        live.want = 'quit';
        live.deadline = this.now() + (d.state === 'essai' ? this.cfg.stopSampleMs : this.cfg.quitMs);
        this.push(item, true);
      }
    }
    this.ensureTimer();
    return Promise.all(waits).then((states) => ({ ok: true, states }));
  }

  /** Last resort when the process goes down: no tool outlives Mia with the GPU; states are written at once. */
  killSync() {
    for (const item of this.items.values()) {
      const live = item.live;
      if (!live) continue;
      try { live.abort.abort(); } catch { /* already */ }
      if (live.pid) { try { spawnSync(TASKKILL, ['/PID', String(live.pid), '/T', '/F'], { windowsHide: true, timeout: 4000 }); } catch { /* gone */ } }
      this.release(item);
      item.live = null;
      if (item.doc.state === 'attente') Object.assign(item.doc, item.prev || { state: 'pret' });
      else this.interrupted(item);
      this.save(item);
    }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // ------------------------------------------------------------ Mes LoRA
  /**
   * File a checkpoint (the last one by default) in the LoRA folder: hard link, else a copy (.part then rename),
   * never over an existing file; its card <name>.mia.json beside it. → {file, comfyName}
   */
  addToLoras(id, step, o = {}) {
    const item = this.item(id);
    if (!item || item.missing) return this.fail('unknown');
    const d = item.doc;
    // the refusals carry their sentence in both languages: a failure of the final filing is kept in train.json.filed
    const no = (code, vars) => ({ ...this.fail(code, vars), message: both(code, vars) });
    const base = this.base(d.base) || { suffix: d.base, label: { fr: d.base, en: d.base } };
    const ck = step == null ? d.checkpoints[d.checkpoints.length - 1] : d.checkpoints.find((c) => c.step === +step);
    if (!ck) return no('noCheckpoint', { step: step == null ? '?' : step });
    if (ck.added && fs.existsSync(ck.added.file)) {
      if (d.filed && ck.step >= d.steps) { d.filed = null; this.save(item); this.push(item, true); }
      return { ok: true, file: ck.added.file, comfyName: ck.added.comfyName, already: true };
    }
    const src = path.join(item.dir, ck.file);
    if (!safetensorsComplete(src)) return no('badCheckpoint', { step: ck.step });
    const dir = this.lorasDir();
    if (!dir || !fs.existsSync(path.dirname(dir))) return no('noLoras', { path: dir || '?' });
    let name;
    let dst;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const stem = `${cleanStem(d.name)}_${base.suffix}_${String(ck.step).padStart(5, '0')}`;
      name = `${stem}.safetensors`;
      for (let k = 2; fs.existsSync(path.join(dir, name)) || fs.existsSync(path.join(dir, name.replace(/\.safetensors$/, '.mia.json'))); k++) name = `${stem}_${k}.safetensors`;
      dst = path.join(dir, name);
      try {
        fs.linkSync(src, dst);
      } catch {
        try {
          fs.copyFileSync(src, `${dst}.part`);
          fs.renameSync(`${dst}.part`, dst);
        } catch (e) {
          try { fs.rmSync(`${dst}.part`, { force: true }); } catch { /* nothing was written */ }
          throw e;
        }
      }
    } catch (e) {
      this.log(`${item.id}: step ${ck.step} not filed in ${dir}:`, e && e.message);
      return no('fileFailed', { dir, msg: String((e && e.code) || (e && e.message) || e) });
    }
    const final = ck.step >= d.steps;
    const vars = (lang) => ({ base: base.label[lang], steps: fmtInt(d.steps, lang), step: fmtInt(ck.step, lang), images: d.dataset.count, trigger: d.trigger });
    const key = final ? 'advice' : 'adviceStep';
    const card = {
      name: d.name,
      kind: d.kind,
      trigger: d.trigger,
      strength: 1.0,
      advice: { fr: fill(STR[key].fr, vars('fr')), en: fill(STR[key].en, vars('en')) },
      training: {
        id: d.id, base: d.base, tool: d.toolName || d.tool, steps: d.steps, step: ck.step, images: d.dataset.count,
        rank: d.settings.rank, date: localDay(this.now())
      }
    };
    try {
      writeAtomic(dst.replace(/\.safetensors$/, '.mia.json'), JSON.stringify(card, null, 1));
    } catch (e) {
      // without its card the file would come back as somebody else's LoRA: taken back out (it is a link or a copy)
      this.log(`${item.id}: card of step ${ck.step} not written:`, e && e.message);
      for (const f of [dst, `${dst.replace(/\.safetensors$/, '.mia.json')}.tmp`]) { try { fs.rmSync(f, { force: true }); } catch { /* left */ } }
      return no('fileFailed', { dir, msg: String((e && e.code) || (e && e.message) || e) });
    }
    ck.added = { file: dst, comfyName: `mia\\${name}` };
    if (final) d.filed = null;
    this.act(item, 'add', String((o && o.by) || 'user').slice(0, 40), String(ck.step));
    this.save(item);
    this.push(item, true);
    return { ok: true, file: dst, comfyName: ck.added.comfyName };
  }

  trash(abs) {
    if (typeof this.opts.trash === 'function') return this.opts.trash(abs);
    if (typeof this.ctx.trashItem === 'function') return this.ctx.trashItem(abs);
    return require('electron').shell.trashItem(abs);
  }

  /** « Retirer de Mes LoRA » : the filed file and its card go to the Recycle Bin; the checkpoint stays in the training. */
  async removeFromLoras(id, step, o = {}) {
    const item = this.item(id);
    if (!item || item.missing) return this.fail('unknown');
    const ck = item.doc.checkpoints.find((c) => c.step === +step);
    if (!ck || !ck.added) return this.fail('notInLoras');
    const file = ck.added.file;
    if (!sameDir(path.dirname(file), this.lorasDir())) return this.fail('notInLoras');   // never anything outside Mia's LoRA folder
    for (const f of [file, file.replace(/\.safetensors$/, '.mia.json')]) {
      if (!fs.existsSync(f)) continue;
      try { await this.trash(f); } catch (e) { this.log(`trash ${f}:`, e.message); return this.fail('trashFailed', { name: path.basename(f) }); }
    }
    ck.added = null;
    this.act(item, 'remove', String((o && o.by) || 'user').slice(0, 40), String(ck.step));
    this.save(item);
    this.push(item, true);
    return { ok: true };
  }

  // ------------------------------------------------------------ notes, seen, bin, folder
  note(id, o = {}) {
    const item = id ? this.item(id) : (this.active() || this.latest());
    if (!item || item.missing) return this.fail('unknown');
    const text = String((o && o.text) || '').trim();
    const by = String((o && o.by) || 'user').slice(0, 40);
    if (!text) return this.fail('noteEmpty');
    if (text.length > 280) return this.fail('noteLong');
    const notes = item.doc.notes.filter((n) => !n.act);
    if (by !== 'user') {
      if (notes.length >= 40) return this.fail('noteMax');
      const last = [...notes].reverse().find((n) => n.by === by);
      if (last && this.now() - last.at < this.cfg.noteMs) return this.fail('noteRate');
    }
    item.doc.notes.push({ by, step: item.doc.step, text, at: this.now() });
    this.save(item);
    this.push(item, true);
    return { ok: true, trainingId: item.id, step: item.doc.step };
  }

  seen(id) {
    const item = this.item(id);
    if (!item) return this.fail('unknown');
    if (!item.doc.seen) { item.doc.seen = true; this.save(item); this.push(item, true); }
    return { ok: true };
  }

  /**
   * A draft left exactly as « Nouveau LoRA » made it: no name, no trigger word, no image (none tried either), never
   * changed, made by the user (an assistant's draft is never thrown away), no suggestion — and its folder holds
   * nothing else than what Mia wrote at its creation.
   */
  pristine(item) {
    const d = item && item.doc;
    if (!d || item.missing || item.live || item.importing || item.queue && item.importJobs > 0) return false;
    if (d.state !== 'pret' || d.edited || d.run > 0 || d.proposal || (d.by && d.by.who && d.by.who !== 'user')) return false;
    if (d.name.trim() || d.trigger.trim() || d.dataset.count > 0 || (d.dataset.skipped || []).length) return false;
    try {
      const names = fs.readdirSync(item.dir);
      if (!names.every((n) => n === 'train.json' || n === 'dataset')) return false;
      if (names.includes('dataset') && !fs.readdirSync(path.join(item.dir, 'dataset')).every((n) => n === 'dataset.json')) return false;
    } catch { return false; }
    return true;
  }

  /**
   * The whole training to the Recycle Bin (refused while it runs). The LoRAs already filed stay where they are.
   * {ifEmpty:true} — leaving the screen of a draft: removed for good, without the Bin, only when it is still the
   * empty « Nouveau LoRA » (pristine); otherwise kept, and nothing is said ({ok:true, kept:true}).
   */
  async remove(id, o = {}) {
    const item = this.item(id);
    if (!item) return this.fail('unknown');
    if (o && o.ifEmpty) {
      if (!this.pristine(item)) return { ok: true, kept: true };
      try { fs.rmSync(item.dir, { recursive: true, force: true }); } catch (e) { this.log(`empty draft ${item.id} not removed:`, e.message); return { ok: true, kept: true }; }
      this.items.delete(item.id);
      this.writeIndex();
      this.push(null);
      return { ok: true, discarded: true };
    }
    if (item.live || this.isActive(item)) return this.fail('activeNoRemove');
    if (item.queue) await item.queue;
    const sizeMB = item.missing ? 0 : Math.round((await dirBytes(item.dir)) / 1048576);
    if (!item.missing && fs.existsSync(item.dir)) {
      try { await this.trash(item.dir); } catch (e) { this.log(`trash ${item.dir}:`, e.message); return this.fail('trashFailed', { name: item.doc.name || item.id }); }
    }
    this.items.delete(item.id);
    this.writeIndex();
    this.push(null);
    return { ok: true, sizeMB };
  }

  async reveal(id) {
    const item = this.item(id);
    if (!item || item.missing) return this.fail('unknown');
    if (typeof this.opts.openPath === 'function') { this.opts.openPath(item.dir); return { ok: true, dir: item.dir }; }
    const err = await require('electron').shell.openPath(item.dir);
    return err ? { ok: false, error: err } : { ok: true, dir: item.dir };
  }

  /** « Retrouver le dossier… » : the folder of a training listed as missing was moved; this is where it is now. */
  locate(id, dir) {
    const item = this.item(id);
    if (!item) return this.fail('unknown');
    if (!item.missing) return this.fail('notMissing');
    const doc = typeof dir === 'string' && path.isAbsolute(dir) ? readJSON(path.join(dir, 'train.json')) : null;
    if (!doc || doc.id !== item.id) return this.fail('locateWrong');
    item.dir = dir;
    item.missing = false;
    item.doc = this.normalize(doc);
    item.doc.owner = { miaPid: process.pid, userData: this.userData() };
    item.dataset = null;
    item.proto = null;
    if (this.isActive(item)) this.interrupted(item);
    this.save(item);
    this.writeIndex();
    this.push(null);
    return { ok: true, dir };
  }

  /** Benches: stop the timer (nothing else is held). */
  dispose() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

/** main.js: require('./trainer').register(ctx) — after the engine. → the Trainer. */
function register(ctx) {
  return new Trainer(ctx).install();
}

module.exports = {
  register, Trainer, TIMING, STR,
  _internals: { imageSize, readImageSize, readCaption, commitAvailableGB, cleanStem, meaningfulLine, tailLines, createLockGate, freeBytesOf, localDay, round }
};
