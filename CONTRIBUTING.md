# Contributing to Mia

Thank you for looking at Mia. It started as one artist's tool and stays opinionated: a quiet board, plain words,
local models, nothing that gets in the way of making a shot. Bug reports, fixes and well-argued ideas are welcome;
please read this page first.

## Before you start

- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the pieces fit, the data formats, the engine.
- For anything larger than a fix, open an issue first and describe what you want to change and why. A new
  block, a new setting or a new dependency is a design decision, not just code.
- Mia's interface speaks French and English. Write issues and pull requests in either language.

## Running Mia from source

```powershell
git clone https://github.com/Quentincls/mia.git
cd mia
npm install
npm start               # or: npm run dev  (DevTools, renderer console copied to the log)
```

Computing needs the engine (ComfyUI and Python) and models: see [docs/INSTALL.md](docs/INSTALL.md). Everything
else (the board, the home page, tabs, projects, import, the player) works without them.

### A test instance that cannot hurt your data

Never test on your own boards. Point a hidden instance at scratch folders:

```powershell
$env:MIA_HEADLESS = "1"            # no window
$env:MIA_NO_GPU = "1"              # every GPU job is refused
$env:MIA_USERDATA = "$env:TEMP\mia-test\ud"
$env:MIA_PROJECTS_ROOT = "$env:TEMP\mia-test\projects"
node_modules\electron\dist\electron.exe . --remote-debugging-port=9333
```

Drive it over the Chrome DevTools Protocol (`window.__mia` exposes `state`, `bus`, `app`, `editor`), take
screenshots, and stop it by its process id, never by image name.

## The rules of the code

- **No new dependency.** The app runs on Electron and Node built-ins; `electron-builder` is the only dev
  dependency. The Python worker uses what the engine already installs.
- **No framework, no bundler.** The main process is CommonJS (`'use strict'`); the interface is native ES modules.
- **Every visible string in French and English**, registered by its module through `i18n.js`
  (`t`, `tn` for plurals, `tl` for `{fr, en}` objects). No label in a module constant.
- **Nothing of Windows on screen**: no native menu, `<select>`, `title=` tooltip or dialog. Use `ui/controls.js`,
  `ui/menu.js`, `ui/tooltip.js`, `ui/modal.js`.
- **Quiet design**: one accent colour, no glow, no decorative gradient, no sparkles. Durations and easings come
  from `src/css/tokens.css`; animate `transform` and `opacity` only, and respect reduced motion.
- **Plain words** in the interface: a *board*, a *block*, a *project*; technical terms only under *Advanced*.
- **Never lose user data**: copy originals, keep versions, write files atomically, send deletions to the Recycle
  Bin, migrate formats without dropping unknown keys (`electron/migrations.js`).
- **One heavy GPU job at a time**, always through the engine queue and the GPU lock.
- **Local only**: no network call outside `127.0.0.1`, except model downloads the user starts.

## Checks before a pull request

Syntax of every JavaScript file, CommonJS and ES modules alike (works in PowerShell, `cmd` and bash):

```powershell
node tools/check-syntax.mjs                          # all of electron, mcp, tools, src/js
node tools/check-syntax.mjs src/js electron/main.js  # or only what you touched
```

None of the tests uses the GPU. These need only the repository and `npm install`, no engine and no model:

```powershell
node tools/test-engine.js            # queue, GPU lock, runs, cancel, with fake executors (tools/fixtures/engine)
node tools/validate-workflows.js     # every ComfyUI graph Mia builds, checked against ComfyUI's schema
node tools/test-migrations.js        # file format upgrades
node tools/test-installer.js         # model downloads, against a local fake Hugging Face
node tools/test-bridge.js            # starts a hidden test Mia (its own profile) and drives it like an assistant
node tools/privacy-audit.js          # nothing personal in what you are about to commit
```

`validate-workflows.js` reads the schema saved in `tools/fixtures/comfy_object_info.json`. To check against your
own ComfyUI, save `http://127.0.0.1:8188/object_info` to a file and pass it with `--schema <file>`. While a
ComfyUI runs on that port, the model lists come from it, so the models you have not installed are reported
missing; `--offline` takes the lists from the schema instead. Run it whenever you change a graph or an executor. `test-engine.js` also checks the author's engine when it finds it; elsewhere those checks are skipped
and say so.

These need an installed engine (ffmpeg, Python, the model folders, see [docs/INSTALL.md](docs/INSTALL.md)); point
them at yours with `$env:MIA_ENGINE_ROOT = "<engine folder>"`:

```powershell
node tools/test-light-executors.js   # the light blocks (ffmpeg and the Python worker, on the CPU)
node tools/test-scanner.js           # model recognition, on your engine's model folders (read only)
```

And this one needs the test instance above, running:

```powershell
node tools/check-wires.mjs 9333 --all     # wires land on their ports, on every board
```

Then look at what you changed, in the running app, in both languages and both themes.

## Pull requests

- One subject per pull request, with a short description of the change and how you checked it.
- Screenshots or a short capture for anything visible.
- New blocks go through `src/catalog/nodes.json` (labels, ports, settings, estimates) and an executor in
  `electron/engine/executors/`; new assistant tools go in `electron/bridge.js`, `src/js/ui/presence.js` and
  `mcp/mia-mcp.js`.
- Update [CHANGELOG.md](CHANGELOG.md) under the next version.

## Models and licences

Mia never ships model weights. When you add support for a model, add its recognition rule and licence flag in
`electron/scanner-rules.js` and its files in `src/catalog/models-manifest.json`. Models whose licence is
non-commercial or excludes the European Union must stay flagged `forbidden`.

## Licence

By contributing, you agree that your contribution is released under the [Apache License 2.0](LICENSE), like the
rest of Mia.
