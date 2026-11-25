'use strict';
// Banc des identifiants de modèles et de leurs alias (SPEC §7), en Node pur : node tools/test-variants.js
//
// L'id d'un modèle est fait de son chemin absolu : il change quand le dossier du moteur déménage, alors que les
// planches (réglages « lora », « model »), les résultats (run.json) et leurs empreintes gardent l'ancien. Ce banc
// DÉPLACE un faux dossier de moteur et constate : zéro LoRA introuvable, zéro résultat périmé.
//
// - aucun disque réel : de faux LoRA (en-têtes safetensors fabriqués) dans un dossier neuf sous _dev\tmp, effacé à
//   la fin ; le « home » du scan est ce dossier (aucun dossier de l'utilisateur n'est parcouru) ;
// - aucun GPU, aucun ComfyUI : scan({ comfy: false }), faux executors de tools/fixtures/engine/executors, verrou
//   GPU sur un fichier temporaire, adresse de ComfyUI morte (127.0.0.1:9).
// Catalogue et inventaire des versions de LTX 2.5 (Compacte, Pleine, Complète), encodeur de texte assorti, mémoire par
// version, total de mémoire de la machine : faux fichiers de tools/fixtures/variants/fake-engine.js (en-têtes seuls).
// Interface : la règle de place en mémoire partagée (src/js/nodes/memory.js, chargé comme route.js) et les textes
// fr / en des écrans qui montrent la version et la mémoire (mêmes clés des deux côtés, un seul vocabulaire).
// Code de sortie 1 si un contrôle échoue.

const fs = require('node:fs');
const path = require('node:path');

// Faux executors : aucun GPU possible. MIA_NO_GPU=1 (imposé aux agents) ferait refuser les blocs lourds du banc.
delete process.env.MIA_NO_GPU;

const MIA = path.resolve(__dirname, '..');
const ENGINE = path.join(MIA, 'electron', 'engine');
const FIXTURES = path.join(__dirname, 'fixtures', 'engine');
const scanner = require(path.join(MIA, 'electron', 'scanner.js'));
const { scan, resolveIn } = scanner;
const S = scanner._internals;
const R = require(path.join(ENGINE, 'route.js')).rules();
const RULES = require(path.join(MIA, 'electron', 'scanner-rules.js'));
const FK = require(path.join(__dirname, 'fixtures', 'variants', 'fake-engine.js'));
const { register, _internals: I } = require(path.join(ENGINE, 'index.js'));

