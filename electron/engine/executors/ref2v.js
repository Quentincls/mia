'use strict';
// Video from references ("Vidéo à partir de références", SPEC §17): MiniMax H3 Reference-to-Video (ref2va), from
// the official template comfyui_workflow_templates_json/templates/video_minimax_h3_r2v.json made local:
// fp16 video VAE (the laptop's), turbo 4-step LoRA on, frames + sound saved as PNG/FLAC and encoded once by Mia.
//   - up to 9 reference images (ref_image_0…8 = « Image 1…9 », in wire order) and 3 reference videos
//     (ref_video_0…2 = « Vidéo 1…3 ») resampled to 24 fps, 2 to 15 s, with their sound;
//   - Quentin writes « Image 2 », « Vidéo 1 » (FR or EN, any case): Mia turns them into <Picture 2>, <Video 1>;
//   - 24 fps, length 17k+5, sizes on the 32-px grid, 720p at most.
// The ref2va model and its turbo LoRA are not installed yet: the run stops at once with
// « Le modèle « MiniMax H3 · références » n'est pas installé » (validate.js says the same).
const path = require('node:path');
const P = require('../patch');

const E = P.exec;

const REF2VA = 'minimax_h3_ref2va_pruned_int8_convrot.safetensors';
const TURBO4 = 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors';
const MAX_IMAGES = 9;
const MAX_VIDEOS = 3;
const FPS = 24;
const PREVIEW_MAX_S = 3;
const MAX_SHORT = 720;
const MAX_PIXELS = 1344 * 768;           // the official 768p area
const REF_MIN = 2 * FPS;                 // reference videos: 2 to 15 s at 24 fps
const REF_MAX = 15 * FPS;

const TXT = {
  model: { fr: 'MiniMax H3 · références', en: 'MiniMax H3 · references' },
  noRefs: { fr: 'Branche au moins une image de référence.', en: 'Wire at least one reference image.' },
  tooManyImages: { fr: '{n} images de référence branchées : 9 au plus.', en: '{n} reference images wired: 9 at most.' },
  tooManyVideos: { fr: '{n} vidéos de référence branchées : 3 au plus.', en: '{n} reference videos wired: 3 at most.' },
  noPrompt: {
    fr: 'Écris la consigne et cite tes références : « Image 1 », « Image 2 »…',
    en: 'Write the prompt and name your references: “Image 1”, “Image 2”…',
  },
  citedImage: {
    fr: 'La consigne cite « Image {n} », mais {count} image(s) de référence seulement sont branchées.',
    en: 'The prompt names “Image {n}”, but only {count} reference image(s) are wired.',
  },
  citedVideo: {
    fr: 'La consigne cite « Vidéo {n} », mais {count} vidéo(s) de référence seulement sont branchées.',
    en: 'The prompt names “Video {n}”, but only {count} reference video(s) are wired.',
  },
  listed: {
    fr: 'Aucune référence citée dans la consigne : Mia les a toutes annoncées en tête.',
    en: 'No reference named in the prompt: Mia listed them all at the start.',
  },
  uncited: {
    fr: 'Non citée(s) dans la consigne (le modèle les voit quand même) : {list}.',
    en: 'Not named in the prompt (the model still sees them): {list}.',
  },
  padded: { fr: 'Vidéo {n} : moins de 2 s, sa dernière image est tenue jusqu’à 2 s.', en: 'Video {n}: under 2 s, its last frame is held up to 2 s.' },
  cut: { fr: 'Vidéo {n} : limitée à ses 15 premières secondes.', en: 'Video {n}: limited to its first 15 seconds.' },
  size: { fr: '{w} × {h}, {frames} images à 24 i/s ({s} s).', en: '{w} × {h}, {frames} frames at 24 fps ({s} s).' },
  refs: { fr: '{i} image(s) et {v} vidéo(s) de référence.', en: '{i} reference image(s) and {v} video(s).' },
  max: { fr: 'Fidélité maximale : références en grand (plus lent).', en: 'Maximum fidelity: references at full size (slower).' },
  previewNote: { fr: 'Aperçu : basse définition, 3 s au plus.', en: 'Preview: low resolution, 3 s at most.' },
  image: { fr: 'Image {n}', en: 'Image {n}' },
  video: { fr: 'Vidéo {n}', en: 'Video {n}' },
};

const list = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).filter((r) => r && r.abs);

/**
 * « Image 2 » / « image n°2 » / "Picture 2" -> <Picture 2>, « Vidéo 1 » / "video 1" -> <Video 1> (any case).
 * Already-written tags (<Picture 1>) are left alone. Returns { text, images:Set, videos:Set } of cited numbers.
 */
