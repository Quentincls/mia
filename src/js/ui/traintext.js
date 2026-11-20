/**
 * Mia — the « Entraînements » screen: every word of it, in French and in English, and what to show for a given
 * state. Pure functions (no DOM, no clock of their own): ui\train.js draws what they return, and
 * tools\test-train-ui.mjs checks them in Node against the wording of the design.
 *
 * `L` is always the language, 'fr' | 'en'. Texts meant for a MONO CAPS zone are written in capitals here.
 * A time of day is written by clock() (« 3 h 40 » / “03:40”), a length by dur() (« 2 h 04 min »).
 */

export const STRINGS = {
  fr: {
    'train.title': 'Entraînements',
    'train.new': 'Nouveau LoRA',
    'train.back': '‹ Retour à {name}',
    'train.home': '‹ Accueil',
    'train.crumb': '‹ Entraînements',
    'train.untitled': 'Nouveau LoRA',
    'train.you': 'TOI',
    // the chip of the title bar
    'chip.rest': 'ENTRAÎNER',
    'chip.restTip': 'Entraîner un LoRA',
    'chip.run': 'LORA · {name} {pct}',
    'chip.state': 'LORA · {name} · {state}',
    'chip.gpu': 'GPU OCCUPÉ',
    'chip.prep': 'PRÉPARATION',
    'chip.sample': 'ESSAI',
    'chip.paused': 'EN PAUSE',
    'chip.done': 'FINI',
    'chip.error': 'ERREUR',
    'chip.proposal.one': '{n} PROPOSITION',
    'chip.proposal.other': '{n} PROPOSITIONS',
    'chip.tip': '{name} · {base} · pas {a} / {b}',
    'chip.tipEnd': ' · fin vers {h}',
    // the list
    'list.empty': 'Aucun entraînement. Glisse un dossier d’images ici pour commencer.',
    'list.drop': 'Lâche ici : un nouveau LoRA est créé avec ces images.',
    'row.draft': 'BROUILLON',
    'row.waiting': 'EN ATTENTE DU GPU',
    'row.running': 'EN COURS {pct}',
    'row.paused': 'EN PAUSE · {a}',
    'row.done': 'FINI · {b} PAS',
    'row.stopped': 'ARRÊTÉ · {a}',
    'row.interrupted': 'INTERROMPU · {a}',
    'row.error': 'ERREUR',
    'row.missing': 'INTROUVABLE',
    'row.locate': 'Retrouver le dossier…',
    'row.unseen': 'Résultat pas encore ouvert',
    'menu.open': 'Ouvrir le dossier',
    'menu.duplicate': 'Dupliquer en brouillon',
    'menu.trash': 'Mettre à la corbeille',
    'trash.title': 'Mettre à la corbeille l’entraînement {name} ({size}) ?',
    'trash.body': 'Les LoRA déjà dans Mes LoRA restent.',
    'trash.ok': 'Mettre à la corbeille',
    'kind.character': 'Personnage',
    'kind.place': 'Lieu',
    'kind.style': 'Style',
    'media.video': 'vidéo',
    'media.image': 'image',
    // the draft
    'f.name': 'NOM',
    'f.model': 'MODÈLE',
    'f.kind': 'GENRE',
    'f.trigger': 'MOT DÉCLENCHEUR',
    'f.triggerHint': 'Un mot rare qui appellera ce LoRA, par exemple « rsa woman ».',
    'f.length': 'DURÉE',
    'f.short': 'Court',
    'f.normal': 'Normal',
    'f.long': 'Long',
    'f.steps': 'PAS',
    'f.estimate': '≈ {d} · GPU ≈ {g} GO',
    'f.estimateNoGpu': '≈ {d}',
    'f.unknown': 'DURÉE INCONNUE : MESURÉE APRÈS LES 20 PREMIERS PAS',
    'f.prompt': 'CONSIGNE D’ESSAI',
    'f.sampleEvery': 'un essai tous les {n} pas',
    'f.noSample': 'aucun essai pendant l’entraînement',
    'f.advanced': 'Avancés',
    'f.rank': 'Rang',
    'f.lr': 'Taux d’apprentissage',
    'f.sizes': 'Tailles d’image',
    'f.saveEvery': 'Un point de contrôle tous les N pas',
    'f.sampleEveryN': 'Un essai tous les N pas',
    'f.none': 'aucun',
    'f.morePrompts': 'Consignes d’essai supplémentaires',
    'f.addPrompt': 'Ajouter une consigne',
    'img.title': 'IMAGES',
    'img.count.one': '{n} image',
    'img.count.other': '{n} images',
    'img.caps.one': '{n} légende',
    'img.caps.other': '{n} légendes',
    'img.empty': 'Glisse des images ou un dossier. Un .txt du même nom = la légende.',
    'img.import': 'IMPORT {n} / {total}',
    'img.remove': 'Retirer du jeu',
    'img.noCaption': 'Sans légende',
    'img.small': 'Trop petite : {w} × {h} px',
    'cap.title': 'LÉGENDE',
    'cap.by': 'ÉCRITE PAR {name}',
    'cap.help': 'Le mot déclencheur est ajouté devant chaque légende : inutile de l’écrire.',
    'cap.pick': 'Clique une image pour lire ou écrire sa légende.',
    'n.noCaption.one': '{n} image sans légende',
    'n.noCaption.other': '{n} images sans légende',
    'n.triggerOnly': 'Mot déclencheur seul',
    'n.small.one': '{n} image trop petite',
    'n.small.other': '{n} images trop petites',
    'n.removeSmall': 'Retirer ces images',
    'n.showAll': 'Tout afficher',
    'n.tiny.one': '{n} image écartée : moins de {s} px',
    'n.tiny.other': '{n} images écartées : moins de {s} px',
    'n.skipped.one': '{n} fichier ignoré (format ou lecture)',
    'n.skipped.other': '{n} fichiers ignorés (format ou lecture)',
    'n.few': 'Moins de {n} images : le résultat peut être fragile.',
    'n.missingDir': 'Dossier introuvable : {path}',
    'n.missingFile': 'Fichier introuvable : {path}',
    'go.start': 'Lancer l’entraînement',
    'go.estimate': '≈ {d} · FIN VERS {h} SI LANCÉ MAINTENANT',
    'go.delete': 'Supprimer le brouillon',
    'go.deleteTitle': 'Supprimer le brouillon {name} ?',
    'go.deleteBody': 'Son dossier va à la corbeille. Tes images d’origine ne sont pas touchées.',
    'go.deleteOk': 'Supprimer',
    'by.prepared': 'PRÉPARÉ PAR {name}',
    'prop.start': '{name} PROPOSE DE LANCER CET ENTRAÎNEMENT',
    'prop.resume': '{name} PROPOSE DE REPRENDRE AU PAS {a}',
    'prop.decline': 'Refuser',
    'prop.go': 'Lancer',
    'prop.goResume': 'Reprendre',
    // the instrument
    'a.images.one': '{n} IMAGE',
    'a.images.other': '{n} IMAGES',
    'a.suggested': 'PROPOSÉ PAR {name}',
    'a.startedYou': 'LANCÉ PAR TOI',
    'a.startedBy': 'LANCÉ PAR {name}',
    'a.watching': '{name} REGARDE · {ago}',
    'ago.now': 'À L’INSTANT',
    'ago.min': 'IL Y A {n} MIN',
    'ago.hour': 'IL Y A {n} H',
    'c.waitGpu': 'ATTENTE DU GPU',
    'c.heldBy': 'PRIS PAR « {who} » DEPUIS {h}',
    'c.miaJob': 'UN CALCUL DE MIA SE TERMINE',
    'c.check': 'VÉRIFICATION DU JEU',
    'c.encode': 'ENCODAGE DES IMAGES {n} / {of}',
    'c.encode0': 'ENCODAGE DES IMAGES',
    'c.load': 'CHARGEMENT DU MODÈLE',
    'c.loadGB': 'CHARGEMENT DU MODÈLE · {g} GO',
    'c.loadSub': 'Mia peut ralentir pendant 3 à 5 minutes.',
    'c.loadSubKnown': 'Mia peut ralentir pendant environ {d}.',
    'c.train': 'ENTRAÎNEMENT',
    'c.step': 'PAS {a} / {b}',
    'c.left': 'RESTE {d}',
    'c.ends': 'FIN VERS {h}',
    'c.lastStep': 'DERNIER PAS IL Y A {d}',
    'c.silent': 'SANS NOUVELLE DEPUIS {n} MIN · ARRÊT AUTOMATIQUE À {m} MIN',
    'c.sample': 'ESSAI DU PAS {a} · ÉTAPE {n} / {t} DU RENDU',
    'c.sample0': 'ESSAI DU PAS {a}',
    'c.samplePrompt': ' · CONSIGNE {i} / {of}',
    'c.resumesIn': 'REPREND DANS ≈ {d}',
    'c.pauseAfter': 'PAUSE APRÈS L’ESSAI',
    'c.stopAfter': 'ARRÊT APRÈS L’ESSAI',
    'c.writing': 'ÉCRITURE DU POINT DE CONTRÔLE…',
    'c.paused': 'EN PAUSE AU PAS {a} · GPU RENDU · NE REPREND PAS SEUL',
    'c.pausedPass.one': 'EN PAUSE · REPREND APRÈS {n} CALCUL',
    'c.pausedPass.other': 'EN PAUSE · REPREND APRÈS {n} CALCULS',
    'c.pausedDisk': 'EN PAUSE AU PAS {a}',
    'c.diskSub': 'Disque presque plein : {b} Go libres. Libère de la place puis Reprendre.',
    'c.diskSubNoSize': 'Disque presque plein. Libère de la place puis Reprendre.',
    'c.done': 'FINI · {b} PAS · {d}',
    'c.doneNoTime': 'FINI · {b} PAS',
    'c.error': 'ERREUR AU PAS {a}',
    'c.stopped.zero': 'ARRÊTÉ AU PAS {a} · AUCUN POINT DE CONTRÔLE SUR LE DISQUE',
    'c.stopped.one': 'ARRÊTÉ AU PAS {a} · {n} POINT DE CONTRÔLE SUR LE DISQUE',
    'c.stopped.other': 'ARRÊTÉ AU PAS {a} · {n} POINTS DE CONTRÔLE SUR LE DISQUE',
    'c.interrupted': 'INTERROMPU AU PAS {a}',
    'c.missing': 'DOSSIER INTROUVABLE',
    'p.loss': 'PERTE',
    'p.mean': '{v} MOY. 100 PAS',
    'p.lossHelp': 'La perte saute d’un pas à l’autre : regarde la tendance, et surtout les essais.',
    'p.hover': 'PAS {a} · PERTE {v} · À {h}',
    'p.hoverNoTime': 'PAS {a} · PERTE {v}',
    'p.samples': 'ESSAIS',
    'p.sampleCap': 'PAS {a}',
    'p.noSample': 'Aucun essai pour l’instant.',
    'p.noSamplePlanned': 'Aucun essai prévu pendant cet entraînement.',
    'p.newSample': 'Nouvel essai',
    'p.pace': 'CADENCE',
    'p.paceV': '{x} S / PAS',
    'p.gpu': 'MÉMOIRE GPU',
    'p.gpuV': '{u} / {t} GO',
    'p.peak': 'PIC {p}',
    'p.ram': 'MÉMOIRE RAM',
    'p.ramV': '{n} GO LIBRES / {t}',
    'p.ramLoad': '{n} GO LIBRES · NORMAL PENDANT LE CHARGEMENT',
    'p.elapsed': 'ÉCOULÉ',
    'p.elapsedV': '{d} · DÉMARRÉ À {h}',
    'p.checkpoints': 'POINTS DE CONTRÔLE',
    'p.noCheckpoint': 'Aucun point de contrôle pour l’instant.',
    'p.ckAt': 'À {h}',
    'p.mb': '{n} MO',
    'p.add': 'Mettre dans Mes LoRA',
    'p.added': 'DANS MES LORA',
    'p.reveal': 'Afficher dans l’Explorateur',
    'p.copy': 'Copier le chemin',
    'p.copied': 'Chemin copié',
    'p.unfile': 'Retirer de Mes LoRA',
    'p.events': 'ÉVÈNEMENTS',
    'p.all': 'Tout',
    'p.mia': 'Mia',
    'done.filed': '{name} est dans Mes LoRA · {base} · mot déclencheur « {trigger} »',
    'done.try': 'Essayer sur une planche',
    'done.testBoard': 'Essai {name}',
    'done.notFiled': '{name} n’a pas pu être rangé dans Mes LoRA. {reason}',
    'done.retry': 'Mettre dans Mes LoRA',
    'b.pause': 'Pause',
    'b.stop': 'Arrêter…',
    'b.stopNow': 'Arrêter sans attendre',
    'b.resume': 'Reprendre',
    'b.resumeNow': 'Reprendre maintenant',
    'b.resumeFrom': 'Reprendre depuis le pas {a}',
    'b.restart': 'Relancer depuis le début',
    'b.resumeHint': 'le modèle se recharge, quelques minutes',
    'b.otherActive': 'Un autre entraînement est en cours',
    'b.log': 'Journal de l’outil',
    'b.showLog': 'Voir le journal de l’outil',
    'b.folder': 'Dossier',
    'b.trash': 'Mettre à la corbeille',
    'b.closeLog': 'Fermer',
    'b.logEmpty': 'Le journal est vide.',
    'b.waiting.one': '{n} calcul attend le GPU',
    'b.waiting.other': '{n} calculs attendent le GPU',
    'b.pass': 'Laisser passer',
    'stop.title': 'Arrêter l’entraînement de {name} au pas {a} ?',
    'stop.body': 'Un point de contrôle est écrit ; tu pourras reprendre.',
    'stop.sample': 'L’arrêt se fait à la fin de l’essai (≈ {d}).',
    'stop.sampleNoTime': 'L’arrêt se fait à la fin de l’essai.',
    'stop.titleNow': 'Arrêter l’entraînement de {name} ?',
    'stop.keep': 'Continuer',
    'stop.ok': 'Arrêter',
    // one line of ÉVÈNEMENTS
    'ev.check': 'Vérification du jeu',
    'ev.encodedNoTime': 'Images encodées',
    'ev.encoded': 'Images encodées ({d})',
    'ev.loaded': 'Modèle chargé',
    'ev.loadedIn': 'Modèle chargé ({d})',
    'ev.checkpoint': 'Point de contrôle {a}',
    'ev.sample': 'Essai {a}',
    'ev.sampleIn': 'Essai {a} ({d})',
    'ev.resumed': 'Reprise au pas {a}',
    'ev.stoppedSaved': 'Arrêt au pas {a}, point de contrôle écrit',
    'ev.stopped': 'Arrêt au pas {a}',
    'ev.pausedSaved': 'Pause au pas {a}, point de contrôle écrit',
    'ev.paused': 'Pause au pas {a}',
    'ev.done': 'Terminé au pas {a}',
    'ev.error': 'Erreur : {m}',
    'ev.errorAt': 'Erreur au pas {a} : {m}',
    // what went wrong, in a word for ÉVÈNEMENTS (the tool’s own words stay in its log)
    'err.oom': 'Mémoire GPU pleine.',
    'err.ram': 'Mémoire Windows insuffisante pendant le chargement.',
    'err.disk': 'Disque plein.',
    'err.missing': 'Un fichier de poids est introuvable.',
    'err.resume': 'La reprise a été refusée par l’outil : rien n’a été écrasé.',
    'err.hang': 'L’outil ne répondait plus.',
    'err.takeover': 'L’outil n’a pas pris le pilotage de Mia.',
    'err.version': 'Version de l’outil LTX non reconnue.',
    'err.spawn': 'Impossible de lancer l’outil.',
    'err.toolCode': 'L’outil s’est arrêté (code {c}).',
    'err.tool': 'L’outil a signalé une erreur.',
    // … and the whole explanation, under line C (after the sentence of the case)
    'why.oom': 'L’outil a demandé plus de mémoire que la carte n’en avait de libre. Ferme ce qui occupe le GPU, puis reprends ; si cela recommence, duplique-le en brouillon et baisse le rang ou les tailles d’image.',
    'why.ram': 'Le modèle n’a pas tenu dans la mémoire de Windows. Ferme des applications ou agrandis le fichier d’échange, puis reprends.',
    'why.disk': 'L’outil n’a plus pu écrire dans le dossier de l’entraînement. Libère de la place, puis reprends.',
    'why.missing': 'Vérifie que les poids du modèle sont installés, puis reprends.',
    'why.resume': 'L’outil serait reparti du pas 0 au lieu du point de contrôle : Mia l’a arrêté avant le premier pas.',
    'why.hang': 'Mia l’a arrêté ; ce qu’il a écrit en dernier est dans son journal.',
    'why.takeover': 'Sans ce pilotage, ni la pause ni l’arrêt ne marcheraient : Mia l’a arrêté au départ.',
    'why.version': 'Mia ne pilote que la version validée de l’outil.',
    'why.spawn': 'Vérifie que l’outil d’entraînement est installé (Réglages → Entraînement).',
    'why.tool': 'Ses dernières lignes sont dans le journal de l’outil.',
    'ev.act.start': 'Lancement',
    'ev.act.resume': 'Reprise demandée',
    'ev.act.pause': 'Pause demandée',
    'ev.act.pass': 'Laisser passer',
    'ev.act.beside': 'Calcul à côté : {t}',
    'ev.act.stop': 'Arrêt demandé',
    'ev.act.add': 'Pas {a} mis dans Mes LoRA',
    'ev.act.remove': 'Pas {a} retiré de Mes LoRA',
    'ev.by': '{name} : {text}',
    'ev.none': 'Rien pour l’instant.',
    'err.failed': 'Mia n’a pas pu faire cela : {why}',
    'err.unknown': 'raison inconnue',
    'err.noTrain': 'L’entraînement de LoRA n’est pas disponible dans cette Mia.',
    'try.noBoard': 'La planche n’a pas pu s’ouvrir.'
  },
  en: {
    'train.title': 'Trainings',
    'train.new': 'New LoRA',
    'train.back': '‹ Back to {name}',
    'train.home': '‹ Home',
    'train.crumb': '‹ Trainings',
    'train.untitled': 'New LoRA',
    'train.you': 'YOU',
    'chip.rest': 'TRAIN',
    'chip.restTip': 'Train a LoRA',
    'chip.run': 'LORA · {name} {pct}',
    'chip.state': 'LORA · {name} · {state}',
    'chip.gpu': 'GPU BUSY',
    'chip.prep': 'PREPARING',
    'chip.sample': 'SAMPLE',
    'chip.paused': 'PAUSED',
    'chip.done': 'DONE',
    'chip.error': 'ERROR',
    'chip.proposal.one': '{n} PROPOSAL',
    'chip.proposal.other': '{n} PROPOSALS',
    'chip.tip': '{name} · {base} · step {a} / {b}',
    'chip.tipEnd': ' · ends around {h}',
    'list.empty': 'No training yet. Drop a folder of images here to start.',
    'list.drop': 'Drop here: a new LoRA is created with these images.',
    'row.draft': 'DRAFT',
    'row.waiting': 'WAITING FOR GPU',
    'row.running': 'RUNNING {pct}',
    'row.paused': 'PAUSED · {a}',
    'row.done': 'DONE · {b} STEPS',
    'row.stopped': 'STOPPED · {a}',
    'row.interrupted': 'INTERRUPTED · {a}',
    'row.error': 'ERROR',
    'row.missing': 'MISSING',
    'row.locate': 'Locate folder…',
    'row.unseen': 'Result not opened yet',
    'menu.open': 'Open folder',
    'menu.duplicate': 'Duplicate as draft',
    'menu.trash': 'Move to Recycle Bin',
    'trash.title': 'Move the training {name} ({size}) to the Recycle Bin?',
    'trash.body': 'The LoRAs already in My LoRAs stay.',
    'trash.ok': 'Move to Recycle Bin',
    'kind.character': 'Character',
    'kind.place': 'Place',
    'kind.style': 'Style',
    'media.video': 'video',
    'media.image': 'image',
    'f.name': 'NAME',
    'f.model': 'MODEL',
    'f.kind': 'KIND',
    'f.trigger': 'TRIGGER WORD',
    'f.triggerHint': 'A rare word that will call this LoRA, e.g. “rsa woman”.',
    'f.length': 'LENGTH',
    'f.short': 'Short',
    'f.normal': 'Normal',
    'f.long': 'Long',
    'f.steps': 'STEPS',
    'f.estimate': '≈ {d} · GPU ≈ {g} GB',
    'f.estimateNoGpu': '≈ {d}',
    'f.unknown': 'UNKNOWN LENGTH: MEASURED AFTER THE FIRST 20 STEPS',
    'f.prompt': 'SAMPLE PROMPT',
    'f.sampleEvery': 'a sample every {n} steps',
    'f.noSample': 'no sample during the training',
    'f.advanced': 'Advanced',
    'f.rank': 'Rank',
    'f.lr': 'Learning rate',
    'f.sizes': 'Image sizes',
    'f.saveEvery': 'A checkpoint every N steps',
    'f.sampleEveryN': 'A sample every N steps',
    'f.none': 'none',
    'f.morePrompts': 'More sample prompts',
    'f.addPrompt': 'Add a prompt',
    'img.title': 'IMAGES',
    'img.count.one': '{n} image',
    'img.count.other': '{n} images',
    'img.caps.one': '{n} caption',
    'img.caps.other': '{n} captions',
    'img.empty': 'Drop images or a folder. A .txt with the same name = the caption.',
    'img.import': 'IMPORT {n} / {total}',
    'img.remove': 'Remove from set',
    'img.noCaption': 'No caption',
    'img.small': 'Too small: {w} × {h} px',
    'cap.title': 'CAPTION',
    'cap.by': 'WRITTEN BY {name}',
    'cap.help': 'The trigger word is added in front of every caption: no need to write it.',
    'cap.pick': 'Click an image to read or write its caption.',
    'n.noCaption.one': '{n} image without a caption',
    'n.noCaption.other': '{n} images without a caption',
    'n.triggerOnly': 'Trigger word only',
    'n.small.one': '{n} image too small',
    'n.small.other': '{n} images too small',
    'n.removeSmall': 'Remove these images',
    'n.showAll': 'Show all',
    'n.tiny.one': '{n} image left out: under {s} px',
    'n.tiny.other': '{n} images left out: under {s} px',
    'n.skipped.one': '{n} file skipped (format or unreadable)',
    'n.skipped.other': '{n} files skipped (format or unreadable)',
    'n.few': 'Fewer than {n} images: the result may be fragile.',
    'n.missingDir': 'Folder not found: {path}',
    'n.missingFile': 'File not found: {path}',
    'go.start': 'Start training',
    'go.estimate': '≈ {d} · ENDS AROUND {h} IF STARTED NOW',
    'go.delete': 'Delete draft',
    'go.deleteTitle': 'Delete the draft {name}?',
    'go.deleteBody': 'Its folder goes to the Recycle Bin. Your original images are not touched.',
    'go.deleteOk': 'Delete',
    'by.prepared': 'PREPARED BY {name}',
    'prop.start': '{name} SUGGESTS STARTING THIS TRAINING',
    'prop.resume': '{name} SUGGESTS RESUMING AT STEP {a}',
    'prop.decline': 'Decline',
    'prop.go': 'Start',
    'prop.goResume': 'Resume',
    'a.images.one': '{n} IMAGE',
    'a.images.other': '{n} IMAGES',
    'a.suggested': 'SUGGESTED BY {name}',
    'a.startedYou': 'STARTED BY YOU',
    'a.startedBy': 'STARTED BY {name}',
    'a.watching': '{name} IS WATCHING · {ago}',
    'ago.now': 'JUST NOW',
    'ago.min': '{n} MIN AGO',
    'ago.hour': '{n} H AGO',
    'c.waitGpu': 'WAITING FOR THE GPU',
    'c.heldBy': 'HELD BY “{who}” SINCE {h}',
    'c.miaJob': 'A MIA JOB IS FINISHING',
    'c.check': 'CHECKING THE SET',
    'c.encode': 'ENCODING IMAGES {n} / {of}',
    'c.encode0': 'ENCODING IMAGES',
    'c.load': 'LOADING THE MODEL',
    'c.loadGB': 'LOADING THE MODEL · {g} GB',
    'c.loadSub': 'Mia may slow down for 3 to 5 minutes.',
    'c.loadSubKnown': 'Mia may slow down for about {d}.',
    'c.train': 'TRAINING',
    'c.step': 'STEP {a} / {b}',
    'c.left': '{d} LEFT',
    'c.ends': 'ENDS AROUND {h}',
    'c.lastStep': 'LAST STEP {d} AGO',
    'c.silent': 'NO NEWS FOR {n} MIN · AUTOMATIC STOP AT {m} MIN',
    'c.sample': 'SAMPLE AT STEP {a} · RENDER STEP {n} / {t}',
    'c.sample0': 'SAMPLE AT STEP {a}',
    'c.samplePrompt': ' · PROMPT {i} / {of}',
    'c.resumesIn': 'RESUMES IN ≈ {d}',
    'c.pauseAfter': 'PAUSE AFTER THE SAMPLE',
    'c.stopAfter': 'STOP AFTER THE SAMPLE',
    'c.writing': 'WRITING THE CHECKPOINT…',
    'c.paused': 'PAUSED AT STEP {a} · GPU RELEASED · DOES NOT RESUME BY ITSELF',
    'c.pausedPass.one': 'PAUSED · RESUMES AFTER {n} JOB',
    'c.pausedPass.other': 'PAUSED · RESUMES AFTER {n} JOBS',
    'c.pausedDisk': 'PAUSED AT STEP {a}',
    'c.diskSub': 'Disk almost full: {b} GB free. Free some space, then Resume.',
    'c.diskSubNoSize': 'Disk almost full. Free some space, then Resume.',
    'c.done': 'DONE · {b} STEPS · {d}',
    'c.doneNoTime': 'DONE · {b} STEPS',
    'c.error': 'ERROR AT STEP {a}',
    'c.stopped.zero': 'STOPPED AT STEP {a} · NO CHECKPOINT ON DISK',
    'c.stopped.one': 'STOPPED AT STEP {a} · {n} CHECKPOINT ON DISK',
    'c.stopped.other': 'STOPPED AT STEP {a} · {n} CHECKPOINTS ON DISK',
    'c.interrupted': 'INTERRUPTED AT STEP {a}',
    'c.missing': 'FOLDER NOT FOUND',
    'p.loss': 'LOSS',
    'p.mean': '{v} 100-STEP MEAN',
    'p.lossHelp': 'Loss jumps from step to step: watch the trend, and above all the samples.',
    'p.hover': 'STEP {a} · LOSS {v} · AT {h}',
    'p.hoverNoTime': 'STEP {a} · LOSS {v}',
    'p.samples': 'SAMPLES',
    'p.sampleCap': 'STEP {a}',
    'p.noSample': 'No sample yet.',
    'p.noSamplePlanned': 'No sample planned during this training.',
    'p.newSample': 'New sample',
    'p.pace': 'PACE',
    'p.paceV': '{x} S / STEP',
    'p.gpu': 'GPU MEMORY',
    'p.gpuV': '{u} / {t} GB',
    'p.peak': 'PEAK {p}',
    'p.ram': 'RAM',
    'p.ramV': '{n} GB FREE / {t}',
    'p.ramLoad': '{n} GB FREE · NORMAL WHILE LOADING',
    'p.elapsed': 'ELAPSED',
    'p.elapsedV': '{d} · STARTED AT {h}',
    'p.checkpoints': 'CHECKPOINTS',
    'p.noCheckpoint': 'No checkpoint yet.',
    'p.ckAt': 'AT {h}',
    'p.mb': '{n} MB',
    'p.add': 'Add to My LoRAs',
    'p.added': 'IN MY LORAS',
    'p.reveal': 'Show in Explorer',
    'p.copy': 'Copy path',
    'p.copied': 'Path copied',
    'p.unfile': 'Remove from My LoRAs',
    'p.events': 'EVENTS',
    'p.all': 'All',
    'p.mia': 'Mia',
    'done.filed': '{name} is in My LoRAs · {base} · trigger word “{trigger}”',
    'done.try': 'Try it on a board',
    'done.testBoard': '{name} test',
    'done.notFiled': '{name} could not be filed in My LoRAs. {reason}',
    'done.retry': 'Add to My LoRAs',
    'b.pause': 'Pause',
    'b.stop': 'Stop…',
    'b.stopNow': 'Stop without waiting',
    'b.resume': 'Resume',
    'b.resumeNow': 'Resume now',
    'b.resumeFrom': 'Resume from step {a}',
    'b.restart': 'Restart from the beginning',
    'b.resumeHint': 'the model reloads, a few minutes',
    'b.otherActive': 'Another training is running',
    'b.log': 'Tool log',
    'b.showLog': 'Show tool log',
    'b.folder': 'Folder',
    'b.trash': 'Move to Recycle Bin',
    'b.closeLog': 'Close',
    'b.logEmpty': 'The log is empty.',
    'b.waiting.one': '{n} job is waiting for the GPU',
    'b.waiting.other': '{n} jobs are waiting for the GPU',
    'b.pass': 'Let it through',
    'stop.title': 'Stop training {name} at step {a}?',
    'stop.body': 'A checkpoint is written; you can resume.',
    'stop.sample': 'It stops when the sample ends (≈ {d}).',
    'stop.sampleNoTime': 'It stops when the sample ends.',
    'stop.titleNow': 'Stop training {name}?',
    'stop.keep': 'Keep training',
    'stop.ok': 'Stop',
    'ev.check': 'Checking the set',
    'ev.encodedNoTime': 'Images encoded',
    'ev.encoded': 'Images encoded ({d})',
    'ev.loaded': 'Model loaded',
    'ev.loadedIn': 'Model loaded ({d})',
    'ev.checkpoint': 'Checkpoint {a}',
    'ev.sample': 'Sample {a}',
    'ev.sampleIn': 'Sample {a} ({d})',
    'ev.resumed': 'Resumed at step {a}',
    'ev.stoppedSaved': 'Stopped at step {a}, checkpoint written',
    'ev.stopped': 'Stopped at step {a}',
    'ev.pausedSaved': 'Paused at step {a}, checkpoint written',
    'ev.paused': 'Paused at step {a}',
    'ev.done': 'Finished at step {a}',
    'ev.error': 'Error: {m}',
    'ev.errorAt': 'Error at step {a}: {m}',
    'err.oom': 'GPU memory full.',
    'err.ram': 'Not enough Windows memory while loading.',
    'err.disk': 'Disk full.',
    'err.missing': 'A weights file was not found.',
    'err.resume': 'The tool refused to resume: nothing was overwritten.',
    'err.hang': 'The tool had stopped responding.',
    'err.takeover': 'The tool did not take Mia’s control.',
    'err.version': 'Unrecognised LTX tool version.',
    'err.spawn': 'Could not start the tool.',
    'err.toolCode': 'The tool stopped (code {c}).',
    'err.tool': 'The tool reported an error.',
    'why.oom': 'The tool asked for more memory than the card had free. Close what is using the GPU, then resume; if it happens again, duplicate it as a draft and lower the rank or the image sizes.',
    'why.ram': 'The model did not fit in Windows memory. Close applications or enlarge the page file, then resume.',
    'why.disk': 'The tool could no longer write in the training folder. Free some space, then resume.',
    'why.missing': 'Check that the model weights are installed, then resume.',
    'why.resume': 'The tool would have started again from step 0 instead of the checkpoint: Mia stopped it before the first step.',
    'why.hang': 'Mia stopped it; what it wrote last is in its log.',
    'why.takeover': 'Without that control, neither pause nor stop would work: Mia stopped it at the start.',
    'why.version': 'Mia only drives the validated version of the tool.',
    'why.spawn': 'Check that the training tool is installed (Settings → Training).',
    'why.tool': 'Its last lines are in the tool log.',
    'ev.act.start': 'Started',
    'ev.act.resume': 'Resume asked',
    'ev.act.pause': 'Pause asked',
    'ev.act.pass': 'Let a job through',
    'ev.act.beside': 'Job alongside: {t}',
    'ev.act.stop': 'Stop asked',
    'ev.act.add': 'Step {a} added to My LoRAs',
    'ev.act.remove': 'Step {a} removed from My LoRAs',
    'ev.by': '{name}: {text}',
    'ev.none': 'Nothing yet.',
    'err.failed': 'Mia could not do that: {why}',
    'err.unknown': 'unknown reason',
    'err.noTrain': 'LoRA training is not available in this Mia.',
    'try.noBoard': 'The board could not open.'
  }
};

