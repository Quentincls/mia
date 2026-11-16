/**
 * Home page (SPEC §18.3): the PROJETS (folders that hold boards) and the
 * PLANCHES (boards outside any project), Slate's gallery for both; inside a
 * project, a breadcrumb « Projets › Court métrage » and its boards. Then the
 * ready-made recipes and the room for the local models (library.js).
 *
 * A board card dragged onto a project card (or onto « Projets » in the
 * breadcrumb) is moved there. Right click: « Déplacer vers › » on a board,
 * Couleur ›, Renommer, Supprimer… on a project.
 *
 * This module talks to the main process for what only concerns a card or a
 * project folder (rename, colour, move, trash) and leaves opening and
 * creating boards to app.js, which owns the tabs and the board.
 * Everything about projects is feature-detected (window.mia.folders): without
 * it the home is the flat gallery it used to be.
 */
import { el, $, relTime, baseName, isTyping } from '../util.js';
import { icon, logo, hasIcon } from '../icons.js';
import { t, tn, tl, register } from '../i18n.js';
import { state } from '../state.js';
import { emit } from '../bus.js';
import { openMenu, closeMenu, isMenuOpen } from './menu.js';
import { prompt, confirm, openModal, isModalOpen } from './modal.js';
import { toast } from './toasts.js';
import { tip, hideTip } from './tooltip.js';
import { openSettings } from './settings.js';
import { toggle } from './controls.js';
import { ms, play, flip, rects, reduced, viewTransition } from './motion.js';

/** A card name cut by its box: too wide (one line) or past its two lines (line clamp). */
const isCut = (n) => n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1;

register({
  fr: {
    'home.title': 'Projets',
    'home.search': 'Rechercher…',
    'home.sort': 'Trier',
    'home.new': 'Nouvelle planche',
    'home.newFolder': 'Nouveau projet',
    'home.folders': 'Projets',
    'home.boards': 'Planches',
    'home.count.folders.one': '{n} projet',
    'home.count.folders.other': '{n} projets',
    'home.count.boards.one': '{n} planche',
    'home.count.boards.other': '{n} planches',
    'home.results.zero': 'aucun résultat',
    'home.results.one': '{n} résultat',
    'home.results.other': '{n} résultats',
    'home.none': 'Rien ne correspond à « {q} ».',
    'home.emptyTitle': 'Aucune planche pour l’instant',
    'home.emptyBody': 'Crée ta première planche et dépose-y une image ou une vidéo, ou pars d’une recette toute prête. Tu pourras ensuite ranger tes planches dans des projets.',
    'home.emptyCta': 'Créer une planche',
    'home.order.updated': 'Modifiés récemment',
    'home.order.opened': 'Ouverts récemment',
    'home.order.created': 'Créés récemment',
    'home.order.name': 'Nom (A → Z)',
    'home.cardMeta': 'Modifiée {when}',
    'home.folderMeta': 'modifié {when}',
    'home.folderEmpty': 'Vide · aucune planche',
    'home.blocks.zero': 'vide',
    'home.blocks.one': '{n} bloc',
    'home.blocks.other': '{n} blocs',
    'home.open': 'Ouvrir',
    'home.rename': 'Renommer',
    'home.renameTitle': 'Renommer la planche',
    'home.duplicate': 'Dupliquer',
    'home.reveal': 'Afficher dans l’Explorateur',
    'home.delete': 'Supprimer',
    'home.duplicated': 'Planche dupliquée',
    'home.deleteTitle': 'Supprimer « {name} » ?',
    'home.deleteBody': 'Le dossier de la planche part à la Corbeille de Windows, avec ses médias et ses résultats. Tu pourras l’y récupérer.',
    'home.deleted': 'Planche mise à la Corbeille',
    'home.options': 'Options',
    'home.isOpen': 'Ouverte dans un onglet',
    'home.moveTo': 'Déplacer vers',
    'home.noFolder': 'Sans projet',
    'home.newFolderDots': 'Nouveau projet…',
    'home.newFolderTitle': 'Nouveau projet',
    'home.newFolderBody': 'La planche y sera rangée.',
    'home.create': 'Créer',
    'home.movedIn': 'Rangée dans « {name} »',
    'home.movedOut': 'Sortie de « {name} »',
    // le nom était pris à l'arrivée (« Plan 01 » existait déjà) : la planche porte un numéro
    'home.movedInAs': 'Rangée dans « {name} » sous le nom « {as} » (le nom était pris)',
    'home.movedOutAs': 'Sortie de « {name} » sous le nom « {as} » (le nom était pris)',
    // elle retrouve le nom qu'elle avait avant un déplacement précédent
    'home.movedInRestored': 'Rangée dans « {name} » : elle reprend son nom « {as} »',
    'home.movedOutRestored': 'Sortie de « {name} » : elle reprend son nom « {as} »',
    'home.moveFailed': 'Impossible de déplacer la planche : {why}',
    'home.dropInto': 'Ranger dans « {name} »',
    'home.dropOut': 'Sortir du projet',
    'home.back': 'Retour aux projets',
    'home.folder.open': 'Ouvrir',
    'home.folder.newBoard': 'Nouvelle planche ici',
    'home.folder.rename': 'Renommer',
    'home.folder.renameTitle': 'Renommer le projet',
    'home.folder.color': 'Couleur',
    'home.folder.reveal': 'Afficher dans l’Explorateur',
    'home.folder.delete': 'Supprimer…',
    'home.folder.deleteTitle': 'Supprimer le projet « {name} » ?',
    'home.folder.keep': 'Garder les planches',
    'home.folder.keepHint': 'Sinon, elles partent à la Corbeille avec le projet.',
    'home.folder.deleteKeep.one': 'Sa planche ressort d’abord dans « Planches ». Puis le dossier du projet part à la Corbeille de Windows, avec tout ce qu’il contient d’autre (images, notes, fichiers rangés là à la main). Tu pourras l’y récupérer.',
    'home.folder.deleteKeep.other': 'Ses {n} planches ressortent d’abord dans « Planches ». Puis le dossier du projet part à la Corbeille de Windows, avec tout ce qu’il contient d’autre (images, notes, fichiers rangés là à la main). Tu pourras l’y récupérer.',
    'home.folder.deleteAll.one': 'Le dossier du projet part à la Corbeille de Windows avec tout ce qu’il contient : sa planche (médias et résultats compris) et tout autre fichier rangé dedans. Tu pourras tout y récupérer.',
    'home.folder.deleteAll.other': 'Le dossier du projet part à la Corbeille de Windows avec tout ce qu’il contient : ses {n} planches (médias et résultats compris) et tout autre fichier rangé dedans. Tu pourras tout y récupérer.',
    'home.folder.deleteEmpty': 'Ce projet n’a aucune planche. Son dossier part à la Corbeille de Windows avec tout ce qu’il contient (images, notes, fichiers rangés là à la main). Tu pourras l’y récupérer.',
    'home.folder.deleted': 'Projet mis à la Corbeille',
    'home.folder.default': 'Nouveau projet',
    'home.folder.emptyHint': 'Ce projet est vide : crée une planche ici, ou glisses-y une planche depuis l’accueil.',
    'home.folder.options': 'Options du projet',
    'home.folder.renameHint': 'Double-clic pour renommer',
    'home.color.grey': 'Gris',
    'home.color.blue': 'Bleu',
    'home.color.teal': 'Turquoise',
    'home.color.green': 'Vert',
    'home.color.yellow': 'Jaune',
    'home.color.orange': 'Orange',
    'home.color.red': 'Rouge',
    'home.color.pink': 'Rose',
    'home.recipes': 'Commencer avec une recette',
    'home.recipeTip': 'Crée une planche déjà câblée',
    'home.recipeTipIn': 'Crée une planche déjà câblée dans « {name} »',
    'home.dropHere': 'Dépose tes fichiers',
    'home.dropSub': 'Images et vidéos : une nouvelle planche  ·  LoRA : ajoutés à Mia',
    'home.dropSubIn': 'Images et vidéos : une nouvelle planche dans « {name} »  ·  LoRA : ajoutés à Mia',
    'home.notLora': 'Ce fichier est un modèle complet, pas un LoRA : range-le dans le dossier du moteur.',
    'home.notRecognised': '« {name} » : fichier non reconnu.',
    'home.modelUnreadable': 'Impossible de lire « {name} » : {why}',
    'home.loraUnavailable': 'L’ajout de LoRA n’est pas encore disponible dans cette version de Mia.',
    'home.rootMissing': 'Le dossier des projets « {path} » est introuvable (disque débranché, dossier renommé ?). Tes planches n’ont pas été touchées.',
    'home.changeRoot': 'Changer de dossier…',
    'home.listFailed': 'Impossible de lire la liste des planches : {why}',
    'home.actionFailed': 'L’opération a échoué : {why}',
    'home.unknown': 'raison inconnue'
  },
  en: {
    'home.title': 'Projects',
    'home.search': 'Search…',
    'home.sort': 'Sort',
    'home.new': 'New board',
    'home.newFolder': 'New project',
    'home.folders': 'Projects',
    'home.boards': 'Boards',
    'home.count.folders.one': '{n} project',
    'home.count.folders.other': '{n} projects',
    'home.count.boards.one': '{n} board',
    'home.count.boards.other': '{n} boards',
    'home.results.zero': 'no results',
    'home.results.one': '{n} result',
    'home.results.other': '{n} results',
    'home.none': 'Nothing matches “{q}”.',
    'home.emptyTitle': 'No boards yet',
    'home.emptyBody': 'Create your first board and drop an image or a video in it, or start from a ready-made recipe. You can then file your boards into projects.',
    'home.emptyCta': 'Create a board',
    'home.order.updated': 'Recently modified',
    'home.order.opened': 'Recently opened',
    'home.order.created': 'Recently created',
    'home.order.name': 'Name (A → Z)',
    'home.cardMeta': 'Modified {when}',
    'home.folderMeta': 'modified {when}',
    'home.folderEmpty': 'Empty · no boards',
    'home.blocks.zero': 'empty',
    'home.blocks.one': '{n} block',
    'home.blocks.other': '{n} blocks',
    'home.open': 'Open',
    'home.rename': 'Rename',
    'home.renameTitle': 'Rename the board',
    'home.duplicate': 'Duplicate',
    'home.reveal': 'Show in Explorer',
    'home.delete': 'Delete',
    'home.duplicated': 'Board duplicated',
    'home.deleteTitle': 'Delete “{name}”?',
    'home.deleteBody': 'The board folder goes to the Windows Recycle Bin, with its media and results. You can get it back from there.',
    'home.deleted': 'Board moved to the Recycle Bin',
    'home.options': 'Options',
    'home.isOpen': 'Open in a tab',
    'home.moveTo': 'Move to',
    'home.noFolder': 'No project',
    'home.newFolderDots': 'New project…',
    'home.newFolderTitle': 'New project',
    'home.newFolderBody': 'The board will be filed in it.',
    'home.create': 'Create',
    'home.movedIn': 'Filed in “{name}”',
    'home.movedOut': 'Taken out of “{name}”',
    'home.movedInAs': 'Filed in “{name}” as “{as}” (the name was taken)',
    'home.movedOutAs': 'Taken out of “{name}” as “{as}” (the name was taken)',
    'home.movedInRestored': 'Filed in “{name}”: it gets its name “{as}” back',
    'home.movedOutRestored': 'Taken out of “{name}”: it gets its name “{as}” back',
    'home.moveFailed': 'Could not move the board: {why}',
    'home.dropInto': 'File in “{name}”',
    'home.dropOut': 'Take out of the project',
    'home.back': 'Back to the projects',
    'home.folder.open': 'Open',
    'home.folder.newBoard': 'New board here',
    'home.folder.rename': 'Rename',
    'home.folder.renameTitle': 'Rename the project',
    'home.folder.color': 'Colour',
    'home.folder.reveal': 'Show in Explorer',
    'home.folder.delete': 'Delete…',
    'home.folder.deleteTitle': 'Delete the project “{name}”?',
    'home.folder.keep': 'Keep the boards',
    'home.folder.keepHint': 'Otherwise they go to the Recycle Bin with the project.',
    'home.folder.deleteKeep.one': 'Its board first comes back to “Boards”. Then the project folder goes to the Windows Recycle Bin, with everything else inside it (pictures, notes, files put there by hand). You can get it back from there.',
    'home.folder.deleteKeep.other': 'Its {n} boards first come back to “Boards”. Then the project folder goes to the Windows Recycle Bin, with everything else inside it (pictures, notes, files put there by hand). You can get it back from there.',
    'home.folder.deleteAll.one': 'The project folder goes to the Windows Recycle Bin with everything inside it: its board (media and results included) and any other file kept there. You can get everything back from there.',
    'home.folder.deleteAll.other': 'The project folder goes to the Windows Recycle Bin with everything inside it: its {n} boards (media and results included) and any other file kept there. You can get everything back from there.',
    'home.folder.deleteEmpty': 'This project has no board. Its folder goes to the Windows Recycle Bin with everything inside it (pictures, notes, files put there by hand). You can get it back from there.',
    'home.folder.deleted': 'Project moved to the Recycle Bin',
    'home.folder.default': 'New project',
    'home.folder.emptyHint': 'This project is empty: create a board here, or drag a board into it from the home page.',
    'home.folder.options': 'Project options',
    'home.folder.renameHint': 'Double-click to rename',
    'home.color.grey': 'Grey',
    'home.color.blue': 'Blue',
    'home.color.teal': 'Teal',
    'home.color.green': 'Green',
    'home.color.yellow': 'Yellow',
    'home.color.orange': 'Orange',
    'home.color.red': 'Red',
    'home.color.pink': 'Pink',
    'home.recipes': 'Start with a recipe',
    'home.recipeTip': 'Creates a board already wired',
    'home.recipeTipIn': 'Creates a board already wired in “{name}”',
    'home.dropHere': 'Drop your files',
    'home.dropSub': 'Pictures and videos: a new board  ·  LoRAs: added to Mia',
    'home.dropSubIn': 'Pictures and videos: a new board in “{name}”  ·  LoRAs: added to Mia',
    'home.notLora': 'This file is a full model, not a LoRA: put it in the engine folder.',
    'home.notRecognised': '“{name}”: file not recognised.',
    'home.modelUnreadable': 'Could not read “{name}”: {why}',
    'home.loraUnavailable': 'Adding LoRAs is not available yet in this version of Mia.',
    'home.rootMissing': 'The projects folder “{path}” cannot be found (unplugged drive, renamed folder?). Your boards were not touched.',
    'home.changeRoot': 'Change folder…',
    'home.listFailed': 'Could not read the list of boards: {why}',
    'home.actionFailed': 'The operation failed: {why}',
    'home.unknown': 'unknown reason'
  }
});

