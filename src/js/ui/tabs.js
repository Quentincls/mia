/**
 * The title-bar tab strip (Slate's, slate-ui §4): a home button, one tab per
 * open board (as many as Quentin wants: there is no limit), a "+" for a new
 * one. Quiet by design — no border, no fill until you hover; the active tab
 * barely lifts.
 *
 * Boards of the same project are grouped the way Chrome groups tabs (SPEC
 * §18.4): contiguous, led by a chip in the project's colour (its name; its
 * number of tabs when folded), each tab of the group underlined by a 2 px line
 * of that colour. A click on the chip folds / unfolds the group; the active
 * tab never hides in a folded group. Loose boards stay plain tabs.
 *
 * The strip only draws and reports; app.js decides what opening, closing and
 * renaming mean. Double-click the active tab's name to rename it in place.
 *
 * Room is measured, never guessed (Slate's roomNeeded, slate-ui §2.3): tabs
 * keep their natural width while they fit; then folded groups shrink to their
 * coloured count, then the names share the room equally down to a floor; below
 * that the tabs keep the floor width and the strip SCROLLS: the wheel (vertical
 * or horizontal) and two arrows move it smoothly, its edges fade where more
 * tabs wait, and the active tab is always brought into view. From the moment
 * names are cut, a list button (▾) lists every open tab, with a search field
 * once they are many, « Replier / Déplier » per project and « Fermer les
 * autres ». Only a window too narrow for even one tab folds the strip into one
 * chip (Slate's fade). The window's own buttons, the GPU chip and the gear
 * never give way.
 */
import { el, $ } from '../util.js';
import { t, tn, register } from '../i18n.js';
import { openMenu } from './menu.js';
import { tip } from './tooltip.js';
import { colorVar, colorMenu, swatch } from './home.js';
import { ms, play, flip, rects, reduced } from './motion.js';

register({
  fr: {
    'tabs.home': 'Accueil',
    'tabs.close': 'Fermer',
    'tabs.new': 'Nouvelle planche',
    'tabs.newIn': 'Nouvelle planche dans « {name} »',
    'tabs.full': '8 planches ouvertes au maximum : ferme un onglet',
    // 8 onglets : on propose de fermer le moins récent qui ne calcule pas, puis on continue le geste
    'tabs.fullOffer': '8 planches ouvertes au maximum',
    'tabs.fullClose': 'Fermer « {name} »',
    'tabs.rename': 'Renommer',
    'tabs.reveal': 'Afficher dans l’Explorateur',
    'tabs.closeOthers': 'Fermer les autres onglets',
    'tabs.closeTab': 'Fermer l’onglet',
    'tabs.switch': 'Planches ouvertes',
    'tabs.count.one': '{n} onglet',
    'tabs.count.other': '{n} onglets',
    'tabs.group.new': 'Nouvelle planche dans ce projet',
    'tabs.group.rename': 'Renommer le projet',
    'tabs.group.color': 'Couleur',
    'tabs.group.collapse': 'Replier',
    'tabs.group.expand': 'Déplier',
    'tabs.group.close': 'Fermer le groupe',
    'tabs.group.tipOpen': '{name} · {count} — clic pour replier',
    'tabs.group.tipFolded': '{name} · {count} — clic pour déplier',
    'tabs.group.tipAuto': '{name} · {count} — replié faute de place, clic pour choisir un onglet',
    'tabs.group.collapseGroup': 'Replier le groupe',
    'tabs.group.expandGroup': 'Déplier le groupe',
    'tabs.prev': 'Onglets précédents',
    'tabs.next': 'Onglets suivants'
  },
  en: {
    'tabs.home': 'Home',
    'tabs.close': 'Close',
    'tabs.new': 'New board',
    'tabs.newIn': 'New board in “{name}”',
    'tabs.full': '8 boards open at most: close a tab',
    'tabs.fullOffer': '8 boards open at most',
    'tabs.fullClose': 'Close “{name}”',
    'tabs.rename': 'Rename',
    'tabs.reveal': 'Show in Explorer',
    'tabs.closeOthers': 'Close the other tabs',
    'tabs.closeTab': 'Close the tab',
    'tabs.switch': 'Open boards',
    'tabs.count.one': '{n} tab',
    'tabs.count.other': '{n} tabs',
    'tabs.group.new': 'New board in this project',
    'tabs.group.rename': 'Rename the project',
    'tabs.group.color': 'Colour',
    'tabs.group.collapse': 'Fold',
    'tabs.group.expand': 'Unfold',
    'tabs.group.close': 'Close the group',
    'tabs.group.tipOpen': '{name} · {count} — click to fold',
    'tabs.group.tipFolded': '{name} · {count} — click to unfold',
    'tabs.group.tipAuto': '{name} · {count} — folded for lack of room, click to pick a tab',
    'tabs.group.collapseGroup': 'Fold the group',
    'tabs.group.expandGroup': 'Unfold the group',
    'tabs.prev': 'Previous tabs',
    'tabs.next': 'Next tabs'
  }
});

const NAME_MAX = 120;      // the same limit as the main process (store.js cleanDisplayName)