const NBSP = ' ';
const fill = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k]))) : String(s));
const lg = (L) => (L === 'en' ? 'en' : 'fr');

/** A string of the table. Unknown key → the key (a missing word shows, it does not hide). */
export function tx(L, key, vars) {
  const s = STRINGS[lg(L)][key] ?? STRINGS.fr[key];
  return s === undefined ? key : fill(s, vars);
}

/** Plural: `key.one` / `key.other` (and `key.zero` when it exists). {n} is the number, written for the language. */
export function txn(L, key, n, vars) {
  const v = Number(n) || 0;
  const table = STRINGS[lg(L)];
  const cat = v === 0 && table[`${key}.zero`] !== undefined ? 'zero' : (lg(L) === 'fr' ? (v < 2 ? 'one' : 'other') : (v === 1 ? 'one' : 'other'));
  return tx(L, `${key}.${cat}`, { n: int(L, v), ...(vars || {}) });
}

/** 1240 → « 1 240 » / “1,240”. Steps never have a leading zero. */
export function int(L, n) {
  return Math.round(Number(n) || 0).toLocaleString(lg(L) === 'en' ? 'en-US' : 'fr-FR').replace(/[  ]/g, NBSP);
}

/** 0.4123 → « 0,412 » / “0.412”. */
export function dec(L, n, digits = 1) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString(lg(L) === 'en' ? 'en-US' : 'fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace(/[  ]/g, NBSP);
}

