/**
 * Dialogs — Mia's own (SPEC §6.3, slate-ui §6.2). No alert/confirm/prompt of
 * the browser, no Windows message box.
 *
 *   openModal(contentEl, { width, onClose, className, dismiss = true, focus }) → { el, close(v), result }
 *     focus: 'auto' (a [data-autofocus], else the first field, else the primary button)
 *            | 'box' (the dialog itself: nothing lit, Tab starts at the top)
 *   confirm({ title, body, ok, cancel, danger }) → Promise<boolean>
 *   prompt({ title, body, value, placeholder, ok, cancel }) → Promise<string|null>
 *   alert({ title, body, ok }) → Promise<void>
 *   isModalOpen(), closeTopModal()
 *
 * Esc or a click on the scrim cancels (an open menu is closed first); Tab stays
 * inside the dialog; the focus goes back where it was afterwards — without a
 * focus ring unless the keyboard is driving (body.kbd, see chrome.js).
 */
import { el } from '../util.js';
import { t } from '../i18n.js';
import { isMenuOpen, closeMenu } from './menu.js';
import { hideTip } from './tooltip.js';
import { ms } from './motion.js';

const open = [];   // stack of { scrim, box, close, dismiss, prevFocus }

export const isModalOpen = () => open.length > 0;

export function closeTopModal() {
  const top = open[open.length - 1];
  if (!top || !top.dismiss) return false;
  top.close(undefined);
  return true;
}

function onKey(e) {
  const top = open[open.length - 1];
  if (!top) return;
  if (e.key === 'Escape') {
    if (isMenuOpen()) return;          // the menu inside the dialog goes first
    e.preventDefault();
    e.stopImmediatePropagation();
    if (top.dismiss) top.close(undefined);
    return;
  }
  if (e.key === 'Tab') {
    // keep the keyboard inside the dialog
    const f = focusables(top.box);
    if (!f.length) { e.preventDefault(); return; }
    const i = f.indexOf(document.activeElement);
    const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i === f.length - 1 ? 0 : i + 1);
    e.preventDefault();
    f[next].focus();
  }
}

// installed once, at load: ahead of the board's own keys, behind the menu's
window.addEventListener('keydown', onKey, true);

