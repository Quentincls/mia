// ── File d'attente des calculs (#queue) et puce GPU de la barre de titre ──
// Quentin ne veut plus demander « on en est où » : chaque calcul se voit,
// avec son heure de fin prévue (« fin vers 20 h 45 », usage.md §2). La file
// est une pastille discrète en bas à droite (« 2 calculs · fin vers 20 h 45 »)
// qui s'ouvre en liste ; elle disparaît quand rien ne tourne.
//
// La puce GPU (« GPU 11,2 / 24 GO » + jauge de 2 px) dit qui tient la carte
// graphique ; un clic ouvre l'état du moteur (ComfyUI) et permet de le
// démarrer. Un seul calcul lourd à la fois : c'est la règle de la machine.

import { on } from '../bus.js';
import { t, tn } from '../i18n.js';
import { icon } from '../icons.js';
import { el, fmtClock } from '../util.js';
import { state } from '../state.js';
import { toast } from './toasts.js';
import { tip } from './tooltip.js';
import { button } from './controls.js';
import * as runs from '../nodes/runs.js';
import { strings, num } from '../nodes/media.js';

strings({
  'queue.title': 'Calculs',
  'queue.count.one': '{n} calcul',
  'queue.count.other': '{n} calculs',
  'queue.waiting': 'en attente',
  'queue.gpuWait': 'GPU occupé',
  'queue.cancel': 'Annuler ce calcul',
  'queue.collapse': 'Replier',
  'queue.expand': 'Voir les calculs',
  'queue.otherBoard': 'Planche « {name} »',
  'queue.preview': 'Aperçu',
  'queue.final': 'Rendu final',
  'gpu.chip': 'GPU {used} / {total} Go',
  'gpu.chipNoTotal': 'GPU',
  'gpu.free': 'GPU libre',
  'gpu.heldBy': 'Pris par « {who} » depuis {since}',
  'gpu.heldByMia': 'Mia calcule : « {who} »',
  'gpu.busyOther': 'Utilisé par un autre programme',
  'gpu.engine': 'Moteur',
  'gpu.card': 'Carte graphique',
  'gpu.queue': 'File de Mia',
  'gpu.vram': '{used} / {total} Go de mémoire vidéo utilisés',
  'gpu.start': 'Démarrer le moteur',
  'gpu.starting': 'Démarrage du moteur…',
  'gpu.started': 'Le moteur est prêt.',
  'gpu.startFailed': 'Le moteur n’a pas pu démarrer.',
  'gpu.st.running': 'En marche',
  'gpu.st.stopped': 'Arrêté',
  'gpu.st.starting': 'Démarrage…',
  'gpu.st.error': 'En erreur',
  'gpu.st.foreign': 'En marche (lancé hors de Mia)',
  'gpu.st.unknown': 'État inconnu',
  'gpu.stoppedHint': 'Il démarrera tout seul au premier calcul.',
  'gpu.queueEmpty': 'Rien en cours',
  'gpu.queueRunning': '{n} en cours',
  'gpu.queueWaiting': '{n} en attente',
  'gpu.showQueue': 'Voir la file',
}, {
  'queue.title': 'Jobs',
  'queue.count.one': '{n} job',
  'queue.count.other': '{n} jobs',
  'queue.waiting': 'waiting',
  'queue.gpuWait': 'GPU busy',
  'queue.cancel': 'Cancel this job',
  'queue.collapse': 'Collapse',
  'queue.expand': 'Show jobs',
  'queue.otherBoard': 'Board “{name}”',
  'queue.preview': 'Preview',
  'queue.final': 'Final render',
  'gpu.chip': 'GPU {used} / {total} GB',
  'gpu.chipNoTotal': 'GPU',
  'gpu.free': 'GPU free',
  'gpu.heldBy': 'Held by “{who}” since {since}',
  'gpu.heldByMia': 'Mia is computing: “{who}”',
  'gpu.busyOther': 'Used by another program',
  'gpu.engine': 'Engine',
  'gpu.card': 'Graphics card',
  'gpu.queue': 'Mia queue',
  'gpu.vram': '{used} / {total} GB of video memory in use',
  'gpu.start': 'Start the engine',
  'gpu.starting': 'Starting the engine…',
  'gpu.started': 'The engine is ready.',
  'gpu.startFailed': 'The engine could not start.',
  'gpu.st.running': 'Running',
  'gpu.st.stopped': 'Stopped',
  'gpu.st.starting': 'Starting…',
  'gpu.st.error': 'Error',
  'gpu.st.foreign': 'Running (started outside Mia)',
  'gpu.st.unknown': 'Unknown state',
  'gpu.stoppedHint': 'It starts by itself with the first job.',
  'gpu.queueEmpty': 'Nothing running',
  'gpu.queueRunning': '{n} running',
  'gpu.queueWaiting': '{n} waiting',
  'gpu.showQueue': 'Show the queue',
});

