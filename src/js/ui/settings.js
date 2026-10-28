/**
 * Settings: one dialog, opened from the gear in the title bar.
 * Language (rebuilds the window), theme (live), board options, folders
 * (projects, LoRA, extra models), the engine, the assistants that can drive
 * Mia (Claude, Codex), and a word about Mia.
 *
 * Prefs are always written as a patch (SPEC §3.4): the main process merges
 * it into prefs.json and sends the whole thing back.
 *
 * Folders are typed or pasted in a Mia field (Enter keeps them), dropped on
 * their row from Explorer, or picked with « Parcourir… » — the native picker
 * is only the fallback (SPEC §0).
 */
import { el, $, shellDo } from '../util.js';
import { icon, logo } from '../icons.js';
import { t, register, setLang, lang } from '../i18n.js';
import { state } from '../state.js';
import { emit, on } from '../bus.js';
import { openModal } from './modal.js';
import { toast } from './toasts.js';
import { tip } from './tooltip.js';
import { segmented, toggle, textField, button } from './controls.js';
import { money, shortDate } from './budget.js';

register({
  fr: {
    'set.title': 'Réglages',
    'set.button': 'Réglages',
    'set.close': 'Fermer',
    'set.secLook': 'Apparence',
    'set.secBoard': 'Planche',
    'set.secFolders': 'Dossiers',
    'set.secEngine': 'Moteur',
    'set.secAssist': 'Assistants (Claude, Codex)',
    'set.secAbout': 'À propos',
    'set.lang': 'Langue',
    'set.langHint': 'Mia se relance pour changer de langue ; ton travail est enregistré avant.',
    'set.theme': 'Thème',
    'set.dark': 'Sombre',
    'set.light': 'Clair',
    'set.wires': 'Câbles',
    'set.wiresHint': 'Colorés : chaque câble prend la couleur de ce qu’il transporte.',
    'set.wiresSober': 'Sobres',
    'set.wiresColor': 'Colorés',
    'set.snap': 'Grille aimantée',
    'set.snapHint': 'Les blocs s’alignent sur la grille quand tu les déplaces (ou en tenant Alt).',
    'set.minimap': 'Minicarte',
    'set.minimapHint': 'Une vue d’ensemble de la planche, en bas à droite.',
    'set.projects': 'Dossier des projets',
    'set.projectsHint': 'Colle un chemin puis Entrée, glisse un dossier ici, ou parcours.',
    'set.loras': 'Dossiers de LoRA',
    'set.lorasHint': 'Les LoRA rangés dans ces dossiers (et leurs sous-dossiers) deviennent utilisables dans les blocs.',
    'set.models': 'Dossiers de modèles en plus',
    'set.modelsHint': 'Mia y cherche aussi des modèles, en plus du dossier du moteur.',
    'set.addFolder': 'Ajouter un dossier…',
    'set.removeFolder': 'Retirer de la liste',
    'set.removeHint': 'Le dossier et ses fichiers restent sur le disque.',
    'set.folderRemovedKept': 'Dossier retiré de la liste : il reste sur le disque, avec ses fichiers.',
    'set.folderAdded': 'Dossier ajouté',
    'set.folderRemoved': 'Dossier retiré de la liste',
    'set.folderKnown': 'Ce dossier est déjà dans la liste',
    'set.engine': 'Dossier du moteur',
    'set.engineHint': 'Le dossier où vivent ComfyUI et les modèles. Mia n’y ajoute que les modèles et les LoRA que tu installes.',
    'set.comfy': 'Adresse de ComfyUI',
    'set.comfyHint': 'Le moteur tourne sur ce PC : seule une adresse locale est acceptée.',
    'set.browse': 'Parcourir…',
    'set.open': 'Ouvrir',
    'set.openTip': 'Ouvrir dans l’Explorateur',
    'set.notSet': 'Non défini',
    'set.saved': 'Réglage enregistré',
    'set.failed': 'Le réglage n’a pas pu être enregistré : {why}',
    'set.badUrl': 'Adresse refusée : elle doit être locale, par exemple http://127.0.0.1:8188',
    'set.badPath': 'Ce n’est pas un chemin de dossier complet (par exemple D:\\Mia\\Projets).',
    'set.rootInEngine': 'Le dossier des projets et le dossier du moteur doivent rester séparés : l’un ne peut pas être dans l’autre.',
    'set.notFolder': 'Glisse un dossier, pas un fichier.',
    'set.folderChanged': 'Dossier changé',
    'set.pickFailed': 'Impossible d’ouvrir le sélecteur de dossier',
    'set.openFailed': 'Impossible d’ouvrir ce dossier : {why}',
    'set.bridge': 'Pilotage par un assistant',
    'set.secCloud': 'Comptes en ligne',
    'set.hf': 'Higgsfield',
    'set.hfHint': 'Les modèles en ligne (Seedance, Kling, MiniMax 2K…) calculent chez Higgsfield : ta carte graphique reste libre, mais chaque calcul coûte des crédits. Crée une clé sur console.higgsfield.ai, puis colle-la ici (ID:SECRET). Elle reste chiffrée sur ce PC et Mia ne la montre plus.',
    'set.hfLinked': 'Relié · clé …{tail}',
    'set.hfOff': 'Pas relié',
    'set.hfPlaceholder': 'ID:SECRET',
    'set.hfLink': 'Relier',
    'set.hfCheck': 'Vérifier',
    'set.hfUnlink': 'Délier',
    'set.hfChecking': 'Vérification auprès de Higgsfield…',
    'set.hfOk': 'Compte relié : les modèles en ligne sont prêts.',
    'set.hfStillOk': 'La clé est toujours acceptée.',
    'set.hfGone': 'Compte délié : la clé est effacée de ce PC.',
    'set.hfTopUp': 'Ta dernière recharge',
    'set.hfTopUpHint': 'Higgsfield ne donne pas le solde à Mia. Indique le montant de ta dernière recharge, en dollars : Mia en retire ce qui a été dépensé depuis et affiche le reste dans le coin de la planche.',
    'set.hfTopUpPh': 'ex. 50',
    'set.hfTopUpSave': 'Garder',
    'set.hfTopUpClear': 'Oublier',
    'set.hfTopUpNow': 'Recharge de {amount} le {date} · dépensé depuis : {spent} · reste ≈ {left}',
    'set.hfTopUpWait': 'Recharge de {amount} le {date}.',
    'set.hfTopUpNone': 'Aucune recharge indiquée : le coin de la planche ne montre que les dépenses du mois.',
    'set.hfConsole': 'Voir mon solde sur Higgsfield',
    'set.bridgeOn': 'Actif · port {port}',
    'set.bridgeOnNoPort': 'Actif',
    'set.bridgeOff': 'Inactif',
    'set.bridgeChecking': 'Vérification…',
    'set.bridgeLast': 'Dernier passage : {who}, {when}',
    'set.assist1': 'Dis à Claude ou à Codex ce que tu veux faire (« anime cette image », « passe ce clip en profondeur ») : tu les vois créer la planche, poser et relier les blocs, régler et lancer le calcul, ici même. Ctrl+Z annule ce qu’ils font.',
    'set.assist2': 'Ensuite, il la trouve sous le nom « mia » et l’ouvre si elle est fermée. Tout reste sur ce PC.',
    'set.assistAdd': 'Ajoute Mia à ton assistant, une seule fois :',
    'set.assistAddMaybe': 'Si ton assistant ne connaît pas encore Mia, ajoute-la, une seule fois :',
    'set.assistHasOne': 'Mia est ajoutée à {who} : il la trouve sous le nom « mia » et l’ouvre si elle est fermée. Tout reste sur ce PC.',
    'set.assistHasBoth': 'Mia est ajoutée à Claude et à Codex : ils la trouvent sous le nom « mia » et l’ouvrent si elle est fermée. Tout reste sur ce PC.',
    'set.assistAlso': 'Pour l’ajouter aussi à {who} :',
    'set.assistClaude': 'Claude Code — dans un terminal :',
    'set.assistCodex': 'Codex — à la fin de config.toml, dans le dossier .codex de ton dossier personnel :',
    'set.copyCmd': 'Copier la commande',
    'set.copyBlock': 'Copier le bloc',
    'set.copied': 'Commande copiée',
    'set.copiedBlock': 'Bloc copié',
    'set.tagline': 'Planche nodale pour l’IA locale',
    'set.version': 'Version {v}',
    'set.versionDate': 'Version {v} · {date}',
    'set.data': 'Données de l’app :',
    'set.whatsNew': 'Nouveautés',
    'set.newsTitle': 'Nouveautés',
    'set.newsOf': 'Mia {v} · {date}',
    'set.newsToast': 'Mia {v} · Nouveautés',
    'set.newsSee': 'Voir',
    'set.newsOlder': 'Versions précédentes',
    'set.newsLess': 'Masquer les versions précédentes',
    'set.newsMissing': 'Le journal des versions est introuvable dans cette copie de Mia.',
    'set.newsNoSection': 'Rien de noté pour la version {v}.',
    'set.newsFrOnly': ''
  },
  en: {
    'set.title': 'Settings',
    'set.button': 'Settings',
    'set.close': 'Close',
    'set.secLook': 'Appearance',
    'set.secBoard': 'Board',
    'set.secFolders': 'Folders',
    'set.secEngine': 'Engine',
    'set.secAssist': 'Assistants (Claude, Codex)',
    'set.secAbout': 'About',
    'set.lang': 'Language',
    'set.langHint': 'Mia restarts to change language; your work is saved first.',
    'set.theme': 'Theme',
    'set.dark': 'Dark',
    'set.light': 'Light',
    'set.wires': 'Wires',
    'set.wiresHint': 'Coloured: each wire takes the colour of what it carries.',
    'set.wiresSober': 'Sober',
    'set.wiresColor': 'Coloured',
    'set.snap': 'Snap to grid',
    'set.snapHint': 'Blocks line up on the grid when you move them (or while holding Alt).',
    'set.minimap': 'Minimap',
    'set.minimapHint': 'An overview of the board, bottom right.',
    'set.projects': 'Projects folder',
    'set.projectsHint': 'Paste a path then Enter, drop a folder here, or browse.',
    'set.loras': 'LoRA folders',
    'set.lorasHint': 'The LoRAs kept in these folders (and their subfolders) become usable in the blocks.',
    'set.models': 'Extra model folders',
    'set.modelsHint': 'Mia also looks for models there, besides the engine folder.',
    'set.addFolder': 'Add a folder…',
    'set.removeFolder': 'Remove from the list',
    'set.removeHint': 'The folder and its files stay on the disk.',
    'set.folderRemovedKept': 'Folder removed from the list: it stays on the disk, with its files.',
    'set.folderAdded': 'Folder added',
    'set.folderRemoved': 'Folder removed from the list',
    'set.folderKnown': 'This folder is already in the list',
    'set.engine': 'Engine folder',
    'set.engineHint': 'The folder where ComfyUI and the models live. Mia only adds the models and LoRAs you install there.',
    'set.comfy': 'ComfyUI address',
    'set.comfyHint': 'The engine runs on this PC: only a local address is accepted.',
    'set.browse': 'Browse…',
    'set.open': 'Open',
    'set.openTip': 'Open in Explorer',
    'set.notSet': 'Not set',
    'set.saved': 'Setting saved',
    'set.failed': 'The setting could not be saved: {why}',
    'set.badUrl': 'Address refused: it must be local, for example http://127.0.0.1:8188',
    'set.badPath': 'This is not a full folder path (for example D:\\Mia\\Projects).',
    'set.rootInEngine': 'The projects folder and the engine folder must stay apart: one cannot be inside the other.',
    'set.notFolder': 'Drop a folder, not a file.',
    'set.folderChanged': 'Folder changed',
    'set.pickFailed': 'Could not open the folder picker',
    'set.openFailed': 'Could not open this folder: {why}',
    'set.bridge': 'Driven by an assistant',
    'set.secCloud': 'Online accounts',
    'set.hf': 'Higgsfield',
    'set.hfHint': 'Online models (Seedance, Kling, MiniMax 2K…) run at Higgsfield: your graphics card stays free, but each job costs credits. Create a key on console.higgsfield.ai, then paste it here (ID:SECRET). It stays encrypted on this PC and Mia never shows it again.',
    'set.hfLinked': 'Linked · key …{tail}',
    'set.hfOff': 'Not linked',
    'set.hfPlaceholder': 'ID:SECRET',
    'set.hfLink': 'Link',
    'set.hfCheck': 'Check',
    'set.hfUnlink': 'Unlink',
    'set.hfChecking': 'Checking with Higgsfield…',
    'set.hfOk': 'Account linked: online models are ready.',
    'set.hfStillOk': 'The key is still accepted.',
    'set.hfGone': 'Account unlinked: the key is erased from this PC.',
    'set.hfTopUp': 'Your last top-up',
    'set.hfTopUpHint': 'Higgsfield does not give the balance to Mia. Enter the amount of your last top-up, in dollars: Mia takes off what was spent since and shows what is left in the corner of the board.',
    'set.hfTopUpPh': 'e.g. 50',
    'set.hfTopUpSave': 'Keep',
    'set.hfTopUpClear': 'Forget',
    'set.hfTopUpNow': 'Top-up of {amount} on {date} · spent since: {spent} · left ≈ {left}',
    'set.hfTopUpWait': 'Top-up of {amount} on {date}.',
    'set.hfTopUpNone': 'No top-up entered: the corner of the board only shows this month’s spending.',
    'set.hfConsole': 'See my balance at Higgsfield',
    'set.bridgeOn': 'On · port {port}',
    'set.bridgeOnNoPort': 'On',
    'set.bridgeOff': 'Off',
    'set.bridgeChecking': 'Checking…',
    'set.bridgeLast': 'Last visit: {who}, {when}',
    'set.assist1': 'Tell Claude or Codex what you want to do (“animate this picture”, “make a depth pass of this clip”): you see them create the board, place and wire the blocks, set them and start the run, right here. Ctrl+Z undoes what they do.',
    'set.assist2': 'Then it finds Mia under the name “mia”, and opens it if it is closed. Everything stays on this PC.',
    'set.assistAdd': 'Add Mia to your assistant, once:',
    'set.assistAddMaybe': 'If your assistant does not know Mia yet, add it, once:',
    'set.assistHasOne': 'Mia is added to {who}: it finds Mia under the name “mia”, and opens it if it is closed. Everything stays on this PC.',
    'set.assistHasBoth': 'Mia is added to Claude and Codex: they find it under the name “mia”, and open it if it is closed. Everything stays on this PC.',
    'set.assistAlso': 'To add it to {who} too:',
    'set.assistClaude': 'Claude Code — in a terminal:',
    'set.assistCodex': 'Codex — at the end of config.toml, in the .codex folder of your home folder:',
    'set.copyCmd': 'Copy the command',
    'set.copyBlock': 'Copy the block',
    'set.copied': 'Command copied',
    'set.copiedBlock': 'Block copied',
    'set.tagline': 'A node board for local AI',
    'set.version': 'Version {v}',
    'set.versionDate': 'Version {v} · {date}',
    'set.data': 'App data:',
    'set.whatsNew': 'What’s new',
    'set.newsTitle': 'What’s new',
    'set.newsOf': 'Mia {v} · {date}',
    'set.newsToast': 'Mia {v} · What’s new',
    'set.newsSee': 'See',
    'set.newsOlder': 'Earlier versions',
    'set.newsLess': 'Hide earlier versions',
    'set.newsMissing': 'The release notes cannot be found in this copy of Mia.',
    'set.newsNoSection': 'Nothing noted for version {v}.',
    'set.newsFrOnly': 'These notes are only written in French.'
  }
});

