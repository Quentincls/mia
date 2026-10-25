'use strict';
// Video from text ("Vidéo depuis un texte"): LTX-2.5 single-stage distilled, text only, run locally in int8.
// Graph = the lab's ltx_t2v_single.api.json made local (int8 + Gemma int8, no prompt enhancer, no cloud Gemma
// branch, no dummy start image, euler) — trailer_secondepart/scripts/vague_t2v.py did the same on the pod.
// Size = the block's format (16:9, 9:16, 1:1, 4:3, 3:4, 21:9) at its resolution (short side 540 / 720 / 1080),
// generated on LTX's 32-px grid and cropped back to the exact size (1088 → 1080, as the lab does).
// Character / place LoRA (SPEC §12): LoraLoaderModelOnly after the UNET, trigger word put first in the prompt.
// Model block extras (« à essayer »): « Deux passes » (half size, latent ×2, 3 refining steps) for final renders and
// « Enrichir la consigne » (Gemma rewrites the prompt), as in i2v.js; « Vidéo depuis une fiche personnage »: a
// reference sheet without any start image, as the official LTX-2.5_ICLoRA_Ingredients template does (empty latent,
// the sheet fitted to the frame and held on every frame as an IC-LoRA guide at frame 0, guides cropped before decode).
const path = require('node:path');
const P = require('../patch');

const E = P.exec;

const LTX_INT8 = 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors';
const FPS = 24;
const PREVIEW_MAX_S = 3;

const LTX_MAX_PIXELS = 2.2e6;          // ≈ 1088×1920, the lab's largest LTX shot on the laptop
const INGREDIENTS = 'ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors';
const SHEET_TOKENS = 17000;            // with a sheet: video tokens (latent frames × 32-px patches) at most, as i2v.js

const TXT = {
  model: { fr: 'LTX 2.5', en: 'LTX 2.5' },
  noPrompt: { fr: 'Décris la vidéo à créer (en anglais, de préférence).', en: 'Describe the video to create (English works best).' },
  size: { fr: '{w} × {h}, {frames} images à {fps} i/s ({s} s).', en: '{w} × {h}, {frames} frames at {fps} fps ({s} s).' },
  previewNote: { fr: 'Aperçu : basse définition, 3 s au plus.', en: 'Preview: low resolution, 3 s at most.' },
  sheet: {
    fr: 'Fiche personnage suivie sur tout le plan, sans image de début (à essayer : regarde si le personnage lui ressemble).',
    en: 'Character sheet followed through the whole shot, no start image (to try: check the character looks like it).',
  },
  sheetRes: {
    fr: 'Avec une fiche, taille ramenée à {w} × {h} pour tenir en mémoire.',
    en: 'With a sheet, size reduced to {w} × {h} to fit in memory.',
  },
};

function plan(x) {
  const preview = x.mode === 'preview';
  const sheet = !!(x.inputs && x.inputs.sheet && x.inputs.sheet.abs);
  // « auto » (the Model block's default) shows as 16:9 without a start image: do the same
  const ratio = E.formatRatio(x.params.format === 'auto' ? '16:9' : x.params.format, null, 16 / 9);
  const twoPass = !preview && x.params.twoPass === true && !sheet;
  // LTX is trusted up to its family limit (SPEC §22), the bound the block shows
  const dur = Math.max(1, Math.min(E.maxSeconds(E.model(x, 'model'), 'ltx'), Number(x.params.duration) || 5));
  const seconds = preview ? Math.min(dur, PREVIEW_MAX_S) : dur;
  const frames = E.ltxFrames(FPS, seconds);
  // the looped sheet doubles the video tokens: keep the total near the lab's largest shot, as i2v.js
  const sheetMax = sheet ? (SHEET_TOKENS * 1024) / (Math.floor((frames - 1) / 8) + 1) : Infinity;
  const short = E.shortSide(x, { preview, previewCap: 576 });
  const size = E.videoSize({ ratio, short, maxPixels: Math.min(LTX_MAX_PIXELS, sheetMax), mult: twoPass ? 64 : 32 });
  const free = sheet ? E.videoSize({ ratio, short, maxPixels: LTX_MAX_PIXELS }) : size;
  const { w, h } = size;
  return { preview, w, h, ow: size.ow, oh: size.oh, crop: size.crop, seconds, frames, twoPass, sheet,
    sheetCapped: sheet && free.w * free.h > w * h, enhance: x.params.enhance === true };
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
  // model chain: UNET -> [Ingredients IC-LoRA] -> [character LoRA]
  let modelTail = '5004:5569';
  if (pl.sheet) {
    P.insertAfter(g, '5004:5569', '9820', { class_type: 'LTXICLoRALoaderModelOnly',
      inputs: { lora_name: INGREDIENTS, strength_model: 1 } }, { 0: 'model' });
    modelTail = '9820';
  }
  if (lora) E.addLora(g, modelTail, lora, '9710');
  if (pl.sheet) {
    // the sheet fitted (padded black) to the frame, held on every frame, guide at 0 on the empty latent
    const upSheet = await E.upload(x, x.inputs.sheet.abs);
    P.addNode(g, 'LoadImage', { image: upSheet }, '9821');
    P.addNode(g, 'ResizeAndPadImage', { image: ['9821', 0], target_width: w, target_height: h,
      padding_color: 'black', interpolation: 'lanczos' }, '9822');
    P.addNode(g, 'RepeatImageBatch', { image: ['9822', 0], amount: pl.frames }, '9823');
    P.addNode(g, 'LTXAddVideoICLoRAGuide', { positive: ['5014:1241', 0], negative: ['5014:1241', 1], vae: ['5004:5571', 0],
      latent: ['5514:3059', 0], image: ['9823', 0], frame_idx: 0, strength: 1, latent_downscale_factor: ['9820', 1],
      crop: 'disabled', use_tiled_encode: false, tile_size: 256, tile_overlap: 64 }, '9824');
    P.set(g, '5514:4528', 'video_latent', ['9824', 2]);
    P.setInputs(g, '5516:4828', { positive: ['9824', 0], negative: ['9824', 1] });
    P.addNode(g, 'LTXVCropGuides', { positive: ['9824', 0], negative: ['9824', 1], latent: ['5516:4845', 0] }, '9825');
    P.set(g, '5518:5538', 'samples', ['9825', 2]);
    notes.push(E.t(TXT.sheet));
    if (pl.sheetCapped) notes.push(E.t(TXT.sheetRes, { w: pl.ow, h: pl.oh }));
  }
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
    const { w, h, frames, twoPass, enhance, sheet } = plan(x);
    const extra = enhance ? 0.5 : 0;
    // a looped sheet doubles the tokens: attention grows ~ tokens^1.5 (as i2v.js)
    return (twoPass ? E.ltxMinutes(w / 2, h / 2, frames) + E.ltxMinutes(w, h, frames) * (3 / 8) : E.ltxMinutes(w, h, frames) * (sheet ? 2.8 : 1)) + extra;
  } catch { return x && x.mode === 'preview' ? 1 : 7; }
}

module.exports = { run: E.wrap(run), estimate, _plan: plan };
