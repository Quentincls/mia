/**
 * Bibliothèque des modèles — ce que Mia a trouvé sur ce PC, en langage simple (SPEC §7, §12, da.md §4.10).
 *
 *   mountLibrary(host = #library)   le panneau latéral (recherche, sections par usage, détail, clic droit)
 *   mountModelsButton(container)    le bouton « Modèles » de la barre de titre, avec le nombre de modèles prêts
 *   mountHomeModels(container)      la section « MODÈLES SUR CE PC » de l'accueil : une ligne par capacité
 *   openLibrary({ caps }), closeLibrary(), toggleLibrary()
 *   openAddLora(path, info?)        la modale « Ajouter un LoRA » (glisser-déposer de l'accueil et de la planche)
 *   gbText(gb)                      « 21,5 Go », « 45 Mo » : la même taille partout (sélecteurs, palette)
 *
 * L'inventaire arrive par le bus (`models:updated`, relayé par app.js depuis le principal) et vit dans
 * `state.inventory` ; ce module le montre. Il montre des USAGES, pas des fichiers : « Créer des vidéos »,
 * « Profondeur »… Les pièces techniques (encodeurs, décodeurs, modes) restent repliées à part.
 * Mia ne supprime ni ne déplace jamais un fichier d'origine : « Retirer de Mia » ne retire qu'une entrée (et la
 * copie que Mia avait rangée pour le moteur).
 *
 * Installer ce qui manque (SPEC §21.4) : sous « Il manque », chaque modèle à télécharger a son bouton
 * « Installer (21,5 Go) », chaque usage son « Tout installer pour … » ; le panneau « Téléchargements » suit la file
 * du principal (electron/installer.js : un fichier à la fois, reprise, pause, annulation). Le bus `installer:open
 * {caps}` (un bloc dont le modèle manque) ouvre la bibliothèque sur cet usage. Au premier lancement sans moteur,
 * l'assistant d'accueil (welcome.js) est monté d'ici.
 *
 * « Il manque » : une ligne résumé par usage (nom, taille, Installer ou son état), dépliable ; les fichiers déjà dans
 * « Téléchargements » n'y sont pas répétés. Un modèle à licence (LTX) sans jeton Hugging Face n'est pas mis en file :
 * une seule note, avec le champ où coller son jeton (tokenNote, partagée avec l'accueil). Un seul défilement pour
 * tout le panneau.
 *   tokenNote(opts)                 la note « licence à accepter + jeton » (accueil et bibliothèque)
 */
import { t, tn, tl, register, locale } from '../i18n.js';
import { on } from '../bus.js';
import { state } from '../state.js';
import { icon, register as registerIcons } from '../icons.js';
import { el, debounce, relTime, fmtClock } from '../util.js';
import { openMenu, isMenuOpen } from './menu.js';
import { tip } from './tooltip.js';
import { button, segmented, textField } from './controls.js';
import { toast } from './toasts.js';
import { openModal, confirm } from './modal.js';
import { ms } from './motion.js';

register({
  fr: {
    'lib.button': 'Modèles',
    'lib.buttonTip.zero': 'Aucun modèle prêt pour l’instant',
    'lib.buttonTip.one': '{n} modèle prêt sur ce PC',
    'lib.buttonTip.other': '{n} modèles prêts sur ce PC',
    'lib.kicker': 'Modèles sur ce PC',
    'lib.title': 'Bibliothèque',
    'lib.dialog': 'Bibliothèque des modèles',
    'lib.close': 'Fermer',
    'lib.ready.zero': 'Aucun modèle prêt',
    'lib.ready.one': '{n} modèle prêt',
    'lib.ready.other': '{n} modèles prêts',
    'lib.sizes': '{mia} pour Mia · {apps} d’autres applis',
    'lib.sizesMia': '{mia} sur le disque',
    'lib.search': 'Chercher un modèle…',
    'lib.rescan': 'Rescanner',
    'lib.rescanTip': 'Relire tous les fichiers de modèles',
    'lib.deep': 'Recherche approfondie',
    'lib.deepTip': 'Cherche d’autres modèles sur tout D:\\ et dans ton profil (quelques secondes)',
    'lib.filter': 'Seulement\u00a0: {what}',
    'lib.filterClear': 'Tout afficher',
    'lib.comfyOn': 'Moteur en marche · ComfyUI {version}',
    'lib.comfyOff': 'Moteur arrêté\u00a0: il démarrera tout seul au premier calcul',
    'lib.scannedAt': 'Lu {when} en {ms}',
    'lib.phase.comfy': 'Interrogation du moteur…',
    'lib.phase.walk': 'Parcours des dossiers… {n}',
    'lib.phase.identify': 'Lecture des fichiers · {done} / {total}',
    'lib.phase.group': 'Mise en ordre…',
    'lib.phase.done': 'Terminé',
    'lib.loading': 'Lecture des modèles…',
    'lib.loadFailed': 'La lecture des modèles n’a pas abouti\u00a0: {msg}',
    'lib.scanFailed': 'Le scan des modèles a échoué\u00a0: {msg}',
    'lib.rescanDone.zero': 'Modèles relus · aucun prêt',
    'lib.rescanDone.one': 'Modèles relus · {n} prêt',
    'lib.rescanDone.other': 'Modèles relus · {n} prêts',
    'lib.deepDone.zero': 'Recherche terminée\u00a0: aucun nouveau modèle.',
    'lib.deepDone.one': 'Recherche terminée\u00a0: {n} nouveau modèle trouvé.',
    'lib.deepDone.other': 'Recherche terminée\u00a0: {n} nouveaux modèles trouvés.',
    'lib.empty': 'Aucun modèle ne correspond à «\u00a0{q}\u00a0».',
    'lib.none': 'Aucun modèle trouvé sur ce PC.',
    'lib.missingKicker': 'Il manque',
    'lib.missing.add': 'Ajoute ces fichiers dans les dossiers indiqués, puis clique «\u00a0Rescanner\u00a0».',
    'lib.missing.addOne': 'Ajoute ce fichier dans le dossier indiqué, puis clique «\u00a0Rescanner\u00a0».',
    'lib.missing.download': 'À télécharger (≈ {size} en tout), puis à ranger dans les dossiers indiqués. Clique ensuite «\u00a0Rescanner\u00a0».',
    'lib.missing.in': 'dans {dir}',
    'lib.group.video': 'Créer des vidéos',
    'lib.group.image': 'Retoucher des images',
    'lib.group.depth': 'Profondeur',
    'lib.group.cutout': 'Détourage',
    'lib.group.upscale': 'Agrandir',
    'lib.group.loras': 'Mes LoRA',
    'lib.group.other': 'Autres modèles sur ce PC',
    'lib.group.internal': 'Pièces internes',
    'lib.group.apps': 'Autres applications',
    'lib.group.partials': 'Téléchargements interrompus',
    'lib.hint.loras': 'Tes personnages, lieux et styles. Glisse un fichier LoRA sur Mia pour en ajouter, puis choisis-le dans un bloc («\u00a0Personnage ou lieu\u00a0»). Tes dossiers de LoRA se règlent dans les Réglages.',
    'lib.hint.other': 'Présents sur le disque, pas encore utilisés par un bloc de Mia.',
    'lib.hint.internal': 'Encodeurs, décodeurs et modes\u00a0: Mia les choisit pour toi.',
    'lib.hint.apps': 'Lecture seule\u00a0: ces modèles appartiennent à d’autres logiciels.',
    'lib.hint.partials': 'Fichiers jamais terminés. Mia ne supprime rien\u00a0: à toi de voir.',
    'lib.training.one': '{n} étape d’entraînement',
    'lib.training.other': '{n} étapes d’entraînement',
    'lib.appCount.one': '{n} modèle · {size}',
    'lib.appCount.other': '{n} modèles · {size}',
    'lib.app.showFiles': 'Voir les fichiers',
    'lib.home.all': 'Tout voir',
    'lib.home.missing': 'Non installé',
    'lib.home.incomplete': 'Incomplet',
    'lib.home.loading': 'Lecture des modèles de ce PC…',
    'lib.home.noLora': 'Aucun pour l’instant',
    'lib.home.noneReady': 'Aucun',
    'lib.copied': 'Chemin copié',
    'lib.copyFailed': 'Impossible de copier le chemin.',
    'lib.lora.add': 'Ajouter un LoRA…',
    'lib.lora.addTip': 'Choisir un fichier LoRA (.safetensors) sur le PC',
    'lib.lora.title': 'Ajouter un LoRA',
    'lib.lora.editTitle': 'Modifier le LoRA',
    'lib.lora.madeFor': 'Fait pour {what}',
    'lib.lora.name': 'Nom',
    'lib.lora.trigger': 'Mot déclencheur',
    'lib.lora.triggerPh': 'Facultatif — ajouté en tête de ta consigne',
    'lib.lora.genre': 'Genre',
    'lib.lora.keep': 'Ton fichier reste où il est. Au premier calcul, Mia le range pour le moteur (sans copie s’il est sur le même disque).',
    'lib.lora.already': 'Déjà dans Mia sous le nom «\u00a0{name}\u00a0»\u00a0: tes changements s’appliqueront à celui-là.',
    'lib.lora.submit': 'Ajouter à Mia',
    'lib.lora.save': 'Enregistrer',
    'lib.lora.cancel': 'Annuler',
    'lib.lora.added': '«\u00a0{name}\u00a0» est dans Mia.',
    'lib.lora.updated': '«\u00a0{name}\u00a0» mis à jour.',
    'lib.lora.removed': '«\u00a0{name}\u00a0» retiré de Mia. Le fichier d’origine n’a pas bougé.',
    'lib.lora.see': 'Voir',
    'lib.lora.notLora': 'Ce fichier n’est pas un LoRA.',
    'lib.lora.unavailable': 'Cette version de Mia ne sait pas encore ajouter de LoRA.',
    'lib.lora.failed': 'Le LoRA n’a pas pu être enregistré\u00a0: {msg}',
    'lib.lora.rename': 'Renommer…',
    'lib.lora.editTrigger': 'Mot déclencheur…',
    'lib.lora.setGenre': 'Genre',
    'lib.lora.remove': 'Retirer de Mia',
    'lib.lora.removeTitle': 'Retirer «\u00a0{name}\u00a0» de Mia\u00a0?',
    'lib.lora.removeBody': 'Le fichier d’origine reste où il est. Mia retire seulement son entrée et la copie rangée pour le moteur.',
    'lib.lora.removeBodyNoCopy': 'Le fichier d’origine reste où il est. Mia retire seulement son entrée.',
    'lib.lora.removeOk': 'Retirer',
    'lib.lora.for': 'pour {what}',
    'lib.lora.triggerQ': '« {t} »',
    'lib.lora.noTrigger': 'aucun',
    'lib.lora.origin': 'Origine',
    'lib.lora.origin.engine': 'Dossier des LoRA du moteur',
    'lib.lora.origin.added': 'Ajouté par toi',
    'lib.lora.origin.folder': 'Un de tes dossiers de LoRA',
    'lib.lora.origin.training': 'Dossier d’entraînement',
    'lib.lora.placed': 'Pour le moteur',
    'lib.lora.placeLater': 'rangé au premier calcul',
    'lib.lora.unknownBase': 'un modèle que Mia ne reconnaît pas',
    'model.status.ready': 'Prêt',
    'model.status.incomplete': 'Incomplet',
    'model.status.duplicate': 'Doublon',
    'model.status.unused': 'Inutilisé',
    'model.status.other-app': 'Autre appli',
    'model.status.partial': 'Partiel',
    'model.license.rd': 'R&D seulement',
    'model.license.trial': 'Essais seulement',
    'model.license.forbidden': 'Interdit',
    'model.auto': 'Auto',
    'model.autoTip': 'Choisi par «\u00a0Auto\u00a0» pour\u00a0: {caps}',
    'model.fit.over': 'Déborde',
    'model.fitTip.over': 'Pointe à {n} Go\u00a0: plus que ta carte de {card} Go. Il passe par la mémoire du PC, beaucoup plus lentement.',
    'model.gb': '{n} Go',
    'model.mb': '{n} Mo',
    'model.mbTiny': '< 1 Mo',
    'model.params': '{n} milliards de paramètres',
    'model.speed': 'Vitesse',
    'model.quality': 'Qualité',
    'model.memory': 'Mémoire',
    'model.memoryVal': '≈ {n} Go en pointe',
    'model.memoryFit.light': '≈ {n} Go en pointe\u00a0: à l’aise sur ta carte de {card} Go',
    'model.memoryFit.comfy': '≈ {n} Go en pointe\u00a0: tient sur ta carte de {card} Go',
    'model.memoryFit.tight': '≈ {n} Go en pointe\u00a0: serré sur ta carte de {card} Go (Mia libère la mémoire entre deux étapes ; évite d’ouvrir autre chose sur le GPU)',
    'model.memoryFit.over': '≈ {n} Go en pointe\u00a0: plus que ta carte de {card} Go, beaucoup plus lent',
    'model.usedFor': 'Sert à',
    'model.madeFor': 'Fait pour',
    'model.genre': 'Genre',
    'model.trigger': 'Mot déclencheur',
    'model.file': 'Fichier',
    'model.files.one': '{n} fichier',
    'model.files.other': '{n} fichiers',
    'model.useful': '{useful} utiles sur {total}',
    'model.where': 'Emplacement',
    'model.precision': 'Précision',
    'model.comfy': 'Nom dans ComfyUI',
    'model.comfyHidden': 'pas vu par ComfyUI',
    'model.usedBy': 'Recettes du labo',
    'model.copyOf': 'Copie de',
    'model.app': 'Application',
    'model.licenseLbl': 'Licence',
    'model.reveal': 'Afficher dans l’Explorateur',
    'model.copyPath': 'Copier le chemin',
    'model.speed.1': 'lent', 'model.speed.2': 'moyen', 'model.speed.3': 'rapide',
    'model.quality.1': 'correcte', 'model.quality.2': 'bonne', 'model.quality.3': 'excellente',
    'model.qc.full': 'Pleine qualité', 'model.qc.compact': 'Compact', 'model.qc.ultra': 'Ultra-compact (RTX 50)', 'model.qc.very': 'Très compact',
  },
  en: {
    'lib.button': 'Models',
    'lib.buttonTip.zero': 'No model ready yet',
    'lib.buttonTip.one': '{n} model ready on this PC',
    'lib.buttonTip.other': '{n} models ready on this PC',
    'lib.kicker': 'Models on this PC',
    'lib.title': 'Library',
    'lib.dialog': 'Model library',
    'lib.close': 'Close',
    'lib.ready.zero': 'No model ready',
    'lib.ready.one': '{n} model ready',
    'lib.ready.other': '{n} models ready',
    'lib.sizes': '{mia} for Mia · {apps} from other apps',
    'lib.sizesMia': '{mia} on disk',
    'lib.search': 'Search a model…',
    'lib.rescan': 'Rescan',
    'lib.rescanTip': 'Read every model file again',
    'lib.deep': 'Deep search',
    'lib.deepTip': 'Looks for other models across D:\\ and your profile (a few seconds)',
    'lib.filter': 'Only: {what}',
    'lib.filterClear': 'Show all',
    'lib.comfyOn': 'Engine running · ComfyUI {version}',
    'lib.comfyOff': 'Engine stopped: it starts by itself on the first render',
    'lib.scannedAt': 'Read {when} in {ms}',
    'lib.phase.comfy': 'Asking the engine…',
    'lib.phase.walk': 'Browsing folders… {n}',
    'lib.phase.identify': 'Reading files · {done} / {total}',
    'lib.phase.group': 'Sorting…',
    'lib.phase.done': 'Done',
    'lib.loading': 'Reading the models…',
    'lib.loadFailed': 'Reading the models did not finish: {msg}',
    'lib.scanFailed': 'The model scan failed: {msg}',
    'lib.rescanDone.zero': 'Models read again · none ready',
    'lib.rescanDone.one': 'Models read again · {n} ready',
    'lib.rescanDone.other': 'Models read again · {n} ready',
    'lib.deepDone.zero': 'Search finished: no new model.',
    'lib.deepDone.one': 'Search finished: {n} new model found.',
    'lib.deepDone.other': 'Search finished: {n} new models found.',
    'lib.empty': 'No model matches “{q}”.',
    'lib.none': 'No model found on this PC.',
    'lib.missingKicker': 'Missing',
    'lib.missing.add': 'Add these files to the folders shown, then click “Rescan”.',
    'lib.missing.addOne': 'Add this file to the folder shown, then click “Rescan”.',
    'lib.missing.download': 'To download (≈ {size} in all), then put in the folders shown. Then click “Rescan”.',
    'lib.missing.in': 'in {dir}',
    'lib.group.video': 'Create videos',
    'lib.group.image': 'Edit images',
    'lib.group.depth': 'Depth',
    'lib.group.cutout': 'Cut out',
    'lib.group.upscale': 'Upscale',
    'lib.group.loras': 'My LoRAs',
    'lib.group.other': 'Other models on this PC',
    'lib.group.internal': 'Internal parts',
    'lib.group.apps': 'Other apps',
    'lib.group.partials': 'Interrupted downloads',
    'lib.hint.loras': 'Your characters, places and styles. Drop a LoRA file on Mia to add one, then pick it in a block (“Character or place”). Your LoRA folders are set in Settings.',
    'lib.hint.other': 'On disk, not used by any Mia block yet.',
    'lib.hint.internal': 'Encoders, decoders and modes: Mia picks them for you.',
    'lib.hint.apps': 'Read-only: these models belong to other software.',
    'lib.hint.partials': 'Files never finished. Mia deletes nothing: your call.',
    'lib.training.one': '{n} training step',
    'lib.training.other': '{n} training steps',
    'lib.appCount.one': '{n} model · {size}',
    'lib.appCount.other': '{n} models · {size}',
    'lib.app.showFiles': 'Show the files',
    'lib.home.all': 'See all',
    'lib.home.missing': 'Not installed',
    'lib.home.incomplete': 'Incomplete',
    'lib.home.loading': 'Reading the models on this PC…',
    'lib.home.noLora': 'None yet',
    'lib.home.noneReady': 'None',
    'lib.copied': 'Path copied',
    'lib.copyFailed': 'Could not copy the path.',
    'lib.lora.add': 'Add a LoRA…',
    'lib.lora.addTip': 'Pick a LoRA file (.safetensors) on the PC',
    'lib.lora.title': 'Add a LoRA',
    'lib.lora.editTitle': 'Edit the LoRA',
    'lib.lora.madeFor': 'Made for {what}',
    'lib.lora.name': 'Name',
    'lib.lora.trigger': 'Trigger word',
    'lib.lora.triggerPh': 'Optional — added at the start of your prompt',
    'lib.lora.genre': 'Kind',
    'lib.lora.keep': 'Your file stays where it is. On the first render, Mia places it for the engine (no copy if it is on the same drive).',
    'lib.lora.already': 'Already in Mia as “{name}”: your changes will apply to that one.',
    'lib.lora.submit': 'Add to Mia',
    'lib.lora.save': 'Save',
    'lib.lora.cancel': 'Cancel',
    'lib.lora.added': '“{name}” is in Mia.',
    'lib.lora.updated': '“{name}” updated.',
    'lib.lora.removed': '“{name}” removed from Mia. The original file did not move.',
    'lib.lora.see': 'Show',
    'lib.lora.notLora': 'This file is not a LoRA.',
    'lib.lora.unavailable': 'This version of Mia cannot add LoRAs yet.',
    'lib.lora.failed': 'The LoRA could not be saved: {msg}',
    'lib.lora.rename': 'Rename…',
    'lib.lora.editTrigger': 'Trigger word…',
    'lib.lora.setGenre': 'Kind',
    'lib.lora.remove': 'Remove from Mia',
    'lib.lora.removeTitle': 'Remove “{name}” from Mia?',
    'lib.lora.removeBody': 'The original file stays where it is. Mia only removes its entry and the copy kept for the engine.',
    'lib.lora.removeBodyNoCopy': 'The original file stays where it is. Mia only removes its entry.',
    'lib.lora.removeOk': 'Remove',
    'lib.lora.for': 'for {what}',
    'lib.lora.triggerQ': '“{t}”',
    'lib.lora.noTrigger': 'none',
    'lib.lora.origin': 'Origin',
    'lib.lora.origin.engine': 'Engine LoRA folder',
    'lib.lora.origin.added': 'Added by you',
    'lib.lora.origin.folder': 'One of your LoRA folders',
    'lib.lora.origin.training': 'Training folder',
    'lib.lora.placed': 'For the engine',
    'lib.lora.placeLater': 'placed on the first render',
    'lib.lora.unknownBase': 'a model Mia does not recognise',
    'model.status.ready': 'Ready',
    'model.status.incomplete': 'Incomplete',
    'model.status.duplicate': 'Duplicate',
    'model.status.unused': 'Unused',
    'model.status.other-app': 'Other app',
    'model.status.partial': 'Partial',
    'model.license.rd': 'R&D only',
    'model.license.trial': 'Trials only',
    'model.license.forbidden': 'Forbidden',
    'model.auto': 'Auto',
    'model.autoTip': 'Picked by “Auto” for: {caps}',
    'model.fit.over': 'Overflows',
    'model.fitTip.over': 'Peaks at {n} GB: more than your {card} GB card. It spills into the PC memory, much slower.',
    'model.gb': '{n} GB',
    'model.mb': '{n} MB',
    'model.mbTiny': '< 1 MB',
    'model.params': '{n} billion parameters',
    'model.speed': 'Speed',
    'model.quality': 'Quality',
    'model.memory': 'Memory',
    'model.memoryVal': '≈ {n} GB at peak',
    'model.memoryFit.light': '≈ {n} GB at peak: easy on your {card} GB card',
    'model.memoryFit.comfy': '≈ {n} GB at peak: fits your {card} GB card',
    'model.memoryFit.tight': '≈ {n} GB at peak: tight on your {card} GB card (Mia frees memory between steps; avoid other GPU apps)',
    'model.memoryFit.over': '≈ {n} GB at peak: more than your {card} GB card, much slower',
    'model.usedFor': 'Used for',
    'model.madeFor': 'Made for',
    'model.genre': 'Kind',
    'model.trigger': 'Trigger word',
    'model.file': 'File',
    'model.files.one': '{n} file',
    'model.files.other': '{n} files',
    'model.useful': '{useful} useful out of {total}',
    'model.where': 'Location',
    'model.precision': 'Precision',
    'model.comfy': 'Name in ComfyUI',
    'model.comfyHidden': 'not seen by ComfyUI',
    'model.usedBy': 'Lab recipes',
    'model.copyOf': 'Copy of',
    'model.app': 'Application',
    'model.licenseLbl': 'License',
    'model.reveal': 'Show in Explorer',
    'model.copyPath': 'Copy path',
    'model.speed.1': 'slow', 'model.speed.2': 'medium', 'model.speed.3': 'fast',
    'model.quality.1': 'fair', 'model.quality.2': 'good', 'model.quality.3': 'excellent',
    'model.qc.full': 'Full quality', 'model.qc.compact': 'Compact', 'model.qc.ultra': 'Ultra-compact (RTX 50)', 'model.qc.very': 'Very compact',
  },
});

