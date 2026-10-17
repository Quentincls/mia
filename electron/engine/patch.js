'use strict';
// Mia — ComfyUI graph patcher (API format) + the plumbing every ComfyUI executor shares.
//
// Part 1 is a port of the author's tool/comfy.py (insert_after, bypass) plus small graph tools.
//   An API graph is { "<id>": { class_type, inputs: { name: literal | [sourceId, outputIndex] } } }.
//   Every function MUTATES the graph it receives and returns it (chaining). Always start from a fresh
//   copy — load() or clone() — never from a cached template.
// Part 2 (`exec`) is what all B2 executors repeat: upload, validate-then-submit with progress, collect
//   the files ComfyUI wrote, encode them with ffmpeg, bilingual messages. It lives here because the SPEC
//   gives executors no shared module, and seven copies of it would drift apart.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const validate = require('./validate');

const WF_DIR = path.join(__dirname, 'workflows');

// ================================================================= part 1 — graph helpers

const tplCache = new Map();

/** Fresh copy of a template from engine/workflows ("ltx_i2v" or "ltx_i2v.api.json"). */
function load(name) {
  const file = path.join(WF_DIR, /\.json$/i.test(name) ? name : `${name}.api.json`);
  let txt = tplCache.get(file);
  if (txt == null) {
    txt = fs.readFileSync(file, 'utf8');
    tplCache.set(file, txt);
  }
  return JSON.parse(txt);
}

const clone = (g) => JSON.parse(JSON.stringify(g));

/** A link is [sourceId, outputIndex]; ComfyUI ids are strings ("170:151"). */
const isLink = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1]);

function node(g, id) {
  const n = g[id];
  if (!n) throw new Error(`patch: node "${id}" is not in the graph`);
  return n;
}

function set(g, id, input, value) {
  node(g, id).inputs[input] = value;
  return g;
}

function setInputs(g, id, values) {
  Object.assign(node(g, id).inputs, values);
  return g;
}

const get = (g, id, input) => node(g, id).inputs[input];

/** Every [consumerId, inputName] reading `id` (optionally only its output `outIdx`). */
function consumers(g, id, outIdx = null) {
  const out = [];
  for (const [cid, n] of Object.entries(g)) {
    for (const [k, v] of Object.entries(n.inputs || {})) {
      if (isLink(v) && v[0] === id && (outIdx == null || v[1] === outIdx)) out.push([cid, k]);
    }
  }
  return out;
}

/** Points every link to [fromId, fromIdx] at `to` instead. */
function relink(g, [fromId, fromIdx], to) {
  for (const [cid, k] of consumers(g, fromId, fromIdx)) g[cid].inputs[k] = Array.isArray(to) ? [...to] : to;
  return g;
}

/**
 * Removes a node and hands its consumers what it was fed (tool.comfy.bypass).
 * passthrough = { outputIndex: inputName }, e.g. { 0: 'positive', 1: 'negative', 2: 'latent' }.
 */
function bypass(g, id, passthrough) {
  const n = node(g, id);
  delete g[id];
  for (const [cid, k] of consumers(g, id)) {
    const v = g[cid].inputs[k];
    const src = passthrough[v[1]];
    if (src === undefined || !(src in n.inputs)) {
      throw new Error(`patch.bypass: output ${v[1]} of "${id}" is still read by "${cid}.${k}"`);
    }
    const fed = n.inputs[src];
    g[cid].inputs[k] = Array.isArray(fed) ? [...fed] : fed;
  }
  return g;
}

/**
 * Inserts newNode right after `id`: its consumers now read newNode (tool.comfy.insert_after).
 * passthrough = { outputIndex: inputNameOfNewNode }; newNode receives id's outputs on those inputs
 * and is expected to expose the same output indices.
 */
function insertAfter(g, id, newId, newNode, passthrough) {
  node(g, id);
  if (g[newId]) throw new Error(`patch.insertAfter: id "${newId}" already used`);
  for (const [cid, k] of consumers(g, id)) {
    const v = g[cid].inputs[k];
    if (v[1] in passthrough) g[cid].inputs[k] = [newId, v[1]];
  }
  const n = clone(newNode);
  n.inputs = n.inputs || {};
  for (const [idx, name] of Object.entries(passthrough)) n.inputs[name] = [id, Number(idx)];
  g[newId] = n;
  return g;
}

function remove(g, ...ids) {
  for (const id of ids.flat()) delete g[id];
  return g;
}

/** Removes every node whose id starts with `prefix` (a whole subgraph export, e.g. "9034:"). */
function removeByPrefix(g, prefix) {
  for (const id of Object.keys(g)) if (id.startsWith(prefix)) delete g[id];
  return g;
}

const findByClass = (g, cls) => Object.keys(g).filter((id) => g[id].class_type === cls);

/** Next free numeric id, kept clear of the template ids (which stay below 9000 or are "a:b"). */
function freeId(g, from = 9500) {
  let n = from;
  while (g[String(n)]) n++;
  return String(n);
}

function addNode(g, classType, inputs, id = null) {
  const nid = id || freeId(g);
  if (g[nid]) throw new Error(`patch.addNode: id "${nid}" already used`);
  g[nid] = { class_type: classType, inputs: { ...inputs } };
  return nid;
}

