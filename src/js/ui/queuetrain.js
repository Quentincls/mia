/**
 * Mia — the LoRA training in the jobs queue (#queue, ui\queue.js): the row at the head of the list
 * (« Entraînement LoRA · Rosa », « LTX 2.5 », « 49 % · FIN VERS 3 H 40 »), what the folded pill says when
 * only a training runs, when the waiting jobs can start behind it, and the « Arrêter… » question of its cross.
 * Pure functions (no DOM, no clock of their own): ui\queue.js draws what they return, and
 * tools\test-train-queue.mjs checks them in Node, in French and in English.
 *
 * `L` is always the language, 'fr' | 'en'. `s` is a training as train:list / train:event give it
 * ({id, name, base, state, phase, pause, step, steps, progress, endAt, seen, silent, pending, missing…}).
 * The state texts go in a MONO CAPS zone (the queue writes them in capitals by CSS).
 */
import * as X from './traintext.js';

export const STRINGS = {
  fr: {
    'q.label': 'Entraînement LoRA · {name}',
    'q.pill': 'LoRA · {name}',
    'q.wait': 'en attente du GPU',
    'q.prep': 'préparation',
    'q.run': '{pct}',
    'q.runEnd': '{pct} · fin vers {h}',
    'q.sample': 'essai · {pct}',
    'q.pass': 'en pause · laisse passer les calculs',
    'q.stopping': 'arrêt en cours',
    'q.pausing': 'mise en pause',
    'q.silent': 'sans nouvelle',
    'q.stop': 'Arrêter l’entraînement…',
    'q.stopFailed': 'L’entraînement n’a pas pu être arrêté.',
    'g.hold': 'L’entraînement « {name} » tient le GPU',
    'g.holdEnd': 'L’entraînement « {name} » tient le GPU (fin vers {h})',
    'g.beside': 'à côté : « {name} »'
  },
  en: {
    'q.label': 'LoRA training · {name}',
    'q.pill': 'LoRA · {name}',
    'q.wait': 'waiting for the GPU',
    'q.prep': 'preparing',
    'q.run': '{pct}',
    'q.runEnd': '{pct} · ends around {h}',
    'q.sample': 'sample · {pct}',
    'q.pass': 'paused · letting jobs through',
    'q.stopping': 'stopping',
    'q.pausing': 'pausing',
    'q.silent': 'no news',
    'q.stop': 'Stop the training…',
    'q.stopFailed': 'The training could not be stopped.',
    'g.hold': 'The training “{name}” holds the GPU',
    'g.holdEnd': 'The training “{name}” holds the GPU (ends around {h})',
    'g.beside': 'alongside: “{name}”'
  }
};

const lg = (L) => (L === 'en' ? 'en' : 'fr');
const fill = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k]))) : String(s));
/** A string of the table above. Unknown key → the key (a missing word shows, it does not hide). */
export function qx(L, key, vars) {
  const s = STRINGS[lg(L)][key] ?? STRINGS.fr[key];
  return s === undefined ? key : fill(s, vars);
}

/** States in which a training has ended: its row stays a few seconds in the queue, like a finished job. */
export const ENDED = new Set(['fini', 'erreur', 'annule', 'interrompu', 'pause']);

/** The training the queue shows: the active one (waiting for the GPU, preparing, training, sampling, letting jobs through). */
export function queueTraining(list) {
  return (list || []).find((s) => X.isActive(s)) || null;
}

const nameOf = (L, s) => (s && s.name) || X.tx(L, 'train.untitled');

/**
 * The row. bases: train:options().bases (the model's name), or nothing (the id in capitals, then).
 * → { label, sub, text, tone: 'live'|'muted'|'err', bar: 'progress'|'ind'|null, progress (0…1), tip, cancel (the cross shows) }
 */
export function trainRow(L, s, bases) {
  const name = nameOf(L, s);
  const p = Math.max(0, Math.min(1, Number(s.progress) || 0));
  const pct = X.pct(L, p);
  const out = {
    label: qx(L, 'q.label', { name }),
    sub: X.baseLabel(L, bases, s.base),
    text: '', tone: 'live', bar: null, progress: p, cancel: X.isActive(s),
    tip: ''
  };
  if (!X.isActive(s)) {
    // ended (or paused by hand) while it was in the queue: what became of it, the time of a glance
    out.text = X.rowState(L, s);
    out.tone = s.state === 'erreur' || s.state === 'interrompu' ? 'err' : 'muted';
  } else if (s.state === 'attente') {
    out.text = qx(L, 'q.wait');
    out.tone = 'muted';
  } else if (s.state === 'preparation') {
    out.text = qx(L, 'q.prep');
    out.bar = 'ind';
  } else if (s.state === 'pause') {             // « Laisser passer »: it resumes by itself once the jobs are done
    out.text = qx(L, 'q.pass');
    out.tone = 'muted';
  } else if (s.state === 'essai') {
    out.text = qx(L, 'q.sample', { pct });
    out.bar = 'progress';
  } else {
    out.text = s.endAt ? qx(L, 'q.runEnd', { pct, h: X.clock(L, s.endAt) }) : qx(L, 'q.run', { pct });
    out.bar = 'progress';
  }
  if (X.isActive(s)) {
    if (s.pending === 'stop' || s.pending === 'stopNow') out.text = `${out.text} · ${qx(L, 'q.stopping')}`;
    else if (s.pending === 'pause') out.text = `${out.text} · ${qx(L, 'q.pausing')}`;
    else if (s.silent) { out.text = `${out.text} · ${qx(L, 'q.silent')}`; out.tone = 'err'; }
  }
  // the same tooltip as the chip of the title bar: « Rosa · LTX 2.5 · pas 1 240 / 2 500 · fin vers 3 h 40 »
  out.tip = X.tx(L, 'chip.tip', { name, base: out.sub, a: X.int(L, s.step), b: X.int(L, s.steps) })
    + (s.endAt && X.isActive(s) ? X.tx(L, 'chip.tipEnd', { h: X.clock(L, s.endAt) }) : '');
  return out;
}

