// ── Corps des blocs (SPEC §6.4 – §6.5) ───────────────────────────────
// L'éditeur (E) dessine la carte : cadre, en-tête, ports, poignée. Ce module
// remplit ce qu'il y a dedans, selon le type :
//   import   → puits du média (ou zone de dépôt d'une recette, ou « introuvable »)
//   text     → consigne qui grandit avec son texte
//   note     → mot sur la planche, façon post-it sobre
//   compare  → volet A/B, côte à côte, différence
//   export   → fichier exporté + « Afficher dans l'Explorateur » / « Ouvrir »
//   mask     → l'image branchée avec la zone peinte par-dessus, « Dessiner la zone » (éditeur)
//   calcul   → puits du résultat (onglets si plusieurs sorties), aperçu en
//              direct, erreur lisible, versions, références numérotées,
//              réglages, pied « Lancer » (ou la raison qui l'empêche)
// et écrit l'état d'exécution dans l'en-tête (mono MAJ, da.md §4.5) ; la barre
// de 2 px reste à l'éditeur. Les données viennent de runs.js.
//
// Ordre vertical (da.md §4.2) : en-tête → slots.preview → ports → slots.controls.

import { on, emit } from '../bus.js';
import { t, tl } from '../i18n.js';
import { icon, register as registerIcons, hasIcon } from '../icons.js';
import { el, fmtBytes, measureLater, measureOnResize } from '../util.js';
import { state, mediaUrl } from '../state.js';
import { tip } from '../ui/tooltip.js';
import { toast } from '../ui/toasts.js';
import { button, segmented } from '../ui/controls.js';
import * as runs from './runs.js';
import { createWell, emptyBlock, urlFor, baseName, strings, shellDo, probeMissing, extractFrame } from './media.js';
import { mountParams, autoGrow } from './params.js';
import { mountVersions } from './versions.js';
import { mountCompare } from './compare.js';
import { modelProblem } from './modelpicker.js';
import { blockWorkflow, isModelBlock } from './ports.js';
import { portsOfWorkflow } from './route.js';
import { typeOf } from '../catalog.js';
import { openMaskEditor } from './maskeditor.js';
import { money } from '../ui/budget.js';
import './viewer.js';      // écoute viewer:open
import './inspector.js';   // écoute inspector:open

strings({
  'node.notComputed': 'Pas encore calculé',
  'node.connect': 'Branche d’abord : {list}',
  'node.fillFirst': 'Écris d’abord : {list}',
  'node.queued': 'En file d’attente',
  'node.waitingGpu': 'En attente du GPU',
  'node.waitingWho': 'Pris par « {who} »',
  'node.running': 'Calcul en cours…',
  'node.generate': 'Générer',
  'node.apply': 'Appliquer',
  'node.export': 'Exporter',
  'node.generateTip': 'Calculé chez Higgsfield avec les réglages du bloc, tels quels : coûte le prix affiché.',
  'node.generateLocalTip': 'Calculé sur ce PC avec les réglages du bloc : la définition, la durée et le nombre d’étapes décident du temps.',
  'node.timeTip': 'Temps prévu d’après tes derniers calculs sur ce PC.',
  'node.timeTipFirst': 'Première estimation : elle se règle sur ce PC dès les premiers calculs.',
  'node.priceTip': 'Prix donné par Higgsfield pour ces réglages, sur ton compte, avant de lancer.',
  'node.priceNone': 'prix ?',
  'node.priceNoneTip': 'Higgsfield ne donne pas de prix pour ces réglages : {why}',
  'node.cancel': 'Annuler',
  'node.errDetail': 'Voir le détail',
  'node.stale': 'Réglages ou entrées changés : relance pour mettre à jour',
  'node.source': 'Source · {label}',
  'node.viewing': 'v{n}',
  'node.viewingMode': 'v{n} · {mode}',
  'node.viewingTip': 'Tu regardes une ancienne version. La suite utilise toujours v{cur}.',
  'node.viewingPreviewTip': 'Tu regardes l’aperçu qui vient de finir. La suite utilise toujours le rendu final v{cur} (★ pour garder celui-ci).',
  'node.drop.title': 'Glisse une image, une vidéo ou un son',
  'node.drop.image': 'Glisse une image ici',
  'node.drop.video': 'Glisse une vidéo ici',
  'node.drop.audio': 'Glisse un son ici',
  'node.drop.or': 'ou',
  'node.drop.pick': 'Choisir un fichier…',
  'node.drop.failed': 'Ce fichier n’a pas pu être ajouté.',
  'node.text.placeholder': 'Écris ici…',
  'node.export.none': 'Le fichier ira dans le dossier A_regarder de la planche.',
  'node.export.where': 'Dans A_regarder',
  'node.export.whereSeq': 'Dossier dans A_regarder · {n} images',
  'node.export.reveal': 'Afficher dans l’Explorateur',
  'node.export.open': 'Ouvrir',
  'node.export.openFolder': 'Ouvrir le dossier',
  'node.model.install': 'Installer le modèle',
  'node.model.cantRun': 'Impossible de lancer : {why}',
  'node.src.missing': '« {name} » est introuvable',
  'node.src.missingSub': 'Remplace le fichier dans le bloc « {block} ».',
  'node.media.missingToast.one': '{n} média introuvable sur cette planche.',
  'node.media.missingToast.other': '{n} médias introuvables sur cette planche.',
  'node.ref.image': 'Image {n}',
  'node.ref.video': 'Vidéo {n}',
  'node.ref.audio': 'Son {n}',
  'node.ref.tip': '« {label} » dans la consigne = {name}',
  'node.extract.oldVersion': 'Extraction depuis la version courante seulement : reviens à v{cur} (ou garde celle-ci avec ★).',
  'node.zone.draw': 'Dessiner la zone',
  'node.zone.edit': 'Modifier la zone',
  'node.zone.needImage': 'Branche d’abord l’image à retoucher.',
  'node.zone.saveFailed': 'Le dessin n’a pas pu être enregistré : {error}',
  'node.variants': '4 variantes',
  'node.variantsTip': '4 images avec 4 graines différentes, l’une après l’autre. Compare-les dans les versions ; l’étoile garde celle que tu choisis.',
  'node.rewrite.title': 'Comprise ainsi',
  'node.rewrite.pending': 'Réécrite en anglais au prochain calcul.',
  'node.rewrite.now': 'Réécrire maintenant',
  'node.rewrite.queued': 'Réécriture en file…',
  'node.rewrite.running': 'Réécriture en anglais…',
  'node.rewrite.failed': 'Réécriture impossible : {error}',
}, {
  'node.notComputed': 'Not computed yet',
  'node.connect': 'Connect first: {list}',
  'node.fillFirst': 'Fill in first: {list}',
  'node.queued': 'Queued',
  'node.waitingGpu': 'Waiting for the GPU',
  'node.waitingWho': 'Held by “{who}”',
  'node.running': 'Computing…',
  'node.generate': 'Generate',
  'node.apply': 'Apply',
  'node.export': 'Export',
  'node.generateTip': 'Computed at Higgsfield with the block’s settings, as they are: costs the price shown.',
  'node.generateLocalTip': 'Computed on this PC with the block’s settings: resolution, length and step count decide the time.',
  'node.timeTip': 'Expected time, from your latest jobs on this PC.',
  'node.timeTipFirst': 'First estimate: it adjusts to this PC after the first jobs.',
  'node.priceTip': 'Price given by Higgsfield for these settings, on your account, before running.',
  'node.priceNone': 'price?',
  'node.priceNoneTip': 'Higgsfield gives no price for these settings: {why}',
  'node.cancel': 'Cancel',
  'node.errDetail': 'See details',
  'node.stale': 'Settings or inputs changed: run again to update',
  'node.source': 'Source · {label}',
  'node.viewing': 'v{n}',
  'node.viewingMode': 'v{n} · {mode}',
  'node.viewingTip': 'You are looking at an older version. What follows still uses v{cur}.',
  'node.viewingPreviewTip': 'You are looking at the preview that just finished. What follows still uses the final render v{cur} (★ to keep this one).',
  'node.drop.title': 'Drop an image, a video or a sound',
  'node.drop.image': 'Drop an image here',
  'node.drop.video': 'Drop a video here',
  'node.drop.audio': 'Drop a sound here',
  'node.drop.or': 'or',
  'node.drop.pick': 'Choose a file…',
  'node.drop.failed': 'This file could not be added.',
  'node.text.placeholder': 'Write here…',
  'node.export.none': 'The file will go to the board’s A_regarder folder.',
  'node.export.where': 'In A_regarder',
  'node.export.whereSeq': 'Folder in A_regarder · {n} images',
  'node.export.reveal': 'Show in Explorer',
  'node.export.open': 'Open',
  'node.export.openFolder': 'Open the folder',
  'node.model.install': 'Install the model',
  'node.model.cantRun': 'Cannot run: {why}',
  'node.src.missing': '“{name}” is missing',
  'node.src.missingSub': 'Replace the file in the “{block}” block.',
  'node.media.missingToast.one': '{n} media file missing on this board.',
  'node.media.missingToast.other': '{n} media files missing on this board.',
  'node.ref.image': 'Image {n}',
  'node.ref.video': 'Video {n}',
  'node.ref.audio': 'Sound {n}',
  'node.ref.tip': '“{label}” in the prompt = {name}',
  'node.extract.oldVersion': 'Extraction only from the current version: go back to v{cur} (or keep this one with ★).',
  'node.zone.draw': 'Draw the zone',
  'node.zone.edit': 'Edit the zone',
  'node.zone.needImage': 'Connect the image to retouch first.',
  'node.zone.saveFailed': 'The drawing could not be saved: {error}',
  'node.variants': '4 variations',
  'node.variantsTip': '4 images with 4 different seeds, one after another. Compare them in the versions; the star keeps the one you pick.',
  'node.rewrite.title': 'Understood as',
  'node.rewrite.pending': 'Rewritten in English at the next run.',
  'node.rewrite.now': 'Rewrite now',
  'node.rewrite.queued': 'Rewrite queued…',
  'node.rewrite.running': 'Rewriting in English…',
  'node.rewrite.failed': 'Rewrite failed: {error}',
});

