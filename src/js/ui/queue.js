// ── File d'attente des calculs (#queue) et puce GPU de la barre de titre ──
// Quentin ne veut plus demander « on en est où » : chaque calcul se voit,
// avec son heure de fin prévue (« fin vers 20 h 45 », usage.md §2). La file
// est une pastille discrète en bas à droite (« 2 calculs · fin vers 20 h 45 »)
// qui s'ouvre en liste ; elle disparaît quand rien ne tourne.
//
// La puce GPU (« GPU 11,2 / 24 GO » + jauge de 2 px) dit qui tient la carte
// graphique ; un clic ouvre l'état du moteur (ComfyUI) et permet de le
// démarrer. Un seul calcul lourd à la fois : c'est la règle de la machine.

import { on, emit } from '../bus.js';
import { t, tn, lang } from '../i18n.js';
import { icon } from '../icons.js';
import { el, fmtClock } from '../util.js';
import { state } from '../state.js';
import { toast } from './toasts.js';
import { tip } from './tooltip.js';
import { button } from './controls.js';
import { ghostOut } from './motion.js';
import { confirm } from './modal.js';
import * as runs from '../nodes/runs.js';
import { strings, num } from '../nodes/media.js';
import * as QT from './queuetrain.js';

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
  'gpu.chip': 'GPU {used} / {total} Go',
  'gpu.chipNoTotal': 'GPU',
  'gpu.free': 'GPU libre',
  'gpu.heldBy': 'Pris par « {who} » depuis {since}',
  'gpu.heldByMia': 'Mia calcule : « {who} »',
  'gpu.busyOther': 'Utilisé par un autre programme',
  'gpu.engine': 'Moteur',
  'gpu.card': 'Carte graphique',
  'gpu.queue': 'File de Mia',
  'gpu.vram': '{used} / {total} Go de mémoire utilisés',
  'gpu.totalSmi': 'Total lu par le pilote NVIDIA : ComfyUI donnera le sien à son premier démarrage.',
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
  'queue.online': 'En ligne',
  'gpu.queueOnline': 'En ligne : {run} en cours · {wait} en file · {max} à la fois',
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
  'gpu.chip': 'GPU {used} / {total} GB',
  'gpu.chipNoTotal': 'GPU',
  'gpu.free': 'GPU free',
  'gpu.heldBy': 'Held by “{who}” since {since}',
  'gpu.heldByMia': 'Mia is computing: “{who}”',
  'gpu.busyOther': 'Used by another program',
  'gpu.engine': 'Engine',
  'gpu.card': 'Graphics card',
  'gpu.queue': 'Mia queue',
  'gpu.vram': '{used} / {total} GB of memory in use',
  'gpu.totalSmi': 'Total read from the NVIDIA driver: ComfyUI will give its own on first start.',
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
  'queue.online': 'Online',
  'gpu.queueOnline': 'Online: {run} running · {wait} queued · {max} at once',
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
  wireTraining();
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

// ── l'entraînement de LoRA (electron\trainer.js) : une rangée en tête de la file ──
// Il vit dans le processus principal ; la fenêtre suit train:list puis train:event (un envoi par seconde
// au plus). Les mots et les états viennent de queuetrain.js (vérifiés sans fenêtre).
let trainRows = [];        // train:list, tenue à jour par train:event
let trainBases = null;     // train:options().bases : le nom du modèle (« LTX 2.5 »), lu une fois
let trainBasesAsked = false;
let trainShown = null;     // { id, gone } : l'entraînement en tête ; gone = quand il a cessé d'être actif
const trainApi = () => window.mia?.train || null;
const L2 = () => (lang() === 'en' ? 'en' : 'fr');

