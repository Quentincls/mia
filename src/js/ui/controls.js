/**
 * Controls — every input Mia shows, drawn by us (SPEC §6.3, da.md §4.2/§4.10).
 * Never a native <select> list, range, checkbox or number spinner: those are
 * Windows widgets and they break the look.
 *
 *   segmented({ options:[{value,label,icon?,tip?}], value, onChange, size:'sm'|'md', full })
 *   dropdown({ items:[{value,label,hint?,meta?,badge?,disabled?,group?}], value, onChange,
 *              placeholder, width, renderItem?, size:'sm'|'md', search? })
 *   slider({ min, max, step, value, unit, onInput, onChange, format?, reset? })
 *   toggle({ value, onChange })
 *   textField({ value, placeholder, multiline, rows, maxRows, onChange, onInput, size, mono })
 *   numberField({ value, min, max, step, unit, onChange, onInput, width })
 *   button({ label, icon, kind:'primary'|'shiny'|'ghost'|'danger', size:'xs'|'sm'|'md', onClick, tip })
 *
 * Each returns its element, with `.setValue(v)` (silent: no callback),
 * `.getValue()`, `.setDisabled(b)`, and `.setItems(items)` for the dropdown.
 */
import { el, clamp, measureLater } from '../util.js';
import { icon } from '../icons.js';
import { t, tl, register, locale } from '../i18n.js';
import { openMenu, closeMenu } from './menu.js';

register({
  fr: { 'app.ctl.choose': 'Choisir…', 'app.ctl.reset': 'Double-clic : valeur par défaut' },
  en: { 'app.ctl.choose': 'Choose…', 'app.ctl.reset': 'Double-click: default value' }
});

const glyph = (g, size) => (!g ? '' : String(g).trim().startsWith('<') ? g : icon(g, size));
const call = (fn, ...a) => { try { return fn?.(...a); } catch (err) { console.error('[controls]', err); } };

/** Shared disabled behaviour: greyed, out of the tab order, deaf to the pointer. */
function disabler(root) {
  return (b) => {
    const on = !!b;
    root.classList.toggle('is-disabled', on);
    root.setAttribute('aria-disabled', on ? 'true' : 'false');
    for (const n of [root, ...root.querySelectorAll('button, input, textarea, [tabindex]')]) {
      if ('disabled' in n && (n.tagName === 'BUTTON' || n.tagName === 'INPUT' || n.tagName === 'TEXTAREA')) n.disabled = on;
    }
  };
}

