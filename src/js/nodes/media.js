// ── Puits de média d'un bloc ─────────────────────────────────────────
// Le média EST le bloc (da.md §3.2) : ce module affiche une image, une vidéo
// muette en boucle ou l'aperçu en direct d'un calcul, avec un fondu enchaîné
// de 240 ms, le badge méta au survol, le damier pour l'alpha et les contrôles
// de lecture façon Slate. Il gère aussi le budget vidéo de la planche : une
// vidéo hors champ ou trop petite à l'écran (< 120 px) est mise en pause et
// remplacée par son poster (da.md §4.7) — indispensable avec 20 vidéos.
//
// Il contient enfin les petits utilitaires partagés par les modules de F
// (URL d'un chemin projet/absolu, formats FR/EN, enregistrement des chaînes).
// Module « feuille » : il n'importe aucun autre module de nodes/ sauf player.js.

import { ms } from '../ui/motion.js';
import { state, mediaUrl, absUrl } from '../state.js';
import { t, register, lang } from '../i18n.js';
import { icon, register as registerIcons, hasIcon } from '../icons.js';
import { el, isTyping } from '../util.js';
import { on, emit } from '../bus.js';
import { toast } from '../ui/toasts.js';
import { openMenu, isMenuOpen } from '../ui/menu.js';
import { isModalOpen } from '../ui/modal.js';
import { attachPlayer, playerKey } from './player.js';

// ── chaînes ──────────────────────────────────────────────────────────

/** Enregistre des chaînes FR/EN (clés plates « node.x », SPEC §6.3). */
export function strings(fr, en) {
  register({ fr, en });
}

strings({
  'node.live': 'En direct',
  'node.meta.fps': '{n} i/s',
  'node.meta.alpha': 'alpha',
  'node.dur.s': '{s} s',
  'node.dur.ms': '{m} min {s} s',
  'node.dur.m': '{m} min',
  'node.dur.hm': '{h} h {m} min',
  'node.dur.hmShort': '{h} h {m}',
  'node.media.broken': 'Lecture impossible ici',
  'node.media.brokenSub': 'Le fichier est intact ; seul l’aperçu ne se lit pas.',
  'node.media.preparing': 'Aperçu en préparation…',
  'node.media.imgBroken': 'Image illisible',
  'node.media.loading': 'Chargement…',
  'node.media.missing': 'Fichier introuvable',
  'node.media.missingSub': '« {name} » n’est plus dans le dossier media de la planche.',
  'node.media.replace': 'Remplacer…',
  'node.shell.failed': 'Action impossible sur ce fichier.',
  'node.frame.copy': 'Copier le numéro d’image',
  'node.frame.copied': 'Numéro d’image copié : {f}',
  'node.extract.failed': 'Impossible de relier un bloc « Extraire une image » à cette sortie.',
  'node.extract.started': 'Image {f} extraite dans un nouveau bloc.',
  'node.meta.khz': '{n} kHz',
  'node.meta.mono': 'mono',
  'node.meta.stereo': 'stéréo',
  'node.meta.channels': '{n} canaux',
  'node.audio.play': 'Écouter',
  'node.audio.pause': 'Pause',
  'node.audio.broken': 'Ce son ne se lit pas ici ; le bloc Son sait l’utiliser.',
}, {
  'node.live': 'Live',
  'node.meta.fps': '{n} fps',
  'node.meta.alpha': 'alpha',
  'node.dur.s': '{s} s',
  'node.dur.ms': '{m} min {s} s',
  'node.dur.m': '{m} min',
  'node.dur.hm': '{h} h {m} min',
  'node.dur.hmShort': '{h}h {m}m',
  'node.media.broken': 'Cannot play here',
  'node.media.brokenSub': 'The file is fine; only the preview cannot play.',
  'node.media.preparing': 'Preparing preview…',
  'node.media.imgBroken': 'Unreadable image',
  'node.media.loading': 'Loading…',
  'node.media.missing': 'File not found',
  'node.media.missingSub': '“{name}” is no longer in the board’s media folder.',
  'node.media.replace': 'Replace…',
  'node.shell.failed': 'This file action is not possible.',
  'node.frame.copy': 'Copy the frame number',
  'node.frame.copied': 'Frame number copied: {f}',
  'node.extract.failed': 'Could not connect an “Extract a frame” block to this output.',
  'node.extract.started': 'Frame {f} extracted into a new block.',
  'node.meta.khz': '{n} kHz',
  'node.meta.mono': 'mono',
  'node.meta.stereo': 'stereo',
  'node.meta.channels': '{n} channels',
  'node.audio.play': 'Listen',
  'node.audio.pause': 'Pause',
  'node.audio.broken': 'This sound cannot play here; the Sound block can still use it.',
});

