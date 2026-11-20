/**
 * Mia — the « Entraînements » screen (SPEC « Entraîner un LoRA ») and its chip in the title bar.
 *
 *   mountTrain(#view-train, { show(), back(), backLabel(), tryLora({name, trigger, file, base}) })
 *   mountTrainChip(#tb-actions)
 *   openTrain(id?)      shows the screen, on one training or on the list
 *   trainEscape()       Esc: closes the tool log if it is open (→ true), else lets app.js go back
 *
 * Three pages in one view: the list, a draft (state `pret`), the instrument (every other state).
 * THE WINDOW KEEPS NOTHING: the training lives in the main process (window.mia.train.*, electron\trainer.js), its
 * folder is the truth. This module asks train:get, draws what comes back, and listens to train:event — so what an
 * assistant prepares or starts through the bridge shows here exactly as what the user does.
 * Every word and every « what to show in this state » is in traintext.js (pure, tested in Node).
 */
import { on, emit } from '../bus.js';
import { state, absUrl } from '../state.js';
import { lang, register } from '../i18n.js';
import { el, isTyping, baseName, debounce } from '../util.js';
import { segmented, textField, numberField, button } from './controls.js';
import { openMenu, closeMenu } from './menu.js';
import { confirm, isModalOpen } from './modal.js';
import { toast } from './toasts.js';
import { tip, hideTip } from './tooltip.js';
import { icon } from '../icons.js';
import { createChart } from './trainchart.js';
import * as X from './traintext.js';

register(X.STRINGS);

const api = () => window.mia?.train || null;
let L = 'fr';
const T = (key, vars) => X.tx(L, key, vars);
const TN = (key, n, vars) => X.txn(L, key, n, vars);

let host = null;
let hooks = {};
let offEvent = null;
let pollTimer = 0;

const S = {
  shown: false,
  mode: 'list',            // 'list' | 'draft' | 'run'
  id: null,
  rows: [],                // train:list
  options: null,           // train:options
  cur: null,               // train:get of S.id (with images[] for a draft)
  fetching: false,
  again: false,
  // draft
  pick: null,              // original name of the image whose caption shows
  onlySmall: false,
  advOpen: false,
  startErr: '',
  busy: false,
  // instrument
  sample: null,            // {step, i} the sample on the big place; null = follow the last one
  fresh: new Set(),        // sample steps that arrived while another one was looked at
  filter: 'all',
  logOpen: false,
  ramLowAt: 0
};
let V = null;              // the nodes of the page on screen (rebuilt when the mode or the training changes)

const fail = (r) => {
  const why = (r && typeof r === 'object' && r.error) || T('err.unknown');
  toast(why, { kind: 'error', ms: 7000 });
};
const bad = (r) => !r || (typeof r === 'object' && r.ok === false);
async function call(fn, ...args) {
  let r;
  try { r = await fn(...args); } catch (err) { r = { ok: false, error: err?.message || String(err) }; }
  return r;
}

const baseOf = (id) => (S.options?.bases || []).find((b) => b.id === id) || null;
const baseText = (id) => X.baseLabel(L, S.options?.bases, id);
const kicker = (text, cls = '') => el('span', { class: `kicker ${cls}`.trim() }, text);
const nameOf = (s) => (s && s.name) || T('train.untitled');
const otherActive = (id) => S.rows.some((r) => r.id !== id && X.isActive(r));

// ── mount ─────────────────────────────────────────────────────────────
export function mountTrain(target = document.getElementById('view-train'), h = {}) {
  if (!target || host) return;
  host = target;
  hooks = h || {};
  L = lang() === 'en' ? 'en' : 'fr';
  host.classList.add('tr-view');
  installDrop();
  on('view:changed', ({ view } = {}) => setShown(view === 'train'));
  // an assistant preparing or suggesting a training (presence.js, greenlight.js), the library, the queue
  on('train:open', (p) => openTrain(p && p.id ? String(p.id) : null));
  on('engine:status', () => { if (S.shown && S.mode === 'run' && S.cur) paintStats(S.cur); });
  window.addEventListener('keydown', onKey);
  if (!api()) return;
  try { offEvent = api().onEvent(onEvent); } catch (err) { console.error('[train] onEvent', err); }
  loadRows();
  loadOptions();
}

async function loadRows() {
  const a = api();
  if (!a) return;
  const list = await call(a.list);
  if (!Array.isArray(list)) return;
  S.rows = list;
  paintChip();
  if (S.shown && S.mode === 'list') paintList();
}

async function loadOptions() {
  const a = api();
  if (!a) return null;
  const o = await call(a.options);
  if (o && o.ok !== false) S.options = o;
  return S.options;
}

function onEvent(ev) {
  if (!ev) return;
  if (ev.list) { loadRows(); return; }
  if (!ev.id || !ev.summary) return;
  const i = S.rows.findIndex((r) => r.id === ev.id);
  if (i >= 0) S.rows[i] = { ...S.rows[i], ...ev.summary, sizeMB: ev.summary.sizeMB ?? S.rows[i].sizeMB };
  else S.rows.unshift(ev.summary);
  paintChip();
  if (!S.shown) return;
  if (S.mode === 'list') paintList();
  else if (S.id === ev.id) refresh();
}

function setShown(shown) {
  if (shown === S.shown) return;
  S.shown = shown;
  clearInterval(pollTimer);
  pollTimer = 0;
  if (!shown) {
    closeLog();
    stopMedia();
    if (S.mode === 'draft') leaveDraft(S.id);
    markShown();
    return;
  }
  L = lang() === 'en' ? 'en' : 'fr';
  loadOptions().then(() => { if (S.shown) repaint(); });
  loadRows();
  build();
  if (S.id) refresh();
  // one reading a second while something moves (the main process pushes at most one event a second anyway);
  // « IL Y A 2 MIN » and the list's sizes follow at a slower pace
  let n = 0;
  pollTimer = setInterval(() => {
    n++;
    if (!S.shown) return;
    if (S.mode !== 'list' && S.cur && (X.isActive(S.cur) || S.cur.importing || S.cur.pending)) refresh();
    else if (S.mode === 'run' && S.cur && n % 30 === 0) paintRun(S.cur);
    if (S.logOpen && n % 2 === 0) loadLog();
  }, 1000);
}

/** Show the screen — on one training (draft or instrument, by its state) or on the list. */
export function openTrain(id = null) {
  if (!host) return;
  if (S.shown && S.mode === 'draft' && S.id && S.id !== (id || null)) leaveDraft(S.id);
  S.id = id || null;
  S.mode = id ? (X.isDraft(S.rows.find((r) => r.id === id)) ? 'draft' : 'run') : 'list';
  S.cur = null;
  resetPage();
  if (!S.shown) {
    try { hooks.show?.(); } catch (err) { console.error('[train] show', err); }
    // app.js answers through « view:changed »; a shell without it (tests) is drawn here
    if (!S.shown && !hooks.show) setShown(true);
    return;
  }
  build();
  if (S.id) refresh();
  else loadRows();
}

function resetPage() {
  S.pick = null;
  S.onlySmall = false;
  S.startErr = '';
  S.sample = null;
  S.fresh = new Set();
  S.filter = 'all';
  S.ramLowAt = 0;
  closeLog();
}

/** Esc: the tool log first. → true when something was closed here. */
export function trainEscape() {
  if (S.logOpen) { closeLog(); return true; }
  return false;
}

function goBack() {
  try { hooks.back?.(); } catch (err) { console.error('[train] back', err); }
}

// ── reading one training ──────────────────────────────────────────────
async function refresh() {
  const a = api();
  if (!a || !S.id) return;
  if (S.fetching) { S.again = true; return; }
  S.fetching = true;
  const id = S.id;
  const s = await call(a.get, id, { dataset: S.mode === 'draft' });
  S.fetching = false;
  if (id !== S.id || !S.shown) return;
  if (bad(s)) {
    // gone (put in the Bin from elsewhere): back to the list
    if (s && s.code === 'unknown') { openTrain(null); return; }
    fail(s);
    return;
  }
  const mode = X.isDraft(s) ? 'draft' : 'run';
  const changed = mode !== S.mode || !V || V.mode !== mode;
  if (mode === 'draft' && !Array.isArray(s.images)) {       // it was read as an instrument: read again with its set
    S.mode = mode;
    S.fetching = false;
    refresh();
    return;
  }
  S.cur = s;
  S.mode = mode;
  if (changed) { resetPage(); build(); }
  repaint();
  // « FINI » and « ERREUR » stay on the chip until this training's screen was opened: it is, now
  if (mode === 'run' && s.seen === false && !document.hidden) call(a.seen, id);
  if (S.again) { S.again = false; refresh(); }
}