// ── numbers ───────────────────────────────────────────────────────────
const decimalsOf = (step) => {
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]) || 0;
  return (s.split('.')[1] || '').length;
};
const snap = (v, min, step) => (step > 0 ? Math.round((v - min) / step) * step + min : v);
const fmtNum = (v, decimals) => new Intl.NumberFormat(locale(), { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(v);
const parseNum = (s) => {
  const v = parseFloat(String(s).replace(/\s| | /g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : null;
};
const withUnit = (txt, unit) => {
  if (!unit) return txt;
  return /^[×x°]$/.test(unit) ? txt + unit : `${txt} ${unit}`;
};

// ── segmented ─────────────────────────────────────────────────────────
const NEEDS = new Map();      // options (taille + libellés) → { max, min } : mesurées une fois pour toute la page
// Trop large pour sa place (carte étroite, libellés longs, français plus long que l'anglais…), le
// choix s'adapte au lieu de déborder — `adapt()`, posé par la rangée qui le loge :
//   'inline' sa largeur naturelle · 'fill' pleine largeur, options à parts égales (la rangée passe
//   en pile : libellé au-dessus) · 'wrap' idem, libellés sur deux lignes · 'menu' liste déroulante.
// Les largeurs voulues sont mesurées une fois, hors de toute mise en page (classe seg-measure), et la
// place est lue sur une sonde dont la taille ne dépend pas du niveau choisi : aucune boucle de layout.
export function segmented({ options = [], value, onChange, size = 'md', full = false, disabled = false } = {}) {
  let current = value;
  let opts = [];
  let need = null;          // { max: une ligne, min: mots seuls } en px de mise en page
  let level = 'inline';
  let fit = null;           // { room(), onLevel() } posé par adapt()
  let dd = null;            // repli « liste déroulante », fabriqué au premier besoin
  const pill = el('span', { class: 'seg-pill', 'aria-hidden': 'true' });
  const root = el('div', { class: ['seg', size === 'sm' && 'sm', full && 'full', 'no-anim'], role: 'radiogroup' }, pill);

  function render() {
    root.querySelectorAll('.seg-opt').forEach((n) => n.remove());
    for (const o of opts) {
      const b = el('button', {
        class: ['seg-opt', o.value === current && 'on'], type: 'button', role: 'radio',
        'aria-checked': o.value === current ? 'true' : 'false',
        tabindex: o.value === current ? '0' : '-1',
        html: glyph(o.icon, size === 'sm' ? 13 : 14)
      });
      if (o.label != null) b.append(el('span', { class: 'seg-txt' }, tl(o.label)));
      if (o.tip) b.dataset.tip = tl(o.tip);
      if (!o.label && o.tip) b.setAttribute('aria-label', tl(o.tip));
      b.addEventListener('click', () => pick(o.value, true));
      if (dd) root.insertBefore(b, dd); else root.append(b);
    }
    dd?.setItems(ddItems());
    need = null;
    if (fit) measureLater(fitJob);
    measureLater(placeJob);
  }

  // la pastille sous l'option choisie : lue puis posée (placeJob passe avec les autres contrôles, util.measureLater)
  function readPlace() {
    const i = opts.findIndex((o) => o.value === current);
    const b = root.querySelectorAll('.seg-opt')[i];
    return { i, w: b ? b.offsetWidth : 0, x: b ? b.offsetLeft : 0 };
  }
  function writePlace(m) {
    if (!m) return;
    if (!m.w) { pill.style.opacity = m.i < 0 ? '0' : ''; return; }
    pill.style.opacity = '';
    pill.style.width = m.w + 'px';
    pill.style.transform = `translateX(${m.x}px)`;
  }
  const place = () => writePlace(readPlace());
  const placeJob = { read: readPlace, write: writePlace };

  function pick(v, user) {
    if (v === current && (user || root.querySelector('.seg-opt.on'))) return;
    current = v;
    root.querySelectorAll('.seg-opt').forEach((n, i) => {
      const on = opts[i]?.value === v;
      n.classList.toggle('on', on);
      n.setAttribute('aria-checked', on ? 'true' : 'false');
      n.tabIndex = on ? 0 : -1;
    });
    dd?.setValue(v);
    root.classList.remove('no-anim');
    place();
    if (user) call(onChange, v);
  }

  // ── adaptation à la place ──
  const ddItems = () => opts.map((o) => ({ value: o.value, label: o.label != null ? tl(o.label) : tl(o.tip) }));

  /**
   * Largeurs voulues, indépendantes de la place et du niveau : une ligne (max) et mots seuls (min). Les mêmes
   * options (« 540p · 720p · 1080p » de cent blocs) ont les mêmes largeurs : mesurées une fois (NEEDS).
   */
  function measure() {
    const key = size + '|' + opts.map((o) => (o.icon || '') + ':' + (o.label != null ? tl(o.label) : '')).join('|');
    if (NEEDS.has(key)) return NEEDS.get(key);
    if (!root.isConnected || !root.offsetParent) return null;
    root.classList.add('seg-measure');
    const max = root.offsetWidth;
    root.classList.add('min');
    const min = root.offsetWidth;
    root.classList.remove('seg-measure', 'min');
    const out = max ? { max, min: Math.min(min || max, max) } : null;
    if (out) NEEDS.set(key, out);
    return out;
  }

  function setLevel(next) {
    if (next === level) return;
    level = next;
    root.classList.toggle('fill', next !== 'inline');
    root.classList.toggle('wrap', next === 'wrap');
    root.classList.toggle('as-menu', next === 'menu');
    if (next === 'menu' && !dd) {
      dd = dropdown({ items: ddItems(), value: current, onChange: (v) => pick(v, true), block: true });
      dd.classList.add('seg-dd');
      if (root.classList.contains('is-disabled')) dd.setDisabled(true);
      root.append(dd);
    }
    call(fit?.onLevel, next);
  }

  // lectures (largeurs voulues, place) puis écritures (niveau), avec les autres contrôles
  const fitJob = {
    read() {
      if (!fit) return null;
      if (!need) need = measure();
      const room = need && call(fit.room);
      return need && room && room.stacked > 0 ? room : null;
    },
    write(room) { if (room) applyRoom(room); },
  };
  function applyRoom(room) {
    const tol = 0.5;
    const next = need.max <= room.inline + tol ? 'inline'
      : need.max <= room.stacked + tol ? 'fill'
        : need.min <= room.stacked + tol ? 'wrap' : 'menu';
    if (next === level) return;
    const anim = !root.classList.contains('no-anim');
    root.classList.add('no-anim');
    setLevel(next);
    measureLater(placeJob);
    if (anim) requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('no-anim')));
  }

  /**
   * watch : élément dont la taille ne dépend pas du niveau (la sonde de la rangée) ;
   * room() → { inline, stacked } : place en px de mise en page, à côté du libellé puis seul sur sa ligne ;
   * onLevel(level) : la rangée passe en pile pour tout niveau autre que 'inline'.
   */
  root.adapt = ({ watch, room, onLevel } = {}) => {
    fit = { room, onLevel };
    const ro = new ResizeObserver(() => measureLater(fitJob));
    ro.observe(watch || root);
    // une police arrivée après coup change les largeurs voulues
    if (document.fonts && document.fonts.status !== 'loaded') document.fonts.ready.then(() => { NEEDS.clear(); need = null; measureLater(fitJob); }).catch(() => {});
    return root;
  };
  root.getLevel = () => level;

  root.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const i = opts.findIndex((o) => o.value === current);
    const n = clamp(i + (e.key === 'ArrowRight' ? 1 : -1), 0, opts.length - 1);
    if (n !== i) { pick(opts[n].value, true); root.querySelectorAll('.seg-opt')[n]?.focus(); }
  });

  // the first real layout (and every resize) puts the pill under its option, without a slide
  const ro = new ResizeObserver(() => {
    const anim = !root.classList.contains('no-anim');
    root.classList.add('no-anim');
    measureLater(placeJob);
    if (anim) requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('no-anim')));
  });
  ro.observe(root);

  root.setValue = (v) => pick(v, false);
  root.getValue = () => current;
  root.setOptions = (list) => { opts = list || []; render(); };
  root.setDisabled = disabler(root);
  root.setOptions(options);
  if (disabled) root.setDisabled(true);
  return root;
}

