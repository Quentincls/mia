'use strict';
// Exécuteur « Superposer » : pose le calque sur le fond à travers un masque, en torch sur le GPU, par le worker
// Python de Mia (python/tasks/composite.py). Bloc « heavy » (SPEC §16) : c'est du CUDA, le moteur prend donc le verrou
// GPU du labo avant de lancer le worker ; le worker rend sa mémoire GPU en fin de tâche.
//
// Le masque est l'entrée « Masque » si elle est branchée, sinon la transparence du calque. Le résultat suit le fond
// (image ou vidéo) ; une vidéo a la cadence du fond et la longueur de la plus courte des vidéos branchées.
// « Accorder les couleurs » : transfert Lab moyenne/écart à 75 % (méthode d'un script de l'auteur).

const { shared: S } = require('./export.js');

const MATCH_STRENGTH = 0.75;

const spec = (inp) => (inp && inp.abs
  ? { abs: inp.abs, kind: inp.kind, meta: inp.meta || {}, skipFirst: !!(inp.skipFirst || (inp.meta && inp.meta.skipFirst)) }
  : null);

async function run(x) {
  const { tr } = S;
  const { bg, fg, mask } = x.inputs;
  if (!bg || !bg.abs) throw S.userError(tr(x, 'Branche un fond.', 'Connect a background.'));
  if (!fg || !fg.abs) throw S.userError(tr(x, 'Branche un calque à poser sur le fond.', 'Connect a layer to place over the background.'));
  const p = x.params || {};
  const feather = Number.isFinite(Number(p.feather)) ? Math.max(0, Math.min(20, Number(p.feather))) : 2;
  x.progress(0, tr(x, 'Démarrage de la superposition…', 'Starting the composite…'));

  const outputs = await S.runWorker(x, 'composite', {
    engineRoot: x.engineRoot || null,
    inputs: { bg: spec(bg), fg: spec(fg), mask: spec(mask) },
    params: { feather, match: !!p.match, strength: MATCH_STRENGTH },
  });
  if (!outputs.out) throw S.userError(tr(x, 'La superposition n’a rien produit.', 'The composite produced nothing.'));
  x.progress(1, tr(x, 'Superposition terminée', 'Composite done'));
  return { outputs: { out: outputs.out } };
}

/** Minutes estimées : ~0,05 s par image (deux passages si l'accord des couleurs est demandé). */
function estimate(x) {
  const m = x && x.inputs && x.inputs.bg && x.inputs.bg.meta;
  const frames = (m && m.frames) || 1;
  return Math.max(0.2, (8 + frames * (x.params && x.params.match ? 0.09 : 0.05)) / 60);
}

module.exports = { run, estimate };
