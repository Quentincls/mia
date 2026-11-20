# -*- coding: utf-8 -*-
"""Mia — what the training adapters share (mia_train_ltx.py, mia_train_aitk.py).

An adapter is started by Mia's main process (electron\\trainer.js, descriptors in electron\\train\\) with the Python of
the tool's own venv:

    <python> -B -u mia_train_<tool>.py --dir <training folder> --run <n> --token <t> [--resume <step>] [--dry]

It speaks the protocol of the training folder — the same one as the fake tool (tools\\fixtures\\train\\fake-trainer.js):

    events.jsonl   one JSON line per event: caps, phase, resumed, sample_step, sample, checkpoint, stopped, done, error
                   (`stopped` carries `why`: Watch.asked() — "stop", "pause", or "alive" when Mia is gone)
    metrics.jsonl  one line per step: {run, s, loss, lr, dt, t}
    control\\       pause, stop, alive (written by Mia) ; adapter.json {pid, token, t} (rewritten here, in a thread)

An adapter never writes train.json, and Mia never writes events.jsonl nor metrics.jsonl. The adapter's output is a
file (log.txt), not a pipe: if Mia dies the tool can still write, save and stop cleanly.

--dry writes and validates the tool's configuration without any GPU work, touches neither events.jsonl nor
metrics.jsonl, and prints one line « MIA_DRY {json} » (tools\\test-train-config.js reads it).

Standard library only here (PyYAML, present in both venvs, is imported when a configuration is written).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import struct
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

# The watch (milliseconds). MIA_TRAIN_TIMING='{"aliveStaleMs":300,…}' shortens them for the benches only.
TIMING = {
    "heartbeatMs": 20000,      # adapter.json is rewritten this often
    "aliveCheckMs": 5000,      # control\alive is looked at this often
    "aliveStaleMs": 180000,    # an `alive` older than this is suspect…
    "aliveRecheckMs": 45000,   # …and acted upon after two readings this far apart showing the same file
    "aliveForceMs": 900000,    # without `alive` for this long: forced exit
    "jumpMs": 60000,           # the clock jumped by more than this between two readings: back from sleep, start again
    "pollMs": 1000,            # how often an adapter looks at what its tool wrote
    "takeoverMs": 60000,       # ai-toolkit: the tool must have written in its Job row within this delay
    "saveWaitMs": 120000,      # pause: how long the checkpoint may take
    "sampleCapMs": 360000,     # pause asked during a sample: how long the sample may still last
    "exitWaitMs": 30000,       # after the stop order: how long the tool may take to leave
}


class Abort(Exception):
    """The adapter gives up: one `error` event (code of the protocol), exit code 1."""

    def __init__(self, code: str, message: str, why: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.why = why          # finer reason for Mia: version, signature, config, takeover, noloss, checkpoint…


class Stopped(Exception):
    """Pause or stop asked: `stopped` has been emitted, the adapter leaves with code 0."""


class ToolExit(Exception):
    """The tool left by itself with this code and no word from us: Mia reads the reason in log.txt."""

    def __init__(self, code: int):
        super().__init__(f"exit {code}")
        self.exit_code = code


# ---------------------------------------------------------------------------------------------- small tools
def now_ms() -> int:
    return int(time.time() * 1000)


def read_json(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_atomic(path: Path, text: str) -> None:
    """.tmp then rename: a reader never sees half a file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8", newline="\n")
    os.replace(tmp, path)


