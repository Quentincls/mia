# Copie figée de D:\AI_Local_Videos\tool\finish_gpu.py, 17/10/2026 (Mia 0.5.0).
# Ne pas corriger ici : corriger dans le labo, puis recopier (le worker de Mia prend cette copie en priorité).
"""Finition « caméra » sur GPU : mêmes étapes et mêmes réglages que tool.finish (version CPU de référence), 20 à 50
fois plus rapide. Un film entier passe en 1 à 2 minutes au lieu de 25 : on peut itérer sur les réglages.

    from tool import finish_gpu
    fin = finish_gpu.Finisher(flow, cuts={1, 388})          # flow : stabilize.Flow (motion vectors du film)
    out = fin(frame_uint8, t)                               # -> uint8
    out = fin(frame_uint8, t, layer_alpha=a, depth_cm=d)    # flou à deux calques (personnage généré posé au montage)

Flou de mouvement (correctif du 14/10/2026 : double profil sur des images à mouvement rapide) :
- velocity="frame" (défaut) : vitesse = motion vector d'Unreal de la frame elle-même, appliqué symétriquement
  (comme le motion blur d'Unreal) ; "legacy" = ancienne version (moitié aval = vecteurs de la frame suivante
  INVERSÉS : au bord d'un premier plan devant un fond rapide, l'inversion donne au premier plan la vitesse du fond) ;
- cuts : frames t dont les vecteurs vers t-1 traversent une coupe ; pas de flou à travers (frame striée, dédoublée) ;
- layer_alpha (+ depth_cm ou layer_velocity) : le décor est flouté sans ramasser le calque (sinon copies décalées du
  visage = 2e profil), le calque est flouté à SA vitesse puis posé par-dessus (« over »).
Sans CUDA (gpu.DEVICE None), tout tourne sur CPU (lent : contrôles d'une frame seulement).
"""
import numpy as np
import torch
import torch.nn.functional as F

from . import gpu


def _t(a):
    return torch.from_numpy(np.ascontiguousarray(a)).to(gpu.DEVICE)


def _blur_x(img, sigma):
    """Flou horizontal seul (traînées de flare)."""
    r = max(1, int(3 * sigma))
    x = torch.arange(-r, r + 1, device=img.device, dtype=torch.float32)
    k = torch.exp(-x ** 2 / (2 * sigma ** 2))
    k = k / k.sum()
    t = img.permute(2, 0, 1)[None]
    C = t.shape[1]
    t = F.conv2d(F.pad(t, (r, r, 0, 0), mode="replicate"), k.view(1, 1, 1, -1).repeat(C, 1, 1, 1), groups=C)
    return t[0].permute(1, 2, 0)


def near_velocity(v, depth_cm, near_cm=150.0, sigma=15.0, sigma_far=80.0):
    """Vitesse (h, w, 2) du corps proche (profondeur < near_cm) prolongée sur toute l'image (convolution normalisée) :
    vitesse d'un calque généré dont l'alpha déborde la silhouette d'Unreal. v, depth_cm : tenseurs."""
    solid = (depth_cm < near_cm).float()[..., None]
    if float(solid.sum()) < 50:
        return v
    num, den = gpu.blur(v * solid, sigma), gpu.blur(solid, sigma)
    numf, denf = gpu.blur(v * solid, sigma_far), gpu.blur(solid, sigma_far)
    w = (den / 0.05).clamp(0, 1)
    return num / den.clamp(min=1e-4) * w + numf / denf.clamp(min=1e-4) * (1 - w)


