# -*- coding: utf-8 -*-
"""Superposer : pose un calque sur un fond à travers un masque, en torch sur le GPU.

job = {"inputs": {"bg": {…}, "fg": {…}, "mask": {…} | absent},
       "params": {"feather": px, "match": bool, "strength": 0.75}, "outDir", "lang", "engineRoot"}
→ {"out": {abs, kind, meta}} — une image si le fond est une image, sinon une vidéo (MP4) :
  cadence du fond, longueur = la plus courte des vidéos branchées.

- Masque : l'entrée « Masque » si elle est branchée (sa transparence si elle en a une, sinon sa luminosité), sinon la
  transparence du calque (PNG ou WebM transparents, sortie « Détouré » du bloc Détourer).
- Un calque d'une autre taille que le fond est ajusté dedans, centré, sans déformation (aucun recadrage).
- Accord des couleurs (port d'un script de l'auteur) : moyenne et écart des couleurs du sujet,
  en Lab, ramenés vers ceux du fond, à 75 %, lissés dans le temps (σ = 5 images) pour ne pas pomper.
- Pas de fondu enchaîné, jamais (double exposition) : c'est un simple « over ».
"""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np

import mia_common as mc
from mia_common import tr

LUMA = (0.2126, 0.7152, 0.0722)
STATS_SIDE = 384           # les statistiques de couleur se mesurent sur une image réduite : même résultat, 20× moins cher
PREVIEW_EVERY_S = 1.5


class _Layout:
    """Où tombe le calque dans le fond : ajusté (contain), centré."""

    def __init__(self, fw, fh, W, H):
        s = min(W / fw, H / fh)
        self.nw, self.nh = max(1, round(fw * s)), max(1, round(fh * s))
        self.ox, self.oy = (W - self.nw) // 2, (H - self.nh) // 2
        self.W, self.H = W, H
        self.identity = (fw, fh) == (W, H)

    def place(self, x):
        """[N, C, h, w] flottant → [N, C, H, W], zéros autour (donc transparent pour l'alpha)."""
        import torch.nn.functional as F
        if self.identity and x.shape[-2:] == (self.H, self.W):
            return x
        x = mc.resize(x, self.nh, self.nw)
        return F.pad(x, (self.ox, self.W - self.nw - self.ox, self.oy, self.H - self.nh - self.oy))


def _f(u8):
    """[N, H, W, C] uint8 → [N, C, H, W] flottant 0..1."""
    return u8.permute(0, 3, 1, 2).float() / 255


def _mask_from(u8, use_alpha):
    """Valeur de masque d'une image : son alpha si elle en a un, sinon sa luminosité."""
    import torch
    x = _f(u8)
    if use_alpha and x.shape[1] == 4:
        return x[:, 3:4]
    w = torch.tensor(LUMA, device=x.device).view(1, 3, 1, 1)
    return (x[:, :3] * w).sum(1, keepdim=True)


def _lab_stats(rgb, weight=None):
    """Moyenne et écart-type Lab par image : [N, 3, 2] (NaN si le sujet est trop petit pour être mesuré)."""
    import torch
    small_h = max(8, round(rgb.shape[-2] * min(1.0, STATS_SIDE / max(rgb.shape[-2:]))))
    small_w = max(8, round(rgb.shape[-1] * min(1.0, STATS_SIDE / max(rgb.shape[-2:]))))
    lab = mc.rgb_to_lab(mc.resize(rgb, small_h, small_w))
    if weight is None:
        w = torch.ones_like(lab[:, :1])
    else:
        w = (mc.resize(weight, small_h, small_w) > 0.5).float()
    n = w.sum((2, 3))                                                     # [N, 1]
    mu = (lab * w).sum((2, 3)) / n.clamp(min=1)
    var = ((lab - mu[..., None, None]) ** 2 * w).sum((2, 3)) / n.clamp(min=1)
    st = torch.stack([mu, var.sqrt() + 1e-3], -1)                         # [N, 3, 2]
    st[(n[:, 0] < 50)] = float("nan")
    return st.cpu().numpy()


