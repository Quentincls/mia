'use strict';
// Online accounts (SPEC §23.3): Higgsfield, the one place Mia talks to the Internet.
//
// - The key (« ID:SECRET », made in console.higgsfield.ai) is pasted by Quentin in Settings → Online accounts.
//   It is checked (a free call), then kept ENCRYPTED with Electron's safeStorage (Windows DPAPI, tied to his
//   Windows account) in %APPDATA%\Mia\data\cloud.json. It is never written in clear, never logged, never sent to
//   the window again (the window only learns « linked, since…, key …abcd »), never sent anywhere but Higgsfield.
// - Only the cloud executor uses it, when Quentin clicks Run on an online Model block: nothing leaves the PC
//   otherwise (no catalog download, no telemetry).
// - Hosts: api.higgsfield.ai (calls), the presigned storage URL Higgsfield gives for each upload (PUT of the
//   file, without our key), the output URLs it returns (GET). MIA_HF_BASE points the calls at a local fake
//   server in tests (tools/test-cloud.js).
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const BASE = (process.env.MIA_HF_BASE || 'https://api.higgsfield.ai').replace(/\/+$/, '');
const CHECK_ID = '00000000-0000-4000-8000-000000000000';     // a request that does not exist: 404 = key accepted

const STR = {
  fr: {
    noCrypto: 'Windows ne permet pas de chiffrer la clé sur ce compte : Mia ne la garde pas.',
    badFormat: 'La clé doit avoir la forme ID:SECRET (deux parties séparées par « : »).',
    refused: 'Higgsfield refuse cette clé : vérifie l’identifiant et le secret (console.higgsfield.ai).',
    noBalance: 'Higgsfield refuse l’accès : solde de crédits insuffisant.',
    unreachable: 'Higgsfield ne répond pas : vérifie la connexion Internet. ({msg})',
    unexpected: 'Réponse inattendue de Higgsfield ({status}).',
    notLinked: 'Relie ton compte Higgsfield dans Réglages → Comptes en ligne.',
    invalid: 'Higgsfield refuse ces réglages : {detail}',
    reused: 'Higgsfield a déjà reçu ce calcul avec d’autres réglages : relance-le.',
    blocked: 'Ce modèle est momentanément bloqué chez Higgsfield : réessaie plus tard.',
    busy: 'Trop de calculs en même temps sur ton compte Higgsfield : réessaie dans un instant.',
    down: 'Higgsfield est indisponible pour l’instant ({status}) : réessaie plus tard.',
    notFound: 'Higgsfield ne connaît pas ce modèle pour ton compte ({detail}).',
  },
  en: {
    noCrypto: 'Windows cannot encrypt the key on this account: Mia does not keep it.',
    badFormat: 'The key must look like ID:SECRET (two parts separated by “:”).',
    refused: 'Higgsfield refuses this key: check the ID and the secret (console.higgsfield.ai).',
    noBalance: 'Higgsfield refuses access: not enough credits.',
    unreachable: 'Higgsfield does not answer: check the Internet connection. ({msg})',
    unexpected: 'Unexpected answer from Higgsfield ({status}).',
    notLinked: 'Link your Higgsfield account in Settings → Online accounts.',
    invalid: 'Higgsfield refuses these settings: {detail}',
    reused: 'Higgsfield already received this job with other settings: run it again.',
    blocked: 'This model is blocked at Higgsfield for now: try again later.',
    busy: 'Too many jobs at once on your Higgsfield account: try again in a moment.',
    down: 'Higgsfield is unavailable for now ({status}): try again later.',
    notFound: 'Higgsfield does not know this model for your account ({detail}).',
  },
};

/**
 * The service, without Electron (tests give a fake `safe`): { file (cloud.json), safe (safeStorage-like:
 * isEncryptionAvailable, encryptString, decryptString), lang() → 'fr'|'en', log?, base? }.
 */
