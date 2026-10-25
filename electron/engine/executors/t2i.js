'use strict';
// Image from text (« Image depuis un texte »), on this PC, through ComfyUI:
// - FLUX.2 Klein 9B (Black Forest Labs, distilled: 4 steps, cfg 1) — templates image_flux2_klein_text_to_image and,
//   with an image wired, image_flux2_klein_image_edit_9b_distilled (the image as a reference latent: the result keeps
//   its framing and follows the prompt);
// - Qwen-Image 2.1 Turbo (8 steps, cfg 1) — template image_qwen_image_2_1_t2i, without its prompt enhancer.
// Size = the block's format × its resolution (1K ≈ 1 MP, 1,5K ≈ 2 MP, 2K ≈ 4 MP), multiples of 16 (Klein) / 32 (Qwen),
// in every mode: an image takes seconds, a smaller « preview » would only ignore the Size the user chose (the Model
// card's one « Lancer » runs in the planner's default mode). Character / place / style LoRA (SPEC §12): only one made for the block's model (a Klein 9B
// LoRA on Klein, a Qwen-Image 2.1 LoRA on Qwen 2.1), right after the diffusion model, trigger word first in the prompt.
const path = require('node:path');
const P = require('../patch');

const E = P.exec;

const KLEIN = { unet: 'flux-2-klein-9b.safetensors', te: 'qwen_3_8b_fp8mixed.safetensors', vae: 'flux2-vae.safetensors' };
const QWEN21 = {
  unet: 'qwen_image_2.1_turbo_int8_convrot.safetensors', te: 'qwen3vl_8b_int8_convrot.safetensors', vae: 'qwen_image_2.1_vae_bf16.safetensors',
};
const MAX_SIDE = { flux2klein9b: 1440, qwen21: 2048 };

const TXT = {
  klein: { fr: 'FLUX.2 Klein 9B', en: 'FLUX.2 Klein 9B' },
  qwen21: { fr: 'Qwen-Image 2.1', en: 'Qwen-Image 2.1' },
  noPrompt: { fr: 'Écris la consigne de l’image (en anglais, de préférence).', en: 'Write the image prompt (English works best).' },
  size: { fr: '{w} × {h}.', en: '{w} × {h}.' },
  steps: { fr: '{n} étapes.', en: '{n} steps.' },
  fromImage: { fr: 'Part de ton image : elle garde son cadrage et suit la consigne.', en: 'Starts from your image: it keeps its framing and follows the prompt.' },
  licence: {
    fr: 'Licence non commerciale : pour des essais et des projets perso, pas pour un projet payé.',
    en: 'Non-commercial license: for trials and personal projects, not for paid work.',
  },
};

/** 'flux2klein9b' | 'qwen21' : the block's family, from the resolved model (else its plan). */
function familyOf(x, m) {
  const k = E.familyKey(m);
  if (k === 'qwen21' || k === 'flux2klein9b') return k;
  return x.gen && x.gen.key === 'qwen21' ? 'qwen21' : 'flux2klein9b';
}

/** Width × height for a ratio and the block's resolution (side of the equivalent square), multiples of `mult`. */
function sizeOf(x, fam, ratio, mult) {
  const side = Math.max(512, Math.min(MAX_SIDE[fam], Number(x.params.resolution) || 1024));
  const area = side * side;
  return [E.snap(Math.sqrt(area * ratio), mult), E.snap(Math.sqrt(area / ratio), mult)];
}

async function run(x) {
  E.begin(x);
  const promptIn = E.promptOf(x);
  if (!promptIn.prompt) throw new Error(E.t(TXT.noPrompt));
  const m = E.model(x, 'model');
  const fam = familyOf(x, m);
  const loraNotes = [];
  const lora = await E.lora(x, fam);
  const prompt = E.loraPrompt(promptIn.prompt, lora, loraNotes);
  const notes = [];
  const files = fam === 'qwen21' ? QWEN21 : KLEIN;
  const unet = E.modelFile(x, 'model', files.unet);
  await E.requireModels(x, [['diffusion_models', unet], ['text_encoders', files.te], ['vae', files.vae]],
    fam === 'qwen21' ? TXT.qwen21 : TXT.klein);

  let g, save, w = null, h = null;
  if (fam === 'qwen21') {
    const ratio = E.formatRatio(x.params.format === 'auto' ? '16:9' : x.params.format, null, 16 / 9);
    [w, h] = sizeOf(x, fam, ratio, 32);
    g = P.load('qwen_image21_t2i');
    P.set(g, '459:451', 'unet_name', unet);
    P.set(g, '459:452', 'prompt', prompt);
    P.set(g, '459:452', 'negative_prompt', promptIn.negative || '');
    P.setInputs(g, '459:456', { width: w, height: h });
    P.set(g, '459:458', 'seed', E.seedOf(x));
    if (lora) E.addLora(g, '459:451', lora, '9710');
    save = '461';
    notes.push(E.t(TXT.steps, { n: 8 }));
  } else {
    const img = x.inputs && x.inputs.image && x.inputs.image.abs ? x.inputs.image : null;
    g = P.load(img ? 'flux2_klein9b_edit' : 'flux2_klein9b_t2i');
    P.set(g, '1', 'unet_name', unet);
    P.set(g, '4', 'text', prompt);
    P.set(g, '10', 'noise_seed', E.seedOf(x));
    if (img) {
      E.ranged(x, 0, 0.05)(0, E.t('uploading'));
      P.set(g, '20', 'image', await E.upload(x, img.abs));
      // the image keeps its own ratio: the resolution only sets how many pixels
      const side = Math.max(512, Math.min(MAX_SIDE[fam], Number(x.params.resolution) || 1024));
      P.set(g, '21', 'megapixels', Math.round(((side * side) / 2 ** 20) * 100) / 100);
      const meta = await E.metaOf(x, img).catch(() => null);
      if (meta && meta.w && meta.h) [w, h] = sizeOf(x, fam, meta.w / meta.h, 16);
      notes.push(E.t(TXT.fromImage));
    } else {
      const ratio = E.formatRatio(x.params.format === 'auto' ? '16:9' : x.params.format, null, 16 / 9);
      [w, h] = sizeOf(x, fam, ratio, 16);
      P.setInputs(g, '8', { width: w, height: h });
      P.setInputs(g, '9', { width: w, height: h });
    }
    if (lora) E.addLora(g, '1', lora, '9710');
    save = '13';
    notes.push(E.t(TXT.steps, { n: 4 }));
  }
  P.set(g, save, 'filename_prefix', E.prefix(x, '', 'image'));

  const res = await E.submit(x, g, { range: [0.05, 0.97] });
  const [file] = await E.filesOrThrow(x, res.outputs, save);
  const out = await E.stillTo(x, file.abs, path.join(x.outDir, 'image.png'));
  E.ranged(x, 0.97, 1)(1, E.t('saving'));

  return {
    outputs: { image: { abs: out, kind: 'image', meta: w && h ? { w, h } : null } },
    model: E.labelOf(m, E.t(fam === 'qwen21' ? TXT.qwen21 : TXT.klein)),
    notes: E.notes([w && h ? E.t(TXT.size, { w, h }) : null, ...notes, ...loraNotes,
      E.t(TXT.licence)]),
  };
}

function estimate(x) {
  return x && x.gen && x.gen.key === 'qwen21' ? 0.8 : 0.5;
}

module.exports = { run: E.wrap(run), estimate, FILES: { KLEIN, QWEN21 } };
