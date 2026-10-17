// ── Placement automatique et rangement ────────────────────────────────
// Trois outils de géométrie pure (aucun DOM) :
//  - `freeOffset` : le décalage le plus court qui pose une boîte (une recette,
//    une colonne de médias, un bloc ajouté par un assistant) sans toucher les
//    blocs déjà là ;
//  - `settleColumns` : pousse vers le bas ce qui se chevauche dans une même
//    colonne (une carte qui a grandi en recevant son image) ;
//  - `layered` : rangement gauche → droite selon les fils (couches, ordre par
//    barycentre), pour « Ranger » et le pont des assistants.

import { GRID } from './doc.js';

export const GAP = GRID * 2;          // 48 : écart entre deux blocs posés par Mia
const H_GAP = GRID * 4;               // 96 : écart entre deux colonnes rangées

const overlaps = (a, b, pad = 0) =>
  a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;

/**
 * Plus petit décalage {dx, dy} qui pose `box` à au moins `pad` de chaque
 * obstacle. Candidats : la place d'origine, puis les positions collées aux
 * bords des obstacles proches (à droite, en dessous, à gauche, au-dessus),
 * alignées sur la grille. `prefer` pèse la direction : 'right' (un bloc qui
 * suit un autre), 'below' (une colonne), 'any' (le plus court).
 */
export function freeOffset(box, obstacles, { pad = GRID, prefer = 'any' } = {}) {
  const near = obstacles.filter((o) => o && Math.abs(o.x + o.w / 2 - (box.x + box.w / 2)) < 6000 && Math.abs(o.y + o.h / 2 - (box.y + box.h / 2)) < 6000);
  const free = (x, y) => {
    const b = { x, y, w: box.w, h: box.h };
    for (const o of near) if (overlaps(b, o, pad - 0.5)) return false;
    return true;
  };
  if (free(box.x, box.y)) return { dx: 0, dy: 0 };
  const up = (v) => Math.ceil(v / GRID) * GRID, down = (v) => Math.floor(v / GRID) * GRID;
  const xs = new Set([box.x]), ys = new Set([box.y]);
  for (const o of near) {
    xs.add(up(o.x + o.w + pad)); xs.add(down(o.x - pad - box.w));
    ys.add(up(o.y + o.h + pad)); ys.add(down(o.y - pad - box.h));
  }
  const wx = prefer === 'below' ? 1.6 : 1, wy = prefer === 'right' ? 1.6 : 1;
  let best = null, bestCost = Infinity;
  const xl = [...xs], yl = [...ys];
  for (const x of xl) {
    const dx = x - box.x;
    for (const y of yl) {
      const dy = y - box.y;
      // on évite de reculer vers la gauche ou le haut quand on « suit » quelque chose
      let cost = Math.hypot(dx * wx, dy * wy);
      if (prefer === 'right' && dx < 0) cost *= 2.5;
      if (prefer === 'below' && dy < 0) cost *= 2.5;
      if (cost >= bestCost) continue;
      if (free(x, y)) { best = { dx, dy }; bestCost = cost; }
    }
  }
  if (best) return best;
  // tout est pris autour : sous l'ensemble
  let maxY = box.y;
  for (const o of near) maxY = Math.max(maxY, o.y + o.h + pad);
  return { dx: 0, dy: up(maxY) - box.y };
}

/**
 * Dans une même colonne (recouvrement horizontal), chaque boîte descend sous
 * celle du dessus si elles se chevauchent. `boxes` = [{id, x, y, w, h}] ;
 * renvoie Map id → nouvel y (seulement ce qui bouge). `fixed` = ids qui ne
 * bougent pas (la carte qui vient de grandir pousse, elle n'est pas poussée).
 */
export function settleColumns(boxes, { gap = GRID, fixed = new Set() } = {}) {
  const list = boxes.map((b) => ({ ...b })).sort((a, b) => a.y - b.y || a.x - b.x);
  const moved = new Map();
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (fixed.has(b.id)) continue;
    let y = b.y;
    for (let k = 0; k < 4; k++) {
      let bump = y;
      for (let j = 0; j < list.length; j++) {
        if (j === i) continue;
        const o = list[j];
        // seules les boîtes déjà réglées (au-dessus, ou fixes) poussent
        if (!(j < i || fixed.has(o.id))) continue;
        if (o.y > y) continue;
        if (overlaps({ ...b, y }, o, gap - 0.5)) bump = Math.max(bump, o.y + o.h + gap);
      }
      if (bump === y) break;
      y = bump;
    }
    if (y !== b.y) { moved.set(b.id, y); b.y = y; }
  }
  return moved;
}

