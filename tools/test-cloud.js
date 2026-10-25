'use strict';
// Banc d'essai du Cloud (SPEC §23.3) contre un FAUX Higgsfield local : aucun réseau, aucune clé réelle, aucun
// crédit. Vérifie le compte (clé au mauvais format, refusée, acceptée, gardée chiffrée), puis l'exécuteur en
// ligne de bout en bout : envoi des fichiers, corps de la demande d'après le catalogue (champs, paliers,
// interrupteurs on/off, aperçu moins cher), suivi de l'état, téléchargement du résultat, erreurs (solde,
// refus, modération), annulation pendant la file.
//   node tools/test-cloud.js
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MIA_HF_POLL_MS = '30';
const ROOT = path.resolve(__dirname, '..');
const { createService } = require(path.join(ROOT, 'electron', 'cloud.js'));
const route = require(path.join(ROOT, 'electron', 'engine', 'route.js'));
const cloudExec = require(path.join(ROOT, 'electron', 'engine', 'executors', 'cloud.js'));

const KEY = 'id-essai:secret-essai-123';
let pass = 0;
let fail = 0;
const ok = (cond, what, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${what}`); } else { fail++; console.log(`  ÉCHEC ${what} ${extra}`); }
};

// ── le faux Higgsfield ──────────────────────────────────────────────
const S = { uploads: new Map(), requests: new Map(), lastBody: null, lastPath: null, cancels: 0, submitMode: 'ok', steps: ['queued', 'in_progress', 'completed'] };
let port = 0;
const server = http.createServer(async (req, res) => {
  const body = await new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(obj == null ? '' : JSON.stringify(obj)); };
  const u = new URL(req.url, `http://127.0.0.1:${port}`);
  if (u.pathname.startsWith('/put/')) { S.uploads.set(u.pathname.slice(5), body); return send(200, null); }
  if (u.pathname.startsWith('/files/') && u.pathname !== '/files/generate-upload-url') {
    const b = S.uploads.get(u.pathname.slice(7)); res.writeHead(b ? 200 : 404); return res.end(b || '');
  }
  if (u.pathname.startsWith('/out/')) { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(Buffer.from('faux mp4')); }
  if (req.headers.authorization !== `Key ${KEY}`) return send(401, { detail: 'Invalid credentials' });
  if (u.pathname === '/files/generate-upload-url') {
    const id = `f${S.uploads.size + 1}_${Date.now()}`;
    return send(200, { public_url: `http://127.0.0.1:${port}/files/${id}`, upload_url: `http://127.0.0.1:${port}/put/${id}`,
      content_type: JSON.parse(body).content_type, upload_headers: { 'x-amz-tagging': 'retention=temporary' } });
  }
  const st = /^\/requests\/([^/]+)\/(status|cancel)$/.exec(u.pathname);
  if (st) {
    const r = S.requests.get(st[1]);
    if (!r) return send(404, { detail: 'Not found' });
    if (st[2] === 'cancel') { S.cancels++; if (r.step === 0) { r.cancelled = true; return send(202, null); } return send(400, { detail: 'started' }); }
    if (r.cancelled) return send(200, { status: 'canceled', request_id: st[1] });
    const status = r.steps[Math.min(r.step, r.steps.length - 1)];
    r.step++;
    const out = { status, request_id: st[1] };
    if (status === 'completed') out.video = { url: `http://127.0.0.1:${port}/out/${st[1]}.mp4` };
    if (status === 'failed') out.error = 'Generation failed';
    return send(200, out);
  }
  if (req.method === 'POST') {
    if (S.submitMode === '403') return send(403, { detail: 'Insufficient balance' });
    if (S.submitMode === '422') return send(422, { detail: [{ msg: 'duration must be ≤ 15' }] });
    S.lastBody = JSON.parse(body);
    S.lastPath = u.pathname.slice(1);
    const id = `00000000-0000-4000-8000-${String(S.requests.size + 1).padStart(12, '0')}`;
    S.requests.set(id, { step: 0, steps: S.steps.slice() });
    return send(200, { status: 'queued', request_id: id, status_url: `http://127.0.0.1:${port}/requests/${id}/status`,
      cancel_url: `http://127.0.0.1:${port}/requests/${id}/cancel` });
  }
  return send(404, { detail: 'Not found' });
});

// ── fichiers d'essai : une image PNG 1×1, un son WAV d'un dixième de seconde ──
function fixtures(dir) {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const img = path.join(dir, 'ref.png');
  fs.writeFileSync(img, png);
  const n = 4800;
  const wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
  const snd = path.join(dir, 'voix.wav');
  fs.writeFileSync(snd, wav);
  return { img, snd };
}

