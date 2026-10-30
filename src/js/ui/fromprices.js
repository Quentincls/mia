// « dès … $ » des modèles en ligne : ce que Higgsfield a répondu (le processus principal le garde un jour, SPEC §23.3)
// et ce qui lui a déjà été demandé. Partagé par « + Bloc » et le choix du modèle d'un bloc.
// Sans compte relié (ou sans montant de Higgsfield), le processus principal donne le tarif public (`_public` : ces
// clés-là) : il s'affiche avec « ≈ » (une remise temporaire peut y être incluse), comme le pied du bloc.
import { on } from '../bus.js';
import { moneyFine } from './budget.js';

const FROM = {};
const PUBLIC = new Set();
const ASKED = new Set();
on('cloud:changed', () => { for (const k of Object.keys(FROM)) delete FROM[k]; PUBLIC.clear(); ASKED.clear(); });

/** Le prix « dès » d'une famille en ligne (« hf:… ») : un nombre, null (Higgsfield n'en donne pas), undefined (pas encore). */
export const fromPrice = (key) => FROM[key];

/** Ce prix est-il le tarif public (sans compte, ou sans montant de Higgsfield) ? Il s'affiche alors avec « ≈ ». */
export const isPublicFrom = (key) => PUBLIC.has(key);

/** Le prix « dès » prêt à écrire : « 0,84 $ », « ≈ 0,003 $ » (tarif public) ; null quand il n'y en a pas. Insécable. */
export function fromText(key) {
  const v = FROM[key];
  if (v == null) return null;
  return `${PUBLIC.has(key) ? '≈ ' : ''}${moneyFine(v)}`.replace(/ /g, ' ');
}

/** Demande les prix encore inconnus (une fois) ; → true quand de nouveaux sont arrivés. */
export function askFromPrices(keys) {
  const missing = [...new Set(keys || [])].filter((k) => !(k in FROM) && !ASKED.has(k));
  if (!missing.length || !window.mia?.cloud?.fromPrices) return Promise.resolve(false);
  for (const k of missing) ASKED.add(k);
  return window.mia.cloud.fromPrices(missing)
    .then((r) => {
      const { _public = [], ...prices } = r || {};
      Object.assign(FROM, prices);
      for (const k of Array.isArray(_public) ? _public : []) PUBLIC.add(k);
      return Object.keys(prices).length > 0;
    })
    .catch(() => false);
}
