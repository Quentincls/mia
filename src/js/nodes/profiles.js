// ── Profils des modèles (SPEC §22) ───────────────────────────────────
// Lit src/catalog/model-families.json : pour chaque famille (LTX, MiniMax,
// Wan…) son nom, son fabricant, son monogramme, une phrase simple « à quoi
// ça sert » (FR/EN), ses variantes et ses limites (durée, cadence,
// définitions, entrées comprises). Même forme pour les modèles en ligne,
// plus tard (Higgsfield, SPEC §22.3).
//
// Les réglages d'un bloc suivent le modèle choisi : un réglage du catalogue
// qui porte `limit` ("seconds" | "fps" | "resolutions") est borné par le
// profil de la famille du modèle résolu (Auto compris).

import { tl } from '../i18n.js';
import { readJSON } from '../catalog.js';

const URL_FAMILIES = new URL('../../catalog/model-families.json', import.meta.url);
const URL_CLOUD = new URL('../../catalog/cloud-higgsfield.json', import.meta.url);
const URL_STRENGTHS = new URL('../../catalog/cloud-strengths.json', import.meta.url);

let data = { families: {}, makers: {}, cloud: {} };
let cloudCat = { families: [] };
let loading = null;
let ready = false;

/**
 * Les points forts des familles en ligne, tenus à la main (cloud-strengths.json : « à choisir quand… »), posés sur
 * chaque famille du catalogue relevé : def.strengths {fr,en} et def.bestFor. Même chose côté moteur (engine/route.js).
 */
function withStrengths(cat, s) {
  const by = (s && s.families) || {};
  for (const def of cat.families) {
    const x = by[def.key];
    if (x && x.strengths) def.strengths = x.strengths;
    if (x && Array.isArray(x.bestFor)) def.bestFor = x.bestFor;
  }
  return cat;
}

/** Charge les profils (et le catalogue en ligne, SPEC §23) une seule fois. */
export function loadProfiles() {
  if (!loading) {
    const local = readJSON(URL_FAMILIES)
      .then((d) => { data = { families: d.families || {}, makers: d.makers || {}, cloud: d.cloud || {} }; })
      .catch((e) => { console.warn('[profiles] model-families.json illisible', e); });
    const strengths = readJSON(URL_STRENGTHS).catch((e) => { console.warn('[profiles] cloud-strengths.json illisible', e); return null; });
    const cloud = Promise.all([readJSON(URL_CLOUD), strengths])
      .then(([d, s]) => { cloudCat = withStrengths(d && Array.isArray(d.families) ? d : { families: [] }, s); })
      .catch((e) => { console.warn('[profiles] cloud-higgsfield.json illisible', e); });
    loading = Promise.all([local, cloud]).then(() => { ready = true; return data; });
  }
  return loading;
}
export const profilesReady = () => ready;

/** Les deux catalogues tels que les lit nodes/route.js (le moteur lit les mêmes fichiers). */
export const localCatalog = () => ({ families: data.families });
export const cloudCatalog = () => cloudCat;

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Clé de famille d'une entrée d'inventaire (« ltx », « minimax »…), d'après le profil. */
export function familyKeyOf(m) {
  if (!m || m.role === 'lora' || (m.caps || []).includes('lora')) return null;
  const fams = data.families;
  const base = fold(m.baseKey);
  if (base) {
    for (const [k, f] of Object.entries(fams)) if (fold(f.match?.baseKey) === base) return k;
    return null;                       // même règle que route.js localKeyOf : jamais devinée par le nom
  }
  const hay = fold(`${m.family || ''} ${m.file || ''}`);
  for (const [k, f] of Object.entries(fams)) {
    const w = fold(f.match?.family);
    if (w && hay.includes(w)) return k;
  }
  return null;
}

/** Profil de la famille d'un modèle (ou null). */
export const profileOf = (m) => data.families[familyKeyOf(m)] || null;

/** Limites du modèle : { seconds:[min,max], fps:[…], resolutions:[…], audio, inputs:[…] } (vide si inconnu). */
export const limitsOf = (m) => profileOf(m)?.limits || {};

/** Variante d'un modèle dans sa famille : { tag, desc } (null si la famille n'en a pas). */
export function variantOf(m) {
  const p = profileOf(m);
  if (!p || !(p.variants || []).length) return null;
  const hay = fold(`${m.file || ''} ${m.label?.fr || ''} ${m.label?.en || ''}`);
  for (const v of p.variants) {
    let ok = false;
    try { ok = new RegExp(v.match || '.*', 'i').test(hay); } catch { ok = false; }
    if (ok) return { tag: tl(v.tag || {}), desc: v.desc ? tl(v.desc) : '' };
  }
  return null;
}

/** Nom de famille affiché (« LTX 2.5 »), sinon la famille du scanner. */
export const familyName = (m) => profileOf(m)?.name || m?.family || '';

/** Phrase « à quoi ça sert » de la famille, dans la langue de Mia. */
export const familyDesc = (m) => (profileOf(m)?.desc ? tl(profileOf(m).desc) : '');

/** Fabricant (« Lightricks »). */
export const makerOf = (m) => profileOf(m)?.maker || '';

/** Monogramme de la pastille : celui de la famille, sinon du fabricant, sinon deux lettres du nom. */
export function markOf(m, fallbackName = '') {
  const p = profileOf(m);
  if (p?.mark) return p.mark;
  const maker = m?.maker || m?.provider_name || '';
  if (maker && data.makers[maker]) return data.makers[maker];
  const s = String(fallbackName || m?.family || m?.file || '?').replace(/[^A-Za-z0-9]/g, '');
  return (s.slice(0, 2) || '?').toUpperCase();
}

/** Fournisseurs en ligne connus (SPEC §22.3) : [{ key, name, mark, desc }]. */
export function cloudProviders() {
  return Object.entries(data.cloud || {}).map(([key, c]) => ({ key, name: c.name, mark: c.mark, desc: c.desc ? tl(c.desc) : '' }));
}

/**
 * Bornes d'un réglage pour le modèle donné, d'après son attribut `limit`.
 * Renvoie null si rien ne s'applique, sinon { min?, max?, values? }.
 */
export function boundsFor(param, m) {
  return m ? limitBounds(param, limitsOf(m)) : null;
}

/** Même chose d'après des limites données (celles d'une famille quand son modèle n'est pas encore résolu). */
export function limitBounds(param, limits) {
  const key = param?.limit;
  if (!key || !limits) return null;
  const lim = limits[key];
  if (!lim) return null;
  if (key === 'seconds' && Array.isArray(lim) && lim.length === 2) return { min: lim[0], max: lim[1] };
  if (Array.isArray(lim)) return { values: lim.map(String) };
  return null;
}

/** L'entrée `port` du bloc sert-elle au modèle ? (vrai si le profil ne dit rien) */
export function usesInput(m, port) {
  const inputs = limitsOf(m).inputs;
  return !Array.isArray(inputs) || inputs.includes(port);
}
