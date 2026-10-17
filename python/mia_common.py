# -*- coding: utf-8 -*-
"""Mia — outils communs du worker Python (protocole, appareil de calcul, lecture et écriture d'images et de vidéos).

Le worker est lancé par electron/engine/pyrun.js :  python -B -u mia_worker.py <tâche> <job.json>  (cwd = dossier du run).
Chaque ligne « @mia {json} » de stdout est un message pour Mia (SPEC §8.4) :
    {"p": 0.42, "msg": "…", "eta": 12}     progression (p dans 0..1, ou null si inconnue), secondes restantes
    {"preview": "C:/…/_preview/003.jpg"}   aperçu à montrer dans le bloc pendant le calcul (effacé en fin de tâche)
    {"done": true, "outputs": {…}}         fin (écrit par mia_worker.py)
    {"error": "…"}                         échec, message lisible
Tout le reste (print, avertissements des bibliothèques) va dans le journal du run.

Règles reprises ici : le calcul image se fait sur le GPU (torch), l'encodage en h264_nvenc, et rien n'est jamais
écrit dans le dossier du moteur (engineRoot) — on n'y lit que les modèles et ffmpeg.
Variables d'environnement utiles aux essais : MIA_DEVICE=cpu (aucun usage du GPU), MIA_NO_NVENC=1 (encodage libx264).
"""
from __future__ import annotations

import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from fractions import Fraction
from pathlib import Path

import numpy as np

# ——————————————————————————————————————————————————————— langue

_LANG = "fr"


def set_lang(lang):
    global _LANG
    _LANG = "en" if str(lang or "").lower().startswith("en") else "fr"


def tr(fr, en):
    """Chaîne dans la langue de l'interface ; le français d'abord (Quentin ne lit pas l'anglais)."""
    return en if _LANG == "en" else fr


# ——————————————————————————————————————————————————————— erreurs


class UserError(Exception):
    """Erreur attendue : son message, déjà traduit, s'affiche tel quel dans le bloc."""


class Cancelled(Exception):
    """L'utilisateur a annulé (le moteur a déposé le fichier « cancel » dans le dossier du run)."""


# ——————————————————————————————————————————————————————— protocole @mia

_out_lock = threading.Lock()


def emit(obj):
    """Un message pour Mia, sur une ligne, vidé tout de suite (pyrun lit stdout ligne par ligne)."""
    line = "@mia " + json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    with _out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def log(*parts):
    """Une ligne de journal (jamais confondue avec le protocole)."""
    text = " ".join(str(p) for p in parts)
    with _out_lock:
        for ln in text.splitlines() or [""]:
            sys.stdout.write((" " + ln if ln.startswith("@mia") else ln) + "\n")
        sys.stdout.flush()


