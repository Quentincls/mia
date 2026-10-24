// Catalogue des modèles en ligne de Higgsfield (SPEC §23), relevé dans leur documentation publique.
// L'API n'a pas de liste des modèles à interroger : chaque famille (MiniMax H3, Seedance 2.5, Kling 3.0…) a sa
// page, qui liste ses « workflows » (texte → vidéo, image → vidéo, références…) ; chaque workflow a sa page avec
// son adresse (`POST /minimax/h3/reference-to-video`) et le schéma JSON complet de ses réglages. L'outil lit ces
// pages (docs.higgsfield.ai, aucune clé, aucun crédit) et écrit src/catalog/cloud-higgsfield.json, que Mia lit
// au démarrage. À relancer quand Higgsfield ajoute des modèles :
//   node tools/build-cloud-catalog.mjs [--only video|image] [--dry]
// Outil de développement : Mia elle-même ne lit jamais la documentation en ligne.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'catalog', 'cloud-higgsfield.json');
const DOCS = 'https://docs.higgsfield.ai/docs/models';
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const DRY = args.includes('--dry');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'Mia catalog builder' } });
      if (r.ok) return await r.text();
      if (r.status === 404) return null;
    } catch { /* réseau : on réessaie */ }
    await sleep(800 * (i + 1));
  }
  throw new Error(`lecture impossible : ${url}`);
}

/** Pages de familles listées par une page d'index (video-generation.md, image-generation.md). */
function familyLinks(md) {
  const out = [];
  // [Fabricant<type> · n workflows\nNom\nPhrase\nView API reference →](url)
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

/** Lignes « | [Nom](url) | `POST /chemin` | » d'une page de famille. */
function workflowLinks(md) {
  const out = [];
  const re = /\|\s*\[([^\]]+)\]\((https:\/\/docs\.higgsfield\.ai\/docs\/models\/[^)\s]+\.md)\)\s*\|\s*`POST\s+([^`]+)`\s*\|/g;
  let m;
  while ((m = re.exec(md))) out.push({ name: m[1].trim(), url: m[2], endpoint: m[3].trim().replace(/^\//, '') });
  return out;
}

/** Schéma JSON complet d'une page de workflow (bloc « Complete JSON schema », lignes préfixées par « > »). */
function schemaOf(md) {
  const at = md.indexOf('Complete JSON schema');
  if (at < 0) return null;
  const rest = md.slice(at);
  const start = rest.indexOf('```json');
  if (start < 0) return null;
  const body = rest.slice(rest.indexOf('\n', start) + 1);
  const end = body.indexOf('```');
  const raw = body.slice(0, end).split('\n').map((l) => l.replace(/^>\s?/, '')).join('\n');
  try { return JSON.parse(raw); } catch { return null; }
}

const notes = (md) => {
  const m = /## Usage notes\s+([\s\S]*?)\n## /.exec(md);
  return m ? m[1].split('\n').map((l) => l.replace(/^\*\s*/, '').trim()).filter(Boolean).slice(0, 6) : [];
};

const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ── normalisation : ce que Mia lit (l'écran comme le moteur, sans rien recalculer) ──────────────────────
// Champs média → entrées du bloc Modèle de Mia (SPEC §23.2). Les autres champs deviennent des réglages,
// nommés en français et en anglais. Un champ obligatoire que Mia ne sait pas remplir (identifiant de style
// Higgsfield, liste d'« elements »…) rend le workflow indisponible dans Mia.
const MEDIA = {
  image_url: (ctx) => (ctx.motion ? 'character' : ctx.kind === 'image' ? 'image' : 'start'),
  first_frame_url: () => 'start',
  end_image_url: () => 'end', last_image_url: () => 'end', last_frame_url: () => 'end',
  image_urls: () => 'refs', input_images: () => 'refs', image_reference_url: () => 'refs',
  video_url: (ctx) => (ctx.motion ? 'motion' : 'video'),
  video_urls: () => 'refVideos',
  audio_urls: () => 'refAudios', audio_url: () => 'audio',
};
const UNFILLABLE = new Set(['preset_id', 'style_id', 'custom_reference_id', 'elements', 'file_url', 'link_url', 'name',
  'colors', 'background_color', 'multi_prompt', 'model_version', 'niche', 'target_audience', 'language']);
const SKIP = new Set(['prompt', 'batch_size', 'multi_shots', 'image_weight', 'custom_reference_strength', 'style_strength',
  ...UNFILLABLE]);
const L = (fr, en) => ({ fr, en: en || fr });
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
};
const ADVANCED = new Set(['seed', 'negative_prompt', 'cfg_scale', 'bitrate_mode', 'output_format', 'aigc_watermark',
  'moderation', 'enable_thinking', 'prompt_extend', 'enhance_prompt', 'prompt_optimizer', 'prompt_extend_mode', 'fps']);