// ── dropdown ──────────────────────────────────────────────────────────
export function dropdown({
  items = [], value, onChange, placeholder, width, renderItem, renderValue, size = 'sm',
  search, block = false, disabled = false, tip
} = {}) {
  let list = items || [];
  let current = value;
  const label = el('span', { class: 'dd-label' });
  const meta = el('span', { class: 'dd-meta' });
  const root = el('button', {
    class: ['dd', size === 'md' && 'md', block && 'block'], type: 'button',
    'aria-haspopup': 'listbox', 'aria-expanded': 'false'
  }, label, meta, el('span', { class: 'dd-chev', html: icon('chevron', 12) }));
  if (width) root.style.width = typeof width === 'number' ? width + 'px' : width;
  if (tip) root.dataset.tip = tip;

  function paint() {
    const it = list.find((x) => x.value === current);
    label.classList.toggle('ph', !it);
    label.textContent = '';
    if (it && renderValue) {
      const r = renderValue(it);
      if (r?.nodeType) label.append(r); else label.textContent = r ?? tl(it.label);
    } else {
      label.textContent = it ? tl(it.label) : tl(placeholder) || t('app.ctl.choose');
    }
    meta.textContent = it?.meta && size === 'md' ? String(it.meta) : '';
    meta.hidden = !meta.textContent;
  }

  function menuItems() {
    const out = [];
    let group;
    for (const it of list) {
      const g = it.group == null ? undefined : tl(it.group);
      if (g !== undefined && g !== group) out.push({ group: g });
      group = g;
      out.push({
        value: it.value,
        label: tl(it.label),
        hint: it.hint ? tl(it.hint) : undefined,
        meta: it.meta != null ? String(it.meta) : undefined,
        badge: it.badge ? tl(it.badge) : undefined,
        disabled: !!it.disabled,
        tip: it.tip ? tl(it.tip) : undefined,
        checked: it.value === current,
        icon: it.icon,
        raw: it,
        action: () => choose(it.value)
      });
    }
    return out;
  }

  function choose(v) {
    if (v === current) return;
    current = v;
    paint();
    call(onChange, v, list.find((x) => x.value === v));
  }

  function open() {
    if (root.classList.contains('is-disabled')) return;
    if (root.classList.contains('open')) { closeMenu(); return; }
    root.classList.add('open');
    root.setAttribute('aria-expanded', 'true');
    openMenu(menuItems(), root, {
      width: root.getBoundingClientRect().width,
      selected: current,
      search,
      renderItem: renderItem ? (mi) => renderItem(mi.raw, mi.checked) : undefined,
      onClose: () => { root.classList.remove('open'); root.setAttribute('aria-expanded', 'false'); }
    });
  }

  // opens on press (not release), like a native list would
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (root.classList.contains('open')) { closeMenu(); return; }
    root.focus({ preventScroll: true });
    open();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      open();
    }
  });

  root.setValue = (v) => { current = v; paint(); };
  root.getValue = () => current;
  root.setItems = (next) => { list = next || []; paint(); };
  root.setDisabled = disabler(root);
  paint();
  if (disabled) root.setDisabled(true);
  return root;
}

