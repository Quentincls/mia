// Typographie française de Mia : dans les textes français, l'apostrophe est typographique (’, U+2019),
// jamais droite ('). Partagé par tools/check-syntax.mjs (contrôle) et utilisable seul :
//   node tools/french-typo.mjs           liste les apostrophes droites des textes français (code 1 s'il y en a)
//   node tools/french-typo.mjs --fix     les remplace par ’
// Où sont les textes français (tout ce qui finit à l'écran) :
//   - les tables de traduction du code : `fr: { … }` (register, électron) et le premier objet de `strings({ … }, { … })` ;
//   - les paires du processus principal : `tr(x, 'fr', 'en')` (exécuteurs) et `say('fr', 'en')` (scanner) ;
//   - le worker Python : `tr("fr", "en")` (python/, sauf python/vendor) ;
//   - le script d'installation du moteur : `T "fr" "en"` (engine-setup/install-engine.ps1) ;
//   - les champs "fr" du catalogue (src/catalog/nodes.json, recettes) ;
//   - les sections françaises de CHANGELOG.md (affiché tel quel dans « Nouveautés »).
// Seule une apostrophe ENTRE DEUX LETTRES est visée (l’accueil, d’images) : les guillemets de code restent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
const SKIP = new Set(['node_modules', '.git', 'fixtures', 'vendor', '__pycache__']);

/** Fin (exclue) du littéral JS qui commence à `a` (son guillemet), gabarits `${…}` compris. */
function jsLiteralEnd(src, a) {
  const q = src[a];
  let i = a + 1;
  if (q !== '`') {
    while (i < src.length && src[i] !== q && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
    return i + 1;
  }
  while (i < src.length && src[i] !== '`') {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '$' && src[i + 1] === '{') { // expression : on la saute en comptant ses accolades
      let d = 0;
      i += 2;
      while (i < src.length && !(src[i] === '}' && d === 0)) { if (src[i] === '{') d++; else if (src[i] === '}') d--; i++; }
    }
    i++;
  }
  return i + 1;
}

/** Étendues [début, fin[ des littéraux de chaîne d'un objet JS qui commence à `open` (son « { »). */
function stringsOfObject(src, open) {
  const spans = [];
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) break; i += 2; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      const end = jsLiteralEnd(src, i);
      spans.push([i, end, c]);
      i = end;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  return spans;
}

const LETTER_APOS_LETTER = /(\p{L})(\\'|')(\p{L})/gu;

