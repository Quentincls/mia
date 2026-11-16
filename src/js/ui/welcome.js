/**
 * Assistant de premier lancement (SPEC §21.3) — « Bienvenue dans Mia », trois pages, une à la fois :
 *   1. Moteur   : « J'ai déjà le moteur de Mia » (son dossier : le coller ou le choisir) · « Installer le moteur de
 *                 Mia » (le script engine-setup\install-engine.ps1 : ses étapes lisibles, une barre, le temps écoulé,
 *                 le journal brut replié sous « Détails ») · « Plus tard ».
 *   2. Modèles  : les usages à installer, avec leur taille, cochés ou non ; la place libre ; la licence Hugging Face
 *                 et le champ du jeton quand un modèle choisi en demande une. Les téléchargements partent dans la
 *                 file du principal ; un modèle à licence sans jeton n'y part pas (le principal le met de côté).
 *   3. C'est prêt — ou « Presque prêt » quand il manque encore quelque chose (moteur, modèle, licence).
 *
 *   maybeWelcome()        au démarrage (monté par library.js) : s'ouvre seulement si aucun moteur n'est utilisable
 *                         (prefs.engineRoot, le labo, le ComfyUI du moteur qui répond). Un ComfyUI d'une autre appli
 *                         ne compte pas : l'assistant s'ouvre et le dit. Un autre moteur trouvé est adopté sans
 *                         rien demander.
 *   openWelcome({step})   depuis la bibliothèque (« Configurer le moteur… », un bouton Installer sans moteur).
 *                         Une installation du moteur en cours (lancée avant « Plus tard ») est reprise à l'écran.
 *
 * Sobre (da.md) : une page pleine sous la barre de titre, noir, gris, blanc ; l'accent seulement sur la barre de
 * 2 px pendant l'installation et sur l'action primaire. Rien de Windows (le sélecteur de dossier en secours d'un
 * champ où coller un chemin). Sa feuille de style est ajoutée ici, au premier usage (index.html n'est pas touché).
 */
import { t, tl, register, locale } from '../i18n.js';
import { state } from '../state.js';
import { icon, logo } from '../icons.js';
import { el, debounce } from '../util.js';
import { button, textField, toggle } from './controls.js';
import { toast } from './toasts.js';
import { gbText, openLibrary, tokenNote, saveHfToken } from './library.js';
import { ms } from './motion.js';

