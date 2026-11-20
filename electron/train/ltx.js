'use strict';
/**
 * Mia — training tool descriptor: Lightricks' ltx-trainer (LTX 2.5), see electron\train\common.js.
 *
 *   <toolsDir>\venv-ltx                              the tool's Python
 *   <toolsDir>\src\LTX-2\packages\ltx-trainer        its sources (scripts\preprocess.py)
 *   <Mia>\python\train\mia_train_ltx.py              Mia's adapter, run inside the trainer's process
 *
 * The adapter hooks private parts of the trainer: only the exact version of the catalog is accepted.
 */
const fs = require('node:fs');
const path = require('node:path');
const { pythonFor } = require('../engine/pyexe');
const C = require('./common');

const VENV = 'venv-ltx';
const sources = (toolsDir) => path.join(toolsDir, 'src', 'LTX-2', 'packages', 'ltx-trainer');
const adapter = (root) => path.join(root, 'python', 'train', 'mia_train_ltx.py');

function detect({ toolsDir, root, toolVersion }) {
  const python = C.venvPython(toolsDir, VENV);
  if (!fs.existsSync(python)) return { ok: false, version: null, python, why: { code: 'tool', path: path.join(toolsDir, VENV) } };
  const src = sources(toolsDir);
  if (!fs.existsSync(path.join(src, 'scripts', 'preprocess.py'))) return { ok: false, version: null, python, why: { code: 'tool', path: src } };
  const version = C.distVersion(path.join(toolsDir, VENV), 'ltx-trainer');
  if (toolVersion && version !== toolVersion) return { ok: false, version, python, why: { code: 'version', version: version || '?' } };
  const a = adapter(root);
  if (!fs.existsSync(a)) return { ok: false, version, python, why: { code: 'tool', path: a } };
  return { ok: true, version, python, why: null };
}

function command({ dir, run, token, resumeFrom, toolsDir, root, engineRoot }) {
  const real = pythonFor(C.venvPython(toolsDir, VENV));   // the real interpreter: no console window
  return {
    exe: real.exe,
    args: ['-B', '-u', adapter(root), ...C.adapterArgs({ dir, run, token, resumeFrom })],
    cwd: sources(toolsDir),
    env: {
      ...real.env,
      ...C.PY_ENV,
      MIA_TRAIN_PYTHON: real.exe,                         // the adapter starts preprocess.py with the same pair
      MIA_TRAIN_TOOLS: toolsDir,
      MIA_ENGINE_MODELS: engineRoot ? path.join(engineRoot, 'models') : ''
    }
  };
}

module.exports = {
  id: 'ltx',
  label: 'ltx-trainer',
  gpu: true,
  detect,
  command,
  checkpoints: C.ltxCheckpoints,
  verify: C.ltxVerify,
  cleanTmp: C.ltxCleanTmp
};