class Finisher:
    """velocity : "frame" (vecteur de la frame, symétrique ; défaut) ou "legacy" (flou d'avant le 14/10/2026).
    cuts : frames t dont les vecteurs vers t-1 traversent une coupe (modifiable après coup : fin.cuts = {...}).
    layer_near_cm : profondeur (cm) sous laquelle Unreal donne la vitesse d'un calque (layer_alpha + depth_cm)."""

    def __init__(self, flow, shutter=0.28, samples=8, halo=0.07, vig=0.06, grain_strength=2.0, curve=True,
                 glare=0.012, flare=0.035, ca=0.7, seed=11, cuts=(), velocity="frame", layer_near_cm=150.0):
        if velocity not in ("frame", "legacy"):
            raise ValueError(f"velocity : 'frame' ou 'legacy', pas {velocity!r}")
        self.gf = gpu.GpuFlow(flow)
        self.n = flow.n
        self.__dict__.update(dict(shutter=shutter, samples=samples, halo=halo, vig=vig, grain_strength=grain_strength,
                                  curve=curve, glare=glare, flare=flare, ca=ca, seed=seed, cuts=set(cuts),
                                  velocity_mode=velocity, layer_near_cm=layer_near_cm))
        h, w = flow.h, flow.w
        yy, xx = torch.meshgrid(torch.arange(h, device=gpu.DEVICE, dtype=torch.float32),
                                torch.arange(w, device=gpu.DEVICE, dtype=torch.float32), indexing="ij")
        cx, cy = (w - 1) / 2, (h - 1) / 2
        r = torch.sqrt(((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2) / np.sqrt(2)
        self.vmap = (1 - vig * r ** 2)[..., None]
        rmax = float(np.hypot(cx, cy))
        self.ca_pos = []
        for k in (ca, -ca):
            f = 1 + k / rmax
            self.ca_pos.append(torch.stack([cx + (xx - cx) / f, cy + (yy - cy) / f], -1))

    # --- étapes (x en 0..1, tenseur (h, w, 3)) ---
    def velocity(self, t):
        """Vitesse (h, w, 2), px/frame, de t-1 vers t = motion vector de la frame t lui-même ; si ses vecteurs
        traversent une coupe (ou t = 0) : ceux de la frame suivante inversés ; None si les deux côtés sont coupés."""
        gf, grid, cuts = self.gf, self.gf.grid, self.cuts
        if t > 0 and t not in cuts:
            return grid - gf.map_to(t, t - 1)
        if t + 1 < self.n and (t + 1) not in cuts:
            return gf.map_to(t, t + 1) - grid
        return None

    def _legacy_blur(self, img, t):
        """Flou d'avant le 14/10/2026 (velocity="legacy") : moitié amont = vecteurs de t, moitié aval = vecteurs de
        t+1 inversés."""
        gf, grid, cuts = self.gf, self.gf.grid, self.cuts
        fwd = gf.map_to(t, t + 1) - grid if t + 1 < self.n and (t + 1) not in cuts else None
        bwd = gf.map_to(t, t - 1) - grid if t > 0 and t not in cuts else None
        if fwd is None and bwd is None:
            return img
        fwd = fwd if fwd is not None else -bwd
        bwd = bwd if bwd is not None else -fwd
        acc = torch.zeros_like(img)
        for i in range(self.samples):
            s = (i + 0.5) / self.samples - 0.5
            d = (fwd if s >= 0 else bwd) * (abs(s) * self.shutter)
            acc += gf.warp(img, grid + d, padding="reflection")
        return acc / self.samples

    def _vector_blur(self, img, t, layer=None):
        """layer : (alpha (h, w, 1) 0..1, vitesse du calque (h, w, 2)) ou None (flou classique)."""
        if layer is None and self.velocity_mode == "legacy":
            return self._legacy_blur(img, t)
        gf, grid = self.gf, self.gf.grid
        v = self.velocity(t)
        if v is None:
            return img
        n, sh = self.samples, self.shutter
        if layer is None:
            acc = torch.zeros_like(img)
            for i in range(n):
                s = (i + 0.5) / n - 0.5
                acc += gf.warp(img, grid + v * (s * sh), padding="reflection")
            return acc / n
        # deux calques : décor sans le calque (échantillons pondérés par 1 - alpha), calque prémultiplié à sa vitesse
        a, vf = layer
        ia = torch.cat([img, a], -1).permute(2, 0, 1)                     # 4 canaux : passés en (C, H, W)
        pre = torch.cat([img * a, a], -1).permute(2, 0, 1)
        bg, wb = torch.zeros_like(img), torch.zeros_like(a)
        fg = torch.zeros(img.shape[:2] + (4,), device=img.device)
        for i in range(n):
            s = (i + 0.5) / n - 0.5
            smp = gf.warp(ia, grid + v * (s * sh), padding="reflection")
            wa = 1 - smp[..., 3:4]
            bg += wa * smp[..., :3]
            wb += wa
            fg += gf.warp(pre, grid + vf * (s * sh), padding="reflection")
        bg = torch.where(wb > 1e-3, bg / wb.clamp(min=1e-3), img)
        fg = fg / n
        return fg[..., :3] + (1 - fg[..., 3:4]) * bg

    def _layer(self, layer_alpha, depth_cm, layer_velocity, t):
        """(alpha, vitesse du calque) pour _vector_blur, ou None (pas de calque, ou pas de vitesse à cette frame)."""
        if layer_alpha is None or float(layer_alpha.max()) <= 0.01:
            return None
        v = self.velocity(t)
        if v is None:
            return None
        T = lambda a: (a if torch.is_tensor(a) else _t(np.asarray(a, np.float32))).float()
        a = T(layer_alpha)
        if layer_velocity is not None:
            vf = T(layer_velocity)
        elif depth_cm is not None:
            vf = near_velocity(v, T(depth_cm), self.layer_near_cm)
        else:
            vf = v
        return a.reshape(a.shape[0], a.shape[1], 1), vf

    @staticmethod
    def _peaks(x, threshold):
        lum = x.max(-1, keepdim=True).values
        local = gpu.blur(lum, 40)
        return ((lum - threshold) / (1 - threshold)).clamp(0, 1) * ((lum - local) / 0.08).clamp(0, 1)

    def _veil(self, x):
        lum = x.mean(-1, keepdim=True)
        return x + self.glare * gpu.blur(x * lum ** 2, 200)

    def _halation(self, x, threshold=0.80, sigma=16.0):
        hi = x * self._peaks(x, threshold)
        glow = gpu.blur(hi, sigma) + 0.5 * gpu.blur(hi, sigma * 3)
        return (x + self.halo * glow).clamp(0, 1)

    def _streaks(self, x, threshold=0.95, length=45.0):
        hi = x * self._peaks(x, threshold)
        if float(hi.max()) <= 0:
            return x
        st = gpu.blur(_blur_x(hi, length), 1.2) * 6.0
        return x + self.flare * st

    @staticmethod
    def _curve(x, shoulder=0.80, contrast=0.10, highlight_desat=0.15):
        Y = x.max(-1, keepdim=True).values
        s = shoulder
        e = 1 - np.exp(-1.6)
        roll = torch.where(Y > s, s + (1 - s) * (1 - torch.exp(-(Y - s) / (1 - s) * 1.6)) / e, Y)
        sc = roll + contrast * (roll - 0.5) * 4 * roll * (1 - roll) * ((roll - 0.04) / 0.12).clamp(0, 1)
        sc = sc.clamp(0, 1)
        out = x * (sc / Y.clamp(min=1e-4))
        hd = ((sc - 0.85) / 0.15).clamp(0, 1) * highlight_desat * ((x.min(-1, keepdim=True).values - 0.75) / 0.2).clamp(0, 1)
        m = out.mean(-1, keepdim=True)
        return (out * (1 - hd) + m * hd).clamp(0, 1)

    def _chromatic(self, x):
        out = x.clone()
        out[..., 0:1] = self.gf.warp(x[..., 0:1].contiguous(), self.ca_pos[0], padding="reflection")
        out[..., 2:3] = self.gf.warp(x[..., 2:3].contiguous(), self.ca_pos[1], padding="reflection")
        return out

    def _grain(self, x, t, size=0.7):
        h, w = x.shape[:2]
        g = torch.Generator(device=gpu.DEVICE)
        g.manual_seed(self.seed * 100003 + t)
        n = torch.randn((h, w, 1), generator=g, device=gpu.DEVICE)
        c = torch.randn((h, w, 3), generator=g, device=gpu.DEVICE) * 0.15
        n, c = gpu.blur(n, size), gpu.blur(c, size)
        n = n / (n.std() + 1e-6)
        lum = x.mean(-1, keepdim=True)
        amp = self.grain_strength / 255.0 * (0.35 + 2.6 * lum * (1 - lum))
        return x + amp * (n + c)

    @torch.no_grad()
    def __call__(self, img_u8, t, overlay=None, layer_alpha=None, depth_cm=None, layer_velocity=None):
        """overlay : calque 0..1 (h, w, 3), composé en « écran » APRÈS le flou de mouvement des motion vectors et AVANT
        voile, halo, courbe, aberration, vignette et grain : éléments ajoutés qui ont leur propre flou de bougé
        (particules filmées posées dans le monde, tool.particles) mais doivent passer par la même optique et le même
        grain que le reste.
        layer_alpha (h, w) 0..1 : alpha d'un calque généré déjà posé dans l'image (la fille du montage) -> flou à deux
        calques. Vitesse du calque : layer_velocity (h, w, 2) px/frame si donnée, sinon celle d'Unreal du corps proche
        (depth_cm (h, w) : profondeur Unreal en cm, < layer_near_cm) prolongée sur l'alpha, sinon celle de l'image."""
        x = _t(img_u8).float() / 255.0
        if self.shutter > 0:
            x = self._vector_blur(x, t, self._layer(layer_alpha, depth_cm, layer_velocity, t))
        if overlay is not None:
            o = overlay if torch.is_tensor(overlay) else _t(overlay)
            x = 1 - (1 - x) * (1 - o.float().clamp(0, 1))
        if self.glare > 0:
            x = self._veil(x)
        if self.halo > 0:
            x = self._halation(x.clamp(0, 1))
        if self.flare > 0:
            x = self._streaks(x)
        if self.curve:
            x = self._curve(x.clamp(0, 1))
        if self.ca > 0:
            x = self._chromatic(x)
        if self.vig > 0:
            x = x * self.vmap
        if self.grain_strength > 0:
            x = self._grain(x, t)
        return (x.clamp(0, 1) * 255.0).round().byte().cpu().numpy()
