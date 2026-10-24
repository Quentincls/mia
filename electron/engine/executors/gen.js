'use strict';
// Model block (« Modèle », SPEC §23): one block per model family. The planner (engine/index.js planGen, with the
// shared rules of src/js/nodes/route.js) already chose the workflow from what is connected and the model doing
// it; this executor hands the job to the executor that already does that workflow (i2v, t2v, ref2v, guided,
// real, perform, edit — tested, unchanged), or to the online one (cloud.js). The block's settings and inputs keep
// the ids of those blocks, so nothing is translated on the way.
const NODES = require('../../../src/catalog/nodes.json');

const typeOf = (id) => NODES.types.find((t) => t.id === id) || null;

/** The job context seen by the executor that does the workflow: its own catalog type, the inputs it reads. */
function forTarget(x) {
  const g = x.gen;
  const type = typeOf(g.as);
  if (!type) throw new Error(`Model block: unknown workflow « ${g.as} »`);
  // the task block's inputs, plus those of the workflow the Model block chose (images-clés, son à suivre…)
  const wanted = new Set([...(type.inputs || []).map((i) => i.id), ...(Array.isArray(g.ports) ? g.ports : [])]);
  const inputs = {};
  for (const [k, v] of Object.entries(x.inputs || {})) if (wanted.has(k)) inputs[k] = v;
  return { ...x, type, inputs };
}

async function run(x) {
  const g = x.gen;
  if (!g) throw new Error('Model block without a plan (gen).');
  if (g.provider !== 'local') return require('./cloud.js').run(x);
  const exec = require(`./${g.executor}.js`);
  return exec.run(forTarget(x));
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