function repaint() {
  if (!S.shown || !V) return;
  if (S.mode === 'list') paintList();
  else if (S.cur && V.mode === S.mode) (S.mode === 'draft' ? paintDraft : paintRun)(S.cur);
}

// ── the page ──────────────────────────────────────────────────────────
function build() {
  if (!host) return;
  hideTip();
  stopMedia();
  V?.chart?.destroy();
  host.textContent = '';
  if (S.mode === 'list') V = buildList();
  else if (S.mode === 'draft') V = buildDraft();
  else V = buildRun();
  host.append(V.root);
  markShown();
  repaint();
}

/**
 * Which training the screen shows, said on #view-train (data-training) and on the bus (« train:shown »): the
 * suggestion card of THAT training is not drawn over the screen (greenlight.js) — its banner and its foot already
 * carry the same decision.
 */
let shownId = '';
function markShown() {
  const id = S.shown && S.mode !== 'list' && S.id ? S.id : '';
  if (host) host.dataset.training = id;
  if (id === shownId) return;
  shownId = id;
  emit('train:shown', { id: id || null });
}

/**
 * Leaving the page of a draft: if it is still the empty « Nouveau LoRA » (no name, no image, never changed), it does
 * not stay in the list — the main process checks it and removes it for good (never one with anything in it).
 */
function leaveDraft(id) {
  const a = api();
  if (!a || !id || typeof a.remove !== 'function') return;
  const s = S.cur && S.cur.id === id ? S.cur : S.rows.find((r) => r.id === id);
  if (!s || s.state !== 'pret' || (s.name || '').trim() || (s.trigger || '').trim() || (s.images && s.images.length) || (s.dataset && s.dataset.count) || s.importing) return;
  // something typed and not sent yet (the name is sent after 400 ms): kept
  const typed = (w) => { const f = w && (w.matches?.('input, textarea') ? w : w.querySelector?.('input, textarea')); return !!(f && f.value.trim()); };
  if (V && V.mode === 'draft' && (typed(V.name) || typed(V.trigger))) return;
  call(a.remove, id, { ifEmpty: true }).then((r) => { if (r && r.discarded) loadRows(); });
}

function crumbs(withList) {
  const label = hooks.backLabel?.() || null;
  const back = el('button', { class: 'tr-link', type: 'button', onclick: goBack }, label ? T('train.back', { name: label }) : T('train.home'));
  const list = withList ? el('button', { class: 'tr-link', type: 'button', onclick: () => openTrain(null) }, T('train.crumb')) : null;
  return [back, list];
}

// ── drop: images or a folder ──────────────────────────────────────────
function droppedPaths(e) {
  const out = [];
  for (const f of e.dataTransfer?.files || []) {
    const p = window.mia?.media?.pathFor?.(f);
    if (p) out.push(p);
  }
  return out;
}

