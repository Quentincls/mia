// ── Versions et état de calcul des blocs (SPEC §6.5) ─────────────────
// SEULE source de vérité, côté interface, de « qu'est-ce que ce bloc a
// produit » et « où en est son calcul ». Tout le reste (corps des blocs,
// fils animés de l'éditeur, file d'attente, inspecteur) la lit ici.
//
// - les versions viennent de run.json (projects.open → project:opened, puis
//   les évènements « done » du moteur) ;
// - l'état vivant (en file, GPU occupé, en cours, erreur…) vient des
//   évènements engine:event relayés sur le bus ;
// - « périmé » se calcule ici : réglages ou amont changés depuis la version
//   affichée. C'est une estimation côté interface ; le moteur, lui, décide
//   avec ses empreintes au moment du lancement.
//
// Tout est rangé par PROJET + bloc : un projet dupliqué garde les mêmes
// identifiants de blocs que l'original, et un calcul de l'un ne doit jamais
// s'afficher ni s'écrire dans l'autre. L'API publique prend un nodeId : il
// s'agit toujours d'un bloc de la planche affichée (state.project).
//
// Ce module gère aussi `node:run` (le bouton Lancer) : appel à
// mia.engine.run et messages d'erreur en français.

import { on, emit } from '../bus.js';
import { state as appState } from '../state.js';
import { t, tl } from '../i18n.js';
import { toast } from '../ui/toasts.js';
import { fmtClock } from '../util.js';
import { strings, urlFor, fmtDur, fmtDurShort } from './media.js';

strings({
  'run.err.generic': 'Le calcul n’a pas pu démarrer.',
  'run.err.noProject': 'Ouvre une planche avant de lancer un calcul.',
  'run.err.engine': 'Le moteur ne répond pas. Réessaie dans un instant.',
  'run.err.cancel': 'Impossible d’annuler ce calcul.',
  'run.err.busy': 'Ce bloc calcule déjà : attends la fin ou annule.',
  'run.err.delete': 'Impossible de supprimer cette version.',
  'run.err.missing': 'Il manque : {list}',
  'run.failed': 'Le calcul a échoué.',
  'run.failedOn': '« {name} » a échoué.',
  'run.done': '« {name} » est prêt.',
}, {
  'run.err.generic': 'The job could not start.',
  'run.err.noProject': 'Open a board before running a job.',
  'run.err.engine': 'The engine is not responding. Try again in a moment.',
  'run.err.cancel': 'Could not cancel this job.',
  'run.err.busy': 'This block is already running: wait for the end or cancel.',
  'run.err.delete': 'Could not delete this version.',
  'run.err.missing': 'Missing: {list}',
  'run.failed': 'The job failed.',
  'run.failedOn': '“{name}” failed.',
  'run.done': '“{name}” is ready.',
});

// ── stockage ─────────────────────────────────────────────────────────

const byNode = new Map();       // « projet|bloc » → [run] (tous statuts, plus récent d'abord)
const live = new Map();         // « projet|bloc » → état vivant (voir state())
const jobs = new Map();         // jobId → job (SPEC §8.6), alimenté par jobs() + évènements
const types = new Map();        // typeId → entrée du catalogue (enregistrée par les corps)
const baselines = new Map();    // « projet|runId » → signature de l'amont au moment du calcul
const projectNames = new Map(); // projectId → nom (pour la file d'attente)
const missingSrc = new Set();   // « projet|media/x.mp4 » : fichier source introuvable
const jobListeners = new Set();

const ACTIVE = new Set(['queued', 'waiting-gpu', 'running']);

const editor = () => window.__mia?.editor || null;
const curPid = () => appState.project?.id || '';
/** Clé d'un bloc : projet + bloc (un projet dupliqué partage les identifiants). */
const K = (nodeId, pid = curPid()) => `${pid || ''}|${nodeId}`;

// ── types ────────────────────────────────────────────────────────────

/** Les corps de blocs enregistrent leur type : runs.js n'a pas besoin du catalogue. */
export function registerType(type) {
  if (type && type.id) types.set(type.id, type);
}

/** Entrée du catalogue d'un bloc (ou null). */
export function typeOf(nodeId) {
  const ed = editor();
  let ty = null;
  try { ty = ed?.nodeType?.(nodeId); } catch { ty = null; }
  if (ty && typeof ty === 'object') { registerType(ty); return ty; }
  const node = ed?.getNode?.(nodeId);
  const id = typeof ty === 'string' ? ty : node?.type;
  return (id && types.get(id)) || null;
}

/** Entrée du catalogue d'un type par son id (si un corps l'a déjà enregistrée). */
export const typeById = (id) => types.get(id) || null;

/**
 * Libellé lisible d'un bloc : son titre, sinon (bloc Modèle) le nom de sa famille (« Kling 4.0 », rapport DA P1-5 : la
 * file montrait trois « Modèle » indiscernables), sinon le nom de son type.
 */
export function nodeLabel(nodeId) {
  const node = editor()?.getNode?.(nodeId);
  if (node?.title) return node.title;
  const fam = node ? familyNameOf(node) : '';
  if (fam) return fam;
  const ty = typeOf(nodeId);
  return ty ? tl(ty.label) : '';
}

/** Nom de la famille d'un bloc Modèle (son réglage « model »), lu dans les catalogues ; '' sinon. */
let famNamer = null;
export function setFamilyNamer(fn) { famNamer = typeof fn === 'function' ? fn : null; }
function familyNameOf(node) {
  if (!famNamer) return '';
  try { return famNamer(node) || ''; } catch { return ''; }
}

/** Le bloc calcule-t-il chez Higgsfield (modèle en ligne) ? Pour la méta « EN LIGNE » de la file. */
export function isOnline(nodeId) {
  const node = editor()?.getNode?.(nodeId);
  return !!node && node.type === 'gen' && String(node.params?.model || '').startsWith('hf:');
}

// ── chargement ───────────────────────────────────────────────────────

function sortRuns(list) {
  return list.sort((a, b) => (b.finished || b.started || 0) - (a.finished || a.started || 0));
}