const ACTIVE = new Set(['queued', 'waiting-gpu', 'running']);
const stop = (e) => e.stopPropagation();

// ── statut du moteur (bus + pont direct + relève lente en secours) ───

let status = null;
const statusListeners = new Set();
let lastStatusAt = 0;

function setStatus(s) {
  if (!s) return;
  status = s;
  lastStatusAt = Date.now();
  for (const fn of statusListeners) { try { fn(s); } catch (e) { console.error(e); } }
}
function onStatus(fn) {
  statusListeners.add(fn);
  if (status) fn(status);
  return () => statusListeners.delete(fn);
}

let statusWired = false;
function wireStatus() {
  if (statusWired) return;
  statusWired = true;
  on('engine:status', setStatus);
  try { window.mia?.engine?.onStatus?.(setStatus); } catch { /* pont absent */ }
  if (state.engine) setStatus(state.engine);
  const fetchNow = async () => {
    try { setStatus(await window.mia?.engine?.status?.()); } catch { /* moteur pas prêt */ }
  };
  fetchNow();
  // si personne ne pousse le statut, on le relève nous-mêmes toutes les 5 s
  setInterval(() => { if (!document.hidden && Date.now() - lastStatusAt > 6000) fetchNow(); }, 5000);
}

/** Heure lisible d'un horodatage (ms, s ou ISO). */
function clockOf(v) {
  if (v == null) return '?';
  const ms = typeof v === 'number' ? (v < 1e11 ? v * 1000 : v) : Date.parse(v);
  return isFinite(ms) ? fmtClock(ms) : '?';
}

// ── file d'attente ───────────────────────────────────────────────────
// Construite une fois, mise à jour en place (clé = jobId) : un évènement de
// progression ne doit ni recréer la pastille ni rejouer son entrée.

let queueMounted = false;
let expanded = false;
let qRoot = null;
let Q = null;            // { pill, dot, sum, bar, fill, panel, list, rows: Map(jobId → row) }

const LINGER_MS = 12000;   // un job fini ne reste jamais plus longtemps (filet si son nettoyage manque)

/** Monte le panneau #queue (une seule fois). `host` = #queue (facultatif). */
export function mountQueue(host) {
  if (queueMounted) return;
  queueMounted = true;
  wireStatus();
  qRoot = host || document.getElementById('queue');
  if (!qRoot) {
    qRoot = el('div', { id: 'queue' });
    (document.getElementById('view-board') || document.body).append(qRoot);
  }
  qRoot.classList.add('q');
  qRoot.hidden = true;
  qRoot.addEventListener('pointerdown', stop);
  qRoot.addEventListener('wheel', stop, { passive: true });
  qRoot.addEventListener('dblclick', stop);

  runs.onJobs(renderQueue);
  on('project:opened', () => renderQueue(runs.jobList()));
  // l'heure de fin bouge avec le temps, et un job fini doit partir : rafraîchissement doux
  setInterval(() => { if (!qRoot.hidden && !document.hidden) renderQueue(runs.jobList()); }, 5000);
  renderQueue(runs.jobList());
}

