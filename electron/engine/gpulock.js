'use strict';
// Shared GPU lock of the engine folder (same protocol as the engine's tool\gpulock.py, when it has one).
//
// One file, <engineRoot>\runtime\gpu.lock, a one-line UTF-8 JSON (no BOM):
//   {"qui": "Mia : Profondeur (Plan 12)", "minutes": 10, "debut": 1791223456.12, "depuis": "19:52", "app": "Mia", "pid": 1234}
// Every Claude session and script of the lab reads it before a heavy job, so Mia must speak it exactly:
// - a file that is not a JSON object still counts as taken (60 min, dated by its mtime);
// - abandoned (stale) once now - debut > 60 × (2 × minutes + 10) seconds;
// - take: when absent, stale, or already ours (same `qui`); otherwise wait and retry;
// - release: delete ONLY when `qui` is ours. Never touch another app's lock.
// This module holds no UI strings: it throws errors with a `code` and index.js words them.

const fs = require('node:fs');
const path = require('node:path');

/** "HH:MM" local time, like the Python side (`time.strftime("%H:%M")`). */
const hhmm = (s = Date.now() / 1000) => new Date(s * 1000).toTimeString().slice(0, 5);

/** True when a process with this pid exists (EPERM = it exists but belongs to someone else). */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Build a lock bound to a path (a string or a function, so a change of prefs.engineRoot is followed).
 * Tests pass a temporary path: the real lock is never written by them.
 * Every function takes an optional last argument `at`: the lock file to use instead of the current one. A job
 * captures file() when it takes the lock and passes it to renew/release, so a change of engineRoot during the
 * job never leaves the real lock behind.
 */
function createGpuLock({ lockPath, app = 'Mia', pid = process.pid } = {}) {
  const file = () => (typeof lockPath === 'function' ? lockPath() : lockPath);
  const pick = (at) => at || file();

  /** Current holder, or null when free. Unreadable content still means "taken" (protocol rule). */
  function readLock(at) {
    const f = pick(at);
    let txt;
    try {
      txt = fs.readFileSync(f, 'utf8');
    } catch {
      return null;
    }
    try {
      const j = JSON.parse(txt.replace(/^\uFEFF/, ''));
      if (j && typeof j === 'object' && !Array.isArray(j)) return j;
    } catch { /* not JSON: handled below */ }
    let mt = Date.now() / 1000;
    try { mt = fs.statSync(f).mtimeMs / 1000; } catch { /* keep now */ }
    return { qui: txt.trim().slice(0, 120) || 'autre session', minutes: 60, debut: mt, depuis: hhmm(mt) };
  }

  /** Abandoned lock: its owner forgot it (crash, killed terminal…). */
  const isStale = (i) => {
    const minutes = Number.isFinite(+i?.minutes) ? +i.minutes : 10;
    return Date.now() / 1000 - (+i?.debut || 0) > 60 * (2 * minutes + 10);
  };

  /** Our own lock, written by this very process. */
  const isMine = (i) => !!i && i.app === app && i.pid === pid;

  /**
   * Same `qui` and not written by another live process. A lock with our label but another pid belongs to a
   * previous Mia's quit helper (still waiting for ComfyUI to let go): it is not ours to take or delete.
   */
  const owns = (i, qui) => !!i && i.qui === qui && !(Number.isInteger(i.pid) && i.pid !== pid && pidAlive(i.pid));

  function body(qui, minutes) {
    return JSON.stringify({
      qui,
      minutes: Math.max(1, Math.round(+minutes || 10)),
      debut: Date.now() / 1000,
      depuis: hhmm(),
      app,
      pid
    });
  }

  // Mia never creates folders inside the lab: no runtime\ folder means a wrong engineRoot.
  function checkDir(at) {
    const dir = path.dirname(pick(at));
    if (!fs.existsSync(dir)) {
      const e = new Error(`lock folder missing: ${dir}`);
      e.code = 'ENOLOCKDIR';
      e.dir = dir;
      throw e;
    }
  }

  /**
   * Try once. → {ok:true} or {ok:false, info} when someone else holds a live lock.
   * Creation is atomic (O_EXCL), like the Node port suggested in engine.md; overwriting a stale lock is not
   * (neither is the Python side), which is acceptable for a cooperative lock polled every 15 s.
   */
  function take(qui, minutes, at, depth = 0) {
    const f = pick(at);
    checkDir(f);
    const info = readLock(f);
    if (info && !isStale(info) && !owns(info, qui)) return { ok: false, info };
    if (!info) {
      try {
        fs.writeFileSync(f, body(qui, minutes), { encoding: 'utf8', flag: 'wx' });
        return { ok: true, file: f };
      } catch (e) {
        if (e.code === 'EEXIST' && depth < 3) return take(qui, minutes, f, depth + 1);   // lost a race: re-read
        throw e;
      }
    }
    fs.writeFileSync(f, body(qui, minutes), 'utf8');   // stale, or already ours
    return { ok: true, file: f };
  }

  /**
   * Long jobs rewrite the lock every ~5 min with debut = now and the remaining estimate, otherwise other
   * sessions would consider it abandoned after 2 × minutes + 10. Never overwrites a live foreign lock.
   */
  function renew(qui, minutes, at, depth = 0) {
    const f = pick(at);
    const info = readLock(f);
    if (info && !owns(info, qui) && !isStale(info)) return { ok: false, info };
    try {
      if (!info) fs.writeFileSync(f, body(qui, minutes), { encoding: 'utf8', flag: 'wx' });   // someone removed ours
      else fs.writeFileSync(f, body(qui, minutes), 'utf8');
      return { ok: true };
    } catch (e) {
      if (e.code === 'EEXIST' && depth < 3) return renew(qui, minutes, f, depth + 1);
      return { ok: false, error: e };
    }
  }

  /** Delete the lock only if it is ours. Returns true when a file was removed. */
  function release(qui, at) {
    const f = pick(at);
    const info = readLock(f);
    if (!owns(info, qui)) return false;
    try {
      fs.rmSync(f, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Mia quits while ComfyUI still finishes one of its prompts: a small helper process keeps the lock until
   * ComfyUI confirms the cancel. The lock keeps its `qui` but now carries the helper's pid (and a fresh
   * `debut`), so other sessions keep waiting and the next Mia does not take it for an orphan.
   */
  function handOver(qui, newPid, at) {
    const f = pick(at);
    const info = readLock(f);
    if (!info || info.qui !== qui || !Number.isInteger(newPid)) return false;
    try {
      fs.writeFileSync(f, JSON.stringify({ ...info, debut: Date.now() / 1000, depuis: hhmm(), app, pid: newPid }), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * At startup: a lock written by Mia whose process is gone is an orphan of a crash — remove it.
   * A lock of any other app is left alone, even with a dead pid.
   */
  function cleanOrphan(at) {
    const f = pick(at);
    const info = readLock(f);
    if (!info || info.app !== app || !Number.isInteger(info.pid)) return false;
    if (info.pid === pid || pidAlive(info.pid)) return false;
    try {
      fs.rmSync(f, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  return { file, readLock, isStale, isMine, owns, take, renew, release, handOver, cleanOrphan };
}

module.exports = { createGpuLock, hhmm, pidAlive };
