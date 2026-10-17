'use strict';
// Make it photoreal ("Rendre photoréaliste"): LTX-2.5 Layout-To-Render, single stage, euler —
// tool.recipes.ltx_v2v(mode="layout", single_stage=True, sampler="euler"), the recipe that works best for 3D renders.
// The 3D render gives camera, shapes and timing; the look image gives the look (IC-LoRA guide at RoPE -1).
//
//   preview: 544 px on the short side, first 49 frames, one pass (~2 min).
//   final:   source size (long side capped at 1920), mirror-padded to multiples of 32 (1080 -> 1088, as the lab
//            does), in 97-frame windows overlapping by 25 (tool.longshot.layout_long): each later window gets
//            the frame already generated at its start as a key at frame 0, and windows are joined with a SHORT
//            8-frame blend at the most similar frame of the overlap (never a long cross-fade: ghosting).
//   keepBlacks: tool.composite.dark_guard_sequence redone in ffmpeg (no GPU): where the render is near black,
//            the render wins, through a blurred, time-smoothed mask (Layout-To-Render "relights" blacks).
//   LoRA:     the character / place LoRA (SPEC §12) goes after the Layout-To-Render IC-LoRA, at its strength.
// windows(), geometry() and join() are shared with the « Vidéo guidée » block (guided.js).
const fsp = require('node:fs/promises');
const path = require('node:path');
const P = require('../patch');

const E = P.exec;

const LTX_INT8 = 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors';
const WINDOW = 97;
const OVERLAP = 25;
const BLEND = 8;
const PREVIEW_FRAMES = 49;
const PREVIEW_SHORT = 544;
const MAX_LONG = 1920;
const MAX_WINDOWS = 20;                        // ~60 s at 24 fps, ~3 h of GPU: beyond, cut the clip first
const GUIDE_PASSTHROUGH = { 0: 'positive', 1: 'negative', 2: 'latent' };
// dark_guard_sequence(low=0.02, high=0.07, blur=8, temporal_sigma≈3): mask = clip((high - lum) / (high - low))
const DARK_LUT = 'clip((17.85-val)*20,0,255)';
const DARK_TMIX = '14 25 41 61 80 95 100 95 80 61 41 25 14';

const TXT = {
  noLook: {
    fr: 'Sans image de look : Mia suit seulement la consigne (look moins maîtrisé).',
    en: 'No look image: Mia only follows the prompt (less control over the look).',
  },
  model: { fr: 'LTX 2.5 · rendu 3D → réel', en: 'LTX 2.5 · 3D to real' },
  defaultPrompt: {
    fr: 'Photoreal cinematic live-action footage, natural light, realistic materials and skin, real film.',
    en: 'Photoreal cinematic live-action footage, natural light, realistic materials and skin, real film.',
  },
  tooLong: {
    fr: 'Ce plan ferait {n} tranches de 4 s (plus de {max}) : coupe-le d’abord avec le bloc « Couper ».',
    en: 'This shot would need {n} chunks of 4 s (more than {max}): trim it first with the “Trim” block.',
  },
  windowShort: {
    fr: 'La tranche {i} n’a rendu que {got} images sur {want}.',
    en: 'Chunk {i} only returned {got} of {want} frames.',
  },
  preview: { fr: 'Aperçu : {w} × {h}, {frames} premières images.', en: 'Preview: {w} × {h}, first {frames} frames.' },
  final: { fr: 'Rendu : {w} × {h}, {frames} images en {n} tranche(s).', en: 'Render: {w} × {h}, {frames} frames in {n} chunk(s).' },
  scaled: { fr: 'Source réduite à {w} × {h} pour tenir en mémoire.', en: 'Source reduced to {w} × {h} to fit in memory.' },
  blacks: { fr: 'Noirs du rendu conservés.', en: 'Render blacks kept.' },
  notLtx: { fr: 'Moteur non reconnu : LTX 2.5 utilisé.', en: 'Unknown engine: LTX 2.5 used.' },
};

/** Window starts covering n frames; the last one ends exactly at n (tool.longshot.windows). */
function windows(n, size = WINDOW, overlap = OVERLAP) {
  if (n <= size) return [0];
  const starts = [];
  let s = 0;
  while (s + size < n) { starts.push(s); s += size - overlap; }
  starts.push(n - size);
  return starts;
}

/**
 * Working geometry: optional rescale, then mirror padding up to multiples of 32.
 * Default (real): preview = 544 px short side, final = source size with the long side capped at 1920.
 * `short` (guided): that short side exactly (up or down), the long side still capped at `maxLong`.
 */
