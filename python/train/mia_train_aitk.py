# -*- coding: utf-8 -*-
"""Mia — training adapter for ostris' ai-toolkit (Qwen-Image, Flux), run with the Python of venv-aitk.

    <python> -B -u mia_train_aitk.py --dir <training folder> --run <n> --token <t> [--resume <step>] [--dry]

The tool runs in a sub-process (python run.py config.yaml, from its own sources, WITHOUT --log) and is driven
through the protocol of its own web interface, without starting that interface:

    control\\aitk.db                 SQLite, table Job: the tool writes status / info / step in its row and reads
                                    stop / save_now from it (AITK_JOB_ID = the training's id)
    out\\<slug>\\loss_log.db          SQLite written by the tool: loss and learning rate at every step
    out\\<slug>\\<slug>_<step on 9 digits>.safetensors, then out\\<slug>\\<slug>.safetensors at the end
    out\\<slug>\\samples\\             the samples

The adapter copies the tool's output to its own (log.txt), reads those files every second and translates them into
the protocol of the training folder (mia_train_common.py). The databases are only read by short queries.

--dry writes config.yaml, creates and resets the Job row, has ai-toolkit itself read the configuration (get_job,
graphics card hidden, nothing is run) and checks that the tool took the row in hand.

Everything here was read in ai-toolkit's code; nothing has run on a GPU yet (see the design, §5.2 and §12).
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mia_train_common as C  # noqa: E402
from mia_train_common import Abort, Stopped, ToolExit  # noqa: E402

VIDEO_EXT = {".mp4", ".webm", ".mov", ".mkv", ".gif"}
SAMPLE_EXT = {".jpg", ".jpeg", ".png", ".webp"} | VIDEO_EXT

# Columns of ai-toolkit's table Job (ui\prisma\schema.prisma), as Prisma creates them in SQLite.
JOB_TABLE = """
CREATE TABLE IF NOT EXISTS Job (
  id              TEXT PRIMARY KEY NOT NULL,
  name            TEXT NOT NULL UNIQUE,
  gpu_ids         TEXT NOT NULL,
  job_config      TEXT NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status          TEXT NOT NULL DEFAULT 'stopped',
  stop            BOOLEAN NOT NULL DEFAULT 0,
  return_to_queue BOOLEAN NOT NULL DEFAULT 0,
  step            INTEGER NOT NULL DEFAULT 0,
  total_steps     INTEGER,
  info            TEXT NOT NULL DEFAULT '',
  speed_string    TEXT NOT NULL DEFAULT '',
  queue_position  INTEGER NOT NULL DEFAULT 0,
  pid             INTEGER,
  job_type        TEXT NOT NULL DEFAULT 'train',
  job_ref         TEXT,
  save_now        BOOLEAN NOT NULL DEFAULT 0,
  sample_now      BOOLEAN NOT NULL DEFAULT 0
)"""

# What ai-toolkit reads back from a configuration, without running it (--dry).
READBACK = r"""
import json, os, sys
sys.path.insert(0, os.getcwd())
from toolkit.job import get_job
job = get_job(sys.argv[1], None)
p = job.process[0]
tc, mc, sc, lc, sm, nc = p.train_config, p.model_config, p.save_config, p.logging_config, p.sample_config, p.network_config
ds = (p.get_conf('datasets', None) or [{}])[0]
print('MIA_READBACK ' + json.dumps({
  'job': type(job).__name__, 'process': type(p).__name__, 'name': job.name, 'save_root': p.save_root,
  'trigger_word': p.trigger_word, 'is_ui_trainer': bool(getattr(p, 'is_ui_trainer', False)),
  'sqlite_db_path': getattr(p, 'sqlite_db_path', None), 'job_id': getattr(p, 'job_id', None),
  'arch': mc.arch, 'name_or_path': mc.name_or_path, 'quantize': mc.quantize,
  'steps': tc.steps, 'batch_size': tc.batch_size, 'optimizer': tc.optimizer, 'lr': tc.lr, 'dtype': tc.dtype,
  'noise_scheduler': tc.noise_scheduler, 'skip_first_sample': tc.skip_first_sample, 'disable_sampling': tc.disable_sampling,
  'save_every': sc.save_every, 'max_step_saves_to_keep': sc.max_step_saves_to_keep,
  'sample_every': sm.sample_every, 'prompts': list(sm.prompts), 'width': sm.width, 'height': sm.height,
  'log_every': lc.log_every, 'use_ui_logger': lc.use_ui_logger, 'logger': type(p.logger).__name__,
  'linear': nc.linear, 'linear_alpha': nc.linear_alpha,
  'folder_path': ds.get('folder_path'), 'resolution': ds.get('resolution'),
}, default=str))
"""


# ---------------------------------------------------------------------------------------------- configuration
def sources_dir() -> Path:
    tools = os.environ.get("MIA_TRAIN_TOOLS")
    return Path(tools) / "src" / "ai-toolkit" if tools else Path.cwd()


def tool_name(src: Path) -> str:
    """« ai-toolkit <commit> » when the sources are a git checkout (read in .git, nothing is started)."""
    try:
        head = (src / ".git" / "HEAD").read_text(encoding="utf-8").strip()
        if head.startswith("ref:"):
            head = (src / ".git" / head[4:].strip()).read_text(encoding="utf-8").strip()
        if re.fullmatch(r"[0-9a-f]{40}", head):
            return f"ai-toolkit {head[:8]}"
    except OSError:
        pass
    return "ai-toolkit"


def save_root(s: C.Session) -> Path:
    return s.out / s.slug


def db_path(s: C.Session) -> Path:
    return s.control / "aitk.db"


def build_config(s: C.Session) -> dict:
    """config.yaml = essais\\qwen21_essai20.yaml with the values of train.json. The tool adds the trigger word itself
    to a caption that lacks it; « trigger word only » captions are files holding that single word (written by Mia)."""
    if not s.slug:
        raise Abort("tool", "train.json sans « slug »", "config")
    sample = s.base.get("sample") or {}
    rank = s.int_setting("rank", 32) or 32
    prompts = s.prompts()
    sample_every = s.int_setting("sampleEvery", 0)
    sampling = bool(sample_every and prompts)
    resolutions = [int(r) for r in (s.setting("resolutions", []) or []) if isinstance(r, (int, float))]
    if not resolutions:
        raise Abort("tool", "aucune taille d’image dans les réglages", "config")
    if not s.base.get("arch") or not s.base.get("name_or_path"):
        raise Abort("tool", f"modèle sans architecture ai-toolkit dans le catalogue : {s.base.get('id')}", "config")
    train = {
        "batch_size": s.int_setting("batch", 1) or 1,
        "steps": s.steps,
        "gradient_accumulation": 1,
        "train_unet": True,
        "train_text_encoder": False,
        "gradient_checkpointing": True,
        "noise_scheduler": "flowmatch",
        "optimizer": str(s.setting("optimizer", "adamw")),
        "lr": float(s.setting("lr", 1e-4)),
        "dtype": "bf16",
        "skip_first_sample": True,
        "ema_config": {"use_ema": False},
    }
    if not sampling:
        train["disable_sampling"] = True          # « none »: not even the sample the tool renders at the end
    return {
        "job": "extension",
        "config": {
            "name": s.slug,
            "process": [{
                "type": "diffusion_trainer",
                "training_folder": C.posix(s.out),
                "sqlite_db_path": C.posix(db_path(s)),
                "device": "cuda",
                "trigger_word": s.trigger or None,
                "network": {"type": "lora", "linear": rank, "linear_alpha": rank},
                "save": {"dtype": "bf16", "save_every": s.int_setting("saveEvery", 250) or 250, "max_step_saves_to_keep": 40},
                "datasets": [{"folder_path": C.posix(s.dataset), "caption_ext": "txt", "caption_dropout_rate": 0.05, "resolution": resolutions}],
                "train": train,
                "model": {"arch": s.base["arch"], "name_or_path": s.base["name_or_path"], "quantize": False},
                "sample": {
                    "sampler": "flowmatch",
                    "sample_every": sample_every if sampling else s.steps + 1,
                    "width": int(sample.get("width", 1024)),
                    "height": int(sample.get("height", 1024)),
                    "prompts": prompts,
                    "seed": 42,
                    "walk_seed": False,
                    "guidance_scale": sample.get("guidance", 4),
                    "sample_steps": int(sample.get("steps", 30)),
                },
                "logging": {"log_every": 1, "use_ui_logger": True},
            }],
        },
        "meta": {"name": "[name]", "version": "1.0"},
    }


def write_config(s: C.Session, config: dict) -> Path:
    header = (f"# Écrit par Mia (python\\train\\mia_train_aitk.py), lancement {s.run}"
              f"{', reprise du pas ' + str(s.resume) if s.resume else ''}. Régénéré à chaque lancement : ne pas modifier.\n")
    path = s.dir / "config.yaml"
    C.write_atomic(path, C.dump_yaml(config, header))
    return path


def command(s: C.Session, config_path: Path) -> tuple[list[str], dict, Path]:
    """How the tool is started: from its sources, without --log (print.py would write every line twice)."""
    src = sources_dir()
    exe, env = C.child_python()
    env["AITK_JOB_ID"] = str(s.doc.get("id") or s.dir.name)
    env.setdefault("PYTHONUNBUFFERED", "1")
    return [exe, "-B", "-u", "run.py", str(config_path)], env, src


# ---------------------------------------------------------------------------------------------- the Job row
def job_id(s: C.Session) -> str:
    return str(s.doc.get("id") or s.dir.name)


def reset_job(db: Path, jid: str, name: str, steps: int, resume: int, config_json: str = "{}") -> None:
    """At EVERY launch, first or resumed, the row is made new: a `stop` left at 1 by the previous pause would stop
    the tool as soon as it loads (hook_before_model_load → maybe_stop)."""
    db.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(db), timeout=30)
    try:
        con.execute("PRAGMA journal_mode=WAL")
        con.execute(JOB_TABLE)
        con.execute("DELETE FROM Job WHERE id != ?", (jid,))
        con.execute(
            "INSERT INTO Job (id, name, gpu_ids, job_config, status, stop, return_to_queue, step, total_steps, info, speed_string, save_now, sample_now)"
            " VALUES (?, ?, '0', ?, 'running', 0, 0, ?, ?, '', '', 0, 0)"
            " ON CONFLICT(id) DO UPDATE SET name=excluded.name, job_config=excluded.job_config, status='running', stop=0, return_to_queue=0,"
            " step=excluded.step, total_steps=excluded.total_steps, info='', speed_string='', pid=NULL, save_now=0, sample_now=0,"
            " updated_at=CURRENT_TIMESTAMP",
            (jid, name, config_json, int(resume), int(steps)))
        con.commit()
    finally:
        con.close()


def _readonly(db: Path) -> sqlite3.Connection:
    return sqlite3.connect(Path(db).resolve().as_uri() + "?mode=ro", uri=True, timeout=1)


def read_job(db: Path, jid: str) -> dict | None:
    """One short read; None when the base is busy or absent (the next second asks again)."""
    try:
        con = _readonly(db)
    except sqlite3.Error:
        return None
    try:
        row = con.execute("SELECT status, info, step, stop, save_now, sample_now, return_to_queue FROM Job WHERE id = ?", (jid,)).fetchone()
    except sqlite3.Error:
        return None
    finally:
        con.close()
    if row is None:
        return None
    def as_int(x):
        try:
            return int(x)
        except (TypeError, ValueError):
            return 0
    return {"status": str(row[0] or ""), "info": str(row[1] or ""), "step": as_int(row[2]), "stop": as_int(row[3]),
            "save_now": as_int(row[4]), "sample_now": as_int(row[5]), "return_to_queue": as_int(row[6])}


def set_job(db: Path, jid: str, key: str, value: int) -> bool:
    """One short write (stop, save_now). False when the base was busy: the caller tries again a second later."""
    if key not in ("stop", "save_now"):
        raise ValueError(key)
    try:
        con = sqlite3.connect(str(db), timeout=2)
        try:
            con.execute(f"UPDATE Job SET {key} = ? WHERE id = ?", (int(value), jid))
            con.commit()
        finally:
            con.close()
        return True
    except sqlite3.Error:
        return False


def phase_of(info: str, training_seen: bool) -> tuple[str, int | None, int | None]:
    """The tool's `info` → (phase, n, of). An unknown text is `load` before the first « Training », `train` after."""
    text = (info or "").strip()
    if text == "Training":
        return "train", None, None
    m = re.match(r"Generating images\s*-\s*(\d+)\s*/\s*(\d+)", text)
    if m:
        return "sample", int(m.group(1)), int(m.group(2))
    if text == "Saving model":
        return "save", None, None
    return ("train" if training_seen else "load"), None, None


