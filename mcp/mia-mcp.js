#!/usr/bin/env node
'use strict';
/**
 * Mia — MCP server (stdio, zero dependency) for assistants: Claude (Claude Code, Claude app) and Codex.
 *
 * JSON-RPC 2.0, one JSON message per line on stdin/stdout (logs go to stderr only). It forwards every tool
 * call to Mia's local bridge (electron/bridge.js) whose port and token are in
 *   %APPDATA%\Mia\data\bridge.json      (MIA_BRIDGE_FILE overrides it — tests)
 * and starts Mia (wscript.exe Mia.vbs) when it is not running, waiting up to 25 s.
 *
 * Environment:
 *   MIA_BRIDGE_FILE=<path>   bridge.json to read (tests use their own Mia profile)
 *   MIA_NO_LAUNCH=1          never start Mia (tests)
 *   MIA_CLIENT_NAME=<name>   name shown on the presence cursor, instead of the client's own
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const MIA_ROOT = path.resolve(__dirname, '..');
const BRIDGE_FILE = process.env.MIA_BRIDGE_FILE
  || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Mia', 'data', 'bridge.json');
const NO_LAUNCH = process.env.MIA_NO_LAUNCH === '1';
const LAUNCH_WAIT_MS = 25000;
const CALL_TIMEOUT_MS = 90000;
const SERVER_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(MIA_ROOT, 'package.json'), 'utf8')).version || '0.1.0'; } catch { return '0.1.0'; }
})();
const DEFAULT_PROTOCOL = '2025-06-18';

const log = (...a) => { try { process.stderr.write(`[mia-mcp] ${a.join(' ')}\n`); } catch { /* closed */ } };

class UserError extends Error {}

