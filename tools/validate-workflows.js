#!/usr/bin/env node
'use strict';
// Dry run of Mia's ComfyUI executors (engine/executors: depth, edit, i2v, t2v, real, perform, upscale, ref2v, guided).
//
// Each executor runs for real against a FAKE engine: comfy.submit() records the graph and fabricates the files
// a run would write, ffmpeg.run() only creates its output file. Nothing reaches ComfyUI's queue and no GPU is
// touched. Every recorded graph is then validated (engine/validate.js) against the ComfyUI schema
// (tools/fixtures/comfy_object_info.json, or --schema) and the model lists ComfyUI really sees (GET /models/<folder>,
// read-only; falls back to the schema's own lists when ComfyUI is down). The templates in engine/workflows are
// checked as well. After each run, the engine-side temp files of the run (<output>\mia\<runId>, its uploads in
// <input>\mia) must be gone (SPEC §16). Exit code 1 if anything is invalid.
//
// TEST MODE: models a block needs but that are not installed yet (MiniMax H3 « références », SPEC §17) are
// « assumed installed » only for the variants that say so (`assume`), and one variant checks the clear
// « n'est pas installé » error without the assumption. Same for the LoRAs made up for the family tests.
// Les LoRA de personnage et de lieu des essais (Mara, Theo, Rooftop) sont inventés : supposés installés partout.
// Sans le moteur de l'auteur (--models), les poids Video Depth Anything Small sont supposés présents (dossier
// temporaire), et c'est écrit en tête du rapport.
//
// Le schéma fourni est l'/object_info d'un ComfyUI avec les nœuds LTXVideo, SeedVR2 et Video-Depth-Anything, sans
// les LoRA personnels ni la liste du dossier input. Pour valider contre le vôtre : lancez ComfyUI, enregistrez
// http://127.0.0.1:8188/object_info dans un fichier et passez-le avec --schema.
//
//   node tools/validate-workflows.js [--schema <object_info.json>] [--models <dossier models du moteur>] [--offline]
//                                    [--only i2v,real] [--keep] [--verbose] [--ffmpeg]
//   --offline : listes de modèles tirées du schéma, sans interroger ComfyUI

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'electron', 'engine');
const P = require(path.join(ENGINE, 'patch'));
const V = require(path.join(ENGINE, 'validate'));

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const SCHEMA = path.resolve(opt('--schema') || path.join(__dirname, 'fixtures', 'comfy_object_info.json'));
const ONLY = (opt('--only') || '').split(',').filter(Boolean);
const KEEP = argv.includes('--keep');
const VERBOSE = argv.includes('--verbose');
const SHOW_FFMPEG = argv.includes('--ffmpeg');
const OFFLINE = argv.includes('--offline');
const COMFY = 'http://127.0.0.1:8188';
// lecture seule : existence des poids VDA ; remplacé par un dossier temporaire quand ils n'y sont pas (main)
let MODELS_DIR = opt('--models') || 'D:/AI_Local_Videos/models';
const VDA_SMALL = path.join('videodepthanything', 'video_depth_anything_vits.pth');
const FOLDERS = ['diffusion_models', 'text_encoders', 'vae', 'loras', 'clip_vision', 'latent_upscale_models',
  'model_patches', 'seedvr2', 'upscale_models', 'checkpoints'];

// models expected by Mia but not on this PC yet (SPEC §17) — assumed only where a variant says so
const REF2V = require(path.join(ENGINE, 'executors', 'ref2v.js'));
const PENDING = { diffusion_models: [REF2V.REF2VA], loras: [REF2V.TURBO4] };
// LoRAs made up for the family / placement tests (« mia\… » = ComfyUI's Windows spelling of models\loras\mia\…)
const TEST_LORAS = { loras: ['wan_style_test.safetensors', 'qwen_style_test.safetensors', 'minimax_style_test.safetensors',
  'mia\\perso_test.safetensors'] };
const merge = (...sets) => {
  const out = {};
  for (const s of sets) for (const [k, v] of Object.entries(s || {})) out[k] = [...(out[k] || []), ...v];
  return out;
};

// ---------------------------------------------------------------- schema + model lists