// Installer les modèles manquants (SPEC §21.4)
register({
  fr: {
    'lib.inst.install': 'Installer ({size})',
    'lib.inst.installAll': 'Tout installer pour {cap} ({size})',
    'lib.inst.option': 'En option',
    'lib.inst.same': 'Les mêmes fichiers que «\u00a0{cap}\u00a0», ci-dessus.',
    'lib.inst.plus': 'Et les fichiers de «\u00a0{cap}\u00a0», ci-dessus.',
    'lib.inst.kicker': 'Téléchargements',
    'lib.inst.left': 'reste {size}',
    'lib.inst.endAt': 'fin vers {clock}',
    'lib.inst.endSoon': 'presque fini',
    'lib.inst.pauseAll': 'Tout mettre en pause',
    'lib.inst.clear': 'Effacer la liste',
    'lib.inst.pause': 'Mettre en pause',
    'lib.inst.resume': 'Reprendre',
    'lib.inst.cancel': 'Annuler ce téléchargement',
    'lib.inst.retry': 'Réessayer',
    'lib.inst.page': 'Ouvrir la page',
    'lib.inst.st.queued': 'En attente · {total}',
    'lib.inst.st.connect': 'Connexion…',
    'lib.inst.st.downloading': '{done} sur {total} · {speed}/s',
    'lib.inst.st.verifying': 'Vérification du fichier · {pct}',
    'lib.inst.st.paused': 'En pause · {done} sur {total}',
    'lib.inst.st.done': 'Installé · {total}',
    'lib.inst.st.gated': 'Licence à accepter sur Hugging Face',
    'lib.inst.pct': '{n} %',
    'lib.inst.chip.queued': 'En attente',
    'lib.inst.chip.downloading': 'Téléchargement · {pct}',
    'lib.inst.chip.verifying': 'Vérification',
    'lib.inst.chip.paused': 'En pause · {pct}',
    'lib.inst.chip.error': 'Arrêté',
    'lib.inst.chip.done': 'Installé',
    'lib.inst.where': 'Les fichiers se rangent dans {dir}.',
    'lib.inst.free': 'Il reste {free} libres sur le disque {drive}.',
    'lib.inst.started.one': '{n} fichier en téléchargement · {size}',
    'lib.inst.started.other': '{n} fichiers en téléchargement · {size}',
    'lib.inst.nothing': 'Tout est déjà là.',
    'lib.inst.doneToast': '« {name} » est installé.',
    'lib.inst.failToast': '« {name} » n’a pas pu être installé.',
    'lib.inst.see': 'Voir',
    'lib.inst.gatedToast': '{name} demande d’accepter sa licence sur Hugging Face : le détail est dans Modèles.',
    'lib.inst.failMany.one': '{n} téléchargement n’a pas abouti.',
    'lib.inst.failMany.other': '{n} téléchargements n’ont pas abouti.',
    'lib.inst.failed': 'Installation impossible : {msg}',
    'lib.inst.noEngine': 'Les calculs et les installations l’attendent.',
    'lib.inst.setup': 'Configurer le moteur…',
    'lib.inst.engineFirst': 'Configure d’abord le moteur\u00a0: les modèles se rangent dedans.',
    'lib.inst.files.one': '{n} fichier',
    'lib.inst.files.other': '{n} fichiers',
    'lib.inst.tbTip': 'Téléchargement de modèles · {pct} · {left}',
  },
  en: {
    'lib.inst.install': 'Install ({size})',
    'lib.inst.installAll': 'Install everything for {cap} ({size})',
    'lib.inst.option': 'Optional',
    'lib.inst.same': 'The same files as “{cap}”, above.',
    'lib.inst.plus': 'Plus the files of “{cap}”, above.',
    'lib.inst.kicker': 'Downloads',
    'lib.inst.left': '{size} left',
    'lib.inst.endAt': 'done around {clock}',
    'lib.inst.endSoon': 'almost done',
    'lib.inst.pauseAll': 'Pause all',
    'lib.inst.clear': 'Clear the list',
    'lib.inst.pause': 'Pause',
    'lib.inst.resume': 'Resume',
    'lib.inst.cancel': 'Cancel this download',
    'lib.inst.retry': 'Try again',
    'lib.inst.page': 'Open the page',
    'lib.inst.st.queued': 'Waiting · {total}',
    'lib.inst.st.connect': 'Connecting…',
    'lib.inst.st.downloading': '{done} of {total} · {speed}/s',
    'lib.inst.st.verifying': 'Checking the file · {pct}',
    'lib.inst.st.paused': 'Paused · {done} of {total}',
    'lib.inst.st.done': 'Installed · {total}',
    'lib.inst.st.gated': 'License to accept on Hugging Face',
    'lib.inst.pct': '{n}%',
    'lib.inst.chip.queued': 'Waiting',
    'lib.inst.chip.downloading': 'Downloading · {pct}',
    'lib.inst.chip.verifying': 'Checking',
    'lib.inst.chip.paused': 'Paused · {pct}',
    'lib.inst.chip.error': 'Stopped',
    'lib.inst.chip.done': 'Installed',
    'lib.inst.where': 'Files go to {dir}.',
    'lib.inst.free': '{free} free on drive {drive}.',
    'lib.inst.started.one': '{n} file downloading · {size}',
    'lib.inst.started.other': '{n} files downloading · {size}',
    'lib.inst.nothing': 'Everything is already there.',
    'lib.inst.doneToast': '“{name}” is installed.',
    'lib.inst.failToast': '“{name}” could not be installed.',
    'lib.inst.see': 'Show',
    'lib.inst.gatedToast': '{name} requires accepting its license on Hugging Face: details in Models.',
    'lib.inst.failMany.one': '{n} download did not finish.',
    'lib.inst.failMany.other': '{n} downloads did not finish.',
    'lib.inst.failed': 'Cannot install: {msg}',
    'lib.inst.noEngine': 'Renders and installs are waiting for one.',
    'lib.inst.setup': 'Set up the engine…',
    'lib.inst.engineFirst': 'Set up the engine first: the models go inside it.',
    'lib.inst.files.one': '{n} file',
    'lib.inst.files.other': '{n} files',
    'lib.inst.tbTip': 'Downloading models · {pct} · {left}',
  },
});

// Licence Hugging Face, jeton collé, moteur absent ou ComfyUI d'une autre appli (revue du 17/10)
register({
  fr: {
    'lib.inst.chip.gated': 'Licence à accepter',
    'lib.inst.inQueue': 'Ses fichiers sont dans les téléchargements, ci-dessus.',
    'lib.inst.restQueued': 'Le reste est dans les téléchargements, ci-dessus.',
    'lib.inst.gatedRow': '{n} fichiers · licence à accepter sur Hugging Face',
    'lib.inst.gatedRowOne': 'Licence à accepter sur Hugging Face',
    'lib.inst.setupTip': 'Configure d’abord le moteur : les modèles se rangent dedans',
    'lib.noEngine': 'Aucun moteur sur ce PC',
    'lib.foreign': 'Un autre ComfyUI tourne sur ce PC (port {port}) : ce n’est pas le moteur de Mia',
    'lib.tok.lead': '{name} demande d’accepter sa licence sur Hugging Face (compte gratuit) : ouvre sa page et accepte-la, puis crée un jeton de lecture et colle-le ici.',
    'lib.tok.leadMany': '{name} demandent d’accepter leur licence sur Hugging Face (compte gratuit) : ouvre leurs pages et accepte-les, puis crée un jeton de lecture et colle-le ici.',
    'lib.tok.denied': 'Ton compte Hugging Face n’a pas encore accès à {name} : ouvre sa page, accepte la licence avec le même compte, puis réessaie.',
    'lib.tok.page': 'Ouvrir la page',
    'lib.tok.pageOf': 'Page de {name}',
    'lib.tok.create': 'Créer un jeton',
    'lib.tok.ph': 'Jeton Hugging Face (hf_…)',
    'lib.tok.save': 'Enregistrer',
    'lib.tok.saving': 'Vérification…',
    'lib.tok.saved': 'Jeton enregistré.',
    'lib.tok.savedFor': 'Jeton enregistré pour {user}.',
    'lib.tok.empty': 'Colle d’abord ton jeton.',
    'lib.tok.keep': 'Mia le range là où Hugging Face le garde sur ce PC, comme la commande « hf auth login », et ne le garde pas elle-même.',
    'lib.tok.cli': 'Autre façon, dans un terminal :',
    'lib.tok.copy': 'Copier la commande',
    'lib.tok.copied': 'Commande copiée',
    'lib.tok.retry': 'Réessayer',
  },
  en: {
    'lib.inst.chip.gated': 'License to accept',
    'lib.inst.inQueue': 'Its files are in the downloads, above.',
    'lib.inst.restQueued': 'The rest is in the downloads, above.',
    'lib.inst.gatedRow': '{n} files · license to accept on Hugging Face',
    'lib.inst.gatedRowOne': 'License to accept on Hugging Face',
    'lib.inst.setupTip': 'Set up the engine first: the models go inside it',
    'lib.noEngine': 'No engine on this PC',
    'lib.foreign': 'Another ComfyUI runs on this PC (port {port}): it is not Mia’s engine',
    'lib.tok.lead': '{name} requires accepting its license on Hugging Face (free account): open its page and accept it, then create a read token and paste it here.',
    'lib.tok.leadMany': '{name} require accepting their licenses on Hugging Face (free account): open their pages and accept them, then create a read token and paste it here.',
    'lib.tok.denied': 'Your Hugging Face account has no access to {name} yet: open its page, accept the license with the same account, then try again.',
    'lib.tok.page': 'Open the page',
    'lib.tok.pageOf': '{name} page',
    'lib.tok.create': 'Create a token',
    'lib.tok.ph': 'Hugging Face token (hf_…)',
    'lib.tok.save': 'Save',
    'lib.tok.saving': 'Checking…',
    'lib.tok.saved': 'Token saved.',
    'lib.tok.savedFor': 'Token saved for {user}.',
    'lib.tok.empty': 'Paste your token first.',
    'lib.tok.keep': 'Mia puts it where Hugging Face keeps it on this PC, like the command “hf auth login”, and never keeps it itself.',
    'lib.tok.cli': 'Another way, in a terminal:',
    'lib.tok.copy': 'Copy the command',
    'lib.tok.copied': 'Command copied',
    'lib.tok.retry': 'Try again',
  },
});

