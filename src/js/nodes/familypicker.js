// ── Choix du modèle d'un bloc Modèle (SPEC §23) ──────────────────────
// Carte en tête du bloc : la pastille du fabricant (sa couleur) et le nom de la
// famille (« MiniMax H3 », « Seedance 2.5 »), puis ce qu'elle sait faire en mots
// courts (« TEXTE · IMAGE · RÉFÉRENCES »). Au clic, un panneau (refait le 28/10,
// demande de Quentin : favoris, couleur, navigation) :
// - en haut, la recherche, puis ce qu'on veut faire (Vidéo, Image, Animer,
//   Références…) en puces qui filtrent ;
// - à gauche, où chercher : Tout, Favoris, Récents, Sur ce PC, En ligne ;
// - au milieu, une ligne courte par famille : pastille colorée, nom, fabricant,
//   ce qu'elle sait faire, « dès … $ » en ligne, l'étoile des favoris ; les
//   variantes du PC (LTX Standard / Rapide) sous leur famille ;
// - en bas, la phrase entière de la famille survolée (une seule fois, plutôt
//   qu'un paragraphe par ligne qui ne laissait voir que cinq modèles).
// Sans compte Higgsfield relié, un bandeau dit où le relier ; le choix reste
// possible (le bloc le rappellera au lancement).
// Valeurs : « fam:<clé> » (une famille locale), l'id d'un modèle de
// l'inventaire (une variante précise), « hf:<famille> » (en ligne).
// Favoris et récents : prefs.favModels, prefs.recentModels (clés de famille).

import { t, tl } from '../i18n.js';
import { icon } from '../icons.js';
import { el, fmtGB } from '../util.js';
import { on, emit } from '../bus.js';
import { state } from '../state.js';
import { tip } from '../ui/tooltip.js';
import { setPrefs } from '../ui/settings.js';
import { money } from '../ui/budget.js';
import { fromPrice, askFromPrices } from '../ui/fromprices.js';
import { strings } from './media.js';
import { localCatalog, cloudCatalog, variantOf } from './profiles.js';
import { familyOf, localKeyOf } from './route.js';
import { modelName } from './modelpicker.js';

