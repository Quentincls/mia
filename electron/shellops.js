'use strict';
/**
 * Mia — file actions toward Windows: show in Explorer, open with the default app, copy the path,
 * Recycle Bin, and dragging a result out of Mia (to Explorer, DaVinci, Premiere…).
 *
 * The window never receives the `shell` API itself: it names a target and the main process resolves
 * it to a CHECKED absolute path —
 *   { projectId, rel }  a file of a project (must stay inside the project folder)
 *   { projectId }       the project folder itself
 *   { folderId, rel? }  a project of boards (SPEC §18: « projet » = folder of boards), or a file in it
 *   { abs }             a file outside projects, only under projectsRoot, engineRoot, %APPDATA%\Mia,
 *                       an extra model root or a LoRA folder (same rule as mia://m/…) — or a model
 *                       the scanner itself listed (ownsPath: MiniMax on C:, LocalMesh, deep-search finds)
 *
 * Nothing that runs code is ever opened with its default app (exe, bat, ps1, lnk…): shown in
 * Explorer instead.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const STR = {
  badTarget: { fr: 'Chemin invalide.', en: 'Invalid path.' },
  outside: { fr: 'Ce chemin est hors des dossiers de Mia.', en: 'This path is outside Mia’s folders.' },
  noProject: { fr: 'Planche introuvable.', en: 'Board not found.' },
  noFolder: { fr: 'Projet introuvable.', en: 'Project not found.' },
  missing: { fr: 'Fichier introuvable : {path}', en: 'File not found: {path}' },
  openFailed: { fr: 'Impossible d’ouvrir « {name} » : {msg}', en: 'Could not open “{name}”: {msg}' },
  noApp: { fr: 'aucune application associée à ce type de fichier', en: 'no application is associated with this file type' },
  trashFailed: { fr: 'Impossible de mettre « {name} » à la corbeille : {msg}', en: 'Could not move “{name}” to the Recycle Bin: {msg}' }
};

// Files that run code when "opened": never handed to shell.openPath, whatever folder they are in.
const RUNS_CODE = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|pif|lnk|url|reg|hta|cpl|jar|appref-ms|settingcontent-ms)$/i;

/**
 * @param {object} deps { store, log, ownsPath?(abs) → bool }
 *   ownsPath: the scanner's ctx.models.owns — a model of the inventory outside Mia's folders
 */