// Un dossier fouillé à la loupe : la recherche approfondie (pas d'icône « IA », da.md §4.11).
// Une flèche qui descend dans un plateau : installer (même famille que le glyphe « Importer »).
registerIcons({
  'lib-deep': '<path d="M3.5 17.6V6.9a1.5 1.5 0 0 1 1.5-1.5h3.7l1.8 2h7.4a1.5 1.5 0 0 1 1.5 1.5v1.6"/><path d="M3.5 17.6a1.5 1.5 0 0 0 1.5 1.5h5.4"/><circle cx="16" cy="15.2" r="3.3"/><path d="M18.4 17.6l2.4 2.4"/>',
  'lib-dl': '<path d="M12 4.5v10"/><path d="M7.8 10.6 12 14.8l4.2-4.2"/><path d="M4.5 15.5v2.2a1.8 1.8 0 0 0 1.8 1.8h11.4a1.8 1.8 0 0 0 1.8-1.8v-2.2"/>',
});

// ── constantes d'affichage ───────────────────────────────────────────
// Sections dans l'ordre de la bibliothèque. Les quatre dernières démarrent repliées.
const GROUPS = ['video', 'image', 'depth', 'cutout', 'upscale', 'loras', 'other', 'internal', 'apps', 'partials'];
const FOLDED = new Set(['other', 'internal', 'apps', 'partials']);
const HINTED = new Set(['loras', 'other', 'internal', 'apps', 'partials']);
// Lignes de l'accueil : une par capacité, dans l'ordre où Quentin s'en sert.
const HOME_CAPS = ['image-to-video', 'text-to-video', '3d-to-real', 'guided-video', 'reference-to-video', 'character-performance',
  'image-edit', 'upscale', 'depth', 'cutout', 'lora'];
const GENRE_KEYS = ['character', 'place', 'style'];
const GENRE_FALLBACK = { character: { fr: 'Personnage', en: 'Character' }, place: { fr: 'Lieu', en: 'Place' }, style: { fr: 'Style', en: 'Style' } };

// ── état du module ───────────────────────────────────────────────────
let mounted = false;
let host = null;              // #library
let ui = null;                // nœuds du panneau
let isOpen = false;
let filterCaps = null;        // capacités demandées par un bloc (library:open {caps})
let query = '';
const expanded = new Set();   // ids des modèles dont le détail est déplié
const unfolded = new Set();   // sections repliées par défaut que l'utilisateur a dépliées
const folded = new Set();     // sections ouvertes par défaut que l'utilisateur a repliées
const openApps = new Set();   // autres applications dont on montre les fichiers
let showTraining = false;
let returnFocus = null;       // élément focalisé avant l'ouverture du panneau
let userScan = null;          // { kind: 'rescan' | 'deep' } pendant un scan lancé d'ici
let progress = null;          // dernier models:progress reçu
const painters = new Set();   // fonctions à rappeler quand l'inventaire change (bouton, accueil, panneau)
let wired = false;
// Installateur (SPEC §21.4) : la dernière réponse de mia.installer.list() et la file en cours (installer:progress).
let inst = null;              // { files, caps, token, free, drive, modelsDir, engineReady, licenses }
let dl = null;                // { queue: [job], active, left }
const lastStates = new Map(); // clé → état précédent (pour annoncer « installé » ou « arrêté » une seule fois)
let liveSig = '';             // états de la file au dernier dessin de « Il manque »
let liveFrame = 0;
const missingOpen = new Set();   // usages de « Il manque » dépliés par l'utilisateur
const missingShut = new Set();   // usages dépliés d'office (demandés par un bloc) qu'il a repliés

const inv = () => {
  const i = state.inventory;
  return i && typeof i === 'object' && Array.isArray(i.models) ? i : null;
};
const mia = () => window.mia || {};

// ── formats ──────────────────────────────────────────────────────────
function num(v, digits = 1, min = 0) {
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: digits, minimumFractionDigits: min }).format(v);
}
/**
 * Une taille lisible, la même partout (bibliothèque, accueil, sélecteurs de modèle, palette) :
 * « 21,5 Go », « 1,3 Go », « 330 Mo », « < 1 Mo ». Une décimale fixe à partir de 1 Go, des Mo entiers en dessous :
 * la colonne se lit d'un coup d'œil et un petit fichier n'affiche jamais « 0,00 Go ».
 */
