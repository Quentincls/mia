/**
 * The app-wide event bus (SPEC §6.2).
 *
 * One flat map of event name → listeners. Modules talk through it instead of
 * importing each other, so the shell keeps working when one of them fails to
 * load. A listener that throws is reported and skipped: one broken module
 * must never stop the others from hearing an event.
 */

const listeners = new Map();   // evt → Set<fn>

/** Listen to `evt`. Returns the function that stops listening. */
export function on(evt, fn) {
  if (typeof fn !== 'function') return () => {};
  let set = listeners.get(evt);
  if (!set) listeners.set(evt, (set = new Set()));
  set.add(fn);
  return () => off(evt, fn);
}

export function off(evt, fn) {
  const set = listeners.get(evt);
  if (!set) return;
  set.delete(fn);
  if (!set.size) listeners.delete(evt);
}

/** Listen once; the listener is removed before it runs. */
export function once(evt, fn) {
  const wrap = (payload) => { off(evt, wrap); return fn(payload); };
  return on(evt, wrap);
}

/** Fire and forget: every listener runs synchronously, in subscription order. */
export function emit(evt, payload) {
  const set = listeners.get(evt);
  if (!set) return;
  // a copy: a listener may unsubscribe (or subscribe) while we iterate
  for (const fn of [...set]) {
    try {
      const r = fn(payload);
      if (r && typeof r.catch === 'function') r.catch((err) => report(evt, err));
    } catch (err) {
      report(evt, err);
    }
  }
}

/**
 * Like emit, but waits for the listeners that return a promise — used where
 * the caller must not go on before everyone is done (save before reload).
 * Failures are reported, never thrown back at the caller.
 */
export async function emitAsync(evt, payload) {
  const set = listeners.get(evt);
  if (!set) return;
  const jobs = [];
  for (const fn of [...set]) {
    try {
      jobs.push(Promise.resolve(fn(payload)).catch((err) => report(evt, err)));
    } catch (err) {
      report(evt, err);
    }
  }
  await Promise.all(jobs);
}

/** Does anyone listen? (cheap guard before building a costly payload) */
export const has = (evt) => !!listeners.get(evt)?.size;

function report(evt, err) {
  console.error(`[bus] un écouteur de « ${evt} » a échoué :`, err);
}

export const bus = { on, off, once, emit, emitAsync, has };
export default bus;
