'use strict';
// Exécuteur « Essayer des looks » : UNE image (de la vidéo branchée, ou l'image branchée) passée par chaque look de la
// Finition — Original, puis les looks de luts/index.json présents sur ce PC — et rangée en grille de 3 colonnes sur le
// fond sombre de Mia, le nom du look sous chaque vignette, assez gros pour se lire dans le bloc. On choisit à l'œil et
// on règle le même look dans Finition › Étalonnage. Tout sur le processeur (lut3d de ffmpeg, une seule image) : « light ».
//
// Aussi la source de vérité des looks pour finish.js : `looks()` lit luts/index.json et rend chaque look avec son
// fichier .cube résolu (« <labo>/… » = dans le dossier du moteur, sinon dans Mia\luts) ; `lookPath(x, id)` donne le
// .cube d'un id. Les noms affichés sont ceux du catalogue (nodes.json, Finition › Étalonnage) : un seul jeu de libellés.

const fs = require('node:fs');
const path = require('node:path');
const { shared: S } = require('./export.js');
const places = require('../../places');

const LUTS = path.resolve(__dirname, '..', '..', '..', 'luts');
const CATALOG = path.resolve(__dirname, '..', '..', '..', 'src', 'catalog', 'nodes.json');
const LAB = '<labo>/';

const TILE = 560;          // grand côté d'une vignette (px)
const GAP = 16;            // marge entre vignettes et autour de la planche
const BG = '0x09090b';     // --bg-canvas de Mia
const INK = '0xd4d4d8';    // texte clair, sans éclat
const COLS = 3;
// Libellés : la planche s'affiche à ~18 % dans le bloc (≈ 312 px pour ≈ 1 750 px) : 1/11,5 du côté d'une vignette
// donne ≈ 9 px à l'écran. Police de l'interface (Segoe UI Semibold), en casse normale (plus courte que les capitales).
const LABEL_RATIO = 11.5;
const CHAR_EM = 0.56;      // largeur moyenne d'un caractère de Segoe UI Semibold, en em (pour faire tenir le plus long)

let cache = null;
let catCache = null;

/** Libellés des looks pris dans le catalogue (Finition › Étalonnage) : id → {label, short, hint}. */
function catalogLooks() {
  let st;
  try { st = fs.statSync(CATALOG); } catch { return new Map(); }
  if (catCache && catCache.mtime === st.mtimeMs) return catCache.map;
  const map = new Map();
  try {
    const c = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
    const t = (c.types || []).find((x) => x && x.id === 'finish');
    const p = t && (t.params || []).find((x) => x && x.id === 'look');
    for (const o of (p && p.options) || []) if (o && o.value) map.set(o.value, { label: o.label, short: o.short || null, hint: o.hint || null });
  } catch { /* catalogue illisible : les noms de index.json servent */ }
  catCache = { mtime: st.mtimeMs, map };
  return map;
}

/**
 * Les looks de luts/index.json : [{id, label, short, desc, preview, abs, lab, exists}] (relu si le fichier change).
 * Un look « <labo>/… » vit dans le dossier du moteur (x.engineRoot, sinon le labo s'il est sur ce PC) : sans moteur,
 * ou sur un moteur qui ne l'a pas, il est absent (exists:false) — la planche et l'assistant ne le proposent pas.
 */
function looks(x) {
  const file = path.join(LUTS, 'index.json');
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  const root = (x && x.engineRoot) || places.labRoot() || '';
  const cat = catalogLooks();
  if (!cache || cache.mtime !== st.mtimeMs || cache.root !== root || cache.cat !== cat) {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { list = []; }
    const out = [];
    for (const e of Array.isArray(list) ? list : []) {
      if (!e || !/^[a-z0-9-]{1,40}$/.test(String(e.id || '')) || typeof e.file !== 'string' || !/\.cube$/i.test(e.file)) continue;
      const rel = e.file.startsWith(LAB) ? e.file.slice(LAB.length) : null;
      if (rel != null && !root) {
        out.push({ id: e.id, ...names(e, cat), preview: e.preview || null, abs: null, lab: true, exists: false });
        continue;
      }
      const abs = rel != null ? path.join(root, ...rel.split('/')) : path.join(LUTS, ...e.file.split('/'));
      // un fichier de Mia\luts reste dans Mia\luts (pas de « ../ »)
      if (rel == null && !path.resolve(abs).toLowerCase().startsWith(LUTS.toLowerCase() + path.sep)) continue;
      out.push({ id: e.id, ...names(e, cat), preview: e.preview || null, abs, lab: rel != null, exists: fs.existsSync(abs) });
    }
    cache = { mtime: st.mtimeMs, root, cat, list: out };
  }
  return cache.list.map((e) => ({ ...e, exists: !!e.abs && fs.existsSync(e.abs) }));
}

