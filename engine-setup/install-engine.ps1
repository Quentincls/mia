<#
.SYNOPSIS
  Installe le moteur de calcul de Mia dans un dossier au choix : Python, ComfyUI à une version figée, PyTorch pour
  carte NVIDIA, les nœuds ajoutés et les dépendances du calcul de Mia.

.DESCRIPTION
  Adapté de setup\install_windows.ps1 du labo (17/10/2026). Même moteur, même organisation, pour que Mia le trouve
  tel quel (Réglages → Dossier du moteur) :

      <dossier>\env\uv\uv.exe          gestionnaire Python (uv), si uv n'est pas déjà installé
      <dossier>\env\python\            Python, installé par uv
      <dossier>\env\venv\              l'environnement virtuel (python.exe de Mia et de ComfyUI)
      <dossier>\env\ComfyUI\           ComfyUI à la version figée, et ses nœuds ajoutés (custom_nodes)
      <dossier>\models\                les modèles (installés ensuite depuis Mia : Bibliothèque → Installer)
      <dossier>\runtime\input|output\  fichiers d'échange de ComfyUI
      <dossier>\config\comfy_user\     réglages de ComfyUI
      <dossier>\mia-engine.json        fiche du moteur (versions, date)

  Relançable sans risque : une étape déjà faite est sautée ; une étape interrompue reprend. Un ComfyUI ou un nœud
  d'une autre version est mis de côté (ComfyUI.ancien-<date>), pas effacé ; seuls les fichiers du script lui-même
  sont remplacés (son uv quand sa version change, les archives une fois décompressées).
  Versions toujours identiques : versions.txt (Python, uv, ComfyUI, PyTorch), custom_nodes.txt (un commit par
  nœud) et constraints.txt (tous les autres paquets Python, passés à chaque « uv pip install -c »).
  Aucun réglage de Windows n'est changé : Python est installé dans le dossier du moteur, sans inscription dans le
  registre (--no-registry). Pas besoin de git ni de droits d'administrateur. Il faut Internet (environ 8 Go à
  télécharger) et une carte graphique NVIDIA récente pour calculer.

  Chaque étape écrit aussi une ligne « @mia {json} » (étape, total, libellé, progression ; puis done ou error), lue
  par l'assistant de premier lancement de Mia ; le reste est le journal lisible.

.PARAMETER Target
  Dossier du moteur (créé s'il n'existe pas). Par défaut : D:\Mia-moteur si le disque D: existe, sinon
  <dossier de l'utilisateur>\Mia-moteur. Choisir un disque avec de la place : les modèles pèsent 20 à 150 Go.

.PARAMETER DryRun
  Montre chaque étape, les adresses et les commandes, vérifie la machine, mais ne télécharge, n'installe et
  n'écrit rien.

