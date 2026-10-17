# Copie figée de D:\AI_Local_Videos\tool\gpu.py, 17/10/2026 (Mia 0.5.0).
# Ne pas corriger ici : corriger dans le labo, puis recopier (le worker de Mia prend cette copie en priorité).
"""Version GPU (PyTorch) des opérations lourdes de stabilize/propagate : composition des flux et recalages.

Mêmes conventions que stabilize.Flow (flux à mi-résolution, bwd[t] : pixel de t+1 -> position en t). Si torch/CUDA
n'est pas disponible, on reste sur la version NumPy (stabilize.py) : l'outil continue de marcher partout.
"""
import numpy as np

try:
    import torch
    import torch.nn.functional as F
    DEVICE = "cuda" if torch.cuda.is_available() else None
except ImportError:  # pragma: no cover
    torch, DEVICE = None, None


def available():
    return DEVICE is not None


def _t(a):
    return torch.from_numpy(np.ascontiguousarray(a)).to(DEVICE)


class GpuFlow:
    """Flux sur GPU. map_to(t, s) renvoie une carte pleine résolution (h, w, 2) en pixels, sur GPU."""

    def __init__(self, flow):
        self.n, self.h, self.w = flow.n, flow.h, flow.w
        self.sw, self.sh, self.scale = flow.sw, flow.sh, flow.scale
        self.bwd = torch.stack([_t(b) for b in flow.bwd]).half()  # (n-1, sh, sw, 2)
        self.fwd = torch.stack([_t(f) for f in flow.fwd]).half() if flow.fwd else None
        ys, xs = torch.meshgrid(torch.arange(self.sh, device=DEVICE, dtype=torch.float32),
                                torch.arange(self.sw, device=DEVICE, dtype=torch.float32), indexing="ij")
        self.sgrid = torch.stack([xs, ys], -1)
        ys, xs = torch.meshgrid(torch.arange(self.h, device=DEVICE, dtype=torch.float32),
                                torch.arange(self.w, device=DEVICE, dtype=torch.float32), indexing="ij")
        self.grid = torch.stack([xs, ys], -1)

    @staticmethod
    def _sample(img, pos, mode="bilinear", padding="border"):
        """img (H, W, C) ou (C, H, W) ; pos (h, w, 2) en pixels de img -> (h, w, C)."""
        if img.dim() == 3 and img.shape[-1] in (1, 2, 3):
            img = img.permute(2, 0, 1)
        C, H, W = img.shape
        g = torch.empty_like(pos)
        g[..., 0] = (pos[..., 0] + 0.5) / W * 2 - 1
        g[..., 1] = (pos[..., 1] + 0.5) / H * 2 - 1
        out = F.grid_sample(img[None].float(), g[None].float(), mode=mode, padding_mode=padding, align_corners=False)
        return out[0].permute(1, 2, 0)

    def map_to(self, t, s):
        if s == t:
            return self.grid
        pos = self.sgrid.clone()
        step = 1 if s > t else -1
        for k in range(t, s, step):
            fl = self.fwd[k] if step == 1 else self.bwd[k - 1]
            pos = pos + self._sample(fl.float(), pos)
        up = F.interpolate(pos.permute(2, 0, 1)[None], size=(self.h, self.w), mode="bilinear", align_corners=False)[0]
        return (up.permute(1, 2, 0) + 0.5) / self.scale - 0.5

    def warp(self, img, pos, padding="reflection"):
        return self._sample(img, pos, padding=padding)


def stabilize(ai_frames, ref_frames, flow, radius=3, tau=2.0, ai_tol=20.0, write=None, log=print):
    """Stabilisation (méthode B) sur GPU, double contrôle Unreal + IA. Renvoie la liste des frames si write est None."""
    gf = GpuFlow(flow)
    T = lambda a: torch.from_numpy(np.ascontiguousarray(a)).to(DEVICE)
    refs = [T(f) for f in ref_frames]
    ais = [T(f) for f in ai_frames]
    n, out = len(ais), []
    for t in range(n):
        with torch.no_grad():
            acc = ais[t].float().clone()
            wsum = torch.ones(acc.shape[:2] + (1,), device=DEVICE)
            for s in range(max(0, t - radius), min(n, t + radius + 1)):
                if s == t:
                    continue
                pos = gf.map_to(t, s)
                wa = gf.warp(ais[s], pos)
                v = validity(refs[t], gf.warp(refs[s], pos)) * validity(ais[t], wa, ai_tol) * float(np.exp(-abs(s - t) / tau))
                acc += v * wa
                wsum += v
            f = (acc / wsum).clamp(0, 255).byte().cpu().numpy()
        write(f) if write else out.append(f)
        if t % 48 == 0:
            log(f"   stabilisation gpu {t}/{n}")
    return out


