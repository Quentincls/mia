'use strict';
// Image from text (« Image depuis un texte »), on this PC, through ComfyUI:
// - FLUX.2 Klein 9B (Black Forest Labs, distilled: 4 steps, cfg 1) — templates image_flux2_klein_text_to_image and,
//   with an image wired, image_flux2_klein_image_edit_9b_distilled (the image as a reference latent: the result keeps
//   its framing and follows the prompt);
// - Qwen-Image 2.1 Turbo (8 steps, cfg 1) — template image_qwen_image_2_1_t2i, without its prompt enhancer; with a
//   layout image wired, its depth (Video Depth Anything Small, gray) guides the composition through the Qwen-Image 2.1
//   Fun ControlNet Union (QwenImageDiffsynthControlnet after the LoRA): the LoRA keeps its style, unlike an img2img;
//   with an image and a mask (« Retoucher une zone »): the image VAE-encoded with the mask as a latent noise mask, the
//   KSampler at « Ampleur du changement » as denoise, then ONLY the zone pasted back on the original through the soft
//   mask (ffmpeg maskedmerge): the rest of the image stays identical to the pixel (the VAE would blur it all).
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
const QWEN21_CN = 'qwen_image_2.1_fun_controlnet_union_int8_convrot.safetensors';
const VDA_SMALL = 'video_depth_anything_vits.pth';
// « Respect du cadrage » → force du guide et fin du guide (part du calcul), les trois dosages essayés le 25/10
const LAYOUT = { strict: [1, 1], balanced: [0.8, 0.6], loose: [0.6, 0.4] };
// « Retoucher une zone » : sous 300 px de côté, la zone est trop petite pour que le modèle y travaille (essai du 25/10 :
// 25 px de pieds ne changeaient pas) — fenêtre carrée de 6 fois la zone (160 px au moins) autour d'elle, agrandie à 1024
const SMALL_ZONE = 300;
const ZOOM_WORK = 1024;

/** La fenêtre carrée { s, x, y } autour d'une petite zone { x, y, w, h } d'une image W × H, dans l'image ; null sinon. */
function zoneWindow(box, W, H) {
  if (!box || !(Math.max(box.w, box.h) < SMALL_ZONE)) return null;
  const s = Math.min(W, H, Math.max(160, Math.round(Math.max(box.w, box.h) * 6)));
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  return { s, x: Math.round(Math.max(0, Math.min(W - s, cx - s / 2))), y: Math.round(Math.max(0, Math.min(H - s, cy - s / 2))) };
}

/**
 * Arguments ffmpeg du recollage : l'original partout, la génération seulement dans la zone, fondue par le masque adouci
 * (blanc = la zone). Fenêtre zoomée : la génération, réduite à la fenêtre, d'abord posée à sa place sur l'original.
 */
function pasteArgs({ img, gen, mask, w, h, win, out }) {
  const genFull = win
    ? `[0:v]format=gbrp,split=2[o][ob];[1:v]scale=${win.s}:${win.s}:flags=lanczos,format=gbrp[gw];[ob][gw]overlay=${win.x}:${win.y},format=gbrp[g];`
    : `[0:v]format=gbrp[o];[1:v]scale=${w}:${h}:flags=lanczos,format=gbrp[g];`;
  return ['-i', img, '-i', gen, '-i', mask, '-filter_complex',
    `${genFull}[2:v]scale=${w}:${h}:flags=bicubic,format=gray,format=gbrp[m];[o][g][m]maskedmerge,format=rgb24`,
    '-frames:v', '1', '-update', '1', out];
}

