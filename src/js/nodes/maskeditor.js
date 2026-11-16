// ── Éditeur de zone du bloc Masque ───────────────────────────────────
// Une fenêtre au-dessus de la planche : l'image branchée et, dessus, la zone
// peinte (couleur d'accent, à demi transparente). Pinceau / gomme, taille,
// inverser, tout effacer, revenir en arrière (Ctrl+Z) ; molette = zoom vers
// le pointeur (pour une petite zone : des pieds, un œil), clic droit, bouton du
// milieu ou Espace enfoncé = se déplacer.
//
// « Valider » rend un PNG noir et blanc (blanc = la zone) à la taille de
// l'image (2048 px de côté au plus : le bloc le remet à la taille exacte).
// Le dessin déjà fait est rechargé tel quel ; on peint par-dessus.
//
//   openMaskEditor({ imageUrl, w, h, drawingUrl? }) → Promise<Uint8Array | null>

import { el, clamp } from '../util.js';
import { t } from '../i18n.js';
import { openModal } from '../ui/modal.js';
import { button, segmented, slider } from '../ui/controls.js';
import { strings } from './media.js';

strings({
  'mz.title': 'Dessiner la zone',
  'mz.brush': 'Pinceau',
  'mz.eraser': 'Gomme',
  'mz.size': 'Taille',
  'mz.undo': 'Revenir en arrière (Ctrl+Z)',
  'mz.invert': 'Inverser',
  'mz.invertTip': 'La zone devient tout le reste',
  'mz.clear': 'Tout effacer',
  'mz.fit': 'Voir toute l’image',
  'mz.ok': 'Valider',
  'mz.help': 'Peins la zone. Molette : zoomer · clic droit ou Espace : se déplacer · [ ] : taille · B / E : pinceau / gomme.',
  'mz.empty': 'Peins d’abord la zone.',
  'mz.loadFailed': 'L’image n’a pas pu être chargée.',
}, {
  'mz.title': 'Draw the zone',
  'mz.brush': 'Brush',
  'mz.eraser': 'Eraser',
  'mz.size': 'Size',
  'mz.undo': 'Undo (Ctrl+Z)',
  'mz.invert': 'Invert',
  'mz.invertTip': 'The zone becomes everything else',
  'mz.clear': 'Clear all',
  'mz.fit': 'See the whole image',
  'mz.ok': 'Done',
  'mz.help': 'Paint the zone. Wheel: zoom · right click or Space: move around · [ ]: size · B / E: brush / eraser.',
  'mz.empty': 'Paint the zone first.',
  'mz.loadFailed': 'The image could not be loaded.',
});

const MAX_SIDE = 2048;
const MAX_ZOOM = 16;
let lastSize = 40;          // taille du pinceau (px à l'écran), gardée d'une ouverture à l'autre

/** Le dessin noir et blanc d'avant → ses pixels en accent, l'alpha = le blanc (null s'il est illisible). */
async function loadDrawing(url, cw, ch, accent) {
  try {
    const blob = await (await fetch(url)).blob();
    const bmp = await createImageBitmap(blob);
    const cv = el('canvas', { width: cw, height: ch });
    const c = cv.getContext('2d', { willReadFrequently: true });
    c.drawImage(bmp, 0, 0, cw, ch);
    bmp.close?.();
    const img = c.getImageData(0, 0, cw, ch);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i];
      d[i] = accent[0]; d[i + 1] = accent[1]; d[i + 2] = accent[2]; d[i + 3] = a;
    }
    c.putImageData(img, 0, 0);
    return cv;
  } catch {
    return null;
  }
}

