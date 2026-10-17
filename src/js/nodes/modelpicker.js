// ── Sélecteur de modèle d'un bloc ────────────────────────────────────
// « Auto · <nom réel> » par défaut (le meilleur installé pour la capacité),
// puis la liste des modèles du PC qui savent faire ce que le bloc demande
// (SPEC §7 : capacités ∩ prêt ∩ licence non interdite), en langage simple :
// nom lisible (jamais mangé par la famille), poids, phrase d'usage, licence.
// Les modèles incomplets restent visibles, grisés, avec ce qui leur manque.
// Pied : « Voir tous les modèles » → bibliothèque.
//
// LoRA (« Personnage ou lieu », SPEC §12) : « Aucun » en tête, jamais « Auto » ;
// seuls les LoRA faits pour le modèle du bloc se choisissent, les autres sont
// grisés avec la raison (« fait pour Wan, pas pour LTX »).
//
// Liste maison (jamais de <select> : sa liste déroulante est une fenêtre Windows).

import { t, tl, has } from '../i18n.js';
import { icon } from '../icons.js';
import { el, fmtGB } from '../util.js';
import { on, emit } from '../bus.js';
import { state } from '../state.js';
import { tip } from '../ui/tooltip.js';
import { strings, num } from './media.js';

strings({
  'node.model.auto': 'Auto',
  'node.model.autoSub': 'Le meilleur modèle installé pour ce bloc',
  'node.model.noneReady': 'Aucun modèle prêt : voir pourquoi ci-dessous',
  'node.model.none': 'Aucun',
  'node.model.noneSub': 'Sans personnage ni lieu particulier',
  'node.model.unknown': 'Modèle introuvable',
  'node.model.unknownTip': 'Ce modèle n’est plus sur le PC. Choisis-en un autre ou laisse « Auto ».',
  'node.model.nothing': 'Aucun modèle installé',
  'node.model.nothingReady': 'Aucun modèle prêt',
  'node.model.scanning': 'Recherche des modèles…',
  'node.model.onPc': 'Sur ce PC',
  'node.model.unavailable': 'Pas disponible',
  'node.model.notInstalled': 'Non installé',
  'node.model.incomplete': 'Incomplet',
  'node.model.trial': 'Essais seulement',
  'node.model.rd': 'Recherche seulement',
  'node.model.ok': 'Usage commercial OK',
  'node.model.size': '{n} Go',
  'node.model.vram': '{n} Go de mémoire vidéo',
  'node.model.all': 'Voir tous les modèles',
  'node.lora.forThis': 'Pour ce bloc ({base})',
  'node.lora.others': 'Faits pour un autre modèle',
  'node.lora.wrong': 'fait pour {lora}, pas pour {base}',
  'node.lora.noBase': 'Aucun modèle prêt pour ce bloc',
  'node.lora.unknown': 'LoRA introuvable',
  'node.lora.unknownTip': 'Ce LoRA n’est plus dans Mia. Choisis-en un autre ou « Aucun ».',
  'node.lora.trigger': 'déclencheur « {w} »',
  'node.lora.kind.identity': 'Personnage',
  'node.lora.kind.character': 'Personnage',
  'node.lora.kind.place': 'Lieu',
  'node.lora.kind.style': 'Style',
  'node.lora.add': 'Glisse un fichier LoRA sur Mia pour en ajouter.',
  'node.model.missingTitle': 'Modèle non installé',
  'node.model.incompleteTitle': 'Modèle incomplet',
  'node.model.unknownTitle': 'Modèle introuvable',
  'node.model.missingSub': 'Aucun modèle installé ne sait faire ce bloc.',
  'node.model.unknownSub': 'Le modèle choisi n’est plus sur le PC. Choisis-en un autre ou « Auto ».',
}, {
  'node.model.auto': 'Auto',
  'node.model.autoSub': 'The best installed model for this block',
  'node.model.noneReady': 'No model ready: see why below',
  'node.model.none': 'None',
  'node.model.noneSub': 'No particular character or place',
  'node.model.unknown': 'Model not found',
  'node.model.unknownTip': 'This model is no longer on the PC. Pick another or keep “Auto”.',
  'node.model.nothing': 'No model installed',
  'node.model.nothingReady': 'No model ready',
  'node.model.scanning': 'Looking for models…',
  'node.model.onPc': 'On this PC',
  'node.model.unavailable': 'Not available',
  'node.model.notInstalled': 'Not installed',
  'node.model.incomplete': 'Incomplete',
  'node.model.trial': 'Trials only',
  'node.model.rd': 'Research only',
  'node.model.ok': 'Commercial use OK',
  'node.model.size': '{n} GB',
  'node.model.vram': '{n} GB of video memory',
  'node.model.all': 'See all models',
  'node.lora.forThis': 'For this block ({base})',
  'node.lora.others': 'Made for another model',
  'node.lora.wrong': 'made for {lora}, not for {base}',
  'node.lora.noBase': 'No model ready for this block',
  'node.lora.unknown': 'LoRA not found',
  'node.lora.unknownTip': 'This LoRA is no longer in Mia. Pick another or “None”.',
  'node.lora.trigger': 'trigger “{w}”',
  'node.lora.kind.identity': 'Character',
  'node.lora.kind.character': 'Character',
  'node.lora.kind.place': 'Place',
  'node.lora.kind.style': 'Style',
  'node.lora.add': 'Drop a LoRA file on Mia to add one.',
  'node.model.missingTitle': 'Model not installed',
  'node.model.incompleteTitle': 'Model incomplete',
  'node.model.unknownTitle': 'Model not found',
  'node.model.missingSub': 'No installed model can do this block.',
  'node.model.unknownSub': 'The chosen model is no longer on the PC. Pick another or “Auto”.',
});