const TXT = {
  klein: { fr: 'FLUX.2 Klein 9B', en: 'FLUX.2 Klein 9B' },
  qwen21: { fr: 'Qwen-Image 2.1', en: 'Qwen-Image 2.1' },
  noPrompt: { fr: 'Écris la consigne de l’image (en anglais, de préférence).', en: 'Write the image prompt (English works best).' },
  size: { fr: '{w} × {h}.', en: '{w} × {h}.' },
  steps: { fr: '{n} étapes.', en: '{n} steps.' },
  fromImage: { fr: 'Part de ton image : elle garde son cadrage et suit la consigne.', en: 'Starts from your image: it keeps its framing and follows the prompt.' },
  layout: { fr: 'Cadrage suivi (profondeur de ton image, force {s}, jusqu’à {e} % du calcul) ; format de l’image de cadrage.',
    en: 'Layout followed (depth of your image, strength {s}, up to {e}% of the computation); format of the layout image.' },
  layoutNoSize: { fr: 'Cadrage suivi (profondeur de ton image, force {s}, jusqu’à {e} % du calcul).',
    en: 'Layout followed (depth of your image, strength {s}, up to {e}% of the computation).' },
  qwen21Guide: { fr: 'Guide de cadrage Qwen-Image 2.1', en: 'Qwen-Image 2.1 layout guide' },
  zone: { fr: 'Zone refaite (ampleur {d}), puis recollée : le reste de l’image est identique au pixel près.',
    en: 'Zone redone (amount {d}), then pasted back: the rest of the image is identical to the pixel.' },
  zoneSize: { fr: 'Calcul en {w} × {h}, recollé sur l’image d’origine ({ow} × {oh}).', en: 'Computed at {w} × {h}, pasted onto the original image ({ow} × {oh}).' },
  zoneZoom: { fr: 'Petite zone : Mia a zoomé sur une fenêtre de {win} px autour d’elle, calculée en {w} × {h}.',
    en: 'Small zone: Mia zoomed into a {win} px window around it, computed at {w} × {h}.' },
  zoneEmpty: { fr: 'Le masque est vide : peins la zone à changer.', en: 'The mask is empty: paint the zone to change.' },
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
  let paste = null;                       // « Retoucher une zone » : { img, mask, w, h } de l'image d'origine
  if (fam === 'qwen21' && x.inputs && x.inputs.image && x.inputs.image.abs && x.inputs.mask && x.inputs.mask.abs) {
    const img = x.inputs.image, zmask = x.inputs.mask;
    const meta = await E.metaOf(x, img);
    if (!(meta && meta.w > 0 && meta.h > 0)) throw new Error(E.t(TXT.noPrompt));
    // la zone (cœur blanc du masque, à la taille de l'image) : petite → une fenêtre zoomée autour d'elle
    const mm = await E.metaOf(x, zmask).catch(() => null);
    const raw = await E.maskBox(x, zmask.abs);
    if (raw && raw.empty) throw new Error(E.t(TXT.zoneEmpty));
    const sx = mm && mm.w > 0 ? meta.w / mm.w : 1, sy = mm && mm.h > 0 ? meta.h / mm.h : 1;
    const box = raw ? { x: raw.x * sx, y: raw.y * sy, w: raw.w * sx, h: raw.h * sy } : null;
    const win = zoneWindow(box, meta.w, meta.h);
    if (win) {
      w = ZOOM_WORK;
      h = ZOOM_WORK;
    } else {
      // taille de travail : celle de l'image, sur la grille de 32, 4 Mpx au plus
      const k = Math.min(1, Math.sqrt((MAX_SIDE.qwen21 * MAX_SIDE.qwen21) / (meta.w * meta.h)));
      w = E.snap(meta.w * k, 32);
      h = E.snap(meta.h * k, 32);
    }
    const d = Math.max(0.3, Math.min(1, Number(x.params.zoneStrength) || 0.7));
    g = P.load('qwen_image21_t2i');
    P.set(g, '459:451', 'unet_name', unet);
    P.set(g, '459:452', 'prompt', prompt);
    P.set(g, '459:452', 'negative_prompt', promptIn.negative || '');
    P.remove(g, '459:456');
    E.ranged(x, 0, 0.05)(0, E.t('uploading'));
    P.addNode(g, 'LoadImage', { image: await E.upload(x, img.abs) }, '9740');
    P.addNode(g, 'LoadImage', { image: await E.upload(x, zmask.abs) }, '9743');
    let srcImg = ['9740', 0], srcMask = ['9743', 0];
    if (win) {
      // la fenêtre, découpée dans l'image et dans le masque (remis d'abord à la taille de l'image)
      P.addNode(g, 'ImageCrop', { image: ['9740', 0], width: win.s, height: win.s, x: win.x, y: win.y }, '9747');
      P.addNode(g, 'ImageScale', { image: ['9743', 0], upscale_method: 'bilinear', width: meta.w, height: meta.h, crop: 'disabled' }, '9748');
      P.addNode(g, 'ImageCrop', { image: ['9748', 0], width: win.s, height: win.s, x: win.x, y: win.y }, '9749');
      srcImg = ['9747', 0];
      srcMask = ['9749', 0];
    }
    P.addNode(g, 'ImageScale', { image: srcImg, upscale_method: 'lanczos', width: w, height: h, crop: 'disabled' }, '9741');
    P.addNode(g, 'VAEEncode', { pixels: ['9741', 0], vae: ['459:454', 0] }, '9742');
    P.addNode(g, 'ImageScale', { image: srcMask, upscale_method: 'bilinear', width: w, height: h, crop: 'disabled' }, '9744');
    P.addNode(g, 'ImageToMask', { image: ['9744', 0], channel: 'red' }, '9745');
    P.addNode(g, 'SetLatentNoiseMask', { samples: ['9742', 0], mask: ['9745', 0] }, '9746');
    P.setInputs(g, '459:458', { latent_image: ['9746', 0], denoise: d, seed: E.seedOf(x) });
    if (lora) E.addLora(g, '459:451', lora, '9710');
    save = '461';
    paste = { img, mask: zmask, w: meta.w, h: meta.h, win };
    notes.push(E.t(TXT.zone, { d: E.dec(d, 2) }), E.t(TXT.steps, { n: 8 }));
    if (win) notes.push(E.t(TXT.zoneZoom, { win: win.s, w, h }));
  } else if (fam === 'qwen21') {
    const layout = x.inputs && x.inputs.layout && x.inputs.layout.abs ? x.inputs.layout : null;
    const lmeta = layout ? await E.metaOf(x, layout).catch(() => null) : null;
    // avec une image de cadrage, la composition impose son format
    const layoutSized = !!(lmeta && lmeta.w > 0 && lmeta.h > 0);
    const ratio = layoutSized ? E.formatRatio('auto', lmeta, 16 / 9)
      : E.formatRatio(x.params.format === 'auto' ? '16:9' : x.params.format, null, 16 / 9);
    [w, h] = sizeOf(x, fam, ratio, 32);
    g = P.load('qwen_image21_t2i');
    P.set(g, '459:451', 'unet_name', unet);
    P.set(g, '459:452', 'prompt', prompt);
    P.set(g, '459:452', 'negative_prompt', promptIn.negative || '');
    P.setInputs(g, '459:456', { width: w, height: h });
    P.set(g, '459:458', 'seed', E.seedOf(x));
    const tail = lora ? E.addLora(g, '459:451', lora, '9710') : '459:451';
    if (layout) {
      await E.requireModels(x, [['model_patches', QWEN21_CN]], TXT.qwen21Guide);
      E.ranged(x, 0, 0.05)(0, E.t('uploading'));
      const [s, e] = LAYOUT[x.params.layoutFollow] || LAYOUT.balanced;
      P.addNode(g, 'LoadImage', { image: await E.upload(x, layout.abs) }, '9730');
      P.addNode(g, 'LoadVideoDepthAnythingModel', { model: VDA_SMALL }, '9731');
      P.addNode(g, 'VideoDepthAnythingProcess', { vda_model: ['9731', 0], images: ['9730', 0], input_size: 518, max_res: 1280,
        precision: 'fp16' }, '9732');
      P.addNode(g, 'VideoDepthAnythingOutput', { depths: ['9732', 0], colormap: 'gray' }, '9733');
      P.addNode(g, 'ImageScale', { image: ['9733', 0], upscale_method: 'lanczos', width: w, height: h,
        crop: layoutSized ? 'center' : 'disabled' }, '9734');
      P.addNode(g, 'ModelPatchLoader', { name: QWEN21_CN }, '9735');
      // after the LoRA, before the K/V cache: the guide steers the model the LoRA already shaped
      P.insertAfter(g, tail, '9736', { class_type: 'QwenImageDiffsynthControlnet', inputs: { model_patch: ['9735', 0],
        vae: ['459:454', 0], image: ['9734', 0], strength: s, start_percent: 0, end_percent: e } }, { 0: 'model' });
      notes.push(E.t(layoutSized ? TXT.layout : TXT.layoutNoSize, { s: E.dec(s), e: Math.round(e * 100) }));
    }
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

  const res = await E.submit(x, g, { range: [0.05, paste ? 0.93 : 0.97] });
  const [file] = await E.filesOrThrow(x, res.outputs, save);
  let out;
  if (paste) {
    // seule la zone revient de la génération : l'original partout ailleurs, fondu par le masque adouci (blanc = zone)
    out = path.join(x.outDir, 'image.png');
    const { w: ow, h: oh, win } = paste;
    await E.ffmpeg(x, pasteArgs({ img: paste.img.abs, gen: file.abs, mask: paste.mask.abs, w: ow, h: oh, win, out }),
      { what: 'image.png', range: [0.93, 0.98], msg: E.t('saving') });
    if (!win) notes.splice(1, 0, E.t(TXT.zoneSize, { w, h, ow, oh }));
    w = ow;
    h = oh;
  } else out = await E.stillTo(x, file.abs, path.join(x.outDir, 'image.png'));
  E.ranged(x, 0.97, 1)(1, E.t('saving'));

  return {
    outputs: { image: { abs: out, kind: 'image', meta: w && h ? { w, h } : null } },
    model: E.labelOf(m, E.t(fam === 'qwen21' ? TXT.qwen21 : TXT.klein)),
    notes: E.notes([w && h && !paste ? E.t(TXT.size, { w, h }) : null, ...notes, ...loraNotes,
      E.t(TXT.licence)]),
  };
}

function estimate(x) {
  return x && x.gen && x.gen.key === 'qwen21' ? 0.8 : 0.5;
}

module.exports = { run: E.wrap(run), estimate, FILES: { KLEIN, QWEN21 }, zoneWindow, pasteArgs };