export function gbText(g) {
  const v = Number(g) || 0;
  if (v < 0.001) return t('model.mbTiny');
  if (v < 1) return t('model.mb', { n: num(v * 1000, 0) });
  return t('model.gb', { n: num(v, 1, 1) });
}
const msText = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${num(ms / 1000, 1)} s`);
const capLabel = (cap) => tl(inv()?.capabilities?.[cap]?.label) || cap;
const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const genreLabel = (g) => tl(inv()?.genres?.[g] || GENRE_FALLBACK[g]) || '';
const baseFull = (k) => tl(inv()?.bases?.[k]?.full) || '';
const baseShort = (k) => tl(inv()?.bases?.[k]?.label) || '';
// La famille (« LTX-2.X ») répète souvent le nom (« LTX 2.5 ») : on ne la montre que si elle apprend quelque chose.
export function famTag(m) {
  const f = String(m?.family || '');
  const first = fold(f).split(/[\s.\-/(]/).filter(Boolean)[0];
  if (!first) return '';
  const name = fold(m?.label?.fr) + ' ' + fold(m?.label?.en);
  return name.includes(first) ? '' : f;
}

// Mémoire de la carte, en Go « Windows » (25,6 milliards d'octets = 24 Go) : c'est le chiffre qu'il connaît.
function cardGB() {
  const g = inv()?.machine?.vramGB ?? state.engine?.gpu?.vramTotalGB;
  return g ? Math.round((g * 1e9) / 2 ** 30) : 24;
}
// Place en mémoire (models.md §6.2) : seuils pensés pour 24 Go, le débordement suit la vraie carte. Rien pour un
// modèle qu'on ne peut pas utiliser (interdit, incomplet, autre appli…) : la pastille n'aurait pas de sens.
function fitOf(m) {
  const v = Number(m.vramGB);
  if (!isFinite(v) || v <= 0 || m.hidden || m.role === 'lora' || m.status !== 'ready' || m.license === 'forbidden') return null;
  const card = cardGB();
  if (v < 8) return 'light';
  if (v < 16) return 'comfy';
  if (v <= card - 1) return 'tight';
  return 'over';
}

const byId = (id) => inv()?.models.find((m) => m.id === id) || null;
const readyCount = (i) => (i ? i.models.filter((m) => m.status === 'ready' && !m.hidden && m.license !== 'forbidden').length : 0);
const isLoraEntry = (m) => m && m.role === 'lora' && (m.caps || []).includes('lora');
const canRemove = (m) => isLoraEntry(m) && (m.origin === 'added' || m.origin === 'folder');
const canEdit = (m) => isLoraEntry(m) && m.origin !== 'training' && m.status !== 'duplicate';

// ── actions sur un fichier ───────────────────────────────────────────
async function reveal(abs) {
  try {
    const r = await mia().shell?.reveal?.({ abs });
    if (r && r.ok === false) toast(r.error, { kind: 'error' });
  } catch (err) {
    toast(String(err?.message || err), { kind: 'error' });
  }
}

// Le principal copie (et vérifie le chemin) ; s'il refuse, le presse-papiers de la fenêtre suffit : copier un
// texte ne touche à aucun fichier.
async function copyPath(abs) {
  const win = String(abs).replace(/\//g, '\\');
  try {
    const r = await mia().shell?.copyPath?.({ abs });
    if (r && r.ok !== false) { toast(t('lib.copied'), { kind: 'ok' }); return; }
  } catch { /* repli ci-dessous */ }
  try {
    await navigator.clipboard.writeText(win);
    toast(t('lib.copied'), { kind: 'ok' });
  } catch {
    toast(t('lib.copyFailed'), { kind: 'error' });
  }
}

function fileMenu(abs, at, m = null) {
  if (!abs) return;
  const items = [];
  if (m && canEdit(m)) {
    items.push({ label: t('lib.lora.rename'), icon: 'edit', action: () => openLoraEditor(m, 'name') });
    items.push({ label: t('lib.lora.editTrigger'), action: () => openLoraEditor(m, 'trigger') });
    items.push({ label: t('lib.lora.setGenre'), submenu: GENRE_KEYS.map((g) => ({
      label: genreLabel(g), icon: m.genre === g ? 'check' : null, action: () => saveLora(m, { kind: g }) })) });
    items.push('sep');
  }
  items.push({ label: t('model.reveal'), icon: 'reveal', action: () => reveal(abs) });
  items.push({ label: t('model.copyPath'), icon: 'copy', action: () => copyPath(abs) });
  if (m && canRemove(m)) items.push('sep', { label: t('lib.lora.remove'), icon: 'trash', danger: true, action: () => removeLora(m) });
  openMenu(items, at);
}

// ── scans lancés depuis la bibliothèque ──────────────────────────────
async function runScan(kind) {
  if (userScan) return;
  const before = new Set((inv()?.models || []).map((m) => m.id));
  userScan = { kind };
  progress = null;
  repaint();
  let res = null;
  try {
    res = await mia().models?.scan?.(kind === 'deep' ? { deep: true } : { force: true });
  } catch (err) {
    res = { ok: false, error: String(err?.message || err) };
  }
  userScan = null;
  progress = null;
  if (!res || res.ok === false || !Array.isArray(res.models)) {
    toast(t('lib.scanFailed', { msg: (res && res.error) || '—' }), { kind: 'error' });
    repaint();
    return;
  }
  // models:update arrive aussi par le bus ; on n'attend pas pour montrer le résultat.
  adopt(res);
  if (kind === 'deep') {
    const fresh = res.models.filter((m) => !before.has(m.id)).length;
    toast(tn('lib.deepDone', fresh), { kind: fresh ? 'ok' : 'info' });
  } else {
    toast(tn('lib.rescanDone', readyCount(res)), { kind: 'ok' });
  }
  repaint();
}

// Un inventaire renvoyé par une action (scan, ajout de LoRA…) remplace tout de suite celui de l'état.
function adopt(i) {
  if (i && Array.isArray(i.models) && (!state.inventory || state.inventory.scannedAt !== i.scannedAt)) state.inventory = i;
}

// ── branchements communs (une seule fois) ────────────────────────────
function wire() {
  if (wired) return;
  wired = true;
  on('models:updated', () => { repaint(); refreshInstSoon(); });
  on('library:open', (p) => openLibrary(p || {}));
  // un bloc dont le modèle manque : « Installer le modèle » ouvre la bibliothèque sur cet usage
  on('installer:open', (p) => openLibrary({ caps: p?.caps }));
  on('view:changed', () => closeLibrary());            // changer d'onglet ou revenir à l'accueil referme le panneau
  on('engine:status', () => { if (isOpen) paintPanel(); });   // la carte graphique peut n'être connue que par le moteur
  try {
    mia().models?.onProgress?.((p) => {
      progress = p && typeof p === 'object' ? p : null;
      if (isOpen) paintProgress();
    });
  } catch (err) {
    console.warn('[library] progress', err);
  }
  try {
    mia().installer?.onProgress?.(onInstallerEvent);
  } catch (err) {
    console.warn('[library] installer', err);
  }
  refreshInst();
  // Premier lancement sans moteur : l'assistant d'accueil, une fois l'interface prête (SPEC §21.3).
  let welcomed = false;
  const welcome = () => {
    if (welcomed) return;
    welcomed = true;
    import('./welcome.js').then((m) => m.maybeWelcome?.()).catch((err) => console.warn('[library] welcome', err?.message || err));
  };
  on('app:ready', welcome);
  setTimeout(welcome, 8000);   // si app:ready n'arrive jamais (un module en panne), l'accueil vient quand même
}

// ── installateur : état, événements ──────────────────────────────────
const LIVE = new Set(['queued', 'downloading', 'verifying']);
const instApi = () => mia().installer || null;
const jobOf = (key) => (dl?.queue || []).find((j) => j.key === key) || null;

async function refreshInst() {
  const api = instApi();
  if (!api || typeof api.list !== 'function') return;
  let r = null;
  try { r = await api.list(); } catch (err) { r = null; console.warn('[library] installer.list', err); }
  if (!r || r.ok === false) return;
  inst = r;
  dl = { queue: r.queue || [], active: dl?.active || null, left: dl?.left || 0 };
  for (const j of dl.queue) if (!lastStates.has(j.key)) lastStates.set(j.key, j.state);
  liveSig = '';
  repaint();
}
const refreshInstSoon = debounce(refreshInst, 250);

function onInstallerEvent(ev) {
  if (!ev || typeof ev !== 'object' || ev.kind === 'engine') return;   // le moteur : welcome.js
  if (ev.status) dl = ev.status;
  const j = ev.job;
  if (j && j.key) {
    const was = lastStates.get(j.key);
    lastStates.set(j.key, j.state);
    if (was !== j.state) {
      if (j.state === 'done') announceDone(j);
      else if (j.state === 'error') announceError(j);
      if (j.state === 'done' || j.state === 'error') refreshInstSoon();
    }
  }
  if (!liveFrame) liveFrame = requestAnimationFrame(() => { liveFrame = 0; liveTick(); });
}

// « installé » une fois par modèle : BiRefNet, c'est quatre fichiers mais un seul message. Pas de toast quand la
// bibliothèque est ouverte : la ligne du panneau le dit déjà.
function announceDone(j) {
  if (isOpen) return;
  const same = (dl?.queue || []).filter((x) => x.model === j.model);
  if (same.some((x) => x.state !== 'done')) return;
  const head = same.find((x) => x.key === j.model) || j;
  toast(t('lib.inst.doneToast', { name: tl(head.label) }), { kind: 'ok' });
}
// Les échecs arrivent souvent ensemble (les fichiers de LTX dont la licence n'est pas acceptée) : un seul message
// court, le détail reste dans le panneau des téléchargements — et aucun message s'il est déjà sous les yeux.
let failed = [];
let failTimer = 0;
function announceError(j) {
  failed.push(j);
  clearTimeout(failTimer);
  failTimer = setTimeout(() => {
    const list = failed;
    failed = [];
    if (isOpen) return;
    const see = { label: t('lib.inst.see'), run: () => openLibrary({}) };
    const gated = list.filter((x) => /^gated/.test(x.errorCode || ''));
    if (gated.length === list.length) {
      // le nom du modèle principal (« LTX 2.5 ») plutôt que celui d'une de ses pièces
      const head = gated.slice().sort((a, b) => (b.bytes || 0) - (a.bytes || 0))[0];
      toast(t('lib.inst.gatedToast', { name: tl(head.label) }), { kind: 'error', ms: 9000, action: see });
    } else if (list.length === 1) {
      toast(t('lib.inst.failToast', { name: tl(list[0].label) }), { kind: 'error', ms: 9000, action: see });
    } else {
      toast(tn('lib.inst.failMany', list.length), { kind: 'error', ms: 9000, action: see });
    }
  }, 600);
}

// À chaque événement (au plus une fois par image) : le panneau, les pastilles de « Il manque », le bouton de la barre.
function liveTick() {
  const sig = (dl?.queue || []).map((j) => `${j.key}:${j.state}`).join('|');
  if (ui && isOpen) {
    paintDownloads();
    if (sig !== liveSig) { liveSig = sig; paintMissing(inv()); }
    else updateChips();
  }
  for (const fn of tbPainters) { try { fn(); } catch { /* bouton démonté */ } }
}

async function install(req) {
  const api = instApi();
  if (!api) return;
  // pas de moteur : le bouton reste cliquable et mène à l'assistant, qui dit quoi faire
  if (inst && inst.engineReady === false) { openWelcome({}); return; }
  let r = null;
  try { r = await api.start(req); } catch (err) { r = { ok: false, error: String(err?.message || err) }; }
  if (!r || r.ok === false) {
    if (r?.code === 'no-engine') { openWelcome({}); return; }
    toast(t('lib.inst.failed', { msg: r?.error || '—' }), { kind: 'error', ms: 9000 });
    return;
  }
  // un modèle à licence sans jeton n'est pas mis en file : son usage se déplie sur la note où coller le jeton
  if (r.blocked?.length) {
    for (const [cap, c] of Object.entries(inst?.caps || {})) if (c.missing.some((k) => r.blocked.includes(k))) { missingOpen.add(cap); missingShut.delete(cap); }
  }
  if (!isOpen) {
    const see = { label: t('lib.inst.see'), run: () => openLibrary({}) };
    if (r.queued?.length) {
      const bytes = r.queued.reduce((s, k) => s + (inst?.files?.[k]?.bytes || 0), 0);
      toast(tn('lib.inst.started', r.queued.length, { size: gbText(bytes / 1e9) }), { action: see });
    } else if (r.blocked?.length) {
      const head = r.blocked.map((k) => inst?.files?.[k]).filter(Boolean).sort((a, b) => (b.bytes || 0) - (a.bytes || 0))[0];
      toast(t('lib.inst.gatedToast', { name: tl(head?.label) || '—' }), { kind: 'info', ms: 9000, action: see });
    } else toast(r.message || t('lib.inst.nothing'));
  } else if (!r.queued?.length && !r.blocked?.length) toast(r.message || t('lib.inst.nothing'));
  refreshInst();
}
const jobAct = async (what, arg) => {
  try { await instApi()?.[what]?.(arg); } catch (err) { console.warn('[library] installer', what, err); }
  refreshInstSoon();
};
const openPage = (url) => { if (/^https:\/\//.test(String(url || ''))) window.open(url); };

/**
 * Le jeton Hugging Face collé dans Mia : le principal le vérifie auprès de Hugging Face, le range dans le fichier de
 * Hugging Face (comme « hf auth login ») et relance les fichiers à licence. `keys` : les fichiers à mettre en file en
 * même temps (l'accueil). → la réponse du principal ({ok, error?, user?, queued, blocked})
 */
export async function saveHfToken(token, keys = null) {
  const api = instApi();
  if (!api) return { ok: false, error: '—' };
  let r = null;
  try {
    if (keys && keys.length) r = await api.start({ token, keys });
    else if (typeof api.setToken === 'function') r = await api.setToken({ token });
    else {
      // preload sans setToken : le même travail en deux appels (jeton, puis les fichiers arrêtés faute de jeton)
      r = await api.start({ token });
      const again = (dl?.queue || []).filter((j) => j.state === 'error' && /^gated/.test(j.errorCode || '')).map((j) => j.key);
      if (r?.ok !== false && again.length) {
        const q = await api.start({ keys: again }).catch(() => null);
        if (q && q.ok !== false) r = { ...r, queued: q.queued, blocked: q.blocked };
      }
    }
  } catch (err) {
    r = { ok: false, error: String(err?.message || err) };
  }
  // la note disparaît d'elle-même une fois le jeton là : un mot pour dire que c'est fait
  if (r && r.ok !== false) toast(r.user ? t('lib.tok.savedFor', { user: r.user }) : t('lib.tok.saved'), { kind: 'ok' });
  refreshInst();
  return r || { ok: false, error: '—' };
}

/**
 * La note d'un modèle à licence : quoi faire en une phrase, les pages à ouvrir, le champ où coller son jeton, et en
 * petit l'autre façon (la commande « hf auth login » du moteur). Partagée avec l'accueil (welcome.js).
 *   groups : [{ label, page }] (un par dépôt à licence) · cli : chemin de hf.exe du moteur (ou null)
 *   tokenPage : la page des jetons · onSave(token) → Promise<{ok, error?, user?}> · denied : la phrase « pas encore
 *   accès » (jeton déjà là, licence pas acceptée) — alors pas de champ, un bouton Réessayer (onRetry)
 */
export function tokenNote({ groups = [], cli = null, tokenPage = 'https://huggingface.co/settings/tokens', onSave, denied = null, onRetry = null, pages = true } = {}) {
  const names = groups.map((g) => tl(g.label)).filter(Boolean);
  let name = names[0] || 'Hugging Face';
  try { if (names.length > 1) name = new Intl.ListFormat(locale(), { type: 'conjunction' }).format(names); } catch { name = names.join(', '); }
  const body = el('div', { class: 'lib-tok-body' });
  const box = el('div', { class: 'lib-tok', role: 'group' }, el('span', { class: 'lib-tok-ico', html: icon('info', 13) }), body);
  body.append(el('p', { class: 'lib-tok-lead' }, denied || t(names.length > 1 ? 'lib.tok.leadMany' : 'lib.tok.lead', { name })));
  const links = el('div', { class: 'lib-tok-links' });
  // (pages:false : les lignes des téléchargements ont déjà « Ouvrir la page »)
  for (const g of pages ? groups : []) {
    if (!/^https:\/\//.test(String(g.page || ''))) continue;
    links.append(button({ label: groups.length > 1 ? t('lib.tok.pageOf', { name: tl(g.label) }) : t('lib.tok.page'), icon: 'external', kind: 'ghost', size: 'xs', onClick: () => openPage(g.page) }));
  }
  if (denied) {
    if (onRetry) links.append(button({ label: t('lib.tok.retry'), icon: 'refresh', kind: 'ghost', size: 'xs', onClick: onRetry }));
    if (links.childNodes.length) body.append(links);
    box.classList.add('is-denied');
    return box;
  }
  links.append(button({ label: t('lib.tok.create'), icon: 'external', kind: 'ghost', size: 'xs', onClick: () => openPage(tokenPage) }));
  body.append(links);
  const field = textField({ placeholder: t('lib.tok.ph'), size: 'sm', mono: true });
  field.type = 'password';
  field.setAttribute('aria-label', t('lib.tok.ph'));
  field.classList.add('lib-tok-field');
  const msg = el('p', { class: 'lib-tok-msg', hidden: true, 'aria-live': 'polite' });
  const say = (text, kind) => { msg.hidden = !text; msg.textContent = text || ''; msg.classList.toggle('err', kind === 'err'); };
  let busy = false;
  const save = async () => {
    if (busy) return;
    const v = field.value.trim();
    if (!v) { say(t('lib.tok.empty'), 'err'); field.focus(); return; }
    busy = true;
    btn.setValue(t('lib.tok.saving'));
    btn.setDisabled(true);
    say('');
    let r = null;
    try { r = await onSave?.(v); } catch (err) { r = { ok: false, error: String(err?.message || err) }; }
    busy = false;
    btn.setValue(t('lib.tok.save'));
    btn.setDisabled(false);
    if (!r || r.ok === false) { say(r?.error || '—', 'err'); field.select(); return; }
    field.setValue('');
    say(r.user ? t('lib.tok.savedFor', { user: r.user }) : t('lib.tok.saved'), 'ok');
  };
  const btn = button({ label: t('lib.tok.save'), size: 'sm', onClick: save });
  field.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); save(); } });
  body.append(el('div', { class: 'lib-tok-row' }, field, btn), msg);
  // en petit : où va le jeton, et l'autre façon de faire, avec la commande exacte du moteur
  const cmd = cli ? `"${cli}" auth login` : 'hf auth login';
  const copy = el('button', { class: 'lib-tok-copy', type: 'button', 'aria-label': t('lib.tok.copy'), tip: t('lib.tok.copy'), html: icon('copy', 12) });
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(cmd); toast(t('lib.tok.copied'), { kind: 'ok' }); } catch { toast(t('lib.copyFailed'), { kind: 'error' }); }
  });
  body.append(el('p', { class: 'lib-tok-keep' }, t('lib.tok.keep')),
    el('p', { class: 'lib-tok-cli' }, t('lib.tok.cli')),
    el('div', { class: 'lib-tok-cmdrow' }, el('code', { class: 'lib-tok-cmd' }, cmd), copy));
  return box;
}

/** Ouvre l'assistant de premier lancement (« Configurer le moteur… »). */
export function openWelcome(opts = {}) {
  closeLibrary();
  return import('./welcome.js').then((m) => m.openWelcome?.(opts)).catch((err) => console.warn('[library] welcome', err?.message || err));
}

function repaint() {
  for (const fn of painters) {
    try { fn(); } catch (err) { console.error('[library] repaint', err); }
  }
}

// =====================================================================
// Bouton « Modèles » de la barre de titre
// =====================================================================
export function mountModelsButton(container) {
  if (!container || container.querySelector('.lib-tb')) return;
  wire();
  const count = el('span', { class: 'lib-tb-count' });
  const btn = el('button', { class: 'tb-btn lib-tb', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
    el('span', { class: 'lib-tb-ico', html: icon('models', 15) }),
    el('span', { class: 'lib-tb-label' }, t('lib.button')),
    count);
  btn.addEventListener('click', (e) => { e.stopPropagation(); toggleLibrary(); });
  // pendant un téléchargement : le pourcentage à la place du compte, et un filet de 2 px sous le bouton
  const bar = el('i', { class: 'lib-tb-bar', 'aria-hidden': 'true' });
  btn.append(bar);
  tip(btn, () => {
    const i = inv();
    const d = dlSummary();
    if (d) return t('lib.inst.tbTip', { pct: pctText(d.frac), left: t('lib.inst.left', { size: gbText(d.left / 1e9) }) });
    if (!i) return t('lib.loading');
    // Une ligne : le nombre de modèles prêts, puis ce qui manque (l'info-bulle ne coupe pas les lignes).
    return [tn('lib.buttonTip', readyCount(i)), ...(i.missing || []).map((m) => tl(m.what))].join(' · ');
  }, { placement: 'bottom' });

  // SPEC §6.1 : [Modèles] [GPU] [Réglages]. Un voisin peut s'insérer en tête plus tard : on reprend la place.
  container.prepend(btn);
  new MutationObserver(() => { if (container.firstElementChild !== btn && btn.isConnected) container.prepend(btn); })
    .observe(container, { childList: true });

  const paint = () => {
    const i = inv();
    const d = dlSummary();
    count.textContent = d ? pctText(d.frac) : i ? num(readyCount(i), 0) : '';
    btn.classList.toggle('dl', !!d);
    bar.style.transform = `scaleX(${d ? Math.max(0.02, d.frac) : 0})`;
    btn.classList.toggle('on', isOpen);
    btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  };
  painters.add(paint);
  tbPainters.add(paint);
  paint();
}

const tbPainters = new Set();
// La file en cours, en un chiffre : la part faite des fichiers en attente ou en route (null s'il n'y en a pas).
function dlSummary() {
  const live = (dl?.queue || []).filter((j) => LIVE.has(j.state));
  if (!live.length) return null;
  const total = live.reduce((s, j) => s + (j.bytes || 0), 0);
  const done = live.reduce((s, j) => s + Math.min(j.done || 0, j.bytes || 0), 0);
  return { frac: total ? done / total : 0, left: total - done, total, n: live.length };
}
const pctText = (f) => t('lib.inst.pct', { n: num(Math.floor(Math.max(0, Math.min(1, f)) * 100), 0) });

// =====================================================================
// Panneau latéral
// =====================================================================
export function mountLibrary(target = document.getElementById('library')) {
  if (mounted || !target) return;
  mounted = true;
  wire();
  host = target;
  host.classList.add('lib');
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-label', t('lib.dialog'));

  const search = el('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: t('lib.search'), 'aria-label': t('lib.search') });
  const rescanBtn = button({ label: t('lib.rescan'), icon: 'refresh', kind: 'ghost', size: 'sm', tip: t('lib.rescanTip'), onClick: () => runScan('rescan') });
  const deepBtn = button({ label: t('lib.deep'), icon: 'lib-deep', kind: 'ghost', size: 'sm', tip: t('lib.deepTip'), onClick: () => runScan('deep') });
  const closeBtn = el('button', { class: 'tb-chip lib-close', type: 'button', 'aria-label': t('lib.close'), tip: t('lib.close'), html: icon('close', 15) });

  ui = {
    scrim: el('div', { class: 'lib-scrim' }),
    sheet: el('section', { class: 'lib-sheet' }),
    bar: el('div', { class: 'lib-progress' }, el('i')),
    title: el('h2', { class: 'lib-title' }, t('lib.title')),
    sum: el('div', { class: 'lib-sum' }),
    status: el('div', { class: 'lib-status' }),
    search, rescanBtn, deepBtn,
    filter: el('div', { class: 'lib-filter', hidden: true }),
    engine: el('div', { class: 'lib-engine', hidden: true }),
    dl: el('section', { class: 'lib-dl', hidden: true, 'aria-live': 'polite' }),
    missing: el('div', { class: 'lib-missing', hidden: true }),
    body: el('div', { class: 'lib-body' }),
  };
  const head = el('header', { class: 'lib-head' },
    el('div', { class: 'lib-head-top' }, el('span', { class: 'kicker' }, t('lib.kicker')), closeBtn),
    el('div', { class: 'lib-head-title' }, ui.title, ui.sum),
    ui.status, ui.engine);
  const tools = el('div', { class: 'lib-tools' },
    el('label', { class: 'search lib-search' }, el('span', { html: icon('search', 14) }), search),
    rescanBtn, deepBtn);
  // un seul défilement pour tout le panneau : téléchargements, ce qui manque, puis la liste des modèles
  ui.top = el('div', { class: 'lib-top' }, ui.dl, ui.missing);
  ui.scroll = el('div', { class: 'lib-scroll' }, ui.top, ui.body);
  ui.sheet.append(ui.bar, head, tools, ui.filter, ui.scroll);
  host.append(ui.scrim, ui.sheet);

  ui.scrim.addEventListener('pointerdown', () => closeLibrary());
  closeBtn.addEventListener('click', () => closeLibrary());
  const onSearch = debounce(() => { query = search.value.trim(); paintList(); }, 90);
  search.addEventListener('input', onSearch);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; query = ''; paintList(); }
  });
  // Clic droit dans le panneau : jamais le menu de Windows ; sur une ligne, notre menu.
  ui.sheet.addEventListener('contextmenu', (e) => {
    if (e.target.closest('input, textarea')) return;
    e.preventDefault();
    const row = e.target.closest('[data-path]');
    if (row) fileMenu(row.dataset.path, { x: e.clientX, y: e.clientY }, row.dataset.id ? byId(row.dataset.id) : null);
  });
  document.addEventListener('keydown', onKey, true);

  painters.add(() => { if (isOpen) paintPanel(); });
}

function onKey(e) {
  if (!isOpen || e.key !== 'Escape' || isMenuOpen()) return;
  if (e.target === ui.search && ui.search.value) return;   // le champ efface d'abord sa recherche
  if (document.querySelector('.modal-scrim')) return;   // une modale au-dessus garde son Échap
  e.stopPropagation();
  e.preventDefault();
  closeLibrary();
}

export function openLibrary({ caps } = {}) {
  if (!mounted) mountLibrary();
  if (!host) return;
  filterCaps = Array.isArray(caps) && caps.length ? caps.slice() : (typeof caps === 'string' ? [caps] : null);
  expanded.clear();
  // Une recherche d'avant ne doit jamais donner un premier écran vide (« Voir tous les modèles » d'un bloc).
  query = '';
  if (ui) ui.search.value = '';
  if (!isOpen) {
    isOpen = true;
    returnFocus = document.activeElement;
    host.hidden = false;
    host.classList.remove('out');
  }
  paintPanel();
  repaint();
  refreshInst();
  if (ui) ui.scroll.scrollTop = 0;
  requestAnimationFrame(() => ui.search.focus({ preventScroll: true }));
}

export function closeLibrary() {
  if (!isOpen || !host) return;
  isOpen = false;
  host.classList.add('out');
  const done = () => { if (!isOpen) { host.hidden = true; host.classList.remove('out'); } };
  host.addEventListener('animationend', done, { once: true });
  setTimeout(done, ms('exit') + 60);   // si l'animation est coupée (mouvement réduit : ms() vaut 0)
  // Le focus revient là où il était (le bouton « Modèles », un bloc…), pas sur le corps de la page.
  if (returnFocus && returnFocus.isConnected && host.contains(document.activeElement)) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
  repaint();
}

export const toggleLibrary = () => (isOpen ? closeLibrary() : openLibrary({}));

// « 233 Go pour Mia · 43 Go d'autres applis » : le compte des prêts n'est jamais accolé au total du disque.
function sizesText(i) {
  const s = i.summary || {};
  const all = s.sizeGB ?? i.models.reduce((a, m) => a + (m.sizeGB || 0), 0);
  const apps = s.appsGB ?? i.models.filter((m) => m.status === 'other-app').reduce((a, m) => a + (m.sizeGB || 0), 0);
  const miaGB = s.miaGB ?? (all - apps);
  return apps > 0.05 ? t('lib.sizes', { mia: gbText(miaGB), apps: gbText(apps) }) : t('lib.sizesMia', { mia: gbText(miaGB) });
}

function paintPanel() {
  if (!ui) return;
  const i = inv();
  const raw = state.inventory;
  ui.sum.textContent = i ? `${tn('lib.ready', readyCount(i))} · ${sizesText(i)}` : '';
  paintStatus(i, raw);
  paintEngine();
  paintProgress();
  paintFilter();
  paintDownloads();
  liveSig = (dl?.queue || []).map((j) => `${j.key}:${j.state}`).join('|');
  paintMissing(i);
  paintList();
}

// Pas de moteur sur ce PC : une ligne sobre et l'accès à l'assistant d'accueil.
function paintEngine() {
  const box = ui.engine;
  box.textContent = '';
  const none = !!inst && inst.engineReady === false;
  box.hidden = !none;
  if (!none) return;
  box.append(el('span', { class: 'lib-engine-ico', html: icon('info', 13) }),
    el('span', { class: 'lib-engine-txt' }, t('lib.inst.noEngine')),
    button({ label: t('lib.inst.setup'), kind: 'ghost', size: 'xs', onClick: () => openWelcome({}) }));
}

// ── Téléchargements : la file du principal, une ligne par fichier ────
// Les fichiers d'un même dépôt à licence, arrêtés faute d'accord (LTX : quatre fichiers), ne font qu'une ligne :
// « LTX 2.5 · 4 fichiers · licence à accepter », avec Ouvrir la page et Réessayer.
function jobLine(j) {
  if (j.group) return j.keys.length > 1 ? t('lib.inst.gatedRow', { n: num(j.keys.length, 0) }) : t('lib.inst.gatedRowOne');
  const total = gbText((j.bytes || 0) / 1e9);
  const done = gbText((j.done || 0) / 1e9);
  const frac = j.bytes ? Math.min(1, (j.done || 0) / j.bytes) : 0;
  switch (j.state) {
    case 'queued': return t('lib.inst.st.queued', { total });
    case 'downloading': {
      if (j.phase === 'connect' && !j.speed) return t('lib.inst.st.connect');
      const bits = [t('lib.inst.st.downloading', { done, total, speed: gbText((j.speed || 0) / 1e9) })];
      if (j.eta != null) bits.push(j.eta < 90 ? t('lib.inst.endSoon') : t('lib.inst.endAt', { clock: fmtClock(Date.now() + j.eta * 1000) }));
      return bits.join(' · ');
    }
    case 'verifying': return t('lib.inst.st.verifying', { pct: pctText(j.verified ?? 0) });
    case 'paused': return t('lib.inst.st.paused', { done, total, pct: pctText(frac) });
    case 'done': return t('lib.inst.st.done', { total });
    case 'error': return /^gated/.test(j.errorCode || '') ? t('lib.inst.st.gated') : j.error || t('lib.inst.chip.error');
    default: return '';
  }
}

function iconBtn(name, label, run, cls = '') {
  const b = el('button', { class: ['lib-dl-btn', cls], type: 'button', 'aria-label': label, tip: label, html: icon(name, 13) });
  b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
  return b;
}

// Les lignes vivent d'un dessin à l'autre : seuls les textes et la barre changent, la barre glisse (--dur-rise
// linéaire, da.md §4.12) au lieu de sauter à chaque événement.
const dlRows = new Map();     // clé (ou « gated:<dépôt> ») → { row, pct, meta, bar, side, sig }
let dlHead = null;            // { count, when, actions, sig }

function dlRow(j) {
  const r = { sig: null };
  r.pct = el('span', { class: 'lib-dl-pct' });
  r.meta = el('div', { class: 'lib-dl-meta' });
  r.bar = el('i');
  r.side = el('div', { class: 'lib-dl-side' });
  r.name = el('span', { class: 'lib-dl-name' });
  r.row = el('div', { class: 'lib-dl-row', dataset: { key: j.key } },
    el('div', { class: 'lib-dl-main' },
      el('div', { class: 'lib-dl-top' }, r.name, r.pct),
      r.meta,
      el('div', { class: 'lib-dl-bar' }, r.bar)),
    r.side);
  return r;
}

function dlSide(r, j) {
  r.side.textContent = '';
  if (j.group) {
    // un dépôt à licence : sa page, Réessayer quand un jeton est là (sinon la note juste au-dessus en demande un)
    if (j.page) r.side.append(iconBtn('external', t('lib.inst.page'), () => openPage(j.page)));
    if (inst?.token) r.side.append(iconBtn('refresh', t('lib.inst.retry'), () => install({ keys: j.keys })));
    r.side.append(iconBtn('close', t('lib.inst.cancel'), () => { for (const k of j.keys) jobAct('cancel', k); }));
    return;
  }
  if (j.state === 'downloading' || j.state === 'verifying') r.side.append(iconBtn('pause', t('lib.inst.pause'), () => jobAct('pause', j.key)));
  if (j.state === 'paused') r.side.append(iconBtn('play', t('lib.inst.resume'), () => install({ keys: [j.key] })));
  if (j.state === 'error') r.side.append(iconBtn('refresh', t('lib.inst.retry'), () => install({ keys: [j.key] })));
  if (j.state !== 'done') r.side.append(iconBtn('close', t('lib.inst.cancel'), () => jobAct('cancel', j.key)));
  else r.side.append(el('span', { class: 'lib-dl-ok', html: icon('check', 13) }));
}

// La file telle qu'on la montre : les fichiers arrêtés d'un même dépôt à licence regroupés en une ligne.
function dlItems(q) {
  const items = [];
  const byRepo = new Map();
  for (const j of q) {
    if (j.state === 'error' && /^gated/.test(j.errorCode || '')) {
      const repo = inst?.files?.[j.key]?.repo || j.key;
      let g = byRepo.get(repo);
      if (!g) {
        g = { key: `gated:${repo}`, group: true, repo, keys: [], state: 'error', label: j.label, bytes: 0, done: 0, page: j.page, errorCode: j.errorCode, head: 0 };
        byRepo.set(repo, g);
        items.push(g);
      }
      g.keys.push(j.key);
      g.bytes += j.bytes || 0;
      if ((j.bytes || 0) > g.head) { g.head = j.bytes || 0; g.label = j.label; g.page = j.page || g.page; }
      if (j.errorCode === 'gated-no-token') g.errorCode = 'gated-no-token';
    } else items.push(j);
  }
  return items;
}

// La note d'un modèle à licence se garde d'un dessin à l'autre : le jeton qu'on est en train de coller ne s'efface
// pas quand un téléchargement avance.
const notes = { dl: { sig: null, node: null }, missing: { sig: null, node: null } };
function keptNote(where, sig, make) {
  const n = notes[where];
  if (n.sig !== sig || !n.node) { n.sig = sig; n.node = make(); }
  return n.node;
}
const groupsOf = (items) => items.map((g) => ({ label: g.label, page: g.page }));

function paintDownloads() {
  if (!ui) return;
  const box = ui.dl;
  const q = dl?.queue || [];
  box.hidden = !q.length;
  if (!q.length) { box.textContent = ''; dlRows.clear(); dlHead = null; return; }
  if (!dlHead || !box.contains(dlHead.count)) {
    box.textContent = '';
    dlRows.clear();
    dlHead = { count: el('span', { class: 'lib-sec-count' }), when: el('span', { class: 'lib-dl-when' }), actions: el('div', { class: 'lib-dl-actions' }), sig: '' };
    dlHead.list = el('div', { class: 'lib-dl-list' });
    dlHead.note = el('div', { class: 'lib-dl-note', hidden: true });
    box.append(el('div', { class: 'lib-dl-head' }, el('span', { class: 'kicker' }, t('lib.inst.kicker')), dlHead.count, dlHead.when, dlHead.actions), dlHead.note, dlHead.list);
  }
  const items = dlItems(q);
  // en-tête : combien, ce qui reste, l'heure de fin ; les boutons seulement quand leur sens change
  const d = dlSummary();
  let when = '';
  if (d) {
    const speed = q.find((j) => j.state === 'downloading')?.speed || 0;
    when = t('lib.inst.left', { size: gbText(d.left / 1e9) });
    if (speed > 1) {
      const eta = d.left / speed;
      when += ' · ' + (eta < 90 ? t('lib.inst.endSoon') : t('lib.inst.endAt', { clock: fmtClock(Date.now() + eta * 1000) }));
    }
  }
  dlHead.count.textContent = num(items.length, 0);
  dlHead.when.textContent = when;
  const anyLive = q.some((j) => LIVE.has(j.state));
  const finished = q.some((j) => j.state === 'done' || j.state === 'error');
  const sig = `${anyLive}|${finished}`;
  if (sig !== dlHead.sig) {
    dlHead.sig = sig;
    dlHead.actions.textContent = '';
    if (anyLive) dlHead.actions.append(button({ label: t('lib.inst.pauseAll'), kind: 'ghost', size: 'xs', onClick: () => jobAct('pause') }));
    if (finished) dlHead.actions.append(button({ label: t('lib.inst.clear'), kind: 'ghost', size: 'xs', onClick: () => jobAct('clear') }));
  }
  // un dépôt à licence arrêté : l'explication une seule fois au-dessus des lignes — le champ du jeton s'il n'y en a
  // pas, sinon la phrase « ton compte n'a pas encore accès » (les lignes ont déjà la page et Réessayer)
  const gated = items.filter((x) => x.group);
  const noTok = !inst?.token ? gated.filter((g) => g.errorCode === 'gated-no-token') : [];
  const denied = gated.filter((g) => g.errorCode === 'gated-denied');
  const gsig = `${noTok.map((g) => g.key).join(',')}|${denied.map((g) => g.key).join(',')}|${inst?.hfCli || ''}`;
  const hadFocus = document.activeElement && dlHead.note.contains(document.activeElement) ? document.activeElement : null;
  let note = null;
  if (noTok.length) {
    note = keptNote('dl', gsig, () => tokenNote({ groups: groupsOf(noTok), cli: inst?.hfCli, tokenPage: inst?.tokenPage, pages: false, onSave: (tok) => saveHfToken(tok) }));
  } else if (denied.length) {
    const names = denied.map((g) => tl(g.label)).join(', ');
    note = keptNote('dl', gsig, () => tokenNote({ groups: groupsOf(denied), denied: t('lib.tok.denied', { name: names }), pages: false }));
  }
  if (dlHead.note.firstChild !== note) {
    dlHead.note.textContent = '';
    if (note) dlHead.note.append(note);
  }
  dlHead.note.hidden = !note;
  if (hadFocus && hadFocus.isConnected && document.activeElement !== hadFocus) hadFocus.focus({ preventScroll: true });
  // lignes : créées une fois, mises à jour sur place, dans l'ordre de la file
  const keep = new Set(items.map((j) => j.key));
  for (const [k, r] of dlRows) if (!keep.has(k)) { r.row.remove(); dlRows.delete(k); }
  let prev = null;
  for (const j of items) {
    let r = dlRows.get(j.key);
    if (!r) { r = dlRow(j); dlRows.set(j.key, r); }
    const frac = j.state === 'verifying' ? (j.verified ?? 0) : j.state === 'done' ? 1 : j.bytes ? Math.min(1, (j.done || 0) / j.bytes) : 0;
    const rsig = `${j.state}|${j.group ? j.keys.length + j.errorCode + (inst?.token ? 't' : '') : ''}`;
    if (r.sig !== rsig) {
      r.sig = rsig;
      r.row.className = `lib-dl-row st-${j.state}${j.group ? ' is-gated' : ''}`;
      dlSide(r, j);
    }
    r.name.textContent = tl(j.label) || j.key;
    r.pct.textContent = j.state === 'done' || (j.state === 'error' && !j.done) ? '' : pctText(frac);
    r.meta.textContent = jobLine(j);
    r.bar.style.transform = `scaleX(${frac})`;
    const want = prev ? prev.nextSibling : dlHead.list.firstChild;
    if (want !== r.row) dlHead.list.insertBefore(r.row, want);
    prev = r.row;
  }
}

function paintStatus(i, raw) {
  const s = ui.status;
  s.textContent = '';
  const err = raw && raw.error;
  if (!i || err) {
    s.append(el('span', { class: ['lib-dot', err && 'err'] }), el('span', {}, err ? t('lib.loadFailed', { msg: err }) : t('lib.loading')));
    return;
  }
  const c = i.comfy || {};
  // pas de moteur de Mia : on ne promet pas qu'il « démarrera tout seul » ; un ComfyUI d'une autre appli qui répond
  // n'est pas le moteur (même règle que le principal)
  const noEngine = !!inst && inst.engineReady === false;
  // le ComfyUI qui répond n'est « le moteur en marche » que s'il est celui de Mia ; celui d'une autre appli ne compte
  // pas (le moteur de Mia démarrera à côté, au premier calcul)
  const running = c.reachable && !(inst && inst.comfyIsEngine === false);
  const text = noEngine
    ? (inst.foreignComfy ? t('lib.foreign', { port: inst.foreignComfy.port || '?' }) : t('lib.noEngine'))
    : running ? t('lib.comfyOn', { version: c.version || '?' }) : t('lib.comfyOff');
  s.append(el('span', { class: ['lib-dot', !noEngine && running && 'on'] }), el('span', { class: 'lib-status-txt' }, text));
  if (i.scannedAt) s.append(el('span', { class: 'lib-status-sep' }, '·'), el('span', { class: 'lib-status-when' }, t('lib.scannedAt', { when: relTime(i.scannedAt), ms: msText(i.durationMs || 0) })));
}

// Barre de 2 px (le seul indicateur animé de Mia, da.md §3.2) et la phase en texte, pendant un scan visible.
function paintProgress() {
  if (!ui) return;
  const p = progress;
  const visible = !!userScan || (p && p.phase === 'identify' && p.total > 3 && !p.final);
  ui.sheet.classList.toggle('is-scanning', !!visible);
  ui.rescanBtn.setDisabled?.(!!userScan);
  ui.deepBtn.setDisabled?.(!!userScan);
  const fill = ui.bar.firstChild;
  if (!visible) { fill.style.transform = 'scaleX(0)'; ui.bar.classList.remove('indet'); return; }
  const frac = p && p.phase === 'identify' && p.total ? Math.min(1, p.done / p.total) : null;
  ui.bar.classList.toggle('indet', frac == null);
  if (frac != null) fill.style.transform = `scaleX(${frac})`;
  let txt = t('lib.loading');
  if (p) {
    if (p.phase === 'comfy') txt = t('lib.phase.comfy');
    else if (p.phase === 'walk') txt = t('lib.phase.walk', { n: num(p.done || 0, 0) });
    else if (p.phase === 'identify') txt = t('lib.phase.identify', { done: num(p.done || 0, 0), total: num(p.total || 0, 0) });
    else if (p.phase === 'group') txt = t('lib.phase.group');
    else if (p.phase === 'done') txt = t('lib.phase.done');
  }
  ui.status.textContent = '';
  ui.status.append(el('span', { class: 'lib-dot on' }), el('span', { class: 'lib-status-phase' }, txt));
}

function paintFilter() {
  const f = ui.filter;
  f.textContent = '';
  f.hidden = !filterCaps;
  ui.top.classList.toggle('filtered', !!filterCaps);
  if (!filterCaps) return;
  const clear = el('button', { class: 'lib-chip-x', type: 'button', 'aria-label': t('lib.filterClear'), tip: t('lib.filterClear'), html: icon('close', 11) });
  clear.addEventListener('click', () => { filterCaps = null; paintPanel(); });
  f.append(el('span', { class: 'lib-chip' }, t('lib.filter', { what: filterCaps.map(capLabel).join(', ') }), clear));
}

// « Il manque » : une ligne résumé par usage — son nom, puis « Installer (21,5 Go) » ou son état (« Licence à
// accepter », « Téléchargement · 42 % ») — qui se déplie sur ses modèles. Un bloc qui a demandé un usage l'ouvre
// d'office. Les fichiers déjà dans « Téléchargements » ne sont pas répétés ; un modèle à licence sans jeton n'a pas
// de bouton : la note où coller son jeton apparaît dans l'usage déplié. Un manque que Mia ne sait pas installer
// donne le fichier à ajouter et le dossier où le ranger ; en bas, le bouton pour relire.
const inQueue = (k) => { const j = jobOf(k); return !!j && j.state !== 'done'; };
// Les fichiers manquants d'un usage, en trois parts : déjà dans la file, bloqués (licence sans jeton), à installer.
function splitKeys(keys) {
  const queued = [], blocked = [], free = [];
  for (const k of keys) {
    if (inQueue(k)) queued.push(k);
    else if (inst?.files?.[k]?.gated && !inst.token) blocked.push(k);
    else free.push(k);
  }
  return { queued, blocked, free };
}
const bytesOf = (keys) => keys.reduce((s, k) => s + (inst?.files?.[k]?.bytes || 0), 0);

function isMissingOpen(cap) {
  const auto = !!(filterCaps && filterCaps.includes(cap));
  return auto ? !missingShut.has(cap) : missingOpen.has(cap);
}
function toggleMissing(cap) {
  const auto = !!(filterCaps && filterCaps.includes(cap));
  if (auto) { if (missingShut.has(cap)) missingShut.delete(cap); else missingShut.add(cap); }
  else if (missingOpen.has(cap)) missingOpen.delete(cap); else missingOpen.add(cap);
  // seul l'usage qu'on vient de déplier fond à l'entrée ; un redessin (un téléchargement qui avance) ne clignote pas
  missingEnter = isMissingOpen(cap) ? cap : null;
  paintMissing(inv());
  missingEnter = null;
}
let missingEnter = null;

// Le côté droit d'une ligne résumé : le geste possible, sinon l'état.
function summarySide(cap, parts) {
  const side = el('span', { class: 'lib-missing-side' });
  const qs = parts.queued.length ? groupState({ keys: parts.queued }) : null;
  const qGated = !!qs && qs.state === 'error' && /^gated/.test(qs.job?.errorCode || '');
  // « Licence à accepter » une seule fois, que les fichiers soient mis de côté ou arrêtés dans la file
  if (parts.blocked.length || qGated) side.append(el('span', { class: 'lib-inst-chip st-gated' }, t('lib.inst.chip.gated')));
  if (parts.free.length) {
    side.append(installButton(parts.free, () => install({ keys: parts.free })));
  } else if (qs && qs.state && !qGated) {
    side.append(el('span', { class: ['lib-inst-chip', 'st-' + qs.state], dataset: { chip: parts.queued.join(' ') } }, chipText(qs)));
  } else if (parts.blocked.length && !qGated) {
    side.append(el('span', { class: 'lib-missing-size' }, gbText(bytesOf(parts.blocked) / 1e9)));
  }
  return side;
}

// « Installer (21,5 Go) » ; sans moteur, le même bouton mène à l'assistant (rien n'est grisé sans explication).
function installButton(keys, run, label = null) {
  const noEngine = !!inst && inst.engineReady === false;
  return button({ label: label || t('lib.inst.install', { size: gbText(bytesOf(keys) / 1e9) }), icon: 'lib-dl', kind: 'ghost', size: 'xs',
    tip: noEngine ? t('lib.inst.setupTip') : null, onClick: noEngine ? () => openWelcome({}) : run });
}

function paintMissing(i) {
  const box = ui.missing;
  const hadFocus = document.activeElement && box.contains(document.activeElement) ? document.activeElement : null;
  const keepScroll = ui.scroll ? ui.scroll.scrollTop : 0;
  box.textContent = '';
  const list = (i?.missing || []).filter((m) => !filterCaps || (m.caps || []).some((c) => filterCaps.includes(c)));
  box.hidden = !list.length;
  if (!list.length) return;
  box.append(el('div', { class: 'kicker' }, t('lib.missingKicker')));
  let files = 0, installable = 0;
  const listed = new Map();   // fichier déjà montré → l'usage sous lequel il l'est (LTX sert à quatre usages)
  let noteSaid = false;
  const noteShownAbove = !!(ui.dl && !ui.dl.hidden && dlHead?.note && !dlHead.note.hidden);
  for (const m of list) {
    const cap = (m.caps || [])[0];
    const ci = inst?.caps?.[cap];
    const open = isMissingOpen(cap);
    const toggle = el('button', { class: 'lib-missing-toggle', type: 'button', 'aria-expanded': open ? 'true' : 'false' },
      el('span', { class: 'lib-missing-chev', html: icon('chevron', 12) }),
      el('span', { class: 'lib-missing-cap' }, (m.caps || []).map(capLabel).join(', ')));
    toggle.addEventListener('click', () => toggleMissing(cap));
    const head = el('div', { class: 'lib-missing-row' }, toggle);
    const item = el('div', { class: ['lib-missing-item', open && 'open'] }, head);
    const sub = el('div', { class: ['lib-missing-sub', missingEnter === cap && 'enter'] });
    if (ci && ci.missing.length) {
      installable++;
      const parts = splitKeys(ci.missing);
      head.append(summarySide(cap, parts));
      if (open) {
        sub.append(el('div', { class: 'lib-missing-what' }, tl(m.what)));
        if (m.detail) sub.append(el('div', { class: 'lib-missing-detail' }, tl(m.detail)));
        const mine = parts.free.concat(parts.blocked);
        const fresh = mine.filter((k) => !listed.has(k));
        const shared = mine.filter((k) => listed.has(k));
        for (const g of missingGroups(fresh)) sub.append(installRow(g));
        if (shared.length) {
          sub.append(el('div', { class: 'lib-inst-same' },
            t(fresh.length ? 'lib.inst.plus' : 'lib.inst.same', { cap: capLabel(listed.get(shared[0])) })));
        }
        if (parts.queued.length) sub.append(el('div', { class: 'lib-inst-same' }, t(mine.length ? 'lib.inst.restQueued' : 'lib.inst.inQueue')));
        // la note de la licence, une seule fois, dans le premier usage déplié qui en a besoin
        if (parts.blocked.length && !noteSaid && !noteShownAbove) {
          noteSaid = true;
          const groups = missingGroups(parts.blocked);
          const byRepo = new Map();
          for (const g of groups) {
            const repo = inst.files[g.keys[0]]?.repo || g.id;
            if (!byRepo.has(repo) || g.bytes > byRepo.get(repo).bytes) byRepo.set(repo, g);
          }
          const reps = [...byRepo.values()].sort((a, b) => b.bytes - a.bytes);
          const sig = `${reps.map((g) => g.id).join(',')}|${inst.hfCli || ''}`;
          sub.append(keptNote('missing', sig, () => tokenNote({ groups: reps.map((g) => ({ label: g.label, page: g.page })), cli: inst.hfCli, tokenPage: inst.tokenPage, onSave: (tok) => saveHfToken(tok) })));
        }
        // les options d'un usage (fiche de référence, version rapide…) quand un bloc a demandé cet usage
        if (filterCaps && filterCaps.includes(cap)) {
          for (const o of ci.options || []) {
            const miss = o.missing.filter((k) => !inQueue(k));
            if (!miss.length) continue;
            sub.append(el('div', { class: 'lib-inst-row lib-inst-opt' },
              el('span', { class: 'lib-inst-main' },
                el('span', { class: 'lib-inst-name' }, tl(o.label)),
                el('span', { class: 'lib-inst-file' }, [t('lib.inst.option'), o.desc ? tl(o.desc) : null].filter(Boolean).join(' · '))),
              el('span', { class: 'lib-inst-side' }, installButton(miss, () => install({ option: { cap, id: o.id } })))));
          }
        }
      }
      for (const k of ci.missing) if (!listed.has(k)) listed.set(k, cap);
    } else {
      const total = (m.files || []).reduce((s, f) => s + (f.sizeGB || 0), 0);
      head.append(el('span', { class: 'lib-missing-side' }, total ? el('span', { class: 'lib-missing-size' }, `≈ ${gbText(total)}`) : null));
      files += (m.files || []).length;
      if (open) {
        sub.append(el('div', { class: 'lib-missing-what' }, tl(m.what)));
        if (m.detail) sub.append(el('div', { class: 'lib-missing-detail' }, tl(m.detail)));
        for (const f of m.files || []) {
          sub.append(el('div', { class: 'lib-missing-file', dataset: f.dir ? { path: f.dir } : {} },
            el('span', { class: 'lib-missing-name' }, f.file),
            el('span', { class: 'lib-missing-dir' }, t('lib.missing.in', { dir: f.dir || f.folder || '' })),
            f.sizeGB ? el('span', { class: 'lib-missing-size' }, `≈ ${gbText(f.sizeGB)}`) : null));
        }
      }
    }
    if (open && sub.childNodes.length) item.append(sub);
    box.append(item);
  }
  let how = '';
  if (installable && inst && inst.engineReady === false) {
    how = t('lib.inst.engineFirst');
  } else if (installable && inst) {
    how = [inst.modelsDir ? t('lib.inst.where', { dir: inst.modelsDir }) : '',
      inst.free != null && inst.drive ? t('lib.inst.free', { free: gbText(inst.free / 1e9), drive: String(inst.drive).replace(/:$/, '') }) : '']
      .filter(Boolean).join(' ');
  } else {
    const anyDownload = list.some((m) => m.download);
    const total = list.reduce((s, m) => s + (m.download ? (m.sizeGB || 0) : 0), 0);
    how = anyDownload ? t('lib.missing.download', { size: gbText(total) }) : files === 1 ? t('lib.missing.addOne') : files ? t('lib.missing.add') : '';
  }
  box.append(el('div', { class: 'lib-missing-foot' },
    how ? el('span', { class: 'lib-missing-how' }, how) : el('span'),
    button({ label: t('lib.rescan'), icon: 'refresh', kind: 'ghost', size: 'sm', onClick: () => runScan('rescan') })));
  if (ui.scroll) ui.scroll.scrollTop = keepScroll;
  if (hadFocus && hadFocus.isConnected && document.activeElement !== hadFocus) hadFocus.focus({ preventScroll: true });
}

// Les fichiers manquants d'un usage, groupés par modèle (BiRefNet = 4 fichiers, une seule ligne).
function missingGroups(keys) {
  const groups = new Map();
  for (const k of keys) {
    const f = inst.files[k];
    if (!f) continue;
    const id = f.model || k;
    if (!groups.has(id)) groups.set(id, { id, keys: [], bytes: 0, gated: false, page: f.page, label: null, file: null });
    const g = groups.get(id);
    g.keys.push(k);
    g.bytes += f.bytes || 0;
    g.gated = g.gated || f.gated;
    if (!g.label || k === id) { g.label = f.label; g.file = String(f.path || '').split('/').pop(); }
  }
  return [...groups.values()];
}

// L'état d'un groupe de fichiers d'après la file : le plus « actif » l'emporte.
function groupState(g) {
  const jobs = g.keys.map(jobOf).filter(Boolean);
  const bytes = g.keys.reduce((s, k) => s + (inst?.files?.[k]?.bytes || jobOf(k)?.bytes || 0), 0);
  const done = g.keys.reduce((s, k) => {
    const j = jobOf(k);
    return s + (j ? (j.state === 'done' ? j.bytes : Math.min(j.done || 0, j.bytes || 0)) : 0);
  }, 0);
  const frac = bytes ? done / bytes : 0;
  for (const st of ['downloading', 'verifying', 'queued', 'paused', 'error']) {
    const j = jobs.find((x) => x.state === st);
    if (j) return { state: st, frac, job: j };
  }
  if (jobs.length && jobs.length === g.keys.length && jobs.every((j) => j.state === 'done')) return { state: 'done', frac: 1 };
  return { state: null, frac };
}

const chipText = (s) => t('lib.inst.chip.' + s.state, { pct: pctText(s.frac) });

// Une ligne par modèle à installer (les fichiers déjà en file n'arrivent pas ici) : le bouton, ou « Licence à
// accepter » pour un modèle à licence tant qu'il n'y a pas de jeton (la note juste en dessous dit quoi faire).
function installRow(g) {
  const side = el('span', { class: 'lib-inst-side' });
  // à licence et sans jeton : la ligne résumé porte déjà « Licence à accepter », la note juste en dessous dit quoi faire
  if (g.gated && !inst.token) side.append(el('span', { class: 'lib-inst-size' }, gbText(g.bytes / 1e9)));
  else side.append(installButton(g.keys, () => install({ keys: g.keys })));
  return el('div', { class: 'lib-inst-row' },
    el('span', { class: 'lib-inst-main' },
      el('span', { class: 'lib-inst-name' }, tl(g.label)),
      el('span', { class: 'lib-inst-file' }, g.keys.length > 1 ? tn('lib.inst.files', g.keys.length) : g.file)),
    side);
}

// Entre deux changements d'état, seuls les pourcentages des pastilles bougent.
function updateChips() {
  if (!ui || !inst) return;
  for (const chip of ui.missing.querySelectorAll('[data-chip]')) {
    const s = groupState({ keys: chip.dataset.chip.split(' ') });
    if (s.state) chip.textContent = chipText(s);
  }
}

// ── liste ────────────────────────────────────────────────────────────
// Recherche par début de mot, dans les deux langues : « son » ne trouve plus « personnage », « upscale » trouve
// « Agrandir », « lora » trouve Mara et Theo.
const words = (s) => fold(s).split(/[\s·,.;:()[\]/\\\-_«»"'’+]+/).filter(Boolean);
function hits(hay, q) {
  const ws = words(hay);
  return words(q).every((w) => ws.some((x) => x.startsWith(w)));
}
function matches(m) {
  if (filterCaps && !(m.caps || []).some((c) => filterCaps.includes(c))) return false;
  if (!query) return true;
  const caps = (m.caps || []).flatMap((c) => { const l = inv()?.capabilities?.[c]?.label; return l ? [l.fr, l.en] : [c]; });
  const g = m.genre ? [inv()?.genres?.[m.genre]?.fr, inv()?.genres?.[m.genre]?.en, GENRE_FALLBACK[m.genre]?.fr, GENRE_FALLBACK[m.genre]?.en] : [];
  return hits([m.label?.fr, m.label?.en, m.family, m.file, m.desc?.fr, m.desc?.en, m.app, m.trigger, m.quant, m.role,
    m.role === 'lora' ? 'LoRA' : '', m.loraForLabel?.fr, ...caps, ...g].filter(Boolean).join(' '), query);
}

const isFolded = (g) => (query ? false : FOLDED.has(g) ? !unfolded.has(g) : folded.has(g));
function toggleFold(g) {
  if (FOLDED.has(g)) { if (unfolded.has(g)) unfolded.delete(g); else unfolded.add(g); }
  else if (folded.has(g)) folded.delete(g); else folded.add(g);
  paintList();
}

function paintList() {
  if (!ui) return;
  const body = ui.body;
  const keepScroll = ui.scroll.scrollTop;
  // pendant une recherche, seuls les modèles comptent : « Il manque » et les téléchargements s'effacent
  ui.top.classList.toggle('searching', !!query);
  body.textContent = '';
  const i = inv();
  if (!i) {
    body.append(el('div', { class: 'lib-empty' }, t('lib.loading')));
    return;
  }
  const groups = new Map(GROUPS.map((g) => [g, []]));
  for (const m of i.models) if (matches(m)) (groups.get(m.group) || groups.get('other')).push(m);
  // Les téléchargements interrompus ne sont pas des modèles : on ne les montre pas quand un bloc filtre.
  const partials = filterCaps ? [] : (i.partials || []).filter((p) => !query || hits(`${tl(p.name) || ''} ${p.file} ${p.app || ''}`, query));

  let shown = 0;
  for (const g of GROUPS) {
    const items = g === 'partials' ? partials : groups.get(g);
    // « Mes LoRA » reste visible même vide : c'est là qu'on en ajoute.
    if (!items.length && !(g === 'loras' && !query && (!filterCaps || filterCaps.includes('lora')))) continue;
    shown += items.length;
    body.append(section(g, items));
  }
  if (!shown) {
    body.append(el('div', { class: 'lib-empty' }, query ? t('lib.empty', { q: query }) : t('lib.none')));
  }
  ui.scroll.scrollTop = keepScroll;
}

// « Mes LoRA » : les étapes d'un entraînement (dossier d'entraînement, numérotées ou non) et les copies
// identiques sont rangées dans le pli ; la section ne compte que les LoRA qu'on peut vraiment choisir.
const loraFolded = (m) => m.origin === 'training' || !!m.trainingStep || m.status === 'duplicate';

function section(g, items) {
  const foldedNow = isFolded(g);
  const count = g === 'loras' ? items.filter((m) => !loraFolded(m)).length
    : g === 'partials' ? partialGroups(items).length : items.length;
  const head = el('button', { class: ['lib-sec-head', foldedNow && 'folded'], type: 'button', 'aria-expanded': foldedNow ? 'false' : 'true' },
    el('span', { class: 'kicker lib-sec-title' }, t('lib.group.' + g)),
    el('span', { class: 'lib-sec-count' }, num(count, 0)),
    el('span', { class: 'lib-sec-chev', html: icon('chevron', 12) }));
  head.addEventListener('click', () => toggleFold(g));
  const sec = el('section', { class: ['lib-sec', 'lib-sec-' + g] }, head);
  if (foldedNow) return sec;
  if (HINTED.has(g)) sec.append(el('p', { class: 'lib-sec-hint' }, t('lib.hint.' + g)));
  if (g === 'partials') {
    for (const p of partialGroups(items)) sec.append(partialRow(p));
  } else if (g === 'apps') {
    appsSection(sec, items);
  } else if (g === 'loras') {
    const main = items.filter((m) => !loraFolded(m));
    const steps = items.filter(loraFolded);
    for (const m of main) sec.append(...modelRow(m));
    if (steps.length) {
      const open = showTraining || !!query;
      const tog = el('button', { class: ['lib-sub-toggle', open && 'open'], type: 'button' },
        el('span', { html: icon('chevron-right', 12) }), tn('lib.training', steps.length));
      tog.addEventListener('click', () => { showTraining = !showTraining; paintList(); });
      sec.append(tog);
      if (open) for (const m of steps) sec.append(...modelRow(m));
    }
    if (!query && (!filterCaps || filterCaps.includes('lora'))) {
      sec.append(el('div', { class: 'lib-sec-actions' },
        button({ label: t('lib.lora.add'), icon: 'plus', kind: 'ghost', size: 'sm', tip: t('lib.lora.addTip'), onClick: pickLoraFile })));
    }
  } else {
    // « Autres modèles » : la section dit déjà « pas encore utilisés », la pastille « Inutilisé » serait répétée.
    for (const m of items) sec.append(...modelRow(m, { quietUnused: g === 'other' }));
  }
  return sec;
}

// Autres applications : une ligne par logiciel (nom, à quoi il sert, combien de fichiers) ; les fichiers seulement
// sur demande, sans répéter « autre appli » sur chacun.
function appsSection(sec, items) {
  const apps = new Map();
  for (const m of items) { const k = m.app || '—'; if (!apps.has(k)) apps.set(k, []); apps.get(k).push(m); }
  for (const [name, list] of apps) {
    const meta = (inv()?.apps || []).find((a) => a.name === name);
    const size = list.reduce((s, m) => s + (m.sizeGB || 0), 0);
    const open = openApps.has(name) || !!query;
    const row = el('div', {
      class: ['lib-row', 'lib-app-row', open && 'open'], tabindex: '0', role: 'button', 'aria-expanded': open ? 'true' : 'false',
      dataset: meta?.root ? { path: meta.root } : {},
    },
    el('div', { class: 'lib-row-main' },
      el('div', { class: 'lib-row-top' }, el('span', { class: 'lib-name' }, name)),
      el('div', { class: 'lib-row-sub' }, el('span', { class: 'lib-desc' }, meta?.desc ? tl(meta.desc) : t('lib.app.showFiles')))),
    el('div', { class: 'lib-row-side' }, el('span', { class: 'lib-count' }, tn('lib.appCount', list.length, { size: gbText(size) }))),
    el('span', { class: 'lib-chev', html: icon('chevron', 12) }));
    const toggle = () => { if (openApps.has(name)) openApps.delete(name); else openApps.add(name); paintList(); };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    sec.append(row);
    if (open) {
      const files = el('div', { class: 'lib-app-files' });
      for (const m of list) files.append(...modelRow(m, { inApps: true }));
      sec.append(files);
    }
  }
}

function badge(text, cls, tipText) {
  return el('span', { class: ['lib-badge', cls], tip: tipText || null }, text);
}

function modelRow(m, { inApps = false, quietUnused = false } = {}) {
  const fit = fitOf(m);
  const lora = m.role === 'lora' && !m.hidden;
  const isAuto = (m.default || []).length > 0;
  const side = el('div', { class: 'lib-row-side' });
  // La mémoire ne se signale que si elle pose problème ; le détail donne toujours le chiffre.
  if (fit === 'over') side.append(badge(t('model.fit.over'), 'fit-over', t('model.fitTip.over', { n: num(m.vramGB, 0), card: cardGB() })));
  if (m.license && m.license !== 'ok') side.append(badge(t('model.license.' + m.license), 'lic-' + m.license, tl(m.licenseNote)));
  // Une seule pastille d'état : « Interdit » suffit, « Autre appli » est dit par la section, « Inutilisé » aussi.
  const quiet = (inApps && m.status === 'other-app') || (quietUnused && m.status === 'unused') || (m.license === 'forbidden' && m.status === 'unused');
  if (m.status && m.status !== 'ready' && !quiet) side.append(badge(t('model.status.' + m.status), 'st-' + m.status, tl(m.statusNote)));
  side.append(el('span', { class: 'lib-size' }, gbText(m.sizeGB)));

  // Ligne du dessous : pour un LoRA, son genre et à quoi il sert (« PERSONNAGE  pour LTX 2.5 · « mra woman » ») ;
  // sinon la famille (seulement si elle apprend quelque chose) et la phrase simple.
  let kicker = '', sub = tl(m.desc);
  if (lora) {
    kicker = m.genre ? genreLabel(m.genre) : '';
    const bits = [];
    if (m.loraFor) bits.push(t('lib.lora.for', { what: baseShort(m.loraFor) || tl(m.loraForLabel) }));
    if (m.trigger) bits.push(t('lib.lora.triggerQ', { t: m.trigger }));
    if (m.statusNote && m.status !== 'ready') bits.unshift(tl(m.statusNote).replace(/\.\s*$/, ''));   // phrase dans une ligne à « · » : sans son point
    sub = bits.join(' · ') || sub;
  } else {
    kicker = famTag(m);
  }

  const open = expanded.has(m.id);
  const row = el('div', {
    class: ['lib-row', open && 'open', m.status !== 'ready' && 'dim', m.license === 'forbidden' && 'forbidden'],
    tabindex: '0', role: 'button', 'aria-expanded': open ? 'true' : 'false',
    dataset: { id: m.id, path: m.path },
  },
  el('div', { class: 'lib-row-main' },
    el('div', { class: 'lib-row-top' },
      el('span', { class: 'lib-name' }, tl(m.label)),
      isAuto ? el('span', { class: 'lib-auto', tip: t('model.autoTip', { caps: m.default.map(capLabel).join(', ') }) }, t('model.auto')) : null),
    el('div', { class: 'lib-row-sub' },
      kicker ? el('span', { class: 'lib-fam' }, kicker) : null,
      el('span', { class: 'lib-desc' }, sub))),
  side,
  el('span', { class: 'lib-chev', html: icon('chevron', 12) }));

  const toggle = () => {
    if (expanded.has(m.id)) expanded.delete(m.id); else expanded.add(m.id);
    paintList();
    requestAnimationFrame(() => ui.body.querySelector(`.lib-row[data-id="${m.id}"]`)?.focus({ preventScroll: true }));
  };
  row.addEventListener('click', (e) => { if (!e.target.closest('.lib-detail')) toggle(); });
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      const r = row.getBoundingClientRect();
      fileMenu(m.path, { x: r.left + 24, y: r.bottom - 4 }, m);
    }
  });
  return open ? [row, detail(m)] : [row];
}

function meter(n) {
  const v = Math.max(0, Math.min(3, Number(n) || 0));
  return el('span', { class: 'lib-meter', 'aria-hidden': 'true' }, ...[1, 2, 3].map((k) => el('i', { class: k <= v ? 'on' : null })));
}

function detail(m) {
  const rows = [];
  const line = (k, v, cls) => { if (v != null && v !== '') rows.push(el('div', { class: 'lib-kv' }, el('span', { class: 'lib-k' }, k), el('span', { class: ['lib-v', cls] }, v))); };
  const lora = m.role === 'lora' && !m.hidden;
  if (lora) {
    line(t('model.madeFor'), m.loraFor ? (baseFull(m.loraFor) || tl(m.loraForLabel)) : t('lib.lora.unknownBase'));
    if (m.genre) line(t('model.genre'), genreLabel(m.genre));
    line(t('model.trigger'), m.trigger || t('lib.lora.noTrigger'), m.trigger ? 'mono' : null);
    if (m.origin) line(t('lib.lora.origin'), t('lib.lora.origin.' + m.origin));
    if (m.origin === 'added' || m.origin === 'folder') line(t('lib.lora.placed'), m.placed || t('lib.lora.placeLater'), m.placed ? 'mono' : null);
  } else if ((m.caps || []).length) {
    line(t('model.usedFor'), m.caps.map(capLabel).join(' · '));
  }
  if (m.speed) line(t('model.speed'), el('span', { class: 'lib-meter-wrap' }, meter(m.speed), t('model.speed.' + m.speed)));
  if (m.quality) line(t('model.quality'), el('span', { class: 'lib-meter-wrap' }, meter(m.quality), t('model.quality.' + m.quality)));
  if (m.vramGB && !m.hidden && m.role !== 'lora') {
    const fit = fitOf(m);
    line(t('model.memory'), fit ? t('model.memoryFit.' + fit, { n: num(m.vramGB, 0), card: cardGB() }) : t('model.memoryVal', { n: num(m.vramGB, 0) }));
  }
  if (m.trigger && !lora) line(t('model.trigger'), m.trigger, 'mono');
  if (m.licenseNote) line(t('model.licenseLbl'), tl(m.licenseNote));
  if (m.app) line(t('model.app'), m.app);
  const prec = [m.quantClass ? t('model.qc.' + m.quantClass) : null, m.quant,
    m.params ? t('model.params', { n: num(m.params, m.params < 1 ? 2 : 1) }) : null].filter(Boolean).join(' · ');
  if (prec && !lora) line(t('model.precision'), prec, 'mono');
  if (m.kind === 'bundle' && m.files) {
    line(t('model.file'), tn('model.files', m.files.length) + (m.usefulGB ? ' · ' + t('model.useful', { useful: gbText(m.usefulGB), total: gbText(m.sizeGB) }) : ''));
  } else {
    line(t('model.file'), m.file, 'mono');
  }
  if (m.comfy && !lora) line(t('model.comfy'), m.comfy.visible === false ? t('model.comfyHidden') : `${m.comfy.folder} / ${m.comfy.name}`, 'mono');
  if (m.duplicateOf) { const o = byId(m.duplicateOf); if (o) line(t('model.copyOf'), `${tl(o.label)} · ${o.path.replace(/\//g, '\\')}`, 'mono'); }
  if ((m.usedBy || []).length) line(t('model.usedBy'), m.usedBy.join('\n'), 'mono pre');
  line(t('model.where'), m.path.replace(/\//g, '\\'), 'mono select');

  let note = null;
  if (m.statusNote) {
    note = el('div', { class: 'lib-note' }, el('span', { class: 'lib-note-ico', html: icon(m.status === 'incomplete' ? 'warn' : 'info', 13) }),
      el('span', { class: 'lib-note-txt' }, tl(m.statusNote)));
    if (m.status === 'incomplete') note.append(button({ label: t('lib.rescan'), icon: 'refresh', kind: 'ghost', size: 'xs', onClick: () => runScan('rescan') }));
  }
  const actions = el('div', { class: 'lib-actions' });
  if (canEdit(m)) {
    actions.append(button({ label: t('lib.lora.rename'), icon: 'edit', kind: 'ghost', size: 'sm', onClick: () => openLoraEditor(m, 'name') }),
      button({ label: t('lib.lora.editTrigger'), kind: 'ghost', size: 'sm', onClick: () => openLoraEditor(m, 'trigger') }));
  }
  actions.append(button({ label: t('model.reveal'), icon: 'reveal', kind: 'ghost', size: 'sm', onClick: () => reveal(m.path) }));
  // Pour un LoRA, « Copier le chemin » reste dans le clic droit : une seule rangée d'actions.
  if (!canEdit(m)) actions.append(button({ label: t('model.copyPath'), icon: 'copy', kind: 'ghost', size: 'sm', onClick: () => copyPath(m.path) }));
  if (canRemove(m)) actions.append(button({ label: t('lib.lora.remove'), icon: 'trash', kind: 'ghost', size: 'sm', onClick: () => removeLora(m) }));
  return el('div', { class: 'lib-detail', dataset: { path: m.path, id: m.id } },
    el('p', { class: 'lib-detail-desc' }, tl(m.desc)), note, el('div', { class: 'lib-kvs' }, ...rows), actions);
}

// Téléchargements interrompus : une ligne par dossier (« marigold-normals · unet · 4 fichiers »), jamais
// l'empreinte illisible du cache (gardée dans l'info-bulle) ni dix lignes identiques.
function partialGroups(list) {
  const groups = new Map();
  for (const p of list) {
    const name = tl(p.name) || p.file;
    const k = `${name}|${p.app || ''}|${tl(p.note)}`;
    if (!groups.has(k)) groups.set(k, { name, app: p.app || null, note: p.note, files: [] });
    groups.get(k).files.push(p);
  }
  return [...groups.values()];
}

function partialRow(g) {
  const size = g.files.reduce((s, p) => s + (p.sizeGB || 0), 0);
  const sub = [tl(g.note), g.files.length > 1 ? tn('model.files', g.files.length) : null, g.app].filter(Boolean).join(' · ');
  return el('div', { class: 'lib-row dim lib-partial', tabindex: '0', dataset: { path: g.files[0].path } },
    el('div', { class: 'lib-row-main' },
      el('div', { class: 'lib-row-top' }, el('span', { class: 'lib-name', tip: g.files.map((p) => p.file).join('\n') }, g.name)),
      el('div', { class: 'lib-row-sub' }, el('span', { class: 'lib-desc' }, sub))),
    el('div', { class: 'lib-row-side' }, badge(t('model.status.partial'), 'st-partial'), el('span', { class: 'lib-size' }, gbText(size))),
    el('span', { class: 'lib-chev lib-chev-spacer', 'aria-hidden': 'true', html: icon('chevron', 12) }));
}

// =====================================================================
// LoRA : ajouter, modifier, retirer (SPEC §12)
// =====================================================================
function loraForm({ name = '', trigger = '', kind = 'character' } = {}) {
  let genre = GENRE_KEYS.includes(kind) ? kind : 'character';
  const nameField = textField({ value: name, size: 'md', maxLength: 60 });
  const trigField = textField({ value: trigger, size: 'md', mono: true, placeholder: t('lib.lora.triggerPh'), maxLength: 80 });
  const seg = segmented({ options: GENRE_KEYS.map((g) => ({ value: g, label: genreLabel(g) })), value: genre, onChange: (v) => { genre = v; }, full: true });
  const field = (label, ctl) => el('label', { class: 'lora-field' }, el('span', { class: 'lora-label' }, label), ctl);
  const fields = el('div', { class: 'lora-fields' },
    field(t('lib.lora.name'), nameField),
    field(t('lib.lora.trigger'), trigField),
    el('div', { class: 'lora-field' }, el('span', { class: 'lora-label' }, t('lib.lora.genre')), seg));
  return { fields, nameField, trigField, values: () => ({ name: nameField.value.trim(), trigger: trigField.value.trim(), kind: genre }) };
}

function enterSubmits(fields, submit) {
  fields.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); }
  }, true);
}

