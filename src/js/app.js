/**
 * Mia — the window's conductor.
 *
 * Boot (prefs → theme → language → chrome → home), routing between the home
 * page and the board, the tabs, opening/creating/saving projects, and the
 * relay of the main process's events onto the bus. The board, the blocks,
 * the queue and the model library are loaded as separate modules: if one of
 * them fails, the shell keeps working and says so in a toast.
 */
import { on, emit } from './bus.js';
import bus from './bus.js';
import { state, DEFAULT_PREFS } from './state.js';
import { t, tn, tl, register, initLang, applyStaticText } from './i18n.js';
import { $, debounce, isTyping, clamp } from './util.js';
import { initChrome, toggleFullscreen } from './ui/chrome.js';
import { initTabs } from './ui/tabs.js';
import { initHome } from './ui/home.js';
import { closeMenu, isMenuOpen, installTextMenus } from './ui/menu.js';
import { isModalOpen, closeTopModal, alert } from './ui/modal.js';
import { toast } from './ui/toasts.js';
import { installTooltips, hideTip } from './ui/tooltip.js';
import { warmIcons } from './icons.js';
import { mountSettingsButton, openSettings, setPrefs, applyTheme } from './ui/settings.js';

register({
  fr: {
    'app.noBridge': 'Mia ne parvient pas à joindre son moteur interne. Ferme puis relance l’application.',
    'app.noBridgeTitle': 'Démarrage incomplet',
    'app.moduleFailed': 'Une partie de Mia n’a pas pu se charger : {what}. Le reste fonctionne.',
    'app.mod.editor': 'la planche',
    'app.mod.runs': 'le suivi des calculs',
    'app.mod.queue': 'la file de calcul',
    'app.mod.library': 'la bibliothèque de modèles',
    'app.noEditor': 'La planche n’est pas disponible : elle ne peut pas s’ouvrir.',
    'app.openFailed': 'Impossible d’ouvrir la planche : {why}',
    'app.createFailed': 'Impossible de créer la planche : {why}',
    'app.saveFailed': 'La planche n’a pas pu être enregistrée : {why}',
    'app.readOnly': 'Planche ouverte en lecture seule : {why}',
    'app.recovered': 'Le fichier de la planche était abîmé : la version précédente a été rouverte.',
    'app.missingMedia.one': '{n} média de cette planche est introuvable (fichier déplacé ou supprimé du dossier media).',
    'app.missingMedia.other': '{n} médias de cette planche sont introuvables (fichiers déplacés ou supprimés du dossier media).',
    'app.reveal': 'Afficher le dossier',
    'app.renameFailed': 'Impossible de renommer la planche : {why}',
    'app.recipeFailed': 'La recette n’a pas pu être posée : {why}',
    'app.importing.one': 'Import de {n} fichier…',
    'app.importing.other': 'Import de {n} fichiers…',
    'app.unknown': 'raison inconnue'
  },
  en: {
    'app.noBridge': 'Mia cannot reach its internal engine. Close and restart the application.',
    'app.noBridgeTitle': 'Incomplete start',
    'app.moduleFailed': 'Part of Mia could not load: {what}. Everything else works.',
    'app.mod.editor': 'the board',
    'app.mod.runs': 'the run tracking',
    'app.mod.queue': 'the run queue',
    'app.mod.library': 'the model library',
    'app.noEditor': 'The board is unavailable: it cannot open.',
    'app.openFailed': 'Could not open the board: {why}',
    'app.createFailed': 'Could not create the board: {why}',
    'app.saveFailed': 'The board could not be saved: {why}',
    'app.readOnly': 'Board opened read-only: {why}',
    'app.recovered': 'The board file was damaged: the previous version was reopened.',
    'app.missingMedia.one': '{n} medium of this board cannot be found (file moved or deleted from the media folder).',
    'app.missingMedia.other': '{n} media of this board cannot be found (files moved or deleted from the media folder).',
    'app.reveal': 'Show the folder',
    'app.renameFailed': 'Could not rename the board: {why}',
    'app.recipeFailed': 'The recipe could not be placed: {why}',
    'app.importing.one': 'Importing {n} file…',
    'app.importing.other': 'Importing {n} files…',
    'app.unknown': 'unknown reason'
  }
});

const mia = window.mia;
const SAVE_DELAY = 800;

let tabs = null;
let home = null;
let editor = null;       // E's editor: load / unload / getGraph / insertRecipe / importFiles / fit
let runsApi = null;      // F's runs store
let resolveEditor;
const editorReady = new Promise((r) => { resolveEditor = r; });   // resolves to editor | null

const app = {};          // inspection hook (window.__mia.app)

const why = (r, err) => (r && typeof r === 'object' && r.error) || err?.message || t('app.unknown');
const failed = (r) => !r || (typeof r === 'object' && r.ok === false);

