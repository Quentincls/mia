// ── Palette « Ajouter un bloc » ───────────────────────────────────────
// Panneau centré de 560 px (da.md §4.9) : un champ de recherche, les
// catégories en langage simple à gauche, les recettes en tête de liste. Chaque
// entrée dit ce que fait le bloc (la phrase entière, sur 2 lignes au plus) et,
// sur la ligne du nom en mono, le modèle qu'il prendra par défaut et sa
// mémoire. Quand on lâche un fil dans le vide, la palette ne
// montre que ce qui peut s'y brancher, et le bloc posé arrive déjà relié.

import { t, tl, tn, register, lang } from '../i18n.js';
import { icon } from '../icons.js';
import { state } from '../state.js';
import { reduced } from '../ui/motion.js';
import {
  types, categories, recipes, typeLabel, typeDesc, compatible, modelCaps,
  inputDefs, outputDefs, outRule, typeOf
} from '../catalog.js';
import { localCatalog, cloudCatalog } from '../nodes/profiles.js';
import { familyOf, localKeyOf, portsOfFamily } from '../nodes/route.js';
import { familyWords } from '../nodes/familypicker.js';

register({
  fr: {
    'pal.search': 'Chercher un modèle, un bloc ou une recette…',
    'pal.all': 'Tout',
    'pal.recipes': 'Recettes',
    'pal.models': 'Modèles',
    'pal.cloud': 'En ligne',
    'pal.online': 'En ligne',
    'pal.from': 'Se branche sur',
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
    'pal.all': 'All',
    'pal.recipes': 'Recipes',
    'pal.models': 'Models',
    'pal.cloud': 'Online',
    'pal.online': 'Online',
    'pal.from': 'Plugs into',
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
  let input, cats, list, chip, foot, panel, hl;
  let st = { at: null, from: null, cat: 'all', items: [], active: 0, prevFocus: null };
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
          <kbd class="pal-esc">Échap</kbd>
        </div>
        <div class="pal-body">
          <nav class="pal-cats"></nav>
          <div class="pal-list" role="listbox"></div>
        </div>
        <div class="pal-foot"></div>
      </div>`;
    input = root.querySelector('.pal-input');
    panel = root.querySelector('.pal-panel');
    cats = root.querySelector('.pal-cats');
    list = root.querySelector('.pal-list');
    chip = root.querySelector('.pal-chip');
    foot = root.querySelector('.pal-foot');
    root.querySelector('.pal-esc').textContent = t('pal.escKey');
    foot.innerHTML = `<span><kbd>↑</kbd><kbd>↓</kbd> ${esc(t('pal.nav'))}</span>`
      + `<span><kbd>↵</kbd> ${esc(t('pal.enter'))}</span>`
      + `<span><kbd>${esc(t('pal.escKey'))}</kbd> ${esc(t('pal.esc'))}</span>`;

    root.querySelector('.pal-catcher').addEventListener('pointerdown', (e) => { e.preventDefault(); close(); });
    root.addEventListener('contextmenu', (e) => { if (e.target !== input) e.preventDefault(); });
    input.addEventListener('input', () => {
      if (input.value.trim() && st.cat !== 'all') st.cat = 'all';
      render(true);
    });
    input.addEventListener('keydown', onKey);
    list.addEventListener('pointermove', (e) => {
      if (mouseArmed) return;
      // premier vrai mouvement : la ligne sous le pointeur s'allume et peut montrer sa phrase
      mouseArmed = true;
      const it = e.target.closest('.pal-item');
      if (it) { setActive(+it.dataset.i, false); scheduleSide(it); }
    });
    list.addEventListener('pointerover', (e) => {
      const it = e.target.closest('.pal-item');
      if (!it || !mouseArmed) return;
      if (+it.dataset.i !== st.active || !it.classList.contains('on')) setActive(+it.dataset.i, false);
      if (e.relatedTarget && it.contains(e.relatedTarget)) return;   // on bouge dans la même ligne
      scheduleSide(it);
    });
    list.addEventListener('pointerleave', hideSide);
    list.addEventListener('scroll', hideSide, { passive: true });
    list.addEventListener('click', (e) => {
      const it = e.target.closest('.pal-item');
      if (it) pick(st.items[+it.dataset.i]);
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

  // ── ouverture ──

  /**
   * `at` = point du monde où le bloc sera posé ; `origin` = point écran (client) d'où la
   * palette s'ouvre (le bouton « + Bloc »). Le panneau naît de ce point (SPEC §20.1).
   */
  function open({ at = null, from = null, category = null, origin = null } = {}) {
    if (!ed.project || ed.readonly) return;
    if (!built) build();
    st = { at, from, cat: category || 'all', items: [], active: 0, prevFocus: document.activeElement };
    if (from) st.cat = 'all';
    input.value = '';
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
    hideSide();
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
          kind: 'recipe', id: r.id, cat: 'recipes', icon: r.icon || 'recipe',
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
        kind: 'type', id: ty.id, cat: ty.category, icon: ty.icon,
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
  /** Les familles de modèles : celles du PC (catégorie « Modèles »), puis en ligne (« En ligne »). */
  function modelEntries(from) {
    const out = [];
    const fams = localCatalog().families || {};
    const inv = state.inventory;
    const push = (value, def, cat, meta, metaCls) => {
      const fam = familyOf(value, localCatalog(), cloudCatalog(), inv);
      const link = from ? linkForFamily(fam, from) : null;
      if (from && !link) return;
      const desc = tl(def.desc || {});
      out.push({
        kind: 'model', id: value, value, cat, mark: def.mark || String(def.maker || def.name).slice(0, 2).toUpperCase(),
        name: def.name, desc, meta: from ? tl(link.def.label) : meta, metaCls: from ? 'port' : metaCls, link,
        src: { label: { fr: def.name, en: def.name }, desc: def.desc, keywords: { fr: `${def.maker || ''} ${familyWords(def).join(' ')}`, en: def.maker || '' } },
      });
    };
    for (const [key, def] of Object.entries(fams)) {
      if (!Array.isArray(def.workflows) || !def.workflows.length) continue;
      const installed = (inv?.models || []).some((m) => m.status === 'ready' && !m.hidden && localKeyOf(m, fams) === key);
      push(`fam:${key}`, def, 'models', installed ? familyWords(def).join(' · ') : t('pal.notInstalled'), installed ? '' : 'missing');
    }
    for (const def of cloudCatalog().families || []) {
      push(def.key, def, 'cloud', [t('pal.online'), ...familyWords(def)].join(' · '), 'online');
    }
    return out;
  }

  /** L'entrée (ou la sortie) d'un bloc Modèle de cette famille qui prendra le fil lâché. */
  function linkForFamily(fam, from) {
    if (!fam) return null;
    if (from.dir === 'out') {
      const ports = portsOfFamily(fam);
      const def = inputDefs('gen').find((p) => ports[p.id] && p.type !== 'text' && compatible(from.type, p.type));
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
    e.wKeys = words(both(src?.keywords));
    e.wDesc = words(`${both(src?.desc)} ${e.desc}`);
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
    return s + (e.kind === 'recipe' ? 0.5 : 0);
  }

  function render(resetActive) {
    const q = fold(input.value.trim());
    const all = entries();
    const catDefs = categories().filter((c) => all.some((e) => e.cat === c.id));
    const hasRecipes = all.some((e) => e.cat === 'recipes');
    const hasModels = all.some((e) => e.cat === 'models');
    const hasCloud = all.some((e) => e.cat === 'cloud');

    // colonne des catégories
    const catBtn = (id, label) => `<button type="button" class="pal-cat${st.cat === id ? ' on' : ''}" data-cat="${esc(id)}">${esc(label)}</button>`;
    cats.innerHTML = catBtn('all', t('pal.all'))
      + (hasModels ? catBtn('models', t('pal.models')) : '')
      + (hasCloud ? catBtn('cloud', t('pal.cloud')) : '')
      + (hasRecipes ? catBtn('recipes', t('pal.recipes')) : '')
      + catDefs.map((c) => catBtn(c.id, tl(c.label))).join('');

    // liste
    let sections;
    if (q) {
      const qWords = words(q);
      const hits = qWords.length
        ? all.map((e) => ({ e, s: score(e, qWords) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s)
        : [];
      sections = [{ title: null, items: hits.map((x) => x.e) }];
    } else if (st.cat === 'all') {
      sections = [];
      // les modèles du PC d'abord ; ceux en ligne ont leur catégorie (ils sont nombreux) et la recherche
      if (hasModels) sections.push({ title: t('pal.models'), items: all.filter((e) => e.cat === 'models') });
      if (st.from && hasCloud) sections.push({ title: t('pal.cloud'), items: all.filter((e) => e.cat === 'cloud') });
      if (hasRecipes) sections.push({ title: t('pal.recipes'), items: all.filter((e) => e.cat === 'recipes') });
      for (const c of catDefs) sections.push({ title: tl(c.label), items: all.filter((e) => e.cat === c.id) });
    } else {
      const special = { recipes: t('pal.recipes'), models: t('pal.models'), cloud: t('pal.cloud') };
      const c = special[st.cat] ? null : categories().find((x) => x.id === st.cat);
      sections = [{ title: c?.label ? tl(c.label) : special[st.cat], items: all.filter((e) => e.cat === st.cat) }];
    }

    st.items = [];
    let html = '';
    for (const s of sections) {
      if (!s.items.length) continue;
      if (s.title) html += `<div class="pal-sec">${esc(s.title)}</div>`;
      for (const e of s.items) {
        const i = st.items.length;
        st.items.push(e);
        // nom et méta (modèle, ou port qui recevra le fil) sur la 1re ligne ; la description prend toute la
        // largeur dessous, sur 2 lignes au plus (demande de Quentin : lire la phrase, pas « … » au bout de 40 signes)
        html += `<button type="button" class="pal-item${e.kind === 'recipe' ? ' recipe' : ''}" data-i="${i}" role="option">`
          + (e.kind === 'model' ? `<span class="pal-glyph pal-mark">${esc(e.mark)}</span>`
            : `<span class="pal-glyph">${icon(e.icon, 16) || icon('g-unknown', 16)}</span>`)
          + '<span class="pal-text"><span class="pal-head">'
          + `<span class="pal-name">${esc(e.name)}</span>`
          + (e.meta ? `<span class="pal-meta ${e.metaCls || ''}"${e.metaTip ? ` data-tip="${esc(e.metaTip)}"` : ''}>${esc(e.meta)}</span>` : '')
          + `</span><span class="pal-desc">${esc(e.desc)}</span></span>`
          + '</button>';
      }
    }
    if (!st.items.length) html = `<div class="pal-empty">${esc(st.from ? t('pal.emptyFrom') : t('pal.empty'))}</div>`;
    list.innerHTML = html;
    // la surbrillance glisse d'une ligne à l'autre : un seul élément, déplacé par transform
    hl = document.createElement('div');
    hl.className = 'pal-hl';
    hl.hidden = !st.items.length;
    list.prepend(hl);
    if (resetActive) { st.active = 0; list.scrollTop = 0; }
    setActive(Math.min(st.active, st.items.length - 1), true, false);
    hideSide();
  }

  // ── la phrase entière d'une description coupée ──
  // Une bulle à côté du panneau (jamais sur la ligne voisine, qu'elle cachait), et seulement
  // quand la souris a vraiment bougé : la palette ouverte sous un pointeur immobile (fil
  // lâché) n'affiche rien tant qu'on n'a pas bougé (même drapeau que la surbrillance).
  let side = null, sideT = 0;
  function hideSide() {
    clearTimeout(sideT);
    sideT = 0;
    if (side && !side.hidden) side.hidden = true;
  }
  function scheduleSide(item) {
    hideSide();
    if (!item || !mouseArmed) return;
    sideT = setTimeout(() => showSide(item), 500);
  }
  function showSide(item) {
    sideT = 0;
    if (root.hidden || !item.isConnected || !mouseArmed) return;
    const d = item.querySelector('.pal-desc');
    if (!d || d.scrollHeight <= d.clientHeight + 1) return;          // la phrase tient : rien à montrer
    if (!side) {
      side = document.createElement('div');
      side.className = 'tooltip multi pal-side';
      side.setAttribute('role', 'tooltip');
      root.append(side);
    }
    side.textContent = d.textContent;
    side.style.left = '0px';
    side.style.top = '0px';
    side.hidden = false;
    const pr = panel.getBoundingClientRect(), ir = item.getBoundingClientRect();
    const w = side.offsetWidth, h = side.offsetHeight;
    const clampY = (y) => Math.max(8, Math.min(innerHeight - h - 8, y));
    let x = pr.right + 10, y = clampY(ir.top + ir.height / 2 - h / 2);
    if (x + w > innerWidth - 8) x = pr.left - 10 - w;                    // pas de place à droite : à gauche
    if (x < 8) {                                                          // fenêtre étroite : sous la ligne
      x = Math.max(8, Math.min(innerWidth - w - 8, ir.left + 40));
      y = clampY(ir.bottom + 6);
    }
    side.style.left = `${Math.round(x)}px`;
    side.style.top = `${Math.round(y)}px`;
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
    hideSide();
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return close(); }
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
