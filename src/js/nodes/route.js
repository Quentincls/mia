// ── Bloc Modèle : que fait-il ? (SPEC §23) ───────────────────────────
// Un bloc Modèle (type `gen`) porte une famille de modèles (LTX, MiniMax, Wan…
// sur ce PC, ou Seedance, Kling… en ligne). Chaque famille sait faire
// plusieurs choses (« workflows » : texte → vidéo, image → vidéo, références,
// vidéo guidée…). Ce que Quentin branche décide du workflow : une image de
// début → animer l'image ; des références → les mélanger ; rien → partir du
// texte. Quand deux workflows vont aussi bien (modifier ou prolonger une
// vidéo), le bloc propose le choix.
//
// UNE seule source pour l'écran (modules ES) et le moteur : ce fichier n'a ni
// import ni accès au DOM ; le moteur (CommonJS) le charge en retirant les
// « export » (electron/engine/route.js). Ne rien y ajouter qui dépende de
// l'un ou de l'autre.

/** Valeur du réglage de modèle d'un bloc Modèle → { provider, key, def, variant } ou null. */
export function familyOf(value, local, cloud, inventory) {
  const v = value == null || value === '' ? 'auto' : String(value);
  const fams = (local && local.families) || {};
  if (v.startsWith('hf:')) {
    const def = ((cloud && cloud.families) || []).find((f) => f.key === v) || null;
    return def ? { provider: def.provider || 'higgsfield', key: v, def, variant: null } : null;
  }
  if (v.startsWith('fam:')) {
    const key = v.slice(4);
    return fams[key] && fams[key].workflows ? { provider: 'local', key, def: fams[key], variant: null } : null;
  }
  if (v === 'auto') return fams.ltx && fams.ltx.workflows ? { provider: 'local', key: 'ltx', def: fams.ltx, variant: null } : null;
  // un modèle précis de l'inventaire (« LTX 2.5 · RTX 50 ») : sa famille, et lui pour les workflows qu'il sait faire
  const m = ((inventory && inventory.models) || []).find((x) => x.id === v);
  if (!m) return null;
  const key = localKeyOf(m, fams);
  return key && fams[key].workflows ? { provider: 'local', key, def: fams[key], variant: m } : null;
}

/** Clé de famille locale d'une entrée d'inventaire (même règle que profiles.js familyKeyOf). */
export function localKeyOf(m, fams) {
  if (!m || m.role === 'lora' || (m.caps || []).includes('lora')) return null;     // un LoRA n'est le modèle d'aucune famille
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const base = fold(m.baseKey);
  if (base) {
    for (const [k, f] of Object.entries(fams || {})) if (fold(f.match && f.match.baseKey) === base) return k;
    // la base est connue et n'est celle d'aucune famille : pas de devinette par le nom (Qwen-Image 2.1 ≠ « qwen »)
    return null;
  }
  const hay = fold(`${m.family || ''} ${m.file || ''}`);
  for (const [k, f] of Object.entries(fams || {})) {
    const w = fold(f.match && f.match.family);
    if (w && hay.includes(w)) return k;
  }
  return null;
}

// Mémoire des calculs ci-dessous, par définition de famille ou de workflow (des objets du catalogue, qui ne changent
// pas) : une planche de 110 blocs les refaisait des centaines de fois à son ouverture (28/10). Les résultats sont
// partagés : les lire, jamais les modifier.
const MEMO_WF = new WeakMap();
const MEMO_FAM = new WeakMap();
const MEMO_CHOICE = new WeakMap();

/** Entrées d'un workflow : { port: { max, multi } } (la Consigne y est toujours). */
export function portsOfWorkflow(wf) {
  if (wf && typeof wf === 'object' && MEMO_WF.has(wf)) return MEMO_WF.get(wf);
  const out = { prompt: { max: 1, multi: false } };
  for (const [k, v] of Object.entries((wf && wf.ports) || {})) {
    out[k] = { max: Number(v && v.max) || 1, multi: !!(v && v.multi) };
    if (v && v.trial) out[k].trial = true;      // « À essayer » : pas encore validé à l'œil au labo
  }
  if (wf && typeof wf === 'object') MEMO_WF.set(wf, out);
  return out;
}

