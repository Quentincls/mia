'use strict';
// Banc d'essai de l'entraînement de LoRA, en Node pur (sans Electron, sans Python, sans GPU) : node tools/test-trainer.js
//
// - le service electron/trainer.js avec un faux ctx, sur le FAUX outil tools/fixtures/train/fake-trainer.js
//   (un script Node qui parle le protocole du dossier d'entraînement) ;
// - tout est écrit sous _dev/tmp/test-trainer-<pid> (jamais dans AppData, jamais dans le moteur, jamais dans le vrai
//   dossier des entraînements) ; le verrou GPU est un fichier TEMPORAIRE, jamais <moteur>\runtime\gpu.lock ;
// - la « corbeille » est un dossier du banc ; aucun processus n'est laissé derrière (vérifié à la fin).
// Code de sortie 1 si un contrôle échoue.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

process.env.MIA_TRAIN_FAKE = '1';        // la base « fake » n'existe qu'ainsi ; les entraînements vont sous <userData>\training
delete process.env.MIA_NO_GPU;           // testé à part (section « MIA_NO_GPU=1 »)
delete process.env.MIA_USERDATA;
process.env.MIA_NO_LAB = '1';            // jamais le labo de l'auteur comme moteur par défaut : le banc donne le sien

const MIA = path.resolve(__dirname, '..');
const { register, TIMING, Trainer, _internals: I } = require(path.join(MIA, 'electron', 'trainer.js'));
const places = require(path.join(MIA, 'electron', 'places.js'));
const C = require(path.join(MIA, 'electron', 'train', 'common.js'));
const LTX = require(path.join(MIA, 'electron', 'train', 'ltx.js'));
const AITK = require(path.join(MIA, 'electron', 'train', 'aitk.js'));
const FAKE = require(path.join(MIA, 'electron', 'train', 'fake.js'));
const { pidAlive } = require(path.join(MIA, 'electron', 'engine', 'gpulock.js'));
const FAKE_TRAINER = path.join(__dirname, 'fixtures', 'train', 'fake-trainer.js');

