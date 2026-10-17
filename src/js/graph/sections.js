// ── Sections « comme dans Slate » (SPEC §15) ──────────────────────────
// Un cadre arrondi teinté, son nom en gras au-dessus du coin haut-gauche.
// Comme dans Slate (render.js drawFrame), les sections sont *peintes* sur le
// canevas de la grille, sous les blocs et les fils : zoomer ou déplacer la vue
// ne touche aucun élément du DOM. On les attrape par leur titre ou leur bord
// (test géométrique ici), jamais par leur intérieur — un clic dedans reste un
// clic sur la planche (sélection au rectangle).
//
// Données : graph.groups[] = { id, x, y, w, h, title, tone } ; tone = clé de
// teinte ou null (= l'accent).

import { GRID } from './doc.js';

export const SECTION_MIN_W = 120;
export const SECTION_MIN_H = 80;
export const SECTION_MARGIN = 48;         // Ctrl+G : marge autour de la sélection

// Palette des cadres de Slate (palette.js FRAME_TINT), plus le rose des projets. null = l'accent (teinte par
// défaut, « Bleu »). Le menu suit l'ordre des couleurs de projet (home.js FOLDER_COLORS) : TONE_MENU.
export const TONES = ['grey', 'teal', 'green', 'yellow', 'orange', 'red', 'pink'];
export const TONE_MENU = ['grey', null, 'teal', 'green', 'yellow', 'orange', 'red', 'pink'];
const TONE_HEX = {
  dark: { grey: '#8a90a2', teal: '#49d2c4', green: '#7be08a', yellow: '#ffd84d', orange: '#ff9f45', red: '#ff6b6b', pink: '#f28fc8', lavender: '#a98bff' },
  // thème clair : mêmes teintes, assombries pour rester lisibles sur blanc
  light: { grey: '#6b7080', teal: '#18998d', green: '#3c9a4e', yellow: '#b08a12', orange: '#d0701a', red: '#d14646', pink: '#c04f8f', lavender: '#7a5fd6' }
};
// anciennes clés (première version de Mia) → teintes de Slate
const LEGACY = { sand: 'yellow', clay: 'orange', sage: 'green', blue: null };

export const toneKey = (tone) => (tone && tone in LEGACY ? LEGACY[tone] : tone || null);

/** Couleur d'une teinte pour le thème courant (`accent` = couleur d'accent lue dans les tokens). */
export function toneColor(tone, theme, accent) {
  const k = toneKey(tone);
  if (!k) return accent;
  return TONE_HEX[theme]?.[k] || TONE_HEX.dark[k] || accent;
}

/** « #4d82f3 » + alpha → « rgba(…) » (les teintes viennent de tokens hexadécimaux ou rgb). */
export function withAlpha(color, a) {
  const c = String(color || '').trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3);
    return `rgba(${p.join(', ')}, ${a})`;
  }
  return c;
}

/** Corps du titre à l’écran : 15 px, borné comme dans Slate (40 px monde), jamais sous 12 px ; 13 px en vue lointaine (au-dessus des titres de blocs, 12 px). */
export const titlePx = (z, lod = 0) => (lod >= 2 ? 13 : Math.max(12, Math.min(15, 40 * z)));
/** Écart écran entre le cadre et la ligne de base du titre ; en vue lointaine, il monte au-dessus des titres des blocs. */
export const titleLift = (lod) => (lod >= 2 ? 27 : 7);

// ── test au pointeur ─────────────────────────────────────────────────

const EDGE = 5;          // px écran de part et d'autre du filet : redimensionner
const BAND = 14;         // px écran à l'intérieur du filet : déplacer
const CORNER = 10;       // px écran : coin

/**
 * Ce qu'il y a sous le point écran `p` : { id, part } avec part =
 * 'title' | 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se', ou null.
 * Les sections du dessus (dernières de la liste) gagnent ; un titre gagne sur un bord.
 * `titleW(g)` = largeur écran du titre (mesurée par le peintre).
 */
