// ── Catalogue des blocs ───────────────────────────────────────────────
// Lit src/catalog/nodes.json et les recettes, et répond aux questions que tout
// le monde se pose sur un type de bloc : ses ports, ses réglages par défaut,
// ce qui peut se brancher sur quoi. Le fichier JSON est la seule source de
// vérité ; ce module ne fait que l'indexer.
//
// Il enregistre aussi les glyphes des blocs (da.md §4.11) : trait 1,7 sur une
// grille de 24, bouts ronds, même écriture que les icônes de Slate. Jamais
// d'étincelles, de baguette ni de cerveau.

import { tl } from './i18n.js';
import { register as registerIcons } from './icons.js';

const BASE = new URL('../catalog/', import.meta.url);

// Les recettes n'ont pas d'index sur le disque : on tente `recipes/index.json`
// (s'il apparaît un jour), sinon cette liste, dans l'ordre où on les propose.
const KNOWN_RECIPES = ['animate-image', 'unreal-to-real', 'character-performance', 'cutout-character', 'depth-video'];

let cat = { categories: [], types: [], byId: new Map(), recipes: [], recipeById: new Map() };
let loading = null;
let loaded = false;

/** Charge le catalogue une seule fois ; les appels suivants renvoient la même promesse. */
export function loadCatalog() {
  if (!loading) {
    loading = (async () => {
      const nodes = await readJSON(new URL('nodes.json', BASE));
      const byId = new Map();
      for (const t of nodes.types || []) byId.set(t.id, t);

      let ids = KNOWN_RECIPES;
      try {
        const idx = await readJSON(new URL('recipes/index.json', BASE));
        if (Array.isArray(idx) && idx.length) ids = idx.map((r) => (typeof r === 'string' ? r : r.id));
      } catch { /* pas d'index : la liste connue suffit */ }

      const recipes = [];
      await Promise.all(ids.map(async (id, i) => {
        try {
          const r = await readJSON(new URL(`recipes/${id}.json`, BASE));
          if (r && Array.isArray(r.nodes)) recipes[i] = r;
        } catch (e) { console.warn('[catalog] recette illisible', id, e); }
      }));

      cat = {
        categories: nodes.categories || [],
        types: nodes.types || [],
        byId,
        recipes: recipes.filter(Boolean),
        recipeById: new Map(recipes.filter(Boolean).map((r) => [r.id, r]))
      };
      loaded = true;
      return cat;
    })();
  }
  return loading;
}

export const catalogReady = () => loaded;

// fetch() refuse parfois le schéma file:// selon la configuration d'Electron ;
// XMLHttpRequest, lui, passe toujours pour une page servie depuis le disque.
// (Exportée : les profils de modèles, nodes/profiles.js, se lisent de la même façon.)
export async function readJSON(url) {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (url.protocol !== 'file:') throw e;
    return await new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('GET', url.href);
      x.onload = () => {
        if (x.status !== 0 && x.status !== 200) return reject(new Error(`HTTP ${x.status}`));
        try { resolve(JSON.parse(x.responseText)); } catch (err) { reject(err); }
      };
      x.onerror = () => reject(new Error(`lecture impossible : ${url.href}`));
      x.send();
    });
  }
}

// ── questions sur les types ───────────────────────────────────────────

/** Entrée du catalogue pour un id de type (ou null si le type n'existe plus). */
export const typeOf = (id) => cat.byId.get(id) || null;
export const types = () => cat.types;
export const categories = () => cat.categories;
export const recipes = () => cat.recipes;
export const recipe = (id) => cat.recipeById.get(id) || null;

export const typeLabel = (t) => {
  const type = typeof t === 'string' ? typeOf(t) : t;
  return type ? tl(type.label) : String(t || '');
};
export const typeDesc = (t) => {
  const type = typeof t === 'string' ? typeOf(t) : t;
  return type?.desc ? tl(type.desc) : '';
};

/** Valeurs par défaut de tous les réglages d'un type. */
export function defaults(typeId) {
  const type = typeOf(typeId);
  const out = {};
  for (const p of type?.params || []) if (p.default !== undefined) out[p.id] = clone(p.default);
  return out;
}

export const inputDefs = (typeId) => typeOf(typeId)?.inputs || [];
export const outputDefs = (typeId) => typeOf(typeId)?.outputs || [];

/** Définition d'un port : `dir` = 'in' | 'out'. */
export function portDef(typeId, portId, dir) {
  const list = dir === 'out' ? outputDefs(typeId) : inputDefs(typeId);
  return list.find((p) => p.id === portId) || null;
}

/** Le type peut-il être calculé par le moteur ? */
export const computes = (typeId) => !!typeOf(typeId)?.engine;