// mult : grille de la taille de travail (32 ; 64 quand l'IC-LoRA lit son guide à demi-résolution, Union-Control « ref0.5 »)
function geometry(meta, preview, { short = null, maxLong = MAX_LONG, mult = 32 } = {}) {
  let w = meta.w || 1080;
  let h = meta.h || 1920;
  let scaled = false;
  let k;
  if (short) k = Math.min(short / Math.min(w, h), maxLong / Math.max(w, h));
  else k = preview ? Math.min(1, PREVIEW_SHORT / Math.min(w, h)) : Math.min(1, maxLong / Math.max(w, h));
  if (Math.abs(k - 1) > 1e-3) { w = E.even(w * k); h = E.even(h * k); scaled = true; }
  const W = Math.ceil(w / mult) * mult;
  const H = Math.ceil(h / mult) * mult;
  const px = Math.floor((W - w) / 2);
  const py = Math.floor((H - h) / 2);
  const chain = ['format=gbrp'];
  if (scaled) chain.push(`scale=${w}:${h}:flags=lanczos`);
  const pad = [];
  if (W !== w || H !== h) {
    pad.push(`pad=${W}:${H}:${px}:${py}`,
      `fillborders=left=${px}:right=${W - w - px}:top=${py}:bottom=${H - h - py}:mode=mirror`);
  }
  chain.push(...pad);
  // the delivered frame: padding cropped back off (even size for yuv420p)
  const ow = w - (w % 2);
  const oh = h - (h % 2);
  // `cover`: any picture (look image, mask) brought to the same frame: fill w×h centred, then the same padding
  const cover = ['format=gbrp', `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos`, `crop=${w}:${h}`, ...pad]
    .join(',');
  return { w, h, W, H, px, py, ow, oh, scaled, vf: chain.join(','), cover, crop: `crop=${ow}:${oh}:${px}:${py}` };
}

function plan(x, meta) {
  const preview = x.mode === 'preview';
  const n = Math.max(1, meta.frames || 0);
  const F = preview ? Math.min(n, PREVIEW_FRAMES) : n;
  const starts = F <= WINDOW ? [0] : windows(F);
  const L = F <= WINDOW ? E.ceil8k1(F) : WINDOW;        // LTX wants 8k+1: the tail frame is cloned, then dropped
  return { preview, n, F, L, starts, geo: geometry(meta, preview) };
}