// ── boot ──────────────────────────────────────────────────────────────
async function boot() {
  window.__mia = Object.assign(window.__mia || {}, { state, bus, app });

  // these go first: they decide what every later keystroke and wheel does
  window.addEventListener('keydown', onGlobalKey, true);
  installPageGuards();

  if (!mia) {
    initLang('fr');
    applyStaticText(document);
    installTooltips();
    alert({ title: t('app.noBridgeTitle'), body: t('app.noBridge') });
    return;
  }

  // prefs → theme → language, before anything is drawn
  try {
    const p = await mia.prefs.get();
    state.prefs = { ...DEFAULT_PREFS, ...(p && typeof p === 'object' && p.ok !== false ? p : {}) };
  } catch (err) {
    console.error('[app] prefs.get', err);
    state.prefs = { ...DEFAULT_PREFS };
  }
  applyTheme(state.prefs.theme === 'light' ? 'light' : 'dark');
  initLang(state.prefs.lang === 'en' ? 'en' : 'fr');
  applyStaticText(document);
  mia.app?.info?.().then((info) => { if (info && typeof info === 'object') state.info = info; }).catch(() => {});

  installTooltips();
  installTextMenus();

  initChrome({ onHome: goHome, onNewProject: () => newBoard(), onNewFolder: () => newFolder(), onSettings: openSettings });
  tabs = initTabs({
    onSelect: (id) => openProject(id),
    onClose: (id) => closeTab(id),
    onNew: () => newBoard(),
    onHome: () => goHome(),
    onRename: (id, name) => renameProject(id, name),
    onReveal: (id) => mia.projects.reveal(id).catch((err) => console.error('[app] reveal', err)),
    onCloseOthers: (id) => closeOthers(id),
    // the tab groups (SPEC §18.4): one per project
    onCollapse: (list) => persistCollapsed(list),
    onNewIn: (folderId) => newBoard({ folderId }),
    onRenameGroup: (folderId) => home.renameFolder(folderId),
    onGroupColor: (folderId, color) => home.setFolderColor(folderId, color),
    onCloseGroup: (folderId) => closeGroup(folderId)
  });
  tabs.setCollapsed(state.prefs.collapsedGroups);
  mountSettingsButton($('#tb-actions'));

  home = initHome({
    onOpen: (p) => openProject(p.id),
    onCreate: ({ folderId } = {}) => newBoard({ folderId }),
    onRecipe: (recipe, { folderId } = {}) => createFromRecipe(recipe, { folderId }),
    onDropFiles: (paths, { folderId } = {}) => createFromFiles(paths, { folderId }),
    onRenamed: (id, name, r) => applyRename(id, name, r),
    onBeforeRemove: async (id) => { if (tabs.has(id)) await closeTab(id); },
    // a project going to the Bin with its boards: their tabs close first
    onBeforeRemoveFolder: async (folderId, keepBoards) => {
      if (keepBoards) return;
      for (const p of home.projects()) if (p.folderId === folderId && tabs.has(p.id)) await closeTab(p.id);
    },
    onMoved: (id, folderId, r) => {
      if (r && typeof r === 'object') setOpenDir(id, r.dir);
    },
    // every fresh list: the open board's folder (its project may have been renamed), the tabs
    // (names, projects, colours) and the window's title follow
    onData: (data) => { syncOpenBoard(data?.projects); tabs.setData(data); syncTitle(); persistCollapsed(tabs.collapsedGroups()); },
    isOpen: (id) => tabs.has(id)
  });
  showView('home');
  // the tab strip comes back with the boards list (names, projects, and whether they still exist)
  const homeShown = home.refresh({ animate: true }).then((list) => restoreTabStrip(list));

  relayMainEvents();

  // the window is closing (Alt+F4, the × button): what is being typed, the board, its picture
  mia.win?.onFlush?.(async () => {
    try { await flushSave({ thumb: true }); } catch (err) { console.error('[app] flush', err); } finally { mia.win.flushed?.(); }
  });
  on('app:flush', () => flushSave({ thumb: true }));
  on('graph:changed', onGraphChanged);
  // a new result shows on the board: the home picture is out of date
  on('engine:event', (evt) => { if (evt?.kind === 'done' && state.project && evt.projectId === state.project.id) thumbDirty = true; });
  // the other theme: the open board's picture is retaken in it (a dark picture is a black hole on the light home)
  on('theme:changed', () => { if (state.project) thumbDirty = true; });
  // the models library opens over the board: the blocks palette steps aside (both sat at z 300, Esc closed only one).
  // Registered before the library mounts, so the library's own focus wins.
  on('library:open', () => {
    const pal = $('#palette');
    if (pal && !pal.hidden) pal.querySelector('.pal-catcher')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  });
  on('prefs:changed', onPrefsChanged);
  on('recipe:insert', (p) => { if (!state.project && p?.recipe) createFromRecipe(p.recipe); });

  await loadModules();
  // the assistants' presence (Claude, Codex driving Mia — SPEC §13, agent G); optional
  import('./ui/presence.js').then((m) => m.mountPresence?.()).catch((err) => console.warn('[app] presence :', err?.message || err));
  await homeShown;
  home.renderRecipes();            // the block glyphs are registered by now
  warmIcons();                     // measured now, on the small home page, not in the middle of a board being built
  await restoreActiveTab();
  emit('app:ready', {});
}

