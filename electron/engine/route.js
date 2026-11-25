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
let builtinCloud = null;
let extraOf = () => null;      // the watch's extra catalog (electron/cloudwatch.js), merged after the shipped one

/** findModel, familyOf, chooseWorkflow, needsOf, portsOfFamily, portsOfWorkflow, localModelFor, localKeyOf. */
function load() {
  if (rules) return rules;
  const src = fs.readFileSync(path.join(SRC, 'js', 'nodes', 'route.js'), 'utf8').replace(/^export /gm, '');
  // eslint-disable-next-line no-new-func
  rules = new Function(`${src}\nreturn { findModel, familyOf, localKeyOf, portsOfWorkflow, portsOfFamily, chooseWorkflow, needsOf, localModelFor };`)();
  return rules;
}

const read = (f, empty) => { try { return JSON.parse(fs.readFileSync(path.join(SRC, 'catalog', f), 'utf8')); } catch { return empty; } };

/** The shipped online catalog alone (cloud-higgsfield.json), what the watch compares the pages with. */
function builtin() {
  if (!builtinCloud) builtinCloud = read('cloud-higgsfield.json', { families: [] });
  return builtinCloud;
}

/**
 * { local: model-families.json, cloud: cloud-higgsfield.json + the models the watch installed (SPEC §23.8) }
 * (read once, again after reload(); an unreadable file counts as empty, a broken extra catalog is ignored).
 */
function cats() {
  if (catalogs) return catalogs;
  let cloud = builtin();
  try { cloud = require('../cloudwatch').mergeCatalog(cloud, extraOf()); } catch { /* the shipped catalog alone */ }
  catalogs = { local: read('model-families.json', { families: {} }), cloud };
  return catalogs;
}

/** The watch installed a model: read the catalogs again on their next use. */
function reload() { catalogs = null; }
/** fn() → the extra catalog (or null). */
function setExtra(fn) { extraOf = typeof fn === 'function' ? fn : () => null; catalogs = null; }

module.exports = { rules: load, catalogs: cats, builtin, reload, setExtra };