strings({
  'node.fam.local': 'Sur ce PC',
  'node.fam.cloud': 'En ligne',
  'node.fam.all': 'Tout',
  'node.fam.favs': 'Favoris',
  'node.fam.recent': 'Récents',
  'node.fam.search': 'Chercher un modèle (LTX, Seedance, Kling…)',
  'node.fam.noMatch': 'Aucun modèle ne correspond à « {q} ».',
  'node.fam.noFilter': 'Aucun modèle ne fait ça ici. Essaie « Tout ».',
  'node.fam.favEmpty': 'Pas encore de favori : l’étoile au bout d’une ligne en ajoute un.',
  'node.fam.fav': 'Ajouter aux favoris',
  'node.fam.unfav': 'Retirer des favoris',
  'node.fam.from': 'dès {price}',
  'node.fam.priceTip': 'Le moins cher de ce modèle (plus petite définition, plus courte durée), donné par Higgsfield.',
  'node.fam.onPc': 'Sur ce PC',
  'node.fam.notInstalled': 'Non installé',
  'node.fam.install': 'Installer',
  'node.fam.installTip': 'Ouvre la bibliothèque sur ce qu’il faut télécharger pour ce modèle.',
  'node.fam.unknown': 'Modèle introuvable',
  'node.fam.unknownTip': 'Ce modèle n’existe plus dans Mia. Choisis-en un autre.',
  'node.fam.byWires': 'MiniMax prend lui-même le bon modèle selon ce que tu branches : références, image de début, vidéo à prolonger, vidéo guide ou texte seul.',
  'node.fam.cloudChecking': 'Vérification du compte Higgsfield…',
  'node.fam.online': 'En ligne',
  'node.fam.tipLocal': 'Modèle · sur ce PC',
  'node.fam.tipCloud': 'Modèle · en ligne, payant',
  'node.fam.paid': 'Payant',
  'node.fam.cloudLink': 'Ces modèles calculent chez Higgsfield (crédits). Relie ton compte pour les lancer.',
  'node.fam.cloudLinkBtn': 'Relier mon compte',
  'node.fam.cloudLinked': 'Compte Higgsfield relié · chaque calcul coûte des crédits.',
  'node.fam.video': 'Vidéo',
  'node.fam.image': 'Image',
  'node.fam.videoOnline': 'En ligne · vidéo',
  'node.fam.imageOnline': 'En ligne · image',
  'node.fam.keys': '↑ ↓ pour parcourir · Entrée pour choisir · Échap pour fermer',
  'node.fam.w.text': 'Texte',
  'node.fam.w.image': 'Animer',
  'node.fam.w.refs': 'Références',
  'node.fam.w.guided': 'Guidée',
  'node.fam.w.real': '3D → réel',
  'node.fam.w.act': 'Personnage',
  'node.fam.w.sheet': 'Fiche',
  'node.fam.w.edit': 'Retouche',
  'node.fam.w.vedit': 'Modifier',
  'node.fam.w.extend': 'Prolonger',
  'node.fam.w.follow': 'Suivre une vidéo',
  'node.fam.w.swap': 'Remplacer',
  'node.fam.w.restyle': 'Restyler',
  'node.fam.w.cinema': 'Plan de cinéma',
}, {
  'node.fam.local': 'On this PC',
  'node.fam.cloud': 'Online',
  'node.fam.all': 'All',
  'node.fam.favs': 'Favourites',
  'node.fam.recent': 'Recent',
  'node.fam.search': 'Search a model (LTX, Seedance, Kling…)',
  'node.fam.noMatch': 'No model matches “{q}”.',
  'node.fam.noFilter': 'No model does that here. Try “All”.',
  'node.fam.favEmpty': 'No favourite yet: the star at the end of a row adds one.',
  'node.fam.fav': 'Add to favourites',
  'node.fam.unfav': 'Remove from favourites',
  'node.fam.from': 'from {price}',
  'node.fam.priceTip': 'This model’s cheapest run (smallest resolution, shortest length), as priced by Higgsfield.',
  'node.fam.onPc': 'On this PC',
  'node.fam.notInstalled': 'Not installed',
  'node.fam.install': 'Install',
  'node.fam.installTip': 'Opens the library on what to download for this model.',
  'node.fam.unknown': 'Model not found',
  'node.fam.unknownTip': 'This model no longer exists in Mia. Choose another one.',
  'node.fam.byWires': 'MiniMax picks the right model itself from what you connect: references, a start image, a video to extend, a guide video or text alone.',
  'node.fam.cloudChecking': 'Checking the Higgsfield account…',
  'node.fam.online': 'Online',
  'node.fam.tipLocal': 'Model · on this PC',
  'node.fam.tipCloud': 'Model · online, paid',
  'node.fam.paid': 'Paid',
  'node.fam.cloudLink': 'These models run at Higgsfield (credits). Link your account to run them.',
  'node.fam.cloudLinkBtn': 'Link my account',
  'node.fam.cloudLinked': 'Higgsfield account linked · each job costs credits.',
  'node.fam.video': 'Video',
  'node.fam.image': 'Image',
  'node.fam.videoOnline': 'Online · video',
  'node.fam.imageOnline': 'Online · image',
  'node.fam.keys': '↑ ↓ to browse · Enter to choose · Esc to close',
  'node.fam.w.text': 'Text',
  'node.fam.w.image': 'Animate',
  'node.fam.w.refs': 'References',
  'node.fam.w.guided': 'Guided',
  'node.fam.w.real': '3D → real',
  'node.fam.w.act': 'Character',
  'node.fam.w.sheet': 'Sheet',
  'node.fam.w.edit': 'Edit',
  'node.fam.w.vedit': 'Edit video',
  'node.fam.w.extend': 'Extend',
  'node.fam.w.follow': 'Follow a video',
  'node.fam.w.swap': 'Swap',
  'node.fam.w.restyle': 'Restyle',
  'node.fam.w.cinema': 'Cinema shot',
});

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Clé du mot court d'une façon de faire (workflow) : « text », « image », « refs »… (null si inconnue). */
function wordKey(wf) {
  const id = String(wf.id || '');
  const rules = [
    [/^t2v$|^t2i$|text-to-video/, 'text'], [/^i2v$|image-to-video|first-last-frame/, 'image'],
    [/^refs$|reference-to-video|image-reference|custom-references/, 'refs'], [/^guided$/, 'guided'], [/^real$/, 'real'],
    [/^perform$|motion-control|motion-transfer/, 'act'], [/video-edit/, 'vedit'], [/^extend$|video-extend/, 'extend'], [/^sheet$/, 'sheet'],
    [/video-reference/, 'follow'], [/object-swap/, 'swap'], [/restyle/, 'restyle'], [/cinema-studio/, 'cinema'],
    [/^edit$|\/edit$/, 'edit'], [/text-to-image|soul|ideogram|z-image|recraft|grok-imagine-image|ads-studio|marketing-studio/, 'text'],
  ];
  const r = rules.find(([re]) => re.test(id));
  return r ? r[1] : null;
}