/** Remplace les versions connues par celles d'un projet ouvert. */
export function load(runsMap, projectId = curPid()) {
  const pid = projectId || curPid();
  for (const [nodeId, list] of Object.entries(runsMap || {})) {
    if (!Array.isArray(list)) continue;
    const k = K(nodeId, pid);
    byNode.set(k, sortRuns(list.filter(Boolean).map((r) => ({ ...r }))));
    // une erreur plus récente que la dernière version réussie reste visible
    const last = byNode.get(k)[0];
    if (last && last.status === 'error' && !ACTIVE.has(live.get(k)?.kind)) {
      live.set(k, { kind: 'error', message: last.error || t('run.failed'), run: last });
    }
  }
  invalidate();
  if (pid === curPid()) for (const nodeId of Object.keys(runsMap || {})) emit('runs:changed', { nodeId });
}

function forgetProject(projectId) {
  const prefix = `${projectId}|`;
  for (const k of [...byNode.keys()]) if (k.startsWith(prefix)) byNode.delete(k);
  for (const [k, L] of [...live]) if (k.startsWith(prefix) && !ACTIVE.has(L?.kind)) live.delete(k);
  for (const k of [...baselines.keys()]) if (k.startsWith(prefix)) baselines.delete(k);
  invalidate();
}

// ── lecture ──────────────────────────────────────────────────────────

/** Toutes les tentatives (réussies, en erreur, annulées), plus récentes d'abord. */
export function all(nodeId) {
  return byNode.get(K(nodeId)) || [];
}

/** Versions = run.json « done », plus récentes d'abord. */
export function list(nodeId) {
  return all(nodeId).filter((r) => r.status === 'done' || !r.status);
}

/**
 * Version courante (SPEC §16, même règle que le moteur) : l'épinglée si elle
 * existe ; sinon la plus récente en rendu final (ou sans mode) ; sinon le
 * plus récent aperçu. Un aval ne prend jamais un aperçu quand un final existe.
 */
export function current(nodeId) {
  const versions = list(nodeId);
  if (!versions.length) return null;
  // Consigne : la réécriture de SON texte, case cochée (comme le moteur, qui ne reprend que celle-là), sinon aucune
  const typed = typedText(nodeId);
  if (typed !== null) return typed === false ? null : versions.find((r) => r.params?.text === typed) || null;
  const pinned = editor()?.getNode?.(nodeId)?.pinnedRun;
  if (pinned) {
    const p = versions.find((r) => r.runId === pinned);
    if (p) return p;
  }
  return versions.find((r) => r.mode !== 'preview') || versions[0];
}

/** Numéro de version (v1 = la plus ancienne). */
export function versionNumber(nodeId, runId) {
  const v = list(nodeId);
  const i = v.findIndex((r) => r.runId === runId);
  return i < 0 ? 0 : v.length - i;
}

export function findRun(nodeId, runId) {
  return all(nodeId).find((r) => r.runId === runId) || null;
}

// ── fichiers sources introuvables ────────────────────────────────────

/** Note qu'un fichier importé a disparu (ou est revenu). Retourne true si ça change. */
export function setMissing(nodeId, src, missing) {
  if (!src) return false;
  const k = `${curPid()}|${src}`;
  if (missing === missingSrc.has(k)) return false;
  if (missing) missingSrc.add(k); else missingSrc.delete(k);
  invalidate();
  emit('runs:changed', { nodeId });
  return true;
}

/** Le fichier d'un bloc Média est-il introuvable ? */
export function isMissing(nodeId) {
  const node = editor()?.getNode?.(nodeId);
  const d = node?.type === 'import' ? node.data || {} : null;
  if (!d?.src) return false;
  return !!d._missing || missingSrc.has(`${curPid()}|${d.src}`);
}

/**
 * Sortie d'un bloc : { path, kind, meta, poster, proxy? } ou null.
 * Un bloc « import » sert son fichier (SPEC §8.2.7) ; le port par défaut est
 * la première sortie de la version courante.
 */
export function output(nodeId, portId, run) {
  const node = editor()?.getNode?.(nodeId);
  if (node?.type === 'import') {
    const d = node.data || {};
    if (!d.src || isMissing(nodeId)) return null;
    return { path: d.src, kind: d.kind, meta: d.meta || null, poster: d.poster || null, proxy: d.proxy || null, name: d.name, port: 'out' };
  }
  const r = run || current(nodeId);
  const outs = r?.outputs;
  if (!outs) return null;
  const key = portId && outs[portId] ? portId : Object.keys(outs)[0];
  return key ? { ...outs[key], port: key } : null;
}

/** Ordre d'une entrée multiple : position verticale, puis horizontale (comme le moteur). */
function byPosition(ed) {
  return (a, b) => {
    const na = ed.getNode?.(a.node) || {};
    const nb = ed.getNode?.(b.node) || {};
    return (na.y || 0) - (nb.y || 0) || (na.x || 0) - (nb.x || 0);
  };
}

/** Liens d'une entrée, dans l'ordre du moteur. */
function linksOf(nodeId, portId) {
  const ed = editor();
  if (!ed?.inputsOf) return [];
  let ins = {};
  try { ins = ed.inputsOf(nodeId) || {}; } catch { ins = {}; }
  return (ins[portId] || []).slice().sort(byPosition(ed));
}

/**
 * Sources branchées sur une entrée : [{ node, port, kind, path, poster, meta, proxy, text, negative, run, missing }].
 * Ordre = celui du moteur (SPEC §3.2 : ordre vertical des blocs sources, puis horizontal).
 */
export function upstream(nodeId, portId) {
  const ed = editor();
  const out = [];
  for (const link of linksOf(nodeId, portId)) {
    const up = ed.getNode?.(link.node);
    if (!up) continue;
    if (up.type === 'text') {
      // « Réécrire en anglais » : l'aval reçoit la réécriture de CE texte (sa version), dès qu'elle est faite
      const typed = up.params?.text || '';
      const rewrite = up.params?.rewrite === true && !!typed.trim();
      const done = rewrite ? list(up.id).find((r) => r.params?.text === typed && r.outputs?.text) : null;
      const rewritten = done?.outputs?.text?.meta?.text || null;
      out.push({ node: up, port: link.port, kind: 'text', text: rewritten || typed, negative: up.params?.negative || '',
        typed, rewrite, rewritten: !!rewritten });
      continue;
    }
    const run = up.type === 'import' ? null : current(up.id);
    const o = output(up.id, link.port, run);
    out.push({ node: up, port: link.port, run, ...(o || {}), kind: o?.kind || null, missing: up.type === 'import' && isMissing(up.id) });
  }
  return out;
}