/** Nom, nom court et phrase d'un look : ceux du catalogue d'abord (les mêmes que dans le bloc Finition). */
function names(e, cat) {
  const c = cat.get(e.id) || {};
  return { label: c.label || e.label || { fr: e.id, en: e.id }, short: c.short || null, desc: c.hint || e.desc || null };
}

const labelOf = (x, l) => (typeof l === 'string' ? l : (l && (l[S.lang(x)] || l.fr)) || '');

/** Fichier .cube d'un look (id de index.json), vérifié ; erreur lisible sinon. */
function lookPath(x, id) {
  const { tr } = S;
  const e = looks(x).find((l) => l.id === id);
  if (!e) {
    throw S.userError(tr(x, `Look inconnu : « ${id} ». Choisis-en un autre dans « Étalonnage ».`,
      `Unknown look: “${id}”. Pick another one in “Grade”.`));
  }
  if (!e.exists) {
    const name = labelOf(x, e.label);
    throw S.userError(e.lab
      ? tr(x, `Le look « ${name} » n’est pas sur ce PC (il vient du dossier du moteur). Choisis un autre look, « Autre LUT » ou « Aucun ».`,
        `The “${name}” look is not on this PC (it comes from the engine folder). Choose another look, “Another LUT” or “None”.`)
      : tr(x, `La LUT « ${name} » manque dans Mia\\luts (${path.basename(e.abs)}).`,
        `The “${name}” LUT is missing from Mia\\luts (${path.basename(e.abs)}).`));
  }
  return e.abs;
}

