// ── Éditeur nodal ─────────────────────────────────────────────────────
// Point d'entrée de la planche : assemble le modèle (doc + historique), la
// caméra, les cartes, les fils, les gestes et les panneaux (palette,
// minicarte, dock, zoom), et expose l'API de la SPEC §6.4 à tout le reste de
// l'interface — exportée ici et posée sur `window.__mia.editor`.
//
// Une seule planche à la fois dans le DOM. Chaque projet ouvert garde sa
// session (document, historique, caméra, sélection) en mémoire, pour qu'un
// changement d'onglet ne perde pas l'annulation.

import { on, emit } from '../bus.js';
import { state, mediaUrl } from '../state.js';
import { t, tn, tl, register } from '../i18n.js';
import { icon } from '../icons.js';
import { toast } from '../ui/toasts.js';
import { ms, reduced, easeFn } from '../ui/motion.js';
import {
  loadCatalog, typeOf, recipe as recipeById, recipes as allRecipes,
  compatible, outRule, portDef, inputDefs, outputDefs
} from '../catalog.js';
import { GraphDoc, plain, GRID, NODE_MIN_W, NODE_MAX_W, GRAPH_VERSION } from './doc.js';
import { History } from './history.js';
import { Camera, SmoothZoom, easeCam } from './camera.js';
import { WireLayer } from './wires.js';
import { Views, estimateHeight, displayTitle, setText } from './view.js';
import { freeOffset, settleColumns, layered, GAP } from './layout.js';
import { paintSections, ellipsize, adopt as adoptSections, boxAround, toneKey, titlePx, titleLift } from './sections.js';
import { attachInteract } from './interact.js';
import { createPalette } from './palette.js';
import { createMinimap } from './minimap.js';
import { createClipboard } from './clipboard.js';
import { attachDrop } from './drop.js';

// ── textes ────────────────────────────────────────────────────────────
register({
  fr: {
    'graph.section': 'Section',
    'graph.stale': 'Réglages ou amont changés : à relancer',
    'graph.unknownType': 'Ce bloc n’existe plus dans cette version de Mia.',
    'graph.state.queued': 'En file',
    'graph.state.waiting': 'GPU occupé',
    'graph.state.waitingWho': 'Le GPU est occupé par {who}',
    'graph.state.running': 'En cours',
    'graph.state.eta': 'Fin vers {time}',
    'graph.state.error': 'Erreur',
    'graph.state.cancelled': 'Annulé',
    'graph.state.done': 'Fait',
    'graph.state.doneIn': 'Fait · {d}',
    'graph.tip.more': 'Actions du bloc',
    'graph.tip.cut': 'Couper le fil',
    'graph.kind.image': 'Image',
    'graph.kind.video': 'Vidéo',
    'graph.kind.media': 'Image ou vidéo',
    'graph.kind.text': 'Texte',
    'graph.kind.audio': 'Son',
    'graph.menu.addNode': 'Ajouter un bloc…',
    'graph.menu.recipes': 'Recettes',
    'graph.menu.paste': 'Coller',
    'graph.menu.selectAll': 'Tout sélectionner',
    'graph.menu.fitAll': 'Tout cadrer',
    'graph.menu.snap': 'Aimanter à la grille',
    'graph.menu.minimap': 'Minicarte',
    'graph.menu.run': 'Lancer',
    'graph.menu.runPreview': 'Lancer l’aperçu',
    'graph.menu.runFinal': 'Lancer le rendu final',
    'graph.menu.rename': 'Renommer',
    'graph.menu.duplicate': 'Dupliquer',
    'graph.menu.copy': 'Copier',
    'graph.menu.collapse': 'Replier',
    'graph.menu.expand': 'Déplier',
    'graph.menu.bypass': 'Désactiver',
    'graph.menu.enable': 'Réactiver',
    'graph.menu.group': 'Grouper dans une section',
    'graph.menu.reveal': 'Afficher le résultat dans l’Explorateur',
    'graph.menu.revealSource': 'Afficher le fichier dans l’Explorateur',
    'graph.menu.copyPath': 'Copier le chemin',
    'graph.menu.delete': 'Supprimer',
    'graph.menu.cut': 'Couper',
    'graph.menu.tone': 'Teinte',
    'graph.menu.ungroup': 'Dégrouper',
    'graph.menu.deleteSection': 'Supprimer la section',
    'graph.menu.selectContent': 'Sélectionner le contenu',
    'graph.menu.inspect': 'Réglages du bloc…',
    'graph.menu.view': 'Voir en grand',
    'graph.menu.newSection': 'Nouvelle section',
    'graph.menu.arrange': 'Ranger les blocs',
    'graph.key.ungroup': 'Ctrl Maj G',
    'graph.tone.none': 'Bleu',
    'graph.tone.grey': 'Gris',
    'graph.tone.teal': 'Turquoise',
    'graph.tone.green': 'Vert',
    'graph.tone.yellow': 'Jaune',
    'graph.tone.orange': 'Orange',
    'graph.tone.red': 'Rouge',
    'graph.tone.pink': 'Rose',
    'graph.toast.maxImage.one': '{n} image au plus',
    'graph.toast.maxImage.other': '{n} images au plus',
    'graph.toast.maxVideo.one': '{n} vidéo au plus',
    'graph.toast.maxVideo.other': '{n} vidéos au plus',
    'graph.toast.maxAny.one': '{n} fil au plus sur cette entrée',
    'graph.toast.maxAny.other': '{n} fils au plus sur cette entrée',
    'graph.toast.notLora': '« {name} » est un modèle complet, pas un LoRA : range-le dans le dossier du moteur.',
    'graph.toast.unknownFile': '« {name} » n’est pas reconnu.',
    'graph.toast.loraLater': 'L’ajout de LoRA n’est pas encore prêt dans cette version.',
    'graph.readonly.title': 'Lecture seule',
    'graph.readonly.body': 'Le fichier de la planche est abîmé : rien de ce que tu changes n’est enregistré.',
    'graph.readonly.newer': 'Cette planche vient d’une version plus récente de Mia : mets Mia à jour pour la modifier.',
    'graph.readonly.migration': 'Cette planche n’a pas pu être mise au format de cette version de Mia : rien de ce que tu changes n’est enregistré.',
    'graph.readonly.reveal': 'Afficher le dossier',
    'graph.readonly.empty': 'Cette planche n’a pas pu être lue.',
    'graph.readonly.emptyNewer': 'Cette planche vient d’une version plus récente de Mia.',
    'graph.err.noNode': 'Ce bloc n’existe pas.',
    'graph.err.self': 'Un bloc ne se relie pas à lui-même.',
    'graph.err.noOutPort': 'Ce bloc n’a pas de sortie « {port} ».',
    'graph.err.noInPort': 'Ce bloc n’a pas d’entrée « {port} ».',
    'graph.err.noOutputs': 'Ce bloc n’a aucune sortie.',
    'graph.err.noInputs': 'Ce bloc n’a aucune entrée.',
    'graph.err.noMatch': 'Aucune entrée de ce bloc ne peut recevoir cette sortie.',
    'graph.key.del': 'Suppr',
    'graph.key.shift1': 'Maj 1',
    'graph.key.altClick': 'Alt clic',
    'graph.zoom.in': 'Zoom avant',
    'graph.zoom.out': 'Zoom arrière',
    'graph.zoom.fit': 'Tout cadrer',
    'graph.zoom.fitSel': 'Cadrer la sélection',
    'graph.zoom.level': 'Niveau de zoom',
    'graph.zoom.pct': '{n} %',
    'graph.pct': '{n} %',
    'graph.minimap.tip': 'Minicarte',
    'graph.drop.veil': 'Dépose tes fichiers (images, vidéos, sons, LoRA)',
    'graph.drop.veilSub': 'Chaque image, vidéo ou son devient un bloc ; un LoRA s’ajoute à Mia',
    'graph.drop.into': 'Dépose pour remplir « {name} »',
    'graph.drop.here': 'Glisse un fichier ici',
    'graph.drop.image': 'Glisse une image ici',
    'graph.drop.video': 'Glisse une vidéo ici',
    'graph.drop.audio': 'Glisse un son ici',
    'graph.drop.lutWhere': 'Une LUT .cube se lâche sur un bloc Finition.',
    'graph.drop.media': 'Glisse une image ou une vidéo ici',
    'graph.empty.title': 'Glisse une image ou une vidéo, ou choisis une recette',
    'graph.empty.hint': 'Double-clic ou {key} pour ajouter un bloc',
    'graph.empty.blocks.one': '{n} bloc',
    'graph.empty.blocks.other': '{n} blocs',
    'graph.toast.importing.one': 'Import du fichier…',
    'graph.toast.importing.other': 'Import de {n} fichiers…',
    'graph.toast.importFailed': 'Impossible d’importer « {name} » : {error}',
    'graph.toast.unknownError': 'erreur inconnue',
    'graph.toast.kindMismatch': 'Ce bloc attendait plutôt {kind}.',
    'graph.toast.incompatible': 'Ces deux ports ne vont pas ensemble : {a} → {b}.',
    'graph.toast.cycle': 'Ce fil ferait une boucle.',
    'graph.toast.copied.one': 'Bloc copié',
    'graph.toast.copied.other': '{n} blocs copiés',
    'graph.toast.pathCopied': 'Chemin copié',
    'graph.toast.noResult': 'Ce bloc n’a pas encore de résultat.',
    'graph.toast.readonly': 'Planche en lecture seule : rien n’est modifié.',
    'graph.toast.pasteFailed': 'Rien à coller.',
    'graph.body.run': 'Lancer',
    'graph.body.preview': 'Aperçu',
    'graph.body.final': 'Rendu final',
    'graph.body.fromWire': 'Vient du fil',
    'graph.fps': 'i/s',
    'graph.yes': 'Oui',
    'graph.no': 'Non',
    'graph.none': 'Aucun',
    'graph.auto': 'Auto',
    'graph.lastFrame': 'Dernière',
    'dock.add': 'Bloc',
    'dock.addTip': 'Ajouter un bloc · Tab',
    'dock.recipes': 'Recettes',
    'dock.recipesTip': 'Poser une recette prête',
    'dock.section': 'Section',
    'dock.sectionTip': 'Dessiner une section : glisser sur la planche · S'
  },
  en: {
    'graph.section': 'Section',
    'graph.stale': 'Settings or inputs changed: run again',
    'graph.unknownType': 'This block no longer exists in this version of Mia.',
    'graph.state.queued': 'Queued',
    'graph.state.waiting': 'GPU busy',
    'graph.state.waitingWho': 'The GPU is busy with {who}',
    'graph.state.running': 'Running',
    'graph.state.eta': 'Ends around {time}',
    'graph.state.error': 'Error',
    'graph.state.cancelled': 'Cancelled',
    'graph.state.done': 'Done',
    'graph.state.doneIn': 'Done · {d}',
    'graph.tip.more': 'Block actions',
    'graph.tip.cut': 'Cut the wire',
    'graph.kind.image': 'Image',
    'graph.kind.video': 'Video',
    'graph.kind.media': 'Image or video',
    'graph.kind.text': 'Text',
    'graph.kind.audio': 'Sound',
    'graph.menu.addNode': 'Add a block…',
    'graph.menu.recipes': 'Recipes',
    'graph.menu.paste': 'Paste',
    'graph.menu.selectAll': 'Select all',
    'graph.menu.fitAll': 'Fit all',
    'graph.menu.snap': 'Snap to grid',
    'graph.menu.minimap': 'Minimap',
    'graph.menu.run': 'Run',
    'graph.menu.runPreview': 'Run preview',
    'graph.menu.runFinal': 'Run final render',
    'graph.menu.rename': 'Rename',
    'graph.menu.duplicate': 'Duplicate',
    'graph.menu.copy': 'Copy',
    'graph.menu.collapse': 'Collapse',
    'graph.menu.expand': 'Expand',
    'graph.menu.bypass': 'Disable',
    'graph.menu.enable': 'Enable',
    'graph.menu.group': 'Group into a section',
    'graph.menu.reveal': 'Show result in Explorer',
    'graph.menu.revealSource': 'Show file in Explorer',
    'graph.menu.copyPath': 'Copy path',
    'graph.menu.delete': 'Delete',
    'graph.menu.cut': 'Cut',
    'graph.menu.tone': 'Tint',
    'graph.menu.ungroup': 'Ungroup',
    'graph.menu.deleteSection': 'Delete the section',
    'graph.menu.selectContent': 'Select content',
    'graph.menu.inspect': 'Block settings…',
    'graph.menu.view': 'View large',
    'graph.menu.newSection': 'New section',
    'graph.menu.arrange': 'Arrange blocks',
    'graph.key.ungroup': 'Ctrl Shift G',
    'graph.tone.none': 'Blue',
    'graph.tone.grey': 'Grey',
    'graph.tone.teal': 'Teal',
    'graph.tone.green': 'Green',
    'graph.tone.yellow': 'Yellow',
    'graph.tone.orange': 'Orange',
    'graph.tone.red': 'Red',
    'graph.tone.pink': 'Pink',
    'graph.toast.maxImage.one': '{n} image at most',
    'graph.toast.maxImage.other': '{n} images at most',
    'graph.toast.maxVideo.one': '{n} video at most',
    'graph.toast.maxVideo.other': '{n} videos at most',
    'graph.toast.maxAny.one': '{n} wire at most on this input',
    'graph.toast.maxAny.other': '{n} wires at most on this input',
    'graph.toast.notLora': '“{name}” is a full model, not a LoRA: put it in the engine folder.',
    'graph.toast.unknownFile': '“{name}” is not recognised.',
    'graph.toast.loraLater': 'Adding LoRAs is not ready yet in this version.',
    'graph.readonly.title': 'Read-only',
    'graph.readonly.body': 'The board file is damaged: nothing you change is saved.',
    'graph.readonly.newer': 'This board comes from a newer version of Mia: update Mia to edit it.',
    'graph.readonly.migration': 'This board could not be brought to this version’s format: nothing you change is saved.',
    'graph.readonly.reveal': 'Show folder',
    'graph.readonly.empty': 'This board could not be read.',
    'graph.readonly.emptyNewer': 'This board comes from a newer version of Mia.',
    'graph.err.noNode': 'This block does not exist.',
    'graph.err.self': 'A block cannot be wired to itself.',
    'graph.err.noOutPort': 'This block has no “{port}” output.',
    'graph.err.noInPort': 'This block has no “{port}” input.',
    'graph.err.noOutputs': 'This block has no output.',
    'graph.err.noInputs': 'This block has no input.',
    'graph.err.noMatch': 'No input of this block can take this output.',
    'graph.key.del': 'Del',
    'graph.key.shift1': 'Shift 1',
    'graph.key.altClick': 'Alt click',
    'graph.zoom.in': 'Zoom in',
    'graph.zoom.out': 'Zoom out',
    'graph.zoom.fit': 'Fit all',
    'graph.zoom.fitSel': 'Fit selection',
    'graph.zoom.level': 'Zoom level',
    'graph.zoom.pct': '{n}%',
    'graph.pct': '{n}%',
    'graph.minimap.tip': 'Minimap',
    'graph.drop.veil': 'Drop your files (images, videos, sounds, LoRAs)',
    'graph.drop.veilSub': 'Each image, video or sound becomes a block; a LoRA is added to Mia',
    'graph.drop.into': 'Drop to fill “{name}”',
    'graph.drop.here': 'Drop a file here',
    'graph.drop.image': 'Drop an image here',
    'graph.drop.video': 'Drop a video here',
    'graph.drop.audio': 'Drop a sound here',
    'graph.drop.lutWhere': 'Drop a .cube LUT onto a Finish block.',
    'graph.drop.media': 'Drop an image or a video here',
    'graph.empty.title': 'Drop an image or a video, or pick a recipe',
    'graph.empty.hint': 'Double-click or {key} to add a block',
    'graph.empty.blocks.one': '{n} block',
    'graph.empty.blocks.other': '{n} blocks',
    'graph.toast.importing.one': 'Importing the file…',
    'graph.toast.importing.other': 'Importing {n} files…',
    'graph.toast.importFailed': 'Could not import “{name}”: {error}',
    'graph.toast.unknownError': 'unknown error',
    'graph.toast.kindMismatch': 'This block was rather expecting {kind}.',
    'graph.toast.incompatible': 'These two ports do not fit together: {a} → {b}.',
    'graph.toast.cycle': 'This wire would make a loop.',
    'graph.toast.copied.one': 'Block copied',
    'graph.toast.copied.other': '{n} blocks copied',
    'graph.toast.pathCopied': 'Path copied',
    'graph.toast.noResult': 'This block has no result yet.',
    'graph.toast.readonly': 'Read-only board: nothing is changed.',
    'graph.toast.pasteFailed': 'Nothing to paste.',
    'graph.body.run': 'Run',
    'graph.body.preview': 'Preview',
    'graph.body.final': 'Final render',
    'graph.body.fromWire': 'From the wire',
    'graph.fps': 'fps',
    'graph.yes': 'Yes',
    'graph.no': 'No',
    'graph.none': 'None',
    'graph.auto': 'Auto',
    'graph.lastFrame': 'Last',
    'dock.add': 'Block',
    'dock.addTip': 'Add a block · Tab',
    'dock.recipes': 'Recipes',
    'dock.recipesTip': 'Place a ready-made recipe',
    'dock.section': 'Section',
    'dock.sectionTip': 'Draw a section: drag on the board · S'
  }
});

