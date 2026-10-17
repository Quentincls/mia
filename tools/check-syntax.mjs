// Vérifie la syntaxe de tout le JavaScript de Mia, sans rien exécuter, dans n'importe quel terminal (PowerShell compris).
//   node tools/check-syntax.mjs                       electron, mcp, tools, src/js, assets/src
//   node tools/check-syntax.mjs src/js electron/main.js   seulement ces dossiers ou fichiers
// L'interface (src/js) et les .mjs sont lus comme modules ES ; le reste (processus principal, serveur MCP, outils)
// comme du CommonJS. Code de sortie 1 s'il y a une erreur.
// Sans argument, vérifie aussi la typographie des textes français (tools/french-typo.mjs) : une apostrophe droite
// entre deux lettres dans un texte français affiché (tables fr, tr(…) / say(…) du processus principal, tr() du worker
// Python, T "…" du script d'installation, champs "fr" du catalogue, CHANGELOG.md) est une erreur (’ attendue).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { frenchApostrophes } from './french-typo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT = ['electron', 'mcp', 'tools', 'src/js', 'assets/src'];
const SKIP = new Set(['node_modules', '.git']);
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

function walk(abs, out) {
  const st = fs.statSync(abs, { throwIfNoEntry: false });
  if (!st) { console.error(`introuvable : ${abs}`); process.exitCode = 1; return; }
  if (st.isFile()) { if (/\.(c|m)?js$/i.test(abs)) out.push(abs); return; }
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (!SKIP.has(e.name)) walk(path.join(abs, e.name), out);
  }
}

const isModule = (abs) => /\.mjs$/i.test(abs) || (/\.js$/i.test(abs) && rel(abs).startsWith('src/js/'));

const files = [];
for (const a of (process.argv.length > 2 ? process.argv.slice(2) : DEFAULT)) walk(path.resolve(ROOT, a), files);

let bad = 0;
for (const abs of files) {
  // module ES : lu sur l'entrée standard avec --input-type=module (un .js seul serait pris pour du CommonJS)
  const r = isModule(abs)
    ? spawnSync(process.execPath, ['--input-type=module', '--check'], { input: fs.readFileSync(abs), encoding: 'utf8' })
    : spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
  if (r.status === 0) continue;
  bad++;
  const msg = String(r.stderr || r.error || '').replace(/^\[stdin\]/gm, rel(abs)).split(/\r?\n/)
    .filter((l) => l.trim() && !/^\s+at |^Node\.js v/.test(l)).join('\n');
  console.log(`✗ ${rel(abs)}\n${msg.replace(/^/gm, '    ')}`);
}
console.log(`${files.length} fichiers JavaScript vérifiés : ${bad ? `${bad} en erreur.` : 'syntaxe correcte.'}`);
if (bad) process.exitCode = 1;

if (process.argv.length <= 2) {
  const apos = frenchApostrophes();
  for (const a of apos) console.log(`✗ ${a.file}:${a.line}  apostrophe droite dans un texte français : ${a.text}`);
  console.log(apos.length
    ? `Textes français : ${apos.length} apostrophe(s) droite(s) (’ attendue ; node tools/french-typo.mjs --fix).`
    : 'Textes français : apostrophes typographiques partout.');
  if (apos.length) process.exitCode = 1;
}
