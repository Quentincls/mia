'use strict';
// ComfyUI client of Mia (SPEC §8.3; protocol notes in engine.md §1, §5, §6 and tech.md §7.3).
//
// - Reuses the lab's instance when it answers (checked through /system_stats argv), launches exactly the lab's
//   command only when a job needs it and nothing answers, and never starts a second instance.
// - Talks HTTP + WebSocket with Node 22's native fetch / WebSocket / FormData: no npm package.
// - Uses its own client_id (kept in %APPDATA%\Mia\data\comfy-client.json, so the prompts of a Mia that crashed
//   can be recognised and cancelled at the next start) and creates each prompt_id itself (canonical lowercase
//   UUID), so progress events are routed to Mia only and cannot race the POST response.
// - Cancels with POST /api/jobs/<id>/cancel — never /interrupt without an id. POST /free only through free(),
//   while Mia holds the GPU lock and ComfyUI's queue is empty (SPEC §16, engine.md §1.4.6).
// - Quitting during one of its prompts: cancel, wait for ComfyUI to confirm (5 s), and if it is still busy hand
//   the GPU lock to a small detached helper that frees it only once ComfyUI has let go (shutdownSync).

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const places = require('../places');

// ------------------------------------------------------------------ strings
// Main-process strings, picked at call time from prefs.lang (the renderer's i18n does not run here).
const STR = {
  fr: {
    notLocal: 'L’adresse du moteur doit rester sur ce PC (127.0.0.1) : {url}',
    down: 'ComfyUI ne répond pas sur {url}.',
    foreign: 'Un autre ComfyUI occupe {url} (ce n’est pas celui du moteur de Mia).',
    noPython: 'Python du moteur introuvable : {path}',
    noEngine: places.noEngine('fr'),
    noComfy: 'ComfyUI introuvable : {path}',
    exited: 'ComfyUI s’est arrêté pendant son démarrage (code {code}). Détails dans comfy.log.',
    exitedRun: 'ComfyUI s’est arrêté (code {code}).',
    timeout: 'ComfyUI n’a pas démarré en 3 minutes. Détails dans comfy.log.',
    spawn: 'Impossible de lancer ComfyUI : {msg}',
    network: 'ComfyUI ne répond plus ({msg}).',
    lost: 'Le calcul a disparu de ComfyUI (moteur redémarré ?).',
    upload: 'Envoi de « {name} » à ComfyUI refusé ({msg}).',
    noFile: 'Fichier introuvable : {path}',
    cancelled: 'Annulé',
    oom: 'Mémoire GPU insuffisante : ferme Unreal ou attends la fin de l’autre calcul, puis relance.',
    execError: 'Erreur dans « {node} » : {msg}',
    modelMissing: 'Modèle introuvable : {value}',
    valueRefused: 'Valeur refusée pour « {input} » ({node}) : {value}',
    inputMissing: 'Entrée manquante « {input} » ({node})',
    badLink: 'Branchement incorrect dans « {node} » ({input})',
    outOfRange: 'Valeur hors limites pour « {input} » ({node})',
    fileMissing: 'Fichier introuvable côté ComfyUI : {value}',
    nodeMissing: 'Nœud ComfyUI absent : « {node} ». Il n’est pas installé dans le moteur.',
    noOutputs: 'Le graphe envoyé à ComfyUI n’a aucune sortie.',
    andMore: '… et {n} autre(s)',
    refused: 'ComfyUI a refusé le calcul : {msg}',
    stQueued: 'En attente dans ComfyUI…',
    stQueuedN: 'En attente dans ComfyUI ({n} calcul(s) devant)…',
    stStart: 'Démarrage du calcul…',
    stLoad: 'Chargement du modèle…',
    stInputs: 'Lecture des entrées…',
    stPrompt: 'Lecture de la consigne…',
    stSample: 'Génération…',
    stSampleN: 'Génération : {v}/{max}',
    stDecode: 'Décodage…',
    stDecodeN: 'Décodage : {v}/{max}',
    stSave: 'Enregistrement…',
    stWork: 'Calcul…',
    stWorkN: 'Calcul : {v}/{max}'
  },
  en: {
    notLocal: 'The engine address must stay on this PC (127.0.0.1): {url}',
    down: 'ComfyUI is not answering on {url}.',
    foreign: 'Another ComfyUI is using {url} (not the one of Mia’s engine).',
    noPython: 'The engine’s Python was not found: {path}',
    noEngine: places.noEngine('en'),
    noComfy: 'ComfyUI not found: {path}',
    exited: 'ComfyUI stopped while starting (code {code}). See comfy.log.',
    exitedRun: 'ComfyUI stopped (code {code}).',
    timeout: 'ComfyUI did not start within 3 minutes. See comfy.log.',
    spawn: 'Could not launch ComfyUI: {msg}',
    network: 'ComfyUI stopped answering ({msg}).',
    lost: 'The job vanished from ComfyUI (engine restarted?).',
    upload: 'ComfyUI refused “{name}” ({msg}).',
    noFile: 'File not found: {path}',
    cancelled: 'Cancelled',
    oom: 'Not enough GPU memory: close Unreal or wait for the other job, then try again.',
    execError: 'Error in “{node}”: {msg}',
    modelMissing: 'Model not found: {value}',
    valueRefused: 'Value refused for “{input}” ({node}): {value}',
    inputMissing: 'Missing input “{input}” ({node})',
    badLink: 'Wrong connection in “{node}” ({input})',
    outOfRange: 'Value out of range for “{input}” ({node})',
    fileMissing: 'File not found by ComfyUI: {value}',
    nodeMissing: 'Missing ComfyUI node: “{node}”. It is not installed in the engine.',
    noOutputs: 'The graph sent to ComfyUI has no output.',
    andMore: '… and {n} more',
    refused: 'ComfyUI refused the job: {msg}',
    stQueued: 'Waiting in ComfyUI…',
    stQueuedN: 'Waiting in ComfyUI ({n} job(s) ahead)…',
    stStart: 'Starting…',
    stLoad: 'Loading model…',
    stInputs: 'Reading inputs…',
    stPrompt: 'Reading the prompt…',
    stSample: 'Generating…',
    stSampleN: 'Generating: {v}/{max}',
    stDecode: 'Decoding…',
    stDecodeN: 'Decoding: {v}/{max}',
    stSave: 'Saving…',
    stWork: 'Computing…',
    stWorkN: 'Computing: {v}/{max}'
  }
};

// ---------------------------------------------------------------- constants
const DEFAULT_URL = 'http://127.0.0.1:8188';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const ALT_PORTS = [8190, 8191, 8192, 8193, 8194, 8195];   // 8189 is the lab's tunnel to a rented GPU: never used
const PROBE_MS = 1500;
const START_TIMEOUT_MS = 180000;
const MODELS_TTL_MS = 60000;
const UPLOAD_LIMIT = 95 * 1024 * 1024;   // the server refuses > 100 MB (max_upload_size)
const POLL_MS = 2000;                    // /history polling when the WebSocket is down
const SAFETY_POLL_MS = 10000;            // …and a slow one even when it is up (a missed event must not hang a job)
const CANCEL_WAIT_MS = 20000;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.exr', '.gif']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v']);
const AUDIO_EXT = new Set(['.wav', '.flac', '.mp3', '.ogg', '.m4a', '.aac', '.opus']);
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.exr': 'image/x-exr', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.wav': 'audio/wav', '.flac': 'audio/flac', '.mp3': 'audio/mpeg'
};