// Durées de repli (s) tant que Mia n'a rien appris dans ce projet : celles du moteur.
const DEFAULT_SEC = {
  'i2v|preview': 120, 'i2v|final': 540, 't2v|preview': 120, 't2v|final': 540, 'ref2v|preview': 150, 'ref2v|final': 420,
  'real|preview': 180, 'real|final': 1200, 'guided|preview': 150, 'guided|final': 600, 'perform|preview': 300,
  'perform|final': 900, edit: 180, upscale: 1200, depth: 120, cutout: 180, composite: 60,
};

/** Durée estimée (s) d'un job pas encore commencé. */
function estimateSec(j) {
  if (j.estSec > 0) return j.estSec;            // le moteur peut l'annoncer (évènement « queued »)
  const learned = runs.typicalSec(j.type, j.mode || null);
  if (learned) return learned;
  const ty = runs.typeById?.(j.type);
  if (ty?.engine?.gpu && ty.engine.gpu !== 'heavy') return 15;
  return DEFAULT_SEC[`${j.type}|${j.mode}`] || DEFAULT_SEC[j.type] || 300;
}

const ms = (v) => (v == null ? null : v < 1e11 ? v * 1000 : v);

/**
 * Heure de fin de toute la file : les calculs en cours finissent à leur heure
 * annoncée, puis ceux en attente s'enchaînent (un calcul lourd à la fois).
 */
function queueEnd(active) {
  const now = Date.now();
  let t0 = now;
  for (const j of active) {
    if (j.state !== 'running') continue;
    const started = ms(j.started) || now;
    const end = j.endAt || started + estimateSec(j) * 1000;
    t0 = Math.max(t0, end);
  }
  let end = t0;
  for (const j of active) if (j.state !== 'running') end += estimateSec(j) * 1000;
  return end > now ? end : null;
}

function jobStatus(j, waitingOrder) {
  const st = { kind: j.state, progress: j.progress, endAt: j.endAt, position: null, run: j.run, who: j.who, since: j.since };
  if (j.state === 'queued') st.position = (waitingOrder.indexOf(j.jobId) + 1) || null;
  return runs.describe(st);
}

function buildSkeleton() {
  const dot = el('span', { class: 'q-dot' });
  // « <bloc> · <état> » : le nom cède (« … »), l'état reste toujours entier
  const sumName = el('span', { class: 'q-sum-name' });
  const sumState = el('span', { class: 'q-sum-st' });
  const sum = el('span', { class: 'q-sum' }, sumName, sumState);
  const fill = el('i');
  const bar = el('span', { class: 'q-bar' }, fill);
  const pill = el('button', { class: 'q-pill' }, dot, sum, el('span', { class: 'q-chev', html: icon('chevron', 12) }), bar);
  let tipText = '';
  tip(pill, () => tipText);
  pill.addEventListener('click', () => { expanded = !expanded; renderQueue(runs.jobList()); });
  const list = el('div', { class: 'q-list' });
  const panel = el('div', { class: 'q-panel', hidden: true },
    el('div', { class: 'q-head' }, el('span', { class: 'q-kicker' }, t('queue.title'))),
    list);
  qRoot.replaceChildren(panel, pill);
  return { pill, dot, sum, sumName, sumState, bar, fill, panel, list, rows: new Map(), setTip: (s) => { tipText = s; } };
}

function setBar(bar, fill, j) {
  const isOn = j?.state === 'running';
  bar.classList.toggle('on', isOn);
  bar.classList.toggle('ind', isOn && j.progress == null);
  const tf = isOn && j.progress != null ? `scaleX(${Math.max(0.005, j.progress)})` : '';
  if (fill.style.transform !== tf) fill.style.transform = tf;
}

