/**
 * Mia — the loss curve of a LoRA training, drawn on a canvas, without a library.
 *
 *   createChart(canvas, { onHover(point | null), onPickSample(step) }) → { set(data), destroy() }
 *   data: { points:[{s, loss, t}], steps, step, live, checkpoints:[step], samples:[step] }
 *
 * What is drawn (da.md: black, 1 px lines, one accent): the raw points in --txt-3, the smoothed line in --txt
 * (1.5 px), ▪ checkpoints and ◇ samples on the base line in --txt-2, one vertical 1 px line at the current step —
 * in the accent while something computes (live), in --txt-3 otherwise. The x axis is the WHOLE training
 * (0 … steps), so the curve grows towards the right edge.
 *
 * The geometry (smooth, bounds, layout, nearest) is pure and exported: tools\test-train-ui.mjs checks it in Node.
 */

/** Exponential mean, corrected for its start (the first points are not pulled towards 0). */
export function smooth(points, span = 0) {
  const n = points.length;
  if (!n) return [];
  const w = span > 0 ? span : Math.max(5, Math.min(100, Math.round(n / 12)));
  const a = 2 / (w + 1);
  const out = [];
  let m = 0;
  let k = 0;
  for (const p of points) {
    if (!Number.isFinite(p.loss)) continue;
    k++;
    m = a * p.loss + (1 - a) * m;
    out.push({ s: p.s, loss: m / (1 - Math.pow(1 - a, k)) });
  }
  return out;
}

/** The vertical range: the 2nd and 98th hundredths of the raw losses (one wild step must not flatten the rest), with air. */
export function bounds(points) {
  const v = points.map((p) => p.loss).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return { min: 0, max: 1 };
  const q = (f) => v[Math.min(v.length - 1, Math.max(0, Math.round(f * (v.length - 1))))];
  let min = q(0.02);
  let max = q(0.98);
  if (!(max > min)) { const c = min; const d = Math.abs(c) * 0.1 || 0.1; min = c - d; max = c + d; }
  const air = (max - min) * 0.12;
  return { min: Math.max(0, min - air), max: max + air };
}

/**
 * Everything needed to draw, in CSS pixels of a w × h canvas.
 * → { box:{l, t, r, b}, x(s), y(loss), sAt(px), min, max, raw:[{x, y, s, loss, t}], line:[{x, y}], marks:{checkpoints:[{x, step}], samples:[{x, step}]}, now }
 */
export function layout(data, w, h) {
  const steps = Math.max(1, +data.steps || 1);
  // a gutter at the right for the two ends of the loss scale: no number is ever written over the curve
  const box = { l: 8, t: 10, r: Math.max(9, w - 48), b: Math.max(11, h - 22) };
  const pts = (data.points || []).filter((p) => Number.isFinite(p.s) && Number.isFinite(p.loss));
  const { min, max } = bounds(pts);
  const x = (s) => box.l + (Math.max(0, Math.min(steps, s)) / steps) * (box.r - box.l);
  const y = (loss) => box.b - ((Math.max(min, Math.min(max, loss)) - min) / (max - min)) * (box.b - box.t);
  const sAt = (px) => Math.round(((Math.max(box.l, Math.min(box.r, px)) - box.l) / (box.r - box.l)) * steps);
  const marks = (list) => [...new Set((list || []).map(Number).filter((s) => Number.isFinite(s) && s > 0 && s <= steps))].sort((a, b) => a - b).map((step) => ({ x: x(step), step }));
  return {
    box, x, y, sAt, min, max, steps,
    raw: pts.map((p) => ({ x: x(p.s), y: y(p.loss), s: p.s, loss: p.loss, t: p.t || 0 })),
    line: smooth(pts).map((p) => ({ x: x(p.s), y: y(p.loss) })),
    marks: { checkpoints: marks(data.checkpoints), samples: marks(data.samples) },
    now: Number.isFinite(+data.step) && +data.step > 0 ? x(+data.step) : null,
    live: data.live !== false
  };
}

/** The colour of the current-step line: the accent while something computes (da.md: progress of a computation),
 *  --txt-3 otherwise (a pause, an error, a stop — nothing runs, and an error already carries its red). */
export function nowColor(L, c) {
  return L && L.live ? c.accent : c.raw;
}

/** The measured point closest to a step (binary search: the points are sorted by step). */
export function nearest(points, s) {
  if (!points || !points.length) return null;
  let a = 0;
  let b = points.length - 1;
  while (b - a > 1) {
    const m = (a + b) >> 1;
    if (points[m].s < s) a = m; else b = m;
  }
  return Math.abs(points[a].s - s) <= Math.abs(points[b].s - s) ? points[a] : points[b];
}

/** The sample mark under the pointer (8 px around its ◇), or null. */
export function sampleAt(L, px, py) {
  if (!L || py < L.box.b - 4) return null;
  let best = null;
  for (const m of L.marks.samples) if (Math.abs(m.x - px) <= 8 && (!best || Math.abs(m.x - px) < Math.abs(best.x - px))) best = m;
  return best ? best.step : null;
}

