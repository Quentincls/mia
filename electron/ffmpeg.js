'use strict';
/**
 * Mia — ffmpeg helpers (SPEC §8.5), shared by the media import and the engine.
 *
 * ffmpeg is found at run time and NEVER copied (Smart App Control trusts the binary its installer
 * laid down, not a copy dropped by another program), in this order: MIA_FFMPEG, the one imageio-ffmpeg
 * ships in the engine's venv (the file name carries its version), the one of a ComfyUI portable chosen
 * as the engine (python_embeded), then any ffmpeg.exe on PATH (winget, Chocolatey, a hand install).
 * There may be no ffprobe, so probing parses the stderr of `ffmpeg -i` (tech.md §6.6, ~150 ms per file).
 *
 *   ffmpegPath()                                  → absolute path or null
 *   probe(abs, {exactFrames:true})                → {kind, w, h, fps, frames, framesExact, duration, codec, pixfmt, alpha, hasAudio, playable, rotate}
 *                                                   (a sound file: kind 'audio', w = h = 0, + sampleRate, channels)
 *   countFrames(abs)                              → exact frame count of a video (packets, no decode) or null
 *   run(args, {duration, onProgress, signal})     → {code, stderr}
 *   poster(src, dst, {at:0, width:640})           → dst
 *   previewImage(src, dst, {maxSide:2048})        → dst   (tif/exr/psd… that Chromium cannot show)
 *   waveform(src, dst, {width:1200, height:160})  → dst   (PNG of a sound's waveform, white on transparent)
 *   proxy(src, dst, {maxSide:1920, gop:12})       → {path, encoder, w, h}
 *   nvenc()                                       → Promise<bool>, tested once, lazily
 *   encodeArgs({quality:'hq'|'phone', fps})       → Mia's standard encoder arguments
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const BIN_REL = ['env', 'venv', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries'];
const BIN_REL_PORTABLE = ['python_embeded', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries'];

// What Mia accepts as a still image / a video. GIF stays an image: Chromium animates it in an <img>.
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.avif', '.tif', '.tiff', '.exr', '.psd', '.hdr', '.dpx', '.tga']);
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mxf', '.wmv', '.flv', '.mpg', '.mpeg', '.ts', '.m2ts', '.mts', '.ogv', '.3gp']);
// Sounds (the Son block): what an <audio> in Chromium plays as is.
const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus']);
// What an <img> in Chromium can show as is (measured, tech.md §2.3): the rest gets a PNG preview.
const BROWSER_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.avif']);
// What a <video> in Electron 38 plays (measured, tech.md §2.3/§6.1). canPlayType lies about .mov/.mkv.
const PLAYABLE_CODECS = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1']);
const PLAYABLE_CONTAINERS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm']);

const STR = {
  missing: {
    fr: 'ffmpeg est introuvable : configure le moteur de Mia (Modèles › Configurer le moteur…) ou installe ffmpeg sur ce PC (winget install ffmpeg).',
    en: 'ffmpeg cannot be found: set up Mia’s engine (Models › Set up the engine…) or install ffmpeg on this PC (winget install ffmpeg).'
  },
  launch: { fr: 'Impossible de lancer ffmpeg : {msg}', en: 'Could not start ffmpeg: {msg}' },
  unreadable: { fr: 'Ce fichier n’est pas lisible comme image ou vidéo.', en: 'This file cannot be read as an image or a video.' },
  noVideo: { fr: 'Ce fichier ne contient ni image ni vidéo.', en: 'This file holds no image or video.' },
  posterFailed: { fr: 'Impossible d’extraire une image de « {name} ».', en: 'Could not extract a frame from “{name}”.' },
  previewFailed: { fr: 'Impossible de créer l’aperçu de « {name} ».', en: 'Could not create the preview of “{name}”.' },
  waveFailed: { fr: 'Impossible de dessiner la forme d’onde de « {name} ».', en: 'Could not draw the waveform of “{name}”.' },
  proxyFailed: { fr: 'La copie de lecture de « {name} » a échoué : {msg}', en: 'The playback copy of “{name}” failed: {msg}' },
  cancelled: { fr: 'Annulé.', en: 'Cancelled.' },
  timeout: { fr: 'ffmpeg ne répond plus (délai dépassé).', en: 'ffmpeg stopped responding (timeout).' }
};

// ---------------------------------------------------------------- configuration
const cfg = {
  engineRoot: () => '',
  lang: () => 'fr',
  log: () => {}
};

/** main.js wires the prefs in: configure({ engineRoot: () => prefs.engineRoot, lang, log }). */
function configure(o = {}) {
  if (typeof o.engineRoot === 'function') cfg.engineRoot = o.engineRoot;
  if (typeof o.lang === 'function') cfg.lang = o.lang;
  if (typeof o.log === 'function') cfg.log = o.log;
}

