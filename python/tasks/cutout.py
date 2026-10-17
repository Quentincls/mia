# -*- coding: utf-8 -*-
"""Détourer : masque du sujet principal (BiRefNet) et version détourée, pour une image ou une vidéo.

D'après un essai de l'auteur (BiRefNet : entrée 1024×1024 normalisée ImageNet, fp16 sur cuda, sortie [-1].sigmoid()).
Ici par paquets d'images (la lecture se fait dans un fil à part pendant que le GPU calcule), avec repli sur des paquets
plus petits si la mémoire GPU manque. On détoure l'image elle-même (jamais un masque 3D élargi, qui laisse des halos).

job = {"inputs": {"media": {abs, kind, meta, skipFirst}},
       "params": {"background": "black"|"green"|"alpha", "feather": px, "grow": px},
       "modelPath": "…/models/outils/BiRefNet" | null, "engineRoot", "outDir", "lang"}
→ {"mask": {abs, kind, meta}, "cut": {abs, kind, meta}}
Fond « alpha » : PNG RGBA pour une image, WebM VP9 transparent pour une vidéo (NVENC ne sait pas faire d'alpha).
"""
from __future__ import annotations

import os
import time
from pathlib import Path

import mia_common as mc
from mia_common import tr

GREEN = (0.0, 177 / 255, 64 / 255)          # vert d'incrustation usuel (#00B140)
MEAN = (0.485, 0.456, 0.406)                # normalisation ImageNet (celle de l'entraînement de BiRefNet)
STD = (0.229, 0.224, 0.225)
PREVIEW_EVERY_S = 1.5


def _model_dir(job):
    cands = []
    p = job.get("modelPath")
    if p:
        p = Path(p)
        cands.append(p if p.is_dir() else p.parent)       # l'inventaire peut pointer le dossier ou model.safetensors
    root = mc.engine_root(job)
    if root is not None:
        cands.append(root / "models" / "outils" / "BiRefNet")
    for d in cands:
        if (d / "config.json").is_file():
            return d
    raise mc.UserError(tr("Modèle de détourage introuvable (BiRefNet, dans models\\outils du moteur).",
                          "Cutout model not found (BiRefNet, in the engine's models\\outils)."))


