'use strict';
// PAN 2 (MBZUAI IFM, 29B « world model », Apache-2.0), Model block only (SPEC §22-23), checked on the GPU 25/11 on
// the Spark (ComfyUI 0.46.3, native support): image to video (Wan22ImageToVideoLatent drives the first frame) and
// text to video. No sound.
//   PAN 2 was trained on structured JSON captions (seven keys: style, lighting, viewpoint, subjects, first frame,
//   timed events with camera tags and actions, quality); a plain sentence gives noise. So the run has two steps:
//   1. the caption: the block's prompt, if it already IS such a JSON caption (an assistant can write one), is used as
//      it is; otherwise Qwen 3.5 9B — PAN 2's own text encoder file — rewrites the prompt with the authors' rewriter
//      system prompt (workflows/pan2/, ifm-ai/PAN2, Apache-2.0), looking at the start image (TextGenerateV2,
//      ≈ 45 s). Its answer is repaired (strings encoded twice, event times stretched to the shot) and serialized
//      once, compact, in the schema's key order. If it cannot be read, a plain caption built from the prompt is used
//      (note).
//   2. the video: the authors' defaults (50 steps, euler / simple, CFG 2.5, the model's own shift 9 — never a
//      ModelSamplingSD3, which forces a ×1000 multiplier: only noise after the first frame), the fixed generic negative
//      with the shot's duration, 24 fps, 4n + 1 frames, at most 704 × 1248 (the authors' canvas).
// Preview = 480 px short side, 3 s at most, 20 steps (checked: a usable draft in ≈ 3.5 min).
const fs = require('node:fs');
const path = require('node:path');
const P = require('../patch');

const E = P.exec;

const FPS = 24;
const PREVIEW_MAX_S = 3;
const MAX_PIXELS = 704 * 1248;
const STEPS = { final: 50, preview: 20 };
const ASSETS = path.join(__dirname, '..', 'workflows', 'pan2');
// the camera tags PAN 2 was trained on (rewriter system prompt); any other word is dropped
const CAMERA_TAGS = new Set(['static', 'pan_left', 'pan_right', 'tilt_up', 'tilt_down', 'track_left', 'track_right',
  'dolly_forward', 'dolly_backward', 'dolly_up', 'dolly_down', 'zoom_in', 'zoom_out', 'roll_clockwise',
  'roll_counterclockwise', 'unstable']);
const KEYS = ['video_style', 'lighting', 'perspective_view', 'subjects_lifecycle', 'init_frame_visual_description', 'events', 'quality'];
const FILES = [['diffusion_models', 'pan2_int8_convrot.safetensors'], ['text_encoders', 'qwen3.5_9b_int8_convrot.safetensors'],
  ['vae', 'wan2.2_vae.safetensors']];

const TXT = {
  model: { fr: 'PAN 2', en: 'PAN 2' },
  noPrompt: {
    fr: 'Décris ce qui se passe et ce que fait la caméra : PAN 2 a besoin d’une consigne.',
    en: 'Describe what happens and what the camera does: PAN 2 needs a prompt.',
  },
  size: { fr: '{w} × {h}, {frames} images à {fps} i/s ({s} s), sans son.', en: '{w} × {h}, {frames} frames at {fps} fps ({s} s), no sound.' },
  previewNote: { fr: 'Aperçu : basse définition, 3 s au plus, 20 étapes.', en: 'Preview: low resolution, 3 s at most, 20 steps.' },
  captionGiven: { fr: 'Légende structurée fournie dans la consigne, utilisée telle quelle.', en: 'Structured caption given in the prompt, used as it is.' },
  captionWritten: { fr: 'Description rédigée par Mia pour PAN 2 :', en: 'Description written by Mia for PAN 2:' },
  captionPlain: {
    fr: 'Mia n’a pas pu rédiger la description détaillée : PAN 2 a reçu ta consigne telle quelle, le résultat peut moins la suivre.',
    en: 'Mia could not write the detailed description: PAN 2 got your prompt as it is, the result may follow it less closely.',
  },
  start: { fr: 'Image de début', en: 'Start image' },
};

