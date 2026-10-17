/**
 * Français (default) / English — SPEC §6.3.
 *
 * `t()` reads the current language at call time, so every label has to be
 * fetched when it is rendered, never frozen into a module-level constant —
 * otherwise a switch would leave half the interface in the old language.
 * Anything missing from the English table falls back to the French, so a gap
 * shows the original wording rather than a raw key.
 *
 * Every module registers its own strings at load time with `register()`;
 * prefixes: app. home. tabs. set. (shell), lib. model. (models), graph. pal.
 * dock. (board), node. run. queue. viewer. (blocks).
 *
 * Plurals go through `tn()` and Intl.PluralRules (`key.one` / `key.other`,
 * plus `key.zero` when a "none" sentence reads better) — Slate's `{s}` trick
 * wrote « 3 tableaus ».
 */
import { emit, emitAsync } from './bus.js';
import { state } from './state.js';

const TABLES = { fr: {}, en: {} };
let current = 'fr';
let plural = new Intl.PluralRules('fr-FR');
let numbers = new Intl.NumberFormat('fr-FR');

/** Add strings. Later registrations win, so a module can override a default. */
export function register(tables) {
  if (!tables) return;
  for (const l of Object.keys(TABLES)) {
    if (tables[l]) Object.assign(TABLES[l], tables[l]);
  }
}

/** The language the interface is in right now: 'fr' | 'en'. */
export const lang = () => current;

/** BCP 47 locale for Intl formatting. */
export const locale = () => (current === 'en' ? 'en-GB' : 'fr-FR');

/** Is there a string for this key (in any language)? */
export const has = (key) => key in TABLES[current] || key in TABLES.fr;

/**
 * Boot only: pick the language before anything is drawn. Switching later
 * goes through `setLang`, which rebuilds the window.
 */
export function initLang(l) {
  current = TABLES[l] ? l : 'fr';
  plural = new Intl.PluralRules(locale());
  numbers = new Intl.NumberFormat(locale());
  document.documentElement.lang = current;
  return current;
}

function lookup(key) {
  const s = TABLES[current][key];
  if (s !== undefined) return s;
  return TABLES.fr[key];
}

function fill(s, vars) {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (whole, name) => (vars[name] === undefined || vars[name] === null ? whole : String(vars[name])));
}

/** Translate `key`, replacing `{name}` by `vars.name`. Unknown key → the key itself. */
export function t(key, vars) {
  const s = lookup(key);
  if (s === undefined) {
    warnMissing(key);
    return key;
  }
  return fill(s, vars);
}

/**
 * Plural-aware: `tn('home.count', 3)` reads `home.count.other` → « 3 projets ».
 * `{n}` is the number, formatted for the language (« 1 234 »).
 */
export function tn(key, n, vars) {
  const num = Number(n) || 0;
  const all = { n: numbers.format(num), ...(vars || {}) };
  if (num === 0 && lookup(key + '.zero') !== undefined) return fill(lookup(key + '.zero'), all);
  const cat = plural.select(num);          // fr: one | many | other ; en: one | other
  const s = lookup(key + '.' + cat) ?? lookup(key + '.other') ?? lookup(key);
  if (s === undefined) {
    warnMissing(key + '.other');
    return key;
  }
  return fill(s, all);
}

/** A `{fr, en}` label from the catalog or the inventory. Strings pass through. */
export function tl(obj) {
  if (obj == null) return '';
  if (typeof obj === 'string') return obj;
  return obj[current] ?? obj.fr ?? obj.en ?? '';
}

/**
 * Switching rebuilds the window rather than hunting down every label already
 * on screen: half of the interface is built once, and a partial refresh is
 * exactly the kind of thing that leaves a stray word behind. The board is
 * saved first (app.js answers `app:flush`), so nothing is lost.
 */
