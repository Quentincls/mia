'use strict';
// Online Model block (SPEC §23.3): the job runs at Higgsfield, not on the PC (no GPU lock, can run beside a
// local job). Only when Quentin clicks Run on that very block: the planner never starts it for a block
// downstream. Steps: each connected input is checked (length of a source video) then uploaded (presigned upload:
// the file goes to Higgsfield's storage, the key never does), the request goes to the workflow's endpoint with the
// block's settings, its status is read every few seconds, and the result is downloaded into the version's folder.
// The endpoint, the field of each input and each setting come from src/catalog/cloud-higgsfield.json
// (normalized by tools/build-cloud-catalog.mjs): nothing is guessed here. Only what the chosen tier accepts is sent
// (onlyTiers, tierOptions); a value the model does not take is brought back AND said in the version's notes.
// A job already started at Higgsfield is paid: cancelling it in Mia never throws the result away (« cloud-locked »).
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const P = require('../patch');

const E = P.exec;

const TXT = {
  uploading: { fr: 'Envoi des fichiers à Higgsfield… {n}/{total}', en: 'Sending files to Higgsfield… {n}/{total}' },
  converting: { fr: 'Préparation de « {name} »…', en: 'Preparing “{name}”…' },
  submitting: { fr: 'Demande envoyée à Higgsfield…', en: 'Request sent to Higgsfield…' },
  queued: { fr: 'En file chez Higgsfield…', en: 'Queued at Higgsfield…' },
  full: { fr: 'File Higgsfield pleine, nouvel essai dans {s} s', en: 'Higgsfield queue full, trying again in {s} s' },
  retry: { fr: 'Higgsfield ne répond pas, nouvel essai dans {s} s', en: 'Higgsfield is not answering, trying again in {s} s' },
  waitGpu: { fr: 'Attend la fin du calcul sur le GPU pour préparer « {name} »…', en: 'Waiting for the GPU job to end to prepare “{name}”…' },
  running: { fr: 'Calcul en cours chez Higgsfield…', en: 'Computing at Higgsfield…' },
  downloading: { fr: 'Récupération du résultat…', en: 'Fetching the result…' },
  failed: { fr: 'Higgsfield n’a pas pu faire ce calcul : {why}', en: 'Higgsfield could not do this job: {why}' },
  nsfw: { fr: 'Higgsfield a refusé le contenu (modération). Rien n’est facturé.', en: 'Higgsfield refused the content (moderation). Nothing is charged.' },
  canceled: { fr: 'Le calcul a été annulé chez Higgsfield.', en: 'The job was cancelled at Higgsfield.' },
  noOutput: { fr: 'Higgsfield a fini sans renvoyer de fichier.', en: 'Higgsfield finished without returning a file.' },
  tooLong: { fr: 'Toujours pas fini chez Higgsfield après {m} min : la demande reste visible sur leur console.', en: 'Still not done at Higgsfield after {m} min: the request stays visible in their console.' },
  done: { fr: 'Calculé en ligne par Higgsfield : {family} · {what}.', en: 'Computed online by Higgsfield: {family} · {what}.' },
  preview: { fr: 'Aperçu : la plus petite résolution et la durée la plus courte du modèle (moins de crédits).', en: 'Preview: the model’s smallest resolution and shortest length (fewer credits).' },
  // the job message while a cancelled job that Higgsfield can no longer stop is still fetched (« cloud-locked »)
  locked: { fr: 'Higgsfield ne peut plus l’arrêter : le calcul est déjà payé, Mia le récupère.', en: 'Higgsfield can no longer stop it: the job is already paid, Mia is fetching it.' },
  lockedNote: { fr: 'Annulé trop tard : le calcul était déjà payé chez Higgsfield, Mia l’a récupéré.', en: 'Cancelled too late: the job was already paid at Higgsfield, Mia fetched it.' },
  needPrompt: { fr: '{family} demande une consigne : écris ce que tu veux voir.', en: '{family} needs a prompt: write what you want to see.' },
  needPromptTier: { fr: '{family} en « {tier} » demande une consigne : écris ce que tu veux voir.', en: '{family} in “{tier}” needs a prompt: write what you want to see.' },
  srcShort: { fr: '« {label} » dure {s} s : {family} demande au moins {min} s. Rien n’a été envoyé.', en: '“{label}” lasts {s} s: {family} needs at least {min} s. Nothing was sent.' },
  srcLong: { fr: '« {label} » dure {s} s : {family} accepte au plus {max} s. Rien n’a été envoyé.', en: '“{label}” lasts {s} s: {family} takes at most {max} s. Nothing was sent.' },
  notInTier: { fr: '« {label} » n’existe pas en « {tier} » : pas envoyé.', en: '“{label}” does not exist in “{tier}”: not sent.' },
  brought: { fr: '« {label} » : {v} n’existe pas ici, ramené à {to}.', en: '“{label}”: {v} is not available here, brought back to {to}.' },
  clamped: { fr: '« {label} » : {v} hors des bornes du modèle ({min} à {max}), ramené à {to}.', en: '“{label}”: {v} is outside the model’s range ({min} to {max}), brought back to {to}.' },
  fromSource: { fr: 'Durée prise sur la vidéo source : {s} s.', en: 'Length taken from the source video: {s} s.' },
  maybeSent: { fr: 'Higgsfield n’a pas répondu ({why}) : un calcul a peut-être été lancé chez eux. Vérifie leur console avant de relancer.', en: 'Higgsfield did not answer ({why}): a job may have started there. Check their console before running again.' },
  cited: { fr: 'Citations réécrites pour {family} : {list}.', en: 'References rewritten for {family}: {list}.' },
};