def sha1(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def posix(path) -> str:
    return str(path).replace("\\", "/")


def file_id(path: Path) -> dict | None:
    """Name, size and date of a file: enough to tell that it changed, without reading it."""
    try:
        st = Path(path).stat()
    except OSError:
        return None
    return {"name": Path(path).name, "bytes": st.st_size, "mtime": int(st.st_mtime * 1000)}


def safetensors_complete(path: Path) -> bool:
    """Same rule as electron\\train\\common.js: size == 8 + header length + end of the last declared tensor.
    A file cut short keeps its header intact, so reading the header alone proves nothing."""
    try:
        size = os.path.getsize(path)
        if size < 10:
            return False
        with open(path, "rb") as f:
            (n,) = struct.unpack("<Q", f.read(8))
            if n < 2 or n > 100 * 1024 * 1024 or 8 + n > size:
                return False
            head = json.loads(f.read(n).decode("utf-8"))
        if not isinstance(head, dict):
            return False
        end = 0
        tensors = 0
        for key, value in head.items():
            if key == "__metadata__":
                continue
            off = value.get("data_offsets") if isinstance(value, dict) else None
            if not isinstance(off, list) or len(off) != 2 or off[0] < 0 or off[1] < off[0]:
                return False
            end = max(end, off[1])
            tensors += 1
        return tensors > 0 and size == 8 + n + end
    except (OSError, ValueError, struct.error):
        return False


def strip_trigger(caption: str, trigger: str) -> str:
    """Remove the trigger word from the head of a caption when it is there (LTX: the tool adds it itself in front
    of every caption). A caption that was the trigger alone becomes empty."""
    text = " ".join(str(caption or "").replace("﻿", "").split())
    trig = " ".join(str(trigger or "").split())
    if not trig or len(text) < len(trig) or text[: len(trig)].lower() != trig.lower():
        return text
    rest = text[len(trig):]
    if rest and not re.match(r"[\s,;:.!\-]", rest):
        return text                      # « rsa womanly » does not start with the trigger « rsa woman »
    return rest.lstrip(" ,;:.!-").strip()


def dump_yaml(obj, header: str = "") -> str:
    import yaml                           # PyYAML: in venv-ltx and venv-aitk
    body = yaml.safe_dump(obj, sort_keys=False, allow_unicode=True, default_flow_style=False, width=1000)
    return (header + body) if header else body


def kill_tree(pid: int) -> None:
    """The process and everything it started (Windows: taskkill /T /F, without a console window)."""
    if not pid:
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, creationflags=CREATE_NO_WINDOW, timeout=20, check=False)
        else:
            os.kill(pid, 9)
    except (OSError, subprocess.SubprocessError):
        pass


def child_python() -> tuple[str, dict]:
    """The interpreter and environment for a tool script started by the adapter: the real interpreter Mia gave
    (MIA_TRAIN_PYTHON) with __PYVENV_LAUNCHER__ naming the venv, exactly as Mia started the adapter itself — so no
    console window appears and site-packages stay those of the venv."""
    exe = os.environ.get("MIA_TRAIN_PYTHON") or sys.executable
    env = dict(os.environ)
    launcher = Path(sys.prefix) / "Scripts" / "python.exe"
    try:
        if launcher.is_file() and Path(exe).resolve() != launcher.resolve():
            env["__PYVENV_LAUNCHER__"] = str(launcher)
    except OSError:
        pass
    return exe, env


def mia_root() -> Path:
    return Path(__file__).resolve().parents[2]


def load_catalog() -> dict:
    path = os.environ.get("MIA_TRAIN_CATALOG") or (mia_root() / "src" / "catalog" / "train-bases.json")
    return read_json(Path(path))


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Mia training adapter")
    p.add_argument("--dir", required=True, help="training folder")
    p.add_argument("--run", type=int, default=1, help="launch number (train.json.run)")
    p.add_argument("--token", default="", help="drawn by Mia at each launch, repeated in control\\adapter.json")
    p.add_argument("--resume", type=int, default=0, help="step of the verified checkpoint to resume from")
    p.add_argument("--dry", action="store_true", help="write and validate the configuration, no GPU work")
    return p.parse_args(argv)


