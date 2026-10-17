'use strict';
// Exécuteur « Redimensionner » : change la taille d'une image ou d'une vidéo.
//
// « Ajuster » (contain) garde toute l'image et complète par des bandes noires ; « Remplir » (cover) remplit le cadre
// et recadre au centre. ×2 / ×½ gardent les proportions. Mise à l'échelle lanczos. Jamais de changement de cadence
// ici : la règle du labo veut une interpolation (RIFE), jamais des images répétées.
// Une image transparente reste transparente (bandes transparentes) ; une vidéo transparente reste en WebM alpha.

const path = require('node:path');
const { shared: S } = require('./export.js');

/** Taille visée d'après le préréglage ; null pour les facteurs (×2, ×½). */
function target(size) {
  const m = /^(\d+)x(\d+)$/.exec(String(size || ''));
  if (m) return { w: +m[1], h: +m[2] };
  const f = /^x([\d.]+)$/.exec(String(size || ''));
  return { factor: f ? Math.max(0.05, Math.min(8, parseFloat(f[1]))) : 1 };
}

async function run(x) {
  const { tr } = S;
  const input = x.inputs.media;
  if (!input || !input.abs) throw S.userError(tr(x, 'Branche une image ou une vidéo.', 'Connect an image or a video.'));
  const report = S.reporter(x);
  report(0, tr(x, 'Lecture…', 'Reading…'));
  const info = await S.inspect(x, input);
  const isVideo = info.kind === 'video';
  const t = target(x.params.size);
  const fit = x.params.fit === 'cover' ? 'cover' : 'contain';
  const alpha = info.alpha;
  // Vidéo 4:2:0 : côtés pairs obligatoires. Image : n'importe quelle taille.
  const round = (v) => (isVideo ? S.even(v) : Math.max(1, Math.round(v)));

  let W, H, chain;
  if (t.factor) {
    W = round(info.w * t.factor); H = round(info.h * t.factor);
    chain = [`scale=${W}:${H}:flags=lanczos`];
  } else {
    W = t.w; H = t.h;
    const div = isVideo ? ':force_divisible_by=2' : '';
    chain = fit === 'cover'
      ? [`scale=${W}:${H}:force_original_aspect_ratio=increase${div}:flags=lanczos`, `crop=${W}:${H}`]
      : [`scale=${W}:${H}:force_original_aspect_ratio=decrease${div}:flags=lanczos`,
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${alpha ? 'black@0' : 'black'}`];
  }
  if (info.skip) chain.unshift('trim=start_frame=1', 'setpts=PTS-STARTPTS');
  chain.push('setsar=1');

  const msg = tr(x, `Redimensionnement en ${W} × ${H}…`, `Resizing to ${W} × ${H}…`);
  const common = ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...S.decoderArgs(info), '-i', info.abs];
  let out;
  if (!isVideo) {
    out = path.join(x.outDir, 'out.png');
    // L'alpha n'entre dans le calcul que s'il existe : un PNG opaque reste en RGB (deux fois plus léger).
    const vf = [...(alpha ? ['format=rgba'] : []), ...chain, alpha ? 'format=rgba' : 'format=rgb24'].join(',');
    report(0.3, msg);
    await S.ff(x, [...common, '-frames:v', '1', '-vf', vf, '-compression_level', '4', out]);
  } else if (alpha) {
    out = path.join(x.outDir, 'out.webm');
    await S.ff(x, [...common, '-map', '0:v:0', '-vf', ['format=yuva420p', ...chain, 'format=yuva420p'].join(','),
      ...S.vp9AlphaArgs(), '-an', out], { duration: info.duration, onProgress: report.span(0.03, 0.98, msg) });
  } else {
    out = path.join(x.outDir, 'out.mp4');
    const af = info.skip ? ['-af', `atrim=start=${(1 / info.fps).toFixed(6)},asetpts=PTS-STARTPTS`] : [];
    await S.encode(x, (nv) => [...common, '-map', '0:v:0', ...(info.hasAudio ? ['-map', '0:a:0?'] : []),
      '-vf', [...chain, 'format=yuv420p'].join(','), ...S.h264Args(nv, { cq: 14, gop: 12 }),
      ...(info.hasAudio ? [...af, ...S.audioArgs(192)] : ['-an']), out],
    { duration: info.duration, onProgress: report.span(0.03, 0.98, msg) });
  }
  if (!S.fileOk(out)) throw S.userError(tr(x, 'Le redimensionnement n’a rien produit.', 'Resizing produced nothing.'));
  report(1, tr(x, `Redimensionné en ${W} × ${H}`, `Resized to ${W} × ${H}`));
  // Compte exact du résultat (recopie des paquets, sans décoder) : l'estimation « durée × cadence » de l'import
  // peut compter une image de trop quand le son est plus long que l'image.
  const n = isVideo ? (await S.countFrames(x, out)) || info.frames : null;
  const meta = isVideo
    ? { w: W, h: H, fps: info.fps, frames: n || undefined, duration: n ? n / info.fps : info.duration || undefined, alpha: alpha || undefined }
    : { w: W, h: H, alpha: alpha || undefined };
  return { outputs: { out: { abs: out, kind: isVideo ? 'video' : 'image', meta } } };
}

module.exports = { run, estimate: (x) => {
  const m = x && x.inputs && x.inputs.media && x.inputs.media.meta;
  return Math.max(0.1, Math.min(5, ((m && m.duration) || 5) / 60));
} };