function renderQueue(jobs) {
  if (!qRoot) return;
  const now = Date.now();
  const active = jobs.filter((j) => ACTIVE.has(j.state));
  // un job fini reste visible quelques secondes (« FAIT · 38 S »), jamais plus
  const visible = jobs.filter((j) => ACTIVE.has(j.state)
    || ((j.state === 'done' || j.state === 'error' || j.state === 'cancelled') && now - (ms(j.finished) || now) < LINGER_MS));
  if (!visible.length) {
    if (!qRoot.hidden) { qRoot.hidden = true; qRoot.classList.remove('q-enter'); }
    expanded = false;
    if (Q) { Q.panel.hidden = true; Q.list.replaceChildren(); Q.rows.clear(); }
    return;
  }
  if (!Q) Q = buildSkeleton();
  if (qRoot.hidden) {
    qRoot.hidden = false;
    // entrée jouée une seule fois, quand la file apparaît
    qRoot.classList.remove('q-enter');
    void qRoot.offsetWidth;
    qRoot.classList.add('q-enter');
  }
  const running = active.find((j) => j.state === 'running');
  const waitingOrder = jobs.filter((j) => j.state === 'queued' || j.state === 'waiting-gpu').map((j) => j.jobId);

  // pastille : « 2 calculs · fin vers 20 h 45 » (en cours + en attente)
  const n = active.length;
  let sumName, sumState;
  if (n) {
    const end = queueEnd(active);
    sumName = tn('queue.count', n, { n });
    sumState = end ? runs.endText(end) : (active.some((j) => j.state === 'waiting-gpu') ? t('queue.gpuWait') : t('queue.waiting'));
  } else {
    // plus rien ne tourne : le calcul terminé le plus récemment (pas le dernier de la liste)
    const last = visible.reduce((a, b) => ((ms(b.finished) || 0) >= (ms(a.finished) || 0) ? b : a));
    sumName = last.label || runs.nodeLabel(last.nodeId) || '';
    sumState = jobStatus(last, waitingOrder).text;
  }
  if (Q.sumName.textContent !== sumName) Q.sumName.textContent = sumName;
  if (Q.sumState.textContent !== sumState) Q.sumState.textContent = sumState;
  Q.sumState.classList.toggle('after', !!sumName);
  Q.dot.classList.toggle('on', !!running);
  Q.pill.classList.toggle('open', expanded);
  Q.setTip(expanded ? t('queue.collapse') : t('queue.expand'));
  setBar(Q.bar, Q.fill, running);

  // liste détaillée
  if (!expanded) {
    if (!Q.panel.hidden) Q.panel.hidden = true;
    return;
  }
  if (Q.panel.hidden) {
    Q.panel.hidden = false;
    Q.panel.classList.remove('q-open');
    void Q.panel.offsetWidth;
    Q.panel.classList.add('q-open');
  }
  const keep = new Set();
  let prev = null;
  for (const j of visible) {
    keep.add(j.jobId);
    let row = Q.rows.get(j.jobId);
    if (!row) { row = jobRow(j); Q.rows.set(j.jobId, row); }
    row.update(j, waitingOrder);
    // ordre de création, sans tout déplacer à chaque évènement
    const want = prev ? prev.el.nextSibling : Q.list.firstChild;
    if (want !== row.el) Q.list.insertBefore(row.el, want);
    prev = row;
  }
  for (const [id, row] of Q.rows) if (!keep.has(id)) { row.el.remove(); Q.rows.delete(id); }
}

