// ── Glisser-déposer depuis l'Explorateur ──────────────────────────────
// Le geste principal pour faire entrer un média dans Mia (da.md §3.2 : « tout
// est direct »). Un voile en tirets annonce la dépose ; lâché sur un bloc Média
// vide (celui d'une recette qui attend « l'image de début »), le premier
// fichier le remplit ; ailleurs, chaque fichier devient un bloc, en colonne à
// partir du point de lâcher. Les chemins réels viennent de
// `mia.media.pathFor(file)` (webUtils côté preload) : rien n'est lu ici.

import { t, tl } from '../i18n.js';
import { toast } from '../ui/toasts.js';
import { displayTitle } from './view.js';

// extensions de fichiers de modèle (SPEC §12.5) : jamais des médias
const MODEL_EXT = /\.(safetensors|ckpt|pt|pth|gguf|bin)$/i;
// une LUT d'étalonnage : elle se lâche sur un bloc Finition (réglage « Fichier LUT »)
const LUT_EXT = /\.cube$/i;

export function attachDrop(ed) {
  const zone = ed.stage;
  const veil = document.createElement('div');
  veil.className = 'drop-veil';
  veil.hidden = true;
  veil.innerHTML = '<div class="drop-pill"><span class="drop-title"></span><span class="drop-sub"></span></div>';
  ed.board.append(veil);
  const title = veil.querySelector('.drop-title');
  const sub = veil.querySelector('.drop-sub');
  let depth = 0;
  let into = null;

  const hasFiles = (e) => {
    const types = e.dataTransfer?.types;
    return !!types && [...types].includes('Files');
  };

  /** Bloc Média encore vide sous le pointeur (placeholder de recette ou bloc tout neuf). */
  function fillableAt(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('.node');
    if (!el) return null;
    const n = ed.doc.node(el.dataset.id);
    if (!n || n.type !== 'import' || n.data?.src) return null;
    return n;
  }

  function setInto(n) {
    if ((into?.id || null) === (n?.id || null)) return;
    if (into) ed.views.get(into.id)?.el.classList.remove('drop-into');
    into = n;
    if (n) {
      ed.views.get(n.id)?.el.classList.add('drop-into');
      title.textContent = t('graph.drop.into', { name: n.data?.placeholder ? tl(n.data.placeholder) : displayTitle(n) });
      sub.textContent = '';
      sub.hidden = true;
      veil.classList.add('targeted');
    } else {
      title.textContent = t('graph.drop.veil');
      sub.textContent = t('graph.drop.veilSub');
      sub.hidden = false;
      veil.classList.remove('targeted');
    }
  }

  function show() {
    if (!veil.hidden) return;
    into = { id: '__none' };
    setInto(null);
    veil.hidden = false;
  }
  function hide() {
    depth = 0;
    setInto(null);
    veil.hidden = true;
  }

  zone.addEventListener('dragenter', (e) => {
    if (!ed.project || ed.readonly || !hasFiles(e)) return;
    e.preventDefault();
    depth++;
    show();
  });
  zone.addEventListener('dragover', (e) => {
    if (!ed.project || ed.readonly || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (veil.hidden) show();
    setInto(fillableAt(e));
  });
  zone.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    // quitter la scène pour de bon (et pas seulement passer d'un enfant à l'autre)
    if (depth === 0 || !e.relatedTarget || !zone.contains(e.relatedTarget)) hide();
  });
  zone.addEventListener('drop', async (e) => {
    if (!ed.project || !hasFiles(e)) return;
    e.preventDefault();
    const target = fillableAt(e);
    hide();
    const files = [...(e.dataTransfer?.files || [])];
    const paths = [];
    for (const f of files) {
      let p = '';
      try { p = window.mia?.media?.pathFor(f) || ''; } catch { p = ''; }
      if (p) paths.push(p);
    }
    if (!paths.length) return;
    // les fichiers de modèle (LoRA) ne deviennent pas des blocs : SPEC §12.5
    const models = paths.filter((p) => MODEL_EXT.test(p));
    const luts = paths.filter((p) => LUT_EXT.test(p));
    const media = paths.filter((p) => !MODEL_EXT.test(p) && !LUT_EXT.test(p));
    if (models.length) addLoras(models);       // la lecture seule du projet n'empêche pas d'ajouter un LoRA à Mia
    if (luts.length && !ed.readonly) giveLut(luts[0], e);
    if (!media.length || ed.readonly) return;
    const r = ed.stage.getBoundingClientRect();
    const at = ed.cam.toWorld(e.clientX - r.left, e.clientY - r.top);
    await ed.importFiles(media, at, target?.id || null);
  });

  /** Une LUT .cube lâchée sur un bloc Finition devient son étalonnage ; ailleurs, on dit où la poser. */
  function giveLut(p, e) {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('.node');
    const n = el ? ed.doc.node(el.dataset.id) : null;
    const api = window.__mia?.editor;
    if (!n || n.type !== 'finish' || !api) { toast(t('graph.drop.lutWhere'), { kind: 'info' }); return; }
    api.setParam(n.id, 'look', 'file');
    api.setParam(n.id, 'lutFile', p);
  }

  /**
   * Un fichier de modèle lâché sur la planche : si c'est un LoRA, la fenêtre
   * « Ajouter un LoRA » de la bibliothèque (C) s'ouvre ; sinon un toast clair.
   * Plusieurs fichiers : l'un après l'autre.
   */
  async function addLoras(list) {
    // l'accueil (D) a la même logique : on la partage pour dire partout la même chose
    try {
      const home = await import('../ui/home.js');
      if (typeof home?.offerModelFiles === 'function') { await home.offerModelFiles(list); return; }
    } catch (err) { console.warn('[editor] home.js', err); }
    for (const p of list) {
      const name = String(p).split(/[\\/]/).pop();
      let info = null;
      try { info = await window.mia?.models?.inspect?.(p); } catch (err) { info = { ok: false, error: String(err?.message || err) }; }
      if (!info || info.ok === false) {
        toast(info?.error || t('graph.toast.unknownFile', { name }), { kind: 'error' });
        continue;
      }
      if (!info.isLora) {
        const why = info.reason ? tl(info.reason) : null;
        toast(why || (info.isModel ? t('graph.toast.notLora', { name }) : t('graph.toast.unknownFile', { name })), { kind: 'info' });
        continue;
      }
      let lib = null;
      try { lib = await import('../ui/library.js'); } catch (err) { console.warn('[editor] library.js', err); }
      if (typeof lib?.openAddLora !== 'function') { toast(t('graph.toast.loraLater'), { kind: 'info' }); return; }
      try { await lib.openAddLora(p, info); } catch (err) { console.error('[editor] openAddLora', err); }
    }
  }
  // un fichier lâché hors de la planche ne doit jamais ouvrir une page à la place de Mia
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); });
}