# ---------------------------------------------------------------------------------------------- loss_log.db
def read_losses(db: Path, after: int) -> list[dict]:
    """Rows of the tool's loss log with step > after: [{step, t (ms), loss, lr}], ascending. Read only."""
    if not Path(db).is_file():
        return []
    try:
        con = _readonly(db)
    except sqlite3.Error:
        return []
    try:
        rows = con.execute(
            "SELECT s.step, s.wall_time,"
            " (SELECT value_real FROM metrics WHERE step = s.step AND key = 'loss/loss'),"
            " (SELECT value_real FROM metrics WHERE step = s.step AND key LIKE 'loss/%' ORDER BY key LIMIT 1),"
            " (SELECT value_real FROM metrics WHERE step = s.step AND key = 'learning_rate')"
            " FROM steps s WHERE s.step > ? ORDER BY s.step", (int(after),)).fetchall()
    except sqlite3.Error:
        return []
    finally:
        con.close()
    return [{"step": int(r[0]), "t": int(float(r[1]) * 1000), "loss": r[2] if r[2] is not None else r[3], "lr": r[4]} for r in rows]


# ---------------------------------------------------------------------------------------------- files of the tool
def checkpoint_files(root: Path, slug: str, steps: int) -> list[dict]:
    """[{step, path, final}] ascending: <slug>_<9 digits>.safetensors, and <slug>.safetensors (the last step)."""
    out = []
    if not root.is_dir():
        return out
    stepped = re.compile(re.escape(slug) + r"_(\d{9})\.safetensors$")
    for path in root.iterdir():
        if not path.is_file():
            continue
        m = stepped.fullmatch(path.name)
        if m:
            out.append({"step": int(m.group(1)), "path": path, "final": False})
        elif path.name == f"{slug}.safetensors":
            out.append({"step": int(steps), "path": path, "final": True})
    return sorted(out, key=lambda c: (c["step"], c["final"]))


