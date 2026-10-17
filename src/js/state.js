/**
 * Shared, read-mostly state of the window (SPEC §6.3).
 *
 * One plain object, written by app.js (and settings.js for prefs) and read by
 * everyone. Changes are announced on the bus (`prefs:changed`,
 * `project:opened`, `engine:status`, `models:updated`), never by watching
 * this object.
 */

/** The defaults of prefs.json (SPEC §3.4); the main process owns the file. */
export const DEFAULT_PREFS = Object.freeze({
  lang: 'fr',
  theme: 'dark',
  projectsRoot: '',
  engineRoot: 'D:\\AI_Local_Videos',
  comfyUrl: 'http://127.0.0.1:8188',
  extraModelRoots: [],
  loraFolders: [],
  order: 'updated',
  openTabs: [],
  activeTab: null,
  snap: false,
  minimap: false,
  wires: 'sober',
  winBounds: null
});

export const state = {
  /** full prefs, as last returned by the main process */
  prefs: { ...DEFAULT_PREFS },
  /** the project on the board: { id, name, dir } — null on the home page */
  project: null,
  /** the project is open read-only (its graph.json could not be read) */
  readOnly: false,
  /** 'home' | 'board' */
  view: 'home',
  /** model inventory (SPEC §7), null until the first list arrives */
  inventory: null,
  /** engine status (SPEC §8.6), null until known */
  engine: null,
  /** app info (version, dataDir…) */
  info: null
};

/**
 * URL of a file inside a project: `mia://p/<projectId>/<rel>`.
 * `rel` is relative to the project folder with `/` separators; each segment is
 * encoded so names with spaces, `#` or `?` survive the trip.
 */
export function mediaUrl(rel, projectId = state.project?.id) {
  if (!rel || !projectId) return '';
  if (/^(mia|data|blob|https?):/i.test(rel)) return rel;   // already a URL
  const clean = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  const path = clean.split('/').map(encodeURIComponent).join('/');
  return `mia://p/${encodeURIComponent(projectId)}/${path}`;
}

/**
 * URL of a file outside any project (model previews, ComfyUI outputs):
 * `mia://m/<base64url of the absolute path, UTF-8>`. The main process only
 * serves it under projectsRoot, engineRoot or %APPDATA%\Mia.
 */
export function absUrl(abs) {
  if (!abs) return '';
  const bytes = new TextEncoder().encode(String(abs));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `mia://m/${b64}`;
}

export default state;
