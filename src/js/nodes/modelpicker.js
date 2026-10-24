// ── Sélecteur de modèle d'un bloc ────────────────────────────────────
// Deux formes (SPEC §22) :
// - **carte de modèle** (`lead`, blocs de génération) : première rangée du
//   bloc, pastille du fabricant + nom en évidence + ce que le modèle sait
//   faire (« IMAGES-CLÉS · 15 S · SON »). Au clic, un panneau façon fal :
//   recherche, onglets Local | Cloud, « Choisir pour moi » (= Auto),
//   épinglés, puis chaque famille (LTX, MiniMax…) avec sa phrase « à quoi
//   ça sert » et ses variantes. Cloud : Higgsfield, pas encore relié.
// - **liste simple** (autres blocs, LoRA) : « Auto · <nom réel> » puis les
//   modèles du PC qui savent faire ce que le bloc demande (SPEC §7 :
//   capacités ∩ prêt ∩ licence non interdite), en langage simple.
// Les modèles incomplets restent visibles, grisés, avec ce qui leur manque.
// Pied : « Voir tous les modèles » → bibliothèque.
//
// LoRA (« Personnage ou lieu », SPEC §12) : « Aucun » en tête, jamais « Auto » ;
// seuls les LoRA faits pour le modèle du bloc se choisissent, les autres sont
// grisés avec la raison (« fait pour Wan, pas pour LTX »).
//
// Liste maison (jamais de <select> : sa liste déroulante est une fenêtre Windows).

import { t, tl, has } from '../i18n.js';
import { icon, register as registerIcons } from '../icons.js';
import { el, fmtGB } from '../util.js';
import { on, emit } from '../bus.js';
import { state } from '../state.js';
import { tip } from '../ui/tooltip.js';
import { segmented, toggle } from '../ui/controls.js';
import { setPrefs } from '../ui/settings.js';
import { strings, num } from './media.js';
import { types, typeLabel, modelCaps } from '../catalog.js';
import {
  loadProfiles, profileOf, limitsOf, variantOf, familyKeyOf, familyName, familyDesc, makerOf, markOf, cloudProviders,
} from './profiles.js';

registerIcons({
  pin: '<path d="M9.5 3.5h5l-.8 5.6 3.3 3.4H7l3.3-3.4z"/><path d="M12 12.5v8"/>',
});

// Les profils arrivent après le premier dessin : on repeint alors les cartes.
loadProfiles().then(() => emit('profiles:ready'));

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
  'node.model.search': 'Chercher un modèle',
  'node.model.noMatch': 'Aucun modèle ne correspond à « {q} ».',
  'node.model.local': 'Local',
  'node.model.cloud': 'Cloud',
  'node.model.pickForMe': 'Choisir pour moi',
  'node.model.pickForMeSub': 'Mia prend le meilleur modèle installé : {name}',
  'node.model.pickForMeNone': 'Mia prendra le meilleur modèle dès qu’il y en aura un',
  'node.model.pinned': 'Épinglés',
  'node.model.pin': 'Épingler en haut de la liste',
  'node.model.unpin': 'Désépingler',
  'node.model.chip.local': 'Local',
  'node.model.chip.seconds': '{n} s',
  'node.model.chip.res': '{n}p',
  'node.model.chip.sound': 'Son',
  'node.model.chip.fps': '{n} i/s',
  'node.model.chip.auto': 'Auto',
  'node.model.cloud.soon': 'Bientôt',
  'node.model.cloud.link': 'Relier mon compte',
  'node.model.cloud.linkTip': 'Pas encore disponible : la connexion à Higgsfield est prévue (SPEC §22.3).',
  'node.model.notHere': 'Pas pour ce bloc',
  'node.model.notHereSub': 'Installés sur ce PC, mais ils ne savent pas faire ce que demande ce bloc.',
  'node.model.usedIn': 'Sert dans : {blocks}.',
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
  'node.model.search': 'Search a model',
  'node.model.noMatch': 'No model matches “{q}”.',
  'node.model.local': 'Local',
  'node.model.cloud': 'Cloud',
  'node.model.pickForMe': 'Pick for me',
  'node.model.pickForMeSub': 'Mia takes the best installed model: {name}',
  'node.model.pickForMeNone': 'Mia will take the best model as soon as there is one',
  'node.model.pinned': 'Pinned',
  'node.model.pin': 'Pin to the top of the list',
  'node.model.unpin': 'Unpin',
  'node.model.chip.local': 'Local',
  'node.model.chip.seconds': '{n} s',
  'node.model.chip.res': '{n}p',
  'node.model.chip.sound': 'Sound',
  'node.model.chip.fps': '{n} fps',
  'node.model.chip.auto': 'Auto',
  'node.model.cloud.soon': 'Soon',
  'node.model.cloud.link': 'Link my account',
  'node.model.cloud.linkTip': 'Not available yet: the Higgsfield connection is planned (SPEC §22.3).',
  'node.model.notHere': 'Not for this block',
  'node.model.notHereSub': 'Installed on this PC, but they cannot do what this block asks for.',
  'node.model.usedIn': 'Used in: {blocks}.',
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
    // la famille d'un bloc Modèle (SPEC §23) : le moteur dit au lancement ce qui manque (« aucun modèle MiniMax… »)
    if (p.kind !== 'model' || p.allowNone || p.gen) continue;
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

