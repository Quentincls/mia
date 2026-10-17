/**
 * Menus — Mia's own, never Windows' (SPEC §6.3, slate-ui §6.1, tech.md §8).
 *
 *   openMenu(items, at, opts?) → { close, el }
 *     items: { label, icon?, key?, danger?, disabled?, action, checked?, hint?,
 *              meta?, badge?, tip?, submenu?: [...] } | 'sep' | { group: 'Title' }
 *     at:    { x, y } (viewport) | an Element | a DOMRect
 *     opts:  { width, minWidth, selected (value), search (bool), align:'start'|'end',
 *              className, renderItem(item) → Node|string, onClose }
 *   closeMenu(), isMenuOpen()
 *   installTextMenus() — Couper / Copier / Coller / Tout sélectionner on every field
 *
 * Slate's look (r 10, 29 px rows, accent highlight, mono shortcut on the right),
 * plus what it lacked: keyboard navigation, submenus, rich rows for dropdowns,
 * closing on scroll. Focus never moves into the menu, so a text field keeps its
 * selection while its menu is open.
 */
import { el, clamp } from '../util.js';
import { icon } from '../icons.js';
import { t, register } from '../i18n.js';

register({
  fr: {
    'app.edit.cut': 'Couper',
    'app.edit.copy': 'Copier',
    'app.edit.paste': 'Coller',
    'app.edit.selectAll': 'Tout sélectionner',
    'app.menu.search': 'Rechercher…',
    'app.menu.none': 'Aucun résultat'
  },
  en: {
    'app.edit.cut': 'Cut',
    'app.edit.copy': 'Copy',
    'app.edit.paste': 'Paste',
    'app.edit.selectAll': 'Select all',
    'app.menu.search': 'Search…',
    'app.menu.none': 'No results'
  }
});

const SEARCH_FROM = 12;     // longer lists get a filter field on top
const SUB_DELAY = 140;      // hover time before a submenu opens

let stack = [];             // open panels, root first: { el, items, rows, hot, parentRow }
let opts = {};
let anchorEl = null;        // the element the menu hangs from, if any
let subTimer = 0;

export const isMenuOpen = () => stack.length > 0;

export function closeMenu() {
  if (!stack.length) return;
  clearTimeout(subTimer);
  const onClose = opts.onClose;
  for (const p of stack) {
    if (p.el.id === 'contextmenu') { p.el.hidden = true; p.el.innerHTML = ''; p.el.className = 'ctxmenu'; p.el.removeAttribute('style'); }
    else p.el.remove();
  }
  stack = [];
  opts = {};
  anchorEl = null;
  window.removeEventListener('pointerdown', onAway, true);
  window.removeEventListener('wheel', onWheel, true);
  window.removeEventListener('scroll', onScroll, true);
  window.removeEventListener('resize', closeMenu);
  window.removeEventListener('blur', closeMenu);
  try { onClose?.(); } catch (err) { console.error('[menu] onClose', err); }
}

