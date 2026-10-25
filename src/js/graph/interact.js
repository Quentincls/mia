// ── Gestes de la planche ──────────────────────────────────────────────
// Souris et trackpad (da.md §4.8, tech.md §4) : deux doigts = déplacer,
// pincer = zoom au curseur, molette = zoom animé au curseur, clic molette /
// Espace + glisser / clic droit glissé = déplacer. Sélection au clic et au
// rectangle, déplacement libre, largeur, fils tirés depuis n'importe quel port
// (aimant de 24 px), sections comme dans Slate, menus contextuels, raccourcis.
//
// Le pointeur n'est capturé qu'une fois le geste parti (au-delà de 3 px) : une
// capture posée dès l'appui envoie le clic et le double-clic à la scène au lieu
// du titre, du puits ou du bouton visé (le double-clic sur un titre ouvrait la
// palette au lieu de renommer).
//
// Les raccourcis lisent `e.key` (lettres imprimées : AZERTY compris) et
// `e.code` pour les chiffres ; ils se taisent dès qu'on tape dans un champ.

import { emit } from '../bus.js';
import { t, tl } from '../i18n.js';
import { openMenu } from '../ui/menu.js';
import { toast } from '../ui/toasts.js';
import { recipes, compatible, portDef, inputDefs, outputDefs, computes, typeOf } from '../catalog.js';
import { wirePathScreen } from './wires.js';
import { GRID, NODE_MIN_W, NODE_MAX_W } from './doc.js';
import { defaultTitle } from './view.js';
import { nodeInputs, nodeOutputs, nodePortDef, hiddenInputs, isModelBlock, usefulInputs, mainPorts, blockFamily } from '../nodes/ports.js';
import { hideTip } from '../ui/tooltip.js';
import { ms, easeFn } from '../ui/motion.js';
import {
  TONE_MENU, toneKey, toneColor, hitSection, CURSORS, resizeBox, membersOf, sectionAt, adopt,
  titlePx, titleLift
} from './sections.js';

const NS = 'http://www.w3.org/2000/svg';
const CLICK_SLOP = 3;     // px écran : en dessous, c'est un clic
const RIGHT_SLOP = 4;     // clic droit glissé au-delà = déplacer la vue
const MAGNET = 24;        // aimant des ports, px écran
const EDGE = 28;          // bord de scène qui fait défiler pendant un glisser
const NOTCH = 1.18;       // un cran de molette = ×1,18

const INTERACTIVE = [
  'input', 'textarea', 'select', 'button', 'a[href]', 'label', 'video[controls]',
  '[contenteditable]:not([contenteditable="false"])', '[role="slider"]', '[role="button"]',
  '[role="listbox"]', '[role="option"]', '[role="switch"]', '[role="tab"]', '[data-nodrag]'
].join(',');

const isTyping = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || !!el.closest?.('[role="textbox"]'));
const RENAME_INPUTS = '.n-title-input, .g-title-input';