register({
  fr: {
    'wel.step.engine': 'Moteur',
    'wel.step.models': 'Modèles',
    'wel.step.ready': 'C’est prêt',
    'wel.step.skipped': 'passé',
    'wel.dialog': 'Bienvenue dans Mia',
    'wel.title': 'Bienvenue dans Mia',
    'wel.lead': 'Pour calculer, Mia a besoin d’un moteur sur ce PC : ComfyUI et quelques outils. Mia n’en a pas trouvé.',
    'wel.foreign': 'Un ComfyUI tourne déjà sur ce PC (port {port}) : ce n’est pas le moteur de Mia. Mia installe le sien à côté, sur un autre port, sans toucher à celui-là.',
    'wel.have.title': 'J’ai déjà le moteur de Mia',
    'wel.have.desc': 'Le dossier d’un moteur de Mia déjà installé (il contient env\\venv et env\\ComfyUI).',
    'wel.have.ph': 'Dossier du moteur, par exemple D:\\Mia-moteur',
    'wel.have.pick': 'Choisir…',
    'wel.have.checking': 'Lecture du dossier…',
    'wel.have.ok': 'Moteur trouvé : Mia s’en servira.',
    'wel.have.comfy': 'C’est un ComfyUI ordinaire : Mia ne sait pas encore s’en servir. Installe plutôt le moteur de Mia, à côté : ce ComfyUI reste intact.',
    'wel.have.toInstall': 'Installer le moteur de Mia',
    'wel.have.incomplete': 'L’installation de ce moteur ne s’est pas terminée. Relance-la dans ce dossier : elle reprend où elle en était.',
    'wel.have.resume': 'Reprendre l’installation ici',
    'wel.have.models': 'Ce dossier contient des modèles mais pas de moteur. Installe le moteur de Mia ailleurs ; tu pourras y ranger ces modèles.',
    'wel.have.empty': 'Ce dossier ne contient pas de moteur.',
    'wel.have.refused': 'Mia n’a pas pu l’adopter : {msg}',
    'wel.inst.title': 'Installer le moteur de Mia',
    'wel.inst.desc': 'Python, ComfyUI et les outils de Mia, dans un dossier à toi. ≈ 8 Go à télécharger, 20 à 40 minutes, connexion nécessaire.',
    'wel.inst.folder': 'Dossier',
    'wel.inst.browse': 'Choisir…',
    'wel.inst.go': 'Installer le moteur',
    'wel.inst.running': 'Installation en cours',
    'wel.inst.step': 'étape {n} sur {total}',
    'wel.inst.cancel': 'Arrêter',
    'wel.inst.done': 'Le moteur est installé dans {dir}.',
    'wel.inst.dry': 'Simulation terminée : rien n’a été téléchargé ni installé.',
    'wel.inst.failed': 'L’installation s’est arrêtée : {msg}',
    'wel.inst.anyway': 'Installer quand même',
    'wel.inst.cancelled': 'Installation arrêtée. Tu peux la relancer : elle reprend où elle en était.',
    'wel.inst.noScript': 'Le programme d’installation n’est pas dans cette copie de Mia.',
    'wel.inst.space': 'Il reste {free} libres sur le disque {drive}.',
    'wel.inst.spaceShort': 'Il reste {free} libres sur le disque {drive} : il en faut au moins {need} pour le moteur, et 20 à 150 Go de plus pour les modèles.',
    'wel.inst.details': 'Détails',
    'wel.inst.hide': 'Masquer les détails',
    'wel.inst.background': 'L’installation du moteur continue : tu la retrouves dans Modèles → Configurer le moteur…',
    'wel.time.s': '{s} s',
    'wel.time.m': '{m} min {s} s',
    'wel.later': 'Plus tard',
    'wel.laterToast': 'Tu pourras configurer le moteur depuis Modèles.',
    'wel.next': 'Continuer',
    'wel.back': 'Retour',
    'wel.models.title': 'Les modèles',
    'wel.models.lead': 'Choisis ce que tu veux faire. Mia télécharge les fichiers un par un depuis Hugging Face ; tu peux travailler pendant ce temps, et tout reprendre plus tard.',
    'wel.models.ready': 'Prêt',
    'wel.models.loading': 'Lecture de ce qui est déjà là…',
    'wel.models.none': 'Mia ne sait rien installer d’ici pour l’instant.',
    'wel.models.total': 'Sélection : {size}',
    'wel.models.free': 'il reste {free} libres sur le disque {drive}',
    'wel.models.short': 'pas assez de place sur le disque {drive} ({free} libres)',
    'wel.models.licence': 'licence Hugging Face à accepter',
    'wel.models.skip': 'Passer',
    'wel.models.install': 'Installer la sélection ({size})',
    'wel.models.failed': 'Les téléchargements n’ont pas pu partir : {msg}',
    'wel.ready.title': 'C’est prêt',
    'wel.ready.almost': 'Presque prêt',
    'wel.ready.engine': 'Le moteur est dans {dir}.',
    'wel.ready.noEngine': 'Pas encore de moteur : les calculs l’attendront. Tu pourras l’installer depuis Modèles → Configurer le moteur…',
    'wel.ready.dl': '{n} fichiers en téléchargement ({size}) : tu peux les suivre dans Modèles.',
    'wel.ready.dlOne': 'Un fichier en téléchargement ({size}) : tu peux le suivre dans Modèles.',
    'wel.ready.blocked': '{name} ({size}) partira dès que ton jeton Hugging Face sera enregistré.',
    'wel.ready.noDl': 'Aucun modèle pour l’instant : ajoute-les quand tu veux depuis Modèles.',
    'wel.ready.see': 'Voir les téléchargements',
    'wel.ready.go': 'Commencer',
    'wel.found': 'Moteur retrouvé : {dir}',
    'wel.cap.image-to-video': 'Une image devient une vidéo.',
    'wel.cap.text-to-video': 'Une vidéo à partir d’une phrase.',
    'wel.cap.3d-to-real': 'Ton blockout 3D devient photoréaliste.',
    'wel.cap.guided-video': 'La vidéo suit la profondeur ou les contours d’une autre.',
    'wel.cap.reference-to-video': 'Une vidéo avec le son, d’après tes images et vidéos de référence.',
    'wel.cap.character-performance': 'Ton personnage rejoue le mouvement d’une vidéo.',
    'wel.cap.image-edit': 'Change une image selon ta consigne.',
    'wel.cap.text-to-image': 'Crée une image depuis ta consigne (licence non commerciale).',
    'wel.cap.upscale': 'Agrandit fidèlement une image ou une vidéo.',
    'wel.cap.depth': 'La profondeur de chaque image.',
    'wel.cap.cutout': 'Détoure le sujet, cheveux compris.',
    'wel.shared': 'fichiers en commun avec « {cap} »',
  },
  en: {
    'wel.step.engine': 'Engine',
    'wel.step.models': 'Models',
    'wel.step.ready': 'Ready',
    'wel.step.skipped': 'skipped',
    'wel.dialog': 'Welcome to Mia',
    'wel.title': 'Welcome to Mia',
    'wel.lead': 'To render, Mia needs an engine on this PC: ComfyUI and a few tools. Mia did not find one.',
    'wel.foreign': 'A ComfyUI is already running on this PC (port {port}): it is not Mia’s engine. Mia installs its own next to it, on another port, without touching that one.',
    'wel.have.title': 'I already have Mia’s engine',
    'wel.have.desc': 'The folder of a Mia engine already installed (it holds env\\venv and env\\ComfyUI).',
    'wel.have.ph': 'Engine folder, for example D:\\Mia-engine',
    'wel.have.pick': 'Browse…',
    'wel.have.checking': 'Reading the folder…',
    'wel.have.ok': 'Engine found: Mia will use it.',
    'wel.have.comfy': 'This is a plain ComfyUI: Mia cannot use it yet. Install Mia’s engine instead, next to it: this ComfyUI stays as it is.',
    'wel.have.toInstall': 'Install Mia’s engine',
    'wel.have.incomplete': 'This engine’s install did not finish. Run it again in this folder: it resumes where it stopped.',
    'wel.have.resume': 'Resume the install here',
    'wel.have.models': 'This folder holds models but no engine. Install Mia’s engine elsewhere; you can move these models into it.',
    'wel.have.empty': 'This folder holds no engine.',
    'wel.have.refused': 'Mia could not adopt it: {msg}',
    'wel.inst.title': 'Install Mia’s engine',
    'wel.inst.desc': 'Python, ComfyUI and Mia’s tools, in a folder of yours. ≈ 8 GB to download, 20 to 40 minutes, internet needed.',
    'wel.inst.folder': 'Folder',
    'wel.inst.browse': 'Browse…',
    'wel.inst.go': 'Install the engine',
    'wel.inst.running': 'Installing',
    'wel.inst.step': 'step {n} of {total}',
    'wel.inst.cancel': 'Stop',
    'wel.inst.done': 'The engine is installed in {dir}.',
    'wel.inst.dry': 'Dry run finished: nothing was downloaded or installed.',
    'wel.inst.failed': 'The install stopped: {msg}',
    'wel.inst.anyway': 'Install anyway',
    'wel.inst.cancelled': 'Install stopped. You can start it again: it resumes where it was.',
    'wel.inst.noScript': 'The installer is not part of this copy of Mia.',
    'wel.inst.space': '{free} free on drive {drive}.',
    'wel.inst.spaceShort': '{free} free on drive {drive}: the engine needs at least {need}, and the models 20 to 150 GB more.',
    'wel.inst.details': 'Details',
    'wel.inst.hide': 'Hide details',
    'wel.inst.background': 'The engine install goes on: find it again in Models → Set up the engine…',
    'wel.time.s': '{s} s',
    'wel.time.m': '{m} min {s} s',
    'wel.later': 'Later',
    'wel.laterToast': 'You can set up the engine from Models.',
    'wel.next': 'Continue',
    'wel.back': 'Back',
    'wel.models.title': 'Models',
    'wel.models.lead': 'Pick what you want to do. Mia downloads the files one by one from Hugging Face; you can keep working meanwhile, and resume later.',
    'wel.models.ready': 'Ready',
    'wel.models.loading': 'Reading what is already there…',
    'wel.models.none': 'Mia cannot install anything from here for now.',
    'wel.models.total': 'Selection: {size}',
    'wel.models.free': '{free} free on drive {drive}',
    'wel.models.short': 'not enough room on drive {drive} ({free} free)',
    'wel.models.licence': 'Hugging Face license to accept',
    'wel.models.skip': 'Skip',
    'wel.models.install': 'Install the selection ({size})',
    'wel.models.failed': 'The downloads could not start: {msg}',
    'wel.ready.title': 'Ready',
    'wel.ready.almost': 'Almost ready',
    'wel.ready.engine': 'The engine is in {dir}.',
    'wel.ready.noEngine': 'No engine yet: renders will wait for it. You can install it from Models → Set up the engine…',
    'wel.ready.dl': '{n} files downloading ({size}): follow them in Models.',
    'wel.ready.dlOne': 'One file downloading ({size}): follow it in Models.',
    'wel.ready.blocked': '{name} ({size}) starts as soon as your Hugging Face token is saved.',
    'wel.ready.noDl': 'No model yet: add them whenever you like from Models.',
    'wel.ready.see': 'See the downloads',
    'wel.ready.go': 'Start',
    'wel.found': 'Engine found again: {dir}',
    'wel.cap.image-to-video': 'An image becomes a video.',
    'wel.cap.text-to-video': 'A video from a sentence.',
    'wel.cap.3d-to-real': 'Your 3D blockout becomes photoreal.',
    'wel.cap.guided-video': 'The video follows the depth or edges of another one.',
    'wel.cap.reference-to-video': 'A video with sound, from your reference images and videos.',
    'wel.cap.character-performance': 'Your character replays the motion of a video.',
    'wel.cap.image-edit': 'Changes an image following your prompt.',
    'wel.cap.text-to-image': 'Creates an image from your prompt (non-commercial license).',
    'wel.cap.upscale': 'Faithfully upscales an image or a video.',
    'wel.cap.depth': 'The depth of every frame.',
    'wel.cap.cutout': 'Cuts out the subject, hair included.',
    'wel.shared': 'files shared with “{cap}”',
  },
});