function plan(x) {
  const preview = x.mode === 'preview';
  const start = x.inputs && x.inputs.start && x.inputs.start.abs ? x.inputs.start : null;
  const ratio = E.formatRatio(x.params.format === 'auto' && !start ? '16:9' : x.params.format, start && start.meta, 16 / 9);
  const dur = Math.max(2, Math.min(E.maxSeconds(E.model(x, 'model'), 'pan2', 15), Number(x.params.duration) || 5));
  const seconds = preview ? Math.min(dur, PREVIEW_MAX_S) : dur;
  const frames = 4 * Math.ceil((seconds * FPS) / 4) + 1;
  const short = preview ? 480 : (Number(x.params.resolution) >= 720 ? 704 : 544);
  const { w, h } = E.videoSize({ ratio, short, exact: false, mult: 32, maxPixels: MAX_PIXELS });
  return { preview, start, w, h, seconds, frames, steps: preview ? STEPS.preview : STEPS.final };
}

// ---------------------------------------------------------------- the caption

const secs = (s) => String(Math.round(s * 10) / 10);
const range = (a, b) => `${secs(a)} to ${secs(b)}`;
const parseRange = (r) => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*to\s*(\d+(?:\.\d+)?)\s*$/.exec(String(r || ''));
  return m ? [Number(m[1]), Number(m[2])] : null;
};
/**
 * A value that may be JSON encoded once more. Qwen 3.5 sometimes leaves an inner string open (GPU 25/11:
 * subjects_lifecycle = ["{\"subject_id\"…}, {\"subject_id\"…}] with no closing quote): the second try flattens the
 * escaped quotes and the quotes around the objects, then reads it again.
 */