const POLL_MS = Number(process.env.MIA_HF_POLL_MS) || 4000;
const MAX_MIN = 60;

/** Content types Higgsfield takes (docs: file uploads); anything else is converted with ffmpeg first. */
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

// ── catalog helpers ────────────────────────────────────────────────────────────────────────────────────
let catalogCache = null;
function catalog() {
  if (catalogCache) return catalogCache;
  try { catalogCache = require('../route').catalogs().cloud || { families: [] }; } catch { catalogCache = { families: [] }; }
  return catalogCache;
}
/**
 * The workflow as the catalog describes it, with what the planner handed (x.gen: endpoints, ports, params). The
 * planner keeps only a few fields; the rest (promptRequiredTiers, cite, durationFromSource, price) is read here.
 */
function wfOf(x) {
  const g = x.gen || {};
  const fam = (catalog().families || []).find((f) => f.key === g.key);
  const wf = fam && (fam.workflows || []).find((w) => w.id === g.workflow);
  return { ...(wf || {}), ...g, name: (fam && fam.name) || g.family || '' };
}
let portNames = null;
/** « Vidéo source », « Image de fin »… : the Model block's own input names (nodes.json). */
function portLabel(port) {
  if (!portNames) {
    portNames = {};
    try {
      const n = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'catalog', 'nodes.json'), 'utf8'));
      const list = Array.isArray(n) ? n : n.types || n.nodes || [];
      const gen = (list || []).find((t) => t && t.id === 'gen');
      for (const i of (gen && gen.inputs) || []) portNames[i.id] = i.label;
    } catch { /* names stay the ids */ }
  }
  return portNames[port] ? E.t(portNames[port]) : port;
}
const paramLabel = (p) => (p && p.label ? E.t(p.label) : (p && p.id) || '');

