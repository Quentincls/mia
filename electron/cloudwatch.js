'use strict';
// La veille des modèles en ligne (SPEC §23.8, demande de Quentin du 25/11) : Mia repère les modèles que Higgsfield
// ajoute et que son catalogue ne connaît pas, les montre sur l'accueil (« 3 nouveaux modèles en ligne ») et les
// installe d'un clic, sans attendre une nouvelle version de Mia.
//
// - Repérer : les pages publiques de la console (aucune clé, aucun crédit), au plus une fois par jour et seulement
//   quand le compte Higgsfield est relié : le plan du site et les trois pages /explore (4 lectures). Une fois par
//   semaine, la page de chaque modèle connu aussi (ses modes voisins : un nouveau mode d'une famille connue).
//   Chaque modèle inconnu : sa page de console (titre, disponibilité, prix public) et son schéma sur dash
//   (llms.txt), normalisés par electron/cloud-catalog.js, le code même de l'outil de développement : mêmes champs
//   écartés, mêmes identifiants bloquants, mêmes paliers, mêmes clés de familles.
// - Installer : rien n'est relu, la famille préparée passe dans %APPDATA%\Mia\data\cloud-extra.json, que
//   engine/route.js fusionne au catalogue de Mia (le catalogue livré passe toujours devant). Un modèle installé
//   porte `fresh` (« Nouveau · pas encore essayé ») jusqu'à son premier calcul réussi.
// - Échouer en silence : une page illisible, un format changé (trop peu de modèles connus retrouvés), un réseau
//   absent ne proposent rien, n'effacent rien et ne cassent rien ; la raison va au journal et dans `reason`.
// Fichiers : cloud-watch.json (ce que la veille a vu, ce qui est écarté ou ignoré, coupée ou non),
// cloud-extra.json (ce qui est installé). Aucun secret dans l'un ni dans l'autre.
const fs = require('node:fs');
const path = require('node:path');
const C = require('./cloud-catalog');

const CONSOLE = (process.env.MIA_HF_CONSOLE || 'https://console.higgsfield.ai').replace(/\/+$/, '');
const DASH = (process.env.MIA_HF_DASH || C.DASH).replace(/\/+$/, '');
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MIN_KNOWN = 15;          // moins de modèles connus retrouvés sur les pages : leur format a changé, on se tait
const MAX_PAGES = 40;          // pages de modèles inconnus lues au plus par passage
const TIMEOUT = 20e3;

const STR = {
  fr: {
    format: 'Les pages de Higgsfield ont changé de forme : la veille ne propose rien pour l’instant.',
    offline: 'Higgsfield ne répond pas : la veille réessaiera plus tard.',
    noSchema: 'pas de schéma lisible sur dash.higgsfield.ai',
    tier: 'nouveau palier d’un mode déjà connu : viendra avec la prochaine version de Mia',
    unavailable: 'indisponible chez Higgsfield',
  },
  en: {
    format: 'Higgsfield’s pages changed shape: the watch offers nothing for now.',
    offline: 'Higgsfield does not answer: the watch will try again later.',
    noSchema: 'no readable schema on dash.higgsfield.ai',
    tier: 'new tier of a known mode: will come with the next version of Mia',
    unavailable: 'unavailable at Higgsfield',
  },
};
const L2 = (k) => ({ fr: STR.fr[k], en: STR.en[k] });

/** Toutes les adresses d'un catalogue (workflows, et ce qu'il écarte : déjà vu, pas nouveau). */
function endpointsOf(cat) {
  const out = new Set();
  for (const f of (cat && cat.families) || []) for (const w of f.workflows || []) for (const e of Object.values(w.endpoints || {})) out.add(e);
  for (const s of (cat && cat.skipped) || []) if (s && s.id) out.add(s.id);
  return out;
}

/** Les entrées d'une famille : l'union de celles de ses workflows (comme normalize). */
function portsOf(workflows) {
  const ports = {};
  for (const w of workflows) for (const [k, v] of Object.entries(w.ports || {})) if (!ports[k] || v.max > ports[k].max) ports[k] = { multi: v.multi, max: v.max };
  return ports;
}

/**
 * Catalogue livré + catalogue complémentaire → catalogue de Mia. Le livré passe devant : un workflow complémentaire
 * dont une adresse est déjà livrée est oublié (la nouvelle version de Mia l'a repris) ; une famille livrée garde sa
 * forme et reçoit seulement les workflows qu'elle n'a pas. Le livré n'est jamais modifié (copie).
 */