export function hitSection(groups, cam, p, { lod = 0, titleW = () => 80 } = {}) {
  const z = cam.z;
  const fs = titlePx(z, lod), lift = titleLift(lod);
  // titres d'abord
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    const s = cam.toScreen(g.x, g.y);
    const w = Math.min(Math.max(titleW(g), 40) + 10, Math.max(40, g.w * z + 40));
    if (p.x >= s.x - 4 && p.x <= s.x + w && p.y <= s.y - lift + fs * 0.35 && p.y >= s.y - lift - fs - 5) return { id: g.id, part: 'title' };
  }
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    const a = cam.toScreen(g.x, g.y), b = cam.toScreen(g.x + g.w, g.y + g.h);
    if (p.x < a.x - EDGE || p.x > b.x + EDGE || p.y < a.y - EDGE || p.y > b.y + EDGE) continue;
    const nearL = Math.abs(p.x - a.x) <= EDGE, nearR = Math.abs(p.x - b.x) <= EDGE;
    const nearT = Math.abs(p.y - a.y) <= EDGE, nearB = Math.abs(p.y - b.y) <= EDGE;
    const cL = p.x - a.x <= CORNER, cR = b.x - p.x <= CORNER, cT = p.y - a.y <= CORNER, cB = b.y - p.y <= CORNER;
    if ((nearT || nearL) && cT && cL) return { id: g.id, part: 'nw' };
    if ((nearT || nearR) && cT && cR) return { id: g.id, part: 'ne' };
    if ((nearB || nearL) && cB && cL) return { id: g.id, part: 'sw' };
    if ((nearB || nearR) && cB && cR) return { id: g.id, part: 'se' };
    if (nearT) return { id: g.id, part: 'n' };
    if (nearB) return { id: g.id, part: 's' };
    if (nearL) return { id: g.id, part: 'w' };
    if (nearR) return { id: g.id, part: 'e' };
    const inside = p.x > a.x && p.x < b.x && p.y > a.y && p.y < b.y;
    const inner = p.x > a.x + BAND && p.x < b.x - BAND && p.y > a.y + BAND && p.y < b.y - BAND;
    if (inside && !inner) return { id: g.id, part: 'move' };
  }
  return null;
}

export const CURSORS = {
  title: 'grab', move: 'grab',
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize'
};

/** Nouvelle boîte d'une section tirée par la poignée `part` de (dx, dy) monde. */
export function resizeBox(g0, part, dx, dy, snapFn = null) {
  let { x, y, w, h } = g0;
  let x1 = x + w, y1 = y + h;
  if (part.includes('w')) x += dx;
  if (part.includes('e')) x1 += dx;
  if (part.includes('n')) y += dy;
  if (part.includes('s')) y1 += dy;
  if (snapFn) {
    if (part.includes('w')) x = snapFn(x);
    if (part.includes('e')) x1 = snapFn(x1);
    if (part.includes('n')) y = snapFn(y);
    if (part.includes('s')) y1 = snapFn(y1);
  }
  if (x1 - x < SECTION_MIN_W) { if (part.includes('w')) x = x1 - SECTION_MIN_W; else x1 = x + SECTION_MIN_W; }
  if (y1 - y < SECTION_MIN_H) { if (part.includes('n')) y = y1 - SECTION_MIN_H; else y1 = y + SECTION_MIN_H; }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(x1 - x), h: Math.round(y1 - y) };
}

// ── appartenance ─────────────────────────────────────────────────────

const contains = (o, b) => b.x >= o.x && b.y >= o.y && b.x + b.w <= o.x + o.w && b.y + b.h <= o.y + o.h;
const centerIn = (o, b) => {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return cx > o.x && cx < o.x + o.w && cy > o.y && cy < o.y + o.h;
};

/** Blocs et sections *entièrement* dans la section `g` (ils voyagent avec elle). */
export function membersOf(g, nodes, groups, boxOf) {
  const nodeIds = [];
  for (const n of nodes) { const b = boxOf(n.id); if (b && contains(g, b)) nodeIds.push(n.id); }
  const groupIds = groups.filter((o) => o.id !== g.id && contains(g, o)).map((o) => o.id);
  return { nodeIds, groupIds };
}

/** La plus petite section dont l'aire contient le centre de `b` (celle où un bloc lâché « entre »). */
export function sectionAt(groups, b, exclude = null) {
  let best = null;
  for (const g of groups) {
    if (exclude && exclude.has(g.id)) continue;
    if (!centerIn(g, b)) continue;
    if (!best || g.w * g.h < best.w * best.h) best = g;
  }
  return best;
}

/**
 * Un bloc lâché avec son centre dans une section y entre : si une partie
 * dépasse, la section s'agrandit pour l'envelopper (marge d'un pas de grille).
 * Modifie les sections sur place ; renvoie true si l'une a changé.
 */
export function adopt(groups, boxes, exclude = null) {
  let changed = false;
  for (const b of boxes) {
    const g = sectionAt(groups, b, exclude);
    if (!g || contains(g, b)) continue;
    const x0 = Math.min(g.x, Math.floor((b.x - GRID) / GRID) * GRID);
    const y0 = Math.min(g.y, Math.floor((b.y - GRID) / GRID) * GRID);
    const x1 = Math.max(g.x + g.w, Math.ceil((b.x + b.w + GRID) / GRID) * GRID);
    const y1 = Math.max(g.y + g.h, Math.ceil((b.y + b.h + GRID) / GRID) * GRID);
    g.x = x0; g.y = y0; g.w = x1 - x0; g.h = y1 - y0;
    changed = true;
  }
  return changed;
}