// ── prefs & theme ─────────────────────────────────────────────────────
/**
 * Write a patch of prefs; keeps `state.prefs` in step and tells everyone.
 * Resolves to the full prefs, or null when the main process refused.
 */
export async function setPrefs(patch) {
  const before = state.prefs;
  state.prefs = { ...state.prefs, ...patch };   // optimistic: the UI moves at once
  try {
    const r = await window.mia.prefs.set(patch);
    if (r && typeof r === 'object' && r.ok === false) throw new Error(r.error || '?');
    if (r && typeof r === 'object' && !('ok' in r)) state.prefs = { ...state.prefs, ...r };
    emit('prefs:changed', { prefs: state.prefs, patch });
    return state.prefs;
  } catch (err) {
    console.error('[settings] prefs.set', err);
    state.prefs = before;
    toast(t('set.failed', { why: err?.message || '?' }), { kind: 'error' });
    return null;
  }
}

/** Instant, no reload: everything reads the tokens. */
export function applyTheme(theme) {
  const light = theme === 'light';
  document.body.classList.toggle('theme-dark', !light);
  document.body.classList.toggle('theme-light', light);
  emit('theme:changed', { theme: light ? 'light' : 'dark' });
}

// ── paths ─────────────────────────────────────────────────────────────
/** What a pasted path usually carries: quotes (Explorer's « Copier en tant que chemin »), spaces, a final slash. */
function cleanPath(raw) {
  let s = String(raw || '').trim().replace(/^["']+|["']+$/g, '').trim();
  s = s.replace(/\//g, '\\');
  if (/^[A-Za-z]:\\?$/.test(s)) return s.slice(0, 2) + '\\';
  return s.replace(/\\+$/, '');
}
const isAbsPath = (s) => /^[A-Za-z]:\\/.test(s) || /^\\\\[^\\]+\\[^\\]+/.test(s);
const norm = (s) => cleanPath(s).toLowerCase().replace(/\\?$/, '\\');
/** Is `a` the folder `b` or inside it? */
const inside = (a, b) => !!a && !!b && norm(a).startsWith(norm(b));

/** A folder dropped from Explorer, or null (and a word) when it is a file. */
function droppedFolder(e) {
  const dt = e.dataTransfer;
  if (!dt) return null;
  const item = [...(dt.items || [])].find((i) => i.kind === 'file');
  const entry = item?.webkitGetAsEntry?.();
  const file = dt.files?.[0];
  const p = file ? window.mia?.media?.pathFor?.(file) : '';
  if (!p) return null;
  if (entry && !entry.isDirectory) { toast(t('set.notFolder'), { kind: 'error' }); return null; }
  return p;
}

/** Let a settings row take a folder dropped from Explorer. */
function acceptFolderDrop(row, onFolder) {
  let depth = 0;
  const carrying = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  row.addEventListener('dragenter', (e) => { if (!carrying(e)) return; e.preventDefault(); e.stopPropagation(); depth++; row.classList.add('drop-on'); });
  row.addEventListener('dragover', (e) => { if (!carrying(e)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'link'; });
  row.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; row.classList.remove('drop-on'); } });
  row.addEventListener('drop', (e) => {
    if (!carrying(e)) return;
    e.preventDefault();
    e.stopPropagation();
    depth = 0;
    row.classList.remove('drop-on');
    const p = droppedFolder(e);
    if (p) onFolder(p);
  });
}

async function pickFolder() {
  try {
    const folder = await window.mia.media.pickFolder();
    return folder && typeof folder === 'string' ? folder : null;
  } catch (err) {
    console.error('[settings] pickFolder', err);
    toast(t('set.pickFailed'), { kind: 'error' });
    return null;
  }
}

const rescan = () => { try { window.mia?.models?.scan?.({ force: true })?.catch?.(() => {}); } catch { /* the next scan will see it */ } };

/** Where Mia lives, read from the page itself (index.html is loaded from the disk). */
function miaRoot() {
  try {
    const u = new URL('../../../', import.meta.url);
    if (u.protocol !== 'file:') return null;
    return decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\').replace(/\\$/, '');
  } catch { return null; }
}

/** A TOML string for a Windows path: literal ('C:\…', no escaping) unless it holds a quote. */
const tomlString = (s) => (/['\n]/.test(s) ? JSON.stringify(s) : `'${s}'`);

/** A small stylesheet of this module, added once (app.css belongs to the shell). */
function ensureCss(id, css) {
  if (document.getElementById(id)) return;
  document.head.append(el('style', { id }, css));
}
const ASSIST_CSS = `
.set-recipe[hidden] { display: none; }
.set-cmd-label { font-size: 12px; color: var(--txt-2); margin: 10px 0 5px; }
.set-cmd.wrap { margin-bottom: 4px; align-items: flex-start; padding-top: 6px; padding-bottom: 6px; }
.set-cmd.wrap code { white-space: pre-wrap; overflow-wrap: anywhere; text-overflow: clip; line-height: 1.55; padding-top: 1px; }
.set-assist-after { margin-top: 10px !important; }
.set-assist-after[hidden] { display: none; }
`;

// ── the gear ──────────────────────────────────────────────────────────
export function mountSettingsButton(host = $('#tb-actions')) {
  const b = el('button', { class: 'tb-chip', id: 'tb-settings', type: 'button', html: icon('gear', 16), 'aria-label': t('set.button') });
  tip(b, () => t('set.button'));
  b.addEventListener('click', () => openSettings());
  host?.append(b);
  return b;
}

// ── the dialog ────────────────────────────────────────────────────────
let current = null;

export function openSettings(opts = {}) {
  if (current) { if (opts.section === 'cloud') current.box?.querySelector?.('.set-cloud')?.scrollIntoView({ block: 'center' }); return current; }
  const p = state.prefs;
  const timers = [];

  const section = (key) => el('div', { class: 'set-sec kicker' }, t(key));
  const rowEl = (name, hint, ...ctl) => el('div', { class: 'set-row' },
    el('div', { class: 'set-label' },
      el('div', { class: 'set-name' }, name),
      hint ? (hint.nodeType ? hint : el('div', { class: 'set-hint' }, hint)) : null
    ),
    el('div', { class: 'set-ctl' }, ...ctl)
  );

  // language: the window is rebuilt, after the board is saved
  const langCtl = segmented({
    options: [{ value: 'fr', label: 'FR' }, { value: 'en', label: 'EN' }],
    value: lang(),
    onChange: (v) => { setLang(v); }
  });

  const themeCtl = segmented({
    options: [{ value: 'dark', label: t('set.dark'), icon: 'moon' }, { value: 'light', label: t('set.light'), icon: 'sun' }],
    value: p.theme === 'light' ? 'light' : 'dark',
    onChange: (v) => { applyTheme(v); setPrefs({ theme: v }); }
  });

  const wiresCtl = segmented({
    // 'sober' | 'typed' (coloured by data type) — the values the board reads
    options: [{ value: 'sober', label: t('set.wiresSober') }, { value: 'typed', label: t('set.wiresColor') }],
    value: p.wires === 'typed' ? 'typed' : 'sober',
    onChange: (v) => setPrefs({ wires: v })
  });
  const snapCtl = toggle({ value: !!p.snap, label: t('set.snap'), onChange: (v) => setPrefs({ snap: v }) });
  const miniCtl = toggle({ value: !!p.minimap, label: t('set.minimap'), onChange: (v) => setPrefs({ minimap: v }) });

  const pathLine = (value) => {
    const n = el('div', { class: 'set-path' }, el('bdi', {}, value || t('set.notSet')));
    tip(n, () => n.textContent);
    return n;
  };
  const openFolder = (abs) => { if (abs) shellDo(window.mia.shell.openPath, { abs }); };

  // ── one folder (projects, engine): a Mia field, a drop target, « Parcourir… » as a fallback ──
  const currentOf = (key) => state.prefs[key] || state.info?.[key] || '';
  function folderRow(key, name, hint) {
    const field = textField({
      value: currentOf(key), size: 'sm', mono: true, placeholder: t('set.notSet'),
      onChange: (v) => applyFolder(key, v, field)
    });
    field.spellcheck = false;
    // Au repos, la fin du chemin (la partie qui parle) est visible, « … » à gauche (CSS), le chemin entier
    // en info-bulle ; au focus, le champ s'édite normalement.
    field.classList.add('set-dir');
    const showEnd = () => { if (document.activeElement !== field) field.scrollLeft = field.scrollWidth; };
    field.addEventListener('blur', () => requestAnimationFrame(showEnd));
    new ResizeObserver(showEnd).observe(field);
    tip(field, () => (document.activeElement !== field && field.scrollWidth > field.clientWidth + 1 ? field.value : ''));
    const row = el('div', { class: 'set-row folder' },
      el('div', { class: 'set-label' },
        el('div', { class: 'set-name' }, name),
        hint ? el('div', { class: 'set-hint' }, hint) : null
      ),
      el('div', { class: 'set-ctl' },
        field,
        button({ label: t('set.browse'), size: 'sm', onClick: async () => { const f = await pickFolder(); if (f) applyFolder(key, f, field); } }),
        button({ icon: 'folder', size: 'sm', kind: 'ghost', tip: t('set.openTip'), onClick: () => openFolder(currentOf(key)) })
      )
    );
    acceptFolderDrop(row, (f) => applyFolder(key, f, field));
    row.field = field;
    return row;
  }

  async function applyFolder(key, raw, field) {
    const was = currentOf(key);
    const v = cleanPath(raw);
    const back = () => field.setValue(was);
    if (!v) return back();
    if (!isAbsPath(v)) { toast(t('set.badPath'), { kind: 'error' }); return back(); }
    if (norm(v) === norm(was)) { field.setValue(was); return; }
    // the projects can never live in the lab, nor the lab in the projects (SPEC §10)
    const proj = key === 'projectsRoot' ? v : currentOf('projectsRoot');
    const eng = key === 'engineRoot' ? v : currentOf('engineRoot');
    if (inside(proj, eng) || inside(eng, proj)) { toast(t('set.rootInEngine'), { kind: 'error' }); return back(); }
    const r = await setPrefs({ [key]: v });
    if (!r) return back();
    field.setValue(r[key] || v);
    toast(t('set.folderChanged'), { kind: 'ok' });
    if (key === 'engineRoot') rescan();
  }

  // ── a list of folders (LoRA, extra models) ──
  function folderList(key, name, hint, { rescanAfter = false } = {}) {
    const list = el('div', { class: 'set-list' });
    const items = () => (Array.isArray(state.prefs[key]) ? state.prefs[key] : []);
    function paint() {
      list.innerHTML = '';
      for (const f of items()) {
        const rm = button({ icon: 'close', size: 'xs', kind: 'ghost', tip: t('set.removeFolder'), onClick: () => remove(f) });
        list.append(el('div', { class: 'set-item' },
          pathLine(f),
          button({ icon: 'folder', size: 'xs', kind: 'ghost', tip: t('set.openTip'), onClick: () => openFolder(f) }),
          rm
        ));
      }
    }
    async function add(raw) {
      const f = cleanPath(raw);
      if (!f) return;
      if (!isAbsPath(f)) { toast(t('set.badPath'), { kind: 'error' }); return; }
      if (items().some((x) => norm(x) === norm(f))) { toast(t('set.folderKnown')); return; }
      if (!await setPrefs({ [key]: [...items(), f] })) return;
      paint();
      toast(t('set.folderAdded'), { kind: 'ok' });
      if (rescanAfter) rescan();
    }
    async function remove(f) {
      if (!await setPrefs({ [key]: items().filter((x) => x !== f) })) return;
      paint();
      toast(t('set.folderRemovedKept'));
      if (rescanAfter) rescan();
    }
    const row = rowEl(name, hint,
      button({ label: t('set.addFolder'), icon: 'plus', size: 'sm', onClick: async () => { const f = await pickFolder(); if (f) add(f); } }));
    row.classList.add('has-list');
    acceptFolderDrop(row, add);
    acceptFolderDrop(list, add);
    paint();
    return [row, list];
  }

  const projectsRow = folderRow('projectsRoot', t('set.projects'), t('set.projectsHint'));
  const engineRow = folderRow('engineRoot', t('set.engine'), t('set.engineHint'));
  // the scanner rescans on its own when extraModelRoots changes; LoRA folders are asked for
  const [loraRow, loraList] = folderList('loraFolders', t('set.loras'), t('set.lorasHint'), { rescanAfter: true });
  const [modelsRow, modelsList] = folderList('extraModelRoots', t('set.models'), t('set.modelsHint'));

  // the engine address: local only, checked before it is kept
  const comfyCtl = textField({
    value: p.comfyUrl || 'http://127.0.0.1:8188', size: 'sm', mono: true,
    onChange: async (v) => {
      const url = v.trim().replace(/\/+$/, '');
      if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i.test(url)) {
        toast(t('set.badUrl'), { kind: 'error' });
        comfyCtl.setValue(state.prefs.comfyUrl || 'http://127.0.0.1:8188');
        return;
      }
      comfyCtl.setValue(url);
      if (url !== state.prefs.comfyUrl && await setPrefs({ comfyUrl: url })) toast(t('set.saved'), { kind: 'ok' });
    }
  });
  comfyCtl.style.width = '210px';

  // ── assistants: is the bridge up, and how to add Mia to Claude or Codex ──
  // The server (mcp/mia-mcp.js) runs on Mia's own executable as plain Node (ELECTRON_RUN_AS_NODE=1, as comfy.js
  // does): nothing else to install. Packaged, that is Mia.exe two folders above resources\app; from the sources,
  // the Electron of node_modules.
  const root = miaRoot();
  const launcher = !root ? null : /\\resources\\app$/i.test(root)
    ? root.replace(/\\resources\\app$/i, '') + '\\Mia.exe'
    : root + '\\node_modules\\electron\\dist\\electron.exe';
  const server = root ? root + '\\mcp\\mia-mcp.js' : null;
  const claudeCmd = launcher ? `claude mcp add mia --scope user -e ELECTRON_RUN_AS_NODE=1 -- "${launcher}" "${server}"` : null;
  const codexBlock = launcher ? [
    '[mcp_servers.mia]',
    `command = ${tomlString(launcher)}`,
    `args = [${tomlString(server)}]`,
    "env = { ELECTRON_RUN_AS_NODE = '1' }",
    'startup_timeout_sec = 40',
    'tool_timeout_sec = 660'
  ].join('\n') : null;
  ensureCss('mia-settings-assist-css', ASSIST_CSS);

  const copy = async (text, done) => {
    try { await navigator.clipboard.writeText(text); toast(t(done), { kind: 'ok' }); } catch (err) {
      console.error('[settings] clipboard', err);
      toast(t('set.failed', { why: err?.message || '?' }), { kind: 'error' });
    }
  };
  const recipe = (label, text, tipKey, doneKey, multi) => {
    if (!text) return null;
    const lab = el('div', { class: 'set-cmd-label' }, label);
    const box = el('div', { class: 'set-cmd wrap' + (multi ? ' block' : '') },
      el('code', {}, text),
      button({ icon: 'copy', size: 'xs', kind: 'ghost', tip: t(tipKey), onClick: () => copy(text, doneKey) }));
    return el('div', { class: 'set-recipe' }, lab, box);
  };
  const claudeRecipe = recipe(t('set.assistClaude'), claudeCmd, 'set.copyCmd', 'set.copied', false);
  const codexRecipe = recipe(t('set.assistCodex'), codexBlock, 'set.copyBlock', 'set.copiedBlock', true);
  const assistLead = el('p', {});
  const assistAfter = el('p', { class: 'set-assist-after' }, t('set.assist2'));
  const assist = el('div', { class: 'set-text' },
    el('p', {}, t('set.assist1')),
    assistLead,
    claudeRecipe, codexRecipe,
    assistAfter
  );
  /**
   * Who already has Mia: `registered: {claude, codex}` from bridge:status when the main process reads
   * ~/.claude.json and ~/.codex/config.toml (electron/assistants.js) ; without it, Mia does not know and says so.
   */
  let assistKey = '';
  function paintAssist(reg) {
    const known = !!(reg && typeof reg === 'object');
    const has = { claude: known && reg.claude === true, codex: known && reg.codex === true };
    const key = known ? `${has.claude}|${has.codex}` : '?';
    if (key === assistKey) return;
    assistKey = key;
    const names = { claude: 'Claude', codex: 'Codex' };
    if (claudeRecipe) claudeRecipe.hidden = has.claude;
    if (codexRecipe) codexRecipe.hidden = has.codex;
    assistAfter.hidden = !launcher || has.claude || has.codex;
    if (has.claude && has.codex) assistLead.textContent = t('set.assistHasBoth');
    else if (has.claude || has.codex) {
      const mine = has.claude ? 'claude' : 'codex';
      const other = has.claude ? 'codex' : 'claude';
      assistLead.textContent = t('set.assistHasOne', { who: names[mine] }) + (launcher ? ' ' + t('set.assistAlso', { who: names[other] }) : '');
    } else {
      assistLead.textContent = launcher ? t(known ? 'set.assistAdd' : 'set.assistAddMaybe') : t('set.assist2');
    }
  }
  paintAssist(null);

  // ── online accounts (SPEC §23.3): the key goes in once, encrypted by the main process, never shown again ──
  const hfState = el('span', { class: 'set-state' }, '…');
  const hfMsg = el('div', { class: 'set-hint set-hf-msg', hidden: true });
  const hfField = textField({ value: '', placeholder: t('set.hfPlaceholder'), mono: true });
  hfField.type = 'password';
  hfField.autocomplete = 'off';
  const hfLink = button({ label: t('set.hfLink'), size: 'sm', onClick: () => linkHf() });
  const hfCheck = button({ label: t('set.hfCheck'), size: 'sm', onClick: () => checkHf() });
  const hfUnlink = button({ label: t('set.hfUnlink'), size: 'sm', kind: 'ghost', onClick: () => unlinkHf() });
  const hfForm = el('div', { class: 'set-hf-form' }, hfField, hfLink);
  const hfLinkedCtl = el('div', { class: 'set-hf-form' }, hfCheck, hfUnlink);
  const say = (text, bad = false) => { hfMsg.hidden = !text; hfMsg.textContent = text || ''; hfMsg.classList.toggle('bad', !!bad); };
  function paintHf(s) {
    const linked = !!(s && s.linked);
    hfState.classList.toggle('on', linked);
    hfState.textContent = linked ? t('set.hfLinked', { tail: s.keyTail || '' }) : t('set.hfOff');
    hfForm.hidden = linked;
    hfLinkedCtl.hidden = !linked;
    // (always called after the whole section is built: the status comes back from the main process)
    topRow.hidden = !linked;
    if (linked) paintTopUp();
  }
  async function refreshHf() {
    let s = null;
    try { s = await window.mia?.cloud?.status?.(); } catch { s = null; }
    paintHf(s);
  }
  async function linkHf() {
    const key = hfField.value.trim();
    if (!key) { hfField.focus(); return; }
    say(t('set.hfChecking'));
    let r = null;
    try { r = await window.mia?.cloud?.setKey?.(key); } catch (e) { r = { ok: false, error: e?.message || '?' }; }
    if (r && r.ok) {
      hfField.setValue('');
      say(t('set.hfOk'));
      paintHf(r.status);
      emit('cloud:changed', r.status);
    } else say(r?.error || '?', true);
  }
  async function checkHf() {
    say(t('set.hfChecking'));
    let r = null;
    try { r = await window.mia?.cloud?.check?.(); } catch (e) { r = { ok: false, error: e?.message || '?' }; }
    say(r && r.ok ? t('set.hfStillOk') : (r?.error || '?'), !(r && r.ok));
  }
  async function unlinkHf() {
    let r = null;
    try { r = await window.mia?.cloud?.removeKey?.(); } catch { r = null; }
    say(t('set.hfGone'));
    paintHf(r?.status || null);
    emit('cloud:changed', r?.status || null);
  }
  hfField.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); linkHf(); } });
  refreshHf();

  // last top-up: Higgsfield gives no balance to a key; Mia takes what was spent since off this amount, and the corner
  // of the board shows it (ui/budget.js)
  const topField = textField({ value: '', placeholder: t('set.hfTopUpPh') });
  topField.inputMode = 'decimal';
  const topSave = button({ label: t('set.hfTopUpSave'), size: 'sm', onClick: () => keepTopUp(topField.value) });
  const topClear = button({ label: t('set.hfTopUpClear'), size: 'sm', kind: 'ghost', onClick: () => keepTopUp(null) });
  const topConsole = button({ label: t('set.hfConsole'), size: 'sm', kind: 'ghost', onClick: () => window.open('https://console.higgsfield.ai', '_blank') });
  const topNow = el('div', { class: 'set-hint' });
  const topMsg = el('div', { class: 'set-hint set-hf-msg bad', hidden: true });
  async function paintTopUp(fresh = false) {
    let b = null;
    try { b = await window.mia?.cloud?.budget?.({ fresh }); } catch { b = null; }
    const v = b && (b.month != null ? b : b.last);
    const top = b && b.topUp;
    topClear.hidden = !top;
    if (!top) topNow.textContent = t('set.hfTopUpNone');
    else if (v && v.left != null) {
      topNow.textContent = t('set.hfTopUpNow', { amount: money(top.amount, v.currency), date: shortDate(top.at),
        spent: money(v.sinceTopUp, v.currency), left: money(v.left, v.currency) });
    } else topNow.textContent = t('set.hfTopUpWait', { amount: money(top.amount), date: shortDate(top.at) });
  }
  async function keepTopUp(value) {
    if (value != null && !String(value).trim()) { topField.focus(); return; }
    let r = null;
    try { r = await window.mia?.cloud?.setTopUp?.(value == null ? null : { amount: String(value).trim() }); } catch (e) { r = { ok: false, error: e?.message || '?' }; }
    topMsg.hidden = !!(r && r.ok);
    topMsg.textContent = r && r.ok ? '' : (r?.error || '?');
    if (r && r.ok) { topField.setValue(''); emit('cloud:topup'); paintTopUp(true); }
  }
  topField.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); keepTopUp(topField.value); } });
  const topBox = el('div', { class: 'set-hf' },
    el('div', { class: 'set-hf-form' }, topField, topSave, topClear), topNow, topMsg, el('div', { class: 'set-hf-form' }, topConsole));
  const topRow = el('div', { class: 'set-hf-top', hidden: true }, rowEl(t('set.hfTopUp'), t('set.hfTopUpHint')), topBox);

  const hfRow = el('div', { class: 'set-cloud' },
    rowEl(t('set.hf'), t('set.hfHint'), hfState),
    el('div', { class: 'set-hf' }, hfForm, hfLinkedCtl, hfMsg),
    topRow);

  const bridgeState = el('span', { class: 'set-state' }, t('set.bridgeChecking'));
  const bridgeHint = el('div', { class: 'set-hint' });
  async function pollBridge() {
    let s = null;
    try { s = await window.mia?.bridge?.status?.(); } catch { s = null; }
    const on = !!(s && typeof s === 'object' && s.ok !== false && (s.active ?? s.running ?? s.listening ?? !!s.port));
    bridgeState.classList.toggle('on', on);
    bridgeState.textContent = on ? (s.port ? t('set.bridgeOn', { port: s.port }) : t('set.bridgeOnNoPort')) : t('set.bridgeOff');
    const last = s && (s.lastClient || s.client);
    const who = typeof last === 'string' ? last : last?.name;
    const when = s && (s.lastCall || last?.at);
    bridgeHint.textContent = on && who ? t('set.bridgeLast', { who, when: when ? new Date(when).toLocaleTimeString(lang() === 'en' ? 'en-GB' : 'fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—' }) : '';
    bridgeHint.hidden = !bridgeHint.textContent;
    paintAssist(s && typeof s === 'object' ? (s.registered || s.assistants || null) : null);
  }
  pollBridge();
  timers.push(setInterval(pollBridge, 4000));

  // ── about: version and its date (CHANGELOG.md, SPEC §21.1), « Nouveautés » ──
  const versionLine = el('span', { class: 'set-about-meta' });
  const paintVersion = (info, date) => {
    const v = info?.version;
    versionLine.textContent = v ? '  ·  ' + (date ? t('set.versionDate', { v, date: fmtDate(date) }) : t('set.version', { v })) : '';
  };
  paintVersion(state.info, state.info?.date);
  const dataDir = state.info?.dataDir || '';
  const about = el('div', { class: 'set-about' },
    el('div', { class: 'set-about-mark', html: logo(30, { tight: false }) }),
    el('div', { style: 'min-width:0;flex:1 1 auto' },
      el('div', { class: 'set-about-name' }, t('app.name'), versionLine),
      el('div', { class: 'set-about-meta' }, t('set.tagline')),
      // the label on its own line: only the path may be cut, from the left
      dataDir ? el('div', { class: 'set-about-data' }, el('div', { class: 'set-about-meta' }, t('set.data')), pathLine(dataDir)) : null
    ),
    el('div', { style: 'flex:0 0 auto;align-self:flex-start' },
      button({ label: t('set.whatsNew'), size: 'sm', onClick: () => openNews() }))
  );
  // the date comes from the changelog (or from the main process when it knows it)
  versionInfo().then(({ info, date }) => paintVersion(info, date)).catch(() => {});

  const closeBtn = el('button', { class: 'set-close', type: 'button', html: icon('close', 14), 'aria-label': t('set.close') });
  tip(closeBtn, () => t('set.close'), { key: t('app.key.esc') });

  const content = el('div', { class: 'settings-inner', style: 'display:contents' },
    el('div', { class: 'set-head' }, el('h2', {}, t('set.title')), closeBtn),
    el('div', { class: 'set-body' },
      section('set.secLook'),
      rowEl(t('set.lang'), t('set.langHint'), langCtl),
      rowEl(t('set.theme'), null, themeCtl),

      section('set.secBoard'),
      rowEl(t('set.wires'), t('set.wiresHint'), wiresCtl),
      rowEl(t('set.snap'), t('set.snapHint'), snapCtl),
      rowEl(t('set.minimap'), t('set.minimapHint'), miniCtl),

      section('set.secFolders'),
      projectsRow,
      loraRow, loraList,
      modelsRow, modelsList,

      section('set.secEngine'),
      engineRow,
      rowEl(t('set.comfy'), t('set.comfyHint'), comfyCtl),

      section('set.secCloud'),
      hfRow,

      section('set.secAssist'),
      rowEl(t('set.bridge'), bridgeHint, bridgeState),
      assist,

      section('set.secAbout'),
      about
    )
  );

  // the dialog itself takes the focus: nothing lit, Esc closes, Tab starts at the top
  const handle = openModal(content, {
    className: 'settings', focus: 'box',
    onClose: () => { current = null; timers.forEach(clearInterval); $('#tb-settings')?.classList.remove('on'); }
  });
  closeBtn.addEventListener('click', () => handle.close());
  $('#tb-settings')?.classList.add('on');
  current = handle;
  // ouvert depuis le choix d'un modèle en ligne : droit sur le compte Higgsfield
  if (opts.section === 'cloud') requestAnimationFrame(() => { hfRow.scrollIntoView({ block: 'center' }); hfField.focus(); });

  // the app info arrives once; fill in what was missing when it does
  if (!state.info) {
    Promise.resolve(window.mia?.app?.info?.()).then((info) => {
      if (!info) return;
      state.info = info;
      if (!state.prefs.projectsRoot && info.projectsRoot) projectsRow.field.setValue(info.projectsRoot);
      if (!state.prefs.engineRoot && info.engineRoot) engineRow.field.setValue(info.engineRoot);
    }).catch(() => {});
  }
  return handle;
}

