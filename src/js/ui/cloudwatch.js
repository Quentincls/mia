/**
 * La veille des modèles en ligne, côté écran (SPEC §23.8) : une ligne calme sur l'accueil quand Higgsfield a des
 * modèles que Mia n'a pas encore (« 3 nouveaux modèles en ligne · Voir »), et la liste où on les installe d'un clic
 * ou les écarte. Le processus principal (electron/cloudwatch.js) lit les pages et prépare tout ; ici, rien que
 * l'affichage. Sans pont (window.mia.cloud.watch absent), rien ne s'affiche.
 */
import { el } from '../util.js';
import { icon } from '../icons.js';
import { t, tn, register } from '../i18n.js';
import { openModal } from './modal.js';
import { toast } from './toasts.js';
import { moneyFine } from './budget.js';

register({
  fr: {
    'watch.line.one': '1 nouveau modèle en ligne chez Higgsfield',
    'watch.line.other': '{n} nouveaux modèles en ligne chez Higgsfield',
    'watch.see': 'Voir',
    'watch.title': 'Nouveaux chez Higgsfield',
    'watch.lead': 'Higgsfield les propose et Mia ne les a pas encore. Installer les ajoute aux modèles en ligne : rien n’est calculé ni payé tant que tu ne lances pas un bloc.',
    'watch.newFamily': 'Nouveau modèle',
    'watch.newWays': 'Nouveaux modes',
    'watch.from': 'dès {price}',
    'watch.perSecond': '{price} / s',
    'watch.perImage': '{price} / image',
    'watch.install': 'Installer',
    'watch.installAll': 'Tout installer',
    'watch.ignore': 'Ignorer',
    'watch.ignoreTip': 'Ne plus le proposer',
    'watch.later': 'Plus tard',
    'watch.installed.one': '{names} installé : il est dans « + Bloc », onglet En ligne. Pas encore essayé.',
    'watch.installed.other': '{names} installés : ils sont dans « + Bloc », onglet En ligne. Pas encore essayés.',
    'watch.failed': 'Installation impossible : {error}',
    'watch.empty': 'Plus rien à installer.',
  },
  en: {
    'watch.line.one': '1 new online model at Higgsfield',
    'watch.line.other': '{n} new online models at Higgsfield',
    'watch.see': 'See',
    'watch.title': 'New at Higgsfield',
    'watch.lead': 'Higgsfield offers them and Mia does not have them yet. Installing adds them to the online models: nothing is computed or paid until you run a block.',
    'watch.newFamily': 'New model',
    'watch.newWays': 'New modes',
    'watch.from': 'from {price}',
    'watch.perSecond': '{price} / s',
    'watch.perImage': '{price} / image',
    'watch.install': 'Install',
    'watch.installAll': 'Install all',
    'watch.ignore': 'Ignore',
    'watch.ignoreTip': 'Do not offer it again',
    'watch.later': 'Later',
    'watch.installed.one': '{names} installed: it is in “+ Block”, Online tab. Not tried yet.',
    'watch.installed.other': '{names} installed: they are in “+ Block”, Online tab. Not tried yet.',
    'watch.failed': 'Could not install: {error}',
    'watch.empty': 'Nothing left to install.',
  },
});

const api = () => window.mia?.cloud;

/** « dès ≈ 0,03 $ / s » : le tarif public le plus bas (il peut inclure une remise du moment). */
function priceText(p) {
  if (!p || !Number.isFinite(p.usd)) return '';
  const v = `≈ ${moneyFine(p.usd)}`;
  const price = p.unit === 'second' ? t('watch.perSecond', { price: v }) : p.unit === 'image' ? t('watch.perImage', { price: v }) : v;
  return t('watch.from', { price }).replace(/ /g, ' ');
}

/**
 * La ligne de l'accueil. → l'élément (caché tant qu'il n'y a rien), à placer où l'accueil veut.
 * Elle se tient à jour seule (évènement cloud:watch du processus principal).
 */