/** Ce que sait faire une famille, en mots courts, sans doublon, toujours dans le même ordre (texte, image…). */
const WORD_ORDER = ['text', 'image', 'refs', 'sheet', 'guided', 'real', 'act', 'edit', 'vedit', 'extend', 'follow', 'swap', 'restyle', 'cinema'];
const wordKeys = (def) => [...new Set((def?.workflows || []).map((wf) => wordKey(wf) || `=${tl(wf.label || {})}`))]
  .sort((a, b) => (WORD_ORDER.indexOf(a) + 1 || 99) - (WORD_ORDER.indexOf(b) + 1 || 99));
export function familyWords(def) {
  return wordKeys(def).map((k) => (k.startsWith('=') ? k.slice(1) : t(`node.fam.w.${k}`)));
}

/**
 * La couleur d'un fabricant (sa pastille) : elle dit d'où vient un modèle d'un coup d'œil, à petite dose (la pastille
 * seule, teinte sourde). Demande de Quentin du 28/10 (« amener de la couleur ») ; jusque-là, tout était gris.
 */
const MAKER_HUE = [
  [/lightricks/i, '#8f7cf7'], [/minimax|hailuo/i, '#f06b93'], [/kling/i, '#3cc28f'], [/bytedance/i, '#4c9dff'],
  [/qwen/i, '#e9b23e'], [/alibaba|wan|happy ?horse/i, '#f0883e'], [/higgsfield/i, '#b9cf45'], [/black forest/i, '#a3adbf'],
  [/xai/i, '#c2c3cc'], [/pixverse/i, '#c879e3'], [/recraft/i, '#ef6352'], [/ideogram/i, '#dcc44b'], [/google/i, '#5b8def'],
  [/openai/i, '#5fc7b2'],
];
export function makerColor(def) {
  const who = `${def?.maker || ''} ${def?.name || ''}`;
  return (MAKER_HUE.find(([re]) => re.test(who)) || [null, '#9aa0aa'])[1];
}

/** Familles locales qui ont des façons de faire, avec leurs modèles prêts sur ce PC. */
function localFamilies() {
  const fams = localCatalog().families || {};
  const models = (state.inventory?.models || []).filter((m) => m.status === 'ready' && !m.hidden && m.license !== 'forbidden' && m.role !== 'lora');
  return Object.entries(fams).filter(([, f]) => Array.isArray(f.workflows) && f.workflows.length).map(([key, def]) => {
    const mine = models.filter((m) => localKeyOf(m, fams) === key);
    // des variantes au choix seulement si elles savent toutes la même chose (LTX Standard / Rapide)
    const capsSig = (m) => [...(m.caps || [])].sort().join(',');
    const same = mine.length > 1 && mine.every((m) => capsSig(m) === capsSig(mine[0]));
    return { key, def, models: mine, variants: same ? mine : [], installed: mine.length > 0 };
  });
}

