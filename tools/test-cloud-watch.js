#!/usr/bin/env node
'use strict';
// Banc de la veille des modèles en ligne (SPEC §23.8, electron/cloudwatch.js) : un faux Higgsfield local (console et
// dash), jamais le vrai, aucune clé, aucun crédit.
//   node tools/test-cloud-watch.js
// Vérifie : repérer un modèle nouveau (et ses modes voisins), les garde-fous du builder (séries, draft_id, schéma
// absent), « une fois par jour », installer, fusionner (le livré passe devant), « pas encore essayé » puis essayé,
// ignorer, un nouveau mode d'une famille connue, l'échec silencieux (pages changées, réseau coupé, fichier abîmé),
// la règle des clés de familles, et que l'outil de développement et Mia normalisent pareil.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
let fails = 0;
let count = 0;
const ok = (cond, msg, more) => {
  count++;
  if (cond) console.log(`  ok    ${msg}`);
  else { fails++; console.log(`  ÉCHEC ${msg}${more ? ` : ${more}` : ''}`); }
};

const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'catalog', 'cloud-higgsfield.json'), 'utf8'));
const knownSlugs = [];
for (const f of shipped.families) for (const w of f.workflows) knownSlugs.push(Object.values(w.endpoints)[0]);

// ── le faux Higgsfield ────────────────────────────────────────────────────────────────────────────────────
const rec = (slug, title, variant, { output = 'video', state = 'available', min = 0.05, max = 0.1, unit = 'sec' } = {}) =>
  `{id:"00000000-0000-4000-8000-${String(Math.abs(hash(slug))).padStart(12, '0').slice(0, 12)}",slug:"${slug}",title:"${title}",variant_title:"${variant}",output_type:"${output}",availability_state:"${state}",input_types:["text"],price_range:{min_amount:${min},max_amount:${max},unit:"${unit}",currency:"USD"}}`;
function hash(s) { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }
const link = (slug) => `<a href="/models/${slug}/playground">x</a>`;
const md = (title, schema, notes = 'Use it for short clips.') => [
  `# ${title}`, '', '> A model.', '', '## Overview', '', '- **Model ID**: `x`', '', '## Using this model', '', notes, '',
  '## Pricing', '', 'Public pricing information is not available for this model.', '', '## API Information', '',
  '### Input JSON Schema', '', '```json', JSON.stringify(schema, null, 2), '```', '', '## Output', '', 'A video.', ''].join('\n');
const t2v = {
  type: 'object', required: ['prompt'],
  properties: {
    prompt: { type: 'string' },
    duration: { type: 'integer', enum: [5, 10], default: 5 },
    resolution: { type: 'string', enum: ['720p', '1080p'], default: '1080p' },
    generate_audio: { type: 'boolean', default: true },
    seed: { type: 'integer', minimum: 1, maximum: 1000 },
  },
};
const i2v = { ...t2v, required: ['prompt', 'image_url'], properties: { ...t2v.properties, image_url: { type: 'string' } } };

// ce que sert le faux Higgsfield : réglé par chaque scène
let site = {};
let hits = [];
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url);
  hits.push(u);
  const body = site[u];
  if (body == null) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(body);
});

const NEW = 'acme/vid-9/text-to-video';
const NEW2 = 'acme/vid-9/image-to-video';
const DRAFT = 'acme/vid-9/finalize-draft';
const SERIES = 'kling-image/v9/series';
const NOSCHEMA = 'acme/pic-1';
const MODE = 'kling-video/v4.0/video-extend';      // un nouveau mode d'une famille connue (Kling 4.0)