async function modelLists(oi) {
  const lists = {};
  let live = !OFFLINE;
  for (const f of OFFLINE ? [] : FOLDERS) {
    try {
      const r = await fetch(`${COMFY}/models/${f}`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error(String(r.status));
      lists[f] = await r.json();
    } catch { live = false; }
  }
  if (!live) {
    // offline: the schema's own combo lists are what ComfyUI listed when it was dumped
    const from = (cls, input) => {
      const e = oi[cls] && oi[cls].input && (oi[cls].input.required[input] || (oi[cls].input.optional || {})[input]);
      if (!e) return [];
      return Array.isArray(e[0]) ? e[0] : ((e[1] && e[1].options) || []);
    };
    Object.assign(lists, {
      diffusion_models: from('UNETLoader', 'unet_name'), text_encoders: from('CLIPLoader', 'clip_name'),
      vae: from('VAELoader', 'vae_name'), loras: from('LoraLoaderModelOnly', 'lora_name'),
      clip_vision: from('CLIPVisionLoader', 'clip_name'), latent_upscale_models: from('LatentUpscaleModelLoader', 'model_name'),
      model_patches: from('ModelPatchLoader', 'name'),
      seedvr2: ['ema_vae_fp16.safetensors', 'seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors'],
    });
  }
  return { lists, live };
}

// ---------------------------------------------------------------- fake engine

function makeFakes(tmp, oi, lists) {
  const inputDir = path.join(tmp, 'comfy_input');
  const outputDir = path.join(tmp, 'comfy_output');
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const frames = new Map();               // abs path -> frame count (inputs + every ffmpeg output)
  const uploads = new Map();              // upload name -> abs path
  const meta = new Map();                 // abs -> probe result

  const ffmpeg = {
    calls: [],
    async run(args) {
      this.calls.push(args);
      const out = args[args.length - 1];
      const fi = args.indexOf('-frames:v');
      const ii = args.indexOf('-i');
      const inherited = ii >= 0 ? frames.get(path.resolve(args[ii + 1])) : null;   // a plain re-encode keeps its length
      const n = fi >= 0 ? Number(args[fi + 1]) : (inherited || 1);
      await fsp.mkdir(path.dirname(out), { recursive: true });
      // thumbnails for the window join: random grey so the "most alike" search really runs
      if (/\.raw$/i.test(out)) await fsp.writeFile(out, crypto.randomBytes(n * 136 * 240));
      else await fsp.writeFile(out, '');
      frames.set(path.resolve(out), n);
      return { code: 0, stderr: '' };
    },
    async probe(abs) { return meta.get(path.resolve(abs)) || { kind: 'image', w: 1080, h: 1920 }; },
    async nvenc() { return true; },
    encodeArgs() { return ['-c:v', 'h264_nvenc']; },
  };

  // frames a graph would produce, from what it reads
  function framesOf(g) {
    for (const n of Object.values(g)) {
      if (n.class_type === 'EmptyLTXVLatentVideo' && typeof n.inputs.length === 'number') return n.inputs.length;
      if (n.class_type === 'MiniMaxH3ImageToVideo' || n.class_type === 'MiniMaxH3ReferenceToVideo') return n.inputs.length;
    }
    if (g['5511'] && g['5512']) return 1 + Math.floor((g['5511'].inputs.value * g['5512'].inputs.value) / 8) * 8;
    const lv = Object.values(g).find((n) => n.class_type === 'LoadVideo');
    if (lv) return frames.get(uploads.get(lv.inputs.file)) || 97;
    return 1;
  }

  const comfy = {
    graphs: [],
    checks: [],
    async ensure() { return { url: COMFY, inputDir, outputDir, modelsDir: MODELS_DIR, version: 'dry-run' }; },
    async upload(abs) {
      const name = `mia/${crypto.createHash('sha1').update(abs).digest('hex').slice(0, 8)}_${path.basename(abs)}`;
      await fsp.mkdir(path.join(inputDir, 'mia'), { recursive: true });
      await fsp.writeFile(path.join(inputDir, name), '');
      uploads.set(name, path.resolve(abs));
      return name;
    },
    async submit(graph, opts = {}) {
      this.graphs.push(JSON.parse(JSON.stringify(graph)));
      // validated now: the run deletes its uploads and outputs from the engine folders once it is over
      this.checks.push(V.validateGraph(graph, { objectInfo: oi, models: lists, inputDir, outputDir, modelsDir: MODELS_DIR }));
      if (opts.onProgress) { opts.onProgress(0.5, 'dry'); opts.onProgress(1, 'dry'); }
      const outputs = {};
      const n = framesOf(graph);
      for (const [id, node] of Object.entries(graph)) {
        const pre = node.inputs.filename_prefix;
        if (typeof pre !== 'string') continue;
        const sub = path.dirname(pre).replace(/\//g, '\\');          // ComfyUI on Windows answers with "\"
        const base = path.basename(pre);
        const dir = path.join(outputDir, path.dirname(pre));
        await fsp.mkdir(dir, { recursive: true });
        if (node.class_type === 'SaveAudioAdvanced') {
          const filename = `${base}_00001_.flac`;
          await fsp.writeFile(path.join(dir, filename), '');
          outputs[id] = { audio: [{ filename, subfolder: sub, type: 'output' }] };
          continue;
        }
        const images = [];
        for (let i = 1; i <= n; i++) {
          const filename = `${base}_${String(i).padStart(5, '0')}_.png`;
          await fsp.writeFile(path.join(dir, filename), '');
          images.push({ filename, subfolder: sub, type: 'output' });
        }
        outputs[id] = { images };
      }
      return { promptId: crypto.randomUUID(), outputs };
    },
    async files(outputs) {
      const list = [];
      for (const o of Object.values(outputs || {})) {
        for (const key of ['images', 'videos', 'gifs', 'audio']) {
          for (const f of o[key] || []) {
            list.push({ abs: path.join(outputDir, f.subfolder, f.filename), filename: f.filename,
              subfolder: f.subfolder, type: f.type, kind: key === 'audio' ? 'audio' : 'image' });
          }
        }
      }
      return list;
    },
    async objectInfo() { return oi; },
    async models(folder) { return lists[folder] || []; },
  };

  return { comfy, ffmpeg, frames, meta, inputDir, outputDir };
}

// ---------------------------------------------------------------- catalog, inventory, variants

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'catalog', 'nodes.json'), 'utf8'));
const typeOf = (id) => catalog.types.find((t) => t.id === id);
const defaults = (type) => Object.fromEntries(type.params.map((p) => [p.id, p.default]));

