/**
 * Mia — the user's green light for assistants (SPEC §13.7).
 *
 * Two doors the user opens himself, so that an assistant never « goes everywhere » on his board:
 *  1. the request: the assistant says what it is about to do (mia_request); a small card waits at the bottom of
 *     the window — « Claude attend ton feu vert » — and nothing moves until « C'est parti »;
 *  2. « À générer »: a heavy or paid computation asked by an assistant is not started, it is listed in a panel on
 *     the right, one group per chain of wired blocks (a « plan »); the user ticks what he wants and starts it
 *     himself. Online (paid) ones arrive unticked.
 * Off (Réglages → Assistants → « Demander mon feu vert », or the switch « Je valide · Claude agit seul » at the bottom
 * left of the board — one preference, prefs.assistantAsk, both sides): assistants act and compute at once, heavy jobs
 * of the PC and paid online ones included (Quentin's decision, 19/11/2026: « Oui ils partent aussi pour les calculs
 * payants »), with neither card nor « À générer ».
 * Switching (SPEC §13.7, « Je valide · Claude agit seul »):
 *  - to « agit seul » while a request card waits: that request is accepted (the assistant goes on);
 *  - to « agit seul » while « À générer » holds lines: they STAY there, unticked ones unticked, with a line that says so —
 *    the switch never starts computations nobody looked at (paid ones arrive unticked); an assistant that asks for the
 *    same block again (mia_run) starts it at once, and its line leaves the list (launched);
 *  - back to « Je valide »: the green light given before is taken back, the next action of every assistant asks
 *    again (mia_request); nothing already started is cancelled;
 *  - « Pause » (title bar) keeps its role in both: it holds the assistants where they are.
 *
 * A LoRA training (SPEC « Entraîner un LoRA ») goes through the same two doors: the request says « Il prépare un
 * entraînement de LoRA » (mia_request {training:true}), and mia_train_start only SUGGESTS: a card « Claude propose
 * un entraînement » [Voir] [Refuser] [Plus tard] [Lancer] waits in the same island. That card is drawn from
 * train.json.proposal (main process: train:list at mount, then train:event), never from this module's memory, so
 * it comes back as it was after a reload; its buttons go through train:start / train:update.
 *
 * presence.js owns the calls; this module owns the state and the cards. Nothing else is kept across a restart.
 */
import { state } from '../state.js';
import { t, register } from '../i18n.js';
import { on, emit } from '../bus.js';
import { tip } from './tooltip.js';
import { money } from './budget.js';
import { typeOf } from '../catalog.js';
import { tl } from '../i18n.js';
import { setPrefs } from './settings.js';

