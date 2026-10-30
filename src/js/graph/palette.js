// ── Palette « Ajouter un bloc » ───────────────────────────────────────
// Panneau centré (da.md §4.9, refait le 28/10 à la demande de Quentin) : la
// recherche et « Tout · Sur ce PC · En ligne » en haut ; à gauche Tout,
// Favoris et les catégories en langage simple ; au milieu une ligne courte
// par entrée (nom, et en mono le modèle qu'elle prendra et sa mémoire, ou
// « dès … $ » en ligne ; l'étoile des favoris) sous des titres qui disent ce
// qu'elle est (modèle du PC, modèle en ligne, tâche prête, recette) ; à
// droite, l'entrée parcourue en entier : sa phrase, quand la choisir (modèles
// en ligne), ce qu'elle prend et ce qu'elle donne. « Tout » commence par les
// favoris et les derniers blocs posés. Quand on lâche un fil dans le vide, la
// palette ne montre que ce qui peut s'y brancher, et le bloc posé arrive déjà
// relié. Favoris : prefs.favModels (modèles, partagés avec le choix du modèle)
// et prefs.favBlocks (blocs, recettes) ; récents : prefs.recentBlocks ; filtre
// retenu : prefs.palWhere.

import { t, tl, tn, register, lang } from '../i18n.js';
import { icon } from '../icons.js';
import { state } from '../state.js';
import { reduced, ghostOut } from '../ui/motion.js';
import {
  types, recipes, typeLabel, typeDesc, compatible, modelCaps,
  inputDefs, outputDefs, outRule, typeOf
} from '../catalog.js';
import { localCatalog, cloudCatalog } from '../nodes/profiles.js';
import { familyOf, localKeyOf, portsOfFamily, chooseWorkflow } from '../nodes/route.js';
import { mainPorts } from '../nodes/ports.js';
import { familyWords, makerColor } from '../nodes/familypicker.js';
import { fromText, askFromPrices } from '../ui/fromprices.js';
import { setPrefs } from '../ui/settings.js';
import { segmented } from '../ui/controls.js';

// Les onglets de « + Bloc », par ce qu'on fabrique (25/10) ; chaque bloc de tâche a le sien, un bloc nouveau suit sa
// catégorie du catalogue en attendant
const TABS = [
  { id: 'video', group: 'make' }, { id: 'image', group: 'make' }, { id: 'sound', group: 'make' },
  { id: 'files', group: 'start' }, { id: 'recipes', group: 'start' }, { id: 'notes', group: 'start' },
  { id: 'edit', group: 'rework' }, { id: 'finish', group: 'rework' },
];
const TAB_OF_TYPE = {
  import: 'files', text: 'files', note: 'notes',
  i2v: 'video', t2v: 'video', ref2v: 'video', real: 'video', guided: 'video', perform: 'video',
  edit: 'image', t2i: 'image', mask: 'image', sound: 'sound',
  trim: 'edit', sequence: 'edit', composite: 'edit', resize: 'edit', frame: 'edit', depth: 'edit', cutout: 'edit',
  finish: 'finish', looks: 'finish', upscale: 'finish', compare: 'finish', export: 'finish',
};
const TAB_OF_CATEGORY = { source: 'files', generate: 'video', analysis: 'edit', tools: 'edit', board: 'notes' };
const LEGACY_TAB = { models: 'video', cloud: 'video' };
const tabOfType = (ty) => TAB_OF_TYPE[ty.id] || TAB_OF_CATEGORY[ty.category] || 'edit';
// les mots d'un modèle tant qu'ils tiennent sur sa ligne (25 signes), puis « … » : jamais un mot coupé
const fitWords = (ws, max = 25) => {
  const out = [];
  let n = 0;
  for (const w of ws) {
    const add = (out.length ? 3 : 0) + w.length;
    if (out.length && n + add > max) return `${out.join(' · ')} …`;
    out.push(w);
    n += add;
  }
  return out.join(' · ');
};

