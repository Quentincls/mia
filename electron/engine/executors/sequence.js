'use strict';
// Exécuteur « Assembler » : met plusieurs vidéos bout à bout, dans l'ordre des fils (ordre vertical des blocs,
// résolu par le moteur).
//
// Tout est ramené au format du PREMIER clip : taille (ajustée, bandes noires, jamais déformée) et cadence.
// « Passage au noir » = un court fondu au noir en fin de clip puis depuis le noir au début du suivant ; jamais de
// fondu enchaîné (règle de Quentin : double exposition entre deux générations). Le son suit s'il existe (silence
// pour les clips muets, pour que l'image et le son restent calés).

const path = require('node:path');
const { shared: S } = require('./export.js');

const DIP_S = 0.3;   // durée de chaque moitié du passage au noir (≈ 7 images à 24 i/s)

async function run(x) {
  const { tr } = S;
  const list = (Array.isArray(x.inputs.clips) ? x.inputs.clips : [x.inputs.clips]).filter((c) => c && c.abs);
  if (!list.length) throw S.userError(tr(x, 'Branche au moins une vidéo.', 'Connect at least one video.'));
  const report = S.reporter(x);
  report(0, tr(x, 'Lecture des clips…', 'Reading the clips…'));

  const clips = [];
  for (const c of list) {
    // Durée de la piste IMAGE (compte exact) : celle du conteneur suit souvent un son plus long, et le
    // calage du son de chaque clip se fait sur l'image.
    const info = await S.inspect(x, c, { exact: true });
    if (info.kind !== 'video') {
      throw S.userError(tr(x, `Assembler n’accepte que des vidéos (${info.name} est une image).`,
        `Join clips only accepts videos (${info.name} is an image).`));
    }
    clips.push(info);
  }

  const first = clips[0];
  const W = S.even(first.w), H = S.even(first.h);
  const fps = S.fpsExpr(first.fps);
  const black = x.params.transition === 'black' && clips.length > 1;
  const withAudio = clips.some((c) => c.hasAudio);

  const inputs = [];
  const parts = [];
  let total = 0;
  let totalFrames = 0;
  clips.forEach((c, i) => {
    inputs.push(...S.decoderArgs(c), '-i', c.abs);
    // Nombre d'images de ce clip une fois à la cadence commune, fixé d'avance : le filtre fps est flou sur la
    // dernière image (il la garde ou la jette selon les horodatages), d'où des trous ou des doublons aux raccords.
    // On prolonge donc d'une image (tpad) avant fps, on recoupe au compte voulu, et on renumérote les horodatages.
    const srcFrames = c.frames || Math.max(1, Math.round((c.duration || 1) * (c.fps || 24)));
    const sameRate = S.fpsExpr(c.fps) === fps;
    const n = sameRate ? srcFrames : Math.max(1, Math.round((srcFrames / c.fps) * first.fps));
    const d = n / first.fps;
    const fade = Math.min(DIP_S, d / 4);
    const v = [];
    if (c.skip) v.push('trim=start_frame=1');
    if (c.alpha) v.push(S.flatten(c));                 // clip transparent : posé sur du noir
    v.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`,
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`, 'setsar=1');
    if (!sameRate) v.push('tpad=stop_mode=clone:stop=2', `fps=${fps}`);
    v.push(`trim=end_frame=${n}`, `setpts=N/(${fps}*TB)`, 'format=yuv420p');
    totalFrames += n;
    if (black && i > 0) v.push(`fade=t=in:st=0:d=${fade.toFixed(3)}`);
    if (black && i < clips.length - 1) v.push(`fade=t=out:st=${(d - fade).toFixed(3)}:d=${fade.toFixed(3)}`);
    parts.push(`[${i}:v:0]${v.join(',')}[v${i}]`);
    if (withAudio) {
      const skipA = c.skip ? `atrim=start=${(1 / c.fps).toFixed(6)},asetpts=PTS-STARTPTS,` : '';
      const a = c.hasAudio
        ? `[${i}:a:0]${skipA}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${d.toFixed(6)},asetpts=PTS-STARTPTS`
        : `anullsrc=r=48000:cl=stereo,atrim=0:${d.toFixed(6)},asetpts=PTS-STARTPTS`;
      const af = [];
      if (black && i > 0) af.push(`afade=t=in:st=0:d=${fade.toFixed(3)}`);
      if (black && i < clips.length - 1) af.push(`afade=t=out:st=${(d - fade).toFixed(3)}:d=${fade.toFixed(3)}`);
      parts.push(`${a}${af.length ? `,${af.join(',')}` : ''}[a${i}]`);
    }
    total += d;
  });
  const pads = clips.map((_, i) => (withAudio ? `[v${i}][a${i}]` : `[v${i}]`)).join('');
  parts.push(`${pads}concat=n=${clips.length}:v=1:a=${withAudio ? 1 : 0}${withAudio ? '[v][a]' : '[v]'}`);

  const out = path.join(x.outDir, 'video.mp4');
  const msg = tr(x, `Assemblage de ${clips.length} clips…`, `Joining ${clips.length} clips…`);
  await S.encode(x, (nv) => ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...inputs,
    '-filter_complex', parts.join(';'), '-map', '[v]', ...(withAudio ? ['-map', '[a]'] : []),
    '-r', fps, '-fps_mode', 'cfr', ...S.h264Args(nv, { cq: 14, gop: 12 }),
    ...(withAudio ? S.audioArgs(192) : ['-an']), out],
  { duration: total, onProgress: report.span(0.03, 0.97, msg) });
  if (!S.fileOk(out)) throw S.userError(tr(x, 'L’assemblage n’a rien produit.', 'Joining produced nothing.'));

  const n = (await S.countFrames(x, out)) || totalFrames;
  report(1, tr(x, `${clips.length} clips assemblés`, `${clips.length} clips joined`));
  return {
    outputs: { video: { abs: out, kind: 'video', meta: { w: W, h: H, fps: first.fps, frames: n, duration: n / first.fps } } },
    notes: { clips: clips.length },
  };
}

module.exports = { run, estimate: (x) => {
  const list = (x && x.inputs && x.inputs.clips) || [];
  const dur = (Array.isArray(list) ? list : [list]).reduce((s, c) => s + ((c && c.meta && c.meta.duration) || 5), 0);
  return Math.max(0.1, Math.min(10, dur / 60));
} };