export function openMenu(items, at, options = {}) {
  closeMenu();
  opts = options || {};
  anchorEl = at?.nodeType === 1 ? at : (opts.anchorEl || null);
  const root = document.getElementById('contextmenu') || document.body.appendChild(el('div', { id: 'contextmenu', class: 'ctxmenu' }));
  const panel = buildPanel(root, normalize(items), null);
  if (opts.className) root.classList.add(...String(opts.className).split(/\s+/).filter(Boolean));
  const minW = opts.width ?? opts.minWidth;
  if (minW) root.style.minWidth = Math.round(minW) + 'px';
  root.hidden = false;
  place(root, at);

  // a dropdown opens on its current value, ready for the arrow keys
  if (opts.selected !== undefined) {
    const i = panel.rows.findIndex((r) => r.item.value === opts.selected);
    if (i >= 0) { setHot(panel, i); panel.rows[i].node.scrollIntoView({ block: 'nearest' }); }
  }
  if (panel.search) requestAnimationFrame(() => panel.search.focus());

  // armed on the next tick: the click that opened the menu must not close it
  setTimeout(() => {
    if (!stack.length) return;
    window.addEventListener('pointerdown', onAway, true);
    window.addEventListener('wheel', onWheel, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('blur', closeMenu);
  }, 0);
  return { close: closeMenu, el: root };
}

// ── building ──────────────────────────────────────────────────────────
function normalize(items) {
  const out = [];
  for (const it of items || []) {
    if (!it) continue;
    if (it === 'sep' || it.sep) {
      // no leading, trailing or doubled separators, whatever the caller filtered out
      if (out.length && out[out.length - 1] !== 'sep') out.push('sep');
      continue;
    }
    out.push(it);
  }
  while (out[out.length - 1] === 'sep') out.pop();
  return out;
}

function buildPanel(host, items, parentRow) {
  host.innerHTML = '';
  const panel = { el: host, items, rows: [], hot: -1, parentRow, search: null, sub: null };
  stack.push(panel);

  // keep the focus where it was (a text field keeps its selection)
  host.onmousedown = (e) => { if (!e.target.closest('input')) e.preventDefault(); };
  host.oncontextmenu = (e) => e.preventDefault();
  host.onpointerleave = () => { if (!panel.sub) setHot(panel, -1); };

  const wantsSearch = !parentRow && (opts.search === true || (opts.search !== false && items.filter((i) => i !== 'sep' && !i.group).length > SEARCH_FROM));
  if (wantsSearch) {
    const input = el('input', { type: 'text', spellcheck: 'false', placeholder: t('app.menu.search') });
    input.addEventListener('input', () => filter(panel, input.value));
    host.append(el('div', { class: 'ctx-search' }, el('span', { html: icon('search', 13) }), input));
    panel.search = input;
  }

  const rich = items.some((it) => it !== 'sep' && (it.hint || it.badge));
  for (const it of items) {
    if (it === 'sep') { host.append(el('div', { class: 'ctx-sep' })); continue; }
    if (it.group !== undefined && it.label === undefined) {
      host.append(el('div', { class: 'ctx-group kicker' }, it.group));
      continue;
    }
    const node = row(it, rich);
    const index = panel.rows.length;
    panel.rows.push({ item: it, node });
    node.addEventListener('pointerenter', () => {
      setHot(panel, index);
      clearTimeout(subTimer);
      if (it.submenu && !it.disabled) subTimer = setTimeout(() => openSub(panel, index), SUB_DELAY);
      else subTimer = setTimeout(() => closeSubOf(panel), SUB_DELAY);
    });
    node.addEventListener('click', (e) => { e.preventDefault(); activate(panel, index); });
    host.append(node);
  }
  if (!panel.rows.length && !wantsSearch) host.append(el('div', { class: 'ctx-empty' }, t('app.menu.none')));
  return panel;
}

function row(it, rich) {
  const ico = it.checked ? icon('check', 14)
    : !it.icon ? ''
    : String(it.icon).trim().startsWith('<') ? it.icon : icon(it.icon, 15);
  let labelNode;
  if (opts.renderItem) {
    const r = opts.renderItem(it);
    labelNode = r == null ? null : (r.nodeType ? r : el('span', { class: 'ctx-label' }, String(r)));
  }
  if (!labelNode) {
    labelNode = el('div', { class: 'ctx-text' },
      el('span', { class: 'ctx-label' }, it.label ?? ''),
      it.hint ? el('span', { class: 'ctx-hint' }, it.hint) : null
    );
  }
  const node = el('button', {
    class: ['ctx-item', rich && 'rich', it.danger && 'danger', it.disabled && 'is-disabled'],
    type: 'button',
    tabindex: '-1',
    'aria-disabled': it.disabled ? 'true' : null,
    role: 'menuitem'
  },
    el('span', { class: 'ctx-ico', html: ico }),
    labelNode,
    it.badge ? el('span', { class: 'ctx-badge' }, it.badge) : null,
    it.meta ? el('span', { class: 'ctx-meta' }, it.meta) : null,
    it.key ? el('span', { class: 'ctx-key' }, it.key) : null,
    it.submenu ? el('span', { class: 'ctx-sub', html: icon('chevron-right', 12) }) : null
  );
  if (it.tip) node.dataset.tip = it.tip;
  return node;
}

function filter(panel, q) {
  const needle = q.trim().toLocaleLowerCase();
  const host = panel.el;
  let shown = 0;
  for (const r of panel.rows) {
    const it = r.item;
    const hay = [it.label, it.hint, it.meta, it.badge, it.group].filter(Boolean).join(' ').toLocaleLowerCase();
    const ok = !needle || hay.includes(needle);
    r.node.hidden = !ok;
    if (ok) shown++;
  }
  // a group title or separator with nothing visible after it goes away too
  const kids = [...host.children];
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (!k.classList.contains('ctx-group') && !k.classList.contains('ctx-sep')) continue;
    let any = false;
    for (let j = i + 1; j < kids.length; j++) {
      const n = kids[j];
      if (n.classList.contains('ctx-group') || n.classList.contains('ctx-sep')) break;
      if (n.classList.contains('ctx-item') && !n.hidden) { any = true; break; }
    }
    k.hidden = !!needle && !any;
  }
  host.querySelector('.ctx-empty')?.remove();
  if (!shown) host.append(el('div', { class: 'ctx-empty' }, t('app.menu.none')));
  const first = panel.rows.findIndex((r) => !r.node.hidden && !r.item.disabled);
  setHot(panel, needle ? first : -1);
}

