# Piloter Mia avec un assistant (Claude, Codex)

Tu dis à Claude (ou à Codex, l'outil de ChatGPT) ce que tu veux faire — « prends ce rendu Unreal, fais-moi la
profondeur et compare-la à l'original » — et tu le **vois** faire dans Mia : il crée la planche (dans le bon
projet), pose les blocs, les relie, règle, importe tes fichiers, lance le calcul et regarde le résultat.

## Projets et planches

Comme dans l'interface : une **planche** est une toile de blocs (un onglet) ; un **projet** est un dossier qui
range plusieurs planches (un groupe d'onglets coloré, une carte sur l'accueil). Dis-lui par exemple « dans le
projet Mon film, fais-moi une planche Plan 05 » : il range la planche dans ce projet, et crée le projet s'il
n'existe pas encore. « Ouvre Mon film / Plan 05 » rouvre une planche précise ; « ouvre Mon film » rouvre la
dernière planche utilisée de ce projet.

Pour l'assistant, les noms des outils restent historiques : `mia_create_project` crée une **planche**,
`mia_open_project` ouvre une **planche**, `mia_create_folder` crée un **projet** ; ses instructions le lui
expliquent.

## Ce que tu vois dans Mia

- **Un curseur** avec le nom de l'assistant (« Claude ») qui glisse jusqu'au bloc qu'il pose, aux ports qu'il
  relie, au réglage qu'il change. La vue le suit doucement quand il travaille hors de l'écran.
- **Une bulle** près du curseur quand il te dit quelque chose.
- **Une pastille** dans la barre de titre : « CLAUDE PILOTE MIA », tant qu'il travaille.
- Chaque action entre dans l'historique : **Ctrl+Z** l'annule, comme les tiennes.
- Ses calculs passent dans **la même file et le même verrou GPU** que tes clics.

## Comment ça marche

Au démarrage, Mia ouvre un petit **pont local** : il n'écoute que ton PC (`127.0.0.1`, port 8777 ou suivant) et
exige un jeton secret, écrit avec le port dans `%APPDATA%\Mia\data\bridge.json` (effacé quand Mia se ferme).
Le serveur MCP `mcp\mia-mcp.js` (sans aucune dépendance) lit ce fichier et transmet les demandes de l'assistant.
Si Mia est fermée, il la lance et attend qu'elle soit prête (25 s au plus).

Réglages → « Pilotage par un assistant » dit si le pont est actif, sur quel port, et qui est passé en dernier.

Le serveur tourne avec **Node.js** (la commande `node` dans un terminal) ou, sans Node.js, avec l'exécutable de
Mia lui-même (voir « Sans Node.js » plus bas). ChatGPT dans le navigateur ne peut pas joindre un programme de ton
PC : c'est Codex (ou Claude) qui fait le lien.

## Déclarer Mia auprès des assistants

Ces fichiers ne sont **pas** modifiés par Mia : c'est à toi (ou à l'assistant, avec ton accord) de le faire.

Il faut le chemin complet du serveur `mia-mcp.js`, rangé dans le dossier `mcp` de Mia :

| Mia | Chemin du serveur |
|---|---|
| installée avec l'installateur (dossier proposé) | `%LOCALAPPDATA%\Programs\Mia\resources\app\mcp\mia-mcp.js` |
| version portable (zip) | `<dossier de Mia>\resources\app\mcp\mia-mcp.js` |
| lancée depuis les sources (`git clone`) | `<dossier de Mia>\mcp\mia-mcp.js` |