/**
 * La modale « Ajouter un LoRA » (SPEC §12.1). `info` = la réponse de mia.models.inspect(path) ; absente, on la
 * demande. Un fichier qui n'est pas un LoRA donne un toast clair. Renvoie l'entrée ajoutée, ou null.
 */
export async function openAddLora(path, info = null) {
  const api = mia().models;
  if (!api || typeof api.addLora !== 'function') { toast(t('lib.lora.unavailable'), { kind: 'error' }); return null; }
  if (!info && typeof api.inspect === 'function') {
    try { info = await api.inspect(path); } catch (err) { info = { ok: false, error: String(err?.message || err) }; }
  }
  if (!info || info.ok === false) { toast(info?.error || t('lib.lora.notLora'), { kind: 'error', ms: 7000 }); return null; }
  if (!info.isLora) { toast(info.reason ? tl(info.reason) : t('lib.lora.notLora'), { kind: 'error', ms: 7000 }); return null; }

  const file = info.file || String(path).split(/[\\/]/).pop();
  const what = info.familyLabel ? tl(info.familyLabel) : t('lib.lora.unknownBase');
  const already = info.already && info.already.id && info.already.usable ? byId(info.already.id) : null;
  const form = loraForm({
    name: already ? tl(already.label) : (info.suggestedName || ''),
    trigger: already ? (already.trigger || '') : (info.suggestedTrigger || ''),
    kind: already?.genre || info.kindGuess,
  });
  let handle = null;
  const submitBtn = button({ label: t('lib.lora.submit'), kind: 'primary', onClick: () => submit() });
  const content = el('div', { class: 'lora-modal' },
    el('h2', {}, t('lib.lora.title')),
    el('div', { class: 'lora-file' },
      el('span', { class: 'lora-file-name' }, file),
      el('span', { class: 'lora-file-size' }, gbText(info.sizeGB))),
    el('div', { class: 'lora-for' }, t('lib.lora.madeFor', { what })),
    already ? el('div', { class: 'lora-already' }, el('span', { html: icon('info', 13) }), t('lib.lora.already', { name: tl(already.label) })) : null,
    form.fields,
    el('p', { class: 'lora-keep' }, t('lib.lora.keep')),
    el('div', { class: 'modal-actions' },
      button({ label: t('lib.lora.cancel'), kind: 'ghost', onClick: () => handle.close(null) }),
      submitBtn));
  let busy = false;
  async function submit() {
    if (busy) return;
    busy = true;
    submitBtn.setDisabled?.(true);
    let res = null;
    try { res = await api.addLora({ path, ...form.values() }); } catch (err) { res = { ok: false, error: String(err?.message || err) }; }
    busy = false;
    submitBtn.setDisabled?.(false);
    if (!res || res.ok === false) { toast(t('lib.lora.failed', { msg: res?.error || '—' }), { kind: 'error', ms: 7000 }); return; }
    adopt(res.inventory);
    repaint();
    const name = tl(res.model?.label) || form.values().name || file;
    toast(t(res.existed ? 'lib.lora.updated' : 'lib.lora.added', { name }), {
      kind: 'ok', action: { label: t('lib.lora.see'), run: () => openLibrary({ caps: ['lora'] }) },
    });
    handle.close(res.model || true);
  }
  enterSubmits(form.fields, submit);
  form.nameField.dataset.autofocus = '';
  handle = openModal(content, { width: 460, className: 'lora-dialog' });
  return handle.result.then((v) => (v && v !== true ? v : null));
}