/** The tier the block asks for: its « Qualité », else the default the block shows (null: one tier only). */
function tierOf(x, g = (x && x.gen) || {}) {
  const tp = (g.params || []).find((p) => p.id === 'hf.tier');
  if (!tp) return null;
  const v = x.params && x.params['hf.tier'];
  return (tp.options || []).some((o) => String(o.value) === String(v)) ? v : tp.default;
}
function tierName(g, tier) {
  const tp = ((g && g.params) || []).find((p) => p.id === 'hf.tier');
  const o = tp && (tp.options || []).find((q) => String(q.value) === String(tier));
  return o ? E.t(o.label) : String(tier || '');
}
const inTier = (d, tier) => !d || !Array.isArray(d.onlyTiers) || !tier || d.onlyTiers.includes(tier);
/** The values this setting takes in this tier (tierOptions), or all of them. */
function optionsFor(p, tier) {
  const all = (p.options || []).map((o) => o.value);
  const only = tier && p.tierOptions && p.tierOptions[tier];
  if (!Array.isArray(only)) return all;
  return [...all.filter((v) => only.some((o) => String(o) === String(v))), ...only.filter((o) => !all.some((v) => String(v) === String(o)))];
}
/** Rank of a resolution: 480p < 720p < 1080p < 2k < 4k (anything else: NaN, not a resolution). */
function resRank(v) {
  const s = String(v).toLowerCase();
  let m = /^(\d+)p$/.exec(s);
  if (m) return Number(m[1]);
  m = /^(\d+(?:\.\d+)?)k$/.exec(s);
  if (m) return Number(m[1]) * 1000;
  return NaN;
}
/** The nearest allowed value: by resolution rank, by number, else the default when allowed, else the first. */
function nearest(v, allowed, def) {
  if (!allowed.length) return undefined;
  const rv = resRank(v);
  if (Number.isFinite(rv) && allowed.every((a) => Number.isFinite(resRank(a)))) {
    return allowed.slice().sort((a, b) => Math.abs(resRank(a) - rv) - Math.abs(resRank(b) - rv) || resRank(a) - resRank(b))[0];
  }
  if (Number.isFinite(Number(v)) && String(v).trim() !== '' && allowed.every((a) => Number.isFinite(Number(a)))) {
    return allowed.slice().sort((a, b) => Math.abs(a - v) - Math.abs(b - v) || a - b)[0];
  }
  const d = allowed.find((a) => String(a) === String(def));
  return d !== undefined ? d : allowed[0];
}
const fmt = (v) => (typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v));

async function prepare(x, item, port, i) {
  const ext = path.extname(item.abs).toLowerCase();
  const kind = item.kind || (IMAGE_TYPES[ext] ? 'image' : ext === '.wav' ? 'audio' : 'video');
  if (kind === 'image' && IMAGE_TYPES[ext]) return { abs: item.abs, type: IMAGE_TYPES[ext] };
  if (kind === 'video' && ext === '.mp4') return { abs: item.abs, type: 'video/mp4' };
  if (kind === 'audio' && ext === '.wav') return { abs: item.abs, type: 'audio/wav' };
  x.progress(null, E.t(TXT.converting, { name: path.basename(item.abs) }));
  const dir = path.join(x.outDir, '_upload');
  await fsp.mkdir(dir, { recursive: true });
  const base = `${port}${i != null ? `_${i + 1}` : ''}`;
  if (kind === 'image') {
    const dst = path.join(dir, `${base}.png`);
    await x.ffmpeg.run(['-y', '-i', item.abs, '-frames:v', '1', dst], { signal: x.signal });
    return { abs: dst, type: 'image/png' };
  }
  if (kind === 'audio') {
    const dst = path.join(dir, `${base}.wav`);
    await x.ffmpeg.run(['-y', '-i', item.abs, '-vn', '-ac', '2', '-ar', '48000', dst], { signal: x.signal });
    return { abs: dst, type: 'audio/wav' };
  }
  const dst = path.join(dir, `${base}.mp4`);
  // a real re-encode: never beside a local GPU job (lab rule); the online lane otherwise never waits for the GPU
  if (typeof x.whenGpuIdle === 'function') {
    await x.whenGpuIdle(E.t(TXT.waitGpu, { name: path.basename(item.abs) }));
    x.progress(null, E.t(TXT.converting, { name: path.basename(item.abs) }));
  }
  // marked as local work while it runs: a heavy job queued meanwhile waits for it (engine: x.localWork, if provided)
  const encode = () => x.ffmpeg.run(['-y', '-i', item.abs, ...x.ffmpeg.encodeArgs({ quality: 'hq' }), '-c:a', 'aac', dst], { signal: x.signal });
  if (typeof x.localWork === 'function') await x.localWork(encode);
  else await encode();
  return { abs: dst, type: 'video/mp4' };
}

/**
 * Value of one setting for the request (catalog param of the workflow), or undefined to leave it out.
 * `ctx`: { preview, tier, notes (receives « ramené à… »), sourceSeconds {port: s}, durationFromSource }; a boolean
 * third argument still means `preview`.
 */
