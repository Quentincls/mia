'use strict';
/**
 * Mia — main process.
 *
 * Lifecycle, the frameless window (Slate's chrome: nothing of Windows shows), the mia:// protocol,
 * the IPC of win / app / prefs / projects / media / shell (SPEC §5), then the model scanner and the
 * engine and the assistant bridge, which plug themselves in through register(ctx) (SPEC §8.1, §13).
 * Any of those may fail to load: it is logged and Mia still opens, with its channels answering a
 * readable error.
 *
 * Flags and test switches:
 *   --dev                 DevTools (detached), renderer console copied to the log, F12 toggles DevTools
 *   MIA_USERDATA=<dir>    data folder instead of %APPDATA%\Mia (tests: never touch real data)
 *   MIA_PROJECTS_ROOT=<d> projects folder for this run only (not saved in the prefs)
 *   MIA_HEADLESS=1        the window is never shown (tests)
 *   MIA_SKIP_MODULES=a,b  do not load these modules (scanner, engine, bridge) — tests of the shell alone
 */
const { app, BrowserWindow, ipcMain, protocol, Menu, nativeTheme, screen, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');

// ---------------------------------------------------------------- GPU tuning (Slate's switches)
// One single 'enable-features': a second call would replace the first, not add to it.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-features', 'CanvasOopRasterization');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const DEV = process.argv.includes('--dev');
const HEADLESS = process.env.MIA_HEADLESS === '1';
const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'src', 'index.html');
const PRELOAD = path.join(__dirname, 'preload.js');
const APP_ICON = path.join(ROOT, 'src', 'assets', 'mia-app.ico');

// Pinned name and data folder: %APPDATA%\Mia, its own single-instance lock, apart from Slate's.
// No AppUserModelID on purpose (Slate's lesson): the shortcut launches this very electron.exe and
// Windows pairs the pinned taskbar button with the window by path; an explicit ID made two buttons.
app.setName('Mia');
app.setPath('userData', process.env.MIA_USERDATA ? path.resolve(process.env.MIA_USERDATA) : path.join(app.getPath('appData'), 'Mia'));
const USER_DATA = app.getPath('userData');
const DATA_DIR = path.join(USER_DATA, 'data');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

// Required after setPath: these modules read nothing at load time, but keep the order obvious.
const store = require('./store');
const places = require('./places');
const ffmpeg = require('./ffmpeg');
const { createMedia } = require('./media');
const { createShellOps } = require('./shellops');

// No application menu at all: no Alt menu bar, and none of its hidden accelerators (Ctrl+R reload,
// Ctrl+± page zoom, Ctrl+Shift+I…) — those exist only through the default menu's roles, so the
// keys reach the page untouched and the board can use them.
try { Menu.setApplicationMenu(null); } catch { /* set again once ready (boot) */ }

protocol.registerSchemesAsPrivileged([{
  scheme: 'mia',
  // corsEnabled + Access-Control-Allow-Origin: a video drawn into a canvas/WebGL never gets "tainted"
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true }
}]);

const STR = {
  unexpected: { fr: 'Une erreur inattendue est survenue : {msg}', en: 'An unexpected error occurred: {msg}' },
  moduleDown: {
    fr: 'Cette partie de Mia n’a pas pu démarrer ({name}). Le détail est dans le journal.',
    en: 'This part of Mia could not start ({name}). Details are in the log.'
  },
  fatal: {
    fr: 'Mia n’a pas pu démarrer : {msg}',
    en: 'Mia could not start: {msg}'
  },
  noUi: {
    fr: 'L’interface de Mia est introuvable (src\\index.html).',
    en: 'Mia’s interface cannot be found (src\\index.html).'
  },
  close: { fr: 'Fermer', en: 'Close' }
};

// ---------------------------------------------------------------- log
// A launch from Mia.vbs has no console: everything also goes to data\logs\main.log.
const LOG_FILE = path.join(LOGS_DIR, 'main.log');
try {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const st = fs.statSync(LOG_FILE, { throwIfNoEntry: false });
  if (st && st.size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, path.join(LOGS_DIR, 'main.1.log'));
} catch { /* logging must never stop the app */ }