const ACTIVE = new Set(['queued', 'waiting-gpu', 'running']);

// installer (une flèche qui descend dans un plateau, comme dans la bibliothèque)
if (!hasIcon('node-dl')) {
  registerIcons({ 'node-dl': '<path d="M12 4.5v10"/><path d="M7.8 10.6 12 14.8l4.2-4.2"/><path d="M4.5 15.5v2.2a1.8 1.8 0 0 0 1.8 1.8h11.4a1.8 1.8 0 0 0 1.8-1.8v-2.2"/>' });
}
/** Le modèle manque : la bibliothèque s'ouvre sur ce qu'il faut installer pour ce bloc (SPEC §21.4). */
const openInstaller = (caps) => emit('installer:open', { caps: caps || [] });

// L'avant / après de la visionneuse n'a de sens que si le bloc transforme sa source en une
// chose de même nature et de même cadre (un look, une image extraite, un son ajouté, un
// montage : non). Un drapeau `compare` du catalogue, s'il existe, a le dernier mot.
const COMPARE_TYPES = new Set(['real', 'guided', 'upscale', 'depth', 'cutout', 'edit', 'finish', 'composite']);
function comparable(type, out, src) {
  if (!out?.path || !src?.displayRel) return false;
  if (typeof type?.compare === 'boolean' ? !type.compare : !COMPARE_TYPES.has(type?.id)) return false;
  if ((out.kind || 'image') !== src.kind) return false;
  const a = out.meta, b = src.meta;
  if (a?.w && a?.h && b?.w && b?.h) {
    const r = (a.w / a.h) / (b.w / b.h);
    if (r < 0.96 || r > 1.04) return false;
  }
  return true;
}
const stop = (e) => e.stopPropagation();

/**
 * Change le texte d'un élément sans remplacer son nœud texte. `textContent =` retire et insère un
 * nœud : une mutation de structure qui, avec les :has() de la page (queue.css), restylait toute la
 * planche (≈ 7 ms par écriture, mesuré) ; changer `data` coûte dix fois moins.
 */
function setText(el, s) {
  const f = el.firstChild;
  if (f && f.nodeType === 3 && !f.nextSibling) { if (f.data !== s) f.data = s; }
  else if (el.textContent !== s) el.textContent = s;
}

// ── proxys vidéo prêts en tâche de fond (un seul abonnement) ─────────
const proxyWatch = new Map();   // src → Set(fn)
let proxySubscribed = false;
function watchProxy(src, fn) {
  if (!proxySubscribed && window.mia?.media?.onProxy) {
    proxySubscribed = true;
    window.mia.media.onProxy((evt) => {
      for (const f of proxyWatch.get(evt?.src) || []) { try { f(evt); } catch (e) { console.error(e); } }
    });
  }
  if (!proxyWatch.has(src)) proxyWatch.set(src, new Set());
  proxyWatch.get(src).add(fn);
  return () => proxyWatch.get(src)?.delete(fn);
}

// ── médias introuvables : un seul toast par ouverture de projet ──────
let missingCount = 0;
let missingTimer = 0;
let missingProject = null;
let missingToasted = false;
function noteMissing() {
  const pid = state.project?.id;
  if (pid !== missingProject) { missingProject = pid; missingCount = 0; missingToasted = false; }
  if (missingToasted) return;            // une fois par ouverture de projet
  missingCount++;
  clearTimeout(missingTimer);
  missingTimer = setTimeout(() => {
    if (!missingCount || missingToasted || state.project?.id !== missingProject) return;
    missingToasted = true;
    toast(t(`node.media.missingToast.${missingCount > 1 ? 'other' : 'one'}`, { n: missingCount }), { kind: 'error', ms: 6000 });
  }, 900);
}
on('project:opened', () => { missingProject = state.project?.id || null; missingCount = 0; missingToasted = false; });

// ── contexte commun ──────────────────────────────────────────────────

function makeCtx(node, type, slots, api) {
  const ctx = {
    node, type, slots, api, id: node.id, offs: [],
    ed: () => api?.graph || window.__mia?.editor || null,
    setParam(key, v) {
      if (api?.setParam) api.setParam(key, v);
      else ctx.ed()?.setParam?.(ctx.id, key, v);
    },
    setData(patch) {
      if (api?.setData) api.setData(patch);
      else ctx.ed()?.updateNode?.(ctx.id, { data: { ...(ctx.node.data || {}), ...patch } });
    },
    nodeEl: () => { try { return ctx.ed()?.nodeEl?.(ctx.id) || null; } catch { return null; } },
    connected(port) {
      try { return !!ctx.ed()?.inputsOf?.(ctx.id)?.[port]?.length; } catch { return false; }
    },
    /** Ce bloc reçoit-il quelque chose de `nodeId` ? */
    feedsFrom(nodeId) {
      let ins = {};
      try { ins = ctx.ed()?.inputsOf?.(ctx.id) || {}; } catch { return false; }
      return Object.values(ins).some((links) => (links || []).some((l) => l.node === nodeId));
    },
    projectId: () => state.project?.id,
  };
  // Nos propres conteneurs dans les emplacements de l'éditeur : il garde la
  // main sur leur style, nous sur le nôtre (marges, espacements).
  ctx.P = slots.preview ? el('div', { class: 'nb-pv' }) : null;
  ctx.C = slots.controls ? el('div', { class: 'nb-ct' }) : null;
  if (ctx.P) slots.preview.append(ctx.P);
  if (ctx.C) slots.controls.append(ctx.C);
  return ctx;
}

/** Texte d'estimation du catalogue (par mode si l'entrée en a). */
function estimateText(type, mode) {
  const e = type.estimate;
  if (!e) return '';
  if (e.fr || e.en) return tl(e);
  if (mode && e[mode]) return tl(e[mode]);
  const first = e.preview || e.final || Object.values(e)[0];
  return first ? tl(first) : '';
}

/**
 * « 4 variantes » : un bloc Modèle qui fait des images sur ce PC (Qwen-Image 2.1, FLUX.2 Klein, Qwen Image Edit) avec
 * une graine — quelques secondes par image ; jamais en ligne, où chaque image coûte des crédits.
 */
function variantsOk(ctx) {
  if (!isModelBlock(ctx.node)) return false;
  const conn = (ctx.type.inputs || []).filter((i) => ctx.connected(i.id)).map((i) => i.id);
  const r = blockWorkflow(ctx.node, conn);
  if (!r || r.blocked || r.fam.provider !== 'local' || r.fam.def?.kind !== 'image') return false;
  return (r.workflow.params || []).some((p) => (typeof p === 'string' ? p : p.id) === 'seed');
}

/** Bloc Modèle en ligne : { ports } (les entrées branchées, pour son prix), sinon null. */
function onlineOf(ctx) {
  if (!isModelBlock(ctx.node)) return null;
  const conn = (ctx.type.inputs || []).filter((i) => ctx.connected(i.id)).map((i) => i.id);
  const r = blockWorkflow(ctx.node, conn);
  return r && r.fam.provider !== 'local' ? { ports: conn } : null;
}

/**
 * Bloc Modèle : le type de bloc de la façon de faire retenue (ses modes, son estimation) ; en ligne, sans estimation
 * en minutes (un calcul en ligne coûte des crédits, sa durée dépend de leur file). Autres blocs : leur propre type.
 */
function targetTypeOf(ctx) {
  if (!isModelBlock(ctx.node)) return ctx.type;
  const conn = (ctx.type.inputs || []).filter((i) => ctx.connected(i.id)).map((i) => i.id);
  const r = blockWorkflow(ctx.node, conn);
  if (!r) return ctx.type;
  if (r.fam.provider !== 'local') return { ...ctx.type, estimate: null };
  return typeOf(r.workflow.as) || ctx.type;
}

/**
 * Les blocs touchés par un changement de réglages (graph:changed avec ids) : eux et tout ce qui est en aval. Calculé
 * une fois par évènement (gardé sur lui), quel que soit le nombre de blocs qui le reçoivent.
 */
function affectedBy(p) {
  if (p._affected) return p._affected;
  const out = new Set(p.ids);
  let edges = [];
  try { edges = window.__mia?.editor?.getGraph?.()?.edges || []; } catch { edges = []; }
  for (const todo = [...p.ids]; todo.length;) {
    const k = todo.pop();
    for (const e of edges) if (e.from?.node === k && e.to?.node && !out.has(e.to.node)) { out.add(e.to.node); todo.push(e.to.node); }
  }
  Object.defineProperty(p, '_affected', { value: out });
  return out;
}

