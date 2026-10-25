'use strict';
// Mia — scanner des modèles IA locaux (processus principal).
//
// Port Node de `_plan/scan_probe.py` (outil interne de l'auteur, non publié ; l'oracle de test : même cache, mêmes familles). LECTURE SEULE stricte :
//  - .safetensors / .sft : 8 octets (u64 LE = taille de l'en-tête) puis l'en-tête JSON, rien d'autre ;
//  - .gguf               : en-tête + métadonnées + infos de tenseurs, jamais les données ;
//  - .pt/.pth/.ckpt/.bin : data.pkl (zip torch) ou pickle ancien PARCOURU PAR OPCODES, jamais exécuté ;
//  - dossiers HF / diffusers : config.json, model_index.json ;
//  - ComfyUI : uniquement des GET (/system_stats, /models, /models/<dossier>) sur 127.0.0.1.
// Le scan n'écrit jamais dans une racine scannée : seulement %APPDATA%\Mia\data\models-cache.json (et loras.json).
//
// Démarrage (models.md §5.3) : on sert le cache tout de suite, puis on revalide en arrière-plan (chemin + taille +
// mtime en ns : un fichier inchangé n'est jamais relu) et on pousse `models:update`.
//
// LoRA (SPEC §12) : registre %APPDATA%\Mia\data\loras.json (ajouts, noms, mots déclencheurs), dossiers de LoRA
// (prefs.loraFolders), et SEULE écriture permise dans le labo : <engineRoot>\models\loras\mia\ (lien physique ou
// copie d'un LoRA pour que ComfyUI le voie, retirée par « Retirer de Mia » ; jamais le fichier d'origine).
//
// API :
//   register(ctx)  → IPC models:list / scan / inspect / addLora / updateLora / removeLora, évts models:update /
//                    models:progress ; remplit ctx.models (list, resolve, owns, ensureLora, inspect…).
//   scan(opts)     → fonction pure (Node seul, sans Electron) utilisée par tools/test-scanner.js.
//   inspectFile(p) → « ce fichier est-il un LoRA ? » (en-tête seulement).

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const R = require('./scanner-rules');
const places = require('./places');

const RULES = R.RULES;
const CACHE_FORMAT = 1;                                           // forme de models-cache.json
const CACHE_VERSION = `${CACHE_FORMAT}.${RULES.schema}.${R.RULES_REV}`;
const CATALOG_REV = R.CATALOG_REV;                                 // catalogue changé : inventaire du cache jeté, fichiers gardés
const COMFY_TIMEOUT_MS = 600;
const IDENTIFY_CONCURRENCY = 8;
const SAMPLE_CHUNK = 1 << 16;                                     // 3 × 64 Ko pour l'empreinte de contenu
const MAX_HEADER = 200 * 1024 * 1024;
const MAX_PICKLE = 64 * 1024 * 1024;
const LEGACY_PICKLE_READ = 32 * 1024 * 1024;
const MAX_GGUF_META = 64 * 1024 * 1024;

const WEIGHT_EXT = new Set(RULES.weightExt);
const PARTIAL_EXT = new Set(RULES.partialExt);
const PRUNE_DIRS = new Set(RULES.pruneDirs);
const LORA_RX = new RegExp(RULES.loraSuffix);
const AUX_RX = new RegExp(RULES.auxTensor);
const NAME_HINTS = RULES.nameHints.map(([rx, h]) => [new RegExp(rx), h]);
const GGUF_DIFF = new Set(RULES.ggufDiffusionArch);

const DTYPE_BYTES = { F64: 8, F32: 4, F16: 2, BF16: 2, F8_E4M3: 1, F8_E5M2: 1, F8_E8M0: 1, I64: 8, I32: 4, I16: 2,
  I8: 1, U8: 1, U16: 2, U32: 4, U64: 8, BOOL: 1, C64: 8, F4: 0.5, F6_E2M3: 0.75, F6_E3M2: 0.75 };
const GGML_TYPE = { 0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 6: 'Q5_0', 7: 'Q5_1', 8: 'Q8_0', 9: 'Q8_1', 10: 'Q2_K',
  11: 'Q3_K', 12: 'Q4_K', 13: 'Q5_K', 14: 'Q6_K', 15: 'Q8_K', 16: 'IQ2_XXS', 17: 'IQ2_XS', 18: 'IQ3_XXS', 19: 'IQ1_S',
  20: 'IQ4_NL', 21: 'IQ3_S', 22: 'IQ2_S', 23: 'IQ4_XS', 24: 'I8', 25: 'I16', 26: 'I32', 27: 'I64', 28: 'F64',
  29: 'IQ1_M', 30: 'BF16', 34: 'TQ1_0', 35: 'TQ2_0', 39: 'MXFP4' };
const HF_ARCH = RULES.hfArch;

// =============================================================================================
// 0. Petits outils
// =============================================================================================

// Chemin normalisé « D:/x/y » : séparateur /, pas de / final (sauf racine de lecteur « D:/»).
function P(p) {
  if (!p) return '';
  let s = path.normalize(String(p)).replace(/\\/g, '/');
  if (s.length > 3) s = s.replace(/\/+$/, '');
  if (/^[A-Za-z]:$/.test(s)) s += '/';
  return s;
}
const lowKey = (p) => P(p).toLowerCase();
const under = (pLow, dirLow) => pLow.startsWith(dirLow.endsWith('/') ? dirLow : dirLow + '/');
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const now = () => Number(process.hrtime.bigint() / 1000000n);
const round2 = (x) => Math.round(x * 100) / 100;
const gb = (bytes) => Math.round(bytes / 1e6) / 1000;          // Go au Mo près : un petit fichier n'est jamais « 0 Go »

async function isDir(p) { try { return (await fsp.stat(p)).isDirectory(); } catch { return false; } }
async function isFile(p) { try { return (await fsp.stat(p)).isFile(); } catch { return false; } }
async function readdirSafe(dir) { try { return await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; } }
async function readJson(p) { try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return null; } }

// Petit limiteur de concurrence : la recherche large ouvre des milliers de dossiers, on n'en lit que N à la fois.
function limiter(n) {
  let active = 0; const queue = [];
  const next = () => { if (active >= n || !queue.length) return; active++; const { fn, res, rej } = queue.shift();
    Promise.resolve().then(fn).then(res, rej).finally(() => { active--; next(); }); };
  return (fn) => new Promise((res, rej) => { queue.push({ fn, res, rej }); next(); });
}

// Progression : au plus une notification toutes les 60 ms, sauf changement de phase.
function throttled(cb) {
  if (typeof cb !== 'function') return () => {};
  let last = 0, phase = null;
  return (p) => {
    const t = Date.now();
    if (p.phase !== phase || p.final || t - last >= 60) { phase = p.phase; last = t; try { cb(p); } catch { /* l'interface n'est pas critique */ } }
  };
}

// =============================================================================================
// 1. Matching des clés de tenseurs (port de scan_probe.py §3)
// =============================================================================================
const canon = (k) => k.toLowerCase().replace(/[_-]/g, '.').replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '');

const RX_CACHE = new Map();
// glob de segments -> RegExp multiligne appliquée à toutes les clés jointes par « \n ».
function globRx(g) {
  let rx = RX_CACHE.get(g);
  if (rx) return rx;
  const anchored = g.startsWith('^');
  const body = anchored ? g.slice(1) : g;
  const src = [...body].map((c) => (c === '.' ? '\\.' : c === '#' ? '\\d+' : c === '*' ? '[^.\\n]+' : c)).join('');
  rx = new RegExp((anchored ? '^' : '(?:^|\\.)') + src + '(?=\\.|$)', 'm');
  RX_CACHE.set(g, rx);
  return rx;
}
const has = (blob, g) => globRx(g).test(blob);

function ruleMatch(rule, blob, metaKeys, lora = false) {
  if (rule.meta_any) return rule.meta_any.some((m) => metaKeys.has(m));
  let al, an, no;
  // Règles LoRA dédiées : on n'hérite pas des listes du modèle complet (bug corrigé pendant l'essai Python).
  if (lora && (rule.lora_all || rule.lora_any || rule.lora_none)) {
    al = rule.lora_all || []; an = rule.lora_any || []; no = rule.lora_none || [];
  } else {
    al = rule.all || []; an = rule.any || []; no = rule.none || [];
  }
  if (!al.length && !an.length) return false;
  return al.every((g) => has(blob, g)) && (!an.length || an.some((g) => has(blob, g))) && !no.some((g) => has(blob, g));
}

function findShape(ckAll, shapes, g, axis) {
  const rx = globRx(g);
  for (const [c, k] of ckAll) {
    const m = rx.exec(c);
    if (!m) continue;
    const rest = c.slice(m.index + m[0].length);
    if ((rest === '.weight' || rest === '') && shapes[k]) {
      const s = shapes[k];
      if (s.length > axis) return s[axis];
    }
  }
  return null;
}

function countBlocks(blob, g) {
  const rx = new RegExp(globRx(g).source.replace('\\d+', '(\\d+)'), 'gm');
  let max = -1, m;
  while ((m = rx.exec(blob))) { const v = parseInt(m[1], 10); if (v > max) max = v; if (m[0] === '') rx.lastIndex++; }
  return max >= 0 ? max + 1 : null;
}

// keys : noms de tenseurs ; shapes : nom -> forme (vide pour un pickle). Renvoie {rule, family, role, …}.
function classifyKeys(keys, shapes, meta) {
  const metaKeys = new Set(Object.keys(meta || {}));
  const ckAll = keys.map((k) => [canon(k), k]);
  const loraKeys = ckAll.filter(([c]) => LORA_RX.test(c));
  const isLora = loraKeys.length >= Math.max(4, Math.floor(ckAll.length / 3));
  const res = { rule: null, family: null, role: null };
  if (isLora) {
    const targets = [...new Set(loraKeys.map(([c]) => c.replace(LORA_RX, '')))].sort();
    const blob = targets.join('\n');
    res.role = 'lora';
    const downs = loraKeys.filter(([c]) => /lora\.(a|down)(\.weight)?$/.test(c));
    if (downs.length && shapes[downs[0][1]]) res.rank = shapes[downs[0][1]][0];
    for (const r of RULES.rules) {
      if ((r.role === 'diffusion_model' || r.role === 'controlnet') && ruleMatch(r, blob, metaKeys, true)) {
        if (r.lora_sure && !r.lora_sure.some((g) => has(blob, g)) && !loraShapeOk(r, loraKeys, shapes)) continue;
        Object.assign(res, { rule: r.id, family: r.family, base_task: r.task ?? null });
        const lp = r.lora_probe;
        if (lp) {
          const rx = globRx(lp[0]);
          for (const [c, k] of downs) {
            if (rx.test(c) && shapes[k]) {
              res.base_width = shapes[k][lp[1]];
              res.variant = (r.sizes || {})[String(shapes[k][lp[1]])] ?? null;
              break;
            }
          }
        }
        if (r.blocks) res.blocks = countBlocks(blob, r.blocks);
        break;
      }
    }
    return res;
  }
  const blob = ckAll.map(([c]) => c).join('\n');
  // Checkpoint complet façon SD (UNet + VAE + texte dans un seul fichier).
  const fullCkpt = has(blob, '^model.diffusion.model') && has(blob, '^first.stage.model');
  for (const r of RULES.rules) {
    if (!ruleMatch(r, blob, metaKeys)) continue;
    Object.assign(res, { rule: r.id, family: r.family, role: r.role, task: r.task ?? null });
    if (fullCkpt && r.role === 'diffusion_model') res.role = 'checkpoint';
    if (r.probe) {
      const v = findShape(ckAll, shapes, r.probe[0], r.probe[1]);
      if (v != null) { res.probe_value = v; res.variant = (r.sizes || {})[String(v)] ?? null; }
    }
    if (r.blocks) res.blocks = countBlocks(blob, r.blocks);
    const fl = Object.entries(r.flags || {}).filter(([, gs]) => gs.some((g) => has(blob, g))).map(([f]) => f);
    if (fl.length) res.flags = fl;
    break;
  }
  return res;
}

// FLUX.2 et FLUX.1 ont les mêmes noms de couches (double_blocks…img_attn.qkv, single_blocks…linear1) : seules les
// formes les séparent. Sortie/entrée de single_blocks.linear1 = 9 (FLUX.2) contre 7 (FLUX.1) ; img_mlp.0 = 6 contre 4.
// Sans ces couches : la largeur seule, si FLUX.1 ne peut pas l'avoir (4096 = Klein 9B, 6144 = dev).
function loraShapeOk(r, loraKeys, shapes) {
  const isA = (c) => /\.lora\.(a|down)(\.weight)?$/.test(c), isB = (c) => /\.lora\.(b|up)(\.weight)?$/.test(c);
  for (const [g, mult] of r.lora_mult || []) {
    const rx = globRx(g);
    const a = loraKeys.find(([c]) => isA(c) && rx.test(c.replace(LORA_RX, '')));
    if (!a) continue;
    const stem = a[0].replace(LORA_RX, '');
    const b = loraKeys.find(([c]) => isB(c) && c.replace(LORA_RX, '') === stem);
    const sa = shapes[a[1]], sb = b && shapes[b[1]];
    if (sa && sb && sa.length === 2 && sb.length === 2) return sb[0] === mult * sa[1];
  }
  const lp = r.lora_probe && globRx(r.lora_probe[0]);
  const a = lp && loraKeys.find(([c, k]) => isA(c) && lp.test(c.replace(LORA_RX, '')) && shapes[k]);
  return !!a && (r.lora_width || []).includes(shapes[a[1]][r.lora_probe[1]]);
}

// Indices par le nom, lus sur le chemin RELATIF à la racine (sinon tout KimodoStudio\ devient « Kimodo »).
function applyNameHints(res, p, rel) {
  const low = (rel || p).toLowerCase().replace(/\\/g, '/');
  const base = low.split('/').pop();
  const hints = {};
  for (const [rx, h] of NAME_HINTS) {
    if (rx.test(low)) for (const [k, v] of Object.entries(h)) if (!(k in hints)) hints[k] = v;
  }
  if (Object.keys(hints).length) res.name_hints = hints;
  if (!res.family && hints.family) { res.family = hints.family; res.rule = res.rule || 'name'; }
  if ((!res.role || res.role === 'unknown') && hints.role) res.role = hints.role;
  // Le VAE Qwen-Image a exactement l'architecture du VAE Wan 2.1 : seul le nom tranche (2.1 : 64 canaux, le sien).
  if (res.rule === 'wan_vae' && base.includes('qwen')) res.family = /qwen.?image.?2[._-]?1/.test(base) || res.probe_value === 64 ? 'Qwen-Image 2.1' : 'Qwen-Image';
  // FLUX.2 sans largeur lisible : le nom dit la variante (« …klein-9b… »)
  if (res.family === 'FLUX.2' && !res.variant && hints.variant) res.variant = hints.variant;
  if (res.rule === 'kl_vae' && low.includes('seedvr')) res.family = 'SeedVR2';
  if (res.rule === 'ltxv' && (hints.family === 'LTX-2.x' || low.includes('ltx-2') || low.includes('ltx25'))) res.family = 'LTX-2.x';
  if (res.family === 'Wan 2.x' && low.includes('animate')) {
    res.flags = res.flags || [];
    if (!res.flags.includes('animate')) res.flags.push('animate');
  }
  if (!res.role) res.role = 'unknown';
  return res;
}

// =============================================================================================
// 2. Lecteurs de formats (lecture seule, aucun poids chargé)
// =============================================================================================
async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, len - got, pos + got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return got === len ? buf : buf.subarray(0, got);
}

async function readSafetensors(fh, size) {
  const b8 = await readAt(fh, 0, 8);
  if (b8.length < 8) throw new Error('fichier trop court');
  const n = b8.readBigUInt64LE(0);
  if (n <= 1n || n > BigInt(MAX_HEADER)) throw new Error(`en-tête safetensors invalide (${n})`);
  if (8n + n > BigInt(size)) throw new Error('fichier tronqué');
  const hb = await readAt(fh, 8, Number(n));
  const h = JSON.parse(hb.toString('utf8'));
  const meta = (h && h.__metadata__) || {};
  delete h.__metadata__;
  return { h, meta, headerSha1: sha1(hb).slice(0, 16) };
}

function summarizeTensors(h, meta) {
  const dtBytes = new Map(), dtCount = {};
  let params = 0;
  const keys = Object.keys(h);
  const ck = {};
  for (const k of keys) ck[k] = canon(k);
  const nvfp4Like = keys.some((k) => ck[k].endsWith('weight.scale.2')) || '_quantization_metadata' in meta;
  const bnb4 = keys.some((k) => ck[k].endsWith('weight.absmax'));
  for (const k of keys) {
    const v = h[k] || {};
    const dt = v.dtype || '?';
    let n = 1;
    for (const d of v.shape || []) n *= d;
    dtCount[dt] = (dtCount[dt] || 0) + 1;
    dtBytes.set(dt, (dtBytes.get(dt) || 0) + n * (DTYPE_BYTES[dt] ?? 1));
    const c = ck[k];
    if (AUX_RX.test(c)) continue;
    if (dt === 'U8' && (nvfp4Like || bnb4) && c.endsWith('weight')) n *= 2;   // 2 valeurs 4 bits par octet
    params += n;
  }
  const quant = quantLabel(h, meta, ck, dtBytes, bnb4);
  return { n_tensors: keys.length, dtypes: dtCount, params, quant };
}