async function run(x) {
  E.begin(x);
  const src = E.input(x, 'video');
  // the look image is optional (catalog): without it, the render + the prompt drive the result
  const look = E.input(x, 'look', false);
  const meta = await E.metaOf(x, src);
  const fps = meta.fps || 24;
  const pl = plan(x, meta);
  const { F, L, starts, geo } = pl;
  if (!meta.frames) throw new Error(E.t('noFrames'));
  if (starts.length > MAX_WINDOWS) throw new Error(E.t(TXT.tooLong, { n: starts.length, max: MAX_WINDOWS }));
  const notes = [];

  let { prompt, negative } = E.promptOf(x);
  if (!prompt) prompt = E.t(TXT.defaultPrompt);
  const lora = await E.lora(x, 'ltx');
  prompt = E.loraPrompt(prompt, lora, notes);
  const m = E.model(x, 'model');
  const name = m && m.comfy && m.comfy.name;
  const unet = name && /ltx/i.test(name) ? name : LTX_INT8;
  if (name && unet !== name) notes.push(E.t(TXT.notLtx));
  const seed = E.seedOf(x);

  // progress budget: 4 % look upload, windows share 4–88 %, joining 88–92 %, final encode 92–100 %
  E.ranged(x, 0, 0.04)(0, E.t('uploading'));
  const upLook = look && look.abs ? await E.upload(x, look.abs) : null;
  if (!upLook) notes.push(E.t(TXT.noLook));
  const span = 0.84 / starts.length;
  const temps = [];
  const outs = [];                              // per window: abs PNG paths (+ file records for the next key)

  try {
    for (let k = 0; k < starts.length; k++) {
      const s = starts[k];
      const a = 0.04 + k * span;
      const msg = starts.length > 1 ? E.t('window', { i: k + 1, n: starts.length }) : E.t('computing');
      E.ranged(x, a, a + span)(0, msg);

      // the guide: this window's frames, rescaled/padded, exactly L frames
      const seg = E.tmp(x, `layout_w${k}.mp4`);
      temps.push(seg);
      await E.prepVideo(x, src, seg, { start: s, frames: L, vf: geo.vf, srcFps: fps, range: [a, a + span * 0.05] });
      const upSeg = await E.upload(x, seg);

      const g = P.load('ltx_layout_single');
      P.set(g, '5001', 'file', upSeg);
      // the look guide (9002:9042, at frame -1) is kept as a template for the continuity key below
      const guideTpl = P.clone(g['9002:9042']);
      if (upLook) P.set(g, '9009', 'image', upLook);
      else { P.bypass(g, '9002:9042', GUIDE_PASSTHROUGH); P.remove(g, '9009'); }
      P.set(g, '5508', 'value', prompt);
      P.set(g, '5509', 'value', negative);
      P.set(g, '5004:5602', 'unet_name', unet);
      P.set(g, '5516:4832', 'noise_seed', seed);
      if (lora) E.addLora(g, '5004:5606', lora, '9710');     // after the Layout-To-Render IC-LoRA
      if (k > 0) {
        // continuity (longshot.layout_long): the frame already generated at this window's start, as key 0,
        // read straight from ComfyUI's output folder
        const prev = outs[k - 1];
        const key = prev.files[s - starts[k - 1]];
        P.addNode(g, 'LoadImage', { image: E.annotated(key) }, '9800');
        const guide = guideTpl;
        guide.inputs.frame_idx = 0;
        guide.inputs.image = ['9800', 0];
        P.insertAfter(g, upLook ? '9002:9042' : '9002:5012', '980a', guide, GUIDE_PASSTHROUGH);
      }
      P.set(g, '9990', 'filename_prefix', E.prefix(x, `w${k}`, 'frame'));

      const res = await E.submit(x, g, { range: [a + span * 0.05, a + span],
        keep: starts.length > 1 ? `comfy_graph_w${k + 1}` : 'comfy_graph' });
      const files = await E.filesOrThrow(x, res.outputs, '9990');
      const want = Math.min(L, F - s);
      if (files.length < want) throw new Error(E.t(TXT.windowShort, { i: k + 1, got: files.length, want }));
      outs.push({ start: s, files, abs: files.map((f) => f.abs) });
    }

    // ---- join the windows (single window: just drop the cloned tail)
    E.ranged(x, 0.88, 0.92)(0, E.t('joining'));
    const seq = starts.length === 1 ? outs[0].abs.slice(0, F) : await join(x, outs, F, temps);

    // ---- one final encode: [keep blacks] -> crop the padding -> h264
    const dst = path.join(x.outDir, 'video.mp4');
    if (x.params.keepBlacks !== false) {
      const first = src.skipFirst ? 1 : 0;
      const srcChain = [`trim=start_frame=${first}:end_frame=${first + F}`, `setpts=N/(${fps})/TB`, geo.vf].join(',');
      const mask = ['format=rgb24',
        'colorchannelmixer=rr=0.3333:rg=0.3333:rb=0.3333:gr=0.3333:gg=0.3333:gb=0.3333:br=0.3333:bg=0.3333:bb=0.3333',
        'format=gbrp', 'gblur=sigma=8', `lut=c0='${DARK_LUT}':c1='${DARK_LUT}':c2='${DARK_LUT}'`,
        'tpad=start_mode=clone:start=6:stop_mode=clone:stop=6', `tmix=frames=13:weights='${DARK_TMIX}'`,
        'trim=start_frame=12', 'setpts=PTS-STARTPTS'].join(',');
      const complex = `[1:v]${srcChain},split[s1][s2];[s1]${mask}[m];[0:v]format=gbrp,setpts=N/(${fps})/TB[ai];`
        + `[ai][s2][m]maskedmerge,${geo.crop}[v]`;
      await E.framesToVideo(x, seq, dst, { fps, complex, extraInputs: ['-i', src.abs], count: F,
        range: [0.92, 1], msg: E.t('keepBlacks') });
      notes.push(E.t(TXT.blacks));
    } else {
      await E.framesToVideo(x, seq, dst, { fps, vf: geo.crop, count: F, range: [0.92, 1], msg: E.t('encoding') });
    }

    notes.unshift(pl.preview
      ? E.t(TXT.preview, { w: geo.ow, h: geo.oh, frames: F })
      : E.t(TXT.final, { w: geo.ow, h: geo.oh, frames: F, n: starts.length }));
    if (geo.scaled && !pl.preview) notes.push(E.t(TXT.scaled, { w: geo.ow, h: geo.oh }));
    return {
      outputs: { video: { abs: dst, kind: 'video', meta: { w: geo.ow, h: geo.oh, fps, frames: F } } },
      model: E.labelOf(m, E.t(TXT.model)),
      notes: E.notes(notes),
    };
  } finally {
    await E.cleanup(temps);
  }
}

/**
 * tool.longshot.assemble: switch from one window to the next at the overlap frame where both generations look
 * most alike, with a BLEND-frame fade centred on it. Returns the F frame paths (blends written to a temp dir).
 */
