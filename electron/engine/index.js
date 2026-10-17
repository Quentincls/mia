'use strict';
// Mia's engine, main process (SPEC §8.1, §8.2, §8.6).
//
// engine:run → plan → queue → executor → run.json:
// - plan: read the block and everything upstream from the graph the board sends (unsaved edits included),
//   check what is missing in plain French, fingerprint each computed block (type, full params, mode, upstream
//   fingerprints), reuse a finished version with the same fingerprint (or the starred one), and queue a job for
//   every stale upstream block before the one asked for;
// - queue: FIFO, ONE heavy (GPU) job at a time and only with the lab's GPU lock; light jobs (max 2) wait while a
//   heavy job holds the GPU (lab rule: never a big CPU job next to a GPU job — the laptop crashed twice);
// - executors: ./executors/<name>.js (B2/B3), loaded lazily, given the context `x` of SPEC §8.2.5
//   (+ x.ensureLora(key), x.engineRoot, x.notes);
// - versions: outputs/<nodeId>/<runId>/ with run.json (done | error | cancelled), probed outputs and posters;
//   a cancelled or failed version keeps run.json + log.txt only (the rest goes to the Recycle Bin).
// Rules of SPEC §16: upstream = starred version › newest final › newest preview; an empty Media block on an
// optional input is left out with a note; a project renamed while its job waits is followed by id (its folder
// cannot move while the job computes: log.txt stays open); quitting cancels Mia's ComfyUI prompt before the
// GPU lock goes. Status (ComfyUI, GPU, lock, queue) is polled every 3 s while a window is open.
// register(ctx) returns the Engine, which main.js serves as ctx.engine (bridge of SPEC §13).

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const { Comfy, kindOf } = require('./comfy');
const { createPyRunner } = require('./pyrun');
const { createGpuLock, hhmm } = require('./gpulock');
const places = require('../places');

// ------------------------------------------------------------------ strings
// Main-process strings, resolved at call time from prefs.lang (the renderer's i18n.js does not run here).
const STR = {
  fr: {
    queued: 'En attente',
    waitHeavy: 'Attend la fin du calcul en cours',
    waitLight: 'Attend la fin d’un petit calcul',
    waitDep: 'Attend le bloc « {name} »',
    gpuBusy: 'GPU occupé par « {who} » depuis {at}',
    gpuBusyMin: 'GPU occupé par « {who} » depuis {at} (~{minutes} min)',
    comfyOther: 'une autre session (ComfyUI)',
    otherSession: 'une autre session',
    comfyStarting: 'Démarrage du moteur…',
    starting: 'Démarrage…',
    done: 'Terminé',
    cancelled: 'Annulé',
    upFailed: 'Le bloc « {name} » a échoué',
    upCancelled: 'Le bloc « {name} » a été annulé',
    noExecutor: 'Ce bloc n’est pas encore disponible dans Mia (moteur « {name} » absent).',
    badExecutor: 'Le moteur « {name} » n’a pas pu se charger : {msg}',
    noOutputs: 'Le calcul n’a produit aucun fichier.',
    outputMissing: 'Fichier de sortie introuvable : {file}',
    badRequest: 'Demande de calcul incomplète.',
    projectNotFound: 'Projet introuvable.',
    nodeNotFound: 'Bloc introuvable sur la planche.',
    unknownType: 'Type de bloc inconnu : {type}',
    notComputable: 'Ce bloc ne se calcule pas.',
    bypassed: 'Ce bloc est désactivé : réactive-le pour le lancer.',
    cycle: 'Les fils forment une boucle : impossible de calculer.',
    dangling: 'Un fil pointe vers un bloc qui n’existe plus.',
    connect: 'Branche {what}',
    connectAny: 'Branche l’entrée « {label} »',
    connectMulti: 'Branche au moins {what}',
    dropFile: 'Glisse un fichier dans « {label} »',
    fileMissing: 'Fichier introuvable : {file}',
    wrongKind: '« {port} » attend {expected}, pas {got}',
    writePrompt: 'Écris une consigne',
    linkedEmpty: 'La consigne branchée sur « {label} » est vide',
    fill: 'Remplis « {label} »',
    noModel: 'Aucun modèle installé pour « {label} »',
    modelGone: 'Le modèle choisi pour « {label} » n’est plus disponible',
    inBlock: 'Bloc « {block} » : {msg}',
    noSuchOutput: 'Le bloc « {name} » n’a pas de sortie « {port} »',
    noOutput: 'Ce bloc ne transmet rien',
    bypassNothing: 'Ce bloc est désactivé et ne transmet rien',
    lockDir: 'Dossier du moteur introuvable ({dir}) : impossible de réserver le GPU.',
    jobNotFound: 'Calcul introuvable (déjà terminé ?).',
    runBusy: 'Cette version est en cours de calcul.',
    runNotFound: 'Version introuvable.',
    deleteFailed: 'Impossible de mettre la version à la corbeille : {msg}',
    internal: 'Erreur interne du moteur : {msg}',
    diskFull: 'Disque plein : libère de la place puis relance.',
    fileBusy: 'Fichier utilisé par un autre programme : {file}',
    oom: 'Mémoire GPU insuffisante : ferme Unreal ou attends la fin de l’autre calcul, puis relance.',
    catalog: 'Catalogue des blocs illisible : {msg}',
    unknownError: 'Erreur inconnue',
    kImage: 'une image',
    kVideo: 'une vidéo',
    kMedia: 'une image ou une vidéo',
    kText: 'un texte',
    kAudio: 'un son',
    ignoredEmpty: '« {label} » est vide : le bloc s’est lancé sans.',
    tooMany: 'Seules les {max} premières entrées « {label} » sont utilisées.',
    projectGone: 'Projet introuvable : il a été mis à la Corbeille ou déplacé pendant l’attente.',
    loraGone: 'Le LoRA choisi pour « {label} » n’est plus disponible',
    loraPrep: 'Préparation du LoRA…',
    loraPrepP: 'Préparation du LoRA… {p} %',
    loraFailed: 'Le LoRA « {name} » n’a pas pu être préparé pour le moteur.',
    quitNote: 'Mia a été fermée pendant le calcul.',
    waitTimeout: 'Toujours en cours après {s} s.'
  },
  en: {
    queued: 'Queued',
    waitHeavy: 'Waiting for the current job',
    waitLight: 'Waiting for a small job to finish',
    waitDep: 'Waiting for “{name}”',
    gpuBusy: 'GPU busy: “{who}” since {at}',
    gpuBusyMin: 'GPU busy: “{who}” since {at} (~{minutes} min)',
    comfyOther: 'another session (ComfyUI)',
    otherSession: 'another session',
    comfyStarting: 'Starting the engine…',
    starting: 'Starting…',
    done: 'Done',
    cancelled: 'Cancelled',
    upFailed: 'Block “{name}” failed',
    upCancelled: 'Block “{name}” was cancelled',
    noExecutor: 'This block is not available in Mia yet (engine “{name}” missing).',
    badExecutor: 'Engine “{name}” could not load: {msg}',
    noOutputs: 'The job produced no file.',
    outputMissing: 'Output file not found: {file}',
    badRequest: 'Incomplete job request.',
    projectNotFound: 'Project not found.',
    nodeNotFound: 'Block not found on the board.',
    unknownType: 'Unknown block type: {type}',
    notComputable: 'This block does not compute anything.',
    bypassed: 'This block is disabled: enable it to run it.',
    cycle: 'The wires form a loop: nothing can be computed.',
    dangling: 'A wire points to a block that no longer exists.',
    connect: 'Connect {what}',
    connectAny: 'Connect the “{label}” input',
    connectMulti: 'Connect at least {what}',
    dropFile: 'Drop a file into “{label}”',
    fileMissing: 'File not found: {file}',
    wrongKind: '“{port}” expects {expected}, not {got}',
    writePrompt: 'Write a prompt',
    linkedEmpty: 'The prompt connected to “{label}” is empty',
    fill: 'Fill in “{label}”',
    noModel: 'No model installed for “{label}”',
    modelGone: 'The model chosen for “{label}” is no longer available',
    inBlock: 'Block “{block}”: {msg}',
    noSuchOutput: 'Block “{name}” has no “{port}” output',
    noOutput: 'This block passes nothing on',
    bypassNothing: 'This block is disabled and passes nothing on',
    lockDir: 'Engine folder not found ({dir}): cannot reserve the GPU.',
    jobNotFound: 'Job not found (already finished?).',
    runBusy: 'This version is being computed.',
    runNotFound: 'Version not found.',
    deleteFailed: 'Could not move the version to the Recycle Bin: {msg}',
    internal: 'Internal engine error: {msg}',
    diskFull: 'Disk full: free some space, then try again.',
    fileBusy: 'File in use by another program: {file}',
    oom: 'Not enough GPU memory: close Unreal or wait for the other job, then try again.',
    catalog: 'Block catalogue unreadable: {msg}',
    unknownError: 'Unknown error',
    kImage: 'an image',
    kVideo: 'a video',
    kMedia: 'an image or a video',
    kText: 'a text',
    kAudio: 'a sound',
    ignoredEmpty: '“{label}” is empty: the block ran without it.',
    tooMany: 'Only the first {max} “{label}” inputs are used.',
    projectGone: 'Project not found: it was moved to the Recycle Bin or moved away while waiting.',
    loraGone: 'The LoRA chosen for “{label}” is no longer available',
    loraPrep: 'Preparing the LoRA…',
    loraPrepP: 'Preparing the LoRA… {p} %',
    loraFailed: 'LoRA “{name}” could not be prepared for the engine.',
    quitNote: 'Mia was closed during the job.',
    waitTimeout: 'Still running after {s} s.'
  }
};

// ---------------------------------------------------------------- constants
const STATUS_MS = 3000;
const SMI_MS = 10000;
const RETRY_MS = 15000;              // GPU lock polling, as the lab's scripts do
const RENEW_MS = 5 * 60 * 1000;
const MAX_LIGHT = 2;
const KEEP_FINISHED_MS = 30 * 60 * 1000;
const KEEP_FINISHED = 30;
const NVIDIA_SMI = 'C:\\Windows\\System32\\nvidia-smi.exe';
const FINAL = new Set(['done', 'error', 'cancelled']);
const GIB = 1024 ** 3;
// A cancelled or failed version keeps only these; the rest (partial video, frames…) goes to the Recycle Bin.
const KEEP_ON_FAIL = new Set(['run.json', 'log.txt']);
// Settings that change a block's duration a lot, learned apart (timings.json).
const TIMING_PARAMS = ['speed', 'detail'];
// First-run lock estimates (minutes) until real durations are learned — from the catalog's estimates.
const DEFAULT_MINUTES = {
  'i2v|preview': 2, 'i2v|final': 9, 't2v|preview': 2, 't2v|final': 9, 'real|preview': 3, 'real|final': 20,
  'perform|preview': 5, 'perform|final': 15, edit: 3, upscale: 20, depth: 2, cutout: 3
};

// ------------------------------------------------------------------ helpers
const fmt = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const toSlash = (p) => String(p).split(/[\\/]+/).join('/');
const safeSeg = (s) => /^[\w.-]+$/.test(String(s || '')) && !/^\.+$/.test(String(s));
const hms = () => new Date().toTimeString().slice(0, 8);

/** JSON with sorted keys: the same settings always give the same fingerprint. */
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
}

/** Cancellable wait: an abort wakes it at once (the caller then sees signal.aborted). */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', done);
      resolve();
    }
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

function abortError(msg) {
  const e = new Error(msg);
  e.name = 'AbortError';
  e.cancelled = true;
  return e;
}

/** "r_1016_201533_ab12" : month-day, time, a little randomness (two runs in the same second). */
function makeRunId(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `r_${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}_${crypto.randomBytes(2).toString('hex')}`;
}

const inside = (dir, abs) => {
  const r = path.relative(dir, abs);
  return !!r && !r.startsWith('..') && !path.isAbsolute(r);
};

/** String key naming a port type for the messages (« une image », « un son »…). */
const kindKey = (k) => ({ image: 'kImage', video: 'kVideo', text: 'kText', audio: 'kAudio' })[k] || 'kMedia';

