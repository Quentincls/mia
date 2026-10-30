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
const { createPrices } = require(path.join(ROOT, 'electron', 'engine', 'cloudprice.js'));

const KEY = 'id-essai:secret-essai-123';
let pass = 0;
let fail = 0;
const ok = (cond, what, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${what}`); } else { fail++; console.log(`  ÉCHEC ${what} ${extra}`); }
};

// ── le faux Higgsfield ──────────────────────────────────────────────
const S = { uploads: new Map(), requests: new Map(), lastBody: null, lastPath: null, cancels: 0, submitMode: 'ok', steps: ['queued', 'in_progress', 'completed'],
  usage: [], usageCalls: [], usageMode: 'ok', estimates: [],
  full429: 0, retryAfter: '1', submits: [], idem: new Map(), lose: 0, down: false };
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
  // faux tarif : 0,10 $ la seconde, +0,20 $ en Pro
  if (req.method === 'POST' && u.pathname.startsWith('/estimate/')) {
    const b = JSON.parse(body);
    const path0 = u.pathname.slice(1);
    S.estimates.push({ path: path0, body: b });
    if (/genjutsu/.test(path0)) return send(422, { detail: [{ msg: 'video_url: could not read the file' }] });
    if (/cinema-studio/.test(path0)) return send(200, { credits: 3 });                       // répond sans prix
    if (/wan-3\.0\/text/.test(path0)) return send(500, { detail: 'down' });
    const usd = 0.1 * (Number(b.duration) || 5) + (/\/pro\//.test(path0) ? 0.2 : 0);
    return send(200, { usd: usd.toFixed(3) });
  }
  if (u.pathname === '/models/usage') {
    const q = u.searchParams;
    S.usageCalls.push({ start: q.get('start'), end: q.get('end'), timeframe: q.get('timeframe'), bound: q.get('bound_to_timeframe') });
    if (S.usageMode === '500') return send(500, { detail: 'down' });
    const a = Date.parse(q.get('start'));
    const b = Date.parse(q.get('end'));
    if (!(b > a) || b - a > 31 * 864e5) return send(400, { detail: 'start/end: at most 31 days' });
    const results = S.usage.filter((x) => x.at >= a && x.at < b)
      .map((x) => ({ model: 'kling-video/v2.5-turbo', unit: 'generation', quantity: '1', unit_price: x.cost.toFixed(4), cost: x.cost.toFixed(4), currency: 'USD' }));
    return send(200, { time_series: results.length ? [{ bucket: q.get('start'), results }] : [], total: results.length ? 1 : 0, page: 1, limit: 100 });
  }
  const st = /^\/requests\/([^/]+)\/(status|cancel)$/.exec(u.pathname);
  if (st) {
    const r = S.requests.get(st[1]);
    if (!r) return send(404, { detail: 'Not found' });
    // comme Higgsfield : annulable tant que la demande est en file, plus une fois commencée
    if (st[2] === 'cancel') {
      S.cancels++;
      if (!r.last || r.last === 'queued') { r.cancelled = true; return send(202, null); }
      return send(400, { detail: 'started' });
    }
    if (r.cancelled) return send(200, { status: 'canceled', request_id: st[1] });
    const status = r.steps[Math.min(r.step, r.steps.length - 1)];
    r.step++;
    r.last = status;
    const out = { status, request_id: st[1] };
    if (status === 'completed') out.video = { url: `http://127.0.0.1:${port}/out/${st[1]}.mp4` };
    if (status === 'failed') out.error = 'Generation failed';
    return send(200, out);
  }
  if (req.method === 'POST') {
    if (S.submitMode === '403') return send(403, { detail: 'Insufficient balance' });
    if (S.submitMode === '422') return send(422, { detail: [{ msg: 'duration must be ≤ 15' }] });
    // comme Higgsfield quand SA file est pleine : 429 account_queue_full + Retry-After, rien n'est créé
    S.submits.push({ key: req.headers['idempotency-key'] || null, at: Date.now() });
    // panne franche : rien n'est créé
    if (S.down) return send(503, { detail: 'down' });
    if (S.full429 > 0) {
      S.full429--;
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': S.retryAfter });
      return res.end(JSON.stringify({ detail: { code: 'account_queue_full', message: 'Too many queued generations for this account',
        retryable: true, limit: 40, retry_after_seconds: 30 } }));
    }
    // même Idempotency-Key = la même demande (jamais deux calculs facturés)
    const k0 = req.headers['idempotency-key'];
    if (k0 && S.idem.has(k0)) {
      const id0 = S.idem.get(k0);
      return send(200, { status: 'queued', request_id: id0, status_url: `http://127.0.0.1:${port}/requests/${id0}/status`,
        cancel_url: `http://127.0.0.1:${port}/requests/${id0}/cancel` });
    }
    S.lastBody = JSON.parse(body);
    S.lastPath = u.pathname.slice(1);
    const id = `00000000-0000-4000-8000-${String(S.requests.size + 1).padStart(12, '0')}`;
    S.requests.set(id, { step: 0, steps: S.steps.slice() });
    if (k0) S.idem.set(k0, id);
    // réponse perdue : la demande EST créée chez Higgsfield, mais Mia reçoit un 502
    if (S.lose > 0) { S.lose--; return send(502, { detail: 'bad gateway' }); }
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
  // deux « vidéos » (le faux ffmpeg leur donne une durée) : la source d'un montage, un clip trop court
  const vid = path.join(dir, 'source.mp4');
  fs.writeFileSync(vid, Buffer.from('fausse video source'));
  const short = path.join(dir, 'court.mp4');
  fs.writeFileSync(short, Buffer.from('fausse video courte'));
  return { img, snd, vid, short };
}