export function watchLine() {
  const msg = el('span', { class: 'home-banner-msg' });
  const see = el('button', { class: 'btn sm', type: 'button' }, t('watch.see'));
  const line = el('div', { class: 'home-banner home-watch', hidden: true, role: 'status' },
    el('span', { class: 'home-banner-ico home-watch-ico', html: icon('globe', 16) }), msg, see);
  let last = null;
  const paint = (w) => {
    last = w && Array.isArray(w.pending) ? w : null;
    const n = last && !last.off ? last.pending.length : 0;
    line.hidden = !n;
    if (n) msg.textContent = tn('watch.line', n, { n });
  };
  see.addEventListener('click', () => { if (last) openList(last, paint); });
  const c = api();
  if (c?.watch) {
    c.watch().then(paint, () => {});
    c.onWatch?.(paint);
  }
  return line;
}

/** La liste des nouveaux modèles : installer (un ou tous), ignorer, plus tard. */
function openList(w, paint) {
  const list = el('div', { class: 'watch-list' });
  const act = el('div', { class: 'modal-actions' });
  const body = el('div', { class: 'watch' },
    el('h2', {}, t('watch.title')),
    el('p', { class: 'watch-lead' }, t('watch.lead')),
    list, act);
  const m = openModal(body, { width: 560, className: 'watch-modal' });
  let pending = w.pending.slice();

  async function install(keys) {
    const c = api();
    if (!c?.watchInstall) return;
    const names = pending.filter((p) => !keys || keys.includes(p.key)).map((p) => p.name);
    const r = await c.watchInstall(keys).catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) { toast(t('watch.failed', { error: (r && r.error) || '?' }), { kind: 'error' }); return; }
    toast(tn('watch.installed', names.length, { names: names.join(', ') }), { kind: 'ok' });
    if (r.watch) { paint(r.watch); pending = r.watch.pending.slice(); }
    if (!pending.length) m.close(true); else draw();
  }
  async function ignore(key) {
    const c = api();
    const r = await c?.watchIgnore?.([key]).catch(() => null);
    if (r) { paint(r); pending = r.pending.slice(); }
    if (!pending.length) m.close(true); else draw();
  }

  function draw() {
    list.innerHTML = '';
    if (!pending.length) list.append(el('p', { class: 'watch-lead' }, t('watch.empty')));
    for (const p of pending) {
      const row = el('div', { class: 'watch-row' },
        el('span', { class: 'watch-mark' }, p.mark || String(p.maker || p.name).slice(0, 2).toUpperCase()),
        el('div', { class: 'watch-main' },
          el('div', { class: 'watch-line' },
            el('span', { class: 'watch-name' }, p.name),
            el('span', { class: 'watch-maker' }, p.maker || ''),
            el('span', { class: 'mp-badge' }, t(p.isNew ? 'watch.newFamily' : 'watch.newWays'))),
          el('div', { class: 'watch-desc' }, p.desc || p.does.join(' · ')),
          // une famille nouvelle : sa phrase dit déjà ce qu'elle fait ; des modes nouveaux : lesquels
          el('div', { class: 'watch-meta' },
            !p.isNew && p.does.length ? el('span', {}, p.does.join(' · ')) : null,
            priceText(p.priceFrom) ? el('span', { class: 'watch-price' }, priceText(p.priceFrom)) : null)),
        el('div', { class: 'watch-acts' },
          el('button', { class: 'btn sm', type: 'button', onclick: () => install([p.key]) }, t('watch.install')),
          el('button', { class: 'btn sm btn-ghost', type: 'button', title: t('watch.ignoreTip'), onclick: () => ignore(p.key) }, t('watch.ignore'))));
      list.append(row);
    }
    act.innerHTML = '';
    act.append(el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => m.close() }, t('watch.later')));
    if (pending.length > 1) act.append(el('button', { class: 'btn btn-primary', type: 'button', onclick: () => install(null) }, el('span', {}, t('watch.installAll'))));
  }
  draw();
  return m.result;
}
