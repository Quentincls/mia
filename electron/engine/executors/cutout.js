'use strict';
// Exécuteur « Détourer » : BiRefNet par le worker Python de Mia (python/tasks/cutout.py), sur le GPU, sous le verrou
// pris par le moteur (bloc « heavy »).
//
// Sorties : « mask » (niveaux de gris) et « cut » (sujet sur fond noir, vert, ou transparent : PNG pour une image,
// WebM VP9 pour une vidéo). Le modèle vient de l'inventaire (capacité « cutout ») ; à défaut, le worker le cherche
// dans <engineRoot>\models\outils\BiRefNet.

const { shared: S } = require('./export.js');

const BACKGROUNDS = ['black', 'green', 'alpha'];

async function run(x) {
  const { tr } = S;
  const input = x.inputs.media;
  if (!input || !input.abs) throw S.userError(tr(x, 'Branche une image ou une vidéo à détourer.', 'Connect an image or a video to cut out.'));
  const model = typeof x.model === 'function' ? x.model('model') : null;
  const p = x.params || {};
  x.progress(0, tr(x, 'Démarrage du détourage…', 'Starting the cutout…'));

  const outputs = await S.runWorker(x, 'cutout', {
    engineRoot: x.engineRoot || null,
    modelPath: (model && model.path) || null,
    inputs: { media: { abs: input.abs, kind: input.kind, meta: input.meta || {}, skipFirst: !!(input.skipFirst || (input.meta && input.meta.skipFirst)) } },
    params: {
      background: BACKGROUNDS.includes(p.background) ? p.background : 'black',
      feather: clampNum(p.feather, 0, 20, 1),
      grow: clampNum(p.grow, -10, 10, 0),
    },
  });
  if (!outputs.mask || !outputs.cut) {
    throw S.userError(tr(x, 'Le détourage n’a pas rendu ses deux fichiers (masque et détouré).',
      'The cutout did not return both files (mask and cut).'));
  }
  x.progress(1, tr(x, 'Détourage terminé', 'Cutout done'));
  return { outputs: { mask: outputs.mask, cut: outputs.cut }, model: S.modelLabel(x, model, 'BiRefNet') };
}

function clampNum(v, min, max, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
}

/** Minutes estimées : ~0,1 s par image sur le GPU + ~20 s de chargement du modèle. */
function estimate(x) {
  const m = x && x.inputs && x.inputs.media && x.inputs.media.meta;
  const frames = (m && m.frames) || 1;
  return Math.max(0.5, (20 + frames * 0.12) / 60);
}

module.exports = { run, estimate };