// ---------------------------------------------------------------- the catalog, for the descriptions
function readCatalog() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(MIA_ROOT, 'src', 'catalog', 'nodes.json'), 'utf8'));
    return Array.isArray(c.types) ? c.types : [];
  } catch { return []; }
}
function readRecipes() {
  try {
    const dir = path.join(MIA_ROOT, 'src', 'catalog', 'recipes');
    const ids = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    return ids.map((id) => {
      try { const r = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')); return { id: r.id, fr: r.label && r.label.fr }; } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}
const TYPES = readCatalog();
const TYPE_IDS = TYPES.map((t) => t.id);
const TYPE_LINES = TYPES.map((t) => {
  const ins = (t.inputs || []).map((i) => `${i.id}:${i.type}${i.multi ? `×${i.max || 'n'}` : ''}${i.required ? '!' : ''}`).join(' ');
  const outs = (t.outputs || []).map((o) => `${o.id}:${o.type}`).join(' ');
  // the Model block's inputs are those of its model (mia_catalog → its params.model.choices[].ways)
  const insText = t.ports === 'model' ? `depends on params.model, up to: ${ins}` : ins;
  return `- ${t.id} « ${t.label && t.label.fr} » — ${t.desc && t.desc.en ? t.desc.en : ''} [in: ${insText || '—'} | out: ${outs || '—'}]${t.modes ? ' (modes: preview, final)' : ''}${t.engine ? '' : ' (no computation)'}`;
}).join('\n');
const RECIPES = readRecipes();
const RECIPE_LINE = RECIPES.map((r) => `${r.id} « ${r.fr} »`).join(', ');

// ---------------------------------------------------------------- tools
const INSTRUCTIONS = [
  'Mia is the user\'s local AI node board (Windows app, French or English UI, runs ComfyUI/Python models on the user\'s own GPU).',
  'Vocabulary — use it with the user: a BOARD (« planche » in the French UI) is one node canvas shown in one tab: its blocks, wires, sections, imported media and results. Board ids start with "p_" (the tools call it boardId). A PROJECT (« projet ») is a FOLDER that groups several boards, like a Chrome tab group (ids start with "f_"; the tools call it folder). A board may also stay outside any project. One level only: no project inside a project. The tool names are historical: mia_create_project creates a BOARD, mia_open_project opens a BOARD, mia_list_projects lists the projects AND the boards, mia_create_folder creates a PROJECT.',
  'Everything you do on a board is VISIBLE LIVE on the user\'s screen: a cursor labelled with your name glides to each block you place, wire or set; blocks fade in; Ctrl+Z undoes any of your actions.',
  'Language: mia_status returns mia.lang, the language of Mia\'s interface ("fr" or "en"). Write mia_say messages and project, board, section and block names in that language, short and plain.',
  'Typical flow: mia_status → mia_list_projects (the user\'s projects and their boards) → mia_catalog (once; it lists every block type, its ports, settings with allowed values, installed models and LoRAs) → a new board: mia_create_project {folder:"<project>", name:"<board>"} (the project is created when it does not exist yet), or an existing board: mia_open_project {name:"<project> / <board>"} → mia_import_media with ABSOLUTE Windows paths → mia_add_block with near=<the block that feeds it> → mia_connect → mia_set_params with values taken from the catalog → mia_run (generation blocks: mode "preview" first, then "final" once it looks right) → mia_wait → mia_get_output / mia_snapshot to look at the result → mia_say to tell the user what you did.',
  'Organising work: one project per film or subject, one board per shot or idea inside it (project « Mon film » → boards « Plan 01 », « Plan 02 »…); inside one board, mia_add_section frames related blocks. When the user names a project, put the new boards in it (folder). Never move, rename or empty the user\'s boards unless asked.',
  'Heavy GPU jobs go through the same queue and GPU lock as the user\'s own clicks (one at a time); a job may wait for the GPU. Never delete blocks you did not create unless asked.',
  'Ports: image→image|media, video→video|media, text→text, audio→audio (import a wav/mp3/m4a/flac with mia_import_media, wire it into the Son block, or into a Model block\'s sound inputs: MiniMax reference sounds, a sound to follow). Settings marked "overriddenByInput" are replaced by a wired text block (Consigne).',
  'MODEL BLOCK (type "gen", « Modèle »): when the user names a model (LTX, MiniMax, Wan, Qwen, Seedance, Kling…), add ONE gen block with params.model = its family (mia_catalog → types[gen].params[model].choices: fam:ltx, fam:minimax, fam:wan, fam:qwen, fam:klein, fam:qwen21, or hf:… online). Its inputs are its model\'s; what you wire picks what it does (choices[].ways: needs, takes, settings) — read types[gen].howItWorks once. mia_get_board shows each Model block\'s model.does, model.uses (wired inputs it uses), model.connect (what is missing), model.ignored, model.trial and, while nothing is wired, model.startFrom (the inputs it can start from — the « Partir de : » buttons of the screen; wire the port, no click needed). The task blocks (i2v « Animer une image », ref2v…) and recipes still exist and stay fine for their one job.',
  'Local model abilities (this PC): LTX 2.5 — from text, animate a start image (+ end image, + up to 4 keyframes in between, + a character sheet), guided video and 3D render → photoreal (both take the start image as their look), video from a character sheet alone (one image with the cast/props side by side; trial). LTX does NOT blend several separate references: use MiniMax for that. MiniMax H3 — from text, animate (start/end, keyframes, a sound to follow), references (up to 9 images, 3 videos, 3 sounds, named « Image n », « Vidéo n », « Son n » in the prompt), guided video, extend a video (the result is the whole video made longer), up to 15 s, 768p. Wan Animate 2 — a character + a motion video (settings motionFidelity, likeness). Qwen Image Edit — edit an image with up to 2 helper images. FLUX.2 Klein 9B (fam:klein) — an image from text in seconds (format, resolution 1K/1.5K), or wire an image to edit it keeping its framing. Qwen-Image 2.1 Turbo (fam:qwen21) — an image from text, very good at text written in the image (up to 2K). Both: non-commercial licenses (trials, personal projects), new (trial); a LoRA is offered only on the model it was trained for. Keyframes: keep the start image\'s framing, a keyframe framed differently makes the shot cut. Features marked trial are new: tell the user to judge them by eye.'
].join('\n');

const nodeRef = {
  type: 'object',
  description: 'A block end: {"node": "<block id>", "port": "<port id>"} — port optional (the first compatible one is chosen).',
  properties: {
    node: { type: 'string', description: 'Block id (n_…)' },
    port: { type: 'string', description: 'Port id from mia_catalog (e.g. "out", "media", "start")' }
  },
  required: ['node'],
  additionalProperties: false
};
const point = {
  type: 'object',
  description: 'World coordinates of the block\'s top-left corner on the board (blocks are ~288–336 wide).',
  properties: { x: { type: 'number' }, y: { type: 'number' } },
  required: ['x', 'y'],
  additionalProperties: false
};
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const FOLDER_COLORS = ['grey', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink'];   // projects (SPEC §18.1)
// Before SPEC §18 a board was called a project: "projectId" is still accepted (deprecated) wherever boardId is.
const boardIdProp = (what) => ({ type: 'string', description: what });
const projectIdAlias = { type: 'string', deprecated: true, description: 'Deprecated: the old name of boardId (p_…), still accepted for now. Use boardId.' };

const TOOLS = [
  {
    name: 'mia_status', method: 'status', annotations: { title: 'Mia: status', ...RO },
    description: 'Is Mia open, the language of its interface (mia.lang: write to the user in it), which view is shown (home page or a board), which board is open (id, name) and in which project (folder), how many blocks, the ComfyUI engine state, the GPU (VRAM, who holds it) and the job queue, and which capabilities (image-to-video, depth, cutout…) have a model installed. Call it first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'mia_catalog', method: 'catalog', annotations: { title: 'Mia: block catalog', ...RO },
    description: `Everything you need to build a board: every block type with its input/output ports (type, required, multi/max), its settings (kind, default, allowed values or range, model choices with ids), the recipes, the models available per capability and the LoRAs. Call it once before building; pass "type" to get one block only.\nBlock types (id « name in the French UI » — in/out ports, ! = required; mia_catalog gives the names in Mia\'s language):\n${TYPE_LINES}`,
    inputSchema: { type: 'object', properties: { type: { type: 'string', description: 'Optional: only this block type', ...(TYPE_IDS.length ? { enum: TYPE_IDS } : {}) } }, additionalProperties: false }
  },
  {
    name: 'mia_list_projects', method: 'list_projects', annotations: { title: 'Mia: projects and boards', ...RO },
    description: 'The user\'s projects and boards. Returns { folders: [{id "f_…", name, color, boards: how many boards it holds}] — the PROJECTS (folders of boards) —, boards: [{id "p_…", name, folderId, folder: the name of its project, blocks, dir, updated, opened}] — every BOARD, folderId null when it is outside any project }. Open a board with mia_open_project (its id, or "<project> / <board>").',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'mia_create_folder', method: 'create_folder', annotations: { title: 'Mia: new project (folder of boards)', ...EDIT, idempotentHint: true },
    description: 'Create a PROJECT: a folder that groups boards (a card on Mia\'s home page, a coloured group of tabs). Short name in Mia\'s language (mia_status → mia.lang), e.g. « Mon film ». If a project with that name already exists (case, accents and extra spaces ignored) it is returned with existed:true and its boards: nothing is doubled, never « Mon film 2 ». Returns folderId (f_…). Then make boards in it with mia_create_project {folder}. (mia_create_project {folder} also creates a missing project by itself.)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 120, description: 'Project name (in Mia\'s language, short)' },
        color: { type: 'string', enum: FOLDER_COLORS, description: 'Optional muted colour of the project (tab group, home card). Default: Mia chooses.' }
      },
      required: ['name'],
      additionalProperties: false
    }
  },
  {
    name: 'mia_create_project', method: 'create_project', annotations: { title: 'Mia: new board', ...EDIT },
    description: `Create a new BOARD (« planche ») and open it in a new tab (visible). "folder" = the PROJECT to put it in: its name or its id (f_…); the project of that name is reused (case, accents and extra spaces ignored: never a second « Mon film 2 »), and created only when none has it (folder.created:true in the answer). Without folder the board stays outside any project. Short names in Mia's language: board « Plan 05 », project « Mon film ». Optional "recipe" pre-fills the board with a ready-made chain (its empty Média blocks are then filled with mia_import_media into=<their id>). Recipes: ${RECIPE_LINE || '(see mia_catalog)'}. Returns boardId (p_…), name, folder {id, name, created} or null, dir, blocks.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Board name (in Mia\'s language, short), e.g. « Plan 12 · profondeur »' },
        folder: { type: 'string', description: 'Optional project for the board: its name (created when missing) or its id f_…' },
        color: { type: 'string', enum: FOLDER_COLORS, description: 'Optional colour, used only when the project is created now' },
        recipe: { type: 'string', description: 'Optional recipe id', ...(RECIPES.length ? { enum: RECIPES.map((r) => r.id) } : {}) }
      },
      additionalProperties: false
    }
  },
  {
    name: 'mia_open_project', method: 'open_project', annotations: { title: 'Mia: open a board', ...EDIT, idempotentHint: true },
    description: 'Open an existing BOARD in its tab. Name it by id ("p_…"), by name ("Plan 05"), by "<project> / <board>" ("Mon film / Plan 05"), or with folder + name ({folder:"Mon film", name:"Plan 05"}). A project alone (folder, or a project id "f_…") opens its most recently used board and lists the others. Names: exact first, then partial; case and accents ignored; several matches give an error that lists them with their project.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Board id (p_…), or a project id (f_…) to open its latest board' },
        boardId: boardIdProp('Board id (p_…): same as id'),
        name: { type: 'string', description: 'Board name, or "<project> / <board>"' },
        folder: { type: 'string', description: 'Optional project (name or f_… id) the board is in' },
        projectId: projectIdAlias
      },
      additionalProperties: false
    }
  },
  {
    name: 'mia_get_board', method: 'get_board', annotations: { title: 'Mia: read the board', ...RO },
    description: 'The open board (id, name, its project): every block (id, type, name in Mia\'s language, title, position/size, all settings, inputs with what is wired into them, outputs with their concrete type, computation state, whether its result is out of date, and its current result with ABSOLUTE file paths), the wires and the sections. A Model block also has model {family, does, workflow, otherWays, uses (wired inputs it uses), connect (inputs still needed), ignored (wired but unused), trial, startFrom (nothing wired yet: the ports it can start from, each with what it would then do)}. Use it to find ids and check your work.',
    inputSchema: { type: 'object', properties: { boardId: boardIdProp('Optional: open this board (p_…) first'), projectId: projectIdAlias }, additionalProperties: false }
  },
  {
    name: 'mia_add_block', method: 'add_block', annotations: { title: 'Mia: add a block', ...EDIT },
    description: 'Place a new block on the board (it fades in; the cursor shows where). Placement: to the right of "near" (use the block that will feed it), or at "at", or else beside your last block — never on top of another block. "params" are checked against the catalog (allowed values, ranges, model ids or names). Returns the new block id and its ports. Use mia_import_media, not this, to bring files in. A model by name (MiniMax, LTX, Seedance…) = type "gen" with params.model (e.g. {"model":"fam:minimax"}): its ports are then those of the model.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Block type id (or its name in Mia\'s language)', ...(TYPE_IDS.length ? { enum: TYPE_IDS } : {}) },
        params: { type: 'object', description: 'Settings {id: value}, values from mia_catalog', additionalProperties: true },
        title: { type: 'string', description: 'Optional title shown on the block (in Mia\'s language), e.g. « Profondeur du plan 12 »' },
        near: { type: 'string', description: 'Block id to place it next to (to its right)' },
        at: point
      },
      required: ['type'],
      additionalProperties: false
    }
  },
  {
    name: 'mia_connect', method: 'connect', annotations: { title: 'Mia: wire two blocks', ...EDIT },
    description: 'Wire an output of one block into an input of another (the cursor draws it). Ports may be omitted: the first compatible output/input is picked (a required empty input first) — on a Model block, name the input port (start, end, keys, refs, refVideos, refAudios, video, audio, guide…): the port chooses what the block does. Every input of a Model block\'s model can be wired, even one the UI keeps behind « Partir de » or « + Ajouter »; without a port, its model\'s main input comes first while it has room, then an input that works on its own. A single input that is already wired is replaced; a multi input adds the wire (numbered by the vertical order of the sources). Errors list the compatible ports.',
    inputSchema: { type: 'object', properties: { from: nodeRef, to: nodeRef }, required: ['from', 'to'], additionalProperties: false }
  },
  {
    name: 'mia_set_params', method: 'set_params', annotations: { title: 'Mia: change settings', ...EDIT, idempotentHint: true },
    description: 'Change settings of a block in one undoable step. Values are validated against the catalog: select/seg take one of the listed values, sliders a number in range, model settings "auto", "none" (when allowed) or a model id/name from mia_catalog, prompts free text (LTX prompts work best in English; the user\'s own text may be in another language).',
    inputSchema: {
      type: 'object',
      properties: { nodeId: { type: 'string' }, params: { type: 'object', additionalProperties: true, description: '{settingId: value}' } },
      required: ['nodeId', 'params'],
      additionalProperties: false
    }
  },
  {
    name: 'mia_rename_block', method: 'rename_block', annotations: { title: 'Mia: rename a block', ...EDIT, idempotentHint: true },
    description: 'Give a block a title (in Mia\'s language, short). Empty title = back to its type name.',
    inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, title: { type: 'string' } }, required: ['nodeId', 'title'], additionalProperties: false }
  },
  {
    name: 'mia_remove_blocks', method: 'remove_blocks', annotations: { title: 'Mia: remove blocks', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: 'Remove blocks (and their wires) from the board. No file is deleted on disk and Ctrl+Z brings them back. Only remove blocks you created, unless the user asks.',
    inputSchema: { type: 'object', properties: { nodeIds: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['nodeIds'], additionalProperties: false }
  },
  {
    name: 'mia_import_media', method: 'import_media', annotations: { title: 'Mia: import files', ...EDIT },
    description: 'Import images or videos from the PC (ABSOLUTE Windows paths, e.g. "D:\\\\Renders\\\\plan12.mp4"). Each file is copied into the open board (its media folder) and becomes a Média block (type import). "into" fills an existing Média block that waits for a file (from a recipe); "near" places the new block to the right of a block. Returns the new block ids, kinds and sizes.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Absolute file paths' },
        into: { type: 'string', description: 'Optional: id of an empty Média block to fill' },
        near: { type: 'string', description: 'Optional: block id to place the media next to' }
      },
      required: ['paths'],
      additionalProperties: false
    }
  },
  {
    name: 'mia_insert_recipe', method: 'insert_recipe', annotations: { title: 'Mia: insert a recipe', ...EDIT },
    description: `Place a ready-made chain of blocks on the open board (beside what is there). Returns each block's recipe key and new id; empty Média blocks report what they wait for. Recipes: ${RECIPE_LINE || '(see mia_catalog)'}.`,
    inputSchema: { type: 'object', properties: { recipe: { type: 'string', ...(RECIPES.length ? { enum: RECIPES.map((r) => r.id) } : {}) }, at: { ...point, description: 'Optional centre of the recipe (world coordinates)' } }, required: ['recipe'], additionalProperties: false }
  },
  {
    name: 'mia_arrange', method: 'arrange', annotations: { title: 'Mia: tidy the board', ...EDIT },
    description: 'Tidy the board left → right following the wires (sources on the left, results on the right), then frame everything. One undoable step.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'mia_run', method: 'run', annotations: { title: 'Mia: run a block', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Compute a block (and whatever upstream is out of date), exactly like the user\'s Run button: same queue, same GPU lock. Generation blocks have two modes: "preview" (fast, low resolution — the default; do this first) and "final". Returns a jobId (and boardId; projectId is the same id under its old, deprecated name): then call mia_wait. If something is missing (an input not wired, a model not installed) the error says what to do.',
    inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, mode: { type: 'string', enum: ['preview', 'final'] }, boardId: boardIdProp('Optional: the board (p_…) of that block, opened first'), projectId: projectIdAlias }, required: ['nodeId'], additionalProperties: false }
  },
  {
    name: 'mia_wait', method: 'wait', annotations: { title: 'Mia: wait for a job', ...RO, idempotentHint: false },
    description: 'Wait until a job ends (by jobId, or the latest job of a block by nodeId), up to timeoutS seconds (default 120, max 600). Returns the final state (done / error / cancelled) with the result files (absolute paths), or timedOut:true with the progress — call it again to keep waiting.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' }, nodeId: { type: 'string' }, boardId: boardIdProp('Optional, with nodeId: the board (p_…) of that block'), projectId: projectIdAlias, timeoutS: { type: 'number', minimum: 1, maximum: 600 } },
      additionalProperties: false
    }
  },
  {
    name: 'mia_jobs', method: 'jobs', annotations: { title: 'Mia: job queue', ...RO },
    description: 'The job queue (running, waiting, recently finished): block, board (boardId; projectId is the same id under its old, deprecated name), state, progress, ETA, and who holds the GPU if it waits.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'mia_cancel', method: 'cancel', annotations: { title: 'Mia: cancel a job', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Cancel a queued or running job (and the upstream jobs it alone needed).',
    inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'], additionalProperties: false }
  },
  {
    name: 'mia_get_output', method: 'get_output', annotations: { title: 'Mia: result files', ...RO },
    description: 'The current result of a block (pinned version, else the latest final, else the latest preview): absolute file paths, kind, size, fps, frames, duration, poster image. For a Média block: its file. You can open the image files to look at them.',
    inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, port: { type: 'string' } }, required: ['nodeId'], additionalProperties: false }
  },
  {
    name: 'mia_snapshot', method: 'snapshot', annotations: { title: 'Mia: look at the board', ...RO, idempotentHint: false },
    description: 'A PNG screenshot of Mia as the user sees it (whole window), or of one block (nodeId: the view centres on it first). Use it to check the layout and the previews.',
    inputSchema: { type: 'object', properties: { nodeId: { type: 'string' } }, additionalProperties: false }
  },
  {
    name: 'mia_focus', method: 'focus', annotations: { title: 'Mia: show blocks', ...RO, readOnlyHint: false, idempotentHint: true },
    description: 'Move the user\'s view to these blocks (and select them) — to show them something.',
    inputSchema: { type: 'object', properties: { nodeIds: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['nodeIds'], additionalProperties: false }
  },
  {
    name: 'mia_add_section', method: 'add_section', annotations: { title: 'Mia: group blocks in a section', ...RO, readOnlyHint: false, idempotentHint: false },
    description: 'Frame these blocks in a named section (like Slate): a tinted rectangle with a bold title above it, inside the open board. Use it to organise one board (e.g. « Sources », « Essais LTX »); for separate shots prefer one board per shot inside a project (mia_create_project {folder}). Title in Mia\'s language, short.',
    inputSchema: { type: 'object', properties: {
      nodeIds: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Blocks to put inside the section' },
      title: { type: 'string', maxLength: 80 },
      tone: { type: 'string', enum: ['grey', 'teal', 'green', 'yellow', 'orange', 'red', 'pink'], description: 'Optional tint (default: the accent blue)' }
    }, required: ['nodeIds', 'title'], additionalProperties: false }
  },
  {
    name: 'mia_say', method: 'say', annotations: { title: 'Mia: say something', ...RO, readOnlyHint: false, idempotentHint: false },
    description: 'Show a short message in a bubble next to your cursor on the user\'s screen (6 s). Write in Mia\'s language (mia_status → mia.lang), one or two short sentences: what you are doing or what to look at.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 400 } }, required: ['text'], additionalProperties: false }
  }
];
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------- the bridge
let clientName = process.env.MIA_CLIENT_NAME || 'Assistant';
let bridge = null;              // {port, token, pid}
let launched = 0;

