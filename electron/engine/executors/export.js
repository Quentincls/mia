'use strict';
// Exécuteur « Exporter » (+ boîte à outils commune des exécuteurs légers de Mia).
//
// Exporter écrit le résultat dans <projet>\A_regarder\ : MP4 haute qualité, MP4 « téléphone » (léger : ~25 Mo
// au plus, débit borné par la taille d'image et jamais au-dessus de la source, deux passes), PNG pour une image ou
// suite PNG (un dossier) pour une vidéo.
// Le bloc n'a pas de sortie : on rend { outputs: {}, notes: { exported, kind, bytes } } ET on écrit le même objet
// dans « exported.json » à côté de run.json, pour que l'interface puisse toujours montrer le fichier et
// « Afficher dans l'Explorateur ». Jamais d'écrasement : un nom déjà pris reçoit « (2) ».
//
// La boîte à outils (`shared`) est ici parce qu'Exporter est le bloc qui fixe la qualité d'encodage de Mia :
// un seul endroit pour les réglages H.264/NVENC, le repli processeur, la sonde et les messages d'erreur.
// trim.js, resize.js, sequence.js, frame.js, cutout.js et composite.js s'en servent.

const fs = require('node:fs');
const path = require('node:path');

// ——————————————————————————————————————————————————————— boîte à outils commune

const IMAGE_RE = /\.(png|jpe?g|webp|bmp|tiff?|exr|psd|tga|gif)$/i;
const MB = 1000 * 1000;

const lang = (x) => (x && x.lang === 'en' ? 'en' : 'fr');
/** Chaîne dans la langue de l'interface (français par défaut : Quentin ne lit pas l'anglais). */
const tr = (x, fr, en) => (lang(x) === 'en' ? en : fr);

/** Erreur « annulé » reconnaissable par le moteur (name AbortError + cancelled). */
function cancelled(x) {
  const e = new Error(tr(x, 'Calcul annulé.', 'Cancelled.'));
  e.name = 'AbortError';
  e.cancelled = true;
  return e;
}
function checkAbort(x) { if (x.signal && x.signal.aborted) throw cancelled(x); }

/** Erreur dont le message s'affiche tel quel dans le bloc (userMessage : même convention que ffmpeg.js). */
function userError(msg, extra) { return Object.assign(new Error(msg), { user: true, userMessage: msg }, extra || {}); }

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Cadence lisible par ffmpeg ; les cadences NTSC (23,976…) restent exactes. */
function fpsExpr(fps) {
  const f = Number(fps) || 24;
  for (const [n, d] of [[24000, 1001], [30000, 1001], [60000, 1001], [120000, 1001]]) {
    if (Math.abs(f - n / d) < 0.006) return `${n}/${d}`;
  }
  return String(Math.round(f * 1000) / 1000);
}

/** Chemin relatif au projet, séparateur « / » (format de run.json). */
function relOf(x, abs) { return path.relative(x.projectDir, abs).split(path.sep).join('/'); }

function fileOk(abs) {
  try { return fs.statSync(abs).size > 0; } catch { return false; }
}

/**
 * Progression globale avec temps restant (mesuré depuis le début de l'exécuteur).
 * `span(a, b, msg)` rend un rappel p∈0..1 → progression a..b, à passer à ffmpeg.run.
 */
function reporter(x) {
  const t0 = Date.now();
  const report = (q, msg) => {
    if (q == null || !Number.isFinite(q)) { x.progress(null, msg); return; }
    q = clamp01(q);
    const el = (Date.now() - t0) / 1000;
    const eta = q > 0.03 && el > 1 ? Math.round((el * (1 - q)) / q) : null;
    x.progress(q, msg, eta);
  };
  report.span = (a, b, msg) => (p) => report(a + (b - a) * clamp01(Number(p) || 0), msg);
  return report;
}

/** NVENC utilisable ? (règle du labo : encoder sur le GPU ; MIA_NO_NVENC=1 pour les essais). */
async function useNvenc(x) {
  if (/^(1|true|yes)$/i.test(process.env.MIA_NO_NVENC || '')) return false;
  try { return !!(await x.ffmpeg.nvenc()); } catch { return false; }
}

/**
 * Arguments H.264 standard de Mia. Fichiers de travail : cq 14 et GOP court (relus image par image dans les blocs) ;
 * livraison : cq 16, GOP par défaut. 4:2:0 8 bits + faststart : lu partout, Chromium compris.
 */
