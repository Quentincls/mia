// ── Comparaison A/B ──────────────────────────────────────────────────
// Le geste le plus parlant pour « vulgariser » (da.md §4.2) : Quentin juge
// ses résultats en côte à côte avec la source (usage.md §2). Trois vues :
// - Volet : B par-dessus A, découpé par un trait vertical de 1 px et une
//   poignée ronde de 14 px qu'on fait glisser ;
// - Côte à côte ;
// - Différence : un canevas qui dessine A puis B en mode « difference »
//   (ce qui n'a pas bougé devient noir).
// Deux vidéos sont lues EN MÊME TEMPS : A mène, B suit (lecture, pause,
// position) avec une correction de dérive à chaque image affichée.
// Utilisé par le bloc « Comparer A/B » et par la visionneuse (avant/après).

import { t } from '../i18n.js';
import { el, clamp } from '../util.js';
import { attachPlayer } from './player.js';
import { strings, emptyBlock, trackVideo, metaText } from './media.js';

strings({
  'node.cmp.a': 'A',
  'node.cmp.b': 'B',
  'node.cmp.needBoth': 'Branche deux images ou vidéos',
  'node.cmp.needBothSub': 'A à gauche, B à droite. Elles se liront en même temps.',
  'node.cmp.needA': 'Branche A pour comparer',
  'node.cmp.needB': 'Branche B pour comparer',
  'node.cmp.notReadySide': '{side} n’est pas encore calculé',
}, {
  'node.cmp.a': 'A',
  'node.cmp.b': 'B',
  'node.cmp.needBoth': 'Connect two images or videos',
  'node.cmp.needBothSub': 'A on the left, B on the right. They play together.',
  'node.cmp.needA': 'Connect A to compare',
  'node.cmp.needB': 'Connect B to compare',
  'node.cmp.notReadySide': '{side} is not computed yet',
});

/**
 * Monte une comparaison.
 * opts : { mode:'slider'|'side'|'diff', full?:bool (visionneuse), labels?:[a,b], onOpen?(), controls?:bool }
 * Retour : { el, set(a, b), setMode(m), master():video|null, destroy() }
 * a / b : { url, kind:'image'|'video', poster?, meta? } | null
 */