const VALUE_LABEL = { std: L('Standard'), standard: L('Standard'), pro: L('Pro'), '4k': L('4K'), fast: L('Rapide', 'Fast'),
  turbo: L('Turbo'), high: L('Élevé', 'High'), low: L('Faible', 'Low'), medium: L('Moyen', 'Medium'), auto: L('Auto'),
  adaptive: L('Adapté', 'Adaptive'), max: L('Maximum'), xhigh: L('Très élevé', 'Very high') };
const pretty = (v) => {
  const k = String(v);
  if (VALUE_LABEL[k.toLowerCase()]) return VALUE_LABEL[k.toLowerCase()];
  if (/^\d+(p|k|K|s)?$|^\d+:\d+$|^[A-Z0-9]+$/.test(k)) return L(k);
  const s = k.replace(/[-_]+/g, ' ');
  return L(s.charAt(0).toUpperCase() + s.slice(1));
};
// Paliers de qualité d'une même famille (Kling 3.0 std / pro / 4k, LTX-2.5 fast / pro…) : un seul workflow
// pour Mia, et un réglage « Qualité » qui choisit l'adresse.
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

function normParam(field, sch, required) {
  const t = Array.isArray(sch.type) ? sch.type.find((x) => x !== 'null') : sch.type;
  const label = PARAM_LABEL[field] || L(sch.title || field);
  const p = { id: `hf.${field}`, field, label, default: sch.default ?? null, advanced: ADVANCED.has(field) };
  if (required) p.required = true;
  if (field === 'seed') return { ...p, kind: 'seed' };
  if (field === 'negative_prompt') return { ...p, kind: 'prompt', default: sch.default ?? '' };
  if (field === 'sound' || field === 'keep_original_sound') {
    // « on » / « off », « yes » / « no » : un interrupteur, la valeur exacte est rendue au moteur
    const vals = sch.enum || [];
    return { ...p, kind: 'toggle', on: vals.includes('on') ? 'on' : 'yes', off: vals.includes('off') ? 'off' : 'no',
      default: (sch.default ?? vals[0]) === (vals.includes('on') ? 'on' : 'yes') };
  }
  if (t === 'boolean') return { ...p, kind: 'toggle', default: !!sch.default };
  if (sch.enum) {
    const options = sch.enum.map((v) => ({ value: v, label: field === 'duration' ? L(`${v} s`) : pretty(v) }));
    return { ...p, kind: options.length <= 4 && options.every((o) => String(o.value).length <= 8) ? 'seg' : 'select', options,
      default: sch.default ?? sch.enum[0] };
  }
  if ((t === 'integer' || t === 'number') && sch.minimum != null && sch.maximum != null) {
    const step = t === 'integer' ? 1 : (sch.multipleOf || 0.05);
    return { ...p, kind: 'slider', min: sch.minimum, max: sch.maximum, step, unit: field === 'duration' ? 's' : '',
      default: sch.default ?? sch.minimum };
  }
  if (t === 'integer' || t === 'number') return { ...p, kind: 'number' };
  if (t === 'string') return { ...p, kind: 'text', default: sch.default ?? '' };
  return null;
}

