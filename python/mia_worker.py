# -*- coding: utf-8 -*-
"""Mia — point d'entrée du worker Python.

    python -B -u mia_worker.py <tâche> <job.json>

Lancé par electron/engine/pyrun.js avec le Python du labo (cwd = dossier du run, PYTHONPATH = engineRoot,
HF_HUB_OFFLINE=1). Charge python/tasks/<tâche>.py et appelle run(job, io) ; la valeur rendue (les sorties) part
dans « @mia {"done": true, "outputs": …} ». Une erreur part dans « @mia {"error": "…"} », en français lisible ;
le détail technique (trace) va dans le journal. Annulation : le moteur dépose <dossier du run>\\cancel, la tâche
le voit entre deux paquets d'images (io.check()) ; après 3 s il tue l'arbre de processus.

Codes de sortie : 0 = fini, 1 = erreur, 2 = mauvais appel, 3 = annulé.
"""
from __future__ import annotations

import importlib
import json
import os
import re
import sys
import time
import traceback
import warnings
from pathlib import Path

# Le dossier de ce script (python\ de Mia) d'abord : `mia_common` et `tasks` sont à nous ;
# puis python\vendor : la copie figée des modules tool.* du labo qu'importent les tâches (SPEC §21.3), pour que Mia
# marche sans le labo ; engineRoot arrive ensuite par PYTHONPATH, en lecture seule (secours pour un module non copié).
# MIA_VENDOR=0 fait ignorer la copie (essais contre le labo).
HERE = Path(__file__).resolve().parent
VENDOR = HERE / "vendor"
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
if os.environ.get("MIA_VENDOR", "1") != "0" and VENDOR.is_dir() and str(VENDOR) not in sys.path:
    sys.path.insert(sys.path.index(str(HERE)) + 1, str(VENDOR))

import mia_common as mc  # noqa: E402

# Journal lisible : les FutureWarning de timm/transformers n'apprennent rien à Quentin.
warnings.filterwarnings("ignore", category=FutureWarning)
os.environ.setdefault("HF_HUB_OFFLINE", "1")          # jamais de réseau, même lancé à la main
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

TASK_LABEL = {
    "cutout": ("Le détourage", "The cutout"),
    "composite": ("La superposition", "The composite"),
    "finish": ("La finition", "The finish"),
}


def _utf8_streams():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
        except Exception:
            pass


def _load_job(path):
    try:
        with open(path, encoding="utf-8") as f:
            job = json.load(f)
    except FileNotFoundError:
        raise mc.UserError(mc.tr(f"Fichier de tâche introuvable : {path}", f"Job file not found: {path}"))
    except (OSError, ValueError) as e:
        raise mc.UserError(mc.tr(f"Fichier de tâche illisible ({e}).", f"Unreadable job file ({e})."))
    if not isinstance(job, dict):
        raise mc.UserError(mc.tr("Fichier de tâche invalide.", "Invalid job file."))
    return job


def _friendly(exc, task):
    """Message d'échec pour le bloc. Les causes connues sont nommées ; le reste renvoie au journal."""
    fr_who, en_who = TASK_LABEL.get(task, ("Le calcul", "The job"))
    if mc.is_oom(exc):
        return mc.tr("Mémoire GPU insuffisante : ferme Unreal ou attends la fin de l’autre calcul, puis relance.",
                     "Not enough GPU memory: close Unreal or wait for the other job to finish, then retry.")
    if isinstance(exc, MemoryError):
        return mc.tr("Mémoire vive insuffisante pour ce fichier.", "Not enough RAM for this file.")
    if isinstance(exc, ModuleNotFoundError):
        return mc.tr(f"Bibliothèque Python manquante dans le moteur : {exc.name}.",
                     f"Python library missing from the engine: {exc.name}.")
    if isinstance(exc, PermissionError):
        return mc.tr(f"Accès refusé : {exc.filename or exc}. Le fichier est peut-être ouvert ailleurs.",
                     f"Access denied: {exc.filename or exc}. The file may be open elsewhere.")
    if isinstance(exc, OSError) and getattr(exc, "errno", None) == 28:
        return mc.tr("Disque plein.", "Disk full.")
    detail = str(exc).strip().splitlines()[0][:200] if str(exc).strip() else type(exc).__name__
    return mc.tr(f"{fr_who} a échoué : {detail} (détails dans le journal).",
                 f"{en_who} failed: {detail} (details in the log).")


def main(argv):
    _utf8_streams()
    if len(argv) < 3:
        mc.emit({"error": "Usage : mia_worker.py <tâche> <job.json>"})
        return 2
    task, job_path = argv[1].strip().lower(), argv[2]
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,40}", task):
        mc.emit({"error": f"Tâche inconnue : {task}"})
        return 2

    t0 = time.monotonic()
    try:
        job = _load_job(job_path)
    except mc.UserError as e:
        mc.emit({"error": str(e)})
        return 2
    mc.set_lang(job.get("lang"))
    out_dir = Path(job.get("outDir") or os.getcwd())
    out_dir.mkdir(parents=True, exist_ok=True)
    io = mc.IO(job, out_dir)
    mc.log(f"[mia_worker] tâche {task} · python {sys.version.split()[0]} · dossier {out_dir} · tool : {mc.tool_origin()}")

    cancelled = {"error": mc.tr("Calcul annulé.", "Cancelled."), "cancelled": True}
    try:
        try:
            mod = importlib.import_module(f"tasks.{task}")
        except ModuleNotFoundError as e:
            if e.name in (f"tasks.{task}", "tasks"):
                raise mc.UserError(mc.tr(f"Tâche inconnue : {task}", f"Unknown task: {task}"))
            raise
        io.check()
        outputs = mod.run(job, io) or {}
        io.check()
        result, code = {"done": True, "outputs": outputs}, 0
        mc.log(f"[mia_worker] fini en {time.monotonic() - t0:.1f} s")
    except mc.Cancelled:
        mc.log("[mia_worker] annulé")
        result, code = cancelled, 3
    except mc.UserError as e:
        mc.log("[mia_worker] erreur :", e)
        result, code = {"error": str(e)}, 1
    except BaseException as e:  # noqa: BLE001 — tout doit finir en message lisible, même un KeyboardInterrupt
        traceback.print_exc()
        if io.cancelled():
            result, code = cancelled, 3
        else:
            result, code = {"error": _friendly(e, task)}, 1

    # Avant le dernier message : le moteur relâche le verrou GPU dès la fin du worker, et l'interface remplace
    # l'aperçu par la sortie. Les aperçus ne restent pas dans le dossier du run ; la mémoire GPU est rendue.
    io.cleanup()
    mc.release_gpu()
    mc.emit(result)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
