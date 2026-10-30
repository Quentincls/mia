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
| `mia_status` | Mia ouverte ? planche affichée (et son projet), moteur ComfyUI, GPU, file de calcul, capacités installées |
| `mia_catalog` | tous les blocs (« Profondeur », « Animer une image »…), leurs entrées/sorties, réglages et valeurs permises, recettes, modèles, LoRA |
| `mia_list_projects` | tes projets et toutes les planches (avec le projet de chacune) |
| `mia_create_folder` | créer un projet (dossier de planches), avec sa couleur ; s'il existe déjà, il est repris tel quel |
| `mia_create_project` | créer une planche (nouvel onglet), dans un projet (`folder`, créé s'il manque), avec une recette au besoin |
| `mia_open_project` | ouvrir une planche : par son nom, « Projet / Planche », ou la dernière d'un projet |
| `mia_get_board` | la planche : blocs, réglages, fils, états, résultats avec leurs chemins complets |
| `mia_add_block` | poser un bloc (à droite du bloc qui l'alimente, jamais par-dessus un autre) |
| `mia_connect` | relier deux blocs (port deviné s'il n'est pas donné) |
| `mia_set_params` · `mia_rename_block` | régler un bloc (valeurs vérifiées), lui donner un titre |
| `mia_remove_blocks` | retirer des blocs de la planche (aucun fichier effacé, Ctrl+Z possible) |
| `mia_import_media` | importer des images/vidéos par leur chemin complet (`D:\…\plan12.mp4`) |
| `mia_insert_recipe` · `mia_arrange` | poser une recette ; ranger la planche de gauche à droite |
| `mia_run` · `mia_wait` · `mia_jobs` · `mia_cancel` | lancer (aperçu d'abord ; `variants: 4` = le bouton « 4 variantes » d'un bloc image du PC ; sur une Consigne « Réécrire en anglais », la réécriture seule), attendre la fin, voir la file, annuler |
| `mia_get_output` · `mia_snapshot` | les fichiers du résultat ; une capture de Mia pour que l'assistant regarde |
| `mia_add_section` | encadrer des blocs dans une section nommée, à la manière de Figma ou Miro |
| `mia_focus` · `mia_say` | te montrer des blocs ; t'écrire un mot dans une bulle |

Les erreurs reviennent en français clair (« Le bloc « Profondeur » n'a pas d'entrée « image ». Entrées : media… »).
Les arguments sont vérifiés d'après le schéma de chaque outil avant d'agir : un champ inconnu (`toPort` au lieu de
`to: {node, port}`) ou une mauvaise forme (`to` en texte) est une erreur qui liste les champs permis, jamais une
supposition qui modifierait la planche. `mia_connect` sans port nommé ne remplace jamais un fil déjà branché : il
demande de nommer l'entrée (`to.port`).

### Le bloc Modèle (un bloc par modèle)
Quand tu demandes un modèle par son nom (« fais-le avec MiniMax », « essaie Seedance »), l'assistant pose un bloc
Modèle (`type: "gen"`, `params.model` = `fam:ltx`, `fam:minimax`, `fam:wan`, `fam:qwen`, ou `hf:…` en ligne,
payant, seulement si tu l'as demandé). Il sait, par `mia_catalog`, ce que chaque modèle fait selon ce qu'on lui
branche (`ways` : ce qu'il faut brancher, combien, quels réglages, ce qui est « à essayer ») et relie en nommant
l'entrée (`start`, `keys`, `refs`, `refAudios`, `video`, `audio`…), même celles que l'écran range derrière
« Partir de » ou « + Ajouter ». `mia_get_board` lui dit ensuite ce que fait chaque bloc Modèle (`model.does`), de
quoi il se sert (`model.uses`), ce qui manque et ce qui est ignoré ; sur un bloc encore vide, `model.startFrom`
donne les points de départ de la ligne « Partir de : » (entrée et ce qu'elle ferait). Les nouveautés « à essayer » (images-clés de LTX, son à suivre, sons de référence, 768p) sont signalées comme telles : juge le résultat à l'œil. Prolonger une vidéo et les images-clés de MiniMax
sont validés (essais du 24/10).

Sur ce PC, le réglage `passes` des blocs LTX (`auto`, `1`, `2`, ou leurs libellés « Auto », « 1 passe »,
« 2 passes ») choisit une ou deux passes ; `auto` en fait deux dès qu'une image de fin ou des images-clés sont
branchées.

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

## En cas de souci

- « Mia ne répond pas » : une Mia d'une version sans pont est peut-être encore ouverte → ferme-la, relance-la.
- Vérifier le tout sans rien calculer : `node tools\test-bridge.js` (ouvre une Mia cachée de test, la pilote
  comme le ferait Claude, et la referme). Contre une Mia de test déjà ouverte : `MIA_BRIDGE_FILE=<son
  bridge.json> MIA_NO_LAUNCH=1 MIA_CDP_PORT=<son port CDP> node tools\test-bridge.js` (elle reste ouverte).
  Jamais contre la Mia de tous les jours : le test y créerait des planches et des projets.
