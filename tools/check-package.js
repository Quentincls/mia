'use strict';
/**
 * Mia — what must hold before a package is built, and the stamp of the package once it is.
 *
 *   node tools/check-package.js           the checks below; exit code 1 when one fails
 *                                         (npm runs it first for dist, dist:zip and dist:dir: « predist »)
 *   afterPack hook of electron-builder    (package.json → build.afterPack) checks LICENSE and NOTICE inside the
 *                                         built app and writes resources\app\build-info.json { version, commit,
 *                                         builtAt }, which electron/version.js reads (Réglages → À propos)
 *
 * Fails when, among the files the package takes (package.json → build.files):
 *   - index.html refers to a stylesheet, script or image that is missing;
 *   - a module of the interface loads a file that is missing: a relative import, new URL('…', import.meta.url),
 *     or a page-relative 'css/…', 'assets/…', 'catalog/…' path (welcome.css was once forgotten in a package);
 *   - a script of the main process require()s a relative module that is missing;
 *   - LICENSE or NOTICE is missing, or CHANGELOG.md has no section (with « En bref » and « In short ») for the
 *     version of package.json;
 *   - a file is empty (a stray « 1 » once was), except __init__.py and .gitkeep;
 *   - a text file holds this PC's home folder (C:\Users\<name>…): a package goes to other people.
 * Notes (without failing) what luts/previews holds: thumbnails rendered from a neutral synthetic scene (an empty room),
 * none of Quentin's own frames.
 *
 * Read only, no dependency, no network. A line that must keep a personal path says so with « privacy-audit: ok ».
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
const readText = (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return null; } };

// ------------------------------------------------------------------------------------------- the packaged files
/** A glob of build.files → a RegExp on « a/b/c » paths: **, *, {a,b}. */
function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      re += '(?:' + glob.slice(i + 1, end).split(',').map((alt) => globRe(alt).source.slice(1, -1)).join('|') + ')';
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

/** Every file electron-builder would take, as « a/b/c » paths relative to Mia's root. */
function packagedFiles(pkg) {
  const globs = (pkg.build && pkg.build.files) || [];
  const plus = globs.filter((g) => !g.startsWith('!')).map(globRe);
  const minus = globs.filter((g) => g.startsWith('!')).map((g) => globRe(g.slice(1)));
  const tops = new Set(globs.filter((g) => !g.startsWith('!')).map((g) => g.split('/')[0]));
  const all = [];
  for (const top of tops) {
    const abs = path.join(ROOT, top);
    let st = null;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) walk(abs, all); else all.push(abs);
  }
  return all.map(rel).filter((p) => plus.some((r) => r.test(p)) && !minus.some((r) => r.test(p)));
}

// ------------------------------------------------------------------------------------------- the checks
const problems = [];
const warnings = [];
const fail = (msg) => problems.push(msg);
const warn = (msg) => warnings.push(msg);
const infos = [];
const info = (msg) => infos.push(msg);

/** The lines of a script that are not comments (a path quoted in a comment is not a load). */
const codeOnly = (code) => code.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

const TEXT = /\.(js|mjs|cjs|json|md|txt|html|css|py|ps1|toml|ya?ml|cube)$/i;