const decode = (v) => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { /* flattened below */ }
  if (!/^s*[[{]/.test(v)) return v;
  try { return JSON.parse(v.replace(/\\"/g, '"').replace(/"s*{/g, '{').replace(/}s*"/g, '}')); } catch { return v; }
};
/** A list whose items may be objects encoded as strings, or several objects in one string (« {…}, {…} »). */
const listOf = (v) => (Array.isArray(v) ? v : []).flatMap((x) => {
  const d = decode(x);
  if (d && typeof d === 'object') return Array.isArray(d) ? d : [d];
  if (typeof x === 'string' && /^s*{/.test(x)) { const m = decode(`[${x}]`); if (Array.isArray(m)) return m; }
  return [x];
});
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** The first JSON object found in a text (fences and words around it tolerated), or null. */
function firstObject(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

/**
 * A caption object put back in the schema: the seven keys in order, inner strings encoded twice decoded, events
 * numbered from 0 and stretched to cover 0 → the shot's length, artifacts null. Null when it is not a caption.
 */
function repair(obj, seconds) {
  let c = decode(obj);
  if (c && typeof c === 'object' && 'refined_prompt' in c) c = decode(c.refined_prompt);
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const events = listOf(c.events).filter((e) => e && typeof e === 'object');
  if (!events.length || !str(c.init_frame_visual_description)) return null;
  const subjects = listOf(c.subjects_lifecycle)
    .filter((s) => s && typeof s === 'object' && str(s.subject_id))
    .map((s) => ({ subject_id: str(s.subject_id), display_name: str(s.display_name), subject_attribute: str(s.subject_attribute) }));
  // the events' times, as given, then scaled onto 0 → seconds (a rewriter that kept another duration)
  const spans = events.map((e) => parseRange(e.time_range_sec));
  const end = Math.max(...spans.map((r) => (r ? r[1] : 0)), 0) || seconds;
  const k = seconds / end;
  const fit = (r, i, n) => {
    const a = r ? r[0] * k : (seconds * i) / n;
    const b = r ? r[1] * k : (seconds * (i + 1)) / n;
    return [Math.max(0, a), Math.min(seconds, b)];
  };
  let prev = 0;
  const outEvents = events.map((e, i) => {
    let [a, b] = fit(spans[i], i, events.length);
    a = i === 0 ? 0 : prev;
    if (i === events.length - 1) b = seconds;
    if (b <= a) b = Math.min(seconds, a + 0.1);
    prev = b;
    const sub = (list) => listOf(list).filter((v) => v && typeof v === 'object');
    const camList = listOf(e.camera_motion);
    const tags = camList.filter((t) => typeof t === 'string' && CAMERA_TAGS.has(t));
    const fromObjects = sub(camList).flatMap((m) => (Array.isArray(m.camera_motion) ? m.camera_motion : []))
      .filter((t) => typeof t === 'string' && CAMERA_TAGS.has(t));
    const camTags = [...new Set([...fromObjects, ...tags])].filter((t, _, all) => t !== 'static' || all.length === 1);
    const cams = camTags.length ? [{ time_range_sec: range(a, b), camera_motion: camTags }] : [];
    const acts = sub(e.contained_actions).filter((v) => str(v.action)).map((v) => {
      const r = parseRange(v.time_range_sec);
      const ra = r ? Math.min(b, Math.max(a, r[0] * k)) : a;
      const rb = r ? Math.min(b, Math.max(ra, r[1] * k)) : b;
      return { time_range_sec: range(ra, rb), action: str(v.action) };
    });
    return { event_index: i, time_range_sec: range(a, b), event_description: str(e.event_description),
      camera_motion: cams.length ? cams : [{ time_range_sec: range(a, b), camera_motion: ['static'] }], contained_actions: acts };
  });
  const q = decode(c.quality) || {};
  return {
    video_style: str(c.video_style) || 'Live-action footage, the whole clip is one uninterrupted continuous shot.',
    lighting: str(c.lighting),
    perspective_view: str(c.perspective_view),
    subjects_lifecycle: subjects,
    init_frame_visual_description: str(c.init_frame_visual_description),
    events: outEvents,
    quality: { video_quality: str(q.video_quality) || 'Sharp, natural, high-detail footage with realistic motion.',
      text_logos_overlays: q.text_logos_overlays == null || q.text_logos_overlays === '' ? null : q.text_logos_overlays, artifacts: null },
  };
}

/** Last resort: the prompt itself, put in the schema (one event over the whole shot). */
function plainCaption(prompt, seconds) {
  return repair({
    video_style: 'Live-action footage, natural and photographic, the whole clip is one uninterrupted continuous shot.',
    lighting: 'Natural, consistent lighting.', perspective_view: 'Steady camera framing the scene.', subjects_lifecycle: [],
    init_frame_visual_description: prompt,
    events: [{ time_range_sec: range(0, seconds), event_description: prompt, camera_motion: [], contained_actions: [] }],
    quality: { video_quality: 'Sharp, natural, high-detail footage with realistic motion.', text_logos_overlays: null, artifacts: null },
  }, seconds);
}

/** The caption as one line for the version's notes: the first frame, then each event with its times. */
function captionNote(c) {
  const t = (r) => r.replace(' to ', '–').replace(/\./g, E.t({ fr: ',', en: '.' }));
  return [c.init_frame_visual_description, ...c.events.map((e) => `${t(e.time_range_sec)} s : ${e.event_description}`)]
    .map((l) => (l.length > 260 ? `${l.slice(0, 260)}…` : l)).join('\n');
}

/** Compact JSON, once, keys in the schema's order (the order of the object built by repair()). */
const serialize = (c) => JSON.stringify(c);

/** The fixed negative of the authors, for this shot's length. */
function negativeFor(seconds) {
  return fs.readFileSync(path.join(ASSETS, 'generic_negative.txt'), 'utf8').trim().replace(/\{duration_sec\}/g, secs(seconds));
}

async function caption(x, pl, prompt, upStart, notes) {
  const given = prompt.startsWith('{') ? repair(firstObject(prompt), pl.seconds) : null;
  if (given) { notes.push(E.t(TXT.captionGiven)); return given; }
  const g = P.load('pan2_caption');
  const request = { type: upStart ? 'i2v' : 't2v', original_prompt: prompt, duration_sec: Number(secs(pl.seconds)) };
  P.setInputs(g, '4', { prompt: JSON.stringify(request), system_prompt: fs.readFileSync(path.join(ASSETS, 'rewriter_system_prompt.md'), 'utf8'),
    'sampling_mode.seed': E.seedOf(x) % 2 ** 32 });
  if (upStart) {
    P.set(g, '2', 'image', upStart);
    const s = E.videoSize({ ratio: pl.w / pl.h, short: 448, exact: false, mult: 32 });
    P.setInputs(g, '3', { width: s.w, height: s.h });
  } else {
    delete g['2']; delete g['3'];
    delete g['4'].inputs['images.image1'];
  }
  let c = null;
  try {
    const res = await E.submit(x, g, { range: [0.01, 0.06], keep: 'comfy_graph_caption' });
    c = repair(firstObject(E.enhancedText(res, '5')), pl.seconds);
  } catch (e) {
    if (x.signal && x.signal.aborted) throw e;
    c = null;
  }
  if (c) { notes.push(`${E.t(TXT.captionWritten)}\n${captionNote(c)}`); return c; }
  notes.push(E.t(TXT.captionPlain));
  return plainCaption(prompt, pl.seconds);
}

// ---------------------------------------------------------------- the run

async function run(x) {
  E.begin(x);
  const pl = plan(x);
  const { w, h, frames, seconds } = pl;
  const prompt = E.promptOf(x).prompt;
  if (!prompt) throw new Error(E.t(TXT.noPrompt));
  const m = E.model(x, 'model');
  await E.requireModels(x, FILES, E.t(TXT.model));
  const notes = [];
  const upStart = pl.start ? await E.upload(x, pl.start.abs) : null;

  const cap = await caption(x, pl, prompt, upStart, notes);

  const g = P.load('pan2_i2v');
  if (m && m.comfy && m.comfy.name && /pan2/i.test(m.comfy.name)) P.set(g, '1', 'unet_name', m.comfy.name);
  P.set(g, '5', 'text', serialize(cap));
  P.set(g, '6', 'text', negativeFor(seconds));
  P.setInputs(g, '9', { width: w, height: h, length: frames });
  P.setInputs(g, '10', { seed: E.seedOf(x), steps: pl.steps });
  if (upStart) {
    P.set(g, '7', 'image', upStart);
    P.setInputs(g, '8', { width: w, height: h });
  } else {
    delete g['7']; delete g['8'];
    delete g['9'].inputs.start_image;
  }
  P.set(g, '9990', 'filename_prefix', E.prefix(x, '', 'frame'));

  const res = await E.submit(x, g, { range: [0.06, 0.95] });
  const shots = (await E.filesOrThrow(x, res.outputs, '9990')).map((f) => f.abs);
  const out = await E.framesToVideo(x, shots, path.join(x.outDir, 'video.mp4'), {
    fps: FPS, range: [0.95, 1], msg: E.t('encoding'),
  });
  return {
    outputs: { video: { abs: out, kind: 'video', meta: { w, h, fps: FPS, frames: shots.length } } },
    model: E.labelOf(m, E.t(TXT.model)),
    notes: E.notes([
      E.t(TXT.size, { w, h, frames: shots.length, fps: FPS, s: E.dec(shots.length / FPS) }),
      pl.preview ? E.t(TXT.previewNote) : null,
      ...notes,
    ]),
  };
}

/**
 * Minutes (GPU 25/11, Spark: 31 s a step at 704 × 1248 × 121 with the CFG, ≈ 1 min to load, ≈ 45 s to write the
 * caption): grows with the video tokens.
 */
function estimate(x) {
  try {
    const { w, h, frames, steps } = plan(x);
    return 1.75 + steps * 0.52 * ((w * h * frames) / (704 * 1248 * 121));
  } catch { return x && x.mode === 'preview' ? 4 : 30; }
}

/** Is this inventory entry PAN 2? (the task blocks « Animer une image » / « Vidéo depuis un texte » hand it over) */
const isPan2 = (m) => !!m && /pan.?2/i.test(`${m.family || ''} ${m.baseKey || ''} ${(m.comfy && m.comfy.name) || m.file || ''}`);

module.exports = { run: E.wrap(run), estimate, isPan2, _run: run, _plan: plan, _repair: repair, _plainCaption: plainCaption, _negativeFor: negativeFor };
