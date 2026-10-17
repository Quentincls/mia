// ── Fils ──────────────────────────────────────────────────────────────
// Tous les fils vivent dans un seul <svg id="wires"> de 1×1 px posé dans
// #world, `overflow: visible` : le déplacement et le zoom de la caméra ne
// coûtent rien par fil (ils suivent la transformation du parent). Chaque fil =
// un chemin de clic invisible et épais + le trait visible (+ un chemin de flux
// pendant un calcul). Les épaisseurs restent constantes à l'écran via `--z`
// (graph.css).

import { ms, play, reduced } from '../ui/motion.js';

const NS = 'http://www.w3.org/2000/svg';

// Bézier cubique à tangentes horizontales. Poussée proportionnelle à la distance,
// bornée pour que les fils courts restent souples et les longs ne fassent pas de ventre.
// (da.md §4.4, à l'identique)
export function wirePath(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = Math.abs(y2 - y1);
  let k = dx >= 0
    ? dx * 0.5                                   // cas normal (React Flow : 0,5 × distance)
    : 60 + Math.sqrt(-dx) * 6 + dy * 0.05;       // fil qui revient en arrière : boucle propre
  k = Math.min(Math.max(k, 36 + dy * 0.08), 260); // min 36 px (+ un peu si grand écart vertical), max 260 px
  return `M${x1},${y1} C${x1 + k},${y1} ${x2 - k},${y2} ${x2},${y2}`;
}

/** Même poussée que `wirePath`, pour retrouver les points de contrôle. */
function push(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = Math.abs(y2 - y1);
  let k = dx >= 0 ? dx * 0.5 : 60 + Math.sqrt(-dx) * 6 + dy * 0.05;
  return Math.min(Math.max(k, 36 + dy * 0.08), 260);
}

/** Point de la courbe au paramètre t (0..1), en unités monde. */
export function wirePoint(x1, y1, x2, y2, t = 0.5) {
  const k = push(x1, y1, x2, y2);
  const c1x = x1 + k, c2x = x2 - k, u = 1 - t;
  return {
    x: u * u * u * x1 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x2,
    y: u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2
  };
}

/**
 * Le même fil, mais tracé en coordonnées écran à partir de points monde :
 * l'aperçu d'un fil en cours de tirage (dans #overlay) a exactement la courbe
 * qu'il aura une fois posé, quel que soit le zoom.
 */
export function wirePathScreen(cam, a, b) {
  const k = push(a.x, a.y, b.x, b.y);
  const s = (x, y) => {
    const p = cam.toScreen(x, y);
    return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  };
  return `M${s(a.x, a.y)} C${s(a.x + k, a.y)} ${s(b.x - k, b.y)} ${s(b.x, b.y)}`;
}

const r1 = (v) => Math.round(v * 10) / 10;

export class WireLayer {
  /**
   * @param ed  contexte de l'éditeur : `doc`, `anchor(node, port, dir)`, `wireState(edge)`
   * @param svg <svg id="wires">
   */
  constructor(ed, svg) {
    this.ed = ed;
    this.svg = svg;
    this.items = new Map();
    svg.setAttribute('width', '1');
    svg.setAttribute('height', '1');
  }

  clear() {
    for (const rec of this.items.values()) { clearTimeout(rec.inT); rec.g.remove(); }
    this.items.clear();
    // les fils qui finissaient de partir (planche quittée) partent tout de suite
    for (const g of this.svg.querySelectorAll('.wire')) g.remove();
  }

  /**
   * Crée et retire les éléments pour coller au document, puis retrace tout. Un fil neuf
   * qui touche un bloc en train d'arriver naît avec lui (fondu) ; un fil qui disparaît
   * s'efface, ou se rétracte vers sa sortie si on vient de le couper (SPEC §20.1).
   */
  sync() {
    const live = new Set();
    const born = [];
    for (const e of this.ed.doc.edges) {
      live.add(e.id);
      if (!this.items.has(e.id)) born.push(this._create(e));
    }
    for (const [id, rec] of this.items) {
      if (!live.has(id)) { this._leave(id, rec); this.items.delete(id); }
    }
    this.updateAll();
    this.styleAll();
    for (const rec of born) {
      const e = this.ed.doc.edge(rec.g.dataset.id);
      if (!e) continue;
      const entering = (id) => !!this.ed.views.get(id)?.el.classList.contains('entering');
      if (entering(e.from.node) || entering(e.to.node)) {
        // classe passagère : style() la garde quand l'état du fil change (sélection juste après la pose)
        rec.fx = 'w-in';
        this.style(e);
        rec.inT = setTimeout(() => { rec.fx = ''; const e2 = this.ed.doc.edge(e.id); if (e2) this.style(e2); }, ms('enter') + 60);
      }
    }
  }

