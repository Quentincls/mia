---
name: mia-recettes-video
description: Des méthodes de vidéo IA locale éprouvées, traduites en chaînes de blocs Mia avec les bons réglages - LTX + LoRA (Animer une image), Rendre photoréaliste un rendu 3D (Unreal, Blender), Vidéo guidée, Vidéo à partir de références (MiniMax), Animer un personnage (Wan Animate 2), Finition et looks, Son, montage, passes (profondeur, détourage). À utiliser pour choisir QUELLE méthode et QUELS blocs/réglages proposer pour un plan, avant de construire une planche ; à combiner avec mia-piloter pour la poser.
---

# Recettes vidéo dans Mia

Principe : **l'IA repeint, la 3D garde le contrôle** (cadrage, caméra et timing viennent du rendu Unreal ou
Blender). On juge à l'œil, en côte à côte avec la source, et sur l'écran où le film sera vu.

## Règles qui valent pour toutes les recettes
1. **Plan d'abord** : en 5-10 lignes, quelle méthode pour quel passage ; le faire valider par l'utilisateur. Une
   recette déjà validée se réapplique telle quelle. **Une seule méthode par passage** (changer en cours = saut
   visible).
2. **Aperçu avant rendu final** (`mode:"preview"` : basse définition, ~3 s), plusieurs graines (`seed`) si le
   résultat hésite ; jamais une génération complète à l'aveugle.
3. **Une clé sur la PREMIÈRE image** de chaque génération (image de début, image de look, image de départ) ; sinon
   le début est improvisé. Une seule clé de visage (plusieurs = le visage « morphe »).
4. **Pas de flou de mouvement** dans ce qu'on donne à l'IA (elle « bouillonne ») ; Mia n'en remet pas (aucune passe
   de mouvement) : à ajouter au montage si besoin.
5. **Image de fin** pour placer l'action : le texte seul ne la place pas.
6. **Jamais de fondu enchaîné** entre deux générations ou entre une génération et le décor (double exposition) :
   coupe franche ou passage au noir.
7. **Contrôler avant de montrer** : bloc Comparer A/B (source ↔ résultat), images consécutives autour des
   raccords (bloc Extraire une image), liste honnête des défauts. Rien de présenté comme sûr sans l'avoir vu.
8. Parler simplement : « repeinte de ton rendu », « génération guidée par la profondeur », jamais « méthode C »,
   « IC-LoRA », « Union ». Pour un envoi sur téléphone : Exporter en `phone` (< 30 Mo).
9. Un défaut ? Trouver l'étape qui le crée (rendu 3D, IA brute, finition, montage) avant de régénérer ; un seul
   réglage changé à la fois. Mia garde chaque version (v1, v2…) : ne rien supprimer, dire laquelle étoiler.

## Quelle méthode ?
| Ce que l'utilisateur a / veut | Bloc Mia (`type`) |
|---|---|
| Un rendu 3D animé à rendre « filmé », caméra et timing gardés | Rendre photoréaliste (`real`) |
| Un blockout / une vidéo dont on garde formes et mouvement, mais tout réinventer (matières, jeu) | Vidéo guidée (`guided`) |
| Une image clé à animer (élément, plan simple) | Animer une image (`i2v`) |
| Rien qu'une description (vague sur un écran, élément) | Vidéo depuis un texte (`t2v`) |
| Plusieurs références (personnage + objet + lieu) dans un plan inventé | Vidéo à partir de références (`ref2v`) |
| Son personnage (une image) qui rejoue une vidéo (selfie, mannequin) | Animer un personnage (`perform`) |
| Retoucher une image vite, en local | Retoucher une image (`edit`) ; une clé retouchée dans un autre outil s'importe aussi |
| Couleur, grain, look film | Essayer des looks (`looks`) puis Finition (`finish`) |
| Musique, bruitage | Son (`sound`) |
| Montage, export | Assembler (`sequence`), Couper (`trim`), Exporter (`export`) |

## 1. Rendre photoréaliste un rendu 3D (`real`)
Recette prête : `unreal-to-real`. Chaîne : Média (rendu) → Extraire une image (`at:0`) → Retoucher une image →
`real.look` ; Média → `real.video` ; `real` → Comparer A/B (`a` = rendu) → Exporter (`format:"phone"`).
- Source : la passe **Lumière seule** (Lighting Only), **sans motion blur**. L'image 0 des ProRes d'Unreal est
  souvent fausse → réglage avancé du Média `skipFirst:true`.