function tagPrompt(prompt) {
  const images = new Set();
  const videos = new Set();
  let text = String(prompt || '');
  // not followed by a unit: « a video 2 seconds long » stays text
  const end = String.raw`(?![\p{L}\p{N}_>])(?!\s*(?:s|sec|secs?|seconds?|secondes?|min|minutes?|fps|i\/s|frames?|px|%)(?![\p{L}]))`;
  const lead = String.raw`(?<![<\p{L}\p{N}_])`;
  text = text.replace(new RegExp(String.raw`${lead}(?:images?|img|pictures?)\s*(?:n\s*[°o]\s*)?(\d{1,2})${end}`, 'giu'),
    (_, n) => { images.add(Number(n)); return `<Picture ${Number(n)}>`; });
  text = text.replace(new RegExp(String.raw`${lead}(?:vid[ée]os?|clips?)\s*(?:n\s*[°o]\s*)?(\d{1,2})${end}`, 'giu'),
    (_, n) => { videos.add(Number(n)); return `<Video ${Number(n)}>`; });
  for (const m of text.matchAll(/<Picture (\d+)>/g)) images.add(Number(m[1]));
  for (const m of text.matchAll(/<Video (\d+)>/g)) videos.add(Number(m[1]));
  return { text, images, videos };
}

/** Frame size on the 32-px grid, never above the asked short side (720p at most). */
function frameSize(ratio, short) {
  const r = Math.min(3.6, Math.max(0.28, Number(ratio) || 16 / 9));
  let ow = r >= 1 ? short * r : short;
  let oh = r >= 1 ? short : short / r;
  if (ow * oh > MAX_PIXELS) { const k = Math.sqrt(MAX_PIXELS / (ow * oh)); ow *= k; oh *= k; }
  return { w: Math.max(64, Math.floor(ow / 32) * 32), h: Math.max(64, Math.floor(oh / 32) * 32) };
}

function plan(x) {
  const preview = x.mode === 'preview';
  const refs = list(x.inputs && x.inputs.refs);
  const first = refs[0];
  const ratio = E.formatRatio(x.params.format, first && first.meta, 16 / 9);
  const short = Math.min(MAX_SHORT, E.shortSide(x, { preview, previewCap: 448, max: MAX_SHORT }));
  const { w, h } = frameSize(ratio, short);
  const dur = Math.max(1, Math.min(15, Number(x.params.duration) || 5));
  const seconds = preview ? Math.min(dur, PREVIEW_MAX_S) : dur;
  const frames = E.minimaxLength(seconds, preview);
  return { preview, w, h, frames, nImages: refs.length, nVideos: list(x.inputs && x.inputs.refVideos).length,
    fidelity: x.params.fidelity === 'max' ? 'max' : 'match' };
}

