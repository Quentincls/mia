'use strict';
// Guided video ("Vidéo guidée", SPEC §17): a new video that follows the shapes and motion of a guide video.
// No technical block for the user: Mia makes the control signal itself.
//   follow = depth : Video Depth Anything Small over the WHOLE guide in one pass (one normalisation, no seams) —
//                    skipped when the guide already is a depth video (it comes from a « Profondeur » block, or it
//                    is grey);
//   follow = edges : ComfyUI's native Canny node, at half size (the control is read at half size anyway; the
//                    whole-batch Canny would otherwise need ~10 GB of VRAM).
// Models (capability guided-video):
//   LTX 2.5 + IC-LoRA Union-Control (default) — tool/union.py ltx_union(): control guide = IC-LoRA guide at
//     frame 0 with a per-region attention mask (« Zone libre » : white = free -> attention 0), the start image as a
//     key on frame 0, « Fidélité au guide » = IC-LoRA strength, single stage euler, decoded straight from stage 1.
//     Long guides: 97-frame windows overlapping by 25, each later window keyed on the frame already generated at
//     its start, joined with a short blend at the most alike frame (same code as « Rendre photoréaliste »).
//   MiniMax H3 + Fun ControlNet Union: fl2va + turbo 8 steps, the control video
//     through MiniMaxH3FunControlNetApply (strength = fidelity), the start image as first frame, 24 fps, sound.
//     Its mask input means « inpaint », not « free area »: the mask is ignored with MiniMax (note).
// Character / place LoRA (SPEC §12): after the IC-LoRA (LTX) or the turbo LoRA (MiniMax).
const fsp = require('node:fs/promises');
const path = require('node:path');
const P = require('../patch');
const real = require('./real');
const depth = require('./depth');

const E = P.exec;

const LTX_INT8 = 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors';
const MINIMAX_INT8 = 'minimax_h3_fl2va_pruned_int8_convrot.safetensors';
const UNION = 'ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors';
const FUN_CN = 'minimax_h3_fun_controlnet_union_2.0_pruned_int8_convrot.safetensors';
const PREVIEW_FRAMES = 49;
const PREVIEW_SHORT = 544;
const MM_MAX_S = 15;
const MM_PREVIEW_S = 3;
const CANNY = { low_threshold: 0.4, high_threshold: 0.8 };   // ComfyUI's / the official LTX canny template's
const GUIDE_PASSTHROUGH = { 0: 'positive', 1: 'negative', 2: 'latent' };

const TXT = {
  ltx: { fr: 'LTX 2.5 · vidéo guidée', en: 'LTX 2.5 · guided video' },
  minimax: { fr: 'MiniMax H3 · vidéo guidée', en: 'MiniMax H3 · guided video' },
  depthPass: { fr: 'Profondeur du guide…', en: 'Depth of the guide…' },
  fromDepth: { fr: 'Le guide est déjà une profondeur : utilisé tel quel.', en: 'The guide already is a depth map: used as is.' },
  grey: { fr: 'Guide en niveaux de gris : lu comme une profondeur.', en: 'Grey guide: read as a depth map.' },
  depthMade: { fr: 'Profondeur du guide calculée (Video Depth Anything Small).', en: 'Guide depth computed (Video Depth Anything Small).' },
  edges: { fr: 'Contours du guide suivis.', en: 'Guide outlines followed.' },
  mask: { fr: 'Zone libre : l’IA invente dans le blanc du masque.', en: 'Free area: the AI invents inside the mask’s white.' },
  maskSkipped: {
    fr: 'La zone libre ne marche qu’avec LTX : ignorée avec MiniMax H3.',
    en: 'The free area only works with LTX: ignored with MiniMax H3.',
  },
  look: { fr: 'Image de début posée sur la 1re image : elle donne le look.', en: 'Start image pinned to the first frame: it sets the look.' },
  strength: { fr: 'Fidélité au guide : {s}.', en: 'Guide fidelity: {s}.' },
  tooLong: {
    fr: 'Ce guide ferait {n} tranches de 4 s (plus de {max}) : coupe-le d’abord avec le bloc « Couper ».',
    en: 'This guide would need {n} chunks of 4 s (more than {max}): trim it first with the “Trim” block.',
  },
  windowShort: { fr: 'La tranche {i} n’a rendu que {got} images sur {want}.', en: 'Chunk {i} only returned {got} of {want} frames.' },
  preview: { fr: 'Aperçu : {w} × {h}, {frames} premières images.', en: 'Preview: {w} × {h}, first {frames} frames.' },
  final: { fr: 'Rendu : {w} × {h}, {frames} images en {n} tranche(s).', en: 'Render: {w} × {h}, {frames} frames in {n} chunk(s).' },
  mmSize: { fr: '{w} × {h}, {frames} images à 24 i/s ({s} s).', en: '{w} × {h}, {frames} frames at 24 fps ({s} s).' },
  mmCut: { fr: 'MiniMax H3 : guide limité à {s} s.', en: 'MiniMax H3: guide limited to {s} s.' },
};

