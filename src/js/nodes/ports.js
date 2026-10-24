// ── Entrées et sorties d'un bloc, bloc Modèle compris (SPEC §23) ─────
// Pour tous les blocs, les ports sont ceux du catalogue (catalog.js). Le bloc
// Modèle (`ports: "model"`) déclare toutes les entrées possibles ; il ne
// montre que celles que sait prendre la famille de son modèle (LTX : image de
// début, de fin, fiche, guide…; Seedance 2.5 : jusqu'à 30 images de
// référence, 10 vidéos, 10 sons…), au nombre qu'elle permet. Une entrée déjà
// branchée que le nouveau modèle ne prend pas reste visible, grisée (le fil ne
// disparaît pas sous les yeux de Quentin), et le moteur l'ignore avec une note.
// Sa sortie a le type de ce que fait la famille (vidéo ou image).

import { typeOf, typeLabel, inputDefs, outputDefs, portDef } from '../catalog.js';
import { state } from '../state.js';
import { familyOf, portsOfFamily, chooseWorkflow } from './route.js';
import { localCatalog, cloudCatalog } from './profiles.js';

/** Le bloc a-t-il des ports qui suivent son modèle ? */
export const isModelBlock = (node) => typeOf(node?.type)?.ports === 'model';

/** Valeur du modèle d'un bloc Modèle (son réglage, sinon le défaut du catalogue). */
function modelValue(node) {
  const p = (typeOf(node.type)?.params || []).find((x) => x.id === 'model');
  return node.params?.model ?? p?.default ?? 'auto';
}

/** Famille du bloc Modèle : { provider, key, def, variant } ou null (catalogues pas encore lus, modèle disparu). */
export function blockFamily(node) {
  if (!isModelBlock(node)) return null;
  return familyOf(modelValue(node), localCatalog(), cloudCatalog(), state.inventory);
}

/**
 * Entrée(s) principale(s) d'une famille, toujours montrée(s) : celle du profil (`main`), sinon la première qui
 * existe parmi image de début, références, vidéo source, image, personnage.
 */
export function mainPorts(fam) {
  if (!fam) return [];
  if (Array.isArray(fam.def.main)) return fam.def.main;
  const p = portsOfFamily(fam);
  return ['start', 'refs', 'video', 'image', 'character'].filter((x) => p[x]).slice(0, 1);
}

/**
 * Entrées d'un bloc. `connected` : ids des entrées déjà reliées (gardées, grisées, si le modèle ne les prend pas).
 * Bloc Modèle (« + Ajouter », demande de Quentin du 24/10) : on montre l'entrée principale, la Consigne, ce qui est
 * relié et ce que Quentin a ajouté (`node.data.shown`) ; `all` montre tout ce que prend la famille (menu « + »,
 * assistant), `extra` quelques entrées de plus (celles qui peuvent recevoir le fil qu'on tire, le temps du geste).
 */
export function nodeInputs(node, connected = [], { all = false, extra = [] } = {}) {
  if (!node) return [];
  if (!isModelBlock(node)) return inputDefs(node.type);
  const fam = blockFamily(node);
  const ports = fam ? portsOfFamily(fam) : { prompt: { max: 1, multi: false } };
  const main = new Set(mainPorts(fam));
  const shown = new Set(Array.isArray(node.data?.shown) ? node.data.shown : []);
  // ce qui manque à la façon de faire retenue se montre toujours (on ne demande jamais de brancher une entrée cachée)
  const plan = fam ? chooseWorkflow(fam, connected, node.params?.workflow || null) : null;
  for (const id of plan?.blocked ? plan.missing : []) main.add(id);
  const visible = (id) => all || id === 'prompt' || main.has(id) || shown.has(id) || connected.includes(id) || extra.includes(id);
  return inputDefs(node.type)
    .filter((d) => (ports[d.id] && visible(d.id)) || connected.includes(d.id))
    .map((d) => {
      const p = ports[d.id];
      if (!p) return { ...d, unused: true };
      // une entrée ajoutée avec « + », encore vide, s'enlève d'un clic
      const removable = shown.has(d.id) && !main.has(d.id) && !connected.includes(d.id) && d.id !== 'prompt';
      // montrée seulement le temps d'un fil tiré : dessinée plus discrète
      const peek = !all && extra.includes(d.id) && !removable && !main.has(d.id) && !connected.includes(d.id) && d.id !== 'prompt' && !shown.has(d.id);
      const base = p.multi ? { ...d, multi: true, max: p.max } : { ...d, multi: false, max: undefined };
      if (p.trial) base.trial = true;
      return removable ? { ...base, removable: true } : peek ? { ...base, peek: true } : base;
    });
}

/** Entrées que la famille sait prendre et que le bloc ne montre pas encore (le menu « + Ajouter »). */
export function hiddenInputs(node, connected = []) {
  if (!isModelBlock(node)) return [];
  const seen = new Set(nodeInputs(node, connected).map((d) => d.id));
  return nodeInputs(node, connected, { all: true }).filter((d) => !d.unused && !seen.has(d.id));
}

/** Sorties d'un bloc : celle du bloc Modèle prend le type de ce que fait sa famille. */
export function nodeOutputs(node) {
  if (!node) return [];
  if (!isModelBlock(node)) return outputDefs(node.type);
  const kind = blockFamily(node)?.def?.kind || 'video';
  return outputDefs(node.type).map((d) => (d.type === 'model' ? { ...d, type: kind } : d));
}

/** Définition d'un port d'un bloc (une entrée reliée hors du modèle est trouvée, marquée `unused`). */
export function nodePortDef(node, portId, dir) {
  if (!node) return null;
  if (!isModelBlock(node)) return portDef(node.type, portId, dir);
  const list = dir === 'out' ? nodeOutputs(node) : nodeInputs(node, [portId]);
  return list.find((p) => p.id === portId) || null;
}

/** Signature des ports (pour reconstruire les rangées quand le modèle change). */
export function portsSignature(node, connected = [], opts = {}) {
  if (!isModelBlock(node)) return '';
  const i = nodeInputs(node, connected, opts).map((p) => `${p.id}${p.multi ? `*${p.max}` : ''}${p.unused ? '!' : ''}${p.removable ? '-' : ''}${p.peek ? '~' : ''}`).join(',');
  const more = !opts.extra?.length && hiddenInputs(node, connected).length ? '+' : '';
  const o = nodeOutputs(node).map((p) => `${p.id}:${p.type}`).join(',');
  return `${i}|${o}|${more}`;
}

/** Titre par défaut d'un bloc Modèle : le nom de sa famille (« MiniMax H3 », « Seedance 2.5 »). */
export function modelBlockTitle(node) {
  const fam = blockFamily(node);
  return fam?.def?.name || typeLabel(node.type);
}

/** Ce que fera le bloc avec ses fils actuels (`connected` : ids des entrées reliées). */
export function blockWorkflow(node, connected) {
  const fam = blockFamily(node);
  if (!fam) return null;
  return { fam, ...chooseWorkflow(fam, connected, node.params?.workflow || null) };
}