const CAP_ORDER = ['image-to-video', 'text-to-video', '3d-to-real', 'guided-video', 'reference-to-video', 'character-performance',
  'image-edit', 'text-to-image', 'upscale', 'depth', 'cutout'];
// cochés d'office — sauf un usage à licence tant qu'il n'y a pas de jeton (il ne partirait pas)
const DEFAULT_CAPS = new Set(['image-to-video', 'depth', 'cutout']);
const STEPS = ['engine', 'models', 'ready'];
const mia = () => window.mia || {};

// ── feuille de style : ajoutée une fois, à côté des autres ───────────
function ensureStyle() {
  if (document.getElementById('welcome-css')) return;
  const link = el('link', { id: 'welcome-css', rel: 'stylesheet', href: 'css/welcome.css' });
  document.head.append(link);
}

let view = null;   // { root, page, bar, steps, step, check, engineOk, engineDir, run, … }

// ── démarrage ────────────────────────────────────────────────────────
/** Au démarrage : rien si un moteur est utilisable ; un autre moteur trouvé est adopté ; sinon l'assistant. */
export async function maybeWelcome() {
  if (view) return;
  const api = mia().app;
  if (!api || typeof api.engineCheck !== 'function') return;
  let chk = null;
  try { chk = await api.engineCheck(); } catch { return; }
  if (!chk || chk.ok === false) return;
  // Un moteur de Mia trouvé ailleurs (le labo) est adopté — même quand le ComfyUI qui répond déjà suffirait :
  // sinon Réglages dirait « Non défini » pour un moteur en marche. Le message n'est utile que s'il manquait.
  if (chk.suggest && (!chk.usable || !chk.current?.root)) {
    try {
      const r = await mia().prefs?.set?.({ engineRoot: chk.suggest });
      if (!r || r.ok !== false) {
        if (!chk.usable) toast(t('wel.found', { dir: chk.suggest }), { kind: 'ok' });
        return;
      }
    } catch { /* on montre l'assistant */ }
  }
  if (chk.usable) return;
  let prefs = state.prefs;
  try { prefs = (await mia().prefs?.get?.()) || prefs; } catch { /* celles de l'état */ }
  if (prefs && prefs.welcomeLater) return;   // « Plus tard » : la bibliothèque le repropose (« Configurer le moteur… »)
  openWelcome({ check: chk });
}

/** Ouvre l'assistant (step : 'engine' | 'models' | 'ready'). */
export async function openWelcome({ step = 'engine', check = null } = {}) {
  ensureStyle();
  if (view) { go(step); return; }
  let chk = check;
  if (!chk) {
    try { chk = await mia().app?.engineCheck?.(); } catch { chk = null; }
  }
  // une installation du moteur peut tourner encore (lancée puis « Plus tard ») : on la reprend à l'écran
  let running = null;
  try { running = (await mia().installer?.status?.())?.engine || null; } catch { running = null; }
  if (view) { go(step); return; }
  const bar = el('div', { class: 'wel-bar', 'aria-hidden': 'true' }, el('i'));
  const steps = el('ol', { class: 'wel-steps' },
    ...STEPS.map((s) => el('li', { dataset: { step: s } })));
  const page = el('div', { class: 'wel-page' });
  const root = el('div', { id: 'welcome', class: 'wel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('wel.dialog') },
    bar, el('div', { class: 'wel-scroll' }, el('div', { class: 'wel-col' }, steps, page)));
  // les raccourcis de la planche ne doivent pas partir pendant qu'on tape un chemin
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && view?.step === 'ready') { e.preventDefault(); close(); }
    e.stopPropagation();
  });
  root.addEventListener('contextmenu', (e) => { if (!e.target.closest('input, textarea')) e.preventDefault(); });
  document.body.append(root);
  view = {
    root, page, bar, steps, step: null, shown: null, check: chk,
    engineOk: !!chk?.usable, engineDir: chk?.current?.ok ? chk.current.root : null,
    choice: null, panelShown: null, picked: null, haveDir: '', run: null, queued: null, blocked: [], selection: null, inst: null,
    installDir: null, space: chk?.space || null, needBytes: chk?.needBytes || 25 * 2 ** 30, showLog: false, timer: 0, notes: {},
  };
  view.offEngine = mia().installer?.onProgress?.((ev) => { if (ev && ev.kind === 'engine') onEngine(ev); }) || null;
  if (running && running.running) {
    view.choice = 'install';
    view.installDir = running.dir;
    view.run = { state: 'running', dir: running.dir, dryRun: !!running.dryRun, lines: (running.lines || []).slice(), p: running.p ?? null, started: running.started || Date.now() };
    setBar(view.run.p || 0, true);
    startTimer();
  }
  go(chk?.usable && step === 'engine' && !view.run ? 'models' : step);
}