def temporal_lock(gen_frames, ref_frames, flow, step=12, tol=14.0, gen_tol=30.0, log=print):
    """Verrou temporel pour un contenu GÉNÉRÉ (personnage) : chaque frame = images générées clés (une toutes les
    `step` frames) transportées par le mouvement exact d'Unreal, là où ce transport est fiable ; ailleurs (rotation
    rapide, zones découvertes, contenu trop différent) on garde la frame générée elle-même, jamais Unreal :
    le personnage garde son identité, et ne « bouillonne » plus là où le mouvement est connu."""
    gf = GpuFlow(flow)
    T = lambda a: torch.from_numpy(np.ascontiguousarray(a)).to(DEVICE)
    refs = [T(f) for f in ref_frames]
    gens = [T(np.clip(g, 0, 255).astype(np.uint8)) for g in gen_frames]
    n = len(gens)
    idx = sorted(set(range(0, n, step)) | {n - 1})
    out = []
    for t in range(n):
        with torch.no_grad():
            g_t = gens[t].float()
            prev = max(k for k in idx if k <= t)
            nxt = min(k for k in idx if k >= t)
            if prev == t or nxt == t:
                out.append(gens[t].cpu().numpy()); continue
            acc = torch.zeros_like(g_t)
            wsum = torch.zeros(g_t.shape[:2] + (1,), device=DEVICE)
            for k in (prev, nxt):
                pos = gf.map_to(t, k)
                wk = gf.warp(gens[k], pos)
                h, w = g_t.shape[:2]
                inside = ((pos[..., 0] >= 0) & (pos[..., 0] <= w - 1) & (pos[..., 1] >= 0) & (pos[..., 1] <= h - 1)).float()[..., None]
                v = validity(refs[t], gf.warp(refs[k], pos), tol) * validity(g_t, wk, gen_tol) * blur(inside, 3)
                wt = 1.0 - abs(t - k) / (nxt - prev)
                acc += v * wt * wk
                wsum += v * wt
            cover = (wsum / 1.0).clamp(0, 1)
            locked = acc / wsum.clamp(min=1e-3)
            out.append((locked * cover + g_t * (1 - cover)).clamp(0, 255).byte().cpu().numpy())
        if t % 48 == 0:
            log(f"   verrou {t}/{n}")
    return out


def validity(ref_t, ref_s_warped, tol=12.0):
    d = (ref_t.float() - ref_s_warped.float()).abs().mean(-1, keepdim=True)
    v = (1.5 - d / tol).clamp(0, 1)
    return blur(v, 2)


def blur(img, sigma):
    """Flou gaussien séparable (h, w, C) sur GPU. Grands rayons : réduit -> floute -> agrandit (équivalent, plus rapide)."""
    if sigma > 24:
        f = sigma / 12.0
        h, w = img.shape[:2]
        t = img.permute(2, 0, 1)[None].float()
        small = F.interpolate(t, size=(max(2, round(h / f)), max(2, round(w / f))), mode="area")[0].permute(1, 2, 0)
        b = blur(small, 12.0)
        return F.interpolate(b.permute(2, 0, 1)[None], size=(h, w), mode="bilinear", align_corners=False)[0].permute(1, 2, 0)
    r = max(1, int(3 * sigma))
    x = torch.arange(-r, r + 1, device=img.device, dtype=torch.float32)
    k = torch.exp(-x ** 2 / (2 * sigma ** 2))
    k = k / k.sum()
    t = img.permute(2, 0, 1)[None].float()
    C = t.shape[1]
    t = F.conv2d(F.pad(t, (r, r, 0, 0), mode="replicate"), k.view(1, 1, 1, -1).repeat(C, 1, 1, 1), groups=C)
    t = F.conv2d(F.pad(t, (0, 0, r, r), mode="replicate"), k.view(1, 1, -1, 1).repeat(C, 1, 1, 1), groups=C)
    return t[0].permute(1, 2, 0)
