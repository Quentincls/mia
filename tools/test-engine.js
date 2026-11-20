'use strict';
// Banc d'essai du moteur de Mia, en Node pur (sans Electron) : node tools/test-engine.js
//
// - un faux ctx (projet temporaire, faux ffmpeg, faux inventaire de modèles, faux ipcMain) ;
// - de faux executors (tools/fixtures/engine/executors) : aucun calcul GPU, aucun POST à ComfyUI ;
// - le verrou GPU testé sur un fichier TEMPORAIRE, jamais sur D:\AI_Local_Videos\runtime\gpu.lock ;
// - ComfyUI : seulement des GET en lecture (détection, /models, /object_info, /queue) ; POST /free jamais
//   envoyé (remplacé par un espion) ; l'aide de fermeture est testée contre un FAUX ComfyUI local ;
// - pyrun : un faux worker Python minuscule (CPU) lancé avec le Python du labo, s'il existe.
// Code de sortie 1 si un contrôle échoue.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

// Faux executors : aucun GPU possible. MIA_NO_GPU=1 (imposé aux agents dans leur environnement) ferait refuser
// tous les blocs lourds du banc : retiré ici, et testé à part (section « MIA_NO_GPU=1 »).
delete process.env.MIA_NO_GPU;

const MIA = path.resolve(__dirname, '..');
const ENGINE = path.join(MIA, 'electron', 'engine');
const FIXTURES = path.join(__dirname, 'fixtures', 'engine');      // faux executors + faux worker Python
const { register, _internals: I } = require(path.join(ENGINE, 'index.js'));
const { createGpuLock } = require(path.join(ENGINE, 'gpulock.js'));
const { Comfy, friendlyPromptError, friendlyExecError, QUIT_HELPER } = require(path.join(ENGINE, 'comfy.js'));
const { createPyRunner } = require(path.join(ENGINE, 'pyrun.js'));

const REAL_LOCK = 'D:\\AI_Local_Videos\\runtime\\gpu.lock';
const LAB_PY = 'D:\\AI_Local_Videos\\env\\venv\\Scripts\\python.exe';