class IO:
    """Ce que le worker offre à une tâche : progress(p, msg, eta), preview(path), cancelled(), check(), log()."""

    def __init__(self, job, out_dir):
        self.job = job
        self.out_dir = Path(out_dir)
        self._cancel_file = self.out_dir / "cancel"
        self._last_emit = 0.0
        self._loop = None            # (instant, images faites) au début de la boucle d'images, pour le temps restant
        self._rate = None            # images par seconde, lissées
        self._previews = []          # aperçus encore sur le disque (les deux derniers)
        self._preview_n = 0
        # Même dossier que les aperçus de ComfyUI : le moteur le supprime aussi à la fin du run (index.js).
        self._preview_dir = self.out_dir / "_preview"

    # — progression —
    def progress(self, p=None, msg=None, eta=None, force=False):
        """Progression globale. Limitée à ~5 messages par seconde, sauf `force` (changement d'étape)."""
        now = time.monotonic()
        if not force and now - self._last_emit < 0.2 and (p is None or p < 1):
            return
        self._last_emit = now
        d = {"p": None if p is None else round(min(1.0, max(0.0, float(p))), 4)}
        if msg is not None:
            d["msg"] = msg
        if eta is not None:
            d["eta"] = max(0, int(round(eta)))
        emit(d)

    def step(self, p, msg):
        """Début d'une étape (chargement du modèle, écriture…) : toujours envoyé."""
        self.progress(p, msg, force=True)

    def frames(self, done, total, msg, lo=0.0, hi=1.0):
        """Progression d'une boucle d'images, avec le temps restant mesuré sur la boucle elle-même."""
        now = time.monotonic()
        if self._loop is None or done < self._loop[1]:
            self._loop, self._rate = (now, done), None
        t0, d0 = self._loop
        eta = None
        if total and done > d0 and now - t0 > 0.3:
            r = (done - d0) / (now - t0)
            self._rate = r if self._rate is None else 0.7 * self._rate + 0.3 * r
            eta = max(0, total - done) / max(self._rate, 1e-6)
        p = lo + (hi - lo) * min(1.0, done / total) if total else None
        self.progress(p, msg, eta, force=done == total)

    # — aperçus —
    def preview(self, path):
        emit({"preview": str(path)})

    def preview_image(self, rgb):
        """Écrit un petit JPEG d'aperçu dans <run>\\_preview\\ et le signale. On n'en garde que deux sur le disque,
        et cleanup() efface le reste en fin de tâche : rien ne traîne à côté des sorties."""
        path = self._preview_dir / f"{self._preview_n:03d}.jpg"   # nom neuf à chaque fois : pas de cache périmé
        self._preview_n += 1
        try:
            self._preview_dir.mkdir(parents=True, exist_ok=True)
            save_jpeg(path, rgb, max_side=640)
        except Exception as e:  # un aperçu raté ne doit jamais faire échouer le calcul
            log("aperçu ignoré :", e)
            return
        self.preview(path)
        self._previews.append(path)
        while len(self._previews) > 2:
            try:
                self._previews.pop(0).unlink()
            except OSError:
                pass

    def cleanup(self):
        """Fin de tâche (finie, en échec ou annulée) : efface les aperçus et le dossier _preview s'il est vide."""
        for p in self._previews:
            try:
                p.unlink()
            except OSError:
                pass
        self._previews = []
        # anciens noms (« _preview_003.jpg » à la racine du run, avant le dossier _preview)
        for p in list(self.out_dir.glob("_preview_*.jpg")) + list(self._preview_dir.glob("*.jpg")):
            try:
                p.unlink()
            except OSError:
                pass
        try:
            self._preview_dir.rmdir()
        except OSError:
            pass

    # — annulation, journal —
    def cancelled(self):
        return self._cancel_file.exists()

    def check(self):
        if self.cancelled():
            raise Cancelled()

    def log(self, *parts):
        log(*parts)


# ——————————————————————————————————————————————————————— chemins, appareil

def engine_root(job=None):
    """Dossier du moteur (lecture seule) : job.json, puis MIA_ENGINE_ROOT, puis PYTHONPATH posé par pyrun ; None sans moteur.

    Aucun chemin par défaut : Mia (electron/places.js) choisit le moteur et le passe ici."""
    cands = [(job or {}).get("engineRoot"), os.environ.get("MIA_ENGINE_ROOT")]
    cands += os.environ.get("PYTHONPATH", "").split(os.pathsep)
    for c in cands:
        if c and (Path(c) / "models").is_dir():
            return Path(c)
    return None


# Copie figée des modules tool.* du labo (SPEC §21.3) : mia_worker.py met ce dossier en tête de sys.path.
VENDOR_DIR = Path(__file__).resolve().parent / "vendor"


def tool_origin():
    """D'où viendra `import tool` (pour le journal) : la copie figée de Mia, le labo, ou rien — sans l'importer."""
    import importlib.util
    try:
        spec = importlib.util.find_spec("tool")
    except (ImportError, ValueError):
        spec = None
    if spec is None or not spec.submodule_search_locations:
        return tr("introuvable", "not found")
    first = Path(list(spec.submodule_search_locations)[0]).resolve()
    if first == (VENDOR_DIR / "tool").resolve():
        return tr("copie figée de Mia (python/vendor)", "Mia's frozen copy (python/vendor)")
    return tr(f"moteur ({first})", f"engine ({first})")


def ffmpeg_exe(job=None):
    """Le ffmpeg de Mia (job.ffmpeg : celui du moteur, d'un ComfyUI portable ou du PATH), sinon celui d'imageio-ffmpeg."""
    root = engine_root(job)
    cands = [(job or {}).get("ffmpeg"), os.environ.get("MIA_FFMPEG")]
    if root is not None:
        bins = root / "env" / "venv" / "Lib" / "site-packages" / "imageio_ffmpeg" / "binaries"
        cands += sorted((str(p) for p in bins.glob("ffmpeg-*.exe")), reverse=True) if bins.is_dir() else []
    for c in cands:
        if c and Path(c).is_file():
            return str(c)
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        raise UserError(tr("ffmpeg introuvable : vérifie le dossier du moteur dans les réglages.",
                           "ffmpeg not found: check the engine folder in the settings."))