function checkInterface(files) {
  const have = new Set(files);
  const need = (target, from) => {
    const p = rel(target);
    if (have.has(p)) return;
    // a folder (new URL('../catalog/', import.meta.url)): something of it must be packaged
    if (p === '' || files.some((f) => f.startsWith(p.replace(/\/?$/, '/')))) return;
    fail(`${from} : « ${p} » manque dans le paquet`);
  };
  // index.html
  const html = readText(path.join(ROOT, 'src', 'index.html'));
  if (html === null) { fail('src/index.html manque'); return; }
  for (const m of html.matchAll(/\b(?:href|src)\s*=\s*"([^"]+)"/g)) {
    const ref = m[1];
    if (/^(?:[a-z]+:|#|\/\/)/i.test(ref)) continue;
    need(path.join(ROOT, 'src', ref.split(/[?#]/)[0]), 'src/index.html');
  }
  // the modules of the interface
  for (const f of files.filter((p) => /^src\/.*\.m?js$/.test(p))) {
    const abs = path.join(ROOT, f);
    const code = codeOnly(readText(abs) || '');
    const dir = path.dirname(abs);
    for (const m of code.matchAll(/\b(?:import|export)\s[^'"`;]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|^\s*import\s*['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      need(path.resolve(dir, m[1] || m[2] || m[3]), f);
    }
    for (const m of code.matchAll(/new URL\(\s*['"]([^'"$]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) {
      need(path.resolve(dir, m[1].split(/[?#]/)[0]), f);
    }
    for (const m of code.matchAll(/['"]((?:css|assets|catalog)\/[\w./-]+\.(?:css|png|svg|jpe?g|webp|ico|json|woff2?))['"]/g)) {
      need(path.join(ROOT, 'src', m[1]), f);
    }
  }
  // the main process
  for (const f of files.filter((p) => /^(electron|mcp)\/.*\.c?js$/.test(p))) {
    const abs = path.join(ROOT, f);
    const code = codeOnly(readText(abs) || '');
    for (const m of code.matchAll(/\brequire\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const base = path.resolve(path.dirname(abs), m[1]);
      const tries = [base, base + '.js', base + '.json', path.join(base, 'index.js')].map(rel);
      if (!tries.some((p) => have.has(p))) fail(`${f} : require('${m[1]}') ne trouve rien dans le paquet`);
    }
  }
}

function checkLegal(pkg, files) {
  const have = new Set(files);
  for (const f of ['LICENSE', 'NOTICE', 'CHANGELOG.md', 'package.json']) {
    if (!fs.existsSync(path.join(ROOT, f))) fail(`${f} manque à la racine de Mia`);
    else if (!have.has(f)) fail(`${f} n'est pas dans build.files de package.json`);
  }
  const md = readText(path.join(ROOT, 'CHANGELOG.md')) || '';
  const { parseChangelog } = require('../electron/version.js');
  const sec = parseChangelog(md).find((s) => s.version === pkg.version);
  if (!sec) fail(`CHANGELOG.md n'a pas de section « ## ${pkg.version} — jj/mm/aaaa »`);
  else {
    if (!/^###\s+En bref\s*$/mi.test(sec.body)) fail(`CHANGELOG.md ${pkg.version} : pas de « ### En bref » (ce que montre Nouveautés en français)`);
    if (!/^###\s+In short\s*$/mi.test(sec.body)) fail(`CHANGELOG.md ${pkg.version} : pas de « ### In short » (ce que montre Nouveautés en anglais)`);
  }
}

function checkEmpty(files) {
  for (const f of files) {
    if (/(^|\/)(__init__\.py|\.gitkeep|\.keep)$/.test(f)) continue;
    let size = 1;
    try { size = fs.statSync(path.join(ROOT, f)).size; } catch { /* gone */ }
    if (size === 0) fail(`${f} : fichier vide (à supprimer, ou à exclure dans build.files)`);
  }
}

function checkPrivacy(files) {
  const user = (() => { try { return os.userInfo().username; } catch { return process.env.USERNAME || ''; } })();
  if (!user) return;
  const esc = user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const home = new RegExp(`(?:[A-Za-z]:|/[a-z])?[\\\\/]+Users[\\\\/]+${esc}(?![\\w.-])`, 'i');
  for (const f of files.filter((p) => TEXT.test(p))) {
    const text = readText(path.join(ROOT, f));
    if (text === null) continue;
    const lines = text.split(/\r?\n/);
    const hits = [];
    lines.forEach((line, i) => { if (home.test(line) && !line.includes('privacy-audit: ok')) hits.push(i + 1); });
    if (hits.length) fail(`${f} : chemin personnel (dossier de ${user}) ligne${hits.length > 1 ? 's' : ''} ${hits.slice(0, 6).join(', ')}${hits.length > 6 ? '…' : ''}`);
  }
  const frames = files.filter((p) => /^luts\/previews\/.+\.(jpe?g|png|webp)$/i.test(p));
  if (frames.length) info(`luts/previews : ${frames.length} vignettes rendues sur une scène neutre (une pièce vide de synthèse), aucune image de Quentin`);
}

function runChecks() {
  const pkg = JSON.parse(readText(path.join(ROOT, 'package.json')) || '{}');
  const files = packagedFiles(pkg);
  if (!files.length) fail('build.files de package.json ne retient aucun fichier');
  checkInterface(files);
  checkLegal(pkg, files);
  checkEmpty(files);
  checkPrivacy(files);
  return { pkg, files };
}

// ------------------------------------------------------------------------------------------- afterPack
/** electron-builder, once the app folder is built (before the zip and the installer): check, then stamp it. */
async function afterPack(context) {
  const appDir = path.join(context.appOutDir, 'resources', 'app');
  for (const f of ['LICENSE', 'NOTICE', 'CHANGELOG.md', 'package.json']) {
    if (!fs.existsSync(path.join(appDir, f))) throw new Error(`check-package : ${f} manque dans ${appDir}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  const { gitCommit } = require('../electron/version.js');
  const info = { version: pkg.version, commit: gitCommit(ROOT), builtAt: new Date().toISOString() };
  fs.writeFileSync(path.join(appDir, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
  console.log(`  • check-package : build-info.json ${JSON.stringify(info)}`);
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.runChecks = runChecks;
module.exports.globRe = globRe;

if (require.main === module) {
  const { pkg, files } = runChecks();
  for (const i of infos) console.log(`INFO       ${i}`);
  for (const w of warnings) console.log(`ATTENTION  ${w}`);
  if (problems.length) {
    for (const p of problems) console.log(`ÉCHEC      ${p}`);
    console.log(`\n${problems.length} problème(s) : pas de paquet tant qu'ils restent.`);
    process.exit(1);
  }
  console.log(`Paquet de Mia ${pkg.version} : ${files.length} fichiers vérifiés, tout est en ordre.`);
}