// ── placement ─────────────────────────────────────────────────────────
function rectOf(at) {
  if (!at) return null;
  if (at.nodeType === 1) return at.getBoundingClientRect();
  if (at.anchor) return at.anchor;
  if (typeof at.left === 'number' && typeof at.bottom === 'number') return at;
  return null;
}

/**
 * Taille de mise en page d'un menu : offsetWidth/offsetHeight ignorent les transformations. Mesurer avec
 * getBoundingClientRect() pendant l'animation « pop » (scale .98) plaçait le menu comme s'il était 2 % plus
 * petit : collé au bord (0,7 px au lieu de 6), sorti de la fenêtre pour une longue liste, sous-menu qui
 * recouvre son parent, menu « end » qui dépasse de son ancre.
 */
const sizeOf = (node) => ({ width: node.offsetWidth, height: node.offsetHeight });

function place(node, at) {
  const r = sizeOf(node);
  const W = innerWidth, H = innerHeight, M = 6;
  const anchor = rectOf(at);
  let x, y;
  if (anchor) {
    if (opts.matchWidth) node.style.minWidth = Math.max(r.width, anchor.width) + 'px';
    const w = node.offsetWidth;
    x = opts.align === 'end' ? anchor.right - w : anchor.left;
    if (x + w > W - M) x = anchor.right - w;
    y = anchor.bottom + 6;
    if (y + r.height > H - M && anchor.top - r.height - 6 >= M) y = anchor.top - r.height - 6;
    node.style.left = clamp(x, M, Math.max(M, W - w - M)) + 'px';
    // it grows out of what opened it: from its top edge below the anchor, its bottom edge above
    const left = parseFloat(node.style.left);
    const above = y < anchor.top;
    node.style.transformOrigin = `${Math.round(clamp(anchor.left + anchor.width / 2 - left, 0, w))}px ${above ? '100%' : '0'}`;
    node.style.setProperty('--pop-dy', above ? '2px' : '-2px');
  } else {
    x = at?.x ?? W / 2;
    y = at?.y ?? H / 2;
    // open toward the room that is left, the way a system menu does
    if (x + r.width > W - M) x = Math.max(M, x - r.width);
    if (y + r.height > H - M) y = Math.max(M, y - r.height);
    node.style.left = clamp(x, M, Math.max(M, W - r.width - M)) + 'px';
  }
  node.style.top = clamp(y, M, Math.max(M, H - r.height - M)) + 'px';
  if (!anchor) {
    // a right click: the menu grows out of the pointer
    const px = at?.x ?? W / 2, py = at?.y ?? H / 2;
    const ox = clamp(px - parseFloat(node.style.left), 0, r.width), oy = clamp(py - parseFloat(node.style.top), 0, r.height);
    node.style.transformOrigin = `${Math.round(ox)}px ${Math.round(oy)}px`;
    node.style.setProperty('--pop-dy', oy > r.height / 2 ? '2px' : '-2px');
  }
}

