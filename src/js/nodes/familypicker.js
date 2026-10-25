// ── Choix du modèle d'un bloc Modèle (SPEC §23) ──────────────────────
// Carte en tête du bloc : la pastille et le nom de la famille (« MiniMax H3 »,
// « Seedance 2.5 »), puis ce qu'elle sait faire en mots courts (« TEXTE ·
// IMAGE · RÉFÉRENCES »). Au clic, un panneau Local | Cloud :
// - Local : les familles du PC qui ont des façons de faire (LTX, MiniMax, Wan,
//   Qwen), leur phrase « à quoi ça sert », et les variantes quand elles font
//   la même chose (LTX Standard / Rapide) ; MiniMax choisit lui-même entre
//   Images-clés et Références selon ce qui est branché ;
// - Cloud : les familles de Higgsfield (catalogue relevé dans leur doc), avec
//   leur fabricant, leur phrase et ce qu'elles savent faire. Sans compte relié,
//   un bandeau dit où le relier ; le choix reste possible (le bloc le
//   rappellera au lancement).
// Valeurs : « fam:<clé> » (une famille locale), l'id d'un modèle de
// l'inventaire (une variante précise), « hf:<famille> » (en ligne).

import { t, tl } from '../i18n.js';
import { icon } from '../icons.js';
import { el, fmtGB } from '../util.js';
import { on, emit } from '../bus.js';
import { state } from '../state.js';
import { tip } from '../ui/tooltip.js';
import { segmented } from '../ui/controls.js';
import { strings } from './media.js';
import { localCatalog, cloudCatalog, variantOf } from './profiles.js';
import { familyOf, localKeyOf } from './route.js';
import { modelName } from './modelpicker.js';

