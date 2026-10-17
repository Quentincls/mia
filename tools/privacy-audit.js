'use strict';
/**
 * Mia — privacy audit before a public push.
 *
 * Lists every file that would be committed (git's own list when the folder is a repository, otherwise the
 * .gitignore rules applied here), then scans each one for what should not leave this PC:
 *
 *   high    home-path      C:\Users\<name>\…, /c/Users/<name>/…, /home/<name>/… (any user but a placeholder)
 *   high    username       the current Windows user name, as a word
 *   high    secret         access tokens and keys (Hugging Face, GitHub, OpenAI, Anthropic, AWS, Google,
 *                          Slack, private keys, "token": "<long hex>"…)
 *   high    weights        model files (.safetensors, .ckpt, .gguf, .pth, .pt)
 *   high    data-file      files that hold user data or secrets (bridge.json, prefs.json, .env, *.pem…)
 *   high    term           your own words (--terms / MIA_PRIVACY_TERMS): names, client names, places
 *   medium  hostname       this PC's name, and DESKTOP-XXXX / LAPTOP-XXXX machine names (a PC named like the
 *                          author declared in NOTICE, "Copyright <year> <name>", is not reported: that name is
 *                          public on purpose, and every credit would otherwise read as a machine name)
 *   medium  email          e-mail addresses (no-reply and example addresses are ignored)
 *   medium  lan-address    private network addresses (10.x, 192.168.x, 172.16–31.x)
 *   medium  doc-abs-path   absolute drive paths (D:\…) in documentation (.md, .txt, .html)
 *   medium  large-file     files over 5 MB
 *   low     code-abs-path  absolute drive paths in code and data (defaults are fine, personal folders are not)
 *
 * Images: PNG text chunks (tEXt, zTXt, iTXt, where tools hide prompts and paths) and the readable strings of
 * other binaries are scanned too.
 *
 *   node tools/privacy-audit.js                    report, grouped by severity
 *   node tools/privacy-audit.js --terms a,b,c      also look for these words (or --terms-file <file>, one per line)
 *   node tools/privacy-audit.js --json             machine-readable findings
 *   node tools/privacy-audit.js --max 5            at most 5 lines per rule and file (default 8; 0 = all)
 *   node tools/privacy-audit.js --strict           exit code 1 when a high finding remains
 *   node tools/privacy-audit.js --list             only print the files that would be committed
 *
 * A line that is fine as it is can say so with the marker "privacy-audit: ok" (in a comment).
 * Read-only: the audit never changes a file. No dependency, no network.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

// ------------------------------------------------------------------------------------------- options
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const ROOT = path.resolve(opt('--root', path.join(__dirname, '..')));
const JSON_OUT = flag('--json');
const STRICT = flag('--strict');
const LIST_ONLY = flag('--list');
const MAX_PER = Math.max(0, Number(opt('--max', '8')) || 0);
const BIG_BYTES = 5 * 1024 * 1024;
const OK_MARK = 'privacy-audit: ok';

const USER = safe(() => os.userInfo().username, '') || process.env.USERNAME || '';
const HOST = safe(() => os.hostname(), '') || process.env.COMPUTERNAME || '';
const HOME = safe(() => os.homedir(), '');

function safe(fn, dflt) { try { return fn(); } catch { return dflt; } }
function reEscape(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function loadTerms() {
  const out = [];
  const add = (list) => { for (const t of list) { const s = String(t || '').trim(); if (s.length >= 3) out.push(s); } };
  const inline = opt('--terms');
  if (inline) add(inline.split(','));
  const file = opt('--terms-file');
  if (file) add(fs.readFileSync(path.resolve(file), 'utf8').split(/\r?\n/).filter((l) => !l.startsWith('#')));
  if (process.env.MIA_PRIVACY_TERMS) add(process.env.MIA_PRIVACY_TERMS.split(','));
  return [...new Set(out)];
}
const TERMS = loadTerms();

/** The author's name as NOTICE declares it ("Copyright 2026 Jane Doe" → ["Jane", "Doe"]). */
function authorWords() {
  let text = '';
  try { text = fs.readFileSync(path.join(ROOT, 'NOTICE'), 'utf8'); } catch { return []; }
  const m = text.match(/^[ \t]*Copyright[ \t]+(?:\(c\)[ \t]*|©[ \t]*)?\d{4}(?:[ \t]*[-–][ \t]*(?:\d{4}|present))?[ \t]+(.+?)[ \t]*$/im);
  if (!m) return [];
  return m[1].split(/[\s,.]+/).filter((w) => w.length >= 3 && !/^(and|the|et|contributors?)$/i.test(w));
}
const AUTHOR = authorWords();
const sameWord = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
const HOST_IS_AUTHOR = !!HOST && AUTHOR.some((w) => sameWord(w, HOST));

