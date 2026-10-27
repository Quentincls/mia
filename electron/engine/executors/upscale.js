'use strict';
// Upscale ("Agrandir"): SeedVR2, inside ComfyUI — never the separate CLI process, which would load a second
// copy of torch next to ComfyUI's models on a 24 GB card and could not be cancelled cleanly.
//   int8 models (diffusion_models\seedvr2_7b/3b_int8_convrot, what the model picker shows): ComfyUI's native
//     nodes, graph from its own blueprint "Upscale Video (SeedVR2 3B Int8)", temporal chunking sized to free VRAM.
//   fp8 custom-node model (models\SEEDVR2\…_fp8…): SeedVR2VideoUpscaler with the lab's CLI settings
//     (batch 21, overlap 4, noise 0.1, prepend 4, colour "lab", tiled VAE).
// Target = short side (1440 or 2160). Only files ComfyUI lists are ever named: SeedVR2's "(Down)Load" node
// downloads anything else, validate.js refuses that.
// Two more engines, video only, picked in the same « Modèle » list:
//   « LTX · détails » (ltx_upscale, LTX-2.5 Native Resolution, Lightricks): a composition pass at half the target
//     with the IC-LoRA Refine Details (8 steps), the latent ×2 upscaler, then 3 refine steps on the full canvas;
//     both passes by Tiled Fusion on 1024×576 tiles (the LoRA's training window) and 97-frame windows.
//   « NVIDIA RTX · express » (rtx_vsr, ComfyUI_Nvidia_VFX_Nodes + nvidia-vfx): RTX Video Super Resolution, frame
//     by frame on the tensor cores, straight to the target size; nothing generated, so no window overlap needed.
//   FlashVSR (ComfyUI-FlashVSR-Stock) is installed but kept out of the picker: far too slow here without sparse
//     attention (scanner-rules.js).
const path = require('node:path');
const P = require('../patch');
const real = require('./real');

const E = P.exec;

const NATIVE_7B = 'seedvr2_7b_int8_convrot.safetensors';
const NATIVE_3B = 'seedvr2_3b_int8_convrot.safetensors';
const NODE_7B = 'seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors';
const PREPEND = 4;
const SEED_WINDOW = 121;
const LTX_INT8 = 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors';
const LTX_TILE = { w: 1024, h: 576, frames: 97 };     // Refine Details' training window

const TXT = {
  model: { fr: 'SeedVR2', en: 'SeedVR2' },
  size: { fr: 'Petit côté porté à {t} px.', en: 'Short side raised to {t} px.' },
  already: {
    fr: 'La source fait déjà {s} px de petit côté : passe de détail sans vrai agrandissement.',
    en: 'The source already has a {s} px short side: a detail pass rather than a real upscale.',
  },
  bigger: {
    fr: 'La source fait déjà {s} px de petit côté, plus que {t} : rien à agrandir (choisis 4K, ou garde-la telle quelle).',
    en: 'The source already has a {s} px short side, more than {t}: nothing to upscale (pick 4K, or keep it as is).',
  },
  videoOnly: {
    fr: '{m} n’agrandit que des vidéos : choisis SeedVR2 pour une image.',
    en: '{m} only upscales videos: pick SeedVR2 for an image.',
  },
  ltx: { fr: 'LTX · détails', en: 'LTX · details' },
  ltxWindows: {
    fr: 'Calculé en {n} morceaux de {f} images, fondus entre eux (mémoire vive).',
    en: 'Computed in {n} chunks of {f} frames, cross-faded (RAM).',
  },
  rtx: { fr: 'NVIDIA RTX · express', en: 'NVIDIA RTX · express' },
  rtxChunks: { fr: 'Calculé par paquets de {f} images (mémoire vive).', en: 'Computed in batches of {f} frames (RAM).' },
  flashNotYet: {
    fr: 'FlashVSR n’est pas encore prêt dans Mia : choisis SeedVR2 ou LTX · détails.',
    en: 'FlashVSR is not ready in Mia yet: pick SeedVR2 or LTX · details.',
  },
  ltxPasses: {
    fr: 'Composition en {w1} × {h1}, puis affinage en {w2} × {h2} ({n} images).',
    en: 'Composition at {w1} × {h1}, then refinement at {w2} × {h2} ({n} frames).',
  },
  face: {
    fr: 'SeedVR2 lisse un peu la peau des visages : compare avec la source.',
    en: 'SeedVR2 slightly smooths skin on faces: compare with the source.',
  },
};

