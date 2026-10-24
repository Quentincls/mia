'use strict';
// Video from text ("Vidéo depuis un texte"): LTX-2.5 single-stage distilled, text only, run locally in int8.
// Graph = the lab's ltx_t2v_single.api.json made local (int8 + Gemma int8, no prompt enhancer, no cloud Gemma
// branch, no dummy start image, euler) — trailer_secondepart/scripts/vague_t2v.py did the same on the pod.
// Size = the block's format (16:9, 9:16, 1:1, 4:3, 3:4, 21:9) at its resolution (short side 540 / 720 / 1080),
// generated on LTX's 32-px grid and cropped back to the exact size (1088 → 1080, as the lab does).
// Character / place LoRA (SPEC §12): LoraLoaderModelOnly after the UNET, trigger word put first in the prompt.
// Model block extras (« à essayer »): « Deux passes » (half size, latent ×2, 3 refining steps) for final renders and
// « Enrichir la consigne » (Gemma rewrites the prompt), as in i2v.js.
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
  const twoPass = !preview && x.params.twoPass === true;
  const size = E.videoSize({ ratio, short: E.shortSide(x, { preview, previewCap: 576 }), maxPixels: LTX_MAX_PIXELS,
    mult: twoPass ? 64 : 32 });
  const { w, h } = size;
  // LTX is trusted up to its family limit (SPEC §22), the bound the block shows
  const dur = Math.max(1, Math.min(E.maxSeconds(E.model(x, 'model'), 'ltx'), Number(x.params.duration) || 5));
  const seconds = preview ? Math.min(dur, PREVIEW_MAX_S) : dur;
  return { preview, w, h, ow: size.ow, oh: size.oh, crop: size.crop, seconds, frames: E.ltxFrames(FPS, seconds), twoPass,
    enhance: x.params.enhance === true };
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
  const enhanceId = pl.enhance
    ? E.ltxEnhance(g, { clip: ['5004:5572', 0], prompt: ['5508', 0], encode: '5014:2483', seed: E.seedOf(x) }) : null;
  if (pl.twoPass) {
    // stage 1 at half size -> its video latent ×2 -> 3 refining steps at full size (sound carried over)
    P.setInputs(g, '5514:3059', { width: w / 2, height: h / 2 });
    P.addNode(g, 'LatentUpscaleModelLoader', { model_name: E.LTX_UPSCALER }, '9810');
    P.addNode(g, 'LTXVLatentUpsampler', { samples: ['5516:4845', 0], upscale_model: ['9810', 0], vae: ['5004:5571', 0] }, '9811');
    P.addNode(g, 'LTXVConcatAVLatent', { video_latent: ['9811', 0], audio_latent: ['5516:4845', 1] }, '9812');
    P.addNode(g, 'RandomNoise', { noise_seed: E.seedOf(x) + 1 }, '9813');
    P.addNode(g, 'CFGGuider', { cfg: 1, model: g['5516:4828'].inputs.model, positive: ['5014:1241', 0], negative: ['5014:1241', 1] }, '9814');
    P.addNode(g, 'ManualSigmas', { sigmas: E.LTX_STAGE2_SIGMAS }, '9815');
    P.addNode(g, 'SamplerCustomAdvanced', { noise: ['9813', 0], guider: ['9814', 0], sampler: ['5516:4831', 0],
      sigmas: ['9815', 0], latent_image: ['9812', 0] }, '9816');
    P.addNode(g, 'LTXVSeparateAVLatent', { av_latent: ['9816', 0] }, '9817');
    P.set(g, '5518:5538', 'samples', ['9817', 0]);
    P.set(g, '5518:4848', 'samples', ['9817', 1]);
    notes.push(E.t('twoPass', { w1: w / 2, h1: h / 2 }));
  }
  P.set(g, '9990', 'filename_prefix', E.prefix(x, '', 'frame'));
  P.set(g, '9991', 'filename_prefix', E.prefix(x, '', 'audio'));

  const res = await E.submit(x, g, { range: [0.02, 0.92] });
  if (enhanceId) {
    const text = E.enhancedText(res, enhanceId);
    notes.push(text ? E.t('enhanced', { text: text.length > 400 ? `${text.slice(0, 400)}…` : text }) : E.t('enhancedNone'));
  }
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
    const { w, h, frames, twoPass, enhance } = plan(x);
    const extra = enhance ? 0.5 : 0;
    return (twoPass ? E.ltxMinutes(w / 2, h / 2, frames) + E.ltxMinutes(w, h, frames) * (3 / 8) : E.ltxMinutes(w, h, frames)) + extra;
  } catch { return x && x.mode === 'preview' ? 1 : 7; }
}

module.exports = { run: E.wrap(run), estimate, _plan: plan };
