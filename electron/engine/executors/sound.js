'use strict';
// Exécuteur « Son » : pose une musique ou un bruitage (fichier audio d'un bloc Média) sur une vidéo, par ffmpeg.
//
// « Garder » mélange le son ajouté à celui de la vidéo (volumes réglables, sans normalisation : 100 % = tel quel,
// un limiteur doux évite seulement la saturation des pics) ; « Remplacer » ne garde que le son ajouté.
// Le son ajouté commence à l'image « Départ du son », avec ses fondus d'entrée et de sortie (la sortie tombe à la fin
// du son tel qu'on l'entend : fin du fichier, ou fin de la vidéo s'il est coupé). « Couper à la fin de la vidéo »
// décoché : la dernière image reste à l'écran jusqu'à la fin du son.
// L'image n'est pas réencodée quand c'est possible (H.264/HEVC/VP9/AV1, ni transparence ni image ignorée ni
// prolongation) : seul le son est refait, en AAC 192 k stéréo 48 kHz.
// « Égaliser les niveaux » (par défaut) : comme pour un montage de film, chaque piste est
// d'abord ramenée à RMS −20 dB (mesuré par volumedetect), puis dosée par son volume — les bruitages générés sortent à
// des niveaux très différents (un projecteur à −54 dB, un impact à −13 dB). « Boucler » répète un son court.

const path = require('node:path');
const { shared: S } = require('./export.js');

const COPY_CODECS = new Set(['h264', 'hevc', 'vp9', 'av1']);
const LEVEL_DB = -20;          // niveau commun (RMS) quand on égalise
const MAX_GAIN_DB = 40;        // jamais plus : un souffle presque muet ne doit pas devenir un vacarme (les bruitages LTX sortent vers −55 dB)
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sec = (v) => Math.max(0, v).toFixed(6);

