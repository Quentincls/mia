// Mia — l'entraînement de LoRA hors de son écran, sans fenêtre :
//   - la rangée « Entraînement LoRA · Rosa » en tête de la file des calculs (src\js\ui\queuetrain.js, que
//     src\js\ui\queue.js dessine) : nom, modèle, pourcentage, heure de fin, état, croix, info-bulle, en français
//     et en anglais ; la pastille repliée quand l'entraînement est seul ; l'heure de départ des calculs qui
//     attendent derrière lui ; la question de la croix (« Arrêter… », la même que sur l'écran) ;
//   - la barre des tâches et la veille quand Mia se ferme (electron\trainshell.js, release()) ;
//   - le branchement (queue.js suit train:list / train:event et ouvre l'écran par « train:open » ; main.js appelle
//     update() quand la fenêtre est prête et release() avant de la détruire).
//
//   node tools/test-train-queue.mjs
// Code de sortie : 0 tout est bon, 1 des contrôles en échec.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const Q = await import(pathToFileURL(path.join(ROOT, 'src', 'js', 'ui', 'queuetrain.js')).href);
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; return; }
  fail++;
  console.log(`ÉCHEC  ${name}${extra !== undefined ? `  → ${JSON.stringify(extra)}` : ''}`);
};
const NB = ' ';
const sp = (s) => String(s).replace(/[  ]/g, ' ');
const clean = (s) => typeof s === 'string' && s.length > 0 && !/[{}]|undefined|NaN|null/.test(s);

const bases = [{ id: 'ltx25', label: { fr: 'LTX 2.5', en: 'LTX 2.5' }, estimate: { sampleSec: 120 } }];
const at340 = new Date(2026, 10, 19, 3, 40).getTime();
const now = at340 - 3600e3;
const base = { id: 'r1', name: 'Rosa', base: 'ltx25', step: 1240, steps: 2500, progress: 0.496, endAt: at340, seen: true };
const S = {
  attente: { ...base, state: 'attente', endAt: null },
  preparation: { ...base, state: 'preparation', phase: 'load', step: 0, progress: 0, endAt: null },
  entrainement: { ...base, state: 'entrainement' },
  entrainementSansFin: { ...base, state: 'entrainement', endAt: null },
  essai: { ...base, state: 'essai', step: 1000, progress: 0.4 },
  passer: { ...base, state: 'pause', pause: { reason: 'pass' } },
  pause: { ...base, state: 'pause', pause: { reason: 'user' } },
  fini: { ...base, state: 'fini', step: 2500, progress: 1, seen: false },
  erreur: { ...base, state: 'erreur', seen: false },
  annule: { ...base, state: 'annule', step: 620 },
  interrompu: { ...base, state: 'interrompu' },
  muet: { ...base, state: 'entrainement', silent: true },
  arret: { ...base, state: 'entrainement', pending: 'stop' }
};