/** A share 0…1 → « 49 % » / “49%”. */
export function pct(L, p, digits = 0) {
  const v = Math.max(0, Math.min(1, Number(p) || 0)) * 100;
  const n = digits ? dec(L, Math.floor(v * 10 ** digits) / 10 ** digits, digits) : String(Math.floor(v));
  return lg(L) === 'fr' ? `${n}${NBSP}%` : `${n}%`;
}

/** A time of day: « 3 h 40 » / “03:40” (the same writing as util.fmtClock). */
export function clock(L, ms) {
  const d = new Date(Number(ms) || 0);
  const mm = String(d.getMinutes()).padStart(2, '0');
  return lg(L) === 'fr' ? `${d.getHours()} h ${mm}` : `${String(d.getHours()).padStart(2, '0')}:${mm}`;
}

/** « 22:10 » (the text kept in the GPU lock) → the same time of day, written for the language. */
export function clockText(L, hhmm) {
  const m = /^(\d{1,2})[:hH ]+(\d{2})/.exec(String(hhmm || '').trim());
  if (!m) return String(hhmm || '');
  return lg(L) === 'fr' ? `${+m[1]} h ${m[2]}` : `${m[1].padStart(2, '0')}:${m[2]}`;
}

/** A length in seconds: « 45 s », « 1 min 20 s », « 12 min », « 2 h 04 min » — the same in both languages. */
export function dur(seconds, { secs = true } = {}) {
  let s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return secs ? `${s} s` : '1 min';
  const h = Math.floor(s / 3600);
  if (h) {
    const m = Math.round((s - h * 3600) / 60);
    return m === 60 ? `${h + 1} h 00 min` : `${h} h ${String(m).padStart(2, '0')} min`;
  }
  if (!secs || s >= 600) return `${Math.round(s / 60)} min`;
  const m = Math.floor(s / 60);
  s -= m * 60;
  return s ? `${m} min ${String(s).padStart(2, '0')} s` : `${m} min`;
}

