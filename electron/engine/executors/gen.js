'use strict';
// Model block (« Modèle », SPEC §23): one block per model family. The planner (engine/index.js planGen, with the
// shared rules of src/js/nodes/route.js) already chose the workflow from what is connected and the model doing
// it; this executor hands the job to the executor that already does that workflow (i2v, t2v, ref2v, guided,
// real, perform, edit — tested, unchanged), or to the online one (cloud.js). The block's settings and inputs keep
// the ids of those blocks, so nothing is translated on the way.
const NODES = require('../../../src/catalog/nodes.json');
const P = require('../patch');

const E = P.exec;
const typeOf = (id) => NODES.types.find((t) => t.id === id) || null;

const TXT = {
  startAsLook: { fr: 'La vidéo guidée part de ton image de début.', en: 'The guided video starts from your start image.' },
  startAsLookReal: { fr: 'Ton image de début sert d’image de look.', en: 'Your start image is used as the look image.' },
  startIgnored: { fr: 'Image de début ignorée : l’image de look sert déjà.', en: 'Start image ignored: the look image is already used.' },
};

/**
 * The job context seen by the executor that does the workflow: its own catalog type, the inputs it reads, and the
 * settings that workflow shows over the task block's defaults (a setting the Model block hides — « À éviter », a LoRA
 * kept from another workflow — does not reach the run: the same job gives the same result as the task block).
 * Guided video and photoreal take the Start image as their look image when there is none (audit 25/10).
 */
function forTarget(x) {
  const g = x.gen;
  const type = typeOf(g.as);
  if (!type) throw new Error(`Model block: unknown workflow « ${g.as} »`);
  // the task block's inputs, plus those of the workflow the Model block chose (images-clés, son à suivre…)
  const wanted = new Set([...(type.inputs || []).map((i) => i.id), ...(Array.isArray(g.ports) ? g.ports : [])]);
  const inputs = {};
  for (const [k, v] of Object.entries(x.inputs || {})) if (wanted.has(k)) inputs[k] = v;
  const notes = [];
  if ((g.as === 'guided' || g.as === 'real') && inputs.start) {
    if (!inputs.look) { inputs.look = inputs.start; notes.push(E.t(g.as === 'guided' ? TXT.startAsLook : TXT.startAsLookReal)); }
    else notes.push(E.t(TXT.startIgnored));
    delete inputs.start;
  }
  let params = x.params;
  if (Array.isArray(g.params)) {
    params = {};
    for (const p of type.params || []) if (p.default !== undefined) params[p.id] = p.default;
    for (const id of ['model', 'prompt', ...g.params]) if (x.params && x.params[id] !== undefined) params[id] = x.params[id];
  }
  return { ...x, type, inputs, params, _genNotes: notes };
}

async function run(x) {
  const g = x.gen;
  if (!g) throw new Error('Model block without a plan (gen).');
  if (g.provider !== 'local') return require('./cloud.js').run(x);
  const exec = require(`./${g.executor}.js`);
  const fx = forTarget(x);
  const res = await exec.run(fx);
  if (res && fx._genNotes.length) res.notes = [...fx._genNotes, res.notes].filter(Boolean).join('\n');
  return res;
}

function estimate(x) {
  const g = x && x.gen;
  if (!g) return null;
  try {
    if (g.provider !== 'local') return require('./cloud.js').estimate(x);
    const exec = require(`./${g.executor}.js`);
    return typeof exec.estimate === 'function' ? exec.estimate(forTarget(x)) : null;
  } catch { return null; }
}

module.exports = { run, estimate, _forTarget: forTarget };
