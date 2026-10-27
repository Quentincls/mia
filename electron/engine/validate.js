'use strict';
// Mia — offline validator of a ComfyUI API graph against the /object_info schema.
//
// Why: ComfyUI refuses a whole prompt for one bad value, and validates every node upstream of an output
// even on a branch a switch disables (engine.md §2). Catching it here gives Quentin a French sentence
// instead of a 400, and stops the two traps that cost real money or rights: nodes that download a model
// when asked for a missing file (SeedVR2 "(Down)Load", Video Depth Anything), and cloud "partner" nodes.
//
// validateGraph(graph, ctx) is pure (no I/O except optional existence checks on disk):
//   ctx = { objectInfo,                       // { ClassName: schema } as served by /object_info
//           models: { folder: [file…] }|null, // /models/<folder> lists (what ComfyUI really sees)
//           inputDir, outputDir, modelsDir }  // optional: check uploads / VDA weights on disk
//   → { ok, problems: [{ level: 'error'|'warn', node, cls, input, code, msg }] }
// ensureValid(graph, { comfy, info }) fetches all that from the live engine and throws a French error.

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------- messages
const MSG = {
  fr: {
    empty: 'Le graphe est vide.',
    badNode: 'Bloc moteur mal formé.',
    unknownClass: 'Bloc moteur inconnu « {cls} » : une extension ComfyUI manque ou a changé.',
    cloud: 'Bloc « {cls} » interdit : c’est un service en ligne payant (Mia reste 100 % locale).',
    missing: 'Réglage obligatoire absent : « {input} ».',
    noSource: 'Relié à un bloc absent (« {src} »).',
    badIndex: 'Relié à une sortie qui n’existe pas (sortie {idx} de « {src} »).',
    badType: 'Branchement incompatible : {got} vers {want}.',
    needLink: 'Doit être relié à un autre bloc, pas une valeur fixe.',
    notInList: 'Valeur « {value} » hors de la liste permise.',
    badKind: 'Valeur « {value} » : {want} attendu.',
    range: 'Valeur {value} hors limites ({min} … {max}).',
    modelMissing: 'Modèle introuvable : {file} (dossier {folder}).',
    modelUnchecked: 'Impossible de vérifier que {file} est installé : refusé pour ne rien télécharger.',
    downloader: 'Ce bloc téléchargerait « {file} », absent du disque : refusé (aucun téléchargement automatique).',
    license: 'Modèle « {file} » non autorisé (licence non commerciale).',
    upload: 'Fichier d’entrée introuvable dans le moteur : {file}.',
    badUpload: 'Nom de fichier d’entrée invalide : « {file} ».',
    unknownInput: 'Entrée inconnue « {input} » (ignorée par ComfyUI).',
    noOutput: 'Le graphe n’a aucune sortie : rien ne serait calculé.',
    cycle: 'Le graphe tourne en rond (boucle de liens).',
    minimaxHint: 'MiniMax H3 n’est visible que si ComfyUI est lancé avec config\\extra_minimax.yaml.',
    notInstalled: 'Le modèle « {label} » n’est pas installé ({file} absent du dossier {folder}).',
    tooMany: '{n} entrées branchées, {max} au plus.',
    invalid: 'Le moteur refuserait ce calcul :',
    more: '… et {n} autre(s) problème(s).',
    noSchema: 'Impossible de lire la liste des blocs du moteur : ComfyUI répond-il ?',
  },
  en: {
    empty: 'The graph is empty.',
    badNode: 'Malformed engine block.',
    unknownClass: 'Unknown engine block “{cls}”: a ComfyUI extension is missing or changed.',
    cloud: 'Block “{cls}” is not allowed: it is a paid online service (Mia stays 100% local).',
    missing: 'Required setting missing: “{input}”.',
    noSource: 'Wired to a missing block (“{src}”).',
    badIndex: 'Wired to an output that does not exist (output {idx} of “{src}”).',
    badType: 'Incompatible wire: {got} into {want}.',
    needLink: 'Must be wired to another block, not a fixed value.',
    notInList: 'Value “{value}” is not in the allowed list.',
    badKind: 'Value “{value}”: {want} expected.',
    range: 'Value {value} out of range ({min} … {max}).',
    modelMissing: 'Model not found: {file} (folder {folder}).',
    modelUnchecked: 'Cannot check that {file} is installed: refused so nothing gets downloaded.',
    downloader: 'This block would download “{file}”, which is not on disk: refused (no automatic download).',
    license: 'Model “{file}” is not allowed (non-commercial licence).',
    upload: 'Input file not found in the engine: {file}.',
    badUpload: 'Invalid input file name: “{file}”.',
    unknownInput: 'Unknown input “{input}” (ignored by ComfyUI).',
    noOutput: 'The graph has no output: nothing would be computed.',
    cycle: 'The graph loops on itself (link cycle).',
    minimaxHint: 'MiniMax H3 is only visible when ComfyUI is started with config\\extra_minimax.yaml.',
    notInstalled: 'The “{label}” model is not installed ({file} missing from the {folder} folder).',
    tooMany: '{n} inputs wired, {max} at most.',
    invalid: 'The engine would refuse this run:',
    more: '… and {n} more problem(s).',
    noSchema: 'Cannot read the engine’s block list: is ComfyUI answering?',
  },
};
let lang = 'fr';
const setLang = (l) => { lang = l === 'en' ? 'en' : 'fr'; };
const t = (k, v = {}) => String(MSG[lang][k] ?? MSG.fr[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => (v[n] ?? ''));

// ---------------------------------------------------------------- rules

const MODEL_EXT = /\.(safetensors|sft|ckpt|pt|pt2|pth|bin|gguf|onnx)$/i;

// Which ComfyUI folder a model widget reads (checked against /models/<folder>, what ComfyUI really sees).
const MODEL_FOLDERS = {
  'UNETLoader.unet_name': 'diffusion_models',
  'CLIPLoader.clip_name': 'text_encoders',
  'DualCLIPLoader.clip_name1': 'text_encoders',
  'DualCLIPLoader.clip_name2': 'text_encoders',
  'CLIPVisionLoader.clip_name': 'clip_vision',
  'VAELoader.vae_name': 'vae',
  'LoraLoaderModelOnly.lora_name': 'loras',
  'LoraLoader.lora_name': 'loras',
  'LTXICLoRALoaderModelOnly.lora_name': 'loras',
  'LatentUpscaleModelLoader.model_name': 'latent_upscale_models',
  'ModelPatchLoader.name': 'model_patches',
  'UpscaleModelLoader.model_name': 'upscale_models',
  'CheckpointLoaderSimple.ckpt_name': 'checkpoints',
  'SeedVR2LoadDiTModel.model': 'seedvr2',
  'SeedVR2LoadVAEModel.model': 'seedvr2',
  // no ComfyUI folder: the node joins models_dir/videodepthanything itself (and downloads when missing)
  'LoadVideoDepthAnythingModel.model': 'disk:videodepthanything',
};

// Nodes whose list offers files that are NOT on disk and that fetch them from the internet when chosen.
const DOWNLOADERS = new Set(['SeedVR2LoadDiTModel.model', 'SeedVR2LoadVAEModel.model',
  'LoadVideoDepthAnythingModel.model']);

// Licence guards (engine.md §7.9): VDA Base/Large and metric variants are non-commercial.
const LICENSE = [
  { key: 'LoadVideoDepthAnythingModel.model', bad: (v) => !/vits/i.test(v) || /metric/i.test(v) },
];

// Files a block of Mia needs but that are not installed on this PC yet (SPEC §17): a plain « not installed »
// sentence instead of « model not found » + the MiniMax launch hint.
const NOT_INSTALLED = {
  'minimax_h3_ref2va_pruned_int8_convrot.safetensors': { fr: 'MiniMax H3 · références', en: 'MiniMax H3 · references' },
  'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors': { fr: 'MiniMax H3 · références', en: 'MiniMax H3 · references' },
};
const notInstalledLabel = (v) => {
  const e = NOT_INSTALLED[String(v).split(/[\\/]/).pop()];
  return e ? (e[lang] || e.fr) : null;
};

const UPLOAD_FLAGS = ['image_upload', 'video_upload', 'audio_upload', 'file_upload'];
const PRIMS = new Set(['INT', 'FLOAT', 'BOOLEAN', 'STRING']);

const isLink = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1]);

