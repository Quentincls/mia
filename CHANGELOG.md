# Journal des versions de Mia

Les évolutions notables de Mia, de la plus récente à la plus ancienne. Numéros de version
[SemVer](https://semver.org/lang/fr/) : Mia reste en 0.x tant que ses formats de fichiers peuvent encore évoluer.

Les fichiers de Mia (planches, projets, réglages) sont mis à jour tout seuls à l’ouverture, sans rien perdre : avant
d’écrire un fichier dans un format plus récent, Mia garde l’ancien à côté (`graph.json.bak-v0`, `prefs.json.bak-v0`…).

Chaque version commence par **En bref** (en français) et **In short** (en anglais) : quelques lignes en mots simples,
celles que Mia affiche dans « Nouveautés ». Suivent le détail (Ajouté, Changé, Corrigé) et, à la fin, ce qui ne
concerne que les développeurs.

## À venir

### En bref
- **MiniMax jusqu’à 3 fois plus rapide** : un nouveau réglage **Rendu** sur MiniMax (animer une image, partir d’un
  texte) : **Esquisse** (2 étapes, environ 2 min 30 au lieu de 8 min pour 5 s sur la Spark) pour chercher le mouvement
  et le cadrage, **Rapide** (4 étapes, presque la qualité habituelle en 2 fois moins de temps), **Standard** (comme
  avant) et **Pika** (le style de Pika H3 Flex).
- **PAN 2, un nouveau modèle vidéo** : un modèle « du monde » qui suit de près les actions et les mouvements de caméra
  que tu décris, seconde par seconde. Pas de son, et lent (environ 30 min pour 5 s en 720p) : pour les plans importants.
  Mia rédige pour lui une description détaillée à partir de ta consigne et de ton image ; elle apparaît dans la version.
- **Moteur à jour** : ComfyUI passe en 0.46.3.

### In short
- **MiniMax up to 3 times faster**: a new **Render** setting on MiniMax (animate an image, start from text): **Sketch**
  (2 steps, about 2 min 30 instead of 8 min for 5 s on the Spark) to find the motion and framing, **Fast** (4 steps,
  close to the usual quality in half the time), **Standard** (as before) and **Pika** (the Pika H3 Flex look).
- **PAN 2, a new video model**: a “world” model that closely follows the actions and camera moves you describe, second
  by second. No sound, and slow (about 30 min for 5 s at 720p): for the shots that matter. Mia writes a detailed
  description for it from your prompt and your image; it shows in the version.
- **Engine up to date**: ComfyUI moves to 0.46.3.

### Ajouté
- Bloc Modèle, MiniMax H3 : réglage `h3mode` (« Rendu ») sur « Animer une image » et « Vidéo depuis un texte ».
  Esquisse et Rapide = adaptateurs pi-H3 (Lakonik, 2 ou 4 étapes, l’image sort directement du modèle sans décodeur
  vidéo) ; Pika = LoRA Pika H3 Flex, 6 étapes. Prolonger une vidéo reste en Standard (note dans la version).
- Bloc Modèle : famille **PAN 2** (MBZUAI IFM, Apache-2.0), animer une image ou partir d’un texte, 540p ou 720p, 2 à
  15 s. Une consigne qui est déjà une légende JSON de PAN 2 est utilisée telle quelle. PAN 2 choisi dans les blocs
  « Animer une image » ou « Vidéo depuis un texte » marche aussi.
- Modèles : PAN 2 et ses pièces reconnus ; les adaptateurs pi-H3 et le style Pika rangés dans les pièces (jamais
  proposés comme LoRA de personnage) ; installation possible depuis Mia (fichiers, versions et empreintes figés).

### Changé
- Moteur : ComfyUI v0.39.2 → **v0.46.3**, nouveau nœud **ComfyUI-piFlow** (commit figé), paquets ComfyUI à jour
  (`engine-setup`). Tous les graphes de Mia ont été revalidés sur la 0.46.3.

### Pour les développeurs
- `electron/engine/executors/pan2.js` (deux calculs : légende par Qwen 3.5 avec la consigne système des auteurs, puis
  vidéo) ; `workflows/pan2_caption.api.json`, `workflows/pan2_i2v.api.json`, `workflows/pan2/` (Apache-2.0, ifm-ai/PAN2).
- `tools/fixtures/comfy_object_info.json` refait depuis ComfyUI 0.46.3, listes de fichiers limitées aux modèles publics.
- Essais GPU du 25/11 (Spark) : 487 s (Standard), 354 s (Pika), 267 s (Rapide), 143 s (Esquisse) pour 5 s en
  704 × 1248 ; PAN 2 ≈ 31 s par étape. `ModelSamplingSD3` ne doit jamais précéder PAN 2 (multiplicateur forcé à 1000 :
  du bruit).

## 0.11.0 — 25/11/2026

### En bref
- **Six nouveaux modèles en ligne (Higgsfield)** : en vidéo, **MiniMax H3 Lite** (la vidéo la moins chère, pour
  chercher une idée), **MiniMax H3 Highspeed**, **Kling 4.0 Flash** (720p, rapide) et **MAGI-2** (1080p jusqu’à
  30 s, avec le son) ; en image, **Kling Image 4.0** (jusqu’en 8K) et **Seedream 5.0 Pro**.
- **Prix en ligne à jour** : Higgsfield a changé ses tarifs (Kling, Wan, Hailuo et Happy Horse plus chers, Seedance
  et Cinema Studio 4.0 moins chers) ; les coûts affichés suivent.
- **Mia repère seule les nouveaux modèles en ligne** : une fois par jour au plus, quand ton compte Higgsfield est
  relié, elle regarde les pages publiques de Higgsfield (sans ta clé, sans crédit). Un modèle qu’elle n’a pas encore
  s’annonce sur l’accueil (« 2 nouveaux modèles en ligne ») : **Installer** l’ajoute aussitôt, sans attendre une
  nouvelle version de Mia. Il porte « Nouveau » jusqu’à son premier calcul réussi. On coupe la veille dans Réglages →
  Comptes en ligne.

### In short
- **Six new online models (Higgsfield)**: for video, **MiniMax H3 Lite** (the cheapest video, to look for an idea),
  **MiniMax H3 Highspeed**, **Kling 4.0 Flash** (720p, fast) and **MAGI-2** (1080p up to 30 s, with sound); for
  images, **Kling Image 4.0** (up to 8K) and **Seedream 5.0 Pro**.
- **Online prices up to date**: Higgsfield changed its rates (Kling, Wan, Hailuo and Happy Horse cost more, Seedance
  and Cinema Studio 4.0 less); the costs shown follow.
- **Mia spots new online models by itself**: once a day at most, while your Higgsfield account is linked, it looks
  at Higgsfield’s public pages (without your key, without credits). A model it does not have yet shows on the home
  page (“2 new online models”): **Install** adds it at once, without waiting for a new version of Mia. It reads
  “New” until its first successful run. Turn the watch off in Settings → Online accounts.

### Pour les développeurs
- Veille des modèles en ligne (SPEC §23.8) : `electron/cloudwatch.js` (repérer, installer, ignorer, « essayé »),
  normalisation partagée avec le builder dans `electron/cloud-catalog.js` (le builder ne garde que la lecture des
  pages et l’écriture des fichiers), catalogue complémentaire `%APPDATA%Miadatacloud-extra.json` fusionné par
  `engine/route.js` (le livré passe devant). Canaux `cloud:catalog`, `cloud:watch*`, évènement `cloud:watch`.
  Bancs `tools/test-cloud-watch.js` (faux Higgsfield) et `tools/check-cloud-watch-ui.mjs` (Mia de test cachée).
- Catalogue Higgsfield relevé le 25/11 (`tools/build-cloud-catalog.mjs`) : 43 familles, 95 workflows. Écartés :
  les séries Kling Image (`/series`, 2 à 10 images payées alors que Mia n’en garde qu’une) et
  `seedance-2.5/finalize-draft` (`draft_id`) ; le champ `draft` de Seedance 2.5 passe en « interface à venir ». Points
  forts des 6 familles dans `cloud-strengths.json`. L’ancien MiniMax H3 n’est plus dans la console (gardé d’après la
  doc, sans prix public).

## 0.10.2 — 24/11/2026

### En bref
- **Claude range bien la planche** : il voit les blocs qui se recouvrent (un bloc grandit quand son image
  arrive), peut les ranger en grille, seulement les siens ou ceux d’une section (la section s’ajuste autour), et
  peut déplacer un bloc à une place précise, jamais par-dessus un autre. Tout s’annule avec Ctrl+Z.

### In short
- **Claude tidies the board well**: it sees the blocks that cover each other (a block grows when its image
  arrives), can arrange them in a grid, only its own or those of a section (the section fits around them), and can
  move a block to a precise place, never onto another one. Ctrl+Z undoes it all.

### Pour les développeurs
- MCP : nouvel outil `mia_move_blocks` (`moves: [{nodeId, x, y}]` ou `nodeIds` + `dx` / `dy`, refusé si un bloc
  en recouvrirait un autre) ; `mia_arrange` prend `nodeIds`, `sectionId`, `layout: "flow" | "grid"` et `columns`,
  et rend les nouvelles positions ; `mia_get_board` donne `overlaps` (blocs qui se recouvrent, à leur vraie
  hauteur) et les `nodeIds` de chaque section. Consigne « A TIDY BOARD » dans les instructions du serveur.
- `graph/layout.js` : `grid()` et `overlapPairs()` ; `graph/editor.js` : `moveNodes`, `sectionNodes`,
  `overlapping`, et `arrange(ids, {layout, columns, section})` (un rangement partiel ne se pose jamais sur les
  autres blocs).

## 0.10.1 — 24/11/2026

### En bref
- **« Je valide · Auto »** : l’interrupteur en bas à gauche de la planche dit maintenant « Auto » au lieu de
  « Claude agit seul » (même rôle : Claude lance tout sans te demander, y compris les calculs en ligne payants).
  Une petite prise remplace la flèche à côté ; elle passe en bleu en « Auto ».
- **Toutes les versions d’un bloc se retrouvent** : quand la bande des versions sous un résultat est trop longue,
  des flèches ‹ › la font défiler (la molette aussi). Elle s’ouvre sur la plus récente. Avant, les plus anciennes
  disparaissaient dans « +4 » sans moyen de les voir.
- **Un seul menu au clic droit sur une vidéo** : « Extraire cette image » et « Copier le numéro d’image » sont en
  haut du menu du bloc, séparés par un trait, et le menu reste ouvert. Avant, le menu du bloc s’ouvrait puis un
  second le remplaçait une fraction de seconde après.

### In short
- **“I approve · Auto”**: the switch at the bottom left of the board now says “Auto” instead of “Claude acts
  alone” (same role: Claude starts everything without asking you, paid online computations included). A small
  plug replaces the arrow next to it; it turns blue in “Auto”.
- **Every version of a block is within reach**: when the strip of versions under a result is too long, ‹ › arrows
  scroll it (the mouse wheel too). It opens on the latest one. Before, the oldest ones vanished into “+4” with no
  way to see them.
- **One menu on a right click on a video**: “Extract this frame” and “Copy the frame number” sit at the top of the
  block’s menu, under a line, and the menu stays open. Before, the block’s menu opened, then a second one replaced
  it a split second later.

### Pour les développeurs
- `ui/menu.js` : `registerNodeMenuExtras(fn)` / `nodeMenuExtras(nodeId, at)`, des entrées en tête du menu d’un bloc
  selon l’endroit du clic ; `nodes/media.js` y inscrit celles du puits vidéo (hors planche, le puits garde son
  propre menu). Le menu d’un bloc s’ouvre sans champ « Rechercher… ».
- `nodes/versions.js` : piste défilante `.nb-vers-track` et boutons `.nb-vers-nav` au lieu du compte « +N » ;
  vignettes en `loading="lazy"`.
- Assistants (MCP) : le mode `"auto"` s’appelle « Auto » dans les textes ; l’identifiant ne change pas.

## 0.10.0 — 20/11/2026

### En bref
- **Entraîne tes LoRA dans Mia** : un nouvel écran « Entraînements », ouvert par la puce **ENTRAÎNER** de la barre
  de titre. Tu glisses tes images, tu donnes un nom et un mot déclencheur, tu choisis la durée, puis « Lancer
  l’entraînement ». Pendant les heures de calcul, tu vois tout : la progression, l’heure de fin, la courbe, les
  essais qui arrivent, la mémoire. Les outils d’entraînement s’installent à part : Réglages → Entraînement dit ce
  qui manque.
- **Rien ne se perd** : « Pause » et « Arrêter… » enregistrent là où on en est, tu peux toujours reprendre, et
  fermer Mia par erreur ne casse rien. À la fin, le LoRA arrive tout seul dans « Mes LoRA », prêt dans tes blocs.
- **Génère une image pendant un entraînement** : elle part à côté quand la mémoire le permet, sinon elle attend de
  la place et part toute seule dès qu’il y en a. Une vidéo attend la fin de l’entraînement.
- **Chaque calcul en attente dit pourquoi**, en clair : « Une vidéo ne part pas à côté : après l’entraînement, vers
  15 h 10 », « Manque de mémoire : il faut ≈ 23 Go, 34 libres moins 16 de marge »…
- **La jauge GPU dit juste** : elle compte la mémoire prise par tous les programmes, comme le panneau NVIDIA. Avant,
  sur la RTX Spark, elle affichait « 2,9 / 94 Go » pendant un entraînement qui en prenait 46.
- **« Je valide » ou « Claude agit seul »**, en un clic en bas à gauche de la planche : avec « Je valide », Claude
  attend ton feu vert ; avec « Claude agit seul », il lance tout sans te demander,
  **y compris les calculs en ligne payants**, pour quand tu n’es pas devant ton PC. « Pause » l’arrête toujours.
  Un entraînement préparé par Claude part alors lui aussi sans ton clic.
- **Tu sais quelle version de LTX 2.5 tu choisis** : « Compacte », « Pleine »…, chacune avec la mémoire qu’elle
  prendra (« ≈ 71 Go ») à côté de celle de ta machine. « Auto » reste sur la compacte : même image, moins de temps
  et de mémoire.
- **Et aussi** : plus de fenêtre noire au démarrage de ComfyUI (moteur dans un environnement virtuel Python), tes
  résultats restent à jour si le dossier du moteur change de place, et un seul chiffre pour la mémoire de la
  machine, le même partout.
- **Mia existe aussi pour les PC ARM64** (Windows sur processeur ARM, comme la RTX Spark) : un installateur et une
  version portable arm64, en plus de ceux pour les PC classiques (x64), comme avant. Sur ARM64, le moteur (ComfyUI)
  s’installe à la main : l’installation automatique reste pour les PC x64.

### In short
- **Train your LoRAs in Mia**: a new “Trainings” screen, opened by the **TRAIN** chip in the title bar. Drop your
  images, give a name and a trigger word, pick a length, then “Start training”. During the hours of computing, you
  see everything: the progress, the end time, the curve, the samples as they come, the memory. The training tools
  are installed separately: Settings → Training tells what is missing.
- **Nothing is lost**: “Pause” and “Stop…” save where it is, you can always resume, and closing Mia by mistake
  breaks nothing. At the end, the LoRA lands in “My LoRAs” by itself, ready in your blocks.
- **Generate an image during a training**: it runs alongside when the memory allows it, else it waits for room and
  starts by itself as soon as there is some. A video waits for the end of the training.
- **Each waiting job says why**, plainly: “A video does not run alongside: after the training, around 3:10 PM”,
  “Not enough memory: needs ≈ 23 GB, 34 free minus the 16 GB margin”…
- **The GPU gauge tells the truth**: it counts the memory taken by all programs, as NVIDIA’s panel does. Before, on
  the RTX Spark, it showed “2.9 / 94 GB” during a training that took 46.
- **“I approve” or “Claude acts alone”**, one click at the bottom left of the board: with “I approve”, Claude waits
  for your go-ahead; with “Claude acts alone”, it starts everything without asking you,
  **paid online computations included**, for when you are away from your PC. “Pause” still stops it. A training
  Claude prepared then starts without your click too.
- **You know which LTX 2.5 version you pick**: “Compact”, “Full”…, each with the memory it will take (“≈ 71 GB”)
  next to your machine’s. “Auto” stays on the compact one: same picture, less time and memory.
- **Also**: no more black window when ComfyUI starts (engine in a Python virtual environment), your results stay
  current if the engine folder moves, and one number for the machine’s memory, the same everywhere.
- **Mia now also exists for ARM64 PCs** (Windows on an ARM processor, like the RTX Spark): an installer and a
  portable arm64 version, besides the ones for regular PCs (x64), as before. On ARM64, the engine (ComfyUI) is
  installed by hand: the automatic install stays for x64 PCs.

### Ajouté
- Interrupteur « Je valide · Claude agit seul » / “I approve · Claude acts alone”, un îlot en bas à gauche de la
  planche, à droite de « Bloc · Recettes · Section » : le même réglage que Réglages → Assistants → « Demander mon feu
  vert » (chacun suit l’autre). Infobulle de « Claude agit seul » : « Claude lance tout sans te demander, y compris les
  calculs en ligne payants. » Passer en « agit seul » accepte la demande qui attend sur sa carte ; les calculs déjà dans
  « À générer » y restent, avec la ligne « Proposés avant « Claude agit seul » : ils attendent ta coche. » (rien ne part
  sans que tu l’aies vu) ; revenir à « Je valide » redemande ton feu vert à la prochaine action de Claude, sans rien
  annuler. « Claude agit seul » se voit en bleu. Dans une fenêtre étroite (montant Higgsfield affiché), l’îlot ne montre
  que le mode choisi : « Claude demande » ou « Claude agit seul », précédé d’un petit interrupteur, et un clic passe à
  l’autre.
- Écran « Entraînements » / “Trainings” (une troisième vue à côté de l’accueil et de la planche, ouverte par la puce
  « ENTRAÎNER » ou par « Entraîner un LoRA » dans Mes LoRA ; « ‹ Retour à … » et Échap ramènent à la planche
  quittée) : la liste (état, taille sur le disque, date, point « pas encore ouvert », « Dupliquer en brouillon »,
  « Mettre à la corbeille », « Retrouver le dossier… »), le brouillon (images glissées, légendes `.txt` du même nom,
  images trop petites repérées, nom et mot déclencheur, modèle : LTX 2.5, ou Qwen-Image 2.1 grisé tant qu’il n’a pas
  été essayé sur la machine, durée Court, Normal ou Long, raisons écrites quand « Lancer » est éteint, estimation de
  la durée et de l’heure de fin, « Avancés » replié) et l’instrument (barre, ligne d’état, courbe de perte, essais
  vidéo ou image avec la bande des tuiles, points de contrôle et « Mettre dans Mes LoRA », cadence, mémoire GPU et
  RAM, ÉVÈNEMENTS filtrables, journal de l’outil, « Pause », « Arrêter… », « Reprendre », « Laisser passer »,
  « Essayer sur une planche » à la fin). Tes images et tes légendes d’origine ne sont jamais modifiées.
- Puce de la barre de titre : « ENTRAÎNER » au repos, puis « LORA · ROSA 49 % », « GPU OCCUPÉ », « ESSAI », « EN
  PAUSE », « FINI » ou « ERREUR » (ces deux-là jusqu’à ce que tu aies ouvert l’entraînement), « 1 PROPOSITION ».
- Erreurs d’un entraînement en clair, chacune avec son explication : mémoire GPU pleine, mémoire Windows
  insuffisante, disque plein, fichier de poids introuvable, reprise refusée, outil muet, outil arrêté ; reprise
  proposée depuis le dernier point de contrôle.
- File des calculs : rangée « Entraînement LoRA · Rosa » en tête (pourcentage, heure de fin, croix qui demande avant
  d’arrêter) ; l’heure de fin de la file est comptée après l’entraînement.
- Bibliothèque → Mes LoRA : bouton « Entraîner un LoRA », mention « ENTRAÎNÉ ICI · 300 PAS », ligne « Entraînement »
  dans le détail, « Voir l’entraînement », « Retirer de Mes LoRA » (question d’abord, fichier et fiche à la
  corbeille), étapes intermédiaires repliées sous leur LoRA final (« Rosa · étape 100 »).
- Réglages → Entraînement : dossier des entraînements et dossier des outils (champ, « Parcourir… », dépôt d’un
  dossier, « Par défaut »), état de chaque outil, place libre ; un dossier dans le moteur, les projets ou un dossier
  de LoRA est refusé ; rien ne change pendant un entraînement.
- Fermer Mia pendant un entraînement : boîte « Rester » / « Arrêter et quitter », « ÉCRITURE DU POINT DE CONTRÔLE… »
  puis « Quitter sans attendre ». Sans réponse au bout de 4 minutes, Mia reste ouverte.
- Barre des tâches de Windows : progression de l’entraînement sur l’icône, clignotement à la fin si Mia n’est pas
  devant ; pas de mise en veille pendant un entraînement.
- Assistants : outils `mia_train_options`, `mia_train_prepare`, `mia_train_start` (en « Je valide », il ne fait que
  proposer : carte « Claude propose un entraînement » avec « Voir », « Refuser », « Plus tard », « Lancer » ; en
  « Claude agit seul », il lance directement), `mia_train_status`,
  `mia_train_wait`, `mia_train_control` (pause, ranger un point), `mia_train_note` ; `training:true` sur
  `mia_request` ; `mia_status.training`, `mia_pending.training`.
- Versions de LTX 2.5, nommées par ce qu’elles sont : « Compacte » (poids compressés, réglée pour 24 Go de
  mémoire), « Compacte · RTX 50 », « Pleine » (poids non compressés : même image que la compacte d’après nos essais,
  plus de mémoire, un peu plus lente ; elle sert surtout à entraîner un LoRA) et « Complète (non distillée) », grisée
  avec sa raison « Recette non validée ». Étiquette de version et mémoire estimée sur la carte du modèle d’un bloc,
  dans la liste de choix, dans le bloc Modèle, dans la bibliothèque et dans « + Bloc ». L’estimation est mesurée sur
  un plan type (960 × 544, 121 images), pas une garantie : elle monte avec la définition et la durée. « Trop lourd »
  prévient quand une version dépasse la machine. Avec la version pleine, Mia prend l’encodeur de texte plein s’il est
  installé, sinon le compact, et le dit.
- Bibliothèque, fiche d’un modèle : lignes « Version », « Mémoire » (avec l’origine du chiffre : mesuré, repris de
  la mesure d’une version voisine, ou d’après la taille du fichier) et « Encodeur de texte ».
- Assistants : `mia_catalog` donne pour chaque modèle sa version et sa mémoire estimée (`version`, `memoryGB`), la
  mémoire de la machine (`machine.memoryGB`) et les modèles reconnus mais non proposés (`notOffered`).
- Réglage interne `formerEngineRoots` : les anciens dossiers du moteur, tenus à jour tout seuls quand le dossier
  change.
- Réglages → Entraînement : « Générer pendant un entraînement » (activé par défaut). Une génération sur ce PC part à
  côté d’un entraînement qui fait ses pas quand la mémoire utilisée (lue à l’instant, jamais moins que le pic connu de
  l’entraînement), plus le pic **mesuré** de son modèle, plus une marge de 16 Go (la même que partout ailleurs dans
  Mia), reste sous le total de la machine ; une à la fois. Pics mesurés le 19/11 sur la RTX Spark à côté d’un
  entraînement LTX : FLUX.2 Klein 9B ≈ 29 Go en 1K, Qwen-Image 2.1 ≈ 23 Go jusqu’en 2K (la bibliothèque et le bloc
  Modèle les montrent aussi sur cette machine : « Mesuré pour une image en 1344 × 768 »). Elle attend pendant la
  préparation et les essais de l’entraînement, ses trois premiers pas après chacun d’eux, et quand Mia n’a pas mesuré
  la mémoire de son modèle (un chiffre « réglé pour 24 Go » ne compte pas). Une vidéo attend toujours la fin. Le
  calcul suivant de la file dit qu’il attend le calcul à côté. À la fin de chaque calcul, même modèle compris, ComfyUI
  rend sa mémoire pour l’essai suivant de l’entraînement. Ligne « Calcul à côté : {bloc} » dans ÉVÈNEMENTS ; « À côté
  de l’entraînement « Plumo » » sur le bloc et dans la file ; la raison d’une attente, chiffres compris, au même
  endroit. Assistants : `mia_run` fait pareil ; `mia_jobs` et `mia_wait` donnent `besideTraining` et
  `waitsForTraining`.
- Mia pour les PC Windows ARM64 (comme la RTX Spark) : un installateur et une version portable arm64
  (`Mia-0.10.0-arm64-installation.exe`, `Mia-0.10.0-arm64-portable.zip`), en plus de ceux pour les PC classiques
  (x64), qui gardent leurs noms. Sur ARM64, l’assistant « Installer le moteur de Mia » n’est pas prévu (il installe
  un Python et un PyTorch x64) : le moteur s’y installe à la main, puis « J’ai déjà un moteur ».
- Les outils d’entraînement ne sont pas installés par Mia : ltx-trainer 1.6.2 de Lightricks pour LTX 2.5,
  ai-toolkit pour Qwen-Image 2.1, dans le dossier « entrainement » à côté du moteur (voir `docs/INSTALL.md`).
  L’entraînement de LTX 2.5 n’a été essayé que sur la RTX Spark : il y prend ≈ 46 Go de mémoire au plus fort, et
  les durées estimées viennent de cette machine.

### Changé
- « Pause » (barre de titre) se montre aussi en « Claude agit seul » dès qu’un assistant travaille : c’est le seul
  frein quand tu n’es pas là.
- La file des calculs écrit la raison d’une attente derrière un entraînement **d’abord, en court et en entier**, sur
  deux lignes au plus : « Une vidéo ne part pas à côté : après l’entraînement, vers 15 h 10 », « Manque de mémoire :
  il faut ≈ 23 Go, 34 libres moins 16 de marge », « Après le calcul en cours à côté »… La phrase complète reste au
  survol et sur le bloc.
- Un calcul local lancé pendant un entraînement, quand il ne peut pas partir à côté (voir « Générer pendant un
  entraînement »), attend, avec la raison : « En file : entraînement « Rosa » en cours (fin vers 3 h 40) ». Un calcul
  sans GPU passe quand même, y compris pendant un calcul à côté, sauf pendant le chargement du modèle de
  l’entraînement. Les calculs légers du PC (extraire une image, redimensionner…) attendent toujours.
- Un LoRA rangé dans `models\loras\mia` avec une fiche `.mia.json` d’entraînement : son nom, son genre et son modèle
  viennent de la fiche, sa licence dit « Entraîné par toi. », et une étape intermédiaire se lit « · étape N »
  quelle que soit son origine. L’inventaire des modèles est refait une fois au démarrage (`CATALOG_REV` 6).
- « Auto » ne change pas : il garde la version compacte de LTX 2.5. Le mécanisme qui lui ferait prendre une version
  pleine quand la machine a la place existe (`autoOver` / `autoCaps` au catalogue, `autoByMemory` au scan), mais le
  service ne le demande pas (`AUTO_BY_MEMORY = false`, `electron/scanner.js`) : essai du 18/11/2026 sur RTX Spark,
  la pleine et la compacte int8 donnent la même image (écart moyen 3,1 à 3,6 sur 255, autant que deux décodages du
  même calcul) pour 13 s et 32 Go de plus. S’il est rallumé un jour, un résultat fait en Auto avec l’ancien défaut
  reste « à jour » (`legacyDefault`).
- Vocabulaire : « mémoire » (plus « mémoire vidéo ») ; précisions nommées « Pleine », « Compacte », « Compacte ·
  RTX 50 », « Très compacte ».
- La liste de choix d’un modèle montre sa mémoire estimée à droite ; le poids du fichier passe dans l’infobulle.
- La pastille de mémoire affiche le total que ComfyUI annonce (Mia le retient quand ComfyUI est éteint), avec une
  décimale, au lieu d’un total arrondi qui changeait selon que ComfyUI tournait ou non.
- Un fichier d’une autre précision que celle attendue (par exemple un MiniMax non compressé) le dit dans son nom et
  n’affiche plus la mémoire du fichier attendu.

### Corrigé
- Pendant un entraînement de LoRA, la fenêtre de la puce GPU disait « GPU libre » alors que l’entraînement tenait
  46 Go ; elle dit maintenant « L’entraînement « Plumo » tient le GPU (fin vers 15 h 10) », et nomme le calcul qui
  tourne à côté (« · à côté : « Portrait » »).
- La file coupait la raison d’une attente avant sa partie utile (« Attend la fin de l’entraînement « Plumo » (… »).
- Pendant un entraînement de LoRA, la mémoire GPU affichée (puce, fenêtre de la puce, écran d’entraînement,
  `mia_status`, `mia_train_status`) ne comptait que ce que ComfyUI voyait : sur une machine à mémoire unifiée
  comme la RTX Spark, l’entraînement (46 Go) n’y apparaissait pas. Mia prend maintenant le plus grand de ComfyUI et
  du pilote NVIDIA (nvidia-smi), relu toutes les 3 s pendant un entraînement ou un calcul.
- Les calculs en attente derrière un entraînement gardaient le message de leur mise en file : le 2ᵉ calcul lourd
  et les vidéos disaient « En file : entraînement … en cours » pendant qu’une image tournait à côté, et seule la
  première vidéo de la file disait qu’une vidéo ne part pas à côté. Chacun lit maintenant sa raison, recalculée à
  chaque changement, sans clignoter ; l’ordre de la file et les départs ne changent pas.
- Une image placée derrière une vidéo (ou derrière un modèle dont Mia n’a pas mesuré la mémoire) disait
  « Attend son tour à côté de l’entraînement … », alors qu’elle ne partira qu’à la fin de l’entraînement. Elle dit
  maintenant « Attend la fin de l’entraînement « Plumo » (vers 15 h 10), puis « LTX 2.5 », placé avant lui dans la
  file ». Avec « 4 variantes », les suivantes disent « un autre « Qwen 2.1 » passe avant » au lieu de nommer leur
  propre bloc.
- Une image placée derrière **trois** vidéos disait dans la file « Après l’entraînement (vers 6 h 07), puis « Plumo
  marche dans le village » », comme si elle partait juste après la première. Les calculs placés avant elle sont
  maintenant comptés : « Après l’entraînement (vers 6 h 07), puis 3 calculs placés avant » (la phrase entière, sur le
  bloc, nomme le premier : « … dont « Plumo marche dans le village » »). De même, à côté de l’entraînement : « Son tour
  à côté : 3 calculs passent avant ».
- Deux clics rapides sur un réglage (par exemple « Claude agit seul » puis « Je valide ») pouvaient remettre un
  instant le premier choix, le temps que Mia l’enregistre : en « Je valide », des actions d’assistants passaient alors
  sans ton feu vert. Le dernier choix tient, sans retour en arrière.
- Une action d’assistant retenue par « Pause » en « Claude agit seul » partait sans feu vert si tu repassais en « Je
  valide » avant « Reprendre ». Elle demande maintenant ton feu vert, comme les suivantes.
- La jauge relisait le pilote NVIDIA une fois sur deux pendant un entraînement (toutes les 6 s au lieu de 3) ; elle
  gardait jusqu’à 10 s une mémoire que ComfyUI venait de libérer ; sur un PC à deux cartes NVIDIA, elle pouvait lire
  l’autre carte. Corrigé.
- Le modèle complet de LTX (non distillé) n’est plus proposé comme une simple « autre précision », lancé avec une
  recette qui n’est pas la sienne. Un bloc qui le garde dit pourquoi il ne part pas, au lieu de basculer en silence
  sur une autre version. Cela vaut aussi pour un modèle complet de LTX 2.5 en poids compressés (int8) : s’il est le
  seul LTX installé, la vidéo LTX et « LTX · détails » ne sont plus proposés tant que la version distillée manque.
  Les modèles « dev » des générations précédentes (LTX 2.0, 2.3) ne sont pas concernés : ils restent proposés
  comme avant.
- Plus de fenêtre de console noire au démarrage de ComfyUI ni à chaque tâche Python quand le moteur est installé
  dans un environnement virtuel (venv).
- Avec deux encodeurs de texte installés, celui que Mia retenait dépendait de l’ordre des fichiers sur le disque.
  Le choix est maintenant toujours le même.
- Après un déménagement du dossier du moteur, les blocs ne signalent plus « LoRA introuvable » ou « à relancer »
  pour des modèles qui sont toujours là.

### Pour les développeurs
- Feu vert (SPEC §13.7) : `greenlight.js` `mountMode` / `paintMode` / `pick` (îlot `#gl-mode`, `greenlight.css`
  `.gl-mode`), `mode()`, `follow()` (suit le réglage d’où qu’il change : accepte la demande en cours en « agit seul »,
  reprend `grant` au retour à « Je valide »), `launched()` (une ligne « À générer » lancée par un `mia_run` en « agit
  seul »), `snapshot()` → `mode`, `granted` vrai en « agit seul ». `presence.js` : « Pause » visible dès qu’un
  assistant travaille, `mia_request` et `mia_pending` disent `mode` (+ `note` en « agit seul »), `mia_run` appelle
  `GL.launched`. `settings.js` : phrase du réglage. `bridge.js` : note `trainStarted`. Consignes MCP
  (`mcp/mia-mcp.js`) : les deux modes. `tools/test-bridge.js` : `testModeSwitch` (interrupteur, Réglages, cas a à d,
  calcul lourd et calcul en ligne payant partis aussitôt, `mia_jobs` sans `waitShort`), rouge sur le code d’avant.
- File et puce (SPEC §8.6, §8.7) : le moteur donne `job.waitShort` (clés `…Q` de `STR`, `besideWhy(…, true)`,
  `besideWaitMessage(v, true)`, `besideVideoMessage(v, true)`, `trainingMessage(true)`, `setWaitingMessage(job, msg,
  short)`) dans `pub()` et `engine:event` (pas dans `mia_jobs`) ; `runs.js` le garde ; `queuetrain.js` `waitLine` et
  `gpuHolder` ; `queue.js` `holderText(status)` d’après `status.training`, `.q-sub.is-why` (`queue.css`, deux lignes).
  `tools/test-engine.js` (+9) et `tools/test-train-queue.mjs` (+15), rouges sur le code d’avant.
- Relecture du 19/11 au soir : `presence.js` `gated()` relit `GL.allowed()` après une « Pause » (une action retenue
  ne passe plus sans feu vert si le mode a changé pendant la pause) ; `settings.js` `setPrefs()` numérote les écritures
  par clé (`prefSeq`, `prefLast`) : la réponse d’une écriture plus ancienne ne remet pas une clé réécrite depuis, et un
  échec ne remet que les clés qui n’ont pas été réécrites ; `greenlight.js` `.tight` : `gl.mode.askTight` (« Claude
  demande » / “Claude asks”), `.gl-mode-sw` (`greenlight.css`), `place()` mesure avec les mots longs puis resserre ;
  moteur : `besideAfterN`/`besideAfterEndN`/`besideBehindN` (+ clés `…Q`), `ctx.afterN` et `ctx.headN` comptés dans
  `pump()`. Tests : `test-bridge.js` (pause puis « Je valide » puis « Reprendre », deux clics rapides et appels
  d’assistants pendant ce temps, fenêtre étroite), `test-engine.js` (+1 contrôle, 5 revus), rouges sur le code d’avant.
- Moteur (`electron/engine/index.js`) : `tick()` prend le plus grand de ComfyUI et de nvidia-smi (`smiUsedNow()`,
  `SMI_FRESH_MS` 20 s ; `smiEveryMs()` : 3 s pendant un entraînement ou un calcul local, 10 s sinon ou sans pilote) ;
  `smi()` ne met plus NaN dans le statut sur un « [N/A] » et accepte `opts.smiQuery` (bancs). `pump()` :
  `besideRunning` mis à jour dans le passage, raison de chaque calcul lourd en attente par `besideWhy()`, nouveaux
  textes `besideStart`, `besideSettle`, `besideSample`, `besideMeasuring`, `besideBehind` (fr/en). SPEC §8.6, §8.7.
  `tools/test-engine.js` : cas réels du 19/11 (jauge à 46,5 au lieu de 2,9, cadence de nvidia-smi, « [N/A] », PC
  classique ; préparation, calcul à côté, 2ᵉ et 3ᵉ vidéos, image derrière une vidéo, essai, réglage coupé,
  stabilité), rouges sur le code d’avant.
- Relecture du 19/11 (`electron/engine/index.js`) : `smiDue()` (lecture due 1 s avant son heure, `SMI_SLACK_MS` ;
  relue aussitôt quand la lecture de ComfyUI bouge d’1 Go, `SMI_MOVE_GB`) ; `smiEveryMs()` garde 3 s pendant 15 s
  après un entraînement ou un calcul (`SMI_TAIL_MS`, `_smiFastUntil`) ; `smi()` lit toutes les lignes de nvidia-smi
  (`_smiRead.gpus`, sans les lignes sans total comme le NPU) et `smiUsedNow(nom)` ne prend que la carte de ComfyUI ;
  `pump()` passe `never` à `besideWhy()` (`besideNever()` : vidéo, pas d’estimation mesurée), nouveaux textes
  `besideAfter`, `besideAfterEnd`, `besideOther`, `besideFirst` (fr/en), `besideBehind` prend le nom déjà entre
  guillemets (`besideFirstOf()`). `tools/test-engine.js` : 17 contrôles rouges sur le code d’avant (cadence réelle
  sur 10 tours, traîne, modèle libéré, deux cartes, NPU ; vidéos en tête, tête sans estimation, « 4 variantes »,
  image, vidéo, image).
- Catalogue (`electron/scanner-rules.js`, `CATALOG_REV` 5, puis 6 avec l’entraînement) : entrées `ltx-dev` (bloquée) et
  `ltx-full`, tables `VERSIONS`, `MEM_AT`, `MEM_MARGIN_GB` ; critères `quantClass` et `notName` dans `matchWhen`.
  Inventaire : champs `aliases`, `version`, `mem`, `blocked`, `partNote`, `pairTag`, `offCatalog`, `machine.memGB`,
  `capabilities[c].auto` et `legacyDefault` (SPEC §7.1 à §7.5).
- Une seule résolution de référence de modèle : `findModel(inventory, ref)` dans `src/js/nodes/route.js` (id, alias,
  id de registre, chemin), lue par le scanner, le moteur, le pont et l’interface.
- Empreintes (SPEC §8.2.2) : `+te:full` quand l’encodeur retenu est plein ; `spec().hashAlts` reconnaît les versions
  faites sous un ancien dossier du moteur ou avec l’ancien défaut d’Auto. Refus `modelBlocked` à la planification.
- Executors LTX (`i2v`, `t2v`, `real`, `guided`) : `clip_name` posé par `patch.js` `ltxParts` ; graphes identiques à
  ceux d’avant avec une version compacte. Aucun gabarit modifié.
- Mémoire : total unique retenu dans `data/machine.json` (`mergeMachine`), `gpu.totalSource` dans `engine:status`,
  règle de place partagée `src/js/nodes/memory.js`. Préférences au format 2 (`formerEngineRoots`).
- Nouveau banc `node tools/test-variants.js` (sans disque réel, sans GPU, sans ComfyUI) et références dans
  `tools/fixtures/variants/`.
- `ltx-dev` ne prend que les fichiers dont le nom dit « ltx-2.5 » et « dev ». Dans le tri de préférence, `ltx-full`
  a le rang de `ltx-other` (`PREFER_AS`) : seul le choix « Auto » selon la mémoire peut la mettre par défaut. La
  version pleine affiche toujours sa mémoire mesurée (≈ 71 Go) dès que le total de la machine est connu.
- `electron/engine/pyexe.js` `pythonFor(py)` : pour un venv, ComfyUI et les tâches Python sont lancés avec
  l’interpréteur réel (`home` de `pyvenv.cfg`) et la variable `__PYVENV_LAUNCHER__`, au lieu du lanceur
  `Scripts\python.exe` ; sans `pyvenv.cfg` (python_embeded), rien ne change.
- Entraînement de LoRA (SPEC §12.6, §8.7, §13.8) : service `electron/trainer.js` (canaux `train:*`, évènement
  `train:event`, `brief()`, `stopForQuit()`, `killSync()`), descripteurs d’outil
  `electron/train/{common,ltx,aitk,fake}.js`, adaptateurs `python/train/mia_train_{common,ltx,aitk}.py` (`--dry` écrit
  et valide la configuration sans GPU), catalogue `src/catalog/train-bases.json`, `electron/trainshell.js` (barre des
  tâches, clignotement, `powerSaveBlocker`, `release()` à la fermeture). Le dossier de l’entraînement est la source de
  vérité : `train.json` (Mia seule, chemins relatifs), `events.jsonl` et `metrics.jsonl` (l’adaptateur seul),
  `control\`, `log.txt` passé à l’outil par descripteur de fichier, jamais un tuyau.
- Moteur : porte `holdGpu()` / `adoptGpu()` (attend tous les calculs locaux, verrou écrit pour min(reste, 30) min et
  réécrit toutes les 5 min), `pump()` qui retient lourds et légers (les `gpu:'none'` passent, sauf en phase `load`),
  messages `waitTraining*`, `engine:status.training`, `shutdown()` → `trainer.killSync()`.
- Calcul à côté d’un entraînement (SPEC §8.7) : préférence `trainGenBeside` (`store.js`, absente = `true`) ; moteur
  `besideCheck` / `besideNeedGB` (seulement `mem.basis` `measured` ou `derived`, et jusqu’à la taille de la mesure
  `mem.at`) / `besideIsVideo` / `besideTotalGB` / `besideMeasure` (nvidia-smi lu à l’instant, `smi()` rend sa lecture ;
  `engineOpts.gpuUsedGB`, `besideFreshMs`, `besideRetryMs`, `besideSettleSteps`, `besideSettleMs` pour les bancs ;
  relecture à 1 ×, 3 ×, 12 × `BESIDE_RETRY_MS` tant qu’elle ne bouge pas) / `besideWaitMessage` (`besideWait`,
  `besideWaitEnd`, `besideRun`, `besideBusy`, `besideVideo*`) / `besideTakeOver` (verrou repris sous le nom du calcul
  quand l’entraînement rend le GPU) / `besideFree` (`POST /free` après chaque calcul à côté) ; `BESIDE_MARGIN_GB = 16`,
  `BESIDE_SETTLE_STEPS = 3`, `BESIDE_SETTLE_MS = 10000` dans `_internals` ; `trainer.brief().peakVramGB` ; catalogue :
  `mem: { peakGB, basis, at: { w, h } }` pour `flux2-klein9b` (29) et `qwen-image21` (23), `memOf` rend ce `at` (sinon
  `MEM_AT`), phrases `memoryAt.measuredImage` / `memTip.measuredImage` ; champs `beside` et `trainWait` des jobs et de
  `engine:event` ; `trainer.noteBeside(label)` (`act: 'beside'`) ; `runs.trainWaitText` / `runs.besideText` ; pont :
  `besideTraining`, `waitsForTraining`. Bancs étendus : `test-engine.js`, `test-migrations.js`,
  `test-train-settings.js`, `test-train-ui.mjs`, `test-bridge.js`.
- `main.js` : module `trainer` chargé entre `engine` et `bridge` ; `app:flush` porte `training` ; `finishClose`
  appelle `trainer.stopForQuit()` sur tous les chemins (7 min au plus), puis `trainShell.release()` ;
  `flushed({now:true})` = quitter sans attendre ; après le délai de 5 min, un entraînement actif garde Mia ouverte.
- Préférences `trainRoot`, `trainRoots[]`, `trainTools` (`places.trainingRoot` / `trainingRoots` / `trainingTools`,
  `store.js` `checkTrainRoot`, `setTrainBusyCheck`) ; `allowedRoots()` sert les dossiers d’entraînement par `mia://m/`.
  Instance de test (`MIA_USERDATA` ou `MIA_TRAIN_FAKE=1`) : `<userData>\training` et `<userData>\loras-mia`.
- Interface : vue `#view-train` (`app.js` `goTrain`, `leaveTrain`, `tryLora`, `openTrain`), modules
  `src/js/ui/train.js`, `traintext.js` (mots fr/en et règles d’affichage, purs), `trainchart.js`, `trainclose.js`,
  `queuetrain.js`, styles `src/css/train.css` et `library-train.css` ; `settings.js` section `train` ;
  `greenlight.js` `proposeTraining`.
- Scanner : `sidecarTraining`, `trainedHere`, `miaLoraDirs` (racine « Entraînés dans Mia » d’une Mia de test),
  `removeLora` pour `trainedHere`, `TRAIN_BASES` / `trainBaseKey` (`scanner-rules.js`), `CATALOG_REV` 6.
- Pont : `train_options`, `train_status`, `train_wait`, `train_start` côté principal, `train_prepare` relayé avec
  son propre délai (140 s), `train_control` et `train_note` relayés ; `NEEDS_GO` de `presence.js` ; 33 outils MCP.
- Faux outil `tools/fixtures/train/fake-trainer.js` (base `fake`, seulement avec `MIA_TRAIN_FAKE=1`). Nouveaux bancs :
  `tools/test-trainer.js`, `test-train-config.js`, `test-train-ui.mjs`, `test-train-queue.mjs`,
  `test-train-settings.js` ; sur une Mia de test cachée : `check-train-screen.mjs`, `test-train-close.mjs`,
  `check-train-queue.mjs`, `check-library-train.mjs`, `test-train-settings-ui.mjs`. Étendus : `test-engine.js`,
  `test-scanner.js`, `test-bridge.js`.
- Paquet : `npm run dist`, `dist:zip` et `dist:dir` passent par `tools/dist.js`, qui lance electron-builder une fois
  par architecture (x64 puis arm64 ; `npm run dist -- arm64` pour une seule). Les fichiers x64 gardent leurs noms,
  ceux d’arm64 disent `arm64` (`nsis.artifactName` et `win.artifactName` changés pour cette passe seulement).
  `build.electronDist` est retiré : `node_modules/electron/dist` est l’Electron du PC qui a fait `npm install` (arm64
  sur un PC ARM), et un paquet x64 l’aurait embarqué ; electron-builder prend maintenant l’Electron officiel de
  chaque architecture (vérifié par SHASUMS256, gardé dans `%LOCALAPPDATA%\electron\Cache`). L’afterPack de
  `tools/check-package.js` refuse un `.exe` dont l’en-tête PE n’est pas de l’architecture fabriquée (`peArch()`).

## 0.9.0 — 17/11/2026

### En bref
- **Ton feu vert avant que l’assistant agisse** : quand tu demandes quelque chose à Claude ou à Codex, une petite
  carte apparaît en bas de Mia, « Claude attend ton feu vert », avec ce qu’il veut faire. Rien ne bouge avant
  « C’est parti ». « Détail » montre les étapes, « Plus tard » range la carte, « Refuser » dit non.
- **« À générer »** : l’assistant ne lance plus de calcul lourd ou payant, il le propose. Un panneau à droite de la
  planche liste ce qu’il veut générer, rangé par plan : tu coches ce que tu veux (une case par plan, une par
  calcul), tu lis le temps prévu et le prix, puis « Générer la sélection ». Les calculs en ligne arrivent décochés.
- **Plusieurs Claude à la fois** : quand tu demandes plusieurs plans d’un coup, chaque plan a son curseur de
  couleur (« Claude 1 », « Claude · Taxi »…), sa bulle et sa rangée sur la planche ; ils travaillent en même temps.
  La barre de titre affiche « 3 Claude pilotent Mia » et une pastille par Claude : un clic et ta caméra le suit, un
  second clic et tu revois tout le monde.
- **« Pause »** dans la barre de titre pendant qu’ils travaillent : ils s’arrêtent là où ils en sont, « Reprendre »
  les relance. Rien n’est annulé.
- **L’assistant sait ce qui est ouvert** : les planches ouvertes en onglets, celle à l’écran, ta sélection et les
  blocs visibles. « Ce bloc » veut enfin dire celui que tu regardes.
- **Tu gardes la main** : Réglages → Assistants → « Demander mon feu vert » coupe tout cela et revient à l’ancien
  comportement (l’assistant agit et calcule tout de suite).

### In short
- **Your go-ahead before an assistant acts**: when you ask Claude or Codex for something, a small card appears at
  the bottom of Mia, “Claude is waiting for your go-ahead”, with what it is about to do. Nothing moves before
  “Go ahead”. “Details” shows the steps, “Later” puts the card aside, “Decline” says no.
- **“To generate”**: an assistant no longer starts a heavy or paid computation, it proposes it. A panel on the right
  of the board lists what it wants to generate, grouped by shot: tick what you want (one box per shot, one per
  computation), read the expected time and the price, then “Generate the selection”. Online jobs arrive unticked.
- **Several Claudes at once**: ask for several shots in one go and each shot gets its own coloured cursor
  (“Claude 1”, “Claude · Taxi”…), its bubble and its row on the board; they work at the same time. The title bar
  shows “3 Claude are driving Mia” and a chip per Claude: click one and your camera follows it, click again to see
  everyone.
- **“Pause”** in the title bar while they work: they stop where they are, “Resume” lets them go on. Nothing is undone.
- **The assistant knows what is open**: the boards open in tabs, the one on screen, your selection and the blocks
  in view.
- **You stay in charge**: Settings → Assistants → “Ask for my go-ahead” turns all this off and brings back the
  former behaviour (the assistant acts and computes at once).

### Ajouté
- Carte « Claude attend ton feu vert » (Détail, Plus tard, C’est parti, Refuser) et sa pastille de rappel.
- Panneau « À générer » : groupes par plan (chaîne de blocs reliés), case par plan, total du temps sur ce PC et du
  montant en ligne, « calculé pour la suite » sur une ligne décochée dont un calcul coché a besoin, « Tout retirer ».
- Curseurs de couleur des assistants, une rangée par assistant, pastilles « qui la caméra suit », « Pause ».
- Réglage « Demander mon feu vert » (Réglages → Assistants), activé par défaut.
- Outils MCP `mia_request` et `mia_pending` ; paramètre `as` sur les outils qui agissent sur la planche.

### Changé
- Avec le feu vert activé, un outil d’assistant qui modifie Mia répond d’abord de demander le feu vert, et
  `mia_run` d’un calcul lourd ou en ligne le propose au lieu de le lancer. Les petits calculs du PC (extraire une
  image, couper, redimensionner) partent toujours tout de suite.
- `mia_status`, `mia_list_projects` et `mia_get_board` disent ce qui est ouvert (onglets, planche à l’écran,
  sélection, blocs visibles).
- Guide `mia-piloter` : le feu vert d’abord, puis le travail à plusieurs (un sous-agent par plan).

### Pour les développeurs
- Pont des assistants : paramètre `as` (SPEC §13.5), un acteur par `as` dans `presence.js` (file, curseur,
  placement), changements de planche exécutés seuls ; `mia.tabs`, `open` / `active`, `inView` (SPEC §13.6).
- Feu vert (SPEC §13.7) : `mia_request`, `mia_pending`, `src/js/ui/greenlight.js`, `src/css/greenlight.css`,
  `prefs.assistantAsk`. Le serveur MCP passe de 24 à 26 outils.
- `tools/test-bridge.js` : plusieurs assistants à la fois, ce qui est ouvert, feu vert, pause, « À générer »
  (`MIA_CDP_PORT` pour changer le port de contrôle de la Mia de test).

## 0.8.0 — 31/10/2026

### En bref
- **Tous les modèles en ligne, en entier** : Mia relève maintenant le catalogue de Higgsfield sur sa console (pas
  seulement sa documentation, en retard). Arrivent **Kling 4.0** (texte, animer avec images-clés et image de fin,
  références, montage d’une vidéo existante, jusqu’à 30 s en 1080p), **Genjutsu Light** et **SOUL V2 image vers
  image**. Chaque champ d’un modèle devient un réglage ; ce qui n’est pas encore pris en charge est listé avec sa
  raison.
- **Le mode d’un bloc en ligne se voit et se choisit** : « Auto · Texte · Animer · Références · Modifier ». Seules
  les entrées utiles au mode s’affichent ; « + Ajouter » range à part celles d’un autre mode et y bascule. Jetons de
  citation propres au modèle (`@image_1`, `@video_1`).
- **Le payant toujours clair** : « EN LIGNE · PAYANT » et « Relier mon compte » sans compte, un tarif public
  « ≈ … $ » quand Higgsfield ne donne pas de prix, et un calcul déjà payé n’est plus jamais jeté : « Attendre le
  résultat ».
- **Plusieurs calculs en ligne à la fois** : ils partent en parallèle sans jamais attendre la carte graphique
  (Réglages → Comptes en ligne, « Calculs en ligne simultanés », 4 par défaut, jusqu’à 16). File Higgsfield pleine :
  Mia attend et réessaie seule, avec la même clé, sans double facture. Le local reste à un calcul lourd à la fois.
- **LTX en 1 ou 2 passes** : nouveau réglage « Passes » (Auto · 1 passe · 2 passes) sur Animer une image, Vidéo
  depuis un texte, Rendre photoréaliste et le bloc Modèle LTX. 2 passes : le mouvement se décide à mi-définition,
  le latent est agrandi ×2 puis affiné, et les images-clés et l’image de fin sont conseillées (0,6 / 0,7) au lieu
  d’imposées : plus de diaporama. Auto = 2 passes dès qu’une image de fin ou des images-clés sont branchées.
- **Planches à vidéos bien plus légères** : petites copies de lecture (960 px, mêmes images) pour les grandes vidéos,
  vignettes de 640 px pour les grandes images, vidéos hors champ libérées en 5 s ; le bloc Comparer ne sature plus le
  décodeur vidéo (98 % → 4 %) ; la mémoire graphique d’une grosse planche passe de ≈ 2,4 Go à moins de 1 Go.
- **Plus de limite d’onglets** : la barre défile (molette, flèches), l’onglet actif reste visible, et un bouton ▾
  liste toutes les planches ouvertes avec une recherche.
- **Plus vivante** : menus, listes, palette, inspecteur et file s’effacent en douceur, les petits boutons
  s’enfoncent sous le doigt ; rien ne bouge au repos (et moins encore si Windows demande moins d’animations).

### In short
- **Every online model, in full**: Mia now reads Higgsfield’s catalogue from its console. New: **Kling 4.0** (text,
  animate with keyframes and end image, references, editing an existing video, up to 30 s in 1080p), **Genjutsu
  Light** and **SOUL V2 image-to-image**. Every model field is a setting; what is not supported yet is listed with
  its reason.
- **An online block’s mode is visible and choosable**: only the inputs of that mode show; “+ Add” lists other modes
  apart. Per-model prompt tokens (`@image_1`, `@video_1`).
- **Paid, always clear**: “ONLINE · PAID” and “Link my account” without an account, a public “≈ … $” rate when
  Higgsfield gives no price, and a paid job is never thrown away: “Wait for the result”.
- **Several online jobs at once**: they run in parallel and never wait for the graphics card (4 by default, up to 16).
  A full Higgsfield queue is retried with the same key: never charged twice. Local jobs stay one heavy job at a time.
- **LTX in 1 or 2 passes**: new “Passes” setting (Auto · 1 pass · 2 passes). 2 passes: motion at half resolution,
  latent ×2 then refined, keyframes and end image advised (0.6 / 0.7) instead of forced. Auto = 2 passes with an end
  image or keyframes.
- **Much lighter video boards**: small playback copies, 640 px thumbnails, off-screen videos released after 5 s; the
  Compare block no longer saturates the video decoder (98 % → 4 %).
- **No tab limit**: the strip scrolls and a ▾ button lists every open board, with search.
- **More alive**: menus, lists, palette, inspector and queue fade out; small buttons give when pressed; nothing moves
  at rest.

### Ajouté
- Modèles en ligne : Kling 4.0, Genjutsu Light, SOUL V2 image vers image ; catalogue relevé sur la console et les
  schémas de Higgsfield (`tools/build-cloud-catalog.mjs`), chaque champ exposé ou listé « non pris en charge » avec
  sa raison ; « À choisir pour… » de Kling 4.0 et de Genjutsu Light.
- Bloc Modèle en ligne : rangée « Mode » ; « Passer en … » pour une entrée ignorée ; aides justes par modèle.
- Tarif public en repli (« ≈ ») sans compte relié ou quand Higgsfield ne donne pas de prix ; un prix sous 1 centime
  s’écrit « 0,003 $ ».
- Réglage « Passes » LTX ; Rendre photoréaliste en 2 passes (passe 2 guidée par le rendu 3D en pleine définition).
- Réglages → Comptes en ligne : « Calculs en ligne simultanés ».
- Liste des onglets ouverts (▾) avec recherche et « Fermer les autres onglets ».

### Changé
- Seuls les réglages du palier choisi partent (Kling 3.0 Turbo, LTX-2.5 Pro et Rapide) ; une valeur hors des options
  est ramenée à la plus proche et la version le dit ; graine bornée selon le modèle ; aperçu à la plus petite
  résolution ; Kling 4.0 à 10 s par défaut et, en montage, à la durée de la source ; la Qualité va de Turbo à 4K.
- La file nomme un bloc Modèle par sa famille ; en-têtes « FAIT · 10 MIN », « EN FILE · 1 », « À RELANCER » ;
  calculs en ligne à part (« En ligne », « En file chez Higgsfield »).
- Un bloc calculé avant le réglage « Passes » garde son empreinte : aucun recalcul par ricochet.
- Réglages → À propos : « Génération vidéo pensée par des créatifs, sur ton PC ou en ligne ».
- Les assistants (MCP) reçoivent les réglages, notes, prix et jetons de chaque mode, et la file en ligne à part.

### Corrigé
- Annuler un calcul déjà commencé chez Higgsfield, ou pendant un nouvel essai après une coupure, ne jette plus un
  résultat payé : Mia le retrouve (même clé) et le récupère.
- Une vidéo source trop courte (moins de 3 s pour Kling 4.0) est signalée avant le clic et refusée avant tout envoi.
- La consigne négative cachée du bloc Modèle n’est plus envoyée aux modèles en ligne.
- « Enrichir la consigne » arrive de nouveau au calcul depuis le bloc Modèle LTX.
- Un titre envoyé au pont depuis une console Windows (cp1252) n’affiche plus « � » ; le pont refuse un argument
  inconnu au lieu de deviner, et relier sans nommer l’entrée ne remplace plus un fil existant.
- Claude et Codex installés depuis le Microsoft Store retrouvent Mia (`%TEMP%\Mia\bridge.json`) ; une Mia lancée
  depuis une console fermée ne remplit plus son journal en boucle.
- Bibliothèque : « Déborde » devient « Trop lourd · plus lent » ; les capacités d’un modèle ne se coupent plus au
  milieu d’un mot ; ouverture plus légère des planches à nombreuses Consignes.

### Pour les développeurs
- `docs/ARCHITECTURE.md` présente le bloc Modèle et les modèles en ligne (catalogue généré, paliers `onlyTiers` /
  `tierOptions`, jetons `cite`, `durationFromSource`, prix publics, reprise sur 429 avec la même clé, annulation
  tardive), la voie en ligne de la file (`prefs.cloudParallel`, `engine.queue.online`) et les onglets sans limite.
  `mcp/README.md` explique la file en ligne (`mia_jobs` `online` / `remote`).
- Bancs : test-engine 247, test-cloud 91, test-route 76, validate-workflows 136 cas, tous verts sans GPU ni réseau
  payant.

## 0.7.0 — 29/10/2026

### En bref
- **Agrandir vite avec NVIDIA** : « Modèle › NVIDIA RTX · express » dans le bloc Agrandir (RTX Video Super Resolution,
  sur la carte RTX) : quelques secondes à quelques minutes pour 10 s, rien d’inventé, image et vidéo.
- **Agrandir avec LTX** : dans le bloc Agrandir, « Modèle › LTX · détails » agrandit une vidéo en 1440p ou en 4K
  en recréant le détail fin, fidèle au cadrage et au style (LTX-2.5 Native Resolution : une passe de composition,
  ×2 dans le calcul, puis un affinage par tuiles), en morceaux de quelques secondes fondus entre eux pour tenir en
  mémoire vive. Plus lent que SeedVR2 (≈ 25 à 35 min pour 10 s en 1440p).
- **Ton budget Higgsfield sur la planche** : avec un compte relié, le coin en bas à droite de chaque planche montre
  ce qui reste (« reste ≈ 42,30 $ ») ou, sans recharge indiquée, ce qui a été dépensé ce mois-ci. Higgsfield ne donne
  pas le solde à Mia : indique le montant de ta dernière recharge dans Réglages → Comptes en ligne, Mia en retire
  ce qui a été dépensé depuis (chiffres de Higgsfield, avec quelques minutes de retard).
- **Un seul bouton « Générer »** sur chaque bloc, à la place d’« Aperçu » et « Rendu final » (« Appliquer » sur les
  outils comme Couper ou Son, « Exporter » sur Exporter) : il calcule les réglages du bloc tels quels. Ce sont eux (définition, durée, étapes) qui décident du temps, affiché à côté du
  bouton (« ≈ 4 min ») et ajusté d’après tes propres calculs sur ce PC.
- **Le prix avant de lancer** : un bloc en ligne affiche aussi son prix à côté de « Générer ». « + Bloc » montre
  « dès … $ » pour chaque modèle en ligne. Les prix viennent de Higgsfield, pour ton compte ; quand il n’en donne
  pas, le bloc affiche « prix ? » et sa raison au survol.
- **Choisir un modèle, refait** : un grand panneau avec la recherche, des filtres par usage (Vidéo, Image, Texte,
  Animer, Références…), une colonne Tout · Favoris · Sur ce PC · En ligne, une ligne courte par modèle avec la
  couleur de son fabricant et son prix « dès … », l’étoile des favoris, les derniers choisis en tête, et la
  description complète du modèle survolé en bas.
- **« + Bloc » refait** : tes favoris (l’étoile au bout d’une ligne, ou Ctrl+D ; Alt+1 à 9 en pose un tout de
  suite) et les derniers blocs posés en tête ; un choix « Tout · Sur ce PC · En ligne » gardé d’une fois sur
  l’autre ; des titres qui disent ce qu’on regarde (modèles sur ce PC, modèles en ligne, tâches prêtes) ; une ligne
  courte par entrée, deux fois plus d’entrées à l’écran ; à droite, l’entrée parcourue en entier : sa phrase, quand
  choisir un modèle en ligne, ce qu’elle prend et ce qu’elle donne, les blocs d’une recette. Les modèles favoris
  sont les mêmes que dans le choix du modèle.
- **Mia plus rapide sur les grandes planches** : taper dans une consigne ne redessine plus tous les blocs (sur une
  planche de 110 blocs, chaque lettre passait de ≈ 0,6 s à quelques millisecondes) ; une planche s’ouvre deux fois
  plus vite ; annuler une saisie est immédiat.
- **Se déplacer sur une grande planche, plus fluide** : attraper la planche (clic du milieu, Espace ou clic
  droit glissé), tirer un fil ou élargir un bloc ne fige plus l’écran au début et à la fin du geste (≈ 0,1 s
  chaque fois sur une planche de 110 blocs) ; pendant le déplacement, plus aucune image ne traîne, à tous les
  zooms ; le zoom à la molette saccade moins. Survoler le bord ou le titre d’une section et appuyer
  sur Espace ne figent plus non plus.

### In short
- **Fast upscaling with NVIDIA**: “Model › NVIDIA RTX · express” in the Upscale block (RTX Video Super Resolution, on
  the RTX card): seconds to a few minutes for 10 s, nothing invented, images and videos.
- **Upscaling with LTX**: “Model › LTX · details” in the Upscale block takes a video to 1440p or 4K by recreating fine
  detail, true to framing and style (LTX-2.5 Native Resolution), in cross-faded chunks of a few seconds to fit in RAM.
  Slower than SeedVR2 (≈ 25 to 35 min for 10 s at 1440p).
- **Your Higgsfield budget on the board**: with a linked account, the bottom-right corner of every board shows what
  is left (“left ≈ $42.30”) or, without a top-up entered, what was spent this month. Higgsfield gives no balance to
  Mia: enter your last top-up in Settings → Online accounts, Mia takes off what was spent since (Higgsfield’s figures,
  a few minutes late).
- **A single “Generate” button** on every block, instead of “Preview” and “Final render” (“Apply” on tools such as
  Trim or Sound, “Export” on Export): it computes the block’s settings as they are. They (resolution, length, steps) decide the time, shown next to the button (“≈ 4 min”) and
  adjusted from your own jobs on this PC.
- **The price before running**: an online block also shows its price next to “Generate”. “+ Block” shows “from … $”
  for each online model. Prices come from Higgsfield, for your account.
- **Choosing a model, redone**: a large panel with search, filters by use (Video, Image, Text, Animate,
  References…), an All · Favourites · On this PC · Online column, one short row per model with its maker’s colour
  and its “from …” price, a star for favourites, recent picks first, and the full description of the hovered model.
- **“+ Block” redone**: your favourites (the star at the end of a row, or Ctrl+D; Alt+1 to 9 places one at once) and
  the last blocks you placed come first; an “All · On this PC · Online” choice kept from one time to the next;
  headings that say what you are looking at (models on this PC, online models, ready-made tasks); one short row per
  entry, twice as many on screen; on the right, the browsed entry in full: its sentence, when to pick an online
  model, what it takes and gives, a recipe’s blocks. Favourite models are the same as in the model picker.
- **Mia faster on big boards**: typing in a prompt no longer redraws every block (on a 110-block board, each letter
  went from ≈ 0.6 s to a few milliseconds); a board opens twice as fast; undoing typing is instant.
- **Moving around a big board, smoother**: grabbing the board (middle click, Space or right-drag), drawing a wire
  or widening a block no longer freezes the screen at the start and end of the gesture (≈ 0.1 s each time on a
  110-block board); while moving, no frame lags any more, at every zoom; wheel zooming stutters less.
  Hovering a section’s edge or title and pressing Space no longer freeze either.

### Corrigé
- « Agrandir · LTX détails » : sur un PC qui ne les a pas, la bibliothèque sait maintenant installer ses deux
  fichiers (le mode détails et l’agrandisseur ×2 de LTX, 2,3 Go) ; elle ne les connaissait pas.
- « + Bloc » : un onglet au libellé long (« Médias et consignes ») débordait sur le suivant ; il passe sur deux lignes.
- Lancer un bloc sans réglage de mode (Finition, Son…) calculait en aperçu un bloc de génération en amont jamais
  calculé : il calcule maintenant ses réglages tels quels.
- Les raisons données par Higgsfield quand il refuse un prix se perdaient quand plusieurs prix arrivaient en même
  temps (« + Bloc » en demande trois à la fois) : `cloud.json` est maintenant écrit une fois à la fois.
- Un bloc Kling 3.0 en ligne dont on n’avait pas touché la qualité affichait « Pro » mais partait en 4K (le premier
  niveau de la liste) ; LTX-2.5 en ligne, en « Rapide » au lieu de « Pro ». Une qualité jamais touchée est
  maintenant celle que montre le bloc.

### Pour les développeurs
- Budget Higgsfield : `electron/cloud.js` lit `GET /models/usage` (fenêtres de 30 jours, à la seconde ; gardé une
  minute), IPC `cloud:budget` et `cloud:setTopUp` (la recharge dans `cloud.json`, pas un secret) ;
  `src/js/ui/budget.js` dans la barre de zoom, rafraîchi après un calcul en ligne et toutes les dix minutes ;
  `tools/test-cloud.js` le vérifie contre un faux Higgsfield.
- Prix : `POST /estimate/<endpoint>` (gratuit, doc « Billing and retention ») avec la demande que ferait
  l’exécuteur en ligne, des adresses factices à la place des médias (`electron/engine/cloudprice.js`) ; IPC
  `cloud:price` (prix d’un bloc, gardé 10 min) et `cloud:fromPrices` (« dès » : 1re façon de faire, plus petite
  définition, durée la plus courte, le plus bas de ses niveaux ; gardé un jour dans `cloud.json`). Bloc en ligne :
  un seul bouton (mode `final`) ; `mia_run` le lance en `final` par défaut. `executors/cloud.js` : `endpointOf`
  prend le niveau par défaut du catalogue quand `hf.tier` n’est pas réglé.
- Un seul « Générer » : `pickMode` (moteur) prend `final` quand aucun mode n’est demandé ; `engine:estimate`
  (`engine.estimate`, preload `estimate`) donne la durée prévue d’un bloc sans rien mettre en file (estimation de
  l’exécuteur × rapport appris dans `timings.json`, une consigne vide ne compte pas) ; le pied des blocs la demande
  (deux questions à la fois au plus, seul l’amont du bloc part au moteur). `mia_run` part en `final` par défaut,
  `preview` reste possible.
- Choix du modèle : `src/js/nodes/familypicker.js` refait, favoris et récents dans `prefs.favModels` et
  `prefs.recentModels`, couleur du fabricant `makerColor()` (aussi sur les pastilles de « + Bloc ») ; prix « dès »
  partagés par `src/js/ui/fromprices.js`.
- « + Bloc » (`src/js/graph/palette.js`, `graph.css`) : panneau de 880 px en trois colonnes (catégories, liste,
  détail) ; favoris `prefs.favModels` (modèles, partagés avec le choix du modèle) et `prefs.favBlocks` (blocs,
  `recipe:<id>` pour une recette), récents `prefs.recentBlocks` (8 au plus ; un modèle posé compte aussi dans
  `prefs.recentModels`), filtre `prefs.palWhere` (`all` | `pc` | `online`) ; la recherche avance les favoris puis
  les récents et lit les points forts des modèles en ligne ; la bulle de la phrase coupée disparaît (le détail la
  montre). Alt+chiffre lu par `e.code` (claviers AZERTY).
- Performances : `graph:changed` porte `ids` pour un réglage changé et un retour en arrière (les blocs hors de
  l’aval ne se redessinent plus ; un retour qui n’a fait que déplacer s’annonce `move`) ; mesures de mise en page
  groupées par image (`util.measureLater`, `measureOnResize` : lectures puis écritures) pour les puits, le pied,
  les versions, les choix segmentés, les rangées de réglages et les consignes ; largeurs des choix segmentés
  mémorisées par libellés ; `route.js` mémorise `portsOfWorkflow`, `portsOfFamily` et `chooseWorkflow` ; glyphes
  mesurés au démarrage (`warmIcons`).
- Navigation dans la planche (mesuré sur une copie de « F1 300 km/h », 110 blocs, `_dev/claude-1028/perf`) :
  aucun curseur n’est plus posé sur `#stage` (le curseur s’hérite : le changer restylait les ~8 000 éléments des
  cartes) ; pendant un geste ou Espace, `#cursor-shield` couvre la scène et porte le curseur, `under()`
  (interact.js) cherche ce qui est dessous ; survol des sections sur le canevas `#grid`. `.nb-badge` et la
  pastille du lecteur cachés aussi par `visibility` au repos (à opacité nulle, ils faisaient 101 calques au lieu
  de 22). `#wires` a sa propre couche (`will-change`, rendue après un zoom comme `#world`). `--zl` déclaré
  `@property` non hérité, écrit sur `#nodes` ; `--wire-sw` des vues lointaines sur `#wires`. Le relevé des
  vidéos (`media.js` `poll`) ne mesure plus pendant un geste de caméra et lit avant d’écrire ; la remesure de
  secours des cartes (`view.js`) attend une image de plus après une image longue.

## 0.6.0 — 27/10/2026

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
- **Des images depuis un texte, sur ce PC** : deux nouveaux modèles dans le bloc Modèle (onglet Image) —
  **FLUX.2 Klein 9B** (une image en quelques secondes ; branche une image, il la retouche en gardant son cadrage) et
  **Qwen-Image 2.1 Turbo** (très fidèle aux textes écrits dans l’image, jusqu’à 2K). Tailles 1K, 1,5K, 2K. Licences
  non commerciales : proposés « à essayer », pour des essais et des projets perso. Une LoRA n’est proposée que sur le
  modèle pour lequel elle a été entraînée (Klein 9B ou Qwen-Image 2.1, jamais l’une sur l’autre, ni sur Qwen Image Edit).
- **Un cadrage pour Qwen-Image 2.1** : branche une image sur « Cadrage », le bloc garde sa composition (sa profondeur)
  et ta LoRA garde son style ; « Respect du cadrage » : Strict, Équilibré, Souple. Le format suit l’image de cadrage.
- **Les conseils d’une LoRA** : une fiche posée à côté du fichier (<nom>.mia.json) donne son mot déclencheur, sa force
  conseillée (posée quand tu la choisis) et une aide affichée sous « Force ».
- **Retoucher une zone** (Qwen-Image 2.1) : un nouveau bloc **Masque** où l’on peint la zone sur l’image (pinceau,
  gomme, taille, inverser, zoom à la molette) ; seule cette zone est recalculée, avec ta LoRA, puis recollée : le
  reste de l’image ne bouge pas d’un pixel. Une petite zone (des pieds, un œil) est agrandie toute seule pour être
  calculée en détail. Recette « Retoucher une zone ».
- **Réécrire ta consigne en anglais** : coche « Réécrire en anglais » sous une Consigne. Avant le calcul, un modèle de
  ce PC (le lecteur de consignes de Qwen) corrige les fautes, traduit et décrit dans l’ordre : sujet, décor, fond,
  lumière, puis ce qu’on ne veut pas. Le texte compris s’affiche sous la consigne ; il n’est refait que si tu la
  changes. « Réécrire maintenant » le montre avant de lancer quoi que ce soit.
- **4 variantes** : sur Qwen-Image 2.1, FLUX.2 Klein et Qwen Image Edit, un bouton lance 4 images avec 4 graines
  différentes, l’une après l’autre. Compare-les dans les versions du bloc ; l’étoile garde celle que tu choisis.
- **« + Bloc » rangé par ce que tu fabriques** : à gauche, Fabriquer (Vidéo, Image, Son), Préparer (Médias et
  consignes, Recettes, Notes), Retravailler (Montage, Finition). Dans Vidéo et Image : les modèles « Sur ce PC », ceux
  « En ligne », puis les blocs. Les modèles en ligne ne sont plus à part : chacun dans l’onglet de ce qu’il fait.
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
- **Images from text, on this PC**: two new models in the Model block (Image tab) — **FLUX.2 Klein 9B** (an image in a
  few seconds; connect an image and it edits it, keeping its framing) and **Qwen-Image 2.1 Turbo** (very faithful to text
  written in the image, up to 2K). Sizes 1K, 1.5K, 2K. Non-commercial licenses: offered “to try”, for trials and personal
  projects. A LoRA is offered only on the model it was trained for (Klein 9B or Qwen-Image 2.1, never one on the other).
- **A layout for Qwen-Image 2.1**: connect an image to “Layout” and the block keeps its composition (its depth) while
  your LoRA keeps its style; “Layout strength”: Strict, Balanced, Loose. The format follows the layout image.
- **A LoRA’s advice**: a file next to it (<name>.mia.json) gives its trigger word, its suggested strength (set when you
  pick it) and advice shown under “Strength”.
- **Retouch a zone** (Qwen-Image 2.1): a new **Mask** block where you paint the zone on the image (brush, eraser,
  size, invert, wheel zoom); only that zone is remade, with your LoRA, then pasted back: the rest of the image does
  not move by a pixel. A small zone (feet, an eye) is enlarged on its own to be computed in detail. Recipe “Retouch
  a zone”.
- **Rewrite your prompt in English**: tick “Rewrite in English” under a Prompt block. Before the job, a model on this
  PC (Qwen’s prompt reader) fixes the typos, translates and describes in order: subject, setting, background, light,
  then what to leave out. The text as understood shows under the prompt; it is redone only when you change it.
  “Rewrite now” shows it before anything runs.
- **4 variations**: on Qwen-Image 2.1, FLUX.2 Klein and Qwen Image Edit, one button makes 4 images with 4 different
  seeds, one after another. Compare them in the block’s versions; the star keeps the one you pick.
- **“+ Block” sorted by what you make**: on the left, Make (Video, Image, Sound), Prepare (Media and prompts, Recipes,
  Notes), Rework (Editing, Finishing). In Video and Image: the models “On this PC”, the “Online” ones, then the blocks.
  Online models are no longer apart: each one sits in the tab of what it makes.
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
- Bloc **Masque** (`mask`, `executors/mask.js`, sans GPU) : le dessin noir et blanc de l’éditeur
  (`src/js/nodes/maskeditor.js`, écrit dans `media\` sous un nouveau nom à chaque validation, réglage `drawing`)
  remis à la taille de l’image, bord adouci vers l’extérieur (flou puis ×2 : la zone peinte reste entière ; au plus
  le quart du petit côté de la zone), inversé pour « Zone à protéger ». Qwen-Image 2.1 « Retoucher une zone »
  (`image` + `mask`) : `VAEEncode` + `SetLatentNoiseMask`, « Ampleur du changement » (`zoneStrength`) en
  débruitage, recollage `maskedmerge` de ffmpeg ; zone de moins de 300 px : fenêtre carrée de 6 fois la zone
  (`ImageCrop`) calculée en 1024 × 1024 puis réduite et recollée. Recette `retouch-zone`.
- Consigne **« Réécrire en anglais »** (réglage `rewrite`) : la Consigne cochée devient un calcul,
  `executors/rewrite.js` (GPU) : `TextGenerate` de ComfyUI sur le lecteur de Qwen-Image 2.1
  (`qwen3vl_8b_int8_convrot`, chargé en `stable_diffusion` : le modèle Qwen-VL qui écrit), sinon celui de Qwen Image
  Edit (`qwen_2.5_vl_7b_fp8_scaled`) ; pas le Gemma de LTX (du charabia à l’essai du 25/10) ni le Qwen3 de Klein (son
  fichier n’a pas la couche qui écrit, `lm_head`).
  Conversation écrite en entier (règles, deux exemples), échantillonnage bas à graine fixe, réponse nettoyée et
  refusée si illisible. Moteur : `rewriteType` (empreinte = texte + façon de réécrire, « À éviter » passe tel quel),
  la réécriture est une version de la Consigne (`consigne.txt`, `outputs.text.meta.text`) reprise tant que le texte
  ne change pas ; l’aval la reçoit (`x.inputs.prompt` et le réglage écrasé par le fil), sa version la note.
- **« 4 variantes »** (`runs.runVariants`) : quatre demandes au moteur, graines tirées au hasard ; le bloc montre le
  calcul en cours puis passe au suivant, « Annuler » les arrête toutes, la graine du bloc devient celle de la
  dernière. Assistants : `mia_run {variants}`, et `rewritten` dans `mia_get_output` d’une Consigne.

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
- Le résultat d’un bloc Modèle du PC se branche enfin sur un autre bloc (Finition, Animer…) : il était rangé sous un
  autre nom que la sortie « Résultat ». Les calculs déjà faits restent lisibles.
- Une LoRA n’est plus devinée d’après le nom de son fichier : « qwen » dans le nom ne la faisait pas aller sur Qwen Image
  Edit ; une LoRA FLUX.2 n’est plus prise pour une LoRA FLUX.1.
- La croix qui coupe un fil ne coupait pas : l’effet « enfoncé » faisait perdre la croix au navigateur.
- Les blocs restaient flous après un zoom avant : la planche est redessinée nette une fois le zoom posé.
- Higgsfield : une image en ligne avec une image de référence (Soul…) était refusée (« URL input should be a string
  ») ; chaque champ reçoit maintenant une adresse seule ou une liste, selon ce qu’il attend.
- Bloc Modèle en ligne : « Ce que fait le bloc » dit « Image depuis un texte + Images de référence » quand les
  références branchées servent ; le puits du résultat n’annonce plus « ≈ 1 min » pour un calcul en ligne.
- La recherche de « + Bloc » ouverte depuis un fil n’est plus coupée (« Chercher… »).

### Pour les développeurs
- `E.maskBox(x, abs)` (`patch.js`) : rectangle de la zone blanche d’un masque (filtre `bbox` de ffmpeg) ;
  `t2i.js` exporte `zoneWindow` et `pasteArgs`, essayés avec le vrai ffmpeg
  (`node tools/test-light-executors.js --only=mask` : le reste de l’image identique au pixel).
- Réécriture : `tools/test-engine.js` (16 contrôles, faux `tools/fixtures/engine/executors/rewrite.js`) et
  `tools/validate-workflows.js` (cas `rewrite` ; le faux ComfyUI rend un texte pour `PreviewAny`).
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