function close() {
  if (!view) return;
  const v = view;
  view = null;
  clearInterval(v.timer);
  try { v.offEngine?.(); } catch { /* déjà parti */ }
  v.root.classList.add('out');
  const done = () => v.root.remove();
  v.root.addEventListener('animationend', done, { once: true });
  setTimeout(done, ms('exit') + 60);   // si l'animation n'a pas lieu (mouvement réduit : ms() vaut 0)
}

// Une étape passée sans être faite (pas de moteur, aucun modèle) a un tiret, pas une coche.
function stepDone(s) {
  if (s === 'engine') return !!view.engineOk;
  if (s === 'models') return !!(view.queued?.n || anyReady());
  return false;
}
const anyReady = () => Object.values(view?.inst?.caps || {}).some((c) => c.state === 'ready');

function go(step) {
  if (!view) return;
  const entering = view.shown !== step;
  view.step = step;
  view.shown = step;
  const cur = STEPS.indexOf(step);
  for (const li of view.steps.children) {
    const s = li.dataset.step;
    const k = STEPS.indexOf(s);
    const past = k < cur;
    const done = past && stepDone(s);
    li.className = [k === cur && 'on', past && 'past', past && !done && 'skip'].filter(Boolean).join(' ');
    li.textContent = '';
    li.append(el('span', { class: 'wel-step-n', html: past ? icon(done ? 'check' : 'minus', 11) : '' }, past ? null : String(k + 1)),
      el('span', {}, t('wel.step.' + s)));
    if (past && !done) li.append(el('span', { class: 'wel-sr' }, ` (${t('wel.step.skipped')})`));
  }
  const card = step === 'models' ? modelsPage() : step === 'ready' ? readyPage() : enginePage();
  card.classList.toggle('enter', entering);
  view.page.textContent = '';
  view.page.append(card);
  if (entering) view.root.querySelector('.wel-scroll').scrollTop = 0;
  if (entering) requestAnimationFrame(() => card.querySelector('[data-autofocus]')?.focus({ preventScroll: true }));
}

// ── page 1 : le moteur ───────────────────────────────────────────────
function choiceRow(id, glyph, title, desc, disabled = false) {
  const row = el('button', { class: ['wel-choice', view.choice === id && 'on'], type: 'button', role: 'radio',
    'aria-checked': view.choice === id ? 'true' : 'false', disabled: disabled || null, dataset: { choice: id } },
  el('span', { class: 'wel-choice-ico', html: icon(glyph, 18) }),
  el('span', { class: 'wel-choice-text' }, el('span', { class: 'wel-choice-title' }, title), el('span', { class: 'wel-choice-desc' }, desc)),
  el('span', { class: 'wel-choice-dot', 'aria-hidden': 'true' }));
  row.addEventListener('click', () => {
    if (view.run?.state === 'running') return;   // pendant l'installation, on ne change pas de chemin
    view.choice = view.choice === id ? null : id;
    go('engine');
  });
  return row;
}

function enginePage() {
  const chk = view.check || {};
  const card = el('section', { class: 'wel-card' });
  card.append(el('div', { class: 'wel-mark', html: logo(30, { tight: true }) }),
    el('h1', { class: 'wel-title' }, t('wel.title')),
    el('p', { class: 'wel-lead' }, t('wel.lead')));
  // un ComfyUI d'une autre appli tourne : ce n'est pas un moteur pour Mia, on le dit avant de proposer
  if (chk.comfy?.foreign && !view.engineOk) card.append(resultLine('info', t('wel.foreign', { port: chk.comfy.foreign.port || '?' }), 'wel-foreign'));
  const choices = el('div', { class: 'wel-choices', role: 'radiogroup' });
  const have = choiceRow('have', 'folder', t('wel.have.title'), t('wel.have.desc'));
  if (!view.choice) have.dataset.autofocus = '';
  choices.append(have);
  if (view.choice === 'have') choices.append(panelEnter(havePanel(), 'have'));
  const scriptMissing = chk.script === false;
  choices.append(choiceRow('install', 'lib-dl', t('wel.inst.title'), scriptMissing ? t('wel.inst.noScript') : t('wel.inst.desc'), scriptMissing));
  if (view.choice === 'install') choices.append(panelEnter(installPanel(), 'install'));
  if (!view.choice) view.panelShown = null;
  card.append(choices);
  const next = button({ label: t('wel.next'), kind: 'primary', disabled: !view.engineOk, onClick: () => go('models') });
  const later = button({ label: t('wel.later'), kind: 'ghost', onClick: later_ });
  card.append(el('div', { class: 'wel-foot' }, later, next));
  return card;
}

// le panneau d'un choix ne fond qu'à son ouverture, pas à chaque mise à jour de la page
function panelEnter(p, id) {
  if (view.panelShown !== id) p.classList.add('enter');
  view.panelShown = id;
  return p;
}

async function later_() {
  const running = view?.run?.state === 'running';
  try { await mia().prefs?.set?.({ welcomeLater: Date.now() }); } catch { /* rien de grave */ }
  close();
  // le script continue dans le principal : on le retrouve en rouvrant l'assistant
  toast(t(running ? 'wel.inst.background' : 'wel.laterToast'));
}

