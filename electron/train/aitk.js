'use strict';
/**
 * Mia — training tool descriptor: ostris' ai-toolkit (Qwen-Image, Flux), see electron\train\common.js.
 *
 *   <toolsDir>\venv-aitk            the tool's Python
 *   <toolsDir>\src\ai-toolkit       its sources (run.py; the tool must be started from this folder)
 *   <Mia>\python\train\mia_train_aitk.py   Mia's adapter: starts run.py and reads the tool's own SQLite files
 *
 * Checkpoints: out\<slug>\<slug>_<step on 9 digits>.safetensors, then out\<slug>\<slug>.safetensors at the end
 * (written in place, without a temporary file: a file is only trusted once it is complete).
 */
const fs = require('node:fs');
const path = require('node:path');
const { pythonFor } = require('../engine/pyexe');
const C = require('./common');

const VENV = 'venv-aitk';
const sources = (toolsDir) => path.join(toolsDir, 'src', 'ai-toolkit');
const adapter = (root) => path.join(root, 'python', 'train', 'mia_train_aitk.py');

function detect({ toolsDir, root }) {
  const python = C.venvPython(toolsDir, VENV);
  if (!fs.existsSync(python)) return { ok: false, version: null, python, why: { code: 'tool', path: path.join(toolsDir, VENV) } };
  const src = sources(toolsDir);
  if (!fs.existsSync(path.join(src, 'run.py'))) return { ok: false, version: null, python, why: { code: 'tool', path: src } };
  const a = adapter(root);
  if (!fs.existsSync(a)) return { ok: false, version: null, python, why: { code: 'tool', path: a } };
  return { ok: true, version: null, python, why: null };
}

function command({ dir, run, token, resumeFrom, toolsDir, root, engineRoot }) {
  const real = pythonFor(C.venvPython(toolsDir, VENV));
  return {
    exe: real.exe,
    args: ['-B', '-u', adapter(root), ...C.adapterArgs({ dir, run, token, resumeFrom })],
    cwd: sources(toolsDir),                               // run.py does sys.path.insert(0, os.getcwd())
    env: {
      ...real.env,
      ...C.PY_ENV,
      MIA_TRAIN_PYTHON: real.exe,
      MIA_TRAIN_TOOLS: toolsDir,
      MODELS_PATH: engineRoot ? path.join(engineRoot, 'models') : '',
      HF_HOME: path.join(toolsDir, 'hf')                  // nothing in the user profile
    }
  };
}

function checkpoints(dir, doc) {
  const slug = (doc && doc.slug) || '';
  const base = path.join(dir, 'out', slug);
  const out = [];
  let names = [];
  try { names = fs.readdirSync(base); } catch { return out; }
  const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stepped = new RegExp(`^${esc}_(\\d{9})\\.safetensors$`);
  for (const name of names) {
    const m = stepped.exec(name);
    const final = name === `${slug}.safetensors`;
    if (!m && !final) continue;
    const file = path.join(base, name);
    let st = null;
    try { st = fs.statSync(file); } catch { continue; }
    out.push({
      step: m ? +m[1] : (doc && doc.steps) || 0,
      file: C.rel(dir, file),
      unit: C.rel(dir, file),
      sizeMB: Math.round((st.size / 1048576) * 1000) / 1000,
      at: Math.round(st.mtimeMs)
    });
  }
  return out.sort((a, b) => a.step - b.step);
}

module.exports = {
  id: 'aitk',
  label: 'ai-toolkit',
  gpu: true,
  detect,
  command,
  checkpoints,
  verify: (dir, ck) => C.safetensorsComplete(path.join(dir, ck.file)),
  cleanTmp: () => 0
};