async function run(x) {
  E.begin(x);
  const refs = list(x.inputs && x.inputs.refs);
  const vids = list(x.inputs && x.inputs.refVideos);
  if (!refs.length) throw new Error(E.t(TXT.noRefs));
  if (refs.length > MAX_IMAGES) throw new Error(E.t(TXT.tooManyImages, { n: refs.length }));
  if (vids.length > MAX_VIDEOS) throw new Error(E.t(TXT.tooManyVideos, { n: vids.length }));
  const notes = [];

  // ---- prompt: « Image N » / « Vidéo N » -> model tags, every cited number must be wired
  const raw = E.promptOf(x).prompt;
  if (!raw) throw new Error(E.t(TXT.noPrompt));
  const tagged = tagPrompt(raw);
  for (const n of tagged.images) {
    if (n < 1 || n > refs.length) throw new Error(E.t(TXT.citedImage, { n, count: refs.length }));
  }
  for (const n of tagged.videos) {
    if (n < 1 || n > vids.length) throw new Error(E.t(TXT.citedVideo, { n, count: vids.length }));
  }
  let prompt = tagged.text;
  if (!tagged.images.size && !tagged.videos.size) {
    const all = [...refs.map((_, i) => `<Picture ${i + 1}>`), ...vids.map((_, i) => `<Video ${i + 1}>`)];
    prompt = `Use ${all.join(', ')} as references.\n${prompt}`;
    notes.push(E.t(TXT.listed));
  } else {
    const left = [...refs.map((_, i) => (tagged.images.has(i + 1) ? null : E.t(TXT.image, { n: i + 1 }))),
      ...vids.map((_, i) => (tagged.videos.has(i + 1) ? null : E.t(TXT.video, { n: i + 1 })))].filter(Boolean);
    if (left.length) notes.push(E.t(TXT.uncited, { list: left.join(', ') }));
  }

  // ---- the model must be installed (it is not yet on this PC: say so before any upload)
  const m = E.model(x, 'model');
  const unet = (m && m.comfy && m.comfy.name && /ref2v/i.test(m.comfy.name)) ? m.comfy.name : REF2VA;
  await E.engine(x);
  await E.requireModels(x, [['diffusion_models', unet], ['loras', TURBO4]], TXT.model);

  const pl = plan(x);
  const { w, h, frames } = pl;
  const temps = [];
  try {
    // ---- uploads: images as they are (the node scales them), videos at 24 fps, 2–15 s, long side <= 1280
    E.ranged(x, 0, 0.08)(0, E.t('uploading'));
    const upImages = [];
    for (const r of refs) upImages.push(await E.upload(x, r.abs));
    const upVideos = [];
    for (let i = 0; i < vids.length; i++) {
      const v = vids[i];
      const meta = await E.metaOf(x, v);
      const fps = meta.fps || 24;
      const n = Math.round(((meta.frames || 0) / fps) * FPS);
      const want = Math.min(REF_MAX, Math.max(REF_MIN, n || REF_MIN));
      if (n < REF_MIN) notes.push(E.t(TXT.padded, { n: i + 1 }));
      if (n > REF_MAX) notes.push(E.t(TXT.cut, { n: i + 1 }));
      const dst = E.tmp(x, `ref_video_${i + 1}.mp4`);
      temps.push(dst);
      await E.prepVideo(x, v, dst, { fps: FPS, frames: want, srcFps: fps, audio: meta.hasAudio === true,
        vf: "scale=w='min(iw,1280)':h='min(ih,1280)':force_original_aspect_ratio=decrease:force_divisible_by=2",
        range: [0.01 + 0.06 * (i / vids.length), 0.01 + 0.06 * ((i + 1) / vids.length)] });
      upVideos.push({ name: await E.upload(x, dst), audio: meta.hasAudio === true });
    }

    // ---- graph
    const g = P.load('minimax_r2v');
    P.set(g, '1', 'unet_name', unet);
    P.setInputs(g, '8', { prompt, width: w, height: h, length: frames, ref_image_size: pl.fidelity });
    P.set(g, '9', 'noise_seed', E.seedOf(x));
    delete g['8'].inputs['ref_images.ref_image_0'];
    P.remove(g, '20');
    upImages.forEach((name, i) => {
      const id = String(20 + i);
      P.addNode(g, 'LoadImage', { image: name }, id);
      P.set(g, '8', `ref_images.ref_image_${i}`, [id, 0]);
    });
    let audioRun = true;                      // soundtracks are paired by number: only a leading run of them
    upVideos.forEach((v, i) => {
      const load = String(30 + i);
      const parts = String(33 + i);
      P.addNode(g, 'LoadVideo', { file: v.name }, load);
      P.addNode(g, 'GetVideoComponents', { video: [load, 0] }, parts);
      P.set(g, '8', `ref_videos.ref_video_${i}`, [parts, 0]);
      audioRun = audioRun && v.audio;
      if (audioRun) P.set(g, '8', `ref_video_audios.ref_video_audio_${i}`, [parts, 1]);
    });
    P.set(g, '9990', 'filename_prefix', E.prefix(x, '', 'frame'));
    P.set(g, '9991', 'filename_prefix', E.prefix(x, '', 'audio'));

    const res = await E.submit(x, g, { range: [0.08, 0.93] });
    const shots = (await E.filesOrThrow(x, res.outputs, '9990')).map((f) => f.abs);
    const sound = (await E.files(x, res.outputs, '9991'))[0];
    const out = await E.framesToVideo(x, shots, path.join(x.outDir, 'video.mp4'), {
      fps: FPS, audio: sound ? sound.abs : null, range: [0.93, 1], msg: E.t('encoding'),
    });

    notes.unshift(E.t(TXT.size, { w, h, frames: shots.length, s: E.dec(shots.length / FPS) }),
      E.t(TXT.refs, { i: refs.length, v: vids.length }));
    if (pl.fidelity === 'max') notes.push(E.t(TXT.max));
    if (pl.preview) notes.push(E.t(TXT.previewNote));
    return {
      outputs: { video: { abs: out, kind: 'video', meta: { w, h, fps: FPS, frames: shots.length } } },
      model: E.labelOf(m && /ref2v/i.test(unet) ? m : null, E.t(TXT.model)),
      notes: E.notes(notes),
    };
  } finally {
    await E.cleanup(temps);
  }
}

function estimate(x) {
  try {
    const { preview, w, h, frames, nImages, nVideos, fidelity } = plan(x);
    if (preview) return 2;
    // turbo 4 steps; reference tokens ride along every step ('max' = references at 2048 px: several times slower)
    const refs = 1 + 0.08 * nImages + 0.25 * nVideos;
    return (0.8 + 1.6 * (frames / 56) * ((w * h) / (704 * 1248)) * refs) * (fidelity === 'max' ? 2.5 : 1);
  } catch { return x && x.mode === 'preview' ? 2 : 6; }
}

module.exports = { run: E.wrap(run), estimate, _plan: plan, _tagPrompt: tagPrompt, REF2VA, TURBO4 };