// ── the modules of the other parts (each may fail on its own) ─────────
async function loadModules() {
  const [ed, rn, qu, lib] = await Promise.allSettled([
    import('./graph/editor.js'),
    import('./nodes/runs.js'),
    import('./ui/queue.js'),
    import('./ui/library.js'),
    // the block glyphs (recipe cards on the home page), even if the board itself fails
    import('./catalog.js')
  ]);
  const broken = [];
  const attempt = async (what, fn) => {
    try { await fn(); } catch (err) {
      console.error(`[app] module « ${what} » :`, err);
      if (!broken.includes(what)) broken.push(what);
    }
  };
  const need = (r) => {
    if (r.status === 'rejected') throw r.reason;
    return r.value;
  };

  await attempt('runs', async () => {
    const m = need(rn);
    runsApi = [m.runs, m.default, m].find((x) => x && typeof x.load === 'function') || null;
  });

  await attempt('editor', async () => {
    const m = need(ed);
    const ret = await m.mountEditor($('#stage'));
    editor = [ret, m.editor, window.__mia?.editor, m.default, m].find((x) => x && typeof x.load === 'function') || null;
    if (!editor) throw new Error('mountEditor ne renvoie pas d’éditeur');
  });
  resolveEditor(editor);

  // title bar order: [models] [GPU] [settings]; each mount on its own, so one
  // broken piece does not take its neighbours down with it
  await attempt('library', () => need(lib).mountLibrary?.($('#library')));
  await attempt('library', () => need(lib).mountModelsButton?.($('#tb-actions')));
  await attempt('library', () => need(lib).mountHomeModels?.($('#home-models')));
  await attempt('queue', () => need(qu).mountQueue?.($('#queue')));
  await attempt('queue', () => need(qu).mountGpuChip?.($('#tb-actions')));
  const gear = $('#tb-settings');
  if (gear) $('#tb-actions').append(gear);   // the gear stays last
  applyStaticText(document);                 // in case a module put data-i18n markup in

  if (broken.length) {
    const what = broken.map((k) => t('app.mod.' + k)).join(', ');
    toast(t('app.moduleFailed', { what }), { kind: 'error', ms: 6000 });
  }
}

// ── main process → bus ────────────────────────────────────────────────
function relayMainEvents() {
  mia.engine?.onEvent?.((evt) => emit('engine:event', evt));
  mia.engine?.onStatus?.((s) => { state.engine = s; emit('engine:status', s); });
  mia.models?.onUpdate?.((inv) => { state.inventory = inv; emit('models:updated', inv); });
  // a project created, renamed, recoloured, emptied — here or by an assistant (SPEC §18.2)
  const onFolders = mia.folders?.onChanged || mia.folders?.onFoldersChanged || mia.onFoldersChanged;
  // the event carries the fresh list: the open board's folder follows at once, before any paste
  if (typeof onFolders === 'function') onFolders((payload) => { syncOpenBoard(payload?.projects); refreshListsSoon(); });

  Promise.resolve(mia.engine?.status?.()).then((s) => {
    if (s && typeof s === 'object' && s.ok !== false && !state.engine) { state.engine = s; emit('engine:status', s); }
  }).catch((err) => console.warn('[app] engine.status', err));
  Promise.resolve(mia.models?.list?.()).then((inv) => {
    if (inv && typeof inv === 'object' && inv.ok !== false && !state.inventory) { state.inventory = inv; emit('models:updated', inv); }
  }).catch((err) => console.warn('[app] models.list', err));
}

// ── views ─────────────────────────────────────────────────────────────
function showView(view) {
  const board = view === 'board';
  state.view = board ? 'board' : 'home';
  $('#view-home').hidden = board;
  $('#view-board').hidden = !board;
  document.body.classList.toggle('on-board', board);
  document.body.classList.toggle('on-home', !board);
  syncTitle();
  emit('view:changed', { view: state.view });
}

/** The window's name in the taskbar: « Projet › Planche », then Mia. */
function syncTitle() {
  if (state.view === 'board' && state.project?.name) {
    const f = tabs?.folder?.(tabs.folderOf(state.project.id));
    document.title = `${f ? `${f.name} › ` : ''}${state.project.name} — ${t('app.name')}`;
  } else document.title = t('app.name');
}

/** The project a new board goes to: the active tab's (on the board), the one shown (on the home page). */
function currentFolderId() {
  if (state.view === 'board' && state.project) return tabs.folderOf(state.project.id) || null;
  return home?.folderId?.() || null;
}

// the lists changed behind our back (main process event): one refresh for a burst of them
const refreshListsSoon = debounce(() => { home?.refresh().catch?.(() => {}); }, 150);

// one navigation at a time: a fast double click must not open a project twice
let navChain = Promise.resolve();
function serial(fn) {
  const run = navChain.then(fn, fn);
  navChain = run.catch(() => {});
  return run;
}

// ── projects ──────────────────────────────────────────────────────────
function openProject(id) {
  return serial(() => doOpen(id));
}

// ── the 8-tab ceiling ─────────────────────────────────────────────────
const tabSeen = new Map();   // boardId → the last time it was on screen (tabs restored at launch: never)

/** The tab to close for room: the least recently seen, not on screen, with no job queued or running. */
function spareTab() {
  const busy = new Set();
  try {
    for (const j of runsApi?.jobList?.() || []) {
      if (j?.projectId && ['queued', 'waiting-gpu', 'running'].includes(j.state)) busy.add(j.projectId);
    }
  } catch { /* no queue known: every tab counts as idle */ }
  const ids = tabs.ids().filter((id) => id !== state.project?.id && !busy.has(id));
  ids.sort((a, b) => (tabSeen.get(a) || 0) - (tabSeen.get(b) || 0));
  return ids[0] || null;
}

/**
 * The strip is full: one click closes the oldest idle tab and carries on with
 * the gesture (`retry`), instead of a dead end. Nothing closes on its own.
 */
