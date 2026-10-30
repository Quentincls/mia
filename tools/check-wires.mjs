// Contrôle « les fils tombent sur les pastilles » (demande de Quentin, 16/10/2026).
// Pour chaque fil d'une planche ouverte dans une Mia pilotable par CDP, compare le bout du fil
// au centre de la pastille du port, en pixels écran, après plusieurs gestes (chargement,
// zoom, dézoom, repli, largeur, rechargement de la page).
// « Pendant l'élargissement » : on tire la vraie poignée de largeur (événements souris CDP) et
// on élargit par petits pas, en relevant l'écart à CHAQUE image (au début de l'image, avant même
// que le ResizeObserver repasse : plus sévère que ce qui est peint), à zoom 1 et 0,5.
//   node tools/check-wires.mjs <port CDP> [--all] [--drag] [--no-screencast]
//   --all : toutes les planches non vides · --drag : seulement les étapes d'élargissement
// Une Mia cachée de test ne peint pas : l'outil y démarre lui-même un screencast acquitté (la
// fenêtre peint alors chaque image et les vrais événements souris passent ; sans lui, Banc 100
// seul dépassait 25 min). Chaque planche est fermée après son contrôle (8 onglets au plus) ; une
// planche qui ne s'ouvre pas est un ÉCHEC, jamais un « ok » mesuré sur la précédente. Ctrl+C ou une
// erreur arrêtent la boucle de relevé de la page (window.__wcs) avant de quitter.
const port = Number(process.argv[2] || 9340);
const ALL = process.argv.includes('--all');
const DRAG_ONLY = process.argv.includes('--drag');
const SCREENCAST = !process.argv.includes('--no-screencast');

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) || list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
const errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  // screencast : chaque image acquittée, sinon Chromium cesse d'en envoyer (et de peindre)
  else if (d.method === 'Page.screencastFrame') ws.send(JSON.stringify({ id: ++id, method: 'Page.screencastFrameAck', params: { sessionId: d.params.sessionId } }));
  else if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
};
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval');
  return r.result?.result?.value;
};
await send('Runtime.enable');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// La boucle de relevé (getPointAtLength sur tous les fils à chaque image) ne doit jamais survivre
// à l'outil : elle fausserait toute mesure qui suit dans la même fenêtre.
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { await Promise.race([ev('(window.__wcs && window.__wcs.stop && window.__wcs.stop(), delete window.__wcs, 1)'), sleep(1500)]); } catch { /* page partie */ }
  if (SCREENCAST) { try { await Promise.race([send('Page.stopScreencast'), sleep(1000)]); } catch { /* idem */ } }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup().finally(() => process.exit(130)); });
if (SCREENCAST) {
  await send('Page.enable');
  await send('Page.startScreencast', { format: 'jpeg', quality: 5, maxWidth: 200, everyNthFrame: 1 });
}

/** Ouvre une planche ; true seulement si c'est bien elle qui est à l'écran. Onglets pleins : on les ferme, on réessaie. */
async function openBoard(boardId) {
  const tryOpen = () => ev(`(async () => {
    const ok = await window.__mia.app.openProject(${JSON.stringify(boardId)});
    return { ok: ok !== false, cur: window.__mia.state.project?.id || null };
  })()`);
  let r = await tryOpen();
  if (r.ok && r.cur === boardId) return true;
  await ev(`(async () => {
    for (const t of [...(window.__mia.state.prefs?.openTabs || [])]) {
      const id = typeof t === 'string' ? t : t?.id;
      if (id) { try { await window.__mia.app.closeTab(id); } catch {} }
    }
    return 1;
  })()`);
  await sleep(600);
  r = await tryOpen();
  return !!(r.ok && r.cur === boardId);
}
const closeBoard = (boardId) => ev(`(async () => { try { await window.__mia.app.closeTab(${JSON.stringify(boardId)}); } catch {} return 1; })()`).catch(() => {});

