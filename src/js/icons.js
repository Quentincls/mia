/**
 * Icon set — inline SVG, 24 grid, 1.7 stroke, round ends, currentColor
 * (Slate's style, da.md §4.11). SPEC §6.3:
 *   icon(name, size = 16) → SVG markup
 *   register({ name: '<path …/>' })   — other modules add their glyphs
 *   fitGlyph(markup, target, baseStroke) — Slate's optical sizing
 *
 * The shell provides the generic set; the board registers its block glyphs
 * (import, depth, cutout…). No sparkles, wands or brains: no "AI" clichés.
 */

const HEAD = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
  'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
const wrap = (d) => (/^\s*<svg\b/i.test(d) ? d.trim() : HEAD + d + '</svg>');

const dot = (cx, cy, r = 1.5) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;

/** Raw glyphs (inner markup of a 24×24 box), fitted lazily on first use. */
const RAW = {
  plus: '<path d="M12 5v14M5 12h14" stroke-width="1.9"/>',
  minus: '<path d="M5 12h14" stroke-width="1.9"/>',
  close: '<path d="M5.8 5.8l12.4 12.4M18.2 5.8L5.8 18.2" stroke-width="1.9"/>',
  chevron: '<path d="M6 9.5l6 6 6-6"/>',
  'chevron-up': '<path d="M6 14.5l6-6 6 6"/>',
  'chevron-right': '<path d="M9.5 6l6 6-6 6"/>',
  'chevron-left': '<path d="M14.5 6l-6 6 6 6"/>',
  'arrow-right': '<path d="M4.5 12h15M13.5 6l6 6-6 6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  gear: '<path d="M10.28 5.11L10.63 2.8L13.37 2.8L13.72 5.11A7.1 7.1 0 0 1 15.66 5.91L17.53 4.52L19.48 6.47L18.09 8.34A7.1 7.1 0 0 1 18.89 10.28L21.2 10.63L21.2 13.37L18.89 13.72A7.1 7.1 0 0 1 18.09 15.66L19.48 17.53L17.53 19.48L15.66 18.09A7.1 7.1 0 0 1 13.72 18.89L13.37 21.2L10.63 21.2L10.28 18.89A7.1 7.1 0 0 1 8.34 18.09L6.47 19.48L4.52 17.53L5.91 15.66A7.1 7.1 0 0 1 5.11 13.72L2.8 13.37L2.8 10.63L5.11 10.28A7.1 7.1 0 0 1 5.91 8.34L4.52 6.47L6.47 4.52L8.34 5.91A7.1 7.1 0 0 1 10.28 5.11Z"/><circle cx="12" cy="12" r="3"/>',
  folder: '<path d="M3.5 7.2a1.7 1.7 0 0 1 1.7-1.7h4.1l2 2.2h7.5a1.7 1.7 0 0 1 1.7 1.7v8.4a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7z"/>',
  reveal: '<path d="M11.5 19.5H5.2a1.7 1.7 0 0 1-1.7-1.7V7.2a1.7 1.7 0 0 1 1.7-1.7h4.1l2 2.2h7.5a1.7 1.7 0 0 1 1.7 1.7v2.4"/><path d="M15.2 14.2h5.3v5.3M20.5 14.2l-6.4 6.4"/>',
  external: '<path d="M14 4.6h5.4V10M19.4 4.6L11 13"/><path d="M18 14v4.4a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 18.4V7.6A1.6 1.6 0 0 1 5.6 6H10"/>',
  copy: '<rect x="8.4" y="8.4" width="11.4" height="11.4" rx="2"/><path d="M15.6 5.6a2 2 0 0 0-2-2H6.2a2 2 0 0 0-2 2v7.4a2 2 0 0 0 2 2"/>',
  cut: '<circle cx="6.6" cy="17.4" r="2.6"/><circle cx="17.4" cy="17.4" r="2.6"/><path d="M8.6 15.8L18 4.4M15.4 15.8L6 4.4"/>',
  paste: '<path d="M8.6 5H7a2 2 0 0 0-2 2v11.4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-1.6"/><rect x="8.6" y="3.4" width="6.8" height="3.4" rx="1.2"/>',
  'select-all': '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><rect x="8.4" y="8.4" width="7.2" height="7.2" rx="1.2"/>',
  duplicate: '<rect x="3.6" y="3.6" width="10.8" height="10.8" rx="2"/><path d="M9.6 20.4h8.8a2 2 0 0 0 2-2V9.6"/>',
  edit: '<path d="M4 20l1.1-4L16.3 4.8a1.9 1.9 0 0 1 2.7 0l.9.9a1.9 1.9 0 0 1 0 2.7L8.6 19.6z"/><path d="M15 6.4l3.2 3.2"/>',
  trash: '<path d="M4.6 6.6h14.8M9.4 6.4V4.9a1.4 1.4 0 0 1 1.4-1.4h2.4a1.4 1.4 0 0 1 1.4 1.4v1.5"/><path d="M6.6 6.8l.9 12.1a1.6 1.6 0 0 0 1.6 1.5h5.8a1.6 1.6 0 0 0 1.6-1.5l.9-12.1"/><path d="M10.4 10.4v6.4M13.6 10.4v6.4"/>',
  play: '<path d="M7.6 4.9l11.3 6.4a.8.8 0 0 1 0 1.4L7.6 19.1a.8.8 0 0 1-1.2-.7V5.6a.8.8 0 0 1 1.2-.7z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.4" y="4.8" width="4" height="14.4" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.6" y="4.8" width="4" height="14.4" rx="1.2" fill="currentColor" stroke="none"/>',
  stop: '<rect x="5.6" y="5.6" width="12.8" height="12.8" rx="2.2" fill="currentColor" stroke="none"/>',
  star: '<path d="M12 3.6l2.5 5.3 5.8.7-4.3 4 1.1 5.7L12 16.5l-5.1 2.8 1.1-5.7-4.3-4 5.8-.7z"/>',
  'star-fill': '<path d="M12 3.6l2.5 5.3 5.8.7-4.3 4 1.1 5.7L12 16.5l-5.1 2.8 1.1-5.7-4.3-4 5.8-.7z" fill="currentColor"/>',
  more: dot(5.4, 12) + dot(12, 12) + dot(18.6, 12),
  'more-v': dot(12, 5.4) + dot(12, 12) + dot(12, 18.6),
  check: '<path d="M4.8 12.6l4.8 4.8L19.2 7" stroke-width="2"/>',
  warn: '<path d="M10.3 4.9a2 2 0 0 1 3.4 0l7.5 13a2 2 0 0 1-1.7 3H4.5a2 2 0 0 1-1.7-3z"/><path d="M12 9.6v4.2"/>' + dot(12, 16.9, 1),
  info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.4"/>' + dot(12, 7.9, 1),
  home: '<rect x="3.4" y="4.2" width="7" height="7" rx="1.6"/><rect x="13.6" y="4.2" width="7" height="7" rx="1.6"/><rect x="3.4" y="13.6" width="7" height="7" rx="1.6"/><rect x="13.6" y="13.6" width="7" height="7" rx="1.6"/>',
  grid: dot(6, 6, 1.1) + dot(12, 6, 1.1) + dot(18, 6, 1.1) + dot(6, 12, 1.1) + dot(12, 12, 1.1) + dot(18, 12, 1.1) + dot(6, 18, 1.1) + dot(12, 18, 1.1) + dot(18, 18, 1.1),
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.4v2.4M12 19.2v2.4M2.4 12h2.4M19.2 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M18.7 5.3L17 7M7 17l-1.7 1.7"/>',
  moon: '<path d="M20 14.4A8.6 8.6 0 0 1 9.6 4a8.6 8.6 0 1 0 10.4 10.4z"/>',
  globe: '<circle cx="12" cy="12" r="8.6"/><path d="M3.6 12h16.8M12 3.4c2.3 2.4 3.5 5.3 3.5 8.6s-1.2 6.2-3.5 8.6c-2.3-2.4-3.5-5.3-3.5-8.6s1.2-6.2 3.5-8.6z"/>',
  gpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.6" y="9.6" width="4.8" height="4.8" rx=".8"/><path d="M9.5 3.2V6M14.5 3.2V6M9.5 18v2.8M14.5 18v2.8M3.2 9.5H6M3.2 14.5H6M18 9.5h2.8M18 14.5h2.8"/>',
  models: '<path d="M12 3.4l7.6 4.2v8.8L12 20.6l-7.6-4.2V7.6z"/><path d="M4.7 7.8L12 11.9l7.3-4.1M12 11.9v8.5"/>',
  recipe: '<rect x="3.2" y="4.2" width="7.4" height="5.8" rx="1.5"/><rect x="13.4" y="14" width="7.4" height="5.8" rx="1.5"/><path d="M10.6 7.1c3.4 0 0 9.8 2.8 9.8"/>',
  undo: '<path d="M4 9h10.2A5.8 5.8 0 0 1 20 14.8v0A5.8 5.8 0 0 1 14.2 20.6H8"/><path d="M8 4.6L3.6 9l4.4 4.4"/>',
  redo: '<path d="M20 9H9.8A5.8 5.8 0 0 0 4 14.8v0a5.8 5.8 0 0 0 5.8 5.8H16"/><path d="M16 4.6L20.4 9 16 13.4"/>',
  fit: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>',
  'zoom-in': '<circle cx="10.6" cy="10.6" r="6.6"/><path d="M15.4 15.4l4.8 4.8M10.6 7.8v5.6M7.8 10.6h5.6"/>',
  'zoom-out': '<circle cx="10.6" cy="10.6" r="6.6"/><path d="M15.4 15.4l4.8 4.8M7.8 10.6h5.6"/>',
  refresh: '<path d="M19.4 12a7.4 7.4 0 1 1-2.2-5.2"/><path d="M19.6 4.4v4.2h-4.2"/>',
  link: '<path d="M10.2 13.8a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.7 1.7"/><path d="M13.8 10.2a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.7-1.7"/>',
  image: '<rect x="3.2" y="4.6" width="17.6" height="14.8" rx="2.4"/><circle cx="8.5" cy="9.6" r="1.7"/><path d="M3.6 16.4l4.6-4.1a1.8 1.8 0 0 1 2.4 0l3.6 3.3M13.6 14.2l1.9-1.7a1.8 1.8 0 0 1 2.4 0l2.5 2.2"/>',
  video: '<rect x="2.8" y="5.4" width="13" height="13.2" rx="2.2"/><path d="M15.8 10.6l4-2.5a.8.8 0 0 1 1.3.7v6.4a.8.8 0 0 1-1.3.7l-4-2.5z"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3.4"/>' + dot(8.6, 8.6, 1.2) + dot(15.4, 8.6, 1.2) + dot(12, 12, 1.2) + dot(8.6, 15.4, 1.2) + dot(15.4, 15.4, 1.2),
  fullscreen: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  window: '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.2"/><path d="M3.6 8.6h16.8"/>',
  // the player's « extract this frame » (SPEC §14)
  camera: '<path d="M3.6 8.6a1.8 1.8 0 0 1 1.8-1.8h2.4l1.5-2.2h5.4l1.5 2.2h2.4a1.8 1.8 0 0 1 1.8 1.8v9a1.8 1.8 0 0 1-1.8 1.8H5.4a1.8 1.8 0 0 1-1.8-1.8z"/><circle cx="12" cy="12.8" r="3.5"/>',
  // playback speed: a dial
  speed: '<path d="M4.3 17.2a8.6 8.6 0 1 1 15.4 0"/><path d="M12 13.6l4.2-4.6"/>' + dot(12, 13.6, 1.6),
  // several pictures that lead a video (ref2v, SPEC §17)
  refs: '<rect x="8" y="8" width="12.4" height="11.6" rx="2"/><path d="M4.6 15.6V6.2a2 2 0 0 1 2-2h9.2"/><path d="M8.4 17l3.2-2.9a1.4 1.4 0 0 1 1.9 0l2.2 2M15.6 15.6l1.1-1a1.4 1.4 0 0 1 1.9 0l1.6 1.5"/>',
  // a video that follows a guide (depth, edges): a frame and a dashed path
  guided: '<rect x="3.2" y="4.8" width="17.6" height="14.4" rx="2.4"/><path d="M6.4 15.6c1.8-4.6 3.8-5.4 5.4-2.6s3.6 2.4 5.8-2.8" stroke-dasharray="2.2 2.4"/>',
  // a section of the board — Slate's frame glyph
  section: '<path d="M7.2 3v18M16.8 3v18M3 7.2h18M3 16.8h18"/>',
  'g-frame': '<path d="M7.2 3v18M16.8 3v18M3 7.2h18M3 16.8h18"/>',   // the board's « Section » (dock, menus)
  // assistants (Claude, Codex) driving Mia
  chat: '<path d="M4.4 6.8a2.2 2.2 0 0 1 2.2-2.2h10.8a2.2 2.2 0 0 1 2.2 2.2v7.2a2.2 2.2 0 0 1-2.2 2.2H11l-4.2 3.4v-3.4h-.2a2.2 2.2 0 0 1-2.2-2.2z"/>',
  // a LoRA: a character or a place taught to a model
  lora: '<circle cx="12" cy="8.6" r="3.6"/><path d="M5.2 19.6a6.8 6.8 0 0 1 13.6 0"/>'
};