// ── submenus ──────────────────────────────────────────────────────────
function openSub(panel, index) {
  const rowInfo = panel.rows[index];
  if (!rowInfo?.item.submenu) return;
  if (panel.sub && panel.sub.parentRow === rowInfo) return;
  closeSubOf(panel);
  const host = el('div', { class: 'ctxmenu sub', role: 'menu' });
  document.body.append(host);
  const sub = buildPanel(host, normalize(rowInfo.item.submenu), rowInfo);
  panel.sub = sub;
  // boîtes de mise en page : le parent peut encore être en train de s'ouvrir (scale .98), le sous-menu aussi
  const pb = panel.el.getBoundingClientRect();
  const k = panel.el.offsetWidth ? pb.width / panel.el.offsetWidth : 1;          // échelle de l'animation en cours
  const pl = parseFloat(panel.el.style.left);
  const pt = parseFloat(panel.el.style.top);
  const pr = { left: Number.isFinite(pl) ? pl : pb.left, top: Number.isFinite(pt) ? pt : pb.top };
  pr.right = pr.left + panel.el.offsetWidth;
  const rowTop = pr.top + (rowInfo.node.getBoundingClientRect().top - pb.top) / (k || 1);
  const r = sizeOf(host);
  let x = pr.right - 3;
  if (x + r.width > innerWidth - 6) x = pr.left - r.width + 3;
  host.style.left = clamp(x, 6, innerWidth - r.width - 6) + 'px';
  host.style.top = clamp(rowTop - 6, 6, innerHeight - r.height - 6) + 'px';
  return sub;
}

function closeSubOf(panel) {
  if (!panel.sub) return;
  const i = stack.indexOf(panel.sub);
  for (const p of stack.splice(i)) p.el.remove();
  panel.sub = null;
}

// ── highlight & activation ────────────────────────────────────────────
function setHot(panel, i) {
  if (panel.hot >= 0) panel.rows[panel.hot]?.node.classList.remove('hot');
  panel.hot = i;
  if (i >= 0) panel.rows[i]?.node.classList.add('hot');
}

function activate(panel, index) {
  const r = panel.rows[index];
  if (!r || r.item.disabled) return;
  if (r.item.submenu) {
    const sub = openSub(panel, index);
    const first = sub ? nextIndex(sub, -1, 1) : -1;
    if (sub && first >= 0) setHot(sub, first);
    return;
  }
  const item = r.item;
  closeMenu();
  try {
    const out = (item.action || item.onclick)?.(item);
    if (out && typeof out.catch === 'function') out.catch((err) => console.error('[menu] action', err));
  } catch (err) {
    console.error('[menu] action', err);
  }
}

function nextIndex(panel, from, dir) {
  const n = panel.rows.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + dir * k + n * 2) % n;
    const r = panel.rows[i];
    if (!r.node.hidden && !r.item.disabled) return i;
  }
  return -1;
}

// ── closing ───────────────────────────────────────────────────────────
const inside = (target) => stack.some((p) => p.el.contains(target));

/**
 * A press outside closes the menu. A press on the very button that opened it
 * closes it too — and goes no further, or the button would open it again.
 */
function onAway(e) {
  if (inside(e.target)) return;
  const anchor = anchorEl;
  closeMenu();
  if (anchor && anchor.contains(e.target)) {
    e.stopPropagation();
    e.preventDefault();
    const swallow = (ev) => { if (anchor.contains(ev.target)) { ev.stopPropagation(); ev.preventDefault(); } };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 700);
  }
}
function onWheel(e) { if (!inside(e.target)) closeMenu(); }
function onScroll(e) { if (!inside(e.target)) closeMenu(); }

