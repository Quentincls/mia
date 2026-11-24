#!/usr/bin/env node
'use strict';
/**
 * Mia — MCP server (stdio, zero dependency) for assistants: Claude (Claude Code, Claude app) and Codex.
 *
 * JSON-RPC 2.0, one JSON message per line on stdin/stdout (logs go to stderr only). It forwards every tool
 * call to Mia's local bridge (electron/bridge.js) whose port and token are in
 *   %TEMP%\Mia\bridge.json, then %APPDATA%\Mia\data\bridge.json   (MIA_BRIDGE_FILE overrides them — tests)
 * and starts Mia (wscript.exe Mia.vbs) when it is not running, waiting up to 25 s.
 *
 * Environment:
 *   MIA_BRIDGE_FILE=<path>   bridge.json to read (tests use their own Mia profile)
 *   MIA_BRIDGE_MIRROR=<path> the %TEMP%\Mia\bridge.json copy to read first (tests of that copy)
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
// Mia's copy in %TEMP% first: under an assistant installed from the Store (MSIX), %APPDATA% is seen through
// a private copy where a stale bridge.json can hide the real one; %TEMP% is not redirected (bridge.js)
const BRIDGE_FILES = process.env.MIA_BRIDGE_FILE && !process.env.MIA_BRIDGE_MIRROR
  ? [BRIDGE_FILE]
  : [process.env.MIA_BRIDGE_MIRROR || path.join(os.tmpdir(), 'Mia', 'bridge.json'), BRIDGE_FILE];
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
  'GO-AHEAD FIRST: before anything that changes Mia (creating or opening a board, importing, placing, wiring, setting, running), call mia_request {title, summary, steps, runs} and wait for state "accepted": the user sees a card « Claude attend ton feu vert » in Mia and clicks « C\'est parti ». Reading (mia_status, mia_catalog, mia_list_projects, mia_get_board) and mia_say need no go-ahead: read first, so that your request says exactly what you will do. Then your computations (mia_run) are only PROPOSED: they land in the user\'s « À générer » list, where they tick what they want; say so instead of announcing results. If the user paused the assistants (mia_pending → paused), wait. TWO MODES, chosen by the user with a switch at the bottom left of the board (« Je valide · Auto », the same as Settings → « Demander mon feu vert »): « Je valide » (mode "ask", the default) is what is described above; « Auto » (mode "auto") means they may be away from the PC: mia_request answers accepted at once (mode:"auto"), and everything you start starts at once — heavy jobs of this PC, paid online ones (Higgsfield credits) and mia_train_start included — with no card and no « À générer » list. mia_request and mia_pending always say the mode. The user may switch at any time: back to « Je valide », your next action that changes Mia needs mia_request again (nothing already started is cancelled); to « Auto » while your card waits, the request is accepted. Even in « Auto », spend credits only on what the user asked for, and « Pause » still holds you.',
  'Typical flow: mia_status → mia_list_projects (the user\'s projects and their boards) → mia_catalog (once; it lists every block type, its ports, settings with allowed values, installed models and LoRAs) → a new board: mia_create_project {folder:"<project>", name:"<board>"} (the project is created when it does not exist yet), or an existing board: mia_open_project {name:"<project> / <board>"} → mia_import_media with ABSOLUTE Windows paths → mia_add_block with near=<the block that feeds it> → mia_connect → mia_set_params with values taken from the catalog → mia_run (it runs the block\'s settings as they are, like the user\'s single « Générer » button; mode "preview" is an optional quick low-resolution draft) → mia_wait → mia_get_output / mia_snapshot to look at the result → mia_say to tell the user what you did.',
  'Organising work: one project per film or subject, one board per shot or idea inside it (project « Mon film » → boards « Plan 01 », « Plan 02 »…); inside one board, mia_add_section frames related blocks. When the user names a project, put the new boards in it (folder). Never move, rename or empty the user\'s boards unless asked.',
  'A TIDY BOARD: blocks must never cover each other. A block GROWS after you place it (its image or video arrives, the strip of versions, settings shown), so blocks you placed close together while empty can end up on top of each other. After results arrive, read mia_get_board: overlaps lists the blocks that cover each other now (with their real x, y, w, h). Tidy them: mia_arrange {nodeIds or sectionId, layout:"grid", columns} for variants side by side (e.g. 6 emotions → 3 columns), layout "flow" (the default) for chains that follow wires; or mia_move_blocks for a precise place (it refuses a place that would cover another block). Arrange only YOUR blocks or a section, not the whole board, unless the user asks. A section follows its blocks (mia_arrange {sectionId} fits the section around them).',
  'WORKING IN PARALLEL: the user can ask for several shots or images at once and likes to see several of you on the board. Calls of one assistant run one after another, so real parallel work needs one subagent per shot (or per chain of blocks), all on the SAME open board; each subagent passes its own "as" (1, 2, 3… or a short name such as "Plan 02") on every tool that takes it. Mia then shows one coloured cursor per worker (« Claude 1 », « Claude 2 »…), each with its own bubble; the first block of each worker opens a row of its own under what is there, and its next blocks follow its own chain (still pass near). The user picks in the title bar which worker the camera follows. Prepare in parallel, but local GPU jobs still run one at a time (online jobs run together): launch every mia_run, then wait. Do not open or create another board while others work (it would change the board under them): create the board first, alone, then start the workers. Without "as" nothing changes: one cursor, as before.',
  'Heavy GPU jobs go through the same queue and GPU lock as the user\'s own clicks (one at a time; during a LoRA training, see TRAINING A LoRA); a job may wait for the GPU. Never delete blocks you did not create unless asked.',
  'Ports: image→image|media, video→video|media, text→text, audio→audio (import a wav/mp3/m4a/flac with mia_import_media, wire it into the Son block, or into a Model block\'s sound inputs: MiniMax reference sounds, a sound to follow). Settings marked "overriddenByInput" are replaced by a wired text block (Consigne).',
  'MODEL BLOCK (type "gen", « Modèle »): when the user names a model (LTX, MiniMax, Wan, Qwen, Seedance, Kling…), add ONE gen block with params.model = its family (mia_catalog → types[gen].params[model].choices: fam:ltx, fam:minimax, fam:wan, fam:qwen, fam:klein, fam:qwen21, or hf:… online). Its inputs are its model\'s; what you wire picks what it does (choices[].ways: needs, takes, settings) — read types[gen].howItWorks once. mia_get_board shows each Model block\'s model.does, model.uses (wired inputs it uses), model.connect (what is missing), model.ignored, model.trial and, while nothing is wired, model.startFrom (the inputs it can start from — the « Partir de : » buttons of the screen; wire the port, no click needed). An ONLINE family (hf:…) shows its mode on screen: params.workflow = a way id forces that mode (it then says what it lacks and ignores the rest), "auto" lets the wires decide; its settings, bounds and tiers are per mode (choices[].ways[].settings), with the provider\'s notes, prompt tokens (cite: Kling 4.0 @image_1, @video_1…) and a public price. The task blocks (i2v « Animer une image », ref2v…) and recipes still exist and stay fine for their one job.',
  'Local model abilities (this PC): LTX 2.5 — from text, animate a start image (+ end image, + up to 4 keyframes in between, + a character sheet), guided video and 3D render → photoreal (both take the start image as their look), video from a character sheet alone (one image with the cast/props side by side; trial). Setting passes (auto | 1 | 2): 2 passes = motion decided at half resolution, latent enlarged ×2 then refined, end image and keyframes advised (0.7 / 0.6) instead of imposed; auto = 2 passes when an end image or keyframes are wired, else 1 (text and 3D render → photoreal: auto = 1; guided video and previews: always 1). LTX does NOT blend several separate references: use MiniMax for that. MiniMax H3 — from text, animate (start/end, keyframes, a sound to follow), references (up to 9 images, 3 videos, 3 sounds, named « Image n », « Vidéo n », « Son n » in the prompt), guided video, extend a video (the result is the whole video made longer), up to 15 s, 768p. Wan Animate 2 — a character + a motion video (settings motionFidelity, likeness). Qwen Image Edit — edit an image with up to 2 helper images. FLUX.2 Klein 9B (fam:klein) — an image from text in seconds (format, resolution 1K/1.5K), or wire an image to edit it keeping its framing. Qwen-Image 2.1 Turbo (fam:qwen21) — an image from text, very good at text written in the image (up to 2K); wire an image into its « layout » input (Cadrage) to keep the composition of that image through its depth while the LoRA keeps its style (setting layoutFollow strict / balanced / loose; with a layout wired, format is ignored: the result takes the shape of the layout image). Retouch a zone (Qwen-Image 2.1): wire the image into « image » and a Mask block (type mask, its « image » input = the same image) into « mask »; the user paints the zone with the « Dessiner la zone » button of the Mask block (you cannot paint: ask the user, or set params.drawing to the absolute path of a black and white PNG you made, white = the zone; mode change or protect, feather in px). Only the zone is remade (zoneStrength 0.3 to 1, default 0.7: how much it changes) and pasted back, the rest of the image stays identical to the pixel; a small zone (under 300 px) is zoomed on automatically. Recipe retouch-zone. A LoRA may come with advice and a suggested strength (mia_catalog → types[gen].params[lora].choices[].advice / .strength): follow them. Both: non-commercial licenses (trials, personal projects), new (trial); a LoRA is offered only on the model it was trained for. Keyframes: keep the start image\'s framing, a keyframe framed differently makes the shot cut. Features marked trial are new: tell the user to judge them by eye.',
  'TRAINING A LoRA: mia_train_options → mia_request {training:true} → mia_train_prepare (absolute paths, one caption per image; write the captions yourself if they are missing: describe the scene, never the fixed features of the character; do NOT put the trigger word in captions, Mia adds it) → mia_train_start only PROPOSES in « Je valide » (mode "ask"): the user starts it in Mia, and any later change to the draft cancels the proposal. In « Auto » (mode "auto") it starts at once: start a training only when the user asked for one. Resuming also goes through mia_train_start {resume:true}. It lasts hours: do not hold the conversation open, come back with mia_train_status or one mia_train_wait at a time; samples are files you can open, look at them before concluding. One training at a time; it holds the GPU. While it trains, ONE local job at a time may run alongside it when the memory measured now allows it (Settings → Training, « Générer pendant un entraînement », on by default): the training slows down a little meanwhile, mia_jobs / mia_wait say besideTraining. Otherwise local jobs wait (waitsForTraining:true, message says why, with the memory figures when memory is what is missing) and start by themselves, or the user lets them through. Only an image whose memory peak was measured goes alongside (Qwen-Image 2.1 up to 2K, FLUX.2 Klein at 1K); a video, an upscale or any other model always waits for the end of the training.'
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

// Several of you at once (subagents working in parallel): « as » names who makes the call. Mia shows one
// coloured cursor per « as », each with its own queue of actions, bubble and place on the board (SPEC §13.5).
const asProp = { type: ['integer', 'string'], description: 'Optional. Who makes this call when several of you work at once: a number (2 → cursor « Claude 2 ») or a few words ("Plan 02" → « Claude · Plan 02 »). Keep the same value for all the calls of one worker. Each « as » has its own coloured cursor and its own queue: workers act at the same time. Omit it when you work alone.' };
const AS_METHODS = new Set(['create_project', 'open_project', 'add_block', 'connect', 'set_params', 'rename_block', 'remove_blocks', 'import_media', 'insert_recipe', 'arrange', 'move_blocks', 'run', 'focus', 'add_section', 'say']);

const TOOLS = [
  {
    name: 'mia_status', method: 'status', annotations: { title: 'Mia: status', ...RO },
    description: 'Is Mia open, the language of its interface (mia.lang: write to the user in it), which view is shown (home page or a board), which board is open (id, name) and in which project (folder), how many blocks, which blocks the user has selected (mia.selection), every board open in a tab (mia.tabs: id, name, folder, active = the one on screen), the ComfyUI engine state, the GPU (VRAM, who holds it) and the job queue (engine.queue: running/waiting overall, local {running, waiting} and online {running, waiting, atHiggsfield, max} apart: online jobs run in parallel, up to the « Calculs en ligne simultanés » setting, and never wait for the GPU), and which capabilities (image-to-video, depth, cutout…) have a model installed, and training: the LoRA training that is active (trainingId, name, state, step, steps, progress, endAt) or null — while one runs, local generations wait behind it. Call it first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'mia_request', method: 'request', annotations: { title: 'Mia: ask the user\'s go-ahead', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'ALWAYS call this before changing anything in Mia, once per thing the user asked: it shows a small card in Mia — « Claude attend ton feu vert » — with what you are about to do, and nothing moves until the user clicks « C\'est parti ». Until then every tool that changes the board answers that the go-ahead is missing. title = the request in a few words, in Mia\'s language (« Préparer 3 plans LTX et Seedance »); summary = one plain sentence (how many files, blocks, wires); steps = optional short lines the user reads under « Détail »; runs = how many computations you will propose (0 = none). It waits up to 40 s: state "accepted" (act now), "declined" (do not act), or "pending" (not answered yet: tell the user you are waiting in Mia, then call it again with requestId to keep waiting). A go-ahead lasts while you keep working (10 minutes without a call ends it); a new request from the user needs a new mia_request. In mode « Auto » (switch at the bottom left of the board, mode:"auto" in the answer) it answers accepted at once, and if the user switches to it while your card waits, the card is accepted; the answer always says the mode ("ask" or "auto"). training:true when what you are about to prepare is a LoRA training: the card then says « Il prépare un entraînement de LoRA. Tu le lanceras toi-même ensuite. » (the start itself is a second click of the user, on the card of mia_train_start).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 90, description: 'What you are about to do, a few words, in Mia\'s language' },
        summary: { type: 'string', maxLength: 220, description: 'One plain sentence: files to import, blocks to place, what gets wired' },
        steps: { type: 'array', items: { type: 'string' }, maxItems: 12, description: 'Optional short lines shown under « Détail »' },
        runs: { type: 'integer', minimum: 0, description: 'How many computations you will propose in « À générer » (0 = none)' },
        requestId: { type: 'string', description: 'To keep waiting for a request already shown' },
        training: { type: 'boolean', description: 'true when you are about to prepare a LoRA training (mia_train_prepare, mia_train_start)' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'mia_pending', method: 'pending', annotations: { title: 'Mia: go-ahead and « À générer »', ...RO },
    description: 'Where things stand with the user: mode ("ask" = « Je valide », the go-ahead is asked; "auto" = « Auto », you act and your computations start at once, paid online ones included — the user chooses it with the switch at the bottom left of the board), enabled (is the go-ahead asked: mode "ask"), request {requestId, state}, granted (may you act now: always true in mode "auto"), paused (the user clicked « Pause »: wait, in both modes), and toGenerate: every computation you proposed with mia_run — state "waiting" (in the user\'s « À générer » list, ticked or not), "launched" (jobId: follow it with mia_wait) or "removed" (the user took it off the list: do not propose it again unless asked). In mode "auto", lines still "waiting" were proposed before the switch: they stay in the list until the user ticks them, or until you run them again with mia_run (they then start at once and their line becomes "launched"); note says so. training: what became of the LoRA training you proposed with mia_train_start — {trainingId, state: "waiting" (the card waits for the user\'s click), "started" (they clicked: follow it with mia_train_status), "declined" (do not propose it again unless asked) or "changed" (the draft changed since: the proposal is cancelled, call mia_train_start again)}, or null.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'mia_catalog', method: 'catalog', annotations: { title: 'Mia: block catalog', ...RO },
    description: `Everything you need to build a board: every block type with its input/output ports (type, required, multi/max), its settings (kind, default, allowed values or range, model choices with ids), the recipes, the models available per capability and the LoRAs. Call it once before building; pass "type" to get one block only. A model choice may carry version (Compact, Full) and memoryGB (estimated peak memory on this machine); leave "auto" or fam:<key> to let Mia choose by this machine’s memory. Models listed under notOffered are recognised but cannot be chosen or run (their recipe is not validated in Mia).\nBlock types (id « name in the French UI » — in/out ports, ! = required; mia_catalog gives the names in Mia\'s language):\n${TYPE_LINES}`,
    inputSchema: { type: 'object', properties: { type: { type: 'string', description: 'Optional: only this block type', ...(TYPE_IDS.length ? { enum: TYPE_IDS } : {}) } }, additionalProperties: false }
  },
  {
    name: 'mia_list_projects', method: 'list_projects', annotations: { title: 'Mia: projects and boards', ...RO },
    description: 'The user\'s projects and boards. Returns { folders: [{id "f_…", name, color, boards: how many boards it holds}] — the PROJECTS (folders of boards) —, boards: [{id "p_…", name, folderId, folder: the name of its project, blocks, dir, updated, opened}] — every BOARD, folderId null when it is outside any project; open:true = open in a tab right now, active:true = the one on screen }. Open a board with mia_open_project (its id, or "<project> / <board>").',
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
    description: 'The open board (id, name, its project): every block (id, type, name in Mia\'s language, title, position/size, its settings, inputs with what is wired into them, outputs with their concrete type, computation state, whether its result is out of date, and its current result with ABSOLUTE file paths), the wires and the sections, plus what the user is looking at: selection (the blocks they selected: « this block » usually means those), inView (ids of the blocks on screen now) and tabs (the other boards open). A Model block also has model {family, does, workflow, otherWays, uses (wired inputs it uses), connect (inputs still needed), ignored (wired but unused), trial, startFrom (nothing wired yet: the ports it can start from, each with what it would then do)}; an online one adds mode (chosen or auto), modes (each way and what it lacks), accepts (inputs of the current mode at its tier), tier, price (public rate: min/max per second, run or image), cite (prompt tokens), unsupported, and its params are those of the current mode with their defaults (hf.*). Use it to find ids and check your work.',
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
    description: 'Wire an output of one block into an input of another (the cursor draws it). Ports may be omitted: the first compatible output/input is picked (a required empty input first) — on a Model block, name the input port (start, end, keys, refs, refVideos, refAudios, video, audio, guide…): the port chooses what the block does. Every input of a Model block\'s model can be wired, even one the UI keeps behind « Partir de » or « + Ajouter »; without a port, its model\'s main input comes first while it has room, then an input that works on its own. When the block\'s current mode does not use that input, the answer says ignored:true with a note (and, online, the mode that uses it: set params.workflow). A single input that is already wired is replaced only when you named it in to.port (a guessed port never replaces a wire: the answer then asks you to name it); a multi input adds the wire (numbered by the vertical order of the sources). Errors list the compatible ports.',
    inputSchema: { type: 'object', properties: { from: nodeRef, to: nodeRef }, required: ['from', 'to'], additionalProperties: false }
  },
  {
    name: 'mia_set_params', method: 'set_params', annotations: { title: 'Mia: change settings', ...EDIT, idempotentHint: true },
    description: 'Change settings of a block in one undoable step. Values are validated against the catalog: select/seg take one of the listed values (or their label), sliders a number in range, model settings "auto", "none" (when allowed) or a model id/name from mia_catalog, prompts free text (LTX prompts work best in English; the user\'s own text may be in another language). An online Model block checks hf.* against its CURRENT mode and tier (params.workflow in the same call counts; "auto" goes back to the wires): a value only another mode allows is kept with a note, a setting of another tier is kept with a note. The answer lists the settings the block shows now, notes, and model (what it does now).',
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
    description: 'Tidy blocks so that none covers another, gliding, one undoable step; then frames them. Without nodeIds or sectionId: the whole board, left → right following the wires (sources on the left, results on the right). nodeIds: only these blocks (tidied from their top-left corner; if that would cover another block, the group slides to the nearest free place). sectionId: the blocks of that section, and the section is fitted around them. layout "flow" (default) follows the wires; "grid" puts them in rows, columns per row (default ≈ the square root of their number), in the order of nodeIds when given, else in reading order — right for variants side by side (emotions, seeds, models). Each column is as wide as its widest block and each row as tall as its tallest, at their real size. Returns each block\'s new x, y, w, h and the overlaps left on the board.',
    inputSchema: { type: 'object', properties: {
      boardId: boardIdProp('Optional: open this board (p_…) first'), projectId: projectIdAlias,
      nodeIds: { type: 'array', items: { type: 'string' }, description: 'Only these blocks (in this order for "grid")' },
      sectionId: { type: 'string', description: 'The blocks of this section (g_… from mia_get_board → sections); the section is fitted around them' },
      layout: { type: 'string', enum: ['flow', 'grid'], description: '"flow" (default): left → right following the wires; "grid": rows of columns' },
      columns: { type: 'integer', minimum: 1, maximum: 12, description: 'Blocks per row for "grid"' },
    }, additionalProperties: false }
  },
  {
    name: 'mia_move_blocks', method: 'move_blocks', annotations: { title: 'Mia: move blocks', ...EDIT },
    description: 'Move blocks to a precise place (they glide; one undoable step). moves: [{nodeId, x, y}] with x, y the top-left corner in board coordinates (as mia_get_board gives them); or nodeIds with dx / dy to shift them together. Nothing moves if a block would cover another one (moved or not, at their real height): the error names both; keep a gap of 48. A section grows to wrap a block moved into it. Returns each block\'s new x, y, w, h and the overlaps left on the board.',
    inputSchema: { type: 'object', properties: {
      boardId: boardIdProp('Optional: open this board (p_…) first'), projectId: projectIdAlias,
      moves: { type: 'array', minItems: 1, items: { type: 'object', properties: { nodeId: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['nodeId', 'x', 'y'], additionalProperties: false }, description: 'Where each block goes (top-left corner)' },
      nodeIds: { type: 'array', items: { type: 'string' }, description: 'Blocks to shift together by dx / dy (instead of moves)' },
      dx: { type: 'number' }, dy: { type: 'number' }
    }, additionalProperties: false }
  },
  {
    name: 'mia_run', method: 'run', annotations: { title: 'Mia: run a block', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Compute a block (and whatever upstream is out of date), exactly like the user\'s « Générer » button: same queue, same GPU lock. During a LoRA training a local job behaves the same as the button: an image whose memory peak was measured runs alongside the training when the memory allows it (one at a time; mia_jobs → besideTraining), else it waits behind it with the reason in its message (waitsForTraining; a video always waits for the end) — do not run it again. WITH THE GO-AHEAD ON (the default), a heavy or paid computation is NOT started by you: it is added to the user\'s « À générer » list (answer awaitingUser:true, pendingId) where they tick what they want and start it themselves; online ones arrive unticked. Do not run it again and do not wait for it: mia_pending tells what became of it (jobId once started). Light jobs of the PC (extract a frame, trim, resize…) still start at once. In mode « Auto » (mia_pending → mode "auto") every computation starts at once and returns its jobId, heavy and paid online ones included. Every block has a single « Générer » button on screen: it runs the block\'s settings as they are (mode "final", the default); the settings (resolution, length, steps) decide how long it takes, and the time expected on this PC shows next to the button. Generation blocks also accept mode "preview": a quick low-resolution, shorter draft, worth it before a long local video when the user wants to check the motion first. An ONLINE Model block (hf:…) shows its price next to « Générer »: run it only when the user asked (credits). Returns a jobId (and boardId; projectId is the same id under its old, deprecated name): then call mia_wait. If something is missing (an input not wired, a model not installed) the error says what to do. variants (2 to 8, a Model block making images on this PC: Qwen-Image 2.1, FLUX.2 Klein, Qwen Image Edit) = the « 4 variantes » button: that many runs with random seeds, one after another, each a version of the block (jobIds, seeds; the user stars the one to keep). On a Prompt block (type text) whose « Réécrire en anglais » is ticked (params.rewrite true), it only rewrites its text: mia_get_output then gives rewritten.',
    inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, mode: { type: 'string', enum: ['preview', 'final'] }, variants: { type: 'integer', minimum: 2, maximum: 8 }, boardId: boardIdProp('Optional: the board (p_…) of that block, opened first'), projectId: projectIdAlias }, required: ['nodeId'], additionalProperties: false }
  },
  {
    name: 'mia_wait', method: 'wait', annotations: { title: 'Mia: wait for a job', ...RO, idempotentHint: false },
    description: 'Wait until a job ends (by jobId, or the latest job of a block by nodeId), up to timeoutS seconds (default 120, max 600). Returns the final state (done / error / cancelled) with the result files (absolute paths), or timedOut:true with the progress — call it again to keep waiting. besideTraining = the name of the LoRA training the job ran (or runs) alongside; waitsForTraining:true = it is held behind a LoRA training (message says why, with the memory figures when memory is what is missing): it starts by itself when the memory allows it or at the end of the training, do not run it again.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' }, nodeId: { type: 'string' }, boardId: boardIdProp('Optional, with nodeId: the board (p_…) of that block'), projectId: projectIdAlias, timeoutS: { type: 'number', minimum: 1, maximum: 600 } },
      additionalProperties: false
    }
  },
  {
    name: 'mia_jobs', method: 'jobs', annotations: { title: 'Mia: job queue', ...RO },
    description: 'The job queue (running, waiting, recently finished): block, board (boardId; projectId is the same id under its old, deprecated name), state, progress, ETA, and who holds the GPU if it waits. Online jobs carry online:true and remote (queued | running at Higgsfield, full = the Higgsfield queue is full and Mia retries by itself, same Idempotency-Key: never charged twice). During a LoRA training: besideTraining (its name) = this local job runs alongside the training (one at a time, when the memory allows it); waitsForTraining:true = it waits behind the training and message says why (« Attend de la place à côté de l’entraînement « Plumo » : il faut ≈ 29 Go, 40 sont libres moins 16 de marge » when memory is what is missing — it starts by itself once the memory measured again allows it; « Attend le calcul en cours à côté de l’entraînement « Plumo » » behind another job alongside; « … une vidéo ne part pas à côté » for a video).',
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
  },
  // ---- training a LoRA (SPEC « Entraîner un LoRA »): reading is free, preparing and acting need the go-ahead,
  // starting and resuming are only ever a proposal the user validates in Mia
  {
    name: 'mia_train_options', method: 'train_options', annotations: { title: 'Mia: LoRA training options', ...RO },
    description: 'What a LoRA can be trained on, on this PC. bases: each trainable model {id (the "base" of mia_train_prepare), label, media: "video" | "image", ready (false = cannot be trained now: why says it, missing lists absent weight files with their size), defaults {rank, lr, batch, saveEvery, sampleEvery, resolutions}, lengths {short, normal, long} in steps (normal is the default), estimate {sPerStep, sampleSec, vramGB, measured: false = never timed on this machine}}; minImages (a set needs at least that many) and advisedImages; kinds (character, place, style) and the sample prompt Mia pre-fills for each; disk {root: the trainings folder, freeGB}; gpu {lock: who holds it, vramUsedGB, vramTotalGB}; active: the training that runs now {trainingId, name, state, step, steps} or null (one at a time). Call it first, before mia_request {training:true}.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'mia_train_prepare', method: 'train_prepare', annotations: { title: 'Mia: prepare a LoRA training', ...EDIT },
    description: 'Create a training draft, or complete one (trainingId): the user sees the « Entraînements » screen fill up, marked « PRÉPARÉ PAR CLAUDE ». Needs the go-ahead (mia_request {training:true}). name, base and trigger are required for a new draft. images = ABSOLUTE paths of png / jpg / jpeg / webp files, or folder = the absolute path of a folder (its own files, not its subfolders); 300 images at most per call. The images are linked, never changed, and a .txt of the same name beside an image is taken as its caption (always copied: the originals are never touched). captions = [{file: the image\'s original file name, text}] writes or replaces captions, marked « ÉCRITE PAR CLAUDE »: one caption per image, describing the scene (pose, framing, light, clothes, place), never the fixed features of the character; do NOT put the trigger word in captions, Mia adds it in front. kind: character (default), place or style. length: short | normal | long (see mia_train_options → lengths), or steps. samplePrompts: up to 4 prompts rendered as samples during the training (default: one, from the kind and the trigger word). advanced {rank, lr, saveEvery, sampleEvery, resolutions}: leave it out unless the user asks. Returns trainingId, state "pret", dataset {count, captioned, missing: images without a caption, small: images under the model\'s size, skipped: files left out and why} — all by original file name —, estimate {seconds, endAt, diskGB, vramGB} (seconds null = never timed on this machine), ready and, when false, why (e.g. « 3 images sans légende »: call it again with trainingId and the missing captions). importing:true = a big import still runs after 120 s: follow it with mia_train_status, then send the captions again. Nothing is started by this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        trainingId: { type: 'string', description: 'To complete an existing draft (t_…) instead of creating one' },
        name: { type: 'string', maxLength: 80, description: 'Name of the LoRA, short (« Rosa »)' },
        base: { type: 'string', description: 'Model id from mia_train_options → bases[].id (e.g. "ltx25")' },
        trigger: { type: 'string', maxLength: 80, description: 'Trigger word: a rare word that will call this LoRA (e.g. "rsa woman")' },
        kind: { type: 'string', enum: ['character', 'place', 'style'], description: 'What the LoRA learns (default: character)' },
        images: { type: 'array', items: { type: 'string' }, maxItems: 300, description: 'Absolute paths of the images' },
        folder: { type: 'string', description: 'Or: the absolute path of a folder of images (and their .txt captions)' },
        captions: {
          type: 'array', maxItems: 300, description: 'Captions to write: [{file: original file name of the image, text}]',
          items: { type: 'object', properties: { file: { type: 'string' }, text: { type: 'string' } }, required: ['file', 'text'], additionalProperties: false }
        },
        length: { type: 'string', enum: ['short', 'normal', 'long'], description: 'How long to train (default: normal)' },
        steps: { type: 'integer', minimum: 1, description: 'Or an exact number of steps' },
        samplePrompts: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Prompts of the samples rendered during the training (with the trigger word)' },
        advanced: {
          type: 'object', description: 'Only when the user asks: {rank, lr, saveEvery, sampleEvery, resolutions}',
          properties: {
            rank: { type: 'integer' }, lr: { type: 'number' }, saveEvery: { type: 'integer' }, sampleEvery: { type: 'integer' },
            resolutions: { type: 'array', description: 'As in mia_train_options → defaults.resolutions' }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'mia_train_start', method: 'train_start', annotations: { title: 'Mia: propose starting a LoRA training', ...EDIT, idempotentHint: true },
    description: 'PROPOSE to start a prepared draft — or, with resume:true, to resume a training that is paused, stopped, interrupted or in error from its last good checkpoint (the only way for you to resume one). Needs the go-ahead. WITH THE GO-AHEAD ON (the default) nothing starts: Mia shows the card « Claude propose un entraînement » [Voir] [Refuser] [Plus tard] [Lancer] and you get awaitingUser:true; the user starts it themselves — tell them so, do not call it again and do not wait for it. mia_pending → training.state tells what follows: waiting, started, declined, or changed (ANY change to the draft after the proposal, by you or by the user, cancels it: call mia_train_start again). In mode « Auto » (mia_pending → mode "auto"): it starts at once (started:true), no card. Errors say why it cannot start: the draft is not ready (the reason is the one of mia_train_prepare → why), or a training is already running (« Un entraînement est déjà en cours : « Lena » (pas 300 / 2 500). »: one at a time).',
    inputSchema: {
      type: 'object',
      properties: { trainingId: { type: 'string' }, resume: { type: 'boolean', description: 'true to propose resuming a paused, stopped, interrupted or failed training' } },
      required: ['trainingId'],
      additionalProperties: false
    }
  },
  {
    name: 'mia_train_status', method: 'train_status', annotations: { title: 'Mia: LoRA training status', ...RO },
    description: 'Where a training stands (without trainingId: the active one, else the latest). state: pret (draft) · attente (waiting for the GPU) · preparation (phase check | encode | load) · entrainement · essai (rendering a sample) · pause (pause: "user" = does not resume by itself, "pass" = lets one job through then resumes, "disk" = disk almost full) · fini · erreur · annule (stopped by the user) · interrompu (Mia closed or crashed). Also step, steps, progress, loss {last, mean100, min, trend: mean of the last 100 steps minus the 100 before; null while no step is measured, never 0} — loss jumps from step to step: watch the trend, and above all the samples —, pace {sPerStep}, eta {seconds, endAt (ms)}, lastNewsS (seconds since the tool last wrote; silent:true = worryingly long), memory {vramGB, peakVramGB, ramFreeGB}, checkpoints [{step, file, sizeMB, at, added: {file, comfyName} once in « Mes LoRA »}], samples [{step, i, file, kind, prompt}] — ABSOLUTE paths: open the image files to look at them —, nextSampleAt, waitingJobs (generations of the user waiting for the GPU behind it), notes (yours and Mia\'s events), error {code, message}, logTail (last 20 lines of the tool), lora {file, comfyName, trigger} once a checkpoint is in « Mes LoRA » (use it in a Model block of the same model), notFiled (finished, but the final LoRA could not be put in « Mes LoRA »: why; mia_train_control add_to_loras tries again), proposal (your proposal: waiting / started / declined / changed), dir. For a draft: dataset, ready, why. Reading shows « CLAUDE REGARDE · IL Y A 2 MIN » on the training screen; it changes nothing.',
    inputSchema: { type: 'object', properties: { trainingId: { type: 'string', description: 'Optional: the active training, else the latest' } }, additionalProperties: false }
  },
  {
    name: 'mia_train_wait', method: 'train_wait', annotations: { title: 'Mia: wait for a LoRA training', ...RO, idempotentHint: false },
    description: 'Wait until something happens in a training, up to timeoutS seconds (default 120, max 600): until "sample" (the next sample file is there: open it), "checkpoint" (the next checkpoint), "end" (finished, stopped, paused, in error or interrupted) or "change" (any change of state or phase, a new sample or checkpoint, your proposal answered). Returns the same fields as mia_train_status plus reached:true — or timedOut:true (call it again later), or ended:true when the training ended before what you were waiting for. A training lasts hours: one call at a time, never a loop that holds the conversation; between two calls let the user work.',
    inputSchema: {
      type: 'object',
      properties: {
        trainingId: { type: 'string', description: 'Optional: the active training, else the latest' },
        until: { type: 'string', enum: ['sample', 'checkpoint', 'end', 'change'] },
        timeoutS: { type: 'number', minimum: 1, maximum: 600 }
      },
      required: ['until'],
      additionalProperties: false
    }
  },
  {
    name: 'mia_train_control', method: 'train_control', annotations: { title: 'Mia: pause a LoRA training, file a checkpoint', ...EDIT },
    description: 'Two actions on a training, both needing the go-ahead (it ends after 10 minutes without a call: hours later, ask again with mia_request). action "pause": the tool writes a checkpoint at the current step and releases the GPU (after the running sample, if any); it does NOT resume by itself. action "add_to_loras": file a checkpoint in « Mes LoRA » (step = which one; default: the latest) → {file, comfyName}; it is then offered in the Model blocks of the same model, nothing is overwritten. NO resume (propose it with mia_train_start {resume:true}), NO stop, NO deletion with this tool: those stay with the user in Mia. Each action is a signed line in the training\'s ÉVÈNEMENTS.',
    inputSchema: {
      type: 'object',
      properties: {
        trainingId: { type: 'string' },
        action: { type: 'string', enum: ['pause', 'add_to_loras'] },
        step: { type: 'integer', minimum: 1, description: 'add_to_loras: the step of the checkpoint to file (default: the latest)' }
      },
      required: ['trainingId', 'action'],
      additionalProperties: false
    }
  },
  {
    name: 'mia_train_note', method: 'train_note', annotations: { title: 'Mia: note on a LoRA training', ...RO, readOnlyHint: false, idempotentHint: false },
    description: 'Write a short note in the ÉVÈNEMENTS of a training (without trainingId: the active one, else the latest), signed with your name, at the current step: what you see in a sample, what you advise (« visage stable, la main gauche reste floue »). In Mia\'s language, 280 characters at most. No go-ahead needed, like mia_say. One note a minute and 40 per training at most: beyond that the error says so.',
    inputSchema: { type: 'object', properties: { trainingId: { type: 'string' }, text: { type: 'string', maxLength: 280 } }, required: ['text'], additionalProperties: false }
  }
];
for (const tool of TOOLS) if (AS_METHODS.has(tool.method)) tool.inputSchema.properties.as = asProp;
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

/** Every bridge.json found, the %TEMP% copy first. */
function readBridges() {
  const out = [];
  for (const file of BRIDGE_FILES) {
    try {
      const b = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (b && b.port && b.token && !out.some((o) => o.token === b.token)) out.push(b);
    } catch { /* missing or partial */ }
  }
  return out;
}