const IDLE = Object.freeze({ kind: 'idle', progress: null, eta: null, message: null, jobId: null });
// Marges utiles pour cadrer : barre de titre flottante en haut, docks en bas.
const INSETS = { top: 44 + 48, right: 56, bottom: 20 + 44 + 40, left: 56 };

let ed = null;           // contexte interne (une seule planche)

// ── API publique (SPEC §6.4) ──────────────────────────────────────────

export const editor = {
  get ready() { return ed?.ready || Promise.reject(new Error('mountEditor() n\'a pas été appelé')); },
  get project() { return ed?.project || null; },
  get loaded() { return !!ed?.project; },
  load: (project, graph) => load(project, graph),
  unload: () => unload(),
  getGraph,
  getNode: (id) => ed?.doc.node(id) || null,
  nodeType: (id) => typeOf(ed?.doc.node(id)?.type),
  updateNode: (id, patch, opts) => updateNode(id, patch, opts),
  setParam: (id, key, value) => setParam(id, key, value),
  addNode: (type, at, opts) => addNode(type, at, opts),
  removeNodes: (ids) => removeNodes(ids),
  connect: (a, ap, b, bp) => connect(a, ap, b, bp),
  disconnect: (edgeId) => disconnect(edgeId),
  inputsOf: (id) => inputsOf(id),
  portType: (id, port, dir) => portType(id, port, dir),
  select: (ids) => select(ids),
  selection: () => (ed ? [...ed.sel.nodes] : []),
  fit: (ids) => fit(ids),
  focusNode: (id) => focusNode(id),
  worldToScreen: (p) => worldToScreen(p),
  screenToWorld: (p) => screenToWorld(p),
  insertRecipe: (r, at) => insertRecipe(r, at),
  importFiles: (paths, at, into) => importFiles(paths, at, into),
  nodeEl: (id) => ed?.views.get(id)?.el || null,
  slotEls: (id) => {
    const v = ed?.views.get(id);
    return v ? { head: v.head, status: v.status, progress: v.prog, preview: v.preview, controls: v.controls } : null;
  },
  // en plus de la SPEC, utiles à D et F
  undo: () => ed?.history.undo() ?? false,
  redo: () => ed?.history.redo() ?? false,
  openPalette: (opts) => ed?.palette.open(opts || {}),
  inputSources: (id, port) => inputSources(id, port),
  camera: () => (ed ? { ...ed.cam.settled } : null),
  setCamera: (c, { animate = false } = {}) => {
    if (!ed || !c) return;
    if (animate) ed.cam.animateTo({ x: +c.x || 0, y: +c.y || 0, z: +c.z || 1 });
    else { ed.cam.stop(); ed.cam.set({ x: +c.x || 0, y: +c.y || 0, z: +c.z || 1 }); }
  },
  // pour le pont des assistants (G, SPEC §13) : poser, relier, ranger « à vue »
  /** {ok, from:{node,port}, to:{node,port}, error} : le fil serait-il accepté ? ports devinés si omis. */
  canConnect: (a, ap, b, bp) => (ed ? resolveConnect(a, ap, b, bp) : { ok: false, error: 'invalid' }),
  /** Range des blocs de gauche à droite selon les fils (tous si `ids` est vide), animé. */
  arrange: (ids, opts) => arrange(ids, opts),
  /** Petite arrivée (180 ms) sur un bloc déjà posé. */
  animateAdd: (id) => animateAdd(id),
  /** Une section : `box` = {x,y,w,h} ou {around:[ids]} ; renvoie son id. */
  addSection: (box, opts) => addSection(box, opts),
  /** Une place libre pour une boîte {x,y,w,h} (près de sa position, ou à droite de `near`). */
  freeSpot: (box, opts) => (ed ? findFree(box, opts) : null)
};
// accès réservé aux bancs d'essai (_dev) : caméra et image forcée, jamais utilisé par l'app
Object.defineProperty(editor, '__debug', { enumerable: false, get: () => (ed ? { cam: ed.cam, frameNow: frame, ctx: ed } : null) });

/** Le document complet (graph.json), caméra comprise : copie profonde, prête pour l'IPC. */
export function getGraph() {
  if (!ed?.doc) return null;
  const g = ed.doc.toJSON();
  const c = ed.cam.settled;
  g.camera = { x: round2(c.x), y: round2(c.y), z: round4(c.z) };
  return JSON.parse(JSON.stringify(g));
}
export const getNode = editor.getNode;
export const nodeType = editor.nodeType;
export const select = (ids) => setSelection({ nodes: ids || [] });
export const selection = editor.selection;
export const nodeEl = editor.nodeEl;
export const slotEls = editor.slotEls;
export default editor;

// ── montage ───────────────────────────────────────────────────────────