strings({
  'node.fam.local': 'Sur ce PC',
  'node.fam.cloud': 'En ligne',
  'node.fam.search': 'Chercher un modèle (LTX, Seedance, Kling…)',
  'node.fam.noMatch': 'Aucun modèle ne correspond à « {q} ».',
  'node.fam.onPc': 'Sur ce PC',
  'node.fam.notInstalled': 'Non installé',
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
  'node.fam.search': 'Search a model (LTX, Seedance, Kling…)',
  'node.fam.noMatch': 'No model matches “{q}”.',
  'node.fam.onPc': 'On this PC',
  'node.fam.notInstalled': 'Not installed',
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
export function familyWords(def) {
  const keys = (def?.workflows || []).map((wf) => wordKey(wf) || `=${tl(wf.label || {})}`);
  const uniq = [...new Set(keys)].sort((a, b) => (WORD_ORDER.indexOf(a) + 1 || 99) - (WORD_ORDER.indexOf(b) + 1 || 99));
  return uniq.map((k) => (k.startsWith('=') ? k.slice(1) : t(`node.fam.w.${k}`)));
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

let openPop = null;
function closePop() {
  if (!openPop) return;
  const p = openPop;
  openPop = null;
  p.cleanup();
  p.el.remove();
}

const markOfDef = (def) => def.mark || String(def.maker || def.name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();

/**
 * Sélecteur de famille d'un bloc Modèle. opts : { param, value, onChange(v) }.
 * Retour : élément avec .setValue(v), .refresh(), .setDisabled(b, why?), .destroy()
 */
export function familyPicker({ param, value, onChange }) {
  let current = value ?? param.default ?? 'fam:ltx';
  let disabled = false;
  let disabledWhy = '';
  let tab = String(current).startsWith('hf:') ? 'cloud' : 'local';
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

  function paint() {
    const fam = famNow();
    if (!fam) {
      txt.textContent = t('node.fam.unknown');
      mark.textContent = '·';
      chips.textContent = '';
      where.hidden = true;
      trigger.classList.add('warn');
      return;
    }
    trigger.classList.remove('warn');
    const def = fam.def;
    txt.textContent = def.name;
    mark.textContent = markOfDef(def);
    const words = familyWords(def);
    const v = fam.variant ? variantOf(fam.variant)?.tag : '';
    chips.textContent = [v, ...words].filter(Boolean).join(' · ');
    where.hidden = fam.provider === 'local';
    where.textContent = t('node.fam.online');
  }
  // au survol : où il calcule, son nom, à quoi il sert, ce qu'il sait faire (infobulle riche)
  tip(trigger, () => {
    if (disabled && disabledWhy) return disabledWhy;
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
    if (v === current) return;
    current = v;
    paint();
    onChange?.(v);
  }

  function open() {
    closePop();
    const search = el('input', { class: 'mp-search-in', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: t('node.fam.search') });
    const head = el('div', { class: 'mp-head' },
      el('label', { class: 'mp-search' }, el('span', { class: 'mp-search-ico', html: icon('search', 14) }), search));
    const tabs = segmented({
      options: [{ value: 'local', label: t('node.fam.local') }, { value: 'cloud', label: t('node.fam.cloud') }],
      value: tab, size: 'sm', full: true,
      onChange: (v) => { tab = v; render(); search.focus(); },
    });
    head.append(el('div', { class: 'mp-tabs' }, tabs));
    const list = el('div', { class: 'mp-list', role: 'listbox' });
    const pop = el('div', { class: 'mp-pop mp-panel' }, head, list);

    const famRow = ({ value: v, def, sub, words, selected, greyed, note, size, indent }) => {
      const r = el('div', { class: `mp-row mp-var${selected ? ' sel' : ''}${greyed ? ' greyed' : ''}${indent ? ' mp-indent' : ''}`, role: 'option', tabindex: '-1' },
        el('span', { class: 'mp-check', html: selected ? icon('check', 13) : '' }),
        indent ? null : el('span', { class: 'mp-mark sm', 'aria-hidden': 'true' }, markOfDef(def)),
        el('span', { class: 'mp-main' },
          el('span', { class: 'mp-line' },
            el('span', { class: 'mp-name' }, sub?.title || def.name),
            words ? el('span', { class: 'mp-fam' }, words) : null),
          sub?.text ? el('span', { class: 'mp-sub' }, sub.text) : null),
        el('span', { class: 'mp-side' },
          note ? el('span', { class: 'mp-note' }, note) : null,
          size ? el('span', { class: 'mp-size' }, size) : null));
      if (!greyed && v) {
        r.dataset.value = v;
        r.addEventListener('click', (e) => { e.stopPropagation(); choose(v); });
      }
      return r;
    };

    function renderLocal(q) {
      const fams = localFamilies().filter(({ def }) => !q || fold(`${def.name} ${def.maker} ${tl(def.desc || {})}`).includes(q));
      const famNowKey = famNow()?.provider === 'local' ? famNow().key : null;
      for (const f of fams) {
        const words = familyWords(f.def).join(' · ');
        const famSel = current === `fam:${f.key}` || (famNowKey === f.key && !f.variants.some((m) => m.id === current));
        const box = el('div', { class: 'mp-family' });
        box.append(famRow({ value: f.installed ? `fam:${f.key}` : null, def: f.def, words, selected: famSel,
          greyed: !f.installed, note: f.installed ? '' : t('node.fam.notInstalled'),
          sub: { text: tl(f.def.desc || {}) } }));
        for (const m of f.variants) {
          const v = variantOf(m);
          box.append(famRow({ value: m.id, def: f.def, indent: true, selected: current === m.id,
            sub: { title: v?.tag || modelName(m), text: v?.desc || '' }, size: m.sizeGB ? fmtGB(m.sizeGB) : '' }));
        }
        if (f.key === 'minimax' && f.installed) box.append(el('div', { class: 'mp-famdesc mp-hint' }, t('node.fam.byWires')));
        list.append(box);
      }
      return fams.length;
    }

    function renderCloud(q) {
      const banner = el('div', { class: 'mp-cloudbar' });
      if (linked === false) {
        const btn = el('button', { class: 'mp-cloud-btn on', type: 'button' }, t('node.fam.cloudLinkBtn'));
        btn.addEventListener('pointerdown', (e) => e.stopPropagation());
        btn.addEventListener('click', (e) => { e.stopPropagation(); closePop(); emit('settings:open', { section: 'cloud' }); });
        banner.append(el('span', {}, t('node.fam.cloudLink')), btn);
      } else banner.append(el('span', {}, t(linked === null ? 'node.fam.cloudChecking' : 'node.fam.cloudLinked')));
      list.append(banner);
      const fams = (cloudCatalog().families || [])
        .filter((def) => !q || fold(`${def.name} ${def.maker} ${tl(def.desc || {})}`).includes(q))
        .slice().sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'video' ? -1 : 1) || a.name.localeCompare(b.name));
      let kind = null;
      for (const def of fams) {
        if (def.kind !== kind) {
          kind = def.kind;
          list.append(el('div', { class: 'mp-group' }, t(kind === 'image' ? 'node.fam.image' : 'node.fam.video')));
        }
        list.append(famRow({ value: def.key, def, words: familyWords(def).join(' · '), selected: current === def.key,
          sub: { text: tl(def.desc || {}) } }));
      }
      return fams.length;
    }

    function render() {
      const q = fold(search.value.trim());
      list.replaceChildren();
      const n = tab === 'cloud' ? renderCloud(q) : renderLocal(q);
      if (q && !n) list.append(el('div', { class: 'mp-empty' }, t('node.fam.noMatch', { q: search.value.trim() })));
      paintFocus();
    }

    let focus = -1;
    const rows = () => [...list.querySelectorAll('.mp-row[data-value]')];
    function paintFocus() {
      const all = rows();
      if (focus < 0 || focus >= all.length) focus = Math.max(0, all.findIndex((r) => r.classList.contains('sel')));
      all.forEach((r, i) => r.classList.toggle('focus', i === focus));
    }
    search.addEventListener('input', () => { focus = 0; render(); });
    search.addEventListener('keydown', (e) => {
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) return;
      e.stopPropagation();
    });

    render();
    document.body.append(pop);
    place(pop, trigger);
    // le compte en ligne : demandé une fois, puis l'onglet Cloud se redessine s'il est montré
    Promise.resolve(window.mia?.cloud?.status?.()).then((s) => {
      linked = !!(s && s.linked);
      if (tab === 'cloud' && openPop?.owner === root) render();
    }).catch(() => { linked = false; if (tab === 'cloud' && openPop?.owner === root) render(); });

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

function place(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.min(vw - 16, 440);
  pop.style.width = `${w}px`;
  const h = pop.offsetHeight;
  const left = Math.min(Math.max(8, r.left), vw - w - 8);
  let top = r.bottom + 6;
  if (top + h > vh - 10 && r.top - h - 6 > 54) top = r.top - h - 6;
  top = Math.max(54, Math.min(top, vh - h - 10));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}