/** Recipes shown on the home page, in this order (src/catalog/recipes/<id>.json). */
const RECIPE_IDS = ['unreal-to-real', 'animate-image', 'character-performance', 'depth-video', 'cutout-character'];

const ORDERS = [
  { id: 'updated', by: (p) => -(p.updated || 0) },
  { id: 'opened', by: (p) => -(p.opened || p.updated || 0) },
  { id: 'created', by: (p) => -(p.created || 0) },
  { id: 'name', by: null }
];

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase();
const failMsg = (r) => (r && typeof r === 'object' && r.ok === false ? (r.error || t('home.unknown')) : null);
const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'fr', { sensitivity: 'base', numeric: true });

// ── project colours (SPEC §18.1): muted, Chrome-like; tokens --fc-* in app.css ──
export const FOLDER_COLORS = ['grey', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink'];
export const folderColor = (c) => (FOLDER_COLORS.includes(c) ? c : 'grey');
export const colorVar = (c) => `var(--fc-${folderColor(c)})`;

/** A colour swatch for a menu row (a ring around the current one). */
export function swatch(c, current = false) {
  const v = colorVar(c);
  return '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">'
    + `<circle cx="8" cy="8" r="${current ? 4.2 : 5}" style="fill:${v}"/>`
    + (current ? `<circle cx="8" cy="8" r="6.9" fill="none" stroke-width="1.4" style="stroke:${v}"/>` : '')
    + '</svg>';
}

/** The « Couleur › » submenu, shared by the home cards and the tab group chip. */
export function colorMenu(current, onPick) {
  const cur = folderColor(current);
  return FOLDER_COLORS.map((c) => ({ label: t('home.color.' + c), icon: swatch(c, c === cur), action: () => onPick(c) }));
}

/** The projects API of the main process (agent S, SPEC §18.2), when it is there. */
const foldersApi = () => {
  const f = window.mia?.folders;
  return f && typeof f.list === 'function' ? f : null;
};
export const foldersAvailable = () => !!foldersApi();
const canMove = () => !!foldersApi() && typeof window.mia?.projects?.move === 'function';

/** One JSON file next to index.html. ES JSON modules work over file://, fetch does not. */
export async function loadJson(rel) {
  const url = new URL('../../' + rel, import.meta.url).href;
  try {
    const mod = await import(url, { with: { type: 'json' } });
    return mod.default;
  } catch (err) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('GET', url);
      x.responseType = 'json';
      x.onload = () => (x.response ? resolve(x.response) : reject(err));
      x.onerror = () => reject(err);
      x.send();
    });
  }
}