/** Première source d'une entrée (ou null). */
export function source(nodeId, portId) {
  return upstream(nodeId, portId)[0] || null;
}

// ── état vivant ──────────────────────────────────────────────────────

const bust = (url, v) => (/^(data|blob):/.test(url) ? url : `${url}${url.includes('?') ? '&' : '?'}v=${v}`);

/** Heure de fin estimée (ms) à partir d'un `eta` (secondes restantes, ou horodatage). */
function endAtFrom(eta, now = Date.now()) {
  if (eta == null || !isFinite(eta) || eta < 0) return null;
  if (eta > 1e11) return eta;            // horodatage en ms
  if (eta > 1e9) return eta * 1000;      // horodatage en s
  return now + eta * 1000;               // secondes restantes
}

/**
 * État de calcul d'un bloc :
 * { kind:'idle'|'queued'|'waiting-gpu'|'running'|'error'|'cancelled'|'done',
 *   progress, eta, endAt, message, jobId, who, since, position, preview, mode, startedAt, run,
 *   justDone (runId de la version qui vient de finir, même si ce n'est pas la courante) }
 */
export function state(nodeId) {
  const L = live.get(K(nodeId));
  if (L && ACTIVE.has(L.kind)) {
    const st = { ...L };
    if (L.kind === 'queued') st.position = queuePosition(L.jobId);
    // calcul en ligne : en file chez Higgsfield, ou sa file pleine (le bloc le dit comme la file, pas « En cours »)
    const j = L.jobId ? jobs.get(L.jobId) : null;
    if (j?.online) { st.online = true; st.remote = j.remote || null; }
    return st;
  }
  // Consigne : un état seulement pour la réécriture de SON texte, case cochée (ni « fait » ni erreur d'un autre texte)
  const typed = typedText(nodeId);
  if (typed === false) return { kind: 'idle', progress: null, message: null, jobId: null };
  if (L && (L.kind === 'error' || L.kind === 'cancelled')
    && (typed === null || !L.run?.params || L.run.params.text === typed)) {
    return { ...L, run: L.run || null, last: current(nodeId) };
  }
  const run = current(nodeId);
  if (run && (typed === null || run.params?.text === typed)) {
    const justDone = L?.kind === 'done' ? L.run?.runId || null : null;
    return { kind: 'done', run, progress: 1, message: null, jobId: null, fresh: justDone === run.runId, justDone };
  }
  return { kind: 'idle', progress: null, message: null, jobId: null };
}

/**
 * Consigne : son texte quand « Réécrire en anglais » est cochée, false quand elle ne l'est pas (rien ne se calcule) ;
 * null pour tout autre bloc.
 */
function typedText(nodeId) {
  const n = editor()?.getNode?.(nodeId);
  if (n?.type !== 'text') return null;
  return n.params?.rewrite === true ? (n.params?.text ?? '') : false;
}

/** Rang (1 = prochain) d'un job dans SA voie de la file de Mia (en ligne et local n'attendent pas l'un derrière l'autre). */
function queuePosition(jobId) {
  const me = jobs.get(jobId);
  const waiting = [...jobs.values()]
    .filter((j) => (j.state === 'queued' || j.state === 'waiting-gpu') && !!j.online === !!me?.online)
    .sort((a, b) => (a.created || 0) - (b.created || 0));
  const i = waiting.findIndex((j) => j.jobId === jobId);
  return i < 0 ? null : i + 1;
}

export function isActive(nodeId) {
  return ACTIVE.has(live.get(K(nodeId))?.kind);
}

// ── évènements du moteur ─────────────────────────────────────────────

function upsertJob(evt, patch) {
  if (!evt.jobId) return null;
  const mine = (evt.projectId || curPid()) === curPid();
  const prev = jobs.get(evt.jobId) || {
    jobId: evt.jobId, projectId: evt.projectId, nodeId: evt.nodeId,
    label: evt.label || null, type: evt.type || (mine ? typeOf(evt.nodeId)?.id : null) || null,
    mode: evt.mode ?? null, created: Date.now(),
  };
  const job = { ...prev, ...patch, touched: Date.now() };
  if (!job.label && mine) job.label = nodeLabel(evt.nodeId);
  if (evt.mode !== undefined && job.mode == null) job.mode = evt.mode;
  // calcul en ligne : sa propre voie dans la file ; remote = queued | running | full chez Higgsfield
  if (evt.online) { job.online = true; job.remote = evt.remote || null; }
  jobs.set(evt.jobId, job);
  return job;
}