def pick_device():
    """cuda par défaut (règle du labo : tout sur le GPU) ; MIA_DEVICE=cpu pour les essais sans GPU."""
    import torch
    want = (os.environ.get("MIA_DEVICE") or "cuda").strip().lower()
    if want != "cpu":
        if torch.cuda.is_available():
            torch.backends.cudnn.benchmark = True      # tailles fixes d'une image à l'autre : cuDNN choisit le plus rapide
            return torch.device("cuda")
        log("CUDA indisponible : calcul sur le processeur (lent).")
    # sur le processeur, laisser de la marge à la machine (Unreal, Slate, l'interface de Mia)
    torch.set_num_threads(max(1, min(8, (os.cpu_count() or 4) // 2)))
    return torch.device("cpu")


def is_oom(exc):
    """Mémoire GPU épuisée (torch ≥ 2 lève OutOfMemoryError ; les anciens messages restent reconnus)."""
    name = type(exc).__name__
    return name == "OutOfMemoryError" or "out of memory" in str(exc).lower()


def release_gpu():
    """Fin de tâche : rend la mémoire GPU tout de suite (modèle et tenseurs déjà libérés par la tâche), sans attendre
    la fin du processus — le verrou du labo est relâché juste après, le calcul suivant doit trouver la carte vide.
    Sans effet si torch n'a jamais été chargé ou si CUDA n'a pas servi."""
    torch = sys.modules.get("torch")
    if torch is None:
        return
    import gc
    gc.collect()
    try:
        if torch.cuda.is_available() and torch.cuda.is_initialized():
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
            log(f"mémoire GPU rendue (encore réservée : {torch.cuda.memory_reserved() / 2 ** 20:.0f} Mo)")
    except Exception as e:  # ne jamais transformer une fin réussie en échec pour ça
        log("libération de la mémoire GPU incomplète :", e)


# ——————————————————————————————————————————————————————— conversions

def as_numpy(x):
    """Tenseur torch (n'importe quel appareil) ou tableau → tableau numpy uint8 contigu."""
    if hasattr(x, "detach"):
        import torch
        x = x.detach()
        if x.dtype.is_floating_point:
            x = (x.clamp(0, 1) * 255 + 0.5).to(torch.uint8)
        x = x.cpu().numpy()
    a = np.asarray(x)
    if a.dtype != np.uint8:
        a = np.clip(a, 0, 255).astype(np.uint8)
    return np.ascontiguousarray(a)


def flatten(a):
    """RGBA → RGB posé sur du noir (couleur × alpha) ; RGB rendu tel quel."""
    if a.ndim != 3 or a.shape[2] != 4:
        return a
    rgb = (a[..., :3].astype(np.uint16) * a[..., 3:4] + 127) // 255
    return np.ascontiguousarray(rgb.astype(np.uint8))


def pad_even(a):
    """H.264/VP9 en 4:2:0 veulent des côtés pairs : on recopie la dernière ligne/colonne plutôt que de couper."""
    h, w = a.shape[:2]
    ph, pw = h % 2, w % 2
    if not (ph or pw):
        return a
    pad = ((0, ph), (0, pw)) + ((0, 0),) * (a.ndim - 2)
    return np.pad(a, pad, mode="edge")


def fps_text(fps):
    f = Fraction(fps).limit_denominator(1001)
    return f"{f.numerator}/{f.denominator}"


# ——————————————————————————————————————————————————————— images

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".exr", ".psd", ".tga", ".gif"}
_ALPHA_PIX = re.compile(r"^(yuva|gbrap|rgba|bgra|argb|abgr|ya\d)")


def _srgb_encode(lin):
    lin = np.clip(lin, 0.0, 1.0)
    return np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1 / 2.4) - 0.055)