function jobRow(j0) {
  let j = j0;
  const label = el('div', { class: 'q-label' });
  const sub = el('div', { class: 'q-sub' });
  const stEl = el('span', { class: 'q-st' });
  const fill = el('i');
  const bar = el('span', { class: 'q-bar' }, fill);
  const cancel = el('button', { class: 'q-x', html: icon('close', 12), 'data-tip': t('queue.cancel') });
  cancel.addEventListener('click', (e) => { e.stopPropagation(); runs.cancelJob(j.jobId); });
  const spacer = el('span');
  // ligne 1 : le bloc (et ×) ; ligne 2 : mode · planche, et l'état en mono — deux rangées indépendantes :
  // la largeur de l'état ne prend jamais la place du nom
  const line1 = el('div', { class: 'q-line' }, label, spacer);
  const rowEl = el('div', { class: 'q-row' }, line1, el('div', { class: 'q-line' }, sub, stEl), bar);
  let tipText = '';
  tip(rowEl, () => tipText);
  rowEl.addEventListener('click', () => {
    if (j.projectId && j.projectId !== state.project?.id) return;
    window.__mia?.editor?.focusNode?.(j.nodeId);
    window.__mia?.editor?.select?.([j.nodeId]);
  });
  return {
    el: rowEl,
    update(next, waitingOrder) {
      j = next;
      const d = jobStatus(j, waitingOrder);
      const other = j.projectId && j.projectId !== state.project?.id;
      const lbl = j.label || (other ? '' : runs.nodeLabel(j.nodeId)) || '…';
      if (label.textContent !== lbl) label.textContent = lbl;
      const s = [
        j.mode ? t(j.mode === 'final' ? 'queue.final' : 'queue.preview') : '',
        other ? t('queue.otherBoard', { name: runs.projectName(j.projectId) || j.projectName || '…' }) : runs.projectName(j.projectId),
      ].filter(Boolean).join(' · ');
      if (sub.textContent !== s) sub.textContent = s;
      if (stEl.textContent !== d.text) stEl.textContent = d.text;
      stEl.dataset.tone = d.tone;
      // le nom entier et « mode · planche » (la rangée peut les couper), puis l'état
      tipText = [lbl, s, d.tip || d.text].filter(Boolean).join(' · ');
      const cls = `q-row is-${j.state}`;
      if (rowEl.className !== cls) rowEl.className = cls;
      const isActive = ACTIVE.has(j.state);
      if (isActive && cancel.parentNode !== line1) line1.replaceChild(cancel, spacer);
      else if (!isActive && cancel.parentNode === line1) line1.replaceChild(spacer, cancel);
      setBar(bar, fill, j);
    },
  };
}

// ── puce GPU ─────────────────────────────────────────────────────────

let chipMounted = false;

/** Monte la puce GPU dans `container` (#tb-actions). */
export function mountGpuChip(container) {
  if (chipMounted || !container) return;
  chipMounted = true;
  wireStatus();
  const label = el('span', { class: 'gpu-txt' }, t('gpu.chipNoTotal'));
  const fill = el('i');
  const gauge = el('span', { class: 'gpu-gauge' }, fill);
  const chip = el('button', { class: 'gpu-chip' }, label, gauge);
  container.append(chip);   // ordre de D : [Modèles] [GPU] [Réglages]
  let tipText = '';
  tip(chip, () => tipText, { placement: 'bottom' });

  function paint(s) {
    const g = s?.gpu || {};
    const used = g.vramUsedGB, total = g.vramTotalGB;
    label.textContent = total ? t('gpu.chip', { used: num(used ?? 0), total: num(total, 0) }) : t('gpu.chipNoTotal');
    const frac = total ? Math.min(1, Math.max(0, (used || 0) / total)) : 0;
    fill.style.transform = `scaleX(${frac})`;
    chip.classList.toggle('busy', !!(g.lock && !g.lock.mine) || !!g.busyOther);
    chip.classList.toggle('mine', !!g.lock?.mine);
    tipText = holderText(g);
  }
  onStatus(paint);
  paint(status);

  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popEl) { closePop(); return; }
    openPop(chip);
  });
}

function holderText(g = {}) {
  if (g.lock) {
    if (g.lock.mine) return t('gpu.heldByMia', { who: String(g.lock.who || '').replace(/^Mia\s*:\s*/, '') });
    return t('gpu.heldBy', { who: g.lock.who || '?', since: clockOf(g.lock.since) });
  }
  if (g.busyOther) return t('gpu.busyOther');
  return t('gpu.free');
}

let popEl = null;
let popOffs = [];
function closePop() {
  for (const off of popOffs) off();
  popOffs = [];
  popEl?.remove();
  popEl = null;
}