function offerRoom(retry) {
  const id = spareTab();
  if (!id) { toast(t('tabs.full')); return; }
  const name = tabs.name?.(id) || home.find(id)?.name || '';
  const short = name.length > 28 ? name.slice(0, 27).trimEnd() + '…' : name;
  toast(t('tabs.fullOffer'), {
    action: {
      label: t('tabs.fullClose', { name: short }),
      run: async () => {
        await closeTab(id);
        if (!tabs.full()) retry?.();
      }
    }
  });
}

async function doOpen(id) {
  if (!id) return false;
  if (state.project?.id === id && state.view === 'board') return true;
  if (!tabs.has(id) && tabs.full()) { offerRoom(() => openProject(id)); return false; }
  closeMenu();
  hideTip();

  const ed = await editorReady;
  if (!ed) { toast(t('app.noEditor'), { kind: 'error' }); return false; }

  await closeCurrent();

  let res;
  try { res = await mia.projects.open(id); } catch (err) { res = { ok: false, error: err?.message }; }
  if (failed(res) || !res.project) {
    toast(t('app.openFailed', { why: why(res) }), { kind: 'error' });
    if (tabs.has(id)) tabs.remove(id);
    persistTabs();
    if (state.view === 'board') { tabs.setActive(null); showView('home'); home.refresh(); }
    return false;
  }

  const project = res.project;
  state.project = { id: project.id || id, name: project.name, dir: res.dir || project.dir || null };
  state.readOnly = !!res.readOnly;
  // its project: what the board says, else what the home list or its creation said
  const meta = { id: state.project.id, name: project.name };
  const folderId = project.folderId !== undefined ? project.folderId
    : home.find(state.project.id) ? home.find(state.project.id).folderId : createdIn.get(state.project.id);
  if (folderId !== undefined) meta.folderId = folderId || null;
  tabs.add(meta);
  tabSeen.set(state.project.id, Date.now());
  showView('board');   // also names the window after the project

  try { runsApi?.load?.(res.runs || {}); } catch (err) { console.error('[app] runs.load', err); }
  try {
    await ed.load(project, res.graph);
  } catch (err) {
    console.error('[app] editor.load', err);
    toast(t('app.openFailed', { why: err?.message || t('app.unknown') }), { kind: 'error' });
  }
  emit('project:opened', { project, graph: res.graph, runs: res.runs || {}, dir: state.project.dir, readOnly: state.readOnly });

  // a pan back to the opened view is no change; a project without an up-to-date picture gets one when it closes
  lastCam.set(state.project.id, res.graph?.camera || null);
  thumbDirty = thumbIsStale(home.find(state.project.id));

  const reveal = { label: t('app.reveal'), run: () => mia.projects.reveal(state.project?.id || id).catch(() => {}) };
  // the store's own sentence: no « read-only: read-only… » wrapping
  if (state.readOnly) toast(res.error || t('app.readOnly', { why: t('app.unknown') }), { kind: 'error', ms: 9000, action: reveal });
  // graph.json was damaged and the previous version came back: the latest edits are gone, say it
  else if (res.warning) {
    toast(typeof res.warning === 'string' ? res.warning : t('app.recovered'), { kind: 'info', icon: 'warn', ms: 10000, action: reveal });
    // write the recovered board back at once, so the next opening is a normal one
    dirty = true;
    contentDirty = true;
    saveSoon();
  }
  const missing = (res.graph?.nodes || []).filter((n) => n?.type === 'import' && n.data?._missing).length;
  if (missing) toast(tn('app.missingMedia', missing), { kind: 'error', ms: 8000 });
  persistTabs();
  return true;
}

/**
 * A card's picture is stale when the project was saved well after it was taken (or it has none),
 * or when it was taken in the other theme (prefs.thumbThemes, see thumbTaken).
 */
function thumbIsStale(p) {
  if (!p) return true;
  if (!p.thumb) return true;
  if (thumbThemeOf(p.id) !== currentTheme()) return true;
  const v = Number(/[?&]v=(\d+)/.exec(String(p.thumb))?.[1]) || 0;
  return !v || (Number(p.updated) || 0) - v > 2000;
}

const currentTheme = () => (document.body.classList.contains('theme-light') ? 'light' : 'dark');
// the theme each picture was taken in: only the light ones are listed (every older picture is dark)
const thumbThemeOf = (id) => (state.prefs?.thumbThemes?.[id] === 'light' ? 'light' : 'dark');
function thumbTaken(id) {
  const theme = currentTheme();
  if (thumbThemeOf(id) === theme) return;
  const map = { ...(state.prefs?.thumbThemes || {}) };
  if (theme === 'light') map[id] = 'light'; else delete map[id];
  setPrefs({ thumbThemes: map }).catch?.(() => {});
}

/** Save and take the current project off the board (its tab stays). */
async function closeCurrent() {
  const p = state.project;
  if (!p) return;
  tabSeen.set(p.id, Date.now());
  // the board is still on screen: last chance for the home page's picture of it
  await flushSave({ thumb: true });
  emit('project:closing', { id: p.id });
  try { await editor?.unload?.(); } catch (err) { console.error('[app] editor.unload', err); }
  state.project = null;
  state.readOnly = false;
  emit('project:closed', { id: p.id });
}

function goHome() {
  return serial(async () => {
    closeMenu();
    await closeCurrent();
    tabs.setActive(null);
    const wasHome = state.view === 'home';
    showView('home');
    await home.refresh({ animate: !wasHome });
    persistTabs();
  });
}