// mesure dans la page : écart (px écran) entre chaque bout de fil et le centre de sa pastille
const MEASURE = `(() => {
  const e = window.__mia.editor, g = e.getGraph(), out = [];
  const z = e.camera().z;
  const center = (nodeId, portId, dir) => {
    const el = e.nodeEl(nodeId); if (!el) return null;
    const p = el.querySelector('[data-port="' + portId + '"][data-dir="' + dir + '"] .dot') || el.querySelector('[data-port="' + portId + '"] .dot');
    if (!p) return null;
    const r = p.getBoundingClientRect(); if (!r.width) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  for (const ed of g.edges) {
    const path = document.querySelector('#wires [data-id="' + ed.id + '"] .w-line');
    if (!path) { out.push({ edge: ed.id, err: 'fil absent' }); continue; }
    const len = path.getTotalLength();
    const m = path.getScreenCTM();
    const toScreen = (pt) => ({ x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f });
    const a = toScreen(path.getPointAtLength(0)), b = toScreen(path.getPointAtLength(len));
    const pa = center(ed.from.node, ed.from.port, 'out'), pb = center(ed.to.node, ed.to.port, 'in');
    const fromNode = g.nodes.find((n) => n.id === ed.from.node), toNode = g.nodes.find((n) => n.id === ed.to.node);
    if (fromNode?.collapsed || toNode?.collapsed) continue;          // repli : ancrage au milieu de l'en-tête, contrôlé à part
    if (!pa || !pb) { out.push({ edge: ed.id, err: 'pastille introuvable ou cachée' }); continue; }
    const da = Math.hypot(a.x - pa.x, a.y - pa.y), db = Math.hypot(b.x - pb.x, b.y - pb.y);
    out.push({ edge: ed.id, da: +da.toFixed(2), db: +db.toFixed(2), z: +z.toFixed(2) });
  }
  return out;
})()`;

async function check(label) {
  const res = await ev(MEASURE);
  const bad = res.filter((r) => r.err || r.da > 1.5 || r.db > 1.5);
  const worst = Math.max(0, ...res.filter((r) => !r.err).map((r) => Math.max(r.da, r.db)));
  console.log(`${bad.length ? 'ÉCHEC' : 'ok   '}  ${label.padEnd(34)} ${res.length} fils, écart max ${worst.toFixed(2)} px${bad.length ? '  ' + JSON.stringify(bad.slice(0, 4)) : ''}`);
  return bad.length === 0;
}

// Relevés : une boucle requestAnimationFrame mesure, au début de chaque image, les fils (pire écart
// de l'image) ; `__wcs.now()` mesure aussi tout de suite, juste après un pas (plus sévère : avant
// que le ResizeObserver de l'image repasse). `window.__wcs.stop()` rend le bilan.
const SAMPLER = `(() => {
  const e = window.__mia.editor;
  if (window.__wcs) window.__wcs.stop();
  const dotAt = (el, port, dir) => {
    const d = el && (el.querySelector('[data-port="' + port + '"][data-dir="' + dir + '"] .dot') || el.querySelector('[data-port="' + port + '"] .dot'));
    if (!d) return null;
    const r = d.getBoundingClientRect(); if (!r.width) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const S = { frames: 0, steps: 0, worst: 0, bad: [], on: true };
  const sample = (kind) => {
    const g = e.getGraph();
    let worst = 0, n = 0;
    for (const ed of g.edges) {
      const A = g.nodes.find((x) => x.id === ed.from.node), B = g.nodes.find((x) => x.id === ed.to.node);
      if (A?.collapsed || B?.collapsed) continue;
      const path = document.querySelector('#wires [data-id="' + ed.id + '"] .w-line');
      if (!path) continue;
      const m = path.getScreenCTM(), len = path.getTotalLength();
      const sc = (pt) => ({ x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f });
      const a = sc(path.getPointAtLength(0)), b = sc(path.getPointAtLength(len));
      const pa = dotAt(e.nodeEl(ed.from.node), ed.from.port, 'out'), pb = dotAt(e.nodeEl(ed.to.node), ed.to.port, 'in');
      if (!pa || !pb) continue;
      n++;
      worst = Math.max(worst, Math.hypot(a.x - pa.x, a.y - pa.y), Math.hypot(b.x - pb.x, b.y - pb.y));
    }
    if (!n) return;
    const i = kind === 'image' ? ++S.frames : ++S.steps;
    if (worst > S.worst) S.worst = worst;
    if (worst > 1.5 && S.bad.length < 12) S.bad.push({ [kind]: i, px: +worst.toFixed(1) });
  };
  const loop = () => { if (!S.on) return; try { sample('image'); } catch (err) { S.err = String(err); } requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  S.now = () => { try { sample('pas'); } catch (err) { S.err = String(err); } return S.steps; };
  S.stop = () => { S.on = false; return { frames: S.frames, steps: S.steps, worst: +S.worst.toFixed(2), bad: S.bad, err: S.err || null }; };
  window.__wcs = S;
  return true;
})()`;