/** The folded pill when the training is all the queue holds: « LoRA · Rosa » · « 49 % · fin vers 3 h 40 ». */
export function trainPill(L, s, bases) {
  return { name: qx(L, 'q.pill', { name: nameOf(L, s) }), state: trainRow(L, s, bases).text };
}

/**
 * When Mia's local jobs that wait can start, given the training (ms), or null when nobody can tell.
 * A training that holds the GPU, or asks for it, goes first: the waiting local jobs start at its end
 * (engine pump(): heavyGate while holdGpu is asked or held). Letting jobs through (pause « pass »), they go now.
 */
export function laneStart(now, s) {
  if (!s || !X.isActive(s)) return now;
  if (s.state === 'pause') return now;
  return s.endAt ? Math.max(now, s.endAt) : null;
}

/**
 * The question of the cross (the same as « Arrêter… » on the training screen, design §2.5).
 * s: the full state of train:get (sampleStep and measured tell how long a sample still runs).
 * → { title, body, ok, cancel }
 */
export function stopQuestion(L, s, bases) {
  const name = nameOf(L, s);
  const ok = X.tx(L, 'stop.ok');
  const cancel = X.tx(L, 'stop.keep');
  // nothing to save (waiting, preparing), a mute tool: an immediate stop
  if ((s.state !== 'entrainement' && s.state !== 'essai') || s.silent) return { title: X.tx(L, 'stop.titleNow', { name }), body: '', ok, cancel };
  let body = X.tx(L, 'stop.body');
  if (s.state === 'essai') {
    const base = (bases || []).find((b) => b.id === s.base);
    const measured = { ...(s.measured || {}) };
    if (!measured.sampleSec && base && base.estimate && base.estimate.sampleSec) measured.sampleSec = base.estimate.sampleSec;
    const left = X.sampleLeft({ ...s, measured });
    body += ` ${left != null ? X.tx(L, 'stop.sample', { d: X.dur(left) }) : X.tx(L, 'stop.sampleNoTime')}`;
  }
  return { title: X.tx(L, 'stop.title', { name, a: X.int(L, s.step) }), body, ok, cancel };
}

/**
 * Who holds the GPU, as the window of the GPU chip says it, when it is a LoRA training of this Mia: « L’entraînement
 * « Plumo » tient le GPU (fin vers 15 h 10) », then « · à côté : « Portrait » » when a job runs beside it.
 * The engine's status says it (status.training, the brief of electron\trainer.js), whatever the lock file says: a tool
 * without a lock (the fake one) or a lock read at the wrong moment no longer gives « GPU libre » under a 46 GB training.
 * s: status.training (or a row of train:list); beside: the name of the job running beside it, or ''.
 * → the sentence, or null when no training holds the GPU (waiting for it, letting jobs through, paused, ended).
 */
export function gpuHolder(L, s, beside = '') {
  if (!s || !HOLDING.has(s.state)) return null;
  const name = nameOf(L, s);
  let out = s.endAt ? qx(L, 'g.holdEnd', { name, h: X.clock(L, s.endAt) }) : qx(L, 'g.hold', { name });
  if (beside) out += ` · ${qx(L, 'g.beside', { name: beside })}`;
  return out;
}
/** The states in which a training has the GPU: loading its model and its data, training, making a sample. */
const HOLDING = new Set(['preparation', 'entrainement', 'essai']);

/**
 * The second line of a job's row in the queue while it waits behind a training: the short reason the engine gives
 * with the message (waitShort: the reason first, without the training's name — its row is right above), else the
 * whole message. The whole message stays in the tooltip, on the block and in mia_jobs.
 * job: {trainWait, waitShort}; full: the whole sentence (runs.trainWaitText). → '' when it does not wait for a training.
 */
export function waitLine(job, full) {
  if (!job || !job.trainWait) return '';
  return (typeof job.waitShort === 'string' && job.waitShort.trim()) || full || '';
}

export default { STRINGS, qx, ENDED, queueTraining, trainRow, trainPill, laneStart, stopQuestion, gpuHolder, waitLine };
