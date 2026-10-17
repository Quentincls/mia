'use strict';
/**
 * Mia — where things live by default, in ONE place (SPEC §21.3).
 *
 * The engine folder is never a default: a fresh Mia has `prefs.engineRoot = ''` and the first-launch check
 * (installer.engineCheck, welcome.js) adopts an engine it finds or offers to install one. The only engine Mia
 * may *discover* on its own is the author's lab (LAB_ROOT), and only when it really is there: on any other
 * PC labRoot() is null, so nothing of the lab leaks into someone else's Mia.
 *
 *   labRoot()               → the lab folder when it holds an engine (env\venv\Scripts\python.exe), else null
 *   engineRoot(prefs)       → prefs.engineRoot, else labRoot(), else '' (no engine on this PC)
 *   noEngine(lang)          → the sentence to show when a job needs the engine and there is none
 *   dataDrive()             → 'D:\\' when D: looks like a big fixed data disk (> 100 GB free), else null
 *   defaultProjectsRoot(documents) / suggestEngineDir()   → D:\Mia\Projets | Documents\Mia Projets, D:\Mia-moteur | ~\Mia-moteur
 *   systemLang(app)         → 'fr' when the system prefers French, else 'en' (first launch only)
 *
 * Test switches: MIA_NO_LAB=1 (or MIA_ENGINE_FALLBACK=none) hides the lab everywhere, to play someone else's PC;
 * MIA_DATA_DRIVE=<X:\|none> forces the data disk; MIA_LANG=fr|en forces the first-launch language.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LAB_ROOT = 'D:\\AI_Local_Videos';
const MIN_FREE = 100 * 1024 ** 3;          // a USB stick, an SD card or a disc never has that much room left

const labDisabled = () => process.env.MIA_NO_LAB === '1' || process.env.MIA_ENGINE_FALLBACK === 'none';

let labMemo = { at: 0, v: null };
/** The author's lab, when it is there (checked at most every 5 s). */
function labRoot() {
  if (labDisabled()) return null;
  const now = Date.now();
  if (now - labMemo.at < 5000) return labMemo.v;
  let v = null;
  try { if (fs.existsSync(path.join(LAB_ROOT, 'env', 'venv', 'Scripts', 'python.exe'))) v = LAB_ROOT; } catch { v = null; }
  labMemo = { at: now, v };
  return v;
}

/** The engine folder to use: the one chosen in the settings, else the lab when present, else '' (none). */
function engineRoot(prefs) {
  const p = prefs && typeof prefs.engineRoot === 'string' ? prefs.engineRoot.trim() : '';
  return p || labRoot() || '';
}

const NO_ENGINE = {
  fr: 'Aucun moteur n’est configuré sur ce PC : ouvre Modèles › Configurer le moteur… (ou Réglages › Dossier du moteur).',
  en: 'No engine is set up on this PC: open Models › Set up the engine… (or Settings › Engine folder).'
};
const noEngine = (lang) => NO_ENGINE[lang === 'en' ? 'en' : 'fr'];

let driveMemo = null;
/** D: when it is a big fixed disk with room (the usual data disk of a workstation), else null. */
function dataDrive() {
  const forced = process.env.MIA_DATA_DRIVE;
  if (forced) return forced === 'none' ? null : forced;
  if (driveMemo !== null) return driveMemo || null;
  let v = '';
  try {
    if (process.platform === 'win32' && fs.existsSync('D:\\') && typeof fs.statfsSync === 'function') {
      const s = fs.statfsSync('D:\\');
      if (Number(s.bavail) * Number(s.bsize) > MIN_FREE) v = 'D:\\';
    }
  } catch { v = ''; }      // no disc in the drive, locked volume…
  driveMemo = v;
  return v || null;
}

// Folder names follow the language of the first launch (lang): « Projets », « Mia-moteur » in French,
// « Projects », « Mia-engine » in English. A French-named folder that already exists is kept: a folder Mia
// already made never changes name.
const keepOr = (fr, en, lang) => (lang !== 'en' || fs.existsSync(fr) ? fr : en);

function defaultProjectsRoot(documents, lang) {
  const d = dataDrive();
  const docs = documents || path.join(os.homedir(), 'Documents');
  if (d) return keepOr(path.join(d, 'Mia', 'Projets'), path.join(d, 'Mia', 'Projects'), lang);
  return keepOr(path.join(docs, 'Mia Projets'), path.join(docs, 'Mia Projects'), lang);
}

/** Default folder for a fresh engine (also the default of engine-setup\install-engine.ps1, which follows -Lang). */
function suggestEngineDir(lang) {
  const base = dataDrive() || os.homedir();
  return keepOr(path.join(base, 'Mia-moteur'), path.join(base, 'Mia-engine'), lang);
}

/** First-launch language: French when the system prefers French, English otherwise. */
function systemLang(app) {
  let tag = '';
  try {
    const list = app && typeof app.getPreferredSystemLanguages === 'function' ? app.getPreferredSystemLanguages() : [];
    tag = (Array.isArray(list) && list[0]) || (app && typeof app.getLocale === 'function' ? app.getLocale() : '') || '';
  } catch { tag = ''; }
  if (process.env.MIA_LANG === 'fr' || process.env.MIA_LANG === 'en') return process.env.MIA_LANG;
  return /^fr\b|^fr[-_]/i.test(String(tag)) ? 'fr' : 'en';
}

module.exports = { LAB_ROOT, labDisabled, labRoot, engineRoot, noEngine, dataDrive, defaultProjectsRoot, suggestEngineDir, systemLang };
