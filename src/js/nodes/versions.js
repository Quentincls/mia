// ── Bande des versions d'un bloc ─────────────────────────────────────
// Chaque calcul réussi crée une version (v1, v2…). Quentin veut « peu de
// versions visibles, clairement nommées » et une étoile pour la version
// retenue (usage.md §2) : la bande n'apparaît qu'à partir de deux versions,
// défile avec ‹ › quand elle déborde (toutes les versions restent atteignables),
// et l'étoile épingle la version qui s'affiche ET part en aval.
//
// Clic = regarder une version dans le puits (sans rien changer en aval).
// Étoile = la garder (épingler). Clic droit = Explorateur / Supprimer.

import { play, flip, rects } from '../ui/motion.js';
import { t, tl } from '../i18n.js';
import { icon } from '../icons.js';
import { el, relTime } from '../util.js';
import { openMenu } from '../ui/menu.js';
import { confirm as confirmModal } from '../ui/modal.js';
import { tip } from '../ui/tooltip.js';
import { emit } from '../bus.js';
import { state } from '../state.js';
import * as runs from './runs.js';
import { strings, urlFor, fmtDur, shellDo, lightImageUrl } from './media.js';

strings({
  'node.ver.label': 'v{n}',
  'node.ver.more': '+{n}',
  'node.ver.moreTip': 'Toutes les versions, dans l’inspecteur',
  'node.ver.olderTip': 'Versions plus anciennes',
  'node.ver.newerTip': 'Versions plus récentes',
  'node.ver.pinned': 'Version gardée',
  'node.ver.latest': 'La plus récente',
  'node.ver.mode.preview': 'Aperçu',
  'node.ver.mode.final': 'Rendu final',
  'node.ver.short.preview': 'Aperçu',
  'node.ver.tipClick': 'Clic : la regarder · ★ : la garder pour la suite',
  'node.ver.show': 'Regarder cette version',
  'node.ver.pin': 'Garder cette version',
  'node.ver.unpin': 'Ne plus la garder',
  'node.ver.open': 'Ouvrir en grand',
  'node.ver.reveal': 'Afficher dans l’Explorateur',
  'node.ver.delete': 'Supprimer cette version',
  'node.ver.deleteTitle': 'Supprimer la version {v} ?',
  'node.ver.deleteBody': 'Ses fichiers partent à la Corbeille de Windows. Tu pourras les y récupérer.',
  'node.ver.deleteOk': 'Supprimer',
  'node.ver.cancel': 'Annuler',
  'node.ver.starTip': 'Garder cette version (elle part en aval)',
  'node.ver.unstarTip': 'Ne plus la garder (la plus récente reprend)',
}, {
  'node.ver.label': 'v{n}',
  'node.ver.more': '+{n}',
  'node.ver.moreTip': 'All versions, in the inspector',
  'node.ver.olderTip': 'Older versions',
  'node.ver.newerTip': 'Newer versions',
  'node.ver.pinned': 'Kept version',
  'node.ver.latest': 'Latest',
  'node.ver.mode.preview': 'Preview',
  'node.ver.mode.final': 'Final render',
  'node.ver.short.preview': 'Preview',
  'node.ver.tipClick': 'Click: view it · ★: keep it for what follows',
  'node.ver.show': 'View this version',
  'node.ver.pin': 'Keep this version',
  'node.ver.unpin': 'Stop keeping it',
  'node.ver.open': 'Open full size',
  'node.ver.reveal': 'Show in Explorer',
  'node.ver.delete': 'Delete this version',
  'node.ver.deleteTitle': 'Delete version {v}?',
  'node.ver.deleteBody': 'Its files go to the Windows Recycle Bin. You can restore them from there.',
  'node.ver.deleteOk': 'Delete',
  'node.ver.cancel': 'Cancel',
  'node.ver.starTip': 'Keep this version (it is sent downstream)',
  'node.ver.unstarTip': 'Stop keeping it (the latest takes over)',
});


