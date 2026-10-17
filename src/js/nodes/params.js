// ── Réglages d'un bloc ───────────────────────────────────────────────
// Une rangée par réglage du catalogue (SPEC §4) : étiquette grise à gauche,
// contrôle maison à droite (ui/controls.js de D). Les réglages `advanced`
// se replient sous « Avancé › » dans la carte ; l'inspecteur les montre tous.
//
// Cas particuliers :
// - `showIf` ({param, in|notIn|eq|ne}) : la rangée n'apparaît que si la
//   condition est vraie (carte et inspecteur, SPEC §12.2) ;
// - `prompt` relié à une entrée texte branchée : le champ cède la place à
//   « Vient de « <bloc> » » grisé, avec le début du texte reçu ; sous la
//   consigne, le mot déclencheur du LoRA choisi s'il manque (« ajouté
//   automatiquement ») ;
// - `frame` : curseur sur la timeline de la vidéo branchée (images
//   numérotées à partir de 0, comme les fichiers), raccourcis première /
//   dernière (-1 = la dernière) ; pendant le glisser, le corps du bloc montre
//   l'image visée dans le puits (onScrub) ;
// - `seed` : champ numérique + dé « au hasard » ;
// - `model` : sélecteur de modèle (modelpicker.js) ; pour un LoRA
//   (« Personnage ou lieu ») la rangée n'existe que si un LoRA compatible
//   avec le modèle du bloc existe (SPEC §12.1).

import { t, tl } from '../i18n.js';
import { icon } from '../icons.js';
import { el, clamp } from '../util.js';
import { on } from '../bus.js';
import { state } from '../state.js';
import { tip } from '../ui/tooltip.js';
import { segmented, dropdown, slider, toggle, textField, numberField } from '../ui/controls.js';
import { modelPicker, isLoraParam, resolveModel, baseKeyOf, loraKeyOf, loraChoices, familyLabel } from './modelpicker.js';
import * as runs from './runs.js';
import { strings, baseName } from './media.js';
import { toast } from '../ui/toasts.js';

strings({
  'node.adv': 'Avancé',
  'node.advTitle': 'Avancé',
  'node.from': 'Vient de « {name} »',
  'node.fromEmpty': 'Le texte de « {name} » est vide.',
  'node.seedRandom': 'Au hasard',
  'node.frame.first': 'Première image (0)',
  'node.frame.last': 'Dernière image',
  'node.frame.lastShort': 'Dernière',
  'node.frame.of': '{f} / {n}',
  'node.frame.lastOf': 'Dernière · {f}',
  'node.frame.lastOn': 'Dernière image ({f}) : suit la longueur de la vidéo',
  'node.frame.tip': 'Images numérotées à partir de 0, comme les fichiers exportés',
  'node.frame.noVideo': 'Branche une vidéo',
  'node.frame.unknown': 'Durée inconnue',
  'node.lora.triggerAdded': '« {w} » ajouté automatiquement',
  'node.lora.triggerTip': 'Le mot déclencheur du LoRA « {name} » est ajouté en tête de la consigne au lancement.',
  'node.lora.wrongNow': 'Ce LoRA est fait pour {lora}, pas pour {base} : il sera ignoré.',
  'node.file.pick': 'Choisir…',
  'node.file.clear': 'Retirer',
  'node.file.tip': 'Choisir un fichier (ou le lâcher sur le bloc)',
  'node.file.wrongExt': 'Il faut un fichier {ext}.',
  'node.sound.noAudio': 'La vidéo n’a pas de son : seule la musique sera posée.',
}, {
  'node.adv': 'Advanced',
  'node.advTitle': 'Advanced',
  'node.from': 'From “{name}”',
  'node.fromEmpty': 'The text of “{name}” is empty.',
  'node.seedRandom': 'Random',
  'node.frame.first': 'First frame (0)',
  'node.frame.last': 'Last frame',
  'node.frame.lastShort': 'Last',
  'node.frame.of': '{f} / {n}',
  'node.frame.lastOf': 'Last · {f}',
  'node.frame.lastOn': 'Last frame ({f}): follows the video’s length',
  'node.frame.tip': 'Frames are numbered from 0, like exported files',
  'node.frame.noVideo': 'Connect a video',
  'node.frame.unknown': 'Unknown length',
  'node.lora.triggerAdded': '“{w}” added automatically',
  'node.lora.triggerTip': 'The trigger word of the LoRA “{name}” is put at the start of the prompt when it runs.',
  'node.lora.wrongNow': 'This LoRA is made for {lora}, not for {base}: it will be ignored.',
  'node.file.pick': 'Choose…',
  'node.file.clear': 'Remove',
  'node.file.tip': 'Choose a file (or drop it on the block)',
  'node.file.wrongExt': 'A {ext} file is needed.',
  'node.sound.noAudio': 'The video has no sound: only the music will be laid on it.',
});