/** Toutes les familles en une liste : { fam (« fam:ltx » | « hf:… »), def, cloud, kind, words, installed, variants, hay } */
function allFamilies() {
  const local = localFamilies().map((f) => ({
    fam: `fam:${f.key}`, def: f.def, cloud: false, kind: f.def.kind === 'image' ? 'image' : 'video',
    installed: f.installed, variants: f.variants, models: f.models,
  }));
  const cloud = (cloudCatalog().families || []).map((def) => ({
    fam: def.key, def, cloud: true, kind: def.kind === 'image' ? 'image' : 'video', installed: true, variants: [], models: [],
  })).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'video' ? -1 : 1) || a.def.name.localeCompare(b.def.name));
  return [...local, ...cloud].map((e) => ({
    ...e, keys: wordKeys(e.def), words: familyWords(e.def),
    hay: fold(`${e.def.name} ${e.def.maker || ''} ${familyWords(e.def).join(' ')} ${tl(e.def.desc || {})}`),
  }));
}

const favList = () => (Array.isArray(state.prefs?.favModels) ? state.prefs.favModels : []);
const recentList = () => (Array.isArray(state.prefs?.recentModels) ? state.prefs.recentModels : []);

let openPop = null;
function closePop() {
  if (!openPop) return;
  const p = openPop;
  openPop = null;
  p.cleanup();
  p.el.remove();
}