function normalSite({ known = knownSlugs.slice(0, 20), extras = [NEW, SERIES, NOSCHEMA, MODE] } = {}) {
  const s = {};
  s['/sitemap.xml'] = `<urlset>${known.concat(extras).map((x) => `<loc>https://console.higgsfield.ai/models/${x}/playground</loc>`).join('')}</urlset>`;
  s['/explore'] = `<html>${known.map((x) => rec(x, 'Known', 'V')).join(',')}${rec(NEW, 'Acme Vid 9', 'Text to Video', { min: 0.03, max: 0.08 })}</html>`;
  s['/explore/video'] = '<html></html>';
  s['/explore/image'] = '<html></html>';
  for (const x of known) s[`/models/${x}/playground`] = `<html>${rec(x, 'Known', 'V')}</html>`;
  // la page du modèle nouveau : ses voisins (l'autre mode, le brouillon) n'apparaissent qu'ici
  s[`/models/${NEW}/playground`] = `<html>${rec(NEW, 'Acme Vid 9', 'Text to Video', { min: 0.03, max: 0.08 })}${rec(NEW2, 'Acme Vid 9', 'Image to Video', { min: 0.04, max: 0.09 })}${link(NEW2)}${link(DRAFT)}</html>`;
  s[`/models/${NEW2}/playground`] = `<html>${rec(NEW2, 'Acme Vid 9', 'Image to Video', { min: 0.04, max: 0.09 })}</html>`;
  s[`/models/${DRAFT}/playground`] = `<html>${rec(DRAFT, 'Acme Vid 9', 'Finalize draft')}</html>`;
  s[`/models/${SERIES}/playground`] = `<html>${rec(SERIES, 'Kling Image 9 Series', 'Series', { output: 'image' })}</html>`;
  s[`/models/${NOSCHEMA}/playground`] = `<html>${rec(NOSCHEMA, 'Acme Pic 1', 'Image', { output: 'image' })}</html>`;
  s[`/models/${MODE}/playground`] = `<html>${rec(MODE, 'Kling 4.0', 'Video Extend')}</html>`;
  s[`/dash/${NEW}/llms.txt`] = md('Acme Vid 9', t2v);
  s[`/dash/${NEW2}/llms.txt`] = md('Acme Vid 9', i2v);
  s[`/dash/${DRAFT}/llms.txt`] = md('Acme Vid 9', { type: 'object', required: ['draft_id'], properties: { draft_id: { type: 'string' } } });
  s[`/dash/${SERIES}/llms.txt`] = md('Kling Image 9 Series', t2v);
  s[`/dash/${MODE}/llms.txt`] = md('Kling 4.0', { type: 'object', required: ['prompt', 'video_url'], properties: { prompt: { type: 'string' }, video_url: { type: 'string' }, duration: { type: 'integer', enum: [5, 10] } } });
  return s;
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.MIA_HF_CONSOLE = base;
  process.env.MIA_HF_DASH = `${base}/dash`;
  const { createWatch, mergeCatalog } = require('../electron/cloudwatch');
  const C = require('../electron/cloud-catalog');
  const route = require('../electron/engine/route');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-watch-'));
  let clock = Date.parse('2026-11-25T10:00:00Z');
  const events = [];
  const logs = [];
  const make = () => createWatch({ dir, builtin: route.builtin, log: (m) => logs.push(m), onChange: (b) => events.push(b), now: () => clock });
  let w = make();
  route.setExtra(() => w.extra());

  console.log('Repérer');
  site = normalSite();
  hits = [];
  let b = await w.check();
  ok(b.ok, 'un passage normal réussit', b.reason);
  ok(b.pending.length === 2, 'deux familles proposées (Acme Vid 9, un mode de Kling 4.0)', JSON.stringify(b.pending.map((p) => p.key)));
  const acme = b.pending.find((p) => p.key === 'hf:acme-vid-9');
  ok(!!acme && acme.isNew, 'la famille nouvelle a la clé automatique hf:acme-vid-9 et est marquée nouvelle');
  ok(acme && acme.slugs.includes(NEW2), 'le mode voisin, vu seulement sur la page du modèle, est repris', acme && acme.slugs.join(','));
  ok(acme && !acme.slugs.includes(DRAFT), 'le brouillon à finaliser (draft_id) est écarté');
  ok(acme && acme.priceFrom && acme.priceFrom.usd === 0.03 && acme.priceFrom.unit === 'second', 'prix public « dès » relevé', JSON.stringify(acme && acme.priceFrom));
  ok(acme && /Vidéo depuis un texte/.test(acme.desc) && /1080p/.test(acme.desc), 'phrase française écrite d’après le schéma', acme && acme.desc);
  const mode = b.pending.find((p) => p.key === 'hf:kling-4-0');
  ok(!!mode && !mode.isNew, 'un nouveau mode d’une famille connue garde la clé de la famille');
  const st = JSON.parse(fs.readFileSync(w.files.watch, 'utf8'));
  ok(st.rejected[SERIES] && /série/.test(st.rejected[SERIES].reason.fr), 'une série payée image par image est écartée, avec sa raison');
  ok(st.rejected[DRAFT] && st.rejected[DRAFT].reason.fr.includes('brouillon'), 'draft_id : écarté, avec sa raison');
  ok(st.rejected[NOSCHEMA], 'un modèle sans schéma lisible est écarté (réessayé dans une semaine)');
  ok(!fs.existsSync(w.files.extra), 'repérer n’installe rien');
  ok(hits.every((h) => !/api\.higgsfield|requests|estimate/.test(h)), 'aucun appel à l’API (pages publiques seulement)');
  ok(events.length === 1, 'l’écran est prévenu une fois');

  console.log('Une fois par jour');
  hits = [];
  clock += 3 * 3600e3;
  b = await w.check();
  ok(hits.length === 0, 'trois heures plus tard : aucune lecture', hits.join(' '));
  ok(w.due() === false, 'due() faux avant un jour');
  clock += 22 * 3600e3;
  ok(w.due() === true, 'due() vrai après un jour');
  hits = [];
  b = await w.check();
  ok(hits.length > 0 && hits.length <= 8, `le lendemain : lecture légère (${hits.length} pages), sans relire les pages des modèles connus`);
  ok(b.pending.length === 2, 'les propositions restent');

  console.log('Installer');
  const before = route.catalogs().cloud.families.length;
  const r = w.install(['hf:acme-vid-9']);
  ok(r.ok && r.installed.join() === 'hf:acme-vid-9', 'installer une famille');
  ok(r.watch.pending.length === 1, 'elle n’est plus proposée');
  route.reload();
  const cat = route.catalogs().cloud;
  const fam = cat.families.find((f) => f.key === 'hf:acme-vid-9');
  ok(cat.families.length === before + 1 && !!fam, 'le catalogue de Mia la connaît aussitôt (sans redémarrer)');
  ok(fam && fam.fresh && fam.workflows.every((x) => x.fresh), '« nouveau, pas encore essayé » sur la famille et ses modes');
  ok(fam && fam.desc.fr && fam.desc.en && fam.desc.fr !== fam.desc.en, 'phrases en français et en anglais', fam && JSON.stringify(fam.desc));
  ok(fam && fam.workflows[0].id === 'acme/vid-9/text-to-video' && fam.workflows[0].price.source === 'public', 'workflow et prix public comme le builder les écrit');
  const R = route.rules();
  const F = R.familyOf('hf:acme-vid-9', route.catalogs().local, cat, null);
  ok(F && F.def && F.def.key === 'hf:acme-vid-9', 'les règles du bloc Modèle la trouvent (route.js)');
  const ch = F && R.chooseWorkflow(F, ['start'], null);
  ok(ch && ch.workflow && ch.workflow.id === 'acme/vid-9/image-to-video', 'une image de début branchée choisit « Animer une image »', ch && ch.workflow && ch.workflow.id);
  ok(shipped.families.length === JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'catalog', 'cloud-higgsfield.json'), 'utf8')).families.length, 'le catalogue livré n’est pas modifié');

  console.log('Nouveau mode d’une famille connue');
  w.install(['hf:kling-4-0']);
  route.reload();
  const k4 = route.catalogs().cloud.families.find((f) => f.key === 'hf:kling-4-0');
  const k4s = shipped.families.find((f) => f.key === 'hf:kling-4-0');
  ok(k4.workflows.length === k4s.workflows.length + 1 && k4.workflows.some((x) => x.id === MODE && x.fresh), 'le mode s’ajoute à la famille livrée, marqué nouveau');
  ok(k4.ports.video && k4.ports.video.max >= 1, 'les entrées de la famille suivent');
  ok(k4s.workflows.length === shipped.families.find((f) => f.key === 'hf:kling-4-0').workflows.length && !k4s.workflows.some((x) => x.fresh), 'la famille livrée en mémoire n’est pas touchée');

  console.log('Essayé');
  ok(w.tried('hf:acme-vid-9', 'acme/vid-9/text-to-video'), 'un premier calcul réussi ôte « pas encore essayé »');
  route.reload();
  const fam2 = route.catalogs().cloud.families.find((f) => f.key === 'hf:acme-vid-9');
  ok(fam2 && !fam2.fresh && !fam2.workflows[0].fresh && fam2.workflows[1].fresh, 'la famille et ce mode-là seulement');
  ok(!w.tried('hf:soul'), 'une famille livrée : rien à changer');

  console.log('Le livré passe devant');
  const later = JSON.parse(JSON.stringify(shipped));
  later.families.push({ ...JSON.parse(JSON.stringify(fam2)), fresh: undefined, workflows: fam2.workflows.map((x) => ({ ...x, fresh: undefined })) });
  const merged = mergeCatalog(later, w.extra());
  ok(merged.families.filter((f) => f.key === 'hf:acme-vid-9').length === 1, 'une version de Mia qui livre ce modèle : pas de double');
  ok(!merged.families.find((f) => f.key === 'hf:acme-vid-9').workflows.some((x) => x.fresh), 'c’est la famille livrée qui reste');

  console.log('Ignorer');
  // un autre modèle nouveau, ignoré
  site = normalSite({ extras: ['zeta/z1/text-to-video'] });
  site['/models/zeta/z1/text-to-video/playground'] = `<html>${rec('zeta/z1/text-to-video', 'Zeta Z1', 'Text to Video')}</html>`;
  site['/dash/zeta/z1/text-to-video/llms.txt'] = md('Zeta Z1', t2v);
  b = await w.check({ force: true });
  ok(b.pending.some((p) => p.key === 'hf:zeta-z1'), 'un autre modèle nouveau est proposé');
  w.ignore(['hf:zeta-z1']);
  b = await w.check({ force: true });
  ok(!b.pending.some((p) => p.key === 'hf:zeta-z1'), 'ignoré : plus jamais proposé');

  console.log('Couper la veille');
  w.setOff(true);
  clock += 3 * 86400e3;
  hits = [];
  ok(w.due() === false, 'coupée : jamais due');
  await w.check();
  ok(hits.length === 0, 'coupée : aucune lecture');
  w.setOff(false);

  console.log('Échouer en silence');
  const extraBefore = fs.readFileSync(w.files.extra, 'utf8');
  site = { '/sitemap.xml': '<html>maintenance</html>', '/explore': '<html><div>nouveau site</div></html>' };
  b = await w.check({ force: true });
  ok(b.ok === false && /changé de forme/.test(b.reason), 'pages changées : rien proposé, raison dite', b.reason);
  ok(fs.readFileSync(w.files.extra, 'utf8') === extraBefore, 'pages changées : rien d’installé n’est touché');
  // un modèle connu absent des pages n'est jamais retiré
  route.reload();
  ok(route.catalogs().cloud.families.some((f) => f.key === 'hf:acme-vid-9'), 'un modèle installé reste, même absent des pages');
  site = normalSite();
  site['/dash/broken/one/llms.txt'] = '# Broken\n\n### Input JSON Schema\n\n```json\n{ pas du json\n```\n\n## End\n';
  site['/sitemap.xml'] += '<loc>https://console.higgsfield.ai/models/broken/one/playground</loc>';
  site['/models/broken/one/playground'] = `<html>${rec('broken/one', 'Broken', 'One')}</html>`;
  b = await w.check({ force: true });
  ok(b.ok && !b.pending.some((p) => p.slugs.includes('broken/one')), 'un schéma illisible : écarté sans bruit');
  // réseau coupé
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  b = await w.check({ force: true });
  ok(b.ok === false && /ne répond pas/.test(b.reason), 'réseau coupé : rien ne casse, raison dite', b.reason);
  ok(logs.some((l) => /injoignable/.test(l)), 'la raison va au journal');
  // fichier complémentaire abîmé
  fs.writeFileSync(w.files.extra, '{ abîmé');
  route.reload();
  ok(route.catalogs().cloud.families.length === shipped.families.length, 'catalogue complémentaire abîmé : ignoré, le livré seul');
  ok(mergeCatalog(shipped, { families: [{ key: 'pas une clé', workflows: [] }, { key: 'hf:x', workflows: 'non' }] }).families.length === shipped.families.length, 'familles mal formées : ignorées');
  fs.writeFileSync(w.files.watch, 'pas du json');
  ok(w.state().pending.length === 0 && w.due(), 'état abîmé : repart de zéro');

  console.log('Clés des familles');
  // clés d'avant la veille : gardées telles quelles. Toute famille ajoutée ensuite à FAMILIES doit garder la clé que
  // la veille lui a donnée (autoKey du titre de la console), sinon les planches qui l'utilisent la perdraient.
  const LEGACY = new Set(['hf:genjutsu', 'hf:genjutsu-light', 'hf:seedance-2-0', 'hf:seedance-2-5', 'hf:kling-2-5-turbo', 'hf:kling-2-6',
    'hf:kling-2-6-motion-control', 'hf:kling-3-0', 'hf:kling-3-0-motion-control', 'hf:kling-o3', 'hf:kling-omni', 'hf:kling-4-0',
    'hf:kling-4-0-flash', 'hf:happy-horse-1-0', 'hf:happyhorse-1-1', 'hf:wan-3-0', 'hf:wan-3-0-prime', 'hf:cinema-studio-4-0', 'hf:ltx-2-5',
    'hf:minimax-h3', 'hf:minimax-h3-highspeed', 'hf:minimax-h3-lite', 'hf:hailuo-2-3', 'hf:pixverse-v6', 'hf:wan-2-6', 'hf:wan-2-7', 'hf:magi-2',
    'hf:grok-imagine-video-1-5', 'hf:soul', 'hf:soul-v2', 'hf:soul-cinema', 'hf:marketing-studio-image', 'hf:ads-studio', 'hf:seedream-5-0-pro',
    'hf:kling-image-4-0', 'hf:grok-image-2-0', 'hf:recraft-v4-1', 'hf:recraft-v4-1-pro', 'hf:recraft-v4-1-utility', 'hf:recraft-v4-1-utility-pro',
    'hf:qwen-image-3', 'hf:ideogram-4-0', 'hf:z-image-turbo']);
  const raw = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, '_dev', 'cloud-docs', 'higgsfield-raw.json'), 'utf8')); } catch { return null; } })();
  const bad = [];
  for (const f of C.FAMILIES) {
    if (LEGACY.has(f.key)) continue;
    const slug = raw && Object.keys(raw.records || {}).find((s) => f.m.test(s));
    const title = (slug && raw.records[slug].title) || f.name;
    if (C.autoKey(title) !== f.key) bad.push(`${f.key} ≠ ${C.autoKey(title)}`);
  }
  ok(!bad.length, 'une famille ajoutée à FAMILIES garde la clé que la veille lui donne', bad.join(' ; '));
  ok(C.autoKey('Kling 5.0') === 'hf:kling-5-0' && C.autoKey('Seedance 3.0 Pro') === 'hf:seedance-3-0-pro', 'autoKey : « hf: » + titre');

  console.log('Builder et veille normalisent pareil');
  if (raw) {
    const built = C.build(raw);
    ok(JSON.stringify(built.families) === JSON.stringify(shipped.families), 'les familles du relevé brut = le catalogue livré');
    ok(JSON.stringify(built.skipped) === JSON.stringify(shipped.skipped), 'les écartés aussi');
  } else console.log('  (sauté : pas de relevé brut dans _dev/cloud-docs, hors git)');

  fs.rmSync(dir, { recursive: true, force: true });
  void port;
  console.log(`\n${count - fails} contrôles réussis, ${fails} échec(s).`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
