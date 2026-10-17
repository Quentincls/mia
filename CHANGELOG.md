# Journal des versions de Mia

Les évolutions notables de Mia, de la plus récente à la plus ancienne. Numéros de version
[SemVer](https://semver.org/lang/fr/) : Mia reste en 0.x tant que ses formats de fichiers peuvent encore évoluer.

Les fichiers de Mia (planches, projets, réglages) sont mis à jour tout seuls à l’ouverture, sans rien perdre : avant
d’écrire un fichier dans un format plus récent, Mia garde l’ancien à côté (`graph.json.bak-v0`, `prefs.json.bak-v0`…).

Chaque version commence par **En bref** (en français) et **In short** (en anglais) : quelques lignes en mots simples,
celles que Mia affiche dans « Nouveautés ». Suivent le détail (Ajouté, Changé, Corrigé) et, à la fin, ce qui ne
concerne que les développeurs.

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