/** Textes français d'un fichier JS : étendues des chaînes des tables fr et des paires tr(…) / say(…). */
function frSpansJs(src) {
  const out = [];
  const starts = [];
  for (const m of src.matchAll(/\bfr\s*:\s*\{/g)) starts.push(m.index + m[0].length - 1);
  for (const m of src.matchAll(/\bstrings\(\s*\{/g)) starts.push(m.index + m[0].length - 1);
  for (const s of starts) out.push(...stringsOfObject(src, s));
  // { fr: 'texte', en: 'text' } : la chaîne qui suit « fr: » ;
  // tr(x, 'texte', 'text') : la chaîne après le contexte ; say('texte', 'text') : la première
  const lead = [/\bfr\s*:\s*(?=['"`])/g, /\btr\(\s*[A-Za-z_$][\w$.]*\s*,\s*(?=['"`])/g, /\bsay\(\s*(?=['"`])/g];
  for (const re of lead) {
    for (const m of src.matchAll(re)) {
      const a = m.index + m[0].length;
      out.push([a, jsLiteralEnd(src, a), src[a]]);
    }
  }
  return out;
}

/** Worker Python : le premier argument de tr("texte", "text"), f-chaînes comprises. */
function frSpansPy(src) {
  const out = [];
  for (const m of src.matchAll(/\btr\(\s*[fFrRuU]{0,2}(?=["'])/g)) {
    const a = m.index + m[0].length;
    const q = src.startsWith('"""', a) || src.startsWith("'''", a) ? src.slice(a, a + 3) : src[a];
    let i = a + q.length;
    while (i < src.length && !src.startsWith(q, i) && (q.length === 3 || src[i] !== '\n')) i += src[i] === '\\' ? 2 : 1;
    out.push([a, i + q.length, q]);
  }
  return out;
}

/** Script PowerShell : le premier argument de T "texte" "text" (échappement ` et "" doublé). */
function frSpansPs1(src) {
  const out = [];
  for (const m of src.matchAll(/\bT\s+(?=")/g)) {
    const a = m.index + m[0].length;
    let i = a + 1;
    while (i < src.length && src[i] !== '\n') {
      if (src[i] === '`') { i += 2; continue; }
      if (src[i] === '"') { if (src[i + 1] === '"') { i += 2; continue; } break; }
      i++;
    }
    out.push([a, i + 1, '"']);
  }
  return out;
}

function frSpansJson(src) {
  const out = [];
  for (const m of src.matchAll(/"fr"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    const start = m.index + m[0].indexOf('"', m[0].indexOf(':'));
    out.push([start, m.index + m[0].length, '"']);
  }
  return out;
}

/** CHANGELOG.md : les sections françaises (« ### En bref », « ### Ajouté »…) jusqu'au titre anglais suivant. */
function frSpansChangelog(src) {
  const out = [];
  const lines = src.split('\n');
  let pos = 0;
  let fr = true;          // par défaut, un texte de Mia est en français
  for (const l of lines) {
    const h = /^#{2,4}\s+(.*?)\r?$/.exec(l);           // \r : fins de ligne Windows (CRLF)
    // seule la section « In short » est en anglais ; tout le reste du journal est en français
    if (h) fr = !/^in short(\s|$)/i.test(h[1].trim());
    if (fr && !h) out.push([pos, pos + l.length, 'md']);
    pos += l.length + 1;
  }
  return out;
}

function filesOf(dirs) {
  const files = [];
  const walk = (abs) => {
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isFile()) { files.push(abs); return; }
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) if (!SKIP.has(e.name)) walk(path.join(abs, e.name));
  };
  for (const d of dirs) walk(path.resolve(ROOT, d));
  return files;
}

/** [{ file, line, text }] des apostrophes droites ; avec fix, réécrit les fichiers. */
export function frenchApostrophes({ fix = false } = {}) {
  const found = [];
  const files = filesOf(['src/js', 'electron', 'mcp', 'python', 'src/catalog', 'engine-setup/install-engine.ps1', 'CHANGELOG.md']);
  for (const abs of files) {
    let kind = null;
    if (/\.(c|m)?js$/i.test(abs)) kind = 'js';
    else if (/\.py$/i.test(abs)) kind = 'py';
    else if (/\.ps1$/i.test(abs)) kind = 'ps1';
    else if (/\.json$/i.test(abs)) kind = 'json';
    else if (/CHANGELOG\.md$/i.test(abs)) kind = 'md';
    if (!kind) continue;
    const src = fs.readFileSync(abs, 'utf8');
    const spans = kind === 'js' ? frSpansJs(src) : kind === 'py' ? frSpansPy(src) : kind === 'ps1' ? frSpansPs1(src)
      : kind === 'json' ? frSpansJson(src) : frSpansChangelog(src);
    if (!spans.length) continue;
    spans.sort((a, b) => a[0] - b[0]);
    let out = '';
    let last = 0;
    let changed = false;
    for (const [a, b] of spans) {
      if (a < last) continue;
      const piece = src.slice(a, b);
      const fixed = piece.replace(LETTER_APOS_LETTER, (m, p, q, r) => {
        const line = src.slice(0, a).split('\n').length;
        found.push({ file: rel(abs), line, text: piece.length > 90 ? piece.slice(0, 87) + '…' : piece });
        return p + '’' + r;
      });
      if (fixed !== piece) changed = true;
      out += src.slice(last, a) + fixed;
      last = b;
    }
    out += src.slice(last);
    if (fix && changed) {
      if (kind === 'json') JSON.parse(out);
      fs.writeFileSync(abs, out);
    }
  }
  return found;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fix = process.argv.includes('--fix');
  const found = frenchApostrophes({ fix });
  for (const f of found) console.log(`${f.file}:${f.line}  ${f.text}`);
  console.log(found.length
    ? `${found.length} apostrophe(s) droite(s) dans des textes français${fix ? ' : remplacées par ’.' : ' (node tools/french-typo.mjs --fix).'}`
    : 'Textes français : apostrophes typographiques partout.');
  if (found.length && !fix) process.exitCode = 1;
}