Les fichiers de réglages ci-dessous ne remplacent pas `%LOCALAPPDATA%` : écris le chemin en entier
(`C:\Users\<ton nom>\AppData\Local\…`), avec les `\` doublés dans le JSON et le TOML.

### Claude Code — `%USERPROFILE%\.claude.json`

Ajouter `mia` dans `mcpServers` (au niveau racine du fichier pour l'avoir dans tous les dossiers) :

```json
{
  "mcpServers": {
    "mia": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\Users\\<ton nom>\\AppData\\Local\\Programs\\Mia\\resources\\app\\mcp\\mia-mcp.js"]
    }
  }
}
```

Ou, en une commande dans l'invite de commandes (`cmd`, qui remplace `%LOCALAPPDATA%` tout seul) :

```
claude mcp add mia --scope user -- node "%LOCALAPPDATA%\Programs\Mia\resources\app\mcp\mia-mcp.js"
```

L'application Claude (bureau) lit le même bloc `mcpServers` dans `%APPDATA%\Claude\claude_desktop_config.json`.

### Codex — `%USERPROFILE%\.codex\config.toml`

```toml
[mcp_servers.mia]
command = "node"
args = ["C:\\Users\\<ton nom>\\AppData\\Local\\Programs\\Mia\\resources\\app\\mcp\\mia-mcp.js"]
startup_timeout_sec = 40
tool_timeout_sec = 660
```

(`tool_timeout_sec` : `mia_wait` peut attendre jusqu'à 10 minutes la fin d'un calcul.)

### Sans Node.js

L'exécutable de Mia fait aussi tourner le serveur : la variable `ELECTRON_RUN_AS_NODE=1` le fait marcher comme
Node.js (le serveur retire cette variable avant de lancer Mia, qui s'ouvre alors normalement). La commande devient :

| Mia | Commande |
|---|---|
| installée avec l'installateur (dossier proposé) | `%LOCALAPPDATA%\Programs\Mia\Mia.exe` |
| version portable (zip) | `<dossier de Mia>\Mia.exe` |
| lancée depuis les sources (`git clone`) | `<dossier de Mia>\node_modules\electron\dist\electron.exe` |

Claude Code (`%USERPROFILE%\.claude.json`) :

```json
{
  "mcpServers": {
    "mia": {
      "type": "stdio",
      "command": "C:\\Users\\<ton nom>\\AppData\\Local\\Programs\\Mia\\Mia.exe",
      "args": ["C:\\Users\\<ton nom>\\AppData\\Local\\Programs\\Mia\\resources\\app\\mcp\\mia-mcp.js"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

Ou, dans `cmd` :

```
claude mcp add mia --scope user -e ELECTRON_RUN_AS_NODE=1 -- "%LOCALAPPDATA%\Programs\Mia\Mia.exe" "%LOCALAPPDATA%\Programs\Mia\resources\app\mcp\mia-mcp.js"
```

Codex (`%USERPROFILE%\.codex\config.toml`) :

```toml
[mcp_servers.mia]
command = "C:\\Users\\<ton nom>\\AppData\\Local\\Programs\\Mia\\Mia.exe"
args = ["C:\\Users\\<ton nom>\\AppData\\Local\\Programs\\Mia\\resources\\app\\mcp\\mia-mcp.js"]
env = { ELECTRON_RUN_AS_NODE = "1" }
startup_timeout_sec = 40
tool_timeout_sec = 660
```

Relance l'assistant après la modification ; il voit alors les outils `mia_…`.

## Les outils (ce que l'assistant peut faire)

| Outil | Ce qu'il fait |
|---|---|
| `mia_status` | Mia ouverte ? planche affichée (et son projet), ta sélection, les planches ouvertes en onglets (`mia.tabs`), moteur ComfyUI, GPU, file de calcul, capacités installées |
| `mia_request` · `mia_pending` | te demander ton feu vert avant d'agir (carte « Claude attend ton feu vert ») ; savoir où en sont le feu vert, la pause et la liste « À générer » |
| `mia_catalog` | tous les blocs (« Profondeur », « Animer une image »…), leurs entrées/sorties, réglages et valeurs permises, recettes, modèles (avec leur version et leur mémoire estimée), LoRA, mémoire de la machine |
| `mia_list_projects` | tes projets et toutes les planches (avec le projet de chacune ; `open` = ouverte dans un onglet, `active` = celle à l'écran) |
| `mia_create_folder` | créer un projet (dossier de planches), avec sa couleur ; s'il existe déjà, il est repris tel quel |
| `mia_create_project` | créer une planche (nouvel onglet), dans un projet (`folder`, créé s'il manque), avec une recette au besoin |
| `mia_open_project` | ouvrir une planche : par son nom, « Projet / Planche », ou la dernière d'un projet |
| `mia_get_board` | la planche : blocs, réglages, fils, états, résultats avec leurs chemins complets, ta sélection, les blocs à l'écran (`inView`) |
| `mia_add_block` | poser un bloc (à droite du bloc qui l'alimente, jamais par-dessus un autre) |
| `mia_connect` | relier deux blocs (port deviné s'il n'est pas donné) |
| `mia_set_params` · `mia_rename_block` | régler un bloc (valeurs vérifiées), lui donner un titre |
| `mia_remove_blocks` | retirer des blocs de la planche (aucun fichier effacé, Ctrl+Z possible) |
| `mia_import_media` | importer des images/vidéos par leur chemin complet (`D:\…\plan12.mp4`) |
| `mia_insert_recipe` · `mia_arrange` | poser une recette ; ranger la planche de gauche à droite selon les fils, ou seulement certains blocs ou une section, en grille (`layout: "grid"`, `columns`) |
| `mia_move_blocks` | déplacer des blocs à une place précise ; refusé si un bloc en recouvrirait un autre (`mia_get_board` → `overlaps` dit ceux qui se recouvrent) |
| `mia_run` · `mia_wait` · `mia_jobs` · `mia_cancel` | lancer (aperçu d'abord ; `variants: 4` = le bouton « 4 variantes » d'un bloc image du PC ; sur une Consigne « Réécrire en anglais », la réécriture seule), attendre la fin, voir la file, annuler |
| `mia_get_output` · `mia_snapshot` | les fichiers du résultat ; une capture de Mia pour que l'assistant regarde |
| `mia_add_section` | encadrer des blocs dans une section nommée, à la manière de Figma ou Miro |
| `mia_focus` · `mia_say` | te montrer des blocs ; t'écrire un mot dans une bulle |
| `mia_train_options` | sur quels modèles un LoRA peut être entraîné ici, les durées, la place disque, le GPU, l’entraînement en cours |
| `mia_train_prepare` | préparer un brouillon d’entraînement : nom, modèle, mot déclencheur, images (chemins complets, 300 au plus), légendes, durée |
| `mia_train_start` | **proposer** de lancer un brouillon, ou de reprendre un entraînement (`resume: true`) : rien ne part, c’est toi qui cliques (en « Auto », il lance directement) |
| `mia_train_status` · `mia_train_wait` | où en est l’entraînement (pas, perte, temps restant, essais et points de contrôle avec leurs chemins) ; attendre le prochain essai, le prochain point, la fin |
| `mia_train_control` | mettre en pause, ou ranger un point de contrôle dans « Mes LoRA » — jamais reprendre, arrêter ni supprimer |
| `mia_train_note` | écrire une courte note signée dans les évènements de l’entraînement |

### Ton feu vert, et « À générer »

Rien ne bouge sans toi. Quand tu demandes quelque chose, une petite carte apparaît en bas de Mia : « Claude attend
ton feu vert », avec ce qu'il veut faire. « C'est parti » le laisse agir, « Plus tard » range la carte dans une
pastille, « Détail » montre les étapes et le bouton « Refuser ». Pendant qu'il travaille, « Pause » dans la barre de
titre l'arrête là où il en est.

Ensuite, aucun calcul ne part tout seul : ce que l'assistant veut générer arrive dans le panneau « À générer », à
droite de la planche, rangé par plan (une case par plan, une case par calcul). Tu
coches ce que tu veux (les calculs en ligne, payants, arrivent décochés), tu lis le temps prévu et le prix, puis
« Générer la sélection ». Pour revenir à l'ancien comportement : Réglages → Assistants → « Demander mon feu vert ».

**« Je valide » ou « Auto »** : le même réglage se change d’un clic en bas à gauche de la planche, à droite
de « Bloc · Recettes · Section ». « Je valide », c’est ce qui est décrit plus haut. « Auto » (en bleu),
pour quand tu n’es pas devant ton PC : l’assistant agit sans carte et **tout part aussitôt, les calculs lourds du PC
comme les calculs en ligne payants**, et un entraînement qu’il lance démarre. Si une carte attend quand tu passes en
« Auto », elle est acceptée. Ce qui est déjà dans « À générer » y reste, à cocher (« Proposés avant « Auto » »
) : rien ne part sans que tu l’aies vu ; l’assistant peut le relancer lui-même, c’est alors parti. Revenir à
« Je valide » ne coupe rien de ce qui tourne : sa prochaine action te redemande ton feu vert. « Pause » l’arrête
toujours, dans les deux modes. Pour l’assistant : `mia_request` et `mia_pending` disent `mode` (`ask` ou `auto`).

### Entraîner un LoRA avec un assistant

Dis-lui par exemple « entraîne un LoRA de Rosa sur LTX avec les images de ce dossier », en lui donnant le chemin
complet du dossier. Tu gardes la main à deux endroits :

1. **Le feu vert.** La carte dit « Il prépare un entraînement de LoRA. Tu le lanceras toi-même ensuite. » Après
   « C’est parti », Mia revient devant et le brouillon se remplit : nom, modèle, mot déclencheur, images, légendes
   (celles qu’il écrit sont marquées à son nom). Tes images et tes légendes d’origine ne sont jamais modifiées.
2. **Le lancement.** En « Je valide », l’assistant ne peut que **proposer** : une carte « Claude propose un entraînement » apparaît
   en bas de Mia, avec « Voir », « Refuser », « Plus tard » et « Lancer ». Rien ne part tant que tu n’as pas cliqué
   « Lancer ». Si le brouillon change entre-temps (par toi ou par lui), la proposition est annulée et il doit la
   refaire. Si le départ est impossible (un autre entraînement tourne, disque plein…), la carte dit pourquoi et
   reste là. Reprendre un entraînement en pause passe par la même carte, avec « Reprendre ». La carte revient
   telle quelle si Mia se recharge ou redémarre.

Pendant l’entraînement, l’assistant peut regarder où il en est, ouvrir les essais, écrire une note (une par
minute au plus), mettre en pause ou ranger un point de contrôle dans « Mes LoRA » (ces deux gestes redemandent
ton feu vert s’il a expiré : il s’éteint après 10 minutes sans appel). Il ne peut ni reprendre, ni arrêter, ni
supprimer : cela reste à toi. Quand il ne fait que regarder, la pastille « Claude pilote Mia » ne s’allume pas.

En « Auto » (« Demander mon feu vert » coupé), il n’y a ni carte ni clic : `mia_train_start` lance
directement l’entraînement, qui tient ensuite le GPU pendant des heures.

Pour l’assistant : `mia_status` donne `training` (l’entraînement actif : état, phase, pas, progression, heure de fin)
et `mia_pending` donne `training.state` (`waiting` : la carte attend ton clic ; `started` ; `declined` ; `changed` :
le brouillon a changé, la proposition est à refaire). `mia_train_wait` attend au plus 600 s (`until` : `sample`,
`checkpoint`, `end` ou `change`) ; un entraînement dure des heures, l’assistant revient plutôt plus tard avec
`mia_train_status`. Les essais sont des fichiers (chemins complets) qu’il peut ouvrir pour juger le résultat.

### Plusieurs assistants à la fois

Demande plusieurs plans d'un coup (« prépare ces deux plans LTX en parallèle ») : l'assistant lance un sous-agent par
plan, et chacun signe ses appels avec `as` (un nombre ou quelques mots). Tu vois alors un curseur de couleur par
plan (« Claude 1 », « Claude 2 », « Claude · Plan 03 »…), chacun avec sa bulle, qui travaillent en même temps, chacun
sur sa rangée de la planche. La barre de titre affiche « 3 Claude pilotent Mia » et une pastille par Claude :
**clique une pastille pour que la caméra le suive**, clique encore pour revoir tout le monde. Les calculs du PC
restent un à la fois (ils se suivent dans la file) ; les calculs en ligne partent ensemble. Sans `as`, rien ne
change : un seul curseur, comme avant.

Les erreurs reviennent en français clair (« Le bloc « Profondeur » n'a pas d'entrée « image ». Entrées : media… »).
Les arguments sont vérifiés d'après le schéma de chaque outil avant d'agir : un champ inconnu (`toPort` au lieu de
`to: {node, port}`) ou une mauvaise forme (`to` en texte) est une erreur qui liste les champs permis, jamais une
supposition qui modifierait la planche. `mia_connect` sans port nommé ne remplace jamais un fil déjà branché : il
demande de nommer l'entrée (`to.port`).

### Le bloc Modèle (un bloc par modèle)
Quand tu demandes un modèle par son nom (« fais-le avec MiniMax », « essaie Seedance »), l'assistant pose un bloc
Modèle (`type: "gen"`, `params.model` = `fam:ltx`, `fam:minimax`, `fam:pan2`, `fam:wan`, `fam:qwen`, ou `hf:…` en ligne,
payant, seulement si tu l'as demandé). Il sait, par `mia_catalog`, ce que chaque modèle fait selon ce qu'on lui
branche (`ways` : ce qu'il faut brancher, combien, quels réglages, ce qui est « à essayer ») et relie en nommant
l'entrée (`start`, `keys`, `refs`, `refAudios`, `video`, `audio`…), même celles que l'écran range derrière
« Partir de » ou « + Ajouter ». `mia_get_board` lui dit ensuite ce que fait chaque bloc Modèle (`model.does`), de
quoi il se sert (`model.uses`), ce qui manque et ce qui est ignoré ; sur un bloc encore vide, `model.startFrom`
donne les points de départ de la ligne « Partir de : » (entrée et ce qu'elle ferait). Les nouveautés « à essayer » (images-clés de LTX, son à suivre, sons de référence, 768p) sont signalées comme telles : juge le résultat à l'œil. Prolonger une vidéo et les images-clés de MiniMax
sont validés (essais du 24/10).

MiniMax a un réglage `h3mode` (« Rendu », pour animer une image et partir d'un texte) : `draft` (Esquisse, 2 étapes,
environ 3 fois plus vite), `fast` (Rapide, 4 étapes), `standard` (8 étapes, par défaut) et `pika` (le style Pika H3 Flex,
6 étapes). PAN 2 (`fam:pan2`, sans son, lent) suit de près les actions et la caméra décrites seconde par seconde : Mia
fait rédiger sa description détaillée par Qwen 3.5 à partir de la consigne (elle apparaît dans la version) ; une
consigne qui est déjà une légende JSON de PAN 2 (sept clés) est utilisée telle quelle. Essais GPU du 25/11.

Sur ce PC, le réglage `passes` des blocs LTX (`auto`, `1`, `2`, ou leurs libellés « Auto », « 1 passe »,
« 2 passes ») choisit une ou deux passes ; `auto` en fait deux dès qu'une image de fin ou des images-clés sont
branchées.

**Versions d’un modèle et mémoire** : quand un modèle du PC existe en plusieurs versions (LTX 2.5 : « Compacte »,
« Compacte · RTX 50 », « Pleine »), `mia_catalog` donne pour chaque choix de modèle `version` (dans la langue de Mia)
et `memoryGB`, la mémoire qu’il prendra à peu près sur cette machine (une estimation, qui monte avec la définition et
la durée). `machine.memoryGB` est la mémoire totale de la machine, `capabilities.<capacité>.memoryGB` celle du modèle
que « auto » lancera. Le plus simple est de laisser `"auto"` (ou `fam:ltx` sur un bloc Modèle) : « auto » garde la
version compacte (même image que la pleine d’après nos essais, moins de temps et de mémoire). `notOffered` liste les modèles que Mia reconnaît sans les
proposer, avec la raison (le modèle complet de LTX, non distillé : « sa recette de calcul n’est pas validée dans
Mia ») : ils ne sont dans aucun choix, et un bloc réglé de force sur l’un d’eux est refusé au lancement, avec la même
raison.

**Modèles en ligne (Higgsfield, payants)** : un bloc en ligne montre son **mode** à l'écran (« Auto · Texte ·
Animer · Références · Modifier »). L'assistant le choisit par `params.workflow` (l'id d'une façon de faire, ou
son libellé) : le mode choisi passe devant ce que disent les fils, le bloc dit alors ce qui lui manque
(`model.connect`) et ignore ce qui ne lui sert pas (`model.ignored`) ; `"auto"` rend le choix aux fils.
`mia_catalog` donne pour chaque mode (`ways[]`) ses propres réglages complets (bornes, choix, paliers
`onlyTiers` / `tierOptions`), les notes de la doc du fabricant (`notes`), la durée minimale d'une vidéo source
(`minSeconds`), les jetons de citation (`cite` : Kling 4.0 `@image_1`, `@video_1`… ; en montage, la vidéo à
modifier est `@video_1` et les vidéos de référence partent de `@video_2`), le tarif public (`price`) et les
champs que Mia n'envoie pas encore (`unsupported`). `mia_get_board` ajoute `model.mode`, `model.modes` (ce qui
manque à chacun), `model.accepts` (les entrées du mode au palier choisi), `model.price`, `model.cite`, et montre
les réglages `hf.*` du mode avec leurs défauts. `mia_set_params` vérifie chaque valeur selon le mode et le
palier en cours (une valeur permise seulement dans un autre mode est gardée, avec une note) et répond avec les
réglages que le bloc montre ; `mia_connect` répond `ignored: true` et une note quand le fil ne sert pas au mode
en cours (ou pas au palier choisi : image de fin en Kling 3.0 Turbo, la note donne alors le palier qui la prend). Un texte envoyé au pont dans l'encodage de la console Windows (cp1252) est relu tel quel : plus de
« � » dans les titres.

**File des calculs en ligne** : un calcul en ligne n'attend jamais la carte graphique ; plusieurs partent en même
temps, jusqu'au réglage « Calculs en ligne simultanés » (Réglages → Comptes en ligne, 4 par défaut, 16 au plus).
`mia_status` donne la file en deux voies : `engine.queue.local {running, waiting}` et `engine.queue.online
{running, waiting, atHiggsfield, max}` (`running`/`waiting` comptent toujours tout). Dans `mia_jobs`, un calcul en
ligne porte `online: true` et `remote` : `queued` (en file chez Higgsfield), `running`, ou `full` (la file
Higgsfield du compte est pleine : Mia attend le délai demandé et renvoie la même demande, avec la même clé, sans
jamais payer deux fois ; rien n'est encore créé). Annuler un calcul déjà commencé chez Higgsfield ne jette pas le
résultat payé : Mia le récupère (la note du résultat le dit).

## Sécurité

- Le pont n'écoute que `127.0.0.1` ; sans le jeton, tout est refusé ; une page web ne peut pas l'appeler.
- Aucune suppression de fichier sur le disque ; les imports n'acceptent que des fichiers qui existent ;
  rien n'est écrit hors des projets (et du dossier `models\loras\mia` quand tu ajoutes un LoRA).
- Un entraînement préparé par un assistant vit dans son propre dossier (Réglages → Entraînement) : les images y sont
  liées ou copiées, les légendes copiées, jamais les originaux modifiés ; 300 fichiers au plus par
  `mia_train_prepare`, chemins complets qui existent. L’assistant ne peut ni lancer, ni reprendre (il le propose
  seulement, sauf en « Auto » où il le fait lui-même), ni arrêter, ni supprimer un entraînement.

## En cas de souci

- « Mia ne répond pas » : une Mia d'une version sans pont est peut-être encore ouverte → ferme-la, relance-la.
- Vérifier le tout sans rien calculer : `node tools\test-bridge.js` (ouvre une Mia cachée de test, la pilote
  comme le ferait Claude, et la referme). Contre une Mia de test déjà ouverte : `MIA_BRIDGE_FILE=<son
  bridge.json> MIA_NO_LAUNCH=1 MIA_CDP_PORT=<son port CDP> node tools\test-bridge.js` (elle reste ouverte).
  Jamais contre la Mia de tous les jours : le test y créerait des planches et des projets.