function onEngineEvent(evt) {
  if (!evt || !evt.nodeId) return;
  const now = Date.now();
  const pid = evt.projectId || curPid();
  const mine = pid === curPid();
  const id = evt.nodeId;
  const key = K(id, pid);
  const prev = live.get(key) || {};
  const base = { jobId: evt.jobId ?? prev.jobId ?? null, mode: evt.mode ?? prev.mode ?? null };
  // « 4 variantes » : plusieurs calculs du même bloc. Un calcul qui entre en file ne remplace pas celui qui est
  // affiché ; à la fin de l'un, le bloc passe au suivant au lieu de se dire fini (followNext).
  const otherShown = ACTIVE.has(prev.kind) && !!prev.jobId && !!evt.jobId && prev.jobId !== evt.jobId;

  switch (evt.kind) {
    case 'queued':
      if (otherShown) { upsertJob(evt, { state: 'queued', progress: null, message: evt.message || null }); break; }
      live.set(key, { ...base, kind: 'queued', progress: null, message: evt.message || null });
      upsertJob(evt, { state: 'queued', progress: null, message: evt.message || null, ...(evt.estSec > 0 ? { estSec: evt.estSec } : {}) });
      break;
    case 'waiting-gpu':
      if (!otherShown) live.set(key, { ...base, kind: 'waiting-gpu', progress: null, who: evt.who || null, since: evt.since || null, message: evt.message || null });
      upsertJob(evt, { state: 'waiting-gpu', who: evt.who || null, since: evt.since || null });
      break;
    case 'start':
    case 'progress':
    case 'preview': {
      const startedAt = prev.kind === 'running' ? prev.startedAt : now;
      const progress = evt.progress != null ? evt.progress : (evt.kind === 'start' ? null : prev.progress ?? null);
      const etaAt = evt.etaAt && evt.etaAt > 1e11 ? evt.etaAt : null;
      const endAt = etaAt || (evt.eta != null ? endAtFrom(evt.eta, now) : (prev.kind === 'running' ? prev.endAt : null));
      // l'aperçu est souvent réécrit au même chemin : ?v= force le rechargement
      const preview = evt.preview ? bust(urlFor(evt.preview, pid), now) : prev.preview || null;
      live.set(key, {
        ...base, kind: 'running', progress, eta: evt.eta ?? prev.eta ?? null, endAt,
        message: evt.message || prev.message || null, startedAt, preview,
      });
      upsertJob(evt, { state: 'running', progress, eta: evt.eta ?? null, endAt, started: startedAt, message: evt.message || null });
      break;
    }
    case 'done': {
      if (evt.run) addRun(key, evt.run, pid);
      upsertJob(evt, { state: 'done', progress: 1, finished: now, run: evt.run || null });
      if (!otherShown && !followNext(key, id, pid, evt.jobId)) live.set(key, { kind: 'done', jobId: evt.jobId, run: evt.run || null, finishedAt: now });
      scheduleJobCleanup(evt.jobId);
      break;
    }
    case 'error': {
      if (evt.run) addRun(key, { ...evt.run, status: 'error' }, pid);
      const message = evt.message || evt.run?.error || t('run.failed');
      upsertJob(evt, { state: 'error', message, finished: now, run: evt.run || null });
      if (!otherShown && !followNext(key, id, pid, evt.jobId)) live.set(key, { kind: 'error', jobId: evt.jobId, message, run: evt.run || null });
      scheduleJobCleanup(evt.jobId, 9000);
      break;
    }
    case 'cancelled': {
      const mark = { kind: 'cancelled', jobId: evt.jobId, message: evt.message || null };
      upsertJob(evt, { state: 'cancelled', finished: now });
      scheduleJobCleanup(evt.jobId, 2500);
      if (otherShown || followNext(key, id, pid, evt.jobId)) break;
      live.set(key, mark);
      // « ANNULÉ » s'efface au bout de quelques secondes : la version d'avant reprend sa place
      setTimeout(() => {
        if (live.get(key) !== mark) return;
        live.delete(key);
        invalidate();
        if (pid === curPid()) emit('runs:changed', { nodeId: id });
      }, 6000);
      break;
    }
    default:
      return;
  }
  invalidate();
  if (mine) emit('runs:changed', { nodeId: id });
  notifyJobs();
}

/** « 4 variantes » : un autre calcul du même bloc reste en file → le bloc l'affiche (true) ; sinon false. */
function followNext(key, nodeId, pid, jobId) {
  const next = [...jobs.values()].find((j) => j.jobId !== jobId && j.nodeId === nodeId
    && (j.projectId || curPid()) === pid && ACTIVE.has(j.state));
  if (!next) return false;
  // « en cours » attend son prochain évènement de progression (début, fin prévue) : en file jusque-là
  live.set(key, { jobId: next.jobId, mode: next.mode ?? null, kind: next.state === 'running' ? 'queued' : next.state,
    progress: null, message: next.message || null });
  return true;
}

function addRun(key, run, pid) {
  const list = byNode.get(key) || [];
  const i = list.findIndex((r) => r.runId === run.runId);
  if (i >= 0) list[i] = { ...list[i], ...run };
  else list.unshift({ ...run });
  byNode.set(key, sortRuns(list));
  // l'amont qui vient de servir au calcul devient la référence « à jour »
  if (run.status !== 'error' && run.runId && pid === curPid()) {
    baselines.set(`${pid}|${run.runId}`, upstreamSig(key.slice(key.indexOf('|') + 1)));
  }
}

// Un job terminé reste quelques secondes dans la file (« FAIT · 38 S »), puis part.
function scheduleJobCleanup(jobId, ms = 6000) {
  setTimeout(() => {
    const j = jobs.get(jobId);
    if (j && !ACTIVE.has(j.state)) { jobs.delete(jobId); notifyJobs(); }
  }, ms);
}

// ── file d'attente (pour ui/queue.js) ────────────────────────────────

/** Jobs connus (actifs et récemment terminés), dans l'ordre de création. */
export function jobList() {
  return [...jobs.values()].sort((a, b) => (a.created || 0) - (b.created || 0));
}

/** S'abonner aux changements de la file. Retourne la fonction de désabonnement. */
export function onJobs(fn) {
  jobListeners.add(fn);
  return () => jobListeners.delete(fn);
}

let jobsQueued = false;
function notifyJobs() {
  if (jobsQueued) return;
  jobsQueued = true;
  queueMicrotask(() => {
    jobsQueued = false;
    for (const fn of jobListeners) { try { fn(jobList()); } catch (e) { console.error(e); } }
  });
}

/** Nom lisible d'un projet (onglet courant ou projets ouverts dans la session). */
export function projectName(projectId) {
  if (appState.project?.id === projectId) return appState.project.name;
  return projectNames.get(projectId) || '';
}

/**
 * Durée typique (secondes) d'un calcul de ce type et de ce mode, apprise des
 * versions du projet ouvert (moyenne des 5 dernières), ou null.
 */
export function typicalSec(typeId, mode = null) {
  const prefix = `${curPid()}|`;
  const durs = [];
  for (const [k, list] of byNode) {
    if (!k.startsWith(prefix)) continue;
    for (const r of list) {
      if (r.type !== typeId || (r.mode || null) !== (mode || null) || (r.status && r.status !== 'done')) continue;
      const d = runDuration(r);
      if (d != null) durs.push({ at: r.finished || 0, d });
    }
  }
  if (!durs.length) return null;
  durs.sort((a, b) => b.at - a.at);
  const last = durs.slice(0, 5);
  return last.reduce((s, x) => s + x.d, 0) / last.length / 1000;
}

/** Recharge la file depuis le moteur (démarrage, rechargement de la fenêtre, filet de sécurité). */
let syncing = null;
export function syncJobs() {
  if (syncing) return syncing;
  syncing = doSyncJobs().finally(() => { syncing = null; });
  return syncing;
}