/** Swaps a node's class in place, keeping its id (and therefore every link to it). */
function replaceNode(g, id, classType, inputs) {
  node(g, id);
  g[id] = { class_type: classType, inputs: { ...inputs } };
  return g;
}

// Output classes Mia's templates use; prune() keeps what feeds them.
const OUTPUT_CLASSES = new Set(['SaveImage', 'SaveImageAdvanced', 'SaveVideo', 'SaveAudio', 'SaveAudioAdvanced',
  'SaveAudioMP3', 'SaveAudioOpus', 'PreviewImage', 'PreviewAny', 'VideoDepthAnythingSaveEXR']);

/** Deletes nodes no output depends on (ComfyUI ignores them, but they still name model files). */
function prune(g, outputIds = null) {
  const roots = outputIds || Object.keys(g).filter((id) => OUTPUT_CLASSES.has(g[id].class_type));
  const keep = new Set();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop();
    if (keep.has(id) || !g[id]) continue;
    keep.add(id);
    for (const v of Object.values(g[id].inputs || {})) if (isLink(v)) stack.push(v[0]);
  }
  for (const id of Object.keys(g)) if (!keep.has(id)) delete g[id];
  return g;
}

// ================================================================= part 2 — executor plumbing

// ---------------------------------------------------------------- messages (FR default, EN)
// The main process has no renderer i18n: begin(x) picks x.lang (set by engine/index.js) for the run.
const MSG = {
  fr: {
    cancelled: 'Calcul annulé.',
    preparingVideo: 'Préparation de la vidéo…',
    uploading: 'Envoi des fichiers au moteur…',
    sending: 'Envoi au moteur…',
    computing: 'Calcul en cours…',
    encoding: 'Encodage de la vidéo…',
    saving: 'Enregistrement du résultat…',
    window: 'Tranche {i} sur {n}…',
    joining: 'Raccord des tranches…',
    keepBlacks: 'Noirs du rendu remis en place…',
    noOutput: 'Le moteur n’a rendu aucun fichier. Regarde le journal du calcul.',
    missingInput: 'Il manque l’entrée « {port} ».',
    ffmpegFailed: 'L’encodage vidéo a échoué ({what}). Détail : {detail}',
    noFrames: 'La vidéo d’entrée ne contient aucune image lisible.',
    engineDown: 'Le moteur ComfyUI ne répond pas. Lance-le depuis la puce GPU ou attends qu’il démarre.',
    loraMismatch: 'Le LoRA « {lora} » est fait pour {for}, pas pour {need} : choisis-en un autre dans « Personnage ou lieu », ou change de modèle.',
    loraNotPlaced: 'Le LoRA « {lora} » n’est pas encore visible par le moteur ComfyUI. Ajoute-le de nouveau depuis la bibliothèque.',
    loraTrigger: 'Mot déclencheur « {t} » ajouté en tête de la consigne.',
    loraUsed: 'LoRA « {lora} » à {s}.',
    notInstalled: 'Le modèle « {label} » n’est pas installé ({files} absent du dossier models\\{folder} du moteur).',
    noPrompt: 'Écris la consigne (en anglais, de préférence).',
  },
  en: {
    cancelled: 'Run cancelled.',
    preparingVideo: 'Preparing the video…',
    uploading: 'Sending files to the engine…',
    sending: 'Sending to the engine…',
    computing: 'Computing…',
    encoding: 'Encoding the video…',
    saving: 'Saving the result…',
    window: 'Chunk {i} of {n}…',
    joining: 'Joining the chunks…',
    keepBlacks: 'Putting the render’s blacks back…',
    noOutput: 'The engine returned no file. Check the run log.',
    missingInput: 'The “{port}” input is missing.',
    ffmpegFailed: 'Video encoding failed ({what}). Detail: {detail}',
    noFrames: 'The input video has no readable frame.',
    engineDown: 'The ComfyUI engine is not answering. Start it from the GPU chip or wait for it to start.',
    loraMismatch: 'The LoRA “{lora}” is made for {for}, not for {need}: pick another one in “Character or place”, or change the model.',
    loraNotPlaced: 'The LoRA “{lora}” is not visible to the ComfyUI engine yet. Add it again from the library.',
    loraTrigger: 'Trigger word “{t}” added at the start of the prompt.',
    loraUsed: 'LoRA “{lora}” at {s}.',
    notInstalled: 'The “{label}” model is not installed ({files} missing from the engine’s models\\{folder} folder).',
    noPrompt: 'Write the prompt (English works best).',
  },
};
let lang = 'fr';

function setLang(l) {
  lang = l === 'en' ? 'en' : 'fr';
  validate.setLang(lang);
}

/** t(key, vars) or t({fr, en}, vars): executors keep their own strings as {fr, en} objects. */
function t(key, vars = {}) {
  const s = typeof key === 'object' ? (key[lang] ?? key.fr) : (MSG[lang][key] ?? MSG.fr[key] ?? key);
  return String(s).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
}

/** First call of every run: the engine hands the UI language in x.lang. */
function begin(x) {
  if (x && x.lang) setLang(x.lang);
  checkAbort(x);
}

function abortError() {
  const e = new Error(t('cancelled'));
  e.name = 'AbortError';
  e.cancelled = true;
  return e;
}

function checkAbort(x) {
  if (x.signal && x.signal.aborted) throw abortError();
}

