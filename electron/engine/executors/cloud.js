'use strict';
// Online Model block (SPEC §23.3): the job runs at Higgsfield, not on the PC (no GPU lock, can run beside a
// local job). Only when Quentin clicks Run on that very block: the planner never starts it for a block
// downstream. Steps: each connected input is uploaded (presigned upload: the file goes to Higgsfield's
// storage, the key never does), the request goes to the workflow's endpoint with the block's settings, its
// status is read every few seconds, and the result is downloaded into the version's folder like any other.
// The endpoint, the field of each input and each setting come from src/catalog/cloud-higgsfield.json
// (normalized by tools/build-cloud-catalog.mjs): nothing is guessed here.
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
  running: { fr: 'Calcul en cours chez Higgsfield…', en: 'Computing at Higgsfield…' },
  downloading: { fr: 'Récupération du résultat…', en: 'Fetching the result…' },
  failed: { fr: 'Higgsfield n’a pas pu faire ce calcul : {why}', en: 'Higgsfield could not do this job: {why}' },
  nsfw: { fr: 'Higgsfield a refusé le contenu (modération). Rien n’est facturé.', en: 'Higgsfield refused the content (moderation). Nothing is charged.' },
  canceled: { fr: 'Le calcul a été annulé chez Higgsfield.', en: 'The job was cancelled at Higgsfield.' },
  noOutput: { fr: 'Higgsfield a fini sans renvoyer de fichier.', en: 'Higgsfield finished without returning a file.' },
  tooLong: { fr: 'Toujours pas fini chez Higgsfield après {m} min : la demande reste visible sur leur console.', en: 'Still not done at Higgsfield after {m} min: the request stays visible in their console.' },
  done: { fr: 'Calculé en ligne par Higgsfield : {family} · {what}.', en: 'Computed online by Higgsfield: {family} · {what}.' },
  preview: { fr: 'Aperçu : la plus petite résolution et la durée la plus courte du modèle (moins de crédits).', en: 'Preview: the model’s smallest resolution and shortest length (fewer credits).' },
  tooLate: { fr: 'Trop tard pour annuler chez Higgsfield (calcul déjà commencé) : il sera facturé.', en: 'Too late to cancel at Higgsfield (already started): it will be charged.' },
};

const POLL_MS = Number(process.env.MIA_HF_POLL_MS) || 4000;
const MAX_MIN = 60;

/** Content types Higgsfield takes (docs: file uploads); anything else is converted with ffmpeg first. */
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

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
  await x.ffmpeg.run(['-y', '-i', item.abs, ...x.ffmpeg.encodeArgs({ quality: 'hq' }), '-c:a', 'aac', dst], { signal: x.signal });
  return { abs: dst, type: 'video/mp4' };
}

/** Value of one setting for the request (catalog param of the workflow), or undefined to leave it out. */
function valueOf(p, x, preview) {
  let v = x.params[p.id];
  if (v === undefined || v === null || v === '') v = p.default;
  if (preview && p.field === 'resolution' && Array.isArray(p.options) && p.options.length) v = p.options[0].value;
  if (preview && p.field === 'duration') {
    if (Array.isArray(p.options) && p.options.length) v = p.options[0].value;
    else if (p.min != null) v = p.min;
  }
  if (v === undefined || v === null || v === '') return undefined;
  if (p.kind === 'toggle' && p.on !== undefined) return v ? p.on : p.off;
  if (p.kind === 'toggle') return !!v;
  if (p.kind === 'slider' || p.kind === 'number' || p.kind === 'seed') return Number(v);
  if (Array.isArray(p.options)) {
    const o = p.options.find((q) => String(q.value) === String(v));
    return o ? o.value : p.default;
  }
  return v;
}

/**
 * The files to upload, in order. Whether a port gets ONE url or a LIST is the online field's own shape (catalog
 * `multi`), never how Mia holds the wires: the Model block's « Images de référence » always comes as a list, but
 * SOUL's image_reference_url is a single url (Quentin's first real run, 25/10: « URL input should be a string »).
 */
function uploadsOf(x) {
  const g = x.gen;
  const items = [];
  for (const [port, v] of Object.entries(x.inputs || {})) {
    const def = (g.ports || {})[port];
    if (port === 'prompt' || !def) continue;
    const list = (Array.isArray(v) ? v : [v]).filter((it) => it && it.abs);
    // a single field takes the first file only (the planner already notes « … au plus » past the maximum)
    (def.multi ? list : list.slice(0, 1)).forEach((it, i) => items.push({ port, it, i: list.length > 1 ? i : null, multi: !!def.multi }));
  }
  return items;
}

