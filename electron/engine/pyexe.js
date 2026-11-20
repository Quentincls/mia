'use strict';
/**
 * Mia — which python.exe to start for the engine, without a console window.
 *
 * <engine>\env\venv\Scripts\python.exe is not Python: it is a small launcher that starts the real interpreter
 * (the `home` of pyvenv.cfg) as a second process. Node's `windowsHide` only hides the launcher; when the launcher
 * has no console (detached, or a windowless parent such as Mia), Windows gives the real interpreter a brand-new
 * console, and on Windows 11 with Windows Terminal as the default terminal that console is a visible window
 * (seen on the RTX Spark, 18/11/2026: one black window per ComfyUI start and per Python task).
 *
 * So Mia starts the real interpreter itself and tells it which venv it serves, exactly as the launcher does:
 * the environment variable __PYVENV_LAUNCHER__ (CPython reads it on Windows to find pyvenv.cfg, so sys.prefix
 * and site-packages stay those of the venv).
 *
 *   pythonFor(py) → { exe, env }   exe to spawn, and the variables to add to the child's environment
 *
 * Anything unexpected (no pyvenv.cfg: a ComfyUI portable's python_embeded; a `home` that is gone) falls back
 * to the path given, unchanged.
 */
const fs = require('node:fs');
const path = require('node:path');

function pythonFor(py) {
  const same = { exe: py, env: {} };
  try {
    if (!py || path.basename(path.dirname(py)).toLowerCase() !== 'scripts') return same;
    const cfg = path.join(path.dirname(path.dirname(py)), 'pyvenv.cfg');
    const m = /^home\s*=\s*(.+?)\s*$/m.exec(fs.readFileSync(cfg, 'utf8'));
    if (!m) return same;
    const real = path.join(m[1], path.basename(py));
    if (real.toLowerCase() === String(py).toLowerCase() || !fs.existsSync(real)) return same;
    return { exe: real, env: { __PYVENV_LAUNCHER__: py } };
  } catch {
    return same;
  }
}

module.exports = { pythonFor };
