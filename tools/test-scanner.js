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
// L'oracle vit hors du dépôt, dans le dossier de travail de l'auteur (Recherche\Scanner, à côté du clone) ; MIA_SCANNER_ORACLE pour en changer.
const ORACLE = process.env.MIA_SCANNER_ORACLE ? path.resolve(process.env.MIA_SCANNER_ORACLE) : path.join(ROOT, '..', 'Recherche', 'Scanner', 'models_inventory.json');
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
  console.log('\n# Comparaison avec l\'oracle Python (Recherche/Scanner/models_inventory.json)');
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
  // fiche de conseils <nom>.mia.json (mot déclencheur, force conseillée, aide) : elle passe avant les métadonnées
  // dossier à part : le banc de retrait compte les LoRA de « mes-loras »
  const lora4 = path.join(base, 'conseils', 'style_conseil.safetensors');
  fakeLora(lora4, { meta: { 'modelspec.trigger_phrase': 'ancien mot' }, fill: 5 });
  fs.writeFileSync(lora4.replace(/\.safetensors$/, '.mia.json'), JSON.stringify({ trigger: 'qntncls style', strength: 0.85,
    advice: { fr: 'Paysages : 1,0', en: 'Landscapes: 1.0' } }));
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
  const inv4 = (await scan({ engineRoot: ENGINE_ROOT, cachePath: CACHE, writeCache: false, comfy: false, loraFolders: [path.join(base, 'conseils')] })).inventory;
  const f4 = inv4.models.find((m) => m.path.toLowerCase() === lora4.replace(/\\/g, '/').toLowerCase());
  ok(f4 && f4.trigger === 'qntncls style' && f4.strength === 0.85 && f4.advice && f4.advice.fr === 'Paysages : 1,0',
    'fiche de conseils <nom>.mia.json : mot déclencheur, force conseillée et aide lus');
  const lora5 = path.join(base, 'conseils', 'style_vide.safetensors');
  fakeLora(lora5, { meta: { 'modelspec.trigger_phrase': 'ancien mot' }, fill: 6 });
  fs.writeFileSync(lora5.replace(/\.safetensors$/, '.mia.json'), JSON.stringify({ trigger: 'mot de la fiche', strength: null }));
  const inv5 = (await scan({ engineRoot: ENGINE_ROOT, cachePath: CACHE, writeCache: false, comfy: false,
    loras: [{ id: 'l_vide', source: lora5, name: 'Vide', kind: 'style', trigger: '', origin: 'added' }] })).inventory;
  const f5 = inv5.models.find((m) => m.path.toLowerCase() === lora5.replace(/\\/g, '/').toLowerCase());
  ok(f5 && f5.trigger === 'mot de la fiche' && f5.strength == null,
    `fiche de conseils : un mot vide à l'ajout laisse celui de la fiche (« ${f5 && f5.trigger} »), force « null » ignorée`);
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

