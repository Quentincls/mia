// ── Visionneuse plein écran (#viewer) ────────────────────────────────
// Double-clic sur un résultat : l'image ou la vidéo en grand, ajustée ou à
// 100 % (un pixel d'image = un pixel d'écran), avec le volet avant/après sur
// sa source quand il y en a une (usage.md §2 : il juge en côte à côte), le
// pas image par image (← →, Maj = ×10), le nom et la méta du fichier, et deux
// actions : Afficher dans l'Explorateur, Copier le chemin. Échap ferme.
//
// Ouverture : bus `viewer:open {nodeId?, rel, kind, compareRel?, name?, meta?}`
// ou openViewer(opts). Les vidéos de la planche sont mises en pause pendant
// ce temps (le décodeur sert à ce qu'on regarde).

import { on } from '../bus.js';
import { ms } from '../ui/motion.js';
import { t } from '../i18n.js';
import { icon } from '../icons.js';
import { el } from '../util.js';
import { state } from '../state.js';
import { isModalOpen } from '../ui/modal.js';
import { isMenuOpen } from '../ui/menu.js';
import { segmented } from '../ui/controls.js';
import { attachPlayer, playerKey } from './player.js';
import { mountCompare } from './compare.js';
import { strings, urlFor, baseName, metaText, pauseAllWells, shellDo, extractFrame } from './media.js';

strings({
  'viewer.fit': 'Ajuster',
  'viewer.actual': '100 %',
  'viewer.single': 'Résultat',
  'viewer.wipe': 'Avant / après',
  'viewer.before': 'Source',
  'viewer.after': 'Résultat',
  'viewer.reveal': 'Afficher dans l’Explorateur',
  'viewer.copy': 'Copier le chemin',
  'viewer.copied': 'Chemin copié',
  'viewer.close': 'Fermer (Échap)',
  'viewer.broken': 'Ce fichier ne se lit pas ici.',
  'viewer.keys': '← → image par image · Maj ×10 · , . vitesse · Espace lecture',
  'viewer.dragOut': 'Glisse l’image hors de Mia pour l’emporter',
}, {
  'viewer.fit': 'Fit',
  'viewer.actual': '100%',
  'viewer.single': 'Result',
  'viewer.wipe': 'Before / after',
  'viewer.before': 'Source',
  'viewer.after': 'Result',
  'viewer.reveal': 'Show in Explorer',
  'viewer.copy': 'Copy path',
  'viewer.copied': 'Path copied',
  'viewer.close': 'Close (Esc)',
  'viewer.broken': 'This file cannot be played here.',
  'viewer.keys': '← → frame by frame · Shift ×10 · , . speed · Space play',
  'viewer.dragOut': 'Drag the picture out of Mia to take it along',
});

let root = null;          // #viewer
let session = null;       // vue ouverte

function host() {
  if (root) return root;
  root = document.getElementById('viewer');
  if (!root) {
    // Filet de sécurité : #viewer est fourni par index.html (SPEC §6.1).
    root = el('div', { id: 'viewer', hidden: true });
    document.body.append(root);
  }
  root.classList.add('vw');
  return root;
}

/** Monte la visionneuse (idempotent ; l'import du module suffit aussi). */
export function mountViewer() { host(); }

/**
 * Ouvre la visionneuse.
 * opts : { nodeId?, rel | url, kind:'image'|'video', compareRel?, name?, meta?, projectId? }
 */
