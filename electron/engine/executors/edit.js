'use strict';
// Edit an image ("Retoucher une image"): Qwen-Image-Edit 2511 int8 through ComfyUI — tool.recipes.keyframe_qwen.
// "Rapide" = Lightning LoRA, 4 steps, CFG 1 (~15 s); "Qualité" = 40 steps, CFG 4 (~3 min).
// Works at ~1.6 MP in multiples of 16 (944×1664 for 9:16, the lab's size), keeping the input's ratio.
// Character / place LoRA (SPEC §12, Qwen family): after the Lightning switch, so it works in both speeds.
// Up to 2 helper images (an outfit, an object, a style): the encoder's Picture 2 and Picture 3, in wire order; the
// image to edit is Picture 1. « image 2 » in the prompt becomes "Picture 2", the words the model was trained on.
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
  ref: { fr: 'Image d’appui utilisée.', en: 'Helper image used.' },
  refs: { fr: '{n} images d’appui utilisées (images 2 à {last}).', en: '{n} helper images used (images 2 to {last}).' },
  tooMany: { fr: '{n} images d’appui branchées : 2 au plus.', en: '{n} helper images wired: 2 at most.' },
  cited: {
    fr: 'La consigne cite « image {n} », mais il n’y a que {count} image(s) : l’image à retoucher et {refs} image(s) d’appui.',
    en: 'The prompt names “image {n}”, but there are only {count} image(s): the image to edit and {refs} helper image(s).',
  },
};

/** « image 2 » / « photo n°3 » / "picture 2" -> "Picture 2" (Qwen's own words). Returns { text, cited:Set }. */
function tagPictures(prompt) {
  const cited = new Set();
  const end = String.raw`(?![\p{L}\p{N}_>])(?!\s*(?:s|sec|px|%|fps)(?![\p{L}]))`;
  const text = String(prompt || '').replace(
    new RegExp(String.raw`(?<![<\p{L}\p{N}_])(?:images?|img|pictures?|photos?)\s*(?:n\s*[°o]\s*)?([1-9])${end}`, 'giu'),
    (_, n) => { cited.add(Number(n)); return `Picture ${Number(n)}`; });
  return { text, cited };
}

/** ~1.6 MP, input ratio, multiples of 16. */
function workSize(w, h) {
  if (!w || !h) return [944, 1664];
  const r = w / h;
  return [E.snap(Math.sqrt(AREA * r), 16), E.snap(Math.sqrt(AREA / r), 16)];
}

async function run(x) {
  E.begin(x);
  const img = E.input(x, 'image');
  const raw = x.inputs ? x.inputs.ref : null;
  const refs = (Array.isArray(raw) ? raw : (raw ? [raw] : [])).filter((r) => r && r.abs);
  if (refs.length > 2) throw new Error(E.t(TXT.tooMany, { n: refs.length }));
  const promptIn = E.promptOf(x);
  const { negative } = promptIn;
  if (!promptIn.prompt) throw new Error(E.t(TXT.noPrompt));
  // « image 2 » -> Picture 2 only when helper images are wired (a lone « image 1 » is the image itself)
  const tagged = refs.length ? tagPictures(promptIn.prompt) : { text: promptIn.prompt, cited: new Set() };
  for (const n of tagged.cited) {
    if (n > refs.length + 1) throw new Error(E.t(TXT.cited, { n, count: refs.length + 1, refs: refs.length }));
  }
  const loraNotes = [];
  const lora = await E.lora(x, 'qwen');
  const prompt = E.loraPrompt(tagged.text, lora, loraNotes);

  const meta = await E.metaOf(x, img);
  const [w, h] = workSize(meta.w, meta.h);
  const fast = x.params.speed !== 'quality';
  const m = E.model(x, 'model');
  const unet = E.modelFile(x, 'model', QWEN_INT8);

  E.ranged(x, 0, 0.05)(0, E.t('uploading'));
  const up = await E.upload(x, img.abs);
  const upRefs = [];
  for (const r of refs) upRefs.push(await E.upload(x, r.abs));

  const g = P.load('qwen_edit_2511');
  P.set(g, '41', 'image', up);
  P.setInputs(g, '170:160', { width: w, height: h });
  P.set(g, '170:161', 'unet_name', unet);
  P.set(g, '170:151', 'prompt', prompt);
  P.set(g, '170:149', 'prompt', negative);
  P.set(g, '170:169', 'seed', E.seedOf(x));
  P.set(g, '170:168', 'value', fast);          // switches LoRA, steps and CFG together
  if (lora) E.addLora(g, '170:163', lora, '9710');
  upRefs.forEach((name, i) => {
    // pictures 2 and 3 of the encoder; it rescales them itself, on both prompts like the template
    const id = String(42 + i);
    P.addNode(g, 'LoadImage', { image: name }, id);
    P.set(g, '170:151', `image${i + 2}`, [id, 0]);
    P.set(g, '170:149', `image${i + 2}`, [id, 0]);
  });
  P.set(g, '195', 'filename_prefix', E.prefix(x, '', 'image'));

  const res = await E.submit(x, g, { range: [0.05, 0.97] });
  const [file] = await E.filesOrThrow(x, res.outputs, '195');
  const out = await E.stillTo(x, file.abs, path.join(x.outDir, 'image.png'));
  E.ranged(x, 0.97, 1)(1, E.t('saving'));

  return {
    outputs: { image: { abs: out, kind: 'image', meta: { w, h } } },
    model: E.labelOf(m, E.t(TXT.model)),
    notes: E.notes([E.t(fast ? TXT.fast : TXT.quality), E.t(TXT.size, { w, h }),
      upRefs.length === 1 ? E.t(TXT.ref) : upRefs.length > 1 ? E.t(TXT.refs, { n: upRefs.length, last: upRefs.length + 1 }) : null,
      ...loraNotes]),
  };
}

function estimate(x) {
  return x.params && x.params.speed === 'quality' ? 3.5 : 0.4;
}

module.exports = { run: E.wrap(run), estimate, _tagPictures: tagPictures };