/** Entrées obligatoires non branchées → libellés. */
function missingInputs(ctx) {
  // bloc Modèle (SPEC §23) : ce que demande la façon de faire choisie d'après les fils (rien n'est obligatoire en soi)
  if (isModelBlock(ctx.node)) {
    const conn = (ctx.type.inputs || []).filter((i) => ctx.connected(i.id)).map((i) => i.id);
    const r = blockWorkflow(ctx.node, conn);
    if (!r || !r.blocked) return [];
    return r.missing.map((id) => tl((ctx.type.inputs || []).find((i) => i.id === id)?.label || { fr: id }));
  }
  return (ctx.type.inputs || []).filter((i) => i.required && !ctx.connected(i.id)).map((i) => tl(i.label));
}

/** Réglages obligatoires encore vides (consigne…) et non remplacés par un fil → libellés. */
function missingParams(ctx) {
  // bloc Modèle : la consigne est obligatoire quand la façon de faire retenue l'exige (texte seul, références,
  // vidéo guidée, prolonger, retoucher) — dit avant le lancement, comme les blocs de tâche
  if (isModelBlock(ctx.node)) {
    const conn = (ctx.type.inputs || []).filter((i) => ctx.connected(i.id)).map((i) => i.id);
    const r = blockWorkflow(ctx.node, conn);
    const p = (ctx.type.params || []).find((x) => x.id === 'prompt');
    if (!r || !r.workflow.promptRequired || !p || (p.port && ctx.connected(p.port))) return [];
    const v = ctx.node.params?.prompt ?? p.default;
    return v == null || String(v).trim() === '' ? [tl(p.label)] : [];
  }
  return (ctx.type.params || []).filter((p) => {
    if (!p.required || (p.port && ctx.connected(p.port))) return false;
    const v = ctx.node.params?.[p.id] ?? p.default;
    return v == null || String(v).trim() === '';
  }).map((p) => tl(p.label));
}

/** Une entrée branchée sur un bloc Média dont le fichier a disparu → { name, block } (ou null). */
function goneSource(ctx) {
  for (const i of ctx.type.inputs || []) {
    if (i.type === 'text') continue;
    for (const s of runs.upstream(ctx.id, i.id)) {
      if (s.missing) return { name: s.node.data?.name || baseName(s.node.data?.src), block: s.node.title || tl(runs.typeOf(s.node.id)?.label || {}) };
    }
  }
  return null;
}

/** Source affichable d'une entrée (proxy pour la lecture, original pour l'IA). */
function sourceMedia(ctx, port) {
  const s = runs.source(ctx.id, port);
  if (!s || !s.path) return null;
  return {
    url: urlFor(s.proxy || s.path), poster: urlFor(s.poster), kind: s.kind, meta: s.meta,
    rel: s.path, displayRel: s.proxy || s.path,
  };
}

/** Première entrée image/vidéo branchée : la « source » d'un avant/après. */
function primarySource(ctx) {
  for (const i of ctx.type.inputs || []) {
    if (i.type === 'text') continue;
    const m = sourceMedia(ctx, i.id);
    if (m) return m;
  }
  return null;
}

/** Ratio « 16:9 » → 1,78 ; « auto » = celui de la première image/vidéo branchée. */
function formatRatio(v, ctx) {
  if (v === 'auto' || v == null || v === '') {
    const m = primarySource(ctx)?.meta;
    return m?.w && m?.h ? m.w / m.h : 16 / 9;
  }
  const r = /^(\d+(?:[.,]\d+)?)\s*[:x×/]\s*(\d+(?:[.,]\d+)?)$/.exec(String(v));
  if (r) return parseFloat(r[1].replace(',', '.')) / parseFloat(r[2].replace(',', '.'));
  return v === 'vertical' ? 9 / 16 : v === 'wide' ? 2.39 : 16 / 9;
}

// ── bloc Masque : « Dessiner la zone » ────────────────────────────────

/** Taille naturelle d'une image (quand le média n'a pas sa fiche). */
function naturalSize(url) {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => res(null);
    im.src = url;
  });
}

const zoneStamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/**
 * Le bouton du bloc Masque. Le dessin validé va dans media\ de la planche sous un nouveau nom (l'empreinte du bloc
 * change, ce qui en dépend se recalcule), puis dans le réglage `drawing`.
 */
function mountZoneRow(ctx, host) {
  let busy = false;
  let shown = null;                // libellé et état affichés : le bouton n'est redessiné que s'ils changent
  const btn = button({ label: t('node.zone.draw'), icon: 'edit', kind: 'ghost', size: 'sm', onClick: () => draw() });
  const row = el('div', { class: 'nb-zone-row' }, btn);
  row.addEventListener('pointerdown', stop);
  row.addEventListener('dblclick', stop);
  host.append(row);
  const rel = () => String(ctx.node.params?.drawing || '').trim();

  async function draw() {
    if (busy) return;
    const src = sourceMedia(ctx, 'image');
    if (!src || src.kind !== 'image') { toast(t('node.zone.needImage'), { kind: 'info' }); return; }
    busy = true;
    try {
      const dims = src.meta?.w && src.meta?.h ? src.meta : await naturalSize(src.url);
      const pid = ctx.projectId();
      const bytes = await openMaskEditor({ imageUrl: src.url, w: dims?.w, h: dims?.h, drawingUrl: rel() ? urlFor(rel()) : null });
      if (!bytes || ctx.projectId() !== pid) return;
      const r = await window.mia.media.importBuffer(pid, `zone-${zoneStamp()}.png`, bytes);
      if (!r?.ok || !r.data?.src) {
        toast(t('node.zone.saveFailed', { error: r?.error || '?' }), { kind: 'error' });
        return;
      }
      if (ctx.projectId() === pid) ctx.setParam('drawing', r.data.src);
    } catch (e) {
      toast(t('node.zone.saveFailed', { error: String(e?.message || e) }), { kind: 'error' });
    } finally {
      busy = false;
    }
  }
  return {
    url: () => (rel() ? urlFor(rel()) : null),
    paint() {
      const label = t(rel() ? 'node.zone.edit' : 'node.zone.draw');
      const off = !sourceMedia(ctx, 'image');
      if (shown && shown.label === label && shown.off === off) return;
      shown = { label, off };
      btn.setValue(label);
      btn.setDisabled(off);
    },
    destroy() { row.remove(); },
  };
}

// ── état d'exécution dans l'en-tête ─────────────────────────────────
// Texte mono MAJ (« EN FILE · 2 », « 47 % · FIN VERS 20 H 45 », « FAIT · 38 S »).
// La barre de 2 px, l'anneau « périmé » et le filet rouge de la carte sont
// dessinés par l'éditeur (SPEC §6.4) à partir du même runs.state().

function mountRunChrome(ctx) {
  const ring = el('i', { class: 'nb-st-ring', hidden: true });
  const alert = el('i', { class: 'nb-st-alert', html: icon('warn', 13), hidden: true });
  const text = el('span', { class: 'nb-st-text' });
  const status = el('span', { class: 'nb-status' }, ring, alert, text);
  let tipText = '';
  if (ctx.slots.status) {
    ctx.slots.status.replaceChildren(status);
    tip(status, () => tipText);
  }
  return {
    paint(st, problem) {
      // modèle absent : en carte étroite, l'icône d'alerte seule (la raison est dans l'info-bulle)
      const d = st.kind === 'idle' && problem ? { text: problem.title, short: '', alert: true, tone: 'err', tip: problem.sub } : runs.describe(st);
      // carte étroite : la forme courte (« 47 % », « #15 », « 1 h 12 »), pour ne pas manger le titre ;
      // le texte entier passe alors dans l'info-bulle
      const wide = (ctx.node.w || ctx.type.width || 336) >= 400;
      const short = d.short != null && !wide && d.short !== d.text;
      const txt = short ? d.short : d.text;
      setText(text, txt);
      if (text.hidden !== !txt) text.hidden = !txt;
      status.dataset.tone = d.tone;
      status.dataset.kind = st.kind;
      ring.hidden = !d.ring;
      alert.hidden = !(d.alert && !txt);
      tipText = short ? [d.text, d.tip].filter(Boolean).join(' — ') : (d.tip || '');
    },
    destroy() { status.remove(); },
  };
}

// ── pied : durée prévue (et prix en ligne) + « Générer » / Annuler ──

/**
 * Le verbe du bouton d'un bloc : « Générer » pour ce qui fabrique une image, une vidéo, une passe (demande de Quentin
 * du 28/10 : un seul bouton), « Exporter » sur Exporter, « Appliquer » sur les outils (couper, redimensionner, son…).
 */
export function runVerbKey(type) {
  if (type?.id === 'export') return 'node.export';
  return type?.category === 'tools' ? 'node.apply' : 'node.generate';
}