register({
  fr: {
    'pal.search': 'Chercher un modèle, un bloc ou une recette…',
    'pal.searchShort': 'Chercher…',
    'pal.all': 'Tout',
    'pal.group.make': 'Fabriquer',
    'pal.group.start': 'Préparer',
    'pal.group.rework': 'Retravailler',
    'pal.tab.video': 'Vidéo',
    'pal.tab.image': 'Image',
    'pal.tab.sound': 'Son',
    'pal.tab.files': 'Médias et consignes',
    'pal.tab.recipes': 'Recettes',
    'pal.tab.notes': 'Notes',
    'pal.tab.edit': 'Montage',
    'pal.tab.finish': 'Finition',
    'pal.sec.pc': 'Modèles sur ce PC',
    'pal.sec.online': 'Modèles en ligne · payants',
    'pal.sec.blocks': 'Tâches prêtes',
    'pal.sec.tabPc': '{tab} · modèles sur ce PC',
    'pal.sec.tabOnline': '{tab} · modèles en ligne · payants',
    'pal.sec.tabBlocks': '{tab} · tâches prêtes',
    'pal.favs': 'Favoris',
    'pal.recent': 'Récents',
    'pal.favEmpty': 'Pas encore de favori : l’étoile au bout d’une ligne (ou Ctrl+D) en ajoute un.',
    'pal.fav': 'Ajouter aux favoris',
    'pal.unfav': 'Retirer des favoris',
    'pal.where.all': 'Tout',
    'pal.where.pc': 'Sur ce PC',
    'pal.where.online': 'En ligne',
    'pal.whereTip.all': 'Les modèles du PC et en ligne, les blocs et les recettes.',
    'pal.whereTip.pc': 'Ce qui calcule sur ce PC : ses modèles, les blocs et les recettes.',
    'pal.whereTip.online': 'Les modèles en ligne seulement (Higgsfield, payants).',
    'pal.emptyWhere': 'Rien ici avec « {where} ».',
    'pal.seeAll': 'Tout voir',
    'pal.d.pc': 'Sur ce PC',
    'pal.d.online': 'En ligne · payant',
    'pal.d.block': 'Bloc',
    'pal.d.recipe': 'Recette',
    'pal.d.takes': 'Ce qu’il prend',
    'pal.d.gives': 'Ce qu’il donne',
    'pal.d.blocks': 'Ses blocs',
    'pal.d.plug': 'Le fil ira sur',
    'pal.d.place': 'Poser',
    'pal.d.favKey': 'favori',
    'pal.d.altKey': 'favori direct',
    'pal.recipes': 'Recettes',
    'pal.models': 'Modèles',
    'pal.cloud': 'En ligne',
    'pal.online': 'En ligne',
    'pal.from': 'Se branche sur',
    'pal.priceFrom': 'dès {price}',
    'pal.priceTip': 'Le moins cher chez Higgsfield : plus petite définition, durée la plus courte. « ≈ » : tarif public (sans compte relié), le prix exact est connu au lancement.',
    'pal.empty': 'Aucun bloc ne correspond.',
    'pal.emptyFrom': 'Aucun bloc ne peut se brancher ici.',
    'pal.nav': 'choisir',
    'pal.enter': 'poser',
    'pal.esc': 'fermer',
    'pal.notInstalled': 'Non installé',
    'pal.incomplete': 'Incomplet',
    'pal.gb': '{n} Go',
    'pal.fit.light': 'Léger',
    'pal.fit.comfy': 'Confortable',
    'pal.fit.tight': 'Juste',
    'pal.fit.over': 'Déborde',
    'pal.memTip': '{name} · jusqu’à {n} Go de mémoire vidéo · {fit}',
    'pal.fitTip.light': 'léger pour cette carte graphique',
    'pal.fitTip.comfy': 'à l’aise sur cette carte graphique',
    'pal.fitTip.tight': 'juste pour cette carte graphique',
    'pal.fitTip.over': 'plus que la mémoire de cette carte graphique',
    'pal.modelTip': 'Modèle choisi par défaut : {name}',
    'pal.blocks.one': '{n} bloc',
    'pal.blocks.other': '{n} blocs',
    'pal.title': 'Ajouter un bloc',
    'pal.escKey': 'Échap'
  },
  en: {
    'pal.search': 'Search a model, a block or a recipe…',
    'pal.searchShort': 'Search…',
    'pal.all': 'All',
    'pal.group.make': 'Make',
    'pal.group.start': 'Prepare',
    'pal.group.rework': 'Rework',
    'pal.tab.video': 'Video',
    'pal.tab.image': 'Image',
    'pal.tab.sound': 'Sound',
    'pal.tab.files': 'Media and prompts',
    'pal.tab.recipes': 'Recipes',
    'pal.tab.notes': 'Notes',
    'pal.tab.edit': 'Editing',
    'pal.tab.finish': 'Finishing',
    'pal.sec.pc': 'Models on this PC',
    'pal.sec.online': 'Online models · paid',
    'pal.sec.blocks': 'Ready-made tasks',
    'pal.sec.tabPc': '{tab} · models on this PC',
    'pal.sec.tabOnline': '{tab} · online models · paid',
    'pal.sec.tabBlocks': '{tab} · ready-made tasks',
    'pal.favs': 'Favourites',
    'pal.recent': 'Recent',
    'pal.favEmpty': 'No favourite yet: the star at the end of a row (or Ctrl+D) adds one.',
    'pal.fav': 'Add to favourites',
    'pal.unfav': 'Remove from favourites',
    'pal.where.all': 'All',
    'pal.where.pc': 'On this PC',
    'pal.where.online': 'Online',
    'pal.whereTip.all': 'Models on this PC and online, blocks and recipes.',
    'pal.whereTip.pc': 'What runs on this PC: its models, the blocks and the recipes.',
    'pal.whereTip.online': 'Online models only (Higgsfield, paid).',
    'pal.emptyWhere': 'Nothing here with “{where}”.',
    'pal.seeAll': 'Show all',
    'pal.d.pc': 'On this PC',
    'pal.d.online': 'Online · paid',
    'pal.d.block': 'Block',
    'pal.d.recipe': 'Recipe',
    'pal.d.takes': 'What it takes',
    'pal.d.gives': 'What it gives',
    'pal.d.blocks': 'Its blocks',
    'pal.d.plug': 'The wire will go into',
    'pal.d.place': 'Place',
    'pal.d.favKey': 'favourite',
    'pal.d.altKey': 'favourite at once',
    'pal.recipes': 'Recipes',
    'pal.models': 'Models',
    'pal.cloud': 'Online',
    'pal.online': 'Online',
    'pal.from': 'Plugs into',
    'pal.priceFrom': 'from {price}',
    'pal.priceTip': 'The cheapest at Higgsfield: smallest resolution, shortest length. “≈”: public rate (no linked account); the exact price is known when it runs.',
    'pal.empty': 'No block matches.',
    'pal.emptyFrom': 'No block can plug in here.',
    'pal.nav': 'choose',
    'pal.enter': 'place',
    'pal.esc': 'close',
    'pal.notInstalled': 'Not installed',
    'pal.incomplete': 'Incomplete',
    'pal.gb': '{n} GB',
    'pal.fit.light': 'Light',
    'pal.fit.comfy': 'Comfortable',
    'pal.fit.tight': 'Tight',
    'pal.fit.over': 'Overflows',
    'pal.memTip': '{name} · up to {n} GB of video memory · {fit}',
    'pal.fitTip.light': 'light for this graphics card',
    'pal.fitTip.comfy': 'comfortable on this graphics card',
    'pal.fitTip.tight': 'tight for this graphics card',
    'pal.fitTip.over': 'more than this graphics card’s memory',
    'pal.modelTip': 'Model picked by default: {name}',
    'pal.blocks.one': '{n} block',
    'pal.blocks.other': '{n} blocks',
    'pal.title': 'Add a block',
    'pal.escKey': 'Esc'
  }
});

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function createPalette(ed) {
  const root = ed.paletteEl;
  root.classList.add('g-palette');
  root.hidden = true;
  let built = false;
  let input, cats, list, chip, foot, panel, hl, detail, whereSeg;
  let st = { at: null, from: null, cat: 'all', where: 'all', items: [], active: 0, prevFocus: null };
  let mouseArmed = false;

  function build() {
    built = true;
    root.innerHTML = `
      <div class="pal-catcher"></div>
      <div class="pal-panel" role="dialog" aria-label="${esc(t('pal.title'))}">
        <div class="pal-search">
          <span class="pal-search-ico">${icon('search', 16)}</span>
          <input class="pal-input" type="text" spellcheck="false" autocomplete="off" placeholder="${esc(t('pal.search'))}">
          <span class="pal-chip" hidden></span>
          <span class="pal-where"></span>
          <kbd class="pal-esc">Échap</kbd>
        </div>
        <div class="pal-body">
          <nav class="pal-cats"></nav>
          <div class="pal-list" role="listbox"></div>
          <div class="pal-detail"></div>
        </div>
        <div class="pal-foot"></div>
      </div>`;
    input = root.querySelector('.pal-input');
    panel = root.querySelector('.pal-panel');
    cats = root.querySelector('.pal-cats');
    list = root.querySelector('.pal-list');
    chip = root.querySelector('.pal-chip');
    foot = root.querySelector('.pal-foot');
    detail = root.querySelector('.pal-detail');
    root.querySelector('.pal-esc').textContent = t('pal.escKey');
    // où ça calcule : tout, ce PC (ses modèles, les blocs, les recettes) ou en ligne ; retenu d'une fois sur l'autre
    whereSeg = segmented({
      size: 'sm', value: 'all',
      options: ['all', 'pc', 'online'].map((v) => ({ value: v, label: t(`pal.where.${v}`), tip: t(`pal.whereTip.${v}`) })),
      onChange: (v) => setWhere(v),
    });
    root.querySelector('.pal-where').append(whereSeg);

    root.querySelector('.pal-catcher').addEventListener('pointerdown', (e) => { e.preventDefault(); close(); });
    root.addEventListener('contextmenu', (e) => { if (e.target !== input) e.preventDefault(); });
    input.addEventListener('input', () => {
      if (input.value.trim() && st.cat !== 'all') st.cat = 'all';
      render(true);
    });
    input.addEventListener('keydown', onKey);
    list.addEventListener('pointermove', (e) => {
      if (mouseArmed) return;
      // premier vrai mouvement : la ligne sous le pointeur s'allume (et le détail la suit)
      mouseArmed = true;
      const it = e.target.closest('.pal-item');
      if (it) setActive(+it.dataset.i, false);
    });
    list.addEventListener('pointerover', (e) => {
      const it = e.target.closest('.pal-item');
      if (!it || !mouseArmed) return;
      if (+it.dataset.i !== st.active || !it.classList.contains('on')) setActive(+it.dataset.i, false);
    });
    list.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="all"]')) { setWhere('all'); return; }
      const it = e.target.closest('.pal-item');
      if (!it) return;
      if (e.target.closest('.pal-star')) { toggleFav(st.items[+it.dataset.i]); return; }
      pick(st.items[+it.dataset.i]);
    });
    detail.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      const it = st.items[st.active];
      if (!b || !it) return;
      if (b.dataset.act === 'place') pick(it);
      else if (b.dataset.act === 'fav') toggleFav(it);
    });
    cats.addEventListener('click', (e) => {
      const b = e.target.closest('.pal-cat');
      if (!b) return;
      st.cat = b.dataset.cat;
      input.value = '';
      render(true);
      input.focus();
    });
  }

  function setWhere(v) {
    if (!['all', 'pc', 'online'].includes(v)) return;
    st.where = v;
    whereSeg.setValue(v);
    if (state.prefs?.palWhere !== v) setPrefs({ palWhere: v }).catch?.(() => {});
    render(true);
    input.focus();
  }

  // ── favoris et récents ──
  // Les modèles partagent leurs favoris avec le choix du modèle d'un bloc (prefs.favModels) ; blocs et recettes ont
  // les leurs (prefs.favBlocks). Les récents : les dernières entrées posées d'ici (prefs.recentBlocks).
  const listPref = (k) => (Array.isArray(state.prefs?.[k]) ? state.prefs[k] : []);
  const favKey = (e) => (e.kind === 'model' ? 'favModels' : 'favBlocks');
  const isFav = (e) => listPref(favKey(e)).includes(e.key);
  /** Les favoris parmi `all`, dans l'ordre : les modèles, puis les blocs et les recettes. */
  const favEntries = (all) => [...listPref('favModels'), ...listPref('favBlocks')]
    .map((k) => all.find((e) => e.key === k)).filter(Boolean);

  async function toggleFav(e) {
    if (!e) return;
    const k = favKey(e);
    const cur = listPref(k);
    await setPrefs({ [k]: cur.includes(e.key) ? cur.filter((x) => x !== e.key) : [...cur, e.key] });
    if (root.hidden) return;
    // la liste se redessine sans sauter : la ligne parcourue reste la même (la copie d'un favori en tête de « Tout »
    // ne la remplace pas) et reste sous le pointeur
    const key = st.items[st.active]?.key;
    const same = (items) => items.map((x, j) => (x.key === key ? j : -1)).filter((j) => j >= 0);
    const n0 = same(st.items).length;
    const occ = same(st.items.slice(0, st.active)).length;
    const row = list.querySelector('.pal-item.on');
    const seen = row ? row.offsetTop - list.scrollTop : 0;
    render(false);
    const idx = same(st.items);
    const at = idx.length > n0 ? occ + 1 : idx.length < n0 ? Math.max(0, occ - 1) : occ;
    if (!idx.length) return;
    setActive(idx[Math.min(at, idx.length - 1)], false, false);
    const now = list.querySelector('.pal-item.on');
    if (now) list.scrollTop = now.offsetTop - seen;
    placeHighlight(false);
  }

  function remember(item) {
    const patch = {};
    const rec = [item.key, ...listPref('recentBlocks').filter((k) => k !== item.key)].slice(0, 8);
    if (rec.join() !== listPref('recentBlocks').join()) patch.recentBlocks = rec;
    if (item.kind === 'model') {
      // un modèle posé d'ici compte aussi parmi les récents du choix du modèle
      const rm = [item.key, ...listPref('recentModels').filter((k) => k !== item.key)].slice(0, 5);
      if (rm.join() !== listPref('recentModels').join()) patch.recentModels = rm;
    }
    if (Object.keys(patch).length) setPrefs(patch).catch?.(() => {});
  }

  // ── ouverture ──

  /**
   * `at` = point du monde où le bloc sera posé ; `origin` = point écran (client) d'où la
   * palette s'ouvre (le bouton « + Bloc »). Le panneau naît de ce point (SPEC §20.1).
   */
  function open({ at = null, from = null, category = null, origin = null } = {}) {
    if (!ed.project || ed.readonly) return;
    if (!built) build();
    const where = ['all', 'pc', 'online'].includes(state.prefs?.palWhere) ? state.prefs.palWhere : 'all';
    st = { at, from, cat: LEGACY_TAB[category] || category || 'all', where, items: [], active: 0, prevFocus: document.activeElement };
    whereSeg.setValue(where);
    if (from) st.cat = 'all';
    input.value = '';
    input.placeholder = t(from ? 'pal.searchShort' : 'pal.search');
    mouseArmed = false;
    if (from) {
      chip.hidden = false;
      chip.innerHTML = `<i class="pal-dot" data-t="${esc(from.type || 'media')}"></i>${esc(t('pal.from'))} : ${esc(ed.kindLabel(from.type || 'media'))}`;
    } else chip.hidden = true;
    render(true);
    root.hidden = false;
    root.classList.remove('closing');
    growFrom(origin || (at ? ed.api.worldToScreen(at) : null));
    placeHighlight(false);
    requestAnimationFrame(() => input.focus());
  }

  /** Le panneau s'ouvre depuis le point du geste (clic, fil lâché, bouton) : origine de sa mise à l'échelle. */
  function growFrom(pt) {
    panel.classList.remove('pal-in');
    panel.style.transformOrigin = '';
    if (reduced()) return;
    if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
      const r = panel.getBoundingClientRect();
      // l'origine reste dans le voisinage du panneau : un point très loin ferait une glissade, pas une ouverture
      const ox = Math.max(-80, Math.min(r.width + 80, pt.x - r.left));
      const oy = Math.max(-80, Math.min(r.height + 80, pt.y - r.top));
      panel.style.transformOrigin = `${Math.round(ox)}px ${Math.round(oy)}px`;
    }
    void panel.offsetWidth;
    panel.classList.add('pal-in');
  }

  function close() {
    if (root.hidden) return;
    ghostOut(root);   // la palette s'efface à sa place (copie inerte, SPEC §20.1)
    root.hidden = true;
    const pf = st.prevFocus;
    st.prevFocus = null;
    if (pf && pf !== document.body && document.contains(pf) && pf.focus) {
      try { pf.focus({ preventScroll: true }); } catch { /* élément parti */ }
    }
  }

  // ── contenu ──

  /** Toutes les entrées possibles (recettes puis blocs), filtrées si un fil attend. */
  function entries() {
    const out = [];
    const from = st.from;
    // SPEC §23 : choisir d'abord un modèle — il pose un bloc Modèle réglé sur lui (le PC, puis en ligne)
    out.push(...modelEntries(from));
    if (!from) {
      for (const r of recipes()) {
        out.push({
          kind: 'recipe', id: r.id, key: `recipe:${r.id}`, cat: 'recipes', tab: 'recipes', where: 'block', icon: r.icon || 'recipe',
          name: tl(r.label), desc: tl(r.desc),
          meta: tn('pal.blocks', r.nodes.length, { n: r.nodes.length }), recipe: r
        });
      }
    }
    for (const ty of types()) {
      if (ty.ports === 'model') continue;          // le bloc Modèle se pose par son modèle (section Modèles)
      let link = null;
      if (from) {
        link = linkFor(ty, from);
        if (!link) continue;
      }
      const m = from ? { text: tl(link.def.label), cls: 'port' } : modelMeta(ty);
      out.push({
        kind: 'type', id: ty.id, key: ty.id, cat: ty.category, tab: tabOfType(ty), where: 'block', icon: ty.icon,
        name: typeLabel(ty), desc: typeDesc(ty), meta: m?.text || '', metaCls: m?.cls || '', metaTip: m?.tip || '', link
      });
    }
    for (const e of out) indexEntry(e);
    return out;
  }

  /**
   * Les mots que la recherche connaît pour une entrée, sans accents, en français ET
   * en anglais (on tape souvent « upscale » dans une Mia en français) : nom, mots-clés
   * du catalogue, phrase, id. La recherche ne compare que des débuts de mots :
   * « lut » trouve « LUT », jamais le milieu de « résolution ».
   */
  /** Les familles de modèles : celles du PC, puis en ligne, chacune dans l'onglet de ce qu'elle fait (Vidéo, Image…). */
  function modelEntries(from) {
    const out = [];
    const fams = localCatalog().families || {};
    const inv = state.inventory;
    const push = (value, def, cat, words, metaCls) => {
      // « TEXTE · ANIMER · FICHE · GUI… » était coupé : trois mots, la liste entière au survol
      const meta = fitWords(words);
      const metaTip = meta === words.join(' · ') ? '' : words.join(' · ');
      const fam = familyOf(value, localCatalog(), cloudCatalog(), inv);
      const link = from ? linkForFamily(fam, from) : null;
      if (from && !link) return;
      const desc = tl(def.desc || {});
      out.push({
        kind: 'model', id: value, key: value, value, cat, tab: def.kind === 'image' ? 'image' : def.kind === 'audio' ? 'sound' : 'video',
        where: cat === 'models' ? 'pc' : 'online', mark: def.mark || String(def.maker || def.name).slice(0, 2).toUpperCase(), hue: makerColor(def),
        name: def.name, desc, meta: from ? tl(link.def.label) : meta, metaCls: from ? 'port' : metaCls, metaTip: from ? '' : metaTip, link,
        words: from ? null : words, online: cat === 'cloud', def, fam, missing: metaCls === 'missing',
        // quand la choisir (cloud-strengths.json) : montré dans le détail, lu par la recherche (« 4k », « visages »)
        pick: def.strengths ? tl(def.strengths) : '',
        src: { label: { fr: def.name, en: def.name }, desc: def.desc, keywords: { fr: `${def.maker || ''} ${familyWords(def).join(' ')}`, en: def.maker || '' } },
      });
    };
    for (const [key, def] of Object.entries(fams)) {
      if (!Array.isArray(def.workflows) || !def.workflows.length) continue;
      const installed = (inv?.models || []).some((m) => m.status === 'ready' && !m.hidden && localKeyOf(m, fams) === key);
      push(`fam:${key}`, def, 'models', installed ? familyWords(def) : [t('pal.notInstalled')], installed ? '' : 'missing');
    }
    for (const def of cloudCatalog().families || []) {
      push(def.key, def, 'cloud', [t('pal.online'), ...familyWords(def)], 'online');
    }
    return out;
  }

  /** L'entrée (ou la sortie) d'un bloc Modèle de cette famille qui prendra le fil lâché. */
  function linkForFamily(fam, from) {
    if (!fam) return null;
    if (from.dir === 'out') {
      // l'entrée principale du modèle d'abord (MiniMax : Images de référence), puis une entrée qui sert seule (un son
      // sur MiniMax : « Son à suivre »), puis la première compatible (audit 25/10, UX-2 / WORKFLOWS-13)
      const ports = portsOfFamily(fam);
      const ok = inputDefs('gen').filter((p) => ports[p.id] && p.type !== 'text' && compatible(from.type, p.type));
      const main = mainPorts(fam);
      const alone = (p) => { const r = chooseWorkflow(fam, [p.id], null); return r && !r.blocked && !r.unused.includes(p.id); };
      const def = ok.find((p) => main.includes(p.id)) || ok.find(alone) || ok[0];
      return def ? { def, dir: 'in' } : null;
    }
    const kind = fam.def.kind || 'video';
    return compatible(kind, from.type) ? { def: { ...outputDefs('gen')[0], type: kind }, dir: 'out' } : null;
  }

  function indexEntry(e) {
    const src = e.kind === 'recipe' ? e.recipe : e.kind === 'model' ? e.src : typeOf(e.id);
    const both = (v) => (v && typeof v === 'object' ? [v.fr, v.en] : [v]).filter(Boolean).join(' ');
    e.wName = words(e.name);
    e.wOther = words(both(src?.label));
    // le modèle qui fait tourner un bloc (« LTX 2.5 ») se cherche aussi : « ltx » trouve Animer une image… (LIVE-11)
    e.wKeys = words(`${both(src?.keywords)} ${typeof e.meta === 'string' ? e.meta : ''}`);
    e.wDesc = words(`${both(src?.desc)} ${e.desc} ${e.pick || ''}`);
    e.wId = words(e.id);
    const lab = src?.label;
    e.whole = [e.name, ...(lab && typeof lab === 'object' ? [lab.fr, lab.en] : [])].map((s) => words(s).join(' '));
  }
  const words = (s) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);
  const starts = (list, w) => list.some((x) => x.startsWith(w));

  /** Le port du nouveau bloc qui recevra le fil (ou d'où il partira). */
  function linkFor(ty, from) {
    if (from.dir === 'out') {
      const def = inputDefs(ty.id).find((p) => compatible(from.type, p.type));
      return def ? { def, dir: 'in' } : null;
    }
    // on remonte depuis une entrée : il faut une sortie qui pourra s'y brancher
    const want = from.type;
    const def = outputDefs(ty.id).find((p) => {
      const r = outRule(p.type);
      if (r.fixed) return compatible(r.fixed, want);
      if (r.data) return want === 'image' || want === 'video' || want === 'media' || want === 'audio';
      return want === 'media';             // `follow:` reste inconnu tant que rien n'y est branché
    });
    return def ? { def, dir: 'out' } : null;
  }

  /**
   * « LTX 2.5 · 21 Go » : le modèle « Auto » de ce bloc sur ce PC, en mots (jamais
   * d'initiales), et sa mémoire en Go (da.md §4.9). Un mot seulement s'il déborde de
   * la carte graphique (« Déborde », en avertissement) ; léger / à l'aise / juste sont
   * dans l'infobulle (« JUSTE » seul, en majuscules, se lisait « correct »).
   */
  function modelMeta(ty) {
    const caps = modelCaps(ty.id);
    const inv = state.inventory;
    if (!caps.length || !inv?.capabilities) return null;
    const cap = inv.capabilities[caps[0]];
    if (!cap?.available) {
      // installé mais incomplet n'est pas « non installé »
      const partial = (inv.models || []).some((m) => m.status === 'incomplete' && (m.caps || []).includes(caps[0]));
      return { text: t(partial ? 'pal.incomplete' : 'pal.notInstalled'), cls: 'missing' };
    }
    const m = (inv.models || []).find((x) => x.id === cap.default);
    if (!m) return null;
    const full = tl(m.label || {}) || m.family || '';
    const fit = fitOf(m, inv);
    const tip = m.vramGB
      ? t('pal.memTip', { name: full, n: fmtNum(m.vramGB), fit: fit ? t(`pal.fitTip.${fit}`) : '' }).replace(/ · $/, '')
      : t('pal.modelTip', { name: full });
    const parts = [shortName(full.split(' · ')[0] || m.family || '')];
    if (Number(m.vramGB) > 0) parts.push(t('pal.gb', { n: fmtNum(m.vramGB) }));
    if (fit === 'over') parts.push(t('pal.fit.over'));
    return { text: parts.filter(Boolean).join(' · '), cls: fit === 'over' ? 'over' : '', tip };
  }

  /**
   * « Video Depth Anything » → « Video Depth », « Qwen Image Edit » → « Qwen
   * Image » : des mots entiers tant que ça tient (12 signes), jamais d'initiales.
   */
  function shortName(s) {
    const words = String(s).trim().split(/\s+/).filter(Boolean);
    let out = words.shift() || '';
    for (const w of words) {
      if ((out + ' ' + w).length > 12) break;
      out += ' ' + w;
    }
    return out;
  }

  // Mêmes seuils que la pastille Mémoire de la bibliothèque (models.md §6.2).
  function fitOf(m, inv) {
    const v = Number(m.vramGB);
    if (!isFinite(v) || v <= 0 || m.hidden || m.role === 'lora') return null;
    const g = inv?.machine?.vramGB ?? state.engine?.gpu?.vramTotalGB;
    const card = g ? Math.round((g * 1e9) / 2 ** 30) : 24;
    if (v < 8) return 'light';
    if (v < 16) return 'comfy';
    if (v <= card - 1) return 'tight';
    return 'over';
  }

  function fmtNum(v) {
    const n = Math.round(v * 10) / 10;
    return lang?.() === 'en' ? String(n) : String(n).replace('.', ',');
  }

  /** Chaque mot tapé doit commencer un mot de l'entrée ; le nom compte plus que les mots-clés, eux plus que la phrase. */
  function score(e, qWords) {
    let s = 0;
    for (const w of qWords) {
      if (e.wName[0]?.startsWith(w)) s += 8;
      else if (starts(e.wName, w)) s += 6;
      else if (e.wKeys.includes(w)) s += 5;
      else if (starts(e.wOther, w)) s += 4.5;
      else if (starts(e.wKeys, w)) s += 4;
      else if (starts(e.wDesc, w)) s += 2;
      else if (starts(e.wId, w)) s += 1;
      else return -1;
    }
    // le nom tapé en entier (« profondeur », « depth ») : le bloc passe devant la recette qui le contient
    if (e.whole.includes(qWords.join(' '))) s += 3;
    // à égalité ou presque, les favoris puis les derniers posés passent devant (comme le menu Tab de Nuke)
    if (isFav(e)) s += 2;
    else if (listPref('recentBlocks').includes(e.key)) s += 1;
    return s + (e.kind === 'recipe' ? 0.5 : 0);
  }

  // « Sur ce PC » : ses modèles, les blocs et les recettes (tout calcule ici) ; « En ligne » : les modèles en ligne
  const inWhere = (e) => st.where === 'all' || (st.where === 'online' ? e.where === 'online' : e.where !== 'online');

  function render(resetActive) {
    const q = fold(input.value.trim());
    const every = entries();
    const all = every.filter(inWhere);
    const has = (tab) => all.some((e) => e.tab === tab);
    const favs = favEntries(all);
    if (st.cat === 'favs' ? !favs.length && !listPref('favModels').length && !listPref('favBlocks').length
      : st.cat !== 'all' && !has(st.cat)) st.cat = 'all';

    // colonne : Tout, Favoris, puis Fabriquer (Vidéo, Image, Son), Préparer, Retravailler — les onglets vides sont tus
    const catBtn = (id, label, n = null, ico = '') => `<button type="button" class="pal-cat${st.cat === id ? ' on' : ''}" data-cat="${esc(id)}">`
      + (ico ? `<span class="pal-cat-ico">${icon(ico, 13)}</span>` : '')
      + `<span class="pal-cat-lbl">${esc(label)}</span>${n != null ? `<span class="pal-cat-n">${n}</span>` : ''}</button>`;
    let nav = catBtn('all', t('pal.all'));
    if (favs.length || st.cat === 'favs') nav += catBtn('favs', t('pal.favs'), favs.length, 'star');
    for (const g of ['make', 'start', 'rework']) {
      const tabs = TABS.filter((x) => x.group === g && has(x.id));
      if (tabs.length) nav += `<div class="pal-catgroup">${esc(t(`pal.group.${g}`))}</div>` + tabs.map((x) => catBtn(x.id, t(`pal.tab.${x.id}`))).join('');
    }
    cats.innerHTML = nav;
    // un onglet : ses modèles du PC, ceux en ligne, puis ses blocs (et recettes)
    const parts = (tab, online = true) => [
      all.filter((e) => e.tab === tab && e.where === 'pc'),
      online ? all.filter((e) => e.tab === tab && e.where === 'online') : [],
      all.filter((e) => e.tab === tab && e.where === 'block'),
    ];
    // les titres disent ce que sont les entrées : modèles du PC, modèles en ligne, tâches prêtes (un seul genre : le
    // nom de l'onglet suffit) ; dans « Tout », précédés de l'onglet (« Vidéo · tâches prêtes »)
    const titled = (tab, [pc, web, blocks], prefix) => {
      const name = t(`pal.tab.${tab}`);
      const secs = [
        { title: prefix ? t('pal.sec.tabPc', { tab: name }) : t('pal.sec.pc'), items: pc },
        { title: prefix ? t('pal.sec.tabOnline', { tab: name }) : t('pal.sec.online'), items: web },
        { title: prefix ? t('pal.sec.tabBlocks', { tab: name }) : t('pal.sec.blocks'), items: blocks },
      ];
      // des blocs seuls (Montage, Recettes…) : le nom de l'onglet ; des modèles seuls gardent « sur ce PC » / « en ligne »
      if (!pc.length && !web.length) return [{ title: name, items: blocks }];
      return secs;
    };

    // liste
    let sections;
    if (q) {
      const qWords = words(q);
      const hits = qWords.length
        ? all.map((e) => ({ e, s: score(e, qWords) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s)
        : [];
      sections = [{ title: null, items: hits.map((x) => x.e) }];
    } else if (st.cat === 'favs') {
      sections = [{ title: t('pal.favs'), items: favs }];
    } else if (st.cat === 'all') {
      // d'abord les favoris et les derniers posés, puis un onglet après l'autre ; les modèles en ligne (nombreux) restent
      // dans leur onglet et la recherche, sauf avec « En ligne » ou quand un fil attend (il faut alors tout ce qui
      // peut le prendre)
      const recent = listPref('recentBlocks').map((k) => all.find((e) => e.key === k)).filter((e) => e && !favs.includes(e)).slice(0, 5);
      const online = !!st.from || st.where === 'online';
      sections = [{ title: t('pal.favs'), items: favs }, { title: t('pal.recent'), items: recent },
        ...TABS.flatMap((x) => titled(x.id, parts(x.id, online), true))];
    } else {
      sections = titled(st.cat, parts(st.cat), false);
    }

    // sous le titre « en ligne », « En ligne · » devant chaque modèle ne dit plus rien
    const metaOf = (e) => (e.words && e.online && !q ? fitWords(e.words.filter((w) => w !== t('pal.online'))) : e.meta);
    st.items = [];
    let html = '';
    for (const s of sections) {
      if (!s.items.length) continue;
      const onlineSec = !q && s.items.every((e) => e.online);
      if (s.title) html += `<div class="pal-sec">${esc(s.title)}</div>`;
      for (const e of s.items) {
        const i = st.items.length;
        st.items.push(e);
        const fav = isFav(e);
        // une ligne : le nom, et à droite en mono ce qu'il prendra (modèle, mémoire) ou le port qui recevra le fil,
        // « dès … $ » en ligne, l'étoile ; la phrase entière est dans le détail à droite
        const meta = onlineSec ? metaOf(e) : e.meta;
        html += `<button type="button" class="pal-item${e.kind === 'recipe' ? ' recipe' : ''}${e.missing ? ' missing' : ''}" data-i="${i}" role="option">`
          + (e.kind === 'model' ? `<span class="pal-glyph pal-mark"${e.hue ? ` style="--mk:${esc(e.hue)}"` : ''}>${esc(e.mark)}</span>`
            : `<span class="pal-glyph">${icon(e.icon, 16) || icon('g-unknown', 16)}</span>`)
          + `<span class="pal-name">${esc(e.name)}</span>`
          + (meta ? `<span class="pal-meta ${e.metaCls || ''}"${e.metaTip ? ` data-tip="${esc(e.metaTip)}"` : ''}>${esc(meta)}</span>` : '<span class="pal-meta"></span>')
          + (e.online && e.kind === 'model' ? `<span class="pal-price" data-fam="${esc(e.value)}" data-tip="${esc(t('pal.priceTip'))}"></span>` : '')
          + `<span class="pal-star${fav ? ' on' : ''}" role="button" aria-label="${esc(t(fav ? 'pal.unfav' : 'pal.fav'))}"`
          + ` data-tip="${esc(t(fav ? 'pal.unfav' : 'pal.fav'))}">${icon(fav ? 'star-fill' : 'star', 14)}</span>`
          + '</button>';
      }
    }
    if (!st.items.length) {
      if (st.cat === 'favs') html = `<div class="pal-empty">${esc(t('pal.favEmpty'))}</div>`;
      else if (st.where !== 'all' && every.length) {
        // un filtre qui ne laisse rien : le dire, et un bouton pour tout revoir
        html = `<div class="pal-empty">${esc(t('pal.emptyWhere', { where: t(`pal.where.${st.where}`) }))}`
          + `<button type="button" class="btn xs pal-seeall" data-act="all">${esc(t('pal.seeAll'))}</button></div>`;
      } else html = `<div class="pal-empty">${esc(st.from ? t('pal.emptyFrom') : t('pal.empty'))}</div>`;
    }
    list.innerHTML = html;
    fillPrices();
    // la surbrillance glisse d'une ligne à l'autre : un seul élément, déplacé par transform
    hl = document.createElement('div');
    hl.className = 'pal-hl';
    hl.hidden = !st.items.length;
    list.prepend(hl);
    if (resetActive) { st.active = 0; list.scrollTop = 0; }
    setActive(Math.min(st.active, st.items.length - 1), true, false);
    paintFoot(favs.length);
  }

  function paintFoot(nFavs) {
    foot.innerHTML = `<span><kbd>↑</kbd><kbd>↓</kbd> ${esc(t('pal.nav'))}</span>`
      + `<span><kbd>↵</kbd> ${esc(t('pal.enter'))}</span>`
      + `<span><kbd>Ctrl D</kbd> ${esc(t('pal.d.favKey'))}</span>`
      + (nFavs ? `<span><kbd>Alt ${nFavs > 1 ? `1…${Math.min(9, nFavs)}` : '1'}</kbd> ${esc(t('pal.d.altKey'))}</span>` : '')
      + `<span><kbd>${esc(t('pal.escKey'))}</kbd> ${esc(t('pal.esc'))}</span>`;
  }

  // « dès … $ » des modèles en ligne : demandés une fois à Higgsfield (le processus principal les garde un jour) ;
  // rien sans compte relié
  function fillPrices() {
    const spans = [...list.querySelectorAll('.pal-price[data-fam]')];
    if (!spans.length) return;
    const paint = () => {
      for (const s of spans) {
        const v = fromText(s.dataset.fam);
        s.textContent = v != null ? t('pal.priceFrom', { price: v }) : '';
      }
    };
    paint();
    askFromPrices(spans.map((s) => s.dataset.fam)).then((fresh) => {
      if (!fresh || !spans[0].isConnected) return;
      paint();
      if (st.items[st.active]?.online) showDetail(st.items[st.active]);     // le prix arrive aussi dans le détail
    });
  }

  // ── le détail de l'entrée parcourue (à droite) ──
  // Ce qu'une ligne courte ne dit pas : la phrase entière, quand choisir un modèle en ligne (cloud-strengths.json), ce
  // qu'il prend et ce qu'il donne (pastilles de la couleur des ports), les blocs d'une recette, le port qui recevra le
  // fil. Il suit la ligne survolée ou parcourue au clavier.
  const chipHtml = (type, label, n = 0) => `<span class="pal-d-chip"><i class="pal-dot" data-t="${esc(type || 'media')}"></i>`
    + `${esc(label)}${n > 1 ? ` <b>×${n}</b>` : ''}</span>`;
  function showDetail(e) {
    if (!detail) return;
    if (!e) { detail.innerHTML = ''; return; }
    const fav = isFav(e);
    let where = [], takes = [], gives = [], blocks = [];
    if (e.kind === 'model') {
      const price = e.online ? fromText(e.value) : null;
      where = e.online ? [e.def.maker, t('pal.d.online'), price != null ? t('pal.priceFrom', { price }) : '']
        : [e.def.maker, e.missing ? t('pal.notInstalled') : t('pal.d.pc')];
      const ports = portsOfFamily(e.fam);
      takes = inputDefs('gen').filter((p) => ports[p.id]).map((p) => [p.type, tl(p.label), ports[p.id].multi ? ports[p.id].max : 0]);
      const kind = e.def.kind || 'video';
      gives = [[kind, ed.kindLabel(kind)]];
    } else if (e.kind === 'recipe') {
      where = [t('pal.d.recipe'), e.meta];
      const n = new Map();
      for (const nd of e.recipe.nodes || []) {
        const ty = typeOf(nd.type);
        const l = ty ? typeLabel(ty) : nd.type;
        n.set(l, (n.get(l) || 0) + 1);
      }
      blocks = [...n];
    } else {
      where = [t('pal.d.block'), st.from ? '' : e.meta];
      takes = inputDefs(e.id).map((p) => [p.type, tl(p.label) || ed.kindLabel(p.type), p.multi ? p.max || 0 : 0]);
      gives = outputDefs(e.id).map((p) => { const k = outRule(p.type).fixed || 'media'; return [k, tl(p.label) || ed.kindLabel(k)]; });
    }
    const glyph = e.kind === 'model'
      ? `<span class="pal-glyph pal-mark lg"${e.hue ? ` style="--mk:${esc(e.hue)}"` : ''}>${esc(e.mark)}</span>`
      : `<span class="pal-glyph lg">${icon(e.icon, 18) || icon('g-unknown', 18)}</span>`;
    const sec = (label, body) => (body ? `<div class="pal-d-sec"><div class="pal-d-label">${esc(label)}</div>${body}</div>` : '');
    const chips = (l) => (l.length ? `<div class="pal-d-chips">${l.join('')}</div>` : '');
    // le contenu défile seul ; « Poser » et l'étoile restent dessous, toujours visibles
    detail.innerHTML = '<div class="pal-d-body">'
      + `<div class="pal-d-head">${glyph}<div class="pal-d-title"><div class="pal-d-name">${esc(e.name)}</div>`
      + `<div class="pal-d-where">${esc(where.filter(Boolean).join(' · '))}</div></div></div>`
      + (e.desc ? `<div class="pal-d-desc">${esc(e.desc)}</div>` : '')
      // la phrase dit elle-même « À choisir pour… » : pas de titre au-dessus
      + (e.pick ? `<div class="pal-d-pick">${esc(e.pick)}</div>` : '')
      + (st.from && e.link ? sec(t('pal.d.plug'), chips([chipHtml(st.from.type, tl(e.link.def.label))])) : '')
      + sec(t('pal.d.takes'), chips(takes.map(([ty, l, n]) => chipHtml(ty, l, n))))
      + sec(t('pal.d.gives'), chips(gives.map(([ty, l]) => chipHtml(ty, l))))
      + sec(t('pal.d.blocks'), chips(blocks.map(([l, n]) => `<span class="pal-d-chip">${esc(l)}${n > 1 ? ` <b>×${n}</b>` : ''}</span>`)))
      + '</div>'
      + `<div class="pal-d-acts"><button type="button" class="btn xs btn-primary" data-act="place">${esc(t('pal.d.place'))}</button>`
      + `<button type="button" class="btn xs btn-ghost pal-d-fav${fav ? ' on' : ''}" data-act="fav">${icon(fav ? 'star-fill' : 'star', 13)}`
      + `<span>${esc(t(fav ? 'pal.unfav' : 'pal.fav'))}</span></button></div>`;
  }

  function setActive(i, scroll, glide = true) {
    st.active = Math.max(0, i);
    const prev = list.querySelector('.pal-item.on');
    const next = list.querySelector(`.pal-item[data-i="${st.active}"]`);
    if (prev && prev !== next) prev.classList.remove('on');
    if (next) {
      next.classList.add('on');
      if (scroll) next.scrollIntoView({ block: 'nearest' });
    }
    placeHighlight(glide);
    showDetail(st.items[st.active]);
  }

  /** La pastille de la ligne active : sa hauteur suit la ligne, sa place glisse (120 ms). */
  function placeHighlight(glide) {
    if (!hl || root.hidden) return;
    const it = list.querySelector('.pal-item.on');
    if (!it) { hl.hidden = true; return; }
    hl.hidden = false;
    hl.classList.toggle('still', !glide);
    hl.style.height = `${it.offsetHeight}px`;
    hl.style.transform = `translateY(${it.offsetTop}px)`;
    if (!glide) { void hl.offsetWidth; hl.classList.remove('still'); }
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return close(); }
    // Ctrl+D : l'entrée parcourue entre ou sort des favoris ; Alt+1…9 : pose le favori n (par la place de la touche,
    // pour les claviers AZERTY où le chiffre demande Maj ; AltGr = Ctrl+Alt n'y compte pas)
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyD') {
      e.preventDefault(); e.stopPropagation();
      toggleFav(st.items[st.active]);
      return;
    }
    const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code || '');
    if (e.altKey && !e.ctrlKey && !e.metaKey && digit) {
      e.preventDefault(); e.stopPropagation();
      const f = favEntries(entries().filter(inWhere))[+digit[1] - 1];
      if (f) pick(f);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!st.items.length) return;
      const d = e.key === 'ArrowDown' ? 1 : -1;
      mouseArmed = false;
      setActive((st.active + d + st.items.length) % st.items.length, true);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const it = st.items[st.active];
      if (it) pick(it);
      return;
    }
    if (e.key === 'Tab') {
      // Tab fait défiler les catégories (le focus reste dans le champ)
      e.preventDefault();
      const ids = [...cats.querySelectorAll('.pal-cat')].map((b) => b.dataset.cat);
      const i = ids.indexOf(st.cat);
      st.cat = ids[(i + (e.shiftKey ? -1 : 1) + ids.length) % ids.length];
      input.value = '';
      render(true);
    }
    e.stopPropagation();
  }

  // ── poser ──

  function pick(item) {
    if (!item) return;
    const { at, from } = st;
    remember(item);
    close();
    if (item.kind === 'recipe') { ed.insertRecipe(item.recipe, at); return; }
    const typeId = item.kind === 'model' ? 'gen' : item.id;      // un modèle pose un bloc Modèle réglé sur lui
    const ty = typeOf(typeId);
    const w = ty?.width || 288;
    let pos = null;
    if (at) {
      // le bloc arrive centré sous le pointeur ; après un fil, son port tombe au point de lâcher
      if (from?.dir === 'out') pos = { x: at.x + 12, y: at.y - 56 };
      else if (from?.dir === 'in') pos = { x: at.x - w - 12, y: at.y - 56 };
      // Tab au pointeur : la place libre la plus proche, jamais sur un autre bloc
      else pos = { x: at.x - w / 2, y: at.y - 18, free: true };
    } else {
      // « + Bloc » du dock avec un bloc sélectionné : le nouveau se pose à sa droite, les fils vont de gauche à droite
      const sel = ed.api.selection();
      if (sel.length === 1) pos = { near: sel[0] };
    }
    const data = {};
    if (from?.dir === 'in' && ty.id === 'import') {
      // un Média créé depuis une entrée sait déjà ce qu'il attend (« Image de début »)
      const inDef = inputDefs(ed.doc.node(from.node)?.type).find((p) => p.id === from.port);
      data.placeholder = { kind: from.type || 'media', ...(inDef?.label || {}) };
    }
    ed.history.begin('add');
    try {
      // le bloc naît du point de pose (double-clic, fil lâché) : origine de son arrivée
      const id = ed.addNode(typeId, pos, { data, origin: at, ...(item.kind === 'model' ? { params: { model: item.value } } : {}) });
      if (id && from && item.link) {
        // le port du nouveau bloc tombe exactement là où le fil a été lâché
        if (at) {
          ed.placePortAt(id, item.link.def.id, item.link.dir, at);
          // fil lâché tout contre un bloc : le nouveau s'écarte plutôt que de le recouvrir
          const box = ed.nodeBox(id);
          const p = box && ed.findFree(box, { prefer: from.dir === 'out' ? 'right' : 'any', exclude: new Set([id]) });
          if (p && (p.x !== box.x || p.y !== box.y)) ed.relocate(id, p.x, p.y);
        }
        if (from.dir === 'out') ed.connect(from.node, from.port, id, item.link.def.id, { quiet: false });
        else ed.connect(id, item.link.def.id, from.node, from.port, { quiet: false });
      }
    } finally { ed.history.commit(); }
  }

  return {
    open,
    close,
    get isOpen() { return !root.hidden; }
  };
}
