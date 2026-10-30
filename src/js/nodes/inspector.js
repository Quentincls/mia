// ── Inspecteur (#inspector, panneau de droite) ───────────────────────
// Le détail d'un bloc, quand la carte ne suffit plus : ce qu'il fait en une
// phrase, TOUS ses réglages (y compris « Avancé »), la liste complète de ses
// versions (date, durée, modèle, mode) et les actions. La carte reste le lieu
// du geste rapide ; l'inspecteur est celui de la vérification.
//
// Ouverture : bus `inspector:open {nodeId}` ; ensuite il suit la sélection
// (un seul bloc sélectionné → il passe à ce bloc).

import { on, emit } from '../bus.js';
import { t, tl } from '../i18n.js';
import { icon } from '../icons.js';
import { el } from '../util.js';
import { state } from '../state.js';
import { openMenu } from '../ui/menu.js';
import { button } from '../ui/controls.js';
import * as runs from './runs.js';
import { mountParams } from './params.js';
import { ghostOut } from '../ui/motion.js';
import { runThumbImg, runDetail, runDir, versionMenuItems, askDelete } from './versions.js';
import { strings, metaText, baseName, shellDo } from './media.js';
import { modelName, modelProblem } from './modelpicker.js';

strings({
  'insp.close': 'Fermer',
  'insp.settings': 'Réglages',
  'insp.noSettings': 'Ce bloc n’a pas de réglage.',
  'insp.versions': 'Versions',
  'insp.noVersions': 'Pas encore de version. Lance un calcul pour en créer une.',
  'insp.file': 'Fichier',
  'insp.actions': 'Actions',
  'insp.pinned': 'gardée',
  'insp.current': 'affichée',
  'insp.failed': 'Échec',
  'insp.cancelled': 'Annulé',
  'insp.revealOutputs': 'Afficher les sorties dans l’Explorateur',
  'insp.reveal': 'Afficher dans l’Explorateur',
  'insp.copy': 'Copier le chemin',
  'insp.copied': 'Chemin copié',
  'insp.focus': 'Centrer la vue sur le bloc',
  'insp.open': 'Ouvrir en grand',
  'insp.more': 'Plus d’actions',
  'insp.star': 'Garder cette version',
  'insp.unstar': 'Ne plus la garder',
  'insp.dragOut': 'Glisse-la vers l’Explorateur ou ton logiciel de montage',
}, {
  'insp.close': 'Close',
  'insp.settings': 'Settings',
  'insp.noSettings': 'This block has no settings.',
  'insp.versions': 'Versions',
  'insp.noVersions': 'No version yet. Run a job to create one.',
  'insp.file': 'File',
  'insp.actions': 'Actions',
  'insp.pinned': 'kept',
  'insp.current': 'shown',
  'insp.failed': 'Failed',
  'insp.cancelled': 'Cancelled',
  'insp.revealOutputs': 'Show outputs in Explorer',
  'insp.reveal': 'Show in Explorer',
  'insp.copy': 'Copy path',
  'insp.copied': 'Path copied',
  'insp.focus': 'Centre the view on the block',
  'insp.open': 'Open full size',
  'insp.more': 'More actions',
  'insp.star': 'Keep this version',
  'insp.unstar': 'Stop keeping it',
  'insp.dragOut': 'Drag it to Explorer or your editing software',
});

const editor = () => window.__mia?.editor || null;
const stop = (e) => e.stopPropagation();

let root = null;
let cur = null;     // { nodeId, params, offs, versionsBox, actionsBox, raf }

function host() {
  if (root) return root;
  root = document.getElementById('inspector');
  if (!root) {
    root = el('aside', { id: 'inspector', hidden: true });
    (document.getElementById('view-board') || document.body).append(root);
  }
  root.classList.add('insp');
  // la planche ne doit ni zoomer ni glisser sous le panneau
  root.addEventListener('pointerdown', stop);
  root.addEventListener('wheel', stop, { passive: true });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.target.closest('input, textarea')) { closeInspector(); e.stopPropagation(); }
  });
  return root;
}

/** Monte l'inspecteur (idempotent ; l'import du module suffit aussi). */
export function mountInspector() { host(); }

export function closeInspector() {
  const r = host();
  // la copie d'abord, puis le démontage : démonté avant, le formulaire des Réglages manquait à la copie (saut de
  // ~330 px de la liste des versions pendant qu'elle s'efface)
  ghostOut(r, { dur: 'exit', to: { translate: '10px 0' } });   // repart vers son bord (SPEC §20.1)
  teardown();
  r.hidden = true;
  r.replaceChildren();
}

function teardown() {
  if (!cur) return;
  for (const off of cur.offs) { try { off(); } catch { /* rien */ } }
  if (cur.raf) cancelAnimationFrame(cur.raf);
  cur.params?.destroy();
  cur = null;
}