def _read_exr(path):
    """EXR (beauty linéaire d'Unreal) → sRGB 8 bits, alpha gardé s'il existe."""
    import OpenEXR
    with OpenEXR.File(str(path), separate_channels=True) as f:
        ch = f.parts[0].channels
        names = {k.split(".")[-1].upper(): k for k in ch}
        if not all(c in names for c in "RGB"):
            raise UserError(tr("Cet EXR n’a pas de couches R, G, B lisibles.", "This EXR has no readable R, G, B layers."))
        rgb = np.dstack([np.asarray(ch[names[c]].pixels, np.float32) for c in "RGB"])
        out = (_srgb_encode(rgb) * 255 + 0.5).astype(np.uint8)
        if "A" in names:
            a = np.clip(np.asarray(ch[names["A"]].pixels, np.float32), 0, 1)
            out = np.dstack([out, (a * 255 + 0.5).astype(np.uint8)])
        return out


def read_image(path, alpha=False):
    """Image → tableau HxWx3 (ou HxWx4 si `alpha`) uint8. Gère le 16 bits, les palettes et l'EXR."""
    path = Path(path)
    if path.suffix.lower() == ".exr":
        a = _read_exr(path)
    else:
        from PIL import Image, ImageOps
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im)        # photos de téléphone : respecter l'orientation
            if im.mode in ("I;16", "I;16B", "I;16L", "I"):
                a = np.asarray(im, dtype=np.float32)
                a = (np.clip(a / (65535.0 if a.max() > 255 else 255.0), 0, 1) * 255 + 0.5).astype(np.uint8)
            elif im.mode == "F":
                a = (np.clip(np.asarray(im, np.float32), 0, 1) * 255 + 0.5).astype(np.uint8)
            else:
                has_a = im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)
                a = np.asarray(im.convert("RGBA" if has_a else "RGB"))
    if a.ndim == 2:
        a = np.dstack([a, a, a])
    if alpha and a.shape[2] == 3:
        a = np.dstack([a, np.full(a.shape[:2], 255, np.uint8)])
    elif not alpha and a.shape[2] == 4:
        a = a[..., :3]
    return np.ascontiguousarray(a)


def image_has_alpha(path):
    path = Path(path)
    if path.suffix.lower() == ".exr":
        try:
            import OpenEXR
            with OpenEXR.File(str(path), separate_channels=True) as f:
                return any(k.split(".")[-1].upper() == "A" for k in f.parts[0].channels)
        except Exception:
            return False
    from PIL import Image
    with Image.open(path) as im:
        return im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)


def write_png(path, arr):
    """PNG sans perte (règle du labo entre deux étapes). arr : HxW (gris), HxWx3 ou HxWx4."""
    from PIL import Image
    a = as_numpy(arr)
    if a.ndim == 3 and a.shape[2] == 1:
        a = a[..., 0]
    mode = {2: "L", 3: "RGB", 4: "RGBA"}[a.ndim if a.ndim == 2 else a.shape[2]]
    Image.fromarray(a, mode).save(str(path), compress_level=4)
    return Path(path)


def save_jpeg(path, arr, max_side=640, quality=84):
    from PIL import Image
    a = as_numpy(arr)
    if a.ndim == 3 and a.shape[2] == 4:
        a = a[..., :3]
    im = Image.fromarray(a)
    if max(im.size) > max_side:
        im.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    im.save(str(path), quality=quality)
    return Path(path)


# ——————————————————————————————————————————————————————— lecture de médias


class _Prefetch:
    """Fait tourner un générateur dans un fil à part : le CPU décode la suite pendant que le GPU calcule."""

    def __init__(self, gen, depth=2):
        self._q = queue.Queue(maxsize=depth)
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._run, args=(gen,), daemon=True)
        self._t.start()

    def _put(self, item):
        while not self._stop.is_set():
            try:
                self._q.put(item, timeout=0.2)
                return True
            except queue.Full:
                continue
        return False

    def _run(self, gen):
        try:
            for item in gen:
                if not self._put(("item", item)):
                    break
            self._put(("end", None))
        except BaseException as e:      # remonté tel quel au fil principal
            self._put(("error", e))
        finally:
            gen.close()                  # ferme le conteneur PyAV / arrête ffmpeg dans le fil qui les a ouverts

    def __iter__(self):
        while True:
            kind, val = self._q.get()
            if kind == "item":
                yield val
            elif kind == "end":
                return
            else:
                raise val

    def close(self):
        self._stop.set()
        try:
            while True:
                self._q.get_nowait()
        except queue.Empty:
            pass
        self._t.join(timeout=3)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


