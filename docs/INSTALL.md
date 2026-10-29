# Installer Mia sur un autre PC

Trois choses à installer, dans cet ordre : **Mia** (l'application), **le moteur** (Python, ComfyUI et ce qui calcule),
puis **les modèles** (les « cerveaux » qui font les images et les vidéos). Compter une heure, surtout du
téléchargement. Ensuite, tout marche sans Internet.

## Ce qu'il faut

- Windows 10 ou 11, 64 bits.
- Une carte graphique **NVIDIA** récente : 12 Go de mémoire au minimum, 24 Go conseillés (RTX 3090, 4090, 5090…),
  avec un pilote à jour (version 580 ou plus récente : NVIDIA App ou site de NVIDIA).
- De la place sur un disque : environ 1 Go pour Mia, 15 Go pour le moteur, et de 20 à 150 Go pour les modèles selon
  les blocs dont on se sert. Un disque D: rapide est idéal.
- Internet pendant l'installation.

---

## 1. Installer Mia

Deux façons, au choix :

- **L'installateur** `Mia-0.7.0-installation.exe` : double-clic, choisir le dossier, c'est tout. Mia s'installe pour
  l'utilisateur seul (pas besoin d'être administrateur), avec un raccourci sur le Bureau et dans le menu Démarrer.
- **La version portable** `Mia-0.7.0-portable.zip` : la décompresser où l'on veut (par exemple `D:\Mia`), puis lancer
  `Mia.exe`. Rien n'est installé dans Windows.

### « Windows a protégé votre ordinateur »

Au premier lancement, Windows peut afficher cet avertissement bleu (SmartScreen). Il ne dit pas que Mia est
dangereuse : il dit que Mia n'est **pas signée** par un certificat de code et qu'elle est encore peu téléchargée.
Cliquer sur **« Informations complémentaires »**, puis **« Exécuter quand même »**. Windows ne le redemande plus.

Sur certains PC récents, **Smart App Control** (Sécurité Windows → Contrôle des applications et du navigateur) est
allumé : il bloque toute application non signée, sans bouton pour passer outre. Dans ce cas :

- soit lancer Mia depuis ses sources (voir « Lancer Mia sans l'installateur » plus bas) : Smart App Control fait
  confiance à l'Electron installé par npm ;
- soit éteindre Smart App Control. Attention : une fois éteint, Windows ne permet plus de le rallumer sans
  réinstaller Windows. À ne faire qu'en connaissance de cause.

---

## 2. Installer le moteur

Au premier lancement, si Mia ne trouve pas de moteur, l'assistant **« Bienvenue dans Mia »** s'ouvre et propose :

- **Installer le moteur de Mia** : choisir un dossier au chemin court (par exemple `D:\Mia-moteur`), Mia fait le reste
  et montre où elle en est. Compter 20 à 40 minutes et environ 8 Go à télécharger ;
- **J'ai déjà un moteur** : indiquer le dossier d'un moteur de Mia déjà installé (celui qui contient `env\venv` et
  `env\ComfyUI`). Un ComfyUI ordinaire, installé autrement, sert seulement quand il est lancé sur ce PC, et pas pour
  tous les blocs (Détourer, Finition…) : mieux vaut installer le moteur de Mia ;
- **Plus tard** : Mia s'ouvre quand même ; on pourra régler le dossier du moteur dans Réglages → Moteur.

### À la main, si on préfère

Le script est livré avec Mia, dans le dossier `engine-setup` (pour Mia installée :
`%LOCALAPPDATA%\Programs\Mia\resources\app\engine-setup`). Ouvrir PowerShell dans ce dossier, puis :

```powershell
# voir ce qui va se passer, sans rien télécharger ni écrire
powershell -NoProfile -ExecutionPolicy Bypass -File install-engine.ps1 -Target "D:\Mia-moteur" -DryRun

# installer pour de vrai
powershell -NoProfile -ExecutionPolicy Bypass -File install-engine.ps1 -Target "D:\Mia-moteur"
```

`-ExecutionPolicy Bypass` autorise ce script-là, pour cette fois seulement. Aucun réglage de Windows n'est changé :
Python s'installe dans le dossier du moteur, sans s'inscrire dans le registre ni dans le PATH. Pas besoin de git ni
de droits d'administrateur.

Le script est **relançable** : s'il s'arrête (coupure Internet, PC éteint), on le relance et il reprend où il en était.
Il n'efface rien qui t'appartienne : un ComfyUI ou un nœud d'une autre version est mis de côté
(`ComfyUI.ancien-<date>`) ; seuls ses propres fichiers sont remplacés (son uv quand sa version change, les archives
une fois décompressées). Choisir un dossier au chemin court (80 caractères au plus) : au-delà, Windows refuse
certains fichiers du moteur.

Ce qu'il installe, toujours aux mêmes versions que le moteur avec lequel Mia est testée : uv (le gestionnaire
Python), Python 3.13, ComfyUI v0.39.2, PyTorch 2.14.1 pour carte NVIDIA (`versions.txt`), trois nœuds ajoutés à
ComfyUI à un commit précis (`custom_nodes.txt` : profondeur, LTX, agrandissement), les bibliothèques du calcul de Mia
(`requirements-mia.txt`), et chaque autre paquet Python à la version relevée sur le moteur de test
(`constraints.txt`).