export function attachInteract(ed) {
  const { stage, cam } = ed;
  let g = null;               // geste en cours
  let spaceDown = false;
  let lastTrackpadAt = -1e9;
  let rect = stage.getBoundingClientRect();

  // ── calque écran : fil tiré, pastille « × » ──
  const ov = ed.ovSvg;
  const preview = document.createElementNS(NS, 'path');
  preview.setAttribute('class', 'ov-wire');
  const previewEnd = document.createElementNS(NS, 'circle');
  previewEnd.setAttribute('class', 'ov-wire-end');
  previewEnd.setAttribute('r', '4');
  ov.append(preview, previewEnd);
  hidePreview();

  const cutBtn = document.createElement('button');
  cutBtn.type = 'button';
  cutBtn.className = 'w-cut';
  cutBtn.hidden = true;
  cutBtn.dataset.tip = t('graph.tip.cut');
  cutBtn.innerHTML = '<svg viewBox="0 0 12 12" width="10" height="10"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  ed.overlay.append(cutBtn);
  let cutHideT = 0;

  const local = (e) => ({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  const sel = () => ed.sel;

  /** La cible est-elle « la planche nue » (grille, scène, monde vide) ? */
  const onCanvas = (el) => el === stage || el === ed.grid || el === ed.world || el === ed.nodesEl
    || el === ed.groupsEl || el === ed.overlay || el?.id === 'grid-canvas';

  /** Section sous le point écran (titre, bord, poignée), ou null. */
  const sectionUnder = (p) => (ed.doc.groups.length
    ? hitSection(ed.doc.groups, cam, p, { lod: ed.lod, titleW: (gr) => ed.sect.widths.get(gr.id) ?? 80 })
    : null);

  // ── pointeur ──────────────────────────────────────────────────────

  stage.addEventListener('pointerdown', (e) => {
    if (!ed.project || g) return;
    let target = e.target;
    // juste après un geste de caméra, le monde ignore encore le pointeur
    // (#world.moving) : on lui rend la main et on retrouve ce qui est vraiment visé
    if (ed.world.classList.contains('moving')) {
      ed.world.classList.remove('moving');
      target = document.elementFromPoint(e.clientX, e.clientY) || target;
    }
    if (target.closest('.w-cut, .g-title-input')) return;
    if (!cutBtn.hidden && !target.classList?.contains('w-hit')) hideCut();   // le fil va bouger : la pastille part
    rect = stage.getBoundingClientRect();
    const p = local(e);
    ed.pointer = p;
    cam.stop();
    ed.smooth.stop();
    const nodeEl = target.closest('.node');

    if (e.button === 1 || (e.button === 0 && spaceDown)) { e.preventDefault(); return startPan(e, p); }
    if (e.button === 2) {
      if (isTyping(target)) return;           // menu Couper/Copier/Coller des champs (D)
      return startRight(e, p, target);
    }
    if (e.button !== 0) return;
    if (ed.readonly) {
      if (!nodeEl) { e.preventDefault(); startMarquee(e, p); }
      else selectOnDown(nodeEl.dataset.id, e);
      return;
    }

    // outil « Section » armé : glisser n'importe où dessine le cadre
    if (ed.tool === 'section' && !target.closest('.n-controls, .n-port')) {
      e.preventDefault();
      blurInside();
      return startSectionDraw(e, p);
    }

    const dot = target.closest('.n-port .dot, .n-port .lbl, .n-cdot');
    if (dot && nodeEl && !dot.closest('.n-controls')) {
      // l'étiquette d'un port sert aussi de poignée : la pastille de 10 px est petite
      e.preventDefault();
      return startConnect(e, p, nodeEl, dot);
    }
    if (target.closest('.n-resize') && nodeEl) { e.preventDefault(); return startResize(e, p, nodeEl.dataset.id); }
    if (target.classList?.contains('w-hit')) {
      e.preventDefault();
      return clickWire(e, target.parentNode.dataset.id);
    }
    if (nodeEl) {
      const id = nodeEl.dataset.id;
      const interactive = isInteractive(target, nodeEl);
      const toggle = selectOnDown(id, e);
      if (interactive) return;               // le contrôle de F garde la main
      e.preventDefault();
      blurInside();
      return startMove(e, p, id, toggle);
    }
    // planche nue : une section par son titre, son bord ou une poignée ?
    const hs = onCanvas(target) ? sectionUnder(p) : null;
    if (hs) {
      e.preventDefault();
      blurInside();
      if (hs.part === 'title' || hs.part === 'move') return startGroupMove(e, p, hs.id);
      return startGroupResize(e, p, hs.id, hs.part);
    }
    e.preventDefault();
    blurInside();
    startMarquee(e, p);
  });

  stage.addEventListener('pointermove', (e) => {
    const p = local(e);
    ed.pointer = p;
    if (!g) { hoverSections(e, p); return; }
    if (e.pointerId !== g.pid) return;
    g.last = p;
    g.alt = e.altKey;
    g.client = { x: e.clientX, y: e.clientY };
    handleMove(p);
    autoPan(p);
  });

  const end = (e) => {
    if (!g || (e && e.pointerId !== g.pid)) return;
    const cur = g;
    g = null;
    stopAutoPan();
    if (cur.captured) { try { stage.releasePointerCapture(cur.pid); } catch { /* déjà relâché */ } }
    stage.classList.remove('panning', 'dragging', 'connecting-cursor', 'resizing');
    // un fil dont le pointeur a été perdu est annulé (rien ne se branche au hasard) ; les autres gestes finissent
    finish(cur, e?.type === 'pointercancel' || (e?.type === 'lostpointercapture' && cur.kind === 'connect'));
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('lostpointercapture', (e) => { if (g && e.pointerId === g.pid && g.captured) end(e); });
  // sans capture (clic qui n'a pas bougé), le relâcher peut tomber hors de la scène
  window.addEventListener('pointerup', (e) => { if (g && e.pointerId === g.pid && !g.captured) end(e); });

  stage.addEventListener('contextmenu', (e) => { if (!isTyping(e.target)) e.preventDefault(); });

  stage.addEventListener('dblclick', (e) => {
    if (!ed.project) return;
    rect = stage.getBoundingClientRect();
    // la vraie cible, au cas où un geste aurait encore la capture
    const target = document.elementFromPoint(e.clientX, e.clientY) || e.target;
    if (target.closest('.w-cut, .g-title-input, .n-title-input')) return;
    const nodeEl = target.closest('.node');
    if (nodeEl) {
      // en-tête (titre ou vide de l'en-tête) = renommer (da.md §4.2) ; le reste
      // de la carte appartient à F (le puits ouvre la visionneuse)
      const head = target.closest('.n-head');
      if (head && !target.closest('.n-more, .n-status button, button') && !ed.readonly) renameNode(nodeEl.dataset.id);
      return;
    }
    if (target.closest('.wire, #dock, #zoombar, #minimap, #queue, #inspector')) return;
    const p = local(e);
    const hs = onCanvas(target) ? sectionUnder(p) : null;
    if (hs) {
      if (hs.part === 'title' && !ed.readonly) renameSection(hs.id);
      return;
    }
    if (ed.readonly || ed.tool) return;
    ed.palette.open({ at: cam.toWorld(p.x, p.y) });
  });

  /** Capture le pointeur : seulement quand le geste part vraiment (voir en tête). */
  function capture() {
    if (!g || g.captured) return;
    try { stage.setPointerCapture(g.pid); g.captured = true; } catch { /* pointeur parti */ }
  }

  function begin(kind, e, p, extra) {
    g = { kind, pid: e.pointerId, start: p, last: p, moved: false, captured: false, alt: e.altKey, client: { x: e.clientX, y: e.clientY }, ...extra };
    if (kind === 'pan') capture();            // une main n'a jamais besoin du double-clic
  }

  function handleMove(p) {
    switch (g.kind) {
      case 'pan': return movePan(p);
      case 'right': return moveRight(p);
      case 'marquee': return moveMarquee(p);
      case 'move': return moveNodes(p);
      case 'resize': return moveResize(p);
      case 'connect': return moveConnect(p);
      case 'gmove': return moveGroup(p);
      case 'gresize': return moveGroupResize(p);
      case 'gdraw': return moveSectionDraw(p);
    }
  }

  function finish(cur, cancelled) {
    switch (cur.kind) {
      case 'right': if (!cur.moved && !cancelled) openContextMenu(cur); return;
      case 'marquee': return endMarquee(cur, cancelled);
      case 'move': return endMove(cur, cancelled);
      case 'resize': return endResize(cur, cancelled);
      case 'connect': return endConnect(cur, cancelled);
      case 'gmove': return endGroupMove(cur, cancelled);
      case 'gresize': return endGroupResize(cur, cancelled);
      case 'gdraw': return endSectionDraw(cur, cancelled);
    }
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  /** Le geste dépasse le seuil de clic : il devient un glisser (et capture le pointeur). */
  function started(p, slop = CLICK_SLOP) {
    if (g.moved) return true;
    if (dist(p, g.start) <= slop) return false;
    g.moved = true;
    capture();
    return true;
  }

  // ── déplacer la vue ───────────────────────────────────────────────

  function startPan(e, p) {
    begin('pan', e, p, { prev: p });
    stage.classList.add('panning');
  }
  function movePan(p) {
    cam.panBy(p.x - g.prev.x, p.y - g.prev.y);
    g.prev = p;
  }

  // clic droit : menu s'il ne bouge pas, déplacement de la vue au-delà de 4 px
  function startRight(e, p, target) {
    const nodeEl = target.closest('.node');
    const wire = target.classList?.contains('w-hit') ? target.parentNode.dataset.id : null;
    const hs = !nodeEl && !wire && onCanvas(target) ? sectionUnder(local(e)) : null;
    begin('right', e, p, {
      prev: p,
      node: nodeEl?.dataset.id || null,
      wire,
      group: hs ? hs.id : null
    });
  }
  function moveRight(p) {
    if (!g.moved && !started(p, RIGHT_SLOP)) return;
    stage.classList.add('panning');
    cam.panBy(p.x - g.prev.x, p.y - g.prev.y);
    g.prev = p;
  }

  // ── sélection ─────────────────────────────────────────────────────

  /** Renvoie true si ce clic doit retirer le bloc de la sélection (s'il ne devient pas un glisser). */
  function selectOnDown(id, e) {
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const has = sel().nodes.has(id);
    if (additive) {
      if (!has) ed.setSelection({ nodes: [id], add: true });
    } else if (!has) ed.setSelection({ nodes: [id] });
    ed.views.get(id)?.raise(++ed.zTop);
    return additive && has;
  }

  function startMarquee(e, p) {
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    begin('marquee', e, p, { add, base: add ? [...sel().nodes] : [] });
  }
  function moveMarquee(p) {
    if (!started(p)) return;
    const x = Math.min(p.x, g.start.x), y = Math.min(p.y, g.start.y);
    const w = Math.abs(p.x - g.start.x), hh = Math.abs(p.y - g.start.y);
    const m = ed.marquee;
    m.hidden = false;
    m.style.transform = `translate(${x}px, ${y}px)`;
    m.style.width = `${w}px`;
    m.style.height = `${hh}px`;
    const a = cam.toWorld(x, y), b = cam.toWorld(x + w, y + hh);
    const hits = [];
    for (const n of ed.doc.nodes) {
      const bx = ed.nodeBox(n.id);
      if (bx.x < b.x && bx.x + bx.w > a.x && bx.y < b.y && bx.y + bx.h > a.y) hits.push(n.id);
    }
    ed.setSelection({ nodes: [...g.base, ...hits] }, true);
  }
  function endMarquee(cur) {
    ed.marquee.hidden = true;
    if (!cur.moved) {
      if (!cur.add) ed.setSelection({ nodes: [] });
      return;
    }
    emit('selection:changed', { ids: [...sel().nodes] });
  }

  // ── déplacer des blocs ────────────────────────────────────────────

  function startMove(e, p, id, toggle) {
    const ids = sel().nodes.has(id) ? [...sel().nodes] : [id];
    const orig = new Map(ids.map((k) => { const n = ed.doc.node(k); return [k, { x: n.x, y: n.y }]; }));
    begin('move', e, p, { id, ids, orig, toggle, additive: e.shiftKey || e.ctrlKey || e.metaKey });
  }

  function moveNodes(p) {
    if (!g.moved) {
      if (!started(p)) return;
      ed.history.begin('move');
      stage.classList.add('dragging');
      // le bloc porté s'élève à peine : son ombre s'allonge (120 ms), elle revient au lâcher
      for (const k of g.ids) ed.views.get(k)?.lift(true);
      g.box = unionBox(g.ids.map((k) => ({ ...ed.nodeBox(k), ...g.orig.get(k) })));
    }
    // Placement libre : le bloc suit le pointeur, sans repère ni aimant (Quentin
    // trouvait l'aimantation d'alignement désagréable). La grille n'aimante que si
    // on l'a demandée dans les réglages, ou en maintenant Alt.
    let ox = (p.x - g.start.x) / cam.z;
    let oy = (p.y - g.start.y) / cam.z;
    const b = g.box;
    if (ed.snap || g.alt) {
      ox = ed.snapValue(b.x + ox) - b.x;
      oy = ed.snapValue(b.y + oy) - b.y;
    }
    // demi-pixel monde : fluide même très zoomé, et des positions propres dans graph.json
    ox = Math.round(ox * 2) / 2; oy = Math.round(oy * 2) / 2;
    for (const k of g.ids) {
      const n = ed.doc.node(k), o = g.orig.get(k);
      if (!n) continue;
      n.x = o.x + ox;
      n.y = o.y + oy;
      ed.views.get(k)?.setPos(n.x, n.y);
      ed.wires.updateNode(k);
    }
    // la section où le bloc « entrera » s'il est lâché là s'éclaire
    if (ed.doc.groups.length) {
      const nb = { x: b.x + ox, y: b.y + oy, w: b.w, h: b.h };
      const into = sectionAt(ed.doc.groups, nb)?.id || null;
      if (into !== ed.sect.drop) { ed.sect.drop = into; ed.requestDraw(); }
    }
    if (ed.lod >= 1 || ed.doc.groups.length) ed.requestDraw();
    ed.minimap.request();
  }

  function endMove(cur, cancelled) {
    if (ed.sect.drop) { ed.sect.drop = null; ed.requestDraw(); }
    if (cur.moved) for (const k of cur.ids) ed.views.get(k)?.lift(false);
    if (!cur.moved) {
      // simple clic : sur un bloc déjà choisi, on revient à lui seul (ou on le retire avec Maj)
      if (cur.toggle) {
        const keep = [...sel().nodes].filter((k) => k !== cur.id);
        ed.setSelection({ nodes: keep });
      } else if (!cur.additive) ed.setSelection({ nodes: [cur.id] });
      return;
    }
    if (cancelled) {
      for (const k of cur.ids) {
        const n = ed.doc.node(k), o = cur.orig.get(k);
        if (n && o) { n.x = o.x; n.y = o.y; }
      }
      ed.history.cancel();
      ed.afterChange();
      return;
    }
    suppressClick();
    // lâché avec son centre dans une section : il y entre (elle l'enveloppe)
    adopt(ed.doc.groups, cur.ids.map((k) => ed.nodeBox(k)).filter(Boolean));
    ed.history.commit();
    ed.afterChange({ changed: new Set(), reason: 'move' });
  }

  // ── largeur d'un bloc ─────────────────────────────────────────────

  function startResize(e, p, id) {
    const n = ed.doc.node(id);
    ed.views.get(id)?.raise(++ed.zTop);
    begin('resize', e, p, { id, w0: n.w });
    stage.classList.add('resizing');
  }
  function moveResize(p) {
    if (!g.moved) {
      if (!started(p)) return;
      ed.history.begin('resize');
    }
    const n = ed.doc.node(g.id);
    if (!n) return;
    let w = g.w0 + (p.x - g.start.x) / cam.z;
    if (ed.snap || g.alt) w = Math.round(w / GRID) * GRID;
    w = Math.round(Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, w)));
    if (w === n.w) return;
    n.w = w;
    const v = ed.views.get(g.id);
    if (v) v.el.style.width = `${w}px`;
    ed.wires.updateNode(g.id);
  }
  function endResize(cur, cancelled) {
    stage.classList.remove('resizing');
    if (!cur.moved) return;
    if (cancelled) {
      const n = ed.doc.node(cur.id);
      if (n) n.w = cur.w0;
      ed.history.cancel();
      ed.afterChange();
      return;
    }
    ed.history.commit();
    ed.afterChange({ changed: new Set(), reason: 'resize' });
  }

  // ── tirer un fil ──────────────────────────────────────────────────

  function startConnect(e, p, nodeEl, dotEl) {
    const id = nodeEl.dataset.id;
    const node = ed.doc.node(id);
    let port, dir;
    if (dotEl.classList.contains('n-cdot')) {
      dir = dotEl.classList.contains('in') ? 'in' : 'out';
      port = (dir === 'in' ? nodeInputs(node) : nodeOutputs(node))[0]?.id;
    } else {
      const pe = dotEl.closest('.n-port');
      port = pe.dataset.port;
      dir = pe.dataset.dir;
    }
    if (!port) return;
    ed.views.get(id)?.raise(++ed.zTop);

    let origin = { node: id, port, dir };
    let detached = null;
    let frozen = null;
    hideTip();
    if (dir === 'in' && (e.ctrlKey || e.metaKey)) {
      // Ctrl + glisser depuis une entrée : on décroche le fil et on le rebranche ailleurs
      const list = ed.doc.edgesTo(id, port);
      const edge = list[list.length - 1];
      if (edge) {
        ed.history.begin('rewire');
        detached = { id: edge.id, from: { ...edge.from }, to: { ...edge.to } };
        // l'aperçu du bloc garde sa taille pendant le geste : ses entrées ne remontent pas sous le pointeur
        frozen = ed.views.get(id)?.el.querySelector('.n-preview') || null;
        if (frozen) frozen.style.height = `${frozen.offsetHeight}px`;
        ed.doc.removeEdge(edge.id);
        ed.wires.sync();
        ed.views.refreshPorts();
        origin = { node: edge.from.node, port: edge.from.port, dir: 'out' };
      }
    }

    const want = origin.dir === 'out' ? 'in' : 'out';
    const outType = origin.dir === 'out' ? ed.portType(origin.node, origin.port, 'out') : null;
    const inDef0 = origin.dir === 'in' ? nodePortDef(ed.doc.node(origin.node), origin.port, 'in') : null;
    const inType = inDef0?.type || null;
    // pas de boucle : on écarte l'amont (ou l'aval) du bloc d'origine
    const banned = origin.dir === 'out'
      ? new Set([origin.node, ...ed.doc.upstream(origin.node)])
      : new Set([origin.node, ...ed.doc.downstream(origin.node)]);
    // bloc Modèle : ses entrées rangées qui peuvent recevoir ce fil se montrent le temps du geste (« + Ajouter »)
    const revealed = [];
    if (want === 'in') {
      for (const v of ed.views.nodes.values()) {
        const n = banned.has(v.id) ? null : ed.doc.node(v.id);
        if (!n || n.collapsed || !isModelBlock(n)) continue;
        const conn = v._connected();
        const useful = new Set(usefulInputs(n, conn));
        const ids = hiddenInputs(n, conn).filter((d) => useful.has(d.id) && compatible(outType, d.type)).map((d) => d.id);
        if (ids.length) { v.setReveal(ids); if (v.reveal) revealed.push(v.id); }
      }
      if (revealed.length) ed.wires.sync();
    }
    const cands = [];
    for (const v of ed.views.nodes.values()) {
      let any = false;
      if (!banned.has(v.id)) {
        for (const [pid, prt] of v.ports[want]) {
          if (prt.def.unused) continue;            // bloc Modèle : entrée que son modèle ne prend pas (SPEC §23)
          const ok = want === 'in'
            ? compatible(outType, prt.def.type)
            : compatible(ed.portType(v.id, pid, 'out'), inType);
          if (!ok) continue;
          any = true;
          prt.el.classList.add('compat');
          const count = want === 'in' ? ed.connections(v.id, pid, 'in') : 0;
          // une entrée multiple bornée et pleine n'est plus « libre » (SPEC §17)
          const roomy = !!prt.def.multi && !(prt.def.max > 0 && count >= prt.def.max);
          // lâcher sur le corps du bloc : l'entrée principale d'un bloc Modèle d'abord, puis une entrée visible, et une
          // entrée montrée le temps du geste en dernier (audit 25/10, LIVE-2)
          const n = ed.doc.node(v.id);
          const rank = want === 'in' && isModelBlock(n)
            ? (mainPorts(blockFamily(n)).includes(pid) ? 0 : prt.def.peek ? 2 : 1) : 1;
          cands.push({ node: v.id, port: pid, el: prt.el, free: want === 'out' || count === 0 || roomy, rank });
        }
      }
      v.el.classList.toggle('no-compat', !any && v.id !== origin.node);
    }
    const ovw = ed.views.get(origin.node);
    const oport = ovw?.ports[origin.dir].get(origin.port);
    oport?.el.classList.add('origin');
    ed.world.classList.add('connecting');
    stage.classList.add('connecting-cursor');

    const type = origin.dir === 'out' ? outType : inType;
    preview.dataset.t = type || 'media';
    previewEnd.dataset.t = type || 'media';
    const w0 = cam.toWorld(p.x, p.y);
    begin('connect', e, p, { origin, want, cands, detached, revealed, frozen, target: null, endW: w0, shown: w0, tween: null, type, inType, outType });
    ed.connecting = g;
    drawPreview();
  }

  function moveConnect(p) {
    started(p);
    const w = cam.toWorld(p.x, p.y);
    let best = null, bd = MAGNET;
    for (const c of g.cands) {
      const a = ed.anchor(c.node, c.port, g.want);
      if (!a) continue;
      const s = cam.toScreen(a.x, a.y);
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d < bd) { bd = d; best = c; }
    }
    // un seul test de position par mouvement : ce qu'il y a sous le pointeur
    const hit = document.elementFromPoint(g.client.x, g.client.y);
    if (!best) {
      // tout le corps d'un bloc aimante, mais seulement vers un port compatible
      // *libre* : remplacer un fil existant demande de viser son port
      const under = hit?.closest('.node');
      if (under) {
        const free = g.cands.filter((c) => c.node === under.dataset.id && c.free);
        best = free.length ? free.reduce((a, c) => (c.rank < a.rank ? c : a)) : null;
      }
    }
    if (best !== g.target) {
      g.target?.el.classList.remove('target');
      best?.el.classList.add('target');
      g.target = best;
      g.tween = { from: { ...g.shown }, t0: performance.now() };
      tickTween();
    }
    g.endW = best ? ed.anchor(best.node, best.port, g.want) : w;
    if (!best) g.shown = g.endW;
    g.overNode = !!hit?.closest('.node, #dock, #zoombar, #minimap, #queue, #inspector');
    drawPreview();
  }

  // le bout du fil glisse jusqu'au centre du port visé (da.md §4.12 : 120 ms)
  function tickTween() {
    if (!g || g.kind !== 'connect' || !g.tween) return;
    if (!g.target) { g.tween = null; return; }
    const d = ms('pop');
    const k = d ? Math.min(1, (performance.now() - g.tween.t0) / d) : 1;
    const e = easeFn('out')(k);
    const to = g.endW;
    g.shown = { x: g.tween.from.x + (to.x - g.tween.from.x) * e, y: g.tween.from.y + (to.y - g.tween.from.y) * e };
    drawPreview();
    if (k < 1) requestAnimationFrame(tickTween);
    else g.tween = null;
  }

  function drawPreview() {
    if (!g || g.kind !== 'connect') return hidePreview();
    const a = ed.anchor(g.origin.node, g.origin.port, g.origin.dir);
    if (!a) return hidePreview();
    const endP = g.target && !g.tween ? g.endW : g.shown;
    const d = g.origin.dir === 'out' ? wirePathScreen(cam, a, endP) : wirePathScreen(cam, endP, a);
    preview.setAttribute('d', d);
    preview.style.display = '';
    const s = cam.toScreen(endP.x, endP.y);
    previewEnd.setAttribute('cx', s.x.toFixed(1));
    previewEnd.setAttribute('cy', s.y.toFixed(1));
    previewEnd.style.display = g.target ? 'none' : '';
  }

  function hidePreview() {
    preview.style.display = 'none';
    previewEnd.style.display = 'none';
  }

  function clearConnectClasses() {
    ed.world.classList.remove('connecting');
    for (const el of ed.nodesEl.querySelectorAll('.n-port.compat, .n-port.target, .n-port.origin')) el.classList.remove('compat', 'target', 'origin');
    for (const el of ed.nodesEl.querySelectorAll('.node.no-compat')) el.classList.remove('no-compat');
  }

  function endConnect(cur, cancelled) {
    ed.connecting = null;
    clearConnectClasses();
    hidePreview();
    hideTip();
    if (cur.frozen) cur.frozen.style.height = '';
    // les entrées montrées le temps du geste se rangent, sur TOUS les blocs (celle qui vient de recevoir le fil reste :
    // elle est reliée) — rien ne doit survivre à la fin d'un geste, quelle qu'en soit la cause
    let tidied = false;
    for (const v of ed.views.nodes.values()) if (v.reveal) { v.setReveal(null); tidied = true; }
    if (tidied || cur.revealed?.length) ed.wires.sync();
    const { origin, detached, target } = cur;
    if (cancelled || (!cur.moved && detached)) {
      if (detached) {
        ed.doc.addEdge(detached);
        ed.history.cancel();
        ed.afterChange();
      }
      return;
    }
    if (target) {
      const [a, ap, b, bp] = origin.dir === 'out'
        ? [origin.node, origin.port, target.node, target.port]
        : [target.node, target.port, origin.node, origin.port];
      const id = ed.connect(a, ap, b, bp, { quiet: false });
      // le fil s'est posé : un battement de la pastille qui le reçoit (220 ms, sans halo)
      if (id) ed.views.get(target.node)?.pulsePort(target.port, origin.dir === 'out' ? 'in' : 'out');
    } else if (cur.moved && !detached && !cur.overNode) {
      // lâché dans le vide : palette filtrée, bloc posé là et déjà relié
      const at = cam.toWorld(cur.last.x, cur.last.y);
      ed.palette.open({
        at,
        from: { node: origin.node, port: origin.port, dir: origin.dir, type: cur.type }
      });
    }
    if (detached) {
      ed.history.commit();
      ed.afterChange({ reason: 'rewire' });
    }
  }

  // ── fils : survol, clic, coupe ────────────────────────────────────

  ed.wiresSvg.addEventListener('pointerover', (e) => {
    if (g || !e.target.classList?.contains('w-hit')) return;
    const id = e.target.parentNode.dataset.id;
    clearTimeout(cutHideT);
    if (ed.hoverEdge !== id) {
      const prev = ed.hoverEdge;
      ed.hoverEdge = id;
      restyleEdge(prev);
      restyleEdge(id);
    }
    if (!ed.readonly) placeCut();
  });
  ed.wiresSvg.addEventListener('pointerout', (e) => {
    if (!e.target.classList?.contains('w-hit')) return;
    scheduleCutHide();
  });
  cutBtn.addEventListener('pointerenter', () => clearTimeout(cutHideT));
  cutBtn.addEventListener('pointerleave', scheduleCutHide);
  cutBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
  cutBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = ed.hoverEdge;
    hideCut();
    if (id) { ed.cutEdge = id; ed.disconnect(id); }
  });

  function restyleEdge(id) { const e = id && ed.doc.edge(id); if (e) ed.wires.style(e); }

  function placeCut() {
    const id = ed.hoverEdge;
    const m = id && ed.wires.midpoint(id);
    if (!m || ed.lod >= 2) { cutBtn.hidden = true; return; }
    const s = cam.toScreen(m.x, m.y);
    cutBtn.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, -50%)`;
    cutBtn.hidden = false;
  }
  function scheduleCutHide() {
    clearTimeout(cutHideT);
    cutHideT = setTimeout(hideCut, 260);
  }
  function hideCut() {
    clearTimeout(cutHideT);
    cutBtn.hidden = true;
    const prev = ed.hoverEdge;
    ed.hoverEdge = null;
    restyleEdge(prev);
  }

  function clickWire(e, id) {
    if (e.altKey) { hideCut(); ed.cutEdge = id; ed.disconnect(id); return; }   // Alt + clic = couper
    ed.setSelection({ nodes: [], edge: id });
  }

  // ── sections (SPEC §15) ───────────────────────────────────────────

  /** Survol de la planche nue : curseur adapté au titre, au bord ou à la poignée visés. */
  function hoverSections(e, p) {
    if (!ed.project) return;
    let cursor = '', hot = null;
    if (ed.tool === 'section') cursor = 'crosshair';
    else if (ed.doc.groups.length && !ed.readonly && onCanvas(e.target)) {
      const hs = sectionUnder(p);
      if (hs) { cursor = CURSORS[hs.part] || ''; hot = hs.id; }
    }
    if (stage.style.cursor !== cursor) stage.style.cursor = cursor;
    if (hot !== ed.sect.hot) { ed.sect.hot = hot; ed.requestDraw(); }
  }

  function startGroupMove(e, p, id) {
    const grp = ed.doc.group(id);
    if (!grp) return;
    ed.setSelection({ nodes: [], group: id });
    // ce qui est entièrement dedans part avec la section (comme dans Slate)
    const m = membersOf(grp, ed.doc.nodes, ed.doc.groups, (k) => ed.nodeBox(k));
    const nodes = m.nodeIds.map((k) => { const n = ed.doc.node(k); return { id: k, x: n.x, y: n.y }; });
    const groups = m.groupIds.map((k) => { const o = ed.doc.group(k); return { id: k, x: o.x, y: o.y }; });
    begin('gmove', e, p, { id, x0: grp.x, y0: grp.y, nodes, groups });
  }
  function moveGroup(p) {
    if (!g.moved) {
      if (!started(p)) return;
      ed.history.begin('group-move');
      stage.classList.add('dragging');
    }
    let dx = (p.x - g.start.x) / cam.z, dy = (p.y - g.start.y) / cam.z;
    if (ed.snap || g.alt) { dx = ed.snapValue(g.x0 + dx) - g.x0; dy = ed.snapValue(g.y0 + dy) - g.y0; }
    dx = Math.round(dx); dy = Math.round(dy);
    const grp = ed.doc.group(g.id);
    if (!grp) return;
    grp.x = g.x0 + dx; grp.y = g.y0 + dy;
    for (const o of g.groups) {
      const og = ed.doc.group(o.id);
      if (og) { og.x = o.x + dx; og.y = o.y + dy; }
    }
    for (const o of g.nodes) {
      const n = ed.doc.node(o.id);
      if (!n) continue;
      n.x = o.x + dx; n.y = o.y + dy;
      ed.views.get(o.id)?.setPos(n.x, n.y);
      ed.wires.updateNode(o.id);
    }
    ed.requestDraw();
    ed.minimap.request();
  }
  function endGroupMove(cur, cancelled) {
    if (!cur.moved) return;
    if (cancelled) {
      const grp = ed.doc.group(cur.id);
      if (grp) { grp.x = cur.x0; grp.y = cur.y0; }
      for (const o of cur.groups) { const og = ed.doc.group(o.id); if (og) { og.x = o.x; og.y = o.y; } }
      for (const o of cur.nodes) { const n = ed.doc.node(o.id); if (n) { n.x = o.x; n.y = o.y; } }
      ed.history.cancel();
      ed.afterChange();
      return;
    }
    suppressClick();
    ed.history.commit();
    ed.afterChange({ changed: new Set(), reason: 'group-move' });
  }

  function startGroupResize(e, p, id, part) {
    const grp = ed.doc.group(id);
    if (!grp) return;
    ed.setSelection({ nodes: [], group: id });
    begin('gresize', e, p, { id, part, g0: { x: grp.x, y: grp.y, w: grp.w, h: grp.h } });
  }
  function moveGroupResize(p) {
    if (!g.moved) {
      if (!started(p)) return;
      ed.history.begin('group-resize');
      stage.classList.add('resizing');
      stage.style.cursor = CURSORS[g.part] || '';
    }
    const grp = ed.doc.group(g.id);
    if (!grp) return;
    const dx = (p.x - g.start.x) / cam.z, dy = (p.y - g.start.y) / cam.z;
    Object.assign(grp, resizeBox(g.g0, g.part, dx, dy, ed.snap || g.alt ? ed.snapValue : null));
    ed.requestDraw();
    ed.minimap.request();
  }
  function endGroupResize(cur, cancelled) {
    if (!cur.moved) return;
    if (cancelled) {
      const grp = ed.doc.group(cur.id);
      if (grp) Object.assign(grp, cur.g0);
      ed.history.cancel();
      ed.afterChange();
      return;
    }
    suppressClick();
    ed.history.commit();
    ed.afterChange({ changed: new Set(), reason: 'group-resize' });
  }

  // outil « Section » : bouton du dock ou S, puis glisser pour dessiner le cadre
  function setTool(tool) {
    ed.tool = tool && !ed.readonly ? tool : null;
    ed.syncTool();
    stage.style.cursor = ed.tool === 'section' ? 'crosshair' : '';
  }
  function toggleSectionTool() { setTool(ed.tool === 'section' ? null : 'section'); }

  function startSectionDraw(e, p) {
    const w = cam.toWorld(p.x, p.y);
    begin('gdraw', e, p, { w0: w });
  }
  function drawBox(p) {
    const a = g.w0, b = cam.toWorld(p.x, p.y);
    let box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    if (ed.snap || g.alt) {
      const x1 = ed.snapValue(box.x + box.w), y1 = ed.snapValue(box.y + box.h);
      box.x = ed.snapValue(box.x); box.y = ed.snapValue(box.y);
      box = { ...box, w: x1 - box.x, h: y1 - box.y };
    }
    return box;
  }
  function moveSectionDraw(p) {
    if (!started(p)) return;
    const box = drawBox(p);
    ed.sect.ghost = { id: '__ghost', ...box, title: '', tone: null };
    ed.requestDraw();
  }
  function endSectionDraw(cur, cancelled) {
    ed.sect.ghost = null;
    setTool(null);
    if (cancelled) { ed.requestDraw(); return; }
    let box;
    if (cur.moved) {
      g = cur;                      // drawBox lit g
      box = drawBox(cur.last);
      g = null;
    }
    const tiny = !box || box.w * cam.z < 12 || box.h * cam.z < 12;
    if (tiny) {
      // un simple clic : une section de taille courante centrée sur le point (Slate : 900 × 600)
      const c = cur.w0;
      box = { x: ed.snapValue(c.x - 360), y: ed.snapValue(c.y - 216), w: 720, h: 432 };
    }
    box.w = Math.max(120, Math.round(box.w)); box.h = Math.max(80, Math.round(box.h));
    suppressClick();
    ed.addSection(box, { edit: true });
  }

  /** Ctrl+G : une section autour de la sélection (marge 48 px), nom tout de suite en édition. */
  function groupSelection() {
    const ids = [...sel().nodes];
    if (!ids.length) return null;
    return ed.addSection({ around: ids }, { edit: true });
  }

  /**
   * Renommer une section : un champ en place sur son titre (Entrée valide,
   * Échap annule). `select` : tout le texte sélectionné (création).
   */
  let rn = null;     // { id, input, before }
  function renameSection(id, { select = true } = {}) {
    const grp = ed.doc.group(id);
    if (!grp || ed.readonly) return;
    finishSectionRename(true);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'g-title-input';
    input.spellcheck = false;
    input.value = grp.title || t('graph.section');
    ed.overlay.append(input);
    rn = { id, input };
    ed.sect.editing = id;
    ed.setSelection({ nodes: [], group: id });
    placeSectionRename();
    ed.requestDraw();
    input.focus({ preventScroll: true });
    if (select) input.select(); else input.setSelectionRange(input.value.length, input.value.length);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finishSectionRename(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finishSectionRename(false); }
    });
    input.addEventListener('input', placeSectionRename);
    input.addEventListener('blur', () => finishSectionRename(true));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
  }
  function placeSectionRename() {
    if (!rn) return;
    const grp = ed.doc.group(rn.id);
    if (!grp) { finishSectionRename(false); return; }
    const s = cam.toScreen(grp.x, grp.y);
    const fs = titlePx(cam.z, ed.lod), lift = titleLift(ed.lod);
    const st = rn.input.style;
    st.font = `700 ${fs}px var(--font-ui)`;
    st.color = toneColor(grp.tone, document.body.classList.contains('theme-light') ? 'light' : 'dark', getComputedStyle(stage).getPropertyValue('--accent').trim() || '#4d82f3');
    st.height = `${Math.round(fs * 1.5)}px`;
    st.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y - lift - fs * 1.2)}px)`;
    st.width = `${Math.max(140, Math.min(480, rn.input.value.length * fs * 0.62 + 40))}px`;
  }
  function finishSectionRename(ok) {
    if (!rn) return;
    const { id, input } = rn;
    rn = null;
    ed.sect.editing = null;
    const v = input.value.trim();
    input.remove();
    const grp = ed.doc.group(id);
    if (ok && grp) {
      const next = v || t('graph.section');
      if (grp.title !== next) ed.mutate('group-rename', () => { grp.title = next; });
    }
    ed.requestDraw();
  }

  function setTone(id, tone) {
    const grp = ed.doc.group(id);
    if (!grp) return;
    ed.mutate('group-tone', () => { grp.tone = tone; });
  }

  function renameNode(id) {
    const v = ed.views.get(id);
    v?.startRename((val) => {
      if (val == null) return;
      const n = ed.doc.node(id);
      if (!n) return;
      // retrouver le nom par défaut (type, rôle de recette, fichier) = effacer le titre
      const def = typeOf(n.type);
      const next = !val || val === defaultTitle(n) || (def && val === tl(def.label)) ? null : val;
      if (n.title !== next) ed.updateNode(id, { title: next });
    });
  }

  // ── défilement automatique au bord pendant un glisser ─────────────

  let autoRaf = 0, autoV = { x: 0, y: 0 };
  function autoPan(p) {
    if (!g || !g.moved || !['move', 'connect', 'marquee', 'gmove', 'gdraw'].includes(g.kind)) return;
    const w = rect.width, hh = rect.height;
    const v = (d) => (d < EDGE ? (EDGE - d) / EDGE : 0);
    autoV = { x: v(p.x) * 14 - v(w - p.x) * 14, y: v(p.y - 44) * 14 - v(hh - p.y) * 14 };
    if ((autoV.x || autoV.y) && !autoRaf) autoRaf = requestAnimationFrame(tickAuto);
  }
  function tickAuto() {
    autoRaf = 0;
    if (!g || (!autoV.x && !autoV.y)) return;
    cam.panBy(autoV.x, autoV.y);
    if (g.kind === 'move' || g.kind === 'gmove' || g.kind === 'marquee') {
      // le bloc reste sous le pointeur : on décale l'origine du geste d'autant
      g.start = { x: g.start.x + autoV.x, y: g.start.y + autoV.y };
    }
    handleMove(g.last);
    autoRaf = requestAnimationFrame(tickAuto);
  }
  function stopAutoPan() { if (autoRaf) cancelAnimationFrame(autoRaf); autoRaf = 0; autoV = { x: 0, y: 0 }; }

  // ── molette, trackpad ─────────────────────────────────────────────

  function isMouseNotch(e) {
    if (e.deltaMode !== 0) return true;                       // lignes / pages : forcément une molette
    if (e.deltaX !== 0) return false;                          // une molette ne fait pas de diagonale
    // wheelDeltaY présent : il tranche (crans Win32 = multiples de 120). Un
    // pavé tactile de précision peut donner un deltaY entier ≥ 48 lors d'un
    // mouvement vif : ce n'est pas un cran.
    const wd = Math.abs(e.wheelDeltaY || 0);
    if (wd) return wd >= 120 && wd % 120 === 0;
    return Math.abs(e.deltaY) >= 48 && Number.isInteger(e.deltaY);   // heuristique de Slate, en secours
  }
  const notches = (e) => Math.max(1, Math.round(Math.abs(e.wheelDeltaY || 120) / 120));

  stage.addEventListener('wheel', (e) => {
    if (!ed.project) return;
    if (!(e.ctrlKey || e.metaKey) && scrollsInside(e.target, e)) return;   // un champ long défile
    e.preventDefault();
    rect = stage.getBoundingClientRect();
    const p = local(e);
    // un défilement fractionnaire ou en diagonale est forcément un pavé tactile
    if (e.deltaX !== 0 || !Number.isInteger(e.deltaY)) lastTrackpadAt = e.timeStamp;
    let notch = isMouseNotch(e);
    // un même geste garde sa nature : un delta « rond » au milieu d'un défilement trackpad n'est pas un cran
    if (notch && e.timeStamp - lastTrackpadAt < 140) notch = false;
    if (!notch) lastTrackpadAt = e.timeStamp;
    ed.wheelAt = performance.now();
    cam.stop();
    if (e.ctrlKey || e.metaKey) {
      if (notch) ed.smooth.by(p, Math.pow(NOTCH, -Math.sign(e.deltaY) * notches(e)));
      else {
        ed.smooth.stop();
        const k = Math.exp(-e.deltaY / 100);                     // pincement : collé aux doigts
        cam.zoomAt(p.x, p.y, Math.min(2, Math.max(0.5, k)));
      }
    } else if (notch) {
      ed.smooth.by(p, Math.pow(NOTCH, -Math.sign(e.deltaY) * notches(e)));
    } else {
      ed.smooth.stop();
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;   // Maj + molette = horizontal
      const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      cam.panBy(-dx, -dy);
    }
    if (g) handleMove(g.last);
  }, { passive: false });

  /** La cible (dans un bloc) peut-elle encore défiler dans ce sens ? */
  function scrollsInside(el, e) {
    const node = el.closest?.('.node');
    if (!node) return false;
    for (let n = el; n && n !== node; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const dy = e.deltaY, dx = e.deltaX;
      if (dy && /(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) {
        if ((dy < 0 && n.scrollTop > 0) || (dy > 0 && n.scrollTop + n.clientHeight < n.scrollHeight - 1)) return true;
      }
      if (dx && /(auto|scroll)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1) {
        if ((dx < 0 && n.scrollLeft > 0) || (dx > 0 && n.scrollLeft + n.clientWidth < n.scrollWidth - 1)) return true;
      }
    }
    return false;
  }

  // ── clavier ───────────────────────────────────────────────────────

  const boardVisible = () => !!ed.project && !ed.board.closest('[hidden]') && ed.stage.offsetParent !== null;
  const overlayOpen = () => {
    if (ed.palette.isOpen) return true;
    const cm = document.getElementById('contextmenu');
    if (cm && !cm.hidden && cm.childElementCount) return true;
    const mr = document.getElementById('modal-root');
    if (mr && mr.childElementCount) return true;
    const vw = document.getElementById('viewer');
    return !!(vw && !vw.hidden);
  };

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !isTyping(e.target) && boardVisible() && !overlayOpen()) {
      // Espace maintenu = main ; on empêche aussi qu'un bouton qui a le focus ne s'active
      e.preventDefault();
      if (!e.repeat) { spaceDown = true; stage.classList.add('space'); }
      return;
    }
    if (!boardVisible() || e.defaultPrevented || isTyping(e.target) || overlayOpen()) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const done = () => { e.preventDefault(); e.stopPropagation(); };

    if (k === 'Escape') {
      if (g) { const cur = g; g = null; stopAutoPan(); finish(cur, true); stage.classList.remove('panning', 'dragging', 'connecting-cursor', 'resizing'); return done(); }
      if (ed.tool) { setTool(null); return done(); }
      if (sel().nodes.size || sel().edge || sel().group) { ed.setSelection({ nodes: [] }); return done(); }
      return;
    }
    if (g) return;      // pas de raccourci au milieu d'un geste

    if (mod && !e.altKey) {
      if (k === 'z' && !e.shiftKey) { ed.api.undo(); return done(); }
      if ((k === 'z' && e.shiftKey) || k === 'y') { ed.api.redo(); return done(); }
      if (k === 'c') { if (ed.clipboard.copy()) done(); return; }
      if (k === 'x') { if (ed.clipboard.cut()) done(); return; }
      if (k === 'v') { ed.clipboard.onPasteKey(); return; }   // l'évènement « paste » suit
      if (k === 'd') { ed.clipboard.duplicate(); return done(); }
      if (k === 'a') { ed.setSelection({ nodes: ed.doc.nodes.map((n) => n.id) }); return done(); }
      if (k === 'g') { if (e.shiftKey) ungroupSelected(); else groupSelection(); return done(); }
      if (e.code === 'Digit0' || e.code === 'Numpad0') { zoomTo(1); return done(); }
      if (k === '+' || k === '=' || e.code === 'NumpadAdd') { ed.smooth.by(center(), 1.25); return done(); }
      if (k === '-' || e.code === 'NumpadSubtract') { ed.smooth.by(center(), 1 / 1.25); return done(); }
      return;
    }
    if (e.altKey) return;

    if (k === 'Delete' || k === 'Backspace') { deleteSelection(); return done(); }
    if (e.shiftKey && (e.code === 'Digit1' || e.code === 'Numpad1')) { ed.fit(); return done(); }
    if (e.shiftKey && (e.code === 'Digit2' || e.code === 'Numpad2')) { ed.fit([...sel().nodes]); return done(); }
    if (k === 'f' && !e.shiftKey) { ed.fit(sel().nodes.size ? [...sel().nodes] : null); return done(); }
    if (k === 'm' && !e.shiftKey) { ed.minimap.toggle(); return done(); }
    if (k === 's' && !e.shiftKey && !ed.readonly) { toggleSectionTool(); return done(); }
    if (k === 'Tab') {
      const p = ed.pointer && inStage(ed.pointer) ? cam.toWorld(ed.pointer.x, ed.pointer.y) : null;
      ed.palette.open({ at: p });
      return done();
    }
    if (k.startsWith('Arrow') && sel().nodes.size) {
      const step = e.shiftKey ? GRID : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[k];
      if (!d) return;
      const ids = [...sel().nodes];
      ed.mutate('nudge', () => {
        for (const id of ids) { const n = ed.doc.node(id); if (n) { n.x += d[0]; n.y += d[1]; } }
      }, { key: 'nudge', changed: new Set() });
      return done();
    }
  }, true);

  // Échap dans un champ d'un bloc : on rend la main à la planche (sinon tous les
  // raccourcis restent muets jusqu'au prochain clic). Écouté en phase de
  // remontée : un contrôle de F qui gère Échap lui-même passe avant.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !boardVisible() || overlayOpen()) return;
    const el = e.target;
    if (!isTyping(el) || !ed.world.contains(el) || el.matches?.(RENAME_INPUTS)) return;
    e.preventDefault();
    el.blur();
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { spaceDown = false; stage.classList.remove('space'); }
  });
  window.addEventListener('blur', () => { spaceDown = false; stage.classList.remove('space'); });

  const center = () => ({ x: cam.vw / 2, y: cam.vh / 2 });
  const inStage = (p) => p.x >= 0 && p.y >= 0 && p.x <= rect.width && p.y <= rect.height;

  function zoomTo(z) {
    const c = cam.settled;
    const cx = c.x + cam.vw / 2 / c.z, cy = c.y + cam.vh / 2 / c.z;
    cam.animateTo({ z, x: cx - cam.vw / 2 / z, y: cy - cam.vh / 2 / z }, ms('card'));
  }

  function deleteSelection() {
    const s = sel();
    if (s.nodes.size) return ed.removeNodes([...s.nodes]);
    if (s.edge) { ed.cutEdge = s.edge; return ed.disconnect(s.edge); }
    if (s.group) return removeSection(s.group);
    return false;
  }

  /** Supprimer une section ne supprime jamais ses blocs. */
  function removeSection(id) {
    if (rn?.id === id) finishSectionRename(false);
    return ed.mutate('ungroup', () => ed.doc.removeGroup(id));
  }

  function ungroupSelected() {
    const id = sel().group;
    if (id) removeSection(id);
  }

  // ── menus contextuels (menu.js de D) ──────────────────────────────

  function openContextMenu(cur) {
    const at = { x: cur.start.x + rect.left, y: cur.start.y + rect.top };
    const w = cam.toWorld(cur.start.x, cur.start.y);
    if (cur.node) {
      if (!sel().nodes.has(cur.node)) ed.setSelection({ nodes: [cur.node] });
      return openNodeMenu(cur.node, at);
    }
    if (cur.wire) {
      ed.setSelection({ nodes: [], edge: cur.wire });
      return openMenu([
        { label: t('graph.menu.cut'), icon: 'g-cut', key: t('graph.key.altClick'), danger: true, disabled: ed.readonly, action: () => { ed.cutEdge = cur.wire; ed.disconnect(cur.wire); } }
      ], at);
    }
    if (cur.group) {
      ed.setSelection({ nodes: [], group: cur.group });
      return openGroupMenu(cur.group, at);
    }
    openMenu(canvasItems(w), at);
  }

  function canvasItems(w) {
    const ro = ed.readonly;
    const many = ed.doc.nodes.length > 1;
    return [
      { label: t('graph.menu.addNode'), icon: 'plus', key: 'Tab', disabled: ro, action: () => ed.palette.open({ at: w }) },
      { label: t('graph.menu.recipes'), icon: 'recipe', disabled: ro, submenu: recipes().map((r) => ({
        label: tl(r.label), icon: r.icon, action: () => ed.insertRecipe(r, w)
      })) },
      { label: t('graph.menu.newSection'), icon: 'g-frame', key: 'S', disabled: ro, action: () => {
        const ids = [...sel().nodes];
        if (ids.length) ed.addSection({ around: ids }, { edit: true });
        else ed.addSection({ x: ed.snapValue(w.x - 360), y: ed.snapValue(w.y - 216), w: 720, h: 432 }, { edit: true });
      } },
      'sep',
      { label: t('graph.menu.paste'), icon: 'copy', key: 'Ctrl V', disabled: ro, action: () => ed.clipboard.paste(w) },
      { label: t('graph.menu.selectAll'), icon: 'g-select-all', key: 'Ctrl A', disabled: !ed.doc.nodes.length, action: () => ed.setSelection({ nodes: ed.doc.nodes.map((n) => n.id) }) },
      { label: t('graph.menu.arrange'), icon: 'g-arrange', disabled: ro || !many, action: () => ed.arrange(sel().nodes.size > 1 ? [...sel().nodes] : null) },
      { label: t('graph.menu.fitAll'), icon: 'fit', key: t('graph.key.shift1'), action: () => ed.fit() },
      'sep',
      { label: t('graph.menu.snap'), icon: ed.snap ? 'check' : 'g-snap', action: () => ed.setPref({ snap: !ed.snap }) },
      { label: t('graph.menu.minimap'), icon: ed.minimap.visible ? 'check' : 'g-minimap', key: 'M', action: () => ed.minimap.toggle() }
    ];
  }

  function openNodeMenu(id, at) {
    const node = ed.doc.node(id);
    if (!node) return;
    if (!sel().nodes.has(id)) ed.setSelection({ nodes: [id] });
    const ids = [...sel().nodes];
    const many = ids.length > 1;
    const def = typeOf(node.type);
    const ro = ed.readonly;
    const out = resultOf(node);
    const items = [];
    if (computes(node.type)) {
      const run = (mode) => {
        const list = ids.filter((k) => computes(ed.doc.node(k)?.type) && !ed.doc.node(k)?.bypass)
          .sort((a, b) => ed.doc.node(a).x - ed.doc.node(b).x);
        for (const k of list) emit('node:run', { nodeId: k, mode: mode ?? null });
      };
      if (def?.modes?.length) {
        items.push({ label: t('graph.menu.runPreview'), icon: 'play', disabled: ro || node.bypass, action: () => run('preview') });
        items.push({ label: t('graph.menu.runFinal'), icon: 'play', disabled: ro || node.bypass, action: () => run('final') });
      } else items.push({ label: t('graph.menu.run'), icon: 'play', disabled: ro || node.bypass, action: () => run(null) });
      items.push('sep');
    }
    items.push(
      { label: t('graph.menu.inspect'), icon: 'gear', action: () => emit('inspector:open', { nodeId: id }) },
      { label: t('graph.menu.rename'), icon: 'g-rename', disabled: ro || many, action: () => renameNode(id) },
      { label: t('graph.menu.duplicate'), icon: 'g-duplicate', key: 'Ctrl D', disabled: ro, action: () => ed.clipboard.duplicate() },
      { label: node.collapsed ? t('graph.menu.expand') : t('graph.menu.collapse'), icon: 'g-collapse', disabled: ro, action: () => {
        const v = !node.collapsed;
        ed.mutate('collapse', () => { for (const k of ids) { const n = ed.doc.node(k); if (n) n.collapsed = v; } }, { changed: new Set() });
      } }
    );
    if (computes(node.type)) {
      items.push({ label: node.bypass ? t('graph.menu.enable') : t('graph.menu.bypass'), icon: 'g-bypass', disabled: ro, action: () => {
        const v = !node.bypass;
        ed.mutate('bypass', () => { for (const k of ids) { const n = ed.doc.node(k); if (n && computes(n.type)) n.bypass = v; } }, { changed: new Set(ids) });
      } });
    }
    items.push({ label: t('graph.menu.group'), icon: 'g-frame', key: 'Ctrl G', disabled: ro, action: () => groupSelection() });
    if (many) items.push({ label: t('graph.menu.arrange'), icon: 'g-arrange', disabled: ro, action: () => ed.arrange(ids) });
    items.push('sep');
    if (out) {
      items.push({ label: t('graph.menu.view'), icon: 'fit', action: () => emit('viewer:open', { nodeId: id, rel: out.rel, kind: out.kind }) });
    }
    items.push(
      { label: node.type === 'import' ? t('graph.menu.revealSource') : t('graph.menu.reveal'), icon: 'reveal', disabled: !out || many, action: () => reveal(out) },
      { label: t('graph.menu.copyPath'), icon: 'copy', disabled: !out || many, action: () => copyPath(out) },
      'sep',
      { label: t('graph.menu.delete'), icon: 'trash', key: t('graph.key.del'), danger: true, disabled: ro, action: () => ed.removeNodes(ids) }
    );
    openMenu(items, at);
  }

  /** Pastille de teinte (menu « Teinte › »), aux couleurs du thème. */
  // la même pastille que la couleur d'un projet (home.js swatch) : un rond, cerclé quand c'est le choix courant
  function swatch(tone, current = false) {
    const theme = document.body.classList.contains('theme-light') ? 'light' : 'dark';
    const accent = getComputedStyle(stage).getPropertyValue('--accent').trim() || '#4d82f3';
    const c = toneColor(tone, theme, accent);
    return '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">'
      + `<circle cx="8" cy="8" r="${current ? 4.2 : 5}" fill="${c}"/>`
      + (current ? `<circle cx="8" cy="8" r="6.9" fill="none" stroke-width="1.4" stroke="${c}"/>` : '')
      + '</svg>';
  }

  function openGroupMenu(id, at) {
    const grp = ed.doc.group(id);
    if (!grp) return;
    const ro = ed.readonly;
    const cur = toneKey(grp.tone);
    openMenu([
      { label: t('graph.menu.rename'), icon: 'g-rename', disabled: ro, action: () => renameSection(id) },
      { label: t('graph.menu.tone'), icon: 'g-tone', disabled: ro, submenu: TONE_MENU.map((tone) => ({
        label: t(`graph.tone.${tone || 'none'}`),
        icon: swatch(tone, cur === tone),
        action: () => setTone(id, tone)
      })) },
      { label: t('graph.menu.selectContent'), icon: 'g-select-all', action: () => {
        ed.setSelection({ nodes: membersOf(grp, ed.doc.nodes, ed.doc.groups, (k) => ed.nodeBox(k)).nodeIds });
      } },
      'sep',
      { label: t('graph.menu.ungroup'), icon: 'g-ungroup', key: t('graph.key.ungroup'), disabled: ro, action: () => removeSection(id) }
    ], at);
  }

  function openZoomMenu(anchor) {
    const s = sel().nodes;
    openMenu([
      { label: t('graph.zoom.fit'), icon: 'fit', key: t('graph.key.shift1'), action: () => ed.fit() },
      { label: t('graph.zoom.fitSel'), key: 'F', disabled: !s.size, action: () => ed.fit([...s]) },
      'sep',
      ...[0.5, 1, 2].map((z) => ({ label: t('graph.zoom.pct', { n: Math.round(z * 100) }), key: z === 1 ? 'Ctrl 0' : undefined, action: () => zoomTo(z) }))
    ], anchor);
  }

  /** Fichier montrable d'un bloc : sa source (Média) ou le premier fichier de sa version courante. */
  function resultOf(node) {
    if (node.type === 'import') {
      const d = node.data || {};
      return d.src ? { rel: d.src, kind: d.kind || 'image' } : null;
    }
    const run = ed.runs.current(node.id);
    const first = run?.outputs ? Object.values(run.outputs)[0] : null;
    return first?.path ? { rel: first.path, kind: first.kind || 'image' } : null;
  }

  function reveal(out) {
    if (!out) return toast(t('graph.toast.noResult'), { kind: 'info' });
    window.mia?.shell?.reveal({ projectId: ed.project.id, rel: out.rel });
  }
  async function copyPath(out) {
    if (!out) return toast(t('graph.toast.noResult'), { kind: 'info' });
    try {
      await window.mia?.shell?.copyPath({ projectId: ed.project.id, rel: out.rel });
      toast(t('graph.toast.pathCopied'), { kind: 'ok' });
    } catch (e) { toast(String(e?.message || e), { kind: 'error' }); }
  }

  // ── petits outils ─────────────────────────────────────────────────

  function isInteractive(target, nodeEl) {
    if (target.closest('.n-controls')) return true;        // réglages : on ne déplace jamais le bloc par là
    const hit = target.closest(INTERACTIVE);
    return !!(hit && nodeEl.contains(hit));
  }

  function blurInside() {
    const a = document.activeElement;
    if (a && a !== document.body && ed.world.contains(a)) a.blur();
  }

  /** Après un glisser, le « click » qui suit ne doit pas déclencher le contrôle de F lâché dessous. */
  function suppressClick() {
    const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
    window.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0);
  }

  function unionBox(list) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of list) {
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  return {
    get busy() { return !!g; },
    cancel() {
      finishSectionRename(true);
      if (!g) return;
      const cur = g;
      g = null;
      stopAutoPan();
      stage.classList.remove('panning', 'dragging', 'connecting-cursor', 'resizing');
      finish(cur, true);
    },
    /** La caméra a bougé : le calque écran suit. */
    onCamera() {
      if (!cutBtn.hidden) placeCut();
      if (g?.kind === 'connect') drawPreview();
      if (rn) placeSectionRename();
    },
    onNodeResized() { if (g?.kind === 'connect') drawPreview(); },
    openNodeMenu,
    openZoomMenu,
    groupSelection,
    renameNode,
    renameSection,
    toggleSectionTool,
    setTool
  };
}