/** « ≈ 40 s », « ≈ 4 min », « ≈ 1 h 20 » : une durée prévue, arrondie à ce qui se lit d'un coup d'œil. */
function approxTime(s) {
  if (!(s > 0)) return '';
  if (s < 60) return `≈ ${Math.max(5, Math.round(s / 5) * 5)} s`;
  if (s < 3600) return `≈ ${Math.max(1, Math.round(s / 60))} min`;
  const m = Math.round(s / 60);
  return `≈ ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

// la durée prévue des blocs : deux questions au moteur à la fois au plus (une planche de 100 blocs qui s'ouvre) ;
// un calcul fini, n'importe où, peut changer ce que ce PC a appris : les blocs redemandent à leur prochain dessin
let estBusy = 0;
const estWaiting = [];
let learnedEpoch = 0;
on('engine:event', (e) => { if (e && e.kind === 'done') learnedEpoch++; });
function askEngine(payload) {
  return new Promise((resolve) => {
    const go = async () => {
      estBusy++;
      let r = null;
      try { r = await window.mia?.engine?.estimate?.(payload); } catch { r = null; }
      estBusy--;
      resolve(r);
      estWaiting.shift()?.();
    };
    if (estBusy < 2) go(); else estWaiting.push(go);
  });
}
// le graphe n'est lu qu'une fois par salve de questions, et seul l'amont du bloc part au moteur
let graphNow = null;
function upstreamGraph(ed, id) {
  if (!graphNow) { graphNow = ed?.getGraph?.() || null; setTimeout(() => { graphNow = null; }, 0); }
  const g = graphNow;
  if (!g || !Array.isArray(g.nodes)) return null;
  const edges = g.edges || [];
  const keep = new Set([id]);
  for (const todo = [id]; todo.length;) {
    const k = todo.pop();
    for (const e of edges) if (e.to?.node === k && e.from?.node && !keep.has(e.from.node)) { keep.add(e.from.node); todo.push(e.from.node); }
  }
  return { nodes: g.nodes.filter((n) => keep.has(n.id)), edges: edges.filter((e) => keep.has(e.to?.node) && keep.has(e.from?.node)) };
}

function mountFooter(ctx, host) {
  const est = el('span', { class: 'nb-est' });
  const actions = el('div', { class: 'nb-actions' });
  // modèle absent (SPEC §21.4) : à la place du texte rouge, de quoi l'installer ; la raison
  // détaillée est dans son infobulle et le titre rouge reste dans l'en-tête de la carte
  const install = button({ label: t('node.model.install'), icon: 'node-dl', kind: 'ghost', size: 'sm', onClick: () => openInstaller(blocked?.caps) });
  install.classList.add('nb-install');
  install.hidden = true;
  const foot = el('div', { class: 'nb-foot' }, install, est, actions);
  host.append(foot);
  for (const x of [actions, install]) { x.addEventListener('pointerdown', stop); x.addEventListener('dblclick', stop); }
  // bloc Modèle : la façon de faire retenue (ses modes, son estimation de départ)
  const targetType = () => targetTypeOf(ctx);
  let ttype = targetType();
  let twoModes = (ttype.modes || []).includes('final');
  let shape = null;          // 'active' | 'idle' | 'blocked|<raison>'
  let estDefault = '';
  let active = false;
  let blocked = null;

  // ── un seul « Générer » (demande de Quentin, 28/10) : ce que règle le bloc décide de la durée et du prix ;
  // un bloc à deux modes calcule en « final » (l'aperçu reste aux assistants qui le demandent) ──

  // la durée prévue avec CES réglages, d'après les calculs de ce PC (engine.estimate : estimation × rapport appris)
  let time = '';
  let timeLearned = false;
  let timeSig = null;
  let timeTimer = 0;
  function askTime() {
    const conn = (ctx.type.inputs || []).filter((i) => ctx.connected(i.id)).map((i) => i.id);
    const sig = JSON.stringify([ctx.node.params, conn, runs.list(ctx.id).length, learnedEpoch]);
    if (sig === timeSig) return;
    timeSig = sig;
    clearTimeout(timeTimer);
    timeTimer = setTimeout(async () => {
      const graph = upstreamGraph(ctx.ed(), ctx.id);
      const projectId = state.project?.id;
      const r = graph && projectId ? await askEngine({ projectId, nodeId: ctx.id, graph, mode: twoModes ? 'final' : null }) : null;
      if (sig !== timeSig) return;                        // les réglages ont changé entre-temps
      time = r && r.ok ? approxTime(r.seconds) : '';
      timeLearned = !!(r && r.learned);
      if (!active && !blocked) { estDefault = idleText(); showEst(estDefault); }
    }, 500);
  }

  // bloc Modèle en ligne : son prix, demandé à Higgsfield avant de lancer (engine/cloudprice.js)
  let online = null;
  let price = '';
  let priceWhy = '';                                      // la raison de Higgsfield quand il ne donne pas de prix
  let priceSig = null;
  let priceTimer = 0;
  function askPrice() {
    const sig = online ? JSON.stringify([ctx.node.params?.model, ctx.node.params?.workflow, ctx.node.params, online.ports]) : null;
    if (sig === priceSig) return;
    priceSig = sig;
    clearTimeout(priceTimer);
    price = '';                                           // l'ancien prix ne vaut plus pour ces réglages
    priceWhy = '';
    if (!sig) return;
    priceTimer = setTimeout(async () => {
      let r = null;
      try {
        r = await window.mia?.cloud?.price?.({ family: ctx.node.params?.model, workflow: ctx.node.params?.workflow || null,
          params: { ...(ctx.node.params || {}) }, ports: online.ports });
      } catch { r = null; }
      if (sig !== priceSig) return;
      // refusé par Higgsfield : « prix ? », sa raison au survol (sans compte relié : rien du tout)
      priceWhy = r && !r.ok && r.error ? r.error : '';
      price = r && r.ok && r.usd != null ? money(r.usd) : priceWhy ? t('node.priceNone') : '';
      if (!active && !blocked) { estDefault = idleText(); showEst(estDefault); }
    }, 400);
  }

  // au repos : le prix (en ligne) puis la durée ; tant que le moteur n'a pas répondu, l'estimation du catalogue
  const idleText = () => [online ? price : '', time || (online ? '' : estimateText(ttype, twoModes ? 'final' : null))]
    .filter(Boolean).join(' · ');

  // calculée au survol seulement : mesurer le texte à chaque dessin forcerait une mise en page
  tip(est, () => {
    if (blocked) return blocked.sub || '';
    if (active) return est.scrollWidth > est.clientWidth ? est.textContent : '';
    // estimation effacée ou coupée faute de place (carte rétrécie, texte long) : elle se lit ici en entier
    const parts = est.classList.contains('is-cut') || est.scrollWidth > est.clientWidth + 1 ? [est.textContent] : [];
    if (online && priceWhy) parts.push(t('node.priceNoneTip', { why: priceWhy }));
    else if (online && price) parts.push(t('node.priceTip'));
    if (time) parts.push(t(timeLearned ? 'node.timeTip' : 'node.timeTipFirst'));
    return parts.join(' ');
  });
  // Carte rétrécie : moins de 90 % du texte (ou moins de 8 signes) visibles, l'estimation s'efface
  // plutôt que de laisser « ≈… » seul. Mesurée seulement quand sa taille ou son texte change, avec les
  // autres blocs (util.measureLater) ; `visibility` ne change pas la mise en page (pas de boucle).
  const estFit = {
    read() {
      if (!est.isConnected || est.hidden || !est.textContent) return false;
      const full = est.scrollWidth, room = est.clientWidth;
      return full > room + 1 && (room / full < 0.9 || Math.floor(est.textContent.length * room / full) < 8);
    },
    write(cut) { if (cut != null && est.classList.contains('is-cut') !== cut) est.classList.toggle('is-cut', cut); },
  };
  const stopEstFit = measureOnResize(est, estFit);
  const showEst = (s) => { if (est.textContent !== s) { setText(est, s); measureLater(estFit); } };

  const run = (m) => emit('node:run', { nodeId: ctx.id, mode: m });

  function build() {
    actions.replaceChildren();
    if (active) {
      actions.append(button({ label: t('node.cancel'), icon: 'stop', kind: 'ghost', size: 'sm', onClick: () => runs.cancel(ctx.id) }));
      return;
    }
    // Modèle absent : le bouton reste visible mais éteint, avec la raison au survol.
    const why = blocked ? t('node.model.cantRun', { why: blocked.sub || blocked.title }) : null;
    // (un bouton éteint ne reçoit pas la souris : l'infobulle est sur son enveloppe)
    const wrap = (b) => (why ? el('span', { class: 'nb-act-off', 'data-tip': why }, b) : b);
    // images sur ce PC : 4 graines d'un coup, à comparer dans les versions (l'étoile choisit)
    if (!why && variantsOk(ctx)) {
      const four = button({ label: t('node.variants'), icon: 'dice', kind: 'ghost', size: 'sm', onClick: () => {
        runs.runVariants(ctx.id, { count: 4, mode: twoModes ? 'final' : null })
          .then((r) => { if (r.error) toast(r.error, { kind: 'error', ms: 5200 }); });
      } });
      four.dataset.tip = t('node.variantsTip');
      actions.append(four);
    }
    const verb = runVerbKey(ctx.type);
    const go = button({ label: t(verb), icon: 'play', kind: why ? 'ghost' : 'shiny', size: 'sm',
      disabled: !!why, onClick: () => run(twoModes ? 'final' : null) });
    if (!why && verb === 'node.generate') go.dataset.tip = t(online ? 'node.generateTip' : 'node.generateLocalTip');
    actions.append(wrap(go));
  }

  return {
    el: foot,
    paint(st, problem) {
      active = ACTIVE.has(st.kind);
      blocked = !active && problem ? problem : null;
      ttype = targetType();
      online = onlineOf(ctx);
      twoModes = online || (ttype.modes || []).includes('final');
      if (!active && !blocked) { askPrice(); askTime(); }
      const want = (active ? 'active' : blocked ? `blocked|${blocked.title}|${blocked.sub}` : 'idle')
        + (twoModes ? '|2' : '') + (variantsOk(ctx) ? '|4' : '') + (online ? '|online' : '');
      if (want !== shape) { shape = want; build(); }
      if (st.kind === 'running') {
        estDefault = runs.endText(st.endAt) || t('node.running');
      } else if (st.kind === 'queued') {
        estDefault = t('node.queued');
      } else if (st.kind === 'waiting-gpu') {
        estDefault = t('node.waitingGpu');
      } else if (blocked) {
        estDefault = blocked.title;
      } else {
        estDefault = idleText();
      }
      foot.classList.toggle('is-blocked', !!blocked);
      install.hidden = !blocked;
      est.hidden = !!blocked;
      if (blocked) install.dataset.tip = blocked.sub || blocked.title || '';
      showEst(estDefault);
    },
    destroy() { stopEstFit(); clearTimeout(timeTimer); clearTimeout(priceTimer); foot.remove(); },
  };
}

// ── références numérotées (Vidéo à partir de références, SPEC §17) ────
// « Image 1 », « Image 2 »… dans l'ordre des fils (celui du moteur) : c'est ce
// que Quentin écrit dans sa consigne.

function mountRefs(ctx, host) {
  // ce qui se cite dans la consigne : les références (images, vidéos, sons) et les images d'appui de Qwen — jamais
  // les images-clés (audit 25/10, UX-3 / LIVE-4)
  const CITED = ['refs', 'refVideos', 'refAudios', 'ref'];
  const all = (ctx.type.inputs || []).filter((i) => CITED.includes(i.id) && i.multi && i.max);
  if (!all.length || !host) return null;
  const portsNow = () => {
    if (!isModelBlock(ctx.node)) return all;
    const conn = (ctx.type.inputs || []).filter((i) => ctx.connected(i.id)).map((i) => i.id);
    const r = blockWorkflow(ctx.node, conn);
    const used = r ? portsOfWorkflow(r.workflow) : {};
    return all.filter((i) => used[i.id]);
  };
  const root = el('div', { class: 'nb-refs', hidden: true });
  root.addEventListener('pointerdown', stop);
  host.append(root);
  let sig = null;
  function render() {
    const items = [];
    for (const p of portsNow()) {
      const list = runs.upstream(ctx.id, p.id);
      // Qwen : l'image à retoucher est l'Image 1, ses images d'appui sont les images 2 et 3
      const from = p.id === 'ref' ? 2 : 1;
      list.forEach((s, i) => {
        const kind = p.type === 'video' ? 'video' : p.type === 'audio' ? 'audio' : 'image';
        const label = t(`node.ref.${kind}`, { n: i + from });
        const thumb = s.kind === 'image' ? (s.path ? urlFor(s.path) : '') : (s.poster ? urlFor(s.poster) : '');
        const name = s.node.title || s.node.data?.name || tl(runs.typeOf(s.node.id)?.label || {});
        items.push({ label, thumb, name, key: `${p.id}:${s.node.id}:${s.path || ''}` });
      });
    }
    const next = items.map((x) => `${x.key}|${x.label}|${x.thumb}`).join(',');
    if (next === sig) return;
    sig = next;
    root.hidden = !items.length;
    root.replaceChildren(...items.map((x) => {
      const chip = el('span', { class: 'nb-ref' },
        el('span', { class: 'nb-ref-thumb' }, x.thumb ? el('img', { src: x.thumb, alt: '', draggable: 'false', decoding: 'async' }) : null),
        el('span', { class: 'nb-ref-lab' }, x.label));
      chip.dataset.tip = t('node.ref.tip', { label: x.label, name: x.name });
      return chip;
    }));
  }
  render();
  return { render, destroy() { root.remove(); } };
}

// ── fiche du fichier exporté (bloc Exporter) ─────────────────────────

const exportedCache = new Map();   // « projet|runId » → notes (lues dans exported.json)
async function exportedNotes(run, nodeId) {
  if (run?.notes?.exported) return run.notes;
  const pid = state.project?.id;
  const k = `${pid}|${run?.runId}`;
  if (exportedCache.has(k)) return exportedCache.get(k);
  let notes = null;
  try {
    const url = mediaUrl(`outputs/${nodeId}/${run.runId}/exported.json`, pid);
    const r = await fetch(url, { cache: 'no-store' });
    if (r.ok) notes = await r.json();
  } catch { notes = null; }
  exportedCache.set(k, notes);
  return notes;
}

// ── bloc de calcul ───────────────────────────────────────────────────

function computeBody(ctx) {
  const { type } = ctx;
  const P = ctx.P;
  const C = ctx.C;
  const isExport = type.id === 'export';
  const outputs = type.outputs || [];
  const frameParam = (type.params || []).find((p) => p.kind === 'frame');
  ctx.tab = outputs[0]?.id || null;
  ctx.viewed = null;           // version regardée (null = la courante)
  ctx.scrub = null;            // { paramId, frame } pendant un glisser d'image
  ctx.shows = 'empty';         // ce que montre le puits : 'output' | 'source' | 'live' | 'empty'
  let lastJustDone = null;

  // onglets de sorties (Détourer : Masque / Détouré)
  let tabs = null;
  if (!isExport && outputs.length > 1) {
    tabs = segmented({
      options: outputs.map((o) => ({ value: o.id, label: tl(o.label) })),
      value: ctx.tab, size: 'sm',
      onChange: (v) => { ctx.tab = v; renderWell(); },
    });
    const bar = el('div', { class: 'nb-tabs' }, tabs);
    bar.addEventListener('pointerdown', stop);
    P?.append(bar);
  }

  // puits (ou, pour Exporter, la fiche du fichier)
  let well = null;
  let exportBox = null;
  if (isExport) {
    exportBox = el('div', { class: 'nb-export' });
    P?.append(exportBox);
  } else {
    well = createWell({
      onOpen: () => openCurrent(),
      onExtract: outputs.length ? (f) => extractHere(f) : null,
    });
    P?.append(well.el);
  }

  const errorBox = el('div', { class: 'nb-error', hidden: true });
  P?.append(errorBox);

  const versions = isExport || !P ? null : mountVersions(P, {
    nodeId: ctx.id,
    viewed: () => ctx.viewed,
    onView: (rid) => { ctx.viewed = rid && rid !== runs.current(ctx.id)?.runId ? rid : null; renderWell(); versions?.refresh(); },
    openInspector: () => emit('inspector:open', { nodeId: ctx.id }),
  });

  // références numérotées + (Masque) dessiner la zone + réglages + conseil d'entrée + pied
  const refs = mountRefs(ctx, C);
  const zone = type.id === 'mask' && C ? mountZoneRow(ctx, C) : null;
  const params = C ? mountParams(C, {
    node: ctx.node, type, mode: 'card', setParam: ctx.setParam,
    onScrub: (paramId, frame) => { ctx.scrub = frame == null ? null : { paramId, frame }; renderWell(); },
  }) : null;
  const hint = el('div', { class: 'nb-hint', hidden: true });
  C?.append(hint);
  const footer = C && type.engine ? mountFooter(ctx, C) : null;
  const chrome = mountRunChrome(ctx);

  function viewedRun() {
    return ctx.viewed ? runs.findRun(ctx.id, ctx.viewed) : runs.current(ctx.id);
  }

  function outputMedia(run) {
    const out = runs.output(ctx.id, ctx.tab, run);
    if (!out?.path) return null;
    const cut = type.id === 'cutout' && out.port === 'cut' && ctx.node.params?.background === 'alpha';
    return {
      url: urlFor(out.path), poster: urlFor(out.poster), kind: out.kind || 'image', meta: out.meta,
      alpha: !!(out.meta?.alpha || cut), rel: out.path, port: out.port,
    };
  }

  /** « Extraire cette image » depuis le puits de ce bloc (sa sortie affichée). */
  function extractHere(f) {
    if (ctx.shows !== 'output') return;
    if (ctx.viewed) {
      const cur = runs.current(ctx.id);
      toast(t('node.extract.oldVersion', { cur: cur ? runs.versionNumber(ctx.id, cur.runId) : '?' }), { kind: 'info', ms: 5200 });
      return;
    }
    const out = runs.output(ctx.id, ctx.tab);
    if (out?.kind !== 'video') return;
    extractFrame(ctx.id, out.port || ctx.tab, f);
  }

  /** Montre la vidéo amont à l'image visée (blocs Extraire / Couper). */
  function showSource(paramId, frame) {
    const p = (type.params || []).find((x) => x.id === paramId) || frameParam;
    const src = p ? sourceMedia(ctx, p.of) : null;
    if (!src || src.kind !== 'video') return false;
    well.show({ ...src, paused: true });
    const fps = src.meta?.fps || 24;
    const total = src.meta?.frames || Math.round((src.meta?.duration || 0) * fps);
    const f = frame === -1 ? Math.max(0, total - 1) : frame;
    well.seek(f, fps);
    well.setTag(t('node.source', { label: `${t('player.frameLabel')} ${f}` }));
    ctx.shows = 'source';
    return true;
  }

  function wellRatio() {
    const fp = (type.params || []).find((p) => p.id === 'format' && p.kind === 'select'
      && (p.options || []).some((o) => /^\d+:\d+$/.test(String(o.value)) || o.value === 'auto'));
    if (fp) return formatRatio(ctx.node.params?.format ?? fp.default, ctx);
    return formatRatio('auto', ctx);
  }

  function emptySpec(st, problem) {
    const ratio = wellRatio();
    if (st.kind === 'queued') return { title: t('node.queued'), ratio };
    if (st.kind === 'waiting-gpu') return { title: t('node.waitingGpu'), sub: st.who ? t('node.waitingWho', { who: st.who }) : '', ratio };
    if (st.kind === 'running') return { title: t('node.running'), sub: runs.endText(st.endAt), ratio };
    if (problem) {
      return {
        title: problem.title, sub: problem.sub, icon: 'warn', ratio,
        action: { label: t('node.model.install'), run: () => openInstaller(problem.caps) },
      };
    }
    const missing = missingInputs(ctx);
    if (missing.length) return { title: t('node.notComputed'), sub: t('node.connect', { list: missing.join(', ') }), ratio };
    const empty = missingParams(ctx);
    if (empty.length) return { title: t('node.notComputed'), sub: t('node.fillFirst', { list: empty.join(', ') }), ratio };
    const gone = goneSource(ctx);
    if (gone) return { title: t('node.src.missing', { name: gone.name }), sub: t('node.src.missingSub', { block: gone.block }), icon: 'warn', ratio };
    // la durée prévue est dans le pied, à côté de « Générer » (une seule, d'après ce PC)
    return { title: t('node.notComputed'), sub: '', ratio };
  }

  function renderWell(st = runs.state(ctx.id), problem = modelProblem(type, ctx.node)) {
    if (!well) return renderExport();
    well.setTag(null);
    if (st.kind === 'running' && st.preview) { ctx.shows = 'live'; well.showLive(st.preview); return; }
    if (ctx.scrub && showSource(ctx.scrub.paramId, ctx.scrub.frame)) return;
    // bloc Masque : l'image branchée et la zone peinte par-dessus (le masque gris, lui, s'ouvre au double-clic)
    if (zone && !ACTIVE.has(st.kind)) {
      const src = sourceMedia(ctx, 'image');
      if (src && src.kind === 'image') { ctx.shows = 'source'; well.show({ ...src, zone: zone.url() }); return; }
    }
    const run = viewedRun();
    const media = run ? outputMedia(run) : null;
    if (media) {
      ctx.shows = 'output';
      well.show(media);
      if (ctx.viewed) {
        const n = runs.versionNumber(ctx.id, ctx.viewed);
        const cur = runs.current(ctx.id);
        const curN = cur ? runs.versionNumber(ctx.id, cur.runId) : '?';
        const mode = run.mode ? t(`node.ver.mode.${run.mode}`) : '';
        well.setTag(mode ? t('node.viewingMode', { n, mode }) : t('node.viewing', { n }));
        well.el.dataset.tip = run.mode === 'preview' && cur && cur.mode !== 'preview' && run.finished > (cur.finished || 0)
          ? t('node.viewingPreviewTip', { cur: curN }) : t('node.viewingTip', { cur: curN });
      } else {
        delete well.el.dataset.tip;
      }
      return;
    }
    delete well.el.dataset.tip;
    if (frameParam && !ACTIVE.has(st.kind)) {
      const v = ctx.node.params?.[frameParam.id] ?? frameParam.default;
      if (showSource(frameParam.id, v)) return;
    }
    ctx.shows = 'empty';
    well.empty(emptySpec(st, problem));
  }

  let exportSig = null;
  let exportReq = 0;
  async function renderExport() {
    const run = runs.current(ctx.id);
    const req = ++exportReq;
    const notes = run ? await exportedNotes(run, ctx.id) : null;
    if (req !== exportReq) return;                  // une version plus récente a pris le relais
    const rel = notes?.exported || (run ? runs.output(ctx.id, null, run)?.path : null) || null;
    const sig = `${run?.runId || ''}|${rel || ''}|${ctx.projectId()}`;
    if (sig === exportSig) return;                  // rien de neuf : pas de clignotement
    exportSig = sig;
    exportBox.replaceChildren();
    if (!rel) {
      exportBox.append(el('div', { class: 'nb-export-none' }, el('span', { class: 'nb-export-ico', html: icon('folder', 16) }), el('span', {}, t('node.export.none'))));
      return;
    }
    const isSeq = notes?.kind === 'sequence';
    const target = { projectId: ctx.projectId(), rel };
    const reveal = el('button', { class: 'nb-link' }, t('node.export.reveal'));
    const open = el('button', { class: 'nb-link' }, isSeq ? t('node.export.openFolder') : t('node.export.open'));
    for (const b of [reveal, open]) { b.addEventListener('pointerdown', stop); b.addEventListener('dblclick', stop); }
    reveal.addEventListener('click', (e) => { e.stopPropagation(); shellDo('reveal', target); });
    open.addEventListener('click', (e) => { e.stopPropagation(); shellDo('openPath', target); });
    const where = isSeq && notes?.files ? t('node.export.whereSeq', { n: notes.files }) : t('node.export.where');
    const size = notes?.bytes ? fmtBytes(notes.bytes) : '';
    exportBox.append(el('div', { class: 'nb-export-file' },
      el('span', { class: 'nb-export-ico', html: icon(isSeq ? 'folder' : 'file', 18) }),
      el('div', { class: 'nb-export-txt' },
        el('div', { class: 'nb-export-name' }, notes?.name || baseName(rel)),
        el('div', { class: 'nb-export-where' }, [where, size].filter(Boolean).join(' · '))),
    ), el('div', { class: 'nb-export-acts' }, reveal, open));
    tip(exportBox.querySelector('.nb-export-name'), () => rel);
  }

  let errSig = null;
  function renderError(st) {
    if (st.kind !== 'error') { errorBox.hidden = true; errSig = null; return; }
    errorBox.hidden = false;
    const log = st.run?.log;
    const sig = `${st.message}|${log}`;
    if (sig === errSig) return;
    errSig = sig;
    const detail = log ? el('button', { class: 'nb-link' }, t('node.errDetail')) : null;
    if (detail) {
      detail.addEventListener('pointerdown', stop);
      detail.addEventListener('click', (e) => {
        e.stopPropagation();
        shellDo('openPath', { projectId: ctx.projectId(), rel: log });
      });
    }
    errorBox.replaceChildren(
      el('span', { class: 'nb-error-ico', html: icon('warn', 14) }),
      el('div', { class: 'nb-error-body' }, el('div', { class: 'nb-error-msg' }, st.message || t('run.failed')), detail),
    );
  }

  /** Conseil d'une entrée facultative non branchée (« image de fin conseillée »). */
  let hintSig = null;
  function renderHint() {
    // bloc Modèle : sa ligne « Ce que fait le bloc » dit déjà quoi brancher
    if (isModelBlock(ctx.node)) { hint.hidden = true; hintSig = null; return; }
    const opt = (type.inputs || []).find((i) => !i.required && i.hint && i.type !== 'text' && !i.multi && !ctx.connected(i.id));
    hint.hidden = !opt;
    if (opt && opt.id !== hintSig) {
      const h = tl(opt.hint);
      hint.replaceChildren(el('span', { class: 'nb-hint-ico', html: icon('info', 13) }),
        el('span', {}, el('b', {}, tl(opt.label)), ' — ', h.charAt(0).toLowerCase() + h.slice(1)));
    }
    hintSig = opt?.id || null;
  }

  function openCurrent() {
    const run = viewedRun();
    const out = run ? runs.output(ctx.id, ctx.tab, run) : null;
    const src = primarySource(ctx);
    if (out?.path) {
      emit('viewer:open', {
        nodeId: ctx.id, port: out.port, rel: out.path, kind: out.kind, meta: out.meta || null,
        compareRel: comparable(type, out, src) ? src.displayRel : null, runId: run.runId, current: !ctx.viewed,
      });
    } else if (src) {
      emit('viewer:open', { nodeId: ctx.id, rel: src.displayRel, kind: src.kind, meta: src.meta || null });
    }
  }

  function renderAll() {
    const st = runs.state(ctx.id);
    if (ctx.viewed && !runs.findRun(ctx.id, ctx.viewed)) ctx.viewed = null;
    // Une version qui vient de finir mais n'est pas la courante (un aperçu quand un
    // rendu final existe, SPEC §16) : on la montre quand même, étiquetée.
    if (st.kind === 'done' && st.justDone && st.justDone !== lastJustDone) {
      lastJustDone = st.justDone;
      if (st.justDone !== st.run?.runId && runs.findRun(ctx.id, st.justDone)) ctx.viewed = st.justDone;
    }
    const problem = type.engine ? modelProblem(type, ctx.node) : null;
    chrome.paint(st, problem);
    footer?.paint(st, problem);
    renderError(st);
    renderWell(st, problem);
    renderHint();
    refs?.render();
    zone?.paint();
    versions?.refresh();
  }

  return {
    render: renderAll,
    renderInputs() { params?.refreshInputs(); renderHint(); zone?.paint(); renderWell(); refs?.render(); chrome.paint(runs.state(ctx.id), type.engine ? modelProblem(type, ctx.node) : null); },
    sync(node) { params?.sync(node); },
    destroy() {
      well?.destroy(); params?.destroy(); versions?.destroy(); footer?.destroy(); chrome.destroy(); refs?.destroy(); zone?.destroy();
      tabs?.remove?.(); errorBox.remove(); hint.remove(); exportBox?.remove();
    },
  };
}

// ── import : le média lui-même, la zone de dépôt, ou « introuvable » ─

function importBody(ctx) {
  const P = ctx.P;
  let well = null;
  let drop = null;
  let params = null;
  let offProxy = null;
  let lastSrc = null;
  let probedSrc = null;

  async function pickInto(kind) {
    let paths = [];
    try { paths = (await window.mia?.media?.pick?.({ kind })) || []; } catch { paths = []; }
    if (!paths.length) return;
    try {
      await ctx.ed()?.importFiles?.(paths.slice(0, 1), null, ctx.id);
    } catch (err) {
      console.error(err);
      toast(t('node.drop.failed'), { kind: 'error' });
    }
  }

  function mountDrop() {
    const ph = ctx.node.data?.placeholder;
    const kind = ph?.kind || 'media';
    const title = ph ? tl(ph) : t(kind === 'image' ? 'node.drop.image' : kind === 'video' ? 'node.drop.video' : kind === 'audio' ? 'node.drop.audio' : 'node.drop.title');
    const pick = el('button', { class: 'nb-link' }, t('node.drop.pick'));
    pick.addEventListener('pointerdown', stop);
    pick.addEventListener('click', (e) => { e.stopPropagation(); pickInto(kind); });
    drop = el('div', { class: 'nb-drop', 'data-kind': kind },
      el('span', { class: 'nb-drop-ico', html: icon('drop-in', 20) }),
      el('div', { class: 'nb-drop-title' }, title),
      el('div', { class: 'nb-drop-sub' }, el('span', {}, t('node.drop.or')), pick));
    drop.style.setProperty('--ar', kind === 'video' ? String(16 / 9) : kind === 'audio' ? '3' : String(4 / 3));
    P?.replaceChildren(drop);
  }

  /** Le fichier a disparu du dossier media : on le dit, et on propose de le remplacer. */
  function markMissing() {
    const d = ctx.node.data || {};
    if (runs.setMissing(ctx.id, d.src, true)) noteMissing();
    render();
  }

  function mountMedia() {
    const d = ctx.node.data || {};
    if (!well) {
      P?.replaceChildren();
      well = createWell({
        onOpen: () => {
          const dd = ctx.node.data || {};
          if (dd.kind === 'audio') return;            // un son s'écoute dans le bloc : pas de visionneuse
          emit('viewer:open', { nodeId: ctx.id, port: 'out', rel: dd.kind === 'video' && dd.proxy ? dd.proxy : dd.src, kind: dd.kind, name: dd.name, meta: dd.meta, current: true });
        },
        onExtract: (f) => { if ((ctx.node.data || {}).kind === 'video' && !runs.isMissing(ctx.id)) extractFrame(ctx.id, 'out', f); },
        onMissing: markMissing,
      });
      P?.append(well.el);
    }
    if (runs.isMissing(ctx.id)) {
      const name = d.name || baseName(d.src);
      well.empty({
        title: t('node.media.missing'), sub: t('node.media.missingSub', { name }), icon: 'warn', missing: true,
        ratio: d.meta?.w && d.meta?.h ? d.meta.w / d.meta.h : undefined,
        action: { label: t('node.media.replace'), run: () => pickInto(d.kind || 'media') },
      });
      return;
    }
    const unplayable = d.kind === 'video' && !d.proxy && d.meta && d.meta.playable === false;
    // Image non lisible par Chromium (tif, exr, psd) : son aperçu PNG (SPEC §8.5).
    const imgUnreadable = d.kind === 'image' && /\.(tiff?|exr|psd|hdr|dpx)$/i.test(d.src || '');
    const url = d.kind === 'video' ? urlFor(d.proxy || d.src)
      : urlFor(imgUnreadable && d.poster ? d.poster : d.src);      // un son : le fichier lui-même, la forme d'onde en poster
    well.show({
      url, poster: urlFor(d.poster), kind: d.kind || 'image', meta: d.meta,
      alpha: !!d.meta?.alpha, pending: unplayable,
    });
    // Le cache de Chromium peut encore lire un fichier effacé : on demande au disque, une fois.
    if (d.src && probedSrc !== d.src) {
      probedSrc = d.src;
      probeMissing(urlFor(d.src)).then((gone) => {
        if (gone && (ctx.node.data || {}).src === d.src) markMissing();
      });
    }
    if (d.src !== lastSrc) {
      offProxy?.();
      lastSrc = d.src;
      offProxy = watchProxy(d.src, (evt) => {
        if (evt.projectId && evt.projectId !== ctx.projectId()) return;
        const cur = ctx.node.data || {};
        if (cur.src !== evt.src) return;
        if (cur.proxy === evt.proxy && (!evt.poster || cur.poster === evt.poster)) return;
        ctx.setData({ proxy: evt.proxy ?? cur.proxy ?? null, poster: evt.poster ?? cur.poster ?? null });
        ctx.node = ctx.ed()?.getNode?.(ctx.id) || ctx.node;
        mountMedia();
      });
    }
  }

  function mountControls() {
    params?.destroy();
    params = null;
    const isVideo = ctx.node.data?.kind === 'video';
    if (ctx.C && isVideo) {
      params = mountParams(ctx.C, { node: ctx.node, type: ctx.type, mode: 'card', setParam: ctx.setParam });
    }
  }

  let shape = null;   // 'drop' | 'image' | 'video' | 'audio' — on ne reconstruit que si ça change
  let shownSrc = null;
  let lastData = null;
  function render() {
    const d = ctx.node.data || {};
    // fichier remplacé sous le même nom (« Remplacer… ») : on redemande au disque
    if (lastData && d !== lastData && !d._missing && runs.isMissing(ctx.id)) {
      runs.setMissing(ctx.id, d.src, false);
      probedSrc = null;
    }
    lastData = d;
    // un fichier remplacé (nouveau src) efface l'état « introuvable » de l'ancien
    if (shownSrc && d.src !== shownSrc) runs.setMissing(ctx.id, shownSrc, false);
    shownSrc = d.src || null;
    if (d._missing && d.src && !runs.isMissing(ctx.id)) runs.setMissing(ctx.id, d.src, true);
    const next = d.src ? (d.kind === 'video' || d.kind === 'audio' ? d.kind : 'image') : 'drop';
    if (next !== shape) {
      if (next === 'drop') { well?.destroy(); well = null; mountDrop(); }
      else { drop?.remove(); drop = null; }
      shape = next;
      mountControls();
    }
    if (next !== 'drop') mountMedia();
  }

  // le média d'origine revient (remplacé par le même nom, recopié à la main…)
  const offFocus = () => window.removeEventListener('focus', onFocus);
  function onFocus() {
    const d = ctx.node.data || {};
    if (!d.src || !runs.isMissing(ctx.id) || d._missing) return;
    probeMissing(urlFor(d.src)).then((gone) => {
      if (!gone && (ctx.node.data || {}).src === d.src && runs.setMissing(ctx.id, d.src, false)) { probedSrc = null; well?.destroy(); well = null; render(); }
    });
  }
  window.addEventListener('focus', onFocus);

  return {
    render,
    renderInputs() {},
    sync(node) { params?.sync(node); render(); },
    destroy() { offProxy?.(); offFocus(); well?.destroy(); drop?.remove(); params?.destroy(); },
  };
}

// ── consigne réécrite en anglais (case « Réécrire en anglais ») ──────
// Sous le texte tapé : ce que le lecteur de Qwen en a compris (la version faite avec CE texte, que le moteur reprend),
// sinon où en est la réécriture (en file, en cours, ratée), sinon de quoi la faire tout de suite.

function mountRewrite(ctx, host) {
  const head = el('div', { class: 'nb-rw-head' });
  const body = el('div', { class: 'nb-rw-text' });
  const now = button({ label: t('node.rewrite.now'), icon: 'play', kind: 'ghost', size: 'sm',
    onClick: () => emit('node:run', { nodeId: ctx.id, mode: null }) });
  const root = el('div', { class: 'nb-rw', hidden: true }, head, body, now);
  for (const x of [root, now]) { x.addEventListener('pointerdown', stop); x.addEventListener('dblclick', stop); }
  host.append(root);
  let sig = null;
  return {
    paint() {
      const p = ctx.node.params || {};
      const text = p.text ?? '';
      const st = runs.state(ctx.id);
      const done = runs.list(ctx.id).find((r) => r.params?.text === text && r.outputs?.text);
      let mode = 'pending';
      let shown = '';
      if (p.rewrite !== true || !String(text).trim()) mode = 'off';
      else if (st.kind === 'running') mode = 'running';
      else if (st.kind === 'queued' || st.kind === 'waiting-gpu') mode = 'queued';
      else if (done) { mode = 'done'; shown = done.outputs.text.meta?.text || ''; }
      else if (st.kind === 'error') { mode = 'error'; shown = t('node.rewrite.failed', { error: st.message || t('run.failed') }); }
      if (mode === 'running' || mode === 'queued' || mode === 'pending') shown = t(`node.rewrite.${mode}`);
      const next = `${mode}|${shown}`;
      if (next === sig) return;
      sig = next;
      root.hidden = mode === 'off';
      root.dataset.state = mode;
      // l'étiquette seulement au-dessus du texte compris ; les états se disent en phrase
      head.textContent = t('node.rewrite.title');
      head.hidden = mode !== 'done';
      body.textContent = shown;
      now.hidden = !(mode === 'pending' || mode === 'error');
    },
    destroy() { root.remove(); },
  };
}

// ── consigne et note : un texte qui grandit avec son contenu ─────────

function textBody(ctx, { note = false } = {}) {
  const P = ctx.P;
  const p = (ctx.type.params || []).find((x) => x.id === 'text') || { id: 'text', default: '' };
  const ta = el('textarea', {
    class: note ? 'nb-note' : 'nb-textarea', spellcheck: 'false', rows: note ? '4' : '3',
    placeholder: p.placeholder ? tl(p.placeholder) : t('node.text.placeholder'),
  });
  ta.value = ctx.node.params?.text ?? p.default ?? '';
  const wrap = el('div', { class: note ? 'nb-note-wrap' : 'nb-text-wrap' }, ta);
  P?.replaceChildren(wrap);
  autoGrow(ta);

  // On enregistre après une courte pause de frappe (et toujours en quittant le champ).
  let timer = 0;
  let last = ta.value;
  const commit = () => {
    clearTimeout(timer);
    if (ta.value === last) return;
    last = ta.value;
    ctx.setParam('text', ta.value);
  };
  ta.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(commit, 400); });
  ta.addEventListener('blur', commit);
  ta.addEventListener('pointerdown', stop);
  ta.addEventListener('dblclick', stop);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();                          // pas de raccourci de planche pendant la saisie
    if (e.key === 'Escape') ta.blur();
  });
  ta.addEventListener('wheel', (e) => {
    // le texte long défile ; sinon la molette reste à la planche
    if (ta.scrollHeight > ta.clientHeight + 1) e.stopPropagation();
  }, { passive: true });

  const card = ctx.nodeEl();
  if (card && note) card.dataset.body = 'note';

  const params = !note && ctx.C
    ? mountParams(ctx.C, { node: ctx.node, type: ctx.type, mode: 'card', setParam: ctx.setParam, exclude: ['text'] })
    : null;
  const rewrite = note ? null : mountRewrite(ctx, wrap);
  rewrite?.paint();

  return {
    render() { rewrite?.paint(); },
    renderInputs() {},
    sync(node) {
      params?.sync(node);
      const v = node.params?.text ?? '';
      if (document.activeElement !== ta && v !== ta.value) { ta.value = v; last = v; ta.dispatchEvent(new Event('input')); clearTimeout(timer); }
      rewrite?.paint();
    },
    destroy() { commit(); wrap.remove(); params?.destroy(); rewrite?.destroy(); if (card) delete card.dataset.body; },
  };
}

// ── comparer A/B ─────────────────────────────────────────────────────

function compareBody(ctx) {
  const P = ctx.P;
  const modeOf = () => ctx.node.params?.mode ?? (ctx.type.params || []).find((p) => p.id === 'mode')?.default ?? 'slider';
  const host = el('div', { class: 'nb-cmp-host' });
  P?.replaceChildren(host);

  const side = (port) => {
    const m = sourceMedia(ctx, port);
    if (m) return m;
    return ctx.connected(port) ? { pending: true } : null;
  };
  let A = null, B = null;
  const cmp = mountCompare(host, {
    mode: modeOf(),
    onOpen: () => {
      if (B?.rel) emit('viewer:open', { nodeId: ctx.id, rel: B.displayRel, kind: B.kind, meta: B.meta, compareRel: A?.displayRel || null });
      else if (A?.rel) emit('viewer:open', { nodeId: ctx.id, rel: A.displayRel, kind: A.kind, meta: A.meta });
    },
  });
  const params = ctx.C ? mountParams(ctx.C, {
    node: ctx.node, type: ctx.type, mode: 'card', setParam: ctx.setParam,
    onChange: (key, v) => { if (key === 'mode') cmp.setMode(v); },
  }) : null;

  function render() {
    A = side('a');
    B = side('b');
    cmp.set(A, B);
    cmp.setMode(modeOf());
  }
  return {
    render,
    renderInputs: render,
    sync(node) { params?.sync(node); cmp.setMode(modeOf()); },
    destroy() { cmp.destroy(); params?.destroy(); host.remove(); },
  };
}

// ── bloc sans calcul ni média (réglages seuls) ───────────────────────

function staticBody(ctx) {
  const params = ctx.C ? mountParams(ctx.C, { node: ctx.node, type: ctx.type, mode: 'card', setParam: ctx.setParam }) : null;
  return {
    render() {},
    renderInputs() { params?.refreshInputs(); },
    sync(node) { params?.sync(node); },
    destroy() { params?.destroy(); },
  };
}

function bodyFor(type) {
  switch (type.id) {
    case 'import': return importBody;
    case 'text': return (ctx) => textBody(ctx);
    case 'note': return (ctx) => textBody(ctx, { note: true });
    case 'compare': return compareBody;
    default: return type.engine ? computeBody : staticBody;
  }
}

// ── point d'entrée (appelé par l'éditeur pour chaque carte) ──────────

/**
 * Monte le contenu d'une carte.
 * @returns {{ update(node), onRun(state), destroy() }}
 */
export function mountBody(node, type, slots, api = {}) {
  runs.registerType(type);
  const ctx = makeCtx(node, type, slots || {}, api);
  ctx.lastPinned = node.pinnedRun || null;
  let impl;
  try {
    impl = bodyFor(type)(ctx);
  } catch (err) {
    // Un corps qui casse ne doit jamais casser la planche : carte vide et trace.
    console.error(`[mia] corps du bloc ${type?.id} :`, err);
    ctx.P?.replaceChildren(emptyBlock({ title: t('run.failed'), icon: 'warn' }));
    return { update() {}, onRun() {}, destroy() { ctx.P?.remove(); ctx.C?.remove(); } };
  }

  // Rendus regroupés par image : 30 évènements de progression → 1 dessin.
  let pending = { all: false, inputs: false, sync: false };
  let raf = 0;
  const schedule = (what) => {
    pending[what] = true;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const p = pending;
      pending = { all: false, inputs: false, sync: false };
      try {
        if (p.sync) impl.sync(ctx.node);
        if (p.inputs) impl.renderInputs();
        if (p.all) impl.render();
      } catch (err) { console.error(`[mia] rendu du bloc ${ctx.id} :`, err); }
    });
  };

  ctx.offs.push(on('runs:changed', ({ nodeId } = {}) => {
    if (nodeId === ctx.id) schedule('all');
    else if (nodeId && ctx.feedsFrom(nodeId)) schedule('inputs');
  }));
  ctx.offs.push(on('graph:changed', (p) => {
    const layout = runs.LAYOUT_ONLY.has(p?.reason);
    // un déplacement peut changer l'ordre des références (Image 1, Image 2…)
    if (layout) { if (p?.reason === 'move' && (type.inputs || []).some((i) => i.multi)) schedule('inputs'); return; }
    // un réglage changé (une lettre tapée dans une consigne), un retour en arrière : seuls les blocs nommés et ceux en
    // aval sont concernés (« à relancer », ce qui leur arrive) ; les autres d'une grande planche ne se redessinent
    // plus tous (28/10)
    if (Array.isArray(p?.ids) && !affectedBy(p).has(ctx.id)) return;
    const fresh = ctx.ed()?.getNode?.(ctx.id);
    // l'éditeur peut muter le même objet : on compare à la dernière valeur vue
    const pinChanged = fresh && (fresh.pinnedRun || null) !== ctx.lastPinned;
    if (fresh) { ctx.node = fresh; ctx.lastPinned = fresh.pinnedRun || null; }
    schedule('sync');
    schedule('inputs');
    if (pinChanged || type.engine) schedule('all');      // étoile, modèle choisi, format…
  }));
  // un modèle installé ou retiré change ce que le bloc peut faire
  if (type.engine) ctx.offs.push(on('models:updated', () => schedule('all')));

  impl.render();

  return {
    update(next) {
      if (next) ctx.node = next;
      schedule('sync');
      schedule('all');
    },
    onRun() { schedule('all'); },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      for (const off of ctx.offs) { try { off?.(); } catch { /* rien */ } }
      try { impl.destroy(); } catch (err) { console.error(err); }
      ctx.P?.remove();
      ctx.C?.remove();
    },
  };
}

export default mountBody;
