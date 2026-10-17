'use strict';
// Mia — banc d'essai du scanner de modèles (Node seul, sans Electron, aucun calcul GPU).
//
//   node tools/test-scanner.js            scan à froid + à chaud, comparaison avec l'oracle Python, capacités
//   node tools/test-scanner.js --quiet    seulement le bilan
//
// Le cache de test vit dans _dev/fix-C/test/ (ou $MIA_TEST_DIR) : jamais dans le vrai %APPDATA%\Mia\data\models-cache.json,
// et les essais de LoRA (dossiers, ajout, rangement pour le moteur) se font dans un faux labo sous ce même dossier :
// rien n'est jamais écrit dans le vrai dossier du moteur.
// Réseau : uniquement des GET vers ComfyUI sur 127.0.0.1 (faits par le scanner lui-même).

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { scan, resolveIn, selectable, identify, pickleScan, parseModelPathsYaml, comfyProbe, inspectFile } = require(path.join(ROOT, 'electron', 'scanner.js'));
const R = require(path.join(ROOT, 'electron', 'scanner-rules.js'));

const QUIET = process.argv.includes('--quiet');
const DEV = process.env.MIA_TEST_DIR ? path.resolve(process.env.MIA_TEST_DIR) : path.join(ROOT, '_dev', 'fix-C', 'test');
const CACHE = path.join(DEV, 'models-cache.test.json');
const ORACLE = path.join(ROOT, '_plan', 'models_inventory.json');
const ENGINE_ROOT = process.env.MIA_ENGINE_ROOT || 'D:/AI_Local_Videos';

let failures = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures++; console.log('  ÉCHEC  ' + msg); } else if (!QUIET) console.log('  ok     ' + msg); };
const log = (...a) => { if (!QUIET) console.log(...a); };
const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);

async function timed(fn) { const t = process.hrtime.bigint(); const r = await fn(); return [r, Number(process.hrtime.bigint() - t) / 1e6]; }

// --- 1. lecteurs : fichiers synthétiques (GGUF, pickle, yaml) -----------------------------------
async function testReaders() {
  console.log('\n# Lecteurs de formats (fichiers synthétiques)');
  fs.mkdirSync(DEV, { recursive: true });

  // GGUF v3 minimal : 3 clés (dont un tableau de chaînes du tokenizer, qui doit être sauté) + 2 tenseurs.
  const parts = [];
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const str = (s) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
  parts.push(Buffer.from('GGUF'), u32(3), u64(2), u64(3));
  parts.push(str('general.architecture'), u32(8), str('llama'));
  parts.push(str('general.file_type'), u32(4), u32(15));                     // Q4_K_M
  parts.push(str('tokenizer.ggml.tokens'), u32(9), u32(8), u64(3), str('a'), str('b'), str('c'));
  parts.push(str('blk.0.attn_q.weight'), u32(2), u64(4096), u64(4096), u32(12), u64(0));
  parts.push(str('token_embd.weight'), u32(2), u64(4096), u64(128256), u32(12), u64(0));
  const gg = path.join(DEV, 'synthetic.gguf');
  fs.writeFileSync(gg, Buffer.concat([...parts, Buffer.alloc(4096)]));
  const gi = await identify(gg, fs.statSync(gg).size, 'synthetic.gguf');
  ok(gi && gi.format === 'gguf' && gi.gguf_arch === 'llama' && gi.quant === 'Q4_K_M', `GGUF : architecture et précision lues (${gi && gi.gguf_arch}, ${gi && gi.quant})`);
  ok(gi && gi.params === 4096 * 4096 + 4096 * 128256, 'GGUF : paramètres recomptés depuis les formes');

  // Pickle protocole 2 façon torch : clé de tenseur, stockage FloatStorage, numel après « cpu ».
  const pk = Buffer.concat([
    Buffer.from([0x80, 0x02, 0x7d, 0x71, 0x00, 0x28]),
    Buffer.from([0x58]), u32(20), Buffer.from('blocks.0.attn.weight'),
    Buffer.from([0x63]), Buffer.from('torch\nFloatStorage\n'),
    Buffer.from([0x58]), u32(3), Buffer.from('cpu'), Buffer.from([0x71, 0x01]),
    Buffer.from([0x4a]), (() => { const b = Buffer.alloc(4); b.writeInt32LE(4096); return b; })(),
    Buffer.from([0x68, 0x01, 0x4b, 0x10, 0x74, 0x75, 0x2e]),   // BINGET 'cpu', BININT1 16 → numel, TUPLE, SETITEMS, STOP
  ]);
  const ps = pickleScan(pk);
  ok(ps.keys.length === 1 && ps.storages.get('FloatStorage') === 1, 'pickle : clé et type de stockage trouvés sans exécution');
  ok(ps.numel === 4096 + 16, `pickle : numel suivi à travers la mémoïsation (${ps.numel})`);

  // extra_model_paths : sections, valeurs entre quotes, blocs « |- ».
  const y = path.join(DEV, 'synthetic.yaml');
  fs.writeFileSync(y, "a:\n  base_path: 'C:\\X\\models'\n  is_default: true\n  'loras': 'loras/'\n  controlnet: |-\n    controlnet/\n    t2i_adapter/\n");
  const ys = await parseModelPathsYaml(y);
  ok(ys.length === 1 && ys[0].basePath === 'C:/X/models' && ys[0].folders.controlnet.length === 2 && ys[0].folders.loras[0] === 'C:/X/models/loras',
    'yaml : base_path et dossiers (bloc multi-lignes) compris');
}

