'use strict';
// Runs Mia's Python worker with the lab's venv (SPEC §8.4, tech.md §7.1).
//
//   <engineRoot>\env\venv\Scripts\python.exe -B -u <Mia>\python\mia_worker.py <task> <outDir>\job.json
//
// - `python.exe`, not pythonw (no stdout there) + windowsHide: no console ever flashes.
// - -B: never write __pycache__ next to the lab's tool\*.py (Mia only reads the lab).
// - stdout protocol: lines starting with "@mia " carry JSON ({p,msg,eta} · {preview} · {done,outputs} · {error});
//   everything else (library prints, stderr, tracebacks) goes to the job log.
// - Cancel: write <outDir>\cancel (the worker checks it between frames), then after 3 s kill the whole tree —
//   child.kill() would leave the ffmpeg that Python spawned running.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const places = require('../places');

const STR = {
  fr: {
    noPython: 'Python du moteur introuvable : {path}',
    noEngine: places.noEngine('fr'),
    noWorker: 'Le module Python de Mia est absent : {path}',
    spawn: 'Impossible de lancer Python : {msg}',
    crashed: 'Le calcul Python s’est arrêté (code {code}) : {line}',
    crashedNoLine: 'Le calcul Python s’est arrêté (code {code}).',
    noResult: 'Le calcul Python s’est terminé sans résultat.',
    cancelled: 'Annulé'
  },
  en: {
    noPython: 'The engine’s Python was not found: {path}',
    noEngine: places.noEngine('en'),
    noWorker: 'Mia’s Python module is missing: {path}',
    spawn: 'Could not start Python: {msg}',
    crashed: 'The Python job stopped (code {code}): {line}',
    crashedNoLine: 'The Python job stopped (code {code}).',
    noResult: 'The Python job ended without a result.',
    cancelled: 'Cancelled'
  }
};

const CANCEL_GRACE_MS = 3000;
const fmt = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
const TASKKILL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');

function abortError(msg) {
  const e = new Error(msg);
  e.name = 'AbortError';
  e.cancelled = true;
  return e;
}

/** Kill a process and all its children (Python → ffmpeg, torch workers…). */
function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    try {
      const k = spawn(TASKKILL, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('exit', () => resolve());
      k.on('error', () => resolve());
    } catch {
      resolve();
    }
  });
}

/** Last stderr/stdout line worth showing to a human (the exception line of a traceback, typically). */
function meaningfulLine(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l || /^(\^|~|File "|Traceback|During handling)/.test(l)) continue;
    return l.slice(0, 300);
  }
  return '';
}

/**
 * @param {object} o
 * @param {() => object} [o.prefs]   current prefs (engineRoot, lang)
 * @param {string} [o.root]          Mia's root folder (python\mia_worker.py lives there)
 * @param {string} [o.python]        ctx.paths.python: either the interpreter (.exe) or Mia's python\ folder
 * @param {string} [o.worker]        explicit worker script (tests)
 */
