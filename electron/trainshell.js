'use strict';
// What Windows shows of a LoRA training, outside Mia's own window (main process, wired by main.js):
// - the taskbar icon carries the progress while a training is active (waiting for the GPU or preparing: the
//   moving bar; paused to let a job through: the paused colour), turns to the error colour when it ends in error
//   until Quentin has opened that training, and is cleared otherwise;
// - the taskbar button flashes when a training ends (done, error, interrupted) while Mia is not in front;
// - the PC does not go to sleep by itself while a training is active (powerSaveBlocker 'prevent-app-suspension';
//   the screen may still turn off); given back at a pause by hand, at the end, at an error, and when Mia closes
//   (release(), called by main.js before the window goes).
// No text here: nothing of this is written anywhere.

const ENDED = new Set(['fini', 'erreur', 'interrompu']);

/**
 * trainer: {brief() → the active training or null, item(id) → {doc} | null}.
 * getWin() → the BrowserWindow or null. powerSaveBlocker: Electron's. headless: a test window is never flashed.
 * → {update(), focused(), release(), state()}.
 */
function createTrainShell({ trainer, getWin, powerSaveBlocker, headless = false, log = () => {} }) {
  let blocker = null;        // id given by powerSaveBlocker.start
  let activeId = null;       // the training that was active at the last update
  let errorId = null;        // ended in error, not opened yet: the icon stays in the error colour
  let bar = '';              // last thing written on the icon (nothing is sent twice)
  let flashing = false;
  let released = false;      // release() was called: Mia is closing

  const win = () => {
    try {
      const w = typeof getWin === 'function' ? getWin() : null;
      return w && !(typeof w.isDestroyed === 'function' && w.isDestroyed()) ? w : null;
    } catch { return null; }
  };
  const docOf = (id) => {
    try {
      const it = id && typeof trainer.item === 'function' ? trainer.item(id) : null;
      return it && !it.missing ? it.doc : null;
    } catch { return null; }
  };

  function setBar(progress, mode) {
    const key = `${mode}|${mode === 'normal' || mode === 'paused' ? Math.round(progress * 1000) : ''}`;
    if (key === bar) return;
    const w = win();
    if (!w || typeof w.setProgressBar !== 'function') return;      // no window yet: written at the next change
    try {
      if (mode === 'none') w.setProgressBar(-1);
      else w.setProgressBar(progress, { mode });
      bar = key;
    } catch (e) { log('taskbar progress:', e.message); }
  }

  function flash(on) {
    if (headless || flashing === on) return;
    const w = win();
    if (!w || typeof w.flashFrame !== 'function') return;
    if (on && typeof w.isFocused === 'function' && w.isFocused()) return;     // Quentin is looking at Mia
    try { w.flashFrame(on); flashing = on; } catch (e) { log('taskbar flash:', e.message); }
  }

  function awake(on) {
    if (!powerSaveBlocker) return;
    try {
      if (on && blocker == null) blocker = powerSaveBlocker.start('prevent-app-suspension');
      else if (!on && blocker != null) {
        if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
        blocker = null;
      }
    } catch (e) { log('sleep blocker:', e.message); }
  }

  /** Called at every change of a training (trainer.onChange), once at start, and when the window is ready. */
  function update() {
    if (released) return;                     // Mia is closing: nothing comes back on
    let b = null;
    try { b = trainer.brief(); } catch (e) { log('brief:', e.message); }
    awake(!!b);

    // the training that was active is not any more: how did it end?
    if (activeId && (!b || b.id !== activeId)) {
      const d = docOf(activeId);
      if (d && ENDED.has(d.state)) {
        flash(true);
        if (d.state === 'erreur' && d.seen === false) errorId = activeId;
      }
    }
    activeId = b ? b.id : null;
    if (errorId) {
      const d = docOf(errorId);
      if (!d || d.state !== 'erreur' || d.seen !== false) errorId = null;       // opened, resumed, or thrown away
    }

    if (b) {
      const p = Math.max(0, Math.min(1, Number(b.progress) || 0));
      if (b.state === 'attente' || b.state === 'preparation') setBar(2, 'indeterminate');
      else if (b.state === 'pause') setBar(p, 'paused');
      else setBar(p, 'normal');
    } else if (errorId) setBar(1, 'error');
    else setBar(0, 'none');
  }

  /** The window came to the front: it stops flashing. */
  function focused() { flash(false); }

  /**
   * Mia is closing (main.js, finishClose, before the window goes): the PC may sleep again, the icon is
   * cleared — even when the training could not be stopped in time. Later changes are ignored.
   */
  function release() {
    if (released) return;
    awake(false);
    setBar(0, 'none');
    flash(false);
    released = true;
  }

  return { update, focused, release, state: () => ({ blocker, activeId, errorId, bar, flashing, released }) };
}

module.exports = { createTrainShell };