function tr(obj, vars) {
  const s = obj[cfg.lang() === 'en' ? 'en' : 'fr'] || obj.fr;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '')) : s;
}

function userError(msg, extra) {
  return Object.assign(new Error(msg), { userMessage: msg }, extra || {});
}

// ---------------------------------------------------------------- locating ffmpeg
let found = { root: null, exe: null };

function binariesIn(root, rel = BIN_REL) {
  if (!root) return [];
  const dir = path.join(root, ...rel);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^ffmpeg-.*\.exe$/i.test(n));
  } catch {
    return [];
  }
  // several versions side by side after an update: the highest one wins
  names.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  return names.map((n) => path.join(dir, n));
}

/** ffmpeg.exe in a folder of PATH (what `where ffmpeg` answers), or null. */
function onPath() {
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter)
    .map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
  for (const d of dirs) {
    if (!path.isAbsolute(d)) continue;          // never a relative folder (the current dir of whoever started Mia)
    const exe = path.join(d, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    try { if (fs.statSync(exe).isFile()) return exe; } catch { /* not there */ }
  }
  return null;
}

/** Absolute path of ffmpeg, or null. Cached per engine root; re-resolved if the file vanished. */
function ffmpegPath() {
  const root = cfg.engineRoot() || '';
  if (found.root === root && found.exe && fs.existsSync(found.exe)) return found.exe;
  if (found.root === root && !found.exe && Date.now() - (found.at || 0) < 5000) return null;   // looked just now
  let exe = null;
  if (process.env.MIA_FFMPEG && fs.existsSync(process.env.MIA_FFMPEG)) exe = process.env.MIA_FFMPEG;
  if (!exe) exe = binariesIn(root)[0] || binariesIn(root, BIN_REL_PORTABLE)[0] || null;
  if (!exe && process.env.MIA_FFMPEG_NO_PATH !== '1') exe = onPath();     // MIA_FFMPEG_NO_PATH=1: tests
  found = { root, exe, at: Date.now() };
  if (exe) cfg.log('ffmpeg:', exe);
  return exe;
}

function requireExe() {
  const exe = ffmpegPath();
  if (!exe) throw userError(tr(STR.missing));
  return exe;
}

// ---------------------------------------------------------------- running
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Spawn ffmpeg (hidden window, arguments as an array: accents and spaces need no quoting).
 * Resolves {code, stderr} whatever the exit code — the caller decides what a failure means.
 * Rejects only when ffmpeg cannot start, on abort (err.name === 'AbortError') or on timeout.
 * @param {string[]} args
 * @param {object} [o] { duration (s, for the progress ratio), onProgress(p 0..1|null), signal,
 *                       cwd, lowPriority, timeoutMs }
 */
