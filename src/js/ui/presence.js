/**
 * Mia — the assistant at work on the board (SPEC §13).
 *
 * The main process relays the assistant's calls (`bridge:call`, from electron/bridge.js); this module
 * runs them through the very same API as Quentin's clicks (window.__mia.app / editor), so every action
 * lands in the undo history, saves like any other, and the blocks arrive with their usual fade.
 *
 * What Quentin sees:
 *  - a presence cursor, Figma-like: an arrow and a label with the assistant's name, one neutral tone,
 *    no glow; it glides (300 ms, ease-out) to the block it places, the ports it wires, the setting it
 *    changes, and fades after 4 s of quiet;
 *  - the camera following gently when the action is off-screen;
 *  - a short bubble near the cursor for mia_say (6 s);
 *  - a discreet pill in the title bar, « Claude pilote Mia », while the assistant is active.
 * Actions are paced (~350 ms apart) so they can be followed with the eye.
 *
 * mountPresence() is called once by app.js (D). Errors go back to the assistant as readable sentences.
 *
 * Projects and boards (SPEC §18): what the code calls a project (p_…, mia.projects.*) is a « planche »
 * (board) for Quentin and for the assistant; a « projet » is a folder of boards (f_…, mia.folders.*).
 * create_project files the new board into a project (created when missing), open_project understands
 * « Projet / Planche », create_folder makes a project. Without mia.folders (an older preload) the rest
 * works as before and only the folder options fail, with a sentence that says why.
 */
import { on, once } from '../bus.js';
import { state } from '../state.js';
import { t, tl, register, has } from '../i18n.js';
import { tip } from './tooltip.js';
import {
  typeOf, types as allTypes, defaults, compatible, recipe as recipeById, recipes as allRecipes
} from '../catalog.js';
import { nodeInputs, nodeOutputs, isModelBlock, blockWorkflow, startPoints, mainPorts, blockFamily } from '../nodes/ports.js';
import { familyOf, localKeyOf } from '../nodes/route.js';
import { localCatalog, cloudCatalog } from '../nodes/profiles.js';

register({
  fr: {
    'presence.pill': '{name} pilote Mia',
    'presence.pillTip': '{name} pilote Mia par le pont des assistants. Chacune de ses actions s’annule avec Ctrl+Z.',
    'presence.err.unknownMethod': 'Action inconnue : « {method} ».',
    'presence.err.noEditor': 'La planche de Mia n’est pas disponible.',
    'presence.err.noProject': 'Aucune planche n’est ouverte dans Mia. Crées-en une (mia_create_project) ou ouvres-en une (mia_open_project).',
    'presence.err.readOnly': 'Cette planche est ouverte en lecture seule : impossible de la modifier.',
    'presence.err.createFailed': 'La planche n’a pas pu être créée : {why}',
    'presence.err.tabsFull': 'Trop d’onglets ouverts dans Mia : ferme une planche (ou demande à l’utilisateur) avant d’en ouvrir une autre.',
    'presence.err.openFailed': 'La planche n’a pas pu s’ouvrir.',
    'presence.err.noProjectFound': 'Aucune planche ne correspond à « {q} ». Planches : {list}.',
    'presence.err.manyProjects': 'Plusieurs planches correspondent à « {q} » : {list}. Donne l’id (p_…) ou « Projet / Planche ».',
    'presence.err.needProject': 'Donne l’id de la planche (p_…), son nom, ou « Projet / Planche ».',
    'presence.err.noFolders': 'Cette version de Mia ne range pas encore les planches dans des projets : relance Mia, ou crée la planche sans « folder ».',
    'presence.err.noFolderFound': 'Aucun projet ne correspond à « {q} ». Projets : {list}.',
    'presence.err.manyFolders': 'Plusieurs projets correspondent à « {q} » : {list}. Donne l’id (f_…).',
    'presence.err.emptyFolder': 'Le projet « {folder} » n’a encore aucune planche : crées-en une avec mia_create_project (folder « {folder} »).',
    'presence.err.noBoardInFolder': 'Le projet « {folder} » n’a pas de planche « {q} ». Ses planches : {list}.',
    'presence.err.folderFailed': 'Le projet « {name} » n’a pas pu être créé : {why}',
    'presence.err.needFolderName': 'Donne le nom du projet.',
    'presence.err.badColor': 'Couleur « {color} » inconnue. Couleurs : {list}.',
    'presence.note.folderCreated': 'Projet « {folder} » créé pour cette planche.',
    'presence.note.folderIgnored': 'Mia n’a pas rangé la planche dans « {folder} » (version sans projets ?) : elle est restée hors projet.',
    'presence.note.folderExisted': 'Un projet « {folder} » existait déjà : c’est lui qui est renvoyé (rien n’a été créé).',
    'presence.note.boardSameName': 'Une planche hors projet s’appelle aussi « {board} » ({id}) : elle n’a pas été déplacée dans le projet « {folder} ». Demande à l’utilisateur s’il veut l’y ranger.',
    'presence.note.latestBoard': 'Planche la plus récente du projet « {folder} ». Ses planches : {list}.',
    'presence.err.unknownType': 'Type de bloc inconnu : « {type} ». Types possibles : {list}.',
    'presence.err.noNode': 'Le bloc « {id} » n’existe pas sur la planche. Blocs présents : {list}.',
    'presence.err.noNodes': 'La planche est vide.',
    'presence.err.needNode': 'Donne l’id du bloc (nodeId).',
    'presence.err.addFailed': 'Le bloc n’a pas pu être posé.',
    'presence.err.selfWire': 'Un bloc ne peut pas se brancher sur lui-même.',
    'presence.err.noOutputs': 'Le bloc « {block} » n’a pas de sortie.',
    'presence.err.noInputs': 'Le bloc « {block} » n’a pas d’entrée.',
    'presence.err.noOutPort': 'Le bloc « {block} » n’a pas de sortie « {port} ». Sorties : {list}.',
    'presence.err.noInPort': 'Le bloc « {block} » n’a pas d’entrée « {port} ». Entrées : {list}.',
    'presence.err.incompatible': 'La sortie « {out} » ({outType}) de « {a} » ne peut pas aller dans l’entrée « {in} » ({inType}) de « {b} ». Entrées compatibles : {list}.',
    'presence.err.noCompatible': 'Aucune entrée de « {b} » n’accepte la sortie {outType} de « {a} ». Entrées de « {b} » : {list}.',
    'presence.err.unknownKind': ' Le type de « {a} » n’est pas encore connu : remplis ou lance d’abord ce bloc.',
    'presence.err.full': 'L’entrée « {in} » de « {b} » accepte {max} fils au plus.',
    'presence.err.refused': 'Fil refusé : il créerait une boucle.',
    'presence.err.none': 'aucune',
    'presence.err.unknownParam': 'Le bloc « {block} » n’a pas de réglage « {key} ». Réglages : {list}.',
    'presence.err.badOption': '« {label} » ({key}) : valeur « {value} » refusée. Valeurs permises : {list}.',
    'presence.err.badRange': '« {label} » ({key}) : de {min} à {max}{unit}.',
    'presence.err.badNumber': '« {label} » ({key}) : un nombre est attendu.',
    'presence.err.badBool': '« {label} » ({key}) : true ou false.',
    'presence.err.badModel': '« {label} » ({key}) : « {value} » introuvable ou indisponible. Choix : {list}.',
    'presence.online': 'en ligne, payant',
    'presence.err.noRecipe': 'Recette inconnue : « {q} ». Recettes : {list}.',
    'presence.err.notRunnable': 'Le bloc « {block} » ne se calcule pas (il n’a pas de bouton Lancer).',
    'presence.err.badMode': 'Mode « {mode} » inconnu pour ce bloc. Modes : {list}.',
    'presence.err.runFailed': 'Le calcul n’a pas pu partir : {why}',
    'presence.err.missing': ' À faire : {list}.',
    'presence.err.noResult': 'Le bloc « {block} » n’a pas encore de résultat : lance-le (mia_run) puis attends (mia_wait).',
    'presence.err.noMedia': 'Le bloc « {block} » attend encore son fichier : importe-le avec mia_import_media (into).',
    'presence.err.noOutPortResult': 'Le résultat de « {block} » n’a pas de sortie « {port} ». Sorties : {list}.',
    'presence.err.notImport': '« into » doit être un bloc Média (type import).',
    'presence.err.importFailed': 'Aucun fichier n’a pu être importé (voir le message dans Mia).',
    'presence.err.emptyText': 'Le texte est vide.',
    'presence.err.needIds': 'Donne au moins un id de bloc.',
    'presence.err.busy': 'Mia n’a pas pu finir cette action (fenêtre réduite ou occupée). Réessaie.',
    'presence.note.hidden': 'Réglage enregistré mais masqué tant que « {param} » ne le permet pas.',
    'presence.note.partial': '{n} fichier(s) n’ont pas pu être importés : voir le message dans Mia.',
    'presence.note.preview': 'Aperçu lancé : regarde le résultat, puis relance en mode « final » si c’est bon.'
  },
  en: {
    'presence.pill': '{name} is driving Mia',
    'presence.pillTip': '{name} drives Mia through the assistant bridge. Every action can be undone with Ctrl+Z.',
    'presence.err.unknownMethod': 'Unknown action: “{method}”.',
    'presence.err.noEditor': 'Mia’s board is not available.',
    'presence.err.noProject': 'No board is open in Mia. Create one (mia_create_project) or open one (mia_open_project).',
    'presence.err.readOnly': 'This board is open read-only: it cannot be changed.',
    'presence.err.createFailed': 'The board could not be created: {why}',
    'presence.err.tabsFull': 'Too many tabs open in Mia: close a board (or ask the user) before opening another one.',
    'presence.err.openFailed': 'The board could not be opened.',
    'presence.err.noProjectFound': 'No board matches “{q}”. Boards: {list}.',
    'presence.err.manyProjects': 'Several boards match “{q}”: {list}. Give the id (p_…) or “Project / Board”.',
    'presence.err.needProject': 'Give the board id (p_…), its name, or “Project / Board”.',
    'presence.err.noFolders': 'This version of Mia cannot file boards into projects yet: restart Mia, or create the board without “folder”.',
    'presence.err.noFolderFound': 'No project matches “{q}”. Projects: {list}.',
    'presence.err.manyFolders': 'Several projects match “{q}”: {list}. Give the id (f_…).',
    'presence.err.emptyFolder': 'Project “{folder}” has no board yet: create one with mia_create_project (folder “{folder}”).',
    'presence.err.noBoardInFolder': 'Project “{folder}” has no board “{q}”. Its boards: {list}.',
    'presence.err.folderFailed': 'Project “{name}” could not be created: {why}',
    'presence.err.needFolderName': 'Give the project name.',
    'presence.err.badColor': 'Unknown colour “{color}”. Colours: {list}.',
    'presence.note.folderCreated': 'Project “{folder}” created for this board.',
    'presence.note.folderIgnored': 'Mia did not file the board into “{folder}” (a version without projects?): it stayed outside any project.',
    'presence.note.folderExisted': 'A project “{folder}” already existed: it is returned (nothing was created).',
    'presence.note.boardSameName': 'A board outside any project is also called “{board}” ({id}): it was not moved into project “{folder}”. Ask the user whether they want it filed there.',
    'presence.note.latestBoard': 'Most recent board of project “{folder}”. Its boards: {list}.',
    'presence.err.unknownType': 'Unknown block type: “{type}”. Possible types: {list}.',
    'presence.err.noNode': 'Block “{id}” is not on the board. Blocks: {list}.',
    'presence.err.noNodes': 'The board is empty.',
    'presence.err.needNode': 'Give the block id (nodeId).',
    'presence.err.addFailed': 'The block could not be placed.',
    'presence.err.selfWire': 'A block cannot be wired to itself.',
    'presence.err.noOutputs': 'Block “{block}” has no output.',
    'presence.err.noInputs': 'Block “{block}” has no input.',
    'presence.err.noOutPort': 'Block “{block}” has no output “{port}”. Outputs: {list}.',
    'presence.err.noInPort': 'Block “{block}” has no input “{port}”. Inputs: {list}.',
    'presence.err.incompatible': 'Output “{out}” ({outType}) of “{a}” cannot go into input “{in}” ({inType}) of “{b}”. Compatible inputs: {list}.',
    'presence.err.noCompatible': 'No input of “{b}” accepts the {outType} output of “{a}”. Inputs of “{b}”: {list}.',
    'presence.err.unknownKind': ' The type of “{a}” is not known yet: fill or run that block first.',
    'presence.err.full': 'Input “{in}” of “{b}” takes {max} wires at most.',
    'presence.err.refused': 'Wire refused: it would create a loop.',
    'presence.err.none': 'none',
    'presence.err.unknownParam': 'Block “{block}” has no setting “{key}”. Settings: {list}.',
    'presence.err.badOption': '“{label}” ({key}): value “{value}” refused. Allowed values: {list}.',
    'presence.err.badRange': '“{label}” ({key}): from {min} to {max}{unit}.',
    'presence.err.badNumber': '“{label}” ({key}): a number is expected.',
    'presence.err.badBool': '“{label}” ({key}): true or false.',
    'presence.err.badModel': '“{label}” ({key}): “{value}” not found or unavailable. Choices: {list}.',
    'presence.online': 'online, paid',
    'presence.err.noRecipe': 'Unknown recipe: “{q}”. Recipes: {list}.',
    'presence.err.notRunnable': 'Block “{block}” does not compute (it has no Run button).',
    'presence.err.badMode': 'Unknown mode “{mode}” for this block. Modes: {list}.',
    'presence.err.runFailed': 'The job could not start: {why}',
    'presence.err.missing': ' To do: {list}.',
    'presence.err.noResult': 'Block “{block}” has no result yet: run it (mia_run) then wait (mia_wait).',
    'presence.err.noMedia': 'Block “{block}” still waits for its file: import it with mia_import_media (into).',
    'presence.err.noOutPortResult': 'The result of “{block}” has no output “{port}”. Outputs: {list}.',
    'presence.err.notImport': '“into” must be a Media block (type import).',
    'presence.err.importFailed': 'No file could be imported (see the message in Mia).',
    'presence.err.emptyText': 'The text is empty.',
    'presence.err.needIds': 'Give at least one block id.',
    'presence.err.busy': 'Mia could not finish this action (window minimised or busy). Try again.',
    'presence.note.hidden': 'Setting saved but hidden while “{param}” does not allow it.',
    'presence.note.partial': '{n} file(s) could not be imported: see the message in Mia.',
    'presence.note.preview': 'Preview started: look at the result, then run again in “final” mode if it is good.'
  }
});