function mergeCatalog(builtin, extra) {
  const base = builtin && Array.isArray(builtin.families) ? builtin : { families: [] };
  const fams = (extra && Array.isArray(extra.families)) ? extra.families : [];
  if (!fams.length) return base;
  const known = endpointsOf(base);
  const out = { ...base, families: base.families.slice() };
  for (const xf of fams) {
    if (!xf || typeof xf.key !== 'string' || !/^hf:[a-z0-9-]+$/.test(xf.key) || !Array.isArray(xf.workflows)) continue;
    const at = out.families.findIndex((f) => f.key === xf.key);
    const have = new Set(at >= 0 ? out.families[at].workflows.map((w) => w.id) : []);
    const wfs = xf.workflows.filter((w) => w && typeof w.id === 'string' && w.endpoints && !have.has(w.id)
      && Object.values(w.endpoints).every((e) => !known.has(e)));
    if (!wfs.length) continue;
    for (const w of wfs) for (const e of Object.values(w.endpoints)) known.add(e);
    if (at >= 0) {
      const f = out.families[at];
      const workflows = [...f.workflows, ...wfs];
      out.families[at] = { ...f, workflows, ports: portsOf(workflows) };
    } else {
      out.families.push({ ...xf, workflows: wfs, ports: portsOf(wfs) });
    }
  }
  return out;
}

