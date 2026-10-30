'use strict';
// Prices of the online models (SPEC §23.3), asked to Higgsfield before anything is sent: POST /estimate/<endpoint> with
// the body the cloud executor would send (docs.higgsfield.ai, « Billing and retention »: free, the account's own price).
// The media a block would upload are not uploaded for a price: a placeholder address stands for each one (the price
// depends on the model, its tier, resolution, length, sound… not on the picture). Two uses:
//   - priceOf: the price of a Model block's current settings (its footer, next to « Générer ») — kept 10 minutes;
//   - fromPrices: « dès … $ » in « + Bloc » — each family's cheapest way: among its workflows that need no media
//     (text → video first), every tier, the smallest resolution and the shortest length — kept a day, in cloud.json.
// When Higgsfield gives no amount (Seedance, Wan 3.0, Cinema Studio answer with a description) or no account is linked,
// the public tariff read on the console (catalog `workflow.price`) stands in, marked { source:'public', approx:true }
// (« ≈ », a range that may include a temporary discount). A refusal (422…) is never hidden behind it.
const route = require('./route');
const exec = require('./executors/cloud');

const PLACEHOLDER = {
  image: 'https://example.com/mia-price-estimate.png',
  video: 'https://example.com/mia-price-estimate.mp4',
  audio: 'https://example.com/mia-price-estimate.wav',
};
const KIND = { video: 'video', guide: 'video', motion: 'video', refVideos: 'video', audio: 'audio', refAudios: 'audio' };
const BLOCK_MS = 10 * 60 * 1000;
const FROM_MS = 24 * 3600 * 1000;
const FROM_WAY = 3;                   // how « dès » is computed: a saved price made another way is asked again

const stable = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(stable).join(',')}]`
    : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`);

const famOf = (family) => {
  const R = route.rules();
  const { local, cloud } = route.catalogs();
  const fam = R.familyOf(family, local, cloud, null);
  return fam && fam.provider !== 'local' ? fam : null;
};
/** Media a workflow needs before it can run (required inputs, one per « either » group). */
const needs = (wf) => [...(wf.required || []), ...((wf.oneOf || []).map((g) => g[0]))].filter((p) => p !== 'prompt');

/** The workflows « dès » is asked on: those that need no media (text first), else the one that needs the fewest. */
function cheapestWays(fam) {
  const wfs = (fam && fam.def.workflows) || [];
  const free = wfs.filter((w) => !needs(w).length);
  if (free.length) return free;
  const least = Math.min(...wfs.map((w) => needs(w).length));
  return wfs.filter((w) => needs(w).length === least).slice(0, 1);
}

/**
 * The request a block with these settings and wires would send: { endpoint, body, wf, tier } (or null: no such model).
 * `seconds`: length of the videos wired on the block ({ video: 12.4 }), when the board knows them — the default length
 * of a workflow that takes it from its source (Kling 4.0 edit) then follows the real video.
 * `cheapest`: the cheapest way (see cheapestWays; `wf` picks one of them), at its smallest resolution and shortest
 * length, with `endpoints` = every tier of it (« Standard », « Pro », « 4K »… : which one is cheapest is Higgsfield's to say).
 */
function requestOf({ family, workflow = null, params = {}, ports = [], seconds = null } = {}, { cheapest = false, wf: way = null } = {}) {
  const fam = famOf(family);
  if (!fam) return null;
  const R = route.rules();
  const wf = cheapest ? (way || cheapestWays(fam)[0]) : R.chooseWorkflow(fam, ports, workflow || null).workflow;
  if (!wf) return null;
  const gen = { key: fam.key, workflow: wf.id, family: fam.def.name, endpoints: wf.endpoints, ports: wf.ports, params: wf.params };
  // each wired input (and each one the way of working needs) stands as a placeholder at its field
  const urls = {};
  const wanted = new Set([...(cheapest ? [] : ports), ...needs(wf)]);
  for (const port of wanted) {
    const def = (wf.ports || {})[port];
    if (!def || !def.field || port === 'prompt') continue;
    const url = PLACEHOLDER[KIND[port] || 'image'];
    urls[port] = def.multi ? Array.from({ length: Math.max(1, def.min || 1) }, () => url) : url;
  }
  const x = { gen, params: { ...params }, inputs: {} };
  // a prompt the model requires: any text, the price does not depend on it
  if (!String(x.params.prompt || '').trim()) x.params.prompt = 'price estimate';
  const tier = exec._tierOf(x);
  const body = exec._bodyOf(x, urls, { preview: cheapest, tier, sourceSeconds: seconds || {}, durationFromSource: wf.durationFromSource });
  if (cheapest) {
    const endpoints = [...new Set(Object.values(wf.endpoints || {}))];
    return endpoints.length ? { endpoint: endpoints[0], endpoints, body, wf, tier } : null;
  }
  const endpoint = exec._endpointOf(x);
  return endpoint ? { endpoint, body, wf, tier } : null;
}

const round3 = (v) => Math.round(v * 1000) / 1000;
/** The setting of the workflow for this field. */
const paramOf = (wf, field) => (wf.params || []).find((p) => p.field === field);

/**
 * The public tariff of a request (catalog `price`, read on the console): its tier's range, the rate placed by the
 * resolution's rank within it (smallest → min, largest → max), times the length for a price per second.
 * → { usd, unit, rate } or null (no tariff, or a price per second without any length to multiply).
 */