def prepare_resume(root: Path, slug: str, steps: int, resume: int, run: int = 0, dry: bool = False) -> dict:
    """The tool resumes by itself from the most recently CREATED <slug>*.safetensors, without any check, and reads
    the step in the file's metadata. So before starting it: every file that is incomplete or later than the chosen
    step goes to out\\ecartes\\ (never deleted). On a first launch (resume 0) nothing may be left at all.
    → {aside: [names], latest: step of the file the tool will pick (0 when none)}"""
    aside, kept = [], []
    for ck in checkpoint_files(root, slug, steps):
        if ck["step"] > resume or resume == 0 or not C.safetensors_complete(ck["path"]):
            aside.append(ck)
        else:
            kept.append(ck)
    if aside and not dry:
        dst = root.parent / "ecartes"
        dst.mkdir(parents=True, exist_ok=True)
        for ck in aside:
            to = dst / f"run{run}_{ck['path'].name}"
            k = 2
            while to.exists():
                to = dst / f"run{run}_{k}_{ck['path'].name}"
                k += 1
            os.replace(ck["path"], to)
    latest = max(kept, key=lambda c: os.path.getctime(c["path"]))["step"] if kept else 0
    return {"aside": [c["path"].name for c in aside], "latest": latest}


def sample_files(root: Path) -> list[dict]:
    """[{step, i, path}] of out\\<slug>\\samples: the tool names them « <time>__<step on 9 digits>_<count>.<ext> »
    (BaseSDTrainProcess.py; exact form never seen on disk: the step is read by a regular expression)."""
    folder = root / "samples"
    out = []
    if not folder.is_dir():
        return out
    for path in folder.iterdir():
        if not path.is_file() or path.suffix.lower() not in SAMPLE_EXT:
            continue
        m = re.search(r"_(\d{9})_(\d+)$", path.stem) or re.search(r"(\d{9})(?:\D+(\d+))?$", path.stem)
        if m:
            out.append({"step": int(m.group(1)), "i": int(m.group(2) or 0) + 1, "path": path})
    return sorted(out, key=lambda x: (x["step"], x["i"]))