/** Les capacités de modèle utilisées par le premier réglage `model` d'un type (pour la palette). */
export function modelCaps(typeId) {
  const p = (typeOf(typeId)?.params || []).find((x) => x.kind === 'model' && !x.allowNone);
  return p?.caps || [];
}

// ── types de ports (SPEC §4) ──────────────────────────────────────────
// Déclarés : image, video, media, text. Une sortie peut aussi être
// `follow:<entrée>` (le type de ce qui est branché sur cette entrée) ou `data`
// (le bloc Média : le type du fichier qu'il porte). La résolution concrète a
// besoin du graphe, elle vit dans l'éditeur ; ici, seulement la règle.

/** Décrit la règle d'une sortie : {fixed:'image'} | {follow:'media'} | {data:true}. */
export function outRule(declared) {
  if (!declared) return { fixed: 'media' };
  if (declared === 'data') return { data: true };
  if (declared.startsWith('follow:')) return { follow: declared.slice(7) };
  return { fixed: declared };
}

/**
 * Un fil peut-il aller d'une sortie de type concret `out` vers une entrée
 * déclarée `inp` ? image→image|media, video→video|media, media→media,
 * text→text. Un `media` dont on ne connaît pas encore la nature ne va pas
 * dans une entrée stricte (image ou vidéo) : l'appelant résout d'abord le
 * type concret, et c'est lui qui décide.
 */
export function compatible(out, inp) {
  if (!out || !inp) return false;
  if (out === inp) return true;
  if (inp === 'media') return out === 'image' || out === 'video';
  return false;
}

function clone(v) { return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v; }