const fmtNum = (v) => String(Math.round(v * 100) / 100).replace('.', E.t({ fr: ',', en: '.' }));

/**
 * The block that produced an input: { type, invert } (B1 may pass the type; else the upstream run.json says it,
 * with its settings — a « Profondeur » output made with « Inverser » is bright = far and must be turned back).
 */
async function sourceOf(x, inp) {
  let run = null;
  if (inp && inp.nodeId && inp.runId && x.projectDir) {
    try {
      run = JSON.parse(await fsp.readFile(path.join(x.projectDir, 'outputs', inp.nodeId, inp.runId, 'run.json'), 'utf8'));
    } catch { /* an imported file */ }
  }
  const type = (inp && (inp.sourceType || inp.fromType)) || (run && run.type) || null;
  return { type: type ? String(type) : null, invert: !!(run && run.params && run.params.invert) };
}

/** true when a few sampled frames carry (almost) no colour; null when it cannot tell. */
async function looksGrey(x, inp) {
  const raw = E.tmp(x, 'grey_probe.raw');
  try {
    await E.ffmpeg(x, ['-i', inp.abs, '-vf', "select='not(mod(n,15))',scale=64:-2,format=rgb24", '-fps_mode', 'vfr',
      '-frames:v', '6', '-f', 'rawvideo', raw], { what: 'probe' });
    const buf = await fsp.readFile(raw);
    const n = Math.floor(buf.length / 3);
    if (n < 64) return null;
    let sum = 0;
    let loud = 0;
    for (let i = 0; i < n * 3; i += 3) {
      const r = buf[i], g = buf[i + 1], b = buf[i + 2];
      const d = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b));
      sum += d;
      if (d > 12) loud++;
    }
    return sum / n < 2.5 && loud / n < 0.01;
  } catch (e) {
    if (e.cancelled) throw e;
    return null;
  } finally {
    await E.cleanup(raw);
  }
}

/**
 * The control video: { src: { abs, kind, meta, skipFirst? }, negate } — the guide itself, or its depth made here.
 * `negate`: the guide is an inverted depth (bright = far): turned back while it is prepared.
 */
