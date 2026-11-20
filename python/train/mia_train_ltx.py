# -*- coding: utf-8 -*-
"""Mia — training adapter for Lightricks' ltx-trainer (LTX 2.5), run with the Python of venv-ltx.

    <python> -B -u mia_train_ltx.py --dir <training folder> --run <n> --token <t> [--resume <step>] [--dry]

What it does, in order (protocol and watch thread: mia_train_common.py):
  check    writes ltx.json (the tool's dataset file) and config.yaml from train.json, checks the tool's version and
           the signatures it hooks, validates the configuration with the tool's own schema (LtxTrainerConfig);
  encode   scripts\\preprocess.py config.yaml in a sub-process, only when the cache key (cache\\cle.json) changed;
  load     the trainer is built and loads the model INSIDE this process (import ltx_trainer);
  train    one line of metrics.jsonl per step, checkpoints and samples announced as they appear; pause and stop
           write a checkpoint at the current step and leave cleanly.

--dry stops after `check`: nothing is encoded, no model is loaded, the graphics card is hidden.

The hooks hold to ltx-trainer 1.6.2 exactly (TrainingProgress replaced by a subclass, LtxvTrainer._save_checkpoint
called on pause): any other version, or a changed signature, is refused before anything is loaded.
"""
from __future__ import annotations

import inspect
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mia_train_common as C  # noqa: E402
from mia_train_common import Abort, Stopped, ToolExit  # noqa: E402

DIST = "ltx-trainer"

# The LoRA goes on the attention and feed-forward projections of every block (the settings of the proven run).
TARGET_MODULES = [
    "attn1.to_k", "attn1.to_q", "attn1.to_v", "attn1.to_out.0",
    "attn2.to_k", "attn2.to_q", "attn2.to_v", "attn2.to_out.0",
    "ff.net.0.proj", "ff.net.2",
]

# What the adapter relies on in the tool: parameter names, in order (inspect.signature).
SIGNATURES = {
    "LtxvTrainer.train": ["self", "disable_progress_bars", "step_callback"],
    "LtxvTrainer._save_checkpoint": ["self"],
    "TrainingProgress.__init__": ["self", "enabled", "total_steps"],
    "TrainingProgress.update_training": ["self", "metrics", "step_time", "advance"],
    "TrainingProgress.start_sampling": ["self", "num_prompts", "num_steps"],
    "SamplingContext.__init__": ["self", "progress", "task", "num_prompts", "num_steps"],
    "SamplingContext.start_video": ["self", "video_idx"],
    "SamplingContext.advance_step": ["self"],
    "SamplingContext.cleanup": ["self"],
}

VIDEO_EXT = {".mp4", ".webm", ".mov", ".mkv"}


# ---------------------------------------------------------------------------------------------- the tool
def installed_version() -> str | None:
    """Version of the installed package, without importing it."""
    from importlib import metadata
    try:
        return metadata.version(DIST)
    except metadata.PackageNotFoundError:
        return None


def guard_version(expected: str | None) -> str:
    version = installed_version()
    if not version or (expected and version != expected):
        raise Abort("tool", f"Version de l’outil LTX non reconnue : {version or 'absente'} (attendue : {DIST} {expected}).", "version")
    return version


class Tool:
    """The pieces of ltx_trainer the adapter uses (imported once; torch comes with them, no model is loaded)."""

    def __init__(self):
        from ltx_trainer import progress as progress_module
        from ltx_trainer import trainer as trainer_module
        from ltx_trainer.config import LtxTrainerConfig
        from ltx_trainer.preprocessing.manifest import assert_preprocess_manifest_matches
        from ltx_trainer.training_strategies import get_training_strategy
        self.trainer_module = trainer_module
        self.LtxvTrainer = trainer_module.LtxvTrainer
        self.TrainingProgress = progress_module.TrainingProgress
        self.SamplingContext = progress_module.SamplingContext
        self.LtxTrainerConfig = LtxTrainerConfig
        self.assert_manifest = assert_preprocess_manifest_matches
        self.get_training_strategy = get_training_strategy