function installDrop() {
  let depth = 0;
  const can = () => S.shown && api() && (S.mode === 'list' || (S.mode === 'draft' && S.cur));
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  host.addEventListener('dragenter', (e) => { if (hasFiles(e) && can()) { depth++; host.classList.add('tr-dropping'); } });
  host.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) host.classList.remove('tr-dropping'); });
  host.addEventListener('dragover', (e) => {
    if (!hasFiles(e) || !can()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  host.addEventListener('drop', async (e) => {
    depth = 0;
    host.classList.remove('tr-dropping');
    if (!hasFiles(e) || !can()) return;
    e.preventDefault();
    const paths = droppedPaths(e);
    if (paths.length) addPaths(paths);
  });
}

/** Images or folders: into the open draft, or into a new one made for them (from the list). */
async function addPaths(paths) {
  const a = api();
  if (!a || !paths.length) return;
  let id = S.mode === 'draft' ? S.id : null;
  if (!id) {
    const made = await call(a.create, {});
    if (bad(made)) { fail(made); return; }
    id = made.id || made.trainingId;
    await loadRows();
    S.id = id;
    S.mode = 'draft';
    S.cur = null;
    resetPage();
    build();
  }
  const r = await call(a.addImages, id, paths);
  if (bad(r)) fail(r);
  refresh();
}

// ══════════════════════════════════════════════════════════════════════
// the list
// ══════════════════════════════════════════════════════════════════════
function buildList() {
  const make = button({ label: T('train.new'), kind: 'primary', size: 'sm', onClick: newDraft });
  const head = el('div', { class: 'tr-head' }, crumbs(false), el('h1', { class: 'tr-title' }, T('train.title')), el('span', { class: 'tr-grow' }), make);
  const rows = el('div', { class: 'tr-rows' });
  const empty = el('div', { class: 'tr-empty-list' }, el('p', {}, T('list.empty')));
  const drop = el('div', { class: 'tr-drop', 'aria-hidden': 'true' }, el('span', {}, T('list.drop')));
  const root = el('div', { class: 'tr tr-list' }, head, rows, empty, drop);
  return { mode: 'list', root, rows, empty, nodes: new Map(), order: '' };
}

async function newDraft() {
  const a = api();
  if (!a) { toast(T('err.noTrain'), { kind: 'error' }); return; }
  const made = await call(a.create, {});
  if (bad(made)) { fail(made); return; }
  await loadRows();
  openTrain(made.id || made.trainingId);
}

function rowSig(s) {
  return [s.name, s.base, s.kind, X.rowState(L, s), s.seen, s.missing, s.sizeMB, s.at, s.thumb, X.isActive(s)].join('|');
}

function buildRow(s) {
  const thumb = el('span', { class: 'tr-row-thumb' });
  if (s.thumb) thumb.append(el('img', { src: absUrl(s.thumb), alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' }));
  else thumb.append(el('span', { class: 'tr-row-none' }, '—'));
  const unseen = s.seen === false && (s.state === 'fini' || s.state === 'erreur' || s.state === 'interrompu');
  const dot = el('span', { class: ['tr-dot', unseen && 'on', unseen && s.state !== 'fini' && 'err'] });
  if (unseen) dot.dataset.tip = T('row.unseen');
  const st = kicker(X.rowState(L, s), `tr-row-state${s.state === 'erreur' ? ' err' : ''}${X.isActive(s) ? ' live' : ''}`);
  const row = el('div', { class: ['tr-row', s.missing && 'missing'], role: 'button', tabindex: '0', dataset: { id: s.id } },
    thumb, dot,
    el('span', { class: 'tr-row-name' }, nameOf(s)),
    kicker(baseText(s.base), 'tr-row-base'),
    kicker(T(`kind.${s.kind || 'character'}`), 'tr-row-kind'),
    st);
  if (s.missing) {
    const locate = el('button', { class: 'btn xs tr-row-locate', type: 'button' }, T('row.locate'));
    locate.addEventListener('click', (e) => { e.stopPropagation(); locateFolder(s); });
    row.append(locate);
  } else {
    row.append(kicker(s.sizeMB != null ? X.size(L, s.sizeMB) : '', 'tr-row-size'), kicker(X.dateShort(L, s.at), 'tr-row-date'));
  }
  const open = () => { if (!s.missing) openTrain(s.id); };
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); rowMenu(s, { x: e.clientX, y: e.clientY }); });
  return row;
}

function paintList() {
  if (!V || V.mode !== 'list') return;
  const rows = S.rows;
  V.empty.hidden = rows.length > 0;
  V.rows.hidden = !rows.length;
  const order = rows.map((r) => r.id).join('|');
  if (order !== V.order) { V.rows.textContent = ''; V.nodes.clear(); V.order = order; }
  for (const s of rows) {
    const sig = rowSig(s);
    const had = V.nodes.get(s.id);
    if (had && had.sig === sig) continue;
    const node = buildRow(s);
    if (had) had.node.replaceWith(node); else V.rows.append(node);
    V.nodes.set(s.id, { node, sig });
  }
}

function rowMenu(s, at) {
  const a = api();
  if (!a) return;
  openMenu([
    { label: T('menu.open'), icon: 'folder', disabled: !!s.missing, action: async () => { const r = await call(a.reveal, s.id); if (bad(r)) fail(r); } },
    { label: T('menu.duplicate'), icon: 'duplicate', disabled: !!s.missing, action: async () => {
      const r = await call(a.create, { from: s.id });
      if (bad(r)) { fail(r); return; }
      await loadRows();
      openTrain(r.id || r.trainingId);
    } },
    'sep',
    { label: T('menu.trash'), icon: 'trash', danger: true, disabled: X.isActive(s), action: () => trashTraining(s) }
  ], at);
}

async function trashTraining(s) {
  const a = api();
  const ok = await confirm({
    title: T('trash.title', { name: nameOf(s), size: s.sizeMB != null ? X.size(L, s.sizeMB, false) : '—' }),
    body: T('trash.body'), ok: T('trash.ok'), danger: true
  });
  if (!ok) return false;
  const r = await call(a.remove, s.id);
  if (bad(r)) { fail(r); return false; }
  if (S.id === s.id) openTrain(null); else loadRows();
  return true;
}

async function locateFolder(s) {
  const dir = await call(window.mia.media.pickFolder, { title: T('row.locate') });
  if (!dir || typeof dir !== 'string') return;
  const r = await call(api().locate, s.id, dir);
  if (bad(r)) fail(r);
  loadRows();
}

// ══════════════════════════════════════════════════════════════════════
// the draft
// ══════════════════════════════════════════════════════════════════════
/** A choice among a few, drawn like the house segmented control, with a second line and greyed options (the models). */
function choice({ onPick }) {
  const root = el('div', { class: 'tr-choice', role: 'radiogroup' });
  let sig = '';
  root.set = (options, value) => {
    const next = JSON.stringify([options, value]);
    if (next === sig) return;
    sig = next;
    root.textContent = '';
    for (const o of options) {
      const b = el('button', { class: ['tr-choice-opt', o.value === value && 'on', o.off && 'off'], type: 'button', role: 'radio', 'aria-checked': o.value === value ? 'true' : 'false', 'aria-disabled': o.off ? 'true' : 'false' },
        el('span', { class: 'tr-choice-name' }, o.label), o.sub ? el('span', { class: 'tr-choice-sub' }, o.sub) : null);
      if (o.tip) b.dataset.tip = o.tip;
      b.addEventListener('click', () => { if (!o.off && o.value !== value) onPick(o.value); });
      root.append(b);
    }
  };
  return root;
}

/** Boxes to tick, ours (the image sizes). */
function checks({ onChange }) {
  const root = el('div', { class: 'tr-checks' });
  let sig = '';
  root.set = (options, values) => {
    const next = JSON.stringify([options, values]);
    if (next === sig) return;
    sig = next;
    root.textContent = '';
    const onSet = new Set(values);
    for (const o of options) {
      const b = el('button', { class: ['tr-check', onSet.has(o.value) && 'on'], type: 'button', role: 'checkbox', 'aria-checked': onSet.has(o.value) ? 'true' : 'false' },
        el('span', { class: 'tr-check-box', html: onSet.has(o.value) ? icon('check', 10) : '' }), el('span', {}, o.label));
      b.addEventListener('click', () => {
        const now = new Set(onSet);
        if (now.has(o.value)) now.delete(o.value); else now.add(o.value);
        if (!now.size) return;                               // one size at least
        onChange(options.filter((x) => now.has(x.value)).map((x) => x.value));
      });
      root.append(b);
    }
  };
  return root;
}

const row = (label, ...content) => el('div', { class: 'tr-f' }, kicker(label, 'tr-f-label'), el('div', { class: 'tr-f-ctl' }, ...content));
const sizeKey = (r) => (Array.isArray(r) ? r.join('×') : String(r));
const sizeLabel = (r) => (Array.isArray(r) ? `${X.int(L, r[0])} × ${X.int(L, r[1])}` : `${X.int(L, r)} px`);
const focusIn = (node) => !!node && (node === document.activeElement || node.contains(document.activeElement));

/** One change of the draft: sent, and the answer (the whole state, without the set) is drawn. */
async function patch(p) {
  const a = api();
  if (!a || !S.id) return;
  S.startErr = '';
  const id = S.id;
  const r = await call(a.update, id, p);
  if (id !== S.id) return;
  if (bad(r)) { fail(r); refresh(); return; }
  if (S.cur) S.cur = { ...r, images: S.cur.images };
  // « Mot déclencheur seul », another model (other « too small » images): the set changed too
  if ('triggerOnly' in p || 'base' in p || 'trigger' in p) refresh(); else repaint();
}

function buildDraft() {
  const v = { mode: 'draft' };
  // ── left: the settings
  v.name = textField({ size: 'md', maxLength: 80, onInput: debounce((x) => patch({ name: x }), 400), onChange: (x) => patch({ name: x }) });
  v.model = choice({ onPick: (id) => patch({ base: id }) });
  v.kind = segmented({ size: 'sm', options: ['character', 'place', 'style'].map((k) => ({ value: k, label: T(`kind.${k}`) })), onChange: (k) => patch({ kind: k }) });
  v.trigger = textField({ size: 'md', mono: true, maxLength: 80, onInput: debounce((x) => patch({ trigger: x }), 400), onChange: (x) => patch({ trigger: x }) });
  v.triggerHint = el('p', { class: 'tr-hint' }, T('f.triggerHint'));
  v.length = segmented({ size: 'sm', options: ['short', 'normal', 'long'].map((k) => ({ value: k, label: T(`f.${k}`) })), onChange: (k) => patch({ length: k }) });
  v.steps = numberField({ min: 1, max: 100000, step: 1, width: 96, onChange: (n) => patch({ steps: n }) });
  v.estimate = kicker('', 'tr-estimate');
  v.prompt = textField({ multiline: true, rows: 2, maxRows: 5, onChange: (x) => setPrompt(0, x) });
  v.sampleEvery = el('p', { class: 'tr-hint' });
  // ── advanced, folded
  v.rank = segmented({ size: 'sm', options: [16, 32, 64].map((n) => ({ value: n, label: String(n) })), onChange: (n) => patch({ settings: { rank: n } }) });
  v.lr = textField({ mono: true, onChange: (x) => { const n = parseFloat(String(x).replace(',', '.')); if (Number.isFinite(n) && n > 0) patch({ settings: { lr: n } }); else repaint(); } });
  v.sizes = checks({ onChange: (keys) => {
    const all = baseOf(S.cur?.base)?.defaults?.resolutions || [];
    patch({ settings: { resolutions: all.filter((r) => keys.includes(sizeKey(r))) } });
  } });
  v.saveEvery = segmented({ size: 'sm', options: [100, 250, 500].map((n) => ({ value: n, label: X.int(L, n) })), onChange: (n) => patch({ settings: { saveEvery: n } }) });
  v.sampleEveryN = segmented({ size: 'sm', options: [...[250, 500, 1000].map((n) => ({ value: n, label: X.int(L, n) })), { value: 0, label: T('f.none') }], onChange: (n) => patch({ settings: { sampleEvery: n } }) });
  v.more = el('div', { class: 'tr-more' });
  v.advBody = el('div', { class: 'tr-adv-body', hidden: !S.advOpen },
    row(T('f.rank'), v.rank), row(T('f.lr'), v.lr), row(T('f.sizes'), v.sizes), row(T('f.saveEvery'), v.saveEvery), row(T('f.sampleEveryN'), v.sampleEveryN), row(T('f.morePrompts'), v.more));
  v.advBody.classList.add('tr-plain-labels');
  v.advToggle = el('button', { class: ['tr-adv', S.advOpen && 'open'], type: 'button', 'aria-expanded': String(S.advOpen) }, el('span', { class: 'tr-adv-chev', html: icon('chevron-right', 12) }), T('f.advanced'));
  v.advToggle.addEventListener('click', () => {
    S.advOpen = !S.advOpen;
    v.advBody.hidden = !S.advOpen;
    v.advToggle.classList.toggle('open', S.advOpen);
    v.advToggle.setAttribute('aria-expanded', String(S.advOpen));
  });
  const form = el('div', { class: 'tr-form' },
    row(T('f.name'), v.name),
    row(T('f.model'), v.model),
    row(T('f.kind'), v.kind),
    row(T('f.trigger'), v.trigger, v.triggerHint),
    row(T('f.length'), v.length, el('div', { class: 'tr-steps' }, kicker(T('f.steps')), v.steps), v.estimate),
    row(T('f.prompt'), v.prompt, v.sampleEvery),
    v.advToggle, v.advBody);

  // ── right: the images and their captions
  v.count = el('span', { class: 'tr-set-count' });
  v.thumbs = el('div', { class: 'tr-thumbs' });
  v.empty = el('div', { class: 'tr-set-empty' }, el('p', {}, T('img.empty')));
  v.capName = el('span', { class: 'tr-cap-name' });
  v.capBy = kicker('', 'tr-cap-by');
  v.cap = textField({ multiline: true, rows: 2, maxRows: 4, onChange: (x) => saveCaption(x) });
  v.capBox = el('div', { class: 'tr-cap' }, el('div', { class: 'tr-cap-head' }, kicker(T('cap.title')), v.capName, el('span', { class: 'tr-grow' }), v.capBy), v.cap, el('p', { class: 'tr-hint' }, T('cap.help')));
  v.capNone = el('p', { class: 'tr-hint tr-cap-none' }, T('cap.pick'));
  v.notices = el('div', { class: 'tr-notices' });
  const set = el('div', { class: 'tr-set' },
    el('div', { class: 'tr-set-head' }, kicker(T('img.title')), el('span', { class: 'tr-grow' }), v.count),
    v.thumbs, v.empty, v.capBox, v.capNone, v.notices,
    el('div', { class: 'tr-drop', 'aria-hidden': 'true' }, el('span', {}, T('img.empty'))));

  // ── foot
  v.go = button({ label: T('go.start'), kind: 'shiny', onClick: startDraft });
  v.why = el('span', { class: 'tr-why' });
  v.del = button({ label: T('go.delete'), kind: 'ghost', size: 'sm', onClick: deleteDraft });
  const foot = el('div', { class: 'tr-foot' }, v.go, v.why, el('span', { class: 'tr-grow' }), v.del);

  v.title = el('h1', { class: 'tr-title' });
  v.by = kicker('', 'tr-by');
  v.prop = el('div', { class: 'tr-prop', hidden: true });
  const head = el('div', { class: 'tr-head' }, crumbs(true), v.title, el('span', { class: 'tr-grow' }), v.by);
  v.root = el('div', { class: 'tr tr-draft' }, head, v.prop, el('div', { class: 'tr-draft-grid' }, form, set), foot);
  v.thumbSig = '';
  v.noticeSig = '';
  v.moreSig = '';
  return v;
}

function setPrompt(index, text) {
  const list = [...((S.cur?.settings || {}).samplePrompts || [])];
  list[index] = text;
  patch({ settings: { samplePrompts: list.map((x) => String(x || '').trim()).filter(Boolean) } });
}

function paintProposal(v, s) {
  const p = s.proposal;
  const sig = p ? `${p.by}|${p.at}|${p.resume}|${s.step}` : '';
  if (v.propSig === sig) return;
  v.propSig = sig;
  v.prop.hidden = !p;
  v.prop.textContent = '';
  if (!p) return;
  const a = api();
  const who = String(p.by || '').toUpperCase();
  const text = p.resume ? T('prop.resume', { name: who, a: X.int(L, X.resumeStep(s) || s.step) }) : T('prop.start', { name: who });
  const decline = button({ label: T('prop.decline'), kind: 'ghost', size: 'sm', onClick: async () => { const r = await call(a.update, s.id, { proposal: null }); if (bad(r)) fail(r); refresh(); } });
  const go = button({ label: p.resume ? T('prop.goResume') : T('prop.go'), size: 'sm', onClick: async () => {
    const r = await call(a.start, s.id, { proposal: true });
    if (bad(r)) { S.startErr = (r && r.error) || T('err.unknown'); fail(r); }
    refresh();
  } });
  v.prop.append(kicker(text, 'tr-prop-text'), el('span', { class: 'tr-grow' }), decline, go);
}

function paintDraft(s) {
  const v = V;
  const base = baseOf(s.base);
  const st = s.settings || {};
  v.title.textContent = nameOf(s);
  const by = X.presenceLine(L, s, { now: Date.now() });
  v.by.textContent = by.join(' · ');
  paintProposal(v, s);

  if (!focusIn(v.name)) v.name.setValue(s.name || '');
  v.model.set((S.options?.bases || []).map((b) => ({
    value: b.id, label: X.baseLabel(L, S.options.bases, b.id), sub: T(`media.${b.media === 'video' ? 'video' : 'image'}`),
    off: !b.ready && b.id !== s.base, tip: b.ready ? '' : ((b.why && (b.why[L] || b.why.fr)) || '')
  })), s.base);
  v.kind.setValue(s.kind);
  if (!focusIn(v.trigger)) v.trigger.setValue(s.trigger || '');
  v.triggerHint.hidden = !!(s.trigger || '').trim();
  v.length.setValue(X.lengthOf(base?.lengths, s.steps));
  if (!focusIn(v.steps)) v.steps.setValue(s.steps);
  v.estimate.textContent = X.estimateText(L, s.estimate);
  if (!focusIn(v.prompt)) v.prompt.setValue((st.samplePrompts || [])[0] || '');
  v.sampleEvery.textContent = st.sampleEvery > 0 ? T('f.sampleEvery', { n: X.int(L, st.sampleEvery) }) : T('f.noSample');

  v.rank.setValue(st.rank);
  if (!focusIn(v.lr)) v.lr.setValue(st.lr != null ? String(st.lr).replace('.', L === 'fr' ? ',' : '.') : '');
  const allSizes = base?.defaults?.resolutions || st.resolutions || [];
  v.sizes.set(allSizes.map((r) => ({ value: sizeKey(r), label: sizeLabel(r) })), (st.resolutions || []).map(sizeKey));
  v.saveEvery.setValue(st.saveEvery);
  v.sampleEveryN.setValue(st.sampleEvery || 0);
  paintMorePrompts(v, st.samplePrompts || []);

  paintSet(v, s, base);

  // the start button: off, with the reason written at its right
  const ready = s.ready === true && !S.busy;
  v.go.setDisabled(!ready);
  let why = '';
  if (S.startErr) why = S.startErr;
  else if (s.ready === false) why = s.why || '';
  else if (s.estimate && s.estimate.seconds != null) why = T('go.estimate', { d: X.dur(s.estimate.seconds, { secs: s.estimate.seconds < 60 }).toUpperCase(), h: X.clock(L, Date.now() + s.estimate.seconds * 1000).toUpperCase() });
  v.why.textContent = why;
  v.why.classList.toggle('reason', !!S.startErr || s.ready === false);
  v.why.classList.toggle('kicker', !S.startErr && s.ready !== false);
}

function paintMorePrompts(v, prompts) {
  const extra = prompts.slice(1);
  const sig = JSON.stringify(extra);
  if (sig === v.moreSig || focusIn(v.more)) return;
  v.moreSig = sig;
  v.more.textContent = '';
  extra.forEach((p, i) => {
    v.more.append(textField({ value: p, multiline: true, rows: 1, maxRows: 3, onChange: (x) => setPrompt(i + 1, x) }));
  });
  if (prompts.length < 4) {
    const add = el('button', { class: 'tr-link tr-add-prompt', type: 'button' }, `+ ${T('f.addPrompt')}`);
    add.addEventListener('click', () => {
      const f = textField({ multiline: true, rows: 1, maxRows: 3, onChange: (x) => setPrompt(prompts.length, x) });
      add.replaceWith(f);
      f.focus();
    });
    v.more.append(add);
  }
}

function paintSet(v, s, base) {
  const imgs = Array.isArray(s.images) ? s.images : [];
  const d = s.dataset || {};
  v.count.textContent = s.importing ? T('img.import', { n: X.int(L, s.importing.n), total: X.int(L, s.importing.total) })
    : `${TN('img.count', d.count || 0)} · ${TN('img.caps', d.captions || 0)}`;
  v.count.classList.toggle('kicker', !!s.importing);
  if (S.onlySmall && !imgs.some((i) => i.small)) S.onlySmall = false;
  if (S.pick && !imgs.some((i) => i.original === S.pick)) S.pick = null;
  const shown = S.onlySmall ? imgs.filter((i) => i.small) : imgs;
  v.empty.hidden = imgs.length > 0;
  v.thumbs.hidden = !imgs.length;

  const sig = JSON.stringify([shown.map((i) => [i.original, i.file, !!i.captionBy, i.small]), S.pick, !!s.importing]);
  if (sig !== v.thumbSig) {
    v.thumbSig = sig;
    const top = v.thumbs.scrollTop;
    v.thumbs.textContent = '';
    for (const im of shown) v.thumbs.append(buildThumb(im, s));
    v.thumbs.scrollTop = top;
  }

  // the caption of the picked image
  const cur = imgs.find((i) => i.original === S.pick) || null;
  v.capBox.hidden = !cur;
  v.capNone.hidden = !!cur || !imgs.length;
  if (cur) {
    v.capName.textContent = cur.original;
    const by = cur.captionBy && !['user', 'file', 'trigger'].includes(cur.captionBy) ? T('cap.by', { name: String(cur.captionBy).toUpperCase() }) : '';
    v.capBy.textContent = by;
    if (v.capFor !== cur.original || !focusIn(v.cap)) v.cap.setValue(cur.caption || '');
    v.capFor = cur.original;
    v.cap.setDisabled(!!s.importing);
  }

  // what Mia says about the set
  const notices = X.draftNotices(L, s, { minSide: base?.minSide, minImages: S.options?.minImages, adviseImages: S.options?.adviseImages });
  const nsig = JSON.stringify([notices, S.onlySmall, !!s.importing]);
  if (nsig !== v.noticeSig) {
    v.noticeSig = nsig;
    v.notices.textContent = '';
    for (const n of notices) {
      const line = el('div', { class: `tr-notice n-${n.id}` });
      if (n.id === 'small') {
        const filter = el('button', { class: ['tr-link', S.onlySmall && 'on'], type: 'button' }, S.onlySmall ? `${n.text} · ${T('n.showAll')}` : n.text);
        filter.addEventListener('click', () => { S.onlySmall = !S.onlySmall; repaint(); });
        line.append(filter);
      } else line.append(el('span', {}, n.text));
      if (n.action) {
        const b = el('button', { class: 'btn xs', type: 'button' }, n.action.label);
        if (s.importing) b.classList.add('is-disabled');
        b.addEventListener('click', () => noticeAction(n.action.id));
        line.append(b);
      }
      v.notices.append(line);
    }
  }
}

function buildThumb(im, s) {
  const node = el('div', { class: ['tr-thumb', im.original === S.pick && 'on', im.small && 'small'], role: 'button', tabindex: '0', dataset: { name: im.original } },
    el('img', { src: absUrl(im.file), alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' }));
  if (!im.captionBy) node.append(el('span', { class: 'tr-thumb-dot', dataset: { tip: T('img.noCaption') } }));
  if (im.small) node.append(el('span', { class: 'tr-thumb-small', dataset: { tip: T('img.small', { w: X.int(L, im.w), h: X.int(L, im.h) }) } }));
  if (!s.importing) {
    const x = el('button', { class: 'tr-thumb-x', type: 'button', html: icon('close', 10), 'aria-label': T('img.remove'), dataset: { tip: T('img.remove') } });
    x.addEventListener('click', async (e) => {
      e.stopPropagation();
      hideTip();
      const r = await call(api().removeImage, S.id, im.original);
      if (bad(r)) fail(r);
      refresh();
    });
    node.append(x);
  }
  node.addEventListener('click', () => { S.pick = im.original; repaint(); });
  node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); S.pick = im.original; repaint(); } });
  node.addEventListener('dblclick', () => emit('viewer:open', { url: absUrl(im.file), kind: 'image', name: im.original }));
  return node;
}

async function saveCaption(text) {
  if (!S.pick || !S.id) return;
  S.startErr = '';
  const r = await call(api().setCaption, S.id, S.pick, text);
  if (bad(r)) fail(r);
  refresh();
}

async function noticeAction(id) {
  if (id === 'triggerOnly') { patch({ triggerOnly: true }); return; }
  if (id === 'removeSmall') {
    const names = (S.cur?.images || []).filter((i) => i.small).map((i) => i.original);
    if (!names.length) return;
    const r = await call(api().removeImage, S.id, names);
    if (bad(r)) fail(r);
    S.onlySmall = false;
    refresh();
  }
}

async function startDraft() {
  const a = api();
  if (!a || !S.id || S.busy) return;
  // what is being typed is part of the draft: its field commits first
  if (isTyping()) document.activeElement.blur();
  S.busy = true;
  S.startErr = '';
  repaint();
  const r = await call(a.start, S.id, {});
  S.busy = false;
  if (bad(r)) S.startErr = (r && r.error) || T('err.unknown');
  refresh();
}

async function deleteDraft() {
  const s = S.cur;
  if (!s) return;
  const ok = await confirm({ title: T('go.deleteTitle', { name: nameOf(s) }), body: T('go.deleteBody'), ok: T('go.deleteOk'), danger: true });
  if (!ok) return;
  const r = await call(api().remove, s.id);
  if (bad(r)) { fail(r); return; }
  openTrain(null);
}

// ══════════════════════════════════════════════════════════════════════
// the instrument
// ══════════════════════════════════════════════════════════════════════
function buildRun() {
  const v = { mode: 'run' };
  v.title = el('h1', { class: 'tr-title' });
  v.meta = el('span', { class: 'kicker tr-meta' });
  v.presence = kicker('', 'tr-by');
  const head = el('div', { class: 'tr-head' }, crumbs(true), v.title, v.meta, el('span', { class: 'tr-grow' }), v.presence);
  v.prop = el('div', { class: 'tr-prop', hidden: true });

  // B: the 2 px bar, the only thing that moves on its own
  v.barFill = el('i');
  v.bar = el('div', { class: 'tr-bar' }, v.barFill);
  // C: the state, in one line
  v.cDot = el('span', { class: 'tr-c-dot' });
  v.cParts = el('span', { class: 'tr-c-parts' });
  v.cSub = el('p', { class: 'tr-c-sub', hidden: true });
  v.c = el('div', { class: 'tr-c' }, el('div', { class: 'tr-c-line' }, v.cDot, v.cParts), v.cSub);

  // loss
  v.lossRight = kicker('', 'tr-cell-right');
  v.canvas = el('canvas', { class: 'tr-chart' });
  v.lossHover = null;
  const loss = el('section', { class: 'tr-cell tr-loss' },
    el('div', { class: 'tr-cell-head' }, kicker(T('p.loss')), el('span', { class: 'tr-grow' }), v.lossRight),
    el('div', { class: 'tr-chart-box' }, v.canvas),
    el('p', { class: 'tr-hint' }, T('p.lossHelp')));

  // samples
  v.samplesRight = kicker('', 'tr-cell-right');
  v.done = el('div', { class: 'tr-done', hidden: true });
  v.big = el('div', { class: 'tr-big' });
  v.bigCap = el('p', { class: 'tr-big-cap' });
  v.tiles = el('div', { class: 'tr-tiles' });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => fitTiles(v)).observe(v.tiles);
  // the wheel moves a strip that scrolls by one tile
  v.tiles.addEventListener('wheel', (e) => {
    if (!v.tiles.classList.contains('scroll') || Math.abs(e.deltaX) > Math.abs(e.deltaY) || !e.deltaY) return;
    e.preventDefault();
    const first = v.tiles.firstElementChild;
    v.tiles.scrollBy({ left: Math.sign(e.deltaY) * ((first ? first.getBoundingClientRect().width : TILE.max) + TILE.gap) });
  }, { passive: false });
  const samples = el('section', { class: 'tr-cell tr-samples' },
    el('div', { class: 'tr-cell-head' }, kicker(T('p.samples')), el('span', { class: 'tr-grow' }), v.samplesRight),
    v.done, v.big, v.bigCap, v.tiles);

  // numbers
  const stat = (key) => {
    const val = el('span', { class: 'kicker tr-stat-v' });
    const line = el('div', { class: 'tr-stat' }, kicker(T(key), 'tr-stat-k'), val);
    return { line, val };
  };
  v.pace = stat('p.pace');
  v.gpu = stat('p.gpu');
  v.gpuFill = el('i');
  v.gpuGauge = el('span', { class: 'tr-gauge', hidden: true }, v.gpuFill);
  v.gpu.line.append(v.gpuGauge);
  v.ram = stat('p.ram');
  v.elapsed = stat('p.elapsed');
  const stats = el('section', { class: 'tr-cell tr-stats' }, v.pace.line, v.gpu.line, v.ram.line, v.elapsed.line);

  // checkpoints
  v.cksRight = kicker('', 'tr-cell-right');
  v.cks = el('div', { class: 'tr-cks' });
  const cks = el('section', { class: 'tr-cell tr-ckcell' },
    el('div', { class: 'tr-cell-head' }, kicker(T('p.checkpoints')), el('span', { class: 'tr-grow' }), v.cksRight), v.cks);

  // D: events
  v.filter = segmented({ size: 'sm', options: [{ value: 'all', label: T('p.all') }, { value: 'mia', label: T('p.mia') }], value: 'all', onChange: (f) => { S.filter = f; v.evSig = ''; paintEvents(v, S.cur); } });
  v.events = el('div', { class: 'tr-ev-flow' });
  const events = el('section', { class: 'tr-events' }, el('div', { class: 'tr-ev-head' }, kicker(T('p.events')), v.filter), v.events);

  // E: what can be done
  v.acts = el('div', { class: 'tr-acts-left' });
  v.waiting = el('div', { class: 'tr-acts-mid' });
  // the tool log has one button: this one, unless the state puts « Voir le journal de l’outil » among its own (erreur)
  v.logBtn = button({ label: T('b.log'), kind: 'ghost', size: 'sm', onClick: () => (S.logOpen ? closeLog() : openLog()) });
  v.logBtn.classList.add('tr-log-btn');
  const dirBtn = button({ label: T('b.folder'), kind: 'ghost', size: 'sm', icon: 'folder', onClick: async () => { const r = await call(api().reveal, S.id); if (bad(r)) fail(r); } });
  const actions = el('div', { class: 'tr-actions' }, v.acts, v.waiting, el('span', { class: 'tr-grow' }), v.logBtn, dirBtn);

  // the tool log, a drawer from the bottom; its last line stays in sight while nobody scrolled up
  v.logBody = el('pre', { class: 'tr-log-body' });
  v.logStuck = true;
  v.logBody.addEventListener('scroll', () => { v.logStuck = v.logBody.scrollTop + v.logBody.clientHeight >= v.logBody.scrollHeight - 8; });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { if (v.logStuck) v.logBody.scrollTop = v.logBody.scrollHeight; }).observe(v.logBody);
  v.log = el('div', { class: 'tr-log', hidden: true },
    el('div', { class: 'tr-log-head' }, kicker(T('b.log')), el('span', { class: 'tr-grow' }), button({ label: T('b.closeLog'), kind: 'ghost', size: 'xs', onClick: closeLog })),
    v.logBody);

  v.grid = el('div', { class: 'tr-grid' }, loss, samples, stats, cks);
  v.root = el('div', { class: 'tr tr-run' }, head, v.prop, v.bar, v.c, v.grid, events, actions, v.log);

  v.chart = createChart(v.canvas, {
    fmt: (n) => X.int(L, n),
    fmtLoss: (n) => X.dec(L, n, 3),
    onHover: (p) => { v.lossHover = p; paintLossHead(v, S.cur); },
    onPickSample: (step) => pickSample(step, 1)
  });
  Object.assign(v, { tileSig: '', bigSig: '', ckSig: '', evSig: '', actSig: '', filterSig: '', doneSig: '', propSig: undefined });
  return v;
}