function valueOf(p, x, ctx = {}) {
  if (typeof ctx === 'boolean') ctx = { preview: ctx };
  const notes = ctx.notes || [];
  const tier = ctx.tier !== undefined ? ctx.tier : tierOf(x);
  const asked = x.params ? x.params[p.id] : undefined;
  const unset = asked === undefined || asked === null || asked === '';
  let v = unset ? p.default : asked;
  const opts = Array.isArray(p.options) ? optionsFor(p, tier) : null;
  // a source video's length as the default length (Kling 4.0 edit: the API does not copy it), within the model's bounds
  const src = ctx.durationFromSource && ctx.sourceSeconds ? ctx.sourceSeconds[ctx.durationFromSource] : 0;
  if (unset && p.field === 'duration' && src > 0 && !ctx.preview) {
    v = opts && opts.length ? nearest(Math.round(src), opts, p.default)
      : Math.max(p.min ?? 0, Math.min(p.max ?? Infinity, Math.round(src)));
    notes.push(E.t(TXT.fromSource, { s: fmt(v) }));
  }
  if (ctx.preview && p.field === 'resolution' && opts && opts.length) {
    const ranked = opts.filter((o) => Number.isFinite(resRank(o)));
    if (ranked.length) v = ranked.sort((a, b) => resRank(a) - resRank(b))[0];
  }
  if (ctx.preview && p.field === 'duration') {
    if (opts && opts.length) v = opts.slice().sort((a, b) => Number(a) - Number(b))[0];
    else if (p.min != null) v = p.min;
  }
  if (v === undefined || v === null || v === '') return undefined;
  if (p.kind === 'toggle' && p.on !== undefined) return v ? p.on : p.off;
  if (p.kind === 'toggle') return !!v;
  if (p.kind === 'slider' || p.kind === 'number' || p.kind === 'seed') {
    let n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    if (p.kind === 'seed' || p.step === 1) n = Math.round(n);
    const lo = p.min != null ? p.min : -Infinity;
    const hi = p.max != null ? p.max : Infinity;
    if (n < lo || n > hi) {
      const to = Math.max(lo, Math.min(hi, n));
      notes.push(E.t(TXT.clamped, { label: paramLabel(p), v: fmt(n), min: fmt(lo), max: fmt(hi), to: fmt(to) }));
      n = to;
    }
    return n;
  }
  if (opts) {
    const o = opts.find((q) => String(q) === String(v));
    if (o !== undefined) return o;
    // never a silent return to the default: brought back to the nearest value, and said
    const to = nearest(v, opts, p.default);
    if (to === undefined) return undefined;
    notes.push(E.t(TXT.brought, { label: paramLabel(p), v: fmt(v), to: fmt(to) }));
    return to;
  }
  if (p.format === 'int-list') {
    const list = String(v).split(/[\s,;]+/).map(Number).filter((k) => Number.isInteger(k) && k > 0);
    const out = p.maxItems ? list.slice(0, p.maxItems) : list;
    return out.length ? out : undefined;
  }
  if (typeof v === 'string') { const s = v.trim(); return s || undefined; }   // never an empty string (« omit unused fields »)
  return v;
}

/**
 * The files to upload, in order. Whether a port gets ONE url or a LIST is the online field's own shape (catalog
 * `multi`), never how Mia holds the wires: the Model block's « Images de référence » always comes as a list, but
 * SOUL's image_reference_url was a single url (Quentin's first real run, 25/10: « URL input should be a string »).
 * An input the chosen tier does not have (Kling 3.0 Turbo: no end image) is left out.
 */
function uploadsOf(x, tier = tierOf(x)) {
  const g = x.gen;
  const items = [];
  for (const [port, v] of Object.entries(x.inputs || {})) {
    const def = (g.ports || {})[port];
    if (port === 'prompt' || !def || !def.field || !inTier(def, tier)) continue;
    const list = (Array.isArray(v) ? v : [v]).filter((it) => it && it.abs);
    // a single field takes the first file only (the planner already notes « … au plus » past the maximum)
    (def.multi ? list : list.slice(0, 1)).forEach((it, i) => items.push({ port, it, i: list.length > 1 ? i : null, multi: !!def.multi }));
  }
  return items;
}