// ── versions & « Nouveautés » (SPEC §21.1) ───────────────────────────
// The notes are CHANGELOG.md at Mia's root (French), read from the disk like the catalogue: index.html is
// loaded from a file, and XMLHttpRequest reads a file beside it where fetch() may refuse the scheme.
// Its sections start with « ## 0.5.0 — 17/10/2026 » (electron/version.js parses the same headings).

const HEADING = /^##\s+\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?\s*(?:[—–-]\s*(\d{1,2})\/(\d{1,2})\/(\d{4})|[—–-]\s*(\d{4})-(\d{2})-(\d{2}))?/;

/** [{ version, date (ISO|null), body }] in the order of the file (newest first). */
export function parseChangelog(md) {
  const out = [];
  let cur = null;
  for (const line of String(md || '').split(/\r?\n/)) {
    const m = HEADING.exec(line);
    if (m) {
      const date = m[4] ? `${m[4]}-${m[3].padStart(2, '0')}-${m[2].padStart(2, '0')}` : m[5] ? `${m[5]}-${m[6]}-${m[7]}` : null;
      cur = { version: m[1], date, lines: [] };
      out.push(cur);
    } else if (cur) cur.lines.push(line);
  }
  return out.map((s) => ({ version: s.version, date: s.date, body: s.lines.join('\n').trim() }));
}