async function doSyncJobs() {
  const asked = Date.now();
  let list = [];
  try { list = (await window.mia?.engine?.jobs?.()) || []; } catch { return; }
  if (!Array.isArray(list)) return;
  const seen = new Set();
  const changed = new Set();
  for (const j of list) {
    if (!j?.jobId) continue;
    seen.add(j.jobId);
    const kind = j.state === 'running' || j.state === 'start' || j.state === 'progress' ? 'running' : j.state;
    const known = jobs.get(j.jobId);
    // un évènement arrivé pendant la question est plus frais que la réponse
    if (known && (known.touched || 0) >= asked) continue;
    if (!ACTIVE.has(kind)) {
      // les jobs terminés que le moteur garde 30 min ne reviennent jamais dans la file ;
      // un job connu qui vient de finir part après le délai habituel
      if (known && ACTIVE.has(known.state)) {
        jobs.set(j.jobId, { ...known, ...j, state: kind, finished: j.finished || Date.now() });
        scheduleJobCleanup(j.jobId, kind === 'error' ? 9000 : kind === 'cancelled' ? 2500 : 6000);
        const k = K(j.nodeId, j.projectId || curPid());
        if (live.get(k)?.jobId === j.jobId && ACTIVE.has(live.get(k)?.kind)) {
          live.delete(k);
          if ((j.projectId || curPid()) === curPid()) changed.add(j.nodeId);
        }
      }
      continue;
    }
    const endAt = j.etaAt && j.etaAt > 1e11 ? j.etaAt : (j.endAt ?? endAtFrom(j.eta));
    jobs.set(j.jobId, { ...(known || {}), ...j, state: kind, endAt, label: j.label || known?.label || null });
    if (j.projectName) projectNames.set(j.projectId, j.projectName);
    if (j.nodeId) {
      const pid = j.projectId || curPid();
      const k = K(j.nodeId, pid);
      const prev = live.get(k);
      const same = prev?.jobId === j.jobId;
      live.set(k, {
        ...(same ? prev : {}),                 // garde l'aperçu en direct et l'heure de départ
        kind, jobId: j.jobId, progress: j.progress ?? (same ? prev.progress : null) ?? null,
        eta: j.eta ?? null, endAt: endAt ?? (same ? prev.endAt : null),
        message: j.message || null, who: j.who || null, since: j.since || null,
        startedAt: j.started || (same ? prev.startedAt : null) || null,
        mode: j.mode || null,
      });
      if (pid === curPid()) changed.add(j.nodeId);
    }
  }
  // un job « actif » que le moteur ne connaît plus est terminé (fenêtre rechargée, évènement perdu)
  for (const [jobId, j] of jobs) {
    if (!ACTIVE.has(j.state) || seen.has(jobId) || (j.touched || 0) >= asked - 3000) continue;
    jobs.delete(jobId);
    const k = K(j.nodeId, j.projectId || curPid());
    if (live.get(k)?.jobId === jobId) {
      live.delete(k);
      if ((j.projectId || curPid()) === curPid()) changed.add(j.nodeId);
    }
  }
  invalidate();
  for (const nodeId of changed) emit('runs:changed', { nodeId });
  notifyJobs();
}

// ── périmé ───────────────────────────────────────────────────────────
// Signature de l'amont = ce que le bloc recevrait s'il était lancé
// maintenant : fichiers importés, textes, et version courante de chaque bloc
// calculé en amont (dans l'ordre du moteur). On la compare à celle notée
// quand la version est sortie.

function upstreamSig(nodeId) {
  const ed = editor();
  if (!ed?.inputsOf) return '';
  let ins = {};
  try { ins = ed.inputsOf(nodeId) || {}; } catch { return ''; }
  const parts = [];
  for (const port of Object.keys(ins).sort()) {
    for (const link of (ins[port] || []).slice().sort(byPosition(ed))) {
      const up = ed.getNode?.(link.node);
      if (!up) continue;
      if (up.type === 'import') parts.push(`${port}=f:${up.data?.src || ''}|${up.params?.skipFirst ? 1 : 0}`);
      // « Réécrire en anglais » cochée : le texte réécrit change ce que reçoit l'aval (marque ajoutée seulement alors :
      // les versions d'avant gardent leur signature)
      else if (up.type === 'text') parts.push(`${port}=t:${up.params?.text || ''}|${up.params?.negative || ''}${up.params?.rewrite === true ? '|rw' : ''}`);
      else parts.push(`${port}=r:${current(up.id)?.runId || '-'}:${link.port}`);
    }
  }
  return parts.join('\n');
}

const norm = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Valeur d'un réglage de modèle comparable (« auto » = le défaut de la capacité). */
function modelKey(param, v) {
  if (v == null || v === '' || v === 'auto') {
    const caps = param.caps || [];
    const capInfo = appState.inventory?.capabilities?.[caps[0]];
    return capInfo?.default ? `id:${capInfo.default}` : 'auto';
  }
  return v === 'none' ? 'none' : `id:${v}`;
}

function paramsChanged(nodeId, run) {
  const ty = typeOf(nodeId);
  const node = editor()?.getNode?.(nodeId);
  if (!ty || !node || !run?.params) return false;
  let connected = {};
  try { connected = editor()?.inputsOf?.(nodeId) || {}; } catch { connected = {}; }
  for (const p of ty.params || []) {
    if (p.port && connected[p.port]?.length) continue;   // écrasé par un fil
    const now = node.params?.[p.id] ?? p.default;
    const then = run.params[p.id] ?? p.default;
    if (p.kind === 'model') {
      if (modelKey(p, now) !== modelKey(p, then)) return true;
    } else if (norm(now) !== norm(then)) {
      return true;
    }
  }
  return false;
}

let memo = new Map();
function invalidate() { memo = new Map(); }
// Déplacer, redimensionner ou cadrer ne change ni réglage ni fil…
export const LAYOUT_ONLY = new Set(['move', 'resize', 'camera', 'group-move', 'group-resize', 'select']);

// … sauf l'ordre d'une entrée multiple (Assembler, références) : il suit la position des sources.
let multiOrder = '';
function multiOrderSig() {
  const ed = editor();
  const g = ed?.getGraph?.();
  if (!g) return '';
  const parts = [];
  for (const n of g.nodes || []) {
    const ty = types.get(n.type) || typeOf(n.id);
    for (const inp of ty?.inputs || []) {
      if (!inp.multi) continue;
      parts.push(`${n.id}.${inp.id}=${linksOf(n.id, inp.id).map((l) => l.node).join(',')}`);
    }
  }
  return parts.join(';');
}
on('graph:changed', (p) => {
  const reason = p?.reason;
  if (reason === 'move' || reason === 'group-move' || reason === 'nudge') {
    const sig = multiOrderSig();
    if (sig !== multiOrder) { multiOrder = sig; invalidate(); }
    return;
  }
  if (!LAYOUT_ONLY.has(reason)) { invalidate(); multiOrder = ''; }
});