/**
 * La fenêtre peint-elle des images, régulièrement ? Une Mia cachée de test n'en peint pas (quelques
 * images éparses juste après un rechargement seulement) : 8 images en 600 ms ou rien.
 */
const paints = () => ev(`new Promise((r) => {
  let n = 0;
  const t = setTimeout(() => r(false), 600);
  const f = () => { if (++n >= 8) { clearTimeout(t); r(true); } else requestAnimationFrame(f); };
  requestAnimationFrame(f);
})`);

// Chromium ne livre un événement souris qu'à une fenêtre qui peint : au-delà de 3 s, on le dit
const mouse = (type, x, y, extra = {}) => Promise.race([
  send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra }),
  sleep(3000).then(() => { throw new Error('événement souris non livré : la fenêtre a cessé de peindre'); })
]);

/** Blocs à élargir : reliés, de types différents, ceux à aperçu d'abord (leurs ports descendent). */
const pickNodes = (max) => ev(`(() => {
  const g = window.__mia.editor.getGraph(), deg = new Map();
  for (const x of g.edges) for (const id of [x.from.node, x.to.node]) deg.set(id, (deg.get(id) || 0) + 1);
  const seen = new Set(), out = [];
  const list = g.nodes.filter((n) => deg.get(n.id) && !n.collapsed)
    .sort((a, b) => (a.type === 'import') - (b.type === 'import') || deg.get(b.id) - deg.get(a.id));
  for (const n of list) { if (seen.has(n.type)) continue; seen.add(n.type); out.push(n.id); if (out.length >= ${max}) break; }
  return out;
})()`);

/** Cadre le bloc au zoom z, sa poignée de largeur au tiers gauche de l'écran ; rend le centre de la poignée. */
async function aim(id, z) {
  await ev(`(() => {
    const e = window.__mia.editor, n = e.getNode(${JSON.stringify(id)});
    const st = document.querySelector('#world').parentElement, r = st.getBoundingClientRect(), z = ${z};
    const v = e.nodeEl(n.id), hgt = v ? v.offsetHeight : 300;
    e.setCamera({ x: n.x + n.w - (r.width * 0.38) / z, y: n.y + hgt / 2 - (r.height * 0.5) / z, z });
    return 1;
  })()`);
  await sleep(450);
  // la caméra n'est posée qu'à l'image : quelques images (s'il en vient) avant de viser
  const frames = await ev(`new Promise((r) => { let n = 0; const t = setTimeout(() => r(0), 400); const f = () => { if (++n >= 3) { clearTimeout(t); r(1); } else requestAnimationFrame(f); }; requestAnimationFrame(f); })`);
  const h = await ev(`(() => {
    const el = window.__mia.editor.nodeEl(${JSON.stringify(id)})?.querySelector('.n-resize');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width) return null;
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    // ce que la souris toucherait là : la poignée elle-même ?
    const hit = document.elementFromPoint(x, y)?.closest('.n-resize') === el;
    return { x, y, hit, vw: innerWidth, vh: innerHeight };
  })()`);
  return h && { ...h, frames: !!frames };
}

/** Les mêmes pas, en événements de pointeur de la page (fenêtre qui ne peint pas : CDP n'y livre rien). */
const SYNTH_DRAG = (id, h, span) => `new Promise((done) => {
  const e = window.__mia.editor, handle = e.nodeEl(${JSON.stringify(id)}).querySelector('.n-resize');
  const stage = document.querySelector('#world').parentElement;
  const pe = (type, x, y, down) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 41, pointerType: 'mouse', isPrimary: true,
    button: type === 'pointermove' ? -1 : 0, buttons: down ? 1 : 0, clientX: x, clientY: y });
  handle.dispatchEvent(pe('pointerdown', ${h.x}, ${h.y}, true));
  const steps = Math.round(${span} / 4);
  let i = 0, w1 = 0;
  const step = () => {
    i++;
    const k = i > steps ? 2 * steps - i : i;
    stage.dispatchEvent(pe('pointermove', ${h.x} + k * 4, ${h.y} + k * 0.5, true));
    window.__wcs.now();
    if (i === steps) w1 = e.getNode(${JSON.stringify(id)}).w;
    if (i < 2 * steps) setTimeout(step, i % 3 ? 3 : 0);
    else { stage.dispatchEvent(pe('pointerup', ${h.x}, ${h.y}, false)); setTimeout(() => done(w1), 120); }
  };
  step();
})`;