const NS = 'http://www.w3.org/2000/svg';
const TARGET = 16.6;          // units of a 24 box every glyph should span
const fitted = new Map();     // name → fitted markup (size-independent)
const warned = new Set();

/**
 * One SVG string for `name`, `size` px square. Unknown names draw a small
 * neutral square, so a missing glyph never breaks a layout.
 */
export function icon(name, size = 16) {
  let svg = fitted.get(name);
  if (!svg) {
    const raw = RAW[name];
    if (raw === undefined) {
      if (!warned.has(name)) { warned.add(name); console.warn(`[icons] icône inconnue : ${name}`); }
      svg = wrap('<rect x="7" y="7" width="10" height="10" rx="2.4" opacity=".5"/>');
    } else {
      svg = fitGlyph(wrap(raw));
      // fitting needs a document; before that, use the raw glyph and try again later
      if (document.body) fitted.set(name, svg);
    }
  }
  const s = String(size);
  return svg.replace(/width="[^"]*"/, `width="${s}"`).replace(/height="[^"]*"/, `height="${s}"`);
}

/** Is `name` a known glyph? */
export const hasIcon = (name) => name in RAW;

/**
 * Add glyphs: `{ name: '<path d="…"/>' }` (inner markup of a 24 box, drawn
 * with the shared head: 1.7 stroke, round ends) or a full `<svg>` string.
 * Registering an existing name replaces it.
 */