/** SemVer order of « x.y.z » (a pre-release before its release): -1, 0, 1. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(v || '').trim());
    return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] || null } : { n: [0, 0, 0], pre: null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** « 0.5.0 » → « 0.5 » (the toast), « 0.5.1 » stays. */
const shortVersion = (v) => String(v || '').replace(/^(\d+\.\d+)\.0$/, '$1');

/** ISO « 2026-10-17 » → « 17 octobre 2026 » / « 17 October 2026 ». */
function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  try {
    return new Date(+m[1], +m[2] - 1, +m[3], 12).toLocaleDateString(lang() === 'en' ? 'en-GB' : 'fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch { return `${m[3]}/${m[2]}/${m[1]}`; }
}

let changelog = null;   // Promise<[sections]> — read once per window
function loadChangelog() {
  if (changelog) return changelog;
  changelog = new Promise((resolve) => {
    let url;
    try { url = new URL('../../../CHANGELOG.md', import.meta.url).href; } catch { resolve([]); return; }
    const x = new XMLHttpRequest();
    x.open('GET', url);
    x.onload = () => resolve(x.status === 0 || x.status === 200 ? parseChangelog(x.responseText) : []);
    x.onerror = () => resolve([]);
    try { x.send(); } catch { resolve([]); }
  }).then((list) => {
    if (!list.length) changelog = null;   // missing: try again next time (a copy being repaired)
    return list;
  });
  return changelog;
}

/** The app's version (main process) and its date (the main process if it says, else the changelog). */
async function versionInfo() {
  let info = state.info;
  if (!info?.version) {
    try { info = await window.mia?.app?.info?.(); } catch { info = null; }
    if (info && typeof info === 'object') state.info = info;
  }
  const sections = await loadChangelog();
  const own = sections.find((s) => s.version === info?.version);
  return { info, date: info?.date || own?.date || null, sections };
}

/** A line of markdown → nodes: **gras**, `code`, [texte](lien) shown as its text. Never innerHTML. */
function inline(text) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\([^)]*\)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(el('strong', {}, m[1]));
    else if (m[2] !== undefined) out.push(el('code', {}, m[2]));
    else out.push(m[3]);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// What « Nouveautés » shows of a version: its short summary for the user, in the window's language —
