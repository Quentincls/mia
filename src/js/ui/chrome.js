/**
 * The window's own chrome: the floating title bar's mark, the window buttons
 * (Slate's, drawn in HTML — nothing of Windows shows), the title bar's menu,
 * and the compact modes of a narrow window.
 */
import { $, isTyping } from '../util.js';
import { logo } from '../icons.js';
import { t, register } from '../i18n.js';
import { openMenu } from './menu.js';

register({
  fr: {
    'app.win.min': 'Réduire',
    'app.win.max': 'Agrandir',
    'app.win.restore': 'Restaurer',
    'app.win.close': 'Fermer',
    'app.win.fullscreen': 'Plein écran',
    'app.win.leaveFullscreen': 'Quitter le plein écran',
    'app.win.home': 'Accueil',
    'app.win.newProject': 'Nouvelle planche',
    'app.win.newFolder': 'Nouveau projet',
    'app.win.settings': 'Réglages'
  },
  en: {
    'app.win.min': 'Minimise',
    'app.win.max': 'Maximise',
    'app.win.restore': 'Restore',
    'app.win.close': 'Close',
    'app.win.fullscreen': 'Full screen',
    'app.win.leaveFullscreen': 'Leave full screen',
    'app.win.home': 'Home',
    'app.win.newProject': 'New board',
    'app.win.newFolder': 'New project',
    'app.win.settings': 'Settings'
  }
});

// 10×10 glyphs, 1 px — exactly Slate's
const GLYPH_MAX = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
const GLYPH_RESTORE = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/><path d="M2.5 2.5V.5h7v7h-2" fill="none" stroke="currentColor" stroke-width="1"/></svg>';

// The tabs fold by measure (tabs.js layout, Slate's roomNeeded). Only a window
// narrower than any real Mia window (900 px minimum) loses its action chips.
const TINY_W = 560;

const win = { maximized: false, fullscreen: false, focused: true };
let hooks = {};

const api = () => window.mia?.win || {};
const safe = (p) => Promise.resolve(p).catch((err) => console.error('[chrome]', err));

/**
 * Wire the title bar. `hooks = { onHome, onNewProject, onNewFolder, onSettings }` are used
 * by the mark and by the title bar's own menu.
 */
export function initChrome(h = {}) {
  hooks = h;
  const mark = $('#tb-mark');
  if (mark) {
    mark.innerHTML = logo(20);
    mark.addEventListener('click', () => hooks.onHome?.());
  }

  const min = $('#win-min');
  const max = $('#win-max');
  const close = $('#win-close');
  min?.addEventListener('click', () => safe(api().minimize?.()));
  max?.addEventListener('click', () => safe(api().toggleMaximize?.()));
  close?.addEventListener('click', () => safe(api().close?.()));
  // double-click on the button strip must not maximise through the drag region
  $('.win-controls')?.addEventListener('dblclick', (e) => e.stopPropagation());

  api().onState?.((s) => applyState(s || {}));
  safe(api().isMaximized?.()).then((m) => { if (typeof m === 'boolean') applyState({ maximized: m }); });

  // Windows would open its system menu on a right click in the drag band; the
  // main process stops it (SPEC §5) and, when it can, hands us the position
  safe(api().setTitlebarMenuGuard?.());
  api().onTitlebarMenu?.((p) => openTitlebarMenu(p || {}));
  $('#titlebar')?.addEventListener('contextmenu', (e) => {
    // tabs, group chips and text fields have their own menus
    if (e.target.closest('.tb-tab, .tb-gchip, input, textarea, #tb-actions > *')) return;
    e.preventDefault();
    openTitlebarMenu({ x: e.clientX, y: e.clientY });
  });

  installFocusModality();
  syncCompact();
  let queued = false;
  window.addEventListener('resize', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; syncCompact(); });
  });
}

function applyState(s) {
  if (typeof s.maximized === 'boolean') win.maximized = s.maximized;
  if (typeof s.fullscreen === 'boolean') win.fullscreen = s.fullscreen;
  if (typeof s.focused === 'boolean') win.focused = s.focused;
  const max = $('#win-max');
  if (max) {
    max.innerHTML = win.maximized ? GLYPH_RESTORE : GLYPH_MAX;
    max.dataset.i18nTip = win.maximized ? 'app.win.restore' : 'app.win.max';
    max.dataset.tip = t(max.dataset.i18nTip);
    max.setAttribute('aria-label', max.dataset.tip);
  }
  $('#titlebar')?.classList.toggle('blur', !win.focused);
  document.body.classList.toggle('maximized', win.maximized);
  document.body.classList.toggle('fullscreen', win.fullscreen);
}

/** Window state as last reported by the main process. */
export const windowState = () => ({ ...win });

export function toggleFullscreen() {
  return safe(api().toggleFullscreen?.());
}

/** Mia's menu for the title bar — never the Windows system menu. */
export function openTitlebarMenu(at) {
  openMenu([
    { label: t('app.win.home'), icon: 'home', action: () => hooks.onHome?.() },
    { label: t('app.win.newProject'), icon: 'plus', key: t('app.key.ctrl') + ' N', action: () => hooks.onNewProject?.() },
    window.mia?.folders ? { label: t('app.win.newFolder'), icon: 'folder', key: `${t('app.key.ctrl')} ${t('app.key.shift')} N`, action: () => hooks.onNewFolder?.() } : null,
    { label: t('app.win.settings'), icon: 'gear', action: () => hooks.onSettings?.() },
    'sep',
    { label: t('app.win.min'), action: () => safe(api().minimize?.()) },
    { label: win.maximized ? t('app.win.restore') : t('app.win.max'), icon: 'window', action: () => safe(api().toggleMaximize?.()) },
    { label: win.fullscreen ? t('app.win.leaveFullscreen') : t('app.win.fullscreen'), icon: 'fullscreen', key: 'F11', action: toggleFullscreen },
    'sep',
    { label: t('app.win.close'), icon: 'close', key: 'Alt F4', action: () => safe(api().close?.()) }
  ], { x: at.x ?? 12, y: at.y ?? 12 });
}

/** A very narrow window: the action chips step away too (the tabs fold on their own). */
function syncCompact() {
  document.body.classList.toggle('tiny', window.innerWidth < TINY_W);
}

/**
 * Focus rings are for the keyboard only. Chromium also lights :focus-visible on
 * an element the mouse focused as soon as any key is pressed — Esc closing a
 * menu or a popover left a stray accent ring on a card or a chip. So the ring
 * is shown only while body.kbd is set: on Tab and on the arrow keys of a
 * focused control, cleared by the next press of the pointer.
 */
function installFocusModality() {
  const body = document.body;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' || (/^(Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown)$/.test(e.key) && !isTyping(e.target))) {
      body.classList.add('kbd');
    }
  }, true);
  window.addEventListener('pointerdown', () => body.classList.remove('kbd'), true);
}

/** Is the keyboard currently driving the focus? (focus({ focusVisible }) callers read it) */
export const keyboardFocus = () => document.body.classList.contains('kbd');

export default { initChrome, openTitlebarMenu, toggleFullscreen, windowState, keyboardFocus };