# ---------------------------------------------------------------------------------------------- the tool's output
class Pump(threading.Thread):
    """Copies the tool's output to ours (log.txt), cutting on \\r and keeping only the last state of a tqdm bar."""

    FOUND_STEP = re.compile(r"Found step (\d+) in metadata")

    def __init__(self, stream):
        super().__init__(name="mia-pump", daemon=True)
        self.stream = stream
        self.first_at = None           # when the tool wrote its first line
        self.found_step = None         # « Found step N in metadata, starting from there »
        self._bar_at = 0.0

    def _write(self, raw: bytes) -> None:
        text = raw.decode("utf-8", "replace").rstrip()
        if not text.strip():
            return
        if self.first_at is None:
            self.first_at = time.time()
        m = self.FOUND_STEP.search(text)
        if m:
            self.found_step = int(m.group(1))
        try:
            sys.stdout.write(text + "\n")
            sys.stdout.flush()
        except (OSError, ValueError):
            pass

    @staticmethod
    def last_state(line: bytes) -> bytes:
        parts = [p for p in line.split(b"\r") if p.strip()]
        return parts[-1] if parts else b""

    def run(self) -> None:
        buf = b""
        read = getattr(self.stream, "read1", None) or self.stream.read
        while True:
            try:
                chunk = read(65536)
            except (OSError, ValueError):
                break
            if not chunk:
                break
            buf += chunk
            *lines, buf = buf.split(b"\n")
            for line in lines:
                self._write(self.last_state(line))
            if b"\r" in buf:                      # a bar being redrawn: one state a minute is enough in the log
                head, _, tail = buf.rpartition(b"\r")
                now = time.time()
                if now - self._bar_at >= 60 and head.strip():
                    self._bar_at = now
                    self._write(self.last_state(head))
                buf = tail
        if buf.strip():
            self._write(self.last_state(buf))