// ---------------------------------------------------------------- small maths shared by the recipes

const snap = (v, m) => Math.max(m, Math.round(v / m) * m);
const even = (v) => Math.max(2, Math.round(v / 2) * 2);
/** LTX wants 8k+1 frames (the lab's 1 + floor(fps*s/8)*8). */
const ltxFrames = (fps, seconds) => 1 + Math.max(1, Math.floor((fps * seconds) / 8)) * 8;
/** Smallest 8k+1 >= n (frame padding before an LTX pass). */
const ceil8k1 = (n) => 1 + Math.max(1, Math.ceil((n - 1) / 8)) * 8;
const int = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);
/**
 * Minutes for one LTX pass, from its token count (latent frames × 32-px patches). Lab anchors: ~6 min for
 * 1088×1920×121 warm, ~1 min for 576×1024×49; attention makes it grow faster than linearly (power 1.5).
 */
function ltxMinutes(w, h, frames) {
  const tokens = (ww, hh, n) => (Math.floor((n - 1) / 8) + 1) * (ww / 32) * (hh / 32);
  return 0.8 + 6 * (tokens(w, h, frames) / tokens(1088, 1920, 121)) ** 1.5;
}
// ---------------------------------------------------------------- video frame size (format + resolution)

/** Picture ratios offered by the video blocks (catalog `format`). Old values stay readable. */
const FORMAT_RATIOS = {
  '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '21:9': 21 / 9,
  horizontal: 16 / 9, vertical: 9 / 16, wide: 2560 / 736,
};
/** Ratio w/h of a block: an explicit format, or (`auto`) the start image's own shape. */
function formatRatio(format, meta, fallback = 16 / 9) {
  if (FORMAT_RATIOS[format]) return FORMAT_RATIOS[format];
  if (meta && meta.w > 0 && meta.h > 0) return Math.min(3.6, Math.max(0.28, meta.w / meta.h));
  return fallback;
}
/**
 * Size of a generated video. `short` = wanted short side (540 / 720 / 1080), `mult` = the model's grid (32).
 * exact = true (LTX): generate on the grid just above, then crop back to the exact size (1088 → 1080, as the lab
 * does); exact = false (MiniMax): round to the nearest grid size and deliver that. maxPixels caps very wide shots.
 * Returns { w, h } to generate, { ow, oh } delivered, and the ffmpeg crop (or null).
 */
function videoSize({ ratio, short, mult = 32, exact = true, maxPixels = Infinity }) {
  const r = Math.min(3.6, Math.max(0.28, Number(ratio) || 16 / 9));
  let ow = r >= 1 ? short * r : short;
  let oh = r >= 1 ? short : short / r;
  if (ow * oh > maxPixels) { const k = Math.sqrt(maxPixels / (ow * oh)); ow *= k; oh *= k; }
  if (!exact) {
    const w = snap(ow, mult), h = snap(oh, mult);
    return { w, h, ow: w, oh: h, crop: null };
  }
  ow = even(ow); oh = even(oh);
  const w = Math.ceil(ow / mult) * mult, h = Math.ceil(oh / mult) * mult;
  const crop = (w !== ow || h !== oh)
    ? `crop=${ow}:${oh}:${Math.floor((w - ow) / 2)}:${Math.floor((h - oh) / 2)}` : null;
  return { w, h, ow, oh, crop };
}
/** Short side asked by the block (catalog `resolution`: '540' | '720' | '1080'), with a preview cap. */
function shortSide(x, { preview = false, def = 720, previewCap = 512, max = 1080 } = {}) {
  const asked = Math.min(max, Number(x.params.resolution) || def);
  return preview ? Math.min(asked, previewCap) : asked;
}

const seedOf = (x) => Math.max(0, Math.min(2 ** 48, Math.floor(Math.abs(Number(x.params.seed) || 0))));

// ---------------------------------------------------------------- inputs, models, prompts

function input(x, port, required = true) {
  const v = x.inputs ? x.inputs[port] : null;
  if (required && (!v || !v.abs)) throw new Error(t('missingInput', { port }));
  return v || null;
}

/** Prompt text: a wired text block overrides the field (catalog `port`). */
function promptOf(x, { negativeDefault = '' } = {}) {
  const wired = x.inputs && x.inputs.prompt;
  const fromPort = wired && typeof wired.text === 'string' && wired.text.trim() ? wired.text : null;
  const prompt = (fromPort ?? String(x.params.prompt ?? '')).trim();
  const neg = wired && typeof wired.negative === 'string' && wired.negative.trim()
    ? wired.negative : (x.params.negative ?? negativeDefault);
  return { prompt, negative: String(neg || '').trim() };
}

/** Inventory entry for a model param (null for "none"/missing). */
function model(x, key) {
  try { return (x.model && x.model(key)) || null; } catch { return null; }
}

/** ComfyUI file name of the chosen model, or the known local fallback. */
function modelFile(x, key, fallback) {
  const m = model(x, key);
  return (m && ((m.comfy && m.comfy.name) || m.file)) || fallback;
}

/** Model name for run.json, in the UI language of the run (x.lang, set by begin()). */
const labelOf = (m, fallback) => (m && m.label && (m.label[lang] || m.label.fr || m.label.en)) || (m && m.file) || fallback;

