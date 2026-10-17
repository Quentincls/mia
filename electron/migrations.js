'use strict';
/**
 * Mia — versions of the data formats and the chain of migrations applied when a file is loaded (SPEC §21.1).
 *
 * Every file Mia keeps carries the version of its format:
 *   graph.json    { version, … }   a board (« planche »)
 *   project.json  { version, … }   the identity of a board
 *   folder.json   { version, … }   a project (« projet » = folder of boards)
 *   prefs.json    { version, … }   the preferences
 *   loras.json    [ … ]            the LoRA registry: a plain list has no room for a number, so its shape is its
 *                                  version (a list = 1; a later format would be { version, items })
 * A file without a version is format 0: written before Mia 0.5, or by hand.
 *
 * migrate(kind, doc) walks the steps from the document's version up to the current one. Today every step is a
 * no-op that only stamps the version — the chain is where the next change of format goes: add a function at
 * the end of STEPS[kind] (it receives version N, returns version N + 1) and the current version follows.
 * Whoever writes that format must write the new number too: graph.json is written by the editor
 * (src/js/graph/doc.js, « version: 1 »), the others by store.js; add a case to tools/test-migrations.js.
 *
 * Rules (never lose anything):
 *   - a step adds or renames; it never drops a key it does not understand (other versions may need it);
 *   - before a newer version is written over a file, the old file is copied once to « <file>.bak-v<old> »
 *     (backupOnce; migrateFile does it as soon as a document is upgraded in memory, before anyone saves);
 *   - a document written by a NEWER Mia (version above the current one) is left as it is and flagged `newer`:
 *     the store then opens such a board read-only, so an older Mia never writes over what it cannot read;
 *   - a step that throws leaves the original document, flagged `failed` (treated like `newer`).
 */
const fsp = require('node:fs/promises');

const STR = {
  newer: {
    fr: 'Cette planche a été enregistrée par une version plus récente de Mia (format {v}, celle-ci lit jusqu’au format {max}). Elle est ouverte en lecture seule pour ne rien abîmer : mets Mia à jour pour la modifier.',
    en: 'This board was saved by a newer version of Mia (format {v}; this one reads up to format {max}). It is open read-only so nothing gets damaged: update Mia to edit it.'
  },
  failed: {
    fr: 'Cette planche n’a pas pu être mise au format de cette version de Mia ({msg}). Elle est ouverte en lecture seule ; le fichier n’a pas été modifié.',
    en: 'This board could not be brought to this version’s format ({msg}). It is open read-only; the file was not changed.'
  }
};

/**
 * STEPS[kind][n] turns a document of version n into version n + 1 (in place or as a new object; returned).
 * The current version of a kind is STEPS[kind].length.
 */
const STEPS = {
  graph: [
    // 0 → 1: the format of Mia 0.1 (SPEC §3.2); an older document only gains its number
    (g) => g
  ],
  project: [
    (p) => p
  ],
  folder: [
    (f) => f
  ],
  prefs: [
    // 0 → 1: prefs.json had no version up to Mia 0.4. Prefs without one come from that Mia: say so, so the
    // first start of this version shows « Nouveautés » (a fresh install has no prefs.json, hence no toast).
    (p) => {
      if (p.lastSeenVersion === undefined) p.lastSeenVersion = '0.4.0';
      return p;
    }
  ],
  loras: [
    (l) => l
  ]
};

const KINDS = Object.keys(STEPS);
const CURRENT = Object.freeze(Object.fromEntries(KINDS.map((k) => [k, STEPS[k].length])));

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The format version a document says it has (0 when it says nothing). */
function versionOf(kind, doc) {
  if (kind === 'loras' && Array.isArray(doc)) return 1;
  if (!isObj(doc)) return null;
  const v = Number(doc.version);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function stamp(kind, doc, v) {
  if (kind === 'loras' && Array.isArray(doc)) return doc;   // a list carries no number (version 1)
  doc.version = v;
  return doc;
}

/**
 * Bring a parsed document to the current format of its kind.
 * @returns {{doc, from:number|null, to:number, upgraded:boolean, newer:boolean, failed:boolean, error?:string}}
 *   `doc` is the migrated document (a copy: the original is never half-changed), or the original when nothing
 *   was done (not an object, already current, newer, failed).
 */
function migrate(kind, doc) {
  if (!STEPS[kind]) throw new Error(`migrations: unknown kind « ${kind} »`);
  const to = CURRENT[kind];
  const from = versionOf(kind, doc);
  const res = { doc, from, to, upgraded: false, newer: false, failed: false };
  if (from === null) return res;                 // not a document of this kind: the caller decides
  if (from > to) { res.newer = true; return res; }
  if (from === to) return res;
  let d;
  try {
    d = structuredClone(doc);
    for (let v = from; v < to; v++) {
      const next = STEPS[kind][v](d);
      d = stamp(kind, next === undefined ? d : next, v + 1);
    }
  } catch (e) {
    return Object.assign(res, { failed: true, error: String((e && e.message) || e) });
  }
  return Object.assign(res, { doc: d, upgraded: true });
}

/**
 * Copy `file` to « <file>.bak-v<from> », once (an existing copy is the oldest one: kept as it is).
 * Never throws; resolves to the copy's path, or null when there was nothing to copy or it failed.
 */
async function backupOnce(file, from, log) {
  return (await copyOnce(file, from, log)).path;
}

async function copyOnce(file, from, log) {
  const dst = `${file}.bak-v${from}`;
  try {
    await fsp.copyFile(file, dst, require('node:fs').constants.COPYFILE_EXCL);
    return { path: dst, created: true };
  } catch (e) {
    if (e && e.code === 'EEXIST') return { path: dst, created: false };
    if (e && e.code !== 'ENOENT' && typeof log === 'function') log('migration backup failed:', file, e.message);
    return { path: null, created: false };
  }
}

/**
 * migrate() + the copy of the file on disk when the document was upgraded (before anyone writes the new format).
 * Never throws. Same result as migrate(), plus `backup` (path or null). A file that is read often but never
 * rewritten (folder.json during a scan) is migrated in memory each time: logged once, when its copy is made.
 */
async function migrateFile(kind, file, doc, log) {
  const res = migrate(kind, doc);
  res.backup = null;
  if (res.upgraded && file) {
    const copy = await copyOnce(file, res.from, log);
    res.backup = copy.path;
    if (copy.created && typeof log === 'function') log(`${kind} format ${res.from} → ${res.to} (copie ${copy.path}):`, file);
  }
  if (res.newer && typeof log === 'function') log(`${kind} from a newer Mia (format ${res.from} > ${res.to}):`, file);
  if (res.failed && typeof log === 'function') log(`${kind} migration failed (${res.error}):`, file);
  return res;
}

/** The sentence for a board that cannot be edited by this version (newer format or failed migration). */
function message(res, lang) {
  const l = lang === 'en' ? 'en' : 'fr';
  const s = res && res.failed ? STR.failed[l] : STR.newer[l];
  return s.replace('{v}', String(res ? res.from : '?'))
    .replace('{max}', String(res ? res.to : '?'))
    .replace('{msg}', String((res && res.error) || '?'));
}

module.exports = { CURRENT, KINDS, versionOf, migrate, migrateFile, backupOnce, message, _STEPS: STEPS };