function focusables(root) {
  return [...root.querySelectorAll('button, input, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((n) => !n.disabled && n.offsetParent !== null && n.tabIndex >= 0);
}

/**
 * Show `content` (an element, put inside the dialog box) over a scrim.
 * `result` resolves with the value given to `close(v)` (undefined on cancel).
 */
const kbd = () => document.body.classList.contains('kbd');

export function openModal(content, { width = null, onClose = null, className = '', dismiss = true, bare = false, focus = 'auto' } = {}) {
  closeMenu();
  hideTip();
  const root = document.getElementById('modal-root') || document.body;
  const scrim = el('div', { class: 'modal-scrim' });
  const box = bare ? content : el('div', { class: ['modal', className], role: 'dialog', 'aria-modal': 'true' }, content);
  if (bare) { box.classList.add('modal'); if (className) box.classList.add(...className.split(/\s+/).filter(Boolean)); box.setAttribute('role', 'dialog'); }
  if (width) box.style.width = typeof width === 'number' ? `min(${width}px, 94vw)` : width;
  scrim.append(box);

  let resolve;
  const result = new Promise((r) => { resolve = r; });
  const entry = { scrim, box, dismiss, prevFocus: document.activeElement, close: null };
  let done = false;
  entry.close = (v) => {
    if (done) return;
    done = true;
    const i = open.indexOf(entry);
    if (i >= 0) open.splice(i, 1);
    closeMenu();
    hideTip();
    scrim.classList.add('out');
    setTimeout(() => scrim.remove(), ms('menu') + 10);
    try { onClose?.(v); } catch (err) { console.error('[modal] onClose', err); }
    const back = entry.prevFocus;
    if (back && back.isConnected && typeof back.focus === 'function' && back !== document.body) {
      back.focus({ preventScroll: true, focusVisible: kbd() });
    }
    resolve(v);
  };

  // a press that starts and ends on the scrim cancels; a drag out of a field does not
  let downOnScrim = false;
  scrim.addEventListener('pointerdown', (e) => { downOnScrim = e.target === scrim; });
  scrim.addEventListener('click', (e) => { if (downOnScrim && e.target === scrim && dismiss) entry.close(undefined); });

  open.push(entry);
  root.append(scrim);

  requestAnimationFrame(() => {
    const auto = box.querySelector('[data-autofocus]');
    if (!auto && focus === 'box') {
      // the dialog itself takes the focus: Esc and Tab work, nothing is lit
      if (!box.hasAttribute('tabindex')) box.tabIndex = -1;
      box.focus({ preventScroll: true, focusVisible: false });
      return;
    }
    const f = auto || box.querySelector('input, textarea') || box.querySelector('.btn-primary') || focusables(box)[0];
    if (f) {
      // a field shows its caret, a button stays quiet unless the keyboard opened the dialog
      const field = f.tagName === 'INPUT' || f.tagName === 'TEXTAREA';
      f.focus({ preventScroll: true, focusVisible: field || kbd() });
      if (f.select && f.tagName === 'INPUT') f.select();
    }
  });
  return { el: box, close: entry.close, result };
}

function actions(...buttons) {
  return el('div', { class: 'modal-actions' }, ...buttons);
}

function primary(label, onclick, { danger = false } = {}) {
  // Slate's danger button: red words on the neutral body — red is never a fill in Mia
  if (danger) return el('button', { class: 'btn btn-danger', type: 'button', onclick }, label);
  return el('button', { class: 'btn btn-primary', type: 'button', onclick }, el('span', {}, label));
}

function ghost(label, onclick) {
  return el('button', { class: 'btn btn-ghost', type: 'button', onclick }, label);
}

/** Yes / no. A dangerous action gets a red button, and the focus starts on Cancel. */
export function confirm({ title, body = '', ok = t('app.confirm'), cancel = t('app.cancel'), danger = false } = {}) {
  let handle = null;
  const no = ghost(cancel, () => handle.close(false));
  const yes = primary(ok, () => handle.close(true), { danger });
  if (danger) no.dataset.autofocus = '';
  const content = el('div', {},
    el('h2', {}, title || ''),
    body ? el('p', {}, body) : null,
    actions(no, yes)
  );
  handle = openModal(content);
  return handle.result.then((v) => v === true);
}

/** One line of text. Enter validates, an empty answer counts as a cancel. */
export function prompt({ title, body = '', value = '', placeholder = '', ok = t('app.ok'), cancel = t('app.cancel'), maxLength = 0 } = {}) {
  let handle = null;
  const input = el('input', {
    class: 'modal-field', type: 'text', value, placeholder, spellcheck: 'false', autocomplete: 'off',
    ...(maxLength > 0 ? { maxlength: String(maxLength) } : {}),
    onkeydown: (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); handle.close(input.value.trim() || null); }
    }
  });
  const content = el('div', {},
    el('h2', {}, title || ''),
    body ? el('p', {}, body) : null,
    input,
    actions(
      ghost(cancel, () => handle.close(null)),
      primary(ok, () => handle.close(input.value.trim() || null))
    )
  );
  handle = openModal(content);
  return handle.result.then((v) => (typeof v === 'string' && v ? v : null));
}

/** A message and one button. */
export function alert({ title, body = '', ok = t('app.ok') } = {}) {
  let handle = null;
  const content = el('div', {},
    el('h2', {}, title || ''),
    body ? el('p', {}, body) : null,
    actions(primary(ok, () => handle.close(true)))
  );
  handle = openModal(content);
  return handle.result.then(() => undefined);
}

export default { openModal, confirm, prompt, alert, isModalOpen, closeTopModal };