const QUIT_CONFIRM_MS = 5000;            // quitting: how long Mia itself waits for ComfyUI to drop its prompt
const HELPER_MAX_MS = 15 * 60 * 1000;    // …then a detached helper keeps the GPU lock up to 15 min more

/**
 * Quit helper, run by Electron's binary in Node mode: cancel our prompts, then poll /queue until they are gone.
 * argv: mode ('quick' = 5 s, exit 0 when confirmed | 'long' = keeps and finally frees the lock), url, lock
 * file ('-' = none), qui, ids… A refused connection means ComfyUI is gone, and its GPU work with it.
 * Long mode refreshes the lock's `debut` every 4 min so other sessions never take it for abandoned.
 */
const QUIT_HELPER = `
const fs=require('fs');
const [mode,u,lock,qui,...ids]=process.argv.slice(1);
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const post=(p,b)=>fetch(u+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{}),signal:AbortSignal.timeout(4000)}).then(r=>r.ok,()=>false);
async function cancel(){for(const id of ids){if(!(await post('/api/jobs/'+encodeURIComponent(id)+'/cancel'))){await post('/interrupt',{prompt_id:id});await post('/queue',{delete:[id]});}}}
async function left(){try{const r=await fetch(u+'/queue',{signal:AbortSignal.timeout(3000)});const j=await r.json();const all=[...(j.queue_running||[]),...(j.queue_pending||[])].map(x=>x&&x[1]);return ids.filter(id=>all.includes(id)).length;}catch(e){return e&&e.cause&&e.cause.code==='ECONNREFUSED'?0:-1;}}
function readLock(){try{return JSON.parse(fs.readFileSync(lock,'utf8').replace(/^\\uFEFF/,''));}catch{return null;}}
(async()=>{
const long=mode==='long'&&lock&&lock!=='-';
const until=Date.now()+(mode==='long'?${HELPER_MAX_MS}:${QUIT_CONFIRM_MS});
await cancel();
let gone=false,last=Date.now(),renewed=Date.now();
while(Date.now()<until){
const n=await left();if(n===0){gone=true;break;}
if(Date.now()-last>10000){last=Date.now();await cancel();}
if(long&&Date.now()-renewed>240000){renewed=Date.now();const l=readLock();if(l&&l.qui===qui&&l.pid===process.pid){l.debut=Date.now()/1000;try{fs.writeFileSync(lock,JSON.stringify(l));}catch{}}}
await wait(300);}
if(long){const l=readLock();if(l&&l.qui===qui&&l.pid===process.pid){try{fs.rmSync(lock,{force:true});}catch{}}}
process.exit(gone?0:3);
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kindOf = (file) => {
  const ext = path.extname(String(file)).toLowerCase();
  return VIDEO_EXT.has(ext) ? 'video' : IMAGE_EXT.has(ext) ? 'image' : AUDIO_EXT.has(ext) ? 'audio' : 'other';
};
const norm = (p) => path.normalize(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
const fmt = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));

function abortError(msg) {
  const e = new Error(msg || 'Annulé');
  e.name = 'AbortError';
  e.cancelled = true;
  return e;
}

/** Error carrying a readable message plus the raw ComfyUI payload for the log. */
class ComfyError extends Error {
  constructor(message, { code = 'comfy', details = null } = {}) {
    super(message);
    this.name = 'ComfyError';
    this.code = code;
    this.details = details;
  }
}

// --------------------------------------------------------------- progress
// Rough share of a job's time by node family, so one bar can cover "load 40 s, sample 8 steps, decode, save".
function nodeFamily(cls) {
  const c = String(cls || '');
  if (/^Load(Image|Video|Audio)/.test(c)) return 'inputs';
  if (/Sampler(?!Select)|DepthAnythingProcess|SeedVR2.*Upscal|Inference$|FrameInterpolate|RemoveBackground|ImageUpscaleWithModel/.test(c)) return 'sample';
  if (/Decode/.test(c)) return 'decode';
  if (/TextEncode/.test(c)) return 'prompt';
  if (/Loader|^Load.*Model/.test(c)) return 'load';
  if (/^Save|^Preview|^CreateVideo/.test(c)) return 'save';
  return 'other';
}
const FAMILY_WEIGHT = { sample: 12, decode: 4, load: 2, prompt: 1.5, save: 1, inputs: 0.5, other: 0.3 };

// --------------------------------------------------------------- node errors
const MODEL_INPUT = /(_name|^model$|ckpt|lora|unet|clip|vae)/i;

/** Turn a 400 from /prompt into one readable sentence (engine.md §6: "Modèle introuvable : …"). */
function friendlyPromptError(j, tr) {
  const lines = [];
  const add = (s) => { if (s && !lines.includes(s)) lines.push(s); };
  const err = j && j.error;
  const errType = err && typeof err === 'object' ? err.type : null;
  const errMsg = err && typeof err === 'object' ? err.message : (typeof err === 'string' ? err : '');

  for (const [id, ne] of Object.entries((j && j.node_errors) || {})) {
    const node = (ne && ne.class_type) || id;
    for (const e of (ne && ne.errors) || []) {
      const input = e.extra_info && e.extra_info.input_name;
      const value = e.extra_info && e.extra_info.received_value;
      const details = String(e.details || '');
      switch (e.type) {
        case 'value_not_in_list':
          add(MODEL_INPUT.test(input || '') ? tr('modelMissing', { value: value ?? details })
            : tr('valueRefused', { input, node, value: value ?? details }));
          break;
        case 'required_input_missing':
          add(tr('inputMissing', { input, node }));
          break;
        case 'return_type_mismatch':
        case 'invalid_input_type':
        case 'bad_linked_input':
          add(tr('badLink', { node, input }));
          break;
        case 'value_smaller_than_min':
        case 'value_bigger_than_max':
          add(tr('outOfRange', { input, node }));
          break;
        case 'custom_validation_failed':
          if (/invalid (image|video) file|not found|does not exist/i.test(details)) {
            add(tr('fileMissing', { value: details.replace(/^.*?:\s*/, '') || value }));
          } else add(tr('execError', { node, msg: details || e.message }));
          break;
        default:
          add(tr('execError', { node, msg: [e.message, details].filter(Boolean).join(' — ') }));
      }
    }
  }
  if (!lines.length) {
    const missing = /node (?:type )?["']?([\w .:-]+?)["']? does not exist|Cannot execute because node ([\w .:-]+) does not exist/i.exec(errMsg || '');
    if (missing) add(tr('nodeMissing', { node: missing[1] || missing[2] }));
    else if (errType === 'prompt_no_outputs') add(tr('noOutputs'));
    else add(tr('refused', { msg: errMsg || JSON.stringify(j).slice(0, 200) }));
  }
  const shown = lines.slice(0, 3);
  if (lines.length > 3) shown.push(tr('andMore', { n: lines.length - 3 }));
  return new ComfyError(shown.join(' · '), { code: 'validation', details: j });
}

/** execution_error payload → readable sentence (OOM gets its own advice). */
function friendlyExecError(data, tr) {
  const m = String((data && data.exception_message) || '').trim();
  const t = String((data && data.exception_type) || '');
  if (/out of memory|OutOfMemory|allocation on device/i.test(`${m} ${t}`)) {
    return new ComfyError(tr('oom'), { code: 'oom', details: data });
  }
  const first = (m.split(/\r?\n/).find((l) => l.trim()) || t || '?').slice(0, 300);
  return new ComfyError(tr('execError', { node: (data && data.node_type) || '?', msg: first }), { code: 'execution', details: data });
}

// ================================================================== client
class Comfy {
  /**
   * @param {object} o
   * @param {() => object} [o.prefs]   current prefs (engineRoot, comfyUrl, lang) — read at each call
   * @param {string} [o.logsDir]       where comfy.log goes (%APPDATA%\Mia\data\logs)
   * @param {string} [o.dataDir]       object_info disk cache
   * @param {() => void} [o.onState]   called whenever state/url/version change (engine pushes engine:status)
   */
  constructor({ prefs, logsDir, dataDir, onState, log } = {}) {
    this._prefs = typeof prefs === 'function' ? prefs : () => prefs || {};
    this.logsDir = logsDir || null;
    this.dataDir = dataDir || null;
    this._onState = onState || (() => {});
    this._log = log || (() => {});
    this.clientId = this._loadClientId();
    this.url = null;              // current instance (may be an alternate port)
    this.state = 'stopped';       // running | stopped | starting | error | foreign
    this.error = null;
    this.version = null;
    this.argv = [];
    this.outputDir = null;
    this.inputDir = null;
    this.minimax = false;
    this.child = null;            // ComfyUI process launched by Mia
    this.jobs = new Map();        // prompt_id → tracker
    this.lastStats = null;
    this.lastQueue = null;
    this._ws = null;
    this._wsReady = null;
    this._wsIdle = null;
    this._executingPrompt = null;
    this._ensuring = null;
    this._launching = false;
    this._models = new Map();
    this._oi = { version: null, all: null, classes: new Map(), diskLoaded: false };
  }

  // ------------------------------------------------------------ helpers
  /** Same client_id from one launch to the next: a crashed Mia's prompts are still recognisable as ours. */
  _loadClientId() {
    const f = this.dataDir ? path.join(this.dataDir, 'comfy-client.json') : null;
    if (f) {
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (j && /^[0-9a-f-]{36}$/i.test(String(j.clientId))) return String(j.clientId).toLowerCase();
      } catch { /* first launch */ }
    }
    const id = crypto.randomUUID();
    if (f) {
      try {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, JSON.stringify({ clientId: id }), 'utf8');
      } catch { /* a fresh id each launch then */ }
    }
    return id;
  }

  tr(key, vars) {
    const lang = this._prefs().lang === 'en' ? 'en' : 'fr';
    return fmt(STR[lang][key] ?? STR.fr[key] ?? key, vars);
  }

  /** prefs.engineRoot, else the lab when it is on this PC, else '' (no engine: nothing to launch). */
  engineRoot() {
    return places.engineRoot(this._prefs());
  }

  /** prefs.comfyUrl, refused when it leaves this PC (SPEC §10: no network call outside 127.0.0.1). */
  baseUrl() {
    const raw = this._prefs().comfyUrl || DEFAULT_URL;
    let u;
    try { u = new URL(raw); } catch { throw new ComfyError(this.tr('notLocal', { url: raw }), { code: 'config' }); }
    if (!LOCAL_HOSTS.has(u.hostname)) throw new ComfyError(this.tr('notLocal', { url: raw }), { code: 'config' });
    return u.origin;
  }

  _withPort(url, port) {
    const u = new URL(url);
    u.port = String(port);
    return u.origin;
  }

  _setState(state, error = null) {
    const changed = state !== this.state || error !== this.error;
    this.state = state;
    this.error = error;
    if (changed) this._onState();
  }

  async _fetchJson(pathname, { url = this.url || this.baseUrl(), timeout = 8000, method = 'GET', body, signal } = {}) {
    const signals = [AbortSignal.timeout(timeout)];
    if (signal) signals.push(signal);
    const r = await fetch(url + pathname, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any(signals)
    });
    const text = await r.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch { j = { error: text.slice(0, 300) }; }
    if (!r.ok) {
      const e = new ComfyError(`HTTP ${r.status}`, { code: 'http', details: j });
      e.status = r.status;
      e.body = j;
      throw e;
    }
    return j;
  }

  /** /system_stats of a URL, or null when nothing answers within 1.5 s. */
  async _probe(url, timeout = PROBE_MS) {
    try {
      const s = await this._fetchJson('/system_stats', { url, timeout });
      return s && s.system ? s : null;
    } catch {
      return null;
    }
  }

  /** The lab's instance: its --models-directory is <engineRoot>\models (engine.md §1.4, not ComfyUI Desktop). */
  _isLab(stats) {
    const argv = (stats && stats.system && stats.system.argv) || [];
    const i = argv.indexOf('--models-directory');
    const dir = i >= 0 ? argv[i + 1] : null;
    if (!dir) return false;
    const root = this.engineRoot();
    if (root && norm(dir) === norm(path.join(root, 'models'))) return true;
    // the lab's own instance, started by its scripts while Mia points elsewhere (only where the lab exists)
    const lab = places.labRoot();
    return !!lab && norm(dir) === norm(path.join(lab, 'models'));
  }

  _adopt(url, stats) {
    const argv = stats.system.argv || [];
    const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
    const root = this.engineRoot();
    const version = stats.system.comfyui_version || null;
    if (version !== this.version) {          // a new ComfyUI may have other nodes: drop the schema cache
      this._oi.all = null;
      this._oi.classes.clear();
      this._models.clear();
    }
    this.url = url;
    this.version = version;
    this.argv = argv;
    this.outputDir = arg('--output-directory') || (root ? path.join(root, 'runtime', 'output') : null);
    this.inputDir = arg('--input-directory') || (root ? path.join(root, 'runtime', 'input') : null);
    this.lastStats = stats;
    // MiniMax H3 needs config\extra_minimax.yaml (engine.md §1.2); otherwise look for its model file.
    if (argv.some((a) => /extra_minimax\.ya?ml$/i.test(String(a)))) this.minimax = true;
    else this.models('diffusion_models')
      .then((l) => { const v = l.some((n) => /minimax_h3_fl2va/i.test(n)); if (v !== this.minimax) { this.minimax = v; this._onState(); } })
      .catch(() => {});
    this._lastOk = Date.now();
    this._launchError = null;
    this._setState('running');
  }

  get managedByMia() {
    return !!(this.child && this.child.exitCode === null && this.url === this._childUrl);
  }

  /** Where is the lab's ComfyUI? → {kind:'lab'|'foreign'|null, url, stats} */
  async _discover() {
    const base = this.baseUrl();
    const candidates = [...new Set([this.url, this._childUrl, base].filter(Boolean))];
    let foreign = null;
    for (const u of candidates) {
      const s = await this._probe(u);
      if (!s) continue;
      if (this._isLab(s)) return { kind: 'lab', url: u, stats: s };
      if (u === base) foreign = { url: u, stats: s };
    }
    if (!foreign) return { kind: null, url: base };
    // The base port belongs to another ComfyUI (Desktop…): the lab's may live on 8190+ (engine.md §1.3).
    for (const port of ALT_PORTS) {
      const u = this._withPort(base, port);
      const s = await this._probe(u, 800);
      if (!s) return { kind: 'foreign', url: base, stats: foreign.stats, freeUrl: u };
      if (this._isLab(s)) return { kind: 'lab', url: u, stats: s };
    }
    return { kind: 'foreign', url: base, stats: foreign.stats, freeUrl: null };
  }

  // ------------------------------------------------------------ public API
  /** {state, url, version, managedByMia, minimax, error?} for engine:status. */
  status() {
    let url = this.url;
    if (!url) { try { url = this.baseUrl(); } catch { url = this._prefs().comfyUrl || DEFAULT_URL; } }
    const s = { state: this.state, url, version: this.version, managedByMia: this.managedByMia, minimax: !!this.minimax };
    if (this.error) s.error = this.error;
    return s;
  }

  /** {url, outputDir, inputDir, version, minimax, managedByMia} once running. */
  info() {
    return { url: this.url, outputDir: this.outputDir, inputDir: this.inputDir, version: this.version,
      minimax: !!this.minimax, managedByMia: this.managedByMia };
  }

  /**
   * Cheap state refresh for the 3 s status poll: never launches anything.
   * While Mia is launching ComfyUI, ensure() owns the state ('starting').
   */
  async refresh() {
    if (this._launching) return this.status();
    try {
      const d = await this._discover();
      if (d.kind === 'lab') this._adopt(d.url, d.stats);
      else if (d.kind === 'foreign') { this.url = null; this._setState('foreign', this.tr('foreign', { url: d.url })); }
      else if (this._launchError) { this.url = null; this._setState('error', this._launchError); }   // stays until the next start
      else { this.url = null; this._setState('stopped'); }
    } catch (e) {
      this._setState('error', e.message);              // bad prefs.comfyUrl: re-evaluated on every refresh
    }
    return this.status();
  }

  /**
   * Make sure the lab's ComfyUI answers. launch:false only detects (status, tests).
   * Concurrent callers share the same attempt, so two jobs can never start two instances.
   */
  ensure({ launch = true } = {}) {
    if (this.state === 'running' && this.url && this.lastStats && Date.now() - (this._lastOk || 0) < 3000) {
      return Promise.resolve(this.info());
    }
    if (this._ensuring) return this._ensuring;
    this._ensuring = (async () => {
      const d = await this._discover();
      if (d.kind === 'lab') {
        this._adopt(d.url, d.stats);
        return this.info();
      }
      if (!launch) {
        if (d.kind === 'foreign') {
          this._setState('foreign', this.tr('foreign', { url: d.url }));
          throw new ComfyError(this.tr('foreign', { url: d.url }), { code: 'foreign' });
        }
        if (!this.child) this._setState('stopped');
        throw new ComfyError(this.tr('down', { url: d.url }), { code: 'down' });
      }
      const url = d.kind === 'foreign' ? d.freeUrl : d.url;
      if (!url) throw new ComfyError(this.tr('foreign', { url: d.url }), { code: 'foreign' });
      this._launchError = null;
      await this._launch(url);
      return this.info();
    })().finally(() => { this._ensuring = null; });
    return this._ensuring;
  }

  /** Launch exactly the lab's command (engine.md §1.3 = bin\comfy.ps1) and wait up to 180 s. */
  async _launch(url) {
    // Our previous child still loading (it does not answer yet): wait for it instead of starting another one.
    if (!(this.child && this.child.exitCode === null && this._childUrl === url)) {
      const root = this.engineRoot();
      if (!root) throw this._fail(this.tr('noEngine'));
      const py = path.join(root, 'env', 'venv', 'Scripts', 'python.exe');
      const cwd = path.join(root, 'env', 'ComfyUI');
      if (!fs.existsSync(py)) throw this._fail(this.tr('noPython', { path: py }));
      if (!fs.existsSync(path.join(cwd, 'main.py'))) throw this._fail(this.tr('noComfy', { path: cwd }));
      const port = new URL(url).port || '8188';
      const args = ['main.py', '--listen', '127.0.0.1', '--port', port,
        '--models-directory', path.join(root, 'models'),
        '--user-directory', path.join(root, 'config', 'comfy_user'),
        '--input-directory', path.join(root, 'runtime', 'input'),
        '--output-directory', path.join(root, 'runtime', 'output'),
        '--temp-directory', path.join(root, 'runtime'),
        '--disable-auto-launch'];
      // Without it MiniMax H3 fails validation; a missing file would crash ComfyUI at startup, so test first.
      const extra = path.join(root, 'config', 'extra_minimax.yaml');
      if (fs.existsSync(extra)) args.push('--extra-model-paths-config', extra);

      let out = 'ignore';
      let fd = null;
      if (this.logsDir) {
        try {
          fs.mkdirSync(this.logsDir, { recursive: true });
          fd = fs.openSync(path.join(this.logsDir, 'comfy.log'), 'a');
          fs.writeSync(fd, `\n===== ${new Date().toISOString()} Mia lance ComfyUI : ${args.join(' ')}\n`);
          out = fd;
        } catch { out = 'ignore'; }
      }
      let child;
      try {
        child = spawn(py, args, {
          cwd,
          env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },   // the logger dies on accents otherwise
          windowsHide: true,
          // Outside libuv's kill-on-close job: other sessions may be using this server when Mia quits, so
          // shutdownSync() decides whether to stop it (queue empty, nobody else holding the GPU lock).
          detached: true,
          stdio: ['ignore', out, out]
        });
      } catch (e) {
        throw this._fail(this.tr('spawn', { msg: e.message }));
      } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch { /* the child keeps its own handle */ } }
      }
      this.child = child;
      this._childUrl = url;
      child.on('error', (e) => { this._childError = e.message; });
      child.on('exit', (code) => {
        if (this.child !== child) return;
        this.child = null;
        this._exitCode = code;
        if (this._launching) return;                      // the wait loop reports it
        if (this.state === 'running' && this.url === url) {
          this.url = null;
          this._launchError = this.tr('exitedRun', { code });   // a crash of the server we launched stays visible
          this._setState('error', this._launchError);
        }
      });
    }

    this._launching = true;
    this._setState('starting');
    try {
      const until = Date.now() + START_TIMEOUT_MS;
      while (Date.now() < until) {
        await sleep(1000);
        if (!this.child) {
          throw this._fail(this._childError ? this.tr('spawn', { msg: this._childError }) : this.tr('exited', { code: this._lastExitCode() }));
        }
        const s = await this._probe(url);
        if (s && this._isLab(s)) {
          this._launching = false;
          this._adopt(url, s);
          return;
        }
      }
      // Too long: stop what we started rather than leave a half-born server behind.
      this._killChild();
      throw this._fail(this.tr('timeout'));
    } finally {
      this._launching = false;
    }
  }

  _lastExitCode() {
    return this._exitCode ?? '?';
  }

  _fail(msg) {
    this._launching = false;
    this._launchError = msg;
    this._setState('error', msg);
    return new ComfyError(msg, { code: 'launch' });
  }

  _killChild() {
    const c = this.child;
    if (!c || c.exitCode !== null) return;
    try {
      spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    } catch { /* already gone */ }
  }

  /** Raw /system_stats of the current instance, or null. Also keeps state in sync. */
  async stats() {
    const url = this.url || (() => { try { return this.baseUrl(); } catch { return null; } })();
    if (!url) return null;
    const s = await this._probe(url, 2500);
    if (s && this._isLab(s)) this._adopt(url, s);
    return s;
  }

  /**
   * {running:[{number, promptId, mine, ours}], pending:[…]} or null when unreachable.
   * mine = a prompt this Mia follows right now; ours = sent with Mia's client_id (also a crashed Mia's orphans,
   * which count as someone else's work until they are gone).
   */
  async queue() {
    if (!this.url) return null;
    try {
      const j = await this._fetchJson('/queue', { timeout: 2000 });
      const map = (it) => ({
        number: it[0],
        promptId: it[1],
        mine: this.jobs.has(it[1]),
        ours: this.jobs.has(it[1]) || !!(it[3] && it[3].client_id === this.clientId)
      });
      this.lastQueue = { running: (j.queue_running || []).map(map), pending: (j.queue_pending || []).map(map), at: Date.now() };
      return this.lastQueue;
    } catch {
      return null;
    }
  }

  /** Someone else's prompt is running in ComfyUI right now (the GPU lock is only cooperative). */
  async busyOther() {
    if (!this.url && !this._launching) await this.refresh();   // never polled yet (no window): look once
    const q = await this.queue();
    return !!q && q.running.some((r) => !r.mine);
  }

  /** Prompts this Mia is following (sent, not finished). */
  activePrompts() {
    return [...this.jobs.values()].filter((j) => !j.settled).map((j) => j.promptId);
  }

  /** Prompts left by a previous Mia (crash): same client_id, not followed by this one. Read-only (GET). */
  async orphanPrompts() {
    if (!this.url && !this._launching) await this.refresh();
    const q = await this.queue();
    if (!q) return [];
    return [...q.running, ...q.pending].filter((r) => r.ours && !r.mine).map((r) => r.promptId);
  }

  /** Cancel these prompts and wait until ComfyUI no longer lists them. → true when confirmed. */
  async cancelAndWait(ids, ms = 120000) {
    if (!ids || !ids.length) return true;
    for (const id of ids) await this.cancel(id);
    const until = Date.now() + ms;
    let last = Date.now();
    while (Date.now() < until) {
      const q = await this.queue();
      if (q && ![...q.running, ...q.pending].some((r) => ids.includes(r.promptId))) return true;
      if (!q && (!this.url || !(await this._probe(this.url, 1000)))) return true;   // ComfyUI gone
      if (Date.now() - last > 10000) { last = Date.now(); for (const id of ids) await this.cancel(id); }
      await sleep(500);
    }
    return false;
  }

  /**
   * Give the VRAM back (POST /free, unload_models + free_memory) — SPEC §16, engine.md §1.4.6. Only when
   * nobody computes in ComfyUI (queue empty); the caller holds the GPU lock. → true when done.
   */
  async free() {
    if (!this.url) return false;
    let j;
    try { j = await this._fetchJson('/queue', { timeout: 3000 }); } catch { return false; }
    if ((j && j.queue_running && j.queue_running.length) || (j && j.queue_pending && j.queue_pending.length)) return false;
    try {
      await this._fetchJson('/free', { method: 'POST', body: { unload_models: true, free_memory: true }, timeout: 15000 });
      this._log('VRAM rendue (POST /free) avant un calcul Python');
      return true;
    } catch {
      return false;
    }
  }

  /** A file was just placed in models/<folder> (a LoRA): forget the cached list. */
  invalidateModels(folder) {
    if (folder) this._models.delete(folder); else this._models.clear();
  }

  /** Node schemas, cached per ComfyUI version (memory + %APPDATA%\Mia\data\comfy-object-info.json). */
  async objectInfo(cls) {
    if (!this.url) { try { await this.ensure({ launch: false }); } catch { /* fall back on the disk cache */ } }
    this._loadOiDisk();
    if (this._oi.all && this._oi.version === this.version) {
      if (!cls) return this._oi.all;
      if (this._oi.all[cls]) return this._oi.all[cls];
      // absent from the cached schema: a custom node added since (same ComfyUI version) — ask for it alone
    }
    if (cls && this._oi.classes.has(cls)) return this._oi.classes.get(cls);
    if (!this.url) {
      if (this._oi.all) return cls ? this._oi.all[cls] ?? null : this._oi.all;   // stale but better than nothing
      return null;
    }
    try {
      if (cls) {
        const j = await this._fetchJson(`/object_info/${encodeURIComponent(cls)}`, { timeout: 10000 });
        const v = (j && j[cls]) || null;
        if (v) this._oi.classes.set(cls, v);          // an unknown node may be installed later: ask again
        return v;
      }
      const all = await this._fetchJson('/object_info', { timeout: 60000 });
      this._oi = { version: this.version, all, classes: new Map(), diskLoaded: true };
      this._saveOiDisk();
      return all;
    } catch {
      if (this._oi.all) return cls ? this._oi.all[cls] ?? null : this._oi.all;
      return null;
    }
  }

  _oiFile() {
    return this.dataDir ? path.join(this.dataDir, 'comfy-object-info.json') : null;
  }

  _loadOiDisk() {
    if (this._oi.diskLoaded) return;
    this._oi.diskLoaded = true;
    const f = this._oiFile();
    if (!f) return;
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j && j.info) { this._oi.all = j.info; this._oi.version = j.version; }
    } catch { /* no cache yet */ }
  }

  _saveOiDisk() {
    const f = this._oiFile();
    if (!f) return;
    fsp.mkdir(path.dirname(f), { recursive: true })
      .then(() => fsp.writeFile(f + '.tmp', JSON.stringify({ version: this.version, info: this._oi.all })))
      .then(() => fsp.rename(f + '.tmp', f))
      .catch(() => {});
  }

  /** File names ComfyUI sees in models/<folder> (cached 60 s). [] when unreachable. */
  async models(folder) {
    const hit = this._models.get(folder);
    if (hit && Date.now() - hit.at < MODELS_TTL_MS) return hit.list;
    if (!this.url) return hit ? hit.list : [];
    try {
      const list = await this._fetchJson(`/models/${encodeURIComponent(folder)}`, { timeout: 5000 });
      const arr = Array.isArray(list) ? list : [];
      this._models.set(folder, { at: Date.now(), list: arr });
      return arr;
    } catch {
      return hit ? hit.list : [];
    }
  }

  // ------------------------------------------------------------ upload
  /**
   * Make a local file usable by LoadImage / LoadVideo → "mia/<hash>_<name>".
   * The name is stable for the same content (size + mtime + first MB), so a retry never re-sends 2 GB.
   * Above 95 MB the server would refuse the upload: copy straight into <inputDir>\mia\ instead (SPEC §8.3).
   */
  async upload(abs, { subfolder = 'mia', signal } = {}) {
    let st;
    try { st = await fsp.stat(abs); } catch { throw new ComfyError(this.tr('noFile', { path: abs }), { code: 'file' }); }
    const info = await this.ensure({ launch: true });
    const hash = await this._fileHash(abs, st);
    const safe = path.basename(abs).replace(/[^\w.-]+/g, '_').slice(-80);
    const name = `${hash}_${safe}`;
    const sub = String(subfolder || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const ret = sub ? `${sub}/${name}` : name;
    const dest = info.inputDir ? path.join(info.inputDir, ...sub.split('/').filter(Boolean), name) : null;

    if (dest) {
      try { if ((await fsp.stat(dest)).size === st.size) return ret; } catch { /* not there yet */ }
    }
    if (st.size > UPLOAD_LIMIT && dest) {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(abs, dest + '.part');
      await fsp.rename(dest + '.part', dest);
      return ret;
    }
    const ext = path.extname(abs).toLowerCase();
    const fd = new FormData();
    fd.append('image', await fs.openAsBlob(abs, { type: MIME[ext] || 'application/octet-stream' }), name);   // streamed, not read whole
    fd.append('type', 'input');
    if (sub) fd.append('subfolder', sub);
    fd.append('overwrite', 'true');
    let r;
    try {
      r = await fetch(`${this.url}/upload/image`, { method: 'POST', body: fd, signal });
    } catch (e) {
      if (signal && signal.aborted) throw abortError(this.tr('cancelled'));
      throw new ComfyError(this.tr('upload', { name: path.basename(abs), msg: e.message }), { code: 'network' });
    }
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new ComfyError(this.tr('upload', { name: path.basename(abs), msg: `HTTP ${r.status} ${t.slice(0, 120)}` }), { code: 'upload' });
    }
    const j = await r.json().catch(() => ({}));
    return j.subfolder ? `${String(j.subfolder).replace(/\\/g, '/')}/${j.name}` : (j.name || ret);
  }

  async _fileHash(abs, st) {
    const h = crypto.createHash('sha1').update(`${st.size}|${Math.round(st.mtimeMs)}|`);
    const fh = await fsp.open(abs, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, 1024 * 1024));
      await fh.read(buf, 0, buf.length, 0);
      h.update(buf);
    } finally {
      await fh.close();
    }
    return h.digest('hex').slice(0, 10);
  }

  // ------------------------------------------------------------ websocket
  _wsUrl() {
    return `${this.url.replace(/^http/, 'ws')}/ws?clientId=${this.clientId}`;
  }

  /** Open (or reuse) the socket; resolves true when open, false when unavailable (polling takes over). */
  _ensureWs() {
    clearTimeout(this._wsIdle);
    if (typeof WebSocket === 'undefined' || !this.url) return Promise.resolve(false);
    if (this._ws && (this._ws.readyState === 0 || this._ws.readyState === 1) && this._wsFor === this.url) return this._wsReady;
    let ws;
    try { ws = new WebSocket(this._wsUrl()); } catch { return Promise.resolve(false); }
    ws.binaryType = 'arraybuffer';
    this._ws = ws;
    this._wsFor = this.url;
    this._wsReady = new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 5000);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        try { ws.send(JSON.stringify({ type: 'feature_flags', data: { supports_preview_metadata: true } })); } catch { /* optional */ }
        resolve(true);
      });
      ws.addEventListener('error', () => { clearTimeout(t); resolve(false); });
      ws.addEventListener('close', () => { clearTimeout(t); resolve(false); });
    });
    ws.addEventListener('message', (ev) => {
      try {
        if (typeof ev.data === 'string') this._onJson(JSON.parse(ev.data));
        else this._onBinary(ev.data);
      } catch (e) { this._log(`ws message: ${e.message}`); }
    });
    ws.addEventListener('close', () => {
      if (this._ws !== ws) return;
      this._ws = null;
      // ComfyUI restarted or the link dropped mid-job: reconnect; /history polling covers the gap.
      if (this.jobs.size) setTimeout(() => { if (this.jobs.size && !this._ws) this._ensureWs(); }, 1500);
    });
    return this._wsReady;
  }

  _wsOpen() {
    return !!(this._ws && this._ws.readyState === 1);
  }

  /** No job left: let the socket go after a minute instead of listening forever. */
  _idleWs() {
    clearTimeout(this._wsIdle);
    if (this.jobs.size) return;
    this._wsIdle = setTimeout(() => {
      if (this.jobs.size || !this._ws) return;
      const ws = this._ws;
      this._ws = null;
      try { ws.close(); } catch { /* already closed */ }
    }, 60000);
    if (this._wsIdle.unref) this._wsIdle.unref();
  }

  _onJson(msg) {
    const { type, data } = msg || {};
    if (type === 'status') return;              // global queue size: /queue gives us the position
    const job = data && data.prompt_id && this.jobs.get(data.prompt_id);
    if (!job || job.settled) return;
    job.lastEvent = Date.now();
    switch (type) {
      case 'execution_start':
        job.t0 = job.t0 || Date.now();
        this._emit(job, this.tr('stStart'));
        break;
      case 'execution_cached':
        for (const n of data.nodes || []) job.cached.add(String(n));
        this._emit(job);
        break;
      case 'executing': {
        this._executingPrompt = data.prompt_id;
        if (data.node == null) { this._complete(job); break; }   // pre-success "idle" signal of older servers
        const id = String(data.node);
        if (job.current && job.current !== id) job.done.add(job.current);
        job.current = id;
        job.t0 = job.t0 || Date.now();
        this._emit(job, this._nodeMessage(job, id));
        break;
      }
      case 'progress': {
        const id = String(data.node);
        if (data.max > 0) job.frac.set(id, Math.min(1, data.value / data.max));
        this._emit(job, this._nodeMessage(job, id, data.value, data.max));
        break;
      }
      case 'progress_state': {
        for (const [id, st] of Object.entries(data.nodes || {})) {
          if (!st) continue;
          if (st.state === 'finished') job.done.add(String(id));
          else if (st.state === 'running' && st.max > 0) job.frac.set(String(id), Math.min(1, st.value / st.max));
        }
        this._emit(job);
        break;
      }
      case 'executed':
        if (data.node != null) job.done.add(String(data.node));
        this._emit(job);
        break;
      case 'execution_success':
        this._complete(job);
        break;
      case 'execution_error':
        this._settle(job, friendlyExecError(data, (k, v) => this.tr(k, v)));
        break;
      case 'execution_interrupted':
        this._settle(job, abortError(this.tr('cancelled')));
        break;
      default:
        break;
    }
  }

  /** Binary frames: 1 = preview (4-byte format, image), 4 = preview with JSON metadata (engine.md §6). */
  _onBinary(buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < 8) return;
    const dv = new DataView(buf);
    const type = dv.getUint32(0);
    let pid = null;
    let img = null;
    let format = 'jpeg';
    if (type === 1) {
      format = dv.getUint32(4) === 2 ? 'png' : 'jpeg';
      img = Buffer.from(buf, 8);
      pid = this._executingPrompt;            // no id in this frame: it belongs to the prompt running now
    } else if (type === 4) {
      const len = dv.getUint32(4);
      if (8 + len > buf.byteLength) return;
      let meta = {};
      try { meta = JSON.parse(Buffer.from(buf, 8, len).toString('utf8')); } catch { /* keep {} */ }
      pid = meta.prompt_id || this._executingPrompt;
      format = /png/i.test(String(meta.image_type || '')) ? 'png' : 'jpeg';
      img = Buffer.from(buf, 8 + len);
    } else return;
    const job = pid && this.jobs.get(pid);
    if (job && !job.settled && typeof job.onPreview === 'function' && img && img.length) {
      try { job.onPreview(img, { format }); } catch { /* a preview never breaks a job */ }
    }
  }

  _nodeMessage(job, id, v, max) {
    const node = job.graph[id];
    const fam = nodeFamily(node && node.class_type);
    const n = max > 1 ? { v, max } : null;
    switch (fam) {
      case 'load': return this.tr('stLoad');
      case 'inputs': return this.tr('stInputs');
      case 'prompt': return this.tr('stPrompt');
      case 'sample': return n ? this.tr('stSampleN', n) : this.tr('stSample');
      case 'decode': return n ? this.tr('stDecodeN', n) : this.tr('stDecode');
      case 'save': return this.tr('stSave');
      default: return n ? this.tr('stWorkN', n) : this.tr('stWork');
    }
  }

  /** Weighted completion of the prompt's nodes → 0..0.99 (1 only once the outputs are in hand) + ETA. */
  _emit(job, message) {
    if (message) job.message = message;
    let tot = 0;
    let acc = 0;
    for (const [id, w] of job.weights) {
      if (job.cached.has(id)) continue;
      tot += w;
      acc += w * (job.done.has(id) ? 1 : (job.frac.get(id) || 0));
    }
    const p = tot > 0 ? acc / tot : 0;
    job.progress = Math.max(job.progress, Math.min(0.99, p));   // loops (Wan segments) restart a sampler: never go back
    if (job.t0 && job.progress >= 0.02) {
      const el = (Date.now() - job.t0) / 1000;
      const raw = (el * (1 - job.progress)) / job.progress;
      job.eta = job.eta == null ? raw : job.eta * 0.7 + raw * 0.3;
    }
    const now = Date.now();
    if (!message && now - job.lastEmit < 200) return;            // throttle step spam, never a new message
    job.lastEmit = now;
    if (typeof job.onProgress === 'function') {
      try { job.onProgress(job.progress, job.message, job.eta != null ? Math.max(0, Math.round(job.eta)) : null); } catch { /* UI only */ }
    }
  }

  async _complete(job) {
    if (job.completing || job.settled) return;
    job.completing = true;
    // execution_success is sent just BEFORE the server stores the history: wait for it.
    const h = await this._history(job.promptId, 30000);
    if (job.settled) return;
    if (!h) return this._settle(job, new ComfyError(this.tr('lost'), { code: 'lost' }));
    const err = this._historyProblem(h);
    if (err) return this._settle(job, err);
    job.progress = 1;
    this._settle(job, null, { promptId: job.promptId, outputs: h.outputs || {}, status: h.status || null });
  }

  _historyProblem(h) {
    const st = h && h.status;
    if (!st || st.status_str !== 'error') return null;
    for (const m of st.messages || []) {
      if (m[0] === 'execution_interrupted') return abortError(this.tr('cancelled'));
      if (m[0] === 'execution_error') return friendlyExecError(m[1], (k, v) => this.tr(k, v));
    }
    return new ComfyError(this.tr('execError', { node: '?', msg: 'error' }), { code: 'execution', details: st });
  }

  async _history(promptId, waitMs = 0) {
    const until = Date.now() + waitMs;
    for (;;) {
      try {
        const h = await this._fetchJson(`/history/${encodeURIComponent(promptId)}`, { timeout: 8000 });
        if (h && h[promptId]) return h[promptId];
      } catch { /* retried below */ }
      if (Date.now() >= until) return null;
      await sleep(300);
    }
  }

  _settle(job, err, value) {
    if (job.settled) return;
    job.settled = true;
    clearInterval(job.poll);
    clearTimeout(job.cancelTimer);
    if (job.signal && job.abortHandler) job.signal.removeEventListener('abort', job.abortHandler);
    this.jobs.delete(job.promptId);
    if (this._executingPrompt === job.promptId) this._executingPrompt = null;
    this._idleWs();
    if (err) job.reject(err); else job.resolve(value);
  }

  /** Fallback when the socket is down (and a slow safety net when it is up): /history then /queue. */
  async _pollOnce(job) {
    if (job.settled || job.polling) return;
    const now = Date.now();
    if (this._wsOpen() && now - job.lastPoll < SAFETY_POLL_MS) return;
    job.polling = true;
    job.lastPoll = now;
    try {
      let h = null;
      try {
        const j = await this._fetchJson(`/history/${encodeURIComponent(job.promptId)}`, { timeout: 8000 });
        h = j && j[job.promptId];
        job.unreachableSince = null;
      } catch (e) {
        job.unreachableSince = job.unreachableSince || now;
        if (now - job.unreachableSince > 60000) this._settle(job, new ComfyError(this.tr('network', { msg: e.message }), { code: 'network' }));
        return;
      }
      if (h) {
        const err = this._historyProblem(h);
        if (err) return this._settle(job, err);
        if (h.status && (h.status.completed || h.status.status_str === 'success')) {
          job.progress = 1;
          return this._settle(job, null, { promptId: job.promptId, outputs: h.outputs || {}, status: h.status });
        }
        return;
      }
      const q = await this.queue();
      if (!q) return;
      const pos = q.pending.findIndex((r) => r.promptId === job.promptId);
      const running = q.running.some((r) => r.promptId === job.promptId);
      if (running || pos >= 0) {
        job.missing = 0;
        if (pos >= 0 && !job.t0) {
          const ahead = q.running.length + pos;
          this._emit(job, ahead > 0 ? this.tr('stQueuedN', { n: ahead }) : this.tr('stQueued'));
        }
      } else if (++job.missing >= 3) {
        this._settle(job, new ComfyError(this.tr('lost'), { code: 'lost' }));
      }
    } finally {
      job.polling = false;
    }
  }

  // ------------------------------------------------------------ submit
  /** Progress tracker of one prompt, registered before the POST so early events cannot be missed. */
  _track(promptId, graph, { onProgress, onPreview, signal, label } = {}) {
    const weights = new Map();
    for (const [id, n] of Object.entries(graph || {})) weights.set(String(id), FAMILY_WEIGHT[nodeFamily(n && n.class_type)]);
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const job = {
      promptId, graph: graph || {}, label: label || null, onProgress, onPreview, signal, resolve, reject,
      weights, cached: new Set(), done: new Set(), frac: new Map(), current: null,
      progress: 0, eta: null, t0: null, message: '', lastEmit: 0, lastPoll: Date.now(), missing: 0,
      settled: false, completing: false, polling: false, unreachableSince: null
    };
    this.jobs.set(promptId, job);
    return { job, promise };
  }

  /**
   * Queue an API graph and wait for it. → {promptId, outputs}
   * onProgress(p 0..1, message, eta_s) · onPreview(Buffer, {format}) · signal → targeted cancel.
   */
  async submit(graph, { onProgress, onPreview, signal, label } = {}) {
    if (signal && signal.aborted) throw abortError(this.tr('cancelled'));
    await this.ensure({ launch: true });
    if (signal && signal.aborted) throw abortError(this.tr('cancelled'));

    const promptId = crypto.randomUUID();
    const { job, promise } = this._track(promptId, graph, { onProgress, onPreview, signal, label });
    await this._ensureWs();

    let res;
    let body;
    try {
      res = await fetch(`${this.url}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: graph, client_id: this.clientId, prompt_id: promptId }),
        signal: AbortSignal.timeout(60000)
      });
      body = await res.json().catch(() => ({}));
    } catch (e) {
      this.jobs.delete(promptId);
      this._idleWs();
      throw new ComfyError(this.tr('network', { msg: e.message }), { code: 'network' });
    }
    if (!res.ok) {
      this.jobs.delete(promptId);
      this._idleWs();
      throw friendlyPromptError(body, (k, v) => this.tr(k, v));
    }
    // Servers that ignore our id answer with theirs: follow it.
    if (body && body.prompt_id && body.prompt_id !== promptId) {
      this.jobs.delete(promptId);
      job.promptId = body.prompt_id;
      this.jobs.set(job.promptId, job);
    }
    this._emit(job, this.tr('stQueued'));

    job.poll = setInterval(() => { this._pollOnce(job).catch(() => {}); }, POLL_MS);
    if (signal) {
      job.abortHandler = () => {
        this.cancel(job.promptId).catch(() => {});
        // Normally execution_interrupted arrives within a second; never hang the job if it does not.
        job.cancelTimer = setTimeout(() => this._settle(job, abortError(this.tr('cancelled'))), CANCEL_WAIT_MS);
      };
      signal.addEventListener('abort', job.abortHandler, { once: true });
      if (signal.aborted) job.abortHandler();        // aborted while the POST was in flight: it is queued, cancel it
    }
    return promise;
  }

  /** Targeted cancel: interrupts it if running, removes it if waiting. Never touches other sessions' jobs. */
  async cancel(promptId) {
    if (!promptId || !this.url) return false;
    try {
      const r = await fetch(`${this.url}/api/jobs/${encodeURIComponent(promptId)}/cancel`, { method: 'POST', signal: AbortSignal.timeout(5000) });
      if (r.ok) return true;
    } catch { /* older server: fall through */ }
    const post = (p, b) => fetch(this.url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b), signal: AbortSignal.timeout(5000) }).catch(() => null);
    await post('/interrupt', { prompt_id: promptId });       // only interrupts if THIS prompt runs
    await post('/queue', { delete: [promptId] });
    return true;
  }

  // ------------------------------------------------------------ outputs
  /**
   * /history outputs → real files on disk: [{abs, filename, subfolder, type, kind, node, exists}].
   * Synchronous on purpose (executors may call it without await). Subfolders come with backslashes on Windows.
   */
  files(outputs) {
    const base = this.outputDir || path.join(this.engineRoot(), 'runtime', 'output');
    const list = [];
    for (const [node, out] of Object.entries(outputs || {})) {
      if (!out || typeof out !== 'object') continue;
      for (const arr of Object.values(out)) {
        if (!Array.isArray(arr)) continue;
        for (const o of arr) {
          if (!o || typeof o !== 'object' || !o.filename) continue;
          if (o.type && o.type !== 'output') continue;       // temp previews
          const parts = String(o.subfolder || '').split(/[\\/]+/).filter((s) => s && s !== '.' && s !== '..');
          const abs = path.join(base, ...parts, path.basename(String(o.filename)));
          list.push({ abs, filename: o.filename, subfolder: o.subfolder || '', type: o.type || 'output',
            kind: kindOf(o.filename), node, exists: fs.existsSync(abs) });
        }
      }
    }
    return list;
  }

  /** Stream one output through /view (when the file is not reachable on disk). */
  async download(file, dst, { signal } = {}) {
    const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' });
    const r = await fetch(`${this.url}/view?${q}`, { signal });
    if (!r.ok || !r.body) throw new ComfyError(this.tr('noFile', { path: file.filename }), { code: 'file' });
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    const { Readable } = require('node:stream');
    const { pipeline } = require('node:stream/promises');
    await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dst));
    return dst;
  }

  // ------------------------------------------------------------ shutdown
  /**
   * Called from app 'will-quit' (synchronous context), BEFORE the engine frees its GPU lock.
   * - The ComfyUI Mia launched, used by nobody else: stopped (our prompt stops with it, at once).
   * - Otherwise our prompts are cancelled by a short-lived Node process (Electron's binary in node mode) that
   *   waits up to 5 s for ComfyUI to confirm. A long node only checks the interrupt between steps: if it is
   *   still busy, a detached helper takes over the lock (`handOver(pid)` rewrites it with the helper's pid) and
   *   frees it only once ComfyUI has let go — the GPU never computes for Mia without the lab's lock.
   * → { handedOff } : true = the helper owns the lock now, the caller must not release it.
   */
  shutdownSync({ lockHeldByOther = false, lock = null, handOver = null } = {}) {
    clearTimeout(this._wsIdle);
    const ids = this.activePrompts();
    if (this._ws) { try { this._ws.close(); } catch { /* closing anyway */ } }
    const q = this.lastQueue;
    const busy = !q || Date.now() - (q.at || 0) > 15000 || q.running.some((r) => !r.mine) || q.pending.some((r) => !r.mine);
    if (this.managedByMia && !busy && !lockHeldByOther) {
      this._killChild();
      return { handedOff: false, stopped: true };
    }
    if (!ids.length || !this.url) return { handedOff: false };
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const file = (lock && lock.file) || '-';
    const qui = (lock && lock.qui) || '-';
    try {
      const r = spawnSync(process.execPath, ['-e', QUIT_HELPER, 'quick', this.url, file, qui, ...ids],
        { env, timeout: QUIT_CONFIRM_MS + 1500, windowsHide: true, stdio: 'ignore' });
      if (r.status === 0) return { handedOff: false, confirmed: true };
    } catch { /* not confirmed: hand over below */ }
    if (!lock || typeof handOver !== 'function') return { handedOff: false };
    try {
      const child = spawn(process.execPath, ['-e', QUIT_HELPER, 'long', this.url, file, qui, ...ids],
        { env, detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => {});
      child.unref();
      if (!child.pid) return { handedOff: false };
      return { handedOff: !!handOver(child.pid), helperPid: child.pid };
    } catch {
      return { handedOff: false };
    }
  }
}

module.exports = { Comfy, ComfyError, friendlyPromptError, friendlyExecError, kindOf, abortError, nodeFamily, QUIT_HELPER };