export function mountCompare(host, opts = {}) {
  let mode = opts.mode || 'slider';
  let pos = 0.5;                   // position du volet (0..1)
  let A = null, B = null;          // sources
  let la = null, lb = null;        // éléments affichés (img / video)
  let player = null;
  let slot = null;
  let rvfc = 0;
  let alive = true;
  let lastSig = null;
  const labels = opts.labels || [t('node.cmp.a'), t('node.cmp.b')];

  const layerA = el('div', { class: 'cmp-layer cmp-a' });
  const layerB = el('div', { class: 'cmp-layer cmp-b' });
  const canvas = el('canvas', { class: 'cmp-diff' });
  const line = el('div', { class: 'cmp-line' }, el('div', { class: 'cmp-handle' }));
  const labA = el('span', { class: 'cmp-lab cmp-lab-a' }, labels[0]);
  const labB = el('span', { class: 'cmp-lab cmp-lab-b' }, labels[1]);
  const empty = el('div', { class: 'cmp-empty' });
  const stage = el('div', { class: 'cmp-stage' }, layerA, layerB, canvas, line, labA, labB, empty);
  const root = el('div', { class: `cmp${opts.full ? ' cmp-full' : ''}`, 'data-mode': mode }, stage);
  host.append(root);

  // ── volet ───────────────────────────────────────────────────────────
  function paintWipe() {
    root.style.setProperty('--wipe', `${pos * 100}%`);
  }
  paintWipe();

  let dragging = false;
  const wipeAt = (e) => {
    const r = stage.getBoundingClientRect();
    pos = clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1);
    paintWipe();
  };
  // Dans un bloc, seul le trait se saisit (le reste du média déplace le bloc) ;
  // en plein écran, toute l'image sert de poignée.
  const grabTarget = opts.full ? stage : line;
  grabTarget.addEventListener('pointerdown', (e) => {
    if (mode !== 'slider' || e.button !== 0) return;
    if (e.target.closest('.media-ctl')) return;
    e.stopPropagation();
    e.preventDefault();
    dragging = true;
    try { grabTarget.setPointerCapture(e.pointerId); } catch { /* pointeur déjà relâché */ }
    root.classList.add('dragging');
    wipeAt(e);
  });
  grabTarget.addEventListener('pointermove', (e) => { if (dragging) wipeAt(e); });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove('dragging');
    try { grabTarget.releasePointerCapture(e.pointerId); } catch { /* rien */ }
  };
  grabTarget.addEventListener('pointerup', endDrag);
  grabTarget.addEventListener('pointercancel', endDrag);

  stage.addEventListener('dblclick', (e) => {
    if (e.target.closest('.media-ctl, .cmp-line')) return;
    if (!opts.onOpen || (!A && !B)) return;
    e.stopPropagation();
    opts.onOpen();
  });

  // ── médias ──────────────────────────────────────────────────────────
  function makeMedia(src) {
    if (src.kind === 'video') {
      const v = el('video', { class: 'cmp-media', muted: true, loop: true, playsinline: true, preload: 'auto' });
      v.muted = true; v.loop = true; v.playsInline = true;
      if (src.poster) v.poster = src.poster;
      return v;
    }
    const img = el('img', { class: 'cmp-media', draggable: 'false', alt: '', decoding: 'async' });
    img.src = src.url;
    return img;
  }

  const isVideo = (x) => x && x.tagName === 'VIDEO';
  const master = () => (isVideo(la) ? la : isVideo(lb) ? lb : null);
  const follower = () => (isVideo(la) && isVideo(lb) ? lb : null);

  function teardown() {
    if (rvfc && master()?.cancelVideoFrameCallback) master().cancelVideoFrameCallback(rvfc);
    rvfc = 0;
    player?.destroy(); player = null;
    slot?.remove(); slot = null;
    for (const m of [la, lb]) {
      if (isVideo(m)) { m.pause(); m.removeAttribute('src'); try { m.load(); } catch { /* rien */ } }
    }
    layerA.replaceChildren(); layerB.replaceChildren();
    la = lb = null;
  }

  function setRatio() {
    const meta = A?.meta || B?.meta;
    let r = meta?.w && meta?.h ? meta.w / meta.h : 16 / 9;
    const mA = isVideo(la) ? [la.videoWidth, la.videoHeight] : la?.naturalWidth ? [la.naturalWidth, la.naturalHeight] : null;
    if (!meta?.w && mA && mA[0]) r = mA[0] / mA[1];
    r = clamp(r, 0.42, 3.2);
    root.style.setProperty('--ar', String(mode === 'side' ? r * 2 : r));
  }

  function set(a, b) {
    const key = (x) => `${x?.url || ''}|${x?.kind || ''}|${x?.pending ? 1 : 0}`;
    const sig = `${key(a)}#${key(b)}`;
    if (sig === lastSig) return;
    lastSig = sig;
    teardown();
    A = a?.url ? a : null;
    B = b?.url ? b : null;
    root.classList.toggle('has-a', !!A);
    root.classList.toggle('has-b', !!B);
    root.classList.toggle('alpha', !!(A?.meta?.alpha || B?.meta?.alpha));

    // un côté branché mais pas encore calculé arrive avec { pending: true }
    if (!A && !B && !a?.pending && !b?.pending) {
      empty.replaceChildren(emptyBlock({ title: t('node.cmp.needBoth'), sub: t('node.cmp.needBothSub') }));
    } else if (!A || !B) {
      const side = !A ? a : b;
      const title = side?.pending ? t('node.cmp.notReadySide', { side: !A ? labels[0] : labels[1] })
        : (!A ? t('node.cmp.needA') : t('node.cmp.needB'));
      empty.replaceChildren(emptyBlock({ title }));
    } else {
      empty.replaceChildren();
    }
    labA.dataset.tip = A ? metaText(A.meta, A.kind) : '';
    labB.dataset.tip = B ? metaText(B.meta, B.kind) : '';

    if (A) { la = makeMedia(A); layerA.append(la); }
    if (B) { lb = makeMedia(B); layerB.append(lb); }
    for (const m of [la, lb]) {
      if (!m) continue;
      m.addEventListener(isVideo(m) ? 'loadedmetadata' : 'load', () => { setRatio(); drawDiff(); });
    }
    setRatio();

    const m = master();
    const f = follower();
    if (m) {
      // la suiveuse se charge tout de suite ; la meneuse passe par le budget vidéo
      if (f) { f.src = (m === la ? B : A).url; }
      if (opts.full) { m.src = (m === la ? A : B).url; m.play().catch(() => {}); }
      else slot = trackVideo(root, m, { src: (m === la ? A : B).url, poster: (m === la ? A : B).poster, autoplay: true });
      bindSync(m, f);
      if (opts.controls !== false) {
        const meta = (m === la ? A : B).meta || {};
        player = attachPlayer(m, {
          mode: opts.full ? 'full' : 'compact', fps: meta.fps, frames: meta.frames,
          onUserToggle: (playing) => { if (slot) { slot.userPaused = !playing; slot.userPlayed = playing; } },
        });
        root.append(player.el);
      }
    }
    drawDiff();
  }

  // ── lecture synchronisée ────────────────────────────────────────────
  function bindSync(m, f) {
    const fps = () => ((m === la ? A : B)?.meta?.fps) || 24;
    const align = (force) => {
      if (!f || !isFinite(f.duration)) return;
      const target = Math.min(m.currentTime, Math.max(0, f.duration - 0.01));
      if (force || Math.abs(f.currentTime - target) > 0.5 / fps()) f.currentTime = target;
    };
    if (f) {
      m.addEventListener('play', () => { align(true); f.play().catch(() => {}); });
      m.addEventListener('pause', () => { f.pause(); align(true); });
      m.addEventListener('seeked', () => align(true));
      m.addEventListener('ratechange', () => { f.playbackRate = m.playbackRate; });
    }
    m.addEventListener('seeked', drawDiff);
    const tick = () => {
      if (!alive) return;
      if (typeof m.requestVideoFrameCallback !== 'function') return;
      rvfc = m.requestVideoFrameCallback(() => {
        align(false);
        if (mode === 'diff') drawDiff();
        tick();
      });
    };
    tick();
  }

  // ── différence ──────────────────────────────────────────────────────
  function ready(x) {
    if (!x) return false;
    return isVideo(x) ? x.readyState >= 2 : x.complete && x.naturalWidth > 0;
  }
  function drawDiff() {
    if (mode !== 'diff' || !ready(la) || !ready(lb)) return;
    const w0 = isVideo(la) ? la.videoWidth : la.naturalWidth;
    const h0 = isVideo(la) ? la.videoHeight : la.naturalHeight;
    const k = Math.min(1, (opts.full ? 1920 : 960) / Math.max(w0, 1));
    const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(la, 0, 0, w, h);
    ctx.globalCompositeOperation = 'difference';
    ctx.drawImage(lb, 0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  }

  function setMode(m) {
    mode = m || 'slider';
    root.dataset.mode = mode;
    setRatio();
    drawDiff();
  }

  return {
    el: root,
    set,
    setMode,
    master,
    player: () => player,
    destroy() {
      alive = false;
      teardown();
      root.remove();
    },
  };
}