/** Monte l'éditeur dans #stage (une seule fois) et renvoie l'API. */
export function mountEditor(stageEl) {
  if (ed) return editor;
  const stage = stageEl || document.getElementById('stage');
  const board = stage.parentElement || document.body;
  const ensure = (id, tag, parent, cls) => {
    let n = document.getElementById(id);
    if (!n) { n = document.createElement(tag); n.id = id; if (cls) n.className = cls; parent.append(n); }
    return n;
  };

  // le DOM de la SPEC §6.1 ; tout ce qui manque est créé
  let grid = ensure('grid', 'canvas', stage);
  if (grid.tagName !== 'CANVAS') grid = ensure('grid-canvas', 'canvas', grid);
  const world = ensure('world', 'div', stage);
  let wiresSvg = document.getElementById('wires');
  if (!wiresSvg) {
    wiresSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    wiresSvg.id = 'wires';
    world.prepend(wiresSvg);
  }
  const nodesEl = ensure('nodes', 'div', world);
  const groupsEl = ensure('groups', 'div', world);
  const marquee = ensure('marquee', 'div', stage);
  marquee.hidden = true;
  const overlay = ensure('overlay', 'div', stage);
  const ovSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ovSvg.setAttribute('class', 'ov-svg');
  overlay.append(ovSvg);
  const dock = ensure('dock', 'div', board, 'dock');
  const zoombar = ensure('zoombar', 'div', board, 'zoombar');
  const minimapEl = ensure('minimap', 'div', board);
  const emptyEl = ensure('board-empty', 'div', board);
  const paletteEl = ensure('palette', 'div', document.body);

  stage.classList.add('mia-stage');
  world.classList.add('lod-0');

  const cam = new Camera();
  ed = {
    stage, board, world, grid, wiresSvg, nodesEl, groupsEl, marquee, overlay, ovSvg,
    dock, zoombar, minimapEl, emptyEl, paletteEl,
    cam, smooth: new SmoothZoom(cam),
    doc: new GraphDoc({}), project: null, readonly: false,
    sel: { nodes: new Set(), edge: null, group: null },
    hover: null, hoverEdge: null,
    zTop: 10,
    bodyModule: null, runsMod: null, fallbackRuns: new Map(),
    sessions: new Map(),
    lod: 0, lastZ: NaN, zApplied: '', stageRect: { left: 0, top: 0, width: 1, height: 1 },
    wheelAt: -1e9,     // dernier évènement de molette ou de pincement (interact.js)
    // sections : survol, cible d'un bloc qu'on glisse, renommage, fantôme du tracé
    sect: { hot: null, drop: null, editing: null, ghost: null, widths: new Map(), born: new Map() },
    tool: null,        // 'section' : le prochain glisser sur la planche dessine une section
    grow: new Map(),   // blocs Média tout juste remplis : s'ils grandissent, ils poussent ce qui est dessous
    pointer: null,     // dernier point du pointeur sur la planche (écran local)
    connecting: null   // geste « tirer un fil » en cours (interact.js)
  };

  ed.history = new History({ capture: captureContent, restore: restoreContent });
  ed.history.onchange = () => emit('history:changed', { canUndo: ed.history.canUndo, canRedo: ed.history.canRedo });
  ed.views = new Views(ed, nodesEl);
  ed.wires = new WireLayer(ed, wiresSvg);

  Object.assign(ed, internals());
  ed.grid2d = new BoardCanvas(grid, ed);
  ed.palette = createPalette(ed);
  ed.minimap = createMinimap(ed);
  ed.clipboard = createClipboard(ed);
  ed.interact = attachInteract(ed);
  attachDrop(ed);
  buildDock(ed);
  buildZoombar(ed);
  buildReadonly(ed);
  applyPrefs(state.prefs || {});

  cam.onchange = requestFrame;

  // taille de la scène (et donc du viewport caméra) — la vue peut naître cachée
  // L'observateur passe après la mise en page, juste avant la peinture. Redimensionner le
  // canevas le vide : il est donc repeint ici même, sinon l'image peinte montrait les blocs sur
  // un fond noir (sans grille, sections ni titres) le temps d'une image (ouverture de planche).
  // Même taille qu'avant : rien à refaire.
  const ro = new ResizeObserver(() => {
    if (!syncViewport()) return;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    frame();
  });
  ro.observe(stage);
  watchDpr(() => { ed.grid2d.resize(ed.stageRect.width, ed.stageRect.height); requestFrame(); });
  // le thème (classe du body) change les couleurs peintes sur les canevas
  let bodyCls = document.body.className;
  new MutationObserver(() => {
    if (document.body.className === bodyCls) return;
    bodyCls = document.body.className;
    ed.grid2d.bust(); ed.minimap.bust(); requestDraw();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // modules de F, chargés à part : si l'un manque, la planche reste utilisable
  const body = import('../nodes/body.js')
    .then((m) => { ed.bodyModule = m; })
    .catch((e) => console.warn('[editor] nodes/body.js indisponible, corps minimal utilisé', e));
  const runsP = import('../nodes/runs.js')
    .then((m) => { ed.runsMod = m.runs || m.default || m; })
    .catch((e) => console.warn('[editor] nodes/runs.js indisponible, états lus sur engine:event', e));
  ed.ready = Promise.all([loadCatalog(), body, runsP]).then(() => {
    buildEmpty(ed);
    return editor;
  });

  wireBus();
  window.__mia = window.__mia || {};
  window.__mia.editor = editor;
  return editor;
}

// ── bus ───────────────────────────────────────────────────────────────

function wireBus() {
  on('runs:changed', (p) => {
    if (!ed.project) return;
    if (p?.nodeId) refreshRun(p.nodeId);
    else refreshAllRuns();
    // un résultat neuf peut préciser un type « follow » encore inconnu
    ed.views.refreshPorts();
    ed.wires.styleAll();
  });
  on('engine:event', (evt) => {
    if (!evt || !ed.project) return;
    if (evt.projectId && evt.projectId !== ed.project.id) return;
    const map = { queued: 'queued', 'waiting-gpu': 'waiting-gpu', start: 'running', progress: 'running', preview: 'running', error: 'error', cancelled: 'cancelled', done: 'idle' };
    const kind = map[evt.kind];
    if (kind && evt.nodeId) {
      ed.fallbackRuns.set(evt.nodeId, {
        kind, progress: evt.progress ?? null, eta: evt.eta ?? null,
        message: evt.message || null, jobId: evt.jobId || null, who: evt.who || null
      });
      refreshRun(evt.nodeId);
    }
  });
  on('prefs:changed', (p) => applyPrefs(p?.prefs || state.prefs || {}));
  on('theme:changed', () => { ed.grid2d.bust(); ed.minimap.bust(); requestDraw(); });
  on('palette:open', (p) => afterLoad(() => ed.palette.open(p || {})));
  // sur l'accueil, D crée d'abord le projet puis appelle insertRecipe : on n'agit
  // que si une planche est déjà ouverte au moment de l'évènement
  on('recipe:insert', (p) => { if (ed.project && !ed.readonly) insertRecipe(p?.recipe ?? p); });
  on('project:opened', (p) => {
    // D appelle normalement editor.load ; si ce n'est pas fait dans la foulée, on s'en charge
    if (!p?.project) return;
    // la raison de la lecture seule, si D la transmet (« planche d'un Mia plus récent »…)
    if (p.readOnlyReason && ed.project?.id === p.project.id && ed.readonly && p.readOnlyReason !== ed.readonlyReason) {
      ed.readonlyReason = p.readOnlyReason;
      syncReadonly();
      updateEmpty();
    }
    setTimeout(() => { if (ed.loadingId !== p.project.id) load(p.project, p.graph); }, 0);
  });
  // « closed » veut dire « sorti de la planche » (D l'émet aussi en changeant
  // d'onglet) : la session reste en mémoire pour garder l'annulation
  on('project:closed', (p) => { if (p?.id && ed.project?.id === p.id) unload(true); });
  on('view:changed', (p) => {
    if (p?.view !== 'board') { ed.palette.close(); return; }
    requestFrame();
  });
}

let loadQueue = Promise.resolve();
function afterLoad(fn) { loadQueue.then(() => { if (ed.project) fn(); }); }

function applyPrefs(prefs) {
  ed.snap = !!prefs.snap;
  ed.world.classList.toggle('wires-typed', prefs.wires === 'typed');
  ed.minimap?.setVisible(!!prefs.minimap, false);
}

/** Écrit une préférence (fusion côté principal) et prévient tout le monde. */
export async function setPref(patch) {
  Object.assign(state.prefs || (state.prefs = {}), patch);
  applyPrefs(state.prefs);
  try {
    const full = await window.mia?.prefs?.set(patch);
    if (full && typeof full === 'object') Object.assign(state.prefs, full);
  } catch (e) { console.warn('[editor] prefs', e); }
  emit('prefs:changed', { prefs: state.prefs });
}

// ── chargement d'un projet ────────────────────────────────────────────

function load(project, graph) {
  if (!ed) throw new Error('mountEditor() doit être appelé avant editor.load()');
  ed.loadingId = project?.id ?? null;
  loadQueue = ed.ready.then(() => doLoad(project, graph)).catch((e) => {
    console.error('[editor] chargement', e);
    toast(String(e?.message || e), { kind: 'error' });
  });
  return loadQueue;
}

function doLoad(project, graph) {
  syncViewport();             // la vue vient peut-être d'apparaître : cadrer avec sa vraie taille
  if (ed.project) stashSession();
  ed.palette.close();
  ed.interact.cancel();
  ed.views.clear();
  ed.wires.clear();
  ed.fallbackRuns.clear();

  ed.project = { id: project.id, name: project.name, dir: project.dir || (state.project?.id === project.id ? state.project.dir : null) || null };
  // lecture seule : graph.json illisible ouvert depuis .bak (D le signale dans state.readOnly)
  ed.readonly = !!(state.readOnly || project.readonly || project.readOnly || graph?.readonly);
  ed.readonlyReason = ed.readonly ? readonlyReason(project, graph) : null;
  ed.tool = null;
  ed.grow.clear();
  ed.sect.hot = ed.sect.drop = ed.sect.editing = ed.sect.ghost = null;
  syncReadonly();
  const fresh = new GraphDoc(graph || {});
  const s = ed.sessions.get(project.id);
  // même contenu que la session gardée en mémoire → on garde son historique
  const restored = !!s && JSON.stringify(s.doc.content()) === JSON.stringify(fresh.content());
  if (restored) {
    ed.doc = s.doc;
    ed.history = s.history;
    ed.sel = { nodes: new Set([...s.sel].filter((id) => ed.doc.node(id))), edge: null, group: null };
    ed.cam.stop();
    ed.cam.set(s.cam);
  } else {
    ed.doc = fresh;
    ed.history = new History({ capture: captureContent, restore: restoreContent });
    ed.history.onchange = () => emit('history:changed', { canUndo: ed.history.canUndo, canRedo: ed.history.canRedo });
    ed.sel = { nodes: new Set(), edge: null, group: null };
    ed.cam.stop();
    const c = ed.doc.camera;
    const hasCam = graph?.camera && (c.x || c.y || c.z !== 1);
    ed.cam.set(c);
    ed._fitOnLoad = !hasCam && ed.doc.nodes.length > 0;
  }

  ed.views.sync();
  // une passe de mesure groupée : toutes les écritures sont faites, une seule mise en page
  for (const v of ed.views.nodes.values()) v.measure();
  ed.wires.sync();
  refreshAllRuns();
  syncSelectionClasses();
  // la caméra enregistrée ne montre plus aucun bloc (blocs rangés ailleurs par un assistant,
  // fenêtre plus petite, planche vidée puis remplie) : on cadre le tout plutôt qu'une planche vide.
  // Jamais au retour sur un onglet (session gardée en mémoire) : Quentin s'était peut-être placé
  // exprès sur une zone vide pour y poser des blocs.
  if (!restored && !ed._fitOnLoad && ed.doc.nodes.length && !anyNodeInView()) ed._fitOnLoad = true;
  if (ed._fitOnLoad) { ed._fitOnLoad = false; fit(null, false); }
  ed.lastZ = NaN;
  requestFrame();
  updateEmpty();
  ed.minimap.request();
  emit('selection:changed', { ids: [...ed.sel.nodes] });
  emit('history:changed', { canUndo: ed.history.canUndo, canRedo: ed.history.canRedo });
}

/**
 * Au moins un bloc se voit-il (24 px écran au moins, sous la barre de titre et au-dessus des
 * docks) avec la caméra actuelle ? Sans taille de vue connue (scène encore cachée), on ne sait
 * pas : on répond oui pour ne rien bouger.
 */
function anyNodeInView() {
  const cam = ed.cam;
  if (cam.vw < 80 || cam.vh < 80) return true;
  const m = 24 / cam.z;
  const x0 = cam.x + 24 / cam.z, x1 = cam.x + (cam.vw - 24) / cam.z;
  const y0 = cam.y + 44 / cam.z, y1 = cam.y + (cam.vh - 72) / cam.z;
  for (const n of ed.doc.nodes) {
    const b = nodeBox(n.id);
    if (b && b.x + b.w > x0 + m && b.x < x1 - m && b.y + b.h > y0 + m && b.y < y1 - m) return true;
  }
  return false;
}

/** Garde document, historique, sélection et caméra du projet quitté (8 au plus, comme les onglets). */
function stashSession() {
  if (!ed.project) return;
  ed.sessions.delete(ed.project.id);
  ed.sessions.set(ed.project.id, { doc: ed.doc, history: ed.history, sel: [...ed.sel.nodes], cam: { ...ed.cam.settled } });
  while (ed.sessions.size > 8) ed.sessions.delete(ed.sessions.keys().next().value);
}

function unload(keepSession = true) {
  if (!ed?.project) return;
  if (keepSession) stashSession();
  ed.loadingId = null;
  ed.palette.close();
  ed.interact.cancel();
  ed.views.clear();
  ed.wires.clear();
  ed.project = null;
  ed.readonly = false;
  ed.readonlyReason = null;
  ed.tool = null;
  ed.grow.clear();
  ed.doc = new GraphDoc({});
  ed.sel = { nodes: new Set(), edge: null, group: null };
  syncReadonly();
  updateEmpty();
  ed.minimap.request();
  requestDraw();
  emit('selection:changed', { ids: [] });
}

// ── historique ────────────────────────────────────────────────────────

function captureContent() { return JSON.stringify(ed.doc.content()); }

/** Annuler / rétablir : on remplace le contenu et on ne prévient que les cartes qui ont changé. */
function restoreContent(snap) {
  ed.interact.cancel();
  const before = new Map(ed.doc.nodes.map((n) => [n.id, JSON.stringify(plain(n))]));
  ed.doc.restore(JSON.parse(snap), false);
  const changed = new Set();
  for (const n of ed.doc.nodes) if (before.get(n.id) !== JSON.stringify(plain(n))) changed.add(n.id);
  afterChange({ changed, animateNew: false, reason: 'undo', history: true });
}

// ── mutations ─────────────────────────────────────────────────────────

/**
 * Toute modification du graphe passe ici : capture pour l'annulation,
 * modification, mise à jour des cartes et des fils, puis `graph:changed`
 * (D sauvegarde 800 ms plus tard).
 */
function mutate(reason, fn, { history = true, key = null, changed = null, animateNew = false, system = false } = {}) {
  // une mise à jour « système » (proxy arrivé en tâche de fond) passe toujours,
  // sans toast : Quentin n'a rien fait
  if (ed.readonly && !system) { toast(t('graph.toast.readonly'), { kind: 'info' }); return undefined; }
  if (history) ed.history.begin(reason, key);
  let r;
  try { r = fn(); } finally { if (history) ed.history.commit(); }
  afterChange({ changed, animateNew, reason, history });
  return r;
}

/**
 * Plusieurs mutations, une seule entrée d'annulation (poser une recette puis la
 * décaler à une place libre, remplir un Média puis pousser ce qui est dessous).
 */
function batch(reason, fn) {
  if (ed.readonly) { toast(t('graph.toast.readonly'), { kind: 'info' }); return undefined; }
  ed.history.begin(reason);
  try { return fn(); } finally { ed.history.commit(); }
}

/**
 * Remet cartes et fils d'accord avec le document. Avec `reason`, annonce
 * `graph:changed` *avant* de relire les états de calcul : runs.js (F) vide
 * son cache « périmé » sur cet évènement, et l'anneau doit lire la valeur neuve.
 */
function afterChange({ changed = null, animateNew = false, reason = null, history = true } = {}) {
  ed.views.sync({ changed, animateNew });
  ed.wires.sync();
  pruneSelection();
  updateEmpty();
  ed.minimap.request();
  requestDraw();                 // sections et titres lointains sont peints sur le canevas
  if (reason) emit('graph:changed', { reason, history });
  refreshAllRuns();
}

function pruneSelection() {
  const s = ed.sel;
  let dirty = false;
  for (const id of [...s.nodes]) if (!ed.doc.node(id)) { s.nodes.delete(id); dirty = true; }
  if (s.edge && !ed.doc.edge(s.edge)) { s.edge = null; dirty = true; }
  if (s.group && !ed.doc.group(s.group)) { s.group = null; dirty = true; }
  if (dirty) { syncSelectionClasses(); emit('selection:changed', { ids: [...s.nodes] }); }
}

function updateNode(id, patch = {}, { history = true, fromBody = false } = {}) {
  if (!ed) return false;
  const node = ed.doc.node(id);
  if (!node || !patch) return false;
  const changed = new Set(fromBody ? [] : [id]);
  if (patch.data) for (const d of ed.doc.downstream(id)) changed.add(d);
  const key = patch.params && Object.keys(patch).length === 1 ? `params:${id}` : null;
  mutate('update', () => {
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      if (k === 'id' || k === 'type') continue;
      if ((k === 'params' || k === 'data') && v && typeof v === 'object' && !Array.isArray(v)) {
        node[k] = node[k] || {};
        for (const kk of Object.keys(v)) {
          if (v[kk] === undefined) delete node[k][kk];
          else node[k][kk] = v[kk];
        }
      } else if (k === 'w') node.w = Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, Math.round(+v || node.w)));
      else if (k === 'x' || k === 'y') node[k] = Math.round(+v || 0);
      else if (k === 'title') node.title = typeof v === 'string' && v.trim() ? v.trim() : null;
      else if (v === undefined) delete node[k];
      else node[k] = v;
    }
  }, { history, key, changed });
  if (patch.pinnedRun !== undefined || patch.bypass !== undefined) refreshRun(id);
  return true;
}

