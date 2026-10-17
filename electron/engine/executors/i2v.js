'use strict';
// Animate an image ("Animer une image"): a start image (+ optional end image) becomes a short video.
//   LTX-2.5 (default): a 23-node single-stage graph (adapted from one of the author's tests),
//     end image = LTXVAddGuide at frame -1 + LTXVCropGuides before decoding. Sound is generated too.
//     Reference sheet (« Fiche de référence », SPEC §17) = the official LTX IC-LoRA « Ingredients »
//     (the official template_ltx2_3_ic_lora_ingredients): the sheet is fitted to the
//     frame (padded, never cropped), looped over the whole shot and given as an IC-LoRA guide at frame 0.
//   MiniMax H3 (when chosen): first + last frame, turbo 8 steps, 24 fps (adapted from one of the author's tests).
//     The sheet is ignored with MiniMax (note).
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
// MiniMax: nearest 32-px size, at most its native 704×1248 area. Preview: short side capped, 3 s at most.
const LTX_MAX_PIXELS = 2.2e6;          // ≈ 1088×1920, the lab's largest LTX shot on the laptop
const MINIMAX_MAX_PIXELS = 704 * 1248;
const SHEET_TOKENS = 17000;            // with a reference sheet: video tokens (latent frames × 32-px patches) at most

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
  minimaxRes: { fr: 'MiniMax H3 travaille jusqu’à 720p : taille ramenée.', en: 'MiniMax H3 works up to 720p: size reduced.' },
  defaultPrompt: {
    fr: 'Cinematic live-action shot, the scene comes alive with natural motion, steady camera, realistic light.',
    en: 'Cinematic live-action shot, the scene comes alive with natural motion, steady camera, realistic light.',
  },
};
const NEGATIVE = 'text, watermark, subtitles, cut, blurry, distorted faces, deformed hands, static image, no motion';

function plan(x) {
  const m = E.model(x, 'model');
  const mm = E.isMinimax(m);
  const preview = x.mode === 'preview';
  const start = x.inputs && x.inputs.start;
  const sheet = !mm && !!(x.inputs && x.inputs.sheet && x.inputs.sheet.abs);
  const ratio = E.formatRatio(x.params.format, start && start.meta);
  const dur = Math.max(1, Math.min(20, Number(x.params.duration) || 5));
  const seconds = preview ? Math.min(dur, PREVIEW_MAX_S) : dur;
  const asked = E.int(x.params.fps, 24);
  const fps = mm ? 24 : ([24, 25, 30].includes(asked) ? asked : 24);
  const frames = mm ? E.minimaxLength(seconds, preview) : E.ltxFrames(fps, seconds);
  const askedShort = E.shortSide(x, { preview, previewCap: mm ? 448 : 576 });
  const short = mm ? Math.min(askedShort, 704) : askedShort;
  // the looped sheet doubles the video tokens: keep the total near the lab's largest shot (1088×1920×121)
  const sheetMax = sheet ? (SHEET_TOKENS * 1024) / (Math.floor((frames - 1) / 8) + 1) : Infinity;
  const maxPixels = mm ? MINIMAX_MAX_PIXELS : Math.min(LTX_MAX_PIXELS, sheetMax);
  const size = E.videoSize({ ratio, short, exact: !mm, maxPixels });
  const { w, h } = size;
  const free = E.videoSize({ ratio, short, exact: !mm, maxPixels: mm ? MINIMAX_MAX_PIXELS : LTX_MAX_PIXELS });
  return { m, mm, preview, sheet, w, h, ow: size.ow, oh: size.oh, crop: size.crop, fps, frames, asked,
    capped: mm && askedShort > 704, sheetCapped: sheet && free.w * free.h > w * h };
}

async function run(x) {
  E.begin(x);
  const start = E.input(x, 'start');
  const end = E.input(x, 'end', false);
  const sheet = E.input(x, 'sheet', false);
  const pl = plan(x);
  const { m, mm, w, h, fps, frames } = pl;
  const notes = [];
  let { prompt, negative } = E.promptOf(x);
  if (!prompt) prompt = E.t(TXT.defaultPrompt);
  if (!negative) negative = NEGATIVE;

  // character / place LoRA of the model's family (a mismatch stops here, before any upload)
  const lora = await E.lora(x, mm ? 'minimax' : 'ltx');
  prompt = E.loraPrompt(prompt, lora, notes);

  E.ranged(x, 0, 0.05)(0, E.t('uploading'));
  const upStart = await E.upload(x, start.abs);
  const upEnd = end && end.abs ? await E.upload(x, end.abs) : null;
  const upSheet = sheet && sheet.abs && !mm ? await E.upload(x, sheet.abs) : null;
  if (sheet && sheet.abs && mm) notes.push(E.t(TXT.sheetSkipped));

  let g;
  if (mm) {
    g = P.load('minimax_i2v');
    P.set(g, '1', 'unet_name', (m && m.comfy && m.comfy.name) || MINIMAX_INT8);
    P.set(g, '6', 'image', upStart);
    P.setInputs(g, '18', { width: w, height: h });
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
  }
  if (upEnd && !mm) notes.push(E.t(TXT.endTip));
  P.set(g, '9990', 'filename_prefix', E.prefix(x, '', 'frame'));
  P.set(g, '9991', 'filename_prefix', E.prefix(x, '', 'audio'));

  const res = await E.submit(x, g, { range: [0.05, 0.92] });
  const shots = (await E.filesOrThrow(x, res.outputs, '9990')).map((f) => f.abs);
  const sound = (await E.files(x, res.outputs, '9991'))[0];

  const out = await E.framesToVideo(x, shots, path.join(x.outDir, 'video.mp4'), {
    fps, vf: pl.crop, audio: sound ? sound.abs : null, range: [0.92, 1], msg: E.t('encoding'),
  });
  const { ow, oh } = pl;

  if (pl.preview) notes.push(E.t(TXT.previewNote));
  notes.unshift(E.t(TXT.size, { w: ow, h: oh, frames: shots.length, fps, s: E.dec(shots.length / fps) }));
  return {
    outputs: { video: { abs: out, kind: 'video', meta: { w: ow, h: oh, fps, frames: shots.length } } },
    model: E.labelOf(m, E.t(mm ? TXT.minimax : TXT.ltx)),
    notes: E.notes(notes),
  };
}

function estimate(x) {
  try {
    const { mm, preview, sheet, w, h, frames } = plan(x);
    // MiniMax: 704×1248×56 in ~2 min, ×124 in ~5 min 17 (lab)
    if (mm) return preview ? 1.5 : 0.6 + 2.2 * (frames / 56) * ((w * h) / (704 * 1248));
    // a looped sheet doubles the tokens: attention grows ~ tokens^1.5
    return E.ltxMinutes(w, h, frames) * (sheet ? 2.8 : 1);
  } catch { return x && x.mode === 'preview' ? 1 : 7; }
}

module.exports = { run: E.wrap(run), estimate, _plan: plan };
