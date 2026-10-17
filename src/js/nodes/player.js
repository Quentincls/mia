// ── Lecteur vidéo de précision (SPEC §14) ────────────────────────────
// La pastille .media-ctl de Slate, au survol d'un puits (mode « compact »)
// et dans la visionneuse (mode « full » : boucle en plus). Quentin veut savoir
// QUELLE image et QUELLE seconde il regarde, pour savoir où modifier :
// - compteur mono cliquable : « IMG 48 / 120 » → « 2,000 S / 5,000 S » →
//   « 00:00:02:00 » (unité gardée dans prefs.playerUnit) ; images numérotées
//   à partir de 0, comme les fichiers exportés (f0048) et les outils du labo ;
// - image par image exacte : on vise le MILIEU de l'image ((f + 0,5) / fps,
//   tech.md §6.4) et requestVideoFrameCallback donne l'image réellement
//   affichée. Jamais de fastSeek (inexact), jamais d'input natif ;
// - vitesse ×0,25 · ×0,5 · ×1 · ×2 (son coupé sous ×1) ;
// - « Extraire cette image » (appareil photo) quand le propriétaire le permet.
// Glisser sur la barre montre l'image ET son numéro sous le curseur.

import { replayClass } from '../ui/motion.js';
import { t, lang } from '../i18n.js';
import { icon, register as registerIcons, hasIcon } from '../icons.js';
import { el, clamp } from '../util.js';
import { state } from '../state.js';
import { on, emit } from '../bus.js';
import { openMenu } from '../ui/menu.js';
import { strings } from './media.js';

strings({
  'player.play': 'Lecture',
  'player.pause': 'Pause',
  'player.prev': 'Image précédente (←)',
  'player.next': 'Image suivante (→)',
  'player.loop': 'Lecture en boucle',
  'player.mute': 'Couper le son',
  'player.unmute': 'Activer le son',
  'player.frameLabel': 'img',
  'player.frames': 'img {f} / {n}',
  'player.seconds': '{s} s / {d} s',
  'player.countTip': 'Image {f} · {s} s · cadence {fps} i/s — clic : changer d’unité',
  'player.speed': 'Vitesse ( , plus lent · . plus vite)',
  'player.speedMuted': 'Le son est coupé sous ×1.',
  'player.extract': 'Extraire cette image',
  'player.extractTip': 'Extraire cette image (crée un bloc « Extraire une image » réglé ici)',
}, {
  'player.play': 'Play',
  'player.pause': 'Pause',
  'player.prev': 'Previous frame (←)',
  'player.next': 'Next frame (→)',
  'player.loop': 'Loop playback',
  'player.mute': 'Mute',
  'player.unmute': 'Unmute',
  'player.frameLabel': 'frame',
  'player.frames': 'frame {f} / {n}',
  'player.seconds': '{s} s / {d} s',
  'player.countTip': 'Frame {f} · {s} s · {fps} fps — click: change unit',
  'player.speed': 'Speed ( , slower · . faster)',
  'player.speedMuted': 'Sound is off below ×1.',
  'player.extract': 'Extract this frame',
  'player.extractTip': 'Extract this frame (adds an “Extract a frame” block set here)',
});

// appareil photo (trait 1,7, grille 24 — style Slate), seulement s'il manque
if (!hasIcon('camera')) {
  registerIcons({
    camera: '<path d="M4.5 8.2a1.7 1.7 0 0 1 1.7-1.7h1.9l1.3-2h5.2l1.3 2h1.9a1.7 1.7 0 0 1 1.7 1.7v8.6a1.7 1.7 0 0 1-1.7 1.7H6.2a1.7 1.7 0 0 1-1.7-1.7z"/><circle cx="12" cy="12.4" r="3.2"/>',
  });
}

/**
 * Change le texte d'un élément sans remplacer son nœud texte. `textContent =` retire et insère un
 * nœud : une mutation de structure qui, avec les :has() de la page (queue.css), restylait toute la
 * planche (≈ 7 ms par écriture, mesuré) ; changer `data` coûte dix fois moins.
 */