// --- 2. scans à froid et à chaud --------------------------------------------------------------
async function testScans() {
  console.log('\n# Scans (racine du labo : ' + ENGINE_ROOT + ')');
  try { fs.unlinkSync(CACHE); } catch { /* pas encore de cache */ }
  const [cold, coldMs] = await timed(() => scan({ engineRoot: ENGINE_ROOT, cachePath: CACHE, force: true }));
  const warmTimes = [];
  let warm;
  for (let i = 0; i < 3; i++) { const [w, ms] = await timed(() => scan({ engineRoot: ENGINE_ROOT, cachePath: CACHE })); warm = w; warmTimes.push(ms); }
  warmTimes.sort((a, b) => a - b);
  const s = cold.inventory.stats, w = warm.inventory.stats;
  console.log(`  à froid : ${coldMs.toFixed(0)} ms (${s.files} fichiers, ${s.misses} identifiés, parcours ${s.walkMs} ms, identification ${s.identifyMs} ms, ComfyUI ${s.comfyMs} ms)`);
  console.log(`  à chaud : médiane ${warmTimes[1].toFixed(0)} ms (min ${warmTimes[0].toFixed(0)}, ${w.hits} depuis le cache, ${w.misses} relus)`);
  console.log(`  ComfyUI : ${warm.inventory.comfy.reachable ? 'joignable, version ' + warm.inventory.comfy.version : 'éteint (disposition prédite)'}`);
  ok(w.misses === 0, 'à chaud, aucun fichier relu');
  ok(warmTimes[1] < 300, `démarrage à chaud sous 300 ms (${warmTimes[1].toFixed(0)} ms)`);
  ok(JSON.stringify(cold.inventory.models.map((m) => [m.id, m.status, m.caps])) === JSON.stringify(warm.inventory.models.map((m) => [m.id, m.status, m.caps])),
    'froid et chaud donnent le même inventaire');
  // Le cache se relit tel quel (format de models-cache.json).
  const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  ok(c.version && c.files && c.inventory && Object.keys(c.files).length >= s.files, `cache écrit (${(fs.statSync(CACHE).size / 1024).toFixed(0)} Ko, ${Object.keys(c.files).length} entrées)`);
  // ComfyUI éteint (ou ignoré) : la liste doit rester utilisable grâce à la disposition prédite.
  const off = await scan({ engineRoot: ENGINE_ROOT, cachePath: CACHE, writeCache: false, comfy: false });
  ok(off.inventory.capabilities['image-to-video'].available && off.inventory.capabilities.depth.available,
    'ComfyUI éteint : les capacités restent disponibles (disposition prédite)');
  return { cold, warm };
}

// --- 3. comparaison avec l'oracle Python ----------------------------------------------------
function compareOracle(records) {
  console.log('\n# Comparaison avec l\'oracle Python (_plan/models_inventory.json)');
  if (!fs.existsSync(ORACLE)) { console.log('  (oracle absent : comparaison sautée)'); return; }
  const oracle = JSON.parse(fs.readFileSync(ORACLE, 'utf8'));
  const mine = new Map(records.map((r) => [r.path.toLowerCase(), r]));
  const FIELDS = ['family', 'role', 'rule', 'variant', 'quant', 'params', 'rank', 'fingerprint', 'format'];
  let same = 0, diff = 0, onlyPy = 0;
  const diffs = [];
  for (const f of oracle.files) {
    const r = mine.get(f.path.toLowerCase());
    if (!r) { onlyPy++; if (!QUIET) console.log(`  seulement dans l'oracle : ${f.path}${f.partial ? ' (partiel)' : ''}`); continue; }
    const bad = FIELDS.filter((k) => (f[k] ?? null) !== (r[k] ?? null) && !(f[k] == null && r[k] == null));
    if (bad.length) { diff++; diffs.push(`${f.path}\n      ` + bad.map((k) => `${k}: py=${JSON.stringify(f[k])} node=${JSON.stringify(r[k])}`).join(' ; ')); }
    else same++;
  }
  const pyPaths = new Set(oracle.files.map((f) => f.path.toLowerCase()));
  const onlyNode = records.filter((r) => !pyPaths.has(r.path.toLowerCase()));
  for (const d of diffs) console.log('  ÉCART  ' + d);
  for (const r of onlyNode) log(`  seulement dans Node : ${r.path}`);
  console.log(`  ${same} fichiers identiques sur ${FIELDS.length} champs, ${diff} écarts, ${onlyPy} seulement dans l'oracle (recherche large), ${onlyNode.length} seulement dans Node`);
  ok(diff === 0, 'mêmes familles, rôles, règles, variantes, précisions, paramètres et empreintes que scan_probe.py');
  // Doublons : mêmes groupes que l'oracle (sur les fichiers communs).
  const pyDup = new Set(oracle.duplicates.map((d) => d.paths.map((p) => p.toLowerCase()).sort().join('|')));
  const nodeGroups = new Map();
  for (const r of records) if (r.fingerprint && !r.partial) { const g = nodeGroups.get(r.fingerprint) || []; g.push(r.path.toLowerCase()); nodeGroups.set(r.fingerprint, g); }
  const nodeDup = new Set([...nodeGroups.values()].filter((g) => g.length > 1).map((g) => g.sort().join('|')));
  ok([...pyDup].every((k) => nodeDup.has(k)), `mêmes groupes de doublons (${pyDup.size} dans l'oracle, ${nodeDup.size} ici)`);
}