// Glyphes propres à F (trait 1,7, grille 24, bouts ronds — style Slate). On
// n'écrase jamais un glyphe déjà fourni par D (étoile, dé, stop, chevrons…).
const OWN_ICONS = {
  'step-back': '<path d="M7 5.5v13"/><path d="M18 6.2v11.6a.7.7 0 0 1-1.1.6L9.6 12.6a.7.7 0 0 1 0-1.2l7.3-5.8a.7.7 0 0 1 1.1.6z" fill="currentColor" stroke="none"/>',
  'step-fwd': '<path d="M17 5.5v13"/><path d="M6 6.2v11.6a.7.7 0 0 0 1.1.6l7.3-5.8a.7.7 0 0 0 0-1.2L7.1 5.6a.7.7 0 0 0-1.1.6z" fill="currentColor" stroke="none"/>',
  'to-start': '<path d="M6 5v14"/><path d="M18.5 6.5L10 12l8.5 5.5"/>',
  'to-end': '<path d="M18 5v14"/><path d="M5.5 6.5L14 12l-8.5 5.5"/>',
  'loop': '<path d="M4.5 11V9.5A3 3 0 0 1 7.5 6.5h11"/><path d="M15.5 3.5l3 3-3 3"/><path d="M19.5 13v1.5a3 3 0 0 1-3 3h-11"/><path d="M8.5 20.5l-3-3 3-3"/>',
  'sound': '<path d="M5 9.4h3l4-3.4v12l-4-3.4H5z" fill="currentColor"/><path d="M15.4 9a4 4 0 0 1 0 6"/>',
  'mute': '<path d="M5 9.4h3l4-3.4v12l-4-3.4H5z" fill="currentColor"/><path d="M15.6 9.6l4.4 4.8M20 9.6l-4.4 4.8"/>',
  'file': '<path d="M6.5 3.5h7l4 4v11.5a1.5 1.5 0 0 1-1.5 1.5h-9.5A1.5 1.5 0 0 1 5 19V5a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M13.5 3.5v4h4"/>',
  'drop-in': '<path d="M12 4v10M7.8 9.8L12 14l4.2-4.2"/><path d="M4.5 14.5v2.8a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.8"/>',
};
registerIcons(Object.fromEntries(Object.entries(OWN_ICONS).filter(([k]) => !hasIcon(k))));

// ── chemins et formats ───────────────────────────────────────────────

/** Chemin Windows absolu ? (sinon : relatif au projet, séparateur « / »). */
export const isAbs = (p) => /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p);

/** URL affichable d'un chemin de projet, d'un chemin absolu ou d'une URL. */
export function urlFor(p, projectId) {
  if (!p) return '';
  if (/^(mia|blob|data|https?|file):/i.test(p)) return p;
  if (isAbs(p)) return absUrl(p);
  const pid = projectId || state.project?.id;
  return pid ? mediaUrl(p, pid) : p;
}

/** Dernier segment d'un chemin (nom de fichier). */
export const baseName = (p) => String(p || '').split(/[\\/]/).pop();

/** Nombre localisé (virgule en FR). */
export function num(v, digits = 1) {
  if (v == null || !isFinite(v)) return '–';
  return new Intl.NumberFormat(lang() === 'en' ? 'en-US' : 'fr-FR', {
    maximumFractionDigits: digits, minimumFractionDigits: 0,
  }).format(v);
}

/** Durée lisible à partir de millisecondes : « 38 s », « 1 min 20 s », « 1 h 05 min ». */
export function fmtDur(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return t('node.dur.s', { s: Math.max(s, 1) });
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return r ? t('node.dur.ms', { m, s: r }) : t('node.dur.m', { m });
  const h = Math.floor(m / 60);
  return t('node.dur.hm', { h, m: String(m % 60).padStart(2, '0') });
}

/** Forme courte d'une durée, pour un en-tête de carte : « 38 s », « 10 min », « 1 h 12 » (« 1h 12m » en anglais). */
export function fmtDurShort(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return t('node.dur.s', { s: Math.max(s, 1) });
  const m = Math.round(s / 60);
  if (m < 60) return t('node.dur.m', { m });
  return t('node.dur.hmShort', { h: Math.floor(m / 60), m: String(m % 60).padStart(2, '0') });
}

/** Badge méta du puits : « 1920×1080 · 24 I/S · 5 S » (la casse vient du CSS). */
export function metaText(meta, kind) {
  if (!meta) return '';
  const parts = [];
  if (meta.w && meta.h) parts.push(`${meta.w}×${meta.h}`);
  if (kind === 'video') {
    if (meta.fps) parts.push(t('node.meta.fps', { n: num(meta.fps, 2) }));
    if (meta.duration) parts.push(fmtDur(meta.duration * 1000));
  }
  if (kind === 'audio') {
    if (meta.duration) parts.push(fmtDur(meta.duration * 1000));
    if (meta.sampleRate) parts.push(t('node.meta.khz', { n: num(meta.sampleRate / 1000, 1) }));
    if (meta.channels) parts.push(meta.channels === 1 ? t('node.meta.mono') : meta.channels === 2 ? t('node.meta.stereo') : t('node.meta.channels', { n: meta.channels }));
  }
  if (meta.alpha) parts.push(t('node.meta.alpha'));
  return parts.join(' · ');
}