/** The request body: prompt, uploaded inputs at their field (a list or one url, as the field wants), settings. */
function bodyOf(x, urls, preview) {
  const g = x.gen;
  const body = {};
  const ports = g.ports || {};
  const { prompt, negative } = E.promptOf(x);
  if (ports.prompt && prompt) body.prompt = prompt;
  for (const [port, url] of Object.entries(urls)) {
    const def = ports[port];
    if (!def || !def.field) continue;
    if (def.multi) body[def.field] = Array.isArray(url) ? url : [url];
    else body[def.field] = Array.isArray(url) ? url[0] : url;
  }
  for (const p of g.params || []) {
    if (!p.field) continue;                                     // hf.tier picks the endpoint, it is no field
    const v = valueOf(p, x, preview);
    if (v !== undefined) body[p.field] = v;
  }
  if (negative && (g.params || []).some((p) => p.field === 'negative_prompt') && body.negative_prompt == null) body.negative_prompt = negative;
  return body;
}

function endpointOf(x) {
  const g = x.gen;
  const eps = g.endpoints || {};
  const tier = x.params['hf.tier'];
  return eps[tier] || eps.default || Object.values(eps)[0];
}

async function run(x) {
  E.begin(x);
  const g = x.gen;
  const svc = x.cloud;
  if (!svc || !svc.linked()) throw Object.assign(new Error(svc ? svc.tr('notLinked') : 'Higgsfield'), {});
  const preview = x.mode === 'preview';
  const notes = [];
  if (preview) notes.push(E.t(TXT.preview));

  // 1. inputs → presigned uploads (one URL per file; a list only where the online field takes a list)
  const items = uploadsOf(x);
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

  // 2. the request (Idempotency-Key = this version: a retry after a network cut is not charged twice)
  x.progress(0.16, E.t(TXT.submitting));
  const endpoint = endpointOf(x);
  const body = bodyOf(x, urls, preview);
  x.log(`Higgsfield : POST /${endpoint} ${JSON.stringify({ ...body, prompt: body.prompt ? `${String(body.prompt).slice(0, 60)}…` : undefined })}`);
  const sub = await svc.call('POST', endpoint, body, { signal: x.signal, headers: { 'Idempotency-Key': x.runId } });
  x.log(`Higgsfield : demande ${sub.request_id}`);

  // 3. status every few seconds; a cancel in Mia cancels at Higgsfield while it is still queued
  const t0 = Date.now();
  let st = sub;
  let cancelSent = false;
  for (;;) {
    if (x.signal && x.signal.aborted) {
      if (!cancelSent && st.status === 'queued' && sub.cancel_url) {
        cancelSent = true;
        await svc.call('POST', sub.cancel_url, null, {}).catch(() => {});
      } else if (st.status === 'in_progress') x.log(E.t(TXT.tooLate));
      E.checkAbort(x);
    }
    if (st.status === 'completed') break;
    if (st.status === 'failed') throw new Error(E.t(TXT.failed, { why: st.error || '?' }));
    if (st.status === 'nsfw') throw new Error(E.t(TXT.nsfw));
    if (st.status === 'canceled') throw new Error(E.t(TXT.canceled));
    if (Date.now() - t0 > MAX_MIN * 60000) throw new Error(E.t(TXT.tooLong, { m: MAX_MIN }));
    x.progress(null, E.t(st.status === 'in_progress' ? TXT.running : TXT.queued));
    await sleep(POLL_MS, x.signal);
    try {
      st = await svc.call('GET', sub.status_url || `requests/${sub.request_id}/status`, null, { signal: x.signal });
    } catch (e) {
      if (x.signal && x.signal.aborted) continue;
      if (e.retry || !e.status) { await sleep(Math.min(30, e.retry || 5) * 1000, x.signal); continue; }   // 5xx, network: retry
      throw e;
    }
  }

  // 4. the result, into this version's folder
  x.progress(0.95, E.t(TXT.downloading));
  const out = (st.video && st.video.url && { url: st.video.url, kind: 'video' })
    || (Array.isArray(st.images) && st.images[0] && st.images[0].url && { url: st.images[0].url, kind: 'image' })
    || (st.audio && st.audio.url && { url: st.audio.url, kind: 'audio' });
  if (!out) throw new Error(E.t(TXT.noOutput));
  const ext = (path.extname(new URL(out.url).pathname).toLowerCase().match(/^\.(mp4|mov|webm|png|jpe?g|webp|wav|mp3)$/) || [])[0]
    || (out.kind === 'video' ? '.mp4' : out.kind === 'image' ? '.png' : '.wav');
  const dst = path.join(x.outDir, `result${ext}`);
  await svc.download(out.url, dst, { signal: x.signal });
  x.progress(1, E.t(TXT.downloading));
  notes.unshift(E.t(TXT.done, { family: g.family, what: g.what }));
  return {
    outputs: { out: { abs: dst, kind: out.kind } },
    model: `${g.family} (Higgsfield)`,
    notes: E.notes(notes),
    provider: 'higgsfield',
    request: sub.request_id,
  };
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

// not E.wrap: that tidies ComfyUI's temporary files, and an online job never touches ComfyUI
module.exports = { run, estimate, _bodyOf: bodyOf, _endpointOf: endpointOf, _uploadsOf: uploadsOf };