function fmt(v) {
  if (v instanceof Error) return v.stack || v.message;
  if (typeof v === 'object' && v !== null) {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}
function log(...args) {
  const line = `${new Date().toISOString()} ${args.map(fmt).join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* disk full: the console still has it */ }
}
const logger = (scope) => (...args) => log(`[${scope}]`, ...args);

process.on('uncaughtException', (e) => log('[uncaught]', e));
process.on('unhandledRejection', (e) => log('[unhandled rejection]', e));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tr = (obj, vars) => store.tr(obj, vars);

// ---------------------------------------------------------------- single instance
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win = null;
let rendererReady = false;   // index.html loaded: it can answer app:flush
let media = null;
let shellops = null;

app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

function send(channel, payload) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------- mia:// protocol
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.flac': 'audio/flac', '.aac': 'audio/aac', '.opus': 'audio/ogg',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  // Chromium cannot show these: served raw (a preview PNG is made at import)
  '.exr': 'application/octet-stream', '.tif': 'application/octet-stream', '.tiff': 'application/octet-stream',
  '.psd': 'application/octet-stream'
};

const plain = (status, text) => new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' } });

/**
 * Serve a file with Range support (Slate's serveFile): without a hand-made 206 + Content-Range,
 * Chromium considers the video unseekable — net.fetch(file://) breaks scrubbing (tech.md §9).
 */
async function serveFile(abs, request) {
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    return plain(404, 'not found');
  }
  if (!st.isFile()) return plain(404, 'not found');
  const base = {
    'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Last-Modified': st.mtime.toUTCString(),
    'Access-Control-Allow-Origin': '*'
  };
  const head = request.method === 'HEAD';
  const stream = (start, end) => (head ? null : Readable.toWeb(fs.createReadStream(abs, { start, end, highWaterMark: 1 << 20 })));
  const m = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
  if (!m || (!m[1] && !m[2])) {
    if (st.size === 0) return new Response(head ? null : '', { status: 200, headers: { ...base, 'Content-Length': '0' } });
    return new Response(stream(0, st.size - 1), { status: 200, headers: { ...base, 'Content-Length': String(st.size) } });
  }
  let start = m[1] ? parseInt(m[1], 10) : 0;
  let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
  if (!m[1] && m[2]) { start = Math.max(0, st.size - parseInt(m[2], 10)); end = st.size - 1; }   // "bytes=-N": the last N
  end = Math.min(end, st.size - 1);
  if (start > end || start >= st.size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}`, 'Access-Control-Allow-Origin': '*' } });
  }
  return new Response(stream(start, end), {
    status: 206,
    headers: { ...base, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${st.size}` }
  });
}

function decodeSegment(s) {
  try { return decodeURIComponent(s); } catch { return null; }
}

/**
 * mia://p/<projectId>/<rel>  a file of a project (thumb.png, media/…, cache/…, outputs/…)
 * mia://m/<b64url(abs)>      a file outside projects, only under projectsRoot, engineRoot,
 *                            %APPDATA%\Mia or an extra model root (model previews, ComfyUI outputs)
 */
async function handleProtocol(request) {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') return plain(405, 'method not allowed');
    const u = new URL(request.url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (u.hostname === 'p' && parts.length >= 2) {
      await store.ready();
      const dir = store.projectDir(decodeSegment(parts[0]));
      if (!dir) return plain(404, 'unknown project');
      const rel = parts.slice(1).map(decodeSegment);
      if (rel.some((s) => s === null)) return plain(400, 'bad path');
      const abs = path.resolve(dir, ...rel);
      if (!store.isInside(abs, dir)) return plain(403, 'forbidden');
      return serveFile(abs, request);
    }
    if (u.hostname === 'm' && parts.length >= 1) {
      const enc = parts.join('/');          // tolerate a standard base64 "/" in the payload
      let abs = '';
      try { abs = Buffer.from(decodeSegment(enc) || '', 'base64url').toString('utf8'); } catch { abs = ''; }
      if (!abs || !path.isAbsolute(abs) || abs.includes('\0')) return plain(400, 'bad path');
      abs = path.resolve(abs);
      if (!store.allowedRoots().some((root) => store.isInside(abs, root))) return plain(403, 'forbidden');
      return serveFile(abs, request);
    }
  } catch (e) {
    log('[protocol]', request.url, e);
    return plain(500, 'error');
  }
  return plain(404, 'not found');
}

// ---------------------------------------------------------------- window
const BG = { dark: '#070709', light: '#f6f6f7' };   // = --bg of the theme: no white flash at launch
const MIN_W = 900;
const MIN_H = 600;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Last bounds, if the screen they were on is still there (an external monitor may be unplugged). */
function restoreBounds(saved) {
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1480, area.width - 40);
  const height = Math.min(920, area.height - 40);
  const def = {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width: Math.max(MIN_W, width),
    height: Math.max(MIN_H, height),
    maximized: false
  };
  const s = saved && typeof saved === 'object' ? saved : null;
  if (!s || ![s.x, s.y, s.width, s.height].every(Number.isFinite)) return def;
  const visible = screen.getAllDisplays().some((d) => overlap(d.workArea, s) >= 200 * 120);
  if (!visible) return Object.assign(def, { maximized: !!s.maximized });
  const wa = screen.getDisplayMatching(s).workArea;
  return {
    x: Math.round(s.x),
    y: Math.round(s.y),
    width: Math.round(clamp(s.width, MIN_W, Math.max(MIN_W, wa.width))),
    height: Math.round(clamp(s.height, MIN_H, Math.max(MIN_H, wa.height))),
    maximized: !!s.maximized
  };
}

let boundsTimer = null;
function saveBoundsNow() {
  clearTimeout(boundsTimer);
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return Promise.resolve();
  const b = win.getNormalBounds();
  return store.setPrefs({ winBounds: { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() } })
    .catch((e) => log('[window] bounds not saved:', e.message));
}
function saveBoundsSoon() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(saveBoundsNow, 700);
}

const winState = () => ({ maximized: win.isMaximized(), fullscreen: win.isFullScreen(), focused: win.isFocused() });

/** A page of our own, so a missing index.html is a message and not a blank black window. */
function fallbackPage(message) {
  const p = store.getPrefs();
  const dark = p.theme !== 'light';
  const html = `<!doctype html><meta charset="utf-8"><title>Mia</title>
<style>html,body{margin:0;height:100%;background:${dark ? '#070709' : '#f6f6f7'};color:${dark ? '#e8e8ea' : '#18181b'};
font:14px/1.5 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif}
body{display:grid;place-items:center;-webkit-app-region:drag;user-select:none}
div{max-width:520px;padding:24px;text-align:center}p{opacity:.72;margin:0 0 20px}
button{-webkit-app-region:no-drag;font:inherit;color:inherit;background:transparent;border:1px solid ${dark ? '#2a2a30' : '#d4d4d8'};
border-radius:8px;padding:6px 16px;cursor:pointer}button:hover{border-color:${dark ? '#4d82f3' : '#3b6fe0'}}</style>
<div><p>${message.replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]))}</p>
<button onclick="window.mia&&window.mia.win.close()">${tr(STR.close)}</button></div>`;
  return win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

/** (Re)load the interface with the current theme and language in the query, for the first paint. */
function loadIndex() {
  if (!win || win.isDestroyed()) return Promise.resolve();
  rendererReady = false;
  if (!fs.existsSync(INDEX_HTML)) {
    log('[window] src/index.html missing');
    return fallbackPage(tr(STR.noUi));
  }
  const p = store.getPrefs();
  return win.loadFile(INDEX_HTML, { query: { theme: p.theme, lang: p.lang } })
    .catch((e) => log('[window] load failed:', e.message));
}

const OWN_PAGE = pathToFileURL(INDEX_HTML).href.toLowerCase();
const isOwnPage = (url) => String(url || '').split(/[?#]/)[0].toLowerCase() === OWN_PAGE;

function createWindow() {
  const prefs = store.getPrefs();
  const theme = prefs.theme === 'light' ? 'light' : 'dark';
  nativeTheme.themeSource = theme;            // scrollbars and form controls follow the theme
  const b = restoreBounds(prefs.winBounds);

  win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    minWidth: MIN_W,
    minHeight: MIN_H,
    show: false,
    frame: false,
    thickFrame: true,                         // keeps Windows 11 resize edges, shadow, rounded corners, Snap
    backgroundColor: BG[theme],
    title: 'Mia',
    icon: fs.existsSync(APP_ICON) ? APP_ICON : undefined,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,                          // the bridge needs only ipcRenderer, contextBridge, webUtils
      backgroundThrottling: false,
      spellcheck: false,
      webviewTag: false
    }
  });
  win.setMenuBarVisibility(false);
  const wc = win.webContents;
  let closing = false;       // the close sequence has started (see the end of this function)
  let allowClose = false;    // the page has flushed: let the window go

  win.once('ready-to-show', () => {
    if (HEADLESS) return;
    if (b.maximized) win.maximize();          // maximize() on a hidden window would show it early
    win.show();
    if (DEV) wc.openDevTools({ mode: 'detach' });
  });

  // ---- zoom: the board zooms, the page never does
  wc.setVisualZoomLevelLimits(1, 1).catch(() => {});      // no pinch-zoom of the whole page
  wc.on('zoom-changed', () => wc.setZoomLevel(0));         // Ctrl+wheel never reaches Chromium's zoom
  wc.on('did-finish-load', () => {
    wc.setZoomFactor(1);                                   // a zoom remembered for file:// must not come back
    wc.setVisualZoomLevelLimits(1, 1).catch(() => {});
    rendererReady = isOwnPage(wc.getURL());
    send('win:state', winState());
  });

  wc.on('before-input-event', (e, input) => {
    if (!DEV || input.type !== 'keyDown') return;
    if (input.key === 'F12' || ((input.control || input.meta) && input.shift && /^i$/i.test(input.key))) {
      wc.toggleDevTools();
      e.preventDefault();
    }
  });

  // ---- nothing leaves the app: no navigation away (a file dropped outside a drop zone), no popups
  wc.on('will-navigate', (e, url) => {
    if (!isOwnPage(url)) {
      e.preventDefault();
      log('[window] navigation blocked:', url.slice(0, 200));
    }
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  if (DEV) {
    wc.on('console-message', (e) => {
      const level = ['debug', 'info', 'warning', 'error'][e.level] ?? e.level;
      log(`[renderer:${level}] ${e.message}  (${e.sourceId}:${e.lineNumber})`);
    });
  }

  let lastCrashReload = 0;
  wc.on('render-process-gone', (_e, details) => {
    log('[window] renderer gone:', details.reason, details.exitCode);
    if (details.reason === 'clean-exit' || closing) return;
    if (Date.now() - lastCrashReload < 10000) return;      // crashing again at once: do not loop
    lastCrashReload = Date.now();
    setTimeout(loadIndex, 500);
  });
  win.on('unresponsive', () => log('[window] unresponsive'));
  win.on('responsive', () => log('[window] responsive again'));

  // ---- the title bar is ours: Windows' system menu never shows
  // Right-click on a drag region: tell the page where, it shows Mia's menu (tech.md §5.1).
  win.on('system-context-menu', (e) => {
    e.preventDefault();
    const c = win.getContentBounds();
    const p = screen.getCursorScreenPoint();               // DIP, like the page (the event point may be physical)
    let x = p.x - c.x;
    let y = p.y - c.y;
    if (x < 0 || y < 0 || x > c.width || y > c.height) { x = 12; y = 12; }
    send('win:titlebarMenu', { x, y });
  });
  // Alt+Space opens the same system menu from the keyboard: cancel it as it opens
  // (WM_INITMENU; disabling the window for a moment closes Windows' menu loop).
  if (process.platform === 'win32') {
    try {
      win.hookWindowMessage(0x0116, () => {
        if (!win || win.isDestroyed()) return;
        win.setEnabled(false);
        setTimeout(() => {
          if (!win || win.isDestroyed()) return;
          win.setEnabled(true);
          win.focus();                        // disabling took the keyboard focus away: give it back
        }, 40);
      });
    } catch (e) {
      log('[window] WM_INITMENU hook unavailable:', e.message);
    }
  }

  // ---- state for the title bar buttons, and the bounds for next time
  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur', 'restore']) {
    win.on(ev, () => send('win:state', winState()));
  }
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, saveBoundsSoon);

  // ---- closing: the page saves first (app:flush → app:flushed, 2 s at most), then queued writes land.
  // app:flush carries { activeJobs }: with jobs running, the page may ask Quentin first — it answers
  // flushed({hold:true}) at once (the wait becomes HOLD_MS), then flushed({quit:true}) to quit or
  // flushed({cancel:true}) to keep Mia open. Without a hold, a bare flushed() means: saved, go.
  const HOLD_MS = 5 * 60 * 1000;
  const finishClose = async () => {
    await Promise.race([store.idle(), sleep(1500)]);
    allowClose = true;
    if (win && !win.isDestroyed()) win.destroy();
  };
  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    if (closing) return;
    closing = true;
    store.setClosing(true);                   // the last save always refreshes the home thumbnail
    saveBoundsNow();
    if (!rendererReady || wc.isDestroyed() || (wc.isCrashed && wc.isCrashed())) {
      finishClose();
      return;
    }
    let done = false;
    let held = false;
    let timer = null;
    const stop = () => {
      done = true;
      clearTimeout(timer);
      ipcMain.removeListener('app:flushed', onFlushed);
    };
    const finish = () => {
      if (done) return;
      stop();
      finishClose();
    };
    const onFlushed = (ev, answer) => {
      if (ev.sender !== wc || done) return;
      const a = answer && typeof answer === 'object' ? answer : {};
      if (a.cancel) {                          // Quentin chose to keep Mia open (a job is running)
        stop();
        closing = false;
        store.setClosing(false);
        log('[window] close cancelled from the page');
        return;
      }
      if (a.hold) {                            // the page is asking Quentin: wait for the answer
        held = true;
        clearTimeout(timer);
        timer = setTimeout(() => { log('[window] no answer to the close question: closing'); finish(); }, HOLD_MS);
        return;
      }
      // once on hold, only an explicit answer counts (a plain « saved » from another listener does not)
      if (held && !a.quit) return;
      finish();
    };
    timer = setTimeout(() => {
      log('[window] the page did not answer app:flush within 2 s');
      finish();
    }, 2000);
    ipcMain.on('app:flushed', onFlushed);
    wc.send('app:flush', { activeJobs: activeJobs() });
  });
  win.on('closed', () => { win = null; });

  loadIndex();
}

// ---------------------------------------------------------------- IPC
const handled = new Set();   // every invoke channel with a handler (for the --dev bridge check)
const stubbed = new Set();   // channels answered by a stand-in because their module did not load

/**
 * Register a handler of ours: a thrown readable error becomes { ok:false, error } (SPEC §5), an
 * unexpected one is logged with its stack and answered with a generic sentence.
 */
function handle(channel, fn) {
  handled.add(channel);
  ipcMain.handle(channel, async (e, ...args) => {
    try {
      return await fn(e, ...args);
    } catch (err) {
      if (err && err.userMessage) {
        log(`[ipc] ${channel}:`, err.userMessage, err.cause ? `(${err.cause.code || err.cause.message})` : '');
        return { ok: false, error: err.userMessage };
      }
      log(`[ipc] ${channel} failed:`, err);
      return { ok: false, error: tr(STR.unexpected, { msg: (err && err.message) || String(err) }) };
    }
  });
}

/** Accept both call styles: (id, name) as SPEC §5 says, or a single object ({ id, name }). */
const pick = (first, key) => (first && typeof first === 'object' && !Array.isArray(first) && key in first ? first[key] : undefined);

function registerIpc() {
  const w = () => (win && !win.isDestroyed() ? win : null);

  // ---- window
  handle('win:minimize', () => { w()?.minimize(); return true; });
  handle('win:toggleMaximize', () => {
    const x = w();
    if (!x) return false;
    if (x.isMaximized()) x.unmaximize();
    else x.maximize();
    return x.isMaximized();
  });
  handle('win:close', () => { w()?.close(); return true; });
  handle('win:isMaximized', () => !!w()?.isMaximized());
  handle('win:toggleFullscreen', () => {
    const x = w();
    if (!x) return false;
    x.setFullScreen(!x.isFullScreen());
    return x.isFullScreen();
  });
  // the system menu is always blocked (createWindow); the call only confirms it
  handle('win:titlebarMenuGuard', () => true);

  // ---- app
  handle('app:info', () => {
    const p = store.getPrefs();
    return {
      version: app.getVersion(),
      dev: DEV,
      dataDir: DATA_DIR,
      projectsRoot: p.projectsRoot,
      engineRoot: p.engineRoot,
      platform: process.platform,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      ffmpeg: ffmpeg.ffmpegPath()
    };
  });
  handle('app:reload', async () => { await loadIndex(); return true; });

  // ---- prefs (patches are merged by the store, never "the whole object")
  handle('prefs:get', () => store.getPrefs());
  handle('prefs:set', (_e, patch) => store.setPrefs(patch));

  // ---- projects
  handle('projects:list', () => store.list());
  // { root, rootMissing, code, message }: the home shows « folder not found » instead of « no project »
  handle('projects:status', () => store.status());
  handle('projects:create', (_e, payload) => store.create(payload));
  handle('projects:rename', (_e, id, name) => store.rename(pick(id, 'id') ?? id, pick(id, 'name') ?? name));
  handle('projects:duplicate', (_e, id) => store.duplicate(pick(id, 'id') ?? id));
  handle('projects:remove', (_e, id) => store.remove(pick(id, 'id') ?? id));
  handle('projects:reveal', (_e, id) => shellops.revealProject(pick(id, 'id') ?? id));
  handle('projects:open', async (_e, id) => {
    const pid = pick(id, 'id') ?? id;
    const r = await store.open(pid);
    if (r && r.ok !== false && r.graph) media.reconcileGraph(pid, r.dir, r.graph);
    return r;
  });
  handle('projects:save', (e, id, graph, opts) => {
    if (pick(id, 'graph')) return store.save(id.id, id.graph, id.opts, e.sender);
    return store.save(id, graph, opts, e.sender);
  });
  // only the home thumbnail, now: the page frames the board and hides its overlays first
  handle('projects:thumb', (e, id, opts) => {
    if (pick(id, 'id') && !opts) return store.thumb(id.id, id, e.sender);
    return store.thumb(id, opts, e.sender);
  });
  // (boardId, folderId|null) → the board's folder moves into that project (SPEC §18.2); refused
  // with a readable sentence while one of its jobs is queued or running
  handle('projects:move', (_e, id, folderId) => {
    if (pick(id, 'folderId') !== undefined) return store.move(id.id, id.folderId);
    return store.move(pick(id, 'id') ?? id, folderId ?? null);
  });

  // ---- projects = folders of boards (SPEC §18.2); every change also sends folders:changed
  handle('folders:list', () => store.folders.list());
  handle('folders:create', (_e, payload) => store.folders.create(payload));
  handle('folders:rename', (_e, id, name) => store.folders.rename(pick(id, 'id') ?? id, pick(id, 'name') ?? name));
  handle('folders:setColor', (_e, id, color) => store.folders.setColor(pick(id, 'id') ?? id, pick(id, 'color') ?? color));
  handle('folders:remove', (_e, id, opts) => {
    if (pick(id, 'id') !== undefined) return store.folders.remove(id.id, opts || id);
    return store.folders.remove(id, opts);
  });
  handle('folders:reveal', (_e, id) => shellops.revealFolder(pick(id, 'id') ?? id));

  // ---- media
  handle('media:importPaths', (_e, projectId, paths) =>
    media.importPaths(pick(projectId, 'projectId') ?? projectId, pick(projectId, 'paths') ?? paths));
  handle('media:importBuffer', (_e, projectId, name, bytes) => {
    if (pick(projectId, 'bytes')) return media.importBuffer(projectId.projectId, projectId.name, projectId.bytes);
    return media.importBuffer(projectId, name, bytes);
  });
  handle('media:pick', (_e, opts) => media.pick(opts));
  handle('media:pickFolder', (_e, opts) => media.pickFolder(opts));

  // ---- shell
  handle('shell:reveal', (_e, target) => shellops.reveal(target));
  handle('shell:openPath', (_e, target) => shellops.openPath(target));
  handle('shell:copyPath', (_e, target) => shellops.copyPath(target));
  ipcMain.on('shell:startDrag', (e, target) => { shellops.startDrag(e.sender, target).catch((err) => log('[shell] drag:', err)); });
}

// ---------------------------------------------------------------- modules of other parts
/**
 * ipcMain as handed to the scanner and the engine: identical, except that their handlers are
 * recorded (bridge check), their failures logged with a stack, and a stand-in registered for a
 * missing module is replaced when the real handler arrives.
 */
const ipcForModules = new Proxy(ipcMain, {
  get(target, prop) {
    if (prop === 'handle' || prop === 'handleOnce') {
      return (channel, fn) => {
        if (stubbed.has(channel)) {
          target.removeHandler(channel);
          stubbed.delete(channel);
        }
        handled.add(channel);
        return target[prop](channel, async (...args) => {
          try {
            return await fn(...args);
          } catch (err) {
            log(`[ipc] ${channel} failed:`, err);
            throw err;
          }
        });
      };
    }
    const v = Reflect.get(target, prop, target);
    return typeof v === 'function' ? v.bind(target) : v;
  }
});

let ctx = null;
const modules = new Map();   // module name → what its register(ctx) returned (the engine instance…)

const ENDED = new Set(['done', 'error', 'cancelled']);

/** The engine's queued or running jobs (its job map: jobId → job, finished ones excluded). */
function engineJobs() {
  const eng = modules.get('engine');
  if (!eng) return [];
  try {
    if (eng.jobs instanceof Map) return [...eng.jobs.values()].filter((j) => j && !ENDED.has(j.state));
  } catch { /* engine half-started */ }
  return [];
}
const activeJobs = () => engineJobs().length;

/** A job of this board is queued or running: its folder must not move nor go to the Recycle Bin. */
function projectBusy(id) {
  const eng = modules.get('engine');
  try {
    if (eng && typeof eng.projectBusy === 'function') return !!eng.projectBusy(id);
  } catch { /* fall back on the job list */ }
  try {
    if (eng && typeof eng.jobList === 'function') {
      const list = eng.jobList();
      if (Array.isArray(list)) return list.some((j) => j && j.projectId === id && !ENDED.has(j.state));
    }
  } catch { /* fall back on the job map */ }
  return engineJobs().some((j) => j.projectId === id);
}

/**
 * When a job ends, a project folder whose rename had to wait (a job of one of its boards was
 * running) may follow its name now. The engine may finish registering later: try for a few seconds.
 */
function watchEngineForStore(tries = 0) {
  const eng = modules.get('engine');
  if (eng && typeof eng.onEvent === 'function') {
    try {
      eng.onEvent((ev) => {
        if (ev && ENDED.has(ev.kind)) setTimeout(() => store.retryPending(), 300);
      });
    } catch (e) {
      log('[store] engine events unavailable:', e.message);
    }
    return;
  }
  if (tries < 20 && !moduleErrors.has('engine')) setTimeout(() => watchEngineForStore(tries + 1), 500);
}

/**
 * A PNG of the window (or of a rect of it, in page pixels), for the assistant bridge (SPEC §13:
 * mia_snapshot). `maxSide` shrinks big captures. Resolves null when nothing could be captured
 * (minimized or hidden window).
 */
async function captureRect(rect, o = {}) {
  const w = win && !win.isDestroyed() ? win : null;
  if (!w || w.webContents.isDestroyed()) return null;
  let r;
  if (rect && typeof rect === 'object') {
    const x = Number(rect.x);
    const y = Number(rect.y);
    const width = Number(rect.w ?? rect.width);
    const height = Number(rect.h ?? rect.height);
    if ([x, y, width, height].every(Number.isFinite) && width >= 1 && height >= 1) {
      r = { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), width: Math.round(width), height: Math.round(height) };
    }
  }
  let img = await w.webContents.capturePage(r);
  if (!img || img.isEmpty()) return null;
  const max = Number(o && o.maxSide) || 0;
  if (max > 0) {
    const { width, height } = img.getSize();
    const k = max / Math.max(width, height);
    if (k < 1) img = img.resize({ width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), quality: 'best' });
  }
  return img.toPNG();
}

/** Bring Mia to the front (the assistant bridge wakes it up for Quentin to watch). Never shows a test window. */
function focusWindow() {
  const w = win && !win.isDestroyed() ? win : null;
  if (!w) return false;
  if (w.isMinimized()) w.restore();
  if (!HEADLESS) {
    w.show();
    w.moveTop();
  }
  w.focus();
  return true;
}

/** The context of SPEC §8.1, built once; scanner.register fills ctx.models before the engine reads it. */
function buildCtx() {
  ctx = {
    app,
    ipcMain: ipcForModules,
    getWin: () => (win && !win.isDestroyed() ? win : null),
    send,
    captureRect,
    focusWindow,
    headless: HEADLESS,
    get engine() { return modules.get('engine') || null; },
    media,
    shell: shellops,
    paths: {
      root: ROOT,
      data: DATA_DIR,
      logs: LOGS_DIR,
      userData: USER_DATA,
      python: path.join(ROOT, 'python'),   // Mia's Python scripts (mia_worker.py…)
      get pythonExe() { const r = places.engineRoot(store.getPrefs()); return r ? path.join(r, 'env', 'venv', 'Scripts', 'python.exe') : null; }
    },
    prefs: { get: store.getPrefs, set: store.setPrefs, onChange: store.onPrefs },
    store: {
      projectDir: store.projectDir,          // board id → folder, through projects (SPEC §18)
      projectById: store.projectById,
      listRuns: store.listRuns,
      ready: store.ready,
      list: store.list,
      create: store.create,                  // ({name, folderId?, recipe?})
      move: store.move,                      // (boardId, folderId|null)
      folders: store.folders,                // list / create / rename / setColor / remove
      folderDir: store.folderDir,
      folderById: store.folderById,
      status: store.status,
      projectsRoot: store.projectsRoot,
      allowedRoots: store.allowedRoots,
      isInside: store.isInside,
      busy: projectBusy
    },
    ffmpeg,
    models: { list: () => null, resolve: () => null },   // replaced by the scanner
    log,
    logger,
    lang: store.lang,
    tr: store.tr,
    dev: DEV
  };
  return ctx;
}

const moduleErrors = new Map();   // module name → why it did not start

function registerModule(name) {
  const say = logger(name);
  let mod;
  try {
    mod = require(`./${name}`);
  } catch (e) {
    moduleErrors.set(name, e);
    say(e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(`./${name}`) ? 'module missing' : 'failed to load:', e);
    return;
  }
  if (!mod || typeof mod.register !== 'function') {
    moduleErrors.set(name, new Error('no register()'));
    say('has no register(ctx)');
    return;
  }
  try {
    const r = mod.register(ctx);
    if (r && typeof r.then === 'function') {
      r.then((v) => modules.set(name, v || mod)).catch((e) => say('register failed:', e));
    } else {
      modules.set(name, r || mod);
    }
  } catch (e) {
    moduleErrors.set(name, e);
    say('register failed:', e);
  }
}

/** The invoke channels the preload exposes, read from its table (between the channels:invoke markers). */
function bridgeChannels() {
  try {
    const src = fs.readFileSync(PRELOAD, 'utf8');
    const block = src.split('/* channels:invoke:begin */')[1].split('/* channels:invoke:end */')[0];
    return [...block.matchAll(/'([a-z]+:[A-Za-z]+)'/g)].map((m) => m[1]);
  } catch {
    return [];
  }
}

/**
 * A channel the preload exposes but nobody handles would reject with Electron's own English error.
 * Answer it instead — with an empty but well-formed value where the interface expects data.
 */
function stubMissingChannels() {
  const down = () => {
    const names = [...moduleErrors.keys()];
    return tr(STR.moduleDown, { name: names.join(', ') || '?' });
  };
  const shapes = {
    'models:list': () => ({ scannedAt: 0, durationMs: 0, comfy: { reachable: false }, models: [], capabilities: {}, missing: [], error: down() }),
    'models:scan': () => ({ scannedAt: 0, durationMs: 0, comfy: { reachable: false }, models: [], capabilities: {}, missing: [], error: down() }),
    'engine:status': () => ({
      comfy: { state: 'error', url: store.getPrefs().comfyUrl, version: null, managedByMia: false, minimax: false, error: down() },
      gpu: { name: null, vramUsedGB: null, vramTotalGB: null, lock: null, busyOther: false },
      queue: { running: 0, waiting: 0 }
    }),
    'engine:jobs': () => [],
    'engine:runs': () => [],
    'engine:looks': () => [],
    'bridge:status': () => ({ ok: false, running: false, error: down() })
  };
  for (const channel of bridgeChannels()) {
    if (handled.has(channel)) continue;
    try {
      ipcMain.handle(channel, () => (shapes[channel] ? shapes[channel]() : { ok: false, error: down() }));
      stubbed.add(channel);
      log('[bridge] no handler for', channel, '— answered by a stand-in');
    } catch {
      // registered straight on electron's ipcMain by a module (not through ctx.ipcMain): it is handled
      handled.add(channel);
    }
  }
}

// ---------------------------------------------------------------- boot
async function boot() {
  try {
    await store.init({
      userData: USER_DATA,
      documents: app.getPath('documents'),
      projectsRootOverride: process.env.MIA_PROJECTS_ROOT || null,
      lang: places.systemLang(app),          // first launch only: French on a French system, else English
      log: logger('store')
    });
  } catch (e) {
    log('[boot] store init failed:', e);
    dialog.showErrorBox('Mia', tr(STR.fatal, { msg: e.message }));   // the one native box left: nothing else can speak
    app.exit(1);
    return;
  }
  ffmpeg.configure({ engineRoot: () => places.engineRoot(store.getPrefs()), lang: store.lang, log: logger('ffmpeg') });
  media = createMedia({ store, ffmpeg, send, getWin: () => (win && !win.isDestroyed() ? win : null), log: logger('media') });
  // a model the scanner listed may live outside Mia's folders (MiniMax on C:, LocalMesh…): the
  // inventory vouches for it. Lazy: ctx.models is filled later, by the scanner.
  const ownsPath = (abs) => {
    try {
      return !!(ctx && ctx.models && typeof ctx.models.owns === 'function' && ctx.models.owns(abs));
    } catch {
      return false;
    }
  };
  shellops = createShellOps({ store, log: logger('shell'), ownsPath });
  // the engine knows which projects have jobs: their folders must not move nor go to the Bin
  store.setBusyCheck(projectBusy);
  // a project (folder of boards) created, renamed, moved…: the home and the tabs refresh (SPEC §18.2)
  store.onChange((payload) => send('folders:changed', payload));

  store.onPrefs((p, changed) => {
    if (changed.has('theme') && win && !win.isDestroyed()) {
      nativeTheme.themeSource = p.theme;
      win.setBackgroundColor(BG[p.theme] || BG.dark);
    }
  });

  Menu.setApplicationMenu(null);
  protocol.handle('mia', handleProtocol);
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (ev) => ev.preventDefault());
  });

  registerIpc();
  buildCtx();
  // MIA_SKIP_MODULES=scanner,engine (tests): run the shell alone, the stand-ins answer for them
  const skip = new Set(String(process.env.MIA_SKIP_MODULES || '').split(',').map((x) => x.trim()).filter(Boolean));
  // the scanner first: it fills ctx.models for the engine; the assistant bridge (SPEC §13) last,
  // it drives the other two. Each one may fail alone: Mia still opens.
  // the model installer (SPEC §21.4) reads ctx.models: after the scanner
  for (const name of ['scanner', 'installer', 'engine', 'bridge']) {
    if (skip.has(name)) moduleErrors.set(name, new Error('skipped (MIA_SKIP_MODULES)'));
    else registerModule(name);
  }
  stubMissingChannels();
  watchEngineForStore();

  createWindow();
  log('[boot] Mia', app.getVersion(), DEV ? '(dev)' : '', 'data:', DATA_DIR, 'projects:', store.projectsRoot());

  if (DEV) {
    // a channel only answered by a stand-in two seconds after start is a contract mismatch
    setTimeout(() => {
      const missing = bridgeChannels().filter((c) => stubbed.has(c));
      if (missing.length) log('[bridge] channels without a real handler:', missing.join(', '));
      else log('[bridge] every channel of the preload has a handler');
    }, 2000);
  }
}

if (gotLock) {
  app.whenReady().then(boot).catch((e) => log('[boot] failed:', e));
}

app.on('window-all-closed', () => app.quit());