function wireTraining() {
  const a = trainApi();
  if (!a) return;
  const load = async () => {
    try {
      const list = await a.list();
      if (Array.isArray(list)) { trainRows = list; trainChanged(); }
    } catch { /* service pas prêt : le prochain évènement relira */ }
  };
  try {
    a.onEvent?.((ev) => {
      if (!ev) return;
      if (ev.list) { load(); return; }
      if (!ev.id || !ev.summary) return;
      const i = trainRows.findIndex((r) => r.id === ev.id);
      if (i >= 0) trainRows[i] = { ...trainRows[i], ...ev.summary };
      else trainRows.unshift(ev.summary);
      trainChanged();
    });
  } catch (err) { console.error('[queue] train.onEvent', err); }
  load();
}

function trainChanged() {
  if (!trainBasesAsked && QT.queueTraining(trainRows)) {
    trainBasesAsked = true;
    Promise.resolve().then(() => trainApi()?.options?.()).then((o) => {
      if (o && Array.isArray(o.bases)) { trainBases = o.bases; renderQueue(runs.jobList()); }
    }).catch(() => { trainBasesAsked = false; });
  }
  renderQueue(runs.jobList());
}

/** L'entraînement à montrer : l'actif ; sinon celui qui vient de finir, quelques secondes (comme un calcul fini). */
function currentTraining(now) {
  const act = QT.queueTraining(trainRows);
  if (act) { trainShown = { id: act.id, gone: 0 }; return act; }
  if (!trainShown) return null;
  const s = trainRows.find((r) => r.id === trainShown.id);
  if (!s || s.missing || !QT.ENDED.has(s.state)) { trainShown = null; return null; }
  if (!trainShown.gone) trainShown.gone = now;
  if (now - trainShown.gone >= LINGER_MS) { trainShown = null; return null; }
  return s;
}
const trainActive = (s) => !!(s && QT.queueTraining([s]));

/** La croix : la même question que « Arrêter… » de l'écran d'entraînement, relue sur l'état complet. */
async function askStopTraining(s0) {
  const a = trainApi();
  if (!a || !s0) return;
  let s = s0;
  try {
    const full = await a.get(s0.id);
    if (full && full.ok !== false && full.id === s0.id) s = { ...s0, ...full };
  } catch { /* le résumé suffit pour la question */ }
  if (!(await confirm({ ...QT.stopQuestion(L2(), s, trainBases), danger: true }))) return;
  let r;
  try { r = await a.control(s.id, 'stop'); } catch (err) { r = { ok: false, error: err?.message || String(err) }; }
  if (!r || r.ok === false) toast((r && r.error) || QT.qx(L2(), 'q.stopFailed'), { kind: 'error', ms: 7000 });
}

/**
 * Heure de fin de toute la file : les calculs en cours finissent à leur heure
 * annoncée, puis ceux en attente s'enchaînent (un calcul lourd à la fois).
 * Un entraînement actif passe d'abord : les calculs locaux en attente partent à sa fin
 * (inconnue → pas d'heure) ; la file ne finit pas avant lui.
 */
function queueEnd(active, training = null) {
  const now = Date.now();
  // deux voies : le local s'enchaîne (un calcul lourd à la fois) ; l'en ligne tourne en parallèle, à côté
  const lane = (list, width, from = now) => {
    let t0 = now;
    for (const j of list) {
      if (j.state !== 'running') continue;
      const started = ms(j.started) || now;
      t0 = Math.max(t0, j.endAt || started + estimateSec(j) * 1000);
    }
    let end = t0;
    const waiting = list.filter((j) => j.state !== 'running');
    if (waiting.length && from == null) return null;
    if (waiting.length) end = Math.max(end, from);
    for (const j of waiting) end += (estimateSec(j) * 1000) / width;
    return end;
  };
  const online = active.filter((j) => j.online);
  const width = Math.max(1, Number(status?.queue?.online?.max) || 4);
  const local = lane(active.filter((j) => !j.online), 1, QT.laneStart(now, trainActive(training) ? training : null));
  if (local == null) return null;
  let end = Math.max(local, online.length ? lane(online, width) : now);
  if (trainActive(training)) {
    if (!training.endAt) return null;
    end = Math.max(end, training.endAt);
  }
  return end > now ? end : null;
}

