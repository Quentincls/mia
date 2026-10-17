'use strict';
/**
 * Mia — its version (SPEC §21.1): { version, date, commit }.
 *
 *   version  package.json, in SemVer (the same as app.getVersion())
 *   date     the date of that version in CHANGELOG.md — heading « ## 0.5.0 — 17/10/2026 » — as ISO
 *            « 2026-10-17 », or null when the changelog does not list it
 *   commit   the commit of a working copy (.git read directly: no git needed on the user's PC), else the
 *            `commit` of a build-info.json put beside package.json at packaging time, else null
 *
 * Read once, synchronously, without any child process: safe to require from anywhere in the main process,
 * and from plain Node (tests, tools).
 *
 * Also: notes(version) → the CHANGELOG section of a version (markdown text) and sections() → all of them,
 * newest first — the same parsing as the « Nouveautés » dialog of the interface (src/js/ui/settings.js).
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const readText = (file) => {
  try { return fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch { return null; }
};
const readJSON = (file) => {
  const t = readText(file);
  if (t === null) return null;
  try { return JSON.parse(t); } catch { return null; }
};

// « ## 0.5.0 — 17/10/2026 », « ## [0.5.0] - 17/10/2026 », « ## 0.5.0 — 2026-10-17 »
const HEADING = /^##\s+\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?\s*(?:[—–-]\s*(\d{1,2})\/(\d{1,2})\/(\d{4})|[—–-]\s*(\d{4})-(\d{2})-(\d{2}))?/;

/** Every section of a changelog, newest first as written: [{ version, date (ISO|null), body }]. */
function parseChangelog(md) {
  const out = [];
  let cur = null;
  for (const line of String(md || '').split(/\r?\n/)) {
    const m = HEADING.exec(line);
    if (m) {
      const iso = m[4] ? `${m[4]}-${m[3].padStart(2, '0')}-${m[2].padStart(2, '0')}`
        : m[5] ? `${m[5]}-${m[6]}-${m[7]}` : null;
      cur = { version: m[1], date: iso, lines: [] };
      out.push(cur);
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  return out.map((s) => ({ version: s.version, date: s.date, body: s.lines.join('\n').trim() }));
}

/** The commit of the working copy, from .git (HEAD → ref → loose file or packed-refs), or null. */
function gitCommit(root) {
  try {
    let gitDir = path.join(root, '.git');
    const st = fs.statSync(gitDir);
    if (st.isFile()) {                       // a worktree: « gitdir: <path> »
      const m = /^gitdir:\s*(.+)$/m.exec(readText(gitDir) || '');
      if (!m) return null;
      gitDir = path.resolve(root, m[1].trim());
    }
    const head = (readText(path.join(gitDir, 'HEAD')) || '').trim();
    if (/^[0-9a-f]{40}$/i.test(head)) return head.toLowerCase();
    const ref = /^ref:\s*(\S+)$/.exec(head);
    if (!ref) return null;
    const loose = (readText(path.join(gitDir, ...ref[1].split('/'))) || '').trim();
    if (/^[0-9a-f]{40}$/i.test(loose)) return loose.toLowerCase();
    for (const line of (readText(path.join(gitDir, 'packed-refs')) || '').split(/\r?\n/)) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref[1] && /^[0-9a-f]{40}$/i.test(sha)) return sha.toLowerCase();
    }
  } catch { /* no .git: a package, or a copy */ }
  return null;
}

let cached = null;

/** { version, date, commit } of this copy of Mia (computed once). */
function info() {
  if (cached) return Object.assign({}, cached);
  const pkg = readJSON(path.join(ROOT, 'package.json')) || {};
  const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  const section = parseChangelog(readText(path.join(ROOT, 'CHANGELOG.md'))).find((s) => s.version === version);
  const build = readJSON(path.join(ROOT, 'build-info.json'));
  const commit = gitCommit(ROOT) || (build && typeof build.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(build.commit) ? build.commit : null);
  cached = { version, date: section ? section.date : null, commit };
  return Object.assign({}, cached);
}

/** All the changelog sections, newest first: [{ version, date, body }]. */
function sections() {
  return parseChangelog(readText(path.join(ROOT, 'CHANGELOG.md')));
}

/** The markdown body of one version's section (default: this one), or null. */
function notes(version) {
  const v = version || info().version;
  const s = sections().find((x) => x.version === v);
  return s ? s.body : null;
}

/** SemVer order of two « x.y.z » strings (a pre-release sorts before its release): -1, 0, 1. */
function compare(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(v || '').trim());
    return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] || null } : { n: [0, 0, 0], pre: null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

module.exports = { info, notes, sections, compare, parseChangelog, gitCommit };

// node electron/version.js → prints the version of this copy (handy in scripts and in the docs)
if (require.main === module) process.stdout.write(JSON.stringify(info()) + '\n');