async function controlOf(x, guide, meta, follow, notes, range) {
  if (follow === 'edges') { notes.push(E.t(TXT.edges)); return { src: guide, made: false }; }
  const from = await sourceOf(x, guide);
  if (from.type === 'depth') { notes.push(E.t(TXT.fromDepth)); return { src: guide, made: false, negate: from.invert }; }
  if (!from.type && (await looksGrey(x, guide)) === true) { notes.push(E.t(TXT.grey)); return { src: guide, made: false }; }
  const [a, b] = range;
  E.ranged(x, a, b)(0, E.t(TXT.depthPass));
  const frames = await depth.vda(x, guide, meta, { range: [a, a + (b - a) * 0.85], sub: 'depth', keep: 'comfy_graph_depth' });
  const w = E.even(meta.w || 0);
  const h = E.even(meta.h || 0);
  const dst = E.tmp(x, 'guide_depth.mp4');
  await E.framesToVideo(x, frames, dst, { fps: meta.fps || 24, vf: w && h ? `scale=${w}:${h}:flags=bicubic` : null,
    kind: 'inter', range: [a + (b - a) * 0.85, b], msg: E.t(TXT.depthPass) });
  notes.push(E.t(TXT.depthMade));
  return { src: { abs: dst, kind: 'video', meta: { ...meta, w, h, frames: frames.length } }, made: true, tmp: dst };
}

// ================================================================= LTX + Union-Control