// « ### En bref » (French) or « ### In short » (English) in CHANGELOG.md. The detail that follows (Ajouté,
// Changé, Corrigé) is for the GitHub page, and « ### Pour les développeurs » never reaches the window.
const SUMMARY = { fr: /^en bref$/i, en: /^in short$/i };
const FOR_DEVS = /^(pour les d[ée]veloppeurs|for developers)\b/i;
const HEAD_EN = { 'ajouté': 'Added', 'changé': 'Changed', 'corrigé': 'Fixed', 'retiré': 'Removed', 'sécurité': 'Security' };

/** A version's body cut at its « ### » headings: [{ title|null, body }]. */
function subsections(body) {
  const out = [{ title: null, lines: [] }];
  for (const line of String(body || '').split(/\r?\n/)) {
    const h = /^###\s+(.*?)\s*$/.exec(line);
    if (h) out.push({ title: h[1], lines: [] });
    else out[out.length - 1].lines.push(line);
  }
  return out.map((x) => ({ title: x.title, body: x.lines.join('\n').trim() })).filter((x) => x.title || x.body);
}

/**
 * The notes of one version for this window: { body (markdown), frOnly }. Its summary in the window's language
 * when it has one; else (an older layout) its detail without the developers' part, headings translated.
 */
export function userNotes(body, language = lang()) {
  const en = language === 'en';
  const subs = subsections(body);
  const own = subs.find((x) => x.title && SUMMARY[en ? 'en' : 'fr'].test(x.title));
  if (own) return { body: own.body, frOnly: false };
  const rest = subs.filter((x) => !(x.title && (FOR_DEVS.test(x.title) || SUMMARY.fr.test(x.title) || SUMMARY.en.test(x.title))));
  const md = rest.map((x) => {
    if (!x.title) return x.body;
    const title = en ? (HEAD_EN[x.title.toLowerCase()] || x.title) : x.title;
    return `### ${title}\n${x.body}`;
  }).join('\n\n');
  return { body: md, frOnly: en && !!md.trim() };
}

