'use strict';
/**
 * Mia — the bridge between the window and the main process: `window.mia` (SPEC §5).
 *
 * Every call returns a promise. Arguments are forwarded AS GIVEN to ipcMain.handle, so a handler
 * is written with the same parameters as the API: mia.engine.runs(projectId, nodeId) arrives as
 * handle('engine:runs', (e, projectId, nodeId) => …). Expected failures come back as
 * { ok:false, error:"readable French sentence" }.
 *
 * One table of channel names below — main.js reads it in --dev to report any channel nobody
 * handles (Slate once lost drag-and-drop to a name that existed on one side only).
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

/* channels:invoke:begin */
const INVOKE = {
  win: {
    minimize: 'win:minimize',
    toggleMaximize: 'win:toggleMaximize',
    close: 'win:close',
    isMaximized: 'win:isMaximized',
    toggleFullscreen: 'win:toggleFullscreen',
    setTitlebarMenuGuard: 'win:titlebarMenuGuard'
  },
  app: {
    info: 'app:info',
    reload: 'app:reload',
    engineCheck: 'app:engineCheck'   // ({root?}) → {usable, current, candidates, comfy, suggest, suggestDir} (SPEC §21.3)
  },
  prefs: {
    get: 'prefs:get',
    set: 'prefs:set'
  },
  projects: {
    list: 'projects:list',
    status: 'projects:status',       // {root, rootMissing, code, message}: folder unreachable?
    create: 'projects:create',
    rename: 'projects:rename',
    duplicate: 'projects:duplicate',
    remove: 'projects:remove',
    reveal: 'projects:reveal',
    open: 'projects:open',
    save: 'projects:save',
    thumb: 'projects:thumb',         // (id, {thumbRect}) → {ok, thumb, url}: only the home picture, now
    move: 'projects:move'            // (boardId, folderId|null) → board meta; refused while a job runs
  },
  // SPEC §18: a « projet » is a folder of boards (« planches »); mia.projects.* stays the boards
  folders: {
    list: 'folders:list',            // () → [{id, name, color, dir, created, updated, boards, thumbs}]
    create: 'folders:create',        // ({name, color?}) → {ok, id, name, color…}
    rename: 'folders:rename',        // (id, name) — the folder on disk is renamed too
    setColor: 'folders:setColor',    // (id, color) grey|blue|teal|green|yellow|orange|red|pink
    remove: 'folders:remove',        // (id, {keepBoards:true|false}) → {ok, moved, trashed}
    reveal: 'folders:reveal'         // (id): the project folder in Explorer
  },
  media: {
    importPaths: 'media:importPaths',
    importBuffer: 'media:importBuffer',
    pick: 'media:pick',
    pickFolder: 'media:pickFolder'
  },
  shell: {
    reveal: 'shell:reveal',
    openPath: 'shell:openPath',
    copyPath: 'shell:copyPath'
  },
  models: {
    list: 'models:list',
    scan: 'models:scan',
    inspect: 'models:inspect',       // (path) → {ok, isLora, family, …} (SPEC §12.3)
    addLora: 'models:addLora',       // ({path, name, trigger, kind}) → entry
    updateLora: 'models:updateLora', // (id, {name, trigger, kind})
    removeLora: 'models:removeLora'  // (id)
  },
  engine: {
    status: 'engine:status',
    run: 'engine:run',
    cancel: 'engine:cancel',
    jobs: 'engine:jobs',
    startComfy: 'engine:startComfy',
    runs: 'engine:runs',
    deleteRun: 'engine:deleteRun',
    looks: 'engine:looks'            // () → [{id, exists, lab}] : Finish looks present on this PC
  },
  // SPEC §21.4: install the missing models (one download at a time, resumable), and Mia's engine (§21.3)
  installer: {
    list: 'installer:list',          // () → {files, caps, queue, token, free, modelsDir, engineReady}
    start: 'installer:start',        // ({keys?, caps?, option?:{cap,id}}) → {ok, queued, skipped}
    pause: 'installer:pause',        // (key?) — without a key, everything
    cancel: 'installer:cancel',      // (key? | {engine:true}) — the part already downloaded is removed
    clear: 'installer:clear',        // () forget the finished and failed lines
    status: 'installer:status',      // () → {queue, active, left, engine}
    engine: 'installer:engine'       // ({dir, dryRun}) runs engine-setup/install-engine.ps1
  },
  bridge: {
    status: 'bridge:status'          // the assistant bridge (SPEC §13): {running, port, client…}
  },
  // SPEC §23.3: online accounts (Higgsfield). The key goes in once (setKey) and never comes back to the window.
  cloud: {
    status: 'cloud:status',          // () → {linked, provider, since, keyTail, crypto}
    setKey: 'cloud:setKey',          // (« ID:SECRET ») → {ok, error?, status?} — checked, then kept encrypted
    removeKey: 'cloud:removeKey',    // () → {ok, status}
    check: 'cloud:check',            // () → {ok, error?} — a free call to Higgsfield
    budget: 'cloud:budget',          // ({fresh}?) → {linked, currency, month, topUp, sinceTopUp, left, at} | {…, error}
    setTopUp: 'cloud:setTopUp'       // ({amount, at?} | null) → {ok, topUp?, error?} — the last top-up, for « left »
  }
};
/* channels:invoke:end */