// measured layout (px) — see .tb-tab, .tb-gchip, .tb-arrow and .tb-list in app.css
const TAB_MAX = 200;       // a tab never grows past this…
const TAB_FLOOR = 100;     // …nor shrinks under this: below, the strip scrolls
const TAB_CHROME = 37;     // padding 9 + 9, gap 6, close 15, its -2 px margin
const CHIP_TIGHT = 92;     // an unfolded group's chip, once the names have to shorten
const CHIP_NAME_MIN = 40;  // a folded chip shows its name (cut) only with this much more than its bare count
const GAP = 2;             // between every piece of the strip (and inside a group)
const DRAG_MIN = 40;       // the window can always be grabbed between the tabs and the actions
const LIST_W = 24;         // the list button (▾), shown once the names are cut
const ARROW_W = 20;        // each scroll arrow, shown while the strip scrolls
const EDGE = 28;           // the active tab keeps this much room from a scrolling edge (its fade)
const SEARCH_FROM = 9;     // the list gets a search field from this many tabs

// Slate's inline glyphs, kept as they are: they are part of the look
const HOME_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="3.4" y="4.2" width="7" height="7" rx="1.6"/><rect x="13.6" y="4.2" width="7" height="7" rx="1.6"/><rect x="3.4" y="13.6" width="7" height="7" rx="1.6"/><rect x="13.6" y="13.6" width="7" height="7" rx="1.6"/></svg>';
const CLOSE_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5.5 5.5l13 13M18.5 5.5l-13 13"/></svg>';
const ADD_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5.5v13M5.5 12h13"/></svg>';
const CHEV_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9.5l6 6 6-6"/></svg>';
const LEFT_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 6l-6 6 6 6"/></svg>';
const RIGHT_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 6l6 6-6 6"/></svg>';

/**
 * @param {{ onSelect(id), onClose(id), onNew(), onHome(), onRename(id, name), onReveal(id), onCloseOthers(id),
 *           onCollapse(folderIds), onNewIn(folderId), onRenameGroup(folderId), onGroupColor(folderId, color),
 *           onCloseGroup(folderId) }} cb
 */
