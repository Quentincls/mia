# Copie figée de D:\AI_Local_Videos\tool\lut_gpu.py, 17/10/2026 (Mia 0.5.0).
# Ne pas corriger ici : corriger dans le labo, puis recopier (le worker de Mia prend cette copie en priorité).
"""LUT 3D (.cube) appliquée sur GPU (interpolation trilinéaire par grid_sample 3D), avec un dosage.

from tool.lut_gpu import Lut ; lut = Lut("…/etalo_33.cube") ; out_uint8 = lut(frame_uint8, force=0.8)
"""
import numpy as np
import torch
import torch.nn.functional as F


class Lut:
    def __init__(self, path, device="cuda"):
        n, rows = None, []
        for line in open(path, encoding="utf-8", errors="ignore"):
            t = line.strip().split()
            if not t or t[0].startswith("#"):
                continue
            if t[0] == "LUT_3D_SIZE":
                n = int(t[1])
            elif len(t) == 3:
                try:
                    rows.append([float(v) for v in t])
                except ValueError:
                    pass
        a = np.array(rows, np.float32).reshape(n, n, n, 3)          # ordre .cube : R varie le plus vite -> [b, g, r]
        self.t = torch.from_numpy(a).permute(3, 0, 1, 2)[None].to(device)   # (1, 3, B, G, R)
        self.dev = device

    def __call__(self, img, force=1.0, garde_chauds=0.0):
        x = torch.from_numpy(np.ascontiguousarray(img)).to(self.dev).float() / 255
        g = (x * 2 - 1)[None, None]                                  # (1, 1, H, W, 3) : x=R, y=G, z=B
        y = F.grid_sample(self.t, g, mode="bilinear", padding_mode="border", align_corners=True)[0, :, 0]
        y = y.permute(1, 2, 0)
        out = x * (1 - force) + y * force
        if garde_chauds > 0:
            # les rouges / oranges saturés gardent leur teinte d'origine (salle rouge, mèche, lèvres : Quentin 16/10)
            # : on reprend leur chroma d'origine en gardant la luminance de la LUT
            mx, mn = x.max(-1).values, x.min(-1).values
            sat = (mx - mn) / (mx + 1e-4)
            r, g, b = x[..., 0], x[..., 1], x[..., 2]
            chaud = ((r >= g) & (g >= b)).float() + ((r >= b) & (b > g)).float() * ((r - b) / (r - g + 1e-4)).clamp(0, 1)
            w = (sat * 1.5).clamp(0, 1) * chaud.clamp(0, 1) * garde_chauds * ((mx - 0.08) / 0.12).clamp(0, 1)   # pas les tons très sombres
            lum = lambda c: (c * torch.tensor([0.2126, 0.7152, 0.0722], device=self.dev)).sum(-1, keepdim=True)
            orig_rel = x * (lum(out) / (lum(x) + 1e-4)).clamp(0, 3)
            out = out * (1 - w[..., None]) + orig_rel * w[..., None]
        return (out.clamp(0, 1) * 255 + 0.5).byte().cpu().numpy()