function draw(ctx, L, w, h, c, hover) {
  ctx.clearRect(0, 0, w, h);
  const { box } = L;
  const px = (v) => Math.round(v) + 0.5;
  // frame lines: the base line, and two faint horizontals
  ctx.lineWidth = 1;
  ctx.strokeStyle = c.line;
  ctx.beginPath();
  for (const f of [0, 0.5, 1]) { const yy = px(box.t + (box.b - box.t) * f); ctx.moveTo(box.l, yy); ctx.lineTo(box.r, yy); }
  ctx.stroke();
  // raw points
  ctx.fillStyle = c.raw;
  for (const p of L.raw) ctx.fillRect(Math.round(p.x) - 0.5, Math.round(p.y) - 0.5, 1.5, 1.5);
  // smoothed line
  if (L.line.length > 1) {
    ctx.strokeStyle = c.txt;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    L.line.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  }
  // marks under the base line: ▪ checkpoint, ◇ sample
  ctx.fillStyle = c.mark;
  for (const m of L.marks.checkpoints) ctx.fillRect(Math.round(m.x) - 2, box.b + 4, 4, 4);
  ctx.strokeStyle = c.mark;
  ctx.lineWidth = 1;
  for (const m of L.marks.samples) {
    const cx = px(m.x);
    const cy = box.b + 6.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 4); ctx.lineTo(cx + 4, cy); ctx.lineTo(cx, cy + 4); ctx.lineTo(cx - 4, cy); ctx.closePath();
    ctx.fillStyle = c.bg;
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = c.mark;
  }
  // the current step
  if (L.now != null) {
    ctx.strokeStyle = nowColor(L, c);
    ctx.beginPath();
    ctx.moveTo(px(L.now), box.t); ctx.lineTo(px(L.now), box.b);
    ctx.stroke();
  }
  // what the pointer reads
  if (hover) {
    ctx.strokeStyle = c.mark;
    ctx.beginPath();
    ctx.moveTo(px(hover.x), box.t); ctx.lineTo(px(hover.x), box.b);
    ctx.stroke();
    ctx.fillStyle = c.txt;
    ctx.beginPath();
    ctx.arc(hover.x, hover.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // axis: 0 … steps, and the range of the losses
  ctx.fillStyle = c.label;
  ctx.font = c.font;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(c.fmt(0), box.l, h - 3);
  ctx.textAlign = 'right';
  ctx.fillText(c.fmt(L.steps), box.r, h - 3);
  if (L.raw.length) {
    ctx.textBaseline = 'top';
    ctx.fillText(c.fmtLoss(L.max), w - 2, box.t - 1);
    ctx.textBaseline = 'bottom';
    ctx.fillText(c.fmtLoss(L.min), w - 2, box.b + 1);
  }
}

export function createChart(canvas, { onHover = null, onPickSample = null, fmt = String, fmtLoss = String } = {}) {
  const ctx = canvas.getContext('2d');
  let data = { points: [], steps: 1, step: 0, live: true, checkpoints: [], samples: [] };
  let L = null;
  let w = 0;
  let h = 0;
  let hover = null;
  let raf = 0;

  const colors = () => {
    const cs = getComputedStyle(canvas);
    const v = (name, d) => cs.getPropertyValue(name).trim() || d;
    return {
      txt: v('--txt', '#ececee'), raw: v('--txt-3', '#77777f'), mark: v('--txt-2', '#9a9aa2'), label: v('--txt-3', '#77777f'),
      line: v('--line-2', 'rgba(255,255,255,.1)'), accent: v('--accent', '#4d82f3'), bg: v('--bg', '#070709'),
      font: `10px ${v('--font-mono', 'monospace')}`, fmt, fmtLoss
    };
  };

  function paint() {
    raf = 0;
    const r = canvas.getBoundingClientRect();
    const nw = Math.round(r.width);
    const nh = Math.round(r.height);
    if (nw < 20 || nh < 20) return;
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    if (nw !== w || nh !== h || canvas.width !== Math.round(nw * dpr)) {
      w = nw; h = nh;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    L = layout(data, w, h);
    draw(ctx, L, w, h, colors(), hover);
  }
  const ask = () => { if (!raf) raf = requestAnimationFrame(paint); };

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(ask) : null;
  ro?.observe(canvas);

  function onMove(e) {
    if (!L) return;
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    canvas.style.cursor = sampleAt(L, mx, my) != null ? 'pointer' : '';
    const p = nearest(L.raw, L.sAt(mx));
    hover = p ? { x: p.x, y: p.y } : null;
    try { onHover?.(p ? { s: p.s, loss: p.loss, t: p.t } : null); } catch (err) { console.error('[trainchart]', err); }
    ask();
  }
  function onLeave() {
    hover = null;
    canvas.style.cursor = '';
    try { onHover?.(null); } catch (err) { console.error('[trainchart]', err); }
    ask();
  }
  function onClick(e) {
    if (!L) return;
    const r = canvas.getBoundingClientRect();
    const step = sampleAt(L, e.clientX - r.left, e.clientY - r.top);
    if (step != null) { try { onPickSample?.(step); } catch (err) { console.error('[trainchart]', err); } }
  }
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('click', onClick);

  return {
    set(next) { data = { ...data, ...next }; ask(); },
    redraw: ask,
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('click', onClick);
    }
  };
}

export default { createChart, layout, smooth, bounds, nearest, sampleAt, nowColor };