// ── ce que sait faire un modèle, en puces courtes (« 15 S · SON ») ───

/**
 * Puces d'un modèle pour ce bloc : durée max (si le bloc a une durée), définition max, cadence unique, son.
 * `short` (la carte du bloc, étroite) : sans la cadence, que le panneau montre.
 */
export function modelChips(m, param, { short = false } = {}) {
  if (!m) return [];
  const lim = limitsOf(m);
  const lims = new Set(param?.limits || []);
  const out = [];
  if (lims.has('seconds') && Array.isArray(lim.seconds)) out.push(t('node.model.chip.seconds', { n: lim.seconds[1] }));
  if (lims.has('resolutions') && Array.isArray(lim.resolutions) && lim.resolutions.length) {
    out.push(t('node.model.chip.res', { n: lim.resolutions[lim.resolutions.length - 1] }));
  }
  if (!short && lims.has('fps') && Array.isArray(lim.fps) && lim.fps.length === 1) out.push(t('node.model.chip.fps', { n: lim.fps[0] }));
  if (lims.has('audio') && lim.audio) out.push(t('node.model.chip.sound'));
  return out;
}

/** Phrase « à quoi ça sert » d'un modèle : celle de sa variante, sinon de sa famille, sinon du scanner. */
export function modelPurpose(m) {
  if (!m) return '';
  return variantOf(m)?.desc || familyDesc(m) || (m.desc ? tl(m.desc) : '');
}

// ── les modèles du PC qui ne savent pas faire ce bloc, et où ils servent ─
// (Quentin, 24/10 : « Pourquoi je vois pas LTX ? » dans Vidéo à partir de références.) Un modèle du même
// genre de résultat (vidéo, image retouchée…) qui manque au panneau doit y être, grisé, avec la raison.
const OUTPUT_GROUPS = [
  ['image-to-video', 'text-to-video', '3d-to-real', 'guided-video', 'reference-to-video', 'character-performance'],
  ['image-edit'], ['upscale'], ['depth'], ['cutout'],
];
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/** Modèles prêts, du même genre que ce bloc, qui ne savent pas le faire : [{ model, blocks:[libellés] }]. */
export function otherModels(caps = []) {
  const group = OUTPUT_GROUPS.find((g) => caps.some((c) => g.includes(c))) || [];
  const can = new Set(modelsFor(caps).ready.map((m) => m.id));
  const out = [];
  for (const m of inv()?.models || []) {
    if (m.status !== 'ready' || m.hidden || m.license === 'forbidden' || can.has(m.id)) continue;
    if (!(m.caps || []).some((c) => group.includes(c))) continue;
    const blocks = types().filter((ty) => ty.category === 'generate')
      .filter((ty) => { const mc = modelCaps(ty.id); return mc.some((c) => (m.caps || []).includes(c)) && !sameSet(mc, caps); })
      .map((ty) => typeLabel(ty));
    out.push({ model: m, blocks });
  }
  return out;
}