let failures = 0;
let passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log(`  ok    ${name}`); }
  else { failures++; console.log(`  ÉCHEC ${name}${detail !== undefined ? ` → ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}
const section = (t) => console.log(`\n== ${t}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => JSON.parse(JSON.stringify(v));
const slash = (p) => p.replace(/\\/g, '/');

const BASE = path.join(MIA, '_dev', 'tmp', `variants-${process.pid}`);

// Un LoRA minimal mais plausible (comme tools/test-scanner.js) : matrices lora_A / lora_B de rang 16 sur des blocs
// d'attention de largeur 4096 (signature LTX), rien que l'en-tête compte.
function fakeLora(file, fill) {
  const tensors = {};
  let off = 0;
  const add = (name, shape) => {
    const n = shape.reduce((a, b) => a * b, 1) * 2;
    tensors[name] = { dtype: 'BF16', shape, data_offsets: [off, off + n] };
    off += n;
  };
  for (let b = 0; b < 2; b++) {
    for (const at of ['attn1', 'attn2']) {
      for (const pr of ['to_q', 'to_k']) {
        add(`diffusion_model.transformer_blocks.${b}.${at}.${pr}.lora_A.weight`, [16, 4096]);
        add(`diffusion_model.transformer_blocks.${b}.${at}.${pr}.lora_B.weight`, [4096, 16]);
      }
    }
  }
  const header = Buffer.from(JSON.stringify({ __metadata__: {}, ...tensors }));
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(header.length));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([len, header, Buffer.alloc(off, fill)]));
}

// Le service de Mia (ModelService, scanner.register) lit le « home » de l'utilisateur dans l'environnement : pendant
// `fn`, il pointe sur des dossiers vides du banc (aucun dossier réel parcouru, pas de labo d'entraînement).
async function withFakeHome(fn) {
  const fakeHome = path.join(BASE, 'home');
  const envs = { USERPROFILE: fakeHome, LOCALAPPDATA: path.join(fakeHome, 'local'), APPDATA: path.join(fakeHome, 'roaming'),
    HF_HOME: path.join(fakeHome, 'hf'), OLLAMA_MODELS: path.join(fakeHome, 'ollama'), MIA_NO_LAB: '1' };
  const keep = {};
  for (const [k, v] of Object.entries(envs)) { keep[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
// Attend que le service n'ait plus de scan en cours (celui de démarrage part par setImmediate), puis l'arrête.
async function settle(svc, stop = true) {
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setImmediate(r));
    if (!svc.running) break;
    await svc.running.promise.catch(() => {});
  }
  await svc.machineQueue;
  if (stop) svc.stop();
}
// Un faux ComfyUI pour la SEULE lecture que fait le scanner (GET /system_stats, /models, /models/<dossier>) : un
// petit serveur local du banc, sur un port libre. Rien d'autre n'est servi ; ce n'est pas le ComfyUI de la machine.
function fakeComfy(vramTotal) {
  const http = require('node:http');
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    const body = req.url === '/system_stats'
      ? { system: { comfyui_version: '0.0.0-banc', argv: [] }, devices: [{ name: 'cuda:0 NVIDIA N1X : cudaMallocAsync', vram_total: vramTotal, vram_free: vramTotal }] }
      : [];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, seen,
    close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }),
  })));
}

// ------------------------------------------------------------------ 1. alias : fonctions pures
function testAliasIds() {
  section('Alias d’un id : le même chemin relatif sous chaque ancien dossier du moteur');
  const env = (engineRoot, formers) => S.makeEnv({ engineRoot, formerEngineRoots: formers, home: BASE });
  // Un déménagement du dossier du moteur (cas étudié le 18/11/2026, nom du fichier changé ici) : le moteur est passé
  // de OLD à NOW, et 95 réglages « lora » de planches portaient l'ancien id d'un fichier comme celui ci-dessous.
  const NOW = 'C:/IA/moteur';
  const OLD = 'D:/AI_Local_Videos';
  const OTHER = 'E:/Mia-moteur';
  const REL = 'models/loras/perso_qwenimage21.safetensors';
  const back = (p) => p.replace(/\//g, '\\');
  const now = env(NOW, [OLD]);
  const lora = `${NOW}/${REL}`;
  check('id d’aujourd’hui = sha1(chemin en minuscules)[:12]', S.modelId(lora) === 'dd6c1e727082', S.modelId(lora));
  check('alias = l’id du même fichier sous l’ancien dossier', JSON.stringify(S.aliasIds(lora, now)) === '["7f0fdf6f2b7f"]', S.aliasIds(lora, now));
  check('alias = modelId(<ancien dossier>/<chemin relatif>)', S.aliasIds(lora, now)[0] === S.modelId(`${OLD}/${REL}`));
  check('« \\ », casse et « / » final ne changent rien', JSON.stringify(S.aliasIds(back(lora).toUpperCase(),
    env(`${back(NOW)}\\`, [`${back(OLD).toLowerCase()}\\`]))) === '["7f0fdf6f2b7f"]');
  check('un dossier-modèle (diffusers) a son alias comme un fichier', S.aliasIds(`${NOW}/models/diffusers/qwen`, now)[0] === S.modelId(`${OLD}/models/diffusers/qwen`));
  const vsr = 'env/venv/Lib/site-packages/nvvfx/libs/nvngx_vsr.dll';
  check('tout le dossier du moteur déménage : un moteur livré dans env\\ a son alias aussi', S.aliasIds(`${NOW}/${vsr}`, now)[0] === S.modelId(`${OLD}/${vsr}`));
  check('hors du dossier du moteur (dossier de LoRA de l’utilisateur, dossier voisin, le dossier lui-même) : aucun alias',
    S.aliasIds(`${OTHER}/mara.safetensors`, now).length === 0 && S.aliasIds(`${NOW}-bis/${REL}`, now).length === 0 && S.aliasIds(NOW, now).length === 0);
  check('sans ancien dossier : aucun alias', S.aliasIds(lora, env(NOW, [])).length === 0 && S.aliasIds(lora, env(NOW)).length === 0);
  const two = env(NOW, [OTHER, OLD]);
  check('plusieurs anciens dossiers : un alias chacun, dans l’ordre des préférences (aliases[i] ↔ formerEngineRoots[i])',
    JSON.stringify(S.aliasIds(lora, two)) === JSON.stringify([S.modelId(`${OTHER}/${REL}`), '7f0fdf6f2b7f']), S.aliasIds(lora, two));
  check('ancien dossier à la racine d’un disque', S.aliasIds(lora, env(NOW, [OTHER.slice(0, 3)]))[0] === S.modelId(`${OTHER.slice(0, 2)}/${REL}`));
  check('valeurs absurdes dans les préférences : ignorées', S.makeEnv({ engineRoot: NOW, formerEngineRoots: [null, 42, '', '  ', OTHER], home: BASE }).formerRoots.join() === OTHER
    && S.makeEnv({ engineRoot: NOW, formerEngineRoots: OTHER, home: BASE }).formerRoots.length === 0);

  const models = [
    { id: 'aaaaaaaaaaaa', aliases: ['bbbbbbbbbbbb', 'cccccccccccc'] },
    { id: 'dddddddddddd', aliases: ['eeeeeeeeeeee', 'aaaaaaaaaaaa'] },      // son 2e alias est l'id d'un vrai modèle
    { id: 'ffffffffffff', aliases: ['bbbbbbbbbbbb'] },                       // alias déjà pris : le premier modèle gagne
    { id: '000000000000', aliases: [] }, { id: '111111111111' },
  ];
  const table = S.aliasTable(models);
  check('table des alias : alias → id d’aujourd’hui', table.bbbbbbbbbbbb === 'aaaaaaaaaaaa' && table.cccccccccccc === 'aaaaaaaaaaaa' && table.eeeeeeeeeeee === 'dddddddddddd', table);
  check('un alias égal à l’id d’un vrai modèle n’est pas dans la table (l’id réel gagne)', !('aaaaaaaaaaaa' in table) && Object.keys(table).length === 3, table);
}

// ------------------------------------------------------------------ 2. le dossier du moteur déménage
async function testMove() {
  section('Déménagement du dossier du moteur : faux moteur scanné, déplacé, rescanné');
  const A = path.join(BASE, 'moteur-avant');
  const B = path.join(BASE, 'moteur-apres');
  const C = path.join(BASE, 'moteur-encore-apres');
  const mine = path.join(BASE, 'mes-loras');
  fakeLora(path.join(A, 'models', 'loras', 'mara_ltx25.safetensors'), 1);
  fakeLora(path.join(A, 'models', 'loras', 'lieux', 'quai_ltx25.safetensors'), 2);
  fakeLora(path.join(mine, 'style_film.safetensors'), 3);
  const scanAt = async (root, formers) => (await scan({
    engineRoot: root, formerEngineRoots: formers, loraFolders: [mine], comfy: false, writeCache: false,
    home: path.join(BASE, 'home'), localAppData: path.join(BASE, 'home', 'local'), appData: path.join(BASE, 'home', 'roaming'),
  })).inventory;
  const lorasOf = (inv) => inv.models.filter((m) => (m.caps || []).includes('lora') && m.status === 'ready');
  const named = (inv, name) => inv.models.find((m) => m.file === name);

  const invA = await scanAt(A, []);
  const refs = { mara: named(invA, 'mara_ltx25.safetensors'), quai: named(invA, 'quai_ltx25.safetensors'), style: named(invA, 'style_film.safetensors') };
  check('avant : 3 LoRA prêts (2 du moteur, 1 d’un dossier de l’utilisateur)', lorasOf(invA).length === 3 && !!refs.mara && !!refs.quai && !!refs.style,
    invA.models.map((m) => `${m.file}:${m.status}:${(m.caps || []).join('+')}`));
  if (!refs.mara || !refs.quai || !refs.style) return null;
  check('avant : aucun alias (aucun ancien dossier connu)', invA.formerRoots === 0 && Object.keys(invA.aliases).length === 0 && invA.models.every((m) => Array.isArray(m.aliases) && !m.aliases.length));
  const old = { mara: refs.mara.id, quai: refs.quai.id, style: refs.style.id };

  fs.renameSync(A, B);                                     // le déménagement
  const invB0 = await scanAt(B, []);
  const lost0 = Object.values(old).filter((id) => !resolveIn(invB0, id, ['lora']));
  check('témoin — sans ancien dossier connu, les 2 LoRA du moteur sont introuvables (le défaut que les alias réparent)',
    lost0.length === 2 && lost0.includes(old.mara) && lost0.includes(old.quai), lost0);

  const invB = await scanAt(B, [A]);
  const mB = { mara: named(invB, 'mara_ltx25.safetensors'), quai: named(invB, 'quai_ltx25.safetensors'), style: named(invB, 'style_film.safetensors') };
  check('après : les ids des LoRA du moteur ont changé, celui du dossier de l’utilisateur non', mB.mara.id !== old.mara && mB.quai.id !== old.quai && mB.style.id === old.style);
  check('après : chaque LoRA du moteur porte son ancien id en alias', JSON.stringify(mB.mara.aliases) === JSON.stringify([old.mara])
    && JSON.stringify(mB.quai.aliases) === JSON.stringify([old.quai]) && mB.style.aliases.length === 0, [mB.mara.aliases, mB.quai.aliases, mB.style.aliases]);
  check('inventaire : table alias → id, nombre d’anciens dossiers', invB.formerRoots === 1 && invB.aliases[old.mara] === mB.mara.id && invB.aliases[old.quai] === mB.quai.id
    && Object.keys(invB.aliases).length === 2, invB.aliases);
  const lost = Object.values(old).filter((id) => !resolveIn(invB, id, ['lora']));
  check('ZÉRO LoRA introuvable : chaque ancien id résout vers le LoRA d’aujourd’hui', lost.length === 0
    && resolveIn(invB, old.mara, ['lora']).id === mB.mara.id && resolveIn(invB, old.quai, ['lora']).id === mB.quai.id && resolveIn(invB, old.style, ['lora']).id === old.style, lost);
  check('la même résolution partout : findModel (écran, moteur) et resolveIn (scanner)', R.findModel(invB, old.mara) === mB.mara && R.findModel(invB, mB.mara.id) === mB.mara
    && R.findModel(invB, slash(path.join(B, 'models', 'loras', 'mara_ltx25.safetensors'))) === mB.mara
    && resolveIn(invB, path.join(B, 'models', 'loras', 'lieux', 'quai_ltx25.safetensors'), ['lora']).id === mB.quai.id
    && resolveIn(invB, 'mara_ltx25.safetensors', ['lora']).id === mB.mara.id);
  check('resolveIn garde ses refus : capacité demandée absente, « none », id inconnu', resolveIn(invB, old.mara, ['image-to-video']) === null
    && resolveIn(invB, 'none', ['lora']) === null && resolveIn(invB, '0123456789ab', ['lora']) === null && resolveIn(invB, 'auto', ['lora']) === null);
  check('l’inventaire reste sérialisable (cache models-cache.json) et se relit pareil', R.findModel(clone(invB), old.quai).id === mB.quai.id);

  // De bout en bout par le SERVICE de Mia (ce que l'application fait vraiment) : la préférence formerEngineRoots doit
  // arriver jusqu'au scan. Sans elle aucun modèle n'a d'alias, et tout ce que les alias réparent est perdu.
  const svcAt = (formers, name) => new scanner.ModelService({ paths: { data: path.join(BASE, 'data-svc', name) }, send: () => {}, logger: () => () => {},
    prefs: { get: async () => ({ engineRoot: B, ...(formers ? { formerEngineRoots: formers } : {}), loraFolders: [mine], comfyUrl: 'http://127.0.0.1:9' }) } });
  await withFakeHome(async () => {
    const svc = svcAt([A], 'avec');
    try {
      svc.loadCacheSync();
      const inv = await svc.scan();
      check('service de Mia, préférence formerEngineRoots = [ancien dossier] : l’inventaire du service porte les alias', inv.formerRoots === 1
        && inv.aliases[old.mara] === mB.mara.id && inv.aliases[old.quai] === mB.quai.id && svc.inventory === inv, [inv.formerRoots, inv.aliases]);
      check('service de Mia : findModel(ancien id) rend le LoRA du nouveau dossier (et resolveIn aussi)', !!svc.findModel(old.mara) && svc.findModel(old.mara).id === mB.mara.id
        && svc.findModel(old.quai).id === mB.quai.id && resolveIn(svc.inventory, old.mara, ['lora']).id === mB.mara.id);
    } finally { await settle(svc); }
    const bare = svcAt(null, 'sans');
    try {
      bare.loadCacheSync();
      const inv0 = await bare.scan();
      check('témoin — service sans la préférence : aucun alias, l’ancien id ne désigne plus rien', inv0.formerRoots === 0 && Object.keys(inv0.aliases).length === 0 && bare.findModel(old.mara) === null);
    } finally { await settle(bare); }
  });

  return { A, B, C, mine, old, invA, invB, invB0, scanAt, named };
}

// ------------------------------------------------------------------ 3. les résultats d'avant restent à jour
async function testRuns(mv) {
  section('Résultats faits avant le déménagement : toujours à jour après (moteur de Mia, faux executors)');
  const { A, B, C, old, invA, invB, invB0, scanAt, named } = mv;
  const projectDir = path.join(BASE, 'Projet');
  const lockPath = path.join(BASE, 'verrou', 'runtime', 'gpu.lock');
  fs.mkdirSync(path.join(projectDir, 'media'), { recursive: true });
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'media', 'a.png'), 'png');
  fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify({ id: 'p_test', name: 'Projet', version: 1 }));
  globalThis.__miaTest = { log: [], cfg: {}, lockPath: () => lockPath };
  const T = globalThis.__miaTest;

  // L'inventaire courant du faux scanner : celui du scan (LoRA réels du faux moteur) ; le modèle de base est un
  // fichier du moteur lui aussi, fait par les mêmes fonctions (id + alias), pour que son id change avec le dossier.
  let cur = { inv: invA, root: A, formers: [] };
  const baseModel = (cap) => {
    const p = slash(path.join(cur.root, 'models', 'diffusion_models', `faux-${cap}.safetensors`));
    return { id: S.modelId(p), aliases: S.aliasIds(p, S.makeEnv({ engineRoot: cur.root, formerEngineRoots: cur.formers, home: BASE })),
      path: p, file: path.basename(p), label: { fr: 'Faux modèle', en: 'Fake model' }, status: 'ready' };
  };
  const handlers = new Map();
  const ctx = {
    app: null,
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    getWin: () => null,
    send: () => {},
    paths: { data: path.join(BASE, 'data'), logs: path.join(BASE, 'data', 'logs'), root: MIA, python: path.join(MIA, 'python') },
    prefs: { get: async () => ({ lang: 'fr', engineRoot: path.join(BASE, 'verrou'), comfyUrl: 'http://127.0.0.1:9' }), set: async () => ({}) },
    store: {
      projectDir: (id) => (id === 'p_test' ? projectDir : null),
      projectById: (id) => (id === 'p_test' ? { id, name: 'Projet', dir: projectDir } : null),
    },
    ffmpeg: {
      probe: async (abs) => ({ kind: /\.mp4$/i.test(abs) ? 'video' : 'image', w: 4, h: 4, fps: 24, frames: 10, duration: 0.42,
        codec: 'fake', pixfmt: 'rgb24', alpha: false, hasAudio: false, playable: true }),
      poster: async (src, dst) => { fs.writeFileSync(dst, 'jpg'); return dst; },
    },
    models: {
      list: () => cur.inv.models.slice(),
      resolve: (value, caps) => ((caps || []).includes('lora') ? resolveIn(cur.inv, value, caps) : baseModel((caps || [])[0] || 'x')),
      find: (ref) => R.findModel(cur.inv, ref),
      inventory: () => cur.inv,
      ensureLora: async (entry) => ({ comfyName: `mia/${entry.id}.safetensors` }),
    },
    trashItem: async (p) => { fs.rmSync(p, { recursive: true, force: true }); },
    engineOpts: {
      lockPath: () => lockPath,
      journalFile: path.join(BASE, 'data', 'engine-runs.json'),
      executorsDir: path.join(FIXTURES, 'executors'),
      timingsFile: path.join(BASE, 'data', 'timings.json'),
      retryMs: 200, renewMs: 120, noStatusPoll: true, checkComfyQueue: false, noTempSweep: true,
    },
  };
  const engine = register(ctx);
  const events = [];
  engine.on('event', (e) => events.push(e));
  await engine.ready;
  const waitEnd = (jobId) => new Promise((resolve, reject) => {
    if (!jobId) { reject(new Error('run refusé : aucun jobId')); return; }
    const done = (e) => e.jobId === jobId && ['done', 'error', 'cancelled'].includes(e.kind);
    const hit = events.find(done);
    if (hit) { resolve(hit); return; }
    const t = setTimeout(() => { engine.off('event', on); reject(new Error(`délai dépassé : fin de ${jobId}`)); }, 10000);
    function on(e) { if (done(e)) { clearTimeout(t); engine.off('event', on); resolve(e); } }
    engine.on('event', on);
  });
  const idle = async () => { const until = Date.now() + 10000; while (engine.jobs.size && Date.now() < until) await wait(20); };

  // Une planche : trois « Animer une image » (un par LoRA, la planche garde l'id du moment), chacun suivi d'un
  // Redimensionner ; les trois se rejoignent dans une Séquence, le bloc qu'on lance.
  const graph = {
    version: 1, camera: { x: 0, y: 0, z: 1 }, groups: [],
    nodes: [{ id: 'n_imp', type: 'import', x: 0, y: 0, params: {}, data: { src: 'media/a.png', kind: 'image', name: 'a.png', meta: { w: 4, h: 4 } } },
      { id: 'n_seq', type: 'sequence', x: 1200, y: 0, params: {} }],
    edges: [],
  };
  const KEYS = ['mara', 'quai', 'style'];
  KEYS.forEach((k, i) => {
    graph.nodes.push({ id: `n_i_${k}`, type: 'i2v', x: 400, y: i * 300, params: { prompt: `plan ${k}`, lora: old[k] } },
      { id: `n_r_${k}`, type: 'resize', x: 800, y: i * 300, params: {} });
    graph.edges.push({ id: `e1${k}`, from: { node: 'n_imp', port: 'out' }, to: { node: `n_i_${k}`, port: 'start' } },
      { id: `e2${k}`, from: { node: `n_i_${k}`, port: 'video' }, to: { node: `n_r_${k}`, port: 'media' } },
      { id: `e3${k}`, from: { node: `n_r_${k}`, port: 'out' }, to: { node: 'n_seq', port: 'clips' } });
  });
  const invoke = (ch, ...a) => handlers.get(ch)({ sender: null }, ...a);
  const run = (nodeId) => invoke('engine:run', { projectId: 'p_test', nodeId, graph: clone(graph) });
  const runDirs = (nodeId) => { try { return fs.readdirSync(path.join(projectDir, 'outputs', nodeId)); } catch { return []; } };
  const upstream = () => KEYS.flatMap((k) => [`n_i_${k}`, `n_r_${k}`]);
  const versions = () => upstream().map((id) => runDirs(id).length).join('');
  // Lance la Séquence et compte ce qui a dû être refait en amont (un résultat périmé = un bloc d'amont recalculé).
  const stale = async () => {
    T.log.length = 0;
    const r = await run('n_seq');
    if (!r.ok) return { refused: r.error };
    const end = await waitEnd(r.jobId);
    await idle();
    return { kind: end.kind, redone: T.log.filter((x) => x.nodeId !== 'n_seq').map((x) => x.nodeId) };
  };

  try {
    let s = await stale();
    check('avant : la planche se calcule (3 animations, 3 redimensionnements, la séquence)', s.kind === 'done' && s.redone.length === 6 && versions() === '111111', s);
    s = await stale();
    check('avant : relancée, rien n’est périmé', s.kind === 'done' && s.redone.length === 0, s);

    cur = { inv: invB0, root: B, formers: [] };
    const planner0 = new I.Planner(engine, { id: 'p_test', dir: projectDir, name: 'Projet' }, clone(graph), 'fr');
    const sp0 = await planner0.spec(planner0.nodes.get('n_i_mara'), engine.types.get('i2v'), 'final', []);
    check('témoin — sans ancien dossier connu : « LoRA choisi… n’est plus disponible »', /LoRA choisi pour « Animer une image » n’est plus disponible/.test(String(sp0.error)), sp0.error);

    cur = { inv: invB, root: B, formers: [A] };
    s = await stale();
    check('ZÉRO résultat périmé après le déménagement : aucun bloc d’amont recalculé', s.kind === 'done' && s.redone.length === 0 && versions() === '111111', s);
    for (const k of ['mara', 'quai']) graph.nodes.find((n) => n.id === `n_i_${k}`).params.lora = named(invB, `${k}_ltx25.safetensors`).id;
    s = await stale();
    check('planche réécrite avec les ids d’aujourd’hui : toujours rien de périmé', s.kind === 'done' && s.redone.length === 0 && versions() === '111111', s);
    for (const k of ['mara', 'quai']) graph.nodes.find((n) => n.id === `n_i_${k}`).params.lora = old[k];

    // un calcul fait APRÈS le déménagement (nouveau réglage), puis un second déménagement : deux anciens dossiers
    graph.nodes.find((n) => n.id === 'n_i_mara').params.prompt = 'plan mara, de nuit';
    s = await stale();
    check('un réglage changé recalcule ce bloc et son aval seulement', s.kind === 'done' && s.redone.slice().sort().join() === 'n_i_mara,n_r_mara' && versions() === '221111', s);
    await idle();
    fs.renameSync(B, C);
    const invC = await scanAt(C, [B, A]);
    const mC = named(invC, 'mara_ltx25.safetensors');
    check('second déménagement : deux alias par LoRA du moteur, le plus récent d’abord', invC.formerRoots === 2
      && JSON.stringify(mC.aliases) === JSON.stringify([named(invB, 'mara_ltx25.safetensors').id, old.mara]) && Object.keys(invC.aliases).length === 4, mC.aliases);
    cur = { inv: invC, root: C, formers: [B, A] };
    s = await stale();
    check('ZÉRO résultat périmé : les versions faites sous le 1er ET sous le 2e dossier sont reconnues', s.kind === 'done' && s.redone.length === 0 && versions() === '221111', s);

    cur = { inv: await scanAt(C, [B]), root: C, formers: [B] };      // le plus ancien dossier oublié
    s = await stale();
    check('témoin — un ancien dossier oublié : ses LoRA ne résolvent plus (refus, pas un rendu sans eux)', !!s.refused && /n’est plus disponible/.test(s.refused), s);
  } finally {
    await idle();
    try { engine.shutdown && engine.shutdown(); } catch { /* déjà arrêté */ }
  }
}

// ------------------------------------------------------------------ 4. catalogue : précision et distillation
function testCatalog() {
  section('Catalogue : la précision lue dans l’en-tête et la distillation décident de l’entrée');
  const view = (name, quantClass, extra = {}) => ({ family: 'LTX-2.x', role: 'diffusion_model', rule: 'ltx2_av', flags: [],
    nameLow: name.toLowerCase(), pathLow: `m:/moteur/models/diffusion_models/${name}`.toLowerCase(), isBundle: false, quantClass, ...extra });
  const w = { family: 'LTX-2.x', role: 'diffusion_model' };
  check('critères absents : comme avant (la précision de la vue n’entre pas en compte)', S.matchWhen(w, view('a.safetensors', 'full'))
    && S.matchWhen(w, view('a.safetensors', 'compact')) && S.matchWhen(w, view('a.safetensors', null)) && S.matchWhen(w, view('a.safetensors', undefined))
    && !S.matchWhen({ ...w, role: 'vae' }, view('a.safetensors', 'full')) && !S.matchWhen({ ...w, name: /int8/ }, view('a.safetensors', 'full')));
  check('quantClass « full » : vrai pour un fichier plein, faux pour un compact, un RTX 50 ou une précision illisible',
    S.matchWhen({ ...w, quantClass: 'full' }, view('a.safetensors', 'full')) && !S.matchWhen({ ...w, quantClass: 'full' }, view('a.safetensors', 'compact'))
    && !S.matchWhen({ ...w, quantClass: 'full' }, view('a.safetensors', 'ultra')) && !S.matchWhen({ ...w, quantClass: 'full' }, view('a.safetensors', null)));
  check('notName : ce que le nom ne doit pas dire', S.matchWhen({ ...w, notName: /distill/ }, view('ltx-dev.safetensors', 'full'))
    && !S.matchWhen({ ...w, notName: /distill/ }, view('ltx-distilled.safetensors', 'full'))
    && S.matchWhen({ ...w, name: /dev/, notName: /distill/ }, view('ltx-dev.safetensors', 'full')) && !S.matchWhen({ ...w, name: /dev/, notName: /distill/ }, view('ltx-distilled-dev.safetensors', 'full')));

  const key = (name, qc) => { const c = S.catalogFor(view(name, qc)); return c ? c.key : null; };
  check('LTX distillé int8 → ltx-int8', key(FK.FILE.int8, 'compact') === 'ltx-int8', key(FK.FILE.int8, 'compact'));
  check('LTX distillé nvfp4 → ltx-nvfp4', key(FK.FILE.nvfp4, 'ultra') === 'ltx-nvfp4', key(FK.FILE.nvfp4, 'ultra'));
  check('LTX distillé bf16 → ltx-full', key(FK.FILE.full, 'full') === 'ltx-full', key(FK.FILE.full, 'full'));
  check('LTX « dev » bf16 ET « dev » int8 → ltx-dev (un dev compressé ne tombe plus dans ltx-int8)',
    key(FK.FILE.dev, 'full') === 'ltx-dev' && key(FK.FILE.devInt8, 'compact') === 'ltx-dev', [key(FK.FILE.dev, 'full'), key(FK.FILE.devInt8, 'compact')]);
  check('« dev » se lit comme un mot : « devil », « developed » ne sont pas le modèle complet', key('ltx-2.5-devil-bf16.safetensors', 'full') === 'ltx-other'
    && key('ltx-2.5-developed-bf16.safetensors', 'full') === 'ltx-other'
    && key('ltx-2.5_dev.safetensors', 'full') === 'ltx-dev' && key('dev-ltx-2.5.safetensors', 'full') === 'ltx-dev' && key('ltx2.5.dev.safetensors', 'full') === 'ltx-dev'
    && key('ltx-2.5-distilled-from-dev-bf16.safetensors', 'full') === 'ltx-full');
  // Seul le « dev » de LTX 2.5 est bloqué (D3, le seul essayé) : un « dev » d'une autre génération, ou dont le nom ne
  // dit pas « 2.5 », garde l'entrée d'avant (ltx-other, proposable), quelle que soit sa précision ou son format.
  const OTHER_GEN = [['ltx-2-19b-dev-fp8.safetensors', 'compact'], ['ltx-2-19b-dev-fp8_e4m3fn.safetensors', 'compact'], ['ltx-2.3-22b-dev-fp8.safetensors', 'compact'],
    ['ltx-2.3-22b-dev.safetensors', 'full'], ['ltx-2-19b-dev_Q4_K_M.gguf', 'very'], ['ltx-2-19b-dev_Q4_K_M.gguf', null], ['ltx_dev.safetensors', 'full'], ['dev-ltx.safetensors', 'full']];
  const otherGen = OTHER_GEN.map(([n, q]) => [n, key(n, q)]);
  check('« dev » d’une autre génération (LTX 2.0, 2.3 ; fp8, bf16, gguf) ou sans « 2.5 » dans le nom → ltx-other, comme avant (jamais ltx-dev)',
    otherGen.every(([, k]) => k === 'ltx-other'), otherGen);
  check('l’entrée proposée à ces fichiers n’est ni bloquée ni libellée « LTX 2.5 · Complète »', OTHER_GEN.every(([n, q]) => { const c = S.catalogFor(view(n, q));
    return c && !c.blocked && c.label === null && c.caps.includes('image-to-video') && c.caps.includes('text-to-video'); }));
  check('« dev » de LTX 2.5, toute précision et tout format → ltx-dev', [['ltx-2.5-22b-dev-fp8.safetensors', 'compact'], ['ltx-2.5-22b-dev_Q4_K_M.gguf', 'very'],
    ['LTX-2.5-22B-DEV-transformer-bf16.safetensors', 'full'], ['ltx_2.5_dev.safetensors', null]].every(([n, q]) => key(n, q) === 'ltx-dev'));
  check('bf16 sans « distill » ni « dev » dans le nom → ltx-other (comportement d’avant)', key(FK.FILE.custom, 'full') === 'ltx-other', key(FK.FILE.custom, 'full'));
  check('distillé d’une précision ni int8 ni nvfp4 ni pleine → ltx-other', key('ltx-2.5-22b-distilled-transformer-fp8.safetensors', 'compact') === 'ltx-other');
  check('un nom « bf16 » dont l’en-tête dit compact n’est pas « Pleine » (l’en-tête fait foi)', key(FK.FILE.full, 'compact') === 'ltx-other');
  const cat = (k) => RULES.CATALOG.find((c) => c.key === k);
  // La pleine n'a pas de rang à elle : elle garde celui de « ltx-other » (le tri d'avant), et seul le choix « Auto »
  // selon la mémoire peut la promouvoir, devant une compacte comme devant une autre précision (autoOver).
  check('ordre de préférence : int8, nvfp4, puis autre (puis MiniMax, PAN 2) ; la pleine au rang de « autre » (PREFER_AS), promue par Auto seulement',
    RULES.CAPS.find((c) => c.id === 'text-to-video').prefer.join() === 'ltx-int8,ltx-nvfp4,ltx-other,pan2'
    && RULES.CAPS.find((c) => c.id === 'image-to-video').prefer.join() === 'ltx-int8,ltx-nvfp4,ltx-other,minimax,pan2'
    && RULES.CAPS.find((c) => c.id === '3d-to-real').prefer.join() === 'ltx-int8,ltx-nvfp4,ltx-other'
    && RULES.CAPS.find((c) => c.id === 'guided-video').prefer.join() === 'ltx-int8,ltx-nvfp4,ltx-other,minimax'
    && JSON.stringify(RULES.PREFER_AS) === '{"ltx-full":"ltx-other"}' && RULES.CAPS.every((c) => !c.prefer.includes('ltx-full'))
    && cat('ltx-full').autoOver.join() === 'ltx-int8,ltx-nvfp4,ltx-other');
  check('« Pleine » : mêmes capacités, mêmes pièces et mêmes modes que la compacte (le bloc Modèle les range ensemble)',
    JSON.stringify([cat('ltx-full').caps, cat('ltx-full').condCaps, cat('ltx-full').needs]) === JSON.stringify([cat('ltx-int8').caps, cat('ltx-int8').condCaps, cat('ltx-int8').needs]));
  check('« Complète » : aucune capacité, aucune pièce, une raison fr / en', cat('ltx-dev').caps.length === 0 && !cat('ltx-dev').needs && !cat('ltx-dev').condCaps
    && cat('ltx-dev').blocked.code === 'recipe' && /recette/.test(cat('ltx-dev').blocked.note.fr) && /recipe/.test(cat('ltx-dev').blocked.note.en));
  check('versions nommées par ce qu’elles sont, en français et en anglais', ['compact', 'compact50', 'full', 'complete'].every((k) => RULES.VERSIONS[k].tag.fr && RULES.VERSIONS[k].tag.en
    && RULES.VERSIONS[k].desc.fr && RULES.VERSIONS[k].desc.en) && RULES.VERSIONS.compact.tag.fr === 'Compacte' && RULES.VERSIONS.full.tag.fr === 'Pleine'
    && RULES.VERSIONS.complete.tag.fr === 'Complète (non distillée)' && RULES.QUANT_LABEL.full.fr === 'Pleine' && RULES.QUANT_LABEL.compact.fr === 'Compacte');
  check('mémoire mesurée au catalogue : compacte ≈ 40 Go, pleine ≈ 71 Go, marge de 16 Go, réglages de la mesure',
    cat('ltx-int8').mem.peakGB === 40 && cat('ltx-int8').mem.basis === 'measured' && cat('ltx-nvfp4').mem.peakGB === 40 && cat('ltx-nvfp4').mem.basis === 'measured'
    && cat('ltx-full').mem.peakGB === 71 && cat('ltx-full').mem.basis === 'measured' && RULES.MEM_MARGIN_GB === 16
    && JSON.stringify(RULES.MEM_AT) === '{"w":960,"h":544,"frames":121}');
  check('les valeurs réglées pour 24 Go ne bougent pas (21 et 19 Go)', cat('ltx-int8').vramGB === 21 && cat('ltx-nvfp4').vramGB === 19 && cat('ltx-full').vramGB === null);
}

// ------------------------------------------------------------------ 5. total de mémoire de la machine
function testMachine() {
  section('Machine : un seul total de mémoire, celui de ComfyUI (octets / 2^30), sinon celui déjà connu');
  const stats = { system: { ram_total: 68000000000, comfyui_version: '0.39.2' }, devices: [{ name: 'cuda:0 NVIDIA N1X : cudaMallocAsync', vram_total: 117790000000 }] };
  const mc = S.machineOf(stats);
  check('/system_stats de 117 790 000 000 octets → 109,7 Go (et l’ancien champ vramGB 117,79 gardé)', mc.memGB === 109.7 && mc.vramGB === 117.79 && mc.ramGB === 68 && mc.gpu === 'NVIDIA N1X', mc);
  check('24 Go de carte : 23,9… arrondi à une décimale ; réponse vide : tout à null', S.machineOf({ devices: [{ name: 'cuda:0 X', vram_total: 25757220864 }] }).memGB === 24
    && S.machineOf({}).memGB === null && S.machineOf(null).memGB === null && S.machineOf({ devices: [] }).gpu === null);
  const both = S.machineIn(mc, { memGB: 94, gpu: 'NVIDIA N1X', source: 'smi' });
  check('même carte, nvidia-smi plus petit (94 contre 109,7 : la RAM prêtée par Windows) : le total de nvidia-smi', both.memGB === 94 && both.source === 'smi' && both.vramGB === 117.79 && both.gpu === 'NVIDIA N1X', both);
  const other = S.machineIn(mc, { memGB: 24, gpu: 'Autre carte', source: 'smi' });
  check('autre carte, ou nom inconnu d’un côté : ComfyUI l’emporte', other.memGB === 109.7 && other.source === 'comfy' && S.machineIn(mc, { memGB: 94, source: 'smi' }).memGB === 109.7, other);
  const smi = S.machineIn(undefined, { memGB: 94.04, gpu: 'NVIDIA N1X', source: 'smi' });
  check('ComfyUI éteint : le total déjà connu, à une décimale, avec sa source', smi.memGB === 94 && smi.source === 'smi' && smi.gpu === 'NVIDIA N1X' && smi.vramGB === null && smi.ramGB === null, smi);
  check('un total retenu d’une réponse de ComfyUI garde sa source', S.machineIn(null, { memGB: 109.7, source: 'comfy' }).source === 'comfy');
  const old = S.machineIn({ gpu: 'RTX', vramGB: 25.76, ramGB: 64 }, null);
  check('état de ComfyUI d’avant (sans memGB) : accepté, total inconnu', old.memGB === null && old.source === null && old.vramGB === 25.76 && old.gpu === 'RTX', old);
  check('rien de connu : pas de machine ; total absurde : ignoré', S.machineIn(null, null) === null && S.machineIn(undefined, undefined) === null
    && S.machineIn(null, { memGB: 'beaucoup' }).memGB === null && S.machineIn(null, { memGB: -3 }).memGB === null && S.machineIn(null, { memGB: 0 }).source === null);
}

// ------------------------------------------------------------------ 6. inventaire : versions, pièces, mémoire
async function testVersions() {
  section('Inventaire d’un faux moteur : versions de LTX 2.5, modèle complet reconnu mais pas proposé');
  const dir = (name) => path.join(BASE, 'var', name);
  const scanAt = async (root, extra = {}) => (await scan({
    engineRoot: root, comfy: false, writeCache: false,
    home: path.join(BASE, 'home'), localAppData: path.join(BASE, 'home', 'local'), appData: path.join(BASE, 'home', 'roaming'), ...extra,
  })).inventory;
  const at = (inv, k) => inv.models.find((m) => m.file === FK.FILE[k]);
  const partFile = (m, k) => (m && m.parts && m.parts[k] ? m.parts[k].file : null);
  const VIDEO = ['image-to-video', 'text-to-video', '3d-to-real', 'guided-video'];

  const ALL = FK.buildEngine(dir('tout'), Object.keys(FK.PIECES));
  const inv = await scanAt(ALL);
  const m = Object.fromEntries(Object.keys(FK.PIECES).map((k) => [k, at(inv, k)]));
  check('tous les faux fichiers sont lus', Object.values(m).every(Boolean), Object.keys(m).filter((k) => !m[k]));
  if (!Object.values(m).every(Boolean)) return;
  check('précision lue dans l’en-tête (pas dans le nom)', m.int8.quantClass === 'compact' && m.nvfp4.quantClass === 'ultra' && m.full.quantClass === 'full'
    && m.dev.quantClass === 'full' && m.devInt8.quantClass === 'compact' && m.teInt8.quantClass === 'compact' && m.teFull.quantClass === 'full',
    Object.fromEntries(Object.entries(m).map(([k, x]) => [k, x.quant])));
  check('clés : int8, nvfp4, pleine, complète (bf16 et int8), autre', m.int8.key === 'ltx-int8' && m.nvfp4.key === 'ltx-nvfp4' && m.full.key === 'ltx-full'
    && m.dev.key === 'ltx-dev' && m.devInt8.key === 'ltx-dev' && m.custom.key === 'ltx-other', Object.fromEntries(Object.entries(m).map(([k, x]) => [k, x.key])));
  check('version résolue par le scanner (l’interface ne devine rien par le nom) : étiquette et phrase fr / en',
    m.int8.version.key === 'compact' && m.int8.version.kind === 'compact' && m.int8.version.tag.fr === 'Compacte' && m.int8.version.tag.en === 'Compact'
    && m.nvfp4.version.key === 'compact50' && m.nvfp4.version.kind === 'compact' && m.nvfp4.version.tag.fr === 'Compacte · RTX 50'
    && m.full.version.key === 'full' && m.full.version.kind === 'full' && m.full.version.tag.fr === 'Pleine' && m.full.version.tag.en === 'Full'
    && /bf16/.test(m.full.version.desc.fr) && /bf16/.test(m.full.version.desc.en)
    && m.dev.version.kind === 'complete' && m.dev.version.tag.fr === 'Complète (non distillée)' && m.dev.version.tag.en === 'Complete (not distilled)'
    && m.custom.version === null && m.teInt8.version === null && m.minimax.version === null);
  check('« Pleine » : libellé fr / en, prête, proposable à la main pour les quatre usages vidéo', m.full.label.fr === 'LTX 2.5 · Pleine' && m.full.label.en === 'LTX 2.5 · Full'
    && m.full.status === 'ready' && VIDEO.every((c) => m.full.caps.includes(c) && inv.capabilities[c].options.includes(m.full.id))
    && resolveIn(inv, m.full.id, ['text-to-video']).id === m.full.id && m.full.baseKey === 'ltx' && m.full.blocked === null, [m.full.label, m.full.status, m.full.caps]);
  check('« Auto » ne change pas dans cette étape : la compacte int8 reste le défaut des quatre usages', VIDEO.every((c) => inv.capabilities[c].default === m.int8.id),
    VIDEO.map((c) => inv.capabilities[c].default));
  check('ordre des choix : int8, nvfp4, pleine, autre', inv.capabilities['text-to-video'].options.join() === [m.int8.id, m.nvfp4.id, m.full.id, m.custom.id].join(),
    inv.capabilities['text-to-video'].options.map((id) => inv.models.find((x) => x.id === id).key));
  check('le libellé et la phrase de la compacte gardent « LTX 2.5 » ; la phrase dit « mémoire », plus « mémoire vidéo »', m.int8.label.fr === 'LTX 2.5'
    && /24 Go de mémoire\.$/.test(m.int8.desc.fr) && /24 GB of memory\.$/.test(m.int8.desc.en) && m.nvfp4.label.fr === 'LTX 2.5 · RTX 50');

  // --- le modèle complet (« dev ») : reconnu, nommé, jamais proposé
  for (const [k, d] of [['bf16', m.dev], ['int8', m.devInt8]]) {
    check(`complet ${k} : reconnu et nommé, pas « prêt », aucune capacité, sa raison fr / en`, d.label.fr === 'LTX 2.5 · Complète (non distillée)'
      && d.label.en === 'LTX 2.5 · Complete (not distilled)' && d.status === 'unused' && d.caps.length === 0 && d.default.length === 0
      && d.blocked && d.blocked.code === 'recipe' && /recette de calcul n’est pas validée/.test(d.blocked.note.fr) && /recipe is not validated/.test(d.blocked.note.en)
      && d.statusNote.fr === d.blocked.note.fr && d.statusNote.en === d.blocked.note.en && d.parts === null && d.pairTag === null, [d.status, d.caps, d.blocked, d.statusNote]);
    check(`complet ${k} : rangé avec les modèles vidéo de la bibliothèque, visible`, d.group === 'video' && d.hidden === false, d.group);
    check(`complet ${k} : absent de tous les choix et de tous les défauts`, Object.values(inv.capabilities).every((c) => !c.options.includes(d.id) && c.default !== d.id && c.fast !== d.id));
    check(`complet ${k} : jamais rendu par resolveIn (id, nom de fichier, chemin, avec ou sans capacité demandée)`, resolveIn(inv, d.id, ['text-to-video']) === null
      && resolveIn(inv, d.id, []) === null && resolveIn(inv, d.id) === null && resolveIn(inv, d.file, ['image-to-video']) === null && resolveIn(inv, d.file) === null
      && resolveIn(inv, d.path, ['text-to-video']) === null && resolveIn(inv, d.path.replace(/\//g, '\\'), VIDEO) === null && scanner.selectable(d, []) === false);
    check(`complet ${k} : findModel le rend quand même (pour dire pourquoi il est refusé)`, R.findModel(inv, d.id) === d && R.findModel(inv, d.path) === d && R.findModel(inv, d.id).blocked.code === 'recipe');
  }
  check('le modèle complet ne compte pas comme « LTX installé » à lui seul', (await scanAt(FK.buildEngine(dir('dev-seul'), ['dev', 'teFull', ...FK.LTX_BASE]))).bases.ltx.installed === false
    && inv.bases.ltx.installed === true);
  const alone = await scanAt(dir('dev-seul'));
  check('modèle complet seul : aucune vidéo possible, et « Il manque » ne le présente pas comme un LTX à réparer', VIDEO.every((c) => !alone.capabilities[c].available)
    && alone.missing.filter((x) => x.caps.some((c) => VIDEO.includes(c))).every((x) => !x.model), alone.missing.map((x) => [x.caps, x.model, x.what.fr]));
  check('un bf16 ni distillé ni « dev » garde le comportement d’avant (proposable, sans version)', m.custom.status === 'ready' && m.custom.caps.includes('text-to-video')
    && m.custom.blocked === null && m.custom.label.fr === 'ltx-custom');

  // --- périmètre du blocage « dev » : LTX 2.5 seulement (vrais scans, machine de 24 Go)
  section('Périmètre du modèle complet : le « dev » de LTX 2.5 est bloqué (même en int8), ceux des autres générations non');
  const t24m = { machine: { memGB: 24, gpu: 'Carte de test', source: 'smi' } };
  // (1) le dev 2.5 int8 pour SEUL transformeur : choix assumé (D3) — pas de vidéo LTX, « LTX · détails » incomplet
  const devOnly8 = await scanAt(FK.buildEngine(dir('dev-int8-seul'), ['devInt8', 'teInt8', ...FK.LTX_BASE]), t24m);
  const d8 = at(devOnly8, 'devInt8'), up8 = at(devOnly8, 'upscaler');
  check('dev 2.5 int8 pour seul transformeur : ltx-dev, pas prêt, bloqué « recette », libellé « LTX 2.5 · Complète (non distillée) »', !!d8 && d8.key === 'ltx-dev' && d8.status === 'unused'
    && d8.caps.length === 0 && d8.blocked && d8.blocked.code === 'recipe' && d8.label.fr === 'LTX 2.5 · Complète (non distillée)', d8 && [d8.key, d8.status, d8.caps, d8.blocked]);
  check('dev 2.5 int8 pour seul transformeur : aucun usage vidéo LTX, aucun défaut (voulu, dit au CHANGELOG)', VIDEO.every((c) => devOnly8.capabilities[c].available === false
    && devOnly8.capabilities[c].default === null && devOnly8.capabilities[c].options.length === 0) && devOnly8.bases.ltx.installed === false, VIDEO.map((c) => devOnly8.capabilities[c]));
  check('dev 2.5 int8 pour seul transformeur : « LTX · détails » est incomplet (il lui manque le LTX 2.5 distillé int8, nommé)', !!up8 && up8.key === 'ltx-upscaler' && up8.status === 'incomplete'
    && up8.missingParts.length === 1 && up8.missingParts[0].key === 'ltx-int8' && up8.missingParts[0].file === FK.FILE.int8, up8 && [up8.status, up8.missingParts]);
  // (2) un « dev » d'une autre génération pour seul transformeur : proposable, comme avant ce chantier
  for (const [name, prec] of [['ltx-2.3-22b-dev-fp8.safetensors', 'int8'], ['ltx-2-19b-dev-fp8.safetensors', 'int8'], ['ltx-2.3-22b-dev.safetensors', 'bf16']]) {
    const root = FK.buildEngine(dir(`autre-gen-${name.replace(/\W+/g, '-')}`), ['teInt8', ...FK.LTX_BASE]);
    FK.writeSt(path.join(root, 'models', 'diffusion_models', name), FK.PIECES[prec === 'int8' ? 'int8' : 'full'][2], 90);
    const invO = await scanAt(root, t24m);
    const o = invO.models.find((x) => x.file === name);
    check(`${name} pour seul transformeur : ltx-other, prêt, ni bloqué ni libellé « LTX 2.5 · Complète », défaut des usages vidéo`, !!o && o.key === 'ltx-other' && o.status === 'ready'
      && o.blocked === null && o.version === null && !/Complète|2\.5/.test(o.label.fr) && !/Complete/.test(o.label.en)
      && ['image-to-video', 'text-to-video'].every((c) => invO.capabilities[c].available === true && invO.capabilities[c].default === o.id)
      && resolveIn(invO, 'auto', ['text-to-video']).id === o.id && invO.bases.ltx.installed === true, o && [o.key, o.status, o.label, o.blocked, invO.capabilities['text-to-video']]);
  }

  // --- pièces : toutes gardées, la retenue est déterministe et assortie
  section('Pièces : l’encodeur de texte est assorti à la version, sans dépendre de l’ordre des fichiers');
  const tes = inv.models.filter((x) => x.key === 'ltx-te');
  check('les deux encodeurs de texte sont dans l’inventaire, prêts, avec taille et précision', tes.length === 2 && tes.every((x) => x.status === 'ready' && x.hidden && x.sizeGB > 0)
    && tes.map((x) => x.quantClass).sort().join() === 'compact,full');
  check('(a) compacte int8 + deux Gemma → Gemma int8, aucune marque, aucune note', partFile(m.int8, 'ltx-te') === FK.FILE.teInt8 && m.int8.pairTag === null && m.int8.partNote === null,
    [partFile(m.int8, 'ltx-te'), m.int8.pairTag, m.int8.partNote]);
  check('(a) compacte RTX 50 + deux Gemma → Gemma int8 aussi', partFile(m.nvfp4, 'ltx-te') === FK.FILE.teInt8 && m.nvfp4.pairTag === null && m.nvfp4.partNote === null);
  check('(b) pleine + deux Gemma → Gemma bf16, marque « te:full », aucune note', partFile(m.full, 'ltx-te') === FK.FILE.teFull && m.full.pairTag === 'te:full' && m.full.partNote === null,
    [partFile(m.full, 'ltx-te'), m.full.pairTag, m.full.partNote]);
  check('une pièce porte id, fichier, nom ComfyUI, taille et précision', JSON.stringify(Object.keys(m.full.parts['ltx-te']).sort()) === '["comfyName","file","id","quantClass","sizeGB"]'
    && m.full.parts['ltx-te'].id === m.teFull.id && m.full.parts['ltx-te'].quantClass === 'full' && m.full.parts['ltx-te'].sizeGB === m.teFull.sizeGB
    && m.full.parts['ltx-te'].comfyName === FK.FILE.teFull && m.int8.parts['ltx-te'].quantClass === 'compact' && m.int8.parts['ltx-l2r'].sizeGB === m.l2r.sizeGB
    && 'quantClass' in m.int8.parts['ltx-vae'], m.full.parts['ltx-te']);
  check('(e) le décodeur vidéo et le décodeur audio sont les mêmes pour toutes les versions', [m.int8, m.nvfp4, m.full, m.custom].every((x) => partFile(x, 'ltx-vae') === FK.FILE.vae
    && partFile(x, 'ltx-audio-vae') === FK.FILE.audioVae));
  check('(f) « LTX · détails » : transformeur int8 et Gemma int8, comme avant', m.upscaler.key === 'ltx-upscaler' && m.upscaler.status === 'ready'
    && partFile(m.upscaler, 'ltx-int8') === FK.FILE.int8 && partFile(m.upscaler, 'ltx-te') === FK.FILE.teInt8 && m.upscaler.pairTag === null && m.upscaler.partNote === null,
    m.upscaler.parts);
  check('un « autre » bf16 (hors appariement) garde la pièce de toujours : Gemma int8', partFile(m.custom, 'ltx-te') === FK.FILE.teInt8 && m.custom.pairTag === null && m.custom.partNote === null);

  // (g) mêmes fichiers, autre ordre : on rejoue resolveParts sur l'inventaire remis à neuf, à l'envers puis mélangé
  const replay = (order) => {
    const list = order(clone(inv.models)).map((x) => {
      const c = RULES.CATALOG.find((e) => e.key === x.key) || null;
      const o = { ...x, _cat: c, parts: null, missingParts: [], pairTag: null, partNote: null, caps: c ? [...(c.caps || [])] : x.caps };
      if (o.status === 'incomplete') { o.status = 'ready'; o.statusNote = null; }
      return o;
    });
    S.resolveParts(list, inv.comfy.modelsDir);
    return JSON.stringify(list.map((x) => [x.id, x.status, x.caps, x.parts, x.pairTag, x.partNote]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  };
  const asIs = replay((l) => l);
  const scanned = JSON.stringify(inv.models.map((x) => [x.id, x.status, x.caps, x.parts, x.pairTag, x.partNote]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  check('(g) rejouer l’appariement sur l’inventaire rend ce que le scan a rendu', asIs === scanned);
  check('(g) fichiers présentés à l’envers : mêmes pièces', replay((l) => l.reverse()) === asIs);
  check('(g) encodeurs de texte échangés, transformeurs en dernier : mêmes pièces', replay((l) => [...l.filter((x) => x.key === 'ltx-te').reverse(),
    ...l.filter((x) => x.key !== 'ltx-te' && x.role !== 'diffusion_model'), ...l.filter((x) => x.role === 'diffusion_model').reverse()]) === asIs);

  const C = await scanAt(FK.buildEngine(dir('gemma-int8'), ['int8', 'nvfp4', 'full', 'teInt8', ...FK.LTX_BASE]));
  check('(c) pleine + Gemma int8 seul → Gemma int8, aucune marque, note « encodeur en version compacte » fr / en', at(C, 'full').status === 'ready'
    && partFile(at(C, 'full'), 'ltx-te') === FK.FILE.teInt8 && at(C, 'full').pairTag === null && at(C, 'full').partNote.fr === RULES.NOTES.teCompact.fr
    && at(C, 'full').partNote.en === RULES.NOTES.teCompact.en && /compacte/.test(at(C, 'full').partNote.fr) && /compact/.test(at(C, 'full').partNote.en),
    [partFile(at(C, 'full'), 'ltx-te'), at(C, 'full').pairTag, at(C, 'full').partNote]);
  check('(c) les compactes n’ont ni marque ni note', [at(C, 'int8'), at(C, 'nvfp4')].every((x) => partFile(x, 'ltx-te') === FK.FILE.teInt8 && x.pairTag === null && x.partNote === null));
  const D = await scanAt(FK.buildEngine(dir('gemma-bf16'), ['int8', 'full', 'teFull', ...FK.LTX_BASE]));
  check('(d) compacte + Gemma bf16 seul → Gemma bf16, marque « te:full », note « encodeur en version pleine » fr / en', at(D, 'int8').status === 'ready'
    && partFile(at(D, 'int8'), 'ltx-te') === FK.FILE.teFull && at(D, 'int8').pairTag === 'te:full' && at(D, 'int8').partNote.fr === RULES.NOTES.teFull.fr
    && at(D, 'int8').partNote.en === RULES.NOTES.teFull.en, [partFile(at(D, 'int8'), 'ltx-te'), at(D, 'int8').pairTag, at(D, 'int8').partNote]);
  check('(d) pleine + Gemma bf16 seul → Gemma bf16, marque, aucune note ; « LTX · détails » prend ce qu’il y a', partFile(at(D, 'full'), 'ltx-te') === FK.FILE.teFull
    && at(D, 'full').pairTag === 'te:full' && at(D, 'full').partNote === null && partFile(at(D, 'upscaler'), 'ltx-te') === FK.FILE.teFull);
  const E = await scanAt(FK.buildEngine(dir('sans-gemma'), ['int8', 'full', ...FK.LTX_BASE]));
  check('sans encodeur de texte : les versions sont « incomplètes », la pièce demandée reste le Gemma int8', at(E, 'full').status === 'incomplete' && at(E, 'int8').status === 'incomplete'
    && at(E, 'full').missingParts[0].file === FK.FILE.teInt8 && at(E, 'full').pairTag === null && at(E, 'full').partNote === null, at(E, 'full').missingParts);

  // --- mémoire par version, selon le total de la machine
  section('Mémoire : les compactes montrent leur pic mesuré si la machine a la place (pic + 16 Go) ; la pleine, toujours le sien');
  const memAt = async (total) => {
    const i = await scanAt(ALL, total == null ? {} : { machine: { memGB: total, gpu: 'Carte de test', source: 'smi' } });
    return { inv: i, int8: at(i, 'int8'), nvfp4: at(i, 'nvfp4'), full: at(i, 'full'), dev: at(i, 'dev'), te: at(i, 'teFull'), l2r: at(i, 'l2r') };
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const fileGB = Math.round(m.full.vramGB * 10) / 10;
  // Les compactes au chiffre réglé pour 24 Go. La pleine n'a pas de tel chiffre : dès que le total est connu elle
  // montre son pic mesuré (≈ 71 Go, le même nombre que « Choisir pour moi ») ; total inconnu : d'après le fichier.
  const FULL_PEAK = { gb: 71, basis: 'measured', at: RULES.MEM_AT };
  const small = (x, known = true) => same(x.int8.mem, { gb: 21, basis: 'catalog', at: null }) && same(x.nvfp4.mem, { gb: 19, basis: 'catalog', at: null })
    && same(x.full.mem, known ? FULL_PEAK : { gb: fileGB, basis: 'file', at: null });
  const Mem = loadMemory();
  const fit = (x) => (Mem ? Mem.fitOf(x.full, x.inv.machine ? x.inv.machine.memGB : null) : 'memory.js illisible');
  const big = (x) => same(x.int8.mem, { gb: 40, basis: 'measured', at: RULES.MEM_AT }) && same(x.nvfp4.mem, { gb: 40, basis: 'measured', at: RULES.MEM_AT })
    && same(x.full.mem, { gb: 71, basis: 'measured', at: RULES.MEM_AT });
  check('la pleine n’a pas de valeur fixe au catalogue : taille du fichier + 4', m.full.vramGB === Math.round((m.full.sizeGB + 4) * 100) / 100, m.full.vramGB);
  const t24 = await memAt(24);
  // (39,1 Go + 4 = 43,1 : le chiffre « fichier » du vrai fichier plein ; le faux fichier du banc ne pèse rien)
  check('24 Go : compacte 21 (catalogue), RTX 50 19 (catalogue), pleine ≈ 71 mesurée → « Trop lourd » (comme avant : le vrai fichier l’était déjà à 43,1 Go)',
    small(t24) && fit(t24) === 'over' && Mem.fitOf({ ...t24.full, mem: { gb: 43.1 } }, 24) === 'over', [t24.int8.mem, t24.nvfp4.mem, t24.full.mem, fit(t24)]);
  check('24 Go : machine { memGB 24, source smi }', t24.inv.machine.memGB === 24 && t24.inv.machine.source === 'smi' && t24.inv.machine.gpu === 'Carte de test', t24.inv.machine);
  const t109 = await memAt(109.7);
  check('109,7 Go : compacte ≈ 40 (mesurée le 18/11), RTX 50 ≈ 40 (mesurée), pleine ≈ 71 (mesurée), avec les réglages de la mesure', big(t109), [t109.int8.mem, t109.nvfp4.mem, t109.full.mem]);
  check('94 Go (total de nvidia-smi sur cette machine) : mêmes pics mesurés', big(await memAt(94)));
  const t869 = await memAt(86.9), t87 = await memAt(87);
  check('86,9 Go : la pleine garde ≈ 71 mesurée (« juste »), pas un chiffre « fichier » plus flatteur ; les compactes (40 + 16) ≈ 40', same(t869.full.mem, FULL_PEAK)
    && fit(t869) === 'tight' && t869.int8.mem.gb === 40 && t869.nvfp4.mem.gb === 40, [t869.int8.mem, t869.full.mem, fit(t869)]);
  check('87 Go : ≈ 71 mesurée aussi — aucun saut de chiffre entre 86,9 et 87 Go', same(t87.full.mem, FULL_PEAK) && same(t87.full.mem, t869.full.mem) && fit(t87) === 'tight', [t87.full.mem, fit(t87)]);
  // Entre 48 et 86,9 Go : le même ≈ 71 Go que la ligne « Choisir pour moi : la pleine demande ≈ 71 Go »
  const t48 = await memAt(48), t64 = await memAt(64), t72 = await memAt(72), t80 = await memAt(80);
  check('48, 64, 72 et 80 Go : la pleine ≈ 71 Go mesurée (jamais « ≈ 46 Go » d’après le fichier)', [t48, t64, t72, t80].every((x) => same(x.full.mem, FULL_PEAK)),
    [t48, t64, t72, t80].map((x) => x.full.mem));
  check('48 et 64 Go : « Trop lourd » (son pic dépasse la machine) ; 72 et 80 Go : « juste »', fit(t48) === 'over' && fit(t64) === 'over' && fit(t72) === 'tight' && fit(t80) === 'tight',
    [t48, t64, t72, t80].map(fit));
  check('48 Go : les compactes restent au chiffre du catalogue (40 + 16 > 48) ; 64 et 80 Go : ≈ 40', t48.int8.mem.gb === 21 && t48.nvfp4.mem.gb === 19
    && [t64, t80].every((x) => x.int8.mem.gb === 40 && x.nvfp4.mem.gb === 40), [t48.int8.mem, t64.int8.mem]);
  const auto64 = (await scanAt(ALL, { autoByMemory: true, machine: { memGB: 64, gpu: 'Carte de test', source: 'smi' } }));
  check('64 Go : le chiffre de la ligne de la pleine = celui de « Choisir pour moi » (needGB 71 = mem.gb 71)', auto64.capabilities['text-to-video'].auto.why === 'full-too-big'
    && auto64.capabilities['text-to-video'].auto.needGB === at(auto64, 'full').mem.gb, [auto64.capabilities['text-to-video'].auto, at(auto64, 'full').mem]);
  const t559 = await memAt(55.9), t56 = await memAt(56);
  check('55,9 Go : compacte au chiffre du catalogue ; 56 Go : ≈ 40', t559.int8.mem.gb === 21 && t559.int8.mem.basis === 'catalog' && t559.nvfp4.mem.gb === 19
    && t56.int8.mem.gb === 40 && t56.nvfp4.mem.basis === 'measured', [t559.int8.mem, t56.int8.mem]);
  const t0 = await memAt(null);
  check('total inconnu : les valeurs d’aujourd’hui, et pas de machine dans l’inventaire', small(t0, false) && t0.inv.machine === null, [t0.int8.mem, t0.full.mem, t0.inv.machine]);
  check('m.vramGB ne change jamais avec le total (21, 19, taille + 4)', [t24, t48, t64, t80, t109, t869, t87, t0].every((x) => x.int8.vramGB === 21 && x.nvfp4.vramGB === 19 && x.full.vramGB === m.full.vramGB));
  check('le total ne change ni les choix ni le défaut dans cette étape', [t24, t109, t87, t0].every((x) => VIDEO.every((c) => JSON.stringify(x.inv.capabilities[c]) === JSON.stringify(inv.capabilities[c]))));
  check('modèle complet, pièces et LoRA : une mémoire d’après le fichier, jamais de mesure inventée', [t24, t109].every((x) => x.dev.mem.basis === 'file' && x.dev.mem.at === null
    && x.te.mem.basis === 'file' && x.l2r.mem.basis === 'file') && t109.inv.models.every((x) => x.mem && ['measured', 'derived', 'catalog', 'file'].includes(x.mem.basis)
    && (x.mem.gb == null || x.mem.gb === Math.round(x.mem.gb * 10) / 10)));
  check('memOf (pure) : sans entrée de catalogue, sans total, total en chaîne', same(S.memOf({ vramGB: 3.26 }, null, 109.7), { gb: 3.3, basis: 'file', at: null })
    && same(S.memOf({ vramGB: 21 }, RULES.CATALOG.find((c) => c.key === 'ltx-int8'), undefined), { gb: 21, basis: 'catalog', at: null })
    && S.memOf({ vramGB: 21 }, RULES.CATALOG.find((c) => c.key === 'ltx-int8'), '109.7').gb === 40
    && S.memOf({ vramGB: 21 }, RULES.CATALOG.find((c) => c.key === 'minimax'), 109.7).basis === 'catalog');
  // images mesurées sur la RTX Spark le 19/11/2026, à côté d'un entraînement (SPEC §8.7) : leur pic avec la taille de la
  // mesure (une image : pas de nombre d'images) ; une machine sans la place (pic + 16) garde le chiffre réglé pour 24 Go
  const catKlein = RULES.CATALOG.find((c) => c.key === 'flux2-klein9b'), catQwen = RULES.CATALOG.find((c) => c.key === 'qwen-image21');
  check('memOf (pure), images mesurées : Klein ≈ 29 en 1344 × 768, Qwen-Image 2.1 ≈ 23 en 2720 × 1536 à 94 Go ; 24 Go : 22 et 17 du catalogue',
    same(S.memOf({ vramGB: 22 }, catKlein, 94), { gb: 29, basis: 'measured', at: { w: 1344, h: 768 } })
    && same(S.memOf({ vramGB: 17 }, catQwen, 94), { gb: 23, basis: 'measured', at: { w: 2720, h: 1536 } })
    && same(S.memOf({ vramGB: 22 }, catKlein, 24), { gb: 22, basis: 'catalog', at: null }) && same(S.memOf({ vramGB: 17 }, catQwen, 24), { gb: 17, basis: 'catalog', at: null })
    && catKlein.vramGB === 22 && catQwen.vramGB === 17, [S.memOf({ vramGB: 22 }, catKlein, 94), S.memOf({ vramGB: 17 }, catQwen, 94)]);
  const catFull = RULES.CATALOG.find((c) => c.key === 'ltx-full');
  check('memOf (pure), pleine : pic à tout total connu (24, « 64 », 86,9) ; total inconnu ou illisible, ou fichier hors catalogue → d’après le fichier',
    [24, '64', 86.9, 87, 109.7].every((tot) => same(S.memOf({ vramGB: 43.1 }, catFull, tot), FULL_PEAK))
    && [undefined, null, 'beaucoup', NaN].every((tot) => same(S.memOf({ vramGB: 43.1 }, catFull, tot), { gb: 43.1, basis: 'file', at: null }))
    && same(S.memOf({ vramGB: 43.1, offCatalog: true }, catFull, 109.7), { gb: 43.1, basis: 'file', at: null }));
  const viaComfy = await scanAt(ALL, { comfy: { reachable: false, url: null, folders: {}, listed: [], machine: S.machineOf({ devices: [{ name: 'cuda:0 NVIDIA N1X : x', vram_total: 117790000000 }] }) },
    machine: { memGB: 24, gpu: 'Autre', source: 'smi' } });
  check('le total de ComfyUI l’emporte sur celui déjà connu, dans l’inventaire et pour la mémoire des versions', viaComfy.machine.memGB === 109.7 && viaComfy.machine.source === 'comfy'
    && viaComfy.machine.vramGB === 117.79 && at(viaComfy, 'full').mem.gb === 71, viaComfy.machine);

  // --- D2 : les autres familles ne mentent plus sur un fichier d'une autre précision
  section('Autres familles : un fichier d’une autre précision que celle attendue le dit, sans mémoire fixe fausse');
  check('MiniMax bf16 : même entrée, libellé « MiniMax H3 · Pleine » / « · Full », mémoire d’après le fichier (taille + 4)', m.minimaxFull.key === 'minimax' && m.minimaxFull.offCatalog === true
    && m.minimaxFull.label.fr === 'MiniMax H3 · Pleine' && m.minimaxFull.label.en === 'MiniMax H3 · Full' && m.minimaxFull.vramGB === Math.round((m.minimaxFull.sizeGB + 4) * 100) / 100
    && m.minimaxFull.mem.basis === 'file' && m.minimaxFull.version === null, [m.minimaxFull.label, m.minimaxFull.vramGB, m.minimaxFull.mem]);
  check('MiniMax attendu (int8) : libellé et 21 Go du catalogue inchangés', m.minimax.key === 'minimax' && m.minimax.offCatalog === false && m.minimax.label.fr === 'MiniMax H3'
    && m.minimax.vramGB === 21 && same(m.minimax.mem, { gb: 21, basis: 'catalog', at: null }), [m.minimax.label, m.minimax.vramGB, m.minimax.mem]);
  check('Klein (fichier attendu sans précision dans son nom, bf16 dans l’en-tête) : inchangé', m.klein.key === 'flux2-klein9b' && m.klein.quantClass === 'full' && m.klein.offCatalog === false
    && m.klein.label.fr === 'FLUX.2 Klein 9B' && m.klein.vramGB === 22 && m.klein.mem.basis === 'catalog', [m.klein.label, m.klein.vramGB]);
  check('les versions de LTX ne sont jamais « hors catalogue » (elles ont chacune leur entrée)', [m.int8, m.nvfp4, m.full, m.dev, m.custom].every((x) => x.offCatalog === false));
  // le fichier attendu, sous son nom exact, dont l'en-tête se lit autrement (format de compression mixte) : rien ne bouge
  const oddRoot = dir('nom-attendu');
  FK.writeSt(path.join(oddRoot, 'models', FK.PIECES.minimax[0], FK.PIECES.minimax[1]), FK.PIECES.minimaxFull[2], 7);
  const odd = at(await scanAt(oddRoot), 'minimax');
  check('le fichier attendu sous son nom exact garde libellé et mémoire, quoi que dise son en-tête', odd.quantClass === 'full' && odd.offCatalog === false && odd.label.fr === 'MiniMax H3' && odd.vramGB === 21,
    [odd.quantClass, odd.label, odd.vramGB]);

  // --- D7 : sur une machine de 24 Go sans fichier plein, l'inventaire est celui d'avant, hors champs ajoutés
  section('Machine de 24 Go sans fichier plein : inventaire identique à celui d’avant, hors champs ajoutés');
  const before = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'variants', 'inventaire-24go-avant-e2.json'), 'utf8'));
  const R24 = FK.buildEngine(dir('24go'), ['int8', 'nvfp4', 'teInt8', ...FK.LTX_BASE, 'minimax', 'klein']);
  // seul écart voulu : la phrase de « LTX 2.5 » dit « mémoire » au lieu de « mémoire vidéo » (vocabulaire D6)
  const ltxBefore = before.models.find((x) => x.key === 'ltx-int8');
  check('référence d’avant : la phrase de LTX 2.5 disait « mémoire vidéo »', /mémoire vidéo\.$/.test(ltxBefore.desc.fr) && /video memory\.$/.test(ltxBefore.desc.en));
  delete ltxBefore.desc;
  for (const [name, extra] of [['total inconnu', {}], ['total de 24 Go', { machine: { memGB: 24, gpu: 'RTX', source: 'smi' } }],
    ['24 Go annoncés par ComfyUI', { comfy: { reachable: false, url: null, folders: {}, listed: [], machine: S.machineOf({ devices: [{ name: 'cuda:0 RTX', vram_total: 25757220864 }] }) } }]]) {
    const now24 = FK.normalize(await scanAt(R24, extra), R24);
    const gaps = FK.missingFrom(before, now24);
    check(`${name} : tout ce que rendait le scanner d’avant est rendu à l’identique (modèles, ordre, capacités, « Il manque », pièces)`, gaps.length === 0, gaps.slice(0, 6));
    check(`${name} : chaque modèle porte les champs ajoutés, vides ou au chiffre d’avant`, now24.models.every((x) => ['version', 'mem', 'blocked', 'partNote', 'pairTag', 'offCatalog'].every((k) => k in x)
      && x.blocked === null && x.partNote === null && x.pairTag === null && x.offCatalog === false && x.mem.at === null && ['catalog', 'file'].includes(x.mem.basis)
      && x.mem.gb === Math.round(x.vramGB * 10) / 10), now24.models.filter((x) => x.mem.at !== null || x.pairTag || x.partNote).map((x) => x.file));
  }
}

// ------------------------------------------------------------------ 7. « Auto » selon la mémoire de la machine
async function testAuto() {
  section('« Auto » : la version pleine quand la machine a la place (pic mesuré + 16 Go), sinon le défaut de toujours');
  const dir = (name) => path.join(BASE, 'auto', name);
  const scanAt = async (root, extra = {}) => (await scan({
    engineRoot: root, comfy: false, writeCache: false,
    home: path.join(BASE, 'home'), localAppData: path.join(BASE, 'home', 'local'), appData: path.join(BASE, 'home', 'roaming'), ...extra,
  })).inventory;
  const withTotal = (root, total, extra = {}) => scanAt(root, { autoByMemory: true, ...(total == null ? {} : { machine: { memGB: total, gpu: 'Carte de test', source: 'smi' } }), ...extra });
  const at = (inv, k) => inv.models.find((m) => m.file === FK.FILE[k]);
  const VIDEO = ['image-to-video', 'text-to-video', '3d-to-real', 'guided-video'];
  const MEASURED = ['image-to-video', 'text-to-video'];
  const UNTRIED = ['3d-to-real', 'guided-video'];
  const ALL = FK.buildEngine(dir('tout'), ['int8', 'nvfp4', 'full', 'dev', 'custom', 'teInt8', 'teFull', ...FK.LTX_BASE, 'minimax', 'klein']);

  const plain = await scanAt(ALL);
  const ids = { int8: at(plain, 'int8').id, nvfp4: at(plain, 'nvfp4').id, full: at(plain, 'full').id };
  const order = (inv) => JSON.stringify(Object.fromEntries(Object.entries(inv.capabilities).map(([k, v]) => [k, v.options])));
  check('scan nu (sans « autoByMemory ») : la compacte int8 par défaut, ni « legacyDefault » ni raison', VIDEO.every((c) => plain.capabilities[c].default === ids.int8
    && plain.capabilities[c].auto === null && !('legacyDefault' in plain.capabilities[c])), VIDEO.map((c) => plain.capabilities[c]));
  const nude109 = await scanAt(ALL, { machine: { memGB: 109.7, source: 'smi' } });
  check('scan nu avec un total de 109,7 Go connu : toujours la compacte (Auto ne change que sur demande du service)', VIDEO.every((c) => nude109.capabilities[c].default === ids.int8
    && nude109.capabilities[c].auto === null) && at(nude109, 'full').mem.gb === 71);

  for (const total of [24, 86.9]) {
    const inv = await withTotal(ALL, total);
    check(`${String(total).replace('.', ',')} Go : la compacte reste le défaut des quatre usages, aucun « legacyDefault »`, VIDEO.every((c) => inv.capabilities[c].default === ids.int8
      && !('legacyDefault' in inv.capabilities[c])) && VIDEO.every((c) => at(inv, 'int8').default.includes(c)) && at(inv, 'full').default.length === 0,
      VIDEO.map((c) => inv.capabilities[c].default));
    check(`${String(total).replace('.', ',')} Go : la raison est dite (pleine trop lourde : ≈ 71 Go demandés)`, MEASURED.every((c) => JSON.stringify(inv.capabilities[c].auto)
      === JSON.stringify({ why: 'full-too-big', model: ids.full, needGB: 71, totalGB: total })) && UNTRIED.every((c) => inv.capabilities[c].auto.why === 'full-unmeasured'),
      VIDEO.map((c) => inv.capabilities[c].auto));
    check(`${String(total).replace('.', ',')} Go : mêmes choix, dans le même ordre, que le scan nu`, order(inv) === order(plain));
  }
  for (const total of [87, 94, 109.7]) {
    const inv = await withTotal(ALL, total);
    check(`${String(total).replace('.', ',')} Go : « Auto » prend la pleine pour Animer une image et Vidéo depuis un texte`, MEASURED.every((c) => inv.capabilities[c].default === ids.full
      && inv.capabilities[c].legacyDefault === ids.int8 && JSON.stringify(inv.capabilities[c].auto) === JSON.stringify({ why: 'full-fits', model: ids.full, needGB: 71, totalGB: total })),
      MEASURED.map((c) => inv.capabilities[c]));
    check(`${String(total).replace('.', ',')} Go : la compacte reste le défaut de Photoréaliste et Vidéo guidée (pleine jamais essayée là), la raison est dite`,
      UNTRIED.every((c) => inv.capabilities[c].default === ids.int8 && !('legacyDefault' in inv.capabilities[c])
        && JSON.stringify(inv.capabilities[c].auto) === JSON.stringify({ why: 'full-unmeasured', model: ids.full, needGB: 71, totalGB: total })
        && inv.capabilities[c].options.includes(ids.full)), UNTRIED.map((c) => inv.capabilities[c]));
    check(`${String(total).replace('.', ',')} Go : les défauts portés par les modèles suivent`, JSON.stringify(at(inv, 'full').default.slice().sort()) === JSON.stringify(MEASURED.slice().sort())
      && JSON.stringify(at(inv, 'int8').default.slice().sort()) === JSON.stringify(UNTRIED.slice().sort()), [at(inv, 'full').default, at(inv, 'int8').default]);
    check(`${String(total).replace('.', ',')} Go : mêmes choix, dans le même ordre (seul le défaut change)`, order(inv) === order(plain));
    check(`${String(total).replace('.', ',')} Go : resolveIn « auto » → la pleine ; avec { legacy } → la compacte d’avant ; un choix précis ne bouge pas`,
      resolveIn(inv, 'auto', ['text-to-video']).id === ids.full && resolveIn(inv, null, ['image-to-video']).id === ids.full
      && resolveIn(inv, 'auto', ['text-to-video'], { legacy: true }).id === ids.int8 && resolveIn(inv, '', ['image-to-video'], { legacy: true }).id === ids.int8
      && resolveIn(inv, 'auto', ['3d-to-real']).id === ids.int8 && resolveIn(inv, 'auto', ['3d-to-real'], { legacy: true }).id === ids.int8
      && resolveIn(inv, ids.nvfp4, ['text-to-video'], { legacy: true }).id === ids.nvfp4 && resolveIn(inv, ids.full, ['text-to-video'], { legacy: true }).id === ids.full);
    check(`${String(total).replace('.', ',')} Go : la pleine choisie par Auto est assortie au Gemma plein`, resolveIn(inv, 'auto', ['text-to-video']).pairTag === 'te:full'
      && resolveIn(inv, 'auto', ['text-to-video']).parts['ltx-te'].file === FK.FILE.teFull && resolveIn(inv, 'auto', ['text-to-video'], { legacy: true }).pairTag === null);
    check(`${String(total).replace('.', ',')} Go : les autres usages (image, profondeur, détourage…) n’ont ni raison ni ancien défaut`,
      Object.entries(inv.capabilities).filter(([k]) => !VIDEO.includes(k)).every(([k, v]) => v.auto === null && !('legacyDefault' in v) && v.default === plain.capabilities[k].default));
  }
  const unknown = await withTotal(ALL, null);
  check('total inconnu : la compacte, aucune raison (rien n’est deviné)', VIDEO.every((c) => unknown.capabilities[c].default === ids.int8 && unknown.capabilities[c].auto === null
    && !('legacyDefault' in unknown.capabilities[c])) && resolveIn(unknown, 'auto', ['text-to-video'], { legacy: true }).id === ids.int8);
  const viaComfy = await scanAt(ALL, { autoByMemory: true, machine: { memGB: 24, source: 'smi' },
    comfy: { reachable: false, url: null, folders: {}, listed: [], machine: S.machineOf({ devices: [{ name: 'cuda:0 NVIDIA N1X : x', vram_total: 117790000000 }] }) } });
  check('le total que ComfyUI annonce l’emporte pour Auto aussi (24 connus, 109,7 annoncés → la pleine)', viaComfy.capabilities['text-to-video'].default === ids.full
    && viaComfy.capabilities['text-to-video'].auto.totalGB === 109.7);

  // sans fichier plein : identique à aujourd'hui, quel que soit le total
  const noFull = FK.buildEngine(dir('sans-pleine'), ['int8', 'nvfp4', 'teInt8', ...FK.LTX_BASE, 'minimax', 'klein']);
  const nfPlain = await scanAt(noFull);
  for (const total of [24, 109.7]) {
    const inv = await withTotal(noFull, total);
    check(`sans fichier plein, ${String(total).replace('.', ',')} Go : mêmes défauts et mêmes choix qu’un scan nu, aucune raison`,
      Object.keys(nfPlain.capabilities).every((k) => inv.capabilities[k].default === nfPlain.capabilities[k].default && inv.capabilities[k].auto === null
        && !('legacyDefault' in inv.capabilities[k]) && JSON.stringify(inv.capabilities[k].options.map((id) => inv.models.find((x) => x.id === id).file))
          === JSON.stringify(nfPlain.capabilities[k].options.map((id) => nfPlain.models.find((x) => x.id === id).file))));
  }
  // le modèle complet seul avec une compacte : jamais promu (il n'est pas un choix)
  const devOnly = await withTotal(FK.buildEngine(dir('dev-et-compacte'), ['int8', 'dev', 'teInt8', 'teFull', ...FK.LTX_BASE]), 109.7);
  check('compacte + modèle complet (sans distillé plein), 109,7 Go : Auto reste sur la compacte, le complet n’est jamais un défaut',
    VIDEO.every((c) => devOnly.capabilities[c].default === at(devOnly, 'int8').id && devOnly.capabilities[c].auto === null) && at(devOnly, 'dev').default.length === 0);
  // la version RTX 50 seule + la pleine : la pleine la remplace aussi
  const fifty = await withTotal(FK.buildEngine(dir('rtx50-et-pleine'), ['nvfp4', 'full', 'teInt8', 'teFull', ...FK.LTX_BASE]), 109.7);
  check('RTX 50 + pleine, 109,7 Go : Auto prend la pleine, l’ancien défaut est la RTX 50', fifty.capabilities['text-to-video'].default === at(fifty, 'full').id
    && fifty.capabilities['text-to-video'].legacyDefault === at(fifty, 'nvfp4').id && fifty.capabilities['3d-to-real'].default === at(fifty, 'nvfp4').id);
  // sans Gemma plein : la pleine quand même, avec la note de repli
  const noTe = await withTotal(FK.buildEngine(dir('sans-gemma-plein'), ['int8', 'full', 'teInt8', ...FK.LTX_BASE]), 109.7);
  const picked = resolveIn(noTe, 'auto', ['text-to-video']);
  check('sans Gemma plein, 109,7 Go : Auto prend la pleine quand même, avec la note « encodeur en version compacte » et sans marque d’empreinte',
    picked.id === at(noTe, 'full').id && picked.partNote && picked.partNote.fr === RULES.NOTES.teCompact.fr && picked.pairTag === null
    && picked.parts['ltx-te'].file === FK.FILE.teInt8, [picked.file, picked.partNote, picked.pairTag]);
  // une pleine seule : elle est déjà le défaut, rien à dire
  const fullOnly = await withTotal(FK.buildEngine(dir('pleine-seule'), ['full', 'teFull', ...FK.LTX_BASE]), 24);
  check('la pleine seule (aucune compacte) : elle est le défaut de toujours, même à 24 Go, sans raison', VIDEO.every((c) => fullOnly.capabilities[c].default === at(fullOnly, 'full').id
    && fullOnly.capabilities[c].auto === null && !('legacyDefault' in fullOnly.capabilities[c])));

  // Une « autre précision » (distillé fp8) + la pleine, sans compacte : avant ce chantier les deux étaient des
  // « ltx-other », le plus petit fichier était le défaut. La pleine ne doit passer devant QUE par Auto, quand la
  // machine a la place — et alors l'ancien défaut (legacyDefault) garde à jour les résultats déjà faits.
  const FP8 = 'ltx-2.5-22b-distilled-fp8_scaled.safetensors';
  const fp8Root = FK.buildEngine(dir('fp8-et-pleine'), ['full', 'teInt8', 'teFull', ...FK.LTX_BASE]);
  FK.writeSt(path.join(fp8Root, 'models', 'diffusion_models', FP8), FK.PIECES.int8[2], 91);
  fs.appendFileSync(path.join(fp8Root, 'models', 'diffusion_models', FK.FILE.full), Buffer.alloc(12e6, 7));   // la pleine est le plus gros fichier
  const fp8Of = (inv) => inv.models.find((x) => x.file === FP8);
  const fpPlain = await scanAt(fp8Root);
  check('fp8 + pleine : le fp8 est un « ltx-other » prêt, plus petit que la pleine', !!fp8Of(fpPlain) && fp8Of(fpPlain).key === 'ltx-other' && fp8Of(fpPlain).status === 'ready'
    && at(fpPlain, 'full').key === 'ltx-full' && fp8Of(fpPlain).sizeGB < at(fpPlain, 'full').sizeGB, fp8Of(fpPlain) && [fp8Of(fpPlain).key, fp8Of(fpPlain).sizeGB, at(fpPlain, 'full').sizeGB]);
  check('fp8 + pleine, scan nu : le fp8 reste le défaut des quatre usages (comme avant), ni raison ni « legacyDefault »', VIDEO.every((c) => fpPlain.capabilities[c].default === fp8Of(fpPlain).id
    && fpPlain.capabilities[c].auto === null && !('legacyDefault' in fpPlain.capabilities[c]) && fpPlain.capabilities[c].options.join() === [fp8Of(fpPlain).id, at(fpPlain, 'full').id].join()),
    VIDEO.map((c) => fpPlain.capabilities[c]));
  for (const total of [24, 64, 86.9]) {
    const inv = await withTotal(fp8Root, total);
    check(`fp8 + pleine, ${String(total).replace('.', ',')} Go : le fp8 reste le défaut (la pleine de 71 Go ne devient jamais le défaut sans la place), raison dite`,
      VIDEO.every((c) => inv.capabilities[c].default === fp8Of(inv).id && !('legacyDefault' in inv.capabilities[c]))
      && MEASURED.every((c) => JSON.stringify(inv.capabilities[c].auto) === JSON.stringify({ why: 'full-too-big', model: at(inv, 'full').id, needGB: 71, totalGB: total }))
      && UNTRIED.every((c) => (inv.capabilities[c].auto || {}).why === 'full-unmeasured') && at(inv, 'full').default.length === 0
      && resolveIn(inv, 'auto', ['text-to-video']).id === fp8Of(inv).id, VIDEO.map((c) => inv.capabilities[c]));
  }
  const fpNone = await withTotal(fp8Root, null);
  check('fp8 + pleine, total inconnu : le fp8, aucune raison', VIDEO.every((c) => fpNone.capabilities[c].default === fp8Of(fpNone).id && fpNone.capabilities[c].auto === null));
  const fpBig = await withTotal(fp8Root, 109.7);
  check('fp8 + pleine, 109,7 Go : Auto prend la pleine pour le texte et l’image, « legacyDefault » = le fp8 (ses résultats restent à jour)',
    MEASURED.every((c) => fpBig.capabilities[c].default === at(fpBig, 'full').id && fpBig.capabilities[c].legacyDefault === fp8Of(fpBig).id
      && (fpBig.capabilities[c].auto || {}).why === 'full-fits') && resolveIn(fpBig, 'auto', ['text-to-video']).id === at(fpBig, 'full').id
    && resolveIn(fpBig, 'auto', ['text-to-video'], { legacy: true }).id === fp8Of(fpBig).id, MEASURED.map((c) => fpBig.capabilities[c]));
  check('fp8 + pleine, 109,7 Go : Photoréaliste et Vidéo guidée restent sur le fp8 (pleine jamais essayée là)', UNTRIED.every((c) => fpBig.capabilities[c].default === fp8Of(fpBig).id
    && !('legacyDefault' in fpBig.capabilities[c]) && (fpBig.capabilities[c].auto || {}).why === 'full-unmeasured'), UNTRIED.map((c) => fpBig.capabilities[c]));
  // capabilities (pure), dans les deux ordres d'entrée : le cas exact relevé à la relecture (23,5 Go et 42 Go)
  const pair = (auto, flip) => {
    const mk = (id, key, sizeGB, label) => ({ id, key, sizeGB, label: { fr: label, en: label }, caps: ['image-to-video', 'text-to-video'], status: 'ready', license: 'ok',
      quality: 3, hidden: false, role: 'diffusion_model', engine: 'comfy', default: [], _cat: RULES.CATALOG.find((e) => e.key === key) });
    const list = [mk('fp8fp8fp8fp8', 'ltx-other', 23.5, 'ltx-2.5-22b-distilled-fp8_scaled'), mk('bf16bf16bf16', 'ltx-full', 42, 'LTX 2.5 · Pleine')];
    return S.capabilities(flip ? list.reverse() : list, 'M:/moteur/models', auto).caps['text-to-video'];
  };
  check('capabilities (pure), fp8 23,5 Go + pleine 42 Go : sans total, total nul ou 24 Go → le fp8 ; 109,7 → la pleine avec legacyDefault',
    [undefined, null, { totalGB: 24 }, { totalGB: 86.9 }].every((a) => [false, true].every((f) => pair(a, f).default === 'fp8fp8fp8fp8' && !('legacyDefault' in pair(a, f))
      && pair(a, f).options.join() === 'fp8fp8fp8fp8,bf16bf16bf16'))
    && [false, true].every((f) => pair({ totalGB: 109.7 }, f).default === 'bf16bf16bf16' && pair({ totalGB: 109.7 }, f).legacyDefault === 'fp8fp8fp8fp8'),
    [pair(null, false), pair({ totalGB: 24 }, true), pair({ totalGB: 109.7 }, false)]);

  // capabilities (pure) : total en chaîne, total absurde
  const again = (auto) => {
    const list = clone(plain.models).map((x) => ({ ...x, default: [], _cat: RULES.CATALOG.find((e) => e.key === x.key) || null }));
    return S.capabilities(list, plain.comfy.modelsDir, auto).caps['text-to-video'];
  };
  check('capabilities (pure) : sans 3e argument, null, total nul ou illisible → le défaut de toujours', [undefined, null, {}, { totalGB: null }, { totalGB: 'beaucoup' }]
    .every((a) => again(a).default === ids.int8 && again(a).auto === null) && again({ totalGB: 87 }).default === ids.full && again({ totalGB: '109.7' }).default === ids.full
    && again({ totalGB: 0 }).default === ids.int8);

  // ---------------------------------------------------------------- total retenu d'une session à l'autre
  section('Total de mémoire retenu : le plus petit de ComfyUI et de nvidia-smi pour la même carte, même éteint ; une autre carte efface');
  const M = S.mergeMachine;
  check('rien de lu : aucun total', M(null, null).effective === null && M(undefined, undefined).changed === false && JSON.stringify(M({}, null).stored) === '{"comfy":null,"smi":null}');
  const s1 = M(null, { source: 'smi', memGB: 94.04, gpu: 'NVIDIA N1X', at: 1 });
  check('nvidia-smi 94,0 → total 94 (source smi)', s1.changed && JSON.stringify(s1.effective) === '{"memGB":94,"gpu":"NVIDIA N1X","source":"smi"}' && s1.stored.smi.at === 1, s1);
  const s2 = M(s1.stored, { source: 'comfy', memGB: 109.7, gpu: 'NVIDIA N1X', at: 2 });
  check('puis ComfyUI 109,7 (94 Go du GPU + la RAM prêtée par Windows) → ComfyUI retenu, mais le total reste 94 (source smi)', s2.changed && s2.stored.comfy.memGB === 109.7 && s2.effective.memGB === 94 && s2.effective.source === 'smi', s2);
  check('ComfyUI seul → son total ; ComfyUI plus petit que nvidia-smi → celui de ComfyUI', M(null, { source: 'comfy', memGB: 109.7 }).effective.memGB === 109.7
    && JSON.stringify(M({ smi: { memGB: 24, gpu: 'X' }, comfy: null }, { source: 'comfy', memGB: 23.5, gpu: 'X' }).effective) === '{"memGB":23.5,"gpu":"X","source":"comfy"}');
  const s3 = M(s2.stored, { source: 'smi', memGB: 94, gpu: 'NVIDIA N1X', at: 3 });
  check('puis nvidia-smi 94,0 de la même carte (ComfyUI éteint) → reste 94, rien à écrire', !s3.changed && s3.effective.memGB === 94 && s3.effective.source === 'smi'
    && JSON.stringify(s3.stored) === JSON.stringify(s2.stored), s3);
  const s4 = M(s3.stored, { source: 'smi', memGB: 23.99, gpu: 'NVIDIA GeForce RTX 5090', at: 4 });
  check('nvidia-smi nomme une autre carte → ce que ComfyUI disait est effacé, le total repasse à nvidia-smi', s4.changed && s4.stored.comfy === null
    && JSON.stringify(s4.effective) === '{"memGB":24,"gpu":"NVIDIA GeForce RTX 5090","source":"smi"}', s4);
  check('relire le fichier gardé rend le même total (et ignore ce qui est abîmé)', JSON.stringify(M(clone(s2.stored), null).effective) === JSON.stringify(s2.effective)
    && M({ comfy: { memGB: 'x' }, smi: { memGB: -1 } }, null).effective === null && M('abîmé', null).effective === null && M({ comfy: { memGB: 109.7 } }, null).effective.gpu === null);
  check('lecture sans total, source inconnue : ignorées', !M(s2.stored, { source: 'smi', memGB: 0, gpu: 'X' }).changed && !M(s2.stored, { source: 'autre', memGB: 50 }).changed
    && !M(s2.stored, { source: 'comfy', memGB: null }).changed && M(s2.stored, { source: 'autre', memGB: 50 }).effective.memGB === 94);
  check('ComfyUI écrit autrement le nom de la même carte : rien à écrire ; le nom qui manquait : retenu', !M(s2.stored, { source: 'comfy', memGB: 109.7, gpu: 'NVIDIA N1X : natif' }).changed
    && M({ comfy: { memGB: 109.7 }, smi: null }, { source: 'comfy', memGB: 109.7, gpu: 'NVIDIA N1X' }).stored.comfy.gpu === 'NVIDIA N1X');
  check('ComfyUI redit le même total : rien à écrire ; un autre total : retenu', !M(s2.stored, { source: 'comfy', memGB: 109.7, gpu: 'NVIDIA N1X' }).changed
    && !M(s2.stored, { source: 'comfy', memGB: 109.74 }).changed && M(s2.stored, { source: 'comfy', memGB: 110.2, gpu: 'NVIDIA N1X' }).stored.comfy.memGB === 110.2
    && M(s2.stored, { source: 'comfy', memGB: 90, gpu: 'NVIDIA N1X' }).effective.memGB === 90);

  // le service : machine.json, relecture au démarrage, nouvel inventaire quand le total change
  const data = path.join(BASE, 'auto', 'data');
  fs.mkdirSync(data, { recursive: true });
  // autoByMemory : le service de Mia ne demande PAS « Auto selon la mémoire » par défaut (scanner.js AUTO_BY_MEMORY :
  // mesure du 18/11/2026, la pleine ne se distingue pas de la compacte à l'œil). Ces cas forcent l'option pour
  // prouver le mécanisme de bout en bout ; le défaut réel est prouvé par « service par défaut », plus bas.
  const mkSvc = (auto = true) => {
    const svc = new scanner.ModelService({ paths: { data }, prefs: { get: async () => ({ engineRoot: ALL, comfyUrl: 'http://127.0.0.1:9' }) }, send: () => {}, logger: () => () => {},
      ...(auto ? { autoByMemory: true } : {}) });
    svc.rescans = 0;
    return svc;
  };
  let svc = mkSvc();
  svc.loadCacheSync();
  svc.scan = () => { svc.rescans++; return Promise.resolve(null); };
  check('service neuf : aucun total, aucun fichier', svc.machineNow() === null && !fs.existsSync(path.join(data, 'machine.json')));
  svc.noteMachine({ source: 'smi', memGB: 94, gpu: 'NVIDIA N1X' });
  await svc.machineQueue;
  check('1re lecture (nvidia-smi) : total 94, machine.json écrit, inventaire redemandé', svc.machineNow().memGB === 94 && svc.machineNow().source === 'smi' && svc.rescans === 1
    && JSON.parse(fs.readFileSync(path.join(data, 'machine.json'), 'utf8')).smi.memGB === 94);
  svc.noteMachine({ source: 'smi', memGB: 94, gpu: 'NVIDIA N1X' });
  check('même lecture : rien ne se passe', svc.rescans === 1);
  svc.noteMachine({ source: 'comfy', memGB: 109.7, gpu: 'NVIDIA N1X' });
  svc.noteMachine({ source: 'smi', memGB: 94, gpu: 'NVIDIA N1X' });
  await svc.machineQueue;
  check('ComfyUI annonce 109,7 : retenu, mais le total reste 94 et l’inventaire n’est pas redemandé', svc.machineNow().memGB === 94 && svc.rescans === 1
    && JSON.parse(fs.readFileSync(path.join(data, 'machine.json'), 'utf8')).comfy.memGB === 109.7);
  svc.noteMachine({ source: 'comfy', memGB: 109.7, gpu: 'NVIDIA N1X (autre nom)' }, { rescan: false });
  await svc.machineQueue;
  check('{ rescan: false } (lecture faite par un scan) et total inchangé : pas de nouvel inventaire', svc.rescans === 1);
  svc = mkSvc();
  svc.loadCacheSync();
  check('au démarrage suivant (ComfyUI éteint) : le total est relu du fichier (94, nvidia-smi)', svc.machineNow().memGB === 94 && svc.machineNow().source === 'smi'
    && !fs.readdirSync(data).some((f) => /\.tmp$/.test(f)), fs.readdirSync(data));
  fs.writeFileSync(path.join(data, 'machine.json'), '{ abîmé');
  const broken = mkSvc();
  broken.loadCacheSync();
  check('machine.json illisible : aucun total, aucune erreur', broken.machineNow() === null);
  fs.writeFileSync(path.join(data, 'machine.json'), JSON.stringify(s2.stored));

  // le vrai scan du service (ComfyUI injoignable, dossiers de l'utilisateur remplacés par des dossiers vides) :
  // il donne le total retenu et demande « Auto » selon la mémoire
  const keep = {};
  const fakeHome = path.join(BASE, 'home');
  const envs = { USERPROFILE: fakeHome, LOCALAPPDATA: path.join(fakeHome, 'local'), APPDATA: path.join(fakeHome, 'roaming'),
    HF_HOME: path.join(fakeHome, 'hf'), OLLAMA_MODELS: path.join(fakeHome, 'ollama'), MIA_NO_LAB: '1' };
  for (const [k, v] of Object.entries(envs)) { keep[k] = process.env[k]; process.env[k] = v; }
  const live = mkSvc();
  try {
    live.loadCacheSync();
    const inv = await live.scan();
    check('scan du service, 94 (nvidia-smi) et 109,7 (ComfyUI) retenus : la machine est dans l’inventaire avec 94 (source smi, ComfyUI éteint)', inv.machine && inv.machine.memGB === 94
      && inv.machine.source === 'smi' && inv.comfy.reachable === false, inv.machine);
    check('scan du service : « Auto » prend la pleine pour le texte et l’image, la mémoire des versions est la mesurée', MEASURED.every((c) => inv.capabilities[c].default === ids.full
      && inv.capabilities[c].legacyDefault === ids.int8) && UNTRIED.every((c) => inv.capabilities[c].default === ids.int8) && at(inv, 'full').mem.gb === 71 && at(inv, 'int8').mem.gb === 40,
      VIDEO.map((c) => inv.capabilities[c].auto));
    // ce que le pont des assistants en dit (mia_catalog)
    const { Bridge } = require(path.join(MIA, 'electron', 'bridge.js'));
    for (const lang of ['fr', 'en']) {
      const br = new Bridge({ paths: { root: MIA, data }, models: { inventory: () => inv }, lang: () => lang, prefs: { get: async () => ({}) } });
      const cat = await br.catalog({});
      const t2v = cat.types.find((t) => t.type === 't2v').params.find((p) => p.id === 'model').choices;
      const by = (id) => t2v.find((c) => c.value === id);
      check(`mia_catalog (${lang}) : chaque version porte son nom et sa mémoire estimée`, !!by(ids.int8) && by(ids.int8).version === (lang === 'en' ? 'Compact' : 'Compacte') && by(ids.int8).memoryGB === 40
        && by(ids.nvfp4).version === (lang === 'en' ? 'Compact · RTX 50' : 'Compacte · RTX 50') && by(ids.full).version === (lang === 'en' ? 'Full' : 'Pleine') && by(ids.full).memoryGB === 71
        && by('auto') && !('memoryGB' in by('auto')), t2v);
      check(`mia_catalog (${lang}) : le modèle complet n’est dans aucun choix d’aucun bloc`, cat.types.every((t) => (t.params || []).every((p) => !(p.choices || []).some((c) => c.value === at(inv, 'dev').id
        || /non distillée|not distilled/i.test(String(c.label))))));
      check(`mia_catalog (${lang}) : il figure dans « notOffered », avec sa raison`, cat.notOffered.length === 1 && cat.notOffered[0].label === (lang === 'en' ? 'LTX 2.5 · Complete (not distilled)' : 'LTX 2.5 · Complète (non distillée)')
        && (lang === 'en' ? /recipe is not validated/ : /recette de calcul n’est pas validée/).test(cat.notOffered[0].reason), cat.notOffered);
      check(`mia_catalog (${lang}) : machine.memoryGB, et le défaut de chaque usage avec sa mémoire`, cat.machine.memoryGB === 94
        && cat.capabilities['text-to-video'].default === (lang === 'en' ? 'LTX 2.5 · Full' : 'LTX 2.5 · Pleine') && cat.capabilities['text-to-video'].memoryGB === 71
        && cat.capabilities['3d-to-real'].default === 'LTX 2.5' && cat.capabilities['3d-to-real'].memoryGB === 40, [cat.machine, cat.capabilities['text-to-video'], cat.capabilities['3d-to-real']]);
    }
    // le service tel que Mia le crée (sans option) : « Auto » reste la compacte, même avec 109,7 Go retenus
    const plainSvc = mkSvc(false);
    try {
      plainSvc.loadCacheSync();
      const invP = await plainSvc.scan();
      check('service par défaut, 94 Go retenus : « Auto » = la compacte pour les quatre usages, ni raison ni « legacyDefault » ; la pleine reste un choix, avec sa mémoire mesurée',
        invP.machine && invP.machine.memGB === 94 && VIDEO.every((c) => invP.capabilities[c].default === ids.int8 && invP.capabilities[c].auto === null
          && !('legacyDefault' in invP.capabilities[c]) && invP.capabilities[c].options.includes(ids.full)) && at(invP, 'full').mem.gb === 71 && at(invP, 'int8').mem.gb === 40,
        VIDEO.map((c) => invP.capabilities[c]));
      const catP = await new (require(path.join(MIA, 'electron', 'bridge.js')).Bridge)({ paths: { root: MIA, data }, models: { inventory: () => invP }, lang: () => 'fr', prefs: { get: async () => ({}) } }).catalog({});
      check('service par défaut : mia_catalog annonce « LTX 2.5 » (compacte, ≈ 40 Go) comme défaut du texte vers vidéo', catP.capabilities['text-to-video'].default === 'LTX 2.5'
        && catP.capabilities['text-to-video'].memoryGB === 40, catP.capabilities['text-to-video']);
    } finally { plainSvc.stop(); }
    const bare = await new (require(path.join(MIA, 'electron', 'bridge.js')).Bridge)({ paths: { root: MIA, data }, models: { inventory: () => null }, lang: () => 'fr', prefs: { get: async () => ({}) } }).catalog({});
    check('mia_catalog sans inventaire : machine.memoryGB null, notOffered vide', bare.machine.memoryGB === null && Array.isArray(bare.notOffered) && bare.notOffered.length === 0);
  } finally {
    live.stop();
    for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// ------------------------------------------------------------------ 8. le vrai câblage : scanner.register(ctx)
// Les sections d'avant prouvent les fonctions ; celle-ci prouve l'objet ctx.models que le moteur, le pont et la
// fenêtre reçoivent VRAIMENT de scanner.register(), et les préférences que le service passe au scan.
async function testWiring() {
  section('Câblage réel (scanner.register) : ctx.models donne au moteur le refus du « dev », l’ancien défaut d’Auto et le total de mémoire');
  const root = FK.buildEngine(path.join(BASE, 'cablage', 'moteur'), ['int8', 'full', 'dev', 'teInt8', 'teFull', ...FK.LTX_BASE]);
  const FORMER = 'Z:/ancien-moteur';
  const data = path.join(BASE, 'cablage', 'data');
  const mkCtx = (dataDir, prefs) => {
    // autoByMemory forcé : ce câblage prouve que l'option { legacy } et le total traversent ctx.models (voir mkSvc)
    const ctx = { handlers: new Map(), sent: [], onChange: [], paths: { data: dataDir }, logger: () => () => {}, autoByMemory: true };
    ctx.ipcMain = { handle: (ch, fn) => ctx.handlers.set(ch, fn) };
    ctx.send = (ch, payload) => ctx.sent.push([ch, payload]);
    ctx.prefs = { get: async () => prefs, onChange: (fn) => ctx.onChange.push(fn) };
    return ctx;
  };
  const prefs = { engineRoot: root, formerEngineRoots: [FORMER], comfyUrl: 'http://127.0.0.1:9' };
  const fileId = (inv, k) => inv.models.find((m) => m.file === FK.FILE[k]).id;

  await withFakeHome(async () => {
    // --- (1) total de mémoire : ctx.models.machine / noteMachine, machine.json, relecture au démarrage suivant (D6)
    const ctx = mkCtx(data, prefs);
    const svc = scanner.register(ctx);
    try {
      const first = await ctx.models.ready();
      const ids = { int8: fileId(first, 'int8'), full: fileId(first, 'full'), dev: fileId(first, 'dev') };
      check('ctx.models expose machine() et noteMachine() ; aucun total tant que rien n’a été lu', typeof ctx.models.machine === 'function' && typeof ctx.models.noteMachine === 'function'
        && ctx.models.machine() === null && first.machine === null && !fs.existsSync(path.join(data, 'machine.json')), ctx.models.machine && ctx.models.machine());
      check('sans total : « Auto » = la compacte, par ctx.models.resolve', ctx.models.resolve('auto', ['text-to-video']).id === ids.int8
        && ctx.models.resolve('auto', ['text-to-video'], { legacy: true }).id === ids.int8);
      // (sans ce câblage le banc continue : il note l'échec et donne le total au service directement)
      if (typeof ctx.models.noteMachine === 'function') ctx.models.noteMachine({ source: 'comfy', memGB: 109.7, gpu: 'NVIDIA N1X' });
      const mach = typeof ctx.models.machine === 'function' ? ctx.models.machine() : null;
      check('ctx.models.noteMachine(lecture de ComfyUI) : ctx.models.machine() rend ce total, avec sa source', !!mach && mach.memGB === 109.7
        && mach.source === 'comfy' && mach.gpu === 'NVIDIA N1X', mach);
      svc.noteMachine({ source: 'comfy', memGB: 109.7, gpu: 'NVIDIA N1X' });
      await settle(svc, false);                 // machine.json écrit, inventaire refait avec ce total
      check('le total est écrit dans machine.json', JSON.parse(fs.readFileSync(path.join(data, 'machine.json'), 'utf8')).comfy.memGB === 109.7);
      const inv = ctx.models.inventory();
      check('l’inventaire a été refait avec ce total : machine 109,7 Go, « Auto » = la pleine, ancien défaut = la compacte', inv.machine && inv.machine.memGB === 109.7
        && inv.capabilities['text-to-video'].default === ids.full && inv.capabilities['text-to-video'].legacyDefault === ids.int8, [inv.machine, inv.capabilities['text-to-video']]);

      // --- (2) D5 : l'option { legacy } traverse ctx.models.resolve (l'empreinte « Auto = compacte » des résultats déjà faits)
      check('ctx.models.resolve(« auto ») → la pleine ; avec { legacy: true } → la compacte d’avant', ctx.models.resolve('auto', ['text-to-video']).id === ids.full
        && ctx.models.resolve('auto', ['text-to-video'], { legacy: true }).id === ids.int8 && ctx.models.resolve('auto', ['image-to-video'], { legacy: true }).id === ids.int8
        && ctx.models.resolve(ids.full, ['text-to-video'], { legacy: true }).id === ids.full,
        [ctx.models.resolve('auto', ['text-to-video']).file, ctx.models.resolve('auto', ['text-to-video'], { legacy: true }).file]);

      // --- (3) D3 : ctx.models.find rend le « dev » (pour le refus modelBlocked) alors que resolve ne le rend jamais
      const dev = typeof ctx.models.find === 'function' ? ctx.models.find(ids.dev) : null;
      check('ctx.models.find(id du « dev ») le rend avec sa raison ; ctx.models.resolve ne le rend pas', !!dev && dev.id === ids.dev && dev.blocked && dev.blocked.code === 'recipe'
        && ctx.models.resolve(ids.dev, ['text-to-video']) === null && ctx.models.resolve(ids.dev, []) === null, dev && [dev.file, dev.blocked]);
      // --- D1 : la préférence formerEngineRoots arrive au scan par register() aussi
      const alias = S.modelId(`${FORMER}/models/diffusion_models/${FK.FILE.dev}`);
      const aliasInt8 = S.modelId(`${FORMER}/models/diffusion_models/${FK.FILE.int8}`);
      check('ctx.models.find(id sous l’ancien dossier du moteur) rend le même modèle ; resolve aussi pour un modèle proposable', inv.formerRoots === 1 && alias !== ids.dev
        && typeof ctx.models.find === 'function' && !!ctx.models.find(alias) && ctx.models.find(alias).id === ids.dev && ctx.models.resolve(aliasInt8, ['text-to-video']).id === ids.int8, [inv.formerRoots, alias]);

      // --- (4) réglages changés : formerEngineRoots redemande un inventaire, une clé sans rapport non
      const asked = [];
      const realScan = svc.scan.bind(svc);
      svc.scan = (o) => { asked.push(o || {}); return Promise.resolve(svc.inventory); };
      const onChange = ctx.onChange[0];
      check('register() s’abonne aux changements de réglages', ctx.onChange.length === 1 && typeof onChange === 'function');
      if (typeof onChange === 'function') {
        onChange(prefs, ['formerEngineRoots']);
        check('formerEngineRoots changé (liste de clés) : un nouvel inventaire est demandé, après le scan en cours', asked.length === 1 && asked[0].queue === true, asked);
        onChange(prefs, new Set(['formerEngineRoots']));
        check('formerEngineRoots changé (ensemble de clés) : pareil', asked.length === 2 && asked[1].queue === true, asked);
        onChange(prefs, ['lang']);
        onChange(prefs, new Set(['theme', 'lang']));
        onChange(prefs, null);
        check('une clé sans rapport (langue, thème), ou rien : aucun inventaire demandé', asked.length === 2, asked);
        onChange(prefs, ['engineRoot', 'formerEngineRoots']);
        check('le dossier du moteur change (les deux clés ensemble) : un seul inventaire demandé', asked.length === 3, asked);
      }
      svc.scan = realScan;
    } finally { await settle(svc); }

    // au démarrage suivant (ComfyUI éteint) : le total est relu du fichier par le service que register() crée
    const ctx2 = mkCtx(data, prefs);
    const svc2 = scanner.register(ctx2);
    try {
      const again = typeof ctx2.models.machine === 'function' ? ctx2.models.machine() : null;
      check('démarrage suivant : ctx.models.machine() rend 109,7 Go (source comfy) relu de machine.json, avant tout scan', !!again && again.memGB === 109.7 && again.source === 'comfy', again);
    } finally { await settle(svc2); }

    // --- (5) le total que ComfyUI annonce PENDANT un scan est retenu (faux ComfyUI du banc : GET seulement)
    const comfy = await fakeComfy(117790000000);
    const data3 = path.join(BASE, 'cablage', 'data-comfy');
    const live = new scanner.ModelService({ paths: { data: data3 }, send: () => {}, logger: () => () => {}, prefs: { get: async () => ({ engineRoot: root, comfyUrl: comfy.url }) } });
    try {
      live.loadCacheSync();
      check('témoin — service neuf : aucun total retenu', live.machineNow() === null && !fs.existsSync(path.join(data3, 'machine.json')));
      const inv = await live.scan();
      await live.machineQueue;
      check('scan avec ComfyUI joignable : l’inventaire porte son total (109,7 Go, source comfy)', inv.comfy.reachable === true && inv.machine && inv.machine.memGB === 109.7 && inv.machine.source === 'comfy',
        [inv.comfy.reachable, inv.machine]);
      check('ce total est retenu par le service et écrit dans machine.json (pour les démarrages où ComfyUI sera éteint)', !!live.machineNow() && live.machineNow().memGB === 109.7
        && live.machineNow().source === 'comfy' && fs.existsSync(path.join(data3, 'machine.json'))
        && JSON.parse(fs.readFileSync(path.join(data3, 'machine.json'), 'utf8')).comfy.memGB === 109.7, live.machineNow());
      check('le faux ComfyUI n’a reçu que des GET', comfy.seen.length > 0 && comfy.seen.every((x) => /^GET /.test(x)), comfy.seen.slice(0, 4));
    } finally { await settle(live); await comfy.close(); }
  });
}

// Charge variantOf de src/js/nodes/profiles.js hors de la fenêtre : les « import » retirés (tl et readJSON fournis),
// import.meta.url remplacé par une adresse fixe ; readJSON rend le vrai model-families.json du dépôt.
async function loadVariantOf(mutate = (s) => s) {
  const file = path.join(MIA, 'src', 'js', 'nodes', 'profiles.js');
  const src = mutate(fs.readFileSync(file, 'utf8')).replace(/^import\s[^;]*;\s*$/gm, '').replace(/^export /gm, '').replace(/import\.meta\.url/g, "'file:///mia/src/js/nodes/profiles.js'");
  const families = JSON.parse(fs.readFileSync(path.join(MIA, 'src', 'catalog', 'model-families.json'), 'utf8'));
  const tl = (o) => (o && typeof o === 'object' ? o.fr || '' : String(o || ''));
  const readJSON = async (url) => (/model-families\.json$/.test(String(url)) ? families : { families: [] });
  // eslint-disable-next-line no-new-func
  const mod = new Function('tl', 'readJSON', 'console', `${src}\nreturn { variantOf, loadProfiles };`)(tl, readJSON, { warn() {} });
  await mod.loadProfiles();
  return mod.variantOf;
}

// ── interface : la place d'un modèle dans la mémoire de la machine (src/js/nodes/memory.js) ──
// Le module n'a ni import ni DOM : chargé ici comme le moteur charge route.js (les « export » retirés).
function loadMemory() {
  const src = fs.readFileSync(path.join(MIA, 'src', 'js', 'nodes', 'memory.js'), 'utf8');
  if (/^\s*import\s/m.test(src) || /\b(document|window)\b/.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))) return null;
  // eslint-disable-next-line no-new-func
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { machineGB, needGB, fitOf };`)();
}

