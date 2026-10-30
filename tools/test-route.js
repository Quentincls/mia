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
  // mode choisi (30/10) : en ligne, il passe devant le score ; il dit ce qui lui manque et ce qu'il ignore
  ['hf:kling-4-0', ['video'], 'kling-video/v4.0/video-edit', { forced: false }],
  ['hf:kling-4-0', ['video'], 'kling-video/v4.0/image-to-video', { blocked: true, missing: ['start'], unused: ['video'], forced: true, auto: 'kling-video/v4.0/video-edit' }, 'kling-video/v4.0/image-to-video'],
  ['hf:kling-4-0', [], 'kling-video/v4.0/reference-to-video', { blocked: true, missing: ['refs'], forced: true }, 'kling-video/v4.0/reference-to-video'],
  ['hf:kling-4-0', ['start'], 'kling-video/v4.0/text-to-video', { blocked: false, unused: ['start'], forced: true, auto: 'kling-video/v4.0/image-to-video' }, 'kling-video/v4.0/text-to-video'],
  ['hf:kling-4-0', ['start'], 'kling-video/v4.0/image-to-video', { forced: false }, 'auto'],
  ['hf:kling-4-0', ['start'], 'kling-video/v4.0/image-to-video', { forced: false }, 'mode-qui-n-existe-pas'],
  // sur ce PC, le choix ne fait toujours que départager (planches d'avant inchangées)
  ['fam:ltx', ['video', 'start'], 'real', { forced: false }, 'i2v'],
];

let ok = 0;
let ko = 0;
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
for (const [f, conn, want, exp, choice = null] of CASES) {
  const r = R.chooseWorkflow(fam(f), conn, choice);
  const why = [];
  if (!r) why.push('aucun résultat');
  else {
    if (r.workflow.id !== want) why.push(`façon ${r.workflow.id} au lieu de ${want}`);
    if (exp.blocked !== undefined && !!r.blocked !== exp.blocked) why.push(`bloqué ${!!r.blocked}`);
    if (exp.missing && !same(r.missing, exp.missing)) why.push(`manque [${r.missing}]`);
    if (exp.unused && !same(r.unused, exp.unused)) why.push(`ignore [${r.unused}]`);
    if (exp.ties && !same(r.ties.map((w) => w.id), exp.ties)) why.push(`choix [${r.ties.map((w) => w.id)}]`);
    if (exp.forced !== undefined && !!r.forced !== exp.forced) why.push(`choisi ${!!r.forced}`);
    if (exp.auto && r.auto?.id !== exp.auto) why.push(`auto ${r.auto?.id}`);
  }
  const label = `${f} [${conn.join(', ')}]${choice ? ` ← ${choice}` : ''}`;
  if (why.length) { ko++; console.log(`  ÉCHEC ${label} : ${why.join(' · ')}`); } else { ok++; console.log(`  ok    ${label} → ${want}`); }
}
// Rangée « Mode » (30/10) : deux modes d'une même famille ne portent jamais le même mot (« Auto · Texte · Texte »
// chez SOUL V2) ; un mot en double laisse la place au libellé entier, qui doit alors les distinguer (FR et EN).
(async () => {
  // module pur sans import : lu tel quel (un import() ESM depuis ce banc CommonJS ferait un avertissement de Node)
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/js/nodes/waywords.js'), 'utf8').replace(/^export /gm, '');
  const { wordKey, modeWordKeys } = new Function(`${src}
return { wordKey, modeWordKeys };`)();
  const famList = [...Object.values(local.families || {}), ...Object.values(cloud.families || {})];
  for (const def of famList) {
    const wfs = def.workflows || [];
    if (wfs.length < 2) continue;
    const keys = modeWordKeys(wfs);
    const bad = [];
    for (const lg of ['fr', 'en']) {
      const shown = wfs.map((w, i) => keys[i] || `=${(w.label || {})[lg] || w.id}`);
      const dup = shown.filter((x, i) => shown.indexOf(x) !== i);
      if (dup.length) bad.push(`${lg} : ${[...new Set(dup)].join(', ')}`);
    }
    if (bad.length) { ko++; console.log(`  ÉCHEC modes de ${def.name} : même libellé (${bad.join(' · ')})`); } else ok++;
  }
  const soul = wordKey({ id: 'higgsfield-ai/soul/v2/image-to-image' });
  if (soul !== 'edit') { ko++; console.log(`  ÉCHEC SOUL V2 image vers image → ${soul} au lieu de edit`); }
  else { ok++; console.log('  ok    SOUL V2 image vers image → Retouche'); }
  console.log(`\n${ok} contrôles réussis, ${ko} échec(s).`);
  process.exit(ko ? 1 : 0);
})();