function normWorkflow(fam, w) {
  const s = w.schema || {};
  const props = s.properties || {};
  const req = new Set(s.required || []);
  const ctx = { kind: fam.kind, motion: /motion-control|motion-transfer/.test(w.id) };
  const ports = {};
  const params = [];
  let unsupported = null;
  for (const [field, sch] of Object.entries(props)) {
    const mapper = MEDIA[field];
    if (mapper) {
      const port = mapper(ctx);
      const multi = (Array.isArray(sch.type) ? sch.type.includes('array') : sch.type === 'array');
      ports[port] = { field, multi, max: multi ? (sch.maxItems || 10) : 1, min: multi ? (sch.minItems || 0) : 0 };
      continue;
    }
    if (field === 'prompt') { ports.prompt = { field, multi: false, max: 1 }; continue; }
    if (SKIP.has(field)) { if (req.has(field) && UNFILLABLE.has(field)) unsupported = field; continue; }
    const p = normParam(field, sch, req.has(field));
    if (p) params.push(p);
  }
  const required = [...req].filter((f) => MEDIA[f]).map((f) => MEDIA[f](ctx));
  // « au moins une image OU une vidéo de référence » (si / sinon du schéma)
  const oneOf = [];
  if (s.if && Array.isArray(s.if.required) && s.else && Array.isArray(s.else.required)) {
    const a = s.if.required.filter((f) => MEDIA[f]).map((f) => MEDIA[f](ctx));
    const b = s.else.required.filter((f) => MEDIA[f]).map((f) => MEDIA[f](ctx));
    if (a.length && b.length) oneOf.push([...a, ...b]);
  }
  if (s.if && Array.isArray(s.if.required) && !s.else) {
    const a = s.if.required.filter((f) => MEDIA[f]).map((f) => MEDIA[f](ctx));
    if (a.length && !required.length) oneOf.push(a);
  }
  // « si plusieurs plans… sinon ceci est obligatoire » : Mia n'envoie jamais plusieurs plans, le « sinon » vaut
  if (s.if && s.if.properties && !s.if.required && s.else && Array.isArray(s.else.required)) {
    for (const f of s.else.required) if (MEDIA[f] && !required.includes(MEDIA[f](ctx))) required.push(MEDIA[f](ctx));
  }
  // le prompt est toujours là (champ de la carte ou entrée Consigne) ; « obligatoire » se vérifie au lancement
  return { ports, required, oneOf, params, promptRequired: req.has('prompt'), unsupported };
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
  [/text-to-image|soul|ideogram|z-image|recraft|grok-imagine-image|ads-studio|marketing-studio/, L('Image depuis un texte', 'Image from text')],
  [/edit$/, L('Retoucher une image', 'Edit an image')],
];
const wfLabel = (id, fallback) => (WF_LABEL.find(([re]) => re.test(id)) || [null, L(fallback)])[1];

/** Famille brute (schémas de la doc) → famille de Mia : workflows regroupés par palier, entrées, réglages. */
function normalize(fam) {
  const groups = new Map();
  for (const w of fam.workflows) {
    const { base, tier } = tierOf(w.id, fam.name);
    const n = normWorkflow(fam, w);
    if (n.unsupported) continue;
    if (!groups.has(base)) groups.set(base, { id: base, label: wfLabel(base, w.name), name: w.name, endpoints: {}, tiers: [], ...n, notes: w.notes || [] });
    const g = groups.get(base);
    g.endpoints[tier || 'default'] = w.id;
    if (tier) g.tiers.push(tier);
    // réglages et entrées : l'union des paliers (un palier peut en avoir un de plus)
    for (const [k, v] of Object.entries(n.ports)) if (!g.ports[k] || (v.max || 0) > (g.ports[k].max || 0)) g.ports[k] = v;
    for (const p of n.params) if (!g.params.some((q) => q.id === p.id)) g.params.push(p);
  }
  const workflows = [...groups.values()].map((g) => {
    if (g.tiers.length > 1) {
      const order = ['std', 'standard', 'fast', 'turbo', 'pro', '4k'];
      const tiers = [...new Set(g.tiers)].sort((a, b) => order.indexOf(a) - order.indexOf(b));
      g.params.unshift({ id: 'hf.tier', field: null, kind: 'seg', label: L('Qualité', 'Quality'),
        options: tiers.map((t) => ({ value: t, label: pretty(t) })), default: tiers.includes('pro') ? 'pro' : tiers[0] });
    }
    delete g.tiers;
    return g;
  });
  // deux workflows du même nom dans une famille (Marketing Studio : image, flare, sunburst) : le nom de la doc
  for (const w of workflows) {
    if (workflows.filter((x) => x.label.fr === w.label.fr).length > 1) w.label = L(w.name);
  }
  const ports = {};
  for (const w of workflows) for (const [k, v] of Object.entries(w.ports)) if (!ports[k] || v.max > ports[k].max) ports[k] = { multi: v.multi, max: v.max };
  return { ...fam, workflows, ports };
}

