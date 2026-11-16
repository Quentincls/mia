// ── « + Ajouter » : les entrées qu'un bloc Modèle garde rangées ──────
// Demande de Quentin (24/10) : un bloc Modèle s'ouvre presque vide (la
// Consigne et l'entrée principale) ; le reste de ce que sait prendre le modèle
// se range derrière « + Ajouter ». Le menu dit, pour chaque entrée, ce qu'elle
// est et ce qu'elle permet, en mots simples ; une entrée encore à l'essai porte
// le badge « À essayer ». Tirer un fil vers le bloc montre aussi les entrées
// utiles, le temps du geste (graph/interact.js). Audit du 25/10 : la ligne dit
// aussi ce qu'il faut brancher en plus (« Pour : Animer une image (avec Image de
// début) »), et un bloc LTX propose de passer sur MiniMax pour des références.

import { t, tl, register } from '../i18n.js';
import { el } from '../util.js';
import { openMenu } from '../ui/menu.js';
import { blockFamily, portLabels } from './ports.js';
import { portsOfWorkflow, needsOf } from './route.js';
import { inputDefs } from '../catalog.js';
import { portTip } from './porthelp.js';

register({
  fr: {
    'addinput.title': '{family} sait prendre aussi',
    'addinput.trial': 'À essayer',
    'addinput.uses': 'Pour : {list}',
    'addinput.upTo': 'jusqu’à {n}',
    'addinput.with': '{what} (avec {needs})',
    'addinput.toMiniMax': 'Partir de références ? Passe ce bloc sur MiniMax H3',
    'addinput.toMiniMaxHint': 'LTX ne mélange pas plusieurs images de référence séparées ; MiniMax H3 le fait (jusqu’à 9 images, 3 vidéos, 3 sons). Les fils restent branchés.',
  },
  en: {
    'addinput.title': '{family} can also take',
    'addinput.trial': 'To try',
    'addinput.uses': 'For: {list}',
    'addinput.upTo': 'up to {n}',
    'addinput.with': '{what} (with {needs})',
    'addinput.toMiniMax': 'Starting from references? Switch this block to MiniMax H3',
    'addinput.toMiniMaxHint': 'LTX does not blend several separate reference images; MiniMax H3 does (up to 9 images, 3 videos, 3 sounds). The wires stay connected.',
  },
});

/** Les façons de faire de la famille qui se servent de l'entrée `id`. */
function usesOf(fam, id) {
  return (fam?.def?.workflows || []).filter((wf) => portsOfWorkflow(wf)[id]);
}

/**
 * Ouvre le menu sous `anchor`. `defs` : les entrées rangées (ports.js `hiddenInputs`) ; `onPick(id)` les montre ;
 * `onModel(value)` change le modèle du bloc (passer sur MiniMax H3).
 */
export function openAddInput(node, anchor, defs, onPick, onModel = null) {
  if (!node || !defs?.length) return null;
  const fam = blockFamily(node);
  const items = [{ group: t('addinput.title', { family: fam?.def?.name || '' }) }];
  const names = portLabels(fam);
  const word = (pid) => tl(names[pid] || inputDefs(node.type).find((i) => i.id === pid)?.label || { fr: pid });
  for (const d of defs) {
    const uses = usesOf(fam, d.id);
    const tipInfo = portTip(node, d, 'in', d.type) || {};
    const labels = [...new Set(uses.map((wf) => {
      const needs = needsOf(wf).filter((pid) => pid !== d.id);
      return needs.length ? t('addinput.with', { what: tl(wf.label || {}), needs: needs.map(word).join(', ') }) : tl(wf.label || {});
    }).filter(Boolean))];
    const line = [labels.length ? t('addinput.uses', { list: labels.join(' · ') }) : '', d.multi && d.max > 1 ? t('addinput.upTo', { n: d.max }) : '']
      .filter(Boolean).join(' · ');
    items.push({
      value: d.id,
      label: tl(d.label),
      hint: tipInfo.body || '',
      uses: line,
      icon: `<span class="pa-dot" data-t="${d.type}"></span>`,
      badge: d.trial || (uses.length && uses.every((wf) => wf.trial)) ? t('addinput.trial') : '',
      action: () => onPick(d.id),
    });
  }
  // LTX ne part pas de références : le dire là où on les cherche, et proposer MiniMax d'un clic
  if (onModel && fam?.provider === 'local' && fam.key === 'ltx') {
    items.push('sep', {
      value: 'fam:minimax', label: t('addinput.toMiniMax'), hint: t('addinput.toMiniMaxHint'),
      icon: '<span class="pa-dot" data-t="image"></span>', action: () => onModel('fam:minimax'),
    });
  }
  return openMenu(items, anchor, {
    className: 'addinput',
    minWidth: 280,
    search: false,
    renderItem: (it) => el('div', { class: 'ctx-text' },
      el('span', { class: 'ctx-label' }, it.label),
      it.hint ? el('span', { class: 'ctx-hint' }, it.hint) : null,
      it.uses ? el('span', { class: 'pa-uses' }, it.uses) : null),
  });
}