def guard_signatures(tool: Tool) -> None:
    """The hooks only hold when these functions take what the adapter gives them."""
    owners = {"LtxvTrainer": tool.LtxvTrainer, "TrainingProgress": tool.TrainingProgress, "SamplingContext": tool.SamplingContext}
    wrong = []
    for dotted, expected in SIGNATURES.items():
        owner, name = dotted.split(".")
        fn = getattr(owners[owner], name, None)
        try:
            got = list(inspect.signature(fn).parameters) if fn is not None else None
        except (TypeError, ValueError):
            got = None
        if got != expected:
            wrong.append(f"{dotted}({', '.join(got) if got is not None else 'absente'})")
    if getattr(tool.trainer_module, "TrainingProgress", None) is not tool.TrainingProgress:
        wrong.append("trainer.TrainingProgress")
    if wrong:
        raise Abort("tool", "Outil LTX : signatures inattendues, " + " ; ".join(wrong), "signature")


# ---------------------------------------------------------------------------------------------- configuration
def checkpoint_dir(s: C.Session, step: int) -> Path:
    return s.out / "checkpoints" / f"step_{step:05d}"


def dataset_rows(s: C.Session, images: list[dict]) -> tuple[list[dict], dict]:
    """ltx.json: columns « video » and « caption ». The trigger word at the head of a caption is removed: the tool
    puts it itself in front of every caption (lora_trigger)."""
    rows, stripped, empty = [], 0, 0
    for im in images:
        caption = C.strip_trigger(im["caption"], s.trigger)
        if caption != " ".join(im["caption"].split()):
            stripped += 1
        if not caption:
            empty += 1
        rows.append({"video": f"dataset/{im['file']}", "caption": caption})
    return rows, {"stripped": stripped, "empty": empty}


def buckets_of(s: C.Session) -> list[list[int]]:
    out = []
    for r in s.setting("resolutions", []) or []:
        if isinstance(r, (list, tuple)) and len(r) >= 2:
            out.append([int(r[0]), int(r[1]), 1])
        elif isinstance(r, (int, float)):
            out.append([int(r), int(r), 1])
    if not out:
        raise Abort("tool", "aucune taille d’image dans les réglages", "config")
    return out


def build_config(s: C.Session, models_dir: str | None) -> dict:
    """config.yaml = the proven run (essais\\rosa_ltx25_essai20.yaml) with the values of train.json."""
    weights, _missing = s.weights(models_dir)
    sample = s.base.get("sample") or {}
    buckets = buckets_of(s)
    rank = s.int_setting("rank", 32) or 32
    prompts = s.prompts()
    sample_every = s.int_setting("sampleEvery", 0)
    save_every = s.int_setting("saveEvery", 250) or 250
    batch = s.int_setting("batch", 1) or 1
    return {
        "training_strategy": {
            "name": "flexible",
            "model": {
                "model_path": C.posix(weights.get("model", "")),
                "text_encoder_path": C.posix(weights.get("text_encoder", "")),
                "video_vae_path": C.posix(weights.get("video_vae", "")),
                "audio_vae_path": None,
                "load_text_encoder_in_8bit": False,
            },
            "training_mode": "lora",
            "lora": {"rank": rank, "alpha": rank, "dropout": 0.0, "target_modules": list(TARGET_MODULES)},
            "quantization": None,
            "data": {
                "dataset_file": C.posix(s.dir / "ltx.json"),
                "preprocessed_data_root": C.posix(s.dir / "cache"),
                "resolution_buckets": buckets,
                "skip_audio": True,
                "lora_trigger": s.trigger or None,
                "num_dataloader_workers": 0,
                "encode_num_workers": 0,
            },
            "video": {"is_generated": True, "latents_dir": "latents"},
            "optimizer": {
                "learning_rate": float(s.setting("lr", 1e-4)),
                "optimizer_type": str(s.setting("optimizer", "adamw")),
                "scheduler_type": "linear",
                "scheduler_params": {},
                "gradient_checkpointing": True,
            },
            "timestep_sampling": {"timestep_sampling_mode": "shifted_logit_normal", "timestep_sampling_params": {}},
            "validation": {
                "samples": [{"prompt": p} for p in prompts],
                "negative_prompt": str(sample.get("negative") or ""),
                "video_dims": [int(sample.get("width", 448)), int(sample.get("height", 768)), int(sample.get("frames", 49))],
                "frame_rate": float(sample.get("fps", 24)),
                "seed": 42,
                "inference_steps": int(sample.get("steps", 25)),
                "video_cfg_scale": float(sample.get("cfg", 3)),
                "audio_cfg_scale": 7.0,
                "video_stg_scale": float(sample.get("stg", 1)),
                "audio_stg_scale": 1.0,
                "stg_blocks": [int(b) for b in sample.get("stgBlocks", [28])],
                "guidance_rescale": float(sample.get("rescale", 0.7)),
                "video_modality_guidance_scale": 3.0,
                "audio_modality_guidance_scale": 3.0,
                "generate_audio": False,
            },
        },
        "optimization": {
            "steps": s.steps,
            "batch_size": 1 if len(buckets) > 1 else batch,       # several image sizes impose a batch of 1
            "gradient_accumulation_steps": 1,
            "max_grad_norm": 1.0,
            "mixed_precision_mode": "bf16",
            "offload_optimizer_during_validation": False,
        },
        "validation": {"interval": sample_every if (sample_every and prompts) else None, "skip_initial_validation": True},
        "checkpoints": {
            "load_checkpoint": C.posix(checkpoint_dir(s, s.resume)) if s.resume else None,
            "no_resume": not s.resume,
            "interval": save_every,
            "keep_last_n": -1,
            "precision": "bfloat16",
            "save_training_state": "minimal",
        },
        "wandb": {"enabled": False, "project": "ltx-2-trainer", "entity": None, "tags": [], "log_validation_videos": False},
        "seed": 42,
        "output_dir": C.posix(s.out),
    }