function h264Args(nvenc, { cq = 16, gop = null } = {}) {
  const a = nvenc
    ? ['-c:v', 'h264_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', String(cq), '-b:v', '0', '-profile:v', 'high']
    : ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(cq), '-profile:v', 'high'];
  if (gop) a.push('-g', String(gop));
  a.push('-pix_fmt', 'yuv420p', '-movflags', '+faststart');
  return a;
}

/**
 * WebM VP9 transparent (processeur : NVENC ne sait pas faire d'alpha). Réservé aux vidéos qui en ont un.
 * -map_metadata -1 : sinon l'étiquette « alpha_mode » de la source est recopiée en « ALPHA_MODE » et masque, à la
 * relecture, l'élément AlphaMode que le muxer écrit de lui-même (celui que Chromium et la sonde lisent).
 */
function vp9AlphaArgs() {
  return ['-map_metadata', '-1', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '20',
    '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-auto-alt-ref', '0', '-g', '12'];
}

/**
 * Options de lecture à placer avant « -i » : le décodeur natif de VP8/VP9 ignore l'alpha rangé à part (libvpx le
 * lit) ; un EXR « beauty » d'Unreal est linéaire et doit passer en sRGB (comme les aperçus de ffmpeg.js).
 */
function decoderArgs(info) {
  if (/\.exr$/i.test(info.abs || '')) return ['-apply_trc', 'iec61966_2_1'];
  if (!info.alpha) return [];
  if (info.codec === 'vp9') return ['-c:v', 'libvpx-vp9'];
  if (info.codec === 'vp8') return ['-c:v', 'libvpx'];
  return [];
}

/**
 * Une source transparente vers une sortie opaque (MP4, JPEG) : la couleur est posée sur du noir. Sans ça, ce que le
 * détourage avait caché (le fond d'origine, gardé sous l'alpha) réapparaîtrait.
 */
const flatten = (info) => (info.alpha ? 'premultiply=inplace=1' : null);

const audioArgs = (kbps = 192) => ['-c:a', 'aac', '-b:a', `${kbps}k`, '-ac', '2'];

/**
 * Tout ce qu'il faut savoir d'une entrée : la sonde de ffmpeg.js complétée par les méta du catalogue.
 * `exact` : compte réel des images (et durée de la piste VIDÉO) au lieu de l'estimation « durée × cadence » —
 * la durée du conteneur suit souvent le son, plus long que l'image de quelques dixièmes.
 * `skipFirst` (bloc Média, rendus Unreal à 1re image ratée) est retranché du compte d'images.
 */
async function inspect(x, input, { exact = false } = {}) {
  if (!input || !input.abs) throw userError(tr(x, 'Une entrée n’est pas branchée.', 'An input is not connected.'));
  const name = path.basename(input.abs);
  if (!fs.existsSync(input.abs)) throw userError(tr(x, `Fichier introuvable : ${name}`, `File not found: ${name}`));
  const meta = input.meta || {};
  let p = null;
  let probeErr = null;
  try { p = await x.ffmpeg.probe(input.abs); } catch (e) { probeErr = e; x.log(`sonde impossible (${name}) : ${e && e.message}`); }
  const kind = input.kind || (p && p.kind) || (IMAGE_RE.test(input.abs) ? 'image' : 'video');
  let bytes = 0;
  try { bytes = fs.statSync(input.abs).size; } catch { /* taille inconnue : pas de plafond tiré de la source */ }
  const info = {
    abs: input.abs, name, kind, bytes,
    w: (p && p.w) || meta.w || 0,
    h: (p && p.h) || meta.h || 0,
    fps: (p && p.fps) || meta.fps || null,
    frames: meta.frames || (p && p.frames) || null,
    duration: (p && p.duration) || meta.duration || null,
    codec: (p && p.codec) || meta.codec || null,
    pixfmt: (p && p.pixfmt) || null,
    alpha: !!((p && p.alpha) || meta.alpha),
    hasAudio: !!(p && p.hasAudio),
    skip: kind === 'video' && (input.skipFirst || meta.skipFirst) ? 1 : 0,
  };
  if (kind === 'video') {
    if (!info.fps) info.fps = 24;
    const n = exact ? await countFrames(x, input.abs) : null;
    if (n) { info.frames = n; info.duration = n / info.fps; info.exact = true; }
    if (!info.frames && info.duration) info.frames = Math.round(info.duration * info.fps);
    if (!info.duration && info.frames) info.duration = info.frames / info.fps;
    if (info.skip && info.frames) { info.frames -= 1; info.duration = info.frames / info.fps; }
  }
  if (!info.w || !info.h) {
    // ffmpeg's own sentence when it has one (« ffmpeg est introuvable : configure le moteur… »)
    if (probeErr && typeof probeErr.userMessage === 'string' && probeErr.userMessage) throw userError(probeErr.userMessage);
    throw userError(tr(x, `Fichier illisible : ${name}`, `Unreadable file: ${name}`));
  }
  return info;
}

