// Mia — les mots de l'écran « Entraînements » (src\js\ui\traintext.js), sans fenêtre : chaque état du §2.5 de la
// conception (attente du GPU, vérification, encodage, chargement, entraînement, essai — avec ou sans étape de rendu,
// ai-toolkit n'en publie pas —, pause manuelle, laisser passer, pause disque, fini, erreur, arrêté, interrompu,
// introuvable), ses boutons et leurs raisons quand ils sont éteints, la zone A (« PROPOSÉ PAR … · LANCÉ PAR TOI »,
// « … REGARDE · IL Y A n MIN », « PRÉPARÉ PAR … »), en français et en anglais.
//
//   node tools/test-train-ui.mjs
// Code de sortie : 0 tout est bon, 1 des contrôles en échec.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const X = await import(pathToFileURL(path.join(ROOT, 'src', 'js', 'ui', 'traintext.js')).href);

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; return; }
  fail++;
  console.log(`ÉCHEC  ${name}${extra !== undefined ? `  → ${JSON.stringify(extra)}` : ''}`);
};
const line = (L, s, ctx) => { const o = X.statusLine(L, s, ctx); return { ...o, text: o.parts.join(' · ') }; };
const clean = (t) => typeof t === 'string' && t.length > 0 && !/[{}]|undefined|NaN|null/.test(t);

const base = { steps: 2000, step: 840, progress: 0.42, settings: { sampleEvery: 250 }, checkpoints: [{ step: 750 }, { step: 500 }] };
const S = {
  attente: { ...base, state: 'attente', wait: { who: 'Mia : Upscale', since: '14:02' } },
  attenteMia: { ...base, state: 'attente', wait: {} },
  verification: { ...base, state: 'preparation', phase: 'check' },
  encodage: { ...base, state: 'preparation', phase: 'encode', phaseN: 12, phaseOf: 64 },
  encodage0: { ...base, state: 'preparation', phase: 'encode', phaseN: 0, phaseOf: 0 },
  chargement: { ...base, state: 'preparation', phase: 'load' },
  entrainement: { ...base, state: 'entrainement', eta: { seconds: 3600, endAt: Date.UTC(2026, 10, 18, 15, 40) }, lastNewsS: 4 },
  essai: { ...base, state: 'essai', step: 750, sampleStep: { i: 1, of: 1, n: 3, total: 5 }, measured: { sampleSec: 50 } },
  essaiAitk: { ...base, state: 'essai', step: 750, sampleStep: null, measured: { sampleSec: 50 } },
  pause: { ...base, state: 'pause', pause: { reason: 'user' } },
  passer: { ...base, state: 'pause', pause: { reason: 'pass' }, waitingJobs: 2 },
  disque: { ...base, state: 'pause', pause: { reason: 'disk' } },
  fini: { ...base, state: 'fini', step: 2000, progress: 1, startedAt: 1000, endedAt: 1000 + 7440000 },
  erreur: { ...base, state: 'erreur', error: { code: 'takeover', message: { fr: 'L’outil n’a pas pris le pilotage de Mia.', en: 'The tool did not take Mia’s control.' } } },
  annule: { ...base, state: 'annule' },
  interrompu: { ...base, state: 'interrompu' },
  introuvable: { ...base, state: 'pause', missing: true }
};
const expect = {
  fr: {
    attente: /^ATTENTE DU GPU · PRIS PAR « Upscale » DEPUIS/, attenteMia: /^ATTENTE DU GPU · UN CALCUL DE MIA SE TERMINE$/,
    verification: /^VÉRIFICATION DU JEU$/, encodage: /^ENCODAGE DES IMAGES 12 \/ 64$/, encodage0: /^ENCODAGE DES IMAGES$/,
    chargement: /^CHARGEMENT DU MODÈLE/, entrainement: /^ENTRAÎNEMENT · PAS 840 \/ 2.000 · 42/,
    essai: /^ESSAI DU PAS 750 · ÉTAPE 3 \/ 5 DU RENDU · PAS 750/, essaiAitk: /^ESSAI DU PAS 750 · PAS 750 \/ 2.000 · REPREND DANS/,
    pause: /^EN PAUSE AU PAS 840 · GPU RENDU · NE REPREND PAS SEUL$/, passer: /^EN PAUSE · REPREND APRÈS 2 CALCULS$/,
    disque: /^EN PAUSE AU PAS 840$/, fini: /^FINI · 2.000 PAS · /, erreur: /^ERREUR AU PAS 840$/,
    annule: /^ARRÊTÉ AU PAS 840 · 2 POINTS DE CONTRÔLE SUR LE DISQUE$/, interrompu: /^INTERROMPU AU PAS 840$/, introuvable: /^DOSSIER INTROUVABLE$/
  },
  en: {
    attente: /^WAITING FOR THE GPU · HELD BY “Upscale” SINCE/, attenteMia: /^WAITING FOR THE GPU · A MIA JOB IS FINISHING$/,
    verification: /^CHECKING THE SET$/, encodage: /^ENCODING IMAGES 12 \/ 64$/, encodage0: /^ENCODING IMAGES$/,
    chargement: /^LOADING THE MODEL/, entrainement: /^TRAINING · STEP 840 \/ 2,000 · 42/,
    essai: /^SAMPLE AT STEP 750 · RENDER STEP 3 \/ 5 · STEP 750/, essaiAitk: /^SAMPLE AT STEP 750 · STEP 750 \/ 2,000 · RESUMES IN/,
    pause: /^PAUSED AT STEP 840 · GPU RELEASED · DOES NOT RESUME BY ITSELF$/, passer: /^PAUSED · RESUMES AFTER 2 JOBS$/,
    disque: /^PAUSED AT STEP 840$/, fini: /^DONE · 2,000 STEPS · /, erreur: /^ERROR AT STEP 840$/,
    annule: /^STOPPED AT STEP 840 · 2 CHECKPOINTS ON DISK$/, interrompu: /^INTERRUPTED AT STEP 840$/, introuvable: /^FOLDER NOT FOUND$/
  }
};
const bars = { attente: 'none', verification: 'indeterminate', encodage: 'progress', encodage0: 'indeterminate', chargement: 'indeterminate', entrainement: 'progress', essai: 'frozen', essaiAitk: 'frozen', pause: 'paused', passer: 'paused', disque: 'paused', fini: 'full', erreur: 'paused', annule: 'paused', interrompu: 'paused' };