// Renommer / mot déclencheur / genre : une seule petite modale, le champ demandé en premier.
function openLoraEditor(m, focus = 'name') {
  const form = loraForm({ name: tl(m.label), trigger: m.trigger || '', kind: m.genre || 'character' });
  let handle = null;
  const save = async () => {
    const v = form.values();
    handle.close(true);
    await saveLora(m, { name: v.name, trigger: v.trigger, kind: v.kind });
  };
  const content = el('div', { class: 'lora-modal' },
    el('h2', {}, t('lib.lora.editTitle')),
    el('div', { class: 'lora-file' }, el('span', { class: 'lora-file-name' }, m.file), el('span', { class: 'lora-file-size' }, gbText(m.sizeGB))),
    m.loraFor ? el('div', { class: 'lora-for' }, t('lib.lora.madeFor', { what: baseFull(m.loraFor) || tl(m.loraForLabel) })) : null,
    form.fields,
    el('div', { class: 'modal-actions' },
      button({ label: t('lib.lora.cancel'), kind: 'ghost', onClick: () => handle.close(null) }),
      button({ label: t('lib.lora.save'), kind: 'primary', onClick: save })));
  enterSubmits(form.fields, save);
  (focus === 'trigger' ? form.trigField : form.nameField).dataset.autofocus = '';
  handle = openModal(content, { width: 460, className: 'lora-dialog' });
}