function jobStatus(j, waitingOrder) {
  const st = { kind: j.state, progress: j.progress, endAt: j.endAt, position: null, run: j.run, who: j.who, since: j.since,
    online: !!j.online, remote: j.remote || null, message: j.message || null,
    // entraînement de LoRA (SPEC §8.7) : à côté (son nom), ou retenu derrière (la raison au survol)
    beside: j.beside || null, trainWait: !!j.trainWait };
  // la place dans SA voie : un calcul en ligne n'attend pas derrière les calculs locaux (ni l'inverse)
  if (j.state === 'queued') st.position = (waitingOrder.filter((id) => !!onlineOf.get(id) === !!j.online).indexOf(j.jobId) + 1) || null;
  // en ligne, en file chez Higgsfield ou sa file pleine : runs.describe le dit (même texte que l'en-tête du bloc)
  return runs.describe(st);
}
const onlineOf = new Map();     // jobId → en ligne ? (rempli à chaque rendu de la file)

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

/** La barre de 2 px d'un entraînement : progression (entraînement, essai), indéterminée (préparation), rien sinon. */
function setTrainBar(bar, fill, m) {
  const isOn = !!m && m.bar != null;
  bar.classList.toggle('on', isOn);
  bar.classList.toggle('ind', isOn && m.bar === 'ind');
  const tf = isOn && m.bar === 'progress' ? `scaleX(${Math.max(0.005, m.progress)})` : '';
  if (fill.style.transform !== tf) fill.style.transform = tf;
}

/** La rangée « Entraînement LoRA · Rosa » : clic = l'écran de l'entraînement ; la croix = « Arrêter… ». */
function trainRowEl() {
  let s = null;
  const label = el('div', { class: 'q-label' });
  const sub = el('div', { class: 'q-sub' });
  const stEl = el('span', { class: 'q-st' });
  const fill = el('i');
  const bar = el('span', { class: 'q-bar' }, fill);
  const cancel = el('button', { class: 'q-x', html: icon('close', 12), 'data-tip': QT.qx(L2(), 'q.stop') });
  cancel.addEventListener('click', (e) => { e.stopPropagation(); askStopTraining(s); });
  const spacer = el('span');
  const line1 = el('div', { class: 'q-line' }, label, spacer);
  const rowEl = el('div', { class: 'q-row q-train' }, line1, el('div', { class: 'q-line' }, sub, stEl), bar);
  rowEl.dataset.train = '';
  let tipText = '';
  tip(rowEl, () => tipText);
  rowEl.addEventListener('click', () => { if (s) emit('train:open', { id: s.id }); });
  return {
    el: rowEl,
    update(next, m) {
      s = next;
      rowEl.dataset.train = s.id;
      if (label.textContent !== m.label) label.textContent = m.label;
      if (sub.textContent !== m.sub) sub.textContent = m.sub;
      if (stEl.textContent !== m.text) stEl.textContent = m.text;
      stEl.dataset.tone = m.tone;
      tipText = m.tip;
      const kind = m.cancel ? 'running' : (m.tone === 'err' ? 'error' : 'done');
      const cls = `q-row q-train is-${kind}`;
      if (rowEl.className !== cls) rowEl.className = cls;
      if (m.cancel && cancel.parentNode !== line1) line1.replaceChild(cancel, spacer);
      else if (!m.cancel && cancel.parentNode === line1) line1.replaceChild(spacer, cancel);
      setTrainBar(bar, fill, m);
    },
  };
}