/**
 * Port compatibility (SPEC §4). An unknown concrete type ("media") is checked again when the job starts.
 * A sound (`audio`) only goes into an `audio` input: « media » means a picture (image or video).
 */
function portAccepts(expected, got) {
  if (expected === 'text' || got === 'text') return expected === got;
  if (!got || got === 'media') return true;
  if (expected === 'media') return got === 'image' || got === 'video';
  return expected === got;
}

const pickMode = (type, mode) => (Array.isArray(type.modes) && type.modes.length
  ? (type.modes.includes(mode) ? mode : type.modes[0]) : null);

const tl = (obj, lang) => (obj && typeof obj === 'object' ? (obj[lang] ?? obj.fr ?? '') : String(obj ?? ''));

// French needs the gender of the noun to say « Branche une image de début » / « Branche un rendu 3D ».
const FEMININE = /^(image|vidéo|video|consigne|référence|description|séquence|photo)\b/i;
const MASCULINE = /^(rendu|personnage|média|fond|calque|masque|texte|clip|film|décor)\b/i;

function lowerFirst(w) {
  return /^[A-Z0-9]{2,}/.test(w) ? w : w.charAt(0).toLowerCase() + w.slice(1);
}

/** « Image ou vidéo » → « une image ou une vidéo » ; null when the gender is unknown. */
function articleFr(label) {
  const parts = String(label).split(/\s+ou\s+/i).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const w of parts) {
    if (FEMININE.test(w)) out.push(`une ${lowerFirst(w)}`);
    else if (MASCULINE.test(w)) out.push(`un ${lowerFirst(w)}`);
    else return null;
  }
  return out.length ? out.join(' ou ') : null;
}

function articleEn(label) {
  const w = lowerFirst(String(label).trim());
  if (!w) return null;
  return `${/^[aeiou]/i.test(w) ? 'an' : 'a'} ${w}`;
}

function pickMeta(p, fallback) {
  const m = { ...(fallback || {}) };
  for (const k of ['w', 'h', 'fps', 'frames', 'duration', 'codec', 'pixfmt', 'alpha', 'hasAudio']) {
    if (p[k] !== undefined && p[k] !== null) m[k] = p[k];
  }
  return m;
}

/** Write beside, then rename over: never half a run.json. A failed rename never leaves the .tmp behind. */
async function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  const txt = JSON.stringify(data, null, 2);
  await fsp.writeFile(tmp, txt, 'utf8');
  try {
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.writeFile(file, txt, 'utf8').finally(() => fsp.rm(tmp, { force: true }).catch(() => {}));
    if (!fs.existsSync(file)) throw e;
  }
}

