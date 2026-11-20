'use strict';
// Faux dossier de moteur pour tools/test-variants.js : des fichiers .safetensors dont SEUL l'en-tête compte (noms de
// tenseurs, formes, types), que le scanner classe comme les vrais (LTX 2.5 compact / RTX 50 / plein / complet, Gemma
// compact et plein, décodeurs, modes, MiniMax, Klein). Aucun poids : 1,1 Mo de remplissage par fichier (le scanner
// ignore les fichiers de moins de 1 Mo), un octet de remplissage différent par fichier (sinon ils seraient « doublons »).

const fs = require('node:fs');
const path = require('node:path');

const DT_BYTES = { BF16: 2, F16: 2, F32: 4, I8: 1, U8: 1 };
const BODY = 1100000;

/** Écrit un .safetensors : tensors = [[nom, type, forme], …]. */
function writeSt(file, tensors, fill = 0, meta = {}) {
  const head = { __metadata__: meta };
  let off = 0;
  for (const [name, dtype, shape] of tensors) {
    const n = shape.reduce((a, b) => a * b, 1) * (DT_BYTES[dtype] || 1);
    head[name] = { dtype, shape, data_offsets: [off, off + n] };
    off += n;
  }
  const header = Buffer.from(JSON.stringify(head));
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(header.length));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([len, header, Buffer.alloc(BODY, fill)]));
}

// Précision : 'bf16' = poids BF16 ; 'int8' / 'nvfp4' = poids I8 / U8 avec le marqueur comfy_quant de ComfyUI.
const DT = { bf16: 'BF16', fp16: 'F16', int8: 'I8', nvfp4: 'U8' };
const quantMark = (prec, layer) => (prec === 'int8' || prec === 'nvfp4' ? [[`${layer}.comfy_quant`, 'U8', [8]]] : []);

const ltx = (prec) => [
  ['audio_patchify_proj.weight', DT[prec], [64, 128]],
  ['adaln_single.linear.weight', DT[prec], [24, 4096]],
  ['transformer_blocks.0.attn1.to_q.weight', DT[prec], [64, 64]],
  ['transformer_blocks.1.attn1.to_q.weight', DT[prec], [64, 64]],
  ...quantMark(prec, 'transformer_blocks.0.attn1.to_q'),
];
const gemma = (prec) => [
  ['model.layers.0.pre_feedforward_layernorm.weight', DT[prec], [64]],
  ['model.layers.0.mlp.down_proj.weight', DT[prec], [64, 64]],
  ['text_embedding_projection.linear.weight', DT[prec], [64, 64]],
  ...quantMark(prec, 'model.layers.0.mlp.down_proj'),
];
const minimax = (prec) => [
  ['token_refiner.blocks.0.linear.weight', DT[prec], [64, 64]],
  ['video_patch_proj.weight', DT[prec], [64, 64]],
  ['audio_patch_proj.weight', DT[prec], [64, 64]],
  ...quantMark(prec, 'token_refiner.blocks.0.linear'),
];
const klein = (prec) => [
  ['double_stream_modulation_img.lin.weight', DT[prec], [64, 64]],
  ['context_embedder.weight', DT[prec], [4096, 16]],
];
const vae = () => [['per_channel_statistics.mean-of-means', 'BF16', [128]], ['decoder.conv_in.weight', 'BF16', [64, 64]]];
const audioVae = () => [['audio_vae.decoder.conv_in.weight', 'BF16', [64, 64]], ['vocoder.conv_pre.weight', 'BF16', [64, 64]]];
const upscaler = () => [['post_upsample_res_blocks.0.conv1.weight', 'BF16', [64, 64]], ['upsampler.0.weight', 'BF16', [64, 64]]];
// LoRA LTX (rang 16 sur des blocs d'attention de largeur 4096), comme les modes IC-LoRA
const lora = () => {
  const out = [];
  for (let b = 0; b < 2; b++) {
    for (const at of ['attn1', 'attn2']) {
      for (const pr of ['to_q', 'to_k']) {
        out.push([`diffusion_model.transformer_blocks.${b}.${at}.${pr}.lora_A.weight`, 'BF16', [16, 4096]],
          [`diffusion_model.transformer_blocks.${b}.${at}.${pr}.lora_B.weight`, 'BF16', [4096, 16]]);
      }
    }
  }
  return out;
};