Le dossier du moteur ressemble ensuite à ceci :

```
D:\Mia-moteur\
  env\venv\          le Python de Mia et de ComfyUI
  env\ComfyUI\       ComfyUI et ses nœuds ajoutés
  models\            les modèles (étape 3)
  runtime\           fichiers d'échange de ComfyUI
  mia-engine.json    versions installées
```

Enfin, dans Mia : **Réglages → Moteur → Dossier du moteur** → `D:\Mia-moteur` (l'assistant le fait tout seul).

---

## 3. Installer les modèles

Dans Mia, ouvrir la **bibliothèque des modèles** (bouton « Modèles » en haut à droite). Chaque capacité qui manque
(« Animer une image », « Retoucher une image », « Profondeur »…) affiche un bouton **« Installer »** avec sa taille.
Les téléchargements se font un par un, reprennent là où ils se sont arrêtés, et peuvent être mis en pause. Un bloc
dont le modèle manque mène directement à la bonne ligne de la bibliothèque.

Quelques ordres de grandeur : la vidéo (LTX 2.5, pour « Animer une image », « Vidéo depuis un texte », « Rendre
photoréaliste ») pèse environ 40 Go ; la retouche d'image (Qwen) environ 31 Go ; la profondeur moins de 1 Go. La
bibliothèque affiche la taille exacte avant de télécharger.

### Modèles à licence à accepter

Certains modèles (LTX notamment) demandent d'accepter leur licence sur **Hugging Face** avant de les télécharger :

1. créer un compte gratuit sur huggingface.co ;
2. ouvrir la page du modèle (Mia donne le lien) et accepter la licence ;
3. créer un jeton d'accès (Settings → Access Tokens, type « Read ») ;
4. dans PowerShell : `D:\Mia-moteur\env\venv\Scripts\hf.exe auth login`, puis coller le jeton.

Mia lit ce jeton au moment de télécharger ; elle ne le garde jamais.

---

## 4. Premier essai

Accueil → **Commencer avec une recette** → « Animer une image » → glisser une image dans le bloc Média → écrire la
consigne → **Aperçu**. Le premier calcul charge les modèles : il est plus long que les suivants.

---

## Assistants (Claude, Codex)

Claude ou Codex peuvent piloter Mia sous tes yeux : créer la planche, poser et relier les blocs, lancer le calcul.
Il suffit de leur ajouter Mia **une seule fois** ; **Réglages → Assistants** donne ce qu'il faut, avec les bons
chemins pour ce PC, et dit à quel assistant Mia est déjà ajoutée :

- **Claude Code** : une commande à coller dans un terminal (`claude mcp add mia …`) ;
- **Codex** : un bloc `[mcp_servers.mia]` à coller à la fin de `config.toml`, dans le dossier `.codex` du dossier
  personnel.

Rien d'autre à installer : le petit serveur qui fait le lien (`mcp\mia-mcp.js`) tourne avec `Mia.exe` lui-même
(variable `ELECTRON_RUN_AS_NODE=1`, déjà dans la commande et le bloc). Ensuite, l'assistant trouve Mia sous le nom
« mia » et l'ouvre si elle est fermée. Tout reste sur ce PC. Détails : `mcp\README.md`.

---

## Lancer Mia sans l'installateur

Pour les développeurs, ou si Windows bloque `Mia.exe` :

1. installer [Node.js](https://nodejs.org) 22 ou plus récent ;
2. récupérer les sources de Mia, puis dans leur dossier : `npm install` ;
3. lancer `npm start`, ou double-cliquer sur `Mia.vbs` (lancement silencieux, sans fenêtre noire).

## Fabriquer l'installateur (pour qui distribue Mia)

`npm run dist` fabrique les deux dans `release\` (installateur et zip portable), `npm run dist:zip` le zip seul,
`npm run dist:dir` le dossier `release\win-unpacked` seul. Avant chacun, `tools\check-package.js` vérifie le paquet
(fichiers de l'interface présents, LICENSE et NOTICE, aucun fichier vide, aucun chemin personnel, résumé « En bref » /
« In short » de la version dans CHANGELOG.md) et refuse de continuer s'il manque quelque chose ; il écrit ensuite
`build-info.json` (version, commit, date) dans le paquet. On peut le lancer seul : `npm run check:package`.

Si electron-builder échoue sur des « liens symboliques » en préparant ses outils de signature, activer le **Mode
développeur** de Windows (Paramètres → Système → Espace développeurs) ou lancer la commande en administrateur ;
`npm run dist:zip` suffit en attendant.

Pour une publication (GitHub Releases…), joindre seulement `Mia-<version>-installation.exe` et
`Mia-<version>-portable.zip` : jamais `builder-debug.yml` (il contient des chemins de la machine de fabrication) ni
les fichiers `.blockmap`.

### Signer Mia

Pour que les avertissements de Windows disparaissent, il faut signer `Mia.exe` et l'installateur avec un
**certificat de signature de code** :

- un certificat acheté à une autorité reconnue (Certum propose une offre pour les projets open source ; Sectigo,
  DigiCert, SSL.com…), ou le service **Azure Trusted Signing** de Microsoft (abonnement mensuel) ;
- electron-builder signe tout seul pendant `npm run dist` quand les variables `CSC_LINK` (le fichier .pfx) et
  `CSC_KEY_PASSWORD` sont définies, ou avec `win.azureSignOptions` dans `package.json` pour Azure ;
- une application signée passe Smart App Control. SmartScreen, lui, se fie aussi à la **réputation** : même signée,
  une nouvelle version peut encore être signalée pendant quelque temps, le temps que les téléchargements s'accumulent.

---

## Où sont les choses

| Quoi | Où |
|---|---|
| Mia | le dossier d'installation (par défaut `%LOCALAPPDATA%\Programs\Mia`), ou le dossier du zip |
| Réglages, journaux, registre des LoRA | `%APPDATA%\Mia\data` |
| Planches et projets | `D:\Mia\Projets` si le disque D: existe, sinon `Documents\Mia Projets` (Réglages → Dossiers) |
| Moteur et modèles | le dossier choisi à l'étape 2 |

## Mettre à jour, désinstaller

- **Mettre à jour** : installer la nouvelle version par-dessus (même dossier), ou décompresser le nouveau zip à la
  place de l'ancien. Planches, projets et réglages sont gardés ; s'il faut changer leur format, Mia le fait seule à
  l'ouverture et garde une copie de l'ancien fichier (`graph.json.bak-v0`…). Au premier lancement, un message
  « Nouveautés » résume les changements (aussi dans Réglages → À propos).
- **Revenir à une version plus ancienne** : possible, mais une planche enregistrée par une version plus récente
  s'ouvre en lecture seule, pour ne rien abîmer.
- **Désinstaller** : Paramètres Windows → Applications → Mia ; pour la version portable, supprimer son dossier.
  Dans les deux cas, les réglages (`%APPDATA%\Mia`), les planches et projets (le dossier des projets) et le moteur
  restent sur le disque : les supprimer à la main pour tout effacer, en particulier le dossier du moteur pour
  récupérer la place des modèles.