.PARAMETER SkipGpuCheck
  Continue même sans carte NVIDIA détectée (le moteur s'installe, mais les calculs seront impossibles ou très lents).

.PARAMETER Lang
  Langue des étapes, des messages et du journal : fr (par défaut) ou en. Mia passe la sienne.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install-engine.ps1 -Target "D:\Mia-moteur" -DryRun

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install-engine.ps1 -Target "D:\Mia-moteur"
#>
[CmdletBinding()]
param(
    [string]$Target = "",
    [switch]$DryRun,
    [switch]$SkipGpuCheck,
    [string]$Lang = "fr"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"          # la barre de progression de PowerShell 5.1 ralentit tout
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$SetupVersion = "0.5.0"
if ($Lang -ne "en") { $Lang = "fr" }
# Texte dans la langue choisie (-Lang) : T "français" "english"
function T([string]$fr, [string]$en) { if ($Lang -eq "en") { return $en } return $fr }
$Here = $PSScriptRoot
$Sys32 = Join-Path $env:SystemRoot "System32"
$Curl = Join-Path $Sys32 "curl.exe"               # ceux de Windows (pas ceux de Git, dont le tar ne lit pas les zip)
$Tar = Join-Path $Sys32 "tar.exe"

# ------------------------------------------------------------------------------------------------- journal
function Out-Line([string]$s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }

function ConvertTo-AsciiJson($obj) {
    # JSON sur une ligne, caractères non ASCII échappés (\u00e9) : lisible quel que soit l'encodage de la console
    $j = ConvertTo-Json -InputObject $obj -Compress -Depth 6
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $j.ToCharArray()) {
        if ([int]$ch -gt 127) { [void]$sb.AppendFormat('\u{0:x4}', [int]$ch) } else { [void]$sb.Append($ch) }
    }
    $sb.ToString()
}

function Emit($obj) { Out-Line ("@mia " + (ConvertTo-AsciiJson $obj)) }

$script:StepNo = 0
$Steps = 11
function Step([string]$label) {
    $script:StepNo++
    Out-Line ""
    Out-Line ("[{0}/{1}] {2}" -f $script:StepNo, $Steps, $label)
    Emit ([ordered]@{ step = $script:StepNo; steps = $Steps; label = $label; p = [math]::Round(($script:StepNo - 1) / $Steps, 3); dryRun = [bool]$DryRun })
}
function Info([string]$s) { Out-Line ("    " + $s) }
function Plan([string]$s) { Out-Line ("    " + (T "(à blanc) " "(dry run) ") + $s) }

function Fail([string]$msg, [int]$code = 1) {
    Out-Line ""
    Out-Line ((T "ÉCHEC : " "FAILED: ") + $msg)
    Emit ([ordered]@{ error = $msg; step = $script:StepNo; steps = $Steps })
    exit $code
}

# Lance un programme ; en cas d'échec, message clair et arrêt. En mode à blanc, montre seulement la commande.
function Run([string]$exe, [string[]]$arguments, [string]$what) {
    $shown = ($arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
    if ($DryRun) { Plan ("> " + [IO.Path]::GetFileName($exe) + " " + $shown); return }
    Info ("> " + [IO.Path]::GetFileName($exe) + " " + $shown)
    & $exe @arguments
    if ($LASTEXITCODE -ne 0) { Fail ((T "{0} (code {1}). Relance le script : il reprend où il s’est arrêté." "{0} (code {1}). Run the script again: it resumes where it stopped.") -f $what, $LASTEXITCODE) }
}

# Lit la réponse d'un programme (sa version…) sans jamais arrêter le script : sous $ErrorActionPreference = "Stop",
# Windows PowerShell 5.1 change en erreur fatale toute ligne qu'un programme écrit sur stderr dès qu'on la redirige
# (2>$null). Ici la redirection se fait sous « Continue », et un échec rend une liste vide.
function Quiet([string]$exe, [string[]]$arguments) {
    $ErrorActionPreference = "Continue"
    try { @(& $exe @arguments 2>$null | ForEach-Object { "$_" }) } catch { @() }
}

function Download([string]$url, [string]$dst) {
    if ($DryRun) { Plan ((T "télécharger " "download ") + $url); return }
    Info ((T "téléchargement : " "downloading: ") + $url)
    $part = $dst + ".part"
    if (Test-Path $Curl) {
        & $Curl -L --fail --retry 4 --retry-delay 3 --silent --show-error -o $part $url
        if ($LASTEXITCODE -ne 0) { Fail ((T "Téléchargement impossible : {0} (code {1}). Vérifie la connexion, puis relance." "Download failed: {0} (code {1}). Check the connection, then run again.") -f $url, $LASTEXITCODE) }
    } else {
        try { Invoke-WebRequest -Uri $url -OutFile $part -UseBasicParsing } catch { Fail ((T "Téléchargement impossible : {0} ({1})." "Download failed: {0} ({1}).") -f $url, $_.Exception.Message) }
    }
    Move-Item -LiteralPath $part -Destination $dst -Force
}

# Décompresse un zip GitHub (un seul dossier racine) dans $dest (qui ne doit pas exister).
function Expand-Single([string]$zip, [string]$dest) {
    if ($DryRun) { Plan ((T "décompresser dans " "unzip into ") + $dest); return }
    $tmp = $dest + ".tmp-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
    New-Item -ItemType Directory -Force $tmp | Out-Null
    if (Test-Path $Tar) {
        & $Tar -xf $zip -C $tmp
        if ($LASTEXITCODE -ne 0) { Fail ((T "Archive illisible : " "Unreadable archive: ") + $zip) }
    } else {
        Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    }
    $top = @(Get-ChildItem -LiteralPath $tmp -Directory)
    if ($top.Count -ne 1) { Fail ((T "Archive inattendue (plusieurs dossiers) : " "Unexpected archive (several folders): ") + $zip) }
    Move-Item -LiteralPath $top[0].FullName -Destination $dest
    Remove-Item -LiteralPath $tmp -Recurse -Force
    Remove-Item -LiteralPath $zip -Force
}

function Read-KeyValues([string]$file) {
    $v = @{}
    Get-Content -LiteralPath $file -Encoding UTF8 | Where-Object { $_ -match '^\s*([A-Z_]+)=(.*)$' } | ForEach-Object { $v[$Matches[1]] = $Matches[2].Trim() }
    $v
}

# ------------------------------------------------------------------------------------------------- réglages
foreach ($f in "versions.txt", "custom_nodes.txt", "requirements-mia.txt", "constraints.txt") {
    if (-not (Test-Path (Join-Path $Here $f))) { Fail ((T "Fichier manquant à côté du script : " "File missing next to the script: ") + $f) }
}
$v = Read-KeyValues (Join-Path $Here "versions.txt")
foreach ($k in "PYTHON", "UV", "COMFYUI_TAG", "COMFYUI_REPO", "TORCH", "TORCHVISION", "TORCHAUDIO", "TORCH_INDEX") {
    if (-not $v[$k]) { Fail ((T "versions.txt : valeur manquante " "versions.txt: missing value ") + $k) }
}
# Les versions exactes de tous les autres paquets Python (uv pip install -c) : le moteur reste celui qui est testé
$Constraints = Join-Path $Here "constraints.txt"
$MinDriver = 580; if ($v["MIN_DRIVER"]) { $MinDriver = [int]$v["MIN_DRIVER"] }
$MinFreeGB = 25; if ($v["MIN_FREE_GB"]) { $MinFreeGB = [int]$v["MIN_FREE_GB"] }

$Nodes = @(Get-Content -LiteralPath (Join-Path $Here "custom_nodes.txt") -Encoding UTF8 | Where-Object { $_ -match '^\s*[^#\s]' } | ForEach-Object {
    $url, $rev = -split $_
    $repo = $url -replace '\.git$', ''
    [pscustomobject]@{ Url = $url; Rev = $rev; Name = [IO.Path]::GetFileNameWithoutExtension($url); Zip = "$repo/archive/$rev.zip" }
})

if (-not $Target) {
    $leaf = T "Mia-moteur" "Mia-engine"
    if (Test-Path "D:\") { $Target = "D:\" + $leaf } else { $Target = Join-Path $env:USERPROFILE $leaf }
}
try { $Target = [IO.Path]::GetFullPath($Target).TrimEnd('\') } catch { Fail ((T "Dossier invalide : " "Invalid folder: ") + $Target) }
if ($Target -notmatch '^[A-Za-z]:') { Fail ((T "Choisis un dossier sur un disque de ce PC (C:, D:…), pas sur le réseau : " "Choose a folder on a drive of this PC (C:, D:…), not on the network: ") + $Target) }
if ($Target -match '^[A-Za-z]:$') { $Target += '\' }

$EnvDir = Join-Path $Target "env"
$UvDir = Join-Path $EnvDir "uv"
$Py = Join-Path $EnvDir "venv\Scripts\python.exe"
$Comfy = Join-Path $EnvDir "ComfyUI"

Out-Line ((T "Moteur de Mia " "Mia engine ") + $SetupVersion + " → " + $Target + $(if ($DryRun) { T "   (à blanc : rien n’est téléchargé ni écrit)" "   (dry run: nothing is downloaded or written)" } else { "" }))
Out-Line ((T "Python {0} · ComfyUI {1} · PyTorch {2} ({3}) · {4} nœuds ajoutés" "Python {0} · ComfyUI {1} · PyTorch {2} ({3}) · {4} added nodes") -f $v.PYTHON, $v.COMFYUI_TAG, $v.TORCH, ($v.TORCH_INDEX -replace '^.*/', ''), $Nodes.Count)

# ------------------------------------------------------------------------------------------------- 1. machine
Step (T "Vérification de la machine" "Checking the machine")
if (-not [Environment]::Is64BitOperatingSystem) { Fail (T "Windows 64 bits est nécessaire." "64-bit Windows is needed.") }
$miaRoot = Split-Path -Parent $Here
if ($Target.ToLower().StartsWith($miaRoot.ToLower() + "\") -or $Target.ToLower() -eq $miaRoot.ToLower()) {
    Fail ((T "Le moteur ne peut pas aller dans le dossier de Mia ({0}) : choisis un autre dossier." "The engine cannot go in Mia's folder ({0}): choose another folder.") -f $miaRoot)
}
# Les paquets Python et le cache de uv descendent loin dans le dossier : au-delà de 260 caractères, Windows refuse
# d'écrire (essai du 17/10 : le cache de uv échoue sous un dossier de 162 caractères).
if ($Target.Length -gt 80) {
    $msg = (T "Chemin trop long ({0} caractères) : Windows refuserait certains fichiers du moteur. Choisis un dossier au chemin court, par exemple D:\Mia-moteur." "Path too long ({0} characters): Windows would refuse some of the engine's files. Choose a folder with a short path, for example D:\Mia-engine.") -f $Target.Length
    if ($DryRun) { Info ((T "ATTENTION : " "WARNING: ") + $msg) } else { Fail $msg }
}
$qual = Split-Path -Qualifier $Target
$drive = New-Object System.IO.DriveInfo($qual)
if (-not $drive.IsReady) { Fail ((T "Le disque {0} est introuvable." "Drive {0} cannot be found.") -f $qual) }
$freeGB = [math]::Round($drive.AvailableFreeSpace / 1GB, 1)
# « 290,8 Go » / « 290.8 GB » : la virgule ou le point de la langue choisie, pas ceux de Windows
$freeTxt = $freeGB.ToString([Globalization.CultureInfo]::GetCultureInfo($(if ($Lang -eq "en") { "en-US" } else { "fr-FR" })))
Info ((T "place libre sur {0} : {1} Go (le moteur prend environ 15 Go ; les modèles 20 à 150 Go de plus)" "{1} GB free on {0} (the engine takes about 15 GB; the models 20 to 150 GB more)") -f $qual, $freeTxt)
if ($freeGB -lt $MinFreeGB) {
    if ($DryRun) { Info ((T "ATTENTION : moins de {0} Go libres : l’installation réelle s’arrêterait ici." "WARNING: less than {0} GB free: the real install would stop here.") -f $MinFreeGB) }
    else { Fail ((T "Pas assez de place sur {0} : {1} Go libres, il en faut au moins {2}." "Not enough space on {0}: {1} GB free, at least {2} GB are needed.") -f $qual, $freeTxt, $MinFreeGB) }
}
$smi = $null
$smiCmd = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
if ($smiCmd) { $smi = $smiCmd.Source } elseif (Test-Path (Join-Path $Sys32 "nvidia-smi.exe")) { $smi = Join-Path $Sys32 "nvidia-smi.exe" }
if ($smi) {
    $gpu = Quiet $smi @("--query-gpu=name,driver_version,memory.total", "--format=csv,noheader") | Select-Object -First 1
    if ($gpu) {
        $parts = $gpu -split ',\s*'
        Info ((T "carte graphique : {0} · pilote {1} · {2}" "graphics card: {0} · driver {1} · {2}") -f $parts[0], $parts[1], $parts[2])
        $major = 0; [void][int]::TryParse(($parts[1] -split '\.')[0], [ref]$major)
        if ($major -lt $MinDriver) {
            $msg = (T "Pilote NVIDIA trop ancien ({0}) : il faut la version {1} ou plus récente (site de NVIDIA ou GeForce Experience / NVIDIA App)." "NVIDIA driver too old ({0}): version {1} or newer is needed (NVIDIA's site or GeForce Experience / NVIDIA App).") -f $parts[1], $MinDriver
            if ($DryRun -or $SkipGpuCheck) { Info ((T "ATTENTION : " "WARNING: ") + $msg) } else { Fail $msg }
        }
    }
} else {
    $msg = T "Aucune carte NVIDIA détectée (nvidia-smi introuvable). Mia calcule sur une carte NVIDIA récente (12 Go de mémoire au moins, 24 Go conseillés)." "No NVIDIA card found (nvidia-smi is missing). Mia computes on a recent NVIDIA card (12 GB of memory at least, 24 GB advised)."
    if ($DryRun -or $SkipGpuCheck) { Info ((T "ATTENTION : " "WARNING: ") + $msg) } else { Fail ($msg + (T " Relance avec -SkipGpuCheck pour installer quand même." " Run again with -SkipGpuCheck to install anyway.")) }
}
if (-not (Test-Path $Curl)) { Info (T "curl.exe de Windows absent : téléchargements par PowerShell (plus lents)." "Windows' curl.exe is missing: downloads go through PowerShell (slower).") }
if (-not (Test-Path $Tar)) { Info (T "tar.exe de Windows absent : décompression par PowerShell (plus lente)." "Windows' tar.exe is missing: unzipping goes through PowerShell (slower).") }

# ------------------------------------------------------------------------------------------------- 2. dossiers
Step (T "Dossiers du moteur" "Engine folders")
$modelDirs = @("checkpoints", "diffusion_models", "text_encoders", "vae", "loras", "latent_upscale_models", "clip_vision",
    "model_patches", "upscale_models", "videodepthanything", "SEEDVR2", "outils")
$dirs = @("env", "models", "runtime\input", "runtime\output", "config\comfy_user") + @($modelDirs | ForEach-Object { "models\" + $_ })
foreach ($d in $dirs) {
    $p = Join-Path $Target $d
    if (Test-Path $p) { continue }
    if ($DryRun) { Plan ((T "créer " "create ") + $p) } else { New-Item -ItemType Directory -Force $p | Out-Null }
}
Info ((T "{0} dossiers prêts" "{0} folders ready") -f $dirs.Count)

# ------------------------------------------------------------------------------------------------- 3. uv
Step ("uv " + $v.UV + (T " (gestionnaire Python)" " (Python manager)"))
$uv = Join-Path $UvDir "uv.exe"
$haveUv = $false
if (Test-Path $uv) {
    $uvv = (Quiet $uv @("--version")) -join " "
    if ($uvv -match [regex]::Escape($v.UV)) { $haveUv = $true; Info ((T "déjà là : " "already there: ") + $uvv) }
}
if (-not $haveUv) {
    $sysUv = Get-Command uv.exe -ErrorAction SilentlyContinue
    if ($sysUv) { Info ((T "uv trouvé sur ce PC ({0}) : Mia installe quand même sa version figée, à part." "uv found on this PC ({0}): Mia still installs its own pinned version, separately.") -f ((Quiet $sysUv.Source @("--version")) -join " ")) }
    $zip = Join-Path $EnvDir ("uv-" + $v.UV + ".zip")
    Download ("https://github.com/astral-sh/uv/releases/download/{0}/uv-x86_64-pc-windows-msvc.zip" -f $v.UV) $zip
    if ($DryRun) { Plan ((T "décompresser dans " "unzip into ") + $UvDir) }
    else {
        if (Test-Path $UvDir) { Remove-Item -LiteralPath $UvDir -Recurse -Force }
        New-Item -ItemType Directory -Force $UvDir | Out-Null
        if (Test-Path $Tar) { & $Tar -xf $zip -C $UvDir; if ($LASTEXITCODE -ne 0) { Fail (T "Archive de uv illisible." "Unreadable uv archive.") } }
        else { Expand-Archive -LiteralPath $zip -DestinationPath $UvDir -Force }
        Remove-Item -LiteralPath $zip -Force
        if (-not (Test-Path $uv)) { $found = Get-ChildItem -LiteralPath $UvDir -Recurse -Filter uv.exe | Select-Object -First 1; if ($found) { $uv = $found.FullName } }
        if (-not (Test-Path $uv)) { Fail (T "uv.exe introuvable après décompression." "uv.exe not found after unzipping.") }
        Info ((T "installé : " "installed: ") + ((Quiet $uv @("--version")) -join " "))
    }
}
# uv garde tout dans le dossier du moteur : Python, cache des paquets (rien dans AppData)
$env:UV_PYTHON_INSTALL_DIR = Join-Path $EnvDir "python"
$env:UV_CACHE_DIR = Join-Path $EnvDir "uv-cache"
$env:UV_LINK_MODE = "copy"

# ------------------------------------------------------------------------------------------------- 4. Python
Step ("Python " + $v.PYTHON)
# --no-bin : pas de python.exe ajouté au PATH ; --no-registry : pas d'inscription dans le registre de Windows
Run $uv @("python", "install", $v.PYTHON, "--no-bin", "--no-registry") (T "Installation de Python" "Installing Python")

# ------------------------------------------------------------------------------------------------- 5. venv
Step (T "Environnement virtuel (env\venv)" "Virtual environment (env\venv)")
if (Test-Path $Py) { Info ((T "déjà là : " "already there: ") + $Py) }
else { Run $uv @("venv", "--python", $v.PYTHON, (Join-Path $EnvDir "venv")) (T "Création de l’environnement virtuel" "Creating the virtual environment") }

# ------------------------------------------------------------------------------------------------- 6. ComfyUI
Step ("ComfyUI " + $v.COMFYUI_TAG)
$mark = Join-Path $Comfy ".mia-source"
$haveComfy = (Test-Path (Join-Path $Comfy "main.py")) -and (Test-Path $mark) -and ((Get-Content -LiteralPath $mark -Raw).Trim() -eq $v.COMFYUI_TAG)
if ($haveComfy) { Info ((T "déjà là : " "already there: ") + $Comfy) }
else {
    if ((Test-Path $Comfy) -and -not $DryRun) {
        $aside = $Comfy + ".ancien-" + (Get-Date -Format "yyyyMMdd-HHmmss")
        Info ((T "un autre ComfyUI est là : mis de côté dans {0} (rien n’est effacé)" "another ComfyUI is there: set aside in {0} (nothing is deleted)") -f $aside)
        Move-Item -LiteralPath $Comfy -Destination $aside
    } elseif (Test-Path $Comfy) { Plan ((T "mettre de côté le ComfyUI existant ({0})" "set the existing ComfyUI aside ({0})") -f $Comfy) }
    $zip = Join-Path $EnvDir ("ComfyUI-" + $v.COMFYUI_TAG + ".zip")
    Download ("{0}/archive/refs/tags/{1}.zip" -f $v.COMFYUI_REPO, $v.COMFYUI_TAG) $zip
    Expand-Single $zip $Comfy
    if (-not $DryRun) { Set-Content -LiteralPath $mark -Value $v.COMFYUI_TAG -Encoding ASCII }
}

# ------------------------------------------------------------------------------------------------- 7. PyTorch
Step ("PyTorch " + $v.TORCH + (T " pour carte NVIDIA" " for NVIDIA cards"))
# Seul l'index CUDA de PyTorch sert ici : constraints.txt n'est pas passé (cet index n'a pas toutes les versions de
# PyPI) ; les étapes suivantes ramènent ses dépendances (numpy, pillow…) aux versions de constraints.txt.
Run $uv @("pip", "install", "--python", $Py, ("torch==" + $v.TORCH), ("torchvision==" + $v.TORCHVISION), ("torchaudio==" + $v.TORCHAUDIO), "--index-url", $v.TORCH_INDEX) (T "Installation de PyTorch" "Installing PyTorch")

# ------------------------------------------------------------------------------------------------- 8. ComfyUI : dépendances
Step (T "Dépendances de ComfyUI" "ComfyUI dependencies")
Run $uv @("pip", "install", "--python", $Py, "-c", $Constraints, "-r", (Join-Path $Comfy "requirements.txt")) (T "Installation des dépendances de ComfyUI" "Installing ComfyUI's dependencies")

# ------------------------------------------------------------------------------------------------- 9. nœuds ajoutés
Step ((T "Nœuds ajoutés ({0})" "Added nodes ({0})") -f $Nodes.Count)
foreach ($n in $Nodes) {
    $dst = Join-Path $Comfy ("custom_nodes\" + $n.Name)
    $nm = Join-Path $dst ".mia-source"
    $have = (Test-Path $nm) -and ((Get-Content -LiteralPath $nm -Raw).Trim() -eq $n.Rev)
    if ($have) { Info ((T "déjà là : " "already there: ") + $n.Name) }
    else {
        if ((Test-Path $dst) -and -not $DryRun) {
            $aside = Join-Path $EnvDir ("custom_nodes.ancien\" + $n.Name + "-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
            New-Item -ItemType Directory -Force (Split-Path -Parent $aside) | Out-Null
            Move-Item -LiteralPath $dst -Destination $aside
            Info ((T "ancienne version mise de côté : " "old version set aside: ") + $aside)
        }
        $zip = Join-Path $EnvDir ($n.Name + ".zip")
        Download $n.Zip $zip
        Expand-Single $zip $dst
        if (-not $DryRun) { Set-Content -LiteralPath $nm -Value $n.Rev -Encoding ASCII }
    }
    $req = Join-Path $dst "requirements.txt"
    if ($DryRun -or (Test-Path $req)) { Run $uv @("pip", "install", "--python", $Py, "-c", $Constraints, "-r", $req) ((T "Dépendances de " "Dependencies of ") + $n.Name) }
}

# ------------------------------------------------------------------------------------------------- 10. Mia
Step (T "Dépendances du calcul de Mia" "Mia's compute dependencies")
Run $uv @("pip", "install", "--python", $Py, "-c", $Constraints, "-r", (Join-Path $Here "requirements-mia.txt")) (T "Installation des dépendances de Mia" "Installing Mia's dependencies")

# ------------------------------------------------------------------------------------------------- 11. contrôle
Step (T "Vérification finale" "Final check")
if ($DryRun) {
    Plan ("> python -c ""import torch, av, numpy, cv2 ; torch.cuda.is_available()""")
    Plan ((T "écrire {0} et {1}" "write {0} and {1}") -f (Join-Path $Target "mia-engine.json"), (Join-Path $EnvDir "lock-windows.txt"))
} else {
    $noCuda = T "pas de carte CUDA" "no CUDA card"
    $check = & $Py -c "import torch, av, numpy, cv2; print('torch', torch.__version__, '| cuda', torch.version.cuda, '|', torch.cuda.get_device_name(0) if torch.cuda.is_available() else '$noCuda')"
    if ($LASTEXITCODE -ne 0) { Fail (T "Le Python du moteur ne charge pas PyTorch : relance le script (il reprend), ou lis le journal ci-dessus." "The engine's Python does not load PyTorch: run the script again (it resumes), or read the log above.") }
    Info $check
    & $uv pip freeze --python $Py | Set-Content -LiteralPath (Join-Path $EnvDir "lock-windows.txt") -Encoding ASCII
    $card = [ordered]@{
        engine = "mia"; setup = $SetupVersion; python = $v.PYTHON; comfyui = $v.COMFYUI_TAG; torch = $v.TORCH
        torchIndex = $v.TORCH_INDEX; nodes = @($Nodes | ForEach-Object { $_.Name + "@" + $_.Rev.Substring(0, 10) })
        installed = (Get-Date).ToString("s")
    }
    [IO.File]::WriteAllText((Join-Path $Target "mia-engine.json"), (ConvertTo-Json -InputObject $card -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
}

Out-Line ""
if ($DryRun) {
    Out-Line ((T "À blanc : tout est prêt pour installer le moteur dans {0}. Relance sans -DryRun pour l’installer." "Dry run: everything is ready to install the engine in {0}. Run again without -DryRun to install it.") -f $Target)
} else {
    Out-Line ((T "Moteur installé dans {0}." "Engine installed in {0}.") -f $Target)
    Out-Line (T "Dans Mia : Réglages → Dossier du moteur → ce dossier ; puis Bibliothèque → installer les modèles." "In Mia: Settings → Engine folder → this folder; then Library → install the models.")
}
Emit ([ordered]@{ done = $true; engineRoot = $Target; dryRun = [bool]$DryRun; p = 1 })
exit 0
