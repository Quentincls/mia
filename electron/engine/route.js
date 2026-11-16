'use strict';
// Model block (SPEC §23): the engine side of « what does this block do? ».
// The rules live ONCE, in src/js/nodes/route.js (an ES module without imports, also used by the board); the
// engine loads that file with its `export` keywords removed, so the board and the engine can never disagree on
// which workflow a block runs. The two catalogs it reads are the same files the board reads.
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src');
let rules = null;
let catalogs = null;

/** familyOf, chooseWorkflow, needsOf, portsOfFamily, portsOfWorkflow, localModelFor, localKeyOf. */
function load() {
  if (rules) return rules;
  const src = fs.readFileSync(path.join(SRC, 'js', 'nodes', 'route.js'), 'utf8').replace(/^export /gm, '');
  // eslint-disable-next-line no-new-func
  rules = new Function(`${src}\nreturn { familyOf, localKeyOf, portsOfWorkflow, portsOfFamily, chooseWorkflow, needsOf, localModelFor };`)();
  return rules;
}

/** { local: model-families.json, cloud: cloud-higgsfield.json } (read once; an unreadable file counts as empty). */
function cats() {
  if (catalogs) return catalogs;
  const read = (f, empty) => { try { return JSON.parse(fs.readFileSync(path.join(SRC, 'catalog', f), 'utf8')); } catch { return empty; } };
  catalogs = { local: read('model-families.json', { families: {} }), cloud: read('cloud-higgsfield.json', { families: [] }) };
  return catalogs;
}

module.exports = { rules: load, catalogs: cats };