/** Files that are models, not media (SPEC §12.5). */
export const MODEL_EXT = /\.(safetensors|ckpt|pt|pth|gguf|bin)$/i;

/**
 * Model files dropped on Mia: each one is inspected (header only); a LoRA opens
 * « Ajouter un LoRA » (library.js), anything else gets a plain sentence.
 * Exported for the board's drop (E) so both places say the same thing.
 */
export async function offerModelFiles(paths = []) {
  const inspect = window.mia?.models?.inspect;
  for (const p of paths) {
    const name = baseName(p);
    if (typeof inspect !== 'function') { toast(t('home.loraUnavailable'), { kind: 'error' }); return; }
    let info;
    try { info = await inspect(p); } catch (err) { info = { ok: false, error: err?.message }; }
    if (!info || info.ok === false) {
      toast(t('home.modelUnreadable', { name, why: info?.error || t('home.unknown') }), { kind: 'error', ms: 7000 });
      continue;
    }
    if (info.isLora) {
      let lib = null;
      try { lib = await import('./library.js'); } catch (err) { console.error('[home] library', err); }
      if (typeof lib?.openAddLora !== 'function') { toast(t('home.loraUnavailable'), { kind: 'error' }); return; }
      try { await lib.openAddLora(p, info); } catch (err) { console.error('[home] openAddLora', err); }
      continue;
    }
    const why = info.reason ? tl(info.reason) : (info.isModel ? t('home.notLora') : t('home.notRecognised', { name }));
    toast(why, { kind: 'error', ms: 7000 });
  }
}

let recipesCache = null;
/** The recipes, loaded once (a missing file is skipped, never fatal). */
export function loadRecipes() {
  if (!recipesCache) {
    recipesCache = Promise.all(RECIPE_IDS.map((id) => loadJson(`catalog/recipes/${id}.json`).catch((err) => {
      console.error(`[home] recette illisible : ${id}`, err);
      return null;
    }))).then((list) => list.filter(Boolean));
  }
  return recipesCache;
}

/**
 * @param {{ onOpen(p), onCreate({folderId}), onRecipe(recipe, {folderId}), onDropFiles(paths, {folderId}),
 *           onRenamed(id, name, r), onBeforeRemove(id), isOpen(id), onData({folders, projects}),
 *           onMoved(id, folderId, r), onBeforeRemoveFolder(folderId, keepBoards) }} cb
 */