/** Which graph and file: the picker's choice, else the best int8 model ComfyUI lists. */
async function pick(x) {
  const m = E.model(x, 'model');
  const file = m && ((m.comfy && m.comfy.name) || m.file);
  if (m && (m.key === 'ltx-upscaler' || /latent.spatial.upscaler/i.test(file || ''))) return { m, kind: 'ltx', file };
  if (m && m.key === 'rtx-vsr') return { m, kind: 'rtx', file };
  if (m && (m.key === 'flashvsr' || /flashvsr/i.test(file || ''))) return { m, kind: 'flash', file };
  const folder = m && m.comfy && m.comfy.folder;
  if (file && (folder === 'seedvr2' || /^seedvr2_ema_/i.test(file))) return { m, kind: 'node', file };
  if (file && /seedvr2/i.test(file)) return { m, kind: 'native', file };
  let listed = [];
  try { listed = (await x.comfy.models('diffusion_models')) || []; } catch { /* validated later anyway */ }
  if (listed.includes(NATIVE_7B)) return { m, kind: 'native', file: NATIVE_7B };
  if (listed.includes(NATIVE_3B)) return { m, kind: 'native', file: NATIVE_3B };
  return { m, kind: 'node', file: NODE_7B };
}

async function run(x) {
  E.begin(x);
  const inp = E.input(x, 'media');
  const isVideo = inp.kind === 'video';
  const meta = await E.metaOf(x, inp);
  const target = String(x.params.target) === '2160' ? 2160 : 1440;
  const short = Math.min(meta.w || 0, meta.h || 0);
  // a source already bigger than the target would only be shrunk, at the price of a full run (26/10: a 4K clip
  // sent to « 1440p » filled 51 GB of RAM before anything happened)
  if (short > target) throw new Error(E.t(TXT.bigger, { s: short, t: target === 2160 ? '4K' : '1440p' }));
  const { m, kind, file } = await pick(x);
  if (kind === 'rtx') return runRtx(x, { inp, meta, target, isVideo });
  if (kind === 'ltx' || kind === 'flash') {
    const name = kind === 'ltx' ? E.t(TXT.ltx) : 'FlashVSR';
    if (!isVideo) throw new Error(E.t(TXT.videoOnly, { m: name }));
    return kind === 'ltx' ? runLtx(x, { inp, meta, target, m, file }) : runFlash(x, { inp, meta, target, m, file });
  }
  const notes = [E.t(TXT.size, { t: target })];
  if (short >= target) notes.push(E.t(TXT.already, { s: short }));

  /** One SeedVR2 run on an uploaded file (a video window, or the still): its frames, prepended ones dropped. */
  const seedOnce = async (up, want, k, range, keep) => {
    const g = P.load(kind === 'node' ? 'seedvr2_node' : 'seedvr2_native');
    const imageInto = kind === 'node' ? ['5', 'image'] : ['3', 'input'];
    if (isVideo) P.set(g, '1', 'file', up);
    else {
      P.replaceNode(g, '1', 'LoadImage', { image: up });
      P.remove(g, '2');
      P.set(g, imageInto[0], imageInto[1], ['1', 0]);
    }
    if (kind === 'node') {
      P.set(g, '3', 'model', file);
      P.setInputs(g, '5', {
        resolution: target,
        // 4n+1 frames per batch: 21 is the lab's 1440 setting, smaller at 4K for VRAM; a still is one frame
        batch_size: isVideo ? (target > 1440 ? 9 : 21) : 1,
        prepend_frames: isVideo ? PREPEND : 0,
        temporal_overlap: isVideo ? 4 : 0,
      });
    } else {
      P.set(g, '3', 'resize_type.shorter_size', target);
      P.set(g, '8', 'unet_name', file);
    }
    P.set(g, '9990', 'filename_prefix', E.prefix(x, k == null ? '' : `w${k}`, 'frame'));
    const res = await E.submit(x, g, { range, keep });
    let shots = (await E.filesOrThrow(x, res.outputs, '9990')).map((f) => f.abs);
    // the custom node is documented to drop its prepended frames; if a build does not, they are at the head
    if (kind === 'node' && want && shots.length === want + PREPEND) shots = shots.slice(PREPEND);
    return want ? shots.slice(0, want) : shots;   // SeedVR2 pads to 4n+1 at the tail
  };

  E.ranged(x, 0, 0.05)(0, E.t('uploading'));
  if (!isVideo) {
    const shots = await seedOnce(await E.upload(x, inp.abs), 1, null, [0.05, 0.97], 'comfy_graph');
    const out = await E.stillTo(x, shots[0], path.join(x.outDir, 'upscaled.png'));
    return { outputs: { out: { abs: out, kind: 'image' } }, model: E.labelOf(m, E.t(TXT.model)), notes: E.notes(notes) };
  }

  // like LTX: windows sized to RAM (ComfyUI keeps every frame as float32), overlapping, cross-faded by real.join
  const F = Math.max(1, meta.frames || 0);
  const k2 = target / Math.max(1, short);
  const per = 12 * ((meta.w || 1280) * (meta.h || 720) + 2 * (meta.w || 1280) * (meta.h || 720) * k2 * k2);
  const size = Math.max(25, Math.min(SEED_WINDOW, Math.floor(RAM_BUDGET / per)));
  const starts = F <= size ? [0] : real.windows(F, size, WIN_OVERLAP);
  if (starts.length > 1) notes.push(E.t(TXT.ltxWindows, { n: starts.length, f: size }));
  const fps = meta.fps || 24;
  const temps = [];
  const outs = [];
  const span = 0.85 / starts.length;
  try {
    for (let k = 0; k < starts.length; k++) {
      const s0 = starts[k];
      const n = Math.min(size, F - s0);
      const a0 = 0.05 + k * span;
      E.ranged(x, a0, a0 + span)(0, starts.length > 1 ? E.t('window', { i: k + 1, n: starts.length }) : E.t('computing'));
      let up;
      if (starts.length === 1 && !inp.skipFirst) up = await E.upload(x, inp.abs);
      else {
        const seg = E.tmp(x, `source_w${k}.mp4`);
        temps.push(seg);
        await E.prepVideo(x, inp, seg, { start: s0, frames: n, srcFps: fps, range: [a0, a0 + span * 0.05] });
        up = await E.upload(x, seg);
      }
      const shots = await seedOnce(up, n, starts.length > 1 ? k : null, [a0 + span * 0.05, a0 + span],
        starts.length > 1 ? `comfy_graph_w${k + 1}` : 'comfy_graph');
      outs.push({ start: s0, abs: shots });
    }
    E.ranged(x, 0.9, 0.91)(0, E.t('joining'));
    const seq = starts.length === 1 ? outs[0].abs : await real.join(x, outs, F, temps);
    const dst = path.join(x.outDir, 'upscaled.mp4');
    await E.framesToVideo(x, seq, dst, {
      fps, audio: meta.hasAudio === true ? inp.abs : null, range: [0.91, 1], msg: E.t('encoding'),
    });
    if (short && short <= 1080) notes.push(E.t(TXT.face));
    return {
      outputs: { out: { abs: dst, kind: 'video', meta: { fps, frames: seq.length } } },
      model: E.labelOf(m, E.t(TXT.model)), notes: E.notes(notes),
    };
  } finally {
    for (const t of temps) await E.cleanup(t);
  }
}