register({
  fr: {
    'gl.ask.title': '{name} attend ton feu vert',
    'gl.ask.none': 'Il veut modifier ta planche.',
    'gl.ask.noRuns': 'Aucun calcul.',
    'gl.ask.runs1': '1 calcul proposé, à cocher ensuite.',
    'gl.ask.runs': '{n} calculs proposés, à cocher ensuite.',
    'gl.ask.go': 'C’est parti',
    'gl.ask.later': 'Plus tard',
    'gl.ask.detail': 'Détail',
    'gl.ask.refuse': 'Refuser',
    'gl.ask.chip': '{name} attend ton feu vert',
    'gl.ask.chipTip': 'Voir ce que {name} veut faire',
    'gl.tray.title': 'À générer',
    'gl.tray.by': 'proposé par {name}',
    'gl.tray.go': 'Générer la sélection ({n})',
    'gl.tray.goNone': 'Générer',
    'gl.tray.none': 'Rien de coché',
    'gl.tray.online': 'en ligne',
    'gl.tray.clear': 'Tout retirer',
    'gl.tray.clearTip': 'Vider la liste. Les blocs restent sur la planche, rien n’est calculé.',
    'gl.tray.fold': 'Replier la liste',
    'gl.tray.plan': 'Plan',
    'gl.tray.pulled': 'calculé pour la suite',
    'gl.tray.pulledTip': 'Décoché, mais un calcul coché en a besoin : il sera fait quand même.',
    'gl.tray.chip': 'À générer · {n}',
    'gl.tray.elsewhere1': '1 autre sur une autre planche',
    'gl.tray.elsewhere': '{n} autres sur d’autres planches',
    'gl.tray.gone': 'Ce bloc n’est plus sur la planche.',
    'gl.tray.onPc': '{time} sur ce PC',
    'gl.tray.paid': '{price} en ligne',
    'gl.tray.check': 'Générer « {name} »',
    'gl.ask.training': 'Il prépare un entraînement de LoRA. Tu le lanceras toi-même ensuite.',
    'gl.train.title': '{name} propose un entraînement',
    'gl.train.titleResume': '{name} propose de reprendre {training} au pas {step}',
    'gl.train.steps': '{n} pas',
    'gl.train.view': 'Voir',
    'gl.train.decline': 'Refuser',
    'gl.train.later': 'Plus tard',
    'gl.train.start': 'Lancer',
    'gl.train.resume': 'Reprendre',
    'gl.train.chip': '{name} propose un entraînement',
    'gl.train.chipResume': '{name} propose de reprendre {training}',
    'gl.train.chipTip': 'Voir ce que {name} propose',
    'gl.train.failed': 'Le départ n’a pas pu se faire.',
    'gl.mode.group': 'Feu vert des assistants',
    'gl.mode.ask': 'Je valide',
    'gl.mode.auto': 'Claude agit seul',
    // a narrow window shows only the chosen mode: « Je valide » alone would read as a button to validate something
    'gl.mode.askTight': 'Claude demande',
    'gl.mode.askTip': 'Claude te montre ce qu’il veut faire et attend ton « C’est parti ». Ses calculs lourds ou payants vont dans « À générer ».',
    'gl.mode.autoTip': 'Claude lance tout sans te demander, y compris les calculs en ligne payants.',
    'gl.mode.flip': 'Clic : passer en « {mode} ».',
    'gl.tray.before': 'Proposés avant « Claude agit seul » : ils attendent ta coche.',
  },
  en: {
    'gl.ask.title': '{name} is waiting for your go-ahead',
    'gl.ask.none': 'It wants to change your board.',
    'gl.ask.noRuns': 'No computation.',
    'gl.ask.runs1': '1 computation proposed, to tick afterwards.',
    'gl.ask.runs': '{n} computations proposed, to tick afterwards.',
    'gl.ask.go': 'Go ahead',
    'gl.ask.later': 'Later',
    'gl.ask.detail': 'Details',
    'gl.ask.refuse': 'Decline',
    'gl.ask.chip': '{name} is waiting for your go-ahead',
    'gl.ask.chipTip': 'See what {name} wants to do',
    'gl.tray.title': 'To generate',
    'gl.tray.by': 'proposed by {name}',
    'gl.tray.go': 'Generate the selection ({n})',
    'gl.tray.goNone': 'Generate',
    'gl.tray.none': 'Nothing ticked',
    'gl.tray.online': 'online',
    'gl.tray.clear': 'Remove all',
    'gl.tray.clearTip': 'Empty the list. The blocks stay on the board, nothing is computed.',
    'gl.tray.fold': 'Fold the list',
    'gl.tray.plan': 'Shot',
    'gl.tray.pulled': 'computed for what follows',
    'gl.tray.pulledTip': 'Unticked, but a ticked computation needs it: it will be done anyway.',
    'gl.tray.chip': 'To generate · {n}',
    'gl.tray.elsewhere1': '1 more on another board',
    'gl.tray.elsewhere': '{n} more on other boards',
    'gl.tray.gone': 'This block is no longer on the board.',
    'gl.tray.onPc': '{time} on this PC',
    'gl.tray.paid': '{price} online',
    'gl.tray.check': 'Generate “{name}”',
    'gl.ask.training': 'It is preparing a LoRA training. You will start it yourself afterwards.',
    'gl.train.title': '{name} suggests a training',
    'gl.train.titleResume': '{name} suggests resuming {training} at step {step}',
    'gl.train.steps': '{n} steps',
    'gl.train.view': 'View',
    'gl.train.decline': 'Decline',
    'gl.train.later': 'Later',
    'gl.train.start': 'Start',
    'gl.train.resume': 'Resume',
    'gl.train.chip': '{name} suggests a training',
    'gl.train.chipResume': '{name} suggests resuming {training}',
    'gl.train.chipTip': 'See what {name} suggests',
    'gl.train.failed': 'It could not start.',
    'gl.mode.group': 'Assistants’ go-ahead',
    'gl.mode.ask': 'I approve',
    'gl.mode.auto': 'Claude acts alone',
    'gl.mode.askTight': 'Claude asks',
    'gl.mode.askTip': 'Claude shows you what it wants to do and waits for your “Go ahead”. Its heavy or paid computations go to “To generate”.',
    'gl.mode.autoTip': 'Claude starts everything without asking you, including paid online computations.',
    'gl.mode.flip': 'Click: switch to “{mode}”.',
    'gl.tray.before': 'Proposed before “Claude acts alone”: they wait for your tick.',
  }
});

const GRANT_MS = 10 * 60 * 1000;      // a green light lasts while the assistant works: 10 min without a call ends it

let dom = null;
let seq = 0;
let ask = null;            // { id, client, title, summary, steps, runs, state: pending|accepted|declined|replaced, later, open, waiters }
let grant = null;          // { client, until }
const items = [];          // « À générer »: { id, nodeId, boardId, mode, variants, by, checked, error }
const settled = new Map(); // pendingId → { state: launched|removed, jobId?, jobIds? } (what became of an item)
let folded = false;
// openTraining(id): shows the « Entraînements » screen on that training (set by the screen when it mounts)
let hooks = { launch: null, editor: () => null, runs: () => null, openTraining: null };
// Suggestions of a LoRA training (mia_train_start): training id → { id, at, by, resume, name, base, baseLabel, step,
// steps, seconds, later, error, busy }. A mirror of train.json.proposal, rebuilt from the main process.
const proposals = new Map();