/** Le contexte qu'un vrai moteur donne à l'exécuteur, pour une famille et des entrées branchées. */
function xFor(svc, famKey, inputs, params, { mode = 'final', choice = null } = {}) {
  const R = route.rules();
  const { local, cloud } = route.catalogs();
  const fam = R.familyOf(famKey, local, cloud, null);
  const wf = R.chooseWorkflow(fam, Object.keys(inputs), choice).workflow;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-cloud-'));
  const ctrl = new AbortController();
  const logs = [];
  return {
    ctrl, logs, wf,
    x: {
      gen: { provider: 'higgsfield', key: fam.key, family: fam.def.name, workflow: wf.id, what: wf.label.fr, kind: fam.def.kind,
        endpoints: wf.endpoints, ports: wf.ports, params: wf.params },
      cloud: svc, params: { prompt: 'a test shot', ...params }, inputs, mode, outDir, runId: `r_test_${Date.now()}`,
      signal: ctrl.signal, lang: 'fr', progress: () => {}, log: (l) => logs.push(l),
      ffmpeg: { run: async () => { throw new Error('pas de conversion attendue'); }, encodeArgs: () => [] },
    },
  };
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-cloud-acc-'));
  const fake = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`CHIFFRE:${Buffer.from(s).toString('hex')}`),
    decryptString: (b) => Buffer.from(String(b).slice(8), 'hex').toString() };
  const file = path.join(dir, 'cloud.json');
  const svc = createService({ file, safe: fake, lang: () => 'fr', base: `http://127.0.0.1:${port}` });
  const { img, snd } = fixtures(dir);

  console.log('Compte');
  let r = await svc.setKey('pas-une-cle');
  ok(!r.ok && /ID:SECRET/.test(r.error), 'clé au mauvais format refusée sans appel');
  r = await svc.setKey('id-faux:secret-faux');
  ok(!r.ok && /refuse cette clé/.test(r.error), 'clé refusée par Higgsfield (401)', r.error);
  ok(!svc.linked(), 'rien n’est gardé après un refus');
  r = await svc.setKey(KEY);
  ok(r.ok && svc.linked() && r.status.keyTail === 'ssai', 'clé acceptée (appel gratuit), compte relié', JSON.stringify(r));
  const saved = fs.readFileSync(file, 'utf8');
  ok(!saved.includes('secret-essai-123') && !saved.includes(KEY), 'la clé n’est jamais écrite en clair');
  ok(!JSON.stringify(svc.status()).includes('secret'), 'l’état montré à la fenêtre ne contient pas la clé');
  const svc2 = createService({ file, safe: fake, lang: () => 'fr', base: `http://127.0.0.1:${port}` });
  ok(svc2.linked() && (await svc2.checkLinked()).ok, 'relu au redémarrage, toujours valable');

  console.log('MiniMax H3 en ligne · références (images + son)');
  let t = xFor(svc, 'hf:minimax-h3', { refs: [{ abs: img, kind: 'image' }, { abs: img, kind: 'image' }], refAudios: [{ abs: snd, kind: 'audio' }] },
    { 'hf.duration': 10, 'hf.aspect_ratio': '9:16' });
  ok(t.wf.id === 'minimax/h3/reference-to-video', 'workflow choisi : références', t.wf.id);
  let res = await cloudExec.run(t.x);
  ok(S.lastPath === 'minimax/h3/reference-to-video', 'adresse de la demande', S.lastPath);
  ok(Array.isArray(S.lastBody.image_urls) && S.lastBody.image_urls.length === 2 && S.lastBody.audio_urls.length === 1,
    'images et son envoyés, en listes', JSON.stringify(S.lastBody));
  ok(S.lastBody.duration === 10 && S.lastBody.aspect_ratio === '9:16' && S.lastBody.prompt === 'a test shot', 'réglages et consigne');
  ok(res.outputs.out && fs.existsSync(res.outputs.out.abs) && res.outputs.out.kind === 'video', 'résultat téléchargé dans la version');
  ok(/Higgsfield/.test(res.notes || '') || /Higgsfield/.test(res.model), 'la note dit « calculé en ligne »');

  console.log('Kling 3.0 · animer une image · palier et son');
  t = xFor(svc, 'hf:kling-3-0', { start: { abs: img, kind: 'image' } }, { 'hf.tier': 'std', 'hf.sound': false, 'hf.duration': 5 });
  await cloudExec.run(t.x);
  ok(S.lastPath === 'kling-video/v3.0/std/image-to-video', 'le palier choisit l’adresse', S.lastPath);
  ok(S.lastBody.sound === 'off' && typeof S.lastBody.image_url === 'string', 'interrupteur rendu en « on/off », image au bon champ', JSON.stringify(S.lastBody));

  console.log('Seedance 2.5 · aperçu moins cher');
  t = xFor(svc, 'hf:seedance-2-5', {}, { 'hf.resolution': '1080p', 'hf.duration': 12 }, { mode: 'preview' });
  await cloudExec.run(t.x);
  ok(S.lastBody.resolution === '480p' && S.lastBody.duration === 4, 'aperçu : plus petite résolution, durée la plus courte', JSON.stringify(S.lastBody));

  // Bug du premier vrai calcul (25/10, SOUL) : « URL input should be a string or URL ». Le bloc Modèle garde ses
  // références en liste ; chaque champ en ligne doit pourtant recevoir UNE adresse ou une LISTE selon son propre
  // format. On vérifie toutes les façons de faire du catalogue, avec deux fichiers branchés sur chaque entrée.
  console.log('Format des adresses envoyées (toutes les familles en ligne)');
  {
    const { cloud } = route.catalogs();
    let checked = 0;
    const wrong = [];
    for (const fam of cloud.families || []) {
      for (const wf of fam.workflows || []) {
        const inputs = {};
        for (const p of Object.keys(wf.ports || {})) if (p !== 'prompt') inputs[p] = [{ abs: img, kind: 'image' }, { abs: img, kind: 'image' }];
        const x = { gen: { ports: wf.ports, params: wf.params }, inputs, params: { prompt: 'p' } };
        const items = cloudExec._uploadsOf(x);
        const urls = {};
        for (const it of items) {
          const u = `https://cdn.test/${it.port}/${it.i ?? 0}.png`;
          if (it.multi) (urls[it.port] = urls[it.port] || []).push(u); else urls[it.port] = u;
        }
        const body = cloudExec._bodyOf(x, urls, false);
        for (const [p, d] of Object.entries(wf.ports || {})) {
          if (p === 'prompt' || !d.field) continue;
          checked++;
          const v = body[d.field];
          const okShape = d.multi ? Array.isArray(v) && v.length === 2 : typeof v === 'string';
          if (!okShape) wrong.push(`${fam.name} · ${wf.id} · ${d.field} = ${JSON.stringify(v)}`);
        }
      }
    }
    ok(!wrong.length && checked > 80, `${checked} champs : une adresse ou une liste, comme chaque champ l’attend`, wrong.slice(0, 5).join(' | '));
  }
  t = xFor(svc, 'hf:soul', { refs: [{ abs: img, kind: 'image' }] }, {});
  await cloudExec.run(t.x);
  ok(typeof S.lastBody.image_reference_url === 'string', 'SOUL : l’image de référence part en une seule adresse', JSON.stringify(S.lastBody));

  console.log('Erreurs');
  S.submitMode = '403';
  t = xFor(svc, 'hf:minimax-h3', {}, {});
  r = await cloudExec.run(t.x).then(() => null, (e) => e);
  ok(r && /crédits insuffisant/.test(r.message), 'solde insuffisant (403) dit en clair', r && r.message);
  S.submitMode = '422';
  r = await cloudExec.run(xFor(svc, 'hf:minimax-h3', {}, {}).x).then(() => null, (e) => e);
  ok(r && /refuse ces réglages : duration/.test(r.message), 'réglages refusés (422) avec le détail', r && r.message);
  S.submitMode = 'ok';
  S.steps = ['queued', 'in_progress', 'nsfw'];
  r = await cloudExec.run(xFor(svc, 'hf:minimax-h3', {}, {}).x).then(() => null, (e) => e);
  ok(r && /modération/.test(r.message), 'modération : rien n’est facturé, dit en clair', r && r.message);
  S.steps = ['queued', 'queued', 'queued', 'queued', 'queued', 'completed'];
  t = xFor(svc, 'hf:minimax-h3', {}, {});
  setTimeout(() => t.ctrl.abort(), 60);
  r = await cloudExec.run(t.x).then(() => null, (e) => e);
  ok(r && (r.name === 'AbortError' || r.cancelled) && S.cancels >= 1, 'annulé dans Mia pendant la file : annulé chez Higgsfield', r && r.message);

  server.close();
  console.log(`\n${pass} contrôles réussis, ${fail} échec(s).`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); server.close(); process.exit(2); });