// ── timing (SPEC §13.1) ─────────────────────────────────────────────────
const GLIDE_MS = 300;
const PACE_MS = 350;
const IDLE_MS = 4000;
const SAY_MS = 6000;
const PILL_MS = 9000;
const CAMERA_MS = 460;
const STUCK_MS = 50000;          // under the bridge's 60 s
const STUCK_IMPORT_MS = 110000;  // big videos take a while to copy (the bridge waits 120 s)
const GAP_X = 96;            // recipes: 336-wide blocks every 432
const GAP_Y = 48;
const GRID = 24;
// the board's useful area: floating title bar on top, docks below (same as the editor)
const INSETS = { top: 92, right: 56, bottom: 104, left: 56 };
const ACTIVE = new Set(['queued', 'waiting-gpu', 'running']);

// cubic-bezier(0.16, 1, 0.3, 1) — the --ease-out of tokens.css
const EASE_OUT = bezier(0.16, 1, 0.3, 1);

let mounted = false;
let dom = null;
let lastAction = 0;
let lastPlaced = null;       // the block the assistant placed last: the next one goes to its right
let lastMedia = null;        // the media it imported last: the next one goes below
let runsMod = null;
let chain = Promise.resolve();

const cur = { world: null, visible: false, anim: null, raf: 0, idleT: 0, hideT: 0, sayT: 0, hold: 0, name: 'Assistant' };

// ── public ──────────────────────────────────────────────────────────────

export function mountPresence() {
  if (mounted) return;
  mounted = true;
  ensureCss();
  buildDom();
  on('view:changed', ({ view } = {}) => { if (view !== 'board') hideCursor(true); });
  on('project:closing', () => { hideCursor(true); cur.world = null; lastPlaced = null; lastMedia = null; });

  const bridge = window.mia?.bridge;
  if (!bridge || typeof bridge.onCall !== 'function') {
    console.warn('[presence] pont des assistants absent (preload)');
    return;
  }
  bridge.onCall((msg) => enqueue(msg));
  whenAppReady().then(() => reply('__ready__', { ok: true, result: { ready: true } }));
}

export default { mountPresence };

// ── calls ───────────────────────────────────────────────────────────────

function enqueue(msg) {
  if (!msg || typeof msg.method !== 'string') return;
  if (msg.method === 'activity') {                                // a main-side call: no answer expected
    if (msg.params?.method === 'snapshot_done') cur.hold = 0;       // the capture is taken: back to normal
    touch(msg.client);
    return;
  }
  chain = chain.then(() => handle(msg)).catch((err) => console.error('[presence]', err));
}

async function handle({ id, method, params, client }) {
  touch(client);
  const fn = Object.prototype.hasOwnProperty.call(METHODS, method) ? METHODS[method] : null;
  let payload;
  if (!fn) payload = { ok: false, error: t('presence.err.unknownMethod', { method }) };
  else {
    let watchdog = 0;
    try {
      // one stuck action (an animation in a window that draws nothing) never blocks the ones after it
      const stuck = new Promise((_, reject) => { watchdog = setTimeout(() => reject(Object.assign(new Error(t('presence.err.busy')), { user: true })), method === 'import_media' ? STUCK_IMPORT_MS : STUCK_MS); });
      const result = await Promise.race([fn(params && typeof params === 'object' ? params : {}, client), stuck]);
      payload = { ok: true, result: result === undefined ? null : result };
    } catch (err) {
      if (!err?.user) console.error(`[presence] ${method}`, err);
      payload = { ok: false, error: err?.message || String(err) };
    } finally {
      clearTimeout(watchdog);
    }
  }
  if (id != null) reply(id, payload);
}

function reply(id, payload) {
  try {
    window.mia.bridge.reply(id, JSON.parse(JSON.stringify(payload ?? null)));
  } catch (err) {
    console.error('[presence] reply', err);
  }
}

function fail(key, vars) {
  const e = new Error(t(`presence.err.${key}`, vars));
  e.user = true;
  throw e;
}

// ── access to the app ───────────────────────────────────────────────────

const appApi = () => window.__mia?.app || null;
const ed = () => window.__mia?.editor || window.__mia?.app?.editor || null;

let appReadyP = null;
function whenAppReady() {
  if (!appReadyP) {
    appReadyP = new Promise((resolve) => {
      let done = false;
      const fin = () => { if (!done) { done = true; clearInterval(iv); clearTimeout(cap); resolve(); } };
      const ok = () => !!(appApi()?.home && ed());
      once('app:ready', fin);
      const iv = setInterval(() => { if (ok()) setTimeout(fin, 300); }, 250);
      const cap = setTimeout(fin, 20000);
    });
  }
  return appReadyP;
}

async function getRuns() {
  if (!runsMod) {
    try {
      const m = await import('../nodes/runs.js');
      runsMod = m.runs || m.default || m;
    } catch { runsMod = {}; }
  }
  return runsMod;
}

/** The editor with a project open (another one first if projectId says so). */
async function board(p = {}, { write = false } = {}) {
  await whenAppReady();
  const e = ed();
  const app = appApi();
  if (!e || !app) fail('noEditor');
  const want = p.boardId || p.projectId;
  if (want && want !== state.project?.id) {
    const ok = await app.openProject(String(want));
    if (!ok) fail('openFailed');
  }
  if (!state.project || !e.loaded) fail('noProject');
  if (write && state.readOnly) fail('readOnly');
  return e;
}

function nodeOf(e, id) {
  if (!id) fail('needNode');
  const n = e.getNode(String(id));
  if (!n) fail('noNode', { id, list: nodeList(e) });
  return n;
}

function nodeList(e) {
  const g = e.getGraph();
  if (!g?.nodes?.length) return t('presence.err.none');
  const list = g.nodes.slice(0, 14).map((n) => `${n.id} (${blockName(n)})`);
  if (g.nodes.length > 14) list.push('…');
  return list.join(', ');
}

function blockName(n) {
  const def = typeOf(n?.type);
  return n?.title || (def ? tl(def.label) : n?.type || '?');
}

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** A block type by id, or by its name in French or English (« Profondeur »). */
function findType(q) {
  const s = String(q || '').trim();
  const direct = typeOf(s);
  if (direct) return direct;
  const n = norm(s);
  return (allTypes() || []).find((d) => norm(d.id) === n || norm(d.label?.fr) === n || norm(d.label?.en) === n) || null;
}

function typeList() {
  return (allTypes() || []).map((d) => `${d.id} « ${d.label?.fr || d.id} »`).join(', ');
}

function findRecipe(q) {
  if (!q) return null;
  if (typeof q === 'object' && q.nodes) return q;
  const s = String(q?.id ?? q);
  const r = recipeById(s);
  if (r) return r;
  const n = norm(s);
  return (allRecipes() || []).find((x) => norm(x.id) === n || norm(x.label?.fr) === n || norm(x.label?.en) === n) || null;
}

function recipeList() {
  return (allRecipes() || []).map((r) => `${r.id} « ${r.label?.fr || r.id} »`).join(', ');
}

// ── projects (folders) and boards (SPEC §18) ────────────────────────────
// In the interface a « planche » (board) is what the API still calls a project (p_…, mia.projects.*);
// a « projet » is a folder of boards (f_…, mia.folders.*). One level only.