// ── glyphes des blocs (da.md §4.11) ───────────────────────────────────
// Dessinés dans une boîte de 24 ; D les recalibre optiquement (fitGlyph).
// Les noms suivent `icon` dans nodes.json et les recettes. Les icônes d'action
// propres à l'éditeur portent le préfixe `g-` pour ne jamais écraser celles de D.
registerIcons({
  // flèche qui descend dans un plateau
  import: '<path d="M12 3.8v10.4M7.9 10.2l4.1 4.1 4.1-4.1"/><path d="M4 14.6v3.1a2.3 2.3 0 0 0 2.3 2.3h11.4a2.3 2.3 0 0 0 2.3-2.3v-3.1"/>',
  // l'inverse : la flèche sort du plateau
  export: '<path d="M12 14.4V4M7.9 8.1L12 4l4.1 4.1"/><path d="M4 14.6v3.1a2.3 2.3 0 0 0 2.3 2.3h11.4a2.3 2.3 0 0 0 2.3-2.3v-3.1"/>',
  // lignes de texte
  text: '<path d="M4.5 6.5h15M4.5 11h15M4.5 15.5h9.5"/>',
  // feuille cornée
  note: '<path d="M14.2 4H6.4A2.4 2.4 0 0 0 4 6.4v11.2A2.4 2.4 0 0 0 6.4 20h11.2a2.4 2.4 0 0 0 2.4-2.4V9.8z"/><path d="M14.2 4v3.9a1.9 1.9 0 0 0 1.9 1.9H20"/><path d="M8 13.4h8M8 16.6h5"/>',
  // un cadre et le triangle de lecture
  animate: '<rect x="3.4" y="5" width="17.2" height="14" rx="2.4"/><path d="M10.3 9.4v5.2l4.4-2.6z"/>',
  // bloc Modèle (SPEC §23) : une carte de modèle — un cadre, trois lignes de réglages, la pastille en tête
  model: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.2"/><rect x="6.6" y="6.6" width="4" height="4" rx="1"/><path d="M13.2 8.6h4.2M6.6 14h10.8M6.6 17h7.4"/>',
  // pellicule
  film: '<rect x="4.2" y="3.6" width="15.6" height="16.8" rx="2"/><path d="M8.2 3.8v16.4M15.8 3.8v16.4M4.4 8.4h3.8M4.4 12h3.8M4.4 15.6h3.8M15.8 8.4h3.8M15.8 12h3.8M15.8 15.6h3.8"/>',
  // un appareil photo : « comme filmé »
  real: '<path d="M3.6 9a2.2 2.2 0 0 1 2.2-2.2h1.9l1.6-2.2h5.4l1.6 2.2h1.9A2.2 2.2 0 0 1 20.4 9v8.2a2.2 2.2 0 0 1-2.2 2.2H5.8a2.2 2.2 0 0 1-2.2-2.2z"/><circle cx="12" cy="13" r="3.4"/>',
  // un personnage en mouvement
  perform: '<circle cx="12" cy="5.2" r="2.1"/><path d="M6.2 10.2l5.8 1.4 5.8-1.4M12 11.6v4M12 15.6l-3.4 4.6M12 15.6l3.4 4.6"/>',
  // image : un cadre, une montagne, un soleil (« Image depuis un texte »)
  picture: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 16.5l4.8-4.8a1.6 1.6 0 0 1 2.3 0l5.9 5.9"/><path d="M14 15l1.7-1.7a1.6 1.6 0 0 1 2.3 0l2.5 2.5"/><circle cx="15.5" cy="9" r="1.5"/>',
  // pinceau
  brush: '<path d="M18.9 4.3a2.6 2.6 0 0 1 0 3.7l-6.6 6.6-3.7-3.7 6.6-6.6a2.6 2.6 0 0 1 3.7 0z"/><path d="M8.6 10.9c-2.4-.2-4.1 1.4-4.3 3.7-.2 2.1-.8 3.6-1.8 4.6 3.3.5 7.3-.3 8.5-2.7.4-.8.4-1.5.3-2.1"/>',
  // quatre coins tournés vers l'extérieur autour d'un petit cadre (da.md §4.11)
  upscale: '<rect x="8.6" y="8.6" width="6.8" height="6.8" rx="1.4"/><path d="M3.8 8.6V3.8h4.8M20.2 8.6V3.8h-4.8M3.8 15.4v4.8h4.8M20.2 15.4v4.8h-4.8"/>',
  // trois références et la lecture : « vidéo à partir de références »
  refs: '<rect x="3.6" y="3.6" width="7.4" height="7.4" rx="1.6"/><rect x="13" y="3.6" width="7.4" height="7.4" rx="1.6"/><rect x="3.6" y="13" width="7.4" height="7.4" rx="1.6"/><path d="M14.2 13.7v5.6a.5.5 0 0 0 .75.43l4.7-2.8a.5.5 0 0 0 0-.86l-4.7-2.8a.5.5 0 0 0-.75.43z"/>',
  // un guide en pointillé que la vidéo suit
  guided: '<path d="M8.8 15.2H5.6a2 2 0 0 1-2-2V5.6a2 2 0 0 1 2-2h7.6a2 2 0 0 1 2 2v3.2" stroke-dasharray="2.2 2.6"/><rect x="8.8" y="8.8" width="11.6" height="11.6" rx="2"/><path d="M13.2 12.3v5a.5.5 0 0 0 .76.43l4.1-2.5a.5.5 0 0 0 0-.86l-4.1-2.5a.5.5 0 0 0-.76.43z"/>',
  // trois plans décalés
  depth: '<rect x="3.6" y="10" width="10" height="10.2" rx="1.5"/><path d="M7.2 10V7.6a1.4 1.4 0 0 1 1.4-1.4h7.6a1.4 1.4 0 0 1 1.4 1.4v7.6a1.4 1.4 0 0 1-1.4 1.4h-2.6"/><path d="M10.8 6.2V4.8a1.4 1.4 0 0 1 1.4-1.4h6.8a1.4 1.4 0 0 1 1.4 1.4v6.8a1.4 1.4 0 0 1-1.4 1.4h-1.4"/>',
  // silhouette dans un cadre pointillé
  zone: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M8.2 15.6c-1.9-1.6-1-5 1.8-5.4 2.3-.3 3 1.3 4.8 1 2-.3 2.9 2.4 1.2 3.9-1.9 1.6-5.9 2.1-7.8.5z" stroke-dasharray="2 2.1"/>',
  cutout: '<rect x="3.6" y="3.6" width="16.8" height="16.8" rx="2.6" stroke-dasharray="2.2 2.6"/><circle cx="12" cy="10" r="2.6"/><path d="M7.4 18.4a4.6 4.6 0 0 1 9.2 0"/>',
  // un cadre coupé en deux, poignée au milieu
  compare: '<rect x="3.4" y="4.8" width="17.2" height="14.4" rx="2.2"/><path d="M12 2.8v18.4"/><circle cx="12" cy="12" r="1.9"/>',
  // une image (soleil + relief)
  frame: '<rect x="3.6" y="5" width="16.8" height="14" rx="2.2"/><circle cx="9" cy="9.8" r="1.6"/><path d="M4 16.6l4.2-3.7a1.6 1.6 0 0 1 2.1 0l2.9 2.6M13.4 14.2l1.6-1.4a1.6 1.6 0 0 1 2.1 0l3 2.6"/>',
  // ciseaux
  trim: '<circle cx="6.4" cy="7" r="2.5"/><circle cx="6.4" cy="17" r="2.5"/><path d="M8.5 8.4L19.6 17M8.5 15.6L19.6 7"/>',
  // cadrage
  resize: '<path d="M7 3.6V17h13.4M3.6 7H17v13.4"/>',
  // calques empilés
  layers: '<path d="M12 4l8.4 4.3L12 12.6 3.6 8.3z"/><path d="M3.6 12.2L12 16.5l8.4-4.3M3.6 16L12 20.3l8.4-4.3"/>',
  // trois plans bout à bout
  sequence: '<rect x="2.8" y="7.6" width="5.4" height="8.8" rx="1.3"/><rect x="9.3" y="7.6" width="5.4" height="8.8" rx="1.3"/><rect x="15.8" y="7.6" width="5.4" height="8.8" rx="1.3"/>',
  // forme d'onde : un son
  audio: '<path d="M4.4 10.4v3.2M8.2 7.5v9M12 4.5v15M15.8 8.3v7.4M19.6 6.5v11"/>',
  // diaphragme d'objectif : la finition « caméra »
  finish: '<circle cx="12" cy="12" r="8.4"/><path d="M15.6 12l-4.8 8.3M13.8 15.1H4.2M10.2 15.1L5.4 6.8M8.4 12l4.8-8.3M10.2 8.9h9.6M13.8 8.9l4.8 8.3"/>',
  // trois cercles qui se recouvrent : essayer des couleurs (« Essayer des looks »)
  looks: '<circle cx="12" cy="8.7" r="5"/><circle cx="8.5" cy="14.8" r="5"/><circle cx="15.5" cy="14.8" r="5"/>',

  // ── actions de l'éditeur ──
  // la section : le glyphe `frame` de Slate (le cadre « # »), bouton du dock et menus
  'g-frame': '<path d="M7.2 3v18M16.8 3v18M3 7.2h18M3 16.8h18"/>',
  'g-section': '<path d="M7.2 3v18M16.8 3v18M3 7.2h18M3 16.8h18"/>',
  'g-ungroup': '<path d="M7.2 3v18M16.8 3v18M3 7.2h18M3 16.8h18" stroke-dasharray="2.2 2.6"/>',
  // ranger de gauche à droite : trois cartes reliées
  'g-arrange': '<rect x="2.8" y="9" width="5" height="6" rx="1.3"/><rect x="16.2" y="4" width="5" height="6" rx="1.3"/><rect x="16.2" y="14" width="5" height="6" rx="1.3"/><path d="M7.8 12h3.2c1.6 0 2-5 3.6-5h1.6M11 12c1.6 0 2 5 3.6 5h1.6"/>',
  'g-rename': '<path d="M4.4 19.6l.9-3.6 10.6-10.6a1.9 1.9 0 0 1 2.7 0l.6.6a1.9 1.9 0 0 1 0 2.7L8.6 19.3z"/><path d="M13.8 7.5l2.7 2.7"/>',
  'g-duplicate': '<rect x="3.6" y="3.6" width="11" height="11" rx="2"/><path d="M9.4 20.4h9a2 2 0 0 0 2-2v-9"/>',
  'g-collapse': '<rect x="3.6" y="4.6" width="16.8" height="14.8" rx="2.4"/><path d="M3.8 9.4h16.4"/>',
  'g-bypass': '<rect x="3.6" y="4.6" width="16.8" height="14.8" rx="2.4" stroke-dasharray="2.2 2.6"/><path d="M2.6 12h18.8"/>',
  'g-cut': '<circle cx="6.4" cy="7" r="2.5"/><circle cx="6.4" cy="17" r="2.5"/><path d="M8.5 8.4L19.6 17M8.5 15.6L19.6 7"/>',
  'g-tone': '<circle cx="12" cy="12" r="8.2"/><path d="M12 3.8v16.4" /><path d="M12 6.2a5.8 5.8 0 0 1 0 11.6z" fill="currentColor" stroke="none"/>',
  'g-minimap': '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.4"/><rect x="11.4" y="11.2" width="6" height="5" rx="1"/>',
  'g-select-all': '<rect x="3.6" y="3.6" width="16.8" height="16.8" rx="2.6" stroke-dasharray="2.2 2.6"/><rect x="8" y="8" width="8" height="8" rx="1.4"/>',
  'g-snap': '<circle cx="6" cy="6" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="6" r="1.1" fill="currentColor" stroke="none"/><circle cx="18" cy="6" r="1.1" fill="currentColor" stroke="none"/><circle cx="6" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="6" cy="18" r="1.1" fill="currentColor" stroke="none"/><rect x="10.4" y="10.4" width="9.6" height="9.6" rx="1.8"/>',
  'g-unknown': '<rect x="4" y="4" width="16" height="16" rx="2.6" stroke-dasharray="2.2 2.6"/><path d="M10 9.6a2.1 2.1 0 1 1 2.8 2c-.5.2-.8.6-.8 1.1v.6M12 16.2v.2"/>'
});