/** Valeur d'option de filtre ffmpeg entre apostrophes : « : » et « ' » échappés pour l'option, « ' » pour le graphe. */
function fq(s) {
  const opt = String(s).replace(/[\\':]/g, (c) => `\\${c}`);
  return `'${opt.replace(/'/g, "'\\''")}'`;
}
const fpath = (p) => fq(String(p).replace(/\\/g, '/'));

/** Police de l'interface pour les libellés (Segoe UI Semibold, sinon Segoe UI, Arial) ; null = celle de ffmpeg. */
function uiFont() {
  const dir = path.join(process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows', 'Fonts');
  for (const f of ['seguisb.ttf', 'segoeui.ttf', 'arial.ttf', 'CascadiaMono.ttf', 'consola.ttf']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** L'image à essayer, en PNG dans outDir (même choix d'image que « Extraire une image »). */
async function grabFrame(x, info, report) {
  const { tr } = S;
  const pixfmt = 'rgb24';
  const src = path.join(x.outDir, '_image.png');
  const flat = S.flatten(info);
  const vf = (sel) => [sel, flat, `format=${pixfmt}`].filter(Boolean).join(',');
  if (info.kind === 'image') {
    await S.ff(x, ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...S.decoderArgs(info), '-i', info.abs,
      '-frames:v', '1', '-vf', vf(null), src]);
    return { src, at: 0, total: 1 };
  }
  const total = info.frames || 0;
  if (info.exact && total <= 0) throw S.userError(tr(x, 'Aucune image lisible dans cette vidéo.', 'No readable frame in this video.'));
  let at = Math.round(Number(x.params.at));
  if (!Number.isFinite(at)) at = 0;
  if (at < 0) at = total + at;                          // -1 = dernière
  if (total > 0 && at >= total) at = total - 1;
  at = Math.max(0, at);
  const index = at + info.skip;
  const of = total ? ` / ${total}` : '';
  await S.ff(x, ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...S.decoderArgs(info), '-i', info.abs,
    '-map', '0:v:0', '-an', '-sn', '-vf', vf(`select='eq(n,${index})'`), '-fps_mode', 'passthrough',
    '-frames:v', '1', src],
  { duration: Math.max(0.04, (index + 1) / (info.fps || 24)), onProgress: report.span(0.1, 0.5, tr(x, `Image ${at}${of}…`, `Frame ${at}${of}…`)) });
  if (!S.fileOk(src)) {
    throw S.userError(tr(x, `Impossible de lire l’image ${at}${of} de cette vidéo.`, `Could not read frame ${at}${of} of this video.`));
  }
  return { src, at, total };
}

async function run(x) {
  const { tr } = S;
  const input = x.inputs.media;
  if (!input || !input.abs) throw S.userError(tr(x, 'Branche une image ou une vidéo.', 'Connect an image or a video.'));
  const report = S.reporter(x);
  report(0, tr(x, 'Lecture du média…', 'Reading the media…'));
  const info = await S.inspect(x, input, { exact: true });
  const { src, at, total } = await grabFrame(x, info, report);

  // vignettes : l'original, puis chaque look présent, dans l'ordre de index.json (nom court du catalogue s'il y en a un)
  const all = looks(x);
  const tiles = [{ id: 'original', label: tr(x, 'Original', 'Original'), lut: null }];
  const missing = [];
  for (const e of all) {
    if (e.exists) tiles.push({ id: e.id, label: labelOf(x, e.short || e.label), lut: e.abs });
    else missing.push(labelOf(x, e.label));
  }
  if (tiles.length < 2) {
    throw S.userError(tr(x, 'Aucun look trouvé (Mia\\luts\\index.json).', 'No look found (Mia\\luts\\index.json).'));
  }
  if (missing.length) x.log(`looks absents : ${missing.join(', ')}`);

  // taille d'une vignette : grand côté = TILE, dimensions paires
  const p = await x.ffmpeg.probe(src).catch(() => null);
  const w0 = (p && p.w) || info.w;
  const h0 = (p && p.h) || info.h;
  const k = TILE / Math.max(w0, h0);
  const tw = S.even(w0 * k);
  const th = S.even(h0 * k);
  // libellés lisibles dans le bloc : 1/11,5 de la vignette, réduits seulement si le plus long ne tiendrait pas
  const longest = Math.max(...tiles.map((t) => [...t.label].length));
  const fs0 = Math.max(14, Math.min(Math.round(tw / LABEL_RATIO), Math.floor((tw * 0.96) / (longest * CHAR_EM))));
  const BAND = Math.round(fs0 * 1.9);               // bande du libellé sous chaque vignette
  const cw = tw + GAP;
  const ch = th + BAND + GAP;
  const rows = Math.ceil(tiles.length / COLS);
  const n = rows * COLS;

  const font = uiFont();
  const g = [`[0:v]scale=${tw}:${th}:flags=lanczos,format=rgb24,split=${tiles.length}${tiles.map((_, i) => `[s${i}]`).join('')}`];
  tiles.forEach((t, i) => {
    const text = ['drawtext=expansion=none', font ? `fontfile=${fpath(font)}` : null, `text=${fq(t.label)}`,
      // y_align=font : même ligne de base pour tous les libellés, qu'ils aient des accents ou des parenthèses ou non
      `fontsize=${fs0}`, `fontcolor=${INK}`, 'x=0', 'y_align=font', `y=${th + Math.round(fs0 * 0.3)}`].filter(Boolean).join(':');
    const lut = t.lut ? `lut3d=file=${fpath(t.lut)}:interp=tetrahedral,` : '';
    g.push(`[s${i}]${lut}pad=${cw}:${ch}:0:0:color=${BG},${text}[t${i}]`);
  });
  for (let i = tiles.length; i < n; i++) g.push(`color=c=${BG}:s=${cw}x${ch},format=rgb24[t${i}]`);
  g.push(`${Array.from({ length: n }, (_, i) => `[t${i}]`).join('')}xstack=inputs=${n}:grid=${COLS}x${rows},`
    + `pad=iw+${GAP}:ih+${GAP}:${GAP}:${GAP}:color=${BG},format=rgb24[out]`);

  const stem = S.cleanName(path.parse(info.abs).name).slice(0, 90) || 'image';
  const out = path.join(x.outDir, info.kind === 'video' ? `${stem}_looks_f${String(at).padStart(4, '0')}.png` : `${stem}_looks.png`);
  report(0.6, tr(x, `Comparatif de ${tiles.length} looks…`, `Comparing ${tiles.length} looks…`));
  await S.ff(x, ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-i', src, '-filter_complex', g.join(';'),
    '-map', '[out]', '-frames:v', '1', '-compression_level', '4', out]);
  if (!S.fileOk(out)) throw S.userError(tr(x, 'Le comparatif des looks n’a pas pu être écrit.', 'The looks comparison could not be written.'));
  try { fs.rmSync(src, { force: true }); } catch { /* fichier de travail */ }

  const W = COLS * cw + GAP;
  const H = rows * ch + GAP;
  const of = info.kind === 'video' && total ? ` / ${total}` : '';
  report(1, info.kind === 'video'
    ? tr(x, `Image ${at}${of} : ${tiles.length - 1} looks`, `Frame ${at}${of}: ${tiles.length - 1} looks`)
    : tr(x, `${tiles.length - 1} looks`, `${tiles.length - 1} looks`));
  return {
    outputs: { image: { abs: out, kind: 'image', meta: { w: W, h: H } } },
    notes: { frame: info.kind === 'video' ? at : undefined, frames: total || undefined,
      looks: tiles.map((t) => t.id), missing: missing.length ? missing : undefined,
      // où est chaque vignette dans l'image (px) : de quoi choisir un look d'un clic dans le bloc ou la visionneuse
      grid: { cols: COLS, rows, w: W, h: H, x0: GAP, y0: GAP, cell: { w: cw, h: ch }, tile: { w: tw, h: th }, label: { size: fs0, band: BAND } } },
  };
}

module.exports = { run, estimate: () => 0.1, looks, lookPath };
