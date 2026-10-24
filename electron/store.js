'use strict';
/**
 * Mia — the store: preferences, the project index, project folders and graph.json.
 *
 * Where things live (SPEC §3.1, §18):
 *   %APPDATA%\Mia\data\prefs.json      preferences, written by MERGING patches (never "the whole object")
 *   %APPDATA%\Mia\data\index.json      a cache { projects:[boards], folders:[projects] }, rebuilt from the disk
 *   <projectsRoot>\<Name>\project.json the truth about a board (« planche ») without project; its id and
 *                                      name live HERE, not in the index
 *   <projectsRoot>\<Projet>\folder.json             a project (« projet » = folder of boards, f_…)
 *   <projectsRoot>\<Projet>\<Planche>\project.json  a board of that project (folderId in project.json)
 * In the code a board is still a "project" (p_…, mia.projects.*, mia://p/<id>/…): only the id → folder
 * lookup knows about the extra level.
 *
 * Lessons taken from Slate (slate-core.md §2.4, §11.2):
 *   - every read-modify-write runs in a per-file queue, or two saves in flight drop each other's changes;
 *   - the index is only a cache: if it is lost or stale, the folders tell the truth;
 *   - an unreadable graph.json is NEVER overwritten by an empty document (we try .bak, else read-only);
 *   - deleting a project sends it to the Recycle Bin, never fs.rm.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// Electron is required lazily so the pure parts of this module can be exercised from plain Node.
const electron = () => require('electron');
// Formats of prefs.json, project.json, folder.json, graph.json: brought to this version's on load (SPEC §21.1).
const migrations = require('./migrations');
const places = require('./places');

// ---------------------------------------------------------------- strings
// The main process speaks to Quentin too (errors, default names): French first, English second.
// Vocabulary (SPEC §18): a « planche » (board) is what the code calls a project (p_…, project.json);
// a « projet » is a folder of boards (f_…, folder.json).
const STR = {
  untitled: { fr: 'Nouvelle planche', en: 'New board' },
  untitledFolder: { fr: 'Nouveau projet', en: 'New project' },
  copySuffix: { fr: ' (copie)', en: ' (copy)' },
  copySuffixN: { fr: ' (copie {n})', en: ' (copy {n})' },
  notFound: { fr: 'Cette planche est introuvable (dossier déplacé ou supprimé ?).', en: 'This board cannot be found (folder moved or deleted?).' },
  folderNotFound: { fr: 'Ce projet est introuvable (dossier déplacé ou supprimé ?).', en: 'This project cannot be found (folder moved or deleted?).' },
  emptyName: { fr: 'Le nom ne peut pas être vide.', en: 'The name cannot be empty.' },
  folderNameTaken: {
    fr: 'Un autre projet s’appelle déjà « {name} » : choisis un autre nom.',
    en: 'Another project is already called “{name}”: choose another name.'
  },
  badColor: { fr: 'Couleur inconnue.', en: 'Unknown colour.' },
  busyMove: {
    fr: 'Un calcul de « {name} » est en file ou en cours : attends la fin (ou annule-le) avant de déplacer la planche.',
    en: 'A job of “{name}” is queued or running: wait for the end (or cancel it) before moving the board.'
  },
  moveLocked: {
    fr: 'Impossible de déplacer « {name} » : un de ses fichiers est utilisé (vidéo en lecture ?). Réessaie dans un instant.',
    en: 'Could not move “{name}”: one of its files is in use (video playing?). Try again in a moment.'
  },
  busyFolder: {
    fr: 'Un calcul est en cours dans « {name} » (projet « {folder} ») : attends la fin ou annule-le avant de supprimer le projet.',
    en: 'A job is running in “{name}” (project “{folder}”): wait for the end or cancel it before deleting the project.'
  },
  unreadable: {
    fr: 'Le fichier de la planche est illisible et aucune copie de secours n’a pu être relue. La planche est ouverte en lecture seule ; une copie du fichier abîmé a été gardée dans son dossier.',
    en: 'The board file is unreadable and no backup could be read. The board is open read-only; a copy of the damaged file was kept in its folder.'
  },
  recovered: {
    fr: 'Le fichier de la planche était abîmé : la version précédente a été rouverte. Une copie du fichier abîmé a été gardée dans le dossier de la planche.',
    en: 'The board file was damaged: the previous version was reopened. A copy of the damaged file was kept in the board folder.'
  },
  readOnlySave: {
    fr: 'Cette planche est ouverte en lecture seule (fichier abîmé) : rien n’a été enregistré.',
    en: 'This board is open read-only (damaged file): nothing was saved.'
  },
  badGraph: { fr: 'Planche invalide : rien n’a été enregistré.', en: 'Invalid board: nothing was saved.' },
  trashFailed: {
    fr: 'Impossible de mettre « {name} » à la corbeille : un fichier est peut-être encore utilisé (vidéo en lecture, calcul en cours).',
    en: 'Could not move “{name}” to the Recycle Bin: a file may still be in use (video playing, job running).'
  },
  diskFull: { fr: 'Le disque est plein.', en: 'The disk is full.' },
  locked: { fr: 'Fichier verrouillé ou accès refusé.', en: 'File locked or access denied.' },
  writeFailed: { fr: 'Écriture impossible : {msg}', en: 'Could not write: {msg}' },
  rootFailed: {
    fr: 'Le dossier des projets « {dir} » est inaccessible.',
    en: 'The projects folder “{dir}” cannot be reached.'
  },
  rootMissing: {
    fr: 'Le dossier des projets « {dir} » est introuvable (disque débranché, dossier renommé ou déplacé ?). Rebranche le disque ou choisis le dossier dans les réglages.',
    en: 'The projects folder “{dir}” cannot be found (drive unplugged, folder renamed or moved?). Plug the drive back in or choose the folder in the settings.'
  },
  rootInEngine: {
    fr: 'Le dossier des projets ne peut pas être dans le dossier du moteur (« {dir} ») : Mia n’écrit jamais dans le moteur.',
    en: 'The projects folder cannot be inside the engine folder (“{dir}”): Mia never writes into the engine.'
  },
  engineInRoot: {
    fr: 'Le dossier du moteur ne peut pas être dans le dossier des projets (« {dir} »).',
    en: 'The engine folder cannot be inside the projects folder (“{dir}”).'
  },
  engineNoTools: {
    fr: 'Ce dossier ne contient pas l’outillage IA : « {file} » est introuvable.',
    en: 'This folder does not hold the AI tooling: “{file}” cannot be found.'
  },
  busyRemove: {
    fr: 'Un calcul est en cours dans « {name} » : annule-le ou attends la fin avant de mettre la planche à la corbeille.',
    en: 'A job is running in “{name}”: cancel it or wait for the end before moving the board to the Recycle Bin.'
  }
};

// ---------------------------------------------------------------- state
const S = {
  dataDir: null,          // %APPDATA%\Mia\data
  userData: null,         // %APPDATA%\Mia
  documents: null,
  prefsFile: null,
  indexFile: null,
  prefs: null,
  rootOverride: null,     // MIA_PROJECTS_ROOT (tests): wins over prefs.projectsRoot without being saved
  index: { projects: [], folders: [] },
  dirs: new Map(),        // projectId → absolute folder (sync lookups for the protocol and the engine)
  folderDirs: new Map(),  // folderId → absolute folder of a project (a folder of boards, SPEC §18)
  pendingFolder: new Set(), // folderIds whose disk folder could not follow a rename yet (job running, file in use)
  changeListeners: new Set(), // (payload) → the structure changed (folders:changed, SPEC §18.2)
  trash: (abs) => electron().shell.trashItem(abs),   // Recycle Bin (tests inject their own)
  readOnly: new Map(),    // projectId → reason: opened from a damaged graph.json, saves refused
  goodGraph: new Set(),   // projectIds whose graph.json on disk is known to parse (safe to back up)
  lastThumb: new Map(),   // projectId → ms of the last thumbnail capture
  openedAt: new Map(),    // projectId → ms of the last open (no capture of a board still painting)
  savedKey: new Map(),    // projectId → sha1 of graph.json WITHOUT the camera, as last read/written
  pendingMove: new Set(), // projectIds whose folder could not follow a rename yet (file in use, job running)
  rootMissing: null,      // { dir, code } while the projects folder cannot be reached
  gen: 0,                 // bumped by every create/rename/duplicate/remove (see touch())
  touched: new Map(),     // projectId → gen of its last folder change (reconcile must not undo it)
  isBusy: () => false,    // projectId → a job of this project is queued or running (set by main.js)
  prefsListeners: new Set(),
  closing: false,
  lastReconcile: 0,
  reconciling: null,
  readyPromise: null,
  log: (...a) => console.log('[store]', ...a)
};

const SKIP_WRITE = Symbol('skip');
const ID_RE = /^p_[a-z0-9]{4,16}$/;
const FID_RE = /^f_[a-z0-9]{4,16}$/;
// Muted tints, like Chrome's tab groups (SPEC §18.1); blue is the accent. The interface owns the hues.
const FOLDER_COLORS = ['grey', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink'];
const COLOR_ROTATION = ['blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'grey'];

// ---------------------------------------------------------------- small helpers
function tr(obj, vars) {
  const s = (obj && (obj[lang()] ?? obj.fr)) || '';
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '')) : s;
}
function lang() { return S.prefs && S.prefs.lang === 'en' ? 'en' : 'fr'; }

/** An error whose message is meant for Quentin (main.js returns it as { ok:false, error }). */
function userError(msg, cause) {
  const e = new Error(msg);
  e.userMessage = msg;
  if (cause) e.cause = cause;
  return e;
}