// main → window events, and window → main one-way messages
const EVENTS = {
  winState: 'win:state',             // {maximized, fullscreen, focused}
  titlebarMenu: 'win:titlebarMenu',  // {x, y}: right-click on the title bar (Windows' own menu is blocked)
  flush: 'app:flush',                // {activeJobs}: the window is closing: save, then answer `flushed`
  proxy: 'media:proxy',              // {projectId, src, proxy, poster, error?}
  foldersChanged: 'folders:changed', // {reason, reasons, folders, projects}: projects or boards created, moved…
  modelsUpdate: 'models:update',
  modelsProgress: 'models:progress',
  engineStatus: 'engine:status',
  engineEvent: 'engine:event',
  bridgeCall: 'bridge:call',         // {id, method, params, client}: an assistant asks the interface
  installerProgress: 'installer:progress'   // {kind:'job'|'queue'|'engine', job?, status?, line?, p?, state?}
};
const SEND = {
  flushed: 'app:flushed',
  startDrag: 'shell:startDrag',
  bridgeReply: 'bridge:reply'        // (id, payload): the interface's answer to a bridge:call
};

/** Subscribe; returns the function that unsubscribes. A throwing callback never breaks the others. */
function listen(channel, cb) {
  if (typeof cb !== 'function') return () => {};
  const h = (_e, payload) => {
    try {
      cb(payload);
    } catch (err) {
      console.error(`[mia] ${channel} listener failed`, err);
    }
  };
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}

/** { name: channel } → { name: (...args) => invoke(channel, ...args) } */
function invokers(table) {
  const out = {};
  for (const [name, channel] of Object.entries(table)) {
    out[name] = (...args) => ipcRenderer.invoke(channel, ...args);
  }
  return out;
}

const mia = {
  win: Object.assign(invokers(INVOKE.win), {
    onState: (cb) => listen(EVENTS.winState, cb),
    onFlush: (cb) => listen(EVENTS.flush, cb),
    // no argument: saved, let the window go. {hold:true}: asking Quentin (the wait grows to 5 min),
    // then {quit:true} to quit or {cancel:true} to keep Mia open (a job is running).
    flushed: (answer) => ipcRenderer.send(SEND.flushed, answer && typeof answer === 'object' ? answer : undefined),
    // the title bar's right-click menu: Windows' system menu is always blocked by the main
    // process; pass a callback to show Mia's own menu at {x, y} instead
    setTitlebarMenuGuard: (cb) => {
      const off = typeof cb === 'function' ? listen(EVENTS.titlebarMenu, cb) : () => {};
      ipcRenderer.invoke(INVOKE.win.setTitlebarMenuGuard).catch(() => {});
      return off;
    },
    onTitlebarMenu: (cb) => listen(EVENTS.titlebarMenu, cb)
  }),
  app: invokers(INVOKE.app),
  cloud: invokers(INVOKE.cloud),
  installer: Object.assign(invokers(INVOKE.installer), {
    onProgress: (cb) => listen(EVENTS.installerProgress, cb)
  }),
  prefs: invokers(INVOKE.prefs),
  projects: Object.assign(invokers(INVOKE.projects), {
    onFoldersChanged: (cb) => listen(EVENTS.foldersChanged, cb)
  }),
  folders: Object.assign(invokers(INVOKE.folders), {
    onChanged: (cb) => listen(EVENTS.foldersChanged, cb),
    onFoldersChanged: (cb) => listen(EVENTS.foldersChanged, cb)
  }),
  // same event, at the top for whoever looks for it there
  onFoldersChanged: (cb) => listen(EVENTS.foldersChanged, cb),
  media: Object.assign(invokers(INVOKE.media), {
    // Electron 32+: the only reliable way to get the real path of a File dropped from Explorer
    pathFor: (file) => {
      try {
        return webUtils.getPathForFile(file) || '';
      } catch {
        return '';
      }
    },
    onProxy: (cb) => listen(EVENTS.proxy, cb)
  }),
  shell: Object.assign(invokers(INVOKE.shell), {
    // drag a result out of Mia as a real file (Explorer, DaVinci…); call it from a dragstart
    startDrag: (target) => ipcRenderer.send(SEND.startDrag, target)
  }),
  models: Object.assign(invokers(INVOKE.models), {
    onUpdate: (cb) => listen(EVENTS.modelsUpdate, cb),
    onProgress: (cb) => listen(EVENTS.modelsProgress, cb)
  }),
  engine: Object.assign(invokers(INVOKE.engine), {
    onStatus: (cb) => listen(EVENTS.engineStatus, cb),
    onEvent: (cb) => listen(EVENTS.engineEvent, cb)
  }),
  // SPEC §13: an assistant (Claude, Codex) drives Mia; the interface runs what is relayed to it
  bridge: Object.assign(invokers(INVOKE.bridge), {
    onCall: (cb) => listen(EVENTS.bridgeCall, cb),
    reply: (id, payload) => ipcRenderer.send(SEND.bridgeReply, id, payload)
  })
};

contextBridge.exposeInMainWorld('mia', mia);