function resultLine(kind, text, cls = null) {
  const glyph = kind === 'ok' ? 'check' : kind === 'wait' ? 'refresh' : kind === 'warn' ? 'warn' : 'info';
  return el('div', { class: ['wel-res', 'is-' + kind, cls] }, el('span', { class: 'wel-res-ico', html: icon(glyph, 13) }), el('span', {}, text));
}

// « J'ai déjà le moteur de Mia » : un champ où coller le chemin, ou le sélecteur de dossier en secours.
function havePanel() {
  const p = el('div', { class: 'wel-panel' });
  const field = textField({ value: view.haveDir || view.picked?.root || '', placeholder: t('wel.have.ph'), size: 'md', mono: true,
    onInput: (v) => { view.haveDir = v; }, onChange: (v) => checkHave(String(v || '').trim()) });
  field.classList.add('wel-field');
  field.dataset.autofocus = '';
  const pick = button({ label: t('wel.have.pick'), icon: 'folder', kind: 'ghost', size: 'sm', onClick: async () => {
    let dir = null;
    try { dir = await mia().media?.pickFolder?.(); } catch { dir = null; }
    if (dir && typeof dir === 'string' && view) { view.haveDir = dir; field.setValue(dir); checkHave(dir, true); }
  } });
  p.append(el('div', { class: 'wel-row' }, field, pick));
  const r = view.picked;
  if (r && r.state === 'checking') p.append(resultLine('wait', t('wel.have.checking')));
  else if (r && r.state === 'ok') p.append(resultLine('ok', t('wel.have.ok')));
  else if (r && r.state === 'refused') p.append(resultLine('warn', t('wel.have.refused', { msg: r.error })));
  else if (r && r.kind) {
    if (r.kind === 'comfy' || r.kind === 'comfy-portable') {
      p.append(resultLine('warn', t('wel.have.comfy')),
        el('div', { class: 'wel-actions' }, button({ label: t('wel.have.toInstall'), icon: 'lib-dl', kind: 'ghost', size: 'sm', onClick: () => { view.choice = 'install'; go('engine'); } })));
    } else if (r.kind === 'incomplete') {
      p.append(resultLine('warn', t('wel.have.incomplete')),
        el('div', { class: 'wel-actions' }, button({ label: t('wel.have.resume'), icon: 'lib-dl', kind: 'ghost', size: 'sm', onClick: () => { view.installDir = r.root; view.choice = 'install'; go('engine'); } })));
    } else {
      p.append(resultLine('warn', t(r.kind === 'models-only' ? 'wel.have.models' : 'wel.have.empty')));
    }
  }
  return p;
}

async function checkHave(dir, force = false) {
  if (!view || !dir) return;
  if (!force && view.picked && view.picked.root === dir && view.picked.state !== 'checking') return;
  view.picked = { root: dir, state: 'checking' };
  go('engine');
  let chk = null;
  try { chk = await mia().app?.engineCheck?.({ root: dir }); } catch { chk = null; }
  if (!view || view.picked?.root !== dir) return;
  const k = chk?.current || { kind: 'empty' };
  if (k.ok) {
    let r = null;
    try { r = await mia().prefs?.set?.({ engineRoot: dir }); } catch (err) { r = { ok: false, error: String(err?.message || err) }; }
    if (!view) return;
    if (r && r.ok === false) view.picked = { root: dir, state: 'refused', error: r.error };
    else {
      view.picked = { root: dir, state: 'ok' };
      view.engineOk = true;
      view.engineDir = dir;
    }
  } else {
    view.picked = { root: dir, state: 'bad', kind: k.kind };
  }
  go('engine');
}

// « Installer le moteur de Mia » : le dossier (champ + Choisir…), la place qui y reste, puis le déroulé.
function installPanel() {
  const chk = view.check || {};
  const p = el('div', { class: 'wel-panel' });
  const run = view.run;
  if (!run || run.state === 'error' || run.state === 'cancelled') {
    const dir0 = view.installDir || chk.suggestDir || '';
    const space = el('div', { class: 'wel-space' });
    const field = textField({ value: dir0, size: 'md', mono: true, onInput: (v) => { view.installDir = v; spaceSoon(v, space); } });
    field.classList.add('wel-field');
    field.dataset.autofocus = '';
    const browse = button({ label: t('wel.inst.browse'), kind: 'ghost', size: 'sm', onClick: async () => {
      let dir = null;
      try { dir = await mia().media?.pickFolder?.(); } catch { dir = null; }
      if (dir && view) { view.installDir = dir; field.setValue(dir); spaceSoon(dir, space, true); }
    } });
    p.append(el('label', { class: 'wel-label' }, t('wel.inst.folder')), el('div', { class: 'wel-row' }, field, browse), space);
    paintSpace(space);
    if (view.space?.dir !== dir0) spaceSoon(dir0, space, true);
    if (run?.state === 'error') {
      p.append(resultLine('warn', t('wel.inst.failed', { msg: run.error || '—' })));
    }
    if (run?.state === 'cancelled') p.append(resultLine('info', t('wel.inst.cancelled')));
    const actions = el('div', { class: 'wel-actions' });
    // pas de carte NVIDIA (ou un pilote trop ancien) : le script s'arrête ; on peut installer quand même
    if (run?.state === 'error' && run.gpu) {
      actions.append(button({ label: t('wel.inst.anyway'), kind: 'ghost', size: 'sm', onClick: () => startEngine(field.value.trim(), { skipGpuCheck: true }) }));
    }
    actions.append(button({ label: t('wel.inst.go'), icon: 'lib-dl', kind: 'primary', size: 'sm', onClick: () => startEngine(field.value.trim()) }));
    p.append(actions);
    if (run?.lines?.length) p.append(...progressBlock(run));
    return p;
  }
  // en cours, ou fini
  if (run.state === 'running') {
    run.timeEl = el('span', { class: 'wel-run-time' }, elapsed(run));
    run.stepEl = el('span', { class: 'wel-run-step' }, stepText(run));
    run.pctEl = el('span', { class: 'wel-run-pct' }, run.p != null ? pct(run.p) : '');
    p.append(el('div', { class: 'wel-row wel-running' },
      el('span', { class: 'wel-run-txt' }, t('wel.inst.running')),
      run.stepEl, run.pctEl, run.timeEl,
      el('span', { class: 'wel-foot-gap' }),
      button({ label: t('wel.inst.cancel'), kind: 'ghost', size: 'sm', onClick: () => mia().installer?.cancel?.({ engine: true }) })));
  } else if (run.state === 'done') {
    p.append(resultLine('ok', run.dryRun ? t('wel.inst.dry') : t('wel.inst.done', { dir: run.dir })));
    if (run.warning) p.append(resultLine('warn', run.warning));
  }
  p.append(...progressBlock(run));
  return p;
}