/** Output size (short side = target, even) and the two LTX canvases (stage 2 in multiples of 64, stage 1 half). */
function ltxGeometry(meta, target) {
  const w = meta.w || 1280, h = meta.h || 720;
  const k = target / Math.min(w, h);
  const ow = E.even(w * k), oh = E.even(h * k);
  const W2 = Math.ceil(ow / 64) * 64, H2 = Math.ceil(oh / 64) * 64;
  return { ow, oh, W1: W2 / 2, H1: H2 / 2, W2, H2 };
}

// ComfyUI holds every frame of a run in RAM as float32 (source, both guides, the decoded result): the whole 10 s
// at 1440p came to ~27 GB and the PC swapped (26/10). So the clip goes through in windows sized to stay near
// RAM_BUDGET, overlapping by WIN_OVERLAP frames and joined by real.js's cross-fade at the most alike frame.
const RAM_BUDGET = 12e9;
const WIN_OVERLAP = 16;

/** Window length (8k+1, 25 to 97 frames) whose float32 frames fit RAM_BUDGET. */
function ltxWindow(meta, geo) {
  const perFrame = 12 * ((meta.w || 1280) * (meta.h || 720) + geo.W1 * geo.H1 + 2 * geo.W2 * geo.H2);
  const n = Math.floor(RAM_BUDGET / perFrame);
  return Math.max(25, Math.min(LTX_TILE.frames, 1 + Math.floor((n - 1) / 8) * 8));
}