// --- 4. capacités, défauts, licences ----------------------------------------------------------
function testCapabilities(inv) {
  console.log('\n# Capacités et choix « Auto »');
  const byId = new Map(inv.models.map((m) => [m.id, m]));
  console.log('  ' + pad('capacité', 24) + pad('auto', 34) + pad('fichier', 58) + 'autres choix');
  for (const c of R.CAPS) {
    const cap = inv.capabilities[c.id];
    const d = cap && cap.default ? byId.get(cap.default) : null;
    const others = (cap ? cap.options : []).filter((id) => id !== (d && d.id)).map((id) => byId.get(id).label.fr);
    console.log('  ' + pad(c.id, 24) + pad(d ? d.label.fr : (cap && cap.available ? '(aucun : choix manuel)' : '— absent —'), 34)
      + pad(d ? d.file : '', 58) + others.join(', '));
  }
  for (const m of inv.missing) console.log(`  manque : ${m.caps.join(', ')} → ${m.what.fr}`);

  const key = (k) => inv.models.find((m) => m.key === k && m.status === 'ready');
  const def = (cap) => byId.get(inv.capabilities[cap].default) || {};
  if (key('ltx-int8')) ok(def('image-to-video').key === 'ltx-int8' && def('text-to-video').key === 'ltx-int8', 'vidéo : LTX int8 par défaut sur le portable');
  if (key('ltx-nvfp4')) ok(inv.capabilities['image-to-video'].options.includes(key('ltx-nvfp4').id), 'vidéo : LTX nvfp4 proposé en alternative « RTX 50 »');
  if (key('vda-small')) ok(def('depth').key === 'vda-small', 'profondeur : Video Depth Anything Small par défaut');
  if (key('birefnet')) ok(def('cutout').key === 'birefnet', 'détourage : BiRefNet par défaut');
  if (key('seedvr2-7b')) ok(def('upscale').key === 'seedvr2-7b', 'agrandir : SeedVR2 7B (qualité) par défaut');
  if (key('seedvr2-3b')) ok(inv.capabilities.upscale.fast === key('seedvr2-3b').id, 'agrandir : SeedVR2 3B en variante rapide');
  ok(inv.capabilities.lora.default === null && inv.capabilities.lora.optional, 'LoRA : pas de choix « Auto » (le bloc part de « Aucun »), capacité facultative');
  ok(!inv.missing.some((x) => x.caps.includes('lora')), 'LoRA : jamais listés dans « Il manque »');
  const mm = inv.models.find((m) => m.key === 'minimax');
  if (mm) ok(mm.license === 'rd' && /^Licence propre à MiniMax : lis-la avant un usage commercial/.test(mm.licenseNote.fr)
    && /^MiniMax's own license/.test(mm.licenseNote.en), 'MiniMax H3 : licence R&D, « Licence propre à MiniMax : lis-la avant un usage commercial »');
  const da2 = inv.models.find((m) => m.key === 'da2-large');
  if (da2) ok(da2.license === 'trial' && !da2.caps.includes('depth') && !inv.capabilities.depth.options.includes(da2.id),
    'Depth Anything V2 Large : jamais proposé pour la profondeur (le bloc ne sait pas s\'en servir)');
  ok(inv.models.every((m) => m.status !== 'ready' || m.license !== 'forbidden'), 'aucun modèle interdit n\'est « prêt »');
  ok(inv.summary.ready === inv.models.filter((m) => m.status === 'ready' && !m.hidden).length
    && Math.abs(inv.summary.miaGB + inv.summary.appsGB - inv.summary.sizeGB) < 0.1,
    `compte des prêts et tailles séparées (${inv.summary.ready} prêts, ${inv.summary.miaGB} Go pour Mia, ${inv.summary.appsGB} Go d'autres applis)`);
  const ltx = key('ltx-int8');
  if (ltx) ok(ltx.baseKey === 'ltx', 'modèle de base : LTX porte baseKey « ltx »');
  const idents = inv.models.filter((m) => m.identity && m.status === 'ready');
  ok(idents.every((m) => m.caps.includes('lora') && m.loraFor === 'ltx' && m.origin === 'engine' && m.placed && m.group === 'loras'),
    'LoRA du labo : capacité « lora », pour LTX, origine moteur, nom ComfyUI connu, section « Mes LoRA »');
  ok(inv.models.filter((m) => m.role === 'lora' && m.hidden).every((m) => !m.caps.includes('lora') && ['control', 'technical'].includes(m.loraKind)),
    'LoRA techniques (modes, accélérateurs) : jamais proposés dans « Personnage ou lieu »');
  if (key('ltx-union')) ok(inv.capabilities['guided-video'].available && def('guided-video').key === 'ltx-int8', 'vidéo guidée : LTX + mode Union-Control par défaut');
  if (key('minimax') && key('minimax-control')) ok(inv.capabilities['guided-video'].options.includes(key('minimax').id), 'vidéo guidée : MiniMax + guidage en alternative');
  const r2v = key('minimax-ref2v');
  if (r2v) ok(def('reference-to-video').key === 'minimax-ref2v' && !inv.capabilities['image-to-video'].options.includes(r2v.id),
    'références : MiniMax « Reference to Video » seul, jamais pris pour « Animer une image »');
  const ids = inv.models.filter((m) => m.identity && m.status === 'ready').map((m) => m.identity).sort();
  log(`  LoRA d'identité prêtes : ${ids.join(', ') || 'aucune'}`);
  ok(inv.models.filter((m) => m.hidden).every((m) => m.group === 'internal'), 'pièces internes (encodeurs, VAE, LoRA techniques) cachées et regroupées');
}

function testForbidden(inv) {
  console.log('\n# Licences interdites : jamais proposées');
  // Faux modèles interdits injectés dans une copie de l'inventaire, « prêts » et dans la bonne capacité.
  const fake = [
    { key: 'vda-forbidden', file: 'video_depth_anything_vitl.pth', caps: ['depth'] },
    { key: 'matanyone', file: 'matanyone.safetensors', caps: ['cutout'] },
    { key: 'hunyuan', file: 'hunyuan_video_t2v.safetensors', caps: ['text-to-video', 'image-to-video'] },
  ].map((f, i) => ({ id: 'fake' + i, path: 'D:/x/' + f.file, file: f.file, key: f.key, caps: f.caps, default: [], status: 'ready',
    license: 'forbidden', engine: 'worker', comfy: null, label: { fr: f.file, en: f.file }, sizeGB: 1, quality: 3 }));
  const inv2 = { ...inv, models: [...fake, ...inv.models] };
  const forb = inv2.models.filter((m) => m.license === 'forbidden');
  let leaks = 0;
  for (const m of forb) {
    for (const c of [...R.CAPS.map((x) => x.id), undefined]) {
      if (resolveIn(inv2, m.id, c ? [c] : []) !== null) leaks++;
      if (resolveIn(inv2, m.file, c ? [c] : []) !== null) leaks++;
    }
  }
  for (const c of R.CAPS) {
    const auto = resolveIn(inv2, 'auto', [c.id]);
    if (auto && auto.license === 'forbidden') leaks++;
    if (inv.capabilities[c.id].options.some((id) => inv2.models.find((m) => m.id === id).license === 'forbidden')) leaks++;
    if (inv2.models.filter((m) => selectable(m, [c.id])).some((m) => m.license === 'forbidden')) leaks++;
  }
  ok(leaks === 0, `${forb.length} modèles interdits (dont ${forb.length - fake.length} réels) : aucun renvoyé par resolve(), « Auto » ni les listes`);
  ok(resolveIn(inv, 'none', ['lora']) === null, "resolve('none') → aucun modèle");
  ok(resolveIn(inv, 'id-inconnu', ['depth']) === null, 'resolve(id inconnu) → null');
  const other = inv.models.find((m) => m.status === 'other-app');
  if (other) ok(resolveIn(inv, other.id, []) === null, 'un modèle d\'une autre application n\'est jamais résolu');
  const dup = inv.models.find((m) => m.status === 'duplicate');
  if (dup) ok(resolveIn(inv, dup.id, []) === null, 'un doublon n\'est jamais résolu (on passe par l\'original)');
}

// --- 5. ComfyUI simulé : lancé sans extra_minimax.yaml, puis sans l'encodeur de texte de LTX ---------
async function testComfyScenarios() {
  console.log('\n# Scénarios ComfyUI simulés (aucune requête, état injecté)');
  const live = await comfyProbe('http://127.0.0.1:8188');
  const base = live.reachable ? live : {
    reachable: true, url: 'http://127.0.0.1:8188', version: 'simulé', folders: {}, listed: [],
    argv: ['main.py', '--models-directory', `${ENGINE_ROOT}/models`, '--extra-model-paths-config', `${ENGINE_ROOT}/config/extra_minimax.yaml`],
  };
  const lab = `${ENGINE_ROOT}/models`.replace(/\//g, '\\');
  // Les listes de ComfyUI telles qu'il les donnerait sans le yaml : seulement les fichiers du labo.
  const labOnly = async () => {
    const out = {};
    for (const [f, list] of Object.entries(base.folders || {})) {
      out[f] = list.filter((n) => fs.existsSync(path.join(lab, f === 'seedvr2' ? 'SEEDVR2' : f, n)));
    }
    return out;
  };
  // a) sans extra_minimax.yaml
  const noYaml = { ...base, argv: (base.argv || []).filter((a, i, all) => a !== '--extra-model-paths-config' && all[i - 1] !== '--extra-model-paths-config'), folders: await labOnly() };
  const a = (await scan({ engineRoot: ENGINE_ROOT, cachePath: CACHE, writeCache: false, comfy: noYaml })).inventory;
  const mm = a.models.find((m) => m.key === 'minimax');
  if (mm) {
    ok(mm.status === 'unused' && /extra_minimax/.test(mm.statusNote?.fr || ''), 'sans extra_minimax.yaml : MiniMax H3 non proposé, avec la raison');
    ok(!a.capabilities['image-to-video'].options.includes(mm.id) && a.capabilities['image-to-video'].available, 'sans extra_minimax.yaml : « Animer une image » reste servi par LTX');
  }
  // b) l'encodeur de texte de LTX a disparu de ComfyUI
  const te = a.models.find((m) => m.key === 'ltx-te');
  if (te && te.comfy) {
    const noTe = { ...noYaml, folders: { ...noYaml.folders, text_encoders: (noYaml.folders.text_encoders || []).filter((n) => n !== te.comfy.name) } };
    const b = (await scan({ engineRoot: ENGINE_ROOT, cachePath: CACHE, writeCache: false, comfy: noTe })).inventory;
    const ltx = b.models.find((m) => m.key === 'ltx-int8');
    ok(ltx && ltx.status === 'incomplete' && ltx.missingParts.length === 1, 'sans encodeur de texte : LTX passe « incomplet » et dit ce qui manque');
    ok(ltx && /gemma4-12b/.test(ltx.statusNote.fr) && /text_encoders/.test(ltx.statusNote.fr), `le message donne le fichier et le dossier : « ${ltx && ltx.statusNote.fr} »`);
    const miss = b.missing.find((x) => x.caps.includes('text-to-video'));
    ok(!!miss && /incomplet/.test(miss.what.fr), `capacité manquante expliquée : « ${miss ? miss.what.fr : '—'} »`);
    ok(resolveIn(b, 'auto', ['text-to-video']) === null, 'resolve(auto) ne renvoie jamais un moteur incomplet');
  }
}

// --- 5 bis. LoRA (SPEC §12) : fichiers synthétiques, faux labo, registre, rangement pour le moteur -------
// Un faux LoRA LTX au format safetensors : clés kohya/diffusers, rang 16, largeur 4096, métadonnées kohya.
function fakeLora(file, { width = 4096, rank = 16, blocks = 2, meta = {}, fill = 1 } = {}) {
  const tensors = {};
  let off = 0;
  const add = (name, shape) => {
    const n = shape.reduce((a, b) => a * b, 1) * 2;
    tensors[name] = { dtype: 'BF16', shape, data_offsets: [off, off + n] };
    off += n;
  };
  for (let b = 0; b < blocks; b++) {
    for (const at of ['attn1', 'attn2']) {
      for (const pr of ['to_q', 'to_k']) {
        add(`diffusion_model.transformer_blocks.${b}.${at}.${pr}.lora_A.weight`, [rank, width]);
        add(`diffusion_model.transformer_blocks.${b}.${at}.${pr}.lora_B.weight`, [width, rank]);
      }
    }
  }
  const header = Buffer.from(JSON.stringify({ __metadata__: meta, ...tensors }));
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(header.length));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([len, header, Buffer.alloc(off, fill)]));
}
// Un faux « modèle complet » (pas un LoRA) : de simples poids, plus de 1 Mo.
function fakeModel(file) {
  const tensors = {};
  let off = 0;
  for (let b = 0; b < 4; b++) for (const k of ['attn1.to_q', 'attn1.to_k', 'attn2.to_q', 'attn2.to_k']) {
    const n = 256 * 1024;
    tensors[`transformer_blocks.${b}.${k}.weight`] = { dtype: 'BF16', shape: [256, 512], data_offsets: [off, off + n] };
    off += n;
  }
  const header = Buffer.from(JSON.stringify(tensors));
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(header.length));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([len, header, Buffer.alloc(off, 3)]));
}