/** Ouvre l'inspecteur sur un bloc. */
export function openInspector(nodeId) {
  const ed = editor();
  const node = ed?.getNode?.(nodeId);
  const type = node ? runs.typeOf(nodeId) : null;
  if (!node || !type) return;
  teardown();
  const r = host();
  const wasHidden = r.hidden;

  const title = el('div', { class: 'insp-title' },
    el('span', { class: 'insp-glyph', html: icon(type.icon || 'info', 16) }),
    el('span', { class: 'insp-name' }, node.title || tl(type.label)));
  const close = el('button', { class: 'insp-x', html: icon('close', 14), 'data-tip': t('insp.close') });
  close.addEventListener('click', () => closeInspector());
  const head = el('div', { class: 'insp-head' }, title, close);
  const scroll = el('div', { class: 'insp-scroll' });
  scroll.append(el('p', { class: 'insp-desc' }, tl(type.desc || {})));
  r.replaceChildren(head, scroll);
  r.hidden = false;
  if (wasHidden) { r.classList.remove('enter'); void r.offsetWidth; r.classList.add('enter'); }

  cur = { nodeId, offs: [], params: null, raf: 0 };

  // fichier importé : nom, méta, chemin
  if (node.type === 'import' && node.data?.src) {
    const d = node.data;
    const target = { projectId: state.project?.id, rel: d.src };
    scroll.append(section(t('insp.file'),
      el('div', { class: 'insp-file' },
        el('div', { class: 'insp-file-name' }, d.name || baseName(d.src)),
        el('div', { class: 'insp-file-meta' }, metaText(d.meta, d.kind))),
      el('div', { class: 'insp-row-btns' },
        linkBtn(t('insp.reveal'), 'reveal', () => shellDo('reveal', target)),
        linkBtn(t('insp.copy'), 'copy', () => shellDo('copyPath', target, t('insp.copied'))))));
  }

  // réglages : tous, « Avancé » compris
  const hasParams = (type.params || []).length > 0;
  if (hasParams) {
    const box = el('div', { class: 'insp-params' });
    scroll.append(section(t('insp.settings'), box));
    cur.params = mountParams(box, {
      node, type, mode: 'inspector',
      setParam: (key, v) => editor()?.setParam?.(nodeId, key, v),
    });
  }

  // versions et actions des blocs qui calculent
  if (type.engine) {
    cur.versionsBox = el('div', { class: 'insp-vers' });
    scroll.append(section(t('insp.versions'), cur.versionsBox));
    cur.actionsBox = el('div', { class: 'insp-actions' });
    scroll.append(section(t('insp.actions'), cur.actionsBox));
    renderVersions();
    renderActions();
  } else if (!hasParams && node.type !== 'import') {
    scroll.append(el('p', { class: 'insp-empty' }, t('insp.noSettings')));
  }

  // mises à jour en direct
  const schedule = () => {
    if (!cur || cur.raf) return;
    cur.raf = requestAnimationFrame(() => {
      if (!cur) return;
      cur.raf = 0;
      const n = editor()?.getNode?.(nodeId);
      if (!n) { closeInspector(); return; }
      cur.params?.sync(n);
      cur.params?.refreshInputs();
      const nm = r.querySelector('.insp-name');
      if (nm) nm.textContent = n.title || tl(type.label);
      if (type.engine) { renderVersions(); renderActions(); }
    });
  };
  cur.offs.push(on('graph:changed', schedule));
  cur.offs.push(on('models:updated', schedule));
  cur.offs.push(on('runs:changed', (p) => { if (!p || p.nodeId === nodeId) schedule(); }));
}

function section(label, ...kids) {
  return el('section', { class: 'insp-sec' }, el('h3', { class: 'insp-kicker' }, label), ...kids);
}

function linkBtn(label, ico, fn) {
  const b = el('button', { class: 'insp-link' }, el('span', { html: icon(ico, 14) }), el('span', {}, label));
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  return b;
}