const FOLDER_COLORS = ['grey', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink'];
const COLOR_WORDS = {
  gris: 'grey', gray: 'grey', bleu: 'blue', accent: 'blue', sarcelle: 'teal', 'bleu-vert': 'teal', turquoise: 'teal',
  vert: 'green', jaune: 'yellow', rouge: 'red', rose: 'pink'
};

/** mia.folders from the preload, or null on a Mia that does not have projects yet. */
function foldersApi() {
  const f = window.mia?.folders;
  return f && typeof f.list === 'function' && typeof f.create === 'function' ? f : null;
}

const answerFailed = (r) => !r || r.ok === false;
const why = (r) => (r && r.error) || '?';

/** Every project (folder): [{id, name, color, boards, …}] — [] when this Mia has none. */
async function listFolders() {
  const api = foldersApi();
  if (!api) return [];
  let r;
  try { r = await api.list(); } catch { r = null; }
  const arr = Array.isArray(r) ? r : Array.isArray(r?.folders) ? r.folders : [];
  return arr.filter((f) => f && f.id);
}

/** Every board: [{id, name, folderId, dir, nodes, updated, opened}]. */
async function listBoards() {
  let r;
  try { r = await window.mia.projects.list(); } catch { r = null; }
  const arr = Array.isArray(r) ? r : Array.isArray(r?.projects) ? r.projects : [];
  return arr.filter((b) => b && b.id);
}

/** A board's folder id, whatever the store calls it. */
function folderIdOf(b) {
  const v = b?.folderId ?? b?.folder ?? null;
  return v && typeof v === 'object' ? v.id ?? null : v || null;
}

/** « Court métrage / Plan 05 », or the board's name alone when it is outside any project. */
function boardLabel(b, folders) {
  const f = folders.find((x) => x.id === folderIdOf(b));
  return f ? `${f.name} / ${b.name}` : b.name;
}

function boardListText(boards, folders, max = 12) {
  if (!boards.length) return t('presence.err.none');
  const list = boards.slice(0, max).map((b) => `${b.id} (${boardLabel(b, folders)})`);
  if (boards.length > max) list.push('…');
  return list.join(', ');
}

function folderListText(folders, max = 12) {
  if (!folders.length) return t('presence.err.none');
  const list = folders.slice(0, max).map((f) => `${f.id} (${f.name})`);
  if (folders.length > max) list.push('…');
  return list.join(', ');
}

/** What a tool accepts for a project: "Court métrage", "f_…", {id}, {name}. */
function folderQuery(v) {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.id || v.folderId || v.name || '').trim();
  return String(v).trim();
}

/** A project by id or by name (accents and case ignored); a partial name only when asked. */
function matchFolder(folders, q, { partial = false } = {}) {
  const s = folderQuery(q);
  if (!s) return { hit: null, many: [] };
  const byId = folders.find((f) => f.id === s);
  if (byId) return { hit: byId, many: [] };
  const exact = folders.filter((f) => norm(f.name) === norm(s));
  if (exact.length === 1) return { hit: exact[0], many: [] };
  if (exact.length > 1 || !partial) return { hit: null, many: exact };
  const part = folders.filter((f) => norm(f.name).includes(norm(s)));
  return part.length === 1 ? { hit: part[0], many: [] } : { hit: null, many: part };
}

/** A board by name among `boards`: exact name first, then partial. */
function matchBoard(boards, q) {
  const s = String(q ?? '').trim();
  if (!s) return { hit: null, many: [] };
  const exact = boards.filter((b) => norm(b.name) === norm(s));
  if (exact.length === 1) return { hit: exact[0], many: [] };
  if (exact.length > 1) return { hit: null, many: exact };
  const part = boards.filter((b) => norm(b.name).includes(norm(s)));
  return part.length === 1 ? { hit: part[0], many: [] } : { hit: null, many: part };
}

/** The board of a project Quentin (or the assistant) used last. */
function latestBoard(boards) {
  return boards.slice().sort((a, b) => (Number(b.opened) || 0) - (Number(a.opened) || 0) || (Number(b.updated) || 0) - (Number(a.updated) || 0))[0] || null;
}

function cleanColor(c) {
  if (c == null || c === '') return null;
  const s = norm(c);
  const key = FOLDER_COLORS.includes(s) ? s : COLOR_WORDS[s];
  if (!key) fail('badColor', { color: c, list: FOLDER_COLORS.join(', ') });
  return key;
}

/** The answer of mia.folders.create: {id, name, color} (alone or under .folder). */
function folderFrom(r, name, color) {
  const f = r && typeof r === 'object' ? (r.folder && typeof r.folder === 'object' ? r.folder : r) : null;
  if (!f || !f.id) return null;
  return { id: f.id, name: f.name || name, color: f.color ?? color ?? null };
}

/**
 * The key two project names share when Mia would give them the same folder on disk: case, accents,
 * runs of spaces, what Windows forbids in a name and trailing dots ignored (« Court  Métrage. » = « court metrage »).
 */
const folderKey = (s) => norm(String(s ?? '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ')).replace(/[. ]+$/g, '');

/**
 * Looking up then creating a project is one step: two calls in a row (create_folder then create_project,
 * or two assistants at once) must never both create « Court métrage ».
 */
let folderQueue = Promise.resolve();
function oneFolderAtATime(fn) {
  const run = folderQueue.then(fn, fn);
  folderQueue = run.catch(() => {});
  return run;
}

/** An existing project with this name (see folderKey), or null. The store's own lookup when it has one. */
async function findFolderByName(name, folders) {
  const api = foldersApi();
  const finder = api && ['findByName', 'findFolderByName'].map((k) => api[k]).find((fn) => typeof fn === 'function');
  if (finder) {
    try {
      const r = await finder.call(api, name);
      const f = r && typeof r === 'object' ? (r.folder && typeof r.folder === 'object' ? r.folder : r) : null;
      if (f && f.id && f.ok !== false) return f;
    } catch { /* the list below decides */ }
  }
  const list = folders || await listFolders();
  return list.find((f) => norm(f.name) === norm(name))
    || list.find((f) => folderKey(f.name) === folderKey(name))
    || null;
}

/**
 * A new project, named exactly as asked — or the one of that name when the store finds it first
 * (`reuse`, one step inside the store; an older store ignores it). An older store also numbered a name
 * whose folder was taken on disk — by a board outside any project (« Court métrage » was a board before
 * projects existed) or a stray folder: the project is then renamed back to the name asked for (only
 * its folder on disk keeps a suffix), never « Court métrage 2 ».
 * → { folder: {id, name, color}, existed, notes: [] }
 */
async function makeFolder(name, color) {
  const api = foldersApi();
  let r;
  try { r = await api.create({ name, reuse: true, ...(color ? { color } : {}) }); } catch (err) { r = { ok: false, error: err?.message }; }
  let f = answerFailed(r) ? null : folderFrom(r, name, color);
  if (!f) fail('folderFailed', { name, why: why(r) });
  const existed = !!(r.existed ?? r.folder?.existed);
  const notes = [];
  if (!existed) {
    if (folderKey(f.name) !== folderKey(name) && typeof api.rename === 'function') {
      let r2;
      try { r2 = await api.rename(f.id, name); } catch (err) { r2 = { ok: false, error: err?.message }; }
      if (!answerFailed(r2)) f = { ...f, name: folderFrom(r2, name, f.color)?.name || name };
    }
    // his old board of that name stays where it is: the assistant should ask before filing it
    const twin = (await listBoards()).find((b) => !folderIdOf(b) && folderKey(b.name) === folderKey(name));
    if (twin) notes.push(t('presence.note.boardSameName', { folder: f.name, board: twin.name, id: twin.id }));
  }
  return { folder: { id: f.id, name: f.name, color: f.color ?? null }, existed, notes };
}

/** The project named (or with this id), created when no project has that name. */
function ensureFolder(q, color) {
  const api = foldersApi();
  if (!api) fail('noFolders');
  return oneFolderAtATime(async () => {
    const folders = await listFolders();
    const { hit, many } = matchFolder(folders, q);
    if (hit) return { folder: { id: hit.id, name: hit.name, color: hit.color ?? null }, created: false, notes: [] };
    if (many.length) fail('manyFolders', { q, list: folderListText(many) });
    const name = folderQuery(q).slice(0, 120).trim();
    // an id nobody has is a mistake, not a name for a new project
    if (/^f_[\w-]+$/.test(name)) fail('noFolderFound', { q: name, list: folderListText(folders) });
    const same = await findFolderByName(name, folders);
    if (same) return { folder: { id: same.id, name: same.name, color: same.color ?? null }, created: false, notes: [] };
    const { folder, existed, notes } = await makeFolder(name, cleanColor(color));
    return { folder, created: !existed, notes };
  });
}

/** {id, name} of the project holding this board, or null. */
async function folderOfBoard(boardId) {
  if (!boardId) return null;
  if (state.project?.id === boardId && state.project.folder?.id) return { id: state.project.folder.id, name: state.project.folder.name };
  const [boards, folders] = await Promise.all([listBoards(), listFolders()]);
  const b = boards.find((x) => x.id === boardId);
  const f = b ? folders.find((x) => x.id === folderIdOf(b)) : null;
  return f ? { id: f.id, name: f.name } : null;
}

/**
 * The board an assistant names: an id (p_…), a project id (f_… → its latest board), a name, « Projet /
 * Planche », or {folder, name}. Returns {board, folder, latest} or fails with the candidates.
 */
function resolveBoard(p, boards, folders) {
  const idQ = String(p.id || p.boardId || p.projectId || '').trim();
  const folderQ = folderQuery(p.folder ?? p.folderId);
  let nameQ = String(p.name ?? '').trim();
  const inFolder = (f) => boards.filter((b) => folderIdOf(b) === f.id);
  const fromFolder = (f, q) => {
    const mine = inFolder(f);
    if (!q) {
      const b = latestBoard(mine);
      if (!b) fail('emptyFolder', { folder: f.name });
      return { board: b, folder: f, latest: true };
    }
    const { hit, many } = matchBoard(mine, q);
    if (hit) return { board: hit, folder: f, latest: false };
    if (many.length) fail('manyProjects', { q: `${f.name} / ${q}`, list: boardListText(many, folders) });
    return fail('noBoardInFolder', { folder: f.name, q, list: mine.map((b) => b.name).join(', ') || t('presence.err.none') });
  };

  if (idQ) {
    const b = boards.find((x) => x.id === idQ);
    if (b) return { board: b, folder: folders.find((f) => f.id === folderIdOf(b)) || null, latest: false };
    const f = folders.find((x) => x.id === idQ);
    if (f) return fromFolder(f, nameQ);
    if (/^[pf]_[\w-]+$/.test(idQ)) fail('noProjectFound', { q: idQ, list: boardListText(boards, folders) });
    if (!nameQ) nameQ = idQ;                       // a name given as id
  }

  if (folderQ) {
    const { hit, many } = matchFolder(folders, folderQ, { partial: true });
    if (!hit) {
      if (many.length) fail('manyFolders', { q: folderQ, list: folderListText(many) });
      fail('noFolderFound', { q: folderQ, list: folderListText(folders) });
    }
    return fromFolder(hit, nameQ);
  }
  if (!nameQ) fail('needProject');

  // the whole name first: a board may well be called « A / B »
  const exact = boards.filter((b) => norm(b.name) === norm(nameQ));
  if (exact.length === 1) return { board: exact[0], folder: folders.find((f) => f.id === folderIdOf(exact[0])) || null, latest: false };
  if (exact.length > 1) fail('manyProjects', { q: nameQ, list: boardListText(exact, folders) });

  // « Projet / Planche » (also › > \ as separators)
  const parts = nameQ.split(/\s*[/›>\\]\s*/).filter(Boolean);
  for (let k = parts.length - 1; k >= 1; k--) {
    const { hit } = matchFolder(folders, parts.slice(0, k).join(' / '), { partial: true });
    if (hit) return fromFolder(hit, parts.slice(k).join(' / '));
  }

  // a project's name alone: its latest board
  const fx = matchFolder(folders, nameQ);
  if (fx.hit) return fromFolder(fx.hit, '');

  const { hit, many } = matchBoard(boards, nameQ);
  if (hit) return { board: hit, folder: folders.find((f) => f.id === folderIdOf(hit)) || null, latest: false };
  if (many.length) fail('manyProjects', { q: nameQ, list: boardListText(many, folders) });
  const fp = matchFolder(folders, nameQ, { partial: true });
  if (fp.hit) return fromFolder(fp.hit, '');
  return fail('noProjectFound', { q: nameQ, list: boardListText(boards, folders) });
}