/** Niveau moyen (RMS, dB) de la 1re piste son d'un fichier, sur `dur` secondes au plus ; null si muet ou illisible. */
async function meanDb(x, abs, dur) {
  try {
    const r = await x.ffmpeg.run(['-hide_banner', '-nostdin', '-v', 'info', ...(dur ? ['-t', sec(dur)] : []), '-i', abs,
      '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], { signal: x.signal });
    const m = /mean_volume:\s*(-?[\d.]+) dB/.exec((r && r.stderr) || '');
    const v = m ? parseFloat(m[1]) : null;
    return v != null && v > -80 ? v : null;
  } catch (e) {
    if (x.signal && x.signal.aborted) throw e;
    x.log(`mesure du niveau impossible (${path.basename(abs)}) : ${e.message}`);
    return null;
  }
}
const levelGain = (db) => (db == null ? 0 : clampN(LEVEL_DB - db, -MAX_GAIN_DB, MAX_GAIN_DB));

async function run(x) {
  const { tr } = S;
  const vin = x.inputs.video;
  const ain = x.inputs.audio;
  if (!vin || !vin.abs) throw S.userError(tr(x, 'Branche une vidéo.', 'Connect a video.'));
  if (!ain || !ain.abs) {
    throw S.userError(tr(x, 'Branche un son : glisse un fichier audio (wav, mp3, m4a, flac) sur la planche puis relie-le.',
      'Connect a sound: drop an audio file (wav, mp3, m4a, flac) on the board, then wire it.'));
  }
  const report = S.reporter(x);
  report(0, tr(x, 'Lecture de la vidéo et du son…', 'Reading the video and the sound…'));

  const info = await S.inspect(x, vin, { exact: true });
  if (info.kind !== 'video') throw S.userError(tr(x, 'Son attend une vidéo, pas une image.', 'Sound expects a video, not an image.'));
  let ap = null;
  try { ap = await x.ffmpeg.probe(ain.abs); } catch (e) { x.log(`sonde du son impossible : ${e.message}`); }
  if (!ap || !(ap.kind === 'audio' || ap.hasAudio)) {
    throw S.userError(tr(x, `« ${path.basename(ain.abs)} » ne contient pas de son lisible.`,
      `“${path.basename(ain.abs)}” holds no readable sound.`));
  }

  const p = x.params || {};
  const mix = p.mode !== 'replace';
  const fps = info.fps;
  const frames = Math.max(1, info.frames || Math.round((info.duration || 1) * fps));
  const vDur = frames / fps;
  let startF = Math.round(num(p.start, 0));
  if (startF < 0) startF = frames + startF;              // -1 = dernière image, comme les autres réglages d'image
  startF = clampN(startF, 0, frames - 1);
  const s0 = startF / fps;
  const aDur = ap.duration && ap.duration > 0 ? ap.duration : null;
  const loop = !!p.loop && !!aDur;
  const fit = p.fit !== false || loop;                    // un son en boucle s'arrête avec la vidéo
  const outDur = fit || !aDur ? vDur : Math.max(vDur, s0 + aDur);
  const extra = Math.max(0, outDur - vDur);
  // durée du son ajouté qu'on entend
  const heard = Math.max(0.01, loop ? outDur - s0 : Math.min(aDur || Infinity, outDur - s0));
  let vol = clampN(num(p.volume, 100), 0, 400) / 100;
  let orig = clampN(num(p.origVolume, 100), 0, 400) / 100;
  const fin = clampN(num(p.fadeIn, 0), 0, heard);
  const fout = clampN(num(p.fadeOut, 0.5), 0, heard);
  const keepOrig = mix && info.hasAudio && orig > 0;

  // ——— niveaux ———
  const levels = { added: 0, orig: 0 };
  if (p.level !== false) {
    report(0.02, tr(x, 'Mesure des niveaux…', 'Measuring levels…'));
    levels.added = levelGain(await meanDb(x, ain.abs));
    if (keepOrig) levels.orig = levelGain(await meanDb(x, info.abs, vDur + (info.skip ? 1 / fps : 0)));
    vol *= 10 ** (levels.added / 20);
    orig *= 10 ** (levels.orig / 20);
  }

  // ——— son ———
  const fmt = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const added = [`[1:a:0]${fmt}`, `atrim=0:${sec(heard)}`, 'asetpts=PTS-STARTPTS', `volume=${vol.toFixed(4)}`];
  if (fin > 0) added.push(`afade=t=in:st=0:d=${fin.toFixed(3)}`);
  if (fout > 0) added.push(`afade=t=out:st=${sec(heard - fout)}:d=${fout.toFixed(3)}`);
  if (s0 > 0) added.push(`adelay=delays=${Math.round(s0 * 1000)}:all=1`);
  added.push('apad', `atrim=0:${sec(outDur)}`, 'asetpts=PTS-STARTPTS');
  const parts = [];
  if (keepOrig) {
    const skipA = info.skip ? `atrim=start=${sec(1 / fps)},asetpts=PTS-STARTPTS,` : '';
    parts.push(`[0:a:0]${skipA}${fmt},volume=${orig.toFixed(4)},apad,atrim=0:${sec(outDur)},asetpts=PTS-STARTPTS[orig]`);
    parts.push(`${added.join(',')}[add]`);
    // normalize=0 : chaque piste garde son volume (amix divise sinon par le nombre d'entrées) ; le limiteur ne
    // touche que les pics qui satureraient (level=0 : pas de remise à niveau automatique)
    parts.push('[orig][add]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.97:level=0:latency=1[a]');
  } else {
    parts.push(`${added.join(',')},alimiter=limit=0.97:level=0:latency=1[a]`);
  }

  // ——— image ———
  const copy = COPY_CODECS.has(info.codec) && !info.alpha && !info.skip && extra <= 0;
  const out = path.join(x.outDir, 'video.mp4');
  const msg = mix
    ? tr(x, 'Mélange du son…', 'Mixing the sound…')
    : tr(x, 'Pose du nouveau son…', 'Laying the new sound…');
  const inputs = [...S.decoderArgs(info), '-i', info.abs, ...(loop ? ['-stream_loop', '-1'] : []), '-i', ain.abs];
  const opts = { duration: outDur, onProgress: report.span(0.03, 0.97, msg) };
  let n = frames;
  if (copy) {
    await S.ff(x, ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...inputs,
      '-filter_complex', parts.join(';'), '-map', '0:v:0', '-map', '[a]', '-c:v', 'copy',
      ...S.audioArgs(192), '-ar', '48000', '-movflags', '+faststart', out], opts);
  } else {
    const rate = S.fpsExpr(fps);
    const vf = [];
    if (info.skip) vf.push('trim=start_frame=1');
    if (info.alpha) vf.push(S.flatten(info));            // une vidéo transparente est posée sur du noir
    if (info.w % 2 || info.h % 2) vf.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
    if (extra > 0) {
      // la dernière image reste jusqu'à la fin du son (tpad AVANT setpts : derrière, il n'ajoute rien)
      n = frames + Math.round(extra * fps);
      vf.push(`tpad=stop_mode=clone:stop=${n - frames}`);
    }
    vf.push(`setpts=N/(${rate}*TB)`, `trim=end_frame=${n}`, 'format=yuv420p');
    parts.push(`[0:v:0]${vf.join(',')}[v]`);
    await S.encode(x, (nv) => ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...inputs,
      '-filter_complex', parts.join(';'), '-map', '[v]', '-map', '[a]', '-r', rate, '-fps_mode', 'cfr',
      ...S.h264Args(nv, { cq: 14, gop: 12 }), ...S.audioArgs(192), '-ar', '48000', out], opts);
  }
  if (!S.fileOk(out)) throw S.userError(tr(x, 'Le son n’a rien produit.', 'Sound produced nothing.'));
  const counted = (await S.countFrames(x, out)) || n;
  const W = info.w - (info.w % 2);
  const H = info.h - (info.h % 2);
  report(1, mix && info.hasAudio
    ? tr(x, 'Son mélangé à celui de la vidéo', 'Sound mixed with the video’s')
    : tr(x, 'Son posé sur la vidéo', 'Sound laid on the video'));
  return {
    outputs: { video: { abs: out, kind: 'video', meta: { w: W, h: H, fps, frames: counted, duration: counted / fps } } },
    notes: { mode: mix ? 'mix' : 'replace', start: startF, audio: path.basename(ain.abs), reencoded: !copy,
      loop, levelDb: { added: Math.round(levels.added * 10) / 10, orig: Math.round(levels.orig * 10) / 10 } },
  };
}

module.exports = { run, estimate: (x) => {
  const m = x && x.inputs && x.inputs.video && x.inputs.video.meta;
  return Math.max(0.1, Math.min(5, ((m && m.duration) || 10) / 120));
} };