// ── données ──────────────────────────────────────────────────────────

const inv = () => state.inventory || null;
const LORA_CAPS = ['lora', 'lora-identity'];
export const isLoraParam = (param) => (param?.caps || []).some((c) => LORA_CAPS.includes(c));

/** Modèles d'une liste de capacités, rangés : prêts d'abord, puis grisés. */
export function modelsFor(caps = []) {
  const models = inv()?.models || [];
  const wanted = (m) => (m.caps || []).some((c) => caps.includes(c));
  const ready = [];
  const greyed = [];
  for (const m of models) {
    if (!wanted(m) || m.license === 'forbidden' || m.hidden) continue;
    if (m.status === 'ready') ready.push(m);
    else if (m.status === 'incomplete') greyed.push({ ...m, why: 'incomplete' });
  }
  // le défaut en tête, puis par qualité décroissante puis par nom
  const def = defaultModel(caps);
  ready.sort((a, b) => (b.id === def?.id) - (a.id === def?.id) || (b.quality || 0) - (a.quality || 0)
    || tl(a.label || {}).localeCompare(tl(b.label || {}), 'fr'));
  // un manque déjà montré par un modèle incomplet grisé n'est pas répété
  const covered = new Set(greyed.flatMap((m) => m.caps || []));
  const missing = (inv()?.missing || []).filter((x) => (x.caps || []).some((c) => caps.includes(c))
    && !(x.caps || []).every((c) => covered.has(c) || !caps.includes(c)));
  return { ready, greyed, missing };
}

/** Modèle choisi par « Auto » pour ces capacités. */
export function defaultModel(caps = []) {
  const i = inv();
  if (!i) return null;
  for (const c of caps) {
    const id = i.capabilities?.[c]?.default;
    if (id) {
      const m = (i.models || []).find((x) => x.id === id);
      if (m) return m;
    }
  }
  return null;
}

/**
 * Le modèle du bloc est-il utilisable ? null si oui, sinon
 * { title, sub, caps } (non installé, incomplet, ou choisi puis disparu).
 */