const inv = (name, folder, family, fr, extra = {}) => ({ id: name.slice(0, 8), file: name, family,
  label: { fr, en: extra.en || fr }, comfy: { folder, name }, ...extra });
const INV = {
  vda: inv('video_depth_anything_vits.pth', 'videodepthanything', 'Video Depth Anything', 'Video Depth Anything (Small)'),
  qwen: inv('qwen_image_edit_2511_int8_convrot.safetensors', 'diffusion_models', 'Qwen-Image', 'Qwen Image Edit 2511'),
  ltxInt8: inv('ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors', 'diffusion_models', 'LTX-2.x',
    'LTX 2.5 · standard', { en: 'LTX 2.5 · standard (EN)' }),
  ltxFp4: inv('ltx-2.5-22b-distilled-transformer-nvfp4.safetensors', 'diffusion_models', 'LTX-2.x', 'LTX 2.5 · rapide',
    { en: 'LTX 2.5 · fast' }),
  minimax: inv('minimax_h3_fl2va_pruned_int8_convrot.safetensors', 'diffusion_models', 'MiniMax H3', 'MiniMax H3'),
  ref2va: inv(REF2V.REF2VA, 'diffusion_models', 'MiniMax H3', 'MiniMax H3 · références', { en: 'MiniMax H3 · references' }),
  mara: inv('mara_ltx25_02000.safetensors', 'loras', 'LTX-2.x', 'Mara', { role: 'lora', trigger: 'mra woman', loraFor: 'ltx' }),
  rooftop: inv('rooftop_ltx25.safetensors', 'loras', 'LTX-2.x', 'Rooftop', { role: 'lora', trigger: 'rooftop place' }),
  theo: inv('theo_tho_1500.safetensors', 'loras', 'LTX-2.x', 'Theo', { role: 'lora' }),   // sans mot déclencheur
  added: { id: 'added01', file: 'perso_test.safetensors', family: 'LTX-2.x', loraFor: 'ltx', role: 'lora', origin: 'added',
    label: { fr: 'Perso test', en: 'Test character' }, trigger: 'prs test', comfy: null, placed: null },
  wanLora: inv('wan_style_test.safetensors', 'loras', 'Wan 2.x', 'Style Wan', { role: 'lora', loraFor: 'wan', trigger: 'wnstyle' }),
  qwenLora: inv('qwen_style_test.safetensors', 'loras', 'Qwen-Image', 'Style Qwen', { role: 'lora', loraFor: 'qwen' }),
  mmLora: inv('minimax_style_test.safetensors', 'loras', 'MiniMax H3', 'Style MiniMax', { role: 'lora', loraFor: 'minimax' }),
  wan: inv('wan_animate_2_int8_convrot.safetensors', 'diffusion_models', 'Wan 2.x', 'Wan Animate 2'),
  sv7: inv('seedvr2_7b_int8_convrot.safetensors', 'diffusion_models', 'SeedVR2', 'SeedVR2 7B'),
  sv3: inv('seedvr2_3b_int8_convrot.safetensors', 'diffusion_models', 'SeedVR2', 'SeedVR2 3B'),
  svNode: inv('seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors', 'seedvr2', 'SeedVR2', 'SeedVR2 7B (fp8)'),
};
// les LoRA de personnage et de lieu des essais n'existent nulle part : supposés installés pour toutes les variantes
const CHARACTER_LORAS = { loras: [INV.mara.file, INV.rooftop.file, INV.theo.file] };

const IMG_V = { kind: 'image', meta: { w: 1080, h: 1920 } };
const IMG_H = { kind: 'image', meta: { w: 1920, h: 1080 } };
const IMG_SQ = { kind: 'image', meta: { w: 2048, h: 2048 } };
const vid = (w, h, frames, fps = 24, extra = {}) => ({ kind: 'video', meta: { w, h, fps, frames, duration: frames / fps,
  hasAudio: false, ...extra } });
const text = (t, negative = '') => ({ text: t, negative });