const readJSON = (file, empty) => { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' ? j : empty; } catch { return empty; } };
function writeJSON(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

/**
 * dir : %APPDATA%\Mia\data. builtin() : le catalogue livré (src/catalog/cloud-higgsfield.json). onChange(state) :
 * après un passage, une installation, un « ignorer ». fetch / now : remplaçables pour les bancs.
 */
function createWatch({ dir, builtin, lang = () => 'fr', log = () => {}, onChange = () => {}, fetch: get = globalThis.fetch, now = Date.now }) {
  const FILE = path.join(dir, 'cloud-watch.json');
  const EXTRA = path.join(dir, 'cloud-extra.json');
  const lg = () => (lang() === 'en' ? 'en' : 'fr');
  let running = null;

  const state = () => {
    const s = readJSON(FILE, {});
    return {
      off: !!s.off, lastCheck: Number(s.lastCheck) || 0, lastDeep: Number(s.lastDeep) || 0, ok: s.ok !== false,
      reason: s.reason || null, pending: Array.isArray(s.pending) ? s.pending : [],
      rejected: s.rejected && typeof s.rejected === 'object' ? s.rejected : {}, ignored: Array.isArray(s.ignored) ? s.ignored : [],
    };
  };
  const save = (s) => { try { writeJSON(FILE, s); } catch (e) { log(`[watch] écriture impossible : ${e.message}`); } };
  const extra = () => {
    const x = readJSON(EXTRA, null);
    return x && Array.isArray(x.families) ? x : { version: 2, families: [] };
  };

  async function page(url) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      const r = await get(url, { headers: { 'user-agent': 'Mia' }, signal: ctl.signal });
      if (!r.ok) return { status: r.status, text: null };
      return { status: r.status, text: await r.text() };
    } catch { return { status: 0, text: null }; } finally { clearTimeout(t); }
  }

  /** Ce qu'on montre sur l'accueil, et rien de plus (pas les schémas). */
  function brief(s = state()) {
    const l = lg();
    return {
      off: s.off, lastCheck: s.lastCheck || null, ok: s.ok, reason: s.reason ? s.reason[l] || s.reason.fr : null,
      pending: s.pending.map((p) => ({
        key: p.key, name: p.family.name, maker: p.family.maker, mark: p.family.mark, kind: p.family.kind, isNew: p.isNew,
        desc: p.family.desc ? p.family.desc[l] || p.family.desc.fr : '',
        does: p.family.workflows.map((w) => (w.label ? w.label[l] || w.label.fr : w.id)),
        priceFrom: priceFrom(p.family), slugs: p.slugs,
      })),
    };
  }
  const priceFrom = (fam) => {
    let best = null;
    for (const w of fam.workflows || []) if (w.price && Number.isFinite(w.price.min) && (!best || w.price.min < best.usd)) best = { usd: w.price.min, unit: w.price.unit };
    return best;
  };

  const due = (s = state()) => !s.off && now() - s.lastCheck >= DAY;

  /** Un passage de la veille. force : même avant le jour écoulé. Ne jette jamais. */
  function check({ force = false } = {}) {
    if (running) return running;
    running = (async () => {
      const s = state();
      if (!force && !due(s)) return brief(s);
      try { await pass(s); } catch (e) { s.ok = false; s.reason = L2('format'); log(`[watch] passage interrompu : ${e.message}`); }
      s.lastCheck = now();
      save(s);
      const b = brief(s);
      try { onChange(b); } catch { /* l'écran n'écoute pas : rien */ }
      return b;
    })().finally(() => { running = null; });
    return running;
  }

  async function pass(s) {
    const cat = builtin() || { families: [] };
    const ex = extra();
    const known = new Set([...endpointsOf(cat), ...endpointsOf(ex)]);
    const records = {};
    const slugs = new Set();
    const take = (html) => {
      if (!html) return;
      for (const x of C.linksOf(html)) slugs.add(x);
      for (const [k, r] of Object.entries(C.recordsOf(html))) { records[k] = C.merge(records[k], r); slugs.add(k); }
    };
    const top = [];
    for (const p of ['/sitemap.xml', '/explore', '/explore/video', '/explore/image']) {
      const r = await page(`${CONSOLE}${p}`);
      top.push(r.status);
      take(r.text);
    }
    if (top.every((x) => x === 0)) { s.ok = false; s.reason = L2('offline'); log('[watch] console injoignable'); return; }
    // les pages ont gardé leur forme : on y retrouve assez de modèles connus
    const seenKnown = [...slugs].filter((x) => known.has(x)).length;
    if (seenKnown < Math.min(MIN_KNOWN, known.size)) {
      s.ok = false; s.reason = L2('format');
      log(`[watch] format des pages changé ? ${slugs.size} modèles lus, ${seenKnown} connus : rien n'est proposé`);
      return;
    }
    // une fois par semaine : la page de chaque modèle connu de la console (ses modes voisins)
    const deep = now() - s.lastDeep >= WEEK;
    const t = now();
    const recent = (x) => s.rejected[x] && t - Number(s.rejected[x].at || 0) < WEEK;
    const ignored = new Set(s.ignored);
    const fresh = (x) => !known.has(x) && !recent(x) && !ignored.has(x);
    const queue = deep ? [...slugs].filter((x) => known.has(x)) : [];
    const read = new Set();
    const playground = {};
    const look = async (x) => {
      read.add(x);
      const r = await page(`${CONSOLE}/models/${x}/playground`);
      playground[x] = r.status;
      take(r.text);
    };
    for (const x of queue) { if (read.size >= MAX_PAGES + queue.length) break; await look(x); }
    if (deep) s.lastDeep = t;
    // les modèles inconnus : leur page (et leurs voisins inconnus), puis leur schéma
    let cands = [...slugs].filter(fresh);
    while (cands.some((x) => !read.has(x)) && read.size < MAX_PAGES + queue.length) {
      for (const x of cands.filter((y) => !read.has(y)).slice(0, 8)) await look(x);
      cands = [...slugs].filter(fresh);
    }
    cands = cands.slice(0, MAX_PAGES);
    const pending = s.pending.filter((p) => p.slugs.every((x) => !known.has(x)) && !p.slugs.some((x) => ignored.has(x)));
    const inPending = new Set(pending.flatMap((p) => p.slugs));
    cands = cands.filter((x) => !inPending.has(x));
    if (!cands.length) { s.pending = pending; s.ok = true; s.reason = null; return; }
    const dash = {};
    for (const x of cands) {
      const r = await page(`${DASH}/${x}/llms.txt`);
      dash[x] = r.text ? { status: 200, md: r.text } : { status: r.status === 0 ? 0 : 404 };
    }
    const raw = { source: 'dash', built: new Date(t).toISOString().slice(0, 10), records, playground, dash, docs: { families: [] } };
    const built = C.build({ ...raw, dash: Object.fromEntries(Object.entries(dash).filter(([, v]) => v.status !== 0)) });
    const taken = new Set();
    for (const f of built.families) {
      const have = cat.families.find((x) => x.key === f.key) || ex.families.find((x) => x.key === f.key);
      const haveIds = new Set(have ? have.workflows.map((w) => w.id) : []);
      const wfs = [];
      for (const w of f.workflows) {
        const eps = Object.values(w.endpoints);
        if (haveIds.has(w.id) || eps.some((e) => known.has(e))) {
          // un palier de plus d'un mode connu : la fusion ne sait pas l'ajouter (même id de workflow)
          for (const e of eps) if (!known.has(e)) s.rejected[e] = { at: t, reason: L2('tier') };
          continue;
        }
        wfs.push({ ...w, fresh: true });
        for (const e of eps) taken.add(e);
      }
      if (!wfs.length) continue;
      const fam = { ...f, workflows: wfs, ports: portsOf(wfs) };
      if (!have) fam.fresh = true;
      pending.push({ key: f.key, isNew: !have, family: fam, slugs: wfs.flatMap((w) => Object.values(w.endpoints)), found: t });
    }
    for (const sk of built.skipped) if (!taken.has(sk.id)) s.rejected[sk.id] = { at: t, reason: sk.reason };
    for (const x of cands) {
      if (taken.has(x) || s.rejected[x]) continue;
      if (dash[x].status === 0) continue;                 // réseau : on réessaiera au prochain passage
      const st = records[x] && records[x].state;
      s.rejected[x] = { at: t, reason: st && st !== 'available' ? L2('unavailable') : L2('noSchema') };
    }
    // un modèle prêt à installer qu'une famille du même nom attend déjà : un seul paquet par famille
    const byKey = new Map();
    for (const p of pending) {
      const q = byKey.get(p.key);
      if (!q) { byKey.set(p.key, p); continue; }
      const ids = new Set(q.family.workflows.map((w) => w.id));
      q.family.workflows.push(...p.family.workflows.filter((w) => !ids.has(w.id)));
      q.family.ports = portsOf(q.family.workflows);
      q.slugs = [...new Set([...q.slugs, ...p.slugs])];
    }
    s.pending = [...byKey.values()];
    s.ok = true; s.reason = null;
    log(`[watch] ${cands.length} modèle(s) inconnu(s) lus, ${s.pending.length} famille(s) à proposer`);
  }

  /** Installe les familles proposées (keys : leurs clés ; rien = toutes). → { ok, installed:[clés] } */
  function install(keys) {
    const s = state();
    const want = Array.isArray(keys) && keys.length ? new Set(keys) : null;
    const go = s.pending.filter((p) => !want || want.has(p.key));
    if (!go.length) return { ok: true, installed: [], watch: brief(s) };
    const x = extra();
    const t = now();
    x.version = 2;
    x._doc = 'Modèles en ligne installés par la veille de Mia (electron/cloudwatch.js), fusionnés au catalogue livré. Le catalogue livré passe devant.';
    x.installed = x.installed && typeof x.installed === 'object' ? x.installed : {};
    for (const p of go) {
      const at = x.families.findIndex((f) => f.key === p.key);
      if (at < 0) x.families.push(p.family);
      else {
        const ids = new Set(x.families[at].workflows.map((w) => w.id));
        const workflows = [...x.families[at].workflows, ...p.family.workflows.filter((w) => !ids.has(w.id))];
        x.families[at] = { ...x.families[at], workflows, ports: portsOf(workflows) };
      }
      x.installed[p.key] = { at: new Date(t).toISOString(), slugs: [...new Set([...((x.installed[p.key] || {}).slugs || []), ...p.slugs])] };
    }
    try { writeJSON(EXTRA, x); } catch (e) { log(`[watch] installation impossible : ${e.message}`); return { ok: false, error: e.message, installed: [] }; }
    s.pending = s.pending.filter((p) => !go.includes(p));
    save(s);
    log(`[watch] installé : ${go.map((p) => p.key).join(', ')}`);
    const b = brief(s);
    try { onChange(b); } catch { /* rien */ }
    return { ok: true, installed: go.map((p) => p.key), watch: b };
  }

  /** « Ignorer » : ces familles ne sont plus proposées (leurs adresses sont retenues). */
  function ignore(keys) {
    const s = state();
    const want = new Set(Array.isArray(keys) ? keys : []);
    const go = s.pending.filter((p) => want.has(p.key));
    s.ignored = [...new Set([...s.ignored, ...go.flatMap((p) => p.slugs)])];
    s.pending = s.pending.filter((p) => !go.includes(p));
    save(s);
    const b = brief(s);
    try { onChange(b); } catch { /* rien */ }
    return b;
  }

  /** Couper ou rallumer la veille (Réglages → Comptes en ligne). */
  function setOff(off) {
    const s = state();
    s.off = !!off;
    save(s);
    const b = brief(s);
    try { onChange(b); } catch { /* rien */ }
    return b;
  }

  /**
   * Premier calcul réussi d'un modèle installé : il perd « pas encore essayé ». → true si le fichier a changé.
   * family : clé, workflow : id (rien = toute la famille).
   */
  function tried(family, workflow) {
    const x = readJSON(EXTRA, null);
    if (!x || !Array.isArray(x.families)) return false;
    const f = x.families.find((y) => y.key === family);
    if (!f) return false;
    let changed = false;
    for (const w of f.workflows || []) if (w.fresh && (!workflow || w.id === workflow)) { delete w.fresh; changed = true; }
    if (f.fresh) { delete f.fresh; changed = true; }
    if (changed) { try { writeJSON(EXTRA, x); } catch { return false; } }
    return changed;
  }

  return { check, due, install, ignore, setOff, tried, state: () => brief(), extra, files: { watch: FILE, extra: EXTRA } };
}

module.exports = { createWatch, mergeCatalog, endpointsOf };