function isCloud(schema) {
  return schema.api_node === true || /^(partner|comfy cloud|api node)/i.test(String(schema.category || ''));
}

/** Normalises one object_info input entry into { kind, … }. */
function specOf(entry) {
  const [type, opts = {}] = Array.isArray(entry) ? entry : [entry, {}];
  if (Array.isArray(type)) return { kind: 'combo', options: type, opts };
  if (type === 'COMBO') return { kind: 'combo', options: opts.options || [], opts };
  if (type === 'COMFY_DYNAMICCOMBO_V3') return { kind: 'dyn', options: opts.options || [], opts };
  if (type === 'COMFY_AUTOGROW_V3') return { kind: 'grow', template: opts.template || {}, opts };
  if (type === 'COMFY_MATCHTYPE_V3') {
    return { kind: 'match', types: String((opts.template && opts.template.allowed_types) || '*'), opts };
  }
  return { kind: 'typed', types: String(type), opts };
}

function typeOk(got, want) {
  if (!got || !want) return true;
  const G = String(got).split(','), W = String(want).split(',');
  if (G.includes('*') || W.includes('*')) return true;
  if (/COMFY_/.test(got) || /COMFY_/.test(want)) return true;       // matchtype: resolved at run time
  return G.some((g) => W.includes(g));
}