class Media:
    """Une entrée de bloc (image ou vidéo) : sondée à l'ouverture, lue ensuite par paquets d'images.

    spec = {"abs": chemin, "kind": "image"|"video", "meta": {…}, "skipFirst": bool} (ce que l'exécuteur JS transmet).
    """

    def __init__(self, spec, job=None):
        if not spec or not spec.get("abs"):
            raise UserError(tr("Une entrée n’est pas branchée.", "An input is not connected."))
        self.path = str(spec["abs"])
        self.name = Path(self.path).name
        self.job = job or {}
        if not Path(self.path).is_file():
            raise UserError(tr(f"Fichier introuvable : {self.name}", f"File not found: {self.name}"))
        ext = Path(self.path).suffix.lower()
        self.kind = spec.get("kind") or ("image" if ext in IMAGE_EXT else "video")
        self.skip_first = bool(spec.get("skipFirst")) and self.kind == "video"
        self.vpx_alpha = False
        self.codec = None
        self.rot_k = 0                      # quarts de tour (sens trigonométrique) pour redresser l'image
        if self.kind == "image":
            self._probe_image()
        else:
            self._probe_video()

    def _probe_image(self):
        try:
            self.alpha = image_has_alpha(self.path)
            a = read_image(self.path, alpha=self.alpha)
        except UserError:
            raise
        except Exception as e:
            raise UserError(tr(f"Image illisible : {self.name} ({e})", f"Unreadable image: {self.name} ({e})"))
        self.h, self.w = a.shape[:2]
        self.fps, self.frames = None, 1
        self._image_cache = a                # RGBA si l'image est transparente, sinon RGB

    def _probe_video(self):
        import av
        try:
            with av.open(self.path) as c:
                if not c.streams.video:
                    raise UserError(tr(f"Pas d’image vidéo dans {self.name}.", f"No video track in {self.name}."))
                st = c.streams.video[0]
                cc = st.codec_context
                self.w, self.h = cc.width, cc.height
                rate = st.average_rate or st.guessed_rate or st.base_rate
                self.fps = Fraction(rate).limit_denominator(1001) if rate else Fraction(24)
                n = st.frames or 0
                if not n:            # MKV/WebM et certains MOV ne donnent pas le compte : estimation par la durée
                    dur = float(st.duration * st.time_base) if st.duration else (c.duration or 0) / 1e6
                    n = int(round(dur * float(self.fps)))
                self.frames = max(0, n - (1 if self.skip_first else 0))
                self.codec = cc.name
                pix = cc.format.name if cc.format else ""
                md = {str(k).lower(): str(v) for k, v in (st.metadata or {}).items()}
                # VP8/VP9 rangent l'alpha à part (alpha_mode=1) : le décodeur natif l'ignore, libvpx le lit
                self.vpx_alpha = self.codec in ("vp8", "vp9") and md.get("alpha_mode") == "1"
                self.alpha = bool(_ALPHA_PIX.match(pix)) or self.vpx_alpha
                # Vidéos de téléphone : pixels couchés + matrice d'affichage. ffmpeg les redresse tout seul,
                # PyAV non : on lit la rotation sur la 1re image et on redresse nous-mêmes (même résultat que Mia/ffmpeg).
                self.rot_k = 0
                for f in c.decode(st):
                    self.rot_k = int(round(float(getattr(f, "rotation", 0) or 0) / 90)) % 4
                    break
                if self.rot_k % 2:
                    self.w, self.h = self.h, self.w
        except UserError:
            raise
        except Exception as e:
            raise UserError(tr(f"Vidéo illisible : {self.name} ({e})", f"Unreadable video: {self.name} ({e})"))
        if not self.w or not self.h:
            raise UserError(tr(f"Vidéo illisible : {self.name}", f"Unreadable video: {self.name}"))

    # — lecture —
    def image(self, alpha=False):
        """L'image (ou la 1re image utile d'une vidéo). Voir _frames pour `alpha`."""
        if self.kind == "image":
            a = self._image_cache
            if alpha:
                return a if a.shape[2] == 4 else np.dstack([a, np.full(a.shape[:2], 255, np.uint8)])
            return flatten(a)
        for a in self._frames(alpha):
            return a
        raise UserError(tr(f"Aucune image lisible dans {self.name}.", f"No readable frame in {self.name}."))

    def _frames(self, alpha):
        """Images HxWx4 si `alpha`, sinon HxWx3 — une source transparente est alors posée sur du noir, comme dans
        les exécuteurs ffmpeg : la couleur gardée sous l'alpha (le fond d'origine d'un détourage) ne réapparaît pas."""
        if self.kind == "image":
            yield self.image(alpha)
            return
        rgba = alpha or self.alpha
        if rgba and self.vpx_alpha:
            for a in self._vpx_rgba():
                yield a if alpha else flatten(a)
            return
        import av
        with av.open(self.path) as c:
            st = c.streams.video[0]
            st.thread_type = "AUTO"
            for i, f in enumerate(c.decode(st)):
                if i == 0 and self.skip_first:
                    continue
                a = f.to_ndarray(format="rgba" if rgba else "rgb24")
                if self.rot_k:
                    a = np.ascontiguousarray(np.rot90(a, self.rot_k))
                yield a if alpha or not rgba else flatten(a)

    def _vpx_rgba(self):
        """WebM VP8/VP9 avec alpha : décodé par libvpx dans ffmpeg, images RGBA brutes par un tuyau."""
        dec = "libvpx-vp9" if self.codec == "vp9" else "libvpx"
        cmd = [ffmpeg_exe(self.job), "-hide_banner", "-v", "error", "-nostdin", "-c:v", dec, "-i", self.path,
               "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        err = []
        t = threading.Thread(target=lambda: err.append(p.stderr.read()), daemon=True)
        t.start()
        size = self.w * self.h * 4
        try:
            i = 0
            while True:
                buf = p.stdout.read(size)
                if not buf or len(buf) < size:
                    break
                if not (i == 0 and self.skip_first):
                    yield np.frombuffer(buf, np.uint8).reshape(self.h, self.w, 4).copy()
                i += 1
        finally:
            if p.poll() is None:
                p.kill()
            p.wait()
            t.join(timeout=2)
        if p.returncode not in (0, None) and i == 0:
            raise UserError(tr(f"Vidéo transparente illisible : {self.name}", f"Unreadable transparent video: {self.name}"))

    def chunks(self, size, alpha=False):
        """Paquets (index de la 1re image, [images HxWxC uint8]) lus dans un fil à part. À utiliser avec `with`."""
        def batches():
            buf, start = [], 0
            for a in self._frames(alpha):
                buf.append(a)
                if len(buf) >= size:
                    yield start, buf
                    start += len(buf)
                    buf = []
            if buf:
                yield start, buf
        return _Prefetch(batches())


def to_tensor(frames, device):
    """Liste d'images HxWxC uint8 → tenseur uint8 [N, H, W, C] sur l'appareil de calcul."""
    import torch
    return torch.from_numpy(np.stack(frames)).to(device, non_blocking=True)


# ——————————————————————————————————————————————————————— écriture vidéo


class VideoWriter:
    """MP4 H.264 par PyAV : h264_nvenc (règle du labo), repli libx264 si MIA_NO_NVENC=1 ou si NVENC refuse.

    cq 14 et GOP court par défaut : ce sont des fichiers de travail, relus image par image dans les blocs.
    Couleurs étiquetées BT.709 (sinon Chromium et ffmpeg ne s'accordent pas et la teinte bouge d'un cran).
    """

    def __init__(self, path, fps, cq=14, gop=12):
        self.path = Path(path)
        self.fps = Fraction(fps or 24).limit_denominator(1001)
        self.cq, self.gop = int(cq), int(gop)
        self.nvenc = os.environ.get("MIA_NO_NVENC", "") not in ("1", "true", "yes")
        self.count = 0
        self._c = self._s = None
        self.size = None

    def _open(self, w, h):
        import av
        while True:
            codec = "h264_nvenc" if self.nvenc else "libx264"
            c = av.open(str(self.path), "w")
            try:
                s = c.add_stream(codec, rate=self.fps)
                s.width, s.height, s.pix_fmt = w, h, "yuv420p"
                cc = s.codec_context
                cc.bit_rate = 0                     # qualité constante : pas de plafond de débit implicite
                cc.gop_size = self.gop
                for attr in ("colorspace", "color_primaries", "color_trc", "color_range"):
                    try:
                        setattr(cc, attr, 1)        # 1 = BT.709 (et plage « TV » pour color_range)
                    except Exception:
                        pass
                if self.nvenc:
                    s.options = {"preset": "p6", "tune": "hq", "rc": "vbr", "cq": str(self.cq), "b": "0"}
                else:
                    s.options = {"preset": "medium", "crf": str(self.cq)}
                cc.open()                           # ouvert tout de suite : un refus de NVENC se voit ici
                self._c, self._s, self.size = c, s, (w, h)
                return
            except Exception as e:
                try:
                    c.close()
                except Exception:
                    pass
                if not self.nvenc:
                    raise
                log("NVENC indisponible (", e, ") : encodage libx264 sur le processeur.")
                self.nvenc = False

    def write(self, frames):
        """Une image HxWx3 ou un paquet [N, H, W, 3] (torch ou numpy, uint8)."""
        import av
        from av.video.reformatter import Colorspace, ColorRange
        arr = as_numpy(frames)
        if arr.ndim == 3:
            arr = arr[None]
        for a in arr:
            a = pad_even(a[..., :3])
            if self._c is None:
                self._open(a.shape[1], a.shape[0])
            f = av.VideoFrame.from_ndarray(np.ascontiguousarray(a), format="rgb24")
            f = f.reformat(format="yuv420p", dst_colorspace=Colorspace.ITU709, dst_color_range=ColorRange.MPEG)
            f.pts = self.count
            for pk in self._s.encode(f):
                self._c.mux(pk)
            self.count += 1

    def close(self):
        if self._c is None:
            raise UserError(tr("Aucune image à écrire : la vidéo d’entrée est vide ?", "No frame to write: is the input video empty?"))
        for pk in self._s.encode():
            self._c.mux(pk)
        self._c.close()
        self._c = None
        return self.path


class AlphaWebmWriter:
    """WebM VP9 avec transparence (yuva420p), par le ffmpeg du labo via un tuyau : NVENC ne sait pas faire d'alpha.

    VP9 est encodé sur le processeur : à réserver aux clips courts (Chromium le lit avec sa transparence).
    """

    def __init__(self, path, fps, job=None, crf=20):
        self.path = Path(path)
        self.fps = Fraction(fps or 24).limit_denominator(1001)
        self.job, self.crf = job, int(crf)
        self.count = 0
        self._p = None
        self._err = []
        self.size = None

    def _open(self, w, h):
        cmd = [ffmpeg_exe(self.job), "-hide_banner", "-v", "error", "-nostdin", "-y",
               "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{w}x{h}", "-r", fps_text(self.fps), "-i", "-",
               "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuva420p",
               "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", str(self.crf),
               "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", "-threads", "4", "-auto-alt-ref", "0",
               "-g", "12", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
               "-an", str(self.path)]
        self._p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self._t = threading.Thread(target=lambda: self._err.append(self._p.stderr.read()), daemon=True)
        self._t.start()
        self.size = (w, h)

    def write(self, frames):
        """Une image HxWx4 ou un paquet [N, H, W, 4] RGBA (couleur non prémultipliée)."""
        arr = as_numpy(frames)
        if arr.ndim == 3:
            arr = arr[None]
        for a in arr:
            a = pad_even(a)
            if self._p is None:
                self._open(a.shape[1], a.shape[0])
            try:
                self._p.stdin.write(np.ascontiguousarray(a).tobytes())
            except OSError:
                self._fail()
            self.count += 1

    def _fail(self):
        if self._p.poll() is None:
            self._p.kill()
        self._p.wait()
        self._t.join(timeout=2)
        msg = (b"".join(e for e in self._err if e) or b"").decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError("ffmpeg (WebM transparent) : " + (msg[-1] if msg else f"code {self._p.returncode}"))

    def close(self):
        if self._p is None:
            raise UserError(tr("Aucune image à écrire : la vidéo d’entrée est vide ?", "No frame to write: is the input video empty?"))
        try:
            self._p.stdin.close()
        except OSError:
            pass
        self._p.wait()
        self._t.join(timeout=5)
        if self._p.returncode != 0:
            self._fail()
        return self.path

    def abort(self):
        if self._p is not None and self._p.poll() is None:
            self._p.kill()
            self._p.wait()


# ——————————————————————————————————————————————————————— opérations torch (masques)


def gaussian_blur(x, sigma):
    """Flou gaussien séparable sur [N, C, H, W] flottant (bords en miroir). sigma en pixels."""
    import torch
    import torch.nn.functional as F
    if sigma <= 0.05:
        return x
    r = max(1, int(round(sigma * 3)))
    k = torch.arange(-r, r + 1, device=x.device, dtype=x.dtype)
    k = torch.exp(-0.5 * (k / sigma) ** 2)
    k = k / k.sum()
    n, c, h, w = x.shape
    y = x.reshape(n * c, 1, h, w)
    mode = "reflect" if r < min(h, w) else "replicate"
    y = F.conv2d(F.pad(y, (r, r, 0, 0), mode=mode), k.view(1, 1, 1, -1))
    y = F.conv2d(F.pad(y, (0, 0, r, r), mode=mode), k.view(1, 1, -1, 1))
    return y.reshape(n, c, h, w)


def grow_mask(m, px):
    """Élargit (px > 0) ou rétrécit (px < 0) un masque doux [N, 1, H, W].

    Morphologie en niveaux de gris, en alternant un pas carré et un pas en croix : le contour grandit en octogone,
    bien plus proche d'un disque qu'un carré pur (pas de coins qui débordent sur un bord en biais).
    """
    import torch.nn.functional as F
    px = int(round(px))
    if px == 0:
        return m
    sign = 1 if px > 0 else -1
    y = m * sign
    for i in range(abs(px)):
        if i % 2 == 0:
            y = F.max_pool2d(y, 3, stride=1, padding=1)
        else:
            p = F.pad(y, (1, 1, 1, 1), mode="replicate")
            y = torch_max(y, p[..., :-2, 1:-1], p[..., 2:, 1:-1], p[..., 1:-1, :-2], p[..., 1:-1, 2:])
    return y * sign


def torch_max(*ts):
    out = ts[0]
    for t in ts[1:]:
        out = out.maximum(t)
    return out


def resize(x, h, w, mode="bilinear"):
    """Redimensionne [N, C, H, W] flottant ; anticrénelage quand on réduit (évite le moiré sur la 4K)."""
    import torch.nn.functional as F
    if x.shape[-2:] == (h, w):
        return x
    down = h < x.shape[-2] or w < x.shape[-1]
    return F.interpolate(x, size=(h, w), mode=mode, align_corners=False, antialias=down and mode in ("bilinear", "bicubic"))


# — couleur : sRGB ↔ Lab (D65), sur le GPU —

_M_RGB2XYZ = ((0.4124564, 0.3575761, 0.1804375), (0.2126729, 0.7151522, 0.0721750), (0.0193339, 0.1191920, 0.9503041))
_WHITE = (0.95047, 1.0, 1.08883)


def rgb_to_lab(rgb):
    """[N, 3, H, W] sRGB 0..1 → Lab (L 0..100)."""
    import torch
    lin = torch.where(rgb <= 0.04045, rgb / 12.92, ((rgb.clamp(min=0) + 0.055) / 1.055) ** 2.4)
    m = torch.tensor(_M_RGB2XYZ, device=rgb.device, dtype=rgb.dtype)
    xyz = torch.einsum("ij,njhw->nihw", m, lin)
    xyz = xyz / torch.tensor(_WHITE, device=rgb.device, dtype=rgb.dtype).view(1, 3, 1, 1)
    e, k = 216 / 24389, 24389 / 27
    f = torch.where(xyz > e, xyz.clamp(min=1e-12) ** (1 / 3), (k * xyz + 16) / 116)
    L = 116 * f[:, 1] - 16
    a = 500 * (f[:, 0] - f[:, 1])
    b = 200 * (f[:, 1] - f[:, 2])
    return torch.stack([L, a, b], 1)


def lab_to_rgb(lab):
    """Lab → [N, 3, H, W] sRGB 0..1 (borné)."""
    import torch
    L, a, b = lab[:, 0], lab[:, 1], lab[:, 2]
    fy = (L + 16) / 116
    fx = fy + a / 500
    fz = fy - b / 200
    e, k = 216 / 24389, 24389 / 27
    def inv(f):
        return torch.where(f ** 3 > e, f ** 3, (116 * f - 16) / k)
    xyz = torch.stack([inv(fx), torch.where(L > k * e, fy ** 3, L / k), inv(fz)], 1)
    xyz = xyz * torch.tensor(_WHITE, device=lab.device, dtype=lab.dtype).view(1, 3, 1, 1)
    m = torch.linalg.inv(torch.tensor(_M_RGB2XYZ, device=lab.device, dtype=torch.float64)).to(lab.dtype)
    lin = torch.einsum("ij,njhw->nihw", m, xyz).clamp(0, 1)
    return torch.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055).clamp(0, 1)