const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; };
const svg = (d, size = 14) => `<svg viewBox="0 0 20 20" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const ICON = {
  check: 'M4.5 10.5l3.6 3.6 7.4-8',
  down: 'M5.5 8l4.5 4.5L14.5 8',
  x: 'M5.5 5.5l9 9M14.5 5.5l-9 9',
  arrow: 'M3.2 2.4 17 9.3l-6.6 1.5-3.1 6.4z'
};

// ── public ──────────────────────────────────────────────────────────────

/** Is the green light asked at all? (« Je valide », the default; « Claude agit seul » = off. Réglages → Assistants too) */
export function enabled() { return state.prefs?.assistantAsk !== false; }

/** « ask » (Je valide) or « auto » (Claude agit seul): what the bridge tells the assistants (mia_request, mia_pending). */
export function mode() { return enabled() ? 'ask' : 'auto'; }

// The mode seen last: a change is followed wherever it comes from (the switch, Réglages, a preference set without the
// bus): prefs:changed, and every call of the assistants (allowed, request, snapshot) looks again.
let seenAsk = null;
function follow() {
  const on = enabled();
  if (seenAsk === on) return;
  const was = seenAsk;
  seenAsk = on;
  if (!on) answer('accepted');                 // « agit seul »: the request waiting on its card is accepted
  else if (was === false) grant = null;        // back to « Je valide »: every next action asks again
  paintMode();
  if (was !== null) paintTray();
}

/** May this assistant act now? Each allowed call keeps its green light alive. */
export function allowed(client) {
  follow();
  if (!enabled()) return true;
  const now = Date.now();
  if (grant && grant.client === client && now < grant.until) { grant.until = now + GRANT_MS; return true; }
  return false;
}

export function mountGreenlight(h = {}) {
  hooks = { ...hooks, ...h };
  if (dom) return;
  ensureCss();
  const stack = el('div', 'gl-stack');
  document.body.append(stack);
  const side = el('div', 'gl-side');
  document.body.append(side);
  dom = { stack, side, ask: null, tray: null, train: [], mode: null };
  seenAsk = enabled();
  mountMode();
  on('project:opened', () => paintTray());
  on('view:changed', () => { paintTray(); paintTrain(); });
  // the training screen shows another training (or the list): its card comes back, the shown one's goes
  on('train:shown', () => paintTrain());
  on('graph:changed', () => { if (items.length) scheduleTray(); });
  // the switch of the board and Réglages → Assistants are the same preference: each follows the other
  on('prefs:changed', () => { follow(); paintMode(); });
  // the suggestions of a training live in the main process: read now, then followed
  try { window.mia?.train?.onEvent?.((ev) => onTrainEvent(ev)); } catch { /* a preload without training */ }
  syncTraining();
}

/**
 * The assistant says what it is about to do. The same request asked again (its id) keeps waiting; a new one
 * replaces the previous one and takes back any green light given before: one click per thing asked.
 * → { id, state, answered: Promise<state> }
 */
export function request({ client, id, title, summary, steps, runs, training }) {
  follow();
  if (ask && ask.state === 'pending' && id && ask.id === id) return handle(ask);
  if (ask && id && ask.id === id) return handle(ask);                       // already answered: say so
  if (ask && ask.state === 'pending') settle(ask, 'replaced');
  grant = null;
  ask = {
    id: `r_${Date.now().toString(36)}${++seq}`, client,
    title: clean(title, 90), summary: clean(summary, 220),
    steps: (Array.isArray(steps) ? steps : []).map((s) => clean(s, 140)).filter(Boolean).slice(0, 12),
    runs: Number.isFinite(+runs) ? Math.max(0, Math.round(+runs)) : null,
    training: training === true,            // a LoRA training is being prepared: the card says a second click will follow
    state: 'pending', later: false, open: false, waiters: []
  };
  paintAsk(true);
  return handle(ask);
}

/** What the assistants may read: the request, the green light, and what became of each proposed computation. */
export function snapshot() {
  follow();
  return {
    enabled: enabled(),
    mode: mode(),                                       // « ask » (Je valide) or « auto » (Claude agit seul)
    request: ask ? { requestId: ask.id, state: ask.state, title: ask.title } : null,
    // may the assistants act now: always in « agit seul », with a green light still alive in « Je valide »
    granted: !enabled() || !!(grant && Date.now() < grant.until),
    toGenerate: [
      ...items.map((i) => ({ pendingId: i.id, nodeId: i.nodeId, boardId: i.boardId, mode: i.mode || null, ticked: i.checked, state: 'waiting' })),
      ...[...settled.entries()].slice(-40).map(([pendingId, s]) => ({ pendingId, ...s }))
    ]
  };
}

/** A computation an assistant asked for: listed, not started. The same block asked twice stays one line. */
export function addRun({ nodeId, boardId, mode, variants, by, online }) {
  let it = items.find((i) => i.nodeId === nodeId && i.boardId === boardId);
  if (it) { Object.assign(it, { mode: mode || null, variants: variants || 0, by }); }
  else {
    it = { id: `g_${Date.now().toString(36)}${++seq}`, nodeId, boardId, mode: mode || null, variants: variants || 0, by, checked: !online, error: '' };
    items.push(it);
  }
  folded = false;
  paintTray(true);
  return it;
}

/**
 * « Claude agit seul »: an assistant started a block itself (mia_run) — its line of « À générer », proposed before the
 * switch, leaves the list, marked launched (mia_pending), as if the user had ticked and started it. → true when one left.
 */
export function launched({ nodeId, boardId, jobId, jobIds }) {
  const it = items.find((i) => i.nodeId === nodeId && i.boardId === boardId);
  if (!it) return false;
  settled.set(it.id, { state: 'launched', nodeId, boardId, jobId: jobId || null, ...(jobIds ? { jobIds } : {}) });
  items.splice(items.indexOf(it), 1);
  paintTray();
  return true;
}

// ── the request card ────────────────────────────────────────────────────

function handle(a) {
  return {
    id: a.id, state: a.state,
    answered: a.state === 'pending' ? new Promise((resolve) => a.waiters.push(resolve)) : Promise.resolve(a.state)
  };
}

function settle(a, st) {
  a.state = st;
  for (const w of a.waiters.splice(0)) { try { w(st); } catch { /* gone */ } }
}

function answer(st) {
  if (!ask || ask.state !== 'pending') return;
  if (st === 'accepted') grant = { client: ask.client, until: Date.now() + GRANT_MS };
  settle(ask, st);
  paintAsk();
}

function clean(s, max) { return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }

function runsLine(a) {
  if (a.runs == null) return '';
  return a.runs === 0 ? t('gl.ask.noRuns') : a.runs === 1 ? t('gl.ask.runs1') : t('gl.ask.runs', { n: a.runs });
}

function paintAsk(fresh = false) {
  if (!dom) return;
  dom.ask?.remove();
  dom.ask = null;
  if (!ask || ask.state !== 'pending') return;
  const a = ask;
  if (a.later) {
    // « Plus tard »: a quiet chip that keeps the request one click away
    const chip = el('button', 'gl-chip');
    chip.type = 'button';
    chip.innerHTML = `<i class="gl-dot"></i><span></span>`;
    chip.querySelector('span').textContent = t('gl.ask.chip', { name: a.client });
    chip.addEventListener('click', () => { a.later = false; paintAsk(true); });
    try { tip(chip, () => t('gl.ask.chipTip', { name: a.client }), { placement: 'top' }); } catch { /* tooltips not ready */ }
    dom.ask = chip;
    dom.stack.prepend(chip);
    return;
  }
  const card = el('div', 'gl-card gl-ask' + (fresh ? ' gl-in' : ''));
  card.setAttribute('role', 'alertdialog');
  const head = el('div', 'gl-ask-head');
  const glyph = el('span', 'gl-glyph');
  glyph.innerHTML = svg(ICON.arrow, 16);
  const txt = el('div', 'gl-ask-txt');
  txt.append(el('div', 'gl-ask-title', t('gl.ask.title', { name: a.client })));
  // one sentence each: what, how much, how many computations
  const dot = (x) => (x && !/[.!?…:]$/.test(x) ? `${x}.` : x);
  // a training: its own sentence takes the place of « Il veut modifier ta planche. » and of the computations line
  const lead = a.title || a.summary;
  const what = (a.training
    ? [dot(lead), a.title && a.summary ? dot(a.summary) : '', t('gl.ask.training')]
    : [dot(lead || t('gl.ask.none')), a.title && a.summary ? dot(a.summary) : '', runsLine(a)]).filter(Boolean).join(' ');
  txt.append(el('div', 'gl-ask-sub', what));
  const acts = el('div', 'gl-ask-acts');
  const detail = el('button', 'btn sm btn-ghost', t('gl.ask.detail'));
  const later = el('button', 'btn sm btn-ghost', t('gl.ask.later'));
  const go = el('button', 'btn sm btn-primary', t('gl.ask.go'));
  for (const b of [detail, later, go]) b.type = 'button';
  detail.hidden = !a.steps.length && !(a.title && a.summary);
  acts.append(detail, later, go);
  head.append(glyph, txt, acts);
  card.append(head);
  const more = el('div', 'gl-ask-more');
  more.hidden = !a.open;
  if (a.steps.length) {
    const ol = el('ol', 'gl-steps');
    for (const s of a.steps) ol.append(el('li', '', s));
    more.append(ol);
  }
  const refuse = el('button', 'btn xs btn-ghost gl-refuse', t('gl.ask.refuse'));
  refuse.type = 'button';
  more.append(refuse);
  card.append(more);
  detail.addEventListener('click', () => { a.open = !a.open; more.hidden = !a.open; detail.setAttribute('aria-expanded', String(a.open)); });
  later.addEventListener('click', () => { a.later = true; paintAsk(); });
  go.addEventListener('click', () => answer('accepted'));
  refuse.addEventListener('click', () => answer('declined'));
  dom.ask = card;
  dom.stack.prepend(card);
}

// ── the suggestion of a LoRA training ───────────────────────────────────

/**
 * train.json.proposal is the truth: give this a row of train:list, the summary of a train:event or the answer of
 * train:get ({id, name, base, step, steps, proposal:{by, at, resume} | null}). A proposal draws (or refreshes) the
 * card; none removes it. Called here at mount and at every train:event; the training screen may call it too.
 */
export function proposeTraining(s) {
  if (!s || !s.id) return;
  if (!s.proposal || s.missing) {
    if (proposals.delete(s.id)) paintTrain();
    return;
  }
  let p = proposals.get(s.id);
  const fresh = !p || p.at !== s.proposal.at;
  if (fresh) {
    p = { id: s.id, at: s.proposal.at, later: false, error: '', busy: false, baseLabel: '', seconds: null };
    proposals.set(s.id, p);
  }
  Object.assign(p, { by: clean(s.proposal.by, 24) || 'Assistant', resume: !!s.proposal.resume, name: clean(s.name, 60), base: s.base || '', step: +s.step || 0, steps: +s.steps || 0 });
  readTraining(p, s);
  paintTrain(fresh ? s.id : null);
  // a row of the list has neither the model's name nor the expected length: read the whole training once
  if (s.estimate === undefined) refreshTraining(p);
}

/** Every suggestion waiting in the main process: at mount, after a reload, when the list changed. */
export async function syncTraining() {
  let list;
  try { list = await window.mia?.train?.list?.(); } catch { list = null; }
  if (!Array.isArray(list)) return;
  const seen = new Set();
  for (const row of list) { if (row && row.proposal && !row.missing) seen.add(row.id); proposeTraining(row); }
  let gone = false;
  for (const id of [...proposals.keys()]) if (!seen.has(id)) { proposals.delete(id); gone = true; }
  if (gone) paintTrain();
}

let syncT = 0;
function onTrainEvent(ev) {
  if (!ev) return;
  if (ev.id && ev.summary) proposeTraining(ev.summary);
  else if (ev.list) { clearTimeout(syncT); syncT = setTimeout(syncTraining, 200); }
}

/** What train:get knows beyond a row: the model's name, how long it should last. */
function readTraining(p, s) {
  if (s.baseLabel) p.baseLabel = typeof s.baseLabel === 'object' ? tl(s.baseLabel) : String(s.baseLabel);
  const est = s.state === 'pret' ? s.estimate : s.eta;
  if (est !== undefined) p.seconds = est && Number.isFinite(+est.seconds) ? +est.seconds : null;
}

/** The values shown are those of train.json now — read again when the card appears, and before every start. */
async function refreshTraining(p) {
  let s;
  try { s = await window.mia?.train?.get?.(p.id); } catch { s = null; }
  if (!s || s.ok === false || proposals.get(p.id) !== p) return;
  if (!s.proposal) { proposals.delete(p.id); paintTrain(); return; }
  const before = `${p.name}|${p.baseLabel}|${p.steps}|${p.step}|${p.seconds}`;
  Object.assign(p, { name: clean(s.name, 60), base: s.base || p.base, step: +s.step || 0, steps: +s.steps || 0 });
  readTraining(p, s);
  if (before !== `${p.name}|${p.baseLabel}|${p.steps}|${p.step}|${p.seconds}`) paintTrain();
}

const num = (n) => Math.round(+n || 0).toLocaleString(state.prefs?.lang === 'en' ? 'en-US' : 'fr-FR');
/** « ≈ 4 h 20 min » — the same words in French and in English. */
function about(seconds) {
  if (!(seconds > 0)) return '';
  const m = Math.max(1, Math.round(seconds / 60));
  return m < 60 ? `≈ ${m} min` : `≈ ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