/**
 * Rangement en couches de gauche à droite. `nodes` = [{id, x, y, w, h}],
 * `edges` = [{from, to, port}] (port = index de l'entrée visée, pour ordonner
 * « début, fin, consigne » de haut en bas). Renvoie Map id → {x, y}.
 */
export function layered(nodes, edges, { origin = null, hGap = H_GAP, vGap = GAP } = {}) {
  if (!nodes.length) return new Map();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const E = edges.filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);
  const preds = new Map(nodes.map((n) => [n.id, []]));
  const succs = new Map(nodes.map((n) => [n.id, []]));
  for (const e of E) { preds.get(e.to).push(e); succs.get(e.from).push(e); }

  // ordre topologique (Kahn) ; un cycle (impossible en principe) est cassé par y
  const indeg = new Map(nodes.map((n) => [n.id, preds.get(n.id).length]));
  const queue = nodes.filter((n) => !indeg.get(n.id)).sort((a, b) => a.y - b.y).map((n) => n.id);
  const topo = [];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    topo.push(id);
    for (const e of succs.get(id)) {
      indeg.set(e.to, indeg.get(e.to) - 1);
      if (indeg.get(e.to) <= 0) queue.push(e.to);
    }
  }
  for (const n of nodes) if (!seen.has(n.id)) topo.push(n.id);

  // couche = plus long chemin depuis une source…
  const layer = new Map();
  for (const id of topo) {
    let l = 0;
    for (const e of preds.get(id)) if (layer.has(e.from)) l = Math.max(l, layer.get(e.from) + 1);
    layer.set(id, l);
  }
  // …puis chaque bloc se rapproche de ce qu'il alimente (une source ne reste pas
  // à l'extrême gauche si elle ne sert qu'au dernier bloc)
  for (let i = topo.length - 1; i >= 0; i--) {
    const id = topo[i];
    const s = succs.get(id);
    if (!s.length) continue;
    const m = Math.min(...s.map((e) => layer.get(e.to))) - 1;
    if (m > layer.get(id)) layer.set(id, m);
  }

  const nL = Math.max(...layer.values()) + 1;
  const cols = Array.from({ length: nL }, () => []);
  for (const n of nodes) cols[layer.get(n.id)].push(n.id);
  for (const c of cols) c.sort((a, b) => byId.get(a).y - byId.get(b).y);

  // ordre dans chaque colonne : barycentre des voisins (aller, retour, aller)
  const rank = new Map();
  const reRank = () => { for (const c of cols) c.forEach((id, i) => rank.set(id, i)); };
  reRank();
  const sortBy = (c, key) => {
    const k = new Map(c.map((id, i) => [id, key(id) ?? i]));
    c.sort((a, b) => k.get(a) - k.get(b) || rank.get(a) - rank.get(b));
  };
  const fromPreds = (id) => {
    const p = preds.get(id);
    return p.length ? p.reduce((s, e) => s + rank.get(e.from), 0) / p.length : null;
  };
  const fromSuccs = (id) => {
    const s = succs.get(id);
    return s.length ? s.reduce((t, e) => t + rank.get(e.to) + (e.port || 0) / 16, 0) / s.length : null;
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let l = 1; l < nL; l++) { sortBy(cols[l], fromPreds); reRank(); }
    for (let l = nL - 2; l >= 0; l--) { sortBy(cols[l], fromSuccs); reRank(); }
  }

  // coordonnées : colonnes côte à côte, chacune centrée sur la plus haute
  let x0 = Infinity, y0 = Infinity;
  for (const n of nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); }
  if (origin) { x0 = origin.x; y0 = origin.y; }
  const colW = cols.map((c) => Math.max(...c.map((id) => byId.get(id).w)));
  const colH = cols.map((c) => c.reduce((s, id) => s + byId.get(id).h, 0) + vGap * Math.max(0, c.length - 1));
  const H = Math.max(...colH);
  const out = new Map();
  let x = x0;
  cols.forEach((c, l) => {
    let y = y0 + (H - colH[l]) / 2;
    for (const id of c) {
      out.set(id, { x: Math.round(x / 2) * 2, y: Math.round(y / 2) * 2 });
      y += byId.get(id).h + vGap;
    }
    x += colW[l] + hGap;
  });
  return out;
}

export { overlaps };
