'use strict';
// Essai des exécuteurs de B3 hors d'Electron, SANS GPU :
//   frame, trim, resize, sequence, export, sound, looks (ffmpeg) · cutout, composite, finish (worker Python).
//
//   node tools/test-light-executors.js [--no-python] [--only=frame,trim,resize,sequence,export,sound,looks,python,finish]
//
// - Médias de test fabriqués par le ffmpeg du labo en libx264 (processeur), dans _dev/B3/work (recréé à chaque essai ;
//   MIA_TEST_WORK=<dossier> pour en changer).
// - MIA_NO_NVENC=1, MIA_DEVICE=cpu et CUDA_VISIBLE_DEVICES vide : ni NVENC ni CUDA, rien ne touche la carte graphique
//   (une autre session peut s'en servir). BiRefNet tourne sur le processeur en 512² (MIA_CUTOUT_RES) pour aller vite.
// - Utilise les vrais electron/ffmpeg.js et electron/engine/pyrun.js s'ils existent, sinon de petits remplaçants
//   intégrés (même API, SPEC §8.4–8.5).
// Code de sortie 0 si tout passe.

process.env.MIA_NO_NVENC = '1';
process.env.MIA_DEVICE = 'cpu';
process.env.CUDA_VISIBLE_DEVICES = '';
if (!process.env.MIA_CUTOUT_RES) process.env.MIA_CUTOUT_RES = '512';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = process.env.MIA_ENGINE_ROOT || 'D:\\AI_Local_Videos';
const PYTHON = path.join(ENGINE, 'env', 'venv', 'Scripts', 'python.exe');
const WORK = process.env.MIA_TEST_WORK ? path.resolve(process.env.MIA_TEST_WORK) : path.join(ROOT, '_dev', 'B3', 'work');
const PROJECT = path.join(WORK, 'Projet essai');
const MEDIA = path.join(PROJECT, 'media');
const LOGS = path.join(WORK, 'logs');
const EXEC = path.join(ROOT, 'electron', 'engine', 'executors');
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'catalog', 'nodes.json'), 'utf8'));

const args = process.argv.slice(2);
const NO_PY = args.includes('--no-python');
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);

// ——————————————————————————————————————————————————————— ffmpeg : le vrai module, sinon un remplaçant

function findFfmpeg() {
  const dir = path.join(ENGINE, 'env', 'venv', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries');
  const exe = fs.readdirSync(dir).find((n) => /^ffmpeg-.*\.exe$/i.test(n));
  if (!exe) throw new Error(`ffmpeg introuvable dans ${dir}`);
  return path.join(dir, exe);
}
const FFMPEG = findFfmpeg();

function shimFfmpeg() {
  const run = (a, o = {}) => new Promise((resolve, reject) => {
    const full = ['-hide_banner', '-nostdin', ...(o.onProgress ? ['-progress', 'pipe:1', '-nostats'] : []), ...a];
    const child = spawn(FFMPEG, full, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let buf = '';
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
        const m = /^out_time_us=(\d+)/.exec(buf.slice(0, i).trim());
        if (m && o.onProgress && o.duration) o.onProgress(Math.min(0.999, +m[1] / 1e6 / o.duration));
      }
    });
    const onAbort = () => { child.kill(); reject(Object.assign(new Error('Annulé.'), { name: 'AbortError' })); };
    if (o.signal) o.signal.addEventListener('abort', onAbort, { once: true });
    child.on('close', (code) => { if (o.signal) o.signal.removeEventListener('abort', onAbort); resolve({ code, stderr: err }); });
  });
  const probe = async (abs) => {
    const { stderr } = await run(['-i', abs]);
    const v = /Stream #\d+:\d+[^:]*: Video: (\w+)[^,]*, (\w+)(?:\([^)]*\))?, (\d+)x(\d+)[^\n]*?(?:, ([\d.]+) (?:fps|tbr))?/.exec(stderr);
    if (!v) throw new Error(`illisible : ${abs}`);
    const d = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(stderr);
    const image = /\.(png|jpe?g|webp|bmp|tiff?|exr)$/i.test(abs);
    const duration = !image && d ? +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]) : null;
    const fps = image ? null : parseFloat(v[5]) || 24;
    return { kind: image ? 'image' : 'video', w: +v[3], h: +v[4], fps, frames: image ? 1 : Math.round(duration * fps),
      duration, codec: v[1], pixfmt: v[2], alpha: /^(rgba|yuva|gbrap|ya8)/.test(v[2]) || /alpha_mode\s*:\s*1/.test(stderr),
      hasAudio: /: Audio: /.test(stderr), playable: true };
  };
  return { ffmpegPath: () => FFMPEG, run, probe, nvenc: async () => false, shim: true };
}

let ffmpeg;
try {
  ffmpeg = require(path.join(ROOT, 'electron', 'ffmpeg.js'));
  if (typeof ffmpeg.configure === 'function') ffmpeg.configure({ engineRoot: () => ENGINE });
  if (typeof ffmpeg.run !== 'function' || typeof ffmpeg.probe !== 'function') throw new Error('API incomplète');
} catch (e) {
  console.log(`(electron/ffmpeg.js indisponible : ${e.message} — remplaçant intégré)`);
  ffmpeg = shimFfmpeg();
}

// ——————————————————————————————————————————————————————— Python : le vrai pyrun.js, sinon un remplaçant

function shimPy() {
  return {
    run(task, payload, { cwd, signal, onProgress, onPreview, onLog } = {}) {
      return new Promise((resolve, reject) => {
        fs.writeFileSync(path.join(cwd, 'job.json'), JSON.stringify(payload, null, 2));
        const child = spawn(PYTHON, ['-B', '-u', path.join(ROOT, 'python', 'mia_worker.py'), task, path.join(cwd, 'job.json')], {
          cwd, windowsHide: true,
          env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONPATH: ENGINE },
        });
        let result = null;
        let error = null;
        let cancelled = false;
        const lines = (stream, fn) => { let b = ''; stream.setEncoding('utf8'); stream.on('data', (d) => { b += d; for (let i; (i = b.indexOf('\n')) >= 0; b = b.slice(i + 1)) fn(b.slice(0, i).replace(/\r$/, '')); }); };
        lines(child.stdout, (l) => {
          if (!l.startsWith('@mia ')) { if (onLog) onLog(l); return; }
          const m = JSON.parse(l.slice(5));
          if (m.done) result = m;
          else if (m.error) error = m.error;
          else if (m.preview) { if (onPreview) onPreview(m.preview); }
          else if (onProgress) onProgress(m.p ?? null, m.msg, m.eta);
        });
        lines(child.stderr, (l) => onLog && onLog(l));
        if (signal) signal.addEventListener('abort', () => {
          cancelled = true;
          fs.writeFileSync(path.join(cwd, 'cancel'), '1');
          setTimeout(() => spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }), 3000);
        }, { once: true });
        child.on('close', (code) => {
          if (cancelled) return reject(Object.assign(new Error('Annulé'), { name: 'AbortError', cancelled: true }));
          if (error) return reject(new Error(error));
          if (result) return resolve({ outputs: result.outputs || {} });
          reject(new Error(`python s'est arrêté (code ${code})`));
        });
      });
    },
    shim: true,
  };
}

