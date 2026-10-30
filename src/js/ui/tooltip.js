/**
 * Tooltips — ours, never the grey Windows box that `title=` produces
 * (SPEC §6.3, da.md §4.10).
 *
 *   tip(el, textOrFn, { placement: 'top'|'bottom'|'auto', key }) → undo()
 *   automatic on any element with `data-tip` (or `data-i18n-tip`), with an
 *   optional `data-tip-key` shown as a keyboard chip ("Ctrl N").
 *
 * 500 ms before the first one; once one is up, its neighbours show at once
 * (toolbar browsing feels instant). Gone on click, key, wheel or scroll.
 */
import { t } from '../i18n.js';
import { clamp, escapeHtml } from '../util.js';

const DELAY = 500;
const WARM_MS = 400;        // after a tip hides, the next one is immediate for this long
const GAP = 7;

const bound = new WeakMap();   // element → { text, placement, key }
let node = null;
let current = null;            // element whose tip is up (or pending)
let timer = 0;
let warmUntil = 0;
let installed = false;

/** Attach a tip to `el`. `textOrFn` may be a function, read when the tip shows. */
export function tip(target, textOrFn, { placement = 'auto', key = null } = {}) {
  if (!target) return () => {};
  install();
  bound.set(target, { text: textOrFn, placement, key });
  target.dataset.tipBound = '';
  return () => {
    bound.delete(target);
    delete target.dataset.tipBound;
    if (current === target) hide();
  };
}

/** Hide whatever tip is showing. */
export function hideTip() { hide(); }

function host() {
  if (node) return node;
  node = document.getElementById('tooltip') || document.body.appendChild(document.createElement('div'));
  node.id = 'tooltip';
  node.className = 'tooltip';
  node.setAttribute('role', 'tooltip');
  node.hidden = true;
  return node;
}

function specOf(target) {
  const b = bound.get(target);
  if (b) return b;
  const ds = target.dataset;
  const text = ds.tip ?? (ds.i18nTip ? t(ds.i18nTip) : '');
  return { text, placement: ds.tipPlacement || 'auto', key: ds.tipKey || null };
}

function findTarget(n) {
  while (n && n !== document.body && n.nodeType === 1) {
    if (bound.has(n) || n.dataset.tip !== undefined || n.dataset.i18nTip !== undefined) return n;
    n = n.parentElement;
  }
  return null;
}

function show(target) {
  if (!target.isConnected) return;
  const spec = specOf(target);
  let text = typeof spec.text === 'function' ? spec.text(target) : spec.text;
  if (text == null || text === '') return;
  const h = host();
  if (typeof text === 'object') {
    // infobulle riche (une pastille d'entrée, un modèle) : { kicker, title, body, meta }, tout échappé
    const part = (cls, s) => (s ? `<span class="${cls}">${escapeHtml(String(s))}</span>` : '');
    h.innerHTML = part('tip-kicker', text.kicker) + part('tip-title', text.title) + part('tip-body', text.body) + part('tip-meta', text.meta);
    h.classList.add('rich');
    h.classList.remove('multi');
  } else {
    text = String(text);
    h.innerHTML = escapeHtml(text) + (spec.key ? ` <kbd>${escapeHtml(spec.key)}</kbd>` : '');
    h.classList.remove('rich');
    h.classList.toggle('multi', text.length > 48);
  }
  // measured at the origin, so the last position never squeezes its width
  h.style.left = '0px';
  h.style.top = '0px';
  h.hidden = false;

  const r = target.getBoundingClientRect();
  const w = h.offsetWidth;
  const ht = h.offsetHeight;
  // under the title bar's controls, above everything else — unless there is no room
  let below = spec.placement === 'bottom' || (spec.placement === 'auto' && r.top < 80);
  if (below && r.bottom + GAP + ht > innerHeight - 6) below = false;
  if (!below && r.top - GAP - ht < 6) below = true;
  const x = clamp(r.left + r.width / 2 - w / 2, 6, innerWidth - w - 6);
  const y = below ? r.bottom + GAP : r.top - GAP - ht;
  h.style.left = Math.round(x) + 'px';
  h.style.top = Math.round(y) + 'px';
  h.style.setProperty('--tip-dy', below ? '-2px' : '2px');
  // restart the entrance animation for this target
  h.style.animation = 'none';
  void h.offsetWidth;
  h.style.animation = '';
}

// Just after a drag (a wire dropped on an input, a block moved), the pointer is released over a target without having
// come to it: no help there until the mouse really moves (the input's card used to cover the wire just placed).
let quietUntil = 0;
let downAt = null;
let sleeping = null;
const QUIET_MS = 600;

function hide() {
  clearTimeout(timer);
  sleeping = null;
  if (node && !node.hidden) {
    node.hidden = true;
    warmUntil = performance.now() + WARM_MS;
  }
  current = null;
}

function onOver(e) {
  if (e.pointerType === 'touch') return;
  const target = findTarget(e.target);
  if (target === current) return;
  hide();
  if (!target || e.buttons) return;
  current = target;
  if (performance.now() < quietUntil) { sleeping = target; return; }
  const wait = performance.now() < warmUntil ? 0 : DELAY;
  timer = setTimeout(() => { if (current === target) show(target); }, wait);
}

function onMove(e) {
  if (!sleeping || current !== sleeping || performance.now() < quietUntil) return;
  if (e.pointerType === 'touch' || e.buttons) return;
  const target = sleeping;
  sleeping = null;
  timer = setTimeout(() => { if (current === target) show(target); }, DELAY);
}

function onOut(e) {
  if (!current) return;
  // still inside the same target (moving between its children)
  if (e.relatedTarget && current.contains(e.relatedTarget)) return;
  hide();
}

function install() {
  if (installed) return;
  installed = true;
  document.addEventListener('pointerover', onOver, true);
  document.addEventListener('pointerout', onOut, true);
  document.addEventListener('pointermove', onMove, { capture: true, passive: true });
  window.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; }, true);
  window.addEventListener('pointerup', (e) => {
    if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) { quietUntil = performance.now() + QUIET_MS; warmUntil = 0; }
    downAt = null;
  }, true);
  for (const evt of ['pointerdown', 'keydown', 'wheel', 'scroll', 'blur', 'dragstart']) {
    window.addEventListener(evt, () => { if (current) { hide(); warmUntil = 0; } }, true);
  }
}

/** Turn on the automatic `data-tip` behaviour (app.js calls it once at boot). */
export function installTooltips() { install(); host(); }

export default { tip, hideTip, installTooltips };