function canOpenTraining() { return typeof hooks.openTraining === 'function' || !!document.getElementById('view-train'); }
function openTraining(id) {
  if (typeof hooks.openTraining === 'function') { try { hooks.openTraining(id); } catch (err) { console.error('[greenlight] openTraining', err); } return; }
  emit('train:open', { id });
}

async function answerTraining(p, how) {
  if (p.busy) return;
  const api = window.mia?.train;
  p.busy = true;
  p.error = '';
  paintTrain();
  let r;
  try {
    // the main process checks everything again at the click: the draft unchanged since the suggestion, no other
    // training running, the disk, the model…
    r = how === 'start' ? await api.start(p.id, { proposal: true }) : await api.update(p.id, { proposal: null });
  } catch (err) { r = { ok: false, error: err?.message || String(err) }; }
  p.busy = false;
  if (proposals.get(p.id) !== p) return;                 // answered meanwhile (a train:event removed or replaced it)
  if (r && r.ok !== false) { proposals.delete(p.id); paintTrain(); return; }
  // the suggestion itself is gone (draft changed, already answered): nothing left to click
  if (r && (r.code === 'proposalChanged' || r.code === 'noProposal' || r.code === 'unknown')) { proposals.delete(p.id); paintTrain(); return; }
  // refused (another training running, disk…): the reason is shown and the card stays
  p.error = clean(r && r.error, 300) || t('gl.train.failed');
  p.later = false;
  paintTrain();
}

