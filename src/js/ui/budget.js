/**
 * The corner of the board (SPEC §23.3): what the Higgsfield account spent this month and, from the last top-up
 * Quentin entered in Settings → Online accounts, an estimate of what is left. Higgsfield gives no balance to an API
 * key: only the spending comes from them (GET /models/usage, a few minutes late), the « left » is his top-up minus
 * that. Nothing is asked while no account is linked; the chip then stays hidden.
 *
 * Mounted in the zoom bar (graph/editor.js); refreshed when the account or the top-up changes, after an online job
 * ends (twice: Higgsfield's figures lag), and every ten minutes while the window is shown. A click opens Settings on
 * the online accounts.
 */
import { el } from '../util.js';
import { t, register, lang } from '../i18n.js';
import { on, emit } from '../bus.js';

register({
  fr: {
    'budget.month': '{amount} ce mois-ci',
    'budget.left': 'reste ≈ {amount}',
    'budget.tip': 'Higgsfield · dépensé ce mois-ci : {month}. {left} Chiffres de Higgsfield, avec quelques minutes de retard. Clic : Réglages → Comptes en ligne.',
    'budget.tipLeft': 'Reste estimé : ta recharge de {amount} du {date}, moins {spent} dépensés depuis.',
    'budget.tipNoTopUp': 'Indique ta dernière recharge dans les Réglages pour voir ce qui reste.',
    'budget.error': 'Higgsfield · dépenses indisponibles : {error}',
  },
  en: {
    'budget.month': '{amount} this month',
    'budget.left': 'left ≈ {amount}',
    'budget.tip': 'Higgsfield · spent this month: {month}. {left} Figures from Higgsfield, a few minutes late. Click: Settings → Online accounts.',
    'budget.tipLeft': 'Estimated left: your top-up of {amount} on {date}, minus {spent} spent since.',
    'budget.tipNoTopUp': 'Enter your last top-up in Settings to see what is left.',
    'budget.error': 'Higgsfield · spending unavailable: {error}',
  },
});

/** An amount for Mia's language: « 12,40 $ » in French, « $12.40 » in English (dollars: the API's currency). */
export function money(amount, currency = 'USD') {
  const n = Number(amount) || 0;
  const s = Math.abs(n).toFixed(2);
  const sign = n < 0 ? '−' : '';
  if (currency !== 'USD') return `${sign}${lang() === 'en' ? s : s.replace('.', ',')} ${currency}`;
  return lang() === 'en' ? `${sign}$${s}` : `${sign}${s.replace('.', ',')} $`;
}

/** A price that may be tiny: « 0,84 $ », but « 0,003 $ » for a SOUL V2 image at 0.0032 $ (never « 0,00 $ »). */
export function moneyFine(amount, currency = 'USD') {
  const n = Number(amount) || 0;
  if (n <= 0 || n >= 0.01) return money(n, currency);
  const x = n.toFixed(3);
  return money(0, currency).replace(/0[.,]00/, (m) => (m.includes(',') ? x.replace('.', ',') : x));
}

/** A top-up date, short: « 27/10 » (« 10/27 » in English). */
export function shortDate(ms) {
  return new Date(ms).toLocaleDateString(lang() === 'en' ? 'en-US' : 'fr-FR', { day: '2-digit', month: '2-digit' });
}

const REFRESH_MS = 10 * 60 * 1000;
let chip = null;
let sep = null;
let last = null;

function paint(b) {
  if (!chip) return;
  const show = !!(b && b.linked && (b.month != null || b.last || b.error));
  chip.hidden = !show;
  if (sep) sep.hidden = !show;
  if (!show) return;
  const v = b.month != null ? b : b.last;
  const name = el('span', { class: 'zb-hf-name' }, 'Higgsfield');
  if (!v) {
    chip.replaceChildren(name, el('span', { class: 'zb-hf-amt' }, '—'));
    chip.dataset.tip = t('budget.error', { error: b.error || '?' });
    chip.classList.remove('low', 'out');
    return;
  }
  // le reste quand une recharge est connue (ce qu'on veut savoir d'un coup d'œil), sinon les dépenses du mois ;
  // le détail au survol
  chip.replaceChildren(name, el('span', { class: 'zb-hf-amt' }, v.left != null
    ? t('budget.left', { amount: money(v.left, v.currency) })
    : t('budget.month', { amount: money(v.month, v.currency) })));
  // un reste bas se voit sans alarme : moins d'un dixième de la recharge, puis rien du tout
  const out = v.left != null && v.left <= 0;
  chip.classList.toggle('out', out);
  chip.classList.toggle('low', !out && v.left != null && v.topUp && v.left < v.topUp.amount * 0.1);
  const left = v.left != null
    ? t('budget.tipLeft', { amount: money(v.topUp.amount, v.currency), date: shortDate(v.topUp.at), spent: money(v.sinceTopUp, v.currency) })
    : t('budget.tipNoTopUp');
  chip.dataset.tip = b.error ? t('budget.error', { error: b.error }) : t('budget.tip', { month: money(v.month, v.currency), left });
}

/** Asks the main process (it keeps an answer one minute unless `fresh`). */
export async function refreshBudget({ fresh = false } = {}) {
  let b = null;
  try { b = await window.mia?.cloud?.budget?.({ fresh }); } catch { b = null; }
  if (b && (b.month != null || !b.linked)) last = b;
  paint(b && b.linked && b.month == null && !b.last && last && last.linked ? { ...b, last } : b);
  return b;
}

/** The chip and its separator, first in the zoom bar. → [chip, separator] */
export function mountBudget() {
  if (!chip) {
    chip = el('button', { type: 'button', class: 'zb-hf', hidden: true });
    chip.addEventListener('click', () => emit('settings:open', { section: 'cloud' }));
    sep = el('span', { class: 'zb-sep', hidden: true });
    refreshBudget();
    setInterval(() => { if (document.visibilityState === 'visible') refreshBudget(); }, REFRESH_MS);
  }
  return [chip, sep];
}

on('cloud:changed', () => { refreshBudget({ fresh: true }); });
on('cloud:topup', () => { refreshBudget({ fresh: true }); });
// un calcul en ligne qui finit : ses dépenses arrivent chez Higgsfield avec un peu de retard
on('engine:event', (evt) => {
  if (!chip || !evt || (evt.kind !== 'done' && evt.kind !== 'error')) return;
  const node = window.__mia?.editor?.getNode?.(evt.nodeId);
  if (!String(node?.params?.model || '').startsWith('hf:')) return;
  setTimeout(() => refreshBudget({ fresh: true }), 30 * 1000);
  setTimeout(() => refreshBudget({ fresh: true }), 3 * 60 * 1000);
});

export default { mountBudget, refreshBudget, money, shortDate };