- Look : l'image 0 retouchée. La meilleure = une clé retouchée avec soin et importée (même cadrage et même format
  que l'image 0 : Mia la remplit au centre, elle ne recale pas une retouche décalée). Retoucher une image (`edit`,
  `speed:"fast"`) pour itérer.
- Réglages : `prompt` court en anglais (« photoreal, cinematic, natural skin… »), `keepBlacks:true` (l'IA rallume
  les noirs), `lora` du personnage si son visage est grand, `loraStrength:1`.
- Aperçu : 544 px, 49 premières images (~2 min). Final : taille source (≤ 1920), fenêtres de 97 images raccordées
  à l'image la plus ressemblante, ~9 min par 4 s.
- Pièges : recopie un mesh faible (visage carré, cheveux « spaghettis ») → personnage au mesh pauvre : Vidéo
  guidée + LoRA, ou Animer un personnage ; rien ne bouge au vent si rien ne bouge en 3D (animer dans la 3D) ;
  ce qui n'existe pas en 3D (lunettes, frange) est inventé et dérive ; un survol aérien ou une surface d'eau
  « tremble » de partout : préférer une autre méthode.

### Un humain qui bouge dans le plan
- Méthode qui marche : **blockout crédible repeint en UNE passe** : vrai corps humain habillé en volumes,
  mouvement de capture (ou texte → mouvement) pieds au sol, blockout **éclairé comme le look voulu** ; puis Rendre
  photoréaliste sur tout le plan (décor + personnage) avec la clé et le LoRA. Lumière, ombres, contact et
  occultation viennent de la 3D.
- Visage petit (30-40 px) : aucun LoRA ne le sauve (LTX travaille 32× plus petit) → le générer **grand** (2e caméra
  serrée sur lui) ; identité prioritaire → Animer un personnage.
- Recoller un personnage généré à part (Détourer + Superposer) = effet « autocollant » (pas d'ombre, lumière de
  face) : seulement en secours.