export function initTabs(cb) {
  const strip = $('#tb-tabs');
  const input = $('#tb-title-input') || el('input', { id: 'tb-title-input', class: 'tb-title-input', spellcheck: 'false', hidden: true });
  input.maxLength = NAME_MAX;
  // the folded strip of a narrow window: one chip that lists the tabs
  // la planche ouverte d'abord (c'est elle qu'on cherche des yeux) ; son projet ensuite, en second plan, qui cède
  // le premier quand la place manque
  const switchLabel = el('span', { class: 'tb-switch-name' });
  const switchProjName = el('span', { class: 'tb-switch-pname' });
  const switchProj = el('span', { class: 'tb-switch-proj' }, el('span', { class: 'fdot' }), switchProjName);
  const switchCount = el('span', { class: 'tb-switch-count' });
  const switchBtn = el('button', {
    class: 'tb-switch', id: 'tb-switch', type: 'button', 'aria-haspopup': 'menu', tabindex: '-1',
    onclick: () => openSwitch()
  }, el('span', { class: 'tb-switch-ico', html: HOME_SVG }), switchLabel, switchProj, switchCount,
  el('span', { class: 'tb-switch-chev', html: CHEV_SVG }));
  tip(switchBtn, () => t('tabs.switch'));
  strip.after(switchBtn);
  // the tabs themselves scroll inside the strip; home, the arrows, the list and « + » stay put around them
  const scroller = el('div', { class: 'tb-scroll' });
  const prevBtn = el('button', {
    class: 'tb-arrow', type: 'button', html: LEFT_SVG, tabindex: '-1', 'aria-label': t('tabs.prev'),
    onclick: () => nudge(-1)
  });
  const nextBtn = el('button', {
    class: 'tb-arrow', type: 'button', html: RIGHT_SVG, tabindex: '-1', 'aria-label': t('tabs.next'),
    onclick: () => nudge(1)
  });
  const listBtn = el('button', {
    class: 'tb-list', type: 'button', html: CHEV_SVG, 'aria-haspopup': 'menu', 'aria-label': t('tabs.switch'),
    onclick: () => openSwitch(listBtn)
  });
  tip(prevBtn, () => t('tabs.prev'), { placement: 'bottom' });
  tip(nextBtn, () => t('tabs.next'), { placement: 'bottom' });
  tip(listBtn, () => `${t('tabs.switch')} · ${tn('tabs.count', tabs.length)}`, { placement: 'bottom' });
  let tabs = [];              // [{ id, name, folderId }] in strip order, groups contiguous
  let folders = new Map();    // folderId → { id, name, color }
  let collapsed = new Set();  // folded groups (prefs.collapsedGroups)
  let activeId = null;        // null while the home page is showing
  let editing = null;         // { id, label } while a name is being typed
  let pendingFold = null;     // { fid, open } : the group being folded / unfolded by the next render

  // ── groups ──
  const groupOf = (tab) => (tab && tab.folderId && folders.has(tab.folderId) ? tab.folderId : null);
  const hidden = (tab) => { const g = groupOf(tab); return !!g && collapsed.has(g); };
  const groupTabs = (fid) => tabs.filter((x) => groupOf(x) === fid);

  /** Chrome's rule: a group is one contiguous run, where its first tab stood. */
  function normalize() {
    const out = [];
    const done = new Set();
    for (const tab of tabs) {
      const g = groupOf(tab);
      if (!g) { out.push(tab); continue; }
      if (done.has(g)) continue;
      done.add(g);
      for (const x of tabs) if (groupOf(x) === g) out.push(x);
    }
    tabs = out;
  }

  /** The strip as drawn: loose tabs one by one, a group as one run. */
  function runs() {
    const out = [];
    for (const tab of tabs) {
      const g = groupOf(tab);
      const last = out[out.length - 1];
      if (g && last && last.folder && last.folder.id === g) last.tabs.push(tab);
      else out.push({ folder: g ? folders.get(g) : null, tabs: [tab] });
    }
    return out;
  }

  const persistCollapsed = () => { try { cb.onCollapse?.([...collapsed]); } catch (err) { console.error('[tabs] onCollapse', err); } };

  /** The active tab never hides in a folded group (it unfolds it). */
  function ensureExpanded(id) {
    const g = groupOf(tabs.find((x) => x.id === id));
    if (g && collapsed.has(g)) { collapsed.delete(g); persistCollapsed(); }
  }

  function toggleGroup(fid) {
    if (!fid) return;
    if (collapsed.has(fid)) {
      collapsed.delete(fid);
      persistCollapsed();
      pendingFold = { fid, open: true };
      render();
      return;
    }
    collapsed.add(fid);
    persistCollapsed();
    pendingFold = { fid, open: false };
    const active = tabs.find((x) => x.id === activeId);
    render();
    if (active && groupOf(active) === fid) {
      // Chrome: the active tab leaves a group being folded — the nearest tab outside it takes over
      const i = tabs.indexOf(active);
      const next = tabs.slice(i + 1).find((x) => !hidden(x)) || tabs.slice(0, i).reverse().find((x) => !hidden(x));
      if (next) cb.onSelect?.(next.id);
      else cb.onHome?.();
    }
  }

  // ── drawing ──
  function tabNode(tab, grouped) {
    const active = tab.id === activeId;
    const label = el('span', { class: 'tb-title', dataset: { id: tab.id } }, tab.name);
    const close = el('button', {
      class: 'tb-tab-close', type: 'button', html: CLOSE_SVG, 'aria-label': t('tabs.close'),
      onpointerdown: (e) => e.stopPropagation(),
      onclick: (e) => { e.stopPropagation(); cb.onClose?.(tab.id); }
    });
    if (active) tip(close, () => t('tabs.close'), { key: t('app.key.ctrl') + ' W' });
    else tip(close, () => t('tabs.close'));

    const node = el('div', {
      class: ['tb-tab', active && 'active', grouped && 'grouped'], role: 'tab', 'aria-selected': active ? 'true' : 'false',
      dataset: { id: tab.id, group: groupOf(tab) || '' },
      onpointerdown: (e) => { if (e.button === 0 && tab.id !== activeId) cb.onSelect?.(tab.id); },
      onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); cb.onClose?.(tab.id); } },
      oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); menuFor(tab, e); }
    }, label, close);
    // the full name, only when the strip had to cut it
    tip(label, () => (label.scrollWidth > label.clientWidth + 1 ? tab.name : ''), { placement: 'bottom' });
    return node;
  }

  function groupNode(f, list) {
    const folded = collapsed.has(f.id);
    const chip = el('button', {
      class: 'tb-gchip', type: 'button', 'aria-expanded': folded ? 'false' : 'true',
      onpointerdown: (e) => e.stopPropagation(),
      onclick: () => toggleGroup(f.id),
      oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); groupMenu(f, chip); }
    },
    el('span', { class: 'tb-gname' }, f.name),
    el('span', { class: 'tb-gcount' }, String(list.length)));
    tip(chip, () => {
      const key = collapsed.has(f.id) ? 'tabs.group.tipFolded' : 'tabs.group.tipOpen';
      return t(key, { name: f.name, count: tn('tabs.count', list.length) });
    }, { placement: 'bottom' });
    const group = el('div', {
      class: ['tb-group', folded && 'collapsed'], role: 'group', 'aria-label': f.name,
      style: { '--gc': colorVar(f.color) }, dataset: { folder: f.id }
    }, chip);
    if (!folded) group.append(el('div', { class: 'tb-gtabs' }, list.map((tab) => tabNode(tab, true))));
    return group;
  }

  /** The pieces of the strip, keyed for the FLIP: tabs, group chips, home, « + ». */
  function stripItems() {
    const out = [];
    for (const n of strip.querySelectorAll('.tb-tab[data-id], .tb-gchip, .tb-home, .tb-tab-add')) {
      const key = n.classList.contains('tb-tab') ? `t:${n.dataset.id}`
        : n.classList.contains('tb-gchip') ? `g:${n.parentElement?.dataset.folder || ''}`
        : n.classList.contains('tb-home') ? 'home' : 'add';
      out.push({ key, el: n });
    }
    return out;
  }

  /**
   * After a render, the strip moves instead of jumping (SPEC §20.1): what stayed slides to
   * its new place (FLIP, 160 ms); a tab that opens unrolls from its left edge; a tab that
   * closes fades where it stood; a group that folds pulls its tabs under its chip, and one
   * that unfolds lets them slide out from under it (Chrome). Transform, opacity, clip-path only.
   */
  function animateStrip(first, olds, fold, view = null) {
    if (!first || !first.size || reduced() || document.body.classList.contains('compact')) return;
    const items = stripItems();
    const now = new Map(items.map((i) => [i.key, i.el]));
    const after = rects(items);                // where each piece lands, before the FLIP moves it back
    const chipOf = (fid) => strip.querySelector(`.tb-group[data-folder="${CSS.escape(fid || '')}"] > .tb-gchip`);
    // the group's coloured line unrolls with its tabs
    if (fold?.open) strip.querySelector(`.tb-group[data-folder="${CSS.escape(fold.fid)}"]`)?.classList.add('tb-unfold');
    flip(first, items, {
      dur: 'exit', easing: 'out',
      enter: (n, r) => {
        if (!n.classList.contains('tb-tab')) return play(n, [{ opacity: 0 }, { opacity: 1 }], { dur: 'exit' });
        const fid = n.closest('.tb-group')?.dataset.folder;
        if (fold?.open && fid === fold.fid) {
          // it slides out from under the chip: clipped at the chip's right edge all the way (same curve)
          const c = chipOf(fid)?.getBoundingClientRect();
          if (!c) return play(n, [{ opacity: 0 }, { opacity: 1 }], { dur: 'exit' });
          const dx = Math.round(c.left - r.left);
          const x0 = Math.round(c.right - c.left), x1 = Math.max(0, Math.round(c.right - r.left));
          return play(n, [
            { opacity: 0.3, transform: `translateX(${dx}px)`, clipPath: `inset(0 0 0 ${x0}px)` },
            { opacity: 1, transform: 'none', clipPath: `inset(0 0 0 ${x1}px)` }
          ], { dur: 'exit', easing: 'out' });
        }
        return play(n, [{ opacity: 0, clipPath: 'inset(0 100% 0 0 round 7px)' }, { opacity: 1, clipPath: 'inset(0 0 0 0 round 7px)' }], { dur: 'exit', easing: 'out' });
      }
    });
    // what left the strip: a ghost where it stood, which fades (or slides under its folding chip)
    for (const [key, r] of first) {
      if (now.has(key) || !key.startsWith('t:')) continue;
      const old = olds.get(key);
      if (!old || r.width < 2) continue;
      // a tab scrolled out of sight leaves without a ghost (it would float over the arrows or the bar)
      if (view && (r.right <= view.left + 2 || r.left >= view.right - 2)) continue;
      const ghost = old.cloneNode(true);
      ghost.classList.add('tb-ghost');
      ghost.removeAttribute('data-id');
      Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      document.body.append(ghost);
      const fid = old.dataset.group || null;
      // closed: it is wiped from its right edge at the pace its right neighbour slides over it; when the strip
      // scrolls back, its LEFT neighbour slides right over it instead (+80 px measured): wiped from the left then,
      // or both labels showed on top of each other (« Essai de lTests »)
      let leftDx = 0, leftBest = -Infinity;
      for (const [k2, r2] of first) {
        if (k2 === key || !now.has(k2) || r2.right > r.left + 2 || r2.right <= leftBest) continue;
        leftBest = r2.right;
        leftDx = (after.get(k2)?.left ?? r2.left) - r2.left;
      }
      let frames = leftDx > 0.5
        ? [{ opacity: 1, clipPath: 'inset(0 0 0 0)' }, { opacity: 0, clipPath: 'inset(0 0 0 100%)' }]
        : [{ opacity: 1, clipPath: 'inset(0 0 0 0)' }, { opacity: 0, clipPath: 'inset(0 100% 0 0)' }];
      if (fold && !fold.open && fid === fold.fid) {
        // folded: it slides under its chip, clipped at the chip's right edge all the way
        const c = chipOf(fid)?.getBoundingClientRect();
        if (c) {
          const x0 = Math.max(0, Math.round(c.right - r.left)), x1 = Math.round(c.right - c.left);
          frames = [
            { opacity: 1, transform: 'none', clipPath: `inset(0 0 0 ${x0}px)` },
            { opacity: 0.3, transform: `translateX(${Math.round(c.left - r.left)}px)`, clipPath: `inset(0 0 0 ${x1}px)` }
          ];
        }
      }
      const a = play(ghost, frames, { dur: 'exit', easing: 'out', fill: 'forwards' });
      if (a) a.finished.then(() => ghost.remove(), () => ghost.remove());
      else ghost.remove();
    }
  }

  function render() {
    if (editing) stopRename(false);
    // FLIP: where everything stood before this render (and the nodes, for the ghosts of what leaves)
    const before = strip.isConnected ? stripItems() : [];
    const first = before.length ? rects(before) : null;
    const olds = new Map(before.map((i) => [i.key, i.el]));
    // what the scroller showed, and how far it had scrolled: a render never makes it jump
    const view = scroller.isConnected && strip.classList.contains('scroll') ? scroller.getBoundingClientRect() : null;
    const keep = scroller.scrollLeft;
    const fold = pendingFold;
    pendingFold = null;
    strip.innerHTML = '';
    scroller.innerHTML = '';
    if (!tabs.length) { layout(); animateStrip(first, olds, fold, view); return; }

    const home = el('button', {
      class: 'tb-home' + (activeId ? '' : ' active'), type: 'button',
      html: HOME_SVG, 'aria-label': t('tabs.home'),
      onclick: () => cb.onHome?.()
    });
    tip(home, () => t('tabs.home'));
    strip.append(home, prevBtn, scroller, nextBtn, listBtn);

    for (const run of runs()) {
      if (run.folder) scroller.append(groupNode(run.folder, run.tabs));
      else scroller.append(tabNode(run.tabs[0], false));
    }

    const add = el('button', {
      class: 'tb-tab-add', type: 'button', html: ADD_SVG, 'aria-label': t('tabs.new'),
      onclick: () => cb.onNew?.()
    });
    tip(add, () => {
      const f = folders.get(groupOf(tabs.find((x) => x.id === activeId)));
      return f ? t('tabs.newIn', { name: f.name }) : t('tabs.new');
    }, { key: t('app.key.ctrl') + ' N' });
    strip.append(add);
    layout({ keep });
    animateStrip(first, olds, fold, view);
  }

  // ── room ──
  /**
   * Natural widths while they fit; then the folded groups shrink to their
   * coloured count and the unfolded groups' names shorten (the list button
   * comes in); then equal shares down to TAB_FLOOR; then the tabs keep the
   * floor and the strip scrolls between two arrows. Arithmetic on measured
   * pieces, so the answer never depends on the state it is about to change (no
   * flicker at the threshold). `keep` = the scroll a render must give back.
   */
  function layout({ keep = null } = {}) {
    const bar = $('#titlebar');
    const right = bar && $('.tb-right', bar);
    if (!bar || !right) return;
    const n = tabs.length;
    const cs = getComputedStyle(bar);
    const mark = $('#tb-mark', bar);
    const room = bar.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
      - right.offsetWidth - DRAG_MIN - (mark ? mark.offsetWidth + 6 : 0) - 4;

    const groups = [...scroller.querySelectorAll('.tb-group')];
    const tabNodes = [...scroller.querySelectorAll('.tb-tab')];
    const chips = groups.map((g) => $('.tb-gchip', g));
    const inner = groups.map((g) => $('.tb-gtabs', g));
    const folded = groups.map((g) => g.classList.contains('collapsed'));
    chips.forEach((c) => { c.classList.remove('mini', 'tight'); c.style.maxWidth = ''; });
    const width = (c) => Math.ceil(c.getBoundingClientRect().width);
    const chipFull = chips.map(width);
    // folded looks, measured on the spot (an unfolded group is folded for the measure):
    // its name and count (chipFold), the coloured count alone (chipMini)
    const chipFold = [];
    const chipMini = groups.map((g, i) => {
      if (!folded[i]) g.classList.add('collapsed');
      chipFold[i] = width(chips[i]);
      chips[i].classList.add('mini');
      const w = width(chips[i]);
      chips[i].classList.remove('mini');
      if (!folded[i]) g.classList.remove('collapsed');
      return w;
    });
    const groupOfTab = tabNodes.map((tab) => groups.indexOf(tab.closest('.tb-group')));
    const nat = tabNodes.map((tab) => Math.min(TAB_MAX, Math.ceil($('.tb-title', tab)?.scrollWidth || 0) + TAB_CHROME + 1));
    // home 26, « + » 24 and its 2 px margin, a 2 px gap between every piece (and inside an open group)
    const base = n ? 26 + 26 + GAP * (scroller.children.length + 1) : 0;
    const innerGaps = (i) => (inner[i] ? GAP + GAP * Math.max(0, inner[i].children.length - 1) : 0);

    /** Stage 0 natural, 1 folded chips to their count, 2 open chips shortened. `extra` = the list button. */
    function measure(stage, extra) {
      let used = base + extra;
      groups.forEach((g, i) => {
        if (!folded[i]) used += innerGaps(i);
        used += stage === 0 ? chipFull[i] : folded[i] ? chipMini[i] : stage >= 2 ? Math.min(chipFull[i], CHIP_TIGHT) : chipFull[i];
      });
      const shown = tabNodes.map((_, k) => groupOfTab[k] < 0 || !folded[groupOfTab[k]]);
      return { avail: room - used, shown };
    }
    const sumOf = (m, cap) => nat.reduce((a, w, k) => a + (m.shown[k] ? Math.min(w, cap) : 0), 0);

    let stage = 0;
    let m = measure(0, 0);
    // everything fits as it is: no list button, nothing cut
    const roomy = sumOf(m, TAB_MAX) <= m.avail;
    const extra = roomy ? 0 : LIST_W + GAP;
    if (!roomy) {
      m = measure(stage = 1, extra);
      while (stage < 2 && sumOf(m, TAB_MAX) > m.avail) m = measure(++stage, extra);
    }
    const avail = m.avail;
    // a short name is never padded up to the floor; only the names that must be cut are cut
    const scroll = n > 0 && sumOf(m, TAB_FLOOR) > avail;
    const tight = !scroll && n > 0 && sumOf(m, TAB_MAX) > avail;
    let cap = scroll ? TAB_FLOOR : TAB_MAX;
    if (tight) {
      // the largest cap that fits (water filling): short names keep their width, long ones share the rest
      let lo = TAB_FLOOR, hi = TAB_MAX;
      for (let i = 0; i < 16; i++) { const mid = (lo + hi) / 2; if (sumOf(m, mid) <= avail) lo = mid; else hi = mid; }
      cap = Math.floor(lo);
    }
    // the scroller's width (chips and tabs scroll together): the room minus home, « + », the list and
    // the two arrows; a window too narrow for one tab folds into the chip
    const view = Math.floor(room - (26 + 26 + 2 * GAP) - extra - 2 * (ARROW_W + GAP));
    const compact = scroll && view < TAB_FLOOR + 2 * EDGE;
    // Room left once every tab has its width: a chip folded to its bare count gets its name back,
    // shortened if need be (« Dernière s… 4 »), never wider than its folded look. The count alone
    // (it reads like a notification badge) stays the last resort.
    const named = groups.map(() => 0);
    if (!scroll && !tight) {
      let spare = avail - sumOf(m, TAB_MAX);
      groups.forEach((g, i) => {
        const mini = stage >= 1 && folded[i];
        const give = Math.min(chipFold[i] - chipMini[i], spare);
        if (!mini || give < CHIP_NAME_MIN) return;
        named[i] = chipMini[i] + Math.floor(give);
        spare -= named[i] - chipMini[i];
      });
    }
    groups.forEach((g, i) => {
      chips[i].classList.toggle('mini', stage >= 1 && folded[i] && !named[i]);
      chips[i].classList.toggle('tight', stage >= 2 && !folded[i] && chipFull[i] > CHIP_TIGHT);
      chips[i].style.maxWidth = named[i] && named[i] < chipFold[i] ? named[i] + 'px' : '';
    });
    const scrolling = scroll && !compact;
    strip.classList.toggle('tight', tight || scroll);
    strip.classList.toggle('scroll', scrolling);
    strip.classList.toggle('listed', !roomy && !compact);
    scroller.style.maxWidth = scrolling ? `${view}px` : '';
    tabNodes.forEach((tab, i) => { tab.style.width = (tight || scroll) && m.shown[i] ? Math.min(nat[i], cap) + 'px' : ''; });
    document.body.classList.toggle('compact', compact);
    // the folded chip gets all the room the tabs had (never a fixed 280 px with the bar empty beside it)
    switchBtn.style.setProperty('--sw-max', `${Math.max(120, Math.floor(room))}px`);
    // the scroll a render had, given back; the active tab brought into view (gliding when it just changed)
    if (!scrolling) { aim = null; scroller.scrollLeft = 0; }
    else {
      if (keep != null) scroller.scrollLeft = keep;
      reveal(activeId, keep != null && shownActive !== undefined && shownActive !== activeId);
    }
    shownActive = activeId;
    // a frame of overflow (fonts, a resize in progress) fades at the edge instead of cutting…
    checkClip();
    // …and is read again once the strip has settled (its width transition may end without an event)
    settleClip();
    switchBtn.tabIndex = compact ? 0 : -1;
    paintSwitch();
  }

  // ── scrolling ──
  let aim = null;              // where a smooth scroll is heading (successive wheel notches add up)
  let shownActive;             // the active tab the last layout brought into view
  const maxScroll = () => Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  function scrollToX(x, smooth) {
    const to = Math.round(Math.min(maxScroll(), Math.max(0, x)));
    if (Math.abs(to - scroller.scrollLeft) < 1) { aim = null; return; }
    const glide = smooth && !reduced();
    aim = glide ? to : null;
    scroller.scrollTo({ left: to, behavior: glide ? 'smooth' : 'auto' });
  }
  /** The arrows: most of a view at a time, the way a page turns. */
  function nudge(dir) {
    const from = aim ?? scroller.scrollLeft;
    scrollToX(from + dir * Math.max(TAB_FLOOR, scroller.clientWidth * 0.7), true);
  }
  /** Bring a tab fully into view, clear of the faded edge. */
  function reveal(id, smooth) {
    if (!id || !strip.classList.contains('scroll')) return;
    const node = scroller.querySelector(`.tb-tab[data-id="${CSS.escape(id)}"]`);
    if (!node) return;
    const sr = scroller.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    const cur = scroller.scrollLeft;
    const x0 = r.left - sr.left + cur;
    const x1 = x0 + r.width;
    const w = scroller.clientWidth;
    let to = cur;
    if (x0 < cur + EDGE) to = x0 - EDGE;
    else if (x1 > cur + w - EDGE) to = x1 - w + EDGE;
    if (Math.abs(to - cur) >= 1) scrollToX(to, smooth);
  }
  function paintEdges() {
    const on = strip.classList.contains('scroll');
    const x = scroller.scrollLeft;
    const atStart = !on || x <= 1;
    const atEnd = !on || x >= maxScroll() - 1;
    prevBtn.disabled = atStart;
    nextBtn.disabled = atEnd;
    scroller.classList.toggle('fade-l', on && !atStart);
    scroller.classList.toggle('fade-r', on && !atEnd);
  }
  scroller.addEventListener('scroll', paintEdges, { passive: true });
  scroller.addEventListener('scrollend', () => { aim = null; paintEdges(); });
  // the wheel scrolls the strip sideways: a mouse notch glides, a trackpad follows the finger
  scroller.addEventListener('wheel', (e) => {
    if (!strip.classList.contains('scroll') || e.ctrlKey) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    e.preventDefault();
    const px = e.deltaMode === 1 ? d * 18 : e.deltaMode === 2 ? d * scroller.clientWidth : d;
    const notch = e.deltaMode !== 0 || Math.abs(px) >= 50;
    scrollToX((notch ? aim ?? scroller.scrollLeft : scroller.scrollLeft) + px, notch);
  }, { passive: false });
  // a middle click on the strip never starts the browser's autoscroll (on a tab, it closes the tab)
  scroller.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });

  function checkClip() {
    const compact = document.body.classList.contains('compact');
    const scrolling = strip.classList.contains('scroll');
    strip.classList.toggle('clip', !compact && strip.scrollWidth > strip.clientWidth + 1);
    scroller.classList.toggle('clip', !compact && !scrolling && scroller.scrollWidth > scroller.clientWidth + 1);
    paintEdges();
  }
  let clipRaf = 0;
  let clipTimer = 0;
  function settleClip() {
    cancelAnimationFrame(clipRaf);
    clipRaf = requestAnimationFrame(() => { clipRaf = requestAnimationFrame(checkClip); });
    clearTimeout(clipTimer);
    clipTimer = setTimeout(checkClip, ms('fade') + 60);   // the strip's width moves for --dur-fade (app.css)
    // and whenever its transitions really end (a busy or hidden window draws late), finished or cut short
    const running = strip.getAnimations?.() || [];
    if (running.length) Promise.allSettled(running.map((a) => a.finished)).then(checkClip);
  }

  function paintSwitch() {
    const active = tabs.find((x) => x.id === activeId);
    const f = folders.get(groupOf(active));
    switchLabel.textContent = active ? active.name : t('tabs.home');
    switchProjName.textContent = active && f ? f.name : '';
    switchProj.hidden = !(active && f);
    if (f) switchProj.style.setProperty('--fc', colorVar(f.color));
    switchCount.textContent = tabs.length ? String(tabs.length) : '';
    switchBtn.setAttribute('aria-label', `${t('tabs.switch')} · ${tn('tabs.count', tabs.length)}`);
  }

  /** Every open tab, by project: from the folded chip of a narrow window or from the list button (▾). */
  function openSwitch(anchor = switchBtn) {
    anchor.classList.add('on');
    const ctrl = t('app.key.ctrl');
    const items = [{ label: t('tabs.home'), icon: 'home', checked: !activeId, action: () => cb.onHome?.() }, 'sep'];
    tabs.forEach((tab, i) => {
      const g = groupOf(tab);
      const prev = tabs[i - 1];
      if (g && groupOf(prev) !== g) {
        items.push({ group: folders.get(g).name });
        // folding a project here wins the room back for the strip
        const folded = collapsed.has(g);
        items.push({
          label: t(folded ? 'tabs.group.expandGroup' : 'tabs.group.collapseGroup'),
          icon: folded ? 'chevron' : 'chevron-up',
          action: () => toggleGroup(g)
        });
      } else if (!g && prev && groupOf(prev)) items.push('sep');
      items.push({
        label: tab.name, checked: tab.id === activeId, key: i < 8 ? `${ctrl} ${i + 1}` : null,
        icon: g ? swatch(folders.get(g).color) : null,
        action: () => { if (tab.id !== activeId) cb.onSelect?.(tab.id); }
      });
    });
    items.push('sep');
    if (activeId) items.push({ label: t('tabs.closeTab'), icon: 'close', key: `${ctrl} W`, action: () => cb.onClose?.(activeId) });
    if (activeId && tabs.length > 1) items.push({ label: t('tabs.closeOthers'), action: () => cb.onCloseOthers?.(activeId) });
    items.push({ label: t('tabs.new'), icon: 'plus', key: `${ctrl} N`, action: () => cb.onNew?.() });
    // many tabs: a search field on top (it filters by board and by project name)
    openMenu(items, anchor, {
      search: tabs.length >= SEARCH_FROM, align: anchor === listBtn ? 'end' : 'start',
      onClose: () => anchor.classList.remove('on')
    });
  }

  // the bar's width and the actions' width (the GPU chip grows and shrinks) both move the room
  const ro = new ResizeObserver(() => layout());
  const barEl = $('#titlebar');
  if (barEl) { ro.observe(barEl); const right = $('.tb-right', barEl); if (right) ro.observe(right); }
  document.fonts?.ready?.then(() => layout()).catch(() => {});
  // the strip coming back from the folded chip grows for 240 ms: its overflow is read once it is done
  // (or cut short by the next resize), whichever of its transitions ends last
  const onStripSettled = (e) => { if (e.target === strip) checkClip(); };
  strip.addEventListener('transitionend', onStripSettled);
  strip.addEventListener('transitioncancel', onStripSettled);

  function menuFor(tab, e) {
    openMenu([
      { label: t('tabs.rename'), icon: 'edit', action: () => { if (tab.id !== activeId) cb.onSelect?.(tab.id); requestAnimationFrame(() => startRename(tab.id)); } },
      { label: t('tabs.reveal'), icon: 'reveal', action: () => cb.onReveal?.(tab.id) },
      'sep',
      { label: t('tabs.closeTab'), icon: 'close', key: tab.id === activeId ? t('app.key.ctrl') + ' W' : null, action: () => cb.onClose?.(tab.id) },
      tabs.length > 1 ? { label: t('tabs.closeOthers'), action: () => cb.onCloseOthers?.(tab.id) } : null
    ], { x: e.clientX, y: e.clientY + 4 });
  }

  function groupMenu(f, chip) {
    chip.classList.add('on');
    const folded = collapsed.has(f.id);
    openMenu([
      { label: t('tabs.group.new'), icon: 'plus', action: () => cb.onNewIn?.(f.id) },
      { label: t('tabs.group.rename'), icon: 'edit', action: () => cb.onRenameGroup?.(f.id) },
      { label: t('tabs.group.color'), icon: swatch(f.color), submenu: colorMenu(f.color, (c) => cb.onGroupColor?.(f.id, c)) },
      { label: folded ? t('tabs.group.expand') : t('tabs.group.collapse'), icon: folded ? 'chevron' : 'chevron-up', action: () => toggleGroup(f.id) },
      'sep',
      { label: t('tabs.group.close'), icon: 'close', action: () => cb.onCloseGroup?.(f.id) }
    ], chip, { onClose: () => chip.classList.remove('on') });
  }

  // ── renaming in place ──
  function startRename(id = activeId) {
    const tab = tabs.find((x) => x.id === id);
    if (!tab) return;
    if (hidden(tab)) { collapsed.delete(groupOf(tab)); persistCollapsed(); render(); }
    const label = strip.querySelector(`.tb-tab[data-id="${CSS.escape(id || '')}"] .tb-title`);
    if (!label) return;
    if (editing) stopRename(false);
    reveal(id, false);
    editing = { id, label };
    input.value = tab.name;
    label.hidden = true;
    label.after(input);
    input.hidden = false;
    input.focus();
    input.select();
  }

  function stopRename(commit) {
    if (!editing) return;
    const { id, label } = editing;
    editing = null;
    const name = input.value.trim().slice(0, NAME_MAX);
    input.hidden = true;
    label.hidden = false;
    // park the field back in the bar so the next render cannot drop it
    $('.tb-left')?.append(input);
    const tab = tabs.find((x) => x.id === id);
    if (!commit || !tab || !name || name === tab.name) return;
    tab.name = name;
    label.textContent = name;
    cb.onRename?.(id, name);
  }

  strip.addEventListener('dblclick', (e) => {
    const label = e.target.closest('.tb-tab.active .tb-title');
    if (label) { e.preventDefault(); startRename(label.dataset.id); }
  });
  input.addEventListener('blur', () => stopRename(true));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); stopRename(true); }
    if (e.key === 'Escape') { e.preventDefault(); stopRename(false); }
  });

  return {
    get tabs() { return tabs.map((x) => ({ ...x })); },
    get activeId() { return activeId; },
    ids: () => tabs.map((x) => x.id),
    has: (id) => tabs.some((x) => x.id === id),
    /** Never full: there is no limit on the number of tabs (the strip scrolls). Kept for app.js and presence.js. */
    full: () => false,

    /** Add (or focus) a tab: `{ id, name, folderId }`. Always true (no limit). */
    add(meta, { activate = true } = {}) {
      let tab = tabs.find((x) => x.id === meta.id);
      if (!tab) {
        tab = { id: meta.id, name: meta.name, folderId: meta.folderId || null };
        // a board of a project lands at the end of its group (Chrome)
        const g = groupOf(tab);
        let last = -1;
        if (g) tabs.forEach((x, i) => { if (groupOf(x) === g) last = i; });
        if (last >= 0) tabs.splice(last + 1, 0, tab);
        else tabs.push(tab);
      } else {
        if (meta.name) tab.name = meta.name;
        if ('folderId' in meta) tab.folderId = meta.folderId || null;
      }
      normalize();
      if (activate) { activeId = meta.id; ensureExpanded(meta.id); }
      render();
      return true;
    },

    /** Remove a tab; returns the neighbour to show if it was the active one. */
    remove(id) {
      const i = tabs.findIndex((x) => x.id === id);
      if (i < 0) return null;
      tabs.splice(i, 1);
      const wasActive = activeId === id;
      let next = null;
      if (wasActive) {
        // the tab to the right, else the left, preferring one that is not folded away
        next = tabs.slice(i).find((x) => !hidden(x)) || tabs.slice(0, i).reverse().find((x) => !hidden(x))
          || tabs[Math.min(i, tabs.length - 1)] || null;
        activeId = null;
      }
      render();
      return next;
    },

    setActive(id) { activeId = id; if (id) ensureExpanded(id); render(); },
    rename(id, name) {
      const tab = tabs.find((x) => x.id === id);
      if (tab && name) { tab.name = name; render(); }
    },

    /**
     * The projects and the boards as the home page last read them: names,
     * colours and which project each open board belongs to (a board moved,
     * a project renamed or deleted).
     */
    setData({ folders: fl, projects } = {}) {
      if (Array.isArray(fl)) folders = new Map(fl.filter((f) => f && f.id).map((f) => [f.id, { id: f.id, name: f.name, color: f.color }]));
      if (Array.isArray(projects)) {
        const byId = new Map(projects.map((p) => [p.id, p]));
        for (const tab of tabs) {
          const p = byId.get(tab.id);
          if (!p) continue;
          if (p.name) tab.name = p.name;
          tab.folderId = p.folderId || null;
        }
      }
      normalize();
      if (editing) return;   // a name is being typed: the next render will show the rest
      render();
    },
    setCollapsed(list) { collapsed = new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []); render(); },
    collapsedGroups: () => [...collapsed],
    toggleGroup,
    /** the project of a tab (null = loose) */
    folderOf: (id) => groupOf(tabs.find((x) => x.id === id)),
    /** The name a tab shows. */
    name: (id) => tabs.find((x) => x.id === id)?.name || '',
    folder: (fid) => (fid ? folders.get(fid) || null : null),
    groupIds: (fid) => groupTabs(fid).map((x) => x.id),

    /** Neighbour in the strip (Ctrl+Tab), wrapping around; folded groups are skipped (Chrome). */
    step(dir) {
      const list = tabs.filter((x) => !hidden(x) || x.id === activeId);
      if (!list.length) return null;
      const i = list.findIndex((x) => x.id === activeId);
      if (i < 0) return dir > 0 ? list[0] : list[list.length - 1];
      return list[(i + dir + list.length) % list.length];
    },
    at: (n) => tabs[n] || null,
    startRename,
    isRenaming: () => !!editing,

    layout,
    /** Brief confirmation that the board reached the disk. */
    flashSaved(id = activeId) {
      const n = strip.querySelector(`.tb-tab[data-id="${CSS.escape(id || '')}"]`);
      if (!n) return;
      n.classList.remove('saved');
      void n.offsetWidth;            // the dot pulses once each time the board reaches the disk
      n.classList.add('saved');
      clearTimeout(n._savedTimer);
      n._savedTimer = setTimeout(() => n.classList.remove('saved'), 1300);
    },
    render
  };
}

export default initTabs;