/** « Vidéo 1 » / « Image 2 » written in the prompt → the model's own tokens (« @video_2 » for Kling 4.0 edit). */
function citePrompt(prompt, cite) {
  if (!cite || !prompt) return { prompt, changed: [] };
  const changed = [];
  const out = String(prompt).replace(/(^|[^\p{L}\p{N}_@])(Image|Vidéo|Video) (\d{1,2})(?![\p{L}\p{N}_])/gu, (all, pre, word, n) => {
    const isVideo = word !== 'Image';
    const tpl = isVideo ? cite.video : cite.image;
    if (!tpl) return all;
    const tok = tpl.replace('{n}', String(Number(n) + (isVideo ? (cite.videoFrom || 1) - 1 : 0)));
    changed.push(`« ${word} ${n} » → « ${tok} »`);
    return `${pre}${tok}`;
  });
  return { prompt: out, changed: [...new Set(changed)] };
}

/**
 * The request body: prompt, uploaded inputs at their field (a list or one url, as the field wants), settings — only
 * those of the chosen tier. The block's hidden local negative prompt (« text, watermark, cuts ») is never sent: only
 * the online « À éviter » (hf.negative_prompt) counts. `ctx`: valueOf's, plus cite and family (a boolean = preview).
 */
function bodyOf(x, urls, ctx = {}) {
  if (typeof ctx === 'boolean') ctx = { preview: ctx };
  const g = x.gen;
  const notes = ctx.notes || [];
  const tier = ctx.tier !== undefined ? ctx.tier : tierOf(x);
  const c = { ...ctx, tier, notes };
  const body = {};
  const ports = g.ports || {};
  let { prompt } = E.promptOf(x);
  if (ctx.cite) {
    const r = citePrompt(prompt, ctx.cite);
    if (r.changed.length) { prompt = r.prompt; notes.push(E.t(TXT.cited, { family: ctx.family || g.family || '', list: r.changed.join(', ') })); }
  }
  if (ports.prompt && prompt) body.prompt = prompt;
  for (const [port, url] of Object.entries(urls || {})) {
    const def = ports[port];
    if (!def || !def.field || !inTier(def, tier)) continue;
    if (def.multi) body[def.field] = Array.isArray(url) ? url : [url];
    else body[def.field] = Array.isArray(url) ? url[0] : url;
  }
  for (const p of g.params || []) {
    if (!p.field) continue;                                     // hf.tier picks the endpoint, it is no field
    if (!inTier(p, tier)) {
      const asked = x.params ? x.params[p.id] : undefined;
      if (asked !== undefined && asked !== null && asked !== '' && String(asked) !== String(p.default)) {
        notes.push(E.t(TXT.notInTier, { label: paramLabel(p), tier: tierName(g, tier) }));
      }
      continue;
    }
    const v = valueOf(p, x, c);
    if (v !== undefined) body[p.field] = v;
  }
  return body;
}

function endpointOf(x) {
  const eps = x.gen.endpoints || {};
  // an untouched « Qualité » is its default, the one the block shows — never the first endpoint listed (Kling 3.0's
  // first was 4K: shown « Pro », billed 4K, audit 28/10)
  const tier = tierOf(x);
  return eps[tier] || eps.default || Object.values(eps)[0];
}

/** Length (s) of the video wired on each port that needs it (minSeconds, maxSeconds, durationFromSource). */
async function sourceSeconds(x, W, tier) {
  const out = {};
  const want = new Set();
  for (const [port, d] of Object.entries(W.ports || {})) if (d && (d.minSeconds || d.maxSeconds) && inTier(d, tier)) want.add(port);
  if (W.durationFromSource) want.add(W.durationFromSource);
  if (!want.size || !x.ffmpeg || typeof x.ffmpeg.probe !== 'function') return out;
  for (const port of want) {
    const v = x.inputs && x.inputs[port];
    const first = (Array.isArray(v) ? v : [v]).find((it) => it && it.abs);
    if (!first) continue;
    try {
      const p = await x.ffmpeg.probe(first.abs);
      if (p && p.duration > 0) out[port] = p.duration;
    } catch { /* unreadable here: Higgsfield will say */ }
  }
  return out;
}