function renderQueue(jobs) {
  if (!qRoot) return;
  const now = Date.now();
  const active = jobs.filter((j) => ACTIVE.has(j.state));
  // un job fini reste visible quelques secondes (« FAIT · 38 S »), jamais plus
  const visible = jobs.filter((j) => ACTIVE.has(j.state)
    || ((j.state === 'done' || j.state === 'error' || j.state === 'cancelled') && now - (ms(j.finished) || now) < LINGER_MS));
  // l'entraînement de LoRA, en tête (actif, ou qui vient de finir)
  const tr = currentTraining(now);
  const trOn = trainActive(tr);
  const trModel = tr ? QT.trainRow(L2(), tr, trainBases) : null;
  if (!visible.length && !tr) {
    if (!qRoot.hidden) { qRoot.hidden = true; qRoot.classList.remove('q-enter'); }
    expanded = false;
    if (Q) { Q.panel.hidden = true; Q.list.replaceChildren(); Q.rows.clear(); Q.train = null; }
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
  onlineOf.clear();
  for (const j of jobs) onlineOf.set(j.jobId, !!j.online);
  const waitingOrder = jobs.filter((j) => j.state === 'queued' || j.state === 'waiting-gpu').map((j) => j.jobId);

  // pastille : « 2 calculs · fin vers 20 h 45 » (en cours + en attente, l'entraînement compté)
  const n = active.length + (trOn ? 1 : 0);
  let sumName, sumState;
  if (tr && !active.length) {
    // l'entraînement seul (ou qui vient de finir) : « LoRA · Rosa · 49 % · fin vers 3 h 40 »
    const p = QT.trainPill(L2(), tr, trainBases);
    sumName = p.name;
    sumState = p.state;
  } else if (n) {
    const end = queueEnd(active, tr);
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
  Q.dot.classList.toggle('on', !!running || (trOn && trModel.bar != null));
  Q.pill.classList.toggle('open', expanded);
  Q.setTip(expanded ? t('queue.collapse') : t('queue.expand'));
  // la barre de la pastille : le calcul en cours, sinon l'entraînement
  if (running || !trOn) setBar(Q.bar, Q.fill, running);
  else setTrainBar(Q.bar, Q.fill, trModel);

  // liste détaillée
  if (!expanded) {
    if (!Q.panel.hidden) { ghostOut(Q.panel, { dur: 'exit', to: { translate: '0 6px' } }); Q.panel.hidden = true; }
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
  if (tr) {
    if (!Q.train) Q.train = trainRowEl();
    Q.train.update(tr, trModel);
    if (Q.list.firstChild !== Q.train.el) Q.list.insertBefore(Q.train.el, Q.list.firstChild);
    prev = Q.train;
  } else if (Q.train) { Q.train.el.remove(); Q.train = null; }
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
      const board = other ? t('queue.otherBoard', { name: runs.projectName(j.projectId) || j.projectName || '…' }) : runs.projectName(j.projectId);
      const s = [
        j.online || runs.isOnline?.(j.nodeId) ? t('queue.online') : '',
        j.mode === 'preview' ? t('queue.preview') : '',
        board,
      ].filter(Boolean).join(' · ');
      // entraînement de LoRA (SPEC §8.7) : « À côté de l’entraînement « Plumo » » pendant le calcul, ou ce qui le
      // retient (« Attend la fin de l’entraînement… : il faut ≈ 40 Go… ») à la place de la planche, entière au survol
      const st0 = { kind: j.state === 'running' ? 'running' : j.state, beside: j.beside, trainWait: j.trainWait, message: j.message };
      const why = runs.besideText(st0) || (j.state === 'queued' ? runs.trainWaitText(st0) : '');
      // derrière un entraînement, la raison d'abord, en court (« Une vidéo ne part pas à côté : après l’entraînement,
      // vers 15 h 10 ») et sur deux lignes au plus : la phrase entière reste au survol, sur le bloc et dans mia_jobs
      const short = j.state === 'queued' ? QT.waitLine(j, why) : '';
      const line2 = short || why || s;
      if (sub.textContent !== line2) sub.textContent = line2;
      // « À côté de l’entraînement « Plumo » » d'un calcul qui tourne : deux lignes aussi (l'état « 3 % · FIN VERS … » est large)
      sub.classList.toggle('is-why', !!short || (j.state === 'running' && !!why));
      if (stEl.textContent !== d.text) stEl.textContent = d.text;
      stEl.dataset.tone = d.tone;
      // le nom entier et « mode · planche » (la rangée peut les couper), puis l'état
      tipText = [lbl, s, why, why ? d.text : (d.tip || d.text)].filter(Boolean).join(' · ');
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
    // le total est celui de la machine (un seul partout, SPEC §7), 1 décimale au plus : « 109,7 », pas « 110 »
    label.textContent = total ? t('gpu.chip', { used: num(used ?? 0), total: num(total) }) : t('gpu.chipNoTotal');
    const frac = total ? Math.min(1, Math.max(0, (used || 0) / total)) : 0;
    fill.style.transform = `scaleX(${frac})`;
    const held = trainHolds(s);
    chip.classList.toggle('busy', !held && (!!(g.lock && !g.lock.mine) || !!g.busyOther));
    chip.classList.toggle('mine', held || !!g.lock?.mine);
    tipText = holderText(s);
  }
  onStatus(paint);
  paint(status);

  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popEl) { closePop(); return; }
    openPop(chip);
  });
}

