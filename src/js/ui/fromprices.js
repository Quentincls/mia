// « dès … $ » des modèles en ligne : ce que Higgsfield a répondu (le processus principal le garde un jour, SPEC §23.3)
// et ce qui lui a déjà été demandé. Partagé par « + Bloc » et le choix du modèle d'un bloc.
import { on } from '../bus.js';

const FROM = {};
const ASKED = new Set();
on('cloud:changed', () => { for (const k of Object.keys(FROM)) delete FROM[k]; ASKED.clear(); });

/** Le prix « dès » d'une famille en ligne (« hf:… ») : un nombre, null (Higgsfield n'en donne pas), undefined (pas encore). */
export const fromPrice = (key) => FROM[key];

/** Demande les prix encore inconnus (une fois) ; → true quand de nouveaux sont arrivés. Rien sans compte relié. */
export function askFromPrices(keys) {
  const missing = [...new Set(keys || [])].filter((k) => !(k in FROM) && !ASKED.has(k));
  if (!missing.length || !window.mia?.cloud?.fromPrices) return Promise.resolve(false);
  for (const k of missing) ASKED.add(k);
  return window.mia.cloud.fromPrices(missing)
    .then((r) => { Object.assign(FROM, r || {}); return Object.keys(r || {}).length > 0; })
    .catch(() => false);
}