function closeTab(id) {
  return serial(async () => {
    const wasActive = state.project?.id === id;
    if (wasActive) await closeCurrent();
    const next = tabs.remove(id);
    persistTabs();
    if (!wasActive) { if (state.view === 'home') home.render(); return; }
    if (next) await doOpen(next.id);
    else {
      showView('home');
      await home.refresh({ animate: true });
    }
  });
}

/** « Fermer le groupe »: every tab of a project; the board on screen moves to the neighbour. */
function closeGroup(folderId) {
  return serial(async () => {
    const ids = tabs.groupIds(folderId);
    if (!ids.length) return;
    const order = tabs.ids();
    const first = order.indexOf(ids[0]);
    const activeIn = !!state.project && ids.includes(state.project.id);
    if (activeIn) await closeCurrent();
    for (const id of ids) tabs.remove(id);
    persistTabs();
    if (!activeIn) { if (state.view === 'home') home.render(); return; }
    const rest = tabs.ids();
    const next = rest.length ? rest[Math.max(0, Math.min(first, rest.length - 1))] : null;
    if (next) await doOpen(next);
    else {
      tabs.setActive(null);
      showView('home');
      await home.refresh({ animate: true });
    }
  });
}

function closeOthers(id) {
  return serial(async () => {
    for (const other of tabs.ids()) if (other !== id) tabs.remove(other);
    persistTabs();
    if (state.project?.id !== id) await doOpen(id);
  });
}

async function cycleTabs(dir) {
  const next = tabs.step(dir);
  if (next) await openProject(next.id);
}

const createdIn = new Map();   // boardId → the project it was created in (until the lists say it)

/**
 * Making a board should not cost a dialog: it opens at once, its name ready to type over.
 * `folderId`: the project it goes in (SPEC §18.2), null = outside any project.
 */
async function createProject({ name, recipe, folderId = null, retry = null } = {}) {
  // 8 tabs: the toast offers to close the oldest idle one, then the whole gesture starts again (retry)
  if (tabs.full()) { offerRoom(retry || (() => createProject({ name, recipe, folderId }))); return null; }
  const payload = { name: name || t('app.untitled'), recipe: recipe?.id };
  if (folderId && mia.folders) payload.folderId = folderId;
  let r;
  try { r = await mia.projects.create(payload); } catch (err) { r = { ok: false, error: err?.message }; }
  if (failed(r) || !r.id) {
    toast(t('app.createFailed', { why: why(r) }), { kind: 'error' });
    return null;
  }
  createdIn.set(r.id, r.folderId !== undefined ? (r.folderId || null) : (payload.folderId || null));
  // the home list learns of it (its card, its project's count) without waiting for the next visit
  home.refresh().catch?.(() => {});
  const ok = await openProject(r.id);
  return ok ? r : null;
}

/** A new board, in a project (default: the one in front of Quentin), its name ready to type. */
async function newBoard({ folderId } = {}) {
  if (isModalOpen()) return;
  const fid = folderId === undefined ? currentFolderId() : folderId;
  const r = await createProject({ folderId: fid, retry: () => newBoard({ folderId: fid }) });
  if (r) requestAnimationFrame(() => tabs.startRename(r.id));
}
const newProject = newBoard;   // the name the other parts (and the assistants' bridge) know

/** A new project (a folder of boards): shown on the home page, its name ready to type. */
async function newFolder() {
  if (isModalOpen() || !home.newFolder || !mia.folders) return;
  if (state.view === 'board') await goHome();
  await home.newFolder();
}

async function createFromRecipe(recipe, { folderId } = {}) {
  const fid = folderId === undefined ? currentFolderId() : folderId;
  const r = await createProject({ name: tl(recipe.label), recipe, folderId: fid, retry: () => createFromRecipe(recipe, { folderId: fid }) });
  if (!r || !editor) return;
  try {
    await editor.insertRecipe(recipe);
    emit('graph:changed', { reason: 'recipe', history: false });
    await flushSave();
    requestAnimationFrame(() => { try { editor.fit?.(); } catch { /* the view stays where it is */ } });
  } catch (err) {
    console.error('[app] insertRecipe', err);
    toast(t('app.recipeFailed', { why: err?.message || t('app.unknown') }), { kind: 'error' });
  }
}

async function createFromFiles(paths, { folderId } = {}) {
  const fid = folderId === undefined ? currentFolderId() : folderId;
  const r = await createProject({ folderId: fid, retry: () => createFromFiles(paths, { folderId: fid }) });
  if (!r || !editor) return;
  toast(tn('app.importing', paths.length), { ms: 1600 });
  try {
    await editor.importFiles(paths);
  } catch (err) {
    console.error('[app] importFiles', err);
    toast(t('app.openFailed', { why: err?.message || t('app.unknown') }), { kind: 'error' });
  }
}

async function renameProject(id, name) {
  const old = tabs.tabs.find((x) => x.id === id)?.name;
  let r;
  try { r = await mia.projects.rename(id, name); } catch (err) { r = { ok: false, error: err?.message }; }
  if (r && typeof r === 'object' && r.ok === false) {
    toast(t('app.renameFailed', { why: why(r) }), { kind: 'error' });
    if (old) tabs.rename(id, old);
    return;
  }
  applyRename(id, (r && typeof r === 'object' && r.name) || name, r);
}