function createShellOps({ store, log = () => {}, ownsPath = null }) {
  const tr = store.tr;
  const userError = store.userError;

  const owned = (abs) => {
    try {
      return typeof ownsPath === 'function' && !!ownsPath(abs);
    } catch {
      return false;
    }
  };

  /** A target from the window → an absolute path we agree to act on. Throws a readable error. */
  function resolveTarget(target) {
    const t = target && typeof target === 'object' ? target : null;
    if (!t) throw userError(tr(STR.badTarget));
    if (typeof t.abs === 'string' && t.abs) {
      if (!path.isAbsolute(t.abs) || t.abs.includes('\0')) throw userError(tr(STR.badTarget));
      const abs = path.resolve(t.abs);
      const inRoots = store.allowedRoots().some((r) => abs.toLowerCase() === path.resolve(r).toLowerCase() || store.isInside(abs, r));
      if (!inRoots && !owned(abs)) throw userError(tr(STR.outside));
      return abs;
    }
    if (typeof t.projectId === 'string') {
      const dir = store.projectDir(t.projectId);
      if (!dir) throw userError(tr(STR.noProject));
      if (t.rel == null || t.rel === '') return dir;
      const parts = String(t.rel).split(/[\\/]+/).filter(Boolean);
      const abs = path.resolve(dir, ...parts);
      if (!store.isInside(abs, dir)) throw userError(tr(STR.badTarget));
      return abs;
    }
    if (typeof t.folderId === 'string') {
      const dir = typeof store.folderDir === 'function' ? store.folderDir(t.folderId) : null;
      if (!dir) throw userError(tr(STR.noFolder));
      if (t.rel == null || t.rel === '') return dir;
      const parts = String(t.rel).split(/[\\/]+/).filter(Boolean);
      const abs = path.resolve(dir, ...parts);
      if (!store.isInside(abs, dir)) throw userError(tr(STR.badTarget));
      return abs;
    }
    throw userError(tr(STR.badTarget));
  }

  /** Explorer with the file selected; a missing file falls back to its nearest existing folder. */
  async function reveal(target) {
    const abs = resolveTarget(target);
    const { shell } = require('electron');
    if (fs.existsSync(abs)) {
      if (fs.statSync(abs).isDirectory() && !target.rel) {
        const err = await shell.openPath(abs);   // a folder asked for itself: open it, not its parent
        if (err) throw userError(tr(STR.openFailed, { name: path.basename(abs), msg: err }));
      } else {
        shell.showItemInFolder(abs);
      }
      return { ok: true, path: abs };
    }
    let dir = path.dirname(abs);
    while (dir && !fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    if (!fs.existsSync(dir)) throw userError(tr(STR.missing, { path: abs }));
    await shell.openPath(dir);
    return { ok: true, path: dir, fallback: true };
  }

  /** The board folder itself, opened in Explorer (SPEC projects:reveal). */
  async function revealProject(id) {
    return reveal({ projectId: id });
  }

  /** A project (folder of boards) opened in Explorer (SPEC §18.2 folders:reveal). */
  async function revealFolder(id) {
    return reveal({ folderId: id });
  }

  /** Open with the application Windows associates with the file. */
  async function openPath(target) {
    const abs = resolveTarget(target);
    if (!fs.existsSync(abs)) throw userError(tr(STR.missing, { path: abs }));
    const { shell } = require('electron');
    if (RUNS_CODE.test(abs) && !fs.statSync(abs).isDirectory()) {
      log('openPath of a program refused, shown in Explorer:', abs);
      shell.showItemInFolder(abs);
      return { ok: true, path: abs, revealed: true };
    }
    const err = await shell.openPath(abs);   // '' on success, else a system message (in English)
    if (err) {
      log('openPath failed:', abs, err);
      const msg = /no application|association/i.test(err) ? tr(STR.noApp) : err;
      throw userError(tr(STR.openFailed, { name: path.basename(abs), msg }));
    }
    return { ok: true, path: abs };
  }

  /** The Windows path (with backslashes) on the clipboard, ready for Unreal, Resolve or a terminal. */
  function copyPath(target) {
    const abs = resolveTarget(target);
    require('electron').clipboard.writeText(abs);
    return { ok: true, path: abs };
  }

  /** Recycle Bin, never a hard delete. */
  async function trash(abs) {
    try {
      await require('electron').shell.trashItem(abs);
      return { ok: true };
    } catch (e) {
      throw userError(tr(STR.trashFailed, { name: path.basename(abs), msg: store.fsMessage(e) }), e);
    }
  }

  /**
   * A real file drag out of the window (webContents.startDrag). Windows wants a non-empty icon:
   * the file itself when it is a small picture, the poster when the caller names one, else Mia's icon.
   */
  async function startDrag(sender, target) {
    const { nativeImage } = require('electron');
    let abs;
    try {
      abs = resolveTarget(target);
    } catch (e) {
      log('drag refused:', e.message);
      return;
    }
    if (!fs.existsSync(abs)) return;
    let icon = null;
    const tryIcon = (p) => {
      try {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) icon = img.resize({ width: 96 });
      } catch { /* not a picture */ }
    };
    if (target.poster) {
      try { tryIcon(resolveTarget({ projectId: target.projectId, rel: target.poster })); } catch { /* ignore */ }
    }
    if (!icon && /\.(png|jpe?g|bmp)$/i.test(abs)) {
      const st = await fsp.stat(abs).catch(() => null);
      if (st && st.size < 24 * 1024 * 1024) tryIcon(abs);
    }
    if (!icon) tryIcon(path.join(__dirname, '..', 'src', 'assets', 'icon.png'));
    if (!icon) icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==');
    try {
      sender.startDrag({ file: abs, icon });
    } catch (e) {
      log('startDrag failed:', e.message);
    }
  }

  return { resolveTarget, reveal, revealProject, revealFolder, openPath, copyPath, trash, startDrag };
}

module.exports = { createShellOps };