function paintLossHead(v, s) {
  if (!s) return;
  const p = v.lossHover;
  if (p) {
    v.lossRight.textContent = p.t ? T('p.hover', { a: X.int(L, p.s), v: X.dec(L, p.loss, 3), h: X.clock(L, p.t).toUpperCase() })
      : T('p.hoverNoTime', { a: X.int(L, p.s), v: X.dec(L, p.loss, 3) });
  } else v.lossRight.textContent = s.loss && s.loss.mean100 != null ? T('p.mean', { v: X.dec(L, s.loss.mean100, 3) }) : '';
}

function paintRun(s) {
  const v = V;
  const now = Date.now();
  const base = baseOf(s.base);
  // A
  v.title.textContent = nameOf(s);
  v.meta.textContent = '';
  v.meta.append(`${baseText(s.base)} · ${T(`kind.${s.kind || 'character'}`)} · `, el('span', { class: 'tr-trigger' }, L === 'fr' ? `« ${s.trigger} »` : `“${s.trigger}”`), ` · ${TN('a.images', s.images || 0)}`);
  v.presence.textContent = X.presenceLine(L, s, { now }).join(' · ');
  paintProposal(v, s);

  // B and C
  const measured = { ...(s.measured || {}) };
  if (!measured.sampleSec && base?.estimate?.sampleSec) measured.sampleSec = base.estimate.sampleSec;
  const line = X.statusLine(L, { ...s, measured }, { now, loadGB: base?.loadGB, freeGB: S.options?.disk?.freeGB });
  v.bar.className = `tr-bar b-${line.bar}`;
  v.barFill.style.transform = line.bar === 'indeterminate' ? '' : `scaleX(${line.bar === 'none' ? 0 : line.progress})`;
  v.c.classList.toggle('err', line.error);
  v.cDot.className = `tr-c-dot${line.error ? ' err' : X.isActive(s) && s.state !== 'attente' && s.state !== 'pause' ? ' live' : ''}`;
  v.cParts.textContent = '';
  line.parts.forEach((p, i) => v.cParts.append(el('span', { class: ['kicker', 'tr-c-part', i === 0 && 'first'] }, p)));
  v.cSub.hidden = !line.sub;
  v.cSub.textContent = line.sub || '';

  // the loss
  // the accent line is the step being computed: none once the training is over
  // …and the accent only while something computes (da.md): grey in a pause, an error, a stop
  v.chart.set({ points: s.curve || [], steps: s.steps, step: s.state === 'fini' ? 0 : s.step, live: X.computing(s), checkpoints: (s.checkpoints || []).map((c) => c.step), samples: [...new Set((s.samples || []).map((x) => x.step))] });
  paintLossHead(v, s);

  paintSamples(v, s);
  paintStats(s);
  paintCheckpoints(v, s);
  paintEvents(v, s);
  paintActions(v, s);
}

