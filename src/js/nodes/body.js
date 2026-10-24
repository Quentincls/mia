// ── Corps des blocs (SPEC §6.4 – §6.5) ───────────────────────────────
// L'éditeur (E) dessine la carte : cadre, en-tête, ports, poignée. Ce module
// remplit ce qu'il y a dedans, selon le type :
//   import   → puits du média (ou zone de dépôt d'une recette, ou « introuvable »)
//   text     → consigne qui grandit avec son texte
//   note     → mot sur la planche, façon post-it sobre
//   compare  → volet A/B, côte à côte, différence
//   export   → fichier exporté + « Afficher dans l'Explorateur » / « Ouvrir »
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
import { el, fmtBytes } from '../util.js';
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
  'node.preview': 'Aperçu',
  'node.final': 'Rendu final',
  'node.launch': 'Lancer',
  'node.cancel': 'Annuler',
  'node.estPreview': 'Aperçu {est}',
  'node.estFinal': 'Rendu final {est}',
  'node.previewTip': 'Court et rapide, pour juger avant le vrai calcul',
  'node.finalTip': 'Pleine qualité, plus long',
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
  'node.ref.tip': '« {label} » dans la consigne = {name}',
  'node.extract.oldVersion': 'Extraction depuis la version courante seulement : reviens à v{cur} (ou garde celle-ci avec ★).',
}, {
  'node.notComputed': 'Not computed yet',
  'node.connect': 'Connect first: {list}',
  'node.fillFirst': 'Fill in first: {list}',
  'node.queued': 'Queued',
  'node.waitingGpu': 'Waiting for the GPU',
  'node.waitingWho': 'Held by “{who}”',
  'node.running': 'Computing…',
  'node.preview': 'Preview',
  'node.final': 'Final render',
  'node.launch': 'Run',
  'node.cancel': 'Cancel',
  'node.estPreview': 'Preview {est}',
  'node.estFinal': 'Final {est}',
  'node.previewTip': 'Short and fast, to judge before the real job',
  'node.finalTip': 'Full quality, takes longer',
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
  'node.ref.tip': '“{label}” in the prompt = {name}',
  'node.extract.oldVersion': 'Extraction only from the current version: go back to v{cur} (or keep this one with ★).',
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

// ── pied : estimation + Aperçu / Rendu final / Lancer / Annuler ──────

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
  const modes = ctx.type.modes || null;
  let shape = null;          // 'active' | 'idle' | 'blocked|<raison>'
  let estDefault = '';
  let active = false;
  let blocked = null;
  // calculée au survol seulement : mesurer le texte à chaque dessin forcerait une mise en page
  tip(est, () => {
    if (blocked) return blocked.sub || '';
    if (modes && !active) {
      return [t('node.estPreview', { est: estimateText(ctx.type, 'preview') }), t('node.estFinal', { est: estimateText(ctx.type, 'final') })].join(' · ');
    }
    return est.scrollWidth > est.clientWidth ? est.textContent : '';
  });
  // Carte rétrécie : moins de 90 % du texte (ou moins de 8 signes) visibles, l'estimation s'efface
  // plutôt que de laisser « ≈… » seul. Mesurée seulement quand sa taille ou son texte change ;
  // `visibility` ne change pas la mise en page (pas de boucle).
  const fitEst = () => {
    const was = est.classList.contains('is-cut');
    if (was) est.classList.remove('is-cut');
    const full = est.scrollWidth, room = est.clientWidth;
    const cut = full > room + 1 && (room / full < 0.9 || Math.floor(est.textContent.length * room / full) < 8);
    if (cut) est.classList.add('is-cut');
  };
  new ResizeObserver(fitEst).observe(est);
  const showEst = (s) => { if (est.textContent !== s) { setText(est, s); fitEst(); } };

  const run = (m) => emit('node:run', { nodeId: ctx.id, mode: m });

  function build() {
    actions.replaceChildren();
    if (active) {
      actions.append(button({ label: t('node.cancel'), icon: 'stop', kind: 'ghost', size: 'sm', onClick: () => runs.cancel(ctx.id) }));
      return;
    }
    // Modèle absent : les boutons restent visibles mais éteints, avec la raison au survol.
    const why = blocked ? t('node.model.cantRun', { why: blocked.sub || blocked.title }) : null;
    // (un bouton éteint ne reçoit pas la souris : l'infobulle est sur son enveloppe)
    const wrap = (b) => (why ? el('span', { class: 'nb-act-off', 'data-tip': why }, b) : b);
    if (modes && modes.includes('preview')) {
      const fin = button({ label: t('node.final'), kind: 'ghost', size: 'sm', disabled: !!why, onClick: () => run('final') });
      const pre = button({ label: t('node.preview'), icon: 'play', kind: why ? 'ghost' : 'shiny', size: 'sm', disabled: !!why, onClick: () => run('preview') });
      if (!why) {
        fin.dataset.tip = t('node.finalTip');
        pre.dataset.tip = t('node.previewTip');
        // l'estimation suit le bouton survolé : on sait ce que coûte chaque choix
        const hover = (m) => () => { showEst(estimateText(ctx.type, m) || estDefault); };
        fin.addEventListener('pointerenter', hover('final'));
        pre.addEventListener('pointerenter', hover('preview'));
        for (const b of [fin, pre]) b.addEventListener('pointerleave', () => { showEst(estDefault); });
      }
      // modèle absent : un seul bouton éteint suffit, la place va à « Installer le modèle »
      actions.append(...(why ? [wrap(pre)] : [wrap(fin), wrap(pre)]));
    } else {
      actions.append(wrap(button({ label: t('node.launch'), icon: 'play', kind: why ? 'ghost' : 'shiny', size: 'sm', disabled: !!why, onClick: () => run(null) })));
    }
  }

  return {
    el: foot,
    paint(st, problem) {
      active = ACTIVE.has(st.kind);
      blocked = !active && problem ? problem : null;
      const want = active ? 'active' : blocked ? `blocked|${blocked.title}|${blocked.sub}` : 'idle';
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
        estDefault = estimateText(ctx.type, modes ? 'preview' : null);
      }
      foot.classList.toggle('is-blocked', !!blocked);
      install.hidden = !blocked;
      est.hidden = !!blocked;
      if (blocked) install.dataset.tip = blocked.sub || blocked.title || '';
      showEst(estDefault);
    },
    destroy() { foot.remove(); },
  };
}