/** Tire la vraie poignée : +span px écran par pas de 4 px, puis retour ; relevé à chaque image et à chaque pas. */
async function dragCheck(id, z, painting, span = 160) {
  const h = await aim(id, z);
  // sans images, la caméra n'est pas appliquée (elle l'est à l'image) : la poignée peut rester hors
  // champ, mais les événements de la page n'ont pas besoin qu'elle soit visible
  if (!h) return { skip: 'poignée cachée' };
  // une fenêtre qui ne peint que par à-coups (cachée) : la vue n'est pas encore là où on vise
  if (painting && (!h.hit || !h.frames)) painting = false;
  if (painting && (h.x < 0 || h.y < 0 || h.x + span > h.vw || h.y > h.vh)) return { skip: 'poignée hors champ' };
  const w0 = await ev(`window.__mia.editor.getNode(${JSON.stringify(id)}).w`);
  await ev(SAMPLER);
  let w1 = w0, lost = null;
  if (painting) {
    try {
      await mouse('mouseMoved', h.x, h.y, { buttons: 0 });
      await mouse('mousePressed', h.x, h.y);
      const steps = Math.round(span / 4);
      for (const dir of [1, -1]) {
        for (let i = 1; i <= steps; i++) {
          const x = dir > 0 ? h.x + i * 4 : h.x + span - i * 4;
          await mouse('mouseMoved', x, h.y + (dir > 0 ? i : steps - i) * 0.5);
          if (i % 3) await ev(`window.__wcs.now()`);           // juste après le pas (avant l'image)
          else await sleep(11);                                 // ou plusieurs pas dans une image
        }
        if (dir > 0) w1 = await ev(`window.__mia.editor.getNode(${JSON.stringify(id)}).w`);
      }
      await mouse('mouseReleased', h.x, h.y);
    } catch (err) { lost = err.message; }
  } else {
    w1 = await ev(SYNTH_DRAG(id, h, span));
  }
  await sleep(250);
  const res = await ev(`window.__wcs.stop()`);
  if (lost) res.err = lost;
  // largeur exacte d'origine, sans entrée d'annulation en plus
  await ev(`window.__mia.editor.updateNode(${JSON.stringify(id)}, { w: ${w0} }, { history: false })`);
  await sleep(150);
  return { ...res, grew: w1 > w0, painting };
}

/** Tous les blocs élargis par l'éditeur (updateNode, comme un assistant), 24 pas hors image, puis retour. */
async function widenCheck(z, painting) {
  await ev(`window.__mia.editor.fit()`);
  await sleep(500);
  await ev(`(() => { const e = window.__mia.editor, c = e.camera(); e.setCamera({ x: c.x, y: c.y, z: ${z} }); return 1; })()`);
  await sleep(500);
  await ev(SAMPLER);
  await ev(`new Promise((done) => {
    const e = window.__mia.editor, w0 = new Map(e.getGraph().nodes.map((n) => [n.id, n.w]));
    let k = 0;
    const step = () => {
      k++;
      const d = k <= 12 ? k * 4 : (24 - k) * 4;
      for (const [id, w] of w0) e.updateNode(id, { w: w + d }, { history: false });
      window.__wcs.now();
      if (k < 24) setTimeout(step, k % 2 ? 7 : 19); else setTimeout(() => done(1), 250);
    };
    step();
  })`);
  return { ...(await ev(`window.__wcs.stop()`)), grew: true, painting };
}

function report(label, r) {
  if (r.skip) { console.log(`--     ${label.padEnd(34)} ${r.skip}`); return true; }
  // le relevé à chaque pas suffit à juger ; celui des images s'y ajoute quand la fenêtre peint
  const bad = r.bad.length > 0 || !!r.err || !r.steps || !r.grew;
  const why = r.err ? { err: r.err } : !r.grew ? 'la largeur n’a pas bougé' : r.bad.slice(0, 6);
  const count = r.painting ? `${r.frames} images + ${r.steps} pas` : `${r.steps} pas (sans images)`;
  console.log(`${bad ? 'ÉCHEC' : 'ok   '}  ${label.padEnd(34)} ${count}, écart max ${r.worst.toFixed(2)} px${bad ? '  ' + JSON.stringify(why) : ''}`);
  return !bad;
}

