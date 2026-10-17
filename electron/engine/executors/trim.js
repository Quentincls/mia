'use strict';
// Exécuteur « Couper » : garde les images [début, fin] (incluses) d'une vidéo.
//
// Méthode du labo (tool/shots.py, extract) : filtre trim par NUMÉRO d'image puis horodatage reconstruit image par
// image (setpts=N/(fps·TB)) — sinon trim laisse une cadence bancale (30,25) et perd la dernière image. Réencodage
// h264_nvenc cq 14 (fichier de travail, GOP court pour défiler image par image dans le bloc). Le son suit.
// Une vidéo transparente (WebM VP9 alpha, sortie « Détouré ») reste transparente.

const path = require('node:path');
const { shared: S } = require('./export.js');

async function run(x) {
  const { tr } = S;
  const input = x.inputs.video;
  if (!input || !input.abs) throw S.userError(tr(x, 'Branche une vidéo.', 'Connect a video.'));
  const report = S.reporter(x);
  report(0, tr(x, 'Lecture de la vidéo…', 'Reading the video…'));
  // Compte exact (recopie des paquets, sans décoder) : -1 et les bornes trop grandes se décident sur le vrai nombre.
  const info = await S.inspect(x, input, { exact: true });
  if (info.kind !== 'video') throw S.userError(tr(x, 'Couper attend une vidéo, pas une image.', 'Trim expects a video, not an image.'));

  const start = Math.max(0, Math.round(Number(x.params.start) || 0));
  let end = Math.round(Number(x.params.end));
  if (!Number.isFinite(end)) end = -1;
  const total = info.frames || 0;
  if (end < 0) end = total ? total + end : -1;          // -1 = jusqu'à la dernière image
  if (total) {
    if (start >= total) {
      throw S.userError(tr(x, `Le début (image ${start}) est après la dernière image de la vidéo (${total - 1}, numérotées à partir de 0).`,
        `The start (frame ${start}) is past the last frame of the video (${total - 1}, numbered from 0).`));
    }
    end = Math.min(end, total - 1);
  }
  if (end >= 0 && end < start) {
    throw S.userError(tr(x, `La fin (${end}) est avant le début (${start}).`, `The end (${end}) is before the start (${start}).`));
  }

  const fps = S.fpsExpr(info.fps);
  const s = start + info.skip;
  const e = end >= 0 ? end + info.skip : -1;
  const frames = e >= 0 ? e - s + 1 : Math.max(1, total - start);
  const vf = [`trim=start_frame=${s}${e >= 0 ? `:end_frame=${e + 1}` : ''}`, `setpts=N/(${fps}*TB)`,
    (info.w % 2 || info.h % 2) ? 'scale=trunc(iw/2)*2:trunc(ih/2)*2' : null].filter(Boolean).join(',');
  const t0 = s / info.fps;
  const af = `atrim=start=${t0.toFixed(6)}${e >= 0 ? `:end=${((e + 1) / info.fps).toFixed(6)}` : ''},asetpts=PTS-STARTPTS`;

  const alpha = info.alpha;
  const out = path.join(x.outDir, alpha ? 'video.webm' : 'video.mp4');
  // Numéros à partir de 0, comme le lecteur du bloc (« IMG 24 / 121 ») et les fichiers « _f0024 ».
  const last = end >= 0 ? end : '…';
  const of = total ? ` / ${total}` : '';
  const msg = tr(x, `Coupe : images ${start} à ${last}${of}…`, `Trim: frames ${start} to ${last}${of}…`);
  const common = ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...S.decoderArgs(info), '-i', info.abs, '-map', '0:v:0'];
  const opts = { duration: frames / info.fps, onProgress: report.span(0.03, 0.98, msg) };
  if (alpha) {
    await S.ff(x, [...common, '-vf', `${vf},format=yuva420p`, ...S.vp9AlphaArgs(), '-r', fps, '-fps_mode', 'cfr', '-an', out], opts);
  } else {
    await S.encode(x, (nv) => [...common, ...(info.hasAudio ? ['-map', '0:a:0?'] : []), '-vf', vf,
      '-r', fps, '-fps_mode', 'cfr', ...S.h264Args(nv, { cq: 14, gop: 12 }),
      ...(info.hasAudio ? ['-af', af, ...S.audioArgs(192)] : ['-an']), out], opts);
  }
  if (!S.fileOk(out)) throw S.userError(tr(x, 'Rien n’a été produit : vérifie le début et la fin.', 'Nothing was produced: check the start and end.'));
  const n = (await S.countFrames(x, out)) || frames;       // compte exact, pour la frise du bloc
  const lastKept = end >= 0 ? end : start + n - 1;
  report(1, tr(x, `Coupé : ${n} images (${start} à ${lastKept})`, `Trimmed: ${n} frames (${start} to ${lastKept})`));
  return {
    outputs: { video: { abs: out, kind: 'video', meta: { w: info.w - (info.w % 2), h: info.h - (info.h % 2), fps: info.fps, frames: n, duration: n / info.fps, alpha: alpha || undefined } } },
    notes: { start, end: lastKept, frames: n },
  };
}

module.exports = { run, estimate: (x) => {
  const m = x && x.inputs && x.inputs.video && x.inputs.video.meta;
  return Math.max(0.1, Math.min(5, ((m && m.duration) || 10) / 60));
} };