async function saveLora(m, patch) {
  const api = mia().models;
  if (!api || typeof api.updateLora !== 'function') { toast(t('lib.lora.unavailable'), { kind: 'error' }); return; }
  let res = null;
  try { res = await api.updateLora(m.id, patch); } catch (err) { res = { ok: false, error: String(err?.message || err) }; }
  if (!res || res.ok === false) { toast(t('lib.lora.failed', { msg: res?.error || '—' }), { kind: 'error', ms: 7000 }); return; }
  adopt(res.inventory);
  repaint();
  toast(t('lib.lora.updated', { name: tl(res.model?.label) || tl(m.label) }), { kind: 'ok' });
}

async function removeLora(m) {
  const api = mia().models;
  if (!api || typeof api.removeLora !== 'function') { toast(t('lib.lora.unavailable'), { kind: 'error' }); return; }
  const name = tl(m.label);
  const yes = await confirm({ title: t('lib.lora.removeTitle', { name }), body: t(m.placed ? 'lib.lora.removeBody' : 'lib.lora.removeBodyNoCopy'), ok: t('lib.lora.removeOk'), danger: true });
  if (!yes) return;
  let res = null;
  try { res = await api.removeLora(m.id); } catch (err) { res = { ok: false, error: String(err?.message || err) }; }
  if (!res || res.ok === false) { toast(t('lib.lora.failed', { msg: res?.error || '—' }), { kind: 'error', ms: 7000 }); return; }
  expanded.delete(m.id);
  adopt(res.inventory);
  repaint();
  toast(res.warning || t('lib.lora.removed', { name }), { kind: res.warning ? 'info' : 'ok' });
}