async function widthSteps() {
  let good = true, said = false;
  // une planche sans aucun fil (des blocs seuls) : rien à mesurer, ce n'est pas un échec
  if (!(await ev(`(window.__mia.editor.getGraph().edges || []).length`))) {
    report(`pendant l'élargissement`, { skip: 'aucun fil sur cette planche' });
    return true;
  }
  const mode = async () => {
    const p = await paints();
    if (!p && !said) { said = true; console.log('       (fenêtre qui ne peint pas : poignée tirée en événements de la page, relevé à chaque pas)'); }
    return p;
  };
  for (const z of [1, 0.5]) {
    good = report(`pendant l'élargissement z${z}`, await widenCheck(z, await mode())) && good;
    for (const id of await pickNodes(3)) {
      const type = await ev(`window.__mia.editor.getNode(${JSON.stringify(id)}).type`);
      good = report(`poignée tirée (${type}) z${z}`, await dragCheck(id, z, await mode())) && good;
    }
  }
  await ev(`window.__mia.editor.fit()`); await sleep(600);
  return good;
}

const projects = await ev(`window.mia.projects.list().then((l) => (Array.isArray(l) ? l : l.projects).filter((p) => p.nodes > 1).map((p) => ({ id: p.id, name: p.name })))`);
let ok = true;
let last = null;
try {
for (const p of ALL ? projects : projects.slice(0, 1)) {
  console.log(`\n# ${p.name}`);
  if (last) { await closeBoard(last); last = null; }                  // 8 onglets au plus : on ferme en partant
  if (!(await openBoard(p.id))) {
    console.log('ÉCHEC  planche non ouverte (onglets pleins ou planche illisible) : rien n’est mesuré');
    ok = false;
    continue;
  }
  last = p.id;
  await sleep(3500);                                                  // médias chargés, cartes à leur taille
  await ev(`window.__mia.editor.fit()`); await sleep(900);
  ok = (await check('ouverture + tout cadrer')) && ok;
  if (DRAG_ONLY) {
    ok = (await widthSteps()) && ok;
    ok = (await check('après les élargissements')) && ok;
    continue;
  }
  for (const z of [1, 1.8, 0.5, 0.3, 0.15]) {
    await ev(`(() => { const e = window.__mia.editor, c = e.camera(); e.setCamera({ x: c.x, y: c.y, z: ${z} }); })()`);
    await sleep(700);
    ok = (await check(`zoom ${z}`)) && ok;
  }
  await ev(`window.__mia.editor.fit()`); await sleep(700);
  // largeur : chaque bloc +48 px puis retour
  await ev(`(() => { const e = window.__mia.editor; for (const n of e.getGraph().nodes) e.updateNode(n.id, { w: n.w + 48 }, { history: false }); })()`);
  await sleep(700);
  ok = (await check('blocs élargis')) && ok;
  await ev(`(() => { const e = window.__mia.editor; for (const n of e.getGraph().nodes) e.updateNode(n.id, { w: n.w - 48 }, { history: false }); })()`);
  await sleep(700);
  ok = (await check('largeur rendue')) && ok;
  ok = (await widthSteps()) && ok;
  ok = (await check('après les élargissements')) && ok;
  // déplacement d'un bloc
  await ev(`(() => { const e = window.__mia.editor, n = e.getGraph().nodes[0]; e.updateNode(n.id, { x: n.x + 120, y: n.y + 60 }, { history: false }); })()`);
  await sleep(500);
  ok = (await check('bloc déplacé')) && ok;
  await ev(`(() => { const e = window.__mia.editor, n = e.getGraph().nodes[0]; e.updateNode(n.id, { x: n.x - 120, y: n.y - 60 }, { history: false }); })()`);
  await sleep(500);
}
// rechargement de la page : on retombe sur la dernière planche ouverte
if (!DRAG_ONLY && last) {
  await ev(`(async () => { try { await window.__mia.app.flushSave(); } catch {} setTimeout(() => location.reload(), 100); return 1; })()`);
  await sleep(6000);
  try {
    await ev(`window.__mia.editor.fit()`); await sleep(900);
    ok = (await check('après rechargement')) && ok;
  } catch (e) { console.log('après rechargement : planche non chargée —', e.message); ok = false; }
}
} catch (err) {
  console.log('\nERREUR', err?.message || err);
  ok = false;
} finally {
  await cleanup();
}
console.log(errors.length ? `\nErreurs console (${errors.length}) :\n` + [...new Set(errors)].slice(0, 8).join('\n') : '\nAucune erreur console.');
console.log(ok ? '\nRÉSULTAT : tous les fils tombent sur leurs pastilles.' : '\nRÉSULTAT : des fils ne tombent pas sur leurs pastilles.');
ws.close();
process.exit(ok ? 0 : 1);
