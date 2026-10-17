// ── Minicarte ─────────────────────────────────────────────────────────
// 200 × 132 en bas à droite, au-dessus de la barre de zoom (da.md §4.6) :
// les blocs en rectangles discrets, la sélection en accent, les blocs en
// calcul en accent atténué, le cadre de la vue. Cliquer ou glisser dedans
// déplace la vue. Cachée par défaut, touche M, état gardé dans les préférences.

const W = 200, H = 132, PAD = 10;

export function createMinimap(ed) {
  const root = ed.minimapEl;
  root.classList.add('g-minimap');
  root.hidden = true;
  const canvas = document.createElement('canvas');
  root.replaceChildren(canvas);
  const ctx = canvas.getContext('2d');
  let visible = false, raf = 0, colors = null, frozen = null, map = null;

  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  size();

  function readColors() {
    const cs = getComputedStyle(root);
    const v = (n, d) => cs.getPropertyValue(n).trim() || d;
    colors = {
      node: v('--mm-node', 'rgba(255,255,255,.18)'),
      group: v('--mm-group', 'rgba(255,255,255,.05)'),
      sel: v('--accent', '#4d82f3'),
      view: v('--mm-view', 'rgba(236,236,238,.5)'),
      viewFill: v('--wash', 'rgba(255,255,255,.055)')
    };
  }

  /** Boîte du monde à représenter : tout le contenu et la vue courante. */
  function bounds() {
    const v = ed.cam.viewRect();
    let x0 = v.x, y0 = v.y, x1 = v.x + v.w, y1 = v.y + v.h;
    const box = ed.project ? ed.bbox(null) : null;
    if (box) {
      x0 = Math.min(x0, box.x); y0 = Math.min(y0, box.y);
      x1 = Math.max(x1, box.x + box.w); y1 = Math.max(y1, box.y + box.h);
    }
    const bw = x1 - x0, bh = y1 - y0;
    const k = Math.min((W - PAD * 2) / bw, (H - PAD * 2) / bh);
    return { k, ox: PAD + ((W - PAD * 2) - bw * k) / 2 - x0 * k, oy: PAD + ((H - PAD * 2) - bh * k) / 2 - y0 * k };
  }

  function draw() {
    raf = 0;
    if (!visible) return;
    if (!colors) readColors();
    map = frozen || bounds();
    const { k, ox, oy } = map;
    ctx.clearRect(0, 0, W, H);
    if (!ed.project) return;
    const R = (x, y, w, h) => [ox + x * k, oy + y * k, Math.max(1.5, w * k), Math.max(1.5, h * k)];
    ctx.fillStyle = colors.group;
    for (const g of ed.doc.groups) {
      const [x, y, w, h] = R(g.x, g.y, g.w, g.h);
      roundRect(x, y, w, h, 2);
      ctx.fill();
    }
    for (const n of ed.doc.nodes) {
      const b = ed.nodeBox(n.id);
      const [x, y, w, h] = R(b.x, b.y, b.w, b.h);
      const running = ed.runs.state(n.id).kind === 'running';
      if (ed.sel.nodes.has(n.id)) { ctx.globalAlpha = 1; ctx.fillStyle = colors.sel; }
      else if (running) { ctx.globalAlpha = 0.6; ctx.fillStyle = colors.sel; }
      else { ctx.globalAlpha = 1; ctx.fillStyle = colors.node; }
      roundRect(x, y, w, h, 1.5);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    const v = ed.cam.viewRect();
    const [x, y, w, h] = R(v.x, v.y, v.w, v.h);
    ctx.fillStyle = colors.viewFill;
    roundRect(x, y, w, h, 2);
    ctx.fill();
    ctx.strokeStyle = colors.view;
    ctx.lineWidth = 1;
    roundRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w) - 1, Math.round(h) - 1, 2);
    ctx.stroke();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, Math.max(0, w), Math.max(0, h), r);
    else ctx.rect(x, y, w, h);
  }

  // Cliquer hors du cadre de vue : la caméra y glisse (400 ms, --ease-cam,
  // da.md §4.12). Attraper le cadre : il suit le pointeur sans sauter (on garde
  // l'écart entre le pointeur et le centre du cadre). Glisser après un clic hors
  // du cadre : la vue suit directement.
  let grab = null;    // { dx, dy } : écart monde pointeur → centre de la vue
  const toWorld = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left - map.ox) / map.k, y: (e.clientY - r.top - map.oy) / map.k };
  };
  const viewCenterW = () => { const v = ed.cam.viewRect(); return { x: v.x + v.w / 2, y: v.y + v.h / 2 }; };
  function follow(e) {
    if (!map || !grab) return;
    const w = toWorld(e);
    ed.cam.stop();
    ed.cam.centerOn(w.x + grab.dx, w.y + grab.dy);
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !ed.project) return;
    e.preventDefault();
    frozen = map || bounds();        // l'échelle ne bouge pas pendant le glisser
    map = frozen;
    canvas.setPointerCapture(e.pointerId);
    const w = toWorld(e);
    const v = ed.cam.viewRect();
    const inView = w.x >= v.x && w.x <= v.x + v.w && w.y >= v.y && w.y <= v.y + v.h;
    if (inView) {
      const c = viewCenterW();
      grab = { dx: c.x - w.x, dy: c.y - w.y, moved: false, x0: e.clientX, y0: e.clientY };
    } else {
      const z = ed.cam.settled.z;
      ed.cam.animateTo({ z, x: w.x - ed.cam.vw / 2 / z, y: w.y - ed.cam.vh / 2 / z });
      grab = { dx: 0, dy: 0, moved: false, x0: e.clientX, y0: e.clientY, pending: true };
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!frozen || !grab) return;
    if (!grab.moved && Math.hypot(e.clientX - grab.x0, e.clientY - grab.y0) < 3) return;
    grab.moved = true;
    if (grab.pending) { grab.pending = false; grab.dx = 0; grab.dy = 0; }
    follow(e);
  });
  const release = () => { frozen = null; grab = null; request(); };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  root.addEventListener('contextmenu', (e) => e.preventDefault());

  // la file de calcul (F, queue.css) partage ce coin : c'est elle qui monte
  // au-dessus de la minicarte quand celle-ci est visible

  function request() { if (visible && !raf) raf = requestAnimationFrame(draw); }

  function setVisible(on, persist = true) {
    on = !!on;
    if (on === visible) { if (ed.minimapBtn) ed.minimapBtn.classList.toggle('on', on); return; }
    visible = on;
    root.hidden = !on;
    if (ed.minimapBtn) ed.minimapBtn.classList.toggle('on', on);
    if (on) { size(); colors = null; request(); }
    if (persist) ed.setPref({ minimap: on });
  }

  return {
    request,
    setVisible,
    toggle() { setVisible(!visible); },
    bust() { colors = null; request(); },
    get visible() { return visible; }
  };
}