async function testLoras() {
  console.log('\n# LoRA : inspection, dossiers, ajout, rangement pour le moteur, retrait (faux labo)');
  const { ModelService } = require(path.join(ROOT, 'electron', 'scanner.js'));
  const base = path.join(DEV, 'loras-test');
  fs.rmSync(base, { recursive: true, force: true });
  const kohya = (name, trig) => ({ ss_output_name: name, ss_tag_frequency: JSON.stringify({ img: { [trig]: 40, smile: 3 } }) });
  const lora1 = path.join(base, 'drop', 'testa_ltx25_02000.safetensors');
  const lora2 = path.join(base, 'drop', 'ville_lora.safetensors');
  const lora3 = path.join(base, 'mes-loras', 'perso', 'style_film_v2.safetensors');
  const notLora = path.join(base, 'mes-loras', 'gros_modele.safetensors');
  const junk = path.join(base, 'drop', 'pas_un_modele.safetensors');
  fakeLora(lora1, { meta: kohya('testa_ltx25', 'tst woman'), fill: 1 });
  fakeLora(lora2, { meta: {}, fill: 2 });
  fakeLora(lora3, { meta: { 'modelspec.trigger_phrase': 'film look' }, fill: 4 });
  fakeModel(notLora);
  fs.writeFileSync(junk, 'pas un fichier de poids');

  // a) inspection seule, contre le vrai labo (lecture seule) : famille LTX 2.5 déduite comme dans le scan
  const realInv = (await scan({ engineRoot: ENGINE_ROOT, cachePath: CACHE, writeCache: false, comfy: false })).inventory;
  const i1 = await inspectFile(lora1, { inventory: realInv, engineRoot: ENGINE_ROOT });
  ok(i1.ok && i1.isLora && i1.loraFor === 'ltx' && i1.familyLabel.fr === 'LTX 2.5 (vidéo)', `inspect : LoRA reconnu, « Fait pour ${i1.familyLabel && i1.familyLabel.fr} »`);
  ok(i1.suggestedName === 'Testa' && i1.suggestedTrigger === 'tst woman' && i1.kindGuess === 'character',
    `inspect : nom « ${i1.suggestedName} », déclencheur « ${i1.suggestedTrigger} » lu dans les métadonnées, genre ${i1.kindGuess}`);
  const i2 = await inspectFile(notLora, { inventory: realInv, engineRoot: ENGINE_ROOT });
  ok(i2.ok && !i2.isLora && i2.reason && /pas un LoRA|non reconnu/.test(i2.reason.fr), `inspect : un fichier qui n'est pas un LoRA → « ${i2.reason && i2.reason.fr.slice(0, 60)}… »`);
  const i3 = await inspectFile(junk, { inventory: realInv });
  ok(i3.ok && !i3.isLora && !!i3.reason, `inspect : fichier illisible → « ${i3.reason && i3.reason.fr} »`);
  // un LoRA de personnage ou de lieu déjà connu du vrai labo, s'il y en a un
  const known = realInv.models.find((m) => m.identity && m.status === 'ready');
  if (known) {
    const i4 = await inspectFile(known.path, { inventory: realInv, files: JSON.parse(fs.readFileSync(CACHE, 'utf8')).files, engineRoot: ENGINE_ROOT });
    ok(i4.isLora && i4.already && i4.already.id === known.id, 'inspect : un LoRA déjà dans Mia est reconnu (pas de doublon)');
  }

  // b) dossier de LoRA (réglages) contre le vrai labo : seuls les LoRA y sont retenus
  const inv = (await scan({ engineRoot: ENGINE_ROOT, cachePath: CACHE, writeCache: false, comfy: false, loraFolders: [path.join(base, 'mes-loras')] })).inventory;
  const f3 = inv.models.find((m) => m.path.toLowerCase() === lora3.replace(/\\/g, '/').toLowerCase());
  ok(f3 && f3.origin === 'folder' && f3.status === 'ready' && f3.caps.includes('lora') && f3.loraFor === 'ltx' && f3.trigger === 'film look' && f3.group === 'loras',
    `dossier de LoRA : « ${f3 && f3.label.fr} » prêt, pour LTX, déclencheur lu, section « Mes LoRA »`);
  ok(!inv.models.some((m) => /gros_modele/.test(m.path)), 'dossier de LoRA : un fichier qui n\'est pas un LoRA est ignoré');
  ok(resolveIn(inv, f3 && f3.id, ['lora']) !== null && resolveIn(inv, 'auto', ['lora']) === null, 'resolve : un LoRA choisi est rendu, « Auto » ne choisit jamais de LoRA');

  // c) faux labo : ajout, rangement (lien puis copie), renommage, retrait — le vrai dossier du moteur n'est jamais touché
  const fakeEngine = path.join(base, 'engine');
  fs.mkdirSync(path.join(fakeEngine, 'models', 'loras'), { recursive: true });
  fs.mkdirSync(path.join(fakeEngine, 'models', 'diffusion_models'), { recursive: true });
  const data = path.join(base, 'data');
  fs.mkdirSync(data, { recursive: true });
  const prefs = { engineRoot: fakeEngine, extraModelRoots: [], loraFolders: [path.join(base, 'mes-loras')], comfyUrl: 'http://127.0.0.1:9' };
  const svc = new ModelService({ paths: { data }, prefs: { get: () => prefs }, send: () => {}, logger: () => () => {} });
  svc.loadCacheSync(); svc.loadRegistrySync();
  await svc.scan();
  const add = await svc.addLora({ path: lora1, name: 'Testa', trigger: 'tst woman', kind: 'character' });
  ok(add.ok && add.model && add.model.origin === 'added' && add.model.label.fr === 'Testa' && add.model.status === 'ready' && add.model.trigger === 'tst woman',
    'addLora : entrée « Testa » prête, origine « ajouté », déclencheur gardé');
  const reg = JSON.parse(fs.readFileSync(path.join(data, 'loras.json'), 'utf8'));
  ok(Array.isArray(reg) && reg.length === 1 && reg[0].source && reg[0].kind === 'character' && reg[0].id, 'registre loras.json : [{ id, source, name, trigger, kind, added }]');
  const placedOnce = await svc.ensureLora(add.model.id);
  const target = path.join(fakeEngine, 'models', 'loras', 'mia', 'testa_ltx25_02000.safetensors');
  ok(placedOnce.comfyName === 'mia\\testa_ltx25_02000.safetensors' && fs.existsSync(target) && fs.existsSync(lora1),
    `ensureLora : rangé dans models\\loras\\mia (${placedOnce.linked ? 'lien physique' : 'copie'}), original intact`);
  ok(placedOnce.linked === true, 'ensureLora : même disque → lien physique, aucune place perdue');
  const again = await svc.ensureLora(add.model.id);
  ok(again.comfyName === placedOnce.comfyName && fs.readdirSync(path.dirname(target)).length === 1, 'ensureLora : deuxième appel → même nom, aucun fichier de plus');
  const inv2 = await svc.scan({ queue: true });
  const m1 = inv2.models.find((m) => m.id === add.model.id);
  ok(m1 && m1.placed === placedOnce.comfyName && inv2.models.filter((m) => /testa_ltx25_02000/.test(m.file)).length === 1,
    'scan : la copie de Mia est rattachée à son original (une seule entrée, nom ComfyUI connu)');
  // copie (disque différent simulé) avec progression
  const add2 = await svc.addLora({ path: lora2, name: '', trigger: '', kind: 'place' });
  let lastP = null;
  const m2 = svc.findModel(add2.model.id);
  const copied = await svc.placeLora(m2, { linkFirst: false, onProgress: (p) => { lastP = p; } });
  ok(!copied.linked && lastP === 1 && fs.existsSync(path.join(fakeEngine, 'models', 'loras', 'mia', 'ville_lora.safetensors')),
    'ensureLora : sans lien possible → copie avec progression jusqu\'à 100 %');
  ok(add2.model.label.fr === 'Ville' && add2.model.genre === 'place', `addLora : nom vide → nom tiré du fichier (« ${add2.model.label.fr} »), genre Lieu`);
  const up = await svc.updateLora(add.model.id, { name: 'Testa bis', kind: 'style', trigger: '' });
  ok(up.ok && up.model.label.fr === 'Testa bis' && up.model.genre === 'style' && up.model.loraKind === 'style' && up.model.trigger === null,
    'updateLora : renommer, changer le genre, effacer le déclencheur');
  const owned = svc.inventory && svc.inventory.placements.some((p) => p.toLowerCase() === target.replace(/\\/g, '/').toLowerCase());
  ok(owned, 'les copies rangées par Mia sont connues de l\'inventaire (owns)');
  const rm = await svc.removeLora(add.model.id);
  ok(rm.ok && !fs.existsSync(target) && fs.existsSync(lora1) && !rm.inventory.models.some((m) => m.id === add.model.id),
    'removeLora : entrée et copie retirées, fichier d\'origine intact');
  const f3b = svc.inventory.models.find((m) => m.origin === 'folder');
  const rm3 = f3b ? await svc.removeLora(f3b.id) : { ok: false };
  ok(rm3.ok && fs.existsSync(lora3) && !rm3.inventory.models.some((m) => m.origin === 'folder'),
    'removeLora (dossier de LoRA) : ignoré désormais, fichier intact');
  let threw = null;
  try { await svc.ensureLora('n-existe-pas'); } catch (e) { threw = e; }
  ok(threw && threw.userMessage && /plus dans Mia/.test(threw.message), 'ensureLora : LoRA inconnu → message clair, rien n\'est écrit');
  const outside = fs.readdirSync(path.join(fakeEngine, 'models', 'loras')).filter((n) => n !== 'mia');
  ok(outside.length === 0, 'rien n\'est jamais écrit dans models\\loras hors du sous-dossier mia');

  // d) un labo vide : ce qui manque est dit avec le fichier, le dossier, et la taille à télécharger
  const emptyEngine = path.join(base, 'empty-engine');
  fs.mkdirSync(path.join(emptyEngine, 'models'), { recursive: true });
  const e = (await scan({ engineRoot: emptyEngine, writeCache: false, comfy: false, cache: JSON.parse(fs.readFileSync(CACHE, 'utf8')) })).inventory;
  const r2v = e.missing.find((x) => x.caps.includes('reference-to-video'));
  ok(r2v && r2v.download && r2v.sizeGB === 23 && r2v.files.length === 2 && /ref2va/.test(r2v.files[0].file) && /models\\diffusion_models$/.test(r2v.files[0].dir),
    `références absentes : « ${r2v && r2v.what.fr} » + 2 fichiers et leur dossier`);
  const dep = e.missing.find((x) => x.caps.includes('depth'));
  ok(dep && dep.files[0] && dep.files[0].file === 'video_depth_anything_vits.pth', `profondeur absente : fichier attendu indiqué (« ${dep && dep.what.fr} »)`);
  svc.stop();
}