function onKey(e) {
  if (!stack.length) return;
  const panel = stack[stack.length - 1];
  const k = e.key;
  const typingInSearch = panel.search && document.activeElement === panel.search;
  const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };

  if (k === 'Escape') {
    stop();
    if (stack.length > 1) { const parent = stack[stack.length - 2]; closeSubOf(parent); } else closeMenu();
    return;
  }
  if (k === 'ArrowDown' || k === 'ArrowUp') {
    stop();
    const i = nextIndex(panel, panel.hot, k === 'ArrowDown' ? 1 : -1);
    if (i >= 0) { setHot(panel, i); panel.rows[i].node.scrollIntoView({ block: 'nearest' }); }
    return;
  }
  if (k === 'Home' || k === 'End') {
    if (typingInSearch) return;
    stop();
    const i = k === 'Home' ? nextIndex(panel, -1, 1) : nextIndex(panel, 0, -1);
    if (i >= 0) { setHot(panel, i); panel.rows[i].node.scrollIntoView({ block: 'nearest' }); }
    return;
  }
  if (k === 'ArrowRight') {
    if (typingInSearch) return;
    stop();
    if (panel.hot >= 0 && panel.rows[panel.hot].item.submenu) activate(panel, panel.hot);
    return;
  }
  if (k === 'ArrowLeft') {
    if (typingInSearch) return;
    stop();
    if (stack.length > 1) closeSubOf(stack[stack.length - 2]);
    return;
  }
  if (k === 'Enter' || (k === ' ' && !typingInSearch)) {
    stop();
    if (panel.hot >= 0) activate(panel, panel.hot);
    else if (typingInSearch) { const i = nextIndex(panel, -1, 1); if (i >= 0) activate(panel, i); }
    return;
  }
  if (k === 'Tab') { stop(); closeMenu(); return; }
  // first letter jumps to the next matching row (no search field)
  if (!panel.search && k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    stop();
    const ch = k.toLocaleLowerCase();
    const n = panel.rows.length;
    for (let s = 1; s <= n; s++) {
      const i = (panel.hot + s + n) % n;
      const r = panel.rows[i];
      if (!r.item.disabled && String(r.item.label || '').trim().toLocaleLowerCase().startsWith(ch)) {
        setHot(panel, i); r.node.scrollIntoView({ block: 'nearest' }); break;
      }
    }
    return;
  }
  // anything else (Ctrl+C on the board…) closes the menu and goes on its way
  if (!typingInSearch && (e.ctrlKey || e.metaKey || e.altKey)) closeMenu();
}

// ── text fields ───────────────────────────────────────────────────────
const TEXT_INPUT = /^(text|search|url|email|tel|password|number|)$/i;

function isTextField(n) {
  if (!n) return false;
  if (n.isContentEditable) return true;
  if (n.tagName === 'TEXTAREA') return true;
  return n.tagName === 'INPUT' && TEXT_INPUT.test(n.getAttribute('type') || '');
}

function selectionOf(n) {
  if (n.isContentEditable) return String(getSelection() || '');
  try { return n.value.slice(n.selectionStart ?? 0, n.selectionEnd ?? 0); } catch { return ''; }
}

async function pasteInto(n) {
  n.focus();
  // Electron lets the page paste; if it ever refuses, read the clipboard ourselves
  let done = false;
  try { done = document.execCommand('paste'); } catch { done = false; }
  if (done) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text) document.execCommand('insertText', false, text);
  } catch (err) {
    console.warn('[menu] coller impossible', err);
  }
}

/* Listening from the moment this module loads puts the menu ahead of every
   keyboard listener the other modules add later: an open menu owns the keys. */
window.addEventListener('keydown', onKey, true);

let textMenusOn = false;

/** One menu for every text field of the window: input, textarea, contenteditable. */
export function installTextMenus() {
  if (textMenusOn) return;
  textMenusOn = true;
  document.addEventListener('contextmenu', (e) => {
    const n = e.target.closest?.('input, textarea, [contenteditable=""], [contenteditable="true"]');
    if (!isTextField(n)) return;
    e.preventDefault();
    e.stopPropagation();
    if (document.activeElement !== n) n.focus();
    const sel = selectionOf(n);
    const ro = n.readOnly || n.disabled;
    const ctrl = t('app.key.ctrl');
    openMenu([
      { label: t('app.edit.cut'), icon: 'cut', key: ctrl + ' X', disabled: !sel || ro || n.type === 'password', action: () => { n.focus(); document.execCommand('cut'); } },
      { label: t('app.edit.copy'), icon: 'copy', key: ctrl + ' C', disabled: !sel || n.type === 'password', action: () => { n.focus(); document.execCommand('copy'); } },
      { label: t('app.edit.paste'), icon: 'paste', key: ctrl + ' V', disabled: ro, action: () => pasteInto(n) },
      'sep',
      { label: t('app.edit.selectAll'), icon: 'select-all', key: ctrl + ' A', action: () => { n.focus(); if (n.select) n.select(); else document.execCommand('selectAll'); } }
    ], { x: e.clientX, y: e.clientY });
  }, true);
}

export default { openMenu, closeMenu, isMenuOpen, installTextMenus };