function setParam(id, key, value, fromBody = false) {
  const node = ed.doc.node(id);
  if (!node) return false;
  if (node.params[key] === value) return true;
  mutate('param', () => { node.params[key] = value; }, {
    key: `param:${id}:${key}`,
    changed: new Set(fromBody ? [] : [id])
  });
  return true;
}

/**
 * Pose un bloc. `at` = {x, y} (coin haut-gauche, tel quel), {near: id} (à
 * droite de ce bloc, à la première place libre — le pont des assistants),
 * {x, y, free: true} (près de ce point, sans chevaucher) ou rien (centre de la
 * vue, place libre). Une place automatique est vérifiée avec la vraie hauteur
 * de la carte une fois montée, dans la même entrée d'annulation.
 */
function addNode(type, at, { data, params, select: doSelect = true, animate = true, title = null, origin = null } = {}) {
  const def = typeOf(type);
  if (!def) { console.warn('[editor] type inconnu', type); return null; }
  const w = def.width || 288;
  const hgt = estimateHeight({ type, w, data: data || {} }, def);
  let pos, prefer = 'any', near = null;
  if (at && at.near && ed.doc.node(at.near)) {
    near = nodeBox(at.near);
    pos = { x: near.x + near.w + GRID * 4, y: near.y };
    prefer = 'right';
  } else if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
    pos = { x: at.x, y: at.y };
    if (!at.free) prefer = null;
  } else {
    const c = viewCenter();
    pos = { x: c.x - w / 2, y: c.y - hgt / 2 };
  }
  if (prefer) pos = findFree({ x: pos.x, y: pos.y, w, h: hgt }, { prefer, pad: GAP });
  if (ed.snap) pos = { x: snap(pos.x), y: snap(pos.y) };
  // la carte naît du point de pose (double-clic, fil lâché) : lu par NodeView à sa création
  ed.poseOrigin = !prefer && origin && Number.isFinite(origin.x) && Number.isFinite(origin.y) ? origin : null;
  const node = batch('add', () => {
    let n;
    try {
      n = mutate('add', () => ed.doc.addNode({ type, x: pos.x, y: pos.y, w, title, data: data || {}, params: params || {} }),
        { animateNew: animate, changed: new Set() });
    } finally { ed.poseOrigin = null; }
    if (!n) return null;
    // la vraie hauteur peut dépasser l'estimation : on revérifie la place
    const v = ed.views.get(n.id);
    v?.measure();
    if (prefer) {
      const box = nodeBox(n.id);
      const p = findFree(box, { prefer, exclude: new Set([n.id]), pad: GAP });
      if (p.x !== n.x || p.y !== n.y) relocate(n.id, p.x, p.y);
    } else if (adoptSections(ed.doc.groups, [nodeBox(n.id)])) requestDraw();
    afterChange({ changed: new Set(), reason: 'add' });
    return n;
  });
  if (!node) return null;
  if (doSelect) setSelection({ nodes: [node.id] });
  return node.id;
}

/** Déplace un bloc tout juste posé (avant tout geste) : carte, fils et origine de l'animation d'arrivée. */
function relocate(id, x, y) {
  const n = ed.doc.node(id);
  if (!n) return;
  n.x = Math.round(x); n.y = Math.round(y);
  const v = ed.views.get(id);
  if (v) {
    v.apply(n);
    if (v.el.classList.contains('entering')) v._centerOrigin(n);
  }
  ed.wires.updateNode(id);
}

/**
 * Une place libre pour `box` (monde) : la plus proche de sa position, sans
 * toucher un bloc (marge d'un pas de grille). `exclude` = ids ignorés (le lot
 * qu'on est en train de placer).
 */
function findFree(box, { prefer = 'any', exclude = null, pad = GRID } = {}) {
  const obstacles = [];
  for (const n of ed.doc.nodes) {
    if (exclude && exclude.has(n.id)) continue;
    const b = nodeBox(n.id);
    if (b) obstacles.push(b);
  }
  const { dx, dy } = freeOffset(box, obstacles, { prefer, pad });
  return { x: Math.round(box.x + dx), y: Math.round(box.y + dy) };
}

function removeNodes(ids) {
  const list = (ids || []).filter((id) => ed.doc.node(id));
  if (!list.length) return false;
  mutate('delete', () => { for (const id of list) ed.doc.removeNode(id); }, { animateNew: true });
  return true;
}

/** Pourquoi ce fil est refusé (texte FR prêt à montrer), ou null s'il est bon. */
function connectProblem(a, ap, b, bp) {
  const A = ed.doc.node(a), B = ed.doc.node(b);
  if (!A || !B || a === b) return 'invalid';
  const outDef = portDef(A.type, ap, 'out'), inDef = portDef(B.type, bp, 'in');
  if (!outDef || !inDef) return 'invalid';
  const outT = portType(a, ap, 'out');
  if (!compatible(outT, inDef.type)) {
    return t('graph.toast.incompatible', { a: kindLabel(outT), b: kindLabel(inDef.type) });
  }
  if (ed.doc.upstream(a).has(b)) return t('graph.toast.cycle');
  // entrée multiple bornée (SPEC §17 : « 9 images au plus »)
  if (inDef.multi && inDef.max > 0) {
    const same = ed.doc.edges.some((e) => e.from.node === a && e.from.port === ap && e.to.node === b && e.to.port === bp);
    if (!same && connections(b, bp, 'in') >= inDef.max) return maxMessage(inDef);
  }
  return null;
}

function maxMessage(inDef) {
  const n = inDef.max;
  const k = inDef.type === 'image' ? 'maxImage' : inDef.type === 'video' ? 'maxVideo' : 'maxAny';
  return tn(`graph.toast.${k}`, n, { n });
}

/**
 * Choisit les ports d'un fil quand on ne les donne pas : la première sortie
 * de A qui va dans la première entrée *libre* et compatible de B (sinon une
 * entrée déjà prise, que le fil remplacera). → {ok, from, to} | {ok:false, error}.
 */
function resolveConnect(a, ap, b, bp) {
  const A = ed.doc.node(a), B = ed.doc.node(b);
  if (!A || !B) return { ok: false, error: t('graph.err.noNode') };
  if (a === b) return { ok: false, error: t('graph.err.self') };
  const outs = ap ? [portDef(A.type, ap, 'out')].filter(Boolean) : outputDefs(A.type);
  const ins = bp ? [portDef(B.type, bp, 'in')].filter(Boolean) : inputDefs(B.type);
  if (!outs.length) return { ok: false, error: t(ap ? 'graph.err.noOutPort' : 'graph.err.noOutputs', { port: ap || '' }) };
  if (!ins.length) return { ok: false, error: t(bp ? 'graph.err.noInPort' : 'graph.err.noInputs', { port: bp || '' }) };
  let firstWhy = null;
  for (const pass of [0, 1]) {
    for (const o of outs) {
      for (const i of ins) {
        const why = connectProblem(a, o.id, b, i.id);
        if (why) { if (!firstWhy && why !== 'invalid') firstWhy = why; continue; }
        if (pass === 0 && !i.multi && connections(b, i.id, 'in') > 0) continue;
        return { ok: true, from: { node: a, port: o.id }, to: { node: b, port: i.id } };
      }
    }
  }
  return { ok: false, error: firstWhy || t('graph.err.noMatch') };
}

function connect(a, ap, b, bp, { quiet = true } = {}) {
  if (!ap || !bp) {
    const r = resolveConnect(a, ap, b, bp);
    if (!r.ok) { if (!quiet) toast(r.error, { kind: 'info' }); return null; }
    ap = r.from.port; bp = r.to.port;
  }
  const why = connectProblem(a, ap, b, bp);
  if (why) {
    if (!quiet && why !== 'invalid') toast(why, { kind: 'info' });
    return null;
  }
  const same = ed.doc.edges.find((e) => e.from.node === a && e.from.port === ap && e.to.node === b && e.to.port === bp);
  if (same) return same.id;
  const inDef = portDef(ed.doc.node(b).type, bp, 'in');
  const changed = new Set([b, ...ed.doc.downstream(b)]);
  const edge = mutate('connect', () => {
    // une entrée simple n'a qu'un fil : le nouveau remplace l'ancien
    if (!inDef.multi) for (const e of ed.doc.edgesTo(b, bp)) ed.doc.removeEdge(e.id);
    return ed.doc.addEdge({ from: { node: a, port: ap }, to: { node: b, port: bp } });
  }, { changed });
  return edge?.id || null;
}

function disconnect(edgeId) {
  const e = ed.doc.edge(edgeId);
  if (!e) return false;
  const changed = new Set([e.to.node, ...ed.doc.downstream(e.to.node)]);
  mutate('disconnect', () => { ed.doc.removeEdge(edgeId); }, { changed });
  return true;
}

// ── questions sur le graphe ───────────────────────────────────────────

/** Type concret d'un port (SPEC §4) : `follow:` et `data` résolus. */
function portType(nodeId, portId, dir, depth = 0) {
  const node = ed?.doc.node(nodeId);
  if (!node) return null;
  const def = portDef(node.type, portId, dir);
  if (!def) return null;
  if (dir !== 'out') return def.type;
  const rule = outRule(def.type);
  if (rule.fixed) return rule.fixed;
  if (rule.data) {
    const k = node.data?.kind || node.data?.placeholder?.kind;
    return k === 'image' || k === 'video' || k === 'audio' ? k : 'media';
  }
  if (depth < 32) {
    const e = ed.doc.edgesTo(nodeId, rule.follow)[0];
    if (e) {
      const up = portType(e.from.node, e.from.port, 'out', depth + 1);
      if (up === 'image' || up === 'video') return up;
    }
  }
  // repli : la nature du résultat déjà calculé
  const o = runs.output(nodeId, portId);
  return o?.kind === 'image' || o?.kind === 'video' ? o.kind : 'media';
}

function connections(nodeId, portId, dir) {
  let n = 0;
  for (const e of ed.doc.edges) {
    if (dir === 'in' ? e.to.node === nodeId && e.to.port === portId : e.from.node === nodeId && e.from.port === portId) n++;
  }
  return n;
}

/** {[entrée]: [{node, port}]} ; une entrée multiple est triée par la position verticale des sources. */
function inputsOf(nodeId) {
  const node = ed?.doc.node(nodeId);
  if (!node) return {};
  const out = {};
  for (const def of inputDefs(node.type)) out[def.id] = [];
  for (const e of ed.doc.edges) {
    if (e.to.node !== nodeId) continue;
    (out[e.to.port] ||= []).push({ node: e.from.node, port: e.from.port });
  }
  for (const k of Object.keys(out)) {
    if (out[k].length > 1) out[k].sort((a, b) => (ed.doc.node(a.node)?.y ?? 0) - (ed.doc.node(b.node)?.y ?? 0));
  }
  return out;
}

/** Sources d'une entrée, avec ce qu'il faut pour les montrer (F : « Vient de … »). */
function inputSources(nodeId, portId) {
  const list = inputsOf(nodeId)[portId] || [];
  return list.map(({ node, port }) => {
    const src = ed.doc.node(node);
    return {
      node, port,
      run: runs.current(node),
      data: src?.data || null,
      title: src ? displayTitle(src) : '',
      type: src?.type || null,
      kind: portType(node, port, 'out')
    };
  });
}

function kindLabel(k) { return t(`graph.kind.${k}`) || k; }

// ── états de calcul (F : nodes/runs.js) ───────────────────────────────

const runs = {
  state(id) {
    const r = ed?.runsMod;
    if (r?.state) {
      try { return r.state(id) || IDLE; } catch (e) { console.error('[editor] runs.state', e); }
    }
    return ed?.fallbackRuns.get(id) || IDLE;
  },
  current(id) { try { return ed?.runsMod?.current?.(id) || null; } catch { return null; } },
  list(id) { try { return ed?.runsMod?.list?.(id) || []; } catch { return []; } },
  isStale(id) { try { return !!ed?.runsMod?.isStale?.(id); } catch { return false; } },
  output(id, port) { try { return ed?.runsMod?.output?.(id, port) || null; } catch { return null; } }
};