/** MiniMax H3 (by family or file name). */
const isMinimax = (m) => !!m && /minimax/i.test(`${m.family || ''} ${m.baseKey || ''} ${(m.comfy && m.comfy.name) || m.file || ''}`);

/** MiniMax length grid: 17k+5 frames at 24 fps (56, 73, …, 124 ≈ 5 s). `floor` never goes past `seconds`. */
function minimaxLength(seconds, floor = false, minK = 3) {
  const k = (seconds * 24 - 5) / 17;
  return 17 * Math.max(minK, floor ? Math.floor(k) : Math.round(k)) + 5;
}

// ---------------------------------------------------------------- LoRA (SPEC §12)

/** Base family key of a model or LoRA entry: 'ltx' | 'wan' | 'qwen' | 'minimax' | 'flux' | 'sdxl' | null. */
function familyKey(m) {
  if (!m) return null;
  if (m.loraFor) return String(m.loraFor).toLowerCase();
  if (m.baseKey) return String(m.baseKey).toLowerCase();
  const s = `${m.family || ''} ${(m.comfy && m.comfy.name) || ''} ${m.file || ''}`;
  if (/minimax/i.test(s)) return 'minimax';
  if (/ltx/i.test(s)) return 'ltx';
  if (/qwen/i.test(s)) return 'qwen';
  if (/\bwan|wan[\d_ -]/i.test(s)) return 'wan';
  if (/flux/i.test(s)) return 'flux';
  if (/sdxl|stable.?diffusion|\bsd[\d_ ]/i.test(s)) return 'sdxl';
  return null;
}

const FAMILY_LABEL = {
  ltx: 'LTX 2.5', wan: 'Wan', qwen: 'Qwen Image', minimax: 'MiniMax H3', flux: 'Flux', sdxl: 'Stable Diffusion XL',
};
const familyLabel = (k) => FAMILY_LABEL[k] || String(k || '?');

/**
 * Trigger word of a LoRA entry, as the inventory gives it: the user's own registry (loras.json), their
 * identities.json, or the LoRA's training metadata (scanner.js loraMeta). Never guessed from a file name.
 */
function loraTrigger(entry) {
  if (!entry) return null;
  if (typeof entry.trigger === 'string' && entry.trigger.trim()) return entry.trigger.trim();
  return null;
}

/** Prompt with the trigger prepended when absent (case-insensitive); returns { prompt, trigger|null }. */
function withTrigger(prompt, trigger) {
  const p = String(prompt || '');
  if (!trigger || p.toLowerCase().includes(String(trigger).toLowerCase())) return { prompt: p, trigger: null };
  return { prompt: p ? `${trigger}, ${p}` : trigger, trigger };
}

const normName = (s) => String(s || '').replace(/\\/g, '/').toLowerCase();

/** The exact spelling ComfyUI lists for a model file ("mia\\x.safetensors" on Windows), else `name`. */
async function listedName(x, folder, name) {
  if (!name || !x.comfy || typeof x.comfy.models !== 'function') return name;
  let list = [];
  try { list = (await x.comfy.models(folder)) || []; } catch { return name; }
  if (list.includes(name)) return name;
  const want = normName(name);
  return list.find((f) => normName(f) === want) || name;
}

/**
 * The block's character / place LoRA (param `key`, strength `<key>Strength` or `loraStrength`), ready for a
 * LoraLoaderModelOnly: { name (ComfyUI file name), strength, trigger, label, family } — or null for « Aucun ».
 * Places the file where ComfyUI sees it first (x.ensureLora, SPEC §12.3). A LoRA made for another family than the
 * block's model throws a readable error BEFORE anything is uploaded or sent.
 */
async function lora(x, family, { key = 'lora' } = {}) {
  const entry = model(x, key);
  if (!entry) return null;
  const label = labelOf(entry, entry.file || key);
  const made = familyKey(entry);
  if (made && family && made !== family) {
    throw new Error(t('loraMismatch', { lora: label, for: familyLabel(made), need: familyLabel(family) }));
  }
  let name = null;
  if (typeof x.ensureLora === 'function') {
    checkAbort(x);
    const r = await x.ensureLora(key);
    name = r && (typeof r === 'string' ? r : (r.comfyName || r.name));
    checkAbort(x);
  }
  if (!name) name = entry.placed || (entry.comfy && entry.comfy.name) || null;
  if (!name) throw new Error(t('loraNotPlaced', { lora: label }));
  name = await listedName(x, 'loras', name);
  const sv = Number(x.params[`${key}Strength`] ?? x.params.loraStrength);
  const strength = Number.isFinite(sv) ? Math.min(2, Math.max(0, sv)) : 1;
  return { name, strength, trigger: loraTrigger(entry), label, family: made || family, entry };
}

/** Applies the LoRA trigger to a prompt and pushes the notes; returns the prompt. */
function loraPrompt(prompt, l, notes) {
  if (!l) return prompt;
  const tr = withTrigger(prompt, l.trigger);
  if (tr.trigger && notes) notes.push(t('loraTrigger', { t: tr.trigger }));
  if (notes) notes.push(t('loraUsed', { lora: l.label, s: String(Math.round(l.strength * 100) / 100).replace('.', lang === 'fr' ? ',' : '.') }));
  return tr.prompt;
}