// ── slider ────────────────────────────────────────────────────────────
export function slider({
  min = 0, max = 1, step = 0.01, value = min, unit = '', onInput, onChange, format, reset, disabled = false
} = {}) {
  const decimals = decimalsOf(step);
  let current = clamp(Number(value) || 0, min, max);
  const rail = el('span', { class: 'sld-rail' });
  const fill = el('span', { class: 'sld-fill' });
  const thumb = el('span', { class: 'sld-thumb' });
  const track = el('div', {
    class: 'sld-track', tabindex: '0', role: 'slider',
    'aria-valuemin': String(min), 'aria-valuemax': String(max)
  }, rail, fill, thumb);
  const out = el('span', { class: 'sld-val' });
  const root = el('div', { class: 'sld' }, track, out);
  if (reset !== undefined) track.dataset.tip = t('app.ctl.reset');

  const text = (v) => (format ? format(v) : withUnit(fmtNum(v, decimals), unit));
  function paint() {
    const p = max > min ? (current - min) / (max - min) : 0;
    root.style.setProperty('--p', String(clamp(p, 0, 1)));
    track.setAttribute('aria-valuenow', String(current));
    if (!out.querySelector('input')) out.textContent = text(current);
  }
  function set(v, phase) {
    const next = clamp(Number(snap(v, min, step).toFixed(Math.max(decimals, 0))), min, max);
    if (next === current && phase !== 'end') return;
    current = next;
    paint();
    if (phase === 'input') call(onInput, current);
    if (phase === 'end') call(onChange, current);
  }
  const fromX = (x) => {
    const r = track.getBoundingClientRect();
    const p = clamp((x - r.left - 6) / Math.max(1, r.width - 12), 0, 1);
    return min + p * (max - min);
  };

  let dragging = false;
  let startValue = current;
  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    track.focus({ preventScroll: true });
    track.setPointerCapture(e.pointerId);
    dragging = true;
    startValue = current;
    root.classList.add('drag');
    set(fromX(e.clientX), 'input');
  });
  track.addEventListener('pointermove', (e) => { if (dragging) set(fromX(e.clientX), 'input'); });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove('drag');
    if (current !== startValue) call(onChange, current);
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
  track.addEventListener('dblclick', () => { if (reset !== undefined) set(reset, 'end'); });

  track.addEventListener('keydown', (e) => {
    const big = e.shiftKey ? 10 : 1;
    let v = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = current + step * big;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = current - step * big;
    else if (e.key === 'Home') v = min;
    else if (e.key === 'End') v = max;
    if (v === null) return;
    e.preventDefault();
    e.stopPropagation();
    set(v, 'end');
  });

  // click the number to type one
  out.addEventListener('click', () => {
    if (out.querySelector('input') || root.classList.contains('is-disabled')) return;
    const input = el('input', { type: 'text', spellcheck: 'false', value: fmtNum(current, decimals) });
    out.textContent = '';
    out.append(input);
    input.focus();
    input.select();
    let committed = false;
    const commit = (keep) => {
      if (committed) return;
      committed = true;
      const v = parseNum(input.value);
      input.remove();
      if (keep && v !== null) set(v, 'end');
      paint();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', () => commit(true));
  });

  root.setValue = (v) => { current = clamp(Number(v) || 0, min, max); paint(); };
  root.getValue = () => current;
  root.setDisabled = disabler(root);
  paint();
  if (disabled) root.setDisabled(true);
  return root;
}