for (const L of ['fr', 'en']) {
  for (const [k, s] of Object.entries(S)) {
    const o = line(L, s, { now: Date.now(), freeGB: 3.2 });
    check(`${L} ${k} : ligne C « ${o.text} »`, clean(o.text) && expect[L][k].test(o.text.replace(/[  ]/g, '.')), o.text);
    if (bars[k]) check(`${L} ${k} : barre « ${bars[k]} »`, o.bar === bars[k], o.bar);
  }
  check(`${L} essai ai-toolkit (sans sample_step) : aucune « étape du rendu »`, !/ÉTAPE|RENDER/.test(line(L, S.essaiAitk).text));
  check(`${L} essai ai-toolkit : tuile en cours sans chiffres`, X.sampleSlots(S.essaiAitk).some((t) => t.step === 750 && t.running && t.n === 0 && t.total === 0));
  check(`${L} pause disque : phrase sous la ligne`, clean(line(L, S.disque, { freeGB: 3.2 }).sub) && clean(line(L, S.disque, {}).sub));
  check(`${L} chargement : phrase sous la ligne`, clean(line(L, S.chargement).sub));
  // l'erreur : sous la ligne C, la phrase du cas PUIS son explication complète (ce qu'il s'est passé, quoi faire)
  check(`${L} erreur : la raison dans la langue, suivie de son explication`, line(L, S.erreur).sub === `${S.erreur.error.message[L]} ${X.tx(L, 'why.takeover')}` && line(L, S.erreur).error === true, line(L, S.erreur).sub);
  const oom = { ...S.erreur, error: { code: 'oom', message: { fr: 'Mémoire GPU pleine.', en: 'GPU memory full.' } } };
  const oomSub = line(L, oom).sub || '';
  check(`${L} erreur mémoire GPU : « ${oomSub} »`, oomSub.startsWith(L === 'fr' ? 'Mémoire GPU pleine. ' : 'GPU memory full. ') && oomSub.length > 80 && /GPU/.test(oomSub.slice(20)) && clean(oomSub), oomSub);
  for (const code of ['oom', 'ram', 'disk', 'missing', 'resume', 'hang', 'takeover', 'version', 'spawn', 'tool']) {
    const why = X.tx(L, `why.${code}`);
    check(`${L} erreur « ${code} » : une explication, une phrase finie`, clean(why) && why !== `why.${code}` && /[.)]$/.test(why), why);
  }
  const toolErr = { code: 'tool', message: { fr: 'L’outil s’est arrêté (code 7) : RuntimeError: plantage simulé au pas 230', en: 'The tool stopped (code 7): RuntimeError: plantage simulé au pas 230' } };
  check(`${L} erreur de l’outil : la ligne brute en haut, close par un point, puis l’invitation au journal ; la phrase propre pour ÉVÈNEMENTS`,
    X.errorSentence(L, toolErr) === `${toolErr.message[L]}. ${X.tx(L, 'why.tool')}` && X.errorShort(L, toolErr) === (L === 'fr' ? 'L’outil s’est arrêté (code 7).' : 'The tool stopped (code 7).'), [X.errorSentence(L, toolErr), X.errorShort(L, toolErr)]);
  const spawnErr = { code: 'tool', message: { fr: 'Impossible de lancer l’outil : spawn ENOENT', en: 'Could not start the tool: spawn ENOENT' } };
  check(`${L} outil introuvable au lancement : « ${X.errorShort(L, spawnErr)} » et le chemin des réglages`, X.errorShort(L, spawnErr) === X.tx(L, 'err.spawn') && X.errorSentence(L, spawnErr).endsWith(X.tx(L, 'why.spawn')));
  check(`${L} erreur sans code connu ni texte : une phrase quand même`, clean(X.errorShort(L, { code: 'zzz' })) && clean(X.errorSentence(L, { code: 'zzz' })));

  // « REPREND DANS ≈ … » : rien sous une seconde (pas de « ≈ 0 S »)
  for (const [name, s] of [['rendu fini', { ...S.essai, sampleStep: { i: 1, of: 1, n: 5, total: 5 } }], ['essai mesuré à 0,4 s', { ...S.essaiAitk, measured: { sampleSec: 0.4 } }]]) {
    const t = line(L, s).text;
    check(`${L} essai, ${name} : pas de « ${L === 'fr' ? 'REPREND DANS' : 'RESUMES IN'} » sous une seconde`, !/REPREND DANS|RESUMES IN/.test(t) && !/≈ 0/.test(t), t);
  }
  check(`${L} essai à 1 s de la fin : « ${L === 'fr' ? 'REPREND DANS ≈ 1 S' : 'RESUMES IN ≈ 1 S'} »`, line(L, { ...S.essai, sampleStep: { i: 1, of: 1, n: 49, total: 50 } }).text.endsWith(L === 'fr' ? 'REPREND DANS ≈ 1 S' : 'RESUMES IN ≈ 1 S'), line(L, { ...S.essai, sampleStep: { i: 1, of: 1, n: 49, total: 50 } }).text);

  // tailles : jamais « 0 MO » pour un dossier qui pèse quelque chose
  const sz = [X.size(L, 0.3), X.size(L, 0.0004), X.size(L, 0), X.size(L, 327), X.size(L, 5324.8), X.size(L, 0.3, false)];
  check(`${L} tailles : ${sz.join(' | ')}`, JSON.stringify(sz.map((x) => x.replace(/[  ]/g, ' '))) === JSON.stringify(L === 'fr' ? ['307 KO', '1 KO', '0 KO', '327 MO', '5,2 GO', '307 Ko'] : ['307 KB', '1 KB', '0 KB', '327 MB', '5.2 GB', '307 KB']), sz);

  // ÉVÈNEMENTS : un seul ordre, des heures justes — un essai dont le fichier a été copié garde la date de sa
  // source (ici une heure plus tôt) : il revient entre les lignes datées qui l'entourent
  {
    const T0 = Date.UTC(2026, 10, 19, 0, 3);
    const run = {
      state: 'fini', step: 200, steps: 200, startedAt: T0 - 400,
      checkpoints: [{ step: 100, at: T0 + 4000 }, { step: 200, at: T0 + 7000 }],
      samples: [{ step: 100, at: T0 - 3600000 }],
      events: [
        { e: 'caps', run: 1 }, { e: 'phase', phase: 'check', t: T0 }, { e: 'phase', phase: 'encode', n: 1, of: 2, t: T0 + 100 },
        { e: 'phase', phase: 'load', t: T0 + 400 }, { e: 'phase', phase: 'train', t: T0 + 2400 },
        { e: 'phase', phase: 'save', t: T0 + 3900 }, { e: 'checkpoint', step: 100 }, { e: 'phase', phase: 'train', t: T0 + 4100 },
        { e: 'phase', phase: 'sample', t: T0 + 5000 }, { e: 'sample', step: 100, sec: 0.6 }, { e: 'phase', phase: 'train', t: T0 + 6000 },
        { e: 'checkpoint', step: 200 }, { e: 'done', step: 200 }
      ],
      notes: [{ by: 'user', act: 'start', at: T0 - 400 }, { by: 'Claude', text: 'visage stable', at: T0 + 5500 }]
    };
    const ev = X.eventLines(L, run);
    const ats = ev.map((e) => e.at);
    const sample = ev.find((e) => /^(Essai|Sample) 100/.test(e.text));
    check(`${L} évènements : dans l’ordre du temps`, ats.every((a, i) => i === 0 || a >= ats[i - 1]), ev.map((e) => [e.at - T0, e.text]));
    check(`${L} évènements : l’essai au fichier copié revient entre « essai » et « entraînement » (pas une heure plus tôt)`, !!sample && sample.at >= T0 + 5000 && sample.at <= T0 + 6000, sample);
    check(`${L} évènements : l’essai suit le point 100 et précède la note de Claude`, ev.findIndex((e) => e === sample) > ev.findIndex((e) => /100$/.test(e.text) && /Point|Checkpoint/.test(e.text)) && ev.findIndex((e) => e === sample) < ev.findIndex((e) => e.by === 'Claude'), ev.map((e) => e.text));
    check(`${L} évènements : aucune durée « (0 s) » (sous une seconde, rien), « (2 s) » pour le chargement`,
      !ev.some((e) => /\(0 s\)/.test(e.text)) && ev.some((e) => e.text === (L === 'fr' ? 'Images encodées' : 'Images encoded')) && ev.some((e) => e.text === (L === 'fr' ? 'Modèle chargé (2 s)' : 'Model loaded (2 s)')) && !!sample && sample.text === (L === 'fr' ? 'Essai 100' : 'Sample 100'), ev.map((e) => e.text));
  }
  // l'erreur qui a fini l'entraînement est dans ÉVÈNEMENTS, une fois, avec la phrase propre ; une erreur d'un
  // lancement précédent aussi, propre ; le message brut de l'outil n'y est jamais (il reste dans son journal)
  {
    const T0 = Date.UTC(2026, 10, 19, 1, 0);
    const failed = {
      state: 'erreur', step: 230, steps: 1500, startedAt: T0, endedAt: T0 + 9000, checkpoints: [{ step: 200, at: T0 + 5000 }],
      error: { code: 'tool', message: { fr: 'L’outil s’est arrêté (code 1) : faux outil : échec demandé au pas 230', en: 'The tool stopped (code 1): faux outil : échec demandé au pas 230' } },
      events: [
        { e: 'caps', run: 1 }, { e: 'phase', phase: 'train', t: T0 + 100 }, { e: 'error', code: 'resume', message: 'reprise demandée au pas 100, l’outil repart de 0' },
        { e: 'caps', run: 2 }, { e: 'phase', phase: 'train', t: T0 + 1000 }, { e: 'checkpoint', step: 200 },
        { e: 'error', code: 'tool', message: 'faux outil : échec demandé au pas 230' }
      ],
      notes: []
    };
    const ev = X.eventLines(L, failed);
    const errs = ev.filter((e) => /^(Erreur|Error)/.test(e.text));
    check(`${L} erreur dans ÉVÈNEMENTS : la dernière, une fois, propre, à la fin`, errs.length === 2 && ev[ev.length - 1].text === (L === 'fr' ? 'Erreur au pas 230 : L’outil s’est arrêté (code 1).' : 'Error at step 230: The tool stopped (code 1).'), ev.map((e) => e.text));
    check(`${L} erreur d’un lancement précédent : la phrase propre`, errs[0] && errs[0].text === `${X.tx(L, 'ev.error', { m: X.tx(L, 'err.resume') })}`, errs.map((e) => e.text));
    check(`${L} ÉVÈNEMENTS sans le message brut de l’outil`, !ev.some((e) => /faux outil|repart de 0|RuntimeError|Traceback/.test(e.text)), ev.map((e) => e.text));
    const oomEv = X.eventLines(L, { ...failed, error: { code: 'oom', message: { fr: 'Mémoire GPU pleine.', en: 'GPU memory full.' } }, events: failed.events.slice(3, 6) });
    check(`${L} erreur sans ligne de l’outil (mémoire GPU) : présente dans ÉVÈNEMENTS`, oomEv[oomEv.length - 1].text === (L === 'fr' ? 'Erreur au pas 230 : Mémoire GPU pleine.' : 'Error at step 230: GPU memory full.') && oomEv[oomEv.length - 1].at === T0 + 9000, oomEv.map((e) => e.text));
  }

  // une pause n'est pas un arrêt : l'outil dit pourquoi il s'est arrêté (why), ÉVÈNEMENTS le dit comme la ligne C
  {
    const T0 = Date.UTC(2026, 10, 19, 2, 0);
    const paused = (why, saved = true) => X.eventLines(L, {
      state: why === 'stop' ? 'annule' : 'pause', step: 1031, steps: 2500, startedAt: T0, pause: why === 'stop' ? null : { reason: 'user' },
      checkpoints: [{ step: 1031, at: T0 + 9000 }],
      events: [{ e: 'caps', run: 1 }, { e: 'phase', phase: 'train', t: T0 + 100 }, { e: 'checkpoint', step: 1031 }, { e: 'stopped', step: 1031, saved, ...(why ? { why } : {}) }],
      notes: [{ by: 'user', act: why === 'stop' ? 'stop' : 'pause', at: T0 + 8000 }]
    }).map((e) => e.text);
    const nb = (t) => t.replace(/[  ]/g, ' ');
    const last = (list) => nb(list[list.length - 1] || '');
    check(`${L} ÉVÈNEMENTS : une pause (why:"pause", point écrit) se dit « ${L === 'fr' ? 'Pause au pas 1 031, point de contrôle écrit' : 'Paused at step 1,031, checkpoint written'} »`,
      last(paused('pause')) === (L === 'fr' ? 'Pause au pas 1 031, point de contrôle écrit' : 'Paused at step 1,031, checkpoint written') && !paused('pause').some((t) => /^(Arrêt|Stopped)/.test(t)), paused('pause'));
    check(`${L} ÉVÈNEMENTS : un arrêt (why:"stop") reste « ${L === 'fr' ? 'Arrêt au pas' : 'Stopped at step'} »`, last(paused('stop')) === (L === 'fr' ? 'Arrêt au pas 1 031, point de contrôle écrit' : 'Stopped at step 1,031, checkpoint written'), paused('stop'));
    check(`${L} ÉVÈNEMENTS : une ligne d’avant (sans why) garde « ${L === 'fr' ? 'Arrêt au pas' : 'Stopped at step'} »`, last(paused(null)) === (L === 'fr' ? 'Arrêt au pas 1 031, point de contrôle écrit' : 'Stopped at step 1,031, checkpoint written'), paused(null));
    check(`${L} ÉVÈNEMENTS : Mia disparue (why:"alive") → une pause aussi`, last(paused('alive')) === (L === 'fr' ? 'Pause au pas 1 031, point de contrôle écrit' : 'Paused at step 1,031, checkpoint written'), paused('alive'));
    check(`${L} ÉVÈNEMENTS : pause sans point écrit → « ${L === 'fr' ? 'Pause au pas 1 031' : 'Paused at step 1,031'} »`, last(paused('pause', false)) === (L === 'fr' ? 'Pause au pas 1 031' : 'Paused at step 1,031'), paused('pause', false));
    // SPEC §8.7 : un calcul parti à côté de l'entraînement (trainer.noteBeside) — une ligne de Mia, le nom du bloc tel quel
    const beside = X.eventLines(L, { state: 'entrainement', step: 640, steps: 2500, startedAt: T0, events: [{ e: 'caps', run: 1 }, { e: 'phase', phase: 'train', t: T0 + 100 }],
      notes: [{ by: 'Mia', act: 'beside', step: 640, text: 'Portrait 1 240', at: T0 + 5000 }] });
    const bl = beside[beside.length - 1];
    check(`${L} ÉVÈNEMENTS : « ${L === 'fr' ? 'Calcul à côté : Portrait 1 240' : 'Job alongside: Portrait 1 240'} » (Mia, sans signature)`, !!bl
      && bl.text === (L === 'fr' ? 'Calcul à côté : Portrait 1 240' : 'Job alongside: Portrait 1 240') && bl.by === null && bl.note === false, bl);
  }

  // la puce : un « FINI » pas encore vu passe devant une pause manuelle (qui n'est pas active) ; « Laisser passer » reste devant
  {
    const now = Date.now();
    const A = { id: 'a', name: 'Rosa', base: 'fake', state: 'pause', pause: { reason: 'user' }, step: 1031, steps: 2500, endedAt: now - 60000, seen: true };
    const B = { id: 'b', name: 'Nina', base: 'fake', state: 'fini', step: 300, steps: 300, endedAt: now - 1000, seen: false };
    const m1 = X.chipModel(L, [A, B], []);
    check(`${L} puce : pause manuelle + fini non vu → « LORA · NINA · ${L === 'fr' ? 'FINI' : 'DONE'} », le clic ouvre le fini`, m1.text === `LORA · NINA · ${L === 'fr' ? 'FINI' : 'DONE'}` && m1.id === 'b' && m1.state === 'done', m1);
    const m2 = X.chipModel(L, [A, { ...B, seen: true }], []);
    check(`${L} puce : fini déjà vu → la pause manuelle reprend la puce (« ${L === 'fr' ? 'EN PAUSE' : 'PAUSED'} », le clic l’ouvre)`, m2.text === `LORA · ROSA · ${L === 'fr' ? 'EN PAUSE' : 'PAUSED'}` && m2.id === 'a' && m2.state === 'paused', m2);
    const m3 = X.chipModel(L, [{ ...A, pause: { reason: 'pass' } }, B], []);
    check(`${L} puce : « Laisser passer » (actif) reste devant le fini`, m3.id === 'a' && m3.state === 'paused', m3);
    const m4 = X.chipModel(L, [{ ...A, pause: { reason: 'disk' } }, { ...B, seen: true }, { id: 'c', name: 'Lena', base: 'fake', state: 'pret', proposal: { by: 'Claude', at: now } }], []);
    check(`${L} puce : pause disque + une proposition → la pause et le compte des propositions`, m4.id === 'a' && m4.text.endsWith(L === 'fr' ? '· 1 PROPOSITION' : '· 1 PROPOSAL'), m4);
  }

  // un nom de 40 caractères (§10, cas 33) : la puce le coupe à 14 caractères, puis « … »
  {
    const long = 'Portrait de Rosabella Marinière Longue 2';
    const m = X.chipModel(L, [{ id: 'l', name: long, base: 'fake', state: 'fini', seen: false, step: 10, steps: 10, endedAt: 1 }], []);
    const r = X.chipModel(L, [{ id: 'l', name: long, base: 'fake', state: 'entrainement', step: 5, steps: 10, progress: 0.5 }], []);
    check(`${L} puce, nom de 40 caractères : « ${m.text} » · « ${r.text} »`, long.length === 40 && m.text === `LORA · PORTRAIT DE RO… · ${L === 'fr' ? 'FINI' : 'DONE'}` && /^LORA · PORTRAIT DE RO… 50/.test(r.text) && m.tip.startsWith(long), [m.text, r.text]);
  }

  // un dossier déposé qui n'existe plus : dit par son chemin, pas « 1 fichier ignoré (format ou lecture) »
  {
    const n = X.draftNotices(L, { dataset: { count: 0, captions: 0, skipped: [{ original: 'Rosa', why: 'missing', path: 'D:\\photos\\Rosa' }, { original: 'a.png', why: 'missing', path: 'D:\\x\\a.png' }] } }, { minImages: 10, adviseImages: 20 });
    const t = n.map((x) => x.text);
    check(`${L} brouillon : dossier introuvable → « ${L === 'fr' ? 'Dossier introuvable : D:\\photos\\Rosa' : 'Folder not found: D:\\photos\\Rosa'} », fichier → « ${L === 'fr' ? 'Fichier introuvable' : 'File not found'} », rien d’« ignoré »`,
      t.includes(L === 'fr' ? 'Dossier introuvable : D:\\photos\\Rosa' : 'Folder not found: D:\\photos\\Rosa') && t.includes(L === 'fr' ? 'Fichier introuvable : D:\\x\\a.png' : 'File not found: D:\\x\\a.png') && !n.some((x) => x.id === 'skipped'), t);
  }

  // le rangement final a échoué : la phrase dit pourquoi, le bouton « Mettre dans Mes LoRA » réessaie
  check(`${L} fin sans LoRA rangé : « ${X.tx(L, 'done.notFiled', { name: 'Rosa', reason: 'X.' })} » et « ${X.tx(L, 'done.retry')} »`,
    X.tx(L, 'done.notFiled', { name: 'Rosa', reason: 'X.' }) === (L === 'fr' ? 'Rosa n’a pas pu être rangé dans Mes LoRA. X.' : 'Rosa could not be filed in My LoRAs. X.') && X.tx(L, 'done.retry') === (L === 'fr' ? 'Mettre dans Mes LoRA' : 'Add to My LoRAs'));

  // les boutons de la rangée E, et leurs raisons quand ils sont éteints
  const ids = (s, ctx) => X.actions(L, s, ctx).map((a) => a.id).join(',');
  check(`${L} attente / préparation : Arrêter…`, ids(S.attente) === 'stop' && ids(S.chargement) === 'stop');
  check(`${L} entraînement, essai : Pause, Arrêter…`, ids(S.entrainement) === 'pause,stop' && ids(S.essaiAitk) === 'pause,stop');
  const pend = X.actions(L, { ...S.essai, pending: 'stop' });
  check(`${L} arrêt demandé pendant l’essai : Pause et Arrêter… éteints, Arrêter sans attendre`, pend.map((a) => a.id).join(',') === 'pause,stop,stopNow' && pend[0].disabled && pend[1].disabled && line(L, { ...S.essai, pending: 'stop' }).text.includes(L === 'fr' ? 'ARRÊT APRÈS L’ESSAI' : 'STOP AFTER THE SAMPLE'));
  check(`${L} laisser passer : Reprendre maintenant`, ids(S.passer) === 'resumeNow,stop');
  check(`${L} pause : Reprendre, Arrêter…`, ids(S.pause) === 'resume,stop' && ids(S.disque) === 'resume,stop');
  const other = X.actions(L, S.pause, { otherActive: true })[0];
  check(`${L} un autre entraînement en cours : Reprendre éteint, avec sa raison`, other.disabled === true && other.why === (L === 'fr' ? 'Un autre entraînement est en cours' : 'Another training is running'));
  check(`${L} erreur : journal + reprendre depuis le dernier point`, ids(S.erreur) === 'log,resume' && /750/.test(X.actions(L, S.erreur)[1].label));
  check(`${L} erreur sans point : relancer depuis le début`, X.actions(L, { ...S.erreur, checkpoints: [] })[1].label === (L === 'fr' ? 'Relancer depuis le début' : 'Restart from the beginning'));
  check(`${L} arrêté : reprendre + corbeille ; interrompu : reprendre`, ids(S.annule) === 'resume,trash' && ids(S.interrompu) === 'resume');
  check(`${L} introuvable, fini : aucun bouton d’état`, ids(S.introuvable) === '' && ids(S.fini) === '');

  // zone A : qui a proposé, lancé, qui regarde ; le bandeau du brouillon
  const now = Date.UTC(2026, 10, 18, 12, 0);
  const a1 = X.presenceLine(L, { ...S.entrainement, proposedBy: 'Claude', startedBy: 'user', lastWatch: { by: 'Claude', at: now - 2 * 60000 } }, { now }).join(' · ');
  check(`${L} zone A : « ${a1} »`, L === 'fr' ? a1 === 'PROPOSÉ PAR CLAUDE · LANCÉ PAR TOI · CLAUDE REGARDE · IL Y A 2 MIN' : /^SUGGESTED BY CLAUDE · STARTED BY YOU · CLAUDE IS WATCHING · 2 MIN AGO$/.test(a1), a1);
  const a2 = X.presenceLine(L, { ...S.entrainement, startedBy: 'Codex' }, { now }).join(' · ');
  check(`${L} zone A, lancé par un assistant : « ${a2} »`, a2 === (L === 'fr' ? 'LANCÉ PAR CODEX' : 'STARTED BY CODEX'), a2);
  const a3 = X.presenceLine(L, { state: 'pret', by: { who: 'Claude', at: now } }, { now }).join(' · ');
  check(`${L} brouillon : « ${a3} »`, a3 === (L === 'fr' ? 'PRÉPARÉ PAR CLAUDE' : 'PREPARED BY CLAUDE'), a3);
  check(`${L} brouillon de Quentin : pas de bandeau`, X.presenceLine(L, { state: 'pret', by: { who: 'user', at: now } }, { now }).length === 0);
  check(`${L} « regarde » d’il y a plus d’un jour : effacé`, X.presenceLine(L, { ...S.pause, lastWatch: { by: 'Claude', at: now - 25 * 3600000 } }, { now }).length === 0);

  // filtre des ÉVÈNEMENTS : un choix par assistant, jamais Quentin
  check(`${L} filtre des évènements : les assistants seulement`, JSON.stringify(X.eventAuthors([{ by: null }, { by: 'user' }, { by: 'Claude' }, { by: 'Codex' }, { by: 'Claude' }])) === '["Claude","Codex"]');
  check(`${L} puce « LORA · 1 PROPOSITION »`, X.txn(L, 'chip.proposal', 1, { n: 1 }) === (L === 'fr' ? '1 PROPOSITION' : '1 PROPOSAL') && X.txn(L, 'chip.proposal', 2, { n: 2 }) === (L === 'fr' ? '2 PROPOSITIONS' : '2 PROPOSALS'));
  check(`${L} légende écrite par un assistant`, X.tx(L, 'cap.by', { name: 'CLAUDE' }) === (L === 'fr' ? 'ÉCRITE PAR CLAUDE' : 'WRITTEN BY CLAUDE'), X.tx(L, 'cap.by', { name: 'CLAUDE' }));
}