/** The LoRA training of this Mia that has the GPU now (engine status, else the queue's row), or null. */
function trainHolding(s) {
  const tr = s?.training || QT.queueTraining(trainRows);
  return tr && QT.gpuHolder(L2(), tr) ? tr : null;
}
const trainHolds = (s) => !!trainHolding(s);

/**
 * Who holds the GPU: a LoRA training of this Mia first (« L’entraînement « Plumo » tient le GPU (fin vers 15 h 10) ·
 * à côté : « Portrait » »: its own words, even when no lock file says so), then the lock, another program, or free.
 */
function holderText(s) {
  const g = s?.gpu || {};
  const tr = trainHolding(s);
  if (tr) {
    const b = runs.jobList().find((j) => j.state === 'running' && j.beside);
    return QT.gpuHolder(L2(), tr, b ? (b.label || runs.nodeLabel(b.nodeId) || '') : '');
  }
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
  ghostOut(popEl);
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
    // l'entraînement de LoRA compte : en cours quand il calcule, en attente quand il attend le GPU ou laisse passer
    const trA = QT.queueTraining(trainRows);
    const trRun = !!trA && trA.state !== 'attente' && trA.state !== 'pause';
    const nRun = jobs.filter((j) => j.state === 'running').length + (trRun ? 1 : 0);
    const nWait = jobs.filter((j) => j.state === 'queued' || j.state === 'waiting-gpu').length + (trA && !trRun ? 1 : 0);
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
        total ? el('div', { class: 'gp-sub' }, t('gpu.vram', { used: num(used ?? 0), total: num(total) })) : null,
        // tant que ComfyUI n'a pas annoncé le sien, le total vient du pilote (il peut différer de quelques Go)
        total && g.totalSource === 'smi' ? el('div', { class: 'gp-hint' }, t('gpu.totalSmi')) : null,
        el('div', { class: `gp-holder${g.lock && !g.lock.mine && !trainHolds(s) ? ' busy' : ''}` }, holderText(s))),
      el('div', { class: 'gp-sec' },
        el('div', { class: 'gp-kicker' }, t('gpu.queue')),
        el('div', { class: 'gp-line' }, el('span', { class: 'gp-main' }, qText), showQ),
        // la voie en ligne, à part : elle n'attend jamais le GPU
        (s?.queue?.online && (s.queue.online.running || s.queue.online.waiting))
          ? el('div', { class: 'gp-sub' }, t('gpu.queueOnline', { run: s.queue.online.running, wait: s.queue.online.waiting, max: s.queue.online.max || 4 }))
          : null));
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