// --- 6. register(ctx) sans Electron : IPC, ctx.models, cache servi tout de suite ------------------
async function testRegister() {
  console.log('\n# register(ctx) avec un faux contexte');
  const { register } = require(path.join(ROOT, 'electron', 'scanner.js'));
  const data = path.join(DEV, 'fake-data');
  fs.mkdirSync(data, { recursive: true });
  fs.copyFileSync(CACHE, path.join(data, 'models-cache.json'));
  const handlers = {}, sent = [];
  const ctx = {
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    send: (ch, p) => sent.push(ch),
    paths: { data },
    prefs: { get: () => ({ engineRoot: ENGINE_ROOT, extraModelRoots: [], comfyUrl: 'http://127.0.0.1:8188' }), onChange: () => {} },
  };
  const t0 = process.hrtime.bigint();
  const svc = register(ctx);
  const first = await handlers['models:list']();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  ok(first && Array.isArray(first.models) && first.models.length > 0, `models:list servi depuis le cache en ${ms.toFixed(0)} ms`);
  ok(ms < 300, 'liste disponible en moins de 300 ms au démarrage');
  const fresh = await handlers['models:scan'](null, {});
  ok(fresh && Array.isArray(fresh.models) && sent.includes('models:update'), 'models:scan renvoie un inventaire frais et pousse models:update');
  const arr = ctx.models.list();
  ok(Array.isArray(arr) && arr.inventory === fresh, 'ctx.models.list() : tableau des modèles (+ .inventory)');
  const d = ctx.models.resolve('auto', ['depth']);
  ok(!d || d.license !== 'forbidden', `ctx.models.resolve('auto', ['depth']) → ${d ? d.file : 'aucun'}`);
  const some = fresh.models.find((m) => m.status === 'other-app') || fresh.models[0];
  ok(ctx.models.owns(some.path) && !ctx.models.owns('C:/Windows/notepad.exe'), 'ctx.models.owns() reconnaît les chemins de l\'inventaire, et eux seuls');
  const app = (fresh.apps || [])[0];
  if (app) ok(ctx.models.owns(app.root), 'ctx.models.owns() accepte le dossier d\'une autre application listée');
  ok(['models:inspect', 'models:addLora', 'models:updateLora', 'models:removeLora'].every((c) => typeof handlers[c] === 'function')
    && typeof ctx.models.ensureLora === 'function', 'IPC des LoRA enregistrés, ctx.models.ensureLora exposé');
  const bad = await handlers['models:inspect'](null, 'C:/nexiste/pas.safetensors');
  ok(bad && bad.ok === false && /introuvable/.test(bad.error), `models:inspect sur un fichier absent → « ${bad && bad.error} »`);
  svc.stop();
}

(async () => {
  console.log('Mia — banc d\'essai du scanner de modèles');
  await testReaders();
  const { warm } = await testScans();
  compareOracle(warm.records);
  testCapabilities(warm.inventory);
  testForbidden(warm.inventory);
  await testComfyScenarios();
  await testLoras();
  await testRegister();
  const inv = warm.inventory;
  console.log(`\n# Bilan : ${inv.summary.ready} modèles prêts (${inv.models.length} entrées, ${inv.summary.sizeGB} Go), `
    + `${inv.partials.length} téléchargements interrompus, ${inv.duplicates.length} groupes de doublons, `
    + `${inv.apps.map((a) => `${a.name} ${a.models}`).join(', ')}`);
  console.log(`${checks - failures}/${checks} vérifications réussies${failures ? ` — ${failures} ÉCHEC(S)` : ''}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('Erreur du banc d\'essai :', e); process.exit(2); });
