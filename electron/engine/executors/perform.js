'use strict';
// Animate a character ("Animer un personnage"): Wan Animate 2, local int8 + lightx2v (6 steps lcm).
// One image of the character + a motion video -> the character replays the motion and expressions.
// Graph = ComfyUI's Wan Animate 2 template made local (adapted from one of the author's tests): pose_end_percent 1.0
// (the official export's 0 barely drives lips and gestures), 81-frame segments chained by the graph's own loop.
// Wan is trained at 16 fps: the motion video is resampled to 16 fps and cut to 4n+1 frames first, and the
// result stays at 16 fps (the lab smooths it back with RIFE ×8, which is not installed on this laptop).
// Character LoRA (SPEC §12, Wan family): after the lightx2v LoRA, trigger word put first in the description.
const path = require('node:path');
const P = require('../patch');

const E = P.exec;

const WAN_INT8 = 'wan_animate_2_int8_convrot.safetensors';
const WAN_FPS = 16;
const SEGMENT = 81;
const PREVIEW_FRAMES = 49;                    // ~3 s
const MAX_FRAMES = 4 * 120 + 1;               // ~30 s, six segments (~1 h 30 of GPU)

// multiples of 16: 720×1280 final (lab), 480p short side for the preview
const SIZES = {
  final: { vertical: [720, 1280], horizontal: [1280, 720] },
  preview: { vertical: [480, 848], horizontal: [848, 480] },
};

const TXT = {
  model: { fr: 'Wan Animate 2', en: 'Wan Animate 2' },
  character: {
    fr: 'Character Description: the character of the reference image.\nBackground description: the background of the reference image.',
    en: 'Character Description: the character of the reference image.\nBackground description: the background of the reference image.',
  },
  background: { fr: 'Background description: as in the reference image.', en: 'Background description: as in the reference image.' },
  action: {
    fr: 'The character performs exactly the motion of the driving video, natural facial expressions and lip movements, real footage.',
    en: 'The character performs exactly the motion of the driving video, natural facial expressions and lip movements, real footage.',
  },
  strengths: {
    fr: 'Fidélité au mouvement {pose}, ressemblance au personnage {face} (1 = normal).',
    en: 'Motion fidelity {pose}, character likeness {face} (1 = normal).',
  },
  fps: {
    fr: 'Vidéo à 16 i/s, la cadence de Wan (le lissage RIFE n’est pas encore installé en local).',
    en: 'Video at 16 fps, Wan’s frame rate (RIFE smoothing is not installed locally yet).',
  },
  size: { fr: '{w} × {h}, {frames} images ({s} s), {seg} segment(s) de 81.', en: '{w} × {h}, {frames} frames ({s} s), {seg} segment(s) of 81.' },
  cut: { fr: 'Vidéo de mouvement limitée à {s} s.', en: 'Motion video limited to {s} s.' },
  tooShort: { fr: 'La vidéo de mouvement est trop courte (moins d’une demi-seconde).', en: 'The motion video is too short (under half a second).' },
  previewNote: { fr: 'Aperçu : 480p, 3 premières secondes.', en: 'Preview: 480p, first 3 seconds.' },
};

function plan(x, meta) {
  const preview = x.mode === 'preview';
  const fps = meta.fps || 24;
  const seconds = (meta.frames || 0) / fps;
  const n16 = Math.floor(seconds * WAN_FPS + 1e-6);
  let frames = 4 * Math.floor((n16 - 1) / 4) + 1;                 // Wan wants 4n+1 frames
  const capped = !preview && frames > MAX_FRAMES;
  frames = Math.min(frames, preview ? PREVIEW_FRAMES : MAX_FRAMES);
  const orient = (meta.w || 0) > (meta.h || 0) ? 'horizontal' : 'vertical';
  const [w, h] = SIZES[preview ? 'preview' : 'final'][orient];
  const segments = Math.floor((Math.max(frames, 2) - 2) / (SEGMENT - 1)) + 1;   // the graph's own loop count
  return { preview, frames, capped, w, h, segments, srcFps: fps };
}

/** "Character Description: …" is how the Wan Animate prompt is written; keep the user's text inside it. */
function characterText(prompt) {
  if (!prompt) return E.t(TXT.character);
  if (/character description\s*:/i.test(prompt)) return prompt;
  return `Character Description: ${prompt}\n${E.t(TXT.background)}`;
}

/** A strength slider (0 to 2, 1 = the model's trained behaviour), clamped and rounded to 0.05. */
function strengthOf(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(Math.min(2, Math.max(0, n)) * 20) / 20 : 1;
}

