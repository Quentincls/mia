'use strict';
/**
 * Tests of the model installer (electron/installer.js, SPEC §21.4) — no real download, ever.
 *
 *   node tools/test-installer.js            everything
 *   node tools/test-installer.js --keep     keep the temporary folder to look at it
 *
 * A local HTTP server (127.0.0.1 and « localhost », random port) plays Hugging Face with fake files: Range and
 * 206, a slow file (pause / resume / cancel), a connection that drops halfway, a server that ignores Range, a
 * wrong size, a damaged file, a gated repository (401 without the right token), a redirect to a « CDN » host that
 * must never receive the token (also when the token host rule would accept it: the host changed), a web page
 * instead of a file, a 404, Hugging Face's whoami for a pasted token; two fake ComfyUI (a plain one, a lab-type one)
 * for the engine rule. Everything happens under _dev/A2a-modeles/test-installer, or $MIA_TEST_DIR (removed at the
 * start of each run).
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { Installer, engineCheck, engineKind, isLabArgv, scriptParams, PART_EXT } = require('../electron/installer');

const KEEP = process.argv.includes('--keep');
const ROOT = process.env.MIA_TEST_DIR ? path.resolve(process.env.MIA_TEST_DIR) : path.join(__dirname, '..', '_dev', 'A2a-modeles', 'test-installer');
const MODELS = path.join(ROOT, 'engine', 'models');
const GOOD_TOKEN = 'hf_test_good_token_123456';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, what) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(what);
  console.log('  ÉCHEC :', what);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const gitOid = (b) => crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');

// ------------------------------------------------------------------------------------------- fake files
const MB = 1024 * 1024;
const rnd = (n, seed) => {
  const out = Buffer.alloc(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) { x = (x * 1664525 + 1013904223) >>> 0; out[i] = x >>> 24; }
  return out;
};
const FILES = {
  'org/fast': { body: rnd(1 * MB, 1) },
  'org/slow': { body: rnd(4 * MB, 2), rate: 1.5 * MB },
  'org/slow2': { body: rnd(4 * MB, 3), rate: 1.5 * MB },
  'org/cut': { body: rnd(3 * MB, 4), cutAt: 1.2 * MB },
  'org/norange': { body: rnd(3 * MB, 5), rate: 2 * MB, noRange: true },
  'org/size': { body: rnd(2 * MB, 6) },                          // the manifest says another size
  'org/corrupt': { body: rnd(1 * MB, 7) },                       // the manifest has another sha256
  'gated/model': { body: rnd(1 * MB, 8), gated: true, cdn: true },
  'org/locked': { body: rnd(1 * MB, 9), gated: true },           // the manifest says « not gated », the server says 401
  'org/html': { body: Buffer.from('<html><body>Sign in</body></html>'), html: true },
  'org/small': { body: Buffer.from('{"architectures":["BiRefNet"]}\n') },
  'org/exists': { body: rnd(256 * 1024, 10) },
  'org/space': { body: rnd(2 * MB, 11) },
  'org/near': { body: rnd(1 * MB, 12) }                          // the manifest says 12 345 bytes less: same « 1 Mo »
};
const hits = [];   // { repo, range, auth, host, path }

function serve(req, res) {
  const u = new URL(req.url, 'http://x');
  const host = String(req.headers.host || '');
  const auth = req.headers.authorization || null;
  const range = req.headers.range || null;
  // « CDN »: /cdn/<org>/<name>
  let m = /^\/cdn\/([^/]+\/[^/]+)$/.exec(u.pathname);
  let repo = null, viaCdn = false;
  if (m) { repo = m[1]; viaCdn = true; }
  m = m || /^\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/.exec(u.pathname);
  if (!viaCdn && m) repo = m[1];
  hits.push({ repo, range, auth, host, path: u.pathname });
  // Hugging Face's « who am I » for a pasted token
  if (u.pathname === '/api/whoami-v2') {
    if (auth === `Bearer ${GOOD_TOKEN}`) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ name: 'testeur', type: 'user' })); }
    else { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"Invalid credentials"}'); }
    return;
  }
  const f = repo && FILES[repo];
  if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
  if (f.gated && !viaCdn && auth !== `Bearer ${GOOD_TOKEN}`) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('gated'); return; }
  if (f.cdn && !viaCdn) {
    // Hugging Face: 302 to its CDN with the size and sha256 of the file in X-Linked-* headers
    res.writeHead(302, {
      Location: `http://localhost:${PORT}/cdn/${repo}`,
      'X-Linked-Size': String(f.body.length),
      'X-Linked-Etag': `"${sha256(f.body)}"`
    });
    res.end();
    return;
  }
  if (f.html) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(f.body); return; }
  const size = f.body.length;
  let start = 0, end = size - 1, code = 200;
  const r = /bytes=(\d+)-(\d*)/.exec(range || '');
  if (r && !f.noRange) {
    start = Number(r[1]);
    if (r[2]) end = Math.min(Number(r[2]), size - 1);
    if (start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    code = 206;
  }
  const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' };
  if (code === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(code, headers);
  // the connection drops once, at cutAt (the first request only)
  const cut = f.cutAt && !f._cutDone ? Math.floor(f.cutAt) : null;
  let pos = start;
  const chunk = 64 * 1024;
  const step = () => {
    if (res.destroyed) return;
    if (pos > end) { res.end(); return; }
    let n = Math.min(chunk, end - pos + 1);
    if (cut != null && pos + n > cut) {
      n = cut - pos;
      if (n > 0) res.write(f.body.subarray(pos, pos + n));
      f._cutDone = true;
      setTimeout(() => res.destroy(), 20);
      return;
    }
    const more = res.write(f.body.subarray(pos, pos + n));
    pos += n;
    const wait = f.rate ? Math.round((n / f.rate) * 1000) : 0;
    if (!more) res.once('drain', () => setTimeout(step, wait));
    else setTimeout(step, wait);
  };
  step();
}

let PORT = 0;

// ------------------------------------------------------------------------------------------- manifest
function manifest() {
  const F = (key, repo, opts = {}) => {
    const body = FILES[repo].body;
    const o = { key, model: key, label: { fr: `Fichier ${key}`, en: `File ${key}` }, repo, revision: 'abc123', path: `${key}.safetensors`,
      dest: opts.dest || 'diffusion_models', bytes: opts.bytes ?? body.length, sizeGB: body.length / 1e9, gated: !!opts.gated, license: 'apache' };
    if (opts.sha !== false) o.sha256 = opts.shaValue || sha256(body);
    if (opts.git) { delete o.sha256; o.gitOid = gitOid(body); o.path = `${key}.json`; }
    return o;
  };
  return {
    schema: 1,
    licenses: { apache: { name: 'Apache-2.0', url: 'https://example.invalid', note: { fr: 'ok', en: 'ok' } } },
    files: [
      F('fast', 'org/fast'),
      F('slow', 'org/slow'),
      F('slow2', 'org/slow2'),
      F('cut', 'org/cut'),
      F('norange', 'org/norange'),
      F('size', 'org/size', { bytes: 3 * MB }),
      F('corrupt', 'org/corrupt', { shaValue: sha256(Buffer.from('another file')) }),
      F('gated', 'gated/model', { gated: true, sha: false }),      // sha256 comes from X-Linked-Etag
      F('locked', 'org/locked'),
      F('html', 'org/html'),
      F('small', 'org/small', { git: true, dest: 'outils/BiRefNet' }),
      F('exists', 'org/exists'),
      F('space', 'org/space'),
      F('near', 'org/near', { bytes: FILES['org/near'].body.length - 12345 }),
      { key: 'gone', model: 'gone', label: { fr: 'Disparu', en: 'Gone' }, repo: 'org/gone', revision: 'abc123', path: 'gone.bin', dest: 'vae', bytes: 10, sizeGB: 0, gated: false, license: 'apache' }
    ],
    capabilities: {
      depth: { label: { fr: 'Profondeur', en: 'Depth' }, needs: ['fast', 'small'] },
      upscale: { label: { fr: 'Agrandir', en: 'Upscale' }, needs: ['fast', 'exists'], options: [{ id: 'fast', label: { fr: 'Rapide', en: 'Fast' }, keys: ['slow2'] }] }
    }
  };
}

function makeInstaller(extra = {}) {
  const events = [];
  let rescans = 0;
  const inst = new Installer({
    manifest: manifest(),
    dataDir: path.join(ROOT, 'data'),
    prefs: () => ({ engineRoot: path.join(ROOT, 'engine') }),
    modelsDir: () => MODELS,
    requireEngine: false,
    inventory: () => null,
    rescan: () => { rescans++; return Promise.resolve(); },
    emit: (p) => events.push(p),
    lang: () => 'fr',
    hfBase: `http://127.0.0.1:${PORT}`,
    tokenFile: path.join(ROOT, 'no-token'),
    env: {},                                   // the machine's own $HF_TOKEN never leaks into a test
    retryDelays: [100, 200, 300],
    progressMs: 50,
    ...extra
  });
  inst._events = events;
  inst._rescans = () => rescans;
  return inst;
}

async function waitFor(inst, key, states, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const j = inst.jobOf(key);
    if (j && states.includes(j.state)) return j;
    if (!j && states.includes('gone')) return null;
    await sleep(25);
  }
  const j = inst.jobOf(key);
  throw new Error(`attente de ${key} en ${states.join('|')} : état ${j ? j.state : 'absent'}`);
}
const finalOf = (key, dest = 'diffusion_models', ext = '.safetensors') => path.join(MODELS, dest, key + ext);
const partOf = (key, dest = 'diffusion_models', ext = '.safetensors') => finalOf(key, dest, ext) + PART_EXT;
const same = (p, body) => { try { return fs.readFileSync(p).equals(body); } catch { return false; } };

// ------------------------------------------------------------------------------------------- tests
async function main() {
  await fsp.rm(ROOT, { recursive: true, force: true });
  await fsp.mkdir(MODELS, { recursive: true });
  const server = http.createServer(serve);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
  // « localhost » must reach the same server (the CDN of the redirect test)
  const server6 = http.createServer(serve);
  await new Promise((r) => server6.listen(PORT, 'localhost', r)).catch(() => {});
  console.log(`serveur de test sur 127.0.0.1:${PORT}`);

  // 1. list(): nothing present, capabilities computed
  {
    console.log('1. inventaire');
    const inst = makeInstaller();
    const l = await inst.list();
    ok(l.ok && l.files.fast && l.files.fast.present === false, 'list : fast absent');
    ok(l.caps.depth.state === 'missing' && l.caps.depth.missing.length === 2, 'list : depth manquant (2 fichiers)');
    ok(l.caps.depth.missingBytes === FILES['org/fast'].body.length + FILES['org/small'].body.length, 'list : taille manquante exacte');
    ok(l.caps.upscale.options[0].missing[0] === 'slow2', 'list : option listée');
    ok(l.token === false, 'list : pas de jeton');
  }

  // 2. a plain download, checked by sha256, then in place, no part left, rescan asked
  {
    console.log('2. téléchargement simple');
    const inst = makeInstaller();
    const r = await inst.start({ keys: ['fast'] });
    ok(r.ok && r.queued[0] === 'fast', 'start : en file');
    await waitFor(inst, 'fast', ['done', 'error']);
    ok(inst.jobOf('fast').state === 'done', 'fast : terminé');
    ok(same(finalOf('fast'), FILES['org/fast'].body), 'fast : fichier identique à l’original');
    ok(!fs.existsSync(partOf('fast')) && !fs.existsSync(partOf('fast') + '.json'), 'fast : pas de .mia-part restant');
    await sleep(200);
    ok(inst._rescans() >= 1, 'fast : rescan demandé');
    ok(inst._events.some((e) => e.kind === 'job' && e.job.key === 'fast' && e.job.state === 'downloading'), 'fast : événements de progression');
    const again = await inst.start({ keys: ['fast'] });
    ok(again.ok && again.skipped.includes('fast') && !again.queued.length, 'fast : déjà là → sauté');
    const l = await inst.list();
    ok(l.files.fast.present === true, 'list : fast présent');
  }

  // 3. pause in the middle, then resume with Range
  {
    console.log('3. pause et reprise');
    const inst = makeInstaller();
    await inst.start({ keys: ['slow'] });
    const total = FILES['org/slow'].body.length;
    const t0 = Date.now();
    while (inst.jobOf('slow').done < total * 0.3 && Date.now() - t0 < 15000) await sleep(20);
    await inst.pause('slow');
    await waitFor(inst, 'slow', ['paused']);
    await sleep(100);
    const part = fs.statSync(partOf('slow')).size;
    ok(part > 0 && part < total, `slow : partie gardée (${part} octets)`);
    ok(!fs.existsSync(finalOf('slow')), 'slow : pas encore rangé');
    const j = inst.jobOf('slow');
    ok(j.eta === null && j.speed === 0, 'slow : en pause, ni vitesse ni ETA');
    const before = hits.length;
    await inst.start({ keys: ['slow'] });
    await waitFor(inst, 'slow', ['done', 'error']);
    ok(inst.jobOf('slow').state === 'done', 'slow : terminé après reprise');
    const resumed = hits.slice(before).find((h) => h.repo === 'org/slow');
    ok(resumed && resumed.range === `bytes=${part}-`, `slow : reprise avec Range bytes=${part}- (${resumed && resumed.range})`);
    ok(same(finalOf('slow'), FILES['org/slow'].body), 'slow : fichier identique (empreinte relue après reprise)');
    const withEta = inst._events.filter((e) => e.kind === 'job' && e.job.key === 'slow' && e.job.state === 'downloading' && e.job.eta != null);
    ok(withEta.length > 0, 'slow : une ETA a été donnée');
  }

  // 4. cancel: the part goes away, the job too
  {
    console.log('4. annulation');
    const inst = makeInstaller();
    await inst.start({ keys: ['slow2'] });
    const t0 = Date.now();
    while (inst.jobOf('slow2').done < 300 * 1024 && Date.now() - t0 < 10000) await sleep(20);
    await inst.cancel('slow2');
    const t1 = Date.now();
    while (inst.jobOf('slow2') && Date.now() - t1 < 5000) await sleep(20);
    ok(!inst.jobOf('slow2'), 'slow2 : retiré de la file');
    await sleep(100);
    ok(!fs.existsSync(partOf('slow2')) && !fs.existsSync(partOf('slow2') + '.json'), 'slow2 : partie effacée');
    ok(!fs.existsSync(finalOf('slow2')), 'slow2 : rien de rangé');
  }

  // 5. the connection drops halfway: automatic resume
  {
    console.log('5. coupure réseau');
    const inst = makeInstaller();
    const before = hits.length;
    await inst.start({ keys: ['cut'] });
    await waitFor(inst, 'cut', ['done', 'error']);
    ok(inst.jobOf('cut').state === 'done', `cut : terminé malgré la coupure (${inst.jobOf('cut').error || ''})`);
    const reqs = hits.slice(before).filter((h) => h.repo === 'org/cut');
    ok(reqs.length >= 2 && reqs.some((h) => /^bytes=\d+-$/.test(h.range || '')), 'cut : reprise par Range après la coupure');
    ok(same(finalOf('cut'), FILES['org/cut'].body), 'cut : fichier identique');
  }

  // 6. a server that ignores Range: the resume starts again from zero and still ends right
  {
    console.log('6. serveur sans Range');
    const inst = makeInstaller();
    await inst.start({ keys: ['norange'] });
    const t0 = Date.now();
    while (inst.jobOf('norange').done < 600 * 1024 && Date.now() - t0 < 10000) await sleep(20);
    await inst.pause('norange');
    await waitFor(inst, 'norange', ['paused']);
    await inst.start({ keys: ['norange'] });
    await waitFor(inst, 'norange', ['done', 'error']);
    ok(inst.jobOf('norange').state === 'done', 'norange : terminé');
    ok(same(finalOf('norange'), FILES['org/norange'].body), 'norange : fichier identique (réécrit depuis 0)');
  }

  // 7. wrong size: refused, nothing kept
  {
    console.log('7. taille fausse');
    const inst = makeInstaller();
    await inst.start({ keys: ['size'] });
    const j = await waitFor(inst, 'size', ['done', 'error']);
    ok(j.state === 'error' && j.errorCode === 'size', `size : refusé (${j.errorCode})`);
    ok(/taille attendue/.test(j.error || ''), `size : phrase claire (${j.error})`);
    ok(!fs.existsSync(finalOf('size')) && !fs.existsSync(partOf('size')), 'size : rien de gardé');
    // two sizes that round to the same « 1 Mo »: the sentence gives the exact bytes instead of « 1 Mo au lieu de 1 Mo »
    await inst.start({ keys: ['near'] });
    const n = await waitFor(inst, 'near', ['done', 'error']);
    ok(n.errorCode === 'size' && /1 048 576 octets au lieu de 1 036 231 octets/.test((n.error || '').replace(/[  ]/g, ' ')), `near : tailles exactes (${n.error})`);
  }

  // 8. damaged file (sha256 differs): removed
  {
    console.log('8. fichier abîmé');
    const inst = makeInstaller();
    await inst.start({ keys: ['corrupt'] });
    const j = await waitFor(inst, 'corrupt', ['done', 'error']);
    ok(j.state === 'error' && j.errorCode === 'hash', `corrupt : refusé (${j.errorCode})`);
    ok(!fs.existsSync(finalOf('corrupt')) && !fs.existsSync(partOf('corrupt')), 'corrupt : retiré');
  }

  // 9. gated without token: not queued at all (it would fail at once), a clear sentence, the server is never asked
  {
    console.log('9. dépôt protégé sans jeton');
    const inst = makeInstaller();
    const before = hits.length;
    await fsp.rm(finalOf('fast'), { force: true });
    const r = await inst.start({ keys: ['gated', 'fast'] });
    ok(r.ok && r.blocked.length === 1 && r.blocked[0] === 'gated' && r.queued.includes('fast'), `gated : mis de côté, le reste part (${JSON.stringify({ q: r.queued, b: r.blocked })})`);
    ok(!inst.jobOf('gated'), 'gated : aucune ligne « arrêtée » dans la file');
    ok(r.pages[0] === 'https://huggingface.co/gated/model', 'gated : la page de la licence est rendue');
    const only = await inst.start({ keys: ['gated'] });
    ok(!only.queued.length && /colle ton jeton/.test(only.message || '') && /accepte la licence/.test(only.message || ''), `gated : phrase claire (${only.message})`);
    await waitFor(inst, 'fast', ['done', 'error']);
    ok(!hits.slice(before).some((h) => h.repo === 'gated/model'), 'gated : aucun appel au serveur sans jeton');
    ok(!fs.existsSync(partOf('gated')) && !fs.existsSync(partOf('gated') + '.json'), 'gated : rien d’écrit sur le disque');
  }

  // 10. gated with a wrong token: 401 → « accept the license »
  {
    console.log('10. dépôt protégé, jeton refusé');
    const tf = path.join(ROOT, 'bad-token');
    await fsp.writeFile(tf, 'hf_wrong_token_999999\n');
    const inst = makeInstaller({ tokenFile: tf });
    await inst.start({ keys: ['gated'] });
    const j = await waitFor(inst, 'gated', ['done', 'error']);
    ok(j.state === 'error' && j.errorCode === 'gated-denied', `gated : accès refusé (${j.errorCode})`);
    ok(/n’a pas encore accès/.test(j.error || ''), `gated : phrase claire (${j.error})`);
  }

  // 11. gated with the right token: OK; the token reaches « Hugging Face » only, never the CDN of the redirect
  {
    console.log('11. dépôt protégé, bon jeton, redirection');
    const tf = path.join(ROOT, 'good-token');
    await fsp.writeFile(tf, GOOD_TOKEN + '\n');
    const inst = makeInstaller({ tokenFile: tf });
    const before = hits.length;
    await inst.start({ keys: ['gated'] });
    const j = await waitFor(inst, 'gated', ['done', 'error']);
    ok(j.state === 'done', `gated : terminé (${j.error || ''})`);
    const mine = hits.slice(before);
    const hf = mine.find((h) => h.path.includes('/resolve/'));
    const cdn = mine.find((h) => h.path.startsWith('/cdn/'));
    ok(hf && hf.auth === `Bearer ${GOOD_TOKEN}`, 'gated : jeton envoyé à « Hugging Face »');
    ok(cdn && !cdn.auth && /^localhost/.test(cdn.host), 'gated : jeton jamais envoyé au CDN');
    ok(same(finalOf('gated'), FILES['gated/model'].body), 'gated : fichier vérifié par X-Linked-Etag');
    // a token on disk is never written anywhere by Mia
    const saved = fs.existsSync(path.join(ROOT, 'data', 'downloads.json')) ? fs.readFileSync(path.join(ROOT, 'data', 'downloads.json'), 'utf8') : '';
    ok(!saved.includes(GOOD_TOKEN), 'gated : jeton absent de downloads.json');
  }

  // 11 b. the token host rule may accept the CDN's name (as the old « *.huggingface.co » rule did): the token is
  // still dropped, because the redirect changed host. And Hugging Face's CDN names are never token hosts.
  {
    console.log('11 b. jeton retiré à tout changement d’hôte');
    await fsp.rm(finalOf('gated'), { force: true });
    const tf = path.join(ROOT, 'good-token');
    const inst = makeInstaller({ tokenFile: tf, tokenHosts: /^(127\.0\.0\.1|localhost)$/ });
    const before = hits.length;
    await inst.start({ keys: ['gated'] });
    const j = await waitFor(inst, 'gated', ['done', 'error']);
    ok(j.state === 'done', `gated (b) : terminé (${j.error || ''})`);
    const cdn = hits.slice(before).find((h) => h.path.startsWith('/cdn/'));
    ok(cdn && !cdn.auth, 'gated (b) : le CDN, hôte accepté par la règle, ne reçoit pas le jeton');
    const plain = makeInstaller({ hfBase: undefined });
    ok(plain.tokenHost('huggingface.co') && plain.tokenHost('hf.co'), 'hôtes du jeton : huggingface.co et hf.co');
    ok(!plain.tokenHost('cdn-lfs.huggingface.co') && !plain.tokenHost('cdn-lfs-us-1.hf.co') && !plain.tokenHost('cas-bridge.xethub.hf.co'), 'hôtes du jeton : jamais un sous-domaine (CDN)');
    ok(!plain.tokenHost('evilhuggingface.co') && !plain.tokenHost('huggingface.co.example.com'), 'hôtes du jeton : pas de faux voisin');
  }

  // 12. a public repository that turns out gated (401) without token
  {
    console.log('12. 401 inattendu');
    const inst = makeInstaller();
    await inst.start({ keys: ['locked'] });
    const j = await waitFor(inst, 'locked', ['done', 'error']);
    ok(j.state === 'error' && j.errorCode === 'gated-no-token', `locked : phrase « accepter la licence » (${j.errorCode})`);
    ok(/colle ton jeton/.test(j.error || ''), `locked : propose de coller un jeton (${j.error})`);
  }

  // 13. a web page instead of the file, and a 404
  {
    console.log('13. page web, 404');
    const inst = makeInstaller();
    await inst.start({ keys: ['html', 'gone'] });
    const a = await waitFor(inst, 'html', ['done', 'error']);
    const b = await waitFor(inst, 'gone', ['done', 'error']);
    ok(a.errorCode === 'not-file', `html : refusé (${a.errorCode})`);
    ok(b.errorCode === 'not-found', `gone : introuvable (${b.errorCode})`);
  }

  // 14. small non-LFS file, checked by its git hash, in a sub-folder (outils/BiRefNet)
  {
    console.log('14. petit fichier (empreinte git)');
    const inst = makeInstaller();
    await inst.start({ keys: ['small'] });
    const j = await waitFor(inst, 'small', ['done', 'error']);
    ok(j.state === 'done', `small : terminé (${j.error || ''})`);
    ok(same(finalOf('small', 'outils/BiRefNet', '.json'), FILES['org/small'].body), 'small : rangé dans outils/BiRefNet');
  }

  // 15. a file of the same name with another size: never overwritten
  {
    console.log('15. fichier existant');
    await fsp.mkdir(path.dirname(finalOf('exists')), { recursive: true });
    await fsp.writeFile(finalOf('exists'), 'mine, not yours');
    const inst = makeInstaller();
    const l = await inst.list();
    ok(l.files.exists.present === false && l.files.exists.conflict === true, 'exists : conflit signalé');
    await inst.start({ keys: ['exists'] });
    const j = await waitFor(inst, 'exists', ['done', 'error']);
    ok(j.errorCode === 'exists' && /ne l’écrase pas/.test(j.error || ''), `exists : refusé (${j.errorCode})`);
    ok(fs.readFileSync(finalOf('exists'), 'utf8') === 'mine, not yours', 'exists : fichier d’origine intact');
  }

  // 16. not enough room
  {
    console.log('16. place insuffisante');
    const inst = makeInstaller({ freeBytes: async () => 100 * MB });
    await inst.start({ keys: ['space'] });
    const j = await waitFor(inst, 'space', ['done', 'error']);
    ok(j.errorCode === 'space' && /Pas assez de place/.test(j.error || ''), `space : refusé (${j.error})`);
  }

  // 17. no engine yet: nothing is downloaded
  {
    console.log('17. pas de moteur');
    const inst = makeInstaller({ requireEngine: true, modelsDir: undefined, prefs: () => ({ engineRoot: path.join(ROOT, 'nowhere'), comfyUrl: 'http://127.0.0.1:9' }) });
    let err = null;
    try { await inst.start({ keys: ['fast'] }); } catch (e) { err = e; }
    ok(err && err.code === 'no-engine' && /moteur/.test(err.userMessage), 'pas de moteur : refus clair');
    const l = await inst.list();
    ok(l.engineReady === false && l.modelsDir === null, `pas de moteur : aucun dossier de modèles déduit d’un dossier absent (${l.modelsDir})`);
  }

  // 18. a whole capability, and an option; the queue survives a restart (paused)
  {
    console.log('18. capacité entière, file gardée au redémarrage');
    await fsp.rm(finalOf('fast'), { force: true });
    await fsp.rm(finalOf('small', 'outils/BiRefNet', '.json'), { force: true });
    const inst = makeInstaller();
    const r = await inst.start({ caps: ['depth'] });
    ok(r.queued.length === 2, 'depth : 2 fichiers en file');
    await waitFor(inst, 'small', ['done', 'error']);
    ok(inst.jobOf('fast').state === 'done' && inst.jobOf('small').state === 'done', 'depth : tout installé');
    const r2 = await inst.start({ option: { cap: 'upscale', id: 'fast' } });
    ok(r2.queued[0] === 'slow2', 'option : en file');
    const t0 = Date.now();
    while (inst.jobOf('slow2').done < 200 * 1024 && Date.now() - t0 < 10000) await sleep(20);
    await inst.pause();
    await waitFor(inst, 'slow2', ['paused']);
    await sleep(400);   // downloads.json is written 200 ms after a change
    const again = makeInstaller();
    await again.load();
    const back = again.jobOf('slow2');
    ok(back && back.state === 'paused' && back.done > 0, `redémarrage : reprise possible (${back && back.state}, ${back && back.done})`);
    await again.start({ keys: ['slow2'] });
    await waitFor(again, 'slow2', ['done', 'error']);
    ok(same(finalOf('slow2'), FILES['org/slow2'].body), 'redémarrage : fichier complet et identique');
    await again.clear();
    ok(!again.status().queue.some((j) => j.state === 'done'), 'clear : terminés retirés');
  }

  // 19. engine check
  {
    console.log('19. contrôle du moteur');
    const empty = path.join(ROOT, 'empty-engine');
    const lab = path.join(ROOT, 'lab-engine');
    await fsp.mkdir(empty, { recursive: true });
    await fsp.mkdir(path.join(lab, 'env', 'venv', 'Scripts'), { recursive: true });
    await fsp.mkdir(path.join(lab, 'env', 'ComfyUI'), { recursive: true });
    await fsp.writeFile(path.join(lab, 'env', 'venv', 'Scripts', 'python.exe'), '');
    await fsp.writeFile(path.join(lab, 'env', 'ComfyUI', 'main.py'), '');
    ok(engineKind(empty).kind === 'empty', 'moteur vide reconnu');
    ok(engineKind(path.join(ROOT, 'nope')).kind === 'missing', 'dossier absent reconnu');
    // python + ComfyUI but neither the engine card nor PyTorch: an install stopped half-way, not an engine
    ok(engineKind(lab).kind === 'incomplete' && engineKind(lab).ok === false, 'installation interrompue : pas un moteur');
    await fsp.writeFile(path.join(lab, 'mia-engine.json'), '{}');
    ok(engineKind(lab).ok === true && engineKind(lab).kind === 'mia', 'moteur de Mia reconnu (fiche mia-engine.json)');
    const labTorch = path.join(ROOT, 'lab-torch');
    await fsp.mkdir(path.join(labTorch, 'env', 'venv', 'Scripts'), { recursive: true });
    await fsp.mkdir(path.join(labTorch, 'env', 'ComfyUI'), { recursive: true });
    await fsp.mkdir(path.join(labTorch, 'env', 'venv', 'Lib', 'site-packages', 'torch'), { recursive: true });
    await fsp.writeFile(path.join(labTorch, 'env', 'venv', 'Scripts', 'python.exe'), '');
    await fsp.writeFile(path.join(labTorch, 'env', 'ComfyUI', 'main.py'), '');
    await fsp.writeFile(path.join(labTorch, 'env', 'venv', 'Lib', 'site-packages', 'torch', '__init__.py'), '');
    ok(engineKind(labTorch).ok === true, 'moteur du labo reconnu (PyTorch dans le venv)');
    const portable = path.join(ROOT, 'comfy-portable');
    await fsp.mkdir(path.join(portable, 'python_embeded'), { recursive: true });
    await fsp.mkdir(path.join(portable, 'ComfyUI'), { recursive: true });
    await fsp.writeFile(path.join(portable, 'python_embeded', 'python.exe'), '');
    await fsp.writeFile(path.join(portable, 'ComfyUI', 'main.py'), '');
    ok(engineKind(portable).kind === 'comfy-portable' && !engineKind(portable).ok, 'ComfyUI portable : reconnu, pas un moteur de Mia');
    ok(isLabArgv(['main.py', '--models-directory', path.join(lab, 'models')], lab), 'règle du labo : --models-directory = <moteur>\\models');
    ok(!isLabArgv(['main.py', '--port', '8188'], lab) && !isLabArgv(['main.py', '--models-directory', 'C:\\other\\models'], lab), 'règle du labo : un autre ComfyUI n’est pas le moteur');
    process.env.MIA_ENGINE_FALLBACK = 'none';
    const a = await engineCheck({ prefs: { engineRoot: empty, comfyUrl: 'http://127.0.0.1:9' } });
    ok(a.usable === false && a.current.kind === 'empty' && !a.suggest, 'engineCheck : rien d’utilisable');
    process.env.MIA_ENGINE_FALLBACK = lab;
    const b = await engineCheck({ prefs: { engineRoot: empty, comfyUrl: 'http://127.0.0.1:9' } });
    ok(b.usable === false && b.suggest === lab, 'engineCheck : un autre moteur est proposé');
    const c = await engineCheck({ prefs: { engineRoot: lab, comfyUrl: 'http://127.0.0.1:9' } });
    ok(c.usable === true, 'engineCheck : moteur utilisable');
    const d = await engineCheck({ prefs: { engineRoot: empty, comfyUrl: 'https://example.com' } });
    ok(d.comfy.reachable === false, 'engineCheck : jamais d’appel hors de ce PC');
    ok(d.space && d.space.drive && typeof d.space.free === 'number' && d.needBytes > 20 * 2 ** 30, 'engineCheck : place libre du dossier proposé');
    const e = await engineCheck({ prefs: {}, root: path.join(ROOT, 'not made yet', 'moteur') });
    ok(e.space && e.space.free > 0 && e.current.kind === 'missing', 'engineCheck(root) : place libre d’un dossier pas encore créé');

    // a plain ComfyUI answering on this PC (another app's): NOT an engine — one rule with engine/comfy.js
    process.env.MIA_ENGINE_FALLBACK = 'none';
    const fakeComfy = (argv) => http.createServer((req, res) => {
      if (req.url.startsWith('/system_stats')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ system: { comfyui_version: '0.39.2', argv } })); return; }
      res.writeHead(404); res.end();
    });
    const plainSrv = fakeComfy(['main.py', '--port', '0']);
    await new Promise((r) => plainSrv.listen(0, '127.0.0.1', r));
    const plainUrl = `http://127.0.0.1:${plainSrv.address().port}`;
    const f = await engineCheck({ prefs: { engineRoot: path.join(ROOT, 'missing-engine'), comfyUrl: plainUrl } });
    ok(f.usable === false && f.comfy.reachable === true && f.comfy.lab === false && f.comfy.foreign && f.comfy.foreign.url === plainUrl,
      `engineCheck : un ComfyUI ordinaire n’est pas un moteur (usable ${f.usable}, foreign ${JSON.stringify(f.comfy.foreign)})`);
    const instPlain = makeInstaller({ requireEngine: true, modelsDir: undefined, prefs: () => ({ engineRoot: path.join(ROOT, 'missing-engine'), comfyUrl: plainUrl }) });
    const lp = await instPlain.list();
    ok(lp.engineReady === false && lp.modelsDir === null && lp.foreignComfy && lp.foreignComfy.url === plainUrl, `installateur : ComfyUI ordinaire → pas de moteur, pas de dossier (${lp.modelsDir})`);
    let errPlain = null;
    try { await instPlain.start({ keys: ['fast'] }); } catch (x) { errPlain = x; }
    ok(errPlain && errPlain.code === 'no-engine', 'installateur : rien ne se télécharge à côté d’un ComfyUI ordinaire');
    plainSrv.close();
    // the lab-type ComfyUI (its --models-directory is <engineRoot>\models): usable, and the models go there
    const labSrv = fakeComfy(['main.py', '--models-directory', path.join(lab, 'models')]);
    await new Promise((r) => labSrv.listen(0, '127.0.0.1', r));
    const labUrl = `http://127.0.0.1:${labSrv.address().port}`;
    const g = await engineCheck({ prefs: { engineRoot: lab, comfyUrl: labUrl } });
    ok(g.usable === true && g.comfy.lab === true && !g.comfy.foreign, 'engineCheck : le ComfyUI du moteur est reconnu');
    const instLab = makeInstaller({ requireEngine: true, modelsDir: undefined, prefs: () => ({ engineRoot: path.join(ROOT, 'missing-engine'), comfyUrl: labUrl }) });
    const ll = await instLab.list();
    ok(ll.engineReady === false, 'installateur : un ComfyUI d’un autre moteur que celui des réglages n’est pas adopté');
    const instLab2 = makeInstaller({ requireEngine: true, modelsDir: undefined, prefs: () => ({ engineRoot: lab, comfyUrl: labUrl }) });
    const ll2 = await instLab2.list();
    ok(ll2.engineReady === true && ll2.modelsDir === path.join(lab, 'models'), `installateur : moteur en marche → ses modèles (${ll2.modelsDir})`);
    labSrv.close();
    delete process.env.MIA_ENGINE_FALLBACK;
  }

  // 20. engine script: its parameters, a run with -DryRun, a failure, a cancel
  {
    console.log('20. script du moteur');
    const p = scriptParams('param(\n  [string]$Target = "D:\\Mia\\Moteur",\n  [switch]$DryRun\n)\nWrite-Host hi');
    ok(p.dirParam === 'Target' && p.hasDryRun, 'paramètres lus (-Target, -DryRun)');
    const p2 = scriptParams('[CmdletBinding()]\nparam(\n  [Parameter(Mandatory=$true)][string]$EngineRoot,\n  [switch]$DryRun\n)');
    ok(p2.dirParam === 'EngineRoot', 'paramètres lus (-EngineRoot)');
    const fake = path.join(ROOT, 'fake-install-engine.ps1');
    // UTF-8 WITH a BOM: Windows PowerShell 5.1 reads a .ps1 without one in the ANSI code page (accents broken)
    await fsp.writeFile(fake, '﻿' + [
      'param([string]$Target, [switch]$DryRun, [switch]$SkipGpuCheck)',
      'Write-Host "[1/3] Python dans $Target"',
      'Write-Host "[2/3] ComfyUI (é à ç)"',
      "if ($DryRun) { Write-Host '@mia {\"p\":0.9,\"msg\":\"Simulation : rien téléchargé\"}' }",
      'if ($Target -like "*fail*") { Write-Host "ECHEC: torch"; exit 3 }',
      "if ($Target -like \"*nogpu*\" -and -not $SkipGpuCheck) { Write-Host '@mia {\"error\":\"Aucune carte NVIDIA détectée (nvidia-smi introuvable). Relance avec -SkipGpuCheck pour installer quand même.\",\"step\":1,\"steps\":3}'; exit 1 }",
      'if ($SkipGpuCheck) { Write-Host "GPU ignoré" }',
      'if ($Target -like "*slow*") { Start-Sleep -Seconds 20 }',
      'Write-Host "[3/3] Fini"',
      'exit 0'
    ].join('\r\n'), 'utf8');
    const inst = makeInstaller({ engineScript: fake, adoptEngine: async () => { throw new Error('should not adopt a dry run'); } });
    const r = await inst.engine({ dir: path.join(ROOT, 'new engine'), dryRun: true });
    ok(r.ok && r.dryRun, `simulation : réussie (${r.error || ''})`);
    ok(r.log.some((l) => l.includes('ComfyUI (é à ç)')), 'simulation : journal lisible en UTF-8');
    ok(r.log.some((l) => l.includes('rien téléchargé')), 'simulation : message @mia lu');
    ok(r.log.some((l) => l.includes(path.join(ROOT, 'new engine'))), 'simulation : dossier avec espace transmis');
    const ev = inst._events.filter((e) => e.kind === 'engine');
    ok(ev.some((e) => e.state === 'done') && ev.some((e) => typeof e.p === 'number' && e.p > 0), 'simulation : progression et fin');
    const f = await inst.engine({ dir: path.join(ROOT, 'will-fail'), dryRun: true });
    ok(!f.ok && f.code === 3 && /code 3/.test(f.error), `échec : code rendu (${f.error})`);
    // no NVIDIA card: the answer says so (the window offers « Install anyway »), without the script's -SkipGpuCheck hint
    const ng = await inst.engine({ dir: path.join(ROOT, 'nogpu'), dryRun: true });
    ok(!ng.ok && ng.gpu === true && /NVIDIA/.test(ng.error) && !/SkipGpuCheck/.test(ng.error) && /quand même/.test(ng.error), `sans carte NVIDIA : proposé quand même (${ng.error})`);
    const ng2 = await inst.engine({ dir: path.join(ROOT, 'nogpu'), dryRun: true, skipGpuCheck: true });
    ok(ng2.ok && ng2.log.some((l) => l.includes('GPU ignoré')), 'installer quand même : -SkipGpuCheck transmis');
    const slow = inst.engine({ dir: path.join(ROOT, 'slow'), dryRun: true });
    await sleep(1500);
    const st = inst.status().engine;
    ok(st && st.running && st.dir === path.join(ROOT, 'slow') && Array.isArray(st.lines) && st.lines.some((l) => /\[1\/3\]/.test(l)) && typeof st.started === 'number',
      'pendant l’installation : status() rend le journal et le début (fenêtre rouverte)');
    inst.cancelEngine();
    const s = await slow;
    ok(s.cancelled === true, 'annulation du script');
    let bad = null;
    try { await inst.engine({ dir: 'relative\\dir' }); } catch (e) { bad = e; }
    ok(bad && bad.code === 'bad-dir', 'dossier relatif refusé');
    const real = path.join(__dirname, '..', 'engine-setup', 'install-engine.ps1');
    if (fs.existsSync(real)) {
      const rp = scriptParams(fs.readFileSync(real, 'utf8'));
      console.log(`   script réel : -${rp.dirParam} ${rp.hasDryRun ? '-DryRun' : '(pas de -DryRun !)'}`);
      ok(!!rp.dirParam && rp.hasDryRun, 'script réel : paramètre de dossier et -DryRun trouvés');
      const inst2 = makeInstaller({ adoptEngine: async () => { throw new Error('dry run adopted'); } });
      // the real script refuses a target inside Mia's own folder: a folder of the system temp (a dry run writes nothing)
      const dryDir = path.join(require('node:os').tmpdir(), 'mia-test-installer-dry-run');
      const rr = await inst2.engine({ dir: dryDir, dryRun: true });
      console.log(`   script réel en -DryRun : ${rr.ok ? 'OK' : 'ÉCHEC ' + rr.error} · ${rr.log ? rr.log.length : 0} lignes`);
      if (rr.log) for (const l of rr.log.slice(-6)) console.log('     │ ' + l);
      ok(rr.ok, 'script réel : la simulation passe');
      ok(!fs.existsSync(dryDir), 'script réel : la simulation n’écrit rien');
    } else {
      console.log('   (engine-setup\\install-engine.ps1 pas encore là : seul le faux script est testé)');
    }
  }

  // 21. the real manifest is well formed
  {
    console.log('21. manifeste réel');
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'catalog', 'models-manifest.json'), 'utf8'));
    const keys = new Set(m.files.map((f) => f.key));
    ok(keys.size === m.files.length, 'manifeste : clés uniques');
    ok(m.files.every((f) => f.repo && f.path && f.dest && f.bytes > 0 && f.revision && /^[0-9a-f]{40}$/.test(f.revision) && m.licenses[f.license]), 'manifeste : champs complets');
    ok(m.files.every((f) => f.sha256 ? /^[0-9a-f]{64}$/.test(f.sha256) : true), 'manifeste : sha256 bien formés');
    ok(Object.values(m.capabilities).every((c) => c.needs.every((k) => keys.has(k)) && (c.options || []).every((o) => o.keys.every((k) => keys.has(k)))), 'manifeste : capacités cohérentes');
    const caps = ['image-to-video', 'text-to-video', '3d-to-real', 'guided-video', 'reference-to-video', 'character-performance', 'image-edit', 'upscale', 'depth', 'cutout'];
    ok(caps.every((c) => m.capabilities[c]), 'manifeste : toutes les capacités des blocs');
    // the files the engine's workflows load are all in it
    const wf = path.join(__dirname, '..', 'electron', 'engine', 'workflows');
    const names = new Set();
    for (const f of fs.readdirSync(wf).filter((x) => x.endsWith('.json'))) {
      for (const mm of fs.readFileSync(path.join(wf, f), 'utf8').matchAll(/"([A-Za-z0-9_.\-]+\.(?:safetensors|pth))"/g)) names.add(mm[1]);
    }
    const inManifest = new Set(m.files.map((f) => path.posix.basename(f.path)));
    const known = ['ema_vae_fp16.safetensors', 'seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors'];   // the SeedVR2 custom-node variant, unused by Mia's native path
    const missing = [...names].filter((n) => !inManifest.has(n) && !known.includes(n));
    ok(!missing.length, `manifeste : chaque fichier des graphes du moteur y est (${missing.join(', ')})`);
    const inst = new Installer({ manifest: m, modelsDir: () => MODELS, requireEngine: false, inventory: () => null, tokenFile: path.join(ROOT, 'no-token') });
    const l = await inst.list();
    ok(l.caps['image-to-video'].missingBytes > 30e9, 'manifeste : LTX ≈ 39 Go à installer sur un PC vide');
    ok(l.caps['image-to-video'].gated === true && l.caps.depth.gated === false, 'manifeste : LTX protégé, profondeur libre');
    ok(inst.urlOf(m.files[0]).startsWith('https://huggingface.co/Lightricks/LTX-2.5/resolve/'), 'manifeste : adresse Hugging Face');
  }

  // 22. a token pasted in Mia: checked with Hugging Face, written to Hugging Face's own file (never in Mia's data),
  // the gated files start again; $HF_TOKEN is read like Hugging Face's tools do
  {
    console.log('22. jeton collé dans Mia');
    await fsp.rm(finalOf('gated'), { force: true });
    const tf = path.join(ROOT, 'hf-home', 'token');
    const inst = makeInstaller({ tokenFile: tf });
    let bad = null;
    try { await inst.saveToken('not a token'); } catch (e) { bad = e; }
    ok(bad && bad.code === 'token-bad' && /hf_/.test(bad.userMessage), 'jeton : forme refusée');
    let refused = null;
    try { await inst.saveToken('hf_wrong_token_999999'); } catch (e) { refused = e; }
    ok(refused && refused.code === 'token-refused' && !fs.existsSync(tf), 'jeton : refusé par Hugging Face, rien d’écrit');
    // a gated file stopped for want of a token (a line kept from an older Mia): setToken starts it again
    const f = inst.file('gated');
    inst.jobs.push(inst.newJob(f, { state: 'error', errorCode: 'gated-no-token', error: 'x' }));
    const r = await inst.setToken({ token: `  Bearer ${GOOD_TOKEN}\n` });
    ok(r.ok && r.verified === true && r.user === 'testeur', `jeton : vérifié (${r.user})`);
    ok(fs.readFileSync(tf, 'utf8') === GOOD_TOKEN, 'jeton : rangé dans le fichier de Hugging Face, nettoyé');
    ok(r.queued.includes('gated'), 'jeton : les fichiers protégés repartent');
    const j = await waitFor(inst, 'gated', ['done', 'error']);
    ok(j.state === 'done', `jeton : fichier protégé installé (${j.error || ''})`);
    const data = fs.readdirSync(path.join(ROOT, 'data')).map((n) => fs.readFileSync(path.join(ROOT, 'data', n), 'utf8')).join('\n');
    ok(!data.includes(GOOD_TOKEN), 'jeton : absent des données de Mia');
    // start({token, keys}) in one call (the window's path while preload has no setToken)
    await fsp.rm(finalOf('gated'), { force: true });
    await fsp.rm(tf, { force: true });
    const inst2 = makeInstaller({ tokenFile: tf });
    const r2 = await inst2.start({ token: GOOD_TOKEN, keys: ['gated'] });
    ok(r2.ok && r2.token && r2.queued.includes('gated') && !r2.blocked.length, 'start {token, keys} : jeton rangé et fichier en file');
    await waitFor(inst2, 'gated', ['done', 'error']);
    const r3 = await inst2.start({ token: GOOD_TOKEN });
    ok(r3.ok && r3.token && !r3.queued.length, 'start {token} seul : rien d’autre');
    // $HF_TOKEN wins over the file, like huggingface_hub
    const inst3 = makeInstaller({ tokenFile: path.join(ROOT, 'no-token'), env: { HF_TOKEN: GOOD_TOKEN } });
    ok((await inst3.token()) === GOOD_TOKEN && (await inst3.list()).token === true, 'HF_TOKEN lu');
    const l = await inst.list();
    ok(l.tokenPage === 'https://huggingface.co/settings/tokens', 'list : page des jetons');
  }

  server.close();
  server6.close();
  if (!KEEP) await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  console.log(`\n${pass} / ${pass + fail} vérifications OK`);
  if (fail) {
    console.log('Échecs :\n - ' + failures.join('\n - '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('test interrompu :', e);
  process.exit(1);
});