export function initHome(cb = {}) {
  const view = $('#view-home');
  const wrap = $('.home-wrap', view);
  const grid = $('#home-grid');          // the boards (loose ones at the root, a project's inside it)
  const empty = $('#home-empty');
  const search = $('#home-search');
  const count = $('#home-count');
  const sortBtn = $('#home-sort');
  const sortLabel = $('#home-sort-label');
  const recipeHost = $('#home-recipe-list');
  const head = $('.home-head', view);
  const titleEl = $('.home-title', view);
  const newBtn = $('#home-new');
  // the title becomes a breadcrumb inside a project: the shell's static text must not overwrite it
  titleEl?.removeAttribute('data-i18n');

  let projects = [];      // every board, with folderId
  let folders = [];       // [{ id, name, color, created, updated, boards, thumbs }]
  let byFolder = new Map();   // folderId → boards
  let loaded = false;
  let rootMissing = null;     // the projects folder cannot be reached (A: projects:list → { projects, rootMissing })
  let filter = '';
  let order = ORDERS.find((o) => o.id === state.prefs.order) || ORDERS[0];
  let openFolderId = null;    // the project shown, null = the root
  let renamingCrumb = null;

  const ctrl = () => t('app.key.ctrl');
  const shift = () => t('app.key.shift');

  // files dragged over the page: a real layer over the cards, the label in a pill (readable on any thumbnail)
  const dropSub = el('span', { class: 'home-drop-sub' }, t('home.dropSub'));
  const dropVeil = el('div', { class: 'home-drop', 'aria-hidden': 'true' },
    el('div', { class: 'home-drop-pill' },
      el('span', { class: 'home-drop-title' }, t('home.dropHere')),
      dropSub
    )
  );
  view.append(dropVeil);

  // « Nouveau projet », the secondary button beside Slate's shiny « Nouvelle planche »
  const newFolderBtn = el('button', { class: 'btn', id: 'home-new-folder', type: 'button', hidden: true, onclick: () => createFolder() },
    el('span', { class: 'btn-ico', html: icon('folder', 15) }),
    el('span', {}, t('home.newFolder'))
  );
  newBtn?.before(newFolderBtn);
  tip(newFolderBtn, () => t('home.newFolder'), { key: `${ctrl()} ${shift()} N` });
  if (newBtn) tip(newBtn, () => (openFolderId ? t('home.folder.newBoard') : t('home.new')), { key: `${ctrl()} N` });

  // the projects folder is out of reach: say so, instead of « no boards yet »
  const banner = el('div', { class: 'home-banner', hidden: true, role: 'alert' },
    el('span', { class: 'home-banner-ico', html: icon('warn', 16) }),
    el('span', { class: 'home-banner-msg' }),
    el('button', { class: 'btn sm btn-ghost', type: 'button', onclick: () => refresh({ animate: true }) }, t('app.retry')),
    el('button', { class: 'btn sm', type: 'button', onclick: () => openSettings() }, t('home.changeRoot'))
  );

  // PROJETS, then PLANCHES (the boards outside any project): two kickers, Slate's grid for both
  const foldersGrid = el('div', { class: 'home-grid home-folders-grid' });
  const foldersCount = el('span', { class: 'home-part-count' });
  const foldersSec = el('section', { class: 'home-part', hidden: true },
    el('div', { class: 'home-part-head' }, el('h2', { class: 'kicker' }, t('home.folders')), foldersCount),
    foldersGrid
  );
  const boardsCount = el('span', { class: 'home-part-count' });
  // dropping a board of a project on « PLANCHES » takes it out (search results show those)
  const boardsHead = el('div', { class: 'home-part-head home-boards-head', hidden: true, dataset: { dropRoot: '' } },
    el('h2', { class: 'kicker' }, t('home.boards')), boardsCount);
  grid.before(banner, foldersSec, boardsHead);

  const artMark = $('.home-empty-mark', empty);
  if (artMark) artMark.innerHTML = logo(64, { tight: false });
  newBtn?.addEventListener('click', () => cb.onCreate?.({ folderId: openFolderId }));
  $('[data-act="new"]', empty)?.addEventListener('click', () => cb.onCreate?.({ folderId: openFolderId }));

  // ── order ──
  function applyOrder(list) {
    const copy = list.slice();
    if (order.id === 'name') copy.sort(byName);
    else copy.sort((a, b) => order.by(a) - order.by(b));
    return copy;
  }
  function paintOrder() { sortLabel.textContent = t('home.order.' + order.id); }
  function setOrder(id) {
    order = ORDERS.find((o) => o.id === id) || ORDERS[0];
    paintOrder();
    render();
    Promise.resolve(window.mia?.prefs?.set({ order: order.id }))
      .then((p) => { if (p && typeof p === 'object' && !('ok' in p)) { state.prefs = { ...state.prefs, ...p }; emit('prefs:changed', { prefs: state.prefs }); } })
      .catch((err) => console.error('[home] prefs', err));
  }
  sortBtn.addEventListener('click', () => {
    sortBtn.classList.add('on');
    openMenu(ORDERS.map((o) => ({
      label: t('home.order.' + o.id),
      checked: o.id === order.id,
      action: () => setOrder(o.id)
    })), sortBtn, { onClose: () => sortBtn.classList.remove('on') });
  });
  tip(sortBtn, () => t('home.sort'));
  paintOrder();

  // ── search ──
  search.addEventListener('input', () => { filter = search.value; render(); });
  search.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' && search.value) { e.preventDefault(); search.value = ''; filter = ''; render(); }
    else if (e.key === 'Escape') search.blur();
    if (e.key === 'Enter') {
      // Enter opens the first match: a board first, else the first project
      const first = visibleBoards()[0];
      if (first) cb.onOpen?.(first);
      else { const f = visibleFolders()[0]; if (f) openFolder(f.id); }
    }
  });

  // ── data ──
  const folderById = (id) => (id ? folders.find((f) => f.id === id) || null : null);
  const boardsOf = (id) => byFolder.get(id) || [];
  /** No block on it (the index counts them at each save); unknown counts are taken as « something ». */
  const isEmptyBoard = (p) => p?.nodes !== undefined && p?.nodes !== null && Number(p.nodes) === 0;

  /** What a project card says: its boards, when it last moved, the pictures of its latest boards. */
  function statsOf(f) {
    const list = boardsOf(f.id);
    let updated = Number(f.updated) || 0;
    let opened = 0;
    for (const p of list) {
      updated = Math.max(updated, Number(p.updated) || 0);
      opened = Math.max(opened, Number(p.opened) || Number(p.updated) || 0);
    }
    const n = list.length || (Number.isFinite(f.boards) ? f.boards : (Array.isArray(f.boards) ? f.boards.length : 0));
    const recent = list.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0));
    // the mosaic shows the boards that hold something (an empty board's picture is a black tile);
    // the main process's own list is the fallback while the boards are not known here
    const thumbs = list.length ? recent.filter((p) => p.thumb && !isEmptyBoard(p)).map((p) => p.thumb)
      : Array.isArray(f.thumbs) ? f.thumbs.filter(Boolean) : [];
    return { n, updated, opened: opened || updated, created: Number(f.created) || 0, thumbs: thumbs.slice(0, 4) };
  }

  function orderFolders(list) {
    if (order.id === 'name') return list.slice().sort(byName);
    const key = (f) => { const s = statsOf(f); return order.id === 'created' ? s.created : order.id === 'opened' ? s.opened : s.updated; };
    return list.slice().sort((a, b) => key(b) - key(a));
  }

  function visibleFolders() {
    if (openFolderId) return [];
    const q = fold(filter.trim());
    return orderFolders(q ? folders.filter((f) => fold(f.name).includes(q)) : folders);
  }

  function visibleBoards() {
    const q = fold(filter.trim());
    let list;
    if (openFolderId) list = boardsOf(openFolderId);
    // at the root, a search looks into the projects too (the card says which one)
    else if (q) list = projects;
    else list = projects.filter((p) => !p.folderId || !folderById(p.folderId));
    return applyOrder(q ? list.filter((p) => fold(p.name).includes(q)) : list);
  }

  async function refresh({ animate = false } = {}) {
    const api = foldersApi();
    const [res, fres] = await Promise.all([
      Promise.resolve().then(() => window.mia.projects.list()).catch((err) => ({ ok: false, error: err?.message })),
      api ? Promise.resolve().then(() => api.list()).catch((err) => { console.error('[home] folders.list', err); return null; }) : null
    ]);
    try {
      // the main process may wrap the list to say its folder is missing
      const list = Array.isArray(res) ? res : (res && Array.isArray(res.projects) ? res.projects : (res && Array.isArray(res.boards) ? res.boards : null));
      if (!list) throw new Error(failMsg(res) || t('home.unknown'));
      rootMissing = !Array.isArray(res) && res.rootMissing ? String(res.rootMissing) : null;
      projects = list;
      loaded = true;
    } catch (err) {
      console.error('[home] projects.list', err);
      toast(t('home.listFailed', { why: err?.message || t('home.unknown') }), { kind: 'error' });
    }
    const flist = Array.isArray(fres) ? fres : (fres && Array.isArray(fres.folders) ? fres.folders
      : (res && Array.isArray(res.folders) ? res.folders : null));
    if (flist) folders = flist.filter((f) => f && f.id);
    else if (!api) folders = [];
    byFolder = new Map();
    for (const p of projects) {
      if (!p.folderId) continue;
      if (!byFolder.has(p.folderId)) byFolder.set(p.folderId, []);
      byFolder.get(p.folderId).push(p);
    }
    if (openFolderId && loaded && !folderById(openFolderId)) openFolderId = null;   // gone meanwhile
    try { cb.onData?.({ folders: folders.slice(), projects: projects.slice() }); } catch (err) { console.error('[home] onData', err); }
    render({ animate });
    return projects;
  }

  // ── drawing ──
  function paintTitle(folder) {
    if (!titleEl) return;
    if (renamingCrumb) return;
    if (!folder) {
      titleEl.classList.remove('crumbs');
      titleEl.textContent = t('home.title');
      return;
    }
    titleEl.classList.add('crumbs');
    const root = el('button', {
      class: 'crumb-root', type: 'button', dataset: { dropRoot: '' },
      onclick: () => openFolder(null)
    }, t('home.title'));
    tip(root, () => t('home.back'), { key: t('app.key.esc') });
    const name = el('span', { class: 'crumb-name' }, folder.name);
    tip(name, () => t('home.folder.renameHint'));
    name.addEventListener('dblclick', (e) => { e.preventDefault(); startCrumbRename(); });
    const more = el('button', {
      class: 'crumb-more', type: 'button', html: icon('more', 16), 'aria-label': t('home.folder.options'),
      onclick: (e) => { e.stopPropagation(); folderMenu(folder, more); }
    });
    tip(more, () => t('home.folder.options'));
    titleEl.replaceChildren(
      root,
      el('span', { class: 'crumb-sep', html: icon('chevron-right', 18) }),
      el('span', { class: 'crumb-cur', style: { '--fc': colorVar(folder.color) } }, el('span', { class: 'crumb-dot' }), name),
      more
    );
  }

  /** Les cartes affichées, avec une clé stable (planche, projet, carte « + »). */
  function cardItems() {
    const out = [];
    for (const n of [...foldersGrid.children, ...grid.children]) {
      const key = n.dataset.folder ? `f:${n.dataset.folder}` : n.dataset.id ? `b:${n.dataset.id}` : n.classList.contains('card-new') ? 'new' : null;
      if (key) out.push({ key, el: n });
    }
    return out;
  }
  let shownFolder;          // le projet affiché au dernier dessin (FLIP seulement dans la même vue)
  let hold = null;          // une carte en train de sortir : le dessin suivant de la même page l'attend (holdRender)

  function render({ animate = false } = {}) {
    if (hold && shownFolder === openFolderId) { hold.args = { animate: animate || !!hold.args?.animate }; return; }
    hold = null;
    const folder = folderById(openFolderId);
    // une carte qui part, arrive ou change de place glisse (FLIP) — pas pendant la cascade d'arrivée
    const first = !animate && shownFolder === openFolderId && !view.closest('[hidden]') ? rects(cardItems()) : null;
    shownFolder = openFolderId;
    const q = filter.trim();
    const withFolders = foldersAvailable();
    paintTitle(folder);
    newFolderBtn.hidden = !withFolders || !!folder;
    view.classList.toggle('in-folder', !!folder);

    banner.hidden = !rootMissing;
    if (rootMissing) $('.home-banner-msg', banner).textContent = t('home.rootMissing', { path: rootMissing });

    grid.innerHTML = '';
    foldersGrid.innerHTML = '';
    const fl = visibleFolders();
    const bl = visibleBoards();

    // the line under the title
    let sub = '';
    if (folder) {
      const s = statsOf(folder);
      sub = s.n ? `${tn('home.count.boards', s.n)} · ${t('home.folderMeta', { when: relTime(s.updated || s.created) })}` : t('home.folderEmpty');
      if (q) sub += ' · ' + tn('home.results', bl.length);
    } else if (projects.length || folders.length) {
      const parts = [];
      if (folders.length) parts.push(tn('home.count.folders', folders.length));
      parts.push(tn('home.count.boards', projects.length));
      sub = parts.join(' · ') + (q ? ' · ' + tn('home.results', fl.length + bl.length) : '');
    }
    count.textContent = sub;
    // no subtitle: the title and the buttons share one centre line (Slate's empty home)
    head?.classList.toggle('no-sub', !count.textContent);

    const none = loaded && !folder && projects.length === 0 && folders.length === 0 && !rootMissing;
    empty.hidden = !none;
    grid.hidden = none;
    if (none) { foldersSec.hidden = true; boardsHead.hidden = true; replay(animate); return; }

    let i = 0;
    // PROJETS — only once there is one (a first-time home stays Slate's plain gallery)
    foldersSec.hidden = !!folder || !fl.length;
    foldersCount.textContent = q ? '' : String(folders.length);
    for (const f of fl) foldersGrid.append(folderCard(f, Math.min(i++, 12)));

    // PLANCHES — titled only when the projects are above it
    boardsHead.hidden = !!folder || foldersSec.hidden;
    const loose = projects.filter((p) => !p.folderId || !folderById(p.folderId)).length;
    boardsCount.textContent = q ? '' : String(loose);
    if (!q) {
      const add = el('button', {
        class: 'card-new', type: 'button', style: { '--i': Math.min(i++, 12) },
        onclick: () => cb.onCreate?.({ folderId: openFolderId })
      },
        el('span', { html: icon('plus', 18) }),
        el('span', {}, t('home.new'))
      );
      grid.append(add);
    }
    for (const p of bl) grid.append(card(p, Math.min(i++, 12)));
    if (folder && !q && !bl.length) grid.append(el('div', { class: 'home-hint' }, t('home.folder.emptyHint')));
    grid.hidden = false;
    if (q && !bl.length) {
      // projects matched, boards did not: no empty « PLANCHES » under them
      if (fl.length) { grid.hidden = true; boardsHead.hidden = true; }
      else grid.append(el('div', { class: 'home-none' }, t('home.none', { q })));
    }
    replay(animate);
    if (first && first.size) {
      // une carte neuve (projet créé, planche dupliquée) naît à sa place ; les autres glissent
      flip(first, cardItems(), {
        dur: 'enter', easing: 'out',
        enter: (n) => play(n, [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], { dur: 'enter', easing: 'out' })
      });
    }
  }

  // cards arrive once, when the page is shown — not on every keystroke
  function replay(animate) {
    if (!animate) return;
    wrap.classList.remove('home-anim');
    void wrap.offsetWidth;
    wrap.classList.add('home-anim');
    clearTimeout(wrap._animTimer);
    wrap._animTimer = setTimeout(() => wrap.classList.remove('home-anim'), ms('card') + 13 * ms('stagger') + 120);
  }

  // ── a project card: 2×2 pictures of its latest boards, its colour, its name ──
  function folderCard(f, i) {
    const s = statsOf(f);
    const n = Math.min(4, s.thumbs.length);
    const thumb = el('div', { class: ['card-thumb', 'fthumb', 'n' + n] });
    if (!n) thumb.append(el('div', { class: 'card-empty-glyph', html: icon('folder', 24) }));
    for (const url of s.thumbs.slice(0, 4)) {
      const img = el('img', { src: url, alt: '', draggable: 'false', decoding: 'async', loading: 'lazy' });
      img.addEventListener('error', () => img.replaceWith(el('span', { class: 'fthumb-blank' })), { once: true });
      thumb.append(img);
    }
    const more = el('button', {
      class: 'card-more', type: 'button', html: icon('more-v', 16), 'aria-label': t('home.folder.options'),
      onclick: (e) => { e.stopPropagation(); folderMenu(f, more); }
    });
    tip(more, () => t('home.folder.options'));
    const meta = s.n ? `${tn('home.count.boards', s.n)} · ${t('home.folderMeta', { when: relTime(s.updated || s.created) })}` : t('home.folderEmpty');
    const node = el('div', {
      class: 'card folder-card', style: { '--i': i, '--fc': colorVar(f.color) },
      dataset: { folder: f.id }, tabindex: '0', role: 'button'
    },
      thumb,
      el('div', { class: 'card-body' },
        el('div', { class: 'card-meta' },
          el('div', { class: 'card-name' }, el('span', { class: 'fdot' }), el('span', { class: 'card-name-text' }, f.name)),
          el('div', { class: 'card-date' }, meta)
        ),
        more
      )
    );
    const nameEl = $('.card-name-text', node);
    tip(nameEl, () => (isCut(nameEl) ? f.name : ''));
    node.addEventListener('click', (e) => { if (e.detail <= 1 && !more.contains(e.target)) openFolder(f.id); });
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFolder(f.id); }
      if (e.key === 'F2') { e.preventDefault(); renameFolder(f.id); }
      if (e.key === 'Delete') { e.preventDefault(); removeFolder(f.id); }
    });
    node.addEventListener('contextmenu', (e) => { e.preventDefault(); folderMenu(f, { x: e.clientX, y: e.clientY }); });
    return node;
  }

  // ── a board card ──
  function card(p, i) {
    const thumb = el('div', { class: 'card-thumb' });
    const glyph = () => el('div', { class: 'card-empty-glyph', html: icon('grid', 22) });
    // an empty board keeps the dotted card with its glyph, never a picture of an empty canvas
    if (p.thumb && !isEmptyBoard(p)) {
      const img = el('img', { src: p.thumb, alt: '', draggable: 'false', decoding: 'async', loading: 'lazy' });
      img.addEventListener('error', () => img.replaceWith(glyph()), { once: true });
      thumb.append(img);
    } else {
      thumb.append(glyph());
    }

    const more = el('button', {
      class: 'card-more', type: 'button', html: icon('more-v', 16), 'aria-label': t('home.options'),
      onclick: (e) => { e.stopPropagation(); menuFor(p, more); }
    });
    tip(more, () => t('home.options'));

    const nodes = Number(p.nodes) || 0;
    const meta = [t('home.cardMeta', { when: relTime(p.updated || p.created) })];
    if (nodes) meta.push(tn('home.blocks', nodes));
    // a search at the root shows boards of every project: say which one
    const f = !openFolderId && p.folderId ? folderById(p.folderId) : null;

    const open = !!cb.isOpen?.(p.id);
    const node = el('div', { class: ['card', 'board-card', open && 'is-open'], style: { '--i': i }, dataset: { id: p.id }, tabindex: '0', role: 'button' },
      thumb,
      el('div', { class: 'card-body' },
        el('div', { class: 'card-meta' },
          el('div', { class: 'card-name' }, p.name),
          el('div', { class: 'card-date' },
            f ? el('span', { class: 'card-folder', style: { '--fc': colorVar(f.color) } }, el('span', { class: 'fdot' }), el('span', { class: 'card-folder-name' }, f.name)) : null,
            el('span', { class: 'card-when' }, meta.join(' · ')))
        ),
        more
      )
    );
    // the full name when the card had to cut it (and whether it has a tab)
    const nameEl = $('.card-name', node);
    tip(nameEl, () => {
      const cut = isCut(nameEl);
      if (cut) return p.name + (open ? ' · ' + t('home.isOpen') : '');
      return open ? t('home.isOpen') : '';
    });
    // recherche à la racine : le nom du projet, entier, quand la pastille a dû le couper
    const folderName = $('.card-folder-name', node);
    if (folderName) tip(folderName, () => (folderName.scrollWidth > folderName.clientWidth + 1 ? f.name : ''));
    node.addEventListener('click', (e) => {
      if (swallowClick) return;
      if (e.detail <= 1 && !more.contains(e.target)) cb.onOpen?.(p);
    });
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cb.onOpen?.(p); }
      if (e.key === 'F2') { e.preventDefault(); rename(p); }
      if (e.key === 'Delete') { e.preventDefault(); remove(p); }
    });
    node.addEventListener('contextmenu', (e) => { e.preventDefault(); menuFor(p, { x: e.clientX, y: e.clientY }); });
    armDrag(node, p);
    return node;
  }

  function moveItems(p) {
    if (!canMove()) return null;
    const cur = p.folderId && folderById(p.folderId) ? p.folderId : null;
    const items = folders.slice().sort(byName).map((f) => ({
      label: f.name, icon: swatch(f.color, f.id === cur), disabled: f.id === cur,
      action: () => moveBoard(p, f.id)
    }));
    if (items.length) items.push('sep');
    items.push({ label: t('home.newFolderDots'), icon: 'plus', action: () => moveToNewFolder(p) });
    items.push({ label: t('home.noFolder'), checked: !cur, disabled: !cur, action: () => moveBoard(p, null) });
    return { label: t('home.moveTo'), icon: 'folder', submenu: items };
  }

  function menuFor(p, at) {
    const anchor = at?.nodeType === 1 ? at : null;
    anchor?.classList.add('on');
    openMenu([
      { label: t('home.open'), icon: 'arrow-right', key: t('app.key.enter'), action: () => cb.onOpen?.(p) },
      { label: t('home.rename'), icon: 'edit', key: 'F2', action: () => rename(p) },
      { label: t('home.duplicate'), icon: 'duplicate', action: () => duplicate(p) },
      moveItems(p),
      'sep',
      { label: t('home.reveal'), icon: 'reveal', action: () => reveal(p) },
      'sep',
      { label: t('home.delete'), icon: 'trash', key: t('app.key.del'), danger: true, action: () => remove(p) }
    ], at, { align: anchor ? 'end' : 'start', onClose: () => anchor?.classList.remove('on') });
  }

  function folderMenu(f, at) {
    const anchor = at?.nodeType === 1 ? at : null;
    anchor?.classList.add('on');
    const inside = openFolderId === f.id;
    openMenu([
      inside ? null : { label: t('home.folder.open'), icon: 'arrow-right', key: t('app.key.enter'), action: () => openFolder(f.id) },
      { label: t('home.folder.newBoard'), icon: 'plus', key: inside ? `${ctrl()} N` : null, action: () => cb.onCreate?.({ folderId: f.id }) },
      'sep',
      { label: t('home.folder.rename'), icon: 'edit', key: inside ? null : 'F2', action: () => (inside ? startCrumbRename() : renameFolder(f.id)) },
      { label: t('home.folder.color'), icon: swatch(f.color), submenu: colorMenu(f.color, (c) => setFolderColor(f.id, c)) },
      'sep',
      { label: t('home.folder.reveal'), icon: 'reveal', action: () => revealFolder(f.id) },
      'sep',
      { label: t('home.folder.delete'), icon: 'trash', key: inside ? null : t('app.key.del'), danger: true, action: () => removeFolder(f.id) }
    ], at, { align: anchor ? 'end' : 'start', onClose: () => anchor?.classList.remove('on') });
  }

  // ── board actions ──
  async function rename(p) {
    const name = await prompt({ title: t('home.renameTitle'), value: p.name, ok: t('home.rename'), maxLength: 120 });
    if (!name || name === p.name) return;
    const r = await window.mia.projects.rename(p.id, name).catch((err) => ({ ok: false, error: err?.message }));
    const why = failMsg(r);
    if (why) return toast(t('home.actionFailed', { why }), { kind: 'error' });
    const finalName = (r && typeof r === 'object' && r.name) || name;
    cb.onRenamed?.(p.id, finalName, r);
    await refresh();
  }

  async function duplicate(p) {
    const r = await window.mia.projects.duplicate(p.id).catch((err) => ({ ok: false, error: err?.message }));
    const why = failMsg(r);
    if (why) return toast(t('home.actionFailed', { why }), { kind: 'error' });
    await refresh();
    toast(t('home.duplicated'), { kind: 'ok' });
  }

  async function reveal(p) {
    const r = await window.mia.projects.reveal(p.id).catch((err) => ({ ok: false, error: err?.message }));
    const why = failMsg(r);
    if (why) toast(t('home.actionFailed', { why }), { kind: 'error' });
  }

  async function remove(p) {
    const ok = await confirm({
      title: t('home.deleteTitle', { name: p.name }),
      body: t('home.deleteBody'),
      ok: t('home.delete'), danger: true
    });
    if (!ok) return;
    await cb.onBeforeRemove?.(p.id);
    const r = await window.mia.projects.remove(p.id).catch((err) => ({ ok: false, error: err?.message }));
    const why = failMsg(r);
    if (why) return toast(t('home.actionFailed', { why }), { kind: 'error' });
    await refresh();
    toast(t('home.deleted'));
  }

  /** File a board in a project (null = out of any project). Returns true when it moved. */
  async function moveBoard(p, folderId, { undo = true } = {}) {
    if (!canMove()) return false;
    const board = typeof p === 'string' ? projects.find((x) => x.id === p) : p;
    if (!board) return false;
    const from = board.folderId && folderById(board.folderId) ? board.folderId : null;
    const to = folderId || null;
    if (from === to) return false;
    const r = await Promise.resolve().then(() => window.mia.projects.move(board.id, to)).catch((err) => ({ ok: false, error: err?.message }));
    const why = failMsg(r);
    if (why || r == null) {
      toast(t('home.moveFailed', { why: why || t('home.unknown') }), { kind: 'error', ms: 7000 });
      return false;
    }
    const target = folderById(to);
    const source = folderById(from);
    try { cb.onMoved?.(board.id, to, r); } catch (err) { console.error('[home] onMoved', err); }
    await refresh();
    // renommée en route (store.js : renamedFrom / nameRestored) : on dit sous quel nom elle arrive
    const name = to ? target?.name || '' : source?.name || '';
    const as = r && typeof r === 'object' && r.renamedFrom && r.name && r.name !== r.renamedFrom ? r.name : null;
    const key = (to ? 'home.movedIn' : 'home.movedOut') + (as ? (r.nameRestored ? 'Restored' : 'As') : '');
    const msg = t(key, { name, as });
    toast(msg, {
      kind: 'ok',
      action: undo ? { label: t('app.undo'), run: () => moveBoard(board.id, from, { undo: false }) } : null
    });
    return true;
  }

  async function moveToNewFolder(p) {
    const name = await prompt({ title: t('home.newFolderTitle'), body: t('home.newFolderBody'), value: t('home.folder.default'), ok: t('home.create'), maxLength: 120 });
    if (!name) return;
    const f = await createFolder({ name, open: false, rename: false });
    if (f?.id) await moveBoard(p, f.id);
  }

  // ── project actions ──
  async function createFolder({ name = null, open = true, rename: thenRename = true } = {}) {
    const api = foldersApi();
    if (!api) return null;
    const r = await Promise.resolve().then(() => api.create({ name: name || t('home.folder.default') })).catch((err) => ({ ok: false, error: err?.message }));
    const why = failMsg(r);
    const id = r && typeof r === 'object' ? (r.id || r.folder?.id) : null;
    if (why || !id) {
      toast(t('home.actionFailed', { why: why || t('home.unknown') }), { kind: 'error' });
      return null;
    }
    await refresh();
    if (open) {
      // the page really shows the project (View Transition update included) before its name turns into a field
      await openFolder(id);
      if (thenRename && openFolderId === id) startCrumbRename();
    }
    return folderById(id) || { id, name: r.name || r.folder?.name || name };
  }

  async function renameFolder(id, value = null) {
    const api = foldersApi();
    const f = folderById(id);
    if (!api || !f) return false;
    const name = value ?? await prompt({ title: t('home.folder.renameTitle'), value: f.name, ok: t('home.rename'), maxLength: 120 });
    if (!name || name.trim() === f.name) return false;
    const r = await Promise.resolve().then(() => api.rename(id, name.trim())).catch((err) => ({ ok: false, error: err?.message }));
    const why = failMsg(r);
    if (why) { toast(t('home.actionFailed', { why }), { kind: 'error' }); return false; }
    await refresh();
    return true;
  }

  async function setFolderColor(id, color) {
    const api = foldersApi();
    const f = folderById(id);
    if (!api || !f || typeof api.setColor !== 'function') return false;
    f.color = color;   // the card and the tabs follow at once; the list confirms
    render();
    try { cb.onData?.({ folders: folders.slice(), projects: projects.slice() }); } catch { /* the refresh repaints */ }
    const r = await Promise.resolve().then(() => api.setColor(id, color)).catch((err) => ({ ok: false, error: err?.message }));
    const why = failMsg(r);
    if (why) toast(t('home.actionFailed', { why }), { kind: 'error' });
    await refresh();
    return !why;
  }

  async function revealFolder(id) {
    const api = foldersApi();
    if (!api || typeof api.reveal !== 'function') return;
    const r = await Promise.resolve().then(() => api.reveal(id)).catch((err) => ({ ok: false, error: err?.message }));
    const why = failMsg(r);
    if (why) toast(t('home.actionFailed', { why }), { kind: 'error' });
  }

  /** « Supprimer le projet » with the « Garder les planches » choice, on by default. */
  function askRemoveFolder(f, n) {
    let keep = true;
    let handle = null;
    const body = el('p', {});
    const paint = () => {
      body.textContent = !n ? t('home.folder.deleteEmpty') : tn(keep ? 'home.folder.deleteKeep' : 'home.folder.deleteAll', n);
    };
    const sw = toggle({ value: true, label: { fr: t('home.folder.keep'), en: t('home.folder.keep') }, onChange: (v) => { keep = v; paint(); } });
    const row = el('div', { class: 'modal-choice' },
      el('div', { class: 'modal-choice-text' },
        el('div', { class: 'modal-choice-name' }, t('home.folder.keep')),
        el('div', { class: 'modal-choice-hint' }, t('home.folder.keepHint'))
      ),
      sw
    );
    row.addEventListener('click', (e) => { if (!sw.contains(e.target)) sw.click(); });
    paint();
    const no = el('button', { class: 'btn btn-ghost', type: 'button', dataset: { autofocus: '' }, onclick: () => handle.close(null) }, t('app.cancel'));
    const yes = el('button', { class: 'btn btn-danger', type: 'button', onclick: () => handle.close({ keepBoards: keep }) }, t('home.delete'));
    const content = el('div', {},
      el('h2', {}, t('home.folder.deleteTitle', { name: f.name })),
      body,
      n ? row : null,
      el('div', { class: 'modal-actions' }, no, yes)
    );
    handle = openModal(content);
    return handle.result.then((v) => (v && typeof v === 'object' ? v : null));
  }

  async function removeFolder(id) {
    const api = foldersApi();
    const f = folderById(id);
    if (!api || !f) return false;
    const n = statsOf(f).n;
    const choice = await askRemoveFolder(f, n);
    if (!choice) return false;
    const keepBoards = !n || choice.keepBoards !== false;
    try { await cb.onBeforeRemoveFolder?.(id, keepBoards); } catch (err) { console.error('[home] onBeforeRemoveFolder', err); }
    const r = await Promise.resolve().then(() => api.remove(id, { keepBoards })).catch((err) => ({ ok: false, error: err?.message }));
    const why = failMsg(r);
    if (why) { toast(t('home.actionFailed', { why }), { kind: 'error', ms: 7000 }); await refresh(); return false; }
    if (openFolderId === id) openFolderId = null;
    await refresh();
    toast(t('home.folder.deleted'));
    return true;
  }

  // ── navigation between the root and a project ──
  /** Show a project (null = the root). Resolves once the page shows it (the View Transition's update done). */
  function openFolder(id) {
    const next = id && folderById(id) ? id : null;
    if (renamingCrumb) stopCrumbRename(false);
    closeMenu();
    hideTip();
    const changed = next !== openFolderId;
    const from = openFolderId;
    const go = (animate) => {
      openFolderId = next;
      if (changed && filter) { search.value = ''; filter = ''; }
      render({ animate });
      if (changed) view.scrollTop = 0;
      emit('home:folder', { folderId: openFolderId });
    };
    // entrer dans un projet / en sortir : transition partagée (SPEC §20.1) — le nom et la pastille
    // de couleur de la carte deviennent ceux du fil d'Ariane, la page glisse dessous
    if (!changed || reduced() || typeof document.startViewTransition !== 'function' || view.hidden) { go(changed); return Promise.resolve(); }
    const fid = next || from;
    const pair = (on) => {
      const card = foldersGrid.querySelector(`[data-folder="${CSS.escape(fid)}"]`);
      const nameA = card && $('.card-name-text', card), dotA = card && $('.fdot', card);
      const nameB = titleEl && $('.crumb-name', titleEl), dotB = titleEl && $('.crumb-dot', titleEl);
      for (const [n, v] of [[nameA, 'mia-fname'], [dotA, 'mia-fdot'], [nameB, 'mia-fname'], [dotB, 'mia-fdot']]) {
        if (n) n.style.viewTransitionName = on && n.isConnected ? v : '';
      }
    };
    // la carte visée doit être à l'écran pour partir d'elle (sinon : simple fondu de page)
    const cardOnScreen = () => {
      const card = foldersGrid.querySelector(`[data-folder="${CSS.escape(fid)}"]`);
      const r = card?.getBoundingClientRect();
      return !!r && r.bottom > 0 && r.top < window.innerHeight;
    };
    document.documentElement.classList.add('vt-home');
    if (!next || cardOnScreen()) pair(true);
    const done = viewTransition(() => {
      pair(false);
      go(false);
      if (next || cardOnScreen()) pair(true);
    });
    done.finally(() => {
      setTimeout(() => { pair(false); document.documentElement.classList.remove('vt-home'); }, ms('card') + 80);
    });
    return done;
  }

  // the project's name in the breadcrumb, renamed in place (double-click, or right after « Nouveau projet »)
  function startCrumbRename() {
    const f = folderById(openFolderId);
    const name = titleEl && $('.crumb-name', titleEl);
    if (!f || !name) return;
    const input = el('input', {
      class: 'crumb-input', type: 'text', value: f.name, spellcheck: 'false', autocomplete: 'off', maxlength: '120'
    });
    // la largeur du nom (et la place du curseur) : rien ne bouge autour quand le champ remplace le titre
    input.style.width = Math.max(140, name.offsetWidth + 6) + 'px';
    renamingCrumb = { id: f.id, input, name };
    name.replaceWith(input);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); stopCrumbRename(true); }
      if (e.key === 'Escape') { e.preventDefault(); stopCrumbRename(false); }
    });
    input.addEventListener('input', () => { input.style.width = Math.max(140, measure(input.value) + 6) + 'px'; });
    input.addEventListener('blur', () => stopCrumbRename(true));
    input.focus();
    input.select();
  }
  const measurer = el('span', { class: 'crumb-measure', 'aria-hidden': 'true' });
  function measure(text) {
    if (!measurer.isConnected) titleEl.append(measurer);
    measurer.textContent = text;
    return measurer.offsetWidth;
  }
  function stopCrumbRename(commit) {
    const r = renamingCrumb;
    if (!r) return;
    renamingCrumb = null;
    const value = r.input.value.trim();
    if (r.input.isConnected) r.input.replaceWith(r.name);
    measurer.remove();
    const f = folderById(r.id);
    if (commit && f && value && value !== f.name) {
      r.name.textContent = value;
      renameFolder(r.id, value);
    } else render();
  }

  // Esc, Backspace, Alt+← or the mouse's back button: out of the project
  window.addEventListener('keydown', (e) => {
    if (state.view !== 'home' || !openFolderId || e.defaultPrevented) return;
    if (drag || renamingCrumb || isModalOpen() || isMenuOpen() || isTyping()) return;
    const back = (e.key === 'Escape' && !e.ctrlKey && !e.altKey) || (e.key === 'Backspace' && !e.ctrlKey && !e.altKey)
      || (e.altKey && e.key === 'ArrowLeft');
    if (back) { e.preventDefault(); openFolder(null); }
  });
  view.addEventListener('mouseup', (e) => {
    if (e.button === 3 && openFolderId && !drag) { e.preventDefault(); openFolder(null); }
  });

  // ── dragging a board card onto a project (or out of it) ──
  let drag = null;
  let swallowClick = false;

  function armDrag(node, p) {
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !canMove() || drag || e.target.closest('.card-more')) return;
      const sx = e.clientX;
      const sy = e.clientY;
      const pid = e.pointerId;
      const onMove = (ev) => {
        if (ev.pointerId !== pid) return;
        if (!drag) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
          beginDrag(p, node);
        }
        moveDrag(ev.clientX, ev.clientY);
      };
      const end = (ev, cancel) => {
        if (ev.pointerId !== pid) return;
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onCancel, true);
        if (drag) finishDrag(!cancel);
      };
      const onUp = (ev) => end(ev, false);
      const onCancel = (ev) => end(ev, true);
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onCancel, true);
    });
  }

  function beginDrag(p, node) {
    hideTip();
    closeMenu();
    const src = $('.card-thumb img', node)?.getAttribute('src');
    const hint = el('span', { class: 'drag-ghost-hint' });
    const ghost = el('div', { class: 'drag-ghost', 'aria-hidden': 'true' },
      el('span', { class: 'drag-ghost-thumb' }, src ? el('img', { src, alt: '', draggable: 'false' }) : el('span', { html: icon('grid', 14) })),
      el('span', { class: 'drag-ghost-text' }, el('span', { class: 'drag-ghost-name' }, p.name), hint)
    );
    document.body.append(ghost);
    node.classList.add('dragging');
    document.body.classList.add('card-dragging');
    drag = { p, node, ghost, hint, target: null, x: 0, y: 0, scroll: 0, raf: 0 };
    window.addEventListener('keydown', onDragKey, true);
  }

  function onDragKey(e) {
    if (!drag || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    finishDrag(false);
  }

  /** The project (or the root) under the pointer, if the board can go there. */
  function dropTargetAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    const node = hit?.closest?.('[data-folder], [data-drop-root]');
    if (!node || !view.contains(node)) return null;
    const from = drag.p.folderId && folderById(drag.p.folderId) ? drag.p.folderId : null;
    if (node.dataset.folder !== undefined) {
      const id = node.dataset.folder;
      return id && id !== from ? { node, folderId: id } : null;
    }
    return from ? { node, folderId: null } : null;
  }

  function moveDrag(x, y) {
    if (!drag) return;
    drag.x = x;
    drag.y = y;
    drag.ghost.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 12)}px)`;
    const tgt = dropTargetAt(x, y);
    if (tgt?.node !== drag.target?.node) {
      drag.target?.node.classList.remove('drop-on');
      tgt?.node.classList.add('drop-on');
      drag.target = tgt;
      const fromName = folderById(drag.p.folderId)?.name || '';
      drag.hint.textContent = !tgt ? '' : tgt.folderId ? t('home.dropInto', { name: folderById(tgt.folderId)?.name || '' }) : t('home.dropOut', { name: fromName });
      drag.ghost.classList.toggle('has-target', !!tgt);
    }
    // near the top or the bottom of the page, it scrolls (the projects are at the top)
    const top = (document.getElementById('titlebar')?.offsetHeight || 44) + 40;
    const bottom = window.innerHeight - 40;
    drag.scroll = y < top ? -Math.min(18, (top - y) / 2 + 4) : y > bottom ? Math.min(18, (y - bottom) / 2 + 4) : 0;
    if (drag.scroll && !drag.raf) {
      const step = () => {
        if (!drag || !drag.scroll) { if (drag) drag.raf = 0; return; }
        view.scrollTop += drag.scroll;
        moveDrag(drag.x, drag.y);
        drag.raf = requestAnimationFrame(step);
      };
      drag.raf = requestAnimationFrame(step);
    }
  }

  function finishDrag(commit) {
    const d = drag;
    if (!d) return;
    drag = null;
    window.removeEventListener('keydown', onDragKey, true);
    cancelAnimationFrame(d.raf);
    d.target?.node.classList.remove('drop-on');
    document.body.classList.remove('card-dragging');
    // dropped on a project: the card leaves from its dimmed look (never back to full light first)
    const leaving = commit && d.target;
    if (!leaving) d.node.classList.remove('dragging');
    if (commit && d.target && !reduced()) {
      // la carte du projet « aspire » la planche : la vignette glisse vers son centre en rapetissant
      const tr = d.target.node.getBoundingClientRect(), gr = d.ghost.getBoundingClientRect();
      const dx = tr.left + tr.width / 2 - (gr.left + gr.width / 2), dy = tr.top + tr.height / 2 - (gr.top + gr.height / 2);
      const base = d.ghost.style.transform || '';
      const a = play(d.ghost, [
        { transform: base, opacity: 1 },
        { transform: `${base} translate(${Math.round(dx)}px, ${Math.round(dy)}px) scale(0.9)`, opacity: 0 }
      ], { dur: 'exit', easing: 'in', fill: 'forwards' });
      if (a) a.finished.then(() => d.ghost.remove(), () => d.ghost.remove());
      else d.ghost.remove();
      play(d.target.node, [{ transform: 'none' }, { transform: 'scale(1.012)' }, { transform: 'none' }], { dur: 'pulse', easing: 'out', delay: ms('exit') * 0.6 });
    } else d.ghost.remove();
    // the click that ends a drag is not a click on the card
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 0);
    if (leaving) {
      // it fades and shrinks where it stood; the grid redraws (and closes the gap, FLIP) only once it is gone
      const out = play(d.node, [{ opacity: 0.35, transform: 'none' }, { opacity: 0, transform: 'scale(0.94)' }], { dur: 'exit', easing: 'in', fill: 'forwards' });
      holdRender(out ? out.finished : null);
      moveBoard(d.p, d.target.folderId).then((ok) => {
        if (ok) return;
        try { out?.cancel(); } catch { /* already gone */ }
        d.node.classList.remove('dragging');
      });
    }
  }

  // a card on its way out: the next drawing of the same page waits for its exit (at most --dur-exit + a frame or two)
  function holdRender(finished) {
    if (!finished) return;
    const h = { args: null };
    hold = h;
    const release = () => {
      if (hold !== h) return;
      hold = null;
      if (h.args) render(h.args);
    };
    Promise.race([finished, new Promise((r) => setTimeout(r, ms('exit') + 120))]).then(release, release);
  }

  // ── recipes ──
  async function renderRecipes() {
    if (!recipeHost) return;
    const list = await loadRecipes();
    recipeHost.innerHTML = '';
    $('#home-recipes').hidden = !list.length;
    list.forEach((r, i) => {
      const b = el('button', { class: 'recipe', type: 'button', style: { '--i': Math.min(i + 3, 12) }, onclick: () => cb.onRecipe?.(r, { folderId: openFolderId }) },
        // the block glyphs arrive with the board's catalog; until then, the generic one
        el('span', { class: 'recipe-ico', html: icon(hasIcon(r.icon) ? r.icon : 'recipe', 18) }),
        el('span', { class: 'recipe-text' },
          el('span', { class: 'recipe-name' }, tl(r.label)),
          el('span', { class: 'recipe-desc' }, tl(r.desc))
        )
      );
      tip(b, () => {
        const f = folderById(openFolderId);
        return f ? t('home.recipeTipIn', { name: f.name }) : t('home.recipeTip');
      });
      recipeHost.append(b);
    });
  }

  // ── files dropped on the home page become a new board (in the project shown) ──
  let depth = 0;
  const carrying = (dt) => !!dt && [...(dt.types || [])].includes('Files');
  view.addEventListener('dragenter', (e) => {
    if (!carrying(e.dataTransfer)) return;
    e.preventDefault();
    if (depth++ === 0) {
      const f = folderById(openFolderId);
      dropSub.textContent = f ? t('home.dropSubIn', { name: f.name }) : t('home.dropSub');
    }
    view.classList.add('drop-here');
  });
  view.addEventListener('dragover', (e) => {
    if (!carrying(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  view.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; view.classList.remove('drop-here'); } });
  view.addEventListener('drop', (e) => {
    if (!carrying(e.dataTransfer)) return;
    e.preventDefault();
    depth = 0;
    view.classList.remove('drop-here');
    const paths = [...(e.dataTransfer.files || [])].map((f) => window.mia?.media?.pathFor?.(f)).filter(Boolean);
    // models (LoRA…) are offered to the library; pictures and videos make a new board
    const models = paths.filter((x) => MODEL_EXT.test(x));
    const media = paths.filter((x) => !MODEL_EXT.test(x));
    if (media.length) cb.onDropFiles?.(media, { folderId: openFolderId });
    if (models.length) offerModelFiles(models);
  });

  renderRecipes();

  return {
    refresh,
    render: () => render(),
    renderRecipes,
    projects: () => projects.slice(),
    folders: () => folders.slice(),
    folder: (id) => folderById(id),
    /** the project shown on the home page (null = the root) */
    folderId: () => openFolderId,
    openFolder,
    newFolder: (opts) => createFolder(opts),
    renameFolder,
    startFolderRename: () => startCrumbRename(),
    setFolderColor,
    removeFolder,
    revealFolder,
    moveBoard,
    rootMissing: () => rootMissing,
    find: (id) => projects.find((p) => p.id === id) || null,
    focusSearch: () => { search.focus(); search.select(); }
  };
}

export default initHome;
