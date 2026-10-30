// Catalogue des modèles en ligne de Higgsfield (SPEC §23), relevé dans leurs pages publiques (aucune clé, aucun
// crédit, aucun appel à api.higgsfield.ai). Trois sources, de la plus complète à l'appoint :
//   1. la console (console.higgsfield.ai → open.higgsfield.ai) : son sitemap, /explore et chaque page
//      /models/<slug>/playground listent TOUS les modèles, avec un enregistrement par workflow (slug, titre, variante,
//      entrées, sortie, disponibilité, fourchette de prix publique) et des liens vers les modèles voisins ;
//   2. dash.higgsfield.ai/models/<slug>/llms.txt : le schéma JSON complet de chaque workflow (« ### Input JSON
//      Schema »), ses notes d'usage et son tarif (« ## Pricing ») ; il prime en cas de désaccord ;
//   3. docs.higgsfield.ai (en retard sur les deux autres) : la phrase de chaque famille, sa page, et les workflows
//      qu'elle seule connaît encore (SOUL Cinema).
// Les pages lues sont gardées dans _dev/cloud-docs/higgsfield-raw.json (hors git) : --renormalize refait le
// catalogue sans réseau. Écrit src/catalog/cloud-higgsfield.json, que Mia lit au démarrage, et
// tools/fixtures/cloud-schemas.json (schémas réduits, que lit tools/test-cloud.js).
//   node tools/build-cloud-catalog.mjs [--dry] [--renormalize]
// Outil de développement : Mia elle-même ne lit jamais ces pages.
//
// Contrat du catalogue (lu par l'écran, le moteur, le MCP) — tout est facultatif, absent = comportement de base :
//   workflow.params[].onlyTiers [tier] · tierOptions {tier: [valeurs]} · seed : min / max · number : min / max
//   workflow.ports.<port>.onlyTiers · help {fr,en} · minSeconds / maxSeconds (vidéos)
//   workflow.promptRequiredTiers [tier] · cite {image, video, videoFrom} · durationFromSource "video"
//   workflow.price {min, max, unit "second"|"run"|"image", currency, source "public", note?, tiers?{tier:{min,max}}}
//   workflow.unsupported [{field, reason {fr,en}}] : ce que Mia n'envoie pas, et pourquoi
//   workflow.notes [phrases] (transmises au MCP) · catalogue.skipped [{id, field?, reason}] : workflows écartés
// Les clés de familles (hf:kling-3-0…) et les ids de workflows ne changent jamais : les planches en dépendent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'catalog', 'cloud-higgsfield.json');
const RAW = path.join(ROOT, '_dev', 'cloud-docs', 'higgsfield-raw.json');
const STRENGTHS = path.join(ROOT, 'src', 'catalog', 'cloud-strengths.json');
const FIXTURE = path.join(ROOT, 'tools', 'fixtures', 'cloud-schemas.json');
const CONSOLE = 'https://console.higgsfield.ai';
const DASH = 'https://dash.higgsfield.ai/models';
const DOCS = 'https://docs.higgsfield.ai/docs/models';
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const warn = (s) => process.stderr.write(`  ! ${s}\n`);

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'Mia catalog builder' } });
      if (r.ok) return await r.text();
      if (r.status === 404 || r.status === 410) return null;
    } catch { /* réseau : on réessaie */ }
    await sleep(800 * (i + 1));
  }
  throw new Error(`lecture impossible : ${url}`);
}

/** n tâches à la fois. */
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = items[i++]; await fn(k); } }));
}