// ------------------------------------------------------------------------------- files to be committed
/** One .gitignore pattern → { neg, dirOnly, re } (git's rules: anchoring, *, **, ?, [..], trailing /). */
function compilePattern(line) {
  let p = line.replace(/\s+$/, '');
  if (!p || p.startsWith('#')) return null;
  let neg = false;
  if (p.startsWith('!')) { neg = true; p = p.slice(1); }
  if (p.startsWith('\\')) p = p.slice(1);
  let dirOnly = false;
  if (p.endsWith('/')) { dirOnly = true; p = p.slice(0, -1); }
  const anchored = p.startsWith('/') || p.includes('/');
  if (p.startsWith('/')) p = p.slice(1);
  let body = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      const before = i === 0 || p[i - 1] === '/';
      const after = p[i + 2] === '/' || i + 2 === p.length;
      if (before && after) {
        if (p[i + 2] === '/') { body += '(?:.*/)?'; i += 2; } else { body += '.*'; i += 1; }
        continue;
      }
      body += '[^/]*'; i += 1; continue;
    }
    if (c === '*') { body += '[^/]*'; continue; }
    if (c === '?') { body += '[^/]'; continue; }
    if (c === '[') {
      const j = p.indexOf(']', i + 1);
      if (j > i) { body += '[' + p.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = j; continue; }
    }
    body += reEscape(c);
  }
  const re = new RegExp((anchored ? '^' : '(?:^|/)') + body + '$');
  return { neg, dirOnly, re };
}

function readIgnore(dirAbs, base) {
  const file = path.join(dirAbs, '.gitignore');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split(/\r?\n/).map(compilePattern).filter(Boolean).map((r) => ({ ...r, base }));
}

function isIgnored(rules, rel, isDir) {
  let hit = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    let sub = rel;
    if (r.base) {
      if (!rel.startsWith(r.base + '/')) continue;
      sub = rel.slice(r.base.length + 1);
    }
    if (r.re.test(sub)) hit = !r.neg;
  }
  return hit;
}

/** The files git would commit, from .gitignore alone (used before `git init`). */
function walkFiles() {
  const out = [];
  const walk = (dirAbs, rel, rules) => {
    const here = rules.concat(readIgnore(dirAbs, rel));
    let entries;
    try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (e.name === '.git' || isIgnored(here, r, true)) continue;
        walk(path.join(dirAbs, e.name), r, here);
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (!isIgnored(here, r, false)) out.push(r);
      }
    }
  };
  walk(ROOT, '', []);
  return out;
}

/** git's own list when the folder is a repository (tracked + untracked not ignored). */
function gitFiles() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) return null;
  const r = spawnSync('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  return r.stdout.split('\0').filter(Boolean).filter((f) => fs.existsSync(path.join(ROOT, f))).sort();
}

// ------------------------------------------------------------------------------------------ the rules
const TEXT_DOC = /\.(md|markdown|txt|html?|rst)$/i;
const WEIGHTS = /\.(safetensors|ckpt|gguf|pth|pt|onnx|bin)$/i;
const DATA_FILE = /(^|\/)(bridge\.json|prefs\.json|loras\.json|\.env(\..*)?|id_rsa|id_ed25519|.*\.pem|.*\.key|.*\.pfx|.*\.p12|credentials\.json|token)$/i;
// placeholders that stand for "any user" in documentation
const PLACEHOLDER_USER = /^(<[^>]*>|%[^%]+%|\$\{?\w+\}?|\{[^}]*\}|public|default|all users|default user|username|user|you|your[-_ ]?name|name|me|xxx+|\.\.\.|…)$/i;