/** The body of one section → « Ajouté / Changé / Corrigé » headings, lists and paragraphs. */
function renderNotes(body) {
  const box = el('div', { class: 'news-notes' });
  let list = null;
  let item = null;
  let para = null;
  const flush = () => { list = null; item = null; para = null; };
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { flush(); continue; }
    const h = /^#{3,6}\s+(.*)$/.exec(line);
    if (h) { flush(); box.append(el('div', { class: 'set-sec kicker news-sec' }, h[1])); continue; }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (!list) { list = el('ul', { class: 'news-list' }); box.append(list); }
      item = el('li', {}, ...inline(li[1]));
      list.append(item);
      para = null;
      continue;
    }
    if (item && /^\s+/.test(line)) { item.append(' ', ...inline(line.trim())); continue; }
    if (para) { para.append(' ', ...inline(line.trim())); continue; }
    list = null;
    item = null;
    para = el('p', { class: 'news-p' }, ...inline(line.trim()));
    box.append(para);
  }
  return box;
}

const NEWS_CSS = `
.news { width: min(600px, 94vw); max-height: min(760px, 88vh); }
.news .set-body { padding-bottom: 8px; }
.news-sub { font-family: var(--font-mono); font-size: var(--fs-meta); color: var(--txt-3); margin-top: 3px; }
.news-note { font-size: var(--fs-meta); color: var(--txt-3); margin: 6px 0 0; }
.news-notes .news-sec:first-child { margin-top: 6px; }
.news-list { margin: 9px 0 2px; padding: 0 0 0 17px; }
.news-list li { font-size: var(--fs-ui); line-height: 1.55; color: var(--txt-2); margin: 0 0 7px; padding-left: 2px; }
.news-list li::marker { color: var(--txt-3); }
.news-list strong, .news-p strong { color: var(--txt); font-weight: 600; }
.news-list code, .news-p code {
  font-family: var(--font-mono); font-size: var(--fs-meta); color: var(--txt);
  background: var(--surface-3); border: 1px solid var(--line); border-radius: var(--r-chip); padding: 0 4px;
}
.news-p { font-size: var(--fs-ui); line-height: 1.55; color: var(--txt-2); margin: 8px 0 0; }
.news-version { display: flex; align-items: baseline; gap: 10px; margin: 28px 0 0; padding-top: 18px; border-top: 1px solid var(--line); }
.news-version h3 { margin: 0; font-size: var(--fs-body); font-weight: 600; color: var(--txt); }
.news-version span { font-family: var(--font-mono); font-size: var(--fs-meta); color: var(--txt-3); }
.news-older[hidden] { display: none; }
.news-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 22px 16px; border-top: 1px solid var(--line); }
`;
function ensureNewsCss() {
  if (document.getElementById('mia-news-css')) return;
  document.head.append(el('style', { id: 'mia-news-css' }, NEWS_CSS));
}