async function run(x) {
  E.begin(x);
  const char = E.input(x, 'character');
  const motion = E.input(x, 'motion');
  const meta = await E.metaOf(x, motion);
  const pl = plan(x, meta);
  if (pl.frames < 5) throw new Error(E.t(TXT.tooShort));
  const notes = [];

  const lora = await E.lora(x, 'wan');
  const prompt = E.loraPrompt(E.promptOf(x).prompt, lora, notes);
  const m = E.model(x, 'model');
  const unet = (m && m.comfy && m.comfy.name && /wan/i.test(m.comfy.name)) ? m.comfy.name : WAN_INT8;

  // ---- motion video at 16 fps, exactly 4n+1 frames, long side <= 1920 (the graph resizes anyway)
  const motion16 = E.tmp(x, 'motion16.mp4');
  try {
    await E.prepVideo(x, motion, motion16, {
      fps: WAN_FPS, frames: pl.frames, srcFps: pl.srcFps, audio: meta.hasAudio === true,
      vf: "scale=w='min(iw,1920)':h='min(ih,1920)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      range: [0, 0.05],
    });
    E.ranged(x, 0.05, 0.08)(0, E.t('uploading'));
    const upChar = await E.upload(x, char.abs);
    const upMotion = await E.upload(x, motion16);

    const g = P.load('wan_animate2');
    P.set(g, '189', 'image', upChar);
    P.set(g, '240', 'file', upMotion);
    P.setInputs(g, '672:600', { 'resize_type.width': pl.w, 'resize_type.height': pl.h });
    P.set(g, '672:582', 'text', characterText(prompt));
    P.set(g, '672:585', 'text', E.t(TXT.action));
    P.set(g, '672:578', 'unet_name', unet);
    if (/distill/i.test(unet)) {
      // the official distilled model needs no lightx2v LoRA and 10 steps (wan_animate.py)
      P.set(g, '672:579', 'strength_model', 0);
      P.set(g, '672:591', 'steps', 10);
    }
    P.set(g, '672:597', 'noise_seed', E.seedOf(x));
    // « Fidélité au mouvement » = pose_strength, « Ressemblance au personnage » = reference_image_strength (1 = trained)
    const pose = strengthOf(x.params.motionFidelity);
    const face = strengthOf(x.params.likeness);
    P.setInputs(g, '672:587', { pose_strength: pose, reference_image_strength: face });
    if (pose !== 1 || face !== 1) notes.push(E.t(TXT.strengths, { pose: E.dec(pose, 2), face: E.dec(face, 2) }));
    if (lora) E.addLora(g, '672:579', lora, '9710');   // after the lightx2v (or distilled) model chain
    P.set(g, '9990', 'filename_prefix', E.prefix(x, '', 'frame'));

    const res = await E.submit(x, g, { range: [0.08, 0.93] });
    const shots = (await E.filesOrThrow(x, res.outputs, '9990')).map((f) => f.abs);
    const dst = path.join(x.outDir, 'video.mp4');
    await E.framesToVideo(x, shots, dst, {
      fps: WAN_FPS, audio: meta.hasAudio === true ? motion16 : null, range: [0.93, 1], msg: E.t('encoding'),
    });

    notes.unshift(E.t(TXT.size, { w: pl.w, h: pl.h, frames: shots.length, s: E.dec(shots.length / WAN_FPS), seg: pl.segments }));
    if (pl.preview) notes.push(E.t(TXT.previewNote));
    if (pl.capped) notes.push(E.t(TXT.cut, { s: Math.round(MAX_FRAMES / WAN_FPS) }));
    notes.push(E.t(TXT.fps));
    return {
      outputs: { video: { abs: dst, kind: 'video', meta: { w: pl.w, h: pl.h, fps: WAN_FPS, frames: shots.length } } },
      model: E.labelOf(m, E.t(TXT.model)),
      notes: E.notes(notes),
    };
  } finally {
    await E.cleanup(motion16);
  }
}

function estimate(x) {
  try {
    const inp = (x.inputs && x.inputs.motion) || {};
    const meta = inp.meta || {};
    const pl = plan(x, { w: meta.w, h: meta.h, fps: meta.fps || 24, frames: meta.frames || 120 });
    const px = (pl.w * pl.h) / (720 * 1280);
    // ~14 min per 81-frame segment at 720×1280 (lab measure), the first load included
    return 1 + 13 * pl.segments * Math.max(0.3, px) * Math.min(1, pl.frames / SEGMENT + 0.2);
  } catch { return x && x.mode === 'preview' ? 4 : 14; }
}

module.exports = { run: E.wrap(run), estimate, _plan: plan };
