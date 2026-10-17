'use strict';
// Depth ("Profondeur"): Video Depth Anything Small through ComfyUI — tool.recipes.depth_vda.
// Image or video in, grey depth out (bright = near, normalised over the whole clip so it does not flicker),
// at the source's size: PNG for an image, h264 mp4 for a video.
// `vda()` is also used by the « Vidéo guidée » block (guided.js) to make its depth guide.
const path = require('node:path');
const P = require('../patch');

const E = P.exec;

// Small only: Base/Large/metric are non-commercial (engine.md §7.9); validate.js refuses them too.
const VDA_SMALL = 'video_depth_anything_vits.pth';
// "fine" = more pixels seen by the model (multiple of 14) and a higher cap on the working size
const DETAIL = {
  fast: { input_size: 518, max_res: 1280 },
  fine: { input_size: 700, max_res: 1920 },
};

const TXT = {
  model: { fr: 'Video Depth Anything (Small)', en: 'Video Depth Anything (Small)' },
  otherModel: {
    fr: 'Ce modèle de profondeur n’est pas encore branché dans Mia : calcul fait avec Video Depth Anything (Small).',
    en: 'This depth model is not wired into Mia yet: computed with Video Depth Anything (Small).',
  },
  inverted: { fr: 'Inversée : clair = loin.', en: 'Inverted: bright = far.' },
};

/**
 * One VDA pass in ComfyUI: returns the depth PNG paths (in ComfyUI's output folder, removed with the run).
 * opts: { detail: 'fast'|'fine', range: [a, b] of the whole run, sub: output subfolder, keep: graph copy name }
 */
async function vda(x, inp, meta, { detail = 'fast', range = [0, 0.85], sub = '', keep = 'comfy_graph' } = {}) {
  const isVideo = inp.kind === 'video';
  const [a, b] = range;
  E.ranged(x, a, a + (b - a) * 0.06)(0, E.t('uploading'));
  // a video whose first frame must be skipped is re-cut first
  const cut = isVideo && inp.skipFirst ? E.tmp(x, `source_${sub || 'depth'}.mp4`) : null;
  try {
    const srcAbs = cut ? await E.prepVideo(x, inp, cut, { srcFps: meta.fps, range: [a, a + (b - a) * 0.06] }) : inp.abs;
    const up = await E.upload(x, srcAbs);

    const g = P.load('depth_vda');
    if (isVideo) P.set(g, '1', 'file', up);
    else {
      // a still goes straight to the model (VDA pads a single frame to its 32-frame window itself)
      P.replaceNode(g, '1', 'LoadImage', { image: up });
      P.remove(g, '2');
      P.set(g, '4', 'images', ['1', 0]);
    }
    P.set(g, '3', 'model', VDA_SMALL);
    P.setInputs(g, '4', DETAIL[detail] || DETAIL.fast);
    P.set(g, '9990', 'filename_prefix', E.prefix(x, sub, 'depth'));

    const res = await E.submit(x, g, { range: [a + (b - a) * 0.06, b], keep });
    return (await E.filesOrThrow(x, res.outputs, '9990')).map((f) => f.abs);
  } finally {
    await E.cleanup(cut);
  }
}

async function run(x) {
  E.begin(x);
  const inp = E.input(x, 'media');
  const isVideo = inp.kind === 'video';
  const meta = await E.metaOf(x, inp);
  const notes = [];

  const m = E.model(x, 'model');
  const chosen = (m && ((m.comfy && m.comfy.name) || m.file)) || VDA_SMALL;
  if (!/video_depth_anything_vits/i.test(chosen)) notes.push(E.t(TXT.otherModel));

  const frames = await vda(x, inp, meta, { detail: x.params.detail, range: [0, isVideo ? 0.85 : 0.95] });

  // ---- back to the source size (VDA works at max_res), optional inversion, one encode
  const w = isVideo ? E.even(meta.w || 0) : meta.w;
  const h = isVideo ? E.even(meta.h || 0) : meta.h;
  const vf = [w && h ? `scale=${w}:${h}:flags=bicubic` : null, x.params.invert ? 'negate' : null,
    isVideo ? null : 'format=gray'].filter(Boolean).join(',') || null;
  if (x.params.invert) notes.push(E.t(TXT.inverted));

  if (isVideo) {
    const fps = meta.fps || 24;
    const out = await E.framesToVideo(x, frames, path.join(x.outDir, 'depth.mp4'),
      { fps, vf, range: [0.85, 1], msg: E.t('encoding') });
    return {
      outputs: { depth: { abs: out, kind: 'video', meta: { w, h, fps, frames: frames.length } } },
      model: E.t(TXT.model), notes: E.notes(notes),
    };
  }
  const out = await E.stillTo(x, frames[0], path.join(x.outDir, 'depth.png'), vf);
  return {
    outputs: { depth: { abs: out, kind: 'image', meta: { w, h } } },
    model: E.t(TXT.model), notes: E.notes(notes),
  };
}

/** Minutes, for the queue's "fin vers…" before the first real timing exists. */
function estimate(x) {
  const inp = (x.inputs && x.inputs.media) || {};
  const frames = inp.kind === 'video' ? ((inp.meta && inp.meta.frames) || 120) : 1;
  const perFrame = (x.params && x.params.detail === 'fine') ? 0.008 : 0.004;
  return Math.max(0.3, 0.3 + frames * perFrame);
}

module.exports = { run: E.wrap(run), estimate, vda, VDA_SMALL };