let newsOpen = null;

/** The « Nouveautés » dialog: the section of `version` (default: this Mia), then the earlier ones on demand. */
export async function openNews(version) {
  if (newsOpen) return newsOpen;
  ensureNewsCss();
  const { info, sections } = await versionInfo();
  const v = version || info?.version || sections[0]?.version || '';
  const idx = sections.findIndex((s) => s.version === v);
  const cur = idx >= 0 ? sections[idx] : null;
  const older = idx >= 0 ? sections.slice(idx + 1) : sections;
  const curNotes = cur ? userNotes(cur.body) : null;

  const closeBtn = el('button', { class: 'set-close', type: 'button', html: icon('close', 14), 'aria-label': t('set.close') });
  tip(closeBtn, () => t('set.close'), { key: t('app.key.esc') });
  const head = el('div', { class: 'set-head' },
    el('div', { style: 'min-width:0' },
      el('h2', {}, t('set.newsTitle')),
      v ? el('div', { class: 'news-sub' }, cur?.date ? t('set.newsOf', { v, date: fmtDate(cur.date) }) : `Mia ${v}`) : null,
      curNotes?.frOnly && t('set.newsFrOnly') ? el('div', { class: 'news-note' }, t('set.newsFrOnly')) : null
    ),
    closeBtn
  );

  const body = el('div', { class: 'set-body' });
  if (!sections.length) body.append(el('p', { class: 'news-p' }, t('set.newsMissing')));
  else if (cur) body.append(renderNotes(curNotes.body));
  else body.append(el('p', { class: 'news-p' }, t('set.newsNoSection', { v })));

  const olderBox = el('div', { class: 'news-older', hidden: true });
  for (const s of older) {
    olderBox.append(
      el('div', { class: 'news-version' }, el('h3', {}, `Mia ${s.version}`), s.date ? el('span', {}, fmtDate(s.date)) : null),
      renderNotes(userNotes(s.body).body)
    );
  }
  body.append(olderBox);

  let shown = false;
  const toggle = button({
    label: t('set.newsOlder'), size: 'sm', kind: 'ghost',
    onClick: () => {
      shown = !shown;
      olderBox.hidden = !shown;
      toggle.setValue(t(shown ? 'set.newsLess' : 'set.newsOlder'));
      if (shown) olderBox.firstChild?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  });
  const okBtn = button({ label: t('set.close'), size: 'sm', kind: 'primary', onClick: () => handle.close() });
  const foot = el('div', { class: 'news-foot' }, older.length ? toggle : el('span'), okBtn);

  const content = el('div', { style: 'display:contents' }, head, body, foot);
  const handle = openModal(content, { className: 'settings news', focus: 'box', onClose: () => { newsOpen = null; } });
  closeBtn.addEventListener('click', () => handle.close());
  newsOpen = handle;
  return handle;
}

/**
 * First start of a new version: a quiet toast « Mia 0.5 · Nouveautés » that opens the notes, and
 * `app:updated {from, to}` on the bus. prefs.lastSeenVersion remembers the version announced; a fresh
 * install (no lastSeenVersion: the welcome greets) or an older version than the one seen stays silent.
 * Prefs from Mia ≤ 0.4 get lastSeenVersion « 0.4.0 » from the migrations (electron/migrations.js).
 */
async function announceNewVersion() {
  const { info } = await versionInfo();
  const v = info?.version;
  if (!v) return;
  const seen = typeof state.prefs?.lastSeenVersion === 'string' ? state.prefs.lastSeenVersion : null;
  if (seen === v) return;
  // remembered first: the toast is said once, even if it is not clicked (the notes stay in Réglages → À propos)
  if (!await setPrefs({ lastSeenVersion: v })) return;
  if (!seen || compareVersions(seen, v) >= 0) return;
  emit('app:updated', { from: seen, to: v });
  toast(t('set.newsToast', { v: shortVersion(v) }), {
    icon: 'info', ms: 9000,
    action: { label: t('set.newsSee'), run: () => { openNews(v); } }
  });
}

// once the window is ready (the board or the home is on screen), not in the middle of the start
on('app:ready', () => { setTimeout(() => { announceNewVersion().catch((err) => console.error('[settings] news', err)); }, 1200); });
// le choix d'un modèle en ligne sans compte relié ouvre les Réglages sur « Comptes en ligne » (SPEC §23.3)
on('settings:open', (p) => openSettings(p || {}));

export default { mountSettingsButton, openSettings, setPrefs, applyTheme, openNews };