// Réglages qui ne valent que si la vidéo branchée a du son (bloc Son : garder / remplacer le son
// d'origine, son volume). Une vidéo sans piste son (meta.hasAudio === false) les cache, avec une note.
const NEEDS_SOURCE_AUDIO = { sound: { port: 'video', params: ['mode', 'origVolume'] } };

// « Avancé » ouvert ou fermé, par bloc, le temps de la session.
const advOpen = new Map();

const editor = () => window.__mia?.editor || null;

/** Le réglage est-il écrasé par un fil branché sur son entrée ? */
function portConnected(nodeId, port) {
  if (!port) return false;
  try { return !!editor()?.inputsOf?.(nodeId)?.[port]?.length; } catch { return false; }
}

const stop = (e) => e.stopPropagation();

/** Condition `showIf` d'un réglage, évaluée sur les valeurs du bloc. */
export function showIfOk(cond, node, type) {
  if (!cond || !cond.param) return true;
  const def = (type?.params || []).find((x) => x.id === cond.param);
  const raw = node?.params?.[cond.param];
  const v = raw === undefined ? (def ? def.default : undefined) : raw;
  const val = v === undefined ? null : v;
  if (Array.isArray(cond.notIn) && cond.notIn.includes(val)) return false;
  if (Array.isArray(cond.in) && !cond.in.includes(val)) return false;
  for (const k of ['eq', 'equals', 'is']) if (k in cond && val !== cond[k]) return false;
  for (const k of ['ne', 'not']) if (k in cond && val === cond[k]) return false;
  return true;
}

/**
 * Monte les réglages d'un bloc.
 * opts : { node, type, setParam(key, v), mode:'card'|'inspector', exclude?:[ids],
 *          onScrub?(paramId, frame|null), onChange?(key, v) }
 * Retour : { el, sync(node), refreshInputs(), destroy() }
 */