/** Boîte d'une section autour d'une boîte de blocs, marge de 48 px posée sur la grille. */
export function boxAround(b, margin = SECTION_MARGIN) {
  const x0 = Math.floor((b.x - margin) / GRID) * GRID, y0 = Math.floor((b.y - margin) / GRID) * GRID;
  const x1 = Math.ceil((b.x + b.w + margin) / GRID) * GRID, y1 = Math.ceil((b.y + b.h + margin) / GRID) * GRID;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ── peinture (canevas de la grille, coordonnées écran) ───────────────

/**
 * Peint les sections. `st` = { theme, accent, font, lod, selId, hotId, dropId,
 * editingId, ghost, born } ; renvoie Map id → largeur écran du titre (pour le test au pointeur).
 * `born` = Map id → avancement 0..1 d'une section qui vient de naître : son cadre se
 * resserre de 1,5 % vers sa taille et son titre monte de 4 px en fondu (SPEC §20.1).
 */
export function paintSections(ctx, cam, groups, st, label) {
  const z = cam.z;
  const fs = titlePx(z, st.lod), lift = titleLift(st.lod);
  const widths = new Map();
  const list = st.ghost ? [...groups, st.ghost] : groups;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  for (const g of list) {
    const a = cam.toScreen(g.x, g.y);
    const w = g.w * z, h = g.h * z;
    if (a.x > ctx.canvas.__w + 40 || a.y > ctx.canvas.__h + 40 || a.x + w < -400 || a.y + h < -60) {
      widths.set(g.id, 80);
      continue;
    }
    const tint = toneColor(g.tone, st.theme, st.accent);
    const sel = g.id === st.selId, hot = g.id === st.hotId || g.id === st.dropId;
    const k = st.born?.get(g.id);
    const forming = k != null && k < 1;
    let bx = a.x, by = a.y, bw = w, bh = h;
    if (forming) {
      const sc = 1.015 - 0.015 * k;
      bw = w * sc; bh = h * sc; bx = a.x - (bw - w) / 2; by = a.y - (bh - h) / 2;
      ctx.globalAlpha = 0.6 + 0.4 * k;
    }
    const r = Math.min(14 * z, bw / 2, bh / 2);
    ctx.beginPath();
    roundRect(ctx, bx, by, bw, bh, r);
    ctx.fillStyle = withAlpha(tint, g === st.ghost ? 0.08 : g.id === st.dropId ? 0.085 : 0.05);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = sel ? st.accentSel : withAlpha(tint, hot ? 0.75 : 0.5);
    if (sel) ctx.lineWidth = 2;
    ctx.stroke();
    if (g === st.ghost || g.id === st.editingId) { widths.set(g.id, 120); ctx.globalAlpha = 1; continue; }
    const text = g.title || label;
    ctx.font = `700 ${fs}px ${st.font}`;
    // Un titre peut dépasser sa section (Slate : 260 px de prise) — en vue lointaine, c'est lui qui
    // porte la lecture — mais jamais mordre sur une section voisine à droite (son titre ou son cadre).
    // en vue lointaine (lod ≥ 2), le titre entier ; de près, au moins 260 px
    let max = st.lod >= 2 ? Infinity : Math.max(260, w + 40);
    const ty0 = a.y - lift - fs - 4, ty1 = a.y - lift + 4;
    for (const o of list) {
      if (o === g) continue;
      const b = cam.toScreen(o.x, o.y);
      if (b.x <= a.x + 1) continue;
      if (b.y + o.h * z < ty0 || b.y - lift - fs - 4 > ty1) continue;
      max = Math.min(max, b.x - a.x - 12);
    }
    max = Math.max(60, max);
    const shown = ellipsize(ctx, text, max);
    ctx.fillStyle = withAlpha(tint, 0.95);
    if (forming) ctx.globalAlpha = k;
    ctx.fillText(shown, a.x + 2, a.y - lift + (forming ? (1 - k) * 4 : 0));
    ctx.globalAlpha = 1;
    widths.set(g.id, Math.min(max, ctx.measureText(shown).width + 4));
  }
  return widths;
}

const cutCache = new Map();
/** Coupe `text` avec « … » pour tenir dans `max` px (mesures mises en cache). */
export function ellipsize(ctx, text, max) {
  const key = `${ctx.font}|${text}|${Math.round(max / 4)}`;
  const hitC = cutCache.get(key);
  if (hitC !== undefined) return hitC;
  let out = text;
  if (ctx.measureText(text).width > max) {
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(text.slice(0, mid) + '…').width <= max) lo = mid; else hi = mid - 1;
    }
    out = lo > 0 ? text.slice(0, lo).trimEnd() + '…' : '';
  }
  if (cutCache.size > 4000) cutCache.clear();
  cutCache.set(key, out);
  return out;
}

export function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) ctx.roundRect(x, y, Math.max(0, w), Math.max(0, h), Math.max(0, r));
  else ctx.rect(x, y, w, h);
}