let py;
try {
  py = require(path.join(ROOT, 'electron', 'engine', 'pyrun.js')).createPyRunner({ prefs: () => ({ engineRoot: ENGINE, lang: 'fr' }), root: ROOT });
} catch (e) {
  console.log(`(electron/engine/pyrun.js indisponible : ${e.message} — remplaçant intégré)`);
  py = shimPy();
}

// ——————————————————————————————————————————————————————— petits outils

function ffSync(a) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...a], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${a.join(' ')}\n${r.stderr}`);
}
function frameCount(abs) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-i', abs, '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', '-'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 });
  return r.stdout.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).length;
}
function stderrOf(abs) {
  return spawnSync(FFMPEG, ['-hide_banner', '-i', abs], { encoding: 'utf8', windowsHide: true }).stderr;
}
const sameBytes = (a, b) => Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) === 0;

async function inputOf(abs, extra = {}) {
  const p = await ffmpeg.probe(abs);
  return { abs, rel: path.relative(PROJECT, abs).split(path.sep).join('/'), kind: p.kind,
    meta: { w: p.w, h: p.h, fps: p.fps, frames: p.frames, duration: p.duration, alpha: p.alpha }, ...extra };
}

let seq = 0;
function makeX(type, inputs, params = {}) {
  const entry = CATALOG.types.find((t) => t.id === type);
  const defaults = Object.fromEntries((entry.params || []).map((p) => [p.id, p.default]));
  const nodeId = `n_${type}`;
  const runId = `r_test_${String(++seq).padStart(2, '0')}`;
  const outDir = path.join(PROJECT, 'outputs', nodeId, runId);
  fs.mkdirSync(outDir, { recursive: true });
  const ac = new AbortController();
  const logFile = path.join(LOGS, `${runId}_${type}.log`);
  const events = [];
  return {
    projectId: 'p_essai', projectDir: PROJECT, nodeId, runId, type: entry, mode: null,
    params: { ...defaults, ...params }, inputs, outDir, engineRoot: ENGINE, lang: 'fr',
    model: (key) => (key === 'model' && type === 'cutout'
      ? { path: path.join(ENGINE, 'models', 'outils', 'BiRefNet'), label: { fr: 'BiRefNet (détourage)', en: 'BiRefNet (cutout)' } } : null),
    progress: (p, msg, eta) => events.push({ p, msg, eta }),
    preview: (abs) => events.push({ preview: abs }),
    log: (line) => fs.appendFileSync(logFile, `${line}\n`),
    signal: ac.signal, abort: () => ac.abort(), comfy: null, py, ffmpeg, events,
  };
}
const run = (type, x) => require(path.join(EXEC, `${type}.js`)).run(x);

// ——————————————————————————————————————————————————————— cadre d'essai

const results = [];
async function test(group, name, fn) {
  if (ONLY.length && !ONLY.includes(group)) return;
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ ok: true });
    console.log(`  ✓ ${group} · ${name}${note ? ` — ${note}` : ''} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    results.push({ ok: false });
    console.log(`  ✗ ${group} · ${name} — ${e.message}`);
  }
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }
async function expectError(promise, re) {
  try { await promise; } catch (e) {
    expect(re.test(e.message), `message inattendu : « ${e.message} »`);
    return `refus attendu : « ${e.message} »`;
  }
  throw new Error('aurait dû échouer');
}

// ——————————————————————————————————————————————————————— médias de test