const pinned = () => new Set(Array.isArray(state.prefs?.pinnedModels) ? state.prefs.pinnedModels : []);
async function togglePin(id) {
  const p = pinned();
  if (p.has(id)) p.delete(id); else p.add(id);
  await setPrefs({ pinnedModels: [...p] });
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

/** Pastille du fabricant : monogramme mono, sobre (aucune couleur de marque). */
function markEl(m, name, cls = '') {
  return el('span', { class: `mp-mark ${cls}`, 'aria-hidden': 'true' }, markOf(m, name));
}

/**
 * Crée un sélecteur de modèle.
 * opts : { param, value, onChange(v), base?() → clé de famille du modèle du bloc (LoRA),
 *          lead? → carte de modèle en tête du bloc + panneau Local | Cloud }
 * Retour : élément avec .setValue(v), .refresh(), .setDisabled(b, why?)
 */
export function modelPicker({ param, value, onChange, base, lead = false }) {
  const lora = isLoraParam(param);
  const card = lead && !lora;
  let current = value ?? param.default ?? (lora ? 'none' : 'auto');
  let disabled = false;
  let disabledWhy = '';

  const txt = el('span', { class: 'mp-text' });
  let trigger;
  let cardMark = null;
  let cardChips = null;
  let cardAuto = null;
  if (card) {
    cardMark = el('span', { class: 'mp-mark lg', 'aria-hidden': 'true' });
    cardAuto = el('span', { class: 'mp-auto', hidden: true }, t('node.model.chip.auto'));
    cardChips = el('span', { class: 'mp-chips' });
    trigger = el('button', { class: 'mp-trigger mp-card' },
      cardMark,
      el('span', { class: 'mp-card-main' },
        el('span', { class: 'mp-card-line' }, txt, cardAuto),
        cardChips),
      el('span', { class: 'mp-chev', html: icon('chevron', 12) }));
  } else {
    trigger = el('button', { class: 'mp-trigger' }, txt, el('span', { class: 'mp-chev', html: icon('chevron', 12) }));
  }
  const root = el('div', { class: `mp${card ? ' mp-lead' : ''}` }, trigger);

  function paint() {
    if (!card) {
      const l = modelValueLabel(param, current);
      txt.textContent = l.text;
      trigger.classList.toggle('muted', !!l.muted);
      trigger.classList.toggle('warn', !!l.warn);
      return;
    }
    // carte : le nom de la famille en évidence, la variante et ce que le modèle sait faire en dessous
    const auto = current === 'auto' || current == null || current === '';
    const m = resolveModel(param, current);
    const l = modelValueLabel(param, current);
    if (m) {
      const v = variantOf(m);
      txt.textContent = profileOf(m) ? familyName(m) : modelName(m);
      cardMark.textContent = markOf(m, modelName(m));
      const chips = [v?.tag, ...modelChips(m, param, { short: true })].filter(Boolean);
      cardChips.textContent = chips.join(' · ');
      cardChips.hidden = !chips.length;
    } else {
      txt.textContent = auto && !inv() ? t('node.model.auto') : l.text;
      cardMark.textContent = '·';
      cardChips.textContent = '';
      cardChips.hidden = true;
    }
    cardAuto.hidden = !(auto && m);
    trigger.classList.toggle('muted', !m && !!l.muted);
    trigger.classList.toggle('warn', !m && !!l.warn);
  }
  tip(trigger, () => {
    if (disabled && disabledWhy) return disabledWhy;
    if (card) {
      const m = resolveModel(param, current);
      if (m) return modelPurpose(m);
    }
    return modelValueLabel(param, current).tip || '';
  });

  trigger.addEventListener('pointerdown', (e) => e.stopPropagation());
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (disabled) return;
    if (openPop?.owner === root) { closePop(); return; }
    if (card) openPanel(); else open();
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
          sub: modelPurpose(m),
          size: sizeText(m.sizeGB),
          badge: licenseBadge(m),
          selected: current === m.id,
        }));
      }
    } else if (inv() && !greyed.length && !missing.length) {
      list.append(el('div', { class: 'mp-empty' }, t('node.model.nothing')));
    }
    fillUnavailable(list, greyed, missing);
    return ready;
  }

  function fillUnavailable(list, greyed, missing) {
    if (!greyed.length && !missing.length) return;
    list.append(el('div', { class: 'mp-group' }, t('node.model.unavailable')));
    for (const m of greyed) {
      list.append(row({
        title: modelName(m), family: famTag(m),
        sub: m.statusNote ? tl(m.statusNote) : modelPurpose(m),
        note: t('node.model.incomplete'), greyed: true,
      }));
    }
    for (const x of missing) {
      list.append(row({ title: tl(x.what || {}), note: t('node.model.notInstalled'), greyed: true }));
    }
  }

  /** Infobulles riches (licence, mémoire) au survol d'une ligne de modèle. */
  function richTips(list, models) {
    for (const r of list.querySelectorAll('.mp-row[data-value]')) {
      const m = models.find((x) => x.id === r.dataset.value);
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
  }

  function open() {
    closePop();
    const caps = param.caps || [];
    const list = el('div', { class: 'mp-list', role: 'listbox' });
    const pop = el('div', { class: `mp-pop${lora ? ' mp-lora' : ''}` }, list);
    let ready = [];
    if (lora) fillLora(list);
    else ready = fillModels(list, caps);
    pop.append(footButton(caps));
    richTips(list, ready);
    document.body.append(pop);
    place(pop, trigger);
    mountKeys(pop, list, null);
  }

  function footButton(caps) {
    const foot = el('button', { class: 'mp-foot' }, el('span', {}, t('node.model.all')), el('span', { html: icon('chevron-right', 12) }));
    foot.addEventListener('click', (e) => { e.stopPropagation(); closePop(); emit('library:open', { caps }); });
    return foot;
  }

  // ── panneau Local | Cloud (carte de modèle) ────────────────────────
  let tab = 'local';
  function openPanel() {
    closePop();
    const caps = param.caps || [];
    const search = el('input', { class: 'mp-search-in', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: t('node.model.search') });
    const head = el('div', { class: 'mp-head' },
      el('label', { class: 'mp-search' }, el('span', { class: 'mp-search-ico', html: icon('search', 14) }), search));
    const tabs = segmented({
      options: [{ value: 'local', label: t('node.model.local') }, { value: 'cloud', label: t('node.model.cloud') }],
      value: tab, size: 'sm', full: true,
      onChange: (v) => { tab = v; render(); search.focus(); },
    });
    head.append(el('div', { class: 'mp-tabs' }, tabs));
    const list = el('div', { class: 'mp-list', role: 'listbox' });
    const pop = el('div', { class: 'mp-pop mp-panel' }, head, list, footButton(caps));

    function render() {
      const q = fold(search.value.trim());
      list.replaceChildren();
      if (tab === 'cloud') { fillCloud(list); return; }
      const { ready, greyed, missing } = modelsFor(caps);
      const def = defaultModel(caps);
      const auto = current === 'auto' || current == null || current === '';
      const match = (m) => !q || fold([modelName(m), familyName(m), makerOf(m), variantOf(m)?.tag, modelPurpose(m), familyDesc(m)].join(' ')).includes(q);

      // « Choisir pour moi » = Auto ; le couper fige le modèle qu'Auto désignait
      if (!q) {
        const sw = toggle({
          value: auto,
          onChange: (on) => {
            if (on) choose('auto');
            else if (def) choose(def.id);
            else sw.setValue(true);
          },
        });
        const autoRow = el('div', { class: 'mp-autorow' },
          el('span', { class: 'mp-main' },
            el('span', { class: 'mp-name' }, t('node.model.pickForMe')),
            el('span', { class: 'mp-sub' }, def ? t('node.model.pickForMeSub', { name: modelName(def) }) : t('node.model.pickForMeNone'))),
          sw);
        sw.addEventListener('pointerdown', (e) => e.stopPropagation());
        list.append(autoRow);
      }

      const shown = ready.filter(match);
      const pins = pinned();
      const pinnedList = shown.filter((m) => pins.has(m.id));
      if (pinnedList.length && !q) {
        list.append(el('div', { class: 'mp-group' }, t('node.model.pinned')));
        for (const m of pinnedList) list.append(variantRow(m, { auto, def, pinnedRow: true }));
      }

      // une section par famille, dans l'ordre de la liste (le défaut d'abord)
      const fams = new Map();
      for (const m of shown) {
        const k = familyKeyOf(m) || `id:${m.id}`;
        if (!fams.has(k)) fams.set(k, []);
        fams.get(k).push(m);
      }
      for (const models of fams.values()) list.append(familyBlock(models, { auto, def }));
      const others = fillOthers(list, ready, (m) => match(m));
      if (q && !shown.length && !others) list.append(el('div', { class: 'mp-empty' }, t('node.model.noMatch', { q: search.value.trim() })));
      if (!q) fillUnavailable(list, greyed, missing);
      else if (!inv()) list.append(el('div', { class: 'mp-empty' }, t('node.model.scanning')));
      richTips(list, ready);
      paintFocus();
    }

    function familyBlock(models, { auto, def }) {
      const m0 = models[0];
      const prof = profileOf(m0);
      const lic = licenseBadge(m0);
      const fname = prof ? familyName(m0) : modelName(m0);
      // le fabricant, sauf s'il ne fait que répéter le nom (« MiniMax H3 · MINIMAX »)
      const maker = makerOf(m0) && !fold(fname).includes(fold(makerOf(m0))) ? makerOf(m0) : '';
      const headEl = el('div', { class: 'mp-famhead' },
        markEl(m0, modelName(m0)),
        el('span', { class: 'mp-famname' }, fname),
        maker ? el('span', { class: 'mp-maker' }, maker) : null,
        lic ? el('span', { class: 'mp-badge' }, lic) : null);
      const desc = familyDesc(m0);
      const box = el('div', { class: 'mp-family' }, headEl);
      if (desc && prof) box.append(el('div', { class: 'mp-famdesc' }, desc));
      for (const m of models) box.append(variantRow(m, { auto, def }));
      return box;
    }

    function variantRow(m, { auto, def, pinnedRow = false }) {
      const v = variantOf(m);
      const prof = profileOf(m);
      // dans sa famille, une variante se nomme par son étiquette (« Rapide ») ; épinglée, par son nom complet
      const title = pinnedRow || !prof ? modelName(m) : (v?.tag || familyName(m));
      const chips = modelChips(m, param);
      const isSel = current === m.id || (auto && def?.id === m.id);
      const pin = el('button', {
        class: `mp-pin${pinned().has(m.id) ? ' on' : ''}`, type: 'button', html: icon('pin', 13),
        'data-tip': pinned().has(m.id) ? t('node.model.unpin') : t('node.model.pin'),
      });
      pin.addEventListener('pointerdown', (e) => e.stopPropagation());
      pin.addEventListener('click', async (e) => {
        e.stopPropagation();
        await togglePin(m.id);
        focus = -1;                                // la surbrillance revient sur le modèle choisi
        render();
      });
      // phrase sous le nom : épinglé → à quoi sert le modèle ; dans sa famille → ce que change la variante
      // (la phrase de la famille est déjà au-dessus) ; modèle sans profil → la phrase du scanner
      let sub = '';
      if (pinnedRow) sub = modelPurpose(m);
      else if (prof) sub = v?.desc || '';
      else sub = modelPurpose(m);
      const r = el('div', { class: `mp-row mp-var${isSel ? ' sel' : ''}${pinnedRow ? ' pinned' : ''}`, role: 'option', tabindex: '-1' },
        el('span', { class: 'mp-check', html: isSel ? icon('check', 13) : '' }),
        pinnedRow ? markEl(m, modelName(m), 'sm') : null,
        el('span', { class: 'mp-main' },
          el('span', { class: 'mp-line' },
            el('span', { class: 'mp-name' }, title),
            chips.length ? el('span', { class: 'mp-fam' }, chips.join(' · ')) : null),
          sub ? el('span', { class: 'mp-sub' }, sub) : null),
        el('span', { class: 'mp-side' }, m.sizeGB ? el('span', { class: 'mp-size' }, sizeText(m.sizeGB)) : null, pin));
      r.dataset.value = m.id;
      r.addEventListener('click', (e) => { e.stopPropagation(); choose(m.id); });
      return r;
    }

    /**
     * « Pas pour ce bloc » : les modèles du PC du même genre qui ne savent pas faire ce bloc, grisés, avec les
     * blocs où ils servent. Une famille absente du panneau tient en une ligne (« LTX 2.5 ») ; une variante d'une
     * famille présente garde son nom complet (« MiniMax H3 · Images-clés »). Renvoie le nombre de lignes.
     */
    function fillOthers(box, ready, match) {
      const others = otherModels(caps).filter((o) => match(o.model));
      if (!others.length) return 0;
      const here = new Set(ready.map((m) => familyKeyOf(m)).filter(Boolean));
      const rowsOut = new Map();                      // clé → { model, title, blocks:Set }
      for (const o of others) {
        const k = familyKeyOf(o.model);
        const whole = !k || !here.has(k);
        const key = whole ? `f:${k || o.model.id}` : `m:${o.model.id}`;
        const tag = variantOf(o.model)?.tag;
        const title = !profileOf(o.model) ? modelName(o.model) : whole || !tag ? familyName(o.model) : `${familyName(o.model)} · ${tag}`;
        if (!rowsOut.has(key)) rowsOut.set(key, { model: o.model, title, blocks: new Set() });
        for (const b of o.blocks) rowsOut.get(key).blocks.add(b);
      }
      box.append(el('div', { class: 'mp-group mp-group-other' }, t('node.model.notHere')),
        el('div', { class: 'mp-other-sub' }, t('node.model.notHereSub')));
      for (const r of rowsOut.values()) {
        const blocks = [...r.blocks];
        box.append(el('div', { class: 'mp-row mp-other greyed' },
          markEl(r.model, r.title, 'sm'),
          el('span', { class: 'mp-main' },
            el('span', { class: 'mp-name' }, r.title),
            blocks.length ? el('span', { class: 'mp-sub' }, t('node.model.usedIn', { blocks: blocks.join(', ') })) : null)));
      }
      return rowsOut.size;
    }

    function fillCloud(box) {
      const providers = cloudProviders();
      for (const c of providers) {
        // pas encore branché : bouton éteint (aria-disabled, pour garder son infobulle)
        const btn = el('button', { class: 'mp-cloud-btn', type: 'button', 'aria-disabled': 'true', 'data-tip': t('node.model.cloud.linkTip') }, t('node.model.cloud.link'));
        btn.addEventListener('pointerdown', (e) => e.stopPropagation());
        box.append(el('div', { class: 'mp-cloud' },
          el('div', { class: 'mp-famhead' },
            el('span', { class: 'mp-mark' }, c.mark || 'HF'),
            el('span', { class: 'mp-famname' }, c.name),
            el('span', { class: 'mp-badge' }, t('node.model.cloud.soon'))),
          el('div', { class: 'mp-famdesc' }, c.desc),
          el('div', { class: 'mp-cloud-foot' }, btn)));
      }
    }

    // navigation clavier + recherche au clavier
    let focus = -1;
    const rows = () => [...list.querySelectorAll('.mp-row[data-value]')];
    function paintFocus() {
      const all = rows();
      if (focus < 0 || focus >= all.length) focus = Math.max(0, all.findIndex((r) => r.classList.contains('sel')));
      all.forEach((r, i) => r.classList.toggle('focus', i === focus));
    }
    search.addEventListener('input', () => { focus = 0; render(); });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Escape') return;   // gérées plus bas
      e.stopPropagation();                                                   // pas de raccourci de planche en tapant
    });

    render();
    document.body.append(pop);
    place(pop, trigger, { width: 420 });
    mountKeys(pop, list, () => focus, (f) => { focus = f; paintFocus(); });
    requestAnimationFrame(() => search.focus());
  }

  /** ↑ ↓ Entrée Échap, fermeture au clic dehors, à la molette hors du panneau, à la perte du focus. */
  function mountKeys(pop, list, getFocus, setFocus) {
    const rows = () => [...list.querySelectorAll('.mp-row[data-value]')];
    let focus = Math.max(0, rows().findIndex((r) => r.classList.contains('sel')));
    const get = getFocus || (() => focus);
    const set = setFocus || ((f) => { focus = f; rows().forEach((r, i) => r.classList.toggle('focus', i === focus)); });
    set(get() < 0 ? focus : get());
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); trigger.focus(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        const n = rows().length;
        const f = (get() + (e.key === 'ArrowDown' ? 1 : -1) + n) % Math.max(n, 1);
        set(f);
        rows()[f]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        const r = rows()[get()];
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
  const offProf = on('profiles:ready', () => { paint(); });
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
  root.destroy = () => { if (openPop?.owner === root) closePop(); offInv?.(); offProf?.(); };
  return root;
}

/** Place la liste sous le déclencheur (ou au-dessus s'il n'y a pas la place), bornée à l'écran. */
function place(pop, anchor, { width } = {}) {
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.min(vw - 16, width || Math.max(340, Math.min(420, r.width + 140)));
  pop.style.width = `${w}px`;
  const h = pop.offsetHeight;
  const left = Math.min(Math.max(8, width ? r.left : r.right - w), vw - w - 8);
  let top = r.bottom + 6;
  if (top + h > vh - 10 && r.top - h - 6 > 54) top = r.top - h - 6;
  top = Math.max(54, Math.min(top, vh - h - 10));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}
