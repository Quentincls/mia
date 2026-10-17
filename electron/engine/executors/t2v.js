'use strict';
// Video from text ("Vidéo depuis un texte"): LTX-2.5 single-stage distilled, text only, run locally in int8.
// Graph = the lab's ltx_t2v_single.api.json made local (int8 + Gemma int8, no prompt enhancer, no cloud Gemma
// branch, no dummy start image, euler) — trailer_secondepart/scripts/vague_t2v.py did the same on the pod.
// Size = the block's format (16:9, 9:16, 1:1, 4:3, 3:4, 21:9) at its resolution (short side 540 / 720 / 1080),
// generated on LTX's 32-px grid and cropped back to the exact size (1088 → 1080, as the lab does).
// Character / place LoRA (SPEC §12): LoraLoaderModelOnly after the UNET, trigger word put first in the prompt.
const path = require('node:path');
const P = require('../patch');

const E = P.exec;

const LTX_INT8 = 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors';
const FPS = 24;
const PREVIEW_MAX_S = 3;

const LTX_MAX_PIXELS = 2.2e6;          // ≈ 1088×1920, the lab's largest LTX shot on the laptop

const TXT = {
  model: { fr: 'LTX 2.5', en: 'LTX 2.5' },
  noPrompt: { fr: 'Décris la vidéo à créer (en anglais, de préférence).', en: 'Describe the video to create (English works best).' },
  size: { fr: '{w} × {h}, {frames} images à {fps} i/s ({s} s).', en: '{w} × {h}, {frames} frames at {fps} fps ({s} s).' },
  previewNote: { fr: 'Aperçu : basse définition, 3 s au plus.', en: 'Preview: low resolution, 3 s at most.' },
};

function plan(x) {
  const preview = x.mode === 'preview';
  const ratio = E.formatRatio(x.params.format, null, 16 / 9);
  const size = E.videoSize({ ratio, short: E.shortSide(x, { preview, previewCap: 576 }), maxPixels: LTX_MAX_PIXELS });
  const { w, h } = size;
  const dur = Math.max(1, Math.min(20, Number(x.params.duration) || 5));
  const seconds = preview ? Math.min(dur, PREVIEW_MAX_S) : dur;
  return { preview, w, h, ow: size.ow, oh: size.oh, crop: size.crop, seconds, frames: E.ltxFrames(FPS, seconds) };
}

async function run(x) {
  E.begin(x);
  const pl = plan(x);
  const { w, h, seconds } = pl;
  const promptIn = E.promptOf(x, { negativeDefault: 'text, watermark, cuts' });
  const { negative } = promptIn;
  if (!promptIn.prompt) throw new Error(E.t(TXT.noPrompt));
  const notes = [];
  const lora = await E.lora(x, 'ltx');
  const prompt = E.loraPrompt(promptIn.prompt, lora, notes);
  const m = E.model(x, 'model');
  const unet = (m && m.comfy && m.comfy.name && /ltx/i.test(m.comfy.name)) ? m.comfy.name : LTX_INT8;

  const g = P.load('ltx_t2v');
  P.set(g, '5004:5569', 'unet_name', unet);
  P.set(g, '5508', 'value', prompt);
  P.set(g, '5509', 'value', negative);
  P.set(g, '5511', 'value', FPS);
  P.set(g, '5512', 'value', seconds);              // the graph turns fps × seconds into 8k+1 frames itself
  P.setInputs(g, '5514:3059', { width: w, height: h });
  P.set(g, '5516:4832', 'noise_seed', E.seedOf(x));
  if (lora) E.addLora(g, '5004:5569', lora, '9710');
  P.set(g, '9990', 'filename_prefix', E.prefix(x, '', 'frame'));
  P.set(g, '9991', 'filename_prefix', E.prefix(x, '', 'audio'));

  const res = await E.submit(x, g, { range: [0.02, 0.92] });
  const shots = (await E.filesOrThrow(x, res.outputs, '9990')).map((f) => f.abs);
  const sound = (await E.files(x, res.outputs, '9991'))[0];

  const out = await E.framesToVideo(x, shots, path.join(x.outDir, 'video.mp4'), {
    fps: FPS, vf: pl.crop, audio: sound ? sound.abs : null, range: [0.92, 1], msg: E.t('encoding'),
  });
  const { ow, oh } = pl;
  return {
    outputs: { video: { abs: out, kind: 'video', meta: { w: ow, h: oh, fps: FPS, frames: shots.length } } },
    model: E.labelOf(m, E.t(TXT.model)),
    notes: E.notes([
      E.t(TXT.size, { w: ow, h: oh, frames: shots.length, fps: FPS, s: E.dec(shots.length / FPS) }),
      pl.preview ? E.t(TXT.previewNote) : null,
      ...notes,
    ]),
  };
}

function estimate(x) {
  try {
    const { w, h, frames } = plan(x);
    return E.ltxMinutes(w, h, frames);
  } catch { return x && x.mode === 'preview' ? 1 : 7; }
}

module.exports = { run: E.wrap(run), estimate, _plan: plan };