/** Absolute Windows path of a project file (rel uses '/'). */
function abs(rel) {
  if (!rel) return null;
  const s = String(rel);
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\')) return s;
  const dir = state.project?.dir;
  return dir ? `${String(dir).replace(/[\\/]+$/, '')}\\${s.replace(/\//g, '\\')}` : s;
}

function compactMeta(m) {
  if (!m || typeof m !== 'object') return null;
  const out = {};
  for (const k of ['w', 'h', 'fps', 'frames', 'duration', 'alpha']) if (m[k] != null) out[k] = m[k];
  return out;
}

// ── geometry ────────────────────────────────────────────────────────────

function boxOf(e, n) {
  const el = e.nodeEl(n.id);
  const h = el?.offsetHeight || estimateH(typeOf(n.type));
  return { x: n.x, y: n.y, w: n.w || el?.offsetWidth || 288, h };
}

function estimateH(def) {
  if (!def) return 240;
  if (def.id === 'text' || def.id === 'note') return 220;
  if (def.id === 'import') return 300;
  return def.engine ? 380 : 300;
}

function union(boxes) {
  const list = boxes.filter(Boolean);
  if (!list.length) return null;
  const x0 = Math.min(...list.map((b) => b.x)), y0 = Math.min(...list.map((b) => b.y));
  const x1 = Math.max(...list.map((b) => b.x + b.w)), y1 = Math.max(...list.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const snapUp = (v) => Math.ceil(v / GRID) * GRID;
const snapNear = (v) => Math.round(v / GRID) * GRID;

/** Slide down from (x, y) until the w×h box touches no block. */
function freeSpot(boxes, x, y, w, h, skip = null) {
  let px = snapNear(x), py = snapNear(y);
  for (let i = 0; i < 80; i++) {
    const hit = boxes.find((b) => b.id !== skip && px < b.x + b.w + GRID && px + w + GRID > b.x && py < b.y + b.h + GRID && py + h + GRID > b.y);
    if (!hit) break;
    py = snapUp(hit.y + hit.h + GAP_Y);
  }
  return { x: px, y: py };
}

function allBoxes(e) {
  const g = e.getGraph();
  return (g?.nodes || []).map((n) => ({ id: n.id, ...boxOf(e, n) }));
}

/**
 * Where a new block goes: to the right of `near` (or of the assistant's last block), a media below the
 * last imported media, else beside everything; never on top of another block.
 */
function placeFor(e, { w, h, near, media = false }) {
  const boxes = allBoxes(e);
  let anchor = null;
  if (near) anchor = nodeOf(e, near);
  let x, y;
  if (anchor) {
    const b = boxOf(e, anchor);
    x = b.x + b.w + GAP_X; y = b.y;
  } else if (media && lastMedia && e.getNode(lastMedia)) {
    const b = boxOf(e, e.getNode(lastMedia));
    x = b.x; y = b.y + b.h + GAP_Y;
  } else if (!media && lastPlaced && e.getNode(lastPlaced)) {
    const b = boxOf(e, e.getNode(lastPlaced));
    x = b.x + b.w + GAP_X; y = b.y;
  } else if (!boxes.length) {
    const c = viewCenter(e);
    x = c.x - w / 2; y = c.y - h / 2;
  } else {
    const bb = union(boxes);
    if (media) { x = bb.x - w - GAP_X; y = bb.y; } else { x = bb.x + bb.w + GAP_X; y = bb.y; }
  }
  return freeSpot(boxes, x, y, w, h);
}

function stageRect() {
  const st = document.getElementById('stage');
  const r = st?.getBoundingClientRect();
  return r && r.width ? r : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

function viewCenter(e) {
  const r = stageRect();
  return e.screenToWorld({
    x: r.left + INSETS.left + (r.width - INSETS.left - INSETS.right) / 2,
    y: r.top + INSETS.top + (r.height - INSETS.top - INSETS.bottom) / 2
  });
}

/** Bring a world box into the useful part of the view: a gentle camera move, only when needed. */
async function ensureVisible(e, box) {
  if (!box || typeof e.camera !== 'function' || typeof e.setCamera !== 'function') return;
  const r = stageRect();
  const cam = e.camera() || { x: 0, y: 0, z: 1 };
  const uw = r.width - INSETS.left - INSETS.right;
  const uh = r.height - INSETS.top - INSETS.bottom;
  const v = { x: cam.x + INSETS.left / cam.z, y: cam.y + INSETS.top / cam.z, w: uw / cam.z, h: uh / cam.z };
  const inside = box.x >= v.x && box.y >= v.y && box.x + box.w <= v.x + v.w && box.y + box.h <= v.y + v.h;
  if (inside) return;
  let z = cam.z < 0.35 ? 0.7 : cam.z;
  const fitZ = Math.min(uw / Math.max(1, box.w + 80), uh / Math.max(1, box.h + 80));
  if (fitZ < z) z = Math.max(0.2, fitZ);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  e.setCamera({ x: cx - (INSETS.left + uw / 2) / z, y: cy - (INSETS.top + uh / 2) / z, z }, { animate: true });
  await sleep(CAMERA_MS);
}

/** World point of a port's dot (the cursor's tip goes there). */
function portPoint(e, id, port, dir) {
  const n = e.getNode(id);
  const el = e.nodeEl(id);
  const dot = el?.querySelector(`.n-port.${dir}[data-port="${cssEscape(port)}"] .dot`);
  const p = n && dot ? localPoint(e, n, dot, 0.5, 0.5) : null;
  if (p) return p;
  const b = boxOf(e, n);
  return { x: dir === 'out' ? b.x + b.w : b.x, y: b.y + 48 };
}

/** World point of an element inside a block (a button, the settings), else of the block itself. */
function elPoint(e, n, selector, fx = 0.5, fy = 0.5) {
  const el = e.nodeEl(n.id);
  const target = selector instanceof Element ? selector : selector ? el?.querySelector(selector) : el;
  const p = target ? localPoint(e, n, target, fx, fy) : null;
  if (p) return p;
  const b = boxOf(e, n);
  return { x: b.x + b.w * fx, y: b.y + Math.min(b.h, 80) * fy };
}

/**
 * Where an element sits inside its block, in world units: measured relative to the block itself, so it
 * stays right even when the page has not drawn the camera's latest move yet.
 */
function localPoint(e, n, target, fx, fy) {
  const host = e.nodeEl(n.id);
  if (!host) return null;
  const hr = host.getBoundingClientRect();
  const r = target.getBoundingClientRect();
  if (!hr.width || (!r.width && !r.height)) return null;
  const k = (n.w || host.offsetWidth) / hr.width;
  return { x: n.x + (r.left - hr.left + r.width * fx) * k, y: n.y + (r.top - hr.top + r.height * fy) * k };
}

function cssEscape(s) {
  return window.CSS?.escape ? window.CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&');
}

// ── pacing ──────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * The next frame — or 34 ms, whichever comes first: a minimised or hidden window gets no frames, and an
 * assistant must never wait forever on an animation nobody can see.
 */
const nextFrame = () => new Promise((resolve) => {
  let done = false;
  const go = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(go);
  setTimeout(go, 34);
});

/** At least PACE_MS between two visible actions. */
async function pace() {
  const wait = PACE_MS - (performance.now() - lastAction);
  await sleep(Math.max(90, wait));
}
function acted() { lastAction = performance.now(); }

// ── the cursor ──────────────────────────────────────────────────────────

function ensureCss() {
  if (document.querySelector('link[data-presence]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../../css/presence.css', import.meta.url).href;
  link.dataset.presence = '';
  document.head.append(link);
}

function buildDom() {
  const cursor = document.createElement('div');
  cursor.className = 'pr-cursor';
  cursor.setAttribute('aria-hidden', 'true');
  cursor.innerHTML = '<svg class="pr-arrow" viewBox="0 0 20 20" width="22" height="22"><path d="M3.2 2.4 17 9.3l-6.6 1.5-3.1 6.4z"/></svg>'
    + '<span class="pr-label"></span><div class="pr-bubble"></div>';
  document.body.append(cursor);

  const pill = document.createElement('div');
  pill.className = 'pr-pill';
  pill.setAttribute('role', 'status');
  pill.innerHTML = '<i class="pr-pill-dot"></i><span class="pr-pill-txt"></span>';
  const host = document.getElementById('tb-actions');
  if (host) host.prepend(pill);
  else document.getElementById('titlebar')?.append(pill);
  try { tip(pill, () => t('presence.pillTip', { name: cur.name }), { placement: 'bottom' }); } catch { /* tooltips not ready */ }

  dom = {
    cursor,
    arrow: cursor.querySelector('.pr-arrow'),
    label: cursor.querySelector('.pr-label'),
    bubble: cursor.querySelector('.pr-bubble'),
    pill,
    pillTxt: pill.querySelector('.pr-pill-txt'),
    pillT: 0
  };
}

/** A call arrived: name the assistant, show the pill, keep the cursor awake. */
function touch(client) {
  if (!dom) return;
  const name = String(client || '').trim() || 'Assistant';
  if (name !== cur.name) cur.name = name;
  dom.label.textContent = cur.name;
  dom.pillTxt.textContent = t('presence.pill', { name: cur.name });
  if (!dom.pill.isConnected) {
    const host = document.getElementById('tb-actions');
    if (host) host.prepend(dom.pill);
  }
  dom.pill.classList.add('on');
  clearTimeout(dom.pillT);
  dom.pillT = setTimeout(() => dom.pill.classList.remove('on'), PILL_MS);
  if (cur.visible) wake();
}

function boardShown() { return state.view === 'board' && !!ed()?.loaded; }

function wake() {
  if (!boardShown()) return;
  clearTimeout(cur.idleT);
  clearTimeout(cur.hideT);
  if (!cur.visible) {
    cur.visible = true;
    dom.cursor.classList.add('on');
    void getComputedStyle(dom.cursor).opacity;   // start the fade now, even if no frame is drawn yet
  }
  loop();
  cur.idleT = setTimeout(() => {
    if (dom.bubble.classList.contains('on') || performance.now() < cur.hold) { wake(); return; }
    hideCursor(false);
  }, IDLE_MS);
}

function hideCursor(now) {
  clearTimeout(cur.idleT);
  dom?.cursor.classList.remove('on');
  if (dom && now) { dom.bubble.classList.remove('on'); clearTimeout(cur.sayT); }
  clearTimeout(cur.hideT);
  cur.hideT = setTimeout(() => { cur.visible = false; }, now ? 0 : 450);
}

function loop() {
  if (!cur.raf) cur.raf = requestAnimationFrame(frame);
}

function frame(now) {
  cur.raf = 0;
  const a = cur.anim;
  if (a) {
    const k = Math.min(1, (now - a.t0) / a.ms);
    const q = EASE_OUT(k);
    cur.world = { x: a.from.x + (a.to.x - a.from.x) * q, y: a.from.y + (a.to.y - a.from.y) * q };
    if (k >= 1) { cur.anim = null; a.done(); }
  }
  place();
  if (cur.anim || cur.visible) loop();
}

/** World → screen every frame: the cursor stays on its block while the camera moves. */
function place() {
  const e = ed();
  if (!e || !cur.world || !boardShown()) { dom.cursor.style.visibility = 'hidden'; return; }
  const s = e.worldToScreen(cur.world);
  dom.cursor.style.visibility = '';
  dom.cursor.style.transform = `translate3d(${Math.round(s.x * 2) / 2}px, ${Math.round(s.y * 2) / 2}px, 0)`;
  // Près du bord droit ou bas de la fenêtre, la bulle (et l'étiquette) passent de l'autre côté de la pointe
  // au lieu de sortir de l'écran. Tailles de mise en page (offsetWidth : la bulle naît à scale .88).
  const M = 8;
  const bubbleOn = dom.bubble.classList.contains('on') || !!dom.bubble.textContent;
  const bw = bubbleOn ? dom.bubble.offsetWidth : 0, bh = bubbleOn ? dom.bubble.offsetHeight : 0;
  const lw = dom.label.offsetWidth;
  const flipX = s.x + 13 + Math.max(bw, lw) > innerWidth - M && s.x - 6 - Math.max(bw, lw) >= M;
  const flipY = bubbleOn && s.y + 42 + bh > innerHeight - M && s.y - 6 - bh >= M;
  if (dom.cursor.classList.contains('pr-flip-x') !== flipX) dom.cursor.classList.toggle('pr-flip-x', flipX);
  if (dom.cursor.classList.contains('pr-flip-y') !== flipY) dom.cursor.classList.toggle('pr-flip-y', flipY);
}

/** Glide the cursor's tip to a world point. */
function glideTo(world, ms = GLIDE_MS) {
  if (!world || !boardShown()) return Promise.resolve();
  const e = ed();
  if (!cur.world || !cur.visible) {
    // it comes in from a little up-left of its target, like a hand entering the frame
    const z = e?.camera?.()?.z || 1;
    cur.world = { x: world.x - 70 / z, y: world.y - 46 / z };
  }
  wake();
  if (cur.anim) cur.anim.done();
  return new Promise((resolve) => {
    const a = { from: { ...cur.world }, to: { ...world }, t0: performance.now(), ms, done: null, timer: 0 };
    let settled = false;
    // ends on its last frame, or on time when no frame comes (minimised window)
    a.done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(a.timer);
      if (cur.anim === a) { cur.anim = null; cur.world = { ...a.to }; place(); }
      resolve();
    };
    a.timer = setTimeout(a.done, ms + 120);
    cur.anim = a;
    loop();
  });
}

/** The little press of a click (run, wire dropped, block placed). */
function press() {
  if (!dom) return;
  dom.cursor.classList.remove('press');
  void dom.cursor.offsetWidth;
  dom.cursor.classList.add('press');
  setTimeout(() => dom.cursor.classList.remove('press'), 220);
}

function say(text) {
  dom.bubble.textContent = text;
  dom.bubble.classList.add('on');
  void getComputedStyle(dom.bubble).opacity;
  clearTimeout(cur.sayT);
  const ms = Math.min(12000, SAY_MS + Math.max(0, text.length - 120) * 25);
  const end = () => {
    if (performance.now() < cur.hold) { cur.sayT = setTimeout(end, 500); return; }   // a capture is being taken
    dom.bubble.classList.remove('on');
    wake();
  };
  cur.sayT = setTimeout(end, ms);
  wake();
}

// ── reading the board ───────────────────────────────────────────────────

function describeNode(e, n, R) {
  const def = typeOf(n.type);
  const box = boxOf(e, n);
  const o = { id: n.id, type: n.type, block: def ? tl(def.label) : n.type, title: n.title || null, x: n.x, y: n.y, w: box.w, h: box.h };
  if (n.bypass) o.bypass = true;
  if (n.collapsed) o.collapsed = true;
  if (def) {
    const ins = e.inputsOf(n.id) || {};
    // bloc Modèle (SPEC §23) : les entrées de son modèle (rangées ou non), et ce qu'il fait avec ce qui est branché
    const model = isModelBlock(n);
    const conn = Object.keys(ins).filter((k) => ins[k] && ins[k].length);
    o.inputs = (model ? nodeInputs(n, conn, { all: true }) : (def.inputs || [])).map((i) => {
      const p = { port: i.id, type: i.type, label: tl(i.label) };
      if (i.required) p.required = true;
      if (i.multi) { p.multi = true; if (i.max) p.max = i.max; }
      if (i.unused) p.ignored = true;
      if (i.trial) p.trial = true;
      p.from = (ins[i.id] || []).map((s) => ({ node: s.node, port: s.port }));
      return p;
    });
    o.outputs = (model ? nodeOutputs(n) : (def.outputs || [])).map((p) => ({ port: p.id, type: e.portType(n.id, p.id, 'out') || p.type, label: tl(p.label) }));
    if (model) o.model = modelInfo(n, conn);
    o.params = shownParams(n, { ...defaults(n.type), ...(n.params || {}) });
  }
  if (n.type === 'import') o.media = mediaOf(n);
  if (def?.engine) {
    const st = safe(() => R.state?.(n.id)) || { kind: 'idle' };
    o.state = { kind: st.kind, progress: st.progress ?? null, message: st.message || null, jobId: st.jobId || null };
    o.stale = !!safe(() => R.isStale?.(n.id));
    const run = safe(() => R.current?.(n.id));
    o.result = run ? runInfo(run) : null;
    o.versions = (safe(() => R.list?.(n.id)) || []).length;
  }
  return o;
}

/**
 * Réglages montrés à un assistant : tous pour un bloc ordinaire ; pour un bloc Modèle, ceux de son modèle seulement
 * (les façons de faire de sa famille, ses réglages en ligne hf.*), plus model et workflow.
 */
function shownParams(n, params) {
  if (!isModelBlock(n)) return params;
  const r = safe(() => blockWorkflow(n, []));
  if (!r) return params;
  const keep = new Set(['model', 'workflow', 'prompt']);
  for (const wf of r.fam.def.workflows || []) for (const p of wf.params || []) keep.add(typeof p === 'string' ? p : p.id);
  return Object.fromEntries(Object.entries(params).filter(([k]) => keep.has(k) || k.startsWith('hf.')));
}

/** Bloc Modèle : sa famille, ce qu'il fait avec ses fils, les autres façons possibles, ce qui manque ou est ignoré. */
function modelInfo(n, conn) {
  const r = safe(() => blockWorkflow(n, conn));
  if (!r) return { family: null, problem: 'unknown model: set params.model (mia_catalog → types[gen] params.model.choices)' };
  const ports = r.workflow.ports || {};
  const info = { family: r.fam.def.name, where: r.fam.provider === 'local' ? 'local' : 'online (paid)', does: tl(r.workflow.label || {}),
    workflow: r.workflow.id };
  const others = (r.ties || []).filter((w) => w.id !== r.workflow.id);
  if (others.length) info.otherWays = others.map((w) => ({ workflow: w.id, does: tl(w.label || {}) }));
  if (r.blocked) info.connect = r.missing;
  const uses = conn.filter((id) => id !== 'prompt' && ports[id] && !(r.unused || []).includes(id));
  if (uses.length) info.uses = uses;
  if (r.unused?.length) info.ignored = r.unused;
  // rien de branché : ce dont il peut partir (la ligne « Partir de : » de l'écran), port par port
  const starts = safe(() => startPoints({ ...n, data: { ...(n.data || {}), shown: [] } }, conn)) || [];
  if (starts.length) info.startFrom = starts.map((s) => ({ port: s.id, label: tl(s.label), for: s.what.map((w) => tl(w)) }));
  const trial = conn.filter((id) => ports[id]?.trial);
  if (r.workflow.trial || trial.length) info.trial = r.workflow.trial ? 'the whole way' : trial;
  return info;
}

function mediaOf(n) {
  const d = n.data || {};
  if (d.placeholder && !d.src) return { waiting: true, kind: d.placeholder.kind || null, label: tl(d.placeholder) };
  if (!d.src) return null;
  return { name: d.name || null, kind: d.kind || null, path: abs(d.src), meta: compactMeta(d.meta) };
}

function runInfo(run) {
  const outputs = Object.entries(run.outputs || {}).map(([port, o]) => ({
    port, path: abs(o.path), kind: o.kind || null, meta: compactMeta(o.meta), poster: abs(o.poster)
  }));
  return { runId: run.runId, mode: run.mode || null, status: run.status || null, model: run.model || null, finished: run.finished || null, outputs };
}

function safe(fn) { try { return fn(); } catch { return null; } }

// ── settings: values checked against the catalog ────────────────────────

function modelChoices(pd) {
  const inv = state.inventory;
  // bloc Modèle (SPEC §23) : une famille du PC (« fam:minimax », « minimax », « MiniMax H3 »), une variante précise
  // de l'inventaire, ou une famille en ligne (« hf:seedance-2-5 », « Seedance 2.5 »)
  if (pd.gen) {
    const list = [];
    const fams = localCatalog().families || {};
    for (const [key, def] of Object.entries(fams)) {
      if (!Array.isArray(def.workflows) || !def.workflows.length) continue;
      list.push({ value: `fam:${key}`, label: def.name, names: [`fam:${key}`, key, def.name] });
      for (const m of inv?.models || []) {
        if (m.status !== 'ready' || m.hidden || m.license === 'forbidden' || localKeyOf(m, fams) !== key) continue;
        list.push({ value: m.id, label: tl(m.label) || m.file, names: [m.id, m.file, m.label?.fr, m.label?.en].filter(Boolean) });
      }
    }
    for (const def of cloudCatalog().families || []) {
      list.push({ value: def.key, label: `${def.name} (${t('presence.online')})`, names: [def.key, def.key.slice(3), def.name] });
    }
    return { list, known: true };
  }
  const caps = pd.caps || [];
  const isLora = caps.includes('lora');
  const list = [];
  if (pd.allowNone) list.push({ value: 'none', names: ['none', 'aucun', 'aucune'] });
  if (!isLora) list.push({ value: 'auto', names: ['auto'] });
  for (const m of inv?.models || []) {
    if (m.status !== 'ready' || m.license === 'forbidden') continue;
    if (isLora) {
      if (!(m.role === 'lora' || (m.caps || []).includes('lora')) || m.hidden) continue;
    } else if (m.hidden || !(m.caps || []).some((c) => caps.includes(c))) continue;
    list.push({ value: m.id, label: tl(m.label) || m.file, names: [m.id, m.file, m.label?.fr, m.label?.en, m.trigger].filter(Boolean) });
  }
  return { list, known: !!inv?.models };
}

function coerce(pd, v, block) {
  const vars = { label: tl(pd.label), key: pd.id, value: String(v), block };
  switch (pd.kind) {
    case 'select':
    case 'seg': {
      const opts = pd.options || [];
      const hit = opts.find((o) => String(o.value) === String(v))
        || opts.find((o) => [o.label?.fr, o.label?.en].some((l) => l && norm(l) === norm(v)));
      if (!hit) fail('badOption', { ...vars, list: opts.map((o) => `${JSON.stringify(o.value)} (${tl(o.label)})`).join(', ') });
      return hit.value;
    }
    case 'slider': {
      const num = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
      if (!Number.isFinite(num)) fail('badNumber', vars);
      if ((pd.min != null && num < pd.min) || (pd.max != null && num > pd.max)) {
        fail('badRange', { ...vars, min: pd.min, max: pd.max, unit: pd.unit ? ` ${pd.unit}` : '' });
      }
      if (pd.step) {
        const base = pd.min ?? 0;
        const dec = (String(pd.step).split('.')[1] || '').length;
        return Number((Math.round((num - base) / pd.step) * pd.step + base).toFixed(dec));
      }
      return num;
    }
    case 'toggle': {
      if (typeof v === 'boolean') return v;
      const s = norm(v);
      if (['true', '1', 'oui', 'yes', 'on'].includes(s)) return true;
      if (['false', '0', 'non', 'no', 'off'].includes(s)) return false;
      return fail('badBool', vars);
    }
    case 'seed':
    case 'frame': {
      const num = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(num)) fail('badNumber', vars);
      return Math.round(num);
    }
    case 'prompt':
    case 'text':
      return v == null ? '' : String(v);
    case 'model': {
      const { list, known } = modelChoices(pd);
      const s = String(v ?? '');
      const hit = list.find((c) => c.value === s) || list.find((c) => c.names.some((x) => norm(x) === norm(s)));
      if (hit) return hit.value;
      if (!known) return s;                       // inventory not read yet: the engine will judge
      return fail('badModel', { ...vars, list: list.slice(0, 14).map((c) => (c.label ? `${c.value} (${c.label})` : c.value)).join(', ') });
    }
    default:
      return v;
  }
}

function checkParams(def, params, block, node = null) {
  const errs = [];
  const out = {};
  let known = def.params || [];
  // bloc Modèle en ligne : ses réglages « hf.* » sont ceux du schéma de sa famille (cloud-higgsfield.json)
  if (def.ports === 'model') {
    const value = params?.model ?? node?.params?.model ?? (def.params || []).find((p) => p.id === 'model')?.default;
    const fam = familyOf(value, localCatalog(), cloudCatalog(), state.inventory);
    if (fam && fam.provider !== 'local') {
      const extra = [];
      for (const wf of fam.def.workflows || []) for (const p of wf.params || []) if (!extra.some((q) => q.id === p.id)) extra.push(p);
      known = [...known, ...extra];
    }
  }
  for (const [k, v] of Object.entries(params || {})) {
    const pd = known.find((p) => p.id === k);
    if (!pd) {
      errs.push(t('presence.err.unknownParam', { block, key: k, list: known.map((p) => p.id).join(', ') || t('presence.err.none') }));
      continue;
    }
    try { out[k] = coerce(pd, v, block); } catch (err) { errs.push(err.message); }
  }
  if (errs.length) { const e = new Error(errs.join('\n')); e.user = true; throw e; }
  return out;
}

/** Settings that stay hidden because of their showIf (said back to the assistant). */
function hiddenNotes(def, params) {
  const notes = [];
  for (const pd of def.params || []) {
    if (!pd.showIf || !(pd.id in params)) continue;
    const val = params[pd.showIf.param];
    const ok = pd.showIf.notIn ? !pd.showIf.notIn.includes(val ?? null) : pd.showIf.in ? pd.showIf.in.includes(val) : true;
    if (!ok) notes.push(`${pd.id}: ${t('presence.note.hidden', { param: pd.showIf.param })}`);
  }
  return notes;
}

// ── wiring: port guessed when omitted ───────────────────────────────────

function endOf(x) {
  if (!x) return { node: null, port: null };
  if (typeof x === 'string') {
    const [node, port] = x.split('.');
    return { node, port: port || null };
  }
  return { node: x.node || x.nodeId || x.id || null, port: x.port || null };
}

const kindName = (k) => (has(`graph.kind.${k}`) ? `${t(`graph.kind.${k}`)} (${k})` : k);

function portLabelList(defs) {
  return defs.length ? defs.map((d) => `${d.id} (${d.type}, « ${tl(d.label)} »)`).join(', ') : t('presence.err.none');
}

// ── the methods ─────────────────────────────────────────────────────────

const METHODS = {
  async ui_state() {
    await whenAppReady();
    const e = ed();
    const g = e?.loaded ? e.getGraph() : null;
    const folder = state.project ? await folderOfBoard(state.project.id).catch(() => null) : null;
    return {
      view: state.view || null,
      board: state.project ? { id: state.project.id, name: state.project.name, dir: state.project.dir || null } : null,
      folder,
      readOnly: !!state.readOnly,
      blocks: g ? g.nodes.length : null,
      selection: e?.loaded ? e.selection() : [],
      lang: state.prefs?.lang || 'fr'
    };
  },

  /** A new board — inside a project (folder) when one is named, the project created if needed. */
  async create_project(p) {
    await whenAppReady();
    const app = appApi();
    if (!app || !ed()) fail('noEditor');
    const rec = p.recipe ? findRecipe(p.recipe) : null;
    if (p.recipe && !rec) fail('noRecipe', { q: p.recipe, list: recipeList() });
    if (app.tabs?.full?.()) fail('tabsFull');
    const folderQ = folderQuery(p.folder ?? p.folderId);
    const { folder, created, notes: folderNotes } = folderQ ? await ensureFolder(folderQ, p.color) : { folder: null, created: false, notes: [] };
    const name = (p.name ? String(p.name).trim().slice(0, 120) : '') || (rec ? tl(rec.label) : '') || t('app.untitled');
    // the store makes the board (in its folder), then the app opens it like a click on its card
    let r;
    try {
      r = await window.mia.projects.create({ name, recipe: rec?.id, ...(folder ? { folderId: folder.id } : {}) });
    } catch (err) { r = { ok: false, error: err?.message }; }
    if (answerFailed(r) || !r.id) fail('createFailed', { why: why(r) });
    if (!(await app.openProject(r.id))) fail('openFailed');
    const notes = [];
    if (created) notes.push(t('presence.note.folderCreated', { folder: folder.name }), ...(folderNotes || []));
    if (folder) {
      // a Mia whose store ignores folderId leaves the board at the root: say so
      const meta = (await listBoards()).find((b) => b.id === r.id);
      if (meta && folderIdOf(meta) !== folder.id) notes.push(t('presence.note.folderIgnored', { folder: folder.name }));
    }
    const e = ed();
    let blocks = [];
    if (rec && e?.loaded) {
      await pace();
      const ids = e.insertRecipe(rec) || [];
      blocks = mapRecipe(rec, ids, e);
      acted();
      try { await app.flushSave?.(); } catch { /* the debounced save follows */ }
      requestAnimationFrame(() => { try { e.fit(); } catch { /* view stays */ } });
    }
    if (e?.loaded) {
      await sleep(120);
      await glideTo(viewCenter(e));
    }
    const out = {
      boardId: r.id, name: state.project?.name || r.name || name, dir: state.project?.dir || null,
      folder: folder ? { id: folder.id, name: folder.name, created } : null,
      blocks
    };
    if (notes.length) out.notes = notes;
    return out;
  },

  /** A board by id, name, « Projet / Planche », {folder, name}, or a project alone (its latest board). */
  async open_project(p) {
    await whenAppReady();
    const app = appApi();
    if (!app) fail('noEditor');
    if (!(p.id || p.boardId || p.projectId || p.name || p.folder || p.folderId)) fail('needProject');
    const [boards, folders] = await Promise.all([listBoards(), listFolders()]);
    const { board: hit, folder, latest } = resolveBoard(p, boards, folders);
    if (state.project?.id !== hit.id && app.tabs && typeof app.tabs.has === 'function' && !app.tabs.has(hit.id) && app.tabs.full?.()) fail('tabsFull');
    const ok = await app.openProject(hit.id);
    if (!ok) fail('openFailed');
    const g = ed()?.getGraph();
    const out = {
      boardId: hit.id, name: state.project?.name || hit.name, dir: state.project?.dir || hit.dir || null,
      folder: folder ? { id: folder.id, name: folder.name } : null,
      blocks: g ? g.nodes.length : 0
    };
    if (latest && folder) {
      out.note = t('presence.note.latestBoard', {
        folder: folder.name,
        list: boards.filter((b) => folderIdOf(b) === folder.id).map((b) => `${b.id} (${b.name})`).join(', ')
      });
    }
    return out;
  },

  /** A project (folder of boards); an existing one with that name is returned rather than doubled. */
  async create_folder(p) {
    await whenAppReady();
    const api = foldersApi();
    if (!api) fail('noFolders');
    const name = String(p.name ?? '').trim().slice(0, 120).trim();
    if (!name) fail('needFolderName');
    const color = cleanColor(p.color);
    return oneFolderAtATime(async () => {
      let hit = await findFolderByName(name);
      let made = null;
      if (!hit) {
        made = await makeFolder(name, color);
        if (made.existed) hit = made.folder;      // the store found it, inside its own lock
      }
      if (hit) {
        const boards = (await listBoards()).filter((b) => folderIdOf(b) === hit.id);
        return {
          folderId: hit.id, name: hit.name, color: hit.color ?? null, existed: true,
          boards: boards.map((b) => ({ id: b.id, name: b.name })),
          note: t('presence.note.folderExisted', { folder: hit.name })
        };
      }
      const { folder: f, notes } = made;
      const out = { folderId: f.id, name: f.name, color: f.color ?? null, existed: false, boards: [] };
      if (notes.length) out.note = notes.join(' ');
      return out;
    });
  },

  async get_board(p) {
    const e = await board(p);
    const R = await getRuns();
    const g = e.getGraph();
    return {
      board: { id: state.project.id, name: state.project.name, dir: state.project.dir || null, folder: await folderOfBoard(state.project.id).catch(() => null) },
      readOnly: !!state.readOnly,
      blocks: g.nodes.map((n) => describeNode(e, n, R)),
      wires: g.edges.map((x) => ({ id: x.id, from: { ...x.from }, to: { ...x.to } })),
      sections: (g.groups || []).map((s) => ({ id: s.id, title: s.title || null, x: s.x, y: s.y, w: s.w, h: s.h })),
      selection: e.selection(),
      camera: g.camera || null
    };
  },

  async add_block(p) {
    const e = await board(p, { write: true });
    const def = findType(p.type);
    if (!def) fail('unknownType', { type: p.type ?? '', list: typeList() });
    const params = p.params ? checkParams(def, p.params, tl(def.label)) : {};
    const w = def.width || 288;
    const h = estimateH(def);
    let pos;
    if (p.at && Number.isFinite(+p.at.x) && Number.isFinite(+p.at.y)) pos = { x: Math.round(+p.at.x), y: Math.round(+p.at.y) };
    else pos = placeFor(e, { w, h, near: p.near });
    await ensureVisible(e, { x: pos.x, y: pos.y, w, h });
    await glideTo({ x: pos.x + 26, y: pos.y + 18 });
    await pace();
    press();
    const id = e.addNode(def.id, pos, { params });
    acted();
    if (!id) fail(state.readOnly ? 'readOnly' : 'addFailed');
    if (p.title) e.updateNode(id, { title: String(p.title).trim().slice(0, 80) }, { history: false });
    lastPlaced = id;
    // the real height is known now: if the block grew onto a neighbour, it slides down (same undo step)
    await nextFrame();
    const n = e.getNode(id);
    if (n && !(p.at && Number.isFinite(+p.at.x))) {
      const b = boxOf(e, n);
      const spot = freeSpot(allBoxes(e), n.x, n.y, b.w, b.h, id);
      if (spot.y !== n.y) e.updateNode(id, { y: spot.y }, { history: false });
    }
    const node = e.getNode(id);
    return {
      nodeId: id, type: def.id, block: tl(def.label), x: node.x, y: node.y,
      // un bloc Modèle n'a que les entrées de son modèle (SPEC §23), rangées ou non
      inputs: nodeInputs(node, [], { all: true }).map((i) => ({ port: i.id, type: i.type, label: tl(i.label), ...(i.required ? { required: true } : {}), ...(i.multi ? { multi: true, max: i.max || null } : {}) })),
      outputs: nodeOutputs(node).map((o) => ({ port: o.id, type: e.portType(id, o.id, 'out') || o.type, label: tl(o.label) })),
      params: shownParams(node, { ...defaults(def.id), ...(node.params || {}) }),
      notes: hiddenNotes(def, params)
    };
  },

  async connect(p) {
    const e = await board(p, { write: true });
    const from = endOf(p.from), to = endOf(p.to);
    const A = nodeOf(e, from.node), B = nodeOf(e, to.node);
    if (A.id === B.id) fail('selfWire');
    // entrées et sorties telles que le bloc les montre (un bloc Modèle : celles de son modèle, SPEC §23)
    const outs = nodeOutputs(A), ins = nodeInputs(B, [], { all: true });
    const a = blockName(A), b = blockName(B);
    if (!outs.length) fail('noOutputs', { block: a });
    if (!ins.length) fail('noInputs', { block: b });
    if (from.port && !outs.some((o) => o.id === from.port)) fail('noOutPort', { block: a, port: from.port, list: portLabelList(outs) });
    if (to.port && !ins.some((i) => i.id === to.port)) fail('noInPort', { block: b, port: to.port, list: portLabelList(ins) });

    const wired = e.inputsOf(B.id) || {};
    // bloc Modèle : l'entrée principale de son modèle d'abord (MiniMax : les références), comme un fil lâché sur le corps
    const main = isModelBlock(B) ? (safe(() => mainPorts(blockFamily(B))) || []) : [];
    const rank = (i) => {
      const n = (wired[i.id] || []).length;
      if (!n) return i.required ? 0 : main.includes(i.id) ? 0.5 : 1;
      if (i.multi && (!i.max || n < i.max)) return 2;
      return 3;
    };
    const inOrder = to.port ? ins.filter((i) => i.id === to.port) : ins.slice().sort((x, y) => rank(x) - rank(y));
    const outCands = from.port ? outs.filter((o) => o.id === from.port) : outs;
    let pick = null;
    for (const o of outCands) {
      const ot = e.portType(A.id, o.id, 'out') || o.type;
      const i = inOrder.find((x) => compatible(ot, x.type));
      if (i) { pick = { o, i, ot }; break; }
    }
    if (!pick) {
      const o = outCands[0];
      const ot = e.portType(A.id, o.id, 'out') || o.type;
      const unknown = ot === 'media' ? t('presence.err.unknownKind', { a }) : '';
      const okIns = ins.filter((x) => compatible(ot, x.type));
      if (to.port) {
        const i = ins.find((x) => x.id === to.port);
        const err = new Error(t('presence.err.incompatible', {
          out: o.id, outType: kindName(ot), a, in: i.id, inType: kindName(i.type), b, list: portLabelList(okIns)
        }) + unknown);
        err.user = true;
        throw err;
      }
      const err = new Error(t('presence.err.noCompatible', { a, b, outType: kindName(ot), list: portLabelList(ins) }) + unknown);
      err.user = true;
      throw err;
    }
    const count = (wired[pick.i.id] || []).length;
    if (pick.i.multi && pick.i.max && count >= pick.i.max) fail('full', { in: tl(pick.i.label), b, max: pick.i.max });
    const replaced = !pick.i.multi && count > 0 ? (wired[pick.i.id] || []).map((s) => ({ ...s })) : [];

    await ensureVisible(e, union([boxOf(e, A), boxOf(e, B)]));
    await glideTo(portPoint(e, A.id, pick.o.id, 'out'));
    await sleep(80);
    await glideTo(portPoint(e, B.id, pick.i.id, 'in'), GLIDE_MS + 60);
    await pace();
    press();
    const edgeId = e.connect(A.id, pick.o.id, B.id, pick.i.id);
    acted();
    if (!edgeId) fail('refused');
    return { wireId: edgeId, from: { node: A.id, port: pick.o.id }, to: { node: B.id, port: pick.i.id }, type: pick.ot, replaced };
  },

  async set_params(p) {
    const e = await board(p, { write: true });
    const n = nodeOf(e, p.nodeId);
    const def = typeOf(n.type);
    const clean = checkParams(def || { params: [] }, p.params || {}, blockName(n), n);
    if (!Object.keys(clean).length) return { nodeId: n.id, params: { ...defaults(n.type), ...(n.params || {}) } };
    await ensureVisible(e, boxOf(e, n));
    const controls = safe(() => e.slotEls(n.id)?.controls) || '.nb-foot';
    await glideTo(elPoint(e, n, controls, 0.42, 0.3));
    await pace();
    e.updateNode(n.id, { params: clean });
    acted();
    const after = { ...defaults(n.type), ...(e.getNode(n.id)?.params || {}) };
    return { nodeId: n.id, params: after, notes: hiddenNotes(def || {}, after).filter((x) => Object.keys(clean).some((k) => x.startsWith(`${k}:`))) };
  },

  async rename_block(p) {
    const e = await board(p, { write: true });
    const n = nodeOf(e, p.nodeId);
    await ensureVisible(e, boxOf(e, n));
    await glideTo(elPoint(e, n, '.n-title', 0.3, 0.6));
    await pace();
    e.updateNode(n.id, { title: p.title == null ? null : String(p.title).trim().slice(0, 80) || null });
    acted();
    return { nodeId: n.id, title: e.getNode(n.id)?.title || null, block: blockName(e.getNode(n.id)) };
  },

  async remove_blocks(p) {
    const e = await board(p, { write: true });
    const ids = (Array.isArray(p.nodeIds) ? p.nodeIds : p.nodeIds ? [p.nodeIds] : []).map(String);
    if (!ids.length) fail('needIds');
    const nodes = ids.map((id) => nodeOf(e, id));
    await ensureVisible(e, union(nodes.map((n) => boxOf(e, n))));
    await glideTo(elPoint(e, nodes[0], '.n-head', 0.5, 0.5));
    await pace();
    press();
    e.removeNodes(nodes.map((n) => n.id));
    acted();
    if (lastPlaced && !e.getNode(lastPlaced)) lastPlaced = null;
    if (lastMedia && !e.getNode(lastMedia)) lastMedia = null;
    return { removed: nodes.map((n) => ({ id: n.id, block: blockName(n) })) };
  },

  async import_media(p) {
    const e = await board(p, { write: true });
    const paths = Array.isArray(p.paths) ? p.paths : [];
    let into = null;
    if (p.into) {
      into = nodeOf(e, p.into);
      if (into.type !== 'import') fail('notImport');
    }
    const def = typeOf('import');
    const w = def?.width || 336;
    let at;
    if (into) {
      await ensureVisible(e, boxOf(e, into));
      await glideTo(elPoint(e, into, null, 0.5, 0.35));
    } else {
      const pos = placeFor(e, { w, h: 300, near: p.near, media: !p.near });
      at = { x: pos.x + w / 2, y: pos.y + 18 };          // the editor puts the block's top-left at (x - w/2, y - 18)
      await ensureVisible(e, { x: pos.x, y: pos.y, w, h: 300 });
      await glideTo({ x: pos.x + 26, y: pos.y + 18 });
    }
    await pace();
    press();
    const ids = (await e.importFiles(paths, at, into ? into.id : undefined)) || [];
    acted();
    if (!ids.length) fail('importFailed');
    lastMedia = ids[ids.length - 1];
    if (!into) lastPlaced = lastPlaced && e.getNode(lastPlaced) ? lastPlaced : null;
    const blocks = ids.map((id) => {
      const n = e.getNode(id);
      return { nodeId: id, block: blockName(n), name: n?.data?.name || null, kind: n?.data?.kind || null, path: abs(n?.data?.src), meta: compactMeta(n?.data?.meta), x: n?.x, y: n?.y };
    });
    const out = { blocks };
    if (ids.length < paths.length) out.note = t('presence.note.partial', { n: paths.length - ids.length });
    return out;
  },

  async insert_recipe(p) {
    const e = await board(p, { write: true });
    const rec = findRecipe(p.recipe);
    if (!rec) fail('noRecipe', { q: p.recipe ?? '', list: recipeList() });
    let at = p.at && Number.isFinite(+p.at.x) && Number.isFinite(+p.at.y) ? { x: +p.at.x, y: +p.at.y } : null;
    if (!at) {
      // beside what is already there, never on top of it
      const boxes = allBoxes(e);
      if (boxes.length) {
        const xs = rec.nodes.map((n) => n.x), ys = rec.nodes.map((n) => n.y);
        const rw = Math.max(...xs) - Math.min(...xs) + 336, rh = Math.max(...ys) - Math.min(...ys) + 420;
        const bb = union(boxes);
        at = { x: bb.x + bb.w + GAP_X * 2 + rw / 2, y: bb.y + rh / 2 };
        await ensureVisible(e, { x: at.x - rw / 2, y: at.y - rh / 2, w: rw, h: rh });
      }
    }
    await glideTo(at || viewCenter(e));
    await pace();
    press();
    const ids = e.insertRecipe(rec, at || undefined) || [];
    acted();
    const blocks = mapRecipe(rec, ids, e);
    if (blocks.length) lastPlaced = blocks[blocks.length - 1].nodeId;
    return { recipe: rec.id, blocks };
  },

  async arrange(p) {
    const e = await board(p, { write: true });
    const g = e.getGraph();
    if (!g.nodes.length) fail('noNodes');
    await glideTo(viewCenter(e));
    await pace();
    let moved;
    // the editor's own arrange glides on animation frames: a minimised window gives none, so it never
    // holds the assistant longer than a few seconds (it finishes when the window comes back)
    if (typeof e.arrange === 'function') moved = await Promise.race([e.arrange(), sleep(3000)]);
    else moved = await arrangeFallback(e);
    acted();
    await sleep(60);
    try { e.fit(); } catch { /* view stays */ }
    await sleep(CAMERA_MS);
    return { arranged: g.nodes.length, moved: typeof moved === 'number' ? moved : null };
  },

  async run(p) {
    const e = await board(p);
    const n = nodeOf(e, p.nodeId);
    const def = typeOf(n.type);
    if (!def?.engine) fail('notRunnable', { block: blockName(n) });
    let mode = p.mode ? String(p.mode) : null;
    if (Array.isArray(def.modes) && def.modes.length) {
      if (!mode) mode = def.modes.includes('preview') ? 'preview' : def.modes[0];
      else if (!def.modes.includes(mode)) fail('badMode', { mode, list: def.modes.join(', ') });
    } else mode = null;
    const R = await getRuns();
    const st = safe(() => R.state?.(n.id));
    // boardId, and projectId: its old name (deprecated, kept for assistants written before SPEC §18)
    const where = { boardId: state.project.id, projectId: state.project.id };
    if (st && ACTIVE.has(st.kind) && st.jobId) return { jobId: st.jobId, nodeId: n.id, ...where, mode, already: true };

    await ensureVisible(e, boxOf(e, n));
    const btnSel = mode === 'final' ? '.nb-foot button:not(.shiny)' : '.nb-foot button.shiny, .nb-foot .btn-primary';
    await glideTo(elPoint(e, n, btnSel, 0.5, 0.5));
    await pace();
    press();
    let res;
    try {
      res = await window.mia.engine.run({ projectId: state.project.id, nodeId: n.id, graph: e.getGraph(), mode });
    } catch (err) {
      res = { ok: false, error: err?.message || String(err) };
    }
    acted();
    if (!res || res.ok === false) {
      const missing = Array.isArray(res?.missing) && res.missing.length
        ? t('presence.err.missing', { list: res.missing.map((m) => (typeof m === 'string' ? m : m?.message || m?.label || JSON.stringify(m))).join(' ; ') })
        : '';
      const err = new Error(t('presence.err.runFailed', { why: res?.error || '?' }) + missing);
      err.user = true;
      throw err;
    }
    const out = { jobId: res.jobId || null, nodeId: n.id, ...where, block: blockName(n), mode };
    if (mode === 'preview') out.note = t('presence.note.preview');
    return out;
  },

  async get_output(p) {
    const e = await board(p);
    const n = nodeOf(e, p.nodeId);
    const name = blockName(n);
    if (n.type === 'import') {
      const m = mediaOf(n);
      if (!m || m.waiting) fail('noMedia', { block: name });
      return { nodeId: n.id, block: name, outputs: [{ port: 'out', path: m.path, kind: m.kind, meta: m.meta }] };
    }
    if (n.type === 'text') {
      return { nodeId: n.id, block: name, outputs: [{ port: 'text', text: n.params?.text ?? '', negative: n.params?.negative ?? '' }] };
    }
    const R = await getRuns();
    const run = safe(() => R.current?.(n.id));
    if (!run) fail('noResult', { block: name });
    const info = runInfo(run);
    if (p.port) {
      const o = info.outputs.find((x) => x.port === p.port);
      if (!o) fail('noOutPortResult', { block: name, port: p.port, list: info.outputs.map((x) => x.port).join(', ') || t('presence.err.none') });
      info.outputs = [o];
    }
    const st = safe(() => R.state?.(n.id));
    return { nodeId: n.id, block: name, stale: !!safe(() => R.isStale?.(n.id)), busy: !!(st && ACTIVE.has(st.kind)), ...info };
  },

  async focus(p) {
    const e = await board(p);
    const ids = (Array.isArray(p.nodeIds) ? p.nodeIds : p.nodeIds ? [p.nodeIds] : p.nodeId ? [p.nodeId] : []).map(String);
    if (!ids.length) fail('needIds');
    const nodes = ids.map((id) => nodeOf(e, id));
    if (nodes.length === 1) e.focusNode(nodes[0].id);
    else { e.select(nodes.map((n) => n.id)); e.fit(nodes.map((n) => n.id)); }
    await sleep(CAMERA_MS + 40);
    await glideTo(elPoint(e, nodes[0], '.n-title', 0.5, 0.9));
    acted();
    return { focused: nodes.map((n) => n.id) };
  },

  async add_section(p) {
    const e = await board(p, { write: true });
    const ids = (Array.isArray(p.nodeIds) ? p.nodeIds : p.nodeIds ? [p.nodeIds] : []).map(String);
    if (!ids.length) fail('needIds');
    const nodes = ids.map((id) => nodeOf(e, id));
    const tones = ['grey', 'teal', 'green', 'yellow', 'orange', 'red'];
    const title = String(p.title ?? '').trim().slice(0, 80) || null;
    const gid = e.addSection({ around: nodes.map((n) => n.id) }, { title, tone: tones.includes(p.tone) ? p.tone : null, edit: false, select: false });
    if (!gid) fail('needIds');
    const g = (e.getGraph()?.groups || []).find((x) => x.id === gid);
    if (g) await glideTo({ x: g.x + 24, y: g.y - 10 });
    acted();
    return { sectionId: gid, title: g ? g.title : title, around: nodes.map((n) => n.id) };
  },

  async say(p) {
    await whenAppReady();
    const text = String(p.text ?? '').trim().slice(0, 400);
    if (!text) fail('emptyText');
    if (!dom) return { shown: false };
    const e = ed();
    if (boardShown() && e) {
      if (!cur.world) await glideTo(viewCenter(e));
      say(text);
      return { shown: true };
    }
    return { shown: false, view: state.view };
  },

  async snapshot_prepare(p) {
    await whenAppReady();
    let rect = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    const e = ed();
    const n = p.nodeId && e?.loaded ? nodeOf(e, p.nodeId) : null;
    if (n) {
      e.focusNode(n.id);
      await sleep(CAMERA_MS + 80);
    }
    // the settled view: a camera glide still running (or starved of frames in a hidden window) ends now
    if (e?.loaded && typeof e.setCamera === 'function') { try { e.setCamera(e.camera(), { animate: false }); } catch { /* view stays */ } }
    if (n) {
      // from the camera, not from the DOM: the page may not have drawn the new view yet
      const b = boxOf(e, n);
      const z = e.camera()?.z || 1;
      const s0 = e.worldToScreen({ x: b.x, y: b.y });
      const pad = 18;
      const x0 = Math.max(0, s0.x - pad), y0 = Math.max(0, s0.y - pad);
      const x1 = Math.min(window.innerWidth, s0.x + b.w * z + pad), y1 = Math.min(window.innerHeight, s0.y + b.h * z + pad);
      if (x1 - x0 > 8 && y1 - y0 > 8) rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }
    await sleep(260);                                // the bubble and the blocks finish fading in
    // the cursor and the bubble stay until the capture is taken (a hidden window can take seconds)
    if (cur.visible) { cur.hold = performance.now() + 20000; wake(); }
    return {
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      view: state.view || null,
      board: state.project ? { id: state.project.id, name: state.project.name } : null
    };
  }
};

function mapRecipe(rec, ids, e) {
  const keys = (rec.nodes || []).filter((n) => typeOf(n.type)).map((n) => n);
  return ids.map((id, i) => {
    const k = keys[i];
    const n = e.getNode(id);
    const o = { key: k?.key || null, nodeId: id, type: n?.type || k?.type || null, block: n ? blockName(n) : null };
    if (k?.placeholder) o.waitsFor = { kind: k.placeholder.kind, label: tl(k.placeholder) };
    return o;
  });
}

/**
 * Left → right along the wires (used when the editor has no arrange() of its own): columns by depth,
 * each block near the height of what feeds it, one single undo step, a short glide of the blocks.
 */
async function arrangeFallback(e) {
  const g = e.getGraph();
  const nodes = g.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const preds = new Map(nodes.map((n) => [n.id, []]));
  for (const x of g.edges) if (byId.has(x.from.node) && byId.has(x.to.node)) preds.get(x.to.node).push(x.from.node);
  const layer = new Map();
  const depth = (id, guard = 0) => {
    if (layer.has(id)) return layer.get(id);
    if (guard > 200) return 0;
    const ps = preds.get(id) || [];
    const l = ps.length ? Math.max(...ps.map((p) => depth(p, guard + 1) + 1)) : 0;
    layer.set(id, l);
    return l;
  };
  for (const n of nodes) depth(n.id);
  const cols = [];
  for (const n of nodes) (cols[layer.get(n.id)] ||= []).push(n.id);
  const box = new Map(nodes.map((n) => [n.id, boxOf(e, n)]));
  const x0 = snapNear(Math.min(...nodes.map((n) => n.x)));
  const y0 = snapNear(Math.min(...nodes.map((n) => n.y)));
  const target = new Map();
  let x = x0;
  cols.forEach((col, ci) => {
    if (!col || !col.length) return;
    const want = (id) => {
      if (ci === 0) return box.get(id).y;
      const ps = (preds.get(id) || []).filter((p) => target.has(p));
      if (!ps.length) return box.get(id).y;
      return ps.reduce((s, p) => s + target.get(p).y + box.get(p).h / 2, 0) / ps.length - box.get(id).h / 2;
    };
    const wanted = new Map(col.map((id) => [id, want(id)]));
    col.sort((a, b) => wanted.get(a) - wanted.get(b));
    let bottom = null;
    for (const id of col) {
      let y;
      if (ci === 0) y = bottom === null ? y0 : bottom + GAP_Y;                 // sources: stacked in their order
      else y = bottom === null ? wanted.get(id) : Math.max(wanted.get(id), bottom + GAP_Y);
      y = snapNear(y);
      target.set(id, { x, y });
      bottom = y + box.get(id).h;
    }
    x += Math.max(...col.map((id) => box.get(id).w)) + GAP_X;
  });
  return tweenTo(e, target);
}

/** Glide blocks to their new places; the first step records the whole board, so one Ctrl+Z undoes it all. */
async function tweenTo(e, target) {
  const moving = [...target].filter(([id, p]) => {
    const n = e.getNode(id);
    return n && (n.x !== p.x || n.y !== p.y);
  });
  if (!moving.length) return 0;
  const start = new Map(moving.map(([id]) => { const n = e.getNode(id); return [id, { x: n.x, y: n.y }]; }));
  const [fid, ft] = moving[0];
  const fs = start.get(fid);
  e.updateNode(fid, { x: fs.x + (Math.sign(ft.x - fs.x) || 1), y: fs.y }, { history: true });
  const ms = 480;
  const t0 = performance.now();
  await new Promise((resolve) => {
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      const q = EASE_OUT(k);
      for (const [id, to] of moving) {
        const s = start.get(id);
        e.updateNode(id, { x: Math.round(s.x + (to.x - s.x) * q), y: Math.round(s.y + (to.y - s.y) * q) }, { history: false });
      }
      if (k < 1) nextFrame().then(() => step(performance.now()));
      else resolve();
    };
    nextFrame().then(() => step(performance.now()));
  });
  return moving.length;
}

// ── cubic-bezier easing (same curve as the CSS token) ───────────────────

function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (s) => ((ax * s + bx) * s + cx) * s;
  const sy = (s) => ((ay * s + by) * s + cy) * s;
  const dx = (s) => (3 * ax * s + 2 * bx) * s + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let s = x;
    for (let i = 0; i < 8; i++) {
      const err = sx(s) - x;
      const d = dx(s);
      if (Math.abs(err) < 1e-5 || Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    s = Math.min(1, Math.max(0, s));
    return sy(s);
  };
}