// le trait du pas courant de la courbe : l'accent seulement pendant un calcul (da.md), gris en pause, erreur, arrêt
{
  const C = await import(pathToFileURL(path.join(ROOT, 'src', 'js', 'ui', 'trainchart.js')).href);
  const colors = { accent: '#4d82f3', raw: '#77777f' };
  const at = (state) => C.nowColor(C.layout({ points: [{ s: 1, loss: 0.5 }], steps: 100, step: 40, live: X.computing({ state }) }, 400, 120), colors);
  const want = { preparation: '#4d82f3', entrainement: '#4d82f3', essai: '#4d82f3', pause: '#77777f', erreur: '#77777f', annule: '#77777f', interrompu: '#77777f' };
  const got = Object.fromEntries(Object.keys(want).map((k) => [k, at(k)]));
  check('courbe : trait du pas courant en accent pendant un calcul, en --txt-3 en pause, erreur, arrêt, interrompu', JSON.stringify(got) === JSON.stringify(want), got);
  check('courbe : sans « live » (ancien appel), le trait reste en accent', C.nowColor(C.layout({ points: [], steps: 10, step: 4 }, 400, 120), colors) === '#4d82f3');
}

// les deux langues ont les mêmes clés, sans apostrophe droite en français
const fr = X.STRINGS.fr, en = X.STRINGS.en;
const missing = Object.keys(fr).filter((k) => !(k in en)).concat(Object.keys(en).filter((k) => !(k in fr)));
check('mêmes clés en français et en anglais', missing.length === 0, missing);
check('apostrophes typographiques en français', Object.entries(fr).every(([, v]) => !/'/.test(v)), Object.entries(fr).filter(([, v]) => /'/.test(v)).map(([k]) => k));

console.log(`${pass} contrôles réussis, ${fail} en échec`);
process.exit(fail ? 1 : 0);
