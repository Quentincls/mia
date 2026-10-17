// ── Mouvement : la table de tokens.css, lue par le JS (SPEC §20) ───────
// Une seule table de durées et de courbes : tokens.css. Les animations faites
// en JS (caméra, FLIP des onglets, rangement, bout d'un fil qui s'aimante) en
// lisent les valeurs ici, jamais une constante à elles. Sous
// `prefers-reduced-motion`, tokens.css met toutes les durées à 1 ms : `ms()`
// renvoie alors 0 et chaque animation se pose directement à l'arrivée.
//
// Règles (SPEC §20.2) : seulement transform et opacity ; FLIP pour les
// changements de mise en page ; `will-change` le temps de l'animation ; rien
// qui tourne en boucle hors calcul en cours.

const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
const cache = new Map();
mq?.addEventListener?.('change', () => cache.clear());

const FALLBACK = {
  '': 140, menu: 110, pop: 120, scrim: 130, modal: 150, exit: 160, enter: 180, rise: 200, pulse: 220,
  fade: 240, card: 260, check: 300, cam: 400, glide: 600, flow: 600, loop: 1200, stagger: 30
};
const EASE_FALLBACK = {
  '': 'cubic-bezier(0.22, 0.61, 0.36, 1)', out: 'cubic-bezier(0.16, 1, 0.3, 1)',
  in: 'cubic-bezier(0.4, 0, 1, 1)', cam: 'cubic-bezier(0.8, 0, 0.2, 1)'
};

function readVar(name) {
  try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch { return ''; }
}

/** Mouvement réduit demandé par Windows (« Afficher les animations » désactivé). */
export const reduced = () => !!mq?.matches;

/**
 * Durée d'un token en millisecondes : `ms('cam')` lit `--dur-cam`, `ms()` lit `--dur`,
 * `ms('stagger')` lit `--stagger`. 0 sous mouvement réduit.
 */
export function ms(name = '') {
  const key = `d:${name}`;
  if (cache.has(key)) return cache.get(key);
  const raw = readVar(name === 'stagger' ? '--stagger' : name ? `--dur-${name}` : '--dur');
  let v = parseFloat(raw);
  if (Number.isFinite(v) && /\ds$/.test(raw) && !/ms$/.test(raw)) v *= 1000;
  if (!Number.isFinite(v)) v = reduced() ? 0 : FALLBACK[name] ?? 140;
  if (v <= 1) v = 0;
  cache.set(key, v);
  return v;
}

/** Courbe d'un token, prête pour l'API Web Animations : `ease('out')` lit `--ease-out`. */
export function ease(name = '') {
  const key = `e:${name}`;
  if (cache.has(key)) return cache.get(key);
  const v = readVar(name ? `--ease-${name}` : '--ease') || EASE_FALLBACK[name] || 'ease';
  cache.set(key, v);
  return v;
}

/**
 * Courbe de Bézier CSS en fonction JS (Newton puis dichotomie) : les animations faites
 * à la main (caméra, rangement, bout d'un fil) suivent exactement les courbes de tokens.css.
 */
export function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const err = sx(t) - x;
      if (Math.abs(err) < 1e-5) return sy(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 24; i++) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-5) break;
      if (v < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

/** La courbe d'un token en fonction JS : `easeFn('cam')` suit `--ease-cam`. */
export function easeFn(name = '') {
  const key = `f:${name}`;
  if (cache.has(key)) return cache.get(key);
  const m = /cubic-bezier\(([^)]+)\)/.exec(ease(name));
  const v = m ? m[1].split(',').map(Number) : null;
  const f = v && v.length === 4 && v.every(Number.isFinite) ? cubicBezier(...v) : (k) => k;
  cache.set(key, f);
  return f;
}

/**
 * Joue une animation Web une fois (transform / opacity), `will-change` posé le temps
 * qu'elle dure. Renvoie l'animation (ou null sous mouvement réduit ou sans durée).
 */
export function play(el, keyframes, { dur = 'enter', easing = 'out', delay = 0, fill = 'none', composite } = {}) {
  if (!el?.animate) return null;
  const d = typeof dur === 'number' ? dur : ms(dur);
  if (!d) return null;
  const opts = { duration: d, easing: easing.includes('(') || easing === 'linear' ? easing : ease(easing), delay, fill };
  if (composite) opts.composite = composite;
  let a;
  try { a = el.animate(keyframes, opts); } catch { return null; }
  const wc = el.style.willChange;
  if (!wc) el.style.willChange = 'transform, opacity';
  const done = () => { if (!wc && el.style.willChange === 'transform, opacity') el.style.willChange = ''; };
  a.finished.then(done, done);
  return a;
}

/** Relance une animation CSS portée par une classe (ex. `pulse`), puis la retire à la fin. */
export function replayClass(el, cls, { timeout = 0 } = {}) {
  if (!el || reduced()) return;
  el.classList.remove(cls);
  void el.offsetWidth;            // relance l'animation
  el.classList.add(cls);
  let t = 0;
  const off = (e) => {
    if (e && e.target !== el) return;
    clearTimeout(t);
    el.removeEventListener('animationend', off);
    el.classList.remove(cls);
  };
  el.addEventListener('animationend', off);
  // filet : une fenêtre qui ne peint pas ne finit pas ses animations
  t = setTimeout(off, (timeout || 1000) + 200);
}

/**
 * FLIP (First, Last, Invert, Play) : `first` = Map(clé → DOMRect) relevée avant le
 * changement ; `items` = [{key, el}] après. Chaque élément qui a bougé glisse de son
 * ancienne place à la nouvelle (translate seulement), ceux qui naissent apparaissent
 * en fondu (option `enter`). Renvoie le nombre d'éléments animés.
 */
export function flip(first, items, { dur = 'exit', easing = 'out', enter = null } = {}) {
  if (!first || reduced()) return 0;
  let n = 0;
  for (const { key, el } of items) {
    if (!el?.isConnected) continue;
    const a = first.get(key);
    const b = el.getBoundingClientRect();
    if (!a) {
      if (enter) { const k = enter(el, b); if (k) n++; }
      continue;
    }
    const dx = a.left - b.left, dy = a.top - b.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    play(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { dur, easing });
    n++;
  }
  return n;
}

/** Relevé « First » d'un FLIP : clé → rectangle à l'écran. */
export function rects(items) {
  const m = new Map();
  for (const { key, el } of items) if (el?.isConnected) m.set(key, el.getBoundingClientRect());
  return m;
}

/** Une View Transition de Chromium si elle existe (et si le mouvement n'est pas réduit), sinon le changement tel quel. */
export function viewTransition(update) {
  if (reduced() || typeof document.startViewTransition !== 'function') {
    const r = update();
    return Promise.resolve(r);
  }
  try {
    const vt = document.startViewTransition(update);
    return vt.updateCallbackDone.catch(() => {});
  } catch {
    return Promise.resolve(update());
  }
}
