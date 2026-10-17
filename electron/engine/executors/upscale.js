'use strict';
// Upscale ("Agrandir"): SeedVR2, inside ComfyUI — never the separate CLI process, which would load a second
// copy of torch next to ComfyUI's models on a 24 GB card and could not be cancelled cleanly.
//   int8 models (diffusion_models\seedvr2_7b/3b_int8_convrot, what the model picker shows): ComfyUI's native
//     nodes, graph from its own blueprint "Upscale Video (SeedVR2 3B Int8)", temporal chunking sized to free VRAM.
//   fp8 custom-node model (models\SEEDVR2\…_fp8…): SeedVR2VideoUpscaler with the lab's CLI settings
//     (batch 21, overlap 4, noise 0.1, prepend 4, colour "lab", tiled VAE).
// Target = short side (1440 or 2160). Only files ComfyUI lists are ever named: SeedVR2's "(Down)Load" node
// downloads anything else, validate.js refuses that.
const path = require('node:path');
const P = require('../patch');

const E = P.exec;

const NATIVE_7B = 'seedvr2_7b_int8_convrot.safetensors';
const NATIVE_3B = 'seedvr2_3b_int8_convrot.safetensors';
const NODE_7B = 'seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors';
const PREPEND = 4;

const TXT = {
  model: { fr: 'SeedVR2', en: 'SeedVR2' },
  size: { fr: 'Petit côté porté à {t} px.', en: 'Short side raised to {t} px.' },
  already: {
    fr: 'La source fait déjà {s} px de petit côté : passe de détail sans vrai agrandissement.',
    en: 'The source already has a {s} px short side: a detail pass rather than a real upscale.',
  },
  face: {
    fr: 'SeedVR2 lisse un peu la peau des visages : compare avec la source.',
    en: 'SeedVR2 slightly smooths skin on faces: compare with the source.',
  },
};

/** Which graph and file: the picker's choice, else the best int8 model ComfyUI lists. */
async function pick(x) {
  const m = E.model(x, 'model');
  const file = m && ((m.comfy && m.comfy.name) || m.file);
  const folder = m && m.comfy && m.comfy.folder;
  if (file && (folder === 'seedvr2' || /^seedvr2_ema_/i.test(file))) return { m, kind: 'node', file };
  if (file && /seedvr2/i.test(file)) return { m, kind: 'native', file };
  let listed = [];
  try { listed = (await x.comfy.models('diffusion_models')) || []; } catch { /* validated later anyway */ }
  if (listed.includes(NATIVE_7B)) return { m, kind: 'native', file: NATIVE_7B };
  if (listed.includes(NATIVE_3B)) return { m, kind: 'native', file: NATIVE_3B };
  return { m, kind: 'node', file: NODE_7B };
}

async function run(x) {
  E.begin(x);
  const inp = E.input(x, 'media');
  const isVideo = inp.kind === 'video';
  const meta = await E.metaOf(x, inp);
  const target = String(x.params.target) === '2160' ? 2160 : 1440;
  const { m, kind, file } = await pick(x);
  const notes = [E.t(TXT.size, { t: target })];
  const short = Math.min(meta.w || 0, meta.h || 0);
  if (short >= target) notes.push(E.t(TXT.already, { s: short }));

  E.ranged(x, 0, 0.05)(0, E.t('uploading'));
  const cut = isVideo && inp.skipFirst ? E.tmp(x, 'source.mp4') : null;
  try {
    const srcAbs = cut ? await E.prepVideo(x, inp, cut, { srcFps: meta.fps, audio: meta.hasAudio === true }) : inp.abs;
    const up = await E.upload(x, srcAbs);

    const g = P.load(kind === 'node' ? 'seedvr2_node' : 'seedvr2_native');
    const imageInto = kind === 'node' ? ['5', 'image'] : ['3', 'input'];
    if (isVideo) P.set(g, '1', 'file', up);
    else {
      P.replaceNode(g, '1', 'LoadImage', { image: up });
      P.remove(g, '2');
      P.set(g, imageInto[0], imageInto[1], ['1', 0]);
    }
    if (kind === 'node') {
      P.set(g, '3', 'model', file);
      P.setInputs(g, '5', {
        resolution: target,
        // 4n+1 frames per batch: 21 is the lab's 1440 setting, smaller at 4K for VRAM; a still is one frame
        batch_size: isVideo ? (target > 1440 ? 9 : 21) : 1,
        prepend_frames: isVideo ? PREPEND : 0,
        temporal_overlap: isVideo ? 4 : 0,
      });
    } else {
      P.set(g, '3', 'resize_type.shorter_size', target);
      P.set(g, '8', 'unet_name', file);
    }
    P.set(g, '9990', 'filename_prefix', E.prefix(x, '', 'frame'));

    const res = await E.submit(x, g, { range: [0.05, isVideo ? 0.9 : 0.97] });
    let shots = (await E.filesOrThrow(x, res.outputs, '9990')).map((f) => f.abs);

    if (!isVideo) {
      const out = await E.stillTo(x, shots[0], path.join(x.outDir, 'upscaled.png'));
      return {
        outputs: { out: { abs: out, kind: 'image' } },
        model: E.labelOf(m, E.t(TXT.model)), notes: E.notes(notes),
      };
    }
    // the custom node is documented to drop its prepended frames; if a build does not, they are at the head
    const want = meta.frames || shots.length;
    if (kind === 'node' && shots.length === want + PREPEND) shots = shots.slice(PREPEND);
    shots = shots.slice(0, want);                 // SeedVR2 pads to 4n+1 at the tail
    const fps = meta.fps || 24;
    const dst = path.join(x.outDir, 'upscaled.mp4');
    await E.framesToVideo(x, shots, dst, {
      fps, audio: meta.hasAudio === true ? srcAbs : null, range: [0.9, 1], msg: E.t('encoding'),
    });
    if (short && short <= 1080) notes.push(E.t(TXT.face));
    return {
      outputs: { out: { abs: dst, kind: 'video', meta: { fps, frames: shots.length } } },
      model: E.labelOf(m, E.t(TXT.model)), notes: E.notes(notes),
    };
  } finally {
    await E.cleanup(cut);
  }
}

function estimate(x) {
  const inp = (x.inputs && x.inputs.media) || {};
  const frames = inp.kind === 'video' ? ((inp.meta && inp.meta.frames) || 120) : 1;
  const k = x.params && String(x.params.target) === '2160' ? 2.25 : 1;
  const m = E.model(x, 'model');
  const small = /3b/i.test((m && ((m.comfy && m.comfy.name) || m.file)) || '') ? 0.5 : 1;
  // lab: 25 min for 240 frames with the 7B at 1440 (~6 s/frame); the 3B about twice as fast
  return Math.max(0.5, 0.5 + (frames * 6 * k * small) / 60);
}

module.exports = { run: E.wrap(run), estimate };