/** Réglages ou amont changés depuis la version affichée → « à relancer ». */
export function isStale(nodeId, _seen) {
  if (memo.has(nodeId)) return memo.get(nodeId);
  const run = current(nodeId);
  // une Consigne n'est jamais « à relancer » : sa réécriture se refait toute seule quand le texte change
  if (!run || typedText(nodeId) !== null) { memo.set(nodeId, false); return false; }
  const seen = _seen || new Set();
  if (seen.has(nodeId)) return false;          // garde-fou contre un cycle
  seen.add(nodeId);

  let stale = paramsChanged(nodeId, run);
  if (!stale) {
    const sig = upstreamSig(nodeId);
    const bk = `${curPid()}|${run.runId}`;
    if (!baselines.has(bk)) baselines.set(bk, sig);  // version chargée du disque
    stale = baselines.get(bk) !== sig;
  }
  if (!stale) {
    // amont recalculé après cette version (session précédente) ou lui-même périmé ;
    // un amont épinglé (étoile) est figé : le moteur le réutilise tel quel
    const ed = editor();
    let ins = {};
    try { ins = ed?.inputsOf?.(nodeId) || {}; } catch { ins = {}; }
    outer: for (const links of Object.values(ins)) {
      for (const link of links || []) {
        const up = ed.getNode?.(link.node);
        if (!up || up.type === 'import' || up.type === 'text' || up.pinnedRun) continue;
        const ur = current(up.id);
        if (ur && run.started && (ur.finished || 0) > run.started) { stale = true; break outer; }
        if (isStale(up.id, seen)) { stale = true; break outer; }
      }
    }
  }
  memo.set(nodeId, stale);
  return stale;
}

// ── textes d'état (en-tête des blocs, file d'attente) ────────────────
// Écrits en casse normale : le CSS les passe en mono MAJUSCULES (da.md §4.1).

/** Durée d'une version, en ms (ou null). */
export function runDuration(run) {
  if (!run?.started || !run?.finished) return null;
  return Math.max(0, run.finished - run.started);
}

/** « fin vers 20 h 45 » (ou '' si l'heure n'est pas connue). */
export function endText(endAt) {
  if (!endAt) return '';
  return t('run.st.endAt', { time: fmtClock(endAt) });
}

/**
 * { text, short, tone:'muted'|'live'|'err', ring?, tip } pour un état de runs.state().
 * `short` : la forme d'un en-tête de carte étroite, qui ne doit pas manger le titre (le texte entier
 * passe alors dans l'info-bulle) — « 47 % », « #15 », « 1 h 12 » ; vide = l'anneau seul.
 */
/**
 * Un calcul en ligne déjà parti, mais qui attend chez Higgsfield (limite du compte : « En file chez Higgsfield ») ou
 * dont la file est pleine (rien de créé ni de facturé, Mia réessaie) → { text, tip, sub } ; null sinon. Partagé par
 * l'en-tête et le puits du bloc et par la file.
 */
export function remoteText(st) {
  if (!st || !st.online || st.kind !== 'running') return null;
  if (st.remote === 'queued') return { text: t('run.st.atHf'), tip: t('run.st.atHfTip'), sub: '' };
  if (st.remote === 'full') return { text: t('run.st.hfFull'), tip: [st.message, t('run.st.hfFullTip')].filter(Boolean).join(' — '), sub: st.message || '' };
  return null;
}

export function describe(st) {
  if (!st) return { text: '', tone: 'muted' };
  switch (st.kind) {
    case 'queued':
      return {
        text: st.position ? t('run.st.queuedN', { n: st.position }) : t('run.st.queued'),
        short: st.position ? t('run.st.queuedN', { n: st.position }) : t('run.st.queued'), tone: 'muted', ring: true,
      };
    case 'waiting-gpu':
      return {
        text: t('run.st.gpuBusy'), short: '', tone: 'muted', ring: true,
        tip: st.who ? t('run.st.gpuBusyWho', { who: st.who, since: st.since ? fmtClock(typeof st.since === 'number' ? st.since : Date.parse(st.since)) : '?' }) : t('run.st.gpuBusyTip'),
      };
    case 'running': {
      const far = remoteText(st);
      if (far) return { text: far.text, short: far.text, tone: 'muted', tip: far.tip };
      const p = st.progress != null ? `${Math.round(st.progress * 100)} %` : t('run.st.running');
      const full = [p, endText(st.endAt)].filter(Boolean).join(' · ');
      // l'heure de fin reste dans le pied du bloc
      return { text: full, short: p, tone: 'live', tip: [full, st.message].filter(Boolean).join(' — ') };
    }
    case 'done': {
      const d = runDuration(st.run);
      // « FAIT · 10 MIN » (da.md §4.5) : seule, la durée se lisait comme l'estimation du pied
      if (st.stale) return { text: t('run.st.stale'), short: t('run.st.stale'), tone: 'muted', tip: t('run.st.staleTip') };
      return { text: d != null ? t('run.st.doneIn', { dur: fmtDur(d) }) : t('run.st.done'), short: d != null ? t('run.st.doneIn', { dur: fmtDurShort(d) }) : t('run.st.done'), tone: 'muted' };
    }
    case 'error':
      return { text: t('run.st.error'), tone: 'err', tip: st.message || '' };
    case 'cancelled':
      return { text: t('run.st.cancelled'), tone: 'muted' };
    default:
      return { text: '', tone: 'muted' };
  }
}