function run(args, o = {}) {
  return new Promise((resolve, reject) => {
    let exe;
    try {
      exe = requireExe();
    } catch (e) {
      reject(e);
      return;
    }
    if (o.signal && o.signal.aborted) {
      reject(userError(tr(STR.cancelled), { name: 'AbortError' }));
      return;
    }
    const full = [];
    if (!args.includes('-hide_banner')) full.push('-hide_banner');
    if (!args.includes('-nostdin')) full.push('-nostdin');
    if (o.onProgress && !args.includes('-progress')) full.push('-progress', 'pipe:1', '-nostats');
    full.push(...args.map(String));

    let child;
    try {
      child = spawn(exe, full, { windowsHide: true, cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(userError(tr(STR.launch, { msg: e.message })));
      return;
    }
    if (o.lowPriority && child.pid) {
      // proxies and posters must never slow the board (nor a GPU job) down
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
    }

    let stderr = '';
    const MAX_ERR = 256 * 1024;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (s) => {
      stderr += s;
      if (stderr.length > MAX_ERR) stderr = stderr.slice(-MAX_ERR);   // keep the end: that is where errors are
    });

    // -progress pipe:1 → "key=value" lines; out_time_us is the position in the output
    let outBuf = '';
    let lastEmit = 0;
    const durUs = Number(o.duration) > 0 ? Number(o.duration) * 1e6 : 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (s) => {
      if (!o.onProgress) return;
      outBuf += s;
      let i;
      while ((i = outBuf.indexOf('\n')) >= 0) {
        const line = outBuf.slice(0, i).trim();
        outBuf = outBuf.slice(i + 1);
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const k = line.slice(0, eq);
        const v = line.slice(eq + 1);
        if (k === 'progress' && v === 'end') {
          safeCall(o.onProgress, 1);
        } else if (k === 'out_time_us' || k === 'out_time_ms') {   // both are microseconds (historic quirk)
          const now = Date.now();
          if (now - lastEmit < 100) continue;
          lastEmit = now;
          const us = Number(v);
          safeCall(o.onProgress, durUs && us >= 0 ? Math.max(0, Math.min(0.999, us / durUs)) : null);
        }
      }
    });

    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (o.signal) o.signal.removeEventListener('abort', onAbort);
      fn(val);
    };
    const kill = () => {
      try { child.kill(); } catch { /* already gone */ }
    };
    const onAbort = () => {
      kill();
      finish(reject, userError(tr(STR.cancelled), { name: 'AbortError' }));
    };
    if (o.signal) o.signal.addEventListener('abort', onAbort, { once: true });
    const timer = o.timeoutMs
      ? setTimeout(() => { kill(); finish(reject, userError(tr(STR.timeout), { name: 'TimeoutError', stderr })); }, o.timeoutMs)
      : null;

    child.on('error', (e) => finish(reject, userError(tr(STR.launch, { msg: e.message }))));
    child.on('close', (code) => finish(resolve, { code: code == null ? -1 : code, stderr }));
  });
}

function safeCall(fn, v) {
  try { fn(v); } catch { /* a progress callback must never break the encode */ }
}

/** The last meaningful stderr line, for an error message. */
function lastError(stderr) {
  const lines = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bad = lines.filter((l) => /error|invalid|failed|cannot|unable|not supported|no such/i.test(l));
  return (bad[bad.length - 1] || lines[lines.length - 1] || '').slice(0, 300);
}

// ---------------------------------------------------------------- probing
/** Split "a (x, y), b, c" on the commas that are not inside () or []. */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const num = (v, k) => (v == null ? null : parseFloat(v) * (k ? 1000 : 1));

const ALPHA_PIXFMT = /^(rgba|bgra|argb|abgr|yuva|gbrap|ya8|ya16|rgba64|bgra64)/;

/** Does Chromium play this, as is, in a <video> / <img>? (tech.md §2.3, measured) */
function isPlayable(kind, ext, codec, pixfmt) {
  if (kind === 'image') return BROWSER_IMAGE_EXT.has(ext);
  if (!PLAYABLE_CODECS.has(codec) || !PLAYABLE_CONTAINERS.has(ext)) return false;
  if (ext === '.webm' && !['vp8', 'vp9', 'av1'].includes(codec)) return false;
  // HEVC 4:2:2 has no hardware decode path in Chromium on Windows: it would show nothing
  if (codec === 'hevc' && pixfmt && /^yuv4(22|40)/.test(pixfmt)) return false;
  return true;
}

/**
 * Parse the stderr of `ffmpeg -i <file>` (exported for tests).
 * Frame count: exact when the container says so (NUMBER_OF_FRAMES in MKV), else duration × fps.
 */
