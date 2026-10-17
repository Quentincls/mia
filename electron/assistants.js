'use strict';
/**
 * Mia — which assistants already know Mia (Réglages → Assistants).
 *
 *   registration() → { claude: bool, codex: bool }
 *
 *   claude   ~/.claude.json declares a server named « mia »: at the root (`mcpServers.mia`, scope user) or in one
 *            of its projects (`projects[<dir>].mcpServers.mia`, scope local)
 *   codex    ~/.codex/config.toml has a `[mcp_servers.mia]` table (or `mcp_servers.mia.…` keys)
 *
 * Read only: Mia never writes these files (the user adds Mia with the command Réglages shows). Each file is read
 * again only when its size or date changes (~/.claude.json can be large), never throws.
 *
 * Meant for bridge:status (statusForUi → `registered`), which Réglages polls every 4 s.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cache = new Map();   // file → { stamp, value }

function stamped(file, read) {
  let st;
  try { st = fs.statSync(file); } catch { cache.delete(file); return false; }
  const stamp = `${st.size}:${st.mtimeMs}`;
  const hit = cache.get(file);
  if (hit && hit.stamp === stamp) return hit.value;
  let value = false;
  try { value = !!read(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { value = false; }
  cache.set(file, { stamp, value });
  return value;
}

const hasMia = (servers) => !!(servers && typeof servers === 'object' && !Array.isArray(servers) && servers.mia);

/** ~/.claude.json text → does it declare « mia »? */
function claudeHasMia(text) {
  const j = JSON.parse(text);
  if (!j || typeof j !== 'object') return false;
  if (hasMia(j.mcpServers)) return true;
  const projects = j.projects && typeof j.projects === 'object' ? Object.values(j.projects) : [];
  return projects.some((p) => p && typeof p === 'object' && hasMia(p.mcpServers));
}

/** ~/.codex/config.toml text → does it declare « mia »? (no TOML parser: the table header or a dotted key) */
function codexHasMia(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim());
  return lines.some((l) => /^\[\s*mcp_servers\s*\.\s*(?:mia|"mia"|'mia')\s*(?:\.[^\]]*)?\]$/.test(l))
    || lines.some((l) => /^mcp_servers\s*\.\s*(?:mia|"mia"|'mia')\s*[.=]/.test(l));
}

function registration(home = os.homedir()) {
  const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
  return {
    claude: stamped(path.join(home, '.claude.json'), claudeHasMia),
    codex: stamped(path.join(codexHome, 'config.toml'), codexHasMia)
  };
}

module.exports = { registration, claudeHasMia, codexHasMia };

// node electron/assistants.js → { claude, codex } for this user
if (require.main === module) process.stdout.write(JSON.stringify(registration()) + '\n');