function literalOk(value, types) {
  const T = String(types).split(',');
  return T.some((tp) => {
    if (tp === 'INT') return typeof value === 'number' && Number.isInteger(value);
    if (tp === 'FLOAT') return typeof value === 'number' && Number.isFinite(value);
    if (tp === 'BOOLEAN') return typeof value === 'boolean';
    if (tp === 'STRING') return typeof value === 'string';
    return tp === '*';
  });
}

const short = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
};

// ---------------------------------------------------------------- the validator

function validateGraph(graph, ctx = {}) {
  const oi = ctx.objectInfo || {};
  const problems = [];
  const add = (level, id, cls, input, code, vars = {}) =>
    problems.push({ level, node: id, cls, input: input || null, code, msg: t(code, { cls, input, ...vars }) });

  if (!graph || typeof graph !== 'object' || !Object.keys(graph).length) {
    add('error', null, null, null, 'empty');
    return { ok: false, problems };
  }

  const ids = Object.keys(graph);
  let outputs = 0;

  for (const id of ids) {
    const n = graph[id];
    if (!n || typeof n.class_type !== 'string' || typeof n.inputs !== 'object' || n.inputs === null) {
      add('error', id, n && n.class_type, null, 'badNode');
      continue;
    }
    const cls = n.class_type;
    const schema = oi[cls];
    if (!schema) { add('error', id, cls, null, 'unknownClass'); continue; }
    if (isCloud(schema)) add('error', id, cls, null, 'cloud');
    if (schema.output_node) outputs++;

    const used = new Set();
    const sections = schema.input || {};
    for (const [section, entries] of Object.entries(sections)) {
      if (section === 'hidden') continue;
      for (const [name, entry] of Object.entries(entries || {})) {
        checkInput(id, cls, name, specOf(entry), section === 'required', n.inputs, used);
      }
    }
    for (const k of Object.keys(n.inputs)) if (!used.has(k)) add('warn', id, cls, k, 'unknownInput');
  }

  if (!outputs) add('error', null, null, null, 'noOutput');
  if (hasCycle(graph)) add('error', null, null, null, 'cycle');

  return { ok: !problems.some((p) => p.level === 'error'), problems };

  // ---- one input (recursive for dynamic combos / autogrow) ----
  function checkInput(id, cls, name, spec, required, values, used) {
    const has = Object.prototype.hasOwnProperty.call(values, name);
    if (spec.kind === 'grow') { checkGrow(id, cls, name, spec, required, values, used); return; }
    if (!has) {
      if (required) add('error', id, cls, name, 'missing');
      return;
    }
    used.add(name);
    const v = values[name];

    if (isLink(v)) { checkLink(id, cls, name, v, spec); return; }

    switch (spec.kind) {
      case 'combo': checkCombo(id, cls, name, v, spec); break;
      case 'dyn': {
        const opt = spec.options.find((o) => String(o.key) === String(v));
        if (!opt) { add('error', id, cls, name, 'notInList', { value: short(v) }); break; }
        for (const [section, entries] of Object.entries(opt.inputs || {})) {
          for (const [sub, entry] of Object.entries(entries || {})) {
            checkInput(id, cls, `${name}.${sub}`, specOf(entry), section === 'required', values, used);
          }
        }
        break;
      }
      case 'match': add('error', id, cls, name, 'needLink'); break;
      default: checkTyped(id, cls, name, v, spec);
    }
  }

  function checkGrow(id, cls, name, spec, required, values, used) {
    const tpl = spec.template || {};
    const slotSections = (tpl.input) || {};
    const keys = Object.keys(values).filter((k) => k.startsWith(`${name}.`));
    for (const k of keys) {
      used.add(k);
      const v = values[k];
      // every slot shares the template's single input spec
      const entry = Object.values(slotSections.required || {})[0] || Object.values(slotSections.optional || {})[0];
      const spec1 = entry ? specOf(entry) : { kind: 'typed', types: '*' };
      if (isLink(v)) checkLink(id, cls, k, v, spec1);
      else if (spec1.kind === 'typed' && !literalOk(v, spec1.types)) {
        add('error', id, cls, k, 'badKind', { value: short(v), want: spec1.types });
      }
    }
    const min = (spec.opts && spec.opts.min) || tpl.min || 0;
    const max = (spec.opts && spec.opts.max) || tpl.max || 0;
    if (required && min > 0 && keys.length < min) add('error', id, cls, `${name}.*`, 'missing');
    if (max > 0 && keys.length > max) add('error', id, cls, `${name}.*`, 'tooMany', { n: keys.length, max });
  }

  function checkLink(id, cls, name, v, spec) {
    const [src, idx] = v;
    const sn = graph[src];
    if (!sn) { add('error', id, cls, name, 'noSource', { src }); return; }
    const ss = oi[sn.class_type];
    if (!ss) return;                                   // reported on the source node itself
    const outs = ss.output || [];
    if (idx < 0 || idx >= outs.length) { add('error', id, cls, name, 'badIndex', { src, idx }); return; }
    const got = Array.isArray(outs[idx]) ? 'COMBO' : outs[idx];
    let want;
    if (spec.kind === 'typed') want = spec.types;
    else if (spec.kind === 'match') want = spec.types;
    else want = 'COMBO';
    if (!typeOk(got, want)) add('error', id, cls, name, 'badType', { got, want });
  }

  function checkTyped(id, cls, name, v, spec) {
    const types = spec.types;
    const prim = String(types).split(',').some((tp) => PRIMS.has(tp));
    if (!prim) { add('error', id, cls, name, 'needLink'); return; }
    if (!literalOk(v, types)) { add('error', id, cls, name, 'badKind', { value: short(v), want: types }); return; }
    if (typeof v === 'number') {
      const { min, max } = spec.opts || {};
      if ((typeof min === 'number' && v < min) || (typeof max === 'number' && v > max)) {
        add('error', id, cls, name, 'range', { value: v, min: min ?? '−∞', max: max ?? '∞' });
      }
    }
    if (typeof v === 'string') checkModel(id, cls, name, v);
  }

  function checkCombo(id, cls, name, v, spec) {
    const isUpload = UPLOAD_FLAGS.some((f) => spec.opts && spec.opts[f]);
    if (isUpload) { checkUpload(id, cls, name, v); return; }
    const inList = spec.options.some((o) => o === v || String(o) === String(v));
    if (!inList) {
      const file = typeof v === 'string' && MODEL_EXT.test(v);
      const folder = MODEL_FOLDERS[`${cls}.${name}`];
      // the schema lists files as they were when /object_info was read: a LoRA Mia just placed
      // (models\loras\mia\…) is only in the live /models/<folder> list — the one ComfyUI checks at queue time
      const live = file && folder && !folder.startsWith('disk:') && ctx.models && Array.isArray(ctx.models[folder])
        && ctx.models[folder].includes(v);
      if (live) { checkModel(id, cls, name, v); return; }
      const label = file ? notInstalledLabel(v) : null;
      if (label) { add('error', id, cls, name, 'notInstalled', { label, file: v, folder: folder || '?' }); return; }
      add('error', id, cls, name, file ? 'modelMissing' : 'notInList',
        { value: short(v), file: v, folder: folder || '?' });
      if (file && /minimax/i.test(v)) add('error', id, cls, name, 'minimaxHint');
      return;
    }
    if (typeof v === 'string') checkModel(id, cls, name, v);
  }

  function checkModel(id, cls, name, v) {
    const key = `${cls}.${name}`;
    const rule = LICENSE.find((r) => r.key === key);
    if (rule && rule.bad(v)) add('error', id, cls, name, 'license', { file: v });
    const folder = MODEL_FOLDERS[key];
    if (!folder || !MODEL_EXT.test(v)) return;
    if (folder.startsWith('disk:')) {
      if (!ctx.modelsDir) { add('error', id, cls, name, 'modelUnchecked', { file: v }); return; }
      if (!fs.existsSync(path.join(ctx.modelsDir, folder.slice(5), v))) {
        add('error', id, cls, name, DOWNLOADERS.has(key) ? 'downloader' : 'modelMissing', { file: v, folder });
      }
      return;
    }
    const list = ctx.models && ctx.models[folder];
    if (!Array.isArray(list)) {
      if (DOWNLOADERS.has(key)) add('error', id, cls, name, 'modelUnchecked', { file: v });
      return;
    }
    if (!list.includes(v)) {
      const label = notInstalledLabel(v);
      if (label) { add('error', id, cls, name, 'notInstalled', { label, file: v, folder }); return; }
      add('error', id, cls, name, DOWNLOADERS.has(key) ? 'downloader' : 'modelMissing', { file: v, folder });
      if (/minimax/i.test(v)) add('error', id, cls, name, 'minimaxHint');
    }
  }

  function checkUpload(id, cls, name, v) {
    if (typeof v !== 'string' || !v.trim()) { add('error', id, cls, name, 'badUpload', { file: short(v) }); return; }
    const m = v.match(/^(.*?)(?:\s*\[(input|output|temp)\])?$/);
    const rel = m[1];
    const where = m[2] || 'input';
    if (path.isAbsolute(rel) || /^[a-z]:/i.test(rel) || rel.split(/[\\/]/).includes('..')) {
      add('error', id, cls, name, 'badUpload', { file: v });
      return;
    }
    const base = where === 'output' ? ctx.outputDir : where === 'input' ? ctx.inputDir : null;
    if (base && !fs.existsSync(path.join(base, rel))) add('error', id, cls, name, 'upload', { file: v });
  }
}