function paintTrain(freshId = null) {
  if (!dom) return;
  for (const x of dom.train) x.remove();
  dom.train = [];
  const list = [...proposals.values()].sort((a, b) => (a.at || 0) - (b.at || 0));
  // the screen of this very training is open: its banner (« CLAUDE PROPOSE … [Refuser] [Lancer] ») and its foot carry
  // the decision already — a card on top would hide ÉVÈNEMENTS or the images, and say the same thing a third time
  const shown = state.view === 'train' ? (document.getElementById('view-train')?.dataset.training || '') : '';
  for (const p of list) {
    if (shown && p.id === shown) continue;
    if (p.later) {
      // « Plus tard »: a quiet chip that keeps the suggestion one click away
      const chip = el('button', 'gl-chip gl-train-chip');
      chip.type = 'button';
      chip.dataset.training = p.id;
      chip.innerHTML = '<i class="gl-dot"></i><span></span>';
      chip.querySelector('span').textContent = p.resume ? t('gl.train.chipResume', { name: p.by, training: p.name }) : t('gl.train.chip', { name: p.by });
      chip.addEventListener('click', () => { p.later = false; paintTrain(p.id); });
      try { tip(chip, () => t('gl.train.chipTip', { name: p.by }), { placement: 'top' }); } catch { /* tooltips not ready */ }
      dom.train.push(chip);
      dom.stack.append(chip);
      continue;
    }
    const card = el('div', 'gl-card gl-train' + (freshId === p.id ? ' gl-in' : ''));
    card.setAttribute('role', 'alertdialog');
    card.dataset.training = p.id;
    const head = el('div', 'gl-ask-head');
    const glyph = el('span', 'gl-glyph');
    glyph.innerHTML = svg(ICON.arrow, 16);
    const txt = el('div', 'gl-ask-txt');
    txt.append(el('div', 'gl-ask-title', p.resume
      ? t('gl.train.titleResume', { name: p.by, training: p.name, step: num(p.step) })
      : t('gl.train.title', { name: p.by })));
    const sub = [p.name, p.baseLabel || p.base, t('gl.train.steps', { n: num(p.steps) }), p.resume ? '' : about(p.seconds)].filter(Boolean).join(' · ');
    txt.append(el('div', 'gl-ask-sub', sub));
    if (p.error) txt.append(el('div', 'gl-train-err', p.error));
    const acts = el('div', 'gl-ask-acts');
    const view = el('button', 'btn sm btn-ghost', t('gl.train.view'));
    const no = el('button', 'btn sm btn-ghost', t('gl.train.decline'));
    const later = el('button', 'btn sm btn-ghost', t('gl.train.later'));
    const go = el('button', 'btn sm btn-primary', t(p.resume ? 'gl.train.resume' : 'gl.train.start'));
    for (const b of [view, no, later, go]) b.type = 'button';
    view.dataset.act = 'view'; no.dataset.act = 'decline'; later.dataset.act = 'later'; go.dataset.act = 'start';
    view.hidden = !canOpenTraining();
    no.disabled = go.disabled = !!p.busy;
    acts.append(view, no, later, go);
    head.append(glyph, txt, acts);
    card.append(head);
    view.addEventListener('click', () => openTraining(p.id));
    no.addEventListener('click', () => answerTraining(p, 'decline'));
    later.addEventListener('click', () => { p.later = true; paintTrain(); });
    go.addEventListener('click', () => answerTraining(p, 'start'));
    dom.train.push(card);
    dom.stack.append(card);
  }
}