/**
 * Action Explorateur / ouvrir / copier : le pont renvoie {ok:false, error} au
 * lieu de lever une erreur ; on le dit au lieu d'échouer en silence (et on ne
 * dit « copié » que si c'est vrai).
 * fn : 'reveal' | 'openPath' | 'copyPath'. Retourne true si ça a marché.
 */
export async function shellDo(fn, target, okMsg) {
  let r;
  try { r = await window.mia?.shell?.[fn]?.(target); } catch (err) { r = { ok: false, error: err?.message }; }
  if (r === undefined && !window.mia?.shell?.[fn]) r = { ok: false };
  if (r && r.ok === false) {
    toast(r.error || t('node.shell.failed'), { kind: 'error' });
    return false;
  }
  if (okMsg) toast(okMsg, { kind: 'ok' });
  return true;
}

/** Le fichier derrière cette URL mia:// a-t-il disparu ? (true = 404 sûr ; erreur réseau = on ne sait pas) */
export async function probeMissing(url) {
  if (!url || !/^mia:/i.test(url)) return false;
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return r.status === 404;
  } catch { return false; }
}

/**
 * « Extraire cette image » (SPEC §14) : pose à droite du bloc source un bloc
 * « Extraire une image » relié à cette sortie, réglé sur l'image f (0 = la
 * première), et le lance tout de suite (calcul léger, instantané).
 */
export function extractFrame(srcNodeId, port, f) {
  const ed = window.__mia?.editor;
  const src = ed?.getNode?.(srcNodeId);
  if (!ed || !src) return null;
  const w = src.w || 336;
  const NEW_W = 336;
  const NEW_H = 420;
  const graph = ed.getGraph?.() || { nodes: [], edges: [] };
  const rects = [];
  const cards = [];             // les blocs seuls : le fil du nouveau bloc ne doit passer sous aucun
  for (const n of graph.nodes || []) {
    if (n.id === srcNodeId) continue;
    const h = ed.nodeEl?.(n.id)?.offsetHeight || 240;
    rects.push({ x: n.x, y: n.y, w: n.w || 336, h });
    cards.push(rects[rects.length - 1]);
  }
  // Les fils qui sortent déjà de la source vers la droite comptent aussi : posé sur l'un d'eux,
  // le bloc semblait l'alimenter (le fil passait sous la carte et sortait de son en-tête). Leur
  // bande va du bord de la source à l'entrée de la cible, entre les deux hauteurs de pastille.
  const portY = (nodeId, p, dir) => {
    const dot = ed.nodeEl?.(nodeId)?.querySelector(`.n-port.${dir}[data-port="${CSS.escape(String(p))}"] .dot`);
    if (!dot) return null;
    const r = dot.getBoundingClientRect();
    if (!r.width) return null;
    return ed.screenToWorld?.({ x: r.left + r.width / 2, y: r.top + r.height / 2 })?.y ?? null;
  };
  for (const e of graph.edges || []) {
    if (e.from?.node !== srcNodeId) continue;
    const dst = (graph.nodes || []).find((n) => n.id === e.to?.node);
    if (!dst || dst.x <= src.x + w) continue;
    const y1 = portY(srcNodeId, e.from.port, 'out') ?? src.y + 60;
    const y2 = portY(dst.id, e.to.port, 'in') ?? dst.y + 60;
    rects.push({ x: src.x + w, y: Math.min(y1, y2) - 12, w: dst.x - (src.x + w), h: Math.abs(y2 - y1) + 24 });
  }
  // à droite, à la hauteur du bloc ; sinon la place libre la plus proche (plus bas,
  // ou une colonne plus loin) — jamais par-dessus un autre bloc, et jamais là où son propre
  // fil passerait sous une carte (il semblerait sortir d'elle) : on garde dégagé le couloir
  // entre la sortie de la source et l'entrée du nouveau bloc (≈ 240 px sous son haut)
  const x0 = Math.round(src.x + w + 72);
  const y0 = Math.round(src.y);
  const outY = portY(srcNodeId, port || 'out', 'out') ?? src.y + 60;
  const IN_DY = 240;
  const boxHit = (x, y) => rects.find((r) => x < r.x + r.w + 24 && x + NEW_W + 24 > r.x && y < r.y + r.h + 24 && y + NEW_H + 24 > r.y);
  const wireHit = (x, y) => {
    const cx0 = src.x + w + 8, cx1 = x - 8;
    if (cx1 <= cx0) return null;
    const cy0 = Math.min(outY, y + IN_DY) - 12, cy1 = Math.max(outY, y + IN_DY) + 12;
    return cards.find((r) => cx0 < r.x + r.w && cx1 > r.x && cy0 < r.y + r.h && cy1 > r.y) || null;
  };
  const hitAt = (x, y) => boxHit(x, y) || wireHit(x, y);
  // Un fil qui traverse une carte trompe (il semble sortir d'elle : « Vidéo guidée → Extraire »),
  // c'est pire qu'une place un peu plus loin : une telle place n'est prise que si aucune autre
  // n'existe à moins de 4 000 px (la caméra y va de toute façon si elle est hors champ).
  const CROSS = 4000;
  let best = null;
  const consider = (x, y, cross) => {
    if (boxHit(x, y)) return;
    const d = Math.hypot(x - x0, y - y0) + (cross ? CROSS : 0);
    if (!best || d < best.d) best = { x, y, d };
  };
  const scan = (x, test) => {
    let y = y0;
    for (let i = 0; i < 24; i++) { const hit = test(x, y); if (!hit) return y; y = Math.round(Math.max(y + 24, hit.y + hit.h + 32)); }
    return test(x, y) ? null : y;
  };
  for (let col = 0; col < 5; col++) {
    const x = x0 + col * (NEW_W + 56);
    const clear = scan(x, hitAt);
    if (clear != null) consider(x, clear, false);
    const free = scan(x, boxHit);
    if (free != null && free !== clear) consider(x, free, !!wireHit(x, free));
  }
  const at = best ? { x: best.x, y: best.y } : { x: x0, y: y0 };
  const id = ed.addNode?.('frame', at, { params: { at: Math.max(0, Math.round(f) || 0) } });
  if (!id) return null;
  const edge = ed.connect?.(srcNodeId, port || 'out', id, 'video');
  if (!edge) {
    toast(t('node.extract.failed'), { kind: 'error' });
    return id;
  }
  // hors champ : on y va doucement, sinon on reste où l'on est
  try {
    const p = ed.worldToScreen?.({ x: at.x + NEW_W / 2, y: at.y + 60 });
    const stage = document.getElementById('stage')?.getBoundingClientRect();
    if (p && stage && (p.x < 0 || p.y < 0 || p.x > stage.width || p.y > stage.height)) ed.focusNode?.(id);
  } catch { /* caméra indisponible */ }
  emit('node:run', { nodeId: id, mode: null });
  return id;
}

