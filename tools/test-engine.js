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
const waitEnd = (jobId, ms) => waitFor((e) => e.jobId === jobId && ['done', 'error', 'cancelled'].includes(e.kind), ms, `fin de ${jobId}`);
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
  T.cfg = {};
  check('showIf (unitaire)', I.shownParam({ showIf: { param: 'lora', notIn: ['none', null, ''] } }, { lora: 'none' }) === false
    && I.shownParam({ showIf: { param: 'lora', notIn: ['none', null, ''] } }, { lora: 'x' }) === true
    && I.shownParam({ showIf: { param: 'lora', notIn: ['none', null, ''] } }, {}) === false && I.shownParam({}, {}) === true);

  // ================================================================ entrée facultative vide
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

  console.log(`\n${passes} contrôles réussis, ${failures} échec(s).`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows garde parfois un verrou un instant */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('\nERREUR DU BANC :', e && e.stack ? e.stack : e);
  process.exit(1);
});