// ── samples ───────────────────────────────────────────────────────────
function doneSamples(s) {
  return [...(s.samples || [])].sort((a, b) => a.step - b.step || (a.i || 1) - (b.i || 1));
}

function shownSample(s) {
  const list = doneSamples(s);
  if (!list.length) return null;
  if (S.sample) {
    const hit = list.find((x) => x.step === S.sample.step && (x.i || 1) === S.sample.i);
    if (hit) return hit;
    S.sample = null;
  }
  return list[list.length - 1];
}

function pickSample(step, i = 1) {
  const s = S.cur;
  if (!s) return;
  const list = doneSamples(s);
  const hit = list.find((x) => x.step === step && (x.i || 1) === i) || list.find((x) => x.step === step);
  if (!hit) return;
  const last = list[list.length - 1];
  S.sample = hit === last ? null : { step: hit.step, i: hit.i || 1 };      // back on the last one: follow the next ones again
  S.fresh.delete(hit.step);
  if (!S.sample) S.fresh.clear();
  paintSamples(V, s);
}

function stepSample(dir) {
  const s = S.cur;
  if (!s) return false;
  const list = doneSamples(s);
  const cur = shownSample(s);
  const k = list.indexOf(cur) + dir;
  if (k < 0 || k >= list.length) return false;
  pickSample(list[k].step, list[k].i || 1);
  return true;
}

