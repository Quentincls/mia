# Journal des versions de Mia

Les évolutions notables de Mia, de la plus récente à la plus ancienne. Numéros de version
[SemVer](https://semver.org/lang/fr/) : Mia reste en 0.x tant que ses formats de fichiers peuvent encore évoluer.

Les fichiers de Mia (planches, projets, réglages) sont mis à jour tout seuls à l’ouverture, sans rien perdre : avant
d’écrire un fichier dans un format plus récent, Mia garde l’ancien à côté (`graph.json.bak-v0`, `prefs.json.bak-v0`…).

Chaque version commence par **En bref** (en français) et **In short** (en anglais) : quelques lignes en mots simples,
celles que Mia affiche dans « Nouveautés ». Suivent le détail (Ajouté, Changé, Corrigé) et, à la fin, ce qui ne
concerne que les développeurs.

## À venir

### Corrigé
- **Claude et Codex retrouvent Mia** : installés depuis le Microsoft Store, ils voient `%APPDATA%` à travers leur
  propre copie privée, où un vieux `bridge.json` (d’une Mia qu’ils avaient lancée eux-mêmes) cachait celui de la
  Mia ouverte : « Mia ne répond pas » à chaque appel. Mia écrit maintenant aussi `%TEMP%\Mia\bridge.json`, que
  le serveur MCP lit en premier (jamais par une instance de test).

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