// ------------------------------------------------------------------ petit cadre de test
let failures = 0;
let passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log(`  ok    ${name}`); }
  else { failures++; console.log(`  ÉCHEC ${name}${detail !== undefined ? ` → ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}
const section = (t) => console.log(`\n== ${t}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000, every = 20) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await wait(every);
  }
}
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// ------------------------------------------------------------------ dossier de travail (dans la copie de travail)
const WORK = path.join(MIA, '_dev', 'tmp', `test-trainer-${process.pid}`);
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const ENGINE = path.join(WORK, 'moteur');
const LOCK = path.join(ENGINE, 'runtime', 'gpu.lock');
const BIN = path.join(WORK, 'corbeille');
fs.mkdirSync(path.dirname(LOCK), { recursive: true });
fs.mkdirSync(BIN, { recursive: true });
if (!path.resolve(LOCK).toLowerCase().startsWith(path.resolve(MIA).toLowerCase())) throw new Error('verrou hors du banc : refus');

// ------------------------------------------------------------------ images de fixture (fabriquées ici, rien de binaire dans le dépôt)
function pngOf(w, h, salt = 0) {
  const b = Buffer.alloc(64, salt & 0xff);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function jpegOf(w, h, orientation) {
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0, 0, 0, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 2 + 6 + tiff.length]), Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.from([0xff, 0xd9])]);
}
function webpOf(w, h) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(22, 4); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1'); b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return b;
}

// un jeu propre de 10 images avec légendes, pour les entraînements du banc
const SET10 = path.join(WORK, 'jeu10');
fs.mkdirSync(SET10, { recursive: true });
for (let i = 1; i <= 10; i++) {
  fs.writeFileSync(path.join(SET10, `rosa_${String(i).padStart(2, '0')}.png`), pngOf(1024, 1024, i));
  fs.writeFileSync(path.join(SET10, `rosa_${String(i).padStart(2, '0')}.txt`), `seated by a window, picture ${i}`);
}

// ------------------------------------------------------------------ faux ctx
// Délais raccourcis, mais larges devant un ralentissement du disque (antivirus, autre tâche sur la machine) : aucun
// contrôle ne dépend d'une course de moins d'une seconde.
const FAST = {
  tickMs: 25, pushMs: 40, aliveMs: 100, retryMs: 120, renewMs: 150, stopMs: 1500, stopSampleMs: 9000, quitMs: 1500,
  warnMinMs: 600000, warnPaces: 0, killMinMs: 2700000, killPaces: 0, adoptMaxAgeMs: 60000, noteMs: 60000
};
const WORLD = { queueIdle: true, free: 500 * 1024 ** 3, clock: 0, commitGB: 64, prefs: { lang: 'fr', engineRoot: ENGINE } };
const allLogs = [];
const trashed = [];
const made = [];                              // tous les services créés, pour ne laisser aucun outil derrière

function makeTrainer(userData, extra = {}) {
  const handlers = new Map();
  const sent = [];
  const ctx = {
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    send: (ch, payload) => sent.push({ ch, payload }),
    paths: { root: MIA, data: path.join(userData, 'data'), userData },
    prefs: { get: () => WORLD.prefs, onChange: () => {} },
    logger: () => (...a) => allLogs.push(a.join(' ')),
    engine: null,
    trainOpts: {
      lockPath: LOCK,
      timing: { ...FAST },
      queueIdle: () => WORLD.queueIdle,
      freeBytes: () => (WORLD.freeFn ? WORLD.freeFn() : WORLD.free),
      commitGB: async () => WORLD.commitGB,
      now: () => Date.now() + WORLD.clock,
      learnFake: true,
      toolsDir: path.join(WORK, 'outils'),
      openPath: (d) => { WORLD.opened = d; },
      trash: async (abs) => {
        trashed.push(abs);
        fs.renameSync(abs, path.join(BIN, `${trashed.length}_${path.basename(abs)}`));
      },
      ...extra
    }
  };
  const t = register(ctx);
  const T = { t, ctx, sent, handlers, userData, invoke: (ch, ...args) => handlers.get(ch)({ sender: null }, ...args) };
  made.push(T);
  return T;
}

const UD = path.join(WORK, 'ud');
fs.mkdirSync(UD, { recursive: true });

async function draft(T, name, fake = {}, o = {}) {
  const r = T.t.create({ name, base: 'fake', kind: 'character', trigger: 'rsa woman', fake: { msPerStep: 8, ...fake } });
  T.t.update(r.id, { steps: o.steps || 40, settings: { saveEvery: o.saveEvery || 10, sampleEvery: o.sampleEvery == null ? 20 : o.sampleEvery } });
  T.t.addImages(r.id, [SET10]);
  await T.t.importIdle(r.id);
  return r.id;
}
const doc = (T, id) => T.t.item(id).doc;
const dirOf = (T, id) => T.t.item(id).dir;
// un état « de repos » (pause, fini, annule, erreur…) n'est acquis que lorsque le service a rendu la main
const until = (T, id, states, ms) => waitFor(() => {
  const it = T.t.item(id);
  if (!it || !states.includes(it.doc.state)) return false;
  return ['attente', 'preparation', 'entrainement', 'essai'].includes(it.doc.state) || !it.live;
}, ms);
// « Mia tuée » : le service ne relève plus rien et ne renouvelle plus son verrou (le fichier, lui, reste)
function crash(T) {
  T.t.dispose();
  for (const it of T.t.items.values()) if (it.live && it.live.hold && it.live.hold.abandon) it.live.hold.abandon();
}
const lockNow = () => { try { return readJSON(LOCK); } catch { return null; } };
const stepsOf = (T, id) => T.t.curve(T.t.item(id)).map((m) => m.s);
const contiguous = (list, n) => list.length === n && list.every((s, i) => s === i + 1);

(async () => {
  // ================================================================ 0. briques
  section('Briques : safetensors, images, légendes, noms');
  {
    const d = path.join(WORK, 'briques');
    fs.mkdirSync(d, { recursive: true });
    const head = Buffer.from(JSON.stringify({ __metadata__: { a: 'b' }, w: { dtype: 'F32', shape: [4], data_offsets: [0, 16] } }));
    const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(head.length), 0);
    fs.writeFileSync(path.join(d, 'bon.safetensors'), Buffer.concat([len, head, Buffer.alloc(16)]));
    fs.writeFileSync(path.join(d, 'coupe.safetensors'), Buffer.concat([len, head, Buffer.alloc(9)]));
    fs.writeFileSync(path.join(d, 'trop.safetensors'), Buffer.concat([len, head, Buffer.alloc(20)]));
    fs.writeFileSync(path.join(d, 'bruit.safetensors'), 'pas un fichier de poids');
    check('safetensors complet reconnu', C.safetensorsComplete(path.join(d, 'bon.safetensors')));
    check('safetensors tronqué refusé (en-tête intact, données coupées)', !C.safetensorsComplete(path.join(d, 'coupe.safetensors')));
    check('safetensors trop long refusé', !C.safetensorsComplete(path.join(d, 'trop.safetensors')));
    check('fichier quelconque refusé', !C.safetensorsComplete(path.join(d, 'bruit.safetensors')) && !C.safetensorsComplete(path.join(d, 'absent.safetensors')));

    const png = I.imageSize(pngOf(640, 480));
    check('PNG : dimensions lues', png && png.w === 640 && png.h === 480, png);
    const j1 = I.imageSize(jpegOf(300, 100, 1));
    const j6 = I.imageSize(jpegOf(300, 100, 6));
    check('JPEG : dimensions lues', j1 && j1.w === 300 && j1.h === 100, j1);
    check('JPEG tourné par EXIF (orientation 6) : largeur et hauteur échangées', j6 && j6.w === 100 && j6.h === 300, j6);
    const wp = I.imageSize(webpOf(800, 1200));
    check('WebP : dimensions lues', wp && wp.w === 800 && wp.h === 1200, wp);
    check('fichier qui n’est pas une image : null', I.imageSize(Buffer.from('bonjour, je ne suis pas une image du tout')) === null);

    fs.writeFileSync(path.join(d, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('  été à la fenêtre \r\n')]));
    fs.writeFileSync(path.join(d, 'u16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('café', 'utf16le')]));
    fs.writeFileSync(path.join(d, 'vide.txt'), '   \r\n ');
    check('légende : BOM retiré, espaces coupés', I.readCaption(path.join(d, 'bom.txt')) === 'été à la fenêtre');
    check('légende UTF-16 lue', I.readCaption(path.join(d, 'u16.txt')) === 'café');
    check('légende faite d’espaces = absente', I.readCaption(path.join(d, 'vide.txt')) === '' && I.readCaption(path.join(d, 'absente.txt')) === '');
    check('nom de fichier sûr (accents, espaces)', I.cleanStem('Rosa été / 2') === 'Rosa_ete_2' && I.cleanStem('') === 'lora');
    check('dernière ligne utile d’un journal', I.meaningfulLine(['ok', 'Traceback (most recent call last):', '  File "x.py", line 3', 'ValueError: non', '   ^^^', '']) === 'ValueError: non');
    // +null vaut 0 : sans cette garde, une moyenne d'aucun pas s'affichait « 0,000 MOY. 100 PAS » et partait à l'assistant
    check('arrondi : null, undefined et « » restent null ; une vraie perte nulle reste 0', I.round(null, 4) === null && I.round(undefined) === null && I.round('', 2) === null && I.round(0, 4) === 0 && I.round(0.12345, 4) === 0.1235 && I.round('x') === null);
  }

  section('Catalogue, descripteurs d’outil, canaux');
  {
    const cat = readJSON(path.join(MIA, 'src', 'catalog', 'train-bases.json'));
    const by = Object.fromEntries(cat.bases.map((b) => [b.id, b]));
    check('LTX 2.5 : 1 500 / 2 500 / 3 000 pas, point tous les 250, essai tous les 500, rang 32', by.ltx25.lengths.short === 1500 && by.ltx25.lengths.normal === 2500 && by.ltx25.lengths.long === 3000
      && by.ltx25.defaults.saveEvery === 250 && by.ltx25.defaults.sampleEvery === 500 && by.ltx25.defaults.rank === 32 && by.ltx25.suffix === 'ltx25');
    check('LTX 2.5 : prêt à l’emploi (essai réussi), outil 1.6.2, 3 fichiers de poids', by.ltx25.tried === true && by.ltx25.toolVersion === '1.6.2' && by.ltx25.weights.length === 3);
    check('Qwen-Image 2.1 : présent mais pas encore essayé', by.qwen21.enabled === true && by.qwen21.tried === false && by.qwen21.lengths.normal === 2000 && by.qwen21.suffix === 'qwenimage21');
    check('Flux 2 Klein et MiniMax H3 : invisibles', by.flux2klein9b.enabled === false && by.minimaxh3.enabled === false);
    check('10 images au moins, conseil sous 20', cat.minImages === 10 && cat.adviseImages === 20);

    // faux dossier d'outils : la détection lit des fichiers, ne lance aucun Python
    const tools = path.join(WORK, 'outils');
    const sp = path.join(tools, 'venv-ltx', 'Lib', 'site-packages');
    fs.mkdirSync(path.join(tools, 'venv-ltx', 'Scripts'), { recursive: true });
    fs.mkdirSync(sp, { recursive: true });
    check('LTX : venv absent → outil introuvable', LTX.detect({ toolsDir: path.join(WORK, 'nulle-part'), root: MIA, toolVersion: '1.6.2' }).why.code === 'tool');
    fs.writeFileSync(path.join(tools, 'venv-ltx', 'Scripts', 'python.exe'), '');
    fs.mkdirSync(path.join(tools, 'src', 'LTX-2', 'packages', 'ltx-trainer', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(tools, 'src', 'LTX-2', 'packages', 'ltx-trainer', 'scripts', 'preprocess.py'), '');
    fs.mkdirSync(path.join(sp, 'ltx_trainer-1.7.0.dist-info'), { recursive: true });
    const v170 = LTX.detect({ toolsDir: tools, root: MIA, toolVersion: '1.6.2' });
    check('LTX : version 1.7.0 → non validée (version exacte exigée)', !v170.ok && v170.why.code === 'version' && v170.why.version === '1.7.0', v170);
    fs.renameSync(path.join(sp, 'ltx_trainer-1.7.0.dist-info'), path.join(sp, 'ltx_trainer-1.6.2.dist-info'));
    const v162 = LTX.detect({ toolsDir: tools, root: MIA, toolVersion: '1.6.2' });
    const adapter = path.join(MIA, 'python', 'train', 'mia_train_ltx.py');
    check('LTX : version 1.6.2 lue dans le venv ; prêt seulement si l’adaptateur de Mia existe',
      v162.version === '1.6.2' && (fs.existsSync(adapter) ? v162.ok : (!v162.ok && v162.why.code === 'tool' && v162.why.path === adapter)), v162);
    const cmd = LTX.command({ dir: 'X:\\t', run: 3, token: 'abc', resumeFrom: 1250, toolsDir: tools, root: MIA, engineRoot: ENGINE });
    check('LTX : commande = adaptateur --dir --run --token --resume, hors ligne, sans wandb',
      cmd.args.join(' ').includes('mia_train_ltx.py --dir X:\\t --run 3 --token abc --resume 1250') && cmd.env.HF_HUB_OFFLINE === '1' && cmd.env.WANDB_MODE === 'disabled' && cmd.env.PYTHONUTF8 === '1', cmd);
    check('ai-toolkit : venv absent → outil introuvable', AITK.detect({ toolsDir: tools, root: MIA }).why.code === 'tool');
    const acmd = AITK.command({ dir: 'X:\\t', run: 1, token: 'k', resumeFrom: 0, toolsDir: tools, root: MIA, engineRoot: ENGINE });
    check('ai-toolkit : lancé depuis ses sources, modèles du moteur, HF_HOME hors du profil, pas de --resume au premier lancement',
      acmd.cwd === path.join(tools, 'src', 'ai-toolkit') && acmd.env.MODELS_PATH === path.join(ENGINE, 'models') && acmd.env.HF_HOME === path.join(tools, 'hf') && !acmd.args.includes('--resume'), acmd);
    const slugDir = path.join(WORK, 'aitk', 'out', 'aida');
    fs.mkdirSync(slugDir, { recursive: true });
    for (const n of ['aida_000000250.safetensors', 'aida_000000500.safetensors', 'aida.safetensors', 'autre.safetensors', 'aida_000000250.txt']) fs.writeFileSync(path.join(slugDir, n), 'x');
    const acks = AITK.checkpoints(path.join(WORK, 'aitk'), { slug: 'aida', steps: 2000 });
    check('ai-toolkit : points lus par leur nom (pas sur 9 chiffres, fichier final = dernier pas)', acks.map((c) => c.step).join() === '250,500,2000' && acks[0].file === 'out/aida/aida_000000250.safetensors', acks);
    check('faux outil : seulement avec MIA_TRAIN_FAKE=1', FAKE.detect({ root: MIA }).ok === true);
    process.env.MIA_TRAIN_FAKE = '0';
    check('faux outil : absent sans MIA_TRAIN_FAKE', FAKE.detect({ root: MIA }).ok === false && FAKE.enabled() === false);
    process.env.MIA_TRAIN_FAKE = '1';
    const real = 'C:\\IA\\entrainement';
    if (fs.existsSync(path.join(real, 'venv-ltx'))) {
      check('vrai venv-ltx de cette machine (lecture seule) : ltx-trainer 1.6.2', C.distVersion(path.join(real, 'venv-ltx'), 'ltx-trainer') === '1.6.2');
    }

    const pre = fs.readFileSync(path.join(MIA, 'electron', 'preload.js'), 'utf8');
    const channels = [...pre.split('/* channels:invoke:begin */')[1].split('/* channels:invoke:end */')[0].matchAll(/'(train:[A-Za-z]+)'/g)].map((m) => m[1]);
    const T0 = makeTrainer(path.join(WORK, 'ud-canaux'));
    check('preload : 17 canaux train:*', channels.length === 17, channels);
    check('chaque canal train:* du preload a un traitement dans le service', channels.every((c) => T0.handlers.has(c)) && T0.handlers.size === channels.length, channels.filter((c) => !T0.handlers.has(c)));
    check('preload : évènement train:event et mia.train.onEvent', /trainEvent: 'train:event'/.test(pre) && /onEvent: \(cb\) => listen\(EVENTS\.trainEvent, cb\)/.test(pre));
    const main = fs.readFileSync(path.join(MIA, 'electron', 'main.js'), 'utf8');
    check('main.js : le module trainer est chargé après engine et avant bridge', /'engine', 'trainer', 'bridge'/.test(main));
    const none = await T0.invoke('train:get', 'inconnu');
    check('canal : entraînement inconnu → phrase lisible, pas d’exception', none.ok === false && none.error === 'Entraînement introuvable.', none);
  }

  section('Emplacements et réglages');
  {
    const ud = path.join(WORK, 'ud-places');
    fs.mkdirSync(ud, { recursive: true });
    check('instance de test : entraînements sous <userData>\\training, quels que soient les réglages',
      places.trainingRoot({ trainRoot: 'X:\\ailleurs', engineRoot: ENGINE }, ud) === path.join(ud, 'training')
      && places.trainingRoots({ trainRoots: ['X:\\ancien'] }, ud).length === 1);
    process.env.MIA_TRAIN_FAKE = '0';
    try {
      check('vraie instance : sans dossier « entrainement » à côté du moteur → <userData>\\training', places.trainingRoot({ engineRoot: ENGINE }, ud) === path.join(ud, 'training'));
      fs.mkdirSync(path.join(WORK, 'entrainement'), { recursive: true });
      check('vraie instance : <parent du moteur>\\entrainement\\mia quand ce dossier existe', places.trainingRoot({ engineRoot: ENGINE }, ud) === path.join(WORK, 'entrainement', 'mia'));
      check('outils par défaut : <parent du moteur>\\entrainement', places.trainingTools({ engineRoot: ENGINE }) === path.join(WORK, 'entrainement'));
      check('le réglage gagne ; les anciens dossiers restent listés, sans doublon',
        places.trainingRoot({ trainRoot: 'X:\\choisi', engineRoot: ENGINE }, ud) === 'X:\\choisi'
        && places.trainingRoots({ trainRoot: 'X:\\choisi', trainRoots: ['X:\\ancien', 'x:\\CHOISI'], engineRoot: ENGINE }, ud).join('|') === 'X:\\choisi|X:\\ancien');
      check('MIA_USERDATA suffit à faire une instance de test', (() => { process.env.MIA_USERDATA = ud; const r = places.trainingIsTest(); delete process.env.MIA_USERDATA; return r; })());

      // le magasin de réglages (store.js), sur des données du banc
      const store = require(path.join(MIA, 'electron', 'store.js'));
      const sud = path.join(WORK, 'ud-store');
      const prefs = await store.init({ userData: sud, documents: WORK, projectsRootOverride: path.join(WORK, 'projets'), log: () => {}, trash: async () => {} });
      check('réglages par défaut : trainRoot, trainTools vides (= emplacement par défaut), trainRoots []', prefs.trainRoot === '' && prefs.trainTools === '' && Array.isArray(prefs.trainRoots) && !prefs.trainRoots.length, prefs);
      const S = store._internals.sanitizePrefs({ trainRoot: 'relatif', trainTools: 42, trainRoots: ['X:\\a', 'pas absolu', 'X:\\a\\', 'X:\\b'] });
      check('réglages : valeurs absurdes ramenées à vide, anciens dossiers nettoyés', S.trainRoot === '' && S.trainTools === '' && S.trainRoots.join('|') === 'X:\\a|X:\\b', S);
      check('sans moteur : mia://m/… permet <userData>\\training', store.allowedRoots().includes(path.join(sud, 'training')), store.allowedRoots());
      // un moteur du banc, avec un dossier « entrainement » à côté de lui
      const eng = path.join(WORK, 'st', 'moteur');
      const beside = path.join(WORK, 'st', 'entrainement', 'mia');
      fs.mkdirSync(path.join(eng, 'python_embeded'), { recursive: true });
      fs.writeFileSync(path.join(eng, 'python_embeded', 'python.exe'), '');
      fs.mkdirSync(path.dirname(beside), { recursive: true });
      const p1 = await store.setPrefs({ engineRoot: eng });
      check('moteur choisi : les entraînements vont à côté de lui, l’ancien dossier reste listé', places.trainingRoot(p1, sud) === beside && p1.trainRoot === '' && p1.trainRoots.join('|') === path.join(sud, 'training'), p1.trainRoots);
      check('mia://m/… : les dossiers d’entraînement sont permis', store.allowedRoots().includes(beside) && store.allowedRoots().includes(path.join(sud, 'training')), store.allowedRoots());
      store.setTrainBusyCheck(() => true);
      let refused = null;
      try { await store.setPrefs({ trainRoot: path.join(WORK, 'autre-racine') }); } catch (e) { refused = e; }
      check('changer le dossier des entraînements pendant un entraînement : refusé, phrase lisible', !!refused && /pendant un entraînement/.test(refused.userMessage || ''), refused && refused.message);
      check('… et rien n’a changé', store.getPrefs().trainRoot === '');
      check('… un autre réglage passe toujours', (await store.setPrefs({ snap: true })).snap === true);
      store.setTrainBusyCheck(() => false);
      const p2 = await store.setPrefs({ trainRoot: path.join(WORK, 'autre-racine') });
      check('sans entraînement : accepté, les anciens dossiers restent listés (rien n’est déplacé)', p2.trainRoot === path.join(WORK, 'autre-racine') && p2.trainRoots.join('|') === [beside, path.join(sud, 'training')].join('|'), p2.trainRoots);
      check('… et mia://m/… permet les trois', [path.join(WORK, 'autre-racine'), beside, path.join(sud, 'training')].every((d) => store.allowedRoots().includes(d)));
      check('prefs.json relu : réglages d’entraînement gardés', (() => { const j = readJSON(path.join(sud, 'data', 'prefs.json')); return j.trainRoot === path.join(WORK, 'autre-racine') && j.trainRoots.length === 2 && j.trainTools === ''; })());
    } finally {
      process.env.MIA_TRAIN_FAKE = '1';
    }
    if (process.platform === 'win32') {
      const gb = await I.commitAvailableGB();
      check('mémoire engageable de Windows lue (commande PowerShell, lecture seule)', typeof gb === 'number' && gb > 0 && gb < 4096, gb);
    }
  }

  // ================================================================ 1. protocole (étape 1 du plan)
  section('Protocole : le faux outil seul, relu par un script');
  {
    const dir = path.join(WORK, 'protocole');
    fs.mkdirSync(path.join(dir, 'control'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'train.json'), JSON.stringify({ id: 't_proto', steps: 40, dataset: { count: 4 }, settings: { saveEvery: 10, sampleEvery: 20, lr: 0.0001, fake: { msPerStep: 2, sampleMs: 20 } } }));
    fs.writeFileSync(path.join(dir, 'control', 'alive'), '1');
    const before = fs.readFileSync(path.join(dir, 'train.json'));
    const fd = fs.openSync(path.join(dir, 'log.txt'), 'a');
    const code = await new Promise((resolve) => {
      const c = spawn(process.execPath, [FAKE_TRAINER, '--dir', dir, '--run', '1', '--token', 'jeton-proto'], { stdio: ['ignore', fd, fd], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
      c.on('exit', resolve);
    });
    fs.closeSync(fd);
    const ev = lines(path.join(dir, 'events.jsonl'));
    const mt = lines(path.join(dir, 'metrics.jsonl'));
    check('sortie 0', code === 0, code);
    check('events : caps en premier, avec le numéro de lancement', ev[0].e === 'caps' && ev[0].run === 1 && /fake-trainer/.test(ev[0].tool) && ev[0].saveNow === true, ev[0]);
    const phases = ev.filter((e) => e.e === 'phase').map((e) => e.phase);
    check('phases : check → encode (n / of) → load → train', phases.slice(0, 7).join() === 'check,encode,encode,encode,encode,load,train', phases.slice(0, 8));
    const enc = ev.filter((e) => e.e === 'phase' && e.phase === 'encode');
    check('encode : 1 / 4 … 4 / 4', enc.map((e) => `${e.n}/${e.of}`).join() === '1/4,2/4,3/4,4/4');
    check('metrics : une ligne par pas, 1 → 40, lancement 1, perte, lr, dt, t', mt.length === 40 && contiguous(mt.map((m) => m.s), 40)
      && mt.every((m) => m.run === 1 && m.loss > 0 && m.lr === 0.0001 && m.dt >= 0 && m.t > 1e12), mt[0]);
    check('perte retrouvée : décroissante en tendance', mt.slice(0, 5).reduce((a, m) => a + m.loss, 0) > mt.slice(-5).reduce((a, m) => a + m.loss, 0));
    const cks = ev.filter((e) => e.e === 'checkpoint');
    check('points retrouvés : 10, 20, 30, 40, fichiers complets', cks.map((c) => c.step).join() === '10,20,30,40' && cks.every((c) => C.safetensorsComplete(path.join(dir, c.file)) && c.sizeMB > 0), cks);
    check('point = dossier à la manière de LTX (weights + state.pt + metadata.json)', C.ltxCheckpoints(dir).length === 4 && C.ltxCheckpoints(dir).every((c) => C.ltxVerify(dir, c)));
    const smp = ev.filter((e) => e.e === 'sample');
    check('essais retrouvés : 20 et 40, fichiers PNG valides', smp.map((s) => s.step).join() === '20,40' && smp.every((s) => { const d = I.readImageSize(path.join(dir, s.file)); return d && d.w === 8 && s.kind === 'image'; }), smp);
    check('sample_step avant chaque essai (n / total)', ev.filter((e) => e.e === 'sample_step').length === 10 && ev.some((e) => e.e === 'sample_step' && e.n === 5 && e.total === 5));
    check('done au dernier pas', ev[ev.length - 1].e === 'done' && ev[ev.length - 1].step === 40);
    const ad = readJSON(path.join(dir, 'control', 'adapter.json'));
    check('adapter.json : pid, jeton, date', Number.isInteger(ad.pid) && ad.token === 'jeton-proto' && ad.t > 1e12, ad);
    const log = fs.readFileSync(path.join(dir, 'log.txt'), 'utf8');
    check('sortie de l’outil écrite dans log.txt à chaque pas (un fichier, pas un tuyau)', (log.match(/^step \d+\/40 /gm) || []).length === 40);
    check('l’outil n’a pas touché à train.json', fs.readFileSync(path.join(dir, 'train.json')).equals(before));
  }

  // ================================================================ 2. brouillon et jeu d'images
  const A = makeTrainer(UD);
  section('Brouillon : création, import du jeu, raisons du bouton éteint');
  let draftId;
  {
    const opt = await A.invoke('train:options');
    const ob = Object.fromEntries(opt.bases.map((b) => [b.id, b]));
    check('options : LTX 2.5, Qwen-Image 2.1 et la base de test ; ni Flux ni MiniMax', Object.keys(ob).sort().join() === 'fake,ltx25,qwen21', Object.keys(ob));
    check('options : Qwen grisé « Pas encore essayé sur cette machine »', ob.qwen21.ready === false && ob.qwen21.why.code === 'untried' && ob.qwen21.why.fr === 'Pas encore essayé sur cette machine' && ob.qwen21.why.en === 'Not tried on this machine yet', ob.qwen21.why);
    check('options : durée de Qwen inconnue (aucune mesure), LTX mesuré 5,8 s par pas', ob.qwen21.estimate.measured === false && ob.ltx25.estimate.sPerStep === 5.8 && ob.ltx25.estimate.vramGB === 46);
    check('options : dossier des entraînements du banc, place libre', opt.disk.root === path.join(UD, 'training') && opt.disk.freeGB === 500 && opt.active === null, opt.disk);

    const c = await A.invoke('train:create', { base: 'fake', fake: { msPerStep: 6 } });
    draftId = c.id;
    const dir = c.dir;
    check('création : dossier t_AAAAMMJJ-HHMM_… sous <userData>\\training, train.json écrit', c.ok && /^t_\d{8}-\d{4}_lora$/.test(c.id) && path.dirname(dir) === path.join(UD, 'training') && fs.existsSync(path.join(dir, 'train.json')), c);
    const d0 = readJSON(path.join(dir, 'train.json'));
    check('train.json : v 1, état pret, propriétaire = ce userData, réglages de la base', d0.v === 1 && d0.state === 'pret' && d0.owner.userData === UD && d0.steps === 2500 && d0.settings.saveEvery === 250 && d0.by.who === 'user', d0);
    let g = await A.invoke('train:get', draftId);
    check('bouton éteint : « Donne un nom »', g.ready === false && g.whyCode === 'noName' && g.why === 'Donne un nom', g.why);
    await A.invoke('train:update', draftId, { name: 'Rosa été' });
    g = await A.invoke('train:get', draftId);
    check('puis : « Ajoute au moins 10 images »', g.whyCode === 'fewImages' && g.why === 'Ajoute au moins 10 images', g.why);

    // un dossier « sale » : bonnes images, légendes, image petite, image minuscule, formats refusés, fichier abîmé
    const src = path.join(WORK, 'jeu-sale');
    fs.mkdirSync(src, { recursive: true });
    for (let i = 1; i <= 9; i++) {
      fs.writeFileSync(path.join(src, `img_${i}.png`), pngOf(128, 160, i));
      fs.writeFileSync(path.join(src, `img_${i}.txt`), `\uFEFFa portrait, number ${i}\r\n`);
    }
    fs.writeFileSync(path.join(src, 'sans_legende.png'), pngOf(128, 128, 20));
    fs.writeFileSync(path.join(src, 'legende_vide.png'), pngOf(128, 128, 21));
    fs.writeFileSync(path.join(src, 'legende_vide.txt'), '   \r\n');
    fs.writeFileSync(path.join(src, 'tournee.jpg'), jpegOf(300, 100, 6));
    fs.writeFileSync(path.join(src, 'large.webp'), webpOf(800, 1200));
    fs.writeFileSync(path.join(src, 'petite.png'), pngOf(40, 200, 22));          // petit côté 40 : sous 64, au-dessus de 32
    fs.writeFileSync(path.join(src, 'minuscule.png'), pngOf(20, 20, 23));        // sous la moitié du seuil : écartée
    fs.writeFileSync(path.join(src, 'abimee.png'), 'ceci n’est pas un PNG');
    fs.writeFileSync(path.join(src, 'anim.gif'), 'GIF89a');
    fs.writeFileSync(path.join(src, 'notes.md'), 'x');
    const stamp = (f) => { const s = fs.statSync(f); return `${s.size}:${Math.round(s.mtimeMs)}`; };
    const origBefore = Object.fromEntries(fs.readdirSync(src).map((n) => [n, stamp(path.join(src, n))]));
    const emptyTxtBefore = fs.readFileSync(path.join(src, 'legende_vide.txt'));

    const add = await A.invoke('train:addImages', draftId, [src]);
    check('import : rend la main tout de suite, « IMPORT n / total » publié', add.ok && add.importing === true && add.total === 16 && A.t.item(draftId).importing.total === 16, add);
    check('pendant l’import : départ refusé', (await A.invoke('train:start', draftId)).code === 'importBusy');
    await A.t.importIdle(draftId);
    g = await A.invoke('train:get', draftId, { dataset: true });
    check('jeu : 14 images gardées, 9 légendes', g.dataset.count === 14 && g.dataset.captions === 9, g.dataset);
    check('fichiers ignorés comptés par nom d’origine : format, lecture, trop petite d’office',
      ['anim.gif:format', 'notes.md:format', 'abimee.png:unreadable', 'minuscule.png:tiny'].every((k) => g.dataset.skipped.some((s) => `${s.original}:${s.why}` === k)) && g.dataset.skipped.length === 4, g.dataset.skipped);
    const im = Object.fromEntries(g.images.map((x) => [x.original, x]));
    check('image trop petite repérée (petit côté 40 < 64), gardée', g.dataset.small === 1 && im['petite.png'].small === true && im['img_1.png'].small === false, g.dataset);
    check('dimensions lues, EXIF appliqué', im['tournee.jpg'].w === 100 && im['tournee.jpg'].h === 300 && im['large.webp'].w === 800 && im['img_1.png'].h === 160);
    check('images nommées 0001… dans dataset\\, extension gardée', /dataset[\\/]0001\.png$/.test(im['img_1.png'].file) && fs.existsSync(im['img_1.png'].file) && /\.jpg$/.test(im['tournee.jpg'].file));
    check('images LIÉES (lien physique), pas copiées', fs.statSync(im['img_1.png'].file).ino === fs.statSync(path.join(src, 'img_1.png')).ino && fs.statSync(path.join(src, 'img_1.png')).nlink >= 2);
    const cap1 = im['img_1.png'].file.replace(/\.png$/, '.txt');
    check('légendes COPIÉES, normalisées (UTF-8 sans BOM, sans fin de ligne)', fs.readFileSync(cap1, 'utf8') === 'a portrait, number 1' && fs.statSync(cap1).nlink === 1 && im['img_1.png'].caption === 'a portrait, number 1' && im['img_1.png'].captionBy === 'file');
    check('un .txt vide compte comme légende absente', im['legende_vide.png'].captionBy === null && im['sans_legende.png'].captionBy === null);
    const dsj = readJSON(path.join(dir, 'dataset', 'dataset.json'));
    check('dataset.json : n, file, original, w, h, captionBy', dsj.length === 14 && dsj[0].n === 1 && dsj[0].file === '0001.png' && dsj[0].original === 'img_1.png' && dsj[0].w === 128 && dsj[0].captionBy === 'file', dsj[0]);
    const again = await A.invoke('train:addImages', draftId, [path.join(src, 'img_1.png')]);
    await A.t.importIdle(draftId);
    check('la même image ajoutée deux fois n’est pas doublée', again.ok && doc(A, draftId).dataset.count === 14 && doc(A, draftId).dataset.skipped.some((s) => s.why === 'duplicate'));

    g = await A.invoke('train:get', draftId);
    check('puis : « Donne un mot déclencheur »', g.whyCode === 'noTrigger' && g.why === 'Donne un mot déclencheur', g.why);
    await A.invoke('train:update', draftId, { trigger: 'rsa woman' });
    g = await A.invoke('train:get', draftId);
    check('puis : « 5 images sans légende »', g.whyCode === 'noCaption' && g.why === '5 images sans légende', g.why);
    check('consigne d’essai préremplie avec le mot déclencheur (personnage)', g.settings.samplePrompts[0] === 'rsa woman, close-up of the face, soft natural light, photoreal film still', g.settings.samplePrompts);
    await A.invoke('train:update', draftId, { kind: 'style' });
    check('… elle suit le genre tant qu’elle n’a pas été modifiée', doc(A, draftId).settings.samplePrompts[0] === 'a street at night, rsa woman');
    await A.invoke('train:update', draftId, { settings: { samplePrompts: ['ma consigne', ' ', 'deux', 'trois', 'quatre', 'cinq'] } });
    await A.invoke('train:update', draftId, { kind: 'character' });
    check('… plus après une modification ; 4 consignes au plus', doc(A, draftId).settings.samplePrompts.join('|') === 'ma consigne|deux|trois|quatre');

    const sc = await A.invoke('train:setCaption', draftId, 'sans_legende.png', '  a woman at the window ', 'Claude');
    check('légende écrite par un assistant : marquée, dans la copie', sc.ok && sc.captionBy === 'Claude' && fs.readFileSync(im['sans_legende.png'].file.replace(/\.png$/, '.txt'), 'utf8') === 'a woman at the window', sc);
    check('… aucun .txt créé à côté de l’original', !fs.existsSync(path.join(src, 'sans_legende.txt')));
    await A.invoke('train:update', draftId, { triggerOnly: true });
    g = await A.invoke('train:get', draftId, { dataset: true });
    const im2 = Object.fromEntries(g.images.map((x) => [x.original, x]));
    check('« Mot déclencheur seul » : les images sans légende reçoivent le mot, dans la copie', g.dataset.captions === 14 && im2['legende_vide.png'].caption === 'rsa woman' && im2['legende_vide.png'].captionBy === 'trigger' && im2['petite.png'].captionBy === 'trigger', g.dataset);
    check('… le .txt d’origine n’a pas changé', fs.readFileSync(path.join(src, 'legende_vide.txt')).equals(emptyTxtBefore));
    await A.invoke('train:update', draftId, { trigger: 'rsa girl' });
    g = await A.invoke('train:get', draftId, { dataset: true });
    check('… et ces légendes suivent le mot déclencheur', g.images.find((x) => x.original === 'legende_vide.png').caption === 'rsa girl' && g.images.find((x) => x.original === 'img_2.png').caption === 'a portrait, number 2');
    await A.invoke('train:update', draftId, { trigger: 'rsa woman' });

    const rm = await A.invoke('train:removeImage', draftId, 'petite.png');
    check('retirer une image du jeu : l’original reste', rm.ok && rm.dataset.count === 13 && fs.existsSync(path.join(src, 'petite.png')) && !fs.existsSync(im['petite.png'].file), rm);
    check('rien de ce que Mia a écrit n’a touché aux fichiers d’origine (taille et date)', fs.readdirSync(src).every((n) => origBefore[n] === stamp(path.join(src, n))) && fs.readdirSync(src).length === Object.keys(origBefore).length);

    WORLD.free = 1000;
    g = await A.invoke('train:get', draftId);
    check('place disque insuffisante : raison chiffrée', g.whyCode === 'disk' && /^Place disque insuffisante : .* Go nécessaires, 0 Go libres$/.test(g.why), g.why);
    WORLD.free = 500 * 1024 ** 3;
    WORLD.prefs = { lang: 'en', engineRoot: ENGINE };
    await A.invoke('train:update', draftId, { triggerOnly: false });
    g = await A.invoke('train:get', draftId);
    check('en anglais aussi', g.whyCode === 'noCaption' && g.why === '3 images without a caption', g.why);
    WORLD.prefs = { lang: 'fr', engineRoot: ENGINE };
    await A.invoke('train:update', draftId, { triggerOnly: true });

    // mémoire Windows : la base de test n'en demande pas ; on lui en fait demander le temps d'un contrôle
    FAKE.BASE.needCommitGB = 45;
    WORLD.commitGB = 12.5;
    const mem = await A.invoke('train:start', draftId);
    check('mémoire Windows insuffisante : départ refusé avec la raison', mem.ok === false && mem.code === 'memory' && /12,5 Go disponibles, 45 nécessaires/.test(mem.error) && doc(A, draftId).state === 'pret', mem);
    FAKE.BASE.needCommitGB = 0;
    WORLD.commitGB = 64;

    // le contrôle de mémoire Windows et le ComfyUI que Mia a lancé (§4.4) : arrêté s'il ne calcule rien, mesuré à nouveau
    {
      const calls = [];
      let stopped = false;
      let freeAfter = 50;
      A.t.ctx.engine = { freeMemoryForTraining: async () => { calls.push('free'); stopped = true; return { stopped: true }; } };
      A.t.opts.commitGB = async () => { calls.push(`commit=${stopped ? freeAfter : 30}`); return stopped ? freeAfter : 30; };
      A.t.cfg.memWaitMs = 600;
      A.t.cfg.memPollMs = 50;
      FAKE.BASE.needCommitGB = 45;
      // une porte qui ne s'ouvre jamais : le départ accepté reste en « attente », « Arrêter » le ramène au brouillon
      A.t.opts.gate = { hold: (o) => new Promise((res) => o.signal.addEventListener('abort', () => res(null), { once: true })), adopt: () => null };
      const ok = await A.invoke('train:start', draftId);
      const st0 = doc(A, draftId).state;
      if (ok.ok) await A.invoke('train:control', draftId, 'stop');
      delete A.t.opts.gate;
      check('mémoire insuffisante, ComfyUI de Mia arrêtable : il est arrêté, la mémoire remesurée, le départ accepté', ok.ok === true && st0 === 'attente' && calls.filter((c) => c === 'free').length === 1 && calls[calls.length - 1] === 'commit=50', { ok, calls });
      // ComfyUI arrêté, mais Windows ne rend pas assez : refus avec la raison, la mesure a été refaite
      calls.length = 0; stopped = false; freeAfter = 40;
      const no1 = await A.invoke('train:start', draftId);
      check('… ComfyUI arrêté mais mémoire toujours insuffisante : refus « Mémoire Windows insuffisante » avec le chiffre remesuré', no1.ok === false && no1.code === 'memory' && /40 Go disponibles, 45 nécessaires/.test(no1.error) && calls.includes('free') && doc(A, draftId).state === 'pret', { no1, calls });
      // le moteur n'arrête rien (ComfyUI pas lancé par Mia, ou occupé) : refus tout de suite, sans attendre
      A.t.ctx.engine = { freeMemoryForTraining: async () => { calls.push('free'); return { stopped: false }; } };
      calls.length = 0; stopped = false;
      const t0 = Date.now();
      const no2 = await A.invoke('train:start', draftId);
      check('… rien à arrêter (ComfyUI d’une autre session, ou qui calcule) : refus immédiat', no2.ok === false && no2.code === 'memory' && /30 Go disponibles/.test(no2.error) && calls.join() === 'commit=30,free' && Date.now() - t0 < 500, { no2, calls });
      A.t.ctx.engine = null;
      A.t.opts.commitGB = async () => WORLD.commitGB;
      A.t.cfg.memWaitMs = TIMING.memWaitMs;
      A.t.cfg.memPollMs = TIMING.memPollMs;
      FAKE.BASE.needCommitGB = 0;
      check('délais de la mémoire : 10 s au plus, une mesure par seconde', TIMING.memWaitMs === 10000 && TIMING.memPollMs === 1000);
    }

    // un brouillon n'a fait aucun pas : ni perte moyenne, ni tendance, ni dernière perte (pas « 0 »)
    {
      const st = A.t.status(A.t.item(draftId));
      check('brouillon sans aucun pas : loss.mean100, last, trend à null (jamais 0)', st.loss.mean100 === null && st.loss.last === null && st.loss.trend === null && st.loss.min === null, st.loss);
      const q = A.t.create({ name: 'Qwen sans mesure', base: 'qwen21', trigger: 'x' });
      const sq = A.t.status(A.t.item(q.id));
      check('modèle jamais mesuré (Qwen) : pace.sPerStep à null pour l’assistant, pas 0', sq.pace.sPerStep === null && sq.loss.mean100 === null, sq.pace);
      const g1 = await A.invoke('train:get', draftId);
      check('… et ce que lit l’assistant (train:get) dit la même chose', g1.loss.mean100 === null, g1.loss);
      await A.t.remove(q.id);
    }

    g = await A.invoke('train:get', draftId);
    check('tout est rempli : prêt, durée estimée', g.ready === true && g.why === null && g.estimate.seconds > 0 && g.estimate.measured === true, g.estimate);
    await A.invoke('train:update', draftId, { length: 'short' });
    check('durée « Court » = 1 500 pas ; pas modifiables', doc(A, draftId).steps === 1500 && (await A.invoke('train:update', draftId, { steps: 30 })).steps === 30);
    await A.invoke('train:update', draftId, { settings: { saveEvery: 10, sampleEvery: 15 } });
  }

  section('Modèles non prêts, MIA_NO_GPU=1');
  {
    const c = A.t.create({ name: 'Vrai', base: 'ltx25', trigger: 'x' });
    A.t.addImages(c.id, [SET10]);
    await A.t.importIdle(c.id);
    let g = A.t.get(c.id);
    check('LTX sans adaptateur ni venv du banc : « Outil d’entraînement introuvable : … »', g.ready === false && (fs.existsSync(path.join(MIA, 'python', 'train', 'mia_train_ltx.py')) || (g.whyCode === 'tool' && /^Outil d’entraînement introuvable : /.test(g.why))), g.why);
    const keep = LTX.detect;
    LTX.detect = () => ({ ok: true, version: '1.6.2', python: 'x', why: null });
    g = A.t.get(c.id);
    check('poids de base absents : listés avec leur taille', g.whyCode === 'weights' && /^Poids de base absents : ltx-2\.5-22b-dev-transformer-bf16\.safetensors \(39,1 Go\), gemma4/.test(g.why), g.why);
    const ob = A.t.options().bases.find((b) => b.id === 'ltx25');
    check('… et dans les options : 3 fichiers manquants', ob.ready === false && ob.missing.length === 3 && ob.missing[0].sizeGB === 39.1, ob.missing);
    for (const w of readJSON(path.join(MIA, 'src', 'catalog', 'train-bases.json')).bases[0].weights) {
      fs.mkdirSync(path.join(ENGINE, 'models', w.dir), { recursive: true });
      fs.writeFileSync(path.join(ENGINE, 'models', w.dir, w.file), 'faux poids du banc');
    }
    check('poids présents, outil détecté : LTX prêt', A.t.get(c.id).ready === true && A.t.options().bases.find((b) => b.id === 'ltx25').ready === true, A.t.get(c.id).why);
    process.env.MIA_NO_GPU = '1';
    g = A.t.get(c.id);
    const st = await A.t.start(c.id);
    check('MIA_NO_GPU=1 : un vrai outil est refusé', g.ready === false && g.whyCode === 'nogpu' && st.ok === false && st.code === 'nogpu' && /MIA_NO_GPU=1/.test(st.error) && doc(A, c.id).state === 'pret', st);
    check('MIA_NO_GPU=1 : le faux outil reste accepté', A.t.options().bases.find((b) => b.id === 'fake').ready === true && A.t.get(draftId).ready === true);
    delete process.env.MIA_NO_GPU;
    LTX.detect = keep;
    // sans moteur ni dossier d'outils : la raison le dit, sans chemin bancal
    const N = makeTrainer(path.join(WORK, 'ud-sans-moteur'), { toolsDir: '' });
    WORLD.prefs = { lang: 'fr', engineRoot: '' };
    const on = await N.invoke('train:options');
    WORLD.prefs = { lang: 'fr', engineRoot: ENGINE };
    check('aucun moteur configuré : LTX grisé avec la phrase du moteur, outils « introuvables » sans chemin inventé',
      on.bases.find((b) => b.id === 'ltx25').why.code === 'noEngine' && /^Aucun moteur n’est configuré/.test(on.bases.find((b) => b.id === 'ltx25').why.fr) && on.tools.ltx.ok === false && on.tools.ltx.why.path === '' && on.toolsDir === '', on.tools.ltx);
    // changer de modèle : « trop petite » se recompte (1 024 px pour LTX, 64 pour la base de test)
    const cs = A.t.create({ name: 'Seuils', base: 'fake', trigger: 'x' });
    const mid = path.join(WORK, 'jeu-moyen');
    fs.mkdirSync(mid, { recursive: true });
    for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(mid, 'm' + i + '.png'), pngOf(600, 900, i));
    A.t.addImages(cs.id, [mid]);
    await A.t.importIdle(cs.id);
    const small0 = doc(A, cs.id).dataset.small;
    A.t.update(cs.id, { base: 'ltx25' });
    check('changement de modèle : réglages du nouveau modèle, images « trop petites » recomptées', small0 === 0 && doc(A, cs.id).dataset.small === 3 && doc(A, cs.id).steps === 2500 && doc(A, cs.id).tool === 'ltx' && doc(A, cs.id).settings.sampleEvery === 500 && A.t.update(cs.id, { base: 'nimporte' }).code === 'unknownBase', doc(A, cs.id).dataset);
    await A.t.remove(cs.id);
    const r = await A.t.remove(c.id);
    check('brouillon mis à la corbeille', r.ok && !A.t.item(c.id) && trashed.some((p) => p === c.dir), r);
  }

  section('Brouillon vide laissé tel quel, dossier introuvable, dossier des entraînements inaccessible');
  {
    // « Nouveau LoRA » puis retour sans rien remplir : le brouillon vide ne reste pas dans la liste (supprimé pour de bon,
    // sans passer par la corbeille : il ne contient que ce que Mia vient d'écrire)
    const before = trashed.length;
    const e1 = await A.invoke('train:create', {});
    const r1 = await A.invoke('train:remove', e1.id, { ifEmpty: true });
    check('brouillon vide, jamais touché : retiré en quittant son écran, sans corbeille', r1.ok && r1.discarded === true && !A.t.item(e1.id) && !fs.existsSync(e1.dir) && trashed.length === before
      && !readJSON(path.join(UD, 'data', 'trainings.json')).items.some((x) => x.id === e1.id), r1);
    const e2 = await A.invoke('train:create', {});
    await A.invoke('train:update', e2.id, { kind: 'style' });
    const r2 = await A.invoke('train:remove', e2.id, { ifEmpty: true });
    check('… touché (un réglage changé) : gardé', r2.ok && r2.kept === true && !!A.t.item(e2.id) && fs.existsSync(e2.dir), r2);
    const e3 = await A.invoke('train:create', { name: 'Nommé' });
    const r3 = await A.invoke('train:remove', e3.id, { ifEmpty: true });
    const e4 = A.t.create({ by: 'Claude' });
    const r4 = await A.invoke('train:remove', e4.id, { ifEmpty: true });
    check('… nommé, ou préparé par un assistant : gardé', r3.kept === true && !!A.t.item(e3.id) && r4.kept === true && !!A.t.item(e4.id), [r3, r4]);
    // un dossier qui n'existe plus : dit à part, avec son chemin (pas « 1 fichier ignoré (format ou lecture) »)
    const gone = path.join(WORK, 'parti', 'Rosa');
    await A.invoke('train:addImages', e3.id, [gone]);
    await A.t.importIdle(e3.id);
    const sk = doc(A, e3.id).dataset.skipped;
    check('dossier introuvable : noté « missing » avec son chemin, pas « unreadable »', sk.length === 1 && sk[0].why === 'missing' && sk[0].path === gone && doc(A, e3.id).dataset.count === 0, sk);
    const r5 = await A.invoke('train:remove', e3.id, { ifEmpty: true });
    check('… un brouillon où un import a été tenté n’est pas « vide »', r5.kept === true, r5);
    for (const id of [e2.id, e3.id, e4.id]) await A.t.remove(id);

    // le dossier des entraînements n'est plus accessible (disque débranché, un fichier à sa place) : une phrase, pas ENOTDIR
    const UDX = path.join(WORK, 'ud-inaccessible');
    fs.mkdirSync(UDX, { recursive: true });
    fs.writeFileSync(path.join(UDX, 'training'), 'un fichier à la place du dossier');
    const X1 = makeTrainer(UDX);
    const c1 = await X1.invoke('train:create', { name: 'Rosa' });
    WORLD.prefs = { lang: 'en', engineRoot: ENGINE };
    const c2 = await X1.invoke('train:create', { name: 'Rosa' });
    WORLD.prefs = { lang: 'fr', engineRoot: ENGINE };
    check('dossier des entraînements inaccessible : « Le dossier des entraînements est inaccessible : … », en français et en anglais',
      c1.ok === false && c1.code === 'rootUnreachable' && c1.error === `Le dossier des entraînements est inaccessible : ${path.join(UDX, 'training')}` && !/ENOTDIR|ENOENT|EEXIST|mkdir/.test(c1.error)
      && c2.error === `The trainings folder cannot be reached: ${path.join(UDX, 'training')}` && X1.t.items.size === 0, [c1, c2]);
    X1.t.dispose();
  }

  section('Dupliquer en brouillon : mêmes réglages, même jeu, légendes copiées (jamais liées), original intact');
  {
    const src = await draft(A, 'Source', { msPerStep: 15 }, { steps: 777, saveEvery: 11, sampleEvery: 0 });
    A.t.setCaption(src, 'rosa_03.png', 'une légende propre à la source');
    const sdir = dirOf(A, src);
    const snap = () => JSON.stringify([readJSON(path.join(sdir, 'train.json')).settings, fs.readdirSync(path.join(sdir, 'dataset')).map((f) => `${f}:${fs.readFileSync(path.join(sdir, 'dataset', f)).length}`)]);
    const before = snap();
    const d1 = await A.invoke('train:create', { from: src });
    const dd = dirOf(A, d1.id);
    const caps = fs.readdirSync(path.join(dd, 'dataset')).filter((f) => f.endsWith('.txt'));
    check('dupliqué : brouillon prêt, 10 images, 10 légendes, mêmes réglages (777 pas, point tous les 11)', d1.ok && doc(A, d1.id).state === 'pret' && doc(A, d1.id).dataset.count === 10 && doc(A, d1.id).dataset.captions === 10
      && doc(A, d1.id).steps === 777 && doc(A, d1.id).settings.saveEvery === 11 && A.t.get(d1.id).ready === true, doc(A, d1.id).dataset);
    check('… chaque légende est une COPIE (un seul lien), les images sont liées', caps.length === 10 && caps.every((f) => fs.statSync(path.join(dd, 'dataset', f)).nlink === 1)
      && fs.statSync(path.join(dd, 'dataset', '0001.png')).ino === fs.statSync(path.join(sdir, 'dataset', '0001.png')).ino, caps.map((f) => fs.statSync(path.join(dd, 'dataset', f)).nlink));
    A.t.setCaption(d1.id, 'rosa_03.png', 'changée dans la copie');
    check('… changer une légende de la copie ne touche pas la source ; la source est intacte', fs.readFileSync(path.join(sdir, 'dataset', '0003.txt'), 'utf8') === 'une légende propre à la source' && snap() === before);
    // la source en cours d'entraînement : la duplication est permise (le jeu ne bouge pas pendant un entraînement)
    await A.t.start(src);
    await until(A, src, ['entrainement']);
    const d2 = await A.invoke('train:create', { from: src });
    check('duplication pendant que la source s’entraîne : permise, le jeu copié, la source continue', d2.ok && doc(A, d2.id).dataset.count === 10 && ['entrainement', 'essai', 'fini'].includes(doc(A, src).state), d2);
    if (doc(A, src).state !== 'fini') { await A.invoke('train:control', src, 'stopNow'); await until(A, src, ['annule']); }   // aucun LoRA rangé par ce cas
    const no = await A.invoke('train:create', { from: 't_inconnu' });
    check('duplication d’un entraînement inconnu : refusée', no.ok === false && no.code === 'unknown', no);
    // le modèle de la source n'est plus proposé ici : le jeu et ses légendes viennent quand même
    A.t.item(src).doc.base = 'modele-disparu';
    const d3 = await A.invoke('train:create', { from: src });
    A.t.item(src).doc.base = 'fake';
    check('modèle de la source plus proposé : le jeu et ses légendes sont copiés quand même (sur un autre modèle)', d3.ok && doc(A, d3.id).dataset.count === 10 && doc(A, d3.id).dataset.captions === 10 && doc(A, d3.id).base !== 'modele-disparu', doc(A, d3.id).dataset);
    for (const id of [d1.id, d2.id, d3.id, src]) await A.t.remove(id);
  }

  // ================================================================ 3. nominal
  section('Nominal : pret → attente → preparation → entrainement ↔ essai → fini');
  {
    A.sent.length = 0;
    const lockSeen = [];
    const spy = setInterval(() => { const l = lockNow(); if (l) lockSeen.push(l); }, 15);
    const st = await A.invoke('train:start', draftId);
    check('départ accepté', st.ok === true && st.state === 'attente', st);
    check('un seul entraînement à la fois', A.t.active().id === draftId);
    await until(A, draftId, ['fini']);
    clearInterval(spy);
    const d = doc(A, draftId);
    const dir = dirOf(A, draftId);
    const states = [];
    for (const s of A.sent) { const x = s.payload.summary && s.payload.summary.id === draftId ? s.payload.summary.state : null; if (x && states[states.length - 1] !== x) states.push(x); }
    check('états publiés dans l’ordre', states[0] === 'attente' && states[1] === 'preparation' && states.includes('entrainement') && states.includes('essai') && states[states.length - 1] === 'fini'
      && states.indexOf('entrainement') < states.indexOf('essai'), states);
    const disk = readJSON(path.join(dir, 'train.json'));
    check('fini : 30 pas, 2 essais, 3 points', d.state === 'fini' && d.step === 30 && d.samples.map((s) => s.step).join() === '15,30' && d.checkpoints.map((c) => c.step).join() === '10,20,30', d.checkpoints);
    check('train.json sur le disque = l’état en mémoire, chemins RELATIFS au dossier', disk.state === 'fini' && disk.checkpoints.every((c) => !path.isAbsolute(c.file) && c.file.startsWith('out/')) && disk.samples.every((s) => s.file.startsWith('out/samples/')), disk.checkpoints[0]);
    check('verrou GPU tenu pendant l’entraînement, sous le libellé attendu, 30 min au plus', lockSeen.length > 0 && lockSeen.every((l) => l.qui === 'Mia : Entraînement LoRA Rosa été (Faux modèle (test))' && l.app === 'Mia' && l.minutes >= 1 && l.minutes <= 30), lockSeen[0]);
    check('verrou rendu à la fin', lockNow() === null);
    const lora = path.join(UD, 'loras-mia', 'Rosa_ete_fake_00030.safetensors');
    check('LoRA rangé dans <userData>\\loras-mia (jamais dans le moteur), nom <Nom>_<suffixe>_<pas>', fs.existsSync(lora) && C.safetensorsComplete(lora) && !fs.existsSync(path.join(ENGINE, 'models', 'loras')), fs.existsSync(path.join(UD, 'loras-mia')) && fs.readdirSync(path.join(UD, 'loras-mia')));
    const card = readJSON(lora.replace(/\.safetensors$/, '.mia.json'));
    check('fiche .mia.json : nom, genre, déclencheur, force, conseil fr/en, entraînement', card.name === 'Rosa été' && card.kind === 'character' && card.trigger === 'rsa woman' && card.strength === 1
      && card.advice.fr === 'Entraîné dans Mia sur Faux modèle (test), 30 pas, 13 images. Mets « rsa woman » dans la consigne.'
      && card.advice.en === 'Trained in Mia on Fake model (test), 30 steps, 13 images. Put “rsa woman” in the prompt.'
      && card.training.id === draftId && card.training.base === 'fake' && card.training.steps === 30 && card.training.step === 30 && card.training.images === 13 && card.training.rank === 32 && /^\d{4}-\d\d-\d\d$/.test(card.training.date), card);
    {
      // the card's date is the day on this PC's clock, not the UTC one (0 h 30 in France = the day before in UTC)
      const justAfterMidnight = new Date(2026, 10, 19, 0, 30).getTime();
      const lateEvening = new Date(2026, 10, 18, 23, 50).getTime();
      const now = Date.now() + WORLD.clock;     // the service's clock (the benches can shift it)
      const today = [I.localDay(now - 60000), I.localDay(now)];
      check('fiche .mia.json : date du jour à l’heure du PC (pas celle de l’UTC)', I.localDay(justAfterMidnight) === '2026-11-19' && I.localDay(lateEvening) === '2026-11-18'
        && today.includes(card.training.date), { a: I.localDay(justAfterMidnight), b: I.localDay(lateEvening), card: card.training.date, today });
    }
    const g = await A.invoke('train:get', draftId);
    check('état complet : courbe de 30 points sans trou, perte, cadence, LoRA', g.curve.length === 30 && contiguous(g.curve.map((p) => p.s), 30) && g.loss.last > 0 && g.loss.mean100 > 0 && g.pace.sPerStep >= 0
      && g.lora && g.lora.file === lora && g.lora.comfyName === 'mia\\Rosa_ete_fake_00030.safetensors' && g.lora.trigger === 'rsa woman', g.lora);
    check('essais et points : chemins absolus à la lecture, consigne jointe', g.samples.length === 2 && g.samples.every((s) => path.isAbsolute(s.file) && fs.existsSync(s.file) && s.prompt === 'ma consigne') && g.checkpoints.every((c) => path.isAbsolute(c.file)), g.samples[0]);
    check('évènements de l’outil relus (phases, points, essais, fin) et 20 dernières lignes du journal', g.events.some((e) => e.e === 'done') && g.events.filter((e) => e.e === 'checkpoint').length === 3 && !g.events.some((e) => e.e === 'sample_step') && g.logTail.length > 0 && g.logTail[g.logTail.length - 1] === 'done');
    check('« FINI » non vu jusqu’à l’ouverture de l’écran', d.seen === false && (await A.invoke('train:seen', draftId)).ok && doc(A, draftId).seen === true && readJSON(path.join(dir, 'train.json')).seen === true);
    check('mesures apprises dans <data>\\train-timings.json', (() => { const t = readJSON(path.join(UD, 'data', 'train-timings.json')); return t.fake && t.fake.sPerStep > 0 && t.fake.checkpointMB > 0; })());
    const list = await A.invoke('train:list');
    check('liste : l’entraînement fini, sa taille sur le disque', list.length === 1 && list[0].id === draftId && list[0].state === 'fini' && list[0].sizeMB >= 0 && list[0].progress === 1, list);
    check('journal de l’outil : en-tête de lancement puis la sortie brute', /---- Mia : lancement 1,/.test(fs.readFileSync(path.join(dir, 'log.txt'), 'utf8')));
    check('un entraînement fini ne se relance pas et ne se modifie plus', (await A.invoke('train:start', draftId)).code === 'notDraft' && (await A.invoke('train:update', draftId, { name: 'X' })).code === 'notDraft' && (await A.invoke('train:addImages', draftId, [SET10])).code === 'notDraft');
    check('ouvrir le dossier', (await A.invoke('train:reveal', draftId)).ok && WORLD.opened === dir);
  }

  section('Mes LoRA : étape intermédiaire, jamais d’écrasement, retrait');
  {
    const dirL = path.join(UD, 'loras-mia');
    fs.writeFileSync(path.join(dirL, 'Rosa_ete_fake_00010.safetensors'), 'un fichier déjà là');
    const r = await A.invoke('train:addToLoras', draftId, 10);
    check('point intermédiaire rangé à côté, sans écraser le fichier présent (suffixe _2)', r.ok && path.basename(r.file) === 'Rosa_ete_fake_00010_2.safetensors' && r.comfyName === 'mia\\Rosa_ete_fake_00010_2.safetensors'
      && fs.readFileSync(path.join(dirL, 'Rosa_ete_fake_00010.safetensors'), 'utf8') === 'un fichier déjà là' && C.safetensorsComplete(r.file), r);
    const card = readJSON(r.file.replace(/\.safetensors$/, '.mia.json'));
    check('fiche d’étape : training.step < training.steps, conseil qui le dit', card.training.step === 10 && card.training.steps === 30 && /^Étape 10 d’un entraînement dans Mia/.test(card.advice.fr) && /^Step 10 of a training in Mia/.test(card.advice.en), card);
    const again = await A.invoke('train:addToLoras', draftId, 10);
    check('déjà « DANS MES LORA » : le même fichier, pas un troisième', again.ok && again.already === true && again.file === r.file && fs.readdirSync(dirL).filter((n) => /\.safetensors$/.test(n)).length === 3);
    check('pas inconnu → phrase lisible', (await A.invoke('train:addToLoras', draftId, 11)).code === 'noCheckpoint');
    const before = trashed.length;
    const rem = await A.invoke('train:removeFromLoras', draftId, 10);
    check('« Retirer de Mes LoRA » : fichier et fiche à la corbeille', rem.ok && trashed.length === before + 2 && !fs.existsSync(r.file) && !fs.existsSync(r.file.replace(/\.safetensors$/, '.mia.json')), trashed.slice(before));
    const ck = doc(A, draftId).checkpoints.find((c) => c.step === 10);
    check('… le point reste dans l’entraînement', ck.added === null && C.safetensorsComplete(path.join(dirOf(A, draftId), ck.file)));
    check('retirer deux fois → phrase lisible', (await A.invoke('train:removeFromLoras', draftId, 10)).code === 'notInLoras');
    check('gestes notés dans les évènements (qui, pas)', doc(A, draftId).notes.some((n) => n.act === 'add' && n.by === 'Mia' && n.text === '30') && doc(A, draftId).notes.some((n) => n.act === 'remove' && n.text === '10'));
  }

  section('Rangement final impossible : l’état suit, la veille est rendue, l’échec est dit, « Mettre dans Mes LoRA » réessaie');
  {
    const { createTrainShell } = require(path.join(MIA, 'electron', 'trainshell.js'));
    const UDF = path.join(WORK, 'ud-rangement');
    fs.mkdirSync(UDF, { recursive: true });
    const ends = [];
    const F = makeTrainer(UDF, { onEnd: (id, st) => ends.push(`${id}:${st}`) });
    // la veille de Windows, comme main.js la branche (trainshell) — avec un faux powerSaveBlocker
    const psb = { n: 0, on: new Set(), start() { const id = ++this.n; this.on.add(id); return id; }, stop(id) { this.on.delete(id); }, isStarted(id) { return this.on.has(id); } };
    const shell = createTrainShell({ trainer: F.t, getWin: () => null, powerSaveBlocker: psb, headless: true });
    F.t.onChange(() => shell.update());
    // (a) <userData>\loras-mia est un fichier : mkdir lève (comme un disque plein, un EPERM… pendant la copie)
    fs.writeFileSync(path.join(UDF, 'loras-mia'), 'un fichier à la place du dossier');
    const id = await draft(F, 'Rangement', { msPerStep: 10 }, { steps: 30, saveEvery: 10, sampleEvery: 0 });
    await F.t.start(id);
    await waitFor(() => doc(F, id).state === 'entrainement');
    const awakeDuring = psb.on.size;
    const fin = await until(F, id, ['fini', 'erreur'], 20000);
    await wait(150);
    const lastSent = F.sent.filter((s) => s.payload.summary && s.payload.summary.id === id).pop();
    const disk = readJSON(path.join(dirOf(F, id), 'train.json'));
    check('rangement qui lève une erreur : « fini » en mémoire, sur le disque ET dans le dernier train:event envoyé à la fenêtre',
      !!fin && doc(F, id).state === 'fini' && disk.state === 'fini' && lastSent && lastSent.payload.summary.state === 'fini', { mem: doc(F, id).state, disk: disk.state, sent: lastSent && lastSent.payload.summary.state });
    check('… la veille de Windows est rendue (tenue pendant l’entraînement), plus d’entraînement actif, fin signalée (onEnd)',
      awakeDuring === 1 && psb.on.size === 0 && F.t.brief() === null && ends.includes(`${id}:fini`), { awakeDuring, now: psb.on.size, ends });
    check('… l’échec est écrit dans train.json (filed), en français et en anglais, avec le dossier', disk.filed && disk.filed.ok === false && disk.filed.code === 'fileFailed'
      && disk.filed.message.fr.startsWith(`Écriture impossible dans ${path.join(UDF, 'loras-mia')} (`) && disk.filed.message.en.startsWith('Could not write in '), disk.filed);
    const g = await F.invoke('train:get', id);
    check('… la fenêtre le lit (filed) et aucun LoRA n’est annoncé', g.filed && g.filed.ok === false && g.lora === null && g.state === 'fini', { filed: g.filed, lora: g.lora });
    // réessai par « Mettre dans Mes LoRA » : le dossier est revenu
    fs.rmSync(path.join(UDF, 'loras-mia'));
    const again = await F.invoke('train:addToLoras', id, 30);
    const g2 = await F.invoke('train:get', id);
    check('« Mettre dans Mes LoRA » une fois le dossier revenu : rangé, l’échec effacé', again.ok && fs.existsSync(again.file) && g2.filed === null && g2.lora && g2.lora.step === 30 && readJSON(path.join(dirOf(F, id), 'train.json')).filed === null, { again, filed: g2.filed });
    // (b) le lien physique ET la copie échouent (autre volume, disque plein) : aucun « .part » laissé, raison rendue
    const id2 = await draft(F, 'Copie', { msPerStep: 10 }, { steps: 20, saveEvery: 10, sampleEvery: 0 });
    const keepLink = fs.linkSync;
    const keepCopy = fs.copyFileSync;
    fs.linkSync = (a, b) => { if (String(b).includes('loras-mia')) throw Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' }); return keepLink(a, b); };
    fs.copyFileSync = (a, b, m) => { if (String(b).includes('loras-mia')) { fs.writeFileSync(b, 'à moitié'); throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); } return keepCopy(a, b, m); };
    try {
      await F.t.start(id2);
      await until(F, id2, ['fini', 'erreur'], 20000);
    } finally {
      fs.linkSync = keepLink;
      fs.copyFileSync = keepCopy;
    }
    const left = fs.existsSync(path.join(UDF, 'loras-mia')) ? fs.readdirSync(path.join(UDF, 'loras-mia')).filter((f) => /Copie/.test(f)) : [];
    check('copie impossible (ENOSPC) : « fini », échec écrit avec la cause, aucun fichier « .part » ni LoRA à moitié laissé', doc(F, id2).state === 'fini' && doc(F, id2).filed && /ENOSPC/.test(doc(F, id2).filed.message.fr) && left.length === 0, { filed: doc(F, id2).filed, left });
    check('… un refus d’ajout manuel rend aussi la phrase (pas une exception)', (() => { fs.linkSync = () => { throw new Error('x'); }; fs.copyFileSync = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); }; try { const r = F.t.addToLoras(id2, 20); return r.ok === false && r.code === 'fileFailed' && /EPERM/.test(r.error); } finally { fs.linkSync = keepLink; fs.copyFileSync = keepCopy; } })());
    F.t.dispose();
  }

  // ================================================================ 4. GPU pris
  section('GPU pris par un autre verrou');
  {
    const id = await draft(A, 'Attente', {}, { steps: 20, sampleEvery: 0 });
    fs.writeFileSync(LOCK, JSON.stringify({ qui: 'Claude : essai LTX', minutes: 10, debut: Date.now() / 1000, depuis: '22:10', app: 'autre', pid: 1 }), 'utf8');
    await A.t.start(id);
    await waitFor(() => A.t.item(id).live && A.t.item(id).live.wait);
    const s = A.t.summary(A.t.item(id));
    check('attente avec qui et depuis', s.state === 'attente' && s.wait.who === 'Claude : essai LTX' && s.wait.since === '22:10', s.wait);
    await wait(300);
    check('rien n’est lancé tant que le GPU est pris', doc(A, id).state === 'attente' && !fs.existsSync(path.join(dirOf(A, id), 'events.jsonl')) && lockNow().qui === 'Claude : essai LTX');
    const other = await draft(A, 'Deuxième', {}, { steps: 20 });
    const no = await A.t.start(other);
    check('« Un autre entraînement est en cours » : un entraînement en attente est actif', no.ok === false && no.code === 'otherActive' && no.error === 'Un autre entraînement est en cours', no);
    const t0 = Date.now();
    fs.rmSync(LOCK);
    await until(A, id, ['preparation', 'entrainement']);
    check('départ tout seul après la libération', Date.now() - t0 < 8000 && lockNow() && /Entraînement LoRA Attente/.test(lockNow().qui) && lockNow().minutes <= 30, lockNow());
    await until(A, id, ['fini']);
    check('terminé, verrou rendu', doc(A, id).state === 'fini' && lockNow() === null);

    fs.writeFileSync(LOCK, JSON.stringify({ qui: 'Autre', minutes: 10, debut: Date.now() / 1000, depuis: '22:10', app: 'autre', pid: 1 }), 'utf8');
    await A.t.start(other);
    await waitFor(() => A.t.item(other).live && A.t.item(other).live.wait);
    const stop = await A.invoke('train:control', other, 'stop');
    check('« Arrêter » pendant l’attente : arrêt immédiat, retour au brouillon, le verrou de l’autre intact', stop.ok && doc(A, other).state === 'pret' && !A.t.item(other).live && lockNow().qui === 'Autre' && A.t.active() === null, stop);
    fs.rmSync(LOCK);
    await wait(250);
    check('… et rien ne part ensuite', doc(A, other).state === 'pret' && lockNow() === null && doc(A, other).run === 0);
    await A.t.remove(other);

    // deux « Lancer » rapprochés, avec le contrôle de mémoire Windows (asynchrone) comme pour LTX 2.5
    const d1 = await draft(A, 'Double un', {}, { steps: 20, sampleEvery: 0 });
    const d2 = await draft(A, 'Double deux', {}, { steps: 20, sampleEvery: 0 });
    FAKE.BASE.needCommitGB = 45;
    const [r1, r2] = await Promise.all([A.t.start(d1), A.t.start(d2)]);
    FAKE.BASE.needCommitGB = 0;
    check('deux départs simultanés : le second refusé « Un autre entraînement est en cours », resté prêt', r1.ok && r1.started && r2.ok === false && r2.code === 'otherActive' && doc(A, d2).state === 'pret' && !A.t.item(d2).live, { r1, r2 });
    check('… et le premier tient le GPU', A.t.holder === A.t.item(d1));
    await until(A, d1, ['fini']);
    check('… le premier va au bout, le second n’a jamais bougé', doc(A, d1).state === 'fini' && doc(A, d2).state === 'pret' && doc(A, d2).run === 0 && lockNow() === null);

    // la porte du moteur refuse (holdBusy) : un refus, retour au brouillon, pas une « erreur » d’outil
    A.t.opts.gate = { hold: async () => { throw Object.assign(new Error('Un entraînement tient déjà le GPU.'), { code: 'holdBusy' }); } };
    const r3 = await A.t.start(d2);
    await waitFor(() => !A.t.item(d2).live);
    delete A.t.opts.gate;
    check('porte du moteur occupée (holdBusy) : retour à « prêt », sans erreur', r3.ok && doc(A, d2).state === 'pret' && doc(A, d2).error === null && A.t.holder !== A.t.item(d2), { r3, st: doc(A, d2).state, err: doc(A, d2).error });
    await A.t.remove(d1);
    await A.t.remove(d2);
  }

  // ================================================================ 5. pause, reprise
  section('Pause en plein entraînement, puis reprise');
  let pausedId;
  {
    const id = await draft(A, 'Pause', { msPerStep: 15 }, { steps: 60, sampleEvery: 0 });
    pausedId = id;
    await A.t.start(id);
    await waitFor(() => doc(A, id).state === 'entrainement' && doc(A, id).step >= 13);
    const r = await A.invoke('train:control', id, 'pause');
    check('pause demandée', r.ok && r.pending === 'pause' && A.t.summary(A.t.item(id)).pending === 'pause', r);
    await until(A, id, ['pause']);
    const d = doc(A, id);
    const dir = dirOf(A, id);
    const at = d.step;
    check('pause : point de contrôle au pas courant, vérifié', d.state === 'pause' && d.pause.reason === 'user' && at >= 13 && at < 60
      && d.checkpoints[d.checkpoints.length - 1].step === at && C.ltxVerify(dir, C.ltxCheckpoints(dir).pop()), { at, ck: d.checkpoints.map((c) => c.step) });
    check('GPU rendu, l’entraînement n’est plus actif', lockNow() === null && A.t.active() === null && !A.t.item(id).live);
    const stEv = lines(path.join(dir, 'events.jsonl')).filter((e) => e.e === 'stopped').pop();
    check('l’outil dit que c’est une PAUSE (stopped why:"pause") : ÉVÈNEMENTS écrira « Pause au pas », pas « Arrêt »', !!stEv && stEv.why === 'pause' && stEv.saved === true && stEv.step === at, stEv);
    check('fichiers d’ordre retirés', !fs.existsSync(path.join(dir, 'control', 'pause')) && !fs.existsSync(path.join(dir, 'control', 'stop')));
    await wait(350);
    check('ne reprend pas seul', doc(A, id).state === 'pause' && doc(A, id).run === 1 && lockNow() === null);
    const other = await draft(A, 'Entre-temps', {}, { steps: 12, saveEvery: 6, sampleEvery: 0 });
    await A.t.start(other);
    check('pendant une pause manuelle, un autre entraînement peut partir', doc(A, other).state !== 'pret');
    const no = await A.t.start(id, { resume: true });
    check('… et « Reprendre » est alors refusé : « Un autre entraînement est en cours »', no.ok === false && no.code === 'otherActive', no);
    await until(A, other, ['fini']);
    const rs = await A.invoke('train:start', id, { resume: true });
    check('reprise acceptée, depuis le pas du point', rs.ok && rs.resumeFrom === at, rs);
    await until(A, id, ['fini']);
    const ev = lines(path.join(dir, 'events.jsonl'));
    const mt = lines(path.join(dir, 'metrics.jsonl'));
    check('lancement 2 : repart du pas suivant', doc(A, id).run === 2 && ev.some((e) => e.e === 'resumed' && e.step === at) && mt.find((m) => m.run === 2).s === at + 1, mt.find((m) => m.run === 2));
    check('courbe sans trou ni doublon de 1 à 60', contiguous(stepsOf(A, id), 60), stepsOf(A, id).length);
    check('fini, LoRA rangé', doc(A, id).state === 'fini' && fs.existsSync(path.join(UD, 'loras-mia', 'Pause_fake_00060.safetensors')));
    check('gestes notés : départ, pause, reprise', ['start', 'pause', 'resume'].every((a) => doc(A, id).notes.some((n) => n.act === a)));
  }

  // ================================================================ 6. laisser passer
  section('Laisser passer : pause, puis reprise automatique quand la file de Mia est vide');
  {
    const id = await draft(A, 'Passer', { msPerStep: 15 }, { steps: 90, sampleEvery: 0 });
    await A.t.start(id);
    await waitFor(() => doc(A, id).step >= 8);
    WORLD.queueIdle = false;                    // un calcul de Mia attend le GPU
    const r = await A.invoke('train:control', id, 'pass');
    await until(A, id, ['pause']);
    const at = doc(A, id).step;
    check('pause « laisser passer », verrou rendu au calcul qui attend', r.ok && doc(A, id).pause.reason === 'pass' && lockNow() === null, doc(A, id).pause);
    check('… l’entraînement reste ACTIF (aucun autre ne peut partir)', A.t.active() && A.t.active().id === id && A.t.blocker(A.t.item(pausedId)) !== null);
    await wait(300);
    check('tant que la file de Mia n’est pas vide, il attend', doc(A, id).state === 'pause' && doc(A, id).run === 1);
    WORLD.queueIdle = true;
    await waitFor(() => doc(A, id).run === 2);
    check('file vide : il repart seul, du point', doc(A, id).run === 2 && doc(A, id).resumedFrom === at && doc(A, id).notes.some((n) => n.act === 'resume' && n.by === 'Mia'), doc(A, id).resumedFrom);
    await waitFor(() => doc(A, id).state === 'entrainement' && doc(A, id).step >= at + 5);
    WORLD.queueIdle = false;
    await A.invoke('train:control', id, 'pass');
    await until(A, id, ['pause']);
    const at2 = doc(A, id).step;
    const now = await A.invoke('train:control', id, 'resumeNow');
    check('« Reprendre maintenant » : repart sans attendre la file', now.ok && now.resumeFrom === at2 && doc(A, id).run === 3, now);
    WORLD.queueIdle = true;
    await until(A, id, ['fini']);
    check('fini, courbe sans trou ni doublon après deux reprises', doc(A, id).state === 'fini' && contiguous(stepsOf(A, id), 90), stepsOf(A, id).length);
  }

  // ================================================================ 7. pendant un essai
  section('Pause et arrêt pendant un essai');
  {
    const id = await draft(A, 'Essai pause', { msPerStep: 8, sampleMs: 1500 }, { steps: 200, sampleEvery: 10, saveEvery: 20 });
    await A.t.start(id);
    await until(A, id, ['essai']);
    const g0 = A.t.get(id);
    const s1 = g0.step;                                          // le pas de l'essai en cours au moment du geste
    check('pendant l’essai : état « essai », étape du rendu connue', g0.state === 'essai' && g0.phase === 'sample' && (g0.sampleStep === null || g0.sampleStep.total === 5), g0.sampleStep);
    const t0 = Date.now();
    await A.invoke('train:control', id, 'pause');
    await wait(150);
    check('la pause attend la fin de l’essai', doc(A, id).state === 'essai' && A.t.summary(A.t.item(id)).pending === 'pause');
    await until(A, id, ['pause']);
    const d = doc(A, id);
    const lastS = d.samples[d.samples.length - 1];
    check('pause prise après l’essai : essai écrit, point au pas de l’essai', s1 % 10 === 0 && d.step === s1 && lastS.step === s1 && d.samples.length === s1 / 10 && fs.existsSync(path.join(dirOf(A, id), lastS.file)) && d.checkpoints.some((c) => c.step === s1) && Date.now() - t0 >= 150, { s1, step: d.step, samples: d.samples.map((x) => x.step) });
    check('durée d’un essai mesurée', d.measured.sampleSec > 1, d.measured);

    await A.t.start(id, { resume: true });
    await waitFor(() => doc(A, id).state === 'essai' && doc(A, id).step > s1);
    const s2 = doc(A, id).step;
    await A.invoke('train:control', id, 'stop');
    await wait(120);
    check('l’arrêt attend la fin de l’essai', doc(A, id).state === 'essai' && A.t.summary(A.t.item(id)).pending === 'stop');
    await until(A, id, ['annule']);
    check('arrêt pris après l’essai : « annule » au pas de l’essai, essai écrit', s2 % 10 === 0 && doc(A, id).state === 'annule' && doc(A, id).step === s2 && doc(A, id).samples.length === s2 / 10, { s2, step: doc(A, id).step });

    await A.t.start(id, { resume: true });
    await waitFor(() => doc(A, id).state === 'essai' && doc(A, id).step > s2);
    const pid = doc(A, id).proc.pid;
    const nSamples = doc(A, id).samples.length;
    const t1 = Date.now();
    await A.invoke('train:control', id, 'stopNow');
    await until(A, id, ['annule']);
    const lastCk3 = C.ltxCheckpoints(dirOf(A, id)).pop().step;
    check('« Arrêter sans attendre » : l’outil est tué sans attendre la fin de l’essai (ni le délai de 9 s du banc)', Date.now() - t1 < 4000 && !pidAlive(pid) && doc(A, id).state === 'annule' && doc(A, id).samples.length === nSamples, Date.now() - t1);
    check('… « annule » au dernier point vérifié, verrou rendu', doc(A, id).step === lastCk3 && lastCk3 >= s2 && lockNow() === null, { step: doc(A, id).step, lastCk3 });
    await A.t.remove(id);
  }

  // ================================================================ 8. arrêter
  section('Arrêter… : point au pas courant, reprise possible ; outil sourd → tué après le délai');
  {
    const id = await draft(A, 'Arrêt', { msPerStep: 15 }, { steps: 60, sampleEvery: 0 });
    await A.t.start(id);
    await waitFor(() => doc(A, id).step >= 14);
    await A.invoke('train:control', id, 'stop', { by: 'user' });
    await until(A, id, ['annule']);
    const at = doc(A, id).step;
    check('annule au pas courant, point écrit à ce pas, verrou rendu', doc(A, id).state === 'annule' && at >= 14 && doc(A, id).checkpoints.some((c) => c.step === at) && lockNow() === null && A.t.active() === null, at);
    check('reprise possible de ce pas', A.t.pickCheckpoint(A.t.item(id), { dryRun: true }) === at);
    const stEv = lines(path.join(dirOf(A, id), 'events.jsonl')).filter((e) => e.e === 'stopped').pop();
    check('l’outil dit que c’est un ARRÊT (stopped why:"stop")', !!stEv && stEv.why === 'stop' && stEv.step === at, stEv);
    const rs = await A.t.start(id, { resume: true });
    await until(A, id, ['fini']);
    check('reprise après arrêt : terminé, courbe complète', rs.ok && rs.resumeFrom === at && contiguous(stepsOf(A, id), 60));

    const id2 = await draft(A, 'Sourd', { msPerStep: 15, ignoreControl: true }, { steps: 2000, sampleEvery: 0 });
    await A.t.start(id2);
    await waitFor(() => doc(A, id2).step >= 24);
    const pid = doc(A, id2).proc.pid;
    const t0 = Date.now();
    await A.invoke('train:control', id2, 'stop');
    await wait(300);
    check('outil sourd : rien n’est tué avant le délai', pidAlive(pid) && doc(A, id2).state === 'entrainement');
    await until(A, id2, ['annule']);
    const lastCk = C.ltxCheckpoints(dirOf(A, id2)).pop().step;
    check('après le délai : arbre tué, « annule » au dernier point écrit', Date.now() - t0 >= 1400 && !pidAlive(pid) && doc(A, id2).state === 'annule' && doc(A, id2).step === lastCk && lastCk >= 20 && lastCk % 10 === 0 && lockNow() === null, { ms: Date.now() - t0, step: doc(A, id2).step, lastCk });
    const st = await A.invoke('train:control', id2, 'pause');
    check('pause sur un entraînement arrêté : phrase lisible', st.ok === false && st.code === 'notRunning', st);
    const nNotes = doc(A, draftId).notes.length;
    check('« Arrêter » un entraînement fini : refusé, rien de noté', (await A.invoke('train:control', draftId, 'stop')).code === 'notRunning' && doc(A, draftId).state === 'fini' && doc(A, draftId).notes.length === nNotes);
    check('action inconnue (un assistant ne peut ni reprendre ni supprimer par « control ») : refusée', (await A.invoke('train:control', id2, 'resume')).code === 'badAction' && (await A.invoke('train:control', id2, 'delete')).code === 'badAction');
    await A.t.remove(id2);
  }

  // ================================================================ 9. erreurs
  section('Échecs de l’outil : mémoire GPU, mémoire Windows, disque, fichier absent, outil');
  {
    const cases = [
      ['oom', 'Mémoire GPU pleine.', 'GPU memory full.'],
      ['ram', 'Mémoire Windows insuffisante pendant le chargement.', 'Not enough Windows memory while loading.'],
      ['disk', 'Disque plein.', 'Disk full.'],
      ['missing', 'Le fichier de poids absent.safetensors est introuvable.', 'Weights file absent.safetensors not found.'],
      ['tool', 'L’outil s’est arrêté (code 1) : faux outil : échec demandé au pas 7', 'The tool stopped (code 1): faux outil : échec demandé au pas 7'],
      // le champ « why » des adaptateurs : une phrase propre dans les deux langues, pas le message français de l'outil
      ['takeover', 'L’outil n’a pas pris le pilotage de Mia.', 'The tool did not take Mia’s control.'],
      ['version', 'Version de l’outil LTX non reconnue (attendue : ltx-trainer 1.6.2).', 'Unrecognised LTX tool version (expected: ltx-trainer 1.6.2).']
    ];
    for (const [code, fr, en] of cases) {
      const id = await draft(A, `Echec ${code}`, { msPerStep: 5, failAt: 7, failCode: code }, { steps: 20, saveEvery: 5, sampleEvery: 0 });
      await A.t.start(id);
      await until(A, id, ['erreur']);
      const d = doc(A, id);
      check(`${code} : « ${fr} »`, d.state === 'erreur' && d.error.code === code && d.error.message.fr === fr && d.error.message.en === en && d.error.logTail.length > 0, d.error);
      if (code === 'ram') check('ram : l’erreur vient de CE lancement (journal lu depuis son en-tête)', d.error.logTail.every((l) => !/^---- Mia :/.test(l)) && d.error.logTail.some((l) => /WinError 1455/.test(l)), d.error.logTail);
      check(`${code} : non vu, verrou rendu, reprise proposée depuis le point 5`, d.seen === false && lockNow() === null && A.t.pickCheckpoint(A.t.item(id), { dryRun: true }) === 5 && d.step === 6, d.step);
      if (code !== 'oom') await A.t.remove(id);
      else {
        const rs = await A.t.start(id, { resume: true });
        await until(A, id, ['fini']);
        check('reprise après une erreur : repart du point 5, sans l’échec, et termine', rs.ok && rs.resumeFrom === 5 && doc(A, id).state === 'fini' && doc(A, id).error === null && contiguous(stepsOf(A, id), 20), rs);
        await A.t.remove(id);
      }
    }
    const id0 = await draft(A, 'Echec chargement', { failAt: 0, failCode: 'ram', loadMs: 60 }, { steps: 20 });
    await A.t.start(id0);
    await until(A, id0, ['erreur']);
    check('échec pendant le chargement : erreur « ram », aucun point, pas 0', doc(A, id0).error.code === 'ram' && doc(A, id0).step === 0 && A.t.pickCheckpoint(A.t.item(id0), { dryRun: true }) === 0, doc(A, id0).error);
    const again = await A.t.start(id0, { resume: true });
    check('sans point de contrôle, « reprendre » relance depuis le début', again.ok && again.resumeFrom === 0, again);
    await until(A, id0, ['fini']);
    check('… et termine (l’échec ne valait que pour le premier lancement)', doc(A, id0).state === 'fini' && doc(A, id0).run === 2 && contiguous(stepsOf(A, id0), 20));
    await A.t.remove(id0);

    const keep = FAKE.command;
    FAKE.command = (o) => ({ ...keep(o), exe: path.join(WORK, 'nexiste-pas.exe') });
    const idx = await draft(A, 'Introuvable', {}, { steps: 10 });
    await A.t.start(idx);
    await until(A, idx, ['erreur']);
    FAKE.command = keep;
    check('outil impossible à lancer : erreur lisible, verrou rendu', doc(A, idx).error.code === 'tool' && /^Impossible de lancer l’outil : /.test(doc(A, idx).error.message.fr) && lockNow() === null, doc(A, idx).error);
    await A.t.remove(idx);
  }

  section('Plantage (crashAt), reprise, point tronqué, reprise refusée');
  {
    const id = await draft(A, 'Plantage', { msPerStep: 5, crashAt: 27 }, { steps: 40, sampleEvery: 0 });
    await A.t.start(id);
    await until(A, id, ['erreur']);
    const dir = dirOf(A, id);
    const d = doc(A, id);
    check('plantage : erreur avec la dernière ligne utile du journal', d.error.code === 'tool' && d.error.message.fr === 'L’outil s’est arrêté (code 7) : RuntimeError: plantage simulé au pas 27', d.error.message);
    check('restes d’un enregistrement interrompu (.tmp_step_*) nettoyés', !fs.readdirSync(path.join(dir, 'out', 'checkpoints')).some((n) => n.startsWith('.tmp_')), fs.readdirSync(path.join(dir, 'out', 'checkpoints')));
    check('pas 26 atteint, reprise proposée depuis 20', d.step === 26 && A.t.pickCheckpoint(A.t.item(id), { dryRun: true }) === 20);
    await A.t.start(id, { resume: true });
    await until(A, id, ['fini']);
    const mt = lines(path.join(dir, 'metrics.jsonl'));
    check('le fichier garde les pas 21 à 26 des deux lancements…', mt.filter((m) => m.s === 23).length === 2 && mt.filter((m) => m.s === 23).map((m) => m.run).join() === '1,2');
    check('… la courbe n’en montre qu’un : ceux du lancement abandonné sont oubliés', contiguous(stepsOf(A, id), 40) && A.t.curve(A.t.item(id)).filter((m) => m.s > 20).every((m) => m.run === 2));
    await A.t.remove(id);

    const id2 = await draft(A, 'Tronqué', { msPerStep: 5, truncateAt: 20, crashAt: 25 }, { steps: 40, sampleEvery: 0 });
    await A.t.start(id2);
    await until(A, id2, ['erreur']);
    const dir2 = dirOf(A, id2);
    check('le point du pas 20 est tronqué sur le disque', !C.safetensorsComplete(path.join(dir2, 'out', 'checkpoints', 'step_00020', 'weights.safetensors')) && doc(A, id2).checkpoints.some((c) => c.step === 20));
    check('il ne peut pas aller dans Mes LoRA', (await A.invoke('train:addToLoras', id2, 20)).code === 'badCheckpoint');
    const rs = await A.t.start(id2, { resume: true });
    check('reprise : le point tronqué est refusé, reprise du précédent (10)', rs.ok && rs.resumeFrom === 10, rs);
    check('… et mis de côté dans out\\ecartes', fs.existsSync(path.join(dir2, 'out', 'ecartes', 'run1_step_00020', 'weights.safetensors')) && doc(A, id2).resumedFrom === 10 && !doc(A, id2).checkpoints.some((c) => c.step === 20 && /ecartes/.test(c.file) === false && !fs.existsSync(path.join(dir2, c.file))),
      fs.existsSync(path.join(dir2, 'out', 'ecartes')) && fs.readdirSync(path.join(dir2, 'out', 'ecartes')));
    await until(A, id2, ['fini']);
    check('terminé : le pas 20 a été refait, complet cette fois', doc(A, id2).state === 'fini' && C.safetensorsComplete(path.join(dir2, 'out', 'checkpoints', 'step_00020', 'weights.safetensors')) && contiguous(stepsOf(A, id2), 40));
    // un service neuf relit tout le fichier d'évènements : ce qui a été mis de côté ne revient pas dans la liste
    const R = makeTrainer(UD);
    const gr = R.t.get(id2);
    check('relecture après redémarrage : même état, points sans fantôme ni doublon, fichiers présents', gr.state === 'fini' && gr.checkpoints.map((c) => c.step).join() === doc(A, id2).checkpoints.map((c) => c.step).join()
      && gr.checkpoints.every((c) => fs.existsSync(c.file)) && new Set(gr.checkpoints.map((c) => c.step)).size === gr.checkpoints.length && gr.curve.length === 40 && gr.samples.length === 0, gr.checkpoints.map((c) => c.step));
    R.t.dispose();
    await A.t.remove(id2);

    const id3 = await draft(A, 'Refus', { msPerStep: 15, refuseResume: true }, { steps: 80, sampleEvery: 0 });
    await A.t.start(id3);
    await waitFor(() => doc(A, id3).step >= 13);
    await A.t.control(id3, 'pause');
    await until(A, id3, ['pause']);
    const dir3 = dirOf(A, id3);
    const snap = () => C.ltxCheckpoints(dir3).map((c) => `${c.step}:${c.at}:${fs.statSync(path.join(dir3, c.file)).size}`).join('|') + '#' + fs.statSync(path.join(dir3, 'metrics.jsonl')).size;
    const before = snap();
    await A.t.start(id3, { resume: true });
    await until(A, id3, ['erreur']);
    check('l’outil repart de zéro au lieu de reprendre : erreur « resume »', doc(A, id3).error.code === 'resume' && doc(A, id3).error.message.fr === 'La reprise a été refusée par l’outil : rien n’a été écrasé.' && doc(A, id3).error.message.en === 'The tool refused to resume: nothing was overwritten.', doc(A, id3).error);
    check('… aucun fichier écrasé (points et mesures identiques)', snap() === before);
    await A.t.remove(id3);
  }

  // ================================================================ 10. outil figé, saut d'horloge
  section('Outil figé : d’abord « SANS NOUVELLE », puis abandon ; saut d’horloge');
  {
    Object.assign(A.t.cfg, { warnMinMs: 1200, killMinMs: 3200 });
    const id = await draft(A, 'Figé', { msPerStep: 10, hangAt: 15 }, { steps: 60, sampleEvery: 0 });
    await A.t.start(id);
    await waitFor(() => A.t.item(id).live && A.t.item(id).live.warn);
    const pid = doc(A, id).proc.pid;
    const g = A.t.get(id);
    check('« SANS NOUVELLE » : signalé, rien n’est tué', g.silent === true && g.state === 'entrainement' && g.step === 14 && pidAlive(pid) && g.lastNewsS >= 1 && g.silentKillS === 3, { silent: g.silent, step: g.step });
    check('… le verrou est toujours tenu', lockNow() && /Figé/.test(lockNow().qui));
    await until(A, id, ['erreur']);
    const d = doc(A, id);
    check('au seuil d’abandon : outil tué, verrou rendu', !pidAlive(pid) && lockNow() === null && d.state === 'erreur' && d.error.code === 'hang', d.error);
    check('phrase : « L’outil ne répondait plus depuis … min : arrêté au pas 14. »', d.error.message.fr === 'L’outil ne répondait plus depuis 1 min : arrêté au pas 14.' && d.error.message.en === 'The tool had stopped responding for 1 min: stopped at step 14.', d.error.message);
    check('reprise proposée depuis le dernier point (10)', A.t.pickCheckpoint(A.t.item(id), { dryRun: true }) === 10);
    await A.t.remove(id);

    const id2 = await draft(A, 'Figé arrêté', { msPerStep: 10, hangAt: 15 }, { steps: 60, sampleEvery: 0 });
    await A.t.start(id2);
    await waitFor(() => A.t.item(id2).live && A.t.item(id2).live.warn);
    const pid2 = doc(A, id2).proc.pid;
    A.t.cfg.stopMs = 20000;                                      // s'il attendait le délai, le contrôle le verrait
    const t0 = Date.now();
    await A.t.control(id2, 'stop');
    await until(A, id2, ['annule']);
    A.t.cfg.stopMs = FAST.stopMs;
    check('« Arrêter » un outil muet : arrêt immédiat, sans attendre le délai ni l’abandon', Date.now() - t0 < 1900 && !pidAlive(pid2) && doc(A, id2).state === 'annule' && doc(A, id2).step === 10, Date.now() - t0);
    await A.t.remove(id2);

    // la fenêtre qui lit l'état entre deux relevés ne doit pas faire croire à un silence
    const idw = await draft(A, 'Regardé', { msPerStep: 12 }, { steps: 180, sampleEvery: 0 });
    await A.t.start(idw);
    let warned = false;
    const peek = setInterval(() => { const g2 = A.t.get(idw); if (g2.silent) warned = true; }, 4);
    await until(A, idw, ['fini', 'erreur']);
    clearInterval(peek);
    check('lecture continue de l’état par la fenêtre : jamais « sans nouvelle », l’entraînement finit', warned === false && doc(A, idw).state === 'fini' && contiguous(stepsOf(A, idw), 180), doc(A, idw).error);
    await A.t.remove(idw);

    // l'horloge saute de deux heures (sortie de veille) : sans la règle, le seuil d'abandon serait dépassé d'un coup
    const id3 = await draft(A, 'Veille', { msPerStep: 12 }, { steps: 300, saveEvery: 50, sampleEvery: 0 });
    await A.t.start(id3);
    await waitFor(() => doc(A, id3).step >= 10);
    WORLD.clock += 2 * 3600 * 1000;
    await wait(400);
    const it = A.t.item(id3);
    check('saut d’horloge : ni « sans nouvelle », ni abandon, ni pause', it.live && it.live.warn === false && !it.live.killedFor && !it.live.want && doc(A, id3).state === 'entrainement' && allLogs.some((l) => /clock jump/.test(l)), doc(A, id3).state);
    await until(A, id3, ['fini']);
    check('… et l’entraînement va au bout', doc(A, id3).state === 'fini' && contiguous(stepsOf(A, id3), 300));
    WORLD.clock = 0;
    Object.assign(A.t.cfg, { warnMinMs: FAST.warnMinMs, killMinMs: FAST.killMinMs });
    await A.t.remove(id3);
    check('seuils réels : avertissement à max(10 min, 20 × cadence), abandon à max(45 min, 100 × cadence), 30 min pour un essai ou le chargement',
      TIMING.warnMinMs === 600000 && TIMING.warnPaces === 20 && TIMING.killMinMs === 2700000 && TIMING.killPaces === 100 && TIMING.sampleKillMs === 1800000 && TIMING.loadKillMs === 1800000 && TIMING.aliveMs === 20000 && TIMING.tickMs === 1000 && TIMING.stopMs === 120000 && TIMING.stopSampleMs === 360000 && TIMING.quitMs === 60000 && TIMING.lockMaxMin === 30 && TIMING.renewMs === 300000 && TIMING.retryMs === 15000);
    check('« Arrêter » avec ai-toolkit : 120 s pour le point + 30 s pour que l’outil parte (l’adaptateur le tue lui-même à 150 s)',
      TIMING.stopExitMs && TIMING.stopExitMs.aitk === 30000 && !TIMING.stopExitMs.ltx && !TIMING.stopExitMs.fake, TIMING.stopExitMs);
  }

  // ================================================================ 11. disque presque plein
  section('Disque presque plein en cours : pause automatique avant le point suivant');
  {
    const id = await draft(A, 'Disque', { msPerStep: 150 }, { steps: 40, sampleEvery: 0 });
    // la place tombe dès que le premier point est écrit : moins de deux points (≈ 1 Ko chacun)
    WORLD.freeFn = () => (doc(A, id).checkpoints.length >= 1 ? 1500 : 500 * 1024 ** 3);
    await A.t.start(id);
    await until(A, id, ['pause']);
    const d = doc(A, id);
    WORLD.freeFn = null;
    WORLD.free = 1500;
    check('pause « disk » posée par Mia après le point 10, avant le point 20', d.pause.reason === 'disk' && d.step > 10 && d.step < 20 && d.notes.some((n) => n.act === 'pause' && n.by === 'Mia'), { step: d.step, pause: d.pause });
    const no = await A.t.start(id, { resume: true });
    check('la reprise revérifie la place : refusée tant que le disque est plein', no.ok === false && no.code === 'disk' && doc(A, id).state === 'pause', no);
    WORLD.free = 500 * 1024 ** 3;
    await A.t.start(id, { resume: true });
    await until(A, id, ['fini']);
    check('place libérée : reprise, terminé', doc(A, id).state === 'fini' && contiguous(stepsOf(A, id), 40));
    await A.t.remove(id);
  }

  // ================================================================ 12. redémarrage de Mia
  section('Mia tuée puis relancée : reprise en main, ou « interrompu »');
  {
    const UD2 = path.join(WORK, 'ud-redemarrage');
    // veille de l'outil raccourcie, mais assez large pour qu'un ralentissement du banc (antivirus, disque) ne la déclenche pas
    const fakeAlive = { heartbeatMs: 150, aliveCheckMs: 100, aliveStaleMs: 1800, aliveRecheckMs: 300, aliveForceMs: 8000 };
    // (a) relancée tout de suite : l'outil tourne encore, même jeton → reprise en main
    const B1 = makeTrainer(UD2);
    const id = await draft(B1, 'Survivant', { msPerStep: 25, ...fakeAlive }, { steps: 90, sampleEvery: 0 });
    await B1.t.start(id);
    await waitFor(() => doc(B1, id).step >= 10);
    const pid = doc(B1, id).proc.pid;
    const lockBefore = lockNow();
    crash(B1);                                                   // « Mia tuée » : plus personne ne relève ni n'écrit alive
    const B2 = makeTrainer(UD2);
    const it2 = B2.t.item(id);
    check('relancée en moins de 60 s : l’outil est repris en main (même jeton), état « entrainement »', it2 && it2.live && it2.live.pid === pid && it2.doc.state === 'entrainement' && it2.doc.step >= 10 && pidAlive(pid), it2 && { state: it2.doc.state, live: !!it2.live, pid: it2.live && it2.live.pid, want: pid, step: it2.doc.step, alive: pidAlive(pid), logs: allLogs.slice(-4) });
    check('… le verrou est repris sous le même libellé, avant tout nettoyage', lockNow() && lockNow().qui === lockBefore.qui && lockNow().debut >= lockBefore.debut, lockNow());
    check('… et alive est réécrit aussitôt', Date.now() - fs.statSync(path.join(dirOf(B2, id), 'control', 'alive')).mtimeMs < 1000);
    await until(B2, id, ['fini']);
    check('le second service suit l’entraînement jusqu’au bout : fini, LoRA rangé, verrou rendu', doc(B2, id).state === 'fini' && contiguous(stepsOf(B2, id), 90) && fs.existsSync(path.join(UD2, 'loras-mia', 'Survivant_fake_00090.safetensors')) && lockNow() === null);
    B2.t.dispose();

    // (b) jeton différent (le pid a pu être réutilisé par Windows) → interrompu, rien ne repart seul ; l'outil s'arrête de lui-même
    const B3 = makeTrainer(UD2);
    const idb = await draft(B3, 'Orphelin', { msPerStep: 25, ...fakeAlive }, { steps: 400, sampleEvery: 0 });
    await B3.t.start(idb);
    await waitFor(() => doc(B3, idb).step >= 12);
    const pidb = doc(B3, idb).proc.pid;
    const dirb = dirOf(B3, idb);
    crash(B3);
    const tj = readJSON(path.join(dirb, 'train.json'));
    tj.proc.token = 'un-autre-jeton';
    fs.writeFileSync(path.join(dirb, 'train.json'), JSON.stringify(tj));
    fs.rmSync(LOCK, { force: true });                            // le verrou de la « Mia morte » (ici le même processus : retiré à la main)
    const B4 = makeTrainer(UD2);
    const d4 = doc(B4, idb);
    check('jeton différent : « interrompu » au dernier pas écrit, rien n’est repris en main', d4.state === 'interrompu' && d4.step >= 12 && !B4.t.item(idb).live && d4.proc === null && d4.seen === false, d4.state);
    check('… aucun verrou pris, rien ne repart seul', lockNow() === null && d4.run === 1);
    const stopped = await waitFor(() => lines(path.join(dirb, 'events.jsonl')).find((e) => e.e === 'stopped'), 12000);
    await waitFor(() => !pidAlive(pidb), 4000);
    check('l’outil orphelin s’arrête seul : alive trop vieux, point écrit, sortie propre (aucun tuyau vers Mia)', !!stopped && stopped.saved === true && !pidAlive(pidb)
      && /stopped at step/.test(fs.readFileSync(path.join(dirb, 'log.txt'), 'utf8')), stopped);
    check('… reprise proposée depuis ce point', B4.t.pickCheckpoint(B4.t.item(idb), { dryRun: true }) === stopped.step);
    const rs = await B4.t.start(idb, { resume: true });
    await waitFor(() => doc(B4, idb).step >= stopped.step + 5);
    check('reprise à la main : repart du point écrit par l’outil', rs.ok && rs.resumeFrom === stopped.step && doc(B4, idb).run === 2);

    // (c) relancée après la mort de l'outil → interrompu
    const pidc = doc(B4, idb).proc.pid;
    crash(B4);
    spawnSync('taskkill', ['/PID', String(pidc), '/T', '/F'], { windowsHide: true });
    await waitFor(() => !pidAlive(pidc), 4000);
    fs.rmSync(LOCK, { force: true });
    const B5 = makeTrainer(UD2);
    check('relancée après la mort de l’outil : « interrompu », restes nettoyés', doc(B5, idb).state === 'interrompu' && doc(B5, idb).step >= stopped.step + 5 && !B5.t.item(idb).live, doc(B5, idb).state);

    // (d) « laisser passer » et « attente » retrouvés au démarrage
    const idd = await draft(B5, 'Passe', { msPerStep: 20 }, { steps: 200, sampleEvery: 0 });
    WORLD.queueIdle = false;
    await B5.t.start(idd);
    await waitFor(() => doc(B5, idd).step >= 5);
    await B5.t.control(idd, 'pass');
    await until(B5, idd, ['pause']);
    const ide = await draft(B5, 'File', {}, { steps: 20 });
    fs.writeFileSync(LOCK, JSON.stringify({ qui: 'Autre', minutes: 10, debut: Date.now() / 1000, depuis: '10:00', app: 'autre', pid: 1 }), 'utf8');
    check('(pendant un « laisser passer », rien d’autre ne part)', (await B5.t.start(ide)).code === 'otherActive');
    B5.t.dispose();
    WORLD.queueIdle = true;
    const B6 = makeTrainer(UD2);
    check('« laisser passer » retrouvé au démarrage : devient une pause manuelle', doc(B6, idd).state === 'pause' && doc(B6, idd).pause.reason === 'user' && B6.t.active() === null);
    await wait(250);
    check('… rien ne repart seul', doc(B6, idd).state === 'pause' && doc(B6, idd).run === 1);
    await B6.t.start(ide);
    await waitFor(() => B6.t.item(ide).live && B6.t.item(ide).live.wait);
    B6.t.save(B6.t.item(ide));
    B6.t.item(ide).live.abort.abort();
    B6.t.dispose();
    const B7 = makeTrainer(UD2);
    check('en attente du GPU au moment du plantage, jamais lancé : redevient un brouillon', doc(B7, ide).state === 'pret' && lockNow().qui === 'Autre');
    fs.rmSync(LOCK, { force: true });
    B7.t.dispose();
  }

  section('Plantage RÉEL de Mia (son processus tué) : l’outil survit et est repris en main ; fin pendant l’absence de Mia');
  {
    // (e) un vrai processus parent, tué seul (taskkill /PID sans /T) : sous Windows, un enfant lancé sans « detached »
    // est dans le job de son parent et meurt avec lui — l'outil doit survivre pour que sa veille et la reprise jouent
    const UDK = path.join(WORK, 'ud-plantage-reel');
    fs.mkdirSync(UDK, { recursive: true });
    const info = path.join(WORK, 'parent-info.json');
    const plog = fs.openSync(path.join(WORK, 'parent.log'), 'a');
    const parent = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'train', 'train-parent.js'), '--mia', MIA, '--ud', UDK, '--lock', LOCK, '--set', SET10, '--out', info,
      '--steps', '300', '--at', '12', '--fake', JSON.stringify({ msPerStep: 25, heartbeatMs: 150, aliveCheckMs: 100, aliveStaleMs: 8000, aliveRecheckMs: 300, aliveForceMs: 20000 })],
    { stdio: ['ignore', plog, plog], windowsHide: true });
    fs.closeSync(plog);
    const got = await waitFor(() => (fs.existsSync(info) ? readJSON(info) : null), 30000);
    check('le « Mia » de test (un processus à part) entraîne avec le faux outil', got && !got.error && got.pid === parent.pid && pidAlive(got.toolPid), got);
    if (got && !got.error) {
      spawnSync('taskkill', ['/PID', String(parent.pid), '/F'], { windowsHide: true });   // le processus de Mia seul, pas son arbre
      await waitFor(() => !pidAlive(parent.pid), 5000);
      await wait(1500);
      check('Mia tuée (processus seul) : l’outil est TOUJOURS en vie 1,5 s après (il n’est pas dans le job de Mia)', !pidAlive(parent.pid) && pidAlive(got.toolPid), { parent: pidAlive(parent.pid), tool: pidAlive(got.toolPid) });
      const K = makeTrainer(UDK);
      const itK = K.t.item(got.id);
      check('Mia relancée : l’outil survivant est repris en main (même pid, état « entrainement »), sans perdre de pas', itK && itK.live && itK.live.pid === got.toolPid && itK.doc.state === 'entrainement' && itK.doc.step >= got.step, itK && { state: itK.doc.state, live: !!itK.live, step: itK.doc.step });
      await until(K, got.id, ['fini'], 30000);
      check('… et suivi jusqu’au bout : fini, courbe complète, LoRA rangé, verrou rendu', doc(K, got.id).state === 'fini' && contiguous(stepsOf(K, got.id), 300) && fs.existsSync(path.join(UDK, 'loras-mia', 'Plantage_reel_fake_00300.safetensors')) && lockNow() === null, doc(K, got.id).state);
      K.t.dispose();
    } else if (pidAlive(parent.pid)) spawnSync('taskkill', ['/PID', String(parent.pid), '/T', '/F'], { windowsHide: true });

    // (f) l'outil va au bout pendant que Mia n'est pas là (plantée, puis relancée après) : « fini », LoRA rangé
    const UD3 = path.join(WORK, 'ud-fin-absente');
    const fakeAlive = { heartbeatMs: 150, aliveCheckMs: 100, aliveStaleMs: 8000, aliveRecheckMs: 300, aliveForceMs: 20000 };
    const C1 = makeTrainer(UD3);
    const idf = await draft(C1, 'Fin absente', { msPerStep: 15, ...fakeAlive }, { steps: 60, saveEvery: 20, sampleEvery: 0 });
    await C1.t.start(idf);
    await waitFor(() => doc(C1, idf).step >= 10);
    crash(C1);
    const dirf = dirOf(C1, idf);
    const pidf = doc(C1, idf).proc.pid;
    await waitFor(() => lines(path.join(dirf, 'events.jsonl')).some((e) => e.e === 'done'), 15000);
    await waitFor(() => !pidAlive(pidf), 4000);
    fs.rmSync(LOCK, { force: true });                                // le verrou de la « Mia morte » (même processus ici)
    const C2 = makeTrainer(UD3);
    const df = doc(C2, idf);
    check('fini pendant l’absence de Mia : au redémarrage « fini » au pas 60 (pas « interrompu »), non vu', df.state === 'fini' && df.step === 60 && df.seen === false && !C2.t.item(idf).live && df.proc === null, { state: df.state, step: df.step });
    check('… le LoRA est rangé avec sa fiche, les mesures apprises', fs.existsSync(path.join(UD3, 'loras-mia', 'Fin_absente_fake_00060.safetensors')) && fs.existsSync(path.join(UD3, 'loras-mia', 'Fin_absente_fake_00060.mia.json')) && df.measured.sPerStep > 0
      && readJSON(path.join(dirf, 'train.json')).state === 'fini', fs.existsSync(path.join(UD3, 'loras-mia')) && fs.readdirSync(path.join(UD3, 'loras-mia')));
    C2.t.dispose();

    // (g) l'outil s'est mis en pause lui-même (Mia partie : alive trop vieux), point écrit : « pause », pas « interrompu »
    const D1 = makeTrainer(UD3);
    const idg = await draft(D1, 'Pause absente', { msPerStep: 25, heartbeatMs: 150, aliveCheckMs: 100, aliveStaleMs: 600, aliveRecheckMs: 300, aliveForceMs: 20000 }, { steps: 400, saveEvery: 50, sampleEvery: 0 });
    await D1.t.start(idg);
    await waitFor(() => doc(D1, idg).step >= 10);
    const dirg = dirOf(D1, idg);
    const pidg = doc(D1, idg).proc.pid;
    crash(D1);
    const stG = await waitFor(() => lines(path.join(dirg, 'events.jsonl')).find((e) => e.e === 'stopped'), 12000);
    await waitFor(() => !pidAlive(pidg), 4000);
    fs.rmSync(LOCK, { force: true });
    const D2 = makeTrainer(UD3);
    const dg = doc(D2, idg);
    check('l’outil s’est arrêté seul (Mia partie) avec son point : au redémarrage « pause » à ce pas, reprise possible', !!stG && stG.why === 'alive' && dg.state === 'pause' && dg.pause.reason === 'user' && dg.step === stG.step
      && D2.t.pickCheckpoint(D2.t.item(idg), { dryRun: true }) === stG.step, { stG, state: dg.state, step: dg.step });
    D2.t.dispose();

    // (h) garde : le « done » d'un lancement PRÉCÉDENT ne fait pas un « fini » (le lancement en cours n'a rien dit)
    const tj = readJSON(path.join(dirf, 'train.json'));
    Object.assign(tj, { state: 'entrainement', run: tj.run + 1, proc: { pid: 1, token: 'autre', startedAt: Date.now() } });
    fs.writeFileSync(path.join(dirf, 'train.json'), JSON.stringify(tj));
    const E1 = makeTrainer(UD3);
    check('garde : un « done » du lancement précédent ne vaut pas pour le lancement en cours → « interrompu »', doc(E1, idf).state === 'interrompu', doc(E1, idf).state);
    E1.t.dispose();
  }

  // ================================================================ 13. fermeture de Mia
  section('Fermeture de Mia : stopForQuit, killSync');
  {
    const id = await draft(A, 'Quitter', { msPerStep: 15 }, { steps: 200, sampleEvery: 0 });
    await A.t.start(id);
    await waitFor(() => doc(A, id).step >= 12);
    const pid = doc(A, id).proc.pid;
    const q = await A.t.stopForQuit();
    check('« Arrêter et quitter » : point écrit, état « pause » au redémarrage', q.ok && q.states.join() === 'pause' && doc(A, id).state === 'pause' && doc(A, id).pause.reason === 'user' && !pidAlive(pid)
      && doc(A, id).checkpoints.some((c) => c.step === doc(A, id).step) && lockNow() === null && readJSON(path.join(dirOf(A, id), 'train.json')).state === 'pause', q);
    await A.t.remove(id);

    const id2 = await draft(A, 'Quitter sourd', { msPerStep: 15, ignoreControl: true }, { steps: 2000, sampleEvery: 0 });
    await A.t.start(id2);
    await waitFor(() => doc(A, id2).step >= 12);
    const pid2 = doc(A, id2).proc.pid;
    const t0 = Date.now();
    const q2 = await A.t.stopForQuit();
    check('outil sourd à la fermeture : tué après le délai, « interrompu »', q2.states.join() === 'interrompu' && Date.now() - t0 >= 1400 && !pidAlive(pid2) && lockNow() === null, { q2, ms: Date.now() - t0 });
    await A.t.remove(id2);

    const id3 = await draft(A, 'Quitter vite', { msPerStep: 15, ignoreControl: true }, { steps: 2000, sampleEvery: 0 });
    await A.t.start(id3);
    await waitFor(() => doc(A, id3).step >= 12);
    const pid3 = doc(A, id3).proc.pid;
    A.t.cfg.quitMs = 20000;                                      // s'il attendait le délai, le contrôle le verrait
    const t1 = Date.now();
    const q3 = await A.t.stopForQuit({ now: true });
    A.t.cfg.quitMs = FAST.quitMs;
    check('« Quitter sans attendre » : tué tout de suite, « interrompu »', q3.states.join() === 'interrompu' && Date.now() - t1 < 5000 && !pidAlive(pid3), { q3, ms: Date.now() - t1 });
    await A.t.remove(id3);

    const id4 = await draft(A, 'Quitter tôt', { msPerStep: 15, loadMs: 8000 }, { steps: 40 });
    await A.t.start(id4);
    await waitFor(() => doc(A, id4).phase === 'load');
    const pid4 = doc(A, id4).proc.pid;
    const q4 = await A.t.stopForQuit();
    check('pendant la préparation : arrêt immédiat (rien à sauver)', q4.states.join() === 'interrompu' && !pidAlive(pid4) && lockNow() === null, q4);
    await A.t.remove(id4);

    fs.writeFileSync(LOCK, JSON.stringify({ qui: 'Autre', minutes: 10, debut: Date.now() / 1000, depuis: '10:00', app: 'autre', pid: 1 }), 'utf8');
    const id5 = await draft(A, 'Quitter en file', {}, { steps: 20 });
    await A.t.start(id5);
    const q5 = await A.t.stopForQuit();
    fs.rmSync(LOCK, { force: true });
    await wait(200);
    check('en attente du GPU : redevient un brouillon, rien ne part après', q5.states.length === 0 && doc(A, id5).state === 'pret' && !A.t.item(id5).live && lockNow() === null, doc(A, id5).state);
    check('sans entraînement actif : stopForQuit rend la main aussitôt', (await A.t.stopForQuit()).states.length === 0);

    await A.t.start(id5);
    await until(A, id5, ['entrainement']);
    const pid5 = doc(A, id5).proc.pid;
    A.t.killSync();
    check('killSync (dernier filet) : outil tué, « interrompu » écrit, verrou rendu', !pidAlive(pid5) && doc(A, id5).state === 'interrompu' && readJSON(path.join(dirOf(A, id5), 'train.json')).state === 'interrompu' && lockNow() === null, doc(A, id5).state);
    await A.t.remove(id5);
  }

  // ================================================================ 14. proposition, notes
  section('Proposition d’un assistant : rien ne part, toute modification l’annule');
  {
    const id = await draft(A, 'Proposé', { msPerStep: 40 }, { steps: 12, saveEvery: 6, sampleEvery: 0 });
    const p = A.t.propose(id, { by: 'Claude' });
    check('proposer n’est pas lancer', p.ok && p.awaitingUser === true && doc(A, id).state === 'pret' && doc(A, id).proposal.by === 'Claude' && doc(A, id).proposal.resume === false && !!doc(A, id).proposal.digest && A.t.active() === null, doc(A, id).proposal);
    check('la proposition survit sur le disque (rechargement de la fenêtre, redémarrage)', readJSON(path.join(dirOf(A, id), 'train.json')).proposal.by === 'Claude' && A.t.summary(A.t.item(id)).proposal.by === 'Claude');
    await A.invoke('train:update', id, { name: 'Proposé modifié' });
    check('brouillon modifié : proposition annulée (« changed »)', doc(A, id).proposal === null && doc(A, id).proposalEnd.state === 'changed');
    check('… un clic « Lancer » tardif sur la carte est refusé', (await A.invoke('train:start', id, { proposal: true })).code === 'noProposal' && doc(A, id).state === 'pret');
    A.t.propose(id, { by: 'Claude' });
    await A.invoke('train:setCaption', id, 'rosa_01.png', 'autre légende');
    check('légende modifiée : annulée aussi', doc(A, id).proposal === null);
    A.t.propose(id, { by: 'Claude' });
    A.t.item(id).doc.steps = 14;                                 // changement que la proposition n'a pas vu
    const ch = await A.invoke('train:start', id, { proposal: true });
    check('empreinte différente au clic : départ refusé, proposition annulée', ch.ok === false && ch.code === 'proposalChanged' && doc(A, id).proposal === null && doc(A, id).state === 'pret', ch);
    A.t.propose(id, { by: 'Claude' });
    const dec = await A.invoke('train:update', id, { proposal: null });
    check('« Refuser » : proposition retirée (« declined »), brouillon intact', dec.ok && doc(A, id).proposal === null && doc(A, id).proposalEnd.state === 'declined' && doc(A, id).state === 'pret');
    check('reprise proposée sur un brouillon : refusée', A.t.propose(id, { by: 'Claude', resume: true }).code === 'notResumable');
    A.t.propose(id, { by: 'Claude' });
    const go = await A.invoke('train:start', id, { proposal: true });
    check('clic « Lancer » : part, « proposé par Claude, lancé par toi »', go.ok && doc(A, id).proposedBy === 'Claude' && doc(A, id).startedBy === 'user' && doc(A, id).proposal === null && doc(A, id).proposalEnd.state === 'started', go);
    await waitFor(() => doc(A, id).step >= 3);
    await A.t.control(id, 'pause', { by: 'Claude' });
    await until(A, id, ['pause']);
    check('pause d’un assistant : signée dans les évènements', doc(A, id).notes.some((n) => n.act === 'pause' && n.by === 'Claude'));
    const pr = A.t.propose(id, { by: 'Claude', resume: true });
    const gr = await A.invoke('train:start', id, { proposal: true });
    check('reprise proposée puis cliquée : repart du point', pr.ok && gr.ok && gr.resumeFrom === doc(A, id).resumedFrom && doc(A, id).run === 2, gr);

    section('Notes, « regarde », vu');
    const n1 = await A.invoke('train:note', id, { text: 'visage stable', by: 'Claude' });
    const n2 = await A.invoke('train:note', id, { text: 'encore', by: 'Claude' });
    check('note d’un assistant : signée, au pas courant', n1.ok && doc(A, id).notes.some((n) => n.text === 'visage stable' && n.by === 'Claude' && !n.act && n.step >= 0), n1);
    check('deuxième note dans la minute : refusée', n2.ok === false && n2.code === 'noteRate' && n2.error === 'Une note par minute au plus.', n2);
    check('note de 281 caractères, note vide : refusées', (await A.invoke('train:note', id, { text: 'x'.repeat(281), by: 'Codex' })).code === 'noteLong' && (await A.invoke('train:note', id, { text: '  ' })).code === 'noteEmpty');
    check('les notes de Quentin ne sont pas limitées', (await A.invoke('train:note', id, { text: 'un' })).ok && (await A.invoke('train:note', id, { text: 'deux' })).ok);
    // garde côté principal : un « by » venu de la page n'est jamais Quentin ni Mia
    const nu = await A.invoke('train:note', id, { text: 'signée user par la page', by: 'user' });
    const nm = await A.invoke('train:note', id, { text: 'signée Mia par la page', by: ' MIA ' });
    check('« by » de la page : « user » devient « Assistant » (limité comme un assistant), « Mia » aussi',
      nu.ok && doc(A, id).notes.some((n) => n.text === 'signée user par la page' && n.by === 'Assistant') && nm.ok === false && nm.code === 'noteRate', [nu, nm]);
    check('« by » de la page : nettoyé et coupé à 40 caractères ; Mia seule peut signer « Mia » (côté principal)',
      Trainer.pageBy('Cl\u0007aude') === 'Cl aude' && Trainer.pageBy('x'.repeat(60)).length === 40 && Trainer.pageBy('') === 'Assistant' &&
      Trainer.pageArgs('setCaption', ['i', 'a.png', 't', 'mia'])[3] === 'Assistant' && Trainer.pageArgs('setCaption', ['i', 'a.png', 't']).length === 3 &&
      Trainer.pageArgs('note', ['i', { text: 't' }])[1].by === undefined);
    A.t.cfg.noteMs = 0;
    let last = null;
    for (let i = 0; i < 41; i++) last = await A.invoke('train:note', id, { text: `note ${i}`, by: 'Codex' });
    A.t.cfg.noteMs = FAST.noteMs;
    check('40 notes au plus par entraînement', last.ok === false && last.code === 'noteMax' && doc(A, id).notes.filter((n) => !n.act).length === 40, last);
    const w = await A.invoke('train:get', id, { watch: 'Claude' });
    check('lecture par un assistant : « Claude regarde » noté', w.lastWatch && w.lastWatch.by === 'Claude' && Date.now() - w.lastWatch.at < 2000, w.lastWatch);
    check('sans identifiant : l’entraînement actif', (await A.invoke('train:get')).id === id);
    await until(A, id, ['fini']);
    await A.t.remove(id);
  }

  // ================================================================ 15. corbeille, instance, dossier introuvable
  section('Corbeille, entraînements d’un autre userData, dossier introuvable');
  {
    const id = await draft(A, 'Corbeille', { msPerStep: 15 }, { steps: 40, sampleEvery: 0 });
    await A.t.start(id);
    await until(A, id, ['entrainement']);
    const no = await A.invoke('train:remove', id);
    check('corbeille refusée pendant l’entraînement', no.ok === false && no.code === 'activeNoRemove' && fs.existsSync(dirOf(A, id)), no);
    await until(A, id, ['fini']);
    const dir = dirOf(A, id);
    const lora = path.join(UD, 'loras-mia', 'Corbeille_fake_00040.safetensors');
    const r = await A.invoke('train:remove', id);
    check('mise à la corbeille : le dossier entier, taille rendue', r.ok && r.sizeMB >= 0 && !fs.existsSync(dir) && trashed.includes(dir) && !A.t.item(id), r);
    check('les LoRA déjà rangés restent', fs.existsSync(lora) && fs.existsSync(lora.replace(/\.safetensors$/, '.mia.json')));
    check('l’index ne le connaît plus', !readJSON(path.join(UD, 'data', 'trainings.json')).items.some((x) => x.id === id));

    // un entraînement d'une autre Mia dans le même dossier : ni listé, ni touché
    const foreign = path.join(UD, 'training', 't_20261118-0900_autre');
    fs.mkdirSync(foreign, { recursive: true });
    const fj = JSON.stringify({ v: 1, id: 't_20261118-0900_autre', name: 'Autre Mia', base: 'fake', state: 'entrainement', owner: { miaPid: 1, userData: 'X:\\autre\\Mia' }, proc: { pid: 1, token: 'z' } });
    fs.writeFileSync(path.join(foreign, 'train.json'), fj);
    const A2 = makeTrainer(UD);
    const l2 = await A2.invoke('train:list');
    check('entraînement d’un autre userData : pas listé', !l2.some((x) => x.id === 't_20261118-0900_autre') && l2.length === (await A.invoke('train:list')).length, l2.map((x) => x.id));
    check('… ni touché (pas de « interrompu » écrit chez lui)', fs.readFileSync(path.join(foreign, 'train.json'), 'utf8') === fj);
    check('un second service sur le même userData relit la même liste depuis le disque', l2.some((x) => x.id === draftId && x.state === 'fini'));
    A2.t.dispose();

    const idm = await draft(A, 'Déplacé', {}, { steps: 10 });
    const dirm = dirOf(A, idm);
    const moved = path.join(WORK, 'ailleurs', 'deplace');
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(dirm, moved);
    const l3 = await A.invoke('train:list');
    check('dossier disparu : la ligne reste, « INTROUVABLE »', l3.find((x) => x.id === idm).missing === true, l3.find((x) => x.id === idm));
    check('… rien n’est possible dessus sauf le retrouver', (await A.invoke('train:start', idm)).code === 'unknown' && (await A.invoke('train:locate', idm, SET10)).code === 'locateWrong');
    const loc = await A.invoke('train:locate', idm, moved);
    check('« Retrouver le dossier… » : de nouveau listé, depuis son nouvel emplacement', loc.ok && A.t.item(idm).missing === false && dirOf(A, idm) === moved && A.t.get(idm).ready === true && readJSON(path.join(UD, 'data', 'trainings.json')).items.find((x) => x.id === idm).dir === moved, loc);
    check('retrouver un dossier connu : phrase lisible', (await A.invoke('train:locate', idm, moved)).code === 'notMissing');
    await A.t.remove(idm);
  }

  section('Rien n’est écrit hors du banc');
  {
    check('aucun dossier loras\\mia créé dans le faux moteur', !fs.existsSync(path.join(ENGINE, 'models', 'loras')));
    check('le faux moteur n’a reçu que le verrou (rendu) et les faux poids du banc', lockNow() === null && fs.readdirSync(ENGINE).sort().join() === 'models,runtime' && fs.readdirSync(path.join(ENGINE, 'runtime')).length === 0);
  }
})().catch((e) => {
  failures++;
  console.log(`\nEXCEPTION ${e && e.stack ? e.stack : e}`);
}).finally(async () => {
  // aucun outil ne doit survivre au banc : on arrête par leur numéro ceux qui resteraient, et on le dit
  let left = 0;
  for (const T of made) {
    T.t.dispose();
    for (const it of T.t.items.values()) {
      const pid = (it.live && it.live.pid) || (it.doc.proc && it.doc.proc.pid);
      if (pid && pid !== 1 && pidAlive(pid)) { left++; console.log(`  (outil ${pid} encore en vie : arrêté)`); spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); }
    }
  }
  check('aucun faux outil laissé en vie par le banc', left === 0, left);
  console.log(`\n${passes} contrôles réussis, ${failures} en échec.`);
  if (failures) {
    console.log(`Dossier du banc gardé pour examen : ${WORK}`);
    if (allLogs.length) console.log(`Journal du service (fin) :\n  ${allLogs.slice(-25).join('\n  ')}`);
    process.exitCode = 1;
  } else {
    await wait(100);
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* un fichier encore tenu : le dossier est sous _dev/tmp */ }
  }
  setTimeout(() => process.exit(process.exitCode || 0), 50);
});