export function modelProblem(type, node) {
  const inv = state.inventory;
  if (!inv) return null;                       // inventaire pas encore là : on ne crie pas au loup
  for (const p of type.params || []) {
    if (p.kind !== 'model' || p.allowNone) continue;
    const caps = p.caps || [];
    const v = node?.params?.[p.id] ?? p.default ?? 'auto';
    if (v && v !== 'auto' && v !== 'none') {
      const m = (inv.models || []).find((x) => x.id === v);
      if (!m) return { title: t('node.model.unknownTitle'), sub: t('node.model.unknownSub'), caps };
      if (m.status === 'ready') continue;
      return { title: t('node.model.incompleteTitle'), sub: m.statusNote ? tl(m.statusNote) : t('node.model.missingSub'), caps };
    }
    const { ready, greyed, missing } = modelsFor(caps);
    const capInfo = inv.capabilities?.[caps[0]];
    if (ready.length && capInfo?.available !== false) continue;
    if (greyed.length) {
      const g = greyed[0];
      return { title: t('node.model.incompleteTitle'), sub: g.statusNote ? `${tl(g.label || {})} : ${tl(g.statusNote)}` : t('node.model.missingSub'), caps };
    }
    const what = missing.find((x) => x.what)?.what;
    return { title: t('node.model.missingTitle'), sub: what ? tl(what) : t('node.model.missingSub'), caps };
  }
  return null;
}

/** Modèle réellement utilisé par un réglage (« auto » → le défaut ; null si rien de prêt). */
export function resolveModel(param, value) {
  const v = value ?? param?.default ?? 'auto';
  if (!param || v === 'none') return null;
  if (v === 'auto' || v === '' || v == null) return defaultModel(param.caps || []);
  return (inv()?.models || []).find((x) => x.id === v) || null;
}

export const modelName = (m) => (m ? tl(m.label || { fr: m.file || m.id }) : '');

// ── familles (filtrage des LoRA) ─────────────────────────────────────

const FAMILY_LABEL = { ltx: 'LTX', wan: 'Wan', qwen: 'Qwen', minimax: 'MiniMax', flux: 'Flux', sdxl: 'SDXL', sd15: 'SD 1.5', hunyuan: 'Hunyuan' };
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Clé de famille de base d'un modèle (« ltx », « wan »…) : baseKey du scanner, sinon déduite. */
export function baseKeyOf(m) {
  if (!m) return null;
  if (m.baseKey) return m.baseKey;
  const f = fold(m.family || m.file || '');
  for (const k of ['ltx', 'wan', 'qwen', 'minimax', 'flux', 'sdxl', 'hunyuan']) if (f.includes(k)) return k;
  return f.split(/[\s.\-_]/)[0] || null;
}

/** Famille visée par un LoRA. */
export const loraKeyOf = (l) => l?.loraFor || baseKeyOf(l);

/** « LTX », « Wan »… */
export const familyLabel = (key) => FAMILY_LABEL[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : '?');

/** LoRA proposables (personnages, lieux, styles : jamais les techniques). */
export function loraModels() {
  return (inv()?.models || []).filter((m) => (m.caps || []).some((c) => LORA_CAPS.includes(c))
    && !m.hidden && m.license !== 'forbidden' && m.loraKind !== 'technical' && m.loraKind !== 'control'
    && (!m.status || m.status === 'ready'));
}

/** LoRA compatibles / non compatibles avec une famille de base. */
export function loraChoices(baseKey) {
  const all = loraModels().sort((a, b) => modelName(a).localeCompare(modelName(b), 'fr'));
  if (!baseKey) return { compatible: [], incompatible: all };
  return {
    compatible: all.filter((l) => loraKeyOf(l) === baseKey),
    incompatible: all.filter((l) => loraKeyOf(l) !== baseKey),
  };
}

