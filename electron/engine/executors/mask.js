'use strict';
// Exécuteur « Masque » : la zone dessinée dans Mia sur une image (blanc = la zone), remise à la taille de l'image, son
// bord adouci, et inversée pour « Zone à protéger » (tout le reste devient la zone). Sans GPU : ffmpeg.
//
// Le dessin est un PNG du projet (réglage `drawing`, chemin relatif à la planche) que l'éditeur du bloc écrit à chaque
// validation — un nouveau nom à chaque fois : l'empreinte du bloc change, ce qui en dépend se recalcule. On peut aussi y
// choisir un masque PNG fait ailleurs (chemin absolu).

const fs = require('node:fs');
const path = require('node:path');
const { shared: S } = require('./export.js');
const { exec: E } = require('../patch');

const MAX_FEATHER = 200;

async function run(x) {
  const { tr } = S;
  const img = x.inputs.image;
  if (!img || !img.abs) throw S.userError(tr(x, 'Branche l’image sur laquelle dessiner la zone.', 'Connect the image to draw the zone on.'));
  const rel = String(x.params.drawing || '').trim();
  if (!rel) {
    throw S.userError(tr(x, 'Dessine d’abord la zone (bouton « Dessiner la zone » du bloc Masque).',
      'Draw the zone first (“Draw the zone” button of the Mask block).'));
  }
  const abs = path.isAbsolute(rel) ? rel : path.resolve(x.projectDir || '', ...rel.split('/'));
  if (!fs.existsSync(abs)) throw S.userError(tr(x, `Dessin introuvable : ${path.basename(abs)}.`, `Drawing not found: ${path.basename(abs)}.`));
  const report = S.reporter(x);
  report(0, tr(x, 'Lecture de l’image…', 'Reading the image…'));
  const info = await S.inspect(x, img);
  const w = info.w, h = info.h;
  if (!(w > 0 && h > 0)) throw S.userError(tr(x, 'Taille de l’image illisible.', 'Unreadable image size.'));
  let feather = Math.max(0, Math.min(MAX_FEATHER, Number(x.params.feather ?? 18) || 0));
  const protect = x.params.mode === 'protect';
  // une petite zone (des pieds, un œil) : un bord de 18 px la noierait toute — au plus le quart de son petit côté,
  // mesuré sur le dessin remis à la taille de l'image (dans les deux sens : une petite zone à protéger aussi)
  const box = await E.maskBox(x, abs);
  if (box && box.empty) throw S.userError(tr(x, 'Le dessin est vide : peins la zone.', 'The drawing is empty: paint the zone.'));
  let capped = false;
  if (box && feather > 0) {
    const d = await S.inspect(x, { abs, meta: {} }).catch(() => null);
    const k = d && d.w > 0 ? w / d.w : 1;
    const cap = Math.max(2, Math.round(Math.min(box.w, box.h) * k * 0.25));
    if (cap < feather) { feather = cap; capped = true; }
  }
  // le masque suit l'image : même taille, gris (blanc = la zone). Bord adouci vers l'extérieur : flou gaussien de
  // `feather` px puis doublé, la zone dessinée reste toute blanche (elle change toute) et le fondu se fait autour ;
  // « Zone à protéger » inverse ensuite : la zone protégée reste toute noire, sa marge aussi protégée en partie
  const vf = [`scale=${w}:${h}:flags=bicubic`, 'format=gray',
    feather > 0 ? `gblur=sigma=${feather},lut=c0='min(255,val*2)'` : null, protect ? 'negate' : null].filter(Boolean).join(',');
  const out = path.join(x.outDir, 'masque.png');
  await S.ff(x, ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-i', abs, '-vf', vf, '-frames:v', '1', out]);
  if (!S.fileOk(out)) throw S.userError(tr(x, 'Le masque n’a pas pu être écrit.', 'The mask could not be written.'));
  report(1, tr(x, 'Masque prêt', 'Mask ready'));
  return {
    outputs: { mask: { abs: out, kind: 'image', meta: { w, h } } },
    notes: tr(x, `${protect ? 'Zone à protéger (tout le reste change)' : 'Zone à changer'} · bord adouci de ${feather} px${capped ? ' (réduit : petite zone)' : ''} · ${w} × ${h}.`,
      `${protect ? 'Zone to protect (everything else changes)' : 'Zone to change'} · edge softened by ${feather} px${capped ? ' (reduced: small zone)' : ''} · ${w} × ${h}.`),
  };
}

function estimate() {
  return 0.05;
}

module.exports = { run, estimate };