/** The first bridge that answers, with its ping. */
async function liveBridge() {
  for (const b of readBridges()) {
    if (!alive(b.pid)) continue;
    const p = await ping(b);
    if (p) return { b, p };
  }
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
  const found = await liveBridge();
  if (found) { bridge = found.b; return found.b; }
  if (NO_LAUNCH) throw new UserError('Mia n’est pas ouverte (ou son pont ne répond pas). Ouvre Mia puis réessaie.');
  if (!launched || Date.now() - launched > 60000) launchMia();
  const until = Date.now() + LAUNCH_WAIT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 400));
    const up = await liveBridge();
    if (up) {
      // give the interface a moment to come up: the bridge itself waits for it too
      for (let i = 0; i < 30 && !up.p.ui; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const q = await ping(up.b);
        if (q && q.ui) break;
      }
      bridge = up.b;
      return up.b;
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

// Arguments checked against the tool's inputSchema before anything reaches Mia: an unknown field (« toPort »
// instead of to:{node, port}) or a wrong shape is an error, never a silent guess that edits the board.
// (enum not checked here: some fields also take a name, e.g. a block type in Mia's language.)
const fieldList = (schema) => Object.entries(schema.properties || {}).filter(([, s]) => !(s && s.deprecated))
  .map(([k, s]) => (s && s.type === 'object' && s.properties ? `${k} {${Object.keys(s.properties).join(', ')}}` : k)).join(', ');
function typeOk(v, type) {
  if (!type) return true;
  if (Array.isArray(type)) return type.some((x) => typeOk(v, x));
  if (type === 'object') return !!v && typeof v === 'object' && !Array.isArray(v);
  if (type === 'array') return Array.isArray(v);
  if (type === 'integer') return Number.isInteger(v);
  if (type === 'number') return typeof v === 'number' && Number.isFinite(v);
  return typeof v === type;   // string, boolean
}
function argError(toolName, schema, value, where) {
  if (!schema || schema.type !== 'object' || !value || typeof value !== 'object') return null;
  const props = schema.properties || {};
  const at = where ? ` dans « ${where} »` : '';
  if (schema.additionalProperties === false) {
    const extra = Object.keys(value).filter((k) => !(k in props) && !(k === 'projectId' && !where && 'boardId' in props));
    if (extra.length) {
      const s = extra.length > 1 ? 's' : '';
      return `${toolName} : champ${s} inconnu${s}${at} : ${extra.map((k) => `« ${k} »`).join(', ')}. Champs : ${fieldList(schema)}.`;
    }
  }
  for (const k of schema.required || []) {
    if (value[k] == null) return `${toolName} : champ « ${where ? `${where}.` : ''}${k} » manquant. Champs : ${fieldList(schema)}.`;
  }
  for (const [k, s] of Object.entries(props)) {
    const v = value[k];
    if (v == null || !s) continue;
    const name = where ? `${where}.${k}` : k;
    if (!typeOk(v, s.type)) {
      const shape = s.type === 'object' && s.properties ? ` {${Object.keys(s.properties).join(', ')}}` : '';
      return `${toolName} : « ${name} » doit être de type ${s.type}${shape}.`;
    }
    if (s.type === 'object') { const err = argError(toolName, s, v, name); if (err) return err; }
  }
  return null;
}

async function callTool(name, args) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return { content: textContent(`Outil inconnu : « ${name} ». Outils : ${TOOLS.map((t) => t.name).join(', ')}.`), isError: true };
  const params = args && typeof args === 'object' ? { ...args } : {};
  const bad = argError(name, tool.inputSchema, params, '');
  if (bad) return { content: textContent(bad), isError: true };
  // deprecated alias: projectId (a board id before SPEC §18) still works as boardId
  if (params.projectId != null && params.boardId == null) params.boardId = params.projectId;
  let timeout = CALL_TIMEOUT_MS;
  if (tool.method === 'wait') timeout = (Math.max(1, Math.min(600, Number(params.timeoutS) || 120)) + 30) * 1000;
  if (tool.method === 'import_media') timeout = 150000;
  // a training: the wait itself, and the import of a big set of images (the bridge gives the page 140 s)
  if (tool.method === 'train_wait') timeout = (Math.max(1, Math.min(600, Number(params.timeoutS) || 120)) + 30) * 1000;
  if (tool.method === 'train_prepare') timeout = 150000;
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
  log(`ready (bridge files: ${BRIDGE_FILES.join(", ")})`);
}

if (require.main === module) start();

module.exports = { TOOLS, displayName, callTool, onMessage };