// executor × variant: inputs (media placeholders, arrays for multi inputs), params over the catalog defaults, mode,
// models; assume = test-only installed models; ensure = what x.ensureLora answers; expectError = the run must fail
// with that message (before or after building graphs); expectModel = run.json model name; lang = UI language.
const VARIANTS = {
  depth: [
    { name: 'vidéo · rapide', inputs: { media: vid(1920, 1080, 120) }, models: { model: INV.vda } },
    { name: 'vidéo · fine · inversée · 1re image ignorée', inputs: { media: { ...vid(1080, 1920, 97, 30), skipFirst: true } },
      params: { detail: 'fine', invert: true }, models: { model: INV.vda } },
    { name: 'image', inputs: { media: IMG_V }, models: { model: INV.vda } },
  ],
  edit: [
    { name: 'rapide', inputs: { image: IMG_V }, params: { prompt: 'make the walls weathered concrete' }, models: { model: INV.qwen } },
    { name: 'qualité + référence', inputs: { image: IMG_H, ref: IMG_V }, params: { prompt: 'warm sunset light', speed: 'quality' },
      models: { model: INV.qwen } },
    { name: 'consigne branchée', inputs: { image: IMG_V, prompt: text('add rain', 'blur') }, params: { prompt: '' },
      models: { model: null } },
    { name: 'LoRA Qwen 0,7 (rapide)', inputs: { image: IMG_V }, params: { prompt: 'old poster style', loraStrength: 0.7 },
      models: { model: INV.qwen, lora: INV.qwenLora }, assume: TEST_LORAS },
    { name: 'LoRA LTX refusée (famille)', inputs: { image: IMG_V }, params: { prompt: 'x' },
      models: { model: INV.qwen, lora: INV.mara }, expectError: /fait pour LTX 2\.5, pas pour Qwen Image/ },
  ],
  i2v: [
    { name: 'LTX · aperçu · vertical', mode: 'preview', inputs: { start: IMG_V }, params: { prompt: 'slow push-in' },
      models: { model: INV.ltxInt8 } },
    { name: 'LTX · final · fin + LoRA 0,8', mode: 'final', inputs: { start: IMG_V, end: IMG_V, prompt: text('the wave bursts out') },
      params: { loraStrength: 0.8 }, models: { model: INV.ltxFp4, lora: INV.mara } },
    { name: 'LTX · final · 16:9 30 i/s 8 s', mode: 'final', inputs: { start: IMG_H },
      params: { format: '16:9', fps: 30, duration: 8 }, models: { model: INV.ltxInt8 } },
    { name: 'LTX · fiche de référence', mode: 'final', inputs: { start: IMG_V, sheet: IMG_SQ },
      params: { prompt: 'tho man walks to the door', resolution: '720' }, models: { model: INV.ltxInt8 } },
    { name: 'LTX · fiche + fin + LoRA (nom)', mode: 'preview', inputs: { start: IMG_H, end: IMG_H, sheet: IMG_SQ },
      params: { prompt: 'he turns around' }, models: { model: INV.ltxInt8, lora: INV.theo } },
    { name: 'LTX · LoRA ajouté (placé par Mia)', mode: 'preview', inputs: { start: IMG_V }, params: { prompt: 'walks' },
      models: { model: INV.ltxInt8, lora: INV.added }, ensure: { lora: 'mia/perso_test.safetensors' }, assume: TEST_LORAS },
    { name: 'LTX · LoRA placé, schéma pas à jour', mode: 'preview', inputs: { start: IMG_V }, params: { prompt: 'walks' },
      models: { model: INV.ltxInt8, lora: INV.added }, ensure: { lora: 'mia\\perso_test.safetensors' }, liveOnly: TEST_LORAS },
    { name: 'LTX · LoRA Wan refusée', mode: 'preview', inputs: { start: IMG_V },
      models: { model: INV.ltxInt8, lora: INV.wanLora }, expectError: /fait pour Wan, pas pour LTX 2\.5/ },
    { name: 'LTX · anglais (libellé EN)', mode: 'preview', lang: 'en', inputs: { start: IMG_V }, models: { model: INV.ltxFp4 },
      expectModel: 'LTX 2.5 · fast' },
    { name: 'MiniMax · aperçu · fin', mode: 'preview', inputs: { start: IMG_V, end: IMG_V }, models: { model: INV.minimax } },
    { name: 'MiniMax · fiche ignorée + LoRA MiniMax', mode: 'final', inputs: { start: IMG_H, sheet: IMG_SQ },
      params: { format: '16:9', duration: 10 }, models: { model: INV.minimax, lora: INV.mmLora }, assume: TEST_LORAS },
    { name: 'MiniMax · LoRA LTX refusée', mode: 'final', inputs: { start: IMG_H },
      models: { model: INV.minimax, lora: INV.rooftop }, expectError: /fait pour LTX 2\.5, pas pour MiniMax H3/ },
  ],
  t2v: [
    { name: 'aperçu · 16:9', mode: 'preview', params: { prompt: 'a slow ocean wave' }, models: { model: INV.ltxInt8 } },
    { name: 'final · 9:16 · LoRA lieu', mode: 'final', params: { prompt: 'the roof at dusk', format: '9:16' },
      models: { model: INV.ltxFp4, lora: INV.rooftop } },
    { name: 'final · 21:9 1080p', mode: 'final', inputs: { prompt: text('huge wave crashing on glass') },
      params: { format: '21:9', duration: 6, resolution: '1080' }, models: { model: null } },
  ],
  real: [
    { name: 'aperçu · 300 images · LoRA', mode: 'preview', inputs: { video: vid(1080, 1920, 300), look: IMG_V },
      models: { model: INV.ltxInt8, lora: INV.mara } },
    { name: 'final · 81 images (1 tranche)', mode: 'final', inputs: { video: vid(1080, 1920, 81, 30), look: IMG_V },
      params: { prompt: 'photoreal' }, models: { model: INV.ltxInt8 } },
    { name: 'final · 240 images (3 tranches) · noirs · LoRA 1,4', mode: 'final', inputs: { video: vid(1920, 1080, 240), look: IMG_H,
      prompt: text('cinematic street') }, params: { loraStrength: 1.4 }, models: { model: INV.ltxFp4, lora: INV.rooftop } },
    { name: 'final · source 4K · sans noirs', mode: 'final', inputs: { video: vid(3840, 2160, 97), look: IMG_H },
      params: { keepBlacks: false }, models: { model: null } },
    { name: 'aperçu · sans image de look', mode: 'preview', inputs: { video: vid(1080, 1920, 120) },
      params: { prompt: 'photoreal, cinematic' }, models: { model: INV.ltxInt8 } },
    { name: 'final · 240 images (3 tranches) · sans look', mode: 'final', inputs: { video: vid(1920, 1080, 240) },
      models: { model: INV.ltxInt8 } },
  ],
  perform: [
    { name: 'aperçu · vertical', mode: 'preview', inputs: { character: IMG_V, motion: vid(1080, 1920, 240, 30, { hasAudio: true }) },
      params: { prompt: 'Mara, a young woman, green vinyl jacket' }, models: { model: INV.wan } },
    { name: 'final · horizontal 10 s (2 segments)', mode: 'final', inputs: { character: IMG_H, motion: vid(1920, 1080, 240) },
      models: { model: INV.wan } },
    { name: 'aperçu · LoRA Wan', mode: 'preview', inputs: { character: IMG_V, motion: vid(1080, 1920, 120) },
      models: { model: INV.wan, lora: INV.wanLora }, assume: TEST_LORAS },
    { name: 'LoRA LTX refusée', mode: 'preview', inputs: { character: IMG_V, motion: vid(1080, 1920, 120) },
      models: { model: INV.wan, lora: INV.mara }, expectError: /fait pour LTX 2\.5, pas pour Wan/ },
  ],
  upscale: [
    { name: 'vidéo · natif 7B · 1440', inputs: { media: vid(720, 1280, 81, 16, { hasAudio: true }) }, models: { model: INV.sv7 } },
    { name: 'vidéo · natif 3B · 4K', inputs: { media: vid(1080, 1920, 121) }, params: { target: '2160' }, models: { model: INV.sv3 } },
    { name: 'vidéo · nœud fp8 (CLI du labo)', inputs: { media: vid(1080, 1920, 97) }, models: { model: INV.svNode } },
    { name: 'image · auto', inputs: { media: IMG_V }, models: { model: null } },
    { name: 'image · nœud fp8', inputs: { media: IMG_H }, params: { target: '2160' }, models: { model: INV.svNode } },
  ],
  ref2v: [
    { name: 'modèle absent → message clair', mode: 'preview', without: PENDING, inputs: { refs: [IMG_V, IMG_H] },
      params: { prompt: 'Image 1 walks into the room of Image 2' }, models: { model: null },
      expectError: /Le modèle « MiniMax H3 · références » n’est pas installé/ },
    { name: 'aperçu · 3 images · consigne FR', mode: 'preview', assume: PENDING, inputs: { refs: [IMG_V, IMG_H, IMG_SQ] },
      params: { prompt: '« Image 1 » entre dans la pièce de l’image 2 et prend l’Image 3.' }, models: { model: INV.ref2va } },
    { name: 'final · 9 images + 3 vidéos (son, < 2 s, > 15 s) · max', mode: 'final', assume: PENDING,
      inputs: { refs: Array.from({ length: 9 }, (_, i) => (i % 2 ? IMG_H : IMG_V)),
        refVideos: [vid(1920, 1080, 120, 30, { hasAudio: true }), vid(1080, 1920, 30, 24), vid(1920, 1080, 600, 25, { hasAudio: true })] },
      params: { prompt: 'Image 1 dances like Video 1, Image 9 sings with the voice of video 3', fidelity: 'max', format: '9:16' },
      models: { model: null } },
    { name: 'final · sans citation · 21:9 720p', mode: 'final', assume: PENDING, inputs: { refs: [IMG_H, IMG_V] },
      params: { prompt: 'a man and his dog on a beach', format: '21:9' }, models: { model: null } },
    { name: 'cite Image 5 avec 3 images → refus', mode: 'final', assume: PENDING, inputs: { refs: [IMG_V, IMG_H, IMG_SQ] },
      params: { prompt: 'Image 5 jumps' }, models: { model: null }, expectError: /cite « Image 5 », mais 3 image/ },
  ],
  guided: [
    { name: 'LTX · profondeur calculée · aperçu', mode: 'preview', inputs: { guide: vid(1920, 1080, 120) },
      params: { prompt: 'a knight walks in a forest' }, models: { model: INV.ltxInt8 } },
    { name: 'LTX · guide venu de Profondeur inversée (run.json) · départ', mode: 'final',
      inputs: { guide: { ...vid(1080, 1920, 97), fromRun: 'depth', fromParams: { invert: true } },
      look: IMG_V }, params: { prompt: 'a dancer on a rooftop', resolution: '1080' }, models: { model: INV.ltxInt8 } },
    { name: 'LTX · contours · masque vidéo · LoRA · 240 images (3 tranches)', mode: 'final',
      inputs: { guide: { ...vid(1920, 1080, 240, 25), skipFirst: true }, look: IMG_H, mask: vid(1280, 720, 300, 30) },
      params: { prompt: 'mra woman in a red coat', follow: 'edges', strength: 0.7, resolution: '720' },
      models: { model: INV.ltxFp4, lora: INV.mara } },
    { name: 'LTX · profondeur fournie · masque image · 540p', mode: 'final',
      inputs: { guide: { ...vid(1280, 720, 97), sourceType: 'depth' }, mask: IMG_SQ, prompt: text('stormy sea', 'text') },
      params: { resolution: '540', strength: 1.3 }, models: { model: null } },
    { name: 'MiniMax · profondeur · départ · LoRA MiniMax', mode: 'final', assume: TEST_LORAS,
      inputs: { guide: vid(1080, 1920, 200, 30), look: IMG_V }, params: { prompt: 'the audience comes alive' },
      models: { model: INV.minimax, lora: INV.mmLora } },
    { name: 'MiniMax · contours · sans départ · masque ignoré · 20 s', mode: 'final',
      inputs: { guide: vid(1920, 1080, 480), mask: IMG_H }, params: { prompt: 'a car drives', follow: 'edges' },
      models: { model: INV.minimax } },
    { name: 'MiniMax · aperçu · guide court', mode: 'preview', inputs: { guide: vid(1920, 1080, 40) },
      params: { prompt: 'waves' }, models: { model: INV.minimax } },
  ],
};