/** La famille n'ajoute-t-elle rien au nom ? (« LTX 2.5 » / « LTX-2.x » → on la tait) */
function famTag(m) {
  const f = m.family || '';
  const first = fold(f).split(/[\s.\-_]/)[0];
  return first && fold(modelName(m)).includes(first) ? '' : f;
}

const sizeText = (gb) => (gb ? (typeof fmtGB === 'function' ? fmtGB(gb) : t('node.model.size', { n: num(gb) })) : '');

function loraSub(l) {
  const k = l.kind || l.loraKind;   // genre choisi à l'ajout (Personnage / Lieu / Style), sinon deviné
  return [
    k && has(`node.lora.kind.${k}`) ? t(`node.lora.kind.${k}`) : '',
    l.trigger ? t('node.lora.trigger', { w: l.trigger }) : '',
  ].filter(Boolean).join(' · ');
}

/** Libellé du déclencheur pour une valeur de réglage. */
export function modelValueLabel(param, value) {
  const v = value ?? param.default ?? 'auto';
  if (v === 'none' || (isLoraParam(param) && (v === 'auto' || v === '' || v == null))) return { text: t('node.model.none') };
  if (v === 'auto' || v === '' || v == null) {
    const d = defaultModel(param.caps || []);
    if (!inv()) return { text: `${t('node.model.auto')}` };
    if (d) return { text: `${t('node.model.auto')} · ${modelName(d)}` };
    const incomplete = modelsFor(param.caps || []).greyed.length > 0;
    return { text: t(incomplete ? 'node.model.nothingReady' : 'node.model.nothing'), muted: true, warn: true };
  }
  const m = (inv()?.models || []).find((x) => x.id === v);
  if (m) return { text: modelName(m) };
  if (!inv()) return { text: '…', muted: true };
  return isLoraParam(param)
    ? { text: t('node.lora.unknown'), muted: true, warn: true, tip: t('node.lora.unknownTip') }
    : { text: t('node.model.unknown'), muted: true, warn: true, tip: t('node.model.unknownTip') };
}

function licenseBadge(m) {
  if (m.license === 'trial') return t('node.model.trial');
  if (m.license === 'rd') return t('node.model.rd');
  return '';
}

// ── liste déroulante ─────────────────────────────────────────────────

let openPop = null;   // une seule liste ouverte à la fois

function closePop() {
  if (!openPop) return;
  const p = openPop;
  openPop = null;
  p.cleanup();
  p.el.remove();
}

/**
 * Crée un sélecteur de modèle.
 * opts : { param, value, onChange(v), base?() → clé de famille du modèle du bloc (LoRA) }
 * Retour : élément avec .setValue(v), .refresh(), .setDisabled(b, why?)
 */