const RULES = [];
function rule(id, severity, re, { test = null, docOnly = false, codeOnly = false, skip = null } = {}) {
  RULES.push({ id, severity, re, test, docOnly, codeOnly, skip });
}
// third-party metadata (package authors' addresses in the npm lockfile) is not ours to report
const THIRD_PARTY = /(^|\/)package-lock\.json$/;

// paths in a user's home folder, whatever the separator
rule('home-path', 'high', /(?:\b[A-Za-z]:|\/[a-z]|^|[\s"'`(=])[\\/]{1,2}(?:Users|home)[\\/]{1,2}([^\\/\s"'`<>|:*?)\]]+)/gi, {
  test: (m) => !PLACEHOLDER_USER.test(m[1])
});
// a whole word, accented letters included (a short user name hidden inside « fréquent » is not a finding)
const word = (w) => new RegExp(`(?<![\\p{L}\\p{N}_-])${reEscape(w)}(?![\\p{L}\\p{N}_-])`, 'giu');
if (USER.length >= 3) rule('username', 'high', word(USER));
for (const t of TERMS) rule('term', 'high', word(t));

rule('secret', 'high', /\bhf_[A-Za-z0-9]{30,}\b/g);
rule('secret', 'high', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g);
rule('secret', 'high', /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g);
rule('secret', 'high', /\bsk-ant-[A-Za-z0-9_-]{20,}/g);
rule('secret', 'high', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g);
rule('secret', 'high', /\bAKIA[0-9A-Z]{16}\b/g);
rule('secret', 'high', /\bAIza[0-9A-Za-z_-]{35}\b/g);
rule('secret', 'high', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g);
rule('secret', 'high', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g);
rule('secret', 'high', /["']?(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|auth)["']?\s*[:=]\s*["'`]([A-Za-z0-9_\-+/=]{24,})["'`]/gi, {
  test: (m) => /[0-9]/.test(m[1]) && /[a-z]/i.test(m[1]) && !/^(x+|your|example|placeholder)/i.test(m[1]) && !/test|fake|dummy|sample/i.test(m[1])
});
rule('secret', 'high', /\bBearer\s+([A-Za-z0-9._\-]{32,})/g, { test: (m) => /[0-9]/.test(m[1]) && !/\$\{|<|\+/.test(m[0]) });

if (HOST.length >= 3 && !HOST_IS_AUTHOR) rule('hostname', 'medium', word(HOST));
rule('hostname', 'medium', /\b(?:DESKTOP|LAPTOP|WIN|PC)-[A-Z0-9]{6,}\b/g);
rule('email', 'medium', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, {
  test: (m) => !/@(?:example\.(?:com|org|net)|users\.noreply\.github\.com|noreply\.[\w.]+|localhost)$/i.test(m[0])
    && !/^(?:noreply|no-reply|git|user|name|you|someone)@/i.test(m[0])
    && !/\.(png|jpe?g|webp|svg|gif|js|css)$/i.test(m[0]),
  skip: THIRD_PARTY
});
rule('lan-address', 'medium', /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g);
// absolute drive paths: medium in documentation, low in code (a default engine folder is fine, a personal one is not)
const DRIVE_PATH = /(?<![\w/\\])[A-Za-z]:[\\/]{1,2}(?![\\/])[^\s"'`<>|*?,;)\]]+/g;
const SYSTEM_PATH = /^[A-Za-z]:[\\/]{1,2}(?:Windows|Program Files|ProgramData|Users[\\/]{1,2}(?:Public|Default))\b/i;
// Mia's documented defaults and examples: not anybody's personal folder
const EXAMPLE_PATH = /^[A-Za-z]:[\\/]{1,2}(?:Mia[\\/]{1,2}Projets|Mia-(?:engine|moteur))(?![\w-])|^[A-Za-z]:[\\/]{1,2}Mia(?:[\\/]{1,2}(?:Projects|Moteur|Engine))?[\\/]{0,2}$|path[\\/]{1,2}to[\\/]|chemin[\\/]{1,2}vers[\\/]|[<{%…]|\.\.\.|^[A-Za-z]:[\\/]{1,2}(?:Users|home)[\\/]{0,2}$/i;
const drivePathOk = (m) => m[0].length > 3 && !SYSTEM_PATH.test(m[0]) && !EXAMPLE_PATH.test(m[0]);
rule('doc-abs-path', 'medium', DRIVE_PATH, { docOnly: true, test: drivePathOk });
rule('code-abs-path', 'low', new RegExp(DRIVE_PATH.source, 'g'), { codeOnly: true, test: drivePathOk });

// ------------------------------------------------------------------------------------------- reading
function decode(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const sw = Buffer.from(buf.slice(2));
    for (let i = 0; i + 1 < sw.length; i += 2) { const a = sw[i]; sw[i] = sw[i + 1]; sw[i + 1] = a; }
    return sw.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  return buf.toString('utf8');
}

function isBinary(buf) {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return false;
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** PNG text chunks: tools write prompts, workflows and paths there. */
function pngText(buf) {
  const out = [];
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return out;
  let o = 8;
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    const data = buf.slice(o + 8, o + 8 + len);
    try {
      if (type === 'tEXt') out.push(data.toString('latin1').replace('\0', ': '));
      else if (type === 'zTXt') {
        const k = data.indexOf(0);
        out.push(data.slice(0, k).toString('latin1') + ': ' + zlib.inflateSync(data.slice(k + 2)).toString('latin1'));
      } else if (type === 'iTXt') {
        const k = data.indexOf(0);
        const compressed = data[k + 1] === 1;
        let p = k + 3;
        p = data.indexOf(0, p) + 1;           // language tag
        p = data.indexOf(0, p) + 1;           // translated keyword
        const body = data.slice(p);
        out.push(data.slice(0, k).toString('latin1') + ': ' + (compressed ? zlib.inflateSync(body) : body).toString('utf8'));
      }
    } catch { /* a damaged chunk is not a finding */ }
    if (type === 'IEND') break;
    o += 12 + len;
  }
  return out;
}

/** Readable ASCII runs of a binary file (EXIF, XMP, embedded paths). */
function strings(buf, min = 8) {
  const out = [];
  let cur = '';
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c >= 0x20 && c < 0x7f) cur += String.fromCharCode(c);
    else { if (cur.length >= min) out.push(cur); cur = ''; }
  }
  if (cur.length >= min) out.push(cur);
  return out;
}

// ------------------------------------------------------------------------------------------ scanning
function snippet(line, idx, len) {
  const a = Math.max(0, idx - 48);
  const b = Math.min(line.length, idx + len + 48);
  const s = (a > 0 ? '…' : '') + line.slice(a, idx) + '[' + line.slice(idx, idx + len) + ']' + line.slice(idx + len, b) + (b < line.length ? '…' : '');
  return s.replace(/\s+/g, ' ').trim();
}

function scanLines(rel, lines, findings, { isDoc, where = '' }) {
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (!line || line.includes(OK_MARK)) continue;
    const seen = [];   // spans already reported on this line (a home path is not also a "username" finding)
    for (const r of RULES) {
      if (r.docOnly && !isDoc) continue;
      if (r.codeOnly && isDoc) continue;
      if (r.skip && r.skip.test(rel)) continue;
      r.re.lastIndex = 0;
      let m;
      while ((m = r.re.exec(line))) {
        if (m[0].length === 0) { r.re.lastIndex++; continue; }
        if (r.test && !r.test(m)) continue;
        const s = m.index, e = m.index + m[0].length;
        if (seen.some(([x, y]) => s < y && e > x)) continue;
        seen.push([s, e]);
        findings.push({ severity: r.severity, rule: r.id, file: rel, line: n + 1, where, text: snippet(line, s, m[0].length) });
      }
    }
  }
}

function scanFile(rel, findings) {
  const abs = path.join(ROOT, rel);
  let st;
  try { st = fs.statSync(abs); } catch { return; }
  const base = rel.split('/').pop();
  if (WEIGHTS.test(base) && st.size > 1024 * 1024) {
    findings.push({ severity: 'high', rule: 'weights', file: rel, line: 0, text: `model weights (${(st.size / 1048576).toFixed(1)} MB) never belong in git` });
  }
  if (DATA_FILE.test(rel)) findings.push({ severity: 'high', rule: 'data-file', file: rel, line: 0, text: 'user data or secret file' });
  if (st.size > BIG_BYTES) findings.push({ severity: 'medium', rule: 'large-file', file: rel, line: 0, text: `${(st.size / 1048576).toFixed(1)} MB` });
  if (st.size > 64 * 1024 * 1024) return;     // too big to read: already reported
  let buf;
  try { buf = fs.readFileSync(abs); } catch { return; }
  const isDoc = TEXT_DOC.test(base);
  if (isBinary(buf)) {
    const chunks = /\.png$/i.test(base) ? pngText(buf) : [];
    const lines = chunks.length ? chunks.flatMap((c) => c.split(/\r?\n/)) : strings(buf);
    scanLines(rel, lines, findings, { isDoc: false, where: chunks.length ? 'png-text' : 'binary' });
    return;
  }
  scanLines(rel, decode(buf).split(/\r?\n/), findings, { isDoc });
}

// ------------------------------------------------------------------------------------------- report
function main() {
  let files = gitFiles();
  const source = files ? 'git ls-files' : '.gitignore rules';
  if (!files) files = walkFiles();

  if (LIST_ONLY) { for (const f of files) console.log(f); console.log(`\n${files.length} files (${source})`); return 0; }

  const findings = [];
  for (const f of files) scanFile(f, findings);
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.line - b.line);

  if (JSON_OUT) {
    console.log(JSON.stringify({ root: ROOT, source, files: files.length, user: USER, host: HOST, hostIsAuthor: HOST_IS_AUTHOR,
      author: AUTHOR, terms: TERMS, findings }, null, 1));
  } else {
    const count = (sev) => findings.filter((f) => f.severity === sev).length;
    console.log(`Mia privacy audit: ${files.length} files would be committed (${source})`);
    console.log(`Looking for user "${USER}", PC "${HOST}"${HOME ? `, home ${HOME}` : ''}${TERMS.length ? `, terms: ${TERMS.join(', ')}` : ''}`);
    if (HOST_IS_AUTHOR) console.log(`The PC name "${HOST}" is also the author's name declared in NOTICE: not reported as a machine name.`);
    for (const sev of ['high', 'medium', 'low']) {
      const list = findings.filter((f) => f.severity === sev);
      if (!list.length) continue;
      console.log(`\n${sev.toUpperCase()} (${list.length})`);
      const shown = new Map();
      const hidden = new Map();
      for (const f of list) {
        const k = f.rule + '\0' + f.file;
        const n = (shown.get(k) || 0) + 1;
        shown.set(k, n);
        if (MAX_PER && n > MAX_PER) { hidden.set(k, (hidden.get(k) || 0) + 1); continue; }
        const loc = f.line ? `${f.file}:${f.line}` : f.file;
        console.log(`  ${f.rule.padEnd(13)} ${loc}${f.where ? ` (${f.where})` : ''}  ${f.text}`);
        if (MAX_PER && n === MAX_PER) {
          const more = list.filter((g) => g.rule === f.rule && g.file === f.file).length - MAX_PER;
          if (more > 0) console.log(`  ${''.padEnd(13)} … ${more} more ${f.rule} in ${f.file}`);
        }
      }
    }
    const byRule = {};
    for (const f of findings) byRule[f.severity + ' ' + f.rule] = (byRule[f.severity + ' ' + f.rule] || 0) + 1;
    const byFile = {};
    for (const f of findings) if (f.severity !== 'low') byFile[f.file] = (byFile[f.file] || 0) + 1;
    console.log(`\nSummary: high ${count('high')} · medium ${count('medium')} · low ${count('low')}`);
    console.log('By rule: ' + Object.entries(byRule).map(([k, v]) => `${k} ${v}`).join(' · '));
    const top = Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 15);
    if (top.length) console.log('Files with the most high/medium findings: ' + top.map(([k, v]) => `${k} (${v})`).join(', '));
    if (!findings.length) console.log('Nothing found.');
  }
  return STRICT && findings.some((f) => f.severity === 'high') ? 1 : 0;
}

process.exitCode = main();