async function run(x) {
  E.begin(x);
  const g = x.gen;
  const svc = x.cloud;
  if (!svc || !svc.linked()) throw Object.assign(new Error(svc ? svc.tr('notLinked') : 'Higgsfield'), {});
  const W = wfOf(x);
  const preview = x.mode === 'preview';
  const tier = tierOf(x);
  const notes = [];
  const said = [];                                 // corrections of settings (« ramené à… »), said in the notes
  if (preview) notes.push(E.t(TXT.preview));

  // 0. before anything is sent (nothing uploaded, nothing paid): a prompt this tier needs, the source's length
  const { prompt } = E.promptOf(x);
  const tierNeeds = Array.isArray(W.promptRequiredTiers) && W.promptRequiredTiers.includes(tier);
  if ((W.promptRequired || tierNeeds) && !prompt) {
    throw new Error(tierNeeds ? E.t(TXT.needPromptTier, { family: W.name, tier: tierName(g, tier) }) : E.t(TXT.needPrompt, { family: W.name }));
  }
  const secs = await sourceSeconds(x, W, tier);
  for (const [port, s] of Object.entries(secs)) {
    const d = (W.ports || {})[port] || {};
    const shown = fmt(Math.round(s * 10) / 10);
    if (d.minSeconds && s < d.minSeconds - 0.05) throw new Error(E.t(TXT.srcShort, { label: portLabel(port), s: shown, family: W.name, min: d.minSeconds }));
    if (d.maxSeconds && s > d.maxSeconds + 0.05) throw new Error(E.t(TXT.srcLong, { label: portLabel(port), s: shown, family: W.name, max: d.maxSeconds }));
  }
  // an input the chosen tier does not take: said, not sent
  for (const [port, v] of Object.entries(x.inputs || {})) {
    const d = (g.ports || {})[port];
    const has = (Array.isArray(v) ? v : [v]).some((it) => it && it.abs);
    if (has && d && d.field && !inTier(d, tier)) said.push(E.t(TXT.notInTier, { label: portLabel(port), tier: tierName(g, tier) }));
  }

  // 1. inputs → presigned uploads (one URL per file; a list only where the online field takes a list)
  const items = uploadsOf(x, tier);
  const urls = {};
  let n = 0;
  for (const { port, it, i, multi } of items) {
    E.checkAbort(x);
    x.progress(items.length ? (n / items.length) * 0.15 : 0, E.t(TXT.uploading, { n: n + 1, total: items.length }));
    const f = await prepare(x, it, port, i);
    const url = await svc.upload(f.abs, f.type, { signal: x.signal });
    if (multi) (urls[port] = urls[port] || []).push(url);
    else urls[port] = url;
    n++;
  }
  await fsp.rm(path.join(x.outDir, '_upload'), { recursive: true, force: true }).catch(() => {});
  E.checkAbort(x);

  // 2. the request (Idempotency-Key = this version: a retry after a network cut is not charged twice). Sent without
  // the cancel signal: once it has left, Mia must know its id, to cancel it at Higgsfield or fetch what is paid.
  x.progress(0.16, E.t(TXT.submitting));
  const endpoint = endpointOf(x);
  const body = bodyOf(x, urls, { preview, tier, notes: said, sourceSeconds: secs, durationFromSource: W.durationFromSource,
    cite: W.cite, family: W.name });
  // the run log keeps the settings, never the addresses of the uploaded files (public links to the user's media)
  const isUrl = (v) => typeof v === 'string' && /^https?:/i.test(v);
  const logged = Object.fromEntries(Object.entries(body).map(([k, v]) => [k,
    k === 'prompt' && v ? `${String(v).slice(0, 60)}…`
      : isUrl(v) ? '<url>' : Array.isArray(v) && v.some(isUrl) ? `<${v.length} url>` : v]));
  x.log(`Higgsfield : POST /${endpoint} ${JSON.stringify(logged)}`);
  for (const s of said) x.log(s);
  const sub = await submit(x, svc, endpoint, body);
  x.log(`Higgsfield : demande ${sub.request_id}`);

  // 3. status every few seconds. A cancel in Mia cancels at Higgsfield while it is still queued; once Higgsfield
  // cannot stop it any more it is paid: Mia keeps waiting and fetches the result (never thrown away).
  const t0 = Date.now();
  const statusUrl = sub.status_url || `requests/${sub.request_id}/status`;
  let st = sub;
  let locked = false;
  const live = () => (locked ? undefined : x.signal);
  for (;;) {
    if (!locked && x.signal && x.signal.aborted) {
      let stopped = false;
      if (st.status === 'queued' && sub.cancel_url) {
        stopped = await svc.call('POST', sub.cancel_url, null, {}).then(() => true, () => false);
        if (stopped) st = await svc.call('GET', statusUrl, null, {}).catch(() => st);
      }
      // accepted (« canceled », or still in the queue it leaves): nothing charged, the cancel goes through
      if (stopped && st.status !== 'in_progress' && st.status !== 'completed') E.checkAbort(x);
      if (['queued', 'in_progress', 'completed'].includes(st.status)) {
        locked = true;
        x.log(E.t(TXT.locked));
        x.progress(null, E.t(TXT.locked));
      } else if (st.status !== 'failed' && st.status !== 'nsfw') E.checkAbort(x);
    }
    if (st.status === 'completed') break;
    if (st.status === 'failed') throw new Error(E.t(TXT.failed, { why: st.error || '?' }));
    if (st.status === 'nsfw') throw new Error(E.t(TXT.nsfw));
    if (st.status === 'canceled') throw (x.signal && x.signal.aborted ? E.abortError() : new Error(E.t(TXT.canceled)));
    if (Date.now() - t0 > MAX_MIN * 60000) throw new Error(E.t(TXT.tooLong, { m: MAX_MIN }));
    remoteState(x, st.status === 'queued' ? 'queued' : 'running');
    x.progress(null, E.t(locked ? TXT.locked : st.status === 'in_progress' ? TXT.running : TXT.queued));
    await sleep(POLL_MS, live());
    try {
      st = await svc.call('GET', statusUrl, null, { signal: live() });
    } catch (e) {
      if (!locked && x.signal && x.signal.aborted) continue;
      if (e.retry || !e.status) { await sleep(Math.min(30, e.retry || 5) * 1000, live()); continue; }   // 5xx, network: retry
      throw e;
    }
  }

  // 4. the result, into this version's folder (a locked job: without the cancel signal, it is paid)
  x.progress(0.95, E.t(locked ? TXT.locked : TXT.downloading));
  const out = (st.video && st.video.url && { url: st.video.url, kind: 'video' })
    || (Array.isArray(st.images) && st.images[0] && st.images[0].url && { url: st.images[0].url, kind: 'image' })
    || (st.audio && st.audio.url && { url: st.audio.url, kind: 'audio' });
  if (!out) throw new Error(E.t(TXT.noOutput));
  const ext = (path.extname(new URL(out.url).pathname).toLowerCase().match(/^\.(mp4|mov|webm|png|jpe?g|webp|wav|mp3)$/) || [])[0]
    || (out.kind === 'video' ? '.mp4' : out.kind === 'image' ? '.png' : '.wav');
  const dst = path.join(x.outDir, `result${ext}`);
  await svc.download(out.url, dst, { signal: live() });
  x.progress(1, E.t(locked ? TXT.locked : TXT.downloading));
  notes.unshift(E.t(TXT.done, { family: g.family, what: g.what }));
  if (locked) notes.unshift(E.t(TXT.lockedNote));
  notes.push(...said);
  return {
    outputs: { out: { abs: dst, kind: out.kind } },
    model: `${g.family} (Higgsfield)`,
    notes: E.notes(notes),
    provider: 'higgsfield',
    request: sub.request_id,
    ...(locked ? { locked: true } : {}),
  };
}

