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
// Outil de développement. La normalisation vit dans electron/cloud-catalog.js : la veille de Mia (electron/cloudwatch.js)
// s’en sert pour installer seule un modèle que Higgsfield ajoute (catalogue complémentaire, hors de ce fichier).
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
import { createRequire } from 'node:module';

// la lecture des pages et la normalisation sont partagées avec la veille de Mia (electron/cloudwatch.js)
const C = createRequire(import.meta.url)('../electron/cloud-catalog.js');
const { recordsOf, merge, linksOf, schemaOfDash, familyLinks, workflowLinks, schemaOfDocs, notesOfDocs, build, slimSchema } = C;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'catalog', 'cloud-higgsfield.json');
const RAW = path.join(ROOT, '_dev', 'cloud-docs', 'higgsfield-raw.json');
const STRENGTHS = path.join(ROOT, 'src', 'catalog', 'cloud-strengths.json');
const FIXTURE = path.join(ROOT, 'tools', 'fixtures', 'cloud-schemas.json');
const CONSOLE = 'https://console.higgsfield.ai';
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

const DASH = C.DASH;
C.setWarn(warn);

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

function write(raw) {
  const { families, skipped } = build(raw);
  const out = {
    version: 2,
    _doc: 'Modèles en ligne de Higgsfield, relevés sur console.higgsfield.ai (liste, tarifs publics), dash.higgsfield.ai (schémas, notes) et docs.higgsfield.ai (appoint) par tools/build-cloud-catalog.mjs (SPEC §23). Ne pas éditer à la main : relancer l’outil (--renormalize sans réseau).',
    source: raw.source === 'dash' ? 'https://console.higgsfield.ai/explore + https://dash.higgsfield.ai/models/<slug>/llms.txt' : 'https://docs.higgsfield.ai/docs/models.md',
    built: raw.built,
    api: { base: 'https://api.higgsfield.ai', auth: 'Authorization: Key {id}:{secret}', upload: 'files/generate-upload-url', status: 'requests/{id}/status' },
    families,
    skipped,
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
  const eps = {};
  for (const [slug, d] of Object.entries(raw.dash || {})) { const s = d.md && schemaOfDash(d.md); if (s && s.properties) eps[slug] = slimSchema(s); }
  for (const f of (raw.docs && raw.docs.families) || []) {
    for (const w of f.workflows || []) if (!eps[w.id] && w.schema && w.schema.properties) eps[w.id] = slimSchema(w.schema);
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

const { normalize, normWorkflow, mergeTiers, familiesOf, notesOfDash, tierOf } = C;
export { normalize, normWorkflow, mergeTiers, familiesOf, recordsOf, schemaOfDash, notesOfDash, tierOf, write };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(2); });
}