// ── la rangée, dans les deux langues ─────────────────────────────────
const expect = {
  fr: {
    label: 'Entraînement LoRA · Rosa', run: `49${NB}% · fin vers 3 h 40`, wait: 'en attente du GPU', prep: 'préparation',
    sample: `essai · 40${NB}%`, pass: 'en pause · laisse passer les calculs', done: 'FINI · 2 500 PAS', err: 'ERREUR',
    stopped: 'ARRÊTÉ · 620', inter: 'INTERROMPU · 1 240', paused: 'EN PAUSE · 1 240', noEnd: `49${NB}%`,
    tip: 'Rosa · LTX 2.5 · pas 1 240 / 2 500 · fin vers 3 h 40', silent: 'sans nouvelle', stopping: 'arrêt en cours',
    pill: 'LoRA · Rosa', crossTip: 'Arrêter l’entraînement…'
  },
  en: {
    label: 'LoRA training · Rosa', run: '49% · ends around 03:40', wait: 'waiting for the GPU', prep: 'preparing',
    sample: 'sample · 40%', pass: 'paused · letting jobs through', done: 'DONE · 2,500 STEPS', err: 'ERROR',
    stopped: 'STOPPED · 620', inter: 'INTERRUPTED · 1,240', paused: 'PAUSED · 1,240', noEnd: '49%',
    tip: 'Rosa · LTX 2.5 · step 1,240 / 2,500 · ends around 03:40', silent: 'no news', stopping: 'stopping',
    pill: 'LoRA · Rosa', crossTip: 'Stop the training…'
  }
};
for (const L of ['fr', 'en']) {
  const E = expect[L];
  const r = (k) => Q.trainRow(L, S[k], bases);
  const run = r('entrainement');
  check(`${L} · rangée : « ${E.label} »`, run.label === E.label, run.label);
  check(`${L} · rangée : sous-ligne = le modèle « LTX 2.5 »`, run.sub === 'LTX 2.5', run.sub);
  check(`${L} · en cours : « ${E.run} », barre de progression, croix`, sp(run.text) === sp(E.run) && run.bar === 'progress' && run.progress === 0.496 && run.cancel && run.tone === 'live', run);
  check(`${L} · en cours : info-bulle comme la puce « ${E.tip} »`, sp(run.tip) === sp(E.tip), run.tip);
  check(`${L} · en cours sans heure de fin : le pourcentage seul`, sp(r('entrainementSansFin').text) === sp(E.noEnd), r('entrainementSansFin').text);
  const w = r('attente');
  check(`${L} · attente du GPU : « ${E.wait} », sans barre, croix`, w.text === E.wait && w.bar === null && w.cancel && w.tone === 'muted', w);
  const p = r('preparation');
  check(`${L} · préparation : « ${E.prep} », barre indéterminée`, p.text === E.prep && p.bar === 'ind' && p.cancel, p);
  const e = r('essai');
  check(`${L} · essai : « ${E.sample} », barre de progression`, sp(e.text) === sp(E.sample) && e.bar === 'progress' && e.cancel, e);
  const ps = r('passer');
  check(`${L} · laisser passer : « ${E.pass} », sans barre, toujours dans la file`, ps.text === E.pass && ps.bar === null && ps.cancel, ps);
  for (const [k, txt, tone] of [['fini', E.done, 'muted'], ['erreur', E.err, 'err'], ['annule', E.stopped, 'muted'], ['interrompu', E.inter, 'err'], ['pause', E.paused, 'muted']]) {
    const x = r(k);
    check(`${L} · ${k} (quelques secondes après) : « ${txt} », sans croix ni barre`, sp(x.text) === sp(txt) && !x.cancel && x.bar === null && x.tone === tone, x);
    check(`${L} · ${k} : l’info-bulle ne promet pas d’heure de fin`, !/fin vers|ends around/.test(x.tip), x.tip);
  }
  const m = r('muet');
  check(`${L} · outil muet : « … · ${E.silent} », en rouge`, m.text.endsWith(` · ${E.silent}`) && m.tone === 'err', m);
  check(`${L} · arrêt demandé : « … · ${E.stopping} »`, r('arret').text.endsWith(` · ${E.stopping}`), r('arret').text);
  check(`${L} · sans la liste des modèles : l’identifiant en capitales`, Q.trainRow(L, S.entrainement, null).sub === 'LTX25');
  check(`${L} · sans nom : « ${L === 'fr' ? 'Nouveau LoRA' : 'New LoRA'} »`, Q.trainRow(L, { ...S.entrainement, name: '' }, bases).label.endsWith(L === 'fr' ? 'Nouveau LoRA' : 'New LoRA'));
  for (const k of Object.keys(S)) {
    const x = r(k);
    check(`${L} · ${k} : textes propres`, clean(x.label) && clean(x.sub) && clean(x.text) && clean(x.tip), x);
  }
  const pill = Q.trainPill(L, S.entrainement, bases);
  check(`${L} · pastille seule : « ${E.pill} » · « ${E.run} »`, pill.name === E.pill && sp(pill.state) === sp(E.run), pill);
  check(`${L} · croix : info-bulle « ${E.crossTip} »`, Q.qx(L, 'q.stop') === E.crossTip);
}

