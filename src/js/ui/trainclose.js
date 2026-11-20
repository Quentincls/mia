/**
 * Closing Mia while a LoRA training is active (CONCEPTION-entrainement §2.6, §4 point 9, test 16).
 *
 *   askTrainingClose(training, answer, { askMs }) → the dialog's handle
 *     training: trainer.brief() as main.js sends it in app:flush ({name, step, steps, state…})
 *     answer:   (payload) => void — mia.win.flushed; the caller has already answered {hold:true}
 *
 * « Rester » → {cancel:true}. No click for askMs (4 min, before main.js's HOLD_MS of 5 min) → {cancel:true} too,
 * the box stays shown: no answer means « Rester » (Mia stays open, the training goes on). « Arrêter et quitter »
 * → {quit:true} (or, after the 4 min, a new close request: mia.win.close(), answered at once), then
 * « ÉCRITURE DU POINT DE CONTRÔLE… » with « Quitter sans attendre » → {now:true}.
 */
import { el } from '../util.js';
import { lang } from '../i18n.js';
import { openModal } from './modal.js';

const NBSP = ' ';
const S = {
  fr: {
    title: 'Fermer Mia',
    body: (n, s, t) => `Un entraînement est en cours (${n}, pas ${s} / ${t}). Quitter l’arrête au pas courant (ou au dernier point de contrôle si un essai est en cours)${NBSP}; tu pourras le reprendre.`,
    stay: 'Rester',
    stopQuit: 'Arrêter et quitter',
    writing: 'ÉCRITURE DU POINT DE CONTRÔLE…',
    now: 'Quitter sans attendre'
  },
  en: {
    title: 'Close Mia',
    body: (n, s, t) => `A training is running (${n}, step ${s} / ${t}). Quitting stops it at the current step (or at the last checkpoint if a sample is running); you can resume it.`,
    stay: 'Stay',
    stopQuit: 'Stop and quit',
    writing: 'WRITING THE CHECKPOINT…',
    now: 'Quit without waiting'
  }
};
const L = () => (lang() === 'en' ? S.en : S.fr);
const num = (n) => Math.round(Number(n) || 0).toLocaleString(lang() === 'en' ? 'en-US' : 'fr-FR').replace(/[   ]/g, NBSP);

export const ASK_MS = 4 * 60 * 1000;

let current = null;            // one box at a time (a second × while it is shown answers with what it already knows)

export function askTrainingClose(training, answer, { askMs = ASK_MS } = {}) {
  const s = L();
  if (current) {
    // the box is still up after the 4 min (Mia stayed open) and Quentin closes again: the box answers
    if (current.quitting) answer({ quit: true });
    else { current.answer = answer; current.arm(); }
    return current;
  }
  const st = { answer, quitting: false, timer: null, cancelled: false, handle: null, arm: null };
  const send = (p) => { try { st.answer(p); } catch (e) { console.error('[trainclose]', e); } };
  st.arm = () => {
    clearTimeout(st.timer);
    st.cancelled = false;
    st.timer = setTimeout(() => { st.cancelled = true; send({ cancel: true }); }, askMs);
  };
  const close = () => { clearTimeout(st.timer); current = null; st.handle.close(true); };

  const body = el('p', { class: 'trq-body' }, s.body(training?.name || '', num(training?.step), num(training?.steps)));
  const stay = el('button', { class: 'btn btn-ghost', type: 'button', 'data-trq': 'stay', 'data-autofocus': '' }, s.stay);
  const go = el('button', { class: 'btn btn-primary', type: 'button', 'data-trq': 'stopQuit' }, el('span', {}, s.stopQuit));
  const row = el('div', { class: 'modal-actions' }, stay, go);
  const content = el('div', { class: 'trq' }, el('h2', {}, s.title), body, row);

  stay.addEventListener('click', () => {
    if (!st.cancelled) send({ cancel: true });
    close();
  });
  go.addEventListener('click', () => {
    clearTimeout(st.timer);
    st.quitting = true;
    const now = el('button', { class: 'btn btn-ghost', type: 'button', 'data-trq': 'now' }, s.now);
    now.addEventListener('click', () => { now.disabled = true; send({ quit: true, now: true }); });
    const bar = el('div', { class: 'tr-bar b-indeterminate trq-bar' }, el('i', {}));
    body.replaceWith(el('div', { class: 'trq-writing' }, el('p', { class: 'trq-caps' }, s.writing), bar));
    row.replaceChildren(now);
    now.focus();
    if (st.cancelled) { try { window.mia?.win?.close?.(); } catch { /* the window is going anyway */ } }
    else send({ quit: true });
  });

  st.handle = openModal(content, { dismiss: false, className: 'trq-modal', width: 460 });
  current = st;
  st.arm();
  return st;
}

/** For the benches: the box shown now, or null. */
export const trainCloseOpen = () => current;