function createService({ file, safe, lang: langFn, log, base = BASE }) {
  const safeStorage = safe;
  const lang = () => (typeof langFn === 'function' && langFn() === 'en' ? 'en' : 'fr');
  const tr = (k, vars) => String((STR[lang()] || STR.fr)[k] || STR.fr[k] || k).replace(/\{(\w+)\}/g, (_, v) => (vars && vars[v] != null ? vars[v] : ''));
  const userError = (k, vars, extra = {}) => Object.assign(new Error(tr(k, vars)), { userMessage: tr(k, vars) }, extra);

  let state = read();
  function read() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
  }
  async function save(next) {
    state = next;
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(next, null, 1));
    await fsp.rename(tmp, file);
  }
  /** The key in clear, only in memory and only for a call. */
  function secret() {
    const h = state.higgsfield;
    if (!h || !h.enc) return null;
    try { return safeStorage.decryptString(Buffer.from(h.enc, 'base64')); } catch { return null; }
  }
  const linked = () => !!(state.higgsfield && state.higgsfield.enc);
  const tail = (key) => String(key).split(':')[0].slice(-4);

  /** Readable error from an HTTP answer of Higgsfield (status codes of docs.higgsfield.ai/docs/concepts/errors). */
  async function failure(res) {
    let detail = '';
    try {
      const j = await res.json();
      detail = Array.isArray(j.detail) ? j.detail.map((d) => d.msg || JSON.stringify(d)).join(' ; ') : String(j.detail || j.error || '');
    } catch { /* no JSON */ }
    detail = detail.slice(0, 300);
    const s = res.status;
    if (s === 401) return userError('refused', null, { status: s });
    if (s === 403) return userError('noBalance', null, { status: s });
    if (s === 404) return userError('notFound', { detail }, { status: s });
    if (s === 400) return userError('invalid', { detail: detail || s }, { status: s });
    if (s === 422) return /idempot/i.test(detail) ? userError('reused', null, { status: s }) : userError('invalid', { detail: detail || s }, { status: s });
    if (s === 423) return userError('blocked', null, { status: s });
    if (s === 429) return userError('busy', null, { status: s, retry: Number(res.headers.get('retry-after')) || 10 });
    if (s >= 500) return userError('down', { status: s }, { status: s, retry: 5 });
    return userError('unexpected', { status: s }, { status: s });
  }

  /** One authenticated call to the API. → parsed JSON (or null for an empty answer). */
  async function call(method, urlOrPath, body, { signal, key, headers = {} } = {}) {
    const k = key || secret();
    if (!k) throw userError('notLinked');
    const url = /^https?:\/\//.test(urlOrPath) ? urlOrPath : `${base}/${String(urlOrPath).replace(/^\/+/, '')}`;
    let res;
    try {
      res = await fetch(url, {
        method, signal,
        headers: { Authorization: `Key ${k}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (signal && signal.aborted) throw e;
      throw userError('unreachable', { msg: e.message });
    }
    if (!res.ok) throw await failure(res);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /** Quentin's key works? A free call: the status of a request that does not exist (404 = accepted). */
  async function check(key) {
    try {
      await call('GET', `requests/${CHECK_ID}/status`, null, { key });
      return { ok: true };
    } catch (e) {
      if (e.status === 404) return { ok: true };
      return { ok: false, error: e.userMessage || e.message };
    }
  }

  /** Upload a local file for a job → its public URL (presigned upload, the key never goes to the storage). */
  async function upload(abs, contentType, { signal } = {}) {
    const u = await call('POST', 'files/generate-upload-url', { content_type: contentType }, { signal });
    const size = (await fsp.stat(abs)).size;
    let res;
    try {
      res = await fetch(u.upload_url, {
        method: 'PUT', signal, duplex: 'half',
        headers: { 'Content-Type': contentType, 'Content-Length': String(size), ...(u.upload_headers || {}) },
        body: Readable.toWeb(fs.createReadStream(abs)),
      });
    } catch (e) {
      if (signal && signal.aborted) throw e;
      throw userError('unreachable', { msg: e.message });
    }
    if (!res.ok) throw await failure(res);
    return u.public_url;
  }

  /** Download an output (a plain URL from Higgsfield's answer, no key sent) to dst. */
  async function download(url, dst, { signal } = {}) {
    let res;
    try { res = await fetch(url, { signal }); } catch (e) {
      if (signal && signal.aborted) throw e;
      throw userError('unreachable', { msg: e.message });
    }
    if (!res.ok || !res.body) throw await failure(res);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dst));
    return { contentType: res.headers.get('content-type') || '' };
  }

  const status = () => ({
    linked: linked(),
    provider: 'higgsfield',
    since: (state.higgsfield && state.higgsfield.since) || null,
    keyTail: (state.higgsfield && state.higgsfield.tail) || null,
    crypto: safeStorage.isEncryptionAvailable(),
  });

  /** Quentin pastes his key: format, encryption available, a free check, then kept encrypted. */
  async function setKey(raw) {
    const key = String(raw || '').trim();
    if (!/^[^:\s]+:[^:\s]+$/.test(key)) return { ok: false, error: tr('badFormat') };
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: tr('noCrypto') };
    const r = await check(key);
    if (!r.ok) return r;
    await save({ ...state, higgsfield: { enc: safeStorage.encryptString(key).toString('base64'), since: Date.now(), tail: tail(key) } });
    if (log) log('[cloud] Higgsfield account linked');
    return { ok: true, status: status() };
  }
  async function removeKey() {
    const next = { ...state };
    delete next.higgsfield;
    await save(next);
    if (log) log('[cloud] Higgsfield account unlinked');
    return { ok: true, status: status() };
  }
  const checkLinked = async () => (linked() ? check(null) : { ok: false, error: tr('notLinked') });

  return { linked, status, call, upload, download, setKey, removeKey, checkLinked, base, tr };
}

function register(ctx) {
  const { safeStorage } = require('electron');
  const svc = createService({ file: path.join(ctx.paths.data, 'cloud.json'), safe: safeStorage, lang: ctx.lang, log: ctx.log });
  ctx.ipcMain.handle('cloud:status', () => svc.status());
  ctx.ipcMain.handle('cloud:setKey', (_e, raw) => svc.setKey(raw));
  ctx.ipcMain.handle('cloud:removeKey', () => svc.removeKey());
  ctx.ipcMain.handle('cloud:check', () => svc.checkLinked());
  ctx.cloud = svc;
  return svc;
}

module.exports = { register, createService };