function testMemory() {
  section('Interface : une seule règle de place en mémoire (memory.js), celle de toujours jusqu’à 24 Go');
  const M = loadMemory();
  check('memory.js se charge sans import ni DOM', !!M);
  if (!M) return;
  const ready = (gb, more = {}) => ({ status: 'ready', license: 'ok', role: 'diffusion_model', mem: { gb }, ...more });
  // la règle d'avant ce chantier (library.js et palette.js, seuils en dur) : 8 / 16 / carte − 1
  const old = (v, card) => (v < 8 ? 'light' : v < 16 ? 'comfy' : v <= card - 1 ? 'tight' : 'over');
  const POINTS = [5, 7.9, 8, 15.9, 16, 23, 23.1];
  for (const total of [12, 24]) {
    const got = POINTS.map((v) => M.fitOf(ready(v), total));
    check(`total ${total} Go : mêmes pastilles qu’avant pour 5 ; 7,9 ; 8 ; 15,9 ; 16 ; 23 ; 23,1`, got.join() === POINTS.map((v) => old(v, total)).join(), got);
  }
  check('total 24 Go : 23 « juste », 23,1 « déborde » (carte − 1)', M.fitOf(ready(23), 24) === 'tight' && M.fitOf(ready(23.1), 24) === 'over');
  // un balayage : aucun écart avec l'ancienne règle pour tout total jusqu'à 24 Go (D7)
  let diff = null;
  for (const total of [6, 8, 11, 12, 16, 23.6, 24]) {
    for (let v = 0.5; v <= 30 && !diff; v = Math.round((v + 0.1) * 10) / 10) {
      const a = M.fitOf(ready(v), total), b = old(v, Math.round(total));
      if (a !== b) diff = { total, v, a, b };
    }
  }
  check('jusqu’à 24 Go, aucun écart avec la règle d’avant (balayage de 0,5 à 30 Go)', !diff, diff);
  check('total inconnu : la règle à 24 Go, comme avant', [null, undefined, 0, NaN].every((tot) => POINTS.every((v) => M.fitOf(ready(v), tot) === old(v, 24))));
  check('total 109,7 Go : 40 et 71 à l’aise, 100 juste, 110 déborde', M.fitOf(ready(40), 109.7) === 'comfy' && M.fitOf(ready(71), 109.7) === 'comfy'
    && M.fitOf(ready(100), 109.7) === 'tight' && M.fitOf(ready(110), 109.7) === 'over',
  [40, 71, 100, 110].map((v) => M.fitOf(ready(v), 109.7)));
  check('total 109,7 Go : les seuils suivent la machine (21 Go léger, 36 léger, 37 à l’aise, 109 juste)', M.fitOf(ready(21), 109.7) === 'light' && M.fitOf(ready(36), 109.7) === 'light'
    && M.fitOf(ready(37), 109.7) === 'comfy' && M.fitOf(ready(109), 109.7) === 'tight');
  check('total 94 Go (nvidia-smi) : 40 à l’aise, 71 juste, 93 juste, 93,1 déborde', M.fitOf(ready(40), 94) === 'comfy' && M.fitOf(ready(71), 94) === 'tight'
    && M.fitOf(ready(93), 94) === 'tight' && M.fitOf(ready(93.1), 94) === 'over');
  check('pas de pastille : modèle pas prêt, licence interdite, LoRA, caché, besoin inconnu', M.fitOf(ready(40, { status: 'incomplete' }), 109.7) === null
    && M.fitOf(ready(40, { status: 'unused' }), 109.7) === null && M.fitOf(ready(40, { license: 'forbidden' }), 109.7) === null
    && M.fitOf(ready(40, { role: 'lora' }), 109.7) === null && M.fitOf(ready(40, { hidden: true }), 109.7) === null
    && M.fitOf(ready(null), 109.7) === null && M.fitOf(null, 109.7) === null);
  check('needGB lit la mémoire prévue pour cette machine (mem.gb), puis l’ancien champ vramGB', M.needGB({ mem: { gb: 71 }, vramGB: 46.04 }) === 71
    && M.needGB({ vramGB: 21 }) === 21 && M.needGB({ mem: { gb: null }, vramGB: 21 }) === 21 && M.needGB({ mem: { gb: null }, vramGB: null }) === null
    && M.needGB({}) === null && M.needGB(null) === null && M.needGB({ mem: { gb: 0 } }) === null);
  check('machineGB : le total de l’inventaire d’abord, sinon celui du moteur, sinon rien', M.machineGB({ machine: { memGB: 109.7 } }, { gpu: { vramTotalGB: 94 } }) === 109.7
    && M.machineGB({ machine: { memGB: null } }, { gpu: { vramTotalGB: 94 } }) === 94 && M.machineGB({ machine: null }, { gpu: { vramTotalGB: 94 } }) === 94
    && M.machineGB(null, null) === null && M.machineGB({}, { gpu: {} }) === null);
}

