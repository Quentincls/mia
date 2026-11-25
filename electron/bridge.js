'use strict';
/**
 * Mia — the assistant bridge (SPEC §13).
 *
 * A tiny JSON server on 127.0.0.1 (first free port from 8777) that lets an assistant (Claude, Codex…)
 * drive Mia through mcp/mia-mcp.js. Every request carries the random token written, with the port, in
 * <data>\bridge.json; the file is removed when Mia quits.
 *
 * A copy goes to %TEMP%\Mia\bridge.json (the mirror): an assistant installed from the Store (Claude,
 * Codex… packaged MSIX) sees %APPDATA% through its own private copy, where a bridge.json written by a
 * Mia it once launched itself stays forever and hides the real one. %TEMP% is not redirected. Only the
 * real profile writes it: a test instance (MIA_USERDATA, MIA_BRIDGE_FILE) never takes it over, unless
 * MIA_BRIDGE_MIRROR names another path (tests of the mirror).
 *
 *   POST /call  { method, params, client }   Authorization: Bearer <token>
 *     → { ok:true, result } | { ok:false, error:"phrase française lisible" }
 *
 * Vocabulary (SPEC §18): a « planche » (board) is what the code calls a project (id p_…, mia.projects.*,
 * mia://p/…); a « projet » is a folder of boards (id f_…, mia.folders.*). The tools keep their old names
 * (mia_create_project makes a board) but speak of boards and folders in what they return.
 *
 * Two kinds of methods:
 *  - main side (here): ping, status, list_projects, catalog, jobs, wait, cancel, snapshot, and the readings of a
 *    LoRA training (train_options, train_status, train_wait: they light no « pilote Mia » pill, they only note
 *    who is watching);
 *  - window side: everything that touches the board (create_project, create_folder, add_block…) is relayed to
 *    the interface (`bridge:call` → src/js/ui/presence.js → `bridge:reply`), which goes through the normal
 *    editor API: what the assistant does is visible, paced, and undoable with Ctrl+Z.
 *
 * Security (SPEC §13.3): loopback only, token required, Host checked (no DNS rebinding), requests from a
 * web page refused (Origin), imports limited to existing files, nothing ever deleted from the disk.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const places = require('./places');

const PORT_FIRST = 8777;
const PORT_LAST = 8799;
const RELAY_TIMEOUT_MS = 60000;      // a window-side call that takes longer is reported, not awaited forever
const READY_TIMEOUT_MS = 25000;      // the interface may still be starting (Mia launched by the MCP server)
const WAIT_DEFAULT_S = 120;
const WAIT_MAX_S = 600;
const BODY_MAX = 1 << 20;
const CLIENT_RECENT_MS = 10 * 60 * 1000;
const SNAPSHOT_MAX_W = 1600;
const IMPORT_MAX = 64;
const TRAIN_IMPORT_MAX = 300;        // images of one mia_train_prepare
const TRAIN_PREPARE_MS = 140000;     // the import of a big set outlasts the ordinary relay (the page gives up at 120 s and says « importing »)
const TRAIN_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const TRAIN_UNTIL = new Set(['sample', 'checkpoint', 'end', 'change']);
const TRAIN_ENDED = new Set(['fini', 'erreur', 'annule', 'interrompu']);

const RELAYED = new Set([
  'ui_state', 'create_project', 'open_project', 'get_board', 'add_block', 'connect', 'set_params', 'rename_block',
  'remove_blocks', 'import_media', 'insert_recipe', 'arrange', 'move_blocks', 'run', 'get_output', 'focus', 'say', 'add_section',
  'create_folder', 'request', 'pending',
  // LoRA training: the page checks the green light (and the pause) and runs them through window.mia.train.*
  'train_control', 'train_note'
]);

const STR = {
  badToken: { fr: 'Jeton du pont refusé : relance le serveur MCP de Mia.', en: 'Bridge token refused: restart Mia’s MCP server.' },
  badRequest: { fr: 'Requête mal formée.', en: 'Malformed request.' },
  unknownMethod: { fr: 'Méthode inconnue du pont : « {m} ».', en: 'Unknown bridge method: “{m}”.' },
  noWindow: { fr: 'La fenêtre de Mia est fermée.', en: 'Mia’s window is closed.' },
  notReady: {
    fr: 'L’interface de Mia ne répond pas encore au pont. Réessaie dans quelques secondes.',
    en: 'Mia’s interface does not answer the bridge yet. Try again in a few seconds.'
  },
  timeout: { fr: 'Mia n’a pas répondu à temps ({s} s).', en: 'Mia did not answer in time ({s} s).' },
  reloaded: { fr: 'L’interface de Mia s’est rechargée pendant l’action.', en: 'Mia’s interface reloaded during the action.' },
  internal: { fr: 'Erreur interne du pont : {msg}', en: 'Internal bridge error: {msg}' },
  noEngine: { fr: 'Le moteur de Mia n’est pas disponible.', en: 'Mia’s engine is not available.' },
  noJob: {
    fr: 'Aucun calcul trouvé pour « {id} ». Les calculs terminés depuis plus de 30 min ne sont plus suivis : regarde le résultat avec mia_get_output.',
    en: 'No job found for “{id}”. Jobs finished more than 30 min ago are no longer tracked: look at the result with mia_get_output.'
  },
  needJob: { fr: 'Indique jobId ou nodeId.', en: 'Give jobId or nodeId.' },
  stillRunning: {
    fr: 'Toujours en cours après {s} s : rappelle mia_wait pour continuer d’attendre.',
    en: 'Still running after {s} s: call mia_wait again to keep waiting.'
  },
  noPaths: { fr: 'Donne au moins un chemin de fichier (paths).', en: 'Give at least one file path (paths).' },
  tooMany: { fr: '{n} fichiers au plus par appel.', en: '{n} files at most per call.' },
  notAbs: { fr: 'Chemin non absolu : « {p} ». Donne le chemin complet (ex. D:\\dossier\\image.png).', en: 'Not an absolute path: “{p}”. Give the full path (e.g. D:\\folder\\image.png).' },
  notFound: { fr: 'Fichier introuvable : « {p} ».', en: 'File not found: “{p}”.' },
  notFile: { fr: 'Ce n’est pas un fichier : « {p} ».', en: 'Not a file: “{p}”.' },
  snapFailed: { fr: 'La capture de la planche a échoué : {msg}', en: 'Capturing the board failed: {msg}' },
  catalogFailed: { fr: 'Catalogue illisible : {msg}', en: 'Unreadable catalog: {msg}' },
  // training a LoRA (SPEC « Entraîner un LoRA », mia_train_*)
  noTrainer: { fr: 'L’entraînement de LoRA n’est pas disponible dans cette Mia.', en: 'LoRA training is not available in this Mia.' },
  trainNoPaths: {
    fr: 'Donne les images : « images » (chemins complets des fichiers) ou « folder » (chemin complet d’un dossier).',
    en: 'Give the images: “images” (full file paths) or “folder” (the full path of a folder).'
  },
  trainNotDir: { fr: 'Ce n’est pas un dossier : « {p} ».', en: 'Not a folder: “{p}”.' },
  trainFolderMany: {
    fr: 'Ce dossier contient {n} images : {max} au plus par appel. Donne une liste « images ».',
    en: 'This folder holds {n} images: {max} at most per call. Give an “images” list.'
  },
  trainNeedId: { fr: 'Indique trainingId.', en: 'Give trainingId.' },
  trainBadUntil: { fr: '« until » : sample, checkpoint, end ou change.', en: '“until”: sample, checkpoint, end or change.' },
  trainBusy: {
    fr: 'Un entraînement est déjà en cours : « {name} » (pas {a} / {b}).',
    en: 'A training is already running: “{name}” (step {a} / {b}).'
  },
  trainNotReady: {
    fr: 'Ce brouillon ne peut pas encore partir : {why}. Complète-le avec mia_train_prepare {trainingId}.',
    en: 'This draft cannot start yet: {why}. Complete it with mia_train_prepare {trainingId}.'
  },
  trainStill: {
    fr: 'Rien de tel après {s} s : rappelle mia_train_wait plus tard (un entraînement dure des heures).',
    en: 'Nothing of the kind after {s} s: call mia_train_wait again later (a training lasts hours).'
  },
  trainProposed: {
    fr: 'Rien n’est lancé : l’utilisateur voit la carte « {name} propose un entraînement » dans Mia et clique « Lancer » lui-même. Ne relance pas ; mia_pending → training.state dit la suite (waiting, started, declined, changed). Toute modification du brouillon annule la proposition.',
    en: 'Nothing is started: the user sees the card “{name} suggests a training” in Mia and clicks “Start” themselves. Do not call it again; mia_pending → training.state tells what follows (waiting, started, declined, changed). Any change to the draft cancels the suggestion.'
  },
  trainProposedResume: {
    fr: 'Rien n’est relancé : l’utilisateur voit la carte « {name} propose de reprendre » dans Mia et clique « Reprendre » lui-même. mia_pending → training.state dit la suite.',
    en: 'Nothing is resumed: the user sees the card “{name} suggests resuming” in Mia and clicks “Resume” themselves. mia_pending → training.state tells what follows.'
  },
  trainStarted: {
    fr: 'Lancé (mode « Auto » : le feu vert n’est pas demandé). Suis-le avec mia_train_status ou mia_train_wait.',
    en: 'Started (mode “Auto”: the go-ahead is not asked). Follow it with mia_train_status or mia_train_wait.'
  }
};

/**
 * Corps d'une requête en texte. UTF-8 d'abord ; un corps qui n'en est pas (une console Windows en cp1252 qui envoie
 * « Wan 3.0 — drone de loin » : le tiret devient l'octet 0x97) est relu en windows-1252 au lieu de laisser des « � »
 * dans les titres (vu le 30/10). La table est écrite ici : le TextDecoder('windows-1252') de Node lit en fait du
 * latin-1 (0x80-0x9F y deviennent des caractères de contrôle invisibles).
 */
