# -*- coding: utf-8 -*-
"""Paquet « tool » de Mia : copie figée de quelques modules de D:\\AI_Local_Videos\\tool, 17/10/2026 (Mia 0.5.0).

Le worker de Mia (python/mia_worker.py) met python/vendor en tête de sys.path : `from tool import gpu` prend donc
la copie d'ici, et Mia marche sur un PC qui n'a pas le labo. Copiés (ceux qu'importent les tâches de python/tasks) :
    gpu.py         flou gaussien, appareil de calcul (importé par finish_gpu)
    lut_gpu.py     LUT 3D .cube sur GPU (tâche finish)
    finish_gpu.py  grain, vignettage, optique de cinéma (tâche finish)

Un module qui n'est pas copié ici est cherché ensuite dans le dossier tool du moteur (engineRoot\\tool), s'il existe :
c'est le comportement d'avant la copie, gardé en secours. MIA_VENDOR=0 fait ignorer la copie (essais contre le labo).

Mettre à jour la copie : recopier les fichiers du labo en gardant l'en-tête de deux lignes « Copie figée de … ».
"""
import os as _os

FROZEN = "2026-10-17"
FROM = r"D:\AI_Local_Videos\tool"


def _lab_tool_dirs():
    """Dossiers tool du moteur, en secours : MIA_ENGINE_ROOT, puis PYTHONPATH (posé par electron/engine/pyrun.js)."""
    here = _os.path.normcase(_os.path.abspath(_os.path.dirname(__file__)))
    roots = [_os.environ.get("MIA_ENGINE_ROOT")] + _os.environ.get("PYTHONPATH", "").split(_os.pathsep)
    seen = set()
    for r in roots:
        if not r:
            continue
        d = _os.path.abspath(_os.path.join(r, "tool"))
        key = _os.path.normcase(d)
        if key == here or key in seen or not _os.path.isfile(_os.path.join(d, "__init__.py")):
            continue
        seen.add(key)
        yield d


try:
    __path__.extend(_lab_tool_dirs())  # noqa: F821 — __path__ existe pour un paquet
except Exception:  # pragma: no cover — le secours ne doit jamais empêcher l'import de la copie
    pass