function hasCycle(graph) {
  const state = new Map();                  // 1 = visiting, 2 = done
  const visit = (id) => {
    const s = state.get(id);
    if (s === 1) return true;
    if (s === 2 || !graph[id]) return false;
    state.set(id, 1);
    for (const v of Object.values(graph[id].inputs || {})) if (isLink(v) && visit(v[0])) return true;
    state.set(id, 2);
    return false;
  };
  return Object.keys(graph).some((id) => visit(id));
}

/** French (or English) bullet list for an Error message. */
function formatProblems(problems, max = 8) {
  const errs = problems.filter((p) => p.level === 'error');
  const lines = errs.slice(0, max).map((p) => {
    const where = p.cls ? `${p.cls}${p.node ? ` #${p.node}` : ''}${p.input ? ` · ${p.input}` : ''} — ` : '';
    return `• ${where}${p.msg}`;
  });
  if (errs.length > max) lines.push(t('more', { n: errs.length - max }));
  return lines.join('\n');
}

// ---------------------------------------------------------------- live engine glue

let oiCache = null;                         // { at, data }
const OI_TTL = 5 * 60 * 1000;

async function objectInfoFrom(comfy) {
  if (oiCache && Date.now() - oiCache.at < OI_TTL) return oiCache.data;
  let data = null;
  try { data = await comfy.objectInfo(); } catch { data = null; }
  if (!data || typeof data !== 'object' || Object.keys(data).length < 10) throw new Error(t('noSchema'));
  oiCache = { at: Date.now(), data };
  return data;
}