function createPyRunner({ prefs, root, python, worker } = {}) {
  const getPrefs = typeof prefs === 'function' ? prefs : () => prefs || {};
  const live = new Set();
  const tr = (key, vars) => {
    const lang = getPrefs().lang === 'en' ? 'en' : 'fr';
    return fmt(STR[lang][key] ?? STR.fr[key], vars);
  };
  const engineRoot = () => places.engineRoot(getPrefs());

  /** Mia's engine venv, else the python_embeded of a ComfyUI portable chosen as the engine; null = no engine. */
  function exe() {
    if (python && /\.exe$/i.test(python)) return python;
    const r = engineRoot();
    if (!r) return null;
    const venv = path.join(r, 'env', 'venv', 'Scripts', 'python.exe');
    const portable = path.join(r, 'python_embeded', 'python.exe');
    return !fs.existsSync(venv) && fs.existsSync(portable) ? portable : venv;
  }

  function workerPath() {
    if (worker) return worker;
    if (python && !/\.exe$/i.test(python)) return path.join(python, 'mia_worker.py');
    return path.join(root || path.resolve(__dirname, '..', '..'), 'python', 'mia_worker.py');
  }

  /**
   * Run one task. → {outputs, ...extra} as reported by "@mia {done:true, outputs}".
   * opts: {cwd (= outDir, required), signal, onProgress(p|null, msg, eta_s), onPreview(abs), onLog(line)}
   */
  async function run(task, payload = {}, opts = {}) {
    const { cwd, signal, onProgress, onPreview } = opts;
    if (!cwd) throw new Error('pyrun: cwd (outDir) is required');
    if (signal && signal.aborted) throw abortError(tr('cancelled'));
    const py = exe();
    const script = workerPath();
    if (!py) throw new Error(tr('noEngine'));
    if (!fs.existsSync(py)) throw new Error(tr('noPython', { path: py }));
    if (!fs.existsSync(script)) throw new Error(tr('noWorker', { path: script }));

    await fsp.mkdir(cwd, { recursive: true });
    const cancelFile = path.join(cwd, 'cancel');
    await fsp.rm(cancelFile, { force: true });
    const jobFile = path.join(cwd, 'job.json');
    await fsp.writeFile(jobFile, JSON.stringify(payload ?? {}, null, 2), 'utf8');

    // Without onLog, the lines still land in <outDir>\log.txt (the file run.json points to).
    const logFile = path.join(cwd, 'log.txt');
    const onLog = typeof opts.onLog === 'function'
      ? opts.onLog
      : (line) => { try { fs.appendFileSync(logFile, line + '\n'); } catch { /* log is best effort */ } };

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(py, ['-B', '-u', script, String(task), jobFile], {
          cwd,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PYTHONUTF8: '1',
            PYTHONIOENCODING: 'utf-8',
            PYTHONUNBUFFERED: '1',
            HF_HUB_OFFLINE: '1',             // Mia stays offline: never a silent model download
            TRANSFORMERS_OFFLINE: '1',
            PYTHONPATH: engineRoot()          // `import tool.xxx` from the engine (read-only), after python\vendor
          }
        });
      } catch (e) {
        reject(new Error(tr('spawn', { msg: e.message })));
        return;
      }
      live.add(child);
      child.stdin.on('error', () => {});      // the worker may exit before we write "cancel"

      let result = null;
      let reported = null;
      let cancelled = false;
      let killTimer = null;
      const tail = [];
      const keep = (line) => { tail.push(line); if (tail.length > 40) tail.shift(); };

      const handleMia = (m) => {
        if (!m || typeof m !== 'object') return;
        if (m.error != null) { reported = String(m.error); return; }
        if (m.done) {
          const { done, outputs, ...extra } = m;
          result = { ...extra, outputs: outputs || {} };
          return;
        }
        if (m.preview && typeof onPreview === 'function') {
          onPreview(path.isAbsolute(m.preview) ? m.preview : path.resolve(cwd, m.preview));
        }
        if (m.log != null) onLog(String(m.log));
        if (typeof onProgress === 'function') {
          if ('p' in m || m.msg != null || m.eta != null) {
            const p = m.p == null ? null : Math.max(0, Math.min(1, +m.p));
            onProgress(Number.isFinite(p) ? p : null, m.msg ?? undefined, m.eta ?? undefined);
          } else if (m.type === 'progress') {          // tech.md §7.1 flavour, accepted too
            onProgress(m.value == null ? null : +m.value, m.label ?? undefined, m.eta ?? undefined);
          }
        }
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
        if (line.startsWith('@mia ')) {
          try { handleMia(JSON.parse(line.slice(5))); return; } catch { /* not ours after all: log it */ }
        }
        onLog(line);
        keep(line);
      });
      readline.createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (line) => {
        onLog(line);
        keep(line);
      });

      const onAbort = () => {
        if (cancelled) return;
        cancelled = true;
        try { fs.writeFileSync(cancelFile, String(Date.now())); } catch { /* the kill below still works */ }
        try { child.stdin.write('cancel\n'); } catch { /* closed */ }
        killTimer = setTimeout(() => killTree(child.pid), CANCEL_GRACE_MS);
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      let spawnError = null;
      child.on('error', (e) => { spawnError = e; });
      child.on('close', (code) => {
        clearTimeout(killTimer);
        live.delete(child);
        if (signal) signal.removeEventListener('abort', onAbort);
        fs.rm(cancelFile, { force: true }, () => {});
        if (spawnError && code == null) return reject(new Error(tr('spawn', { msg: spawnError.message })));
        if (cancelled) return reject(abortError(tr('cancelled')));
        if (reported) return reject(new Error(reported));
        if (result) {
          // Relative paths are relative to the job folder.
          for (const [k, o] of Object.entries(result.outputs)) {
            if (typeof o === 'string') result.outputs[k] = { abs: path.resolve(cwd, o) };
            else if (o && o.abs && !path.isAbsolute(o.abs)) o.abs = path.resolve(cwd, o.abs);
          }
          return resolve(result);
        }
        if (code === 0) return reject(new Error(tr('noResult')));
        const line = meaningfulLine(tail);
        reject(new Error(line ? tr('crashed', { code, line }) : tr('crashedNoLine', { code })));
      });
    });
  }

  /** App quitting: no Python job may outlive Mia (it would keep the GPU without its lock). */
  function killAllSync() {
    for (const c of live) {
      try { spawnSync(TASKKILL, ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true, timeout: 4000 }); } catch { /* gone */ }
    }
    live.clear();
  }

  return { run, killAllSync, exe, workerPath, running: () => live.size };
}

module.exports = { createPyRunner, killTree };
