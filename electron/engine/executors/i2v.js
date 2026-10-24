'use strict';
// Animate an image ("Animer une image"): a start image (+ optional end image) becomes a short video.
//   LTX-2.5 (default): a 23-node single-stage graph (adapted from one of the author's tests),
//     end image = LTXVAddGuide at frame -1 + LTXVCropGuides before decoding. Sound is generated too.
//     Reference sheet (« Fiche de référence », SPEC §17) = the official LTX IC-LoRA « Ingredients »
//     (the official template_ltx2_3_ic_lora_ingredients): the sheet is fitted to the
//     frame (padded, never cropped), looped over the whole shot and given as an IC-LoRA guide at frame 0.
//   MiniMax H3 (when chosen): first + last frame, turbo 8 steps, 24 fps (adapted from one of the author's tests).
//     The sheet is ignored with MiniMax (note).
//   Keyframes (« Images-clés », Model block): up to 4 images the shot passes through, spread evenly between the first
//     and the last frame in wire order — MiniMaxH3AddGuide (MiniMax, checked on the GPU 24/10: same framing as the
//     start image or the shot cuts to it) / LTXVAddGuide (LTX, « à essayer »).
//   MiniMax only (Model block): a sound to follow (MiniMaxH3AddGuide audio at frame 0, « à essayer ») and
//     « Prolonger une vidéo » (checked on the GPU 24/10: invisible join): the last 39 frames of the video (with their sound) are anchored at frame 0, the model
//     carries the shot on, and the result is the whole video made longer (original + what comes after).
//   LTX extras (Model block, « à essayer »). « Deux passes » is hidden (not in the catalog: the 24/10 GPU test was
//     less sharp than one pass) but kept for later tuning: for final renders = the shot made at half size, its video
//     latent enlarged ×2 by the LTX latent upscaler, the start image and guides put back at full size and 3 refining
//     steps (the official distilled second stage); « Enrichir la consigne » = Gemma rewrites the prompt first.
//   Character / place LoRA (SPEC §12): after the technical LoRAs, its trigger word put first in the prompt.
// Preview = low resolution and at most 3 s; final = full size. Frames come back as PNG and are encoded once.
const path = require('node:path');
const P = require('../patch');

const E = P.exec;

const LTX_INT8 = 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors';
const MINIMAX_INT8 = 'minimax_h3_fl2va_pruned_int8_convrot.safetensors';
const INGREDIENTS = 'ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors';
const PREVIEW_MAX_S = 3;
const GUIDE_PASSTHROUGH = { 0: 'positive', 1: 'negative', 2: 'latent' };

// Size = the block's format (16:9, 9:16, 1:1… or « comme l'image de début ») at its resolution (short side).
// LTX: generated on the 32-px grid just above and cropped back to the exact size (1088 → 1080, as the lab does);
// MiniMax: nearest 32-px size, at most 704×1248 (768×1344, its native canvas, at « 768p »). Preview: short side
// capped, 3 s at most.
const LTX_MAX_PIXELS = 2.2e6;          // ≈ 1088×1920, the lab's largest LTX shot on the laptop
const SHEET_TOKENS = 17000;
const MAX_KEYS = 4;
const EXTEND_TAIL = 39;                // frames of the video anchored when extending (17k+5: 1,6 s at 24 fps)            // with a reference sheet: video tokens (latent frames × 32-px patches) at most