export function register(map) {
  if (!map) return;
  for (const [name, markup] of Object.entries(map)) {
    if (typeof markup !== 'string') continue;
    RAW[name] = markup;
    fitted.delete(name);
  }
}

// ── optical sizing ────────────────────────────────────────────────────
// Every glyph is drawn inside a 24 box, but none of them fills it the same
// way: a check spans 14 units, a folder 17. Side by side in a toolbar that
// reads as ragged. One hidden measurement rescales each glyph to the same
// optical size and centres it, and the stroke width is divided by the same
// factor so the line weight never changes.
let probe = null;

/** Refit one inline SVG into a centred 24 box. Returns it unchanged if it cannot. */
export function fitGlyph(markup, target = TARGET, baseStroke = 1.7) {
  const m = /^(<svg\b[^>]*>)([\s\S]*)<\/svg>$/.exec(String(markup).trim());
  if (!m || typeof document === 'undefined' || !document.body) return markup;

  const box = (/viewBox="([^"]+)"/.exec(m[1]) || [, '0 0 24 24'])[1];
  if (!probe) {
    probe = document.createElementNS(NS, 'svg');
    probe.setAttribute('aria-hidden', 'true');
    probe.setAttribute('style', 'position:absolute;left:-999px;top:-999px;width:48px;height:48px;opacity:0;pointer-events:none');
  }
  probe.setAttribute('viewBox', box);
  probe.innerHTML = m[2];
  document.body.append(probe);

  let b;
  try { b = probe.getBBox(); } catch { b = null; }
  probe.remove();
  probe.innerHTML = '';
  if (!b || !b.width || !b.height) return markup;

  const k = target / Math.max(b.width, b.height);
  const dx = 12 - (b.x + b.width / 2) * k;
  const dy = 12 - (b.y + b.height / 2) * k;
  let head = m[1].replace(/viewBox="[^"]+"/, 'viewBox="0 0 24 24"');
  head = /stroke-width="/.test(head)
    ? head.replace(/stroke-width="[^"]+"/, 'stroke-width="' + (baseStroke / k).toFixed(3) + '"')
    : head.replace(/^<svg\b/, '<svg stroke-width="' + (baseStroke / k).toFixed(3) + '"');

  return head + '<g transform="translate(' + dx.toFixed(2) + ' ' + dy.toFixed(2) +
    ') scale(' + k.toFixed(4) + ')">' + m[2] + '</g></svg>';
}

/**
 * Mia's mark, « Le fil » (assets/src/app-icon.svg): an M drawn in one stroke whose
 * valley is exactly a Mia wire. `size` px, currentColor. `tight` crops the
 * box to the glyph for small sizes (title bar) — and thins the stroke so it
 * matches Slate's mark beside it.
 */
export function logo(size = 20, { tight = true } = {}) {
  // the glyph spans ~3/4 of the box, like Slate's mark beside its tabs
  const box = tight ? '6 14 244 244' : '0 0 256 256';
  const sw = tight ? 25 : 28;
  return `<svg viewBox="${box}" width="${size}" height="${size}" fill="none" aria-hidden="true" focusable="false">` +
    `<path d="M50 202V70C108 70 82 166 128 166S148 70 206 70V202" stroke="currentColor" stroke-width="${sw}" ` +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

export default { icon, register, fitGlyph, hasIcon, logo };