export function openViewer(opts = {}) {
  if (!opts.rel && !opts.url) return;
  closeViewer(true);
  const r = host();
  const projectId = opts.projectId || state.project?.id;
  const url = opts.url || urlFor(opts.rel, projectId);
  const kind = opts.kind || (/\.(mp4|mov|mkv|webm|m4v)$/i.test(opts.rel || opts.url) ? 'video' : 'image');
  const name = opts.name || baseName(opts.rel || opts.url);
  const hasCompare = !!opts.compareRel;

  const s = {
    opts, projectId, kind, url, zoom: 'fit', view: hasCompare ? 'wipe' : 'single',
    media: null, player: null, cmp: null, offs: [],
  };
  session = s;

  // ── barre du haut ───────────────────────────────────────────────────
  const metaEl = el('span', { class: 'vw-meta' }, metaText(opts.meta, kind));
  const title = el('div', { class: 'vw-title' }, el('span', { class: 'vw-name' }, name), metaEl);
  const zoomSeg = segmented({
    options: [{ value: 'fit', label: t('viewer.fit') }, { value: 'actual', label: t('viewer.actual') }],
    value: 'fit', size: 'sm', onChange: (v) => { s.zoom = v; applyZoom(); },
  });
  const viewSeg = hasCompare ? segmented({
    options: [{ value: 'single', label: t('viewer.single') }, { value: 'wipe', label: t('viewer.wipe') }],
    value: s.view, size: 'sm', onChange: (v) => { s.view = v; renderStage(); },
  }) : null;
  const target = opts.rel ? { projectId, rel: opts.rel } : null;
  const bReveal = el('button', { class: 'vw-btn', html: icon('reveal', 16), 'data-tip': t('viewer.reveal') });
  const bCopy = el('button', { class: 'vw-btn', html: icon('copy', 16), 'data-tip': t('viewer.copy') });
  const bClose = el('button', { class: 'vw-btn vw-close', html: icon('close', 16), 'data-tip': t('viewer.close') });
  bReveal.disabled = !target;
  bCopy.disabled = !target;
  bReveal.addEventListener('click', () => target && shellDo('reveal', target));
  bCopy.addEventListener('click', () => target && shellDo('copyPath', target, t('viewer.copied')));
  bClose.addEventListener('click', () => closeViewer());
  const top = el('div', { class: 'vw-top' },
    title,
    el('div', { class: 'vw-tools' }, viewSeg, zoomSeg, el('span', { class: 'vw-sep' }), bReveal, bCopy, bClose));

  const stage = el('div', { class: 'vw-stage' });
  const bottom = el('div', { class: 'vw-bottom' });
  const keys = el('div', { class: 'vw-keys' }, kind === 'video' ? t('viewer.keys') : (target ? t('viewer.dragOut') : ''));
  r.replaceChildren(top, stage, bottom, keys);
  r.hidden = false;
  r.classList.remove('out');
  r.classList.add('in');
  s.stage = stage; s.bottom = bottom; s.metaEl = metaEl; s.zoomSeg = zoomSeg;

  // clic dans le vide = fermer (jamais sur le média ni les contrôles)
  // (en « Ajuster », le média occupe tout le cadre : les bandes autour de l'image comptent comme du vide)
  stage.addEventListener('click', (e) => {
    if (e.target === stage || e.target.classList.contains('vw-fit')) { closeViewer(); return; }
    const m = e.target.closest?.('.vw-media');
    if (m && s.zoom === 'fit' && s.view !== 'wipe' && !insideContent(m, e)) closeViewer();
  });

  // ── contenu ─────────────────────────────────────────────────────────
  function teardownStage() {
    s.player?.destroy(); s.player = null;
    s.cmp?.destroy(); s.cmp = null;
    if (s.media?.tagName === 'VIDEO') { s.media.pause(); s.media.removeAttribute('src'); try { s.media.load(); } catch { /* rien */ } }
    s.media = null;
    stage.replaceChildren();
    bottom.replaceChildren();
  }

  function renderStage() {
    teardownStage();
    stage.classList.toggle('is-wipe', s.view === 'wipe');
    zoomSeg.hidden = s.view === 'wipe';         // l'avant/après est toujours ajusté
    if (s.view === 'wipe') {
      s.zoom = 'fit';
      zoomSeg.setValue?.('fit');
      s.cmp = mountCompare(stage, { mode: 'slider', full: true, labels: [t('viewer.before'), t('viewer.after')], controls: false });
      const before = { url: urlFor(opts.compareRel, projectId), kind: /\.(mp4|mov|mkv|webm|m4v)$/i.test(opts.compareRel) ? 'video' : 'image' };
      s.cmp.set(before, { url, kind, meta: opts.meta });
      // la vidéo qui mène peut être l'« avant » (le résultat est une image) : sa cadence et son
      // nombre d'images ne sont alors pas ceux du résultat (sinon « IMG 0 / 1 » sur une vidéo)
      const m = s.cmp.master();
      if (m) mountPlayer(m, kind === 'video' ? opts.meta : null);
      applyZoom();
      return;
    }
    const wrap = el('div', { class: 'vw-fit' });
    if (kind === 'video') {
      const v = el('video', { class: 'vw-media', playsinline: true, loop: true, preload: 'auto' });
      v.muted = true; v.loop = true; v.playsInline = true;
      v.src = url;
      v.addEventListener('loadedmetadata', () => { if (!opts.meta) s.metaEl.textContent = `${v.videoWidth}×${v.videoHeight}`; applyZoom(); });
      v.addEventListener('error', () => wrap.replaceChildren(el('div', { class: 'vw-broken' }, t('viewer.broken'))));
      v.play().catch(() => {});
      s.media = v;
      mountPlayer(v);
    } else {
      const img = el('img', { class: 'vw-media', draggable: 'false', alt: '' });
      img.addEventListener('load', () => { if (!opts.meta) s.metaEl.textContent = `${img.naturalWidth}×${img.naturalHeight}`; applyZoom(); });
      img.addEventListener('error', () => wrap.replaceChildren(el('div', { class: 'vw-broken' }, t('viewer.broken'))));
      img.src = url;
      s.media = img;
    }
    // Glisser le média hors de Mia (Explorateur, DaVinci…) : le vrai fichier part,
    // par le glisser natif de Windows (mia.shell.startDrag). En « 100 % », le
    // glisser sert à se déplacer dans l'image.
    if (target && window.mia?.shell?.startDrag) {
      s.media.draggable = true;
      s.media.addEventListener('dragstart', (e) => {
        e.preventDefault();
        if (s.zoom === 'actual') return;
        window.mia.shell.startDrag(target);
      });
    }
    wrap.append(s.media);
    stage.append(wrap);
    applyZoom();
  }

  // « Extraire cette image » : sur le bloc d'origine, depuis sa version courante (SPEC §14)
  const canExtract = kind === 'video' && opts.nodeId && opts.port && opts.current !== false;
  function mountPlayer(video, meta = opts.meta) {
    s.player = attachPlayer(video, {
      mode: 'full', fps: meta?.fps, frames: meta?.frames,
      onExtract: canExtract ? (f) => { const id = opts.nodeId; const port = opts.port; closeViewer(); extractFrame(id, port, f); } : null,
    });
    bottom.append(s.player.el);
  }

  // 100 % = un pixel d'image par pixel d'écran (on corrige l'échelle de Windows).
  function applyZoom() {
    stage.classList.toggle('is-actual', s.zoom === 'actual' && s.view !== 'wipe');
    const m = s.media;
    if (!m) return;
    if (s.zoom === 'actual' && s.view !== 'wipe') {
      const w = m.tagName === 'VIDEO' ? m.videoWidth : m.naturalWidth;
      const h = m.tagName === 'VIDEO' ? m.videoHeight : m.naturalHeight;
      const dpr = window.devicePixelRatio || 1;
      if (w && h) { m.style.width = `${w / dpr}px`; m.style.height = `${h / dpr}px`; }
    } else {
      m.style.width = '';
      m.style.height = '';
    }
  }

  // Glisser pour se déplacer dans une image à 100 %.
  let pan = null;
  stage.addEventListener('pointerdown', (e) => {
    if (!stage.classList.contains('is-actual') || e.button !== 0) return;
    pan = { x: e.clientX, y: e.clientY, sl: stage.scrollLeft, st: stage.scrollTop, id: e.pointerId };
    try { stage.setPointerCapture(e.pointerId); } catch { /* pointeur déjà relâché */ }
    stage.classList.add('panning');
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pan) return;
    stage.scrollLeft = pan.sl - (e.clientX - pan.x);
    stage.scrollTop = pan.st - (e.clientY - pan.y);
  });
  const endPan = () => { if (pan) { try { stage.releasePointerCapture(pan.id); } catch { /* rien */ } } pan = null; stage.classList.remove('panning'); };
  stage.addEventListener('pointerup', endPan);
  stage.addEventListener('pointercancel', endPan);
  stage.addEventListener('dblclick', (e) => {
    if (s.view === 'wipe' || !s.media || !e.target.closest('.vw-media')) return;
    s.zoom = s.zoom === 'fit' ? 'actual' : 'fit';
    zoomSeg.setValue?.(s.zoom);
    applyZoom();
  });

  // ── clavier (en capture : la planche ne reçoit rien tant que c'est ouvert) ──
  const onKey = (e) => {
    if (!session || session !== s) return;
    if (isModalOpen() || isMenuOpen()) return;  // une boîte de dialogue ou un menu garde le clavier
    const p = s.player;
    let handled = true;
    if (e.key === 'Escape') closeViewer();
    else if (p && playerKey(p, e)) { /* image par image, Début / Fin, vitesse */ }
    else if ((e.key === ' ' || e.code === 'Space') && p) p.toggle(true);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };
  window.addEventListener('keydown', onKey, true);
  s.offs.push(() => window.removeEventListener('keydown', onKey, true));

  s.teardown = teardownStage;
  pauseAllWells(true);
  renderStage();
}