# ---------------------------------------------------------------------------------------------- the training folder
class Session:
    """One launch of an adapter on one training folder."""

    def __init__(self, args):
        self.dir = Path(args.dir).resolve()
        self.run = max(1, int(args.run or 1))
        self.token = str(args.token or "")
        self.resume = max(0, int(args.resume or 0))
        self.dry = bool(args.dry)
        self.control = self.dir / "control"
        self.out = self.dir / "out"
        self.dataset = self.dir / "dataset"
        self._events = self.dir / "events.jsonl"
        self._metrics = self.dir / "metrics.jsonl"
        self._lock = threading.Lock()
        self.dry_events: list[dict] = []
        self.timing = dict(TIMING)
        try:
            self.timing.update({k: float(v) for k, v in json.loads(os.environ.get("MIA_TRAIN_TIMING") or "{}").items() if k in TIMING})
        except (ValueError, TypeError, AttributeError):
            pass
        self.doc = {}
        self.settings = {}
        self.base = {}

    def load(self) -> None:
        """train.json (read only) and the catalog entry of its base. Raises Abort when something is unusable."""
        try:
            self.doc = read_json(self.dir / "train.json")
        except (OSError, ValueError) as e:
            raise Abort("tool", f"train.json illisible dans {self.dir} : {e}", "config") from e
        if not isinstance(self.doc, dict):
            raise Abort("tool", "train.json n’est pas un objet", "config")
        self.settings = self.doc.get("settings") if isinstance(self.doc.get("settings"), dict) else {}
        try:
            bases = load_catalog().get("bases") or []
        except (OSError, ValueError) as e:
            raise Abort("tool", f"catalogue des modèles illisible : {e}", "config") from e
        self.base = next((b for b in bases if b.get("id") == self.doc.get("base")), None) or {}
        if not self.base:
            raise Abort("tool", f"modèle inconnu du catalogue : {self.doc.get('base')!r}", "config")
        if self.steps < 1:
            raise Abort("tool", "nombre de pas invalide dans train.json", "config")
        if self.resume >= self.steps:
            raise Abort("resume", f"reprise au pas {self.resume} : il ne reste aucun pas (total {self.steps})", "config")

    # -- what the draft says
    @property
    def steps(self) -> int:
        try:
            return int(self.doc.get("steps") or 0)
        except (TypeError, ValueError):
            return 0

    @property
    def trigger(self) -> str:
        return " ".join(str(self.doc.get("trigger") or "").split())

    @property
    def slug(self) -> str:
        return str(self.doc.get("slug") or "").strip()

    def setting(self, key: str, default=None):
        value = self.settings.get(key)
        if value is None:
            value = (self.base.get("defaults") or {}).get(key)
        return default if value is None else value

    def int_setting(self, key: str, default: int = 0) -> int:
        try:
            return max(0, int(self.setting(key, default) or 0))
        except (TypeError, ValueError):
            return default

    def prompts(self) -> list[str]:
        raw = self.settings.get("samplePrompts")
        return [p.strip() for p in (raw if isinstance(raw, list) else []) if isinstance(p, str) and p.strip()][:4]

    def images(self) -> list[dict]:
        """The set, in order: [{file, original, path, caption}] — caption read from the training's own copy."""
        try:
            listing = read_json(self.dataset / "dataset.json")
        except (OSError, ValueError) as e:
            raise Abort("tool", f"dataset.json illisible : {e}", "config") from e
        out = []
        for entry in listing if isinstance(listing, list) else []:
            name = str((entry or {}).get("file") or "")
            path = self.dataset / name
            if not name or not path.is_file():
                raise Abort("missing", name or "dataset.json", "dataset")
            caption = ""
            try:
                caption = path.with_suffix(".txt").read_text(encoding="utf-8-sig").strip()
            except OSError:
                caption = ""
            out.append({"file": name, "original": str(entry.get("original") or name), "path": path, "caption": caption})
        if not out:
            raise Abort("tool", "le jeu d’images est vide", "config")
        return out

    def weights(self, models_dir: str | os.PathLike | None) -> tuple[dict, list[str]]:
        """→ ({role: path}, [names of the missing files]) for the base, under <engine>\\models."""
        found, missing = {}, []
        for w in self.base.get("weights") or []:
            path = Path(models_dir or "") / str(w.get("dir") or "") / str(w.get("file") or "")
            found[str(w.get("role"))] = path
            if not models_dir or not path.is_file():
                missing.append(str(w.get("file")))
        return found, missing

    # -- the protocol
    def rel(self, path) -> str:
        try:
            return posix(Path(path).resolve().relative_to(self.dir))
        except ValueError:
            return posix(path)

    def emit(self, event: dict) -> None:
        if self.dry:
            self.dry_events.append(event)
            return
        line = json.dumps(event, ensure_ascii=False) + "\n"
        with self._lock:
            with open(self._events, "a", encoding="utf-8", newline="\n") as f:
                f.write(line)

    def phase(self, phase: str, n: int | None = None, of: int | None = None) -> None:
        event = {"e": "phase", "phase": phase}
        if n is not None and of is not None:
            event.update({"n": int(n), "of": int(of)})
        event["t"] = now_ms()
        self.emit(event)

    def metric(self, step: int, loss, lr, dt, t: int | None = None) -> None:
        if self.dry:
            return
        def num(x, digits):
            try:
                x = float(x)
            except (TypeError, ValueError):
                return None
            return round(x, digits) if x == x and abs(x) != float("inf") else None
        line = json.dumps({"run": self.run, "s": int(step), "loss": num(loss, 6), "lr": num(lr, 12), "dt": num(dt, 3), "t": t or now_ms()}) + "\n"
        with self._lock:
            with open(self._metrics, "a", encoding="utf-8", newline="\n") as f:
                f.write(line)

    def say(self, line: str) -> None:
        """One line in log.txt (the adapter's output), never mixed up with the tool's own."""
        try:
            sys.stdout.write(f"[mia] {line}\n")
            sys.stdout.flush()
        except (OSError, ValueError):
            pass

    def report(self, payload: dict) -> None:
        """--dry: the one line the caller reads."""
        sys.stdout.write("MIA_DRY " + json.dumps(payload, ensure_ascii=False, default=str) + "\n")
        sys.stdout.flush()