async function runLtx(x, { inp, meta, target, m, file }) {
  const geo = ltxGeometry(meta, target);
  const F = Math.max(1, meta.frames || 0);
  const size = ltxWindow(meta, geo);
  const starts = F <= size ? [0] : real.windows(F, size, WIN_OVERLAP);
  const L = F <= size ? E.ceil8k1(F) : size;       // LTX wants 8k+1 frames: a short tail is cloned, then dropped
  const fps = meta.fps || 24;
  const parts = (m && m.parts) || {};
  const part = (k, def) => (parts[k] && (parts[k].comfyName || parts[k].file)) || def;
  const notes = [E.t(TXT.size, { t: target }),
    E.t(TXT.ltxPasses, { w1: geo.W1, h1: geo.H1, w2: geo.W2, h2: geo.H2, n: F })];
  if (starts.length > 1) notes.push(E.t(TXT.ltxWindows, { n: starts.length, f: L }));
  const short = Math.min(meta.w || 0, meta.h || 0);
  if (short >= target) notes.push(E.t(TXT.already, { s: short }));

  const temps = [];
  const outs = [];
  const span = 0.88 / starts.length;
  try {
    for (let k = 0; k < starts.length; k++) {
      const s0 = starts[k];
      const a0 = 0.02 + k * span;
      E.ranged(x, a0, a0 + span)(0, starts.length > 1 ? E.t('window', { i: k + 1, n: starts.length }) : E.t('computing'));
      const seg = E.tmp(x, `source_w${k}.mp4`);
      temps.push(seg);
      await E.prepVideo(x, inp, seg, { start: s0, frames: L, srcFps: fps, range: [a0, a0 + span * 0.03] });
      const up = await E.upload(x, seg);
      const g = P.load('ltx_upscale');
      P.set(g, '1', 'file', up);
      P.set(g, '10', 'unet_name', part('ltx-int8', LTX_INT8));
      P.set(g, '11', 'lora_name', part('ltx-refine', 'ltx-2.5-22b-ic-lora-refine-details-1.0.safetensors'));
      P.set(g, '12', 'vae_name', part('ltx-vae', 'ltx-2.5-video-vae-bf16.safetensors'));
      P.set(g, '13', 'clip_name', part('ltx-te', 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors'));
      if (file) P.set(g, '14', 'model_name', file);
      P.setInputs(g, '30', { width: geo.W1, height: geo.H1 });
      P.setInputs(g, '31', { width: geo.W1, height: geo.H1, length: L });
      P.setInputs(g, '41', { width: geo.W2, height: geo.H2 });
      for (const id of ['32', '42']) P.set(g, id, 'tile_frames', L);
      for (const id of ['34', '44']) P.setInputs(g, id, { tile_width: LTX_TILE.w, tile_height: LTX_TILE.h, tile_frames: L });
      P.set(g, '9990', 'filename_prefix', E.prefix(x, `w${k}`, 'frame'));
      const res = await E.submit(x, g, { range: [a0 + span * 0.03, a0 + span],
        keep: starts.length > 1 ? `comfy_graph_w${k + 1}` : 'comfy_graph' });
      const shots = (await E.filesOrThrow(x, res.outputs, '9990')).map((f) => f.abs);
      outs.push({ start: s0, abs: shots });
    }
    E.ranged(x, 0.9, 0.92)(0, E.t('joining'));
    const seq = starts.length === 1 ? outs[0].abs.slice(0, F) : await real.join(x, outs, F, temps);
    const dst = path.join(x.outDir, 'upscaled.mp4');
    // the canvas is in multiples of 64: back to the exact target (same aspect, a few pixels stretched at most)
    await E.framesToVideo(x, seq, dst, {
      fps, vf: `scale=${geo.ow}:${geo.oh}:flags=lanczos`, audio: meta.hasAudio === true ? inp.abs : null,
      range: [0.92, 1], msg: E.t('encoding'),
    });
    return {
      outputs: { out: { abs: dst, kind: 'video', meta: { w: geo.ow, h: geo.oh, fps, frames: seq.length } } },
      model: E.t(TXT.ltx), notes: E.notes(notes),
    };
  } finally {
    for (const t of temps) await E.cleanup(t);
  }
}

/** RTX Video Super Resolution: batches of frames (float32 in RAM, like every ComfyUI IMAGE), joined end to end. */
async function runRtx(x, { inp, meta, target, isVideo }) {
  const geo = ltxGeometry(meta, target);
  const ow = Math.round(geo.ow / 8) * 8, oh = Math.round(geo.oh / 8) * 8;   // the SDK works in multiples of 8
  const notes = [E.t(TXT.size, { t: target })];
  const short = Math.min(meta.w || 0, meta.h || 0);
  if (short >= target) notes.push(E.t(TXT.already, { s: short }));
  const F = isVideo ? Math.max(1, meta.frames || 0) : 1;
  const per = 12 * ((meta.w || 1280) * (meta.h || 720) + ow * oh);
  const size = Math.max(8, Math.min(F, Math.floor(RAM_BUDGET / 2 / per)));
  const starts = [];
  for (let s0 = 0; s0 < F; s0 += size) starts.push(s0);
  if (starts.length > 1) notes.push(E.t(TXT.rtxChunks, { f: size }));
  const fps = meta.fps || 24;
  const temps = [];
  const seq = [];
  const span = 0.88 / starts.length;
  try {
    for (let k = 0; k < starts.length; k++) {
      const s0 = starts[k];
      const n = Math.min(size, F - s0);
      const a0 = 0.02 + k * span;
      E.ranged(x, a0, a0 + span)(0, starts.length > 1 ? E.t('window', { i: k + 1, n: starts.length }) : E.t('computing'));
      const g = P.load('rtx_vsr');
      if (isVideo) {
        const seg = E.tmp(x, `source_b${k}.mp4`);
        temps.push(seg);
        await E.prepVideo(x, inp, seg, { start: s0, frames: n, srcFps: fps, range: [a0, a0 + span * 0.1] });
        P.set(g, '1', 'file', await E.upload(x, seg));
      } else {
        P.replaceNode(g, '1', 'LoadImage', { image: await E.upload(x, inp.abs) });
        P.remove(g, '2');
        P.set(g, '3', 'images', ['1', 0]);
      }
      P.setInputs(g, '3', { 'resize_type.width': ow, 'resize_type.height': oh });
      P.set(g, '9990', 'filename_prefix', E.prefix(x, `b${k}`, 'frame'));
      const res = await E.submit(x, g, { range: [a0 + span * 0.1, a0 + span],
        keep: starts.length > 1 ? `comfy_graph_b${k + 1}` : 'comfy_graph' });
      seq.push(...(await E.filesOrThrow(x, res.outputs, '9990')).map((f) => f.abs).slice(0, n));
    }
    if (!isVideo) {
      const out = await E.stillTo(x, seq[0], path.join(x.outDir, 'upscaled.png'), `scale=${geo.ow}:${geo.oh}:flags=lanczos`);
      return { outputs: { out: { abs: out, kind: 'image' } }, model: E.t(TXT.rtx), notes: E.notes(notes) };
    }
    const dst = path.join(x.outDir, 'upscaled.mp4');
    await E.framesToVideo(x, seq, dst, {
      fps, vf: ow === geo.ow && oh === geo.oh ? null : `scale=${geo.ow}:${geo.oh}:flags=lanczos`,
      audio: meta.hasAudio === true ? inp.abs : null, range: [0.9, 1], msg: E.t('encoding'),
    });
    return {
      outputs: { out: { abs: dst, kind: 'video', meta: { w: geo.ow, h: geo.oh, fps, frames: seq.length } } },
      model: E.t(TXT.rtx), notes: E.notes(notes),
    };
  } finally {
    for (const t of temps) await E.cleanup(t);
  }
}

async function runFlash() {
  // FlashVSR stays out of the picker (scanner-rules: caps []) until it runs at its announced speed here
  throw new Error(E.t(TXT.flashNotYet));
}

function estimate(x) {
  const inp = (x.inputs && x.inputs.media) || {};
  const frames = inp.kind === 'video' ? ((inp.meta && inp.meta.frames) || 120) : 1;
  const k = x.params && String(x.params.target) === '2160' ? 2.25 : 1;
  const m = E.model(x, 'model');
  if (m && m.key === 'rtx-vsr') return 0.5 + frames * 0.005;   // measured 26/10: 241 frames to 1440p in 86 s
  if (m && m.key === 'ltx-upscaler') {
    // measured 26/10 (RTX 5090 Laptop): 49 frames to 1440 in ~6 min, models loading included; 4K canvases are 2.25× bigger
    const meta = { w: 1280, h: 720, ...(inp.meta || {}) };
    const size = ltxWindow(meta, ltxGeometry(meta, k > 1 ? 2160 : 1440));
    const done = frames <= size ? frames : real.windows(frames, size, WIN_OVERLAP).length * size;   // overlaps count twice
    return 1.5 + (done / 49) * 4.5 * k;
  }
  const small = /3b/i.test((m && ((m.comfy && m.comfy.name) || m.file)) || '') ? 0.5 : 1;
  // lab: 25 min for 240 frames with the 7B at 1440 (~6 s/frame); the 3B about twice as fast
  return Math.max(0.5, 0.5 + (frames * 6 * k * small) / 60);
}

module.exports = { run: E.wrap(run), estimate };
