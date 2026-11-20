'use strict';
// Réglages → Entraînement (CONCEPTION-entrainement §2.6, §4.2), en Node pur (sans Electron, sans Python, sans GPU) :
//   node tools/test-train-settings.js
//
// - le magasin de réglages (electron/store.js) : prefs.trainRoot refusé dans le moteur, dans les projets, dans un dossier
//   lu par le scanner, sur un disque absent ; « '' » = l'emplacement par défaut ; rien n'est créé sur le disque ;
// - le service (electron/trainer.js) lit ces réglages à chaque appel : dossier des entraînements (création d'un brouillon,
//   liste, anciens dossiers), dossier des outils (détection LTX / ai-toolkit), `folders` de train:options ;
// - les textes de l'écran (src/js/ui/settings.js) : mêmes clés en français et en anglais, aucun <select>, aucun title=.
// Tout est écrit sous _dev/tmp/test-train-settings-<pid> ; jamais dans AppData, jamais dans le moteur. Aucun outil n'est
// lancé (MIA_NO_GPU=1, aucun « start »). Code de sortie 1 si un contrôle échoue.

const fs = require('node:fs');
const path = require('node:path');

delete process.env.MIA_TRAIN_FAKE;       // une VRAIE instance : les réglages comptent (une instance de test les ignore)
delete process.env.MIA_USERDATA;
process.env.MIA_NO_GPU = '1';            // filet : rien ne partirait sur le GPU, même par erreur
process.env.MIA_NO_LAB = '1';            // jamais le labo de l'auteur comme moteur par défaut

const MIA = path.resolve(__dirname, '..');
const places = require(path.join(MIA, 'electron', 'places.js'));
const { register } = require(path.join(MIA, 'electron', 'trainer.js'));

