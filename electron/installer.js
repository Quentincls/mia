'use strict';
/**
 * Mia — installer of missing models, and the engine check of the first launch (SPEC §21.3, §21.4).
 *
 *   register(ctx)            IPC installer:list / start / pause / cancel / clear / status / engine / setToken, app:engineCheck,
 *                            event installer:progress (see the end of this file)
 *   new Installer(opts)      the download queue alone (tools/test-installer.js drives it without Electron)
 *   engineCheck(opts)        is there an engine Mia can use? (prefs.engineRoot, the lab, a running ComfyUI)
 *
 * What it does, and what it never does:
 *   - one download at a time, over HTTPS, resumable: the file grows as « <name>.mia-part » next to its final
 *     place (same folder, so the last step is an atomic rename), with a small « .mia-part.json » that says which
 *     file and version it holds. Not « .part »: the model scanner watches those folders and lists « .part » files as
 *     interrupted downloads — a growing « .part » would trigger a rescan every second and show up in the library.
 *   - the size is checked before (server vs manifest) and after; the sha256 too when it is known (manifest, or the
 *     X-Linked-Etag Hugging Face sends); small non-LFS files are checked with their git blob hash.
 *   - free space is checked before each file (what is left to fetch + 512 MB).
 *   - a file already in place with the right size is kept as is; a file of the same name with another size is
 *     NEVER overwritten (readable error) — Mia does not destroy what is on the disk.
 *   - the Hugging Face token is the user's own: $HF_TOKEN, else Hugging Face's file (%USERPROFILE%\.cache\huggingface\
 *     token, or $HF_HOME\token), read for each file, kept in memory for that file only, sent only to the exact host
 *     huggingface.co / hf.co and dropped at the first redirect to another host (its CDNs never see it), never logged.
 *     A token pasted in Mia (installer:setToken, or installer:start {token}) is checked with Hugging Face, then written
 *     to that same file — what `hf auth login` does — and nowhere in Mia's data. A gated file without a token is not
 *     queued: start() returns it in `blocked`, and the window offers to paste a token.
 *   - files land in <engineRoot>\models\<dest> — only when the engine root is Mia's engine (engineKind ok), or when
 *     the ComfyUI running here is the lab-type one Mia adopts (the rule of engine/comfy.js _isLab: its
 *     --models-directory is <engineRoot>\models). A plain ComfyUI that happens to answer is NOT an engine: nothing is
 *     downloaded until a real engine is set up.
 *   - test switches (never set in normal use): MIA_HF_BASE=http://127.0.0.1:<port> (a local fake server; loopback
 *     only), MIA_HF_TOKEN_FILE=<file>, MIA_MODELS_MANIFEST=<json> (a manifest of fake files), MIA_ENGINE_FALLBACK=
 *     none|<dir;dir> (where to look for an engine besides prefs.engineRoot), MIA_ENGINE_DRYRUN=1 (the engine script
 *     always runs with -DryRun), MIA_ENGINE_SCRIPT=<.ps1> (a fake engine script, to see the wizard while it runs).
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn, execFile } = require('node:child_process');

const MANIFEST = path.join(__dirname, '..', 'src', 'catalog', 'models-manifest.json');
const ENGINE_SCRIPT = path.join(__dirname, '..', 'engine-setup', 'install-engine.ps1');
const PART_EXT = '.mia-part';
const MARGIN = 512 * 1024 * 1024;          // free space kept on top of what is left to download
const STALL_MS = 60 * 1000;                // no byte for that long: the connection is dropped and retried
const RETRIES = [2000, 5000, 10000, 20000, 30000, 60000];
// the token goes to these exact hosts only — never to a subdomain (cdn-lfs*.hf.co, cas-bridge.xethub.hf.co…)
const HF_HOST = /^(huggingface\.co|hf\.co)$/i;
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/i;
const DEFAULT_ENGINE_ROOT = 'D:\\AI_Local_Videos';      // engine/comfy.js: the engine root when prefs has none
const ALT_PORTS = [8190, 8191, 8192, 8193, 8194, 8195];  // engine/comfy.js: where Mia's ComfyUI goes when 8188 is taken
const ENGINE_CACHE_MS = 3000;
const TOKEN_PAGE = 'https://huggingface.co/settings/tokens';   // where a « Read » token is made

// ------------------------------------------------------------------------------------------- sentences
const STR = {
  noEngine: {
    fr: 'Installe d’abord le moteur de Mia (ou indique son dossier) : les modèles se rangent dedans.',
    en: 'Set up Mia’s engine first (or point to its folder): the models go inside it.'
  },
  unknown: { fr: 'Mia ne sait pas installer « {what} ».', en: 'Mia does not know how to install “{what}”.' },
  nothing: { fr: 'Rien à installer : tout est déjà là.', en: 'Nothing to install: everything is already there.' },
  gatedNoToken: {
    fr: '{name} demande d’accepter sa licence sur Hugging Face. Ouvre {url}, connecte-toi (compte gratuit) et accepte la licence, puis colle ton jeton Hugging Face dans Modèles (ou relie ce PC avec la commande « hf auth login »). Mia ne garde pas ton jeton.',
    en: '{name} requires accepting its license on Hugging Face. Open {url}, sign in (free account) and accept the license, then paste your Hugging Face token in Models (or link this PC with the command “hf auth login”). Mia never keeps your token.'
  },
  tokenBad: {
    fr: 'Ce n’est pas un jeton Hugging Face : un jeton commence par « hf_ ». Crée-le sur huggingface.co/settings/tokens (type « Read »).',
    en: 'This is not a Hugging Face token: a token starts with “hf_”. Create one at huggingface.co/settings/tokens (type “Read”).'
  },
  tokenRefused: {
    fr: 'Hugging Face ne reconnaît pas ce jeton. Crée-en un nouveau (type « Read ») sur huggingface.co/settings/tokens, puis colle-le.',
    en: 'Hugging Face does not recognise this token. Create a new one (type “Read”) at huggingface.co/settings/tokens, then paste it.'
  },
  tokenWrite: { fr: 'Le jeton n’a pas pu être rangé dans {file} : {msg}', en: 'The token could not be saved to {file}: {msg}' },
  gatedDenied: {
    fr: 'Ton compte Hugging Face n’a pas encore accès à {name}. Ouvre {url}, accepte la licence avec le même compte, puis réessaie.',
    en: 'Your Hugging Face account has no access to {name} yet. Open {url}, accept the license with the same account, then try again.'
  },
  notFound: { fr: '{name} est introuvable sur Hugging Face (le dépôt a peut-être changé).', en: '{name} cannot be found on Hugging Face (the repository may have changed).' },
  server: { fr: 'Le serveur a répondu {code} pour {name}. Réessaie plus tard.', en: 'The server answered {code} for {name}. Try again later.' },
  notFile: { fr: 'Le serveur a renvoyé une page au lieu du fichier {name}.', en: 'The server sent a web page instead of the file {name}.' },
  wrongSize: {
    fr: 'Le fichier proposé pour {name} n’a pas la taille attendue ({got} au lieu de {want}) : rien n’a été rangé.',
    en: 'The file offered for {name} does not have the expected size ({got} instead of {want}): nothing was installed.'
  },
  badHash: {
    fr: 'Le fichier {name} est arrivé abîmé (empreinte différente) : il a été retiré, relance l’installation.',
    en: 'The file {name} arrived damaged (checksum mismatch): it was removed, start the install again.'
  },
  exists: {
    fr: 'Un fichier {file} existe déjà dans {dir} avec une autre taille : Mia ne l’écrase pas. Déplace-le si tu veux le remplacer.',
    en: 'A file {file} already exists in {dir} with another size: Mia does not overwrite it. Move it away to replace it.'
  },
  space: {
    fr: 'Pas assez de place sur {drive} pour {name} : il faut {need}, il reste {free}.',
    en: 'Not enough room on {drive} for {name}: {need} needed, {free} left.'
  },
  network: { fr: 'La connexion a été coupée trop souvent pour {name} : {msg}', en: 'The connection dropped too often for {name}: {msg}' },
  write: { fr: 'Impossible d’écrire {name} sur le disque : {msg}', en: 'Could not write {name} to the disk: {msg}' },
  busyEngine: { fr: 'Une installation du moteur est déjà en cours.', en: 'An engine install is already running.' },
  noScript: {
    fr: 'Le programme d’installation du moteur manque dans cette copie de Mia (engine-setup\\install-engine.ps1).',
    en: 'The engine installer is missing from this copy of Mia (engine-setup\\install-engine.ps1).'
  },
  badDir: { fr: 'Choisis un dossier complet (par exemple D:\\Mia\\Moteur).', en: 'Pick a full folder path (for example D:\\Mia\\Engine).' },
  engineFailed: { fr: 'L’installation du moteur s’est arrêtée (code {code}). Le journal dit pourquoi.', en: 'The engine install stopped (code {code}). The log says why.' },
  engineSet: {
    fr: 'Le moteur est installé, mais Mia n’a pas pu l’adopter : {msg}',
    en: 'The engine is installed, but Mia could not adopt it: {msg}'
  },
  gpu: {
    fr: '{msg} Tu peux installer le moteur quand même : les calculs seront impossibles ou très lents sur ce PC.',
    en: '{msg} You can install the engine anyway: renders will be impossible or very slow on this PC.'
  },
  gb: { fr: '{n} Go', en: '{n} GB' },
  mb: { fr: '{n} Mo', en: '{n} MB' },
  bytes: { fr: '{n} octets', en: '{n} bytes' }
};

function fill(s, vars) {
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
}

class UserError extends Error {
  constructor(message, code, extra) {
    super(message);
    this.userMessage = message;
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) { reject(abortError()); return; }
  const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', on); resolve(); }, ms);
  const on = () => { clearTimeout(t); reject(abortError()); };
  if (signal) signal.addEventListener('abort', on, { once: true });
});
function abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
const isAbort = (e) => !!e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');

const exists = (p) => fsp.stat(p).then((s) => s, () => null);

/** The nearest folder that exists above (or at) p — for a free-space question about a folder not made yet. */
function nearestDir(p) {
  let d = path.resolve(p);
  for (let i = 0; i < 64; i++) {
    try {
      if (fs.statSync(d).isDirectory()) return d;
    } catch { /* go up */ }
    const up = path.dirname(d);
    if (up === d) return d;
    d = up;
  }
  return d;
}