/** Same, synchronous (app quitting: no promise will complete). */
function writeJsonAtomicSync(file, data) {
  const tmp = `${file}.tmp`;
  const txt = JSON.stringify(data, null, 2);
  try {
    fs.writeFileSync(tmp, txt, 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    try { fs.writeFileSync(file, txt, 'utf8'); } catch { /* best effort */ }
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * The version of a block that is shown and passed downstream (SPEC §16, same rule as nodes/runs.js):
 * the starred one is handled by the caller; else the newest `done` in final mode (or without mode); else the
 * newest `done` preview. `runs` = done runs, newest first.
 */
function currentRun(runs) {
  return runs.find((r) => r.mode !== 'preview') || runs[0] || null;
}

/** A setting hidden by its `showIf` (e.g. the LoRA strength while no LoRA is chosen) does not count. */
function shownParam(p, params) {
  const c = p && p.showIf;
  if (!c || !c.param) return true;
  const v = params[c.param];
  const same = (a, b) => a === b || (a == null && b == null);
  if (Array.isArray(c.notIn) && c.notIn.some((x) => same(x, v))) return false;
  if (Array.isArray(c.in) && !c.in.some((x) => same(x, v))) return false;
  if ('eq' in c && !same(c.eq, v)) return false;
  if ('ne' in c && same(c.ne, v)) return false;
  return true;
}

/**
 * VRAM in use from ComfyUI's /system_stats device: vram_free counts torch's reserved-but-free memory (and with
 * cudaMallocAsync can exceed the total), so it is taken out first. → GB (one decimal) or null when inconsistent.
 */
function vramUsedGB(dev) {
  const total = +dev.vram_total;
  if (!(total > 0)) return null;
  const free = (+dev.vram_free || 0) - (+dev.torch_vram_free || 0);
  const used = total - free;
  if (!(used >= 0 && used <= total)) return null;
  return Math.round((used / GIB) * 10) / 10;
}

// ================================================================== planner
/**
 * Resolves one engine:run request against the graph the board sent: validation, fingerprints, reuse, and the
 * list of new jobs in dependency order. One planner per request; results are memoized per block so a block
 * feeding several inputs gets one job only.
 */
class Planner {
  constructor(engine, project, graph, lang) {
    this.e = engine;
    this.project = project;
    this.lang = lang;
    this.nodes = new Map((graph.nodes || []).filter((n) => n && n.id).map((n) => [n.id, n]));
    this.edges = (graph.edges || []).filter((e) => e && e.from && e.to);
    this.specMemo = new Map();
    this.compMemo = new Map();
    this.newJobs = [];
  }

  tr(key, vars) {
    return this.e.tr(key, vars, this.lang);
  }

  label(node, type) {
    return node.title || tl(type.label, this.lang) || node.type;
  }

  /** Wires into a port; several wires (multi input) are ordered by the vertical position of their source (SPEC §3.2). */
  edgesInto(nodeId, port) {
    const list = this.edges.filter((e) => e.to.node === nodeId && e.to.port === port && this.nodes.has(e.from.node));
    return list.sort((a, b) => {
      const na = this.nodes.get(a.from.node);
      const nb = this.nodes.get(b.from.node);
      return (na.y || 0) - (nb.y || 0) || (na.x || 0) - (nb.x || 0);
    });
  }

  kindWord(k) {
    return this.tr(kindKey(k));
  }

  connectMessage(inp) {
    const label = tl(inp.label, this.lang);
    const word = inp.multi ? label.replace(/s$/i, '') : label;
    const what = this.lang === 'en' ? articleEn(word) : articleFr(word);
    if (!what) return this.tr('connectAny', { label });
    return this.tr(inp.multi ? 'connectMulti' : 'connect', { what });
  }

  /** Entry point: plan the requested block. → {ok, job, already?} | {ok:false, error, missing} */
  async request(nodeId, mode) {
    const node = this.nodes.get(nodeId);
    if (!node) return { ok: false, error: this.tr('nodeNotFound'), missing: [] };
    const type = this.e.types.get(node.type);
    if (!type) return { ok: false, error: this.tr('unknownType', { type: node.type }), missing: [] };
    if (!type.engine || !type.engine.executor) return { ok: false, error: this.tr('notComputable'), missing: [] };
    if (node.bypass) return { ok: false, error: this.tr('bypassed'), missing: [{ nodeId, kind: 'bypass', message: this.tr('bypassed') }] };

    const spec = await this.spec(node, type, pickMode(type, mode), []);
    if (spec.error) return { ok: false, error: spec.error, missing: spec.missing || [] };
    // Same block, same settings, already queued or running: answer with that job instead of computing twice.
    const active = this.e.activeJob(this.project.id, node.id, spec.hash);
    if (active) return { ok: true, job: active, already: true };
    const job = this.e.makeJob(this.project, node, type, spec, this.lang);
    job._.createdUpstream = this.newJobs.slice();
    this.newJobs.push(job);
    return { ok: true, job };
  }

  /** Settings of a computed block: inputs, full params, models, fingerprint. Memoized per block and mode. */
  spec(node, type, mode, stack) {
    const key = `${node.id}|${mode}`;
    if (!this.specMemo.has(key)) this.specMemo.set(key, this._spec(node, type, mode, stack));
    return this.specMemo.get(key);
  }

  /** A Media block still waiting for its file (recipe placeholder): its label, else null. */
  emptyImport(nodeId) {
    const n = this.nodes.get(nodeId);
    if (!n || n.type !== 'import' || (n.data && n.data.src)) return null;
    const type = this.e.types.get('import');
    return tl(n.data && n.data.placeholder, this.lang) || (type ? this.label(n, type) : n.title) || '';
  }

  async _spec(node, type, mode, stack) {
    const missing = [];
    const notes = [];
    const inputRefs = {};
    const inputHashes = {};
    const inputKinds = {};
    const deps = new Set();

    for (const inp of type.inputs || []) {
      let edges = this.edgesInto(node.id, inp.id);
      // SPEC §16: an empty Media block on an input that can do without (or among several references) is
      // left out with a note; on a required single input it still says « Glisse un fichier dans « … » ».
      if (!inp.required || inp.multi) {
        const kept = [];
        let empty = null;
        for (const e of edges) {
          const label = this.emptyImport(e.from.node);
          if (label === null) kept.push(e);
          else empty = empty || { nodeId: e.from.node, label };
        }
        if (empty && (kept.length || !inp.required)) notes.push(this.tr('ignoredEmpty', { label: empty.label || tl(inp.label, this.lang) }));
        if (empty && !kept.length && inp.required) {
          const msg = this.tr('dropFile', { label: empty.label || tl(inp.label, this.lang) });
          missing.push({ nodeId: empty.nodeId, kind: 'file', port: inp.id, message: msg });
          continue;
        }
        edges = kept;
      }
      if (!edges.length) {
        if (inp.required) missing.push({ nodeId: node.id, kind: 'input', port: inp.id, message: this.connectMessage(inp) });
        continue;
      }
      // Several wires: ordered by the height of their source (SPEC §3.2), bounded by `max` (SPEC §17).
      const max = inp.multi ? (Number(inp.max) > 0 ? Number(inp.max) : Infinity) : 1;
      if (inp.multi && edges.length > max) notes.push(this.tr('tooMany', { max, label: tl(inp.label, this.lang) }));
      const refs = [];
      const hashes = [];
      const kinds = [];
      for (const e of edges.slice(0, max)) {
        const src = await this.output(e.from.node, e.from.port, stack.concat(node.id), mode);
        if (src.error) return { ...src, upstream: true };      // already names the faulty block
        if (!portAccepts(inp.type, src.kind)) {
          missing.push({ nodeId: node.id, kind: 'type', port: inp.id,
            message: this.tr('wrongKind', { port: tl(inp.label, this.lang), expected: this.kindWord(inp.type), got: this.kindWord(src.kind) }) });
          continue;
        }
        refs.push(src.ref);
        hashes.push(src.hash);
        kinds.push(src.kind);
        if (src.job) deps.add(src.job);
      }
      if (!refs.length) continue;
      inputRefs[inp.id] = inp.multi ? refs : refs[0];
      inputHashes[inp.id] = inp.multi ? hashes : hashes[0];
      inputKinds[inp.id] = inp.multi ? (kinds.every((k) => k === kinds[0]) ? kinds[0] : 'media') : kinds[0];
    }

    const params = this.e.fullParams(type, node.params);
    // A wired text input overrides its prompt field (SPEC §4, `port`).
    for (const p of type.params || []) {
      const ref = p.port && inputRefs[p.port];
      if (ref && ref.text) params[p.id] = ref.text.text;
    }
    for (const p of type.params || []) {
      if (!p.required) continue;
      const v = params[p.id];
      if (v == null || (typeof v === 'string' && !v.trim())) {
        const linked = p.port && inputRefs[p.port];
        const label = tl(p.label, this.lang);
        missing.push({ nodeId: node.id, kind: 'param', param: p.id,
          message: linked ? this.tr('linkedEmpty', { label: this.label(node, type) })
            : p.kind === 'prompt' ? this.tr('writePrompt') : this.tr('fill', { label }) });
      }
    }

    const models = {};
    for (const p of type.params || []) {
      if (p.kind !== 'model') continue;
      const v = params[p.id];
      if (p.allowNone && (v == null || v === '' || v === 'none')) { models[p.id] = null; continue; }
      const m = await this.e.resolveModel(v == null || v === '' ? 'auto' : v, p.caps);
      models[p.id] = m;
      if (m || !this.e.hasModels()) continue;
      const chosen = v && v !== 'auto';
      if (!p.allowNone) {
        missing.push({ nodeId: node.id, kind: 'model', param: p.id, caps: p.caps || [],
          message: this.tr(chosen ? 'modelGone' : 'noModel', { label: this.label(node, type) }) });
      } else if (chosen) {
        // A LoRA picked by name that vanished must not be silently dropped from the render.
        const isLora = (p.caps || []).includes('lora');
        missing.push({ nodeId: node.id, kind: 'model', param: p.id, caps: p.caps || [],
          message: this.tr(isLora ? 'loraGone' : 'modelGone', { label: this.label(node, type) }) });
      }
    }

    if (missing.length) {
      const msgs = [...new Set(missing.map((m) => m.message))];
      return { error: msgs.slice(0, 2).join(' · ') + (msgs.length > 2 ? ` (+${msgs.length - 2})` : ''), missing };
    }

    const hashParams = this.e.hashParams(type, params, models);
    const hashFor = (m) => sha1(stable([type.id, hashParams, type.modes ? m : null, inputHashes]));
    return { node, type, mode, params, models, inputRefs, inputKinds, deps: [...deps], hash: hashFor(mode), hashFor,
      notes: [...new Set(notes)] };
  }

  /** What an upstream port carries. → {ref, hash, kind, job?} | {error, missing, upstream} */
  async output(nodeId, port, stack, reqMode) {
    if (stack.includes(nodeId)) {
      return { error: this.tr('cycle'), missing: [{ nodeId, kind: 'cycle', message: this.tr('cycle') }], upstream: true };
    }
    const node = this.nodes.get(nodeId);
    if (!node) return { error: this.tr('dangling'), missing: [], upstream: true };
    const type = this.e.types.get(node.type);
    if (!type) {
      const msg = this.tr('unknownType', { type: node.type });
      return { error: msg, missing: [{ nodeId, kind: 'type', message: msg }], upstream: true };
    }
    const label = this.label(node, type);
    const fail = (msg, extra = {}) => ({
      error: this.tr('inBlock', { block: label, msg }), missing: [{ nodeId, message: msg, ...extra }], upstream: true
    });

    if (type.id === 'import') return this.importOutput(node, type);
    if (type.id === 'text') {
      const p = this.e.fullParams(type, node.params);
      const text = String(p.text ?? '');
      const negative = String(p.negative ?? '');
      return { ref: { text: { text, negative } }, hash: sha1(stable(['text', text, negative])), kind: 'text' };
    }
    const outDef = (type.outputs || []).find((o) => o.id === port);
    if (!outDef) return fail(this.tr('noSuchOutput', { name: label, port }));
    if (!type.engine) return fail(this.tr('noOutput'));
    if (node.bypass) return this.bypassOutput(node, type, outDef, stack, reqMode, fail);

    const res = await this.computed(node, type, stack, reqMode);
    if (res.error) return res.upstream ? res : { error: this.tr('inBlock', { block: label, msg: res.error }), missing: res.missing, upstream: true };
    if (res.run) {
      const o = res.run.outputs && res.run.outputs[port];
      if (!o) return fail(this.tr('noSuchOutput', { name: label, port }));
      return { ref: { run: res.run, port }, hash: res.run.hash || res.hash, kind: o.kind || this.concrete(outDef, res.spec) };
    }
    return { ref: { job: res.job, port }, hash: res.hash, kind: this.concrete(outDef, res.spec), job: res.job };
  }

  /** Concrete type of a declared output: `follow:<input>` = type of what is wired into that input (SPEC §4). */
  concrete(outDef, spec) {
    const t = String(outDef.type || 'media');
    if (t.startsWith('follow:')) return (spec && spec.inputKinds && spec.inputKinds[t.slice(7)]) || 'media';
    return t === 'data' ? 'media' : t;
  }

  async importOutput(node, type) {
    const d = node.data || {};
    const label = tl(d.placeholder, this.lang) || this.label(node, type);
    const fail = (msg) => ({ error: msg, missing: [{ nodeId: node.id, kind: 'file', message: msg }], upstream: true });
    if (!d.src) return fail(this.tr('dropFile', { label }));
    const abs = path.resolve(this.project.dir, d.src);
    let st;
    try { st = await fsp.stat(abs); } catch { return fail(this.tr('fileMissing', { file: d.name || path.basename(abs) })); }
    const params = this.e.fullParams(type, node.params);
    const skipFirst = !!params.skipFirst;
    const ext = kindOf(abs);
    const KINDS = ['image', 'video', 'audio'];
    const kind = KINDS.includes(d.kind) ? d.kind : (KINDS.includes(ext) ? ext : 'media');
    const rel = toSlash(d.src);
    return {
      ref: { static: { abs, rel, kind, meta: d.meta || null, name: d.name || path.basename(abs), skipFirst, nodeId: node.id } },
      // Fingerprint of a source = the file itself (name, size, date) and how it is read (SPEC §8.2.2).
      hash: sha1(stable(['import', rel, st.size, Math.round(st.mtimeMs), skipFirst])),
      kind
    };
  }

  /** A disabled block lets its input through untouched, like a bypassed node in ComfyUI. */
  async bypassOutput(node, type, outDef, stack, reqMode, fail) {
    const t = String(outDef.type || 'media');
    const first = t.startsWith('follow:') ? t.slice(7) : null;
    const order = [first, ...(type.inputs || []).map((i) => i.id)].filter((v, i, a) => v && a.indexOf(v) === i);
    const want = t.startsWith('follow:') || t === 'data' ? 'media' : t;
    for (const port of order) {
      const edges = this.edgesInto(node.id, port);
      if (!edges.length) continue;
      const src = await this.output(edges[0].from.node, edges[0].from.port, stack.concat(node.id), reqMode);
      if (src.error) return src;
      if (portAccepts(want, src.kind)) return src;
    }
    return fail(this.tr('bypassNothing'));
  }

  computed(node, type, stack, reqMode) {
    if (!this.compMemo.has(node.id)) this.compMemo.set(node.id, this._computed(node, type, stack, reqMode));
    return this.compMemo.get(node.id);
  }

  /**
   * Upstream computed block: starred version › current version with the same settings (any mode: a final
   * render wins over a preview, SPEC §16) › running job › new job.
   */
  async _computed(node, type, stack, reqMode) {
    const dir = this.project.dir;
    if (node.pinnedRun) {
      const run = await this.e.readRun(dir, node.id, node.pinnedRun);
      if (run && run.status === 'done' && this.e.runFilesExist(dir, run)) return { run, hash: run.hash };
      // A starred version that vanished (deleted by hand): fall back on the normal rules.
    }
    const mode = pickMode(type, reqMode);
    const spec = await this.spec(node, type, mode, stack);
    if (spec.error) return spec;
    const wanted = new Set(type.modes ? type.modes.map((m) => spec.hashFor(m)) : [spec.hash]);
    const runs = (await this.e.listRuns(dir, node.id))
      .filter((r) => r.status === 'done' && wanted.has(r.hash) && this.e.runFilesExist(dir, r));
    const run = currentRun(runs);
    if (run) return { run, hash: run.hash, spec };
    const active = this.e.activeJob(this.project.id, node.id, spec.hash);
    if (active) return { job: active, hash: spec.hash, spec };
    const job = this.e.makeJob(this.project, node, type, spec, this.lang);
    this.newJobs.push(job);                 // after its own upstream jobs: the queue stays in dependency order
    return { job, hash: spec.hash, spec };
  }
}

// =================================================================== engine
class Engine extends EventEmitter {
  constructor(ctx = {}) {
    super();
    this.ctx = ctx;
    this.opts = ctx.engineOpts || {};       // test hooks only (temp lock path, fake executors…), never set by main.js
    this.root = (ctx.paths && ctx.paths.root) || path.resolve(__dirname, '..', '..');
    this.dataDir = (ctx.paths && ctx.paths.data) || path.join(this.root, '_data');
    this.logsDir = (ctx.paths && ctx.paths.logs) || path.join(this.dataDir, 'logs');
    this.executorsDir = this.opts.executorsDir || path.join(__dirname, 'executors');
    this.timingsFile = this.opts.timingsFile || path.join(this.dataDir, 'timings.json');
    // Run folders being written: after a quit or a crash, the next start finishes their run.json (SPEC §3.3).
    this.journalFile = this.opts.journalFile || path.join(this.dataDir, 'engine-runs.json');
    this.retryMs = this.opts.retryMs || RETRY_MS;
    this.renewMs = this.opts.renewMs || RENEW_MS;
    this.ffmpeg = ctx.ffmpeg || null;

    this._prefs = {};
    try {
      const p = ctx.prefs && ctx.prefs.get && ctx.prefs.get();
      if (p && typeof p.then === 'function') p.then((v) => { if (v) this._prefs = v; }).catch(() => {});
      else if (p) this._prefs = p;
    } catch { /* defaults */ }

    this.loadCatalog();
    this.jobs = new Map();       // jobId → job (queued or active)
    this.order = [];             // FIFO of jobIds
    this.finished = [];          // recently finished jobs, for engine:jobs
    this._exec = new Map();
    this._gpu = { name: null, vramUsedGB: null, vramTotalGB: null };
    this._smiAt = 0;
    this._lastTick = 0;
    this._lastStatusJson = '';
    this._comfyBusyOther = false;
    this.timings = this.loadTimings();
    this._journal = this.loadJournal();

    this.lock = createGpuLock({ lockPath: () => this.lockPath() });
    this.comfy = this.opts.comfy || new Comfy({
      prefs: () => this._prefs,
      logsDir: this.logsDir,
      dataDir: this.dataDir,
      onState: () => this.onComfyState(),
      log: (l) => this.logLine(`comfy: ${l}`)
    });
    this.py = createPyRunner({ prefs: () => this._prefs, root: this.root, python: ctx.paths && ctx.paths.python, worker: this.opts.workerPath });
  }

  // ------------------------------------------------------------ basics
  lang() {
    return this._prefs.lang === 'en' ? 'en' : 'fr';
  }

  tr(key, vars, lang = this.lang()) {
    return fmt(STR[lang][key] ?? STR.fr[key] ?? key, vars);
  }

  async refreshPrefs() {
    try {
      const p = this.ctx.prefs && this.ctx.prefs.get && (await this.ctx.prefs.get());
      if (p && typeof p === 'object') this._prefs = p;
    } catch { /* keep the last ones */ }
    return this._prefs;
  }

  /** prefs.engineRoot, else the lab when it is on this PC (places.js), else '' (no engine yet). */
  engineRoot() {
    return places.engineRoot(this._prefs);
  }

  /** Finish looks (luts/index.json) with whether their .cube is on this PC: [{id, exists, lab}]. */
  looks() {
    const { looks } = require('./executors/looks.js');
    return looks({ engineRoot: this.engineRoot() }).map((l) => ({ id: l.id, exists: !!l.exists, lab: !!l.lab }));
  }

  /** Current lock file (follows prefs.engineRoot). A job keeps the file it took: J.lockFile. */
  lockPath() {
    const o = this.opts.lockPath;
    if (o) return typeof o === 'function' ? o() : o;
    const root = this.engineRoot();
    // no engine: a lock of Mia's own (never a relative path) — the job then stops on « no engine »
    if (!root) return path.join(this.dataDir || require('node:os').tmpdir(), 'runtime', 'gpu.lock');
    return path.join(root, 'runtime', 'gpu.lock');
  }

  /** Recycle Bin, never a hard delete (SPEC §5). */
  trash(p) {
    const fn = typeof this.ctx.trashItem === 'function' ? this.ctx.trashItem : (x) => require('electron').shell.trashItem(x);
    return fn(p);
  }

  loadCatalog() {
    const file = this.opts.catalogPath || path.join(this.root, 'src', 'catalog', 'nodes.json');
    try {
      const cat = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.types = new Map((cat.types || []).map((t) => [t.id, t]));
      this.catalogError = null;
    } catch (e) {
      this.types = new Map();
      this.catalogError = e.message;
    }
  }

  logLine(line) {
    try {
      fs.mkdirSync(this.logsDir, { recursive: true });
      fs.appendFileSync(path.join(this.logsDir, 'engine.log'), `${new Date().toISOString()} ${line}\n`);
    } catch { /* logging never breaks the engine */ }
  }

  send(channel, payload) {
    try {
      if (typeof this.ctx.send === 'function') return this.ctx.send(channel, payload);
      const w = this.ctx.getWin && this.ctx.getWin();
      if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
    } catch { /* window closing */ }
    return undefined;
  }

  windowOpen() {
    if (this.opts.forcePoll) return true;
    try {
      const w = this.ctx.getWin && this.ctx.getWin();
      return !!w && !(w.isDestroyed && w.isDestroyed());
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ catalog / params / models
  fullParams(type, nodeParams) {
    const out = {};
    for (const p of type.params || []) out[p.id] = p.default === undefined ? null : clone(p.default);
    for (const [k, v] of Object.entries(nodeParams || {})) {
      if (k.startsWith('_') || v === undefined) continue;   // "_" = display caches (SPEC §3.2)
      out[k] = clone(v);
    }
    return out;
  }

  /**
   * Params that define the result — every one of the catalog (format, resolution, lora, loraStrength, follow,
   * strength…). "auto" models hash as the model they resolve to: a new default recomputes. A setting hidden
   * by its showIf (the LoRA strength while no LoRA is chosen) hashes as its default: no pointless recompute,
   * and versions made before keep their fingerprint.
   */
  hashParams(type, params, models) {
    const o = {};
    for (const p of type.params || []) {
      if (!shownParam(p, params)) { o[p.id] = p.default === undefined ? null : clone(p.default); continue; }
      if (p.kind === 'model') {
        const m = models[p.id];
        o[p.id] = m ? `model:${m.id || m.file || m.path || stable(m.comfy || m.label || '')}` : String(params[p.id] ?? '');
      } else o[p.id] = params[p.id] ?? null;
    }
    return o;
  }

  hasModels() {
    return !!(this.ctx.models && typeof this.ctx.models.resolve === 'function');
  }

  async resolveModel(value, caps) {
    if (!this.hasModels()) return null;
    try {
      return (await this.ctx.models.resolve(value, caps || [])) || null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ projects / runs
  async project(projectId) {
    let dir = null;
    try { dir = this.ctx.store && (await this.ctx.store.projectDir(projectId)); } catch { dir = null; }
    if (!dir || !fs.existsSync(dir)) return null;
    let name = null;
    try {
      const p = this.ctx.store.projectById && (await this.ctx.store.projectById(projectId));
      name = p && p.name;
    } catch { /* read below */ }
    if (!name) {
      try { name = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).name; } catch { /* folder name */ }
    }
    return { id: projectId, dir, name: name || path.basename(dir) };
  }

  /**
   * The project's folder NOW, by id: a project renamed while its job waited is followed, one moved to the
   * Recycle Bin ends the job with a clear message. While a job computes, its open log.txt keeps Windows from
   * moving the folder under it.
   */
  async refreshProject(job) {
    const p = await this.project(job.projectId);
    if (!p) throw new Error(this.tr('projectGone'));
    const J = job._;
    J.project.dir = p.dir;
    J.project.name = p.name;
    return p.dir;
  }

  async readRun(projectDir, nodeId, runId) {
    if (!safeSeg(nodeId) || !safeSeg(runId)) return null;
    try {
      const run = JSON.parse(await fsp.readFile(path.join(projectDir, 'outputs', nodeId, runId, 'run.json'), 'utf8'));
      if (!run || typeof run !== 'object') return null;
      run.runId = run.runId || runId;
      run.nodeId = run.nodeId || nodeId;
      return run;
    } catch {
      return null;
    }
  }

  /** All versions of a block (done, error, cancelled), newest first. */
  async listRuns(projectDir, nodeId) {
    if (!safeSeg(nodeId)) return [];
    let entries;
    try { entries = await fsp.readdir(path.join(projectDir, 'outputs', nodeId), { withFileTypes: true }); } catch { return []; }
    const runs = [];
    for (const d of entries) {
      if (!d.isDirectory()) continue;
      const r = await this.readRun(projectDir, nodeId, d.name);
      if (r) runs.push(r);
    }
    runs.sort((a, b) => (b.finished || b.started || 0) - (a.finished || a.started || 0));
    return runs;
  }

  runFilesExist(projectDir, run) {
    const outs = Object.values(run.outputs || {});
    return outs.every((o) => o && o.path && fs.existsSync(path.join(projectDir, ...String(o.path).split('/'))));
  }

  // ------------------------------------------------------------ journal of run folders being written
  loadJournal() {
    try {
      const j = JSON.parse(fs.readFileSync(this.journalFile, 'utf8'));
      return new Set(Array.isArray(j && j.active) ? j.active.filter((d) => typeof d === 'string') : []);
    } catch {
      return new Set();
    }
  }

  saveJournal() {
    try {
      fs.mkdirSync(path.dirname(this.journalFile), { recursive: true });
      writeJsonAtomicSync(this.journalFile, { active: [...this._journal] });
    } catch { /* the next start just has less to repair */ }
  }

  journalAdd(dir) {
    this._journal.add(dir);
    this.saveJournal();
  }

  journalRemove(dir) {
    if (this._journal.delete(dir)) this.saveJournal();
  }

  /** Cancelled or failed version: run.json + log.txt stay, the partial files go to the Recycle Bin (SPEC §16). */
  async trashPartials(outDir) {
    let names;
    try { names = await fsp.readdir(outDir); } catch { return; }
    const extra = names.filter((n) => !KEEP_ON_FAIL.has(n) && !n.startsWith('partiel_'));
    if (!extra.length) return;
    // One Recycle Bin entry per version: the partial files are gathered in one folder first.
    const bin = path.join(outDir, `partiel_${path.basename(outDir)}`);
    try {
      await fsp.mkdir(bin, { recursive: true });
      for (const n of extra) {
        try { await fsp.rename(path.join(outDir, n), path.join(bin, n)); } catch { /* still in use: stays */ }
      }
      await this.trash(bin);
    } catch (e) {
      this.logLine(`partial files of ${outDir}: ${e.message}`);
    }
  }

  /** A run folder left by a quit or a crash: give it its run.json (cancelled) and drop its partial files. */
  async repairRun(dir) {
    if (!fs.existsSync(dir)) return;
    const f = path.join(dir, 'run.json');
    const read = async () => { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch { return null; } };
    let run = await read();
    if (!run && fs.existsSync(`${f}.tmp`)) {
      try { await fsp.rename(`${f}.tmp`, f); } catch { /* rewritten below */ }
      run = await read();
    }
    await fsp.rm(`${f}.tmp`, { force: true }).catch(() => {});
    if (!run || typeof run !== 'object') {
      const runId = path.basename(dir);
      const nodeId = path.basename(path.dirname(dir));
      run = {
        runId, nodeId, type: null, mode: null, status: 'cancelled', hash: null, params: {}, started: null,
        finished: Date.now(), outputs: {}, model: null, error: null, notes: this.tr('quitNote'),
        log: fs.existsSync(path.join(dir, 'log.txt')) ? `outputs/${nodeId}/${runId}/log.txt` : null
      };
      await writeJsonAtomic(f, run);
    }
    if (run.status !== 'done') await this.trashPartials(dir);
  }

  /**
   * At start: versions half-written by a quit or a crash are finished (run.json "cancelled", partial files to
   * the Recycle Bin); prompts that a crashed Mia left in ComfyUI are cancelled BEFORE its GPU lock is cleared.
   */
  async startupSweep() {
    this._sweeping = true;
    try {
      for (const d of [...this._journal]) {
        if ([...this.jobs.values()].some((j) => j._.outDir === d)) continue;
        await this.repairRun(d).catch((e) => this.logLine(`repair ${d}: ${e.message}`));
        this.journalRemove(d);
      }
      if (!this.opts.noOrphanCheck) {
        const ids = await this.comfy.orphanPrompts();
        if (ids.length) {
          this.logLine(`prompts left by a previous Mia: ${ids.join(', ')} — cancelled`);
          await this.comfy.cancelAndWait(ids, 120000);
        }
      }
      // Mia's own temp files left in the lab by old runs (each run removes its own: patch.js release()).
      const root = this.engineRoot();
      if (!this.opts.noTempSweep && (root || this.comfy.outputDir)) {
        const dirs = {
          outputDir: this.comfy.outputDir || path.join(root, 'runtime', 'output'),
          inputDir: this.comfy.inputDir || path.join(root, 'runtime', 'input')
        };
        const { exec: E } = require('./patch');
        const freed = await E.sweepEngineTemps(dirs);
        if (freed > 0) this.logLine(`old temp files of Mia removed from the engine: ${(freed / 1048576).toFixed(1)} MB`);
      }
    } catch (e) {
      this.logLine(`startup: ${e && e.message}`);
    } finally {
      this._sweeping = false;
      try { this.lock.cleanOrphan(); } catch { /* engine root missing: reported on the first heavy job */ }
    }
  }

  // ------------------------------------------------------------ jobs
  makeJob(project, node, type, spec, lang) {
    const gpu = ['heavy', 'light', 'none'].includes(type.engine.gpu) ? type.engine.gpu : 'heavy';
    // Instances de test (MIA_NO_GPU=1) : jamais de calcul GPU, même pour un amont périmé lancé par ricochet
    // (le 17/10, un essai de « Couper » a relancé « Animer une image » en amont et démarré ComfyUI).
    if (gpu === 'heavy' && process.env.MIA_NO_GPU === '1') {
      const e = new Error(lang === 'en' ? 'GPU disabled in this test instance (MIA_NO_GPU=1).'
        : 'GPU désactivé dans cette instance de test (MIA_NO_GPU=1).');
      e.userMessage = e.message;
      throw e;
    }
    return {
      jobId: `j_${crypto.randomBytes(5).toString('hex')}`,
      projectId: project.id,
      nodeId: node.id,
      label: node.title || tl(type.label, lang),
      type: type.id,
      mode: spec.mode,
      state: 'queued',
      progress: null,
      eta: null,
      etaAt: null,
      message: this.tr('queued', null, lang),
      created: Date.now(),
      started: null,
      finished: null,
      who: undefined,
      since: undefined,
      _: {
        project, type, spec, gpu,
        labelFr: node.title || (type.label && type.label.fr) || type.id,   // the lock is read by French sessions
        abort: new AbortController(),
        active: false, holdsLock: false, wantsGpu: false, lockFile: null, qui: null,
        createdUpstream: [], run: null, runId: null, outDir: null, logFile: null, logFd: null,
        usesComfy: false, freed: false, estSec: null, expectedSec: null,
        lastEmit: 0, emitTimer: null, finalEvt: null
      }
    };
  }

  /** Queued or running job of this block with this fingerprint. */
  activeJob(projectId, nodeId, hash) {
    for (const j of this.jobs.values()) {
      if (j.projectId === projectId && j.nodeId === nodeId && j._.spec.hash === hash && !FINAL.has(j.state) && !j._.abort.signal.aborted) return j;
    }
    return null;
  }

  pub(job) {
    return {
      jobId: job.jobId, projectId: job.projectId, nodeId: job.nodeId, label: job.label, type: job.type, mode: job.mode,
      state: job.state, progress: job.progress, eta: job.eta, etaAt: job.etaAt, message: job.message,
      created: job.created, started: job.started, finished: job.finished, who: job.who, since: job.since,
      projectName: job._.project.name
    };
  }

  emitJob(job, kind, extra = {}) {
    const evt = {
      jobId: job.jobId, projectId: job.projectId, nodeId: job.nodeId, kind, state: job.state,
      progress: job.progress ?? null, message: job.message || '', eta: job.eta ?? null, etaAt: job.etaAt ?? null,
      label: job.label, type: job.type, mode: job.mode, ...extra
    };
    if (job.who) { evt.who = job.who; evt.since = job.since; }
    if (FINAL.has(kind)) job._.finalEvt = evt;
    job._.lastEmit = Date.now();
    this.send('engine:event', evt);
    this.emit('event', evt);
    this.pushStatusSoon();
  }

  setWaitingMessage(job, msg) {
    if (job.message === msg) return;
    job.message = msg;
    this.emitJob(job, 'queued');
  }

  enqueue(job) {
    this.jobs.set(job.jobId, job);
    this.order.push(job.jobId);
    this.emitJob(job, 'queued');
  }

  retire(job) {
    if (!this.jobs.has(job.jobId)) return;
    this.jobs.delete(job.jobId);
    this.order = this.order.filter((id) => id !== job.jobId);
    this.finished.push(job);
    const now = Date.now();
    this.finished = this.finished.filter((j) => now - (j.finished || now) < KEEP_FINISHED_MS).slice(-KEEP_FINISHED);
  }

  jobList() {
    const now = Date.now();
    this.finished = this.finished.filter((j) => now - (j.finished || now) < KEEP_FINISHED_MS);
    return [...this.finished, ...this.order.map((id) => this.jobs.get(id)).filter(Boolean)]
      .sort((a, b) => a.created - b.created)
      .map((j) => this.pub(j));
  }

  lightActive() {
    let n = 0;
    for (const j of this.jobs.values()) if (j._.active && j._.gpu !== 'heavy') n++;
    return n;
  }

  depState(job) {
    let waiting = null;
    for (const d of job._.spec.deps) {
      if (d.state === 'done') continue;
      if (d.state === 'error') return { failed: d };
      if (d.state === 'cancelled') return { failed: d, cancelled: true };
      waiting = waiting || d;
    }
    return { waiting };
  }

  /** A job that ends without having run (cancelled while queued, upstream failed). No run.json: it never started. */
  finishEarly(job, state, message) {
    job._.abort.abort();
    job.state = state;
    job.message = message;
    job.finished = Date.now();
    this.emitJob(job, state === 'error' ? 'error' : 'cancelled', state === 'error' ? { error: message } : {});
    this.retire(job);
  }

  /**
   * Start whatever may start, in FIFO order:
   * - one heavy job at a time (it then waits for the GPU lock and for running light jobs to end);
   * - light/none jobs, max 2, never while a heavy job holds (or is about to take) the GPU.
   * The catalog decides what is heavy (`engine.gpu`): composite (torch on CUDA) is, and takes the lock.
   */
  pump() {
    if (this._disposed) return;
    const active = [...this.jobs.values()].filter((j) => j._.active);
    let heavyActive = active.some((j) => j._.gpu === 'heavy');
    let lights = active.filter((j) => j._.gpu !== 'heavy').length;
    let heavyGate = active.some((j) => j._.gpu === 'heavy' && (j._.holdsLock || j._.wantsGpu));

    for (const id of [...this.order]) {
      const job = this.jobs.get(id);
      if (!job || job._.active || job.state !== 'queued') continue;
      const dep = this.depState(job);
      if (dep.failed) {
        const name = dep.failed.label;
        this.finishEarly(job, dep.cancelled ? 'cancelled' : 'error', this.tr(dep.cancelled ? 'upCancelled' : 'upFailed', { name }));
        continue;
      }
      if (dep.waiting) { this.setWaitingMessage(job, this.tr('waitDep', { name: dep.waiting.label })); continue; }
      if (job._.gpu === 'heavy') {
        if (heavyActive) { this.setWaitingMessage(job, this.tr('waitHeavy')); continue; }
        heavyActive = true;
        // It wants the GPU right away: no light job may slip in behind it (released if it has to wait for another app).
        job._.wantsGpu = true;
        heavyGate = true;
        this.start(job);
      } else {
        if (heavyGate) { this.setWaitingMessage(job, this.tr('waitHeavy')); continue; }
        if (lights >= MAX_LIGHT) { this.setWaitingMessage(job, this.tr('queued')); continue; }
        lights++;
        this.start(job);
      }
    }
    this.pushStatusSoon();
  }

  start(job) {
    job._.active = true;
    this.execute(job)
      .catch((e) => this.logLine(`execute ${job.jobId}: ${e && e.stack ? e.stack : e}`))
      .finally(() => {
        job._.active = false;
        this.retire(job);
        this.pump();
      });
  }

  loadExecutor(name) {
    if (this._exec.has(name)) return this._exec.get(name);
    const file = path.join(this.executorsDir, `${name}.js`);
    if (!/^[\w-]+$/.test(String(name)) || !fs.existsSync(file)) throw new Error(this.tr('noExecutor', { name }));
    let mod;
    try {
      mod = require(file);
    } catch (e) {
      throw new Error(this.tr('badExecutor', { name, msg: e.message }));
    }
    if (!mod || typeof mod.run !== 'function') throw new Error(this.tr('badExecutor', { name, msg: 'run()' }));
    this._exec.set(name, mod);
    return mod;
  }

  /** Inputs as files, from the project's folder as it is NOW (paths are rebuilt from their project-relative form). */
  async materialize(job) {
    const J = job._;
    const dir = J.project.dir;
    const out = {};
    for (const inp of J.type.inputs || []) {
      const ref = J.spec.inputRefs[inp.id];
      if (ref === undefined) continue;
      const one = (r) => {
        let v;
        if (r.static) {
          v = { ...r.static, abs: path.resolve(dir, r.static.rel) };
          if (!fs.existsSync(v.abs)) throw new Error(this.tr('fileMissing', { file: v.name }));
        } else if (r.text) {
          return { ...r.text };
        } else {
          const run = r.run || (r.job && r.job._.run);
          const name = r.job ? r.job.label : r.run && r.run.nodeId;
          if (!run) throw new Error(this.tr('upFailed', { name }));
          const o = run.outputs && run.outputs[r.port];
          if (!o) throw new Error(this.tr('noSuchOutput', { name, port: r.port }));
          v = {
            abs: path.join(dir, ...String(o.path).split('/')), rel: o.path, kind: o.kind, meta: o.meta || null,
            poster: o.poster ? path.join(dir, ...String(o.poster).split('/')) : null, posterRel: o.poster || null,
            runId: run.runId, nodeId: run.nodeId
          };
          if (!fs.existsSync(v.abs)) throw new Error(this.tr('fileMissing', { file: path.basename(v.abs) }));
        }
        if (v.kind && !portAccepts(inp.type, v.kind)) {
          throw new Error(this.tr('wrongKind', { port: tl(inp.label, this.lang()),
            expected: this.tr(kindKey(inp.type)), got: this.tr(kindKey(v.kind)) }));
        }
        return v;
      };
      out[inp.id] = Array.isArray(ref) ? ref.map(one) : one(ref);
    }
    return out;
  }

  // ------------------------------------------------------------ GPU gate
  /**
   * Take the lab's lock for a heavy job. While someone else holds it (or another session's prompt runs in
   * ComfyUI), the job shows "GPU occupé par …" and retries every 15 s. Returns our `qui`; the lock file taken
   * is kept in J.lockFile, so renew/release always touch that file even if prefs.engineRoot changes meanwhile.
   */
  async acquireGpu(job, minutes) {
    const J = job._;
    const signal = J.abort.signal;
    const qui = `Mia : ${J.labelFr} (${J.project.name})`.slice(0, 120);
    J.qui = qui;
    let lastWho = null;
    let comfySince = null;
    for (;;) {
      if (signal.aborted) throw abortError(this.tr('cancelled'));
      if (!this._sweeping) this.lock.cleanOrphan();   // not before a crashed Mia's prompts are gone
      const info = this.lock.readLock();
      let other = info && !this.lock.isStale(info) && !this.lock.owns(info, qui) ? info : null;
      if (!other && this.opts.checkComfyQueue !== false && (await this.comfy.busyOther())) {
        comfySince = comfySince || Date.now();
        other = { qui: this.tr('comfyOther'), debut: comfySince / 1000, minutes: null };
      } else if (!other) comfySince = null;

      if (other) {
        J.wantsGpu = false;
        const who = String(other.qui || this.tr('otherSession'));
        const since = Math.round((+other.debut || Date.now() / 1000) * 1000);
        if (job.state !== 'waiting-gpu' || who !== lastWho) {
          lastWho = who;
          job.state = 'waiting-gpu';
          job.who = who;
          job.since = since;
          const at = hhmm(since / 1000);
          job.message = other.minutes ? this.tr('gpuBusyMin', { who, at, minutes: Math.round(+other.minutes) }) : this.tr('gpuBusy', { who, at });
          this.emitJob(job, 'waiting-gpu');
          this.pump();                      // small jobs may run meanwhile
        }
        await sleep(this.retryMs, signal);
        continue;
      }

      // Free: block new light jobs, let the running ones end, then take it.
      J.wantsGpu = true;
      if (this.lightActive() > 0) {
        if (job.state !== 'queued' || job.message !== this.tr('waitLight')) {
          job.state = 'queued';
          job.who = undefined;
          job.since = undefined;
          job.message = this.tr('waitLight');
          this.emitJob(job, 'queued');
        }
        await sleep(Math.min(this.retryMs, 1000), signal);
        continue;
      }
      let r;
      try {
        r = this.lock.take(qui, minutes);
      } catch (e) {
        if (e.code === 'ENOLOCKDIR') {
          // no engine at all on this PC: say how to set one up, not « folder not found »
          if (!this.opts.lockPath && !this.engineRoot()) throw new Error(places.noEngine(this.lang()));
          throw new Error(this.tr('lockDir', { dir: e.dir }));
        }
        throw e;
      }
      if (!r.ok) continue;                  // lost a race: the next turn shows who has it
      J.holdsLock = true;
      J.lockFile = r.file || this.lock.file();
      job.who = undefined;
      job.since = undefined;
      return qui;
    }
  }

  // ------------------------------------------------------------ timings / ETA
  /** type|mode, plus the settings that change the duration a lot (edit speed, depth detail). */
  timingKey(job) {
    const p = (job._ && job._.spec && job._.spec.params) || {};
    const extra = TIMING_PARAMS.filter((k) => p[k] != null && p[k] !== '').map((k) => `${k}=${p[k]}`);
    return [job.type, job.mode || '-', ...extra].join('|');
  }

  loadTimings() {
    try { return JSON.parse(fs.readFileSync(this.timingsFile, 'utf8')) || {}; } catch { return {}; }
  }

  /**
   * What was learned, kept in %APPDATA%\Mia\data\timings.json: the last 10 real durations (`avg`, seconds) and,
   * when the executor gave an estimate for that very input, the last 10 ratios real ÷ estimated (`ratio`):
   * a 240-frame upscale is then announced from the executor's per-frame estimate, not from an 18 s image.
   */
  learn(job, seconds) {
    if (!(seconds > 0)) return;
    const k = this.timingKey(job);
    const t = { ...(this.timings[k] || {}) };
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    t.samples = [...(Array.isArray(t.samples) ? t.samples : []), Math.round(seconds * 10) / 10].slice(-10);
    t.n = t.samples.length;
    t.avg = Math.round(mean(t.samples) * 10) / 10;
    const est = job._.estSec;
    if (est > 0) {
      const r = Math.max(0.05, Math.min(20, seconds / est));
      t.ratios = [...(Array.isArray(t.ratios) ? t.ratios : []), Math.round(r * 1000) / 1000].slice(-10);
      t.ratio = Math.round(mean(t.ratios) * 1000) / 1000;
    }
    t.last = Date.now();
    this.timings[k] = t;
    clearTimeout(this._timingsTimer);
    this._timingsTimer = setTimeout(() => {
      fsp.mkdir(path.dirname(this.timingsFile), { recursive: true })
        .then(() => writeJsonAtomic(this.timingsFile, this.timings))
        .catch(() => {});
    }, 200);
  }

  /**
   * Expected duration (seconds) of this job, for the ETA and the minutes announced in the GPU lock: the
   * executor's estimate for these inputs and settings × the learned ratio; without an executor estimate, the
   * mean of past runs; else the catalog's first-run figure. Also sets J.estSec (what the ratio is learned on).
   */
  async expectedSeconds(job, exec, inputs) {
    const J = job._;
    let est = null;
    if (exec && typeof exec.estimate === 'function') {
      try {
        const m = await exec.estimate({
          type: J.type, params: clone(J.spec.params), mode: job.mode, inputs,
          model: (k) => (Object.prototype.hasOwnProperty.call(J.spec.models, k) ? J.spec.models[k] : null)
        });
        if (Number.isFinite(+m) && +m > 0) est = +m * 60;
      } catch { /* no estimate */ }
    }
    J.estSec = est;
    const t = this.timings[this.timingKey(job)];
    if (est) return est * (t && t.ratio > 0 ? t.ratio : 1);
    if (t && t.avg > 0) return t.avg;
    const d = DEFAULT_MINUTES[`${job.type}|${job.mode}`] || DEFAULT_MINUTES[job.type];
    return d ? d * 60 : null;
  }

  /** Seconds left: the executor's ETA wins; else extrapolate progress, blended with what we expected. */
  etaFor(job) {
    const J = job._;
    const el = (Date.now() - (job.started || Date.now())) / 1000;
    const expected = J.expectedSec || null;
    const p = job.progress;
    if (p != null && p > 0.02 && el > 2) {
      const ex = (el * (1 - p)) / p;
      if (!expected) return ex;
      const w = Math.min(1, p / 0.3);
      return w * ex + (1 - w) * Math.max(0, expected - el);
    }
    return expected ? Math.max(0, expected - el) : null;
  }

  // ------------------------------------------------------------ executor context
  onProgress(job, p, msg, eta) {
    if (job.state !== 'running') return;
    const J = job._;
    if (p === null) job.progress = null;
    else if (typeof p === 'number' && Number.isFinite(p)) job.progress = Math.max(0, Math.min(1, p));
    const newMsg = msg != null && msg !== '' && String(msg) !== job.message;
    if (newMsg) job.message = String(msg);
    const e = typeof eta === 'number' && Number.isFinite(eta) ? Math.max(0, eta) : this.etaFor(job);
    job.eta = e != null ? Math.round(e) : null;
    job.etaAt = job.eta != null ? Date.now() + job.eta * 1000 : null;
    // ≤ 4 events/s, but a new message or the end always goes out; a trailing timer sends the last value.
    if (newMsg || p === 1 || Date.now() - J.lastEmit >= 250) {
      clearTimeout(J.emitTimer);
      J.emitTimer = null;
      this.emitJob(job, 'progress');
    } else if (!J.emitTimer) {
      J.emitTimer = setTimeout(() => { J.emitTimer = null; if (job.state === 'running') this.emitJob(job, 'progress'); }, 250);
    }
  }

  onPreview(job, abs) {
    if (job.state !== 'running' || !abs) return;
    const dir = job._.project.dir;
    const full = path.resolve(abs);
    this.emitJob(job, 'preview', { preview: inside(dir, full) ? toSlash(path.relative(dir, full)) : full });
  }

  /** ComfyUI is being launched for a running job: say so instead of a frozen bar. */
  onComfyState() {
    if (this.comfy.state === 'starting') {
      for (const j of this.jobs.values()) {
        if (j.state === 'running' && j._.usesComfy) { j.message = this.tr('comfyStarting'); this.emitJob(j, 'progress'); }
      }
    }
    this.pushStatusSoon();
  }

  /** One line in the job's log.txt (held open during the run). */
  jobLog(job, line) {
    const J = job._;
    const text = `[${hms()}] ${line}\n`;
    try {
      if (J.logFd != null) fs.writeSync(J.logFd, text);
      else if (J.logFile) fs.appendFileSync(J.logFile, text);
    } catch { /* best effort */ }
  }

  closeLog(job) {
    const J = job._;
    if (J.logFd == null) return;
    try { fs.closeSync(J.logFd); } catch { /* already closed */ }
    J.logFd = null;
  }

  /** The comfy client seen by one job: its signal, progress and preview are plugged in by default. */
  boundComfy(job, { signal, progress, outDir }) {
    const c = this.comfy;
    const J = job._;
    const only = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined));
    let n = 0;
    let last = 0;
    let prev = null;
    const onPreview = (buf, { format } = {}) => {
      const now = Date.now();
      if (now - last < 1000) return;
      last = now;
      const dir = path.join(outDir, '_preview');
      const file = path.join(dir, `p${++n}.${format === 'png' ? 'png' : 'jpg'}`);   // a new name: no stale cache in the UI
      fsp.mkdir(dir, { recursive: true })
        .then(() => fsp.writeFile(file, buf))
        .then(() => {
          if (prev) fsp.rm(prev, { force: true }).catch(() => {});
          prev = file;
          this.onPreview(job, file);
        })
        .catch(() => {});
    };
    const use = () => { J.usesComfy = true; };
    return {
      get url() { return c.url; },
      get outputDir() { return c.outputDir; },
      get inputDir() { return c.inputDir; },
      get clientId() { return c.clientId; },
      ensure: (o) => { use(); return c.ensure(o); },
      upload: (abs, o) => { use(); return c.upload(abs, { signal, ...only(o) }); },
      submit: (graph, o) => { use(); return c.submit(graph, { signal, onProgress: progress, onPreview, label: job.label, ...only(o) }); },
      files: (outputs) => c.files(outputs),
      download: (file, dst, o) => c.download(file, dst, { signal, ...only(o) }),
      objectInfo: (cls) => c.objectInfo(cls),
      models: (folder) => c.models(folder),
      stats: () => c.stats(),
      queue: () => c.queue(),
      cancel: (id) => c.cancel(id),
      status: () => c.status()
    };
  }

  /**
   * SPEC §16: a Python GPU job of Mia (cutout, composite…) cannot reclaim what ComfyUI keeps in VRAM. Right
   * before it starts — Mia holding the lab's lock, ComfyUI's queue empty — ComfyUI is asked to give it back.
   */
  async freeVramForPython(job) {
    const J = job._;
    if (!J.holdsLock || J.freed || this.opts.noComfyFree) return;
    J.freed = true;
    try {
      if (typeof this.comfy.free === 'function' && (await this.comfy.free())) this.jobLog(job, 'VRAM de ComfyUI rendue (POST /free)');
    } catch { /* the job runs anyway */ }
  }

  /**
   * x.ensureLora(paramKey): makes the LoRA chosen in that setting visible to ComfyUI (placed in
   * models\loras\mia\ by the scanner, SPEC §12.3) → { comfyName } | null when no LoRA is chosen.
   */
  async ensureLora(job, key = 'lora', { signal } = {}) {
    const J = job._;
    const m = Object.prototype.hasOwnProperty.call(J.spec.models, key) ? J.spec.models[key] : null;
    if (!m) return null;
    const name = tl(m.label, this.lang()) || m.file || m.id || key;
    const fn = this.ctx.models && this.ctx.models.ensureLora;
    let r = null;
    if (typeof fn === 'function') {
      this.onProgress(job, job.progress, this.tr('loraPrep'));
      let shown = -1;
      r = await fn.call(this.ctx.models, m, {
        signal,
        onProgress: (p) => {
          const pc = Math.round(Math.max(0, Math.min(1, +p || 0)) * 100);
          if (pc !== shown) { shown = pc; this.onProgress(job, job.progress, this.tr('loraPrepP', { p: pc })); }
        }
      });
    } else {
      const known = m.placed || (m.comfy && m.comfy.name);   // already in ComfyUI's models\loras
      if (known) r = { comfyName: known };
    }
    if (signal && signal.aborted) throw abortError(this.tr('cancelled'));
    if (r && r.ok === false && r.error) throw new Error(r.error);
    if (!r || !r.comfyName) throw new Error(this.tr('loraFailed', { name }));
    try { if (typeof this.comfy.invalidateModels === 'function') this.comfy.invalidateModels('loras'); } catch { /* cache only */ }
    this.jobLog(job, `LoRA : ${r.comfyName}`);
    return r;
  }

  makeX(job, { runId, outDir, inputs }) {
    const J = job._;
    const spec = J.spec;
    const signal = J.abort.signal;
    const log = (line) => this.jobLog(job, line);
    const progress = (p, msg, eta) => this.onProgress(job, p, msg, eta);
    const preview = (abs) => this.onPreview(job, abs);
    const only = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined));
    return {
      projectId: job.projectId,
      projectDir: J.project.dir,
      nodeId: job.nodeId,
      runId,
      type: J.type,
      params: clone(spec.params),
      mode: job.mode,
      inputs,
      outDir,
      engineRoot: this.engineRoot(),
      notes: spec.notes.slice(),
      model: (key) => (Object.prototype.hasOwnProperty.call(spec.models, key) ? spec.models[key] : null),
      ensureLora: (key = 'lora') => this.ensureLora(job, key, { signal }),
      progress,
      preview,
      signal,
      comfy: this.boundComfy(job, { signal, progress, outDir }),
      py: {
        run: async (task, payload, o) => {
          await this.freeVramForPython(job);
          return this.py.run(task, payload,
            { cwd: outDir, signal, onProgress: progress, onPreview: preview, onLog: log, ...only(o) });
        }
      },
      ffmpeg: this.ffmpeg,
      log,
      lang: this.lang()
    };
  }

  // ------------------------------------------------------------ execution
  async execute(job) {
    const J = job._;
    const signal = J.abort.signal;
    let qui = null;
    let renew = null;
    let ended = false;
    let final = null;                                            // [kind, extra]: sent once everything is tidy
    try {
      if (signal.aborted) throw abortError(this.tr('cancelled'));
      const exec = this.loadExecutor(J.type.engine.executor);   // fails fast, before waiting for the GPU
      await this.refreshProject(job);                            // renamed while queued: followed by id
      let inputs = await this.materialize(job);
      const sec = await this.expectedSeconds(job, exec, inputs);
      const minutes = J.gpu === 'heavy' ? Math.max(1, Math.ceil(((sec || 600) / 60) * 1.2)) : null;
      if (J.gpu === 'heavy') qui = await this.acquireGpu(job, minutes);
      if (signal.aborted) throw abortError(this.tr('cancelled'));
      const before = J.project.dir;
      const dir = await this.refreshProject(job);                // the GPU wait can be long: look again
      if (dir !== before) inputs = await this.materialize(job);
      // Never create anything above the project: its folder must still be a project (project.json).
      if (!fs.existsSync(path.join(dir, 'project.json'))) throw new Error(this.tr('projectGone'));

      J.runId = makeRunId();
      J.outDir = path.join(dir, 'outputs', job.nodeId, J.runId);
      await fsp.mkdir(J.outDir, { recursive: true });
      this.journalAdd(J.outDir);
      J.logFile = path.join(J.outDir, 'log.txt');
      // Open for the whole run: Windows then refuses to move or trash the project folder under the job.
      try { J.logFd = fs.openSync(J.logFile, 'a'); } catch { J.logFd = null; }
      for (const n of J.spec.notes) this.jobLog(job, n);
      J.expectedSec = sec || null;
      job.state = 'running';
      job.started = Date.now();
      job.progress = null;
      job.who = undefined;
      job.since = undefined;
      job.message = this.tr('starting');
      job.eta = J.expectedSec ? Math.round(J.expectedSec) : null;
      job.etaAt = job.eta != null ? Date.now() + job.eta * 1000 : null;
      this.emitJob(job, 'start');

      if (qui) {
        renew = setInterval(() => {
          const left = Math.max(2, Math.ceil(minutes - (Date.now() - job.started) / 60000));
          const r = this.lock.renew(qui, left, J.lockFile);
          if (!r.ok) this.logLine(`lock renew refused for ${qui}: ${r.info ? r.info.qui : r.error && r.error.message}`);
        }, this.renewMs);
      }

      const x = this.makeX(job, { runId: J.runId, outDir: J.outDir, inputs });
      const res = (await exec.run(x)) || {};
      const run = await this.finalize(job, x, res);
      J.run = run;
      ended = true;
      job.state = 'done';
      job.progress = 1;
      job.eta = 0;
      job.etaAt = Date.now();
      job.message = this.tr('done');
      job.finished = Date.now();
      this.learn(job, (job.finished - job.started) / 1000);
      final = ['done', { run, ...(run.notes ? { notes: run.notes } : {}) }];
    } catch (err) {
      const cancelled = signal.aborted || !!(err && (err.name === 'AbortError' || err.cancelled));
      const msg = cancelled ? this.tr('cancelled') : this.readable(err);
      let run = null;
      if (J.outDir && !(this._shut && fs.existsSync(path.join(J.outDir, 'run.json')))) {
        run = await this.writeEndedRun(job, cancelled ? 'cancelled' : 'error', cancelled ? null : msg, err)
          .catch((e) => { this.logLine(`run.json ${job.jobId}: ${e.message}`); return null; });
        ended = !!run;
        this.closeLog(job);
        await this.trashPartials(J.outDir);
      }
      if (!cancelled) this.logLine(`${job.label} (${job.jobId}): ${err && err.stack ? err.stack : err}`);
      job.state = cancelled ? 'cancelled' : 'error';
      job.message = msg;
      job.finished = Date.now();
      job.eta = null;
      job.etaAt = null;
      final = [job.state, { ...(run ? { run } : {}), ...(cancelled ? {} : { error: msg }) }];
    } finally {
      clearInterval(renew);
      this.closeLog(job);
      if (J.outDir && ended && !this._shut) this.journalRemove(J.outDir);
      if (qui) this.lock.release(qui, J.lockFile);
      J.holdsLock = false;
      J.wantsGpu = false;
      if (J.outDir) fsp.rm(path.join(J.outDir, '_preview'), { recursive: true, force: true }).catch(() => {});
      // The end is announced last: whoever reacts to it finds the lock free and the version complete.
      clearTimeout(J.emitTimer);
      if (final) this.emitJob(job, final[0], final[1]);
      this.pushStatusSoon();
    }
  }

  readable(err) {
    if (!err) return this.tr('unknownError');
    const m = String(err.message || err);
    const file = err.path ? path.basename(err.path) : '';
    if (err.code === 'ENOENT' && file) return this.tr('fileMissing', { file });
    if (err.code === 'ENOSPC') return this.tr('diskFull');
    if ((err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') && file) return this.tr('fileBusy', { file });
    if (/out of memory/i.test(m) && err.code !== 'oom') return this.tr('oom');
    return m || this.tr('unknownError');
  }

  modelName(job, fromRes) {
    if (typeof fromRes === 'string' && fromRes) return fromRes;
    const m = (fromRes && typeof fromRes === 'object' ? fromRes : null) || job._.spec.models.model || null;
    if (!m) return null;
    return tl(m.label, this.lang()) || m.file || m.id || null;
  }

  /** The planner's notes (ignored empty input…) in front of the executor's. Strings, joined by new lines. */
  mergeNotes(job, notes) {
    const mine = job._.spec.notes || [];
    if (!mine.length) return notes;
    const text = mine.join('\n');
    if (notes == null || notes === '') return text;
    if (typeof notes === 'string') return `${text}\n${notes}`;
    if (Array.isArray(notes)) return [...mine, ...notes];
    if (typeof notes === 'object') return { ...notes, text: notes.text ? `${text}\n${notes.text}` : text };
    return text;
  }

  /** Probe outputs, make posters, write run.json (SPEC §8.2.6). */
  async finalize(job, x, res) {
    const J = job._;
    const dir = J.project.dir;
    const outDir = J.outDir;
    const logFile = J.logFile;
    const rel = (abs) => toSlash(path.relative(dir, abs));
    const entries = Object.entries(res.outputs || {});
    if (!entries.length && (J.type.outputs || []).length) throw new Error(this.tr('noOutputs'));
    const outputs = {};
    for (const [port, o] of entries) {
      let abs = typeof o === 'string' ? o : o && o.abs;
      if (!abs) continue;
      abs = path.resolve(outDir, abs);
      if (!fs.existsSync(abs)) throw new Error(this.tr('outputMissing', { file: path.basename(abs) }));
      if (!inside(outDir, abs)) {               // outputs live in the run folder (SPEC §8.2.5): bring strays in
        let dst = path.join(outDir, path.basename(abs));
        if (fs.existsSync(dst)) dst = path.join(outDir, `${port}_${path.basename(abs)}`);
        await fsp.copyFile(abs, dst);
        abs = dst;
      }
      let kind = (o && o.kind) || kindOf(abs);
      let meta = (o && o.meta) || null;
      if (this.ffmpeg && typeof this.ffmpeg.probe === 'function') {
        try {
          const p = await this.ffmpeg.probe(abs);
          if (p) { if (p.kind) kind = p.kind; meta = pickMeta(p, meta); }
        } catch (e) { x.log(`probe ${path.basename(abs)}: ${e.message}`); }
      }
      try { meta = { ...(meta || {}), size: (await fsp.stat(abs)).size }; } catch { /* keep meta */ }
      let poster = null;
      if (o && o.poster && fs.existsSync(path.resolve(outDir, o.poster))) {
        poster = rel(path.resolve(outDir, o.poster));
      } else if (kind === 'video' && this.ffmpeg && typeof this.ffmpeg.poster === 'function') {
        const p = path.parse(abs);
        let dst = path.join(p.dir, `${p.name}.jpg`);
        if (dst === abs || fs.existsSync(dst)) dst = path.join(p.dir, `${p.name}_poster.jpg`);
        try {
          await this.ffmpeg.poster(abs, dst, { at: 0, width: 640 });
          if (fs.existsSync(dst)) poster = rel(dst);
        } catch (e) { x.log(`poster ${path.basename(abs)}: ${e.message}`); }
      }
      outputs[port] = { path: rel(abs), kind, meta, poster };
    }
    const run = {
      runId: J.runId, nodeId: job.nodeId, type: job.type, mode: job.mode, status: 'done', hash: J.spec.hash,
      params: J.spec.params, started: job.started, finished: Date.now(), outputs,
      model: this.modelName(job, res.model), error: null,
      log: logFile && fs.existsSync(logFile) ? rel(logFile) : null
    };
    const notes = this.mergeNotes(job, res.notes);
    if (notes != null && notes !== '') run.notes = notes;
    await writeJsonAtomic(path.join(outDir, 'run.json'), run);
    return run;
  }

  endedRunObject(job, status, error, extraNote) {
    const J = job._;
    const logFile = J.logFile;
    const run = {
      runId: J.runId, nodeId: job.nodeId, type: job.type, mode: job.mode, status, hash: J.spec.hash,
      params: J.spec.params, started: job.started, finished: Date.now(), outputs: {},
      model: this.modelName(job, null), error: error || null,
      log: logFile && fs.existsSync(logFile) ? toSlash(path.relative(J.project.dir, logFile)) : null
    };
    const notes = this.mergeNotes(job, extraNote || undefined);
    if (notes != null && notes !== '') run.notes = notes;
    return run;
  }

  async writeEndedRun(job, status, error, err) {
    const J = job._;
    if (error) {
      const stack = err && err.stack && err.stack !== String(err.message) ? `\n${err.stack}` : '';
      const details = err && err.details ? `\n${JSON.stringify(err.details).slice(0, 4000)}` : '';
      this.jobLog(job, `ERREUR : ${error}${stack}${details}`);
    }
    const run = this.endedRunObject(job, status, error);
    await writeJsonAtomic(path.join(J.outDir, 'run.json'), run);
    return run;
  }

  /** App quitting: the run.json of a job cut short, written now (no promise completes after will-quit). */
  endRunSync(job) {
    const J = job._;
    if (!J.outDir || !fs.existsSync(J.outDir) || fs.existsSync(path.join(J.outDir, 'run.json'))) return;
    this.jobLog(job, this.tr('quitNote'));
    this.closeLog(job);
    writeJsonAtomicSync(path.join(J.outDir, 'run.json'), this.endedRunObject(job, 'cancelled', null, this.tr('quitNote')));
  }

  // ------------------------------------------------------------ IPC actions
  /**
   * Plans run one after the other: two clicks in a row on blocks sharing a stale upstream block must see each
   * other's jobs, or that block would be computed twice.
   */
  run(payload) {
    const p = (this._planQueue || Promise.resolve()).then(() => this._run(payload));
    this._planQueue = p.catch(() => {});
    return p;
  }

  async _run(payload) {
    const { projectId, nodeId, graph, mode } = payload || {};
    await this.refreshPrefs();
    const lang = this.lang();
    if (this._disposed) return { ok: false, error: this.tr('internal', { msg: 'shutdown' }), missing: [] };
    if (this.catalogError) return { ok: false, error: this.tr('catalog', { msg: this.catalogError }), missing: [] };
    if (!projectId || !nodeId || !graph || !Array.isArray(graph.nodes)) return { ok: false, error: this.tr('badRequest'), missing: [] };
    const project = await this.project(projectId);
    if (!project) return { ok: false, error: this.tr('projectNotFound'), missing: [] };
    const planner = new Planner(this, project, graph, lang);
    let res;
    try {
      res = await planner.request(nodeId, mode);
    } catch (e) {
      this.logLine(`plan ${nodeId}: ${e && e.stack ? e.stack : e}`);
      return { ok: false, error: this.tr('internal', { msg: e.message }), missing: [] };
    }
    if (!res.ok) return { ok: false, error: res.error, missing: res.missing || [] };
    if (!res.already) {
      for (const j of planner.newJobs) this.enqueue(j);
      this.pump();
    }
    const notes = (res.job._.spec.notes || []).slice();
    return { ok: true, jobId: res.job.jobId, ...(notes.length ? { notes } : {}) };
  }

  cancel(jobId) {
    if (jobId && typeof jobId === 'object') jobId = jobId.jobId;
    const job = this.jobs.get(jobId) || this.finished.find((j) => j.jobId === jobId);
    if (!job) return { ok: false, error: this.tr('jobNotFound') };
    if (FINAL.has(job.state)) return { ok: true };
    this.abortJob(job);
    // Upstream jobs queued only for this request go too, unless another live job still needs them
    // (deepest last: a job's own upstream is checked after it).
    for (const up of [...job._.createdUpstream].reverse()) {
      if (FINAL.has(up.state) || up._.abort.signal.aborted) continue;
      const needed = [...this.jobs.values()].some((o) => o !== up && !o._.abort.signal.aborted && o._.spec.deps.includes(up));
      if (!needed) this.abortJob(up);
    }
    this.pump();
    return { ok: true };
  }

  abortJob(job) {
    job._.abort.abort();
    if (!job._.active) this.finishEarly(job, 'cancelled', this.tr('cancelled'));
    // An active job ends through execute(): the executor sees the signal, the GPU wait wakes up.
  }

  /** Jobs of this project still queued or running (the store asks before moving or trashing its folder). */
  projectBusy(projectId) {
    for (const j of this.jobs.values()) if (j.projectId === projectId && !FINAL.has(j.state)) return true;
    return false;
  }

  /** Cancel every job of a project and wait until they are over (15 s at most). → {ok, cancelled} */
  async cancelProject(projectId, ms = 15000) {
    const mine = [...this.jobs.values()].filter((j) => j.projectId === projectId && !FINAL.has(j.state));
    for (const j of mine) this.abortJob(j);
    this.pump();
    const until = Date.now() + ms;
    while (this.projectBusy(projectId) && Date.now() < until) await sleep(100);
    return { ok: !this.projectBusy(projectId), cancelled: mine.length };
  }

  /** What a finished job produced, with absolute paths (assistants' bridge). */
  finalResult(job) {
    const J = job._;
    const evt = J.finalEvt || {};
    const run = J.run || evt.run || null;
    const outputs = {};
    if (run && run.outputs) {
      for (const [port, o] of Object.entries(run.outputs)) {
        if (!o || !o.path) continue;
        outputs[port] = {
          abs: path.join(J.project.dir, ...String(o.path).split('/')), rel: o.path, kind: o.kind, meta: o.meta || null,
          poster: o.poster ? path.join(J.project.dir, ...String(o.poster).split('/')) : null
        };
      }
    }
    return {
      ok: job.state === 'done', jobId: job.jobId, projectId: job.projectId, nodeId: job.nodeId, state: job.state,
      message: job.message, ...(job.state === 'error' ? { error: job.message } : {}),
      runId: run ? run.runId : null, run, outputs, ...(run && run.notes ? { notes: run.notes } : {})
    };
  }

  /**
   * Wait for the end of a job (by jobId, or the newest job of a block by nodeId). → final result, or
   * {ok:false, timeout:true, job} after timeoutS (≤ 600 s).
   */
  wait(target, timeoutS, opts) {
    if (target && typeof target === 'object') {          // wait({jobId|nodeId, timeoutS, projectId})
      opts = opts || { projectId: target.projectId };
      timeoutS = timeoutS ?? target.timeoutS;
      target = target.jobId || target.nodeId;
    }
    const projectId = opts && opts.projectId;
    const ofNode = (j) => j.nodeId === target && (!projectId || j.projectId === projectId);
    let job = this.jobs.get(target) || this.finished.find((j) => j.jobId === target) || null;
    if (!job) {
      job = [...this.jobs.values()].filter(ofNode).sort((a, b) => b.created - a.created)[0]
        || [...this.finished].reverse().find(ofNode) || null;
    }
    if (!job) return Promise.resolve({ ok: false, error: this.tr('jobNotFound') });
    if (FINAL.has(job.state)) return Promise.resolve(this.finalResult(job));
    const s = Math.max(1, Math.min(600, Number(timeoutS) || 600));   // SPEC §13.2: ≤ 600 s
    return new Promise((resolve) => {
      const on = (evt) => {
        if (evt.jobId !== job.jobId || !FINAL.has(evt.kind)) return;
        clearTimeout(t);
        this.off('event', on);
        resolve(this.finalResult(job));
      };
      const t = setTimeout(() => {
        this.off('event', on);
        resolve({ ok: false, timeout: true, error: this.tr('waitTimeout', { s }), job: this.pub(job) });
      }, s * 1000);
      this.on('event', on);
    });
  }

  async runs(projectId, nodeId) {
    const project = await this.project(projectId);
    if (!project) return [];
    return this.listRuns(project.dir, nodeId);
  }

  async deleteRun(projectId, nodeId, runId) {
    const project = await this.project(projectId);
    if (!project) return { ok: false, error: this.tr('projectNotFound') };
    if (!safeSeg(nodeId) || !safeSeg(runId)) return { ok: false, error: this.tr('runNotFound') };
    const dir = path.join(project.dir, 'outputs', nodeId, runId);
    if (!fs.existsSync(dir)) return { ok: false, error: this.tr('runNotFound') };
    for (const j of this.jobs.values()) {
      if (j.projectId === projectId && j._.runId === runId && j.nodeId === nodeId && !FINAL.has(j.state)) return { ok: false, error: this.tr('runBusy') };
    }
    try {
      await this.trash(dir);                  // Recycle Bin, never a hard delete
      return { ok: true };
    } catch (e) {
      return { ok: false, error: this.tr('deleteFailed', { msg: e.message }) };
    }
  }

  async startComfy() {
    await this.refreshPrefs();
    const p = this.comfy.ensure({ launch: true });
    const r = await Promise.race([p.then(() => 'ok', (e) => e), sleep(1500).then(() => 'pending')]);
    this.pushStatus();
    if (r instanceof Error) return { ok: false, error: r.message, state: this.comfy.state };
    p.catch((e) => this.logLine(`startComfy: ${e.message}`)).finally(() => this.pushStatus());
    return { ok: true, state: this.comfy.state };
  }

  // ------------------------------------------------------------ status
  statusNow() {
    let info = null;
    try { info = this.lock.readLock(); } catch { info = null; }
    let lock = null;
    if (info && !this.lock.isStale(info)) {
      lock = {
        who: String(info.qui || ''),
        since: Math.round((+info.debut || 0) * 1000),
        depuis: info.depuis || null,
        minutes: info.minutes ?? null,
        mine: this.lock.isMine(info)
      };
    }
    let running = 0;
    let waiting = 0;
    for (const j of this.jobs.values()) {
      if (j.state === 'running') running++;
      else if (j.state === 'queued' || j.state === 'waiting-gpu') waiting++;
    }
    const g = { ...this._gpu };
    if (g.vramUsedGB != null) g.vramUsedGB = Math.max(0, g.vramTotalGB > 0 ? Math.min(g.vramUsedGB, g.vramTotalGB) : g.vramUsedGB);
    return {
      comfy: this.comfy.status(),
      gpu: { ...g, lock, busyOther: (!!lock && !lock.mine) || !!this._comfyBusyOther },
      queue: { running, waiting }
    };
  }

  async status() {
    if (Date.now() - this._lastTick > STATUS_MS) await this.tick();
    return this.statusNow();
  }

  /** One status round: ComfyUI stats (+ its queue), the lock, and nvidia-smi when ComfyUI is down. */
  tick() {
    if (this._ticking) return this._ticking;
    this._ticking = (async () => {
      await this.refreshPrefs();
      await this.comfy.refresh();
      const s = this.comfy.state === 'running' ? this.comfy.lastStats : null;
      const dev = s && s.devices && s.devices[0];
      if (dev && dev.vram_total) {
        const total = Math.round((dev.vram_total / GIB) * 10) / 10;
        let used = vramUsedGB(dev);
        if (used == null) {                   // inconsistent figures (cudaMallocAsync): ask the driver
          if (Date.now() - this._smiAt > SMI_MS) await this.smi();
          used = this._gpu.vramUsedGB != null ? Math.max(0, Math.min(this._gpu.vramUsedGB, total)) : null;
        }
        this._gpu = {
          name: String(dev.name || '').replace(/^cuda:\d+\s*/, '').replace(/\s*:\s*[\w.-]+$/, '') || this._gpu.name || null,
          vramUsedGB: used,
          vramTotalGB: total
        };
        this._comfyBusyOther = await this.comfy.busyOther();
      } else {
        this._comfyBusyOther = false;
        if (Date.now() - this._smiAt > SMI_MS) await this.smi();
      }
      this._lastTick = Date.now();
      this.pushStatus();
    })().catch((e) => this.logLine(`tick: ${e.message}`)).finally(() => { this._ticking = null; });
    return this._ticking;
  }

  /** nvidia-smi, read-only, as a fallback indicator when ComfyUI is not there to tell (or tells nonsense). */
  smi() {
    this._smiAt = Date.now();
    return new Promise((resolve) => {
      execFile(NVIDIA_SMI, ['--query-gpu=name,memory.used,memory.total', '--format=csv,noheader,nounits'],
        { windowsHide: true, timeout: 5000 }, (err, stdout) => {
          if (!err) {
            const [name, used, total] = String(stdout).split(/\r?\n/)[0].split(',').map((s) => s.trim());
            if (name && +total > 0) {
              this._gpu = {
                name,
                vramUsedGB: Math.max(0, Math.min(Math.round((+used / 1024) * 10) / 10, Math.round((+total / 1024) * 10) / 10)),
                vramTotalGB: Math.round((+total / 1024) * 10) / 10
              };
            }
          }
          resolve();
        });
    });
  }

  pushStatus() {
    const s = this.statusNow();
    const json = JSON.stringify(s);
    if (json === this._lastStatusJson) return;
    this._lastStatusJson = json;
    this.send('engine:status', s);
    this.emit('status', s);
  }

  pushStatusSoon() {
    if (this._statusTimer) return;
    this._statusTimer = setTimeout(() => { this._statusTimer = null; this.pushStatus(); }, 50);
  }

  // ------------------------------------------------------------ lifecycle
  /** Subscribe to engine events (same objects as engine:event). → unsubscribe function. */
  onEvent(fn) {
    this.on('event', fn);
    return () => this.off('event', fn);
  }

  install() {
    const { ipcMain, app } = this.ctx;
    // Half-written versions of a previous session, a crashed Mia's prompts, then its orphan lock (pid dead).
    this.ready = this.startupSweep();

    if (ipcMain && typeof ipcMain.handle === 'function') {
      const handle = (channel, fn, fallback) => ipcMain.handle(channel, async (_e, ...args) => {
        try {
          return await fn(...args);
        } catch (e) {
          this.logLine(`${channel}: ${e && e.stack ? e.stack : e}`);
          return typeof fallback === 'function' ? fallback(e) : fallback;
        }
      });
      // Positional arguments as in SPEC §5; an object form is accepted too.
      const ids = (a, b, c) => (a && typeof a === 'object' ? [a.projectId, a.nodeId, a.runId] : [a, b, c]);
      handle('engine:status', () => this.status(), () => this.statusNow());
      handle('engine:run', (p) => this.run(p), (e) => ({ ok: false, error: this.tr('internal', { msg: e.message }), missing: [] }));
      handle('engine:cancel', (id) => this.cancel(id && typeof id === 'object' ? id.jobId : id), (e) => ({ ok: false, error: e.message }));
      handle('engine:jobs', () => this.jobList(), []);
      handle('engine:startComfy', () => this.startComfy(), (e) => ({ ok: false, error: e.message, state: this.comfy.state }));
      handle('engine:runs', (a, b) => { const [p, n] = ids(a, b); return this.runs(p, n); }, []);
      handle('engine:deleteRun', (a, b, c) => { const [p, n, r] = ids(a, b, c); return this.deleteRun(p, n, r); },
        (e) => ({ ok: false, error: this.tr('deleteFailed', { msg: e.message }) }));
      // the Finish looks present on this PC: [{id, exists}] — the interface hides the absent ones (« Etalo » lives
      // in the engine folder and is not on every PC)
      handle('engine:looks', () => this.looks(), []);
    }
    if (app && typeof app.on === 'function') app.on('will-quit', () => this.shutdown());

    if (!this.opts.noStatusPoll) {
      this._timer = setInterval(() => { if (this.windowOpen()) this.tick(); }, STATUS_MS);
      if (this._timer.unref) this._timer.unref();
      setTimeout(() => { if (this.windowOpen()) this.tick(); }, 500).unref?.();
    }
    // ctx.engine = this instance (SPEC §13 bridge, main.js): run(p), cancel(jobId), jobList(), wait(jobId|nodeId,
    // timeoutS), status(), runs(), projectBusy(id), cancelProject(id), onEvent(fn) / on('event'). main.js
    // already exposes it through a getter (what register() returns); a plain ctx (tests) gets it here.
    const d = Object.getOwnPropertyDescriptor(this.ctx, 'engine');
    if (!d || d.writable || d.set) { try { this.ctx.engine = this; } catch { /* read-only: main.js serves it */ } }
    return this;
  }

  /**
   * App quitting (synchronous): stop our jobs, write their run.json, cancel our ComfyUI prompts and wait for
   * ComfyUI to confirm BEFORE the GPU lock goes (or hand the lock to a helper that waits for it), and stop the
   * ComfyUI Mia launched if nobody else needs it. A ComfyUI Mia did not launch is never stopped. Partial files
   * of the cut runs go to the Recycle Bin at the next start (journal).
   */
  shutdown() {
    if (this._shut) return;
    this._shut = true;
    this._disposed = true;
    clearInterval(this._timer);
    const active = [...this.jobs.values()].filter((j) => j._.active);
    for (const j of this.jobs.values()) { try { j._.abort.abort(); } catch { /* already */ } }
    try { this.py.killAllSync(); } catch { /* best effort */ }
    for (const j of active) { try { this.endRunSync(j); } catch { /* best effort */ } }
    let otherHolds = false;
    try {
      const info = this.lock.readLock();
      otherHolds = !!info && !this.lock.isStale(info) && !this.lock.isMine(info);
    } catch { /* unreadable: assume free */ }
    const holder = active.find((j) => j._.holdsLock && j._.qui);
    let handedOff = false;
    try {
      const r = this.comfy.shutdownSync({
        lockHeldByOther: otherHolds,
        lock: holder ? { file: holder._.lockFile || this.lock.file(), qui: holder._.qui } : null,
        handOver: holder ? (pid) => this.lock.handOver(holder._.qui, pid, holder._.lockFile || undefined) : null
      });
      handedOff = !!(r && r.handedOff);
      if (handedOff) this.logLine(`quit: ComfyUI still finishing our prompt, lock handed to helper ${r.helperPid}`);
    } catch { /* best effort */ }
    if (handedOff) return;                    // the helper frees the lock once ComfyUI has let go
    for (const j of this.jobs.values()) if (j._.qui && j._.holdsLock) this.lock.release(j._.qui, j._.lockFile || undefined);
    try {
      const info = this.lock.readLock();
      if (info && this.lock.isMine(info)) this.lock.release(info.qui);
    } catch { /* nothing to free */ }
  }

  /** Tests: stop timers without touching processes. */
  dispose() {
    this._disposed = true;
    clearInterval(this._timer);
    clearTimeout(this._statusTimer);
    clearTimeout(this._timingsTimer);
    for (const j of this.jobs.values()) { try { j._.abort.abort(); } catch { /* already */ } }
  }
}

/** main.js: require('./engine').register(ctx) — after scanner.register(ctx), which fills ctx.models. → the Engine (= ctx.engine). */
function register(ctx) {
  return new Engine(ctx).install();
}

module.exports = {
  register, Engine, Planner,
  _internals: { stable, portAccepts, articleFr, articleEn, makeRunId, pickMode, currentRun, shownParam, vramUsedGB }
};