const CP1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
function decodeBody(buf) {
  if (!buf || !buf.length) return '';
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* pas de l'UTF-8 */ }
  let out = '';
  for (const b of buf) out += b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b);
  return out;
}

class BridgeError extends Error {}

function fill(s, vars) {
  return String(s).replace(/\{(\w+)\}/g, (_m, k) => (vars && vars[k] != null ? String(vars[k]) : ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FINAL = new Set(['done', 'error', 'cancelled']);

/** A client name fit for a label: « Claude », « Codex »… never a long or odd string. */
/** A board's folder id, whatever the store calls it (folderId, or a folder object). */
/** Written whole or not at all: the MCP server may read it at any moment. */
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function folderIdOf(b) {
  const v = b ? (b.folderId ?? b.folder ?? null) : null;
  return v && typeof v === 'object' ? v.id ?? null : v || null;
}

function cleanClient(name) {
  const s = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
  return s || 'Assistant';
}

class Bridge {
  constructor(ctx) {
    this.ctx = ctx;
    this.port = null;
    this.token = null;
    this.server = null;
    this.pending = new Map();          // relay id → { resolve, timer }
    this.seq = 0;
    this.clients = new Map();          // display name → last call (ms)
    this.lastCall = 0;
    this.rendererReady = false;
    this.readyWaiters = [];
    this.watched = null;               // the webContents whose reloads we follow
    this.trainAsked = new Map();       // display name → the training it last suggested starting (mia_pending → training)
    this.file = process.env.MIA_BRIDGE_FILE
      || path.join((ctx.paths && ctx.paths.data) || path.join(ctx.app.getPath('userData'), 'data'), 'bridge.json');
    this.mirror = process.env.MIA_BRIDGE_MIRROR
      || (process.env.MIA_USERDATA || process.env.MIA_BRIDGE_FILE ? null : path.join(os.tmpdir(), 'Mia', 'bridge.json'));
    this.version = (() => { try { return ctx.app.getVersion(); } catch { return '0'; } })();
    this.log = typeof ctx.logger === 'function' ? ctx.logger('bridge') : (...a) => { if (typeof ctx.log === 'function') ctx.log('[bridge]', ...a); };
  }

  tr(key, vars) {
    const o = STR[key] || { fr: key, en: key };
    let lang = 'fr';
    try { lang = typeof this.ctx.lang === 'function' ? this.ctx.lang() : 'fr'; } catch { /* fr */ }
    return fill(o[lang] || o.fr, vars);
  }

  fail(key, vars) { throw new BridgeError(this.tr(key, vars)); }

  // ------------------------------------------------------------------ lifecycle
  async start() {
    this.token = crypto.randomBytes(24).toString('hex');
    this.installIpc();
    const { app } = this.ctx;
    if (app && typeof app.on === 'function') {
      app.on('will-quit', () => this.stop());
      app.on('browser-window-created', () => setImmediate(() => this.watchWindow()));
    }
    process.once('exit', () => this.removeFile());
    try {
      await this.listen();
      this.writeFile();
      this.log(`listening on 127.0.0.1:${this.port}`);
    } catch (e) {
      this.log('could not start:', e && e.message ? e.message : e);
    }
    return this;
  }

  listen() {
    return new Promise((resolve, reject) => {
      const tryPort = (port) => {
        if (port > PORT_LAST) { reject(new Error(`no free port in ${PORT_FIRST}-${PORT_LAST}`)); return; }
        const server = http.createServer((req, res) => { this.onRequest(req, res); });
        server.requestTimeout = 0;           // mia_wait may legitimately last 10 minutes
        server.headersTimeout = 20000;
        server.timeout = 0;
        server.keepAliveTimeout = 5000;
        server.once('error', (e) => {
          if (e && (e.code === 'EADDRINUSE' || e.code === 'EACCES')) tryPort(port + 1);
          else reject(e);
        });
        server.listen(port, '127.0.0.1', () => {
          server.removeAllListeners('error');
          server.on('error', (e) => this.log('server error:', e && e.message));
          this.server = server;
          this.port = port;
          resolve(port);
        });
      };
      tryPort(PORT_FIRST);
    });
  }

  writeFile() {
    this.info = { port: this.port, token: this.token, pid: process.pid, version: this.version, started: Date.now() };
    writeJson(this.file, this.info);
    if (!this.mirror) return;
    try {
      writeJson(this.mirror, this.info);
    } catch (e) {
      this.log('mirror not written:', e && e.message);
    }
    // a temp cleaner (Storage Sense) may take it away while Mia stays open for days
    this.mirrorTimer = setInterval(() => {
      try { if (!fs.existsSync(this.mirror)) writeJson(this.mirror, this.info); } catch { /* next round */ }
    }, 10 * 60 * 1000);
    this.mirrorTimer.unref();
  }

  /** Only our own files: another Mia (tests, another profile) may have written its own since. */
  removeFile() {
    clearInterval(this.mirrorTimer);
    for (const file of [this.file, this.mirror]) {
      if (!file) continue;
      try {
        const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (cur && cur.pid === process.pid) fs.unlinkSync(file);
      } catch { /* already gone */ }
    }
  }

  stop() {
    if (this._stopped) return;
    this._stopped = true;
    this.removeFile();
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: this.tr('noWindow') }); }
    this.pending.clear();
    try { if (this.server) this.server.close(); } catch { /* closing */ }
  }

  // ------------------------------------------------------------------ window side
  installIpc() {
    const ipc = this.ctx.ipcMain;
    if (!ipc) return;
    if (typeof ipc.handle === 'function') {
      ipc.handle('bridge:status', () => this.statusForUi());
    }
    if (typeof ipc.on === 'function') {
      // reply(id, payload) — or a single object {id, …payload}
      ipc.on('bridge:reply', (e, a, b) => {
        const win = this.win();
        if (!win || !e || e.sender !== win.webContents) return;      // only our own page answers
        let id = a;
        let payload = b;
        if (a && typeof a === 'object' && b === undefined) { id = a.id; payload = a.payload !== undefined ? a.payload : a; }
        this.onReply(id, payload);
      });
    }
  }

  win() {
    try { return typeof this.ctx.getWin === 'function' ? this.ctx.getWin() : null; } catch { return null; }
  }

  /** Follow reloads (language change): the interface must say it is ready again. */
  watchWindow() {
    const win = this.win();
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    if (this.watched === wc) return;
    this.watched = wc;
    const lost = () => {
      this.rendererReady = false;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, error: this.tr('reloaded') });
        this.pending.delete(id);
      }
    };
    wc.on('did-start-loading', lost);
    wc.on('render-process-gone', lost);
    wc.once('destroyed', () => { lost(); if (this.watched === wc) this.watched = null; });
  }

  onReply(id, payload) {
    if (id === '__ready__') {
      this.rendererReady = true;
      const w = this.readyWaiters.splice(0);
      for (const fn of w) fn(true);
      return;
    }
    if (!this.rendererReady) {
      this.rendererReady = true;
      for (const fn of this.readyWaiters.splice(0)) fn(true);
    }
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(payload && typeof payload === 'object' ? payload : { ok: true, result: payload ?? null });
  }

  waitReady(ms = READY_TIMEOUT_MS) {
    this.watchWindow();
    if (this.rendererReady) return Promise.resolve(true);
    return new Promise((resolve) => {
      const fn = (v) => { clearTimeout(timer); resolve(v); };
      const timer = setTimeout(() => {
        const i = this.readyWaiters.indexOf(fn);
        if (i >= 0) this.readyWaiters.splice(i, 1);
        resolve(false);
      }, ms);
      this.readyWaiters.push(fn);
    });
  }

  /** Send a call to the interface and wait for its answer ({ok, result|error}). */
  async relay(method, params, client, timeoutMs = RELAY_TIMEOUT_MS) {
    let win = this.win();
    // Mia launched by the MCP server: the bridge is up a moment before the window exists
    for (let i = 0; (!win || win.isDestroyed()) && i < 40 && process.uptime() < 60; i++) {
      await sleep(200);
      win = this.win();
    }
    if (!win || win.isDestroyed()) this.fail('noWindow');
    if (!(await this.waitReady())) this.fail('notReady');
    const id = `b${++this.seq}_${Date.now().toString(36)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: this.tr('timeout', { s: Math.round(timeoutMs / 1000) }) });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        win.webContents.send('bridge:call', { id, method, params: params || {}, client });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: this.tr('internal', { msg: e.message }) });
      }
    });
  }

  /** Main-side calls still show the assistant at work (title bar pill), without waiting for an answer. */
  notifyActivity(method, client) {
    const win = this.win();
    if (!win || win.isDestroyed() || !this.rendererReady) return;
    try { win.webContents.send('bridge:call', { id: null, method: 'activity', params: { method }, client }); } catch { /* closing */ }
  }

  /**
   * Quentin should see the assistant work: a new or opened project brings Mia to the front, and a
   * minimised window comes back for any visible action (main.js never shows a test window).
   */
  wake(method) {
    if (typeof this.ctx.focusWindow !== 'function') return;
    const win = this.win();
    if (!win || win.isDestroyed()) return;
    const quiet = method === 'ui_state' || method === 'get_board' || method === 'get_output' || method === 'pending';
    // a training being prepared or suggested is to be seen: its screen fills, its card waits for a click
    const front = method === 'create_project' || method === 'open_project' || method === 'train_prepare' || method === 'train_start';
    if (front || (!quiet && win.isMinimized())) {
      try { this.ctx.focusWindow(); } catch { /* best effort */ }
    }
  }

  statusForUi() {
    const now = Date.now();
    const clients = [...this.clients.entries()]
      .filter(([, at]) => now - at < CLIENT_RECENT_MS)
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
    const active = !!this.server && !!this.port;
    // which assistants already declare Mia (Réglages → Assistants) ; null if the module is missing or fails
    let registered = null;
    try {
      const a = require('./assistants');
      if (a && typeof a.registration === 'function') registered = a.registration();
    } catch { registered = null; }
    return { active, running: active, port: this.port, clients, lastClient: clients[0] || null, lastCall: this.lastCall || null, file: this.file, registered };
  }

  // ------------------------------------------------------------------ HTTP
  onRequest(req, res) {
    const send = (code, obj) => {
      if (res.headersSent) return;
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) { send(403, { ok: false, error: 'host' }); return; }
    if (req.headers.origin) { send(403, { ok: false, error: 'origin' }); return; }   // never a web page
    if (!this.authorized(req.headers.authorization)) { send(401, { ok: false, error: this.tr('badToken') }); return; }
    if (req.method !== 'POST' || (req.url || '').split('?')[0] !== '/call') { send(404, { ok: false, error: this.tr('badRequest') }); return; }

    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_MAX) { tooBig = true; req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (tooBig) return;
      let msg;
      try { msg = JSON.parse(decodeBody(Buffer.concat(chunks)) || '{}'); } catch { send(400, { ok: false, error: this.tr('badRequest') }); return; }
      if (!msg || typeof msg.method !== 'string') { send(400, { ok: false, error: this.tr('badRequest') }); return; }
      let out;
      try {
        out = await this.dispatch(msg.method, msg.params && typeof msg.params === 'object' ? msg.params : {}, cleanClient(msg.client));
      } catch (e) {
        out = e instanceof BridgeError ? { ok: false, error: e.message } : { ok: false, error: this.tr('internal', { msg: e && e.message ? e.message : String(e) }) };
        if (!(e instanceof BridgeError)) this.log(`${msg.method} failed:`, e && e.stack ? e.stack : e);
      }
      send(200, out);
    });
    req.on('error', () => { /* client went away */ });
  }

  authorized(header) {
    const m = /^Bearer\s+(\S+)$/i.exec(String(header || ''));
    if (!m) return false;
    const a = Buffer.from(m[1]);
    const b = Buffer.from(this.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async dispatch(method, params, client) {
    if (method !== 'ping') {
      this.clients.set(client, Date.now());
      this.lastCall = Date.now();
    }
    switch (method) {
      case 'ping': return { ok: true, result: { app: 'mia', version: this.version, pid: process.pid, ui: this.rendererReady } };
      case 'status': this.notifyActivity(method, client); return { ok: true, result: await this.status(client) };
      case 'list_projects': this.notifyActivity(method, client); return { ok: true, result: await this.listProjects(client) };
      case 'catalog': this.notifyActivity(method, client); return { ok: true, result: await this.catalog(params) };
      case 'jobs': return { ok: true, result: await this.jobs() };
      case 'wait': this.notifyActivity(method, client); return { ok: true, result: await this.wait(params) };
      case 'cancel': this.notifyActivity(method, client); return this.cancel(params);
      case 'snapshot': this.wake(method); return this.snapshot(params, client);
      case 'import_media': this.checkPaths(params); this.wake(method); return this.relay(method, params, client, RELAY_TIMEOUT_MS * 2);
      // LoRA training. The three readings stay here and light nothing in the title bar; they note who is watching.
      case 'train_options': return { ok: true, result: await this.trainOptions() };
      case 'train_status': return { ok: true, result: await this.trainStatus(params, client) };
      case 'train_wait': return { ok: true, result: await this.trainWait(params, client) };
      case 'train_prepare': this.checkTrainPaths(params); this.wake(method); return this.relay(method, params, client, TRAIN_PREPARE_MS);
      case 'train_start': this.wake(method); return this.trainStart(params, client);
      case 'pending': return this.pendingWithTraining(params, client);
      default:
        if (RELAYED.has(method)) { this.wake(method); return this.relay(method, params, client); }
        return { ok: false, error: this.tr('unknownMethod', { m: method }) };
    }
  }

  // ------------------------------------------------------------------ main-side methods
  /** The engine instance (B1 puts it on ctx.engine); otherwise the IPC handlers it registered. */
  engine() { return this.ctx.engine && typeof this.ctx.engine === 'object' ? this.ctx.engine : null; }

  /** Call an ipcMain.handle handler from here, as the window would (fallback when an object is missing). */
  async invokeLocal(channel, ...args) {
    const { ipcMain } = require('electron');
    const h = ipcMain && ipcMain._invokeHandlers && ipcMain._invokeHandlers.get(channel);
    if (typeof h !== 'function') return undefined;
    const win = this.win();
    return h({ sender: win ? win.webContents : null, senderFrame: null, frameId: 0, processId: 0 }, ...args);
  }

  async engineCall(name, channel, ...args) {
    const eng = this.engine();
    if (eng && typeof eng[name] === 'function') return eng[name](...args);
    return this.invokeLocal(channel, ...args);
  }

  async status(client) {
    const win = this.win();
    let ui = null;
    if (win && !win.isDestroyed() && !this.rendererReady) await this.waitReady(10000);   // Mia just started
    if (win && !win.isDestroyed() && this.rendererReady) {
      const r = await this.relay('ui_state', {}, client, 5000).catch(() => null);
      if (r && r.ok) ui = r.result;
    }
    let eng = null;
    try { eng = await this.engineCall('status', 'engine:status'); } catch { eng = null; }
    const inv = this.inventory();
    const caps = {};
    if (inv && inv.capabilities) {
      for (const [k, v] of Object.entries(inv.capabilities)) caps[k] = !!(v && v.available);
    }
    return {
      mia: {
        version: this.version,
        lang: (() => { try { return this.ctx.lang() === 'en' ? 'en' : 'fr'; } catch { return 'fr'; } })(),   // write to the user in this language
        window: win && !win.isDestroyed() ? (win.isMinimized() ? 'minimized' : win.isVisible() ? 'visible' : 'hidden') : 'closed',
        interfaceReady: this.rendererReady,
        view: ui ? ui.view : null,
        board: ui ? ui.board || ui.project || null : null,
        folder: ui ? ui.folder || null : null,
        readOnly: ui ? !!ui.readOnly : false,
        blocks: ui ? ui.blocks : null,
        selection: ui ? ui.selection : [],
        // every board open in a tab, left to right; active = the one on screen (none on the home page)
        tabs: ui && Array.isArray(ui.tabs) ? ui.tabs : []
      },
      engine: eng ? {
        comfy: eng.comfy ? { state: eng.comfy.state, version: eng.comfy.version || null, error: eng.comfy.error || null } : null,
        gpu: eng.gpu ? {
          name: eng.gpu.name || null, vramUsedGB: eng.gpu.vramUsedGB ?? null, vramTotalGB: eng.gpu.vramTotalGB ?? null,
          busyWith: eng.gpu.lock ? { who: eng.gpu.lock.who, sinceMs: eng.gpu.lock.since, mine: !!eng.gpu.lock.mine } : null,
          busyOther: !!eng.gpu.busyOther
        } : null,
        queue: eng.queue || null
      } : null,
      // the LoRA training that is active (waiting for the GPU, preparing, running, sampling, letting a job through), or null
      training: this.trainingBrief(eng),
      capabilities: caps,
      bridge: { port: this.port }
    };
  }

  inventory() {
    const m = this.ctx.models;
    try {
      if (m && typeof m.inventory === 'function') return m.inventory();
      if (m && typeof m.list === 'function') { const arr = m.list(); return (arr && arr.inventory) || null; }
    } catch { /* scanner down */ }
    return null;
  }

  /** The store module (main.js puts it on ctx; else the one in require's cache). */
  store() {
    const s = this.ctx.store;
    if (s && typeof s.list === 'function') return s;
    try { return require('./store'); } catch { return null; }
  }

  /** Every project (folder) from the store (SPEC §18.2), or [] on a Mia without folders. */
  async listFolders() {
    let mod = null;
    try { mod = require('./store'); } catch { mod = null; }
    let arr;
    try {
      // ctx.store is a hand-picked subset: the store module itself may have more
      const store = [this.ctx.store, mod].find((s) => s && ((s.folders && typeof s.folders.list === 'function') || typeof s.listFolders === 'function'));
      if (store && store.folders && typeof store.folders.list === 'function') arr = await store.folders.list();
      else if (store) arr = await store.listFolders();
      else arr = await this.invokeLocal('folders:list');
    } catch { arr = null; }
    if (arr && !Array.isArray(arr) && Array.isArray(arr.folders)) arr = arr.folders;
    return (Array.isArray(arr) ? arr : []).filter((f) => f && f.id);
  }

  /**
   * SPEC §18.5: { folders:[{id, name, color, boards}], boards:[{id, name, folderId, folder, blocks, …}] }
   * — projects are folders of boards; a board outside any project has folderId null.
   */
  async listProjects(client) {
    // which boards are open in a tab right now, and which one is on screen (the interface knows)
    let tabs = [];
    const win = this.win();
    if (client !== undefined && win && !win.isDestroyed() && this.rendererReady) {
      const r = await this.relay('ui_state', {}, client, 5000).catch(() => null);
      if (r && r.ok && r.result && Array.isArray(r.result.tabs)) tabs = r.result.tabs;
    }
    const open = new Map(tabs.map((t) => [t.id, t]));
    let list;
    const store = this.store();
    try { list = await store.list(); } catch { list = await this.invokeLocal('projects:list'); }
    const raw = Array.isArray(list) ? list : [];
    const folders = await this.listFolders();
    const names = new Map(folders.map((f) => [f.id, f.name]));
    const count = new Map();
    const boards = raw.map((p) => {
      const fid = folderIdOf(p);
      if (fid) count.set(fid, (count.get(fid) || 0) + 1);
      return {
        id: p.id, name: p.name, folderId: fid, folder: fid ? names.get(fid) || null : null,
        blocks: p.nodes ?? null, dir: p.dir || null, updated: p.updated || null, opened: p.opened || null,
        open: open.has(p.id), active: !!(open.get(p.id) && open.get(p.id).active)
      };
    });
    return {
      folders: folders.map((f) => ({
        id: f.id, name: f.name, color: f.color || null,
        boards: count.has(f.id) ? count.get(f.id) : (Number.isFinite(+f.boards) ? +f.boards : Array.isArray(f.boards) ? f.boards.length : 0),
        updated: f.updated || null
      })),
      boards
    };
  }

  /** Block types, their ports and settings with allowed values, recipes, models per capability, LoRAs. */
  async catalog(params) {
    const root = (this.ctx.paths && this.ctx.paths.root) || path.join(__dirname, '..');
    let cat;
    try { cat = JSON.parse(fs.readFileSync(path.join(root, 'src', 'catalog', 'nodes.json'), 'utf8')); } catch (e) { this.fail('catalogFailed', { msg: e.message }); }
    const inv = this.inventory();
    const lang = (() => { try { return this.ctx.lang(); } catch { return 'fr'; } })();
    const L = (o) => (o && typeof o === 'object' ? (o[lang] || o.fr || o.en || '') : o == null ? '' : String(o));
    const only = params && params.type ? String(params.type) : null;

    const usable = (m) => m && m.status === 'ready' && m.license !== 'forbidden';
    const modelChoices = (caps, allowNone) => {
      const isLora = caps.includes('lora');
      const out = isLora ? [] : [{ value: 'auto', label: lang === 'en' ? 'Auto (recommended default)' : 'Auto (choix conseillé)' }];
      if (allowNone) out.unshift({ value: 'none', label: lang === 'en' ? 'None' : 'Aucun' });
      if (!inv || !Array.isArray(inv.models)) return out;
      for (const m of inv.models) {
        if (!usable(m)) continue;
        if (isLora) {
          if (!(m.role === 'lora' || (m.caps || []).includes('lora')) || m.hidden) continue;
          out.push({ value: m.id, label: L(m.label) || m.file, loraFor: m.loraFor || null, trigger: m.trigger || null, kind: m.loraKind || null,
            ...(Number.isFinite(Number(m.strength)) ? { strength: Number(m.strength) } : {}), ...(m.advice ? { advice: L(m.advice) } : {}) });
        } else {
          if (m.hidden || !(m.caps || []).some((c) => caps.includes(c))) continue;
          // version (Compacte, Pleine…) and memoryGB (estimated peak on this machine) when the scanner knows them
          out.push({ value: m.id, label: L(m.label) || m.file, family: m.family || null, speed: m.speed ?? null, quality: m.quality ?? null, license: m.license,
            version: m.version ? L(m.version.tag) || null : null, memoryGB: m.mem && m.mem.gb != null ? m.mem.gb : null });
        }
      }
      return out;
    };

    // how to drive a Model block, for assistants (mia_catalog → types[gen].howItWorks)
    const MODEL_BLOCK_HOWTO = [
      'One block per model. Set params.model to a family from params[model].choices: fam:ltx, fam:minimax, fam:wan, fam:qwen, fam:klein, fam:qwen21 (this PC) or hf:<family> (online at Higgsfield, paid: run it only when the user asked).',
      'What you WIRE decides what it does (choices[].ways): each way lists needs (must be wired), needsOneOf, takes (inputs and how many) and settings. Nothing wired → from text; a start image → animate it; references → blend them (MiniMax); a guide video (+ a start image) → guided; a 3D render (+ a start image as look) → photoreal; a character sheet alone → LTX video from a sheet (trial); a character + a motion video → animate a character; a video into MiniMax → extend it.',
      'A wired input that no possible way uses alone (an end image, keyframes or a sheet without a start image on LTX…) BLOCKS the block with « Il manque pour « … » : … » — nothing silently starts from text: wire what is missing. mia_get_board → model.connect lists it.',
      'On screen an empty Model block of a family that does several things (LTX, MiniMax, most online ones) shows only its prompt and a « Partir de : » line, one button per starting point (start image, references, 3D render, guide video, character sheet…): nothing is imposed, nothing wired = from the prompt (a family that cannot start from the prompt, like Genjutsu, shows what it needs instead). Wan and Qwen (one way each) show their inputs. You never click those buttons: wire the port directly (mia_get_board → model.startFrom lists them while nothing is wired).',
      'Wire with mia_connect giving the input port id: every input the family takes can be wired, even those the UI keeps behind « Partir de » or « + Ajouter » (wiring shows them). Without a port: the family\'s main input while it has room (MiniMax: refs, also for the 2nd and 3rd image; LTX: start), then an input that works on its own (a sound into MiniMax → audio, the sound to follow). An input the chosen way does not take is ignored: mia_connect then answers ignored:true with a note naming the mode that uses it. On this PC, when two ways fit equally, params.workflow picks one (mia_get_board → model.otherWays).',
      'ONLINE families (hf:…) show their MODE on screen (Auto · Texte · Animer · Références · Modifier…): params.workflow = a way id (or its label) FORCES that mode even if the wires say otherwise — the block then lists what it lacks (model.connect) and ignores what it does not use (model.ignored); "auto" (or "") goes back to choosing from the wires. mia_get_board → model.mode, model.modes (each with what it lacks), model.accepts (inputs of the current mode at its tier), model.price (public rate), model.cite. Settings are checked against the CURRENT mode and tier (ways[].settings: bounds, options, onlyTiers, tierOptions); a value valid only in another mode is kept with a note. hf.tier picks the tier (Kling 3.0 Turbo has no sound, no end image, no prompt adherence, and needs a prompt). In an edit mode with durationFromSource, hf.duration left unset follows the connected video (bounded); ways[].minSeconds is the shortest source accepted. ways[].notes are the provider\'s own rules; ways[].unsupported lists fields Mia does not send yet.',
      'Several images into one multi input are numbered by the vertical order of their source blocks (top first). Name them in the prompt: MiniMax references « Image 1 », « Vidéo 2 », « Son 1 » (Son = the reference sounds input, counted on their own); Qwen edit: the image to edit is « image 1 », helper images « image 2 », « image 3 ». An online way with ways[].cite uses ITS tokens: Kling 4.0 references @image_1… and @video_1…; Kling 4.0 edit: the source video is @video_1, reference videos start at @video_2 (cite.videoFrom), images at @image_1 — « Image n » / « Vidéo n » are rewritten to those tokens before sending. Keyframes (keys) are spread evenly between the first and the last frame on this PC; online, the model places them itself, in wire order.',
      'Inputs or ways marked trial are new and not yet checked by the user at the lab: use them when asked, and tell the user to judge the result by eye. Settings of a way not in the list are ignored.',
      'Prompts: English works best for LTX and MiniMax. Preview first (low resolution, short), then final.',
    ].join(' ');

    // Model block (SPEC §23): its « model » is a family — of this PC (fam:ltx…, or one model id of the inventory) or
    // online at Higgsfield (hf:seedance-2-5…, paid, run only when the user asks) — with what it does and the inputs
    // it shows (up to how many); an online family also lists its own settings (hf.*), set like any other.
    const modelFamilies = () => {
      const route = require('./engine/route');
      const R = route.rules();
      const { local, cloud } = route.catalogs();
      const out = [];
      const portsOf = (fam) => Object.fromEntries(Object.entries(R.portsOfFamily(fam)).map(([k, v]) => [k, v.multi ? `${v.max} max` : '1']));
      // each way of working: what it does, what must be wired, what it takes (how many; « trial » = not yet checked
      // at the lab: say so to the user), its settings — the assistant wires exactly what the way it wants needs
      const waysOf = (def, online = false) => (def.workflows || []).map((wf) => {
        const ports = R.portsOfWorkflow(wf);
        const w = { workflow: wf.id, does: L(wf.label), needs: wf.required || [] };
        if (Array.isArray(wf.oneOf) && wf.oneOf.length) w.needsOneOf = wf.oneOf;
        w.takes = Object.fromEntries(Object.entries(ports).map(([k, v]) => [k, `${v.multi ? `${v.max} max` : '1'}${v.trial ? ' (trial)' : ''}`]));
        if (online) {
          // en ligne (30/10) : chaque mode a SES réglages (Kling Omni : durée 5/10 en « Animer », 3-10 en
          // « Références »), ses paliers, ses notes de doc, ses jetons de citation, son tarif public, ce que Mia n'envoie pas
          w.settings = (wf.params || []).map(settingDef);
          for (const [k, v] of Object.entries(wf.ports || {})) {
            if (v && v.minSeconds) (w.minSeconds = w.minSeconds || {})[k] = v.minSeconds;
            if (v && v.maxSeconds) (w.maxSeconds = w.maxSeconds || {})[k] = v.maxSeconds;
            if (v && Array.isArray(v.onlyTiers)) (w.portTiers = w.portTiers || {})[k] = v.onlyTiers;
            if (v && v.help) (w.portHelp = w.portHelp || {})[k] = L(v.help);
          }
          if (wf.cite) w.cite = wf.cite;
          if (wf.durationFromSource) w.durationFromSource = wf.durationFromSource;
          if (Array.isArray(wf.promptRequiredTiers) && wf.promptRequiredTiers.length) w.promptRequiredTiers = wf.promptRequiredTiers;
          if (wf.price) w.price = wf.price;
          if (Array.isArray(wf.notes) && wf.notes.length) w.notes = wf.notes;
          if (Array.isArray(wf.unsupported) && wf.unsupported.length) w.unsupported = wf.unsupported.map((u) => ({ field: u.field, why: L(u.reason) }));
        } else w.settings = (wf.params || []).map((p) => (typeof p === 'string' ? p : p.id));
        if (wf.promptRequired) w.promptRequired = true;
        if (wf.trial) w.trial = true;
        // installé par la veille de Mia (SPEC §23.8) : jamais essayé, le dire à l'utilisateur
        if (wf.fresh) w.notTriedYet = true;
        return w;
      });
      // un réglage en ligne tel que le donne le catalogue (bornes, choix, paliers, aide)
      function settingDef(p) {
        const o = { id: p.id, kind: p.kind, label: L(p.label), default: p.default };
        if (Array.isArray(p.options)) o.options = p.options.map((x) => ({ value: x.value, label: L(x.label) }));
        for (const k of ['min', 'max', 'step', 'unit', 'format', 'maxItems']) if (p[k] !== undefined && p[k] !== '') o[k] = p[k];
        if (p.advanced) o.advanced = true;
        if (Array.isArray(p.onlyTiers)) o.onlyTiers = p.onlyTiers;
        if (p.tierOptions) o.tierOptions = p.tierOptions;
        if (p.hint) o.hint = L(p.hint);
        if (p.id === 'hf.output_format') o.hiddenInMia = true;
        return o;
      }
      for (const [key, def] of Object.entries(local.families || {})) {
        if (!Array.isArray(def.workflows) || !def.workflows.length) continue;
        const fam = R.familyOf(`fam:${key}`, local, cloud, inv);
        const installed = !!(inv && (inv.models || []).some((m) => usable(m) && !m.hidden && R.localKeyOf(m, local.families) === key));
        out.push({ value: `fam:${key}`, label: def.name, where: 'local', installed, about: L(def.desc), does: def.workflows.map((w) => L(w.label)),
          inputs: portsOf(fam), ways: waysOf(def), ...(def.limits ? { limits: { seconds: def.limits.seconds, fps: def.limits.fps, resolutions: def.limits.resolutions } } : {}) });
      }
      for (const def of cloud.families || []) {
        const fam = { provider: def.provider, key: def.key, def };
        const settings = [];
        for (const wf of def.workflows || []) {
          for (const p of wf.params || []) {
            if (settings.some((s) => s.id === p.id)) continue;
            const s = { id: p.id, kind: p.kind, label: L(p.label), default: p.default };
            if (Array.isArray(p.options)) s.options = p.options.map((x) => x.value);
            if (p.kind === 'slider') Object.assign(s, { min: p.min, max: p.max });
            settings.push(s);
          }
        }
        out.push({ value: def.key, label: def.name, maker: def.maker, where: 'online (Higgsfield, paid)', kind: def.kind,
          does: (def.workflows || []).map((w) => L(w.label)), inputs: portsOf(fam), ways: waysOf(def, true), settings,
          settingsNote: 'Union of all modes (first definition): each mode\'s own settings, bounds, tiers and notes are in ways[].settings.',
          ...(def.fresh || (def.workflows || []).some((w) => w.fresh)
            ? { notTriedYet: 'New at Higgsfield, installed by Mia\'s watch: never run in Mia yet. Say so to the user before spending credits.' } : {}) });
      }
      return out;
    };

    // looks of the Finish block whose .cube is not on this PC (« Etalo » lives in the engine folder): not offered
    let missingLooks = new Set();
    try {
      const prefs = this.ctx.prefs && typeof this.ctx.prefs.get === 'function' ? await this.ctx.prefs.get() : {};
      const { looks } = require('./engine/executors/looks.js');
      missingLooks = new Set(looks({ engineRoot: places.engineRoot(prefs || {}) }).filter((l) => !l.exists).map((l) => l.id));
    } catch { /* every look listed */ }

    const types = [];
    for (const t of cat.types || []) {
      if (only && t.id !== only) continue;
      const params = (t.params || []).map((p) => {
        const o = { id: p.id, kind: p.kind, label: L(p.label) };
        if (p.default !== undefined) o.default = p.default;
        if (p.required) o.required = true;
        if (p.advanced) o.advanced = true;
        if (p.port) o.overriddenByInput = p.port;
        if (p.showIf) o.showIf = p.showIf;
        if (p.hint) o.hint = L(p.hint);
        if (Array.isArray(p.options)) {
          o.options = p.options
            .filter((x) => !(t.id === 'finish' && p.id === 'look' && missingLooks.has(x.value)))
            .map((x) => ({ value: x.value, label: L(x.label), ...(x.hint ? { hint: L(x.hint) } : {}) }));
        }
        if (p.kind === 'slider') Object.assign(o, { min: p.min, max: p.max, step: p.step, unit: p.unit || '' });
        if (p.kind === 'model') o.choices = p.gen ? modelFamilies() : modelChoices(p.caps || [], !!p.allowNone);
        if (p.kind === 'frame') o.of = p.of || null;
        return o;
      });
      types.push({
        type: t.id,
        name: L(t.label),
        description: L(t.desc),
        category: t.category || null,
        computes: !!t.engine,
        gpu: t.engine ? t.engine.gpu || null : null,
        modes: t.modes || null,
        estimate: t.estimate ? (typeof t.estimate === 'object' && !t.estimate.fr ? Object.fromEntries(Object.entries(t.estimate).map(([k, v]) => [k, L(v)])) : L(t.estimate)) : null,
        inputs: (t.inputs || []).map((i) => {
          const o = { port: i.id, type: i.type, label: L(i.label) };
          if (i.required) o.required = true;
          if (i.multi) o.multi = true;
          if (i.max) o.max = i.max;
          if (i.hint) o.hint = L(i.hint);
          return o;
        }),
        outputs: (t.outputs || []).map((o) => ({ port: o.id, type: o.type, label: L(o.label) })),
        params,
        // SPEC §23: the Model block shows only the inputs of its family, and what is connected picks what it does
        ...(t.ports === 'model' ? { howItWorks: MODEL_BLOCK_HOWTO } : {})
      });
    }

    let recipes = [];
    if (!only) {
      const dir = path.join(root, 'src', 'catalog', 'recipes');
      let ids = [];
      try { ids = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch { ids = []; }
      for (const id of Array.isArray(ids) ? ids : []) {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(dir, `${String(id).replace(/[^\w-]/g, '')}.json`), 'utf8'));
          recipes.push({
            id: r.id, name: L(r.label), description: L(r.desc),
            blocks: (r.nodes || []).map((n) => ({ key: n.key, type: n.type, waitsFor: n.placeholder ? `${n.placeholder.kind}: ${L(n.placeholder)}` : undefined })),
            wires: (r.edges || []).map(([a, ap, b, bp]) => `${a}.${ap} → ${b}.${bp}`)
          });
        } catch { /* a broken recipe is skipped */ }
      }
    }

    const capabilities = {};
    if (inv && inv.capabilities) {
      for (const [k, v] of Object.entries(inv.capabilities)) {
        const def = v && v.default && Array.isArray(inv.models) ? require('./engine/route').rules().findModel(inv, v.default) : null;
        // memoryGB: estimated peak memory of that default (what « auto » runs) on this machine
        capabilities[k] = { available: !!(v && v.available), default: def ? L(def.label) || def.file : null,
          memoryGB: def && def.mem && def.mem.gb != null ? def.mem.gb : null };
      }
    }
    const missing = inv && Array.isArray(inv.missing) ? inv.missing.map((m) => ({ caps: m.caps, what: L(m.what) })) : [];
    // the machine's one memory total (GB), and the models Mia recognises but does not offer (never a choice: a block
    // set to one of them is refused when planned, with the same reason)
    const machine = { memoryGB: inv && inv.machine && inv.machine.memGB != null ? inv.machine.memGB : null };
    const notOffered = inv && Array.isArray(inv.models)
      ? inv.models.filter((m) => m && m.blocked && m.status !== 'duplicate' && m.status !== 'other-app')
        .map((m) => ({ label: L(m.label) || m.file, reason: L(m.blocked.note) || L(m.statusNote) })) : [];

    return {
      portRules: lang === 'en'
        ? 'Wires go from an output to an input. image→image|media, video→video|media, text→text, audio→audio (a sound file imported into a Média block; it goes only into the Son block). An output "follow:<input>" has the concrete type of what is wired into that input; the Média block (import) outputs the type of its file. An input with multi accepts several wires (max = limit), ordered top to bottom.'
        : 'Un fil va d’une sortie vers une entrée. image→image|media, video→video|media, text→text, audio→audio (un fichier son importé dans un bloc Média ; il ne va que dans le bloc Son). Une sortie « follow:<entrée> » a le type concret de ce qui est branché sur cette entrée ; le bloc Média (import) sort le type de son fichier. Une entrée multi accepte plusieurs fils (max = limite), ordonnés de haut en bas.',
      types,
      recipes,
      capabilities,
      missing,
      machine,
      notOffered
    };
  }

  async jobs() {
    const list = await this.engineCall('jobList', 'engine:jobs');
    return (Array.isArray(list) ? list : []).map((j) => ({
      jobId: j.jobId, boardId: j.projectId, projectId: j.projectId /* deprecated alias of boardId, kept one version */, board: j.projectName || null, nodeId: j.nodeId, block: j.label, type: j.type,
      mode: j.mode, state: j.state, progress: j.progress, etaS: j.eta ?? null, message: j.message || null,
      waitingFor: j.who || null,
      // online job (Model block hf:…): its own lane, never waits for the GPU; remote = queued | running | full at Higgsfield
      ...(j.online ? { online: true, remote: j.remote || null } : {}),
      // a LoRA training (SPEC §8.7): the job runs beside it (its name), or waits behind it (message says why, with the
      // memory figures when the memory is what is missing)
      ...(j.beside ? { besideTraining: j.beside } : {}),
      ...(j.trainWait ? { waitsForTraining: true } : {})
    }));
  }

  cancel(params) {
    const jobId = params && params.jobId;
    if (!jobId) this.fail('needJob');
    return Promise.resolve(this.engineCall('cancel', 'engine:cancel', jobId)).then((r) => (r && r.ok === false ? { ok: false, error: r.error } : { ok: true, result: { cancelled: jobId } }));
  }

  /** Absolute paths of a run's outputs. */
  describeRun(projectId, run) {
    if (!run) return null;
    const dir = this.ctx.store && typeof this.ctx.store.projectDir === 'function' ? this.ctx.store.projectDir(projectId) : null;
    const abs = (rel) => (rel && dir ? path.join(dir, String(rel).replace(/\//g, path.sep)) : rel || null);
    const outputs = [];
    for (const [port, o] of Object.entries(run.outputs || {})) {
      outputs.push({ port, path: abs(o.path), kind: o.kind || null, meta: o.meta || null, poster: abs(o.poster) });
    }
    return { runId: run.runId, status: run.status, mode: run.mode || null, model: run.model || null, error: run.error || null, finished: run.finished || null, outputs };
  }

  async wait(params) {
    const timeoutS = Math.max(1, Math.min(WAIT_MAX_S, Number(params.timeoutS) || WAIT_DEFAULT_S));
    if (!params.jobId && !params.nodeId) this.fail('needJob');
    const find = async () => {
      const list = await this.engineCall('jobList', 'engine:jobs');
      const jobs = Array.isArray(list) ? list : [];
      if (params.jobId) return jobs.find((j) => j.jobId === params.jobId) || null;
      const board = params.boardId || params.projectId;
      const mine = jobs.filter((j) => j.nodeId === params.nodeId && (!board || j.projectId === board));
      return mine.filter((j) => !FINAL.has(j.state)).pop() || mine.pop() || null;
    };
    let job = await find();
    if (!job) this.fail('noJob', { id: params.jobId || params.nodeId });

    const eng = this.engine();
    const deadline = Date.now() + timeoutS * 1000;
    let finalEvt = null;
    if (!FINAL.has(job.state)) {
      await new Promise((resolve) => {
        let poll = null;
        const done = () => { clearTimeout(timer); clearInterval(poll); if (eng && typeof eng.off === 'function') eng.off('event', onEvt); resolve(); };
        const onEvt = (evt) => {
          if (evt && evt.jobId === job.jobId && FINAL.has(evt.kind)) { finalEvt = evt; done(); }
        };
        const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
        if (eng && typeof eng.on === 'function') eng.on('event', onEvt);
        // polling too: an event emitted between find() and on() must not be missed
        poll = setInterval(async () => {
          try {
            const j = await find();
            if (j && j.jobId === job.jobId && FINAL.has(j.state)) { job = j; done(); }
          } catch { /* next tick */ }
        }, eng ? 2500 : 1000);
      });
      if (!finalEvt) job = (await find()) || job;
    }
    const state = finalEvt ? finalEvt.kind : job.state;
    const out = {
      jobId: job.jobId, nodeId: job.nodeId, boardId: job.projectId, projectId: job.projectId /* deprecated alias of boardId */, block: job.label, mode: job.mode, state,
      progress: state === 'done' ? 1 : (finalEvt && finalEvt.progress != null ? finalEvt.progress : job.progress ?? null), message: (finalEvt && (finalEvt.message || finalEvt.error)) || job.message || null
    };
    if (job.beside) out.besideTraining = job.beside;          // computed beside a LoRA training (SPEC §8.7)
    if (!FINAL.has(state)) {
      if (job.trainWait) out.waitsForTraining = true;          // held behind a LoRA training: message says why
      out.timedOut = true;
      out.etaS = job.eta ?? null;
      out.hint = this.tr('stillRunning', { s: timeoutS });
      return out;
    }
    let run = finalEvt && finalEvt.run ? finalEvt.run : null;
    if (!run) {
      try {
        const runs = await this.engineCall('runs', 'engine:runs', job.projectId, job.nodeId);
        const list = (Array.isArray(runs) ? runs : []).slice().sort((a, b) => (b.finished || b.started || 0) - (a.finished || a.started || 0));
        run = list[0] || null;
      } catch { run = null; }
    }
    out.run = this.describeRun(job.projectId, run);
    if (state === 'error' && run && run.error && !out.message) out.message = run.error;
    return out;
  }

  // ------------------------------------------------------------------ training a LoRA (mia_train_*)
  /** The training service of the main process (electron\trainer.js), once it has read its folders. */
  async trainer() {
    const t = this.ctx.trainer;
    if (!t || typeof t.get !== 'function') this.fail('noTrainer');
    try {
      await t.ready;
      if (typeof t.refreshPrefs === 'function') await t.refreshPrefs();
    } catch { /* it answers with what it has */ }
    return t;
  }

  lang() { try { return this.ctx.lang() === 'en' ? 'en' : 'fr'; } catch { return 'fr'; } }

  /** The engine's last status, without asking the GPU again (a reading must stay quick). */
  engineNow() {
    const eng = this.engine();
    try { return eng && typeof eng.statusNow === 'function' ? eng.statusNow() : null; } catch { return null; }
  }

  /** mia_status → training: {trainingId, name, base, state, phase, pause, step, steps, progress, endAt} | null */
  trainingBrief(engStatus) {
    let b = engStatus && engStatus.training ? engStatus.training : null;
    if (!b) {
      const t = this.ctx.trainer;
      try { b = t && typeof t.brief === 'function' ? t.brief() : null; } catch { b = null; }
    }
    if (!b) return null;
    return {
      trainingId: b.id, name: b.name, base: b.base, state: b.state, phase: b.phase || null, pause: b.pause || null,
      step: b.step, steps: b.steps, progress: b.progress, endAt: b.endAt || null
    };
  }

  async trainOptions() {
    const t = await this.trainer();
    const o = t.options();
    const lang = this.lang();
    const L = (x) => (x && typeof x === 'object' ? (x[lang] || x.fr || x.en || '') : x == null ? '' : String(x));
    const eng = this.engineNow();
    const gpu = eng && eng.gpu ? eng.gpu : null;
    return {
      bases: (o.bases || []).map((b) => ({
        id: b.id, label: L(b.label), media: b.media, ready: !!b.ready,
        ...(b.ready ? {} : { why: L(b.why) }),
        missing: b.missing || [],
        defaults: b.defaults, lengths: b.lengths,
        estimate: { sPerStep: b.estimate.sPerStep, sampleSec: b.estimate.sampleSec, vramGB: b.estimate.vramGB, measured: !!b.estimate.measured }
      })),
      minImages: o.minImages,
      advisedImages: o.adviseImages,
      samplePrompts: o.samplePrompts,
      kinds: ['character', 'place', 'style'],
      disk: o.disk,
      gpu: gpu ? {
        lock: gpu.lock ? { who: gpu.lock.who, sinceMs: gpu.lock.since, mine: !!gpu.lock.mine } : null,
        vramUsedGB: gpu.vramUsedGB ?? null, vramTotalGB: gpu.vramTotalGB ?? null
      } : null,
      active: o.active || null
    };
  }

  /** What an assistant reads of one training: train:get without the screen's own data (curve, raw events). */
  trainView(s) {
    const eng = this.engineNow();
    const draft = s.state === 'pret';
    const est = draft ? s.estimate : s.eta;
    return {
      trainingId: s.trainingId, name: s.name, base: s.base, kind: s.kind, trigger: s.trigger,
      state: s.state, phase: s.phase, pause: s.pause ? s.pause.reason : null,
      by: s.by ? s.by.who : null, startedBy: s.startedBy || null, proposedBy: s.proposedBy || null,
      // a suggestion of an assistant: waiting for the user's click, or what became of the last one
      proposal: s.proposal ? { state: 'waiting', by: s.proposal.by, resume: !!s.proposal.resume }
        : s.proposalEnd ? { state: s.proposalEnd.state } : null,
      step: s.step, steps: s.steps, progress: s.progress,
      importing: s.importing || null,
      dataset: s.dataset ? { count: s.dataset.count, captioned: s.dataset.captions, small: s.dataset.small, skipped: (s.dataset.skipped || []).length } : null,
      ...(draft ? { ready: !!s.ready, why: s.why || null } : {}),
      loss: s.loss, pace: s.pace,
      eta: { seconds: est ? est.seconds : null, endAt: est ? est.endAt : null },
      lastNewsS: s.lastNewsS, silent: !!s.silent,
      memory: {
        vramGB: eng && eng.gpu && eng.gpu.vramUsedGB != null ? eng.gpu.vramUsedGB : null,
        peakVramGB: s.memory ? s.memory.peakVramGB : null, ramFreeGB: s.memory ? s.memory.ramFreeGB : null
      },
      checkpoints: (s.checkpoints || []).map((c) => ({ step: c.step, file: c.file, sizeMB: c.sizeMB ?? null, at: c.at ?? null, added: c.added || null })),
      samples: (s.samples || []).map((x) => ({ step: x.step, i: x.i, file: x.file, kind: x.kind, prompt: x.prompt || '' })),
      nextSampleAt: s.nextSampleAt, waitingJobs: s.waitingJobs,
      notes: (s.notes || []).slice(-60),
      error: s.error ? { code: s.error.code, message: (s.error.message && (s.error.message[this.lang()] || s.error.message.fr)) || null } : null,
      logTail: s.logTail || [],
      lora: s.lora ? { file: s.lora.file, comfyName: s.lora.comfyName, trigger: s.lora.trigger, step: s.lora.step } : null,
      // finished, but the final LoRA could not be filed: why (mia_train_control add_to_loras tries again)
      notFiled: s.filed && s.filed.ok === false ? ((s.filed.message && (s.filed.message[this.lang()] || s.filed.message.fr)) || s.filed.code) : null,
      dir: s.dir
    };
  }

  /** One training read for an assistant; it is noted as watching (« CLAUDE REGARDE · IL Y A 2 MIN »). */
  async trainRead(t, id, client) {
    const s = await t.get(id ? String(id) : null, { watch: client });
    if (!s || s.ok === false) throw new BridgeError((s && s.error) || this.tr('noTrainer'));
    return s;
  }

  async trainStatus(params, client) {
    const t = await this.trainer();
    return this.trainView(await this.trainRead(t, params.trainingId, client));
  }

  /**
   * Waits for the next sample, the next checkpoint, the end, or any change of state — same contract as wait():
   * the state when it happened, or timedOut:true to call again.
   */
  async trainWait(params, client) {
    const t = await this.trainer();
    const until = params.until == null ? 'change' : String(params.until);
    if (!TRAIN_UNTIL.has(until)) this.fail('trainBadUntil');
    const timeoutS = Math.max(1, Math.min(WAIT_MAX_S, Number(params.timeoutS) || WAIT_DEFAULT_S));
    const first = await this.trainRead(t, params.trainingId, client);
    const id = first.trainingId;
    // what counts as « it moved »: never the step itself, it moves every few seconds
    const sig = (s) => [s.state, s.phase || '', s.pause ? s.pause.reason : '', (s.checkpoints || []).length, (s.samples || []).length,
      s.proposal ? 'p' : '', s.proposalEnd ? s.proposalEnd.state : '', s.error ? s.error.code : '', s.importing ? 'i' : ''].join('|');
    const over = (s) => TRAIN_ENDED.has(s.state) || (s.state === 'pause' && !(s.pause && s.pause.reason === 'pass'));
    const base = { sig: sig(first), samples: (first.samples || []).length, checkpoints: (first.checkpoints || []).length };
    const reached = (s) => (until === 'end' ? over(s)
      : until === 'sample' ? (s.samples || []).length > base.samples
        : until === 'checkpoint' ? (s.checkpoints || []).length > base.checkpoints
          : sig(s) !== base.sig);
    const peek = () => { try { const s = t.get(id); return s && s.ok !== false ? s : null; } catch { return null; } };
    let hit = reached(first);
    let ended = over(first);
    if (!hit && !(ended && until !== 'change')) {
      const deadline = Date.now() + timeoutS * 1000;
      await new Promise((resolve) => {
        let off = null;
        let poll = null;
        const done = () => { clearTimeout(timer); clearInterval(poll); if (typeof off === 'function') off(); resolve(); };
        const look = () => {
          const s = peek();
          if (!s) { done(); return; }                        // the training went to the Recycle Bin
          hit = reached(s);
          ended = over(s);
          // a sample or a checkpoint will never come from a training that ended: say so instead of waiting
          if (hit || (ended && until !== 'change')) done();
        };
        const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
        poll = setInterval(look, 1000);
        if (typeof t.onChange === 'function') off = t.onChange((changed) => { if (changed === id) look(); });
      });
    }
    const out = this.trainView(await this.trainRead(t, id, client));
    out.until = until;
    if (hit) out.reached = true;
    else if (ended && until !== 'change') { out.reached = false; out.ended = true; }
    else { out.timedOut = true; out.hint = this.tr('trainStill', { s: timeoutS }); }
    return out;
  }

  /** mia_train_prepare: full paths that exist, 300 images at most (its own check: checkPaths stops at 64). */
  checkTrainPaths(params) {
    const strip = (raw) => String(raw || '').trim().replace(/^"(.*)"$/, '$1');
    const images = Array.isArray(params.images) ? params.images : typeof params.images === 'string' ? [params.images] : [];
    const folder = typeof params.folder === 'string' ? strip(params.folder) : '';
    if (!images.length && !folder) {
      if (params.trainingId) { delete params.images; delete params.folder; return; }     // completing a draft: captions, settings
      this.fail('trainNoPaths');
    }
    if (images.length > TRAIN_IMPORT_MAX) this.fail('tooMany', { n: TRAIN_IMPORT_MAX });
    const clean = [];
    for (const raw of images) {
      const p = strip(raw);
      if (!path.isAbsolute(p)) this.fail('notAbs', { p });
      let st;
      try { st = fs.statSync(p); } catch { this.fail('notFound', { p }); }
      if (!st.isFile()) this.fail('notFile', { p });
      clean.push(path.normalize(p));
    }
    if (clean.length) params.images = clean; else delete params.images;
    if (folder) {
      if (!path.isAbsolute(folder)) this.fail('notAbs', { p: folder });
      let st;
      try { st = fs.statSync(folder); } catch { this.fail('notFound', { p: folder }); }
      if (!st.isDirectory()) this.fail('trainNotDir', { p: folder });
      let n = 0;
      try { n = fs.readdirSync(folder).filter((f) => TRAIN_IMAGE_EXT.has(path.extname(f).toLowerCase())).length; } catch { n = 0; }
      if (n + clean.length > TRAIN_IMPORT_MAX) this.fail('trainFolderMany', { n, max: TRAIN_IMPORT_MAX });
      params.folder = path.normalize(folder);
    } else delete params.folder;
    if (Array.isArray(params.captions) && params.captions.length > TRAIN_IMPORT_MAX) this.fail('tooMany', { n: TRAIN_IMPORT_MAX });
  }

  /**
   * mia_train_start. The page first says whether this assistant may act (green light, pause) and whether the
   * user's click is asked; then, here: a SUGGESTION written in train.json (the card of the window is drawn from
   * it, so it survives a reload) — or, « Demander mon feu vert » off, the start itself.
   */
  async trainStart(params, client) {
    const gate = await this.relay('train_start', params, client);
    if (!gate || !gate.ok) return gate || { ok: false, error: this.tr('notReady') };
    const t = await this.trainer();
    const id = params.trainingId ? String(params.trainingId) : '';
    if (!id) this.fail('trainNeedId');
    const resume = params.resume === true;
    const by = cleanClient((gate.result && gate.result.by) || client);
    const active = typeof t.active === 'function' ? t.active() : null;
    if (active) {
      const n = (x) => Math.round(+x || 0).toLocaleString(this.lang() === 'en' ? 'en-US' : 'fr-FR');
      this.fail('trainBusy', { name: active.doc.name, a: n(active.doc.step), b: n(active.doc.steps) });
    }
    const cur = await t.get(id);
    if (!cur || cur.ok === false) return { ok: false, error: (cur && cur.error) || this.tr('noTrainer') };
    if (!resume && cur.state === 'pret' && cur.ready === false) this.fail('trainNotReady', { why: cur.why || '?' });
    const ask = !(gate.result && gate.result.ask === false);
    if (ask) {
      const r = t.propose(id, { by, resume });
      if (!r || r.ok === false) return { ok: false, error: (r && r.error) || this.tr('noTrainer') };
      this.trainAsked.set(client, id);
      return { ok: true, result: { awaitingUser: true, trainingId: id, resume, note: this.tr(resume ? 'trainProposedResume' : 'trainProposed', { name: by }) } };
    }
    const r = await t.start(id, { resume, by });
    if (!r || r.ok === false) return { ok: false, error: (r && r.error) || this.tr('noTrainer') };
    this.trainAsked.set(client, id);
    return { ok: true, result: { started: true, trainingId: id, state: r.state, resumeFrom: r.resumeFrom || 0, note: this.tr('trainStarted') } };
  }

  /** mia_pending → training: what became of the training this assistant suggested starting. */
  async pendingWithTraining(params, client) {
    const out = await this.relay('pending', params, client);
    if (!out || !out.ok || !out.result || typeof out.result !== 'object') return out;
    let training = null;
    try {
      const t = this.ctx.trainer;
      const items = t && t.items instanceof Map ? [...t.items.values()] : [];
      const mine = this.trainAsked.get(client);
      // after a restart of Mia nobody remembers who asked: a suggestion still waiting is in train.json
      const item = items.find((it) => it.id === mine) || items.find((it) => it.doc && it.doc.proposal && it.doc.proposal.by === client);
      if (item && item.doc) {
        const d = item.doc;
        const state = d.proposal ? 'waiting' : d.proposalEnd ? d.proposalEnd.state : null;
        if (state) training = { trainingId: item.id, state, ...(state === 'started' ? { training: d.state } : {}) };
      }
    } catch { training = null; }
    out.result.training = training;
    return out;
  }

  checkPaths(params) {
    const list = Array.isArray(params.paths) ? params.paths : typeof params.paths === 'string' ? [params.paths] : [];
    if (!list.length) this.fail('noPaths');
    if (list.length > IMPORT_MAX) this.fail('tooMany', { n: IMPORT_MAX });
    const clean = [];
    for (const raw of list) {
      const p = String(raw || '').trim().replace(/^"(.*)"$/, '$1');
      if (!path.isAbsolute(p)) this.fail('notAbs', { p });
      let st;
      try { st = fs.statSync(p); } catch { this.fail('notFound', { p }); }
      if (!st.isFile()) this.fail('notFile', { p });
      clean.push(path.normalize(p));
    }
    params.paths = clean;
  }

  async snapshot(params, client) {
    try {
      return await this.takeSnapshot(params, client);
    } finally {
      this.notifyActivity('snapshot_done', client);       // the cursor may fade again
    }
  }

  async takeSnapshot(params, client) {
    const win = this.win();
    if (!win || win.isDestroyed()) this.fail('noWindow');
    const prep = await this.relay('snapshot_prepare', { nodeId: params.nodeId || null }, client, 15000);
    if (!prep || !prep.ok) return prep || { ok: false, error: this.tr('notReady') };
    const r = prep.result && prep.result.rect;
    const rect = r ? { x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) } : undefined;
    let img = null;
    // A visible window draws all the time: copy its last frame. A hidden one (tests) draws only now and
    // then: ask Chromium for a new frame, which also runs the board's pending drawing.
    if (!win.isVisible() || win.isMinimized()) {
      try { img = await this.captureViaDebugger(win.webContents, rect, 15000); } catch { img = null; }
    }
    if (!img || img.isEmpty()) try {
      if (typeof this.ctx.captureRect === 'function') {
        const got = await this.ctx.captureRect(rect);
        img = this.toImage(got);
      }
      if (!img || img.isEmpty()) img = await win.webContents.capturePage(rect);
      if (!img || img.isEmpty()) img = await this.captureViaDebugger(win.webContents, rect);
    } catch (e) {
      try { img = await this.captureViaDebugger(win.webContents, rect); } catch (e2) { return { ok: false, error: this.tr('snapFailed', { msg: e2.message || e.message }) }; }
    }
    if (!img || img.isEmpty()) return { ok: false, error: this.tr('snapFailed', { msg: 'image vide' }) };
    let size = img.getSize();
    if (size.width > SNAPSHOT_MAX_W) {
      img = img.resize({ width: SNAPSHOT_MAX_W, quality: 'good' });
      size = img.getSize();
    }
    return {
      ok: true,
      result: {
        image: { data: img.toPNG().toString('base64'), mimeType: 'image/png' },
        width: size.width, height: size.height,
        nodeId: params.nodeId || null,
        view: prep.result.view || null,
        board: prep.result.board || prep.result.project || null
      }
    };
  }

  toImage(got) {
    const { nativeImage } = require('electron');
    if (!got) return null;
    if (Buffer.isBuffer(got)) return nativeImage.createFromBuffer(got);
    if (typeof got.isEmpty === 'function') return got;
    if (got.image) return this.toImage(got.image);
    if (typeof got === 'string') return nativeImage.createFromBuffer(Buffer.from(got.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
    return null;
  }

  /** A hidden or minimised window can capture empty: ask Chromium itself. */
  async captureViaDebugger(wc, rect, timeoutMs = 6000) {
    const { nativeImage } = require('electron');
    const dbg = wc.debugger;
    let mine = false;
    if (!dbg.isAttached()) { dbg.attach('1.3'); mine = true; }
    try {
      const opts = { format: 'png', captureBeyondViewport: false };
      if (rect) opts.clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 };
      // never hang the assistant on a page that draws nothing: a few seconds, then the other ways
      let timer = null;
      const r = await Promise.race([
        dbg.sendCommand('Page.captureScreenshot', opts),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('capture timeout')), timeoutMs); })
      ]).finally(() => clearTimeout(timer));
      return nativeImage.createFromBuffer(Buffer.from(r.data, 'base64'));
    } finally {
      if (mine) { try { dbg.detach(); } catch { /* already */ } }
    }
  }
}

/** main.js: require('./bridge').register(ctx) — after the scanner and the engine. */
function register(ctx) {
  const bridge = new Bridge(ctx);
  ctx.bridge = bridge;
  bridge.start().catch(() => {});
  return bridge;
}

module.exports = { register, Bridge, _internals: { cleanClient, fill, folderIdOf } };