// La phrase « à quoi ça sert » de chaque famille, en français (la doc ne parle qu'anglais).
const DESC_FR = {
  'Genjutsu': 'Transfère un mouvement, remplace un objet ou change le style d’une vidéo.',
  'Seedance 2.0': 'Vidéo depuis un texte, des images-clés ou des références (images, vidéos, sons).',
  'Seedance 2.5': 'Crée, modifie et prolonge des vidéos à partir d’un texte et de références.',
  'Kling 2.5 Turbo': 'Vidéo rapide depuis un texte ou une image, en Standard ou Pro.',
  'Kling 2.6': 'Vidéo depuis un texte ou une image de départ, avec le son si tu veux.',
  'Kling 2.6 Motion Control': 'Fait jouer le personnage d’une image avec le mouvement d’une vidéo.',
  'Kling 3.0': 'Vidéo depuis un texte ou une image, en Standard, Pro, 4K ou Turbo.',
  'Kling 3.0 Motion Control': 'Fait jouer le personnage d’une image avec le mouvement d’une vidéo.',
  'Kling O3': 'Crée et modifie des vidéos avec images-clés, images et vidéos de référence.',
  'Kling Omni': 'Crée et modifie des vidéos avec des images et des vidéos de référence.',
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
  'SOUL V2': 'Images photoréalistes depuis un texte, nouvelle version.',
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
const MARK = { Higgsfield: 'HF', ByteDance: 'BD', Kling: 'KL', Alibaba: 'AL', Lightricks: 'LT', MiniMax: 'MM', PixVerse: 'PV',
  xAI: 'xA', Recraft: 'RC', Ideogram: 'ID', Qwen: 'QW', Wan: 'WA', Tongyi: 'TY' };
const RAW = path.join(ROOT, '_dev', 'cloud-docs', 'higgsfield-raw.json');

function write(raw) {
  const families = raw.families.map(normalize).filter((f) => f.workflows.length).map((f) => ({
    key: f.key, provider: f.provider, kind: f.kind, maker: f.maker, mark: MARK[f.maker] || f.maker.slice(0, 2).toUpperCase(),
    name: f.name, desc: { fr: DESC_FR[f.name] || f.desc, en: f.desc }, doc: f.doc, ports: f.ports, workflows: f.workflows,
  }));
  const out = {
    version: 1,
    _doc: 'Modèles en ligne de Higgsfield, relevés dans docs.higgsfield.ai par tools/build-cloud-catalog.mjs (SPEC §23). Ne pas éditer à la main : relancer l’outil (--renormalize sans réseau).',
    source: 'https://docs.higgsfield.ai/docs/models.md',
    built: raw.built,
    api: { base: 'https://api.higgsfield.ai', auth: 'Authorization: Key {id}:{secret}', upload: 'files/generate-upload-url', status: 'requests/{id}/status' },
    families,
  };
  const wf = families.reduce((n, f) => n + f.workflows.length, 0);
  process.stderr.write(`catalogue de Mia : ${families.length} familles, ${wf} workflows\n`);
  if (!DRY) fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
}

async function main() {
  if (args.includes('--renormalize')) { write(JSON.parse(fs.readFileSync(RAW, 'utf8'))); return; }
  const indexes = [['video', `${DOCS}/video-generation.md`], ['image', `${DOCS}/image-generation.md`]]
    .filter(([k]) => !only || only === k);
  const families = [];
  let wfCount = 0;
  let skipped = 0;
  for (const [kind, url] of indexes) {
    const md = await get(url);
    for (const f of familyLinks(md || '')) {
      const fmd = await get(f.url);
      if (!fmd) continue;
      const wfs = [];
      for (const w of workflowLinks(fmd)) {
        const wmd = await get(w.url);
        const schema = wmd && schemaOf(wmd);
        if (!schema || !schema.properties) { skipped++; continue; }
        wfs.push({ id: w.endpoint, name: w.name, schema, notes: notes(wmd) });
        wfCount++;
        await sleep(120);
      }
      if (!wfs.length) continue;
      families.push({
        key: `hf:${slug(f.name)}`, provider: 'higgsfield', kind: f.kind || kind, maker: f.maker, name: f.name,
        desc: f.desc, doc: f.url, workflows: wfs,
      });
      process.stderr.write(`  ${f.name} : ${wfs.length} workflow(s)\n`);
    }
  }
  process.stderr.write(`${families.length} familles, ${wfCount} workflows (${skipped} sans schéma lisible)\n`);
  const raw = { built: new Date().toISOString().slice(0, 10), families };
  fs.mkdirSync(path.dirname(RAW), { recursive: true });
  fs.writeFileSync(RAW, JSON.stringify(raw));             // pages brutes (hors git) : --renormalize sans réseau
  write(raw);
}

main().catch((e) => { console.error(e.message); process.exit(2); });
