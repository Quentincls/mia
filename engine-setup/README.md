# engine-setup — le moteur de Mia

`install-engine.ps1` installe dans un dossier au choix le moteur avec lequel Mia est testée : uv, Python, ComfyUI à
une version figée, PyTorch pour carte NVIDIA, les nœuds ajoutés et les dépendances du calcul de Mia. Relançable, sans
git ni droits d'administrateur, sans rien changer aux réglages de Windows (Python n'est pas inscrit dans le
registre) ; `-DryRun` montre tout sans rien télécharger ni écrire.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install-engine.ps1 -Target "D:\Mia-moteur" -DryRun
```

Choisir un dossier au chemin court (80 caractères au plus) : au-delà, Windows refuse certains fichiers du moteur.

| Fichier | Rôle |
|---|---|
| `versions.txt` | versions figées (Python, uv, ComfyUI, torch, torchvision, torchaudio et leur index CUDA, pilote minimal, place libre) |
| `custom_nodes.txt` | nœuds ComfyUI ajoutés, chacun à un commit précis (téléchargés en zip) |
| `requirements-mia.txt` | bibliothèques du worker Python de Mia (`python\mia_worker.py`) |
| `constraints.txt` | version exacte de tous les autres paquets Python, relevée sur le moteur de test ; passée à chaque `uv pip install -c` (sauf PyTorch, qui vient de son index CUDA) |

Mettre à jour `constraints.txt` : `uv pip freeze --python <moteur>\env\venv\Scripts\python.exe`, retirer les lignes
`torch`, `torchvision` et `torchaudio`, garder l'en-tête. Vérifier que tout se résout, sans rien installer :

```powershell
<moteur>\env\uv\uv.exe pip install --dry-run --python <moteur>\env\venv\Scripts\python.exe -c constraints.txt `
  -r <moteur>\env\ComfyUI\requirements.txt -r requirements-mia.txt
```

Pour l'assistant de premier lancement, chaque étape écrit aussi une ligne `@mia {json}` sur la sortie :
`{"step":3,"steps":11,"label":"…","p":0.18,"dryRun":false}`, puis `{"done":true,"engineRoot":"…"}` ou
`{"error":"…"}` (code de sortie 1). Le reste est le journal lisible, en français.

Essais : `-DryRun` complet ; installation réelle des étapes 1 à 6 (uv, Python sans registre, environnement, ComfyUI)
lancée comme le fait Mia ; résolution de toutes les dépendances avec `constraints.txt` (111 paquets, tous aux
versions du moteur de test). L'installation complète (PyTorch, environ 8 Go) reste à faire une fois sur un PC
propre avant d'annoncer une version.

Pas à pas pour quelqu'un qui découvre : [`docs/INSTALL.md`](../docs/INSTALL.md).