// ── « À générer » ───────────────────────────────────────────────────────

let trayT = 0;
function scheduleTray() { clearTimeout(trayT); trayT = setTimeout(() => paintTray(), 250); }

function nodeName(n) {
  const def = n ? typeOf(n.type) : null;
  return n?.title || (def ? tl(def.label) : n?.type || '?');
}

/** What the block itself shows next to « Générer » (price, expected time): the tray says the same thing. */
function estOf(e, id) {
  const txt = e?.nodeEl?.(id)?.querySelector?.('.nb-est')?.textContent || '';
  return txt.replace(/\s+/g, ' ').trim();
}
function parseEst(txt) {
  let seconds = 0, usd = 0;
  let m = /≈\s*(\d+)\s*h\s*(\d+)/.exec(txt);
  if (m) seconds = (+m[1]) * 3600 + (+m[2]) * 60;
  else if ((m = /≈\s*(\d+)\s*min/.exec(txt))) seconds = (+m[1]) * 60;
  else if ((m = /≈\s*(\d+)\s*s\b/.exec(txt))) seconds = +m[1];
  if ((m = /(\d+[.,]\d+)\s*\$|\$\s*(\d+[.,]\d+)/.exec(txt))) usd = parseFloat((m[1] || m[2]).replace(',', '.')) || 0;
  return { seconds, usd };
}
function approx(s) {
  if (!(s > 0)) return '';
  if (s < 60) return `≈ ${Math.max(5, Math.round(s / 5) * 5)} s`;
  if (s < 3600) return `≈ ${Math.max(1, Math.round(s / 60))} min`;
  const m = Math.round(s / 60);
  return `≈ ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

/** « Claude · Taxi » → « Taxi », « Claude 2 » → « Claude 2 », « Claude » → '' : the worker that proposed a line. */
function workerOf(by) {
  const s = String(by || '').trim();
  const i = s.indexOf(' · ');
  if (i >= 0) return s.slice(i + 3);
  return /\s\d+$/.test(s) ? s : '';
}

/**
 * The lines of the open board, one group per chain of wired blocks (a « plan »), top to bottom as on the board,
 * each group left to right (what feeds comes before what is fed). Also: who is downstream of whom.
 */
function groupsOf(e, here) {
  const g = e?.getGraph?.() || {};
  const nodes = g.nodes || [], edges = g.edges || [];
  const near = new Map(), down = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const x of edges) {
    const a = x.from?.node, b = x.to?.node;
    if (!a || !b) continue;
    push(near, a, b); push(near, b, a); push(down, a, b);
  }
  const comp = new Map();
  let k = 0;
  for (const n of nodes) {
    if (comp.has(n.id)) continue;
    k++;
    comp.set(n.id, k);
    for (const todo = [n.id]; todo.length;) {
      const c = todo.pop();
      for (const o of near.get(c) || []) if (!comp.has(o)) { comp.set(o, k); todo.push(o); }
    }
  }
  const at = new Map(nodes.map((n) => [n.id, n]));
  const by = new Map();
  for (const i of here) push(by, comp.get(i.nodeId) ?? `alone:${i.id}`, i);
  const list = [...by.entries()].map(([key, its]) => {
    its.sort((a, b) => (at.get(a.nodeId)?.x ?? 0) - (at.get(b.nodeId)?.x ?? 0));
    const workers = [...new Set(its.map((i) => workerOf(i.by)).filter(Boolean))];
    const media = nodes.filter((n) => comp.get(n.id) === key && n.type === 'import' && n.data?.name).sort((a, b) => a.x - b.x || a.y - b.y)[0];
    return {
      items: its,
      y: Math.min(...its.map((i) => at.get(i.nodeId)?.y ?? Infinity)),
      label: workers.length === 1 ? workers[0] : media ? String(media.data.name).replace(/\.[a-z0-9]{2,5}$/i, '') : ''
    };
  }).sort((a, b) => a.y - b.y);
  const feeds = (from, to) => {
    const seen = new Set([from]);
    for (const todo = [from]; todo.length;) {
      for (const o of down.get(todo.pop()) || []) { if (o === to) return true; if (!seen.has(o)) { seen.add(o); todo.push(o); } }
    }
    return false;
  };
  return { list, feeds };
}

function checkBox(labelText) {
  const box = el('button', 'gl-check');
  box.type = 'button';
  box.setAttribute('role', 'checkbox');
  box.innerHTML = svg(ICON.check, 12) + '<i class="gl-dash"></i>';
  box.setAttribute('aria-label', labelText);
  return box;
}

function paintTray(fresh = false) {
  if (!dom) return;
  const scroll = dom.tray?.querySelector?.('.gl-rows')?.scrollTop || 0;
  dom.tray?.remove();
  dom.tray = null;
  const open = state.view === 'board' ? state.project?.id || null : null;
  const here = items.filter((i) => i.boardId === open);
  const elsewhere = items.length - here.length;
  if (!items.length) return;
  if (folded || !here.length) {
    const chip = el('button', 'gl-chip');
    chip.type = 'button';
    chip.innerHTML = '<i class="gl-dot"></i><span></span>';
    chip.querySelector('span').textContent = here.length ? t('gl.tray.chip', { n: here.length })
      : elsewhere === 1 ? t('gl.tray.elsewhere1') : t('gl.tray.elsewhere', { n: elsewhere });
    if (here.length) chip.addEventListener('click', () => { folded = false; paintTray(true); });
    else chip.disabled = true;
    dom.tray = chip;
    dom.side.append(chip);
    return;
  }
  const e = hooks.editor();
  const card = el('div', 'gl-card gl-tray' + (fresh ? ' gl-in-side' : ''));
  const head = el('div', 'gl-tray-head');
  head.append(el('span', 'gl-tray-title', t('gl.tray.title')));
  const by = [...new Set(here.map((i) => String(i.by || '').split(/[ ·]/)[0]).filter(Boolean))];
  head.append(el('span', 'gl-tray-by', by.length === 1 ? t('gl.tray.by', { name: by[0] }) : ''));
  const clear = el('button', 'btn xs btn-ghost', t('gl.tray.clear'));
  clear.type = 'button';
  clear.addEventListener('click', () => {
    for (const i of here) { settled.set(i.id, { state: 'removed', nodeId: i.nodeId, boardId: i.boardId }); items.splice(items.indexOf(i), 1); }
    paintTray();
  });
  try { tip(clear, () => t('gl.tray.clearTip'), { placement: 'bottom' }); } catch { /* tooltips not ready */ }
  const fold = el('button', 'gl-icon');
  fold.type = 'button';
  fold.innerHTML = svg(ICON.x);
  fold.setAttribute('aria-label', t('gl.tray.fold'));
  try { tip(fold, () => t('gl.tray.fold'), { placement: 'bottom' }); } catch { /* tooltips not ready */ }
  fold.addEventListener('click', () => { folded = true; paintTray(); });
  head.append(clear, fold);
  card.append(head);

  // what each block says next to its own « Générer »
  for (const i of here) {
    const n = e?.getNode?.(i.nodeId) || null;
    i.gone = !n;
    i.online = !!n && n.type === 'gen' && String(n.params?.model || '').startsWith('hf:');
    i.name = nodeName(n);
    i.text = n ? estOf(e, i.nodeId) : '';
    const p = parseEst(i.text);
    i.est = i.online ? { seconds: 0, usd: p.usd } : { seconds: p.seconds, usd: 0 };
  }
  const { list: groups, feeds } = groupsOf(e, here);
  const ticked = here.filter((i) => i.checked && !i.gone);
  // an unticked line that feeds a ticked one is computed anyway (a block computes what it lacks upstream)
  const pulled = (i) => !i.checked && !i.gone && ticked.some((x) => feeds(i.nodeId, x.nodeId));

  const list = el('div', 'gl-rows');
  const many = groups.length > 1;
  for (const grp of groups) {
    const live = grp.items.filter((i) => !i.gone);
    if (many) {
      const hd = el('div', 'gl-group');
      const on = live.filter((i) => i.checked).length;
      const box = checkBox(grp.label || t('gl.tray.plan'));
      box.setAttribute('aria-checked', on && on === live.length ? 'true' : on ? 'mixed' : 'false');
      box.disabled = !live.length;
      const flip = () => { const v = !(on && on === live.length); for (const i of live) i.checked = v; paintTray(); };
      box.addEventListener('click', flip);
      const name = el('span', 'gl-group-name', grp.label || t('gl.tray.plan'));
      name.addEventListener('click', flip);
      hd.append(box, name, el('span', 'gl-group-n', `${on}/${grp.items.length}`));
      list.append(hd);
    }
    for (const i of grp.items) {
      const row = el('div', 'gl-row' + (i.gone ? ' is-gone' : '') + (i.checked ? '' : ' is-off') + (many ? ' in-group' : ''));
      const box = checkBox(t('gl.tray.check', { name: i.name }));
      box.setAttribute('aria-checked', String(!!i.checked && !i.gone));
      box.disabled = i.gone;
      const label = el('span', 'gl-name', i.name);
      const need = pulled(i);
      const sub = el('span', 'gl-sub', i.gone ? t('gl.tray.gone') : i.error || (need ? t('gl.tray.pulled')
        : i.online ? [i.text.replace(/\s*·\s*≈.*$/, ''), t('gl.tray.online')].filter(Boolean).join(' · ') : i.text));
      if (i.error) sub.classList.add('is-bad');
      if (need) { row.classList.add('is-pulled'); try { tip(sub, () => t('gl.tray.pulledTip'), { placement: 'left' }); } catch { /* tooltips not ready */ } }
      const toggle = () => { if (i.gone) return; i.checked = !i.checked; paintTray(); };
      box.addEventListener('click', toggle);
      label.addEventListener('click', toggle);
      row.append(box, label, sub);
      list.append(row);
    }
  }
  card.append(list);
  if (elsewhere) card.append(el('div', 'gl-else', elsewhere === 1 ? t('gl.tray.elsewhere1') : t('gl.tray.elsewhere', { n: elsewhere })));
  // « Claude agit seul »: what was proposed before the switch does not start by itself — it waits for the tick
  if (!enabled()) card.append(el('div', 'gl-before', t('gl.tray.before')));

  const foot = el('div', 'gl-tray-foot');
  const total = el('span', 'gl-total');
  const go = el('button', 'btn sm btn-primary');
  go.type = 'button';
  let s = 0, usd = 0;
  for (const i of here) { if (i.gone || !(i.checked || pulled(i))) continue; s += i.est?.seconds || 0; usd += i.est?.usd || 0; }
  const parts = [];
  if (s) parts.push(t('gl.tray.onPc', { time: approx(s) }));
  if (usd) parts.push(t('gl.tray.paid', { price: money(usd) }));
  total.textContent = ticked.length ? parts.join(' · ') : t('gl.tray.none');
  go.textContent = ticked.length ? t('gl.tray.go', { n: ticked.length }) : t('gl.tray.goNone');
  go.disabled = !ticked.length;
  foot.append(total, go);
  card.append(foot);
  go.addEventListener('click', async () => {
    go.disabled = true;
    // left to right: what feeds is asked first, so the engine never starts the same upstream twice
    for (const i of groups.flatMap((x) => x.items).filter((x) => x.checked && !x.gone)) {
      let r;
      try { r = await hooks.launch?.(i); } catch (err) { r = { ok: false, error: err?.message || String(err) }; }
      if (r && r.ok !== false) {
        settled.set(i.id, { state: 'launched', nodeId: i.nodeId, boardId: i.boardId, jobId: r.jobId || null, ...(r.jobIds ? { jobIds: r.jobIds } : {}) });
        items.splice(items.indexOf(i), 1);
      } else { i.error = (r && r.error) || '?'; }
    }
    paintTray();
  });
  dom.tray = card;
  dom.side.append(card);
  list.scrollTop = scroll;
}

// ── « Je valide · Claude agit seul » (bottom left of the board) ─────────

/**
 * The switch, an island of its own right of the dock (« Bloc · Recettes · Section »), in the dock's style: two
 * choices, one click. « Claude agit seul » on = the one accent of Mia (a filled dot and a ring), visible at a glance.
 * Same preference as Réglages → Assistants → « Demander mon feu vert » (prefs.assistantAsk).
 */
function mountMode() {
  const board = document.getElementById('view-board');
  if (!board || dom.mode) return;
  const root = el('div', 'gl-mode');
  root.id = 'gl-mode';
  root.setAttribute('role', 'radiogroup');
  const glyph = el('span', 'gl-mode-glyph');
  glyph.innerHTML = svg(ICON.arrow, 13);
  const opt = (value) => {
    const b = el('button', 'gl-mode-opt');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.mode = value;
    if (value === 'auto') b.append(el('i', 'gl-mode-dot'));
    // a narrow window (.tight): a small switch in front of the one mode shown says it is a switch (greenlight.css)
    b.append(el('i', 'gl-mode-sw'), el('span', 'gl-mode-txt'));
    // narrow window (.tight): only the chosen one shows, and a click on it switches to the other
    b.addEventListener('click', () => {
      const other = value === 'auto' ? 'ask' : 'auto';
      pick(root.classList.contains('tight') && mode() === value ? other : value);
    });
    const tipText = () => {
      const own = t(value === 'auto' ? 'gl.mode.autoTip' : 'gl.mode.askTip');
      if (!root.classList.contains('tight')) return own;
      return `${own} ${t('gl.mode.flip', { mode: t(value === 'auto' ? 'gl.mode.askTight' : 'gl.mode.auto') })}`;
    };
    try { tip(b, tipText, { placement: 'top' }); } catch { /* tooltips not ready */ }
    return b;
  };
  const askBtn = opt('ask');
  const autoBtn = opt('auto');
  root.append(glyph, askBtn, autoBtn);
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    pick(mode() === 'ask' ? 'auto' : 'ask');
    (mode() === 'ask' ? askBtn : autoBtn).focus();
  });
  const dock = document.getElementById('dock');
  (dock && dock.parentNode === board ? dock : board.lastElementChild)?.after(root);
  // right of the dock, whatever its width (language, read-only board…)
  // …and short of the zoom bar (its Higgsfield amount comes and goes): too narrow, only the chosen mode shows (.tight)
  const zoom = document.getElementById('zoombar');
  const place = () => {
    if (!dock || !dock.offsetWidth) return;
    const left = dock.offsetLeft + dock.offsetWidth + 10;
    root.style.left = `${left}px`;
    // measured with both choices and their own words, then narrowed (its words change: paintMode)
    root.classList.remove('tight');
    paintMode();
    if (zoom && zoom.offsetWidth && root.offsetWidth > zoom.offsetLeft - 10 - left) { root.classList.add('tight'); paintMode(); }
  };
  try { const ro = new ResizeObserver(place); ro.observe(dock); if (zoom) ro.observe(zoom); ro.observe(board); } catch { /* no dock: the CSS place */ }
  // measured again before its tooltip says what a click does (a window without frames gets no ResizeObserver call)
  root.addEventListener('pointerenter', place);
  dom.mode = { root, askBtn, autoBtn };
  place();
  paintMode();
}

async function pick(value) {
  if (mode() === value) return;
  const want = value === 'ask';
  const p = setPrefs({ assistantAsk: want });         // the state moves at once, the file follows
  follow();
  paintMode();
  await p;
  follow();
  paintMode();
}

function paintMode() {
  const m = dom?.mode;
  if (!m) return;
  const cur = mode();
  m.root.setAttribute('aria-label', t('gl.mode.group'));
  m.root.classList.toggle('is-auto', cur === 'auto');
  for (const b of [m.askBtn, m.autoBtn]) {
    const on = b.dataset.mode === cur;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
    // narrow (.tight): « Claude demande » rather than « Je valide » — alone, it must say whose mode it is
    const tight = m.root.classList.contains('tight');
    const txt = t(b.dataset.mode === 'auto' ? 'gl.mode.auto' : (tight ? 'gl.mode.askTight' : 'gl.mode.ask'));
    const s = b.querySelector('.gl-mode-txt');
    if (s.textContent !== txt) s.textContent = txt;
  }
}

function ensureCss() {
  if (document.querySelector('link[data-greenlight]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../../css/greenlight.css', import.meta.url).href;
  link.dataset.greenlight = '';
  document.head.append(link);
}

export default { mountGreenlight, enabled, mode, allowed, request, snapshot, addRun, launched, proposeTraining, syncTraining };