/** A project renamed from its tab or its card: its folder may have moved too. */
function applyRename(id, name, r) {
  tabs.rename(id, name);
  if (state.project?.id === id) {
    setOpenDir(id, r && typeof r === 'object' ? r.dir : null, name);
    syncTitle();
  }
  if (state.view === 'home') home.refresh();
}

/**
 * The open board's folder as the main process last reported it. Renaming its
 * project (tab chip, breadcrumb, card), moving it, or a deferred rename that
 * lands after a run moves the folder on disk: the app state (the assistants'
 * get_board paths) and the editor's own project object (copy-paste of media
 * between boards) must follow, or they point at a folder that no longer exists.
 */
function setOpenDir(id, dir, name) {
  const cur = state.project;
  if (!id || cur?.id !== id) return;
  const d = typeof dir === 'string' && dir ? dir : null;
  const n = typeof name === 'string' && name ? name : null;
  if (d) cur.dir = d;
  if (n) cur.name = n;
  // the editor keeps its own (mutable) copy, set when the board was loaded
  for (const ed of new Set([editor, window.__mia?.editor])) {
    const ep = ed?.project;
    if (!ep || typeof ep !== 'object' || ep.id !== id) continue;
    if (d && ep.dir !== d) ep.dir = d;
    if (n && ep.name !== n) ep.name = n;
  }
}

/** Same, from a fresh list of the boards (projects.list or the folders:changed payload). */
function syncOpenBoard(list) {
  if (!state.project || !Array.isArray(list)) return;
  const p = list.find((x) => x && x.id === state.project.id);
  if (p) setOpenDir(p.id, p.dir, p.name);
}

// ── tabs remembered across launches ───────────────────────────────────
const persistTabs = debounce(() => {
  // the projects folder is out of reach: the tabs we hold are not a reason to forget the real ones
  if (home?.rootMissing?.()) return;
  const openTabs = tabs.ids();
  const activeTab = state.project?.id ?? null;
  const same = JSON.stringify(state.prefs.openTabs || []) === JSON.stringify(openTabs) && state.prefs.activeTab === activeTab;
  if (!same) setPrefs({ openTabs, activeTab });
}, 400);

function restoreTabStrip(list = []) {
  const wanted = (state.prefs.openTabs || []).map((x) => (typeof x === 'string' ? x : x?.id)).filter(Boolean);
  if (!wanted.length) return;
  const byId = new Map(list.map((p) => [p.id, p]));
  for (const id of wanted) {
    const p = byId.get(id);
    if (p && !tabs.has(id)) tabs.add({ id, name: p.name, folderId: p.folderId || null }, { activate: false });
  }
  tabs.setActive(null);
  home.render();
}

/** Folded groups are remembered (prefs.collapsedGroups), only for projects that still exist. */
function persistCollapsed(list) {
  if (!mia.folders || home?.rootMissing?.()) return;
  const known = new Set((home?.folders?.() || []).map((f) => f.id));
  if (!known.size) return;   // no list (yet): nothing to judge stale entries by
  const keep = (Array.isArray(list) ? list : []).filter((id) => known.has(id));
  if (JSON.stringify(keep) === JSON.stringify(state.prefs.collapsedGroups || [])) return;
  setPrefs({ collapsedGroups: keep });
}

async function restoreActiveTab() {
  const id = state.prefs.activeTab;
  if (!id || !editor) return;
  const list = home.projects();
  if (!list.some((p) => p.id === id)) return;
  await openProject(id);
}

// ── saving ────────────────────────────────────────────────────────────
let dirty = false;          // something to write
let contentDirty = false;   // …and more than the camera (blocks, wires, settings, sections)
let thumbDirty = false;     // the board changed since the home page's picture of it
const lastCam = new Map();  // projectId → the camera last written (a pan back to it is no change)
let saving = Promise.resolve();
const saveSoon = debounce(() => saveNow(), SAVE_DELAY);

const sameCam = (a, b) => !!a && !!b && Math.abs((a.x || 0) - (b.x || 0)) < 0.01 && Math.abs((a.y || 0) - (b.y || 0)) < 0.01 && Math.abs((a.z || 1) - (b.z || 1)) < 1e-4;

function onGraphChanged({ reason } = {}) {
  if (!state.project || state.readOnly) return;
  if (reason === 'camera') {
    // the view only: worth remembering, but it is not an edit (store: no .bak, no « Modifié »)
    if (sameCam(editor?.camera?.(), lastCam.get(state.project.id))) return;
  } else {
    contentDirty = true;
    thumbDirty = true;
  }
  dirty = true;
  saveSoon();
}

/**
 * What is being typed is part of the board. Text fields commit on blur (and
 * Ctrl+S / Ctrl+W / Ctrl+Tab / Alt+F4 come before any blur), so the field is
 * blurred first: its change lands in the graph synchronously, then the save
 * sees it. `refocus` puts the caret back where it was (Ctrl+S keeps typing).
 */
function commitActiveField({ refocus = false } = {}) {
  const a = document.activeElement;
  if (!a || a === document.body) return;
  if (!(a.matches?.('input, textarea') || a.isContentEditable)) return;
  let sel = null;
  if (refocus) { try { sel = [a.selectionStart, a.selectionEnd]; } catch { sel = null; } }
  // a window without the system focus (being closed from the taskbar, tests) fires no blur:
  // the field's own commit listeners are then called with a stand-in event
  const silent = !document.hasFocus();
  a.blur();
  if (silent) {
    a.dispatchEvent(new Event('change', { bubbles: true }));
    a.dispatchEvent(new FocusEvent('blur'));
    a.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }
  if (refocus && a.isConnected) {
    a.focus({ preventScroll: true });
    if (sel && sel[0] != null) { try { a.setSelectionRange(sel[0], sel[1]); } catch { /* not a text field */ } }
  }
}