## 2. Animer une image avec LTX + LoRA (`i2v`)
Recette : `animate-image`. Média → `start` (requis) ; Média → `end` (conseillé) ; Consigne → `prompt`.
- `duration` 2-15 s (5 ; LTX 10 s au plus, MiniMax H3 15 s : le moteur ramène à la limite du modèle), `format` (`auto` = comme l'image, `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `21:9`),
  `resolution` `540`/`720`/`1080` (côté court, rendu final seulement), avancé `fps` 24/25/30, `seed`.
- `lora` = un personnage ou un lieu de l'utilisateur (par exemple `mon_perso`, déclencheur « mnprs woman ») ; le
  mot déclencheur est ajouté en tête de la consigne. Le LoRA aide l'identité **quand le visage est grand** ; il ne
  sauve pas un petit visage ; pas de LoRA visage sur un travelling vers l'œil guidé par des clés.
- `sheet` (Fiche de référence) : planche du personnage (plusieurs vues), LTX s'en inspire tout le plan ; ignorée
  avec MiniMax.
- `model` : `auto` = LTX 2.5 ; « MiniMax H3 » (début + fin, 24 i/s ; licence **R&D seulement**, Mia l'indique :
  pas pour un travail payé ; pas de LoRA LTX avec lui). Aperçu ≈ 1 min ; final 5-9 min.
- Consigne : sujet + action + caméra (« static locked-off camera », « no cuts, no text ») + lumière +
  « photoreal, cinematic ».
- Piège : la clé de fin LTX peut figer les ~0,8 dernière seconde : regarder la fin.
- `t2v` (texte seul) : mêmes réglages, `prompt` requis, `negative` avancé (« text, watermark, cuts »).

## 3. Vidéo guidée (`guided`)
Entrées : `guide` (vidéo, requis : blockout, rendu, ou sortie d'un bloc Profondeur), `look` (Image de départ = la
1re image retouchée), `mask` (Zone libre : blanc = l'IA invente, noir = elle suit), `prompt` (requis).
- `follow` : `depth` (volumes + caméra) ou `edges` (contours, garde aussi les détails) ; `strength` 0,3-1,5 (1) ;
  `resolution` 540/720/1080 ; `lora`.
- `model` : `auto` = LTX (guide de profondeur ou contours) ; MiniMax H3 possible (le masque est alors ignoré).
- Pièges : la profondeur seule ne porte **aucune lumière** → sans Image de départ, la lumière pompe et le décor
  s'invente : toujours une clé de départ. Pas de squelette/pose dans Mia. Aperçu 544 px / 49 images ; final
  ~8 min par 4 s.

## 4. Vidéo à partir de références (`ref2v`, MiniMax H3)
- `refs` : jusqu'à **9 images** (requis), `refVideos` : jusqu'à **3 vidéos** de 2 à 15 s (mouvement, ambiance,
  voix). Numérotées dans l'ordre des fils = ordre vertical des blocs sources.
- `prompt` (requis) cite « Image 1 », « Vidéo 2 »… (Mia traduit pour le modèle). `format`, `resolution`
  `540`/`720`/`768` (768 = la taille native de MiniMax, à essayer : mémoire), avancé `fidelity` `match`/`max`.
  24 i/s. Aperçu ≈ 2 min ; final ≈ 6 min pour 5 s.
- `refAudios` : jusqu'à **3 sons** (voix, musique, bruitage ; 15 s au plus), cités « Son 1 »… (à essayer). Le son
  d'une vidéo de référence est déjà pris avec elle.
- Licence du modèle : R&D seulement (comme MiniMax H3 dans Animer une image).

## 5. Animer un personnage (`perform`, Wan Animate 2)
Recette : `character-performance`. `character` (une image, requis) + `motion` (vidéo, requis) + `prompt`
(Description).
- Meilleure identité à ce jour (même visage du début à la fin). Image de référence idéale : le personnage **dans
  son décor**. Vidéo : quelqu'un filmé au téléphone, ou le mannequin du blockout **en cadre serré** (un petit
  personnage dans un plan large n'a pas les pixels pour un visage : le générer grand).
- Mia passe le mouvement à 16 i/s (cadence de Wan) ; **le résultat reste à 16 i/s** (pas d'interpolation
  d'images dans Mia). Aperçu 480p, 3 premières secondes (~4 min) ; final 720×1280, ~14 min par 5 s, 30 s au plus.
- Limites : fond inventé et lumière de face → recomposer (Détourer sur SON image + Superposer) ou demander le
  contre-jour ; sortie ~720p. LoRA : seulement un LoRA Wan (un LoRA LTX est refusé).
- Avancé : `motionFidelity` (Fidélité au mouvement, 0-2, 1 = normal : plus haut = colle au geste) et `likeness`
  (Ressemblance au personnage, 0-2 : plus bas = la consigne peut changer son allure).

## 6. Finition et looks
1. **Essayer des looks** (`looks`, léger, quelques secondes) : une image (`at` = n° d'image) passée par chaque
   look, en planche contact. On choisit à l'œil.
2. **Finition** (`finish`, GPU, quelques secondes par plan, son gardé) : `look` = `etalo-doux`, `etalo-nuit`,
   `pellicule-chaude`, `pellicule-froide`, `sans-blanchiment`, `crepuscule`, `nb-argentique`, `none`, ou `file` +
   `lutFile` (ta propre LUT .cube). `lutStrength` 0-150 (100), `grain` 0-6 (**2** : discret), `vignette` 0-30
   (**6**) ; avancé `warm` (garder les rouges saturés), `film` (optique de cinéma : courbe douce, léger halo,
   franges).
- Même look sur tous les plans d'un film. Finition **après** le rendu final de la génération, avant Son/Exporter.

## 7. Son (`sound`, léger)
Média audio → `audio` ; vidéo → `video`. `mode` `mix` (garder le son d'origine, `origVolume`) ou `replace` ;
`volume` 0-200 % ; `fadeIn` / `fadeOut` (0,5 s) ; `loop` (ambiance courte) ; `fit` (couper à la fin de la
vidéo, sinon la dernière image tient) ; avancé `start` (image de départ), `level` (égaliser à RMS −20 dB, activé).

## 8. Montage et livraison
- **Couper** (`trim`) : `start` / `end` en n° d'image (0 = première, −1 = dernière, incluses).
- **Assembler** (`sequence`) : `clips` dans l'ordre vertical des blocs ; `transition` `cut` ou `black` (jamais de
  fondu enchaîné). Tout est ramené au format et à la cadence du **premier** clip.
- **Exporter** (`export`) → dossier `A_regarder\` de la planche : `mp4` (haute qualité), `phone` (< 30 Mo),
  `png` (suite d'images pour une vidéo) ; `name` facultatif, jamais d'écrasement.
- Raccord entre deux générations : la suivante **part de la dernière image** de la précédente (Extraire une image
  `at:-1` → image de début), puis coupe nette vérifiée image par image.

## 9. Passes et outils
- **Profondeur** (`depth`) : Video Depth Anything Small (clair = proche, stable), `detail` `fast`/`fine`, avancé
  `invert`. Sert aussi de guide à la Vidéo guidée.
- **Détourer** (`cutout`, BiRefNet) : sorties `mask` et `cut` ; `background` `black`/`green`/`alpha`
  (PNG / WebM transparents), `feather`, `grow`. Détourer sur l'image générée elle-même, pas avec un masque 3D élargi.
- **Superposer** (`composite`) : `bg`, `fg`, `mask` (sinon la transparence du calque) ; `feather`, `match`
  (accorder les couleurs au fond).
- **Agrandir** (`upscale`, SeedVR2) : `target` `1440`/`2160` ; utile pour sortir du 720p de Wan ; décevant sur les
  visages (lisse à 1080, durcit à 1440).
- **Redimensionner** (`resize`) : jamais de changement de cadence (pas d'images répétées).
- **Comparer A/B** (`compare`, `mode` `slider`/`side`/`diff`) : systématique, source en A.

## 10. Nouveautés du bloc Modèle (24/10 ; « à essayer » sauf prolonger et images-clés MiniMax, validés)
Toutes passent par un bloc Modèle (`type:"gen"`, voir mia-piloter) ; le moteur les note dans le résultat.
- **Images-clés** (`keys`, LTX et MiniMax, jusqu'à 4) : des images par où le plan passe entre le début et la fin,
  réparties à intervalles égaux dans l'ordre vertical des fils. Pour tenir une action longue sans dériver.
  **Même cadrage que l'image de début** : essai GPU du 24/10 (MiniMax), une image-clé cadrée autrement fait couper
  le plan vers elle ; au même cadrage, le plan reste continu et passe par la pose (≈ 6 min pour 5 s).
- **Son à suivre** (`audio`, MiniMax) : une voix ou une musique sur laquelle la vidéo se cale (lèvres, rythme).
- **Prolonger une vidéo** (`video` dans MiniMax) : reprend les ~1,6 s de fin (et leur son) et continue le plan de
  `duration` secondes ; le résultat est la vidéo entière. La consigne dit ce qui se passe ensuite. Essai GPU du
  24/10 : raccord invisible, son continu (≈ 9 min pour 3 s + 4 s).
- **LTX « Deux passes »** : caché dans Mia depuis l'essai GPU du 24/10 (en 1080p, **moins net** qu'une passe et
  visage moins fidèle, pour le même temps). Une passe reste la bonne réponse pour un 1080p net.
- **LTX « Enrichir la consigne »** (`enhance`) : Gemma réécrit la consigne en anglais détaillé (dans les notes).
- **Qwen Image Edit** : jusqu'à 2 images d'appui (`ref`), citées « image 2 », « image 3 ».
- **LTX « Vidéo depuis une fiche personnage »** (`sheet` seule, à essayer) : une image qui réunit le personnage,
  ses tenues, ses objets ou le lieu ; la consigne désigne chaque élément par sa place (« l'homme à gauche »). Gabarit
  officiel Ingredients ; au labo, visage moyen (moins bon que Wan Animate 2). Pour des références séparées, MiniMax.
- **Recette « Vidéo à partir de mes références »** : 2 Médias (Personnage = Image 1, Lieu = Image 2) + une Consigne
  qui les cite + « Vidéo à partir de références » (MiniMax).
- **MiniMax 768p** : la taille native (1344 × 768) au lieu de 704 px ; si la mémoire manque, revenir en 720p.

## Durées indicatives (GPU portable de 24 Go, un calcul lourd à la fois)
Retoucher une image ≈ 15 s (rapide) / ≈ 3 min (qualité) · Animer une image : aperçu ≈ 1 min, final 5-9 min ·
Rendre photoréaliste : aperçu ≈ 2 min, ≈ 9 min par 4 s · Vidéo guidée ≈ 8 min par 4 s · Références ≈ 6 min pour
5 s · Animer un personnage ≈ 14 min pour 5 s · Agrandir ≈ 6 s par image · Profondeur, Détourer : rapides.