/** Folders a graph's model widgets read (to fetch only those /models lists). */
function foldersOf(graph) {
  const out = new Set();
  for (const n of Object.values(graph || {})) {
    for (const k of Object.keys(n.inputs || {})) {
      const f = MODEL_FOLDERS[`${n.class_type}.${k}`];
      if (f && !f.startsWith('disk:')) out.add(f);
    }
  }
  return [...out];
}

async function modelsFrom(comfy, folders) {
  const models = {};
  for (const f of folders) {
    try {
      const list = await comfy.models(f);
      if (Array.isArray(list)) models[f] = list;
    } catch { /* left unknown: downloaders then refuse, others rely on the schema list */ }
  }
  return models;
}

/** Validates against the running engine; throws a readable Error (err.problems) when it would fail. */
/** /models/<folder> straight from ComfyUI, past every cache (a LoRA placed a second ago). GET only. */
async function freshModels(comfy, folders) {
  const out = {};
  const url = comfy && typeof comfy.url === 'string' ? comfy.url.replace(/\/+$/, '') : null;
  if (!url || typeof fetch !== 'function') return out;
  for (const f of folders) {
    try {
      const r = await fetch(`${url}/models/${encodeURIComponent(f)}`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) { const j = await r.json(); if (Array.isArray(j)) out[f] = j; }
    } catch { /* keep the cached list */ }
  }
  return out;
}

