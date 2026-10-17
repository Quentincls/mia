/**
 * Small helpers shared by every module (SPEC §6.3).
 * Formatting follows the interface language: « 1,2 Go », « 1 min 20 s »,
 * « 20 h 45 » in French; "1.2 GB", "1 min 20 s", "20:45" in English.
 */
import { t, tn, lang, locale } from './i18n.js';

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, k) => a + (b - a) * k;

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ── ids ───────────────────────────────────────────────────────────────
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Short random id: `uid('n')` → "n_k3j2a9" (SPEC §3.2 style). Six base-36
 * characters from the crypto generator: 2 billion values, plenty for a board.
 */
export function uid(prefix = '', len = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const b of bytes) s += ALPHABET[b % 36];
  if (!prefix) return s;
  return prefix.endsWith('_') ? prefix + s : prefix + '_' + s;
}

// ── timing ────────────────────────────────────────────────────────────
/** Trailing debounce, with `.cancel()`, `.flush()` and `.pending()`. */
export function debounce(fn, ms) {
  let timer = null;
  let args = null;
  const d = (...a) => {
    args = a;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; const x = args; args = null; fn(...x); }, ms);
  };
  d.cancel = () => { clearTimeout(timer); timer = null; args = null; };
  d.flush = () => {
    if (!timer) return undefined;
    clearTimeout(timer);
    timer = null;
    const x = args; args = null;
    return fn(...x);
  };
  d.pending = () => timer !== null;
  return d;
}

/** At most once every `ms`, first call immediate, last call never lost. */
export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let args = null;
  const run = () => { last = performance.now(); timer = null; const x = args; args = null; fn(...x); };
  const th = (...a) => {
    args = a;
    const wait = ms - (performance.now() - last);
    if (wait <= 0) { clearTimeout(timer); run(); } else if (!timer) timer = setTimeout(run, wait);
  };
  th.cancel = () => { clearTimeout(timer); timer = null; args = null; };
  return th;
}

/** Once per animation frame, with the latest arguments. */
export function rafThrottle(fn) {
  let queued = false;
  let last;
  return (...a) => {
    last = a;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(...last); });
  };
}

// ── DOM ───────────────────────────────────────────────────────────────
/**
 * `el('button', { class: 'btn', onclick: fn, html: icon('plus') }, 'Label')`.
 * attrs: class, style (object or string), html, text, dataset, on<event>,
 * `tip` (our tooltip), booleans (true → present, false/null → absent).
 */
export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class' || k === 'className') n.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'style') {
      if (typeof v === 'object') {
        for (const [p, val] of Object.entries(v)) {
          if (p.startsWith('--')) n.style.setProperty(p, val);
          else n.style[p] = val;
        }
      } else n.setAttribute('style', v);
    }
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k === 'tip') n.dataset.tip = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESC[c]);

/** Is the keyboard focus in something that takes text? (shortcuts stand down) */
export function isTyping(target = document.activeElement) {
  if (!target || target === document.body) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA') return !target.readOnly;
  if (tag !== 'INPUT') return false;
  return !/^(button|checkbox|radio|range|color|file|submit|reset|image)$/i.test(target.type || 'text') && !target.readOnly;
}

// ── numbers ───────────────────────────────────────────────────────────
function num(v, digits) {
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(v);
}

/** 1 288 490 188 → « 1,2 Go » / "1.2 GB" (powers of 1024, like Explorer). */
export function fmtBytes(bytes) {
  let v = Number(bytes);
  if (!isFinite(v) || v < 0) v = 0;
  const units = ['b', 'kb', 'mb', 'gb', 'tb'];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const digits = i === 0 ? 0 : v < 10 ? 1 : 0;
  return `${num(v, digits)} ${t('app.unit.' + units[i])}`;
}

/**
 * A duration in **seconds** → « 45 s », « 1 min 20 s », « 1 h 05 min ».
 * Under 10 s it keeps one decimal (« 4,2 s ») — clip lengths need it.
 */
export function fmtDuration(seconds) {
  let s = Number(seconds);
  if (!isFinite(s) || s < 0) s = 0;
  if (s < 10 && s % 1) return `${num(Math.round(s * 10) / 10, 1)} s`;
  s = Math.round(s);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  return r ? `${m} min ${r} s` : `${m} min`;
}

/** A timestamp (ms) → the time of day: « 20 h 45 » / "20:45". */
export function fmtClock(ms) {
  const d = new Date(Number(ms) || Date.now());
  const hh = String(d.getHours());
  const mm = String(d.getMinutes()).padStart(2, '0');
  return lang() === 'fr' ? `${hh} h ${mm}` : `${hh.padStart(2, '0')}:${mm}`;
}

/** « 0:42 » / « 1:02:07 » — media timecodes. */
export function fmtTime(seconds) {
  let s = Number(seconds);
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** A timestamp (ms) → « à l’instant », « il y a 5 min », « hier », « 3 sept. 2026 ». */
export function relTime(ms) {
  const ts = Number(ms) || 0;
  const d = Date.now() - ts;
  const m = 60e3, h = 3600e3, day = 86400e3;
  if (d < -m) return t('app.time.future');
  if (d < m) return t('app.time.now');
  if (d < h) return t('app.time.min', { n: Math.floor(d / m) });
  if (d < day) return t('app.time.hour', { n: Math.floor(d / h) });
  if (d < 2 * day) return t('app.time.yesterday');
  if (d < 7 * day) return tn('app.time.days', Math.floor(d / day));
  const sameYear = new Date(ts).getFullYear() === new Date().getFullYear();
  return new Date(ts).toLocaleDateString(locale(), sameYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Windows path → its last segment. */
export const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';

/**
 * A model size given in GB → « 4 Mo », « 0,3 Go », « 21,5 Go » — never « 0,00 Go ».
 * The same rounding everywhere (library, model pickers, palette).
 */
export function fmtGB(gb) {
  const v = Number(gb);
  if (!isFinite(v) || v <= 0) return `0 ${t('app.unit.mb')}`;
  if (v < 0.1) return `${num(Math.max(1, Math.round(v * 1024)), 0)} ${t('app.unit.mb')}`;
  return `${num(v, v < 100 ? 1 : 0)} ${t('app.unit.gb')}`;
}

/**
 * Run a shell action (`mia.shell.*`, `mia.projects.reveal`…) and say when it
 * failed: those calls resolve to `{ ok:false, error }` instead of throwing, and
 * an ignored result is a silent failure. `okMsg` is toasted on success.
 *   shellDo(window.mia.shell.openPath, { projectId, rel }, null)
 */
export async function shellDo(fn, target, okMsg = null) {
  let r;
  try { r = await fn?.(target); } catch (err) { r = { ok: false, error: err?.message || String(err) }; }
  const { toast } = await import('./ui/toasts.js');
  if (r && typeof r === 'object' && r.ok === false) {
    toast(r.error || t('app.error'), { kind: 'error' });
    return false;
  }
  if (okMsg) toast(okMsg, { kind: 'ok' });
  return true;
}

export default {
  clamp, lerp, $, $$, uid, debounce, throttle, rafThrottle, el, escapeHtml, isTyping,
  fmtBytes, fmtDuration, fmtClock, fmtTime, relTime, baseName, fmtGB, shellDo
};