/** Turn a filesystem failure into a sentence Quentin can act on. */
function fsMessage(err) {
  const code = err && err.code;
  if (code === 'ENOSPC') return tr(STR.diskFull);
  if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') return tr(STR.locked);
  return tr(STR.writeFailed, { msg: (err && err.message) || String(err) });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** JSON.parse that tolerates the UTF-8 BOM Notepad and PowerShell 5.1 put at the start of a file. */
const parseJSON = (text) => JSON.parse(String(text).replace(/^﻿/, ''));

async function readJSON(file, fallback) {
  try {
    return parseJSON(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const exists = (p) => fsp.access(p).then(() => true, () => false);

// ---------------------------------------------------------------- text cutting
// Names are cut on what a person sees as one character (a grapheme): never half an emoji (a lone
// surrogate becomes « � » on disk, and the folder name would never match the name again).
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const GRAPHEMES = (() => {
  try { return new Intl.Segmenter(undefined, { granularity: 'grapheme' }); } catch { return null; }
})();

/** At most `max` code points, cut between graphemes; lone surrogates removed. */
function cutText(s, max) {
  const text = String(s ?? '').replace(LONE_SURROGATE, '');
  if (text.length <= max) return text;   // UTF-16 length ≥ code points: nothing to cut
  if (!GRAPHEMES) return Array.from(text).slice(0, max).join('');
  let out = '';
  let n = 0;
  for (const { segment } of GRAPHEMES.segment(text)) {
    const c = Array.from(segment).length;
    if (n + c > max) break;
    out += segment;
    n += c;
  }
  return out;
}

/**
 * rename() with a short retry: on Windows an antivirus or the search indexer can hold a freshly
 * written file for a few milliseconds, and a <video> streaming a file holds it for longer.
 */
async function renameRetry(from, to, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      return await fsp.rename(from, to);
    } catch (e) {
      if (i >= tries - 1 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      await sleep(30 * (i + 1));
    }
  }
}

/** Write next to the target then rename over it: a crash never leaves half a file behind. */
async function writeFileAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, data);
    await renameRetry(tmp, file);
  } catch (e) {
    fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}
const writeJSONAtomic = (file, data, indent = 2) => writeFileAtomic(file, JSON.stringify(data, null, indent));

/** Is `child` strictly inside `parent`? (win32 path.relative compares case-insensitively) */
function isInside(child, parent) {
  if (!child || !parent) return false;
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Run fn over items with at most `n` in flight; results keep the input order. */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------- queues
/**
 * One promise chain per key ('index', 'prefs', 'p:<id>'): each read-modify-write waits for the
 * previous one. Generalises Slate's withIndex() to every file that has several writers.
 */
const queues = new Map();
function serial(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(() => {}, () => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

/**
 * Hold several queues at once, always taken in the same (sorted) order so two callers can never
 * wait on each other. Used to rename a project folder while no save of its boards is in flight.
 */
function serialAll(keys, fn) {
  const ks = [...new Set(keys)].sort();
  const step = (i) => (i >= ks.length ? fn() : serial(ks[i], () => step(i + 1)));
  return step(0);
}

/**
 * The tree of folders (SPEC §18): every change of where boards and projects live on disk —
 * create, move, duplicate, remove, folder rename — runs one at a time. Lock order, never reversed:
 * 'tree' → 'p:<id>' (sorted) → 'index'. Nothing queued on 'index' or 'p:' ever waits for 'tree'
 * (a media import holds 'p:<id>' through withBoard and may reconcile, i.e. take 'index': same order).
 */
const tree = (fn) => serial('tree', fn);

/** Resolves once every queued write has landed (used when the window closes). */
function idle() {
  return Promise.all([...queues.values()]).then(() => {});
}

/** Slate's withIndex(), on the in-memory index: mutate, then persist unless told not to. */
function withIndex(mutate) {
  return serial('index', async () => {
    const result = await mutate(S.index);
    if (result !== SKIP_WRITE) {
      try {
        await writeJSONAtomic(S.indexFile, S.index, 0);
      } catch (e) {
        S.log('index write failed:', e.message);   // a cache: the next reconcile rebuilds it
      }
    }
    return result === SKIP_WRITE ? undefined : result;
  });
}

// ---------------------------------------------------------------- prefs
function defaultProjectsRoot() {
  // D:\Mia\Projets when D: is a big fixed data disk (not a USB stick, an SD card or a disc), else Documents
  return places.defaultProjectsRoot(S.documents || path.join(os.homedir(), 'Documents'), S.firstLang || (S.prefs && S.prefs.lang) || 'fr');
}

function defaultPrefs() {
  return {
    lang: S.firstLang || 'fr',
    theme: 'dark',
    projectsRoot: defaultProjectsRoot(),
    engineRoot: '',           // none: the first-launch check adopts an engine it finds or offers to install one
    comfyUrl: 'http://127.0.0.1:8188',
    extraModelRoots: [],
    order: 'updated',
    openTabs: [],
    activeTab: null,
    snap: false,
    minimap: false,
    wires: 'sober',
    winBounds: null,
    loraFolders: [],          // SPEC §12.1: folders whose LoRA become usable directly (scanner reads them)
    playerUnit: 'frames',     // SPEC §14: counter of the precise player (frames | seconds | timecode)
    pinnedModels: []          // SPEC §22: models pinned at the top of the model panel (inventory ids)
  };
}

const absList = (v) => (Array.isArray(v) ? v : [])
  .filter((x) => typeof x === 'string' && path.isAbsolute(x))
  .map((x) => path.normalize(x).replace(/[\\/]+$/, '') || x)
  .map((x) => (/^[A-Za-z]:$/.test(x) ? x + '\\' : x))
  .filter((x, i, a) => a.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i);

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Keep unknown keys (other modules store their own), but never let a known key hold nonsense. */
function sanitizePrefs(p) {
  const d = defaultPrefs();
  const out = Object.assign({}, d);
  for (const [k, v] of Object.entries(p || {})) {
    if (!FORBIDDEN_KEYS.has(k) && v !== undefined) out[k] = v;
  }
  if (!['fr', 'en'].includes(out.lang)) out.lang = d.lang;
  if (!['dark', 'light'].includes(out.theme)) out.theme = d.theme;
  for (const k of ['projectsRoot', 'engineRoot']) {
    if (k === 'engineRoot' && (out[k] === '' || out[k] == null)) { out[k] = ''; continue; }   // no engine yet
    if (typeof out[k] !== 'string' || !path.isAbsolute(out[k])) out[k] = d[k];
    else out[k] = path.normalize(out[k]).replace(/[\\/]+$/, '') || d[k];
    if (/^[A-Za-z]:$/.test(out[k])) out[k] += '\\';   // "D:" alone means "current dir of D:" — keep the root
  }
  if (typeof out.comfyUrl !== 'string' || !/^https?:\/\//.test(out.comfyUrl)) out.comfyUrl = d.comfyUrl;
  out.extraModelRoots = absList(out.extraModelRoots);
  out.loraFolders = absList(out.loraFolders);
  if (typeof out.playerUnit !== 'string' || !/^[a-z]{1,16}$/.test(out.playerUnit)) out.playerUnit = d.playerUnit;
  if (!['updated', 'opened', 'created', 'name'].includes(out.order)) out.order = d.order;
  if (!Array.isArray(out.openTabs)) out.openTabs = [];
  out.pinnedModels = (Array.isArray(out.pinnedModels) ? out.pinnedModels : [])
    .filter((x) => typeof x === 'string' && x.length <= 128).slice(0, 64);
  for (const k of ['snap', 'minimap']) out[k] = !!out[k];
  if (out.winBounds !== null && typeof out.winBounds !== 'object') out.winBounds = null;
  return out;
}

async function loadPrefs() {
  let raw = null;
  try {
    raw = await fsp.readFile(S.prefsFile, 'utf8');
  } catch { /* first launch */ }
  let parsed = null;
  if (raw !== null) {
    try {
      parsed = parseJSON(raw);
    } catch {
      // keep the damaged file aside rather than silently losing Quentin's settings history
      const aside = S.prefsFile.replace(/\.json$/, `.corrupt-${Date.now()}.json`);
      await fsp.copyFile(S.prefsFile, aside).catch(() => {});
      S.log('prefs.json unreadable, kept as', aside);
    }
  }
  // first launch only (no prefs.json yet): Mia speaks the system's language; existing prefs keep theirs
  S.firstLang = raw === null ? S.sysLang : null;
  // SPEC §21.1: older prefs are brought to this version's format (prefs.json.bak-v<old> kept first);
  // fresh prefs start at the current format
  const mig = parsed ? await migrations.migrateFile('prefs', S.prefsFile, parsed, S.log) : null;
  S.prefs = sanitizePrefs(mig ? mig.doc : parsed);
  if (S.prefs.version === undefined) S.prefs.version = migrations.CURRENT.prefs;
  if (raw === null || parsed === null || (mig && mig.upgraded)) await writeJSONAtomic(S.prefsFile, S.prefs).catch(() => {});
}

function effectivePrefs() {
  const p = Object.assign({}, S.prefs);
  if (S.rootOverride) p.projectsRoot = S.rootOverride;
  return JSON.parse(JSON.stringify(p));   // a copy: callers cannot mutate our state by accident
}

function getPrefs() { return effectivePrefs(); }

/** Merge a patch (never the whole object — Slate lost settings that way), persist, notify. */
const sameDir = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * The two big folders must stay apart (SPEC §10: Mia never writes in the engine), and an engine folder
 * must hold a Python: Mia's engine (env\venv) or a ComfyUI portable (python_embeded). Checked only when
 * one of them changes. Throws a readable error.
 */
function checkRoots(before, next) {
  const rootChanged = !sameDir(before.projectsRoot, next.projectsRoot);
  const engineChanged = !sameDir(before.engineRoot, next.engineRoot);
  if (!rootChanged && !engineChanged) return;
  const pr = next.projectsRoot;
  const er = next.engineRoot;
  if (!er) return;                                   // no engine folder (yet): nothing to keep apart
  if (sameDir(pr, er) || isInside(pr, er)) {
    throw userError(tr(rootChanged ? STR.rootInEngine : STR.engineInRoot, { dir: rootChanged ? er : pr }));
  }
  if (isInside(er, pr)) throw userError(tr(STR.engineInRoot, { dir: pr }));
  if (engineChanged) {
    const py = path.join(er, 'env', 'venv', 'Scripts', 'python.exe');
    const portable = path.join(er, 'python_embeded', 'python.exe');
    if (!fs.existsSync(py) && !fs.existsSync(portable)) throw userError(tr(STR.engineNoTools, { file: py }));
  }
}

/** Merge a patch (never the whole object — Slate lost settings that way), persist, notify. */
function setPrefs(patch) {
  return serial('prefs', async () => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return effectivePrefs();
    const p = Object.assign({}, patch);
    // While the projects folder is unreachable the home lists nothing it can open: leaving the
    // board then would save "no tabs" over Quentin's real ones. Keep them for when it comes back.
    if (S.rootMissing) { delete p.openTabs; delete p.activeTab; }
    const before = S.prefs;
    const next = sanitizePrefs(Object.assign({}, before, p));
    checkRoots(before, next);
    const changed = new Set();
    for (const k of new Set([...Object.keys(before), ...Object.keys(next)])) {
      if (JSON.stringify(before[k]) !== JSON.stringify(next[k])) changed.add(k);
    }
    if (!changed.size) return effectivePrefs();
    S.prefs = next;
    await writeJSONAtomic(S.prefsFile, next);
    if (changed.has('projectsRoot') && !S.rootOverride) {
      // a new projects folder: the cache describes the old one, rebuild it from the new folder
      S.lastReconcile = 0;
      S.rootMissing = null;
      await reconcile().catch((e) => S.log('reconcile after root change failed:', e.message));
    }
    const snapshot = effectivePrefs();
    for (const fn of S.prefsListeners) {
      try { fn(snapshot, changed); } catch (e) { S.log('prefs listener failed:', e.message); }
    }
    return snapshot;
  });
}

function onPrefs(fn) {
  S.prefsListeners.add(fn);
  return () => S.prefsListeners.delete(fn);
}

function projectsRoot() { return S.rootOverride || S.prefs.projectsRoot; }

/** Folders the protocol (mia://m/…) and the shell actions may touch outside a project. */
function allowedRoots() {
  const p = effectivePrefs();
  return [p.projectsRoot, places.engineRoot(p), S.userData, ...(p.extraModelRoots || []), ...(p.loraFolders || [])].filter(Boolean);
}

// ---------------------------------------------------------------- names, ids, folders
const NAME_MAX = 120;      // code points of a display name (the rename fields say the same)
const FOLDER_MAX = 80;     // code points of a folder name (Windows' limit is 255 UTF-16 units)

/** The name shown in Mia: anything printable, trimmed, bounded (never half an emoji). */
function cleanDisplayName(name) {
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cutText(s, NAME_MAX).trim();
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
/**
 * The folder name: the display name without what Windows forbids (SPEC §3.1). `fallback` names a
 * folder whose name had nothing usable (« ??? »): a board's by default, STR.untitledFolder for a
 * project — a project folder must not look like a board in Explorer.
 */
function folderName(display, fallback) {
  let s = String(display ?? '').replace(LONE_SURROGATE, '').replace(/[<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
  s = cutText(s, FOLDER_MAX).replace(/[. ]+$/g, '');
  if (!s) s = tr(fallback || STR.untitled);
  if (RESERVED.test(s)) s += '_';
  return s;
}
const projectFolderName = (display) => folderName(display, STR.untitledFolder);

/** How two names are compared: case and accents ignored (« Court metrage » is « Court métrage »), as the assistants match them. */
const nameKey = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** The first `variant(i)` (i = 1 is the name itself) that no entry of `siblings` shows. */
function freeName(siblings, variant) {
  const taken = new Set(siblings.map((p) => nameKey(p.name)));
  for (let i = 1; i < 1000; i++) {
    const name = cleanDisplayName(variant(i));
    if (name && !taken.has(nameKey(name))) return name;
  }
  return cleanDisplayName(`${variant(1)} ${crypto.randomBytes(2).toString('hex')}`);
}

/**
 * A display name no sibling of the same kind shows (the boards of the same place, or the projects),
 * then a free folder for it: the name shown and the folder on disk are chosen apart. A project
 * « Court métrage » beside a board « Court métrage » at the root keeps its name; only its folder becomes
 * « Court métrage (2) » (tidyLocked gives it back when the place is free again).
 * @param {string} parent   the folder the new one goes into
 * @param {Array} siblings  index entries whose names must not be reused
 * @param {object} [fallback] STR entry naming a folder whose name had nothing usable
 */
async function uniqueIn(parent, siblings, variant, fallback) {
  const name = freeName(siblings, variant);
  return { name, dir: await uniqueDir(parent, folderName(name, fallback)) };
}

/** The boards of one place: a project (folderId) or the root (null). */
const boardsIn = (folderId, exceptId) => S.index.projects.filter((p) => (p.folderId || null) === (folderId || null) && p.id !== exceptId);

/** A board name free among the boards of the same project (or of the root): « Plan 01 » may exist in each project. */
function uniqueBoard(parent, folderId, variant, exceptId) {
  return uniqueIn(parent, boardsIn(folderId, exceptId), variant);
}

/** A project (folder of boards) name free among the projects — boards at the root do not count. */
function uniqueFolder(root, variant, exceptId) {
  return uniqueIn(root, (S.index.folders || []).filter((f) => f.id !== exceptId), variant, STR.untitledFolder);
}

/** The project showing this name (case and accents ignored), other than `exceptId`, or null. */
function folderByName(name, exceptId) {
  const k = nameKey(cleanDisplayName(name));
  if (!k) return null;
  return (S.index.folders || []).find((f) => f && f.id !== exceptId && nameKey(f.name) === k) || null;
}

/** « Court métrage (2) » for « Court métrage »: a folder that took a number only because its place was taken. */
function isSuffixed(base, wanted) {
  const m = /^(.*) \((\d+)\)$/.exec(String(base));
  return !!m && Number(m[2]) >= 2 && m[1].toLowerCase() === String(wanted).toLowerCase();
}

/** « Sans titre », « Sans titre 2 »… ; « Plan 12 », « Plan 12 (2) » (a name ending in a digit). */
const numbered = (base) => (i) => (i === 1 ? base : /\d$/.test(base) ? `${base} (${i})` : `${base} ${i}`);

/**
 * A folder change starts or ends (create, rename, duplicate, remove): a reconcile that started
 * before must keep what we set in S.dirs, not what it read on disk half-way through.
 */
function touch(id) {
  S.gen += 1;
  S.touched.set(id, S.gen);
}

/** "<base>", then "<base> (2)", "<base> (3)"… — `except` is the folder being renamed (case-only renames). */
async function uniqueDir(root, base, except) {
  for (let i = 1; i < 1000; i++) {
    const name = i === 1 ? base : `${base} (${i})`;
    const abs = path.join(root, name);
    if (except && abs.toLowerCase() === path.resolve(except).toLowerCase()) return abs;
    try {
      await fsp.access(abs);
    } catch {
      return abs;
    }
  }
  return path.join(root, `${base} ${crypto.randomBytes(3).toString('hex')}`);
}

function newProjectId(taken) {
  for (;;) {
    const id = 'p_' + crypto.randomBytes(3).toString('hex');
    if (!S.dirs.has(id) && !(taken && taken.has(id))) return id;
  }
}

function newFolderId(taken) {
  for (;;) {
    const id = 'f_' + crypto.randomBytes(3).toString('hex');
    if (!S.folderDirs.has(id) && !(taken && taken.has(id))) return id;
  }
}

const validColor = (c) => (typeof c === 'string' && FOLDER_COLORS.includes(c) ? c : null);

/** The tint used least by the projects (then in Chrome's order): new projects do not all look alike. */
function nextColor(extraUsed = []) {
  const used = new Map(COLOR_ROTATION.map((c) => [c, 0]));
  for (const c of [...(S.index.folders || []).map((f) => f.color), ...extraUsed]) {
    if (used.has(c)) used.set(c, used.get(c) + 1);
  }
  let best = COLOR_ROTATION[0];
  for (const c of COLOR_ROTATION) if (used.get(c) < used.get(best)) best = c;
  return best;
}

const emptyGraph = () => ({ version: 1, camera: { x: 0, y: 0, z: 1 }, nodes: [], edges: [], groups: [] });

/** Give a parsed document the minimal shape the editor expects, without touching what it holds. */
function normalizeGraph(g) {
  if (!g || typeof g !== 'object' || Array.isArray(g)) return null;
  if (!Array.isArray(g.nodes)) g.nodes = [];
  if (!Array.isArray(g.edges)) g.edges = [];
  if (!Array.isArray(g.groups)) g.groups = [];
  const c = g.camera || {};
  g.camera = { x: Number(c.x) || 0, y: Number(c.y) || 0, z: Number(c.z) > 0 ? Number(c.z) : 1 };
  if (!g.version) g.version = 1;
  return g;
}

/** Display caches (keys starting with "_") never reach the disk (SPEC §3.2). */
const stripPrivate = (k, v) => (typeof k === 'string' && k.startsWith('_') ? undefined : v);

/**
 * What a board holds, camera aside: a pan or a zoom changes nothing worth a backup, a new
 * « modifié » date or a new thumbnail.
 */
function contentKey(graph) {
  // keys sorted: the same board written by another version of the editor hashes the same
  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (!v || typeof v !== 'object') return v;
    const o = {};
    for (const k of Object.keys(v).sort()) {
      if (!k.startsWith('_') && v[k] !== undefined) o[k] = canon(v[k]);
    }
    return o;
  };
  try {
    const rest = Object.assign({}, graph);
    delete rest.camera;
    return crypto.createHash('sha1').update(JSON.stringify(canon(rest))).digest('hex');
  } catch {
    return null;
  }
}

const files = (dir) => ({
  project: path.join(dir, 'project.json'),
  graph: path.join(dir, 'graph.json'),
  bak: path.join(dir, 'graph.json.bak'),
  thumb: path.join(dir, 'thumb.png')
});
const folderFile = (dir) => path.join(dir, 'folder.json');

// ---------------------------------------------------------------- index entries
const folderEntry = (id) => (id && (S.index.folders || []).find((f) => f.id === id)) || null;
const thumbUrl = (e) => (e.hasThumb ? `mia://p/${e.id}/thumb.png?v=${e.thumbAt || e.updated || 0}` : null);

function publicMeta(e) {
  if (!e) return null;
  const f = folderEntry(e.folderId);
  return {
    id: e.id,
    name: e.name,
    dir: e.dir,
    folderId: e.folderId || null,       // SPEC §18: the project (folder) holding this board, or null (root)
    folderName: f ? f.name : null,
    created: e.created || 0,
    updated: e.updated || 0,
    opened: e.opened || null,
    nodes: e.nodes || 0,
    thumb: thumbUrl(e)
  };
}

/**
 * A project as the home shows it: its boards counted, up to 4 of their thumbnails (most recently
 * modified first), « modifié » = the latest of the folder and of its boards.
 */
function publicFolder(f) {
  if (!f) return null;
  const boards = S.index.projects.filter((p) => p.folderId === f.id)
    .sort((a, b) => (b.updated || 0) - (a.updated || 0));
  return {
    id: f.id,
    name: f.name,
    color: validColor(f.color) || 'grey',
    dir: f.dir,
    created: f.created || 0,
    updated: Math.max(f.updated || 0, ...boards.map((b) => b.updated || 0)),
    boards: boards.length,
    thumbs: boards.filter((b) => b.hasThumb).slice(0, 4).map(thumbUrl)
  };
}

const currentBoards = () => S.index.projects.slice()
  .sort((a, b) => (b.updated || 0) - (a.updated || 0))
  .map((e) => (S.rootMissing ? Object.assign(publicMeta(e), { missing: true }) : publicMeta(e)));

const currentFolders = () => (S.index.folders || []).map(publicFolder)
  .sort((a, b) => b.updated - a.updated)
  .map((f) => (S.rootMissing ? Object.assign(f, { missing: true }) : f));

/** Every index entry's folder as S.dirs / S.folderDirs say (after a move or a folder rename). */
function syncDirs(idx) {
  for (const p of idx.projects) if (S.dirs.has(p.id)) p.dir = S.dirs.get(p.id);
  for (const f of idx.folders || []) if (S.folderDirs.has(f.id)) f.dir = S.folderDirs.get(f.id);
}

// ---------------------------------------------------------------- change events
// folders:changed (SPEC §18.2): several changes in a row (a project removed with its 12 boards
// moved out) make one event, sent once the burst is over. Payload: { reasons, folders, projects }.
let changeTimer = null;
let changeReasons = [];
function changed(reason, info) {
  if (!S.changeListeners.size) return;
  changeReasons.push(Object.assign({ reason }, info || {}));
  if (changeTimer) return;
  changeTimer = setTimeout(() => {
    changeTimer = null;
    const payload = { reasons: changeReasons, reason: changeReasons[0] && changeReasons[0].reason, folders: currentFolders(), projects: currentBoards() };
    changeReasons = [];
    for (const fn of S.changeListeners) {
      try { fn(payload); } catch (e) { S.log('change listener failed:', e.message); }
    }
  }, 40);
}

function onChange(fn) {
  S.changeListeners.add(fn);
  return () => S.changeListeners.delete(fn);
}

/** The projects folder cannot be reached right now: { root, rootMissing, code, message }. */
function status() {
  const m = S.rootMissing;
  return {
    root: projectsRoot(),
    rootMissing: !!m,
    code: m ? m.code || null : null,
    message: m ? tr(STR.rootMissing, { dir: m.dir }) : null
  };
}

function setRootMissing(v) {
  const was = !!S.rootMissing;
  S.rootMissing = v;
  if (was !== !!v) S.log(v ? `projects root unreachable: ${v.dir} (${v.code})` : 'projects root reachable again');
}

/**
 * Can the projects folder be used? A missing folder is created only when it never held a project
 * Mia knows (first run, or a brand new folder chosen in the settings). One that held projects is
 * a drive unplugged or a folder renamed in Explorer: recreating it empty would make every project
 * look lost — it is reported instead (status()), and the cached index is kept as it was.
 */
async function reachRoot(root, idx) {
  try {
    const st = await fsp.stat(root);
    if (st.isDirectory()) {
      setRootMissing(null);
      return true;
    }
    setRootMissing({ dir: root, code: 'ENOTDIR' });
    return false;
  } catch (e) {
    const knownHere = (idx.projects || []).some((p) => p && p.dir && isInside(p.dir, root));
    if (!knownHere) {
      try {
        await fsp.mkdir(root, { recursive: true });
        setRootMissing(null);
        return true;
      } catch (e2) {
        setRootMissing({ dir: root, code: e2.code || 'ERR' });
        return false;
      }
    }
    setRootMissing({ dir: root, code: e.code || 'ERR' });
    return false;
  }
}

const entryOf = (id) => S.index.projects.find((p) => p.id === id) || null;

function projectDir(id) {
  return (typeof id === 'string' && S.dirs.get(id)) || null;
}

function projectById(id) {
  return publicMeta(entryOf(id));
}

function requireDir(id) {
  const dir = projectDir(id);
  if (!dir) throw userError(tr(STR.notFound));
  return dir;
}

/**
 * The folder, checked on disk: a write must never recreate (mkdir -p) a project folder that went
 * away — drive unplugged, folder moved in Explorer — with only one file in it.
 */
async function requireLiveDir(id) {
  const dir = requireDir(id);
  if (await exists(dir)) return dir;
  // renamed or moved within the projects folder (Explorer): the folders tell where it went
  if (!S.rootMissing) await reconcile().catch(() => {});
  const now = projectDir(id);
  if (now && now !== dir && !S.rootMissing && (await exists(now))) return now;
  throw userError(S.rootMissing ? status().message : tr(STR.notFound));
}

// ---- projects (folders of boards, SPEC §18)
function folderDir(id) {
  return (typeof id === 'string' && S.folderDirs.get(id)) || null;
}

function folderById(id) {
  return publicFolder(folderEntry(id));
}

function requireFolder(id) {
  const dir = folderDir(id);
  if (!dir) throw userError(tr(STR.folderNotFound));
  return dir;
}

/** The project folder, checked on disk (renamed in Explorer: the folders tell where it went). */
async function requireLiveFolder(id) {
  const dir = requireFolder(id);
  if (await exists(dir)) return dir;
  if (!S.rootMissing) await reconcile().catch(() => {});
  const now = folderDir(id);
  if (now && !S.rootMissing && (await exists(now))) return now;
  throw userError(S.rootMissing ? status().message : tr(STR.folderNotFound));
}

/** The project whose folder holds this board folder, or null (a board at the root). */
function folderOfDir(boardDir) {
  const parent = path.resolve(path.dirname(boardDir)).toLowerCase();
  for (const [id, d] of S.folderDirs) if (path.resolve(d).toLowerCase() === parent) return id;
  return null;
}

/** The boards Mia knows inside a project folder (by where they are, not by what the index says). */
function boardsInside(dir) {
  return [...S.dirs].filter(([, d]) => isInside(d, dir)).map(([id]) => id);
}

async function countNodes(dir) {
  const g = await readJSON(files(dir).graph, null);
  return g && Array.isArray(g.nodes) ? g.nodes.length : 0;
}

/** The sub-folders of `dir`, by name (null when it cannot be read). */
async function subdirs(dir) {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return null;
  }
}

/** A folder on disk → a board { dir, pj, adopt, thumbAt }, or null when it is not one. */
async function scanBoard(dir) {
  const raw = await readJSON(path.join(dir, 'project.json'), null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;   // not a Mia board
  const pj = (await migrations.migrateFile('project', path.join(dir, 'project.json'), raw, S.log)).doc;   // SPEC §21.1
  let adopt = false;
  if (typeof pj.id !== 'string' || !ID_RE.test(pj.id)) {
    // a project.json written by hand (no id, or a broken one): a board beside it says it is ours
    if (!(await exists(path.join(dir, 'graph.json')))) return null;
    adopt = true;
  }
  const thumbSt = await fsp.stat(path.join(dir, 'thumb.png')).catch(() => null);
  return { dir, pj, adopt, thumbAt: thumbSt ? Math.round(thumbSt.mtimeMs) : 0 };
}

/**
 * A folder of the root that is not a board → a project { dir, fj, adopt, boards }: it has a
 * folder.json, or it holds boards (a plain folder of boards is adopted, SPEC §18.1). One level only.
 */
async function scanFolder(dir) {
  const raw = await readJSON(folderFile(dir), null);
  const fj = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (await migrations.migrateFile('folder', folderFile(dir), raw, S.log)).doc   // SPEC §21.1
    : null;
  const names = (await subdirs(dir)) || [];
  const boards = (await mapLimit(names, 8, (n) => scanBoard(path.join(dir, n)))).filter(Boolean);
  if (!fj && !boards.length) return null;
  return { dir, fj: fj || {}, adopt: !fj || typeof fj.id !== 'string' || !FID_RE.test(fj.id), boards };
}

/**
 * Give one id to one folder: when the same id shows twice (a folder duplicated in Explorer), the
 * folder the index already knew keeps it and the other gets a fresh one, named after its folder —
 * otherwise mia:// and the engine would mix the two up. `rewrite(victim, newId)` persists the change.
 */
async function dedupeIds(scans, idOf, cached, fresh, rewrite) {
  const seen = new Map();
  for (const s of scans) {
    const id = idOf(s);
    if (!seen.has(id)) {
      seen.set(id, s);
      continue;
    }
    const prev = seen.get(id);
    const known = cached.get(id);
    const sIsKnown = !!known && String(known.dir).toLowerCase() === s.dir.toLowerCase();
    let victim = s;
    if (sIsKnown) {
      victim = prev;
      seen.set(id, s);
    }
    const nid = fresh(new Set(seen.keys()));
    await rewrite(victim, nid);
    seen.set(nid, victim);
    S.log('duplicate id', id, '→', nid, 'for', victim.dir);
  }
  return seen;
}

/** project.json says another project than where the board is (moved in Explorer): the disk wins. */
function fixFolderId(id, folderId) {
  serial('p:' + id, async () => {
    const dir = projectDir(id);
    if (!dir) return;
    const pj = await readJSON(files(dir).project, null);
    if (!pj || pj.id !== id || (pj.folderId ?? null) === folderId) return;
    pj.folderId = folderId;
    await writeJSONAtomic(files(dir).project, pj).catch((e) => S.log('folderId fix failed:', dir, e.message));
  }).catch(() => {});
}

/**
 * Rebuild the index from the folders: the disk is the truth —
 *   <root>\<Planche>\project.json            a board without project (« sans projet »)
 *   <root>\<Projet>\folder.json              a project (folder of boards, SPEC §18)
 *   <root>\<Projet>\<Planche>\project.json   a board of that project
 * Cheap enough (one small read per board) to run at start and again when the home page lists
 * boards, so a folder copied in by hand shows up without a restart.
 */
function reconcile() {
  if (S.reconciling) return S.reconciling;
  S.reconciling = withIndex(async (idx) => {
    const gen0 = S.gen;
    const root = projectsRoot();
    if (!Array.isArray(idx.folders)) idx.folders = [];
    if (!(await reachRoot(root, idx))) {
      // unreachable: keep the index as it is (never rewrite it with "no projects")
      S.lastReconcile = Date.now();
      return SKIP_WRITE;
    }
    const names = await subdirs(root);
    if (!names) {
      setRootMissing({ dir: root, code: 'ERR' });
      S.lastReconcile = Date.now();
      return SKIP_WRITE;
    }
    const top = await mapLimit(names, 8, async (n) => {
      const dir = path.join(root, n);
      const board = await scanBoard(dir);
      if (board) return { board };
      const folder = await scanFolder(dir);
      return folder ? { folder } : null;
    });
    const now = Date.now();

    // ---- projects (folders): adopted ones get an id (and a name, the folder's) written back
    const cachedF = new Map(idx.folders.map((f) => [f.id, f]));
    const folderScans = top.filter((t) => t && t.folder).map((t) => t.folder);
    const takenF = new Set(folderScans.filter((f) => !f.adopt).map((f) => f.fj.id));
    const tints = [];
    for (const f of folderScans) {
      if (!f.adopt) continue;
      const nid = newFolderId(takenF);
      takenF.add(nid);
      const color = validColor(f.fj.color) || nextColor(tints);
      tints.push(color);
      f.fj = Object.assign({}, f.fj, {
        id: nid,
        name: cleanDisplayName(f.fj.name) || path.basename(f.dir),
        color,
        created: Number(f.fj.created) || now,
        updated: Number(f.fj.updated) || now,
        version: f.fj.version || 1
      });
      await writeJSONAtomic(folderFile(f.dir), f.fj).catch((e) => S.log('folder adopt write failed:', f.dir, e.message));
      S.log('folder of boards adopted as project', nid, 'for', f.dir);
    }
    const seenF = await dedupeIds(folderScans, (f) => f.fj.id, cachedF,
      (seen) => { const id = newFolderId(new Set([...seen, ...takenF])); takenF.add(id); return id; },
      async (victim, nid) => {
        victim.fj = Object.assign({}, victim.fj, { id: nid, name: path.basename(victim.dir) });
        await writeJSONAtomic(folderFile(victim.dir), victim.fj).catch(() => {});
      });

    // ---- boards, at the root and one level down in each project
    const boardScans = top.filter((t) => t && t.board).map((t) => Object.assign(t.board, { folderId: null }));
    for (const [fid, f] of seenF) for (const b of f.boards) boardScans.push(Object.assign(b, { folderId: fid }));
    const cached = new Map(idx.projects.map((p) => [p.id, p]));
    const taken = new Set(boardScans.filter((s) => !s.adopt).map((s) => s.pj.id));
    for (const s of boardScans) {
      if (!s.adopt) continue;
      const nid = newProjectId(taken);
      taken.add(nid);
      s.pj = Object.assign({}, s.pj, {
        id: nid,
        name: cleanDisplayName(s.pj.name) || path.basename(s.dir),
        folderId: s.folderId,
        created: Number(s.pj.created) || now,
        updated: Number(s.pj.updated) || now,
        version: s.pj.version || 1
      });
      await writeJSONAtomic(path.join(s.dir, 'project.json'), s.pj).catch((e) => S.log('adopt write failed:', s.dir, e.message));
      S.log('project.json without id adopted as', s.pj.id, 'for', s.dir);
    }
    const seen = await dedupeIds(boardScans, (s) => s.pj.id, cached,
      (ids) => { const id = newProjectId(new Set([...ids, ...taken])); taken.add(id); return id; },
      async (victim, nid) => {
        // the copy is named after its folder (« Plan 01 - Copie »): two identical cards help nobody
        victim.pj = Object.assign({}, victim.pj, { id: nid, name: path.basename(victim.dir), folderId: victim.folderId });
        await writeJSONAtomic(path.join(victim.dir, 'project.json'), victim.pj).catch(() => {});
      });

    const projects = [];
    const fixes = [];
    for (const s of seen.values()) {
      const pj = s.pj;
      const old = cached.get(pj.id);
      const updated = Number(pj.updated) || 0;
      const nodes = old && old.updated === updated && old.dir === s.dir ? old.nodes : await countNodes(s.dir);
      // a board moved by hand into (or out of) a project: its project.json follows (a root board
      // that never had the key is left untouched)
      if (pj.folderId === undefined ? s.folderId !== null : pj.folderId !== s.folderId) fixes.push([pj.id, s.folderId]);
      projects.push({
        id: pj.id,
        name: cleanDisplayName(pj.name) || path.basename(s.dir),
        dir: s.dir,
        folderId: s.folderId,
        created: Number(pj.created) || 0,
        updated,
        opened: Number(pj.opened) || null,
        nodes,
        hasThumb: !!s.thumbAt,
        thumbAt: s.thumbAt || 0
      });
    }
    const folders = [...seenF.values()].map((f) => ({
      id: f.fj.id,
      name: cleanDisplayName(f.fj.name) || path.basename(f.dir),
      dir: f.dir,
      color: validColor(f.fj.color) || 'grey',
      created: Number(f.fj.created) || 0,
      updated: Number(f.fj.updated) || 0
    }));

    // A create / rename / move / duplicate / remove that ran while we were reading the disk wins:
    // what it set in S.dirs / S.folderDirs is the truth, what we read may be its half-way state
    // (folder not renamed yet, project.json not written yet). Its own index update is queued right after us.
    const moving = new Set([...S.touched].filter(([, g]) => g > gen0).map(([id]) => id));
    const kept = projects.filter((p) => !moving.has(p.id));
    const keptF = folders.filter((f) => !moving.has(f.id));
    for (const id of moving) {
      if (id.startsWith('f_')) {
        const dir = S.folderDirs.get(id);
        const old = cachedF.get(id);
        if (dir && old) keptF.push(Object.assign({}, old, { dir }));
      } else {
        const dir = S.dirs.get(id);
        const old = cached.get(id);
        if (dir && old) kept.push(Object.assign({}, old, { dir }));
      }
    }
    kept.sort((a, b) => b.updated - a.updated);
    keptF.sort((a, b) => a.name.localeCompare(b.name));
    const dirs = new Map(kept.map((p) => [p.id, p.dir]));
    const fdirs = new Map(keptF.map((f) => [f.id, f.dir]));
    for (const id of moving) {
      const [mine, live] = id.startsWith('f_') ? [fdirs, S.folderDirs] : [dirs, S.dirs];
      if (live.has(id)) mine.set(id, live.get(id));
      else mine.delete(id);
    }
    for (const [id, g] of S.touched) if (g <= gen0) S.touched.delete(id);

    const before = JSON.stringify([idx.projects, idx.folders]);
    idx.projects = kept;
    idx.folders = keptF;
    S.dirs = dirs;
    S.folderDirs = fdirs;
    S.lastReconcile = Date.now();
    for (const [id, fid] of fixes) if (!moving.has(id)) fixFolderId(id, fid);
    // a project whose folder had to take « (2) » (a board of that name sat at the root) gets its own
    // name back once the place is free — retryPending moves it, under the 'tree' lock
    for (const f of keptF) {
      if (moving.has(f.id) || S.pendingFolder.has(f.id)) continue;
      const wanted = projectFolderName(f.name);
      if (isSuffixed(path.basename(f.dir), wanted) && !(await exists(path.join(path.dirname(f.dir), wanted)))) S.pendingFolder.add(f.id);
    }
    const same = JSON.stringify([kept, keptF]) === before;
    if (!same) changed('reconcile');
    return same ? SKIP_WRITE : true;
  }).finally(() => { S.reconciling = null; });
  return S.reconciling;
}

// ---------------------------------------------------------------- init
/**
 * @param {object} o
 * @param {string} o.userData     %APPDATA%\Mia (or a test folder)
 * @param {string} [o.documents]  the user's Documents folder (fallback projects root)
 * @param {string} [o.projectsRootOverride]  tests: use this root without saving it
 * @param {Function} [o.log]
 * @param {Function} [o.trash]    tests: (abs) → Promise, instead of the Recycle Bin
 */
async function init(o) {
  S.userData = o.userData;
  S.documents = o.documents || path.join(os.homedir(), 'Documents');
  S.dataDir = path.join(o.userData, 'data');
  S.prefsFile = path.join(S.dataDir, 'prefs.json');
  S.indexFile = path.join(S.dataDir, 'index.json');
  S.rootOverride = o.projectsRootOverride ? path.resolve(o.projectsRootOverride) : null;
  S.sysLang = o.lang === 'en' || o.lang === 'fr' ? o.lang : null;   // the system's language (main.js)
  if (o.log) S.log = o.log;
  if (typeof o.trash === 'function') S.trash = o.trash;
  await fsp.mkdir(path.join(S.dataDir, 'logs'), { recursive: true });
  await loadPrefs();
  const cachedIndex = await readJSON(S.indexFile, null);
  if (cachedIndex && Array.isArray(cachedIndex.projects)) {
    if (!Array.isArray(cachedIndex.folders)) cachedIndex.folders = [];   // an index from before SPEC §18
    S.index = cachedIndex;
    // usable at once for lookups; reconcile() replaces it with what the disk says
    S.dirs = new Map(cachedIndex.projects.filter((p) => p && p.id && p.dir).map((p) => [p.id, p.dir]));
    S.folderDirs = new Map(cachedIndex.folders.filter((f) => f && f.id && f.dir).map((f) => [f.id, f.dir]));
  }
  // The window does not wait for the scan: list/open await ready() instead.
  S.readyPromise = reconcile().catch((e) => S.log('initial reconcile failed:', e.message));
  return effectivePrefs();
}

function ready() { return S.readyPromise || Promise.resolve(); }

// ---------------------------------------------------------------- projects
/**
 * The projects, most recently modified first (the home page applies Quentin's own order on top).
 * While the projects folder is unreachable: the projects Mia knew, each flagged `missing:true`
 * (status() says why) — never an empty list that would read « no project yet ».
 */
async function list() {
  await ready();
  // unreachable: look again at every call (a stat), so « Réessayer » sees the drive come back
  if (S.rootMissing || Date.now() - S.lastReconcile > 3000) await reconcile();
  retryPending();
  return currentBoards();
}

/** The projects folder, created if needed — or the readable reason it cannot be used. */
async function requireRoot() {
  const root = projectsRoot();
  const ok = await serial('index', () => reachRoot(root, S.index));
  if (!ok) {
    const code = S.rootMissing && S.rootMissing.code;
    throw userError(code === 'ENOENT' || code === 'ENOTDIR' ? tr(STR.rootMissing, { dir: root }) : tr(STR.rootFailed, { dir: root }));
  }
  return root;
}

/**
 * A new board: { name?, folderId?, recipe? } — in the project `folderId` (SPEC §18.2), else at the
 * root (« sans projet »). The recipe only names it; the interface fills the board.
 */
async function create(payload) {
  await ready();
  const o = payload && typeof payload === 'object' ? payload : {};
  let display = cleanDisplayName(o.name);
  if (!display && o.recipe) display = await recipeLabel(o.recipe);
  if (!display) display = tr(STR.untitled);
  const fid = o.folderId ? String(o.folderId) : null;
  if (fid) requireFolder(fid);

  const root = await requireRoot();
  const r = await tree(() => createLocked(display, fid, root));
  changed('board-create', { boardId: r.id, folderId: fid });
  return r;
}

async function createLocked(display, fid, root) {
  const parent = fid ? await requireLiveFolder(fid) : root;
  const id = newProjectId();
  const now = Date.now();
  touch(id);
  let dir;
  for (let attempt = 0; ; attempt++) {
    // « Nouvelle planche », « Nouvelle planche 2 »… among the boards of that place; the folder is
    // chosen apart (« Court métrage (2) » when a project « Court métrage » sits at the root)
    const u = await uniqueBoard(parent, fid, numbered(display));
    dir = u.dir;
    try {
      await fsp.mkdir(dir);           // not recursive: fails if another create took the name meanwhile
      display = u.name;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' || attempt > 5) throw userError(fsMessage(e), e);
    }
  }
  S.dirs.set(id, dir);
  touch(id);
  const f = files(dir);
  try {
    // project.json first: whatever happens next, the folder is recognisable as a Mia project
    await writeJSONAtomic(f.project, { id, name: display, folderId: fid, created: now, updated: now, opened: now, version: 1 });
    await writeJSONAtomic(f.graph, emptyGraph(), 1);
    for (const sub of ['media', 'cache', 'outputs']) await fsp.mkdir(path.join(dir, sub), { recursive: true });
  } catch (e) {
    throw userError(fsMessage(e), e);
  }
  S.goodGraph.add(id);
  S.savedKey.set(id, contentKey(emptyGraph()));
  const entry = { id, name: display, dir, folderId: fid, created: now, updated: now, opened: now, nodes: 0, hasThumb: false, thumbAt: 0 };
  await withIndex((idx) => {
    idx.projects = [entry, ...idx.projects.filter((p) => p.id !== id)];
  });
  return Object.assign({ ok: true }, publicMeta(entry));
}

/**
 * Let the folder follow the display name (SPEC §3.1: renamed project = renamed folder). Not while
 * one of its jobs is queued or running (the engine writes into it), nor when a file is held (a
 * video playing): then the move waits for the next rename or the next open. Returns the folder.
 */
async function followName(id, dir, display) {
  const wanted = folderName(display);
  if (path.basename(dir) === wanted) {
    S.pendingMove.delete(id);
    return dir;
  }
  const target = await uniqueDir(path.dirname(dir), wanted, dir);
  if (target === dir) {
    S.pendingMove.delete(id);
    return dir;
  }
  if (busy(id)) {
    S.pendingMove.add(id);
    S.log('folder rename postponed (job running):', dir, '→', target);
    return dir;
  }
  touch(id);
  try {
    await renameRetry(dir, target, 4);
  } catch (e) {
    S.pendingMove.add(id);
    S.log('folder rename postponed:', dir, '→', target, e.code || e.message);
    return dir;
  }
  S.dirs.set(id, target);
  touch(id);
  S.pendingMove.delete(id);
  return target;
}

function busy(id) {
  try { return !!S.isBusy(id); } catch { return false; }
}

/** "Animer une image" for a project created from that recipe without a name. */
async function recipeLabel(recipeId) {
  const safe = String(recipeId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return '';
  const r = await readJSON(path.join(__dirname, '..', 'src', 'catalog', 'recipes', `${safe}.json`), null);
  return r && r.label ? cleanDisplayName(r.label[lang()] ?? r.label.fr) : '';
}

/** Rename = new name in project.json AND the folder renamed (SPEC §3.1). */
async function rename(id, name) {
  await ready();
  const display = cleanDisplayName(name);
  if (!display) throw userError(tr(STR.emptyName));
  requireDir(id);
  let freed = null;   // the folder left behind: a « (2) » beside it may drop its number
  const r = await serial('p:' + id, async () => {
    const dir = requireDir(id);
    const pj = (await readJSON(files(dir).project, null)) || { id, created: Date.now(), version: 1 };
    const now = Date.now();
    pj.name = display;
    pj.updated = now;
    delete pj.nameBeforeMove;   // named by Quentin: a later move has no older name to give back
    // a playing video or a running job holds the folder: the name still changes, the folder follows later
    const newDir = await followName(id, dir, display);
    if (newDir !== dir) freed = path.dirname(dir);
    try {
      await writeJSONAtomic(files(newDir).project, pj);
    } catch (e) {
      throw userError(fsMessage(e), e);
    }
    const meta = await withIndex((idx) => {
      let p = idx.projects.find((x) => x.id === id);
      if (!p) {
        // a reconcile running meanwhile may have missed it: put it back rather than lose it
        p = { id, name: display, dir: newDir, folderId: folderOfDir(newDir), created: Number(pj.created) || now, updated: now, opened: Number(pj.opened) || null, nodes: 0, hasThumb: fs.existsSync(files(newDir).thumb), thumbAt: now };
        idx.projects.unshift(p);
      }
      Object.assign(p, { name: display, dir: newDir, updated: now });
      return publicMeta(p);
    });
    changed('board-rename', { boardId: id });
    return Object.assign({ ok: true }, meta || publicMeta({ id, name: display, dir: newDir, updated: now }));
  });
  if (freed) await tree(() => tidyLocked(freed));
  return r;
}

// Big media and outputs are hard-linked into a duplicate rather than copied (same volume, instant,
// no extra space). Safe because Mia never rewrites such a file in place: every run gets a new
// folder and proxies are written beside and renamed over.
const LINK_MIN_BYTES = 64 * 1024 * 1024;

async function copyTree(src, dst, skip) {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const d of entries) {
    const a = path.join(src, d.name);
    const b = path.join(dst, d.name);
    if (d.isDirectory()) {
      await copyTree(a, b);
    } else if (d.isFile()) {
      if (d.name.endsWith('.tmp') || (skip && skip.has(d.name.toLowerCase()))) continue;
      const st = await fsp.stat(a);
      if (st.size >= LINK_MIN_BYTES) {
        try {
          await fsp.link(a, b);
          continue;
        } catch { /* another volume, or links refused: copy */ }
      }
      await fsp.copyFile(a, b);
    }
  }
}

/** A copy of the board, in the same project (SPEC §18.2). */
async function duplicate(id) {
  await ready();
  requireDir(id);
  const r = await tree(() => duplicateLocked(id));
  changed('board-duplicate', { boardId: r.id, folderId: r.folderId });
  return r;
}

async function duplicateLocked(id) {
  const src = requireDir(id);
  const fid = folderOfDir(src);
  // wait for any save of the source in flight, so the copy is a coherent snapshot
  await serial('p:' + id, async () => {});
  const pj = (await readJSON(files(src).project, null)) || {};
  // « Plan 12 (copie) », then « Plan 12 (copie 2) »… — a copy of a copy starts from the original name
  const copyRe = /\s\((?:copie|copy)(?: \d+)?\)$/i;
  const base = cutText((cleanDisplayName(pj.name) || path.basename(src)).replace(copyRe, ''), NAME_MAX - 12).trim();
  const nid = newProjectId();
  touch(nid);
  const u = await uniqueBoard(path.dirname(src), fid, (i) => base + (i === 1 ? tr(STR.copySuffix) : tr(STR.copySuffixN, { n: i })));
  const display = u.name;
  const dst = u.dir;
  try {
    // project.json last: a half-made copy is never taken for a project (nor for a duplicate id)
    await copyTree(src, dst, new Set(['project.json']));
  } catch (e) {
    fsp.rm(dst, { recursive: true, force: true }).catch(() => {});   // our own half-copy, never user data
    throw userError(fsMessage(e), e);
  }
  const now = Date.now();
  await writeJSONAtomic(files(dst).project, { id: nid, name: display, folderId: fid, created: now, updated: now, opened: null, version: 1 });
  // (thumb.png is small, so it was copied, never linked: the copy's next capture cannot touch the source)
  S.dirs.set(nid, dst);
  touch(nid);
  if (S.goodGraph.has(id)) S.goodGraph.add(nid);
  const srcEntry = entryOf(id);
  const hasThumb = fs.existsSync(files(dst).thumb);
  const entry = {
    id: nid, name: display, dir: dst, folderId: fid, created: now, updated: now, opened: null,
    nodes: srcEntry ? srcEntry.nodes : await countNodes(dst), hasThumb, thumbAt: hasThumb ? now : 0
  };
  await withIndex((idx) => {
    idx.projects = [entry, ...idx.projects.filter((p) => p.id !== nid)];
  });
  return Object.assign({ ok: true }, publicMeta(entry));
}

/** To the Recycle Bin (reversible), never fs.rm: a board holds hours of GPU work. */
async function remove(id) {
  await ready();
  requireDir(id);
  const folderId = (entryOf(id) || {}).folderId || null;
  await tree(async () => {
    const parent = path.dirname(requireDir(id));
    await removeLocked(id);
    await tidyLocked(parent);   // its name is free: a « Court métrage (2) » beside it drops the number
  });
  changed('board-remove', { boardId: id, folderId });
  return { ok: true };
}

async function removeLocked(id) {
  const dir = requireDir(id);
  const name = (entryOf(id) || {}).name || path.basename(dir);
  // the engine writes into the folder of a queued or running job: trashing it would lose the work
  if (busy(id)) throw userError(tr(STR.busyRemove, { name }));
  await serial('p:' + id, async () => {
    const live = requireDir(id);
    touch(id);
    try {
      await S.trash(live);
    } catch (e) {
      throw userError(tr(STR.trashFailed, { name }), e);
    }
    S.dirs.delete(id);
    touch(id);
  });
  forget(id);
  await withIndex((idx) => {
    idx.projects = idx.projects.filter((p) => p.id !== id);
  });
}

/** A board gone from Mia: drop what was remembered about it. */
function forget(id) {
  S.readOnly.delete(id);
  S.goodGraph.delete(id);
  S.lastThumb.delete(id);
  S.savedKey.delete(id);
  S.openedAt.delete(id);
  S.pendingMove.delete(id);
}

// ---------------------------------------------------------------- projects = folders of boards (SPEC §18)
/**
 * Move a board into the project `folderId` (or to the root with null): its folder moves on disk,
 * its id stays (open tabs, mia://, the engine follow). Refused while one of its jobs is queued or
 * running — the engine writes into that folder.
 */
async function move(id, folderId) {
  await ready();
  requireDir(id);
  const fid = folderId ? String(folderId) : null;
  if (fid) requireFolder(fid);
  const from = (entryOf(id) || {}).folderId || null;
  const r = await tree(async () => {
    const res = await moveLocked(id, fid);
    if (res.unchanged) return res;
    // the place it left is free: « Court métrage (2) » (a project named like this board) drops its number
    if (await tidyLocked(res.left)) return Object.assign(res, publicMeta(entryOf(id)) || {});
    return res;
  });
  delete r.left;
  if (!r.unchanged) changed('board-move', { boardId: id, folderId: fid, from });
  return r;
}

/** move(), the 'tree' lock already held. */
async function moveLocked(id, fid) {
  const name0 = (entryOf(id) || {}).name || path.basename(requireDir(id));
  if (busy(id)) throw userError(tr(STR.busyMove, { name: name0 }));
  return serial('p:' + id, async () => {
    const dir = await requireLiveDir(id);
    const parent = fid ? await requireLiveFolder(fid) : await requireRoot();
    const e = entryOf(id);
    if (path.resolve(path.dirname(dir)).toLowerCase() === path.resolve(parent).toLowerCase()) {
      return Object.assign({ ok: true, unchanged: true }, publicMeta(e) || { id, dir });
    }
    if (busy(id)) throw userError(tr(STR.busyMove, { name: name0 }));   // queued while we waited
    const pj = (await readJSON(files(dir).project, null)) || { id, created: Date.now(), version: 1 };
    const display = cleanDisplayName(pj.name) || (e && e.name) || path.basename(dir);
    // The name shown stays: only the folder on disk takes « (2) » when its place is taken over there
    // (a project or a stray folder of that name). When another board of that place already SHOWS
    // this name, the moved one becomes « Plan 01 (2) » and remembers its own name, given back as soon
    // as it is free where it goes next (« Annuler » brings it back under its name).
    const siblings = boardsIn(fid, id);
    const taken = new Set(siblings.map((p) => nameKey(p.name)));
    const own = typeof pj.nameBeforeMove === 'string' ? cleanDisplayName(pj.nameBeforeMove) : '';
    let name = display;
    if (own && !taken.has(nameKey(own))) name = own;
    else if (taken.has(nameKey(display))) name = freeName(siblings, numbered(own || display));
    if (name === own || (!own && name === display)) delete pj.nameBeforeMove;
    else if (name !== display) pj.nameBeforeMove = own || display;
    const target = await uniqueDir(parent, folderName(name));
    touch(id);
    try {
      await renameRetry(dir, target, 6);
    } catch (err) {
      const held = ['EPERM', 'EACCES', 'EBUSY'].includes(err.code);
      throw userError(held ? tr(STR.moveLocked, { name: display }) : fsMessage(err), err);
    }
    S.dirs.set(id, target);
    touch(id);
    S.pendingMove.delete(id);     // the folder was named after the display name just now
    pj.id = id;
    pj.name = name;
    pj.folderId = fid;
    await writeJSONAtomic(files(target).project, pj).catch((err) => S.log('project.json after move failed:', err.message));
    const meta = await withIndex((idx) => {
      let p = idx.projects.find((x) => x.id === id);
      if (!p) {
        p = { id, created: Number(pj.created) || 0, updated: Number(pj.updated) || 0, opened: Number(pj.opened) || null, nodes: 0, hasThumb: fs.existsSync(files(target).thumb), thumbAt: Date.now() };
        idx.projects.unshift(p);
      }
      Object.assign(p, { name, dir: target, folderId: fid });
      return publicMeta(p);
    });
    // renamedFrom: the name changed on the way (« Rangée dans « Court métrage » sous le nom « Plan 01 (2) » »);
    // nameRestored: it is its own name given back
    const renamed = name !== display ? { renamedFrom: display, nameRestored: name === own } : {};
    return Object.assign({ ok: true }, meta, renamed, { left: path.dirname(dir) });
  });
}

/**
 * A name was freed in `parent` (a board moved out or removed, a project renamed or removed): the
 * folders that had to take a number because of it drop it when they can — « Court métrage (2) » becomes
 * « Court métrage » again. Only a folder named exactly « <its name> (n) » is touched: a folder Quentin
 * renamed himself in Explorer stays as he named it. A busy board or a held file: the follow* helpers
 * postpone it (pendingFolder / pendingMove). The 'tree' lock is held. Never throws. → anything moved?
 */
async function tidyLocked(parent) {
  if (!parent || S.rootMissing) return false;
  const p0 = path.resolve(parent).toLowerCase();
  const here = (d) => !!d && path.resolve(path.dirname(d)).toLowerCase() === p0;
  const due = async (dir, wanted) => here(dir) && isSuffixed(path.basename(dir), wanted) && !(await exists(path.join(parent, wanted)));
  let moved = false;
  try {
    for (const f of (S.index.folders || []).slice()) {
      const dir = S.folderDirs.get(f.id);
      if (!(await due(dir, projectFolderName(f.name)))) continue;
      const r = await followFolder(f.id, f.name);
      if (r.moved) {
        moved = true;
        changed('folder-rename', { folderId: f.id, tidy: true });
      }
    }
    for (const b of S.index.projects.slice()) {
      const dir = S.dirs.get(b.id);
      if (!(await due(dir, folderName(b.name)))) continue;
      const now = await serial('p:' + b.id, async () => {
        const d = S.dirs.get(b.id);
        return d && here(d) ? followName(b.id, d, b.name) : d;
      });
      if (now && now !== dir) {
        moved = true;
        changed('board-rename', { boardId: b.id, tidy: true });
      }
    }
  } catch (e) {
    S.log('folder tidy failed:', e.message);
  }
  if (moved) await withIndex((idx) => { syncDirs(idx); });
  return moved;
}

/** The projects (folders of boards), most recently modified first: { id, name, color, boards, thumbs… }. */
async function listFolders() {
  await ready();
  if (S.rootMissing || Date.now() - S.lastReconcile > 3000) await reconcile();
  retryPending();
  return currentFolders();
}

/**
 * The project showing this name (case and accents ignored, « Court metrage » finds « Court métrage »), or
 * null — for the assistants' bridge, which reuses a project rather than making a second one.
 */
async function findFolderByName(name) {
  await ready();
  if (S.rootMissing || Date.now() - S.lastReconcile > 3000) await reconcile().catch(() => {});
  return publicFolder(folderByName(name));
}

/**
 * A new, empty project: <root>\<Name>\folder.json. → { ok, id, name, color, existed, … }
 * Its name is unique among the PROJECTS only (« Court métrage 2 » when a project « Court métrage » exists);
 * a board or a stray folder of that name at the root only changes the folder on disk (« Court métrage (2) »).
 * `reuse: true` (asked by the caller): a project of that name is handed back (existed:true) instead.
 */
async function createFolder(payload) {
  await ready();
  const o = payload && typeof payload === 'object' ? payload : { name: payload };
  let display = cleanDisplayName(o.name) || tr(STR.untitledFolder);
  if (o.color != null && o.color !== '' && !validColor(o.color)) throw userError(tr(STR.badColor));
  const root = await requireRoot();
  const r = await tree(async () => {
    if (o.reuse && cleanDisplayName(o.name)) {
      if (Date.now() - S.lastReconcile > 3000) await reconcile().catch(() => {});
      const hit = folderByName(display);
      if (hit && S.folderDirs.has(hit.id)) return Object.assign({ ok: true, existed: true }, publicFolder(hit));
    }
    const id = newFolderId();
    touch(id);
    let dir;
    for (let attempt = 0; ; attempt++) {
      const u = await uniqueFolder(root, numbered(display));
      try {
        await fsp.mkdir(u.dir);         // not recursive: fails if a board or project took the name meanwhile
        dir = u.dir;
        display = u.name;
        break;
      } catch (e) {
        if (e.code !== 'EEXIST' || attempt > 5) throw userError(fsMessage(e), e);
      }
    }
    const now = Date.now();
    const fj = { id, name: display, color: validColor(o.color) || nextColor(), created: now, updated: now, version: 1 };
    try {
      await writeJSONAtomic(folderFile(dir), fj);
    } catch (e) {
      fsp.rmdir(dir).catch(() => {});   // our own empty folder
      throw userError(fsMessage(e), e);
    }
    S.folderDirs.set(id, dir);
    touch(id);
    const entry = { id, name: display, dir, color: fj.color, created: now, updated: now };
    await withIndex((idx) => {
      idx.folders = [entry, ...(idx.folders || []).filter((f) => f.id !== id)];
    });
    return Object.assign({ ok: true, existed: false }, publicFolder(entry));
  });
  if (!r.existed) changed('folder-create', { folderId: r.id });
  return r;
}

/**
 * Let the project's folder follow its name, holding the queues of every board inside (no save
 * lands in the old place half-way). Not while one of its boards has a job queued or running, nor
 * when a file is held: then it waits (retryPending). → { dir, moved }
 */
async function followFolder(id, display) {
  const dir = requireFolder(id);
  const wanted = projectFolderName(display);
  if (path.basename(dir) === wanted) {
    S.pendingFolder.delete(id);
    return { dir, moved: false };
  }
  const target = await uniqueDir(path.dirname(dir), wanted, dir);
  if (target === dir) {
    S.pendingFolder.delete(id);
    return { dir, moved: false };
  }
  const inside = boardsInside(dir);
  if (inside.some(busy)) {
    S.pendingFolder.add(id);
    S.log('project folder rename postponed (job running):', dir, '→', target);
    return { dir, moved: false };
  }
  return serialAll(inside.map((b) => 'p:' + b), async () => {
    const boards = boardsInside(dir);
    if (boards.some(busy)) {
      S.pendingFolder.add(id);
      return { dir, moved: false };
    }
    touch(id);
    boards.forEach(touch);
    try {
      await renameRetry(dir, target, 4);
    } catch (e) {
      S.pendingFolder.add(id);
      S.log('project folder rename postponed:', dir, '→', target, e.code || e.message);
      return { dir, moved: false };
    }
    S.folderDirs.set(id, target);
    for (const b of boards) S.dirs.set(b, path.join(target, path.relative(dir, S.dirs.get(b))));
    touch(id);
    boards.forEach(touch);
    S.pendingFolder.delete(id);
    return { dir: target, moved: true };
  });
}

/**
 * Rename a project: folder.json, then its folder on disk (boards keep their ids; mia:// follows).
 * Same rule as createFolder: the name is unique among the projects (another project's exact name is
 * refused with a sentence), and a board of that name at the root only changes the folder on disk.
 */
async function renameFolder(id, name) {
  await ready();
  const display = cleanDisplayName(name);
  if (!display) throw userError(tr(STR.emptyName));
  requireFolder(id);
  const r = await tree(async () => {
    const other = folderByName(display, id);
    if (other) throw userError(tr(STR.folderNameTaken, { name: other.name }));
    const dir0 = await requireLiveFolder(id);
    const e = folderEntry(id) || {};
    const now = Date.now();
    const fj = (await readJSON(folderFile(dir0), null)) || { created: e.created || now, color: e.color, version: 1 };
    Object.assign(fj, { id, name: display, updated: now });
    if (!validColor(fj.color)) fj.color = validColor(e.color) || 'grey';
    try {
      await writeJSONAtomic(folderFile(dir0), fj);   // the name first: a postponed folder move loses nothing
    } catch (err) {
      throw userError(fsMessage(err), err);
    }
    const { dir } = await followFolder(id, display);
    const meta = await withIndex((idx) => {
      syncDirs(idx);
      let f = (idx.folders || []).find((x) => x.id === id);
      if (!f) {
        f = { id, created: Number(fj.created) || now, color: fj.color };
        idx.folders.unshift(f);
      }
      Object.assign(f, { name: display, dir, updated: now });
      return publicFolder(f);
    });
    // its old folder name is free: a board « Court métrage (2) » at the root drops its number
    if (dir !== dir0) await tidyLocked(path.dirname(dir0));
    return Object.assign({ ok: true }, meta);
  });
  changed('folder-rename', { folderId: id });
  return r;
}

/** One of the muted tints (SPEC §18.1): grey, blue, teal, green, yellow, orange, red, pink. */
async function setFolderColor(id, color) {
  await ready();
  const c = validColor(color);
  if (!c) throw userError(tr(STR.badColor));
  requireFolder(id);
  const r = await tree(async () => {
    const dir = await requireLiveFolder(id);
    const e = folderEntry(id) || {};
    const fj = (await readJSON(folderFile(dir), null)) || { id, name: e.name || path.basename(dir), created: e.created || Date.now(), updated: e.updated || Date.now(), version: 1 };
    fj.id = id;
    fj.color = c;                       // a tint is not an edit: « modifié » does not move
    try {
      await writeJSONAtomic(folderFile(dir), fj);
    } catch (err) {
      throw userError(fsMessage(err), err);
    }
    const meta = await withIndex((idx) => {
      const f = (idx.folders || []).find((x) => x.id === id);
      if (!f) return SKIP_WRITE;
      f.color = c;
      return publicFolder(f);
    });
    return Object.assign({ ok: true }, meta || { id, color: c });
  });
  changed('folder-color', { folderId: id });
  return r;
}

/**
 * Delete a project. keepBoards (the default): its boards come back to the root, then the folder
 * (now without boards) goes to the Recycle Bin. keepBoards:false: the whole folder, boards
 * included, goes to the Recycle Bin. Refused while one of its boards has a job queued or running.
 * → { ok, moved:[boardId], trashed:n }
 */
async function removeFolder(id, opts) {
  await ready();
  const o = opts && typeof opts === 'object' ? opts : {};
  const keep = o.keepBoards !== false;
  requireFolder(id);
  const moved = [];
  const renames = [];
  try {
    return await tree(async () => {
      if (!S.rootMissing) await reconcile().catch(() => {});   // boards copied in by hand are boards too
      const dir = await requireLiveFolder(id);
      const fname = (folderEntry(id) || {}).name || path.basename(dir);
      const inside = boardsInside(dir);
      const running = inside.find(busy);
      if (running) {
        throw userError(tr(STR.busyFolder, { name: (entryOf(running) || {}).name || running, folder: fname }));
      }
      if (keep) {
        // Boards that wear their own name go first: one renamed « Plan 01 (2) » when it came in (it
        // remembers « Plan 01 ») must not take that name back from the board that had it first.
        const order = await Promise.all(inside.map(async (b) => {
          const d = S.dirs.get(b);
          const pj = d ? await readJSON(files(d).project, null) : null;
          return { b, later: !!(pj && typeof pj.nameBeforeMove === 'string' && pj.nameBeforeMove) };
        }));
        order.sort((x, y) => Number(x.later) - Number(y.later));
        // one by one: a board that cannot move (file in use) stops here, nothing is trashed
        for (const { b } of order) {
          const from = (entryOf(b) || {}).name || null;
          const r = await moveLocked(b, null);
          moved.push(b);
          const to = (r && r.name) || (entryOf(b) || {}).name || null;
          if (from && to && from !== to) renames.push({ id: b, from, to });
        }
      }
      const gone = keep ? [] : inside;
      await serialAll(gone.map((b) => 'p:' + b), async () => {
        touch(id);
        gone.forEach(touch);
        try {
          await S.trash(dir);
        } catch (e) {
          throw userError(tr(STR.trashFailed, { name: fname }), e);
        }
        S.folderDirs.delete(id);
        S.pendingFolder.delete(id);
        for (const b of gone) {
          S.dirs.delete(b);
          forget(b);
        }
        touch(id);
        gone.forEach(touch);
      });
      await withIndex((idx) => {
        idx.folders = (idx.folders || []).filter((f) => f.id !== id);
        if (gone.length) idx.projects = idx.projects.filter((p) => !gone.includes(p.id));
      });
      // its folder name is free: a board « Plan G » brought back to the root as « Plan G (2) » on
      // disk (the project's folder was still there) gets its own folder name
      await tidyLocked(path.dirname(dir));
      return { ok: true, moved, trashed: gone.length, renames };
    });
  } finally {
    changed('folder-remove', { folderId: id, moved: moved.slice(), renames: renames.slice() });
  }
}

/**
 * Folder moves that had to wait (a job was running, a file was held): try them again, quietly.
 * Called when the home lists, and when a job ends.
 */
let retrying = null;
function retryPending() {
  if (retrying || !S.pendingFolder.size) return retrying || Promise.resolve();
  retrying = tree(async () => {
    for (const id of [...S.pendingFolder]) {
      const f = folderEntry(id);
      if (!f || !S.folderDirs.has(id)) {
        S.pendingFolder.delete(id);
        continue;
      }
      const was = S.folderDirs.get(id);
      const r = await followFolder(id, f.name);
      if (!r.moved) continue;
      await withIndex((idx) => { syncDirs(idx); });
      changed('folder-rename', { folderId: id });
      await tidyLocked(path.dirname(was));   // the name it left is free in turn
    }
  }).catch((e) => S.log('pending folder move failed:', e.message))
    .finally(() => { retrying = null; });
  return retrying;
}

/** graph.corrupt-<stamp>.json beside the damaged file — once: opening it again adds no new copy. */
async function keepCorruptCopy(dir, file) {
  try {
    const buf = await fsp.readFile(file);
    const sum = crypto.createHash('sha1').update(buf).digest('hex');
    const names = (await fsp.readdir(dir)).filter((n) => /^graph\.corrupt-.*\.json$/i.test(n));
    for (const n of names) {
      const st = await fsp.stat(path.join(dir, n)).catch(() => null);
      if (!st || st.size !== buf.length) continue;
      const other = await fsp.readFile(path.join(dir, n)).catch(() => null);
      if (other && crypto.createHash('sha1').update(other).digest('hex') === sum) return;
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    await fsp.writeFile(path.join(dir, `graph.corrupt-${stamp}.json`), buf);
  } catch (e) {
    S.log('corrupt copy not kept:', e.message);
  }
}

/** Read graph.json; on damage keep a copy aside, try .bak, else hand back a read-only empty board. */
async function loadGraph(dir) {
  const f = files(dir);
  let raw = null;
  let missing = false;
  try {
    raw = await fsp.readFile(f.graph, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') missing = true;
    else return { graph: emptyGraph(), readOnly: true, error: tr(STR.unreadable) };
  }
  if (raw !== null) {
    let parsed;
    try {
      parsed = parseJSON(raw);
    } catch { /* damaged: below */ }
    if (parsed !== undefined) {
      // SPEC §21.1: an older format is brought to this version's (graph.json.bak-v<old> kept first); a newer
      // one, or a failed migration, opens read-only: this Mia never writes over what it cannot read
      const mig = await migrations.migrateFile('graph', f.graph, parsed, S.log);
      const g = normalizeGraph(mig.doc);
      if (g && (mig.newer || mig.failed)) return { graph: g, readOnly: true, reason: mig.newer ? 'newer' : 'migration', error: migrations.message(mig, lang()) };
      if (g) return { graph: g, good: true };
    }
    await keepCorruptCopy(dir, f.graph);
  }
  // the .bak is never written over by this path (the next save goes to graph.json): migrated in memory only
  const bakMig = migrations.migrate('graph', await readJSON(f.bak, null));
  const bak = normalizeGraph(bakMig.doc);
  if (bak && (bakMig.newer || bakMig.failed)) return { graph: bak, readOnly: true, reason: bakMig.newer ? 'newer' : 'migration', error: migrations.message(bakMig, lang()) };
  if (bak) return { graph: bak, warning: missing ? null : tr(STR.recovered) };
  if (missing) return { graph: emptyGraph() };            // nothing to protect: a fresh board
  return { graph: emptyGraph(), readOnly: true, error: tr(STR.unreadable) };
}

/** Every run.json under outputs\<nodeId>\<runId>\, grouped by node, newest first (SPEC §3.3). */
async function scanRuns(dir) {
  const out = {};
  const base = path.join(dir, 'outputs');
  let nodeDirs = [];
  try {
    nodeDirs = (await fsp.readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  const jobs = [];
  for (const nd of nodeDirs) {
    let runDirs = [];
    try {
      runDirs = (await fsp.readdir(path.join(base, nd.name), { withFileTypes: true })).filter((d) => d.isDirectory());
    } catch { continue; }
    for (const rd of runDirs) jobs.push([nd.name, rd.name]);
  }
  const runs = await mapLimit(jobs, 16, async ([nodeId, runId]) => {
    const r = await readJSON(path.join(base, nodeId, runId, 'run.json'), null);   // no run.json = still running
    if (!r || typeof r !== 'object') return null;
    if (!r.nodeId) r.nodeId = nodeId;
    if (!r.runId) r.runId = runId;
    return r;
  });
  for (const r of runs) {
    if (!r) continue;
    (out[r.nodeId] = out[r.nodeId] || []).push(r);
  }
  const when = (r) => Number(r.finished) || Number(r.started) || 0;
  for (const k of Object.keys(out)) {
    out[k].sort((a, b) => when(b) - when(a) || String(b.runId).localeCompare(String(a.runId)));
  }
  return out;
}

async function listRuns(id) {
  return scanRuns(requireDir(id));
}

/**
 * Open a project: graph, versions of every block, folder. `opened` is stamped.
 * Extra fields beside SPEC §5: readOnly (bool), warning / error (sentences to toast).
 */
async function open(id) {
  await ready();
  if (!projectDir(id)) await reconcile();
  requireDir(id);
  return serial('p:' + id, async () => {
    let dir = requireDir(id);
    let pj = await readJSON(files(dir).project, null);
    if (!pj && !S.rootMissing) {
      // renamed or moved in Explorer since the last look: the folders tell where it went
      await reconcile().catch(() => {});
      const moved = projectDir(id);
      if (moved && moved !== dir) {
        dir = moved;
        pj = await readJSON(files(dir).project, null);
      }
    }
    if (!pj) throw userError(S.rootMissing ? status().message : tr(STR.notFound));
    pj = (await migrations.migrateFile('project', files(dir).project, pj, S.log)).doc;   // SPEC §21.1
    // a rename whose folder could not follow (file in use, job running): try again now
    if (S.pendingMove.has(id) && pj.name) dir = await followName(id, dir, cleanDisplayName(pj.name));
    const f = files(dir);
    const now = Date.now();
    pj.opened = now;
    await writeJSONAtomic(f.project, pj).catch((e) => S.log('opened stamp failed:', e.message));

    const g = await loadGraph(dir);
    if (g.readOnly) S.readOnly.set(id, g.error);
    else S.readOnly.delete(id);
    if (g.good) S.goodGraph.add(id);
    else S.goodGraph.delete(id);     // a damaged graph.json must not become the next .bak
    // what is on disk, camera aside: a save that only moved the camera is not an edit
    if (g.good) S.savedKey.set(id, contentKey(g.graph));
    else S.savedKey.delete(id);
    S.openedAt.set(id, now);

    const runs = await scanRuns(dir);
    const meta = await withIndex((idx) => {
      const p = idx.projects.find((x) => x.id === id);
      if (!p) return SKIP_WRITE;
      p.opened = now;
      p.dir = dir;
      return publicMeta(p);
    });
    const res = {
      ok: true,
      project: meta || publicMeta({ id, name: pj.name, dir, created: pj.created, updated: pj.updated, opened: now }),
      graph: g.graph,
      runs,
      dir,
      readOnly: !!g.readOnly
    };
    if (g.error) res.error = g.error;
    if (g.warning) res.warning = g.warning;
    // why it is read-only when it is not a damaged file: 'newer' (saved by a newer Mia) | 'migration' (SPEC §21.1)
    if (g.reason) res.readOnlyReason = g.reason;
    return res;
  });
}

const THUMB_W = 480;
const THUMB_H = 300;
const THUMB_EVERY_MS = 15000;
const THUMB_SETTLE_MS = 1500;   // a board just opened is still painting: no automatic capture before

/**
 * Is the board of this project the one on screen right now? Asked to the page itself just before
 * and just after the capture: a capture is asynchronous, and the view may have changed (Home, another
 * tab) between the save request and capturePage — the card would then show another screen.
 * An interface without window.__mia (tests, fallback page) is trusted.
 */
async function boardShows(wc, id) {
  if (!wc || wc.isDestroyed()) return false;
  const js = `(() => { try {
    const m = window.__mia; if (!m || !m.state) return 'unknown';
    const p = m.state.project; const v = document.getElementById('view-board');
    return !!(p && p.id === ${JSON.stringify(String(id))} && v && !v.hidden && document.visibilityState !== 'hidden');
  } catch (e) { return 'unknown'; } })()`;
  try {
    const r = await Promise.race([wc.executeJavaScript(js, true), sleep(1500).then(() => false)]);
    return r === true || r === 'unknown';
  } catch {
    return false;
  }
}

/**
 * Grab the board area of the window, cover-crop it to 16:10 and keep a 480×300 PNG — only if the
 * board of `id` is on screen before and after the grab.
 */
async function captureThumb(wc, rect, file, id) {
  if (!wc || wc.isDestroyed() || !rect) return false;
  const r = {
    x: Math.max(0, Math.round(Number(rect.x) || 0)),
    y: Math.max(0, Math.round(Number(rect.y) || 0)),
    width: Math.round(Number(rect.w ?? rect.width) || 0),
    height: Math.round(Number(rect.h ?? rect.height) || 0)
  };
  if (r.width < 16 || r.height < 16) return false;
  if (id && !(await boardShows(wc, id))) return false;
  const img = await wc.capturePage(r);
  if (!img || img.isEmpty()) return false;
  if (id && !(await boardShows(wc, id))) return false;
  const { width: iw, height: ih } = img.getSize();
  const want = THUMB_W / THUMB_H;
  let cw = iw;
  let ch = ih;
  if (iw / ih > want) cw = Math.max(1, Math.round(ih * want));
  else ch = Math.max(1, Math.round(iw / want));
  const cropped = img.crop({ x: Math.floor((iw - cw) / 2), y: Math.floor((ih - ch) / 2), width: cw, height: ch });
  const out = cropped.resize({ width: THUMB_W, height: THUMB_H, quality: 'best' });
  await writeFileAtomic(file, out.toPNG());
  return true;
}

/** Capture (if due and the board is on screen), then tell the index. Never throws. */
async function maybeThumb(id, f, rect, wc, due) {
  if (!rect || !due) return false;
  try {
    const ok = await captureThumb(wc, rect, f.thumb, id);
    if (ok) S.lastThumb.set(id, Date.now());
    return ok;
  } catch (e) {
    S.log('thumbnail failed:', e.message);   // never fail a save over a picture
    return false;
  }
}

/**
 * Save: graph.json.bak ← previous graph.json, then graph.json atomically, project.json `updated`,
 * the thumbnail (at most every 15 s; at once when forced or while the window closes), the index.
 * A save that only moved the camera (pan, zoom, window resized) writes graph.json and nothing
 * else: no backup rotation, no new « modifié » date, no thumbnail unless forced.
 * @param {object} opts { thumbRect:{x,y,w,h}|null, force?:bool }
 * @param {Electron.WebContents} wc  the sender, for capturePage
 * @returns {{ok, updated, thumb, cameraOnly}}
 */
async function save(id, graph, opts, wc) {
  await ready();
  requireDir(id);
  if (S.readOnly.has(id)) return { ok: false, error: tr(STR.readOnlySave), readOnly: true };
  if (!graph || typeof graph !== 'object' || Array.isArray(graph) || !Array.isArray(graph.nodes)) {
    return { ok: false, error: tr(STR.badGraph) };
  }
  const o = opts && typeof opts === 'object' ? opts : {};
  let text;
  try {
    text = JSON.stringify(graph, stripPrivate, 1);
  } catch {
    return { ok: false, error: tr(STR.badGraph) };
  }
  const key = contentKey(graph);
  return serial('p:' + id, async () => {
    const dir = await requireLiveDir(id);
    const f = files(dir);
    const cameraOnly = !!key && S.savedKey.get(id) === key && S.goodGraph.has(id);
    try {
      if (!cameraOnly && S.goodGraph.has(id)) await fsp.copyFile(f.graph, f.bak).catch(() => {});
      await writeFileAtomic(f.graph, text);
    } catch (e) {
      throw userError(fsMessage(e), e);
    }
    S.goodGraph.add(id);
    if (key) S.savedKey.set(id, key);
    const now = Date.now();
    const hasThumb = fs.existsSync(f.thumb);
    const settled = now - (S.openedAt.get(id) || 0) >= THUMB_SETTLE_MS;

    if (cameraOnly) {
      const wroteThumb = await maybeThumb(id, f, o.thumbRect, wc, o.force || S.closing || (!hasThumb && settled));
      if (wroteThumb) {
        await withIndex((idx) => {
          const p = idx.projects.find((x) => x.id === id);
          if (!p) return SKIP_WRITE;
          p.hasThumb = true;
          p.thumbAt = Date.now();
          return true;
        });
      }
      const e = entryOf(id);
      return { ok: true, updated: e ? e.updated || null : null, thumb: wroteThumb, cameraOnly: true };
    }

    const pj = (await readJSON(f.project, null)) || { id, name: (entryOf(id) || {}).name || path.basename(dir), created: now, version: 1 };
    pj.updated = now;
    await writeJSONAtomic(f.project, pj).catch((e) => S.log('project.json update failed:', e.message));

    const last = S.lastThumb.get(id) || 0;
    const due = o.force || S.closing || ((!hasThumb || now - last >= THUMB_EVERY_MS) && settled);
    const wroteThumb = await maybeThumb(id, f, o.thumbRect, wc, due);
    const count = graph.nodes.length;
    await withIndex((idx) => {
      const p = idx.projects.find((x) => x.id === id);
      if (!p) return SKIP_WRITE;
      p.updated = now;
      p.nodes = count;
      if (wroteThumb) { p.hasThumb = true; p.thumbAt = Date.now(); }
      return true;
    });
    return { ok: true, updated: now, thumb: wroteThumb, cameraOnly: false };
  });
}

/**
 * Only the thumbnail, now (no graph written): for the interface, which frames the whole board,
 * hides its overlays, then asks — typically while a project is being closed (SPEC §5 projects:thumb).
 * Refused (thumb:false) unless the board of `id` is the one on screen.
 * @param {object} opts { thumbRect:{x,y,w,h} } (or the rect itself)
 */
async function thumb(id, opts, wc) {
  await ready();
  requireDir(id);
  const o = opts && typeof opts === 'object' ? opts : {};
  const rect = o.thumbRect || o.rect || (Number.isFinite(Number(o.x)) ? o : null);
  if (!rect) return { ok: false, error: tr(STR.badGraph) };
  return serial('p:' + id, async () => {
    const f = files(await requireLiveDir(id));
    const wrote = await maybeThumb(id, f, rect, wc, true);
    let url = null;
    if (wrote) {
      const meta = await withIndex((idx) => {
        const p = idx.projects.find((x) => x.id === id);
        if (!p) return SKIP_WRITE;
        p.hasThumb = true;
        p.thumbAt = Date.now();
        return publicMeta(p);
      });
      url = meta ? meta.thumb : null;
    }
    return { ok: true, thumb: wrote, url };
  });
}

function setClosing(v) { S.closing = !!v; }

/** main.js: (projectId) → is a job of this project queued or running? (the engine knows) */
function setBusyCheck(fn) { S.isBusy = typeof fn === 'function' ? fn : () => false; }

/**
 * Run fn in the board's own queue — the one its saves, its moves and its project's renames hold —
 * so a media import never writes into a folder that is being moved (media.js).
 */
function withBoard(id, fn) { return serial('p:' + String(id), fn); }

module.exports = {
  init,
  ready,
  idle,
  // prefs
  getPrefs,
  setPrefs,
  onPrefs,
  lang,
  tr,
  // boards (« planches » — still called projects in the code and in mia.projects.*)
  list,
  create,
  rename,
  duplicate,
  remove,
  move,
  open,
  save,
  thumb,
  status,
  setBusyCheck,
  listRuns,
  scanRuns,
  reconcile,
  projectDir,
  requireLiveDir,
  projectById,
  // projects (« projets » = folders of boards, SPEC §18)
  folders: {
    list: listFolders,
    create: createFolder,
    rename: renameFolder,
    setColor: setFolderColor,
    remove: removeFolder,
    findByName: findFolderByName
  },
  findFolderByName,
  folderDir,
  folderById,
  withBoard,
  onChange,
  retryPending,
  FOLDER_COLORS,
  projectsRoot,
  allowedRoots,
  setClosing,
  // helpers shared with media.js / shellops.js / main.js
  isInside,
  userError,
  fsMessage,
  readJSON,
  writeFileAtomic,
  writeJSONAtomic,
  renameRetry,
  mapLimit,
  serial,
  paths: () => ({ userData: S.userData, data: S.dataDir, logs: S.dataDir && path.join(S.dataDir, 'logs') }),
  // exposed for tests
  _internals: { folderName, cleanDisplayName, cutText, contentKey, parseJSON, sanitizePrefs, normalizeGraph, nameKey, isSuffixed, S, idle }
};
