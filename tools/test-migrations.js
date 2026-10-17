'use strict';
// Essai des versions de formats et des migrations (SPEC §21.1), hors d'Electron, sur des fichiers fabriqués :
//   node tools/test-migrations.js
//
// - electron/migrations.js : chaîne de mise à jour (format 0 → actuel), copie .bak-v<ancien> unique, document d'une
//   version plus récente laissé tel quel, étape qui échoue → document d'origine.
// - electron/store.js : prefs.json, project.json, folder.json et graph.json sans version sont mis au format courant
//   à l'ouverture (copie gardée), une planche d'un Mia plus récent s'ouvre en lecture seule et n'est jamais écrite.
// - electron/version.js : version, date tirée de CHANGELOG.md, ordre SemVer.
// Tout se passe dans _dev/test-migrations (recréé à chaque essai ; MIA_TEST_WORK=<dossier> pour en changer) :
// aucune donnée réelle n'est lue ni écrite. Code de sortie 0 si tout passe.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const WORK = process.env.MIA_TEST_WORK ? path.resolve(process.env.MIA_TEST_WORK) : path.join(ROOT, '_dev', 'test-migrations');
const migrations = require(path.join(ROOT, 'electron', 'migrations.js'));
const version = require(path.join(ROOT, 'electron', 'version.js'));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    passed++;
    console.log(`  ✓ ${name}${note ? ' — ' + note : ''} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${String(e && e.stack || e).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJSON = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };

async function main() {
  await fsp.rm(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  console.log('\nmigrations.js');
  await test('versions courantes déclarées pour les 5 formats', () => {
    for (const k of ['graph', 'project', 'folder', 'prefs', 'loras']) assert.ok(migrations.CURRENT[k] >= 1, k);
    return Object.entries(migrations.CURRENT).map(([k, v]) => `${k} ${v}`).join(' · ');
  });
  await test('planche sans version → format courant, contenu intact, original non modifié', () => {
    const old = { camera: { x: 1, y: 2, z: 0.5 }, nodes: [{ id: 'n_a', type: 'depth', params: { detail: 'fast' } }], edges: [], groups: [], extra: { keep: true } };
    const before = JSON.stringify(old);
    const r = migrations.migrate('graph', old);
    assert.equal(r.from, 0);
    assert.equal(r.to, migrations.CURRENT.graph);
    assert.equal(r.upgraded, true);
    assert.equal(r.doc.version, migrations.CURRENT.graph);
    assert.deepEqual(r.doc.nodes, old.nodes);
    assert.deepEqual(r.doc.extra, { keep: true }, 'une clé inconnue est gardée');
    assert.equal(JSON.stringify(old), before, 'l’original n’est pas touché');
  });
  await test('déjà au format courant → rien à faire', () => {
    const g = { version: migrations.CURRENT.graph, nodes: [] };
    const r = migrations.migrate('graph', g);
    assert.equal(r.upgraded, false);
    assert.equal(r.doc, g);
  });
  await test('document d’un Mia plus récent → laissé tel quel, signalé', () => {
    const g = { version: migrations.CURRENT.graph + 7, nodes: [], future: 1 };
    const r = migrations.migrate('graph', g);
    assert.equal(r.newer, true);
    assert.equal(r.doc, g);
    assert.match(migrations.message(r, 'fr'), /plus récente/);
    assert.match(migrations.message(r, 'en'), /newer/);
  });
  await test('prefs sans version (Mia ≤ 0.4) → lastSeenVersion 0.4.0 pour annoncer les nouveautés', () => {
    const r = migrations.migrate('prefs', { lang: 'fr', theme: 'dark' });
    assert.equal(r.doc.version, migrations.CURRENT.prefs);
    assert.equal(r.doc.lastSeenVersion, '0.4.0');
    const r2 = migrations.migrate('prefs', { lang: 'fr', lastSeenVersion: '0.3.0' });
    assert.equal(r2.doc.lastSeenVersion, '0.3.0', 'une valeur existante n’est pas écrasée');
  });
  await test('registre des LoRA : une liste est le format 1', () => {
    const l = [{ id: 'x', name: 'Mara' }];
    const r = migrations.migrate('loras', l);
    assert.equal(r.from, 1);
    assert.equal(r.upgraded, false);
    assert.equal(r.doc, l);
  });
  await test('ce qui n’est pas un document (null, texte, liste pour une planche) → rendu tel quel', () => {
    for (const d of [null, undefined, 'x', 3, []]) {
      const r = migrations.migrate('graph', d);
      assert.equal(r.from, null);
      assert.equal(r.doc, d);
    }
  });
  await test('une étape qui échoue → document d’origine, signalé « failed »', () => {
    const steps = migrations._STEPS.graph;
    const saved = steps[0];
    steps[0] = () => { throw new Error('boum'); };
    try {
      const g = { nodes: [] };
      const r = migrations.migrate('graph', g);
      assert.equal(r.failed, true);
      assert.equal(r.doc, g);
      assert.match(migrations.message(r, 'fr'), /boum/);
    } finally {
      steps[0] = saved;
    }
  });
  await test('copie .bak-v<ancien> faite une seule fois (la plus ancienne gagne)', async () => {
    const f = path.join(WORK, 'unit', 'graph.json');
    writeJSON(f, { nodes: [], mark: 'premier' });
    const r1 = await migrations.migrateFile('graph', f, readJSON(f));
    assert.equal(r1.backup, f + '.bak-v0');
    writeJSON(f, { nodes: [], mark: 'second' });
    const r2 = await migrations.migrateFile('graph', f, readJSON(f));
    assert.equal(r2.backup, f + '.bak-v0');
    assert.equal(readJSON(f + '.bak-v0').mark, 'premier');
    const none = await migrations.migrateFile('graph', path.join(WORK, 'unit', 'absent.json'), { nodes: [] });
    assert.equal(none.backup, null, 'pas de fichier : pas de copie, pas d’erreur');
  });

  console.log('\nstore.js (ouverture des fichiers)');
  const userData = path.join(WORK, 'userdata');
  const projects = path.join(WORK, 'projets');
  const oldBoard = path.join(projects, 'Ancienne planche');
  const futureBoard = path.join(projects, 'Planche du futur');
  const folder = path.join(projects, 'Un projet');
  const inFolder = path.join(folder, 'Plan 01');
  const oldGraph = {
    camera: { x: 0, y: 0, z: 1 },
    nodes: [{ id: 'n_imp', type: 'import', x: 0, y: 0, w: 336, params: {}, data: { placeholder: { kind: 'image', fr: 'Image', en: 'Image' } } }],
    edges: [],
    groups: [{ id: 'g_1', x: 0, y: 0, w: 400, h: 300, title: 'Plan', tone: null }]
  };
  writeJSON(path.join(userData, 'data', 'prefs.json'), { lang: 'fr', theme: 'dark', projectsRoot: projects, wires: 'typed' });
  writeJSON(path.join(oldBoard, 'project.json'), { id: 'p_ancien1', name: 'Ancienne planche', created: 1, updated: 2 });
  writeJSON(path.join(oldBoard, 'graph.json'), oldGraph);
  writeJSON(path.join(futureBoard, 'project.json'), { id: 'p_futur01', name: 'Planche du futur', created: 1, updated: 2, version: 1 });
  writeJSON(path.join(futureBoard, 'graph.json'), { version: 99, camera: { x: 0, y: 0, z: 1 }, nodes: [], edges: [], groups: [], hologram: true });
  writeJSON(path.join(folder, 'folder.json'), { id: 'f_projet1', name: 'Un projet', color: 'teal', created: 1, updated: 2 });
  writeJSON(path.join(inFolder, 'project.json'), { id: 'p_plan0001', name: 'Plan 01', folderId: 'f_projet1', created: 1, updated: 2, version: 1 });
  writeJSON(path.join(inFolder, 'graph.json'), { version: 1, camera: { x: 0, y: 0, z: 1 }, nodes: [], edges: [], groups: [] });
  const futureBytes = fs.readFileSync(path.join(futureBoard, 'graph.json'));

  const store = require(path.join(ROOT, 'electron', 'store.js'));
  const logs = [];
  const prefs = await store.init({ userData, documents: WORK, projectsRootOverride: projects, log: (...a) => logs.push(a.join(' ')), trash: async () => {} });
  await store.ready();

  await test('prefs.json sans version → format courant écrit, copie prefs.json.bak-v0 gardée', () => {
    const pf = path.join(userData, 'data', 'prefs.json');
    assert.equal(prefs.version, migrations.CURRENT.prefs);
    assert.equal(prefs.lastSeenVersion, '0.4.0');
    assert.equal(prefs.wires, 'typed', 'les réglages de l’utilisateur restent');
    assert.equal(readJSON(pf).version, migrations.CURRENT.prefs);
    assert.ok(fs.existsSync(pf + '.bak-v0'));
    assert.equal(readJSON(pf + '.bak-v0').version, undefined, 'la copie est l’ancien fichier');
  });
  await test('project.json et folder.json sans version : copie gardée au premier passage, index intact', async () => {
    const list = await store.list();
    const names = list.map((p) => p.name).sort();
    assert.deepEqual(names, ['Ancienne planche', 'Plan 01', 'Planche du futur']);
    assert.ok(fs.existsSync(path.join(oldBoard, 'project.json.bak-v0')));
    assert.ok(fs.existsSync(path.join(folder, 'folder.json.bak-v0')));
    assert.ok(!fs.existsSync(path.join(inFolder, 'project.json.bak-v1')), 'un fichier à jour n’a pas de copie');
    const folders = await store.folders.list();
    assert.equal(folders.length, 1);
    assert.equal(folders[0].color, 'teal');
  });
  await test('ouvrir une planche sans version → format courant, contenu intact, graph.json.bak-v0 gardé', async () => {
    const r = await store.open('p_ancien1');
    assert.equal(r.readOnly, false);
    assert.equal(r.graph.version, migrations.CURRENT.graph);
    assert.deepEqual(r.graph.nodes, oldGraph.nodes);
    assert.deepEqual(r.graph.groups, oldGraph.groups);
    const bak = path.join(oldBoard, 'graph.json.bak-v0');
    assert.ok(fs.existsSync(bak));
    assert.equal(readJSON(bak).version, undefined);
    assert.equal(readJSON(path.join(oldBoard, 'project.json')).version, migrations.CURRENT.project, 'project.json réécrit au format courant');
    const s = await store.save('p_ancien1', r.graph, {});
    assert.equal(s.ok, true);
    assert.equal(readJSON(path.join(oldBoard, 'graph.json')).version, migrations.CURRENT.graph);
    assert.equal(readJSON(bak).version, undefined, 'la copie de l’ancien format ne bouge plus');
  });
  await test('planche d’un Mia plus récent → lecture seule, message clair, fichier jamais réécrit', async () => {
    const r = await store.open('p_futur01');
    assert.equal(r.readOnly, true);
    assert.equal(r.readOnlyReason, 'newer');
    assert.match(r.error, /version plus récente de Mia/);
    assert.equal(r.graph.hologram, true, 'ce que cette version ne connaît pas reste dans le document');
    const s = await store.save('p_futur01', r.graph, {});
    assert.equal(s.ok, false);
    assert.ok(fs.readFileSync(path.join(futureBoard, 'graph.json')).equals(futureBytes), 'graph.json identique à l’octet près');
    assert.ok(!fs.existsSync(path.join(futureBoard, 'graph.json.bak-v99')));
  });
  await test('planche au format courant → ouverte normalement, aucune copie', async () => {
    const r = await store.open('p_plan0001');
    assert.equal(r.readOnly, false);
    assert.ok(!fs.readdirSync(inFolder).some((n) => /\.bak-v\d+$/.test(n)));
  });
  await test('deuxième démarrage : rien de plus (pas de nouvelle copie, rien à migrer)', async () => {
    const before = logs.filter((l) => /format \d+ → \d+/.test(l)).length;
    await store.reconcile();
    await store.open('p_ancien1');
    const after = logs.filter((l) => /format \d+ → \d+/.test(l)).length;
    assert.equal(after, before);
    return `${before} mise(s) à jour au premier passage`;
  });
  await store.idle?.();

  console.log('\nversion.js');
  await test('version = package.json, date tirée de CHANGELOG.md', () => {
    const pkg = readJSON(path.join(ROOT, 'package.json'));
    const v = version.info();
    assert.equal(v.version, pkg.version);
    assert.match(v.date || '', /^\d{4}-\d{2}-\d{2}$/, 'la version courante a sa section datée dans CHANGELOG.md');
    assert.ok(version.notes(v.version).includes('### '), 'la section a des rubriques');
    return `${v.version} du ${v.date}${v.commit ? ' · ' + v.commit.slice(0, 7) : ''}`;
  });
  await test('CHANGELOG : sections du plus récent au plus ancien, depuis 0.1.0', () => {
    const s = version.sections();
    assert.equal(s[s.length - 1].version, '0.1.0');
    for (let i = 1; i < s.length; i++) assert.equal(version.compare(s[i - 1].version, s[i].version), 1, `${s[i - 1].version} > ${s[i].version}`);
    return s.map((x) => x.version).join(' · ');
  });
  await test('ordre SemVer', () => {
    assert.equal(version.compare('0.4.0', '0.5.0'), -1);
    assert.equal(version.compare('0.10.0', '0.9.9'), 1);
    assert.equal(version.compare('1.0.0-beta', '1.0.0'), -1);
    assert.equal(version.compare('0.5.0', '0.5.0'), 0);
  });

  console.log(`\n${passed}/${passed + failed} essais réussis`);
  console.log(`(fichiers d'essai gardés dans ${WORK})`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