def _smooth(stats, sigma=5.0):
    """Lissage temporel des statistiques (trous comblés par interpolation), comme `lisse` dans merge_wan_ltx.py."""
    arr = np.array(stats, dtype=np.float64)
    n = arr.shape[0]
    flat = arr.reshape(n, -1)
    idx = np.arange(n)
    r = int(3 * sigma)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    for j in range(flat.shape[1]):
        v = flat[:, j]
        good = ~np.isnan(v)
        if not good.any():
            return None
        v = np.interp(idx, idx[good], v[good])
        flat[:, j] = np.convolve(np.pad(v, r, mode="edge"), k, mode="valid") if n > 1 else v
    return flat.reshape(arr.shape)


def _match(rgb, st_fg, st_bg, strength):
    """Transfert Lab moyenne/écart du calque vers le fond, mélangé à `strength` ; écarts bornés (×0,5 à ×2)."""
    import torch
    if st_fg is None or st_bg is None:
        return rgb
    dev = rgb.device
    sf = torch.as_tensor(st_fg, device=dev, dtype=torch.float32)[..., None, None]   # [N, 3, 2, 1, 1]
    sb = torch.as_tensor(st_bg, device=dev, dtype=torch.float32)[..., None, None]
    lab = mc.rgb_to_lab(rgb)
    ratio = (sb[:, :, 1] / sf[:, :, 1]).clamp(0.5, 2.0)
    tgt = (lab - sf[:, :, 0]) * ratio + sb[:, :, 0]
    return mc.lab_to_rgb(lab + strength * (tgt - lab))


class _Source:
    """Une entrée : soit une image fixe (tenseur gardé, répété), soit une vidéo lue par paquets alignés sur les autres.

    `first_only` : une vidéo réduite à sa 1re image (calque ou masque vidéo posé sur un fond image).
    """

    def __init__(self, media, alpha, device, first_only=False):
        self.media, self.alpha, self.device = media, alpha, device
        self.static = media.kind == "image" or first_only
        self.img = mc.to_tensor([media.image(alpha=alpha)], device) if self.static else None

    def chunks(self, size):
        return self.media.chunks(size, alpha=self.alpha)


def _frames_zip(sources, size):
    """Paquets alignés des entrées vidéo ; les images fixes sont répétées. S'arrête à la plus courte vidéo."""
    from contextlib import ExitStack
    with ExitStack() as stack:
        its = {}
        for key, src in sources.items():
            if src is not None and not src.static:
                its[key] = iter(stack.enter_context(src.chunks(size)))
        if not its:
            yield {k: (s.img if s is not None else None) for k, s in sources.items()}
            return
        while True:
            got = {}
            for key, it in its.items():
                try:
                    got[key] = next(it)[1]
                except StopIteration:
                    return
            n = min(len(v) for v in got.values())
            out = {}
            for key, src in sources.items():
                if src is None:
                    out[key] = None
                elif src.static:
                    out[key] = src.img.expand(n, -1, -1, -1)
                else:
                    out[key] = mc.to_tensor(got[key][:n], src.device)
            yield out
            if any(len(v) > n for v in got.values()):
                return