function setText(el, s) {
  const f = el.firstChild;
  if (f && f.nodeType === 3 && !f.nextSibling) { if (f.data !== s) f.data = s; }
  else if (el.textContent !== s) el.textContent = s;
}

export const SPEEDS = [0.25, 0.5, 1, 2];
const UNITS = ['frames', 'seconds', 'timecode'];

// ── unité du compteur (partagée par tous les lecteurs, gardée dans les prefs) ──
const alive = new Set();          // refresh() de chaque lecteur monté
const unitNow = () => (UNITS.includes(state.prefs?.playerUnit) ? state.prefs.playerUnit : 'frames');

function cycleUnit() {
  const next = UNITS[(UNITS.indexOf(unitNow()) + 1) % UNITS.length];
  state.prefs = { ...(state.prefs || {}), playerUnit: next };
  try { window.mia?.prefs?.set?.({ playerUnit: next })?.catch?.(() => {}); } catch { /* pont absent */ }
  emit('prefs:changed', { prefs: state.prefs, patch: { playerUnit: next } });
}
on('prefs:changed', () => { for (const fn of alive) fn(); });

// ── formats ──────────────────────────────────────────────────────────

const nf = (digits) => new Intl.NumberFormat(lang() === 'en' ? 'en-US' : 'fr-FR', {
  minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false,
});
const fmtSec = (s) => nf(3).format(Math.max(0, s));
const fmtNum = (v) => new Intl.NumberFormat(lang() === 'en' ? 'en-US' : 'fr-FR', { maximumFractionDigits: 3 }).format(v);