function displayName(raw) {
  if (process.env.MIA_CLIENT_NAME) return process.env.MIA_CLIENT_NAME;
  const s = String(raw || '').toLowerCase();
  if (s.includes('claude')) return 'Claude';
  if (s.includes('codex')) return 'Codex';
  if (s.includes('chatgpt') || s.includes('openai')) return 'ChatGPT';
  if (s.includes('cursor')) return 'Cursor';
  if (s.includes('gemini')) return 'Gemini';
  const word = String(raw || '').trim().split(/[\s_\-/]+/)[0] || '';
  return word ? (word[0].toUpperCase() + word.slice(1)).slice(0, 20) : 'Assistant';
}

function readBridge() {
  try {
    const b = JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8'));
    if (b && b.port && b.token) return b;
  } catch { /* missing or partial */ }
  return null;
}

function alive(pid) {
  if (!pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function post(info, method, params, timeoutMs) {
  const body = JSON.stringify({ method, params: params || {}, client: clientName });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: info.port, path: '/call', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${info.token}` }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* below */ }
        if (res.statusCode === 401) { const e = new Error('unauthorized'); e.code = 'EAUTH'; reject(e); return; }
        if (!json) { reject(new Error(`réponse illisible du pont (HTTP ${res.statusCode})`)); return; }
        resolve(json);
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })); });
    req.on('error', reject);
    req.end(body);
  });
}

async function ping(info) {
  try {
    const r = await post(info, 'ping', {}, 2500);
    return r && r.ok ? r.result || {} : null;
  } catch { return null; }
}

function launchMia() {
  const vbs = path.join(MIA_ROOT, 'Mia.vbs');
  if (!fs.existsSync(vbs)) throw new UserError(`Mia est introuvable (${vbs}).`);
  log('launching Mia:', vbs);
  // ce serveur peut tourner sous l'Electron de Mia en mode Node (ELECTRON_RUN_AS_NODE=1) : ne pas transmettre
  // cette variable, sinon Mia démarrerait elle-même comme un simple Node et planterait
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore', windowsHide: true, cwd: MIA_ROOT, env });
  child.on('error', (e) => log('launch failed:', e.message));
  child.unref();
  launched = Date.now();
}

/** The bridge of a running Mia, Mia started if needed. */
async function connect() {
  const info = readBridge();
  if (info && alive(info.pid)) {
    const p = await ping(info);
    if (p) { bridge = info; return info; }
  }
  if (NO_LAUNCH) throw new UserError('Mia n’est pas ouverte (ou son pont ne répond pas). Ouvre Mia puis réessaie.');
  if (!launched || Date.now() - launched > 60000) launchMia();
  const until = Date.now() + LAUNCH_WAIT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 400));
    const b = readBridge();
    if (b && alive(b.pid)) {
      const p = await ping(b);
      if (p) {
        // give the interface a moment to come up: the bridge itself waits for it too
        for (let i = 0; i < 30 && !p.ui; i++) {
          await new Promise((r) => setTimeout(r, 300));
          const q = await ping(b);
          if (q && q.ui) break;
        }
        bridge = b;
        return b;
      }
    }
  }
  throw new UserError('Mia ne répond pas. Si elle est déjà ouverte, ferme-la et relance-la (une version sans pont des assistants tourne peut-être encore).');
}

async function call(method, params, timeoutMs = CALL_TIMEOUT_MS) {
  let info = bridge || await connect();
  try {
    return await post(info, method, params, timeoutMs);
  } catch (e) {
    if (e.code === 'ETIMEOUT') throw new UserError('Mia n’a pas répondu à temps.');
    // Mia restarted (new port/token) or closed: reconnect once
    bridge = null;
    info = await connect();
    try {
      return await post(info, method, params, timeoutMs);
    } catch (e2) {
      if (e2.code === 'ETIMEOUT') throw new UserError('Mia n’a pas répondu à temps.');
      throw new UserError(`Le pont de Mia ne répond pas : ${e2.message}`);
    }
  }
}

// ---------------------------------------------------------------- tools/call
const textContent = (obj) => [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }];

async function callTool(name, args) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return { content: textContent(`Outil inconnu : « ${name} ». Outils : ${TOOLS.map((t) => t.name).join(', ')}.`), isError: true };
  const params = args && typeof args === 'object' ? { ...args } : {};
  // deprecated alias: projectId (a board id before SPEC §18) still works as boardId
  if (params.projectId != null && params.boardId == null) params.boardId = params.projectId;
  let timeout = CALL_TIMEOUT_MS;
  if (tool.method === 'wait') timeout = (Math.max(1, Math.min(600, Number(params.timeoutS) || 120)) + 30) * 1000;
  if (tool.method === 'import_media') timeout = 150000;
  try {
    const res = await call(tool.method, params, timeout);
    if (!res || res.ok === false) return { content: textContent((res && res.error) || 'Erreur inconnue dans Mia.'), isError: true };
    const result = res.result;
    if (tool.method === 'snapshot' && result && result.image && result.image.data) {
      const { image, ...rest } = result;
      return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType || 'image/png' }, ...textContent(rest)] };
    }
    return { content: textContent(result === undefined ? null : result) };
  } catch (e) {
    const msg = e instanceof UserError ? e.message : `Erreur du serveur MCP de Mia : ${e && e.message ? e.message : e}`;
    if (!(e instanceof UserError)) log(name, 'failed:', e && e.stack ? e.stack : e);
    return { content: textContent(msg), isError: true };
  }
}

// ---------------------------------------------------------------- JSON-RPC over stdio
function send(msg) {
  try { process.stdout.write(`${JSON.stringify(msg)}\n`); } catch (e) { log('write failed:', e.message); }
}
const result = (id, r) => send({ jsonrpc: '2.0', id, result: r });
const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function onMessage(msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    if (msg && msg.id !== undefined) error(msg.id, -32600, 'Invalid Request');
    return;
  }
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  if (!method) return;                        // a response to us: we never send requests
  switch (method) {
    case 'initialize': {
      const ci = params && params.clientInfo;
      clientName = displayName(ci && (ci.title || ci.name));
      log('client:', ci ? `${ci.name} ${ci.version || ''}` : '?', '→', clientName);
      result(id, {
        protocolVersion: (params && typeof params.protocolVersion === 'string' && params.protocolVersion) || DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'mia', title: 'Mia', version: SERVER_VERSION },
        instructions: INSTRUCTIONS
      });
      return;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/roots/list_changed':
      return;
    case 'ping':
      if (isRequest) result(id, {});
      return;
    case 'tools/list':
      if (isRequest) {
        result(id, {
          tools: TOOLS.map((t) => ({ name: t.name, title: t.annotations && t.annotations.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }))
        });
      }
      return;
    case 'tools/call': {
      if (!isRequest) return;
      const name = params && params.name;
      const r = await callTool(name, params && params.arguments);
      result(id, r);
      return;
    }
    case 'resources/list': if (isRequest) result(id, { resources: [] }); return;
    case 'resources/templates/list': if (isRequest) result(id, { resourceTemplates: [] }); return;
    case 'prompts/list': if (isRequest) result(id, { prompts: [] }); return;
    default:
      if (isRequest) error(id, -32601, `Method not found: ${method}`);
  }
}

let inflight = 0;
let ended = false;
const maybeExit = () => { if (ended && inflight === 0) process.exit(0); };

function start() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '').trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { error(null, -32700, 'Parse error'); continue; }
      const list = Array.isArray(msg) ? msg : [msg];
      for (const m of list) {
        inflight++;
        onMessage(m)
          .catch((e) => { log('handler failed:', e && e.stack ? e.stack : e); if (m && m.id != null) error(m.id, -32603, 'Internal error'); })
          .finally(() => { inflight--; maybeExit(); });
      }
    }
  });
  // the client closed our stdin: finish what is in flight, then leave
  process.stdin.on('end', () => { ended = true; maybeExit(); });
  process.on('uncaughtException', (e) => log('uncaught:', e && e.stack ? e.stack : e));
  process.on('unhandledRejection', (e) => log('unhandled:', e && e.stack ? e.stack : e));
  log(`ready (bridge file: ${BRIDGE_FILE})`);
}

if (require.main === module) start();

module.exports = { TOOLS, displayName, callTool, onMessage };