async function freeBytes(dir) {
  try {
    const s = await fsp.statfs(nearestDir(dir));
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;   // unknown: do not block on it
  }
}

const driveOf = (p) => {
  const m = /^([A-Za-z]:)/.exec(path.resolve(p));
  return m ? m[1].toUpperCase() : path.parse(path.resolve(p)).root;
};

// ------------------------------------------------------------------------------------------- engine check
/**
 * What a folder holds: Mia's engine (the lab layout), an engine whose install stopped half-way, a plain ComfyUI, a
 * models folder only, or nothing. Mia's engine = env\venv + env\ComfyUI AND its card (mia-engine.json, written by
 * the last step of install-engine.ps1) or PyTorch in the venv (the lab, installed before the card existed): a folder
 * left by a cancelled install (stopped before PyTorch) is 'incomplete', not an engine.
 */
function engineKind(root) {
  const out = { root: root || null, kind: 'none', ok: false, python: null, comfy: null, models: null };
  if (!root || typeof root !== 'string' || !path.isAbsolute(root)) return out;
  const has = (...p) => { try { return fs.statSync(path.join(root, ...p)); } catch { return null; } };
  if (!has()) return { ...out, kind: 'missing' };
  const py = path.join(root, 'env', 'venv', 'Scripts', 'python.exe');
  const comfy = path.join(root, 'env', 'ComfyUI', 'main.py');
  const models = path.join(root, 'models');
  if (has('env', 'venv', 'Scripts', 'python.exe') && has('env', 'ComfyUI', 'main.py')) {
    const done = has('mia-engine.json') || has('env', 'venv', 'Lib', 'site-packages', 'torch', '__init__.py');
    return { ...out, kind: done ? 'mia' : 'incomplete', ok: !!done, python: py, comfy, models };
  }
  // ComfyUI "portable" (python_embeded + ComfyUI\main.py) or a git clone (main.py at the top)
  if (has('python_embeded', 'python.exe') && has('ComfyUI', 'main.py')) {
    return { ...out, kind: 'comfy-portable', python: path.join(root, 'python_embeded', 'python.exe'), comfy: path.join(root, 'ComfyUI', 'main.py'), models: path.join(root, 'ComfyUI', 'models') };
  }
  if (has('main.py') && has('comfy')) return { ...out, kind: 'comfy', comfy: path.join(root, 'main.py'), models };
  if (has('ComfyUI', 'main.py')) return { ...out, kind: 'comfy', comfy: path.join(root, 'ComfyUI', 'main.py'), models: path.join(root, 'ComfyUI', 'models') };
  if (has('models')) return { ...out, kind: 'models-only', models };
  return { ...out, kind: 'empty' };
}

function fallbackRoots() {
  const v = process.env.MIA_ENGINE_FALLBACK;
  if (v === 'none') return [];
  if (v) return v.split(';').map((x) => x.trim()).filter((x) => path.isAbsolute(x));
  return ['D:\\AI_Local_Videos'];
}

/** The engine root Mia uses when prefs has none — engine/comfy.js does the same (MIA_ENGINE_FALLBACK: tests). */
function defaultRoot() {
  return fallbackRoots()[0] || null;
}

