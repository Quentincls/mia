---
name: mia-piloter
description: Piloter Mia, la planche nodale d'IA vidéo/image LOCALE (app Windows), par son serveur MCP (outils mia_*) - créer projets et planches, importer des fichiers, poser, relier et régler des blocs, lancer aperçu puis rendu final, lire et montrer les résultats. À utiliser dès que l'utilisateur demande de faire quelque chose « dans Mia » (planche, projet, blocs, Animer une image, Rendre photoréaliste, Finition…) ou quand des outils mia_* sont disponibles. Pour choisir la méthode vidéo, voir mia-recettes-video ; pour modifier le code de Mia, voir mia-developper.
---

# Piloter Mia par MCP

Mia = planche nodale noire où l'on relie des fichiers à des blocs simples (« Profondeur », « Animer une image »…)
qui tournent sur le GPU du PC (ComfyUI + worker Python). **Tout ce que tu fais est visible en direct** chez
l'utilisateur : un curseur à ton nom glisse vers chaque bloc posé, relié ou réglé ; chaque action entre dans
l'historique (Ctrl+Z). Parle-lui dans **sa langue** (l'interface de Mia est en français ou en anglais) : noms de
projets, planches, blocs et messages `mia_say` courts, sans jargon (« repeinte de ton rendu », pas « IC-LoRA »).

## Vocabulaire (les noms d'outils sont historiques)

| L'utilisateur dit | C'est | Id | Outils |
|---|---|---|---|
| **planche** (board) | une toile de blocs = un onglet | `p_…` (`boardId`) | `mia_create_project` (crée), `mia_open_project` (ouvre) |
| **projet** (project) | un dossier de planches = groupe d'onglets coloré | `f_…` (`folder`) | `mia_create_folder` |

`mia_list_projects` renvoie `{folders:[…], boards:[…]}` (les projets ET les planches). Un seul niveau : pas de
projet dans un projet. Une planche peut rester hors projet (`folderId: null`). `projectId` = ancien nom de
`boardId`, encore accepté : écris `boardId`.

## Avant de commencer
1. Outils `mia_*` absents ? Mia doit être déclarée auprès de l'assistant (`~/.claude.json` → `mcpServers.mia`,
   `~/.codex/config.toml` → `[mcp_servers.mia]`), puis l'assistant relancé : voir `mcp/README.md` de Mia. Ne
   modifie pas ces fichiers sans l'accord de l'utilisateur. Secours sans MCP : voir « Sans MCP » en bas.
2. `mia_status` : fenêtre, vue (`home`/`board`), planche ouverte, ComfyUI, GPU (`busyWith`, `busyOther`), file,
   capacités installées (`capabilities`). Si Mia est fermée, le serveur MCP la lance (25 s au plus).
3. `mia_catalog` **une fois** : chaque bloc (`type`, `inputs[].port`, `outputs[].port`, `params[]` avec `kind`,
   `default`, `options`, `min/max/step`, `choices` des modèles et LoRA, `showIf`, `overriddenByInput`), les
   recettes, les capacités et ce qui manque (`missing`). `mia_catalog {type:"i2v"}` pour un seul bloc.
4. Si l'utilisateur dit qu'il utilise le GPU, ou si `busyOther` / un verrou d'un autre outil est là : **ne lance
   aucun calcul lourd** ; prépare la planche et propose de lancer plus tard.

## Déroulé type
```
mia_status
mia_list_projects
mia_catalog
mia_create_project {folder:"Mon film", name:"Plan 05"}      // projet créé s'il manque, jamais de doublon
   (ou planche existante : mia_open_project {name:"Mon film / Plan 05"})
mia_import_media {paths:["C:\\Users\\<toi>\\Videos\\plan05_lighting.mp4"]}   // chemins ABSOLUS Windows → blocs Média
mia_add_block {type:"real", near:"<id du Média>", title:"Repeinte du plan 05"}
mia_connect {from:{node:"<Média>", port:"out"}, to:{node:"<real>", port:"video"}}
mia_set_params {nodeId:"<real>", params:{prompt:"photoreal, cinematic, natural skin", keepBlacks:true}}
mia_run {nodeId:"<real>", mode:"preview"}  →  jobId
mia_wait {jobId, timeoutS:600}               // timedOut:true → rappeler mia_wait
mia_get_output {nodeId:"<real>"}             // chemins absolus, méta
mia_snapshot {nodeId:"<real>"}               // regarder ; puis montrer à l'utilisateur
mia_say {text:"Aperçu prêt : regarde le bloc « Repeinte du plan 05 »."}
… si validé : mia_run {nodeId, mode:"final"} → mia_wait …
```

## Les outils (paramètres exacts)
- `mia_create_folder {name, color?}` → `{folderId, name, color, existed, boards}`. Couleurs : grey, blue, teal,
  green, yellow, orange, red, pink. Un nom existant (casse, accents, espaces ignorés) est **repris** (`existed:true`).