/** Entrées de toute la famille (l'union de ses workflows, au plus grand nombre permis). */
export function portsOfFamily(fam) {
  const def = fam && fam.def;
  if (def && typeof def === 'object' && MEMO_FAM.has(def)) return MEMO_FAM.get(def);
  const out = { prompt: { max: 1, multi: false } };
  for (const wf of (fam && fam.def && fam.def.workflows) || []) {
    for (const [k, v] of Object.entries(portsOfWorkflow(wf))) {
      const o = out[k];
      if (!o) { out[k] = { ...v }; continue; }
      out[k] = { max: Math.max(o.max, v.max), multi: o.multi || v.multi };
      if (o.trial && v.trial) out[k].trial = true;   // à l'essai seulement si aucune façon de faire ne l'a validée
    }
  }
  if (def && typeof def === 'object') MEMO_FAM.set(def, out);
  return out;
}

/**
 * Entrées « principales » : celles qui disent ce qu'on veut faire (une image de début, des références, une vidéo…).
 * Jeter l'une d'elles coûte plus cher que jeter une entrée d'appoint (image de fin, images-clés, son, look, masque) :
 * des références + une image-clé restent des références, pas une vidéo depuis le texte.
 */
const MAIN_PORTS = ['start', 'refs', 'refVideos', 'guide', 'video', 'image', 'character', 'motion'];

/**
 * Le workflow que fera le bloc, d'après les entrées branchées (`connected` : ids de ports, la Consigne comprise ou
 * non) et le choix gardé par Quentin quand deux vont aussi bien (`choice` : id de workflow).
 * → { workflow, ties: [workflows à égalité], unused: [ports branchés qui ne servent pas], missing: [ports à brancher],
 *     blocked: vrai si aucun workflow n'est possible avec ce qui est branché }
 * Règles (audit du 25/10) :
 * - une entrée que la famille ne prend pas du tout est ignorée (barrée) et ne pèse pas sur le choix ;
 * - une façon de faire qui ne se sert d'AUCUNE des entrées branchées n'est possible que s'il n'y a rien de branché :
 *   une image de fin seule sur LTX ne part plus du texte en silence, le bloc dit « il manque l'image de début » ;
 * - quand rien ne va, la plus proche est d'abord une façon de faire qui se sert de ce qui est branché.
 */
export function chooseWorkflow(fam, connected, choice) {
  const def = fam && fam.def;
  const key = `${[...new Set(connected || [])].join(',')}|${choice || ''}`;
  const memo = def && typeof def === 'object' ? (MEMO_CHOICE.get(def) || new Map()) : null;
  if (memo && memo.has(key)) return memo.get(key);
  const res = chooseWorkflowNow(fam, connected, choice);
  if (memo) { if (memo.size > 200) memo.clear(); memo.set(key, res); MEMO_CHOICE.set(def, memo); }
  return res;
}

