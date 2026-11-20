# Mia — architecture

How Mia is built, for anyone who wants to read or change the code. The user guide is the [README](../README.md);
installation on another PC is [INSTALL.md](INSTALL.md) (in French).

- [Principles](#principles)
- [Stack](#stack)
- [Repository layout](#repository-layout)
- [Processes and the `window.mia` bridge](#processes-and-the-windowmia-bridge)
- [Data on disk](#data-on-disk)
- [The block catalogue](#the-block-catalogue)
- [The engine](#the-engine)
- [Models and LoRAs](#models-and-loras)
- [The interface](#the-interface)
- [Assistants: bridge and MCP server](#assistants-bridge-and-mcp-server)
- [Versions, migrations, packaging](#versions-migrations-packaging)
- [Design rules](#design-rules)
- [Tests](#tests)

---

## Principles

- **Local first.** Everything runs on the user's PC: ComfyUI on `127.0.0.1`, a Python worker, ffmpeg. The only
  outgoing connections are the model downloads the user starts, the engine setup script and, once the user has
  linked an account, the paid online models of one service (Higgsfield), only when the user runs such a block.
- **Plain words.** A *board* holds *blocks* named by what they do; a *project* is a folder of boards. No jargon
  outside the folded *Advanced* settings (no "sampler", "VAE", "IC-LoRA" on screen).
- **One heavy job at a time**, behind a GPU lock that other tools on the machine can share.
- **Never lose anything.** Originals are copied, never recompressed; every run is kept as a version; a damaged
  file is never overwritten by an empty one; deletions go to the Recycle Bin.
- **Nothing of Windows on screen**: no native title bar, menu, tooltip, `<select>` or dialog (the file picker is
  only a fallback).
- **Two languages**, French (default) and English, for every visible string.

## Stack

| Layer | Choice |
|---|---|
| Shell | Electron 38, frameless window, no application menu |
| Main process | CommonJS, Node built-ins only (`fetch`, `WebSocket`, `FormData`) |
| Interface | native ES modules, no framework, no bundler, no TypeScript |
| Compute | ComfyUI (driven over HTTP and WebSocket) and `python/mia_worker.py` (PyTorch, PyAV) |
| Video I/O | ffmpeg from the engine's Python environment (`imageio-ffmpeg`), NVENC when available |
| Dependencies | none at runtime besides Electron; `electron-builder` for packaging only |

## Repository layout

```
electron/            main process
  main.js            lifecycle, window, mia:// protocol, IPC for window/app/prefs/projects/media/shell
  preload.js         the window.mia bridge (contextIsolation, sandbox)
  store.js           prefs, index, projects and boards, graph.json (+ .bak), thumbnails, migrations on load
  media.js           import, probe, poster, proxy video (one ffmpeg at a time)
  ffmpeg.js          ffmpeg path, probe, run with progress, poster, proxy, encoding presets
  shellops.js        Explorer, open with, copy path, Recycle Bin
  scanner.js         model scan, cache, capabilities, LoRA registry and placement
  scanner-rules.js   recognition rules and the display catalogue (labels, licences, VRAM)
  installer.js       resumable model downloads, first-launch engine check
  trainer.js         LoRA training service: the list, image sets, one training tool at a time, filing the LoRA
  trainshell.js      what Windows shows of a training: taskbar progress, flash at the end, no sleep meanwhile
  train/             one descriptor per training tool (ltx, aitk, fake): detection, version, weights, command
  places.js          default folders: engine, projects, trainings and training tools
  bridge.js          local HTTP bridge for the assistants
  version.js         { version, date, commit }, changelog sections
  migrations.js      data format versions and migration chain
  engine/
    index.js         job queue, upstream resolution, hashes, run.json, status, IPC engine:*
    comfy.js         ComfyUI client (reuse or launch, upload, submit, progress, outputs, cancel)
    pyrun.js         runs the Python worker, reads its progress, cancels
    gpulock.js       shared GPU lock file
    patch.js         API-graph patcher (set by id, bypass, insert after)
    validate.js      offline validation of a graph against ComfyUI's object_info
    workflows/       ComfyUI API graphs used by the executors (sources, licences and changes: NOTICE.md in this folder, index.json)
    executors/       one module per block type that computes
python/
  mia_worker.py      entry point: python -B -u mia_worker.py <task> <job.json>
  mia_common.py      @mia protocol, video read/write (PyAV + NVENC), CUDA helpers
  tasks/             cutout, composite, finish
  train/             training adapters (LTX trainer, ai-toolkit): they drive the tool and write its progress files
  vendor/tool/       frozen copies of the few toolbox modules the tasks import
src/
  index.html         one module script, all style sheets
  catalog/           nodes.json (the blocks), recipes/, models-manifest.json, train-bases.json (trainable models)
  css/               tokens, app, controls, home, graph, nodes, queue, library, presence, train…
  js/                app, bus, state, i18n, icons, util
  js/ui/             chrome, tabs, home, menus, modals, toasts, tooltips, controls, settings, library, welcome, presence,
                     train (the Trainings screen) with traintext, trainchart, trainclose, and queuetrain (its queue row)
  js/graph/          editor, document, history, camera, view, wires, interaction, palette, minimap, sections…
  js/nodes/          block bodies, media wells, player, settings, model picker, compare, versions, viewer, runs
mcp/mia-mcp.js       MCP server (stdio, no dependency)
luts/                Finish looks (.cube), index.json, previews
engine-setup/        install-engine.ps1 and its pinned versions
skills/              SKILL.md files for AI assistants
tools/               tests and maintenance scripts
```

## Processes and the `window.mia` bridge

The renderer never touches Node. `preload.js` exposes `window.mia`, a set of promise-returning calls over
`ipcRenderer.invoke`; an expected failure comes back as `{ ok: false, error: "readable sentence" }`.

| Namespace | What it covers |
|---|---|
| `mia.win` | minimize, maximize, close, fullscreen, state events, flush-before-close handshake, title-bar menu |
| `mia.app` | `info()` (version, data and projects folders, engine root), `reload()` |
| `mia.prefs` | `get()`, `set(patch)` — prefs are always merged, never replaced |
| `mia.projects` | boards: list, create (in a project or not), open, save (with a thumbnail rectangle), rename, duplicate, move, remove, reveal |
| `mia.folders` | projects: list, create, rename, set colour, remove (keeping the boards or not), reveal |
| `mia.media` | import paths or a pasted buffer, file picker fallback, proxy-ready events |
| `mia.shell` | reveal, open, copy path, drag a file out of Mia |
| `mia.models` | inventory, scan, inspect a file, add / update / remove a LoRA, update and progress events |
| `mia.engine` | status, run, cancel, jobs, runs of a block, delete a run, start ComfyUI, events |
| `mia.installer` | model downloads: list, start, pause, cancel, status, progress events |
| `mia.train` | LoRA trainings: options, list, get, create, update, add or remove images, captions, start, control (pause, let a job through, stop), file a checkpoint in My LoRAs, notes, Recycle Bin, reveal, locate, seen; `train:event` |
| `mia.bridge` | assistants: status, calls relayed to the interface, replies |

Files are served to the page by the `mia://` protocol, with byte ranges (video seeking) and no caching:
`mia://p/<boardId>/<relative path>` for a board's files, `mia://m/<base64url(absolute path)>` for a file outside
it, allowed only under the projects folder, the engine folder, Mia's data folder, the model and LoRA folders of the
settings, and the trainings folders. The page's Content Security
Policy allows only `self`, `mia:`, `data:` and `blob:`.

## Data on disk

```
%APPDATA%\Mia\data\              prefs.json, index.json (a cache), models-cache.json, loras.json,
                                 timings.json (learnt durations), bridge.json (while Mia runs), logs\
<projects root>\                 prefs.projectsRoot; default D:\Mia\Projets when D: exists, else Documents\Mia Projets
  <Project>\folder.json          { id: "f_…", name, color, created, updated, version }
  <Project>\<Board>\             a board in a project…
  <Board>\                       …or a board on its own
    project.json                 { id: "p_…", name, folderId, created, updated, opened, version }
    graph.json (+ .bak)          the board
    thumb.png                    the home page picture (480×300)
    media\                       imported originals
    cache\                       proxies, posters, waveforms (disposable)
    outputs\<blockId>\<runId>\   the files of a run and its run.json
    A_regarder\                  exports ("to review")
<trainings root>\                prefs.trainRoot; default <engine's parent>\entrainement\mia when that folder exists,
                                 else <data>\training (a test instance always uses its own data folder)
  <trainingId>\                  t_YYYYMMDD-HHMM_<name>
    train.json                   the record, written by Mia only, paths relative to the folder
    dataset\                     images (hard links, else copies), captions (always copies), dataset.json
    config.yaml, cache\, out\    the tool's configuration (rewritten at each launch), its cache and its output
    control\                     pause, stop, alive (Mia) and adapter.json (the adapter)
    events.jsonl, metrics.jsonl  what the adapter reports, one line per event and per step
    log.txt                      the tool's raw output
```

The index is rebuilt from the folders at start-up; a board renamed in the app is a folder renamed on disk, and
all writes to the index go through one queue. A project folder without `folder.json` that holds boards is adopted.

**graph.json**

```json
{
  "version": 1,
  "camera": { "x": 0, "y": 0, "z": 1 },
  "nodes": [
    { "id": "n_k3j2a9", "type": "depth", "x": 120, "y": 80, "w": 336, "title": null,
      "params": { "detail": "fast" }, "data": {}, "pinnedRun": null, "collapsed": false, "bypass": false }
  ],
  "edges": [ { "id": "e_x81f", "from": { "node": "n_a", "port": "out" }, "to": { "node": "n_b", "port": "media" } } ],
  "groups": [ { "id": "g_1", "x": 0, "y": 0, "w": 800, "h": 500, "title": "Shot 12", "tone": null } ]
}
```

`camera` is the world point at the top-left of the view and the zoom. Node `x, y, w` are in world units; the
height follows the content. Properties starting with `_` are display caches and never written. Results are not
in the graph: they live in `run.json` files.

**run.json** (one version of a block, written by the engine)

```json
{ "runId": "r_1016_201533_ab12", "nodeId": "n_k3j2a9", "type": "depth", "mode": "final",
  "status": "done", "hash": "…", "params": {}, "started": 0, "finished": 0,
  "outputs": { "depth": { "path": "outputs/n_k3j2a9/r_…/depth.mp4", "kind": "video",
                          "meta": { "w": 1920, "h": 1080, "fps": 24, "frames": 120, "duration": 5 },
                          "poster": "outputs/n_k3j2a9/r_…/depth.jpg" } },
  "model": "Video Depth Anything (Small)", "error": null, "log": "outputs/…/log.txt" }
```

`status` is `done`, `error` or `cancelled`; paths are relative to the board. The versions of a block are its
`done` runs, newest first. The *current* version is the pinned one if any, else the newest final render, else
the newest preview — so a block downstream never takes a preview when a final render exists.

## The block catalogue

`src/catalog/nodes.json` is the single source of truth for blocks: categories, ports, settings, engine and
estimates. The interface, the engine and the MCP server all read it.

- **Ports**: `image`, `video`, `media` (image or video), `text`, `audio`. An output `follow:<input>` takes the
  concrete type of what is wired to that input. Inputs may be `multi` (ordered by the vertical position of their
  sources) with a `max`.
- **Settings** (`kind`): `model` (filtered by capability), `select`, `seg` (segmented control), `slider`,
  `toggle`, `prompt` (overridden by a wired text block), `text`, `seed`, `frame` (a frame of an input video),
  `file` (a LUT, for instance). `advanced: true` folds a setting; `showIf` shows it only under a condition;
  `required` blocks a run while it is empty.
- **Running**: `modes: ["preview", "final"]` gives the two buttons *Preview* and *Final render*; without modes a
  single *Run*; `engine: null` means the block never computes. `engine.gpu` is `heavy`, `light` or `none`.
- **Labels** are `{ fr, en }` objects, always read through `tl()`.
- **Recipes** (`src/catalog/recipes/*.json`) are small boards: nodes with keys and positions, edges as
  `[fromKey, fromPort, toKey, toPort]`, optional placeholders for the files the user still has to drop.

## The engine

`electron/engine/index.js` registers the `engine:*` channels and owns the queue.

1. **Check** the block: required inputs wired, required settings filled, model available — otherwise a plain
   sentence and the list of what is missing.
2. **Resolve upstream.** Each computable block upstream gets a hash of its type, full settings, mode and upstream
   hashes (an imported file: path, size, modification time; a text: its text). A `done` run with the same hash,
   or a pinned run, is reused; otherwise a job is queued for it first. A failed upstream fails the block with its
   name.
3. **Queue.** One `heavy` job at a time, and only with the GPU lock; `light` and `none` jobs run two at a time
   but wait while a heavy job runs (or while a LoRA training holds the GPU, see below). First in, first out; any job can be cancelled. Online jobs (a Model block set
   to an online model) have their own lane: they never wait for the GPU and never hold a heavy job back, up to
   `prefs.cloudParallel` at once (4 by default, 1 to 16, set in Settings → Online accounts).
4. **GPU lock.** A small lock file in the engine's `runtime` folder, shared with other tools: who holds it, since
   when, for how long. Taken for each heavy job with a readable label, renewed every five minutes, released in a
   `finally`; a stale lock of a dead Mia process is cleared at start-up. While someone else holds it the job shows
   *waiting for the GPU* and retries every 15 s. `MIA_NO_GPU=1` refuses every heavy job (test instances).
5. **Executor.** `executors/<name>.js` exports `run(x)` (and optionally `estimate(x)`), where `x` carries the
   board, block, run id, catalogue entry, settings with defaults, mode, resolved inputs (`{abs, rel, kind, meta}`,
   `{text, negative}` or lists), an output folder, a model resolver, `progress()`, `preview()`, an `AbortSignal`
   and the ComfyUI, Python and ffmpeg helpers. It returns `{ outputs, model?, notes? }`.
6. **After** a run: every output is probed, videos get a poster, `run.json` is written and a `done` event carries
   it. Errors write `status: "error"`, a readable message and a log; cancelled runs keep only `run.json` and the
   log. Mia's temporary files in the engine's input and output folders are removed.

**ComfyUI** (`comfy.js`): reuses a running instance or starts one (never a second one), uploads inputs (large
files are copied directly), submits API graphs with Mia's own prompt id, follows progress over WebSocket, reads
outputs from history, cancels its own prompts only. After a ComfyUI job, models are unloaded when the next queued
job is a Python GPU task.

**Python worker** (`pyrun.js` + `python/`): `python -B -u mia_worker.py <task> <job.json>`, with offline Hugging
Face flags and UTF-8 output. It talks back with lines such as `@mia {"p":0.42,"msg":"…","eta":12}`,
`@mia {"preview":"<image>"}`, `@mia {"done":true,"outputs":{…}}` or `@mia {"error":"…"}`. Cancelling writes a
`cancel` file in the output folder, then ends the process tree after three seconds.

**Status**: `engine:status` reports ComfyUI (`running`, `stopped`, `starting`, `error`, `foreign`), the GPU
(name, memory, lock) and the queue (`running`, `waiting`, then `local` and `online` apart), refreshed every three
seconds while a window is open. Jobs and events carry progress, a message and an ETA learnt from past runs of the
same block type and mode; an online job also carries `online: true` and `remote` (`queued`, `running`, or `full`
while the provider's queue is full).

### Training a LoRA

A training is not a job: it lasts hours, files nothing in a board and keeps its whole state in its own folder (see
[Data on disk](#data-on-disk)), so the screen, the assistants and a restarted Mia all read the same files.
`electron/trainer.js` keeps the list, imports image sets without touching the originals, checks everything again
before each start (tool and its exact version, weights, images, captions, disk space, Windows memory), starts one
tool at a time and reads its files every second. The tool is a Python adapter per training tool
(`python/train/mia_train_ltx.py` for the LTX trainer, `mia_train_aitk.py` for ai-toolkit) that writes
`events.jsonl` and `metrics.jsonl`; orders go through files in `control\` (`pause`, `stop`, and `alive`, rewritten
every 20 s: an adapter that sees it too old stops by itself). The tool's output goes to `log.txt` through a file
handle, never a pipe, so it can stop cleanly even if Mia dies; at start-up Mia either takes a still-running tool
back (same token) or files the training as interrupted. Resuming starts from the last *verified* checkpoint. A
finished LoRA is hard-linked into `models\loras\mia\` with a `.mia.json` card that the scanner reads.

It uses the GPU through the engine's door, `engine.holdGpu()`: it waits for every local job to end, takes the same
lock file (written for at most 30 minutes, renewed every five, so an orphan lock falls within 70 minutes), and while
it holds it no local job starts, except jobs that need no GPU (and not even those while the model loads). Online
jobs are never held. “Let it through” pauses the training for the waiting jobs and resumes it when the local queue is
empty. `tools/fixtures/train/fake-trainer.js` speaks the same protocol without Python or GPU; it is the only tool a
test instance (`MIA_TRAIN_FAKE=1`, `MIA_NO_GPU=1`) accepts.

### The Model block and online models

A *Model* block (`type: "gen"`) is set to a model family rather than a task: `fam:ltx`, `fam:minimax`… on this PC
(`src/catalog/model-families.json`), or `hf:<family>` online (`src/catalog/cloud-higgsfield.json`). What is wired
into it picks what it does: `src/js/nodes/route.js` (an ES module with no import, loaded by the interface and, with
its `export`s stripped, by the engine) scores each of the family's ways of working against the wired inputs, so
the screen and the engine always agree. Online, a way chosen by the user (`params.workflow`) wins over the score.

The online catalogue is generated, never edited by hand: `tools/build-cloud-catalog.mjs` reads the provider's
public pages and schemas (`--renormalize` rebuilds it offline from a cache). Each way lists its inputs, settings
(with tier-only settings and options: `onlyTiers`, `tierOptions`), prompt tokens (`cite`), whether its length
follows the source video (`durationFromSource`, `minSeconds`), a public price range (`price`) and the fields Mia
does not send yet, each with a reason (`unsupported`). `electron/engine/executors/cloud.js` uploads the inputs,
sends only what the chosen tier accepts, retries a full queue (HTTP 429) after the delay it is given with the
same `Idempotency-Key` (never charged twice), and follows the request until the result is downloaded into the
version folder. A job cancelled after the provider has started it is still fetched, since it is already paid.
Prices come from the provider's free estimate, or from the public price range, shown with "≈". The account key
is kept encrypted (`safeStorage`) in the data folder and never reaches the window. `tools/test-cloud.js` checks
all of this against a local fake server.

## Models and LoRAs

`scanner.js` walks the engine's model folders (and extra roots), identifies each file by its header and name with
`scanner-rules.js`, and returns an inventory: one entry per model with its family, role, capabilities, size,
VRAM estimate, licence flag (`ok`, `trial`, `rd`, `forbidden`) and status (`ready`, `incomplete`, `duplicate`…).
Capabilities form a closed vocabulary used by the catalogue (`image-to-video`, `text-to-video`, `3d-to-real`,
`guided-video`, `reference-to-video`, `character-performance`, `image-edit`, `upscale`, `depth`, `cutout`,
`lora`). Text encoders, VAEs and technical LoRAs are hidden parts; models whose licence is non-commercial or
excludes the EU are never offered. The cache answers at once; a revalidation runs in the background.

LoRAs come from the engine, from folders listed in the settings, or from files dropped on Mia (registry
`loras.json`). Each one knows the base family it was made for, its kind (character, place, style) and its trigger
word. Before a run, a LoRA that ComfyUI cannot see yet is placed in `models\loras\mia\` (hard link on the same
volume, copy otherwise) — the only place Mia writes in the engine's model folders, besides downloads. A LoRA
trained in Mia is filed there too, beside a `<name>.mia.json` card (name, kind, trigger word, training: base,
steps, images, date); the scanner reads it, marks the file *trained here*, labels an intermediate step
“Rosa · step 1,000” and lets the user send the file and its card to the Recycle Bin.

**Installer** (`installer.js` + `src/catalog/models-manifest.json`): the files each capability needs, with source
repository, size and licence. One download at a time, resumable, size (and hash when known) checked, free space
checked, a same-named file of another size never overwritten. A gated repository uses the user's own Hugging Face
token file, read per download and sent only to Hugging Face.

## The interface

`index.html` loads every style sheet and a single module, `js/app.js`, which mounts the chrome, the home page and
the editor. Modules talk through a small event bus (`bus.js`: `on`, `off`, `once`, `emit`); shared state lives in
`state.js` (prefs, current board, inventory, engine status).

- **Home** (`ui/home.js`): projects, then boards without a project, then recipes; search and sort; breadcrumb
  inside a project; drag a board onto a project to file it.
- **Tabs** (`ui/tabs.js`): one tab per open board; the boards of a project are contiguous behind a coloured
  group chip that folds and unfolds; the window controls are never pushed out of view. There is no tab limit:
  past the room available, names shrink to a floor, then the strip scrolls between two arrows (wheel too), the
  active tab is always brought into view, and a list button shows every open board by project, with a search
  field from nine tabs.
- **Editor** (`graph/editor.js`): the camera (world point at the top-left plus zoom), the block cards (header,
  preview well, port rows, settings, footer), wires (horizontal-tangent cubic Béziers), sections, minimap,
  clipboard, undo history. Levels of detail switch content visibility at zoom 0.45, 0.22 and 0.10; a block never
  changes size with the zoom. No alignment guides or magnetism unless the grid snap is turned on.
- **Block bodies** (`nodes/body.js`): what is inside a card, given `(node, type, slots, api)`. `nodes/runs.js` is
  the single source of truth for versions and run state (`idle`, `queued`, `waiting-gpu`, `running`, `error`,
  `cancelled`, `done`, out of date).
- **Player** (`nodes/player.js`): frame counter (frames from 0, seconds or timecode), one- and ten-frame steps,
  speed ×0.25 to ×2, *grab this frame* into a new block, A/B comparison kept in sync.
- **i18n** (`i18n.js`): `t(key, vars)`, `tn(key, n)` for plurals, `tl({fr, en})`; each module registers its own
  strings; language changes reload the window after saving.
- **Controls** (`ui/controls.js`): segmented controls, dropdowns, sliders, toggles, fields, buttons — all drawn by
  Mia, never native.
- **Trainings** (`ui/train.js`): a third view beside the home page and the board (`#view-train`), with the list,
  a draft and the instrument of a running training (bar, state line, loss curve in `trainchart.js`, samples,
  checkpoints, events, controls), plus its chip in the title bar. It keeps nothing: it asks `train:get` and listens
  to `train:event`. Every word and every “what to show in this state” rule is in `traintext.js`, a pure module tested
  under Node. `trainclose.js` asks before Mia closes over a training (no answer keeps Mia open), `queuetrain.js`
  draws the training's row in the job queue, and the library and the settings have their own training parts.

## Assistants: bridge and MCP server

`electron/bridge.js` serves a small JSON API on `127.0.0.1` (first free port from 8777) with a random bearer
token, written with the port to `%APPDATA%\Mia\data\bridge.json` while Mia runs. Calls run in the main process or
are relayed to the interface, which performs them through the editor with a visible presence: a cursor labelled
with the assistant's name glides to each block it places, wires or sets, a short bubble shows what it says, and
every action enters the undo history.

`mcp/mia-mcp.js` is a stdio MCP server without dependencies. It reads `bridge.json`, starts Mia if needed, and
exposes 33 tools: the user's go-ahead (request, pending), status, catalogue, projects and boards, blocks, wires, settings, media import, recipes,
sections, arrange, run, wait, jobs, cancel, outputs, snapshot, focus and say, and seven `mia_train_*` tools for
LoRA training (options, prepare, start, status, wait, control, note). Assistant jobs share the same
queue and GPU lock as the user's clicks. The bridge never deletes a file and only imports existing paths. An
assistant can prepare a training and *suggest* starting it, never start it: the user clicks “Start” on a card in
Mia, and only the user resumes, stops or deletes a training.

## Versions, migrations, packaging

- **Versions**: SemVer in `package.json`; `CHANGELOG.md` (French) lists each version; `electron/version.js`
  reads both. A new version shows a discreet *What's new* toast once.
- **Migrations** (`electron/migrations.js`): `graph.json`, `project.json`, `folder.json`, `prefs.json` and
  `loras.json` carry a format version. Files are migrated step by step when loaded; the old file is copied to
  `<file>.bak-v<old>` before a newer version is written; a file from a newer Mia opens read-only.
- **Packaging**: `npm run dist` builds an NSIS installer (per user, folder of choice, shortcuts) and a portable
  zip with electron-builder, for x64 then arm64 (`tools/dist.js`, one run per architecture, arm64 files named
  `Mia-<version>-arm64-…`; Electron is the official build of each architecture, never `node_modules/electron/dist`), `asar` off so the Python worker, LUTs and MCP server stay real files. Builds are not
  signed yet.
- **Engine setup**: `engine-setup/install-engine.ps1` installs, into a chosen folder, the same engine Mia is
  tested with (uv, Python, ComfyUI at a pinned tag, PyTorch for CUDA, the extra nodes at pinned commits, the
  worker's packages). It can be run again safely; `-DryRun` prints every step without downloading. The
  first-launch wizard (`src/js/ui/welcome.js`) offers it when no engine is found.

## Design rules

The look is deliberately quiet: near-black surfaces, 1 px hairlines, a 2 px progress bar as the only animated
indicator, monospace capitals for small labels, and **one accent colour** (blue) kept for selection, a running
job and the primary action. No glow, no decorative gradient, no "AI sparkles". Wires are neutral grey; only the
port dots carry the muted colour of their data type. Motion uses `transform` and `opacity` only, with durations
and easings defined once in `src/css/tokens.css`, and falls back to short fades when the system asks for reduced
motion. Labels are never hard-coded in a module constant, never shown with a native `title=` tooltip, and every
string exists in French and English.

## Tests

All tests run without a GPU and without touching real user data. Some read an installed engine (ffmpeg, Python,
model folders): see [CONTRIBUTING.md](../CONTRIBUTING.md).

| Command | What it checks |
|---|---|
| `node tools/test-engine.js` | queue, GPU lock, hashes, cancellation |
| `node tools/test-scanner.js` | model recognition, capabilities, LoRA registry and placement (in a fake engine folder) |
| `node tools/validate-workflows.js` | every ComfyUI graph Mia builds, validated offline against the schema in `tools/fixtures/comfy_object_info.json` (or `--schema`) |
| `node tools/check-syntax.mjs` | syntax of every JavaScript file, typographic apostrophes in French strings |
| `node tools/test-route.js` | how a Model block picks its way of working from what is wired (shared by screen and engine) |
| `node tools/test-variants.js` | versions of a model (compact, full, complete), paired text encoder, estimated memory, “auto” by the machine's memory, ids kept after the engine folder moves (fake engine in a temporary folder) |
| `node tools/test-cloud.js` | online models against a local fake server: uploads, requests, tiers, retries, cancelling, prices (no real call, nothing paid) |
| `node tools/test-light-executors.js` | CPU executors (trim, resize, sequence, sound, finish…) |
| `node tools/test-bridge.js` | the assistants' bridge and MCP server, LoRA training tools included |
| `node tools/test-migrations.js` | data format migrations |
| `node tools/test-installer.js` | model downloads against a local fake server (resume, cancel, wrong size, gated) |
| `node tools/test-trainer.js` | the training service with the fake tool: drafts, image sets, start, pause, stop, resume, errors, restart, filing, Recycle Bin |
| `node tools/test-train-config.js` | the training adapters' configurations in `--dry` mode, against the real tools' virtual environments when present (no GPU; about 4 minutes) |
| `node tools/test-train-ui.mjs` | the words and display rules of the Trainings screen (`traintext.js`), in French and English |
| `node tools/test-train-queue.mjs` | the training's row in the job queue (`queuetrain.js`) |
| `node tools/test-train-settings.js` | Settings → Training: folders refused or accepted, tools detected, the service following the settings |
| `node tools/check-wires.mjs <port> --all` | every wire ends exactly on its port dot, in a running instance |
| `node tools/check-train-screen.mjs <port>` | the Trainings screen in a running test instance with the fake tool, French then English, with screenshots |
| `node tools/test-train-close.mjs <port> --userdata <dir>` | closing Mia during a training (stay, no answer, stop and quit, quit without waiting); that instance closes |
| `node tools/check-train-queue.mjs <port>` · `check-library-train.mjs <port>` · `test-train-settings-ui.mjs <port> --userdata <dir>` | the queue row, the library's trained LoRAs and Settings → Training, on screen |
| `node tools/privacy-audit.js` | what would be committed: personal paths, user and host names, secrets, weights |

The on-screen training checks need a fresh hidden test instance each, started with `MIA_TRAIN_FAKE=1` as well
(below): they refuse an instance that uses everyday data or has no fake tool.

A test instance never shares data with a real one:

```powershell
$env:MIA_HEADLESS = "1"            # the window is never shown
$env:MIA_NO_GPU = "1"              # every heavy job is refused
$env:MIA_TRAIN_FAKE = "1"          # the fake training tool (only for the training checks)
$env:MIA_USERDATA = "$env:TEMP\mia-test\ud"
$env:MIA_PROJECTS_ROOT = "$env:TEMP\mia-test\projects"
node_modules\electron\dist\electron.exe . --remote-debugging-port=9333
```

It can then be driven over the Chrome DevTools Protocol; `window.__mia` exposes `state`, `bus`, `app` and
`editor`. Stop it by its process id, never by image name (another Electron app may be running).
