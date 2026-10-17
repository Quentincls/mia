# -*- coding: utf-8 -*-
"""Tâches du worker Python de Mia : un module par tâche, chacun expose run(job, io) → sorties.

Sorties : {"<port>": {"abs": "C:/…/fichier", "kind": "image"|"video", "meta": {"w", "h", "fps", "frames", "alpha"}}},
fichiers écrits dans job["outDir"] (le dossier du run). Voir mia_worker.py pour le protocole.
"""