/** Dossier d'une version, relatif au projet. */
export function runDir(nodeId, run) {
  const first = run?.outputs && Object.values(run.outputs)[0]?.path;
  if (first && first.includes('/')) return first.slice(0, first.lastIndexOf('/'));
  return `outputs/${nodeId}/${run?.runId || ''}`;
}

/**
 * Vignette d'une version : poster de vidéo, sinon la vignette de 640 px de l'image (l'original tant qu'elle n'est pas
 * faite : 60 originaux décodés pesaient 68 Mpx sur Plan 01). `onLite(url)` : la vignette, quand elle arrive.
 */
export function runThumb(run, onLite = null) {
  const outs = run?.outputs ? Object.values(run.outputs) : [];
  for (const o of outs) {
    if (o.poster) return urlFor(o.poster);
    if (o.kind === 'image' && o.path) return lightImageUrl({ rel: o.path, kind: 'image', meta: o.meta }, onLite);
  }
  return '';
}

/** La vignette d'une version en <img> (null sans vignette), qui passe sur la petite image dès qu'elle est faite. */
export function runThumbImg(run, attrs = {}) {
  let img = null;
  const src = runThumb(run, (u) => { if (img) img.src = u; });
  if (!src) return null;
  img = el('img', { src, alt: '', draggable: 'false', ...attrs });
  return img;
}

/** Ligne de détail : « il y a 5 min · Aperçu · 38 s ». */
export function runDetail(run) {
  const bits = [];
  if (run.finished || run.started) bits.push(relTime(run.finished || run.started));
  if (run.mode) bits.push(t(`node.ver.mode.${run.mode}`));
  const d = runs.runDuration(run);
  if (d != null) bits.push(fmtDur(d));
  return bits.join(' · ');
}

/** Entrées du menu d'une version (partagées avec l'inspecteur). */
export function versionMenuItems(nodeId, run, { onView } = {}) {
  const node = window.__mia?.editor?.getNode?.(nodeId);
  const pinned = node?.pinnedRun === run.runId;
  const v = runs.versionNumber(nodeId, run.runId);
  const items = [];
  if (onView) items.push({ label: t('node.ver.show'), icon: 'play', action: () => onView(run.runId) });
  items.push({
    label: pinned ? t('node.ver.unpin') : t('node.ver.pin'),
    icon: 'star',
    action: () => runs.pin(nodeId, pinned ? null : run.runId),
  });
  const out = runs.output(nodeId, null, run);
  if (out?.path) {
    items.push({
      label: t('node.ver.open'), icon: 'fullscreen',
      action: () => emit('viewer:open', {
        nodeId, port: out.port, rel: out.path, kind: out.kind, meta: out.meta || null, runId: run.runId,
        current: runs.current(nodeId)?.runId === run.runId,
      }),
    });
  }
  items.push({
    label: t('node.ver.reveal'), icon: 'reveal',
    action: () => shellDo('reveal', { projectId: state.project?.id, rel: out?.path || runDir(nodeId, run) }),
  });
  items.push('sep');
  items.push({
    label: t('node.ver.delete'), icon: 'trash', danger: true,
    action: () => askDelete(nodeId, run, v),
  });
  return items;
}

export async function askDelete(nodeId, run, v = runs.versionNumber(nodeId, run.runId)) {
  const ok = await confirmModal({
    title: t('node.ver.deleteTitle', { v: t('node.ver.label', { n: v }) }),
    body: t('node.ver.deleteBody'),
    ok: t('node.ver.deleteOk'),
    cancel: t('node.ver.cancel'),
    danger: true,
  });
  if (ok) await runs.removeRun(nodeId, run.runId);
}

/**
 * Monte la bande des versions.
 * opts : { nodeId, viewed():runId|null, onView(runId|null), openInspector() }
 * Retour : { el, refresh(), destroy() }
 */