// ── budget vidéo de la planche ───────────────────────────────────────
// Chaque vidéo de puits s'inscrit ici. Un IntersectionObserver dit si elle est
// dans la vue ; un relevé léger toutes les 400 ms mesure sa largeur à l'écran
// (le zoom de la caméra ne déclenche pas l'observer).

const MIN_PX = 120;         // en dessous : poster, pas de décodage
const MAX_AUTOPLAY = 8;     // vidéos qui jouent seules en même temps
const UNLOAD_MS = 30000;    // hors champ depuis 30 s : on rend le décodeur

const slots = new Set();
const slotByEl = new WeakMap();
let pollTimer = 0;

const io = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      const s = slotByEl.get(e.target);
      if (!s) continue;
      s.inView = e.isIntersecting;
      s.px = e.boundingClientRect.width;
      if (!s.inView && !s.hiddenAt) s.hiddenAt = performance.now();
      if (s.inView) s.hiddenAt = 0;
      applySlot(s);
    }
  }, { rootMargin: '160px' })
  : null;

function playingCount() {
  let n = 0;
  for (const s of slots) if (!s.video.paused) n++;
  return n;
}

function poll() {
  if (document.hidden) return;
  for (const s of slots) {
    if (!s.inView) {
      if (s.loaded && s.hiddenAt && performance.now() - s.hiddenAt > UNLOAD_MS) unload(s);
      continue;
    }
    s.px = s.host.getBoundingClientRect().width;
    applySlot(s);
  }
}

function unload(s) {
  s.video.pause();
  s.video.removeAttribute('src');
  try { s.video.load(); } catch { /* rien */ }
  s.loaded = false;
  s.host.classList.add('use-poster');
}

function applySlot(s) {
  const want = s.inView && s.px >= MIN_PX && !document.hidden && !s.suspended;
  // Le poster ne remplace l'image que si le puits est petit (sinon la dernière
  // image décodée, plus juste, reste affichée).
  s.host.classList.toggle('use-poster', s.px < MIN_PX && !!s.poster);
  if (want) {
    if (!s.loaded) { s.video.src = s.src; s.loaded = true; }
    if (s.video.paused && !s.userPaused && s.autoplay && (s.userPlayed || playingCount() < MAX_AUTOPLAY)) {
      s.video.play().catch(() => { /* lecture refusée : on reste sur l'image */ });
    }
  } else if (!s.video.paused) {
    s.video.pause();
  }
}

function addSlot(s) {
  slots.add(s);
  slotByEl.set(s.host, s);
  if (io) io.observe(s.host);
  else { s.inView = true; s.px = 999; applySlot(s); }
  if (!pollTimer) pollTimer = setInterval(poll, 400);
}