// clé → [dossier de ComfyUI, nom de fichier, tenseurs]. Les noms sont ceux des vrais fichiers de LTX 2.5.
const PIECES = {
  int8: ['diffusion_models', 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors', ltx('int8')],
  nvfp4: ['diffusion_models', 'ltx-2.5-22b-distilled-transformer-nvfp4.safetensors', ltx('nvfp4')],
  full: ['diffusion_models', 'ltx-2.5-22b-distilled-transformer-bf16.safetensors', ltx('bf16')],
  dev: ['diffusion_models', 'ltx-2.5-22b-dev-transformer-bf16.safetensors', ltx('bf16')],
  devInt8: ['diffusion_models', 'ltx-2.5-22b-dev-transformer-comfy-int8-convrot.safetensors', ltx('int8')],
  custom: ['diffusion_models', 'ltx-custom.safetensors', ltx('bf16')],
  teInt8: ['text_encoders', 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', gemma('int8')],
  teFull: ['text_encoders', 'gemma4-12b-with-proj-ltx-2.5-bf16.safetensors', gemma('bf16')],
  vae: ['vae', 'ltx-2.5-video-vae-bf16.safetensors', vae()],
  audioVae: ['vae', 'ltx-2.5-audio-vae-bf16.safetensors', audioVae()],
  upscaler: ['latent_upscale_models', 'ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors', upscaler()],
  l2r: ['loras', 'ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors', lora()],
  union: ['loras', 'ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors', lora()],
  refine: ['loras', 'ltx-2.5-22b-ic-lora-refine-details-1.0.safetensors', lora()],
  minimax: ['diffusion_models', 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', minimax('int8')],
  minimaxFull: ['diffusion_models', 'minimax_h3_fl2va_bf16.safetensors', minimax('bf16')],
  klein: ['diffusion_models', 'flux-2-klein-9b.safetensors', klein('bf16')],
};
const FILE = Object.fromEntries(Object.entries(PIECES).map(([k, v]) => [k, v[1]]));
// Ce qu'il faut à LTX pour être « prêt » avec ses deux modes, et à « LTX · détails ».
const LTX_BASE = ['vae', 'audioVae', 'l2r', 'union', 'refine', 'upscaler'];

/** Crée <root>\models\… avec les pièces demandées (clés de PIECES). → root */
function buildEngine(root, keys) {
  const all = Object.keys(PIECES);
  for (const k of keys) {
    const p = PIECES[k];
    if (!p) throw new Error(`pièce inconnue : ${k}`);
    writeSt(path.join(root, 'models', p[0], p[1]), p[2], all.indexOf(k) + 1);
  }
  return root;
}

// Inventaire rendu comparable d'un dossier (et d'un jour) à l'autre : ids → noms de fichier, chemins relatifs au
// dossier du moteur, dates retirées. Sert au contrôle « rien ne change sur une machine de 24 Go ».
function normalize(inv, root) {
  // le dossier du moteur, écrit avec « / » ou « \ », quelle que soit la casse, partout où il apparaît dans un texte
  const rootRx = new RegExp(root.replace(/\\/g, '/').split('/').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]'), 'gi');
  const byId = new Map(inv.models.map((m) => [m.id, m.file]));
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    if (typeof v !== 'string') return v;
    if (byId.has(v)) return `id:${byId.get(v)}`;
    return v.replace(rootRx, '<moteur>');
  };
  return {
    models: inv.models.map((m) => { const o = walk(m); delete o.mtime; return o; }),
    capabilities: walk(inv.capabilities),
    missing: walk(inv.missing),
    summary: walk(inv.summary),
    bases: walk(inv.bases),
    duplicates: walk(inv.duplicates),
  };
}

/** Tout ce que `a` contient est dans `b`, à l'identique (b peut avoir des champs EN PLUS). → liste des écarts. */
function missingFrom(a, b, at = '', out = []) {
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) { out.push(`${at} : ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); return out; }
    a.forEach((x, i) => missingFrom(x, b[i], `${at}[${i}]`, out));
  } else if (a && typeof a === 'object') {
    if (!b || typeof b !== 'object' || Array.isArray(b)) { out.push(`${at} : ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); return out; }
    for (const k of Object.keys(a)) missingFrom(a[k], b[k], at ? `${at}.${k}` : k, out);
  } else if (a !== b) out.push(`${at} : ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
  return out;
}

module.exports = { writeSt, buildEngine, normalize, missingFrom, PIECES, FILE, LTX_BASE };
