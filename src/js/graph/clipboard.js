// ── Copier, coller, dupliquer ─────────────────────────────────────────
// Copier garde les blocs choisis et les fils qui les relient entre eux, en
// mémoire et dans le presse-papiers système (texte `mia-graph:` + JSON, pour
// passer d'un projet à l'autre). Coller pose des copies neuves sous le
// pointeur. Le presse-papiers sait aussi apporter une image (capture d'écran)
// ou des fichiers copiés dans l'Explorateur : ils deviennent des blocs Média.
//
// Dupliquer (Ctrl+D) garde en plus les fils *entrants* : on obtient une
// variante branchée sur la même source, posée juste dessous — le geste pour
// comparer deux réglages.

import { t, tn } from '../i18n.js';
import { toast } from '../ui/toasts.js';
import { typeOf } from '../catalog.js';
import { plain, GRID } from './doc.js';

const PREFIX = 'mia-graph:';
const isTyping = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

export function createClipboard(ed) {
  let internal = null;
  let keyAt = 0, pasteSeen = 0, fallbackT = 0;

  const boardActive = () => !!ed.project && !ed.board.closest('[hidden]') && !ed.palette.isOpen;

  /** Les blocs choisis et leurs fils internes, en copie profonde sans caches. */
  function snapshot(ids) {
    const set = new Set(ids);
    const nodes = ids.map((id) => ed.doc.node(id)).filter(Boolean).map((n) => JSON.parse(JSON.stringify(plain(n))));
    const edges = ed.doc.edges.filter((e) => set.has(e.from.node) && set.has(e.to.node)).map((e) => JSON.parse(JSON.stringify(plain(e))));
    // d'où viennent les médias : coller dans un autre projet les y recopie
    return { mia: 1, projectId: ed.project?.id || null, dir: ed.project?.dir || null, nodes, edges };
  }

  /**
   * Les blocs Média pointent vers `media/…` *de leur projet*. Collés ailleurs,
   * leurs fichiers sont d'abord importés dans le projet d'arrivée.
   */
  async function adoptMedia(payload) {
    if (!payload?.projectId || payload.projectId === ed.project?.id || !Array.isArray(payload.nodes)) return payload;
    const imports = payload.nodes.filter((n) => n.type === 'import' && n.data?.src);
    if (!imports.length) return payload;
    // la planche d'origine a pu être renommée ou rangée dans un projet depuis la copie :
    // son dossier d'aujourd'hui d'abord, celui noté au moment de copier en secours
    const dir = await sourceDir(payload);
    if (!dir) return payload;
    const root = String(dir).replace(/[\\/]+$/, '');
    const paths = imports.map((n) => `${root}/${n.data.src}`.replace(/\//g, '\\'));
    let res = [];
    try { res = await window.mia.media.importPaths(ed.project.id, paths); } catch (e) { res = []; }
    const nodes = payload.nodes.map((n) => {
      const i = imports.indexOf(n);
      if (i < 0) return n;
      const r = res[i];
      if (r?.ok && r.data) return { ...n, data: { ...r.data } };
      toast(t('graph.toast.importFailed', { name: n.data.name || n.data.src, error: r?.error || t('graph.toast.unknownError') }), { kind: 'error' });
      return n;
    });
    return { ...payload, nodes, projectId: ed.project.id, dir: ed.project.dir };
  }

  /** Dossier actuel de la planche d'où vient la copie (liste des planches lue au moment de coller). */
  async function sourceDir(payload) {
    try {
      const list = await window.mia?.projects?.list?.();
      const arr = Array.isArray(list) ? list : Array.isArray(list?.projects) ? list.projects : [];
      const p = arr.find((x) => x && (x.id === payload.projectId || (Array.isArray(x.aliases) && x.aliases.includes(payload.projectId))));
      if (p?.dir) return p.dir;
    } catch { /* liste indisponible : le dossier noté à la copie */ }
    return payload.dir || null;
  }

  async function pasteFrom(payload, at) {
    const pid = ed.project?.id;
    const ready = await adoptMedia(payload);
    if (ed.project?.id !== pid) return [];
    return pasteGraph(ready, at);
  }

  function copy() {
    const ids = [...ed.sel.nodes];
    if (!ids.length) return false;
    internal = snapshot(ids);
    try { navigator.clipboard?.writeText(PREFIX + JSON.stringify(internal)).catch(() => {}); } catch { /* presse-papiers refusé */ }
    toast(tn('graph.toast.copied', ids.length, { n: ids.length }), { kind: 'ok', ms: 1400 });
    return true;
  }

  function cut() {
    if (ed.readonly || !copy()) return false;
    ed.removeNodes([...ed.sel.nodes]);
    return true;
  }

  /**
   * Pose un lot de blocs copiés, centré sur `at`. Ids neufs, fils remappés,
   * versions épinglées oubliées (elles appartiennent aux originaux).
   */
  function pasteGraph(payload, at, { offset = null, keepInputs = false } = {}) {
    if (ed.readonly || !payload?.nodes?.length) return [];
    const nodes = payload.nodes.filter((n) => typeOf(n.type));
    if (!nodes.length) return [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      const b = ed.views.get(n.id) ? ed.nodeBox(n.id) : { x: n.x, y: n.y, w: n.w || 288, h: 200 };
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + (n.w || 288)); y1 = Math.max(y1, n.y + b.h);
    }
    let dx, dy;
    if (offset) { dx = offset.x; dy = offset.y; }
    else {
      const c = at || ed.viewCenter();
      dx = c.x - (x0 + x1) / 2;
      dy = c.y - (y0 + y1) / 2;
      if (ed.snap) { dx = Math.round(dx / GRID) * GRID; dy = Math.round(dy / GRID) * GRID; }
    }
    dx = Math.round(dx); dy = Math.round(dy);
    const ids = new Map();
    const created = ed.mutate('paste', () => {
      const out = [];
      for (const n of nodes) {
        const copyN = { ...n, id: undefined, x: n.x + dx, y: n.y + dy, pinnedRun: null };
        const nn = ed.doc.addNode(copyN);
        ids.set(n.id, nn.id);
        out.push(nn.id);
      }
      for (const e of payload.edges || []) {
        const a = ids.get(e.from.node), b = ids.get(e.to.node);
        if (a && b) ed.doc.addEdge({ from: { node: a, port: e.from.port }, to: { node: b, port: e.to.port } });
      }
      if (keepInputs) {
        // fils entrants depuis l'extérieur du lot : la variante lit la même source
        for (const e of [...ed.doc.edges]) {
          const b = ids.get(e.to.node);
          if (b && !ids.has(e.from.node)) ed.doc.addEdge({ from: { ...e.from }, to: { node: b, port: e.to.port } });
        }
      }
      return out;
    }, { animateNew: true, changed: new Set() }) || [];
    ed.setSelection({ nodes: created });
    return created;
  }

  function paste(at) {
    if (internal) return pasteFrom(internal, at || pointerWorld());
    readSystemClipboard(at || pointerWorld());
    return [];
  }

  function duplicate() {
    if (ed.readonly) return [];
    const ids = [...ed.sel.nodes];
    if (!ids.length) return [];
    const b = ed.bbox(ids);
    // juste dessous ; si la place est prise, à la place libre la plus proche (même entrée d'annulation)
    return ed.batch('duplicate', () => {
      const created = pasteGraph(snapshot(ids), null, { offset: { x: 0, y: Math.ceil((b.h + GRID * 2) / GRID) * GRID }, keepInputs: true });
      if (created.length) {
        for (const id of created) ed.views.get(id)?.measure();
        const box = ed.bbox(created);
        const p = ed.findFree(box, { prefer: 'below', exclude: new Set(created) });
        for (const id of created) {
          const n = ed.doc.node(id);
          if (n) ed.relocate(id, n.x + p.x - box.x, n.y + p.y - box.y);
        }
        ed.afterChange({ changed: new Set(), reason: 'duplicate' });
      }
      return created;
    }) || [];
  }

  function pointerWorld() {
    const p = ed.pointer;
    const r = ed.stageRect;
    if (p && p.x >= 0 && p.y >= 0 && p.x <= r.width && p.y <= r.height) return ed.cam.toWorld(p.x, p.y);
    return ed.viewCenter();
  }

  // ── presse-papiers système ──
  // Ctrl+V déclenche normalement l'évènement « paste » (qui seul donne accès
  // aux fichiers copiés dans l'Explorateur). S'il ne vient pas, on lit le
  // presse-papiers par l'API asynchrone.

  function onPasteKey() {
    if (!boardActive()) return;
    keyAt = performance.now();
    clearTimeout(fallbackT);
    fallbackT = setTimeout(() => {
      if (pasteSeen >= keyAt) return;
      if (internal) pasteFrom(internal, pointerWorld());
      else readSystemClipboard(pointerWorld());
    }, 90);
  }

  document.addEventListener('paste', (e) => {
    // l'évènement vise l'élément qui a le focus : un champ garde son propre collage
    if (!boardActive() || isTyping(e.target)) return;
    pasteSeen = performance.now();
    clearTimeout(fallbackT);
    if (ed.readonly) return;
    e.preventDefault();
    const at = pointerWorld();
    const dt = e.clipboardData;
    const files = dt ? [...dt.files] : [];
    if (files.length) return pasteFiles(files, at);
    const text = dt?.getData('text/plain') || '';
    if (text.startsWith(PREFIX)) {
      try { return pasteFrom(JSON.parse(text.slice(PREFIX.length)), at); } catch { /* texte abîmé */ }
    }
    if (internal && !text) return pasteFrom(internal, at);
    if (text.trim()) return pasteText(text, at);
    if (internal) return pasteFrom(internal, at);
    toast(t('graph.toast.pasteFailed'), { kind: 'info' });
  });

  async function readSystemClipboard(at) {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const img = it.types.find((x) => x.startsWith('image/'));
        if (img) {
          const blob = await it.getType(img);
          return pasteBlobs([new File([blob], `colle_${stamp()}.${img.split('/')[1] || 'png'}`, { type: img })], at);
        }
      }
      for (const it of items) {
        if (it.types.includes('text/plain')) {
          const text = await (await it.getType('text/plain')).text();
          if (text.startsWith(PREFIX)) return pasteFrom(JSON.parse(text.slice(PREFIX.length)), at);
          if (text.trim()) return pasteText(text, at);
        }
      }
    } catch (e) { console.warn('[editor] presse-papiers', e); }
    if (internal) return pasteFrom(internal, at);
    toast(t('graph.toast.pasteFailed'), { kind: 'info' });
  }

  /** Fichiers de l'Explorateur : par leur chemin ; images sans chemin (captures) : par leurs octets. */
  async function pasteFiles(files, at) {
    const paths = [], loose = [];
    for (const f of files) {
      let p = '';
      try { p = window.mia?.media?.pathFor(f) || ''; } catch { p = ''; }
      if (p) paths.push(p); else loose.push(f);
    }
    if (paths.length) await ed.importFiles(paths, at);
    if (loose.length) await pasteBlobs(loose, at);
  }

  async function pasteBlobs(files, at) {
    const pid = ed.project?.id;
    if (!pid) return;
    const ok = [];
    for (const f of files) {
      if (!/^(image|video)\//.test(f.type)) continue;
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const r = await window.mia.media.importBuffer(pid, f.name || `colle_${stamp()}.png`, bytes);
        if (r?.ok && r.data) ok.push(r.data);
        else toast(t('graph.toast.importFailed', { name: f.name || 'image', error: r?.error || t('graph.toast.unknownError') }), { kind: 'error' });
      } catch (e) {
        toast(t('graph.toast.importFailed', { name: f.name || 'image', error: String(e?.message || e) }), { kind: 'error' });
      }
    }
    if (ok.length && ed.project?.id === pid) ed.placeMedia(ok, at);
  }

  /** Du texte collé devient une Consigne : le geste naturel pour un prompt pris ailleurs. */
  function pasteText(text, at) {
    const ty = typeOf('text');
    const w = ty?.width || 288;
    const id = ed.addNode('text', { x: Math.round(at.x - w / 2), y: Math.round(at.y - 18) }, { params: { text: text.trim() } });
    return id ? [id] : [];
  }

  return { copy, cut, paste, duplicate, onPasteKey, pasteGraph, pasteFrom };
}

function stamp() {
  const d = new Date();
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