// ---------------------------------------------------------------- run

function summary(g) {
  const bits = [];
  const find = (cls) => Object.values(g).find((n) => n.class_type === cls);
  const all = (cls) => Object.values(g).filter((n) => n.class_type === cls);
  const lat = find('EmptyLTXVLatentVideo');
  if (lat && typeof lat.inputs.width === 'number') {
    bits.push(`${lat.inputs.width}×${lat.inputs.height}${typeof lat.inputs.length === 'number' ? `·${lat.inputs.length}` : ''}`);
  }
  const mm = find('MiniMaxH3ImageToVideo');
  if (mm) bits.push(`${mm.inputs.width}×${mm.inputs.height}·${mm.inputs.length}${mm.inputs.first_frame ? '·départ' : ''}${mm.inputs.last_frame ? '·fin' : ''}`);
  const r2v = find('MiniMaxH3ReferenceToVideo');
  if (r2v) {
    const k = Object.keys(r2v.inputs);
    bits.push(`${r2v.inputs.width}×${r2v.inputs.height}·${r2v.inputs.length} réf ${k.filter((s) => s.startsWith('ref_images.')).length}i`
      + `/${k.filter((s) => s.startsWith('ref_videos.')).length}v/${k.filter((s) => s.startsWith('ref_video_audios.')).length}son ${r2v.inputs.ref_image_size}`);
  }
  const sc = find('ImageScale');
  if (sc && !lat && !mm && !r2v) bits.push(`${sc.inputs.width}×${sc.inputs.height}`);
  const wan = g['672:600'];
  if (wan) bits.push(`${wan.inputs['resize_type.width']}×${wan.inputs['resize_type.height']}`);
  if (all('LTXVAddGuide').length) bits.push(`guides ${all('LTXVAddGuide').map((n) => n.inputs.frame_idx).join('/')}`);
  if (g['37']) bits.push(`fiche ×${g['36'] && g['36'].inputs.amount}`);
  if (g['980a']) bits.push('clé raccord');
  const loras = all('LoraLoaderModelOnly').filter((n) => !/turbo|lightning|lightx2v/i.test(n.inputs.lora_name));
  for (const l of loras) bits.push(`LoRA ${l.inputs.lora_name.replace(/\.safetensors$/, '')}@${l.inputs.strength_model}`);
  const ic = all('LTXICLoRALoaderModelOnly');
  for (const l of ic) bits.push(`IC ${l.inputs.lora_name.replace(/^ltx-2\.[35]-22b-ic-lora-|\.safetensors$/g, '')}@${l.inputs.strength_model}`);
  const adv = find('LTXAddVideoICLoRAGuideAdvanced');
  if (adv) bits.push(`contrôle${adv.inputs.attention_mask ? '+masque' : ''}`);
  if (find('Canny')) bits.push('Canny');
  const cn = find('MiniMaxH3FunControlNetApply');
  if (cn) bits.push(`FunCN@${cn.inputs.strength}`);
  const vda = find('VideoDepthAnythingProcess');
  if (vda) bits.push(`VDA ${vda.inputs.input_size}/${vda.inputs.max_res}`);
  const sv = find('SeedVR2VideoUpscaler');
  if (sv) bits.push(`nœud ${sv.inputs.resolution} b${sv.inputs.batch_size}`);
  const rs = g['3'] && g['3'].inputs['resize_type.shorter_size'];
  if (rs) bits.push(`natif ${rs}`);
  return bits.join(' ');
}