// ── toggle ────────────────────────────────────────────────────────────
export function toggle({ value = false, onChange, disabled = false, label } = {}) {
  let on = !!value;
  const root = el('button', { class: 'tgl', type: 'button', role: 'switch' });
  if (label) root.setAttribute('aria-label', tl(label));
  const paint = () => {
    root.classList.toggle('on', on);
    root.setAttribute('aria-checked', on ? 'true' : 'false');
  };
  root.addEventListener('click', () => { on = !on; paint(); call(onChange, on); });
  root.setValue = (v) => { on = !!v; paint(); };
  root.getValue = () => on;
  root.setDisabled = disabler(root);
  paint();
  if (disabled) root.setDisabled(true);
  return root;
}

// ── text field ────────────────────────────────────────────────────────
export function textField({
  value = '', placeholder = '', multiline = false, rows = 3, maxRows = 14,
  onChange, onInput, size = 'sm', mono = false, disabled = false, maxLength
} = {}) {
  const root = multiline
    ? el('textarea', { class: ['tf', size === 'md' && 'md', mono && 'mono'], rows: String(rows), spellcheck: 'false' })
    : el('input', { class: ['tf', size === 'md' && 'md', mono && 'mono'], type: 'text', spellcheck: 'false', autocomplete: 'off' });
  root.value = value ?? '';
  if (placeholder) root.placeholder = tl(placeholder);
  if (maxLength) root.maxLength = maxLength;
  let committed = root.value;

  // a prompt grows with its text, up to maxRows, then scrolls
  function grow() {
    if (!multiline) return;
    const cs = getComputedStyle(root);
    const line = parseFloat(cs.lineHeight) || 18;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    root.style.height = 'auto';
    const min = rows * line + pad;
    const max = maxRows * line + pad;
    const h = clamp(root.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth), min, max);
    root.style.height = h + 'px';
    root.classList.toggle('scroll', root.scrollHeight + 2 > max);
  }

  const commit = () => {
    if (root.value === committed) return;
    committed = root.value;
    call(onChange, root.value);
  };
  root.addEventListener('input', () => { grow(); call(onInput, root.value); });
  root.addEventListener('change', commit);
  root.addEventListener('blur', commit);
  root.addEventListener('keydown', (e) => {
    // board shortcuts (Suppr, lettres…) must not fire while typing
    e.stopPropagation();
    if (e.key === 'Enter' && !multiline && !e.isComposing) { e.preventDefault(); commit(); root.blur(); }
    if (e.key === 'Enter' && multiline && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); root.blur(); }
  });
  if (multiline) {
    // première mise à la hauteur avec les autres champs (util.measureLater) : lire scrollHeight sans rien changer
    // suffit pour grandir (le champ part de sa plus petite hauteur) ; ensuite, une largeur qui change le redemande
    let first = true;
    const firstGrow = {
      read() {
        if (!root.isConnected) return null;
        const cs = getComputedStyle(root);
        const line = parseFloat(cs.lineHeight) || 18;
        const borders = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
        const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + borders;
        return { sh: root.scrollHeight, ch: root.clientHeight, line, pad, borders };
      },
      write(m) {
        if (!m) return;
        const min = rows * m.line + m.pad;
        const max = maxRows * m.line + m.pad;
        if (m.sh > m.ch + 1) {
          root.style.height = clamp(m.sh + m.borders, min, max) + 'px';
          root.classList.toggle('scroll', m.sh + 2 > max);
        } else root.style.height = min + 'px';
      },
    };
    const later = { read: () => null, write: () => grow() };
    new ResizeObserver(() => { if (first) { first = false; measureLater(firstGrow); } else measureLater(later); }).observe(root);
  }

  root.setValue = (v) => {
    const next = v ?? '';
    if (root.value === next) { committed = next; return; }       // rien à remesurer
    root.value = next;
    committed = next;
    measureLater({ read: () => null, write: () => grow() });
  };
  root.getValue = () => root.value;
  root.setDisabled = disabler(root);
  if (disabled) root.setDisabled(true);
  return root;
}

