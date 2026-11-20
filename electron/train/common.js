'use strict';
/**
 * Mia — what the training tool descriptors share (electron\train\ltx.js, aitk.js, fake.js).
 *
 * A descriptor tells the trainer service (electron\trainer.js) how one tool is found and started, and where it
 * leaves its checkpoints. It never starts anything itself and holds no state:
 *
 *   id, label                         'ltx' · 'ltx-trainer'
 *   gpu                               true when the tool really computes on the GPU (the fake one does not)
 *   detect({toolsDir, root})          → {ok, version, python, why:{code, path?, version?}|null}
 *   command({dir, run, token, resumeFrom, toolsDir, root, engineRoot}) → {exe, args, cwd, env}
 *   checkpoints(dir, doc)             → [{step, file, unit, sizeMB, at}] found on disk, ascending; `file` and `unit`
 *                                       are relative to the training folder; `unit` is what goes aside when the
 *                                       checkpoint is refused (a folder for LTX, a file for ai-toolkit)
 *   verify(dir, ck)                   → true when the checkpoint is complete (resume may start from it)
 *   cleanTmp(dir)                     → removes what an interrupted save left behind
 *
 * Every adapter is started the same way (protocol of the training folder, SPEC « Entraîner un LoRA ») :
 *   <adapter> --dir <training folder> --run <n> --token <t> [--resume <step>]
 */
const fs = require('node:fs');
const path = require('node:path');

const rel = (dir, abs) => path.relative(dir, abs).split(path.sep).join('/');

/**
 * A .safetensors file is complete when its size is 8 + header length + the end of the last tensor the header
 * declares: a file cut short by a crash keeps its header intact, so reading the header alone proves nothing.
 */
function safetensorsComplete(file) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    if (size < 10) return false;
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(8);
    if (fs.readSync(fd, head, 0, 8, 0) !== 8) return false;
    const n = Number(head.readBigUInt64LE(0));
    if (!Number.isFinite(n) || n < 2 || n > 100 * 1024 * 1024 || 8 + n > size) return false;
    const buf = Buffer.alloc(n);
    if (fs.readSync(fd, buf, 0, n, 8) !== n) return false;
    const j = JSON.parse(buf.toString('utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return false;
    let end = 0;
    let tensors = 0;
    for (const [k, v] of Object.entries(j)) {
      if (k === '__metadata__') continue;
      const o = v && v.data_offsets;
      if (!Array.isArray(o) || !(o[1] >= o[0]) || o[0] < 0) return false;
      end = Math.max(end, o[1]);
      tensors++;
    }
    return tensors > 0 && size === 8 + n + end;
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } }
  }
}

/** Version of a package installed in a venv, read from its dist-info folder name (no Python started). */
function distVersion(venv, pkg) {
  try {
    const sp = path.join(venv, 'Lib', 'site-packages');
    const re = new RegExp(`^${pkg.replace(/[-_.]+/g, '[-_.]+')}-(.+)\\.dist-info$`, 'i');
    for (const name of fs.readdirSync(sp)) {
      const m = re.exec(name);
      if (m) return m[1];
    }
  } catch { /* no venv */ }
  return null;
}

const venvPython = (toolsDir, venv) => path.join(toolsDir, venv, 'Scripts', 'python.exe');

/** What every Python adapter gets (Mia stays offline; nothing is ever uploaded). */
const PY_ENV = {
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
  PYTHONUNBUFFERED: '1',
  HF_HUB_OFFLINE: '1',
  TRANSFORMERS_OFFLINE: '1',
  WANDB_MODE: 'disabled'
};

const adapterArgs = ({ dir, run, token, resumeFrom }) => [
  '--dir', dir, '--run', String(run), '--token', String(token),
  ...(resumeFrom > 0 ? ['--resume', String(resumeFrom)] : [])
];

// ---------------------------------------------------------------- LTX layout (also the fake tool's)
//   out\checkpoints\step_NNNNN\weights.safetensors (+ state.pt, metadata.json: without them the tool restarts at 0)
//   out\checkpoints\.tmp_step_*   a save cut short
function ltxCheckpoints(dir) {
  const base = path.join(dir, 'out', 'checkpoints');
  const out = [];
  let names = [];
  try { names = fs.readdirSync(base); } catch { return out; }
  for (const name of names) {
    const m = /^step_(\d+)$/.exec(name);
    if (!m) continue;
    const file = path.join(base, name, 'weights.safetensors');
    let st = null;
    try { st = fs.statSync(file); } catch { st = null; }
    out.push({
      step: +m[1],
      file: rel(dir, file),
      unit: rel(dir, path.join(base, name)),
      sizeMB: st ? Math.round((st.size / 1048576) * 1000) / 1000 : 0,
      at: st ? Math.round(st.mtimeMs) : 0
    });
  }
  return out.sort((a, b) => a.step - b.step);
}

function ltxVerify(dir, ck) {
  const file = path.join(dir, ck.file);
  const d = path.dirname(file);
  return safetensorsComplete(file) && fs.existsSync(path.join(d, 'state.pt')) && fs.existsSync(path.join(d, 'metadata.json'));
}

function ltxCleanTmp(dir) {
  const base = path.join(dir, 'out', 'checkpoints');
  let n = 0;
  let names = [];
  try { names = fs.readdirSync(base); } catch { return 0; }
  for (const name of names) {
    if (!/^\.tmp_step_/.test(name)) continue;
    try { fs.rmSync(path.join(base, name), { recursive: true, force: true }); n++; } catch { /* in use: next time */ }
  }
  return n;
}

module.exports = { rel, safetensorsComplete, distVersion, venvPython, PY_ENV, adapterArgs, ltxCheckpoints, ltxVerify, ltxCleanTmp };