// ── 1. console : découverte des modèles ─────────────────────────────────────────────────────────────────────
const L = (fr, en) => ({ fr, en: en || fr });
const unq = (s) => (s == null ? s : s.replace(/\\"/g, '"').replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))));

/**
 * Enregistrements de modèles d'une page de la console (données sérialisées dans le HTML :
 * `{id:"<uuid>",slug:"…",title:"…",variant_title:…,input_types:…,price_range:{…},…}`).
 */
function recordsOf(html) {
  const out = {};
  const re = /\{id:"[0-9a-f-]{36}",slug:"([^"]+)",title:"((?:[^"\\]|\\.)*)"/g;
  const starts = [];
  let m;
  while ((m = re.exec(html))) starts.push({ at: m.index, slug: m[1], title: unq(m[2]) });
  starts.forEach((s, i) => {
    const end = Math.min(i + 1 < starts.length ? starts[i + 1].at : html.length, s.at + 8000);
    const c = html.slice(s.at, end);
    const g = (rx) => { const x = rx.exec(c); return x ? unq(x[1]) : undefined; };
    const list = (rx) => { const x = rx.exec(c); return x ? (x[1].match(/"([^"]+)"/g) || []).map((q) => q.slice(1, -1)) : undefined; };
    const rec = {
      slug: s.slug, title: s.title,
      variant: g(/variant_title:"((?:[^"\\]|\\.)*)"/), desc: g(/og_description:"((?:[^"\\]|\\.)*)"/),
      output: g(/output_type:"([^"]*)"/), state: g(/availability_state:"([^"]*)"/),
      inputs: list(/input_types:(?:\$R\[\d+\]=)?\[([^\]]*)\]/), released: g(/released_(?:at|on):"([^"]*)"/),
    };
    const field = (txt, k) => (new RegExp(`${k}:"?([^",}]*)"?`).exec(txt) || [])[1];
    const pr = /price_range:(?:\$R\[\d+\]=)?\{([^}]*)\}/.exec(c);
    if (pr) {
      rec.price = { min: Number(field(pr[1], 'min_amount')), max: Number(field(pr[1], 'max_amount')), unit: field(pr[1], 'unit'),
        currency: field(pr[1], 'currency') || 'USD', from: 'range' };
    } else {
      // /explore : pricing.primary {amount, original_amount, unit}
      const pp = /primary:(?:\$R\[\d+\]=)?\{([^}]*)\}/.exec(c);
      const a = pp ? Number(field(pp[1], 'amount')) : NaN;
      if (Number.isFinite(a)) rec.price = { min: a, max: a, unit: field(pp[1], 'unit'), currency: field(pp[1], 'currency') || 'USD', from: 'primary' };
    }
    for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k];
    out[s.slug] = merge(out[s.slug], rec);
  });
  return out;
}
/** Deux lectures du même modèle : on garde ce qui est connu, et la fourchette de prix plutôt qu'un prix seul. */
function merge(a, b) {
  if (!a) return b;
  const o = { ...b, ...a };
  if (b.price && (!a.price || (a.price.from !== 'range' && b.price.from === 'range'))) o.price = b.price;
  return o;
}
const linksOf = (html) => [...new Set([...String(html).matchAll(/\/models\/([a-z0-9][^"'#?<>\s]*?)\/playground/g)].map((m) => m[1]))];

async function discover() {
  const records = {};
  const seen = new Set();
  const queue = [];
  const add = (s) => { if (!seen.has(s)) { seen.add(s); queue.push(s); } };
  const take = (html) => {
    for (const s of linksOf(html)) add(s);
    for (const [k, r] of Object.entries(recordsOf(html))) { records[k] = merge(records[k], r); add(k); }
  };
  take(await get(`${CONSOLE}/sitemap.xml`) || '');
  for (const p of ['/explore', '/explore/video', '/explore/image']) take(await get(`${CONSOLE}${p}`) || '');
  const playground = {};
  while (queue.length) {
    const batch = queue.splice(0);
    await pool(batch, 4, async (s) => {
      const html = await get(`${CONSOLE}/models/${s}/playground`).catch(() => null);
      playground[s] = html ? 200 : 404;
      if (html) take(html);
    });
  }
  process.stderr.write(`console : ${Object.keys(playground).length} pages lues, ${Object.keys(records).length} modèles\n`);
  return { records, playground };
}

// ── 2. dash : schéma, notes, tarif ──────────────────────────────────────────────────────────────────────────
function schemaOfDash(md) {
  const at = md.indexOf('### Input JSON Schema');
  if (at < 0) return null;
  const rest = md.slice(at);
  const s = rest.indexOf('```json');
  if (s < 0) return null;
  const body = rest.slice(rest.indexOf('\n', s) + 1);
  const e = body.indexOf('```');
  try { return JSON.parse(body.slice(0, e).split('\n').map((l) => l.replace(/^>\s?/, '')).join('\n')); } catch { return null; }
}
/** Sections « Using this model » / « Validation notes » / « Usage notes » : leurs paragraphes, sans code ni titres. */
function notesOfDash(md) {
  const out = [];
  const re = /\n## (?:\d+\.\s*)?(Using this model|Validation notes|Usage notes)\s*\n([\s\S]*?)(?=\n## )/g;
  let m;
  while ((m = re.exec(md))) {
    const txt = m[2].replace(/```[\s\S]*?```/g, '');
    for (const para of txt.split(/\n\s*\n/)) {
      const p = para.split('\n').map((l) => l.replace(/^[*-]\s*/, '').trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('|')).join(' ');
      if (p && !/^In Playground/i.test(p)) out.push(p.length > 420 ? `${p.slice(0, 417)}…` : p);
    }
  }
  return [...new Set(out)].slice(0, 8);
}
const pricingOfDash = (md) => {
  const m = /\n## Pricing\s*\n([\s\S]*?)(?=\n## )/.exec(md);
  const p = m && m[1].trim();
  return p && !/not available/i.test(p) ? p.slice(0, 600) : null;
};
const titleOfDash = (md) => (/^# (.+)$/m.exec(md) || [])[1] || null;

// ── 3. docs : appoint (phrase et page de chaque famille, workflows connus d'elle seule) ──────────────────────────
function familyLinks(md) {
  const out = [];
  const re = /\[([^\]]*?)\]\((https:\/\/docs\.higgsfield\.ai\/docs\/models\/[^)\s]+\.md)\)/g;
  let m;
  while ((m = re.exec(md))) {
    const lines = m[1].split('\n').map((s) => s.trim()).filter(Boolean);
    if (!/workflow/i.test(lines[0] || '')) continue;
    const head = lines[0];
    const kind = /video/i.test(head) ? 'video' : /image/i.test(head) ? 'image' : /audio/i.test(head) ? 'audio' : null;
    const maker = head.replace(/(Video|Image|Audio).*$/i, '').trim();
    out.push({ url: m[2], maker, kind, name: lines[1] || '', desc: lines[2] || '' });
  }
  return out;
}
function workflowLinks(md) {
  const out = [];
  const re = /\|\s*\[([^\]]+)\]\((https:\/\/docs\.higgsfield\.ai\/docs\/models\/[^)\s]+\.md)\)\s*\|\s*`POST\s+([^`]+)`\s*\|/g;
  let m;
  while ((m = re.exec(md))) out.push({ name: m[1].trim(), url: m[2], endpoint: m[3].trim().replace(/^\//, '') });
  return out;
}
function schemaOfDocs(md) {
  const at = md.indexOf('Complete JSON schema');
  if (at < 0) return null;
  const rest = md.slice(at);
  const start = rest.indexOf('```json');
  if (start < 0) return null;
  const body = rest.slice(rest.indexOf('\n', start) + 1);
  const end = body.indexOf('```');
  try { return JSON.parse(body.slice(0, end).split('\n').map((l) => l.replace(/^>\s?/, '')).join('\n')); } catch { return null; }
}
const notesOfDocs = (md) => {
  const m = /## Usage notes\s+([\s\S]*?)\n## /.exec(md);
  return m ? m[1].split('\n').map((l) => l.replace(/^\*\s*/, '').trim()).filter(Boolean).slice(0, 6) : [];
};

async function readDocs(dashOk) {
  const families = [];
  for (const [kind, url] of [['video', `${DOCS}/video-generation.md`], ['image', `${DOCS}/image-generation.md`]]) {
    const md = await get(url).catch(() => null);
    for (const f of familyLinks(md || '')) {
      const fmd = await get(f.url).catch(() => null);
      if (!fmd) continue;
      const wfs = [];
      for (const w of workflowLinks(fmd)) {
        // le schéma de la doc ne sert que pour un workflow que dash ne connaît pas
        if (dashOk.has(w.endpoint)) { wfs.push({ id: w.endpoint, name: w.name }); continue; }
        const wmd = await get(w.url).catch(() => null);
        const schema = wmd && schemaOfDocs(wmd);
        wfs.push({ id: w.endpoint, name: w.name, ...(schema ? { schema, notes: notesOfDocs(wmd) } : {}) });
        await sleep(100);
      }
      families.push({ name: f.name, maker: f.maker, kind: f.kind || kind, desc: f.desc, doc: f.url, workflows: wfs });
    }
  }
  return { families };
}

// ── familles de Mia : une table qui garde les clés existantes ───────────────────────────────────────────────
// Ordre = ordre du catalogue. `m` : les slugs de la famille. Un slug qu'aucune ligne ne prend devient une famille
// nouvelle d'après le titre de la console (signalée : l'ajouter ici, et ses points forts dans cloud-strengths.json).
const FAMILIES = [
  { key: 'hf:genjutsu', name: 'Genjutsu', maker: 'Higgsfield', kind: 'video', m: /^higgsfield\/genjutsu\// },
  { key: 'hf:genjutsu-light', name: 'Genjutsu Light', maker: 'Higgsfield', kind: 'video', m: /^higgsfield\/genjutsu-light\// },
  { key: 'hf:seedance-2-0', name: 'Seedance 2.0', maker: 'ByteDance', kind: 'video', m: /^bytedance\/seedance-2\.0\// },
  { key: 'hf:seedance-2-5', name: 'Seedance 2.5', maker: 'ByteDance', kind: 'video', m: /^bytedance\/seedance-2\.5\// },
  { key: 'hf:kling-2-5-turbo', name: 'Kling 2.5 Turbo', maker: 'Kling', kind: 'video', m: /^kling-video\/v2\.5-turbo\// },
  { key: 'hf:kling-2-6', name: 'Kling 2.6', maker: 'Kling', kind: 'video', m: /^kling-video\/v2\.6\// },
  { key: 'hf:kling-2-6-motion-control', name: 'Kling 2.6 Motion Control', maker: 'Kling', kind: 'video', m: /^kling-video\/motion-control\// },
  { key: 'hf:kling-3-0', name: 'Kling 3.0', maker: 'Kling', kind: 'video', m: /^kling-video\/v3\.0(-turbo)?\// },
  { key: 'hf:kling-3-0-motion-control', name: 'Kling 3.0 Motion Control', maker: 'Kling', kind: 'video', m: /^kling-video\/v3\/motion-control\// },
  { key: 'hf:kling-o3', name: 'Kling O3', maker: 'Kling', kind: 'video', m: /^kling-video\/o3\// },
  { key: 'hf:kling-omni', name: 'Kling Omni', maker: 'Kling', kind: 'video', m: /^kling-video\/omni\// },
  { key: 'hf:kling-4-0', name: 'Kling 4.0', maker: 'Kling', kind: 'video', m: /^kling-video\/v4\.0\// },
  { key: 'hf:happy-horse-1-0', name: 'Happy Horse 1.0', maker: 'Alibaba', kind: 'video', m: /^alibaba\/happy-horse\/[a-z-]+-to-video$/ },
  { key: 'hf:happyhorse-1-1', name: 'HappyHorse 1.1', maker: 'Alibaba', kind: 'video', m: /^alibaba\/happy-horse\/v1\.1\// },
  { key: 'hf:wan-3-0', name: 'Wan 3.0', maker: 'Alibaba', kind: 'video', m: /^alibaba\/wan-3\.0\// },
  { key: 'hf:wan-3-0-prime', name: 'Wan 3.0 Prime', maker: 'Alibaba', kind: 'video', m: /^alibaba\/wan-3\.0-prime\// },
  { key: 'hf:cinema-studio-4-0', name: 'Cinema Studio 4.0', maker: 'Higgsfield', kind: 'video', m: /^higgsfield\/cinema-studio\/4\.0$/ },
  { key: 'hf:ltx-2-5', name: 'LTX-2.5', maker: 'Lightricks', kind: 'video', m: /^lightricks\/ltx-2\.5\// },
  { key: 'hf:minimax-h3', name: 'MiniMax H3', maker: 'MiniMax', kind: 'video', m: /^minimax\/h3\// },
  { key: 'hf:hailuo-2-3', name: 'Hailuo 2.3', maker: 'MiniMax', kind: 'video', m: /^minimax\/hailuo-2\.3\// },
  { key: 'hf:pixverse-v6', name: 'PixVerse V6', maker: 'PixVerse', kind: 'video', m: /^pixverse\/v6\// },
  { key: 'hf:wan-2-6', name: 'Wan 2.6', maker: 'Alibaba', kind: 'video', m: /^wan\/v2\.6\// },
  { key: 'hf:wan-2-7', name: 'Wan 2.7', maker: 'Alibaba', kind: 'video', m: /^wan\/v2\.7\// },
  { key: 'hf:grok-imagine-video-1-5', name: 'Grok Imagine Video 1.5', maker: 'xAI', kind: 'video', m: /^xai\/grok-imagine-video\/v1\.5\// },
  { key: 'hf:soul', name: 'SOUL', maker: 'Higgsfield', kind: 'image', m: /^higgsfield-ai\/soul\/standard$/ },
  { key: 'hf:soul-v2', name: 'SOUL V2', maker: 'Higgsfield', kind: 'image', m: /^higgsfield-ai\/soul\/v2\// },
  { key: 'hf:soul-cinema', name: 'SOUL Cinema', maker: 'Higgsfield', kind: 'image', m: /^higgsfield-ai\/soul\/cinema$/ },
  { key: 'hf:marketing-studio-image', name: 'Marketing Studio Image', maker: 'Higgsfield', kind: 'image', m: /^marketing-studio\/image(\/|$)/ },
  { key: 'hf:ads-studio', name: 'Ads Studio', maker: 'Higgsfield', kind: 'image', m: /^higgsfield\/ads-studio\// },
  { key: 'hf:grok-image-2-0', name: 'Grok Image 2.0', maker: 'xAI', kind: 'image', m: /^xai\/grok-imagine-image-2\.0$/ },
  { key: 'hf:recraft-v4-1', name: 'Recraft V4.1', maker: 'Recraft', kind: 'image', m: /^recraft\/v4\.1\/text-to-image$/ },
  { key: 'hf:recraft-v4-1-pro', name: 'Recraft V4.1 Pro', maker: 'Recraft', kind: 'image', m: /^recraft\/v4\.1\/pro\// },
  { key: 'hf:recraft-v4-1-utility', name: 'Recraft V4.1 Utility', maker: 'Recraft', kind: 'image', m: /^recraft\/v4\.1\/utility\/text-to-image$/ },
  { key: 'hf:recraft-v4-1-utility-pro', name: 'Recraft V4.1 Utility Pro', maker: 'Recraft', kind: 'image', m: /^recraft\/v4\.1\/utility\/pro\// },
  { key: 'hf:qwen-image-3', name: 'Qwen Image 3', maker: 'Alibaba', kind: 'image', m: /^alibaba\/qwen-image-3\// },
  { key: 'hf:ideogram-4-0', name: 'Ideogram 4.0', maker: 'Ideogram', kind: 'image', m: /^ideogram\/v4\.0$/ },
  { key: 'hf:z-image-turbo', name: 'Z-Image Turbo', maker: 'Alibaba', kind: 'image', m: /^z-image\/turbo$/ },
];
// Ce que la console liste mais qui n'est pas un modèle pour le bloc Modèle de Mia.
const EXCLUDE = [
  [/^workflows\//, L('application de la console, pas un modèle', 'console app, not a model')],
  [/^higgsfiled\//, L('slug mal écrit dans la console (404)', 'misspelt console slug (404)')],
  [/^higgsfield\/ai-influencer$/, L('application (palier, sélection, variantes de traits), pas un modèle', 'an app (tier, selection, trait variants), not a model')],
  [/^soul-id$|custom-references$/, L('entraînement d’un visage, pas une génération', 'face training, not a generation')],
];

// ── normalisation : ce que Mia lit (l'écran comme le moteur, sans rien recalculer) ──────────────────────
// Champs média → entrées du bloc Modèle (SPEC §23.2). Les autres champs deviennent des réglages, nommés en FR et EN.
const MEDIA = {
  image_url: (ctx) => (ctx.motion ? 'character' : ctx.kind === 'image' ? 'image' : 'start'),
  first_frame_url: () => 'start',
  end_image_url: () => 'end', last_image_url: () => 'end', last_frame_url: () => 'end',
  // « Middle frames » (Kling 4.0, animer) : des images-clés, pas des références
  image_urls: (ctx, sch) => (ctx.kind === 'video' && /middle|intermediate|keyframe/i.test(`${sch && sch.title} ${sch && sch.description}`) ? 'keys' : 'refs'),
  input_images: () => 'refs', image_reference_url: () => 'refs',
  video_url: (ctx) => (ctx.motion ? 'motion' : 'video'),
  video_urls: () => 'refVideos',
  audio_urls: () => 'refAudios', audio_url: () => 'audio',
};
const mediaPort = (f, ctx, props) => (MEDIA[f] ? MEDIA[f](ctx, props && props[f]) : null);
// Champs que Mia n'envoie pas (encore), avec la raison dite à l'assistant et dans le catalogue.
const WHY = {
  multi_prompt: L('plusieurs plans avec chacun sa consigne et sa durée : interface à venir', 'several shots, each with its prompt and length: interface to come'),
  colors: L('palette de couleurs : interface à venir', 'colour palette: interface to come'),
  background_color: L('couleur de fond : interface à venir', 'background colour: interface to come'),
  batch_size: L('Mia garde une seule image par version', 'Mia keeps one picture per version'),
};
// Identifiant obligatoire que Mia ne sait pas lister : le workflow n'est pas proposé.
const BLOCKING = {
  preset_id: L('demande un préréglage Higgsfield (identifiant) que Mia ne sait pas lister', 'needs a Higgsfield preset id that Mia cannot list'),
  name: L('entraînement (nom du visage), pas une génération', 'training (face name), not a generation'),
};
const PARAM_LABEL = {
  duration: L('Durée', 'Duration'), resolution: L('Résolution', 'Resolution'), aspect_ratio: L('Format', 'Aspect ratio'),
  seed: L('Graine', 'Seed'), generate_audio: L('Son', 'Sound'), sound: L('Son', 'Sound'),
  negative_prompt: L('À éviter', 'Avoid'), cfg_scale: L('Fidélité à la consigne', 'Prompt adherence'),
  mode: L('Qualité', 'Quality'), quality: L('Qualité', 'Quality'), enable_thinking: L('Réfléchir avant', 'Think first'),
  prompt_extend: L('Enrichir la consigne', 'Expand the prompt'), enhance_prompt: L('Enrichir la consigne', 'Expand the prompt'),
  prompt_optimizer: L('Enrichir la consigne', 'Expand the prompt'), prompt_extend_mode: L('Façon d’enrichir', 'Expansion mode'),
  bitrate_mode: L('Débit', 'Bitrate'), output_format: L('Format du fichier', 'File format'),
  camera_movement: L('Mouvement de caméra', 'Camera move'), keep_original_sound: L('Garder le son d’origine', 'Keep original sound'),
  character_orientation: L('Orientation du personnage', 'Character orientation'), fps: L('Cadence', 'Frame rate'),
  aigc_watermark: L('Filigrane « IA »', '“AI” watermark'), moderation: L('Modération', 'Moderation'),
  shot_type: L('Découpage', 'Shot type'), era: L('Époque', 'Era'), genre: L('Genre', 'Genre'), light: L('Lumière', 'Light'),
  pacing: L('Rythme', 'Pacing'), camera_lens: L('Objectif', 'Lens'), camera_model: L('Caméra', 'Camera'),
  color_palette: L('Palette', 'Palette'), camera_aperture: L('Ouverture', 'Aperture'), rendering_speed: L('Vitesse', 'Speed'),
  image_weight: L('Poids de l’image', 'Image weight'), style_strength: L('Force du style', 'Style strength'),
  custom_reference_strength: L('Force du Soul ID', 'Soul ID strength'), multi_shots: L('Plusieurs plans', 'Multiple shots'),
  elements: L('Éléments Higgsfield', 'Higgsfield elements'), style_id: L('Style Soul', 'Soul style'),
  custom_reference_id: L('Soul ID', 'Soul ID'), preset_id: L('Préréglage', 'Preset'), niche: L('Secteur', 'Niche'),
  language: L('Langue', 'Language'), target_audience: L('Public visé', 'Target audience'),
  link_url: L('Page web de référence', 'Reference web page'), file_url: L('Document de référence', 'Reference document'),
};
const PARAM_HINT = {
  elements: L('Identifiants d’« elements » de ton compte Higgsfield, séparés par des virgules (console.higgsfield.ai).',
    'IDs of “elements” from your Higgsfield account, separated by commas (console.higgsfield.ai).'),
  style_id: L('Identifiant d’un style Soul de Higgsfield. Vide : sans style.', 'ID of a Higgsfield Soul style. Empty: no style.'),
  custom_reference_id: L('Identifiant d’un Soul ID entraîné sur ton compte Higgsfield. Vide : aucun.', 'ID of a Soul ID trained on your Higgsfield account. Empty: none.'),
  preset_id: L('Identifiant d’un préréglage Higgsfield. Vide : aucun.', 'ID of a Higgsfield preset. Empty: none.'),
  link_url: L('Adresse d’une page publique : le modèle la lit avant de générer. Pas avec un document.', 'Address of a public page: the model reads it before generating. Not with a document.'),
  file_url: L('Adresse publique d’un document (pdf, docx, xlsx, pptx, md). Pas avec une page web.', 'Public address of a document (pdf, docx, xlsx, pptx, md). Not with a web page.'),
};
const ADVANCED = new Set(['seed', 'negative_prompt', 'cfg_scale', 'bitrate_mode', 'output_format', 'aigc_watermark',
  'moderation', 'enable_thinking', 'prompt_extend', 'enhance_prompt', 'prompt_optimizer', 'prompt_extend_mode', 'fps',
  'elements', 'style_id', 'custom_reference_id', 'custom_reference_strength', 'preset_id', 'niche', 'language',
  'target_audience', 'link_url', 'file_url', 'image_weight', 'style_strength']);
const VALUE_LABEL = { std: L('Standard'), standard: L('Standard'), pro: L('Pro'), '4k': L('4K'), fast: L('Rapide', 'Fast'),
  turbo: L('Turbo'), high: L('Élevé', 'High'), low: L('Faible', 'Low'), medium: L('Moyen', 'Medium'), auto: L('Auto'),
  adaptive: L('Adapté', 'Adaptive'), max: L('Maximum'), xhigh: L('Très élevé', 'Very high') };
const pretty = (v) => {
  const k = String(v);
  if (VALUE_LABEL[k.toLowerCase()]) return VALUE_LABEL[k.toLowerCase()];
  if (/^\d+k$/i.test(k)) return L(k.toUpperCase());   // 1k · 2k · 4K → 1K · 2K · 4K (la valeur envoyée reste celle de l'API)
  if (/^\d+(p|s)?$|^\d+:\d+$|^[A-Z0-9]+$/.test(k)) return L(k);
  const s = k.replace(/[-_]+/g, ' ');
  return L(s.charAt(0).toUpperCase() + s.slice(1));
};
// Paliers de qualité d'une même famille (Kling 3.0 std / pro / 4k / turbo, LTX-2.5 fast / pro…) : un seul workflow
// pour Mia, et un réglage « Qualité » qui choisit l'adresse. Ce qu'un palier n'a pas est marqué (onlyTiers…).
const TIERS = ['std', 'standard', 'pro', '4k', 'fast'];
function tierOf(endpoint, familyName) {
  const segs = endpoint.split('/');
  let tier = null;
  const base = [];
  for (const s of segs) {
    if (!tier && TIERS.includes(s)) { tier = s; continue; }
    const t = /^(.*)-turbo$/.exec(s);
    if (!tier && t && !/turbo/i.test(familyName)) { tier = 'turbo'; base.push(t[1]); continue; }
    base.push(s);
  }
  return { base: base.join('/'), tier };
}

const typeOf = (sch) => (Array.isArray(sch.type) ? sch.type.find((x) => x !== 'null') : sch.type);
/** 480p < 720p < 1080p < 2k < 4k (NaN : pas une résolution). */
const resRank = (v) => {
  const s = String(v).toLowerCase();
  const p = /^(\d+)p$/.exec(s);
  if (p) return Number(p[1]);
  const k = /^(\d+(?:\.\d+)?)k$/.exec(s);
  return k ? Number(k[1]) * 1000 : NaN;
};

function normParam(field, sch, required) {
  const t = typeOf(sch);
  const label = PARAM_LABEL[field] || L(sch.title || field);
  const p = { id: `hf.${field}`, field, label, default: sch.default ?? null, advanced: ADVANCED.has(field) };
  if (PARAM_HINT[field]) p.hint = PARAM_HINT[field];
  if (required) p.required = true;
  if (field === 'seed') {
    // les bornes de l'API (SOUL : 1 à 1 000 000 ; Wan 2.6 : -1 à 10 000 000 ; HappyHorse : 1 à 2 147 483 646…)
    const s = { ...p, kind: 'seed' };
    if (Number.isFinite(sch.minimum)) s.min = sch.minimum;
    if (Number.isFinite(sch.maximum)) s.max = sch.maximum;
    return s;
  }
  if (field === 'negative_prompt') return { ...p, kind: 'prompt', default: sch.default ?? '' };
  if (field === 'sound' || field === 'keep_original_sound') {
    // « on » / « off », « yes » / « no » : un interrupteur, la valeur exacte est rendue au moteur
    const vals = sch.enum || [];
    return { ...p, kind: 'toggle', on: vals.includes('on') ? 'on' : 'yes', off: vals.includes('off') ? 'off' : 'no',
      default: (sch.default ?? vals[0]) === (vals.includes('on') ? 'on' : 'yes') };
  }
  if (t === 'boolean') return { ...p, kind: 'toggle', default: !!sch.default };
  if (sch.enum) {
    let vals = sch.enum.filter((v) => v !== null);
    // résolutions dans l'ordre de leur taille (Genjutsu les donne 720p, 480p, 1080p)
    if (field === 'resolution' && vals.every((v) => Number.isFinite(resRank(v)))) vals = vals.slice().sort((a, b) => resRank(a) - resRank(b));
    const options = vals.map((v) => ({ value: v, label: field === 'duration' ? L(`${v} s`) : pretty(v) }));
    return { ...p, kind: options.length <= 4 && options.every((o) => String(o.value).length <= 8) ? 'seg' : 'select', options,
      default: sch.default ?? options[0].value };
  }
  if ((t === 'integer' || t === 'number') && sch.minimum != null && sch.maximum != null) {
    const step = t === 'integer' ? 1 : (sch.multipleOf || 0.05);
    return { ...p, kind: 'slider', min: sch.minimum, max: sch.maximum, step, unit: field === 'duration' ? 's' : '',
      default: sch.default ?? sch.minimum };
  }
  if (t === 'integer' || t === 'number') {
    const n = { ...p, kind: 'number' };
    if (Number.isFinite(sch.minimum)) n.min = sch.minimum;
    if (Number.isFinite(sch.maximum)) n.max = sch.maximum;
    return n;
  }
  if (t === 'string') return { ...p, kind: 'text', default: sch.default ?? '' };
  // une liste d'entiers (identifiants d'« elements ») : un texte « 3, 12 », rendu en liste au moteur
  if (t === 'array' && sch.items && ['integer', 'number'].includes(typeOf(sch.items))) {
    const a = { ...p, kind: 'text', default: '', format: 'int-list' };
    if (sch.maxItems) a.maxItems = sch.maxItems;
    return a;
  }
  return null;
}

/** Groupes « au moins l'un de » d'un schéma (si / sinon, même imbriqués ; anyOf de required). */
function eitherGroups(s, ctx, props) {
  const leaves = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 8 || !node.if || !Array.isArray(node.if.required)) return;
    leaves.push(node.if.required);
    if (node.else && Array.isArray(node.else.required) && !node.else.if) leaves.push(node.else.required);
    if (node.else) walk(node.else, depth + 1);
  };
  walk(s, 0);
  if (Array.isArray(s.anyOf) && s.anyOf.length && s.anyOf.every((a) => Array.isArray(a.required))) for (const a of s.anyOf) leaves.push(a.required);
  const ports = [...new Set(leaves.flat().map((f) => mediaPort(f, ctx, props)).filter(Boolean))];
  if (ports.length < 2) return [];
  // une image de début ou de fin seule reste « Animer une image » : le groupe se limite aux références quand il en a
  const refs = ports.filter((p) => /^ref/.test(p));
  const g = refs.length ? refs : ports;
  return g.length ? [g] : [];
}

// Ce que les pages ne disent pas en clair, ou que Mia vérifie elle-même : par workflow (id sans palier).
const EXTRA = {
  'kling-video/v4.0/video-edit': {
    // la durée demandée n'est pas recopiée de la source : Mia la prend par défaut (bornée 3–30 s)
    durationFromSource: 'video',
    ports: { video: { minSeconds: 3 } },
  },
};
const PORT_HELP = {
  'kling-video/v4.0/image-to-video': {
    keys: L('Images intermédiaires, dans l’ordre : Kling les place lui-même entre le début et la fin (8 au plus).',
      'In-between frames, in order: Kling places them itself between the start and the end (8 at most).'),
  },
  'kling-video/v4.0/video-edit': {
    refVideos: L('Dans la consigne, la vidéo à modifier est « @video_1 », ces vidéos suivent à partir de « @video_2 ».',
      'In the prompt, the video to edit is “@video_1”; these videos follow from “@video_2”.'),
    refs: L('Dans la consigne : « @image_1 », « @image_2 »… dans l’ordre des fils.', 'In the prompt: “@image_1”, “@image_2”… in wire order.'),
  },
  'kling-video/v4.0/reference-to-video': {
    refVideos: L('Dans la consigne : « @video_1 », « @video_2 »… dans l’ordre des fils.', 'In the prompt: “@video_1”, “@video_2”… in wire order.'),
    refs: L('Dans la consigne : « @image_1 », « @image_2 »… dans l’ordre des fils.', 'In the prompt: “@image_1”, “@image_2”… in wire order.'),
  },
};

/** Jetons de citation des références dans la consigne, lus dans les notes (« The source is @video_1… »). */
function citeOf(text) {
  const s = String(text || '');
  if (!/@image_1|@video_1/.test(s)) return null;
  const c = {};
  if (/@image_\d/.test(s)) c.image = '@image_{n}';
  if (/@video_\d/.test(s)) { c.video = '@video_{n}'; c.videoFrom = /start(?:s)? at `?@video_2/i.test(s) ? 2 : 1; }
  return c;
}
/** « The source video must be at least 4 seconds » → 4. */
const minSecondsOf = (text) => {
  const m = /source(?: video)?[^.]{0,40}?at least (\d+(?:\.\d+)?) seconds/i.exec(String(text || ''));
  return m ? Number(m[1]) : null;
};

function normWorkflow(fam, w) {
  const s = w.schema || {};
  const props = s.properties || {};
  const req = new Set(s.required || []);
  const ctx = { kind: fam.kind, motion: /motion-control|motion-transfer/.test(w.id) };
  const ports = {};
  const params = [];
  const unsupported = [];
  let blocked = null;
  const multiShots = !!props.multi_prompt;
  for (const [field, sch] of Object.entries(props)) {
    const port = mediaPort(field, ctx, props);
    if (port) {
      const multi = (Array.isArray(sch.type) ? sch.type.includes('array') : sch.type === 'array');
      ports[port] = { field, multi, max: multi ? (sch.maxItems || 10) : 1, min: multi ? (sch.minItems || 0) : 0 };
      continue;
    }
    if (field === 'prompt') { ports.prompt = { field, multi: false, max: 1 }; continue; }
    if (BLOCKING[field] && req.has(field)) { blocked = { field, reason: BLOCKING[field] }; continue; }
    // plusieurs plans : l'interrupteur va avec la liste des plans (Kling 3.0, O3) ; seul (Wan 2.6) c'est un réglage
    if (field === 'multi_shots' && multiShots) { unsupported.push({ field, reason: WHY.multi_prompt }); continue; }
    if (WHY[field]) { unsupported.push({ field, reason: WHY[field] }); if (req.has(field)) blocked = { field, reason: WHY[field] }; continue; }
    const p = normParam(field, sch, req.has(field));
    if (p) params.push(p);
    else {
      const reason = L(`champ d’un type que Mia ne sait pas encore remplir`, 'a field type Mia cannot fill yet');
      unsupported.push({ field, reason });
      if (req.has(field)) blocked = { field, reason };
    }
  }
  const required = [...req].map((f) => mediaPort(f, ctx, props)).filter(Boolean);
  // « au moins une image OU une vidéo de référence » (si / sinon du schéma, même imbriqués)
  const oneOf = [];
  for (const g of eitherGroups(s, ctx, props)) if (!g.some((p) => required.includes(p))) oneOf.push(g);
  // « si plusieurs plans… sinon ceci est obligatoire » : Mia n'envoie jamais plusieurs plans, le « sinon » vaut
  if (s.if && s.if.properties && !s.if.required && s.else && Array.isArray(s.else.required)) {
    for (const f of s.else.required) { const p = mediaPort(f, ctx, props); if (p && !required.includes(p)) required.push(p); }
  }
  // aide propre au modèle, durée minimale de la source (notes), jetons de citation
  const text = (w.notes || []).join('\n');
  for (const [p, h] of Object.entries(PORT_HELP[w.base] || {})) if (ports[p]) ports[p].help = h;
  const minS = minSecondsOf(text);
  if (minS) for (const p of ['video', 'motion']) if (ports[p]) ports[p].minSeconds = minS;
  const extra = EXTRA[w.base] || {};
  for (const [p, o] of Object.entries(extra.ports || {})) if (ports[p]) Object.assign(ports[p], o);
  const out = { ports, required, oneOf, params, promptRequired: req.has('prompt'), unsupported, blocked };
  const cite = citeOf(text);
  if (cite) out.cite = cite;
  if (extra.durationFromSource && params.some((p) => p.field === 'duration') && ports[extra.durationFromSource]) out.durationFromSource = extra.durationFromSource;
  return out;
}

const WF_LABEL = [
  [/text-to-video/, L('Vidéo depuis un texte', 'Video from text')],
  [/image-to-video|first-last-frame/, L('Animer une image', 'Animate an image')],
  [/reference-to-video|image-reference|custom-references/, L('Vidéo à partir de références', 'Video from references')],
  [/video-reference/, L('Suivre une vidéo de référence', 'Follow a reference video')],
  [/video-edit/, L('Modifier une vidéo', 'Edit a video')],
  [/video-extend/, L('Prolonger une vidéo', 'Extend a video')],
  [/motion-control|motion-transfer/, L('Faire jouer un personnage', 'Make a character act')],
  [/object-swap/, L('Remplacer un objet', 'Swap an object')],
  [/restyle/, L('Changer le style d’une vidéo', 'Restyle a video')],
  [/cinema-studio/, L('Plan de cinéma', 'Cinematic shot')],
  [/image-to-image/, L('Transformer une image', 'Transform an image')],
  [/text-to-image|soul|ideogram|z-image|recraft|grok-imagine-image|ads-studio|marketing-studio/, L('Image depuis un texte', 'Image from text')],
  [/edit$/, L('Retoucher une image', 'Edit an image')],
];
const wfLabel = (id, fallback) => (WF_LABEL.find(([re]) => re.test(id)) || [null, L(fallback)])[1];
// ordre des façons de faire dans une famille : texte d'abord (prix « dès », choix quand rien n'est branché) ;
// une adresse sans mot connu (SOUL, Ideogram, Marketing Studio…) compte comme « depuis un texte »
const WF_ORDER = [/text-to-video/, /image-to-video|first-last-frame/, /reference-to-video|image-reference/, /video-edit/,
  /video-reference/, /video-extend/, /motion-control|motion-transfer/, /object-swap/, /restyle/, /text-to-image/, /image-to-image/, /edit$/];
const T2I_RANK = WF_ORDER.findIndex((re) => String(re) === String(/text-to-image/));
const rankOf = (id) => { const i = WF_ORDER.findIndex((re) => re.test(id)); return i < 0 ? T2I_RANK : i; };

const UNIT = { sec: 'second', second: 'second', seconds: 'second', s: 'second', image: 'image', images: 'image' };
const priceOf = (p, note) => {
  if (!p || !Number.isFinite(p.min)) return null;
  const o = { min: p.min, max: Number.isFinite(p.max) ? p.max : p.min, unit: UNIT[String(p.unit || '').toLowerCase()] || 'run',
    currency: p.currency || 'USD', source: 'public' };
  if (note) o.note = note;
  return o;
};

// ordre montré dans « Qualité » : de la vitesse vers la qualité (Turbo · Standard · Pro · 4K ; Rapide · Pro)
const ORDER_TIERS = ['turbo', 'fast', 'std', 'standard', 'pro', '4k', 'default'];
// palier par défaut quand il n'y a pas de Pro : le premier dans l'ordre d'avant (inchangé)
const DEFAULT_TIERS = ['std', 'standard', 'fast', 'turbo', 'pro', '4k', 'default'];
const sameList = (a, b) => a.length === b.length && a.every((v, i) => String(v) === String(b[i]));

/** Famille brute → famille de Mia : workflows regroupés par palier, entrées, réglages. */
function normalize(fam) {
  const groups = new Map();
  const skipped = [];
  for (const w of fam.workflows) {
    if (!w.schema || !w.schema.properties) continue;
    const { base, tier } = tierOf(w.id, fam.name);
    const n = normWorkflow(fam, { ...w, base });
    if (n.blocked) { skipped.push({ id: w.id, field: n.blocked.field, reason: n.blocked.reason }); continue; }
    if (!groups.has(base)) groups.set(base, { base, name: w.name, entries: [] });
    groups.get(base).entries.push({ tier: tier || 'default', n, w });
  }
  const workflows = [...groups.values()].map(mergeTiers);
  workflows.sort((a, b) => rankOf(a.id) - rankOf(b.id));
  // deux workflows du même nom dans une famille (Marketing Studio : image, flare, sunburst) : le nom de la console
  for (const w of workflows) {
    if (workflows.filter((x) => x.label.fr === w.label.fr).length > 1) w.label = L(w.name);
  }
  const ports = {};
  for (const w of workflows) for (const [k, v] of Object.entries(w.ports)) if (!ports[k] || v.max > ports[k].max) ports[k] = { multi: v.multi, max: v.max };
  return { ...fam, workflows, ports, skipped };
}

/** Les paliers d'un workflow (Kling 3.0 std / pro / 4k / turbo…) en un seul : ce qui ne vaut pas partout est marqué. */
function mergeTiers(g) {
  const entries = g.entries.slice().sort((a, b) => ORDER_TIERS.indexOf(a.tier) - ORDER_TIERS.indexOf(b.tier));
  const tiers = entries.map((e) => e.tier);
  const multi = tiers.length > 1;
  const defTier = multi ? (tiers.includes('pro') ? 'pro' : tiers.slice().sort((a, b) => DEFAULT_TIERS.indexOf(a) - DEFAULT_TIERS.indexOf(b))[0]) : tiers[0];
  const main = entries.find((e) => e.tier === defTier) || entries[0];
  const wf = { id: g.base, label: wfLabel(g.base, g.name), name: g.name, endpoints: {} };
  for (const e of entries) wf.endpoints[e.tier] = e.w.id;
  // entrées : l'union ; une entrée qu'un palier n'a pas est marquée
  wf.ports = {};
  for (const e of [main, ...entries.filter((x) => x !== main)]) for (const [k, v] of Object.entries(e.n.ports)) {
    const cur = wf.ports[k];
    if (cur && cur.field !== v.field) warn(`${g.base} : l’entrée ${k} n’a pas le même champ selon le palier (${cur.field} / ${v.field})`);
    if (!cur || (v.max || 0) > (cur.max || 0)) wf.ports[k] = { ...(cur || {}), ...v };
  }
  if (multi) for (const k of Object.keys(wf.ports)) {
    const has = entries.filter((e) => e.n.ports[k]).map((e) => e.tier);
    if (has.length < tiers.length) wf.ports[k].onlyTiers = has;
  }
  // obligatoires : ceux de tous les paliers
  wf.required = main.n.required.filter((p) => entries.every((e) => e.n.required.includes(p)));
  wf.oneOf = main.n.oneOf;
  // réglages : l'union ; un réglage qu'un palier n'a pas, ou des options qui diffèrent, sont marqués
  wf.params = [];
  const ids = [];
  for (const e of [main, ...entries.filter((x) => x !== main)]) for (const p of e.n.params) if (!ids.includes(p.id)) ids.push(p.id);
  for (const id of ids) {
    const per = entries.map((e) => ({ tier: e.tier, p: e.n.params.find((q) => q.id === id) })).filter((x) => x.p);
    const base = { ...((per.find((x) => x.tier === defTier) || per[0]).p) };
    if (multi && per.length < tiers.length) base.onlyTiers = per.map((x) => x.tier);
    if (per.some((x) => Array.isArray(x.p.options))) {
      const all = [];
      for (const x of [per.find((y) => y.tier === defTier) || per[0], ...per]) {
        for (const o of x.p.options || []) if (!all.some((q) => String(q.value) === String(o.value))) all.push(o);
      }
      if (base.field === 'resolution' && all.every((o) => Number.isFinite(resRank(o.value)))) all.sort((a, b) => resRank(a.value) - resRank(b.value));
      if (['fps', 'duration'].includes(base.field) && all.every((o) => typeof o.value === 'number')) all.sort((a, b) => a.value - b.value);
      base.options = all;
      if (base.kind === 'seg' && (all.length > 4 || all.some((o) => String(o.value).length > 8))) base.kind = 'select';
      const to = {};
      for (const x of per) {
        const vals = (x.p.options || []).map((o) => o.value);
        if (!sameList(vals.slice().map(String).sort(), all.map((o) => String(o.value)).sort())) to[x.tier] = vals;
      }
      if (multi && Object.keys(to).length) base.tierOptions = to;
    }
    if (per.some((x) => x.p.kind === 'slider' && (x.p.min !== base.min || x.p.max !== base.max))) {
      base.min = Math.min(...per.map((x) => x.p.min));
      base.max = Math.max(...per.map((x) => x.p.max));
      warn(`${g.base} : « ${id} » n’a pas les mêmes bornes selon le palier (gardées : ${base.min}–${base.max})`);
    }
    wf.params.push(base);
  }
  if (multi) {
    wf.params.unshift({ id: 'hf.tier', field: null, kind: 'seg', label: L('Qualité', 'Quality'),
      options: tiers.map((t) => ({ value: t, label: pretty(t) })), default: defTier });
  }
  // consigne obligatoire : partout, ou seulement pour certains paliers (Kling 3.0 turbo)
  const pr = entries.filter((e) => e.n.promptRequired).map((e) => e.tier);
  wf.promptRequired = pr.length === entries.length;
  if (multi && pr.length && pr.length < entries.length) wf.promptRequiredTiers = pr;
  // ce que Mia n'envoie pas, une fois par champ
  wf.unsupported = [];
  for (const e of entries) for (const u of e.n.unsupported) if (!wf.unsupported.some((x) => x.field === u.field)) wf.unsupported.push(u);
  if (main.n.cite) wf.cite = main.n.cite;
  if (main.n.durationFromSource) wf.durationFromSource = main.n.durationFromSource;
  wf.notes = main.w.notes || [];
  // tarif public (console), par palier quand il y en a plusieurs
  const prices = entries.map((e) => ({ tier: e.tier, p: priceOf(e.w.price, e.w.pricing) })).filter((x) => x.p);
  if (prices.length) {
    const p = { ...((prices.find((x) => x.tier === defTier) || prices[0]).p) };
    p.min = Math.min(...prices.map((x) => x.p.min));
    p.max = Math.max(...prices.map((x) => x.p.max));
    if (multi && prices.length > 1) p.tiers = Object.fromEntries(prices.map((x) => [x.tier, { min: x.p.min, max: x.p.max }]));
    wf.price = p;
  }
  return wf;
}

// La phrase « à quoi ça sert » de chaque famille, en français (les pages ne parlent qu'anglais).
const DESC_FR = {
  'Genjutsu': 'Transfère un mouvement, remplace un objet ou change le style d’une vidéo.',
  'Genjutsu Light': 'Genjutsu plus léger et moins cher : transfère un mouvement ou remplace un objet dans une vidéo.',
  'Seedance 2.0': 'Vidéo depuis un texte, des images-clés ou des références (images, vidéos, sons).',
  'Seedance 2.5': 'Crée, modifie et prolonge des vidéos à partir d’un texte et de références.',
  'Kling 2.5 Turbo': 'Vidéo rapide depuis un texte ou une image, en Standard ou Pro.',
  'Kling 2.6': 'Vidéo depuis un texte ou une image de départ, avec le son si tu veux.',
  'Kling 2.6 Motion Control': 'Fait jouer le personnage d’une image avec le mouvement d’une vidéo.',
  'Kling 3.0': 'Vidéo depuis un texte ou une image, en Standard, Pro, 4K ou Turbo.',
  'Kling 3.0 Motion Control': 'Fait jouer le personnage d’une image avec le mouvement d’une vidéo.',
  'Kling O3': 'Crée et modifie des vidéos avec images-clés, images et vidéos de référence.',
  'Kling Omni': 'Crée et modifie des vidéos avec des images et des vidéos de référence.',
  'Kling 4.0': 'Vidéos jusqu’à 30 s en 1080p : texte, images-clés, références, ou montage d’une vidéo existante.',
  'Happy Horse 1.0': 'Vidéo depuis un texte, une image de départ ou des images de référence.',
  'HappyHorse 1.1': 'Vidéo depuis un texte, une image de départ ou des images de référence.',
  'Wan 3.0': 'Vidéo depuis un texte, des images-clés ou des références variées.',
  'Wan 3.0 Prime': 'La version haut de gamme de Wan 3.0.',
  'Cinema Studio 4.0': 'Plans de cinéma : caméra, objectif, lumière, époque et rythme au choix.',
  'LTX-2.5': 'LTX dans le cloud : vidéo depuis un texte ou une image, en Rapide ou Pro.',
  'MiniMax H3': 'MiniMax dans le cloud, en 2K : texte, images-clés ou références (images, vidéos, sons).',
  'Hailuo 2.3': 'Vidéo depuis un texte ou une image, mouvements naturels.',
  'PixVerse V6': 'Vidéo depuis un texte ou une image, avec le son.',
  'Wan 2.6': 'Vidéo depuis un texte, une image ou une vidéo de référence.',
  'Wan 2.7': 'Vidéo depuis un texte, des images-clés ou des références.',
  'Grok Imagine Video 1.5': 'Vidéo depuis un texte, une image ou des références (images, son).',
  'SOUL': 'Images photoréalistes depuis un texte.',
  'SOUL V2': 'Images photoréalistes depuis un texte ou une image à transformer, nouvelle version.',
  'SOUL Cinema': 'Images au rendu cinéma depuis un texte.',
  'Soul ID': 'Apprend un visage à partir de tes photos.',
  'Marketing Studio Image': 'Visuels publicitaires à partir d’un texte et de tes images.',
  'Ads Studio': 'Visuels publicitaires à partir d’un texte et de tes images.',
  'Grok Image 2.0': 'Images depuis un texte, avec des images de référence.',
  'Recraft V4.1': 'Images et illustrations depuis un texte.',
  'Recraft V4.1 Pro': 'Images et illustrations depuis un texte, version Pro.',
  'Recraft V4.1 Utility': 'Images utilitaires depuis un texte.',
  'Recraft V4.1 Utility Pro': 'Images utilitaires depuis un texte, version Pro.',
  'Qwen Image 3': 'Images depuis un texte, ou retouche d’une image en lui disant quoi changer.',
  'Ideogram 4.0': 'Images avec du texte bien écrit dedans (affiches, logos).',
  'Z-Image Turbo': 'Images très rapides depuis un texte.',
};
// dit au créatif, comme DESC_FR (la phrase de l'API parle de « workflow variants », « processing »… : jargon)
const DESC_EN = {
  'Genjutsu': 'Transfer a motion, swap an object or change the style of a video.',
  'Genjutsu Light': 'A lighter, cheaper Genjutsu: transfer a motion or swap an object in a video.',
  'Seedance 2.0': 'Video from text, keyframes or references (images, videos, sounds).',
  'Seedance 2.5': 'Create, edit and extend videos from text and references.',
  'Kling 2.5 Turbo': 'Fast video from text or an image, in Standard or Pro.',
  'Kling 2.6': 'Video from text or a start image, with sound if you want.',
  'Kling 2.6 Motion Control': 'Make the character of an image play the motion of a video.',
  'Kling 3.0': 'Video from text or an image, from fast Turbo to 4K.',
  'Kling 3.0 Motion Control': 'Make the character of an image play the motion of a video.',
  'Kling O3': 'Create and edit videos with keyframes, reference images and reference videos.',
  'Kling Omni': 'Create and edit videos with reference images and videos.',
  'Kling 4.0': 'Up to 30 s in 1080p: text, keyframes, references, or editing an existing video.',
  'Happy Horse 1.0': 'Video from text, a start image or reference images.',
  'HappyHorse 1.1': 'Video from text, a start image or reference images.',
  'Wan 3.0': 'Video from text, keyframes or varied references.',
  'Wan 3.0 Prime': 'The high-end version of Wan 3.0.',
  'Cinema Studio 4.0': 'Cinema shots: pick the camera, lens, light, era and pace.',
  'LTX-2.5': 'LTX in the cloud: video from text or an image, in Fast or Pro.',
  'MiniMax H3': 'MiniMax in the cloud, in 2K: text, keyframes or references (images, videos, sounds).',
  'Hailuo 2.3': 'Video from text or an image, natural motion.',
  'PixVerse V6': 'Video from text or an image, with sound.',
  'Wan 2.6': 'Video from text, an image or a reference video.',
  'Wan 2.7': 'Video from text, keyframes or references.',
  'Grok Imagine Video 1.5': 'Video from text, an image or references (images, sound).',
  'SOUL': 'Photoreal images from text.',
  'SOUL V2': 'Photoreal images from text or from an image to transform, new version.',
  'SOUL Cinema': 'Cinema-look images from text.',
  'Soul ID': 'Learns a face from your photos.',
  'Marketing Studio Image': 'Ad visuals from text and your images.',
  'Ads Studio': 'Ad visuals from text and your images.',
  'Grok Image 2.0': 'Images from text, with reference images.',
  'Recraft V4.1': 'Images and illustrations from text.',
  'Recraft V4.1 Pro': 'Images and illustrations from text, Pro version.',
  'Recraft V4.1 Utility': 'Utility images from text.',
  'Recraft V4.1 Utility Pro': 'Utility images from text, Pro version.',
  'Qwen Image 3': 'Images from text, or edit an image by saying what to change.',
  'Ideogram 4.0': 'Images with well-written text in them (posters, logos).',
  'Z-Image Turbo': 'Very fast images from text.',
};
const MARK = { Higgsfield: 'HF', ByteDance: 'BD', Kling: 'KL', Alibaba: 'AL', Lightricks: 'LT', MiniMax: 'MM', PixVerse: 'PV',
  xAI: 'xA', Recraft: 'RC', Ideogram: 'ID', Qwen: 'QW', Wan: 'WA', Tongyi: 'TY' };
const slugify = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Cache brut (console + dash + docs) → familles brutes { key, name, maker, kind, desc, doc, workflows[{id,name,schema,notes,price,pricing}] }. */
function familiesOf(raw) {
  if (raw.source !== 'dash') return { families: raw.families || [], skipped: [] };   // ancien cache (docs seule)
  const docsBy = new Map();                 // endpoint → { famille de la doc, workflow }
  for (const f of (raw.docs && raw.docs.families) || []) for (const w of f.workflows || []) docsBy.set(w.id, { f, w });
  const slugs = new Set([...Object.keys(raw.dash || {}), ...docsBy.keys()]);
  const fams = new Map();
  const skipped = [];
  for (const s of [...slugs].sort()) {
    const ex = EXCLUDE.find(([re]) => re.test(s));
    if (ex) { skipped.push({ id: s, reason: ex[1] }); continue; }
    const rec = (raw.records || {})[s] || {};
    if (rec.state && rec.state !== 'available') {
      skipped.push({ id: s, reason: L(`indisponible chez Higgsfield (${rec.state})`, `unavailable at Higgsfield (${rec.state})`) });
      continue;
    }
    const d = (raw.dash || {})[s];
    const doc = docsBy.get(s);
    let schema = d && d.md ? schemaOfDash(d.md) : null;
    let notes = d && d.md ? notesOfDash(d.md) : [];
    const pricing = d && d.md ? pricingOfDash(d.md) : null;
    if (!schema && doc && doc.w.schema) {
      schema = doc.w.schema;
      notes = doc.w.notes || [];
      warn(`${s} : absent de dash et de la console, gardé d’après docs.higgsfield.ai (peut-être en fin de vie)`);
    }
    if (!schema) { if (d && d.status === 200) skipped.push({ id: s, reason: L('schéma illisible', 'unreadable schema') }); continue; }
    let def = FAMILIES.find((f) => f.m.test(s));
    if (!def) {
      const title = rec.title || (d && d.md && titleOfDash(d.md)) || (doc && doc.f.name) || s.split('/')[0];
      def = { key: `hf:${slugify(title)}`, name: title, maker: (doc && doc.f.maker) || title.split(' ')[0],
        kind: rec.output === 'image' || (doc && doc.f.kind === 'image') ? 'image' : 'video' };
      warn(`nouvelle famille « ${title} » (${s}) : l’ajouter à FAMILIES et ses points forts à cloud-strengths.json`);
    }
    if (!fams.has(def.key)) fams.set(def.key, { def, workflows: [], docs: null, recs: [] });
    const F = fams.get(def.key);
    if (doc && !F.docs) F.docs = doc.f;
    F.recs.push(rec);
    F.workflows.push({ id: s, name: rec.variant || (doc && doc.w.name) || s.split('/').pop(), schema, notes, price: rec.price || null, pricing });
  }
  const order = (k) => { const i = FAMILIES.findIndex((f) => f.key === k); return i < 0 ? FAMILIES.length : i; };
  const families = [...fams.values()].sort((a, b) => order(a.def.key) - order(b.def.key)).map(({ def, workflows, docs, recs }) => ({
    key: def.key, provider: 'higgsfield', kind: def.kind, maker: def.maker, name: def.name,
    desc: DESC_EN[def.name] || (docs && docs.desc) || (recs.find((r) => r.desc) || {}).desc || '',
    doc: (docs && docs.doc) || `${DASH}/${workflows[0].id}/llms.txt`,
    workflows,
  }));
  return { families, skipped };
}

function write(raw) {
  const { families: rawFams, skipped } = familiesOf(raw);
  const norm = rawFams.map(normalize);
  for (const f of norm) skipped.push(...f.skipped);
  const families = norm.filter((f) => f.workflows.length).map((f) => ({
    key: f.key, provider: f.provider, kind: f.kind, maker: f.maker, mark: MARK[f.maker] || f.maker.slice(0, 2).toUpperCase(),
    name: f.name, desc: { fr: DESC_FR[f.name] || f.desc, en: f.desc }, doc: f.doc, ports: f.ports, workflows: f.workflows,
  }));
  const out = {
    version: 2,
    _doc: 'Modèles en ligne de Higgsfield, relevés sur console.higgsfield.ai (liste, tarifs publics), dash.higgsfield.ai (schémas, notes) et docs.higgsfield.ai (appoint) par tools/build-cloud-catalog.mjs (SPEC §23). Ne pas éditer à la main : relancer l’outil (--renormalize sans réseau).',
    source: raw.source === 'dash' ? 'https://console.higgsfield.ai/explore + https://dash.higgsfield.ai/models/<slug>/llms.txt' : 'https://docs.higgsfield.ai/docs/models.md',
    built: raw.built,
    api: { base: 'https://api.higgsfield.ai', auth: 'Authorization: Key {id}:{secret}', upload: 'files/generate-upload-url', status: 'requests/{id}/status' },
    families,
    skipped: skipped.map((s) => ({ id: s.id, ...(s.field ? { field: s.field } : {}), reason: s.reason })),
  };
  const wf = families.reduce((n, f) => n + f.workflows.length, 0);
  process.stderr.write(`catalogue de Mia : ${families.length} familles, ${wf} workflows, ${skipped.length} écartés\n`);
  for (const s of skipped) process.stderr.write(`    écarté ${s.id}${s.field ? ` (${s.field})` : ''} : ${s.reason.fr}\n`);
  // une famille sans points forts : à écrire à la main (cloud-strengths.json)
  try {
    const st = JSON.parse(fs.readFileSync(STRENGTHS, 'utf8')).families || {};
    for (const f of families) if (!st[f.key]) warn(`${f.key} n’a pas de points forts dans cloud-strengths.json`);
  } catch { /* fichier absent : rien à signaler */ }
  if (!DRY) {
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
    if (raw.source === 'dash') writeFixture(raw);
  }
  return out;
}

/**
 * Le banc tools/test-cloud.js vérifie que Mia n'envoie rien hors du schéma de chaque palier : il lit le schéma de
 * chaque adresse, réduit aux champs, options et bornes (tools/fixtures/cloud-schemas.json), refait ici.
 */
function writeFixture(raw) {
  const slim = (s) => {
    const props = {};
    for (const [k, v] of Object.entries(s.properties || {})) {
      const o = {};
      const t = typeOf(v);
      if (t) o.type = t;
      if (v.enum) o.enum = v.enum.filter((x) => x !== null);
      if (v.minimum != null) o.min = v.minimum;
      if (v.maximum != null) o.max = v.maximum;
      props[k] = o;
    }
    return { required: s.required || [], props };
  };
  const eps = {};
  for (const [slug, d] of Object.entries(raw.dash || {})) { const s = d.md && schemaOfDash(d.md); if (s && s.properties) eps[slug] = slim(s); }
  for (const f of (raw.docs && raw.docs.families) || []) {
    for (const w of f.workflows || []) if (!eps[w.id] && w.schema && w.schema.properties) eps[w.id] = slim(w.schema);
  }
  const endpoints = Object.fromEntries(Object.keys(eps).sort().map((k) => [k, eps[k]]));
  const doc = `Schémas des adresses Higgsfield (dash.higgsfield.ai, ${raw.built}) réduits aux champs, options et bornes : tools/test-cloud.js vérifie que Mia n’envoie rien hors du schéma de chaque palier. Refait par tools/build-cloud-catalog.mjs.`;
  fs.writeFileSync(FIXTURE, JSON.stringify({ _doc: doc, built: raw.built, endpoints }, null, 1) + '\n');
}

async function main() {
  if (args.includes('--renormalize')) { write(JSON.parse(fs.readFileSync(RAW, 'utf8'))); return; }
  const { records, playground } = await discover();
  // dash : chaque slug connu de la console
  const slugs = [...new Set([...Object.keys(records), ...Object.keys(playground)])].sort();
  const dash = {};
  await pool(slugs, 4, async (s) => {
    const md = await get(`${DASH}/${s}/llms.txt`).catch(() => null);
    dash[s] = md ? { status: 200, md } : { status: 404 };
  });
  const ok = new Set(Object.entries(dash).filter(([, v]) => v.md && schemaOfDash(v.md)).map(([k]) => k));
  process.stderr.write(`dash : ${ok.size} schémas lisibles sur ${slugs.length} slugs\n`);
  const docs = await readDocs(ok).catch((e) => { warn(`docs.higgsfield.ai illisible (${e.message}) : sans appoint`); return { families: [] }; });
  const raw = { source: 'dash', built: new Date().toISOString().slice(0, 10), records, playground, dash, docs };
  fs.mkdirSync(path.dirname(RAW), { recursive: true });
  fs.writeFileSync(RAW, JSON.stringify(raw));             // pages brutes (hors git) : --renormalize sans réseau
  write(raw);
}

export { normalize, normWorkflow, mergeTiers, familiesOf, recordsOf, schemaOfDash, notesOfDash, tierOf, write };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(2); });
}