/** The same, the way an event writes it: « 2 min 08 », « 45 s ». */
export function durShort(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s} s`;
  if (s >= 3600) return dur(s);
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`;
}

/** The date of a row of the list: « 19/11 · 23 h 31 ». */
export function dateShort(L, ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} · ${clock(L, ms)}`;
}

/** A size given in MB: « 320 KO », « 327 MO », « 5,2 GO » in a MONO CAPS zone; caps false for a sentence (« 5,2 Go »).
 *  Under 1 MB it is counted in kB (a draft of a few images, a test checkpoint): never « 0 MO » for something there. */
export function size(L, mb, caps = true) {
  const v = Number(mb);
  if (!Number.isFinite(v) || v < 0) return '';
  const u = lg(L) === 'fr' ? (caps ? ['KO', 'MO', 'GO'] : ['Ko', 'Mo', 'Go']) : ['KB', 'MB', 'GB'];
  if (v < 1) return `${int(L, Math.max(v > 0 ? 1 : 0, Math.round(v * 1024)))} ${u[0]}`;
  if (v < 1000) return `${int(L, Math.round(v))} ${u[1]}`;
  return `${dec(L, v / 1024, 1)} ${u[2]}`;
}

/** A name in the chip: 14 characters, then « … ». */
export function cutName(name, max = 14) {
  const chars = [...String(name || '').trim()];
  return chars.length > max ? `${chars.slice(0, max).join('').trimEnd()}…` : chars.join('');
}

/** Who did something: the user is « TOI » / “YOU”, an assistant keeps its name. */
export const who = (L, by) => (!by || by === 'user' ? tx(L, 'train.you') : String(by));
const isUser = (by) => !by || by === 'user';

export const ACTIVE_STATES = ['attente', 'preparation', 'entrainement', 'essai'];
/** Active = waiting, preparing, training, sampling — and a pause that resumes by itself (« Laisser passer »). */
export const isActive = (s) => !!s && !s.missing && (ACTIVE_STATES.includes(s.state) || (s.state === 'pause' && s.pause && s.pause.reason === 'pass'));
export const isDraft = (s) => !!s && s.state === 'pret';
/** Something computes right now (preparing, training, sampling): the only time the accent marks the current step. */
export const computing = (s) => !!s && !s.missing && ['preparation', 'entrainement', 'essai'].includes(s.state);

const baseName = (L, bases, id) => {
  const b = (bases || []).find((x) => x.id === id);
  const label = b && b.label;
  return (label && (typeof label === 'string' ? label : (label[lg(L)] || label.fr))) || String(id || '').toUpperCase();
};
export { baseName as baseLabel };

/**
 * The chip of the title bar. list: the rows of train:list; bases: train:options().bases (for the model's name).
 * → { text, tip, id (the training a click opens, or null), state: 'rest'|'run'|'wait'|'paused'|'done'|'error'|'proposal',
 *     progress (0…1 while the gauge shows, else null), error }
 * Priority: an error not seen yet, then what runs (a « Laisser passer » pause included, with the count of
 * suggestions), then « FINI » not seen, then a pause that does not resume by itself (manual, disk), then suggestions.
 */
export function chipModel(L, list, bases) {
  const rows = (list || []).filter((s) => s && !s.missing);
  const proposals = rows.filter((s) => s.proposal).length;
  const prop = proposals ? txn(L, 'chip.proposal', proposals) : '';
  const tip = (s) => tx(L, 'chip.tip', { name: s.name || tx(L, 'train.untitled'), base: baseName(L, bases, s.base), a: int(L, s.step), b: int(L, s.steps) })
    + (s.endAt ? tx(L, 'chip.tipEnd', { h: clock(L, s.endAt) }) : '');
  const name = (s) => cutName(s.name || tx(L, 'train.untitled')).toUpperCase();
  const st = (s, key) => tx(L, 'chip.state', { name: name(s), state: tx(L, key) });
  const newest = (a, b) => (b.endedAt || b.at || 0) - (a.endedAt || a.at || 0);

  const bad = rows.filter((s) => (s.state === 'erreur' || s.state === 'interrompu') && s.seen === false).sort(newest)[0];
  if (bad) return { text: st(bad, 'chip.error'), tip: tip(bad), id: bad.id, state: 'error', progress: null, error: true };

  const act = rows.find(isActive);
  if (act) {
    let text;
    let state = 'run';
    let progress = null;
    if (act.state === 'attente') { text = st(act, 'chip.gpu'); state = 'wait'; }
    else if (act.state === 'preparation') { text = st(act, 'chip.prep'); progress = 0; }
    else if (act.state === 'essai') { text = st(act, 'chip.sample'); progress = act.progress || 0; }
    else if (act.state === 'pause') { text = st(act, 'chip.paused'); state = 'paused'; }
    else { text = tx(L, 'chip.run', { name: name(act), pct: pct(L, act.progress) }); progress = act.progress || 0; }
    if (prop) text += ` · ${prop}`;
    return { text, tip: tip(act), id: act.id, state, progress, error: false };
  }

  const done = rows.filter((s) => s.state === 'fini' && s.seen === false).sort(newest)[0];
  if (done) return { text: st(done, 'chip.done'), tip: tip(done), id: done.id, state: 'done', progress: null, error: false };

  // a manual (or disk) pause is not active: another training may have run and finished meanwhile — its « FINI » first
  const held = rows.filter((s) => s.state === 'pause').sort(newest)[0];
  if (held) return { text: st(held, 'chip.paused') + (prop ? ` · ${prop}` : ''), tip: tip(held), id: held.id, state: 'paused', progress: null, error: false };

  if (proposals) {
    const p = rows.filter((s) => s.proposal).sort((a, b) => (b.proposal.at || 0) - (a.proposal.at || 0))[0];
    return { text: `LORA · ${prop}`, tip: tip(p), id: proposals === 1 ? p.id : null, state: 'proposal', progress: null, error: false };
  }
  return { text: tx(L, 'chip.rest'), tip: tx(L, 'chip.restTip'), id: null, state: 'rest', progress: null, error: false };
}

/** The state of a row of the list. */
export function rowState(L, s) {
  if (!s) return '';
  if (s.missing) return tx(L, 'row.missing');
  switch (s.state) {
    case 'pret': return tx(L, 'row.draft');
    case 'attente': return tx(L, 'row.waiting');
    case 'preparation':
    case 'entrainement':
    case 'essai': return tx(L, 'row.running', { pct: pct(L, s.progress) });
    case 'pause': return tx(L, 'row.paused', { a: int(L, s.step) });
    case 'fini': return tx(L, 'row.done', { b: int(L, s.steps) });
    case 'annule': return tx(L, 'row.stopped', { a: int(L, s.step) });
    case 'interrompu': return tx(L, 'row.interrupted', { a: int(L, s.step) });
    case 'erreur': return tx(L, 'row.error');
    default: return String(s.state || '').toUpperCase();
  }
}

/** The step a resume would start from: the last checkpoint on the record (the main process checks the file itself). */
export function resumeStep(s) {
  const steps = ((s && s.checkpoints) || []).map((c) => +c.step).filter(Number.isFinite);
  return steps.length ? Math.max(...steps) : 0;
}

/**
 * Line C of the instrument, and what moves on bar B.
 * ctx: { now, lastNewsS (seconds since the tool's last news, counted on by the screen), loadGB, freeGB }
 * → { parts:[text…], sub: a sentence under the line | null, error: boolean,
 *     bar: 'none'|'indeterminate'|'progress'|'frozen'|'paused'|'full', progress: 0…1 }
 */
export function statusLine(L, s, ctx = {}) {
  const out = { parts: [], sub: null, error: false, bar: 'none', progress: Math.max(0, Math.min(1, +s.progress || 0)) };
  const a = int(L, s.step);
  const b = int(L, s.steps);
  if (s.missing) { out.parts = [tx(L, 'c.missing')]; return out; }
  const pending = s.pending || null;
  switch (s.state) {
    case 'attente': {
      const w = s.wait;
      out.parts = [tx(L, 'c.waitGpu')];
      if (w && w.who) out.parts.push(tx(L, 'c.heldBy', { who: String(w.who).replace(/^Mia\s*:\s*/, ''), h: clockText(L, w.since) }));
      else if (w) out.parts.push(tx(L, 'c.miaJob'));
      break;
    }
    case 'preparation':
      if (s.phase === 'encode') {
        const known = s.phaseOf > 0;
        out.parts = [known ? tx(L, 'c.encode', { n: int(L, s.phaseN), of: int(L, s.phaseOf) }) : tx(L, 'c.encode0')];
        out.bar = known ? 'progress' : 'indeterminate';
        out.progress = known ? Math.max(0, Math.min(1, s.phaseN / s.phaseOf)) : 0;
      } else if (s.phase === 'load') {
        out.parts = [ctx.loadGB ? tx(L, 'c.loadGB', { g: int(L, ctx.loadGB) }) : tx(L, 'c.load')];
        const known = s.measured && s.measured.loadSec > 0 ? s.measured.loadSec : 0;
        out.sub = known ? tx(L, 'c.loadSubKnown', { d: dur(known) }) : tx(L, 'c.loadSub');
        out.bar = 'indeterminate';
      } else {
        out.parts = [tx(L, 'c.check')];
        out.bar = 'indeterminate';
      }
      break;
    case 'entrainement': {
      out.parts = [tx(L, 'c.train'), tx(L, 'c.step', { a, b }), pct(L, s.progress, 1)];
      if (pending) out.parts.push(tx(L, 'c.writing'));
      else {
        if (s.eta && s.eta.seconds != null) out.parts.push(tx(L, 'c.left', { d: dur(s.eta.seconds, { secs: s.eta.seconds < 60 }).toUpperCase() }));
        if (s.eta && s.eta.endAt) out.parts.push(tx(L, 'c.ends', { h: clock(L, s.eta.endAt).toUpperCase() }));
        const news = ctx.lastNewsS != null ? ctx.lastNewsS : s.lastNewsS;
        if (s.silent) {
          out.parts.push(tx(L, 'c.silent', { n: int(L, Math.floor((news || 0) / 60)), m: int(L, Math.round((s.silentKillS || 0) / 60)) }));
        } else if (news != null) out.parts.push(tx(L, 'c.lastStep', { d: dur(news).toUpperCase() }));
      }
      out.bar = 'progress';
      break;
    }
    case 'essai': {
      const ss = s.sampleStep;
      let head = ss && ss.total > 0 ? tx(L, 'c.sample', { a, n: int(L, ss.n), t: int(L, ss.total) }) : tx(L, 'c.sample0', { a });
      if (ss && ss.of > 1) head += tx(L, 'c.samplePrompt', { i: int(L, ss.i), of: int(L, ss.of) });
      out.parts = [head, tx(L, 'c.step', { a, b })];
      if (pending) out.parts.push(tx(L, pending === 'pause' ? 'c.pauseAfter' : 'c.stopAfter'));
      else {
        // under a second there is nothing left to wait for: no « ≈ 0 S »
        const left = sampleLeft(s);
        if (left != null && left >= 1) out.parts.push(tx(L, 'c.resumesIn', { d: dur(left).toUpperCase() }));
      }
      out.bar = 'frozen';
      break;
    }
    case 'pause': {
      const reason = s.pause && s.pause.reason;
      out.bar = 'paused';
      if (reason === 'pass') out.parts = [txn(L, 'c.pausedPass', Math.max(1, +s.waitingJobs || 0))];
      else if (reason === 'disk') {
        out.parts = [tx(L, 'c.pausedDisk', { a })];
        out.sub = ctx.freeGB != null ? tx(L, 'c.diskSub', { b: dec(L, ctx.freeGB, 1) }) : tx(L, 'c.diskSubNoSize');
      } else out.parts = [tx(L, 'c.paused', { a })];
      break;
    }
    case 'fini': {
      const sec = s.startedAt && s.endedAt && s.endedAt > s.startedAt ? (s.endedAt - s.startedAt) / 1000 : null;
      out.parts = [sec != null ? tx(L, 'c.done', { b, d: dur(sec, { secs: sec < 60 }).toUpperCase() }) : tx(L, 'c.doneNoTime', { b })];
      out.bar = 'full';
      out.progress = 1;
      break;
    }
    case 'erreur':
      out.parts = [tx(L, 'c.error', { a })];
      out.sub = errorSentence(L, s.error);
      out.error = true;
      out.bar = 'paused';
      break;
    case 'annule':
      out.parts = [txn(L, 'c.stopped', (s.checkpoints || []).length, { a })];
      out.bar = 'paused';
      break;
    case 'interrompu':
      out.parts = [tx(L, 'c.interrupted', { a })];
      out.bar = 'paused';
      break;
    default:
      out.parts = [String(s.state || '').toUpperCase()];
  }
  return out;
}

/** Seconds left in the running sample, from its render step and the measured length of a sample; null when unknown. */
export function sampleLeft(s) {
  const ss = s && s.sampleStep;
  const one = s && s.measured && s.measured.sampleSec > 0 ? s.measured.sampleSec : 0;
  if (!one) return null;
  if (!ss || !(ss.total > 0)) return Math.round(one);
  const parts = Math.max(1, ss.of || 1);
  const done = ((ss.i || 1) - 1 + Math.min(1, ss.n / ss.total)) / parts;
  return Math.max(0, Math.round(one * parts * (1 - done)));
}

// ── what went wrong ─────────────────────────────────────────────────────
const ERR_CODES = ['oom', 'ram', 'disk', 'missing', 'resume', 'hang', 'takeover', 'version', 'spawn', 'tool'];
const errMessage = (L, err) => (err && err.message ? String(err.message[lg(L)] || err.message.fr || '') : '');
/** train.json.error → its code among ERR_CODES (« Impossible de lancer l’outil : … » is filed as `tool` by the main process). */
function errCode(L, err) {
  const c = String((err && err.code) || 'tool');
  if (c === 'tool' && /^(Impossible de lancer|Could not start)/.test(errMessage('fr', err) || errMessage('en', err))) return 'spawn';
  return ERR_CODES.includes(c) ? c : 'tool';
}

/**
 * Under line C, for an error: the sentence of the case (written by the main process, with its file name, its
 * code, its last line), then what it means and what to do. null when there is no error on record.
 */
export function errorSentence(L, err) {
  if (!err) return null;
  const code = errCode(L, err);
  const msg = (errMessage(L, err) || tx(L, `err.${code}`)).trim();
  // the tool’s last line rarely ends a sentence: a full stop before the explanation
  return `${/[.!?…»”)]$/.test(msg) ? msg : `${msg}.`} ${tx(L, `why.${code}`)}`;
}

/** The same error in one clean sentence, for ÉVÈNEMENTS: never the tool’s raw line (that one stays in its log). */
export function errorShort(L, err) {
  if (!err) return tx(L, 'err.tool');
  const code = errCode(L, err);
  const msg = errMessage(L, err);
  if (code === 'tool') {
    const c = /\(code ([^)]+)\)/.exec(msg);
    return c && c[1] !== '?' ? tx(L, 'err.toolCode', { c: c[1] }) : tx(L, 'err.tool');
  }
  if (code === 'spawn') return tx(L, 'err.spawn');
  // the sentences of these cases are clean, and some carry a useful detail (a file name, minutes, a step)
  return msg || tx(L, `err.${code}`);
}

/** An `error` line of events.jsonl (the tool’s own words in `message`) → a clean sentence. */
function errorOfEvent(L, ev) {
  const why = String(ev.why || '');
  const code = why === 'takeover' || why === 'version' ? why : String(ev.code || 'tool');
  return tx(L, `err.${ERR_CODES.includes(code) && code !== 'spawn' ? code : 'tool'}`);
}

/**
 * The buttons of row E for a state. ctx: { otherActive }
 * → [{ id, label, primary?, danger?, disabled?, why?, hint? }] with id among:
 *   pause · stop · stopNow · resume · resumeNow · trash · log
 */
export function actions(L, s, ctx = {}) {
  if (!s || s.missing) return [];
  const pending = s.pending || null;
  const from = resumeStep(s);
  const blocked = ctx.otherActive ? { disabled: true, why: tx(L, 'b.otherActive') } : {};
  const resumeFrom = { id: 'resume', label: from > 0 ? tx(L, 'b.resumeFrom', { a: int(L, from) }) : tx(L, 'b.restart'), ...blocked };
  switch (s.state) {
    case 'attente':
    case 'preparation':
      return [{ id: 'stop', label: tx(L, 'b.stop') }];
    case 'entrainement':
    case 'essai': {
      const list = [{ id: 'pause', label: tx(L, 'b.pause'), disabled: !!pending }, { id: 'stop', label: tx(L, 'b.stop'), disabled: pending === 'stop' || pending === 'quit' }];
      if (pending === 'stop' || pending === 'quit') list.push({ id: 'stopNow', label: tx(L, 'b.stopNow') });
      return list;
    }
    case 'pause':
      if (s.pause && s.pause.reason === 'pass') return [{ id: 'resumeNow', label: tx(L, 'b.resumeNow') }, { id: 'stop', label: tx(L, 'b.stop') }];
      return [{ id: 'resume', label: tx(L, 'b.resume'), hint: tx(L, 'b.resumeHint'), ...blocked }, { id: 'stop', label: tx(L, 'b.stop') }];
    case 'erreur':
      // « Reprendre » only when a checkpoint exists; without one, the only way on is from the beginning
      return [{ id: 'log', label: tx(L, 'b.showLog') }, resumeFrom];
    case 'annule':
      return [resumeFrom, { id: 'trash', label: tx(L, 'b.trash'), danger: true }];
    case 'interrompu':
      return [resumeFrom];
    default:
      return [];
  }
}

/** The sample tiles: one per planned sample step, done or to come. → [{step, files:[sample…], running, n, total}] */
export function sampleSlots(s) {
  const every = Math.max(0, Math.round(+((s.settings || {}).sampleEvery) || 0));
  const steps = new Set();
  if (every > 0) for (let k = every; k <= (+s.steps || 0); k += every) steps.add(k);
  for (const x of s.samples || []) steps.add(+x.step);
  return [...steps].filter((k) => Number.isFinite(k) && k > 0).sort((x, y) => x - y).map((step) => {
    const files = (s.samples || []).filter((x) => +x.step === step).sort((x, y) => (x.i || 1) - (y.i || 1));
    const running = s.state === 'essai' && +s.step === step && !files.length;
    return { step, files, running, n: running && s.sampleStep ? s.sampleStep.n : 0, total: running && s.sampleStep ? s.sampleStep.total : 0 };
  });
}

/**
 * The lines of ÉVÈNEMENTS, oldest first, in one order: what the tool wrote (events.jsonl), the error that ended the
 * training (in Mia’s words), and what Mia, the user or an assistant did or noted (train.json.notes).
 * → [{ at, text, by: null (Mia) | 'user' | name, note: boolean }]
 */
export function eventLines(L, s) {
  const out = [];
  const evs = s.events || [];
  const ckAt = new Map((s.checkpoints || []).map((c) => [+c.step, +c.at || 0]));
  const smAt = new Map((s.samples || []).map((x) => [+x.step, +x.at || 0]));
  // The tool dates its phase lines itself; a checkpoint or a sample is dated by its file. A line without its own
  // time happened between the dated line before it and the dated line after it: a date outside that window is
  // wrong (a copied file keeps the date of its source) and is brought back into it, so the lines keep the order
  // in which the tool wrote them.
  const nextT = new Array(evs.length).fill(0);
  for (let i = evs.length - 1, t = 0; i >= 0; i--) { nextT[i] = t; if (+evs[i].t > 0) t = +evs[i].t; }
  let lastCaps = -1;
  evs.forEach((ev, i) => { if (ev.e === 'caps') lastCaps = i; });
  const failed = s.state === 'erreur' && !!s.error;
  let floor = 0;                          // the last dated line so far
  const when = (i, fileAt) => {
    let at = fileAt > 0 ? fileAt : (floor || +s.startedAt || 0);
    if (floor && at < floor) at = floor;
    if (nextT[i] && at > nextT[i]) at = nextT[i];
    return at;
  };
  // a length under a second says nothing: « Images encodées », not « Images encodées (0 s) »
  const timed = (key, keyIn, sec, vars) => (sec >= 1 ? tx(L, keyIn, { ...vars, d: durShort(sec) }) : tx(L, key, vars));
  let phase = null;
  let phaseAt = 0;
  evs.forEach((ev, i) => {
    if (+ev.t > 0) floor = Math.max(floor, +ev.t);
    const push = (at, text) => out.push({ at, text, by: null, note: false });
    switch (ev.e) {
      case 'caps':
        phase = null;
        break;
      case 'phase': {
        const at = when(i, +ev.t || 0);
        if (ev.phase !== phase) {
          if (phase === 'encode' && phaseAt) push(at, timed('ev.encodedNoTime', 'ev.encoded', (at - phaseAt) / 1000));
          if (phase === 'load') push(at, phaseAt ? timed('ev.loaded', 'ev.loadedIn', (at - phaseAt) / 1000) : tx(L, 'ev.loaded'));
          phase = ev.phase;
          phaseAt = at;
        }
        break;
      }
      case 'checkpoint':
        push(when(i, ckAt.get(+ev.step)), tx(L, 'ev.checkpoint', { a: int(L, ev.step) }));
        break;
      case 'sample':
        push(when(i, smAt.get(+ev.step)), timed('ev.sample', 'ev.sampleIn', +ev.sec || 0, { a: int(L, ev.step) }));
        break;
      case 'resumed':
        push(when(i, 0), tx(L, 'ev.resumed', { a: int(L, ev.step) }));
        break;
      case 'stopped': {
        // `why` (written by the adapters): « pause » asked, or Mia gone (« alive ») — a pause, not a stop. An older
        // line without it keeps « Arrêt au pas ».
        const paused = ev.why === 'pause' || ev.why === 'alive';
        const key = paused ? (ev.saved ? 'ev.pausedSaved' : 'ev.paused') : (ev.saved ? 'ev.stoppedSaved' : 'ev.stopped');
        push(when(i, ckAt.get(+ev.step)), tx(L, key, { a: int(L, ev.step) }));
        break;
      }
      case 'done':
        push(when(i, ckAt.get(+ev.step)), tx(L, 'ev.done', { a: int(L, ev.step) }));
        break;
      case 'error':
        // the error that ended this training is written once, below, from what Mia made of it
        if (!(failed && i > lastCaps)) push(when(i, 0), tx(L, 'ev.error', { m: errorOfEvent(L, ev) }));
        break;
      default: break;
    }
  });
  if (failed) {
    const end = +s.endedAt > 0 ? Math.max(+s.endedAt, floor) : (floor || +s.startedAt || 0);
    out.push({ at: end, text: tx(L, 'ev.errorAt', { a: int(L, s.step), m: errorShort(L, s.error) }), by: null, note: false });
  }
  for (const n of s.notes || []) {
    const mine = isUser(n.by) || n.by === 'Mia';
    let text;
    if (n.act) {
      const key = `ev.act.${n.act}`;
      // {a}: the step of the line (added, removed…); {t}: its text as written (« Calcul à côté : Portrait »)
      text = STRINGS.fr[key] ? tx(L, key, { a: int(L, n.text || n.step), t: String(n.text || '') }) : String(n.act);
    } else text = String(n.text || '');
    if (!mine) text = tx(L, 'ev.by', { name: n.by, text });
    out.push({ at: +n.at || 0, text, by: mine ? (n.by === 'Mia' ? null : 'user') : String(n.by), note: !n.act });
  }
  return out.map((e, i) => ({ ...e, i })).sort((x, y) => (x.at - y.at) || (x.i - y.i)).map(({ i, ...e }) => e);
}

/** The assistants that left a line: the filter of ÉVÈNEMENTS gets one choice per name. */
export function eventAuthors(lines) {
  return [...new Set((lines || []).map((e) => e.by).filter((b) => b && b !== 'user'))];
}

/** Line A, right part: who suggested, who started, who is watching. ctx: { now } */
export function presenceLine(L, s, ctx = {}) {
  const parts = [];
  if (s.state !== 'pret') {
    if (s.proposedBy) parts.push(tx(L, 'a.suggested', { name: String(s.proposedBy).toUpperCase() }));
    if (s.startedBy && !isUser(s.startedBy) && s.startedBy !== 'Mia') parts.push(tx(L, 'a.startedBy', { name: String(s.startedBy).toUpperCase() }));
    else if (s.proposedBy) parts.push(tx(L, 'a.startedYou'));
  } else if (s.by && !isUser(s.by.who)) parts.push(tx(L, 'by.prepared', { name: String(s.by.who).toUpperCase() }));
  const w = s.lastWatch;
  if (w && w.by && w.at) {
    const min = Math.max(0, Math.floor(((ctx.now || 0) - w.at) / 60000));
    if (min < 24 * 60) {
      const ago = min < 1 ? tx(L, 'ago.now') : min < 60 ? tx(L, 'ago.min', { n: min }) : tx(L, 'ago.hour', { n: Math.floor(min / 60) });
      parts.push(tx(L, 'a.watching', { name: String(w.by).toUpperCase(), ago }));
    }
  }
  return parts;
}

/**
 * What the draft says about its set, under the images.
 * → [{ id: 'noCaption'|'small'|'tiny'|'skipped'|'missing'|'few', text, action?: {id, label} }]
 */
export function draftNotices(L, s, opts = {}) {
  const out = [];
  const d = s.dataset || {};
  const count = +d.count || 0;
  const missing = Math.max(0, count - (+d.captions || 0));
  if (missing) out.push({ id: 'noCaption', text: txn(L, 'n.noCaption', missing), action: { id: 'triggerOnly', label: tx(L, 'n.triggerOnly') } });
  if (+d.small > 0) out.push({ id: 'small', text: txn(L, 'n.small', d.small), action: { id: 'removeSmall', label: tx(L, 'n.removeSmall') } });
  const skipped = Array.isArray(d.skipped) ? d.skipped : [];
  const tiny = skipped.filter((x) => x && x.why === 'tiny').length;
  const other = skipped.filter((x) => x && (x.why === 'format' || x.why === 'unreadable')).length;
  if (tiny) out.push({ id: 'tiny', text: txn(L, 'n.tiny', tiny, { s: int(L, Math.round((+opts.minSide || 0) / 2)) }) });
  if (other) out.push({ id: 'skipped', text: txn(L, 'n.skipped', other) });
  // a dropped folder (or file) that is not there any more: said by its path, not counted as « ignored »
  const gone = [...new Set(skipped.filter((x) => x && x.why === 'missing').map((x) => String(x.path || x.original || '')))].filter(Boolean);
  for (const p of gone.slice(-3)) {
    const file = /\.(png|jpe?g|webp|txt)$/i.test(p);
    out.push({ id: 'missing', text: tx(L, file ? 'n.missingFile' : 'n.missingDir', { path: p }) });
  }
  const min = +opts.minImages || 10;
  const advise = +opts.adviseImages || 20;
  if (count >= min && count < advise) out.push({ id: 'few', text: tx(L, 'n.few', { n: advise }) });
  return out;
}

/** Under the length of a draft: « ≈ 4 H 20 MIN · GPU ≈ 46 GO », or that nothing was ever measured. */
export function estimateText(L, est) {
  if (!est || est.seconds == null) return tx(L, 'f.unknown');
  const d = dur(est.seconds, { secs: est.seconds < 60 }).toUpperCase();
  return est.vramGB > 0 ? tx(L, 'f.estimate', { d, g: int(L, est.vramGB) }) : tx(L, 'f.estimateNoGpu', { d });
}

/** Which of Court / Normal / Long a number of steps is, or null. */
export function lengthOf(lengths, steps) {
  for (const k of ['short', 'normal', 'long']) if (lengths && +lengths[k] === +steps) return k;
  return null;
}

export default {
  STRINGS, tx, txn, int, dec, pct, clock, clockText, dur, durShort, dateShort, size, cutName, who, isActive, isDraft, computing,
  chipModel, rowState, resumeStep, statusLine, sampleLeft, errorSentence, errorShort, actions, sampleSlots, eventLines, eventAuthors, presenceLine,
  draftNotices, estimateText, lengthOf, baseLabel: baseName
};