/** Le clic tombe-t-il sur l'image elle-même (et pas sur les bandes d'un média « ajusté ») ? */
function insideContent(m, e) {
  const r = m.getBoundingClientRect();
  const iw = m.videoWidth || m.naturalWidth;
  const ih = m.videoHeight || m.naturalHeight;
  if (!iw || !ih) return true;
  const k = Math.min(r.width / iw, r.height / ih);
  const w = iw * k, h = ih * k;
  const x0 = r.left + (r.width - w) / 2, y0 = r.top + (r.height - h) / 2;
  return e.clientX >= x0 && e.clientX <= x0 + w && e.clientY >= y0 && e.clientY <= y0 + h;
}

/** Ferme la visionneuse. `instant` = sans fondu (on en rouvre une autre). */
export function closeViewer(instant = false) {
  const s = session;
  if (!s) return;
  session = null;
  for (const off of s.offs) off();
  const r = host();
  const finish = () => {
    s.teardown?.();
    if (!session) { r.hidden = true; r.replaceChildren(); r.classList.remove('in', 'out'); }
  };
  pauseAllWells(false);
  if (instant) { finish(); return; }
  r.classList.remove('in');
  r.classList.add('out');
  setTimeout(finish, ms('scrim') + 10);
}

export const isViewerOpen = () => !!session;

on('viewer:open', (opts) => openViewer(opts || {}));
on('project:closing', () => closeViewer(true));
