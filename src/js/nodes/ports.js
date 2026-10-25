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
import { familyOf, portsOfFamily, chooseWorkflow, needsOf } from './route.js';
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
 * assistant), `extra` quelques entrées de plus (celles qui peuvent recevoir le fil qu'on tire, le temps du geste),
 * `hold` celles qui restent à leur place pendant le geste (le fil qu'on décroche au Ctrl+glisser).
 */
export function nodeInputs(node, connected = [], { all = false, extra = [], hold = [] } = {}) {
  if (!node) return [];
  if (!isModelBlock(node)) return inputDefs(node.type);
  const fam = blockFamily(node);
  const ports = fam ? portsOfFamily(fam) : { prompt: { max: 1, multi: false } };
  // une famille qui sait faire plusieurs choses n'impose aucune entrée (« points de départ ») ; une famille à une
  // seule façon de faire (Wan : personnage + mouvement) montre ce qu'elle demande. Replié, un bloc garde son entrée
  // principale : c'est elle qui reçoit un fil lâché sur sa barre de titre.
  const main = new Set(isMultiWay(fam) && !node.collapsed ? [] : mainPorts(fam));
  for (const id of hold) main.add(id);
  const shown = new Set(Array.isArray(node.data?.shown) ? node.data.shown : []);
  // ce qui manque à la façon de faire retenue se montre toujours (on ne demande jamais de brancher une entrée cachée)
  const plan = fam ? chooseWorkflow(fam, connected, node.params?.workflow || null) : null;
  for (const id of plan?.blocked ? plan.missing : []) main.add(id);
  const ignored = new Set(plan?.unused || []);
  const labels = portLabels(fam);
  const visible = (id) => all || id === 'prompt' || main.has(id) || shown.has(id) || connected.includes(id) || extra.includes(id);
  const list = inputDefs(node.type)
    .filter((d) => (ports[d.id] && visible(d.id)) || connected.includes(d.id))
    .map((d) => {
      const p = ports[d.id];
      if (!p) return { ...d, unused: true };
      // une entrée ajoutée avec « + », encore vide, s'enlève d'un clic
      const removable = shown.has(d.id) && !main.has(d.id) && !connected.includes(d.id) && d.id !== 'prompt';
      // montrée seulement le temps d'un fil tiré : dessinée plus discrète
      const peek = !all && extra.includes(d.id) && !removable && !main.has(d.id) && !connected.includes(d.id) && d.id !== 'prompt' && !shown.has(d.id);
      const base = p.multi ? { ...d, multi: true, max: p.max } : { ...d, multi: false, max: undefined };
      if (labels[d.id]) base.label = labels[d.id];          // « Rendu 3D » (LTX), « Vidéo à prolonger » (MiniMax)
      if (p.trial) base.trial = true;
      // reliée mais pas utilisée par la façon de faire retenue : grisée (elle reste une cible de fil, ≠ unused)
      if (connected.includes(d.id) && ignored.has(d.id)) base.ignored = true;
      return removable ? { ...base, removable: true } : peek ? { ...base, peek: true } : base;
    });
  // les entrées montrées le temps d'un fil vont tout en bas : rien ne bouge sous le pointeur (audit 25/10, LIVE-1)
  return [...list.filter((d) => !d.peek), ...list.filter((d) => d.peek)];
}

/** La famille sait-elle faire plusieurs choses (plusieurs façons de faire) ? */
const isMultiWay = (fam) => ((fam?.def?.workflows) || []).length > 1;

// ordre des points de départ : ce qu'on fait le plus souvent d'abord
const START_ORDER = ['start', 'refs', 'refVideos', 'image', 'character', 'video', 'guide', 'sheet', 'motion', 'end', 'keys', 'audio'];
// ce dont une façon de faire sans exigence peut partir (pas les images-clés ni le son d'un « depuis un texte »)
const LEADS = START_ORDER.slice(0, START_ORDER.indexOf('motion'));

/**
 * Points de départ d'un bloc Modèle vide (rien de relié hors Consigne, rien d'ajouté) : la 1re entrée qu'exige chaque
 * façon de faire de sa famille → [{ id, label, what: [libellés des façons de faire], trial }]. Vide sinon, et pour
 * une famille qui ne sait pas partir de la consigne (Genjutsu : le bloc montre plutôt ce qui lui manque).
 */
export function startPoints(node, connected = []) {
  if (!isModelBlock(node)) return [];
  const fam = blockFamily(node);
  if (!isMultiWay(fam)) return [];
  if (connected.some((id) => id !== 'prompt')) return [];
  // une entrée ajoutée que ce modèle prend : la ligne a fait son office (celle d'un modèle d'avant ne compte pas)
  const ports = portsOfFamily(fam);
  if ((Array.isArray(node.data?.shown) ? node.data.shown : []).some((id) => ports[id])) return [];
  const empty = chooseWorkflow(fam, connected, node.params?.workflow || null);
  if (!empty || empty.blocked) return [];
  const labels = portLabels(fam);
  // une façon de faire sans exigence part de l'entrée de tête qui, branchée seule, la choisit vraiment (Kling O3 :
  // ses références, pas son image de début)
  const picks = (wf, p) => {
    const r = chooseWorkflow(fam, [p], null);
    return !!r && !r.blocked && (r.workflow.id === wf.id || (r.ties || []).some((w) => w.id === wf.id));
  };
  const byId = new Map();
  for (const wf of fam.def.workflows) {
    const id = needsOf(wf)[0] || LEADS.find((p) => (wf.ports || {})[p] && picks(wf, p));
    if (!id) continue;
    const d = inputDefs(node.type).find((x) => x.id === id);
    if (!d) continue;
    const cur = byId.get(id) || { id, label: labels[id] || d.label, what: [], trials: [] };
    cur.what.push(wf.label || {});
    cur.trials.push(!!wf.trial);
    byId.set(id, cur);
  }
  const main = mainPorts(fam);
  const rank = (id) => { const m = main.indexOf(id); if (m >= 0) return m - 100; const i = START_ORDER.indexOf(id); return i < 0 ? 99 : i; };
  // « à essayer » quand toutes les façons de faire qu'il ouvre le sont (la fiche personnage de LTX)
  return [...byId.values()].sort((a, b) => rank(a.id) - rank(b.id))
    .map(({ trials, ...s }) => ({ ...s, trial: trials.every(Boolean) }));
}

/** Libellés propres à une famille (« Rendu 3D » pour la vidéo de LTX…), pris dans les ports de ses façons de faire. */
export function portLabels(fam) {
  const out = {};
  for (const wf of fam?.def?.workflows || []) {
    for (const [id, v] of Object.entries(wf.ports || {})) if (v && v.label && !out[id]) out[id] = v.label;
  }
  return out;
}

/**
 * Entrées rangées qui, une fois reliées, serviraient tout de suite (une façon de faire possible s'en sert) : seules
 * celles-là apparaissent pendant qu'on tire un fil — pas « Image de look » sur un LTX qui a déjà son image de début.
 */
export function usefulInputs(node, connected = []) {
  const fam = blockFamily(node);
  if (!fam) return [];
  return hiddenInputs(node, connected).map((d) => d.id).filter((id) => {
    const r = chooseWorkflow(fam, [...connected, id], node.params?.workflow || null);
    return r && !r.blocked && !r.unused.includes(id);
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
  const lab = (l) => l?.fr || '';
  const i = nodeInputs(node, connected, opts).map((p) => `${p.id}=${lab(p.label)}${p.multi ? `*${p.max}` : ''}${p.unused ? '!' : ''}${p.removable ? '-' : ''}${p.peek ? '~' : ''}${p.ignored ? '#' : ''}`).join(',');
  const gesture = !!opts.extra?.length;
  const starts = gesture ? [] : startPoints(node, connected);
  const hid = gesture ? [] : hiddenInputs(node, connected);
  // « + » : seul derrière la ligne « Partir de » s'il reste autre chose à ajouter, « + Ajouter » sinon (view.js)
  const more = hid.some((d) => !starts.some((s) => s.id === d.id)) ? '+' : '';
  const st = starts.map((s) => `${s.id}=${lab(s.label)}:${s.what.map(lab).join('/')}${s.trial ? '?' : ''}`).join(',');
  const o = nodeOutputs(node).map((p) => `${p.id}:${p.type}`).join(',');
  return `${i}|${o}|${more}|${st}`;
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