const TXT = {
  ltx: { fr: 'LTX 2.5', en: 'LTX 2.5' },
  minimax: { fr: 'MiniMax H3', en: 'MiniMax H3' },
  size: { fr: '{w} × {h}, {frames} images à {fps} i/s ({s} s).', en: '{w} × {h}, {frames} frames at {fps} fps ({s} s).' },
  previewNote: { fr: 'Aperçu : basse définition, 3 s au plus.', en: 'Preview: low resolution, 3 s at most.' },
  endTip: {
    fr: 'Image de fin posée sur la dernière image : vérifie que la fin du plan ne se fige pas.',
    en: 'End image pinned to the last frame: check that the end of the shot does not freeze.',
  },
  sheet: {
    fr: 'Fiche de référence suivie sur tout le plan (un peu plus long à calculer).',
    en: 'Reference sheet followed through the whole shot (a little slower).',
  },
  sheetRes: {
    fr: 'Avec une fiche de référence, taille ramenée à {w} × {h} pour tenir en mémoire.',
    en: 'With a reference sheet, size reduced to {w} × {h} to fit in memory.',
  },
  sheetSkipped: {
    fr: 'La fiche de référence ne marche qu’avec LTX : ignorée avec MiniMax H3.',
    en: 'The reference sheet only works with LTX: ignored with MiniMax H3.',
  },
  fpsForced: { fr: 'MiniMax H3 travaille à 24 i/s.', en: 'MiniMax H3 works at 24 fps.' },
  durCapped: { fr: '{name} va jusqu’à {n} s : vidéo de {n} s.', en: '{name} goes up to {n} s: a {n} s video.' },
  textOnly: { fr: 'MiniMax H3 à partir du texte seul, sans image de début.', en: 'MiniMax H3 from text alone, no start image.' },
  keys: { fr: '{n} image(s)-clé(s) aux images {list}.', en: '{n} keyframe(s) at frames {list}.' },
  keysTrial: {
    fr: '{n} image(s)-clé(s) aux images {list} (à essayer : regarde si le plan passe bien par elles).',
    en: '{n} keyframe(s) at frames {list} (to try: check that the shot really passes through them).',
  },
  follow: {
    fr: 'Son suivi depuis le début du plan (à essayer : regarde si la vidéo se cale dessus).',
    en: 'Sound followed from the start of the shot (to try: check that the video locks onto it).',
  },
  extend: {
    fr: 'Prolongement : MiniMax reprend les {tail} s de fin de la vidéo et continue sur {s} s. Vidéo entière : {total} s.',
    en: 'Extension: MiniMax picks up the last {tail} s of the video and carries on for {s} s. Whole video: {total} s.',
  },
  tooShort: { fr: 'La vidéo à prolonger est trop courte (moins de 0,2 s).', en: 'The video to extend is too short (under 0.2 s).' },
  minimaxRes: { fr: 'MiniMax H3 travaille jusqu’à 768p : taille ramenée.', en: 'MiniMax H3 works up to 768p: size reduced.' },
  defaultPrompt: {
    fr: 'Cinematic live-action shot, the scene comes alive with natural motion, steady camera, realistic light.',
    en: 'Cinematic live-action shot, the scene comes alive with natural motion, steady camera, realistic light.',
  },
};
const NEGATIVE = 'text, watermark, subtitles, cut, blurry, distorted faces, deformed hands, static image, no motion';

const listOf = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).filter((r) => r && r.abs);

/** Frames of the video to extend at 24 fps, and how many of its last ones are anchored (17k+5, 5 at least). */
function tailOf(meta) {
  const n24 = Math.round(((Number(meta && meta.frames) || 0) / (Number(meta && meta.fps) || 24)) * 24);
  let tail = Math.min(EXTEND_TAIL, n24);
  while (tail >= 5 && tail % 17 !== 5) tail--;
  return { n24, tail: tail >= 5 ? tail : 0 };
}

/** Keyframe positions: evenly spread strictly between the first and the last frame. */
function keyFrames(frames, n) {
  return Array.from({ length: n }, (_, i) => Math.round(((i + 1) * (frames - 1)) / (n + 1)));
}