// la place libre du dossier choisi (le principal la lit, le dossier n'a pas besoin d'exister)
const spaceAsk = debounce(async (dir, box) => {
  if (!view || !dir) return;
  let r = null;
  try { r = await mia().app?.engineCheck?.({ root: dir }); } catch { r = null; }
  if (!view || (view.installDir || view.check?.suggestDir) !== dir) return;
  view.space = r?.space || null;
  if (r?.needBytes) view.needBytes = r.needBytes;
  if (box.isConnected) paintSpace(box);
}, 350);
function spaceSoon(dir, box, now = false) {
  if (now) { spaceAsk(dir, box); return; }
  spaceAsk(String(dir || '').trim(), box);
}
function paintSpace(box) {
  const s = view?.space;
  box.textContent = '';
  if (!s || s.free == null || !s.drive) return;
  const short = s.free < view.needBytes;
  const drive = String(s.drive).replace(/:$/, '');
  box.classList.toggle('short', short);
  box.textContent = short
    ? t('wel.inst.spaceShort', { free: gbText(s.free / 1e9), drive, need: gbText(view.needBytes / 1e9) })
    : t('wel.inst.space', { free: gbText(s.free / 1e9), drive });
}

const pct = (f) => new Intl.NumberFormat(locale(), { style: 'percent', maximumFractionDigits: 0 }).format(Math.max(0, Math.min(1, f || 0)));
function elapsed(run) {
  const s = Math.max(0, Math.round((Date.now() - (run.started || Date.now())) / 1000));
  return s < 60 ? t('wel.time.s', { s }) : t('wel.time.m', { m: Math.floor(s / 60), s: String(s % 60).padStart(2, '0') });
}

// Le déroulé lisible : les lignes « [3/11] Étape » du script, une par étape (faite, en cours, arrêtée) ; le
// journal brut (les commandes uv, python…) reste replié sous « Détails ».
const STEP_RE = /^\[(\d{1,2})\/(\d{1,2})\]\s+(.+)$/;
function stepsOf(run) {
  const out = [];
  for (const l of run.lines || []) {
    const m = STEP_RE.exec(String(l).trim());
    if (m) out.push({ n: Number(m[1]), total: Number(m[2]), label: m[3] });
  }
  return out;
}
function stepText(run) {
  const s = stepsOf(run);
  const last = s[s.length - 1];
  return last ? t('wel.inst.step', { n: last.n, total: last.total }) : '';
}
function paintSteps(run) {
  const box = run.stepsBox;
  if (!box) return;
  const s = stepsOf(run);
  box.textContent = '';
  s.forEach((st, k) => {
    const lastOne = k === s.length - 1;
    const state = !lastOne || run.state === 'done' ? 'done' : run.state === 'running' ? 'now' : 'stop';
    box.append(el('li', { class: 'is-' + state },
      el('span', { class: 'wel-st-ico', html: state === 'done' ? icon('check', 11) : state === 'stop' ? icon('close', 11) : '' }),
      el('span', { class: 'wel-st-n' }, `${st.n}/${st.total}`),
      el('span', { class: 'wel-st-label' }, st.label)));
  });
  box.hidden = !s.length;
}
function progressBlock(run) {
  run.stepsBox = el('ol', { class: 'wel-stlist', 'aria-live': 'polite' });
  paintSteps(run);
  const toggleBtn = button({ label: t(view.showLog ? 'wel.inst.hide' : 'wel.inst.details'), kind: 'ghost', size: 'xs', onClick: () => {
    view.showLog = !view.showLog;
    go('engine');
  } });
  const out = [run.stepsBox, el('div', { class: 'wel-details' }, toggleBtn)];
  run.box = null;
  if (view.showLog) out.push(logBox(run));
  return out;
}

function logBox(run) {
  const box = el('pre', { class: 'wel-log', tabindex: '0' });
  box.textContent = (run.lines || []).slice(-400).join('\n');
  requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  run.box = box;
  return box;
}

function startTimer() {
  if (!view) return;
  clearInterval(view.timer);
  // le temps qui passe : pendant les longues étapes (PyTorch ≈ 3 Go), rien d'autre ne bouge à l'écran
  view.timer = setInterval(() => {
    const run = view?.run;
    if (!run || run.state !== 'running') { clearInterval(view?.timer); return; }
    if (run.timeEl?.isConnected) run.timeEl.textContent = elapsed(run);
  }, 1000);
}

async function startEngine(dir, { skipGpuCheck = false } = {}) {
  if (!view || view.run?.state === 'running' || !dir) return;
  view.installDir = dir;
  view.run = { state: 'running', dir, lines: [], p: null, dryRun: false, started: Date.now() };
  setBar(0, true);
  startTimer();
  go('engine');
  let r = null;
  try { r = await mia().installer?.engine?.({ dir, skipGpuCheck }); } catch (err) { r = { ok: false, error: String(err?.message || err) }; }
  endRun(r || { ok: false, error: '—' });
}

// La fin arrive deux fois (l'événement du principal, puis la réponse de mia.installer.engine) — ou une seule, pour
// une installation reprise à l'écran : la première l'emporte.
function endRun(res) {
  const run = view?.run;
  if (!run || run.state !== 'running') return;
  clearInterval(view.timer);
  if (res.cancelled || res.state === 'cancelled') {
    run.state = 'cancelled';
  } else if (res.ok === false || res.state === 'error') {
    run.state = 'error';
    run.error = res.error || '—';
    run.gpu = !!res.gpu;
    if (Array.isArray(res.log) && !run.lines.length) run.lines = res.log;
  } else {
    run.state = 'done';
    run.dryRun = !!res.dryRun;
    run.warning = res.warning || (res.state === 'done' ? res.error : null) || null;
    if (!run.dryRun && res.adopted) {
      view.engineOk = true;
      view.engineDir = run.dir;
    }
  }
  setBar(run.state === 'done' ? 1 : 0, false);
  if (view.step === 'engine') go('engine');
}