async function ensureValid(graph, { comfy, info = {} } = {}) {
  let objectInfo = await objectInfoFrom(comfy);
  // a node the cached schema lacks may come from a pack installed since (same ComfyUI version): ask for it alone
  const absent = [...new Set(Object.values(graph || {}).map((n) => n && n.class_type))]
    .filter((c) => c && !objectInfo[c] && typeof comfy.objectInfo === 'function');
  if (absent.length) {
    objectInfo = { ...objectInfo };
    for (const c of absent) {
      try { const v = await comfy.objectInfo(c); if (v) objectInfo[c] = v; } catch { /* stays unknown */ }
    }
  }
  const models = await modelsFrom(comfy, foldersOf(graph));
  const ctx = { objectInfo, models, inputDir: info.inputDir, outputDir: info.outputDir, modelsDir: info.modelsDir };
  let r = validateGraph(graph, ctx);
  const stale = [...new Set(r.problems.filter((p) => p.level === 'error' && p.code === 'modelMissing')
    .map((p) => MODEL_FOLDERS[`${p.cls}.${p.input}`]).filter((f) => f && !f.startsWith('disk:')))];
  if (stale.length) {
    // the 60 s list cache may predate a file that just arrived (a LoRA Mia placed): ask ComfyUI again, once
    Object.assign(models, await freshModels(comfy, stale));
    r = validateGraph(graph, ctx);
  }
  if (!r.ok) {
    const err = new Error(`${t('invalid')}\n${formatProblems(r.problems)}`);
    err.code = 'MIA_INVALID_GRAPH';
    err.problems = r.problems;
    throw err;
  }
  return r;
}

/** Offline schema (e.g. tools/fixtures/comfy_object_info.json) for tools and tests. */
const loadObjectInfoFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * TEST MODE ONLY (tools/validate-workflows.js): copies of the schema and of the model lists in which `extra`
 * ({ folder: [file…] }) is installed — to build and check graphs for models Quentin has not downloaded yet.
 */
function assumeInstalled(objectInfo, lists, extra = {}) {
  const oi = JSON.parse(JSON.stringify(objectInfo));
  const models = { ...(lists || {}) };
  for (const [folder, files] of Object.entries(extra)) {
    models[folder] = [...new Set([...(models[folder] || []), ...files])];
    for (const [key, f] of Object.entries(MODEL_FOLDERS)) {
      if (f !== folder) continue;
      const [cls, input] = key.split('.');
      const sec = oi[cls] && oi[cls].input;
      const entry = sec && ((sec.required || {})[input] || (sec.optional || {})[input]);
      if (!entry) continue;
      if (Array.isArray(entry[0])) entry[0] = [...new Set([...entry[0], ...files])];
      else if (entry[1] && Array.isArray(entry[1].options)) entry[1].options = [...new Set([...entry[1].options, ...files])];
    }
  }
  return { objectInfo: oi, models };
}

module.exports = {
  validateGraph, ensureValid, formatProblems, foldersOf, loadObjectInfoFile, isCloud, setLang, assumeInstalled,
  MODEL_FOLDERS, DOWNLOADERS, NOT_INSTALLED,
  _resetCache: () => { oiCache = null; },
};
