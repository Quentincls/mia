// ── « + Ajouter » : les entrées qu'un bloc Modèle garde rangées ──────
// Demande de Quentin (24/10) : un bloc Modèle s'ouvre presque vide (la
// Consigne et l'entrée principale) ; le reste de ce que sait prendre le modèle
// se range derrière « + Ajouter ». Le menu dit, pour chaque entrée, ce qu'elle
// est et ce qu'elle permet, en mots simples ; une entrée encore à l'essai porte
// le badge « À essayer ». Tirer un fil vers le bloc montre aussi tout, le temps
// du geste (graph/interact.js).

import { t, tl, register } from '../i18n.js';
import { el } from '../util.js';
import { openMenu } from '../ui/menu.js';
import { blockFamily } from './ports.js';
import { portsOfWorkflow } from './route.js';
import { portTip } from './porthelp.js';

register({
  fr: {
    'addinput.title': '{family} sait prendre aussi',
    'addinput.trial': 'À essayer',
    'addinput.uses': 'Pour : {list}',
    'addinput.upTo': 'jusqu’à {n}',
  },
  en: {
    'addinput.title': '{family} can also take',
    'addinput.trial': 'To try',
    'addinput.uses': 'For: {list}',
    'addinput.upTo': 'up to {n}',
  },
});

/** Les façons de faire de la famille qui se servent de l'entrée `id`. */
function usesOf(fam, id) {
  return (fam?.def?.workflows || []).filter((wf) => portsOfWorkflow(wf)[id]);
}

/**
 * Ouvre le menu sous `anchor`. `defs` : les entrées rangées (ports.js `hiddenInputs`) ; `onPick(id)` les montre.
 */
export function openAddInput(node, anchor, defs, onPick) {
  if (!node || !defs?.length) return null;
  const fam = blockFamily(node);
  const items = [{ group: t('addinput.title', { family: fam?.def?.name || '' }) }];
  for (const d of defs) {
    const uses = usesOf(fam, d.id);
    const tipInfo = portTip(node, d, 'in', d.type) || {};
    const labels = [...new Set(uses.map((wf) => tl(wf.label || {})).filter(Boolean))];
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