// le journal du script arrive ligne par ligne : on met à jour le déroulé sans redessiner la page
function onEngine(ev) {
  const run = view?.run;
  if (!run) return;
  if (ev.line && run.state === 'running') {
    run.lines.push(ev.line);
    if (run.lines.length > 2000) run.lines.splice(0, run.lines.length - 2000);
    if (STEP_RE.test(String(ev.line).trim())) {
      paintSteps(run);
      if (run.stepEl?.isConnected) run.stepEl.textContent = stepText(run);
    }
    if (run.box && run.box.isConnected) {
      const stick = run.box.scrollTop + run.box.clientHeight >= run.box.scrollHeight - 24;
      run.box.textContent = run.lines.slice(-400).join('\n');
      if (stick) run.box.scrollTop = run.box.scrollHeight;
    }
  }
  if (ev.state && ev.state !== 'running') { endRun(ev); return; }
  if (run.state !== 'running') return;
  if (typeof ev.p === 'number') {
    run.p = ev.p;
    setBar(ev.p, true);
    if (run.pctEl?.isConnected) run.pctEl.textContent = pct(ev.p);
  }
}

function setBar(p, on) {
  if (!view) return;
  view.bar.classList.toggle('on', !!on);
  view.bar.classList.toggle('indet', !!on && !p);
  view.bar.firstChild.style.transform = `scaleX(${Math.max(0, Math.min(1, p || 0))})`;
}

// ── page 2 : les modèles ─────────────────────────────────────────────
function modelsPage() {
  const card = el('section', { class: 'wel-card' });
  card.append(el('h1', { class: 'wel-title' }, t('wel.models.title')), el('p', { class: 'wel-lead' }, t('wel.models.lead')));
  const list = el('div', { class: 'wel-caps' });
  const sum = el('div', { class: 'wel-sum' });
  const note = el('div', { class: 'wel-note-slot' });
  const install = button({ label: t('wel.next'), icon: 'lib-dl', kind: 'primary', onClick: () => startModels() });
  card.append(list, sum, note, el('div', { class: 'wel-foot' },
    button({ label: t('wel.back'), kind: 'ghost', onClick: () => go('engine') }),
    el('span', { class: 'wel-foot-gap' }),
    button({ label: t('wel.models.skip'), kind: 'ghost', onClick: () => { view.queued = null; view.blocked = []; go('ready'); } }),
    install));
  view.models = { list, sum, note, install };
  if (view.inst) paintCaps();
  else {
    list.append(el('div', { class: 'wel-wait' }, t('wel.models.loading')));
    loadCaps();
  }
  return card;
}

async function loadCaps() {
  let r = null;
  try { r = await mia().installer?.list?.(); } catch { r = null; }
  if (!view) return;
  view.inst = r && r.ok !== false ? r : { caps: {}, files: {} };
  if (!view.selection) {
    view.selection = new Set(CAP_ORDER.filter((c) => DEFAULT_CAPS.has(c) && view.inst.caps?.[c]?.missing?.length && (!view.inst.caps[c].gated || view.inst.token)));
  }
  if (view.step === 'models') paintCaps();
}

// les fichiers à télécharger pour la sélection, sans compter deux fois ceux qu'ont plusieurs usages (LTX)
function selectedKeys() {
  const keys = new Set();
  for (const c of view.selection || []) for (const k of view.inst?.caps?.[c]?.missing || []) keys.add(k);
  return keys;
}
// un fichier à licence sans jeton ne partirait pas : il attend (le principal le met de côté)
const isBlocked = (k) => !!(view.inst?.files?.[k]?.gated && !view.inst?.token);

function paintCaps() {
  const m = view.models;
  if (!m) return;
  const inst = view.inst || { caps: {}, files: {} };
  m.list.textContent = '';
  const caps = CAP_ORDER.filter((c) => inst.caps?.[c]);
  if (!caps.length) m.list.append(el('div', { class: 'wel-wait' }, t('wel.models.none')));
  const chosen = selectedKeys();
  for (const c of caps) {
    const ci = inst.caps[c];
    const ready = !ci.missing.length;
    const on = view.selection.has(c);
    // un usage dont tous les fichiers viennent déjà avec un autre usage coché : on le dit, sans compter deux fois
    const own = ci.missing.filter((k) => !on || [...view.selection].every((o) => o === c || !(inst.caps[o]?.missing || []).includes(k)));
    const sharedWith = on && !ready && own.length < ci.missing.length
      ? [...view.selection].find((o) => o !== c && (inst.caps[o]?.missing || []).some((k) => ci.missing.includes(k))) : null;
    const tg = ready ? null : toggle({ value: on, label: tl(ci.label), onChange: (v) => { if (v) view.selection.add(c); else view.selection.delete(c); paintCaps(); } });
    const size = ready ? el('span', { class: 'wel-chip' }, t('wel.models.ready'))
      : el('span', { class: 'wel-size' }, gbText(ci.missingBytes / 1e9));
    const bits = [t('wel.cap.' + c)];
    if (sharedWith) bits.push(t('wel.shared', { cap: tl(inst.caps[sharedWith].label) }));
    else if (!ready && ci.gated && !inst.token) bits.push(t('wel.models.licence'));
    const row = el('div', { class: ['wel-cap', ready && 'ready', on && 'on'] },
      el('span', { class: 'wel-cap-text' },
        el('span', { class: 'wel-cap-name' }, tl(ci.label)),
        el('span', { class: 'wel-cap-desc' }, bits.join(' · '))),
      size, tg || el('span', { class: 'wel-tgl-spacer' }));
    if (tg) row.addEventListener('click', (e) => { if (!e.target.closest('.tgl')) tg.click(); });
    m.list.append(row);
  }
  const bytes = [...chosen].reduce((s, k) => s + (inst.files?.[k]?.bytes || 0), 0);
  const now = [...chosen].filter((k) => !isBlocked(k));
  const nowBytes = now.reduce((s, k) => s + (inst.files?.[k]?.bytes || 0), 0);
  m.sum.textContent = '';
  if (chosen.size) {
    const free = inst.free;
    const short = free != null && free < nowBytes + 1e9;
    m.sum.append(el('span', {}, t('wel.models.total', { size: gbText(bytes / 1e9) })));
    if (free != null && inst.drive) {
      m.sum.append(el('span', { class: ['wel-sum-free', short && 'short'] },
        t(short ? 'wel.models.short' : 'wel.models.free', { free: gbText(free / 1e9), drive: String(inst.drive).replace(/:$/, '') })));
    }
  }
  // la licence Hugging Face : la note et le champ du jeton, gardés d'un dessin à l'autre (on peut être en train
  // de coller son jeton quand on coche une autre ligne)
  const blocked = [...chosen].filter(isBlocked);
  const note = blocked.length ? gatedNote('models', blocked, async (tok) => {
    const r = await saveHfToken(tok);
    if (r && r.ok !== false && view?.inst) { view.inst.token = true; paintCaps(); }
    return r;
  }) : null;
  if (m.note.firstChild !== note) {
    m.note.textContent = '';
    if (note) m.note.append(note);
  }
  m.install.setValue(now.length ? t('wel.models.install', { size: gbText(nowBytes / 1e9) }) : t('wel.next'));
}