function openPop(anchor) {
  closePop();
  const body = el('div', { class: 'gpu-pop-body' });
  popEl = el('div', { class: 'gpu-pop' }, body);
  popEl.addEventListener('pointerdown', stop);
  document.body.append(popEl);

  const render = (s) => {
    const c = s?.comfy || {};
    const g = s?.gpu || {};
    const stKey = { running: 'gpu.st.running', stopped: 'gpu.st.stopped', starting: 'gpu.st.starting', error: 'gpu.st.error', foreign: 'gpu.st.foreign' }[c.state] || 'gpu.st.unknown';
    const canStart = c.state === 'stopped' || c.state === 'error';
    const engineRows = [
      el('div', { class: 'gp-line' },
        el('span', { class: `gp-dot st-${c.state || 'unknown'}` }),
        el('span', { class: 'gp-main' }, `ComfyUI · ${t(stKey)}`),
        c.version ? el('span', { class: 'gp-mono' }, c.version) : null),
    ];
    if (c.state === 'error' && c.error) engineRows.push(el('div', { class: 'gp-err' }, c.error));
    if (c.state === 'stopped') engineRows.push(el('div', { class: 'gp-hint' }, t('gpu.stoppedHint')));
    if (canStart) {
      engineRows.push(el('div', { class: 'gp-act' }, button({
        label: t('gpu.start'), icon: 'play', kind: 'ghost', size: 'sm',
        onClick: async () => {
          toast(t('gpu.starting'));
          let res;
          try { res = await window.mia.engine.startComfy(); } catch { res = { ok: false }; }
          if (res?.ok) toast(t('gpu.started'), { kind: 'ok' });
          else toast(res?.error || t('gpu.startFailed'), { kind: 'error' });
        },
      })));
    }
    const used = g.vramUsedGB, total = g.vramTotalGB;
    const frac = total ? Math.min(1, (used || 0) / total) : 0;
    const gaugeFill = el('i');
    gaugeFill.style.transform = `scaleX(${frac})`;
    const jobs = runs.jobList();
    const nRun = jobs.filter((j) => j.state === 'running').length;
    const nWait = jobs.filter((j) => j.state === 'queued' || j.state === 'waiting-gpu').length;
    const qText = !nRun && !nWait ? t('gpu.queueEmpty')
      : [nRun ? t('gpu.queueRunning', { n: nRun }) : '', nWait ? t('gpu.queueWaiting', { n: nWait }) : ''].filter(Boolean).join(' · ');
    const showQ = nRun || nWait ? el('button', { class: 'gp-link' }, t('gpu.showQueue')) : null;
    showQ?.addEventListener('click', () => { expanded = true; renderQueue(runs.jobList()); closePop(); });

    body.replaceChildren(
      el('div', { class: 'gp-sec' }, el('div', { class: 'gp-kicker' }, t('gpu.engine')), ...engineRows),
      el('div', { class: 'gp-sec' },
        el('div', { class: 'gp-kicker' }, t('gpu.card')),
        el('div', { class: 'gp-line' }, el('span', { class: 'gp-main' }, g.name || '—')),
        total ? el('div', { class: 'gp-gauge' }, gaugeFill) : null,
        total ? el('div', { class: 'gp-sub' }, t('gpu.vram', { used: num(used ?? 0), total: num(total, 0) })) : null,
        el('div', { class: `gp-holder${g.lock && !g.lock.mine ? ' busy' : ''}` }, holderText(g))),
      el('div', { class: 'gp-sec' },
        el('div', { class: 'gp-kicker' }, t('gpu.queue')),
        el('div', { class: 'gp-line' }, el('span', { class: 'gp-main' }, qText), showQ)));
    place();
  };

  function place() {
    const r = anchor.getBoundingClientRect();
    const w = popEl.offsetWidth;
    popEl.style.top = `${r.bottom + 8}px`;
    popEl.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
  }

  popOffs.push(onStatus(render));
  popOffs.push(runs.onJobs(() => render(status)));
  render(status);
  const onDown = (e) => { if (popEl && !popEl.contains(e.target) && !anchor.contains(e.target)) closePop(); };
  const onKey = (e) => { if (e.key === 'Escape') { closePop(); e.stopPropagation(); } };
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', closePop);
  popOffs.push(() => {
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', closePop);
  });
}

// ── filet de sécurité : si l'app ne monte pas ces éléments, on le fait ──
on('app:ready', () => {
  setTimeout(() => {
    if (!queueMounted) mountQueue();
    if (!chipMounted) mountGpuChip(document.getElementById('tb-actions'));
  }, 0);
});

