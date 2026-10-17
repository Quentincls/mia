'use strict';
/**
 * Mia — media import (SPEC §5 media:*, §3.2 import block data).
 *
 * An import copies the ORIGINAL into <project>\media\ (never re-encoded: it feeds the AI), probes it,
 * and prepares what the board needs to show it fast:
 *   - videos: a poster (first frame, 640 px wide) in cache\<file>.poster.jpg;
 *   - images Chromium cannot show (tif, exr, psd…): a PNG preview in cache\<file>.preview.png,
 *     handed back as `poster`;
 *   - videos Chromium cannot play (ProRes, DNxHR, AVI…): a proxy cache\<file>.proxy.mp4, encoded in
 *     the background by a single-worker queue; `media:proxy` is sent when it is ready;
 *   - sounds (wav, mp3, m4a, flac…, for the Son block): their waveform in cache\<file>.wave.png, as `poster`.
 * Paths in the returned data are relative to the project, with "/" (SPEC §3.3).
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const STR = {
  unsupported: { fr: '« {name} » : format non pris en charge.', en: '“{name}”: unsupported format.' },
  folder: { fr: '« {name} » est un dossier : dépose les fichiers eux-mêmes.', en: '“{name}” is a folder: drop the files themselves.' },
  notFound: { fr: '« {name} » est introuvable.', en: '“{name}” cannot be found.' },
  copyFailed: { fr: '« {name} » n’a pas pu être copié : {msg}', en: '“{name}” could not be copied: {msg}' },
  empty: { fr: 'Le contenu collé est vide.', en: 'The pasted content is empty.' },
  noProject: { fr: 'Projet introuvable (dossier déplacé ou supprimé ?).', en: 'Project not found (folder moved or deleted?).' },
  pasteName: { fr: 'collage', en: 'paste' },
  pickTitle: { fr: 'Importer des médias', en: 'Import media' },
  pickFolderTitle: { fr: 'Choisir un dossier', en: 'Choose a folder' },
  filterImages: { fr: 'Images', en: 'Images' },
  filterVideos: { fr: 'Vidéos', en: 'Videos' },
  filterMedia: { fr: 'Images, vidéos et sons', en: 'Images, videos and sounds' },
  filterAudio: { fr: 'Sons', en: 'Sounds' },
  filterLut: { fr: 'LUT 3D (.cube)', en: '3D LUT (.cube)' },
  pickLutTitle: { fr: 'Choisir une LUT', en: 'Choose a LUT' },
  filterAll: { fr: 'Tous les fichiers', en: 'All files' }
};

/** Windows-safe file name, extension kept. */
function safeFileName(name, fallback) {
  let s = String(name || '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
  if (s.length > 120) {
    const ext = path.extname(s).slice(0, 12);
    s = s.slice(0, 120 - ext.length).trim() + ext;
  }
  return s || fallback;
}

const posix = (rel) => rel.split(path.sep).join('/');
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/**
 * @param {object} deps
 * @param {object} deps.store    electron/store.js
 * @param {object} deps.ffmpeg   electron/ffmpeg.js
 * @param {Function} deps.send   (channel, payload) → the window
 * @param {Function} deps.getWin () → BrowserWindow|null (parent of the fallback dialogs)
 * @param {Function} [deps.log]
 */
function createMedia({ store, ffmpeg, send, getWin, log = () => {} }) {
  const tr = store.tr;
  const userError = store.userError;

  /** The project folder, checked on disk (an import never recreates a folder that went away). */
  async function liveDir(projectId) {
    if (typeof store.requireLiveDir === 'function') return store.requireLiveDir(projectId);
    const dir = store.projectDir(projectId);
    if (!dir || !fs.existsSync(dir)) throw userError(tr(STR.noProject));
    return dir;
  }

  /** "clip.mp4", or "clip (2).mp4" if taken. Reserved with an exclusive create, so two imports never collide. */
  async function claimName(dir, base) {
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    for (let i = 1; i < 10000; i++) {
      const abs = path.join(dir, i === 1 ? base : `${stem} (${i})${ext}`);
      try {
        const fh = await fsp.open(abs, 'wx');
        await fh.close();
        return abs;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    throw userError(tr(STR.copyFailed, { name: base, msg: 'name' }));
  }

  const cacheRel = (file, suffix) => `cache/${file}${suffix}`;

  /**
   * Probe a file already inside <project>\media\ and build its import data.
   * @returns {{ok:true, data:object}}
   */
  async function describe(projectId, dir, abs, displayName) {
    const ext = path.extname(abs).toLowerCase();
    const file = path.basename(abs);
    const rel = posix(path.relative(dir, abs));
    const st = await fsp.stat(abs);
    let kind = ffmpeg.IMAGE_EXT.has(ext) ? 'image' : ffmpeg.AUDIO_EXT.has(ext) ? 'audio' : 'video';
    const meta = { w: 0, h: 0, fps: null, frames: kind === 'image' ? 1 : null, duration: null, codec: null, size: st.size, alpha: false };

    let info = null;
    try {
      info = await ffmpeg.probe(abs);
    } catch (e) {
      log('probe failed:', file, e.userMessage || e.message);
      // Without ffmpeg at all, trust the extension: Chromium may still show or play the file.
      // With ffmpeg, a file it cannot read is broken — except a plain png/jpg, which Chromium decodes itself.
      const noFfmpeg = !ffmpeg.ffmpegPath();
      if (!noFfmpeg && (kind !== 'image' || !ffmpeg.BROWSER_IMAGE_EXT.has(ext))) {
        throw userError(e.userMessage || tr(STR.unsupported, { name: displayName }));
      }
    }
    if (info) {
      kind = info.kind;
      Object.assign(meta, {
        w: info.w, h: info.h, fps: info.fps, frames: info.frames, duration: info.duration,
        codec: info.codec, pixfmt: info.pixfmt, alpha: info.alpha, hasAudio: info.hasAudio, playable: info.playable
      });
      if (kind === 'audio') Object.assign(meta, { sampleRate: info.sampleRate || null, channels: info.channels || null });
    }

    let poster = null;
    if (kind === 'audio') {
      try {
        await ffmpeg.waveform(abs, path.join(dir, 'cache', `${file}.wave.png`), { width: 1200, height: 160 });
        poster = cacheRel(file, '.wave.png');
      } catch (e) {
        log('waveform failed:', file, e.userMessage || e.message);
      }
    } else if (kind === 'video') {
      try {
        await ffmpeg.poster(abs, path.join(dir, 'cache', `${file}.poster.jpg`), { at: 0, width: 640 });
        poster = cacheRel(file, '.poster.jpg');
      } catch (e) {
        log('poster failed:', file, e.userMessage || e.message);
      }
    } else if (!ffmpeg.BROWSER_IMAGE_EXT.has(ext)) {
      try {
        await ffmpeg.previewImage(abs, path.join(dir, 'cache', `${file}.preview.png`), { maxSide: 2048 });
        poster = cacheRel(file, '.preview.png');
      } catch (e) {
        log('preview failed:', file, e.userMessage || e.message);
      }
    }

    const data = { src: rel, kind, name: displayName || file, meta, proxy: null, poster };
    if (kind === 'video' && info && !info.playable) queueProxy({ projectId, src: rel, poster, meta: info });
    return { ok: true, data };
  }

  /** Copy one file from anywhere into the project, then describe it. Never throws: {ok:false, error}. */
  async function importOne(projectId, dir, src) {
    const name = path.basename(String(src || ''));
    try {
      if (!src || typeof src !== 'string' || !path.isAbsolute(src)) throw userError(tr(STR.notFound, { name: name || '?' }));
      let st;
      try {
        st = await fsp.stat(src);
      } catch {
        throw userError(tr(STR.notFound, { name }));
      }
      if (st.isDirectory()) throw userError(tr(STR.folder, { name }));
      const ext = path.extname(src).toLowerCase();
      if (!ffmpeg.IMAGE_EXT.has(ext) && !ffmpeg.VIDEO_EXT.has(ext) && !ffmpeg.AUDIO_EXT.has(ext)) throw userError(tr(STR.unsupported, { name }));

      const mediaDir = path.join(dir, 'media');
      await fsp.mkdir(mediaDir, { recursive: true });
      let abs = src;
      const copied = !store.isInside(src, mediaDir);   // dropped again from the project itself: reuse it
      if (copied) {
        abs = await claimName(mediaDir, safeFileName(name, `media${ext}`));
        try {
          // CopyFileEx under the hood: streams, keeps the bytes exactly as they were
          await fsp.copyFile(src, abs);
        } catch (e) {
          await fsp.rm(abs, { force: true }).catch(() => {});
          throw userError(tr(STR.copyFailed, { name, msg: store.fsMessage(e) }), e);
        }
      }
      try {
        return await describe(projectId, dir, abs, name);
      } catch (e) {
        if (copied) await fsp.rm(abs, { force: true }).catch(() => {});   // our copy of a file we refuse
        throw e;
      }
    } catch (e) {
      log('import failed:', src, e.message);
      return { ok: false, error: e.userMessage || tr(STR.copyFailed, { name, msg: e.message }) };
    }
  }

  /**
   * In the board's own queue (store.withBoard: the one its saves, its moves and its project's renames
   * hold): a board moved or a project renamed meanwhile waits for the copies and the posters, instead
   * of leaving them in a folder that no longer exists (ffmpeg's mkdir -p would bring it back empty).
   */
  const inBoard = (projectId, fn) => (typeof store.withBoard === 'function' ? store.withBoard(projectId, fn) : fn());

  async function importPaths(projectId, paths) {
    await store.ready();
    const list = Array.isArray(paths) ? paths : [paths];
    return inBoard(projectId, async () => {
      let dir;
      try {
        dir = await liveDir(projectId);
      } catch (e) {
        return list.map(() => ({ ok: false, error: e.userMessage || tr(STR.noProject) }));
      }
      // three at a time: probing and posters are short, copies stream through the OS
      return store.mapLimit(list, 3, (p) => importOne(projectId, dir, p));
    });
  }

  /** A pasted image (clipboard bytes): written into media\, then described like any import. */
  async function importBuffer(projectId, name, bytes) {
    await store.ready();
    return inBoard(projectId, () => importBufferIn(projectId, name, bytes));
  }

  async function importBufferIn(projectId, name, bytes) {
    let dir;
    try {
      dir = await liveDir(projectId);
    } catch (e) {
      return { ok: false, error: e.userMessage || tr(STR.noProject) };
    }
    let buf;
    try {
      buf = Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
    } catch {
      buf = null;
    }
    if (!buf || !buf.length) return { ok: false, error: tr(STR.empty) };
    let base = safeFileName(name, '');
    // the clipboard calls every screenshot "image.png": a dated name is easier to find later
    if (!base || /^image\.(png|jpe?g|webp|bmp|gif)$/i.test(base)) {
      const ext = (base && path.extname(base).toLowerCase()) || '.png';
      base = `${tr(STR.pasteName)}-${stamp()}${ext}`;
    }
    if (!path.extname(base)) base += '.png';
    const ext = path.extname(base).toLowerCase();
    if (!ffmpeg.IMAGE_EXT.has(ext) && !ffmpeg.VIDEO_EXT.has(ext)) return { ok: false, error: tr(STR.unsupported, { name: base }) };
    try {
      const mediaDir = path.join(dir, 'media');
      await fsp.mkdir(mediaDir, { recursive: true });
      const abs = await claimName(mediaDir, base);
      try {
        await fsp.writeFile(abs, buf);
        return await describe(projectId, dir, abs, path.basename(abs));
      } catch (e) {
        await fsp.rm(abs, { force: true }).catch(() => {});
        throw e;
      }
    } catch (e) {
      log('paste failed:', e.message);
      return { ok: false, error: e.userMessage || tr(STR.copyFailed, { name: base, msg: store.fsMessage(e) }) };
    }
  }

  // ---------------------------------------------------------------- proxy queue
  // One ffmpeg at a time (FIFO): proxies are background comfort, they never compete with each
  // other nor with a GPU job for long. Jobs keep the project id, not the folder: a project
  // renamed meanwhile still gets its proxy.
  const queue = [];
  let busy = false;

  const jobKey = (j) => `${j.what || 'proxy'}|${j.projectId}|${j.src}`;

  function queueProxy(job) {
    const key = jobKey(job);
    if (queue.some((j) => jobKey(j) === key) || (busy && busy === key)) return;
    // a poster is quick and shows at once: before the long proxies
    if (job.what === 'poster') queue.unshift(job);
    else queue.push(job);
    pump();
  }

  /** A poster / preview deleted with cache\ (disposable), made again where graph.json expects it. */
  async function remakePoster(job, dir) {
    const src = path.join(dir, ...job.src.split('/'));
    const dst = path.join(dir, ...job.poster.split('/'));
    if (!store.isInside(dst, path.join(dir, 'cache'))) throw new Error('poster outside cache');
    if (job.kind === 'video') await ffmpeg.poster(src, dst, { at: 0, width: 640 });
    else if (job.kind === 'audio') await ffmpeg.waveform(src, dst, { width: 1200, height: 160 });
    else await ffmpeg.previewImage(src, dst, { maxSide: 2048 });
    log('poster made again:', job.poster);
    send('media:proxy', { projectId: job.projectId, src: job.src, poster: job.poster });
  }

  async function pump() {
    if (busy) return;
    const job = queue.shift();
    if (!job) return;
    busy = jobKey(job);
    if (job.what === 'poster') {
      try {
        const dir = store.projectDir(job.projectId);
        if (!dir) throw new Error('project gone');
        await remakePoster(job, dir);
      } catch (e) {
        log('poster not made again:', job.src, e.message);
      } finally {
        busy = false;
        setImmediate(pump);
      }
      return;
    }
    const file = job.src.split('/').pop();
    const rel = cacheRel(file, '.proxy.mp4');
    try {
      const dir = store.projectDir(job.projectId);
      if (!dir) throw new Error('project gone');
      const src = path.join(dir, ...job.src.split('/'));
      const dst = path.join(dir, 'cache', `${file}.proxy.mp4`);
      const t0 = Date.now();
      const r = await ffmpeg.proxy(src, dst, { maxSide: 1920, gop: 12, meta: job.meta });
      log('proxy ready:', rel, `${r.w}x${r.h}`, r.encoder, `${Date.now() - t0} ms`);
      send('media:proxy', { projectId: job.projectId, src: job.src, proxy: rel, poster: job.poster || null });
    } catch (e) {
      log('proxy failed:', job.src, e.message);
      send('media:proxy', { projectId: job.projectId, src: job.src, proxy: null, poster: job.poster || null, error: e.userMessage || e.message });
    } finally {
      busy = false;
      setImmediate(pump);
    }
  }

  /**
   * On project open, for every import block:
   *   - its original is gone from media\ (deleted in Explorer): `data._missing = true` — a display
   *     cache (the "_" keeps it out of graph.json), so the block can say « fichier introuvable »
   *     instead of « lecture impossible » and nothing downstream runs on a file that is not there;
   *   - a proxy that finished after its project was closed is adopted; one that never got made
   *     (app closed mid-encode) or was deleted with the cache folder is queued again;
   *   - a poster / preview deleted with the cache folder is made again (cache\ is disposable).
   * Mutates the graph about to be sent to the window (it is saved with the next change).
   */
  function reconcileGraph(projectId, dir, graph) {
    if (!graph || !Array.isArray(graph.nodes)) return graph;
    const inProject = (rel) => typeof rel === 'string' && rel && fs.existsSync(path.join(dir, ...rel.split('/')));
    for (const n of graph.nodes) {
      const d = n && n.type === 'import' ? n.data : null;
      if (!d || typeof d.src !== 'string' || !d.src) continue;
      if (!inProject(d.src)) {
        d._missing = true;
        continue;
      }
      if (d._missing) delete d._missing;
      const file = d.src.split('/').pop();
      if (d.poster && !inProject(d.poster)) queueProxy({ projectId, src: d.src, poster: d.poster, meta: null, what: 'poster', kind: d.kind });
      if (d.kind !== 'video') continue;
      if (d.proxy && !inProject(d.proxy)) d.proxy = null;
      if (d.proxy) continue;
      if (fs.existsSync(path.join(dir, 'cache', `${file}.proxy.mp4`))) {
        d.proxy = cacheRel(file, '.proxy.mp4');
      } else if (d.meta && d.meta.playable === false) {
        queueProxy({ projectId, src: d.src, poster: d.poster || null, meta: null });
      }
    }
    return graph;
  }

  // ---------------------------------------------------------------- fallback dialogs
  // The Windows file dialog only as a fallback (SPEC §0): drag-and-drop and paste come first.
  const EXT = {
    image: [...ffmpeg.IMAGE_EXT].map((e) => e.slice(1)),
    video: [...ffmpeg.VIDEO_EXT].map((e) => e.slice(1)),
    audio: [...ffmpeg.AUDIO_EXT].map((e) => e.slice(1))
  };

  /** kind: 'image' | 'video' | 'audio' | 'media' (all three) | 'lut' (a .cube for the Finition block). */
  async function pick(opts) {
    const { dialog } = require('electron');
    const kind = (opts && opts.kind) || 'media';
    const filters = [];
    if (kind === 'image') filters.push({ name: tr(STR.filterImages), extensions: EXT.image });
    else if (kind === 'video') filters.push({ name: tr(STR.filterVideos), extensions: EXT.video });
    else if (kind === 'audio') filters.push({ name: tr(STR.filterAudio), extensions: EXT.audio });
    else if (kind === 'lut') filters.push({ name: tr(STR.filterLut), extensions: ['cube'] });
    else filters.push({ name: tr(STR.filterMedia), extensions: [...EXT.image, ...EXT.video, ...EXT.audio] });
    filters.push({ name: tr(STR.filterAll), extensions: ['*'] });
    const win = getWin();
    const r = await dialog.showOpenDialog(win || undefined, {
      title: tr(kind === 'lut' ? STR.pickLutTitle : STR.pickTitle),
      properties: ['openFile', ...(opts && opts.multiple === false ? [] : ['multiSelections'])],
      filters
    });
    return r.canceled ? [] : r.filePaths;
  }

  async function pickFolder(opts) {
    const { dialog } = require('electron');
    const win = getWin();
    const r = await dialog.showOpenDialog(win || undefined, {
      title: (opts && opts.title) || tr(STR.pickFolderTitle),
      defaultPath: opts && typeof opts.defaultPath === 'string' ? opts.defaultPath : undefined,
      properties: ['openDirectory', 'createDirectory']
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  }

  return {
    importPaths,
    importBuffer,
    pick,
    pickFolder,
    reconcileGraph,
    proxyQueue: () => ({ busy: !!busy, waiting: queue.length })
  };
}

module.exports = { createMedia, safeFileName };
