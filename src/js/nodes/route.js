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
  if (!m) return null;
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const base = fold(m.baseKey);
  if (base) for (const [k, f] of Object.entries(fams || {})) if (fold(f.match && f.match.baseKey) === base) return k;
  const hay = fold(`${m.family || ''} ${m.file || ''}`);
  for (const [k, f] of Object.entries(fams || {})) {
    const w = fold(f.match && f.match.family);
    if (w && hay.includes(w)) return k;
  }
  return null;
}

/** Entrées d'un workflow : { port: { max, multi } } (la Consigne y est toujours). */
export function portsOfWorkflow(wf) {
  const out = { prompt: { max: 1, multi: false } };
  for (const [k, v] of Object.entries((wf && wf.ports) || {})) {
    out[k] = { max: Number(v && v.max) || 1, multi: !!(v && v.multi) };
    if (v && v.trial) out[k].trial = true;      // « À essayer » : pas encore validé à l'œil au labo
  }
  return out;
}

/** Entrées de toute la famille (l'union de ses workflows, au plus grand nombre permis). */
export function portsOfFamily(fam) {
  const out = { prompt: { max: 1, multi: false } };
  for (const wf of (fam && fam.def && fam.def.workflows) || []) {
    for (const [k, v] of Object.entries(portsOfWorkflow(wf))) {
      const o = out[k];
      if (!o) { out[k] = { ...v }; continue; }
      out[k] = { max: Math.max(o.max, v.max), multi: o.multi || v.multi };
      if (o.trial && v.trial) out[k].trial = true;   // à l'essai seulement si aucune façon de faire ne l'a validée
    }
  }
  return out;
}

/**
 * Le workflow que fera le bloc, d'après les entrées branchées (`connected` : ids de ports, la Consigne comprise ou
 * non) et le choix gardé par Quentin quand deux vont aussi bien (`choice` : id de workflow).
 * → { workflow, ties: [workflows à égalité], unused: [ports branchés qui ne servent pas], missing: [ports à brancher],
 *     blocked: vrai si aucun workflow n'est possible avec ce qui est branché }
 */
export function chooseWorkflow(fam, connected, choice) {
  const wfs = (fam && fam.def && fam.def.workflows) || [];
  const on = new Set((connected || []).filter((p) => p !== 'prompt'));
  const scored = wfs.map((wf, i) => {
    const ports = portsOfWorkflow(wf);
    const req = wf.required || [];
    const missReq = req.filter((p) => !on.has(p));
    const missOne = (wf.oneOf || []).filter((g) => !g.some((p) => on.has(p)));
    const used = [...on].filter((p) => ports[p]);
    const unused = [...on].filter((p) => !ports[p]);
    return {
      // need : ce que la façon de faire exige (entrées obligatoires, groupes « l'une ou l'autre ») — à score égal, celle
      // qui a ce qu'elle exige passe devant celle qui n'exige rien (des références + une image-clé → les références)
      wf, i, eligible: !missReq.length && !missOne.length, used: used.length, unused, need: req.length + (wf.oneOf || []).length,
      size: Object.keys(ports).length, missing: [...missReq, ...missOne.map((g) => g[0])],
      score: used.length - 10 * unused.length,
    };
  });
  const ok = scored.filter((s) => s.eligible);
  if (!ok.length) {
    // rien ne va : le plus proche (le moins de choses à brancher), pour dire quoi brancher
    const near = scored.slice().sort((a, b) => a.missing.length - b.missing.length || b.used - a.used || a.i - b.i)[0];
    return near ? { workflow: near.wf, ties: [], unused: near.unused, missing: near.missing, blocked: true } : null;
  }
  ok.sort((a, b) => b.score - a.score || b.need - a.need || a.size - b.size || a.i - b.i);
  const best = ok[0];
  // à égalité (même score, mêmes exigences) : le choix est offert ; par défaut la plus petite
  const ties = ok.filter((s) => s.score === best.score && s.need === best.need).map((s) => s.wf);
  const picked = (choice && ties.find((w) => w.id === choice)) || best.wf;
  const s = scored.find((x) => x.wf === picked);
  return { workflow: picked, ties: ties.length > 1 ? ties : [], unused: s.unused, missing: [], blocked: false };
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