function renderVersions() {
  if (!cur?.versionsBox) return;
  const { nodeId } = cur;
  const box = cur.versionsBox;
  const all = runs.all(nodeId);
  box.replaceChildren();
  if (!all.length) { box.append(el('p', { class: 'insp-empty' }, t('insp.noVersions'))); return; }
  const current = runs.current(nodeId);
  const pinned = editor()?.getNode?.(nodeId)?.pinnedRun || null;
  for (const r of all) {
    const ok = r.status === 'done' || !r.status;
    const n = ok ? runs.versionNumber(nodeId, r.runId) : 0;
    const thumb = ok ? runThumbImg(r) : null;
    const isPinned = pinned === r.runId;
    const isCurrent = current?.runId === r.runId;
    const star = ok ? el('button', {
      class: `insp-star${isPinned ? ' on' : ''}`, html: icon(isPinned ? 'star-fill' : 'star', 14),
      'data-tip': isPinned ? t('insp.unstar') : t('insp.star'),
    }) : null;
    star?.addEventListener('click', (e) => { e.stopPropagation(); runs.pin(nodeId, isPinned ? null : r.runId); });
    const more = el('button', { class: 'insp-more', html: icon('more', 14), 'data-tip': t('insp.more') });
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      const items = ok
        ? versionMenuItems(nodeId, r, {})
        : [{ label: t('insp.reveal'), icon: 'reveal', action: () => shellDo('reveal', { projectId: state.project?.id, rel: runDir(nodeId, r) }) },
          'sep', { label: t('node.ver.delete'), icon: 'trash', danger: true, action: () => askDelete(nodeId, r, '?') }];
      openMenu(items, more);
    });
    const model = r.model ? (typeof r.model === 'object' ? (r.model.label ? modelName(r.model) : tl(r.model)) : r.model) : '';
    const tags = [];
    if (isPinned) tags.push(el('span', { class: 'insp-tag' }, t('insp.pinned')));
    else if (isCurrent) tags.push(el('span', { class: 'insp-tag' }, t('insp.current')));
    if (r.status === 'error') tags.push(el('span', { class: 'insp-tag err' }, t('insp.failed')));
    if (r.status === 'cancelled') tags.push(el('span', { class: 'insp-tag' }, t('insp.cancelled')));
    const row = el('div', { class: `insp-ver${isCurrent ? ' is-current' : ''}${ok ? '' : ' is-failed'}` },
      el('span', { class: 'insp-ver-thumb' }, thumb || el('span', { html: icon(ok ? 'file' : 'warn', 14) })),
      el('div', { class: 'insp-ver-body' },
        el('div', { class: 'insp-ver-line' },
          el('span', { class: 'insp-ver-n' }, ok ? t('node.ver.label', { n }) : '—'), ...tags),
        el('div', { class: 'insp-ver-detail' }, runDetail(r)),
        model ? el('div', { class: 'insp-ver-model' }, model) : null,
        r.status === 'error' && r.error ? el('div', { class: 'insp-ver-err' }, r.error) : null),
      el('div', { class: 'insp-ver-acts' }, star, more));
    if (ok) {
      const out = runs.output(nodeId, null, r);
      row.addEventListener('dblclick', () => {
        if (out?.path) emit('viewer:open', { nodeId, port: out.port, rel: out.path, kind: out.kind, meta: out.meta || null, runId: r.runId, current: isCurrent });
      });
      // la vignette se glisse hors de Mia comme le vrai fichier (Explorateur, montage…)
      const th = row.querySelector('.insp-ver-thumb');
      if (out?.path && th && window.mia?.shell?.startDrag) {
        th.draggable = true;
        th.dataset.tip = t('insp.dragOut');
        th.addEventListener('dragstart', (e) => {
          e.preventDefault();
          window.mia.shell.startDrag({ projectId: state.project?.id, rel: out.path });
        });
      }
    }
    box.append(row);
  }
}

function renderActions() {
  if (!cur?.actionsBox) return;
  const { nodeId } = cur;
  const type = runs.typeOf(nodeId);
  const box = cur.actionsBox;
  const st = runs.state(nodeId);
  box.replaceChildren();
  const active = st.kind === 'queued' || st.kind === 'waiting-gpu' || st.kind === 'running';
  const btns = el('div', { class: 'insp-run' });
  let install = null;
  if (active) {
    btns.append(button({ label: t('node.cancel'), icon: 'stop', kind: 'ghost', size: 'sm', onClick: () => runs.cancel(nodeId) }));
  } else {
    // modèle absent : boutons éteints, la raison au survol (comme dans la carte)
    const problem = type ? modelProblem(type, editor()?.getNode?.(nodeId)) : null;
    const off = !!problem;
    const wrap = (b) => (off ? el('span', { class: 'nb-act-off', 'data-tip': t('node.model.cantRun', { why: problem.sub || problem.title }) }, b) : b);
    // un seul « Générer », comme dans la carte : les réglages du bloc décident de la durée
    const verb = type?.id === 'export' ? 'node.export' : type?.category === 'tools' ? 'node.apply' : 'node.generate';   // comme la carte (body.js runVerbKey)
    btns.append(wrap(button({ label: t(verb), icon: 'play', kind: off ? 'ghost' : 'shiny', size: 'sm', disabled: off, onClick: () => emit('node:run', { nodeId, mode: null }) })));
    if (problem) btns.prepend(el('span', { class: 'insp-run-why' }, problem.title));
    // et de quoi l'installer (SPEC §21.4) : la bibliothèque s'ouvre sur ce qu'il faut pour ce bloc
    if (problem) install = linkBtn(t('node.model.install'), 'node-dl', () => emit('installer:open', { caps: problem.caps || [] }));
  }
  box.append(btns, ...(install ? [install] : []),
    linkBtn(t('insp.revealOutputs'), 'folder', () => shellDo('reveal', { projectId: state.project?.id, rel: `outputs/${nodeId}` })),
    linkBtn(t('insp.focus'), 'fit', () => editor()?.focusNode?.(nodeId)));
}

// ── branchements ─────────────────────────────────────────────────────

on('inspector:open', (p) => { if (p?.nodeId) openInspector(p.nodeId); });
on('selection:changed', (p) => {
  if (!cur || host().hidden) return;
  const ids = p?.ids || [];
  if (ids.length === 1 && ids[0] !== cur.nodeId) openInspector(ids[0]);
});
on('project:closing', () => closeInspector());

export const isInspectorOpen = () => !!cur;