function makeMedia() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(MEDIA, { recursive: true });
  fs.mkdirSync(LOGS, { recursive: true });
  const m = (n) => path.join(MEDIA, n);
  const x264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
  // 10 images 256², 24 i/s, avec du son
  ffSync(['-f', 'lavfi', '-i', 'testsrc=size=256x256:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-frames:v', '10', ...x264, '-c:a', 'aac', '-shortest', m('clip_a.mp4')]);
  // 12 images 320×180, 30 i/s, muet (normalisation de l'Assembler)
  ffSync(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-frames:v', '12', ...x264, m('clip_b.mp4')]);
  // un codec que l'export doit réencoder (FFV1 en MKV)
  ffSync(['-f', 'lavfi', '-i', 'testsrc2=size=256x144:rate=25', '-frames:v', '8', '-c:v', 'ffv1', m('clip_c.mkv')]);
  ffSync(['-f', 'lavfi', '-i', 'testsrc2=size=256x256', '-frames:v', '1', m('image.png')]);
  ffSync(['-f', 'lavfi', '-i', 'color=c=red@0.5:s=200x120,format=rgba', '-frames:v', '1', m('alpha.png')]);
  // un « sujet » : disque clair sur fond dégradé (image) et qui se déplace (vidéo de 10 images)
  const disc = (cx) => `geq=r='if(lt(hypot(X-${cx},Y-128),60),235,30+X/4)':g='if(lt(hypot(X-${cx},Y-128),60),190,40+Y/5)':b='if(lt(hypot(X-${cx},Y-128),60),150,90)'`;
  ffSync(['-f', 'lavfi', '-i', 'color=c=black:s=256x256', '-vf', disc(128), '-frames:v', '1', m('sujet.png')]);
  ffSync(['-f', 'lavfi', '-i', 'color=c=black:s=256x256:rate=24', '-vf', disc('(100+N*6)'), '-frames:v', '10', ...x264, m('sujet.mp4')]);
  // fonds de la superposition (autre taille que le calque : il doit s'y ajuster)
  ffSync(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24', '-frames:v', '12', ...x264, m('fond.mp4')]);
  ffSync(['-f', 'lavfi', '-i', 'testsrc2=size=320x240', '-frames:v', '1', m('fond.png')]);
  // plan vertical de travail (cas du contrôle : export téléphone plus lourd que le HQ) : 6 s 480×848, cq 14 + son
  ffSync(['-f', 'lavfi', '-i', 'testsrc2=size=480x848:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
    '-t', '6', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-g', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', m('vertical.mp4')]);
  // vidéo « de téléphone » : pixels couchés + rotation d'affichage
  ffSync(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24', '-frames:v', '4', ...x264, m('couche_src.mp4')]);
  ffSync(['-display_rotation', '90', '-i', m('couche_src.mp4'), '-c', 'copy', m('telephone.mp4')]);
  // sons du bloc Son : 3 s en WAV (plus long que clip_a), 0,2 s en MP3 avec une pochette (piste « attached pic »)
  ffSync(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100:duration=3', '-ac', '2', '-c:a', 'pcm_s16le', m('son.wav')]);
  // un bruitage très faible (comme le projecteur du film : RMS ≈ −49 dB)
  ffSync(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=2', '-af', 'volume=-25dB', '-ac', '2', '-c:a', 'pcm_s16le', m('faible.wav')]);
  ffSync(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=0.2', '-f', 'lavfi', '-i', 'color=c=gray:s=64x64',
    '-map', '0:a', '-map', '1:v', '-frames:v', '1', '-c:a', 'libmp3lame', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', m('court.mp3')]);
  // LUT 3D de la Finition : 2³ qui inverse les couleurs (ordre .cube : le rouge varie le plus vite)
  const rows = [];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) rows.push(`${1 - r} ${1 - g} ${1 - b}`);
  fs.writeFileSync(m('inverse.cube'), `TITLE "inverse"\nLUT_3D_SIZE 2\n${rows.join('\n')}\n`);
  return m;
}

/** Couleur RGB du pixel (x, y) de la 1re image d'une image ou d'une vidéo. */
function pixel(abs, x, y) {
  const raw = spawnSync(FFMPEG, ['-v', 'error', '-i', abs, '-frames:v', '1', '-vf', `crop=1:1:${x}:${y}`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, maxBuffer: 1 << 20 }).stdout;
  return [raw[0], raw[1], raw[2]];
}

/** Volume moyen (dB) d'un passage du son d'un fichier : -91 = silence. */
function meanDb(abs, from, to) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-i', abs, '-vn', '-af',
    `atrim=${from}:${to},volumedetect`, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
  const mm = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr);
  return mm ? (mm[1] === '-inf' ? -200 : parseFloat(mm[1])) : null;
}

/** Durée (s) de la piste son d'un fichier, ou null s'il n'a pas de son. */
function audioSeconds(abs) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-i', abs, '-map', '0:a:0', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  const all = [...r.stderr.matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
  if (!all.length) return null;
  const t = all[all.length - 1];
  return +t[1] * 3600 + +t[2] * 60 + parseFloat(t[3]);
}

// ——————————————————————————————————————————————————————— essais

async function main() {
  console.log(`Mia · essai des exécuteurs B3 — ffmpeg ${ffmpeg.shim ? '(remplaçant)' : '(electron/ffmpeg.js)'}, python ${py.shim ? '(remplaçant)' : '(pyrun.js)'}`);
  const m = makeMedia();
  const clipA = await inputOf(m('clip_a.mp4'));
  const clipB = await inputOf(m('clip_b.mp4'));
  const clipC = await inputOf(m('clip_c.mkv'));
  const img = await inputOf(m('image.png'));
  const alphaImg = await inputOf(m('alpha.png'));

  console.log('\nExtraire une image');
  await test('frame', 'image 3, PNG 256² nommé « clip_a_f0003.png »', async () => {
    const x = makeX('frame', { video: clipA }, { at: 3 });
    const r = await run('frame', x);
    const p = await ffmpeg.probe(r.outputs.image.abs);
    expect(p.w === 256 && p.h === 256, `taille ${p.w}×${p.h}`);
    expect(path.basename(r.outputs.image.abs) === 'clip_a_f0003.png', `nom ${path.basename(r.outputs.image.abs)}`);
    const msgs = x.events.filter((e) => e.msg).map((e) => e.msg);
    expect(msgs.some((s) => /Image 3 \/ 10 extraite/.test(s)), `messages ${msgs.join(' | ')}`);
    return `${path.basename(r.outputs.image.abs)} · « ${msgs[msgs.length - 1]} »`;
  });
  await test('frame', '-1 = dernière = n° 9, et n° 50 ramené à la dernière', async () => {
    const last = await run('frame', makeX('frame', { video: clipA }, { at: -1 }));
    const nine = await run('frame', makeX('frame', { video: clipA }, { at: 9 }));
    const far = await run('frame', makeX('frame', { video: clipA }, { at: 50 }));
    const three = await run('frame', makeX('frame', { video: clipA }, { at: 3 }));
    expect(sameBytes(last.outputs.image.abs, nine.outputs.image.abs), '-1 ≠ 9');
    expect(sameBytes(far.outputs.image.abs, nine.outputs.image.abs), '50 ≠ 9');
    expect(!sameBytes(three.outputs.image.abs, nine.outputs.image.abs), '3 = 9 ?');
    expect(path.basename(last.outputs.image.abs) === 'clip_a_f0009.png', path.basename(last.outputs.image.abs));
    expect(last.notes.frame === 9 && last.notes.frames === 10, `notes ${JSON.stringify(last.notes)}`);
    return `notes ${JSON.stringify(last.notes)}`;
  });
  await test('frame', 'Ignorer la 1re image décale d\'un cran', async () => {
    const a = await run('frame', makeX('frame', { video: { ...clipA, skipFirst: true } }, { at: 2 }));
    const b = await run('frame', makeX('frame', { video: clipA }, { at: 3 }));
    expect(sameBytes(a.outputs.image.abs, b.outputs.image.abs), 'skipFirst ignoré');
  });

  console.log('\nCouper');
  await test('trim', 'images 2 à 6 → 5 images, son gardé', async () => {
    const x = makeX('trim', { video: clipA }, { start: 2, end: 6 });
    const r = await run('trim', x);
    const n = frameCount(r.outputs.video.abs);
    const p = await ffmpeg.probe(r.outputs.video.abs);
    expect(n === 5, `${n} images`);
    expect(r.outputs.video.meta.frames === 5, `méta ${r.outputs.video.meta.frames}`);
    expect(p.hasAudio, 'son perdu');
    const lastMsg = x.events.filter((e) => e.msg).pop().msg;
    expect(/5 images \(2 à 6\)/.test(lastMsg), `message « ${lastMsg} »`);
    return `${n} images, ${p.fps} i/s, ${p.codec} · « ${lastMsg} »`;
  });
  await test('trim', 'de 3 à la fin (-1) → 7 images', async () => {
    const r = await run('trim', makeX('trim', { video: clipA }, { start: 3, end: -1 }));
    const n = frameCount(r.outputs.video.abs);
    expect(n === 7, `${n} images`);
    expect(r.notes.end === 9 && r.notes.frames === 7, `notes ${JSON.stringify(r.notes)}`);
  });
  await test('trim', 'son plus long que l\'image : la fin (-1) tombe sur la vraie dernière image', async () => {
    // 10 images (0,42 s) + 1 s de son : l'estimation « durée × cadence » compterait 24 images
    const src = path.join(MEDIA, 'son_long.mp4');
    ffSync(['-f', 'lavfi', '-i', 'testsrc=size=256x256:rate=24:duration=0.4166', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
    expect(frameCount(src) === 10, `source de ${frameCount(src)} images`);
    const inp = await inputOf(src);
    const r = await run('trim', makeX('trim', { video: inp }, { start: 8, end: -1 }));
    const n = frameCount(r.outputs.video.abs);
    const f = await run('frame', makeX('frame', { video: inp }, { at: -1 }));
    expect(n === 2 && r.notes.end === 9, `${n} images, notes ${JSON.stringify(r.notes)} (méta d'import : ${inp.meta.frames} images)`);
    expect(f.notes.frame === 9 && path.basename(f.outputs.image.abs) === 'son_long_f0009.png', `extraire -1 : ${JSON.stringify(f.notes)}`);
    return `méta d'import ${inp.meta.frames} images, réel 10 : coupe 8 à 9, dernière = f0009`;
  });
  await test('trim', 'fin avant le début → refus clair', () =>
    expectError(run('trim', makeX('trim', { video: clipA }, { start: 6, end: 2 })), /avant le début/));

  console.log('\nRedimensionner');
  for (const [size, fit, w, h] of [['1280x720', 'contain', 1280, 720], ['720x1280', 'cover', 720, 1280], ['x2', 'contain', 512, 512], ['x0.5', 'contain', 128, 128]]) {
    await test('resize', `vidéo ${size} ${fit}`, async () => {
      const r = await run('resize', makeX('resize', { media: clipA }, { size, fit }));
      const p = await ffmpeg.probe(r.outputs.out.abs);
      expect(p.w === w && p.h === h, `${p.w}×${p.h}`);
      expect(frameCount(r.outputs.out.abs) === 10, 'images perdues');
    });
  }
  await test('resize', 'image transparente 1920×1080 ajustée : reste transparente', async () => {
    const r = await run('resize', makeX('resize', { media: alphaImg }, { size: '1920x1080', fit: 'contain' }));
    const p = await ffmpeg.probe(r.outputs.out.abs);
    expect(p.w === 1920 && p.h === 1080 && p.alpha, `${p.w}×${p.h} alpha=${p.alpha} (${p.pixfmt})`);
  });
  await test('resize', 'image ×½', async () => {
    const r = await run('resize', makeX('resize', { media: img }, { size: 'x0.5' }));
    const p = await ffmpeg.probe(r.outputs.out.abs);
    expect(p.w === 128 && p.h === 128 && r.outputs.out.kind === 'image', `${p.w}×${p.h}`);
  });

  console.log('\nAssembler');
  for (const transition of ['cut', 'black']) {
    await test('sequence', `256² 24 i/s + 320×180 30 i/s, ${transition}`, async () => {
      const r = await run('sequence', makeX('sequence', { clips: [clipA, clipB] }, { transition }));
      const p = await ffmpeg.probe(r.outputs.video.abs);
      const n = frameCount(r.outputs.video.abs);
      expect(p.w === 256 && p.h === 256, `${p.w}×${p.h}`);
      expect(Math.abs(p.fps - 24) < 0.01, `${p.fps} i/s`);
      expect(n >= 19 && n <= 21, `${n} images (≈ 20 attendues)`);
      expect(p.hasAudio, 'son perdu');
      return `${n} images`;
    });
  }

  console.log('\nExporter');
  await test('export', 'MP4 HQ d\'un H.264 → recopie sans réencodage', async () => {
    const r = await run('export', makeX('export', { media: clipA }, { format: 'mp4' }));
    expect(Object.keys(r.outputs).length === 0, 'export ne doit pas avoir de sortie');
    const abs = path.join(PROJECT, r.notes.exported);
    expect(r.notes.exported.startsWith('A_regarder/') && fs.existsSync(abs), r.notes.exported);
    expect(frameCount(abs) === 10, 'images perdues');
    return r.notes.exported;
  });
  await test('export', 'MP4 HQ d\'un FFV1 → réencodé en H.264', async () => {
    const r = await run('export', makeX('export', { media: clipC }, { format: 'mp4', name: 'Essai: FFV1?' }));
    const abs = path.join(PROJECT, r.notes.exported);
    const p = await ffmpeg.probe(abs);
    expect(p.codec === 'h264' && p.pixfmt === 'yuv420p', `${p.codec} ${p.pixfmt}`);
    expect(path.basename(abs) === 'Essai FFV1.mp4', `nom ${path.basename(abs)}`);
    return r.notes.exported;
  });
  await test('export', 'même nom deux fois → « (2) », rien d\'écrasé', async () => {
    const r = await run('export', makeX('export', { media: clipC }, { format: 'mp4', name: 'Essai: FFV1?' }));
    expect(path.basename(r.notes.exported) === 'Essai FFV1 (2).mp4', r.notes.exported);
  });
  await test('export', 'téléphone : deux passes, < 30 Mo, exported.json à côté du run', async () => {
    const x = makeX('export', { media: clipA }, { format: 'phone' });
    const r = await run('export', x);
    const abs = path.join(PROJECT, r.notes.exported);
    expect(r.notes.bytes < 30e6 && fs.statSync(abs).size === r.notes.bytes, `${r.notes.bytes} octets`);
    const left = fs.readdirSync(x.outDir).filter((f) => f.startsWith('_'));
    expect(!left.length, `fichiers de travail oubliés : ${left.join(', ')}`);
    const ej = JSON.parse(fs.readFileSync(path.join(x.outDir, 'exported.json'), 'utf8'));
    expect(ej.exported === r.notes.exported && ej.kind === 'video' && ej.bytes === r.notes.bytes && ej.format === 'phone',
      `exported.json ${JSON.stringify(ej)}`);
    return r.notes.exported;
  });
  await test('export', 'téléphone plus léger que le HQ (plan vertical 6 s 480×848 de travail)', async () => {
    const vert = await inputOf(m('vertical.mp4'));
    const hq = await run('export', makeX('export', { media: vert }, { format: 'mp4' }));
    const ph = await run('export', makeX('export', { media: vert }, { format: 'phone' }));
    const p = await ffmpeg.probe(path.join(PROJECT, ph.notes.exported));
    expect(ph.notes.bytes < hq.notes.bytes, `téléphone ${ph.notes.bytes} ≥ HQ ${hq.notes.bytes}`);
    expect(p.w === 480 && p.h === 848 && p.hasAudio, `${p.w}×${p.h} son=${p.hasAudio}`);
    const kbps = (ph.notes.bytes * 8) / 6 / 1000;
    expect(kbps < 2000, `${kbps.toFixed(0)} kb/s (≈ 1,2 Mb/s visés)`);
    return `HQ ${(hq.notes.bytes / 1e6).toFixed(2)} Mo · téléphone ${(ph.notes.bytes / 1e6).toFixed(2)} Mo (${kbps.toFixed(0)} kb/s)`;
  });
  await test('export', 'suite PNG : un dossier, « nom.0000.png »', async () => {
    const r = await run('export', makeX('export', { media: clipA }, { format: 'png', name: 'plan 12' }));
    const dir = path.join(PROJECT, r.notes.exported);
    const files = fs.readdirSync(dir).sort();
    expect(r.notes.kind === 'sequence' && files.length === 10, `${files.length} fichiers`);
    expect(files[0] === 'plan 12.0000.png' && files[9] === 'plan 12.0009.png', `${files[0]} … ${files[9]}`);
  });
  await test('export', 'image : PNG recopié, téléphone → JPEG', async () => {
    const a = await run('export', makeX('export', { media: img }, { format: 'png' }));
    const b = await run('export', makeX('export', { media: img }, { format: 'phone' }));
    expect(sameBytes(path.join(PROJECT, a.notes.exported), img.abs), 'PNG modifié');
    expect(/\.jpg$/.test(b.notes.exported), b.notes.exported);
    return `${a.notes.exported} · ${b.notes.exported}`;
  });

  console.log('\nSon');
  const sonWav = await inputOf(m('son.wav'));
  const court = await inputOf(m('court.mp3'));
  await test('sound', 'sonde : un WAV et un MP3 à pochette sont des sons', async () => {
    expect(sonWav.kind === 'audio' && court.kind === 'audio', `${sonWav.kind} / ${court.kind}`);
    const p = await ffmpeg.probe(m('son.wav'));
    expect(Math.abs(p.duration - 3) < 0.05 && p.sampleRate === 44100 && p.channels === 2, JSON.stringify(p));
  });
  await test('sound', 'garder le son d\'origine : mélangé, image recopiée, coupé à la vidéo', async () => {
    const r = await run('sound', makeX('sound', { video: clipA, audio: sonWav }, {}));
    const out = r.outputs.video.abs;
    expect(frameCount(out) === 10 && r.notes.reencoded === false, `${frameCount(out)} images, réencodé ${r.notes.reencoded}`);
    const a = audioSeconds(out);
    expect(a && Math.abs(a - 10 / 24) < 0.06, `son ${a} s pour ${10 / 24} s d'image`);
    expect(/Audio: aac.*48000 Hz, stereo/.test(stderrOf(out)), 'son AAC 48 kHz stéréo attendu');
  });
  await test('sound', 'remplacer, départ à l\'image 5 : silence avant, son après', async () => {
    const r = await run('sound', makeX('sound', { video: clipA, audio: sonWav }, { mode: 'replace', start: 5, fadeOut: 0 }));
    const out = r.outputs.video.abs;
    const before = meanDb(out, 0, 0.18);
    const after = meanDb(out, 0.23, 0.4);
    expect(before < -60 && after > -30, `avant ${before} dB, après ${after} dB`);
    return `avant ${before} dB · après ${after} dB`;
  });
  await test('sound', 'ne pas couper : la dernière image tient jusqu\'à la fin du son (3 s)', async () => {
    const r = await run('sound', makeX('sound', { video: clipA, audio: sonWav }, { fit: false }));
    const n = frameCount(r.outputs.video.abs);
    expect(n === 72 && r.notes.reencoded === true, `${n} images (72 attendues)`);
  });
  await test('sound', 'vidéo muette 30 i/s + son court à pochette, fondus', async () => {
    const r = await run('sound', makeX('sound', { video: clipB, audio: court }, { fadeIn: 0.05, fadeOut: 0.05 }));
    const out = r.outputs.video.abs;
    expect(frameCount(out) === 12 && audioSeconds(out) > 0.35, `${frameCount(out)} images, son ${audioSeconds(out)} s`);
  });
  await test('sound', 'un « son » sans piste audio → refus clair', () =>
    expectError(run('sound', makeX('sound', { video: clipA, audio: clipB }, {})), /ne contient pas de son/));
  await test('sound', 'égaliser : un bruitage à −49 dB ressort à −20 dB ; décoché, il garde son niveau', async () => {
    const faible = await inputOf(m('faible.wav'));
    const on = await run('sound', makeX('sound', { video: clipA, audio: faible }, { mode: 'replace', fadeOut: 0 }));
    const off = await run('sound', makeX('sound', { video: clipA, audio: faible }, { mode: 'replace', fadeOut: 0, level: false }));
    const a = meanDb(on.outputs.video.abs, 0.05, 0.35);
    const b = meanDb(off.outputs.video.abs, 0.05, 0.35);
    expect(Math.abs(a + 20) < 1.5 && Math.abs(b + 49) < 1.5, `égalisé ${a} dB, brut ${b} dB`);
    return `égalisé ${a} dB · brut ${b} dB`;
  });
  await test('sound', 'boucler un son de 0,2 s sur 0,42 s de vidéo', async () => {
    const r = await run('sound', makeX('sound', { video: clipA, audio: court }, { mode: 'replace', loop: true, fadeOut: 0 }));
    const end = meanDb(r.outputs.video.abs, 0.3, 0.4);
    expect(r.notes.loop === true && end > -40, `fin ${end} dB (le son doit encore jouer)`);
  });

  console.log('\nLooks (Mia\\luts) et « Essayer des looks »');
  const LUTS = path.join(ROOT, 'luts');
  const INDEX = JSON.parse(fs.readFileSync(path.join(LUTS, 'index.json'), 'utf8'));
  // les vignettes de la planche (looks.js) : grand côté 560, marge 16, 3 colonnes ; sous chaque vignette, une bande
  // du libellé de 1,9 × la taille du texte (1/11,5 de la vignette, réduite si le plus long nom ne tiendrait pas)
  const tileAt = (i, tw, th, band) => [16 + (i % 3) * (tw + 16), 16 + Math.floor(i / 3) * (th + band + 16)];
  // noms montrés sur la planche : ceux du catalogue (Finition › Étalonnage, nom court s'il y en a un), sinon index.json
  const LOOK_OPTS = CATALOG.types.find((t) => t.id === 'finish').params.find((p) => p.id === 'look').options;
  const sheetName = (e) => { const o = LOOK_OPTS.find((k) => k.value === e.id); return ((o && (o.short || o.label)) || e.label).fr; };
  const labelSize = (tw, names) => Math.max(14, Math.min(Math.round(tw / 11.5), Math.floor((tw * 0.96) / (Math.max(...names.map((n) => [...n].length)) * 0.56))));
  /** Valeur la plus claire d'une zone de l'image (une seule lecture ffmpeg). */
  const brightest = (abs, x, y, w, h) => {
    const raw = spawnSync(FFMPEG, ['-v', 'error', '-i', abs, '-frames:v', '1', '-vf', `crop=${w}:${h}:${x}:${y}`,
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { windowsHide: true, maxBuffer: 1 << 24 }).stdout;
    let mx = 0;
    for (const v of raw) if (v > mx) mx = v;
    return mx;
  };
  await test('looks', 'luts/index.json : Etalo + 7 looks, .cube 33³ dans [0, 1], gris croissants, noir > 0, blanc < 95 %', async () => {
    expect(INDEX.length === 8 && INDEX[0].id === 'etalo' && INDEX[0].file.startsWith('<labo>/'), `index : ${INDEX.map((e) => e.id)}`);
    expect(fs.existsSync(path.join(ENGINE, ...INDEX[0].file.slice('<labo>/'.length).split('/'))), 'etalo_33.cube absent du labo');
    for (const e of INDEX.slice(1)) {
      expect(e.label && e.label.fr && e.label.en && e.desc && e.desc.fr && e.desc.en, `${e.id} : libellé ou description manquant`);
      expect(fs.existsSync(path.join(LUTS, e.preview)), `${e.id} : aperçu ${e.preview} absent`);
      const rows = fs.readFileSync(path.join(LUTS, e.file), 'utf8').split(/\r?\n/);
      expect(rows.includes('LUT_3D_SIZE 33'), `${e.file} : pas 33³`);
      const v = rows.filter((l) => /^[\d.]+ [\d.]+ [\d.]+$/.test(l)).map((l) => l.split(' ').map(Number));
      expect(v.length === 33 ** 3 && v.every((c) => c.every((k) => k >= 0 && k <= 1)), `${e.file} : ${v.length} lignes ou valeur hors [0, 1]`);
      const gray = Array.from({ length: 33 }, (_, i) => v[i + 33 * i + 33 * 33 * i]);
      const lum = gray.map((c) => c[0] + c[1] + c[2]);
      expect(lum.every((y, i) => i === 0 || y > lum[i - 1]), `${e.file} : axe neutre non croissant`);
      expect(Math.min(...gray[0]) > 0.005 && Math.max(...gray[32]) < 0.95, `${e.file} : noir ${gray[0]} / blanc ${gray[32]}`);
    }
    return INDEX.map((e) => e.id).join(', ');
  });
  await test('looks', 'catalogue : « Étalonnage » = Aucun, les looks de index.json dans l\'ordre, Autre LUT ; un seul jeu de noms', async () => {
    const opts = LOOK_OPTS;
    const want = ['none', ...INDEX.map((e) => e.id), 'file'];
    expect(JSON.stringify(opts.map((o) => o.value)) === JSON.stringify(want), `options ${opts.map((o) => o.value)}`);
    expect(opts.every((o) => o.label && o.label.fr && o.label.en), 'option sans libellé fr/en');
    // les noms viennent du catalogue : la planche des looks et la Finition disent la même chose
    const LK = require(path.join(EXEC, 'looks.js'));
    const lk = LK.looks({ engineRoot: ENGINE });
    expect(JSON.stringify(lk.map((e) => e.id)) === JSON.stringify(INDEX.map((e) => e.id)), `looks() ${lk.map((e) => e.id)}`);
    const diff = lk.filter((e) => { const o = opts.find((k) => k.value === e.id); return e.label.fr !== o.label.fr || e.label.en !== o.label.en; });
    expect(!diff.length, `noms de looks() différents du catalogue : ${diff.map((e) => e.id)}`);
    const t = CATALOG.types.find((x) => x.id === 'looks');
    expect(t && t.engine.executor === 'looks' && t.engine.gpu === 'light' && t.params[0].kind === 'frame' && t.params[0].of === 'media',
      'bloc « looks » absent ou mal décrit');
  });
  const peau = m('peau.png');
  ffSync(['-f', 'lavfi', '-i', 'color=c=0xB07860:s=320x180', '-frames:v', '1', peau]);
  await test('looks', 'planche d\'une image : 9 vignettes (Original, Etalo, 7 looks), libellés, fond de Mia', async () => {
    const x = makeX('looks', { media: await inputOf(peau) }, {});
    const r = await run('looks', x);
    const out = r.outputs.image.abs;
    const p = await ffmpeg.probe(out);
    const tw = 560;
    const th = 316;
    const size = labelSize(tw, ['Original', ...INDEX.map(sheetName)]);
    const band = Math.round(size * 1.9);
    const g = r.notes.grid;
    expect(g && g.tile.w === tw && g.tile.h === th && g.label.size === size && g.label.band === band && g.cols === 3 && g.rows === 3,
      `grille ${JSON.stringify(g)} (attendu texte ${size}, bande ${band})`);
    expect(p.w === 3 * (tw + 16) + 16 && p.h === 3 * (th + band + 16) + 16 && p.w === r.outputs.image.meta.w && p.h === r.outputs.image.meta.h,
      `taille ${p.w}×${p.h} (méta ${r.outputs.image.meta.w}×${r.outputs.image.meta.h})`);
    expect(path.basename(out) === 'peau_looks.png', `nom ${path.basename(out)}`);
    expect(JSON.stringify(r.notes.looks) === JSON.stringify(['original', ...INDEX.map((e) => e.id)]), `ordre ${r.notes.looks}`);
    const bg = pixel(out, 3, 3);
    expect(bg[0] === 9 && bg[1] === 9 && bg[2] === 11, `fond ${bg}`);
    const centre = (i) => { const [tx, ty] = tileAt(i, tw, th, band); return pixel(out, tx + tw / 2, ty + th / 2); };
    const src = pixel(peau, 160, 90);
    const orig = centre(0);
    expect(orig.every((c, i) => Math.abs(c - src[i]) <= 2), `original ${orig} ≠ source ${src}`);
    const nb = centre(INDEX.findIndex((e) => e.id === 'nb-argentique') + 1);
    expect(Math.max(...nb) - Math.min(...nb) <= 8, `noir et blanc ${nb}`);
    const looks = INDEX.map((e, i) => centre(i + 1));
    expect(looks.every((c) => c.some((v, i) => Math.abs(v - src[i]) > 3)), `un look ne change rien : ${looks.map((c) => c.join('/')).join(' · ')}`);
    // libellé : de l'encre claire dans la bande sous la 1re vignette, rien que le fond dans la marge entre deux lignes
    const [lx, ly] = tileAt(0, tw, th, band);
    const ink = brightest(out, lx, ly + th + 2, Math.round(tw / 2), band - 4);
    expect(ink > 90, `libellé introuvable (max ${ink})`);
    const gap = brightest(out, lx, ly + th + band + 2, tw, 12);
    expect(gap < 20, `la marge sous le libellé n'est pas vide (max ${gap})`);
    return `${p.w}×${p.h} · source ${src} → ${looks.map((c) => c.join('/')).join(' · ')}`;
  });
  await test('looks', 'planche d\'une vidéo : l\'image n° 3 (même choix que « Extraire une image »)', async () => {
    const r = await run('looks', makeX('looks', { media: clipA }, { at: 3 }));
    expect(path.basename(r.outputs.image.abs) === 'clip_a_looks_f0003.png' && r.notes.frame === 3 && r.notes.frames === 10,
      `${path.basename(r.outputs.image.abs)} · image ${r.notes.frame} / ${r.notes.frames}`);
    // la vignette « Original » = l'image 3 extraite par le bloc Extraire une image, agrandie à 560
    const f = await run('frame', makeX('frame', { video: clipA }, { at: 3 }));
    const ref = pixel(f.outputs.image.abs, 200, 40);
    const got = pixel(r.outputs.image.abs, 16 + Math.round(200 * 560 / 256), 16 + Math.round(40 * 560 / 256));
    expect(got.every((c, i) => Math.abs(c - ref[i]) <= 24), `original ${got} ≠ image 3 ${ref}`);
  });
  await test('looks', 'chemins à apostrophe et accents (« L\'été ») dans les LUT et le projet', async () => {
    const LK = require(path.join(EXEC, 'looks.js'));
    const dir = path.join(WORK, 'Labo L\'été');
    fs.mkdirSync(path.join(dir, 'projects', 'close_up', 'etalo'), { recursive: true });
    fs.copyFileSync(path.join(ENGINE, 'projects', 'close_up', 'etalo', 'etalo_33.cube'), path.join(dir, 'projects', 'close_up', 'etalo', 'etalo_33.cube'));
    const x = makeX('looks', { media: await inputOf(peau) }, {});
    x.engineRoot = dir;
    expect(LK.lookPath(x, 'etalo').startsWith(dir), 'etalo pas résolu dans le labo choisi');
    const r = await run('looks', x);
    expect(r.notes.looks.length === 9 && !r.notes.missing, `looks ${r.notes.looks} · absents ${r.notes.missing}`);
  });
  await test('looks', 'labo sans etalo : la planche se fait avec les 7 looks de Mia et le dit', async () => {
    const x = makeX('looks', { media: await inputOf(peau) }, {});
    x.engineRoot = path.join(WORK, 'labo vide');
    const r = await run('looks', x);
    expect(r.notes.looks.length === 8 && !r.notes.looks.includes('etalo') && r.notes.missing.length === 1, `looks ${r.notes.looks}`);
    const p = await ffmpeg.probe(r.outputs.image.abs);
    const band = Math.round(labelSize(560, ['Original', ...INDEX.filter((e) => e.id !== 'etalo').map(sheetName)]) * 1.9);
    expect(r.notes.grid.rows === 3 && r.notes.grid.label.band === band && p.h === 3 * (316 + band + 16) + 16,
      `hauteur ${p.h} (bande ${r.notes.grid.label.band}, attendu ${band})`);
  });

  if (NO_PY) { summary(); return; }

  console.log('\nPython (processeur seulement)');
  await test('python', 'rotation d\'une vidéo de téléphone = celle de ffmpeg', async () => {
    const code = [
      'import sys, subprocess, numpy as np',
      `sys.path.insert(0, r"${path.join(ROOT, 'python')}")`,
      'import mia_common as mc',
      `m = mc.Media({"abs": r"${m('telephone.mp4')}", "kind": "video"})`,
      'a = m.image().astype(np.int16)',
      `raw = subprocess.run([r"${FFMPEG}", "-v", "error", "-i", r"${m('telephone.mp4')}", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True).stdout`,
      'b = np.frombuffer(raw, np.uint8).reshape(m.h, m.w, 3).astype(np.int16)',
      'print(m.w, m.h, m.rot_k, float(np.abs(a - b).mean()))',
    ].join('\n');
    const r = spawnSync(PYTHON, ['-B', '-c', code], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONPATH: ENGINE } });
    expect(r.status === 0, r.stderr.split('\n').slice(-3).join(' '));
    const [w, h, k, diff] = r.stdout.trim().split(/\s+/).map(Number);
    expect(w === 240 && h === 320, `${w}×${h}`);
    expect(diff < 2, `écart moyen ${diff} avec ffmpeg (rotation ${k})`);
    return `${w}×${h}, quart de tour ${k}, écart ${diff.toFixed(2)}`;
  });

  let cutVideo = null;
  let cutAlpha = null;
  await test('python', 'Détourer une image, fond transparent → PNG RGBA + masque', async () => {
    const x = makeX('cutout', { media: await inputOf(m('sujet.png')) }, { background: 'alpha', feather: 2, grow: 1 });
    const r = await run('cutout', x);
    const pm = await ffmpeg.probe(r.outputs.mask.abs);
    const pc = await ffmpeg.probe(r.outputs.cut.abs);
    expect(pm.w === 256 && pc.alpha && r.outputs.cut.kind === 'image', `masque ${pm.w}, alpha ${pc.alpha}`);
    expect(r.model === 'BiRefNet (détourage)', `modèle ${r.model}`);
    return `${x.events.length} évènements`;
  });
  await test('python', 'Détourer une vidéo de 10 images, fond noir', async () => {
    const x = makeX('cutout', { media: await inputOf(m('sujet.mp4')) }, { background: 'black' });
    const r = await run('cutout', x);
    cutVideo = r;
    expect(frameCount(r.outputs.mask.abs) === 10 && frameCount(r.outputs.cut.abs) === 10, 'nombre d\'images');
    const ps = x.events.filter((e) => e.p != null).map((e) => e.p);
    expect(ps.length > 2 && ps[ps.length - 1] === 1, `progression ${ps.join(',')}`);
    expect(/bt709/.test(stderrOf(r.outputs.cut.abs)), 'couleurs non étiquetées BT.709');
    const left = fs.readdirSync(x.outDir).filter((f) => /preview/i.test(f));
    expect(!left.length, `aperçus restés dans le dossier du run : ${left.join(', ')}`);
    const counts = x.events.filter((e) => e.msg && /\d+ \/ \d+ images/.test(e.msg)).map((e) => e.msg);
    expect(counts.length && /10 \/ 10 images/.test(counts[counts.length - 1]), `messages ${counts.join(' | ')}`);
    return `${ps.length} progressions, ${x.events.filter((e) => e.preview).length} aperçus (effacés)`;
  });
  await test('python', 'Détourer une vidéo, fond transparent → WebM VP9 alpha', async () => {
    const r = await run('cutout', makeX('cutout', { media: await inputOf(m('sujet.mp4')) }, { background: 'alpha' }));
    const p = await ffmpeg.probe(r.outputs.cut.abs);
    expect(/\.webm$/.test(r.outputs.cut.abs) && p.alpha && p.codec === 'vp9', `${p.codec} alpha=${p.alpha}`);
    expect(frameCount(r.outputs.cut.abs) === 10, 'nombre d\'images');
    cutAlpha = r;
    return path.basename(r.outputs.cut.abs);
  });
  await test('python', 'WebM transparent → Couper garde la transparence', async () => {
    expect(cutAlpha, 'dépend du détourage transparent');
    const r = await run('trim', makeX('trim', { video: await inputOf(cutAlpha.outputs.cut.abs) }, { start: 2, end: 5 }));
    const p = await ffmpeg.probe(r.outputs.video.abs);
    expect(/\.webm$/.test(r.outputs.video.abs) && p.alpha && frameCount(r.outputs.video.abs) === 4,
      `${path.basename(r.outputs.video.abs)} alpha=${p.alpha}`);
  });
  await test('python', 'WebM transparent → Exporter en MP4 : posé sur du noir', async () => {
    expect(cutAlpha, 'dépend du détourage transparent');
    const r = await run('export', makeX('export', { media: await inputOf(cutAlpha.outputs.cut.abs) }, { format: 'mp4' }));
    const raw = spawnSync(FFMPEG, ['-v', 'error', '-i', path.join(PROJECT, r.notes.exported), '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, maxBuffer: 64 << 20 }).stdout;
    expect(raw.length > 3 && raw[0] < 8 && raw[1] < 8 && raw[2] < 8, `coin = ${raw[0]},${raw[1]},${raw[2]} (noir attendu)`);
    return r.notes.exported;
  });
  await test('python', 'Superposer : fond vidéo 320×240 + calque vidéo + masque, couleurs accordées', async () => {
    expect(cutVideo, 'dépend du détourage vidéo');
    const mask = await inputOf(cutVideo.outputs.mask.abs);
    const r = await run('composite', makeX('composite', { bg: await inputOf(m('fond.mp4')), fg: await inputOf(m('sujet.mp4')), mask }, { match: true }));
    const p = await ffmpeg.probe(r.outputs.out.abs);
    const n = frameCount(r.outputs.out.abs);
    expect(p.w === 320 && p.h === 240 && n === 10, `${p.w}×${p.h}, ${n} images`);
    return `${n} images (la plus courte)`;
  });
  await test('python', 'Superposer : fond image + calque PNG transparent (sans masque)', async () => {
    const r = await run('composite', makeX('composite', { bg: await inputOf(m('fond.png')), fg: alphaImg }, { feather: 3 }));
    const p = await ffmpeg.probe(r.outputs.out.abs);
    expect(r.outputs.out.kind === 'image' && p.w === 320 && p.h === 240, `${p.w}×${p.h}`);
  });
  await test('python', 'Superposer sans masque ni transparence → refus clair', () =>
    expectError(run('composite', makeX('composite', { bg: { abs: m('fond.png'), kind: 'image', meta: {} }, fg: img }, {})), /pas de transparence/));
  await test('finish', 'Finition d\'une image : LUT .cube qui inverse, à 100 %, sans grain ni vignette', async () => {
    const r = await run('finish', makeX('finish', { media: img }, { look: 'file', lutFile: m('inverse.cube'), grain: 0, vignette: 0 }));
    const a = pixel(img.abs, 40, 40);
    const b = pixel(r.outputs.out.abs, 40, 40);
    expect(r.outputs.out.kind === 'image' && a.every((v, i) => Math.abs(255 - v - b[i]) <= 2), `${a} → ${b}`);
    return `${a} → ${b}`;
  });
  await test('finish', 'Finition d\'une vidéo, réglages par défaut : look « Etalo doux » + grain 2 + vignette, son remis', async () => {
    const def = Object.fromEntries(CATALOG.types.find((t) => t.id === 'finish').params.map((q) => [q.id, q.default]));
    expect(def.look === 'etalo-doux' && def.grain === 2 && def.vignette > 0, `défauts du catalogue ${JSON.stringify(def)}`);
    const r = await run('finish', makeX('finish', { media: clipA }, {}));
    const out = r.outputs.out.abs;
    const doux = INDEX.find((e) => e.id === 'etalo-doux');
    expect(frameCount(out) === 10 && r.notes.lut === path.basename(doux.file), `${frameCount(out)} images, LUT ${r.notes.lut}`);
    const a = audioSeconds(out);
    expect(a && Math.abs(a - audioSeconds(clipA.abs)) < 0.05, `son ${a} s`);
    expect(/bt709/.test(stderrOf(out)), 'couleurs non étiquetées BT.709');
  });
  await test('finish', 'Finition : « Garder les rouges » un rouge ne pâlit pas sous la LUT etalo', async () => {
    const red = m('rouge.png');
    ffSync(['-f', 'lavfi', '-i', 'color=c=0x7A3A30:s=64x64', '-frames:v', '1', red]);
    const base = { look: 'etalo', grain: 0, vignette: 0 };
    const a = await run('finish', makeX('finish', { media: await inputOf(red) }, base));
    const b = await run('finish', makeX('finish', { media: await inputOf(red) }, { ...base, warm: true }));
    const pa = pixel(a.outputs.out.abs, 32, 32);
    const pb = pixel(b.outputs.out.abs, 32, 32);
    expect(pb[0] / Math.max(1, pb[1]) >= pa[0] / Math.max(1, pa[1]), `sans ${pa} · avec ${pb}`);
    return `sans ${pa} · avec ${pb}`;
  });
  await test('finish', 'Finition : optique de cinéma, sans LUT', async () => {
    const r = await run('finish', makeX('finish', { media: await inputOf(m('fond.mp4')) }, { look: 'none', film: true }));
    expect(frameCount(r.outputs.out.abs) === 12, `${frameCount(r.outputs.out.abs)} images`);
  });
  await test('finish', 'Finition : « Autre LUT » sans fichier → refus clair', () =>
    expectError(run('finish', makeX('finish', { media: img }, { look: 'file' })), /Choisis un fichier \.cube/));
  await test('finish', 'Finition avec un look de Mia\\luts : « Pellicule chaude » puis « Noir et blanc argentique »', async () => {
    const base = { grain: 0, vignette: 0 };
    const a = await run('finish', makeX('finish', { media: await inputOf(peau) }, { ...base, look: 'pellicule-chaude' }));
    const b = await run('finish', makeX('finish', { media: await inputOf(peau) }, { ...base, look: 'nb-argentique' }));
    const src = pixel(peau, 160, 90);
    const pa = pixel(a.outputs.out.abs, 160, 90);
    const pb = pixel(b.outputs.out.abs, 160, 90);
    expect(a.notes.lut === 'pellicule_chaude.cube' && b.notes.lut === 'nb_argentique.cube', `LUT ${a.notes.lut} / ${b.notes.lut}`);
    expect(pa.some((v, i) => Math.abs(v - src[i]) > 3) && Math.max(...pb) - Math.min(...pb) <= 8, `${src} → chaude ${pa} · n&b ${pb}`);
    return `${src} → chaude ${pa} · n&b ${pb}`;
  });
  await test('finish', 'Finition : un look inconnu → refus clair', () =>
    expectError(run('finish', makeX('finish', { media: img }, { look: 'pellicule-rose' })), /Look inconnu/));
  await test('finish', 'worker Python : un id de look est aussi résolu (« crepuscule »)', async () => {
    const x = makeX('finish', { media: await inputOf(peau) }, {});
    const res = await py.run('finish', { task: 'finish', lang: 'fr', outDir: x.outDir, engineRoot: ENGINE,
      inputs: { media: { abs: peau, kind: 'image', meta: { w: 320, h: 180 } } },
      params: { lut: 'crepuscule', lutStrength: 1, grain: 0, vignette: 0, film: false, keepReds: 0 } }, { cwd: x.outDir });
    const out = res && res.outputs && res.outputs.out;
    expect(out && fs.existsSync(out.abs), 'pas de sortie');
    const ref = await run('finish', makeX('finish', { media: await inputOf(peau) }, { look: 'crepuscule', grain: 0, vignette: 0 }));
    const p1 = pixel(out.abs, 160, 90);
    const p2 = pixel(ref.outputs.out.abs, 160, 90);
    expect(p1.every((c, i) => Math.abs(c - p2[i]) <= 1), `id ${p1} ≠ chemin ${p2}`);
  });
  await test('python', 'Annuler un détourage en cours', async () => {
    const x = makeX('cutout', { media: await inputOf(m('sujet.mp4')) }, {});
    setTimeout(() => x.abort(), 4000);
    const t0 = Date.now();
    const msg = await expectError(run('cutout', x), /annul/i);
    return `${msg} après ${((Date.now() - t0) / 1000).toFixed(1)} s`;
  });

  summary();
}

function summary() {
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad}/${results.length} essais réussis${bad ? ` — ${bad} échec(s), journaux dans ${LOGS}` : ''}`);
  console.log(`(fichiers d'essai gardés dans ${WORK})`);
  process.exitCode = bad ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