// ── number field ──────────────────────────────────────────────────────
export function numberField({
  value = 0, min = -Infinity, max = Infinity, step = 1, unit = '', onChange, onInput, width, disabled = false, decimals
} = {}) {
  const dec = decimals ?? decimalsOf(step);
  let current = clamp(Number(value) || 0, min, max);
  const input = el('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', inputmode: 'decimal' });
  const up = el('button', { class: 'nf-step', type: 'button', tabindex: '-1', html: icon('chevron-up', 9) });
  const down = el('button', { class: 'nf-step', type: 'button', tabindex: '-1', html: icon('chevron', 9) });
  const root = el('div', { class: 'nf' },
    unit ? el('span', { class: 'nf-unit' }, unit) : null,
    input,
    el('div', { class: 'nf-steps' }, up, down)
  );
  if (width) root.style.width = typeof width === 'number' ? width + 'px' : width;

  const show = () => { input.value = fmtNum(current, dec); };
  function set(v, phase) {
    if (v === null || !Number.isFinite(v)) { show(); return; }
    const next = clamp(Number(snap(v, Number.isFinite(min) ? min : 0, step).toFixed(dec)), min, max);
    const changed = next !== current;
    current = next;
    show();
    if (phase === 'input' && changed) call(onInput, current);
    if (phase === 'end' && changed) call(onChange, current);
    return changed;
  }

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); set(parseNum(input.value), 'end'); input.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); show(); input.blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const k = (e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      set(current + step * k, 'end');
      input.select();
    }
  });
  input.addEventListener('blur', () => set(parseNum(input.value), 'end'));

  // drag sideways to scrub (Blender habit); a plain click types
  let press = null;
  input.addEventListener('pointerdown', (e) => {
    if (document.activeElement === input || e.button !== 0) return;
    e.preventDefault();
    input.setPointerCapture(e.pointerId);
    press = { x: e.clientX, start: current, scrub: false, moved: 0 };
  });
  input.addEventListener('pointermove', (e) => {
    if (!press) return;
    const dx = e.clientX - press.x;
    if (!press.scrub && Math.abs(dx) > 3) { press.scrub = true; root.classList.add('scrub'); }
    if (press.scrub) {
      const k = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      set(press.start + Math.round(dx / 3) * step * k, 'input');
    }
  });
  const release = () => {
    if (!press) return;
    const p = press;
    press = null;
    root.classList.remove('scrub');
    if (p.scrub) { if (current !== p.start) call(onChange, current); }
    else { input.focus(); input.select(); }
  };
  input.addEventListener('pointerup', release);
  input.addEventListener('pointercancel', release);

  const nudge = (dir) => (e) => { e.preventDefault(); set(current + step * dir * (e.shiftKey ? 10 : 1), 'end'); };
  up.addEventListener('pointerdown', (e) => e.preventDefault());
  down.addEventListener('pointerdown', (e) => e.preventDefault());
  up.addEventListener('click', nudge(1));
  down.addEventListener('click', nudge(-1));

  root.setValue = (v) => { current = clamp(Number(v) || 0, min, max); show(); };
  root.getValue = () => current;
  root.setDisabled = disabler(root);
  show();
  if (disabled) root.setDisabled(true);
  return root;
}

// ── button ────────────────────────────────────────────────────────────
export function button({ label = '', icon: ico, kind, size = 'md', onClick, tip, tipKey, disabled = false, type = 'button' } = {}) {
  const cls = ['btn',
    kind === 'primary' && 'btn-primary',
    kind === 'shiny' && 'btn-primary shiny',
    kind === 'ghost' && 'btn-ghost',
    kind === 'danger' && 'btn-danger',
    size === 'sm' && 'sm', size === 'xs' && 'xs',
    !label && ico && 'icon-only'];
  const root = el('button', { class: cls, type });
  const iconSize = size === 'md' ? 15 : 14;
  function paint(text) {
    root.textContent = '';
    const parts = [ico ? el('span', { class: 'btn-ico', style: 'display:grid;place-items:center', html: glyph(ico, iconSize) }) : null, text ? el('span', { class: 'btn-label' }, tl(text)) : null];
    // the shiny layer paints over the content unless it is wrapped in a bare span
    if (kind === 'shiny') root.append(el('span', {}, ...parts));
    else root.append(...parts.filter(Boolean));
    if (!text && tip) root.setAttribute('aria-label', tl(tip));
  }
  if (tip) root.dataset.tip = tl(tip);
  if (tipKey) root.dataset.tipKey = tipKey;
  root.addEventListener('click', (e) => { if (!root.classList.contains('is-disabled')) call(onClick, e); });
  root.setValue = (text) => { label = text; paint(text); };
  root.getValue = () => label;
  root.setDisabled = disabler(root);
  paint(label);
  if (disabled) root.setDisabled(true);
  return root;
}

export default { segmented, dropdown, slider, toggle, textField, numberField, button };