async function join(x, outs, F, temps) {
  const out = new Array(F).fill(null);          // { file } | { blend: [a, b, w] }
  const blendDir = E.tmp(x, 'blend');
  temps.push(blendDir);
  await fsp.mkdir(blendDir, { recursive: true });

  for (let k = 0; k < outs.length; k++) {
    const { start: s, abs } = outs[k];
    if (k === 0) {
      for (let i = 0; i < abs.length && s + i < F; i++) out[s + i] = { file: abs[i] };
      continue;
    }
    const prev = outs[k - 1];
    const end = Math.min(prev.start + prev.abs.length, F);       // end of the overlap (excluded)
    const lo = s + BLEND / 2;
    const hi = Math.max(lo, end - BLEND / 2 - 1);
    const g0 = await mostAlike(x, prev, outs[k], lo, hi, k);
    const a = g0 - BLEND / 2;
    const b = g0 + BLEND / 2;
    for (let i = 0; i < abs.length && s + i < F; i++) {
      const g = s + i;
      if (g < a) continue;
      if (g <= b && out[g] && out[g].file) out[g] = { blend: [out[g].file, abs[i], (g - a + 1) / (b - a + 2)] };
      else out[g] = { file: abs[i] };
    }
  }

  const list = [];
  for (let g = 0; g < F; g++) {
    const o = out[g];
    if (!o) throw new Error(E.t('noOutput'));
    if (o.file) { list.push(o.file); continue; }
    const [fa, fb, wgt] = o.blend;
    const dst = path.join(blendDir, `blend_${String(g).padStart(6, '0')}.png`);
    const expr = `A*${(1 - wgt).toFixed(4)}+B*${wgt.toFixed(4)}`;
    await E.ffmpeg(x, ['-i', fa, '-i', fb, '-filter_complex',
      `[0:v]format=gbrp[a];[1:v]format=gbrp[b];[a][b]blend=all_expr='${expr}'`, '-frames:v', '1', '-update', '1', dst],
    { what: 'blend' });
    list.push(dst);
  }
  return list;
}

/** Global index in [lo, hi] where the two windows differ least (136×240 grey thumbnails, mean |a-b|). */
async function mostAlike(x, prev, cur, lo, hi, k) {
  const mid = Math.round((lo + hi) / 2);
  if (hi <= lo) return lo;
  try {
    const A = await thumbs(x, prev.abs.slice(lo - prev.start, hi - prev.start + 1), `a${k}`);
    const B = await thumbs(x, cur.abs.slice(lo - cur.start, hi - cur.start + 1), `b${k}`);
    const n = Math.min(A.length, B.length);
    if (n < hi - lo + 1) return mid;            // unreadable thumbnails: middle of the overlap is a safe cut
    let best = lo;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      let d = 0;
      const a = A[i];
      const b = B[i];
      for (let p = 0; p < a.length; p++) d += Math.abs(a[p] - b[p]);
      if (d < bestD) { bestD = d; best = lo + i; }
    }
    return best;
  } catch (e) {
    if (e.cancelled) throw e;
    return mid;
  }
}

async function thumbs(x, files, tag) {
  const TW = 136;
  const TH = 240;
  const raw = E.tmp(x, `thumbs_${tag}.raw`);
  const inp = await E.framesInput(x, files, 24);
  try {
    await E.ffmpeg(x, [...inp.args, '-frames:v', String(files.length), '-vf', `scale=${TW}:${TH}:flags=area,format=gray`,
      '-f', 'rawvideo', raw], { what: 'thumbs' });
    const buf = await fsp.readFile(raw);
    const size = TW * TH;
    const list = [];
    for (let o = 0; o + size <= buf.length; o += size) list.push(buf.subarray(o, o + size));
    return list;
  } finally {
    await E.cleanup(raw, inp.tmpDir);
  }
}

function estimate(x) {
  try {
    const inp = (x.inputs && x.inputs.video) || {};
    const meta = inp.meta || {};
    const pl = plan(x, { w: meta.w || 1080, h: meta.h || 1920, frames: meta.frames || 97 });
    if (pl.preview) return 2;
    const px = (pl.geo.W * pl.geo.H) / (1088 * 1920);
    // lab: 6–10 min per 97-frame window at 1088×1920
    return 0.5 + pl.starts.length * (1 + 8 * Math.max(0.25, px));
  } catch { return x && x.mode === 'preview' ? 2 : 9; }
}

module.exports = { run: E.wrap(run), estimate, _plan: plan, _windows: windows, windows, geometry, join,
  WINDOW, OVERLAP, MAX_WINDOWS, GUIDE_PASSTHROUGH };