/** Inserts the LoRA loader right after `afterId` (a model output 0). Returns the new node id. */
function addLora(g, afterId, l, id = null) {
  const nid = id || freeId(g, 9710);
  insertAfter(g, afterId, nid, { class_type: 'LoraLoaderModelOnly',
    inputs: { lora_name: l.name, strength_model: l.strength } }, { 0: 'model' });
  return nid;
}

/**
 * Throws « Le modèle « label » n'est pas installé » when one of `files` ([folder, file]) is not listed by ComfyUI.
 * Silent when the engine cannot list the folder (the validator then decides).
 */
async function requireModels(x, files, label) {
  const missing = [];
  for (const [folder, file] of files) {
    let list = null;
    try { list = await x.comfy.models(folder); } catch { list = null; }
    if (!Array.isArray(list) || !list.length) continue;
    const want = normName(file);
    if (!list.some((f) => normName(f) === want)) missing.push([folder, file]);
  }
  if (missing.length) {
    const e = new Error(t('notInstalled', { label: t(label), files: missing.map(([, f]) => f).join(', '),
      folder: [...new Set(missing.map(([f]) => f))].join(', models\\') }));
    e.code = 'MIA_NOT_INSTALLED';
    e.missing = missing;
    throw e;
  }
}

// ---------------------------------------------------------------- engine, progress, files

const infoCache = new WeakMap();

/** comfy.ensure() once per run: { url, inputDir, outputDir, version, modelsDir }. */
async function engine(x) {
  if (infoCache.has(x)) return infoCache.get(x);
  let info;
  try { info = await x.comfy.ensure({ launch: true }); } catch (e) {
    const err = new Error(t('engineDown'));
    err.cause = e;
    throw err;
  }
  info = { ...(info || {}) };
  // the lab layout: <engineRoot>\runtime\output and <engineRoot>\models (VDA has no ComfyUI folder listing)
  if (!info.modelsDir && info.outputDir) {
    const root = path.dirname(path.dirname(info.outputDir));
    if (fs.existsSync(path.join(root, 'models'))) info.modelsDir = path.join(root, 'models');
  }
  if (!info.modelsDir && x.engineRoot) info.modelsDir = path.join(x.engineRoot, 'models');
  infoCache.set(x, info);
  return info;
}

/** A progress callback mapped onto [a, b] of the whole run. */
function ranged(x, a, b) {
  return (p, msg) => {
    if (typeof x.progress !== 'function') return;
    x.progress(p == null ? null : a + Math.max(0, Math.min(1, p)) * (b - a), msg);
  };
}

const tmp = (x, name) => path.join(x.outDir, `_${name}`);

