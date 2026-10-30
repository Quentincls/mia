// ── Bande des versions d'un bloc ─────────────────────────────────────
// Chaque calcul réussi crée une version (v1, v2…). Quentin veut « peu de
// versions visibles, clairement nommées » et une étoile pour la version
// retenue (usage.md §2) : la bande n'apparaît qu'à partir de deux versions,
// montre au plus six vignettes, et l'étoile épingle la version qui
// s'affiche ET part en aval.
//
// Clic = regarder une version dans le puits (sans rien changer en aval).
// Étoile = la garder (épingler). Clic droit = Explorateur / Supprimer.

import { play, flip, rects } from '../ui/motion.js';
import { t, tl } from '../i18n.js';
import { icon } from '../icons.js';
import { el, relTime, measureLater } from '../util.js';
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

const MAX_CHIPS = 6;
// une puce qui dit « Aperçu / Final » est plus large : on en montre moins
const MAX_CHIPS_MODES = 4;

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
    const thumb = runThumbImg(run, { decoding: 'async' });
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

  let sig = null;
  let quiet = false;          // relance après un changement de largeur : pas d'animation
  // Les puces que la bande tient : les plus anciennes passent dans « +N ». Une marge garde la place de l'étoile qui
  // apparaît au survol d'une puce. Lectures (largeurs) puis écritures (puces retirées), jamais mêlées.
  let fit = null;
  function readFit() {
    const s = fit;
    const room = root.clientWidth;
    if (!s || !room || root.hidden) return null;
    const widths = new Map();
    for (const [id, c] of s.chips) widths.set(id, c.offsetWidth);
    return { s, room, gap: parseFloat(getComputedStyle(root).columnGap) || 0, widths, moreW: s.more.isConnected ? s.more.offsetWidth : 0 };
  }
  function applyFit(m) {
    if (!m || m.s !== fit) { fit?.paintMore(); return; }
    const { s, room, gap, widths, moreW } = m;
    const total = s.shown.length + (versionsCount() - s.shown.length > 0 ? 1 : 0);
    let used = s.shown.reduce((w, r) => w + (widths.get(r.runId) || 0), 0) + (total > s.shown.length ? moreW : 0) + gap * Math.max(0, total - 1);
    while (used > room - 20) {
      const drop = s.shown.find((r) => !s.keep.has(r.runId));
      if (!drop || s.shown.length <= 1) break;
      const hadMore = versionsCount() - s.shown.length > 0;
      s.shown = s.shown.filter((r) => r !== drop);
      s.chips.get(drop.runId)?.remove();
      used -= (widths.get(drop.runId) || 0) + gap;
      if (!hadMore) used += moreW + gap;          // « +N » apparaît
    }
    s.paintMore();
  }
  const fitJob = { read: readFit, write: applyFit };
  const versionsCount = () => runs.list(nodeId).length;
  function refresh() {
    const versions = runs.list(nodeId);           // plus récentes d'abord
    const cur = runs.current(nodeId);
    const pinnedId = window.__mia?.editor?.getNode?.(nodeId)?.pinnedRun || null;
    const viewed = opts.viewed?.() || null;
    // appelée à chaque changement de la planche : on ne reconstruit que si besoin
    const next = [versions.map((r) => r.runId).join(','), cur?.runId, pinnedId, viewed].join('|');
    if (next === sig) return;
    sig = next;
    // FLIP : les puces gardées glissent, une version neuve (« v3 ») glisse dans la bande (SPEC §20.1)
    const items = () => [...root.querySelectorAll('.nb-ver[data-run]')].map((n) => ({ key: n.dataset.run, el: n }));
    const first = !quiet && !root.hidden && root.isConnected ? rects(items()) : null;
    const known = new Set(first ? first.keys() : []);
    root.replaceChildren();
    if (versions.length < 2) { root.hidden = true; return; }
    root.hidden = false;
    // Candidates : les plus récentes (au plus MAX_CHIPS), plus la version courante, épinglée ou
    // regardée si elle est plus ancienne — elle reste toujours visible.
    const max = versions.some((r) => r.mode === 'preview') ? MAX_CHIPS_MODES : MAX_CHIPS;   // seul un aperçu porte une marque
    const keep = new Set([cur?.runId, pinnedId, viewed].filter(Boolean));
    let shown = versions.slice(0, max);
    for (const r of versions) if (keep.has(r.runId) && !shown.includes(r)) shown.push(r);
    shown = versions.filter((r) => shown.includes(r)).reverse();       // de la plus ancienne à la plus récente
    const more = el('button', { class: 'nb-ver nb-ver-more', 'data-tip': t('node.ver.moreTip') });
    more.addEventListener('click', (e) => { e.stopPropagation(); opts.openInspector?.(); });
    more.addEventListener('pointerdown', (e) => { if (e.button === 0) e.stopPropagation(); });
    const chips = new Map();
    for (const r of shown) {
      const n = versions.length - versions.indexOf(r);
      chips.set(r.runId, chip(r, n, cur?.runId === r.runId, viewed === r.runId, pinnedId === r.runId));
    }
    const paintMore = () => {
      const hidden = versions.length - shown.length;
      more.textContent = t('node.ver.more', { n: hidden });
      if (hidden > 0 && !more.isConnected) root.prepend(more);
      if (hidden <= 0) more.remove();
    };
    root.append(...chips.values());
    // « +N » mesuré avec les puces (il prend sa place dès qu'une puce passe dedans), retiré ensuite s'il ne sert pas
    more.textContent = t('node.ver.more', { n: Math.max(1, versions.length - shown.length) });
    root.prepend(more);
    fit = { shown, chips, keep, more, paintMore: () => { shown = fit.shown; paintMore(); } };
    // Autant de puces que la bande en tient : mesuré avec les autres blocs (util.measureLater), sauf quand une
    // version neuve arrive (une seule bande, animée tout de suite)
    if (first && first.size) applyFit(readFit());
    else measureLater(fitJob);
    if (first && first.size) {
      flip(first, items(), {
        dur: 'enter', easing: 'out',
        enter: (n) => (known.has(n.dataset.run) ? null
          : play(n, [{ opacity: 0, transform: 'translateX(-10px)' }, { opacity: 1, transform: 'none' }], { dur: 'fade', easing: 'out' }))
      });
    }
  }

  // la carte change de largeur (poignée) : on recompte les puces, sans animation
  let lastW = 0;
  const ro = new ResizeObserver((entries) => {
    const w = entries[entries.length - 1]?.contentRect?.width || 0;
    if (!w || Math.abs(w - lastW) < 0.5) return;
    lastW = w;
    sig = null;
    quiet = true;
    try { refresh(); } finally { quiet = false; }
  });
  ro.observe(root);

  refresh();
  return { el: root, refresh, destroy() { ro.disconnect(); root.remove(); } };
}