async function runLtx(x, c) {
  const { meta, fps, follow, look, mask, notes, temps } = c;
  const preview = x.mode === 'preview';
  const n = Math.max(1, meta.frames || 0);
  const F = preview ? Math.min(n, PREVIEW_FRAMES) : n;
  const starts = F <= real.WINDOW ? [0] : real.windows(F);
  if (starts.length > real.MAX_WINDOWS) throw new Error(E.t(TXT.tooLong, { n: starts.length, max: real.MAX_WINDOWS }));
  const L = F <= real.WINDOW ? E.ceil8k1(F) : real.WINDOW;
  const geo = real.geometry(meta, preview, { short: E.shortSide(x, { preview, previewCap: PREVIEW_SHORT }), mult: 64 });
  const unet = c.m && c.m.comfy && c.m.comfy.name && /ltx/i.test(c.m.comfy.name) ? c.m.comfy.name : LTX_INT8;

  const ctl = await controlOf(x, c.guide, meta, follow, notes, [0, 0.14]);
  const control = ctl.src;
  if (control.abs !== c.guide.abs) temps.push(control.abs);
  const segVf = ctl.negate ? `${geo.vf},negate` : geo.vf;

  // look image and mask, brought once to the working frame
  E.ranged(x, 0.14, 0.18)(0, E.t('preparingVideo'));
  let upLook = null;
  if (look) {
    const png = E.tmp(x, 'look.png');
    temps.push(png);
    await E.stillTo(x, look.abs, png, `${geo.cover},format=rgb24`);
    upLook = await E.upload(x, png);
    notes.push(E.t(TXT.look));
  }
  let maskFull = null;
  if (mask) {
    maskFull = E.tmp(x, 'attn_full.mp4');
    temps.push(maskFull);
    const vf = `${geo.cover},negate,format=gray`;      // white = free -> attention 0
    if (mask.kind === 'video') {
      const mm = await E.metaOf(x, mask);
      await E.prepVideo(x, mask, maskFull, { fps, frames: F, vf, srcFps: mm.fps || fps, range: [0.16, 0.18] });
    } else {
      await E.encode(x, ['-loop', '1', '-framerate', String(fps), '-i', mask.abs],
        ['-vf', vf, '-frames:v', String(F), '-r', String(fps), '-an'], maskFull,
        { kind: 'inter', what: 'mask', duration: F / fps, range: [0.16, 0.18], msg: E.t('preparingVideo') });
    }
    notes.push(E.t(TXT.mask));
  }

  const span = 0.70 / starts.length;
  const outs = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const a = 0.18 + k * span;
    const msg = starts.length > 1 ? E.t('window', { i: k + 1, n: starts.length }) : E.t('computing');
    E.ranged(x, a, a + span)(0, msg);

    const seg = E.tmp(x, `control_w${k}.mp4`);
    temps.push(seg);
    await E.prepVideo(x, control, seg, { start: s, frames: L, vf: segVf, srcFps: fps, range: [a, a + span * 0.04] });
    const upSeg = await E.upload(x, seg);
    let upMask = null;
    if (maskFull) {
      const mseg = E.tmp(x, `attn_w${k}.mp4`);
      temps.push(mseg);
      await E.prepVideo(x, { abs: maskFull, kind: 'video' }, mseg, { start: s, frames: L, srcFps: fps,
        range: [a + span * 0.04, a + span * 0.06] });
      upMask = await E.upload(x, mseg);
    }

    // tool/union.py ltx_union() on the single-stage layout graph
    const g = P.load('ltx_layout_single');
    P.set(g, '5001', 'file', upSeg);
    P.set(g, '5508', 'value', c.prompt);
    P.set(g, '5509', 'value', c.negative);
    P.set(g, '5004:5602', 'unet_name', unet);
    P.set(g, '5516:4832', 'noise_seed', c.seed);
    P.setInputs(g, '5004:5606', { lora_name: UNION, strength_model: c.strength });
    P.bypass(g, '9002:9042', GUIDE_PASSTHROUGH);           // no look image at RoPE -1 (Layout-To-Render only)
    P.remove(g, '9009');
    const cg = g['9002:5012'];
    cg.class_type = 'LTXAddVideoICLoRAGuideAdvanced';
    cg.inputs.attention_strength = 1;
    if (follow === 'edges') {
      P.addNode(g, 'ImageScaleBy', { image: ['5548:9006', 0], upscale_method: 'area', scale_by: 0.5 }, '9730');
      P.addNode(g, 'Canny', { image: ['9730', 0], ...CANNY }, '9731');
      cg.inputs.image = ['9731', 0];
    }
    if (upMask) {
      P.addNode(g, 'LoadVideo', { file: upMask }, '9701');
      P.addNode(g, 'GetVideoComponents', { video: ['9701', 0] }, '9702');
      P.addNode(g, 'ImageToMask', { image: ['9702', 0], channel: 'red' }, '9703');
      cg.inputs.attention_mask = ['9703', 0];
    }
    // key on frame 0: the start image (first window), else the frame already generated there (continuity)
    const key = k === 0 ? upLook : E.annotated(outs[k - 1].files[s - starts[k - 1]]);
    if (key) {
      P.addNode(g, 'LoadImage', { image: key }, '9800');
      P.insertAfter(g, '9002:5012', '9801', { class_type: 'LTXVAddGuide',
        inputs: { vae: ['5004:5601', 0], image: ['9800', 0], frame_idx: 0, strength: 1 } }, GUIDE_PASSTHROUGH);
    }
    if (c.lora) E.addLora(g, '5004:5606', c.lora, '9710');
    P.set(g, '9990', 'filename_prefix', E.prefix(x, `w${k}`, 'frame'));

    const res = await E.submit(x, g, { range: [a + span * 0.06, a + span],
      keep: starts.length > 1 ? `comfy_graph_w${k + 1}` : 'comfy_graph' });
    const files = await E.filesOrThrow(x, res.outputs, '9990');
    const want = Math.min(L, F - s);
    if (files.length < want) throw new Error(E.t(TXT.windowShort, { i: k + 1, got: files.length, want }));
    outs.push({ start: s, files, abs: files.map((f) => f.abs) });
  }

  E.ranged(x, 0.88, 0.92)(0, E.t('joining'));
  const seq = starts.length === 1 ? outs[0].abs.slice(0, F) : await real.join(x, outs, F, temps);
  const dst = path.join(x.outDir, 'video.mp4');
  await E.framesToVideo(x, seq, dst, { fps, vf: geo.crop, count: F, range: [0.92, 1], msg: E.t('encoding') });
  notes.unshift(preview ? E.t(TXT.preview, { w: geo.ow, h: geo.oh, frames: F })
    : E.t(TXT.final, { w: geo.ow, h: geo.oh, frames: F, n: starts.length }));
  return {
    outputs: { video: { abs: dst, kind: 'video', meta: { w: geo.ow, h: geo.oh, fps, frames: F } } },
    model: E.labelOf(c.m, E.t(TXT.ltx)),
  };
}