function plan(x, vmeta = null) {
  const m = E.model(x, 'model');
  const mm = E.isMinimax(m);
  const preview = x.mode === 'preview';
  const start = x.inputs && x.inputs.start;
  const video = mm && x.inputs && x.inputs.video && x.inputs.video.abs ? x.inputs.video : null;
  const vm = video ? (vmeta || video.meta || {}) : null;
  const sheet = !mm && !!(x.inputs && x.inputs.sheet && x.inputs.sheet.abs);
  // two passes: final LTX renders without a sheet; both stages on LTX's grid, so the full size is a multiple of 64
  const twoPassAsked = !mm && !preview && x.params.twoPass === true;
  const twoPass = twoPassAsked && !sheet;
  // an extension keeps the video's own frame shape
  const ratio = vm && vm.w > 0 && vm.h > 0 ? vm.w / vm.h : E.formatRatio(x.params.format, start && start.meta);
  // the longest shot the model is trusted with (SPEC §22: LTX 10 s, MiniMax H3 15 s); the block shows the same bound
  const durMax = E.maxSeconds(m, mm ? 'minimax' : 'ltx');
  const dur = Math.max(1, Math.min(durMax, Number(x.params.duration) || 5));
  const seconds = preview ? Math.min(dur, PREVIEW_MAX_S) : dur;
  const asked = E.int(x.params.fps, 24);
  const fps = mm ? 24 : ([24, 25, 30].includes(asked) ? asked : 24);
  // extension: the anchored tail plus the asked duration, within the model's 15 s
  const ext = video ? tailOf(vm) : null;
  const newS = ext ? Math.max(1, Math.min(seconds, durMax - ext.tail / 24)) : seconds;
  const frames = mm ? E.minimaxLength(ext ? ext.tail / 24 + newS : seconds, preview) : E.ltxFrames(fps, seconds);
  const keys = Math.min(MAX_KEYS, listOf(x.inputs && x.inputs.keys).length);
  const askedShort = E.shortSide(x, { preview, previewCap: mm ? 448 : 576 });
  const mmc = mm ? E.minimaxCanvas(x, { preview, previewCap: 448 }) : null;
  const short = mm ? mmc.short : askedShort;
  // the looped sheet doubles the video tokens: keep the total near the lab's largest shot (1088×1920×121)
  const sheetMax = sheet ? (SHEET_TOKENS * 1024) / (Math.floor((frames - 1) / 8) + 1) : Infinity;
  const maxPixels = mm ? mmc.maxPixels : Math.min(LTX_MAX_PIXELS, sheetMax);
  const size = E.videoSize({ ratio, short, exact: !mm, maxPixels, mult: twoPass ? 64 : 32 });
  const { w, h } = size;
  const free = E.videoSize({ ratio, short, exact: !mm, maxPixels: mm ? mmc.maxPixels : LTX_MAX_PIXELS });
  return { m, mm, preview, sheet, w, h, ow: size.ow, oh: size.oh, crop: size.crop, fps, frames, asked, durMax, ext, keys,
    twoPass, twoPassSheet: twoPassAsked && sheet, enhance: !mm && x.params.enhance === true,
    durCapped: (Number(x.params.duration) || 5) > durMax,
    capped: mm && mmc.capped, native: mm && mmc.native, sheetCapped: sheet && free.w * free.h > w * h };
}

async function run(x) {
  const temps = [];                    // _files of this run (sound to follow, video to extend), always removed
  try { return await animate(x, temps); } finally { await E.cleanup(temps); }
}

