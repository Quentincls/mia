---
name: mia-developper
description: Faire évoluer le code de Mia (planche nodale d'IA locale, Electron 38, modules ES sans framework) sans rien casser - où lire l'architecture (docs/ARCHITECTURE.md, CONTRIBUTING.md), carte du code, ajouter un bloc ou un outil MCP, règles non négociables (aucune dépendance, FR+EN, rien de Windows visible, sobriété), tests tools/*, instance cachée isolée pilotée en CDP, et surtout ne jamais recharger la fenêtre de l'utilisateur ni toucher ses données. À utiliser pour toute modification de code, de catalogue de blocs, d'executor, du worker Python ou du serveur MCP de Mia ; pas pour s'en servir (voir mia-piloter).
---

# Développer Mia sans casser

`<Mia>` = dossier des sources de l'app (le clone du dépôt) ; `<moteur>` = dossier du moteur IA
(`prefs.engineRoot` : ComfyUI, Python, modèles), **lecture seule** pour toi ; les planches de l'utilisateur
(`prefs.projectsRoot`) et ses données (`%APPDATA%\Mia`) sont aussi en **lecture seule**.

## Lire d'abord (dans cet ordre)
1. `docs/ARCHITECTURE.md` : principes, carte des fichiers, pont `window.mia`, formats sur disque (`graph.json`,
   `run.json`, `project.json`, `folder.json`), catalogue, moteur, modèles et LoRA, interface, assistants,
   versions et migrations, tests.
2. `CONTRIBUTING.md` : règles du code, instance de test, contrôles avant une modification.
3. `README.md` (ce que voit l'utilisateur), `CHANGELOG.md` (ce qui a changé), `mcp/README.md` (pont des
   assistants), `src/catalog/nodes.json` (les blocs).
4. Copie de travail de l'auteur seulement (absents du dépôt public) : `HANDOFF.md`, `_plan/ETAT.md`,
   `_plan/SPEC.md`, `_plan/da.md`. S'ils existent, lis-les **en entier** : ils décrivent le chantier en cours et
   priment sur cette fiche.

## Carte du code
- `electron/` (principal, **CommonJS**) : `main.js` (fenêtre, `mia://`, IPC), `preload.js` (`window.mia`),
  `store.js` (prefs, index, planches, projets, `withIndex()`), `media.js`, `ffmpeg.js` (pas de ffprobe :
  `ffmpeg -i`), `scanner.js` + `scanner-rules.js` (modèles, LoRA), `installer.js` (téléchargements de modèles),
  `bridge.js` (pont HTTP local), `version.js`, `migrations.js`, `engine/index.js` (file, verrou GPU, empreintes,
  `run.json`), `engine/comfy.js`, `pyrun.js`, `gpulock.js`, `patch.js`, `validate.js`, `engine/workflows/*.json`,
  `engine/executors/<executor>.js`.
- `python/` : `mia_worker.py <tâche> <job.json>`, `mia_common.py`, `tasks/*.py` (protocole `@mia {json}` sur
  stdout), `vendor/tool/` (copies figées des modules importés par les tâches).
- `src/` (interface, **modules ES natifs**, aucun bundler) : `js/app.js bus.js state.js i18n.js icons.js util.js`,
  `js/ui/*` (chrome, onglets, accueil, menus, modales, bibliothèque, accueil du premier lancement, présence des
  assistants), `js/graph/*` (éditeur, fils, sections, palette), `js/nodes/*` (corps des blocs, lecteur, versions,
  `runs.js`), `css/*` (`tokens.css` : couleurs, durées, courbes).
- `src/catalog/nodes.json` = **source de vérité des blocs** ; `recipes/*.json` + `index.json` ;
  `models-manifest.json` (fichiers à télécharger par capacité) ; glyphes des blocs dans `src/js/catalog.js`.
  `mcp/mia-mcp.js` (serveur MCP stdio sans dépendance). `luts/` (looks de la Finition). `engine-setup/` (script
  d'installation du moteur).

## Ajouter ou changer un bloc
1. `nodes.json` : `id`, `category`, `icon`, `width`, `label{fr,en}`, `desc{fr,en}`, `inputs`/`outputs` (types
   `image` `video` `media` `audio` `text`, `follow:<entrée>`, `required`, `multi` + `max`), `params` (`kind` :
   `model` `select` `seg` `slider` `toggle` `prompt` `text` `seed` `frame` `file` ; `advanced`, `hint`, `showIf`,
   `port`), `modes:["preview","final"]` pour une génération, `engine:{executor, gpu:"heavy"|"light"|"none"}`,
   `estimate`.
2. `electron/engine/executors/<executor>.js` : `module.exports = { run: async (x) => ({ outputs, model?, notes? }),
   estimate? }` ; sorties **dans** `x.outDir` ; `x.progress`, `x.signal` (annulation), `x.model(key)`,
   `x.ensureLora(key)`, `x.comfy`, `x.py`, `x.ffmpeg`. Tout calcul CUDA = `gpu:"heavy"` (prend le verrou).
3. Graphe ComfyUI : un fichier de `engine/workflows/` (format API), décrit dans `workflows/index.json` (source,
   changements, nœuds réglés) ; un graphe tiré d'un exemple publié garde sa licence (voir `NOTICE`). Ne nommer que
   des modèles présents (le nœud SeedVR2 « (Down)Load » télécharge sinon ; VDA **Small** seulement ; nœuds
   partner/cloud interdits). `node tools/validate-workflows.js` doit rester vert.
4. Interface : chaînes via `register({fr,en})` du module, glyphe dans `catalog.js` (trait fin, jamais
   d'étincelles « IA »), réglage nouveau → `src/js/nodes/params.js`.
5. MCP : le serveur relit `nodes.json` à son démarrage (descriptions, `enum` des types) ; la validation des
   réglages est dans `src/js/ui/presence.js` (`coerce`, `hiddenNotes`) : un nouveau `kind` ou une nouvelle forme
   de `showIf` s'y gère aussi. Un **nouvel outil MCP** touche trois endroits : `TOOLS` de `mcp/mia-mcp.js`,
   `RELAYED`/`dispatch` de `electron/bridge.js`, `METHODS` de `presence.js` ; plus `mcp/README.md`.
6. Tests du bloc (voir plus bas), syntaxe, puis note dans `CHANGELOG.md` (Ajouté / Changé / Corrigé, en français).

## Règles non négociables
- **Aucune dépendance npm** (Electron 38 seul ; seule exception : `electron-builder` en devDependency pour le
  paquet). Pas de framework, pas de TypeScript, pas de bundler.
- **FR + EN par i18n** : aucun libellé en dur, `tn()` pour les pluriels, vocabulaire « bloc », « planche »,
  « projet », « Modèle » (choix du modèle) ; aucun jargon visible hors « Avancé ».
- **Rien de Windows visible** : pas de `title=`, pas de `<select>`, pas de menu ni de boîte de dialogue natifs
  (sélecteur de fichiers en secours seulement) ; contrôles maison de `ui/controls.js`.
- **Sobriété** : aucun halo, aucune lueur, aucun dégradé décoratif, **un seul accent** (`#4d82f3` sombre /
  `#3b6fe0` clair) pour sélection, calcul en cours, action primaire ; petites étiquettes en Cascadia Mono
  majuscules.
- **Mouvement** : seulement `transform`/`opacity`, durées et courbes des tokens `--dur-*` / `--ease-*`,
  `prefers-reduced-motion` respecté, aucune boucle hors calcul en cours, 60 i/s avec 100 blocs.
- Planche : un bloc ne change jamais de taille avec le zoom ; **pas de repères d'alignement ni d'aimant** (grille
  seulement si activée) ; les fils tombent pile sur les pastilles (`tools/check-wires.mjs`).
- Moteur : un seul calcul lourd à la fois, toujours sous verrou `<moteur>\runtime\gpu.lock` ; jamais `POST
  /interrupt` sans `prompt_id`, jamais `/free` si un autre calcule, jamais arrêter un ComfyUI que Mia n'a pas
  lancé, jamais un 2e ComfyUI ; le traitement vidéo passe par le GPU (`h264_nvenc` s'il existe).
- Moteur en lecture seule, sauf `runtime\gpu.lock`, `models\loras\mia\` (LoRA ajoutés par l'utilisateur) et les
  fichiers temporaires de Mia dans `runtime\input|output\mia\`. Jamais `pip install` ; aucun réseau hors
  `127.0.0.1`, sauf les téléchargements de modèles lancés par l'utilisateur (`installer.js`, testé contre un faux
  serveur local).
- Données : `graph.json` illisible jamais écrasé (on tente `.bak`) ; prefs écrites par **fusion** (patch) ;
  chemins de `run.json` relatifs à la planche, séparateur `/` ; formats versionnés, migrés sans perte
  (`electron/migrations.js`).

## Tester sans casser
- **Instance cachée isolée**, jamais celle de l'utilisateur :
  ```
  MIA_HEADLESS=1 MIA_NO_GPU=1 MIA_USERDATA=<brouillon>\ud MIA_PROJECTS_ROOT=<brouillon>\projects
  <Mia>\node_modules\electron\dist\electron.exe <Mia> --remote-debugging-port=<port libre>
  ```
  (en tâche de fond ; syntaxe Git Bash, en PowerShell `$env:MIA_HEADLESS='1'` etc.). `MIA_NO_GPU=1` bloque tout
  calcul lourd, même un amont relancé par ricochet. Autres : `MIA_SKIP_MODULES=scanner,engine,bridge`,
  `MIA_DEVICE=cpu`, `MIA_NO_NVENC=1` (worker Python), `MIA_ENGINE_ROOT`.
- Pilotage CDP : `window.__mia` expose `state`, `bus`, `app`, `editor` ; prends des captures et **regarde-les**.
- MCP contre l'instance de test : `MIA_BRIDGE_FILE=<ud>\data\bridge.json MIA_NO_LAUNCH=1 node mcp\mia-mcp.js`.
- Besoin de vraies planches ? **Copie**-les dans ton dossier de brouillon ; ne travaille jamais sur l'original.
- Fermer : seulement **ton** PID (`netstat -ano | findstr :<port>`). **Jamais `taskkill /IM electron.exe`** : il
  fermerait aussi la Mia de l'utilisateur et toute autre app Electron.
- Bancs d'essai (aucun GPU) : `node tools/test-engine.js` · `node tools/test-scanner.js` ·
  `node tools/validate-workflows.js` · `node tools/test-light-executors.js [--only=sound,finish…]` ·
  `node tools/test-bridge.js` (ouvre sa propre Mia cachée ; jamais contre la Mia de tous les jours) ·
  `node tools/test-migrations.js` · `node tools/test-installer.js` · `node tools/check-wires.mjs <port CDP> --all`
  · `node tools/privacy-audit.js` (rien de personnel dans ce qui partirait sur le dépôt).
- Un **vrai calcul GPU** de test : seulement avec l'accord de l'utilisateur, GPU libre, verrou vérifié.
- Syntaxe de chaque fichier touché : `node --check <fichier.js>` (CommonJS) ; module ES :
  `node --experimental-vm-modules -e "const vm=require('vm');new vm.SourceTextModule(require('fs').readFileSync(process.argv[1],'utf8'))" <fichier>`.

## La fenêtre de l'utilisateur est sacrée
- Ne **jamais** recharger sa fenêtre (pas de changement de langue, pas de `app.reload`, pas de redémarrage)
  pendant qu'il l'utilise ou qu'un assistant pilote Mia (voir `<moteur>\runtime\gpu.lock` et la file de Mia). Le
  code sur le disque ne prend effet qu'au prochain démarrage : c'est voulu.
- Garde le code **cohérent à tout moment** : pas de module à moitié modifié qu'un redémarrage de Mia pourrait
  charger (une fenêtre rouverte en plein chantier peut casser une planche).
- Redémarrer sa Mia : une seule fois, en le prévenant, quand plus personne ne s'en sert.
- Aucun calcul GPU de test quand il dit utiliser le GPU.

## Travailler à plusieurs
- N'écris que **tes** fichiers (la liste donnée par le coordinateur) ; brouillons et essais dans un dossier à toi
  (par exemple `<Mia>\_dev\<toi>\`, ignoré par git). Toute divergence avec l'architecture : la justifier.
- Compte rendu court : fait, testé comment, reste à faire, fichiers touchés.
- Jamais de commit ni de push sans demande ; versions SemVer (`package.json`) + `CHANGELOG.md` en français.

## Pièges connus
- `showIf` : `{param, eq | ne | in | notIn}`, évalué à trois endroits qui doivent rester d'accord :
  `showIfOk` (`src/js/nodes/params.js`), `shownParam` (`engine/index.js`), `hiddenNotes` (`presence.js`, qui ne
  gère encore que `in`/`notIn`).
- La version courante d'un bloc (étoile › dernier final › dernier aperçu) est calculée à deux endroits
  (`engine/index.js` et `src/js/nodes/runs.js`) : changer l'une = changer l'autre.
- Un `import` vide sur une entrée facultative est ignoré ; sur une entrée requise, message « Glisse un fichier dans
  « … » ».
- Windows : `PYTHONUTF8=1` pour ComfyUI et Python ; `windowsHide` sur chaque processus ; annuler un worker =
  fichier `cancel` puis `taskkill /PID <pid> /T /F`.
- Une entrée `multi` reçoit ses fils dans l'ordre vertical des blocs sources (y).
- Ports : `image→image|media`, `video→video|media`, `text→text`, `audio→audio` (le son ne va que dans Son).
