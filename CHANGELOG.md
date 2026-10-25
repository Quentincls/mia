# Journal des versions de Mia

Les évolutions notables de Mia, de la plus récente à la plus ancienne. Numéros de version
[SemVer](https://semver.org/lang/fr/) : Mia reste en 0.x tant que ses formats de fichiers peuvent encore évoluer.

Les fichiers de Mia (planches, projets, réglages) sont mis à jour tout seuls à l’ouverture, sans rien perdre : avant
d’écrire un fichier dans un format plus récent, Mia garde l’ancien à côté (`graph.json.bak-v0`, `prefs.json.bak-v0`…).

Chaque version commence par **En bref** (en français) et **In short** (en anglais) : quelques lignes en mots simples,
celles que Mia affiche dans « Nouveautés ». Suivent le détail (Ajouté, Changé, Corrigé) et, à la fin, ce qui ne
concerne que les développeurs.

## Prochaine version — en cours (pas encore publiée)

### En bref
- **Un bloc par modèle** : « + Bloc » montre d’abord les **Modèles** (LTX, MiniMax, Wan, Qwen) et ceux **En ligne**
  (Seedance, Kling, MiniMax 2K…). Le bloc posé porte le nom du modèle, n’a que les entrées que ce modèle sait prendre
  (jusqu’à 30 images de référence pour Seedance 2.5) et fait ce que demandent les fils : une image de début, il
  l’anime ; des références, il les mélange ; rien, il part du texte.
- **Les modèles en ligne de Higgsfield** : colle ta clé dans Réglages → Comptes en ligne (gardée chiffrée sur ce
  PC) ; les calculs se font chez eux, ta carte graphique reste libre, chaque calcul coûte des crédits et ne part
  qu’à ton clic. L’aperçu prend la plus petite résolution et la durée la plus courte.
- MiniMax H3 sait maintenant partir d’un texte seul, sans image.
- **Des infobulles qui expliquent** : au survol d’une entrée d’un bloc (image de début, références, vidéo guide…),
  ce que c’est, à quoi ça sert, et ce que le modèle choisi en fait ; au survol du modèle, où il calcule et ce qu’il sait faire.
- **Le modèle en évidence** : dans chaque bloc de génération, le modèle est la première chose qu’on voit (sa
  pastille, son nom, ce qu’il sait faire : « 15 S · 720P · SON »). Un clic ouvre un panneau avec recherche, onglets
  **Local** et **Cloud**, « Choisir pour moi », épingles, et une phrase simple qui dit à quoi sert chaque modèle.
- **Les réglages suivent le modèle** : avec MiniMax H3, la durée monte à 15 s et la cadence (toujours 24 i/s)
  disparaît ; LTX reste à 10 s au plus. Une note dit quand une entrée branchée ne sert pas au modèle choisi.
- Les noms longs des cartes de l’accueil passent sur deux lignes ; un titre de bloc coupé se lit en entier au survol.
- **« Partir de : » et « + Ajouter »** : un bloc Modèle vide n’impose plus d’entrée. LTX, MiniMax et les modèles en
  ligne montrent la consigne et une ligne « Partir de : Image de début · Rendu 3D · Vidéo guide · Fiche
  personnage » : un clic fait apparaître l’entrée, sinon le bloc part du texte. Wan et Qwen, qui ne font qu’une
  chose, montrent leurs entrées. Le reste de ce que sait prendre le modèle se range derrière « + Ajouter », avec une
  phrase simple pour chaque entrée. Quand tu tires
  un fil vers le bloc, les entrées qui peuvent le recevoir apparaissent le temps du geste ; une entrée ajoutée et
  restée vide se range d’un clic sur ×.
- **Tout ce que savent les modèles du PC**, dans le bloc Modèle (les nouveautés portent « À essayer » tant qu’elles
  n’ont pas été jugées à l’œil) :
  - **Images-clés** (LTX, MiniMax) : jusqu’à 4 images par où le plan passe, entre le début et la fin (au même
    cadrage que l’image de début, sinon le plan coupe vers elle) ;
  - **MiniMax** : **prolonger une vidéo** (le résultat est la vidéo entière, rallongée ; raccord invisible à
    l’essai), un **son à suivre** (la vidéo se cale sur une voix ou une musique), jusqu’à 3 **sons de référence**
    (« Son 1 »…), et **768p** ;

  - **Wan Animate 2** : « Fidélité au mouvement » et « Ressemblance au personnage » ;
  - **Qwen Image Edit** : deux images d’appui au lieu d’une (« image 2 », « image 3 »).
- **Plus clair quand un branchement ne suffit pas** : une image de fin, des images-clés ou une fiche seules sur LTX
  ne font plus partir le bloc du texte en silence ; il dit en rouge ce qui manque (« Il manque pour « Animer une
  image » : Image de début »). Une entrée reliée mais pas utilisée est grisée, avec la raison au survol.
- **Les fils se posent où tu vises** : pendant qu’on tire un fil, les entrées qui apparaissent s’ajoutent en bas au
  lieu de pousser celles qu’on vise ; lâcher sur le corps d’un bloc MiniMax branche les références ; la croix qui
  coupe un fil marche enfin.
- **LTX et les références** : LTX ne mélange pas plusieurs références séparées (c’est MiniMax, le bloc le dit et
  propose d’y passer d’un clic) ; il sait partir d’une **fiche personnage** seule (à essayer). Nouvelle recette
  « Vidéo à partir de mes références ».
- **Les assistants (Claude, Codex) connaissent tout cela** : chaque modèle, ce qu’il faut lui brancher pour chaque
  façon de faire, ses réglages, ce qui est à essayer ; et, sur la planche, ce que fait chaque bloc Modèle.

### In short
- **One block per model**: “+ Block” first shows the **Models** (LTX, MiniMax, Wan, Qwen) and the **Online** ones
  (Seedance, Kling, MiniMax 2K…). The block is named after its model, only has the inputs that model takes (up to 30
  reference images for Seedance 2.5) and does what its wires ask: a start image, it animates it; references, it
  mixes them; nothing, it starts from the text.
- **Higgsfield’s online models**: paste your key in Settings → Online accounts (kept encrypted on this PC); jobs run
  on their servers, your graphics card stays free, each job costs credits and only leaves on your click. The preview
  uses the smallest resolution and the shortest length.
- MiniMax H3 can now start from text alone, without an image.
- **Tooltips that explain**: hover an input of a block (start image, references, guide video…) to see what it is,
  what it is for and what the chosen model does with it; hover the model to see where it runs and what it can do.
- **The model up front**: in every generation block, the model is the first thing you see (its badge, its name,
  what it can do: “15 S · 720P · SOUND”). One click opens a panel with search, **Local** and **Cloud** tabs,
  “Pick for me”, pins, and a plain sentence on what each model is for.
- **Settings follow the model**: with MiniMax H3 the length goes up to 15 s and the frame rate (always 24 fps)
  goes away; LTX stays at 10 s at most. A note says when a connected input is not used by the chosen model.
- Long names on home cards wrap onto two lines; a cut block title shows in full on hover.
- **“Start from:” and “+ Add”**: an empty Model block no longer imposes an input. LTX, MiniMax and the online models
  show the prompt and a line “Start from: Start image · 3D render · Guide video · Character sheet”: one click shows
  that input, otherwise the block starts from the text. Wan and Qwen, which do one thing, show their inputs.
  Everything else its model can take waits behind “+ Add”, with a plain sentence for each input. While you drag a wire to the block, the inputs that
  can take it show up for the gesture; an input you added and left empty goes away with ×.
- **Everything this PC’s models can do**, in the Model block (new features say “To try” until judged by eye):
  keyframes (LTX, MiniMax, up to 4 between start and end, same framing as the start image); MiniMax: extend a video
  (the result is the whole video, longer), a sound to follow, up to 3 reference sounds, 768p; Wan Animate 2: motion fidelity and character likeness; Qwen Image Edit: two helper images.
- **Clearer when a wiring is not enough**: an end image, keyframes or a sheet alone on LTX no longer make the block
  start from text silently; it says in red what is missing. An input connected but not used is greyed out, with the
  reason on hover.
- **Wires land where you aim**: while you drag a wire, the inputs that show up are added at the bottom instead of
  pushing the one you aim at; dropping on a MiniMax block connects its references; the cross that cuts a wire works.
- **LTX and references**: LTX does not blend several separate references (MiniMax does: the block says so and
  switches in one click); it can start from a **character sheet** alone (to try). New recipe “Video from my
  references”.
- **Assistants (Claude, Codex) know all of it**: each model, what to wire for each way of working, its settings,
  what is to try; and, on the board, what each Model block does.

### Ajouté
- **Bloc Modèle** (`gen`, SPEC §23) : entrées et réglages selon la famille de son modèle, façon de faire choisie
  d’après les fils (règle unique `src/js/nodes/route.js`, lue aussi par le moteur), ligne « Ce que fait le bloc »,
  entrées reliées hors du modèle barrées et ignorées ; panneau des familles Local | Cloud ; section Modèles et
  catégorie En ligne dans « + Bloc ».
- **En ligne (Higgsfield)** : `electron/cloud.js` (clé chiffrée par Windows, IPC `cloud:*`), exécuteur
  `executors/cloud.js` (envoi des fichiers, demande, suivi, téléchargement, erreurs en clair, annulation en file),
  catalogue `src/catalog/cloud-higgsfield.json` (35 familles, 71 façons de faire) relevé par
  `tools/build-cloud-catalog.mjs` ; Réglages → Comptes en ligne ; `tools/hf-check.mjs` vérifie une clé sans rien
  dépenser.
- Profils de modèles `src/catalog/model-families.json` (SPEC §22) : nom, fabricant, monogramme, phrase « à quoi ça
  sert » en français et en anglais, variantes (LTX Standard / Rapide, MiniMax Images-clés / Références, SeedVR2
  Rapide / Qualité) et limites (durée, cadence, définitions, entrées comprises).
- Panneau de choix du modèle : onglets Local | Cloud (Cloud = Higgsfield, annoncé, pas encore relié), recherche,
  « Choisir pour moi » (= Auto), modèles épinglés (`prefs.pinnedModels`).

- **« + Ajouter »** (`src/js/nodes/addinput.js`) : entrées montrées = consigne, entrée principale (`main` du
  profil), ce qui est relié, ce qui manque à la façon de faire retenue et ce que l’utilisateur a ajouté
  (`node.data.shown`) ; geste de fil : `NodeView.setReveal`.
- Entrées et façons de faire **« à essayer »** (`trial` dans `model-families.json`) : badge dans le menu « + »,
  l’infobulle et la ligne « Ce que fait le bloc », note dans le résultat.
- MiniMax : `refAudios` (3 sons, `ref_audios` du nœud, « Son n » décalé après les sons des vidéos), `keys` et
  `audio` (`MiniMaxH3AddGuide`), façon de faire « Prolonger une vidéo » (39 dernières images ancrées à l’image 0,
  vidéo d’origine + suite), 768p (`minimaxCanvas`, toile native 768 × 1344).
- LTX : `keys` (`LTXVAddGuide` aux images réparties), `twoPass` (`LTXVLatentUpsampler` ×2 + 3 pas distillés ;
  caché, hors catalogue : moins net qu’une passe à l’essai GPU du 24/10), `enhance` (`TextGenerateLTX2Prompt` sur le Gemma de LTX, texte relu par `PreviewAny`).
- Wan : `motionFidelity` / `likeness` → `pose_strength` / `reference_image_strength`. Qwen : `ref` multiple (2).
- Pont des assistants : `choices[].ways` (needs, needsOneOf, takes, settings, trial), `howItWorks` détaillé,
  `mia_get_board` → `model` {family, does, workflow, otherWays, connect, ignored, trial} et réglages du seul
  modèle ; descriptions et instructions du serveur MCP ; guides mia-piloter et mia-recettes-video.

### Changé
- Audit du 25/10 (UX, textes, façons de faire) : règle de choix (une façon de faire qui ne se sert d’aucune entrée
  branchée n’est possible que si rien n’est branché ; une entrée principale ignorée pèse plus qu’une entrée
  d’appoint ; rien de branché = pas de choix proposé), vidéo guidée et photoréaliste prennent l’image de début comme
  image de look, MiniMax sans « Zone libre » en vidéo guidée, consigne obligatoire dite avant le lancement, réglages
  cachés du bloc Modèle plus envoyés au calcul (« À éviter », LoRA), Média vide compté comme branché, résolution
  calculée = résolution affichée, format des références = 16:9 affiché, estimation et boutons de la façon de faire
  retenue (Qwen : un seul « Lancer »), pastilles « Image n » seulement pour les références, onglets « Sur ce PC | En
  ligne », accents des pastilles, « + Bloc » pose le nouveau bloc à droite de la sélection, recherche par nom de
  modèle, textes simplifiés (FR/EN) ; nouveaux bancs tools/test-route.js.
- Le modèle n’est plus jamais rangé sous « Avancé » dans un bloc de génération.
- À égalité, la façon de faire dont les exigences sont remplies passe devant celle qui n’exige rien (des références
  et une image-clé → « Vidéo à partir de références ») ; deux façons aux mêmes exigences restent proposées au choix.
- « Vidéo à partir de références » accepte des vidéos de référence sans image.
- Qwen : l’entrée « Référence » devient « Images d’appui » (jusqu’à 2).
- **Animer une image** et **Vidéo à partir de références** : jusqu’à 15 s avec MiniMax H3 (sa limite vérifiée au
  labo) ; le moteur ramène toute durée à la limite du modèle et le note dans le résultat.
- Le texte reçu d’une Consigne branchée (« Vient de … ») se lit en entier au survol quand il dépasse trois lignes.

### Corrigé
- « Enrichir la consigne » (LTX) est caché : à l’essai, la consigne réécrite était du charabia et la vidéo en partait
  (le Gemma de ce PC sait lire une consigne, pas en écrire une ; le petit modèle prévu pour n’est pas installé).
- « Vidéo depuis une fiche personnage » (LTX, à essayer) : la vidéo prend le format de la fiche, comme le gabarit
  officiel ; posée dans un cadre 16:9 bordé de noir, la fiche était recopiée telle quelle (essai GPU du 25/10).
- Bloc Modèle (relecture du 25/10) : la ligne « Partir de » revient après un changement de modèle ; un bloc replié
  reçoit de nouveau un fil ; un fil lâché sur le corps va à l’entrée choisie dans « Partir de » ; au Ctrl+glisser,
  l’entrée décrochée ne saute plus sous le pointeur ; « Ce que fait le bloc » suit chaque fil branché ou débranché ;
  Genjutsu (en ligne) montre ce qui lui manque ; Kling O3 propose ses références. Assistants : un fil sans entrée
  nommée va aux références de MiniMax tant qu’il y a de la place, un son à « Son à suivre ».
- La croix qui coupe un fil ne coupait pas : l’effet « enfoncé » faisait perdre la croix au navigateur.
- Les blocs restaient flous après un zoom avant : la planche est redessinée nette une fois le zoom posé.
- Higgsfield : une image en ligne avec une image de référence (Soul…) était refusée (« URL input should be a string
  ») ; chaque champ reçoit maintenant une adresse seule ou une liste, selon ce qu’il attend.
- Bloc Modèle en ligne : « Ce que fait le bloc » dit « Image depuis un texte + Images de référence » quand les
  références branchées servent ; le puits du résultat n’annonce plus « ≈ 1 min » pour un calcul en ligne.
- La recherche de « + Bloc » ouverte depuis un fil n’est plus coupée (« Chercher… »).

### Pour les développeurs
- Points de départ : `startPoints` (`src/js/nodes/ports.js`, 1re exigence de chaque façon de faire, ou son entrée de
  tête) ; une famille à plusieurs façons de faire ne montre plus d’entrée principale d’office ; pont des assistants :
  `model.startFrom`, `model.uses`, un fil sans port va à l’entrée principale. Cloud : `uploadsOf`/`bodyOf`
  suivent `multi` du catalogue (`tools/test-cloud.js` vérifie les 94 champs).
- Ports par bloc : `src/js/nodes/ports.js` (`nodeInputs`, `nodeOutputs`, `nodePortDef`) remplace la lecture directe
  du catalogue dans l’éditeur, le geste de fil et le pont des assistants (les autres blocs lisent la même chose
  qu’avant). Moteur : `planGen` (index.js), `executors/gen.js` (renvoie vers i2v, t2v, ref2v, guided, real, perform,
  edit ou cloud), `gpu: "auto"`, empreinte avec le workflow et les réglages `hf.*`. Tests : `tools/test-cloud.js`.
- Réglage `limit` ("seconds" | "fps" | "resolutions") et liste `limits` sur le réglage de modèle (puces de la
  carte) dans `nodes.json` ; évaluation dans `src/js/nodes/profiles.js` et `params.js`, bornes moteur par
  `patch.js` (`familyLimits`, `maxSeconds`).

## 0.5.1 — 17/10/2026

### En bref
- **Finitions partout** : plus rien ne déborde des blocs, des menus ni des fenêtres, en français comme en anglais
  (un choix trop large passe sous son libellé au lieu de sortir du bloc).
- **Première version publique** : code ouvert sous licence Apache-2.0, page GitHub avec démonstrations animées.

### In short
- **Polish everywhere**: nothing overflows blocks, menus or windows any more, in French or English (a choice that
  is too wide moves under its label instead of spilling out of the block).
- **First public release**: open source under Apache-2.0, GitHub page with animated demos.

### Corrigé
- Le choix « Raccord » du bloc **Assembler** (« Passage au noir ») sortait de la carte ; les choix segmentés
  s’adaptent maintenant à la largeur du bloc, dans les deux langues.
- Débordements, textes coupés et libellés mal tronqués relevés par un contrôle automatique de toutes les surfaces
  (blocs, accueil, réglages, bibliothèque, onglets, palette, menus, file de calcul).

### Pour les développeurs
- `tools/check-overflow.mjs` : contrôle géométrique des débordements et des textes coupés, en français et en anglais,
  sur une planche de banc qui pose chaque type de bloc.
- `tools/check-syntax.mjs` : syntaxe de tous les fichiers JavaScript ; jeux de test autonomes dans `tools/fixtures/`.
- Licences : `NOTICE` et `electron/engine/workflows/NOTICE.md` donnent la source, la licence et les modifications de
  chaque gabarit ComfyUI (Apache-2.0, MIT, LTX-2.x Community License, GPL-3.0).

## 0.5.0 — 17/10/2026

### En bref
- **Installer Mia chez quelqu’un** : un installateur Windows, ou une version portable à décompresser.
- **Bienvenue dans Mia** : au premier lancement, Mia aide à trouver ou à installer son moteur, puis les modèles.
- **Les modèles manquants s’installent depuis Modèles** : taille annoncée, pause, reprise après une coupure.
- **Une app plus vivante** : blocs, fils, onglets et fenêtres bougent avec retenue ; le réglage d’animations de
  Windows est respecté.
- **Version et nouveautés** : le numéro de version dans Réglages → À propos, et ce résumé à chaque nouvelle version.

### In short
- **Install Mia on someone else's PC**: a Windows installer, or a portable version to unzip.
- **Welcome to Mia**: on first start, Mia helps you find or install its engine, then the models.
- **Missing models install from Models**: size shown first, pause, resume after a cut.
- **A livelier app**: blocks, wires, tabs and windows move with restraint; Windows' animation setting is respected.
- **Version and what's new**: the version number in Settings → About, and this summary with every new version.

### Ajouté
- **Installer Mia sur un autre PC** : un installateur Windows (pour l’utilisateur seul, sans droits
  d’administrateur, dossier au choix, raccourcis Bureau et menu Démarrer) et une version portable en zip.
- **Installer le moteur depuis Mia** : Python, ComfyUI, PyTorch pour carte NVIDIA et les outils de Mia, dans le
  dossier de son choix, toujours aux mêmes versions. Relançable : une installation interrompue reprend.
- **Assistant de premier lancement** : « Bienvenue dans Mia » quand aucun moteur n’est trouvé — reprendre le dossier
  du moteur de Mia ou un ComfyUI déjà lancé sur ce PC, installer le moteur, ou plus tard — puis les modèles à
  installer.
- **Installer les modèles manquants** depuis Modèles : taille annoncée, téléchargements un par un avec reprise, pause
  et annulation, vérification de la taille, rangement dans le dossier du moteur.
- **Numéro de version** et date dans Réglages → À propos ; au premier lancement d’une nouvelle version, un message
  discret « Nouveautés » ouvre ce résumé.
- Une planche enregistrée par une version plus récente de Mia s’ouvre en lecture seule, pour ne rien abîmer.
- **Mouvement** : blocs qui apparaissent et disparaissent, fils qui se branchent, fin de calcul, onglets, menus,
  fenêtres et messages animés avec retenue.
- **Skills pour assistants** (Claude, Codex) : piloter Mia, recettes vidéo, faire évoluer Mia sans la casser.

### Changé
- Les outils de la Finition (LUT, grain, optique) sont livrés avec Mia, à la même version partout.
- Réglages → Assistants : la commande à donner à Claude ou à Codex marche sans rien installer de plus.

### Corrigé
- Des blocs copiés depuis une planche qu’on vient de ranger dans un projet gardent leurs images et vidéos au collage.
- Le message qui confirme le renommage d’une planche ou d’un projet.
- Les descriptions des looks.
- Une planche vide (ou vue vide) s’ouvre bien cadrée.

### Pour les développeurs
- Paquet : electron-builder (`npm run dist` : NSIS + zip portable dans `release\`), `asar: false`. Avant chaque
  paquet, `tools/check-package.js` vérifie les fichiers de l’interface, LICENSE et NOTICE, l’absence de chemins
  personnels, et écrit `build-info.json` (commit, date). Ne jamais joindre `builder-debug.yml` ni les `.blockmap`
  à une publication.
- Moteur : `engine-setup/install-engine.ps1` (`-DryRun` montre chaque étape sans rien télécharger) ; versions
  figées dans `versions.txt` (Python, uv, ComfyUI, torch, torchvision, torchaudio), nœuds à un commit précis dans
  `custom_nodes.txt`, toutes les dépendances Python tenues par `constraints.txt` (relevé du moteur de test, torch
  à part). Python installé par uv sans inscription dans le registre de Windows.
- Les modules `tool.*` du calcul sont copiés dans `python/vendor` (copie figée et datée) et passent avant ceux du
  moteur.
- Formats versionnés (`graph.json`, `project.json`, `folder.json`, `prefs.json`, `loras.json`) et chaîne de
  migrations `electron/migrations.js` (copie `.bak-<version>` avant d’écrire un format plus récent ;
  `node tools/test-migrations.js`).
- `electron/version.js` : `{version, date, commit}` (le commit vient de `.git`, sinon de `build-info.json`).
- Licence Apache-2.0, présentation en français et en anglais ; installation pas à pas : `docs/INSTALL.md`.

## 0.4.0 — 17/10/2026

### En bref
- **Projets** : un projet range plusieurs planches, avec sa couleur ; ses onglets se regroupent comme dans Chrome.
- **Son** : garder ou remplacer le son d’une vidéo, régler les volumes et les fondus.
- **Finition et looks** : étalonnage, grain, vignettage, et sept looks « film » à comparer côte à côte.
- **Assistants** : Claude et Codex rangent leurs planches dans le bon projet.

### In short
- **Projects**: a project holds several boards, with its own colour; its tabs group together as in Chrome.
- **Sound**: keep or replace the sound of a video, set the volumes and fades.
- **Finishing and looks**: grading, grain, vignette, and seven "film" looks to compare side by side.
- **Assistants**: Claude and Codex put their boards in the right project.

### Ajouté
- **Projets et planches** : un projet regroupe plusieurs planches (un dossier sur le disque). L’accueil montre les
  PROJETS puis les PLANCHES sans projet ; fil d’Ariane « Projets › … » ; glisser une planche sur un projet pour l’y
  ranger ; une couleur par projet ; supprimer un projet en gardant ses planches.
- **Onglets groupés** comme dans Chrome : pastille colorée au nom du projet, repliable, liseré de couleur sous ses
  onglets. Ctrl+N : nouvelle planche dans le projet de l’onglet actif ; Ctrl+Maj+N : nouveau projet.
- **Son** : un Média accepte aussi wav, mp3, m4a, flac… (forme d’onde, lecteur sobre) ; bloc « Son » pour garder ou
  remplacer le son d’une vidéo, régler les volumes, les fondus, la boucle.
- **Finition** : étalonnage par LUT, grain, vignettage, et en option l’optique de cinéma ; « Garder les rouges ».
- **Looks** : une famille de sept LUT « film » (Etalo doux, Etalo nuit, Pellicule chaude, Pellicule froide, Sans
  blanchiment, Crépuscule, Noir et blanc argentique) et le bloc « Essayer des looks » (planche contact).
- Réglage « fichier » dans les blocs : choisir un fichier (une LUT .cube) ou le lâcher sur le bloc.

### Changé
- Vocabulaire : une **planche** est une toile de blocs, un **projet** est un dossier de planches.
- Palette des blocs : descriptions sur deux lignes, phrase entière au survol.

### Corrigé
- Deux projets ne peuvent plus porter le même nom ; un chemin périmé après un renommage.
- Onglets lisibles dès 900 px de large.
- Les assistants retrouvent une planche par ses deux identifiants, et réutilisent un projet du même nom.
- Les fils suivent un bloc qui s’élargit.

### Pour les développeurs
- Outils MCP : `mia_add_section`, `mia_create_folder` ; `mia_create_project` prend `folder` ; `mia_list_projects`
  rend `{folders, boards}`.
- Instances de test : `MIA_NO_GPU=1` bloque tout calcul GPU, même relancé en cascade par un bloc en aval.

## 0.3.0 — 16/10/2026

### En bref
- **Lecteur image par image**, et « Extraire cette image » en un clic.
- **Sections** nommées pour ranger une planche, à la Figma ou Miro.
- **Vidéo à partir de références** (jusqu’à neuf images et trois vidéos) et **Vidéo guidée**.
- **Format et résolution** au choix pour les vidéos.

### In short
- **Frame-by-frame player**, and "Extract this frame" in one click.
- Named **sections** to tidy a board, as in Figma or Miro.
- **Video from references** (up to nine images and three videos) and **Guided video**.
- **Format and resolution** of your choice for videos.

### Ajouté
- **Lecteur image par image** : compteur en images, secondes ou timecode ; ← → pour une image, Maj pour dix ;
  vitesse de ×0,25 à ×2 ; « Extraire cette image » crée et lance le bloc tout de suite.
- **Sections** à la Figma ou Miro : cadre nommé, six teintes, touche S ou Ctrl+G ; déplacer une section déplace ses
  blocs.
- **Fiche de référence** dans « Animer une image » : une image guide tenue sur tout le plan.
- **Vidéo à partir de références** : jusqu’à neuf images et trois vidéos, appelées « Image 1 », « Vidéo 2 »… dans la
  consigne.
- **Vidéo guidée** : une vidéo guide, dont Mia extrait elle-même la profondeur ou les contours ; fidélité au guide,
  zone libre, image de départ.
- **Format et résolution** des vidéos : comme l’image de départ, 16:9, 9:16, 1:1, 4:3, 3:4, 21:9 ; 540, 720 ou 1080.

### Changé
- Version affichée d’un bloc : l’épinglée, sinon le dernier rendu final, sinon le dernier aperçu — un bloc en aval
  ne prend jamais un aperçu quand un rendu final existe.
- Plus de repères d’alignement ni d’aimant pendant les déplacements ; grille aimantée seulement si elle est activée
  (ou en tenant Alt).
- Le contenu des blocs reste lisible en dézoomant ; un bloc ne change jamais de taille avec le zoom.
- « Modèle » plutôt que « Moteur » pour le choix du modèle dans un bloc.

### Corrigé
- Les fils arrivent pile sur les pastilles des ports.
- Puits média et visionneuse : l’image n’est jamais rognée, le cadre prend le format du média.
- Les fichiers temporaires de Mia sont nettoyés dans le moteur après chaque calcul.

### Pour les développeurs
- Contrôle automatique des fils : `node tools/check-wires.mjs <port CDP> --all`.

## 0.2.0 — 16/10/2026

### En bref
- **LoRA** : glisser un fichier pour l’ajouter, puis le choisir dans les blocs.
- **Pilotage par un assistant** : Claude ou Codex posent et relient les blocs sous tes yeux ; Ctrl+Z annule ce
  qu’ils font.
- 90 petits défauts corrigés.

### In short
- **LoRA**: drop a file to add it, then pick it in the blocks.
- **Driven by an assistant**: Claude or Codex place and wire the blocks before your eyes; Ctrl+Z undoes what they
  do.
- 90 small defects fixed.

### Ajouté
- **LoRA** : glisser un fichier pour l’ajouter (famille reconnue, mot déclencheur, genre), dossiers de LoRA dans les
  réglages, rangées « Personnage ou lieu » et « Force » dans les blocs ; le mot déclencheur est ajouté tout seul à
  la consigne. Bibliothèque : section « Mes LoRA ».
- **Pilotage par un assistant** (Claude, Codex) : on voit le curseur de l’assistant poser, relier, régler et lancer
  les blocs, et Ctrl+Z annule ce qu’il a fait.

### Corrigé
- Les 90 constats du premier contrôle qualité (interface, moteur, modèles, fichiers).

### Pour les développeurs
- Serveur MCP local `mcp/mia-mcp.js`, pont `127.0.0.1` à jeton (`electron/bridge.js`).

## 0.1.0 — 16/10/2026

Première version.

### En bref
- Première version : une planche nodale sobre pour l’IA locale, des blocs simples, des recettes pour démarrer, et
  tout le calcul sur ce PC.

### In short
- First version: a sober node board for local AI, simple blocks, recipes to start with, and every computation on
  this PC.

### Ajouté
- Planche nodale infinie, noire et sobre : barre de titre flottante, onglets, accueil en grille,
  menus, messages et fenêtres maison ; rien de Windows visible.
- Français et anglais ; thème sombre et clair ; souris et trackpad.
- Blocs : Média, Consigne, Note, Animer une image, Vidéo depuis un texte, Rendre photoréaliste, Animer un
  personnage, Retoucher une image, Agrandir, Profondeur, Détourer, Comparer A/B, Extraire une image, Couper,
  Redimensionner, Superposer, Assembler, Exporter.
- Recettes pour démarrer : animer une image, d’Unreal au photoréel, profondeur d’une vidéo, détourer un
  personnage, animer un personnage.
- Calcul : ComfyUI sur ce PC et le calcul Python de Mia ; une file, un seul calcul lourd à la fois ; aperçu puis
  rendu final ; heure de fin estimée.
- Versions de chaque bloc (l’étoile épingle celle qui part en aval), visionneuse plein écran.
- Bibliothèque de modèles : recherche au lancement, capacités en langage simple, licences.