// ------------------------------------------------------------------ petit cadre de test
let failures = 0;
let passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log(`  ok    ${name}`); }
  else { failures++; console.log(`  ÉCHEC ${name}${detail !== undefined ? ` → ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}
const section = (t) => console.log(`\n== ${t}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => JSON.parse(JSON.stringify(v));
const overlap = (a, b) => a.start < b.end && b.start < a.end;

// ------------------------------------------------------------------ projet temporaire
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-b1-'));
const projectDir = path.join(tmp, 'Projet Test');
const labRoot = path.join(tmp, 'lab');
const lockPath = path.join(labRoot, 'runtime', 'gpu.lock');
const lockPath2 = path.join(tmp, 'lab2', 'runtime', 'gpu.lock');      // « engineRoot » changé pendant un calcul
fs.mkdirSync(path.join(projectDir, 'media'), { recursive: true });
fs.mkdirSync(path.dirname(lockPath), { recursive: true });
fs.mkdirSync(path.dirname(lockPath2), { recursive: true });
fs.writeFileSync(path.join(projectDir, 'media', 'a.png'), 'png');
fs.writeFileSync(path.join(projectDir, 'media', 'clip.mp4'), 'mp4');
for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(projectDir, 'media', `r${i}.png`), `ref ${i}`);
fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify({ id: 'p_test', name: 'Projet Test', version: 1 }));
for (const p of [lockPath, lockPath2]) {
  if (path.resolve(p).toLowerCase() === path.resolve(REAL_LOCK).toLowerCase()) throw new Error('verrou réel : refus');
}

let curLock = lockPath;                 // ce que « prefs.engineRoot » désigne en ce moment
let curDir = projectDir;                // où le magasin de projets dit que vit p_test (renommage)
globalThis.__miaTest = { log: [], cfg: {}, lockPath: () => curLock };
const T = globalThis.__miaTest;
const trashed = [];
const loraCalls = [];

const handlers = new Map();
const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
const invoke = (ch, ...args) => handlers.get(ch)({ sender: null }, ...args);
const sent = [];

const ctx = {
  app: null,
  ipcMain,
  getWin: () => null,
  send: (ch, payload) => sent.push({ ch, payload }),
  // Python du labo donné directement (l'engineRoot du test est un dossier temporaire sans venv)
  paths: { data: path.join(tmp, 'data'), logs: path.join(tmp, 'data', 'logs'), root: MIA, python: fs.existsSync(LAB_PY) ? LAB_PY : path.join(MIA, 'python') },
  prefs: { get: async () => ({ lang: 'fr', engineRoot: labRoot, comfyUrl: 'http://127.0.0.1:8188' }), set: async () => ({}) },
  store: {
    projectDir: (id) => (id === 'p_test' ? curDir : null),
    projectById: (id) => (id === 'p_test' && curDir ? { id, name: 'Projet Test', dir: curDir } : null)
  },
  ffmpeg: {
    probe: async (abs) => ({ kind: /\.mp4$/i.test(abs) ? 'video' : 'image', w: 4, h: 4, fps: 24, frames: 10, duration: 0.42,
      codec: 'fake', pixfmt: 'rgb24', alpha: false, hasAudio: false, playable: true }),
    poster: async (src, dst) => { fs.writeFileSync(dst, 'jpg'); return dst; }
  },
  models: {
    list: () => ({ models: [] }),
    resolve: (value, caps) => {
      if (caps && caps.includes('lora')) {
        return value === 'disparu' ? null : { id: `lora-${value}`, label: { fr: `LoRA ${value}` }, caps, loraFor: 'ltx' };
      }
      return caps && caps[0] === 'character-performance' ? null
        : { id: `fake-${(caps || [])[0] || 'x'}`, label: { fr: 'Faux modèle', en: 'Fake model' }, caps };
    },
    ensureLora: async (entry, o) => {
      loraCalls.push(entry.id);
      if (o && o.onProgress) { o.onProgress(0.5); o.onProgress(1); }
      return { comfyName: `mia/${entry.id}.safetensors` };
    }
  },
  trashItem: async (p) => { trashed.push(p); fs.rmSync(p, { recursive: true, force: true }); },
  engineOpts: {
    lockPath: () => curLock,
    journalFile: path.join(tmp, 'data', 'engine-runs.json'),
    workerPath: path.join(FIXTURES, 'fake_worker.py'),
    executorsDir: path.join(FIXTURES, 'executors'),
    timingsFile: path.join(tmp, 'data', 'timings.json'),
    retryMs: 200,
    renewMs: 120,
    noStatusPoll: true,
    checkComfyQueue: false,       // une autre session peut calculer pendant le test : ne pas en dépendre
    noTempSweep: true             // jamais de ménage dans le vrai runtime du labo pendant un test
  }
};

// ------------------------------------------------------------------ graphe de base
const BASE = {
  version: 1,
  camera: { x: 0, y: 0, z: 1 },
  nodes: [
    { id: 'n_imp', type: 'import', x: 0, y: 0, params: {}, data: { src: 'media/a.png', kind: 'image', name: 'a.png', meta: { w: 4, h: 4 } } },
    { id: 'n_vid', type: 'import', x: 0, y: 400, params: {}, data: { src: 'media/clip.mp4', kind: 'video', name: 'clip.mp4', meta: { w: 4, h: 4, fps: 24 } } },
    { id: 'n_ph', type: 'import', x: 0, y: 800, params: {}, data: { placeholder: { kind: 'image', fr: 'Image de début', en: 'Start image' } } },
    { id: 'n_txt', type: 'text', x: 0, y: 1200, params: { text: '' } },
    { id: 'n_dep', type: 'depth', x: 400, y: 0, params: { detail: 'fast', model: 'auto' } },
    { id: 'n_rsz', type: 'resize', x: 800, y: 0, params: {} },
    { id: 'n_rsz2', type: 'resize', x: 800, y: 200, params: { fit: 'cover' } },
    { id: 'n_rszv', type: 'resize', x: 800, y: 400, params: {} },
    { id: 'n_cut', type: 'cutout', x: 400, y: 200, params: {} },
    { id: 'n_frm', type: 'frame', x: 400, y: 400, params: { at: 0 } },
    { id: 'n_frm2', type: 'frame', x: 400, y: 500, params: { at: 3 } },
    { id: 'n_trm', type: 'trim', x: 400, y: 600, params: {} },
    { id: 'n_i2v', type: 'i2v', x: 400, y: 800, params: {} },
    { id: 'n_edit', type: 'edit', x: 400, y: 1000, params: { prompt: '' } },
    { id: 'n_edit2', type: 'edit', x: 400, y: 1100, params: { prompt: 'ignored' } },
    { id: 'n_lone', type: 'depth', x: 400, y: 1400, params: {} },
    { id: 'n_bad', type: 'frame', x: 400, y: 1500, params: {} },
    { id: 'n_c1', type: 'resize', x: 900, y: 1600, params: {} },
    { id: 'n_c2', type: 'resize', x: 900, y: 1700, params: {} },
    { id: 'n_ph2', type: 'import', x: 0, y: 2000, params: {}, data: { placeholder: { kind: 'image', fr: 'Image de fin (conseillée)', en: 'End image (recommended)' } } },
    { id: 'n_ia', type: 'i2v', x: 400, y: 2000, params: { prompt: 'une rue' } },
    { id: 'n_ib', type: 'i2v', x: 400, y: 2200, params: { prompt: 'un quai' } },
    { id: 'n_down', type: 'resize', x: 800, y: 2000, params: {} },
    { id: 'n_ref', type: 'ref2v', x: 400, y: 3000, params: { prompt: 'Image 1 marche' } },
    { id: 'n_seq1', type: 'sequence', x: 400, y: 3500, params: {} },
    { id: 'n_seq3', type: 'sequence', x: 400, y: 3600, params: {} }
  ],
  edges: [
    { id: 'e1', from: { node: 'n_imp', port: 'out' }, to: { node: 'n_dep', port: 'media' } },
    { id: 'e2', from: { node: 'n_dep', port: 'depth' }, to: { node: 'n_rsz', port: 'media' } },
    { id: 'e3', from: { node: 'n_imp', port: 'out' }, to: { node: 'n_cut', port: 'media' } },
    { id: 'e4', from: { node: 'n_vid', port: 'out' }, to: { node: 'n_frm', port: 'video' } },
    { id: 'e5', from: { node: 'n_vid', port: 'out' }, to: { node: 'n_frm2', port: 'video' } },
    { id: 'e6', from: { node: 'n_vid', port: 'out' }, to: { node: 'n_trm', port: 'video' } },
    { id: 'e7', from: { node: 'n_ph', port: 'out' }, to: { node: 'n_i2v', port: 'start' } },
    { id: 'e8', from: { node: 'n_imp', port: 'out' }, to: { node: 'n_edit', port: 'image' } },
    { id: 'e9', from: { node: 'n_imp', port: 'out' }, to: { node: 'n_edit2', port: 'image' } },
    { id: 'e10', from: { node: 'n_txt', port: 'text' }, to: { node: 'n_edit2', port: 'prompt' } },
    { id: 'e11', from: { node: 'n_imp', port: 'out' }, to: { node: 'n_bad', port: 'video' } },
    { id: 'e12', from: { node: 'n_c1', port: 'out' }, to: { node: 'n_c2', port: 'media' } },
    { id: 'e13', from: { node: 'n_c2', port: 'out' }, to: { node: 'n_c1', port: 'media' } },
    { id: 'e14', from: { node: 'n_vid', port: 'out' }, to: { node: 'n_rszv', port: 'media' } },
    { id: 'e15', from: { node: 'n_dep', port: 'depth' }, to: { node: 'n_rsz2', port: 'media' } },
    { id: 'e30', from: { node: 'n_imp', port: 'out' }, to: { node: 'n_ia', port: 'start' } },
    { id: 'e31', from: { node: 'n_ia', port: 'video' }, to: { node: 'n_down', port: 'media' } },
    { id: 'e32', from: { node: 'n_imp', port: 'out' }, to: { node: 'n_ib', port: 'start' } },
    { id: 'e33', from: { node: 'n_ph2', port: 'out' }, to: { node: 'n_ib', port: 'end' } },
    { id: 'e40', from: { node: 'n_vid', port: 'out' }, to: { node: 'n_seq1', port: 'clips' } },
    { id: 'e41', from: { node: 'n_vid', port: 'out' }, to: { node: 'n_seq3', port: 'clips' } },
    { id: 'e42', from: { node: 'n_rszv', port: 'out' }, to: { node: 'n_seq3', port: 'clips' } },
    { id: 'e43', from: { node: 'n_frm', port: 'image' }, to: { node: 'n_seq3', port: 'clips' } }
  ],
  groups: []
};
const YS = [700, 100, 900, 300, 0, 500, 800, 200, 600, 400];     // r_i est posé à la hauteur YS[i]
for (let i = 0; i < 10; i++) {
  BASE.nodes.push({ id: `n_r${i}`, type: 'import', x: 0, y: 3000 + YS[i], params: {}, data: { src: `media/r${i}.png`, kind: 'image', name: `r${i}.png` } });
  BASE.edges.push({ id: `er${i}`, from: { node: `n_r${i}`, port: 'out' }, to: { node: 'n_ref', port: 'refs' } });
}
BASE.nodes.push({ id: 'n_rph', type: 'import', x: 0, y: 2990, params: {}, data: { placeholder: { kind: 'image', fr: 'Référence 0', en: 'Reference 0' } } });
BASE.edges.push({ id: 'erph', from: { node: 'n_rph', port: 'out' }, to: { node: 'n_ref', port: 'refs' } });
// sequence n_seq3 : un fil vers une image (Extraire) est refusé par le type → on le retire
BASE.edges = BASE.edges.filter((e) => e.id !== 'e43');
let graph = clone(BASE);
const node = (id) => graph.nodes.find((n) => n.id === id);
const run = (nodeId, mode) => invoke('engine:run', { projectId: 'p_test', nodeId, graph: clone(graph), mode });

// ------------------------------------------------------------------ moteur
let engine;
const events = [];

function waitFor(pred, ms = 8000, what = 'événement') {
  const hit = events.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { engine.off('event', on); reject(new Error(`délai dépassé : ${what}`)); }, ms);
    function on(evt) { if (pred(evt)) { clearTimeout(t); engine.off('event', on); resolve(evt); } }
    engine.on('event', on);
  });
}
const waitEnd = (jobId, ms) => (!jobId ? Promise.reject(new Error('run refusé : aucun jobId'))
  : waitFor((e) => e.jobId === jobId && ['done', 'error', 'cancelled'].includes(e.kind), ms, `fin de ${jobId}`));
async function idle(ms = 10000) {
  const until = Date.now() + ms;
  while (engine.jobs.size && Date.now() < until) await wait(20);
  return engine.jobs.size === 0;
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const readJsonSafe = (f) => { try { return readJson(f); } catch { return null; } };
const runDirs = (nodeId) => { try { return fs.readdirSync(path.join(projectDir, 'outputs', nodeId)); } catch { return []; } };

function deadPid() {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
    c.on('exit', () => resolve(c.pid));
  });
}

async function main() {
  console.log(`Dossier temporaire : ${tmp}`);

  // ================================================================ verrou GPU (unitaire)
  section('Verrou GPU (fichier temporaire)');
  const lk = createGpuLock({ lockPath });
  check('libre au départ', lk.readLock() === null);
  check('prendre', lk.take('Mia : essai (P)', 5).ok);
  const mine = lk.readLock();
  check('format JSON du labo', mine.qui === 'Mia : essai (P)' && mine.minutes === 5 && typeof mine.debut === 'number'
    && /^\d\d:\d\d$/.test(mine.depuis) && mine.app === 'Mia' && mine.pid === process.pid, mine);
  check('pas de BOM, une ligne', !fs.readFileSync(lockPath, 'utf8').startsWith('\uFEFF') && !fs.readFileSync(lockPath, 'utf8').includes('\n'));
  check('reprendre le sien = ok', lk.take('Mia : essai (P)', 5).ok);
  const other = lk.take('Autre : x', 5);
  check('pris par un autre = refus', !other.ok && other.info.qui === 'Mia : essai (P)');
  check('rendre avec un autre « qui » ne supprime rien', lk.release('Autre : x') === false && fs.existsSync(lockPath));
  check('rendre le sien', lk.release('Mia : essai (P)') === true && !fs.existsSync(lockPath));
  fs.writeFileSync(lockPath, 'texte libre');
  const txt = lk.readLock();
  check('contenu non JSON = pris (60 min)', txt && txt.qui === 'texte libre' && txt.minutes === 60 && !lk.isStale(txt), txt);
  check('non JSON : jamais supprimé par release', lk.release('Mia : essai (P)') === false && fs.existsSync(lockPath));
  fs.writeFileSync(lockPath, '\uFEFF{"qui": "Vieux", "minutes": 1, "debut": 1000, "depuis": "01:00"}');
  check('BOM toléré + périmé détecté', lk.isStale(lk.readLock()) && lk.readLock().qui === 'Vieux');
  check('périmé : on le reprend', lk.take('Mia : essai (P)', 2).ok && lk.readLock().qui === 'Mia : essai (P)');
  check('renouveler', lk.renew('Mia : essai (P)', 7).ok && lk.readLock().minutes === 7);
  lk.release('Mia : essai (P)');
  const dead = await deadPid();
  fs.writeFileSync(lockPath, JSON.stringify({ qui: 'Mia : orphelin', minutes: 10, debut: Date.now() / 1000, depuis: '12:00', app: 'Mia', pid: dead }));
  check('orphelin de Mia (pid mort) nettoyé', lk.cleanOrphan() === true && !fs.existsSync(lockPath));
  fs.writeFileSync(lockPath, JSON.stringify({ qui: 'Autre appli', minutes: 10, debut: Date.now() / 1000, depuis: '12:00', app: 'Autre', pid: dead }));
  check('verrou d’une autre appli (pid mort) intouché', lk.cleanOrphan() === false && fs.existsSync(lockPath));
  fs.writeFileSync(lockPath, JSON.stringify({ qui: 'Mia : vivant', minutes: 10, debut: Date.now() / 1000, depuis: '12:00', app: 'Mia', pid: process.ppid || 4 }));
  check('verrou de Mia avec pid vivant intouché', lk.cleanOrphan() === false && fs.existsSync(lockPath));
  const noDir = createGpuLock({ lockPath: path.join(tmp, 'absent', 'runtime', 'gpu.lock') });
  let code = null;
  try { noDir.take('x', 1); } catch (e) { code = e.code; }
  check('dossier runtime absent → ENOLOCKDIR (aucun dossier créé dans le labo)', code === 'ENOLOCKDIR' && !fs.existsSync(path.join(tmp, 'absent')));

  // Verrou : chemin passé explicitement (`at`), « même étiquette mais autre processus vivant », passation
  fs.rmSync(lockPath, { force: true });
  const lk2 = createGpuLock({ lockPath: () => lockPath2 });
  check('take(at) écrit le fichier demandé, pas le courant', lk2.take('Mia : at', 3, lockPath).ok && fs.existsSync(lockPath) && !fs.existsSync(lockPath2));
  check('release(at) rend ce fichier-là', lk2.release('Mia : at', lockPath) && !fs.existsSync(lockPath));
  const alive = process.ppid || 4;
  fs.writeFileSync(lockPath, JSON.stringify({ qui: 'Mia : même nom', minutes: 10, debut: Date.now() / 1000, depuis: '12:00', app: 'Mia', pid: alive }));
  check('même « qui » mais autre processus vivant (aide de fermeture) : pas à nous',
    !lk.take('Mia : même nom', 5).ok && lk.release('Mia : même nom') === false && fs.existsSync(lockPath));
  fs.rmSync(lockPath);
  lk.take('Mia : passe', 5);
  check('handOver : même « qui », pid de l’aide', lk.handOver('Mia : passe', alive) && readJsonSafe(lockPath).pid === alive
    && readJsonSafe(lockPath).qui === 'Mia : passe' && !lk.isMine(readJsonSafe(lockPath)));
  check('après passation, Mia ne le reprend ni ne le supprime', !lk.take('Mia : passe', 5).ok && lk.release('Mia : passe') === false);
  fs.rmSync(lockPath);

  // Orphelin nettoyé par register() (après le contrôle des calculs orphelins dans ComfyUI : GET seulement)
  fs.writeFileSync(lockPath, JSON.stringify({ qui: 'Mia : crash', minutes: 10, debut: Date.now() / 1000, depuis: '12:00', app: 'Mia', pid: dead }));
  engine = register(ctx);
  engine.on('event', (e) => events.push(e));
  await engine.ready;
  check('register() nettoie l’orphelin de Mia', !fs.existsSync(lockPath));
  check('ctx.engine = le moteur (pont des assistants)', ctx.engine === engine && ['run', 'cancel', 'jobList', 'wait', 'status', 'runs', 'onEvent', 'projectBusy', 'cancelProject']
    .every((k) => typeof ctx.engine[k] === 'function'));
  const freed = [];
  engine.comfy.free = async () => { freed.push({ lock: readJsonSafe(curLock) }); return true; };   // jamais de vrai POST /free

  // ================================================================ IPC
  section('Canaux IPC');
  for (const ch of ['engine:status', 'engine:run', 'engine:cancel', 'engine:jobs', 'engine:startComfy', 'engine:runs', 'engine:deleteRun']) {
    check(`canal ${ch}`, handlers.has(ch));
  }

  // ================================================================ validation
  section('Validation (messages en français)');
  let r = await run('n_lone');
  check('entrée requise absente', !r.ok && r.error === 'Branche une image ou une vidéo' && r.missing[0].port === 'media', r);
  r = await run('n_i2v');
  check('fichier attendu (bloc de recette vide)', !r.ok && /Glisse un fichier dans « Image de début »/.test(r.error) && r.missing.some((m) => m.nodeId === 'n_ph'), r);
  r = await run('n_edit');
  check('consigne requise', !r.ok && /Écris une consigne/.test(r.error) && r.missing[0].param === 'prompt', r);
  r = await run('n_edit2');
  check('consigne branchée vide', !r.ok && /consigne branchée/.test(r.error), r);
  r = await run('n_bad');
  check('mauvais type branché', !r.ok && r.error === '« Vidéo » attend une vidéo, pas une image', r);
  r = await run('n_c1');
  check('boucle détectée', !r.ok && /boucle/.test(r.error), r);
  r = await run('n_nope');
  check('bloc inconnu', !r.ok && /introuvable/.test(r.error), r);
  r = await invoke('engine:run', { projectId: 'p_absent', nodeId: 'n_dep', graph: clone(graph) });
  check('projet inconnu', !r.ok && r.error === 'Projet introuvable.', r);
  r = await run('n_imp');
  check('bloc sans calcul', !r.ok && /ne se calcule pas/.test(r.error), r);
  graph.nodes.push({ id: 'n_perf', type: 'perform', x: 0, y: 0, params: {} });
  graph.edges.push({ id: 'e20', from: { node: 'n_imp', port: 'out' }, to: { node: 'n_perf', port: 'character' } });
  graph.edges.push({ id: 'e21', from: { node: 'n_vid', port: 'out' }, to: { node: 'n_perf', port: 'motion' } });
  r = await run('n_perf', 'preview');
  check('aucun modèle pour la capacité', !r.ok && /Aucun modèle installé/.test(r.error) && r.missing[0].kind === 'model', r);
  node('n_ia').params.lora = 'disparu';
  r = await run('n_ia', 'preview');
  check('LoRA choisi puis disparu : refus clair (pas un rendu sans lui)', !r.ok && /LoRA choisi pour « Animer une image » n’est plus disponible/.test(r.error), r);
  node('n_ia').params.lora = 'none';
  check('aucun job créé par les refus', engine.jobs.size === 0);

  // ================================================================ MIA_NO_GPU
  section('MIA_NO_GPU=1 : un amont lourd est refusé, sans job');
  process.env.MIA_NO_GPU = '1';
  try {
    r = await run('n_rsz');
    check('run refusé avec le message du mode test', !r.ok && /MIA_NO_GPU=1/.test(r.error || ''), r);
    check('aucun job créé', engine.jobs.size === 0);
  } finally { delete process.env.MIA_NO_GPU; }

  // ================================================================ chaîne amont
  section('Chaîne import → Profondeur (lourd) → Redimensionner (léger)');
  T.log.length = 0;
  r = await run('n_rsz');
  check('run accepté', r.ok && typeof r.jobId === 'string', r);
  let end = await waitEnd(r.jobId);
  check('le bloc demandé finit', end.kind === 'done', end);
  const depRec = T.log.find((x) => x.name === 'depth');
  const rszRec = T.log.find((x) => x.name === 'resize');
  check('l’amont a été calculé avant', depRec && rszRec && depRec.end <= rszRec.start);
  check('l’aval reçoit la sortie de l’amont', rszRec && rszRec.inputs.media.abs.includes(path.join('outputs', 'n_dep')) && rszRec.inputs.media.kind === 'image', rszRec && rszRec.inputs);
  check('x.model résolu (auto → défaut)', depRec && depRec.model && depRec.model.id === 'fake-depth');
  check('params complétés par les défauts', depRec && depRec.params.invert === false && depRec.params.detail === 'fast');
  check('verrou pris pendant le calcul lourd', depRec && depRec.lock && depRec.lock.qui === 'Mia : Profondeur (Projet Test)' && depRec.lock.app === 'Mia' && depRec.lock.pid === process.pid, depRec && depRec.lock);
  check('verrou rendu après', !fs.existsSync(lockPath));
  const firstDepRun = runDirs('n_dep')[0];
  const rj = readJson(path.join(projectDir, 'outputs', 'n_dep', firstDepRun, 'run.json'));
  check('run.json complet', rj.status === 'done' && rj.runId === firstDepRun && /^r_\d{4}_\d{6}_[0-9a-f]{4}$/.test(rj.runId)
    && rj.nodeId === 'n_dep' && rj.type === 'depth' && rj.mode === null && rj.hash && rj.error === null
    && rj.outputs.depth.path === `outputs/n_dep/${firstDepRun}/depth.png` && rj.outputs.depth.kind === 'image'
    && rj.outputs.depth.meta.w === 4 && rj.outputs.depth.poster === null && rj.model === 'Faux modèle'
    && rj.log === `outputs/n_dep/${firstDepRun}/log.txt` && rj.started <= rj.finished, rj);
  check('événement done porte le run', end.run && end.run.status === 'done' && end.run.nodeId === 'n_rsz');
  const kinds = events.filter((e) => e.nodeId === 'n_dep').map((e) => e.kind);
  check('événements queued → start → progress → done', kinds[0] === 'queued' && kinds.includes('start') && kinds.includes('progress') && kinds[kinds.length - 1] === 'done', kinds);
  const lst = await invoke('engine:runs', 'p_test', 'n_dep');
  check('engine:runs', Array.isArray(lst) && lst.length === 1 && lst[0].runId === firstDepRun);
  await wait(300);
  const tim = readJson(path.join(tmp, 'data', 'timings.json'));
  check('timings.json appris (clé : type|mode|réglage qui pèse)', tim['depth|-|detail=fast'] && tim['depth|-|detail=fast'].n === 1
    && tim['depth|-|detail=fast'].ratio > 0 && tim['resize|-'].n === 1, tim);

  section('Vidéo : poster et type concret « follow »');
  r = await run('n_rszv');
  end = await waitEnd(r.jobId);
  const vrun = end.run;
  check('sortie vidéo + poster', vrun && vrun.outputs.out.kind === 'video' && /\/out\.jpg$/.test(vrun.outputs.out.poster)
    && fs.existsSync(path.join(projectDir, vrun.outputs.out.poster)), vrun && vrun.outputs);

  section('Réutilisation par empreinte');
  T.log.length = 0;
  const before = events.length;
  r = await run('n_rsz');
  end = await waitEnd(r.jobId);
  check('amont non recalculé (même empreinte)', end.kind === 'done' && !T.log.some((x) => x.name === 'depth') && T.log.filter((x) => x.name === 'resize').length === 1);
  check('aucun job créé pour l’amont', !events.slice(before).some((e) => e.nodeId === 'n_dep'));
  node('n_dep').params.detail = 'fine';
  T.log.length = 0;
  r = await run('n_rsz');
  await waitEnd(r.jobId);
  check('réglage changé → amont recalculé', T.log.some((x) => x.name === 'depth' && x.params.detail === 'fine'));
  check('deux versions de la Profondeur', runDirs('n_dep').length === 2);
  node('n_dep').pinnedRun = firstDepRun;
  T.log.length = 0;
  r = await run('n_rsz');
  await waitEnd(r.jobId);
  const pinRec = T.log.find((x) => x.name === 'resize');
  check('version épinglée transmise en aval', !T.log.some((x) => x.name === 'depth') && pinRec.inputs.media.runId === firstDepRun, pinRec && pinRec.inputs.media);
  node('n_dep').pinnedRun = null;
  r = await run('n_dep');
  const r2 = await run('n_dep');
  check('même bloc + mêmes réglages déjà en file → même job', r.ok && r2.ok && r.jobId === r2.jobId);
  await waitEnd(r.jobId);
  await idle();
  node('n_dep').params.invert = true;          // amont périmé, partagé par deux avals lancés au même instant
  const mark0 = events.length;
  const [ra, rb] = await Promise.all([run('n_rsz'), run('n_rsz2')]);
  await Promise.all([waitEnd(ra.jobId), waitEnd(rb.jobId)]);
  const depQueued = new Set(events.slice(mark0).filter((e) => e.nodeId === 'n_dep' && e.kind === 'start').map((e) => e.jobId));
  check('deux clics simultanés : l’amont commun calculé une seule fois', ra.ok && rb.ok && depQueued.size === 1, depQueued.size);
  node('n_dep').params.invert = false;
  await idle();

  // ================================================================ file : un seul lourd
  section('File : un seul calcul lourd, les légers attendent');
  T.log.length = 0;
  T.cfg.depth = { delay: 400 };
  T.cfg.cutout = { delay: 400 };
  T.cfg.frame = { delay: 150 };
  node('n_dep').params.invert = true;          // nouvelle empreinte
  const ids = [];
  for (const n of ['n_dep', 'n_cut', 'n_frm', 'n_frm2']) { const x = await run(n); ids.push(x.jobId); }
  const jobsNow = await invoke('engine:jobs');
  check('engine:jobs liste la file', jobsNow.filter((j) => ['queued', 'running', 'waiting-gpu'].includes(j.state)).length >= 3, jobsNow.map((j) => j.state));
  await Promise.all(ids.map((id) => waitEnd(id, 10000)));
  await idle();
  const heavy = T.log.filter((x) => ['depth', 'cutout'].includes(x.name));
  const light = T.log.filter((x) => ['frame', 'resize'].includes(x.name));
  check('2 lourds, 2 légers exécutés', heavy.length === 2 && light.length === 2, T.log.map((x) => x.name));
  check('jamais deux lourds en même temps', !overlap(heavy[0], heavy[1]));
  check('aucun léger pendant un lourd', light.every((l) => heavy.every((h) => !overlap(l, h))));
  check('ordre FIFO des lourds', heavy[0].name === 'depth' && heavy[1].name === 'cutout');
  check('les deux légers tournent ensemble (max 2)', overlap(light[0], light[1]));
  T.cfg = {};

  // ================================================================ voie « en ligne » (blocs Modèle hf:…)
  section('File : les calculs en ligne ont leur propre voie (ni GPU, ni limite des légers)');
  {
    const prefsGet = ctx.prefs.get;
    const withPrefs = (extra) => { ctx.prefs.get = async () => ({ ...(await prefsGet()), ...extra }); };
    ctx.cloud = { linked: () => true };               // compte relié (faux) : aucun appel réseau, l'executor est faux
    let gi = 0;
    const addGen = () => {
      const id = `n_on${gi++}`;
      graph.nodes.push({ id, type: 'gen', x: 1600, y: 200 * gi, params: { model: 'hf:seedance-2-5', prompt: `plan en ligne ${id}` } });
      return id;
    };
    // maximum de calculs simultanés d'une liste d'enregistrements {start, end}
    const maxAtOnce = (recs) => Math.max(0, ...recs.map((a) => recs.filter((b) => b.start <= a.start && a.start < b.end).length));
    const gens = () => T.log.filter((x) => x.name === 'gen');

    // 1) un lourd local + 5 en ligne (défaut : 4 à la fois) + un léger local
    withPrefs({});
    T.log.length = 0;
    T.cfg.depth = { delay: 1500 };
    T.cfg.gen = { delay: 700 };
    T.cfg.frame = { delay: 100 };
    node('n_dep').params.invert = 'en-ligne-1';      // nouvelle empreinte
    node('n_frm2').params.at = 5;
    const hv = await run('n_dep');
    check('lourd local accepté', hv.ok, hv);
    await waitFor((e) => e.jobId === hv.jobId && e.kind === 'start', 4000, 'départ du lourd');
    const onIds = [];
    for (let i = 0; i < 5; i++) { const x = await run(addGen()); check(`bloc en ligne ${i + 1} accepté`, x.ok, x); onIds.push(x.jobId); }
    const lt = await run('n_frm2');
    await wait(250);
    const st = await invoke('engine:status');
    const q = st && st.queue;
    check('statut : la file en ligne est donnée à part (4 en cours, 1 en file, max 4)',
      q && q.online && q.online.running === 4 && q.online.waiting === 1 && q.online.max === 4 && q.local && q.local.running === 1, q);
    const fifth = engine.jobs.get(onIds[4]);
    check('le 5e attend dans la file de Mia avec un état clair', fifth && fifth.state === 'queued' && /En file dans Mia : 4 calculs en ligne/.test(fifth.message), fifth && fifth.message);
    check('le job en ligne est marqué « online » (file, MCP)', engine.jobList().find((j) => j.jobId === onIds[0]).online === true
      && events.some((e) => e.jobId === onIds[0] && e.online === true));
    const ltJob = engine.jobs.get(lt.jobId);
    check('le léger local attend toujours le lourd (règle du labo inchangée)', ltJob && ltJob.state === 'queued' && /calcul en cours/.test(ltJob.message), ltJob && ltJob.message);
    await Promise.all([...onIds, hv.jobId, lt.jobId].map((id) => waitEnd(id, 15000)));
    await idle();
    const dep1 = T.log.find((x) => x.name === 'depth');
    const g1 = gens();
    const fr1 = T.log.find((x) => x.name === 'frame');
    check('5 calculs en ligne faits', g1.length === 5 && onIds.every((id) => events.some((e) => e.jobId === id && e.kind === 'done')), g1.length);
    check('4 calculs en ligne pendant le calcul lourd (aucun n’attend le GPU)', g1.filter((g) => overlap(g, dep1)).length >= 4, g1.map((g) => [g.start - dep1.start, g.end - dep1.start]));
    check('jamais plus de 4 en ligne à la fois', maxAtOnce(g1) === 4, maxAtOnce(g1));
    check('le léger local n’a pas tourné pendant le lourd', fr1 && !overlap(fr1, dep1));
    check('le lourd n’a pas attendu les calculs en ligne', dep1.start <= Math.min(...g1.map((g) => g.start)) + 50);

    // 2) réglage « Calculs en ligne simultanés » = 2 : 3 blocs → jamais plus de 2
    withPrefs({ cloudParallel: 2 });
    T.log.length = 0;
    T.cfg.gen = { delay: 400 };
    const ids2 = [];
    for (let i = 0; i < 3; i++) ids2.push((await run(addGen())).jobId);
    await wait(120);
    const q2 = (await invoke('engine:status')).queue.online;
    check('réglage à 2 : 2 en cours, 1 en file', q2.max === 2 && q2.running === 2 && q2.waiting === 1, q2);
    await Promise.all(ids2.map((id) => waitEnd(id, 10000)));
    check('réglage à 2 respecté', maxAtOnce(gens()) === 2 && gens().length === 3, maxAtOnce(gens()));
    withPrefs({ cloudParallel: 99 });
    await engine.refreshPrefs();
    check('réglage borné (99 → 16, 0 ou illisible → 4)', engine.onlineLimit() === 16
      && I.onlineLimit({ cloudParallel: 0 }) === 4 && I.onlineLimit({ cloudParallel: 'x' }) === 4 && I.onlineLimit({}) === 4 && I.onlineLimit({ cloudParallel: 1 }) === 1);

    // 3) un lourd lancé APRÈS des calculs en ligne démarre tout de suite (ils ne comptent pas comme « petits calculs »)
    withPrefs({});
    T.log.length = 0;
    T.cfg.gen = { delay: 1200 };
    T.cfg.depth = { delay: 200 };
    const ids3 = [];
    for (let i = 0; i < 2; i++) ids3.push((await run(addGen())).jobId);
    await wait(100);
    node('n_dep').params.invert = 'en-ligne-2';
    const hv2 = await run('n_dep');
    await Promise.all([...ids3, hv2.jobId].map((id) => waitEnd(id, 10000)));
    const dep3 = T.log.find((x) => x.name === 'depth');
    check('lourd lancé pendant 2 calculs en ligne : il démarre sans les attendre', dep3 && gens().every((g) => overlap(g, dep3)),
      gens().map((g) => [g.start, g.end]).concat([[dep3 && dep3.start, dep3 && dep3.end]]));
    await idle();

    // 4) une vraie conversion locale d'un calcul en ligne (réencodage avant envoi) attend la fin du lourd
    T.log.length = 0;
    T.cfg.depth = { delay: 600 };
    node('n_dep').params.invert = 'en-ligne-3';
    const hv3 = await run('n_dep');
    await waitFor((e) => e.jobId === hv3.jobId && e.kind === 'start', 4000, 'départ du lourd');
    const fakeOnline = { state: 'queued', online: true, _: { abort: new AbortController(), active: false, gpu: 'none', online: true } };
    await engine.whenGpuIdle(fakeOnline);
    const freeAt = Date.now();
    await waitEnd(hv3.jobId, 5000);
    const dep4 = T.log.find((x) => x.name === 'depth');
    check('réencodage d’un calcul en ligne : attend que le GPU local soit libre', dep4 && freeAt >= dep4.end - 5, { freeAt, end: dep4 && dep4.end });
    await idle();
    T.cfg = {};
    ctx.prefs.get = prefsGet;
    await engine.refreshPrefs();
    delete ctx.cloud;
  }

  // ================================================================ verrou tenu par une autre session
  section('GPU pris par une autre session');
  const debut = Date.now() / 1000;
  fs.writeFileSync(lockPath, JSON.stringify({ qui: 'Autre session : test', minutes: 10, debut, depuis: '20:00' }));
  node('n_dep').params.invert = false;
  node('n_dep').params.detail = 'fast';
  node('n_dep').title = 'Ma profondeur';
  T.log.length = 0;
  T.cfg.depth = { delay: 200 };
  r = await run('n_dep');
  const w = await waitFor((e) => e.jobId === r.jobId && e.kind === 'waiting-gpu', 3000, 'waiting-gpu');
  check('événement waiting-gpu avec who/since', w.who === 'Autre session : test' && Math.abs(w.since - debut * 1000) < 2000 && /GPU occupé par « Autre session : test »/.test(w.message), w);
  const st = await invoke('engine:status');
  check('statut : verrou d’un autre, busyOther', st.gpu.lock && st.gpu.lock.who === 'Autre session : test' && st.gpu.lock.mine === false && st.gpu.busyOther === true && st.queue.waiting >= 1, st.gpu);
  node('n_frm').params.at = 7;
  const lightJob = await run('n_frm');
  const lightEnd = await waitEnd(lightJob.jobId, 4000);
  check('un léger passe pendant que le lourd attend un autre programme', lightEnd.kind === 'done' && engine.jobs.get(r.jobId) && engine.jobs.get(r.jobId).state === 'waiting-gpu');
  await wait(450);
  check('le verrou de l’autre n’est jamais touché', readJson(lockPath).qui === 'Autre session : test' && !T.log.some((x) => x.name === 'depth'));
  fs.rmSync(lockPath);
  end = await waitEnd(r.jobId, 4000);
  const wRec = T.log.find((x) => x.name === 'depth');
  check('verrou libéré → le job démarre et prend le verrou', end.kind === 'done' && wRec && wRec.lock && wRec.lock.qui === 'Mia : Ma profondeur (Projet Test)', wRec && wRec.lock);
  check('verrou rendu à la fin', !fs.existsSync(lockPath));

  section('Verrou abandonné (périmé) et verrou non JSON');
  fs.writeFileSync(lockPath, JSON.stringify({ qui: 'Vieille session', minutes: 1, debut: Date.now() / 1000 - 3600, depuis: '19:00' }));
  node('n_dep').params.invert = true;
  r = await run('n_dep');
  end = await waitEnd(r.jobId, 4000);
  check('périmé : repris sans attendre', end.kind === 'done' && !events.some((e) => e.jobId === r.jobId && e.kind === 'waiting-gpu'));
  check('puis rendu', !fs.existsSync(lockPath));
  fs.writeFileSync(lockPath, 'occupé par un script');
  node('n_dep').params.detail = 'fine';
  r = await run('n_dep');
  const w2 = await waitFor((e) => e.jobId === r.jobId && e.kind === 'waiting-gpu', 3000, 'waiting-gpu texte');
  check('non JSON = occupé', w2.who === 'occupé par un script');
  await invoke('engine:cancel', r.jobId);
  end = await waitEnd(r.jobId, 3000);
  check('annulé pendant l’attente du GPU', end.kind === 'cancelled' && fs.readFileSync(lockPath, 'utf8') === 'occupé par un script');
  fs.rmSync(lockPath);
  await idle();

  // ================================================================ annulation
  section('Annulation');
  T.cfg.depth = { delay: 4000 };
  node('n_dep').params.invert = false;
  T.log.length = 0;
  r = await run('n_dep');
  await waitFor((e) => e.jobId === r.jobId && e.kind === 'start', 3000, 'start');
  await wait(150);
  const c = await invoke('engine:cancel', r.jobId);
  end = await waitEnd(r.jobId, 3000);
  check('annulation d’un job en cours', c.ok && end.kind === 'cancelled' && end.run && end.run.status === 'cancelled', end);
  check('run.json « cancelled » écrit', end.run && readJson(path.join(projectDir, 'outputs', 'n_dep', end.run.runId, 'run.json')).status === 'cancelled');
  check('l’executor a vu le signal', T.log[0] && T.log[0].cancelled === true);
  check('verrou rendu après annulation', !fs.existsSync(lockPath));

  T.cfg.cutout = { delay: 800 };
  node('n_cut').params.feather = 5;
  const a = await run('n_cut');
  node('n_dep').params.invert = true;
  node('n_dep').params.detail = 'fast';
  const b = await run('n_dep');
  const nBefore = runDirs('n_dep').length;
  await invoke('engine:cancel', b.jobId);
  end = await waitEnd(b.jobId, 2000);
  check('annulation d’un job en file : immédiate, sans dossier de version', end.kind === 'cancelled' && !end.run && runDirs('n_dep').length === nBefore);
  await waitEnd(a.jobId, 4000);

  T.cfg.depth = { delay: 1500 };
  node('n_dep').params.invert = false;
  node('n_dep').params.detail = 'fine';
  node('n_dep').title = null;
  node('n_imp').params.skipFirst = true;     // la source change d'empreinte : la Profondeur doit être recalculée
  const mark = events.length;
  r = await run('n_rsz');
  const created = (await invoke('engine:jobs')).filter((j) => !['done', 'error', 'cancelled'].includes(j.state));
  await invoke('engine:cancel', r.jobId);
  await waitEnd(r.jobId, 3000);
  await idle(4000);
  const casc = events.slice(mark).filter((e) => e.nodeId === 'n_dep' && e.kind === 'cancelled');
  check('annuler l’aval annule l’amont créé pour lui', created.length === 2 && casc.length === 1 && engine.jobs.size === 0, created.map((j) => j.nodeId));
  T.cfg = {};

  // ================================================================ erreurs
  section('Erreurs');
  T.cfg.depth = { fail: 'Échec simulé de la profondeur' };
  node('n_dep').params.invert = true;        // empreinte jamais calculée (skipFirst + fine + invert)
  r = await run('n_rsz');
  end = await waitEnd(r.jobId, 4000);
  const depErr = events.filter((e) => e.nodeId === 'n_dep' && e.kind === 'error').pop();
  check('erreur de l’executor → run.json error + message', depErr && depErr.message === 'Échec simulé de la profondeur' && depErr.run && depErr.run.status === 'error'
    && depErr.run.error === 'Échec simulé de la profondeur', depErr);
  const logTxt = depErr && depErr.run && fs.readFileSync(path.join(projectDir, depErr.run.log), 'utf8');
  check('log.txt contient l’erreur', logTxt && /ERREUR : Échec simulé/.test(logTxt));
  check('l’aval échoue avec « Le bloc … a échoué »', end.kind === 'error' && end.message === 'Le bloc « Profondeur » a échoué', end);
  T.cfg = {};
  r = await run('n_trm');
  end = await waitEnd(r.jobId, 3000);
  check('executor absent → message clair', end.kind === 'error' && /pas encore disponible dans Mia/.test(end.message), end.message);
  await idle();


  // ================================================================ version courante (SPEC §16)
  section('Version courante : épinglée › dernier rendu final › dernier aperçu');
  T.cfg = {};
  r = await run('n_ia', 'preview');
  end = await waitEnd(r.jobId);
  const P1 = end.run.runId;
  await wait(5);
  r = await run('n_ia', 'final');
  end = await waitEnd(r.jobId);
  const F1 = end.run.runId;
  check('aperçu puis rendu final du même bloc', end.run.mode === 'final' && P1 !== F1);
  await wait(5);
  r = await run('n_ia', 'preview');
  end = await waitEnd(r.jobId);
  const P2 = end.run.runId;
  T.log.length = 0;
  r = await run('n_down');
  end = await waitEnd(r.jobId);
  let downRec = T.log.find((x) => x.name === 'resize');
  check('l’aval prend le rendu final, même si un aperçu est plus récent', end.kind === 'done' && !T.log.some((x) => x.name === 'i2v')
    && downRec && downRec.inputs.media.runId === F1, downRec && downRec.inputs.media.runId);
  node('n_ia').pinnedRun = P2;
  T.log.length = 0;
  r = await run('n_down');
  await waitEnd(r.jobId);
  downRec = T.log.find((x) => x.name === 'resize');
  check('l’étoile l’emporte (aperçu épinglé)', downRec && downRec.inputs.media.runId === P2);
  node('n_ia').pinnedRun = null;
  check('règle currentRun (unitaire)', I.currentRun([{ runId: 'p2', mode: 'preview' }, { runId: 'f1', mode: 'final' }, { runId: 'p1', mode: 'preview' }]).runId === 'f1'
    && I.currentRun([{ runId: 'p2', mode: 'preview' }]).runId === 'p2' && I.currentRun([{ runId: 'x', mode: null }, { runId: 'f', mode: 'final' }]).runId === 'x'
    && I.currentRun([]) === null);
  // un seul « Générer » (28/10) : sans mode demandé, les réglages tels quels (« final ») ; l'aperçu seulement demandé
  check('sans mode : « final » (unitaire)', I.pickMode({ modes: ['preview', 'final'] }, null) === 'final'
    && I.pickMode({ modes: ['preview', 'final'] }, 'preview') === 'preview' && I.pickMode({ modes: ['preview', 'final'] }, 'nope') === 'final'
    && I.pickMode({ modes: ['solo'] }, null) === 'solo' && I.pickMode({}, 'final') === null);

  // ================================================================ LoRA + empreinte
  section('LoRA et empreinte (tous les réglages comptent)');
  T.log.length = 0;
  node('n_ia').params.loraStrength = 0.4;            // rangée cachée (aucun LoRA) : ne compte pas
  r = await run('n_down');
  end = await waitEnd(r.jobId);
  check('force du LoRA sans LoRA : pas de recalcul', end.kind === 'done' && !T.log.some((x) => x.name === 'i2v'));
  node('n_ia').params.lora = 'mara';
  T.cfg.i2v = { lora: true };
  T.log.length = 0;
  r = await run('n_down');
  end = await waitEnd(r.jobId);
  const loraRec = T.log.find((x) => x.name === 'i2v');
  check('LoRA choisi → recalcul ; x.ensureLora → nom ComfyUI', end.kind === 'done' && loraRec && loraRec.lora
    && loraRec.lora.comfyName === 'mia/lora-mara.safetensors' && loraCalls.includes('lora-mara'), loraRec && loraRec.lora);
  check('x.engineRoot et x.ensureLora fournis', loraRec && loraRec.hasEnsureLora && loraRec.engineRoot === labRoot, loraRec && loraRec.engineRoot);
  node('n_ia').params.loraStrength = 0.8;
  T.log.length = 0;
  r = await run('n_down');
  await waitEnd(r.jobId);
  check('force changée avec un LoRA → recalcul', T.log.some((x) => x.name === 'i2v' && x.params.loraStrength === 0.8));
  node('n_ia').params.format = '9:16';
  T.log.length = 0;
  r = await run('n_down');
  await waitEnd(r.jobId);
  check('format changé → recalcul', T.log.some((x) => x.name === 'i2v' && x.params.format === '9:16'));

  // « Passes » des blocs LTX (30/10) : un bloc d'avant ce réglage garde EXACTEMENT son empreinte (aucun recalcul par
  // ricochet) ; « auto » = rien ; seul un choix explicite (1 ou 2) compte
  section('Passes LTX : empreinte inchangée sans choix explicite');
  node('n_ia').params.passes = 'auto';
  T.log.length = 0;
  r = await run('n_down');
  end = await waitEnd(r.jobId);
  check('passes « auto » posé sur un bloc existant : pas de recalcul', end.kind === 'done' && !T.log.some((x) => x.name === 'i2v'));
  node('n_ia').params.passes = '2';
  T.log.length = 0;
  r = await run('n_down');
  await waitEnd(r.jobId);
  check('passes « 2 » → recalcul, réglage transmis', T.log.some((x) => x.name === 'i2v' && x.params.passes === '2'));
  {
    const CAT = JSON.parse(fs.readFileSync(path.join(MIA, 'src', 'catalog', 'nodes.json'), 'utf8'));
    const P = require(path.join(ENGINE, 'patch.js'));
    const models = { model: { id: 'ltx', file: 'ltx.safetensors' }, lora: null };
    for (const id of ['i2v', 't2v', 'real', 'gen']) {
      const type = CAT.types.find((t) => t.id === id);
      const pd = (type.params || []).find((p) => p.id === 'passes');
      check(`${id} : réglage « passes » seg auto/1/2, non avancé, sans empreinte par défaut`, !!pd && pd.kind === 'seg' && pd.default === 'auto'
        && !pd.advanced && pd.hashOmitDefault === true && pd.options.map((o) => o.value).join() === 'auto,1,2'
        && pd.label.fr === 'Passes' && pd.options[2].label.en === '2 passes' && !!pd.hint.fr && !!pd.hint.en, pd);
      const before = { ...type, params: type.params.filter((p) => p.id !== 'passes') };
      const old = {};
      for (const p of before.params) old[p.id] = p.default === undefined ? null : clone(p.default);
      const h0 = I.stable(I.hashParamsOf(before, old, models));
      check(`${id} : bloc d'avant « passes » → même empreinte`, I.stable(I.hashParamsOf(type, old, models)) === h0);
      check(`${id} : « auto » → même empreinte`, I.stable(I.hashParamsOf(type, { ...old, passes: 'auto' }, models)) === h0);
      check(`${id} : « 1 » et « 2 » → autre empreinte`, I.stable(I.hashParamsOf(type, { ...old, passes: '1' }, models)) !== h0
        && I.stable(I.hashParamsOf(type, { ...old, passes: '2' }, models)) !== h0
        && I.stable(I.hashParamsOf(type, { ...old, passes: '1' }, models)) !== I.stable(I.hashParamsOf(type, { ...old, passes: '2' }, models)));
    }
    const E = P.exec;
    const ps = (params, o) => E.ltxPasses({ params }, o);
    check('passes : auto + fin/clés → 2 ; auto seul → 1 ; ancien twoPass:true → 2',
      ps({ passes: 'auto' }, { autoTwo: true }).two && !ps({ passes: 'auto' }, {}).two && ps({ twoPass: true }, {}).two
      && ps({ passes: '2' }, {}).two && !ps({ passes: '1', twoPass: true }, { autoTwo: true }).two);
    check('passes : aperçu, fiche, MiniMax → 1 passe et la raison', ps({ passes: '2' }, { preview: true }).why === 'preview'
      && ps({ passes: '2' }, { sheet: true }).why === 'sheet' && ps({ passes: '2' }, { minimax: true }).why === 'minimax'
      && ps({ passes: 'auto' }, { minimax: true, autoTwo: true }).two === false && !ps({ passes: '1' }, { preview: true }).why);
    // bloc Modèle fam:ltx : forTarget ne filtre plus « passes » ni « enhance » (constat 30/10)
    const fams = JSON.parse(fs.readFileSync(path.join(MIA, 'src', 'catalog', 'model-families.json'), 'utf8'));
    const way = (wid) => fams.families.ltx.workflows.find((w) => w.id === wid);
    const gen = require(path.join(ENGINE, 'executors', 'gen.js'));
    const ft = (wid) => gen._forTarget({ gen: { as: way(wid).as, ports: Object.keys(way(wid).ports), params: way(wid).params },
      params: { model: 'fam:ltx', prompt: 'x', passes: '2', enhance: true }, inputs: {} }).params;
    check('bloc Modèle LTX : « passes » arrive à Animer, Texte et Photoréaliste', ft('i2v').passes === '2' && ft('t2v').passes === '2'
      && ft('real').passes === '2' && ft('guided').passes === undefined);
    check('bloc Modèle LTX : « enhance » arrive à Animer et Texte', ft('i2v').enhance === true && ft('t2v').enhance === true);
    // estimation (labo 30/10) : demi-définition + 0,5 × pleine définition + 0,3 min
    const i2v = require(path.join(ENGINE, 'executors', 'i2v.js'));
    const xi = (passes, inputs = {}) => ({ mode: 'final', params: { duration: 5, format: '16:9', resolution: '1080', fps: 24, passes },
      inputs: { start: { abs: 'a.png', meta: { w: 1920, h: 1080 } }, ...inputs }, model: () => null });
    const two = i2v.estimate(xi('2'));
    check('estimation 2 passes = ltxMinutes(w/2,h/2) + 0,5 × ltxMinutes(w,h) + 0,3', Math.abs(two
      - (E.ltxMinutes(960, 544, 121) + 0.5 * E.ltxMinutes(1920, 1088, 121) + 0.3)) < 1e-9 && two > 4 && two < 6, two);
    check('estimation auto + fin = 2 passes ; auto seul = 1 passe', i2v.estimate(xi('auto', { end: { abs: 'b.png' } })) === two
      && i2v.estimate(xi('auto')) === E.ltxMinutes(1920, 1088, 121), [i2v.estimate(xi('auto')), E.ltxMinutes(1920, 1088, 121)]);
  }
  delete node('n_ia').params.passes;
  T.cfg = {};
  check('showIf (unitaire)', I.shownParam({ showIf: { param: 'lora', notIn: ['none', null, ''] } }, { lora: 'none' }) === false
    && I.shownParam({ showIf: { param: 'lora', notIn: ['none', null, ''] } }, { lora: 'x' }) === true
    && I.shownParam({ showIf: { param: 'lora', notIn: ['none', null, ''] } }, {}) === false && I.shownParam({}, {}) === true);

  // ================================================================ entrée facultative vide
  // Dossier du moteur déménagé (SPEC §7) : l'id d'un modèle est fait de son chemin, il change donc avec le dossier ;
  // l'inventaire donne à chaque modèle l'id qu'il avait sous chaque ancien dossier (`aliases`). Une version faite
  // avec l'ancien id reste la version courante : ni le bloc ni ceux d'après ne sont recalculés.
  section('Dossier du moteur déménagé : les versions d’avant restent à jour (alias d’ids)');
  {
    const CAT = JSON.parse(fs.readFileSync(path.join(MIA, 'src', 'catalog', 'nodes.json'), 'utf8'));
    const type = CAT.types.find((t) => t.id === 'i2v');
    const pr = {};
    for (const p of type.params) pr[p.id] = p.default === undefined ? null : clone(p.default);
    pr.lora = 'x';
    const mm = { model: { id: 'idmodele0001', aliases: ['avant1modele', 'avant2modele'] }, lora: { id: 'idlora000001', aliases: ['avant1lora00'] } };
    const h = I.hashParamsOf(type, pr, mm);
    const h0 = I.hashParamsOf(type, pr, mm, 0);
    const h1 = I.hashParamsOf(type, pr, mm, 1);
    check('hashParamsOf sans ancien dossier : exactement « model:<id> »', h.model === 'model:idmodele0001' && h.lora === 'model:idlora000001'
      && I.stable(I.hashParamsOf(type, pr, mm, -1)) === I.stable(h), h);
    check('hashParamsOf(…, 0) : « model:<alias> » du 1er ancien dossier', h0.model === 'model:avant1modele' && h0.lora === 'model:avant1lora00', h0);
    check('hashParamsOf(…, 1) : l’alias du 2e ancien dossier ; un modèle qui n’en a pas garde son id', h1.model === 'model:avant2modele' && h1.lora === 'model:idlora000001', h1);
    const rest = (o) => I.stable({ ...o, model: 0, lora: 0 });
    check('seuls les ids de modèles changent d’une empreinte à l’autre', rest(h) === rest(h0) && rest(h) === rest(h1));
    const plain = { model: { id: 'idmodele0001' }, lora: null };
    check('modèle sans alias (hors du dossier du moteur, faux modèle des bancs) : même empreinte quel que soit le dossier',
      I.stable(I.hashParamsOf(type, pr, plain, 0)) === I.stable(I.hashParamsOf(type, pr, plain)));

    // la chaîne : Animer une image (modèle + LoRA) → Redimensionner → Redimensionner
    const OLD_L = 'a0a0a0a0a0a0';
    const NEW_L = 'b1b1b1b1b1b1';
    const realResolve = ctx.models.resolve;
    const inventoryAt = (when) => (value, caps) => {
      const c = (caps || [])[0] || 'x';
      if ((caps || []).includes('lora')) {
        if (when === 'avant') return value === OLD_L ? { id: OLD_L, label: { fr: 'LoRA' }, caps, loraFor: 'ltx' } : null;
        if (value !== NEW_L && !(when === 'alias' && value === OLD_L)) return null;      // l'ancien id ne résout que par l'alias
        return { id: NEW_L, aliases: when === 'alias' ? [OLD_L] : [], label: { fr: 'LoRA' }, caps, loraFor: 'ltx' };
      }
      if (when === 'avant') return { id: `avant-${c}`, label: { fr: 'Faux modèle' }, caps };
      return { id: `apres-${c}`, aliases: when === 'alias' ? [`avant-${c}`] : [], label: { fr: 'Faux modèle' }, caps };
    };
    graph.nodes.push({ id: 'n_mi', type: 'i2v', x: 400, y: 5000, params: { prompt: 'un phare', lora: OLD_L } },
      { id: 'n_md', type: 'resize', x: 800, y: 5000, params: {} },
      { id: 'n_md2', type: 'resize', x: 1200, y: 5000, params: { fit: 'cover' } });
    graph.edges.push({ id: 'em1', from: { node: 'n_imp', port: 'out' }, to: { node: 'n_mi', port: 'start' } },
      { id: 'em2', from: { node: 'n_mi', port: 'video' }, to: { node: 'n_md', port: 'media' } },
      { id: 'em3', from: { node: 'n_md', port: 'out' }, to: { node: 'n_md2', port: 'media' } });
    try {
      ctx.models.resolve = inventoryAt('avant');
      r = await run('n_md2');
      end = await waitEnd(r.jobId);
      await idle();
      const oldRun = readJsonSafe(path.join(projectDir, 'outputs', 'n_mi', runDirs('n_mi')[0], 'run.json'));
      check('avant le déménagement : la chaîne est calculée', end.kind === 'done' && runDirs('n_mi').length === 1 && runDirs('n_md').length === 1 && !!(oldRun && oldRun.hash), end);

      ctx.models.resolve = inventoryAt('alias');
      T.log.length = 0;
      let mark = events.length;
      r = await run('n_md2');
      end = await waitEnd(r.jobId);
      await idle();
      check('après, la planche garde l’ancien id du LoRA : il résout, aucun recalcul du bloc', r.ok && end.kind === 'done' && !T.log.some((x) => x.name === 'i2v'), r);
      check('ni du bloc d’après (l’empreinte d’avant se transmet de proche en proche)', !T.log.some((x) => x.nodeId === 'n_md')
        && !events.slice(mark).some((e) => e.nodeId === 'n_mi' || e.nodeId === 'n_md'));
      check('aucune version de plus en amont', runDirs('n_mi').length === 1 && runDirs('n_md').length === 1);
      node('n_mi').params.lora = NEW_L;             // planche déjà passée à l'id d'aujourd'hui (migration faite à la main)
      T.log.length = 0;
      mark = events.length;
      r = await run('n_md2');
      end = await waitEnd(r.jobId);
      await idle();
      check('planche passée au nouvel id : la version d’avant reste à jour', end.kind === 'done' && !T.log.some((x) => x.name === 'i2v' || x.nodeId === 'n_md')
        && !events.slice(mark).some((e) => e.nodeId === 'n_mi' || e.nodeId === 'n_md'));
      // « Générer » sur le bloc lui-même fait toujours un calcul : il porte l'empreinte d'aujourd'hui, jamais un alias
      const planner = new I.Planner(engine, { id: 'p_test', dir: projectDir, name: 'Projet Test' }, clone(graph), 'fr');
      const sp = await planner.spec(planner.nodes.get('n_mi'), engine.types.get('i2v'), I.pickMode(engine.types.get('i2v'), undefined), []);
      check('empreinte d’aujourd’hui ≠ celle d’avant, qui figure parmi les empreintes reconnues (une par ancien dossier)',
        !sp.error && sp.hash !== oldRun.hash && engine.types.get('i2v').modes.some((m) => sp.hashAlts(m).includes(oldRun.hash))
        && !sp.hashAlts(sp.mode).includes(sp.hash) && sp.hashAlts(sp.mode).length === 1, sp.error || { hash: sp.hash, alts: sp.hashAlts(sp.mode), old: oldRun.hash });

      ctx.models.resolve = inventoryAt('sans-alias');   // le même inventaire sans les anciens dossiers : ce qu'il se passait avant
      T.log.length = 0;
      r = await run('n_md2');
      end = await waitEnd(r.jobId);
      await idle();
      check('sans alias, le même changement d’id recalcule l’amont (un job est créé)', end.kind === 'done' && T.log.some((x) => x.name === 'i2v')
        && T.log.some((x) => x.nodeId === 'n_md') && runDirs('n_mi').length === 2);
      node('n_mi').params.lora = OLD_L;
      r = await run('n_md2');
      check('sans alias, l’ancien id du LoRA ne désigne plus rien : refus clair', !r.ok && /LoRA choisi pour « Animer une image » n’est plus disponible/.test(r.error), r);
    } finally {
      ctx.models.resolve = realResolve;
      await idle();
    }
    check('findModel du moteur : sans scanner qui sait chercher, null (jamais d’erreur)', engine.findModel('a0a0a0a0a0a0') === null && engine.findModel(null) === null);
    ctx.models.find = (ref) => (ref === 'x1' ? { id: 'x1', blocked: null } : null);
    check('findModel du moteur : rend ce que le scanner trouve', engine.findModel('x1').id === 'x1' && engine.findModel('rien') === null);
    delete ctx.models.find;
  }

  // Versions de LTX 2.5 (SPEC §7) : la compacte (int8 / nvfp4), la pleine (bf16) et la complète (« dev », reconnue mais
  // pas proposée). Les graphes sont ceux que les VRAIS executors enverraient, relevés sans rien exécuter
  // (tools/fixtures/variants/ltx-graphs.js) ; la référence graphes-ltx-avant-e3.json date d'avant l'appariement.
  section('LTX 2.5 : encodeur de texte assorti dans les graphes (rien n’est exécuté)');
  {
    const G = require(path.join(__dirname, 'fixtures', 'variants', 'ltx-graphs.js'));
    const before = readJson(path.join(__dirname, 'fixtures', 'variants', 'graphes-ltx-avant-e3.json'));
    const P = require(path.join(ENGINE, 'patch.js'));
    const UNET_INT8 = 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors';
    const UNET_FULL = 'ltx-2.5-22b-distilled-transformer-bf16.safetensors';
    const TE_INT8 = 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors';
    const TE_FULL = 'gemma4-12b-with-proj-ltx-2.5-bf16.safetensors';
    const part = (file, quantClass) => ({ id: `id-${quantClass}`, file, comfyName: file, sizeGB: 1, quantClass });
    const NOTE = { fr: 'Encodeur de texte en version compacte : la version pleine n’est pas installée.', en: 'Text encoder in its compact version: the full one is not installed.' };
    const compact = { id: 'cmp000000001', file: UNET_INT8, family: 'LTX-2.x', baseKey: 'ltx', comfy: { name: UNET_INT8, visible: true }, label: { fr: 'LTX 2.5', en: 'LTX 2.5' },
      version: { key: 'compact', kind: 'compact' }, parts: { 'ltx-te': part(TE_INT8, 'compact') }, pairTag: null, partNote: null, blocked: null };
    const bare = { ...compact, parts: null };                                    // inventaire d'avant (cache) : aucune pièce connue
    const full = { ...compact, id: 'ful000000001', file: UNET_FULL, comfy: { name: UNET_FULL, visible: true }, label: { fr: 'LTX 2.5 · Pleine', en: 'LTX 2.5 · Full' },
      version: { key: 'full', kind: 'full' }, parts: { 'ltx-te': part(TE_FULL, 'full') }, pairTag: 'te:full' };
    const fallback = { ...full, parts: { 'ltx-te': part(TE_INT8, 'compact') }, pairTag: null, partNote: NOTE };
    const dev = { id: 'dev000000001', file: 'ltx-2.5-22b-dev-transformer-bf16.safetensors', family: 'LTX-2.x', baseKey: 'ltx', status: 'unused', caps: [],
      comfy: { name: 'ltx-2.5-22b-dev-transformer-bf16.safetensors', visible: true }, label: { fr: 'LTX 2.5 · Complète (non distillée)', en: 'LTX 2.5 · Complete (not distilled)' },
      version: { key: 'complete', kind: 'complete' }, parts: null, pairTag: null, partNote: null,
      blocked: { code: 'recipe', note: { fr: 'Reconnu, pas encore proposé : sa recette de calcul n’est pas validée dans Mia.', en: 'Recognised, not offered yet: its compute recipe is not validated in Mia.' } } };
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const names = (graphs, key) => graphs.flatMap((g) => Object.values(g).filter((n) => n.inputs && key in n.inputs).map((n) => n.inputs[key]));
    // un graphe « plein » où l'on remet les deux noms du gabarit : tout le reste doit être celui d'avant
    const back = (g) => {
      const c = clone(g);
      for (const n of Object.values(c)) {
        if (n.inputs && 'clip_name' in n.inputs) n.inputs.clip_name = TE_INT8;
        if (n.inputs && 'unet_name' in n.inputs) n.inputs.unet_name = UNET_INT8;
      }
      return c;
    };
    check('référence d’avant : un graphe par executor, chacun avec un seul encodeur de texte (Gemma int8)', G.KINDS.every((k) => Array.isArray(before[k]) && before[k].length === 1
      && same(names(before[k], 'clip_name'), [TE_INT8]) && same(names(before[k], 'unet_name'), [UNET_INT8])), G.KINDS.map((k) => names(before[k] || [], 'clip_name')));
    for (const kind of G.KINDS) {
      const r0 = await G.capture(kind, {});
      const rc = await G.capture(kind, { model: compact });
      const rb = await G.capture(kind, { model: bare });
      check(`${kind} : sans inventaire, modèle compact, modèle sans pièces connues → graphe IDENTIQUE à celui d’avant`, !r0.error && !rc.error && !rb.error
        && same(r0.graphs, before[kind]) && same(rc.graphs, before[kind]) && same(rb.graphs, before[kind]), r0.error || rc.error || rb.error || names(rc.graphs, 'clip_name'));
      const rf = await G.capture(kind, { model: full });
      check(`${kind} : modèle plein assorti → transformeur bf16 ET Gemma bf16, décodeurs inchangés, rien d’autre ne change`, !rf.error && rf.graphs.length === 1
        && same(names(rf.graphs, 'clip_name'), [TE_FULL]) && same(names(rf.graphs, 'unet_name'), [UNET_FULL])
        && same(names(rf.graphs, 'vae_name'), names(before[kind], 'vae_name')) && names(rf.graphs, 'vae_name').length > 0
        && same(rf.graphs.map(back), before[kind]) && !/Encodeur de texte/.test(String(rf.notes)), rf.error || [names(rf.graphs, 'clip_name'), names(rf.graphs, 'unet_name'), rf.notes]);
      const rr = await G.capture(kind, { model: fallback });
      const rrEn = await G.capture(kind, { model: fallback, lang: 'en' });
      check(`${kind} : modèle plein sans Gemma plein → Gemma int8, et la note de repli dans les notes du résultat (fr / en)`, !rr.error
        && same(names(rr.graphs, 'clip_name'), [TE_INT8]) && same(names(rr.graphs, 'unet_name'), [UNET_FULL]) && String(rr.notes).split('\n').includes(NOTE.fr)
        && String(rrEn.notes).split('\n').includes(NOTE.en) && !String(rc.notes).includes(NOTE.fr), rr.error || rr.notes);
      const rd = await G.capture(kind, { model: dev });
      const rdEn = await G.capture(kind, { model: dev, lang: 'en' });
      check(`${kind} : modèle complet (recette non validée) → refus clair fr / en, AUCUN graphe envoyé`, rd.graphs.length === 0 && rdEn.graphs.length === 0
        && rd.error === '« LTX 2.5 · Complète (non distillée) » ne peut pas être lancé : sa recette de calcul n’est pas validée dans Mia.'
        && rdEn.error === '“LTX 2.5 · Complete (not distilled)” cannot be run: its compute recipe is not validated in Mia.', [rd.error, rdEn.error]);
    }
    const X = (m) => ({ model: (k) => (k === 'model' ? m : null) });
    let threw = null;
    try { P.exec.ltxParts(X(dev)); } catch (e) { threw = e.message; }
    check('ltxParts : gabarit sans modèle, pièce assortie sinon ; un modèle bloqué lève', same(P.exec.ltxParts(X(null)), { clip: TE_INT8, note: null })
      && same(P.exec.ltxParts(X(full)), { clip: TE_FULL, note: null }) && same(P.exec.ltxParts(X(fallback)), { clip: TE_INT8, note: NOTE.fr })
      && same(P.exec.ltxParts(X({ parts: { 'ltx-te': { file: 'x.safetensors', comfyName: null } } })), { clip: 'x.safetensors', note: null })
      && P.exec.LTX_TE_INT8 === TE_INT8 && /recette de calcul n’est pas validée/.test(String(threw)), threw);
    const up = P.load('ltx_upscale');
    check('« LTX · détails » : son gabarit nomme le même Gemma int8 (l’executor lit déjà la pièce de l’inventaire)',
      same(names([up], 'clip_name'), [TE_INT8]));

    // ---------------------------------------------------------------- empreinte
    section('LTX 2.5 : empreinte (encodeur plein marqué, compact inchangé), « Auto » d’avant reconnu, modèle complet refusé');
    const CAT = JSON.parse(fs.readFileSync(path.join(MIA, 'src', 'catalog', 'nodes.json'), 'utf8'));
    const type = CAT.types.find((t) => t.id === 'i2v');
    const pr = {};
    for (const p of type.params) pr[p.id] = p.default === undefined ? null : clone(p.default);
    const hp = (m, root) => I.hashParamsOf(type, pr, { model: m, lora: null }, root).model;
    check('hashParamsOf : encodeur plein → « model:<id>+te:full » ; compact, sans marque ou marque vide → la chaîne de toujours',
      hp(full) === 'model:ful000000001+te:full' && hp(compact) === 'model:cmp000000001' && hp(bare) === 'model:cmp000000001'
      && hp({ id: 'abc' }) === 'model:abc' && hp({ id: 'abc', pairTag: '' }) === 'model:abc' && hp(fallback) === 'model:ful000000001', [hp(full), hp(compact)]);
    check('hashParamsOf : la marque suit aussi l’id d’un ancien dossier du moteur', hp({ ...full, aliases: ['avant0000001'] }, 0) === 'model:avant0000001+te:full'
      && hp({ ...compact, aliases: ['avant0000002'] }, 0) === 'model:avant0000002');

    const tk = (m, extra = {}) => engine.timingKey({ type: 'i2v', mode: 'final', _: { spec: { params: {}, models: { model: m }, ...extra } } });
    check('durées apprises : clé inchangée en compact (et sans modèle), « v=full » en plein', tk(compact) === 'i2v|final' && tk(null) === 'i2v|final' && tk(bare) === 'i2v|final'
      && tk(full) === 'i2v|final|v=full' && tk(fallback) === 'i2v|final|v=full'
      && tk(full, { gen: { key: 'ltx', workflow: 't2v' } }) === 'i2v|final|ltx:t2v|v=full' && tk(compact, { gen: { key: 'ltx', workflow: 't2v' } }) === 'i2v|final|ltx:t2v', [tk(compact), tk(full)]);

    // « Auto » : hier la compacte, aujourd'hui la pleine (la machine a la place). La version faite hier reste à jour.
    const realResolve = ctx.models.resolve;
    const lite = (m, caps) => ({ id: m.id, label: m.label, caps, pairTag: m.pairTag, version: m.version, aliases: [] });
    // état : 'avant' (Auto = compacte) · 'promu' (Auto = pleine, l'ancien défaut connu) · 'sourd' (Auto = pleine, ancien défaut inconnu)
    const inventoryAt = (state) => (value, caps, opts) => {
      if ((caps || [])[0] !== 'image-to-video') return realResolve(value, caps);
      if (value === 'auto') return lite(state === 'avant' || (state === 'promu' && opts && opts.legacy) ? compact : full, caps);
      return value === full.id ? lite(full, caps) : value === compact.id ? lite(compact, caps) : null;
    };
    graph.nodes.push({ id: 'n_la', type: 'i2v', x: 400, y: 6000, params: { prompt: 'une digue' } }, { id: 'n_ld', type: 'resize', x: 800, y: 6000, params: {} });
    graph.edges.push({ id: 'el1', from: { node: 'n_imp', port: 'out' }, to: { node: 'n_la', port: 'start' } },
      { id: 'el2', from: { node: 'n_la', port: 'video' }, to: { node: 'n_ld', port: 'media' } });
    const i2vType = engine.types.get('i2v');
    const specOf = async (lang = 'fr', id = 'n_la') => {
      const planner = new I.Planner(engine, { id: 'p_test', dir: projectDir, name: 'Projet Test' }, clone(graph), lang);
      const n = planner.nodes.get(id);
      return planner.spec(n, engine.types.get(n.type), I.pickMode(engine.types.get(n.type), undefined), []);
    };
    try {
      ctx.models.resolve = inventoryAt('avant');
      r = await run('n_ld');
      end = await waitEnd(r.jobId);
      await idle();
      const oldRun = readJsonSafe(path.join(projectDir, 'outputs', 'n_la', runDirs('n_la')[0], 'run.json'));
      const sp0 = await specOf();
      check('hier (Auto = compacte) : la chaîne est calculée, aucune empreinte de rechange', end.kind === 'done' && runDirs('n_la').length === 1 && !!(oldRun && oldRun.hash)
        && sp0.models.model.id === compact.id && i2vType.modes.every((m) => sp0.hashAlts(m).length === 0), end);

      ctx.models.resolve = inventoryAt('promu');
      T.log.length = 0;
      let mark = events.length;
      r = await run('n_ld');
      end = await waitEnd(r.jobId);
      await idle();
      check('aujourd’hui (Auto = pleine) : la version faite hier en Auto reste à jour, aucun calcul en amont', r.ok && end.kind === 'done' && !T.log.some((x) => x.name === 'i2v')
        && !events.slice(mark).some((e) => e.nodeId === 'n_la') && runDirs('n_la').length === 1, r);
      const sp = await specOf();
      check('le bloc résout la pleine ; son empreinte du jour porte « +te:full » ; celle d’hier figure parmi les reconnues', !sp.error && sp.models.model.id === full.id
        && sp.hash !== oldRun.hash && i2vType.modes.some((m) => sp.hashAlts(m).includes(oldRun.hash)) && !sp.hashAlts(sp.mode).includes(sp.hash)
        && sp.hashAlts(sp.mode).length === 1 && I.hashParamsOf(i2vType, sp.params, sp.models).model === `model:${full.id}+te:full`,
        sp.error || { hash: sp.hash, alts: sp.hashAlts(sp.mode), old: oldRun.hash });
      ctx.models.resolve = inventoryAt('sourd');
      const spDeaf = await specOf();
      check('témoin — sans l’ancien défaut, l’empreinte d’hier n’est pas reconnue (l’amont serait recalculé)', !spDeaf.error && spDeaf.hash === sp.hash
        && i2vType.modes.every((m) => !spDeaf.hashAlts(m).includes(oldRun.hash)));

      ctx.models.resolve = inventoryAt('promu');
      node('n_la').params.model = compact.id;            // la compacte choisie à la main : c'est bien la version d'hier
      T.log.length = 0;
      r = await run('n_ld');
      end = await waitEnd(r.jobId);
      await idle();
      check('la compacte choisie à la main : même empreinte qu’hier, aucun calcul', end.kind === 'done' && !T.log.some((x) => x.name === 'i2v') && (await specOf()).hash === oldRun.hash);
      node('n_la').params.model = full.id;               // la pleine choisie à la main : aucune tolérance, un calcul
      const spFull = await specOf();
      check('la pleine choisie à la main : pas d’empreinte de rechange (un choix précis n’a pas la tolérance d’Auto)', !spFull.error && spFull.hash === sp.hash
        && i2vType.modes.every((m) => spFull.hashAlts(m).length === 0));
      T.log.length = 0;
      r = await run('n_ld');
      end = await waitEnd(r.jobId);
      await idle();
      check('la pleine choisie à la main → un calcul en amont (une version de plus)', end.kind === 'done' && T.log.some((x) => x.name === 'i2v') && runDirs('n_la').length === 2);
      check('sa durée est apprise à part de celle de la compacte', Object.keys(engine.timings).some((k) => /^i2v\|/.test(k) && /\|v=full$/.test(k))
        && Object.keys(engine.timings).some((k) => /^i2v\|/.test(k) && !/v=full/.test(k)), Object.keys(engine.timings));

      // --- le modèle complet posé dans un bloc (vieille planche, ou pont des assistants) : refus par son nom
      node('n_la').params.model = dev.id;
      ctx.models.find = (ref) => (ref === dev.id ? dev : null);
      const spDev = await specOf();
      const spDevEn = await specOf('en');
      check('bloc de tâche réglé sur le modèle complet : « ne peut pas être lancé », jamais « n’est plus disponible » (fr)',
        spDev.error === 'Le modèle « LTX 2.5 · Complète (non distillée) » choisi pour « Animer une image » ne peut pas être lancé : sa recette de calcul n’est pas validée dans Mia. Choisis « Auto » ou une autre version.'
        && spDev.missing.length === 1 && spDev.missing[0].kind === 'model' && spDev.missing[0].param === 'model', spDev.error);
      check('… et en anglais', /^The model “LTX 2\.5 · Complete \(not distilled\)” chosen for “.+” cannot be run: its compute recipe is not validated in Mia\. Pick “Auto” or another version\.$/.test(String(spDevEn.error))
        && !/no longer available/.test(String(spDevEn.error)), spDevEn.error);
      T.log.length = 0;
      r = await run('n_la');
      check('« Générer » sur ce bloc : refusé avec la même phrase, aucun calcul', !r.ok && /ne peut pas être lancé : sa recette de calcul n’est pas validée/.test(r.error) && !T.log.some((x) => x.nodeId === 'n_la'), r);
      r = await run('n_ld');
      check('… et sur le bloc d’après aussi (rien ne part en silence avec une autre version)', !r.ok && /ne peut pas être lancé/.test(r.error), r);
      delete ctx.models.find;
      check('témoin — un id que le scanner ne connaît pas reste « n’est plus disponible »', /n’est plus disponible/.test(String((await specOf()).error)));

      // --- bloc Modèle (SPEC §23) : la famille laissée à Mia suit Auto ; le modèle complet y est refusé de même
      const inv = (promoted) => ({
        models: [compact, full].map((m) => ({ ...m, status: 'ready', hidden: false, license: 'ok', role: 'diffusion_model', quality: 3, aliases: [], caps: ['image-to-video', 'text-to-video'] })).concat([{ ...dev, role: 'diffusion_model', hidden: false, license: 'ok', aliases: [] }]),
        aliases: {},
        capabilities: Object.fromEntries(['image-to-video', 'text-to-video'].map((c) => [c, promoted
          ? { available: true, default: full.id, legacyDefault: compact.id, options: [compact.id, full.id] }
          : { available: true, default: compact.id, options: [compact.id, full.id] }])),
      });
      graph.nodes.push({ id: 'n_lg', type: 'gen', x: 400, y: 6400, params: { model: 'fam:ltx', prompt: 'un phare' } });
      let cur = inv(false);
      ctx.models.inventory = () => cur;
      ctx.models.find = (ref) => cur.models.find((m) => m.id === ref) || null;
      const g0 = await specOf('fr', 'n_lg');
      cur = inv(true);
      const g1 = await specOf('fr', 'n_lg');
      const genModes = engine.types.get('gen').modes || [g1.mode];
      check('bloc Modèle « LTX » : hier la compacte, aujourd’hui la pleine ; l’empreinte d’hier est reconnue', !g0.error && !g1.error && g0.models.model.id === compact.id
        && g1.models.model.id === full.id && g0.gen.workflow === 't2v' && g1.hash !== g0.hash && g1.hashAlts(g1.mode).includes(g0.hash)
        && genModes.every((m) => g0.hashAlts(m).length === 0), g0.error || g1.error || { h0: g0.hash, h1: g1.hash, alts: g1.hashAlts(g1.mode) });
      node('n_lg').params.model = full.id;
      const g2 = await specOf('fr', 'n_lg');
      check('bloc Modèle réglé sur la pleine à la main : même empreinte, aucune de rechange', !g2.error && g2.models.model.id === full.id && g2.hash === g1.hash
        && genModes.every((m) => g2.hashAlts(m).length === 0), g2.error);
      node('n_lg').params.model = dev.id;
      const g3 = await specOf('fr', 'n_lg');
      const g3en = await specOf('en', 'n_lg');
      const genType = engine.types.get('gen');
      const planner = new I.Planner(engine, { id: 'p_test', dir: projectDir, name: 'Projet Test' }, clone(graph), 'fr');
      const pg = planner.planGen(planner.nodes.get('n_lg'), genType, engine.fullParams(genType, node('n_lg').params), {}, {}, {}, []);
      check('bloc Modèle réglé sur le modèle complet : refusé par son nom (fr / en), jamais « n’est plus disponible »',
        /^Le modèle « LTX 2\.5 · Complète \(non distillée\) » choisi pour « .+ » ne peut pas être lancé : sa recette de calcul n’est pas validée dans Mia\. Choisis « Auto » ou une autre version\.$/.test(String(g3.error))
        && /^The model “LTX 2\.5 · Complete \(not distilled\)” chosen for “.+” cannot be run: its compute recipe is not validated in Mia\./.test(String(g3en.error)), [g3.error, g3en.error]);
      check('… aucun modèle retenu, aucune façon de faire : pas de bascule en silence vers une autre version', pg.model === null && pg.gen === null && pg.missing.length === 1
        && pg.missing[0].kind === 'model' && pg.missing[0].param === 'model' && !pg.legacyModel, pg);
      r = await run('n_lg');
      check('« Générer » sur ce bloc Modèle : refusé, aucun calcul', !r.ok && /ne peut pas être lancé : sa recette de calcul n’est pas validée/.test(r.error), r);
    } finally {
      ctx.models.resolve = realResolve;
      delete ctx.models.find;
      delete ctx.models.inventory;
      await idle();
      graph.nodes = graph.nodes.filter((n) => !['n_la', 'n_ld', 'n_lg'].includes(n.id));
      graph.edges = graph.edges.filter((e) => !['el1', 'el2'].includes(e.id));
    }

    // ---------------------------------------------------------------- total de mémoire unique
    section('Statut : un seul total de mémoire, celui que le scanner retient (ComfyUI, sinon nvidia-smi)');
    const keptGpu = engine._gpu;
    try {
      engine._gpu = { name: 'Carte de test', vramUsedGB: 100, vramTotalGB: 94 };
      const live = engine.statusNow().gpu;
      check('sans total retenu (scanner d’avant, bancs) : la valeur lue en direct, comme avant', live.vramTotalGB === 94 && live.vramUsedGB === 94 && !('totalSource' in live), live);
      ctx.models.machine = () => ({ memGB: 109.7, gpu: 'Carte de test', source: 'comfy' });
      const kept = engine.statusNow().gpu;
      check('avec un total retenu : c’est lui (109,7 Go, source comfy), et l’occupation n’est plus bornée à l’autre total', kept.vramTotalGB === 109.7 && kept.totalSource === 'comfy'
        && kept.vramUsedGB === 100 && kept.name === 'Carte de test', kept);
      ctx.models.machine = () => ({ memGB: 94, source: 'smi' });
      check('total venu de nvidia-smi : la source est dite', engine.statusNow().gpu.totalSource === 'smi' && engine.statusNow().gpu.vramTotalGB === 94);
      ctx.models.machine = () => null;
      const none = engine.statusNow().gpu;
      ctx.models.machine = () => { throw new Error('scanner en panne'); };
      check('total retenu vide, ou scanner en panne : la valeur en direct, aucune erreur', none.vramTotalGB === 94 && !('totalSource' in none) && engine.statusNow().gpu.vramTotalGB === 94);
      delete ctx.models.machine;
      const seen = [];
      check('une lecture sans scanner pour la retenir : ignorée sans erreur', engine.noteMachine({ source: 'smi', memGB: 94 }) === undefined);
      ctx.models.noteMachine = (reading) => { seen.push(reading); };
      engine.noteMachine({ source: 'comfy', memGB: 109.7, gpu: 'Carte de test' });
      check('le moteur transmet ses lectures au scanner', seen.length === 1 && seen[0].source === 'comfy' && seen[0].memGB === 109.7);
      // nvidia-smi (lecture seule) : quand il répond, sa lecture part au scanner avec sa source ; absent, rien ne part
      seen.length = 0;
      engine._gpu = { name: null, vramUsedGB: null, vramTotalGB: null };
      await engine.smi();
      check('nvidia-smi : sa lecture (source smi, total > 0, nom de la carte) part au scanner — ou rien s’il est absent',
        engine._gpu.vramTotalGB == null ? seen.length === 0
          : seen.length === 1 && seen[0].source === 'smi' && seen[0].memGB === engine._gpu.vramTotalGB && seen[0].memGB > 0 && seen[0].gpu === engine._gpu.name, seen);
      // le vrai tour de statut (tick) : ComfyUI « allumé » (réponse /system_stats fabriquée, aucun appel réseau) →
      // son total part au scanner avec la source « comfy ». C'est ce câblage qui alimente le total unique.
      const keptComfy = { state: engine.comfy.state, lastStats: engine.comfy.lastStats, refresh: engine.comfy.refresh, busyOther: engine.comfy.busyOther };
      try {
        seen.length = 0;
        engine.comfy.refresh = async () => {};
        engine.comfy.busyOther = async () => false;
        engine.comfy.state = 'running';
        engine.comfy.lastStats = { devices: [{ name: 'cuda:0 NVIDIA N1X : cudaMallocAsync', vram_total: 117790000000, vram_free: 100e9, torch_vram_total: 0, torch_vram_free: 0 }] };
        engine._smiAt = Date.now();                       // pas de nvidia-smi pendant ce tour
        await engine.tick();
        const fromComfy = seen.filter((x) => x.source === 'comfy');
        check('tick() avec ComfyUI allumé : son total (117 790 000 000 octets → 109,7 Go) part au scanner, source « comfy », carte nommée',
          fromComfy.length === 1 && fromComfy[0].memGB === 109.7 && fromComfy[0].gpu === 'NVIDIA N1X' && engine._gpu.vramTotalGB === 109.7, seen);
        seen.length = 0;
        engine.comfy.state = 'stopped';
        engine._smiAt = Date.now();
        await engine.tick();
        check('tick() avec ComfyUI éteint : aucune lecture « comfy » ne part', seen.every((x) => x.source !== 'comfy'), seen);

        // La mémoire PRISE PAR TOUS LES PROGRAMMES (19/11/2026, en vrai : la puce disait « GPU 2,9 / 94 Go » pendant un
        // entraînement LTX de 46 Go ; nvidia-smi et Windows disaient 46,5). Chiffres réels de /system_stats ce jour-là ;
        // nvidia-smi simulé (opts.smiQuery : la ligne CSV qu'il écrirait).
        const keptHold = engine._hold;
        let smiN = 0;
        let smiLine = 'NVIDIA RTX Spark N1X, 47565, 96256';
        engine.opts.smiQuery = async () => { smiN++; if (smiLine instanceof Error) throw smiLine; return smiLine; };
        ctx.models.machine = () => ({ memGB: 94, gpu: 'NVIDIA RTX Spark N1X', source: 'smi' });
        const SPARK = { name: 'cuda:0 NVIDIA RTX Spark N1X (6144-core Blackwell RTX GPU) : cudaMallocAsync', vram_total: 117808041984, vram_free: 114757939199, torch_vram_total: 100663296, torch_vram_free: 33292288 };
        try {
          engine.comfy.state = 'running';
          engine.comfy.lastStats = { devices: [SPARK] };
          const comfyOnly = require(path.join(MIA, 'electron', 'engine', 'index.js'))._internals.vramUsedGB(SPARK);
          engine._smiAt = 0;
          await engine.tick();
          let g = engine.statusNow().gpu;
          check('RTX Spark, entraînement de 46 Go : ComfyUI seul dit 2,9 ; la jauge dit 46,5 / 94 (nvidia-smi, tous les programmes)',
            comfyOnly === 2.9 && g.vramUsedGB === 46.5 && g.vramTotalGB === 94 && smiN === 1, { comfyOnly, g, smiN });
          // cadence : sans entraînement ni calcul, nvidia-smi toutes les 10 s ; pendant un entraînement, à chaque tour (3 s)
          engine._hold = null;
          engine._smiFastUntil = 0;
          engine._smiAt = Date.now() - 4000;
          await engine.tick();
          const idleN = smiN;
          engine._hold = { held: true, wants: false, qui: 'Mia : Plumo' };
          engine._smiAt = Date.now() - 3100;
          await engine.tick();
          check('nvidia-smi relu à chaque tour (3 s) pendant un entraînement, toutes les 10 s sinon', idleN === 1 && smiN === 2, { idleN, smiN });
          // relecture : le tour lit nvidia-smi APRÈS GET /system_stats, dont la durée varie ; un tour arrivé 2,5 s après
          // la lecture d'avant (requête plus courte que la précédente) la refait quand même (avant : une sur deux, 6 s)
          engine._smiAt = Date.now() - 2500;
          await engine.tick();
          check('pendant un entraînement : relu même si le tour arrive un peu avant 3 s (durée de /system_stats variable)', smiN === 3, smiN);
          // … et la vraie cadence : 10 tours de minuteur (3 s simulées), /system_stats de 80, 20, 90, 10… ms
          {
            const realNow = Date.now;
            let clockT = realNow();
            Date.now = () => clockT;
            const keepRefresh = engine.comfy.refresh;
            const delays = [80, 20, 90, 10, 60, 30, 70, 15, 85, 25];
            const at = [];
            const keepQuery = engine.opts.smiQuery;
            engine.opts.smiQuery = async () => { at.push(clockT); return smiLine; };
            try {
              engine._smiAt = 0;
              for (let k = 0; k < delays.length; k++) {
                const t0 = clockT;
                engine.comfy.refresh = async () => { clockT = t0 + delays[k]; };
                await engine.tick();
                clockT = t0 + 3000;
              }
            } finally {
              Date.now = realNow;
              engine.comfy.refresh = keepRefresh;
              engine.opts.smiQuery = keepQuery;
            }
            check('… 10 tours de 3 s pendant un entraînement : 10 lectures de nvidia-smi (avant : 5, toutes les 6 s)', at.length === 10, at.length);
          }
          // idle : sans entraînement ni calcul (et hors traîne), pas avant 10 s, même à 8,5 s
          engine._hold = null;
          engine._smiFastUntil = 0;
          const nIdle = smiN;
          engine._smiAt = Date.now() - 8500;
          await engine.tick();
          check('sans entraînement ni calcul : nvidia-smi pas relu à 8,5 s (toutes les 10 s)', smiN === nIdle, smiN - nIdle);
          // traîne : l'entraînement vient de rendre le GPU, sa mémoire tombe : relu à chaque tour encore 15 s
          engine._hold = { held: true, wants: false, qui: 'Mia : Plumo' };
          const fast = engine.smiEveryMs();
          engine._hold = null;
          const tail = engine.smiEveryMs();
          engine._smiFastUntil = Date.now() - 1;
          const after = engine.smiEveryMs();
          check('fin d’un entraînement : nvidia-smi relu à chaque tour encore 15 s (3 s), puis toutes les 10 s', fast === 3000 && tail === 3000 && after === 10000, { fast, tail, after });
          engine._hold = keptHold;
          engine._smiFastUntil = 0;
          // la lecture ComfyUI plus grande (PC classique, ou nvidia-smi en retard) : elle l'emporte ; bornée au total
          ctx.models.machine = () => ({ memGB: 24, gpu: 'RTX 4090', source: 'comfy' });
          engine.comfy.lastStats = { devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync', vram_total: 24 * 2 ** 30, vram_free: 4 * 2 ** 30, torch_vram_free: 0 }] };
          smiLine = 'NVIDIA GeForce RTX 4090, 18432, 24564';
          engine._smiAt = 0;
          await engine.tick();
          g = engine.statusNow().gpu;
          check('PC classique : le plus grand des deux (ComfyUI 20, nvidia-smi 18 → 20), total de la machine', g.vramUsedGB === 20 && g.vramTotalGB === 24, g);
          smiLine = 'NVIDIA GeForce RTX 4090, 30000, 24564';
          engine._smiAt = 0;
          await engine.tick();
          check('… jamais au-delà du total de la machine', engine.statusNow().gpu.vramUsedGB === 24, engine.statusNow().gpu);
          // relecture : ComfyUI libère un modèle (20 → 2 Go) entre deux lectures de nvidia-smi (sans calcul : toutes les
          // 10 s) ; le plus grand des deux gardait 20 jusqu'à la lecture suivante. Sa lecture bouge : nvidia-smi relu aussitôt.
          const dev4090 = (freeGiB) => ({ name: 'cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync', vram_total: 24 * 2 ** 30, vram_free: freeGiB * 2 ** 30, torch_vram_free: 0 });
          engine._hold = null;
          engine._smiFastUntil = 0;
          engine.comfy.lastStats = { devices: [dev4090(4)] };
          smiLine = 'NVIDIA GeForce RTX 4090, 20480, 24564';
          engine._smiAt = 0;
          await engine.tick();
          const before = engine.statusNow().gpu.vramUsedGB;
          const nFree = smiN;
          engine.comfy.lastStats = { devices: [dev4090(22)] };
          smiLine = 'NVIDIA GeForce RTX 4090, 2048, 24564';
          engine._smiAt = Date.now();                      // nvidia-smi pas encore dû (10 s)
          await engine.tick();
          g = engine.statusNow().gpu;
          check('PC classique, modèle libéré (ComfyUI 20 → 2) : la jauge tombe à 2 tout de suite, pas 20 pendant 10 s', before === 20 && g.vramUsedGB === 2 && smiN === nFree + 1, { before, g, n: smiN - nFree });
          engine._smiAt = Date.now();
          await engine.tick();
          check('… lecture ComfyUI stable : nvidia-smi pas relu avant son heure', smiN === nFree + 1, smiN - nFree);
          // relecture : deux cartes NVIDIA. nvidia-smi les liste dans l'ordre PCI (3060 d'abord), ComfyUI calcule sur la 4090
          // (cuda:0) : la jauge lit la ligne de la 4090, pas la première (avant : 11 Go de la 3060 sur la jauge de la 4090)
          engine.comfy.lastStats = { devices: [dev4090(20)] };   // ComfyUI : 4 Go
          smiLine = 'NVIDIA GeForce RTX 3060, 11264, 12288\nNVIDIA GeForce RTX 4090, 5120, 24564';
          engine._smiAt = 0;
          await engine.tick();
          g = engine.statusNow().gpu;
          check('deux cartes : la jauge lit la carte de ComfyUI (4090 : 5 Go), pas la première listée (3060 : 11)', g.vramUsedGB === 5 && g.vramTotalGB === 24 && g.name === 'NVIDIA GeForce RTX 4090', g);
          smiLine = 'NVIDIA GeForce RTX 4090, 11264, 24564\nNVIDIA GeForce RTX 4090, 5120, 24564';
          engine._smiAt = 0;
          await engine.tick();
          g = engine.statusNow().gpu;
          check('… deux cartes du même nom : on ne sait pas laquelle, ComfyUI seul (4 Go)', g.vramUsedGB === 4, g);
          // la RTX Spark liste aussi son NPU, sans chiffres : une seule carte, lue
          ctx.models.machine = () => ({ memGB: 94, gpu: 'NVIDIA RTX Spark N1X', source: 'smi' });
          engine.comfy.lastStats = { devices: [SPARK] };
          smiLine = 'NVIDIA RTX Spark N1X (6144-core Blackwell RTX GPU), 47565, 96256\nNVIDIA NPU, [N/A], [N/A], [N/A]';
          engine._smiAt = 0;
          await engine.tick();
          g = engine.statusNow().gpu;
          check('RTX Spark : la ligne du NPU (« [N/A] ») ne compte pas, la jauge dit 46,5 / 94', g.vramUsedGB === 46.5 && g.vramTotalGB === 94, g);
          engine._hold = keptHold;
          // nvidia-smi sans chiffre (« [N/A] ») ou absent : ComfyUI seul, comme avant, jamais NaN
          ctx.models.machine = () => ({ memGB: 94, gpu: 'NVIDIA RTX Spark N1X', source: 'smi' });
          engine.comfy.lastStats = { devices: [SPARK] };
          engine._smiRead = null;
          smiLine = 'NVIDIA RTX Spark N1X, [N/A], 96256';
          engine._smiAt = 0;
          await engine.tick();
          g = engine.statusNow().gpu;
          check('nvidia-smi sans chiffre (« [N/A] ») : ComfyUI seul, aucun NaN', g.vramUsedGB === 2.9, g);
          smiLine = 'NVIDIA RTX Spark N1X, [N/A], 96256';
          engine.comfy.state = 'stopped';
          engine._smiAt = 0;
          await engine.tick();
          g = engine.statusNow().gpu;
          check('… ComfyUI éteint et « [N/A] » : aucune occupation (null), pas NaN', g.vramUsedGB === null && engine._gpu.vramUsedGB === null, g);
          engine.comfy.state = 'running';
          engine._smiRead = null;
          smiLine = new Error('nvidia-smi absent');
          engine._smiAt = 0;
          await engine.tick();
          check('nvidia-smi absent : ComfyUI seul, et plus relu qu’à son rythme lent', engine.statusNow().gpu.vramUsedGB === 2.9 && typeof engine.smiEveryMs === 'function' && engine.smiEveryMs() === 10000);
          // ComfyUI éteint : nvidia-smi seul, comme avant
          smiLine = 'NVIDIA RTX Spark N1X, 47565, 96256';
          engine.comfy.state = 'stopped';
          engine._smiAt = 0;
          await engine.tick();
          check('ComfyUI éteint : nvidia-smi seul (46,5 / 94)', engine.statusNow().gpu.vramUsedGB === 46.5 && engine.statusNow().gpu.vramTotalGB === 94, engine.statusNow().gpu);
        } finally {
          engine._hold = keptHold;
          delete engine.opts.smiQuery;
          engine._smiRead = null;
          engine._smiFailed = false;
          engine._smiAt = 0;
        }
      } finally {
        engine.comfy.refresh = keptComfy.refresh;
        engine.comfy.busyOther = keptComfy.busyOther;
        engine.comfy.state = keptComfy.state;
        engine.comfy.lastStats = keptComfy.lastStats;
      }
    } finally {
      engine._gpu = keptGpu;
      delete ctx.models.machine;
      delete ctx.models.noteMachine;
    }
  }

  section('Entrée facultative vide (recette) : ignorée avec une note');
  T.log.length = 0;
  r = await run('n_ib', 'preview');
  check('le bloc se lance sans l’image de fin', r.ok && Array.isArray(r.notes) && r.notes.some((n) => /« Image de fin \(conseillée\) » est vide/.test(n)), r);
  end = await waitEnd(r.jobId);
  const ibRec = T.log.find((x) => x.nodeId === 'n_ib');
  check('x.inputs.end absent, x.notes transmis', end.kind === 'done' && ibRec && !('end' in ibRec.inputs) && ibRec.notes.length === 1, ibRec && ibRec.notes);
  check('la note est dans run.json', /est vide/.test(String(end.run && end.run.notes)), end.run && end.run.notes);

  // ================================================================ entrées multiples
  section('Entrées multiples : ordre des fils (hauteur des sources) et maximum');
  T.log.length = 0;
  r = await run('n_ref', 'preview');
  check('10 images pour 9 places (+ un bloc vide) : notes', r.ok && r.notes && r.notes.some((n) => /Seules les 9 premières/.test(n))
    && r.notes.some((n) => /« Référence 0 » est vide/.test(n)), r);
  end = await waitEnd(r.jobId);
  const refRec = T.log.find((x) => x.name === 'ref2v');
  const order = refRec ? refRec.inputs.refs.map((o) => path.basename(o.abs)) : [];
  const wantOrder = YS.map((y, i) => [y, i]).sort((a, b) => a[0] - b[0]).slice(0, 9).map(([, i]) => `r${i}.png`);
  check('9 images, dans l’ordre vertical des blocs sources', end.kind === 'done' && order.join() === wantOrder.join(), order);

  // ================================================================ ETA
  section('ETA : estimation de l’executor pour CETTE entrée × rapport appris');
  T.cfg.sequence = { delay: 100 };
  r = await run('n_seq1');
  const st1 = await waitFor((e) => e.jobId === r.jobId && e.kind === 'start', 3000, 'start seq1');
  await waitEnd(r.jobId);
  check('1er calcul : ETA = estimation de l’executor (2 min pour 1 clip)', st1.eta === 120, st1.eta);
  const tk = engine.timings['sequence|-'];
  check('rapport réel ÷ estimé appris', tk && tk.ratio > 0 && tk.ratios.length === 1, tk);
  r = await run('n_seq3');
  const st3 = await waitFor((e) => e.jobId === r.jobId && e.kind === 'start', 3000, 'start seq3');
  await waitEnd(r.jobId);
  check('2 clips : estimation (4 min) × rapport, pas la durée apprise d’un clip', Math.abs(st3.eta - Math.round(240 * tk.ratio)) <= 1, { eta: st3.eta, want: 240 * tk.ratio });
  // « ≈ 4 min » à côté de « Générer » : la même estimation, demandée avant de lancer, sans rien mettre en file
  const jobsBefore = engine.jobs.size;
  const e3 = await invoke('engine:estimate', { projectId: 'p_test', nodeId: 'n_seq3', graph: clone(graph) });
  const tkNow = engine.timings['sequence|-'];          // le rapport appris après les deux calculs
  check('avant de lancer : la durée prévue (estimation × rapport appris), apprise de ce PC',
    e3.ok && Math.abs(e3.seconds - Math.round(240 * tkNow.ratio)) <= 1 && e3.learned === true && engine.jobs.size <= jobsBefore,
    { e3, want: 240 * tkNow.ratio, jobs: engine.jobs.size });
  const eNo = await invoke('engine:estimate', { projectId: 'p_test', nodeId: 'n_txt', graph: clone(graph) });
  const eBad = await invoke('engine:estimate', { projectId: 'p_absent', nodeId: 'n_seq3', graph: clone(graph) });
  check('une Consigne sans réécriture, un projet inconnu : pas de durée', !eNo.ok && !eBad.ok, { eNo, eBad });
  check('VRAM : réservé de torch retiré ; chiffres incohérents → null', I.vramUsedGB({ vram_total: 24 * 2 ** 30, vram_free: 10 * 2 ** 30, torch_vram_free: 2 * 2 ** 30 }) === 16
    && I.vramUsedGB({ vram_total: 24 * 2 ** 30, vram_free: 34 * 2 ** 30 }) === null);
  T.cfg = {};

  // ================================================================ fichiers partiels
  section('Version annulée ou en erreur : run.json + log.txt, le reste à la Corbeille');
  T.cfg.depth = { delay: 3000, partial: true };
  trashed.length = 0;
  r = await run('n_dep');
  await waitFor((e) => e.jobId === r.jobId && e.kind === 'start', 3000, 'start');
  await wait(200);
  await invoke('engine:cancel', r.jobId);
  end = await waitEnd(r.jobId, 4000);
  const cdir = path.join(curDir, 'outputs', 'n_dep', end.run.runId);
  check('annulé : seuls run.json et log.txt restent', fs.readdirSync(cdir).sort().join() === 'log.txt,run.json', fs.readdirSync(cdir));
  check('fichiers partiels à la Corbeille, en un seul dossier', trashed.length === 1 && /partiel_r_/.test(path.basename(trashed[0])), trashed);
  T.cfg.depth = { partial: true, fail: 'Échec avec fichier partiel' };
  r = await run('n_dep');
  end = await waitEnd(r.jobId, 4000);
  const edir = path.join(curDir, 'outputs', 'n_dep', end.run.runId);
  check('erreur : seuls run.json et log.txt restent', end.kind === 'error' && fs.readdirSync(edir).sort().join() === 'log.txt,run.json', fs.readdirSync(edir));
  check('jamais de run.json.tmp ; journal vide après des fins normales', !fs.existsSync(path.join(edir, 'run.json.tmp'))
    && readJsonSafe(ctx.engineOpts.journalFile).active.length === 0);
  T.cfg = {};

  // ================================================================ Python GPU : VRAM
  section('Calcul Python GPU : VRAM de ComfyUI rendue avant, verrou tenu');
  if (!fs.existsSync(LAB_PY)) {
    console.log('  (Python du labo absent : sauté)');
  } else {
    freed.length = 0;
    T.cfg.cutout = { py: true };
    node('n_cut').params.feather = 7;
    r = await run('n_cut');
    end = await waitEnd(r.jobId, 20000);
    const cutRec = T.log.filter((x) => x.name === 'cutout').pop();
    check('POST /free demandé une fois, verrou de Mia tenu', end.kind === 'done' && freed.length === 1 && freed[0].lock
      && freed[0].lock.app === 'Mia' && freed[0].lock.pid === process.pid, freed);
    check('x.py.run passe par le worker', cutRec && cutRec.py && cutRec.py.model === 'Faux');
    const cutLog = fs.readFileSync(path.join(curDir, end.run.log), 'utf8');
    check('journal Python dans log.txt (fichier tenu ouvert)', /une ligne de bibliothèque/.test(cutLog) && /POST \/free/.test(cutLog));
    T.cfg = {};
  }

  // ================================================================ verrou : chemin capturé
  section('Verrou : rendu là où il a été pris (engineRoot changé pendant le calcul)');
  T.cfg.depth = { delay: 700 };
  r = await run('n_dep');
  await waitFor((e) => e.jobId === r.jobId && e.kind === 'start', 3000, 'start');
  check('verrou pris sous l’ancien dossier', fs.existsSync(lockPath));
  curLock = lockPath2;
  end = await waitEnd(r.jobId, 4000);
  await wait(50);
  check('rendu à l’endroit pris, rien écrit au nouveau', end.kind === 'done' && !fs.existsSync(lockPath) && !fs.existsSync(lockPath2));
  curLock = lockPath;
  T.cfg = {};

  // ================================================================ projet renommé / à la corbeille
  section('Projet renommé ou mis à la Corbeille pendant un calcul');
  const foreign = () => fs.writeFileSync(curLock, JSON.stringify({ qui: 'Autre session : rendu', minutes: 10, debut: Date.now() / 1000, depuis: '20:00' }));
  foreign();
  T.cfg.depth = { delay: 800 };
  r = await run('n_dep');
  await waitFor((e) => e.jobId === r.jobId && e.kind === 'waiting-gpu', 3000, 'waiting-gpu');
  check('projectBusy vrai pendant l’attente', ctx.engine.projectBusy('p_test') === true);
  const movedDir = path.join(tmp, 'Projet Renommé');
  fs.renameSync(curDir, movedDir);
  curDir = movedDir;
  fs.rmSync(curLock);
  await waitFor((e) => e.jobId === r.jobId && e.kind === 'start', 4000, 'start après renommage');
  let moveErr = null;
  try { fs.renameSync(curDir, path.join(tmp, 'Projet Bis')); } catch (e) { moveErr = e.code; }
  if (!moveErr) fs.renameSync(path.join(tmp, 'Projet Bis'), curDir);
  end = await waitEnd(r.jobId, 5000);
  check('renommé pendant l’attente : le calcul suit le projet (par son id)', end.kind === 'done' && end.run
    && fs.existsSync(path.join(movedDir, ...end.run.outputs.depth.path.split('/'))), end.message);
  check('aucun dossier fantôme à l’ancien nom', !fs.existsSync(projectDir));
  check('pendant le calcul, Windows refuse de déplacer le dossier (log.txt ouvert)', moveErr === 'EPERM' || moveErr === 'EBUSY', moveErr);
  check('projectBusy faux après la fin', ctx.engine.projectBusy('p_test') === false);
  foreign();
  r = await run('n_dep');
  await waitFor((e) => e.jobId === r.jobId && e.kind === 'waiting-gpu', 3000, 'waiting-gpu 2');
  const binDir = path.join(tmp, 'Corbeille simulée');
  fs.renameSync(curDir, binDir);
  curDir = null;
  fs.rmSync(curLock);
  end = await waitEnd(r.jobId, 4000);
  check('mis à la Corbeille pendant l’attente : erreur claire, rien recréé', end.kind === 'error' && /Projet introuvable/.test(end.message)
    && !fs.existsSync(movedDir) && !fs.existsSync(projectDir), end.message);
  fs.renameSync(binDir, projectDir);
  curDir = projectDir;
  T.cfg.depth = { delay: 3000 };
  r = await run('n_dep');
  await waitFor((e) => e.jobId === r.jobId && e.kind === 'start', 3000, 'start cancelProject');
  const cp = await ctx.engine.cancelProject('p_test');
  check('cancelProject : annule et attend la fin', cp.ok && cp.cancelled >= 1 && !ctx.engine.projectBusy('p_test'), cp);
  T.cfg = {};
  await idle();

  // ================================================================ consigne réécrite en anglais
  section('Consigne « Réécrire en anglais » : un calcul du bloc Consigne, refait seulement quand le texte change');
  graph.nodes.push({ id: 'n_rwt', type: 'text', x: 0, y: 5000, params: { text: 'une epave sur la plage', negative: 'blur', rewrite: true } });
  graph.nodes.push({ id: 'n_rwi', type: 'i2v', x: 400, y: 5000, params: {} });
  graph.edges.push({ id: 'erw1', from: { node: 'n_imp', port: 'out' }, to: { node: 'n_rwi', port: 'start' } });
  graph.edges.push({ id: 'erw2', from: { node: 'n_rwt', port: 'text' }, to: { node: 'n_rwi', port: 'prompt' } });
  const rewrites = () => T.log.filter((x) => x.name === 'rewrite').length;
  T.log.length = 0;
  r = await run('n_rwi', 'preview');
  check('l’aval se lance (la consigne tapée passe les contrôles)', r.ok, r);
  end = await waitEnd(r.jobId);
  let rwi = T.log.find((x) => x.nodeId === 'n_rwi');
  check('réécriture faite avant, sur le bloc Consigne', rewrites() === 1 && T.log[0].name === 'rewrite' && T.log[0].nodeId === 'n_rwt', T.log.map((x) => x.name));
  check('l’aval reçoit le texte réécrit et « À éviter » tel quel', end.kind === 'done' && rwi && rwi.inputs.prompt.text === 'EN: UNE EPAVE SUR LA PLAGE'
    && rwi.inputs.prompt.negative === 'blur' && rwi.inputs.prompt.original === 'une epave sur la plage', rwi && rwi.inputs.prompt);
  check('le réglage écrasé par le fil aussi (x.params.prompt)', rwi && rwi.params.prompt === 'EN: UNE EPAVE SUR LA PLAGE', rwi && rwi.params.prompt);
  check('la version de l’aval garde le texte envoyé', /Consigne réécrite en anglais : « EN: UNE EPAVE SUR LA PLAGE »/.test(String(end.run && end.run.notes)), end.run && end.run.notes);
  const rwDirs = runDirs('n_rwt');
  const rwRun = rwDirs.length ? readJsonSafe(path.join(projectDir, 'outputs', 'n_rwt', rwDirs[0], 'run.json')) : null;
  check('la réécriture est une version du bloc Consigne (texte, sans sonde ffmpeg)', rwDirs.length === 1 && rwRun && rwRun.status === 'done'
    && rwRun.outputs.text.kind === 'text' && rwRun.outputs.text.meta.text === 'EN: UNE EPAVE SUR LA PLAGE' && rwRun.params.text === 'une epave sur la plage', rwRun);
  r = await run('n_rwi', 'final');
  end = await waitEnd(r.jobId);
  check('même texte : réécriture reprise, pas refaite', end.kind === 'done' && rewrites() === 1, rewrites());
  node('n_rwt').params.negative = 'text';
  r = await run('n_rwi', 'final');
  check('« À éviter » changé : l’aval recalcule…', r.ok && r.jobId, r);
  end = await waitEnd(r.jobId);
  rwi = T.log.filter((x) => x.nodeId === 'n_rwi').pop();
  check('… sans refaire la réécriture', end.kind === 'done' && rewrites() === 1 && rwi.inputs.prompt.negative === 'text', rewrites());
  node('n_rwt').params.text = 'un phare';
  r = await run('n_rwi', 'final');
  end = await waitEnd(r.jobId);
  check('texte changé : réécrit de nouveau', end.kind === 'done' && rewrites() === 2 && T.log.filter((x) => x.nodeId === 'n_rwi').pop().inputs.prompt.text === 'EN: UN PHARE', rewrites());
  r = await run('n_rwt');
  check('« Réécrire maintenant » : le bloc Consigne se lance seul', r.ok && r.jobId, r);
  end = await waitEnd(r.jobId);
  check('… et fait une version', end.kind === 'done' && rewrites() === 3 && runDirs('n_rwt').length === 3, runDirs('n_rwt'));
  node('n_rwt').params.rewrite = false;
  r = await run('n_rwt');
  check('case décochée : la Consigne ne se lance pas', !r.ok && /Réécrire en anglais/.test(r.error || ''), r);
  r = await run('n_rwi', 'preview');
  end = await waitEnd(r.jobId);
  check('case décochée : l’aval reçoit le texte tapé', end.kind === 'done' && rewrites() === 3
    && T.log.filter((x) => x.nodeId === 'n_rwi').pop().inputs.prompt.text === 'un phare', rewrites());
  node('n_rwt').params.rewrite = true;
  node('n_rwt').params.text = '   ';
  r = await run('n_rwt');
  check('consigne vide : « Écris une consigne »', !r.ok && /Écris une consigne/.test(r.error || ''), r);
  node('n_rwt').params.text = 'une tempete';
  T.cfg.rewrite = { fail: 'La réécriture n’a rien donné de lisible.' };
  r = await run('n_rwi', 'preview');
  end = await waitEnd(r.jobId);
  check('réécriture ratée : l’aval s’arrête avec le nom de la Consigne', end.kind === 'error' && /Consigne/.test(end.message || end.error || ''), end);
  T.cfg = {};
  await idle();

  // ================================================================ API pour le pont
  section('API du moteur pour le pont des assistants (ctx.engine)');
  T.cfg.depth = { delay: 300 };
  let a1 = await ctx.engine.run({ projectId: 'p_test', nodeId: 'n_dep', graph: clone(graph) });
  const wa1 = await ctx.engine.wait(a1.jobId, 10);
  check('wait(jobId) → état final + sorties en chemins absolus', wa1.ok && wa1.state === 'done' && path.isAbsolute(wa1.outputs.depth.abs)
    && fs.existsSync(wa1.outputs.depth.abs), wa1);
  const wa2 = await ctx.engine.wait('n_dep', 5, { projectId: 'p_test' });
  check('wait(nodeId) d’un bloc fini → son dernier résultat', wa2.ok && wa2.jobId === a1.jobId);
  T.cfg.depth = { delay: 4000 };
  a1 = await ctx.engine.run({ projectId: 'p_test', nodeId: 'n_dep', graph: clone(graph) });
  const wa3 = await ctx.engine.wait({ jobId: a1.jobId, timeoutS: 1 });
  check('wait : délai dépassé → timeout', wa3.ok === false && wa3.timeout === true && wa3.job && wa3.job.jobId === a1.jobId, wa3);
  ctx.engine.cancel(a1.jobId);
  const wa4 = await ctx.engine.wait(a1.jobId, 5);
  check('wait après annulation → cancelled', wa4.state === 'cancelled' && wa4.ok === false, wa4);
  check('jobList() liste les calculs', Array.isArray(ctx.engine.jobList()) && ctx.engine.jobList().some((j) => j.jobId === a1.jobId));
  const ctxGetter = { ...ctx, ipcMain: { handle: () => {} }, engineOpts: { ...ctx.engineOpts, noOrphanCheck: true } };
  let held = null;
  Object.defineProperty(ctxGetter, 'engine', { get: () => held, enumerable: true });
  let regErr = null;
  try { held = register(ctxGetter); await held.ready; held.dispose(); } catch (e) { regErr = e.message; }
  check('ctx.engine en lecture seule (main.js) : register() ne plante pas', !regErr && ctxGetter.engine === held, regErr);
  T.cfg = {};
  await idle();

  // ================================================================ corbeille
  section('Corbeille d’une version');
  const vers = await invoke('engine:runs', 'p_test', 'n_dep');
  const del = await invoke('engine:deleteRun', 'p_test', 'n_dep', vers[0].runId);
  check('deleteRun', del.ok && (await invoke('engine:runs', 'p_test', 'n_dep')).length === vers.length - 1);
  const bad = await invoke('engine:deleteRun', 'p_test', 'n_dep', '..');
  check('deleteRun refuse un chemin douteux', bad.ok === false);

  // ================================================================ statut
  section('Statut (GET ComfyUI + verrou + file)');
  const s = await invoke('engine:status');
  check('forme du statut', s && s.comfy && typeof s.comfy.state === 'string' && 'url' in s.comfy && 'managedByMia' in s.comfy
    && 'minimax' in s.comfy && s.gpu && 'vramUsedGB' in s.gpu && 'busyOther' in s.gpu && s.queue && s.queue.running === 0, s);
  console.log(`        ComfyUI : ${s.comfy.state} ${s.comfy.version || ''} · GPU : ${s.gpu.name || '?'} ${s.gpu.vramUsedGB ?? '?'} / ${s.gpu.vramTotalGB ?? '?'} Go`);
  check('ComfyUI lancé par Mia ? non', s.comfy.managedByMia === false);
  check('événements engine:status poussés', sent.some((x) => x.ch === 'engine:status') && sent.some((x) => x.ch === 'engine:event'));

  // un job en ligne qui réencode en local (x.localWork) compte comme un léger : un lourd l'attend
  section('Job en ligne : réencodage local (localWork) compté comme un léger');
  {
    const fake = { jobId: 'j_fake', _: { active: true, gpu: 'none', online: true, abort: new AbortController() } };
    engine.jobs.set(fake.jobId, fake);
    try {
      check('en ligne seul : pas compté comme léger', engine.lightActive() === 0);
      let during = -1;
      const back = await engine.localWork(fake, async () => { during = engine.lightActive(); return 42; });
      check('pendant le réencodage : compté comme léger', during === 1, during);
      check('localWork rend la valeur de fn', back === 42, back);
      check('après : plus compté', engine.lightActive() === 0 && !fake._.localWork);
    } finally { engine.jobs.delete(fake.jobId); }
  }
  // ================================================================ entraînement LoRA : la porte du GPU
  section('Entraînement LoRA : holdGpu attend les calculs en cours, tient le verrou, retient la file');
  {
    const LABEL = 'Mia : Entraînement LoRA Rosa (LTX 2.5)';
    // faux service d'entraînement : ce que le moteur en lit (brief), son dernier filet (killSync), ses changements
    const tr = {
      info: null, killed: 0, fns: new Set(),
      brief() { return this.info; },
      killSync() { this.killed++; },
      onChange(fn) { this.fns.add(fn); return () => this.fns.delete(fn); },
      set(v) { this.info = v; for (const fn of this.fns) fn(v ? v.id : null); }
    };
    const rosa = (state, phase, extra = {}) => ({ id: 't_rosa', name: 'Rosa', base: 'ltx25', state, phase: phase || null, step: 0, steps: 2500, progress: 0, endAt: null, ...extra });
    const jobOf = (x) => engine.jobs.get(x.jobId);
    const started = (x) => events.some((e) => e.jobId === x.jobId && e.kind === 'start');
    const accepted = (x, what) => { if (!x || !x.ok || !x.jobId) check(`${what} accepté`, false, x); return x; };
    engine.attachTrainer(tr);
    check('statut au repos : training null', (await invoke('engine:status')).training === null);
    check('file vide : localIdle, personne n’attend un entraînement', engine.localIdle() === true && engine.waitingForGpu() === 0);
    check('heure de fin écrite comme dans la fenêtre : « 3 h 05 » / "03:05"', I.clock(new Date(2026, 10, 19, 3, 5).getTime(), 'fr') === '3 h 05'
      && I.clock(new Date(2026, 10, 19, 3, 5).getTime(), 'en') === '03:05' && I.clock(new Date(2026, 10, 19, 23, 40).getTime(), 'fr') === '23 h 40');

    // 1) un calcul lourd tourne : la porte l'attend, puis passe avant le lourd suivant
    freed.length = 0;
    T.log.length = 0;
    T.cfg.depth = { delay: 500 };
    T.cfg.cutout = { delay: 150 };
    node('n_dep').params.invert = 'lora-1';
    const h1 = accepted(await run('n_dep'), 'lourd 1');
    await waitFor((e) => e.jobId === h1.jobId && e.kind === 'start', 4000, 'départ du lourd');
    const waits = [];
    let minutesLeft = 260;
    let handle = null;
    const pHold = engine.holdGpu({ label: LABEL, minutes: () => minutesLeft, onWait: (who, since) => waits.push([who, since]) }).then((h) => { handle = h; });
    tr.set(rosa('attente'));
    node('n_cut').params.feather = 11;
    const h2 = accepted(await run('n_cut'), 'lourd 2');
    await wait(120);
    const lk0 = readJsonSafe(lockPath);
    check('porte demandée pendant un lourd : pas encore tenue, le verrou reste au calcul', handle === null && lk0 && /^Mia : .*\(Projet Test\)$/.test(lk0.qui), lk0);
    check('onWait(null, "") : un calcul de Mia se termine', waits.length === 1 && waits[0][0] === null && waits[0][1] === '', waits);
    check('le lourd suivant attend derrière l’entraînement, nommé', jobOf(h2) && jobOf(h2).state === 'queued'
      && jobOf(h2).message === 'En file : l’entraînement « Rosa » passe d’abord', jobOf(h2) && jobOf(h2).message);
    check('waitingForGpu compte ce calcul ; la file locale n’est pas vide', engine.waitingForGpu() === 1 && engine.localIdle() === false, engine.waitingForGpu());
    await pHold;
    const depRec = T.log.find((x) => x.name === 'depth');
    const lk1 = readJsonSafe(lockPath);
    check('porte tenue seulement après la fin du lourd', !!handle && depRec && depRec.end > 0 && events.some((e) => e.jobId === h1.jobId && e.kind === 'done'), depRec && depRec.end);
    check('verrou : libellé de l’entraînement, écrit par Mia', lk1 && lk1.qui === LABEL && lk1.app === 'Mia' && lk1.pid === process.pid && handle.file === lockPath, lk1);
    check('verrou : 30 minutes au plus, même s’il en reste 260', lk1 && lk1.minutes === 30 && I.HOLD_MAX_MIN === 30, lk1 && lk1.minutes);
    check('VRAM de ComfyUI rendue une fois, verrou de l’entraînement en main', freed.length === 1 && freed[0].lock && freed[0].lock.qui === LABEL, freed);
    check('le lourd en attente n’est pas parti', !started(h2) && !T.log.some((x) => x.name === 'cutout'));

    // 2) entraînement en cours : statut, message, ce qui passe et ce qui attend
    const endAt = Date.now() + 2 * 3600 * 1000;
    tr.set(rosa('entrainement', 'train', { step: 1240, progress: 0.496, endAt }));
    await wait(80);
    const st1 = await invoke('engine:status');
    check('statut : training = l’entraînement actif', st1.training && st1.training.id === 't_rosa' && st1.training.name === 'Rosa' && st1.training.base === 'ltx25'
      && st1.training.state === 'entrainement' && st1.training.step === 1240 && st1.training.steps === 2500 && st1.training.progress === 0.496 && st1.training.endAt === endAt, st1.training);
    check('statut : le verrou est celui de Mia', st1.gpu.lock && st1.gpu.lock.who === LABEL && st1.gpu.lock.mine === true && st1.gpu.busyOther === false, st1.gpu.lock);
    check('message d’attente avec l’heure de fin', jobOf(h2).message === `En file : entraînement « Rosa » en cours (fin vers ${I.clock(endAt, 'fr')})`, jobOf(h2).message);
    check('message en anglais', engine.tr('waitTrainingEnd', { name: 'Rosa', at: '03:40' }, 'en') === 'Queued: training “Rosa” is running (ends around 03:40)'
      && engine.tr('waitTraining', { name: 'Rosa' }, 'en') === 'Queued: training “Rosa” is running' && engine.tr('waitTrainingSoon', { name: 'Rosa' }, 'en') === 'Queued: training “Rosa” goes first');
    T.cfg.resize = { delay: 100 };
    T.cfg.frame = { delay: 100 };
    T.cfg.gen = { delay: 100 };
    node('n_rszv').params.size = 'x2';
    const l1 = accepted(await run('n_rszv'), 'léger 1');
    node('n_frm').params.at = 1;
    const n1 = accepted(await run('n_frm'), 'sans GPU 1');
    const n1End = await waitEnd(n1.jobId, 4000);
    check('un calcul sans GPU (gpu : none) passe pendant l’entraînement', n1End.kind === 'done' && !!engine._hold && engine._hold.held);
    check('un calcul léger attend, même message', jobOf(l1) && jobOf(l1).state === 'queued' && !started(l1)
      && /^En file : entraînement « Rosa » en cours \(fin vers /.test(jobOf(l1).message), jobOf(l1) && jobOf(l1).message);
    check('deux calculs attendent le GPU', engine.waitingForGpu() === 2, engine.waitingForGpu());
    minutesLeft = 12;
    const debut1 = readJsonSafe(lockPath).debut;
    await wait(420);                                   // renewMs = 120 dans ce banc
    const lk2 = readJsonSafe(lockPath);
    check('verrou réécrit régulièrement, avec min(reste, 30) minutes', lk2 && lk2.qui === LABEL && lk2.debut > debut1 && lk2.minutes === 12, lk2);

    // 3) chargement du modèle : plus rien ne part, sauf les calculs en ligne
    tr.set(rosa('preparation', 'load'));
    node('n_frm2').params.at = 2;
    const n2 = accepted(await run('n_frm2'), 'sans GPU 2');
    ctx.cloud = { linked: () => true };
    graph.nodes.push({ id: 'n_onLora', type: 'gen', x: 1600, y: 5000, params: { model: 'hf:seedance-2-5', prompt: 'plan en ligne pendant un entraînement' } });
    const o1 = accepted(await run('n_onLora'), 'en ligne');
    const fakeOnline = { state: 'queued', online: true, _: { abort: new AbortController(), active: false, gpu: 'none', online: true } };
    let idleAt = 0;
    const pIdle = engine.whenGpuIdle(fakeOnline).then(() => { idleAt = Date.now(); });
    const o1End = await waitEnd(o1.jobId, 4000);
    await wait(250);
    check('chargement du modèle : même un calcul sans GPU attend', jobOf(n2) && jobOf(n2).state === 'queued' && !started(n2)
      && /^En file : entraînement « Rosa » en cours/.test(jobOf(n2).message), jobOf(n2) && jobOf(n2).message);
    check('chargement : la conversion locale d’un calcul en ligne attend aussi (whenGpuIdle)', idleAt === 0);
    check('chargement : un calcul en ligne, lui, n’est pas touché', o1End.kind === 'done');
    const loadEnd = Date.now();
    tr.set(rosa('entrainement', 'train', { step: 1, endAt }));
    const n2End = await waitEnd(n2.jobId, 4000);
    await pIdle;
    check('chargement fini : le calcul sans GPU part tout seul', n2End.kind === 'done');
    check('… et la conversion locale reprend', idleAt >= loadEnd, { idleAt, loadEnd });
    delete ctx.cloud;

    // 4) une seule porte à la fois
    let twice = null;
    try { await engine.holdGpu({ label: 'Mia : Entraînement LoRA Aida (Qwen-Image 2.1)', minutes: () => 5 }); } catch (e) { twice = e.message; }
    check('une deuxième porte est refusée', twice === 'Un entraînement tient déjà le GPU.' && readJsonSafe(lockPath).qui === LABEL, twice);

    // 5) rendre : le verrou part, la file repart
    const rel = handle.release();
    tr.set(null);
    check('rendre : le verrou de l’entraînement part', rel === true && engine._hold === null && (readJsonSafe(lockPath) || {}).qui !== LABEL);
    const [h2End, l1End] = await Promise.all([waitEnd(h2.jobId, 6000), waitEnd(l1.jobId, 6000)]);
    const cutRec2 = T.log.find((x) => x.name === 'cutout');
    check('les calculs en attente partent ensuite, le lourd avec son propre verrou', h2End.kind === 'done' && l1End.kind === 'done'
      && cutRec2 && cutRec2.lock && /\(Projet Test\)$/.test(cutRec2.lock.qui), cutRec2 && cutRec2.lock);
    check('rendre deux fois ne fait rien', handle.release() === false);
    await idle();
    check('à la fin : verrou libre, statut sans entraînement, plus personne en attente', !fs.existsSync(lockPath)
      && (await invoke('engine:status')).training === null && engine.waitingForGpu() === 0 && engine.localIdle());

    // 6) la porte attend aussi un calcul léger en cours
    T.cfg.resize = { delay: 500 };
    node('n_rszv').params.size = 'x0.5';
    const l2 = accepted(await run('n_rszv'), 'léger 2');
    await waitFor((e) => e.jobId === l2.jobId && e.kind === 'start', 4000, 'départ du léger');
    const waits2 = [];
    const hB = await engine.holdGpu({ label: LABEL, minutes: () => 5, onWait: (who, since) => waits2.push([who, since]) });
    const rsRec = T.log.filter((x) => x.name === 'resize').pop();
    check('la porte attend la fin d’un calcul léger', !!hB && rsRec && rsRec.end > 0 && events.some((e) => e.jobId === l2.jobId && e.kind === 'done')
      && waits2.length === 1 && waits2[0][0] === null, waits2);
    check('verrou : les minutes restantes quand il en reste peu', readJsonSafe(lockPath).minutes === 5, readJsonSafe(lockPath));
    check('rendu', hB.release() === true && !fs.existsSync(lockPath));
    T.cfg.resize = { delay: 60 };

    // 7) GPU pris par une autre session
    fs.writeFileSync(lockPath, JSON.stringify({ qui: 'Claude : essai LTX', minutes: 10, debut: Date.now() / 1000, depuis: '22:10' }));
    const waits3 = [];
    let hC = null;
    const pC = engine.holdGpu({ label: LABEL, minutes: () => 200, onWait: (who, since) => waits3.push([who, since]) }).then((h) => { hC = h; });
    await wait(150);
    check('GPU pris par un autre : onWait(qui, depuis), rien n’est pris', waits3.length === 1 && waits3[0][0] === 'Claude : essai LTX' && waits3[0][1] === '22:10' && hC === null, waits3);
    node('n_rszv').params.size = '1280x720';
    const l3 = accepted(await run('n_rszv'), 'léger 3');
    const l3End = await waitEnd(l3.jobId, 4000);
    check('un léger passe pendant que l’entraînement attend un autre programme', l3End.kind === 'done' && hC === null);
    node('n_dep').params.invert = 'lora-2';
    T.cfg.depth = { delay: 100 };
    const h3 = accepted(await run('n_dep'), 'lourd 3');
    await wait(80);
    check('un lourd reste derrière l’entraînement qui attend', jobOf(h3) && jobOf(h3).state === 'queued' && /passe d’abord/.test(jobOf(h3).message), jobOf(h3) && jobOf(h3).message);
    await wait(300);
    check('le verrou de l’autre n’est jamais touché', readJsonSafe(lockPath).qui === 'Claude : essai LTX' && hC === null);
    fs.rmSync(lockPath);
    const freeAt = Date.now();
    await pC;
    const lk3 = readJsonSafe(lockPath);
    check('libéré : la porte est prise au tour suivant (15 s en vrai, 200 ms ici)', !!hC && Date.now() - freeAt < 2000 && lk3 && lk3.qui === LABEL && lk3.minutes === 30, lk3);
    hC.release();
    const h3End = await waitEnd(h3.jobId, 6000);
    check('porte rendue : le lourd part', h3End.kind === 'done');
    await idle();

    // 8) arrêt pendant l'attente
    fs.writeFileSync(lockPath, 'occupé par un script');
    const ac = new AbortController();
    const pD = engine.holdGpu({ label: LABEL, minutes: () => 5, signal: ac.signal });
    await wait(100);
    ac.abort();
    const hD = await pD;
    check('arrêt pendant l’attente : null, rien de pris, la file n’est plus retenue', hD === null && engine._hold === null
      && fs.readFileSync(lockPath, 'utf8') === 'occupé par un script');
    fs.rmSync(lockPath);

    // 9) un outil sans GPU (le faux outil) : aucun fichier de verrou, mais la file de Mia est retenue
    const nFreed = freed.length;
    const hE = await engine.holdGpu({ label: 'Mia : Entraînement LoRA Essai (Faux modèle)', minutes: () => 1, lockFile: null });
    check('lockFile null : ni fichier de verrou ni POST /free', !!hE && hE.file === null && !fs.existsSync(lockPath) && freed.length === nFreed);
    node('n_dep').params.invert = 'lora-3';
    const h4 = accepted(await run('n_dep'), 'lourd 4');
    await wait(120);
    check('… la file de Mia est retenue quand même (libellé à défaut de nom)', jobOf(h4) && jobOf(h4).state === 'queued' && !started(h4)
      && jobOf(h4).message === 'En file : entraînement « Entraînement LoRA Essai (Faux modèle) » en cours', jobOf(h4) && jobOf(h4).message);
    hE.release();
    const h4End = await waitEnd(h4.jobId, 6000);
    check('… et repart quand la porte est rendue', h4End.kind === 'done' && engine._hold === null);
    await idle();

    // 10) le fichier de verrou demandé par le service
    const hF = await engine.holdGpu({ label: LABEL, minutes: () => 3, lockFile: lockPath2 });
    check('lockFile donné : pris là, pas ailleurs', !!hF && hF.file === lockPath2 && (readJsonSafe(lockPath2) || {}).qui === LABEL && !fs.existsSync(lockPath));
    check('… et rendu là', hF.release() === true && !fs.existsSync(lockPath2));

    // 11) reprise en main après un redémarrage de Mia (adoptGpu, synchrone)
    const gone = await deadPid();
    fs.writeFileSync(lockPath, JSON.stringify({ qui: LABEL, minutes: 30, debut: Date.now() / 1000 - 600, depuis: '21:00', app: 'Mia', pid: gone }));
    const hG = engine.adoptGpu({ label: LABEL, minutes: () => 90 });
    const lkG = readJsonSafe(lockPath);
    check('reprise en main : le verrou d’une Mia disparue est repris sous le même libellé', !!hG && lkG && lkG.qui === LABEL && lkG.pid === process.pid && lkG.minutes === 30
      && engine.lock.cleanOrphan() === false && fs.existsSync(lockPath), lkG);
    check('… la porte est tenue : une autre est refusée', engine._hold && engine._hold.held === true && engine.adoptGpu({ label: LABEL, minutes: () => 1 }) === null);
    check('… rendue', hG.release() === true && !fs.existsSync(lockPath) && engine._hold === null);
    fs.writeFileSync(lockPath, JSON.stringify({ qui: 'Claude : essai LTX', minutes: 10, debut: Date.now() / 1000, depuis: '22:10' }));
    check('reprise en main refusée si un autre a le GPU, son verrou intact', engine.adoptGpu({ label: LABEL, minutes: () => 5 }) === null
      && readJsonSafe(lockPath).qui === 'Claude : essai LTX' && engine._hold === null);
    fs.rmSync(lockPath);
    const hH = engine.adoptGpu({ label: LABEL, minutes: () => 5, lockFile: null });
    check('reprise en main d’un outil sans GPU : aucun fichier', !!hH && hH.file === null && !fs.existsSync(lockPath) && !!engine._hold);
    hH.release();

    // 12) ce qu'un plantage laisse : le fichier reste, plus rien ne le réécrit
    const hI = await engine.holdGpu({ label: LABEL, minutes: () => 5 });
    hI.abandon();
    const debutI = readJsonSafe(lockPath).debut;
    await wait(300);
    check('abandon (banc) : le verrou reste tel quel, la file n’est plus retenue', readJsonSafe(lockPath).debut === debutI && engine._hold === null);
    fs.rmSync(lockPath);

    // 13) CONCEPTION-entrainement §4.4 : verrou en main, POST /free, puis — mémoire engageable toujours sous le seuil —
    //     le ComfyUI que Mia a lancé est arrêté (sa RAM revient à Windows avant que l'outil charge le modèle)
    {
      const order = [];
      const keepFree = engine.comfy.free;
      engine.comfy.free = async () => { order.push(`free:${(readJsonSafe(lockPath) || {}).qui === LABEL ? 'verrou' : 'sans verrou'}`); return true; };
      engine.comfy.stopOwned = async () => { order.push('stop'); return true; };
      let mem = 30;
      const commitGB = async () => { order.push(`commit=${mem}`); return mem; };
      const hJ = await engine.holdGpu({ label: LABEL, minutes: () => 5, needCommitGB: 45, commitGB });
      check('§4.4 : mémoire sous le seuil → POST /free, mesure, puis arrêt du ComfyUI de Mia, verrou en main', !!hJ && order.join() === 'free:verrou,commit=30,stop' && (readJsonSafe(lockPath) || {}).qui === LABEL, order);
      hJ.release();
      order.length = 0; mem = 60;
      const hK = await engine.holdGpu({ label: LABEL, minutes: () => 5, needCommitGB: 45, commitGB });
      check('… assez de mémoire : ComfyUI n’est pas arrêté', !!hK && order.join() === 'free:verrou,commit=60', order);
      hK.release();
      order.length = 0;
      const hL = await engine.holdGpu({ label: LABEL, minutes: () => 5 });
      check('… un modèle sans seuil (Qwen, faux outil) : ni mesure ni arrêt', !!hL && order.join() === 'free:verrou', order);
      hL.release();
      engine.comfy.free = keepFree;

      // avant le départ (train:start refuse sinon) : freeMemoryForTraining n'arrête que ce que Mia a lancé et qui ne fait rien
      order.length = 0;
      Object.defineProperty(engine.comfy, 'managedByMia', { value: true, configurable: true });
      const f1 = await engine.freeMemoryForTraining();
      check('freeMemoryForTraining : ComfyUI lancé par Mia, rien en cours, personne d’autre sur le GPU → arrêté', f1.stopped === true && order.join() === 'stop', { f1, order });
      order.length = 0;
      fs.writeFileSync(lockPath, JSON.stringify({ qui: 'Claude : essai LTX', minutes: 10, debut: Date.now() / 1000, depuis: '22:10' }));
      const f2 = await engine.freeMemoryForTraining();
      fs.rmSync(lockPath);
      engine.localIdle = () => false;
      const f3 = await engine.freeMemoryForTraining();
      delete engine.localIdle;
      Object.defineProperty(engine.comfy, 'managedByMia', { value: false, configurable: true });
      const f4 = await engine.freeMemoryForTraining();
      delete engine.comfy.managedByMia;
      check('… jamais quand une autre session tient le GPU, quand un calcul de Mia tourne ou attend, ni un ComfyUI que Mia n’a pas lancé', !f2.stopped && !f3.stopped && !f4.stopped && order.length === 0, { f2, f3, f4, order });
      delete engine.comfy.stopOwned;                     // la vraie méthode (prototype) revient

      // la vraie méthode de comfy.js, sur un faux processus « ComfyUI » (un Node qui attend) : jamais un ComfyUI qui calcule
      const { spawn: spawnP } = require('node:child_process');
      const c = engine.comfy;
      const keep = { child: c.child, childUrl: c._childUrl, url: c.url, fetchJson: c._fetchJson, state: c.state, lastStats: c.lastStats };
      const fake = spawnP(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
      const exited = new Promise((r) => fake.on('exit', r));
      c.child = fake; c._childUrl = c.url = 'http://127.0.0.1:9';
      let queue = { queue_running: [['1', 'p1']], queue_pending: [] };
      c._fetchJson = async (p) => { if (p === '/queue') return queue; throw new Error('pas ici'); };
      const busy = await c.stopOwned();
      check('comfy.stopOwned : un ComfyUI qui calcule n’est pas arrêté', busy === false && fake.exitCode === null && c.child === fake);
      queue = { queue_running: [], queue_pending: [] };
      const ok = await c.stopOwned();
      const code = await Promise.race([exited, wait(5000).then(() => 'vivant')]);
      check('comfy.stopOwned : file vide → processus arrêté, état « stopped » (pas une erreur), plus géré par Mia', ok === true && code !== 'vivant' && c.child === null && c.url === null && c.state === 'stopped' && c.managedByMia === false, { ok, code, state: c.state });
      check('comfy.stopOwned : un ComfyUI que Mia n’a pas lancé → rien', (await c.stopOwned()) === false);
      Object.assign(c, { child: keep.child, _childUrl: keep.childUrl, url: keep.url, state: keep.state, lastStats: keep.lastStats });
      if (keep.fetchJson === Object.getPrototypeOf(c)._fetchJson) delete c._fetchJson; else c._fetchJson = keep.fetchJson;
    }
    engine.attachTrainer(null);
    T.cfg = {};
  }

  // ================================================================ un calcul à côté d'un entraînement (SPEC §8.7)
  section('Générer pendant un entraînement : un calcul lourd part à côté quand la mémoire mesurée le permet');
  {
    const LABEL = 'Mia : Entraînement LoRA Plumo (LTX 2.5)';
    const notes = [];
    // faux service d'entraînement : brief, onChange, et la ligne « Calcul à côté : … » de ses ÉVÈNEMENTS (noteBeside)
    const tr = {
      info: null, fns: new Set(),
      brief() { return this.info; },
      killSync() {},
      onChange(fn) { this.fns.add(fn); return () => this.fns.delete(fn); },
      set(v) { this.info = v; for (const fn of this.fns) fn(v ? v.id : null); },
      noteBeside(label) { notes.push(label); return true; }
    };
    const endAt = Date.now() + 3 * 3600 * 1000;
    const at = I.clock(endAt, 'fr');
    const plumo = (state, phase, extra = {}) => ({ id: 't_plumo', name: 'Plumo', base: 'ltx25', state, phase: phase || null, step: 600, steps: 2500, progress: 0.24, endAt, ...extra });
    const jobOf = (x) => engine.jobs.get(x.jobId);
    const startOf = (x) => events.find((e) => e.jobId === x.jobId && e.kind === 'start');
    const accepted = (x, what) => { if (!x || !x.ok || !x.jobId) check(`${what} accepté`, false, x); return x; };
    const OLD = `En file : entraînement « Plumo » en cours (fin vers ${at})`;
    // la mémoire : 94 Go au total (RTX Spark), ce que nvidia-smi dirait maintenant (simulé), l'estimation de chaque modèle
    let used = 46;
    let cached = 0;                       // ce que ComfyUI garderait en mémoire après un calcul (rendu par POST /free)
    let measures = 0;
    const mem = { depth: 17, cutout: 10 };
    const memBasis = {};                  // base de l'estimation, 'measured' par défaut (scanner memOf)
    const memAt = {};                     // réglages de la mesure (null par défaut)
    const keepResolve = ctx.models.resolve;
    ctx.models.resolve = (value, caps) => {
      const m = keepResolve(value, caps);
      const k = m && caps && caps[0];
      if (m && mem[k] != null) m.mem = { gb: mem[k], basis: memBasis[k] || 'measured', at: memAt[k] || null };
      return m;
    };
    const keepGet = ctx.prefs.get;
    engine.machine = () => ({ memGB: 94, gpu: 'NVIDIA RTX Spark', source: 'smi' });
    // l'entraînement est « posé » d'emblée dans les cas 1 à 7 (BESIDE_SETTLE_* : testé à part, cas 10)
    Object.assign(engine.opts, { gpuUsedGB: async () => { measures++; return used + cached; }, besideFreshMs: 40, besideRetryMs: 80,
      besideSettleSteps: 0, besideSettleMs: 0 });
    engine.attachTrainer(tr);
    T.log.length = 0;
    T.cfg.depth = { delay: 400 };
    T.cfg.cutout = { delay: 300 };
    T.cfg.resize = { delay: 60 };
    T.cfg.frame = { delay: 60 };
    T.cfg.gen = { delay: 60 };
    const nFreed0 = freed.length;
    const hold = await engine.holdGpu({ label: LABEL, minutes: () => 60 });
    tr.set(plumo('entrainement', 'train'));
    check('banc : porte tenue, réglage absent des préférences (un prefs.json d’avant) → activé', !!hold && engine._hold && engine._hold.held
      && (await ctx.prefs.get()).trainGenBeside === undefined && typeof engine.besideAllowed === 'function' && engine.besideAllowed() === true);
    const RULES = require(path.join(MIA, 'electron', 'scanner-rules.js'));
    check('marge de 16 Go (exportée), la même que Mia garde au-dessus de tout pic mesuré (scanner-rules MEM_MARGIN_GB)',
      I.BESIDE_MARGIN_GB === 16 && I.BESIDE_MARGIN_GB === RULES.MEM_MARGIN_GB, I.BESIDE_MARGIN_GB);

    // 1) assez de mémoire : 46 + 17 + 16 = 79 < 94 → part à côté, sans verrou à lui
    node('n_dep').params.invert = 'cote-1';
    const a = accepted(await run('n_dep'), 'image à côté');
    const aStart = await waitFor((e) => e.jobId === a.jobId && e.kind === 'start', 4000, 'départ à côté').catch(() => null);
    const aRec = T.log.find((x) => x.name === 'depth');
    check('réglage actif + mémoire suffisante (46 + 17 + 16 < 94) : le calcul part à côté de l’entraînement', !!aStart && aStart.beside === 'Plumo'
      && !!jobOf(a) && jobOf(a).beside === 'Plumo', aStart);
    check('… sans verrou à lui : celui de l’entraînement couvre le GPU pendant le calcul', !!aRec && !!aRec.lock && aRec.lock.qui === LABEL
      && (readJsonSafe(lockPath) || {}).qui === LABEL, aRec && aRec.lock);
    check('… la mémoire a été mesurée juste avant (nvidia-smi, simulé ici)', measures >= 1, measures);
    check('… ÉVÈNEMENTS de l’entraînement : « Calcul à côté : <bloc> »', notes.length === 1 && !!jobOf(a) && notes[0] === jobOf(a).label, notes);
    check('… la file publique le dit (beside), sans attente', engine.jobList().some((j) => j.jobId === a.jobId && j.beside === 'Plumo' && !j.trainWait));

    // 2) un seul à côté à la fois ; les légers attendent toujours ; sans GPU et en ligne passent
    node('n_cut').params.feather = 21;
    const b = accepted(await run('n_cut'), 'deuxième calcul lourd');
    node('n_rszv').params.size = 'x2';
    const l = accepted(await run('n_rszv'), 'léger pendant le calcul à côté');
    node('n_frm').params.at = 2;
    const nn = accepted(await run('n_frm'), 'sans GPU pendant le calcul à côté');
    ctx.cloud = { linked: () => true };
    const o = accepted(await run('n_onLora'), 'en ligne pendant le calcul à côté');
    await wait(150);
    // il partira à côté dès la fin du premier : son message le dit, pas « fin vers <fin de l'entraînement> »
    check('deux calculs lourds : un seul à côté, le second attend le calcul à côté (son message), « Laisser passer » le compte',
      !!jobOf(b) && jobOf(b).state === 'queued' && !startOf(b)
      && jobOf(b).message === 'Attend le calcul en cours à côté de l’entraînement « Plumo »' && jobOf(b).trainWait === true, jobOf(b) && jobOf(b).message);
    check('… en anglais', engine.tr('besideBusy', { name: 'Plumo' }, 'en') === 'Waiting for the job running alongside the training “Plumo”');
    check('un calcul léger garde son comportement : il attend la fin de l’entraînement', !!jobOf(l) && jobOf(l).state === 'queued' && !startOf(l) && jobOf(l).message === OLD, jobOf(l) && jobOf(l).message);
    // sans GPU : il part PENDANT le calcul à côté, comme pendant l'entraînement seul (avant sa fin, pas après)
    const iStartN = events.findIndex((x) => x.jobId === nn.jobId && x.kind === 'start');
    const iEndA = events.findIndex((x) => x.jobId === a.jobId && ['done', 'error', 'cancelled'].includes(x.kind));
    check('un calcul sans GPU part pendant le calcul à côté, sans attendre sa fin', iStartN >= 0 && (iEndA < 0 || iStartN < iEndA)
      && !!jobOf(a) && jobOf(a).state === 'running', { iStartN, iEndA, a: jobOf(a) && jobOf(a).state, msg: jobOf(nn) && jobOf(nn).message });
    const [nEnd, oEnd] = await Promise.all([waitEnd(nn.jobId, 4000), waitEnd(o.jobId, 4000)]);
    check('un calcul sans GPU et un calcul en ligne passent, comme avant', nEnd.kind === 'done' && oEnd.kind === 'done' && !oEnd.beside);
    delete ctx.cloud;
    const aEnd = await waitEnd(a.jobId, 6000);
    const bStart = await waitFor((e) => e.jobId === b.jobId && e.kind === 'start', 4000, 'départ du second').catch(() => null);
    const bEnd = await waitEnd(b.jobId, 6000);
    const cutRec = T.log.find((x) => x.name === 'cutout');
    check('… le second part à côté à la fin du premier, jamais en même temps', aEnd.kind === 'done' && !!bStart && bStart.beside === 'Plumo' && bEnd.kind === 'done'
      && !!cutRec && aRec.end <= cutRec.start, { a: aRec && aRec.end, b: cutRec && cutRec.start });
    check('après chaque calcul à côté : POST /free (ComfyUI rend sa mémoire), l’entraînement tient toujours le GPU', freed.length - nFreed0 === 3
      && engine._hold && engine._hold.held && (readJsonSafe(lockPath) || {}).qui === LABEL, freed.length - nFreed0);

    // 3) mémoire insuffisante : 50 + 40 + 16 > 94 → attend, la raison et les chiffres ; « Laisser passer » le compte
    mem.depth = 40;
    used = 50;
    node('n_dep').params.invert = 'cote-2';
    const c = accepted(await run('n_dep'), 'calcul trop gros');
    await wait(250);
    // il attend de la PLACE (il part dès que la mémoire mesurée le permet), pas forcément la fin de l'entraînement
    const want = `Attend de la place à côté de l’entraînement « Plumo » (fin vers ${at}) : il faut ≈ 40 Go, 44 sont libres moins 16 de marge`;
    check('mémoire insuffisante : attend de la place, avec la raison et les chiffres', !!jobOf(c) && jobOf(c).state === 'queued' && !startOf(c) && jobOf(c).message === want, jobOf(c) && jobOf(c).message);
    check('… l’évènement « queued » porte trainWait et ce message', events.some((e) => e.jobId === c.jobId && e.kind === 'queued' && e.trainWait === true && e.message === want));
    check('… « Laisser passer » reste proposé : waitingForGpu le compte (avec le léger)', engine.waitingForGpu() === 2, engine.waitingForGpu());
    check('… en anglais', engine.tr('besideWaitEnd', { name: 'Plumo', at: '15:10', need: '40', free: '44', margin: '16' }, 'en')
      === 'Waiting for room alongside the training “Plumo” (ends around 15:10): needs ≈ 40 GB, 44 are free minus the 16 GB margin'
      && engine.tr('besideRun', { name: 'Plumo' }, 'en') === 'Alongside the training “Plumo”' && engine.tr('besideRun', { name: 'Plumo' }, 'fr') === 'À côté de l’entraînement « Plumo »');
    {
      // la file (2e ligne d'une rangée) : la raison d'abord, en court, sans le nom de l'entraînement (sa rangée est juste
      // au-dessus) ; la phrase entière reste le message (bloc, survol, mia_jobs) — avant : « Attend de la place à côté de
      // l’entraînement « Plumo » (… » coupé par la file avant les chiffres
      const P = (x) => String(x == null ? '' : x).replace(/\u00a0/g, ' ');
      const wantQ = 'Manque de mémoire : il faut ≈ 40 Go, 44 libres moins 16 de marge';
      check('la file : la raison d’abord, en court (waitShort), chiffres compris ; la phrase entière reste dans message', !!jobOf(c)
        && P(jobOf(c).waitShort) === wantQ && jobOf(c).message === want, jobOf(c) && jobOf(c).waitShort);
      check('… l’évènement « queued » et la liste des calculs (pub) la portent aussi', events.some((e) => e.jobId === c.jobId && e.kind === 'queued' && P(e.waitShort) === wantQ)
        && P(engine.pub(jobOf(c)).waitShort) === wantQ && engine.pub(jobOf(c)).message === want);
      check('… en anglais', engine.besideWaitMessage({ name: 'Plumo', endAt: null, needGB: 40, freeGB: 44, marginGB: 16 }, true) !== null
        && engine.tr('besideWaitQ', { need: '40', free: '44', margin: '16' }, 'en') === 'Not enough memory: needs ≈ 40 GB, 44 free minus the 16 GB margin');
    }
    check('… décimales à la française, sans heure de fin', typeof engine.besideWaitMessage === 'function' && engine.besideWaitMessage({ name: 'Plumo', endAt: null, needGB: 22.5, freeGB: 27.3, marginGB: 16 })
      === 'Attend de la place à côté de l’entraînement « Plumo » : il faut ≈ 22,5 Go, 27,3 sont libres moins 16 de marge');
    // ≈ 40 Go à côté de 46 Go : 46 + 40 + 16 = 102, au-dessus de 94 → attend toujours
    used = 46;
    const c46 = await waitFor((e) => e.jobId === c.jobId && e.kind === 'queued' && /48 sont libres/.test(e.message || ''), 3000, 'nouvelle lecture').catch(() => null);
    check('≈ 40 Go à côté de 46 Go : 46 + 40 + 16 n’est pas sous 94 → attend', !!c46 && !!jobOf(c) && jobOf(c).state === 'queued' && !startOf(c)
      && /il faut ≈ 40 Go, 48 sont libres moins 16 de marge$/.test(jobOf(c).message), jobOf(c) && jobOf(c).message);
    // la mémoire se libère : mesurée de nouveau, le calcul part seul
    used = 30;
    const cStart = await waitFor((e) => e.jobId === c.jobId && e.kind === 'start', 3000, 'départ après la mémoire libérée').catch(() => null);
    check('la mémoire se libère (30 + 40 + 16 < 94) : il part tout seul, à côté', !!cStart && cStart.beside === 'Plumo', cStart);
    check('… parti : plus de raison courte (ni sur le calcul, ni dans son évènement)', !!jobOf(c) && !jobOf(c).waitShort && !('waitShort' in cStart) && !('waitShort' in engine.pub(jobOf(c))), jobOf(c) && jobOf(c).waitShort);
    await waitEnd(c.jobId, 6000);

    // 4) réglage coupé : attend comme avant, sans mesurer
    ctx.prefs.get = async () => ({ ...(await keepGet()), trainGenBeside: false });
    await engine.refreshPrefs();
    mem.depth = 17;
    used = 46;
    const m0 = measures;
    node('n_dep').params.invert = 'cote-3';
    const d = accepted(await run('n_dep'), 'réglage coupé');
    await wait(300);
    check('réglage coupé : attend comme avant (même message), aucune mesure', !!jobOf(d) && jobOf(d).state === 'queued' && !startOf(d)
      && jobOf(d).message === OLD && measures === m0, { msg: jobOf(d) && jobOf(d).message, measures: measures - m0 });
    ctx.prefs.get = keepGet;
    await engine.refreshPrefs();
    engine.pump();
    const dStart = await waitFor((e) => e.jobId === d.jobId && e.kind === 'start', 3000, 'départ après le réglage rallumé').catch(() => null);
    check('… rallumé : il part à côté', !!dStart && dStart.beside === 'Plumo');
    await waitEnd(d.jobId, 6000);

    // 5) l'entraînement fait un essai, ou charge son modèle : attendre (pic de mémoire de l'entraînement)
    tr.set(plumo('essai', 'sample'));
    node('n_dep').params.invert = 'cote-4';
    const f = accepted(await run('n_dep'), 'pendant un essai');
    await wait(250);
    // sa raison : la fin de l'essai (avant le 19/11 : le message d'avant, « entraînement en cours »)
    const plain5 = (x) => String(x || '').replace(/\u00a0/g, ' ');
    check('pendant un essai de l’entraînement : attend, et dit qu’il attend la fin de l’essai', !!jobOf(f) && jobOf(f).state === 'queued' && !startOf(f)
      && plain5(jobOf(f).message) === 'Attend que l’entraînement « Plumo » ait fini son essai' && jobOf(f).trainWait === true, jobOf(f) && jobOf(f).message);
    tr.set(plumo('preparation', 'load'));
    await wait(200);
    check('pendant le chargement du modèle : attend aussi, « ait démarré ses pas »', !!jobOf(f) && jobOf(f).state === 'queued' && !startOf(f)
      && plain5(jobOf(f).message) === 'Attend que l’entraînement « Plumo » ait démarré ses pas', jobOf(f) && jobOf(f).message);
    tr.set(plumo('entrainement', 'train'));
    const fStart = await waitFor((e) => e.jobId === f.jobId && e.kind === 'start', 3000, 'départ après l’essai').catch(() => null);
    check('… l’entraînement reprend ses pas : il part à côté', !!fStart && fStart.beside === 'Plumo');
    await waitEnd(f.jobId, 6000);

    // 6) estimation inconnue : attendre (prudence), sans mesurer
    delete mem.cutout;
    const m1 = measures;
    node('n_cut').params.feather = 22;
    const e = accepted(await run('n_cut'), 'estimation inconnue');
    await wait(300);
    check('estimation inconnue pour le modèle : attend (message d’avant), aucune mesure', !!jobOf(e) && jobOf(e).state === 'queued' && !startOf(e)
      && jobOf(e).message === OLD && measures === m1, jobOf(e) && jobOf(e).message);
    await invoke('engine:cancel', e.jobId);
    await waitEnd(e.jobId, 4000);
    const cancelQueued = async (x) => { await invoke('engine:cancel', x.jobId); await waitEnd(x.jobId, 4000).catch(() => null); };

    // 8) seuls les pics MESURÉS comptent : un chiffre « réglé pour 24 Go » (base catalog) ou lu sur le fichier vaut une
    //    estimation inconnue — « LTX · détails » (20 au catalogue) fait tourner le même LTX que la vidéo (40 mesurés)
    used = 10;
    mem.cutout = 12;
    memBasis.cutout = 'catalog';
    const m8 = measures;
    node('n_cut').params.feather = 23;
    const k8 = accepted(await run('n_cut'), 'estimation du catalogue');
    await wait(300);
    check('estimation « réglée pour 24 Go » (base catalog), 84 Go libres : attend (message d’avant), aucune mesure', !!jobOf(k8) && jobOf(k8).state === 'queued'
      && !startOf(k8) && jobOf(k8).message === OLD && measures === m8, { msg: jobOf(k8) && jobOf(k8).message, measures: measures - m8 });
    await cancelQueued(k8);
    delete memBasis.cutout;
    delete mem.cutout;
    {
      const S = require(path.join(MIA, 'electron', 'scanner.js'))._internals;
      const cat = (key) => RULES.CATALOG.find((x) => x.key === key);
      const jobWith = (m, params = {}, gen = null) => ({ _: { spec: { models: { model: m }, params, gen } } });
      const real = (key, params) => { const c = cat(key); return jobWith({ id: key, caps: c.caps, vramGB: c.vramGB, mem: S.memOf({ vramGB: c.vramGB }, c, 94) }, params); };
      const need = (key, params) => engine.besideNeedGB(real(key, params));
      const NOPEAK = ['ltx-upscaler', 'minimax', 'minimax-ref2v', 'wan-animate', 'qwen-edit', 'seedvr2-7b'];
      check('catalogue réel, 94 Go : LTX · détails, MiniMax, MiniMax références, Wan Animate, Qwen Edit, SeedVR2 → aucune estimation, ils attendent',
        NOPEAK.every((x) => !!cat(x) && need(x) === null), NOPEAK.map((x) => [x, need(x)]));
      check('… FLUX.2 Klein 9B ≈ 29 mesuré en 1K, rien au-delà (1,5K pas mesuré) ; Qwen-Image 2.1 ≈ 23 mesuré jusqu’en 2K', need('flux2-klein9b', { resolution: '1024' }) === 29
        && need('flux2-klein9b', { resolution: '1440' }) === null && need('qwen-image21', { resolution: '2048' }) === 23 && need('qwen-image21', {}) === 23,
      [need('flux2-klein9b', { resolution: '1024' }), need('flux2-klein9b', { resolution: '1440' }), need('qwen-image21', { resolution: '2048' })]);
      check('… une estimation d’après le fichier (base file) ou sans base : aucune', engine.besideNeedGB(jobWith({ id: 'x', vramGB: 8, mem: { gb: 8, basis: 'file', at: null } })) === null
        && engine.besideNeedGB(jobWith({ id: 'y', vramGB: 8 })) === null);
    }

    // 9) une vidéo attend toujours la fin : son pic monte avec sa définition et sa durée (40 mesurés en 960 × 544,
    //    121 images) — ni à 45,5 Go lus, ni même à 30
    used = 30;
    mem.depth = 40;
    memAt.depth = { w: 960, h: 544, frames: 121 };
    const m9 = measures;
    node('n_dep').params.invert = 'cote-6';
    const v9 = accepted(await run('n_dep'), 'vidéo');
    await wait(300);
    check('une estimation mesurée sur une vidéo, 30 + 40 + 16 < 94 : attend quand même la fin, le message le dit, aucune mesure', !!jobOf(v9) && jobOf(v9).state === 'queued'
      && !startOf(v9) && jobOf(v9).message === `Attend la fin de l’entraînement « Plumo » (vers ${at}) : une vidéo ne part pas à côté` && jobOf(v9).trainWait === true
      && measures === m9, { msg: jobOf(v9) && jobOf(v9).message, measures: measures - m9 });
    await cancelQueued(v9);
    delete memAt.depth;
    {
      const vid = (model, gen) => ({ _: { spec: { models: { model }, params: { resolution: '1080', seconds: 10 }, gen } } });
      engine._besideMem = { usedGB: 45.5, at: Date.now() };
      const r1 = engine.besideCheck(vid({ id: 'ltx', caps: ['image-to-video', 'text-to-video'], mem: { gb: 40, basis: 'measured', at: { w: 960, h: 544, frames: 121 } } }, { kind: 'video' }));
      const r2 = engine.besideCheck(vid({ id: 'mm', caps: ['reference-to-video'], mem: { gb: 20, basis: 'measured', at: null } }, null));
      const r3 = engine.besideCheck(vid({ id: 'wa', caps: ['character-performance'], mem: { gb: 18, basis: 'measured', at: null } }, null));
      check('vidéo LTX en 1080p sur 10 s, lecture 45,5 Go : attend (raison video) ; une vidéo reconnue par ses capacités aussi',
        r1.reason === 'video' && r2.reason === 'video' && r3.reason === 'video', [r1, r2, r3]);
      check('… en anglais', engine.tr('besideVideoEnd', { name: 'Plumo', at: '15:10' }, 'en') === 'Waiting for the training “Plumo” to end (around 15:10): a video does not start alongside it'
        && engine.tr('besideVideo', { name: 'Plumo' }, 'en') === 'Waiting for the training “Plumo” to end: a video does not start alongside it');
      engine._besideMem = null;
    }

    // 10) l'entraînement vient d'entrer dans ses pas (avant le premier, ses activations ne sont pas allouées : lecture
    //     basse) : rien à côté avant 3 pas ; ensuite son pic connu compte, même si la lecture est plus basse
    Object.assign(engine.opts, { besideSettleSteps: 3, besideSettleMs: 30 });
    check('3 pas et 10 s avant un calcul à côté (exportés)', I.BESIDE_SETTLE_STEPS === 3 && I.BESIDE_SETTLE_MS === 10000);
    used = 28;
    mem.depth = 40;
    tr.set(plumo('essai', 'sample'));
    tr.set(plumo('entrainement', 'train', { step: 700 }));
    const m10 = measures;
    node('n_dep').params.invert = 'cote-7';
    const s10 = accepted(await run('n_dep'), 'juste après le passage en entraînement');
    await wait(300);
    check('juste entré dans ses pas (pas 700, lecture 28 : 28 + 40 + 16 < 94) : rien ne part à côté avant 3 pas, sans mesure', !!jobOf(s10) && jobOf(s10).state === 'queued'
      && !startOf(s10) && plain5(jobOf(s10).message) === 'Attend que l’entraînement « Plumo » ait pris sa place en mémoire (quelques pas)' && measures === m10,
    { msg: jobOf(s10) && jobOf(s10).message, measures: measures - m10 });
    tr.set(plumo('entrainement', 'train', { step: 703, peakVramGB: 46.4 }));
    const s10w = await waitFor((x) => x.jobId === s10.jobId && x.kind === 'queued' && /47,6 sont libres/.test(x.message || ''), 3000, 'pic connu').catch(() => null);
    check('… 3 pas plus tard : le pic connu de l’entraînement (46,4) compte, pas la lecture basse (28) → attend de la place', !!s10w && !startOf(s10)
      && /il faut ≈ 40 Go, 47,6 sont libres moins 16 de marge$/.test(jobOf(s10).message), jobOf(s10) && jobOf(s10).message);
    tr.set(plumo('entrainement', 'train', { step: 704 }));
    const s10s = await waitFor((x) => x.jobId === s10.jobId && x.kind === 'start', 3000, 'départ').catch(() => null);
    check('… sans pic connu, lecture 28 : il part à côté', !!s10s && s10s.beside === 'Plumo', s10s);
    await waitEnd(s10.jobId, 6000);
    Object.assign(engine.opts, { besideSettleSteps: 0, besideSettleMs: 0 });

    // 11) « 4 variantes » : même modèle deux fois, ComfyUI le garde après le premier → POST /free quand même, sinon la
    //     lecture le compte en plus de l'estimation du second, qui attendrait la fin de l'entraînement pour rien
    used = 46;
    mem.depth = 22;
    const keepFree = engine.comfy.free;
    engine.comfy.free = async () => { cached = 0; return keepFree(); };
    const f11 = freed.length;
    node('n_dep').params.invert = 'cote-8';
    const v1 = accepted(await run('n_dep'), 'variante 1');
    node('n_dep').params.invert = 'cote-9';
    const v2 = accepted(await run('n_dep'), 'variante 2');
    const v1s = await waitFor((x) => x.jobId === v1.jobId && x.kind === 'start', 4000, 'variante 1').catch(() => null);
    cached = 25;                          // ComfyUI garde le modèle après le calcul (46 + 25 lus)
    const v2s = await waitFor((x) => x.jobId === v2.jobId && x.kind === 'start', 4000, 'variante 2').catch(() => null);
    const freedBetween = freed.length - f11;
    await waitEnd(v2.jobId, 6000).catch(() => null);
    check('« 4 variantes », même modèle, ComfyUI le garde : la 2e part à côté après un POST /free, puis un autre après elle', !!v1s && v1s.beside === 'Plumo'
      && !!v2s && v2s.beside === 'Plumo' && freedBetween === 1 && freed.length - f11 === 2, { v2: jobOf(v2) && jobOf(v2).message, freedBetween, freed: freed.length - f11 });
    engine.comfy.free = keepFree;
    cached = 0;

    // 12) un calcul qui ne tiendrait pas même l'entraînement arrêté (PC de 24 Go, 17 + 16 > 24) : message d'avant, sans
    //     relancer nvidia-smi pendant des heures ; une attente de mémoire sur une lecture qui ne bouge pas s'espace
    engine.machine = () => ({ memGB: 24, gpu: 'RTX', source: 'smi' });
    used = 10;
    mem.depth = 17;
    const m12 = measures;
    node('n_dep').params.invert = 'cote-10';
    const k12 = accepted(await run('n_dep'), 'PC de 24 Go');
    await wait(300);
    check('PC de 24 Go, ≈ 17 Go : ne tiendra jamais à côté → message d’avant, aucune mesure', !!jobOf(k12) && jobOf(k12).state === 'queued' && !startOf(k12)
      && jobOf(k12).message === OLD && measures === m12, { msg: jobOf(k12) && jobOf(k12).message, measures: measures - m12 });
    await cancelQueued(k12);
    engine.machine = () => ({ memGB: 94, gpu: 'NVIDIA RTX Spark', source: 'smi' });
    used = 50;
    mem.depth = 40;
    await wait(150);
    const m13 = measures;
    node('n_dep').params.invert = 'cote-11';
    const k13 = accepted(await run('n_dep'), 'attente de mémoire longue');
    await wait(1300);
    const n13 = measures - m13;
    check('lecture qui ne bouge pas : mesures espacées (×1, ×3, ×12 de 80 ms : 3 à 5 en 1,3 s, pas 15)', n13 >= 2 && n13 <= 6, n13);
    await cancelQueued(k13);
    used = 46;
    mem.depth = 17;

    // 13) chaque calcul lourd en attente derrière l'entraînement lit SA raison, recalculée quand la situation change
    //     (19/11/2026, en vrai : pendant « Qwen 2.1 · à côté », le 2e calcul lourd et les 3 vidéos lisaient encore
    //     « En file : entraînement … en cours » ; puis seule la 1re vidéo lisait « une vidéo ne part pas à côté »).
    //     Ni l'ordre ni les départs ne changent : un seul à côté à la fois, « Laisser passer » les compte toujours.
    {
      const plain = (x) => String(x || '').replace(/ /g, ' ');
      const VIDEO = 'Attend la fin de l’entraînement « Plumo » (vers ' + plain(at) + ') : une vidéo ne part pas à côté';
      const START = 'Attend que l’entraînement « Plumo » ait démarré ses pas';
      const BUSY = 'Attend le calcul en cours à côté de l’entraînement « Plumo »';
      const msg = (x) => plain(jobOf(x) && jobOf(x).message);
      // la même raison en court, pour la file (waitShort) — la raison d'abord, sans le nom de l'entraînement
      const short = (x) => plain(jobOf(x) && jobOf(x).waitShort);
      const START_Q = 'Attend les premiers pas de l’entraînement';
      const VIDEO_Q = 'Une vidéo ne part pas à côté : après l’entraînement, vers ' + plain(at);
      const BUSY_Q = 'Après le calcul en cours à côté';
      check('les raisons courtes de la file, en français (espaces insécables) et en anglais, 70 signes au plus',
        plain(engine.tr('besideVideoEndQ', { at: '15 h 10' }, 'fr')) === 'Une vidéo ne part pas à côté : après l’entraînement, vers 15 h 10'
        && /\u00a0:/.test(engine.tr('besideVideoQ', {}, 'fr')) && /«\u00a0LTX\u00a0»/.test(engine.tr('besideAfterQ', { first: engine.tr('besideFirst', { first: 'LTX' }, 'fr') }, 'fr'))
        && engine.tr('besideVideoEndQ', { at: '3:10 PM' }, 'en') === 'A video does not run alongside: after the training, around 3:10 PM'
        && engine.tr('besideBehindQ', { first: engine.tr('besideFirst', { first: 'Depth' }, 'en') }, 'en') === 'Its turn alongside: “Depth” goes first'
        && engine.tr('waitTrainingEndQ', { at: '3:10 PM' }, 'en') === 'After the training, around 3:10 PM'
        && ['waitTraining', 'waitTrainingEnd', 'waitTrainingSoon', 'besideWait', 'besideWaitEnd', 'besideVideo', 'besideVideoEnd', 'besideBusy', 'besideStart', 'besideSettle', 'besideSample', 'besideMeasuring', 'besideBehind', 'besideAfter', 'besideAfterEnd', 'besideAfterN', 'besideAfterEndN', 'besideBehindN']
          .every((k) => ['fr', 'en'].every((L) => {
            const v = { name: 'Plumo', at: L === 'en' ? '12:45 PM' : '15 h 10', need: '22,5', free: '27,3', margin: '16', n: 3, first: engine.tr('besideFirst', { first: 'Qwen-Image 2.1' }, L) };
            const q = engine.tr(k + 'Q', v, L);
            return q !== k + 'Q' && !/\{|Plumo/.test(q) && q.length <= 70 && q.length < engine.tr(k, v, L).length;
          })));
      check('nouveaux messages, en français (espaces insécables) et en anglais',
        plain(engine.tr('besideStart', { name: 'Plumo' }, 'fr')) === START
        && plain(engine.tr('besideSettle', { name: 'Plumo' }, 'fr')) === 'Attend que l’entraînement « Plumo » ait pris sa place en mémoire (quelques pas)'
        && plain(engine.tr('besideSample', { name: 'Plumo' }, 'fr')) === 'Attend que l’entraînement « Plumo » ait fini son essai'
        && plain(engine.tr('besideMeasuring', { name: 'Plumo' }, 'fr')) === 'Mesure la mémoire libre à côté de l’entraînement « Plumo »'
        && plain(engine.tr('besideBehind', { name: 'Plumo', first: engine.tr('besideFirst', { first: 'Profondeur' }, 'fr') }, 'fr')) === 'Attend son tour à côté de l’entraînement « Plumo » : « Profondeur » passe avant'
        && /« Plumo »/.test(engine.tr('besideStart', { name: 'Plumo' }, 'fr')) && / : « Profondeur »/.test(engine.tr('besideBehind', { name: 'Plumo', first: engine.tr('besideFirst', { first: 'Profondeur' }, 'fr') }, 'fr'))
        && engine.tr('besideStart', { name: 'Plumo' }, 'en') === 'Waiting for the training “Plumo” to start its steps'
        && engine.tr('besideSettle', { name: 'Plumo' }, 'en') === 'Waiting for the training “Plumo” to take its memory (a few steps)'
        && engine.tr('besideSample', { name: 'Plumo' }, 'en') === 'Waiting for the training “Plumo” to finish its sample'
        && engine.tr('besideMeasuring', { name: 'Plumo' }, 'en') === 'Measuring the free memory alongside the training “Plumo”'
        && engine.tr('besideBehind', { name: 'Plumo', first: engine.tr('besideFirst', { first: 'Depth' }, 'en') }, 'en') === 'Waiting its turn alongside the training “Plumo”: “Depth” goes first'
        && plain(engine.tr('besideAfterEnd', { name: 'Plumo', at: '15 h 10', first: engine.tr('besideFirst', { first: 'LTX' }, 'fr') }, 'fr')) === 'Attend la fin de l’entraînement « Plumo » (vers 15 h 10), puis « LTX », placé avant lui dans la file'
        && plain(engine.tr('besideAfter', { name: 'Plumo', first: engine.tr('besideOther', { first: 'LTX' }, 'fr') }, 'fr')) === 'Attend la fin de l’entraînement « Plumo », puis un autre « LTX », placé avant lui dans la file'
        && /« LTX »/.test(engine.tr('besideOther', { first: 'LTX' }, 'fr'))
        && engine.tr('besideAfterEnd', { name: 'Plumo', at: '3:10 PM', first: engine.tr('besideOther', { first: 'LTX' }, 'en') }, 'en') === 'Waiting for the training “Plumo” to end (around 3:10 PM), then for another “LTX”, queued before it');
      check('plusieurs calculs devant : comptés, en français (espaces insécables) et en anglais',
        plain(engine.tr('besideAfterEndN', { name: 'Plumo', at: '15 h 10', n: 3, first: engine.tr('besideFirst', { first: 'LTX' }, 'fr') }, 'fr')) === 'Attend la fin de l’entraînement « Plumo » (vers 15 h 10), puis 3 calculs placés avant lui dans la file, dont « LTX »'
        && /3\u00a0calculs/.test(engine.tr('besideAfterEndNQ', { at: '15 h 10', n: 3 }, 'fr')) && /\u00a0: 2\u00a0calculs/.test(engine.tr('besideBehindNQ', { n: 2 }, 'fr'))
        && plain(engine.tr('besideAfterEndNQ', { at: '15 h 10', n: 3 }, 'fr')) === 'Après l’entraînement (vers 15 h 10), puis 3 calculs placés avant'
        && plain(engine.tr('besideBehindN', { name: 'Plumo', n: 2 }, 'fr')) === 'Attend son tour à côté de l’entraînement « Plumo » : 2 calculs passent avant'
        && engine.tr('besideAfterEndN', { name: 'Plumo', at: '3:10 PM', n: 3, first: engine.tr('besideFirst', { first: 'LTX' }, 'en') }, 'en') === 'Waiting for the training “Plumo” to end (around 3:10 PM), then for 3 jobs queued before it, including “LTX”'
        && engine.tr('besideAfterEndNQ', { at: '3:10 PM', n: 3 }, 'en') === 'After the training (around 3:10 PM), then 3 jobs queued before it'
        && engine.tr('besideBehindNQ', { n: 2 }, 'en') === 'Its turn alongside: 2 jobs go first');
      used = 46;
      mem.cutout = 10;                    // une image : 46 + 10 + 16 < 94
      mem.depth = 40;
      memAt.depth = { w: 960, h: 544, frames: 121 };    // une vidéo
      T.cfg.cutout = { delay: 500 };
      const q0 = events.length;
      // l'entraînement prépare (vérification, encodage, chargement) : la file se remplit
      tr.set(plumo('preparation', 'check'));
      node('n_cut').params.feather = 40;
      const i1 = accepted(await run('n_cut'), 'image 1 pendant la préparation');
      node('n_cut').params.feather = 41;
      const i2 = accepted(await run('n_cut'), 'image 2 pendant la préparation');
      node('n_dep').params.invert = 'cote-20';
      const w1 = accepted(await run('n_dep'), 'vidéo 1 pendant la préparation');
      node('n_dep').params.invert = 'cote-21';
      const w2 = accepted(await run('n_dep'), 'vidéo 2 pendant la préparation');
      node('n_dep').params.invert = 'cote-22';
      const w3 = accepted(await run('n_dep'), 'vidéo 3 pendant la préparation');
      await wait(200);
      const all = [i1, i2, w1, w2, w3];
      check('préparation de l’entraînement : chaque image « attend qu’il ait démarré ses pas », chaque vidéo dit qu’elle ne part pas à côté',
        msg(i1) === START && msg(i2) === START && msg(w1) === VIDEO && msg(w2) === VIDEO && msg(w3) === VIDEO
        && all.every((x) => !!jobOf(x) && jobOf(x).state === 'queued' && jobOf(x).trainWait === true && !startOf(x)), all.map(msg));
      tr.set(plumo('preparation', 'load'));
      await wait(100);
      check('… pendant le chargement du modèle aussi (rien ne part)', msg(i1) === START && msg(w3) === VIDEO && all.every((x) => !startOf(x)), all.map(msg));
      check('… la file lit la raison en court : « Attend les premiers pas… », « Une vidéo ne part pas à côté : après l’entraînement, vers … »',
        short(i1) === START_Q && short(i2) === START_Q && [w1, w2, w3].every((x) => short(x) === VIDEO_Q), all.map(short));
      // les pas commencent : la 1re image part à côté ; DANS LE MÊME TOUR, la 2e lit qu'elle attend le calcul à côté
      // et les trois vidéos gardent leur raison (avant : « En file : entraînement … en cours »)
      tr.set(plumo('entrainement', 'train'));
      const i1s = await waitFor((e) => e.jobId === i1.jobId && e.kind === 'start', 4000, 'départ de l’image 1').catch(() => null);
      await wait(60);
      check('l’image 1 part à côté ; l’image 2 attend le calcul à côté, les 3 vidéos la fin de l’entraînement', !!i1s && i1s.beside === 'Plumo'
        && msg(i2) === BUSY && msg(w1) === VIDEO && msg(w2) === VIDEO && msg(w3) === VIDEO && !startOf(i2), [i2, w1, w2, w3].map(msg));
      check('… en court : l’image 2 « Après le calcul en cours à côté », l’image 1 partie n’en a plus', short(i2) === BUSY_Q && !jobOf(i1).waitShort
        && [w1, w2, w3].every((x) => short(x) === VIDEO_Q), [i1, i2, w1].map(short));
      check('… « Laisser passer » les compte toujours (trainWait, waitingForGpu)', [i2, w1, w2, w3].every((x) => !!jobOf(x) && jobOf(x).trainWait === true)
        && engine.waitingForGpu() >= 4, engine.waitingForGpu());
      // stables : sans changement, aucun nouvel évènement « queued » (pas de clignotement)
      const nq = () => events.filter((e) => e.kind === 'queued' && [i2, w1, w2, w3].some((x) => x.jobId === e.jobId)).length;
      const n0 = nq();
      engine.pump(); engine.pump(); engine.pump();
      await wait(30);
      check('… messages stables : trois passes de la file sans changement, aucun nouvel évènement', nq() === n0, nq() - n0);
      await waitEnd(i1.jobId, 6000);
      const i2s = await waitFor((e) => e.jobId === i2.jobId && e.kind === 'start', 4000, 'départ de l’image 2').catch(() => null);
      await wait(60);
      check('l’image 2 part à côté à son tour ; les vidéos 2 et 3 (pas seulement la 1re) disent qu’une vidéo ne part pas à côté',
        !!i2s && i2s.beside === 'Plumo' && msg(w1) === VIDEO && msg(w2) === VIDEO && msg(w3) === VIDEO, [w1, w2, w3].map(msg));
      await waitEnd(i2.jobId, 6000);
      await wait(60);
      check('après les images : les 3 vidéos attendent toujours la fin, chacune avec la raison vidéo', [w1, w2, w3].every((x) => msg(x) === VIDEO && !startOf(x)), [w1, w2, w3].map(msg));
      // une image derrière une vidéo (la file garde son ordre) : la vidéo ne partira pas à côté, l'image non plus avant
      // elle ; elle attend la FIN de l'entraînement, puis la vidéo (relecture : « attend son tour à côté » la trompait)
      node('n_cut').params.feather = 42;
      const i3 = accepted(await run('n_cut'), 'image derrière les vidéos');
      await wait(100);
      const label1 = plain(jobOf(w1) && jobOf(w1).label);
      // trois vidéos devant elle : elles sont comptées (relecture du 19/11 : « puis « <1re vidéo> » » seul laissait croire
      // que l'image partirait juste après la première ; la phrase entière nomme la première, « dont … »)
      const AFTER = 'Attend la fin de l’entraînement « Plumo » (vers ' + plain(at) + '), puis 3 calculs placés avant lui dans la file, dont « ' + label1 + ' »';
      check('… en court : « Après l’entraînement (vers …), puis 3 calculs placés avant » (les trois vidéos comptées)', short(i3) === 'Après l’entraînement (vers ' + plain(at) + '), puis 3 calculs placés avant', short(i3));
      check('une image derrière trois vidéos : elle attend la fin de l’entraînement, puis les 3 calculs placés avant (la 1re nommée ; pas « son tour à côté »)', msg(i3) === AFTER
        && !startOf(i3) && jobOf(i3).trainWait === true, msg(i3));
      tr.set(plumo('essai', 'sample'));
      await wait(60);
      check('… pendant un essai de l’entraînement aussi (elle ne partira pas à côté) ; les vidéos gardent leur raison', msg(i3) === AFTER
        && [w1, w2, w3].every((x) => msg(x) === VIDEO), [i3, w1, w2, w3].map(msg));
      tr.set(plumo('preparation', 'load'));
      await wait(60);
      check('… pendant le chargement du modèle aussi (pas « ait démarré ses pas »)', msg(i3) === AFTER && [w1, w2, w3].every((x) => msg(x) === VIDEO), [i3, w1, w2, w3].map(msg));
      // réglage coupé : le message d'avant pour tous
      ctx.prefs.get = async () => ({ ...(await keepGet()), trainGenBeside: false });
      await engine.refreshPrefs();
      tr.set(plumo('entrainement', 'train'));
      await wait(60);
      check('réglage coupé : le message d’avant pour tous (vidéos comprises)', [w1, w2, w3, i3].every((x) => !!jobOf(x) && jobOf(x).message === OLD), [w1, w2, w3, i3].map(msg));
      check('… et sa forme courte : « Après l’entraînement, vers … »', [w1, w2, w3, i3].every((x) => short(x) === 'Après l’entraînement, vers ' + plain(at)), [w1, i3].map(short));
      ctx.prefs.get = keepGet;
      await engine.refreshPrefs();
      for (const x of [w1, w2, w3, i3]) await cancelQueued(x);
      check('… aucun ne s’est glissé à côté pendant ce temps (une seule image à la fois)', [w1, w2, w3, i3].every((x) => !startOf(x))
        && events.slice(q0).filter((e) => e.kind === 'start' && e.beside).length === 2);
      delete memAt.depth;
      mem.depth = 17;
      mem.cutout = 10;
      T.cfg.cutout = { delay: 300 };
    }

    // 7) l'entraînement rend le GPU pendant un calcul à côté : le calcul prend le verrou sous son nom, puis le rend
    T.cfg.depth = { delay: 700 };
    node('n_dep').params.invert = 'cote-5';
    const g = accepted(await run('n_dep'), 'calcul à côté quand l’entraînement finit');
    await waitFor((x) => x.jobId === g.jobId && x.kind === 'start', 4000, 'départ').catch(() => null);
    const relG = hold.release();
    tr.set(null);
    const lkG = readJsonSafe(lockPath);
    check('l’entraînement finit pendant le calcul à côté : le calcul prend le verrou sous son nom', relG === true && !!lkG && /^Mia : .*\(Projet Test\)$/.test(lkG.qui)
      && lkG.app === 'Mia' && lkG.pid === process.pid, lkG);
    const gEnd = await waitEnd(g.jobId, 6000);
    const lEnd = await waitEnd(l.jobId, 6000);
    check('… et le rend à sa fin ; le léger qui attendait passe ensuite', gEnd.kind === 'done' && lEnd.kind === 'done' && !fs.existsSync(lockPath));
    await idle();
    check('à la fin : file vide, plus personne n’attend, verrou libre', engine.jobs.size === 0 && engine.waitingForGpu() === 0 && !fs.existsSync(lockPath));

    ctx.models.resolve = keepResolve;
    delete engine.machine;
    for (const k of ['gpuUsedGB', 'besideFreshMs', 'besideRetryMs']) delete engine.opts[k];
    engine.attachTrainer(null);
    T.cfg = {};
  }

  section('Entraînement LoRA : le vrai service et son faux outil, branchés sur la porte du moteur');
  {
    const prevFake = process.env.MIA_TRAIN_FAKE;
    process.env.MIA_TRAIN_FAKE = '1';                 // la base « fake » n'existe qu'ainsi ; tout va sous <userData>\training
    const WORK = path.join(MIA, '_dev', 'tmp', `test-engine-train-${process.pid}`);
    fs.rmSync(WORK, { recursive: true, force: true });
    const SET = path.join(WORK, 'jeu');
    fs.mkdirSync(SET, { recursive: true });
    for (let i = 1; i <= 10; i++) {
      const b = Buffer.alloc(64, i);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
      b.writeUInt32BE(13, 8);
      b.write('IHDR', 12, 'latin1');
      b.writeUInt32BE(1024, 16);
      b.writeUInt32BE(1024, 20);
      fs.writeFileSync(path.join(SET, `rosa_${i}.png`), b);
      fs.writeFileSync(path.join(SET, `rosa_${i}.txt`), `seated by a window, picture ${i}`);
    }
    const UD = path.join(WORK, 'ud');
    fs.mkdirSync(UD, { recursive: true });
    const trainerMod = require(path.join(MIA, 'electron', 'trainer.js'));
    const { pidAlive } = require(path.join(ENGINE, 'gpulock.js'));
    const tlogs = [];
    const svc = trainerMod.register({
      ipcMain: { handle: () => {} },
      send: () => {},
      paths: { root: MIA, data: path.join(UD, 'data'), userData: UD },
      prefs: { get: () => ({ lang: 'fr', engineRoot: labRoot }), onChange: () => {} },
      logger: () => (...a) => tlogs.push(a.join(' ')),
      engine,
      trainOpts: {
        lockPath: () => curLock,                      // le verrou temporaire du banc, jamais celui du moteur
        timing: { tickMs: 25, pushMs: 40, aliveMs: 100, retryMs: 120, renewMs: 150, stopMs: 4000, stopSampleMs: 9000, quitMs: 4000 },
        freeBytes: () => 500 * 1024 ** 3,
        commitGB: async () => 64,
        learnFake: true,
        toolsDir: path.join(WORK, 'outils'),
        trash: async () => {}
      }
    });
    const poll = async (fn, ms = 20000) => {
      const t0 = Date.now();
      for (;;) {
        let v = null;
        try { v = fn(); } catch { v = null; }
        if (v) return v;
        if (Date.now() - t0 > ms) return null;
        await wait(20);
      }
    };
    const draft = async (name, fake, steps) => {
      const c = svc.create({ name, base: 'fake', kind: 'character', trigger: 'rsa woman', fake });
      svc.update(c.id, { steps, settings: { saveEvery: 20, sampleEvery: 0 } });
      svc.addImages(c.id, [SET]);
      await svc.importIdle(c.id);
      return c.id;
    };
    const docOf = (id) => svc.item(id).doc;
    const jobOf = (x) => engine.jobs.get(x.jobId);
    try {
      check('le service se présente au moteur (attachTrainer)', engine.trainer === svc && svc.brief() === null);
      const id = await draft('Rosa', { msPerStep: 25, loadMs: 1500, encodeMs: 40 }, 80);
      const s0 = await svc.start(id);
      check('départ accepté', s0 && s0.ok === true && s0.started === true, s0);
      const inLoad = await poll(() => docOf(id).phase === 'load');
      T.cfg.frame = { delay: 60 };
      T.cfg.depth = { delay: 300 };
      node('n_frm').params.at = 4;
      const nA = await run('n_frm');
      await wait(200);
      const stL = engine.statusNow();
      const lkL = readJsonSafe(lockPath);
      if (docOf(id).phase === 'load') {
        check('phase « load » du vrai service : un calcul sans GPU attend', !!inLoad && jobOf(nA) && jobOf(nA).state === 'queued'
          && /^En file : entraînement « Rosa » en cours/.test(jobOf(nA).message), jobOf(nA) && jobOf(nA).message);
        check('statut du moteur : l’entraînement, en préparation', stL.training && stL.training.id === id && stL.training.name === 'Rosa' && stL.training.base === 'fake'
          && stL.training.state === 'preparation' && stL.training.phase === 'load' && stL.training.steps === 80, stL.training);
      } else {
        check('phase « load » observée à temps (machine trop lente pour ce contrôle)', false, docOf(id).phase);
      }
      check('verrou pris par la porte du moteur, au fichier que le service désigne', lkL && lkL.qui === 'Mia : Entraînement LoRA Rosa (Faux modèle (test))' && lkL.pid === process.pid
        && lkL.minutes >= 1 && lkL.minutes <= 30 && engine._hold && engine._hold.held && engine._hold.file === lockPath, lkL);
      await poll(() => docOf(id).state === 'entrainement');
      const nAEnd = await waitEnd(nA.jobId, 6000);
      check('entraînement lancé : le calcul sans GPU part tout seul', docOf(id).state === 'entrainement' && nAEnd.kind === 'done');
      // SPEC §8.7 : le moteur dit au service qu'un calcul part à côté → une ligne de ÉVÈNEMENTS, signée Mia
      const nb = typeof svc.noteBeside === 'function' ? svc.noteBeside('Portrait') : null;
      const lastNote = docOf(id).notes[docOf(id).notes.length - 1];
      check('vrai service : noteBeside écrit « Calcul à côté : Portrait » dans ÉVÈNEMENTS (act beside, par Mia)', nb === true && !!lastNote
        && lastNote.act === 'beside' && lastNote.by === 'Mia' && lastNote.text === 'Portrait', lastNote);

      // un lourd arrive : il attend ; « Laisser passer » le fait passer, puis l'entraînement repart seul
      node('n_dep').params.invert = 'lora-svc';
      T.log.length = 0;
      const hv = await run('n_dep');
      await wait(150);
      check('un lourd attend l’entraînement ; le service le compte', jobOf(hv) && jobOf(hv).state === 'queued' && /^En file : entraînement « Rosa » en cours/.test(jobOf(hv).message)
        && svc.gateWaiting() === 1 && svc.queueIdle() === false, jobOf(hv) && jobOf(hv).message);
      const stepAtPass = docOf(id).step;
      const pass = await svc.control(id, 'pass');
      check('« Laisser passer » accepté', pass && pass.ok === true, pass);
      const hvEnd = await waitEnd(hv.jobId, 15000);
      const depRec = T.log.find((x) => x.name === 'depth');
      check('le lourd passe, avec son propre verrou (l’entraînement a rendu le sien)', hvEnd.kind === 'done' && depRec && depRec.lock && /^Mia : .*\(Projet Test\)$/.test(depRec.lock.qui) && !/Entraînement/.test(depRec.lock.qui), depRec && depRec.lock);
      const again = await poll(() => docOf(id).run === 2 && docOf(id).state === 'entrainement');
      check('la file vide, l’entraînement repart seul (2e lancement), verrou repris', !!again && docOf(id).step >= stepAtPass && (readJsonSafe(lockPath) || {}).qui === 'Mia : Entraînement LoRA Rosa (Faux modèle (test))',
        { run: docOf(id).run, state: docOf(id).state });
      const fin = await poll(() => docOf(id).state === 'fini' && !svc.item(id).live, 30000);
      check('fin : état « fini », verrou rendu, statut sans entraînement', !!fin && docOf(id).step === 80 && !fs.existsSync(lockPath) && engine._hold === null
        && engine.statusNow().training === null, { state: docOf(id).state, step: docOf(id).step });

      // dernier filet : le moteur se ferme pendant un entraînement
      const id2 = await draft('Aida', { msPerStep: 30, loadMs: 50, encodeMs: 20 }, 4000);
      await svc.start(id2);
      await poll(() => docOf(id2).state === 'entrainement' && docOf(id2).step > 3);
      const pid = svc.item(id2).live && svc.item(id2).live.pid;
      check('second entraînement en cours avant la fermeture', docOf(id2).state === 'entrainement' && Number.isInteger(pid) && pidAlive(pid) && fs.existsSync(lockPath), docOf(id2).state);
      engine.shutdown();
      const dead = await poll(() => !pidAlive(pid), 5000);
      check('fermeture du moteur : l’outil est arrêté (par son numéro), plus aucun processus', !!dead && !svc.item(id2).live);
      check('fermeture : entraînement rangé « interrompu », verrou rendu', docOf(id2).state === 'interrompu' && docOf(id2).step > 0 && !fs.existsSync(lockPath) && engine._hold === null, docOf(id2).state);
      check('fermeture : train.json écrit sur-le-champ', readJsonSafe(path.join(svc.item(id2).dir, 'train.json')).state === 'interrompu');
    } finally {
      for (const it of svc.items.values()) {
        const p = it.live && it.live.pid;
        if (p && pidAlive(p)) { try { process.kill(p); } catch { /* déjà parti */ } }
      }
      svc.dispose();
      if (prevFake === undefined) delete process.env.MIA_TRAIN_FAKE; else process.env.MIA_TRAIN_FAKE = prevFake;
      await wait(200);
      try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* Windows garde parfois un verrou un instant */ }
    }
    T.cfg = {};
  }

  engine.dispose();

  // ================================================================ fermeture / reprise
  section('Fermeture pendant un calcul, puis reprise au démarrage');
  const orphanA = path.join(curDir, 'outputs', 'n_dep', 'r_0101_000000_aaaa');
  const orphanB = path.join(curDir, 'outputs', 'n_dep', 'r_0101_000001_bbbb');
  fs.mkdirSync(orphanA, { recursive: true });
  fs.mkdirSync(orphanB, { recursive: true });
  fs.writeFileSync(path.join(orphanA, 'run.json.tmp'), JSON.stringify({ runId: 'r_0101_000000_aaaa', nodeId: 'n_dep', status: 'cancelled', outputs: {} }));
  fs.writeFileSync(path.join(orphanA, 'out.mp4'), 'partiel');
  fs.writeFileSync(path.join(orphanB, 'comfy_graph.json'), '{}');
  fs.writeFileSync(path.join(orphanB, 'log.txt'), 'x');
  fs.writeFileSync(ctx.engineOpts.journalFile, JSON.stringify({ active: [orphanA, orphanB] }));
  trashed.length = 0;
  const e2 = register(ctx);
  e2.comfy.free = async () => true;
  await e2.ready;
  const ora = readJsonSafe(path.join(orphanA, 'run.json'));
  const orb = readJsonSafe(path.join(orphanB, 'run.json'));
  check('run.json.tmp repris en run.json', ora && ora.status === 'cancelled' && !fs.existsSync(path.join(orphanA, 'run.json.tmp')));
  check('dossier sans run.json : « annulé » écrit', orb && orb.status === 'cancelled' && orb.log === 'outputs/n_dep/r_0101_000001_bbbb/log.txt', orb);
  check('fichiers partiels à la Corbeille', !fs.existsSync(path.join(orphanA, 'out.mp4')) && !fs.existsSync(path.join(orphanB, 'comfy_graph.json')) && trashed.length === 2, trashed);
  check('journal vidé', readJsonSafe(ctx.engineOpts.journalFile).active.length === 0);
  T.cfg.depth = { delay: 5000, partial: true };
  const rr = await e2.run({ projectId: 'p_test', nodeId: 'n_dep', graph: clone(graph) });
  await new Promise((res) => {
    const on = (ev) => { if (ev.jobId === rr.jobId && ev.kind === 'start') { e2.off('event', on); res(); } };
    e2.on('event', on);
  });
  await wait(100);
  const qdir = e2.jobs.get(rr.jobId)._.outDir;
  check('verrou pris avant la fermeture', fs.existsSync(lockPath));
  e2.shutdown();
  const qrun = readJsonSafe(path.join(qdir, 'run.json'));
  check('fermeture : run.json « annulé » écrit sur-le-champ', qrun && qrun.status === 'cancelled' && /fermée pendant le calcul/.test(String(qrun.notes)), qrun);
  check('fermeture : verrou rendu (aucun calcul ComfyUI en cours)', !fs.existsSync(lockPath));
  check('fermeture : le dossier reste au journal (partiels au prochain démarrage)', readJsonSafe(ctx.engineOpts.journalFile).active.includes(qdir));
  await wait(300);
  check('aucun run.json.tmp laissé', !fs.existsSync(path.join(qdir, 'run.json.tmp')) && readJsonSafe(path.join(qdir, 'run.json')).status === 'cancelled');
  e2.dispose();
  T.cfg = {};

  // ================================================================ fermeture : la porte d'un entraînement
  section('Fermeture pendant un entraînement : dernier filet (killSync) puis verrou rendu');
  {
    const e3 = register(ctx);
    e3.comfy.free = async () => true;
    await e3.ready;
    const order = [];
    const tr3 = { brief: () => ({ id: 't_x', name: 'Rosa', state: 'entrainement', phase: 'train' }), killSync: () => { order.push(fs.existsSync(lockPath) ? 'kill, verrou encore là' : 'kill, verrou parti'); } };
    e3.attachTrainer(tr3);
    const h = await e3.holdGpu({ label: 'Mia : Entraînement LoRA Rosa (LTX 2.5)', minutes: () => 120 });
    check('porte tenue avant la fermeture', !!h && (readJsonSafe(lockPath) || {}).qui === 'Mia : Entraînement LoRA Rosa (LTX 2.5)');
    e3.shutdown();
    check('fermeture : killSync du service appelé une fois, AVANT de rendre le verrou', order.length === 1 && order[0] === 'kill, verrou encore là', order);
    check('fermeture : verrou de l’entraînement rendu', !fs.existsSync(lockPath) && e3._hold === null);
    await wait(300);
    check('fermeture : plus rien ne réécrit le verrou', !fs.existsSync(lockPath));
    check('après la fermeture : aucune porte n’est plus donnée', (await e3.holdGpu({ label: 'Mia : x', minutes: () => 1 })) === null && e3.adoptGpu({ label: 'Mia : x', minutes: () => 1 }) === null && !fs.existsSync(lockPath));
    e3.shutdown();
    check('fermeture appelée deux fois : killSync une seule', order.length === 1);
    // un service qui plante dans killSync n'empêche pas de rendre le verrou
    const e4 = register(ctx);
    e4.comfy.free = async () => true;
    await e4.ready;
    e4.attachTrainer({ brief: () => null, killSync: () => { throw new Error('panne'); } });
    await e4.holdGpu({ label: 'Mia : Entraînement LoRA Rosa (LTX 2.5)', minutes: () => 10 });
    let threw = null;
    try { e4.shutdown(); } catch (e) { threw = e.message; }
    check('killSync en panne : la fermeture continue, verrou rendu', threw === null && !fs.existsSync(lockPath), threw);
    e3.dispose();
    e4.dispose();
  }

  // ================================================================ un entraînement vu de Windows
  section('Entraînement LoRA hors de la fenêtre : barre des tâches, clignotement, veille (trainshell.js)');
  {
    const { createTrainShell } = require(path.join(MIA, 'electron', 'trainshell.js'));
    const calls = [];
    const last = () => calls[calls.length - 1];
    const fwin = {
      front: false,
      setProgressBar: (p, o) => calls.push(['bar', p, o ? o.mode : undefined]),
      flashFrame: (on) => calls.push(['flash', on]),
      isFocused() { return this.front; },
      isDestroyed: () => false
    };
    const psb = {
      n: 0, on: new Set(), kinds: [],
      start(kind) { this.kinds.push(kind); this.on.add(++this.n); return this.n; },
      stop(id) { this.on.delete(id); },
      isStarted(id) { return this.on.has(id); }
    };
    const docs = {};
    let b = null;
    const ftr = { brief: () => b, item: (id) => (docs[id] ? { doc: docs[id] } : null) };
    const sh = createTrainShell({ trainer: ftr, getWin: () => fwin, powerSaveBlocker: psb });
    sh.update();
    check('au repos : barre retirée, veille libre', calls.length === 1 && last()[0] === 'bar' && last()[1] === -1 && psb.on.size === 0, calls);
    docs.t1 = { state: 'attente', seen: true };
    b = { id: 't1', state: 'attente', progress: 0 };
    sh.update();
    check('attente du GPU : barre indéterminée', last()[0] === 'bar' && last()[1] > 1 && last()[2] === 'indeterminate', last());
    check('entraînement actif : la mise en veille est bloquée (prevent-app-suspension)', psb.on.size === 1 && psb.kinds.join() === 'prevent-app-suspension', psb.kinds);
    b = { id: 't1', state: 'preparation', phase: 'load', progress: 0 };
    sh.update();
    const nPrep = calls.length;
    b = { id: 't1', state: 'entrainement', progress: 0.496 };
    sh.update();
    check('entraînement : la barre porte la progression', calls.length === nPrep + 1 && last()[1] === 0.496 && last()[2] === 'normal', last());
    sh.update();
    sh.update();
    check('rien n’est réécrit sans changement', calls.length === nPrep + 1 && psb.n === 1, calls.length);
    b = { id: 't1', state: 'essai', progress: 0.6 };
    sh.update();
    check('essai : la progression continue', last()[1] === 0.6 && last()[2] === 'normal', last());
    b = { id: 't1', state: 'pause', pause: 'pass', progress: 0.6 };
    sh.update();
    check('« Laisser passer » : barre en pause, veille toujours bloquée', last()[1] === 0.6 && last()[2] === 'paused' && psb.on.size === 1, last());
    b = { id: 't1', state: 'entrainement', progress: 1 };
    sh.update();
    b = null;
    docs.t1 = { state: 'fini', seen: false };
    sh.update();
    check('fin, Mia en arrière-plan : le bouton clignote, la barre est retirée', calls.some((c) => c[0] === 'flash' && c[1] === true) && last()[0] === 'bar' && last()[1] === -1, calls.slice(-3));
    check('fin : la veille est rendue', psb.on.size === 0 && sh.state().blocker === null);
    sh.focused();
    check('Mia revient devant : le clignotement s’arrête', last()[0] === 'flash' && last()[1] === false && sh.state().flashing === false, last());
    sh.focused();
    check('… une seule fois', calls.filter((c) => c[0] === 'flash').length === 2);

    docs.t2 = { state: 'entrainement', seen: true };
    b = { id: 't2', state: 'entrainement', progress: 0.2 };
    sh.update();
    fwin.front = true;
    b = null;
    docs.t2 = { state: 'erreur', seen: false };
    sh.update();
    check('erreur, Mia devant : pas de clignotement, barre en mode erreur', calls.filter((c) => c[0] === 'flash').length === 2 && last()[0] === 'bar' && last()[2] === 'error', last());
    sh.update();
    check('… qui reste tant que l’entraînement n’a pas été ouvert', last()[2] === 'error' && sh.state().errorId === 't2');
    docs.t2.seen = true;
    sh.update();
    check('entraînement ouvert : barre retirée', last()[0] === 'bar' && last()[1] === -1 && sh.state().errorId === null, last());

    fwin.front = false;
    docs.t3 = { state: 'entrainement', seen: true };
    b = { id: 't3', state: 'entrainement', progress: 0.3 };
    sh.update();
    const nFlash = calls.filter((c) => c[0] === 'flash').length;
    b = null;
    docs.t3 = { state: 'pause', pause: { reason: 'user' }, seen: true };
    sh.update();
    check('pause manuelle : ni clignotement ni erreur, barre retirée, veille rendue', calls.filter((c) => c[0] === 'flash').length === nFlash && last()[1] === -1 && psb.on.size === 0, last());
    docs.t4 = { state: 'entrainement', seen: true };
    b = { id: 't4', state: 'entrainement', progress: 0.3 };
    sh.update();
    b = null;
    docs.t4 = { state: 'interrompu', seen: false };
    sh.update();
    check('interrompu, Mia en arrière-plan : clignote', calls.filter((c) => c[0] === 'flash' && c[1] === true).length === 2);

    // fenêtre de test (MIA_HEADLESS) : jamais de clignotement ; pas de fenêtre : aucune erreur
    const calls2 = [];
    const hwin = { setProgressBar: (p) => calls2.push(['bar', p]), flashFrame: (on) => calls2.push(['flash', on]), isFocused: () => false, isDestroyed: () => false };
    let b2 = { id: 'h1', state: 'entrainement', progress: 0.5 };
    const hdocs = { h1: { state: 'fini', seen: false } };
    const sh2 = createTrainShell({ trainer: { brief: () => b2, item: (id) => (hdocs[id] ? { doc: hdocs[id] } : null) }, getWin: () => hwin, powerSaveBlocker: null, headless: true });
    sh2.update();
    b2 = null;
    sh2.update();
    check('fenêtre de test cachée : jamais de clignotement', calls2.length === 2 && !calls2.some((c) => c[0] === 'flash'), calls2);
    let threw = null;
    try {
      const sh3 = createTrainShell({ trainer: { brief: () => { throw new Error('panne'); }, item: () => null }, getWin: () => null, powerSaveBlocker: psb });
      sh3.update();
      sh3.focused();
    } catch (e) { threw = e.message; }
    check('pas de fenêtre, service en panne : aucune erreur', threw === null, threw);
    const mainSrc = fs.readFileSync(path.join(MIA, 'electron', 'main.js'), 'utf8');
    check('main.js : arrêt de l’entraînement dans finishClose, « training » joint à app:flush, barre et veille branchées',
      /const finishClose = async[\s\S]{0,1500}stopForQuit\(\{ now: !!o\.now \}\)[\s\S]{0,600}win\.destroy\(\)/.test(mainSrc)
      && /wc\.send\('app:flush', \{ activeJobs: activeJobs\(\), training: activeTraining\(\) \}\)/.test(mainSrc)
      && /createTrainShell\(\{[\s\S]{0,200}powerSaveBlocker/.test(mainSrc) && /t\.onChange\(\(\) => trainShell\.update\(\)\)/.test(mainSrc));
    check('main.js : question de fermeture sans réponse pendant un entraînement → Mia reste ouverte (cas 16)',
      /const training = activeTraining\(\);[\s\S]{0,1200}if \(a\.hold\) \{[\s\S]{0,400}setTimeout\(\(\) => \{\s*if \(training\) cancel\(/.test(mainSrc));
  }

  // ================================================================ aide de fermeture (faux ComfyUI)
  section('Aide de fermeture contre un FAUX ComfyUI local (aucun calcul)');
  const fake = { queue: ['pid-1'], cancels: [] };
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && /^\/api\/jobs\/[^/]+\/cancel$/.test(req.url)) {
      fake.cancels.push(decodeURIComponent(req.url.split('/')[3]));
      res.end('{}');
      return;
    }
    if (req.url === '/queue') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ queue_running: fake.queue.map((id, i) => [i, id, {}, {}, []]), queue_pending: [] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const furl = 'http://127.0.0.1:' + srv.address().port;
  const helper = (args) => spawn(process.execPath, ['-e', QUIT_HELPER, ...args], { windowsHide: true, stdio: 'ignore' });
  const exitOf = (c) => new Promise((ok) => c.on('exit', (code) => ok(code)));
  setTimeout(() => { fake.queue = []; }, 1200);
  let t0 = Date.now();
  let code1 = await exitOf(helper(['quick', furl, '-', '-', 'pid-1']));
  check('rapide : annule puis attend que ComfyUI confirme', code1 === 0 && fake.cancels.includes('pid-1') && Date.now() - t0 >= 1000, { code1, ms: Date.now() - t0 });
  fake.queue = ['pid-2'];
  t0 = Date.now();
  code1 = await exitOf(helper(['quick', furl, '-', '-', 'pid-2']));
  check('rapide : 5 s au plus si ComfyUI ne lâche pas', code1 === 3 && Date.now() - t0 < 8000, { code1, ms: Date.now() - t0 });
  const hlock = path.join(tmp, 'helper.lock');
  const lc = helper(['long', furl, hlock, 'Mia : long (P)', 'pid-2']);
  const lexit = exitOf(lc);
  fs.writeFileSync(hlock, JSON.stringify({ qui: 'Mia : long (P)', minutes: 5, debut: Date.now() / 1000, depuis: '12:00', app: 'Mia', pid: lc.pid }));
  await wait(1200);
  check('long : le verrou reste tant que ComfyUI calcule', fs.existsSync(hlock));
  fake.queue = [];
  check('long : verrou supprimé après confirmation', (await lexit) === 0 && !fs.existsSync(hlock));
  const cfq = new Comfy({ prefs: () => ({ engineRoot: labRoot, comfyUrl: furl, lang: 'fr' }), dataDir: path.join(tmp, 'data-q') });
  check('shutdownSync sans calcul à nous : rien à passer', cfq.shutdownSync({}).handedOff === false);
  check('client_id gardé d’un lancement à l’autre', new Comfy({ dataDir: path.join(tmp, 'data-q') }).clientId === cfq.clientId);
  srv.close();

  // ================================================================ ComfyUI (lecture seule)
  section('ComfyUI du labo — détection en lecture seule');
  const cf = new Comfy({ prefs: () => ({ engineRoot: 'D:\\AI_Local_Videos', comfyUrl: 'http://127.0.0.1:8188', lang: 'fr' }), dataDir: path.join(tmp, 'data') });
  let info = null;
  // ces contrôles décrivent le moteur de l'auteur (D:\AI_Local_Videos) : un autre ComfyUI sur 8188 n'y répondrait pas pareil
  if (!fs.existsSync(LAB_PY)) console.log('  (moteur du labo absent : contrôles réseau sautés)');
  else {
    try { info = await cf.ensure({ launch: false }); } catch (e) { console.log(`  (ComfyUI absent : ${e.message} — contrôles réseau sautés)`); }
  }
  if (info) {
    check('instance du labo détectée', cf.state === 'running' && info.url === 'http://127.0.0.1:8188');
    check('outputDir lu dans argv', info.outputDir === 'D:\\AI_Local_Videos\\runtime\\output', info.outputDir);
    check('inputDir lu dans argv', info.inputDir === 'D:\\AI_Local_Videos\\runtime\\input', info.inputDir);
    check('MiniMax disponible (extra_minimax.yaml)', info.minimax === true);
    check('version', /^\d+\.\d+/.test(info.version || ''), info.version);
    check('pas lancé par Mia', info.managedByMia === false);
    const dm = await cf.models('diffusion_models');
    check('/models/diffusion_models', Array.isArray(dm) && dm.length > 0, dm.length);
    check('cache 60 s', (await cf.models('diffusion_models')) === dm);
    const li = await cf.objectInfo('LoadImage');
    check('/object_info/LoadImage', li && li.input && li.input.required && li.input.required.image);
    const q = await cf.queue();
    check('/queue', q && Array.isArray(q.running) && Array.isArray(q.pending));
    console.log(`        file ComfyUI : ${q.running.length} en cours, ${q.pending.length} en attente`);
    // WebSocket natif de Node (GET Upgrade, aucun calcul) : il doit s'ouvrir avec le clientId de Mia.
    const wsOk = await cf._ensureWs();
    check('WebSocket /ws?clientId= ouvert', wsOk === true && cf._wsOpen());
    try { cf._ws.close(); } catch { /* fermé */ }
  }
  const files = cf.files({
    195: { images: [{ filename: 'keyframe_00001.png', subfolder: 'aivideo\\s1', type: 'output' }, { filename: 'tmp.png', subfolder: '', type: 'temp' }] },
    23: { images: [{ filename: 'ltx_00001_.mp4', subfolder: 'sortie_ecran', type: 'output' }], animated: [true] },
    9: { videos: [{ filename: '../evil.mp4', subfolder: '..\\..', type: 'output' }] }
  });
  check('files() : sous-dossier avec antislash, temp ignoré', files.some((f) => f.abs === 'D:\\AI_Local_Videos\\runtime\\output\\aivideo\\s1\\keyframe_00001.png' && f.kind === 'image'));
  check('files() : vidéo reconnue', files.some((f) => f.filename === 'ltx_00001_.mp4' && f.kind === 'video'));
  check('files() : pas de sortie du dossier', files.length === 3 && files.every((f) => f.abs.startsWith('D:\\AI_Local_Videos\\runtime\\output\\')), files.map((f) => f.abs));

  section('ComfyUI — erreurs et progression (hors ligne)');
  const tr = (k, v) => cf.tr(k, v);
  const e400 = friendlyPromptError({
    error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' },
    node_errors: { 4: { class_type: 'UNETLoader', errors: [{ type: 'value_not_in_list', message: 'Value not in list', details: "unet_name: 'x.safetensors' not in [...]",
      extra_info: { input_name: 'unet_name', received_value: 'x.safetensors' } }] } }
  }, tr);
  check('400 node_errors → « Modèle introuvable : … »', e400.message === 'Modèle introuvable : x.safetensors' && e400.code === 'validation', e400.message);
  const eMissing = friendlyPromptError({ error: { type: 'invalid_prompt', message: 'Cannot execute because node FooBar does not exist.' }, node_errors: {} }, tr);
  check('nœud absent', /Nœud ComfyUI absent : « FooBar »/.test(eMissing.message), eMissing.message);
  const eOom = friendlyExecError({ node_type: 'KSampler', exception_type: 'torch.OutOfMemoryError', exception_message: 'CUDA out of memory. Tried to allocate…' }, tr);
  check('OOM → conseil clair', eOom.code === 'oom' && /Mémoire GPU insuffisante/.test(eOom.message));
  const seen = [];
  const graphApi = { 1: { class_type: 'UNETLoader' }, 2: { class_type: 'CLIPTextEncode' }, 3: { class_type: 'KSampler' }, 4: { class_type: 'VAEDecode' }, 5: { class_type: 'SaveImage' } };
  const { promise } = cf._track('p-1', graphApi, { onProgress: (p, m, eta) => seen.push({ p, m, eta }) });
  cf._history = async () => ({ outputs: { 5: { images: [{ filename: 'a.png', subfolder: 'mia', type: 'output' }] } }, status: { status_str: 'success', completed: true } });
  const msg = (type, data) => cf._onJson({ type, data: { prompt_id: 'p-1', ...data } });
  msg('execution_start', {});
  msg('execution_cached', { nodes: ['2'] });
  msg('executing', { node: '1' });
  msg('executing', { node: '3' });
  for (let i = 1; i <= 8; i++) { msg('progress', { node: '3', value: i, max: 8 }); }
  msg('executing', { node: '4' });
  msg('executed', { node: '5', output: {} });
  msg('execution_success', {});
  const done = await promise;
  check('progression monotone, pondérée, < 1 avant la fin', seen.length >= 4 && seen.every((x, i) => i === 0 || x.p >= seen[i - 1].p) && seen[seen.length - 1].p < 1 && seen.some((x) => x.p > 0.5), seen.map((x) => x.p.toFixed(2)));
  check('messages : chargement, génération n/8, décodage', seen.some((x) => x.m === 'Chargement du modèle…') && seen.some((x) => x.m === 'Génération : 8/8') && seen.some((x) => x.m === 'Décodage…'), seen.map((x) => x.m));
  check('fin : sorties de /history', done.promptId === 'p-1' && done.outputs[5].images[0].filename === 'a.png');
  const t2 = cf._track('p-2', graphApi, {});
  cf._onJson({ type: 'execution_error', data: { prompt_id: 'p-2', node_type: 'KSampler', exception_message: 'CUDA out of memory' } });
  let err2 = null;
  try { await t2.promise; } catch (e) { err2 = e; }
  check('execution_error → erreur lisible', err2 && err2.code === 'oom');
  const t3 = cf._track('p-3', graphApi, {});
  cf._onJson({ type: 'execution_interrupted', data: { prompt_id: 'p-3' } });
  let err3 = null;
  try { await t3.promise; } catch (e) { err3 = e; }
  check('execution_interrupted → AbortError', err3 && err3.name === 'AbortError');
  const prevs = [];
  const t4 = cf._track('p-4', graphApi, { onPreview: (buf, o) => prevs.push([buf.length, o.format]) });
  const meta = Buffer.from(JSON.stringify({ prompt_id: 'p-4', image_type: 'image/png' }));
  const frame = Buffer.alloc(8 + meta.length + 3);
  frame.writeUInt32BE(4, 0); frame.writeUInt32BE(meta.length, 4); meta.copy(frame, 8); frame.write('PNG', 8 + meta.length);
  cf._onBinary(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.length));
  check('aperçu binaire (type 4) routé vers son job', prevs.length === 1 && prevs[0][0] === 3 && prevs[0][1] === 'png', prevs);
  cf._settle(t4.job, null, {});
  try { cf._ws && cf._ws.close(); } catch { /* fermé */ }

  // ================================================================ pyrun
  section('pyrun — faux worker (CPU, minuscule)');
  if (!fs.existsSync(LAB_PY)) {
    console.log('  (Python du labo absent : sauté)');
  } else {
    const py = createPyRunner({ prefs: () => ({ engineRoot: 'D:\\AI_Local_Videos', lang: 'fr' }), worker: path.join(FIXTURES, 'fake_worker.py') });
    const dir = path.join(tmp, 'py');
    const prog = [];
    const prevs2 = [];
    const res = await py.run('ok', { text: 'bonjour é' }, { cwd: path.join(dir, 'ok'), onProgress: (p, m, eta) => prog.push([p, m, eta]), onPreview: (a) => prevs2.push(a) });
    check('job.json écrit', readJson(path.join(dir, 'ok', 'job.json')).text === 'bonjour é');
    check('progression @mia', prog.length === 4 && prog[3][0] === 0.75 && prog[0][1] === 'étape 1' && prog[0][2] === 4, prog);
    check('aperçu @mia', prevs2.length === 1 && prevs2[0].endsWith('prev.jpg'));
    check('sorties (chemin relatif résolu)', res.outputs.out.abs.endsWith('out.txt') && res.outputs.rel.abs === path.join(dir, 'ok', 'out.txt') && res.model === 'Faux');
    const log = fs.readFileSync(path.join(dir, 'ok', 'log.txt'), 'utf8');
    check('le reste va au journal (UTF-8)', log.includes('une ligne de bibliothèque é') && log.includes('un avertissement'));
    let e1 = null;
    try { await py.run('fail', {}, { cwd: path.join(dir, 'fail') }); } catch (e) { e1 = e; }
    check('@mia {error} → erreur lisible', e1 && e1.message === 'Erreur simulée du worker');
    let e2 = null;
    try { await py.run('crash', {}, { cwd: path.join(dir, 'crash') }); } catch (e) { e2 = e; }
    check('plantage → dernière ligne utile', e2 && /plantage simulé/.test(e2.message) && /code 1/.test(e2.message), e2 && e2.message);
    const ac = new AbortController();
    const t0 = Date.now();
    const p1 = py.run('slow', {}, { cwd: path.join(dir, 'slow'), signal: ac.signal });
    setTimeout(() => ac.abort(), 400);
    let e3 = null;
    try { await p1; } catch (e) { e3 = e; }
    check('annulation coopérative (fichier cancel)', e3 && e3.name === 'AbortError' && Date.now() - t0 < 2500, Date.now() - t0);
    const ac2 = new AbortController();
    const t1 = Date.now();
    const p2 = py.run('stubborn', {}, { cwd: path.join(dir, 'stub'), signal: ac2.signal });
    setTimeout(() => ac2.abort(), 300);
    let e4 = null;
    try { await p2; } catch (e) { e4 = e; }
    const dt = Date.now() - t1;
    check('worker têtu tué (taskkill /T) après 3 s', e4 && e4.name === 'AbortError' && dt >= 3000 && dt < 8000, dt);
    check('plus aucun processus Python à nous', py.running() === 0);
  }

  // ================================================================ pyexe : quel python.exe lancer (aucun Python réel)
  section('pyexe — un venv est lancé par son interpréteur réel (pas de fenêtre de console), le reste est inchangé');
  {
    const { pythonFor } = require(path.join(ENGINE, 'pyexe.js'));
    const root = path.join(tmp, 'pyexe');
    const touch = (p, txt = '') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); return p; };
    const same = (r, py) => r.exe === py && JSON.stringify(r.env) === '{}';
    const home = path.join(root, 'home');
    touch(path.join(home, 'python.exe'));
    const venvPy = touch(path.join(root, 'venv', 'Scripts', 'python.exe'));
    touch(path.join(root, 'venv', 'pyvenv.cfg'), `home = ${home}\r\ninclude-system-site-packages = false\r\nversion = 3.13.18\r\n`);
    const r1 = pythonFor(venvPy);
    check('venv complet : l’interpréteur du « home » de pyvenv.cfg, et __PYVENV_LAUNCHER__ = le python du venv',
      r1.exe === path.join(home, 'python.exe') && JSON.stringify(r1.env) === JSON.stringify({ __PYVENV_LAUNCHER__: venvPy }), r1);
    const noCfg = touch(path.join(root, 'sans-cfg', 'Scripts', 'python.exe'));
    check('sans pyvenv.cfg : chemin inchangé, aucune variable', same(pythonFor(noCfg), noCfg), pythonFor(noCfg));
    const gone = touch(path.join(root, 'home-absent', 'Scripts', 'python.exe'));
    touch(path.join(root, 'home-absent', 'pyvenv.cfg'), `home = ${path.join(root, 'nulle-part')}\n`);
    check('« home » sans python.exe (Python désinstallé) : inchangé', same(pythonFor(gone), gone), pythonFor(gone));
    const noHome = touch(path.join(root, 'sans-home', 'Scripts', 'python.exe'));
    touch(path.join(root, 'sans-home', 'pyvenv.cfg'), 'version = 3.13.18\n');
    check('pyvenv.cfg sans ligne « home » : inchangé', same(pythonFor(noHome), noHome), pythonFor(noHome));
    const embed = touch(path.join(root, 'python_embeded', 'python.exe'));
    touch(path.join(root, 'pyvenv.cfg'), `home = ${home}\n`);
    check('dossier parent autre que « Scripts » (python_embeded d’un ComfyUI portable) : inchangé', same(pythonFor(embed), embed), pythonFor(embed));
    const self = touch(path.join(root, 'boucle', 'Scripts', 'python.exe'));
    touch(path.join(root, 'boucle', 'pyvenv.cfg'), `home = ${path.join(root, 'boucle', 'Scripts').toUpperCase()}\n`);
    check('« home » = le dossier Scripts lui-même (à la casse près) : inchangé, pas de boucle', same(pythonFor(self), self), pythonFor(self));
    check('chemin vide ou nul : rendu tel quel, aucune variable, aucune erreur', pythonFor(null).exe === null && same(pythonFor(null), null)
      && same(pythonFor(undefined), undefined) && same(pythonFor(''), ''));
    // câblage : ComfyUI et les tâches Python passent tous deux par pythonFor, et posent ses variables
    const srcOf = (f) => fs.readFileSync(path.join(ENGINE, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check('comfy.js et pyrun.js lancent real.exe avec ...real.env', ['comfy.js', 'pyrun.js'].every((f) => /pythonFor\(/.test(srcOf(f)) && /spawn\(real\.exe/.test(srcOf(f)) && /\.\.\.real\.env/.test(srcOf(f))));
  }

  // bloc Modèle : sa sortie « out » se lit aussi dans un calcul d'avant le 25/10, rangé sous « video » ou « image »
  {
    const vid = { path: 'outputs/n/r/video.mp4', kind: 'video' };
    check('sortie « out » d’un bloc Modèle rangée sous « video » (calcul d’avant le 25/10)', I.runOutput({ outputs: { video: vid } }, 'out') === vid);
    check('sortie « out » rangée sous « out »', I.runOutput({ outputs: { out: vid } }, 'out') === vid);
    check('un autre port manquant reste manquant', I.runOutput({ outputs: { video: vid } }, 'mask') === null);
    check('deux sorties : « out » n’en devine aucune', I.runOutput({ outputs: { a: vid, b: vid } }, 'out') === null);
    const gen = require(path.join(ENGINE, 'executors', 'gen.js'));
    check('gen.js range le résultat d’un calcul du PC sous « out »', /res\.outputs = \{ out: first \}/.test(fs.readFileSync(path.join(ENGINE, 'executors', 'gen.js'), 'utf8')) && typeof gen.run === 'function');
  }

  section('File derrière un entraînement : la raison de chaque calcul quand celui de tête ne partira pas à côté (relecture du 19/11)');
  {
    // pump() réel sur un moteur sans processus ni GPU : l'état de l'entraînement et la mémoire sont simulés
    const { Engine } = require(path.join(ENGINE, 'index.js'));
    const plain = (x) => String(x || '').replace(/ /g, ' ');
    const END = new Date(2026, 10, 19, 18, 6).getTime();
    const mk = (lang = 'fr') => {
      const e = Object.create(Engine.prototype);
      Object.assign(e, { jobs: new Map(), order: [], _prefs: { lang }, opts: { besideSettleSteps: 0, besideSettleMs: 0 }, ctx: {},
        _disposed: false, _besideMem: { usedGB: 46.5, at: Date.now() }, _besideStill: 0, finished: [], ev: [] });
      e.emitJob = (j, kind) => { e.ev.push([j.jobId, kind, j.message]); };
      e.pushStatusSoon = () => {}; e.logLine = () => {}; e.send = () => {};
      e.start = (j) => { j._.active = true; j.state = 'running'; e.ev.push([j.jobId, 'start']); };
      e.besideMeasure = () => {};
      e.machine = () => ({ memGB: 94, source: 'comfy' });
      e._hold = { held: true, wants: false, qui: 'Mia : Essai à côté' };
      e.T = { id: 't1', name: 'Essai à côté', state: 'entrainement', phase: 'train', step: 500, endAt: END, peakVramGB: 46 };
      e.trainer = { brief: () => e.T };
      return e;
    };
    let n = 0;
    const job = (e, label, gb, { video = false, basis = 'measured' } = {}) => {
      const j = { jobId: 'u' + (++n), label, state: 'queued', message: 'En attente',
        _: { gpu: 'heavy', online: false, active: false, spec: { deps: [], params: {}, gen: video ? { kind: 'video' } : { kind: 'image' },
          models: { m: { mem: { basis, gb }, caps: video ? ['image-to-video'] : ['text-to-image'] } } } } };
      e.jobs.set(j.jobId, j); e.order.push(j.jobId); return j;
    };
    const m = (j) => plain(j.message);
    const started = (e) => e.ev.filter((x) => x[1] === 'start').map((x) => x[0]);
    const VID = 'Attend la fin de l’entraînement « Essai à côté » (vers 18 h 06) : une vidéo ne part pas à côté';
    const OLDMSG = 'En file : entraînement « Essai à côté » en cours (fin vers 18 h 06)';
    const after = (first) => 'Attend la fin de l’entraînement « Essai à côté » (vers 18 h 06), puis « ' + first + ' », placé avant lui dans la file';
    const after3 = (first) => 'Attend la fin de l’entraînement « Essai à côté » (vers 18 h 06), puis 3 calculs placés avant lui dans la file, dont « ' + first + ' »';
    // A) 3 vidéos LTX en tête, une image Qwen (23 Go : 46,5 + 23 + 16 < 94, elle tiendrait) derrière
    {
      const e = mk();
      const v = [1, 2, 3].map(() => job(e, 'LTX 2.5', 30, { video: true }));
      const q = job(e, 'Qwen 2.1', 23);
      e.pump();
      check('vidéos en tête : l’image derrière attend la fin de l’entraînement puis « LTX 2.5 » (pas « son tour à côté »)',
        v.every((x) => m(x) === VID) && m(q) === after3('LTX 2.5') && started(e).length === 0 && q.trainWait === true, [...v, q].map(m));
      check('… les trois vidéos comptées, en court aussi : « Après l’entraînement (vers 18 h 06), puis 3 calculs placés avant »',
        plain(q.waitShort) === 'Après l’entraînement (vers 18 h 06), puis 3 calculs placés avant', q.waitShort);
      e.T = { ...e.T, state: 'preparation', phase: 'encode' };
      e.pump();
      check('… pendant la préparation aussi (pas « ait démarré ses pas »)', m(q) === after3('LTX 2.5') && v.every((x) => m(x) === VID), m(q));
      const k = e.ev.length;
      e.pump(); e.pump(); e.pump();
      check('… stable : trois passes sans changement, aucun nouvel évènement', e.ev.length === k, e.ev.slice(k));
    }
    // B) FLUX.2 Klein sans estimation mesurée (« réglé pour 24 Go ») en tête, Qwen derrière
    {
      const e = mk();
      const fx = job(e, 'FLUX.2 Klein', 29, { basis: 'catalog' });
      const q = job(e, 'Qwen 2.1', 23);
      e.pump();
      check('tête sans estimation mesurée : elle garde le message d’avant ; l’image derrière attend la fin puis « FLUX.2 Klein »',
        m(fx) === OLDMSG && m(q) === after('FLUX.2 Klein') && started(e).length === 0, [fx, q].map(m));
    }
    // C) « 4 variantes » de Qwen 2.1, un autre programme prend 60 Go : la 1re attend de la place, les 3 autres leur tour
    //    derrière « un autre « Qwen 2.1 » » (avant : « « Qwen 2.1 » passe avant » sur une rangée nommée Qwen 2.1)
    {
      const e = mk();
      e._besideMem = { usedGB: 60, at: Date.now() };
      const qs = [1, 2, 3, 4].map(() => job(e, 'Qwen 2.1', 23));
      e.pump();
      check('« 4 variantes » sans place : la 1re dit les chiffres, la 2e « un autre « Qwen 2.1 » passe avant », les suivantes comptent ceux d’avant',
        /il faut ≈ 23 Go, 34 sont libres moins 16 de marge$/.test(m(qs[0]))
        && m(qs[1]) === 'Attend son tour à côté de l’entraînement « Essai à côté » : un autre « Qwen 2.1 » passe avant'
        && m(qs[2]) === 'Attend son tour à côté de l’entraînement « Essai à côté » : 2 calculs passent avant'
        && m(qs[3]) === 'Attend son tour à côté de l’entraînement « Essai à côté » : 3 calculs passent avant'
        && plain(qs[3].waitShort) === 'Son tour à côté : 3 calculs passent avant'
        && started(e).length === 0, qs.map(m));
      const en = mk('en');
      en._besideMem = { usedGB: 60, at: Date.now() };
      const qe = [1, 2].map(() => job(en, 'Qwen 2.1', 23));
      en.pump();
      check('… en anglais : « another “Qwen 2.1” goes first »', qe[1].message === 'Waiting its turn alongside the training “Essai à côté”: another “Qwen 2.1” goes first', qe[1].message);
    }
    // D) une tête qui partira à côté (elle attend de la place) : celle d'après attend son tour, la tête nommée
    {
      const e = mk();
      e._besideMem = { usedGB: 60, at: Date.now() };
      const q = job(e, 'Qwen 2.1', 23);
      const c = job(e, 'Profondeur', 10);
      e.pump();
      check('tête qui attend de la place à côté : celle d’après « attend son tour : « Qwen 2.1 » passe avant », rien ne part',
        m(c) === 'Attend son tour à côté de l’entraînement « Essai à côté » : « Qwen 2.1 » passe avant' && started(e).length === 0, [q, c].map(m));
      e._besideMem = { usedGB: 46.5, at: Date.now() };
      e.pump();
      check('… la place revient : la tête part, l’autre attend le calcul à côté (un seul à la fois)',
        started(e).join() === q.jobId && m(c) === 'Attend le calcul en cours à côté de l’entraînement « Essai à côté »', [started(e), m(c)]);
    }
    // E) une image qui attend de la place, puis une vidéo, puis une image : la 2e image est derrière la vidéo
    {
      const e = mk();
      e._besideMem = { usedGB: 60, at: Date.now() };
      const q = job(e, 'Qwen 2.1', 23);
      const v = job(e, 'LTX 2.5', 30, { video: true });
      const c = job(e, 'Profondeur', 10);
      e.pump();
      check('image, vidéo, image : la 2e image attend la fin de l’entraînement puis « LTX 2.5 »', m(v) === VID && m(c) === after('LTX 2.5'), [q, v, c].map(m));
    }
  }

  console.log(`\n${passes} contrôles réussis, ${failures} échec(s).`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows garde parfois un verrou un instant */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('\nERREUR DU BANC :', e && e.stack ? e.stack : e);
  process.exit(1);
});