// ── références numérotées (Vidéo à partir de références, SPEC §17) ────
// « Image 1 », « Image 2 »… dans l'ordre des fils (celui du moteur) : c'est ce
// que Quentin écrit dans sa consigne.

function mountRefs(ctx, host) {
  const ports = (ctx.type.inputs || []).filter((i) => i.multi && i.max && (i.type === 'image' || i.type === 'video'));
  if (!ports.length || !host) return null;
  const root = el('div', { class: 'nb-refs', hidden: true });
  root.addEventListener('pointerdown', stop);
  host.append(root);
  let sig = null;
  function render() {
    const items = [];
    for (const p of ports) {
      const list = runs.upstream(ctx.id, p.id);
      list.forEach((s, i) => {
        const kind = p.type === 'video' ? 'video' : 'image';
        const label = t(kind === 'video' ? 'node.ref.video' : 'node.ref.image', { n: i + 1 });
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

  // références numérotées + réglages + conseil d'entrée + pied
  const refs = mountRefs(ctx, C);
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
    return { title: t('node.notComputed'), sub: estimateText(type, type.modes ? 'preview' : null), ratio };
  }

  function renderWell(st = runs.state(ctx.id), problem = modelProblem(type, ctx.node)) {
    if (!well) return renderExport();
    well.setTag(null);
    if (st.kind === 'running' && st.preview) { ctx.shows = 'live'; well.showLive(st.preview); return; }
    if (ctx.scrub && showSource(ctx.scrub.paramId, ctx.scrub.frame)) return;
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
    versions?.refresh();
  }

  return {
    render: renderAll,
    renderInputs() { params?.refreshInputs(); renderHint(); renderWell(); refs?.render(); chrome.paint(runs.state(ctx.id), type.engine ? modelProblem(type, ctx.node) : null); },
    sync(node) { params?.sync(node); },
    destroy() {
      well?.destroy(); params?.destroy(); versions?.destroy(); footer?.destroy(); chrome.destroy(); refs?.destroy();
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

  return {
    render() {},
    renderInputs() {},
    sync(node) {
      params?.sync(node);
      const v = node.params?.text ?? '';
      if (document.activeElement !== ta && v !== ta.value) { ta.value = v; last = v; ta.dispatchEvent(new Event('input')); clearTimeout(timer); }
    },
    destroy() { commit(); wrap.remove(); params?.destroy(); if (card) delete card.dataset.body; },
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