  /** Un fil part : coupé → il se rétracte vers sa sortie (160 ms) ; sinon (bloc supprimé) → fondu. */
  _leave(id, rec) {
    clearTimeout(rec.inT);
    const cut = this.ed.cutEdge === id;
    if (cut) this.ed.cutEdge = null;
    if (reduced() || !rec.d || !this.svg.isConnected) { rec.g.remove(); return; }
    // il n'est plus un fil de la planche : plus d'id (un Ctrl+Z qui le rend en recrée un neuf)
    rec.g.removeAttribute('data-id');
    rec.g.setAttribute('class', 'wire');
    rec.flow?.remove();
    if (cut) {
      // (pas « w-cut » : c'est la classe de la pastille « couper », avec son apparition en fondu)
      rec.g.classList.add('w-cutting');
      let len = 0;
      try { len = rec.line.getTotalLength(); } catch { len = 0; }
      if (len > 1) {
        rec.line.style.strokeDasharray = `${len} ${len}`;
        const a = play(rec.line, [{ strokeDashoffset: 0, opacity: 1 }, { strokeDashoffset: len, opacity: 0.4 }],
          { dur: 'exit', easing: 'cam', fill: 'forwards' });
        if (a) { a.finished.then(() => rec.g.remove(), () => rec.g.remove()); return; }
      }
      rec.g.remove();
      return;
    }
    rec.g.classList.add('w-out');
    setTimeout(() => rec.g.remove(), ms('pop') + 40);
  }

  _create(e) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'wire');
    g.dataset.id = e.id;
    const hit = document.createElementNS(NS, 'path');
    hit.setAttribute('class', 'w-hit');
    const line = document.createElementNS(NS, 'path');
    line.setAttribute('class', 'w-line');
    g.append(hit, line);
    this.svg.append(g);
    const rec = { g, hit, line, flow: null, d: '', cls: '', a: null, b: null, t: '', fx: '', inT: 0 };
    this.items.set(e.id, rec);
    return rec;
  }

  update(id) {
    const e = this.ed.doc.edge(id);
    const rec = this.items.get(id);
    if (!e || !rec) return;
    const a = this.ed.anchor(e.from.node, e.from.port, 'out');
    const b = this.ed.anchor(e.to.node, e.to.port, 'in');
    if (!a || !b) return;
    rec.a = a; rec.b = b;
    const d = wirePath(r1(a.x), r1(a.y), r1(b.x), r1(b.y));
    if (d === rec.d) return;
    rec.d = d;
    rec.hit.setAttribute('d', d);
    rec.line.setAttribute('d', d);
    if (rec.flow) rec.flow.setAttribute('d', d);
  }

  updateAll() { for (const id of this.items.keys()) this.update(id); }

  /** Retrace seulement les fils d'un bloc (déplacement, redimensionnement : O(degré)). */
  updateNode(nodeId) {
    for (const e of this.ed.doc.edges) {
      if (e.from.node === nodeId || e.to.node === nodeId) this.update(e.id);
    }
  }

  styleAll() { for (const e of this.ed.doc.edges) this.style(e); }

  styleNode(nodeId) {
    for (const e of this.ed.doc.edges) {
      if (e.from.node === nodeId || e.to.node === nodeId) this.style(e);
    }
  }

  /** Classes d'état d'un fil : chaud, en calcul (flux), périmé, désactivé, invalide, choisi. */
  style(e) {
    const rec = this.items.get(e.id);
    if (!rec) return;
    const s = this.ed.wireState(e);
    let cls = 'wire';
    if (s.hot) cls += ' hot';
    if (s.sel) cls += ' sel';
    if (s.run) cls += ' run';
    if (s.stale) cls += ' stale';
    if (s.bypass) cls += ' bypass';
    if (s.bad) cls += ' bad';
    if (s.dim) cls += ' dim';
    if (rec.fx) cls += ` ${rec.fx}`;
    if (cls !== rec.cls) { rec.cls = cls; rec.g.setAttribute('class', cls); }
    if (s.t !== rec.t) { rec.t = s.t; rec.g.dataset.t = s.t || ''; }
    if (s.run && !rec.flow) {
      rec.flow = document.createElementNS(NS, 'path');
      rec.flow.setAttribute('class', 'w-flow');
      rec.flow.setAttribute('d', rec.d);
      rec.g.append(rec.flow);
    } else if (!s.run && rec.flow) {
      // arrêt net à la fin du calcul (da.md : pas de fondu)
      rec.flow.remove();
      rec.flow = null;
    }
  }

  /** Milieu de la courbe (monde) : là où s'affiche la pastille « × ». */
  midpoint(id) {
    const rec = this.items.get(id);
    if (!rec?.a || !rec?.b) return null;
    return wirePoint(rec.a.x, rec.a.y, rec.b.x, rec.b.y, 0.5);
  }
}