/** Le contexte qu'un vrai moteur donne à l'exécuteur, pour une famille et des entrées branchées. */
function xFor(svc, famKey, inputs, params, { mode = 'final', choice = null, durations = {} } = {}) {
  const R = route.rules();
  const { local, cloud } = route.catalogs();
  const fam = R.familyOf(famKey, local, cloud, null);
  const wf = R.chooseWorkflow(fam, Object.keys(inputs), choice).workflow;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-cloud-'));
  const ctrl = new AbortController();
  const logs = [];
  const msgs = [];
  return {
    ctrl, logs, msgs, wf,
    x: {
      gen: { provider: 'higgsfield', key: fam.key, family: fam.def.name, workflow: wf.id, what: wf.label.fr, kind: fam.def.kind,
        endpoints: wf.endpoints, ports: wf.ports, params: wf.params },
      cloud: svc, params: { prompt: 'a test shot', ...params }, inputs, mode, outDir, runId: `r_test_${Date.now()}_${Math.random()}`,
      signal: ctrl.signal, lang: 'fr', progress: (p, m) => { if (m) msgs.push(m); }, log: (l) => logs.push(l),
      // faux ffmpeg : aucune conversion attendue ; la durée d'une vidéo est celle que le test donne (5 s sinon)
      ffmpeg: { run: async () => { throw new Error('pas de conversion attendue'); }, encodeArgs: () => [],
        probe: async (abs) => ({ duration: durations[abs] ?? 5 }) },
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
  const { img, snd, vid, short } = fixtures(dir);

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

  console.log('Dépenses et reste estimé (coin de la planche)');
  const DAY = 864e5;
  const now = Date.now();
  const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();
  // 2,50 $ ce mois-ci (une génération à l'instant), 4 $ il y a 40 jours, 1,25 $ il y a 50 jours
  S.usage = [{ at: now - 60 * 1000, cost: 2.5 }, { at: now - 40 * DAY, cost: 4 }, { at: now - 50 * DAY, cost: 1.25 }];
  S.usageCalls = [];
  let b = await svc.budget({ fresh: true });
  ok(b.linked && b.month === 2.5 && b.currency === 'USD' && b.left === null && b.topUp === null, 'ce mois-ci : 2,50 $, pas de reste sans recharge', JSON.stringify(b));
  ok(S.usageCalls.length === 1 && Date.parse(S.usageCalls[0].start) === Math.floor(monthStart / 1000) * 1000 && S.usageCalls[0].bound === 'false',
    'une seule demande, du 1er du mois à maintenant, bornes exactes', JSON.stringify(S.usageCalls));
  r = await svc.setTopUp({ amount: 'cinquante' });
  ok(!r.ok && /montant/.test(r.error), 'montant illisible refusé', JSON.stringify(r));
  r = await svc.setTopUp({ amount: '50,00', at: now - 45 * DAY });
  ok(r.ok && r.topUp.amount === 50, 'recharge de 50 $ il y a 45 jours, gardée', JSON.stringify(r));
  ok(!fs.readFileSync(file, 'utf8').includes(KEY) && JSON.parse(fs.readFileSync(file, 'utf8')).topUp.amount === 50, 'gardée dans cloud.json, la clé toujours chiffrée');
  S.usageCalls = [];
  b = await svc.budget();
  ok(b.sinceTopUp === 6.5 && b.left === 43.5, 'depuis la recharge : 2,50 + 4 = 6,50 $ ; reste ≈ 43,50 $ (la dépense d’avant ne compte pas)', JSON.stringify(b));
  const spans = S.usageCalls.map((c) => (Date.parse(c.end) - Date.parse(c.start)) / DAY);
  ok(S.usageCalls.length === 3 && spans.every((d) => d <= 31), '45 jours : coupés en fenêtres de 31 jours au plus (l’API refuse plus de 31)', JSON.stringify(spans));
  S.usageCalls = [];
  b = await svc.budget();
  ok(S.usageCalls.length === 0 && b.left === 43.5, 'redemandé dans la minute : la réponse gardée, aucun appel');
  S.usageMode = '500';
  b = await svc.budget({ fresh: true });
  ok(b.linked && /indisponible/.test(b.error) && b.last && b.last.left === 43.5, 'Higgsfield en panne : erreur claire, dernière valeur gardée', JSON.stringify(b));
  S.usageMode = 'ok';
  r = await svc.setTopUp({ amount: 20 });
  b = await svc.budget();
  ok(r.ok && !b.error && b.left === 20 && b.sinceTopUp === 0, 'recharge indiquée à l’instant : début et fin ne se confondent pas, reste = 20 $', JSON.stringify(b));
  r = await svc.setTopUp(null);
  b = await svc.budget({ fresh: true });
  ok(r.ok && b.topUp === null && b.left === null && b.month === 2.5, 'recharge oubliée : plus de reste, les dépenses restent');
  const svcOff = createService({ file: path.join(dir, 'aucun.json'), safe: fake, lang: () => 'fr', base: `http://127.0.0.1:${port}` });
  ok((await svcOff.budget()).linked === false, 'sans compte relié : rien n’est demandé');

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
  t = xFor(svc, 'hf:kling-3-0', { start: { abs: img, kind: 'image' } }, {});
  await cloudExec.run(t.x);
  ok(S.lastPath === 'kling-video/v3.0/pro/image-to-video', 'qualité jamais touchée : « Pro », celle que montre le bloc (plus la 4K, la 1re de la liste)', S.lastPath);

  console.log('Prix avant de lancer (POST /estimate)');
  const prices = createPrices(svc);
  const upBefore = S.uploads.size;
  S.estimates = [];
  let pr = await prices.priceOf({ family: 'hf:kling-3-0', params: { 'hf.duration': 10 }, ports: ['start'] });
  const est = S.estimates[0] || {};
  ok(pr.ok && pr.usd === 1.2, 'prix du bloc : 10 s en Pro = 1,20 $ (faux tarif)', JSON.stringify(pr));
  ok(est.path === 'estimate/kling-video/v3.0/pro/image-to-video' && /example\.com/.test(est.body.image_url) && est.body.duration === 10,
    'la demande que le bloc enverrait, l’image remplacée par une adresse factice', JSON.stringify(est));
  ok(S.uploads.size === upBefore && !S.requests.has(est.id), 'rien d’envoyé ni de lancé pour un prix');
  pr = await prices.priceOf({ family: 'hf:kling-3-0', params: { 'hf.duration': 10 }, ports: ['start'] });
  ok(S.estimates.length === 1 && pr.usd === 1.2, 'mêmes réglages : prix gardé, aucun nouvel appel');
  let from = await prices.fromPrices(['hf:kling-3-0', 'hf:seedance-2-5', 'hf:inconnu']);
  ok(typeof from['hf:kling-3-0'] === 'number' && typeof from['hf:seedance-2-5'] === 'number' && from['hf:inconnu'] === null,
    '« dès … $ » pour chaque famille, rien pour une inconnue', JSON.stringify(from));
  const cheap = S.estimates.find((e) => /seedance-2\.5/.test(e.path));
  ok(cheap && cheap.path === 'estimate/bytedance/seedance-2.5/text-to-video' && cheap.body.duration === 4 && cheap.body.resolution === '480p',
    '« dès » = la façon la moins chère : sans média, plus petite résolution, durée la plus courte', JSON.stringify(cheap));
  const k3 = S.estimates.filter((e) => /^estimate\/kling-video\/v3\.0/.test(e.path) && !e.body.image_url);
  ok(k3.length === 4 && from['hf:kling-3-0'] === Math.min(...k3.map((e) => Math.round((0.1 * e.body.duration + (/\/pro\//.test(e.path) ? 0.2 : 0)) * 1000) / 1000)),
    'Kling 3.0 : chaque qualité demandée, le plus bas gardé (plus la 4K, la 1re de la liste)', JSON.stringify({ from: from['hf:kling-3-0'], paths: k3.map((e) => e.path) }));
  const n0 = S.estimates.length;
  from = await createPrices(svc).fromPrices(['hf:kling-3-0', 'hf:seedance-2-5']);
  ok(S.estimates.length === n0 && from['hf:seedance-2-5'] === 0.4, 'gardés un jour dans cloud.json : aucun appel au redémarrage', JSON.stringify(from));
  ok(!(await createPrices({ linked: () => false }).priceOf({ family: 'hf:genjutsu' })).ok, 'sans compte relié : pas de prix, aucun appel');
  pr = await prices.priceOf({ family: 'hf:genjutsu', params: {}, ports: ['refs', 'motion'] });
  const errs = JSON.parse(fs.readFileSync(file, 'utf8')).priceErrors || {};
  const gErr = Object.entries(errs).find(([k]) => /genjutsu/.test(k));
  ok(!pr.ok && /could not read the file/.test(pr.error) && gErr && gErr[1].status === 422 && /could not read/.test(gErr[1].message),
    'prix refusé : la raison de Higgsfield revient au bloc et reste dans cloud.json (sans la clé)', JSON.stringify({ pr, gErr }));
  ok(!JSON.stringify(errs).includes(KEY), 'aucune trace de la clé dans les raisons gardées');
  // plusieurs refus en même temps (« + Bloc » demande trois prix à la fois) : aucun ne se perd dans le fichier (28/10)
  from = await createPrices(svc).fromPrices(['hf:cinema-studio-4-0', 'hf:wan-3-0', 'hf:genjutsu', 'hf:kling-2-6-motion-control', 'hf:kling-2-6']);
  const errs2 = JSON.parse(fs.readFileSync(file, 'utf8')).priceErrors || {};
  const has = (re) => Object.keys(errs2).some((k) => re.test(k));
  ok(has(/cinema-studio/) && has(/wan-3\.0\/text/) && has(/genjutsu/) && from['hf:kling-2-6'] > 0
    && /sans prix/.test((Object.entries(errs2).find(([k]) => /cinema/.test(k)) || [])[1]?.message || '')
    && JSON.parse(fs.readFileSync(file, 'utf8')).prices['hf:kling-2-6'],
    'refus simultanés : chacun gardé dans cloud.json, avec les prix obtenus', JSON.stringify({ keys: Object.keys(errs2), from }));
  ok(from['hf:cinema-studio-4-0'] > 0 && from._public.includes('hf:cinema-studio-4-0') && !from._public.includes('hf:kling-2-6')
    && !JSON.parse(fs.readFileSync(file, 'utf8')).prices['hf:cinema-studio-4-0'],
    'réponse sans montant (Cinema Studio) : le tarif public, marqué « public », jamais gardé comme une estimation', JSON.stringify(from));

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
  // (SOUL n'a plus image_reference_url dans son schéma, 30/10) : SOUL V2 image → image prend UNE image
  t = xFor(svc, 'hf:soul-v2', { image: { abs: img, kind: 'image' } }, {});
  await cloudExec.run(t.x);
  ok(t.wf.id === 'higgsfield-ai/soul/v2/image-to-image' && S.lastPath === 'higgsfield-ai/soul/v2/image-to-image' && typeof S.lastBody.image_url === 'string',
    'SOUL V2 image → image : l’image part en une seule adresse', JSON.stringify({ path: S.lastPath, body: S.lastBody }));

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
  // annulé une fois le calcul commencé : Higgsfield ne peut plus l'arrêter, il est payé → Mia attend et le récupère
  S.steps = ['queued', 'in_progress', 'in_progress', 'in_progress', 'completed'];
  t = xFor(svc, 'hf:minimax-h3', {}, {});
  {
    const msgs = [];
    t.x.progress = (p, m) => { if (m) msgs.push(m); if (m && /Calcul en cours/.test(m) && !t.ctrl.signal.aborted) t.ctrl.abort(); };
    res = await cloudExec.run(t.x).then((v) => v, (e) => e);
    ok(res && res.outputs && fs.existsSync(res.outputs.out.abs) && res.locked === true && /déjà payé/.test(res.notes || ''),
      'annulé trop tard (calcul commencé) : le résultat payé est récupéré, la note le dit', res && (res.message || res.notes));
    ok(msgs.some((m) => cloudExec.isLocked(m)) && cloudExec.isLocked(cloudExec.LOCKED.en),
      'pendant l’attente, le message « cloud-locked » est donné (isLocked) pour le bouton du bloc', JSON.stringify(msgs.slice(-3)));
  }
  S.steps = ['queued', 'in_progress', 'completed'];

  console.log('Paliers : rien hors de ce que le palier choisi accepte');
  t = xFor(svc, 'hf:kling-3-0', { start: { abs: img, kind: 'image' }, end: { abs: img, kind: 'image' } },
    { 'hf.tier': 'turbo', 'hf.cfg_scale': 0.8, 'hf.resolution': '1080p' });
  let up0 = S.uploads.size;
  res = await cloudExec.run(t.x);
  ok(S.lastPath === 'kling-video/v3.0-turbo/image-to-video' && !('sound' in S.lastBody) && !('cfg_scale' in S.lastBody)
    && !('last_image_url' in S.lastBody) && S.lastBody.resolution === '1080p' && S.uploads.size - up0 === 1,
  'Kling 3.0 Turbo : ni son, ni fidélité, ni image de fin (envoyée nulle part), mais sa résolution', JSON.stringify(S.lastBody));
  ok(/Image de fin » n’existe pas en « Turbo »/.test(res.notes || '') && /Fidélité à la consigne » n’existe pas en « Turbo »/.test(res.notes || ''),
    'ce qui n’est pas envoyé est dit dans les notes de la version', res.notes);
  t = xFor(svc, 'hf:kling-3-0', { start: { abs: img, kind: 'image' } }, { 'hf.tier': 'std', 'hf.resolution': '1080p' });
  await cloudExec.run(t.x);
  ok(S.lastPath === 'kling-video/v3.0/std/image-to-video' && !('resolution' in S.lastBody) && S.lastBody.sound === 'on',
    'Kling 3.0 Standard : pas de résolution (réservée au Turbo), le son par défaut', JSON.stringify(S.lastBody));
  up0 = S.uploads.size;
  let reqs0 = S.requests.size;
  r = await cloudExec.run(xFor(svc, 'hf:kling-3-0', { start: { abs: img, kind: 'image' } }, { 'hf.tier': 'turbo', prompt: '' }).x).then(() => null, (e) => e);
  ok(r && /Turbo » demande une consigne/.test(r.message) && S.uploads.size === up0 && S.requests.size === reqs0,
    'Turbo sans consigne : arrêté avant tout envoi (la consigne n’y est obligatoire que là)', r && r.message);
  t = xFor(svc, 'hf:ltx-2-5', {}, { 'hf.tier': 'pro', 'hf.resolution': '4k', 'hf.fps': 48 });
  res = await cloudExec.run(t.x);
  ok(S.lastPath === 'lightricks/ltx-2.5/text-to-video/pro' && S.lastBody.resolution === '1080p' && S.lastBody.fps === 50
    && /4k n’existe pas ici, ramené à 1080p/.test(res.notes || '') && /48 n’existe pas ici, ramené à 50/.test(res.notes || ''),
  'LTX-2.5 Pro : 4K et 48 i/s (Rapide seulement) ramenés à 1080p et 50, et dit', JSON.stringify({ body: S.lastBody, notes: res.notes }));
  t = xFor(svc, 'hf:ltx-2-5', {}, { 'hf.tier': 'fast', 'hf.resolution': '4k', 'hf.fps': 48 });
  await cloudExec.run(t.x);
  ok(S.lastPath === 'lightricks/ltx-2.5/text-to-video/fast' && S.lastBody.resolution === '4k' && S.lastBody.fps === 48,
    'LTX-2.5 Rapide : 4K et 48 i/s gardés', JSON.stringify(S.lastBody));
  // toutes les familles, tous les paliers, chaque réglage poussé à sa dernière valeur (graine au-delà de tout maximum) :
  // chaque champ envoyé existe dans le schéma de CETTE adresse, avec une valeur permise
  {
    const SCH = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'fixtures', 'cloud-schemas.json'), 'utf8')).endpoints;
    const { cloud } = route.catalogs();
    let n = 0;
    const bad = [];
    for (const fam of cloud.families || []) {
      for (const wf of fam.workflows || []) {
        const tp = (wf.params || []).find((p) => p.id === 'hf.tier');
        for (const tier of tp ? tp.options.map((o) => o.value) : [null]) {
          for (const push of [false, true]) {
            const params = { prompt: 'p', negative: 'text, watermark, cuts' };
            if (tier) params['hf.tier'] = tier;
            for (const p of wf.params || []) {
              if (!p.field || !push) continue;
              if (p.options) params[p.id] = p.options[p.options.length - 1].value;
              else if (p.kind === 'seed') params[p.id] = 2 ** 31 + 5;
              else if (p.kind === 'slider' || p.kind === 'number') params[p.id] = (p.max ?? 100) + 1000;
              else if (p.kind === 'toggle') params[p.id] = true;
              else if (p.format === 'int-list') params[p.id] = '3, 12';
              else params[p.id] = 'x';
            }
            const inputs = {};
            for (const p of Object.keys(wf.ports || {})) if (p !== 'prompt') inputs[p] = [{ abs: img, kind: 'image' }, { abs: img, kind: 'image' }];
            const x = { gen: { ports: wf.ports, params: wf.params, endpoints: wf.endpoints }, inputs, params };
            const urls = {};
            for (const it of cloudExec._uploadsOf(x)) {
              const u = `https://cdn.test/${it.port}/${it.i ?? 0}.png`;
              if (it.multi) (urls[it.port] = urls[it.port] || []).push(u); else urls[it.port] = u;
            }
            const body = cloudExec._bodyOf(x, urls, { notes: [] });
            const ep = cloudExec._endpointOf(x);
            const sch = SCH[ep];
            if (!sch) { bad.push(`${ep} : pas de schéma`); continue; }
            for (const [k, v] of Object.entries(body)) {
              n++;
              const d = sch.props[k];
              if (!d) { bad.push(`${ep} · ${k} hors du schéma`); continue; }
              if (d.enum && !d.enum.some((e) => String(e) === String(v))) bad.push(`${ep} · ${k}=${v} hors de [${d.enum}]`);
              if (typeof v === 'number' && ((d.min != null && v < d.min) || (d.max != null && v > d.max))) bad.push(`${ep} · ${k}=${v} hors de ${d.min}–${d.max}`);
              if (d.type === 'string' && typeof v === 'string' && !v.trim()) bad.push(`${ep} · ${k} vide`);
            }
            if ('negative_prompt' in body && body.negative_prompt === 'text, watermark, cuts') bad.push(`${ep} · consigne négative cachée envoyée`);
          }
        }
      }
    }
    ok(!bad.length && n > 400, `${n} champs envoyés, tous dans le schéma de leur palier, valeurs permises (réglages poussés au bout)`, bad.slice(0, 6).join(' | '));
  }

  console.log('Graines bornées, consigne négative, aperçu');
  t = xFor(svc, 'hf:soul', {}, { 'hf.seed': 999999999 });
  res = await cloudExec.run(t.x);
  ok(S.lastBody.seed === 1000000 && /hors des bornes du modèle \(1 à 1000000\), ramené à 1000000/.test(res.notes || ''),
    'SOUL : graine du dé (1e9) ramenée au maximum de l’API (1 000 000), et dit', JSON.stringify({ seed: S.lastBody.seed, notes: res.notes }));
  t = xFor(svc, 'hf:happyhorse-1-1', {}, { 'hf.seed': 0 });
  await cloudExec.run(t.x);
  ok(S.lastBody.seed === 1, 'HappyHorse 1.1 : graine 0 refusée par l’API, ramenée à 1', JSON.stringify(S.lastBody));
  t = xFor(svc, 'hf:kling-2-5-turbo', {}, { negative: 'text, watermark, cuts' });
  await cloudExec.run(t.x);
  ok(!('negative_prompt' in S.lastBody), 'la consigne négative cachée du bloc Modèle n’est pas envoyée en ligne', JSON.stringify(S.lastBody));
  t = xFor(svc, 'hf:kling-2-5-turbo', {}, { negative: 'text, watermark, cuts', 'hf.negative_prompt': 'blur' });
  await cloudExec.run(t.x);
  ok(S.lastBody.negative_prompt === 'blur', 'seul « À éviter » du modèle en ligne compte', JSON.stringify(S.lastBody));
  t = xFor(svc, 'hf:genjutsu-light', { motion: { abs: vid, kind: 'video' }, refs: [{ abs: img, kind: 'image' }] }, { 'hf.resolution': '1080p' }, { mode: 'preview' });
  await cloudExec.run(t.x);
  const unsorted = { id: 'hf.resolution', field: 'resolution', kind: 'seg', default: '720p',
    options: ['720p', '480p', '1080p'].map((value) => ({ value })) };
  ok(S.lastPath === 'higgsfield/genjutsu-light/motion-transfer/v1.0' && S.lastBody.resolution === '480p'
    && cloudExec._valueOf(unsorted, { params: { 'hf.resolution': '1080p' } }, { preview: true }) === '480p',
  'aperçu : la plus petite résolution par rang (480p), pas la 1re de la liste (720p dans l’ordre de l’API Genjutsu)', JSON.stringify(S.lastBody));

  console.log('Kling 4.0');
  {
    const R = route.rules();
    const { local, cloud } = route.catalogs();
    const k4 = R.familyOf('hf:kling-4-0', local, cloud, null);
    ok(k4.def.workflows[0].id === 'kling-video/v4.0/text-to-video' && R.chooseWorkflow(k4, [], null).workflow.id === 'kling-video/v4.0/text-to-video',
      'texte → vidéo en premier (le prix « dès », rien de branché)', k4.def.workflows.map((w) => w.id).join(' '));
    const refOnlyStart = R.chooseWorkflow(k4, ['start'], null);
    const refMix = R.chooseWorkflow(k4, ['start', 'refs'], null);
    ok(refOnlyStart.workflow.id === 'kling-video/v4.0/image-to-video' && !refOnlyStart.ties.length && refMix.workflow.id === 'kling-video/v4.0/reference-to-video',
      'références : au moins une image ou vidéo de référence ; une image de début seule reste « Animer »', JSON.stringify([refOnlyStart.workflow.id, refMix.workflow.id]));
  }
  up0 = S.uploads.size;
  reqs0 = S.requests.size;
  r = await cloudExec.run(xFor(svc, 'hf:kling-4-0', { video: { abs: short, kind: 'video' } }, {}, { durations: { [short]: 2 } }).x).then(() => null, (e) => e);
  ok(r && /« Vidéo source » dure 2 s : Kling 4\.0 demande au moins 3 s\. Rien n’a été envoyé/.test(r.message) && S.uploads.size === up0 && S.requests.size === reqs0,
    'montage : une source de 2 s est arrêtée avant tout envoi (rien de payé)', r && r.message);
  t = xFor(svc, 'hf:kling-4-0', { video: { abs: vid, kind: 'video' }, start: { abs: img, kind: 'image' }, end: { abs: img, kind: 'image' } }, {},
    { durations: { [vid]: 12.4 } });
  res = await cloudExec.run(t.x);
  ok(S.lastPath === 'kling-video/v4.0/video-edit' && S.lastBody.duration === 12 && /Durée prise sur la vidéo source : 12 s/.test(res.notes || '')
    && typeof S.lastBody.image_url === 'string' && typeof S.lastBody.end_image_url === 'string',
  'montage : durée = celle de la source (12,4 s → 12), images de début et de fin envoyées', JSON.stringify({ body: S.lastBody, notes: res.notes }));
  t = xFor(svc, 'hf:kling-4-0', { video: { abs: vid, kind: 'video' } }, { 'hf.duration': 5 }, { durations: { [vid]: 12.4 } });
  await cloudExec.run(t.x);
  ok(S.lastBody.duration === 5, 'une durée choisie par Quentin passe avant celle de la source', JSON.stringify(S.lastBody));
  t = xFor(svc, 'hf:kling-4-0', { video: { abs: vid, kind: 'video' }, refs: [{ abs: img, kind: 'image' }], refVideos: [{ abs: vid, kind: 'video' }] },
    { prompt: 'Put the hat from Image 1 on him, moving like Vidéo 1' });
  res = await cloudExec.run(t.x);
  ok(S.lastBody.prompt === 'Put the hat from @image_1 on him, moving like @video_2' && /Citations réécrites/.test(res.notes || ''),
    'montage : « Image 1 » → @image_1, « Vidéo 1 » (1re référence) → @video_2 (la source est @video_1)', S.lastBody.prompt);
  t = xFor(svc, 'hf:kling-4-0', { refs: [{ abs: img, kind: 'image' }], start: { abs: img, kind: 'image' } }, {});
  await cloudExec.run(t.x);
  ok(S.lastPath === 'kling-video/v4.0/reference-to-video' && Array.isArray(S.lastBody.image_urls) && typeof S.lastBody.image_url === 'string'
    && S.lastBody.duration === 10, 'références + image de début ; durée par défaut de l’API (10 s)', JSON.stringify(S.lastBody));

  console.log('File Higgsfield pleine (429 account_queue_full + Retry-After)');
  {
    // 2 refus « file pleine », puis accepté : attente de Retry-After, même Idempotency-Key, une seule demande créée
    S.full429 = 2; S.retryAfter = '1'; S.submits = [];
    const before = S.requests.size;
    let tq = xFor(svc, 'hf:kling-3-0', { start: { abs: img, kind: 'image' } }, { 'hf.tier': 'std' });
    const remotes = [];
    tq.x.remote = (st) => remotes.push(st);
    const t0 = Date.now();
    let rq = await cloudExec.run(tq.x);
    const keys = S.submits.map((x) => x.key);
    ok(rq.outputs && fs.existsSync(rq.outputs.out.abs), '429 deux fois puis accepté : résultat récupéré');
    ok(keys.length === 3 && keys.every((k) => k && k === tq.x.runId), 'trois envois, la MÊME Idempotency-Key (celle de la version)', JSON.stringify(keys));
    ok(S.requests.size === before + 1, 'une seule demande créée chez Higgsfield (rien de facturé en double)', `${before} → ${S.requests.size}`);
    ok(Date.now() - t0 >= 1900 && S.submits[1].at - S.submits[0].at >= 950, 'Retry-After respecté (1 s entre deux envois)', `${Date.now() - t0} ms`);
    ok(tq.msgs.some((m) => /^File Higgsfield pleine, nouvel essai dans 1 s$/.test(m)), 'progression : « File Higgsfield pleine, nouvel essai dans N s »', JSON.stringify(tq.msgs.slice(0, 6)));
    ok(tq.msgs.includes('En file chez Higgsfield…') && remotes.includes('full') && remotes.includes('queued') && remotes.includes('running'),
      'état « en file chez Higgsfield » donné au moteur (full → queued → running)', JSON.stringify(remotes));
    ok(tq.logs.some((l) => /429 \(account_queue_full\).*même Idempotency-Key/.test(l)), 'le journal dit 429 account_queue_full et la même clé');

    // annulé pendant l'attente : rien d'envoyé de plus, rien de créé, rien de payé
    S.full429 = 50; S.retryAfter = '30'; S.submits = [];
    const before2 = S.requests.size;
    tq = xFor(svc, 'hf:kling-3-0', { start: { abs: img, kind: 'image' } }, { 'hf.tier': 'std' });
    setTimeout(() => tq.ctrl.abort(), 1300);
    const t1 = Date.now();
    rq = await cloudExec.run(tq.x).then(() => null, (e) => e);
    ok(rq && (rq.name === 'AbortError' || rq.cancelled), 'annulé pendant l’attente de Retry-After : annulation propre', rq && rq.message);
    ok(Date.now() - t1 < 4000 && S.submits.length === 1 && S.requests.size === before2, 'pas d’attente des 30 s, aucun nouvel envoi, aucune demande créée',
      JSON.stringify({ ms: Date.now() - t1, sends: S.submits.length }));
    ok(tq.msgs.some((m) => /nouvel essai dans 30 s/.test(m)), 'Retry-After lu (30 s)', JSON.stringify(tq.msgs.slice(-2)));
    S.full429 = 0;

    // 502 après création (réponse perdue), puis annulé pendant l'attente : un dernier envoi avec la même clé retrouve
    // la demande, qui est annulée chez Higgsfield tant qu'elle est en file (rien n'est abandonné ni payé)
    S.lose = 1; S.submits = [];
    const before3 = S.requests.size; const cancels3 = S.cancels;
    tq = xFor(svc, 'hf:kling-3-0', { start: { abs: img, kind: 'image' } }, { 'hf.tier': 'std' });
    setTimeout(() => tq.ctrl.abort(), 300);
    const t2 = Date.now();
    rq = await cloudExec.run(tq.x).then(() => null, (e) => e);
    ok(rq && (rq.name === 'AbortError' || rq.cancelled) && Date.now() - t2 < 3000, 'coupure après création puis annulé : annulation propre, sans attendre', rq && rq.message);
    ok(S.submits.length === 2 && S.submits.every((x) => x.key === tq.x.runId) && S.requests.size === before3 + 1 && S.cancels === cancels3 + 1,
      'un dernier envoi (même clé) retrouve la demande créée et l’annule chez Higgsfield', JSON.stringify({ sends: S.submits.length, made: S.requests.size - before3, cancels: S.cancels - cancels3 }));
    ok(tq.logs.some((l) => /dernier envoi/.test(l)), 'le journal dit le dernier envoi');

    // même chose, mais Higgsfield ne répond toujours pas : l'erreur dit qu'un calcul a peut-être été lancé
    S.down = true; S.submits = [];
    tq = xFor(svc, 'hf:kling-3-0', { start: { abs: img, kind: 'image' } }, { 'hf.tier': 'std' });
    setTimeout(() => tq.ctrl.abort(), 300);
    rq = await cloudExec.run(tq.x).then(() => null, (e) => e);
    ok(rq && /un calcul a peut-être été lancé/.test(rq.message) && S.submits.length === 2,
      'coupure, annulé, et toujours pas de réponse : « un calcul a peut-être été lancé »', rq && rq.message);
    S.down = false;

    // 429 seulement (rien de créé) : l'annulation reste immédiate, sans dernier envoi (contrôle plus haut : 1 seul envoi)

    // vidéo à réencoder avant l'envoi : marquée comme travail local (un lourd attend sa fin)
    {
      const mov = path.join(dir, 'source.mov');
      fs.copyFileSync(vid, mov);
      const tl = xFor(svc, 'hf:kling-4-0', { video: { abs: mov, kind: 'video' } }, {});
      const seen = [];
      let inside = false;
      tl.x.localWork = async (fn) => { inside = true; try { return await fn(); } finally { inside = false; seen.push('fin'); } };
      tl.x.ffmpeg.run = async (args) => { seen.push(inside ? 'encode-local' : 'encode-libre'); fs.writeFileSync(args[args.length - 1], 'faux mp4'); };
      const rl = await cloudExec.run(tl.x).then((r) => r, (e) => e);
      ok(rl && rl.outputs && seen.join(',') === 'encode-local,fin', 'réencodage d’une vidéo dans x.localWork (le moteur le compte comme travail local)',
        JSON.stringify({ seen, err: rl && rl.message }));
    }

    // Retry-After en date HTTP, ou absent (le corps donne retry_after_seconds)
    const { retryAfter } = require(path.join(ROOT, 'electron', 'cloud.js'));
    ok(retryAfter('7', 30) === 7 && retryAfter(new Date(Date.now() + 20000).toUTCString(), null) >= 19 && retryAfter(null, 30) === 30
      && retryAfter('n’importe quoi', null) === 10 && retryAfter('99999', null) === 600,
    'Retry-After : secondes, date HTTP, corps, défaut 10 s, plafond 10 min');
  }

  console.log('Prix de repli (tarif public de la console)');
  {
    const off = createPrices({ linked: () => false, estimate: async () => { throw new Error('appel interdit sans compte'); } });
    pr = await off.priceOf({ family: 'hf:kling-4-0', params: { 'hf.duration': 10, 'hf.resolution': '1080p' }, ports: [] });
    const pr720 = await off.priceOf({ family: 'hf:kling-4-0', params: { 'hf.duration': 10, 'hf.resolution': '720p' }, ports: [] });
    ok(pr.ok && pr.source === 'public' && pr.approx && pr.usd === 1.645 && pr720.usd === 1.099,
      'sans compte : 10 s de Kling 4.0 ≈ 1,645 $ en 1080p, 1,099 $ en 720p (fourchette publique), marqué « public »', JSON.stringify([pr, pr720]));
    from = await off.fromPrices(['hf:kling-4-0', 'hf:soul', 'hf:inconnu']);
    ok(from['hf:kling-4-0'] === 0.33 && from['hf:soul'] === 0.094 && from['hf:inconnu'] === null
      && from._public.includes('hf:kling-4-0') && from._public.includes('hf:soul'),
    'sans compte : « dès » public (Kling 4.0 : 0,1099 $/s × 3 s ; SOUL : par image), aucun appel', JSON.stringify(from));
    from = await off.fromPrices(['hf:soul-v2']);
    ok(from['hf:soul-v2'] === 0.003 && from._public.includes('hf:soul-v2'),
      'sans compte : SOUL V2 « dès » 0,003 $, marqué public (l’interface doit montrer « ≈ » et 3 décimales)', JSON.stringify(from));
    S.estimates = [];
    from = await createPrices(svc).fromPrices(['hf:kling-4-0']);
    ok(S.estimates.length && S.estimates.every((e) => e.path === 'estimate/kling-video/v4.0/text-to-video') && from['hf:kling-4-0'] === 0.3 && !from._public.length,
      'avec compte : « dès » de Kling 4.0 demandé sur texte → vidéo (sans média), plus sur le montage', JSON.stringify({ from, paths: S.estimates.map((e) => e.path) }));
    S.estimates = [];
    pr = await createPrices(svc).priceOf({ family: 'hf:kling-4-0', params: {}, ports: ['video'], seconds: { video: 12.4 } });
    ok(S.estimates[0] && S.estimates[0].path === 'estimate/kling-video/v4.0/video-edit' && S.estimates[0].body.duration === 12 && pr.ok && pr.source === 'estimate',
      'prix du montage : la durée de la vidéo branchée est passée (12 s)', JSON.stringify(S.estimates[0]));
    pr = await createPrices(svc).priceOf({ family: 'hf:cinema-studio-4-0', params: {}, ports: [] });
    ok(pr.ok && pr.source === 'public' && pr.approx && pr.usd > 0 && /sans donner de prix/.test(pr.why || ''),
      'Higgsfield répond sans montant : le tarif public en repli, avec la raison', JSON.stringify(pr));
  }

  server.close();
  console.log(`\n${pass} contrôles réussis, ${fail} échec(s).`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); server.close(); process.exit(2); });