export function modelPicker({ param, value, onChange, base }) {
  const lora = isLoraParam(param);
  let current = value ?? param.default ?? (lora ? 'none' : 'auto');
  let disabled = false;
  let disabledWhy = '';

  const txt = el('span', { class: 'mp-text' });
  const trigger = el('button', { class: 'mp-trigger' }, txt, el('span', { class: 'mp-chev', html: icon('chevron', 12) }));
  const root = el('div', { class: 'mp' }, trigger);

  function paint() {
    const l = modelValueLabel(param, current);
    txt.textContent = l.text;
    trigger.classList.toggle('muted', !!l.muted);
    trigger.classList.toggle('warn', !!l.warn);
  }
  tip(trigger, () => (disabled && disabledWhy) || modelValueLabel(param, current).tip || '');

  trigger.addEventListener('pointerdown', (e) => e.stopPropagation());
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (disabled) return;
    if (openPop?.owner === root) { closePop(); return; }
    open();
  });

  function choose(v) {
    closePop();
    if (v === current) return;
    current = v;
    paint();
    onChange?.(v);
  }

  function row({ value: v, title, family, sub, size, badge, greyed, note, selected, muted }) {
    const r = el('div', { class: `mp-row${greyed ? ' greyed' : ''}${selected ? ' sel' : ''}${muted ? ' muted' : ''}`, role: 'option', tabindex: '-1' },
      el('span', { class: 'mp-check', html: selected ? icon('check', 13) : '' }),
      el('span', { class: 'mp-main' },
        el('span', { class: 'mp-line' },
          el('span', { class: 'mp-name' }, title),
          family ? el('span', { class: 'mp-fam' }, family) : null),
        sub ? el('span', { class: 'mp-sub' }, sub) : null),
      el('span', { class: 'mp-side' },
        note ? el('span', { class: 'mp-note' }, note) : null,
        size ? el('span', { class: 'mp-size' }, size) : null,
        badge ? el('span', { class: 'mp-badge' }, badge) : null));
    if (!greyed && v !== undefined) {
      r.dataset.value = String(v);
      r.addEventListener('click', (e) => { e.stopPropagation(); choose(v); });
    }
    return r;
  }

  function fillLora(list) {
    const key = base?.() || null;
    list.append(row({ value: 'none', title: t('node.model.none'), sub: t('node.model.noneSub'), selected: current === 'none' || current === 'auto' || current == null || current === '' }));
    const { compatible, incompatible } = loraChoices(key);
    if (compatible.length) {
      list.append(el('div', { class: 'mp-group' }, t('node.lora.forThis', { base: familyLabel(key) })));
      for (const l of compatible) {
        list.append(row({ value: l.id, title: modelName(l), sub: loraSub(l), size: sizeText(l.sizeGB), selected: current === l.id }));
      }
    }
    if (incompatible.length) {
      list.append(el('div', { class: 'mp-group' }, t('node.lora.others')));
      for (const l of incompatible) {
        const why = key ? t('node.lora.wrong', { lora: familyLabel(loraKeyOf(l)), base: familyLabel(key) }) : t('node.lora.noBase');
        list.append(row({ title: modelName(l), sub: why, greyed: true }));
      }
    }
    if (!compatible.length && !incompatible.length) list.append(el('div', { class: 'mp-empty' }, t('node.lora.add')));
  }

  function fillModels(list, caps) {
    const { ready, greyed, missing } = modelsFor(caps);
    const def = defaultModel(caps);
    if (param.allowNone) {
      list.append(row({ value: 'none', title: t('node.model.none'), sub: t('node.model.noneSub'), selected: current === 'none' }));
    }
    // « Auto » seulement s'il désigne vraiment quelque chose (ou si rien d'autre n'est possible)
    if (!(param.allowNone && !def)) {
      list.append(row({
        value: 'auto',
        title: def ? `${t('node.model.auto')} · ${modelName(def)}` : t('node.model.auto'),
        sub: !inv() ? t('node.model.scanning') : def ? t('node.model.autoSub') : t('node.model.noneReady'),
        muted: !def,
        selected: current === 'auto' || current == null || current === '',
      }));
    }
    if (ready.length) {
      list.append(el('div', { class: 'mp-group' }, t('node.model.onPc')));
      for (const m of ready) {
        list.append(row({
          value: m.id, title: modelName(m), family: famTag(m),
          sub: m.desc ? tl(m.desc) : '',
          size: sizeText(m.sizeGB),
          badge: licenseBadge(m),
          selected: current === m.id,
        }));
      }
    } else if (inv() && !greyed.length && !missing.length) {
      list.append(el('div', { class: 'mp-empty' }, t('node.model.nothing')));
    }
    if (greyed.length || missing.length) {
      list.append(el('div', { class: 'mp-group' }, t('node.model.unavailable')));
      for (const m of greyed) {
        list.append(row({
          title: modelName(m), family: famTag(m),
          sub: m.statusNote ? tl(m.statusNote) : (m.desc ? tl(m.desc) : ''),
          note: t('node.model.incomplete'), greyed: true,
        }));
      }
      for (const x of missing) {
        list.append(row({ title: tl(x.what || {}), note: t('node.model.notInstalled'), greyed: true }));
      }
    }
    return ready;
  }

  function open() {
    closePop();
    const caps = param.caps || [];
    const list = el('div', { class: 'mp-list', role: 'listbox' });
    const pop = el('div', { class: `mp-pop${lora ? ' mp-lora' : ''}` }, list);
    let ready = [];
    if (lora) fillLora(list);
    else ready = fillModels(list, caps);
    const foot = el('button', { class: 'mp-foot' }, el('span', {}, t('node.model.all')), el('span', { html: icon('chevron-right', 12) }));
    foot.addEventListener('click', (e) => { e.stopPropagation(); closePop(); emit('library:open', { caps }); });
    pop.append(foot);

    // Tooltips riches : licence et mémoire, au survol d'une ligne de modèle.
    for (const r of list.querySelectorAll('.mp-row[data-value]')) {
      const m = ready.find((x) => x.id === r.dataset.value);
      if (!m) continue;
      tip(r, () => [
        m.licenseNote ? tl(m.licenseNote) : (m.license === 'ok' ? t('node.model.ok') : ''),
        m.vramGB ? t('node.model.vram', { n: num(m.vramGB) }) : '',
      ].filter(Boolean).join(' · '));
    }
    // une raison tronquée se lit en entier au survol
    for (const r of list.querySelectorAll('.mp-row.greyed')) {
      const sub = r.querySelector('.mp-sub')?.textContent || '';
      if (sub) tip(r, () => sub);
    }

    document.body.append(pop);
    place(pop, trigger);

    // Navigation clavier : ↑ ↓ Entrée Échap.
    const rows = () => [...list.querySelectorAll('.mp-row[data-value]')];
    let focus = Math.max(0, rows().findIndex((r) => r.classList.contains('sel')));
    const paintFocus = () => rows().forEach((r, i) => r.classList.toggle('focus', i === focus));
    paintFocus();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); trigger.focus(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        const n = rows().length;
        focus = (focus + (e.key === 'ArrowDown' ? 1 : -1) + n) % Math.max(n, 1);
        paintFocus();
        rows()[focus]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        const r = rows()[focus];
        if (r) choose(r.dataset.value);
      }
    };
    const onDown = (e) => { if (!pop.contains(e.target) && !trigger.contains(e.target)) closePop(); };
    const onWheel = (e) => { if (!pop.contains(e.target)) closePop(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('wheel', onWheel, true);
    window.addEventListener('blur', closePop);
    trigger.classList.add('open');
    openPop = {
      el: pop, owner: root,
      cleanup() {
        trigger.classList.remove('open');
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('pointerdown', onDown, true);
        window.removeEventListener('wheel', onWheel, true);
        window.removeEventListener('blur', closePop);
      },
    };
  }

  const offInv = on('models:updated', () => { paint(); });
  paint();

  root.setValue = (v) => { current = v ?? param.default ?? (lora ? 'none' : 'auto'); paint(); };
  root.refresh = paint;
  root.setDisabled = (b, why = '') => {
    disabled = !!b;
    disabledWhy = why || '';
    trigger.disabled = disabled;
    root.classList.toggle('disabled', disabled);
    if (disabled && openPop?.owner === root) closePop();
  };
  root.destroy = () => { if (openPop?.owner === root) closePop(); offInv?.(); };
  return root;
}

/** Place la liste sous le déclencheur (ou au-dessus s'il n'y a pas la place), bornée à l'écran. */
function place(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  const w = Math.max(340, Math.min(420, r.width + 140));
  pop.style.width = `${w}px`;
  const h = pop.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  const left = Math.min(Math.max(8, r.right - w), vw - w - 8);
  let top = r.bottom + 6;
  if (top + h > vh - 10 && r.top - h - 6 > 54) top = r.top - h - 6;
  top = Math.max(54, Math.min(top, vh - h - 10));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}