/**
 * Nombre EXACT d'images d'une vidéo (la sonde par « ffmpeg -i » n'en donne qu'une estimation) :
 * on recopie les paquets vidéo vers un framecrc (une ligne par image, sans décoder) et on compte.
 */
async function countFrames(x, abs) {
  const crc = path.join(x.outDir, '_frames.crc');
  try {
    await ff(x, ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-i', abs, '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', crc]);
    const n = fs.readFileSync(crc, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#')).length;
    return n > 0 ? n : null;
  } catch (e) {
    if (e.cancelled) throw e;
    x.log(`comptage des images impossible : ${e.message}`);
    return null;
  } finally {
    fs.rm(crc, { force: true }, () => {});
  }
}

const NVENC_FAIL = /\[h264_nvenc|OpenEncodeSession|nvcuda|No NVENC capable|CUDA_ERROR|Cannot load.*nv|InitializeEncoder|Driver does not support the required nvenc API/i;

/** Message d'échec lisible à partir du stderr de ffmpeg (le détail complet part dans le journal). */
function ffError(x, stderr, args, code) {
  const text = String(stderr || '').trim();
  const last = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-1)[0] || '';
  x.log(`ffmpeg ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
  if (text) x.log(text.split(/\r?\n/).slice(-25).join('\n'));
  let msg;
  if (/No space left|ENOSPC/i.test(text)) msg = tr(x, 'Disque plein.', 'Disk full.');
  else if (/Permission denied|EACCES|EBUSY/i.test(text)) msg = tr(x, 'Accès refusé : le fichier est peut-être ouvert dans une autre application.', 'Access denied: the file may be open in another application.');
  else if (/No such file or directory|ENOENT/i.test(text)) msg = tr(x, 'Fichier introuvable.', 'File not found.');
  else if (/Invalid data found|moov atom not found|could not find codec parameters|Error while decoding/i.test(text)) msg = tr(x, 'Fichier vidéo illisible ou incomplet.', 'Unreadable or incomplete video file.');
  else if (/Output file is empty|nothing was encoded/i.test(text)) msg = tr(x, 'Rien n’a été produit : la plage choisie est peut-être hors de la vidéo.', 'Nothing was produced: the chosen range may be outside the video.');
  else msg = tr(x, `ffmpeg a échoué${code != null ? ` (code ${code})` : ''} : ${last.slice(0, 160) || 'erreur inconnue'}.`,
    `ffmpeg failed${code != null ? ` (code ${code})` : ''}: ${last.slice(0, 160) || 'unknown error'}.`);
  return userError(msg, { nvenc: NVENC_FAIL.test(text), stderr: text });
}

/** Lance ffmpeg (ffmpeg.js de Mia), relaie l'annulation, transforme un échec en message lisible. */
async function ff(x, args, { duration, onProgress } = {}) {
  checkAbort(x);
  let res;
  try {
    res = await x.ffmpeg.run(args, { duration: duration || undefined, onProgress, signal: x.signal });
  } catch (e) {
    if (x.signal && x.signal.aborted) throw cancelled(x);
    if (e && e.user) throw e;
    // ffmpeg.js a déjà formulé le problème (ffmpeg introuvable, délai dépassé…) : on le garde tel quel.
    if (e && e.userMessage && !e.stderr) throw userError(e.userMessage);
    throw ffError(x, (e && (e.stderr || e.message)) || String(e), args, e && e.code);
  }
  if (x.signal && x.signal.aborted) throw cancelled(x);
  if (!res || res.code !== 0) throw ffError(x, res && res.stderr, args, res && res.code);
  return res;
}

/**
 * Encode avec NVENC, et refait la même chose sur le processeur si NVENC refuse (pilote, sessions épuisées).
 * `build(nvenc)` rend les arguments complets.
 */
async function encode(x, build, opts = {}) {
  const nv = await useNvenc(x);
  try {
    return await ff(x, build(nv), opts);
  } catch (e) {
    if (!nv || !e.nvenc || e.cancelled) throw e;
    x.log('NVENC indisponible : nouvel essai avec libx264 (processeur).');
    x.progress(null, tr(x, 'Encodage sur le processeur (plus lent)…', 'Encoding on the CPU (slower)…'));
    return ff(x, build(false), opts);
  }
}

/** Libellé d'un modèle de l'inventaire dans la langue de l'interface. */
function modelLabel(x, model, fallback) {
  const l = model && model.label;
  if (!l) return fallback;
  return typeof l === 'string' ? l : l[lang(x)] || l.fr || fallback;
}

/**
 * Lance une tâche du worker Python (python/tasks/<task>.py) par x.py (pyrun.js) et rend ses sorties
 * au format du moteur : { port: { abs, kind, meta } }, fichiers vérifiés dans outDir.
 */
async function runWorker(x, task, payload) {
  if (!x.py || typeof x.py.run !== 'function') {
    throw userError(tr(x, 'Le moteur Python de Mia est indisponible.', 'Mia\'s Python engine is unavailable.'));
  }
  checkAbort(x);
  const onProgress = (a, b, c) => {
    // pyrun peut relayer (p, msg, eta) ou l'objet du protocole tel quel : les deux sont acceptés.
    if (a && typeof a === 'object') {
      if (a.preview) { x.preview(a.preview); return; }
      x.progress(a.p ?? null, a.msg, a.eta);
    } else x.progress(a ?? null, b, c);
  };
  // the worker encodes with the same ffmpeg as Mia (engine, ComfyUI portable or PATH): job.ffmpeg
  let ffmpeg;
  try { ffmpeg = (x.ffmpeg && typeof x.ffmpeg.ffmpegPath === 'function' && x.ffmpeg.ffmpegPath()) || undefined; } catch { ffmpeg = undefined; }
  const res = await x.py.run(task, { ffmpeg, ...payload, task, lang: lang(x), outDir: x.outDir }, {
    cwd: x.outDir, signal: x.signal, onProgress,
    onPreview: (p) => x.preview(p),
    onLog: (line) => x.log(line),
  });
  checkAbort(x);
  const outs = (res && res.outputs) || {};
  const root = path.resolve(x.outDir).toLowerCase();
  const outputs = {};
  for (const [port, o] of Object.entries(outs)) {
    if (!o || !o.abs) continue;
    const abs = path.resolve(o.abs);
    if (!abs.toLowerCase().startsWith(root + path.sep) || !fileOk(abs)) {
      throw userError(tr(x, `Sortie « ${port} » absente ou hors du dossier du calcul.`, `Output "${port}" missing or outside the job folder.`));
    }
    outputs[port] = { abs, kind: o.kind === 'image' ? 'image' : 'video', meta: o.meta || undefined };
  }
  return outputs;
}

// ——————————————————————————————————————————————————————— Exporter

const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const PHONE_LIMIT = 30 * MB;            // promesse du libellé « < 30 Mo »
const PHONE_TARGET = 25 * MB;           // visée pour une vidéo longue (marge pour le conteneur et les écarts du débit)
const PHONE_BPP = 0.12;                 // bits par pixel et par image : net sur un téléphone (~1,2 Mb/s en 480×848 à
                                        // 24 i/s, ~7,5 Mb/s en 1080p30) — un clip court n'a pas à remplir 25 Mo
const PHONE_MIN_KBPS = 150;
/** Codecs avec perte : leur débit est celui de l'export HQ (recopie) ou s'en approche ; le téléphone reste dessous. */
const LOSSY = /^(h264|hevc|h265|vp8|vp9|av1|mpeg4|mpeg2video|mpeg1video|wmv\d|msmpeg4.*|theora|mjpeg)$/i;

function cleanName(s) {
  let n = String(s || '').replace(FORBIDDEN, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  n = n.replace(/\.(mp4|mov|png|jpe?g|webm)$/i, '').trim();
  if (RESERVED.test(n)) n = `_${n}`;
  return n.slice(0, 120);
}

function stamp() {
  const d = new Date();
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}h${p(d.getMinutes())}`;
}

/** Nom du bloc qui a produit l'entrée (lu dans run.json + le catalogue), pour un nom automatique parlant. */
function sourceLabel(x, input) {
  try {
    const rel = relOf(x, input.abs);
    if (rel.startsWith('media/')) return path.parse(input.abs).name;
    const m = /^outputs\/[^/]+\/[^/]+\//.exec(rel);
    if (m) {
      const run = JSON.parse(fs.readFileSync(path.join(x.projectDir, m[0], 'run.json'), 'utf8'));
      const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'catalog', 'nodes.json'), 'utf8'));
      const t = cat.types.find((ty) => ty.id === run.type);
      if (t && t.label) return t.label[lang(x)] || t.label.fr;
    }
  } catch { /* pas de run.json lisible : nom de projet */ }
  return path.basename(x.projectDir);
}