function parseProbe(stderr, abs) {
  const ext = path.extname(abs || '').toLowerCase();
  const text = String(stderr || '');
  const fmt = (/Input #0, (.+?), from '/.exec(text) || [])[1] || '';

  // first real video stream (an MP4 cover is a "Video: mjpeg … (attached pic)": skip it)
  const streams = [...text.matchAll(/^\s*Stream #0:(\d+)[^:\n]*: Video: (.+)$/gm)];
  const real = streams.find((m) => !/attached pic/.test(m[2]));
  // a sound: no picture at all, or only a cover (an mp3 with its album art)
  if (!real && (AUDIO_EXT.has(ext) || !streams.length)) return parseAudio(text, ext);
  const vs = real || streams[0];
  if (!vs) return null;

  const tokens = splitTop(vs[2]);
  const codec = ((tokens[0] || '').match(/^[\w-]+/) || [''])[0].toLowerCase() || null;
  let pixfmt = null;
  if (tokens[1] && !/^\d+x\d+/.test(tokens[1])) pixfmt = ((tokens[1].match(/^[\w]+/) || [])[0] || null);
  let w = 0;
  let h = 0;
  let fps = null;
  let tbr = null;
  for (const t of tokens) {
    const sz = /^(\d+)x(\d+)/.exec(t);
    if (sz && !w) { w = +sz[1]; h = +sz[2]; }
    const f = /^([\d.]+)(k?) fps$/.exec(t);
    if (f) fps = num(f[1], f[2]);
    const r = /^([\d.]+)(k?) tbr$/.exec(t);
    if (r) tbr = num(r[1], r[2]);
  }
  if (!fps) fps = tbr;

  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  let duration = d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : null;

  const isImage = IMAGE_EXT.has(ext) || (!VIDEO_EXT.has(ext) && (/_pipe\b/.test(fmt) || /\bimage2\b/.test(fmt)) && !duration);
  const kind = isImage ? 'image' : 'video';

  // metadata block of the video stream: from its line to the next "Stream #"
  const after = text.slice(vs.index + vs[0].length);
  const block = after.split(/^\s*Stream #/m)[0];
  let frames = null;
  const nf = /NUMBER_OF_FRAMES\s*:\s*(\d+)/.exec(block);
  if (kind === 'image') {
    frames = 1;
    fps = null;
    duration = null;
  } else if (nf) {
    frames = +nf[1];
  } else if (duration && fps) {
    frames = Math.max(1, Math.round(duration * fps));
  }

  // phone clips: the pixels are stored sideways and rotated on display
  let rotate = 0;
  const rm = /displaymatrix: rotation of (-?[\d.]+) degrees/.exec(block) || /rotate\s*:\s*(-?\d+)/.exec(block);
  if (rm) rotate = Math.round(parseFloat(rm[1])) % 360;
  if (Math.abs(rotate) === 90 || Math.abs(rotate) === 270) [w, h] = [h, w];

  const alpha = !!(pixfmt && ALPHA_PIXFMT.test(pixfmt)) || /alpha_mode\s*:\s*1/.test(block);
  const hasAudio = /^\s*Stream #0:\d+[^:\n]*: Audio: /m.test(text);

  return {
    kind,
    w,
    h,
    fps: fps ? Math.round(fps * 1000) / 1000 : null,
    frames,
    framesExact: kind === 'image' || !!nf,
    duration: duration != null ? Math.round(duration * 1000) / 1000 : null,
    codec,
    pixfmt,
    alpha,
    hasAudio,
    playable: isPlayable(kind, ext, codec, pixfmt),
    rotate
  };
}

/** A sound file (no picture): duration, codec, sample rate, channels. null when there is no audio either. */
function parseAudio(text, ext) {
  const as = /^\s*Stream #0:\d+[^:\n]*: Audio: (.+)$/m.exec(text);
  if (!as) return null;
  const tokens = splitTop(as[1]);
  const codec = ((tokens[0] || '').match(/^[\w-]+/) || [''])[0].toLowerCase() || null;
  let sampleRate = null;
  let channels = null;
  for (const t of tokens) {
    const hz = /^(\d+) Hz$/.exec(t);
    if (hz) sampleRate = +hz[1];
    else if (channels == null && /^(mono|stereo|\d+(\.\d+)*(\(\w+\))?|\d+ channels)$/.test(t)) {
      channels = t === 'mono' ? 1 : t === 'stereo' ? 2
        : t.replace(/\(.*\)$/, '').split('.').reduce((a, b) => a + (parseInt(b, 10) || 0), 0) || null;
    }
  }
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const duration = d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : null;
  // a WAV is played by Chromium when it holds PCM; ADPCM and other oddities only go through ffmpeg
  const playable = AUDIO_EXT.has(ext) && !(ext === '.wav' && codec && !/^pcm_/.test(codec));
  return {
    kind: 'audio', w: 0, h: 0, fps: null, frames: null, framesExact: true,
    duration: duration != null ? Math.round(duration * 1000) / 1000 : null,
    codec, pixfmt: null, alpha: false, hasAudio: true, playable, rotate: 0, sampleRate, channels
  };
}

/**
 * The exact number of frames of a video: its video packets copied to nowhere, nothing decoded
 * (~0.1 s for a short clip, I/O-bound for a long one). The same count as the engine's exports,
 * so « IMG 120 / 121 » and the f0120 file names agree. null when it cannot be counted.
 */
async function countFrames(abs, o = {}) {
  try {
    const r = await run(['-i', abs, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-'], { timeoutMs: o.timeoutMs || 30000, signal: o.signal, lowPriority: true });
    if (r.code !== 0) return null;
    const all = [...String(r.stderr).matchAll(/frame=\s*(\d+)/g)];
    const n = all.length ? parseInt(all[all.length - 1][1], 10) : 0;
    return n > 0 ? n : null;
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    return null;
  }
}

/**
 * Probe a file. Throws a readable error when ffmpeg finds no picture in it.
 * Videos get their exact frame count (countFrames) unless the container states it or
 * `o.exactFrames === false`; when counting fails, the estimate (duration × fps) stays.
 */
async function probe(abs, o = {}) {
  const { stderr } = await run(['-i', abs], { timeoutMs: o.timeoutMs || 30000, signal: o.signal });
  const info = parseProbe(stderr, abs);
  if (!info) {
    const noFile = /No such file|does not exist/i.test(stderr);
    const audioOnly = /: Audio: /.test(stderr);
    throw userError(noFile ? tr(STR.unreadable) : audioOnly ? tr(STR.noVideo) : tr(STR.unreadable), { stderr });
  }
  // (a huge rush — 8 GB and more — keeps the estimate: reading it all would hold the import for minutes)
  const size = (() => { try { return fs.statSync(abs).size; } catch { return 0; } })();
  if (info.kind === 'video' && !info.framesExact && o.exactFrames !== false && size < 8 * 1024 ** 3) {
    const n = await countFrames(abs, { signal: o.signal, timeoutMs: o.countTimeoutMs || 60000 });
    if (n) {
      info.frames = n;
      info.framesExact = true;
    }
  }
  return info;
}

// ---------------------------------------------------------------- stills
/** Input options a decoder needs before -i (EXR beauty passes are linear: show them in sRGB). */
function inputOpts(src) {
  return path.extname(src).toLowerCase() === '.exr' ? ['-apply_trc', 'iec61966_2_1'] : [];
}

/** Encoder options chosen from the output extension. */
function stillCodec(dst) {
  const ext = path.extname(dst).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return ['-q:v', '3'];
  if (ext === '.webp') return ['-c:v', 'libwebp', '-quality', '82'];
  return [];   // png
}

/** "x.poster.jpg" → "x.poster.part-1a2b.jpg": written beside, renamed over (never a half file on screen). */
function partName(dst) {
  const ext = path.extname(dst);
  return dst.slice(0, dst.length - ext.length) + `.part-${process.pid}-${Date.now().toString(36)}${ext}`;
}

async function renameOver(from, to) {
  for (let i = 0; ; i++) {
    try {
      return await fsp.rename(from, to);
    } catch (e) {
      if (i >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      await sleep(40 * (i + 1));
    }
  }
}

async function still(src, dst, at, vf, o, failMsg) {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  const tmp = partName(dst);
  const attempt = async (seek) => {
    const args = ['-y'];
    if (seek > 0) args.push('-ss', String(seek));
    args.push(...inputOpts(src), '-i', src, '-map', '0:v:0', '-frames:v', '1', '-an', '-vf', vf, ...stillCodec(dst), '-update', '1', tmp);
    const r = await run(args, { signal: o.signal, lowPriority: true, timeoutMs: o.timeoutMs || 60000 });
    const ok = r.code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 0;
    return { ok, stderr: r.stderr };
  };
  let r = await attempt(at);
  if (!r.ok && at > 0) r = await attempt(0);   // asked past the end: the first frame is better than nothing
  if (!r.ok) {
    fsp.rm(tmp, { force: true }).catch(() => {});
    throw userError(failMsg, { stderr: r.stderr });
  }
  await renameOver(tmp, dst);
  return dst;
}

/**
 * One frame as a picture (jpg/png/webp from the extension of dst), `width` px wide at most —
 * never enlarged. `at` in seconds.
 */
function poster(src, dst, o = {}) {
  const width = Math.max(16, Math.round(o.width || 640));
  const at = Math.max(0, Number(o.at) || 0);
  const vf = `scale=w='min(iw,${width})':h=-2:flags=bicubic`;
  return still(src, dst, at, vf, o, tr(STR.posterFailed, { name: path.basename(src) }));
}

/** A PNG Chromium can show for an image it cannot (tif, exr, psd…), longest side ≤ maxSide. */
function previewImage(src, dst, o = {}) {
  const m = Math.max(16, Math.round(o.maxSide || 2048));
  const vf = `scale=w='if(gte(iw,ih),min(iw,${m}),-2)':h='if(gte(iw,ih),-2,min(ih,${m}))':flags=bicubic`;
  return still(src, dst, 0, vf, o, tr(STR.previewFailed, { name: path.basename(src) }));
}

/**
 * The waveform of a sound as a PNG: white on transparent (the interface colours it through a CSS mask),
 * mono mix, square-root scale so the quiet passages still show.
 */
async function waveform(src, dst, o = {}) {
  const w = Math.max(64, Math.round(o.width || 1200));
  const h = Math.max(16, Math.round(o.height || 160));
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  const tmp = partName(dst);
  const args = ['-y', '-i', src, '-filter_complex',
    `[0:a:0]aformat=channel_layouts=mono,showwavespic=s=${w}x${h}:colors=white:scale=sqrt:draw=full`,
    '-frames:v', '1', '-update', '1', tmp];
  const r = await run(args, { signal: o.signal, lowPriority: true, timeoutMs: o.timeoutMs || 60000 });
  if (r.code !== 0 || !fs.existsSync(tmp) || !fs.statSync(tmp).size) {
    fsp.rm(tmp, { force: true }).catch(() => {});
    throw userError(tr(STR.waveFailed, { name: path.basename(src) }), { stderr: r.stderr });
  }
  await renameOver(tmp, dst);
  return dst;
}

// ---------------------------------------------------------------- NVENC
let nvencPromise = null;
let nvencValue = null;   // null = not tested yet

/**
 * Can this machine encode with NVENC? Tested once, lazily — only when a proxy is first needed —
 * with a 0.1 s black clip encoded to nowhere. MIA_NO_NVENC=1 forces the CPU path (tests).
 */
function nvenc() {
  if (process.env.MIA_NO_NVENC === '1') {
    nvencValue = false;
    return Promise.resolve(false);
  }
  if (!nvencPromise) {
    nvencPromise = run(['-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1', '-c:v', 'h264_nvenc', '-f', 'null', '-'], { timeoutMs: 20000 })
      .then((r) => r.code === 0)
      .catch(() => false)
      .then((ok) => {
        nvencValue = ok;
        cfg.log('nvenc:', ok ? 'available' : 'unavailable (CPU encoding)');
        return ok;
      });
  }
  return nvencPromise;
}
nvenc.known = () => nvencValue;

function markNvencBroken() {
  nvencValue = false;
  nvencPromise = Promise.resolve(false);
}

// ---------------------------------------------------------------- encoding
const even = (v) => Math.max(2, Math.round(v / 2) * 2);

/** Fit w×h inside maxSide (never enlarge), even dimensions for H.264. */
function fitSize(w, h, maxSide) {
  if (!w || !h) return { W: 0, H: 0 };
  const k = Math.min(1, maxSide / Math.max(w, h));
  return { W: even(w * k), H: even(h * k) };
}

/**
 * Mia's standard encoder arguments (video only + AAC audio), NVENC unless it is known broken.
 *   hq    : h264_nvenc -preset p7 -tune hq -rc vbr -cq 16
 *   phone : a bitrate aimed at < 30 MB for `duration` seconds; NVENC two-pass (`-multipass fullres`)
 *           in a single run, libx264 single pass with the same bitrate cap as fallback.
 * @param {object} o { quality, fps, duration, audio:true }
 */
function encodeArgs(o = {}) {
  const gpu = nvencValue !== false;
  const quality = o.quality === 'phone' ? 'phone' : 'hq';
  const a = [];
  if (quality === 'phone') {
    const seconds = Number(o.duration) > 0 ? Number(o.duration) : 20;
    const budgetKbit = 30e6 * 8 * 0.92 / 1000;                // 30 MB, 8 % kept for the container
    const audioK = o.audio === false ? 0 : 128;
    const v = Math.round(Math.min(20000, Math.max(600, budgetKbit / seconds - audioK)));
    if (gpu) a.push('-c:v', 'h264_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-multipass', 'fullres');
    else a.push('-c:v', 'libx264', '-preset', 'slow');
    a.push('-b:v', `${v}k`, '-maxrate', `${Math.round(v * 1.4)}k`, '-bufsize', `${v * 2}k`);
  } else if (gpu) {
    a.push('-c:v', 'h264_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', '16', '-b:v', '0');
  } else {
    a.push('-c:v', 'libx264', '-preset', 'slow', '-crf', '16');
  }
  a.push('-pix_fmt', 'yuv420p', '-profile:v', 'high');
  if (o.fps) a.push('-r', String(o.fps));
  if (o.audio === false) a.push('-an');
  else a.push('-c:a', 'aac', '-b:a', quality === 'phone' ? '128k' : '192k');
  a.push('-movflags', '+faststart');
  return a;
}

/**
 * A board copy of a video Chromium cannot play (or scrub): H.264, long side ≤ maxSide,
 * GOP 12 without B-frames (a frame-exact seek decodes at most 12 frames), constant rate,
 * timestamps from 0, faststart. NVENC first, libx264 if NVENC is missing or fails.
 * The original is never touched: the proxy only serves the display.
 * @param {object} o { maxSide:1920, gop:12, meta (a probe() result, saves a probe),
 *                     onProgress, signal, encoder:'nvenc'|'x264' (force) }
 */
async function proxy(src, dst, o = {}) {
  const info = o.meta && o.meta.w ? o.meta : await probe(src, { signal: o.signal });
  const { W, H } = fitSize(info.w, info.h, o.maxSide || 1920);
  const gop = String(Math.max(1, Math.round(o.gop || 12)));
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  const tmp = partName(dst);

  const scale = W && H ? `scale=${W}:${H}:flags=lanczos,format=yuv420p` : 'format=yuv420p';
  const base = (codec) => [
    '-y', ...inputOpts(src), '-i', src,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', scale,
    ...codec,
    '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-g', gop, '-bf', '0',
    '-fps_mode', 'cfr', '-avoid_negative_ts', 'make_zero',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    tmp
  ];
  const NV = ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '22', '-b:v', '0'];
  const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'];

  let useGpu = o.encoder ? o.encoder === 'nvenc' : await nvenc();
  const runOpts = { duration: info.duration, onProgress: o.onProgress, signal: o.signal, lowPriority: true };
  let r = await run(base(useGpu ? NV : X264), runOpts);
  if (r.code !== 0 && useGpu && !(o.signal && o.signal.aborted)) {
    cfg.log('nvenc proxy failed, CPU fallback:', lastError(r.stderr));
    if (/nvenc|cuda|nvcuda|No capable devices|OpenEncodeSessionEx/i.test(r.stderr)) markNvencBroken();
    useGpu = false;
    r = await run(base(X264), runOpts);
  }
  if (r.code !== 0) {
    fsp.rm(tmp, { force: true }).catch(() => {});
    throw userError(tr(STR.proxyFailed, { name: path.basename(src), msg: lastError(r.stderr) }), { stderr: r.stderr });
  }
  await renameOver(tmp, dst);
  return { path: dst, encoder: useGpu ? 'nvenc' : 'x264', w: W, h: H };
}

module.exports = {
  configure,
  ffmpegPath,
  probe,
  parseProbe,
  countFrames,
  run,
  poster,
  previewImage,
  waveform,
  proxy,
  nvenc,
  encodeArgs,
  fitSize,
  isPlayable,
  lastError,
  IMAGE_EXT,
  VIDEO_EXT,
  AUDIO_EXT,
  BROWSER_IMAGE_EXT
};