- `mia_create_project {name?, folder?, color?, recipe?}` → `{boardId, name, dir, folder:{id,name,created}, blocks}`.
  `folder` = nom ou `f_…` ; `recipe` pré-remplit la planche (ids des blocs et ce qu'attendent les Média vides).
- `mia_open_project {id? | boardId? | name? | folder?}` : `"p_…"`, `"Plan 05"`, `"Mon film / Plan 05"`,
  `{folder, name}`, ou un projet seul (`f_…` / `folder`) = sa dernière planche. Plusieurs correspondances → erreur
  qui les liste.
- `mia_get_board {boardId?}` : blocs (id, type, titre, position, réglages, entrées branchées, sorties, état,
  périmé ou non, résultat courant avec chemins absolus), fils, sections.
- `mia_add_block {type, params?, title?, near?, at?}` → `{nodeId, inputs, outputs, params, notes}`. `type` = id
  du catalogue (`i2v`, `real`…) ou son nom français.
- `mia_connect {from:{node, port?}, to:{node, port?}}` → `{wireId, type, replaced}`. Port omis = premier
  compatible (entrée requise vide d'abord). Une entrée simple déjà branchée est **remplacée**.
- `mia_set_params {nodeId, params}` (une seule étape d'annulation) · `mia_rename_block {nodeId, title}` (vide =
  nom du type) · `mia_remove_blocks {nodeIds}` (aucun fichier effacé).
- `mia_import_media {paths, into?, near?}` → `{blocks:[{nodeId, kind, path, meta}]}`. Images, vidéos, sons
  (wav/mp3/m4a/aac/flac/ogg/opus). Le fichier est **copié** dans `media\` de la planche. `into` = remplir un
  Média vide (recette) ; `near` = poser à droite d'un bloc.
- `mia_insert_recipe {recipe, at?}` : recettes `unreal-to-real`, `animate-image`, `character-performance`,
  `depth-video`, `cutout-character`.
- `mia_arrange` (gauche → droite selon les fils, puis cadre tout) · `mia_add_section {nodeIds, title, tone?}`
  (tons : grey, teal, green, yellow, orange, red ; défaut = bleu d'accent) · `mia_focus {nodeIds}` (montre à
  l'utilisateur) · `mia_say {text}` (bulle 6 s, 400 caractères max, 1-2 phrases).
- `mia_run {nodeId, mode?, boardId?}` → `{jobId, mode, note?}` ; `already:true` si le bloc calcule déjà.
- `mia_wait {jobId | nodeId, timeoutS ≤ 600, boardId?}` → `state` (`done`/`error`/`cancelled`) + `run.outputs`,
  ou `timedOut:true` avec la progression. `mia_jobs` : file (état, progression, `etaS`, `waitingFor`).
  `mia_cancel {jobId}`.
- `mia_get_output {nodeId, port?}` → `outputs[{port, path, kind, meta, poster}]`, `stale`, `busy`.
- `mia_snapshot {nodeId?}` : capture PNG de la fenêtre (ou centrée sur un bloc).

## Placement et rangement
- Pose chaque bloc avec `near` = le bloc qui l'alimente : chaîne lisible de gauche à droite, jamais de
  chevauchement. `at {x,y}` = coin haut-gauche en coordonnées monde (blocs ~288-336 de large ; un pas de 432 entre
  colonnes).
- Plusieurs sources d'une entrée multiple : pose-les **de haut en bas dans l'ordre voulu** (l'ordre des fils =
  ordre vertical des blocs sources : « Image 1 », « Image 2 »…, clips d'Assembler).
- Fin de montage : `mia_arrange`, puis `mia_add_section` pour regrouper (« Sources », « Essais LTX »…).
- Organisation : **un projet par film ou sujet, une planche par plan ou idée** (« Mon film » → « Plan 01 »,
  « Plan 02 »). Quand l'utilisateur nomme un projet, crée les planches dedans (`folder`).

## Réglages : ce qui est accepté
- Les valeurs sont vérifiées contre le catalogue ; l'erreur liste les valeurs permises : lis-la et corrige.
- `select`/`seg` : la `value` (`"16:9"`, `"720"`) ou son libellé ; `slider` : nombre dans `[min,max]`, arrondi au
  pas ; `toggle` : booléen ; `frame` : numéro d'image **à partir de 0**, `-1` = dernière ; `seed` : entier.
- `model` : `"auto"` (conseillé), un `value` de `choices` (id dépendant du PC) ou le libellé (`"MiniMax H3"`).
  `lora` : `"none"`, l'id ou le nom donné par l'utilisateur (`"mon_perso"`) ; le mot déclencheur est ajouté
  **tout seul** en tête de la consigne.
- Réglage masqué par `showIf` (ex. `loraStrength` sans LoRA, `lutFile` hors `look:"file"`) : enregistré, mais
  `notes` le signale.
- `overriddenByInput:"prompt"` : un bloc **Consigne** (`text`) relié à l'entrée `prompt` remplace le champ.
- Consignes LTX : en **anglais** (« sujet + action + caméra + lumière + photoreal, cinematic »). Traduis et dis-le
  à l'utilisateur dans sa langue.

## Calculs
- Blocs de génération (`i2v`, `t2v`, `ref2v`, `real`, `guided`, `perform`) : **toujours `preview` d'abord**
  (basse définition, ~3 s), montrer, puis `final` si l'utilisateur valide. Les autres blocs n'ont pas de mode.
- `mia_run` calcule aussi l'amont périmé. Un bloc en aval prend la **version courante** de l'amont : étoile ›
  dernier rendu final › dernier aperçu ; sans version, l'amont est calculé dans le mode demandé, donc **en
  aperçu** quand le bloc lancé n'a pas de mode (Finition, Son, Exporter…). Donc : rendu final du bloc de génération
  d'abord, puis Finition / Son / Exporter. (Pas d'outil pour épingler : l'utilisateur met l'étoile.)
- Lourds (GPU, verrou partagé, un seul à la fois) : tous les blocs IA + `finish`, `composite`, `cutout`.
  Légers : `frame`, `trim`, `resize`, `sequence`, `sound`, `looks`, `export`. Un job peut attendre le GPU
  (`waiting-gpu`, `waitingFor` = qui le tient) : ne force rien, préviens l'utilisateur.
- Durées (rendu final, GPU de 24 Go) : Animer une image 5-9 min, Rendre photoréaliste ~9 min par 4 s, Vidéo
  guidée ~8 min par 4 s, Animer un personnage ~14 min par 5 s. Donne l'heure de fin prévue (« fin vers 20 h 45 »,
  depuis `etaS`) et ne reste jamais muet plus de 5 minutes.

## Regarder et montrer
- `mia_get_output` donne les chemins : ouvre les PNG ; pour une vidéo, regarde le `poster` ou extrais des images
  avec un bloc **Extraire une image** (`frame`, léger, `at` = n° d'image) à plusieurs moments.
- `mia_snapshot` pour vérifier la mise en page. Montre à l'utilisateur ce que tu as regardé, avec la liste
  honnête des défauts vus ; `mia_focus` + `mia_say` pour lui montrer le bloc dans Mia.

## Pièges
- **Les ids sont ceux de la planche ouverte** : après `mia_open_project` / `mia_create_project`, les ids d'une autre
  planche échouent (« Le bloc … n'existe pas sur la planche »). `mia_run` / `mia_wait` / `mia_get_board` acceptent
  `boardId` pour rouvrir la bonne planche.
- Chemins d'import : absolus, existants, côté Windows (`C:\\…`), 64 fichiers au plus par appel. Un dossier ou
  une URL est refusé.
- Le son (Média audio) ne va que dans le bloc **Son** (`sound.audio`).
- Recette : remplis ses Média vides avec `mia_import_media {into}`. Un Média vide sur une entrée **requise** bloque
  le calcul (« Glisse un fichier dans « … » ») ; sur une entrée facultative, il est ignoré.
- LoRA : le catalogue liste tous les LoRA, mais un LoRA LTX (`loraFor:"ltx"`) ne marche que sur les blocs LTX
  (`i2v`, `t2v`, `real`, `guided` en LTX) ; sur `perform` (Wan), `edit` (Qwen) ou avec MiniMax → erreur.
- Capacité absente (`capabilities[x] = false`, `missing`) : le bloc ne partira pas ; dis à l'utilisateur ce qui
  manque (il l'installe depuis la bibliothèque de Mia), ne télécharge rien toi-même.
- Ne déplace, renomme, vide ni supprime **jamais** ses planches ou ses blocs sans qu'il le demande ; ne retire
  que tes propres blocs.
- Un message d'erreur de Mia est clair et dit quoi faire (ports compatibles, valeurs permises) : suis-le au lieu
  de deviner.
- Nouveau type de bloc ajouté au code : le serveur MCP lit le catalogue à son démarrage → relancer l'assistant.

## Sans MCP (secours)
Le pont local de Mia : `%APPDATA%\Mia\data\bridge.json` = `{port, token, pid}` (127.0.0.1 seulement, effacé à la
fermeture). `POST http://127.0.0.1:<port>/call`, en-tête `Authorization: Bearer <token>`, corps
`{"method":"add_block","params":{…},"client":"Claude"}` → `{ok, result}` / `{ok:false, error}`. Méthode = nom
de l'outil sans `mia_` (`status`, `catalog`, `create_project`, `run`, `wait`…). Ou lancer
`node <Mia>\mcp\mia-mcp.js` comme client stdio. Mode d'emploi : `mcp/README.md` de Mia.