/** Premier chemin libre : « nom.ext », puis « nom (2).ext »… (jamais d'écrasement d'un export précédent). */
function freePath(dir, base, ext) {
  for (let k = 1; k < 1000; k++) {
    const p = path.join(dir, `${base}${k > 1 ? ` (${k})` : ''}${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  throw new Error('nom libre introuvable');
}

/** Déplace le fichier (ou dossier) fini à sa place définitive ; repli copie si le disque diffère. */
function moveInto(src, dst) {
  try { fs.renameSync(src, dst); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(src, dst, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

/** Débits des pistes vidéo et son annoncés par « ffmpeg -i » (« … 24 fps, 4180 kb/s ») : {video, audio}, null si absent. */
async function streamKbps(x, abs) {
  const out = { video: null, audio: null };
  try {
    const r = await x.ffmpeg.run(['-hide_banner', '-nostdin', '-i', abs], { signal: x.signal });
    const lines = String((r && r.stderr) || '').split(/\r?\n/);
    const first = (re) => lines.find((l) => re.test(l) && !/attached pic/.test(l));
    for (const [key, re] of [['video', /^\s*Stream #0:\d+[^:]*: Video: /], ['audio', /^\s*Stream #0:\d+[^:]*: Audio: /]]) {
      const m = /(\d+(?:\.\d+)?) kb\/s/.exec(first(re) || '');
      if (m) out[key] = parseFloat(m[1]);
    }
  } catch { /* débits inconnus : plafonds par la taille d'image et le budget seulement */ }
  return out;
}

/** Débit vidéo de la source en kb/s : celui de la piste, sinon taille du fichier moins un son estimé ; null si inconnu. */
function sourceVideoKbps(info) {
  if (info.videoKbps) return info.videoKbps;
  if (!info.bytes || !info.duration) return null;
  const kbps = (info.bytes * 8) / info.duration / 1000 - (info.hasAudio ? 192 : 0);
  return kbps > 0 ? kbps : null;
}

/**
 * Plan de l'export téléphone : débit vidéo (kb/s), son, côté long de sortie. Trois plafonds, le plus bas gagne :
 *  - le budget : ~25 Mo pour toute la durée (vidéo longue) ;
 *  - la taille d'image : PHONE_BPP bit par pixel et par image (clip court : inutile de remplir 25 Mo) ;
 *  - la source : 80 % de son débit si elle est déjà compressée (le fichier téléphone ne dépasse jamais le HQ).
 * `scale` < 1 : nouvel essai plus léger si le premier a dépassé.
 */
function phonePlan(info, scale = 1) {
  const fps = info.fps || 24;
  const dur = Math.max(0.5, info.duration || (info.frames || 1) / fps);
  // AAC 128 kb/s, ou moins si la source est déjà plus légère (un son mono à 70 kb/s ne gagne rien à doubler).
  const audio = info.hasAudio ? Math.round(Math.max(64, Math.min(128, info.audioKbps || 128))) : 0;
  const budget = Math.floor(((PHONE_TARGET * 8) / dur / 1000) - audio - 16);
  const long = Math.max(info.w, info.h);
  // Peu de débit (vidéo très longue) : image plus petite mais nette, plutôt que grande et pâteuse.
  const side = Math.min(long, budget < 1000 ? 960 : budget < 2500 ? 1280 : 1920);
  const k = side / long;
  const pixels = even(info.w * k) * even(info.h * k);
  const caps = [budget, Math.round((pixels * fps * PHONE_BPP) / 1000)];
  const src = LOSSY.test(info.codec || '') ? sourceVideoKbps(info) : null;
  if (src) caps.push(Math.floor(src * 0.8));
  // Plancher de lisibilité, sauf si la source elle-même est encore plus légère (le plafond « source » prime).
  const floor = src ? Math.max(50, Math.min(PHONE_MIN_KBPS, Math.floor(src * 0.8 * scale))) : PHONE_MIN_KBPS;
  const video = Math.max(floor, Math.floor(Math.min(...caps) * scale));
  return { video, audio, side, caps };
}

function scaleToLongSide(info, side) {
  if (Math.max(info.w, info.h) <= side && info.w % 2 === 0 && info.h % 2 === 0) return null;
  const k = Math.min(1, side / Math.max(info.w, info.h));
  return `scale=${even(info.w * k)}:${even(info.h * k)}:flags=lanczos`;
}

async function exportVideoHQ(x, info, tmp, report) {
  // Déjà du H.264 4:2:0 8 bits : simple recopie, sans nouvelle génération d'encodage (règle du labo).
  const copyable = info.codec === 'h264' && /^yuv(j)?420p$/.test(info.pixfmt || '') && !info.skip &&
    info.w % 2 === 0 && info.h % 2 === 0;
  const common = ['-hide_banner', '-nostdin', '-y', '-v', 'error'];
  if (copyable) {
    // L'image est recopiée telle quelle ; le son est remis en AAC (un MOV peut porter du PCM, refusé par le MP4).
    report(0.05, tr(x, 'Copie sans réencodage…', 'Copying without re-encoding…'));
    await ff(x, [...common, '-i', info.abs, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy',
      ...(info.hasAudio ? audioArgs(256) : ['-an']), '-movflags', '+faststart', tmp],
    { duration: info.duration, onProgress: report.span(0.05, 0.95, tr(x, 'Copie…', 'Copying…')) });
    return;
  }
  const vf = [info.skip ? 'trim=start_frame=1,setpts=PTS-STARTPTS' : null, flatten(info),
    (info.w % 2 || info.h % 2) ? 'scale=trunc(iw/2)*2:trunc(ih/2)*2' : null, 'format=yuv420p'].filter(Boolean).join(',');
  const af = info.skip ? ['-af', `atrim=start=${(1 / info.fps).toFixed(6)},asetpts=PTS-STARTPTS`] : [];
  const msg = tr(x, 'Encodage haute qualité…', 'High-quality encode…');
  await encode(x, (nv) => [...common, ...decoderArgs(info), '-i', info.abs, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', vf, ...h264Args(nv, { cq: 16 }), ...(info.hasAudio ? [...af, ...audioArgs(256)] : ['-an']), tmp],
  { duration: info.duration, onProgress: report.span(0.02, 0.97, msg) });
}

async function exportVideoPhone(x, info, tmp, report) {
  const common = ['-hide_banner', '-nostdin', '-y', '-v', 'error'];
  const passlog = path.join(x.outDir, '_x264pass');
  // Plus lourd que le HQ ? Seulement si la source est déjà compressée : le HQ est alors sa recopie (ou presque).
  const hqBytes = LOSSY.test(info.codec || '') && info.bytes ? info.bytes : null;
  const rates = await streamKbps(x, info.abs);
  if (LOSSY.test(info.codec || '')) info.videoKbps = rates.video;
  info.audioKbps = rates.audio;
  for (const attempt of [1, 0.7]) {        // rare dépassement (scène très chargée) : un 2e essai à 70 % du débit
    const plan = phonePlan(info, attempt);
    x.log(`téléphone : visée ${plan.video} kb/s (plafonds ${plan.caps.join(' / ')} kb/s), côté long ${plan.side}`);
    const vf = [info.skip ? 'trim=start_frame=1,setpts=PTS-STARTPTS' : null, flatten(info),
      scaleToLongSide(info, plan.side), 'format=yuv420p'].filter(Boolean).join(',');
    const rate = ['-b:v', `${plan.video}k`, '-maxrate', `${Math.round(plan.video * 1.5)}k`, '-bufsize', `${plan.video * 2}k`];
    const audio = info.hasAudio
      ? [...(info.skip ? ['-af', `atrim=start=${(1 / info.fps).toFixed(6)},asetpts=PTS-STARTPTS`] : []), ...audioArgs(plan.audio)]
      : ['-an'];
    const msg = tr(x, 'Encodage pour téléphone…', 'Encoding for phone…');
    const nv = await useNvenc(x);
    let done = false;
    if (nv) {
      // NVENC fait ses deux passes lui-même (multipass pleine résolution), en un seul appel.
      try {
        await ff(x, [...common, ...decoderArgs(info), '-i', info.abs, '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf,
          '-c:v', 'h264_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-multipass', 'fullres', ...rate,
          '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', ...audio, tmp],
        { duration: info.duration, onProgress: report.span(0.02, 0.95, msg) });
        done = true;
      } catch (e) {
        if (!e.nvenc || e.cancelled) throw e;
        x.log('NVENC indisponible : deux passes libx264 (processeur).');
      }
    }
    if (!done) {
      // libx264 : vraie double passe (analyse, puis encodage au débit visé).
      const nul = process.platform === 'win32' ? 'NUL' : '/dev/null';
      const x264 = ['-c:v', 'libx264', '-preset', 'medium', ...rate, '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-passlogfile', passlog];
      await ff(x, [...common, ...decoderArgs(info), '-i', info.abs, '-map', '0:v:0', '-vf', vf, ...x264, '-pass', '1', '-an', '-f', 'null', nul],
        { duration: info.duration, onProgress: report.span(0.02, 0.45, tr(x, 'Analyse (1re passe)…', 'Analysis (1st pass)…')) });
      await ff(x, [...common, ...decoderArgs(info), '-i', info.abs, '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf, ...x264, '-pass', '2',
        '-movflags', '+faststart', ...audio, tmp],
      { duration: info.duration, onProgress: report.span(0.45, 0.95, tr(x, 'Encodage (2e passe)…', 'Encoding (2nd pass)…')) });
      for (const f of fs.readdirSync(x.outDir)) if (f.startsWith('_x264pass')) fs.rmSync(path.join(x.outDir, f), { force: true });
    }
    const size = fs.statSync(tmp).size;
    x.log(`téléphone : ${(size / MB).toFixed(2)} Mo à ${plan.video} kb/s${hqBytes ? ` (source ${(hqBytes / MB).toFixed(2)} Mo)` : ''}`);
    if (size < PHONE_LIMIT && (!hqBytes || size < hqBytes)) return;
    if (attempt !== 1 && size < PHONE_LIMIT) {
      // Toujours plus lourd que la source après le 2e essai (clip minuscule où le conteneur et le son pèsent) :
      // le fichier reste valable et sous 30 Mo, on le garde.
      x.log('téléphone : pas plus léger que la source, gardé tel quel');
      return;
    }
  }
  throw userError(tr(x, 'Impossible de tenir sous 30 Mo : la vidéo est trop longue pour ce format.',
    'Could not stay under 30 MB: the video is too long for this format.'));
}

async function exportSequence(x, info, tmpDir, base, report) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const digits = Math.max(4, String(Math.max(0, (info.frames || 1) - 1)).length);
  const vf = [info.skip ? 'trim=start_frame=1,setpts=PTS-STARTPTS' : null, info.alpha ? 'format=rgba' : 'format=rgb24']
    .filter(Boolean).join(',');
  // « nom.0000.png » : la convention de nommage d'Unreal, que Quentin et les logiciels de montage reconnaissent.
  await ff(x, ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...decoderArgs(info), '-i', info.abs, '-map', '0:v:0',
    '-vf', vf, '-fps_mode', 'passthrough', '-start_number', '0', '-compression_level', '4',
    path.join(tmpDir, `${base}.%0${digits}d.png`)],
  { duration: info.duration, onProgress: report.span(0.02, 0.97, tr(x, 'Écriture des images PNG…', 'Writing PNG frames…')) });
}

async function exportImage(x, info, tmp, asJpeg, report) {
  const ext = path.extname(info.abs).toLowerCase();
  if (!asJpeg && ext === '.png') { fs.copyFileSync(info.abs, tmp); return; }   // déjà un PNG : copie exacte
  report(0.2, tr(x, 'Conversion de l’image…', 'Converting the image…'));
  const fmt = asJpeg ? ['-vf', info.alpha ? 'format=rgba,premultiply=inplace=1,format=yuvj444p' : 'format=yuvj444p', '-q:v', '2'] : ['-vf', info.alpha ? 'format=rgba' : 'format=rgb24', '-compression_level', '4'];
  await ff(x, ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...decoderArgs(info), '-i', info.abs, '-frames:v', '1', ...fmt, tmp]);
}

async function run(x) {
  const input = Array.isArray(x.inputs.media) ? x.inputs.media[0] : x.inputs.media;
  if (!input || !input.abs) throw userError(tr(x, 'Branche une image ou une vidéo à exporter.', 'Connect an image or a video to export.'));
  const report = reporter(x);
  report(0, tr(x, 'Préparation de l’export…', 'Preparing the export…'));
  const info = await inspect(x, input);
  const format = ['mp4', 'phone', 'png'].includes(x.params.format) ? x.params.format : 'mp4';

  const dir = path.join(x.projectDir, 'A_regarder');
  fs.mkdirSync(dir, { recursive: true });
  let base = cleanName(x.params.name);
  if (!base) {
    base = cleanName(`${sourceLabel(x, input)} ${stamp()}`) || 'Mia';
    if (format === 'phone') base += tr(x, ' (téléphone)', ' (phone)');
  }

  let final, kind;
  try {
    if (info.kind === 'image') {
      const jpeg = format === 'phone';       // une image « pour téléphone » : un JPEG léger, pas une vidéo
      const ext = jpeg ? '.jpg' : '.png';
      const tmp = path.join(x.outDir, `_export${ext}`);
      await exportImage(x, info, tmp, jpeg, report);
      final = freePath(dir, base, ext); kind = 'image';
      moveInto(tmp, final);
    } else if (format === 'png') {
      const tmpDir = path.join(x.outDir, '_export_png');
      fs.rmSync(tmpDir, { recursive: true, force: true });
      await exportSequence(x, info, tmpDir, base, report);
      final = freePath(dir, base, ''); kind = 'sequence';
      moveInto(tmpDir, final);
    } else {
      const tmp = path.join(x.outDir, '_export.mp4');
      if (format === 'phone') await exportVideoPhone(x, info, tmp, report);
      else await exportVideoHQ(x, info, tmp, report);
      final = freePath(dir, base, '.mp4'); kind = 'video';
      moveInto(tmp, final);
    }
  } finally {
    removeTemp(x);                           // annulé ou en échec : rien de partiel ne reste dans le dossier du run
  }

  let files;
  let bytes;
  if (kind === 'sequence') {
    const names = fs.readdirSync(final);
    files = names.length;
    bytes = names.reduce((s, f) => s + fs.statSync(path.join(final, f)).size, 0);
  } else bytes = fs.statSync(final).size;
  const rel = relOf(x, final);
  x.log(`exporté : ${rel} (${(bytes / MB).toFixed(2)} Mo)`);
  const notes = { exported: rel, kind, bytes, ...(files != null ? { files } : {}) };
  // Copie à côté de run.json : l'interface retrouve l'export même si elle ne lit pas les notes du run.
  writeJson(path.join(x.outDir, 'exported.json'), { ...notes, name: path.basename(final), format, at: Date.now() }, x);
  report(1, tr(x, `Exporté : ${path.basename(final)}`, `Exported: ${path.basename(final)}`));
  return { outputs: {}, notes };
}

/** Fichiers de travail de l'export (« _export… », journaux de passe libx264). */
function removeTemp(x) {
  let names = [];
  try { names = fs.readdirSync(x.outDir); } catch { return; }
  for (const f of names) {
    if (f.startsWith('_export') || f.startsWith('_x264pass')) {
      try { fs.rmSync(path.join(x.outDir, f), { recursive: true, force: true }); } catch { /* fichier tenu : tant pis */ }
    }
  }
}

/** Écriture atomique d'un petit JSON (jamais à moitié écrit si Mia se ferme au même instant). */
function writeJson(file, data, x) {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    x.log(`${path.basename(file)} non écrit : ${e.message}`);
    try { fs.rmSync(tmp, { force: true }); } catch { /* rien */ }
  }
}

/** Minutes estimées (pour l'heure de fin affichée) : un export prend quelques secondes à une minute. */
function estimate(x) {
  const m = x && x.inputs && x.inputs.media && x.inputs.media.meta;
  const dur = (m && m.duration) || 10;
  return Math.max(0.1, Math.min(10, dur / 60 * (x.params && x.params.format === 'phone' ? 0.8 : 0.4)));
}

module.exports = {
  run,
  estimate,
  shared: {
    lang, tr, cancelled, checkAbort, userError, clamp01, even, fpsExpr, relOf, fileOk, reporter, useNvenc,
    h264Args, vp9AlphaArgs, decoderArgs, flatten, audioArgs, inspect, countFrames, ff, encode, modelLabel, runWorker,
    cleanName,
  },
};