function refreshRun(id) {
  const v = ed.views.get(id);
  if (!v) return;
  v.setRun(runs.state(id), runs.current(id), runs.isStale(id));
  ed.wires.styleNode(id);
  ed.minimap.request();
}

function refreshAllRuns() {
  for (const v of ed.views.nodes.values()) v.setRun(runs.state(v.id), runs.current(v.id), runs.isStale(v.id));
  ed.wires.styleAll();
}

// ── sélection ─────────────────────────────────────────────────────────

function setSelection({ nodes = [], edge = null, group = null, add = false } = {}, silent = false) {
  if (!ed) return;
  const next = new Set(add ? [...ed.sel.nodes, ...nodes] : nodes);
  for (const id of [...next]) if (!ed.doc.node(id)) next.delete(id);
  const same = next.size === ed.sel.nodes.size && [...next].every((id) => ed.sel.nodes.has(id))
    && edge === ed.sel.edge && group === ed.sel.group;
  if (same) return;
  ed.sel = { nodes: next, edge, group };
  syncSelectionClasses();
  if (!silent) emit('selection:changed', { ids: [...next] });
}

function syncSelectionClasses() {
  for (const v of ed.views.nodes.values()) {
    const on = ed.sel.nodes.has(v.id);
    v.setSelected(on);
  }
  ed.wires.styleAll();
  ed.minimap.request();
  requestDraw();               // section choisie : son filet passe à l'accent
}

// ── caméra, boîtes, coordonnées ───────────────────────────────────────

function nodeBox(id) {
  const n = ed.doc.node(id);
  if (!n) return null;
  return { x: n.x, y: n.y, w: n.w, h: ed.views.get(id)?.h || estimateHeight(n, typeOf(n.type)) };
}