/** Tell the engine where the job is at Higgsfield (queue of Mia: « en file chez Higgsfield »). */
function remoteState(x, st) {
  if (x && typeof x.remote === 'function') { try { x.remote(st); } catch { /* display only */ } }
}

/**
 * The request, with ONE Idempotency-Key for this version (x.runId), the same on every retry: Higgsfield never
 * charges it twice. Retried automatically, with that key:
 * - 429 (its queue is full for the account, `account_queue_full`, or too many at once): nothing was created nor
 *   charged; wait Retry-After (shown as a countdown), then send again, as long as MAX_MIN allows;
 * - 5xx or the network: a few times, a little longer each time.
 * A cancel during a wait after a 429 stops here: Higgsfield created nothing, nothing is paid. After a network cut or a
 * 5xx it may have created the request anyway (the answer was lost): a cancel then sends the SAME request one last time
 * (same key, no signal), so that Mia gets its id back and the status loop cancels it while queued, or fetches what is
 * paid (« cloud-locked »). If that last try fails too, the error says a job may have started.
 */
async function submit(x, svc, endpoint, body) {
  const t0 = Date.now();
  let other = 0;
  let maybeSent = false;   // a network cut or a 5xx: Higgsfield may have kept the request
  const post = () => svc.call('POST', endpoint, body, { headers: { 'Idempotency-Key': x.runId } });
  const lastTry = async () => {
    x.log('Higgsfield : annulé après une coupure, dernier envoi (même Idempotency-Key) pour retrouver une demande peut-être créée');
    try {
      const sub = await post();
      remoteState(x, sub && sub.status === 'queued' ? 'queued' : 'running');
      return sub;
    } catch (e) {
      if (e && e.status && e.status < 500 && e.status !== 429) throw e;
      throw new Error(E.t(TXT.maybeSent, { why: (e && (e.userMessage || e.message)) || '?' }));
    }
  };
  for (;;) {
    if (maybeSent && x.signal && x.signal.aborted) return lastTry();
    E.checkAbort(x);
    try {
      const sub = await post();
      remoteState(x, sub && sub.status === 'queued' ? 'queued' : 'running');
      return sub;
    } catch (e) {
      const full = e && e.status === 429;
      const flaky = e && e.userMessage && (!e.status || e.status >= 500);
      if (!full && !flaky) throw e;
      if (flaky) maybeSent = true;
      if (!full && ++other > 5) throw maybeSent ? new Error(E.t(TXT.maybeSent, { why: e.userMessage || e.message || '?' })) : e;
      if (Date.now() - t0 > MAX_MIN * 60000) throw e;
      const wait = full ? Math.max(1, Math.round(e.retry || 10)) : Math.min(30, (e.retry || 5) * other);
      x.log(`Higgsfield : ${e.status || 'réseau'}${e.code ? ` (${e.code})` : ''}, nouvel essai dans ${wait} s (même Idempotency-Key)`);
      if (full) remoteState(x, 'full');
      for (let left = wait; left > 0; left--) {
        if (maybeSent && x.signal && x.signal.aborted) break;   // straight to the last try above
        E.checkAbort(x);
        x.progress(null, E.t(full ? TXT.full : TXT.retry, { s: left }));
        await sleep(1000, x.signal);
      }
    }
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const tm = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(tm); resolve(); }, { once: true });
  });
}

/** Rough minutes: an online video takes a few minutes, an image well under one. */
function estimate(x) {
  const g = x && x.gen;
  if (!g) return null;
  if (g.kind === 'image') return 0.5;
  return x.mode === 'preview' ? 2 : 4;
}

/**
 * « cloud-locked »: the job message (FR or EN) while a cancelled online job is still fetched because Higgsfield can no
 * longer stop it. The board can test job.message with isLocked() to show « Attendre le résultat » instead of Cancel.
 */
const LOCKED = TXT.locked;
const isLocked = (msg) => !!msg && (String(msg) === LOCKED.fr || String(msg) === LOCKED.en);

// not E.wrap: that tidies ComfyUI's temporary files, and an online job never touches ComfyUI
module.exports = { run, estimate, LOCKED, isLocked, _bodyOf: bodyOf, _endpointOf: endpointOf, _uploadsOf: uploadsOf,
  _valueOf: valueOf, _tierOf: tierOf, _wfOf: wfOf, _citePrompt: citePrompt, _resRank: resRank, _optionsFor: optionsFor };