/** Copies of the schema and lists WITHOUT some files (a model not installed, whatever this PC has). */
function withoutModels(objectInfo, lists, gone) {
  const drop = new Set(Object.values(gone).flat());
  const oi = JSON.parse(JSON.stringify(objectInfo));
  for (const key of Object.keys(V.MODEL_FOLDERS)) {
    const [cls, input] = key.split('.');
    const sec = oi[cls] && oi[cls].input;
    const entry = sec && ((sec.required || {})[input] || (sec.optional || {})[input]);
    if (!entry) continue;
    if (Array.isArray(entry[0])) entry[0] = entry[0].filter((f) => !drop.has(f));
    else if (entry[1] && Array.isArray(entry[1].options)) entry[1].options = entry[1].options.filter((f) => !drop.has(f));
  }
  const models = {};
  for (const [f, l] of Object.entries(lists || {})) models[f] = (l || []).filter((n) => !drop.has(n));
  return { objectInfo: oi, models };
}

/** What the run left in the fake engine folders (must be nothing, SPEC §16). */
function leftovers(fk, runId) {
  const out = [];
  const runDir = path.join(fk.outputDir, 'mia', runId);
  if (fs.existsSync(runDir)) out.push(`sorties ${path.relative(fk.outputDir, runDir)}`);
  const up = path.join(fk.inputDir, 'mia');
  if (fs.existsSync(up)) for (const f of fs.readdirSync(up)) out.push(`envoi mia/${f}`);
  return out;
}

