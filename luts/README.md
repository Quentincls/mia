# Looks « film » de Mia

Sept LUT 33³ (.cube) d'une même famille, dérivées de **etalo**, un étalonnage Lightroom de l'auteur (cette LUT
d'origine reste privée : elle n'est pas dans le dépôt). Pour l'aperçu et la finition dans Mia : bloc **Finition**
(réglage « Étalonnage ») et bloc **Essayer des looks** (planche d'une image avec tous les looks). `index.json` les
liste ; `previews\` = une vignette par look.

## L'ADN d'etalo (mesuré sur la LUT)
- **Courbe** : noirs relevés et mats (le noir sort à 9/255, jamais bouché), pied profond (les ombres restent
  serrées : gris 25 % → 16 %), contraste franc dans les tons moyens (pente ×1,3 vers 50 %), épaule douce : le blanc
  s'arrête à 84 % (crème), jamais d'écrêtage. Tons moyens plus sombres (gris 18 % : 46 % → 36 %).
- **Couleur des gris** : ombres légèrement olive, tons moyens et hautes lumières ambrés (rouge +3 %, bleu −4 %).
- **Saturation** : très basse dans les ombres (×0,4), presque gardée dans les tons moyens et les hautes lumières.
- **Teintes** : la peau est épargnée (×0,9, à peine plus jaune) ; rouges tirés vers la brique, verts vers l'olive,
  bleus éteints (×0,5) et tirés vers le bleu-vert ; les couleurs très saturées sont compressées (rien de fluo).
- **Contraste global** : durcit une image claire ; sur une image très sombre (une salle de cinéma), il relève les
  noirs et adoucit (écart-type de luminance 0,084 → 0,056).

## Les looks (même courbe, même pied, même épaule ; une intention chacun)
| Look | Intention |
|---|---|
| Etalo doux | etalo plus tendre : noirs moins appuyés, contraste et couleurs adoucis |
| Etalo nuit | plus sombre et plus froid, ombres profondes bleutées, peau gardée |
| Pellicule chaude | négatif chaud façon Kodak : tons dorés, rouges pleins, noirs bruns |
| Pellicule froide | négatif froid façon Fuji : ombres vertes, blancs neutres, couleurs retenues |
| Sans blanchiment | couleurs éteintes, contraste dur, reflets argentés |
| Crépuscule | hautes lumières ambrées, ombres bleu-vert, sans excès |
| Noir et blanc argentique | gris riches, noirs mats, une pointe de chaleur |

Tous : axe neutre croissant, noir > 0 et blanc < 93 %, peau protégée, gamut tenu en réduisant la chroma (pas en
écrêtant).

## Comment elles sont faites
L'étalonnage d'origine est décomposé en Oklab (courbe de clarté, virage des gris, saturation selon la clarté et
selon la teinte, décalage de teinte), puis chaque look est réécrit à partir de cet « ADN » avec quelques réglages.
L'outil qui les fabrique lit l'étalonnage privé de l'auteur : il n'est pas publié. Pour ta propre LUT .cube :
Finition → Étalonnage → « Autre LUT (fichier) ».