# ---------------------------------------------------------------------------------------------- one run
class Runner:
    def __init__(self, s: C.Session, watch: C.Watch):
        self.s = s
        self.watch = watch
        self.db = db_path(s)
        self.jid = job_id(s)
        self.root = save_root(s)
        self.proc = None
        self.pump = None
        self.started_at = 0.0
        self.taken = False             # the tool wrote in its Job row
        self.training_seen = False
        self.phase = "load"
        self.phase_n = None
        self.sample_at = None
        self.last_loss_step = s.resume - 1       # the tool's steps start at 0: its step k is Mia's step k + 1
        self.last_loss_t = None
        self.announced: set[int] = set()
        self.sizes: dict[str, int] = {}
        self.samples_seen: set[str] = set()
        self.last_row = None
        # pause / stop
        self.ask = None                # what was asked
        self.ask_at = 0.0
        self.save_at = None            # when save_now was written
        self.stop_at = None            # when stop was written
        self.saved_step = None

    # -- start
    def start(self, config_path: Path) -> None:
        argv, env, src = command(self.s, config_path)
        if not (src / "run.py").is_file():
            raise Abort("tool", f"ai-toolkit introuvable : {src}", "config")
        for ck in checkpoint_files(self.root, self.s.slug, self.s.steps):
            self.announced.add(ck["step"])           # what a previous launch left: already known to Mia
        self.samples_seen = {x["path"].name for x in sample_files(self.root)}
        self.s.say("lancement : " + " ".join(argv))
        sys.stdout.flush()
        self.proc = subprocess.Popen(argv, cwd=str(src), env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, creationflags=C.CREATE_NO_WINDOW)
        self.started_at = time.time()
        self.pump = Pump(self.proc.stdout)
        self.pump.start()

    def kill(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            C.kill_tree(self.proc.pid)

    # -- what the tool wrote
    def set_phase(self, phase: str, n=None, of=None) -> None:
        if phase == self.phase and n == self.phase_n:
            return
        if phase == "sample" and self.phase != "sample":
            self.sample_at = time.time()
        self.phase, self.phase_n = phase, n
        self.s.phase(phase, n, of)

    def read_row(self) -> None:
        row = read_job(self.db, self.jid)
        if row is None:
            return
        self.last_row = row
        if row["info"]:
            self.taken = True
        if not self.training_seen and row["info"].strip() == "Training":
            self.first_training(row)
        phase, n, of = phase_of(row["info"], self.training_seen)
        self.set_phase(phase, n, of)

    def first_training(self, row: dict) -> None:
        """First reading where the tool trains: it must have started from the step Mia chose — checked before the
        first save_every, so nothing has been overwritten yet."""
        resume = self.s.resume
        found = self.pump.found_step if self.pump else None
        started = found if found is not None else row["step"]
        if resume and row["step"] != resume and found != resume:
            raise Abort("resume", f"reprise demandée au pas {resume}, l’outil repart du pas {started}", "resume")
        if not resume and (found or 0) > 0:
            raise Abort("resume", f"premier lancement, mais l’outil reprend au pas {found}", "resume")
        self.training_seen = True
        if resume:
            self.s.emit({"e": "resumed", "step": resume})

    def read_metrics(self, final: bool = False) -> None:
        rows = read_losses(self.root / "loss_log.db", self.last_loss_step)
        for k, r in enumerate(rows):
            if r["loss"] is None and k == len(rows) - 1 and not final:
                break                              # the step is there, its loss not yet: read again in a second
            dt = (r["t"] - self.last_loss_t) / 1000 if self.last_loss_t else None
            self.s.metric(r["step"] + 1, r["loss"], r["lr"], dt, r["t"])
            self.last_loss_step, self.last_loss_t = r["step"], r["t"]

    def stable(self, path: Path) -> bool:
        """Same size at two readings a second apart (the tool writes its files in place, without a temporary one)."""
        try:
            size = path.stat().st_size
        except OSError:
            return False
        key = str(path)
        same = self.sizes.get(key) == size
        self.sizes[key] = size
        return same and size > 0

    def read_checkpoints(self, final: bool = False) -> None:
        for ck in checkpoint_files(self.root, self.s.slug, self.s.steps):
            if ck["step"] in self.announced or (ck["final"] and not final):
                continue
            if not self.stable(ck["path"]) or not C.safetensors_complete(ck["path"]):
                continue
            self.announced.add(ck["step"])
            self.s.emit({"e": "checkpoint", "step": ck["step"], "file": self.s.rel(ck["path"]),
                         "sizeMB": round(ck["path"].stat().st_size / 1048576, 3)})

    def read_samples(self) -> None:
        for x in sample_files(self.root):
            name = x["path"].name
            if name in self.samples_seen or not self.stable(x["path"]):
                continue
            self.samples_seen.add(name)
            sec = round(time.time() - self.sample_at, 1) if self.sample_at else None
            self.s.emit({"e": "sample", "step": x["step"], "i": x["i"], "file": self.s.rel(x["path"]),
                         "kind": "video" if x["path"].suffix.lower() in VIDEO_EXT else "image", **({"sec": sec} if sec else {})})

    # -- pause and stop
    def newest_since(self, since: float) -> dict | None:
        """The stepped file written after `since`, once complete and of stable size."""
        best = None
        for ck in checkpoint_files(self.root, self.s.slug, self.s.steps):
            if ck["final"]:
                continue
            try:
                if ck["path"].stat().st_mtime >= since - 2 and (best is None or ck["step"] > best["step"]):
                    best = ck
            except OSError:
                continue
        return best if best and self.stable(best["path"]) and C.safetensors_complete(best["path"]) else None

    def order_stop(self, saved_step: int | None) -> None:
        if set_job(self.db, self.jid, "stop", 1):
            self.stop_at = time.time()
            self.saved_step = saved_step
            self.s.say("ordre d’arrêt donné" + (f" (point au pas {saved_step})" if saved_step is not None else " (sans point)"))

    def drive_stop(self) -> None:
        """Pause, stop, or Mia gone: save_now, wait for the complete file, THEN stop — the tool writes the LoRA in
        place and its stop watcher interrupts the main thread at any moment."""
        t = self.s.timing
        now = time.time()
        if self.ask is None:
            self.ask = self.watch.asked()
            if self.ask is None:
                return
            self.ask_at = now
            self.s.say(f"{self.ask} demandé")
        if self.stop_at is not None:
            if now - self.stop_at > t["exitWaitMs"] / 1000:
                self.s.say("l’outil ne part pas : arrêté de force")
                self.kill()
            return
        row = self.last_row or {}
        if not self.training_seen:
            self.order_stop(None)                              # nothing to save yet
            return
        if self.save_at is None:
            if self.phase == "sample" and now - self.ask_at < t["sampleCapMs"] / 1000:
                return                                         # takes effect after the sample
            if self.phase == "sample":
                self.order_stop(None)
                return
            if set_job(self.db, self.jid, "save_now", 1):
                self.save_at = now
            return
        if now - self.save_at > t["saveWaitMs"] / 1000:
            self.order_stop(None)
            return
        if row.get("save_now") == 0 and row.get("info", "").strip() == "Training":
            ck = self.newest_since(self.save_at)
            if ck:
                if ck["step"] not in self.announced:
                    self.announced.add(ck["step"])
                    self.s.emit({"e": "checkpoint", "step": ck["step"], "file": self.s.rel(ck["path"]),
                                 "sizeMB": round(ck["path"].stat().st_size / 1048576, 3)})
                self.order_stop(ck["step"])

    # -- the loop
    def check_takeover(self) -> None:
        """Without its base or AITK_JOB_ID the tool drops its interface mode without a word: no pause, no stop.
        The delay runs from the tool's first line of output (its imports alone can last a minute)."""
        if self.taken or self.pump is None or self.pump.first_at is None:
            return
        if time.time() - self.pump.first_at > self.s.timing["takeoverMs"] / 1000:
            self.kill()
            raise Abort("tool", "L’outil n’a pas pris le pilotage de Mia.", "takeover")

    def loop(self) -> int:
        poll = self.s.timing["pollMs"] / 1000
        try:
            while self.proc.poll() is None:
                time.sleep(poll)
                self.read_row()
                self.check_takeover()
                self.read_metrics()
                self.read_checkpoints()
                self.read_samples()
                self.drive_stop()
        except BaseException:
            self.kill()
            raise
        self.pump.join(timeout=10)
        return self.finish(self.proc.returncode)

    def finish(self, code: int) -> int:
        s = self.s
        self.read_row()
        self.read_metrics(final=True)
        if self.stop_at is not None:                           # a stop we asked for: a non-zero exit code is normal
            time.sleep(self.s.timing["pollMs"] / 1000)
            self.read_checkpoints()
            saved = self.saved_step is not None
            step = self.saved_step if saved else (self.last_loss_step + 1 if self.last_loss_step >= 0 else s.resume)
            s.emit({"e": "stopped", "step": int(step), "saved": saved, "why": self.ask or "stop"})
            s.say(f"arrêté au pas {step}{'' if saved else ' (sans point de contrôle)'}")
            return 0
        status = (self.last_row or {}).get("status", "")
        final = self.root / f"{s.slug}.safetensors"
        if code == 0 and (status == "completed" or final.is_file()):
            for _ in range(10):                                # the final file, once of stable size
                self.read_checkpoints(final=True)
                if s.steps in self.announced:
                    break
                time.sleep(self.s.timing["pollMs"] / 1000)
            if not C.safetensors_complete(final):
                raise Abort("tool", f"ai-toolkit : LoRA final absent ou incomplet ({s.rel(final)})", "checkpoint")
            self.read_samples()
            s.emit({"e": "done", "step": s.steps})
            s.say("terminé")
            return 0
        if code == 0:
            raise Abort("tool", f"ai-toolkit s’est arrêté sans finir (état « {status or '?'} »)", "exit")
        s.say(f"ai-toolkit s’est arrêté (code {code})")
        raise ToolExit(code)


# ---------------------------------------------------------------------------------------------- --dry
def readback(s: C.Session, config_path: Path) -> dict:
    """ai-toolkit reads the configuration itself (get_job builds the job and its process, nothing is run)."""
    src = sources_dir()
    if not (src / "toolkit" / "job.py").is_file():
        raise Abort("tool", f"ai-toolkit introuvable : {src}", "config")
    _argv, env, _src = command(s, config_path)
    env.update({"CUDA_VISIBLE_DEVICES": "", "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "NO_ALBUMENTATIONS_UPDATE": "1", "DISABLE_TELEMETRY": "YES"})
    r = subprocess.run([_argv[0], "-B", "-c", READBACK, str(config_path)], cwd=str(src), env=env, stdin=subprocess.DEVNULL,
                       capture_output=True, timeout=600, creationflags=C.CREATE_NO_WINDOW, check=False)
    out = r.stdout.decode("utf-8", "replace")
    line = next((l for l in out.splitlines() if l.startswith("MIA_READBACK ")), None)
    if r.returncode != 0 or line is None:
        tail = (r.stderr.decode("utf-8", "replace").strip().splitlines() or out.strip().splitlines() or ["?"])[-1]
        raise Abort("tool", f"configuration refusée par ai-toolkit : {tail[:300]}", "config")
    return json.loads(line[len("MIA_READBACK "):])


# ---------------------------------------------------------------------------------------------- entry point
def main(s: C.Session) -> int:
    name = tool_name(sources_dir())
    runner_box: list[Runner] = []
    watch = C.Watch(s, on_force=lambda: [r.kill() for r in runner_box])
    if not s.dry:
        s.control.mkdir(parents=True, exist_ok=True)
        s.out.mkdir(parents=True, exist_ok=True)
        watch.start()
    s.emit({"e": "caps", "tool": name, "saveNow": True, "run": s.run})
    s.say(f"{name}, lancement {s.run}{', reprise du pas ' + str(s.resume) if s.resume else ''}{' (à blanc)' if s.dry else ''}")
    s.phase("check")
    s.load()
    images = s.images()
    config = build_config(s)
    config_path = write_config(s, config)
    _weights, missing = s.weights(os.environ.get("MODELS_PATH") or None)
    prep = prepare_resume(save_root(s), s.slug, s.steps, s.resume, s.run, dry=s.dry)
    if s.resume and prep["latest"] != s.resume and not s.dry:
        raise Abort("resume", f"reprise demandée au pas {s.resume}, fichier le plus récent : pas {prep['latest']}", "resume")
    if prep["aside"]:
        s.say(("à écarter : " if s.dry else "écartés : ") + ", ".join(prep["aside"]))
    reset_job(db_path(s), job_id(s), s.slug, s.steps, s.resume, json.dumps(config))

    if s.dry:
        argv, _env, src = command(s, config_path)
        back = readback(s, config_path)
        row = read_job(db_path(s), job_id(s)) or {}
        takeover = bool(row.get("info"))                 # get_job built the trainer: it wrote « Starting » in OUR row
        reset_job(db_path(s), job_id(s), s.slug, s.steps, s.resume, json.dumps(config))
        s.report({
            "ok": True, "tool": name, "config": str(config_path), "images": len(images), "weightsMissing": missing,
            "command": argv, "cwd": str(src), "jobId": job_id(s), "db": str(db_path(s)), "takeover": takeover,
            "takeoverInfo": row.get("info"), "job": read_job(db_path(s), job_id(s)), "readback": back, "resume": {"step": s.resume, **prep},
        })
        return 0

    if missing:
        raise Abort("missing", missing[0], "weights")
    s.phase("load")
    runner = Runner(s, watch)
    runner_box.append(runner)
    runner.start(config_path)
    code = runner.loop()
    watch.halt()
    return code


if __name__ == "__main__":
    C.run_adapter(main)