// ================================================================= MiniMax H3 + Fun ControlNet Union

function mmPlan(x, meta) {
  const preview = x.mode === 'preview';
  const fps = meta.fps || 24;
  const srcS = Math.max(0.1, (meta.frames || 0) / fps);
  const cap = preview ? MM_PREVIEW_S : MM_MAX_S;
  const seconds = Math.min(srcS, cap);
  const frames = E.minimaxLength(seconds, true);
  const mmc = E.minimaxCanvas(x, { preview, previewCap: 448 });
  const ratio = meta.w > 0 && meta.h > 0 ? meta.w / meta.h : 16 / 9;
  const { w, h } = E.videoSize({ ratio, short: mmc.short, exact: false, maxPixels: mmc.maxPixels });
  return { preview, frames, w, h, cut: !preview && srcS > MM_MAX_S + 0.05, srcFps: fps, native: mmc.native };
}

async function runMinimax(x, c) {
  const { meta, follow, look, mask, notes, temps } = c;
  const pl = mmPlan(x, meta);
  const { w, h, frames } = pl;
  if (mask) notes.push(E.t(TXT.maskSkipped));

  const made = await controlOf(x, c.guide, meta, follow, notes, [0, 0.12]);
  const control = made.src;
  if (control.abs !== c.guide.abs) temps.push(control.abs);
  const ctl = E.tmp(x, 'control_24.mp4');
  temps.push(ctl);
  await E.prepVideo(x, control, ctl, { fps: 24, frames, srcFps: pl.srcFps,
    vf: `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}${made.negate ? ',negate' : ''}`,
    range: [0.12, 0.16] });
  E.ranged(x, 0.16, 0.18)(0, E.t('uploading'));
  const upCtl = await E.upload(x, ctl);
  const upLook = look ? await E.upload(x, look.abs) : null;

  const g = P.load('minimax_i2v');
  P.set(g, '1', 'unet_name', c.m && c.m.comfy && c.m.comfy.name && /minimax/i.test(c.m.comfy.name) && !/ref2v/i.test(c.m.comfy.name)
    ? c.m.comfy.name : MINIMAX_INT8);
  P.setInputs(g, '8', { prompt: c.prompt, width: w, height: h, length: frames });
  P.set(g, '9', 'noise_seed', c.seed);
  if (upLook) {
    P.set(g, '6', 'image', upLook);
    P.setInputs(g, '18', { width: w, height: h });
    notes.push(E.t(TXT.look));
  } else {
    delete g['8'].inputs.first_frame;
    P.remove(g, '6', '18');
  }
  P.addNode(g, 'LoadVideo', { file: upCtl }, '20');
  P.addNode(g, 'GetVideoComponents', { video: ['20', 0] }, '21');
  let ctlOut = ['21', 0];
  if (follow === 'edges') {
    P.addNode(g, 'ImageScaleBy', { image: ['21', 0], upscale_method: 'area', scale_by: 0.5 }, '24');
    P.addNode(g, 'Canny', { image: ['24', 0], ...CANNY }, '25');
    P.addNode(g, 'ImageScale', { image: ['25', 0], upscale_method: 'lanczos', width: w, height: h, crop: 'disabled' }, '26');
    ctlOut = ['26', 0];
  }
  P.addNode(g, 'ModelPatchLoader', { name: FUN_CN }, '22');
  const tail = c.lora ? E.addLora(g, '2', c.lora, '40') : '2';     // turbo LoRA -> [character LoRA] -> control
  P.insertAfter(g, tail, '23', { class_type: 'MiniMaxH3FunControlNetApply', inputs: { model_patch: ['22', 0],
    vae: ['4', 0], strength: c.strength, start_percent: 0, end_percent: 1, control_video: ctlOut } }, { 0: 'model' });
  P.set(g, '9990', 'filename_prefix', E.prefix(x, '', 'frame'));
  P.set(g, '9991', 'filename_prefix', E.prefix(x, '', 'audio'));

  const res = await E.submit(x, g, { range: [0.18, 0.93] });
  const shots = (await E.filesOrThrow(x, res.outputs, '9990')).map((f) => f.abs);
  const sound = (await E.files(x, res.outputs, '9991'))[0];
  const dst = path.join(x.outDir, 'video.mp4');
  await E.framesToVideo(x, shots, dst, { fps: 24, audio: sound ? sound.abs : null, range: [0.93, 1], msg: E.t('encoding') });
  notes.unshift(E.t(TXT.mmSize, { w, h, frames: shots.length, s: E.dec(shots.length / 24) }));
  if (pl.cut) notes.push(E.t(TXT.mmCut, { s: MM_MAX_S }));
  if (pl.native) notes.push(E.t('minimax768'));
  return {
    outputs: { video: { abs: dst, kind: 'video', meta: { w, h, fps: 24, frames: shots.length } } },
    model: E.labelOf(c.m, E.t(TXT.minimax)),
  };
}

