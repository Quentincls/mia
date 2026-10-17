'use strict';
// Exécuteur « Extraire une image » : une image précise d'une vidéo, en PNG sans perte.
//
// Exactitude d'abord : on choisit l'image par son NUMÉRO de décodage (filtre select, n = index), jamais par un temps
// (un « -ss » tombe à côté d'une image sur les vidéos à cadence variable des téléphones). Le compte d'images est
// exact (recopie des paquets sans décoder) : -1 = la dernière, un numéro trop grand est ramené à la dernière.
//
// Numérotation à partir de 0, partout (messages, nom de fichier, lecteur du bloc « IMG 48 / 120 », outils du labo) :
// l'image 48 d'un clip « clip_mara.mp4 » donne « clip_mara_f0048.png » (SPEC §14).

const path = require('node:path');
const { shared: S } = require('./export.js');

/** « clip_mara_f0048.png » : nom de la source + numéro d'image sur 4 chiffres au moins. */
function frameName(info, at) {
  const stem = S.cleanName(path.parse(info.abs).name).slice(0, 100) || 'image';
  return `${stem}_f${String(at).padStart(4, '0')}.png`;
}

async function run(x) {
  const { tr } = S;
  const input = x.inputs.video;
  if (!input || !input.abs) throw S.userError(tr(x, 'Branche une vidéo.', 'Connect a video.'));
  const report = S.reporter(x);
  report(0, tr(x, 'Lecture de la vidéo…', 'Reading the video…'));
  const info = await S.inspect(x, input, { exact: true });
  const pixfmt = info.alpha ? 'rgba' : 'rgb24';

  // Une image branchée par erreur : on la rend telle quelle (en PNG), c'est ce qu'on attend d'« extraire ».
  if (info.kind === 'image') {
    const out = path.join(x.outDir, frameName(info, 0));
    await S.ff(x, ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-i', info.abs, '-frames:v', '1', '-vf', `format=${pixfmt}`, out]);
    return { outputs: { image: { abs: out, kind: 'image', meta: { w: info.w, h: info.h } } }, notes: { frame: 0, frames: 1 } };
  }

  const total = info.frames || 0;
  if (info.exact && total <= 0) throw S.userError(tr(x, 'Aucune image lisible dans cette vidéo.', 'No readable frame in this video.'));
  let at = Math.round(Number(x.params.at));
  if (!Number.isFinite(at)) at = 0;
  if (at < 0) at = total + at;                          // -1 = dernière, -2 = avant-dernière…
  if (total > 0 && at >= total) {
    x.log(`image ${at} demandée, la vidéo en a ${total} (0 à ${total - 1}) : on prend la dernière`);
    at = total - 1;
  }
  at = Math.max(0, at);
  const index = at + info.skip;                         // « Ignorer la 1re image » décale tout d'un cran
  const of = total ? ` / ${total}` : '';                // même affichage que le compteur du lecteur : « IMG 48 / 120 »

  const out = path.join(x.outDir, frameName(info, at));
  const msg = tr(x, `Image ${at}${of}…`, `Frame ${at}${of}…`);
  await S.ff(x, ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...S.decoderArgs(info), '-i', info.abs,
    '-map', '0:v:0', '-an', '-sn', '-vf', `select='eq(n,${index})',format=${pixfmt}`,
    '-fps_mode', 'passthrough', '-frames:v', '1', '-compression_level', '4', out],
  { duration: Math.max(0.04, (index + 1) / (info.fps || 24)), onProgress: report.span(0.05, 0.95, msg) });

  if (!S.fileOk(out)) {
    throw S.userError(tr(x, `Impossible de lire l’image ${at}${of} de cette vidéo.`, `Could not read frame ${at}${of} of this video.`));
  }
  report(1, tr(x, `Image ${at}${of} extraite`, `Frame ${at}${of} extracted`));
  return {
    outputs: { image: { abs: out, kind: 'image', meta: { w: info.w, h: info.h, alpha: info.alpha || undefined } } },
    notes: { frame: at, frames: total || undefined },
  };
}

module.exports = { run, estimate: () => 0.1 };