async function animate(x, temps) {
  E.begin(x);
  // MiniMax H3 can start from text alone (first_frame is optional in MiniMaxH3ImageToVideo): the Model block's
  // « Vidéo depuis un texte » with MiniMax comes here without a start image (SPEC §23). LTX always needs one.
  const isMm = E.isMinimax(E.model(x, 'model'));
  const textOnly = isMm && !(x.inputs && x.inputs.start && x.inputs.start.abs);
  const start = textOnly ? null : E.input(x, 'start');
  const end = textOnly ? null : E.input(x, 'end', false);
  const sheet = E.input(x, 'sheet', false);
  const keys = listOf(x.inputs && x.inputs.keys).slice(0, MAX_KEYS);
  const follow = isMm && x.inputs && x.inputs.audio && x.inputs.audio.abs ? x.inputs.audio : null;
  const video = isMm && x.inputs && x.inputs.video && x.inputs.video.abs ? x.inputs.video : null;
  const vmeta = video ? await E.metaOf(x, video) : null;
  const pl = plan(x, vmeta);
  if (video && !pl.ext.tail) throw new Error(E.t(TXT.tooShort));
  const { m, mm, w, h, fps, frames } = pl;
  const notes = [];
  let { prompt, negative } = E.promptOf(x);
  if (!prompt) prompt = E.t(TXT.defaultPrompt);
  if (!negative) negative = NEGATIVE;

  // character / place LoRA of the model's family (a mismatch stops here, before any upload)
  const lora = await E.lora(x, mm ? 'minimax' : 'ltx');
  prompt = E.loraPrompt(prompt, lora, notes);

  E.ranged(x, 0, 0.05)(0, E.t('uploading'));
  const upStart = start ? await E.upload(x, start.abs) : null;
  const upEnd = end && end.abs ? await E.upload(x, end.abs) : null;
  const upSheet = sheet && sheet.abs && !mm ? await E.upload(x, sheet.abs) : null;
  if (sheet && sheet.abs && mm) notes.push(E.t(TXT.sheetSkipped));
  const upKeys = [];
  for (const k of keys) upKeys.push(await E.upload(x, k.abs));
  const at = keyFrames(frames, upKeys.length);
  if (upKeys.length) notes.push(E.t(mm ? TXT.keys : TXT.keysTrial, { n: upKeys.length, list: at.join(', ') }));
  // the sound to follow, cut to the shot's length; the video to extend, at 24 fps and the shot's size, and its tail
  let upFollow = null;
  if (follow) {
    const dst = E.tmp(x, 'follow.flac');
    temps.push(dst);
    await E.ffmpeg(x, ['-i', follow.abs, '-vn', '-t', (frames / 24).toFixed(3), '-ac', '2', '-c:a', 'flac', dst],
      { what: path.basename(dst), range: [0.02, 0.03], msg: E.t('uploading') });
    upFollow = await E.upload(x, dst);
    notes.push(E.t(TXT.follow));
  }
  let ext = null;
  if (video) {
    const src = E.tmp(x, 'extend_source.mp4');
    const tailDst = E.tmp(x, 'extend_tail.mp4');
    temps.push(src, tailDst);
    const audio = vmeta.hasAudio === true;
    await E.prepVideo(x, video, src, { fps: 24, frames: pl.ext.n24, srcFps: vmeta.fps || 24, audio,
      vf: `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`, range: [0.01, 0.03] });
    await E.prepVideo(x, { abs: src }, tailDst, { start: pl.ext.n24 - pl.ext.tail, frames: pl.ext.tail, srcFps: 24, audio,
      range: [0.03, 0.04] });
    ext = { src, audio, name: await E.upload(x, tailDst) };
  }

  let g;
  let enhanceId = null;
  if (mm) {
    g = P.load('minimax_i2v');
    P.set(g, '1', 'unet_name', (m && m.comfy && m.comfy.name) || MINIMAX_INT8);
    if (upStart) {
      P.set(g, '6', 'image', upStart);
      P.setInputs(g, '18', { width: w, height: h });
    } else {
      // text only (or an extension): no start image at all (the node's first_frame is optional)
      delete g['6'];
      delete g['18'];
      delete g['8'].inputs.first_frame;
      if (!ext) notes.push(E.t(TXT.textOnly));
    }
    // guides chained on the positive conditioning: keyframes, the sound to follow, the extended video's tail
    let pos = ['8', 0];
    const guide = (id, inputs) => {
      P.addNode(g, 'MiniMaxH3AddGuide', { positive: pos, latent: ['8', 1], ...inputs }, id);
      pos = [id, 0];
    };
    upKeys.forEach((name, i) => {
      P.addNode(g, 'LoadImage', { image: name }, String(50 + i));
      guide(String(60 + i), { vae: ['4', 0], image: [String(50 + i), 0], frame_idx: at[i] });
    });
    if (upFollow) {
      P.addNode(g, 'LoadAudio', { audio: upFollow }, '70');
      guide('71', { audio_vae: ['5', 0], audio: ['70', 0], frame_idx: 0 });
    }
    if (ext) {
      P.addNode(g, 'LoadVideo', { file: ext.name }, '80');
      P.addNode(g, 'GetVideoComponents', { video: ['80', 0] }, '81');
      guide('82', { vae: ['4', 0], image: ['81', 0], frame_idx: 0, ...(ext.audio ? { audio_vae: ['5', 0], audio: ['81', 1] } : {}) });
    }
    if (pos[0] !== '8') P.set(g, '12', 'conditioning', pos);
    P.setInputs(g, '8', { prompt, width: w, height: h, length: frames });
    P.set(g, '9', 'noise_seed', E.seedOf(x));
    if (upEnd) {
      P.addNode(g, 'LoadImage', { image: upEnd }, '7');
      P.addNode(g, 'ImageScale', { upscale_method: 'lanczos', width: w, height: h, crop: 'center', image: ['7', 0] }, '19');
      P.set(g, '8', 'last_frame', ['19', 0]);
    }
    if (lora) E.addLora(g, '2', lora, '40');            // after the turbo LoRA
    if (pl.asked !== 24) notes.push(E.t(TXT.fpsForced));
    if (pl.capped) notes.push(E.t(TXT.minimaxRes));
    if (pl.native) notes.push(E.t('minimax768'));
  } else {
    g = P.load('ltx_i2v');
    const unet = (m && m.comfy && m.comfy.name && /ltx/i.test(m.comfy.name)) ? m.comfy.name : LTX_INT8;
    P.set(g, '1', 'unet_name', unet);
    P.set(g, '5', 'text', prompt);
    P.set(g, '6', 'text', negative);
    P.set(g, '7', 'frame_rate', fps);
    P.set(g, '8', 'image', upStart);
    P.setInputs(g, '24', { width: w, height: h });
    P.setInputs(g, '10', { width: w, height: h, length: frames });
    P.setInputs(g, '12', { frames_number: frames, frame_rate: fps });
    P.set(g, '14', 'noise_seed', E.seedOf(x));
    if (pl.enhance) enhanceId = E.ltxEnhance(g, { clip: ['2', 0], prompt, encode: '5', image: ['24', 0], seed: E.seedOf(x) });

    // model chain: UNET -> [Ingredients IC-LoRA] -> [character LoRA]
    let modelTail = '1';
    if (upSheet) {
      P.insertAfter(g, '1', '41', { class_type: 'LTXICLoRALoaderModelOnly',
        inputs: { lora_name: INGREDIENTS, strength_model: 1 } }, { 0: 'model' });
      modelTail = '41';
    }
    if (lora) E.addLora(g, modelTail, lora, '40');

    // guide chain on (positive, negative, video latent): [end image at -1] -> [sheet at 0]
    let guide = null;                                   // id of the last guide node
    const chain = (id, node) => {
      const from = guide || null;
      node.inputs.positive = from ? [from, 0] : ['7', 0];
      node.inputs.negative = from ? [from, 1] : ['7', 1];
      node.inputs.latent = from ? [from, 2] : ['11', 0];
      g[id] = node;
      guide = id;
    };
    if (upEnd) {
      // essai_sortie_ecran.py: the end image guides the latent at frame -1, guides cropped before decoding
      P.addNode(g, 'LoadImage', { image: upEnd }, '30');
      P.addNode(g, 'ImageScale', { upscale_method: 'lanczos', width: w, height: h, crop: 'center', image: ['30', 0] }, '33');
      chain('31', { class_type: 'LTXVAddGuide', inputs: { vae: ['3', 0], image: ['33', 0], frame_idx: -1, strength: 1 } });
    }
    upKeys.forEach((name, i) => {
      // a keyframe: the same guide as the end image, at its frame (a single image may sit on any frame)
      P.addNode(g, 'LoadImage', { image: name }, String(50 + i));
      P.addNode(g, 'ImageScale', { upscale_method: 'lanczos', width: w, height: h, crop: 'center', image: [String(50 + i), 0] },
        String(55 + i));
      chain(String(60 + i), { class_type: 'LTXVAddGuide', inputs: { vae: ['3', 0], image: [String(55 + i), 0], frame_idx: at[i], strength: 1 } });
    });
    if (upSheet) {
      // official Ingredients workflow: sheet fitted (padded black) to the frame, looped over the clip, guide at 0
      P.addNode(g, 'LoadImage', { image: upSheet }, '34');
      P.addNode(g, 'ResizeAndPadImage', { image: ['34', 0], target_width: w, target_height: h,
        padding_color: 'black', interpolation: 'lanczos' }, '35');
      P.addNode(g, 'RepeatImageBatch', { image: ['35', 0], amount: frames }, '36');
      chain('37', { class_type: 'LTXAddVideoICLoRAGuide', inputs: { vae: ['3', 0], image: ['36', 0], frame_idx: 0,
        strength: 1, latent_downscale_factor: ['41', 1], crop: 'disabled', use_tiled_encode: false,
        tile_size: 256, tile_overlap: 64 } });
      notes.push(E.t(TXT.sheet));
      if (pl.sheetCapped) notes.push(E.t(TXT.sheetRes, { w: pl.ow, h: pl.oh }));
    }
    if (guide) {
      P.set(g, '13', 'video_latent', [guide, 2]);
      P.setInputs(g, '15', { positive: [guide, 0], negative: [guide, 1] });
      P.addNode(g, 'LTXVCropGuides', { positive: [guide, 0], negative: [guide, 1], latent: ['19', 0] }, '32');
      P.set(g, '20', 'samples', ['32', 2]);
    }
    if (pl.twoPass) {
      // stage 1 at half size -> its video latent ×2 -> start image and guides again at full size -> 3 refining steps
      P.setInputs(g, '10', { width: w / 2, height: h / 2 });
      P.addNode(g, 'LatentUpscaleModelLoader', { model_name: E.LTX_UPSCALER }, '90');
      P.addNode(g, 'LTXVLatentUpsampler', { samples: guide ? ['32', 2] : ['19', 0], upscale_model: ['90', 0], vae: ['3', 0] }, '91');
      P.addNode(g, 'LTXVImgToVideoInplace', { strength: 1, bypass: false, vae: ['3', 0], image: ['9', 0], latent: ['91', 0] }, '92');
      let g2 = null;
      const chain2 = (id, image, frame) => {
        P.addNode(g, 'LTXVAddGuide', { positive: g2 ? [g2, 0] : ['7', 0], negative: g2 ? [g2, 1] : ['7', 1],
          latent: g2 ? [g2, 2] : ['92', 0], vae: ['3', 0], image, frame_idx: frame, strength: 1 }, id);
        g2 = id;
      };
      if (upEnd) chain2('93', ['33', 0], -1);
      upKeys.forEach((_, i) => chain2(String(110 + i), [String(55 + i), 0], at[i]));
      P.addNode(g, 'LTXVConcatAVLatent', { video_latent: g2 ? [g2, 2] : ['92', 0], audio_latent: ['19', 1] }, '96');
      P.addNode(g, 'RandomNoise', { noise_seed: E.seedOf(x) + 1 }, '97');
      P.addNode(g, 'CFGGuider', { cfg: 1, model: g['15'].inputs.model, positive: g2 ? [g2, 0] : ['7', 0],
        negative: g2 ? [g2, 1] : ['7', 1] }, '98');
      P.addNode(g, 'ManualSigmas', { sigmas: E.LTX_STAGE2_SIGMAS }, '100');
      P.addNode(g, 'SamplerCustomAdvanced', { noise: ['97', 0], guider: ['98', 0], sampler: ['16', 0], sigmas: ['100', 0],
        latent_image: ['96', 0] }, '101');
      P.addNode(g, 'LTXVSeparateAVLatent', { av_latent: ['101', 0] }, '102');
      let video = ['102', 0];
      if (g2) {
        P.addNode(g, 'LTXVCropGuides', { positive: [g2, 0], negative: [g2, 1], latent: ['102', 0] }, '103');
        video = ['103', 2];
      }
      P.set(g, '20', 'samples', video);
      P.set(g, '21', 'samples', ['102', 1]);
      notes.push(E.t('twoPass', { w1: w / 2, h1: h / 2 }));
    }
    if (pl.twoPassSheet) notes.push(E.t('twoPassSheet'));
  }
  if (upEnd && !mm) notes.push(E.t(TXT.endTip));
  if (pl.durCapped) notes.push(E.t(TXT.durCapped, { name: E.t(mm ? TXT.minimax : TXT.ltx), n: pl.durMax }));
  P.set(g, '9990', 'filename_prefix', E.prefix(x, '', 'frame'));
  P.set(g, '9991', 'filename_prefix', E.prefix(x, '', 'audio'));

  const res = await E.submit(x, g, { range: [0.05, 0.92] });
  if (enhanceId) {
    const text = E.enhancedText(res, enhanceId);
    notes.push(text ? E.t('enhanced', { text: text.length > 400 ? `${text.slice(0, 400)}…` : text }) : E.t('enhancedNone'));
  }
  const shots = (await E.filesOrThrow(x, res.outputs, '9990')).map((f) => f.abs);
  const sound = (await E.files(x, res.outputs, '9991'))[0];

  const final = path.join(x.outDir, 'video.mp4');
  let out;
  let total = shots.length;
  if (!ext) {
    out = await E.framesToVideo(x, shots, final, {
      fps, vf: pl.crop, audio: sound ? sound.abs : null, range: [0.92, 1], msg: E.t('encoding'),
    });
  } else {
    // the new part starts after the anchored tail: original video + generated frames from `tail` on
    const genMp4 = E.tmp(x, 'extend_new.mp4');
    temps.push(genMp4);
    await E.framesToVideo(x, shots, genMp4, { fps: 24, audio: sound ? sound.abs : null, range: [0.92, 0.96], msg: E.t('encoding'), kind: 'inter' });
    const T = pl.ext.tail;
    total = pl.ext.n24 + Math.max(0, shots.length - T);
    const before = ['-i', ext.src, '-i', genMp4];
    const stereo = 'aresample=48000,aformat=channel_layouts=stereo';
    let complex = `[0:v]setsar=1[v0];[1:v]trim=start_frame=${T},setpts=PTS-STARTPTS,setsar=1[v1];[v0][v1]concat=n=2:v=1:a=0[v]`;
    const after = [];
    if (sound) {
      if (!ext.audio) before.push('-f', 'lavfi', '-t', (pl.ext.n24 / 24).toFixed(4), '-i', 'anullsrc=r=48000:cl=stereo');
      complex += `;${ext.audio ? '[0:a]' : '[2:a]'}${stereo}[a0];[1:a]atrim=start=${(T / 24).toFixed(4)},asetpts=PTS-STARTPTS,${stereo}[a1];[a0][a1]concat=n=2:v=0:a=1[a]`;
      after.push('-filter_complex', complex, '-map', '[v]', '-map', '[a]', '-c:a', 'aac', '-b:a', '192k');
    } else after.push('-filter_complex', complex, '-map', '[v]', '-an');
    after.push('-frames:v', String(total), '-r', '24', '-movflags', '+faststart');
    await E.encode(x, before, after, final, { what: 'video.mp4', duration: total / 24, range: [0.96, 1], msg: E.t('encoding') });
    out = final;
    notes.push(E.t(TXT.extend, { tail: E.dec(T / 24), s: E.dec(Math.max(0, shots.length - T) / 24), total: E.dec(total / 24) }));
  }
  const { ow, oh } = pl;

  if (pl.preview) notes.push(E.t(TXT.previewNote));
  notes.unshift(E.t(TXT.size, { w: ow, h: oh, frames: total, fps, s: E.dec(total / fps) }));
  return {
    outputs: { video: { abs: out, kind: 'video', meta: { w: ow, h: oh, fps, frames: total } } },
    model: E.labelOf(m, E.t(mm ? TXT.minimax : TXT.ltx)),
    notes: E.notes(notes),
  };
}

function estimate(x) {
  try {
    const { mm, preview, sheet, w, h, frames, twoPass, enhance } = plan(x);
    // MiniMax: 704×1248×56 in ~2 min, ×124 in ~5 min 17 (lab)
    if (mm) return preview ? 1.5 : 0.6 + 2.2 * (frames / 56) * ((w * h) / (704 * 1248));
    // two passes: 8 steps at a quarter of the pixels, then 3 at full size; Gemma's rewrite ~ half a minute
    if (twoPass) return E.ltxMinutes(w / 2, h / 2, frames) + E.ltxMinutes(w, h, frames) * (3 / 8) + (enhance ? 0.5 : 0);
    // a looped sheet doubles the tokens: attention grows ~ tokens^1.5
    return E.ltxMinutes(w, h, frames) * (sheet ? 2.8 : 1);
  } catch { return x && x.mode === 'preview' ? 1 : 7; }
}

module.exports = { run: E.wrap(run), estimate, _plan: plan, _keyFrames: keyFrames, _tailOf: tailOf };