/**
 * Write the open project now; saves are chained, never two at once.
 * `thumb`: also take the home page's picture, if the board changed since the last one.
 */
function saveNow({ thumb = false } = {}) {
  saveSoon.cancel();
  if (!state.project || !editor || state.readOnly) return saving;
  // an empty board keeps the home's dotted card: no picture of an empty canvas (a black tile)
  if (thumb && thumbDirty && !(editor.getGraph?.()?.nodes?.length)) thumbDirty = false;
  const withThumb = thumb && thumbDirty && state.view === 'board' && !document.hidden;
  if (!dirty && !withThumb) return saving;
  const id = state.project.id;
  const cameraOnly = !contentDirty;
  dirty = false;
  contentDirty = false;
  if (withThumb) thumbDirty = false;
  let graph;
  try {
    // `_` properties are display caches: never on disk (SPEC §3.2)
    graph = JSON.parse(JSON.stringify(editor.getGraph(), (k, v) => (k.startsWith('_') ? undefined : v)));
  } catch (err) {
    console.error('[app] getGraph', err);
    return saving;
  }
  saving = saving.then(async () => {
    let staged = null;
    if (withThumb) {
      try { staged = await stageThumb(id); } catch (err) { console.error('[app] thumbnail', err); }
    }
    let r;
    try {
      r = await mia.projects.save(id, graph, { thumbRect: staged?.rect || null, force: !!staged, cameraOnly });
    } catch (err) {
      r = { ok: false, error: err?.message };
    } finally {
      try { staged?.restore(); } catch (err) { console.error('[app] thumbnail', err); }
    }
    if (r && typeof r === 'object' && r.ok === false) {
      if (state.project?.id === id) {
        dirty = true;
        if (!cameraOnly) contentDirty = true;
        if (withThumb) thumbDirty = true;
      }
      toast(t('app.saveFailed', { why: why(r) }), { kind: 'error' });
      return;
    }
    if (graph.camera) lastCam.set(id, graph.camera);
    if (staged) thumbTaken(id);
    // the dot confirms an edit reached the disk; a pan or a zoom is no edit
    if (!cameraOnly) tabs.flashSaved(id);
  });
  return saving;
}

async function flushSave({ thumb = false } = {}) {
  commitActiveField();
  if (saveSoon.pending() || dirty || (thumb && thumbDirty)) await saveNow({ thumb });
  else await saving;
}

// ── the home page's picture of a board ────────────────────────────────
// never waits for ever: a hidden or occluded window may stop its frames (the save chain must go on)
const nextFrame = () => new Promise((r) => { const t = setTimeout(r, 80); requestAnimationFrame(() => { clearTimeout(t); r(); }); });
const twoFrames = () => nextFrame().then(nextFrame);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The window area the picture is cut from: under the title bar, 16:10, centred. */
function thumbRect() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const top = ($('#titlebar')?.offsetHeight || 44) + 4;
  let x = 4, y = top, w = W - 8, h = H - top - 4;
  if (w < 160 || h < 100) return null;
  if (w / h > 1.6) { const nw = h * 1.6; x += (w - nw) / 2; w = nw; } else { const nh = w / 1.6; y += (h - nh) / 2; h = nh; }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** Everything on the board, in world units: blocks and sections. */
function contentBox(graph) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of graph?.nodes || []) {
    const node = editor.nodeEl?.(n.id);
    const w = Number(n.w) || node?.offsetWidth || 320;
    const h = node?.offsetHeight > 24 ? node.offsetHeight : 220;
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + w); y1 = Math.max(y1, n.y + h);
  }
  for (const g of graph?.groups || []) {
    x0 = Math.min(x0, g.x); y0 = Math.min(y0, g.y - 30);   // the section's name sits above it
    x1 = Math.max(x1, g.x + g.w); y1 = Math.max(y1, g.y + g.h);
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) } : null;
}

/**
 * Frame the whole board for the picture: everything floating over it steps
 * aside (body.thumbing), the camera fits the content without animation, and
 * the board gets two frames plus its 150 ms settle (crisp text, real LOD)
 * before the main process captures. `restore()` puts the user's view back.
 */
async function stageThumb(id) {
  if (!editor || state.view !== 'board' || state.project?.id !== id || document.hidden) return null;
  const stage = $('#stage');
  const rect = thumbRect();
  if (!stage || !stage.offsetWidth || !rect) return null;
  const body = document.body;
  const cam = editor.camera?.() || null;
  body.classList.add('thumbing');
  hideTip();
  const box = contentBox(editor.getGraph());
  if (box && cam && typeof editor.setCamera === 'function') {
    const s = stage.getBoundingClientRect();
    const pad = Math.round(Math.min(rect.w, rect.h) * 0.07);
    const z = clamp(Math.min((rect.w - 2 * pad) / box.w, (rect.h - 2 * pad) / box.h), 0.1, 1);
    editor.setCamera({
      z,
      x: box.x + box.w / 2 - (rect.x + rect.w / 2 - s.left) / z,
      y: box.y + box.h / 2 - (rect.y + rect.h / 2 - s.top) / z
    }, { animate: false });
  }
  await twoFrames();
  await sleep(170);
  await twoFrames();
  // the user moved on in the meantime (another tab, home): no picture of the wrong screen
  if (state.project?.id !== id || state.view !== 'board') {
    if (cam && state.project?.id === id) editor.setCamera(cam, { animate: false });
    body.classList.remove('thumbing');
    return null;
  }
  return {
    rect,
    restore() {
      if (cam && state.project?.id === id) editor.setCamera(cam, { animate: false });
      body.classList.remove('thumbing');
    }
  };
}