def run(job, io):
    import torch

    params = job.get("params") or {}
    feather = max(0.0, float(params.get("feather", 2) or 0))
    match = bool(params.get("match", False))
    strength = float(params.get("strength", 0.75))
    out_dir = Path(job.get("outDir") or ".")
    ins = job.get("inputs") or {}

    io.step(0.01, tr("Préparation…", "Preparing…"))
    bg = mc.Media(ins.get("bg"), job)
    fg = mc.Media(ins.get("fg"), job)
    mk = mc.Media(ins["mask"], job) if ins.get("mask") else None
    if mk is None and not fg.alpha:
        raise mc.UserError(tr("Le calque n’a pas de transparence : branche un masque (sortie « Masque » du bloc Détourer) "
                              "ou un calque transparent.",
                              "The layer has no transparency: connect a mask (the Cut out block's Mask output) "
                              "or a transparent layer."))
    device = mc.pick_device()
    W, H = bg.w, bg.h
    lay = _Layout(fg.w, fg.h, W, H)
    # Masque à la taille du fond : déjà dans le repère du fond ; sinon il suit le calque.
    mask_lay = _Layout(W, H, W, H) if mk is not None and (mk.w, mk.h) == (W, H) and not lay.identity else lay

    # Le résultat suit le fond : sur un fond image, un calque ou un masque vidéo ne donne que sa 1re image.
    out_video = bg.kind == "video"
    sources = {
        "bg": _Source(bg, False, device),
        # Calque transparent lu en RGBA même avec un masque : sa couleur non prémultipliée évite un liseré sombre.
        "fg": _Source(fg, mk is None or fg.alpha, device, first_only=not out_video),
        "mask": _Source(mk, mk.alpha, device, first_only=not out_video) if mk is not None else None,
    }

    pixels = W * H
    chunk = int(max(1, min(8, 12_000_000 // max(1, pixels)))) if device.type == "cuda" else 2
    videos = [m for m in (bg, fg, mk) if m is not None and m.kind == "video"]
    total = min(m.frames for m in videos) if (out_video and videos) else 1

    def layer_alpha(fr):
        fgx = _f(fr["fg"])
        rgb = lay.place(fgx[:, :3])
        if fr["mask"] is not None:
            a = mask_lay.place(_mask_from(fr["mask"], sources["mask"].alpha))
        else:
            a = lay.place(fgx[:, 3:4])
        if feather > 0:
            a = mc.gaussian_blur(a, feather / 2.0)
        return rgb, a.clamp(0, 1)

    # ——— 1er passage (accord des couleurs) : mesurer, puis lisser dans le temps ———
    st_fg = st_bg = None
    lo = 0.03
    if match:
        msg = tr("Mesure des couleurs", "Measuring colours")
        io.step(lo, f"{msg}…")
        sf, sb, done = [], [], 0
        for fr in _frames_zip(sources, chunk):
            io.check()
            rgb, a = layer_alpha(fr)
            sf.append(_lab_stats(rgb, a))
            sb.append(_lab_stats(_f(fr["bg"])))
            done += fr["bg"].shape[0]
            io.frames(done, max(total, done), tr(f"{msg} · {done} / {max(total, done)} images",
                                                 f"{msg} · {done} / {max(total, done)} frames"), 0.03, 0.33)
        st_fg, st_bg = _smooth(np.concatenate(sf)), _smooth(np.concatenate(sb))
        if st_fg is None:
            mc.log("accord des couleurs ignoré : sujet trop petit ou absent")
        lo = 0.35

    # ——— 2e passage : composer ———
    msg = tr("Superposition", "Compositing")
    io.step(lo, f"{msg}…")
    writer = mc.VideoWriter(out_dir / "out.mp4", bg.fps) if out_video else None
    done, last_preview, result = 0, 0.0, None
    for fr in _frames_zip(sources, chunk):
        io.check()
        n = fr["bg"].shape[0]
        rgb, a = layer_alpha(fr)
        if st_fg is not None and st_bg is not None and done + n <= len(st_fg):
            rgb = _match(rgb, st_fg[done:done + n], st_bg[done:done + n], strength)
        base = _f(fr["bg"])[:, :3]
        comp = base * (1 - a) + rgb * a
        result = (comp.permute(0, 2, 3, 1) * 255 + 0.5).clamp(0, 255).to(torch.uint8)
        if writer is None:
            break
        writer.write(result)
        done += n
        io.frames(done, max(total, done), tr(f"{msg} · {done} / {max(total, done)} images",
                                             f"{msg} · {done} / {max(total, done)} frames"), lo, 0.97)
        now = time.monotonic()
        if now - last_preview > PREVIEW_EVERY_S:
            last_preview = now
            io.preview_image(result[-1])

    io.step(0.98, tr("Écriture du fichier…", "Writing the file…"))
    if writer is None:
        path = mc.write_png(out_dir / "out.png", result[0])
        return {"out": {"abs": str(path), "kind": "image", "meta": {"w": W, "h": H}}}
    path = writer.close()
    w, h = writer.size
    return {"out": {"abs": str(path), "kind": "video", "meta": {"w": w, "h": h, "fps": float(bg.fps), "frames": done}}}