/** « #4d82f3 » / « rgb(…) » → [r, g, b]. */
function rgbOf(css) {
  const s = String(css || '').trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
  const m = /(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(s);
  return m ? [+m[1], +m[2], +m[3]] : [77, 130, 243];
}

export function openMaskEditor({ imageUrl, w, h, drawingUrl = null } = {}) {
  const k = Math.min(1, MAX_SIDE / Math.max(w || 1, h || 1));
  const cw = Math.max(8, Math.round((w || 1024) * k));
  const ch = Math.max(8, Math.round((h || 1024) * k));
  const accentCss = getComputedStyle(document.documentElement).getPropertyValue('--accent');
  const accent = rgbOf(accentCss);
  const paint = `rgb(${accent.join(',')})`;

  const cv = el('canvas', { class: 'mz-cv', width: cw, height: ch });
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const img = el('img', { class: 'mz-img', draggable: 'false', alt: '' });
  const view = el('div', { class: 'mz-view' }, img, cv);
  const cursor = el('div', { class: 'mz-cursor', hidden: true });
  const stage = el('div', { class: 'mz-stage' }, view, cursor);
  const msg = el('div', { class: 'mz-msg' }, t('mz.help'));

  let tool = 'brush';
  let size = lastSize;
  let base = null;                 // le dessin rechargé (canvas en accent) ou null
  const ops = [];                  // { k:'stroke', erase, lw, pts } | { k:'invert' } | { k:'clear' }
  let z = 1, tx = 0, ty = 0, fitK = 1;
  let stroke = null;               // trait en cours
  let pan = null;                  // { x, y, tx, ty }
  let spaceDown = false;
  let handle = null;

  // ── barre d'outils
  const toolSeg = segmented({
    options: [{ value: 'brush', label: t('mz.brush') }, { value: 'eraser', label: t('mz.eraser') }],
    value: tool, size: 'sm', onChange: (v) => { tool = v; },
  });
  const sizeSld = slider({ min: 4, max: 240, step: 1, value: size, unit: 'px', onInput: (v) => { size = v; lastSize = v; moveCursor(); } });
  const undoBtn = button({ icon: 'undo', kind: 'ghost', size: 'sm', tip: t('mz.undo'), onClick: () => undo() });
  const invertBtn = button({ label: t('mz.invert'), kind: 'ghost', size: 'sm', tip: t('mz.invertTip'), onClick: () => apply({ k: 'invert' }) });
  const clearBtn = button({ label: t('mz.clear'), kind: 'ghost', size: 'sm', onClick: () => apply({ k: 'clear' }) });
  const fitBtn = button({ icon: 'fit', kind: 'ghost', size: 'sm', tip: t('mz.fit'), onClick: () => fit() });
  const cancelBtn = button({ label: t('app.cancel'), kind: 'ghost', size: 'sm', onClick: () => handle.close(null) });
  const okBtn = button({ label: t('mz.ok'), kind: 'primary', size: 'sm', onClick: () => done() });
  const bar = el('div', { class: 'mz-bar' },
    el('h2', { class: 'mz-title' }, t('mz.title')),
    toolSeg,
    el('div', { class: 'mz-size' }, el('span', { class: 'mz-lbl' }, t('mz.size')), sizeSld),
    el('div', { class: 'mz-tools' }, undoBtn, invertBtn, clearBtn, fitBtn),
    el('div', { class: 'mz-acts' }, cancelBtn, okBtn));
  const root = el('div', { class: 'mz' }, bar, stage, msg);

  // ── dessin
  function strokeSeg(c, op, from, to) {
    c.globalCompositeOperation = op.erase ? 'destination-out' : 'source-over';
    c.strokeStyle = paint;
    c.fillStyle = paint;
    c.lineWidth = op.lw;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    if (!from || (from[0] === to[0] && from[1] === to[1])) {
      c.beginPath();
      c.arc(to[0], to[1], op.lw / 2, 0, Math.PI * 2);
      c.fill();
      return;
    }
    c.beginPath();
    c.moveTo(from[0], from[1]);
    c.lineTo(to[0], to[1]);
    c.stroke();
  }
  function drawOp(op) {
    if (op.k === 'clear') { cx.clearRect(0, 0, cw, ch); return; }
    if (op.k === 'invert') {
      const tmp = el('canvas', { width: cw, height: ch });
      const tc = tmp.getContext('2d');
      tc.fillStyle = paint;
      tc.fillRect(0, 0, cw, ch);
      tc.globalCompositeOperation = 'destination-out';
      tc.drawImage(cv, 0, 0);
      cx.globalCompositeOperation = 'copy';
      cx.drawImage(tmp, 0, 0);
      cx.globalCompositeOperation = 'source-over';
      return;
    }
    const p = op.pts;
    for (let i = 0; i < p.length; i += 2) strokeSeg(cx, op, i ? [p[i - 2], p[i - 1]] : null, [p[i], p[i + 1]]);
    cx.globalCompositeOperation = 'source-over';
  }
  function replay() {
    cx.globalCompositeOperation = 'source-over';
    cx.clearRect(0, 0, cw, ch);
    if (base) cx.drawImage(base, 0, 0);
    for (const op of ops) drawOp(op);
  }
  function apply(op) { ops.push(op); drawOp(op); }
  function undo() { if (!ops.length) return; ops.pop(); replay(); }

  // ── vue : ajuster, zoomer, se déplacer (transform seulement)
  function place() { view.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`; }
  function fit() {
    const sw = stage.clientWidth, sh = stage.clientHeight;
    if (!sw || !sh) return;
    fitK = Math.min((sw - 32) / cw, (sh - 32) / ch);
    view.style.width = `${cw * fitK}px`;
    view.style.height = `${ch * fitK}px`;
    z = 1;
    tx = (sw - cw * fitK) / 2;
    ty = (sh - ch * fitK) / 2;
    place();
  }
  const ro = new ResizeObserver(() => fit());

  function local(e) {
    const r = stage.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  /** Point de l'écran → pixel du dessin. */
  function toCanvas(e) {
    const [x, y] = local(e);
    return [(x - tx) / (z * fitK), (y - ty) / (z * fitK)];
  }
  let lastPt = null;
  function moveCursor(e) {
    if (e) lastPt = local(e);
    if (!lastPt || pan || spaceDown) { cursor.hidden = true; return; }
    cursor.hidden = false;
    cursor.style.width = cursor.style.height = `${size}px`;
    cursor.style.transform = `translate(${lastPt[0] - size / 2}px, ${lastPt[1] - size / 2}px)`;
    cursor.classList.toggle('erase', tool === 'eraser');
  }

  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2 || spaceDown) {
      const [x, y] = local(e);
      pan = { x, y, tx, ty };
      stage.classList.add('panning');
      moveCursor(e);
      return;
    }
    if (e.button !== 0) return;
    const p = toCanvas(e);
    stroke = { k: 'stroke', erase: tool === 'eraser', lw: Math.max(1, size / (z * fitK)), pts: [p[0], p[1]] };
    strokeSeg(cx, stroke, null, p);
    cx.globalCompositeOperation = 'source-over';
  });
  stage.addEventListener('pointermove', (e) => {
    moveCursor(e);
    if (pan) {
      const [x, y] = local(e);
      tx = pan.tx + x - pan.x;
      ty = pan.ty + y - pan.y;
      place();
      return;
    }
    if (!stroke) return;
    const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
    for (const ev of evs.length ? evs : [e]) {
      const p = toCanvas(ev);
      const n = stroke.pts.length;
      strokeSeg(cx, stroke, [stroke.pts[n - 2], stroke.pts[n - 1]], p);
      stroke.pts.push(p[0], p[1]);
    }
    cx.globalCompositeOperation = 'source-over';
  });
  const end = () => {
    if (stroke) { ops.push(stroke); stroke = null; }
    if (pan) { pan = null; stage.classList.remove('panning'); }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('pointerleave', () => { if (!pan && !stroke) cursor.hidden = true; });
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [x, y] = local(e);
    const nz = clamp(z * Math.exp(-e.deltaY * 0.0015), 1, MAX_ZOOM);
    if (nz === z) return;
    tx = x - (x - tx) * (nz / z);
    ty = y - (y - ty) * (nz / z);
    z = nz;
    if (z === 1) { fit(); return; }
    place();
  }, { passive: false });

  // Échap et un clic à côté ferment sans rien garder, comme toute boîte de Mia (modal.js)
  function onKey(e) {
    if (e.target && e.target.closest?.('.sld-track')) return;     // le curseur de taille a ses flèches
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (e.code === 'Space') { e.preventDefault(); if (!spaceDown) { spaceDown = true; stage.classList.add('space'); moveCursor(); } return; }
    if (mod && key === 'z') { e.preventDefault(); undo(); return; }
    if (mod) return;
    if (key === 'b' || key === 'e') { tool = key === 'b' ? 'brush' : 'eraser'; toolSeg.setValue(tool); moveCursor(); }
    else if (key === '[' || key === ']') {
      size = clamp(Math.round(size * (key === ']' ? 1.25 : 0.8)), 4, 240);
      lastSize = size;
      sizeSld.setValue(size);
      moveCursor();
    }
  }
  function onKeyUp(e) { if (e.code === 'Space') { spaceDown = false; stage.classList.remove('space'); moveCursor(); } }

  /** PNG noir et blanc du dessin, ou null s'il est vide. */
  async function exportPng() {
    const data = cx.getImageData(0, 0, cw, ch).data;
    let any = false;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 127) { any = true; break; }
    if (!any) return null;
    const white = el('canvas', { width: cw, height: ch });
    const wc = white.getContext('2d');
    wc.drawImage(cv, 0, 0);
    wc.globalCompositeOperation = 'source-in';
    wc.fillStyle = '#fff';
    wc.fillRect(0, 0, cw, ch);
    const out = el('canvas', { width: cw, height: ch });
    const oc = out.getContext('2d');
    oc.fillStyle = '#000';
    oc.fillRect(0, 0, cw, ch);
    oc.drawImage(white, 0, 0);
    const blob = await new Promise((res) => out.toBlob(res, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  }
  async function done() {
    okBtn.setDisabled(true);
    const bytes = await exportPng().catch(() => null);
    okBtn.setDisabled(false);
    if (!bytes) {
      msg.textContent = t('mz.empty');
      msg.classList.add('warn');
      return;
    }
    handle.close(bytes);
  }

  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKeyUp, true);
  handle = openModal(root, {
    bare: true, className: 'mz-dialog', focus: 'box',
    onClose: () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
      ro.disconnect();
    },
  });
  ro.observe(stage);
  img.onerror = () => { msg.textContent = t('mz.loadFailed'); msg.classList.add('warn'); };
  img.src = imageUrl;
  if (drawingUrl) {
    loadDrawing(drawingUrl, cw, ch, accent).then((c) => { if (c) { base = c; replay(); } });
  }
  requestAnimationFrame(() => fit());
  return handle.result.then((v) => (v instanceof Uint8Array ? v : null));
}