function removeSlot(s) {
  slots.delete(s);
  if (io) io.unobserve(s.host);
  if (!slots.size && pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
}

document.addEventListener('visibilitychange', () => {
  for (const s of slots) applySlot(s);
});

/**
 * Confie une <video> au budget de la planche : elle ne joue que visible et
 * assez grande, se décharge après 30 s hors champ. `host` = l'élément mesuré
 * (un élément par vidéo : l'observer ne suit qu'une fois le même élément) ;
 * il reçoit la classe `use-poster` quand le poster remplace la vidéo.
 * Retour : le « slot » (userPaused / userPlayed modifiables) avec remove().
 */
export function trackVideo(host, video, { src, poster, autoplay = true } = {}) {
  const slot = {
    host, video, src, poster, loaded: false,
    inView: false, px: 0, autoplay, userPaused: false, userPlayed: false, hiddenAt: 0,
  };
  slot.remove = () => removeSlot(slot);
  addSlot(slot);
  return slot;
}

/** Met en pause toutes les vidéos de la planche (visionneuse ouverte, onglet quitté). */
export function pauseAllWells(paused = true) {
  for (const s of slots) {
    s.suspended = paused;
    if (paused) s.video.pause();
    else applySlot(s);
  }
  // les sons ne repartent jamais seuls : seulement au clic
  if (paused) for (const a of audios) a.pause();
}

// Les sons des blocs Média (bloc Son) : un seul joue à la fois.
const audios = new Set();
const AUDIO_RATIO = 3;      // bandeau de forme d'onde (même valeur que view.js, estimateHeight)

/** « 0:05 », « 1:20 », « 1:02:03 ». */
function clock(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = Math.floor(s % 60);
  const ss = String(r).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// ── puits vidéo actifs : clavier, sélection, clic droit (SPEC §14) ────
// Le lecteur d'un puits répond au clavier quand on le survole, ou quand son
// bloc est seul sélectionné : ← → (Maj ×10), Début, Fin, « , » « . ». Ce
// guetteur est posé au chargement du module, donc AVANT celui de l'éditeur :
// sur un bloc vidéo, les flèches avancent d'une image au lieu de pousser le bloc.

const wells = new Set();   // { root, isVideo(), arm() → lecteur|null, extract?(f) }

const boardShown = () => state.view !== 'home' && !document.getElementById('view-board')?.hidden;
const viewerShown = () => { const v = document.getElementById('viewer'); return !!(v && !v.hidden); };

function selectedIds() {
  try { return window.__mia?.editor?.selection?.() || []; } catch { return []; }
}

/** Le puits vidéo visé : celui sous la souris, sinon celui du seul bloc sélectionné. */
function activeWell() {
  for (const w of wells) if (w.isVideo() && w.root.isConnected && w.root.matches(':hover')) return w;
  const ids = selectedIds();
  if (ids.length !== 1) return null;
  for (const w of wells) {
    if (w.isVideo() && w.root.isConnected && w.root.closest('.node')?.dataset.id === ids[0]) return w;
  }
  return null;
}

const PLAYER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End', ',', '.']);
window.addEventListener('keydown', (e) => {
  if (!PLAYER_KEYS.has(e.key) || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (isTyping(e.target) || isMenuOpen() || isModalOpen() || viewerShown() || !boardShown()) return;
  const w = activeWell();
  const p = w?.arm();
  if (p && playerKey(p, e)) { e.preventDefault(); e.stopImmediatePropagation(); }
}, true);

// Un bloc sélectionné montre son lecteur (le CSS l'affiche, ici on le crée).
on('selection:changed', ({ ids } = {}) => {
  if (!ids?.length || ids.length > 3) return;
  for (const w of wells) {
    if (w.isVideo() && ids.includes(w.root.closest('.node')?.dataset.id)) w.arm();
  }
});

// Clic droit sur un puits vidéo : « Extraire cette image », « Copier le numéro d'image ».
// L'éditeur ouvre son menu au relâché ; le « contextmenu » qui suit le remplace
// (même geste, pas de glisser : un clic droit glissé reste un déplacement de planche).
let rightDown = null;
window.addEventListener('pointerdown', (e) => {
  rightDown = e.button === 2 ? { x: e.clientX, y: e.clientY } : null;
}, true);
window.addEventListener('contextmenu', (e) => {
  const rd = rightDown;
  rightDown = null;
  if (!rd || Math.hypot(e.clientX - rd.x, e.clientY - rd.y) > 5 || isTyping(e.target)) return;
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  if (!hit || hit.closest('.media-ctl')) return;
  let w = null;
  for (const x of wells) if (x.isVideo() && x.root.isConnected && x.root.contains(hit)) { w = x; break; }
  if (!w) return;
  const p = w.arm();
  if (!p) return;
  e.preventDefault();
  e.stopPropagation();
  // on fige l'image : celle qu'on voit est celle qu'on extrait
  p.step(0);
  const f = p.frame();
  openMenu([
    w.extract ? { label: t('player.extract'), icon: 'camera', action: () => w.extract(f) } : null,
    {
      label: t('node.frame.copy'), icon: 'copy',
      action: async () => {
        try { await navigator.clipboard.writeText(String(f)); toast(t('node.frame.copied', { f }), { kind: 'ok' }); }
        catch { toast(t('node.shell.failed'), { kind: 'error' }); }
      },
    },
  ], { x: e.clientX, y: e.clientY });
}, true);

// ── le puits ─────────────────────────────────────────────────────────

/**
 * Crée un puits de média.
 * opts : { onOpen(), onExtract(frame)?, onMissing()?, autoplay = true, controls = true, ratio = 16/9 }
 * Retour : { el, show(media), showLive(url), empty(spec), setTag(text), video(), player(), destroy() }
 * media = { url, poster?, kind:'image'|'video', meta?, alpha?, note? }
 * Le puits prend le ratio du média (SPEC §16) : plus étroit et centré pour un
 * média vertical, jamais rogné, 460 px de haut au plus.
 */
export function createWell(opts = {}) {
  const root = el('div', { class: 'nb-well' });
  const stage = el('div', { class: 'nb-well-stage' });
  const badge = el('div', { class: 'nb-badge' });
  const tag = el('div', { class: 'nb-tag', hidden: true });
  const liveChip = el('div', { class: 'nb-live' }, el('i'), el('span', {}, t('node.live')));
  root.append(stage, badge, tag, liveChip);
  setRatio(opts.ratio || 16 / 9);

  // Badge méta (au survol, à gauche) et étiquette (à droite) partagent le haut du puits : quand ils ne
  // tiennent pas côte à côte (puits vertical, anglais), l'étiquette s'efface le temps du survol au lieu
  // de passer sous le badge. Mesuré quand un texte ou la largeur du puits change, jamais en continu.
  function fitTop() {
    const w = root.clientWidth;
    if (!w) return;
    const clash = !badge.hidden && !tag.hidden && badge.textContent && tag.textContent
      && badge.scrollWidth + tag.offsetWidth + 6 + 12 > w;
    if (tag.classList.contains('yields') !== clash) tag.classList.toggle('yields', clash);
  }
  const topRO = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fitTop()) : null;
  topRO?.observe(root);

  let layer = null;        // couche affichée { el, key, slot?, player?, video?, media? }
  let destroyed = false;

  function setRatio(r) {
    const v = Math.min(Math.max(r || 16 / 9, 0.42), 3.2);
    root.style.setProperty('--ar', String(v));
  }

  // Double-clic : visionneuse plein écran (le simple clic reste à l'éditeur).
  root.addEventListener('dblclick', (e) => {
    if (e.target.closest('.media-ctl, .nb-link')) return;
    if (!layer || layer.kind === 'empty') return;
    e.stopPropagation();
    opts.onOpen?.();
  });

  /** Remplace la couche visible par `next` avec un fondu enchaîné. */
  function swap(next) {
    const prev = layer;
    layer = next;
    stage.append(next.el);
    if (prev) {
      // première image prête → fondu ; l'ancienne couche part après 240 ms
      requestAnimationFrame(() => next.el.classList.add('in'));
      setTimeout(() => dispose(prev), ms('fade') + 20);
    } else {
      next.el.classList.add('in', 'now');
    }
  }

  function dispose(l) {
    if (!l) return;
    if (l.slot) l.slot.remove();
    l.disarm?.();
    l.player?.destroy();
    if (l.video) { l.video.pause(); l.video.removeAttribute('src'); try { l.video.load(); } catch { /* rien */ } }
    if (l.audio) {
      audios.delete(l.audio);
      l.audio.pause(); l.audio.removeAttribute('src'); try { l.audio.load(); } catch { /* rien */ }
    }
    l.el.remove();
  }

  function show(media) {
    if (destroyed || !media || !media.url) return empty({});
    root.classList.remove('is-live', 'is-empty', 'is-missing');
    root.classList.toggle('alpha', !!(media.alpha || media.meta?.alpha));
    badge.textContent = media.badge ?? metaText(media.meta, media.kind);
    badge.hidden = !badge.textContent;
    fitTop();
    const key = `${media.kind}|${media.url}|${media.paused ? 'p' : ''}`;
    if (layer && layer.key === key) {          // même média : on garde la lecture en cours
      if (media.meta?.w && media.meta?.h) setRatio(media.meta.w / media.meta.h);
      return;
    }
    if (media.meta?.w && media.meta?.h) setRatio(media.meta.w / media.meta.h);
    swap(media.kind === 'video' ? videoLayer(media, key) : media.kind === 'audio' ? audioLayer(media, key) : imageLayer(media, key));
  }

  /** Un 404 sur le fichier = il a disparu du disque (pas « lecture impossible »). */
  function checkGone(url) {
    if (!opts.onMissing) return;
    probeMissing(url).then((gone) => { if (gone && !destroyed) opts.onMissing(); });
  }

  function imageLayer(media, key) {
    const img = el('img', { class: 'nb-media', draggable: 'false', decoding: 'async', alt: '' });
    const box = el('div', { class: 'nb-layer' }, img);
    img.onload = () => {
      if (!media.meta?.w && img.naturalWidth) setRatio(img.naturalWidth / img.naturalHeight);
    };
    img.onerror = () => {
      box.replaceChildren(emptyBlock({ title: t('node.media.imgBroken'), icon: 'warn' }));
      checkGone(media.url);
    };
    img.src = media.url;
    return { el: box, key, kind: 'image' };
  }

  /** Crée le lecteur du calque vidéo (au premier survol, à la sélection, au clavier). */
  function armPlayer(l) {
    if (!l || l.kind !== 'video' || opts.controls === false || destroyed) return null;
    if (l.player) return l.player;
    const m = l.media;
    l.player = attachPlayer(l.video, {
      mode: 'compact',
      fps: m.meta?.fps, frames: m.meta?.frames,
      onUserToggle: (playing) => { l.slot.userPaused = !playing; l.slot.userPlayed = playing; },
      onExtract: opts.onExtract ? (f) => opts.onExtract(f) : null,
    });
    root.append(l.player.el);
    return l.player;
  }

  function videoLayer(media, key) {
    const video = el('video', { class: 'nb-media', muted: true, loop: true, playsinline: true, preload: 'metadata' });
    video.muted = true;                        // l'attribut seul ne suffit pas pour l'autoplay
    video.loop = true;
    video.playsInline = true;
    if (media.poster) video.poster = media.poster;
    const poster = el('img', { class: 'nb-poster', draggable: 'false', alt: '' });
    if (media.poster) poster.src = media.poster;
    const box = el('div', { class: 'nb-layer' }, video, poster);
    const l = { el: box, key, kind: 'video', video, media };
    video.addEventListener('loadedmetadata', () => {
      if (!media.meta?.w && video.videoWidth) setRatio(video.videoWidth / video.videoHeight);
    });
    video.addEventListener('error', () => {
      if (!slot.loaded) return;                // src retiré volontairement (déchargement)
      // Pas lisible par Chromium : on garde le poster s'il existe, avec une note.
      const note = media.note || (media.pending ? t('node.media.preparing') : t('node.media.broken'));
      if (media.poster) {
        box.classList.add('use-poster');
        setTag(note);
      } else {
        box.replaceChildren(emptyBlock({ title: note, sub: media.pending ? '' : t('node.media.brokenSub'), icon: media.pending ? null : 'warn' }));
      }
      slot.remove();
      checkGone(media.url);
    });
    if (opts.controls !== false) {
      // Contrôles créés au premier survol : 20 vidéos = 20 barres inutiles sinon.
      const arm = () => {
        root.removeEventListener('pointerenter', arm);
        if (layer === l) armPlayer(l);
      };
      root.addEventListener('pointerenter', arm);
      l.disarm = () => root.removeEventListener('pointerenter', arm);
    }
    // la couche (et non le puits) est observée : pendant un fondu enchaîné entre deux
    // vidéos, chacune a son propre élément suivi par l'IntersectionObserver
    const slot = trackVideo(box, video, { src: media.url, poster: media.poster, autoplay: opts.autoplay !== false && !media.paused });
    l.slot = slot;
    return l;
  }

  /**
   * Un son : sa forme d'onde (PNG blanc sur transparent fait à l'import, posé en masque CSS : gris, la partie
   * écoutée plus claire), un bouton lecture et le temps. Cliquer ou glisser sur l'onde = aller à ce moment.
   * Rien ne joue tout seul ; un seul son à la fois.
   */
  function audioLayer(media, key) {
    setRatio(AUDIO_RATIO);
    const audio = el('audio', { preload: 'metadata' });
    const wave = el('div', { class: 'nb-wave' });
    const heard = el('div', { class: 'nb-wave nb-wave-heard' });
    const head = el('div', { class: 'nb-au-head' });
    const track = el('div', { class: 'nb-au-track media-ctl' }, wave, heard, head);
    if (media.poster) for (const w of [wave, heard]) w.style.setProperty('--wave', `url("${media.poster}")`);
    else track.classList.add('no-wave');
    const play = el('button', { class: 'nb-au-play media-ctl', html: icon('play', 14), 'data-tip': t('node.audio.play') });
    const time = el('span', { class: 'nb-au-time' });
    const box = el('div', { class: 'nb-layer nb-audio' }, track, el('div', { class: 'nb-au-bar' }, play, time));
    const total = () => (isFinite(audio.duration) && audio.duration > 0 ? audio.duration : media.meta?.duration || 0);
    const paint = () => {
      const d = total();
      const p = d ? Math.min(1, audio.currentTime / d) : 0;
      box.style.setProperty('--p', String(p));
      time.textContent = `${clock(audio.currentTime)} / ${clock(d)}`;
    };
    const setPlaying = (on) => {
      play.innerHTML = icon(on ? 'pause' : 'play', 14);
      play.dataset.tip = t(on ? 'node.audio.pause' : 'node.audio.play');
      box.classList.toggle('playing', on);
    };
    let raf = 0;
    const loop = () => { paint(); if (!audio.paused) raf = requestAnimationFrame(loop); };
    audio.addEventListener('play', () => {
      for (const a of audios) if (a !== audio) a.pause();
      setPlaying(true);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    });
    audio.addEventListener('pause', () => { setPlaying(false); cancelAnimationFrame(raf); paint(); });
    audio.addEventListener('ended', () => { audio.currentTime = 0; paint(); });
    audio.addEventListener('loadedmetadata', paint);
    audio.addEventListener('error', () => {
      if (!audio.getAttribute('src')) return;                 // src retiré volontairement (fermeture)
      setTag(t('node.audio.broken'));
      play.disabled = true;
      checkGone(media.url);
    });
    const stopEv = (e) => e.stopPropagation();
    play.addEventListener('pointerdown', stopEv);
    play.addEventListener('dblclick', stopEv);
    play.addEventListener('click', (e) => {
      e.stopPropagation();
      if (audio.paused) audio.play().catch(() => {});
      else audio.pause();
    });
    // aller à un moment : clic ou glisser sur l'onde (le bloc ne bouge pas)
    const seekAt = (e) => {
      const r = track.getBoundingClientRect();
      const d = total();
      if (!r.width || !d) return;
      audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d;
      paint();
    };
    track.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      track.setPointerCapture?.(e.pointerId);
      seekAt(e);
      const move = (ev) => seekAt(ev);
      const up = () => { track.removeEventListener('pointermove', move); track.removeEventListener('pointerup', up); track.removeEventListener('pointercancel', up); };
      track.addEventListener('pointermove', move);
      track.addEventListener('pointerup', up);
      track.addEventListener('pointercancel', up);
    });
    track.addEventListener('dblclick', stopEv);
    audio.src = media.url;
    audios.add(audio);
    paint();
    return { el: box, key, kind: 'audio', audio };
  }

  /** Dernière image reçue pendant un calcul (évènement engine « preview »). */
  function showLive(url) {
    if (destroyed || !url) return;
    root.classList.add('is-live');
    root.classList.remove('is-empty', 'alpha', 'is-missing');
    badge.hidden = true;
    const key = `live|${url}`;
    if (layer && layer.key === key) return;
    const img = el('img', { class: 'nb-media', draggable: 'false', alt: '' });
    const box = el('div', { class: 'nb-layer' }, img);
    img.onload = () => { if (img.naturalWidth) setRatio(img.naturalWidth / img.naturalHeight); };
    img.src = url;
    swap({ el: box, key, kind: 'live' });
  }

  /** État vide : { title, sub?, icon?, action?: {label, run}, ratio?, missing? } */
  function empty(spec = {}) {
    if (destroyed) return;
    root.classList.remove('is-live', 'alpha');
    root.classList.add('is-empty');
    root.classList.toggle('is-missing', !!spec.missing);
    badge.hidden = true;
    const key = `empty|${spec.title || ''}|${spec.sub || ''}|${spec.icon || ''}|${spec.action?.label || ''}`;
    if (spec.ratio) setRatio(spec.ratio);
    if (layer && layer.key === key) return;
    const box = el('div', { class: 'nb-layer' }, emptyBlock(spec));
    swap({ el: box, key, kind: 'empty' });
  }

  function setTag(text) {
    if (tag.textContent === (text || '')) return;
    tag.textContent = text || '';
    tag.hidden = !text;
    fitTop();
  }

  /** Va à l'image f de la vidéo affichée (même si elle n'est pas encore chargée). */
  function seek(f, fps) {
    const v = layer?.kind === 'video' ? layer.video : null;
    if (!v) return;
    const go = () => { v.currentTime = (Math.max(0, f) + 0.5) / (fps || 24); };
    if (!v.paused) v.pause();
    if (v.readyState >= 1) go();
    else v.addEventListener('loadedmetadata', go, { once: true });
  }

  const entry = {
    root,
    isVideo: () => layer?.kind === 'video',
    arm: () => armPlayer(layer),
    extract: opts.onExtract ? (f) => opts.onExtract(f) : null,
  };
  wells.add(entry);

  return {
    el: root,
    show, showLive, empty, setTag, setRatio, seek,
    /** La vidéo affichée (ou null) — pour le défilement image par image. */
    video: () => (layer && layer.kind === 'video' ? layer.video : null),
    /** Le lecteur de la vidéo affichée (créé à la demande) ou null. */
    player: () => armPlayer(layer),
    kind: () => layer?.kind || null,
    destroy() {
      destroyed = true;
      topRO?.disconnect();
      wells.delete(entry);
      dispose(layer);
      layer = null;
      root.remove();
    },
  };
}

/** Bloc d'état vide centré (titre + sous-titre + action facultative). */
export function emptyBlock({ title, sub, icon: ico, action } = {}) {
  return el('div', { class: 'nb-empty' },
    ico ? el('span', { class: 'nb-empty-ico', html: icon(ico, 18) }) : null,
    title ? el('div', { class: 'nb-empty-title' }, title) : null,
    sub ? el('div', { class: 'nb-empty-sub' }, sub) : null,
    action ? el('button', {
      class: 'nb-link', onclick: (e) => { e.stopPropagation(); action.run(); },
      onpointerdown: (e) => e.stopPropagation(),
    }, action.label) : null,
  );
}