# ---------------------------------------------------------------------------------------------- the watch thread
class Watch(threading.Thread):
    """adapter.json and control\\alive, in a thread of their own: the step callback of a tool comes neither while the
    model loads nor during a sample, and Mia must know all along that the adapter is alive (and the other way round).

    - adapter.json {pid, token, t} is rewritten every 20 s;
    - an `alive` older than 180 s is only acted upon after two readings 45 s apart showing the same unchanged file:
      `pause_wanted` is then set, and the adapter does as for `pause` at the next step;
    - beyond 15 min without `alive`: forced exit (on_force first: it kills what the adapter started);
    - if the clock jumped by more than 60 s between two readings (back from sleep), the counters start again.
    """

    def __init__(self, session: Session, on_force=None):
        super().__init__(name="mia-watch", daemon=True)
        self.s = session
        self.on_force = on_force
        self.pause_wanted = False
        self._halt = threading.Event()
        self._last_tick = None
        self._stale_seen = None       # (mtime, when first read)
        self._lost_at = None

    def heartbeat(self) -> None:
        try:
            write_atomic(self.s.control / "adapter.json", json.dumps({"pid": os.getpid(), "token": self.s.token, "t": now_ms()}))
        except OSError:
            pass                       # the next beat tries again

    def check_alive(self, now: float | None = None) -> None:
        t = self.s.timing
        now = now_ms() if now is None else now
        if self._last_tick is not None and now - self._last_tick > t["jumpMs"] + t["aliveCheckMs"]:
            self._stale_seen = None    # back from sleep: Mia has not had the time to write yet
            self._lost_at = None
            self._last_tick = now
            return
        self._last_tick = now
        try:
            mtime = (self.s.control / "alive").stat().st_mtime * 1000
        except OSError:
            mtime = 0
        if now - mtime <= t["aliveStaleMs"]:
            self._stale_seen = None
            self._lost_at = None
            return
        if self._lost_at is None:
            self._lost_at = now
        if now - self._lost_at > t["aliveForceMs"]:
            self.s.say("Mia ne donne plus signe de vie : sortie forcée")
            try:
                if self.on_force:
                    self.on_force()
            finally:
                os._exit(3)
        if self._stale_seen is None or self._stale_seen[0] != mtime:
            self._stale_seen = (mtime, now)
            return
        if now - self._stale_seen[1] >= t["aliveRecheckMs"] and not self.pause_wanted:
            self.pause_wanted = True
            self.s.say("Mia ne donne plus signe de vie : arrêt avec point de contrôle au prochain pas")

    def run(self) -> None:
        t = self.s.timing
        next_beat = 0.0
        next_check = time.time() + t["aliveCheckMs"] / 1000
        step = max(0.02, min(t["heartbeatMs"], t["aliveCheckMs"], 1000) / 1000 / 2)
        while not self._halt.is_set():
            now = time.time()
            if now >= next_beat:
                self.heartbeat()
                next_beat = now + t["heartbeatMs"] / 1000
            if now >= next_check:
                try:
                    self.check_alive()
                except OSError:
                    pass
                next_check = now + t["aliveCheckMs"] / 1000
            self._halt.wait(step)

    def halt(self) -> None:
        self._halt.set()

    def asked(self) -> str | None:
        """What Mia asks for, if anything: 'stop', 'pause', or 'alive' (Mia is gone)."""
        if (self.s.control / "stop").exists():
            return "stop"
        if (self.s.control / "pause").exists():
            return "pause"
        return "alive" if self.pause_wanted else None


# ---------------------------------------------------------------------------------------------- entry point
def run_adapter(main) -> None:
    """Run main(session) and turn what it raises into the protocol's last word and an exit code."""
    args = parse_args()
    s = Session(args)
    if s.dry:
        os.environ["CUDA_VISIBLE_DEVICES"] = ""       # --dry never reaches the graphics card
    code = 0
    try:
        code = int(main(s) or 0)
    except Stopped:
        code = 0
    except ToolExit as e:
        code = e.exit_code or 1
    except Abort as a:
        s.say(f"abandon ({a.code}{' / ' + a.why if a.why else ''}) : {a.message}")
        if s.dry:
            s.report({"ok": False, "error": {"code": a.code, "why": a.why, "message": a.message}})
        else:
            try:
                s.emit({"e": "error", "code": a.code, "message": a.message, **({"why": a.why} if a.why else {})})
            except OSError:
                pass                                   # disk full: Mia measures it herself
        code = 1
    except SystemExit:
        raise
    except KeyboardInterrupt:
        s.say("interrompu")
        code = 130
    except BaseException:                              # noqa: BLE001 — the trace goes to log.txt, Mia classifies it
        traceback.print_exc()
        if s.dry:
            s.report({"ok": False, "error": {"code": "tool", "why": "crash", "message": traceback.format_exc().strip().splitlines()[-1]}})
        code = 1
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except (OSError, ValueError):
        pass
    sys.exit(code)