def write_config(s: C.Session, config: dict, rows: list[dict]) -> Path:
    C.write_atomic(s.dir / "ltx.json", json.dumps(rows, ensure_ascii=False, indent=1))
    header = (f"# Écrit par Mia (python\\train\\mia_train_ltx.py), lancement {s.run}"
              f"{', reprise du pas ' + str(s.resume) if s.resume else ''}. Régénéré à chaque lancement : ne pas modifier.\n")
    path = s.dir / "config.yaml"
    C.write_atomic(path, C.dump_yaml(config, header))
    return path


def validate_config(tool: Tool, config: dict):
    """The tool's own schema, in both modes; returns the configuration object the trainer takes."""
    try:
        tool.LtxTrainerConfig.from_dict(json.loads(json.dumps(config)), mode="preprocess")
        return tool.LtxTrainerConfig.from_dict(json.loads(json.dumps(config)), mode="train")
    except Exception as e:  # noqa: BLE001 — pydantic's error, whatever its class
        said = " | ".join(line.strip() for line in str(e).strip().splitlines()[:3])[:400]
        raise Abort("tool", f"configuration refusée par l’outil LTX : {said}", "config") from e


# ---------------------------------------------------------------------------------------------- the encoding cache
def cache_key(s: C.Session, images: list[dict], rows: list[dict], config: dict) -> dict:
    """What the pre-encoded files depend on. Any difference → cache\\ emptied and encoding done again."""
    model = config["training_strategy"]["model"]
    return {
        "v": 1,
        "trigger": s.trigger,
        "buckets": config["training_strategy"]["data"]["resolution_buckets"],
        "images": [{**(C.file_id(im["path"]) or {"name": im["file"]}), "caption": C.sha1(row["caption"])} for im, row in zip(images, rows)],
        "weights": [C.file_id(Path(model["text_encoder_path"])) or {"name": Path(model["text_encoder_path"]).name},
                    C.file_id(Path(model["video_vae_path"])) or {"name": Path(model["video_vae_path"]).name}],
    }


def cache_files(s: C.Session) -> int:
    cache = s.dir / "cache"
    return sum(1 for _ in cache.rglob("*.pt")) if cache.is_dir() else 0


def cache_state(s: C.Session, key: dict) -> dict:
    """→ {state: 'absent' | 'match' | 'stale', diff: [what changed]}"""
    cache = s.dir / "cache"
    try:
        saved = C.read_json(cache / "cle.json")
    except (OSError, ValueError):
        return {"state": "absent", "diff": []}
    diff = [k for k in ("v", "trigger", "buckets", "weights") if saved.get(k) != key.get(k)]
    old = {str(i.get("name")): i for i in saved.get("images") or [] if isinstance(i, dict)}
    new = {str(i.get("name")): i for i in key["images"]}
    diff += sorted(name for name in set(old) | set(new) if old.get(name) != new.get(name))
    if not diff and [i.get("name") for i in saved.get("images") or []] != [i.get("name") for i in key["images"]]:
        diff.append("ordre")
    if not diff and (not (cache / "preprocess_manifest.json").is_file() or cache_files(s) < 2 * len(key["images"])):
        diff.append("incomplet")
    return {"state": "stale" if diff else "match", "diff": diff}