async function cleanup(...paths) {
  for (const p of paths.flat()) {
    if (!p) continue;
    try { await fsp.rm(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// What this run left in the engine's folders (SPEC §16): its uploads in <input>\mia and <output>\mia\<runId>.
const runFiles = new WeakMap();
const track = (x) => {
  let s = runFiles.get(x);
  if (!s) { s = { uploads: new Set(), outputs: false }; runFiles.set(x, s); }
  return s;
};

async function upload(x, abs) {
  checkAbort(x);
  const name = await x.comfy.upload(abs, { subfolder: 'mia' });
  if (typeof name === 'string') track(x).uploads.add(name);
  return name;
}

/** "sub/dir/name.png [output]" — LoadImage/LoadVideo read ComfyUI outputs without a re-upload. */
function annotated(file) {
  const sub = String(file.subfolder || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return `${sub ? `${sub}/` : ''}${file.filename} [output]`;
}

const RUN_ID = /^[A-Za-z0-9][\w-]{2,80}$/;

/** Unique SaveImage prefix for this run (ComfyUI counters restart at 1 in a new subfolder). */
const prefix = (x, sub, name) => {
  track(x).outputs = true;
  return `mia/${x.runId || 'run'}${sub ? `/${sub}` : ''}/${name}`;
};

const isInside = (base, p) => {
  const r = path.relative(base, p);
  return !!r && !r.startsWith('..') && !path.isAbsolute(r);
};

/**
 * Deletes what this run put in the engine's folders, once Mia has its own copy (SPEC §16): the run's output
 * folder <outputDir>\mia\<runId>\ and the files it uploaded to <inputDir>\mia\. Nothing else is ever touched:
 * every path is checked to sit inside those two `mia` folders. After a failure or a cancel ComfyUI may still be
 * writing (or reading an upload): a second sweep runs 30 s later.
 */
async function release(x, { late = false } = {}) {
  const s = runFiles.get(x);
  if (!s) return;
  const info = infoCache.get(x) || {};
  const outputDir = info.outputDir || (x.comfy && x.comfy.outputDir) || null;
  const inputDir = info.inputDir || (x.comfy && x.comfy.inputDir) || null;
  const doomed = [];
  if (s.outputs && outputDir && RUN_ID.test(String(x.runId || ''))) {
    const base = path.resolve(outputDir, 'mia');
    const dir = path.resolve(base, String(x.runId));
    if (isInside(base, dir) && path.dirname(dir) === base) doomed.push(dir);
  }
  if (inputDir) {
    const base = path.resolve(inputDir, 'mia');
    for (const name of s.uploads) {
      const parts = String(name).replace(/\s*\[input\]$/, '').split(/[\\/]+/).filter(Boolean);
      if (parts[0] !== 'mia' || parts.includes('..')) continue;
      const f = path.resolve(inputDir, ...parts);
      if (path.dirname(f) === base && isInside(base, f)) doomed.push(f);
    }
  }
  await cleanup(doomed);
  if (late) {
    const timer = setTimeout(() => { cleanup(doomed).catch(() => {}); }, 30000);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
}

/**
 * Leftovers of runs that ended long ago (before this cleanup existed, or a crash): <outputDir>\mia\r_*\ and
 * <inputDir>\mia\* untouched for `olderThanMs` (default 6 h — a long « Rendre photoréaliste » stays well under).
 * For engine/index.js at start-up (B1). Never looks outside those two `mia` folders. Returns the bytes freed.
 */
async function sweepEngineTemps({ outputDir, inputDir } = {}, { olderThanMs = 6 * 3600 * 1000, now = Date.now() } = {}) {
  let freed = 0;
  const old = async (p) => {
    try { const st = await fsp.stat(p); return now - st.mtimeMs > olderThanMs ? st : null; } catch { return null; }
  };
  const sizeOf = async (p) => {
    let n = 0;
    try {
      for (const e of await fsp.readdir(p, { withFileTypes: true })) {
        const q = path.join(p, e.name);
        if (e.isDirectory()) n += await sizeOf(q);
        else { try { n += (await fsp.stat(q)).size; } catch { /* gone */ } }
      }
    } catch { /* gone */ }
    return n;
  };
  if (outputDir) {
    const base = path.resolve(outputDir, 'mia');
    let names = [];
    try { names = await fsp.readdir(base); } catch { names = []; }
    for (const n of names) {
      if (!/^r_[\w-]+$/.test(n)) continue;
      const dir = path.join(base, n);
      // the newest file decides (a run still writing keeps its folder)
      const st = await old(dir);
      if (!st || !st.isDirectory()) continue;
      let recent = false;
      try {
        for (const e of await fsp.readdir(dir, { withFileTypes: true, recursive: true })) {
          if (!e.isFile()) continue;
          const f = path.join(e.parentPath || e.path || dir, e.name);
          if (!(await old(f))) { recent = true; break; }
        }
      } catch { recent = true; }
      if (recent) continue;
      freed += await sizeOf(dir);
      await cleanup(dir);
    }
  }
  if (inputDir) {
    const base = path.resolve(inputDir, 'mia');
    let names = [];
    try { names = await fsp.readdir(base, { withFileTypes: true }); } catch { names = []; }
    for (const e of names) {
      if (!e.isFile()) continue;
      const f = path.join(base, e.name);
      const st = await old(f);
      if (!st) continue;
      freed += st.size;
      await cleanup(f);
    }
  }
  return freed;
}

/** Wraps an executor's run(): whatever happens, the engine-side temp files of the run are removed. */
function wrap(fn) {
  return async function run(x) {
    let ok = false;
    try {
      const res = await fn(x);
      ok = true;
      return res;
    } finally {
      await release(x, { late: !ok }).catch(() => {});
    }
  };
}

/**
 * Validates the graph against the live engine, then submits it, progress mapped onto `range`.
 * Previews, the job label and the signal are already plugged into the comfy client the engine hands us
 * (engine/index.js boundComfy); we only pass what we change. `keep` names the copy of the graph written next
 * to the result (reopenable in ComfyUI, the first thing to read on a bug).
 */
async function submit(x, graph, { range = [0, 1], keep = 'comfy_graph' } = {}) {
  checkAbort(x);
  const info = await engine(x);
  const prog = ranged(x, range[0], range[1]);
  await validate.ensureValid(graph, { comfy: x.comfy, info });
  try {
    await fsp.writeFile(path.join(x.outDir, `${keep}.json`), JSON.stringify(graph, null, 1), 'utf8');
  } catch { /* not worth failing a run */ }
  prog(0, t('sending'));
  const res = await x.comfy.submit(graph, {
    signal: x.signal,
    onProgress: (p, msg) => prog(p, msg || t('computing')),
  });
  checkAbort(x);
  if (typeof x.log === 'function' && res && res.promptId) x.log(`ComfyUI prompt ${res.promptId}`);
  return res || {};
}

/** Files one output node wrote ({abs, filename, subfolder}), in batch order, outputs only. */
async function files(x, outputs, nodeId) {
  const sub = outputs && outputs[nodeId];
  if (!sub) return [];
  let list = null;
  if (typeof x.comfy.files === 'function') {
    try { list = await x.comfy.files({ [nodeId]: sub }); } catch { list = null; }
  }
  if (!Array.isArray(list) || !list.length) {
    const info = await engine(x);
    list = [];
    for (const key of ['images', 'videos', 'gifs', 'audio']) {
      for (const o of sub[key] || []) {
        list.push({ abs: path.join(info.outputDir || '', o.subfolder || '', o.filename), filename: o.filename,
          subfolder: o.subfolder || '', type: o.type || 'output' });
      }
    }
  }
  return list.filter((f) => !f.type || f.type === 'output');
}

async function filesOrThrow(x, outputs, nodeId) {
  const list = await files(x, outputs, nodeId);
  if (!list.length) throw new Error(t('noOutput'));
  return list;
}

/** Media meta of an input: what B1 probed, else ffmpeg.probe. */
async function metaOf(x, inp) {
  const m = { ...(inp.meta || {}) };
  const isVideo = inp.kind === 'video';
  if (!m.w || !m.h || (isVideo && (!m.fps || !m.frames || m.hasAudio === undefined))) {
    try { Object.assign(m, await x.ffmpeg.probe(inp.abs)); } catch { /* keep what we have */ }
  }
  if (isVideo && !m.frames && m.duration && m.fps) m.frames = Math.round(m.duration * m.fps);
  if (inp.skipFirst && m.frames) m.frames -= 1;
  return m;
}

// ---------------------------------------------------------------- ffmpeg

let nvencOk = null;

async function hasNvenc(x) {
  if (nvencOk != null) return nvencOk;
  try { nvencOk = typeof x.ffmpeg.nvenc === 'function' ? !!(await x.ffmpeg.nvenc()) : true; } catch { nvencOk = true; }
  return nvencOk;
}

/**
 * Video codec args. 'final' = what Quentin judges (lab: cq 10–16, one single encode from PNG);
 * 'inter' = an intermediate the engine reads back (near lossless).
 */
function codecArgs(nv, kind = 'final') {
  if (nv) {
    return ['-c:v', 'h264_nvenc', '-preset', kind === 'final' ? 'p7' : 'p5', '-tune', 'hq', '-rc', 'vbr',
      '-cq', kind === 'final' ? '12' : '10', '-b:v', '0', '-profile:v', 'high', '-pix_fmt', 'yuv420p'];
  }
  return ['-c:v', 'libx264', '-preset', kind === 'final' ? 'slow' : 'fast', '-crf', kind === 'final' ? '12' : '10',
    '-pix_fmt', 'yuv420p'];
}

const tail = (s, n = 400) => String(s || '').trim().split(/\r?\n/).slice(-4).join(' ').slice(-n);

/** Runs ffmpeg; throws a readable error (and an AbortError when cancelled). */
async function ffmpeg(x, args, { what = 'ffmpeg', duration = null, range = null, msg = null } = {}) {
  checkAbort(x);
  const prog = range ? ranged(x, range[0], range[1]) : null;
  if (prog) prog(0, msg || t('encoding'));
  const r = await x.ffmpeg.run(['-y', '-hide_banner', '-v', 'error', ...args], {
    duration: duration || undefined,
    signal: x.signal,
    onProgress: prog ? (p) => prog(p, msg || t('encoding')) : undefined,
  });
  checkAbort(x);
  if (r && r.code !== 0 && r.code != null) {
    const e = new Error(t('ffmpegFailed', { what, detail: tail(r.stderr) }));
    e.stderr = r.stderr;
    throw e;
  }
  return r;
}

// what ffmpeg says when the GPU encoder itself refuses (busy sessions, driver), as opposed to a bad filter
const NVENC_REFUSED = /nvenc|nvcuda|cuda|encode ?session|capable devices|InitializeEncoder/i;

/** Encodes with NVENC, retrying once on libx264 if the GPU encoder refuses (busy, old driver…). */
async function encode(x, before, after, dst, opts = {}) {
  const kind = opts.kind || 'final';
  const nv = await hasNvenc(x);
  try {
    return await ffmpeg(x, [...before, ...codecArgs(nv, kind), ...after, dst], opts);
  } catch (e) {
    if (!nv || e.cancelled || !NVENC_REFUSED.test(String(e.stderr || ''))) throw e;
    if (typeof x.log === 'function') x.log(`NVENC refused (${tail(e.stderr, 200)}), retrying with libx264`);
    return ffmpeg(x, [...before, ...codecArgs(false, kind), ...after, dst], opts);
  }
}

const ffPath = (p) => String(p).replace(/%/g, '%%');

/**
 * Describes a frame list as an image2 input. ComfyUI names frames "<prefix>_00001_.png"; when the list
 * is one contiguous run in one folder we read it in place, else we hard-link it into a temp folder.
 */
async function framesInput(x, frames, fps) {
  if (!frames.length) throw new Error(t('noOutput'));
  const re = /^(.*_)(\d{5,})_\.png$/i;
  const first = path.basename(frames[0]).match(re);
  const dir = path.dirname(frames[0]);
  let contiguous = !!first;
  if (contiguous) {
    const start = Number(first[2]);
    contiguous = frames.every((f, i) => {
      const m = path.basename(f).match(re);
      return m && path.dirname(f) === dir && m[1] === first[1] && Number(m[2]) === start + i;
    });
    if (contiguous) {
      return { args: ['-framerate', String(fps), '-start_number', String(start),
        '-i', path.join(ffPath(dir), `${ffPath(first[1])}%0${first[2].length}d_.png`)], tmpDir: null };
    }
  }
  const seq = tmp(x, `seq_${Date.now().toString(36)}`);
  await fsp.mkdir(seq, { recursive: true });
  for (let i = 0; i < frames.length; i++) {
    const dst = path.join(seq, `f_${String(i).padStart(6, '0')}.png`);
    try { await fsp.link(frames[i], dst); } catch { await fsp.copyFile(frames[i], dst); }
  }
  return { args: ['-framerate', String(fps), '-start_number', '0', '-i', path.join(ffPath(seq), 'f_%06d.png')],
    tmpDir: seq };
}

/**
 * PNG frames (+ optional audio file / audio from a video) -> one h264 mp4.
 * vf: filter chain on the frames; complex: full -filter_complex (must output [v]); extraInputs: more -i.
 */
async function framesToVideo(x, frames, dst, { fps, vf = null, complex = null, extraInputs = [], audio = null,
  count = null, range = null, msg = null, kind = 'final' } = {}) {
  const inp = await framesInput(x, frames, fps);
  try {
    const before = [...inp.args, ...extraInputs];
    const nIn = 1 + extraInputs.filter((a) => a === '-i').length;
    if (audio) before.push('-i', audio);
    const after = [];
    if (complex) after.push('-filter_complex', complex, '-map', '[v]');
    else {
      if (vf) after.push('-vf', vf);
      after.push('-map', '0:v:0');
    }
    const n = count || frames.length;
    // audio padded with silence then cut at the last frame: -shortest could drop the video's tail instead
    if (audio) after.push('-map', `${nIn}:a:0?`, '-af', 'apad', '-c:a', 'aac', '-b:a', '192k', '-t', (n / fps).toFixed(4));
    else after.push('-an');
    after.push('-frames:v', String(n), '-r', String(fps), '-movflags', '+faststart');
    await encode(x, before, after, dst, { kind, what: path.basename(dst), duration: n / fps, range, msg: msg || t('encoding') });
  } finally {
    if (inp.tmpDir) await cleanup(inp.tmpDir);
  }
  return dst;
}

/** One still image through ffmpeg filters (resize / invert); a plain copy when nothing to do. */
async function stillTo(x, src, dst, vf = null) {
  if (!vf) {
    await fsp.copyFile(src, dst);
    return dst;
  }
  await ffmpeg(x, ['-i', src, '-vf', vf, '-frames:v', '1', '-update', '1', dst], { what: path.basename(dst) });
  return dst;
}

/**
 * A video re-timed / trimmed / resized for upload (near-lossless intermediate in outDir).
 * opts: { fps (resample), frames (exact count; the last frame is cloned if the source is short),
 *         start (first source frame), vf (filters after trim/resample), audio (only if the source has one),
 *         srcFps (needed to cut the audio at `start`) }
 */
async function prepVideo(x, inp, dst, { fps = null, frames = null, start = 0, vf = null, audio = false,
  srcFps = null, range = null } = {}) {
  if (inp.skipFirst) start += 1;           // import block "skip the broken first frame", if B1 left it to us
  const chain = [];
  if (start > 0) chain.push(`trim=start_frame=${start}`, 'setpts=PTS-STARTPTS');
  if (fps) chain.push(`fps=${fps}`);
  // after trim+setpts the link has no frame rate any more: tpad's clones would all share one timestamp and the
  // output would come out short (checked: 49 + 2 frames instead of 97) — restate the source rate
  else if (start > 0 && frames && srcFps) chain.push(`fps=${srcFps}`);
  if (vf) chain.push(vf);
  if (frames) chain.push(`tpad=stop_mode=clone:stop=${frames}`);   // never short; -frames:v cuts the excess
  const outFps = fps || srcFps;
  const after = ['-vf', chain.length ? chain.join(',') : 'null', '-map', '0:v:0'];
  if (audio) {
    after.push('-map', '0:a:0?');
    if (start > 0 && srcFps) after.push('-af', `atrim=start=${(start / srcFps).toFixed(4)},asetpts=PTS-STARTPTS`);
    after.push('-c:a', 'aac', '-b:a', '192k');
    if (frames && outFps) after.push('-t', (frames / outFps).toFixed(4));
  } else after.push('-an');
  if (frames) after.push('-frames:v', String(frames));
  // an explicit output rate: after trim the last frame has no duration and the mp4 would lose it on decode
  if (outFps) after.push('-r', String(outFps));
  await encode(x, ['-i', inp.abs], after, dst, { kind: 'inter', what: path.basename(dst), range,
    duration: frames && outFps ? frames / outFps : null, msg: t('preparingVideo') });
  return dst;
}

/** A decimal number in the run's language: « 2,5 » in French, "2.5" in English. */
const dec = (v, digits = 1) => {
  const str = Number(v).toFixed(digits);
  return lang === 'fr' ? str.replace('.', ',') : str;
};

/** Text for run.json `notes`. */
const notes = (list) => list.filter(Boolean).join('\n') || undefined;

const exec = {
  setLang, begin, t, abortError, checkAbort,
  snap, even, ltxFrames, ceil8k1, int, seedOf, ltxMinutes, FORMAT_RATIOS, formatRatio, videoSize, shortSide,
  input, promptOf, model, modelFile, labelOf, isMinimax, minimaxLength,
  familyKey, familyLabel, loraTrigger, withTrigger, listedName, lora, loraPrompt, addLora, requireModels,
  engine, ranged, tmp, cleanup, upload, annotated, prefix, release, wrap, sweepEngineTemps, submit, files, filesOrThrow, metaOf,
  hasNvenc, codecArgs, ffmpeg, encode, framesInput, framesToVideo, stillTo, prepVideo, notes, dec,
};

module.exports = {
  WF_DIR, load, clone, isLink, node, set, setInputs, get, consumers, relink, bypass, insertAfter, remove,
  removeByPrefix, findByClass, freeId, addNode, replaceNode, prune, OUTPUT_CLASSES,
  exec,
};
