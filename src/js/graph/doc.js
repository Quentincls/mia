// ── Modèle du graphe ──────────────────────────────────────────────────
// Le document tel qu'il s'écrit dans graph.json (SPEC §3.2) : blocs, fils,
// sections, caméra. Les propriétés préfixées `_` sont des caches d'affichage
// (hauteur mesurée, ancres des ports…) : elles ne sortent jamais d'ici.
//
// `normalize` est idempotent, comme dans Slate : re-normaliser un objet déjà
// normalisé le rend tel quel. Sans ça, un appelant qui garde une référence
// (le geste qui vient de créer le bloc) éditerait un fantôme.

import { uid } from '../util.js';
import { typeOf, defaults } from '../catalog.js';

export const NODE_MIN_W = 216;
export const NODE_MAX_W = 720;
export const GRID = 24;
/** Format de graph.json écrit par cet éditeur (SPEC §21.1 ; electron/migrations.js en tient la chaîne). */
export const GRAPH_VERSION = 1;

/** Copie superficielle sans les clés `_` (caches). */
export function plain(o) {
  const out = {};
  for (const k in o) if (k.charCodeAt(0) !== 95) out[k] = o[k];
  return out;
}
function persistable() { return plain(this); }
function mark(o) {
  Object.defineProperty(o, 'toJSON', { value: persistable, enumerable: false, configurable: true, writable: true });
  return o;
}
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const clampW = (w) => Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, Math.round(num(w, 288))));

/**
 * Un bloc complet : tous ses réglages présents (défauts du catalogue + valeurs choisies).
 * `round` : positions entières (bloc neuf). À la lecture d'une planche, on garde les positions
 * telles quelles (un glisser pose des demi-pixels) : un arrondi au chargement comptait comme une
 * modification (graph.json et son .bak réécrits, « Modifiée » sans rien avoir touché).
 */
export function normalizeNode(n, round = true) {
  if (n && n.toJSON === persistable) return n;
  const src = n || {};
  const type = typeOf(src.type);
  const o = {
    id: src.id || uid('n_'),
    type: String(src.type || 'note'),
    x: round ? Math.round(num(src.x)) : num(src.x),
    y: round ? Math.round(num(src.y)) : num(src.y),
    w: clampW(src.w ?? type?.width ?? 288),
    title: typeof src.title === 'string' && src.title.trim() ? src.title.trim() : null,
    // les réglages inconnus du catalogue sont gardés : un type qui évolue ne
    // doit pas effacer ce que Quentin avait réglé
    params: { ...defaults(src.type), ...(isObj(src.params) ? src.params : {}) },
    data: isObj(src.data) ? { ...src.data } : {},
    pinnedRun: src.pinnedRun || null,
    collapsed: !!src.collapsed,
    bypass: !!src.bypass
  };
  // propriétés en plus (écrites par une version future) : on les laisse passer
  for (const k in src) if (!(k in o) && k.charCodeAt(0) !== 95) o[k] = src[k];
  return mark(o);
}

export function normalizeEdge(e) {
  if (e && e.toJSON === persistable) return e;
  return mark({
    id: e.id || uid('e_'),
    from: { node: String(e.from?.node), port: String(e.from?.port) },
    to: { node: String(e.to?.node), port: String(e.to?.port) }
  });
}