def _resolution():
    """1024 = la taille d'entraînement. MIA_CUTOUT_RES (multiple de 32) ne sert qu'aux essais rapides sur processeur."""
    try:
        r = int(os.environ.get("MIA_CUTOUT_RES", "1024"))
    except ValueError:
        r = 1024
    return max(256, min(2048, r // 32 * 32))


def _load(model_dir, device):
    import torch
    from transformers import AutoModelForImageSegmentation
    m = AutoModelForImageSegmentation.from_pretrained(str(model_dir), trust_remote_code=True, local_files_only=True)
    # Le fichier est en fp16 et transformers garde le type stocké : demi-précision sur le GPU (comme le labo),
    # pleine précision sur le processeur (le fp16 y est lent, voire refusé par certaines couches).
    dtype = torch.float16 if device.type == "cuda" else torch.float32
    return m.to(device=device, dtype=dtype).eval(), dtype


def _batch_size(device, res):
    """Images traitées ensemble sur le GPU, d'après la mémoire libre (prudent : Unreal tourne souvent à côté)."""
    if device.type != "cuda":
        return 1
    import torch
    free_gb = torch.cuda.mem_get_info()[0] / 2 ** 30
    per_image = 2.5 * (res / 1024) ** 2
    return int(max(1, min(8, (free_gb - 2.0) // per_image)))


class _Segmenter:
    """BiRefNet sur des paquets [N, H, W, 3] uint8 → masques [N, 1, H, W] flottants 0..1, à la taille d'origine."""

    def __init__(self, model, dtype, device, res):
        import torch
        self.model, self.dtype, self.device, self.res = model, dtype, device, res
        self.mean = torch.tensor(MEAN, device=device).view(1, 3, 1, 1)
        self.std = torch.tensor(STD, device=device).view(1, 3, 1, 1)
        self.bs = _batch_size(device, res)

    def _infer(self, u8):
        import torch
        h, w = u8.shape[1:3]
        x = u8.permute(0, 3, 1, 2).float() / 255
        x = (mc.resize(x, self.res, self.res) - self.mean) / self.std
        with torch.inference_mode():
            p = self.model(x.to(self.dtype))[-1].sigmoid().float()
        return mc.resize(p, h, w)

    def __call__(self, u8):
        import torch
        out, i = [], 0
        while i < u8.shape[0]:
            sub = u8[i:i + self.bs]
            try:
                out.append(self._infer(sub))
                i += sub.shape[0]
            except Exception as e:
                if not (mc.is_oom(e) and self.bs > 1):
                    raise
                torch.cuda.empty_cache()
                self.bs = max(1, self.bs // 2)
                mc.log(f"mémoire GPU juste : paquets de {self.bs} image(s)")
        return torch.cat(out)


def _finish_mask(m, grow, feather):
    if grow:
        m = mc.grow_mask(m, grow)
    if feather > 0:
        m = mc.gaussian_blur(m, feather / 2.0)    # σ = moitié du réglage : le dégradé du bord fait ≈ « feather » px
    return m.clamp(0, 1)


def _cut(rgb_u8, m, background):
    """rgb [N, H, W, 3] uint8, m [N, 1, H, W] → [N, H, W, 3|4] uint8."""
    import torch
    rgb = rgb_u8.permute(0, 3, 1, 2).float() / 255
    if background == "alpha":                          # couleur intacte (non prémultipliée) + alpha
        out = torch.cat([rgb, m], 1)
    elif background == "green":
        g = torch.tensor(GREEN, device=rgb.device).view(1, 3, 1, 1)
        out = rgb * m + g * (1 - m)
    else:
        out = rgb * m
    return (out.permute(0, 2, 3, 1) * 255 + 0.5).clamp(0, 255).to(torch.uint8)


def _preview_rgb(cut_u8):
    """Aperçu : la transparence est montrée sur un damier gris sombre (comme dans les logiciels d'image)."""
    import torch
    a = cut_u8[0]
    if a.shape[-1] == 3:
        return a
    h, w = a.shape[:2]
    yy, xx = torch.meshgrid(torch.arange(h, device=a.device), torch.arange(w, device=a.device), indexing="ij")
    board = torch.where(((yy // 16 + xx // 16) % 2) == 0, 42.0, 58.0)[..., None]
    al = a[..., 3:4].float() / 255
    return (a[..., :3].float() * al + board * (1 - al)).to(torch.uint8)


def run(job, io):
    import torch

    params = job.get("params") or {}
    background = params.get("background") if params.get("background") in ("black", "green", "alpha") else "black"
    feather = max(0.0, float(params.get("feather", 1) or 0))
    grow = int(round(float(params.get("grow", 0) or 0)))
    out_dir = Path(job.get("outDir") or ".")

    media = mc.Media((job.get("inputs") or {}).get("media"), job)
    io.step(0.01, tr("Chargement du modèle de détourage…", "Loading the cutout model…"))
    device = mc.pick_device()
    res = _resolution()
    t_load = time.monotonic()
    model, dtype = _load(_model_dir(job), device)
    io.check()
    seg = _Segmenter(model, dtype, device, res)
    mc.log(f"BiRefNet prêt en {time.monotonic() - t_load:.1f} s · {device.type} · {res}² · paquets de {seg.bs}")

    # ——— image seule ———
    if media.kind == "image":
        io.step(0.5, tr("Détourage…", "Cutting out…"))
        u8 = mc.to_tensor([media.image()], device)
        m = _finish_mask(seg(u8), grow, feather)
        cut = _cut(u8, m, background)
        mask_path = mc.write_png(out_dir / "mask.png", (m[0, 0] * 255 + 0.5).to(torch.uint8))
        cut_path = mc.write_png(out_dir / "cut.png", cut[0])
        meta = {"w": media.w, "h": media.h}
        return {"mask": {"abs": str(mask_path), "kind": "image", "meta": meta},
                "cut": {"abs": str(cut_path), "kind": "image", "meta": {**meta, "alpha": background == "alpha"}}}

    # ——— vidéo ———
    total = media.frames
    mask_w = mc.VideoWriter(out_dir / "mask.mp4", media.fps)
    cut_w = (mc.AlphaWebmWriter(out_dir / "cut.webm", media.fps, job) if background == "alpha"
             else mc.VideoWriter(out_dir / "cut.mp4", media.fps))
    step_msg = tr("Détourage", "Cutting out")
    io.step(0.08, f"{step_msg}…")
    done, last_preview = 0, 0.0
    chunk = max(seg.bs * 2, 2) if device.type == "cuda" else 2
    try:
        with media.chunks(chunk) as it:
            for _start, frames in it:
                io.check()
                u8 = mc.to_tensor(frames, device)
                m = _finish_mask(seg(u8), grow, feather)
                cut = _cut(u8, m, background)
                mask_w.write((m[:, 0, :, :, None].expand(-1, -1, -1, 3) * 255 + 0.5).to(torch.uint8))
                cut_w.write(cut)
                done += len(frames)
                total = max(total, done)
                # un compte d'images faites (« 48 / 121 images »), pas un numéro d'image : ceux-là partent de 0
                io.frames(done, total, tr(f"{step_msg} · {done} / {total} images", f"{step_msg} · {done} / {total} frames"),
                          0.08, 0.97)
                now = time.monotonic()
                if now - last_preview > PREVIEW_EVERY_S:
                    last_preview = now
                    io.preview_image(_preview_rgb(cut[-1:]))
        io.step(0.98, tr("Écriture des fichiers…", "Writing files…"))
        mask_path, cut_path = mask_w.close(), cut_w.close()
    except BaseException:
        if isinstance(cut_w, mc.AlphaWebmWriter):
            cut_w.abort()
        raise

    w, h = mask_w.size
    meta = {"w": w, "h": h, "fps": float(media.fps), "frames": done}
    return {"mask": {"abs": str(mask_path), "kind": "video", "meta": meta},
            "cut": {"abs": str(cut_path), "kind": "video", "meta": {**meta, "alpha": background == "alpha"}}}
