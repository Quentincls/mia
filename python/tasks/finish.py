# -*- coding: utf-8 -*-
"""Finition : LUT 3D (.cube) dosée, grain et vignettage — et, en option, une optique de cinéma (courbe douce des
hautes lumières, halo, voile, traînées, franges colorées). Sur le GPU.

job = {"inputs": {"media": {…}},
       "params": {"lut": chemin .cube | id d'un look de Mia/luts/index.json (« etalo-doux », « pellicule-chaude »…) | None,
                  "lutStrength": 0..1,5, "grain": 0..6, "vignette": 0..0,3, "film": bool,
                  "keepReds": 0..1 (garde_chauds de tool.lut_gpu : les rouges saturés gardent leur teinte)},
       "outDir", "lang", "engineRoot"}
→ {"out": {abs, kind, meta}} : PNG pour une image ; MP4 muet pour une vidéo (l'exécuteur remet le son de la source).

L'exécuteur (electron/engine/executors/finish.js → looks.js) envoie déjà le chemin du .cube ; un id de look est aussi
accepté ici (même index.json : « <labo>/… » = dans le dossier du moteur, sinon dans Mia/luts).

Le calcul : tool.lut_gpu.Lut puis tool.finish_gpu.Finisher (copie figée dans python/vendor), avec les réglages
conseillés (grain 2,0, vignette 0,06 ; optique : halo 0,07, voile 0,012, traînées 0,035, aberration 0,7, courbe).
Mia n'a pas de vecteurs de mouvement : obturateur 0 (pas de flou de bougé) et un flux vide.
"""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np

import mia_common as mc
from mia_common import tr

PREVIEW_EVERY_S = 1.5
# Optique de cinéma : les valeurs par défaut de tool.finish_gpu.Finisher
FILM = {"halo": 0.07, "glare": 0.012, "flare": 0.035, "ca": 0.7, "curve": True}


MIA = Path(__file__).resolve().parents[2]
LAB = "<labo>/"


def resolve_lut(value, engine_root=None):
    """Chemin .cube tel quel, ou id d'un look de Mia/luts/index.json → chemin ; None = pas d'étalonnage."""
    v = str(value or "").strip()
    if not v or v == "none":
        return None
    if v.lower().endswith(".cube") or "/" in v or "\\" in v:
        return v
    import json
    try:
        index = json.loads((MIA / "luts" / "index.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        index = []
    for e in index if isinstance(index, list) else []:
        if isinstance(e, dict) and e.get("id") == v:
            f = str(e.get("file") or "")
            if f.startswith(LAB):
                if not engine_root:
                    raise mc.UserError(tr(f"Le look « {v} » n’est pas sur ce PC (il vient du dossier du moteur).",
                                          f"The “{v}” look is not on this PC (it comes from the engine folder)."))
                return str(Path(engine_root).joinpath(*f[len(LAB):].split("/")))
            return str(MIA.joinpath("luts", *f.split("/")))
    raise mc.UserError(tr(f"Look inconnu : « {v} ».", f"Unknown look: “{v}”."))


class _SansFlux:
    """Le Finisher attend des vecteurs de mouvement ; sans flou de bougé (obturateur 0), un flux vide suffit."""

    def __init__(self, h, w):
        self.n, self.h, self.w, self.sw, self.sh, self.scale = 2, h, w, 2, 2, 1.0
        self.bwd, self.fwd = [np.zeros((2, 2, 2), np.float32)], []


def run(job, io):
    params = job.get("params") or {}
    lut_path = resolve_lut(params.get("lut"), job.get("engineRoot"))
    strength = max(0.0, min(1.5, float(params.get("lutStrength", 1.0) or 0)))
    grain = max(0.0, min(6.0, float(params.get("grain", 2.0) or 0)))
    vig = max(0.0, min(0.3, float(params.get("vignette", 0.06) or 0)))
    film = bool(params.get("film", False))
    keep_reds = max(0.0, min(1.0, float(params.get("keepReds", 0) or 0)))
    out_dir = Path(job.get("outDir") or ".")

    io.step(0.01, tr("Préparation…", "Preparing…"))
    media = mc.Media((job.get("inputs") or {}).get("media"), job)
    device = mc.pick_device()
    # tool.gpu choisit son appareil à l'import (cuda s'il existe) : on le cale sur celui de Mia (MIA_DEVICE=cpu pour
    # les essais sans carte graphique). Rien n'est écrit dans le labo : c'est l'attribut du module chargé ici.
    from tool import gpu, finish_gpu
    gpu.DEVICE = "cuda" if device.type == "cuda" else "cpu"

    lut = None
    if lut_path and strength > 0:
        if not Path(lut_path).is_file():
            raise mc.UserError(tr(f"LUT introuvable : {lut_path}", f"LUT not found: {lut_path}"))
        from tool.lut_gpu import Lut
        try:
            lut = Lut(lut_path, device=gpu.DEVICE)
        except Exception as e:
            raise mc.UserError(tr(f"LUT illisible ({Path(lut_path).name}) : ce n’est pas une LUT 3D .cube valide.",
                                  f"Unreadable LUT ({Path(lut_path).name}): not a valid 3D .cube LUT.")) from e

    W, H = media.w, media.h
    opt = FILM if film else {"halo": 0.0, "glare": 0.0, "flare": 0.0, "ca": 0.0, "curve": False}
    fin = finish_gpu.Finisher(_SansFlux(H, W), shutter=0, vig=vig, grain_strength=grain, **opt)

    def apply(fr, t):
        if lut is not None:
            fr = lut(fr, strength, garde_chauds=keep_reds)
        return fin(fr, t)

    msg = tr("Finition", "Finishing")
    io.step(0.04, f"{msg}…")
    if media.kind == "image":
        img = apply(media.image(), 0)
        io.step(0.95, tr("Écriture du fichier…", "Writing the file…"))
        path = mc.write_png(out_dir / "out.png", img)
        return {"out": {"abs": str(path), "kind": "image", "meta": {"w": int(img.shape[1]), "h": int(img.shape[0])}}}

    total = max(1, media.frames or 1)
    writer = mc.VideoWriter(out_dir / "out.mp4", media.fps)
    done, last_preview = 0, 0.0
    with media.chunks(4) as chunks:
        for _start, frames in chunks:
            for fr in frames:
                io.check()
                img = apply(fr, done)
                writer.write(img)
                done += 1
                now = time.monotonic()
                if now - last_preview > PREVIEW_EVERY_S:
                    last_preview = now
                    io.preview_image(img)
            io.frames(done, max(total, done), tr(f"{msg} · {done} / {max(total, done)} images",
                                                 f"{msg} · {done} / {max(total, done)} frames"), 0.05, 0.97)
    io.step(0.98, tr("Écriture du fichier…", "Writing the file…"))
    path = writer.close()
    w, h = writer.size
    return {"out": {"abs": str(path), "kind": "video",
                    "meta": {"w": w, "h": h, "fps": float(media.fps), "frames": done}}}