export function normalizeGroup(g, round = true) {
  if (g && g.toJSON === persistable) return g;
  const pos = (v) => (round ? Math.round(num(v)) : num(v));
  return mark({
    id: g.id || uid('g_'),
    x: pos(g.x), y: pos(g.y),
    w: Math.max(120, Math.round(num(g.w, 480))), h: Math.max(80, Math.round(num(g.h, 320))),
    title: typeof g.title === 'string' ? g.title : '',
    tone: g.tone || null
  });
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function sanitizeCamera(c) {
  const z = num(c?.z ?? c?.zoom, 1);
  return { x: num(c?.x), y: num(c?.y), z: z > 0 ? z : 1 };
}

export class GraphDoc {
  constructor(graph = {}) { this.restore(graph, true); }

  /**
   * Remplace tout le contenu. Les fils dont un bout manque et les doublons sont
   * écartés : un graph.json abîmé ne doit pas planter l'éditeur.
   */
  restore(g = {}, withCamera = false) {
    this.version = GRAPH_VERSION;
    if (withCamera) this.camera = sanitizeCamera(g.camera);
    this.nodes = (Array.isArray(g.nodes) ? g.nodes : []).filter((n) => n && n.type).map((n) => normalizeNode(n, false));
    this._nodes = new Map(this.nodes.map((n) => [n.id, n]));
    const seen = new Set();
    this.edges = [];
    for (const raw of Array.isArray(g.edges) ? g.edges : []) {
      if (!raw?.from || !raw?.to) continue;
      const e = normalizeEdge(raw);
      const key = `${e.from.node}.${e.from.port}>${e.to.node}.${e.to.port}`;
      if (seen.has(key) || !this._nodes.has(e.from.node) || !this._nodes.has(e.to.node)) continue;
      seen.add(key);
      this.edges.push(e);
    }
    this._edges = new Map(this.edges.map((e) => [e.id, e]));
    this.groups = (Array.isArray(g.groups) ? g.groups : []).filter(Boolean).map((x) => normalizeGroup(x, false));
    this._groups = new Map(this.groups.map((x) => [x.id, x]));
  }

  node(id) { return this._nodes.get(id) || null; }
  edge(id) { return this._edges.get(id) || null; }
  group(id) { return this._groups.get(id) || null; }

  addNode(n) {
    const node = normalizeNode(n);
    if (this._nodes.has(node.id)) node.id = uid('n_');
    this.nodes.push(node);
    this._nodes.set(node.id, node);
    return node;
  }

  /** Retire un bloc et tous ses fils ; renvoie ce qui a été retiré. */
  removeNode(id) {
    const node = this._nodes.get(id);
    if (!node) return null;
    this.nodes.splice(this.nodes.indexOf(node), 1);
    this._nodes.delete(id);
    const gone = this.edges.filter((e) => e.from.node === id || e.to.node === id);
    for (const e of gone) this.removeEdge(e.id);
    return { node, edges: gone };
  }

  addEdge(e) {
    const edge = normalizeEdge(e);
    if (this._edges.has(edge.id)) edge.id = uid('e_');
    this.edges.push(edge);
    this._edges.set(edge.id, edge);
    return edge;
  }

  removeEdge(id) {
    const e = this._edges.get(id);
    if (!e) return null;
    this.edges.splice(this.edges.indexOf(e), 1);
    this._edges.delete(id);
    return e;
  }

  addGroup(g) {
    const group = normalizeGroup(g);
    this.groups.push(group);
    this._groups.set(group.id, group);
    return group;
  }

  removeGroup(id) {
    const g = this._groups.get(id);
    if (!g) return null;
    this.groups.splice(this.groups.indexOf(g), 1);
    this._groups.delete(id);
    return g;
  }

  /** Fils qui arrivent sur un bloc (sur un port précis si `port`). */
  edgesTo(nodeId, port) {
    return this.edges.filter((e) => e.to.node === nodeId && (port == null || e.to.port === port));
  }
  /** Fils qui partent d'un bloc (d'un port précis si `port`). */
  edgesFrom(nodeId, port) {
    return this.edges.filter((e) => e.from.node === nodeId && (port == null || e.from.port === port));
  }
  edgesOf(nodeId) {
    return this.edges.filter((e) => e.from.node === nodeId || e.to.node === nodeId);
  }

  /** Tous les blocs en aval (sans `id` lui-même). */
  downstream(id) {
    const out = new Set();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      for (const e of this.edges) {
        if (e.from.node === cur && !out.has(e.to.node)) { out.add(e.to.node); stack.push(e.to.node); }
      }
    }
    return out;
  }
  /** Tous les blocs en amont (sans `id` lui-même). */
  upstream(id) {
    const out = new Set();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      for (const e of this.edges) {
        if (e.to.node === cur && !out.has(e.from.node)) { out.add(e.from.node); stack.push(e.from.node); }
      }
    }
    return out;
  }

  /** Le contenu sans la caméra : ce que l'historique compare et restaure. */
  content() {
    return { nodes: this.nodes.map(plain), edges: this.edges.map(plain), groups: this.groups.map(plain) };
  }

  /** Instantané sérialisable (graph.json), sans caches. */
  toJSON() {
    return { version: GRAPH_VERSION, camera: { ...this.camera }, ...this.content() };
  }
}