function quantLabel(h, meta, ck, dtBytes, bnb4) {
  const qm = meta._quantization_metadata;
  if (qm) {
    try {
      const fm = new Map();
      for (const l of Object.values(JSON.parse(qm).layers || {})) { const f = (l && l.format) || '?'; fm.set(f, (fm.get(f) || 0) + 1); }
      return [...fm.keys()].sort().join('+') + ' (mixte, couches sensibles en bf16)';
    } catch { return 'quantifie (metadonnees)'; }
  }
  const cq = Object.values(ck).some((c) => c.endsWith('comfy.quant'));
  if (bnb4) return 'nf4 (bitsandbytes)';
  if (cq) {
    const wb = new Map();
    for (const [k, c] of Object.entries(ck)) {
      if (c.endsWith('weight') && !AUX_RX.test(c)) {
        let n = 1;
        for (const d of h[k].shape || []) n *= d;
        const dt = h[k].dtype;
        wb.set(dt, (wb.get(dt) || 0) + n * (DTYPE_BYTES[dt] ?? 1));
      }
    }
    const q = { I8: 'int8 convrot', U8: 'nvfp4', F8_E4M3: 'fp8 e4m3' };
    const parts = [...wb.entries()].sort((a, b) => b[1] - a[1]).filter(([d]) => d in q).map(([d]) => q[d]);
    if (parts.length) return parts.join(' + ') + ' (ComfyUI' + (parts.length > 1 ? ', mixte)' : ')');
  }
  if (Object.values(ck).some((c) => c === 'scaled.fp8')) return 'fp8 e4m3 scaled';
  const weights = [...dtBytes.entries()].filter(([d]) => !['I64', 'C64', 'BOOL'].includes(d));
  if (!weights.length) return '?';
  let top = weights[0], tot = 0;
  for (const w of weights) { tot += w[1]; if (w[1] > top[1]) top = w; }
  let lab = { F8_E4M3: 'fp8 e4m3', F8_E5M2: 'fp8 e5m2', BF16: 'bf16', F16: 'fp16', F32: 'fp32', I8: 'int8',
    U8: 'uint8/4 bits' }[top[0]] || top[0].toLowerCase();
  if (tot > 0 && top[1] / tot < 0.85) lab += ' (mixte)';
  return lab;
}

// --- GGUF : lecteur progressif (le vocabulaire d'un LLM pèse plusieurs Mo : on ne lit que ce qu'il faut) ---
class GrowReader {
  constructor(fh, size) { this.fh = fh; this.size = size; this.buf = Buffer.alloc(0); this.pos = 0; }
  async need(n) {
    const end = this.pos + n;
    if (end <= this.buf.length) return;
    if (end > this.size) throw new Error('fin de fichier GGUF inattendue');
    if (end > MAX_GGUF_META) throw new Error('métadonnées GGUF trop grosses');
    const want = Math.min(this.size, MAX_GGUF_META, Math.max(end, this.buf.length * 2, 1 << 20));
    const more = await readAt(this.fh, this.buf.length, want - this.buf.length);
    this.buf = Buffer.concat([this.buf, more]);
    if (end > this.buf.length) throw new Error('fin de fichier GGUF inattendue');
  }
  async u32() { await this.need(4); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  async u64() { await this.need(8); const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return Number(v); }
  async skip(n) { await this.need(n); this.pos += n; }
  async str(v) { const n = v >= 2 ? await this.u64() : await this.u32(); await this.need(n); const s = this.buf.toString('utf8', this.pos, this.pos + n); this.pos += n; return s; }
}
const GGUF_SCALAR = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
async function ggufValue(r, t, v) {
  if (t in GGUF_SCALAR) {
    await r.need(GGUF_SCALAR[t]);
    const b = r.buf, p = r.pos; r.pos += GGUF_SCALAR[t];
    switch (t) {
      case 0: return b.readUInt8(p); case 1: return b.readInt8(p); case 2: return b.readUInt16LE(p);
      case 3: return b.readInt16LE(p); case 4: return b.readUInt32LE(p); case 5: return b.readInt32LE(p);
      case 6: return b.readFloatLE(p); case 7: return b.readUInt8(p) !== 0; case 10: return Number(b.readBigUInt64LE(p));
      case 11: return Number(b.readBigInt64LE(p)); default: return b.readDoubleLE(p);
    }
  }
  if (t === 8) return r.str(v);
  if (t === 9) {
    const at = await r.u32();
    const n = v >= 2 ? await r.u64() : await r.u32();
    if (at in GGUF_SCALAR) { await r.skip(n * GGUF_SCALAR[at]); return `<array ${n}>`; }
    const out = [];
    for (let i = 0; i < n; i++) { const x = await ggufValue(r, at, v); if (n <= 64) out.push(x); }
    return n <= 64 ? out : `<array ${n}>`;
  }
  throw new Error(`type gguf ${t}`);
}
async function readGguf(fh, size) {
  const r = new GrowReader(fh, size);
  await r.need(4);
  if (r.buf.toString('latin1', 0, 4) !== 'GGUF') throw new Error('pas un GGUF');
  r.pos = 4;
  const v = await r.u32();
  const nt = v >= 2 ? await r.u64() : await r.u32();
  const nkv = v >= 2 ? await r.u64() : await r.u32();
  const kv = {};
  for (let i = 0; i < nkv; i++) {
    const k = await r.str(v);
    const t = await r.u32();
    const val = await ggufValue(r, t, v);
    if (!k.startsWith('tokenizer.ggml.')) kv[k] = val;
  }
  const names = [], shapes = {}, types = new Map();
  let params = 0;
  for (let i = 0; i < nt; i++) {
    const name = await r.str(v);
    const nd = await r.u32();
    const dims = [];
    for (let d = 0; d < nd; d++) dims.push(v >= 2 ? await r.u64() : await r.u32());
    const tt = await r.u32();
    await r.skip(8);
    let n = 1;
    for (const d of dims) n *= d;
    params += n;
    names.push(name);
    shapes[name] = dims.slice().reverse();               // ggml stocke les dimensions à l'envers
    const tn = GGML_TYPE[tt] || String(tt);
    types.set(tn, (types.get(tn) || 0) + n);
  }
  const arch = kv['general.architecture'] ?? null;
  const ft = kv['general.file_type'];
  let quant = Number.isInteger(ft) ? (RULES.ggufFtype[String(ft)] ?? null) : null;
  if (!quant && types.size) quant = [...types.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  return { names, shapes, kv, info: { n_tensors: nt, params, quant, gguf_arch: arch, gguf_name: kv['general.name'] ?? null, gguf_version: v } };
}

// --- Pickle : parcours d'opcodes SANS exécution (équivalent de pickletools.genops) ---
// [nom, type d'argument]. Les arguments sont lus pour être sautés ; seuls chaînes et entiers nous intéressent.
const OPS = {
  0x28: ['MARK'], 0x2e: ['STOP'], 0x30: ['POP'], 0x31: ['POP_MARK'], 0x32: ['DUP'], 0x46: ['FLOAT', 'line'],
  0x49: ['INT', 'intline'], 0x4a: ['BININT', 'i4'], 0x4b: ['BININT1', 'u1'], 0x4c: ['LONG', 'longline'],
  0x4d: ['BININT2', 'u2'], 0x4e: ['NONE'], 0x50: ['PERSID', 'line'], 0x51: ['BINPERSID'], 0x52: ['REDUCE'],
  0x53: ['STRING', 'strline'], 0x54: ['BINSTRING', 's4'], 0x55: ['SHORT_BINSTRING', 's1'], 0x56: ['UNICODE', 'line'],
  0x58: ['BINUNICODE', 's4u'], 0x61: ['APPEND'], 0x62: ['BUILD'], 0x63: ['GLOBAL', 'line2'], 0x64: ['DICT'],
  0x7d: ['EMPTY_DICT'], 0x65: ['APPENDS'], 0x67: ['GET', 'intline'], 0x68: ['BINGET', 'u1'], 0x69: ['INST', 'line2'],
  0x6a: ['LONG_BINGET', 'u4'], 0x6c: ['LIST'], 0x5d: ['EMPTY_LIST'], 0x6f: ['OBJ'], 0x70: ['PUT', 'intline'],
  0x71: ['BINPUT', 'u1'], 0x72: ['LONG_BINPUT', 'u4'], 0x73: ['SETITEM'], 0x74: ['TUPLE'], 0x29: ['EMPTY_TUPLE'],
  0x75: ['SETITEMS'], 0x47: ['BINFLOAT', 'f8'], 0x80: ['PROTO', 'u1'], 0x81: ['NEWOBJ'], 0x82: ['EXT1', 'u1'],
  0x83: ['EXT2', 'u2'], 0x84: ['EXT4', 'i4'], 0x85: ['TUPLE1'], 0x86: ['TUPLE2'], 0x87: ['TUPLE3'], 0x88: ['NEWTRUE'],
  0x89: ['NEWFALSE'], 0x8a: ['LONG1', 'long1'], 0x8b: ['LONG4', 'long4'], 0x42: ['BINBYTES', 'b4'],
  0x43: ['SHORT_BINBYTES', 'b1'], 0x8c: ['SHORT_BINUNICODE', 's1u'], 0x8d: ['BINUNICODE8', 's8u'],
  0x8e: ['BINBYTES8', 'b8'], 0x8f: ['EMPTY_SET'], 0x90: ['ADDITEMS'], 0x91: ['FROZENSET'], 0x92: ['NEWOBJ_EX'],
  0x93: ['STACK_GLOBAL'], 0x94: ['MEMOIZE'], 0x95: ['FRAME', 'u8'], 0x96: ['BYTEARRAY8', 'b8'],
  0x97: ['NEXT_BUFFER'], 0x98: ['READONLY_BUFFER'],
};
const STR_OPS = new Set(['SHORT_BINUNICODE', 'BINUNICODE', 'UNICODE', 'BINUNICODE8', 'SHORT_BINSTRING', 'BINSTRING', 'STRING']);
const INT_OPS = new Set(['BININT', 'BININT1', 'BININT2', 'LONG1', 'LONG', 'INT', 'LONG4']);
const KEY_RX = /^[A-Za-z_]\w*(\.\w+)+$/;
const LOC_RX = /^(cpu|cuda(:\d+)?|mps)$/;
const STORAGE_BYTES = ['FloatStorage', 'HalfStorage', 'BFloat16Storage', 'DoubleStorage'];

function leSigned(bytes) {
  if (!bytes.length) return 0;
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  if (bytes[bytes.length - 1] & 0x80) v -= 1n << BigInt(bytes.length * 8);
  return Number(v);
}

// Renvoie {keys, storages (Map), numel}. Le nb d'éléments est l'entier qui suit la chaîne de localisation
// ('cpu', 'cuda:0') de chaque persistent_id ; les chaînes mémoïsées (BINPUT/BINGET) sont suivies.
function pickleScan(buf, maxOps = 3000000, maxPickles = 4) {
  const keys = [], storages = new Map();
  let numel = 0, ops = 0, pos = 0;
  const bump = (s) => storages.set(s, (storages.get(s) || 0) + 1);
  const line = () => { const e = buf.indexOf(0x0a, pos); if (e < 0) throw new Error('eof'); const s = buf.toString('latin1', pos, e); pos = e + 1; return s; };
  const take = (n) => { if (pos + n > buf.length) throw new Error('eof'); const b = buf.subarray(pos, pos + n); pos += n; return b; };
  for (let p = 0; p < maxPickles; p++) {
    const memo = new Map();
    let memoN = 0, last = null;
    try {
      for (;;) {
        if (pos >= buf.length) throw new Error('eof');
        const op = OPS[buf[pos++]];
        if (!op) throw new Error('opcode');
        if (++ops > maxOps) return { keys, storages, numel };
        const [nm, at] = op;
        let arg = null;
        switch (at) {
          case 'u1': arg = take(1)[0]; break;
          case 'u2': arg = take(2).readUInt16LE(0); break;
          case 'i4': arg = take(4).readInt32LE(0); break;
          case 'u4': arg = take(4).readUInt32LE(0); break;
          case 'u8': arg = Number(take(8).readBigUInt64LE(0)); break;
          case 'f8': take(8); break;
          case 'line': arg = line(); break;
          case 'line2': arg = line() + ' ' + line(); break;
          case 'intline': { const s = line().trim(); arg = s === '00' ? 0 : s === '01' ? 1 : parseInt(s, 10); break; }
          case 'longline': arg = parseInt(line().trim().replace(/L$/, ''), 10); break;
          case 'strline': { const s = line().trim(); arg = s.length >= 2 && (s[0] === "'" || s[0] === '"') ? s.slice(1, -1) : s; break; }
          case 's1': arg = take(take(1)[0]).toString('latin1'); break;
          case 's4': arg = take(take(4).readInt32LE(0)).toString('latin1'); break;
          case 's1u': arg = take(take(1)[0]).toString('utf8'); break;
          case 's4u': arg = take(take(4).readUInt32LE(0)).toString('utf8'); break;
          case 's8u': arg = take(Number(take(8).readBigUInt64LE(0))).toString('utf8'); break;
          case 'b1': take(take(1)[0]); break;
          case 'b4': take(take(4).readUInt32LE(0)); break;
          case 'b8': take(Number(take(8).readBigUInt64LE(0))); break;
          case 'long1': arg = leSigned(take(take(1)[0])); break;
          case 'long4': arg = leSigned(take(take(4).readInt32LE(0))); break;
          default: break;
        }
        if (STR_OPS.has(nm) && typeof arg === 'string') {
          last = arg;
          if (arg.endsWith('Storage')) bump(arg);
          else if (KEY_RX.test(arg) && !/^(torch\.|collections\.|numpy\.|__)/.test(arg)) keys.push(arg);
          continue;
        }
        if (nm === 'BINPUT' || nm === 'LONG_BINPUT' || nm === 'PUT') { memo.set(arg, last); continue; }
        if (nm === 'MEMOIZE') { memo.set(memoN++, last); continue; }
        if (nm === 'BINGET' || nm === 'LONG_BINGET' || nm === 'GET') { last = memo.has(arg) ? memo.get(arg) : null; continue; }
        if (nm === 'GLOBAL' && typeof arg === 'string' && arg.includes('Storage')) bump(arg.split(/\s+/).pop());
        if (INT_OPS.has(nm) && Number.isFinite(arg) && typeof last === 'string' && LOC_RX.test(last)) numel += arg;
        last = null;
        if (nm === 'STOP') break;
      }
    } catch {
      break;   // fin de flux, ou données binaires après les pickles
    }
  }
  return { keys, storages, numel };
}

// Lecteur zip minimal (répertoire central + ZIP64) : on n'extrait que l'entrée */data.pkl d'un fichier torch.
async function readZipEntry(fh, size, pick, maxBytes) {
  const tailLen = Math.min(size, 65557 + 22);
  const tail = await readAt(fh, size - tailLen, tailLen);
  let eo = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eo = i; break; }
  if (eo < 0) throw new Error('zip sans répertoire central');
  let count = tail.readUInt16LE(eo + 10), cdSize = tail.readUInt32LE(eo + 12), cdOff = tail.readUInt32LE(eo + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    const loc = eo - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('zip64 illisible');
    const z64off = Number(tail.readBigUInt64LE(loc + 8));
    const z = await readAt(fh, z64off, 56);
    if (z.readUInt32LE(0) !== 0x06064b50) throw new Error('zip64 illisible');
    count = Number(z.readBigUInt64LE(32)); cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48));
  }
  if (cdSize > MAX_PICKLE) throw new Error('répertoire zip trop gros');
  const cd = await readAt(fh, cdOff, cdSize);
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const method = cd.readUInt16LE(p + 10);
    let comp = cd.readUInt32LE(p + 20), unc = cd.readUInt32LE(p + 24);
    const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
    let lho = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nl);
    if (pick(name)) {
      // Champ extra ZIP64 : seuls les champs à 0xFFFFFFFF y figurent, dans cet ordre.
      let x = p + 46 + nl;
      const xEnd = x + xl;
      while (x + 4 <= xEnd) {
        const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (unc === 0xffffffff) { unc = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (comp === 0xffffffff) { comp = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (lho === 0xffffffff) { lho = Number(cd.readBigUInt64LE(q)); q += 8; }
        }
        x += 4 + len;
      }
      if (unc > maxBytes) throw new Error('data.pkl trop gros');
      const lh = await readAt(fh, lho, 30);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('entrée zip illisible');
      const data = await readAt(fh, lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28), comp);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`compression zip ${method} non gérée`);
    }
    p += 46 + nl + xl + cl;
  }
  return null;
}

