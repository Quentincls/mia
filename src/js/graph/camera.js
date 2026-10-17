// ── Caméra de la planche ──────────────────────────────────────────────
// Convention de Slate : `x, y` = point du monde au coin haut-gauche de la vue,
// `z` = zoom ; écran = (monde − origine) × z. Rien ici ne touche au DOM :
// l'éditeur applique la transformation une fois par image.

import { ms as dur, reduced as reducedMotion, cubicBezier, easeFn } from '../ui/motion.js';

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 2.5;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);


export { cubicBezier };
/** `--ease-cam` (.8, 0, .2, 1) de tokens.css : le glissement lent, rapide, lent de la page Surface. */
export const easeCam = (k) => easeFn('cam')(k);

export class Camera {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.z = 1;
    this.vw = 1;
    this.vh = 1;
    this._anim = 0;
    this.target = null;
    this.onchange = null;
  }

  get zoom() { return this.z; }

  setViewport(w, h) { this.vw = Math.max(1, w); this.vh = Math.max(1, h); }

  toScreen(wx, wy) { return { x: (wx - this.x) * this.z, y: (wy - this.y) * this.z }; }
  toWorld(sx, sy) { return { x: sx / this.z + this.x, y: sy / this.z + this.y }; }

  /** Rectangle du monde visible (marge en pixels écran). */
  viewRect(pad = 0) {
    const p = pad / this.z;
    return { x: this.x - p, y: this.y - p, w: this.vw / this.z + p * 2, h: this.vh / this.z + p * 2 };
  }

  set({ x = this.x, y = this.y, z = this.z }) {
    this.x = x; this.y = y; this.z = clamp(z, ZOOM_MIN, ZOOM_MAX);
    this._changed();
  }

  panBy(dxScreen, dyScreen) {
    if (!dxScreen && !dyScreen) return;
    this.x -= dxScreen / this.z;
    this.y -= dyScreen / this.z;
    this._changed();
  }

  /** Zoom en gardant fixe le point du monde sous (sx, sy). */
  zoomAt(sx, sy, factor) {
    const z = clamp(this.z * factor, ZOOM_MIN, ZOOM_MAX);
    if (z === this.z) return;
    const wx = sx / this.z + this.x;
    const wy = sy / this.z + this.y;
    this.z = z;
    this.x = wx - sx / z;
    this.y = wy - sy / z;
    this._changed();
  }

  centerOn(wx, wy, z = this.z) {
    this.z = clamp(z, ZOOM_MIN, ZOOM_MAX);
    this.x = wx - this.vw / 2 / this.z;
    this.y = wy - this.vh / 2 / this.z;
    this._changed();
  }

  /** Cible qui cadre une boîte du monde (marges en pixels écran). */
  frame(box, { padding = 96, maxZoom = 1, minZoom = ZOOM_MIN, insets = null } = {}) {
    const ins = insets || { top: padding, right: padding, bottom: padding, left: padding };
    const aw = Math.max(40, this.vw - ins.left - ins.right);
    const ah = Math.max(40, this.vh - ins.top - ins.bottom);
    const z = clamp(Math.min(aw / Math.max(box.w, 1), ah / Math.max(box.h, 1)), Math.max(ZOOM_MIN, minZoom), Math.min(ZOOM_MAX, maxZoom));
    // centre de la zone utile, pas de l'écran : la barre de titre et les docks mangent des bords
    const cx = ins.left + aw / 2, cy = ins.top + ah / 2;
    return { z, x: box.x + box.w / 2 - cx / z, y: box.y + box.h / 2 - cy / z };
  }

  /** Où la caméra s'arrêtera (pendant une animation, les valeurs vivantes sont en retard). */
  get settled() { return this.target || { x: this.x, y: this.y, z: this.z }; }

  /**
   * Anime vers une cible. Comme Slate, on interpole le *centre* de la vue (le
   * coin bouge énormément quand le zoom change), avec un zoom géométrique, mais
   * sur la courbe `--ease-cam` de da.md (--dur-cam, 400 ms).
   */
  animateTo(target, ms = dur('cam')) {
    const t = { x: target.x, y: target.y, z: clamp(target.z, ZOOM_MIN, ZOOM_MAX) };
    this.stop();
    if (ms <= 0 || reducedMotion()) { this.set(t); return; }
    const centre = (x, y, z) => ({ x: x + this.vw / 2 / z, y: y + this.vh / 2 / z });
    const from = { ...centre(this.x, this.y, this.z), z: this.z };
    const to = { ...centre(t.x, t.y, t.z), z: t.z };
    const t0 = performance.now();
    this.target = t;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      const e = easeCam(k);
      const z = from.z * Math.pow(to.z / from.z, e);
      this.z = z;
      this.x = from.x + (to.x - from.x) * e - this.vw / 2 / z;
      this.y = from.y + (to.y - from.y) * e - this.vh / 2 / z;
      this._changed();
      if (k < 1) this._anim = requestAnimationFrame(step);
      else { this._anim = 0; this.target = null; this.set(t); }
    };
    this._anim = requestAnimationFrame(step);
  }

  get animating() { return !!this._anim; }

  stop() {
    if (this._anim) cancelAnimationFrame(this._anim);
    this._anim = 0;
    this.target = null;
  }

  _changed() { if (this.onchange) this.onchange(); }
}

/**
 * Zoom animé au curseur pour la molette (tech.md §4.3) : interpolation en
 * logarithme (le zoom est géométrique), constante de temps 55 ms ; les crans
 * rapprochés s'accumulent sur la cible, et le point sous le curseur reste fixe
 * même si la souris bouge pendant l'animation.
 */
export class SmoothZoom {
  constructor(cam) {
    this.cam = cam;
    this.goal = null;
    this.anchor = null;
    this.raf = 0;
    this.t = 0;
    this._tick = this._tick.bind(this);
  }

  by(anchor, factor) {
    this.goal = clamp((this.goal ?? this.cam.z) * factor, ZOOM_MIN, ZOOM_MAX);
    this.anchor = anchor;
    if (reducedMotion()) {
      this.cam.zoomAt(anchor.x, anchor.y, this.goal / this.cam.z);
      this.goal = null;
      return;
    }
    if (!this.raf) { this.t = 0; this.raf = requestAnimationFrame(this._tick); }
  }

  get active() { return !!this.raf; }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.goal = null;
  }

  _tick(now) {
    // l'horodatage d'une image rAF est le *début* de l'image : il peut précéder le
    // performance.now() pris au cran. Un dt négatif ferait d'abord zoomer à l'envers.
    // premier pas : une image de 16 ms, pour que le cran réponde tout de suite
    const dt = this.t ? Math.max(0, Math.min(50, now - this.t)) : 16;
    this.t = now;
    const lz = Math.log(this.cam.z), lt = Math.log(this.goal);
    const k = 1 - Math.exp(-dt / 55);
    const z = Math.abs(lt - lz) < 0.002 ? this.goal : Math.exp(lz + (lt - lz) * k);
    this.cam.zoomAt(this.anchor.x, this.anchor.y, z / this.cam.z);
    if (z !== this.goal && this.goal != null) this.raf = requestAnimationFrame(this._tick);
    else { this.raf = 0; this.goal = null; }
  }
}