strings({
  'run.st.queued': 'En file',
  'run.st.queuedN': 'En file · {n}',
  'run.st.queuedShort': '#{n}',
  'run.st.gpuBusy': 'GPU occupé',
  'run.st.gpuBusyWho': 'Le GPU est pris par « {who} » depuis {since}. Mia attend son tour.',
  'run.st.gpuBusyTip': 'Un autre calcul utilise le GPU. Mia attend son tour.',
  'run.st.running': 'En cours',
  'run.st.endAt': 'fin vers {time}',
  'run.st.atHf': 'En file chez Higgsfield',
  'run.st.atHfTip': 'Higgsfield l’a reçu et le lancera dès qu’un de tes calculs en ligne finit (limite de ton compte).',
  'run.st.hfFull': 'File Higgsfield pleine',
  'run.st.hfFullTip': 'La file de ton compte Higgsfield est pleine : rien n’a été créé ni facturé, Mia réessaie toute seule.',
  'run.st.done': 'Fait',
  'run.st.doneIn': 'Fait · {dur}',
  'run.st.error': 'Erreur',
  'run.st.cancelled': 'Annulé',
  'run.st.stale': 'À relancer',
  'run.st.staleTip': 'Réglages ou amont changés depuis cette version : relance pour la mettre à jour.',
}, {
  'run.st.queued': 'Queued',
  'run.st.queuedN': 'Queued · {n}',
  'run.st.queuedShort': '#{n}',
  'run.st.gpuBusy': 'GPU busy',
  'run.st.gpuBusyWho': 'The GPU is held by “{who}” since {since}. Mia waits its turn.',
  'run.st.gpuBusyTip': 'Another job is using the GPU. Mia waits its turn.',
  'run.st.running': 'Running',
  'run.st.endAt': 'ends ~{time}',
  'run.st.atHf': 'Queued at Higgsfield',
  'run.st.atHfTip': 'Higgsfield received it and will start it as soon as one of your online jobs ends (your account’s limit).',
  'run.st.hfFull': 'Higgsfield queue full',
  'run.st.hfFullTip': 'Your Higgsfield account’s queue is full: nothing was created or charged, Mia tries again by itself.',
  'run.st.done': 'Done',
  'run.st.doneIn': 'Done · {dur}',
  'run.st.error': 'Error',
  'run.st.cancelled': 'Cancelled',
  'run.st.stale': 'Run again',
  'run.st.staleTip': 'Settings or inputs changed since this version: run again to update it.',
});

// ── actions ──────────────────────────────────────────────────────────

/** Épingle (étoile) une version : elle s'affiche et part en aval. null = désépingler. */
export function pin(nodeId, runId) {
  const ed = editor();
  if (!ed) return;
  const node = ed.getNode?.(nodeId);
  const next = runId && node?.pinnedRun !== runId ? runId : null;
  ed.updateNode?.(nodeId, { pinnedRun: next }, { history: true });   // annonce graph:changed
  invalidate();
  emit('runs:changed', { nodeId });
}

export function unpin(nodeId) { pin(nodeId, null); }

/** Supprime une version (corbeille du dossier du run). La confirmation est à l'appelant. */
export async function removeRun(nodeId, runId) {
  // la planche ne montre qu'un projet : c'est toujours le sien (jamais celui d'un original dupliqué)
  const pid = curPid();
  if (!pid) return false;
  let res;
  try { res = await window.mia.engine.deleteRun(pid, nodeId, runId); } catch { res = { ok: false }; }
  if (res && res.ok === false) {
    toast(res.error || t('run.err.delete'), { kind: 'error' });
    return false;
  }
  const k = K(nodeId, pid);
  const list = (byNode.get(k) || []).filter((r) => r.runId !== runId);
  byNode.set(k, list);
  baselines.delete(`${pid}|${runId}`);
  if (curPid() === pid && editor()?.getNode?.(nodeId)?.pinnedRun === runId) {
    editor().updateNode?.(nodeId, { pinnedRun: null }, { history: false });
  }
  const L = live.get(k);
  if (L && L.run?.runId === runId && !ACTIVE.has(L.kind)) live.delete(k);
  invalidate();
  if (curPid() === pid) emit('runs:changed', { nodeId });
  return true;
}

/** Demande un calcul (passe par le bus, comme les boutons du bloc). */
export function run(nodeId, mode = null) {
  emit('node:run', { nodeId, mode });
}

/**
 * Annule le calcul en cours ou en file d'un bloc, et ses autres variantes encore en file (« 4 variantes ») — celles-ci
 * d'abord : annulé le premier, le calcul en cours laisserait démarrer la suivante.
 */
export async function cancel(nodeId) {
  const L = live.get(K(nodeId));
  if (!L?.jobId || !ACTIVE.has(L.kind)) return;
  const pid = curPid();
  const others = [...jobs.values()].filter((j) => j.jobId !== L.jobId && j.nodeId === nodeId
    && (j.projectId || pid) === pid && ACTIVE.has(j.state)).map((j) => j.jobId);
  let failed = null;
  for (const id of [...others, L.jobId]) {
    let res;
    try { res = await window.mia.engine.cancel(id); } catch { res = { ok: false }; }
    if (res && res.ok === false) failed = failed || res;
  }
  if (failed) toast(failed.error || t('run.err.cancel'), { kind: 'error' });
}

/**
 * « 4 variantes » : le même calcul avec `count` graines tirées au hasard, l'un après l'autre dans la file : autant de
 * versions à comparer, l'étoile choisit. La graine du bloc devient celle de la dernière variante (une étape annulable) :
 * sans étoile, la version affichée à la fin correspond aux réglages du bloc.
 * → { ok, jobIds, seeds, error } (ok : au moins une variante en file ; error : ce qui a arrêté les autres)
 */