def wipe_cache(s: C.Session) -> None:
    cache = s.dir / "cache"
    if cache.exists():
        shutil.rmtree(cache, ignore_errors=True)
    cache.mkdir(parents=True, exist_ok=True)


def sources_dir() -> Path:
    tools = os.environ.get("MIA_TRAIN_TOOLS")
    return Path(tools) / "src" / "LTX-2" / "packages" / "ltx-trainer" if tools else Path.cwd()


def encode(s: C.Session, watch: C.Watch, config_path: Path, images: int) -> None:
    """scripts\\preprocess.py in a sub-process (it loads Gemma then the VAE, and frees them by leaving).
    Progress = files appeared in cache\\ over 2 × images; if the count does not fit, no numbers (indeterminate bar)."""
    script = sources_dir() / "scripts" / "preprocess.py"
    if not script.is_file():
        raise Abort("tool", f"script d’encodage introuvable : {script}", "config")
    exe, env = C.child_python()
    s.phase("encode", 0, images)
    s.say(f"encodage : {exe} {script} {config_path}")
    sys.stdout.flush()
    proc = subprocess.Popen([exe, "-B", "-u", str(script), str(config_path)], cwd=str(script.parent.parent), env=env,
                            stdin=subprocess.DEVNULL, stdout=sys.stdout, stderr=subprocess.STDOUT, creationflags=C.CREATE_NO_WINDOW)
    last = (0, True)
    try:
        while proc.poll() is None:
            time.sleep(s.timing["pollMs"] / 1000)
            why = watch.asked()
            if why:
                C.kill_tree(proc.pid)
                s.emit({"e": "stopped", "step": s.resume, "saved": False, "why": why})
                raise Stopped()
            count = cache_files(s)
            fits = count <= 2 * images
            cur = (min(images, count // 2), fits)
            if cur != last:
                last = cur
                s.phase("encode", cur[0], images) if fits else s.phase("encode")
    finally:
        if proc.poll() is None:
            C.kill_tree(proc.pid)
    if proc.returncode != 0:
        s.say(f"l’encodage s’est arrêté (code {proc.returncode})")
        raise ToolExit(proc.returncode)
    s.phase("encode", images, images)


def manifest_ok(tool: Tool, config) -> str | None:
    """None when the trainer will accept the cache; else the tool's own sentence."""
    try:
        fingerprint = tool.get_training_strategy(config.training_strategy).preprocessing_fingerprint()
        if fingerprint is not None:
            tool.assert_manifest(fingerprint.artifact_root, fingerprint.fields, allow_stale=False)
        return None
    except ValueError as e:
        return str(e).strip().splitlines()[0][:300]


# ---------------------------------------------------------------------------------------------- hooks in the trainer
class Hook:
    """What the replaced TrainingProgress tells Mia. Order inside one step of the trainer (trainer.py, 1.6.2):
    train_step → sample (if due) → checkpoint (if due) → step_callback → update_training(metrics of this step)."""

    def __init__(self, s: C.Session, watch: C.Watch):
        self.s = s
        self.watch = watch
        self.trainer = None
        self.announced: set[int] = set()
        self.first = True
        self.measured = 0
        self.no_loss = 0
        self.video = None            # (index, started at) of the sample being rendered
        self.sample_total = 0
        self.sample_prompts = 0
        self.sample_n = 0

    # -- start
    def started(self, total_steps: int) -> None:
        """The trainer has loaded everything and restored its state: TrainingProgress is being built."""
        initial = getattr(self.trainer, "_initial_step", None)
        if not isinstance(initial, int) or not hasattr(self.trainer, "_global_step") or not hasattr(self.trainer, "_last_checkpoint_step"):
            raise Abort("tool", "Outil LTX : état du trainer introuvable (_initial_step, _global_step, _last_checkpoint_step)", "signature")
        if initial != self.s.resume:
            # the tool restarts from another step in silence (unreadable state, different settings): stop before any step
            raise Abort("resume", f"reprise demandée au pas {self.s.resume}, l’outil repart du pas {initial}", "resume")
        if self.s.resume:
            self.s.emit({"e": "resumed", "step": self.s.resume})
        self.s.say(f"entraînement : pas {initial} → {self.s.steps} ({total_steps} à faire)")
        self.s.phase("train")

    def callback(self, step: int, total: int, last_validation) -> None:
        """step_callback: called before the step is measured — nothing to tell yet."""

    # -- one step
    def step(self, metrics: dict, step_time: float) -> None:
        trainer = self.trainer
        step = int(trainer._global_step)
        if self.first:
            self.first = False
            if step != self.s.resume + 1:
                raise Abort("resume", f"reprise demandée au pas {self.s.resume}, premier pas mesuré : {step}", "resume")
        self.measured += 1
        loss = metrics.get("train/loss") if isinstance(metrics, dict) else None
        lr = next((v for k, v in metrics.items() if str(k).startswith("train/learning_rate")), None) if isinstance(metrics, dict) else None
        self.s.metric(step, loss, lr, step_time)
        if loss is None:
            self.no_loss += 1
            if self.measured >= 3 and self.no_loss == self.measured:
                raise Abort("tool", "Outil LTX : les 3 premiers pas n’apportent pas « train/loss »", "noloss")
        if trainer._last_checkpoint_step == step:
            self.announce(step)
        ask = self.watch.asked()
        if ask:
            self.s.say(f"{ask} au pas {step}")
            if trainer._last_checkpoint_step != step:
                self.s.phase("save")
                trainer._save_checkpoint()
            self.announce(step)
            self.s.emit({"e": "stopped", "step": step, "saved": True, "why": ask})
            raise Stopped()

    def announce(self, step: int) -> None:
        if step in self.announced:
            return
        file = checkpoint_dir(self.s, step) / "weights.safetensors"
        if not file.is_file():
            raise Abort("tool", f"Outil LTX : point de contrôle annoncé au pas {step}, fichier absent ({self.s.rel(file)})", "checkpoint")
        self.announced.add(step)
        self.s.emit({"e": "checkpoint", "step": step, "file": self.s.rel(file), "sizeMB": round(file.stat().st_size / 1048576, 3)})

    # -- samples
    def sampling(self, num_prompts: int, num_steps: int) -> None:
        self.sample_prompts = int(num_prompts)
        self.sample_total = int(num_steps)
        self.video = None
        self.s.phase("sample")

    def start_video(self, index: int) -> None:
        self.close_video()
        self.video = (int(index), time.time())
        self.sample_n = 0
        self.s.emit({"e": "sample_step", "i": index + 1, "of": self.sample_prompts, "n": 0, "total": self.sample_total})

    def advance(self) -> None:
        if self.video is None:
            return
        self.sample_n += 1
        self.s.emit({"e": "sample_step", "i": self.video[0] + 1, "of": self.sample_prompts, "n": self.sample_n, "total": self.sample_total})

    def close_video(self) -> None:
        """The file of the sample just rendered: out\\samples\\step_{step:06d}_{i}.mp4 (or an image)."""
        if self.video is None:
            return
        index, t0 = self.video
        self.video = None
        step = int(self.trainer._global_step)
        folder = self.s.out / "samples"
        found = sorted(folder.glob(f"step_{step:06d}_{index + 1}.*")) if folder.is_dir() else []
        if not found:
            self.s.say(f"essai du pas {step} : fichier attendu absent (step_{step:06d}_{index + 1}.*)")
            return
        file = found[0]
        self.s.emit({"e": "sample", "step": step, "i": index + 1, "file": self.s.rel(file),
                     "kind": "video" if file.suffix.lower() in VIDEO_EXT else "image", "sec": round(time.time() - t0, 1)})

    def sampling_done(self) -> None:
        self.close_video()
        self.s.phase("train")


def install_hooks(tool: Tool, hook: Hook) -> None:
    """Replace the TrainingProgress the trainer instantiates by a subclass that reports to Mia (no Rich display)."""
    base_progress, base_context = tool.TrainingProgress, tool.SamplingContext

    class MiaSampling(base_context):
        def __init__(self, num_prompts: int, num_steps: int):
            super().__init__(progress=None, task=None, num_prompts=num_prompts, num_steps=num_steps)

        def start_video(self, video_idx: int) -> None:
            hook.start_video(video_idx)

        def advance_step(self) -> None:
            hook.advance()

        def cleanup(self) -> None:
            hook.sampling_done()

    class MiaProgress(base_progress):
        def __init__(self, enabled: bool, total_steps: int):
            super().__init__(enabled=False, total_steps=total_steps)
            hook.started(total_steps)

        def update_training(self, *, metrics, step_time, advance=True) -> None:
            hook.step(metrics, step_time)

        def start_sampling(self, num_prompts: int, num_steps: int):
            hook.sampling(num_prompts, num_steps)
            return MiaSampling(num_prompts, num_steps)

    tool.trainer_module.TrainingProgress = MiaProgress


def train(s: C.Session, watch: C.Watch, tool: Tool, config) -> None:
    hook = Hook(s, watch)
    install_hooks(tool, hook)
    s.phase("load")
    trainer = tool.LtxvTrainer(config)
    hook.trainer = trainer
    # Stopped and Abort raised from the hooks travel through train(): its `finally` tears the run down, and
    # _finalize_training is not reached (no stray final checkpoint).
    saved_path, stats = trainer.train(disable_progress_bars=True, step_callback=hook.callback)
    step = int(trainer._global_step)
    if step not in hook.announced:                       # the last step was not on the cadence: the final checkpoint
        if not (Path(saved_path) / "weights.safetensors").is_file():
            raise Abort("tool", f"Outil LTX : point final absent ({saved_path})", "checkpoint")
        hook.announce(step)
    peak = getattr(stats, "peak_gpu_memory_gb", None)
    s.emit({"e": "done", "step": step, **({"peakVramGB": round(float(peak), 1)} if peak else {})})
    s.say("terminé")


# ---------------------------------------------------------------------------------------------- entry point
def main(s: C.Session) -> int:
    version = installed_version()
    tool_name = f"{DIST} {version or '?'}"
    watch = C.Watch(s)
    if not s.dry:
        s.control.mkdir(parents=True, exist_ok=True)
        s.out.mkdir(parents=True, exist_ok=True)
        watch.start()
    s.emit({"e": "caps", "tool": tool_name, "saveNow": True, "run": s.run})
    s.say(f"{tool_name}, lancement {s.run}{', reprise du pas ' + str(s.resume) if s.resume else ''}{' (à blanc)' if s.dry else ''}")
    s.phase("check")
    s.load()
    guard_version(s.base.get("toolVersion"))

    images = s.images()
    rows, captions = dataset_rows(s, images)
    models_dir = os.environ.get("MIA_ENGINE_MODELS") or None
    config = build_config(s, models_dir)
    config_path = write_config(s, config, rows)
    _weights, missing = s.weights(models_dir)
    if missing and not s.dry:
        raise Abort("missing", missing[0], "weights")
    if s.resume and not s.dry:
        d = checkpoint_dir(s, s.resume)
        if not (C.safetensors_complete(d / "weights.safetensors") and (d / "state.pt").is_file() and (d / "metadata.json").is_file()):
            raise Abort("resume", f"point de contrôle du pas {s.resume} absent ou incomplet", "resume")

    tool = Tool()
    guard_signatures(tool)
    (s.dir / "cache").mkdir(parents=True, exist_ok=True)      # the schema (mode « train ») wants the folder to exist
    parsed = validate_config(tool, config)
    key = cache_key(s, images, rows, config)
    cache = cache_state(s, key)

    if s.dry:
        s.report({
            "ok": True, "tool": tool_name, "version": version, "signatures": sorted(SIGNATURES),
            "config": str(config_path), "dataset": str(s.dir / "ltx.json"), "images": len(images), "captions": captions,
            "batch": config["optimization"]["batch_size"], "weightsMissing": missing, "cache": cache, "cacheKey": key,
            "resume": {"step": s.resume, "loadCheckpoint": config["checkpoints"]["load_checkpoint"]},
        })
        return 0

    if cache["state"] == "match":
        s.say("encodage : rien n’a changé, cache gardé")
    else:
        s.say(f"encodage : {'cache absent' if cache['state'] == 'absent' else 'cache périmé (' + ', '.join(cache['diff'][:8]) + ')'}")
        wipe_cache(s)
        encode(s, watch, config_path, len(images))
        C.write_atomic(s.dir / "cache" / "cle.json", json.dumps(key, ensure_ascii=False, indent=1))
    refused = manifest_ok(tool, parsed)
    if refused:                                           # the trainer would refuse this cache: encode once more, then give up
        s.say(f"cache refusé par l’outil ({refused}) : encodage refait")
        wipe_cache(s)
        encode(s, watch, config_path, len(images))
        C.write_atomic(s.dir / "cache" / "cle.json", json.dumps(key, ensure_ascii=False, indent=1))
        refused = manifest_ok(tool, parsed)
        if refused:
            raise Abort("tool", f"Outil LTX : cache d’encodage refusé : {refused}", "cache")

    train(s, watch, tool, parsed)
    watch.halt()
    return 0


if __name__ == "__main__":
    C.run_adapter(main)