// ── interface : les textes fr / en des écrans (mêmes clés des deux côtés, un seul vocabulaire) ──
// Les tables de textes sont lues dans la source (les modules d'écran ne se chargent pas hors de la fenêtre).
async function testTexts() {
  section('Interface : textes fr / en de la version et de la mémoire (mêmes clés, « ≈ », un seul vocabulaire)');
  const read = (rel) => fs.readFileSync(path.join(MIA, 'src', 'js', ...rel.split('/')), 'utf8');
  /** Toutes les valeurs d'une clé de texte dans un fichier, dans l'ordre (fr puis en). */
  const valuesOf = (src, key) => [...src.matchAll(new RegExp(`'${key.replace(/[.]/g, '\\.')}':\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g'))].map((m) => m[1]);
  const FILES = {
    'nodes/modelpicker.js': ['node.model.mem', 'node.model.vram', 'node.model.memTip.measured', 'node.model.memTip.derived', 'node.model.memTip.plain',
      'node.model.memTip.noTotal', 'node.model.memOf', 'node.model.memOfNoTotal', 'node.model.file', 'node.model.tooBig', 'node.model.pickForMeFull',
      'node.model.pickForMeNoRoom', 'node.model.pickForMeUnmeasured', 'node.model.blockedTitle', 'node.model.blockedNote'],
    'ui/library.js': ['model.status.blocked', 'model.version', 'model.pair', 'model.fit.over', 'model.fitTip.over', 'model.memoryVal', 'model.memoryFit.light',
      'model.memoryFit.comfy', 'model.memoryFit.tight', 'model.memoryFit.over', 'model.memoryAt.measured', 'model.memoryAt.derived', 'model.memoryAt.file',
      'model.qc.full', 'model.qc.compact', 'model.qc.ultra', 'model.qc.very'],
    'graph/palette.js': ['pal.gb', 'pal.memTip', 'pal.fitTip.light', 'pal.fitTip.comfy', 'pal.fitTip.tight', 'pal.fitTip.over'],
    'ui/queue.js': ['gpu.vram', 'gpu.totalSmi'],
  };
  const all = {};
  const bad = [];
  for (const [rel, keys] of Object.entries(FILES)) {
    const src = read(rel);
    for (const k of keys) {
      const v = valuesOf(src, k);
      if (v.length !== 2 || !v[0] || !v[1]) bad.push(`${rel} : ${k} (${v.length})`);
      else all[k] = { fr: v[0], en: v[1] };
    }
  }
  check('chaque texte existe une fois en français et une fois en anglais', !bad.length, bad);
  const holes = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
  const uneven = Object.entries(all).filter(([, v]) => holes(v.fr) !== holes(v.en)).map(([k]) => k);
  check('mêmes variables ({n}, {total}, {card}…) en français et en anglais', !uneven.length, uneven);
  // toute mémoire affichée est une estimation : « ≈ » devant le nombre, dans les deux langues
  const withN = Object.entries(all).filter(([k, v]) => /\{n\}/.test(v.fr) && /mem|vram|gb|fit|pickForMe/i.test(k));
  const noApprox = withN.filter(([, v]) => !/≈ \{n\}/.test(v.fr) || !/≈ \{n\}/.test(v.en)).map(([k]) => k);
  check('« ≈ » devant toute mémoire affichée (jamais une garantie)', withN.length >= 15 && !noApprox.length, noApprox);
  const units = withN.filter(([, v]) => !/\{n\} Go/.test(v.fr) || !/\{n\} GB|\{n\} of \{total\} GB/.test(v.en)).map(([k]) => k);
  check('une seule unité : « Go » en français, « GB » en anglais', !units.length, units);
  // un seul vocabulaire (D6) : « mémoire », jamais « mémoire vidéo » ni « carte graphique » pour dire la place
  const srcs = Object.keys(FILES).concat(['nodes/familypicker.js', 'nodes/profiles.js', 'nodes/memory.js']).map((rel) => [rel, read(rel)]);
  const stale = srcs.filter(([, s]) => /mémoire vidéo|video memory|ta carte de|your \{card\} GB card|en pointe|at peak/i.test(s)).map(([rel]) => rel);
  check('plus de « mémoire vidéo », de « ta carte de … Go » ni de « en pointe » dans ces écrans', !stale.length, stale);
  const fitTips = ['pal.fitTip.light', 'pal.fitTip.comfy', 'pal.fitTip.tight', 'pal.fitTip.over'].filter((k) => all[k] && (/carte graphique/.test(all[k].fr) || /graphics card/.test(all[k].en)));
  check('palette : la place se dit « cette machine », pas « cette carte graphique »', !fitTips.length, fitTips);
  // les versions portent les mêmes mots partout : fiche de la bibliothèque (model.qc.*) et catalogue (QUANT_LABEL)
  const Q = RULES.QUANT_LABEL || {};
  const qc = ['full', 'compact', 'ultra', 'very'].filter((k) => !all[`model.qc.${k}`] || !Q[k] || all[`model.qc.${k}`].fr !== Q[k].fr || all[`model.qc.${k}`].en !== Q[k].en);
  check('précision : mêmes mots dans la bibliothèque et dans le catalogue (Pleine, Compacte, Compacte · RTX 50, Très compacte)', !qc.length, qc);
  check('« Trop lourd » / « Too big » : le même mot dans la liste de choix et dans la bibliothèque', !!all['node.model.tooBig'] && !!all['model.fit.over']
    && all['node.model.tooBig'].fr === 'Trop lourd' && all['model.fit.over'].fr === 'Trop lourd' && all['node.model.tooBig'].en === 'Too big' && all['model.fit.over'].en === 'Too big');
  check('modèle complet : la même raison courte partout (« Recette non validée »)', !!all['node.model.blockedNote'] && !!all['model.status.blocked']
    && all['node.model.blockedNote'].fr === all['model.status.blocked'].fr && all['node.model.blockedNote'].en === all['model.status.blocked'].en);
  // rien de Windows : ni <select>, ni attribut title= dans les écrans touchés
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // les commentaires en parlent, eux
  const win = srcs.filter(([, s]) => /el\('select'|<select|el\('[a-z0-9]+',\s*\{[^}]*\btitle:|setAttribute\('title'|\.title\s*=[^=]|\stitle=/.test(code(s))).map(([rel]) => rel);
  check('aucun <select> ni attribut title= dans ces écrans', !win.length, win);
  // variantOf lit la version résolue par le scanner avant toute regex sur le nom
  // (les commentaires retirés : celui de la fonction cite « m.version » lui aussi)
  const prof = code(read('nodes/profiles.js'));
  check('variantOf lit m.version (résolue par le scanner) avant la regex du profil de famille', prof.indexOf('m.version') > 0 && prof.indexOf('m.version') < prof.indexOf('new RegExp(v.match'));
  // … et le comportement lui-même : variantOf chargé hors de la fenêtre, avec le vrai model-families.json
  const LTX_INT8 = { file: FK.FILE.int8, baseKey: 'ltx', family: 'LTX-2.x', label: { fr: 'LTX 2.5', en: 'LTX 2.5' } };
  const LTX_FULL = { file: FK.FILE.full, baseKey: 'ltx', family: 'LTX-2.x', label: { fr: 'LTX 2.5 · Pleine', en: 'LTX 2.5 · Full' } };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  let variantOf = null;
  try { variantOf = await loadVariantOf(); } catch (e) { check('profiles.js se charge hors de la fenêtre (variantOf)', false, e.message); }
  if (variantOf) {
    const full = variantOf({ ...LTX_FULL, version: RULES.VERSIONS.full });
    check('variantOf : la version du scanner l’emporte — « Pleine » et sa phrase, pas « Standard »', same(full, { tag: 'Pleine', desc: RULES.VERSIONS.full.desc.fr }), full);
    check('variantOf : même un nom qui dit « nvfp4 » suit la version du scanner (l’écran ne devine rien par le nom)',
      same(variantOf({ file: FK.FILE.nvfp4, baseKey: 'ltx', version: { tag: { fr: 'Pleine', en: 'Full' }, desc: { fr: 'x', en: 'y' } } }), { tag: 'Pleine', desc: 'x' })
      && same(variantOf({ file: FK.FILE.int8, baseKey: 'ltx', version: { tag: { fr: 'Compacte', en: 'Compact' } } }), { tag: 'Compacte', desc: '' }));
    check('variantOf : une version sans famille connue est rendue quand même', same(variantOf({ file: 'x.safetensors', version: RULES.VERSIONS.complete }),
      { tag: 'Complète (non distillée)', desc: RULES.VERSIONS.complete.desc.fr }));
    check('variantOf sans version (inventaire d’avant, autre famille) : repli sur les variantes du profil de famille, comme avant',
      variantOf(LTX_INT8).tag === 'Standard' && variantOf({ ...LTX_INT8, file: FK.FILE.nvfp4 }).tag === 'Rapide' && variantOf({ ...LTX_INT8, version: null }).tag === 'Standard'
      && variantOf({ ...LTX_INT8, version: {} }).tag === 'Standard' && variantOf({ file: 'inconnu.safetensors' }) === null,
      [variantOf(LTX_INT8), variantOf({ ...LTX_INT8, file: FK.FILE.nvfp4 })]);
    // témoin : sans la ligne qui lit m.version, ce banc le voit (la pleine redeviendrait « Standard »)
    const without = await loadVariantOf((s) => s.replace(/^\s*if \(m && m\.version && m\.version\.tag\) return[^\n]*\n/m, ''));
    check('témoin — sans la lecture de m.version, la pleine serait nommée « Standard » : le contrôle ci-dessus le verrait',
      without({ ...LTX_FULL, version: RULES.VERSIONS.full }).tag === 'Standard');
  }
  // une seule règle de place : la bibliothèque et la palette n'ont plus de seuils en dur
  const dup = ['ui/library.js', 'graph/palette.js'].filter((rel) => /v < 8\b|v < 16\b|1e9\) \/ 2 \*\* 30/.test(read(rel)) || !/from '\.\.\/nodes\/memory\.js'/.test(read(rel)));
  check('bibliothèque et palette : la règle de memory.js, plus de seuils 8 / 16 en dur', !dup.length, dup);
  // modèle complet (recette non validée) : le bloc le dit sans proposer de l'installer, et les listes ne le rendent
  // jamais cliquable (contrôle de câblage, lu dans la source : ces modules ne se chargent pas hors de la fenêtre)
  const mp = code(read('nodes/modelpicker.js')), fp = code(read('nodes/familypicker.js'));
  check('bloc : un modèle reconnu mais pas proposé est un problème sans bouton « Installer » (noInstall), bloc Modèle compris',
    (mp.match(/blockedTitle'\), sub: blockedWhy\(\w+\), caps(?:: \[\])?, noInstall: true/g) || []).length === 2
    && /problem\.noInstall \? null :/.test(read('nodes/body.js')) && /!blocked \|\| !!blocked\.noInstall/.test(read('nodes/body.js'))
    && /problem && !problem\.noInstall/.test(read('nodes/inspector.js')));
  check('listes : une version reconnue mais pas proposée est une ligne grisée sans valeur (jamais choisissable)',
    /m\.blocked\s*\?\s*row\(\{[^}]*greyed: true/.test(mp) && /for \(const m of blocked\) \{\s*list\.append\(row\(\{[^}]*greyed: true/.test(mp)
    && /const v = variant \? \(stop \? null : variant\.id\)/.test(fp));
  check('bloc Modèle : seuls les modèles qui font une façon de faire de la famille sont des versions (« LTX · détails » n’en est pas une)',
    /const able = mine\.filter\(\(m\) => \(m\.caps \|\| \[\]\)\.some\(\(c\) => wfCaps\.has\(c\)\)\)/.test(fp) && /variants: same \? byMem : \[\]/.test(fp));
}

async function main() {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(BASE, { recursive: true });
  console.log(`Dossier temporaire : ${BASE}`);
  try {
    testAliasIds();
    testCatalog();
    testMachine();
    await testVersions();
    await testAuto();
    await testWiring();
    testMemory();
    await testTexts();
    const mv = await testMove();
    if (mv) await testRuns(mv);
    else check('déménagement : le faux moteur a pu être scanné', false);
  } finally {
    try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* Windows garde parfois un verrou un instant */ }
  }
  console.log(`\n${passes} contrôles réussis, ${failures} échec(s).`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('\nERREUR DU BANC :', e && e.stack ? e.stack : e);
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* */ }
  process.exit(1);
});
