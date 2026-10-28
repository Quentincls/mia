'use strict';
// Banc de la règle « que fait le bloc Modèle ? » (src/js/nodes/route.js, lue aussi par le moteur) sur les familles du
// PC et quelques familles en ligne : ce que Quentin branche → la façon de faire retenue, ce qui manque, ce qui est
// ignoré, le choix proposé. Sans GPU ni Mia : node tools/test-route.js
// Cas tirés de l'audit du 25/10 (une entrée d'appoint seule ne fait plus partir du texte en silence, une entrée
// principale n'est plus jetée pour une entrée d'appoint, rien de branché = pas de choix…).
const route = require('../electron/engine/route');

const R = route.rules();
const { local, cloud } = route.catalogs();
const fam = (v) => R.familyOf(v, local, cloud, { models: [] });

// [famille, entrées branchées, façon attendue, { blocked, missing, unused, ties }]
const CASES = [
  ['fam:ltx', [], 't2v', { ties: [] }],
  ['fam:ltx', ['start'], 'i2v', {}],
  ['fam:ltx', ['start', 'end', 'keys', 'sheet'], 'i2v', { unused: [] }],
  ['fam:ltx', ['end'], 'i2v', { blocked: true, missing: ['start'] }],
  ['fam:ltx', ['sheet'], 'sheet', { blocked: false }],                         // fiche personnage seule (à essayer)
  ['fam:ltx', ['start', 'sheet'], 'i2v', { unused: [] }],
  ['fam:ltx', ['keys'], 'i2v', { blocked: true, missing: ['start'] }],
  ['fam:ltx', ['start', 'look'], 'i2v', { unused: ['look'] }],
  ['fam:ltx', ['guide'], 'guided', {}],
  ['fam:ltx', ['guide', 'start'], 'guided', { unused: [], ties: [] }],
  ['fam:ltx', ['video'], 'real', {}],
  ['fam:ltx', ['video', 'start'], 'real', { unused: [], ties: [] }],
  ['fam:ltx', ['refs'], 't2v', { unused: ['refs'] }],                         // LTX ne prend pas de références
  ['fam:minimax', [], 't2v', { ties: [] }],
  ['fam:minimax', ['refs'], 'refs', {}],
  ['fam:minimax', ['refVideos'], 'refs', {}],
  ['fam:minimax', ['refs', 'keys'], 'refs', { unused: ['keys'] }],
  ['fam:minimax', ['refs', 'keys', 'audio'], 'refs', { unused: ['keys', 'audio'] }],
  ['fam:minimax', ['refAudios'], 'refs', { blocked: true, missing: ['refs'] }],
  ['fam:minimax', ['start'], 'i2v', {}],
  ['fam:minimax', ['start', 'end', 'keys', 'audio'], 'i2v', { unused: [] }],
  ['fam:minimax', ['keys'], 't2v', {}],
  ['fam:minimax', ['audio'], 't2v', {}],
  ['fam:minimax', ['end'], 'i2v', { blocked: true, missing: ['start'] }],
  ['fam:minimax', ['guide', 'start'], 'guided', { unused: [] }],
  ['fam:minimax', ['guide', 'keys', 'audio'], 'guided', { unused: ['keys', 'audio'] }],
  ['fam:minimax', ['video'], 'extend', {}],
  ['fam:minimax', ['mask'], 't2v', { unused: ['mask'] }],                     // plus de « Zone libre » chez MiniMax
  ['fam:wan', ['character', 'motion'], 'perform', {}],
  ['fam:wan', ['character'], 'perform', { blocked: true, missing: ['motion'] }],
  ['fam:qwen', ['image', 'ref'], 'edit', {}],
  ['fam:qwen', ['ref'], 'edit', { blocked: true, missing: ['image'] }],
  ['fam:klein', [], 't2i', { ties: [] }],
  ['fam:klein', ['image'], 'edit', { unused: [] }],
  ['fam:klein', ['ref'], 't2i', { unused: ['ref'] }],                            // Klein ne prend pas d'images d'appui
  ['fam:qwen21', [], 't2i', { ties: [] }],
  ['fam:qwen21', ['image'], 'zone', { blocked: true, missing: ['mask'] }],    // une image seule : il manque la zone
  ['fam:qwen21', ['image', 'mask'], 'zone', { unused: [] }],                  // retoucher une zone
  ['fam:qwen21', ['layout'], 't2i', { unused: [] }],                          // guide de cadrage (profondeur)                         // 2.1 : pas de retouche (Qwen Image Edit)
  ['hf:seedance-2-5', [], 'bytedance/seedance-2.5/text-to-video', { ties: [] }],
  ['hf:seedance-2-5', ['refs'], 'bytedance/seedance-2.5/reference-to-video', {}],
];

let ok = 0;
let ko = 0;
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
for (const [f, conn, want, exp] of CASES) {
  const r = R.chooseWorkflow(fam(f), conn, null);
  const why = [];
  if (!r) why.push('aucun résultat');
  else {
    if (r.workflow.id !== want) why.push(`façon ${r.workflow.id} au lieu de ${want}`);
    if (exp.blocked !== undefined && !!r.blocked !== exp.blocked) why.push(`bloqué ${!!r.blocked}`);
    if (exp.missing && !same(r.missing, exp.missing)) why.push(`manque [${r.missing}]`);
    if (exp.unused && !same(r.unused, exp.unused)) why.push(`ignore [${r.unused}]`);
    if (exp.ties && !same(r.ties.map((w) => w.id), exp.ties)) why.push(`choix [${r.ties.map((w) => w.id)}]`);
  }
  const label = `${f} [${conn.join(', ')}]`;
  if (why.length) { ko++; console.log(`  ÉCHEC ${label} : ${why.join(' · ')}`); } else { ok++; console.log(`  ok    ${label} → ${want}`); }
}

// points forts des familles en ligne (cloud-strengths.json, tenus à la main) : chacune a sa phrase FR et EN, ses
// critères sont de la liste, aucune entrée ne vise une famille disparue ; le moteur les a bien posés sur le catalogue
const strengths = require('../src/catalog/cloud-strengths.json');
for (const def of cloud.families || []) {
  const s = strengths.families[def.key] || {};
  const why = [];
  for (const l of ['fr', 'en']) if (!String((s.strengths || {})[l] || '').trim()) why.push(`phrase ${l.toUpperCase()} absente`);
  if (/[a-zà-ÿ]'[a-zà-ÿ]/i.test((s.strengths || {}).fr || '')) why.push('apostrophe droite en français (’ attendue)');
  const bad = (s.bestFor || []).filter((c) => !strengths.criteria.includes(c));
  if (!Array.isArray(s.bestFor) || !s.bestFor.length) why.push('bestFor vide');
  else if (bad.length) why.push(`critères inconnus [${bad}]`);
  if (JSON.stringify(def.strengths) !== JSON.stringify(s.strengths)) why.push('non posés par engine/route.js');
  const label = `points forts ${def.key}`;
  if (why.length) { ko++; console.log(`  ÉCHEC ${label} : ${why.join(' · ')}`); } else { ok++; console.log(`  ok    ${label}`); }
}
const gone = Object.keys(strengths.families).filter((k) => !(cloud.families || []).some((d) => d.key === k));
if (gone.length) { ko++; console.log(`  ÉCHEC points forts de familles absentes du catalogue : ${gone.join(', ')}`); } else ok++;
console.log(`\n${ok} contrôles réussis, ${ko} échec(s).`);
process.exit(ko ? 1 : 0);