// « Ajouter un LoRA… » : le sélecteur de fichiers de Windows, en secours du glisser-déposer.
async function pickLoraFile() {
  let paths = [];
  try { paths = (await mia().media?.pick?.({ kind: 'lora' })) || []; } catch (err) { console.warn('[library] pick', err); }
  const p = Array.isArray(paths) ? paths[0] : paths;
  if (p) await openAddLora(p);
}

// =====================================================================
// Accueil : « MODÈLES SUR CE PC », une ligne par capacité
// =====================================================================
export function mountHomeModels(container) {
  if (!container || container.dataset.libMounted) return;
  container.dataset.libMounted = '1';
  wire();
  container.classList.add('home-sec', 'hm');
  let first = true;

  const paint = () => {
    const i = inv();
    container.textContent = '';
    const all = el('button', { class: 'hm-all', type: 'button' }, t('lib.home.all'), el('span', { html: icon('arrow-right', 13) }));
    all.addEventListener('click', () => openLibrary({}));
    // Le nombre de modèles prêts seul : le total du disque (autres applis comprises) tromperait à côté.
    const summary = i ? tn('lib.ready', readyCount(i)) : '';
    container.append(el('div', { class: 'home-sec-head' },
      el('h2', { class: 'kicker' }, t('lib.kicker')),
      el('div', { class: 'hm-head-side' }, el('span', { class: 'hm-sum' }, summary), all)));
    const list = el('div', { class: ['hm-list', first && i && 'hm-anim'] });
    // Pas encore d'inventaire, ou le scanner n'a pas démarré (le principal répond alors avec `error`).
    const err = state.inventory && state.inventory.error;
    if (!i || (err && !i.models.length)) {
      list.append(el('div', { class: 'hm-row hm-wait' }, el('span', { class: 'hm-cap' }, err ? t('lib.loadFailed', { msg: err }) : t('lib.home.loading'))));
      container.append(list);
      return;
    }
    HOME_CAPS.filter((cap) => i.capabilities?.[cap]).forEach((cap, k) => {
      const r = homeRow(i, cap);
      r.style.setProperty('--i', String(Math.min(k, 12)));
      list.append(r);
    });
    container.append(list);
    first = false;
  };
  painters.add(paint);
  paint();
}

function homeRow(i, cap) {
  const c = i.capabilities?.[cap] || { available: false };
  const models = i.models || [];
  let name, fam = '', size = null, stateTxt, stateCls, path = null, ttl = null;
  if (cap === 'lora') {
    const ids = models.filter((m) => (c.options || []).includes(m.id));
    name = ids.map((m) => tl(m.label)).join(', ');
    ttl = name;
    size = ids.reduce((s, m) => s + (m.sizeGB || 0), 0);
    path = ids[0]?.path || null;
    if (!ids.length) name = t('lib.home.noLora');
  } else {
    const d = c.default ? models.find((m) => m.id === c.default) : null;
    name = d ? tl(d.label) : '';
    fam = d ? famTag(d) : '';
    size = d ? d.sizeGB : null;
    path = d?.path || null;
  }
  if (c.available) { stateTxt = t('model.status.ready'); stateCls = 'ready'; }
  else if (cap === 'lora') { stateTxt = t('lib.home.noneReady'); stateCls = 'missing'; }
  else {
    const inc = models.find((m) => m.status === 'incomplete' && (m.caps || []).includes(cap));
    stateTxt = inc ? t('lib.home.incomplete') : t('lib.home.missing');
    stateCls = inc ? 'incomplete' : 'missing';
    if (inc) { name = tl(inc.label); fam = famTag(inc); size = inc.sizeGB; path = inc.path; }
    else {
      // Le modèle attendu (« MiniMax H3 · Références ») et, s'il est à télécharger, sa taille ; la phrase entière
      // est dans l'info-bulle et dans la bibliothèque.
      const miss = (i.missing || []).find((x) => (x.caps || []).includes(cap));
      if (miss) { name = tl(miss.name) || tl(miss.what); ttl = tl(miss.what); if (miss.sizeGB) size = miss.sizeGB; }
      // la même taille que la bibliothèque (« Installer (… Go) ») : le total du manifeste des fichiers qui manquent
      const keys = inst?.caps?.[cap]?.missing || [];
      if (keys.length && bytesOf(keys) > 0) size = bytesOf(keys) / 1e9;
    }
  }
  const nameEl = el('span', { class: 'hm-name' }, name || '—');
  // la phrase du manque, sinon le nom entier quand la rangée l'a coupé (la liste de tous ses LoRA)
  tip(nameEl, () => ttl || (nameEl.scrollWidth > nameEl.clientWidth + 1 ? name : ''));
  const row = el('button', { class: ['hm-row', 'hm-' + stateCls], type: 'button', dataset: path ? { path } : {} },
    el('span', { class: 'hm-cap' }, capLabel(cap)),
    // le nom prend la place libre ; la famille (mono gris) le suit seulement si elle dit autre chose que le nom
    el('span', { class: 'hm-model' }, nameEl, fam ? el('span', { class: 'hm-fam' }, fam) : null),
    el('span', { class: 'hm-size' }, size != null && size > 0 ? gbText(size) : ''),
    el('span', { class: 'hm-state' }, stateTxt));
  row.addEventListener('click', () => openLibrary({ caps: [cap] }));
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (path) fileMenu(path, { x: e.clientX, y: e.clientY });
  });
  return row;
}

export default { mountLibrary, mountModelsButton, mountHomeModels, openLibrary, closeLibrary, toggleLibrary, openAddLora, gbText, famTag };