function bbox(ids) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const list = ids ? ids : ed.doc.nodes.map((n) => n.id);
  for (const id of list) {
    const b = nodeBox(id);
    if (!b) continue;
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  if (!ids) {
    for (const g of ed.doc.groups) {
      x0 = Math.min(x0, g.x); y0 = Math.min(y0, g.y - 28);
      x1 = Math.max(x1, g.x + g.w); y1 = Math.max(y1, g.y + g.h);
    }
  }
  if (!Number.isFinite(x0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Taille réelle de la scène, lue tout de suite (le ResizeObserver arrive une
 * image plus tard, trop tard pour cadrer un projet qu'on vient d'ouvrir).
 */
function syncViewport(resizeGrid = false) {
  const r = ed.stage.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const changed = r.width !== ed.stageRect.width || r.height !== ed.stageRect.height;
  ed.stageRect = r;
  ed.cam.setViewport(r.width, r.height);
  if (changed || resizeGrid) ed.grid2d.resize(r.width, r.height);
  return changed || resizeGrid;
}

function fit(ids, animate = true) {
  syncViewport();
  if (!ed?.project) return;
  const list = ids && ids.length ? ids : null;
  const box = bbox(list);
  if (!box) {
    const target = { z: 1, x: -ed.cam.vw / 2, y: -ed.cam.vh / 2 };
    if (animate) ed.cam.animateTo(target); else ed.cam.set(target);
    return;
  }
  const target = ed.cam.frame(box, { insets: INSETS, maxZoom: list ? 1.25 : 1, minZoom: 0.1 });
  if (animate) ed.cam.animateTo(target); else ed.cam.set(target);
}

function focusNode(id) {
  const b = nodeBox(id);
  if (!b) return;
  setSelection({ nodes: [id] });
  const z = Math.min(1.25, Math.max(ed.cam.settled.z, 0.8));
  const fits = b.w * z < ed.cam.vw - INSETS.left - INSETS.right && b.h * z < ed.cam.vh - INSETS.top - INSETS.bottom;
  const target = fits
    ? { z, x: b.x + b.w / 2 - ed.cam.vw / 2 / z, y: b.y + b.h / 2 - (INSETS.top + (ed.cam.vh - INSETS.top - INSETS.bottom) / 2) / z }
    : ed.cam.frame(b, { insets: INSETS, maxZoom: 1.25 });
  ed.cam.animateTo(target);
}

function viewCenter() {
  const c = ed.cam.settled;
  const vh = ed.cam.vh - INSETS.top - INSETS.bottom;
  return { x: c.x + ed.cam.vw / 2 / c.z, y: c.y + (INSETS.top + vh / 2) / c.z };
}

function worldToScreen(p) {
  if (!ed) return { x: 0, y: 0 };
  const s = ed.cam.toScreen(p.x, p.y);
  return { x: s.x + ed.stageRect.left, y: s.y + ed.stageRect.top };
}
function screenToWorld(p) {
  if (!ed) return { x: 0, y: 0 };
  return ed.cam.toWorld(p.x - ed.stageRect.left, p.y - ed.stageRect.top);
}

const snap = (v) => Math.round(v / GRID) * GRID;

// ── image par image ───────────────────────────────────────────────────

let raf = 0, drawRaf = 0, settleT = 0, camSaveT = 0;
function requestFrame() { if (!raf && ed) raf = requestAnimationFrame(frame); }
/** Repeint seulement le canevas (sections, titres lointains), sans toucher à la caméra. */
function requestDraw() { if (!drawRaf && !raf && ed) drawRaf = requestAnimationFrame(drawOnly); }
function drawOnly() { drawRaf = 0; ed.grid2d.draw(); }

/**
 * La caméra s'applique une fois par image, jamais dans un gestionnaire
 * d'événement (tech.md §3.2). Pendant un geste, #world porte `will-change`
 * (couche composée, fluide) ; 150 ms après le dernier mouvement on l'enlève et
 * Chromium re-rastérise le texte net à la nouvelle échelle.
 *
 * Rien de ce qui dépend du zoom n'est réécrit pendant le geste : `--z` ne vit
 * plus sur #world (le réécrire restylait les ~7 000 éléments des cartes, 100 à
 * 175 ms figées à chaque début et fin de zoom) mais sur les fils et les barres
 * de calcul, à l'arrêt ; les sections et les titres lointains sont peints sur
 * le canevas, à chaque image, pour presque rien.
 */
function frame() {
  raf = 0;
  if (drawRaf) { cancelAnimationFrame(drawRaf); drawRaf = 0; }
  const { cam, world } = ed;
  const dpr = window.devicePixelRatio || 1;
  const tx = Math.round(-cam.x * cam.z * dpr) / dpr;
  const ty = Math.round(-cam.y * cam.z * dpr) / dpr;
  const tr = `translate(${tx}px, ${ty}px) scale(${cam.z})`;
  if (world.style.transform !== tr) world.style.transform = tr;
  // déjà en mouvement à l'image précédente : on est au milieu d'un geste
  const wasMoving = world.classList.contains('moving');
  if (cam.z !== ed.lastZ) {
    ed.lastZ = cam.z;
    // changement isolé (chargement, cadrage instantané) : tout de suite ; au
    // milieu d'un geste (molette, pincement, animation) : à l'arrêt seulement
    const gesture = ed.smooth.active || cam.animating || performance.now() - ed.wheelAt < 200 || wasMoving;
    if (!gesture) { applyZ(); setLod(cam.z); }
    // le pourcentage suit le geste sans réécrire la barre à chaque image (settle donne le dernier mot)
    const now = performance.now();
    if (!gesture || now - (ed.zLabelAt || 0) > 120) { ed.zLabelAt = now; updateZoomLabel(); }
  }
  if (!wasMoving) world.classList.add('moving');
  clearTimeout(settleT);
  settleT = setTimeout(settle, 150);

  ed.grid2d.draw();
  ed.views.cull(cam.viewRect(240), cam.z, wasMoving);
  ed.interact.onCamera();
  ed.minimap.request();
  if (ed.project) {
    clearTimeout(camSaveT);
    camSaveT = setTimeout(() => { if (ed.project) emit('graph:changed', { reason: 'camera', history: false }); }, 900);
  }
}

/** Fin d'un geste : texte net, épaisseurs à jour, niveau de détail. */
function settle() {
  if (ed.smooth.active || ed.cam.animating) { settleT = setTimeout(settle, 60); return; }
  ed.world.classList.remove('moving');
  applyZ();
  updateZoomLabel();
  const lod = ed.lod;
  setLod(ed.cam.z);
  ed.views.cull(ed.cam.viewRect(240), ed.cam.z);
  if (lod !== ed.lod) requestDraw();
}

/**
 * Écrit le zoom là où il sert : les fils (épaisseur constante à l'écran) et
 * les barres de calcul en cours. Quelques centaines d'éléments, pas des milliers.
 */
function applyZ() {
  const z = String(ed.cam.z);
  if (z === ed.zApplied) return;
  ed.zApplied = z;
  ed.wiresSvg.style.setProperty('--z', z);
  for (const v of ed.views.nodes.values()) {
    if (v.prog.classList.contains('on')) v.prog.style.setProperty('--z', z);
  }
}

/**
 * Niveau de détail (da.md §4.7) avec hystérésis : on ne change de classe
 * qu'une fois le seuil franchi de 0,015 dans un sens ou l'autre.
 */
// Seuils bas : Quentin veut voir le contenu des blocs en dézoomant ; on ne simplifie
// que quand le texte devient illisible (≈ 3 px), sans jamais changer la taille d'un bloc.
const LOD_T = [0.45, 0.22, 0.1];
function setLod(z) {
  let l = 0;
  for (const th of LOD_T) if (z < th) l++;
  if (l === ed.lod) return;
  const edge = l > ed.lod ? LOD_T[l - 1] : LOD_T[ed.lod - 1];
  if (Math.abs(z - edge) < 0.015 && Math.abs(l - ed.lod) === 1) return;
  ed.world.classList.remove(`lod-${ed.lod}`);
  ed.lod = l;
  ed.views.lod = l;
  ed.world.classList.add(`lod-${l}`);
  // l'anneau de sélection des vues lointaines garde son épaisseur à l'écran ;
  // écrit en même temps que la classe (qui restyle déjà toutes les cartes)
  ed.world.style.setProperty('--zl', String(z));
  ed.stage.dataset.lod = String(l);
}

function watchDpr(cb) {
  const mq = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`);
  mq?.addEventListener('change', () => { cb(); watchDpr(cb); }, { once: true });
}

// ── canevas de la planche : grille, sections, titres lointains ────────
// Un seul canevas plein écran sous #world (comme Slate) : la grille de points
// de Slate (render.js drawGrid), les sections (sections.js) et, en vue
// lointaine, le titre de chaque bloc à taille écran fixe.

class BoardCanvas {
  constructor(canvas, ed) {
    this.c = canvas;
    this.ed = ed;
    this.cam = ed.cam;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    // les titres des vues lointaines passent *au-dessus* des cartes (calque
    // écran) : posés sous le monde, la carte du dessus les cachait
    this.tc = document.createElement('canvas');
    this.tc.className = 'ov-titles';
    ed.overlay.prepend(this.tc);
    this.tctx = this.tc.getContext('2d');
    this.titlesShown = false;
    this.w = 1; this.h = 1; this.dpr = 1;
    this.colors = null;
    this.tile = null;
    this.tileKey = '';
  }
  bust() { this.colors = null; this.tileKey = ''; }
  resize(w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.w = Math.max(1, w); this.h = Math.max(1, h); this.dpr = dpr;
    this.c.width = Math.round(this.w * dpr);
    this.c.height = Math.round(this.h * dpr);
    this.c.__w = this.w; this.c.__h = this.h;
    this.tc.width = this.c.width;
    this.tc.height = this.c.height;
    this.titlesShown = true;           // la taille a changé : le calque est à repeindre
    this.tileKey = '';
  }
  _colors() {
    if (!this.colors) {
      const cs = getComputedStyle(this.c);
      const v = (n, d) => cs.getPropertyValue(n).trim() || d;
      const theme = document.body.classList.contains('theme-light') ? 'light' : 'dark';
      this.colors = {
        theme,
        bg: v('--bg-canvas', '#09090b'),
        dot: v('--grid-dot', 'rgba(255,255,255,.075)'),
        strong: v('--grid-dot-strong', 'rgba(255,255,255,.14)'),
        accent: v('--accent', '#4d82f3'),
        txt: v('--txt', '#ececee'),
        txt2: v('--txt-2', 'rgba(236,236,238,.66)'),
        font: v('--font-ui', 'system-ui, sans-serif')
      };
    }
    return this.colors;
  }

  /**
   * Un carreau de 4 × 4 points (le point fort en premier) peint une fois quand
   * l'espacement change, puis répété par un motif : un seul remplissage par
   * image au lieu de milliers d'arcs (vue lointaine : 5 000 points).
   */
  _pattern(s, r, strong, col) {
    const dpr = this.dpr;
    const P = s * 4;                                   // période du carreau, px CSS
    const N = Math.max(4, Math.round(P * dpr));        // taille entière en px réels
    const key = `${N}|${r}|${strong}|${col.dot}|${col.strong}`;
    if (key !== this.tileKey) {
      const tc = this.tile || (this.tile = document.createElement('canvas'));
      tc.width = N; tc.height = N;
      const c = tc.getContext('2d');
      c.clearRect(0, 0, N, N);
      const sp = N / 4;
      c.fillStyle = col.dot;
      c.beginPath();
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          const x = (i + 0.5) * sp, y = (j + 0.5) * sp;
          c.moveTo(x + r * dpr, y);
          c.arc(x, y, r * dpr, 0, 6.2832);
        }
      }
      c.fill();
      if (strong) {
        c.fillStyle = col.strong;
        c.beginPath();
        c.arc(0.5 * sp, 0.5 * sp, (r + 0.5) * dpr, 0, 6.2832);
        c.fill();
      }
      this.pat = this.ctx.createPattern(tc, 'repeat');
      this.tileKey = key;
      this.tileN = N;
    }
    // le carreau fait N px réels pour P px CSS : on le ramène à la bonne taille
    return { pat: this.pat, k: P / this.tileN };
  }

  draw() {
    const { ctx, cam, ed } = this;
    const col = this._colors();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = col.bg;
    ctx.fillRect(0, 0, this.w, this.h);

    // points
    let step = GRID;
    while (step * cam.z < 16) step *= 4;
    while (step * cam.z > 90) step /= 2;
    const s = step * cam.z;
    if (s >= 6) {
      const fade = Math.min(1, Math.max(0, (s - 7) / 12));
      const r = cam.z > 1.6 ? 1.35 : 1.1;
      const { pat, k } = this._pattern(s, r, s * 4 < 260, col);
      const P = s * 4;
      // le point fort tombe sur les multiples de 4 pas (monde), comme avant
      const ox = -(((cam.x * cam.z) % P) + P) % P;
      const oy = -(((cam.y * cam.z) % P) + P) % P;
      pat.setTransform(new DOMMatrix().translateSelf(ox - s / 2, oy - s / 2).scaleSelf(k, k));
      ctx.globalAlpha = fade;
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.globalAlpha = 1;
    }
    if (!ed.project) return;

    // sections
    const st = ed.sect;
    if (ed.doc.groups.length || st.ghost) {
      st.widths = paintSections(ctx, cam, ed.doc.groups, {
        theme: col.theme, accent: col.accent, accentSel: col.accent, font: col.font, lod: ed.lod,
        selId: ed.sel.group, hotId: st.hot, dropId: st.drop, editingId: st.editing, ghost: st.ghost,
        born: bornProgress()
      }, t('graph.section'));
    }

    this.drawTitles(col);
  }

  /**
   * Titres des blocs en vue lointaine (da.md §4.7 : 12 px écran au-dessus de la carte), calque écran.
   * Dès 0,45 (lod 1) : l'en-tête de la carte n'y mesure plus que 3 à 6 px, son titre interne est caché
   * (graph.css) et c'est celui-ci qu'on lit. Une carte étroite garde un titre d'au moins 120 px, borné
   * par le titre voisin sur la même ligne et par toute carte à droite qui croise sa bande (jamais un titre
   * sur un autre titre ni sur le corps d'une carte voisine).
   */
  drawTitles(col) {
    const { cam, ed } = this;
    const t2 = this.tctx;
    const show = !!ed.project && ed.lod >= 1;
    if (!show && !this.titlesShown) return;
    t2.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    t2.clearRect(0, 0, this.w, this.h);
    this.titlesShown = show;
    if (!show) return;
    t2.font = `600 12px ${col.font}`;
    t2.textBaseline = 'bottom';
    t2.textAlign = 'left';
    const z = cam.z;
    const vis = [];        // titres à peindre
    const cards = [];      // cartes à l'écran (titre compris) : ce qu'un titre ne doit pas recouvrir
    for (const n of ed.doc.nodes) {
      const sx = (n.x - cam.x) * z, sy = (n.y - cam.y) * z;
      if (sx > this.w || sy - 20 > this.h || sx + n.w * z < -200) continue;
      const sh = (ed.views.get(n.id)?.h || estimateHeight(n, typeOf(n.type))) * z;
      if (sy + sh < -24) continue;
      const c = { n, sx, sy, sh };
      cards.push(c);
      if (sy >= -4) vis.push(c);
    }
    for (const v of vis) {
      const { n, sx, sy } = v;
      // la place du titre : sa carte (+ 64 px), au moins 120 px, bornée à droite par le titre voisin sur la
      // même ligne et par toute carte (placement libre : un peu plus haute ou plus basse) qui croise sa bande
      let max = Math.max(120, (n.w + 64) * z);
      for (const o of cards) {
        if (o === v || o.sx <= sx + 0.5) continue;
        if (Math.abs(o.sy - sy) < 16) max = Math.min(max, o.sx - sx - 10);
        else if (o.sy - 20 < sy - 4 && o.sy + o.sh > sy - 20) max = Math.min(max, o.sx - sx - 8);
      }
      // trop peu de place : pas de moignon (« Imag… Anim… »). Un titre coupé garde au moins un mot entier.
      if (max < 40) continue;
      const title = displayTitle(n);
      const shown = ellipsize(t2, title, max);
      if (!shown || (shown !== title && !keepsWord(title, shown))) continue;
      t2.fillStyle = ed.sel.nodes.has(n.id) ? col.txt : col.txt2;
      t2.fillText(shown, Math.round(sx), Math.round(sy - 6));
    }
  }
}

// ── chrome de la planche : dock, zoom, état vide ──────────────────────

function buildDock(ed) {
  const d = ed.dock;
  d.classList.add('dock', 'g-dock');
  d.replaceChildren();
  const btn = (cls, ico, label, tip, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.innerHTML = `${icon(ico, 16)}<span>${escapeText(label)}</span>`;
    b.dataset.tip = tip;
    b.addEventListener('click', onClick);
    return b;
  };
  ed.sectionBtn = btn('g-dock-btn', 'g-frame', t('dock.section'), t('dock.sectionTip'), () => ed.interact.toggleSectionTool());
  d.append(
    btn('g-dock-btn', 'plus', t('dock.add'), t('dock.addTip'), (e) => ed.palette.open({ origin: btnCenter(e) })),
    btn('g-dock-btn', 'recipe', t('dock.recipes'), t('dock.recipesTip'), (e) => ed.palette.open({ category: 'recipes', origin: btnCenter(e) })),
    ed.sectionBtn
  );
}

/** Centre (écran) du bouton cliqué : la palette s'ouvre depuis lui. */
function btnCenter(e) {
  const r = e?.currentTarget?.getBoundingClientRect?.();
  return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
}

/** Le bouton « Section » du dock reste allumé tant que l'outil attend son glisser. */
function syncTool() {
  ed.sectionBtn?.classList.toggle('on', ed.tool === 'section');
  ed.stage.classList.toggle('tool-section', ed.tool === 'section');
}

/**
 * Planche en lecture seule (graph.json abîmé) : une pastille fixe en haut,
 * dock et recettes désactivés — sinon la planche ressemble à une planche vide
 * normale et chaque geste rebondit sur un toast.
 */
function buildReadonly(ed) {
  const pill = document.createElement('div');
  pill.className = 'g-readonly';
  pill.hidden = true;
  const ico = document.createElement('span');
  ico.className = 'g-ro-ico';
  ico.innerHTML = icon('warn', 14);
  const txt = document.createElement('span');
  txt.className = 'g-ro-text';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'g-ro-btn';
  b.textContent = t('graph.readonly.reveal');
  b.addEventListener('click', () => {
    if (ed.project) window.mia?.shell?.reveal({ projectId: ed.project.id, rel: 'graph.json' });
  });
  pill.append(ico, txt, b);
  ed.board.append(pill);
  ed.roPill = pill;
  ed.roIco = ico;
  ed.roText = txt;
}

/**
 * Pourquoi la planche est en lecture seule (store.js, SPEC §21.1) : 'newer' (enregistrée par un
 * Mia plus récent), 'migration' (mise au format impossible), sinon un fichier abîmé. app.js ne
 * garde que state.readOnly : la raison vient de state.readOnlyReason quand il la transmet, de
 * l'évènement project:opened, ou se déduit du format du document (version plus haute que la nôtre).
 */
function readonlyReason(project, graph) {
  const r = state.readOnlyReason || project?.readOnlyReason || graph?.readOnlyReason;
  if (r === 'newer' || r === 'migration' || r === 'damaged') return r;
  if (Number(graph?.version) > GRAPH_VERSION) return 'newer';
  // un fichier abîmé s'ouvre vide (store.js) ; une planche lisible mais en lecture seule vient
  // d'une mise au format qui a échoué
  if (Array.isArray(graph?.nodes) && graph.nodes.length) return 'migration';
  return 'damaged';
}

function syncReadonly() {
  if (!ed?.roPill) return;
  const ro = !!(ed.project && ed.readonly);
  ed.roPill.hidden = !ro;
  if (ro) {
    const why = ed.readonlyReason || 'damaged';
    const key = why === 'newer' ? 'graph.readonly.newer' : why === 'migration' ? 'graph.readonly.migration' : 'graph.readonly.body';
    const strong = document.createElement('b');
    strong.textContent = t('graph.readonly.title');
    ed.roText.replaceChildren(strong, ` · ${t(key)}`);
    // une planche d'un Mia plus récent n'est pas abîmée : pas de pastille rouge
    ed.roPill.classList.toggle('info', why === 'newer');
    ed.roIco.innerHTML = icon(why === 'newer' ? 'info' : 'warn', 14);
  }
  ed.board.classList.toggle('g-readonly-on', ro);
  for (const b of ed.dock.querySelectorAll('button')) b.disabled = ro;
  if (ro && ed.tool) { ed.tool = null; syncTool(); }
}

function buildZoombar(ed) {
  const z = ed.zoombar;
  z.classList.add('zoombar', 'g-zoombar');
  z.replaceChildren();
  const mk = (cls, html, tip, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.innerHTML = html;
    if (tip) b.dataset.tip = tip;
    b.addEventListener('click', onClick);
    return b;
  };
  const center = () => ({ x: ed.cam.vw / 2, y: ed.cam.vh / 2 });
  ed.zoomLevel = mk('zb-level', '100 %', t('graph.zoom.level'), (e) => ed.interact.openZoomMenu(e.currentTarget));
  ed.minimapBtn = mk('zb-mini', icon('g-minimap', 16), `${t('graph.minimap.tip')} · M`, () => ed.minimap.toggle());
  const sep = () => { const s = document.createElement('span'); s.className = 'zb-sep'; return s; };
  z.append(
    mk('zb-btn', icon('zoom-out', 16), t('graph.zoom.out'), () => ed.smooth.by(center(), 1 / 1.25)),
    ed.zoomLevel,
    mk('zb-btn', icon('zoom-in', 16), t('graph.zoom.in'), () => ed.smooth.by(center(), 1.25)),
    sep(),
    mk('zb-btn', icon('fit', 16), `${t('graph.zoom.fit')} · ${t('graph.key.shift1')}`, () => fit()),
    ed.minimapBtn
  );
}

function updateZoomLabel() {
  if (!ed.zoomLevel) return;
  const s = t('graph.zoom.pct', { n: Math.round(ed.cam.z * 100) });
  setText(ed.zoomLevel, s);
}

/** Planche vide : une phrase et les recettes, rien d'autre (da.md : peu d'éléments par écran). */
function buildEmpty(ed) {
  const root = ed.emptyEl;
  root.classList.add('g-empty');
  root.replaceChildren();
  const inner = document.createElement('div');
  inner.className = 'be-inner';
  const title = document.createElement('div');
  title.className = 'be-title';
  title.textContent = t('graph.empty.title');
  const cards = document.createElement('div');
  cards.className = 'be-recipes';
  for (const [i, r] of allRecipes().entries()) {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'be-card';
    c.style.setProperty('--i', String(i));
    c.innerHTML = `<span class="be-glyph">${icon(r.icon, 18)}</span>`
      + `<span class="be-name">${escapeText(tl(r.label))}</span>`
      + `<span class="be-desc">${escapeText(tl(r.desc))}</span>`
      + `<span class="be-meta">${escapeText(tn('graph.empty.blocks', r.nodes.length, { n: r.nodes.length }))}</span>`;
    c.addEventListener('click', () => insertRecipe(r));
    cards.append(c);
  }
  const hint = document.createElement('div');
  hint.className = 'be-hint';
  const parts = t('graph.empty.hint', { key: '\u0000' }).split('\u0000');
  hint.append(parts[0] || '');
  const kbd = document.createElement('kbd');
  kbd.textContent = 'Tab';
  hint.append(kbd, parts[1] || '');
  inner.append(title, cards, hint);
  root.append(inner);
  updateEmpty();
}

function updateEmpty() {
  if (!ed?.emptyEl) return;
  const show = !!ed.project && ed.doc.nodes.length === 0 && !!ed.emptyEl.firstChild;
  ed.emptyEl.hidden = !show;
  // lecture seule : ni recettes ni « double-clic pour ajouter », juste le constat
  ed.emptyEl.classList.toggle('readonly', !!ed.readonly);
  const title = ed.emptyEl.querySelector('.be-title');
  if (title) {
    title.textContent = !ed.readonly ? t('graph.empty.title')
      : ed.readonlyReason === 'newer' ? t('graph.readonly.emptyNewer') : t('graph.readonly.empty');
  }
  ed.board.classList.toggle('g-is-empty', show);
}

// ── recettes et import ────────────────────────────────────────────────

/** Boîte qui englobe des blocs (vraies hauteurs si mesurées). */
function boxOfIds(ids) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const id of ids) {
    const b = nodeBox(id);
    if (!b) continue;
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** Décale un lot de blocs tout juste posés (cartes, fils, origine de l'arrivée). */
function shiftIds(ids, dx, dy) {
  if (!dx && !dy) return;
  for (const id of ids) {
    const n = ed.doc.node(id);
    if (n) relocate(id, n.x + dx, n.y + dy);
  }
}

/** Si la boîte sort de la vue, la caméra recule pour tout montrer. */
function revealBox(box) {
  if (!box) return;
  const view = ed.cam.viewRect(-40);
  const inside = box.x >= view.x && box.y >= view.y && box.x + box.w <= view.x + view.w && box.y + box.h <= view.y + view.h;
  if (!inside) ed.cam.animateTo(ed.cam.frame(box, { insets: INSETS, maxZoom: Math.min(1, ed.cam.settled.z) }));
}

/**
 * Pose une recette centrée sur `at` (ou sur la vue), avec des ids neufs.
 * Ensuite, avec les vraies hauteurs des cartes : ce qui se chevauche dans une
 * colonne de la recette descend, et le tout glisse jusqu'à la place libre la
 * plus proche — une recette ne se pose jamais sur des blocs existants.
 */
function insertRecipe(r, at) {
  if (!ed?.project) return [];
  if (ed.readonly) { toast(t('graph.toast.readonly'), { kind: 'info' }); return []; }
  const rec = typeof r === 'string' ? recipeById(r) : r?.nodes ? r : recipeById(r?.id);
  if (!rec) { console.warn('[editor] recette inconnue', r); return []; }
  const items = rec.nodes.filter((n) => typeOf(n.type)).map((n) => {
    const def = typeOf(n.type);
    const data = n.placeholder ? { placeholder: { ...n.placeholder } } : {};
    const w = def.width || 288;
    return { n, def, data, w, h: estimateHeight({ type: n.type, w, data, params: n.params || {} }, def) };
  });
  if (!items.length) return [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of items) {
    x0 = Math.min(x0, it.n.x); y0 = Math.min(y0, it.n.y);
    x1 = Math.max(x1, it.n.x + it.w); y1 = Math.max(y1, it.n.y + it.h);
  }
  const c = at && Number.isFinite(at.x) ? at : viewCenter();
  // décalage aligné sur la grille : les recettes sont dessinées en multiples de 24
  const ox = snap(c.x - (x0 + x1) / 2), oy = snap(c.y - (y0 + y1) / 2);
  const keyToId = new Map();
  const ids = batch('recipe', () => {
    const created = mutate('recipe', () => {
      const out = [];
      for (const it of items) {
        const node = ed.doc.addNode({ type: it.n.type, x: it.n.x + ox, y: it.n.y + oy, w: it.w, params: it.n.params || {}, data: it.data });
        keyToId.set(it.n.key, node.id);
        out.push(node.id);
      }
      for (const [fk, fp, tk, tp] of rec.edges || []) {
        const a = keyToId.get(fk), b = keyToId.get(tk);
        if (a && b && portDef(ed.doc.node(a).type, fp, 'out') && portDef(ed.doc.node(b).type, tp, 'in')) {
          ed.doc.addEdge({ from: { node: a, port: fp }, to: { node: b, port: tp } });
        }
      }
      return out;
    }, { animateNew: true, changed: new Set() }) || [];
    if (!created.length) return created;
    for (const id of created) ed.views.get(id)?.measure();
    // les cartes réelles sont parfois plus hautes que prévu : une colonne se tasse vers le bas
    const moved = settleColumns(created.map((id) => ({ id, ...nodeBox(id) })), { gap: GRID });
    for (const [id, y] of moved) relocate(id, ed.doc.node(id).x, y);
    // puis la recette entière glisse à la place libre la plus proche
    const box = boxOfIds(created);
    const p = findFree(box, { exclude: new Set(created), pad: GAP });
    shiftIds(created, p.x - box.x, p.y - box.y);
    afterChange({ changed: new Set(), reason: 'recipe' });
    return created;
  }) || [];
  if (!ids.length) return ids;
  setSelection({ nodes: ids });
  revealBox(boxOfIds(ids));
  return ids;
}

/**
 * Importe des fichiers du PC : copiés dans le projet par le principal, puis
 * posés en colonne à partir de `at` ({x, y} ou {near: id}). Avec `intoNodeId`
 * (un bloc Média qui attend un fichier), le premier remplit ce bloc.
 */
async function importFiles(paths, at, intoNodeId) {
  if (!ed?.project || !paths?.length) return [];
  if (ed.readonly) { toast(t('graph.toast.readonly'), { kind: 'info' }); return []; }
  const pid = ed.project.id;
  const slow = setTimeout(() => toast(tn('graph.toast.importing', paths.length, { n: paths.length }), { kind: 'info' }), 600);
  let res;
  try {
    res = await window.mia.media.importPaths(pid, paths);
  } catch (e) {
    res = paths.map(() => ({ ok: false, error: String(e?.message || e) }));
  } finally { clearTimeout(slow); }
  if (!ed.project || ed.project.id !== pid) return [];
  const ok = [];
  (res || []).forEach((r, i) => {
    if (r?.ok && r.data) ok.push(r.data);
    else toast(t('graph.toast.importFailed', { name: baseName(paths[i]), error: r?.error || t('graph.toast.unknownError') }), { kind: 'error' });
  });
  return placeMedia(ok, at, intoNodeId);
}

/**
 * Pose des médias déjà importés (`data` de SPEC §3.2). Utilisé aussi par le
 * collage. Tout se fait en une seule entrée d'annulation : remplir le Média
 * visé, pousser vers le bas ce qui se trouvait sous lui s'il a grandi, poser
 * les autres fichiers en colonne avec leurs vraies hauteurs, à une place libre.
 */
function placeMedia(list, at, intoNodeId) {
  if (!list.length) return [];
  if (ed.readonly) { toast(t('graph.toast.readonly'), { kind: 'info' }); return []; }
  let target = intoNodeId ? ed.doc.node(intoNodeId) : null;
  if (target && target.type !== 'import') target = null;
  const def = typeOf('import');
  const w = def?.width || 336;
  const near = at?.near && ed.doc.node(at.near) ? nodeBox(at.near) : null;
  const explicit = !near && at && Number.isFinite(at.x) && Number.isFinite(at.y);
  const ids = [], fresh = [];
  const changed = new Set();
  if (target) { changed.add(target.id); for (const d of ed.doc.downstream(target.id)) changed.add(d); }
  const h0 = target ? nodeBox(target.id).h : 0;
  // le Média rempli grandit, et l'aval aussi (son puits prend le ratio de l'image) :
  // chacun pousse ce qui est sous lui
  const before = new Map([...changed].map((id) => [id, nodeBox(id)?.h || 0]));

  batch('import', () => {
    mutate('import', () => {
      let rest = list;
      if (target) {
        const want = target.data?.placeholder?.kind;
        if ((want === 'image' || want === 'video') && list[0].kind && list[0].kind !== want) {
          toast(t('graph.toast.kindMismatch', { kind: kindLabel(want).toLowerCase() }), { kind: 'info' });
        }
        // le rôle annoncé par la recette (« Image de début ») reste le titre du
        // bloc, dans les deux langues : il suit la langue de l'interface
        const ph = target.data?.placeholder;
        const role = target.data?.role || (ph && (ph.fr || ph.en) ? { fr: ph.fr, en: ph.en } : null);
        target.data = { ...list[0], ...(role ? { role } : {}) };
        ids.push(target.id);
        rest = list.slice(1);
      }
      let x, y;
      if (target) { x = target.x; y = target.y + h0 + GRID; }
      else if (near) { x = near.x + near.w + GRID * 4; y = near.y; }
      else if (explicit) { x = at.x - w / 2; y = at.y - 18; }
      else {
        const c = viewCenter();
        x = c.x - w / 2;
        y = c.y - estimateHeight({ type: 'import', w, data: list[0] }, def) / 2;
      }
      for (const data of rest) {
        const p = ed.snap ? { x: snap(x), y: snap(y) } : { x: Math.round(x), y: Math.round(y) };
        const n = ed.doc.addNode({ type: 'import', x: p.x, y: p.y, w, data });
        ids.push(n.id);
        fresh.push(n.id);
        y += estimateHeight(n, def) + GRID;
      }
    }, { animateNew: true, changed });

    // vraies hauteurs (F monte le puits au ratio du média tout de suite)
    for (const id of ids) ed.views.get(id)?.measure();
    if (target) {
      const exclude = new Set(fresh);
      // du haut vers le bas : ce que pousse un bloc est déjà à sa place quand on mesure le suivant
      const order = [...before.keys()].filter((id) => ed.doc.node(id)).sort((a, b) => ed.doc.node(a).y - ed.doc.node(b).y);
      for (const id of order) {
        ed.views.get(id)?.measure();
        pushBelow(id, before.get(id), nodeBox(id).h, exclude);
        // l'image peut encore changer la hauteur à son chargement : on surveille un moment
        ed.grow.set(id, Date.now() + 5000);
      }
    }
    if (fresh.length) {
      // la colonne, avec les vraies hauteurs, un pas de grille entre deux cartes
      let y = ed.doc.node(fresh[0]).y;
      for (const id of fresh) {
        const n = ed.doc.node(id);
        relocate(id, n.x, y);
        y += nodeBox(id).h + GRID;
      }
      // jamais par-dessus un bloc existant, et avec de l'air (48 px) autour
      const box = boxOfIds(fresh);
      const exclude = new Set(fresh);
      const p = findFree(box, { prefer: near ? 'right' : target ? 'below' : 'any', exclude, pad: GAP });
      shiftIds(fresh, p.x - box.x, p.y - box.y);
      // lâché dans une section : il y entre
      if (explicit) adoptSections(ed.doc.groups, fresh.map((id) => nodeBox(id)));
    }
    afterChange({ changed: new Set(), reason: 'import' });
  });
  if (!ids.length) return ids;
  setSelection({ nodes: ids });
  if (fresh.length) revealBox(boxOfIds(fresh));
  return ids;
}

/**
 * Un bloc a grandi de h0 à h1 : ce qui est juste dessous (même colonne) descend
 * pour garder au moins 48 px d'écart. Tout le dessous bouge d'un bloc, sa mise
 * en page est gardée. Renvoie true si quelque chose a bougé.
 */
function pushBelow(id, h0, h1, exclude = null) {
  const t0 = ed.doc.node(id);
  if (!t0 || !(h1 > h0)) return false;
  const oldBottom = t0.y + h0, newBottom = t0.y + h1;
  const below = ed.doc.nodes.filter((n) => n.id !== id && !(exclude && exclude.has(n.id))
    && n.y >= oldBottom - 8 && n.x < t0.x + t0.w + GRID && n.x + n.w > t0.x - GRID);
  if (!below.length) return false;
  const minTop = Math.min(...below.map((n) => n.y));
  const delta = Math.ceil((newBottom + GAP - minTop) / 2) * 2;
  if (delta <= 0) return false;
  for (const n of below) relocate(n.id, n.x, n.y + delta);
  return true;
}

// ── pour le pont des assistants : ranger, faire apparaître, sections ──

/**
 * Range des blocs de gauche à droite selon les fils (layout.js `layered`),
 * en glissant 420 ms (--ease-cam). Une seule entrée d'annulation.
 */
function arrange(ids, { animate = true, fitAfter = false } = {}) {
  if (!ed?.project || ed.readonly) return Promise.resolve(false);
  const list = (ids && ids.length ? ids : ed.doc.nodes.map((n) => n.id)).filter((id) => ed.doc.node(id));
  if (!list.length) return Promise.resolve(false);
  const set = new Set(list);
  const boxes = list.map((id) => ({ id, ...nodeBox(id) }));
  const portIndex = (e) => Math.max(0, inputDefs(ed.doc.node(e.to.node).type).findIndex((p) => p.id === e.to.port));
  const edges = ed.doc.edges.filter((e) => set.has(e.from.node) && set.has(e.to.node))
    .map((e) => ({ from: e.from.node, to: e.to.node, port: portIndex(e) }));
  const pos = layered(boxes, edges);
  ed.interact.cancel();
  ed.history.begin('arrange');
  const from = new Map(list.map((id) => { const n = ed.doc.node(id); return [id, { x: n.x, y: n.y }]; }));
  return new Promise((resolve) => {
    const finish = () => {
      for (const [id, p] of pos) { const n = ed.doc.node(id); if (n) { n.x = p.x; n.y = p.y; } }
      ed.history.commit();
      afterChange({ changed: new Set(), reason: 'arrange' });
      if (fitAfter) fit(list);
      resolve(true);
    };
    const D = ms('cam');
    if (!animate || !D) { finish(); return; }
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, Math.max(0, (now - t0) / D));
      const e = easeCam(k);
      for (const [id, p] of pos) {
        const n = ed.doc.node(id), f = from.get(id);
        if (!n || !f) continue;
        n.x = f.x + (p.x - f.x) * e;
        n.y = f.y + (p.y - f.y) * e;
        ed.views.get(id)?.setPos(n.x, n.y);
        ed.wires.updateNode(id);
      }
      requestDraw();
      ed.minimap.request();
      if (k < 1) requestAnimationFrame(step); else finish();
    };
    requestAnimationFrame(step);
  });
}

/** Rejoue la petite arrivée d'un bloc (180 ms, depuis son centre) : un assistant vient de le poser. */
function animateAdd(id) {
  const v = ed?.views.get(id), n = ed?.doc.node(id);
  if (!v || !n || reduced()) return;
  const el = v.el;
  el.classList.remove('entering');
  void el.offsetWidth;            // relance l'animation
  v._centerOrigin(n);
  el.classList.add('entering');
  const done = (e) => {
    if (e.target !== el) return;
    el.removeEventListener('animationend', done);
    el.classList.remove('entering');
    el.style.transformOrigin = '';
  };
  el.addEventListener('animationend', done);
}

/**
 * Nouvelle section. `box` = {x, y, w, h} (monde), {around: [ids]} (marge de
 * 48 px) ou rien (au centre de la vue). `edit` : le nom passe tout de suite en
 * édition, « Section » sélectionné (SPEC §15).
 */
function addSection(box, { title = null, tone = null, edit = false, select: doSelect = true } = {}) {
  if (!ed?.project) return null;
  let b = box;
  if (box?.around) {
    const bb = bbox(box.around.filter((id) => ed.doc.node(id)));
    if (!bb) return null;
    b = boxAround(bb);
  }
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) {
    const c = viewCenter();
    b = { x: snap(c.x - 360), y: snap(c.y - 216), w: 720, h: 432 };
  }
  const g = mutate('section', () => ed.doc.addGroup({
    x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w || 720), h: Math.round(b.h || 432),
    title: title ?? t('graph.section'), tone: toneKey(tone)
  }));
  if (!g) return null;
  sectionBorn(g.id);
  if (doSelect) setSelection({ nodes: [], group: g.id });
  if (edit) {
    // le nom passe en édition tout de suite (on peut taper aussitôt) ; si le titre ou le cadre
    // sortent de la zone utile (sous les onglets, sur les îlots du bas), la vue glisse pour
    // montrer la section entière — le champ suit la caméra (interact.onCamera)
    revealSection(g.id);
    ed.interact.renameSection(g.id, { select: true });
  }
  return g.id;
}

/** Recadre doucement (ease-cam) si une section neuve n'est pas entière dans la zone utile ; jamais plus près. */
function revealSection(id) {
  const g = ed.doc.group(id);
  if (!g) return;
  syncViewport();
  const cam = ed.cam, c = cam.settled, z = c.z;
  if (cam.vw < 80 || cam.vh < 80) return;
  const fs = titlePx(z, ed.lod), lift = titleLift(ed.lod);
  // zone utile (écran) : sous la barre de titre et ses onglets, au-dessus du dock et du zoom
  const top = 56, bottom = cam.vh - 76, left = 16, right = cam.vw - 16;
  const sx = (g.x - c.x) * z, sy = (g.y - c.y) * z;
  const titleTop = sy - lift - fs * 1.25;
  const fits = titleTop >= top && sy + g.h * z <= bottom && sx >= left && sx + Math.max(g.w * z, 160) <= right;
  if (fits) return;
  const pad = (lift + fs * 1.25 + 8) / z;
  const box = { x: g.x, y: g.y - pad, w: g.w, h: g.h + pad };
  cam.animateTo(cam.frame(box, { insets: { top: top + 8, right: 32, bottom: cam.vh - bottom + 8, left: 32 }, maxZoom: z, minZoom: 0.1 }));
}

/**
 * Une section qui naît se forme (SPEC §20.1) : son cadre se resserre d'un rien et
 * son titre monte en fondu, peints sur le canevas pendant --dur-enter.
 */
function sectionBorn(id) {
  const D = ms('enter');
  if (!D) return;
  ed.sect.born.set(id, performance.now());
  const step = () => {
    const now = performance.now();
    for (const [gid, t0] of ed.sect.born) if (now - t0 >= D) ed.sect.born.delete(gid);
    requestDraw();
    if (ed.sect.born.size) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Avancement (0 → 1, courbe ease-out) des sections qui naissent, pour la peinture. */
function bornProgress() {
  if (!ed.sect.born.size) return null;
  const D = ms('enter') || 1, now = performance.now(), out = new Map();
  for (const [id, t0] of ed.sect.born) {
    const k = Math.min(1, Math.max(0, (now - t0) / D));
    out.set(id, easeFn('out')(k));
  }
  return out;
}

// ── contexte interne partagé avec les autres modules ──────────────────

function internals() {
  return {
    api: editor,
    t, tl,
    runs,
    mutate,
    batch,
    afterChange,
    requestFrame,
    requestDraw,
    syncTool,
    relocate,
    findFree,
    resolveConnect,
    addSection,
    arrange,
    setSelection,
    syncSelectionClasses,
    refreshRun,
    refreshAllRuns,
    updateNode,
    setParam,
    addNode,
    removeNodes,
    connect,
    connectProblem,
    disconnect,
    portType,
    connections,
    inputsOf,
    insertRecipe,
    importFiles,
    placeMedia,
    nodeBox,
    bbox,
    fit,
    focusNode,
    viewCenter,
    snapValue: snap,
    kindLabel,
    setPref,

    /**
     * Déplace un bloc tout juste posé pour que son port `portId` tombe sur `at`
     * (un fil lâché dans le vide). Une mesure synchrone, une seule fois.
     */
    placePortAt(nodeId, portId, dir, at) {
      const n = ed.doc.node(nodeId), v = ed.views.get(nodeId);
      if (!n || !v || !at) return;
      v.measure();
      const y = v.anchorY(portId, dir);
      n.x = Math.round(dir === 'in' ? at.x : at.x - n.w);
      n.y = Math.round(at.y - y);
      if (ed.snap) { n.x = snap(n.x); n.y = snap(n.y); }
      v.apply(n);
      // l'arrivée part du point de lâcher, là où tombe le port : le fil ne quitte jamais sa pastille
      if (v.el.classList.contains('entering')) v.el.style.transformOrigin = `${at.x}px ${at.y}px`;
      ed.wires.updateNode(nodeId);
    },

    /** Point d'accroche d'un port en coordonnées monde. */
    anchor(nodeId, portId, dir) {
      const n = ed.doc.node(nodeId);
      const v = ed.views.get(nodeId);
      if (!n || !v) return null;
      return { x: dir === 'out' ? n.x + n.w : n.x, y: n.y + v.anchorY(portId, dir) };
    },

    /** Tout ce qui décide de l'apparence d'un fil. */
    wireState(e) {
      const s = ed.sel, from = e.from.node, to = e.to.node;
      const A = ed.doc.node(from), B = ed.doc.node(to);
      const outT = portType(from, e.from.port, 'out');
      const inDef = B ? portDef(B.type, e.to.port, 'in') : null;
      return {
        hot: s.nodes.has(from) || s.nodes.has(to) || ed.hover === from || ed.hover === to || ed.hoverEdge === e.id,
        sel: s.edge === e.id,
        run: runs.state(to).kind === 'running',
        stale: runs.isStale(to),
        bypass: !!(A?.bypass || B?.bypass),
        bad: !inDef || !compatible(outT, inDef.type),
        t: outT || 'media'
      };
    },

    setHover(id, leaving) {
      if (id == null && leaving != null && ed.hover !== leaving) return;
      if (ed.hover === id) return;
      const prev = ed.hover;
      ed.hover = id;
      if (prev) ed.wires.styleNode(prev);
      if (id) ed.wires.styleNode(id);
    },

    onNodeResized(id, anchorsMoved, h0) {
      if (anchorsMoved) ed.wires.updateNode(id);
      // un Média tout juste rempli qui grandit encore (image chargée) pousse ce
      // qui est dessous : rattaché à l'entrée d'annulation de l'import, pas une neuve
      const until = ed.grow.get(id);
      if (until) {
        const v = ed.views.get(id);
        if (Date.now() > until) ed.grow.delete(id);
        else if (v && h0 && v.h > h0 + 1 && !ed.interact.busy && !ed.readonly && pushBelow(id, h0, v.h)) {
          afterChange({ changed: new Set(), reason: 'grow', history: false });
        }
      }
      ed.minimap.request();
      if (ed.lod >= 1 || ed.doc.groups.length) requestDraw();
      ed.interact.onNodeResized?.(id);
    },

    openNodeMenu(id, at) { ed.interact.openNodeMenu(id, at); },

    /** Vignette d'un bloc : poster/image du média, sinon du résultat courant. */
    thumbFor(node) {
      const pid = ed.project?.id;
      if (!pid) return null;
      let rel = null;
      if (node.type === 'import') {
        const d = node.data || {};
        // un son : sa forme d'onde (blanche, faite pour un masque) ne se lit pas en vignette ; le glyphe suffit
        rel = d.kind === 'audio' ? null : d.poster || (d.kind === 'image' ? d.src : null);
      } else {
        const outs = runs.current(node.id)?.outputs;
        const first = outs ? Object.values(outs)[0] : null;
        rel = first?.poster || (first?.kind === 'image' ? first.path : null);
      }
      return rel ? mediaUrl(rel, pid) : null;
    },

    /** L'objet `api` donné à mountBody (SPEC §6.5). */
    bodyApi(id) {
      return {
        nodeId: id,
        get node() { return ed.doc.node(id); },
        setParam: (key, v) => setParam(id, key, v, true),
        setData: (patch, opts = {}) => setDataFromBody(id, patch || {}, opts),
        run: (mode) => emit('node:run', { nodeId: id, mode: mode ?? null }),
        cancel: () => {
          const st = runs.state(id);
          if (st?.jobId) window.mia?.engine?.cancel(st.jobId);
        },
        graph: editor,
        mediaUrl: (rel, pid) => mediaUrl(rel, pid || ed.project?.id),
        openInspector: () => emit('inspector:open', { nodeId: id }),
        openViewer: (opts = {}) => emit('viewer:open', { nodeId: id, ...opts }),
        reveal: (rel) => ed.project && window.mia?.shell?.reveal({ projectId: ed.project.id, rel }),
        currentRun: () => runs.current(id),
        runs: () => runs.list(id),
        pin: (runId) => {
          updateNode(id, { pinnedRun: runId || null });
          emit('runs:changed', { nodeId: id });
        },
        inputSource: (port) => inputSources(id, port)[0] || null,
        inputSources: (port) => inputSources(id, port),
        portType: (port, dir = 'in') => portType(id, port, dir),
        el: () => ed.views.get(id)?.el || null
      };
    }
  };
}

// Clés de `data` qu'écrit le système (proxy vidéo, affiche arrivés en tâche de
// fond), jamais Quentin : elles n'entrent pas dans l'historique.
const SYSTEM_DATA = new Set(['proxy', 'poster', 'meta', 'preview']);

/**
 * `api.setData` du corps (F). Un patch « système » (proxy arrivé minutes après
 * l'import) n'est pas un geste : pas d'entrée d'annulation, pas de toast
 * « lecture seule », et il est reporté dans les instantanés de l'historique
 * pour qu'un Ctrl+Z ultérieur ne remette pas le proxy à null.
 */
function setDataFromBody(id, patch, opts) {
  const node = ed.doc.node(id);
  if (!node) return false;
  const keys = Object.keys(patch);
  const system = opts.history === false || (keys.length > 0 && keys.every((k) => SYSTEM_DATA.has(k)));
  if (!system) return updateNode(id, { data: patch }, { fromBody: true, history: opts.history ?? true });
  if (keys.every((k) => node.data?.[k] === patch[k])) return true;
  const src = node.data?.src;
  const changed = new Set(ed.doc.downstream(id));
  mutate('system', () => {
    node.data = node.data || {};
    for (const k of keys) { if (patch[k] === undefined) delete node.data[k]; else node.data[k] = patch[k]; }
  }, { history: false, changed, system: true });
  ed.history.rewrite((c) => {
    for (const n of c.nodes || []) {
      if (n.id !== id || !n.data || n.data.src !== src) continue;
      for (const k of keys) { if (patch[k] === undefined) delete n.data[k]; else n.data[k] = patch[k]; }
    }
  });
  return true;
}

// ── petits outils ─────────────────────────────────────────────────────

/** « Animer le p… » garde « Animer » entier ; « Imag… » ne garde rien d'entier. */
function keepsWord(full, cut) {
  const kept = cut.replace(/…$/, '').trimEnd();
  const first = String(full).trim().split(/\s+/)[0] || '';
  return kept.length >= first.length;
}

const round2 = (v) => Math.round(v * 100) / 100;
const round4 = (v) => Math.round(v * 10000) / 10000;
const baseName = (p) => String(p || '').split(/[\\/]/).pop();
function escapeText(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