// La note d'un modèle à licence (celle de la bibliothèque), une par dépôt : LTX, et son mode « Blockout → rendu ».
function gatedNote(where, keys, onSave) {
  const inst = view.inst || {};
  const byRepo = new Map();
  for (const k of keys) {
    const f = inst.files?.[k];
    if (!f) continue;
    const g = byRepo.get(f.repo);
    if (!g || (f.bytes || 0) > g.bytes) byRepo.set(f.repo, { label: f.label, page: f.page, bytes: f.bytes || 0 });
  }
  const groups = [...byRepo.values()].sort((a, b) => b.bytes - a.bytes);
  const sig = groups.map((g) => g.page).join('|');
  const kept = view.notes[where];
  if (kept && kept.sig === sig) return kept.node;
  const node = tokenNote({ groups, cli: inst.hfCli, tokenPage: inst.tokenPage, onSave });
  node.classList.add('wel-tok');
  view.notes[where] = { sig, node };
  return node;
}

async function startModels() {
  const keys = [...selectedKeys()];
  if (!keys.length) { view.queued = null; view.blocked = []; go('ready'); return; }
  let r = null;
  try { r = await mia().installer?.start?.({ keys }); } catch (err) { r = { ok: false, error: String(err?.message || err) }; }
  if (!view) return;
  if (!r || r.ok === false) { toast(t('wel.models.failed', { msg: r?.error || '—' }), { kind: 'error', ms: 9000 }); return; }
  const files = view.inst?.files || {};
  view.queued = { n: r.queued.length, bytes: r.queued.reduce((s, k) => s + (files[k]?.bytes || 0), 0) };
  view.blocked = r.blocked || [];
  go('ready');
}

// ── page 3 : c'est prêt (ou presque) ─────────────────────────────────
function readyPage() {
  const q = view.queued;
  const blocked = view.blocked || [];
  const files = view.inst?.files || {};
  const complete = !!view.engineOk && !!(q?.n || anyReady()) && !blocked.length;
  const card = el('section', { class: 'wel-card wel-ready' });
  // la coche ne se trace que si tout ce qui a été choisi arrive vraiment
  if (complete) card.append(el('div', { class: 'wel-done', html: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" pathLength="1"/></svg>' }));
  card.append(el('h1', { class: 'wel-title' }, t(complete ? 'wel.ready.title' : 'wel.ready.almost')));
  const lines = el('div', { class: 'wel-lines' });
  if (view.engineDir) lines.append(el('p', {}, t('wel.ready.engine', { dir: view.engineDir })));
  else if (!view.engineOk) lines.append(el('p', {}, t('wel.ready.noEngine')));
  if (q && q.n) lines.append(el('p', {}, q.n === 1 ? t('wel.ready.dlOne', { size: gbText(q.bytes / 1e9) }) : t('wel.ready.dl', { n: q.n, size: gbText(q.bytes / 1e9) })));
  if (blocked.length) {
    const head = blocked.map((k) => files[k]).filter(Boolean).sort((a, b) => (b.bytes || 0) - (a.bytes || 0))[0];
    const bytes = blocked.reduce((s, k) => s + (files[k]?.bytes || 0), 0);
    lines.append(el('p', {}, t('wel.ready.blocked', { name: tl(head?.label) || 'Hugging Face', size: gbText(bytes / 1e9) })));
    // le jeton collé ici fait partir ces fichiers tout de suite
    lines.append(gatedNote('ready', blocked, async (tok) => {
      const r = await saveHfToken(tok, blocked);
      if (r && r.ok !== false && view) {
        const add = r.queued || [];
        view.queued = { n: (view.queued?.n || 0) + add.length, bytes: (view.queued?.bytes || 0) + add.reduce((s, k) => s + (files[k]?.bytes || 0), 0) };
        view.blocked = r.blocked || [];
        if (view.inst) view.inst.token = true;
        // « Jeton enregistré » est dit par un toast (saveHfToken) : la page se redessine tout de suite
        queueMicrotask(() => { if (view?.step === 'ready') go('ready'); });
      }
      return r;
    }));
  }
  if (!(q && q.n) && !blocked.length) lines.append(el('p', {}, t('wel.ready.noDl')));
  card.append(lines);
  const go_ = button({ label: t('wel.ready.go'), kind: 'primary', onClick: finish });
  go_.dataset.autofocus = '';
  card.append(el('div', { class: 'wel-foot' },
    q && q.n ? button({ label: t('wel.ready.see'), kind: 'ghost', onClick: () => { finish(); openLibrary({}); } }) : el('span'),
    go_));
  return card;
}

function finish() {
  mia().prefs?.set?.({ welcomeDone: Date.now() })?.catch?.(() => {});
  close();
}

export default { maybeWelcome, openWelcome };
