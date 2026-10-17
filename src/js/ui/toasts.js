/**
 * Toasts — short messages in a pill at the bottom centre (SPEC §6.3,
 * slate-ui §6.3). Mia's never Windows notifications.
 *
 *   toast(msg, { kind: 'info'|'ok'|'error', action: { label, run }, ms }) → { close }
 *
 * Errors stay longer and carry a warning glyph; a toast with an action (Annuler,
 * Voir…) stays long enough to be clicked. The same message twice in a row
 * refreshes the one on screen instead of stacking a copy.
 */
import { el } from '../util.js';
import { icon } from '../icons.js';
import { ms as dur, flip, rects } from './motion.js';

const MAX = 4;
const live = [];   // { node, msg, timer, close }

function hostEl() {
  return document.getElementById('toasts') || document.body.appendChild(el('div', { id: 'toasts', class: 'toasts' }));
}

export function toast(msg, { kind = 'info', action = null, ms, icon: glyph = null } = {}) {
  const text = String(msg ?? '');
  const life = ms ?? (action ? 6000 : kind === 'error' ? 5200 : 2600);

  const twin = live.find((x) => x.msg === text && x.kind === kind && !x.action);
  if (twin && !action) {
    clearTimeout(twin.timer);
    twin.timer = setTimeout(twin.close, life);
    return { close: twin.close };
  }

  const mark = glyph || (kind === 'error' ? 'warn' : kind === 'ok' ? 'check' : null);
  const node = el('div', { class: ['toast', kind], role: kind === 'error' ? 'alert' : 'status' },
    mark ? el('span', { class: 'toast-ico', html: String(mark).startsWith('<') ? mark : icon(mark, 15) }) : null,
    el('span', { class: 'toast-msg' }, text)
  );

  let closed = false;
  const entry = { node, msg: text, kind, action, timer: 0, close: null };
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(entry.timer);
    const i = live.indexOf(entry);
    if (i >= 0) live.splice(i, 1);
    node.classList.add('out');
    setTimeout(() => {
      // the others close the gap by sliding, not by jumping (FLIP)
      const host = node.parentElement;
      const first = host ? rects(stack(host)) : null;
      node.remove();
      if (first) flip(first, stack(host), { dur: 'exit', easing: 'out' });
    }, dur('exit') + 10);
  };
  entry.close = close;

  if (action?.label) {
    node.append(el('button', {
      class: 'toast-action', type: 'button',
      onclick: () => { close(); try { action.run?.(); } catch (err) { console.error('[toast] action', err); } }
    }, action.label));
  }

  // hovering holds the message: you were reading it
  node.addEventListener('pointerenter', () => clearTimeout(entry.timer));
  node.addEventListener('pointerleave', () => { if (!closed) entry.timer = setTimeout(close, 1400); });

  // a new toast pushes the others up: they slide (FLIP), it rises (CSS)
  const host = hostEl();
  const first = rects(stack(host));
  host.append(node);
  flip(first, stack(host), { dur: 'rise', easing: 'out' });
  live.push(entry);
  while (live.length > MAX) live[0].close();
  entry.timer = setTimeout(close, life);
  return { close };
}

/** The toasts on screen, for the FLIP. */
function stack(host) {
  return [...host.children].filter((n) => !n.classList.contains('out')).map((n, i) => ({ key: n, el: n }));
}

export default toast;