export async function setLang(l) {
  const next = TABLES[l] ? l : 'fr';
  if (next === current) return;
  try { await window.mia?.prefs?.set({ lang: next }); } catch (err) { console.error('[i18n] prefs', err); }
  await emitAsync('app:flush', { reason: 'lang' });
  emit('project:closing', { id: state.project?.id ?? null, reload: true });
  try {
    if (window.mia?.app?.reload) await window.mia.app.reload();
    else location.reload();
  } catch {
    location.reload();
  }
}

/**
 * The pieces written straight into HTML: `data-i18n` (text),
 * `data-i18n-placeholder`, `data-i18n-tip` (our tooltip, never `title=`).
 */
export function applyStaticText(root = document) {
  const scope = root || document;
  const all = (sel) => {
    const list = [...scope.querySelectorAll(sel)];
    if (scope.matches?.(sel)) list.unshift(scope);
    return list;
  };
  for (const n of all('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  for (const n of all('[data-i18n-placeholder]')) n.placeholder = t(n.dataset.i18nPlaceholder);
  for (const n of all('[data-i18n-tip]')) {
    const s = t(n.dataset.i18nTip);
    n.dataset.tip = s;
    // icon-only buttons still need a name for screen readers
    if (!n.textContent.trim()) n.setAttribute('aria-label', s);
  }
}

const missing = new Set();
function warnMissing(key) {
  if (missing.has(key)) return;
  missing.add(key);
  console.warn(`[i18n] clé absente : ${key}`);
}

// ── strings shared by the whole shell ─────────────────────────────────
register({
  fr: {
    'app.name': 'Mia',
    'app.ok': 'OK',
    'app.cancel': 'Annuler',
    'app.close': 'Fermer',
    'app.confirm': 'Confirmer',
    'app.delete': 'Supprimer',
    'app.rename': 'Renommer',
    'app.retry': 'Réessayer',
    'app.undo': 'Annuler',
    'app.error': 'Erreur',
    'app.untitled': 'Sans titre',

    'app.time.now': 'à l’instant',
    'app.time.min': 'il y a {n} min',
    'app.time.hour': 'il y a {n} h',
    'app.time.yesterday': 'hier',
    'app.time.days.one': 'il y a {n} jour',
    'app.time.days.other': 'il y a {n} jours',
    'app.time.future': 'dans un instant',

    'app.unit.b': 'o',
    'app.unit.kb': 'Ko',
    'app.unit.mb': 'Mo',
    'app.unit.gb': 'Go',
    'app.unit.tb': 'To',

    'app.key.ctrl': 'Ctrl',
    'app.key.shift': 'Maj',
    'app.key.alt': 'Alt',
    'app.key.enter': 'Entrée',
    'app.key.esc': 'Échap',
    'app.key.del': 'Suppr',
    'app.key.space': 'Espace',
    'app.key.tab': 'Tab'
  },
  en: {
    'app.name': 'Mia',
    'app.ok': 'OK',
    'app.cancel': 'Cancel',
    'app.close': 'Close',
    'app.confirm': 'Confirm',
    'app.delete': 'Delete',
    'app.rename': 'Rename',
    'app.retry': 'Try again',
    'app.undo': 'Undo',
    'app.error': 'Error',
    'app.untitled': 'Untitled',

    'app.time.now': 'just now',
    'app.time.min': '{n} min ago',
    'app.time.hour': '{n} h ago',
    'app.time.yesterday': 'yesterday',
    'app.time.days.one': '{n} day ago',
    'app.time.days.other': '{n} days ago',
    'app.time.future': 'in a moment',

    'app.unit.b': 'B',
    'app.unit.kb': 'KB',
    'app.unit.mb': 'MB',
    'app.unit.gb': 'GB',
    'app.unit.tb': 'TB',

    'app.key.ctrl': 'Ctrl',
    'app.key.shift': 'Shift',
    'app.key.alt': 'Alt',
    'app.key.enter': 'Enter',
    'app.key.esc': 'Esc',
    'app.key.del': 'Del',
    'app.key.space': 'Space',
    'app.key.tab': 'Tab'
  }
});

export default { t, tn, tl, register, lang, setLang, initLang, applyStaticText, locale, has };