export function mountParams(host, opts) {
  const { type } = opts;
  let node = opts.node;
  const nodeId = node.id;
  const inspector = opts.mode === 'inspector';
  const exclude = new Set(opts.exclude || []);
  const params = (type.params || []).filter((p) => !exclude.has(p.id));
  const basic = params.filter((p) => !p.advanced);
  const adv = params.filter((p) => p.advanced);

  const root = el('div', { class: `np ${inspector ? 'np-insp' : 'np-card'}` });
  host.append(root);
  const ctrls = new Map();     // paramId → { set(v), owns(el), row, refresh?() }
  const rows = new Map();      // paramId → rangée (pour showIf)
  const cleanups = [];
  let advBtn = null;
  let advBox = null;

  const val = (p) => node.params?.[p.id] ?? p.default;
  const commit = (p, v) => {
    opts.setParam(p.id, v);
    opts.onChange?.(p.id, v);
  };

  // ── LoRA : famille du modèle du bloc ─────────────────────────────────
  const loraParam = (type.params || []).find((p) => p.kind === 'model' && isLoraParam(p));
  /** Clé de famille du modèle réellement utilisé par le bloc (« auto » compris). */
  function baseKey() {
    if (!loraParam) return null;
    // loraFor = id du réglage de modèle à suivre (« model »), ou directement une famille (« wan »)
    const refId = loraParam.loraFor || 'model';
    const ref = (type.params || []).find((x) => x.id === refId && x.kind === 'model' && !isLoraParam(x));
    if (ref) return baseKeyOf(resolveModel(ref, node.params?.[ref.id]));
    return refId !== 'model' ? refId : null;
  }
  /** Entrée d'inventaire du LoRA choisi (ou null). */
  function chosenLora() {
    if (!loraParam) return null;
    const v = val(loraParam);
    if (!v || v === 'none' || v === 'auto') return null;
    return (state.inventory?.models || []).find((m) => m.id === v) || null;
  }

  // ── fabriques de rangées ────────────────────────────────────────────
  function label(p) {
    const l = el('span', { class: 'np-label' }, tl(p.label));
    if (p.hint) {
      l.classList.add('has-hint');
      tip(l, () => tl(p.hint));
    }
    return l;
  }

  function rowFor(p) {
    let row;
    switch (p.kind) {
      case 'seg': row = segRow(p); break;
      case 'select': row = selectRow(p); break;
      case 'slider': row = sliderRow(p); break;
      case 'toggle': row = toggleRow(p); break;
      case 'prompt': row = promptRow(p); break;
      case 'text': row = textRow(p); break;
      case 'seed': row = seedRow(p); break;
      case 'frame': row = frameRow(p); break;
      case 'model': row = modelRow(p); break;
      case 'file': row = fileRow(p); break;
      default: row = textRow(p);
    }
    rows.set(p.id, row);
    return row;
  }

  function line(p, control, cls = '') {
    const row = el('div', { class: `np-row ${cls}`, 'data-param': p.id }, label(p), el('div', { class: 'np-ctl' }, control));
    return row;
  }

  // ── rangée trop étroite pour son contrôle : libellé au-dessus, contrôle sur toute la largeur ──
  // La place est lue sur une sonde (largeur de la rangée, hauteur nulle) : passer en pile change la
  // hauteur de la rangée, jamais la taille de la sonde, donc jamais de boucle de ResizeObserver. La
  // décision se prend dans les deux sens (rétrécir puis rélargir rend la disposition normale).
  function probeOf(row) {
    let pr = row.querySelector(':scope > .np-probe');
    if (!pr) { pr = el('i', { class: 'np-probe', 'aria-hidden': 'true' }); row.append(pr); }
    return pr;
  }
  // Classes posées par la mesure elle-même et qui changent les colonnes de la rangée : la colonne de
  // référence se lit sans elles (retirées le temps d'une lecture synchrone, sans peinture entre les deux),
  // sinon la place relue serait celle que la classe a laissée et la rangée ne reviendrait jamais.
  const TRACK_CLASSES = ['np-tgl-wide'];
  /** { inline : colonne du contrôle à côté du libellé, stacked : la rangée entière }, px de mise en page. */
  function roomOf(row) {
    const w = row.clientWidth;
    if (!w) return null;
    const off = TRACK_CLASSES.filter((c) => row.classList.contains(c));
    if (off.length) row.classList.remove(...off);
    const tracks = getComputedStyle(row).gridTemplateColumns.split(' ').map(parseFloat).filter(Number.isFinite);
    if (off.length) row.classList.add(...off);
    return { inline: tracks.length >= 2 ? tracks[tracks.length - 1] : w, stacked: w };
  }
  const setStack = (row, on, cls = 'np-stack') => { if (row.classList.contains(cls) !== !!on) row.classList.toggle(cls, !!on); };
  /** need() → largeur minimale du contrôle (px) ; la rangée s'empile quand la colonne est plus étroite. */
  function stackWhenNarrow(row, need, cls = 'np-stack') {
    const ro = new ResizeObserver(() => {
      const r = roomOf(row);
      const n = r && need();
      if (r && n) setStack(row, n > r.inline + 0.5, cls);
    });
    ro.observe(probeOf(row));
    cleanups.push(() => ro.disconnect());
  }

  // Listes, curseurs, champs, graine, fichier, modèle : en pile quand la colonne du contrôle fait moins de
  // NARROW px (seulement sur une carte rétrécie à la poignée : à leur largeur par défaut, aucun bloc n'y est)
  const NARROW = 160;
  const narrowLine = (p, control, cls) => {
    const row = line(p, control, cls);
    stackWhenNarrow(row, () => NARROW);
    return row;
  };

  function segRow(p) {
    const c = segmented({
      options: (p.options || []).map((o) => ({ value: o.value, label: tl(o.label) })),
      value: val(p), size: 'sm', onChange: (v) => commit(p, v),
    });
    ctrls.set(p.id, { set: (v) => c.setValue(v), owns: (x) => c.contains(x) });
    const row = line(p, c, 'np-seg');
    // pas la place à côté du libellé : en pile, puis libellés sur deux lignes, puis liste déroulante
    c.adapt({ watch: probeOf(row), room: () => roomOf(row), onLevel: (lvl) => setStack(row, lvl !== 'inline') });
    return row;
  }

  // Anciennes valeurs de format (projets d'avant les ratios « 16:9 »…) : affichées
  // sous leur nom actuel, sans réécrire le projet tant qu'on n'y touche pas.
  const LEGACY = { vertical: '9:16', portrait: '9:16', horizontal: '16:9', landscape: '16:9', wide: '21:9', square: '1:1' };
  function shownValue(p, v) {
    const opts = p.options || [];
    if (opts.some((o) => o.value === v)) return v;
    // une cadence gardée en texte (« 24 ») retrouve son option numérique, et inversement
    const loose = opts.find((o) => String(o.value) === String(v));
    if (loose) return loose.value;
    const alias = LEGACY[v];
    return alias && opts.some((o) => o.value === alias) ? alias : v;
  }

  function selectRow(p) {
    const c = dropdown({
      // la phrase de chaque choix (les looks de Finition) s'affiche sous son nom dans la liste ;
      // le bouton, étroit, montre la forme courte du catalogue (`short`) quand elle existe
      items: (p.options || []).map((o) => ({ value: o.value, label: tl(o.label), short: o.short ? tl(o.short) : undefined, hint: o.hint ? tl(o.hint) : undefined })),
      renderValue: (it) => it.short || it.label,
      value: shownValue(p, val(p)), onChange: (v) => commit(p, v),
    });
    ctrls.set(p.id, { set: (v) => c.setValue(shownValue(p, v)), owns: (x) => c.contains(x) });
    return narrowLine(p, c, 'np-select');
  }

  function sliderRow(p) {
    const c = slider({
      min: p.min, max: p.max, step: p.step ?? 1, value: val(p), unit: p.unit || '',
      reset: p.default,                  // double-clic : valeur par défaut
      onChange: (v) => commit(p, v),
    });
    ctrls.set(p.id, { set: (v) => c.setValue(v), owns: (x) => c.contains(x) });
    return narrowLine(p, c, 'np-slider');
  }

  function toggleRow(p) {
    const c = toggle({ value: !!val(p), onChange: (v) => commit(p, !!v) });
    ctrls.set(p.id, { set: (v) => c.setValue(!!v), owns: (x) => c.contains(x) });
    const row = line(p, c, 'np-toggle');
    // carte étroite : pas de pile pour un interrupteur de 30 px, mais son libellé prend toute la largeur
    stackWhenNarrow(row, () => NARROW, 'np-tgl-wide');
    return row;
  }

  function textRow(p) {
    const c = textField({
      value: val(p) ?? '', placeholder: p.placeholder ? tl(p.placeholder) : '',
      onChange: (v) => commit(p, v),
    });
    ctrls.set(p.id, { set: (v) => c.setValue(v ?? ''), owns: (x) => c.contains(x) });
    return narrowLine(p, c, 'np-text');
  }

  function promptRow(p) {
    const wrap = el('div', { class: 'np-prompt' });
    const note = el('div', { class: 'np-note', hidden: true });
    const row = el('div', { class: 'np-row np-block', 'data-param': p.id }, label(p), wrap, note);
    let field = null;
    let fromEl = null;
    let noteSig = null;

    function render() {
      const linked = portConnected(nodeId, p.port);
      if (linked) {
        const src = runs.source(nodeId, p.port);
        const name = src ? runs.nodeLabel(src.node.id) : '';
        const text = (src?.text || '').trim();
        fromEl = el('div', { class: 'np-from' },
          el('div', { class: 'np-from-head' }, t('node.from', { name })),
          el('div', { class: `np-from-text${text ? '' : ' empty'}` }, text || t('node.fromEmpty', { name })));
        wrap.replaceChildren(fromEl);
        field = null;
        row.classList.add('linked');
      } else {
        if (!field) {
          field = textField({
            value: val(p) ?? '', multiline: true, rows: inspector ? 4 : 2,
            placeholder: p.placeholder ? tl(p.placeholder) : '', maxRows: inspector ? 16 : 10,
            onChange: (v) => { commit(p, v); trigger(); },
          });
          field.addEventListener('input', () => trigger(field.querySelector('textarea, input')?.value));
        }
        if (wrap.firstChild !== field) wrap.replaceChildren(field);
        row.classList.remove('linked');
      }
      trigger();
    }

    /** Mot déclencheur du LoRA choisi, absent de la consigne → ajouté au lancement. */
    function trigger(typed) {
      let l = loraParam && p.id === 'prompt' ? chosenLora() : null;
      const key = l ? baseKey() : null;
      if (l && key && loraKeyOf(l) !== key) l = null;      // LoRA ignoré : pas de mot ajouté
      const w = (l?.trigger || '').trim();
      let text = typed;
      if (text == null) text = portConnected(nodeId, p.port) ? (runs.source(nodeId, p.port)?.text || '') : (val(p) || '');
      const show = !!w && !String(text).toLowerCase().includes(w.toLowerCase());
      const sig = show ? `${w}|${l.id}` : '';
      if (sig === noteSig) return;
      noteSig = sig;
      note.hidden = !show;
      if (show) {
        note.replaceChildren(el('span', { class: 'np-note-ico', html: icon('info', 12) }), el('span', {}, t('node.lora.triggerAdded', { w })));
        note.dataset.tip = t('node.lora.triggerTip', { name: tl(l.label || { fr: l.file || '' }) });
      }
    }

    render();
    ctrls.set(p.id, {
      set: (v) => { field?.setValue(v ?? ''); trigger(); },
      owns: (x) => wrap.contains(x),
      refresh: render,
      trigger: () => trigger(),
    });
    return row;
  }

  function seedRow(p) {
    const n = numberField({ value: Number(val(p)) || 0, min: 0, max: 2147483647, step: 1, onChange: (v) => commit(p, Math.round(Number(v) || 0)) });
    const dice = el('button', { class: 'np-icon-btn', html: icon('dice', 15), 'data-tip': t('node.seedRandom') });
    dice.addEventListener('pointerdown', stop);
    dice.addEventListener('click', (e) => {
      e.stopPropagation();
      const v = Math.floor(Math.random() * 1e9);
      n.setValue(v);
      commit(p, v);
    });
    ctrls.set(p.id, { set: (v) => n.setValue(Number(v) || 0), owns: (x) => n.contains(x) });
    return narrowLine(p, el('div', { class: 'np-seed' }, n, dice), 'np-seedrow');
  }

  // Un fichier du PC (la LUT .cube de la Finition) : son nom dans un bouton maison, le chemin complet en
  // info-bulle ; le sélecteur de Windows n'est qu'un secours (on peut lâcher le fichier sur le bloc, drop.js).
  function fileRow(p) {
    const accept = (p.accept || []).map((e) => String(e).toLowerCase());
    let cur = val(p) || '';
    const name = el('span', { class: 'np-file-name' });
    const btn = el('button', { class: 'np-file' }, el('span', { class: 'np-file-ico', html: icon('folder', 13) }), name);
    const clear = el('button', { class: 'np-icon-btn np-file-clear', html: icon('close', 12), 'data-tip': t('node.file.clear') });
    const paint = () => {
      name.textContent = cur ? baseName(cur) : (p.placeholder ? tl(p.placeholder) : t('node.file.pick'));
      btn.classList.toggle('empty', !cur);
      btn.dataset.tip = cur || t('node.file.tip');
      clear.hidden = !cur;
    };
    for (const b of [btn, clear]) b.addEventListener('pointerdown', stop);
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      let paths = [];
      try { paths = (await window.mia?.media?.pick?.({ kind: accept.includes('cube') ? 'lut' : 'media', multiple: false })) || []; } catch { paths = []; }
      const f = paths[0];
      if (!f) return;
      if (accept.length && !accept.some((x) => f.toLowerCase().endsWith(`.${x}`))) {
        toast(t('node.file.wrongExt', { ext: accept.map((x) => `.${x}`).join(', ') }), { kind: 'error' });
        return;
      }
      cur = f;
      paint();
      commit(p, f);
    });
    clear.addEventListener('click', (e) => {
      e.stopPropagation();
      cur = '';
      paint();
      commit(p, '');
    });
    paint();
    ctrls.set(p.id, { set: (v) => { cur = v || ''; paint(); }, owns: () => false });
    return narrowLine(p, el('div', { class: 'np-file-wrap' }, btn, clear), 'np-filerow');
  }

  function modelRow(p) {
    const lora = isLoraParam(p);
    const c = modelPicker({ param: p, value: val(p), onChange: (v) => commit(p, v), base: lora ? baseKey : undefined });
    ctrls.set(p.id, { set: (v) => c.setValue(v), owns: (x) => c.contains(x), refresh: () => c.refresh?.() });
    cleanups.push(() => c.destroy?.());
    const row = narrowLine(p, c, `np-model${lora ? ' np-lora' : ''}`);
    if (lora) {
      // un LoRA choisi puis rendu inutilisable par un changement de modèle : on le dit
      const warn = el('div', { class: 'np-note np-warn', hidden: true });
      row.classList.add('np-wrap');
      row.append(warn);
      ctrls.get(p.id).warn = warn;
    }
    return row;
  }

  // Curseur d'image sur la vidéo branchée : exact à l'image, -1 = dernière.
  // Le compteur a une largeur réservée (selon le nombre d'images de la vidéo), la même pour toutes les
  // rangées d'un bloc : les rails de « Début » et « Fin » ont la même longueur. « Dernière » (-1, qui suit
  // la vidéo) se lit sur le bouton ⇥ allumé. Sans vidéo, le message passe dans une note sous le rail
  // (une seule fois par entrée), jamais dans la case du compteur.
  const frameNoteOwner = new Map();      // entrée → id du premier réglage frame qui la suit
  function frameRow(p) {
    const fill = el('div', { class: 'np-fr-fill' });
    const knob = el('div', { class: 'np-fr-knob' });
    const rail = el('div', { class: 'np-fr-rail' }, fill, knob);
    const track = el('div', { class: 'np-fr-track' }, rail);
    const num = el('span', { class: 'np-fr-num', 'data-tip': t('node.frame.tip') });
    const bFirst = el('button', { class: 'np-icon-btn', html: icon('to-start', 14), 'data-tip': t('node.frame.first') });
    const bLast = el('button', { class: 'np-icon-btn', html: icon('to-end', 14) });
    const box = el('div', { class: 'np-frame' }, bFirst, track, bLast, num);
    if (!frameNoteOwner.has(p.of)) frameNoteOwner.set(p.of, p.id);
    const why = frameNoteOwner.get(p.of) === p.id ? el('div', { class: 'np-note np-fr-why', hidden: true }) : null;
    let value = val(p);
    let total = 0;
    let dragging = false;
    let endTimer = 0;

    function info() {
      const src = runs.source(nodeId, p.of);
      const meta = src?.meta || null;
      if (!src) return { ok: false, why: t('node.frame.noVideo') };
      if (src.kind !== 'video') return { ok: false, why: '' };        // une image : la rangée est cachée (shown)
      const fps = meta?.fps || 24;
      const n = meta?.frames || (meta?.duration ? Math.round(meta.duration * fps) : 0);
      return n ? { ok: true, n } : { ok: false, why: t('node.frame.unknown') };
    }

    function paint() {
      const i = info();
      total = i.ok ? i.n : 0;
      box.classList.toggle('disabled', !i.ok);
      // « 1199 / 1200 » : 2 × chiffres + « / » ; 3 chiffres au moins, pour que rien ne bouge
      const digits = Math.max(3, String(Math.max(1, total)).length);
      num.style.width = `calc(${digits * 2 + 3}ch + 4px)`;
      if (why) {
        why.hidden = i.ok || !i.why;
        if (!why.hidden && why.dataset.why !== i.why) {
          why.dataset.why = i.why;
          why.replaceChildren(el('span', { class: 'np-note-ico', html: icon('info', 12) }), el('span', {}, i.why));
        }
      }
      const last = value === -1 || (value == null && p.default === -1);
      bLast.classList.toggle('on', i.ok && last);
      bLast.dataset.tip = i.ok && last ? t('node.frame.lastOn', { f: total - 1 }) : t('node.frame.last');
      if (!i.ok) {
        num.textContent = '';
        fill.style.transform = 'scaleX(0)';
        knob.style.left = '0%';
        return;
      }
      const f = last ? total - 1 : clamp(Number(value) || 0, 0, total - 1);
      const frac = total > 1 ? f / (total - 1) : 0;
      fill.style.transform = `scaleX(${frac})`;
      knob.style.left = `${frac * 100}%`;
      // numéros à partir de 0 (comme f0048.png) ; « / n » = nombre d'images
      num.textContent = t('node.frame.of', { f, n: total });
    }

    function frameAt(e) {
      const r = rail.getBoundingClientRect();
      const frac = clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1);
      return Math.round(frac * (total - 1));
    }
    function preview(f) {
      clearTimeout(endTimer);
      opts.onScrub?.(p.id, f);
    }
    function endPreview() {
      clearTimeout(endTimer);
      endTimer = setTimeout(() => opts.onScrub?.(p.id, null), 1400);
    }

    track.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !total) return;
      e.stopPropagation();
      e.preventDefault();
      dragging = true;
      try { track.setPointerCapture(e.pointerId); } catch { /* pointeur déjà relâché */ }
      box.classList.add('active');
      value = frameAt(e);
      paint();
      preview(value);
    });
    track.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const f = frameAt(e);
      if (f === value) return;
      value = f;
      paint();
      preview(value);
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      box.classList.remove('active');
      try { track.releasePointerCapture(e.pointerId); } catch { /* rien */ }
      // la dernière image glissée devient « -1 » : elle suit si la vidéo change
      const v = value >= total - 1 && total > 1 ? -1 : value;
      value = v;
      commit(p, v);
      endPreview();
      paint();
    };
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
    // survol = aperçu de l'image visée, sans rien changer
    track.addEventListener('pointerenter', () => { if (total) preview(value === -1 ? total - 1 : value); });
    track.addEventListener('pointerleave', () => { if (!dragging) endPreview(); });

    for (const [b, v] of [[bFirst, 0], [bLast, -1]]) {
      b.addEventListener('pointerdown', stop);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!total) return;
        value = v;
        paint();
        commit(p, v);
        preview(v === -1 ? total - 1 : 0);
        endPreview();
      });
    }

    paint();
    ctrls.set(p.id, {
      set: (v) => { if (!dragging) { value = v; paint(); } },
      owns: () => dragging,
      refresh: paint,
    });
    const row = line(p, box, 'np-framerow');
    if (why) { row.classList.add('np-wrap'); row.append(why); }
    // ⇤ rail ⇥ compteur : moins de place que ça à côté du libellé, la rangée passe en pile
    stackWhenNarrow(row, () => (num.offsetWidth ? bFirst.offsetWidth + bLast.offsetWidth + num.offsetWidth + 64 + 6 : 0));
    return row;
  }

  // ── visibilité (showIf, LoRA, son d'origine) ────────────────────────
  const audioRule = NEEDS_SOURCE_AUDIO[type.id] || null;
  /** La vidéo branchée est-elle muette ? (inconnu = non : on montre tout) */
  function sourceSilent() {
    if (!audioRule) return false;
    let src = null;
    try { src = runs.source(nodeId, audioRule.port); } catch { src = null; }
    return !!src && src.kind === 'video' && src.meta?.hasAudio === false;
  }
  let noAudioNote = null;
  function shown(p) {
    if (p.showIf && !showIfOk(p.showIf, node, type)) return false;
    if (audioRule && audioRule.params.includes(p.id) && sourceSilent()) return false;
    // curseur d'image branché sur une IMAGE : il n'y a rien à choisir (« Branche une vidéo » serait faux)
    if (p.kind === 'frame' && p.of) {
      let src = null;
      try { src = runs.source(nodeId, p.of); } catch { src = null; }
      if (src && src.kind !== 'video') return false;
    }
    if (p.kind === 'model' && isLoraParam(p)) {
      const v = val(p);
      if (v && v !== 'none' && v !== 'auto') return true;      // choisi : on le montre toujours
      if (!state.inventory) return false;
      return loraChoices(baseKey()).compatible.length > 0;
    }
    return true;
  }

  function applyVisibility() {
    if (noAudioNote) {
      const silent = sourceSilent();
      if (noAudioNote.hidden === silent) noAudioNote.hidden = !silent;
    }
    for (const p of params) {
      const row = rows.get(p.id);
      if (!row) continue;
      const vis = shown(p);
      if (row.hidden === vis) row.hidden = !vis;
    }
    if (advBtn) {
      const any = adv.some((p) => !rows.get(p.id)?.hidden);
      advBtn.hidden = !any;
      if (!any && advBox) advBox.hidden = true;
      else if (advBox) advBox.hidden = !advBtn.classList.contains('open');
    }
    // LoRA devenu incompatible avec le modèle choisi
    if (loraParam) {
      const c = ctrls.get(loraParam.id);
      const l = chosenLora();
      const key = baseKey();
      const wrong = l && key && loraKeyOf(l) !== key;
      if (c?.warn) {
        c.warn.hidden = !wrong;
        // même gabarit que la note du mot déclencheur (icône + texte) ; seule la couleur l'en distingue
        if (wrong) {
          c.warn.replaceChildren(el('span', { class: 'np-note-ico', html: icon('warn', 12) }),
            el('span', {}, t('node.lora.wrongNow', { lora: familyLabel(loraKeyOf(l)), base: familyLabel(key) })));
        }
      }
      for (const x of ctrls.values()) x.trigger?.();
    }
  }

  // ── assemblage ──────────────────────────────────────────────────────
  if (audioRule) {
    noAudioNote = el('div', { class: 'np-note np-noaudio', hidden: true },
      el('span', { class: 'np-note-ico', html: icon('info', 12) }), el('span', {}, t('node.sound.noAudio')));
    root.append(noAudioNote);
  }
  for (const p of basic) root.append(rowFor(p));

  if (adv.length) {
    if (inspector) {
      advBtn = el('div', { class: 'np-section' }, t('node.advTitle'));
      advBtn.classList.add('open');
      root.append(advBtn);
      for (const p of adv) root.append(rowFor(p));
    } else {
      const open = advOpen.get(nodeId) === true;
      const chev = el('span', { class: 'np-adv-chev', html: icon('chevron-right', 12) });
      advBtn = el('button', { class: 'np-adv' }, el('span', {}, t('node.adv')), chev);
      advBox = el('div', { class: 'np-adv-box', hidden: !open });
      for (const p of adv) advBox.append(rowFor(p));
      advBtn.classList.toggle('open', open);
      advBtn.addEventListener('pointerdown', stop);
      advBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const now = advBox.hidden;
        advBox.hidden = !now;
        advBtn.classList.toggle('open', now);
        advOpen.set(nodeId, now);
      });
      root.append(advBtn, advBox);
    }
  }
  applyVisibility();

  // Un LoRA ajouté ou retiré (glisser un fichier, bibliothèque) fait apparaître la rangée.
  cleanups.push(on('models:updated', () => {
    for (const x of ctrls.values()) x.refresh?.();
    applyVisibility();
  }));

  // Les champs gardent le clavier : pas de raccourci de planche pendant la saisie.
  root.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, [contenteditable="true"]')) e.stopPropagation();
  });
  // Cliquer dans un champ ne doit pas déplacer le bloc.
  root.addEventListener('pointerdown', (e) => {
    if (e.target.closest('input, textarea, button, [role="slider"], .np-ctl, .np-prompt')) e.stopPropagation();
  });

  return {
    el: root,
    /** Reporte les valeurs du nœud (annuler, inspecteur) sans toucher au champ en cours d'édition. */
    sync(next) {
      if (next) node = next;
      const active = document.activeElement;
      for (const p of params) {
        const c = ctrls.get(p.id);
        if (!c) continue;
        if (active && c.owns(active)) continue;
        c.set(val(p));
      }
      applyVisibility();
    },
    /** Fils branchés ou débranchés : « Vient de … », curseurs d'image. */
    refreshInputs() {
      for (const c of ctrls.values()) c.refresh?.();
      applyVisibility();
    },
    destroy() {
      for (const fn of cleanups) { try { fn(); } catch { /* rien */ } }
      root.remove();
    },
  };
}

/** Hauteur d'un textarea qui suit son contenu (bornée par le CSS max-height). */
export function autoGrow(fieldEl) {
  const ta = fieldEl.matches?.('textarea') ? fieldEl : fieldEl.querySelector?.('textarea');
  if (!ta) return;
  const fit = () => {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight + 2}px`;
  };
  ta.addEventListener('input', fit);
  requestAnimationFrame(fit);
  // setValue() externe : réajuster aussi
  const set = fieldEl.setValue;
  if (typeof set === 'function') fieldEl.setValue = (v) => { set.call(fieldEl, v); requestAnimationFrame(fit); };
}
