// ── Mémoire : le total de la machine, le besoin d'un modèle, la place qu'il y prend (SPEC §7) ──
// UNE seule règle pour la bibliothèque, la palette d'ajout, la liste de choix d'un bloc et le bloc Modèle : avant,
// la bibliothèque et la palette avaient chacune la leur, avec des seuils en dur pensés pour 24 Go.
//
// Ce fichier n'a ni import ni accès au DOM (comme nodes/route.js) : le banc tools/test-variants.js le charge en
// retirant les « export ». Les textes et la mise en forme des nombres restent chez ceux qui affichent.
//
// Unité : Go « Windows » (octets / 2^30), comme le total que ComfyUI annonce et que le scanner retient
// (`inventory.machine.memGB`) ; le moteur rend le même total dans `gpu.vramTotalGB`.

/** Total de mémoire de la machine, en Go, ou null s'il n'est pas encore connu. */
export function machineGB(inv, engine) {
  const ok = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : null);
  return ok(inv && inv.machine ? inv.machine.memGB : null) ?? ok(engine && engine.gpu ? engine.gpu.vramTotalGB : null);
}

/**
 * Mémoire qu'un modèle prendra, en Go, ou null si elle n'est pas connue : celle que le scanner a résolue pour cette
 * machine (`m.mem.gb` : le pic mesuré — toujours pour une version sans chiffre réglé pour 24 Go, comme la pleine ;
 * seulement quand la machine a la place pour les compactes —, sinon le chiffre du catalogue ou du fichier), à
 * défaut l'ancien champ `m.vramGB` (un inventaire gardé d'avant).
 */
export function needGB(m) {
  const v = Number(m && m.mem && m.mem.gb != null ? m.mem.gb : m ? m.vramGB : null);
  return isFinite(v) && v > 0 ? v : null;
}

/**
 * Place d'un modèle dans la mémoire de la machine : 'light' | 'comfy' | 'tight' | 'over', ou null quand la question
 * ne se pose pas (besoin inconnu, modèle caché, LoRA, pas prêt, licence interdite).
 * Seuils : pensés pour 24 Go (léger < 8, à l'aise < 16, juste jusqu'au total − 1), puis à l'échelle de la machine
 * au-delà (k = total / 24) ; jusqu'à 24 Go ils sont ceux de toujours. Total inconnu : 24, comme toujours.
 */
export function fitOf(m, total) {
  const v = needGB(m);
  if (v == null || !m || m.hidden || m.role === 'lora' || m.status !== 'ready' || m.license === 'forbidden') return null;
  const T = Math.round(typeof total === 'number' && isFinite(total) && total > 0 ? total : 24);
  const k = Math.max(1, T / 24);
  if (v < 8 * k) return 'light';
  if (v < 16 * k) return 'comfy';
  if (v <= T - 1) return 'tight';
  return 'over';
}