const markOfDef = (def) => def.mark || String(def.maker || def.name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
const markEl = (def, size = '') => el('span', { class: `mp-mark${size ? ` ${size}` : ''}`, style: `--mk:${makerColor(def)}`, 'aria-hidden': 'true' }, markOfDef(def));

/**
 * Sélecteur de famille d'un bloc Modèle. opts : { param, value, onChange(v) }.
 * Retour : élément avec .setValue(v), .refresh(), .setDisabled(b, why?), .destroy()
 */
export function familyPicker({ param, value, onChange }) {
  let current = value ?? param.default ?? 'fam:ltx';
  let disabled = false;
  let disabledWhy = '';
  let linked = null;                          // compte Higgsfield relié ? (demandé à l'ouverture)

  const mark = el('span', { class: 'mp-mark lg', 'aria-hidden': 'true' });
  const txt = el('span', { class: 'mp-text' });
  const where = el('span', { class: 'mp-auto', hidden: true });
  const chips = el('span', { class: 'mp-chips' });
  const trigger = el('button', { class: 'mp-trigger mp-card' }, mark,
    el('span', { class: 'mp-card-main' }, el('span', { class: 'mp-card-line' }, txt, where), chips),
    el('span', { class: 'mp-chev', html: icon('chevron', 12) }));
  const root = el('div', { class: 'mp mp-lead mp-famcard' }, trigger);

  const famNow = () => familyOf(current, localCatalog(), cloudCatalog(), state.inventory);
  /** La famille d'une valeur (une variante du PC compte pour sa famille) : sa clé de favori. */
  const famKeyOf = (v) => {
    if (String(v).startsWith('hf:') || String(v).startsWith('fam:')) return String(v);
    const f = familyOf(v, localCatalog(), cloudCatalog(), state.inventory);
    return f ? (f.provider === 'local' ? `fam:${f.key}` : f.def.key) : String(v);
  };

  function paint() {
    const fam = famNow();
    if (!fam) {
      txt.textContent = t('node.fam.unknown');
      mark.textContent = '·';
      mark.style.removeProperty('--mk');
      chips.textContent = '';
      where.hidden = true;
      trigger.classList.add('warn');
      return;
    }
    trigger.classList.remove('warn');
    const def = fam.def;
    txt.textContent = def.name;
    mark.textContent = markOfDef(def);
    mark.style.setProperty('--mk', makerColor(def));
    const words = familyWords(def);
    const v = fam.variant ? variantOf(fam.variant)?.tag : '';
    chips.textContent = [v, ...words].filter(Boolean).join(' · ');
    where.hidden = fam.provider === 'local';
    where.textContent = t('node.fam.online');
  }
  // au survol : où il calcule, son nom, à quoi il sert, ce qu'il sait faire (infobulle riche)
  tip(trigger, () => {
    if (disabled && disabledWhy) return disabledWhy;
    if (openPop?.owner === root) return '';
    const fam = famNow();
    if (!fam) return t('node.fam.unknownTip');
    const v = fam.variant ? variantOf(fam.variant)?.tag : '';
    return {
      kicker: fam.provider === 'local' ? t('node.fam.tipLocal') : t('node.fam.tipCloud'),
      title: v ? `${fam.def.name} · ${v}` : fam.def.name,
      body: tl(fam.def.desc || {}),
      meta: familyWords(fam.def).join(' · '),
    };
  });

  trigger.addEventListener('pointerdown', (e) => e.stopPropagation());
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (disabled) return;
    if (openPop?.owner === root) { closePop(); return; }
    open();
  });

  function choose(v) {
    closePop();
    // récents : les cinq dernières familles choisies, la plus récente d'abord
    const key = famKeyOf(v);
    const rec = [key, ...recentList().filter((k) => k !== key)].slice(0, 5);
    if (rec.join() !== recentList().join()) setPrefs({ recentModels: rec }).catch?.(() => {});
    if (v === current) return;
    current = v;
    paint();
    onChange?.(v);
  }

  function open() {
    closePop();
    const fams = allFamilies();
    // où chercher (colonne de gauche) et ce qu'on veut faire (puces) ; les dernières vues retenues pour la session
    const view = { scope: openView.scope, kind: null, task: null };
    if (view.scope === 'favs' && !favList().length) view.scope = 'all';

    const search = el('input', { class: 'mp-search-in', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: t('node.fam.search') });
    const head = el('div', { class: 'fp-head' },
      el('label', { class: 'mp-search' }, el('span', { class: 'mp-search-ico', html: icon('search', 14) }), search));

    // ce qu'on veut faire : Vidéo, Image, puis les façons de faire que plusieurs modèles savent (Texte, Animer,
    // Références…) ; celles d'un seul modèle (Plan de cinéma…) se trouvent par la recherche
    const taskKeys = WORD_ORDER.filter((k) => fams.filter((f) => f.keys.includes(k)).length >= 2).slice(0, 8);
    const chipRow = el('div', { class: 'fp-chips', role: 'toolbar' });
    const chipEls = [];
    const addChip = (label, isOn, toggle, extra = '') => {
      const c = el('button', { class: `fp-chip${extra}`, type: 'button' }, label);
      c.addEventListener('pointerdown', (e) => e.stopPropagation());
      c.addEventListener('click', (e) => { e.stopPropagation(); toggle(); renderAll(); search.focus(); });
      chipEls.push([c, isOn]);
      chipRow.append(c);
    };
    addChip(t('node.fam.video'), () => view.kind === 'video', () => { view.kind = view.kind === 'video' ? null : 'video'; }, ' fp-kind');
    addChip(t('node.fam.image'), () => view.kind === 'image', () => { view.kind = view.kind === 'image' ? null : 'image'; }, ' fp-kind');
    chipRow.append(el('span', { class: 'fp-chip-sep', 'aria-hidden': 'true' }));
    for (const k of taskKeys) addChip(t(`node.fam.w.${k}`), () => view.task === k, () => { view.task = view.task === k ? null : k; });
    head.append(chipRow);

    const nav = el('div', { class: 'fp-nav', role: 'tablist' });
    const list = el('div', { class: 'fp-list', role: 'listbox' });
    const detail = el('div', { class: 'fp-detail' });
    const pop = el('div', { class: 'mp-pop fp' }, head, el('div', { class: 'fp-body' }, nav, list), detail);

    const matches = (f, q) => (!q || f.hay.includes(q)) && (!view.kind || f.kind === view.kind) && (!view.task || f.keys.includes(view.task));
    const isSel = (f) => current === f.fam || famKeyOf(current) === f.fam;

    function renderNav(q) {
      nav.replaceChildren();
      const favs = new Set(favList());
      const count = (pred) => fams.filter((f) => pred(f) && matches(f, q)).length;
      const items = [
        ['all', t('node.fam.all'), count(() => true), 'grid'],
        ['favs', t('node.fam.favs'), count((f) => favs.has(f.fam)), 'star'],
        ['local', t('node.fam.local'), count((f) => !f.cloud), 'gpu'],
        ['cloud', t('node.fam.cloud'), count((f) => f.cloud), 'globe'],
      ];
      for (const [id, label, n, ico] of items) {
        const b = el('button', { class: `fp-nav-it${view.scope === id ? ' on' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(view.scope === id) },
          el('span', { class: 'fp-nav-ico', html: icon(ico, 14) }), el('span', { class: 'fp-nav-lbl' }, label), el('span', { class: 'fp-nav-n' }, String(n)));
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => { e.stopPropagation(); view.scope = id; openView.scope = id; renderAll(); search.focus(); });
        nav.append(b);
      }
    }

    function row(f, { variant = null } = {}) {
      const v = variant ? variant.id : (f.installed ? f.fam : null);
      const sel = variant ? current === variant.id : (isSel(f) && !f.variants.some((m) => m.id === current));
      const fav = favList().includes(f.fam);
      const r = el('div', { class: `fp-row${sel ? ' sel' : ''}${!f.installed ? ' greyed' : ''}${variant ? ' fp-variant' : ''}`, role: 'option',
        'aria-selected': String(sel) });
      if (variant) {
        const vv = variantOf(variant);
        r.append(el('span', { class: 'fp-name' }, vv?.tag || modelName(variant)),
          el('span', { class: 'fp-meta' }, vv?.desc || ''),
          el('span', { class: 'fp-side' }, variant.sizeGB ? fmtGB(variant.sizeGB) : ''));
      } else {
        const side = el('span', { class: 'fp-side' });
        if (f.cloud) {
          side.dataset.fam = f.fam;
          side.dataset.tip = t('node.fam.priceTip');
          const p = fromPrice(f.fam);
          side.textContent = p != null ? t('node.fam.from', { price: money(p) }) : '';
        } else if (!f.installed) {
          const caps = (f.def.workflows || []).map((w) => w.cap).filter(Boolean);
          const inst = el('button', { class: 'fp-install', type: 'button', 'data-tip': t('node.fam.installTip') }, t('node.fam.install'));
          inst.addEventListener('pointerdown', (e) => e.stopPropagation());
          inst.addEventListener('click', (e) => { e.stopPropagation(); closePop(); emit('installer:open', { caps }); });
          side.append(el('span', { class: 'fp-note' }, t('node.fam.notInstalled')), inst);
        }
        const star = el('button', { class: `fp-star${fav ? ' on' : ''}`, type: 'button', html: icon(fav ? 'star-fill' : 'star', 14),
          'aria-label': t(fav ? 'node.fam.unfav' : 'node.fam.fav'), 'data-tip': t(fav ? 'node.fam.unfav' : 'node.fam.fav') });
        star.addEventListener('pointerdown', (e) => e.stopPropagation());
        star.addEventListener('click', (e) => { e.stopPropagation(); toggleFav(f.fam); });
        r.append(markEl(f.def),
          el('span', { class: 'fp-main' },
            el('span', { class: 'fp-line' }, el('span', { class: 'fp-name' }, f.def.name), el('span', { class: 'fp-maker' }, f.def.maker || '')),
            el('span', { class: 'fp-words' }, f.words.join(' · '))),
          side, star);
      }
      r.append(el('span', { class: 'fp-check', html: sel ? icon('check', 13) : '' }));
      r._fam = f;
      if (v) {
        r.dataset.value = v;
        r.addEventListener('click', (e) => { e.stopPropagation(); choose(v); });
      }
      r.addEventListener('pointerenter', () => { if (mouseMoved) showDetail(f, variant); });
      return r;
    }

    const group = (label, extra = null) => el('div', { class: 'fp-group' }, label, extra);
    function section(label, items, { banner = null, variants = false } = {}) {
      if (!items.length && !banner) return 0;
      list.append(group(label));
      if (banner) list.append(banner);
      for (const f of items) {
        list.append(row(f));
        // les variantes d'une famille du PC (LTX Standard / Rapide), sous elle (dans « Sur ce PC » seulement)
        if (variants) for (const m of f.variants) list.append(row(f, { variant: m }));
      }
      return items.length;
    }
    function cloudBanner() {
      const banner = el('div', { class: 'mp-cloudbar' });
      if (linked === false) {
        const btn = el('button', { class: 'mp-cloud-btn on', type: 'button' }, t('node.fam.cloudLinkBtn'));
        btn.addEventListener('pointerdown', (e) => e.stopPropagation());
        btn.addEventListener('click', (e) => { e.stopPropagation(); closePop(); emit('settings:open', { section: 'cloud' }); });
        banner.append(el('span', {}, t('node.fam.cloudLink')), btn);
        return banner;
      }
      return null;                              // relié : rien à dire de plus (le prix est sur chaque ligne)
    }

    function renderList(q) {
      list.replaceChildren();
      const shown = fams.filter((f) => matches(f, q));
      const favs = favList();
      const byFav = (f) => favs.includes(f.fam);
      const local = shown.filter((f) => !f.cloud);
      const cloudV = shown.filter((f) => f.cloud && f.kind === 'video');
      const cloudI = shown.filter((f) => f.cloud && f.kind === 'image');
      let n = 0;
      if (view.scope === 'favs') {
        const mine = favs.map((k) => shown.find((f) => f.fam === k)).filter(Boolean);
        n += section(t('node.fam.favs'), mine);
        if (!favs.length) list.append(el('div', { class: 'mp-empty' }, t('node.fam.favEmpty')));
      } else if (view.scope === 'local') {
        n += section(t('node.fam.local'), local, { variants: true });
      } else if (view.scope === 'cloud') {
        const b = cloudBanner();
        n += section(t('node.fam.videoOnline'), cloudV, { banner: b });
        n += section(t('node.fam.imageOnline'), cloudI);
      } else {
        // Tout : les favoris et les derniers choisis d'abord (sans recherche ni filtre), puis le PC, puis en ligne
        if (!q && !view.kind && !view.task) {
          section(t('node.fam.favs'), favs.map((k) => shown.find((f) => f.fam === k)).filter(Boolean));
          section(t('node.fam.recent'), recentList().filter((k) => !byFav({ fam: k }))
            .map((k) => shown.find((f) => f.fam === k)).filter(Boolean).slice(0, 4));
        }
        n += section(t('node.fam.local'), local, { variants: true });
        n += section(t('node.fam.videoOnline'), cloudV, { banner: cloudV.length ? cloudBanner() : null });
        n += section(t('node.fam.imageOnline'), cloudI);
      }
      if (!n && view.scope !== 'favs') {
        list.append(el('div', { class: 'mp-empty' }, q ? t('node.fam.noMatch', { q: search.value.trim() }) : t('node.fam.noFilter')));
      }
    }

    function renderAll({ keepScroll = false } = {}) {
      const q = fold(search.value.trim());
      const top = list.scrollTop;
      renderNav(q);
      for (const [c, isOn] of chipEls) c.classList.toggle('on', isOn());
      renderList(q);
      if (keepScroll) list.scrollTop = top;
      focus = -1;
      paintFocus(false);
      // les prix « dès » des familles en ligne montrées : demandés une fois, puis posés sur leur ligne
      const cloudShown = [...list.querySelectorAll('.fp-side[data-fam]')].map((s) => s.dataset.fam);
      if (cloudShown.length && linked !== false) askFromPrices(cloudShown).then((fresh) => { if (fresh && pop.isConnected) paintPrices(); });
    }
    function paintPrices() {
      for (const s of list.querySelectorAll('.fp-side[data-fam]')) {
        const p = fromPrice(s.dataset.fam);
        s.textContent = p != null ? t('node.fam.from', { price: money(p) }) : '';
      }
    }

    async function toggleFav(key) {
      const favs = favList();
      const next = favs.includes(key) ? favs.filter((k) => k !== key) : [...favs, key];
      await setPrefs({ favModels: next });
      if (pop.isConnected) renderAll({ keepScroll: true });
    }

    // la phrase entière : de la ligne survolée ou parcourue au clavier, sinon du modèle du bloc
    function showDetail(f, variant = null) {
      detail.replaceChildren();
      if (!f) { detail.append(el('div', { class: 'fp-keys' }, t('node.fam.keys'))); return; }
      const price = f.cloud ? fromPrice(f.fam) : undefined;
      const whereTxt = f.cloud ? [t('node.fam.cloud'), price != null ? t('node.fam.from', { price: money(price) }) : ''].filter(Boolean).join(' · ')
        : (f.installed ? t('node.fam.onPc') : t('node.fam.notInstalled'));
      const vv = variant ? variantOf(variant) : null;
      detail.append(markEl(f.def, 'lg'), el('div', { class: 'fp-d-main' },
        el('div', { class: 'fp-d-title' },
          el('span', { class: 'fp-d-name' }, vv ? `${f.def.name} · ${vv.tag || modelName(variant)}` : f.def.name),
          el('span', { class: 'fp-d-where' }, [f.def.maker, whereTxt].filter(Boolean).join(' · '))),
        el('div', { class: 'fp-d-desc' }, (vv && vv.desc) || tl(f.def.desc || {})),
        f.fam === 'fam:minimax' ? el('div', { class: 'fp-d-hint' }, t('node.fam.byWires')) : null,
        el('div', { class: 'fp-d-words' }, f.words.join(' · '))));
    }

    let focus = -1;
    const rows = () => [...list.querySelectorAll('.fp-row[data-value]')];
    function paintFocus(scroll = true) {
      const all = rows();
      if (focus < 0 || focus >= all.length) focus = Math.max(0, all.findIndex((r) => r.classList.contains('sel')));
      all.forEach((r, i) => r.classList.toggle('focus', i === focus));
      const r = all[focus];
      if (r && scroll) r.scrollIntoView({ block: 'nearest' });
      if (r) showDetail(r._fam, r.classList.contains('fp-variant') ? r._fam.variants.find((m) => m.id === r.dataset.value) : null);
      else showDetail(null);
    }
    // la souris ne prend la main qu'une fois bougée : le panneau ouvert sous un pointeur immobile garde le modèle du bloc
    let mouseMoved = false;
    pop.addEventListener('pointermove', () => { mouseMoved = true; }, { once: true });
    search.addEventListener('input', () => renderAll());
    search.addEventListener('keydown', (e) => {
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) return;
      e.stopPropagation();
    });

    renderAll();
    document.body.append(pop);
    place(pop, trigger);
    // le modèle du bloc, visible dès l'ouverture
    list.querySelector('.fp-row.sel')?.scrollIntoView({ block: 'center' });
    // le compte en ligne : demandé une fois, puis la liste se redessine (bandeau, prix)
    Promise.resolve(window.mia?.cloud?.status?.()).then((s) => {
      linked = !!(s && s.linked);
      if (openPop?.owner === root) renderAll({ keepScroll: true });
    }).catch(() => { linked = false; if (openPop?.owner === root) renderAll({ keepScroll: true }); });

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); trigger.focus(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        const n = rows().length;
        focus = (focus + (e.key === 'ArrowDown' ? 1 : -1) + n) % Math.max(n, 1);
        paintFocus();
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
    requestAnimationFrame(() => search.focus());
  }

  const offs = [on('models:updated', paint), on('profiles:ready', paint)];
  paint();
  root.setValue = (v) => { current = v ?? param.default ?? 'fam:ltx'; paint(); };
  root.refresh = paint;
  root.setDisabled = (b, why = '') => {
    disabled = !!b;
    disabledWhy = why || '';
    trigger.disabled = disabled;
    root.classList.toggle('disabled', disabled);
    if (disabled && openPop?.owner === root) closePop();
  };
  root.destroy = () => { if (openPop?.owner === root) closePop(); offs.forEach((f) => f()); };
  return root;
}

// où le panneau s'était arrêté (Tout, Favoris, Sur ce PC, En ligne) : il rouvre au même endroit pendant la session
const openView = { scope: 'all' };

function place(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.min(vw - 16, 720);
  pop.style.width = `${w}px`;
  pop.classList.toggle('narrow', w < 600);
  const h = pop.offsetHeight;
  const left = Math.min(Math.max(8, r.left), vw - w - 8);
  let top = r.bottom + 6;
  if (top + h > vh - 10 && r.top - h - 6 > 54) top = r.top - h - 6;
  top = Math.max(54, Math.min(top, vh - h - 10));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}