function chooseWorkflowNow(fam, connected, choice) {
  const wfs = (fam && fam.def && fam.def.workflows) || [];
  const famPorts = portsOfFamily(fam);
  const all = [...new Set((connected || []).filter((p) => p !== 'prompt'))];
  const foreign = all.filter((p) => !famPorts[p]);
  const on = new Set(all.filter((p) => famPorts[p]));
  const scored = wfs.map((wf, i) => {
    const ports = portsOfWorkflow(wf);
    const req = wf.required || [];
    const missReq = req.filter((p) => !on.has(p));
    const missOne = (wf.oneOf || []).filter((g) => !g.some((p) => on.has(p)));
    const used = [...on].filter((p) => ports[p]);
    const ignored = [...on].filter((p) => !ports[p]);
    const penalty = ignored.reduce((sum, p) => sum + (MAIN_PORTS.includes(p) ? 30 : 10), 0);
    return {
      // need : ce que la façon de faire exige (entrées obligatoires, groupes « l'une ou l'autre ») — à score égal, celle
      // qui a ce qu'elle exige passe devant celle qui n'exige rien
      wf, i, eligible: !missReq.length && !missOne.length && (used.length > 0 || on.size === 0),
      used: used.length, unused: [...ignored, ...foreign], need: req.length + (wf.oneOf || []).length,
      size: Object.keys(ports).length, missing: [...missReq, ...missOne.map((g) => g[0])],
      score: used.length - penalty,
    };
  });
  const ok = scored.filter((s) => s.eligible);
  // modèle en ligne (30/10, rapport cloud-ui) : un mode choisi par Quentin passe devant le score, même s'il ne va
  // pas avec les fils actuels — le bloc dit alors ce qui lui manque, et ignore avec une note ce qui ne lui sert pas.
  // `auto` : ce que Mia aurait choisi seule (pour proposer d'y revenir). Sur ce PC, le choix ne départage toujours
  // que deux façons qui vont aussi bien (planches d'avant inchangées).
  const forced = choice && choice !== 'auto' && fam && fam.provider && fam.provider !== 'local'
    ? scored.find((s) => s.wf.id === choice) : null;
  if (forced) {
    const auto = chooseWorkflowNow(fam, connected, null);
    const lack = forced.missing.length > 0;
    return {
      workflow: forced.wf, ties: [], unused: forced.unused, missing: lack ? forced.missing : [], blocked: lack,
      forced: true, auto: auto ? auto.workflow : null,
    };
  }
  if (!ok.length) {
    // rien ne va : la plus proche, d'abord parmi celles qui se servent de ce qui est branché, pour dire quoi brancher
    const near = scored.slice().sort((a, b) => (b.used > 0) - (a.used > 0) || a.missing.length - b.missing.length
      || b.used - a.used || a.i - b.i)[0];
    return near ? { workflow: near.wf, ties: [], unused: near.unused, missing: near.missing, blocked: true, forced: false, auto: near.wf } : null;
  }
  ok.sort((a, b) => b.score - a.score || b.need - a.need || a.size - b.size || a.i - b.i);
  const best = ok[0];
  // à égalité (même score, mêmes exigences) : le choix est offert ; par défaut la plus petite. Rien de branché : pas de
  // choix, la plus simple (texte → vidéo plutôt que des références sans références)
  const ties = on.size ? ok.filter((s) => s.score === best.score && s.need === best.need).map((s) => s.wf) : [best.wf];
  const picked = (choice && ties.find((w) => w.id === choice)) || best.wf;
  const s = scored.find((x) => x.wf === picked);
  return { workflow: picked, ties: ties.length > 1 ? ties : [], unused: s.unused, missing: [], blocked: false, forced: false, auto: best.wf };
}

/**
 * Palier choisi d'un bloc en ligne pour une façon de faire (`hf.tier`, Kling 3.0 Turbo / Pro…) : la valeur posée si
 * le réglage existe et la permet, sinon son défaut ; null quand la façon de faire n'a pas de paliers.
 */
export function tierOf(wf, params) {
  const p = ((wf && wf.params) || []).find((x) => x && x.id === 'hf.tier');
  if (!p) return null;
  const v = params ? params['hf.tier'] : undefined;
  const ok = (p.options || []).some((o) => String(o.value) === String(v));
  return ok ? String(v) : (p.default != null ? String(p.default) : null);
}

/** Le réglage ou l'entrée existe-t-il pour ce palier ? (`onlyTiers` du catalogue en ligne ; sans palier : oui) */
export function tierAllows(def, tier) {
  return !(def && Array.isArray(def.onlyTiers) && tier != null && !def.onlyTiers.includes(tier));
}

/** Ce qu'exige une façon de faire, en ids d'entrées : ses obligatoires, puis la 1re de chaque groupe « l'une ou l'autre ». */
export function needsOf(wf) {
  return [...((wf && wf.required) || []), ...(((wf && wf.oneOf) || []).map((g) => g[0]))];
}

/** Le modèle local qui fera ce workflow : la variante choisie si elle sait le faire, sinon le meilleur prêt de la famille. */
export function localModelFor(fam, wf, inventory) {
  const models = ((inventory && inventory.models) || []).filter((m) => m.status === 'ready' && !m.hidden && m.license !== 'forbidden');
  const can = (m) => (m.caps || []).includes(wf.cap);
  if (fam.variant && can(fam.variant)) return fam.variant;
  const mine = models.filter((m) => localKeyOf(m, { [fam.key]: fam.def }) === fam.key && can(m));
  if (!mine.length) return null;
  const def = inventory && inventory.capabilities && inventory.capabilities[wf.cap] && inventory.capabilities[wf.cap].default;
  return mine.find((m) => m.id === def) || mine.sort((a, b) => (b.quality || 0) - (a.quality || 0))[0];
}