export function mountVersions(host, opts) {
  const { nodeId } = opts;
  const root = el('div', { class: 'nb-vers', hidden: true });
  host?.append(root);

  function chip(run, n, isCurrent, isViewed, pinned) {
    const thumb = runThumbImg(run, { decoding: 'async', loading: 'lazy' });
    const star = el('button', {
      class: `nb-ver-star ${pinned ? 'on' : ''}`,
      html: icon(pinned ? 'star-fill' : 'star', 12),
      'data-tip': pinned ? t('node.ver.unstarTip') : t('node.ver.starTip'),
    });
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      runs.pin(nodeId, pinned ? null : run.runId);
    });
    const c = el('div', {
      class: `nb-ver${isCurrent ? ' is-current' : ''}${isViewed ? ' is-viewed' : ''}${pinned ? ' is-pinned' : ''}`,
      role: 'button', dataset: { run: run.runId },
    },
    el('span', { class: 'nb-ver-thumb' }, thumb),
    el('span', { class: 'nb-ver-txt' },
      el('span', { class: 'nb-ver-n' }, t('node.ver.label', { n })),
      // seul un aperçu est marqué : « Générer » calcule les réglages tels quels, c'est le cas ordinaire
      run.mode === 'preview' ? el('span', { class: 'nb-ver-mode is-preview' }, t('node.ver.short.preview')) : null),
    star);
    c.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onView?.(isViewed && !isCurrent ? null : run.runId);
    });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu(versionMenuItems(nodeId, run, { onView: opts.onView }), { x: e.clientX, y: e.clientY });
    });
    c.addEventListener('pointerdown', (e) => { if (e.button === 0) e.stopPropagation(); });
    tip(c, () => {
      const head = `${t('node.ver.label', { n })}${pinned ? ` · ${t('node.ver.pinned')}` : isCurrent ? ` · ${t('node.ver.latest')}` : ''}`;
      // une seule ligne : le tooltip de D replie les retours à la ligne
      const model = run.model ? (typeof run.model === 'object' ? tl(run.model) : run.model) : '';
      return [head, runDetail(run), model, t('node.ver.tipClick')].filter(Boolean).join(' · ');
    });
    return c;
  }

  // Toutes les versions sur une piste qui défile : ‹ › aux deux bouts quand elle déborde (les plus anciennes à
  // gauche, la plus récente à droite). Avant, les plus anciennes passaient dans « +N » et on ne pouvait plus les voir.
  const prev = el('button', { class: 'nb-vers-nav is-prev', html: icon('chevron-left', 12), 'data-tip': t('node.ver.olderTip'), 'aria-label': t('node.ver.olderTip') });
  const next = el('button', { class: 'nb-vers-nav is-next', html: icon('chevron-right', 12), 'data-tip': t('node.ver.newerTip'), 'aria-label': t('node.ver.newerTip') });
  const track = el('div', { class: 'nb-vers-track' });
  root.append(prev, track, next);
  const step = () => Math.max(60, track.clientWidth * 0.8);
  for (const [b, dir] of [[prev, -1], [next, 1]]) {
    b.addEventListener('click', (e) => { e.stopPropagation(); pinEnd = false; track.scrollBy({ left: dir * step(), behavior: 'smooth' }); });
    b.addEventListener('pointerdown', (e) => { if (e.button === 0) e.stopPropagation(); });
    b.addEventListener('dblclick', (e) => e.stopPropagation());
  }
  // molette sur la piste (quand elle déborde) : défile au lieu de zoomer la planche
  track.addEventListener('wheel', (e) => {
    if (track.scrollWidth <= track.clientWidth + 1 || e.ctrlKey) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    pinEnd = false;
    track.scrollLeft += d;
  }, { passive: false });
  // flèches : visibles seulement quand la piste déborde, éteintes au bout
  function paintNav() {
    const over = track.scrollWidth > track.clientWidth + 1;
    root.classList.toggle('is-over', over);
    const max = track.scrollWidth - track.clientWidth;
    prev.disabled = !over || track.scrollLeft <= 1;
    next.disabled = !over || track.scrollLeft >= max - 1;
  }
  track.addEventListener('scroll', paintNav, { passive: true });
  // amène une puce dans la piste, sans toucher au défilement de la planche (pas de scrollIntoView)
  function reveal(chipEl, smooth) {
    if (!chipEl) return;
    const l = chipEl.offsetLeft - track.offsetLeft;
    const r = l + chipEl.offsetWidth;
    let to = null;
    if (l < track.scrollLeft) to = l - 4;
    else if (r > track.scrollLeft + track.clientWidth) to = r - track.clientWidth + 4;
    if (to != null) track.scrollTo({ left: Math.max(0, to), behavior: smooth ? 'smooth' : 'auto' });
  }

  let sig = null;
  let quiet = false;          // relance après un changement de largeur : pas d'animation
  let pinEnd = true;          // la piste reste calée sur la plus récente tant que l'utilisateur ne l'a pas fait défiler
  let seen = 0;               // nombre de versions au dernier dessin : une version neuve ramène la piste à droite
  function refresh() {
    const versions = runs.list(nodeId);           // plus récentes d'abord
    const cur = runs.current(nodeId);
    const pinnedId = window.__mia?.editor?.getNode?.(nodeId)?.pinnedRun || null;
    const viewed = opts.viewed?.() || null;
    // appelée à chaque changement de la planche : on ne reconstruit que si besoin
    const nextSig = [versions.map((r) => r.runId).join(','), cur?.runId, pinnedId, viewed].join('|');
    if (nextSig === sig) return;
    sig = nextSig;
    // FLIP : les puces gardées glissent, une version neuve (« v3 ») glisse dans la bande (SPEC §20.1)
    const items = () => [...track.querySelectorAll('.nb-ver[data-run]')].map((n) => ({ key: n.dataset.run, el: n }));
    const first = !quiet && !root.hidden && root.isConnected ? rects(items()) : null;
    const known = new Set(first ? first.keys() : []);
    const keepScroll = track.scrollLeft;
    const grew = versions.length > seen;
    const firstPaint = seen === 0;
    seen = versions.length;
    track.replaceChildren();
    if (versions.length < 2) { root.hidden = true; return; }
    root.hidden = false;
    const chips = new Map();
    for (const r of [...versions].reverse()) {        // de la plus ancienne à la plus récente
      const n = versions.length - versions.indexOf(r);
      chips.set(r.runId, chip(r, n, cur?.runId === r.runId, viewed === r.runId, pinnedId === r.runId));
    }
    track.append(...chips.values());
    // position : la plus récente au premier dessin ou quand une version arrive, sinon là où l'utilisateur était ;
    // la version regardée reste toujours visible
    if (firstPaint || grew) pinEnd = true;
    if (pinEnd) track.scrollLeft = track.scrollWidth;
    else track.scrollLeft = keepScroll;
    reveal(chips.get(viewed), !firstPaint && !quiet);
    paintNav();
    if (first && first.size) {
      flip(first, items(), {
        dur: 'enter', easing: 'out',
        enter: (n) => (known.has(n.dataset.run) ? null
          : play(n, [{ opacity: 0, transform: 'translateX(-10px)' }, { opacity: 1, transform: 'none' }], { dur: 'fade', easing: 'out' }))
      });
    }
  }

  // la carte change de largeur (poignée) : les flèches suivent
  // (la piste n'a sa largeur qu'une fois posée : la plus récente est ramenée à droite à ce moment-là)
  const ro = new ResizeObserver(() => { if (pinEnd) track.scrollLeft = track.scrollWidth; paintNav(); });
  ro.observe(root);
  ro.observe(track);

  refresh();
  return { el: root, refresh, destroy() { ro.disconnect(); root.remove(); } };
}