/** « 00:00:02:00 » à la cadence nominale de la vidéo (non drop-frame). */
export function timecode(f, fps) {
  const R = Math.max(1, Math.round(fps || 24));
  const ff = f % R;
  const tot = Math.floor(f / R);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(Math.floor(tot / 3600))}:${p2(Math.floor(tot / 60) % 60)}:${p2(tot % 60)}:${p2(ff)}`;
}

/** Texte du compteur pour l'image f (0 = première) sur n images. */
export function counterText(f, n, fps, unit = unitNow()) {
  if (unit === 'seconds') return t('player.seconds', { s: fmtSec(f / (fps || 24)), d: fmtSec(n / (fps || 24)) });
  if (unit === 'timecode') return timecode(f, fps);
  return t('player.frames', { f, n });
}

/** « ×0,25 », « ×1 » : une seule notation, au bouton comme dans son menu. */
export const speedLabel = (r) => `×${fmtNum(r)}`;

/** « 1:05 » — minutes:secondes (gardé pour les autres modules). */
export function fmtClockTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

/** Va au milieu de l'image f : aucune ambiguïté d'arrondi vers la précédente. */
export function seekFrame(video, f, fps) {
  video.currentTime = (Math.max(0, f) + 0.5) / (fps || 24);
}

/**
 * Accroche une barre de contrôle à une <video>.
 * opts : { mode:'compact'|'full', fps?, frames?, onUserToggle(playing)?, onFrame(f)?, onExtract(f)? }
 * Retour : { el, refresh(), step(n), seek(f), toggle(), frame(), total(), fps(),
 *            setSpeed(r), speedStep(±1), setMeta({fps, frames}), destroy() }
 */
export function attachPlayer(video, opts = {}) {
  const full = opts.mode === 'full';
  let fps = opts.fps || 24;
  let frames = opts.frames || 0;
  let frame = 0;             // image affichée (rVFC si dispo, sinon currentTime)
  let dragging = false;
  let wasPlaying = false;
  let rvfc = 0;
  let raf = 0;
  let live = true;
  let mutedBySpeed = false;  // le son a été coupé par un ralenti (on le rend en revenant à ×1)

  const mk = (name, tipKey, onclick, cls = '') => {
    const b = el('button', { class: `pl-btn ${cls}`, 'data-tip': t(tipKey), html: icon(name, 16) });
    b.addEventListener('click', (e) => { e.stopPropagation(); onclick(e); });
    return b;
  };

  const bPlay = mk('play', 'player.play', () => toggle(true), 'pl-play');
  // image par image partout ; dans un puits étroit, le CSS les range (requête de conteneur)
  const bPrev = mk('step-back', 'player.prev', () => step(-1), 'pl-step');
  const bNext = mk('step-fwd', 'player.next', () => step(1), 'pl-step');
  const fill = el('div', { class: 'pl-fill' });
  // Le pouce glisse par transform (jamais `left` : une mise en page à chaque image) ;
  // son porteur, sans taille, est déplacé de la largeur de piste gardée en cache.
  const thumb = el('div', { class: 'pl-thumb' });
  const knob = el('div', { class: 'pl-knob' }, thumb);
  const rail = el('div', { class: 'pl-rail' }, fill, knob);
  const hint = el('span', { class: 'pl-hint', hidden: true });
  const track = el('div', { class: 'pl-track' }, rail, hint);
  const count = el('button', { class: 'pl-count' });
  count.addEventListener('click', (e) => { e.stopPropagation(); cycleUnit(); });
  // l'infobulle n'est écrite qu'au survol du compteur (l'image change pendant la lecture) :
  // la formater à chaque image coûtait cher pour un texte que personne ne lit
  count.dataset.tip = '';
  let countHover = false;
  count.addEventListener('pointerenter', () => { countHover = true; count.dataset.tip = countTip(); });
  count.addEventListener('pointerleave', () => { countHover = false; });
  // largeur de la piste, lue par l'observateur (après la mise en page, sans la forcer)
  let railW = 0;
  const railRO = typeof ResizeObserver === 'function'
    ? new ResizeObserver((ents) => { railW = ents[0]?.contentRect?.width || 0; lastKnob = ''; refresh(); })
    : null;
  railRO?.observe(rail);
  const bSpeed = el('button', { class: 'pl-speed', 'data-tip': t('player.speed') }, speedLabel(1));
  bSpeed.addEventListener('click', (e) => { e.stopPropagation(); openSpeedMenu(); });
  const bSnap = opts.onExtract ? mk('camera', 'player.extractTip', () => extract(), 'pl-snap') : null;
  const bLoop = full ? mk('loop', 'player.loop', () => { video.loop = !video.loop; refresh(); }, 'pl-loop') : null;
  const bMute = mk(video.muted ? 'mute' : 'sound', 'player.unmute', () => {
    video.muted = !video.muted;
    mutedBySpeed = false;
    if (!video.muted && video.volume === 0) video.volume = 1;
    refresh();
  }, 'pl-mute');

  const root = el('div', { class: `media-ctl pl ${full ? 'pl-full' : 'pl-compact'}` },
    bPlay, bPrev, bNext, track, count, bSpeed, bSnap, bLoop, bMute);

  // ── place dans la pastille compacte (puits d'une carte) ──────────────
  // Le compteur réserve la largeur de son texte le plus long pour CETTE vidéo et cette unité (police
  // mono : un signe = 1ch) : il ne pousse plus rien quand il s'allonge. Puis, tant que la piste
  // n'aurait pas ses 60 px, les boutons facultatifs se rangent dans l'ordre : vitesse, son, pas à pas,
  // appareil photo, et en dernier le compteur (les raccourcis clavier restent). La pastille a la largeur
  // du puits (position absolue) : ce qu'on range ne change pas sa taille, pas de boucle.
  const TRACK_MIN = 60;
  const OPTIONAL = [['pl-no-speed', [bSpeed]], ['pl-no-mute', [bMute]], ['pl-no-step', [bPrev, bNext]],
    ['pl-no-snap', [bSnap].filter(Boolean)], ['pl-no-count', [count]]];
  let reserveSig = '';
  function reserve(n) {
    if (full) return;
    const sig = `${unitNow()}|${n}|${fps}|${lang()}`;
    if (sig === reserveSig) return;
    reserveSig = sig;
    const len = counterText(Math.max(0, n - 1), n, fps).length;
    count.style.width = `calc(${len} * (1ch + .03em) + 8px)`;
    fit();
  }
  function fit() {
    if (full) return;
    const room = root.clientWidth;
    if (!room) return;
    for (const [cls] of OPTIONAL) root.classList.remove(cls);
    const cs = getComputedStyle(root);
    const gap = parseFloat(cs.columnGap) || 0;
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const kids = [...root.children].filter((k) => k !== track && k.offsetWidth > 0);
    const w = new Map(kids.map((k) => [k, k.offsetWidth]));
    let shownN = kids.length + 1;
    let need = pad + TRACK_MIN + [...w.values()].reduce((a, b) => a + b, 0) + gap * (shownN - 1);
    for (const [cls, els] of OPTIONAL) {
      if (need <= room) break;
      const live = els.filter((k) => w.has(k));
      if (!live.length) continue;
      root.classList.add(cls);
      for (const k of live) { need -= w.get(k) + gap; shownN -= 1; }
    }
  }
  const fitRO = !full && typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
  fitRO?.observe(root);

  // La barre ne doit jamais déclencher un glisser de bloc ni la visionneuse.
  for (const ev of ['pointerdown', 'dblclick', 'contextmenu']) {
    root.addEventListener(ev, (e) => e.stopPropagation());
  }

  // ── état ────────────────────────────────────────────────────────────
  const total = () => frames || Math.max(1, Math.round((video.duration || 0) * fps));

  function readFrame() {
    return clamp(Math.floor(video.currentTime * fps + 1e-4), 0, total() - 1);
  }

  function countTip() {
    return t('player.countTip', { f: frame, s: fmtSec(frame / fps), fps: fmtNum(fps) });
  }

  // Les contrôles sont-ils à l'écran ? Dans une carte, la pastille n'apparaît qu'au survol
  // du puits ou quand le bloc est choisi (nodes.css) ; hors champ (.off) ou en vue lointaine
  // (lod-2/3), elle est cachée. Une vidéo qui joue seule n'a alors rien à rafraîchir.
  let card;          // la carte qui porte ce lecteur (null dans la visionneuse)
  let world = null;
  function shown() {
    if (dragging) return true;
    if (card === undefined) {
      card = root.isConnected ? root.closest('.node') : undefined;
      if (card) world = card.closest('#world');
      if (card === undefined) return true;        // pas encore posé : on ne sait pas, on peint
    }
    if (!card) return true;
    if (card.classList.contains('off')) return false;
    if (world && (world.classList.contains('lod-2') || world.classList.contains('lod-3'))) return false;
    if (card.classList.contains('sel')) return true;
    return !!root.parentElement?.matches(':hover');
  }

  let lastSig = '';
  let lastFill = '';
  let lastKnob = '';
  let lastTickAt = 0;
  /**
   * `tick` : appelé à chaque image vidéo (lecture). Dans une carte, sauté si les contrôles ne se
   * voient pas, et limité à 10 relevés par seconde quand ils se voient (4 sur un bloc choisi qui
   * joue sans être survolé) : chaque écriture dans une carte repeint la planche entière (≈ 5 ms de
   * mise en couches par image sur Banc 100, mesuré). Une transition entre deux relevés coûtait
   * plus cher que les relevés eux-mêmes (animation tenue par le fil principal). La visionneuse,
   * hors planche, suit chaque image. Pause, pas à pas, glisser : exact et immédiat (sans `tick`).
   */
  function refresh(tick = false) {
    if (!live) return;
    if (tick === true) {
      if (!shown()) return;
      if (card && !dragging) {
        const now = performance.now();
        const hover = countHover || !!root.parentElement?.matches(':hover');
        if (now - lastTickAt < (hover ? 96 : 240)) return;
        lastTickAt = now;
      }
    }
    const playing = !video.paused && !video.ended;
    const sig = `${playing}|${video.muted}|${video.loop}|${video.playbackRate}`;
    if (sig !== lastSig) {
      // lecture ↔ pause : l'icône se transforme (fondu + échelle), pas un simple échange
      const was = lastSig ? lastSig.startsWith('true') : playing;
      lastSig = sig;
      bPlay.innerHTML = icon(playing ? 'pause' : 'play', 16);
      if (was !== playing) replayClass(bPlay, 'pl-morph');
      bPlay.dataset.tip = t(playing ? 'player.pause' : 'player.play');
      bMute.innerHTML = icon(video.muted ? 'mute' : 'sound', 16);
      bMute.dataset.tip = video.playbackRate < 1 && video.muted ? t('player.speedMuted') : t(video.muted ? 'player.unmute' : 'player.mute');
      bLoop?.classList.toggle('on', video.loop);
      setText(bSpeed, speedLabel(video.playbackRate || 1));
      bSpeed.classList.toggle('on', (video.playbackRate || 1) !== 1);
    }
    const n = total();
    reserve(n);
    const p = dragging || video.paused ? (n > 1 ? frame / (n - 1) : 0)
      : (video.duration ? clamp(video.currentTime / video.duration, 0, 1) : 0);
    const fs = `scaleX(${Math.round(p * 1e4) / 1e4})`;
    if (fs !== lastFill) { lastFill = fs; fill.style.transform = fs; }
    const ks = `translateX(${Math.round(p * railW * 10) / 10}px)`;
    if (ks !== lastKnob) { lastKnob = ks; knob.style.transform = ks; }
    setText(count, counterText(frame, n, fps));
    if (countHover) count.dataset.tip = countTip();
  }
  const onPrefs = () => refresh();
  alive.add(onPrefs);

  // Boucle d'affichage pendant la lecture : rVFC donne l'image exacte.
  function loop() {
    if (!live) return;
    if (typeof video.requestVideoFrameCallback === 'function') {
      rvfc = video.requestVideoFrameCallback((_now, md) => {
        frame = clamp(Math.round(md.mediaTime * fps), 0, total() - 1);
        opts.onFrame?.(frame);
        refresh(true);
        if (!video.paused) loop();
      });
    } else {
      raf = requestAnimationFrame(() => {
        frame = readFrame();
        refresh(true);
        if (!video.paused) loop();
      });
    }
  }

  const onPlay = () => { refresh(); loop(); };
  const onSeeked = () => { if (!dragging) frame = readFrame(); opts.onFrame?.(frame); refresh(); };
  // timeupdate (4 fois par seconde) : en lecture, la boucle d'images s'en charge déjà
  const onTime = () => { if (video.paused && !dragging) { frame = readFrame(); refresh(); } else refresh(true); };
  const onRate = () => refresh();
  video.addEventListener('play', onPlay);
  video.addEventListener('pause', refresh);
  video.addEventListener('ended', refresh);
  video.addEventListener('seeked', onSeeked);
  video.addEventListener('timeupdate', onTime);
  video.addEventListener('loadedmetadata', onTime);
  video.addEventListener('volumechange', refresh);
  video.addEventListener('ratechange', onRate);

  // ── actions ─────────────────────────────────────────────────────────
  function toggle(user = false) {
    // On note l'intention avant l'appel : play() est asynchrone.
    const wantPlay = video.paused;
    if (wantPlay) video.play().catch(() => {});
    else video.pause();
    if (user) opts.onUserToggle?.(wantPlay);
    refresh();
  }

  function seek(f) {
    frame = clamp(Math.round(f), 0, total() - 1);
    seekFrame(video, frame, fps);
    refresh();
  }

  function step(n) {
    if (!video.paused) { video.pause(); frame = readFrame(); }
    seek(frame + n);
    // le compteur accuse le pas : un petit glissement dans le sens de l'image
    count.style.setProperty('--pl-dx', n > 0 ? '3px' : '-3px');
    replayClass(count, 'pl-tick');
    opts.onUserToggle?.(false);
  }

  function setSpeed(r) {
    const rate = SPEEDS.includes(r) ? r : 1;
    video.playbackRate = rate;
    // le son est coupé sous ×1 ; on le rend en revenant à ×1 si c'est nous qui l'avions coupé
    if (rate < 1 && !video.muted) { video.muted = true; mutedBySpeed = true; }
    else if (rate >= 1 && mutedBySpeed) { video.muted = false; mutedBySpeed = false; }
    refresh();
  }

  function speedStep(dir) {
    const i = SPEEDS.indexOf(video.playbackRate);
    const cur = i < 0 ? SPEEDS.indexOf(1) : i;
    setSpeed(SPEEDS[clamp(cur + dir, 0, SPEEDS.length - 1)]);
    replayClass(bSpeed, 'pl-pop');
  }

  function openSpeedMenu() {
    const cur = video.playbackRate || 1;
    openMenu(SPEEDS.map((r) => ({
      label: speedLabel(r), icon: r === cur ? 'check' : undefined, action: () => { setSpeed(r); replayClass(bSpeed, 'pl-pop'); },
    })), bSpeed);
  }

  function extract() {
    if (!video.paused) { video.pause(); frame = readFrame(); opts.onUserToggle?.(false); }
    opts.onExtract?.(frame);
  }

  // ── défilement à la souris : l'image ET son numéro sous le curseur ─────
  function frameAtX(clientX) {
    const r = rail.getBoundingClientRect();
    const frac = clamp((clientX - r.left) / Math.max(1, r.width), 0, 1);
    return { f: Math.round(frac * (total() - 1)), frac };
  }
  function showHint(clientX) {
    const { f, frac } = frameAtX(clientX);
    hint.hidden = false;
    setText(hint, counterText(f, total(), fps).split(' / ')[0]);
    hint.style.left = `${frac * 100}%`;
    return f;
  }
  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    wasPlaying = !video.paused;
    if (wasPlaying) video.pause();
    try { track.setPointerCapture(e.pointerId); } catch { /* pointeur déjà relâché */ }
    root.classList.add('scrubbing');
    seek(showHint(e.clientX));
  });
  track.addEventListener('pointermove', (e) => {
    const f = showHint(e.clientX);
    if (dragging && f !== frame) seek(f);
  });
  track.addEventListener('pointerleave', () => { if (!dragging) hint.hidden = true; });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove('scrubbing');
    hint.hidden = true;
    try { track.releasePointerCapture(e.pointerId); } catch { /* déjà relâché */ }
    if (wasPlaying) video.play().catch(() => {});
  };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);

  refresh();
  if (!video.paused) loop();

  return {
    el: root,
    video,
    refresh,
    toggle,
    seek,
    step,
    setSpeed,
    speedStep,
    extract: opts.onExtract ? extract : null,
    frame: () => frame,
    total,
    fps: () => fps,
    setMeta(m = {}) { if (m.fps) fps = m.fps; if (m.frames) frames = m.frames; refresh(); },
    destroy() {
      live = false;
      alive.delete(onPrefs);
      railRO?.disconnect();
      fitRO?.disconnect();
      if (rvfc && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(rvfc);
      if (raf) cancelAnimationFrame(raf);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', refresh);
      video.removeEventListener('ended', refresh);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('loadedmetadata', onTime);
      video.removeEventListener('volumechange', refresh);
      video.removeEventListener('ratechange', onRate);
      root.remove();
    },
  };
}

/**
 * Raccourcis d'un lecteur : ← → (Maj ×10), Début, Fin, « , » plus lent,
 * « . » plus vite. Renvoie true si la touche a servi. (Se fier à `e.key` :
 * pas de conflit AZERTY.)
 */
export function playerKey(p, e) {
  if (!p || e.ctrlKey || e.metaKey || e.altKey) return false;
  switch (e.key) {
    case 'ArrowLeft': p.step(e.shiftKey ? -10 : -1); return true;
    case 'ArrowRight': p.step(e.shiftKey ? 10 : 1); return true;
    case 'Home': p.seek(0); return true;
    case 'End': p.seek(p.total() - 1); return true;
    case ',': p.speedStep(-1); return true;
    case '.': p.speedStep(1); return true;
    default: return false;
  }
}