function publicPrice(req, seconds = null) {
  const wf = req && req.wf;
  const p = wf && wf.price;
  if (!p || !Number.isFinite(p.min)) return null;
  const range = (req.tier && p.tiers && p.tiers[req.tier]) || p;
  let rate = range.min;
  const rp = paramOf(wf, 'resolution');
  const res = req.body && req.body.resolution;
  if (rp && res != null && Number.isFinite(range.max) && range.max > range.min) {
    const opts = exec._optionsFor(rp, req.tier).filter((o) => Number.isFinite(exec._resRank(o)))
      .sort((a, b) => exec._resRank(a) - exec._resRank(b));
    const i = opts.findIndex((o) => String(o) === String(res));
    if (i >= 0 && opts.length > 1) rate = range.min + (range.max - range.min) * (i / (opts.length - 1));
  }
  if (p.unit === 'second') {
    const d = Number(req.body && req.body.duration)
      || (wf.durationFromSource && seconds && seconds[wf.durationFromSource]) || 0;
    if (!(d > 0)) return null;
    return { usd: round3(rate * d), unit: p.unit, rate };
  }
  return { usd: round3(rate), unit: p.unit, rate };
}

/** « dès » from the public tariff: the lowest rate of the cheapest ways × their shortest length. */
function publicFrom(fam) {
  let best = null;
  for (const wf of cheapestWays(fam)) {
    const p = wf.price;
    if (!p || !Number.isFinite(p.min)) continue;
    let usd = p.min;
    if (p.unit === 'second') {
      const dp = paramOf(wf, 'duration');
      const opts = dp && Array.isArray(dp.options) ? dp.options.map((o) => Number(o.value)).filter(Number.isFinite) : [];
      const d = opts.length ? Math.min(...opts) : dp && Number.isFinite(dp.min) ? dp.min : null;
      if (!(d > 0)) continue;
      usd = p.min * d;
    }
    if (best == null || usd < best) best = round3(usd);
  }
  return best;
}

/** svc = electron/cloud.js's service (estimate, state of the price memory). */
function createPrices(svc) {
  const memo = new Map();             // request → { usd, at }
  async function ask(req, keepMs) {
    const key = `${req.endpoint}|${stable(req.body)}`;
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < keepMs) return hit.usd;
    const usd = await svc.estimate(req.endpoint, req.body);
    memo.set(key, { usd, at: Date.now() });
    return usd;
  }
  const linked = () => { try { return !!(svc && svc.linked && svc.linked()); } catch { return false; } };
  const pub = (req, seconds, why) => {
    const p = publicPrice(req, seconds);
    return p ? { ok: true, usd: p.usd, source: 'public', approx: true, unit: p.unit, ...(why ? { why } : {}) } : null;
  };

  /**
   * The price of a block's settings (`block.seconds`: lengths of its wired videos, when known).
   * → { ok, usd, source:'estimate' } | { ok, usd, source:'public', approx:true, unit, why? } | { ok:false, error? }
   */
  async function priceOf(block) {
    const req = requestOf(block || {});
    if (!req) return { ok: false };
    const seconds = (block && block.seconds) || null;
    if (!linked()) return pub(req, seconds) || { ok: false };
    let usd;
    try { usd = await ask(req, BLOCK_MS); } catch (e) { return { ok: false, error: e.userMessage || e.message }; }
    if (usd != null) return { ok: true, usd, source: 'estimate' };
    // Higgsfield answered without a price: the public tariff, else said as such on the block (« prix ? »)
    const why = svc.tr ? svc.tr('noPrice') : 'no price';
    return pub(req, seconds, why) || { ok: false, error: why };
  }

  /**
   * « dès … $ » for these families (keys « hf:… »), three at a time; a day in cloud.json. → { key: usd|null, _public:[keys] }
   * (_public: the keys whose price is the public tariff, to show « ≈ »).
   */
  async function fromPrices(keys) {
    const out = {};
    const publicKeys = [];
    const fallback = (k) => {
      const fam = famOf(k);
      const v = fam ? publicFrom(fam) : null;
      if (v != null) publicKeys.push(k);
      return v;
    };
    const list = [...new Set(keys || [])];
    if (!linked()) {
      for (const k of list) out[k] = fallback(k);
      return { ...out, _public: publicKeys };
    }
    const saved = svc.savedPrices();
    const todo = [];
    for (const k of list) {
      const s = saved[k];
      if (s && s.way === FROM_WAY && Date.now() - s.at < FROM_MS) out[k] = s.usd;
      else todo.push(k);
    }
    let i = 0;
    const fresh = {};
    const worker = async () => {
      while (i < todo.length) {
        const k = todo[i++];
        const fam = famOf(k);
        let usd = null;
        // the lowest of its ways and tiers (a tier Higgsfield does not price is left out)
        for (const wf of fam ? cheapestWays(fam) : []) {
          const req = requestOf({ family: k }, { cheapest: true, wf });
          for (const endpoint of (req && req.endpoints) || []) {
            let v = null;
            try { v = await ask({ endpoint, body: req.body }, FROM_MS); } catch { v = null; }
            if (v != null && (usd == null || v < usd)) usd = v;
          }
        }
        if (usd != null) { out[k] = usd; fresh[k] = { usd, at: Date.now(), way: FROM_WAY }; } else out[k] = fallback(k);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (Object.keys(fresh).length) await svc.savePrices(fresh);
    return { ...out, _public: publicKeys };
  }

  return { priceOf, fromPrices, requestOf };
}

module.exports = { createPrices, requestOf, publicPrice, publicFrom, cheapestWays, PLACEHOLDER };