// ── prefs ─────────────────────────────────────────────────────────────
function onPrefsChanged({ patch } = {}) {
  // another projects folder: the open tabs belonged to the old one
  if (patch && 'projectsRoot' in patch) {
    serial(async () => {
      await closeCurrent();
      for (const id of tabs.ids()) tabs.remove(id);
      tabs.setActive(null);
      showView('home');
      await home.refresh({ animate: true });
      persistTabs();
    });
  }
}

// ── keyboard ──────────────────────────────────────────────────────────
/**
 * One capture listener decides the global keys. Esc closes, in this order:
 * a menu, a dialog — then the board's own layers (palette, viewer,
 * selection) handle it themselves. Letters are read on `e.key` (AZERTY
 * prints what it says), digits on `e.code` (the top row of AZERTY gives
 * & é " ' without Shift).
 */
function onGlobalKey(e) {
  const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  if (e.key === 'Escape') {
    hideTip();
    if (isMenuOpen()) { stop(); closeMenu(); return; }
    if (isModalOpen()) { stop(); closeTopModal(); return; }
    return;
  }
  if (isModalOpen() || !tabs) return;

  const mod = e.ctrlKey || e.metaKey;
  const key = (e.key || '').toLowerCase();

  if (e.key === 'F11') { stop(); toggleFullscreen(); return; }
  // Chromium's page reload / zoom: never in Mia (the board uses Ctrl ± for its camera)
  if (e.key === 'F5' || (mod && key === 'r')) { e.preventDefault(); return; }
  if (mod && !e.altKey && (['=', '+', '-', '_', '0'].includes(e.key) || /^(Equal|Minus|Digit0|Numpad0|NumpadAdd|NumpadSubtract)$/.test(e.code))) {
    if (state.view !== 'board') e.preventDefault();
    return;
  }
  if (!mod || e.altKey) {
    if (e.key === '/' && state.view === 'home' && !isTyping()) { stop(); home.focusSearch(); }
    return;
  }
  if (tabs.isRenaming()) return;

  // every shortcut below leaves the board or writes it: what is being typed goes in first
  // Ctrl+N: a board in the project in front of Quentin; Ctrl+Maj+N: a new project
  if (key === 'n' && !e.shiftKey) { stop(); commitActiveField(); newBoard(); return; }
  if (key === 'n' && e.shiftKey) { stop(); commitActiveField(); newFolder(); return; }
  if (key === 'w' && !e.shiftKey) {
    stop();
    if (state.view === 'board' && state.project) { commitActiveField(); closeTab(state.project.id); }
    return;
  }
  if (e.key === 'Tab') { stop(); commitActiveField(); cycleTabs(e.shiftKey ? -1 : 1); return; }
  if (key === 's' && !e.shiftKey && state.project) {
    stop();
    commitActiveField({ refocus: true });
    dirty = true;
    saveNow();
    return;
  }
  if (e.key === ',') { stop(); openSettings(); return; }
  const digit = /^(Digit|Numpad)([1-8])$/.exec(e.code);
  if (digit && !e.shiftKey) {
    const tab = tabs.at(Number(digit[2]) - 1);
    if (tab) { stop(); commitActiveField(); openProject(tab.id); }
  }
}

/** No page zoom, no file navigation: Chromium's defaults that would break the app. */
function installPageGuards() {
  // Ctrl+wheel and trackpad pinch would zoom the whole interface; the board
  // reads them for its camera before they get here
  window.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); }, { passive: false });
  // a file dropped anywhere nobody handles would replace the app by the file
  window.addEventListener('dragover', (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
  });
  window.addEventListener('drop', (e) => e.preventDefault());
  // the middle button's autoscroll and the browser's own drag of links
  window.addEventListener('mousedown', (e) => { if (e.button === 1 && !e.target.closest?.('#stage')) e.preventDefault(); });
}

Object.assign(app, {
  openProject, goHome, closeTab, closeGroup, newProject, newBoard, newFolder, createProject, createFromRecipe,
  saveNow: () => { dirty = true; return saveNow(); },
  flushSave,
  /** take the home picture now (tests, assistants) */
  thumbnail: () => { thumbDirty = true; return flushSave({ thumb: true }); }
});
// live getters: Object.assign would have copied the values once, at load (all null)
Object.defineProperties(app, {
  editor: { get: () => editor, enumerable: true },
  tabs: { get: () => tabs, enumerable: true },
  home: { get: () => home, enumerable: true }
});

boot().catch((err) => {
  console.error('[app] démarrage', err);
  try { toast(t('app.openFailed', { why: err?.message || t('app.unknown') }), { kind: 'error', ms: 8000 }); } catch { /* nothing left to tell with */ }
});
