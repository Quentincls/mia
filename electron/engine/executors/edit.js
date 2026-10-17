'use strict';
// Edit an image ("Retoucher une image"): Qwen-Image-Edit 2511 int8 through ComfyUI — tool.recipes.keyframe_qwen.
// "Rapide" = Lightning LoRA, 4 steps, CFG 1 (~15 s); "Qualité" = 40 steps, CFG 4 (~3 min).
// Works at ~1.6 MP in multiples of 16 (944×1664 for 9:16, the lab's size), keeping the input's ratio.
// Character / place LoRA (SPEC §12, Qwen family): after the Lightning switch, so it works in both speeds.
const path = require('node:path');
const P = require('../patch');

const E = P.exec;

const QWEN_INT8 = 'qwen_image_edit_2511_int8_convrot.safetensors';
const AREA = 944 * 1664;

const TXT = {
  model: { fr: 'Qwen Image Edit 2511', en: 'Qwen Image Edit 2511' },
  noPrompt: { fr: 'Écris la consigne de retouche (en anglais, de préférence).', en: 'Write the edit prompt (English works best).' },
  fast: { fr: 'Rapide : 4 étapes.', en: 'Fast: 4 steps.' },
  quality: { fr: 'Qualité : 40 étapes.', en: 'Quality: 40 steps.' },
  size: { fr: 'Taille de travail {w} × {h}.', en: 'Working size {w} × {h}.' },
  ref: { fr: 'Image de référence utilisée.', en: 'Reference image used.' },
};

/** ~1.6 MP, input ratio, multiples of 16. */
function workSize(w, h) {
  if (!w || !h) return [944, 1664];
  const r = w / h;
  return [E.snap(Math.sqrt(AREA * r), 16), E.snap(Math.sqrt(AREA / r), 16)];
}

async function run(x) {
  E.begin(x);
  const img = E.input(x, 'image');
  const ref = E.input(x, 'ref', false);
  const promptIn = E.promptOf(x);
  const { negative } = promptIn;
  if (!promptIn.prompt) throw new Error(E.t(TXT.noPrompt));
  const loraNotes = [];
  const lora = await E.lora(x, 'qwen');
  const prompt = E.loraPrompt(promptIn.prompt, lora, loraNotes);

  const meta = await E.metaOf(x, img);
  const [w, h] = workSize(meta.w, meta.h);
  const fast = x.params.speed !== 'quality';
  const m = E.model(x, 'model');
  const unet = E.modelFile(x, 'model', QWEN_INT8);

  E.ranged(x, 0, 0.05)(0, E.t('uploading'));
  const up = await E.upload(x, img.abs);
  const upRef = ref && ref.abs ? await E.upload(x, ref.abs) : null;

  const g = P.load('qwen_edit_2511');
  P.set(g, '41', 'image', up);
  P.setInputs(g, '170:160', { width: w, height: h });
  P.set(g, '170:161', 'unet_name', unet);
  P.set(g, '170:151', 'prompt', prompt);
  P.set(g, '170:149', 'prompt', negative);
  P.set(g, '170:169', 'seed', E.seedOf(x));
  P.set(g, '170:168', 'value', fast);          // switches LoRA, steps and CFG together
  if (lora) E.addLora(g, '170:163', lora, '9710');
  if (upRef) {
    // second picture of the encoder ("Picture 2"); it rescales it itself, on both prompts like the template
    P.addNode(g, 'LoadImage', { image: upRef }, '42');
    P.set(g, '170:151', 'image2', ['42', 0]);
    P.set(g, '170:149', 'image2', ['42', 0]);
  }
  P.set(g, '195', 'filename_prefix', E.prefix(x, '', 'image'));

  const res = await E.submit(x, g, { range: [0.05, 0.97] });
  const [file] = await E.filesOrThrow(x, res.outputs, '195');
  const out = await E.stillTo(x, file.abs, path.join(x.outDir, 'image.png'));
  E.ranged(x, 0.97, 1)(1, E.t('saving'));

  return {
    outputs: { image: { abs: out, kind: 'image', meta: { w, h } } },
    model: E.labelOf(m, E.t(TXT.model)),
    notes: E.notes([E.t(fast ? TXT.fast : TXT.quality), E.t(TXT.size, { w, h }), upRef ? E.t(TXT.ref) : null, ...loraNotes]),
  };
}

function estimate(x) {
  return x.params && x.params.speed === 'quality' ? 3.5 : 0.4;
}

module.exports = { run: E.wrap(run), estimate };