async function main() {
  if (!fs.existsSync(SCHEMA)) {
    console.error(`Schéma ComfyUI introuvable : ${SCHEMA}\nLancez ComfyUI, enregistrez http://127.0.0.1:8188/object_info `
      + 'dans un fichier, puis : node tools/validate-workflows.js --schema <ce fichier>');
    process.exit(2);
  }
  let schema;
  try { schema = V.loadObjectInfoFile(SCHEMA); } catch (e) {
    console.error(`Schéma ComfyUI illisible (${SCHEMA}) : ${e.message}\nIl faut le JSON renvoyé par /object_info, tel quel.`);
    process.exit(2);
  }
  const { lists: rawLists, live } = await modelLists(schema);
  const { objectInfo: oi0, models: lists0 } = V.assumeInstalled(schema, rawLists, CHARACTER_LORAS);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-validate-'));
  const rows = [];
  let bad = 0;
  // poids VDA absents (pas le moteur de l'auteur) : un faux fichier dans le dossier du test, signalé dans le rapport
  const vdaAssumed = !fs.existsSync(path.join(MODELS_DIR, VDA_SMALL));
  if (vdaAssumed) {
    MODELS_DIR = path.join(tmp, 'models');
    fs.mkdirSync(path.dirname(path.join(MODELS_DIR, VDA_SMALL)), { recursive: true });
    fs.writeFileSync(path.join(MODELS_DIR, VDA_SMALL), '');
  }

  // 1. templates as shipped (models still to download assumed installed — test mode, flagged in the report)
  const tplCtx = V.assumeInstalled(oi0, lists0, PENDING);
  for (const f of fs.readdirSync(P.WF_DIR).filter((n) => n.endsWith('.api.json')).sort()) {
    const g = JSON.parse(fs.readFileSync(path.join(P.WF_DIR, f), 'utf8'));
    const uses = JSON.stringify(g);
    const pending = Object.values(PENDING).flat().some((m) => uses.includes(m));
    const r = V.validateGraph(g, { objectInfo: pending ? tplCtx.objectInfo : oi0, models: pending ? tplCtx.models : lists0,
      modelsDir: MODELS_DIR });
    rows.push({ exec: 'modèle', variant: f, graphs: 1, ok: r.ok, info: pending ? 'modèles à installer supposés présents' : '',
      problems: r.problems });
    if (!r.ok) bad++;
  }

  // 2. executors, dry
  for (const [execName, variants] of Object.entries(VARIANTS)) {
    if (ONLY.length && !ONLY.includes(execName)) continue;
    const exec = require(path.join(ENGINE, 'executors', `${execName}.js`));
    const type = typeOf(execName);
    if (!type) throw new Error(`type « ${execName} » absent du catalogue`);
    for (const v of variants) {
      V._resetCache();                        // each variant may see another schema (assumed models)
      let oi = oi0;
      let lists = lists0;
      if (v.assume) ({ objectInfo: oi, models: lists } = V.assumeInstalled(oi0, lists0, v.assume));
      if (v.liveOnly) lists = V.assumeInstalled(oi0, lists0, v.liveOnly).models;   // stale schema, fresh /models
      if (v.without) ({ objectInfo: oi, models: lists } = withoutModels(oi, lists, v.without));
      const fk = makeFakes(tmp, oi, lists);
      const slug = `${execName}_${rows.length}`;
      const runId = `r_${slug}`;
      const outDir = path.join(tmp, 'runs', slug);
      fs.mkdirSync(outDir, { recursive: true });
      const mediaOf = (port, spec, i = null) => {
        const abs = path.join(tmp, 'media', `${slug}_${port}${i == null ? '' : `_${i + 1}`}.${spec.kind === 'video' ? 'mp4' : 'png'}`);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, '');
        if (spec.meta.frames) fk.frames.set(path.resolve(abs), spec.meta.frames);
        fk.meta.set(path.resolve(abs), { kind: spec.kind, ...spec.meta });
        const o = { abs, rel: `media/${path.basename(abs)}`, kind: spec.kind, meta: spec.meta, skipFirst: spec.skipFirst };
        if (spec.sourceType) o.sourceType = spec.sourceType;
        if (spec.fromRun) {                    // an upstream block's output: its run.json says its type
          o.nodeId = `n_up_${port}`;
          o.runId = `r_up_${slug}`;
          const rd = path.join(tmp, 'outputs', o.nodeId, o.runId);
          fs.mkdirSync(rd, { recursive: true });
          fs.writeFileSync(path.join(rd, 'run.json'), JSON.stringify({ type: spec.fromRun, status: 'done', params: spec.fromParams || {} }));
        }
        return o;
      };
      const inputs = {};
      for (const [port, spec] of Object.entries(v.inputs || {})) {
        if (spec.text !== undefined) { inputs[port] = spec; continue; }
        inputs[port] = Array.isArray(spec) ? spec.map((s, i) => mediaOf(port, s, i)) : mediaOf(port, spec);
      }
      const log = [];
      const x = {
        projectId: 'p_dry', projectDir: tmp, nodeId: `n_${execName}`, runId,
        type, params: { ...defaults(type), ...(v.params || {}) }, mode: v.mode || null, inputs, outDir,
        model: (key) => (v.models && key in v.models ? v.models[key] : null),
        progress: () => {}, preview: () => {}, signal: new AbortController().signal,
        comfy: fk.comfy, py: null, ffmpeg: fk.ffmpeg, log: (l) => log.push(l), lang: v.lang || 'fr',
      };
      if (v.ensure) x.ensureLora = async (key) => ({ comfyName: v.ensure[key] });
      let res = null;
      let error = null;
      try { res = await exec.run(x); } catch (e) { error = e; }
      const problems = [];
      let ok = v.expectError ? !!(error && v.expectError.test(error.message)) : !error;
      for (const r of fk.comfy.checks) {
        if (!r.ok) ok = false;
        problems.push(...r.problems);
      }
      if (!v.expectError && !fk.comfy.graphs.length) ok = false;
      const outPorts = res ? Object.keys(res.outputs || {}) : [];
      const portOk = res && type.outputs.every((o) => outPorts.includes(o.id))
        && outPorts.every((p) => fs.existsSync(res.outputs[p].abs));
      if (res && !portOk) ok = false;
      const modelOk = !v.expectModel || (res && res.model === v.expectModel);
      if (!modelOk) ok = false;
      const left = leftovers(fk, runId);
      if (left.length) ok = false;
      const temps = fs.readdirSync(outDir).filter((f) => f.startsWith('_'));
      if (temps.length) ok = false;
      if (!ok) bad++;
      let est = null;
      try { est = exec.estimate ? exec.estimate(x) : null; } catch (e) { est = `estimate: ${e.message}`; }
      const why = [];
      if (v.expectError && !(error && v.expectError.test(error.message))) why.push(`erreur attendue ${v.expectError} — obtenu : ${error ? error.message : 'aucune'}`);
      else if (!v.expectError && error) why.push(error.stack || error.message);
      if (res && !portOk) why.push('sorties manquantes');
      if (!modelOk) why.push(`modèle « ${res && res.model} » au lieu de « ${v.expectModel} »`);
      if (left.length) why.push(`restes dans le moteur : ${left.join(', ')}`);
      if (temps.length) why.push(`fichiers temporaires restés dans le run : ${temps.join(', ')}`);
      rows.push({
        exec: execName, variant: v.name, graphs: fk.comfy.graphs.length, ok,
        info: [v.expectError && error ? `refus : ${error.message.split('\n')[0]}` : null,
          fk.comfy.graphs.map(summary).join(' | '), typeof est === 'number' ? `≈${est.toFixed(1)} min` : est,
          v.assume ? '(test : modèles supposés)' : null].filter(Boolean).join(' · '),
        problems, error: why.length ? why.join('\n') : null,
        notes: res && res.notes, model: res && res.model, outputs: outPorts.join(','), ffmpeg: fk.ffmpeg.calls.length,
        ffcalls: fk.ffmpeg.calls,
      });
    }
  }

  // ---- report
  const w1 = Math.max(...rows.map((r) => r.exec.length));
  const w2 = Math.max(...rows.map((r) => r.variant.length));
  console.log(`Schéma : ${path.relative(ROOT, SCHEMA)} · listes de modèles : ${live ? 'ComfyUI en direct (GET /models)' : 'hors ligne (schéma)'}`
    + (vdaAssumed ? ' · poids VDA Small supposés présents (test)' : ''));
  console.log('');
  console.log(`${'executor'.padEnd(w1)}  ${'variante'.padEnd(w2)}  graphes  résultat  détail`);
  console.log(`${'-'.repeat(w1)}  ${'-'.repeat(w2)}  -------  --------  ------`);
  for (const r of rows) {
    console.log(`${r.exec.padEnd(w1)}  ${r.variant.padEnd(w2)}  ${String(r.graphs).padStart(7)}  ${(r.ok ? 'valide' : 'INVALIDE').padEnd(8)}  ${r.info}`);
    const errs = r.problems.filter((p) => p.level === 'error');
    if (errs.length) console.log(V.formatProblems(r.problems, 20).replace(/^/gm, '      '));
    if (r.error && !r.ok) console.log(`      ✗ ${r.error.split('\n').slice(0, VERBOSE ? 20 : 3).join('\n        ')}`);
    if (VERBOSE) {
      const warns = r.problems.filter((p) => p.level === 'warn');
      if (warns.length) console.log(`      avertissements : ${warns.map((p) => p.msg).join(' | ')}`);
      if (r.model) console.log(`      modèle : ${r.model}`);
      if (r.notes) console.log(`      notes : ${String(r.notes).replace(/\n/g, ' / ')}`);
      if (r.outputs) console.log(`      sorties : ${r.outputs} · appels ffmpeg : ${r.ffmpeg}`);
    }
    if (SHOW_FFMPEG && r.ffcalls) {
      for (const c of r.ffcalls) console.log(`      ffmpeg ${c.map((a) => (/[\s']/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    }
  }
  console.log('');
  console.log(bad ? `${bad} cas invalide(s).` : `Tout est valide (${rows.length} cas).`);
  if (KEEP) console.log(`Fichiers du test gardés dans ${tmp}`);
  else fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