async function comfyReachable(url, ms = 1500) {
  let u;
  try { u = new URL(String(url || 'http://127.0.0.1:8188')); } catch { return { reachable: false, url: String(url || '') }; }
  if (!LOOPBACK.test(u.hostname)) return { reachable: false, url: u.origin };   // Mia only talks to this PC
  try {
    const r = await fetch(u.origin + '/system_stats', { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return { reachable: false, url: u.origin };
    const j = await r.json().catch(() => ({}));
    const sys = j.system || {};
    return { reachable: true, url: u.origin, version: sys.comfyui_version || null, argv: Array.isArray(sys.argv) ? sys.argv.map(String) : [] };
  } catch {
    return { reachable: false, url: u.origin };
  }
}

const normDir = (p) => path.normalize(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
const argOf = (argv, k) => { const i = (argv || []).indexOf(k); return i >= 0 ? (argv[i + 1] || null) : null; };

/**
 * Is this running ComfyUI the one Mia adopts? The rule of engine/comfy.js _isLab, word for word: its
 * --models-directory is <engineRoot>\models (or the lab's own models folder). Any other ComfyUI is « foreign »:
 * Mia never computes with it, so it never counts as an engine here either.
 */
function isLabArgv(argv, engineRoot) {
  const dir = argOf(argv, '--models-directory');
  if (!dir) return false;
  const root = engineRoot || DEFAULT_ENGINE_ROOT;
  return normDir(dir) === normDir(path.join(root, 'models')) || /[\\/]ai_local_videos[\\/]models$/i.test(normDir(dir));
}

/**
 * The ComfyUI running on this PC, read like engine/comfy.js reads it: the base port, then — when another ComfyUI
 * holds it — Mia's alternate ports, until the first free one. → { base, lab, foreign }
 *   base: the answer of the base port · lab: a lab-type ComfyUI (url, argv, modelsDir) · foreign: {url, port}
 */
async function liveComfy(prefs = {}) {
  const base = await comfyReachable(prefs.comfyUrl);
  const root = prefs.engineRoot || defaultRoot();
  const lab = (c) => ({ url: c.url, version: c.version || null, modelsDir: path.normalize(argOf(c.argv, '--models-directory')) });
  if (!base.reachable) return { base, lab: null, foreign: null };
  if (isLabArgv(base.argv, root)) return { base, lab: lab(base), foreign: null };
  const port = (u) => { try { return Number(new URL(u).port) || 80; } catch { return null; } };
  const foreign = { url: base.url, port: port(base.url), version: base.version || null };
  for (const p of ALT_PORTS) {
    let alt;
    try { const u = new URL(base.url); u.port = String(p); alt = u.origin; } catch { break; }
    const s = await comfyReachable(alt, 800);
    if (!s.reachable) break;                 // the first free port is where Mia's own ComfyUI would go
    if (isLabArgv(s.argv, root)) return { base, lab: lab(s), foreign };
  }
  return { base, lab: null, foreign };
}

/** Free space under a folder (made or not): { dir, drive, free } (free null when unknown). */
async function spaceOf(dir) {
  if (!dir || !path.isAbsolute(String(dir))) return null;
  return { dir, drive: driveOf(dir), free: await freeBytes(dir) };
}

/** MIN_FREE_GB of engine-setup\versions.txt (GiB, like the script): the room the engine alone wants. */
function engineNeedBytes() {
  try {
    const m = /^\s*MIN_FREE_GB\s*=\s*(\d+)/m.exec(fs.readFileSync(path.join(path.dirname(ENGINE_SCRIPT), 'versions.txt'), 'utf8'));
    if (m) return Number(m[1]) * 2 ** 30;
  } catch { /* no file: the script's own default */ }
  return 25 * 2 ** 30;
}

/** A folder to suggest for a fresh engine — ONE rule with places.suggestEngineDir() (Réglages, first launch):
 *  <data disk>\Mia-moteur when D: is a big fixed disk with room (MIA_DATA_DRIVE forces it), else <user folder>\Mia-moteur. */
function suggestDir(lang) {
  try { return require('./places').suggestEngineDir(lang); } catch { return path.join(os.homedir(), lang === 'en' ? 'Mia-engine' : 'Mia-moteur'); }
}

/** The lab is not suggested when places.js hides it (MIA_NO_LAB=1 or MIA_ENGINE_FALLBACK=none: someone else's PC). */
function labHidden() {
  try { return require('./places').labDisabled(); } catch { return process.env.MIA_NO_LAB === '1' || process.env.MIA_ENGINE_FALLBACK === 'none'; }
}

/**
 * engineCheck({ prefs, root }) → { ok, usable, current, candidates, comfy, suggest, suggestDir, space, needBytes, script }
 *   root given: only that folder is looked at (« J'ai déjà le moteur de Mia → son dossier », or the folder typed for a
 *   new install: its free space).
 *   usable = prefs.engineRoot is Mia's engine, or the ComfyUI running here is the lab-type one Mia adopts — ONE rule
 *   with engine/comfy.js and Installer.engineReady(): a plain ComfyUI that answers is not usable (comfy.foreign).
 *   suggest = another folder that is Mia's engine (the lab), when prefs.engineRoot is not.
 *   space = { dir, drive, free } of the folder looked at (root, else the suggested install folder).
 */
async function engineCheck({ prefs = {}, root = null } = {}) {
  const script = fs.existsSync(ENGINE_SCRIPT);
  if (root) {
    const k = engineKind(root);
    return { ok: true, usable: k.ok, current: k, candidates: [], comfy: null, suggest: null, suggestDir: suggestDir(prefs.lang), space: await spaceOf(root), needBytes: engineNeedBytes(), script };
  }
  const current = engineKind(prefs.engineRoot);
  const candidates = (labHidden() ? [] : fallbackRoots())
    .filter((r) => !prefs.engineRoot || path.resolve(r).toLowerCase() !== path.resolve(prefs.engineRoot).toLowerCase())
    .map(engineKind);
  const live = await liveComfy(prefs);
  const found = candidates.find((c) => c.ok) || null;
  const sd = suggestDir(prefs.lang);
  return {
    ok: true,
    usable: current.ok || !!live.lab,
    current,
    candidates,
    comfy: { reachable: !!live.base.reachable, url: live.base.url, version: live.base.version || null, lab: !!live.lab, foreign: live.foreign },
    suggest: !current.ok && found ? found.root : null,
    suggestDir: sd,
    space: await spaceOf(sd),
    needBytes: engineNeedBytes(),
    script
  };
}

// ------------------------------------------------------------------------------------------- the queue
/**
 * opts: {
 *   manifest | manifestPath, dataDir (downloads.json), prefs() → {engineRoot, comfyUrl}, inventory() → inventory|null,
 *   modelsDir() → string|null (overrides the rule), rescan() → Promise, emit(payload), log(...), lang() → 'fr'|'en',
 *   hfBase ('https://huggingface.co'), tokenFile, tokenHosts (RegExp|string[]), env (process.env: HF_TOKEN),
 *   progressMs (250), retryDelays, requireEngine (true), freeBytes(dir) (tests), version
 * }
 */
class Installer {
  constructor(opts = {}) {
    this.o = opts;
    this.log = opts.log || (() => {});
    this.emitFn = opts.emit || (() => {});
    this.jobs = [];             // in order; at most one is 'downloading' or 'verifying'
    this.active = null;
    this.engineRun = null;      // the engine script while it runs
    this.statePath = opts.dataDir ? path.join(opts.dataDir, 'downloads.json') : null;
    this.retry = Array.isArray(opts.retryDelays) ? opts.retryDelays : RETRIES;
    this.progressMs = opts.progressMs || 250;
    this.rescanTimer = null;
    this.loaded = false;
  }

  // ---- language and sentences
  lang() {
    try { return (this.o.lang && this.o.lang()) === 'en' ? 'en' : 'fr'; } catch { return 'fr'; }
  }
  say(key, vars) {
    const s = STR[key];
    return fill(s ? s[this.lang()] || s.fr : key, vars);
  }
  sizeText(bytes) {
    const gb = Number(bytes) / 1e9;
    const loc = this.lang() === 'en' ? 'en-GB' : 'fr-FR';
    if (gb >= 1) return this.say('gb', { n: gb.toLocaleString(loc, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
    return this.say('mb', { n: Math.max(1, Math.round(Number(bytes) / 1e6)).toLocaleString(loc) });
  }
  /** Two sizes that must read differently (« 4 Mo au lieu de 4 Mo » says nothing): exact bytes when they round alike. */
  sizePair(got, want) {
    const a = this.sizeText(got), b = this.sizeText(want);
    if (a !== b) return { got: a, want: b };
    const loc = this.lang() === 'en' ? 'en-GB' : 'fr-FR';
    const n = (x) => this.say('bytes', { n: Number(x).toLocaleString(loc) });
    return { got: n(got), want: n(want) };
  }
  label(f) {
    const l = f && f.label;
    return (l && (l[this.lang()] || l.fr)) || (f && f.key) || '?';
  }

  // ---- manifest
  manifest() {
    if (this._manifest) return this._manifest;
    const m = this.o.manifest || JSON.parse(fs.readFileSync(this.o.manifestPath || MANIFEST, 'utf8'));
    this._manifest = m;
    this._byKey = new Map((m.files || []).map((f) => [f.key, f]));
    return m;
  }
  file(key) {
    this.manifest();
    return this._byKey.get(key) || null;
  }

  // ---- where things go
  prefs() {
    try { return (this.o.prefs && this.o.prefs()) || {}; } catch { return {}; }
  }
  inventory() {
    try { return (this.o.inventory && this.o.inventory()) || null; } catch { return null; }
  }
  /** The engine root Mia uses: prefs.engineRoot, else the same default as engine/comfy.js. */
  engineRoot() {
    return this.prefs().engineRoot || defaultRoot();
  }
  /**
   * Is there an engine, and where do the models go? ONE rule with engineCheck() and engine/comfy.js: the engine root
   * is Mia's engine (engineKind ok), or the ComfyUI running here is the lab-type one Mia adopts. A plain ComfyUI that
   * answers (another app's) is not an engine: no folder is derived from it, nor from a folder that does not exist.
   * Read again at most every 3 s (list() and start() ask first). → { ready, modelsDir, foreign }
   */
  async refreshEngine(force = false) {
    if (this.o.modelsDir || this.o.requireEngine === false) return this._eng || null;
    const now = Date.now();
    if (!force && this._eng && now - this._eng.at < ENGINE_CACHE_MS) return this._eng;
    if (this._engP) return this._engP;
    this._engP = (async () => {
      const p = this.prefs();
      const k = engineKind(this.engineRoot());
      let live = { lab: null, foreign: null };
      try { live = await liveComfy({ ...p, engineRoot: this.engineRoot() }); } catch { /* nothing answers */ }
      this._eng = {
        at: Date.now(),
        ready: k.ok || !!live.lab,
        modelsDir: live.lab && live.lab.modelsDir ? live.lab.modelsDir : k.ok ? k.models : null,
        root: k.ok ? k.root : null,
        lab: !!live.lab,
        foreign: live.foreign || null
      };
      return this._eng;
    })().finally(() => { this._engP = null; });
    return this._engP;
  }
  modelsDir() {
    if (this.o.modelsDir) return this.o.modelsDir();
    if (this._eng) return this._eng.modelsDir;
    const k = engineKind(this.engineRoot());
    return k.ok ? k.models : null;
  }
  engineReady() {
    if (this.o.requireEngine === false) return true;
    if (this._eng) return this._eng.ready;
    return engineKind(this.engineRoot()).ok;
  }
  /** The engine's own Hugging Face command (hf.exe in its venv), for the « hf auth login » fallback; null if none. */
  hfCli() {
    const k = engineKind(this.engineRoot());
    if (!k.python) return null;
    const dir = path.dirname(k.python);
    for (const n of ['hf.exe', 'huggingface-cli.exe']) {
      const p = path.join(dir, n);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
    }
    return null;
  }
  target(f, dir = this.modelsDir()) {
    const name = path.posix.basename(f.path);
    const folder = path.join(dir, ...String(f.dest || '').split('/').filter(Boolean));
    const final = path.join(folder, name);
    return { name, folder, final, part: final + PART_EXT, meta: final + PART_EXT + '.json' };
  }

  // ---- the base URL (tests: a local fake server, loopback only)
  base() {
    const b = this.o.hfBase || process.env.MIA_HF_BASE || '';
    if (b) {
      try {
        const u = new URL(b);
        if (u.protocol === 'https:' || LOOPBACK.test(u.hostname)) return u.href.replace(/\/+$/, '');
      } catch { /* ignored: back to Hugging Face */ }
    }
    return 'https://huggingface.co';
  }
  urlOf(f) {
    const enc = (s) => String(s).split('/').map(encodeURIComponent).join('/');
    return `${this.base()}/${enc(f.repo)}/resolve/${encodeURIComponent(f.revision || 'main')}/${enc(f.path)}`;
  }
  pageOf(f) {
    return `https://huggingface.co/${f.repo}`;
  }
  /**
   * May this host receive the token? Only Hugging Face itself — the exact hosts huggingface.co and hf.co, never a
   * subdomain (its CDNs: cdn-lfs*.hf.co, cas-bridge.xethub.hf.co…) — or the local fake server of the tests. open()
   * also drops the token for good at the first redirect to another host, whatever this says.
   */
  tokenHost(hostname) {
    const th = this.o.tokenHosts;
    if (th instanceof RegExp) return th.test(hostname);
    if (Array.isArray(th) && th.includes(hostname)) return true;
    if (HF_HOST.test(hostname)) return true;
    // a local fake server of the tests stands in for Hugging Face
    const b = this.o.hfBase || process.env.MIA_HF_BASE;
    if (b) { try { const u = new URL(b); if (LOOPBACK.test(u.hostname) && u.hostname === hostname) return true; } catch { /* no */ } }
    return false;
  }
  /** Is the download server Hugging Face (or its stand-in)? A gated file needs a token only there. */
  baseIsHf() {
    try { return this.tokenHost(new URL(this.base()).hostname); } catch { return false; }
  }
  tokenFile() {
    if (this.o.tokenFile) return this.o.tokenFile;
    if (process.env.MIA_HF_TOKEN_FILE) return process.env.MIA_HF_TOKEN_FILE;
    const home = process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface');
    return path.join(home, 'token');
  }
  /** $HF_TOKEN (or the older $HUGGING_FACE_HUB_TOKEN): Hugging Face's own tools read it before the file. */
  envToken() {
    const env = this.o.env || process.env;
    const t = String(env.HF_TOKEN || env.HUGGING_FACE_HUB_TOKEN || '').trim();
    return /^[\x21-\x7e]{8,512}$/.test(t) ? t : null;
  }
  /** The user's Hugging Face token, read now, never stored by Mia. null when there is none. */
  async token() {
    const e = this.envToken();
    if (e) return e;
    try {
      const t = (await fsp.readFile(this.tokenFile(), 'utf8')).trim();
      return /^[\x21-\x7e]{8,512}$/.test(t) ? t : null;
    } catch {
      return null;
    }
  }
  async hasToken() {
    return !!(await this.token());
  }

  /**
   * saveToken(raw) — a token pasted by the user. Checked with Hugging Face first (a refused one is never written),
   * then written to Hugging Face's own token file — exactly what `hf auth login` does — and nowhere in Mia's data.
   * Never logged. → { ok, token: true, verified, user }
   */
  async saveToken(raw) {
    const tok = String(raw == null ? '' : raw).trim().replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '');
    if (!/^hf_[\x21-\x7e]{8,500}$/.test(tok)) throw new UserError(this.say('tokenBad'), 'token-bad');
    let verified = false, user = null;
    try {
      const u = new URL(this.base() + '/api/whoami-v2');
      const r = await fetch(u, { headers: { Authorization: `Bearer ${tok}`, 'User-Agent': `Mia/${this.o.version || '0'} (model installer)` }, signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (r.status === 401 || r.status === 403) throw new UserError(this.say('tokenRefused'), 'token-refused');
      if (r.ok) {
        verified = true;
        const j = await r.json().catch(() => ({}));
        user = typeof j.name === 'string' ? j.name.slice(0, 80) : null;
      }
    } catch (e) {
      if (e && e.userMessage) throw e;
      // offline, or Hugging Face does not answer: the token is kept unverified (a download will tell)
    }
    const file = this.tokenFile();
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, tok, { encoding: 'utf8', mode: 0o600 });
    } catch (e) {
      throw new UserError(this.say('tokenWrite', { file, msg: (e && e.code) || 'error' }), 'token-write');
    }
    if (this.envToken() && this.envToken() !== tok) this.log('HF_TOKEN is set in the environment: it wins over the token file');
    return { ok: true, token: true, verified, user };
  }

  /**
   * setToken({ token }) — save the token, then start again the gated files that stopped for want of one (or of a
   * license accepted with it). → { ok, token, verified, user, queued, blocked }
   */
  async setToken(req = {}) {
    await this.load();
    const saved = await this.saveToken(req && req.token);
    const keys = this.jobs.filter((j) => j.state === 'error' && /^gated/.test(j.errorCode || '')).map((j) => j.key);
    let r = { queued: [], skipped: [], blocked: [] };
    if (keys.length) {
      await this.refreshEngine();
      if (this.engineReady()) r = await this.start({ keys });
    }
    return { ...saved, queued: r.queued || [], blocked: r.blocked || [] };
  }

  // ---- what is there, what is missing
  /** A file counts as present when it is at its place, or when the scanner saw it elsewhere for ComfyUI. */
  async presence(f, dir) {
    const t = dir ? this.target(f, dir) : null;
    if (t) {
      const st = await exists(t.final);
      if (st && st.isFile()) return st.size === f.bytes || !f.bytes ? { present: true, where: t.final } : { present: false, conflict: true, where: t.final, size: st.size };
    }
    const inv = this.inventory();
    if (inv && Array.isArray(inv.models)) {
      const name = path.posix.basename(f.path).toLowerCase();
      if (f.model === 'birefnet') {
        const m = inv.models.find((x) => /birefnet/i.test(x.family || '') && x.status === 'ready');
        if (m) return { present: true, where: m.path };
      } else {
        const m = inv.models.find((x) => String(x.file || '').toLowerCase() === name && x.status !== 'other-app');
        if (m) return { present: true, where: m.path };
      }
    }
    return { present: false };
  }

  jobOf(key) {
    return this.jobs.find((j) => j.key === key) || null;
  }

  /** The whole picture, for the library and the welcome assistant. */
  async list() {
    await this.refreshEngine();
    await this.load();
    const m = this.manifest();
    const dir = this.modelsDir();
    const files = {};
    for (const f of m.files || []) {
      const p = await this.presence(f, dir);
      const j = this.jobOf(f.key);
      files[f.key] = {
        key: f.key, model: f.model || f.key, label: f.label, repo: f.repo, path: f.path, dest: f.dest,
        bytes: f.bytes, sizeGB: f.sizeGB, gated: !!f.gated, license: f.license, page: this.pageOf(f),
        present: p.present, conflict: !!p.conflict, where: p.where || null,
        job: j ? this.publicJob(j) : null
      };
    }
    const caps = {};
    for (const [id, c] of Object.entries(m.capabilities || {})) {
      const need = (c.needs || []).filter((k) => files[k]);
      const missing = need.filter((k) => !files[k].present);
      caps[id] = {
        id, label: c.label, needs: need, missing,
        missingBytes: missing.reduce((s, k) => s + (files[k].bytes || 0), 0),
        gated: missing.some((k) => files[k].gated),
        state: !missing.length ? 'ready' : missing.length === need.length ? 'missing' : 'partial',
        options: (c.options || []).map((o) => {
          const keys = (o.keys || []).filter((k) => files[k]);
          const miss = keys.filter((k) => !files[k].present);
          return { id: o.id, label: o.label, desc: o.desc || null, keys, missing: miss, missingBytes: miss.reduce((s, k) => s + files[k].bytes, 0) };
        })
      };
    }
    const free = dir ? await (this.o.freeBytes ? this.o.freeBytes(dir) : freeBytes(dir)) : null;
    const eng = this._eng || null;
    return {
      ok: true,
      modelsDir: dir,
      engineReady: this.engineReady(),
      // another app's ComfyUI answers on this PC: it is not Mia's engine (Mia installs its own next to it)
      foreignComfy: eng && eng.foreign && !eng.ready ? eng.foreign : null,
      // the ComfyUI that answers is Mia's own (lab-type); false when only another app's answers, or none
      comfyIsEngine: eng ? !!eng.lab : null,
      token: await this.hasToken(),
      tokenPage: TOKEN_PAGE,
      hfCli: this.hfCli(),
      free, drive: dir ? driveOf(dir) : null,
      licenses: m.licenses || {},
      files, caps,
      queue: this.status().queue
    };
  }

  // ---- the queue
  publicJob(j) {
    return {
      key: j.key, model: j.model, label: j.label, bytes: j.bytes, done: j.done, state: j.state,
      speed: j.speed || 0, eta: j.eta == null ? null : j.eta, error: j.error || null, errorCode: j.errorCode || null,
      page: j.page || null, phase: j.phase || null, verified: j.state === 'verifying' ? (j.verified || 0) : null,
      added: j.added, finished: j.finished || null
    };
  }
  status() {
    const q = this.jobs.map((j) => this.publicJob(j));
    const live = q.filter((j) => j.state === 'queued' || j.state === 'downloading' || j.state === 'verifying');
    return {
      ok: true,
      queue: q,
      active: this.active ? this.active.key : null,
      left: live.reduce((s, j) => s + Math.max(0, j.bytes - j.done), 0),
      // the engine script while it runs: enough for a window opened meanwhile to show where it is
      engine: this.engineRun ? {
        running: true, dir: this.engineRun.dir, dryRun: this.engineRun.dryRun, p: this.engineRun.p,
        started: this.engineRun.started, lines: this.engineRun.lines.slice(-400)
      } : null
    };
  }
  emit(payload) {
    try { this.emitFn(payload); } catch { /* the window is gone */ }
  }
  emitJob(j) {
    this.emit({ kind: 'job', job: this.publicJob(j), status: this.status() });
  }
  emitQueue() {
    this.emit({ kind: 'queue', status: this.status() });
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.statePath) return;
    try {
      const raw = JSON.parse(await fsp.readFile(this.statePath, 'utf8'));
      for (const s of Array.isArray(raw.jobs) ? raw.jobs : []) {
        const f = this.file(s.key);
        if (!f || this.jobOf(s.key)) continue;
        // a restart never resumes on its own: the user decides when the bandwidth goes to it
        const state = s.state === 'done' || s.state === 'error' ? s.state : 'paused';
        this.jobs.push(this.newJob(f, { state, done: Number(s.done) || 0, error: s.error || null, errorCode: s.errorCode || null, added: s.added, finished: s.finished }));
      }
      // what is really on the disk wins over the saved count
      const dir = this.modelsDir();
      for (const j of this.jobs) {
        if (j.state !== 'paused' || !dir) continue;
        const st = await exists(this.target(this.file(j.key), dir).part);
        j.done = st ? Math.min(st.size, j.bytes) : 0;
      }
    } catch { /* first time, or unreadable: start empty */ }
  }
  save() {
    if (!this.statePath) return;
    const data = { version: 1, jobs: this.jobs.filter((j) => j.state !== 'cancelled').map((j) => ({
      key: j.key, state: j.state, done: j.done, error: j.error || null, errorCode: j.errorCode || null, added: j.added, finished: j.finished || null
    })) };
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const tmp = this.statePath + '.tmp';
      fsp.mkdir(path.dirname(this.statePath), { recursive: true })
        .then(() => fsp.writeFile(tmp, JSON.stringify(data, null, 1)))
        .then(() => fsp.rename(tmp, this.statePath))
        .catch((e) => this.log('downloads.json not written:', e.message));
    }, 200);
  }

  newJob(f, extra = {}) {
    return Object.assign({
      key: f.key, model: f.model || f.key, label: f.label, bytes: f.bytes, done: 0, state: 'queued',
      speed: 0, eta: null, error: null, errorCode: null, page: f.gated ? this.pageOf(f) : null, added: Date.now()
    }, extra);
  }

  /**
   * start({ keys?, caps?, option?, token? }) — queue what is missing. caps: capability ids (their « needs »);
   * option: { cap, id } (one of a capability's options); token: a Hugging Face token pasted by the user, saved first
   * (saveToken). Paused or failed jobs of those keys start again.
   * A gated file without a token is NOT queued (it would fail at once): it comes back in `blocked`, with its page.
   * → { ok, queued, skipped, blocked, pages, message? }
   */
  async start(req = {}) {
    await this.load();
    let saved = null;
    if (req.token != null) {
      saved = await this.saveToken(req.token);
      if (!req.keys && !req.caps && !req.option) return { ...saved, queued: [], skipped: [], blocked: [], pages: [] };
    }
    await this.refreshEngine();
    if (!this.engineReady()) throw new UserError(this.say('noEngine'), 'no-engine');
    const m = this.manifest();
    const keys = new Set();
    for (const k of [].concat(req.keys || [])) {
      if (!this.file(k)) throw new UserError(this.say('unknown', { what: k }), 'unknown');
      keys.add(k);
    }
    for (const c of [].concat(req.caps || [])) {
      const cap = (m.capabilities || {})[c];
      if (!cap) throw new UserError(this.say('unknown', { what: c }), 'unknown');
      for (const k of cap.needs || []) keys.add(k);
    }
    if (req.option && req.option.cap) {
      const cap = (m.capabilities || {})[req.option.cap];
      const o = cap && (cap.options || []).find((x) => x.id === req.option.id);
      if (!o) throw new UserError(this.say('unknown', { what: `${req.option.cap}/${req.option.id}` }), 'unknown');
      for (const k of o.keys || []) keys.add(k);
    }
    const dir = this.modelsDir();
    const queued = [], skipped = [], blocked = [];
    const noToken = this.baseIsHf() && !(await this.token());
    for (const k of keys) {
      const f = this.file(k);
      const p = await this.presence(f, dir);
      if (p.present) { skipped.push(k); continue; }
      let j = this.jobOf(k);
      if (j && (j.state === 'queued' || j.state === 'downloading' || j.state === 'verifying')) { queued.push(k); continue; }
      if (f.gated && noToken) { blocked.push(k); continue; }
      if (j) {
        Object.assign(j, { state: 'queued', error: null, errorCode: null, speed: 0, eta: null, finished: null });
      } else {
        j = this.newJob(f);
        this.jobs.push(j);
      }
      queued.push(k);
    }
    const pages = [...new Set(blocked.map((k) => this.pageOf(this.file(k))))];
    const extra = saved ? { token: true, verified: saved.verified, user: saved.user } : {};
    if (!queued.length) {
      // the biggest blocked file names the model (« LTX 2.5 », not one of its decoders)
      const head = blocked.map((k) => this.file(k)).sort((a, b) => (b.bytes || 0) - (a.bytes || 0))[0];
      const message = head ? this.say('gatedNoToken', { name: this.label(head), url: this.pageOf(head) }) : this.say('nothing');
      return { ok: true, queued, skipped, blocked, pages, message, ...extra };
    }
    this.save();
    this.emitQueue();
    this.pump();
    return { ok: true, queued, skipped, blocked, pages, ...extra };
  }

  /** pause(key?) — the running download stops and keeps its part; without a key, everything waiting stops. */
  async pause(key = null) {
    await this.load();
    const list = key ? this.jobs.filter((j) => j.key === key) : this.jobs;
    for (const j of list) {
      if (j.state === 'queued') j.state = 'paused';
      else if ((j.state === 'downloading' || j.state === 'verifying') && j.ctrl) {
        j.stop = 'pause';
        j.ctrl.abort();
      }
    }
    this.save();
    this.emitQueue();
    return this.status();
  }

  /** cancel(key?) — stops and removes the part already downloaded; without a key, every unfinished job. */
  async cancel(key = null) {
    await this.load();
    if (key && typeof key === 'object' && key.engine) return this.cancelEngine();
    const list = key ? this.jobs.filter((j) => j.key === key) : this.jobs.filter((j) => j.state !== 'done');
    for (const j of list) {
      if ((j.state === 'downloading' || j.state === 'verifying') && j.ctrl) {
        j.stop = 'cancel';
        j.ctrl.abort();
      } else if (j.state !== 'done') {
        j.state = 'cancelled';
        await this.removePart(j);
      }
    }
    this.jobs = this.jobs.filter((j) => j.state !== 'cancelled' || j === this.active);
    this.save();
    this.emitQueue();
    return this.status();
  }

  /** clear() — forget the finished and failed lines of the list. */
  async clear() {
    await this.load();
    this.jobs = this.jobs.filter((j) => j.state !== 'done' && j.state !== 'error' && j.state !== 'cancelled');
    this.save();
    this.emitQueue();
    return this.status();
  }

  /** After a failure: a « .mia-part.json » with no byte downloaded is only clutter. */
  async tidy(f) {
    const dir = this.modelsDir();
    if (!dir || !f) return;
    const t = this.target(f, dir);
    const st = await exists(t.part);
    if (!st || st.size === 0) {
      await fsp.rm(t.part, { force: true }).catch(() => {});
      await fsp.rm(t.meta, { force: true }).catch(() => {});
    }
  }

  async removePart(j) {
    const dir = this.modelsDir();
    const f = this.file(j.key);
    if (!dir || !f) return;
    const t = this.target(f, dir);
    for (const p of [t.part, t.meta]) await fsp.rm(p, { force: true }).catch(() => {});
    j.done = 0;
  }

  pump() {
    if (this.active) return;
    const next = this.jobs.find((j) => j.state === 'queued');
    if (!next) {
      this.rescanSoon(true);
      return;
    }
    this.active = next;
    this.run(next).finally(() => {
      this.active = null;
      this.save();
      this.emitQueue();
      setImmediate(() => this.pump());
    });
  }

  rescanSoon(now = false) {
    if (!this.o.rescan || !this.needRescan) return;
    clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.needRescan = false;
      Promise.resolve(this.o.rescan()).catch((e) => this.log('rescan failed:', e && e.message));
    }, now ? 50 : 1500);
  }

  async run(j) {
    const f = this.file(j.key);
    j.ctrl = new AbortController();
    j.stop = null;
    j.state = 'downloading';
    j.phase = 'connect';
    j.error = null;
    j.errorCode = null;
    j.started = Date.now();
    this.emitJob(j);
    try {
      await this.download(j, f, j.ctrl.signal);
      j.state = 'done';
      j.phase = null;
      j.done = j.bytes;
      j.eta = 0;
      j.speed = 0;
      j.finished = Date.now();
      this.needRescan = true;
      this.log('installed', f.key, '→', f.dest);
      this.rescanSoon();
    } catch (e) {
      if (isAbort(e) || j.stop) {
        if (j.stop === 'cancel') {
          j.state = 'cancelled';
          await this.removePart(j);
          this.jobs = this.jobs.filter((x) => x !== j);
        } else {
          j.state = 'paused';
        }
      } else {
        j.state = 'error';
        j.error = e && e.userMessage ? e.userMessage : this.say('network', { name: this.label(f), msg: (e && e.message) || String(e) });
        j.errorCode = (e && e.code) || 'error';
        j.finished = Date.now();
        this.log('install failed', f.key, j.errorCode, e && !e.userMessage ? e : '');
        await this.tidy(f);
      }
      j.phase = null;
      j.speed = 0;
      j.eta = null;
    } finally {
      j.ctrl = null;
      j.stop = null;
      this.emitJob(j);
    }
  }

  /**
   * One HTTP(S) GET, redirects followed by hand. The token goes only to the host of the first request when that host
   * is Hugging Face itself (tokenHost), and is dropped for good at the first redirect to another host — like
   * huggingface_hub does: the CDN (cdn-lfs*.hf.co, cas-bridge.xethub.hf.co…) gets a presigned URL, never the token.
   */
  async open(url, { offset, token, signal }) {
    let cur = url;
    const linked = {};
    let first = null;
    for (let hop = 0; hop < 8; hop++) {
      const u = new URL(cur);
      const local = u.protocol === 'http:' && LOOPBACK.test(u.hostname);
      if (u.protocol !== 'https:' && !local) throw new Error(`refused URL ${u.protocol}//${u.hostname}`);
      if (first == null) first = u.host;
      else if (u.host !== first) token = null;
      const headers = { 'User-Agent': `Mia/${this.o.version || '0'} (model installer)`, 'Accept-Encoding': 'identity' };
      if (offset > 0) headers.Range = `bytes=${offset}-`;
      if (token && this.tokenHost(u.hostname)) headers.Authorization = `Bearer ${token}`;
      const res = await new Promise((resolve, reject) => {
        const req = (u.protocol === 'https:' ? https : http).get(u, { headers, signal }, resolve);
        req.on('error', reject);
        req.setTimeout(STALL_MS, () => req.destroy(Object.assign(new Error('no answer'), { code: 'ETIMEDOUT' })));
      });
      const h = res.headers;
      if (h['x-linked-size']) linked.size = Number(h['x-linked-size']);
      if (h['x-linked-etag']) linked.etag = String(h['x-linked-etag']).replace(/^W\//, '').replace(/"/g, '');
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && h.location) {
        res.resume();
        cur = new URL(h.location, u).href;
        continue;
      }
      return { res, linked, url: cur };
    }
    throw new Error('too many redirects');
  }

  async download(j, f, signal) {
    const dir = this.modelsDir();
    if (!dir) throw new UserError(this.say('noEngine'), 'no-engine');
    const t = this.target(f, dir);
    const name = this.label(f);

    // already in place?
    const st = await exists(t.final);
    if (st) {
      if (st.size === f.bytes) return;
      throw new UserError(this.say('exists', { file: t.name, dir: t.folder }), 'exists');
    }
    // a gated repository without a token: said before anything is written (no folder, no part)
    const isHf = this.baseIsHf();
    if (f.gated && isHf && !(await this.token())) {
      throw new UserError(this.say('gatedNoToken', { name, url: this.pageOf(f) }), 'gated-no-token', { page: this.pageOf(f) });
    }
    await fsp.mkdir(t.folder, { recursive: true });

    // a part from another version of the file is not resumed
    let meta = null;
    try { meta = JSON.parse(await fsp.readFile(t.meta, 'utf8')); } catch { /* none */ }
    if (meta && (meta.revision !== f.revision || meta.bytes !== f.bytes || meta.path !== f.path)) {
      await fsp.rm(t.part, { force: true });
      meta = null;
    }
    await fsp.writeFile(t.meta, JSON.stringify({ key: f.key, repo: f.repo, revision: f.revision, path: f.path, bytes: f.bytes, started: meta ? meta.started : Date.now() }));

    let hash = null;              // sha256 computed while downloading (only when it starts at byte 0)
    let wantSha = f.sha256 || null;
    let tries = 0;
    for (;;) {
      if (signal.aborted) throw abortError();
      const ps = await exists(t.part);
      let offset = ps ? ps.size : 0;
      if (offset > f.bytes) { await fsp.truncate(t.part, 0); offset = 0; }
      j.done = offset;
      if (offset === f.bytes) break;

      // room for what is left
      const free = this.o.freeBytes ? await this.o.freeBytes(t.folder) : await freeBytes(t.folder);
      const need = f.bytes - offset + MARGIN;
      if (free != null && free < need) {
        throw new UserError(this.say('space', { drive: driveOf(t.folder), name, need: this.sizeText(f.bytes - offset), free: this.sizeText(Math.max(0, free - MARGIN / 2)) }), 'space');
      }

      const token = await this.token();
      if (f.gated && !token && isHf) {
        throw new UserError(this.say('gatedNoToken', { name, url: this.pageOf(f) }), 'gated-no-token', { page: this.pageOf(f) });
      }

      j.phase = 'connect';
      let r;
      try {
        r = await this.open(this.urlOf(f), { offset, token, signal });
      } catch (e) {
        if (isAbort(e) || signal.aborted) throw abortError();
        if (tries >= this.retry.length) throw new UserError(this.say('network', { name, msg: e.message }), 'network');
        this.log('connection failed for', f.key, '—', e.message, '— retry', tries + 1);
        await sleep(this.retry[tries++], signal);
        continue;
      }
      const { res, linked } = r;
      const code = res.statusCode;
      if (linked.etag && /^[0-9a-f]{64}$/i.test(linked.etag) && !wantSha) wantSha = linked.etag.toLowerCase();

      if (code === 401 || code === 403) {
        res.resume();
        if (!token) throw new UserError(this.say('gatedNoToken', { name, url: this.pageOf(f) }), 'gated-no-token', { page: this.pageOf(f) });
        throw new UserError(this.say('gatedDenied', { name, url: this.pageOf(f) }), 'gated-denied', { page: this.pageOf(f) });
      }
      if (code === 404) { res.resume(); throw new UserError(this.say('notFound', { name }), 'not-found'); }
      if (code === 416) {
        res.resume();
        // the part is longer than the file, or complete already: start again from zero once
        await fsp.truncate(t.part, 0).catch(() => {});
        hash = null;
        if (tries >= this.retry.length) throw new UserError(this.say('server', { code, name }), 'server');
        tries++;
        continue;
      }
      if (code >= 500 || code === 429) {
        res.resume();
        if (tries >= this.retry.length) throw new UserError(this.say('server', { code, name }), 'server');
        await sleep(this.retry[tries++], signal);
        continue;
      }
      if (code !== 200 && code !== 206) { res.resume(); throw new UserError(this.say('server', { code, name }), 'server'); }
      if (/text\/html/i.test(String(res.headers['content-type'] || ''))) { res.resume(); throw new UserError(this.say('notFile', { name }), 'not-file'); }

      // the total size the server announces must be the one we expect
      let start = 0, total = null;
      if (code === 206) {
        const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(String(res.headers['content-range'] || ''));
        if (!m || Number(m[1]) !== offset) {
          res.resume();
          await fsp.truncate(t.part, 0).catch(() => {});
          hash = null;
          if (tries >= this.retry.length) throw new UserError(this.say('server', { code, name }), 'server');
          tries++;
          continue;
        }
        start = offset;
        total = m[3] === '*' ? (linked.size || null) : Number(m[3]);
      } else {
        total = res.headers['content-length'] != null ? Number(res.headers['content-length']) : (linked.size || null);
      }
      if (total != null && f.bytes && total !== f.bytes) {
        res.resume();
        await fsp.rm(t.part, { force: true });
        await fsp.rm(t.meta, { force: true });
        throw new UserError(this.say('wrongSize', { name, ...this.sizePair(total, f.bytes) }), 'size');
      }
      if (start === 0) {
        // a fresh start (no Range, or the server ignored it): the part is rewritten from byte 0
        hash = crypto.createHash('sha256');
        offset = 0;
      }

      // stream to the part, counting, hashing, watching for a stalled connection
      j.phase = 'download';
      j.done = start;
      this.track(j, true);
      let stall = null;
      const kick = () => {
        clearTimeout(stall);
        stall = setTimeout(() => res.destroy(Object.assign(new Error('stalled'), { code: 'ESTALL' })), STALL_MS);
      };
      kick();
      const self = this;
      const count = new Transform({
        transform(chunk, _enc, cb) {
          kick();
          j.done += chunk.length;
          if (hash) hash.update(chunk);
          if (j.done > f.bytes) { cb(Object.assign(new Error('longer than expected'), { code: 'ETOOLONG' })); return; }
          self.track(j);
          cb(null, chunk);
        }
      });
      try {
        await pipeline(res, count, fs.createWriteStream(t.part, { flags: start > 0 ? 'a' : 'w' }), { signal });
      } catch (e) {
        clearTimeout(stall);
        if (isAbort(e) || signal.aborted) throw abortError();
        if (e && (e.code === 'ENOSPC' || e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS')) {
          throw new UserError(this.say('write', { name, msg: e.message }), 'write');
        }
        if (e && e.code === 'ETOOLONG') {
          await fsp.truncate(t.part, 0).catch(() => {});
          hash = null;
        }
        if (tries >= this.retry.length) throw new UserError(this.say('network', { name, msg: e.message }), 'network');
        this.log('download interrupted for', f.key, 'at', j.done, '—', e.message, '— retry', tries + 1);
        hash = null;            // the sum no longer covers the file from byte 0
        await sleep(this.retry[tries++], signal);
        continue;
      }
      clearTimeout(stall);
      const after = await exists(t.part);
      if (after && after.size === f.bytes) break;
      // the server closed early: resume where it stopped
      hash = null;
      if (tries >= this.retry.length) throw new UserError(this.say('network', { name, msg: 'incomplete' }), 'network');
      await sleep(this.retry[tries++], signal);
    }

    // check: size, then the checksum when there is one
    j.state = 'verifying';
    j.phase = 'verify';
    j.verified = hash ? 1 : 0;
    j.speed = 0;
    j.eta = null;
    this.emitJob(j);
    const fin = await exists(t.part);
    if (!fin || fin.size !== f.bytes) {
      throw new UserError(this.say('wrongSize', { name, ...this.sizePair(fin ? fin.size : 0, f.bytes) }), 'size');
    }
    let ok = true;
    if (wantSha) {
      const got = hash ? hash.digest('hex') : await this.hashFile(t.part, 'sha256', null, j, signal);
      ok = got === wantSha.toLowerCase();
    } else if (f.gitOid) {
      const got = await this.hashFile(t.part, 'sha1', `blob ${f.bytes}\0`, j, signal);
      ok = got === f.gitOid;
    }
    if (!ok) {
      await fsp.rm(t.part, { force: true });
      await fsp.rm(t.meta, { force: true });
      throw new UserError(this.say('badHash', { name }), 'hash');
    }

    // in place (same folder: an atomic rename); someone may have put the file there meanwhile
    const late = await exists(t.final);
    if (late) {
      if (late.size !== f.bytes) throw new UserError(this.say('exists', { file: t.name, dir: t.folder }), 'exists');
      await fsp.rm(t.part, { force: true });
    } else {
      await fsp.rename(t.part, t.final);
    }
    await fsp.rm(t.meta, { force: true });
  }

  /** Re-read a file to check it (after a resumed download, the running sum does not cover it). */
  async hashFile(file, algo, prefix, j, signal) {
    const h = crypto.createHash(algo);
    if (prefix) h.update(prefix);
    let read = 0;
    const size = (await fsp.stat(file)).size;
    const self = this;
    await pipeline(fs.createReadStream(file, { highWaterMark: 4 << 20 }), new Transform({
      transform(chunk, _e, cb) {
        h.update(chunk);
        read += chunk.length;
        if (j) {
          j.verified = size ? read / size : 1;
          self.track(j);
        }
        cb();
      }
    }), { signal });
    return h.digest('hex');
  }

  /** Speed (smoothed), ETA, and a throttled progress event. */
  track(j, reset = false) {
    const now = Date.now();
    if (reset || !j._t) {
      j._t = now;
      j._d = j.done;
      j._e = 0;
      this.emitJob(j);
      return;
    }
    if (now - j._e < this.progressMs) return;
    const dt = (now - j._t) / 1000;
    if (dt >= 0.5 && j.phase === 'download') {
      const inst = (j.done - j._d) / dt;
      j.speed = j.speed ? j.speed * 0.7 + inst * 0.3 : inst;
      j._t = now;
      j._d = j.done;
      j.eta = j.speed > 1 ? Math.round((j.bytes - j.done) / j.speed) : null;
    }
    j._e = now;
    this.emitJob(j);
  }

  // ------------------------------------------------------------------------------------------- engine
  /**
   * Run engine-setup\install-engine.ps1 into `dir` (SPEC §21.3), with a readable log in installer:progress
   * events ({kind:'engine', state, line, p}). dryRun: the script shows what it would do, downloads nothing.
   * On success (not a dry run) the folder becomes prefs.engineRoot and the models are read again.
   * skipGpuCheck: install even without a usable NVIDIA card (the script's -SkipGpuCheck). When the script stops at
   * its machine check for that reason, the answer says so ({gpu: true}) and the window offers « Install anyway ».
   */
  async engine({ dir, dryRun = false, skipGpuCheck = false } = {}) {
    if (this.engineRun) throw new UserError(this.say('busyEngine'), 'busy');
    if (!dir || typeof dir !== 'string' || !path.isAbsolute(dir) || /["\r\n]/.test(dir)) throw new UserError(this.say('badDir'), 'bad-dir');
    const script = this.o.engineScript || ENGINE_SCRIPT;
    if (!fs.existsSync(script)) throw new UserError(this.say('noScript'), 'no-script');
    if (process.env.MIA_ENGINE_DRYRUN === '1') dryRun = true;
    const src = fs.readFileSync(script, 'utf8');
    const { dirParam, hasDryRun, names } = scriptParams(src);
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const args = [dirParam ? `-${dirParam} ${q(dir)}` : q(dir)];
    if (dryRun && hasDryRun) args.push('-DryRun');
    if (skipGpuCheck && names.some((n) => n.toLowerCase() === 'skipgpucheck')) args.push('-SkipGpuCheck');
    // the steps, the failures and the log in Mia's language (the script speaks French unless told otherwise)
    const langParam = names.find((n) => n.toLowerCase() === 'lang');
    if (langParam) args.push(`-${langParam} ${this.lang()}`);
    // UTF-8 out, whatever the console code page: the log may hold accents
    // a script that throws (no exit code of its own) still ends as a failure
    const command = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; $c = 0; '
      + `try { & ${q(script)} ${args.join(' ')}; if ($LASTEXITCODE) { $c = $LASTEXITCODE } } `
      + 'catch { [Console]::Error.WriteLine($_.Exception.Message); $c = 1 }; exit $c';
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(fs.existsSync(ps) ? ps : 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      cwd: path.dirname(script), windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' }
    });
    const run = { child, dir, dryRun, lines: [], p: null, started: Date.now(), cancelled: false };
    this.engineRun = run;
    const send = (extra) => this.emit({ kind: 'engine', dir, dryRun, p: run.p, ...extra });
    send({ state: 'running', line: null });
    const onLine = (line, err) => {
      const text = line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '');
      if (!text) return;
      const at = /^@mia\s+(\{.*\})\s*$/.exec(text);
      if (at) {
        // {step, steps, label, p, dryRun} at each step (its readable « [3/11] … » line is printed too), then
        // {done, engineRoot} or {error} — engine-setup\README.md
        try {
          const j = JSON.parse(at[1]);
          if (typeof j.p === 'number') run.p = Math.max(0, Math.min(1, j.p));
          if (j.error) { run.error = String(j.error); run.errorStep = Number(j.step) || null; }
          if (j.msg) { run.lines.push(String(j.msg)); send({ state: 'running', line: String(j.msg) }); }
          else send({ state: 'running', line: null });
        } catch { /* not ours */ }
        return;
      }
      const step = /(?:^|\s|\[|\()(\d{1,2})\s*\/\s*(\d{1,2})(?:\]|\)|\s|$)/.exec(text);
      if (step && /^(\[|\(|é|e|s)/i.test(text.trim())) {
        const a = Number(step[1]), b = Number(step[2]);
        if (b > 0 && a <= b) run.p = Math.max(run.p || 0, (a - 1) / b);
      }
      run.lines.push(text);
      if (run.lines.length > 2000) run.lines.splice(0, run.lines.length - 2000);
      send({ state: 'running', line: text, err: !!err });
    };
    const reader = (stream, err) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (d) => {
        buf += d;
        const parts = buf.split(/\r?\n/);
        buf = parts.pop();
        for (const l of parts) onLine(l, err);
      });
      stream.on('end', () => { if (buf) onLine(buf, err); });
    };
    reader(child.stdout, false);
    reader(child.stderr, true);
    const code = await new Promise((resolve) => {
      child.on('error', (e) => { onLine(String(e.message), true); resolve(-1); });
      child.on('close', (c) => resolve(c));
    });
    this.engineRun = null;
    if (run.cancelled) {
      send({ state: 'cancelled', line: null });
      return { ok: false, cancelled: true };
    }
    if (code !== 0) {
      // the script's own sentence (« ÉCHEC : … ») says more than an exit code
      // the machine check (step 1) refused the graphics card: the window cannot pass -SkipGpuCheck by hand, it
      // offers « Install anyway » instead — the script's own hint is taken out of the sentence
      const gpu = !!run.error && run.errorStep === 1 && /NVIDIA|SkipGpuCheck/i.test(run.error);
      let error = run.error || this.say('engineFailed', { code });
      if (gpu) error = this.say('gpu', { msg: error.replace(/\s*(?:Relance avec|Run again with) -SkipGpuCheck[^.]*\.?/i, '').trim() });
      send({ state: 'error', line: null, error, gpu });
      return { ok: false, error, code, gpu, log: run.lines.slice(-40) };
    }
    let adopted = false, adoptError = null;
    if (!dryRun && this.o.adoptEngine) {
      try {
        await this.o.adoptEngine(dir);
        adopted = true;
        if (this.o.rescan) Promise.resolve(this.o.rescan()).catch(() => {});
      } catch (e) {
        adoptError = this.say('engineSet', { msg: (e && (e.userMessage || e.message)) || String(e) });
      }
    }
    run.p = 1;
    send({ state: 'done', line: null, adopted, error: adoptError });
    return { ok: true, dryRun, dir, adopted, warning: adoptError, log: run.lines.slice(-40) };
  }

  cancelEngine() {
    const run = this.engineRun;
    if (!run) return this.status();
    run.cancelled = true;
    // the script starts uv, git, pip…: the whole tree goes
    execFile('taskkill', ['/PID', String(run.child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    return this.status();
  }
}

/** The script's own parameter names: the folder one (-Target, -Root, -Dir…) and whether -DryRun exists. */
function scriptParams(src) {
  const m = /param\s*\(([\s\S]*?)\)\s*(?:\r?\n|$)/i.exec(src);
  const block = m ? m[1] : '';
  const names = [...block.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((x) => x[1]);
  const pref = ['Target', 'TargetDir', 'EngineRoot', 'Root', 'InstallDir', 'Destination', 'Dest', 'Dir', 'Folder', 'Path', 'Into'];
  let dirParam = null;
  for (const p of pref) {
    const hit = names.find((n) => n.toLowerCase() === p.toLowerCase());
    if (hit) { dirParam = hit; break; }
  }
  if (!dirParam) {
    const str = /\[string\]\s*\$([A-Za-z_][A-Za-z0-9_]*)/i.exec(block);
    dirParam = str ? str[1] : null;
  }
  const hasDryRun = names.some((n) => n.toLowerCase() === 'dryrun');
  return { dirParam, hasDryRun, names };
}

// ------------------------------------------------------------------------------------------- Electron side
function register(ctx) {
  const prefs = () => (ctx.prefs && ctx.prefs.get ? ctx.prefs.get() : {});
  // MIA_MODELS_MANIFEST (tests only): a small manifest of fake files, served by a local fake Hugging Face
  const testManifest = process.env.MIA_MODELS_MANIFEST && fs.existsSync(process.env.MIA_MODELS_MANIFEST) ? process.env.MIA_MODELS_MANIFEST : null;
  const inst = new Installer({
    manifestPath: testManifest || MANIFEST,
    engineScript: process.env.MIA_ENGINE_SCRIPT && /\.ps1$/i.test(process.env.MIA_ENGINE_SCRIPT) && fs.existsSync(process.env.MIA_ENGINE_SCRIPT) ? process.env.MIA_ENGINE_SCRIPT : undefined,
    dataDir: ctx.paths && ctx.paths.data,
    prefs,
    inventory: () => (ctx.models && typeof ctx.models.inventory === 'function' ? ctx.models.inventory() : null),
    rescan: () => (ctx.models && typeof ctx.models.scan === 'function' ? ctx.models.scan({ queue: true }) : null),
    emit: (payload) => ctx.send && ctx.send('installer:progress', payload),
    log: ctx.logger ? ctx.logger('installer') : (ctx.log || (() => {})),
    lang: () => (typeof ctx.lang === 'function' ? ctx.lang() : 'fr'),
    version: ctx.app && ctx.app.getVersion ? ctx.app.getVersion() : '0',
    adoptEngine: async (dir) => {
      const r = await ctx.prefs.set({ engineRoot: dir });
      if (r && r.ok === false) throw new Error(r.error || 'refused');
    }
  });
  const ipc = ctx.ipcMain;
  const guard = (fn) => async (...a) => {
    try {
      return await fn(...a);
    } catch (e) {
      if (e && e.userMessage) return { ok: false, error: e.userMessage, code: e.code || null, page: e.page || null };
      inst.log('failed:', e);
      return { ok: false, error: (e && e.message) || String(e) };
    }
  };
  ipc.handle('installer:list', guard(() => inst.list()));
  ipc.handle('installer:start', guard((_e, req) => inst.start(req || {})));
  ipc.handle('installer:pause', guard((_e, key) => inst.pause(typeof key === 'string' ? key : (key && key.key) || null)));
  ipc.handle('installer:cancel', guard((_e, key) => inst.cancel(key && typeof key === 'object' ? (key.engine ? key : key.key || null) : (key || null))));
  ipc.handle('installer:clear', guard(() => inst.clear()));
  ipc.handle('installer:status', guard(async () => { await inst.load(); return inst.status(); }));
  ipc.handle('installer:engine', guard((_e, req) => inst.engine(req || {})));
  // a Hugging Face token pasted in Mia: checked, written to Hugging Face's own file, gated files started again.
  // (installer:start {token, keys} does the same in one call — the window uses it while preload has no setToken.)
  ipc.handle('installer:setToken', guard((_e, req) => inst.setToken(req && typeof req === 'object' ? req : { token: req })));
  ipc.handle('app:engineCheck', guard((_e, req) => engineCheck({ prefs: prefs(), root: req && req.root ? String(req.root) : null })));
  inst.load().then(() => inst.emitQueue()).catch(() => {});
  // closing Mia during a download: the part stays, the next launch offers to resume
  if (ctx.app && typeof ctx.app.on === 'function') {
    ctx.app.on('will-quit', () => {
      for (const j of inst.jobs) if (j.ctrl) { j.stop = 'pause'; j.ctrl.abort(); }
      if (inst.engineRun) inst.cancelEngine();
    });
  }
  return inst;
}

module.exports = { register, Installer, engineCheck, engineKind, isLabArgv, liveComfy, scriptParams, PART_EXT, MANIFEST };