let failures = 0;
let passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log(`  ok    ${name}`); }
  else { failures++; console.log(`  ÉCHEC ${name}${detail !== undefined ? ` → ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}
const section = (t) => console.log(`\n== ${t}`);

const WORK = path.join(MIA, '_dev', 'tmp', `test-train-settings-${process.pid}`);
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const inBench = (p) => path.resolve(p).toLowerCase().startsWith(path.resolve(WORK).toLowerCase());

// un moteur du banc (portable : python_embeded), un dossier « entrainement » à côté, des outils factices
const ENGINE = path.join(WORK, 'IA', 'moteur');
fs.mkdirSync(path.join(ENGINE, 'python_embeded'), { recursive: true });
fs.writeFileSync(path.join(ENGINE, 'python_embeded', 'python.exe'), '');
const BESIDE = path.join(WORK, 'IA', 'entrainement');
fs.mkdirSync(BESIDE, { recursive: true });

/** Un dossier d'outils factice : venv-ltx (version donnée), sources LTX, et ai-toolkit si demandé. Rien ne s'exécute. */
function fakeTools(dir, { ltx = '1.6.2', aitk = false } = {}) {
  fs.mkdirSync(path.join(dir, 'venv-ltx', 'Scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'venv-ltx', 'Scripts', 'python.exe'), '');
  fs.mkdirSync(path.join(dir, 'venv-ltx', 'Lib', 'site-packages', `ltx_trainer-${ltx}.dist-info`), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'LTX-2', 'packages', 'ltx-trainer', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'LTX-2', 'packages', 'ltx-trainer', 'scripts', 'preprocess.py'), '');
  if (aitk) {
    fs.mkdirSync(path.join(dir, 'venv-aitk', 'Scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'venv-aitk', 'Scripts', 'python.exe'), '');
    fs.mkdirSync(path.join(dir, 'src', 'ai-toolkit'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'ai-toolkit', 'run.py'), '');
  }
  return dir;
}

/** Une lettre de disque qui n'existe pas sur ce PC (pour le refus « disque introuvable »). */
function absentDrive() {
  for (const l of 'QRSTUVWXYZKLMNOP') if (!fs.existsSync(`${l}:\\`)) return `${l}:\\`;
  return null;
}

(async () => {
  const store = require(path.join(MIA, 'electron', 'store.js'));
  const UD = path.join(WORK, 'ud');
  const PROJ = path.join(WORK, 'projets');
  await store.init({ userData: UD, documents: WORK, projectsRootOverride: PROJ, log: () => {}, trash: async () => {} });
  await store.setPrefs({ lang: 'fr', engineRoot: ENGINE });

  // ================================================================ le magasin de réglages
  section('Magasin : où le dossier des entraînements peut aller');
  {
    const refused = async (patch, re, name) => {
      const before = JSON.stringify(store.getPrefs());
      let err = null;
      try { await store.setPrefs(patch); } catch (e) { err = e; }
      check(name, !!err && re.test(err.userMessage || ''), err ? (err.userMessage || err.message) : 'accepté');
      check(`… et les réglages n’ont pas bougé (${Object.keys(patch).join(', ')})`, JSON.stringify(store.getPrefs()) === before);
    };
    await refused({ trainRoot: ENGINE }, /dans le dossier du moteur/, 'le dossier du moteur lui-même : refusé, phrase lisible');
    await refused({ trainRoot: path.join(ENGINE, 'models', 'loras', 'entrainements') }, /Mia n’écrit jamais dans le moteur/, 'un dossier dans le moteur : refusé');
    await refused({ trainRoot: path.join(PROJ, 'LoRA') }, /dans le dossier des projets/, 'un dossier dans les projets : refusé');
    const loras = path.join(WORK, 'mes-lora');
    await store.setPrefs({ loraFolders: [loras] });
    await refused({ trainRoot: path.join(loras, 'entrainements') }, /dossier de LoRA ou de modèles/, 'un dossier dans un dossier de LoRA (lu par le scanner) : refusé');
    const models = path.join(WORK, 'modeles-en-plus');
    await store.setPrefs({ extraModelRoots: [models] });
    await refused({ trainRoot: models }, /passeraient pour des LoRA/, 'un dossier de modèles en plus : refusé');
    const drive = absentDrive();
    if (drive) await refused({ trainRoot: path.join(drive, 'entrainement') }, new RegExp(`Le disque « ${drive.replace(/\\/g, '\\\\')} » est introuvable`), `un disque absent (${drive}) : refusé`);

    const chosen = path.join(WORK, 'choisi', 'entrainements');
    const p1 = await store.setPrefs({ trainRoot: chosen });
    check('un dossier ailleurs : accepté et gardé', p1.trainRoot === chosen, p1.trainRoot);
    check('… sans le créer (le service le crée au premier brouillon, là où il a été choisi)', !fs.existsSync(chosen) && !fs.existsSync(path.dirname(chosen)));
    check('… l’emplacement d’avant (à côté du moteur) reste listé', p1.trainRoots[0] === path.join(BESIDE, 'mia'), p1.trainRoots);

    // le dossier des entraînements est gardé : un dossier de LoRA qui l'engloberait est refusé à son tour
    await refused({ loraFolders: [loras, path.join(WORK, 'choisi')] }, /dossier de LoRA ou de modèles/, 'ajouter un dossier de LoRA qui contient le dossier des entraînements : refusé');
    fs.mkdirSync(path.join(WORK, 'choisi', 'python_embeded'), { recursive: true });       // un vrai moteur portable
    fs.writeFileSync(path.join(WORK, 'choisi', 'python_embeded', 'python.exe'), '');
    await refused({ engineRoot: path.join(WORK, 'choisi') }, /ne peut pas être dans le dossier du moteur/, 'un moteur qui engloberait le dossier des entraînements : refusé');

    await store.setPrefs({ lang: 'en' });
    let en = null;
    try { await store.setPrefs({ trainRoot: ENGINE }); } catch (e) { en = e; }
    check('en anglais : la même règle, la phrase en anglais', !!en && /^The trainings folder cannot be inside the engine folder/.test(en.userMessage || ''), en && en.userMessage);
    await store.setPrefs({ lang: 'fr' });

    const p2 = await store.setPrefs({ trainRoot: '' });
    check('« Par défaut » (= \'\') : toujours accepté, l’emplacement suit le moteur', p2.trainRoot === '' && places.trainingRoot(p2, UD) === path.join(BESIDE, 'mia'), places.trainingRoot(p2, UD));
    check('… et le dossier choisi avant reste listé (rien n’est déplacé)', p2.trainRoots.includes(chosen), p2.trainRoots);
    const p3 = await store.setPrefs({ trainTools: path.join(WORK, 'outils-ailleurs') });
    check('dossier des outils : un chemin absolu, gardé tel quel, rien créé', p3.trainTools === path.join(WORK, 'outils-ailleurs') && !fs.existsSync(p3.trainTools));
    const p4 = await store.setPrefs({ trainTools: '' });
    check('dossier des outils : « Par défaut » = <parent du moteur>\\entrainement', p4.trainTools === '' && places.trainingTools(p4) === BESIDE, places.trainingTools(p4));
    await store.setPrefs({ loraFolders: [], extraModelRoots: [] });
  }

  // ================================================================ le service lit ces réglages
  section('Service : le dossier des entraînements et celui des outils viennent des réglages');
  const made = [];
  function makeTrainer(userData) {
    const handlers = new Map();
    const ctx = {
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      send: () => {},
      paths: { root: MIA, data: path.join(userData, 'data'), userData },
      prefs: { get: () => store.getPrefs(), onChange: (fn) => store.onPrefs(fn) },
      logger: () => () => {},
      engine: null,
      trainOpts: {
        lockPath: path.join(WORK, 'gpu.lock'),          // jamais <moteur>\runtime\gpu.lock
        queueIdle: () => true,
        freeBytes: () => 400 * 1024 ** 3,
        commitGB: async () => 64,
        trash: async () => {}
      }
    };
    const t = register(ctx);
    made.push(t);
    return { t, invoke: (ch, ...a) => handlers.get(`train:${ch}`)({ sender: null }, ...a) };
  }
  {
    const UD2 = path.join(WORK, 'ud-service');
    fs.mkdirSync(UD2, { recursive: true });
    const T = makeTrainer(UD2);

    let o = await T.invoke('options');
    check('options : ok, et `folders` décrit les emplacements', o && o.ok === true && o.folders && typeof o.folders === 'object', o && o.error);
    check('par défaut : entraînements à côté du moteur, outils à côté du moteur, pas une instance de test',
      o.folders.root === path.join(BESIDE, 'mia') && o.folders.defaultRoot === path.join(BESIDE, 'mia') && o.folders.tools === BESIDE && o.folders.defaultTools === BESIDE && o.folders.test === false, o.folders);
    check('… le dossier choisi avant est encore lu (anciens dossiers)', o.folders.roots[0] === o.folders.root && o.folders.roots.includes(path.join(WORK, 'choisi', 'entrainements')), o.folders.roots);
    check('outils absents : LTX et ai-toolkit « introuvables », avec le chemin qui manque', o.tools.ltx.ok === false && o.tools.ltx.why.code === 'tool' && o.tools.ltx.why.path === path.join(BESIDE, 'venv-ltx') && o.tools.aitk.ok === false, o.tools);
    check('le faux outil n’existe pas dans une vraie instance', !o.tools.fake && !o.bases.some((b) => b.id === 'fake'));

    // le dossier des outils change dans les réglages : la détection suit, sans relancer Mia
    const TOOLS = fakeTools(path.join(WORK, 'outils-a'), { ltx: '1.6.2', aitk: true });
    await store.setPrefs({ trainTools: TOOLS });
    o = await T.invoke('options');
    check('réglage « Outils d’entraînement » suivi : LTX prêt · ltx-trainer 1.6.2', o.folders.tools === TOOLS && o.toolsDir === TOOLS && o.tools.ltx.ok === true && o.tools.ltx.version === '1.6.2' && o.tools.ltx.label === 'ltx-trainer', o.tools.ltx);
    check('… Qwen / Flux (ai-toolkit) prêt aussi', o.tools.aitk.ok === true, o.tools.aitk);
    check('… et l’emplacement par défaut reste connu (bouton « Par défaut »)', o.folders.defaultTools === BESIDE, o.folders.defaultTools);
    const ltxBase = o.bases.find((b) => b.id === 'ltx25');
    check('… le brouillon le voit aussi : LTX ne bute plus sur l’outil (seulement sur MIA_NO_GPU de ce banc)', ltxBase && ltxBase.why && ltxBase.why.code === 'nogpu', ltxBase && ltxBase.why);
    const TOOLS17 = fakeTools(path.join(WORK, 'outils-b'), { ltx: '1.7.0' });
    await store.setPrefs({ trainTools: TOOLS17 });
    o = await T.invoke('options');
    check('autre dossier d’outils, ltx-trainer 1.7.0 : « version 1.7.0 non validée »', o.tools.ltx.ok === false && o.tools.ltx.why.code === 'version' && o.tools.ltx.why.version === '1.7.0', o.tools.ltx);
    check('… et ai-toolkit introuvable dans ce dossier-là', o.tools.aitk.ok === false && o.tools.aitk.why.path === path.join(TOOLS17, 'venv-aitk'), o.tools.aitk);
    await store.setPrefs({ trainTools: '' });
    o = await T.invoke('options');
    check('« Par défaut » : retour à <parent du moteur>\\entrainement', o.folders.tools === BESIDE && o.tools.ltx.ok === false, o.folders.tools);

    // le dossier des entraînements change : rien n'est créé avant le premier brouillon, qui va LÀ
    const ROOT = path.join(WORK, 'disque-entrainements', 'mia');
    await store.setPrefs({ trainRoot: ROOT });
    o = await T.invoke('options');
    check('réglage « Dossier des entraînements » suivi par train:options', o.folders.root === ROOT && o.disk.root === ROOT, o.folders);
    await T.invoke('list');
    check('… lister ne crée pas le dossier', !fs.existsSync(ROOT));
    const d = await T.invoke('create', { name: 'Rosa', base: 'ltx25', kind: 'character', trigger: 'rsa woman' });
    check('un brouillon : son dossier est créé dans le dossier choisi', d && d.id && fs.existsSync(path.join(ROOT, d.id, 'train.json')), d);
    check('… et nulle part ailleurs (ni à côté du moteur, ni dans les données de Mia)', !fs.existsSync(path.join(BESIDE, 'mia')) && !fs.existsSync(path.join(UD2, 'training')));

    // on change encore de dossier : l'ancien reste lu, son brouillon reste dans la liste
    const ROOT2 = path.join(WORK, 'autre-disque', 'lora');
    await store.setPrefs({ trainRoot: ROOT2 });
    const list = await T.invoke('list');
    check('changer de dossier : le brouillon de l’ancien dossier reste dans la liste', Array.isArray(list) && list.some((x) => x.id === d.id), list && list.map((x) => x.id));
    o = await T.invoke('options');
    check('… l’ancien dossier est dans `folders.roots`, le nouveau en tête', o.folders.roots[0] === ROOT2 && o.folders.roots.includes(ROOT), o.folders.roots);
    check('… rien n’a été déplacé ni créé dans le nouveau', fs.existsSync(path.join(ROOT, d.id, 'train.json')) && !fs.existsSync(ROOT2));
    const d2 = await T.invoke('create', { name: 'Aida', base: 'ltx25', kind: 'place', trigger: 'aida place' });
    check('… le brouillon suivant va dans le nouveau', d2 && fs.existsSync(path.join(ROOT2, d2.id, 'train.json')), d2);

    // une instance de test (MIA_TRAIN_FAKE=1) garde les siens dans ses données, quels que soient les réglages
    process.env.MIA_TRAIN_FAKE = '1';
    try {
      o = await T.invoke('options');
      check('instance de test : `folders.test`, entraînements sous <userData>\\training malgré le réglage', o.folders.test === true && o.folders.root === path.join(UD2, 'training') && o.folders.roots.length === 1, o.folders);
      check('… le faux outil y est listé, prêt', o.tools.fake && o.tools.fake.ok === true && o.tools.fake.version === '1.0.0', o.tools.fake);
    } finally {
      delete process.env.MIA_TRAIN_FAKE;
    }
    await store.setPrefs({ trainRoot: '' });
  }

  // ================================================================ les textes de l'écran
  section('Écran Réglages → Entraînement : textes et règles de la maison');
  {
    const src = fs.readFileSync(path.join(MIA, 'src', 'js', 'ui', 'settings.js'), 'utf8');
    const block = (lang) => {
      const a = src.indexOf(`  ${lang}: {`);
      const b = src.indexOf('\n  }', a);
      return src.slice(a, b);
    };
    const keys = (s) => [...s.matchAll(/'(set\.[A-Za-z0-9]+)':/g)].map((m) => m[1]);
    const fr = keys(block('fr'));
    const en = keys(block('en'));
    const want = ['set.secTrain', 'set.trainRoot', 'set.trainTools', 'set.trainDefault', 'set.toolReadyV', 'set.toolVersion', 'set.toolMissing', 'set.trainBusy', 'set.trainTest'];
    check('les clés de l’entraînement existent en français ET en anglais', want.every((k) => fr.includes(k) && en.includes(k)), want.filter((k) => !fr.includes(k) || !en.includes(k)));
    check('mêmes clés dans les deux langues (aucune oubliée)', fr.length === en.length && fr.every((k) => en.includes(k)), fr.filter((k) => !en.includes(k)).concat(en.filter((k) => !fr.includes(k))));
    const val = (lang, k) => { const m = new RegExp(`'${k.replace('.', '\\.')}': '([^']*)'`).exec(block(lang)); return m ? m[1] : null; };
    check('libellés du §2.6 : « Dossier des entraînements » / “Trainings folder”, « Outils d’entraînement » / “Training tools”',
      val('fr', 'set.trainRoot') === 'Dossier des entraînements' && val('en', 'set.trainRoot') === 'Trainings folder' && val('fr', 'set.trainTools') === 'Outils d’entraînement' && val('en', 'set.trainTools') === 'Training tools');
    check('états du §2.6 : « {tool} : prêt · {v} », « {tool} : version {v} non validée »',
      val('fr', 'set.toolReadyV') === '{tool} : prêt · {v}' && val('fr', 'set.toolVersion') === '{tool} : version {v} non validée' && val('en', 'set.toolVersion') === '{tool}: version {v} not validated');
    // SPEC §8.7 : « Générer pendant un entraînement », un interrupteur de la section, activé sauf prefs.trainGenBeside === false
    check('réglage « Générer pendant un entraînement » / “Generate during a training”, avec sa phrase, dans les deux langues',
      val('fr', 'set.trainBeside') === 'Générer pendant un entraînement' && val('en', 'set.trainBeside') === 'Generate during a training'
      && /ralentit un peu/.test(val('fr', 'set.trainBesideHint') || '') && /Mia attend/.test(val('fr', 'set.trainBesideHint') || '')
      && /slows down a little/.test(val('en', 'set.trainBesideHint') || '') && /Mia waits/.test(val('en', 'set.trainBesideHint') || ''));
    check('… un interrupteur dans la section Entraînement, activé par défaut (seul false l’éteint)',
      /trainToolsRow, toolsBox,[\s\S]{0,400}toggle\(\{ value: p\.trainGenBeside !== false[\s\S]{0,160}setPrefs\(\{ trainGenBeside: v \}\)/.test(src));
    check('aucun <select> natif, aucun attribut title=',!/<select|el\('select'|\btitle=|setAttribute\('title'|\.title\s*=[^=]/.test(src));
    check('le choix d’un dossier passe par la boîte native déjà utilisée ailleurs (media.pickFolder)', /trainFolderRow[\s\S]*pickFolder\(\)/.test(src));
  }

  // ================================================================ rien hors du banc
  section('Rien n’est écrit hors du banc');
  {
    const p = store.getPrefs();
    check('les réglages du banc vivent sous le banc', inBench(path.join(UD, 'data', 'prefs.json')) && fs.existsSync(path.join(UD, 'data', 'prefs.json')));
    check('aucun verrou GPU pris', !fs.existsSync(path.join(WORK, 'gpu.lock')) && !fs.existsSync(path.join(ENGINE, 'runtime', 'gpu.lock')));
    check('les dossiers d’entraînement retenus sont tous sous le banc', [p.trainRoot, ...p.trainRoots].filter(Boolean).every(inBench), p.trainRoots);
  }

  for (const t of made) { try { t.dispose(); } catch { /* gone */ } }
  console.log(`\n${passes} contrôles réussis, ${failures} en échec.`);
  if (!failures) fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