// --- 5 ter. LoRA entraînés dans Mia (CONCEPTION-entrainement §4.6, cas 23 et 24) : fiche <nom>.mia.json écrite par
// electron/trainer.js addToLoras, rangés dans models\loras\mia d'un faux labo — rien n'est écrit dans le vrai moteur,
// et la « corbeille » est un dossier du banc (ctx.trashItem) : rien ne part dans celle de Windows.
async function testTrainedLoras() {
  console.log('\n# LoRA entraînés dans Mia : fiche, « entraîné ici », étapes, retrait (faux labo)');
  const { ModelService } = require(path.join(ROOT, 'electron', 'scanner.js'));
  const base = path.join(DEV, 'loras-trained');
  fs.rmSync(base, { recursive: true, force: true });
  const engine = path.join(base, 'engine');
  const mia = path.join(engine, 'models', 'loras', 'mia');
  fs.mkdirSync(path.join(engine, 'models', 'diffusion_models'), { recursive: true });
  const card = (file, o) => fs.writeFileSync(file.replace(/\.safetensors$/, '.mia.json'), JSON.stringify(o, null, 1));
  const training = (o) => ({ id: 't_rosa01', base: 'ltx25', tool: 'ltx-trainer 1.6.2', steps: 2500, step: 2500, images: 32, rank: 32, date: '2026-11-19', ...o });
  const rosaCard = (step) => ({ name: 'Rosa', kind: 'character', trigger: 'rsa woman', strength: 1.0,
    advice: { fr: 'Entraîné dans Mia sur LTX 2.5.', en: 'Trained in Mia on LTX 2.5.' }, training: training({ step }) });
  // a) le point final et une étape intermédiaire du même entraînement, rangés par Mia
  const final = path.join(mia, 'Rosa_ltx25_02500.safetensors');
  const step1k = path.join(mia, 'Rosa_ltx25_01000.safetensors');
  fakeLora(final, { fill: 11 }); card(final, rosaCard(2500));
  fakeLora(step1k, { fill: 12 }); card(step1k, rosaCard(1000));
  // b) un LoRA de models\loras\mia SANS fiche : ni « entraîné ici », ni étape (le nom finit par 02000 : ignoré)
  const bare = path.join(mia, 'Mara_ltx25_02000.safetensors');
  fakeLora(bare, { fill: 13 });
  // c) une fiche d'entraînement abîmée (pas pas entiers) : rien d'entraîné, le nom de la fiche reste lu
  const broken = path.join(mia, 'Abime_ltx25_00500.safetensors');
  fakeLora(broken, { fill: 14 }); card(broken, { name: 'Abîmé', kind: 'place', training: { id: 't_x', steps: 'beaucoup', step: 500 } });
  // d) un LoRA dont le fichier ne dit pas pour quel modèle il a été fait (clés kohya génériques, largeur inconnue, nom
  //    sans indice) : la base de la fiche
  const odd = path.join(mia, 'Atelier_03000.safetensors');
  {
    const tensors = {};
    let off = 0;
    const add = (n, shape) => { const k = shape.reduce((a, b) => a * b, 1) * 2; tensors[n] = { dtype: 'BF16', shape, data_offsets: [off, off + k] }; off += k; };
    for (let b = 0; b < 16; b++) { add(`lora_unet_blocks_${b}_proj.lora_down.weight`, [16, 1234]); add(`lora_unet_blocks_${b}_proj.lora_up.weight`, [1234, 16]); }
    const h = Buffer.from(JSON.stringify({ __metadata__: {}, ...tensors }));
    const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(h.length));
    fs.writeFileSync(odd, Buffer.concat([len, h, Buffer.alloc(off, 15)]));
  }
  card(odd, { name: 'Atelier', kind: 'place', trigger: 'atl studio', training: training({ id: 't_atl', base: 'qwen21', steps: 3000, step: 3000 }) });
  // d bis) une LoRA LTX ambiguë (aucun LTX-2 dans ce faux labo, aucun indice dans le nom) : sans fiche « LTX-Video 0.9 »,
  //        avec une fiche d'entraînement LTX 2.5, pour LTX 2.5
  const amb = path.join(mia, 'Nina_02500.safetensors');
  const ambBare = path.join(mia, 'Nora_02500.safetensors');
  fakeLora(amb, { fill: 21 }); card(amb, { name: 'Nina', kind: 'character', training: training({ id: 't_nina' }) });
  fakeLora(ambBare, { fill: 22 });
  // e) une fiche d'entraînement recopiée hors du dossier de Mia (dossier de LoRA de l'utilisateur) : l'entraînement et
  //    l'étape sont lus (« quelle que soit l'origine »), mais ce n'est pas un LoRA rangé par Mia
  const elsewhereDir = path.join(base, 'mes-loras');
  const elsewhere = path.join(elsewhereDir, 'Rosa_ltx25_01500.safetensors');
  fakeLora(elsewhere, { fill: 16 }); card(elsewhere, rosaCard(1500));
  // f) le même contenu qu'un LoRA de l'utilisateur : un LoRA entraîné n'est jamais pris pour la copie de rangement
  const twinSrc = path.join(elsewhereDir, 'jumeau.safetensors');
  const twin = path.join(mia, 'Jumeau_ltx25_02000.safetensors');
  fakeLora(twinSrc, { fill: 17 }); fakeLora(twin, { fill: 17 });
  card(twin, { name: 'Jumeau', kind: 'style', training: training({ id: 't_jum', steps: 2000, step: 2000 }) });
  // g) la logique d'avant Mia : dossier d'entraînement (origine « training »), numéro lu dans le nom du fichier
  const old = path.join(engine, 'personnages', 'testa', 'lora', 'testa_ltx25_01500.safetensors');
  fakeLora(old, { fill: 18 });
  // h) une Mia de test range les siens dans <userData>\loras-mia (electron/trainer.js lorasDir)
  const testDir = path.join(base, 'userdata', 'loras-mia');
  const testFile = path.join(testDir, 'Lena_fake_00300.safetensors');
  fakeLora(testFile, { fill: 19 }); card(testFile, { name: 'Lena', kind: 'character', trigger: 'lna woman', training: training({ id: 't_lena', base: 'fake', steps: 300, step: 300 }) });

  const bin = path.join(base, 'corbeille');
  fs.mkdirSync(bin, { recursive: true });
  const binned = [];
  const trashItem = async (abs) => { const to = path.join(bin, path.basename(abs)); fs.renameSync(abs, to); binned.push(abs); };
  const data = path.join(base, 'data');
  fs.mkdirSync(data, { recursive: true });
  const prefs = { engineRoot: engine, extraModelRoots: [], loraFolders: [elsewhereDir], comfyUrl: 'http://127.0.0.1:9' };
  const svc = new ModelService({ paths: { data }, prefs: { get: () => prefs }, send: () => {}, logger: () => () => {}, trashItem, miaLoraDirs: [testDir] });
  svc.loadCacheSync(); svc.loadRegistrySync();
  const inv = await svc.scan();
  const find = (f) => inv.models.find((m) => m.path.toLowerCase() === f.replace(/\\/g, '/').toLowerCase());
  const mF = find(final), mS = find(step1k), mB = find(bare), mX = find(broken), mO = find(odd), mE = find(elsewhere), mT = find(twin), mOld = find(old), mL = find(testFile);

  ok(mF && mF.trainedHere === true && mF.label.fr === 'Rosa' && mF.label.en === 'Rosa' && mF.genre === 'character' && mF.trigger === 'rsa woman'
    && mF.origin === 'engine' && mF.group === 'loras' && mF.trainingStep == null,
    `point final : « ${mF && mF.label.fr} », entraîné ici, personnage, « rsa woman » lu dans la fiche, aucune étape`);
  ok(mF && mF.training && mF.training.id === 't_rosa01' && mF.training.steps === 2500 && mF.training.step === 2500 && mF.training.base === 'ltx25'
    && mF.training.images === 32 && mF.training.date === '2026-11-19', 'point final : l’entraînement de la fiche est recopié dans l’entrée (id, base, pas, images, date)');
  ok(mF && mF.loraFor === 'ltx' && mF.caps.includes('lora'), 'point final : pour LTX (lu dans le fichier), proposé comme LoRA');
  ok(mF && mF.license === 'ok' && mF.licenseNote.fr === 'Entraîné par toi.' && mB && mB.licenseNote.fr === 'Licence non vérifiée.',
    'licence : « Entraîné par toi. » pour un LoRA entraîné ici, « Licence non vérifiée. » sans fiche');
  ok(mS && mS.trainedHere === true && mS.trainingStep === 1000 && /^Rosa · étape 1\s000$/.test(mS.label.fr) && mS.label.en === 'Rosa · step 1,000',
    `étape intermédiaire : « ${mS && mS.label.fr} » / « ${mS && mS.label.en} », trainingStep 1000`);
  ok(mB && !mB.trainedHere && mB.training == null && mB.trainingStep == null && !/étape/.test(mB.label.fr),
    `models\\loras\\mia sans fiche : « ${mB && mB.label.fr} », ni entraîné ici, ni étape`);
  ok(mX && !mX.trainedHere && mX.training == null && mX.label.fr === 'Abîmé' && mX.genre === 'place' && mX.trainingStep == null,
    'fiche d’entraînement abîmée : rien d’entraîné ni d’étape, son nom et son genre restent lus');
  ok(mO && mO.trainedHere && mO.loraFor === 'qwen21' && mO.label.fr === 'Atelier' && mO.genre === 'place',
    `fichier muet sur son modèle : la base de la fiche (qwen21 → « ${mO && mO.loraFor} »)`);
  const mA = find(amb), mAB = find(ambBare);
  ok(mAB && mAB.loraFor === 'ltxv' && mA && mA.loraFor === 'ltx' && mA.loraForLabel && mA.loraForLabel.fr === 'LTX 2.5',
    `LoRA LTX ambiguë : sans fiche « ${mAB && mAB.loraFor} », avec une fiche d’entraînement LTX 2.5 « ${mA && mA.loraFor} »`);
  ok(mE && !mE.trainedHere && mE.training && mE.training.id === 't_rosa01' && mE.trainingStep === 1500 && /^Rosa · étape 1\s500$/.test(mE.label.fr) && mE.origin === 'folder',
    `fiche recopiée hors du dossier de Mia : « ${mE && mE.label.fr} », étape lue, pas « entraîné ici »`);
  ok(mT && mT.trainedHere && mT.label.fr === 'Jumeau', 'même contenu qu’un LoRA de l’utilisateur : le LoRA entraîné reste une entrée (pas une copie de rangement)');
  ok(mOld && mOld.origin === 'training' && mOld.trainingStep === 1500 && /· étape 1\s500$/.test(mOld.label.fr) && !mOld.trainedHere,
    `dossier d’entraînement d’avant (origine « training ») : numéro lu dans le nom, « ${mOld && mOld.label.fr} »`);
  ok(mL && mL.trainedHere && mL.origin === 'folder' && mL.label.fr === 'Lena' && mL.trainingStep == null && mL.status === 'ready',
    'Mia de test : <userData>\\loras-mia lu, « Lena » entraîné ici');
  ok(inv.roots.some((r) => r.path.toLowerCase() === testDir.replace(/\\/g, '/').toLowerCase() && r.kind === 'loras' && r.label.fr === 'Entraînés dans Mia'),
    'Mia de test : le dossier est une racine « Entraînés dans Mia » (surveillée comme les dossiers de LoRA)');
  const ins = await svc.inspect(final);
  ok(ins.ok && ins.isLora && ins.suggestedName === 'Rosa' && ins.suggestedTrigger === 'rsa woman' && ins.kindGuess === 'character',
    `inspect : nom, mot déclencheur et genre de la fiche (« ${ins.suggestedName} »)`);
  const insO = await svc.inspect(odd);
  ok(insO.ok && insO.isLora && insO.loraFor === 'qwen21', 'inspect : la base de la fiche quand le fichier ne la dit pas');

  // retrait : seulement le fichier et sa fiche, à la corbeille ; le reste ne bouge pas
  const refused = await svc.removeLora(mB.id);
  ok(refused.ok === false && fs.existsSync(bare) && binned.length === 0, 'removeLora : un LoRA du moteur sans fiche reste refusé (rien à la corbeille)');
  const rm = await svc.removeLora(mF.id);
  ok(rm.ok && rm.trashed.length === 2 && !fs.existsSync(final) && !fs.existsSync(final.replace(/\.safetensors$/, '.mia.json'))
    && fs.existsSync(path.join(bin, 'Rosa_ltx25_02500.safetensors')) && fs.existsSync(path.join(bin, 'Rosa_ltx25_02500.mia.json')),
    'removeLora (entraîné ici) : le fichier et sa fiche vont à la corbeille');
  ok(fs.existsSync(step1k) && fs.existsSync(bare) && fs.existsSync(twin) && !rm.inventory.models.some((m) => m.id === mF.id)
    && rm.inventory.models.some((m) => m.id === mS.id), 'removeLora : l’étape intermédiaire et les autres LoRA restent, l’entrée disparaît');
  const rmL = await svc.removeLora(mL.id);
  ok(rmL.ok && !fs.existsSync(testFile) && binned.length === 4, 'removeLora : un LoRA d’une Mia de test (<userData>\\loras-mia) aussi, fichier et fiche');
  // un nom choisi à la main pour un LoRA entraîné : il passe avant la fiche, l'étape reste dite
  const up = await svc.updateLora(mS.id, { name: 'Rosa essai' });
  ok(up.ok && /^Rosa essai · étape 1\s000$/.test(up.model.label.fr) && up.model.trainedHere, `renommé : « ${up.model && up.model.label.fr} », toujours entraîné ici`);
  const rmS = await svc.removeLora(mS.id);
  ok(rmS.ok && !svc.loras.some((e) => /rosa_ltx25_01000/i.test(e.source)) && !fs.existsSync(step1k),
    'removeLora : le nom choisi pour un LoRA mis à la corbeille est oublié du registre');
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
  await testTrainedLoras();
  await testRegister();
  const inv = warm.inventory;
  console.log(`\n# Bilan : ${inv.summary.ready} modèles prêts (${inv.models.length} entrées, ${inv.summary.sizeGB} Go), `
    + `${inv.partials.length} téléchargements interrompus, ${inv.duplicates.length} groupes de doublons, `
    + `${inv.apps.map((a) => `${a.name} ${a.models}`).join(', ')}`);
  console.log(`${checks - failures}/${checks} vérifications réussies${failures ? ` — ${failures} ÉCHEC(S)` : ''}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('Erreur du banc d\'essai :', e); process.exit(2); });