// ================================================================= entry

async function run(x) {
  E.begin(x);
  const guide = E.input(x, 'guide');
  const look = E.input(x, 'look', false);
  const mask = E.input(x, 'mask', false);
  const meta = await E.metaOf(x, guide);
  if (!meta.frames) throw new Error(E.t('noFrames'));
  const m = E.model(x, 'model');
  const mm = E.isMinimax(m);
  const notes = [];

  const promptIn = E.promptOf(x);
  if (!promptIn.prompt) throw new Error(E.t('noPrompt'));
  const lora = await E.lora(x, mm ? 'minimax' : 'ltx');
  const prompt = E.loraPrompt(promptIn.prompt, lora, notes);
  const sv = Number(x.params.strength);
  const strength = Number.isFinite(sv) ? Math.min(2, Math.max(0.05, sv)) : 1;
  notes.push(E.t(TXT.strength, { s: fmtNum(strength) }));

  const c = {
    guide, look: look && look.abs ? look : null, mask: mask && mask.abs ? mask : null, meta, fps: meta.fps || 24,
    follow: x.params.follow === 'edges' ? 'edges' : 'depth', m, lora, prompt, negative: promptIn.negative,
    strength, seed: E.seedOf(x), notes, temps: [],
  };
  try {
    const res = mm ? await runMinimax(x, c) : await runLtx(x, c);
    return { ...res, notes: E.notes(notes) };
  } finally {
    await E.cleanup(c.temps);
  }
}

function estimate(x) {
  try {
    const inp = (x.inputs && x.inputs.guide) || {};
    const meta = { w: 1920, h: 1080, fps: 24, frames: 97, ...(inp.meta || {}) };
    const m = E.model(x, 'model');
    const depthMin = x.params && x.params.follow === 'edges' ? 0 : 0.3 + meta.frames * 0.004;
    if (E.isMinimax(m)) {
      const pl = mmPlan(x, meta);
      return depthMin + (pl.preview ? 1.5 : 0.6 + 2.2 * (pl.frames / 56) * ((pl.w * pl.h) / (704 * 1248)));
    }
    const preview = x.mode === 'preview';
    const F = preview ? Math.min(meta.frames, PREVIEW_FRAMES) : meta.frames;
    const starts = F <= real.WINDOW ? [0] : real.windows(F);
    const geo = real.geometry(meta, preview, { short: E.shortSide(x, { preview, previewCap: PREVIEW_SHORT }), mult: 64 });
    if (preview) return depthMin + 2;
    // lab: 6–10 min per 97-frame window at 1088×1920
    return depthMin + 0.5 + starts.length * (1 + 8 * Math.max(0.25, (geo.W * geo.H) / (1088 * 1920)));
  } catch { return x && x.mode === 'preview' ? 2 : 9; }
}

module.exports = { run: E.wrap(run), estimate, _mmPlan: mmPlan, _looksGrey: looksGrey, _sourceOf: sourceOf };
