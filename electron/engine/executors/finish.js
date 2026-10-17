'use strict';
// Exécuteur « Finition » : LUT d'étalonnage dosée, grain, vignettage (+ « Optique de cinéma » en option), en torch sur
// le GPU par le worker Python de Mia (python/tasks/finish.py, avec tool.lut_gpu et tool.finish_gpu, copie figée dans
// python/vendor). Bloc « heavy » : le moteur prend le verrou GPU avant de lancer le worker.
//
// LUT : un des looks « film » de luts/index.json (looks.js les résout ; « Etalo » vit dans le dossier du moteur et
// n'existe que là où il est installé), n'importe quel fichier .cube, ou aucune. Défaut : « Etalo doux », livré.
// Le son de la source est remis tel quel sur la vidéo finie (recopié ; réencodé en AAC seulement si le MP4 le refuse).

const fs = require('node:fs');
const path = require('node:path');
const { shared: S } = require('./export.js');
const { lookPath } = require('./looks.js');

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** Chemin de la LUT choisie, vérifié ; null = pas d'étalonnage. */
function lutPath(x) {
  const { tr } = S;
  const p = x.params || {};
  const look = String(p.look || 'etalo-doux');       // le défaut du catalogue : un look livré avec Mia
  if (look === 'none') return null;
  if (look === 'file') {
    const f = String(p.lutFile || '').trim();
    if (!f) throw S.userError(tr(x, 'Choisis un fichier .cube (réglage « Fichier LUT »).', 'Pick a .cube file (“LUT file” setting).'));
    if (!/\.cube$/i.test(f)) throw S.userError(tr(x, `Une LUT doit être un fichier .cube (${path.basename(f)}).`, `A LUT must be a .cube file (${path.basename(f)}).`));
    if (!fs.existsSync(f)) throw S.userError(tr(x, `Fichier LUT introuvable : ${f}`, `LUT file not found: ${f}`));
    return f;
  }
  return lookPath(x, look);                          // un look de luts/index.json
}

/** Remet le son de la source sur la vidéo finie (muette). Recopie d'abord, AAC si le conteneur refuse le codec. */
async function putSoundBack(x, silent, info) {
  const tmp = path.join(x.outDir, 'out_son.mp4');
  const base = ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-i', silent, '-i', info.abs,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy'];
  const tail = ['-movflags', '+faststart', tmp];
  if (info.skip) {
    // la 1re image ignorée (rendu Unreal) : le son recule d'autant pour rester calé
    await S.ff(x, [...base, '-af', `atrim=start=${(1 / info.fps).toFixed(6)},asetpts=PTS-STARTPTS`, ...S.audioArgs(192), ...tail]);
  } else {
    try {
      await S.ff(x, [...base, '-c:a', 'copy', ...tail]);
    } catch (e) {
      if (e.cancelled) throw e;
      x.log(`recopie du son refusée (${e.message}) : réencodage AAC`);
      await S.ff(x, [...base, ...S.audioArgs(192), ...tail]);
    }
  }
  fs.renameSync(tmp, silent);
}

async function run(x) {
  const { tr } = S;
  const inp = x.inputs.media;
  if (!inp || !inp.abs) throw S.userError(tr(x, 'Branche une image ou une vidéo.', 'Connect an image or a video.'));
  const p = x.params || {};
  const lut = lutPath(x);
  const info = await S.inspect(x, inp);
  x.progress(0, tr(x, 'Démarrage de la finition…', 'Starting the finish…'));

  const outputs = await S.runWorker(x, 'finish', {
    engineRoot: x.engineRoot || null,
    inputs: {
      media: { abs: inp.abs, kind: inp.kind || info.kind, meta: inp.meta || {},
        skipFirst: !!(inp.skipFirst || (inp.meta && inp.meta.skipFirst)) },
    },
    params: {
      lut,
      lutStrength: Math.max(0, Math.min(150, num(p.lutStrength, 100))) / 100,
      grain: Math.max(0, Math.min(6, num(p.grain, 2))),
      vignette: Math.max(0, Math.min(30, num(p.vignette, 6))) / 100,
      film: !!p.film,
      keepReds: lut && p.warm ? 1 : 0,                  // tool.lut_gpu « garde_chauds » (salle rouge, lèvres)
    },
  });
  const out = outputs.out;
  if (!out) throw S.userError(tr(x, 'La finition n’a rien produit.', 'The finish produced nothing.'));
  if (out.kind === 'video' && info.hasAudio) {
    x.progress(0.99, tr(x, 'Remise du son…', 'Putting the sound back…'));
    await putSoundBack(x, out.abs, info);
  }
  x.progress(1, tr(x, 'Finition terminée', 'Finish done'));
  return {
    outputs: { out },
    notes: { lut: lut ? path.basename(lut) : null },
  };
}

/** Minutes estimées : ~0,03 s par image en 1080p sur le GPU, lecture et encodage compris. */
function estimate(x) {
  const m = x && x.inputs && x.inputs.media && x.inputs.media.meta;
  const frames = (m && m.frames) || 1;
  const px = ((m && m.w) || 1920) * ((m && m.h) || 1080);
  return Math.max(0.2, (10 + frames * 0.03 * (px / (1920 * 1080))) / 60);
}

module.exports = { run, estimate };