export async function runVariants(nodeId, { count = 4, mode = null } = {}) {
  const ed = editor();
  const projectId = curPid();
  if (!projectId || !ed) return { ok: false, jobIds: [], seeds: [], error: t('run.err.noProject') };
  if (isActive(nodeId)) return { ok: false, jobIds: [], seeds: [], error: t('run.err.busy') };
  const n = Math.max(2, Math.min(8, Math.round(Number(count)) || 4));
  // des graines éloignées les unes des autres, entières et positives comme celles du dé
  const base = 1 + Math.floor(Math.random() * 1e9);
  const seeds = Array.from({ length: n }, (_, i) => base + i * 104729);
  const key = K(nodeId, projectId);
  live.set(key, { kind: 'queued', jobId: null, progress: null, mode: mode || null, optimistic: true });
  emit('runs:changed', { nodeId });
  const jobIds = [];
  let error = null;
  for (const seed of seeds) {
    const graph = ed.getGraph();
    const node = (graph?.nodes || []).find((x) => x.id === nodeId);
    if (!node) { error = t('run.err.generic'); break; }
    node.params = { ...(node.params || {}), seed };
    let res;
    try {
      res = await window.mia.engine.run({ projectId, nodeId, graph, mode: mode || null });
    } catch (err) {
      res = { ok: false, error: t('run.err.engine') };
      console.error(err);
    }
    if (!res || res.ok === false) { error = res?.error || t('run.err.generic'); break; }
    if (!res.jobId) continue;
    jobIds.push(res.jobId);
    if (!jobs.has(res.jobId)) {
      jobs.set(res.jobId, {
        jobId: res.jobId, projectId, nodeId, label: nodeLabel(nodeId), type: typeOf(nodeId)?.id || null,
        mode: mode || null, state: 'queued', created: Date.now(), progress: null, touched: Date.now(),
      });
    }
  }
  const L = live.get(key);
  if (L?.optimistic) {
    if (jobIds.length) live.set(key, { ...L, jobId: jobIds[0], optimistic: false });
    else live.delete(key);
  }
  if (jobIds.length && editor()?.getNode?.(nodeId)) {
    editor().updateNode?.(nodeId, { params: { seed: seeds[jobIds.length - 1] } }, { history: true });
  }
  notifyJobs();
  if (curPid() === projectId) emit('runs:changed', { nodeId });
  // l'appelant dit l'erreur (bouton : un message ; assistant : sa réponse), même quand une partie est partie
  return { ok: jobIds.length > 0, jobIds, seeds: seeds.slice(0, jobIds.length), error };
}

export async function cancelJob(jobId) {
  let res;
  try { res = await window.mia.engine.cancel(jobId); } catch { res = { ok: false }; }
  if (res && res.ok === false) toast(res.error || t('run.err.cancel'), { kind: 'error' });
}

// Le bouton « Lancer » d'un bloc émet node:run ; c'est ici qu'on parle au moteur.
async function handleRun({ nodeId, mode } = {}) {
  // un seul « Générer » : sans mode demandé, un bloc à deux modes calcule ses réglages tels quels (« final ») ;
  // l'aperçu (petite définition, plus court) ne part que quand un assistant le demande
  if (mode == null && typeOf(nodeId)?.modes?.includes('final')) mode = 'final';
  const ed = editor();
  const projectId = curPid();          // la planche ne montre qu'un projet
  if (!projectId || !ed) { toast(t('run.err.noProject'), { kind: 'error' }); return; }
  if (isActive(nodeId)) return;                       // déjà en file : pas de doublon
  const key = K(nodeId, projectId);
  // Retour immédiat (la réponse du moteur prend quelques ms) ; corrigé par les évènements.
  live.set(key, { kind: 'queued', jobId: null, progress: null, mode: mode || null, optimistic: true });
  emit('runs:changed', { nodeId });
  let res;
  try {
    res = await window.mia.engine.run({ projectId, nodeId, graph: ed.getGraph(), mode: mode || null });
  } catch (err) {
    res = { ok: false, error: t('run.err.engine') };
    console.error(err);
  }
  const L = live.get(key);
  const here = curPid() === projectId;
  if (!res || res.ok === false) {
    if (L?.optimistic) live.delete(key);
    if (here) emit('runs:changed', { nodeId });
    toast(res?.error || t('run.err.generic'), { kind: 'error', ms: 5200 });
    return;
  }
  if (L?.optimistic) {
    live.set(key, { ...L, jobId: res.jobId || null, optimistic: false });
    if (res.jobId && !jobs.has(res.jobId)) {
      jobs.set(res.jobId, {
        jobId: res.jobId, projectId, nodeId, label: nodeLabel(nodeId), type: typeOf(nodeId)?.id || null,
        mode: mode || null, state: 'queued', created: Date.now(), progress: null, touched: Date.now(),
      });
      notifyJobs();
    }
    // accepté sans job : rien à recalculer (tout était déjà à jour)
    if (!res.jobId) live.delete(key);
    if (here) emit('runs:changed', { nodeId });
  }
}

// ── branchements sur le bus ──────────────────────────────────────────

// Les évènements arrivent par le bus (relais de D). On s'abonne aussi au pont
// directement, au cas où le relais manquerait ; un même évènement reçu deux
// fois en moins d'une seconde n'est traité qu'une fois.
const seenEvents = new Map();
function firstTime(evt) {
  const sig = `${evt?.jobId}|${evt?.projectId}|${evt?.nodeId}|${evt?.kind}|${evt?.progress}|${evt?.eta}|${evt?.message}|${evt?.preview}|${evt?.run?.runId}|${evt?.remote}`;
  const now = performance.now();
  if (seenEvents.size > 300) {
    for (const [k, at] of seenEvents) if (now - at > 1000) seenEvents.delete(k);
  }
  const at = seenEvents.get(sig);
  if (at != null && now - at < 1000) return false;
  seenEvents.set(sig, now);
  return true;
}
const takeEvent = (evt) => { if (firstTime(evt)) onEngineEvent(evt); };
on('engine:event', takeEvent);
try { window.mia?.engine?.onEvent?.(takeEvent); } catch { /* pont absent (tests) */ }
on('node:run', handleRun);
on('project:opened', (p) => {
  const pid = p?.project?.id;
  if (pid && p.project.name) projectNames.set(pid, p.project.name);
  load(p?.runs || {}, pid);
  multiOrder = '';
  syncJobs();
});
on('project:closed', (p) => { if (p?.id) forgetProject(p.id); });
on('models:updated', invalidate);
syncJobs();
// Filet de sécurité (un seul, pour toute la session) : tant que quelque chose
// tourne, on recoupe avec le moteur toutes les 10 s — un évènement perdu ne
// doit pas laisser « EN FILE » à vie.
setInterval(() => {
  if (!document.hidden && [...jobs.values()].some((j) => ACTIVE.has(j.state))) syncJobs();
}, 10000);

/** Objet unique pour `import { runs } from './runs.js'` (SPEC : runs.list(…)). */
export const runs = {
  load, list, all, current, state, isStale, output, upstream, source, pin, unpin, removeRun, run, runVariants, cancel,
  cancelJob, versionNumber, findRun, registerType, typeOf, typeById, nodeLabel, jobList, onJobs, projectName, syncJobs,
  isActive, describe, remoteText, endText, runDuration, typicalSec, setMissing, isMissing,
};
export default runs;