async function readPickleWeights(fh, size) {
  const magic = await readAt(fh, 0, 4);
  let scanRes, fp, fmt;
  if (magic[0] === 0x50 && magic[1] === 0x4b) {                       // « PK » : zip torch
    const data = await readZipEntry(fh, size, (n) => n.endsWith('data.pkl'), MAX_PICKLE);
    if (!data) throw new Error('zip sans data.pkl');
    scanRes = pickleScan(data);
    fp = sha1(data).slice(0, 16);
    fmt = 'torch-zip';
  } else if (magic[0] === 0x80) {                                     // pickle ancien (torch < 1.6)
    const data = await readAt(fh, 0, Math.min(size, LEGACY_PICKLE_READ));
    scanRes = pickleScan(data);
    fp = sha1(data.subarray(0, 1 << 20)).slice(0, 16);
    fmt = 'torch-legacy';
  } else {
    throw new Error('pas un fichier de poids (ni zip torch ni pickle)');
  }
  const { keys, storages, numel } = scanRes;
  if (!keys.length) throw new Error('aucune clé de tenseur trouvée');
  let dom = null;
  const fl = [...storages.entries()].filter(([k]) => STORAGE_BYTES.includes(k));
  if (fl.length) dom = fl.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  else if (storages.size) dom = [...storages.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const quant = { FloatStorage: 'fp32', HalfStorage: 'fp16', BFloat16Storage: 'bf16' }[dom] || dom;
  return { keys, info: { format: fmt, n_tensors: keys.length, params: numel || null, quant }, fp };
}

// Empreinte de contenu : taille + SHA-1 de 3 × 64 Ko (début, milieu, fin). L'en-tête seul ne suffit pas :
// deux LoRA de même architecture et de même rang ont exactement le même en-tête safetensors.
async function sampleHash(fh, size) {
  const h = crypto.createHash('sha1');
  for (const off of [0, Math.max(0, Math.floor(size / 2) - SAMPLE_CHUNK / 2), Math.max(0, size - SAMPLE_CHUNK)]) {
    h.update(await readAt(fh, off, Math.max(0, Math.min(SAMPLE_CHUNK, size - off))));
  }
  return `${size}:${h.digest('hex').slice(0, 16)}`;
}

// <fichier>.json voisin (TRELLIS) -> nom d'architecture.
async function sidecarArch(p) {
  const j = p.replace(/\.[^./\\]*$/, '') + '.json';
  const d = await readJson(j);
  return d && typeof d === 'object' ? (d.name || d._class_name || null) : null;
}

// Nom et mot déclencheur d'un LoRA d'après ses métadonnées (kohya : ss_output_name, ss_tag_frequency ; modelspec).
// Le mot le plus fréquent des légendes d'entraînement est, en pratique, le déclencheur (« mra woman »).
function loraMeta(meta) {
  const o = {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const title = str(meta['modelspec.title']) || str(meta.ss_output_name);
  if (title && title.length <= 80) o.lora_title = title;
  let trig = str(meta['modelspec.trigger_phrase']);
  if (!trig && typeof meta.ss_tag_frequency === 'string' && meta.ss_tag_frequency.length < 4e6) {
    try {
      let best = null, n = -1;
      for (const ds of Object.values(JSON.parse(meta.ss_tag_frequency) || {})) {
        for (const [tag, c] of Object.entries(ds || {})) if (Number(c) > n) { n = Number(c); best = tag; }
      }
      if (best) trig = String(best).trim();
    } catch { /* métadonnée libre */ }
  }
  if (trig && trig.length <= 60) o.lora_trigger = trig;
  return o;
}

// Modèle de base écrit par l'outil d'entraînement. Il comble une famille inconnue et précise la variante d'une même
// architecture ; il ne contredit jamais une architecture lue dans les tenseurs (sauf FLUX.1 / FLUX.2, mêmes noms).
const META_BASE = [
  [/qwen[-_ .]?image[-_ .]?2[-_.]?1/, { family: 'Qwen-Image 2.1' }],
  [/qwen[-_ .]?image/, { family: 'Qwen-Image' }],
  [/klein[-_ .]?(base[-_ .]?)?9b|flux[-_ .]?2[-_ .]?klein[-_ .]?(base[-_ .]?)?9/, { family: 'FLUX.2', variant: 'Klein 9B' }],
  [/klein[-_ .]?(base[-_ .]?)?4b|flux[-_ .]?2[-_ .]?klein[-_ .]?(base[-_ .]?)?4/, { family: 'FLUX.2', variant: 'Klein 4B' }],
  [/flux[-_ .]?2/, { family: 'FLUX.2' }],
  [/flux[-_ .]?1|flux-1/, { family: 'FLUX.1' }],
];
const META_BASE_KEYS = ['modelspec.architecture', 'ss_base_model_version', 'ss_architecture', 'ss_base_model', 'base_model', 'ss_base_checkpoint', 'ss_sd_model_name'];
const SAME_ARCH = { 'FLUX.1': 'FLUX.2', 'FLUX.2': 'FLUX.1' };
function loraBaseFromMeta(res, meta) {
  const s = META_BASE_KEYS.map((k) => (typeof meta[k] === 'string' ? meta[k] : '')).join(' ').toLowerCase();
  if (!s.trim()) return;
  const hit = META_BASE.find(([rx]) => rx.test(s));
  if (!hit) return;
  const h = hit[1];
  res.meta_base = h.family + (h.variant ? ` ${h.variant}` : '');
  if (!res.family || SAME_ARCH[res.family] === h.family) { res.family = h.family; res.rule = res.rule || 'meta'; }
  if (res.family === h.family && h.variant && !res.variant) res.variant = h.variant;
}

const KEEP_META = ['model_version', 'base_model', 'training_rank', 'training_alpha', 'format', 'modelspec.architecture',
  'ss_base_model_version', 'ss_network_dim', 'reference_kind', 'minimax_h3_fun_controlnet'];

// Identifie un fichier : format, empreinte, famille, rôle, précision, paramètres… (résultat mis en cache).
async function identify(p, size, rel) {
  const ext = path.extname(p).toLowerCase();
  const out = { ext };
  let res = {};
  let fh = null;
  try {
    fh = await fsp.open(p, 'r');
    if (ext === '.safetensors' || ext === '.sft') {
      const { h, meta, headerSha1 } = await readSafetensors(fh, size);
      Object.assign(out, { format: 'safetensors', header_sha1: headerSha1, fingerprint: await sampleHash(fh, size) });
      Object.assign(out, summarizeTensors(h, meta));
      const shapes = {};
      for (const [k, v] of Object.entries(h)) shapes[k] = (v && v.shape) || [];
      res = classifyKeys(Object.keys(h), shapes, meta);
      const keep = {};
      for (const k of KEEP_META) if (k in meta) keep[k] = String(meta[k]).slice(0, 120);
      if ('config' in meta) {
        try {
          const tr = (JSON.parse(meta.config) || {}).transformer || {};
          const cls = tr._class_name || tr.model_type;
          if (cls) keep.config_class = cls;
        } catch { /* métadonnée libre, pas forcément du JSON */ }
      }
      if (typeof meta.license === 'string' && meta.license.trim()) keep.license = meta.license.trim().split(/\r?\n/)[0].slice(0, 80);
      if (Object.keys(keep).length) out.meta = keep;
      if (keep.config_class && String(keep.config_class).startsWith('animate')) (res.flags = res.flags || []).push('animate');
      if (res.role === 'lora') { Object.assign(out, loraMeta(meta)); loraBaseFromMeta(res, meta); }
    } else if (ext === '.gguf') {
      const { names, shapes, info } = await readGguf(fh, size);
      Object.assign(out, { format: 'gguf', fingerprint: await sampleHash(fh, size) }, info);
      res = classifyKeys(names, shapes, {});
      const arch = info.gguf_arch;
      if (!res.family) res.family = arch;
      if (!res.role && arch) res.role = GGUF_DIFF.has(arch) ? 'diffusion_model' : 'llm';
    } else if (['.pt', '.pth', '.ckpt', '.bin', '.pt2'].includes(ext)) {
      const { keys, info } = await readPickleWeights(fh, size);
      Object.assign(out, info);
      out.fingerprint = await sampleHash(fh, size);
      res = classifyKeys(keys, {}, {});
    } else if (['.onnx', '.task', '.tflite'].includes(ext)) {
      Object.assign(out, { format: ext.slice(1), fingerprint: await sampleHash(fh, size) });
      res = { rule: 'name' };
    } else {
      return null;
    }
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 160);
    // Un .bin qui n'est ni zip torch ni pickle n'est pas un modèle (cache d'Unreal, glTF, tuiles…).
    if (ext === '.bin') return { not_a_model: true, error: msg };
    Object.assign(out, { format: 'illisible', error: msg });
    res = {};
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
  const arch = await sidecarArch(p);
  if (arch) {
    out.sidecar_arch = arch;
    if (HF_ARCH[arch] && !res.family) [res.family, res.role] = HF_ARCH[arch];
  }
  applyNameHints(res, p, rel);
  for (const [k, v] of Object.entries(res)) if (v != null) out[k] = v;
  return out;
}

// =============================================================================================
// 3. Racines : globs, fichiers yaml de ComfyUI, parcours
// =============================================================================================
function makeEnv(opts = {}) {
  const home = P(opts.home || os.homedir());
  const local = P(opts.localAppData || process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'));
  const roaming = P(opts.appData || process.env.APPDATA || path.join(home, 'AppData', 'Roaming'));
  return {
    // sans moteur : là où l'installer le mettrait (rien n'y est encore : aucune racine, des chemins d'aide justes)
    engineRoot: P(opts.engineRoot || places.labRoot() || places.suggestEngineDir()),
    home, local, roaming,
    hfHome: P(process.env.HF_HOME || path.join(home, '.cache', 'huggingface')),
    ollama: P(process.env.OLLAMA_MODELS || path.join(home, '.ollama', 'models')),
  };
}

const wildRx = (s) => new RegExp('^' + s.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');

// glob minimal (« * » dans un segment, « ** » = zéro ou plusieurs dossiers), insensible à la casse comme Windows.
async function expandGlob(pattern, { files = false, maxDepth = 5 } = {}) {
  const segs = P(pattern).split('/').filter((s, i) => s || i === 0);
  let bases = [segs[0].endsWith(':') ? segs[0] + '/' : segs[0]];
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i], lastSeg = i === segs.length - 1;
    const next = [];
    if (s === '**') {
      const walkDirs = async (d, depth) => {
        next.push(d);
        if (depth >= maxDepth) return;
        for (const e of await readdirSafe(d)) {
          if (e.isDirectory() && !PRUNE_DIRS.has(e.name.toLowerCase())) await walkDirs(P(path.join(d, e.name)), depth + 1);
        }
      };
      for (const b of bases) await walkDirs(b, 0);
    } else if (/[*?]/.test(s)) {
      const rx = wildRx(s);
      for (const b of bases) {
        for (const e of await readdirSafe(b)) {
          if (!rx.test(e.name)) continue;
          if (e.isDirectory() || (lastSeg && files && e.isFile())) next.push(P(path.join(b, e.name)));
        }
      }
    } else {
      for (const b of bases) {
        const p = P(path.join(b, s));
        if (lastSeg && files ? await isFile(p) : await isDir(p)) next.push(p);
      }
    }
    bases = [...new Set(next)];
    if (!bases.length) break;
  }
  return bases;
}

// extra_model_paths.yaml de ComfyUI (sous-ensemble YAML : sections, clés, valeurs, blocs « |- »).
// Renvoie [{section, basePath, folders: {dossier: [chemins absolus]}}], comme folder_paths le comprend.
async function parseModelPathsYaml(file) {
  let txt;
  try { txt = await fsp.readFile(file, 'utf8'); } catch { return []; }
  const unq = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');
  const strip = (s) => { const m = s.match(/^((?:[^#'"]|'[^']*'|"[^"]*")*)/); return (m ? m[1] : s).replace(/\s+$/, ''); };
  const sections = [];
  let cur = null, block = null;
  for (const raw of txt.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const ind = raw.match(/^\s*/)[0].length;
    if (block && ind > block.indent) { cur.raw[block.key].push(unq(strip(raw))); continue; }
    block = null;
    const line = strip(raw);
    let m;
    if (ind === 0 && (m = line.match(/^(['"]?)([^'":]+)\1\s*:\s*$/))) { cur = { section: m[2], raw: {} }; sections.push(cur); continue; }
    if (cur && (m = line.match(/^\s+(['"]?)([^'":]+)\1\s*:\s*(.*)$/))) {
      const key = m[2].trim(), val = m[3].trim();
      if (/^[|>][-+]?$/.test(val)) { cur.raw[key] = []; block = { key, indent: ind }; }
      else cur.raw[key] = [unq(val)];
    }
  }
  const dir = path.dirname(file);
  return sections.map((s) => {
    let base = (s.raw.base_path || [])[0] || '';
    if (base) {
      base = base.replace(/%([^%]+)%/g, (_, v) => process.env[v] || '').replace(/^~(?=[\\/]|$)/, os.homedir());
      if (!path.isAbsolute(base)) base = path.resolve(dir, base);
    }
    const folders = {};
    for (const [k, vals] of Object.entries(s.raw)) {
      if (k === 'base_path' || k === 'is_default') continue;
      for (const v of String(vals.join('\n')).split('\n')) {
        if (!v.trim()) continue;
        const full = base ? path.join(base, v.trim()) : (path.isAbsolute(v.trim()) ? v.trim() : path.resolve(dir, v.trim()));
        (folders[k] = folders[k] || []).push(P(full));
      }
    }
    return { section: s.section, file: P(file), basePath: base ? P(base) : null, folders };
  });
}

function argvValues(argv, flag) {
  const out = [];
  for (let i = 0; i < (argv || []).length; i++) {
    if (argv[i] !== flag) continue;
    for (let j = i + 1; j < argv.length && !String(argv[j]).startsWith('--'); j++) out.push(String(argv[j]));
  }
  return out;
}

// Où ComfyUI cherche ses modèles : --models-directory + chaque yaml de --extra-model-paths-config.
// Hors ligne, on prédit la commande que Mia elle-même utilisera (engine.md §1.3 : avec extra_minimax.yaml).
async function comfyLayout(env, comfy) {
  const live = !!(comfy && comfy.reachable && comfy.argv);
  const argv = live ? comfy.argv : null;
  const modelsDir = P((argv && argvValues(argv, '--models-directory')[0]) || `${env.engineRoot}/models`);
  let yamls = argv ? argvValues(argv, '--extra-model-paths-config').map(P) : [P(`${env.engineRoot}/config/extra_minimax.yaml`)];
  const own = P(`${env.engineRoot}/env/ComfyUI/extra_model_paths.yaml`);   // lu d'office par ComfyUI s'il existe
  if (await isFile(own)) yamls.push(own);
  yamls = [...new Set(yamls)];
  const dirs = [];
  for (const f of [...R.COMFY_FOLDERS, 't2i_adapter', ...R.UNLISTED_COMFY_FOLDERS]) {
    dirs.push({ dir: lowKey(`${modelsDir}/${f}`), folder: R.FOLDER_ALIASES[f] || f, src: 'models' });
  }
  const yamlDirs = [];
  for (const y of yamls) {
    for (const s of await parseModelPathsYaml(y)) {
      for (const [f, list] of Object.entries(s.folders)) {
        for (const d of list) { const e = { dir: lowKey(d), folder: R.FOLDER_ALIASES[f] || f, src: 'yaml', yaml: y }; dirs.push(e); yamlDirs.push(e); }
      }
    }
  }
  // Ce que le yaml du labo DEVRAIT ouvrir (Mia lance toujours ComfyUI avec lui) : sert à expliquer pourquoi
  // MiniMax manque quand le ComfyUI actif a été lancé sans.
  const expectYamlDirs = [];
  for (const s of await parseModelPathsYaml(P(`${env.engineRoot}/config/extra_minimax.yaml`))) {
    for (const [f, list] of Object.entries(s.folders)) for (const d of list) expectYamlDirs.push({ dir: lowKey(d), folder: R.FOLDER_ALIASES[f] || f });
  }
  return { live, modelsDir, yamls, dirs, yamlDirs, expectYamlDirs };
}

// Racines (models.md §5.2) : labo, yaml de ComfyUI, --models-directory, autres racines connues (entraînement,
// autres applis), dossiers de l'utilisateur, dossiers trouvés par une recherche large, puis la recherche large.
async function resolveRoots(env, { extraRoots = [], foundRoots = [], loraFolders = [], loraFiles = [], comfy = null, deep = false } = {}) {
  const roots = [], seen = new Set();
  const add = async (r) => {
    const p = P(r.path);
    if (!p || seen.has(p.toLowerCase()) || !(await (r.file ? isFile(p) : isDir(p)))) return;
    seen.add(p.toLowerCase());
    roots.push({ ...r, path: p });
  };
  const known = R.knownRoots(env);
  await add(known[0]);
  for (const pat of R.extraPathFiles(env)) {
    for (const f of await expandGlob(pat, { files: true })) {
      for (const s of await parseModelPathsYaml(f)) {
        if (!s.basePath) continue;
        const desktop = /comfy-desktop/i.test(s.basePath);
        await add({ path: s.basePath, kind: 'comfy', from: f, app: desktop ? 'ComfyUI Desktop' : null,
          label: desktop ? { fr: 'ComfyUI Desktop', en: 'ComfyUI Desktop' } : { fr: `extra_model_paths (${path.basename(f)})`, en: `extra_model_paths (${path.basename(f)})` } });
      }
    }
  }
  if (comfy && comfy.reachable) {
    for (const d of argvValues(comfy.argv, '--models-directory')) {
      await add({ path: d, kind: 'comfy', label: { fr: 'ComfyUI actif (:8188)', en: 'Running ComfyUI (:8188)' } });
    }
  }
  for (const r of known.slice(1)) {
    if (r.glob) for (const g of await expandGlob(r.glob)) await add({ ...r, path: g });
    else if (r.path) await add(r);
  }
  for (const p of extraRoots || []) await add({ path: p, kind: 'user', label: { fr: 'Mes dossiers de modèles', en: 'My model folders' } });
  // Dossiers de LoRA (SPEC §12.1, réglages) : 4 niveaux au plus, seuls les LoRA y sont retenus.
  for (const p of loraFolders || []) await add({ path: p, kind: 'loras', maxDepth: 4, label: { fr: 'Mes dossiers de LoRA', en: 'My LoRA folders' } });
  // LoRA ajoutés un par un (glisser-déposer) : chaque fichier est sa propre « racine ».
  for (const p of loraFiles || []) await add({ path: p, kind: 'added', file: true, label: { fr: 'Ajouté par toi', en: 'Added by you' } });
  for (const p of foundRoots || []) await add({ path: p, kind: 'found', label: { fr: 'Trouvé sur ce PC', en: 'Found on this PC' } });
  if (deep) {
    for (const b of R.broadRoots(env)) {
      const p = P(b);
      if (!(await isDir(p))) continue;
      roots.push({ path: p, kind: 'found', broad: true, label: { fr: 'Recherche approfondie', en: 'Deep search' } });
    }
  }
  return roots;
}

// Parcours d'une racine : fichiers de poids et téléchargements partiels, sans suivre les jonctions de dossiers.
async function walkRoot(root, out, ctx) {
  const top = root.path;
  const minBytes = root.broad ? R.MIN_BYTES_BROAD : R.MIN_BYTES_ROOT;
  const knownLow = ctx.knownLow;
  const lim = ctx.limit;
  const visit = async (dir, depth) => {
    const ents = await lim(() => readdirSafe(dir));
    ctx.dirs++;
    ctx.progress({ phase: 'walk', done: ctx.dirs, total: null, current: dir });
    const names = new Set(ents.map((e) => e.name.toLowerCase()));
    const subs = [];
    for (const e of ents) {
      const low = e.name.toLowerCase();
      const full = P(path.join(dir, e.name));
      let isD = e.isDirectory(), isF = e.isFile();
      if (e.isSymbolicLink()) {
        // Cache HF : les fichiers des snapshots sont des liens vers blobs/. On suit les liens de FICHIERS seulement.
        try { const st = await fsp.stat(full); isF = st.isFile(); isD = false; } catch { continue; }
      }
      if (isD) {
        if (PRUNE_DIRS.has(low) || depth + 1 > (root.maxDepth ?? 15)) continue;
        if (low === 'blobs' && names.has('snapshots')) continue;          // vu via snapshots/
        const subLow = full.toLowerCase() + '/';
        if (root.kind === 'found' && knownLow.some((k) => subLow.startsWith(k))) continue;
        subs.push(visit(full, depth + 1));
        continue;
      }
      if (!isF) continue;
      const ext = path.extname(low);
      const partial = PARTIAL_EXT.has(ext);
      if (!WEIGHT_EXT.has(ext) && !partial) continue;
      if (root.kind === 'training' && ext !== '.safetensors') continue;
      let st;
      try { st = await fsp.stat(full, { bigint: true }); } catch { continue; }
      if (st.size < BigInt(minBytes)) continue;
      out.push({ path: full, root: top, size: Number(st.size), mtimeNs: String(st.mtimeNs), mtimeMs: Number(st.mtimeMs),
        root_kind: root.kind, root_label: root.label, partial });
    }
    await Promise.all(subs);
  };
  await visit(top, 0);
}

// Racine d'un seul fichier (LoRA ajouté par glisser-déposer) : pas de seuil de taille, pas de parcours.
async function fileRoot(root) {
  const ext = path.extname(root.path).toLowerCase();
  if (!WEIGHT_EXT.has(ext)) return null;
  try {
    const st = await fsp.stat(root.path, { bigint: true });
    if (!st.isFile()) return null;
    return { path: root.path, root: root.path, size: Number(st.size), mtimeNs: String(st.mtimeNs), mtimeMs: Number(st.mtimeMs),
      root_kind: root.kind, root_label: root.label, partial: false };
  } catch { return null; }
}

// Ollama : manifests/ -> couche « model » -> blobs/sha256-* (un GGUF sans extension).
async function ollamaFiles(root) {
  const res = [];
  const walkM = async (d) => {
    for (const e of await readdirSafe(d)) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { await walkM(full); continue; }
      const m = await readJson(full);
      for (const layer of (m && m.layers) || []) {
        if (!String(layer.mediaType || '').endsWith('.model')) continue;
        const blob = path.join(root.path, 'blobs', String(layer.digest || '').replace(':', '-'));
        try {
          const st = await fsp.stat(blob, { bigint: true });
          res.push({ path: P(blob), root: root.path, size: Number(st.size), mtimeNs: String(st.mtimeNs), mtimeMs: Number(st.mtimeMs),
            root_kind: 'ollama', root_label: root.label, partial: false, ollama_tag: P(path.relative(path.join(root.path, 'manifests'), full)) });
        } catch { /* blob absent */ }
      }
    }
  };
  await walkM(path.join(root.path, 'manifests'));
  return res;
}

// =============================================================================================
// 4. ComfyUI : GET seulement, et seulement sur cette machine
// =============================================================================================
function isLocalUrl(u) {
  try { return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(u).hostname); } catch { return false; }
}

async function comfyProbe(url, timeoutMs = COMFY_TIMEOUT_MS) {
  const base = String(url || 'http://127.0.0.1:8188').replace(/\/+$/, '');
  const off = { reachable: false, url: base, version: null, argv: null, folders: {}, listed: [] };
  if (!isLocalUrl(base) || typeof fetch !== 'function') return off;
  const get = async (p) => {
    const r = await fetch(base + p, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  let stats;
  try { stats = await get('/system_stats'); } catch { return off; }
  let listed = [];
  try { listed = await get('/models'); } catch { /* ancienne version : on interroge la liste par défaut */ }
  if (!Array.isArray(listed) || !listed.length) listed = R.COMFY_FOLDERS;
  const want = listed.filter((f) => R.COMFY_FOLDERS.includes(f));
  const folders = {};
  await Promise.all(want.map(async (f) => {
    try { const v = await get('/models/' + encodeURIComponent(f)); if (Array.isArray(v)) folders[f] = v; } catch { /* dossier inconnu */ }
  }));
  const sys = (stats && stats.system) || {};
  const dev = (stats && stats.devices && stats.devices[0]) || null;
  return {
    reachable: true, url: base, version: sys.comfyui_version || null, argv: Array.isArray(sys.argv) ? sys.argv : null,
    folders, listed: Object.keys(folders),
    machine: {
      gpu: dev ? String(dev.name || '').replace(/^cuda:\d+\s*/, '').replace(/\s*:\s*\w+$/, '') : null,
      vramGB: dev && dev.vram_total ? round2(dev.vram_total / 1e9) : null,
      ramGB: sys.ram_total ? round2(sys.ram_total / 1e9) : null,
    },
  };
}

// =============================================================================================
// 5. Regroupements : bundles HF/diffusers, shards, doublons, références des recettes
// =============================================================================================
async function bundleOf(p, root, comfyDirsLow, memo) {
  let d = path.posix.dirname(p);
  const rootLow = root.toLowerCase();
  let foundCfg = null;
  for (let i = 0; i < 4; i++) {
    const dl = d.toLowerCase();
    if (!dl.startsWith(rootLow) || dl === rootLow) break;
    // Un dossier de ComfyUI (loras/, vae/…) n'est jamais un modèle à lui seul, même s'il contient un config.json.
    if (comfyDirsLow.has(dl)) break;
    let ent = memo.get(dl);
    if (!ent) {
      ent = { idx: await isFile(`${d}/model_index.json`), cfg: await isFile(`${d}/config.json`) };
      memo.set(dl, ent);
    }
    if (ent.idx) return d;
    if (!foundCfg && ent.cfg) foundCfg = d;
    d = path.posix.dirname(d);
  }
  return foundCfg;
}

async function bundleIdentity(dir) {
  for (const fn of ['model_index.json', 'config.json']) {
    const cfg = await readJson(`${dir}/${fn}`);
    if (!cfg || typeof cfg !== 'object') continue;
    let arch = cfg._class_name || (Array.isArray(cfg.architectures) ? cfg.architectures[0] : null) || cfg.model_type || cfg.model_name || null;
    if (!arch && cfg.config && typeof cfg.config === 'object') arch = ((cfg.config.__object__ || {}).name) || null;
    return { arch, source: fn };
  }
  return { arch: null, source: null };
}

const hfRepo = (p) => { const m = p.match(/models--([^/\\]+)--([^/\\]+)/); return m ? `${m[1]}/${m[2]}` : null; };

// Noms de fichiers cités par les recettes du labo (workflows, workflows/reference, tool/*.py), mis en cache par
// signature (chemin + taille + mtime) : 2,6 Mo de texte qu'on ne relit que s'ils changent.
async function workflowRefs(env, cached) {
  const files = [];
  for (const pat of [`${env.engineRoot}/workflows/*.json`, `${env.engineRoot}/workflows/reference/*.json`, `${env.engineRoot}/tool/*.py`]) {
    files.push(...await expandGlob(pat, { files: true }));
  }
  const stats = await Promise.all(files.map(async (f) => { try { const s = await fsp.stat(f); return `${f}|${s.size}|${s.mtimeMs}`; } catch { return f; } }));
  const sig = sha1(stats.join('\n')).slice(0, 16);
  if (cached && cached.sig === sig && cached.map) return cached;
  const rx = /["']([^"'/\\]+\.(?:safetensors|pth|pt|gguf|ckpt))["']/g;
  const map = {};
  for (const f of files) {
    let txt;
    try { txt = await fsp.readFile(f, 'utf8'); } catch { continue; }
    const rel = P(path.relative(env.engineRoot, f));
    let m;
    while ((m = rx.exec(txt))) { const s = (map[m[1]] = map[m[1]] || []); if (!s.includes(rel)) s.push(rel); }
  }
  for (const k of Object.keys(map)) map[k].sort();
  return { sig, map };
}

// =============================================================================================
// 6. Présentation : fichiers -> modèles lisibles par quelqu'un qui n'est pas technicien
// =============================================================================================
function matchWhen(w, r) {
  const ok = (val, cond) => {
    if (cond == null) return true;
    if (cond instanceof RegExp) return cond.test(String(val || '').toLowerCase());
    if (Array.isArray(cond)) return cond.includes(val);
    return val === cond;
  };
  return ok(r.family, w.family) && ok(r.role, w.role) && ok(r.rule, w.rule)
    && (!w.name || w.name.test(r.nameLow)) && (!w.path || w.path.test(r.pathLow))
    && (!w.flag || (r.flags || []).includes(w.flag)) && (w.bundle == null || !!r.isBundle === w.bundle);
}
const catalogFor = (r) => R.CATALOG.find((c) => matchWhen(c.when, r)) || null;

function pretty(name) {
  return String(name).replace(/\.(safetensors|sft|gguf|ckpt|pt|pth|bin|onnx|task|tflite|pt2)$/i, '')
    .replace(/\.fp(16|32)$/i, '').replace(/[_]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 64);
}

// Nom lisible d'un fichier sans entrée de catalogue : « model.safetensors » ne dit rien, son dossier oui.
// On remonte le chemin relatif à la racine en sautant les segments techniques (hub/, snapshots/<rev>/…).
const GENERIC_SEG = new Set(['model', 'models', 'adapter model', 'diffusion pytorch model', 'pytorch model', 'transformer',
  'text encoder', 'vae', 'unet', 'base', 'weights', 'checkpoint', 'checkpoints', 'cameras', 'nf4', 'fp8', 'fp16', 'bf16']);
const DROP_SEG = new Set(['model', 'models', 'adapter model', 'diffusion pytorch model', 'pytorch model', 'weights']);
function genericLabel(p, rootPath) {
  const rel = rootPath && under(p.toLowerCase(), rootPath.toLowerCase()) ? p.slice(rootPath.length + 1) : path.posix.basename(p);
  const segs = rel.split('/').map((s) => {
    const repo = s.match(/^models--[^-]+(?:-[^-]+)*?--(.+)$/);
    return pretty(repo ? repo[1] : s);
  }).filter((s) => s && !/^(hub|hf|snapshots|ckpts(?: fp8)?|sources|[0-9a-f]{40})$/i.test(s));
  if (!segs.length) return pretty(path.posix.basename(p));
  const pick = [segs.pop()];
  while (GENERIC_SEG.has(pick[0].toLowerCase()) && segs.length) pick.unshift(segs.pop());
  const kept = pick.length > 1 ? pick.filter((s) => !DROP_SEG.has(s.toLowerCase())) : pick;
  return (kept.length ? kept : pick).join(' · ').slice(0, 64);
}
// Nom lisible d'un téléchargement interrompu : un fichier du cache Hugging Face s'appelle par son empreinte
// (« 4SfAgk9U…incomplete ») ; son dossier dit à quoi il servait (« marigold-normals · unet »).
function partialName(p) {
  const segs = P(p).split('/');
  const ci = segs.findIndex((s) => s.toLowerCase() === '.cache');
  if (ci > 0) {
    const di = segs.findIndex((s, i) => i > ci && s.toLowerCase() === 'download');
    const sub = di > 0 && di < segs.length - 2 ? segs.slice(di + 1, segs.length - 1).join(' / ') : '';
    return [segs[ci - 1], sub].filter(Boolean).join(' · ').slice(0, 64);
  }
  return pretty(segs[segs.length - 1].replace(/\.(part|partial|download|crdownload|incomplete)$/i, ''));
}
const modelId = (p) => sha1(lowKey(p)).slice(0, 12);
const LIC_ORDER = { ok: 0, rd: 1, trial: 2, forbidden: 9 };

function selectable(m, caps) {
  if (!m || m.status !== 'ready' || m.license === 'forbidden') return false;
  if (m.engine === 'comfy' && m.comfy && m.comfy.visible === false) return false;
  const want = Array.isArray(caps) ? caps : caps ? [caps] : [];
  if (want.length && !want.some((c) => (m.caps || []).includes(c))) return false;
  return true;
}

// Rattache chaque fichier à son dossier ComfyUI et dit si le ComfyUI actif (ou celui que Mia lancera) le voit.
function comfyPlace(rec, layout, comfy, rootPath) {
  const pl = rec.pathLow;
  let best = null;
  for (const d of layout.dirs) if (under(pl, d.dir) && (!best || d.dir.length > best.dir.length)) best = d;
  if (!best) {
    // Prévu par le yaml du labo, mais le ComfyUI actif ne le lit pas : on garde la place pour dire pourquoi.
    let y = null;
    for (const d of layout.expectYamlDirs || []) if (under(pl, d.dir) && (!y || d.dir.length > y.dir.length)) y = d;
    if (y) return { folder: y.folder, name: rec.path.slice(y.dir.length + 1).replace(/\//g, '\\'), visible: false, source: 'live', missingYaml: true };
    // Sinon, dans une racine de type ComfyUI, le 1er dossier dit à quoi le fichier servirait.
    if (rootPath) {
      const rel = rec.path.slice(rootPath.length + 1);
      const seg = rel.split('/')[0].toLowerCase();
      const f = R.FOLDER_ALIASES[seg] || seg;
      if (rel.includes('/') && (R.COMFY_FOLDERS.includes(f) || R.UNLISTED_COMFY_FOLDERS.includes(f))) {
        return { folder: f, name: rel.slice(seg.length + 1).replace(/\//g, '\\'), visible: false, source: comfy && comfy.reachable ? 'live' : 'predicted' };
      }
    }
    return null;
  }
  const rel = rec.path.slice(best.dir.length + 1);
  const name = rel.replace(/\//g, '\\');                 // ComfyUI sous Windows liste « sous\fichier »
  const unlisted = R.UNLISTED_COMFY_FOLDERS.includes(best.folder);
  if (comfy && comfy.reachable && !unlisted) {
    const list = comfy.folders[best.folder];
    if (Array.isArray(list)) {
      const nl = name.toLowerCase().replace(/\//g, '\\');
      const hit = list.find((n) => String(n).toLowerCase().replace(/\//g, '\\') === nl);
      return { folder: best.folder, name: hit || name, visible: !!hit, source: 'live', yaml: best.yaml || null };
    }
  }
  return { folder: best.folder, name, visible: true, source: comfy && comfy.reachable ? 'disk' : 'predicted', yaml: best.yaml || null };
}

function buildModels(records, bundles, ctx) {
  const { layout, comfy, rootsByPath } = ctx;
  const units = [];
  const bundled = new Map();
  for (const b of bundles) {
    const files = records.filter((r) => r.bundle === b.path && !r.partial);
    if (!files.length) continue;
    files.forEach((r) => bundled.set(r.pathLow, b));
    units.push({ kind: 'bundle', b, files });
  }
  for (const r of records) if (!r.partial && !bundled.has(r.pathLow)) units.push({ kind: 'file', r, files: [r] });

  const models = [];
  const byRecord = new Map();
  for (const u of units) {
    const main = u.files.reduce((a, b) => (b.size > a.size ? b : a));
    const root = rootsByPath.get(lowKey(main.root)) || { kind: 'found', label: null };
    const isB = u.kind === 'bundle';
    const p = isB ? u.b.path : main.path;
    const sizeBytes = u.files.reduce((s, r) => s + r.size, 0);
    // Une famille lue dans config.json fait foi pour un dossier ; sinon celle de son plus gros fichier.
    const family = (isB && u.b.family) || main.family || null;
    const role = (isB && u.b.role) || main.role || 'unknown';
    const view = { family, role, rule: main.rule, flags: main.flags, nameLow: (isB ? path.posix.basename(p) : main.name).toLowerCase(),
      pathLow: p.toLowerCase(), isBundle: isB };
    const id = modelId(p);
    let cat = catalogFor(view);
    // Une LoRA LTX de Quentin (personnage ou lieu), reconnue par le nom.
    let ident = null;
    if (role === 'lora' && (family === 'LTX-2.x' || main.rule === 'ltxv')) ident = R.IDENTITY.find((i) => i.test.test(view.pathLow)) || null;
    if (ident) cat = null;
    const comfyPos = comfyPlace(main, layout, comfy, root.kind === 'comfy' ? root.path : null);
    const m = {
      id, key: ident ? 'identity' : (cat ? cat.key : null), kind: u.kind,
      path: p, file: isB ? path.posix.basename(p) : main.name,
      sizeGB: gb(sizeBytes), family, role, variant: main.variant || null, quant: main.quant || null,
      quantClass: R.quantClass(main.quant),
      // Paramètres : ceux du fichier, ou pour un dossier la somme des seules variantes utiles (pas fp16 + fp32).
      params: (() => {
        const src = isB && u.b.useful ? u.files.filter((r) => u.b.useful.has(r.pathLow)) : [main];
        const n = src.reduce((s, r) => s + (r.params || 0), 0);
        return n ? round2(n / 1e9) : null;
      })(),
      rank: main.rank || null,
      label: null, desc: null, caps: [], default: [],
      comfy: comfyPos ? { folder: comfyPos.folder, name: comfyPos.name, visible: comfyPos.visible, source: comfyPos.source } : null,
      engine: null, license: 'ok', licenseNote: R.LIC.unknown, vramGB: null, speed: null, quality: null,
      status: 'ready', statusNote: null, app: null, hidden: false, group: 'other', part: null,
      tier: null, trigger: null, identity: null, genre: null, trainingStep: null, duplicateOf: null, missingParts: [], parts: null,
      baseKey: null,
      root: { path: root.path || main.root, kind: root.kind, label: root.label || null },
      usedBy: [...new Set(u.files.flatMap((r) => r.used_by || []))],
      files: isB ? u.files.map((r) => r.path.slice(p.length + 1)) : null,
      mtime: Math.max(...u.files.map((r) => r.mtimeMs || 0)) || null,
    };
    if (isB) {
      m.arch = u.b.arch || null;
      if (u.b.usefulBytes && u.b.usefulBytes < sizeBytes) m.usefulGB = gb(u.b.usefulBytes);
      if (u.b.hf_repo) m.hfRepo = u.b.hf_repo;
    }
    // --- libellés, capacités, licence, mémoire ---
    if (ident) {
      const step = (main.name.match(/(?:^|[_\-.])0*(\d{3,6})\.safetensors$/i) || [])[1];
      m.identity = ident.key; m.trigger = ident.trigger; m.genre = ident.kind;
      m.label = { ...ident.label };
      m.desc = { ...R.IDENTITY_DESC[ident.kind] };
      m.caps = ['lora'];
      m.license = 'ok'; m.licenseNote = R.LIC.own; m.vramGB = round2(m.sizeGB);
      if (root.kind === 'training' && step) {
        m.trainingStep = Number(step);
        m.label = { fr: `${ident.label.fr} · étape ${Number(step).toLocaleString('fr-FR')}`, en: `${ident.label.en} · step ${Number(step).toLocaleString('en-US')}` };
      }
    } else if (cat) {
      m.label = cat.label ? { ...cat.label } : null;
      m.desc = cat.desc ? { ...cat.desc } : null;
      m.caps = [...(cat.caps || [])];
      m.license = cat.license || 'ok';
      m.licenseNote = cat.licenseNote || (m.license === 'ok' ? R.LIC.unknown : null);
      m.vramGB = cat.vramGB != null ? cat.vramGB : null;
      m.speed = cat.speed ?? null; m.quality = cat.quality ?? null;
      m.hidden = !!cat.hidden; m.part = cat.part || null; m.tier = cat.tier || null;
      if (cat.engine) m.engine = cat.engine;
    } else if (R.INTERNAL_ROLES.has(role)) {
      m.hidden = true; m.part = role;
    }
    // Pour une autre application, le nom de son fichier parle mieux que notre catalogue (deux « BiRefNet »…).
    if (!m.label || root.kind === 'app' || root.kind === 'ollama') {
      const nm = genericLabel(p, root.path || main.root);
      m.label = { fr: nm, en: nm };
    }
    if (!m.desc) {
      const d = R.TASK_DESC[main.task || main.base_task] || R.ROLE_DESC[role] || R.ROLE_DESC.unknown;
      m.desc = { ...d };
    }
    if (m.vramGB == null) m.vramGB = round2(m.sizeGB + (role === 'diffusion_model' || role === 'checkpoint' ? 4 : 0.5));
    // --- moteur d'exécution ---
    if (root.kind === 'app' || root.kind === 'ollama') m.engine = 'app';
    else if (!m.engine) m.engine = m.comfy ? 'comfy' : null;
    // --- état ---
    const note = (n) => { m.statusNote = n ? { ...n } : null; };
    // Ce qui appartient à une autre application n'est ni proposé ni rangé parmi les pièces internes de Mia.
    if (root.kind === 'app' || root.kind === 'ollama') {
      m.status = 'other-app'; m.app = root.app || null; m.caps = []; m.hidden = false;
    } else if (comfyPos && comfyPos.missingYaml) {
      // MiniMax vit sur C: et n'est vu que via extra_minimax.yaml (models.md §7.3) : on dit pourquoi il manque.
      m.status = 'unused'; note(R.NOTES.noExtraYaml);
    } else if (root.kind === 'comfy' && root.app && m.comfy && m.comfy.visible === false) {
      m.status = 'other-app'; m.app = root.app; m.caps = []; m.engine = 'app'; m.hidden = false;
    } else if (main.format === 'illisible') {
      m.status = 'unused'; note(R.NOTES.unreadable);
    } else if (root.kind === 'training') {
      m.status = 'unused'; note(R.NOTES.training);
    } else if (lowKey(root.path || '') === lowKey(`${ctx.env.engineRoot}/env/ComfyUI/models`)) {
      m.status = 'unused'; note(R.NOTES.internalComfy);
    } else if (m.engine === 'comfy' && m.comfy && m.comfy.visible === false) {
      m.status = 'unused'; note(R.NOTES.notVisible);
    } else if (m.engine === 'comfy' && !m.comfy) {
      m.status = 'unused'; note(R.NOTES.notVisible);
    } else if (root.kind === 'comfy' && !m.comfy && m.engine !== 'worker' && !R.INTERNAL_ROLES.has(role)) {
      m.status = 'unused'; note(R.NOTES.notUsed);
    } else if (cat && cat.unused) {
      m.status = 'unused'; note(R.NOTES.notUsed);
    } else if (!cat && !ident && !m.hidden) {
      m.status = 'unused'; note(root.kind === 'user' ? R.NOTES.userRoot : root.kind === 'found' ? R.NOTES.found : R.NOTES.notUsed);
    }
    // « Prêt » veut toujours dire « utilisable » : un modèle interdit par sa licence n'est jamais prêt.
    if (m.license === 'forbidden' && m.status === 'ready') { m.status = 'unused'; note(R.NOTES.forbidden); }
    if (role === 'diffusion_model' || role === 'checkpoint') m.baseKey = R.baseKeyOf(family, m.variant);
    m._cat = cat;
    m._main = main;
    u.files.forEach((r) => byRecord.set(r.pathLow, m));
    models.push(m);
  }
  return { models, byRecord };
}

// LoRA (SPEC §12.3) : à qui ils servent (`loraFor`), leur genre, leur origine, leur nom choisi par Quentin, et
// s'ils sont utilisables. Ceux du labo sont vus par ComfyUI tels quels ; ceux ajoutés à la main ou trouvés dans
// ses dossiers de LoRA sont prêts aussi : ensureLora les place dans models\loras\mia au premier calcul.
function applyLoras(models, ctx) {
  const labLow = lowKey(`${ctx.env.engineRoot}/models`);
  const reg = ctx.registry || new Map();
  const placements = ctx.placements || new Map();
  const readyBases = new Set(models.filter((m) => m.baseKey && m.status === 'ready').map((m) => m.baseKey));
  for (const m of models) {
    if (m.role !== 'lora' || m.status === 'other-app') continue;
    const main = m._main || {};
    m.loraFor = R.baseKeyOf(m.family, m.variant);
    m.loraForLabel = m.loraFor ? R.baseLabel(m.loraFor, false) : null;
    const cat = m._cat;
    if (cat && cat.part) { m.loraKind = cat.part === 'mode' ? 'control' : 'technical'; continue; }
    if (cat && cat.license === 'forbidden') continue;              // un LoRA d'un modèle exclu reste exclu
    const inLab = under(m.path.toLowerCase(), labLow);
    const entry = reg.get(lowKey(m.path)) || null;
    const origin = inLab ? 'engine' : entry ? (entry.origin === 'folder' ? 'folder' : 'added')
      : m.root.kind === 'loras' ? 'folder' : m.root.kind === 'added' ? 'added' : m.root.kind === 'training' ? 'training' : null;
    if (!origin) continue;                                         // dossier quelconque, recherche large : « Autres modèles »
    const hints = main.name_hints || {};
    // Un LoRA technique inconnu du catalogue dans le labo (accélérateur, mode) : pièce interne, jamais proposé.
    if (origin === 'engine' && !m.identity && !entry && (hints.speed || hints.adapter)) {
      m.hidden = true; m.part = hints.adapter ? 'mode' : 'speedup'; m.caps = [];
      m.loraKind = hints.adapter ? 'control' : 'technical';
      continue;
    }
    m.origin = origin;
    m.source = m.path;
    m.loraId = entry ? entry.id : null;
    m.caps = ['lora'];
    m.hidden = false; m.part = null;
    if (entry && typeof entry.trigger === 'string') m.trigger = entry.trigger.trim() || null;
    else if (!m.trigger && main.lora_trigger) m.trigger = main.lora_trigger;
    // Genre : celui choisi par Quentin, sinon celui du personnage reconnu, sinon deviné d'après le nom.
    m.genre = (entry && R.GENRES[entry.kind] ? entry.kind : null) || m.genre
      || R.guessGenre(`${(entry && entry.name) || ''} ${main.lora_title || ''} ${m.trigger || ''} ${m.file}`);
    m.loraKind = m.genre === 'character' || m.genre === 'place' ? 'identity' : 'style';
    if (entry && entry.name) m.label = { fr: entry.name, en: entry.name };
    else if (!m.identity) { const nm = R.loraNameFromFile(m.file); m.label = { fr: nm, en: nm }; }
    // Étape d'entraînement : son numéro, qu'il y ait un personnage reconnu ou non — sinon « Mara »
    // s'afficherait trois fois sans qu'on puisse les distinguer (la bibliothèque les range aussi d'après lui).
    if (origin === 'training') {
      const step = (String(m.file || '').match(/(?:^|[_\-. ])0*(\d{3,6})\.(?:safetensors|sft|ckpt|pt|pth|bin)$/i) || [])[1];
      if (step) {
        m.trainingStep = Number(step);
        const fr = ` · étape ${m.trainingStep.toLocaleString('fr-FR')}`, en = ` · step ${m.trainingStep.toLocaleString('en-US')}`;
        if (!String(m.label.fr).endsWith(fr)) m.label = { fr: `${m.label.fr}${fr}`, en: `${m.label.en}${en}` };
      }
    }
    if (!m.identity || entry) m.desc = R.loraDesc(m.genre, m.loraFor);
    if (!m.identity && !cat) { m.license = 'ok'; m.licenseNote = { ...R.LIC.unknown }; }
    m.vramGB = round2(m.sizeGB);
    m.placed = null;
    if (origin === 'training') continue;                           // étapes d'entraînement : listées, pas proposées
    if (main.format === 'illisible') continue;
    if (origin === 'engine') {
      m.placed = m.comfy && m.comfy.visible !== false ? m.comfy.name : null;
      if (m.placed) { m.status = 'ready'; m.statusNote = null; }
    } else {
      // Placé plus tôt par Mia (même contenu dans models\loras\mia) ou pas encore : prêt dans les deux cas.
      m.placed = (main.fingerprint && placements.get(main.fingerprint)) || null;
      m.comfy = m.placed ? { folder: 'loras', name: m.placed, visible: true, source: 'mia' } : null;
      m.engine = 'comfy';
      m.status = 'ready'; m.statusNote = null;
    }
    if (m.status === 'ready') {
      if (!m.loraFor) m.statusNote = { ...R.NOTES.loraUnknownBase };
      else if (!readyBases.has(m.loraFor)) m.statusNote = R.loraNoBaseNote(m.loraFor);
    }
  }
}

// Doublons : la copie « canonique » est celle que le moteur lit (racine du labo, dossier natif) ; les autres
// passent en « doublon ». Une copie dans une autre appli reste « autre appli » mais connaît son original.
function markDuplicates(models, records, byRecord, ctx) {
  const groups = new Map();
  for (const r of records) {
    if (!r.fingerprint || r.partial) continue;
    const g = groups.get(r.fingerprint) || [];
    g.push(r);
    groups.set(r.fingerprint, g);
  }
  const dups = [];
  const kindRank = { comfy: 0, user: 1, loras: 1, added: 1, found: 2, hf_cache: 3, training: 4, app: 5, ollama: 5 };
  const labLow = lowKey(`${ctx.env.engineRoot}/models`);
  for (const [fpr, g] of groups) {
    const ms = [...new Set(g.map((r) => byRecord.get(r.pathLow)).filter(Boolean))];
    if (ms.length < 2) continue;
    const score = (m) => [
      m.status === 'ready' ? 0 : m.status === 'incomplete' ? 1 : 2,
      kindRank[m.root.kind] ?? 6,
      under(m.path.toLowerCase(), labLow) ? 0 : 1,
      m.comfy ? (R.FOLDER_RANK.indexOf(m.comfy.folder) + 1 || 99) : 99,
      m.path.length,
    ];
    ms.sort((a, b) => { const x = score(a), y = score(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; });
    const keep = ms[0];
    for (const m of ms.slice(1)) {
      m.duplicateOf = keep.id;
      if (m.status === 'other-app') continue;
      const promoted = m.root.kind === 'training';
      m.status = 'duplicate';
      m.statusNote = { ...(promoted ? R.NOTES.promoted : R.NOTES.duplicate) };
      if (!promoted && m.role === 'lora' && keep.role === 'lora') {
        m.statusNote = { fr: `Copie identique de « ${keep.label.fr} », déjà dans Mia.`, en: `Identical copy of “${keep.label.en}”, already in Mia.` };
      }
    }
    dups.push({ sizeGB: gb(Number(fpr.split(':')[0])), ids: ms.map((m) => m.id), paths: ms.map((m) => m.path) });
  }
  return dups;
}

// Pièces internes requises (encodeur de texte, VAE…) et capacités conditionnelles (3D → réel).
// Dossier où ranger un fichier attendu, en chemin Windows complet (« <moteur>\models\text_encoders »).
const folderPath = (modelsDir, folder) => `${P(modelsDir)}/${folder}`.replace(/\//g, '\\');
const lc = (s) => String(s || '').charAt(0).toLowerCase() + String(s || '').slice(1);

// « Il manque une pièce : encodeur de texte Wan (fichier umt5_xxl…, dossier D:\…\text_encoders). »
function missingNote(miss, modelsDir) {
  const one = (x, l) => {
    const name = lc(x.label[l]);
    if (!x.file) return name;
    return l === 'fr' ? `${name} (fichier ${x.file}, dossier ${folderPath(modelsDir, x.folder)})`
      : `${name} (file ${x.file}, folder ${folderPath(modelsDir, x.folder)})`;
  };
  if (miss.length === 1) {
    return { fr: `Il manque une pièce : ${one(miss[0], 'fr')}.`, en: `One part is missing: ${one(miss[0], 'en')}.` };
  }
  return { fr: `Il manque ${miss.length} pièces : ${miss.map((x) => one(x, 'fr')).join(' ; ')}.`,
    en: `${miss.length} parts are missing: ${miss.map((x) => one(x, 'en')).join('; ')}.` };
}

function resolveParts(models, modelsDir) {
  const readyByKey = new Map();
  for (const m of models) {
    if (!m.key || m.status !== 'ready') continue;
    if (m.engine === 'comfy' && m.comfy && m.comfy.visible === false) continue;
    if (!readyByKey.has(m.key)) readyByKey.set(m.key, m);
  }
  const byKey = new Map(R.CATALOG.map((c) => [c.key, c]));
  for (const m of models) {
    const cat = m._cat;
    if (!cat) continue;
    if (cat.needs && m.status === 'ready') {
      const parts = {}, miss = [];
      for (const k of cat.needs) {
        const part = readyByKey.get(k);
        if (part) { parts[k] = { id: part.id, file: part.file, comfyName: part.comfy ? part.comfy.name : null }; continue; }
        const c = byKey.get(k);
        miss.push({ key: k, label: c ? { ...c.label } : { fr: k, en: k }, file: c && c.expect ? c.expect.file : null,
          folder: c && c.expect ? c.expect.folder : null, sizeGB: c && c.expect ? c.expect.sizeGB : null });
      }
      m.parts = parts;
      if (miss.length) {
        m.status = 'incomplete';
        m.missingParts = miss;
        m.statusNote = missingNote(miss, modelsDir);
      }
    }
    for (const c of cat.condCaps || []) {
      const part = readyByKey.get(c.needs);
      if (part && !m.caps.includes(c.cap)) {
        m.caps.push(c.cap);
        m.parts = m.parts || {};
        m.parts[c.needs] = { id: part.id, file: part.file, comfyName: part.comfy ? part.comfy.name : null };
      }
    }
  }
}

const GROUP_ORDER = ['video', 'image', 'depth', 'cutout', 'upscale', 'loras', 'other', 'internal', 'apps'];
const CAP_GROUP = Object.fromEntries(R.CAPS.map((c) => [c.id, c.group]));

function assignGroups(models) {
  for (const m of models) {
    if (m.status === 'other-app') m.group = 'apps';
    else if (m.hidden) m.group = 'internal';
    else if (m.role === 'lora' && (m.caps || []).includes('lora')) m.group = 'loras';
    else if (m.caps.length) m.group = CAP_GROUP[m.caps[0]] || 'other';
    else m.group = 'other';
  }
}

// Fichiers attendus d'une capacité, avec le dossier complet où les ranger.
const filesFor = (list, modelsDir) => (list || []).map((f) => ({ ...f, dir: folderPath(modelsDir, f.folder) }));

function capabilities(models, modelsDir) {
  const caps = {}, missing = [];
  for (const c of R.CAPS) {
    const prefer = (m) => { const i = c.prefer.indexOf(m.key); return i < 0 ? 99 : i; };
    const opts = models.filter((m) => selectable(m, [c.id])).sort((a, b) =>
      prefer(a) - prefer(b) || (LIC_ORDER[a.license] ?? 5) - (LIC_ORDER[b.license] ?? 5)
      || (b.quality || 0) - (a.quality || 0) || a.sizeGB - b.sizeGB || a.label.fr.localeCompare(b.label.fr, 'fr'));
    const def = c.noDefault ? null : (opts[0] ? opts[0].id : null);
    if (def) models.find((m) => m.id === def).default.push(c.id);
    const fast = opts.find((m) => m.tier === 'fast');
    caps[c.id] = { available: opts.length > 0, default: def, options: opts.map((m) => m.id), fast: fast ? fast.id : null,
      label: { ...c.label }, optional: !!c.optional };
    if (!opts.length && !c.optional) {
      // Message précis : modèle présent mais incomplet, ou invisible de ComfyUI, sinon le message du catalogue.
      // `what` reste court (il s'affiche dans un sélecteur) ; `files` dit quoi ajouter et où.
      const cands = models.filter((m) => m.license !== 'forbidden' && m.status !== 'other-app' && m.status !== 'duplicate'
        && (m.caps.includes(c.id) || (m._cat && (m._cat.condCaps || []).some((x) => x.cap === c.id))));
      const inc = cands.find((m) => m.status === 'incomplete');
      const inv = cands.find((m) => m.status === 'unused' && m.statusNote);
      const item = { caps: [c.id], name: c.name ? { ...c.name } : null, what: { ...c.missing }, files: filesFor(c.files, modelsDir),
        download: !!c.download, sizeGB: c.sizeGB || null };
      if (inc) {
        item.name = { ...inc.label };
        item.what = { fr: `${inc.label.fr} est incomplet.`, en: `${inc.label.en} is incomplete.` };
        item.detail = { ...inc.statusNote };
        item.files = filesFor((inc.missingParts || []).filter((x) => x.file), modelsDir);
        item.model = inc.id;
        item.download = false;
      } else if (inv && c.id !== '3d-to-real' && c.id !== 'guided-video') {
        item.name = { ...inv.label };
        item.what = { fr: `${inv.label.fr} : ${lc(inv.statusNote.fr)}`, en: `${inv.label.en}: ${lc(inv.statusNote.en)}` };
        item.files = [];
        item.model = inv.id;
        item.download = false;
      }
      // Ce qui est déjà sur le disque n'est pas à ajouter (ex. LTX présent, seul son mode manque).
      if (!inc) item.files = item.files.filter((f) => !models.some((m) => m.file === f.file && m.status !== 'other-app'));
      missing.push(item);
    }
  }
  return { caps, missing };
}

// Ordre d'affichage : section, puis capacité principale (les variantes de LTX restent ensemble), puis le choix
// « Auto » en tête, puis l'état, la qualité et le nom.
const CAP_ORDER = R.CAPS.map((c) => c.id);
function sortModels(models) {
  const g = (m) => GROUP_ORDER.indexOf(m.group);
  const ci = (m) => { const i = CAP_ORDER.indexOf((m.caps || [])[0]); return i < 0 ? 99 : i; };
  const st = { ready: 0, incomplete: 1, unused: 2, duplicate: 3, 'other-app': 4 };
  models.sort((a, b) => g(a) - g(b) || ci(a) - ci(b) || (b.default.length > 0) - (a.default.length > 0) || st[a.status] - st[b.status]
    || (a.trainingStep || 0) - (b.trainingStep || 0) || (b.quality || 0) - (a.quality || 0)
    || a.label.fr.localeCompare(b.label.fr, 'fr'));
}

// =============================================================================================
// 7. scan(opts) — fonction pure, utilisable sans Electron
// =============================================================================================
function emptyCache() { return { version: CACHE_VERSION, catalogRev: CATALOG_REV, files: {}, foundRoots: [], refs: null, inventory: null }; }

async function loadCache(file) {
  try {
    const c = JSON.parse(await fsp.readFile(file, 'utf8'));
    // Catalogue changé : l'identification des fichiers reste bonne, seul l'inventaire est à refaire.
    if (c && c.version === CACHE_VERSION) return { ...emptyCache(), ...c, inventory: c.catalogRev === CATALOG_REV ? c.inventory : null };
    // Règles changées : on garde seulement les dossiers trouvés par une recherche large (ils restent valables).
    return { ...emptyCache(), foundRoots: (c && Array.isArray(c.foundRoots)) ? c.foundRoots : [] };
  } catch { return emptyCache(); }
}

async function saveCache(file, cache) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(cache));
  await fsp.rename(tmp, file);
}

/**
 * opts : { engineRoot, extraRoots[], loraFolders[], loras (registre loras.json), comfyUrl, deep, force,
 *          cache | cachePath, writeCache, onProgress, comfy: false | état }
 * → { inventory, records, cache }
 */
async function scan(opts = {}) {
  const t0 = now();
  const env = makeEnv(opts);
  const progress = throttled(opts.onProgress);
  const cache = opts.cache ? { ...emptyCache(), ...opts.cache } : (opts.cachePath ? await loadCache(opts.cachePath) : emptyCache());
  const oldFiles = opts.force ? {} : (cache.files || {});

  progress({ phase: 'comfy', done: 0, total: null, current: null });
  let comfyMs = 0;
  const tC = now();
  // opts.comfy : false = ne pas interroger ComfyUI ; un objet = état déjà sondé (tests, ou sonde partagée).
  const comfyP = (opts.comfy === false ? Promise.resolve({ reachable: false, url: opts.comfyUrl || null, folders: {}, listed: [] })
    : opts.comfy && typeof opts.comfy === 'object' ? Promise.resolve(opts.comfy)
    : comfyProbe(opts.comfyUrl || 'http://127.0.0.1:8188', opts.comfyTimeoutMs || COMFY_TIMEOUT_MS))
    .then((c) => { comfyMs = now() - tC; return c; });

  // Les racines ne dépendent de ComfyUI que pour --models-directory (presque toujours la racine du labo) :
  // on parcourt pendant que la sonde répond, puis on complète si besoin.
  const walkCtx = { dirs: 0, progress, limit: limiter(opts.deep ? 16 : 32), knownLow: [] };
  const files = [];
  const walked = new Set();
  const walkAll = async (roots) => {
    walkCtx.knownLow = roots.filter((r) => !r.broad && !r.file).map((r) => r.path.toLowerCase().replace(/\/?$/, '/'));
    for (const r of roots) {
      const k = r.path.toLowerCase();
      if (walked.has(k)) continue;
      walked.add(k);
      if (r.kind === 'ollama') files.push(...await ollamaFiles(r));
      else if (r.file) { const one = await fileRoot(r); if (one) files.push(one); }
      else await walkRoot(r, files, walkCtx);
    }
  };
  // Registre des LoRA (SPEC §12.3) : ajouts par glisser-déposer, noms et mots déclencheurs choisis, LoRA retirés.
  const registry = new Map();
  for (const e of Array.isArray(opts.loras) ? opts.loras : []) if (e && e.source) registry.set(lowKey(e.source), e);
  const ignored = new Set([...registry.entries()].filter(([, e]) => e.ignored).map(([k]) => k));
  const loraFiles = [...registry.values()].filter((e) => !e.ignored && e.origin === 'added').map((e) => e.source);
  const rootOpts = { extraRoots: opts.extraRoots, foundRoots: cache.foundRoots, loraFolders: opts.loraFolders, loraFiles, deep: opts.deep };
  const tWalk0 = now();
  let roots = await resolveRoots(env, rootOpts);
  await walkAll(roots);
  const comfy = await comfyP;
  // ComfyUI actif lancé sur un autre dossier de modèles que celui du labo : on le parcourt aussi.
  if (comfy.reachable) {
    const extra = argvValues(comfy.argv, '--models-directory').map(P).filter((d) => !walked.has(d.toLowerCase()));
    if (extra.length) {
      roots = await resolveRoots(env, { ...rootOpts, comfy });
      await walkAll(roots);
    }
  }
  const walkMs = now() - tWalk0;

  // Dédoublonnage des fichiers vus par deux racines imbriquées : la première racine (la plus prioritaire) gagne.
  const seenFiles = new Set();
  const uniq = [];
  for (const f of files) { const k = f.path.toLowerCase(); if (!seenFiles.has(k)) { seenFiles.add(k); uniq.push(f); } }

  // --- identification (cache par chemin + taille + mtime en ns) ---
  const tId = now();
  const newFiles = {};
  let hits = 0, misses = 0;
  const todo = [];
  const infos = new Map();
  for (const f of uniq) {
    const key = f.path.toLowerCase();
    const c = oldFiles[key];
    if (f.partial) infos.set(key, { format: 'partiel' });
    else if (c && c.size === f.size && c.mtimeNs === f.mtimeNs && c.info) { infos.set(key, c.info); hits++; }
    else todo.push(f);
  }
  const lim = limiter(IDENTIFY_CONCURRENCY);
  let done = 0;
  await Promise.all(todo.map((f) => lim(async () => {
    const rel = f.path.slice(f.root.length).replace(/^\/+/, '');
    let info;
    try { info = (await identify(f.path, f.size, rel)) || { format: '?' }; } catch (e) { info = { format: 'illisible', error: String(e.message || e).slice(0, 160) }; }
    infos.set(f.path.toLowerCase(), info);
    misses++; done++;
    progress({ phase: 'identify', done, total: todo.length, current: path.basename(f.path) });
  })));
  const identifyMs = now() - tId;

  progress({ phase: 'group', done: 0, total: null, current: null });
  const records = [];
  for (const f of uniq) {
    const key = f.path.toLowerCase();
    const info = infos.get(key) || { format: '?' };
    newFiles[key] = { size: f.size, mtimeNs: f.mtimeNs, info };
    if (info.not_a_model) continue;
    const rec = { ...f, ...info };
    rec.name = path.posix.basename(f.path);
    rec.pathLow = key;
    rec.size_gb = gb(f.size);
    records.push(rec);
  }

  // Racine de chaque fichier = la plus longue racine qui le contient (les racines peuvent s'imbriquer).
  const rootsSorted = [...roots].sort((a, b) => b.path.length - a.path.length);
  for (const rec of records) {
    const r = rootsSorted.find((x) => under(rec.pathLow, x.path.toLowerCase()) || rec.pathLow === x.path.toLowerCase());
    if (r) rec.root = r.path;
    const repo = hfRepo(rec.path);
    if (repo) rec.hf_repo = repo;
    const m = rec.name.match(/(.+)-(\d{5})-of-(\d{5})\.(safetensors|bin)$/);
    if (m) rec.shard = `${m[1]} (${parseInt(m[3], 10)} parts)`;
  }
  // LoRA LTX ambiguë (48 blocs × 4096 = LTXV 13B ou LTX-2) : si seul LTX-2 est installé, c'est pour lui.
  const fams = new Set(records.filter((r) => r.role === 'diffusion_model').map((r) => r.family));
  if (fams.has('LTX-2.x') && !fams.has('LTX-Video 0.9')) {
    for (const r of records) {
      if (r.role === 'lora' && r.rule === 'ltxv' && r.family === 'LTX-Video 0.9') {
        r.family = 'LTX-2.x';
        r.inferred = 'seul moteur LTX compatible installe : LTX-2.x';
      }
    }
  }
  // Un shard sans signature (dernier morceau d'un LLM) hérite de ses frères.
  const shardRef = new Map();
  for (const r of records) {
    if (r.shard && r.rule && r.rule !== 'name') {
      const k = path.posix.dirname(r.path) + '|' + r.shard;
      if (!shardRef.has(k)) shardRef.set(k, r);
    }
  }
  for (const r of records) {
    const ref = r.shard ? shardRef.get(path.posix.dirname(r.path) + '|' + r.shard) : null;
    if (ref && (!r.rule || r.rule === 'name')) {
      for (const k of ['family', 'role', 'rule', 'variant']) if (ref[k]) r[k] = ref[k];
      r.inherited_from = ref.name;
    }
  }

  // --- LoRA : copies rangées par Mia (models\loras\mia), LoRA retirés, fichiers non-LoRA des dossiers de LoRA ---
  // Une copie (ou un lien) de models\loras\mia n'est pas un modèle de plus : c'est la place de son original dans
  // ComfyUI. On la rattache à l'original par l'empreinte de contenu.
  const placeLow = lowKey(`${env.engineRoot}/models/loras/mia`);
  const placements = new Map();                                  // empreinte → nom ComfyUI (« mia\mara.safetensors »)
  const placementFiles = [];
  {
    const sources = new Set(records.filter((r) => !r.partial && r.role === 'lora' && !under(r.pathLow, placeLow))
      .map((r) => r.fingerprint).filter(Boolean));
    const lorasListed = comfy.reachable && comfy.folders && Array.isArray(comfy.folders.loras)
      ? new Set(comfy.folders.loras.map((n) => String(n).replace(/\//g, '\\').toLowerCase())) : null;
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (r.partial) continue;
      if (under(r.pathLow, placeLow) && r.fingerprint && sources.has(r.fingerprint)) {
        const name = 'mia\\' + r.path.slice(placeLow.length + 1).replace(/\//g, '\\');
        if (!lorasListed || lorasListed.has(name.toLowerCase())) placements.set(r.fingerprint, name);
        placementFiles.push(r.path);
        records.splice(i, 1);
        continue;
      }
      if (ignored.has(r.pathLow) || (r.root_kind === 'loras' && r.role !== 'lora')) records.splice(i, 1);
    }
  }

  // --- disposition de ComfyUI (dossiers vus) ---
  const layout = await comfyLayout(env, comfy);
  const comfyDirsLow = new Set(layout.dirs.map((d) => d.dir));

  // --- dossiers-modèles HF / diffusers ---
  const memo = new Map();
  const bundles = new Map();
  for (const rec of records) {
    if (!rec.root) continue;
    const b = await bundleOf(rec.path, rec.root, comfyDirsLow, memo);
    if (!b) continue;
    rec.bundle = b;
    const e = bundles.get(b) || { path: b, files: [], size: 0 };
    if (!rec.partial) { e.files.push(rec.path.slice(b.length + 1)); e.size += rec.size; }
    bundles.set(b, e);
  }
  for (const b of bundles.values()) {
    const { arch, source } = await bundleIdentity(b.path);
    b.arch = arch; b.arch_source = source;
    if (arch && HF_ARCH[arch]) [b.family, b.role] = HF_ARCH[arch];
    b.hf_repo = hfRepo(b.path);
    // Variantes de format d'un même poids (.bin + .safetensors, fp16 + fp32) : une seule « sert ».
    const stems = new Map();
    for (const fn of b.files) {
      const base = fn.replace(/^pytorch_model/, 'model').replace(/(\.fp16)?\.(safetensors|bin)$/, '').replace('diffusion_pytorch_model', 'model');
      if (!stems.has(base)) stems.set(base, []);
      stems.get(base).push(fn);
    }
    let useful = 0;
    b.useful = new Set();
    const pref = (fn) => (/\.fp16\.safetensors$/.test(fn) ? 0 : /\.safetensors$/.test(fn) ? 1 : /\.fp16\.bin$/.test(fn) ? 2 : 3);
    for (const list of stems.values()) {
      const best = list.slice().sort((x, y) => pref(x) - pref(y))[0];
      const rec = records.find((r) => r.path === `${b.path}/${best}`);
      if (rec) { useful += rec.size; b.useful.add(rec.pathLow); }
    }
    b.usefulBytes = useful;
    const fv = [...stems.entries()].filter(([, v]) => v.length > 1);
    if (fv.length) b.format_variants = Object.fromEntries(fv);
  }

  // --- recettes du labo : qui utilise quoi, et ce qui manque ---
  const refs = await workflowRefs(env, cache.refs);
  const present = new Set(records.filter((r) => !r.partial).map((r) => r.name));
  for (const r of records) if (refs.map[r.name]) r.used_by = refs.map[r.name];
  const missingFiles = Object.entries(refs.map).filter(([n]) => !present.has(n)).map(([file, usedBy]) => ({ file, usedBy }));

  // --- modèles présentés ---
  const rootsByPath = new Map(roots.map((r) => [r.path.toLowerCase(), r]));
  const { models, byRecord } = buildModels(records, [...bundles.values()], { layout, comfy, rootsByPath, env });
  applyLoras(models, { env, registry, placements });
  const duplicates = markDuplicates(models, records, byRecord, { env });
  resolveParts(models, layout.modelsDir);
  assignGroups(models);
  const { caps, missing } = capabilities(models, layout.modelsDir);
  sortModels(models);
  for (const m of models) { delete m._cat; delete m._main; }

  // Téléchargements interrompus : informatifs seulement, Mia ne supprime jamais rien.
  const partials = records.filter((r) => r.partial).map((r) => {
    const target = r.path.replace(/\.(part|partial|download|crdownload|incomplete)$/i, '');
    const twin = records.find((x) => !x.partial && x.name === path.posix.basename(target) && x.size === r.size);
    const root = rootsByPath.get(lowKey(r.root || ''));
    const nm = partialName(r.path, r.root);
    return { path: r.path, file: r.name, name: { fr: nm, en: nm }, sizeGB: r.size_gb, root: r.root, app: (root && root.app) || null,
      note: { ...(twin ? R.NOTES.partialComplete : R.NOTES.partial) }, twin: twin ? twin.path : null };
  });

  // Autres applications : une ligne par appli (nombre de fichiers, taille).
  const apps = [];
  for (const m of models.filter((x) => x.status === 'other-app')) {
    const name = m.app || 'Autre';
    let a = apps.find((x) => x.name === name);
    if (!a) { a = { name, desc: R.APPS[name] ? { ...R.APPS[name] } : null, root: m.root.path, models: 0, sizeGB: 0 }; apps.push(a); }
    a.models++; a.sizeGB = round2(a.sizeGB + m.sizeGB);
  }

  // Une recherche large mémorise les dossiers trouvés : les démarrages suivants les relisent sans tout refaire.
  let foundRoots = Array.isArray(cache.foundRoots) ? cache.foundRoots.slice() : [];
  if (opts.deep) {
    const dirs = new Set(foundRoots.map(P));
    for (const r of records) {
      const root = rootsByPath.get(lowKey(r.root));
      if (root && root.broad) dirs.add(r.bundle || path.posix.dirname(r.path));
    }
    const list = [...dirs].sort((a, b) => a.length - b.length);
    foundRoots = list.filter((d, i) => !list.slice(0, i).some((p) => under(d.toLowerCase(), p.toLowerCase())));
  }

  const totalMs = now() - t0;
  const ready = models.filter((m) => m.status === 'ready' && !m.hidden);
  const inventory = {
    schema: 1,
    scannedAt: Date.now(),
    durationMs: totalMs,
    deep: !!opts.deep,
    comfy: {
      reachable: !!comfy.reachable, url: comfy.url || opts.comfyUrl || null, version: comfy.version || null,
      modelsDir: layout.modelsDir, layout: layout.live ? 'live' : 'predicted',
      minimax: models.some((m) => m.key === 'minimax' && m.status === 'ready'),
    },
    machine: comfy.machine || null,
    // ready = modèles utilisables (jamais un interdit, jamais une pièce interne) ; miaGB = ce que Mia lit ou
    // pourrait lire, appsGB = ce qui appartient à d'autres logiciels (comptés à part, pour ne pas tromper).
    summary: {
      ready: ready.length, models: models.length, sizeGB: round2(models.reduce((s, m) => s + m.sizeGB, 0)),
      miaGB: round2(models.filter((m) => m.status !== 'other-app').reduce((s, m) => s + m.sizeGB, 0)),
      appsGB: round2(models.filter((m) => m.status === 'other-app').reduce((s, m) => s + m.sizeGB, 0)),
      loras: models.filter((m) => m.status === 'ready' && (m.caps || []).includes('lora')).length,
    },
    // Modèles de base (pour « fait pour LTX 2.5 ») et genres de LoRA : une seule source pour l'interface.
    bases: Object.fromEntries(Object.keys(R.BASES).map((k) => [k, { label: R.baseLabel(k, false), full: R.baseLabel(k, true),
      media: R.BASES[k].media, installed: models.some((m) => m.baseKey === k && m.status === 'ready') }])),
    genres: R.GENRES,
    loraFolders: (opts.loraFolders || []).map((p) => {
      const r = roots.find((x) => x.kind === 'loras' && lowKey(x.path) === lowKey(p));
      return { path: P(p), found: !!r, loras: r ? models.filter((m) => m.origin === 'folder' && under(m.path.toLowerCase(), lowKey(p))).length : 0 };
    }),
    placements: placementFiles,
    models,
    capabilities: caps,
    missing,
    partials,
    duplicates,
    apps,
    roots: roots.filter((r) => !r.file).map((r) => ({ path: r.path, kind: r.kind, label: r.label || null, app: r.app || null,
      models: models.filter((m) => lowKey(m.root.path) === r.path.toLowerCase()).length })),
    missingFiles,
    stats: { files: records.length, hits, misses, walkMs, identifyMs, comfyMs, totalMs },
  };
  const outCache = { version: CACHE_VERSION, catalogRev: CATALOG_REV, savedAt: Date.now(), files: newFiles, foundRoots, refs, inventory };
  if (opts.cachePath && opts.writeCache !== false) {
    try { await saveCache(opts.cachePath, outCache); } catch (e) { inventory.cacheError = String(e.message || e); }
  }
  progress({ phase: 'done', done: records.length, total: records.length, current: null, final: true });
  return { inventory, records, cache: outCache };
}

// Résolution d'un réglage de modèle d'un bloc : 'auto' -> défaut de la capacité, 'none' -> null, sinon l'id
// (ou, par tolérance, le nom de fichier). Un modèle interdit, absent ou pas prêt n'est JAMAIS renvoyé.
function resolveIn(inv, value, caps) {
  if (!inv || !Array.isArray(inv.models)) return null;
  const want = Array.isArray(caps) ? caps : caps ? [caps] : [];
  if (value === 'none') return null;
  if (value == null || value === '' || value === 'auto') {
    for (const c of want) {
      const id = inv.capabilities && inv.capabilities[c] && inv.capabilities[c].default;
      const m = id && inv.models.find((x) => x.id === id);
      if (m && selectable(m, [c])) return { ...m };
    }
    return null;
  }
  const v = String(value).toLowerCase();
  const m = inv.models.find((x) => x.id === value)
    || inv.models.find((x) => x.file.toLowerCase() === v && selectable(x, want))
    || inv.models.find((x) => x.path.toLowerCase() === v.replace(/\\/g, '/'));
  return m && selectable(m, want) ? { ...m } : null;
}

// =============================================================================================
// 7 bis. Un fichier déposé sur Mia : LoRA ou pas ? (SPEC §12.1) — en-tête seulement, aucun poids chargé
// =============================================================================================
const PART_ROLES = new Set([...R.INTERNAL_ROLES]);
const MODEL_ROLES = new Set(['diffusion_model', 'checkpoint', 'controlnet', 'adapter', 'upscaler', 'depth', 'segmentation',
  'matting', 'normals', 'optical_flow', 'frame_interp', 'vision_backbone', '3d', 'motion', 'llm', 'pipeline', 'face']);

// Le LoRA déjà connu de Mia qui a le même contenu (ou le même chemin), en suivant les doublons jusqu'à l'original.
function sameLora(inv, files, p, fingerprint) {
  if (!inv || !Array.isArray(inv.models)) return null;
  const k = lowKey(p);
  const loras = inv.models.filter((m) => m.role === 'lora');
  let m = loras.find((x) => lowKey(x.path) === k) || null;
  if (!m && fingerprint && files) {
    const same = new Set(Object.entries(files).filter(([, v]) => v && v.info && v.info.fingerprint === fingerprint).map(([key]) => key));
    m = loras.find((x) => same.has(lowKey(x.path)) && x.status === 'ready') || loras.find((x) => same.has(lowKey(x.path))) || null;
  }
  if (m && m.status === 'duplicate' && m.duplicateOf) m = inv.models.find((x) => x.id === m.duplicateOf) || m;
  if (!m) return null;
  return { id: m.id, name: { ...m.label }, origin: m.origin || null, usable: m.status === 'ready' && (m.caps || []).includes('lora') };
}

/**
 * inspectFile(path, { inventory, files, engineRoot, lang }) → { ok, isLora, isModel, family, familyLabel{fr,en}, loraFor,
 *   sizeGB, suggestedName, suggestedTrigger, kindGuess, reason{fr,en}|null, already|null, file, path }
 */
async function inspectFile(file, { inventory = null, files = null, engineRoot = null, lang = 'fr' } = {}) {
  engineRoot = engineRoot || places.labRoot() || places.suggestEngineDir();
  const p = P(file);
  const ext = path.extname(p).toLowerCase();
  const out = { ok: true, path: p, file: path.posix.basename(p), isLora: false, isModel: false, family: null, familyLabel: null,
    loraFor: null, sizeGB: 0, suggestedName: '', suggestedTrigger: '', kindGuess: 'character', reason: null, already: null };
  const fail = (reason) => ({ ...out, ok: false, reason: { ...reason }, error: reason[lang] || reason.fr });
  let st;
  try { st = await fsp.stat(p); } catch { return fail(R.INSPECT.missing); }
  if (!st.isFile()) return fail(R.INSPECT.unknown);
  out.sizeGB = gb(st.size);
  if (!R.MODEL_EXT.includes(ext)) return { ...out, reason: { ...R.INSPECT.unknown } };
  let info = null;
  try { info = await identify(p, st.size, out.file); } catch { info = null; }
  if (!info || info.not_a_model || info.format === '?') return { ...out, reason: { ...R.INSPECT.unknown } };
  if (info.format === 'illisible') return { ...out, reason: { ...R.INSPECT.unreadable } };
  const role = info.role || 'unknown';
  if (role === 'lora') {
    let family = info.family || null;
    const diff = (inventory && Array.isArray(inventory.models) ? inventory.models : []).filter((m) => m.role === 'diffusion_model');
    // Même règle que le scan : une LoRA « LTX » ambiguë est pour LTX-2 quand seul LTX-2 est installé.
    if (family === 'LTX-Video 0.9' && diff.some((m) => m.family === 'LTX-2.x') && !diff.some((m) => m.family === 'LTX-Video 0.9')) family = 'LTX-2.x';
    const loraFor = R.baseKeyOf(family, info.variant);
    const ident = R.IDENTITY.find((i) => i.test.test(p.toLowerCase())) || null;
    const name = ident ? (ident.label[lang] || ident.label.fr) : R.loraNameFromFile(info.lora_title || out.file);
    const trigger = (ident && ident.trigger) || info.lora_trigger || '';
    return { ...out, isLora: true, family, loraFor,
      familyLabel: loraFor ? R.baseLabel(loraFor) : { ...R.INSPECT.unknownBase },
      suggestedName: name, suggestedTrigger: trigger,
      kindGuess: ident ? ident.kind : R.guessGenre(`${name} ${trigger} ${out.file}`),
      already: sameLora(inventory, files, p, info.fingerprint) };
  }
  const dir = `${P(engineRoot)}/models`.replace(/\//g, '\\');
  if (PART_ROLES.has(role)) return { ...out, isModel: true, family: info.family || null, reason: R.INSPECT.part(dir) };
  if (MODEL_ROLES.has(role)) return { ...out, isModel: true, family: info.family || null, reason: R.INSPECT.model(`${dir}\\diffusion_models`) };
  return { ...out, reason: { ...R.INSPECT.unknown } };
}

// Nom de fichier sûr pour models\loras\mia (lettres, chiffres, . _ -), sans accent ni chemin.
function cleanFileStem(stem) {
  return String(stem || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+|[._]+$/g, '').slice(0, 80) || 'lora';
}

async function sameContent(a, b) {
  let fa = null, fb = null;
  try {
    const [sa, sb] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
    if (sa.size !== sb.size) return false;
    fa = await fsp.open(a, 'r'); fb = await fsp.open(b, 'r');
    return (await sampleHash(fa, sa.size)) === (await sampleHash(fb, sb.size));
  } catch { return false; } finally {
    if (fa) await fa.close().catch(() => {});
    if (fb) await fb.close().catch(() => {});
  }
}

// Copie avec progression (0..1), annulable ; écrit à côté sous un nom que ComfyUI ignore, puis renomme.
function copyWithProgress(src, dst, size, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const tmp = `${dst}.miatmp`;
    const rd = fs.createReadStream(src, { highWaterMark: 4 << 20 });
    const wr = fs.createWriteStream(tmp);
    let done = 0, last = 0, ended = false;
    const fail = (e) => {
      if (ended) return;
      ended = true;
      rd.destroy(); wr.destroy();
      fs.unlink(tmp, () => reject(e));
    };
    const onAbort = () => fail(Object.assign(new Error('annulé'), { name: 'AbortError' }));
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    rd.on('data', (chunk) => {
      done += chunk.length;
      const t = Date.now();
      if (typeof onProgress === 'function' && (t - last > 150 || done === size)) { last = t; try { onProgress(size ? done / size : null); } catch { /* */ } }
    });
    rd.on('error', fail);
    wr.on('error', fail);
    wr.on('finish', () => {
      if (ended) return;
      ended = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      fsp.rename(tmp, dst).then(resolve, (e) => fs.unlink(tmp, () => reject(e)));
    });
    rd.pipe(wr);
  });
}

// =============================================================================================
// 8. Service Electron : cache servi tout de suite, revalidation en arrière-plan, veille des dossiers, LoRA
// =============================================================================================
const GENRE_KEYS = new Set(Object.keys(R.GENRES));
const validEntry = (e) => e && typeof e === 'object' && typeof e.source === 'string' && path.isAbsolute(e.source);
const userError = (msg) => Object.assign(new Error(msg), { userMessage: true });

class ModelService {
  constructor(ctx) {
    this.ctx = ctx;
    const data = (ctx.paths && ctx.paths.data) || path.join(os.homedir(), 'AppData', 'Roaming', 'Mia', 'data');
    this.cachePath = path.join(data, 'models-cache.json');
    this.regPath = path.join(data, 'loras.json');               // registre des LoRA (SPEC §12.3)
    this.identPath = path.join(data, 'identities.json');        // LoRA d'identité de l'utilisateur (facultatif)
    this.cache = null;
    this.inventory = null;
    this.loras = [];
    this.running = null;
    this.watchers = [];
    this.timers = [];
    this.comfySig = null;
    this.placing = new Map();                                   // source → placement en cours (un seul à la fois)
    this.regQueue = Promise.resolve();
    // Journal de Mia si le principal en fournit un (logs), sinon la console.
    const lg = typeof ctx.logger === 'function' ? ctx.logger('models') : null;
    this.log = typeof lg === 'function' ? lg : (...a) => console.warn('[models]', ...a);
  }

  lang() {
    try { return typeof this.ctx.lang === 'function' && this.ctx.lang() === 'en' ? 'en' : 'fr'; } catch { return 'fr'; }
  }

  // Message lisible dans la langue de l'interface (le français par défaut).
  say(fr, en) {
    if (fr && typeof fr === 'object') return this.lang() === 'en' ? (fr.en || fr.fr) : fr.fr;
    return this.lang() === 'en' ? en : fr;
  }

  loadCacheSync() {
    try {
      const c = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      if (c && c.version === CACHE_VERSION) {
        // Catalogue changé depuis : on garde l'identification des fichiers, l'inventaire sera refait (scan à chaud).
        this.cache = { ...c, inventory: c.catalogRev === CATALOG_REV ? c.inventory : null };
        this.inventory = this.cache.inventory || null;
      } else this.cache = { ...emptyCache(), foundRoots: (c && c.foundRoots) || [] };
    } catch { this.cache = emptyCache(); }
    if (this.inventory) this.comfySig = this.sigOf(this.inventory.comfy);
  }

  loadRegistrySync() {
    try {
      const a = JSON.parse(fs.readFileSync(this.regPath, 'utf8'));
      this.loras = Array.isArray(a) ? a.filter(validEntry) : [];
    } catch { this.loras = []; }
    // LoRA d'identité de l'utilisateur (personnages, lieux) : data\identities.json, jamais dans le dépôt
    try {
      const n = R.setIdentities(JSON.parse(fs.readFileSync(this.identPath, 'utf8')));
      if (n) this.log(`identités : ${n}`);
    } catch { R.setIdentities([]); }
  }

  // Écritures du registre en file (jamais deux à la fois), atomiques (fichier temporaire puis renommage).
  saveRegistry() {
    const snapshot = JSON.stringify(this.loras, null, 1);
    this.regQueue = this.regQueue.catch(() => {}).then(async () => {
      await fsp.mkdir(path.dirname(this.regPath), { recursive: true });
      const tmp = `${this.regPath}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, snapshot);
      await fsp.rename(tmp, this.regPath);
    });
    return this.regQueue;
  }

  async prefs() {
    try { return (await Promise.resolve(this.ctx.prefs && this.ctx.prefs.get && this.ctx.prefs.get())) || {}; } catch { return {}; }
  }

  send(channel, payload) {
    try { if (typeof this.ctx.send === 'function') this.ctx.send(channel, payload); } catch { /* fenêtre fermée */ }
  }

  sigOf(c) { return c ? `${c.reachable ? 1 : 0}|${c.version || ''}|${c.url || ''}` : ''; }

  // Une demande simple rejoint le scan en cours ; une demande forcée, approfondie ou « après un changement »
  // (queue : registre des LoRA modifié) passe après lui.
  scan(opts = {}) {
    const force = !!opts.force, deep = !!opts.deep, queue = !!opts.queue;
    if (this.running && !force && !deep && !queue) return this.running.promise;
    const prev = this.running ? this.running.promise.catch(() => {}) : Promise.resolve();
    const promise = prev.then(() => this.runScan({ force, deep }));
    const job = { promise };
    this.running = job;
    promise.finally(() => { if (this.running === job) this.running = null; }).catch(() => {});
    return promise;
  }

  async runScan({ force, deep }) {
    const prefs = await this.prefs();
    const folders = (Array.isArray(prefs.loraFolders) ? prefs.loraFolders : []).filter((x) => typeof x === 'string' && path.isAbsolute(x));
    const res = await scan({
      engineRoot: places.engineRoot(prefs) || places.suggestEngineDir(),
      extraRoots: Array.isArray(prefs.extraModelRoots) ? prefs.extraModelRoots : [],
      loraFolders: folders,
      loras: this.loras,
      comfyUrl: prefs.comfyUrl || 'http://127.0.0.1:8188',
      cache: this.cache || emptyCache(), force, deep,
      onProgress: (p) => this.send('models:progress', p),
    });
    this.cache = res.cache;
    this.inventory = res.inventory;
    this.comfySig = this.sigOf(res.inventory.comfy);
    try { await saveCache(this.cachePath, res.cache); } catch (e) { this.log('cache non écrit :', e.message); }
    this.send('models:update', this.inventory);
    this.rewatch(res.inventory.roots);
    return this.inventory;
  }

  // Veille des dossiers du labo et de l'utilisateur : un nouveau fichier de poids déclenche une revalidation
  // (rapide : seuls les fichiers nouveaux ou modifiés sont relus).
  rewatch(roots) {
    const want = (roots || []).filter((r) => ['comfy', 'training', 'user', 'loras'].includes(r.kind)).map((r) => r.path);
    const key = want.join('|');
    if (key === this.watchKey) return;
    this.watchKey = key;
    for (const w of this.watchers) { try { w.close(); } catch { /* déjà fermé */ } }
    this.watchers = [];
    let t = null;
    const kick = () => { clearTimeout(t); t = setTimeout(() => this.scan().catch(() => {}), 1500); t.unref?.(); };
    for (const p of want) {
      try {
        const w = fs.watch(p, { recursive: true, persistent: false }, (_ev, file) => {
          const ext = path.extname(String(file || '')).toLowerCase();
          if (!file || WEIGHT_EXT.has(ext) || PARTIAL_EXT.has(ext) || !ext) kick();
        });
        w.on('error', () => {});
        this.watchers.push(w);
      } catch { /* dossier inaccessible : la revalidation suivante suffira */ }
    }
  }

  // ComfyUI peut démarrer (ou s'arrêter) après Mia : on revalide quand son état change.
  startComfyWatch() {
    const tick = async () => {
      const prefs = await this.prefs();
      const url = prefs.comfyUrl || 'http://127.0.0.1:8188';
      let c = { reachable: false, url, version: null };
      if (isLocalUrl(url) && typeof fetch === 'function') {
        try {
          const r = await fetch(url.replace(/\/+$/, '') + '/system_stats', { signal: AbortSignal.timeout(COMFY_TIMEOUT_MS) });
          if (r.ok) { const j = await r.json(); c = { reachable: true, url: url.replace(/\/+$/, ''), version: (j.system || {}).comfyui_version || null }; }
        } catch { /* éteint */ }
      }
      if (this.sigOf(c) !== this.comfySig && !this.running) this.scan().catch(() => {});
    };
    const t = setInterval(() => { tick().catch(() => {}); }, 20000);
    t.unref?.();
    this.timers.push(t);
  }

  stop() {
    for (const w of this.watchers) { try { w.close(); } catch { /* */ } }
    for (const t of this.timers) clearInterval(t);
    this.watchers = []; this.timers = [];
  }

  // ------------------------------------------------------------------------------------- LoRA
  // Un modèle de l'inventaire par id, id du registre, chemin, ou objet d'inventaire (copie comprise).
  findModel(ref) {
    const inv = this.inventory;
    if (!inv || ref == null) return null;
    if (typeof ref === 'object') ref = ref.id || ref.source || ref.path || '';
    const s = String(ref);
    const k = lowKey(s);
    return inv.models.find((m) => m.id === s)
      || inv.models.find((m) => m.loraId && m.loraId === s)
      || inv.models.find((m) => m.role === 'lora' && (lowKey(m.path) === k || (m.source && lowKey(m.source) === k)))
      || null;
  }

  entryFor(m) {
    const k = lowKey(m.source || m.path);
    return this.loras.find((e) => lowKey(e.source) === k) || null;
  }

  async inspect(p) {
    if (typeof p !== 'string' || !p.trim()) return { ok: false, error: this.say(R.INSPECT.missing), reason: { ...R.INSPECT.missing } };
    if (!this.inventory) { try { await this.scan(); } catch { /* inspect marche sans */ } }
    const prefs = await this.prefs();
    return inspectFile(p, { inventory: this.inventory, files: this.cache && this.cache.files, engineRoot: places.engineRoot(prefs) || places.suggestEngineDir(), lang: this.lang() });
  }

  // Ajout par glisser-déposer : une ligne dans loras.json ; le fichier d'origine ne bouge jamais.
  async addLora({ path: p, name, trigger, kind } = {}) {
    const info = await this.inspect(p);
    if (!info.ok) return { ok: false, error: info.error };
    if (!info.isLora) return { ok: false, error: this.say(info.reason || R.INSPECT.unknown) };
    // Déjà dans Mia et utilisable (même contenu ou même fichier) : on met à jour celui-là plutôt que d'en faire un
    // doublon. Une étape d'entraînement que ComfyUI ne voit pas, elle, est bien ajoutée (rangée au premier calcul).
    if (info.already && info.already.id && info.already.usable) {
      const r = await this.updateLora(info.already.id, { name, trigger, kind });
      return r.ok ? { ...r, existed: true } : r;
    }
    const source = P(p);
    const k = lowKey(source);
    this.loras = this.loras.filter((e) => lowKey(e.source) !== k);
    const entry = { id: 'l_' + sha1(k).slice(0, 10), source, name: cleanText(name, 60) || info.suggestedName,
      trigger: cleanText(trigger, 80), kind: GENRE_KEYS.has(kind) ? kind : info.kindGuess, added: Date.now(), origin: 'added' };
    this.loras.push(entry);
    await this.saveRegistry();
    const inv = await this.scan({ queue: true });
    const model = inv.models.find((m) => lowKey(m.path) === k) || null;
    return { ok: true, model, inventory: inv };
  }

  async updateLora(id, patch = {}) {
    const m = this.findModel(id);
    if (!m || m.role !== 'lora') return { ok: false, error: this.say("Ce LoRA n’est plus dans Mia.", 'This LoRA is no longer in Mia.') };
    let e = this.entryFor(m);
    if (!e) {
      const source = P(m.source || m.path);
      e = { id: 'l_' + sha1(lowKey(source)).slice(0, 10), source, added: Date.now(), origin: m.origin === 'added' ? 'added' : (m.origin || 'engine') };
      this.loras.push(e);
    }
    if ('name' in patch) { const n = cleanText(patch.name, 60); if (n) e.name = n; else delete e.name; }
    if ('trigger' in patch) e.trigger = cleanText(patch.trigger, 80);
    if ('kind' in patch && GENRE_KEYS.has(patch.kind)) e.kind = patch.kind;
    delete e.ignored;
    await this.saveRegistry();
    const inv = await this.scan({ queue: true });
    return { ok: true, model: inv.models.find((x) => x.id === m.id) || null, inventory: inv };
  }

  // Retirer de Mia : l'entrée et la copie (ou le lien) rangée dans models\loras\mia — JAMAIS le fichier d'origine.
  async removeLora(id) {
    const m = this.findModel(id);
    if (!m || m.role !== 'lora') return { ok: false, error: this.say("Ce LoRA n’est plus dans Mia.", 'This LoRA is no longer in Mia.') };
    if (m.origin === 'engine' || m.origin === 'training') {
      return { ok: false, error: this.say('Ce LoRA est rangé dans le dossier du moteur : Mia ne le retire pas. Tu peux le renommer.',
        "This LoRA lives in the engine folder: Mia does not remove it. You can rename it.") };
    }
    let warning = null;
    if (m.placed) {
      try { await this.unplace(m); } catch (err) {
        this.log('copie non retirée :', err);
        warning = this.say('La copie rangée pour le moteur est en cours d’utilisation : elle sera retirée plus tard.',
          'The copy kept for the engine is in use: it will be removed later.');
      }
    }
    const k = lowKey(m.source || m.path);
    if (m.origin === 'folder') {
      const e = this.entryFor(m) || { id: 'l_' + sha1(k).slice(0, 10), source: P(m.source || m.path), origin: 'folder', added: Date.now() };
      e.ignored = true;
      if (!this.loras.includes(e)) this.loras.push(e);
    } else {
      this.loras = this.loras.filter((e) => lowKey(e.source) !== k);
    }
    await this.saveRegistry();
    const inv = await this.scan({ queue: true });
    return { ok: true, warning, inventory: inv };
  }

  async engineDirs() {
    const prefs = await this.prefs();
    const engineRoot = places.engineRoot(prefs) || places.suggestEngineDir();
    const loras = path.join(engineRoot, 'models', 'loras');
    return { engineRoot, loras, mia: path.join(loras, 'mia') };
  }

  // Supprime la copie (ou le lien) de Mia — seulement dans models\loras\mia, jamais le fichier d'origine.
  async unplace(m) {
    const { mia } = await this.engineDirs();
    const rel = String(m.placed || '').replace(/^mia[\\/]/i, '');
    if (!rel || rel === m.placed) return;
    const file = path.join(mia, ...rel.split(/[\\/]/));
    if (!under(lowKey(file), lowKey(mia)) || lowKey(file) === lowKey(m.source || m.path)) return;
    await fsp.unlink(file);
  }

  // SPEC §12.3 : rend un LoRA visible de ComfyUI. Ceux du labo le sont déjà ; les autres sont rangés dans
  // <engineRoot>\models\loras\mia (lien physique sur le même disque, sinon copie), puis on attend que ComfyUI
  // les liste (10 s au plus). Renvoie { comfyName } : le nom exact à mettre dans LoraLoaderModelOnly.
  async ensureLora(ref, opts = {}) {
    const m = this.findModel(ref);
    if (!m || m.role !== 'lora') throw userError(this.say("Ce LoRA n’est plus dans Mia : choisis-en un autre.", 'This LoRA is no longer in Mia: pick another one.'));
    if ((m.origin === 'engine' || !m.origin) && m.comfy && m.comfy.visible !== false && m.comfy.name) {
      return { comfyName: m.comfy.name, placed: false, listed: true };
    }
    const key = lowKey(m.source || m.path);
    if (this.placing.has(key)) return this.placing.get(key);
    const job = this.placeLora(m, opts).finally(() => this.placing.delete(key));
    this.placing.set(key, job);
    return job;
  }

  async placeLora(m, { onProgress, signal, linkFirst = true, waitMs = 10000 } = {}) {
    const { loras, mia } = await this.engineDirs();
    if (!(await isDir(loras))) {
      throw userError(this.say(`Le dossier des LoRA du moteur est introuvable (${loras}). Vérifie le dossier du moteur dans les Réglages.`,
        `The engine's LoRA folder was not found (${loras}). Check the engine folder in Settings.`));
    }
    const src = m.source || m.path;
    let st;
    try { st = await fsp.stat(src); } catch {
      throw userError(this.say(`Le fichier de ce LoRA est introuvable : ${src.replace(/\//g, '\\')}`, `This LoRA file was not found: ${src.replace(/\//g, '\\')}`));
    }
    await fsp.mkdir(mia, { recursive: true });
    const ext = (path.extname(src) || '.safetensors').toLowerCase();
    const stem = cleanFileStem(path.basename(src, path.extname(src)));
    let target = null, reuse = false;
    for (let i = 1; i < 100 && !target; i++) {
      const cand = path.join(mia, (i === 1 ? stem : `${stem}_${i}`) + ext);
      let cs = null;
      try { cs = await fsp.stat(cand); } catch { target = cand; break; }
      if (cs && cs.size === st.size && await sameContent(cand, src)) { target = cand; reuse = true; }
    }
    if (!target || !under(lowKey(target), lowKey(mia))) throw userError(this.say('Impossible de ranger ce LoRA pour le moteur.', 'Could not place this LoRA for the engine.'));
    let linked = false;
    if (!reuse) {
      const sameVolume = path.parse(path.resolve(src)).root.toLowerCase() === path.parse(path.resolve(mia)).root.toLowerCase();
      if (sameVolume && linkFirst) {
        try { await fsp.link(src, target); linked = true; } catch (e) { this.log('lien impossible, copie :', e.code || e.message); }
      }
      if (!linked) {
        try { await copyWithProgress(src, target, st.size, onProgress, signal); } catch (e) {
          if (e && e.name === 'AbortError') throw e;
          throw userError(this.say(`La copie du LoRA pour le moteur a échoué : ${e.message || e}`, `Copying the LoRA for the engine failed: ${e.message || e}`));
        }
      }
    }
    if (typeof onProgress === 'function') { try { onProgress(1); } catch { /* */ } }
    const fname = path.basename(target);
    const listed = await this.waitComfyLora(fname, waitMs, signal);
    const comfyName = typeof listed === 'string' ? listed : `mia\\${fname}`;
    // L'inventaire en mémoire le sait tout de suite ; le scan qui suit (veille du dossier) le confirmera.
    m.placed = comfyName;
    m.comfy = { folder: 'loras', name: comfyName, visible: true, source: 'mia' };
    if (this.inventory && Array.isArray(this.inventory.placements) && !this.inventory.placements.some((x) => lowKey(x) === lowKey(target))) {
      this.inventory.placements.push(P(target));
    }
    this.scan({ queue: true }).catch(() => {});
    return { comfyName, placed: true, linked, reused: reuse, listed: typeof listed === 'string' };
  }

  // Attend que ComfyUI liste « mia\<fichier> » ; null s'il est éteint (il le verra en démarrant), false au-delà du délai.
  async waitComfyLora(fname, timeoutMs = 10000, signal) {
    const prefs = await this.prefs();
    const base = String(prefs.comfyUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '');
    if (!isLocalUrl(base) || typeof fetch !== 'function') return null;
    const want = `mia\\${fname}`.toLowerCase();
    const t0 = Date.now();
    for (;;) {
      let list = null;
      try {
        const r = await fetch(base + '/models/loras', { signal: AbortSignal.timeout(1500) });
        if (r.ok) list = await r.json();
      } catch { list = null; }
      if (!Array.isArray(list)) return null;
      const hit = list.find((n) => String(n).replace(/\//g, '\\').toLowerCase() === want);
      if (hit) return String(hit);
      if (Date.now() - t0 >= timeoutMs || (signal && signal.aborted)) return false;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) : '';
}

function register(ctx) {
  const svc = new ModelService(ctx);
  svc.loadCacheSync();
  svc.loadRegistrySync();

  // ctx.models : utilisé par le moteur (SPEC §8.1). list() renvoie le tableau des modèles ; on y accroche
  // aussi l'inventaire complet (`.inventory`) pour qui en a besoin.
  ctx.models = {
    list() {
      const inv = svc.inventory;
      const arr = inv ? inv.models.slice() : [];
      Object.defineProperty(arr, 'inventory', { value: inv, enumerable: false });
      return arr;
    },
    resolve: (value, caps) => resolveIn(svc.inventory, value, caps),
    inventory: () => svc.inventory,
    options: (caps) => (svc.inventory ? svc.inventory.models.filter((m) => selectable(m, caps)) : []),
    selectable,
    // Ce chemin est-il un modèle, un fichier partiel, une racine ou une copie de LoRA listés par l'inventaire ?
    // Permet au principal d'accepter « Afficher dans l'Explorateur » hors des racines de Mia (MiniMax sur C:…),
    // sans jamais ouvrir un chemin quelconque.
    owns(abs) {
      const inv = svc.inventory;
      if (!inv || !abs) return false;
      const k = lowKey(abs);
      return inv.models.some((m) => lowKey(m.path) === k || (m.kind === 'bundle' && under(k, lowKey(m.path))))
        || (inv.partials || []).some((p) => lowKey(p.path) === k)
        || (inv.roots || []).some((r) => lowKey(r.path) === k)
        || (inv.apps || []).some((a) => a.root && lowKey(a.root) === k)
        || (inv.placements || []).some((p) => lowKey(p) === k);
    },
    // SPEC §12.3 : place un LoRA pour ComfyUI si besoin → { comfyName }. opts : { onProgress(p), signal }.
    ensureLora: (ref, opts) => svc.ensureLora(ref, opts),
    inspect: (p) => svc.inspect(p),
    scan: (opts) => svc.scan(opts),
    ready: () => (svc.inventory ? Promise.resolve(svc.inventory) : svc.scan()),
  };

  const { ipcMain } = ctx;
  if (ipcMain && typeof ipcMain.handle === 'function') {
    const guard = (what, fn) => async (...a) => {
      try { return await fn(...a); } catch (e) {
        svc.log(`${what} en échec :`, e);
        return { ok: false, error: e && e.userMessage ? e.message : svc.say(`Opération impossible : ${(e && e.message) || e}`, `Operation failed: ${(e && e.message) || e}`) };
      }
    };
    // Premier lancement (pas de cache) : on attend le premier scan plutôt que de montrer une liste vide.
    ipcMain.handle('models:list', async () => {
      if (svc.inventory) return svc.inventory;
      try { return await svc.scan(); } catch (e) {
        svc.log('première lecture en échec :', e);
        return { ok: false, error: svc.say(`Lecture des modèles impossible : ${e.message || e}`, `Could not read the models: ${e.message || e}`) };
      }
    });
    ipcMain.handle('models:scan', async (_e, opts) => {
      try { return await svc.scan(opts || {}); } catch (e) {
        svc.log('scan en échec :', e);
        return { ok: false, error: svc.say(`Le scan des modèles a échoué : ${e.message || e}`, `The model scan failed: ${e.message || e}`) };
      }
    });
    // LoRA (SPEC §12.3) : le pont preload expose mia.models.inspect / addLora / updateLora / removeLora.
    ipcMain.handle('models:inspect', guard('inspect', (_e, p) => svc.inspect(p)));
    ipcMain.handle('models:addLora', guard('addLora', (_e, payload) => svc.addLora(payload || {})));
    ipcMain.handle('models:updateLora', guard('updateLora', (_e, id, patch) => svc.updateLora(id, patch || {})));
    ipcMain.handle('models:removeLora', guard('removeLora', (_e, id) => svc.removeLora(id)));
  }

  // Dossiers changés dans les réglages (racine du labo, dossiers de modèles ou de LoRA, adresse de ComfyUI) : on relit.
  if (ctx.prefs && typeof ctx.prefs.onChange === 'function') {
    ctx.prefs.onChange((_p, changed) => {
      const has = (k) => (changed && typeof changed.has === 'function' ? changed.has(k) : Array.isArray(changed) ? changed.includes(k) : !!(changed && changed[k]));
      if (has('engineRoot') || has('extraModelRoots') || has('comfyUrl') || has('loraFolders')) svc.scan({ queue: true }).catch(() => {});
    });
  }

  // Revalidation de démarrage, dès que la boucle est libre (la fenêtre a déjà reçu le cache).
  setImmediate(() => { svc.scan().catch((e) => svc.log('revalidation en échec :', e)); });
  svc.startComfyWatch();
  if (ctx.app && typeof ctx.app.on === 'function') ctx.app.on('will-quit', () => svc.stop());
  return svc;
}

module.exports = {
  register, scan, resolveIn, selectable, identify, classifyKeys, pickleScan, comfyProbe, parseModelPathsYaml,
  inspectFile, loadCache, CACHE_VERSION, CATALOG_REV, ModelService,
};