// ── mêmes clés, apostrophes typographiques ───────────────────────────
const kf = Object.keys(Q.STRINGS.fr).sort().join();
check('mêmes clés en français et en anglais', kf === Object.keys(Q.STRINGS.en).sort().join());
check('français : apostrophes typographiques', Object.values(Q.STRINGS.fr).every((s) => !/[A-Za-zÀ-ÿ]'[A-Za-zÀ-ÿ]/.test(s)));
check('clé inconnue : la clé s’affiche', Q.qx('fr', 'q.nope') === 'q.nope');

// ── quel entraînement la file montre ─────────────────────────────────
check('file : l’entraînement actif', Q.queueTraining([S.fini, S.entrainement]) === S.entrainement);
check('file : laisser passer compte comme actif', Q.queueTraining([S.passer]) === S.passer);
check('file : rien d’actif (fini, pause à la main, brouillon) → rien', Q.queueTraining([S.fini, S.pause, { ...base, state: 'pret' }]) === null);
check('file : un dossier introuvable ne compte pas', Q.queueTraining([{ ...S.entrainement, missing: true }]) === null);
check('file : états de fin gardés quelques secondes', ['fini', 'erreur', 'annule', 'interrompu', 'pause'].every((k) => Q.ENDED.has(k)) && !Q.ENDED.has('entrainement'));

// ── heure de départ des calculs qui attendent derrière ───────────────
check('derrière un entraînement : les calculs partent à sa fin', Q.laneStart(now, S.entrainement) === at340);
check('derrière un essai : idem', Q.laneStart(now, S.essai) === at340);
check('derrière une attente ou une préparation sans heure : inconnu', Q.laneStart(now, S.attente) === null && Q.laneStart(now, S.preparation) === null);
check('« Laisser passer » : les calculs partent tout de suite', Q.laneStart(now, S.passer) === now);
check('sans entraînement ou fini : tout de suite', Q.laneStart(now, null) === now && Q.laneStart(now, S.fini) === now);
check('heure de fin déjà passée : pas avant maintenant', Q.laneStart(now, { ...S.entrainement, endAt: now - 5000 }) === now);

// ── la question de la croix ──────────────────────────────────────────
{
  const fr = Q.stopQuestion('fr', S.entrainement, bases);
  check('fr · croix : « Arrêter l’entraînement de Rosa au pas 1 240 ? » + point de contrôle', sp(fr.title) === 'Arrêter l’entraînement de Rosa au pas 1 240 ?' && fr.body === 'Un point de contrôle est écrit ; tu pourras reprendre.' && fr.ok === 'Arrêter' && fr.cancel === 'Continuer', fr);
  const en = Q.stopQuestion('en', S.entrainement, bases);
  check('en · croix : “Stop training Rosa at step 1,240?”', en.title === 'Stop training Rosa at step 1,240?' && en.body === 'A checkpoint is written; you can resume.' && en.ok === 'Stop' && en.cancel === 'Keep training', en);
  const es = Q.stopQuestion('fr', { ...S.essai, sampleStep: { i: 1, of: 1, n: 10, total: 20 }, measured: { sampleSec: 120 } }, bases);
  check('fr · croix pendant un essai : « L’arrêt se fait à la fin de l’essai (≈ 1 min) »', es.body.endsWith('L’arrêt se fait à la fin de l’essai (≈ 1 min).'), es.body);
  const es2 = Q.stopQuestion('en', { ...S.essai, sampleStep: null, measured: null }, bases);
  check('en · croix pendant un essai, durée du modèle : “It stops when the sample ends (≈ 2 min).”', es2.body.endsWith('It stops when the sample ends (≈ 2 min).'), es2.body);
  const es3 = Q.stopQuestion('fr', { ...S.essai, base: 'autre' }, bases);
  check('fr · croix pendant un essai, durée inconnue : sans durée', es3.body.endsWith('L’arrêt se fait à la fin de l’essai.'), es3.body);
  for (const k of ['attente', 'preparation', 'muet', 'passer']) {
    const q = Q.stopQuestion('fr', S[k], bases);
    check(`fr · croix en ${k} : « Arrêter l’entraînement de Rosa ? », arrêt immédiat`, q.title === 'Arrêter l’entraînement de Rosa ?' && q.body === '', q);
  }
}

// ── la fenêtre de la puce GPU : qui tient le GPU pendant un entraînement (19/11 : « GPU libre » sous 46 Go) ──
{
  const fn = typeof Q.gpuHolder === 'function' ? Q.gpuHolder : () => null;
  const fr = fn('fr', S.entrainement);
  check('puce GPU · fr : « L’entraînement « Rosa » tient le GPU (fin vers 3 h 40) »', sp(fr) === 'L’entraînement « Rosa » tient le GPU (fin vers 3 h 40)', fr);
  check('puce GPU · fr : espaces insécables dans « … »', /«\u00a0Rosa\u00a0»/.test(fr || ''), fr);
  const en = fn('en', S.entrainement);
  check('GPU chip · en: “The training “Rosa” holds the GPU (ends around 03:40)”', en === 'The training “Rosa” holds the GPU (ends around 03:40)', en);
  const side = fn('fr', S.entrainement, 'Portrait Plumo');
  check('puce GPU · un calcul à côté est nommé : « … · à côté : « Portrait Plumo » »', sp(side) === 'L’entraînement « Rosa » tient le GPU (fin vers 3 h 40) · à côté : « Portrait Plumo »', side);
  check('GPU chip · en, a job alongside: “… · alongside: “Portrait””', fn('en', S.entrainement, 'Portrait') === 'The training “Rosa” holds the GPU (ends around 03:40) · alongside: “Portrait”', fn('en', S.entrainement, 'Portrait'));
  check('puce GPU · préparation et essai : il tient le GPU, sans heure quand elle manque', sp(fn('fr', S.preparation)) === 'L’entraînement « Rosa » tient le GPU' && /tient le GPU \(fin vers/.test(sp(fn('fr', S.essai))), [fn('fr', S.preparation), fn('fr', S.essai)]);
  check('puce GPU · en attente du GPU, laisse passer, en pause, fini : ce n’est pas lui (rien)', ['attente', 'passer', 'pause', 'fini', 'erreur', 'annule'].every((k) => fn('fr', S[k]) === null) && fn('fr', null) === null);
  check('puce GPU · sans nom : « Nouveau LoRA »', /Nouveau LoRA/.test(fn('fr', { ...S.entrainement, name: '' }) || ''));
  const qs = fs.readFileSync(path.join(ROOT, 'src', 'js', 'ui', 'queue.js'), 'utf8');
  check('queue.js : la fenêtre de la puce dit d’abord l’entraînement (statut du moteur), nomme le calcul à côté', /function holderText\(s\)/.test(qs) && /QT\.gpuHolder\(L2\(\), tr, b \?/.test(qs) && /s\?\.training \|\| QT\.queueTraining\(trainRows\)/.test(qs) && /holderText\(s\)\)\)/.test(qs));
}

// ── la 2e ligne d'une rangée de la file : la raison d'attendre, lisible (19/11 : coupée avant la partie utile) ──
{
  const fn = typeof Q.waitLine === 'function' ? Q.waitLine : () => '';
  const FULL = 'Attend la fin de l’entraînement « Plumo » (vers 15 h 10) : une vidéo ne part pas à côté';
  const SHORT = 'Une vidéo ne part pas à côté : après l’entraînement, vers 15 h 10';
  check('file : derrière un entraînement, la forme courte du moteur (la raison d’abord)', fn({ trainWait: true, waitShort: SHORT }, FULL) === SHORT);
  check('file : sans forme courte (un moteur d’avant), la phrase entière', fn({ trainWait: true }, FULL) === FULL && fn({ trainWait: true, waitShort: '  ' }, FULL) === FULL);
  check('file : pas derrière un entraînement → rien (« mode · planche » comme avant)', fn({ trainWait: false, waitShort: SHORT }, FULL) === '' && fn(null, FULL) === '');
  const qs = fs.readFileSync(path.join(ROOT, 'src', 'js', 'ui', 'queue.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'css', 'queue.css'), 'utf8');
  check('queue.js : la 2e ligne prend QT.waitLine et passe en « is-why » ; la phrase entière reste au survol', /QT\.waitLine\(j, why\)/.test(qs) && /classList\.toggle\('is-why'/.test(qs) && /tipText = \[lbl, s, why,/.test(qs));
  check('queue.css : « is-why » sur deux lignes au plus', /\.q-sub\.is-why\s*\{[^}]*white-space: normal[^}]*-webkit-line-clamp: 2/.test(css));
  const runsJs = fs.readFileSync(path.join(ROOT, 'src', 'js', 'nodes', 'runs.js'), 'utf8');
  check('runs.js : waitShort suit les évènements du moteur et la relève de la file', /job\.waitShort = \(evt\.trainWait && evt\.waitShort\) \|\| null/.test(runsJs) && /waitShort: \(j\.trainWait && j\.waitShort\) \|\| null/.test(runsJs));
}

// ── barre des tâches et veille quand Mia se ferme (trainshell.release) ──
{
  const { createTrainShell } = require(path.join(ROOT, 'electron', 'trainshell.js'));
  const calls = [];
  const fwin = { setProgressBar: (p, o) => calls.push(['bar', p, o ? o.mode : undefined]), flashFrame: (on) => calls.push(['flash', on]), isFocused: () => false, isDestroyed: () => false };
  const psb = { n: 0, on: new Set(), start() { this.on.add(++this.n); return this.n; }, stop(id) { this.on.delete(id); }, isStarted(id) { return this.on.has(id); } };
  let b = { id: 't1', state: 'entrainement', progress: 0.4 };
  const docs = { t1: { state: 'entrainement', seen: true } };
  const sh = createTrainShell({ trainer: { brief: () => b, item: (id) => (docs[id] ? { doc: docs[id] } : null) }, getWin: () => fwin, powerSaveBlocker: psb });
  sh.update();
  check('fermeture : avant, veille bloquée et barre à 40 %', psb.on.size === 1 && calls.some((c) => c[1] === 0.4 && c[2] === 'normal'));
  sh.release();
  check('fermeture : release() rend la veille et retire la barre, même si l’entraînement tourne encore', psb.on.size === 0 && calls[calls.length - 1][0] === 'bar' && calls[calls.length - 1][1] === -1 && sh.state().released === true, calls.slice(-2));
  const n = calls.length;
  b = { id: 't1', state: 'entrainement', progress: 0.5 };
  sh.update();
  check('fermeture : après release(), un dernier évènement du service ne rallume rien', calls.length === n && psb.on.size === 0 && psb.n === 1);
  sh.release();
  check('fermeture : release() deux fois, sans effet ni erreur', calls.length === n);

  // une erreur qui faisait clignoter : le clignotement s'arrête à la fermeture
  const calls2 = [];
  const w2 = { setProgressBar: (p, o) => calls2.push(['bar', p, o ? o.mode : undefined]), flashFrame: (on) => calls2.push(['flash', on]), isFocused: () => false, isDestroyed: () => false };
  let b2 = { id: 'e1', state: 'entrainement', progress: 0.2 };
  const d2 = { e1: { state: 'entrainement', seen: true } };
  const sh2 = createTrainShell({ trainer: { brief: () => b2, item: (id) => (d2[id] ? { doc: d2[id] } : null) }, getWin: () => w2, powerSaveBlocker: null });
  sh2.update();
  b2 = null; d2.e1 = { state: 'erreur', seen: false };
  sh2.update();
  check('erreur, Mia derrière : barre en mode erreur et clignotement', calls2.some((c) => c[0] === 'flash' && c[1] === true) && calls2.some((c) => c[2] === 'error'));
  sh2.release();
  check('fermeture : le clignotement s’arrête, la barre d’erreur est retirée', calls2.slice(-2).some((c) => c[0] === 'flash' && c[1] === false) && calls2.some((c) => c[0] === 'bar' && c[1] === -1), calls2.slice(-3));

  // pas de fenêtre au démarrage (le service part avant elle) : la barre est écrite au premier update() qui en trouve une
  const calls3 = [];
  let w3 = null;
  const sh3 = createTrainShell({ trainer: { brief: () => ({ id: 'x', state: 'entrainement', progress: 0.3 }), item: () => null }, getWin: () => w3, powerSaveBlocker: null });
  sh3.update();
  w3 = { setProgressBar: (p, o) => calls3.push(['bar', p, o ? o.mode : undefined]), isDestroyed: () => false };
  sh3.update();
  check('fenêtre prête après le service : la progression est écrite dès qu’elle existe', calls3.length === 1 && calls3[0][1] === 0.3 && calls3[0][2] === 'normal', calls3);
}

// ── branchements ─────────────────────────────────────────────────────
{
  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  check('main.js : update() quand la fenêtre est prête', /win\.once\('ready-to-show', \(\) => \{ if \(trainShell\) trainShell\.update\(\); \}\)/.test(main));
  check('main.js : release() dans finishClose, avant de détruire la fenêtre', /const finishClose = async[\s\S]{0,2000}trainShell\.release\(\)[\s\S]{0,120}win\.destroy\(\)/.test(main));
  const qs = fs.readFileSync(path.join(ROOT, 'src', 'js', 'ui', 'queue.js'), 'utf8');
  check('queue.js : suit train:list et train:event', /a\.list\(\)/.test(qs) && /a\.onEvent\?\.\(/.test(qs));
  check('queue.js : le clic sur la rangée ouvre l’écran (train:open)', /emit\('train:open', \{ id: s\.id \}\)/.test(qs));
  check('queue.js : la croix demande d’abord, puis arrête (control stop)', /confirm\(\{ \.\.\.QT\.stopQuestion\(/.test(qs) && /a\.control\(s\.id, 'stop'\)/.test(qs));
  check('queue.js : l’heure de fin de la file compte l’entraînement', /queueEnd\(active, tr\)/.test(qs) && /QT\.laneStart\(/.test(qs));
  check('queue.js : ni <select> ni attribut title', !/<select|'select'|\btitle:/.test(qs));
}

console.log(`${pass} contrôles bons, ${fail} en échec`);
process.exit(fail ? 1 : 0);