/** Stop what plays: the big sample only (it is being replaced), or every video of the page (it is being left). */
function stopMedia(all = true) {
  try { V?.player?.destroy?.(); } catch { /* already gone */ }
  if (V) V.player = null;
  for (const vid of host?.querySelectorAll(all ? 'video' : '.tr-big > video') || []) { try { vid.pause(); vid.removeAttribute('src'); vid.load(); } catch { /* detached */ } }
}

/** « Rosa est dans Mes LoRA · LTX 2.5 · mot déclencheur « rsa woman » » — the trigger word, quotes included, never
 *  cut over two lines: it is the thing to copy. → nodes for el() */
function doneText(s) {
  const MARK = '\u0001';
  const text = T('done.filed', { name: nameOf(s), base: baseText(s.base), trigger: MARK });
  const m = /(«\s?|“)\u0001(\s?»|”)/.exec(text);
  if (!m) return [text.replace(MARK, s.trigger || '')];
  return [text.slice(0, m.index), el('span', { class: 'tr-trigger tr-nowrap' }, m[0].replace(MARK, s.trigger || '')), text.slice(m.index + m[0].length)];
}

function paintSamples(v, s) {
  const slots = X.sampleSlots(s);
  const made = slots.filter((x) => x.files.length).length;
  v.samplesRight.textContent = slots.length ? `${X.int(L, made)} / ${X.int(L, slots.length)}` : '';

  // a sample that arrives takes the big place — unless another one is being looked at: then a dot on its tile
  const known = v.knownSteps || new Set();
  for (const x of slots) if (x.files.length && !known.has(x.step) && v.knownSteps && S.sample) S.fresh.add(x.step);
  v.knownSteps = new Set(slots.filter((x) => x.files.length).map((x) => x.step));

  // finished: where the LoRA is, at the top of the column — or why it could not be filed, with a way to try again
  const failed = s.state === 'fini' && !s.lora && s.filed && s.filed.ok === false ? s.filed : null;
  const dsig = s.state === 'fini' && s.lora ? `ok|${s.lora.file}|${s.name}|${s.trigger}`
    : failed ? `no|${failed.at}|${failed.code}|${s.name}` : '';
  if (dsig !== v.doneSig) {
    v.doneSig = dsig;
    v.done.hidden = !dsig;
    v.done.textContent = '';
    if (dsig && !failed) {
      v.done.append(el('p', { class: 'tr-done-text' }, ...doneText(s)),
        button({ label: T('done.try'), size: 'sm', onClick: () => hooks.tryLora?.({ name: nameOf(s), trigger: s.trigger, file: s.lora.file, base: s.base, family: baseOf(s.base)?.family || '', testName: T('done.testBoard', { name: nameOf(s) }) }) }));
    } else if (failed) {
      const reason = (failed.message && (failed.message[L] || failed.message.fr)) || T('err.unknown');
      const retry = button({ label: T('done.retry'), size: 'sm', onClick: async () => {
        retry.setDisabled?.(true);
        const r = await call(api().addToLoras, s.id, s.step);
        if (bad(r)) fail(r);
        refresh();
      } });
      retry.dataset.act = 'file';
      v.done.classList.add('err');
      v.done.append(el('p', { class: 'tr-done-text' }, T('done.notFiled', { name: nameOf(s), reason })), retry);
    }
    if (!failed) v.done.classList.remove('err');
  }

  const cur = shownSample(s);
  const bsig = cur ? `${cur.file}|${cur.at}` : `none|${slots.length}`;
  if (bsig !== v.bigSig) {
    const arrival = !!v.bigSig && !!cur;
    v.bigSig = bsig;
    stopMedia(false);
    v.big.textContent = '';
    if (!cur) {
      v.big.append(el('p', { class: 'tr-hint' }, slots.length ? T('p.noSample') : T('p.noSamplePlanned')));
    } else if (cur.kind === 'video') {
      const video = el('video', { src: absUrl(cur.file), muted: true, loop: true, playsinline: true, autoplay: true, preload: 'auto' });
      video.muted = true;
      v.big.append(video);
      // Mia's own player pill, never the browser's controls
      import('../nodes/player.js').then((m) => {
        if (!video.isConnected || !m.attachPlayer) return;
        v.player = m.attachPlayer(video, { mode: 'compact' });
        v.big.append(v.player.el);
      }).catch((err) => console.warn('[train] player', err?.message || err));
    } else {
      v.big.append(el('img', { src: `${absUrl(cur.file)}?v=${cur.at || 0}`, alt: '', draggable: 'false' }));
    }
    if (cur) {
      v.big.firstElementChild.addEventListener('dblclick', () => emit('viewer:open', { url: absUrl(cur.file), kind: cur.kind === 'video' ? 'video' : 'image', name: baseName(cur.file) }));
      if (arrival) v.big.firstElementChild.classList.add('tr-arrive');
    }
  }
  v.bigCap.textContent = '';
  if (cur) {
    v.bigCap.append(kicker(T('p.sampleCap', { a: X.int(L, cur.step) })));
    if (cur.prompt) v.bigCap.append(el('span', { class: 'tr-big-prompt' }, L === 'fr' ? `« ${cur.prompt} »` : `“${cur.prompt}”`));
  }

  const tsig = JSON.stringify([slots.map((x) => [x.step, x.files.map((f) => f.file), x.running, x.n, x.total]), cur && cur.step, [...S.fresh]]);
  if (tsig !== v.tileSig) {
    v.tileSig = tsig;
    const keep = v.tiles.scrollLeft;
    v.tiles.textContent = '';
    for (const x of slots) {
      const have = x.files.length > 0;
      const tile = el(have ? 'button' : 'div', { class: ['tr-tile', have && 'have', cur && cur.step === x.step && 'on', x.running && 'running'], ...(have ? { type: 'button' } : {}) });
      const first = x.files[0];
      if (have && first.kind !== 'video') tile.append(el('img', { src: `${absUrl(first.file)}?v=${first.at || 0}`, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' }));
      // a video shows its first frame (never played here: the big place plays the chosen one)
      if (have && first.kind === 'video') tile.append(el('video', { src: `${absUrl(first.file)}#t=0.1`, muted: true, playsinline: true, preload: 'metadata', tabindex: '-1' }));
      tile.append(kicker(X.int(L, x.step), 'tr-tile-step'));
      if (x.running) {
        const f = el('i');
        f.style.transform = `scaleX(${x.total > 0 ? Math.min(1, x.n / x.total) : 0})`;
        tile.append(el('span', { class: 'tr-tile-bar' }, f));
        if (x.total > 0) tile.append(kicker(`${X.int(L, x.n)} / ${X.int(L, x.total)}`, 'tr-tile-n'));
      }
      if (S.fresh.has(x.step)) tile.append(el('span', { class: 'tr-tile-dot', dataset: { tip: T('p.newSample') } }));
      if (have) tile.addEventListener('click', () => pickSample(x.step, 1));
      v.tiles.append(tile);
    }
    v.tiles.scrollLeft = keep;
    fitTiles(v, true);
  }
}

/**
 * The strip of sample tiles holds in its cell: the tiles narrow down to 52 px to all fit; past that, the strip
 * scrolls by whole tiles (as many as fit, sized so that none is cut at the edge), with the tile shown in big — or
 * the one being rendered — kept in sight.
 */
const TILE = { max: 68, min: 52, gap: 6 };
function fitTiles(v, follow = false) {
  const box = v && v.tiles;
  if (!box || !box.isConnected) return;
  const n = box.children.length;
  // the exact width, rounded down: clientWidth rounds, and half a pixel too many would show a scroll bar for nothing
  const W = Math.floor(box.getBoundingClientRect().width);
  if (!n || !W) return;
  const g = TILE.gap;
  let w = TILE.max;
  if (n * w + (n - 1) * g > W) {
    const all = (W - (n - 1) * g) / n;
    if (all >= TILE.min) w = all;
    else {
      const k = Math.max(1, Math.floor((W + g) / (TILE.min + g)));
      w = (W - (k - 1) * g) / k;
    }
  }
  w = Math.floor(w * 100) / 100;
  box.style.setProperty('--tw', `${w}px`);
  const scrolls = n * w + (n - 1) * g > W + 0.5;
  box.classList.toggle('scroll', scrolls);
  if (!scrolls) { box.scrollLeft = 0; return; }
  const step = w + g;
  const per = Math.max(1, Math.round((W + g) / step));
  let first = Math.round(box.scrollLeft / step);            // the first tile in sight: never a half tile at an edge
  const cur = follow ? (box.querySelector('.tr-tile.running') || box.querySelector('.tr-tile.on')) : null;
  if (cur) {
    const k = [...box.children].indexOf(cur);
    if (k < first) first = k;
    else if (k > first + per - 1) first = k - per + 1;
  }
  box.scrollLeft = Math.max(0, Math.min(n - per, first)) * step;
}

// ── numbers ───────────────────────────────────────────────────────────
function paintStats(s) {
  const v = V;
  if (!v || v.mode !== 'run') return;
  const now = Date.now();
  v.pace.val.textContent = s.pace && s.pace.sPerStep ? T('p.paceV', { x: X.dec(L, s.pace.sPerStep, s.pace.sPerStep < 1 ? 2 : 1) }) : '—';
  // the card's memory comes from the engine's own reading (the title bar's chip shows the same)
  const g = state.engine?.gpu || {};
  const used = s.memory?.vramGB ?? g.vramUsedGB;
  const total = g.vramTotalGB;
  const peak = s.memory?.peakVramGB;
  const gpu = [used != null && total ? T('p.gpuV', { u: X.dec(L, used, 1), t: X.int(L, total) }) : null, peak > 0 ? T('p.peak', { p: X.dec(L, peak, 1) }) : null].filter(Boolean);
  v.gpu.val.textContent = gpu.join(' · ') || '—';
  v.gpuGauge.hidden = !(used != null && total);
  if (used != null && total) v.gpuFill.style.transform = `scaleX(${Math.max(0, Math.min(1, used / total))})`;
  const m = s.memory || {};
  const loading = s.state === 'preparation' && s.phase === 'load';
  v.ram.val.textContent = m.ramFreeGB == null ? '—'
    : loading ? T('p.ramLoad', { n: X.dec(L, m.ramFreeGB, 1) })
      : T('p.ramV', { n: X.dec(L, m.ramFreeGB, 1), t: X.int(L, m.ramTotalGB || 0) });
  // red only in the training steps, under 2 GB for more than a minute — never while loading
  const low = s.state === 'entrainement' && m.ramFreeGB != null && m.ramFreeGB < 2;
  if (!low) S.ramLowAt = 0; else if (!S.ramLowAt) S.ramLowAt = now;
  v.ram.val.classList.toggle('err', low && now - S.ramLowAt > 60000);
  if (s.startedAt) {
    const end = s.endedAt && !X.isActive(s) ? s.endedAt : now;
    const sec = Math.max(0, (end - s.startedAt) / 1000);
    v.elapsed.val.textContent = T('p.elapsedV', { d: X.dur(sec, { secs: sec < 60 }).toUpperCase(), h: X.clock(L, s.startedAt).toUpperCase() });
  } else v.elapsed.val.textContent = '—';
}

// ── checkpoints ───────────────────────────────────────────────────────
function paintCheckpoints(v, s) {
  const list = [...(s.checkpoints || [])].sort((a, b) => b.step - a.step);
  v.cksRight.textContent = list.length ? X.int(L, list.length) : '';
  const sig = JSON.stringify(list.map((c) => [c.step, c.sizeMB, c.at, !!c.added]));
  if (sig === v.ckSig) return;
  v.ckSig = sig;
  v.cks.textContent = '';
  if (!list.length) { v.cks.append(el('p', { class: 'tr-hint' }, T('p.noCheckpoint'))); return; }
  const a = api();
  for (const c of list) {
    const text = [X.int(L, c.step), c.sizeMB != null ? X.size(L, c.sizeMB) : null, c.at ? T('p.ckAt', { h: X.clock(L, c.at).toUpperCase() }) : null].filter(Boolean).join(' · ');
    const line = el('div', { class: 'tr-ck' }, kicker(text, 'tr-ck-text'), el('span', { class: 'tr-grow' }));
    if (c.added) line.append(kicker(T('p.added'), 'tr-ck-added'));
    else {
      const add = el('button', { class: 'btn xs', type: 'button' }, T('p.add'));
      add.addEventListener('click', async () => {
        add.classList.add('is-disabled');
        const r = await call(a.addToLoras, s.id, c.step);
        if (bad(r)) fail(r);
        refresh();
      });
      line.append(add);
    }
    line.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const target = { abs: c.file };
      openMenu([
        { label: T('p.reveal'), icon: 'reveal', action: async () => { const r = await call(window.mia.shell.reveal, target); if (bad(r)) fail(r); } },
        { label: T('p.copy'), icon: 'copy', action: async () => { const r = await call(window.mia.shell.copyPath, target); if (bad(r)) fail(r); else toast(T('p.copied'), { kind: 'ok' }); } },
        ...(c.added ? ['sep', { label: T('p.unfile'), icon: 'trash', danger: true, action: async () => { const r = await call(a.removeFromLoras, s.id, c.step); if (bad(r)) fail(r); refresh(); } }] : [])
      ], { x: e.clientX, y: e.clientY });
    });
    v.cks.append(line);
  }
}

// ── events ────────────────────────────────────────────────────────────
function paintEvents(v, s) {
  if (!s) return;
  const lines = X.eventLines(L, s);
  const authors = X.eventAuthors(lines);
  const fsig = authors.join('|');
  if (fsig !== v.filterSig) {
    v.filterSig = fsig;
    v.filter.setOptions([{ value: 'all', label: T('p.all') }, { value: 'mia', label: T('p.mia') }, ...authors.map((n) => ({ value: `by:${n}`, label: n }))]);
    if (S.filter.startsWith('by:') && !authors.includes(S.filter.slice(3))) S.filter = 'all';
    v.filter.setValue(S.filter);
  }
  const shown = lines.filter((e) => (S.filter === 'all' ? true : S.filter === 'mia' ? (!e.by || e.by === 'user') : e.by === S.filter.slice(3)));
  const sig = `${S.filter}|${shown.length}|${shown.length ? shown[shown.length - 1].at : 0}`;
  if (sig === v.evSig) return;
  const first = !v.evSig;
  v.evSig = sig;
  const stuck = first || v.events.scrollTop + v.events.clientHeight >= v.events.scrollHeight - 6;
  v.events.textContent = '';
  if (!shown.length) v.events.append(el('span', { class: 'tr-hint' }, T('ev.none')));
  for (const e of shown) {
    v.events.append(el('span', { class: ['tr-ev', e.by && e.by !== 'user' && 'other'] }, e.at ? kicker(X.clock(L, e.at), 'tr-ev-t') : null, el('span', { class: 'tr-ev-x' }, e.text)));
  }
  // the newest line stays in sight, unless the wheel went up to read older ones
  if (stuck) v.events.scrollTop = v.events.scrollHeight;
}

// ── actions ───────────────────────────────────────────────────────────
function paintActions(v, s) {
  const acts = X.actions(L, s, { otherActive: otherActive(s.id) });
  const waiting = (s.state === 'entrainement' || s.state === 'essai') && !s.pending ? (+s.waitingJobs || 0) : 0;
  const sig = JSON.stringify([acts, waiting]);
  if (sig === v.actSig) return;
  v.actSig = sig;
  v.logBtn.hidden = acts.some((a) => a.id === 'log');
  v.acts.textContent = '';
  for (const a of acts) {
    const b = button({ label: a.label, size: 'sm', kind: a.danger ? 'danger' : undefined, disabled: !!a.disabled, onClick: () => doAction(a.id) });
    b.dataset.act = a.id;
    v.acts.append(b);
    if (a.disabled && a.why) v.acts.append(el('span', { class: 'tr-why reason' }, a.why));
    else if (a.hint) v.acts.append(el('span', { class: 'tr-hint' }, a.hint));
  }
  v.waiting.textContent = '';
  if (waiting) {
    v.waiting.append(el('span', { class: 'tr-waiting' }, TN('b.waiting', waiting)), button({ label: T('b.pass'), size: 'sm', onClick: () => doAction('pass') }));
  }
}

async function doAction(id) {
  const a = api();
  const s = S.cur;
  if (!a || !s) return;
  let r = null;
  if (id === 'log') { if (S.logOpen) closeLog(); else openLog(); return; }
  if (id === 'trash') { await trashTraining(s); return; }
  if (id === 'stop') {
    if (!(await confirmStop(s))) return;
    r = await call(a.control, s.id, 'stop');
  } else if (id === 'resume') r = await call(a.start, s.id, { resume: true });
  else r = await call(a.control, s.id, id);        // pause · pass · resumeNow · stopNow
  if (bad(r)) fail(r);
  refresh();
}

/** « Arrêter… » : what will happen, said before it happens. */
function confirmStop(s) {
  const name = nameOf(s);
  // nothing to save (waiting, preparing), a mute tool, or already stopped: an immediate stop
  const plain = s.state !== 'entrainement' && s.state !== 'essai';
  if (plain || s.silent) return confirm({ title: T('stop.titleNow', { name }), ok: T('stop.ok'), cancel: T('stop.keep'), danger: true });
  let body = T('stop.body');
  if (s.state === 'essai') {
    const base = baseOf(s.base);
    const measured = { ...(s.measured || {}) };
    if (!measured.sampleSec && base?.estimate?.sampleSec) measured.sampleSec = base.estimate.sampleSec;
    const left = X.sampleLeft({ ...s, measured });
    body += ` ${left != null && left >= 1 ? T('stop.sample', { d: X.dur(left) }) : T('stop.sampleNoTime')}`;
  }
  return confirm({ title: T('stop.title', { name, a: X.int(L, s.step) }), body, ok: T('stop.ok'), cancel: T('stop.keep'), danger: true });
}

// ── the tool log ──────────────────────────────────────────────────────
async function loadLog() {
  const v = V;
  if (!S.logOpen || !v || v.mode !== 'run' || !S.id) return;
  const r = await call(api().get, S.id, { log: 200 });
  if (!S.logOpen || V !== v || bad(r)) return;
  const text = (r.log || []).join('\n');
  if (text === v.logText) return;
  const stuck = v.logStuck || v.logText === undefined;
  v.logText = text;
  v.logBody.textContent = text || T('b.logEmpty');
  if (stuck) { v.logBody.scrollTop = v.logBody.scrollHeight; v.logStuck = true; }
}

function openLog() {
  if (!V || V.mode !== 'run') return;
  S.logOpen = true;
  V.log.hidden = false;
  V.logText = undefined;
  loadLog();
}

function closeLog() {
  S.logOpen = false;
  if (V && V.log) V.log.hidden = true;
}

// ── keys ──────────────────────────────────────────────────────────────
function onKey(e) {
  if (!S.shown || S.mode !== 'run' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (isTyping() || isModalOpen() || document.activeElement?.closest?.('.seg')) return;
  const viewer = document.getElementById('viewer');
  if (viewer && !viewer.hidden) return;
  if (stepSample(e.key === 'ArrowRight' ? 1 : -1)) e.preventDefault();
}

// ══════════════════════════════════════════════════════════════════════
// the chip of the title bar
// ══════════════════════════════════════════════════════════════════════
let chip = null;

export function mountTrainChip(container) {
  if (chip || !container) return;
  const label = el('span', { class: 'tr-chip-txt' });
  const fill = el('i');
  const gauge = el('span', { class: 'tr-chip-gauge' }, fill);
  const node = el('button', { class: 'tr-chip', type: 'button', id: 'tb-train' }, label, gauge);
  chip = { node, label, fill, gauge, model: null };
  // title bar order: [models] [training] [GPU] [settings]
  const gpu = container.querySelector('.gpu-chip') || container.querySelector('#tb-settings');
  if (gpu) container.insertBefore(node, gpu); else container.append(node);
  tip(node, () => chip.model?.tip || '', { placement: 'bottom' });
  node.addEventListener('click', () => { closeMenu(); openTrain(chip.model?.id || null); });
  L = lang() === 'en' ? 'en' : 'fr';
  paintChip();
}

function paintChip() {
  if (!chip) return;
  const m = X.chipModel(L, S.rows, S.options?.bases);
  chip.model = m;
  chip.label.textContent = m.text;
  chip.node.className = `tr-chip s-${m.state}${m.error ? ' err' : ''}`;
  chip.gauge.hidden = m.progress == null;
  chip.fill.style.transform = `scaleX(${m.progress == null ? 0 : m.progress})`;
}

/** Tests and the assistants' bridge: what is on screen, without reading the DOM. */
export function trainSnapshot() {
  return { shown: S.shown, mode: S.mode, id: S.id, state: S.cur?.state || null, chip: chip?.model?.text || null };
}

export default { mountTrain, mountTrainChip, openTrain, trainEscape, trainSnapshot };
