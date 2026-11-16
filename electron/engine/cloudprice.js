'use strict';
// Prices of the online models (SPEC §23.3), asked to Higgsfield before anything is sent: POST /estimate/<endpoint> with
// the body the cloud executor would send (docs.higgsfield.ai, « Billing and retention »: free, the account's own price).
// The media a block would upload are not uploaded for a price: a placeholder address stands for each one (the price
// depends on the model, its tier, resolution, length, sound… not on the picture). Two uses:
//   - priceOf: the price of a Model block's current settings (its footer, next to « Générer ») — kept 10 minutes;
//   - fromPrices: « dès … $ » in « + Bloc » — each family's cheapest way: its first workflow and tier, the smallest
//     resolution and the shortest length — kept a day, in cloud.json.
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
const FROM_WAY = 2;                   // how « dès » is computed: a saved price made another way is asked again

const stable = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(stable).join(',')}]`
    : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`);

/**
 * The request a block with these settings and wires would send: { endpoint, body } (or null: no such model).
 * `cheapest`: the first workflow at its smallest resolution and shortest length, with `endpoints` = every tier of it
 * (« Standard », « Pro », « 4K »… : which one is cheapest is Higgsfield's to say).
 */
function requestOf({ family, workflow = null, params = {}, ports = [] }, { cheapest = false } = {}) {
  const R = route.rules();
  const { local, cloud } = route.catalogs();
  const fam = R.familyOf(family, local, cloud, null);
  if (!fam || fam.provider === 'local') return null;
  const wf = cheapest ? (fam.def.workflows || [])[0] : R.chooseWorkflow(fam, ports, workflow || null).workflow;
  if (!wf) return null;
  const gen = { endpoints: wf.endpoints, ports: wf.ports, params: wf.params };
  // each wired input (and each one the way of working needs) stands as a placeholder at its field
  const urls = {};
  const wanted = new Set([...(cheapest ? [] : ports), ...(wf.required || []), ...((wf.oneOf || []).map((g) => g[0]))]);
  for (const port of wanted) {
    const def = (wf.ports || {})[port];
    if (!def || !def.field || port === 'prompt') continue;
    const url = PLACEHOLDER[KIND[port] || 'image'];
    urls[port] = def.multi ? Array.from({ length: Math.max(1, def.min || 1) }, () => url) : url;
  }
  const x = { gen, params: { ...params }, inputs: {} };
  // a prompt the model requires: any text, the price does not depend on it
  if (!String(x.params.prompt || '').trim()) x.params.prompt = 'price estimate';
  const body = exec._bodyOf(x, urls, cheapest);
  if (cheapest) {
    const endpoints = [...new Set(Object.values(wf.endpoints || {}))];
    return endpoints.length ? { endpoint: endpoints[0], endpoints, body } : null;
  }
  const endpoint = exec._endpointOf(x);
  return endpoint ? { endpoint, body } : null;
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

  /** The price of a block's settings. → { ok, usd } | { ok:false, error } (no account linked: { ok:false }) */
  async function priceOf(block) {
    if (!svc.linked()) return { ok: false };
    const req = requestOf(block || {});
    if (!req) return { ok: false };
    let usd;
    try { usd = await ask(req, BLOCK_MS); } catch (e) { return { ok: false, error: e.userMessage || e.message }; }
    // Higgsfield answered without a price: said as such on the block (« prix ? »), not a blank
    return usd == null ? { ok: false, error: svc.tr ? svc.tr('noPrice') : 'no price' } : { ok: true, usd };
  }

  /** « dès … $ » for these families (keys « hf:… »), three at a time; a day in cloud.json. → { key: usd|null } */
  async function fromPrices(keys) {
    if (!svc.linked()) return {};
    const out = {};
    const saved = svc.savedPrices();
    const todo = [];
    for (const k of [...new Set(keys || [])]) {
      const s = saved[k];
      if (s && s.way === FROM_WAY && Date.now() - s.at < FROM_MS) out[k] = s.usd;
      else todo.push(k);
    }
    let i = 0;
    const fresh = {};
    const worker = async () => {
      while (i < todo.length) {
        const k = todo[i++];
        const req = requestOf({ family: k }, { cheapest: true });
        let usd = null;
        // the lowest of its tiers (a tier Higgsfield does not price is left out)
        for (const endpoint of (req && req.endpoints) || []) {
          let v = null;
          try { v = await ask({ endpoint, body: req.body }, FROM_MS); } catch { v = null; }
          if (v != null && (usd == null || v < usd)) usd = v;
        }
        out[k] = usd;
        if (usd != null) fresh[k] = { usd, at: Date.now(), way: FROM_WAY };
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (Object.keys(fresh).length) await svc.savePrices(fresh);
    return out;
  }

  return { priceOf, fromPrices, requestOf };
}

module.exports = { createPrices, requestOf, PLACEHOLDER };
