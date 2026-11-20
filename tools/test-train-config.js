'use strict';
// Banc d'essai des adaptateurs d'entraînement (python\train\mia_train_*.py), SANS GPU : node tools/test-train-config.js
//
// - option --dry des deux adaptateurs, lancés par la commande des descripteurs electron\train\ltx.js et aitk.js :
//   la configuration écrite est validée par le schéma de chaque outil dans son venv (LtxTrainerConfig ; get_job
//   d'ai-toolkit) et comparée aux essais de référence rosa_ltx25_essai20.yaml et qwen21_essai20.yaml ;
// - garde de version et de signatures, retrait du mot déclencheur, clé du cache d'encodage ;
// - base Job d'ai-toolkit (création, remise à neuf après une pause), lecture d'un loss_log.db, dossier de reprise ;
// - lecture de l'avancement et fil de veille, sur de FAUX outils écrits par ce banc (un faux paquet ltx_trainer et un
//   faux run.py : aucun modèle, aucun torch, aucune carte graphique), lancés comme Mia les lance (sortie dans log.txt).
// Tout est écrit sous _dev/tmp/test-train-config-<pid>. Les outils réels ne sont jamais lancés (ni preprocess.py,
// ni train.py, ni run.py). Sans les outils d'entraînement sur la machine, les sections qui en dépendent sont sautées.
// Code de sortie 1 si un contrôle échoue.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const MIA = path.resolve(__dirname, '..');
const LTX = require(path.join(MIA, 'electron', 'train', 'ltx.js'));
const AITK = require(path.join(MIA, 'electron', 'train', 'aitk.js'));
const TC = require(path.join(MIA, 'electron', 'train', 'common.js'));

const TOOLS = process.env.MIA_TRAIN_TOOLS_DIR || 'C:\\IA\\entrainement';
const ENGINE = process.env.MIA_TEST_ENGINE || 'C:\\IA\\moteur';
const REF_LTX = path.join(TOOLS, 'essais', 'rosa_ltx25_essai20.yaml');
const REF_AITK = path.join(TOOLS, 'essais', 'qwen21_essai20.yaml');
const ADAPTERS = path.join(MIA, 'python', 'train');
const CATALOG = JSON.parse(fs.readFileSync(path.join(MIA, 'src', 'catalog', 'train-bases.json'), 'utf8'));

// ------------------------------------------------------------------ petit cadre de test
let failures = 0;
let passes = 0;
let skipped = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log(`  ok    ${name}`); }
  else { failures++; console.log(`  ÉCHEC ${name}${detail !== undefined ? ` → ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}
const section = (t) => console.log(`\n== ${t}`);
const skip = (t) => { skipped++; console.log(`  sauté ${t}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000, every = 25) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await wait(every);
  }
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const events = (dir) => lines(path.join(dir, 'events.jsonl'));
const metrics = (dir) => lines(path.join(dir, 'metrics.jsonl'));
const logOf = (dir) => (fs.existsSync(path.join(dir, 'log.txt')) ? fs.readFileSync(path.join(dir, 'log.txt'), 'utf8') : '');

const WORK = path.join(MIA, '_dev', 'tmp', `test-train-config-${process.pid}`);
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

// ------------------------------------------------------------------ un dossier d'entraînement, comme Mia l'écrit
function makeTraining(name, { base, trigger, steps, settings, images, slug }) {
  const dir = path.join(WORK, name);
  const b = CATALOG.bases.find((x) => x.id === base);
  fs.mkdirSync(path.join(dir, 'dataset'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'control'), { recursive: true });
  const list = images.map((im, k) => {
    const file = `${String(k + 1).padStart(4, '0')}.png`;
    fs.writeFileSync(path.join(dir, 'dataset', file), Buffer.from(`image ${k + 1} de ${name}`));
    if (im.caption != null) fs.writeFileSync(path.join(dir, 'dataset', file.replace('.png', '.txt')), im.caption, 'utf8');
    return { n: k + 1, file, original: im.original || `photo_${k + 1}.png`, w: 1024, h: 1536, captionBy: im.caption != null ? 'user' : null };
  });
  fs.writeFileSync(path.join(dir, 'dataset', 'dataset.json'), JSON.stringify(list, null, 1));
  const doc = {
    v: 1, id: `t_20261118-1200_${name}`, name, slug: slug || name, base, tool: b.tool, kind: 'character', trigger,
    run: 0, state: 'pret', step: 0, steps,
    settings: { ...b.defaults, samplePrompts: [`${trigger}, close-up of the face`], triggerOnly: false, ...settings },
    dataset: { count: list.length, captions: list.filter((e) => e.captionBy).length }
  };
  fs.writeFileSync(path.join(dir, 'train.json'), JSON.stringify(doc, null, 1));
  fs.writeFileSync(path.join(dir, 'control', 'alive'), String(Date.now()));
  return dir;
}
const setDoc = (dir, patch) => {
  const f = path.join(dir, 'train.json');
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...d, ...patch, settings: { ...d.settings, ...(patch.settings || {}) } }, null, 1));
};
const touchAlive = (dir) => fs.writeFileSync(path.join(dir, 'control', 'alive'), String(Date.now()));

// ------------------------------------------------------------------ lancer un adaptateur par la commande du descripteur
function commandOf(tool, dir, { run = 1, resume = 0, token = 'jeton' } = {}) {
  return tool.command({ dir, run, token, resumeFrom: resume, toolsDir: TOOLS, root: MIA, engineRoot: ENGINE });
}
/** --dry : sortie capturée, on lit la ligne « MIA_DRY {json} ». */
function dry(tool, dir, opts = {}, env = {}) {
  const cmd = commandOf(tool, dir, opts);
  const r = spawnSync(cmd.exe, [...cmd.args, '--dry'], { cwd: cmd.cwd, env: { ...process.env, ...cmd.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 900000, maxBuffer: 64 * 1024 * 1024 });
  const line = String(r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('MIA_DRY '));
  let report = null;
  try { report = line ? JSON.parse(line.slice(8)) : null; } catch { report = null; }
  return { code: r.status, report, out: `${r.stdout || ''}\n${r.stderr || ''}` };
}
/** Lancement réel de l'adaptateur (sur un faux outil) : comme Mia, sortie dans log.txt par un descripteur de fichier. */
function launch(tool, dir, opts = {}, env = {}) {
  const cmd = commandOf(tool, dir, opts);
  for (const f of ['pause', 'stop', 'adapter.json']) fs.rmSync(path.join(dir, 'control', f), { force: true });
  touchAlive(dir);
  const fd = fs.openSync(path.join(dir, 'log.txt'), 'a');
  fs.writeSync(fd, `\n---- Mia : lancement ${opts.run || 1} ----\n`);
  const child = spawn(cmd.exe, cmd.args, { cwd: cmd.cwd, env: { ...process.env, ...cmd.env, ...env }, stdio: ['ignore', fd, fd], windowsHide: true });
  fs.closeSync(fd);
  const beat = opts.noAlive ? null : setInterval(() => { try { touchAlive(dir); } catch { /* fini */ } }, 500);
  const done = new Promise((resolve) => {
    child.on('exit', (code) => { if (beat) clearInterval(beat); resolve(code); });
    child.on('error', () => { if (beat) clearInterval(beat); resolve(-1); });
  });
  return { child, done };
}
const withTimeout = (p, ms, child) => Promise.race([p, wait(ms).then(() => { try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* parti */ } return 'délai'; })]);

function yamlToJson(python, file) {
  const r = spawnSync(python.exe, ['-B', '-c', 'import yaml, json, sys; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding="utf-8"))))', file],
    { env: { ...process.env, ...python.env }, encoding: 'utf8', windowsHide: true });
  return JSON.parse(r.stdout);
}

/** Différences entre deux configurations, chemin par chemin ; les nombres écrits « 1e-4 » et les \ des chemins ne comptent pas. */
function diffPaths(a, b, at = '') {
  const norm = (v) => {
    if (typeof v === 'string' && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v.trim())) return Number(v);
    if (typeof v === 'string') return v.replace(/\\/g, '/').replace(/\s+/g, ' ').trim();
    return v;
  };
  const isObj = (v) => v && typeof v === 'object';
  if (isObj(a) && isObj(b) && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    let out = [];
    for (const k of keys) out = out.concat(diffPaths(a[k], b[k], at ? `${at}.${k}` : k));
    return out;
  }
  if (isObj(a) && !Array.isArray(a) && Object.keys(a).length === 0 && b == null) return [];
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b)) ? [] : [at];
}

// ------------------------------------------------------------------ FAUX outils (écrits ici, jamais dans le dépôt)
const PY_SAFETENSORS = String.raw`
import json, struct
def write_safetensors(path, step, cut=False):
    head = json.dumps({"__metadata__": {"step": str(step)}, "lora.w": {"dtype": "F32", "shape": [4], "data_offsets": [0, 16]}}).encode()
    with open(path, "wb") as f:
        f.write(struct.pack("<Q", len(head)) + head + b"\0" * (8 if cut else 16))
`;

function writeFakeLtx(root) {
  const pkg = path.join(root, 'pkg', 'ltx_trainer');
  const scripts = path.join(root, 'tools', 'src', 'LTX-2', 'packages', 'ltx-trainer', 'scripts');
  for (const d of [pkg, path.join(pkg, 'preprocessing'), path.join(pkg, 'training_strategies'), scripts]) fs.mkdirSync(d, { recursive: true });
  const w = (f, s) => fs.writeFileSync(f, s.replace(/^\n/, ''), 'utf8');
  w(path.join(pkg, '__init__.py'), '');
  w(path.join(pkg, 'preprocessing', '__init__.py'), '');
  w(path.join(pkg, 'config.py'), String.raw`
from types import SimpleNamespace
class LtxTrainerConfig:
    @classmethod
    def from_dict(cls, raw, *, mode="train"):
        if "training_strategy" not in raw:
            raise ValueError("training_strategy: field required")
        return SimpleNamespace(training_strategy=raw["training_strategy"], output_dir=raw["output_dir"], steps=raw["optimization"]["steps"],
                               ckpt=raw["checkpoints"], val=raw["validation"])
`);
  w(path.join(pkg, 'progress.py'), String.raw`
import os
class SamplingContext:
    def __init__(self, progress, task, num_prompts, num_steps):
        self._progress = progress
    def start_video(self, video_idx):
        raise RuntimeError("the adapter must replace SamplingContext.start_video")
    def advance_step(self):
        raise RuntimeError("the adapter must replace SamplingContext.advance_step")
    def cleanup(self):
        pass
class TrainingProgress:
    def __init__(self, enabled, total_steps):
        self._enabled = enabled
        self._progress = None
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass
    if os.environ.get("FAKE_LTX_SIG"):
        def update_training(self, *, loss, lr, step_time, advance=True):
            pass
    else:
        def update_training(self, *, metrics, step_time, advance=True):
            raise RuntimeError("the adapter must replace TrainingProgress.update_training")
    def start_sampling(self, num_prompts, num_steps):
        return SamplingContext(None, None, num_prompts, num_steps)
`);
  w(path.join(pkg, 'preprocessing', 'manifest.py'), String.raw`
import json
from pathlib import Path
def assert_preprocess_manifest_matches(root, expected, *, allow_stale=False, allow_missing=True):
    f = Path(root) / "preprocess_manifest.json"
    if not f.exists():
        return
    if json.loads(f.read_text())["fingerprint"] != expected:
        raise ValueError("Preprocessed data under %s does not match this config: lora_trigger" % root)
`);
  w(path.join(pkg, 'training_strategies', '__init__.py'), String.raw`
from pathlib import Path
from types import SimpleNamespace
def get_training_strategy(cfg):
    d = cfg["data"]
    fp = SimpleNamespace(artifact_root=Path(d["preprocessed_data_root"]), fields={"lora_trigger": d["lora_trigger"]})
    return SimpleNamespace(preprocessing_fingerprint=lambda: fp)
`);
  // même ordre que trainer.py 1.6.2 dans un pas : pas → essai → point → rappel → update_training
  w(path.join(pkg, 'trainer.py'), PY_SAFETENSORS + String.raw`
import os, time
from pathlib import Path
from types import SimpleNamespace
from ltx_trainer.progress import TrainingProgress

class LtxvTrainer:
    def __init__(self, trainer_config):
        self._config = trainer_config
        self._global_step = -1
        self._last_checkpoint_step = None
        self._initial_step = 0

    def train(self, disable_progress_bars=False, step_callback=None):
        c = self._config
        out = Path(c.output_dir)
        load = c.ckpt["load_checkpoint"]
        if load and not c.ckpt["no_resume"] and not os.environ.get("FAKE_LTX_REFUSE"):
            self._initial_step = json.loads((Path(load) / "metadata.json").read_text())["global_step"]
        print("fake ltx: loading the model", flush=True)
        time.sleep(float(os.environ.get("FAKE_LTX_LOAD", "0")))
        try:
            progress = TrainingProgress(enabled=not disable_progress_bars, total_steps=c.steps - self._initial_step)
            self._global_step = self._initial_step
            with progress:
                while self._global_step < c.steps:
                    t0 = time.time()
                    time.sleep(float(os.environ.get("FAKE_LTX_STEP", "0.02")))
                    self._global_step += 1
                    s = self._global_step
                    if c.val["interval"] and s % c.val["interval"] == 0:
                        self._validate(progress, out, s)
                    if s % c.ckpt["interval"] == 0:
                        self._save_checkpoint()
                    if step_callback:
                        step_callback(s, c.steps, None)
                    m = {"train/learning_rate/lora": 1e-4 * (1 - 0.9 * s / c.steps)}
                    if not os.environ.get("FAKE_LTX_NOLOSS"):
                        m["train/loss"] = round(1.0 / s, 6)
                    progress.update_training(metrics=m, step_time=time.time() - t0, advance=True)
            if self._last_checkpoint_step == self._global_step:
                saved = out / "checkpoints" / ("step_%05d" % self._global_step)
            else:
                saved = self._save_checkpoint()
            print("fake ltx: finalize", flush=True)
            return saved, SimpleNamespace(peak_gpu_memory_gb=46.37)
        finally:
            print("fake ltx: teardown", flush=True)

    def _validate(self, progress, out, s):
        prompts = self._config.training_strategy["validation"]["samples"]
        ctx = progress.start_sampling(num_prompts=len(prompts), num_steps=3)
        (out / "samples").mkdir(parents=True, exist_ok=True)
        for i in range(len(prompts)):
            ctx.start_video(i)
            for _ in range(3):
                time.sleep(float(os.environ.get("FAKE_LTX_SAMPLE", "0.01")))
                ctx.advance_step()
            (out / "samples" / ("step_%06d_%d.mp4" % (s, i + 1))).write_bytes(b"mp4")
        ctx.cleanup()

    def _save_checkpoint(self):
        s = self._global_step
        d = Path(self._config.output_dir) / "checkpoints" / ("step_%05d" % s)
        self._last_checkpoint_step = s
        if os.environ.get("FAKE_LTX_NOFILE"):
            return d
        tmp = d.parent / (".tmp_" + d.name)
        tmp.mkdir(parents=True, exist_ok=True)
        if d.exists():
            import shutil
            shutil.rmtree(d)
        write_safetensors(tmp / "weights.safetensors", s)
        (tmp / "state.pt").write_text("state")
        (tmp / "metadata.json").write_text(json.dumps({"global_step": s}))
        tmp.rename(d)
        print("fake ltx: checkpoint", s, flush=True)
        return d
`);
  w(path.join(scripts, 'preprocess.py'), String.raw`
import json, sys, time, os
from pathlib import Path
import yaml
cfg = yaml.safe_load(Path(sys.argv[1]).read_text(encoding="utf-8"))
d = cfg["training_strategy"]["data"]
rows = json.loads(Path(d["dataset_file"]).read_text(encoding="utf-8"))
root = Path(d["preprocessed_data_root"])
print("fake preprocess: %d items" % len(rows), flush=True)
for sub in ("conditions", "latents"):
    for r in rows:
        f = (root / sub / r["video"]).with_suffix(".pt")
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(b"pt")
        time.sleep(float(os.environ.get("FAKE_LTX_ENCODE", "0.01")))
(root / "preprocess_manifest.json").write_text(json.dumps({"format_version": 1, "fingerprint": {"lora_trigger": d["lora_trigger"]}}))
print("fake preprocess: done", flush=True)
`);
  return { pkg: path.join(root, 'pkg'), tools: path.join(root, 'tools') };
}

/** Faux run.py d'ai-toolkit : mêmes fichiers et mêmes écritures dans la ligne Job que DiffusionTrainer, sans rien calculer. */
function writeFakeAitk(root) {
  const src = path.join(root, 'tools', 'src', 'ai-toolkit');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'run.py'), (PY_SAFETENSORS + String.raw`
import glob, os, sqlite3, sys, time
from pathlib import Path
import yaml
cfg = yaml.safe_load(Path(sys.argv[1]).read_text(encoding="utf-8"))
name = cfg["config"]["name"]
p = cfg["config"]["process"][0]
root = Path(p["training_folder"]) / name
root.mkdir(parents=True, exist_ok=True)
Path(p["training_folder"], "argv.json").write_text(json.dumps({"argv": sys.argv, "cwd": os.getcwd(), "job": os.environ.get("AITK_JOB_ID")}))
db = p["sqlite_db_path"]
jid = os.environ.get("AITK_JOB_ID")
ui = bool(jid) and os.path.exists(db) and not os.environ.get("FAKE_AITK_NO_DB")
STEP = float(os.environ.get("FAKE_AITK_STEP", "0.03"))
print("Running 1 job", flush=True)

def q(sql, args=()):
    con = sqlite3.connect(db, timeout=30.0)
    con.isolation_level = None
    try:
        return con.execute(sql, args).fetchone()
    finally:
        con.close()
def status(st, info):
    if ui: q("UPDATE Job SET status = ?, info = ? WHERE id = ?", (st, info, jid))
def flag(key):
    r = q("SELECT %s FROM Job WHERE id = ?" % key, (jid,)) if ui else None
    return bool(r) and r[0] == 1
def setkey(key, value):
    if ui: q("UPDATE Job SET %s = ? WHERE id = ?" % key, (str(value), jid))
def maybe_stop():
    if flag("stop"):
        status("stopped", "Job stopped")
        print("Job stopped", flush=True)
        sys.exit(0)
def save(step):
    maybe_stop(); status("running", "Saving model")
    time.sleep(float(os.environ.get("FAKE_AITK_SAVE", "0.05")))
    write_safetensors(root / ("%s_%09d.safetensors" % (name, step)), step)
    maybe_stop(); status("running", "Training")
def sample(step):
    total = len(p["sample"]["prompts"])
    status("running", "Generating images - 0/%d" % total)
    (root / "samples").mkdir(exist_ok=True)
    for i in range(total):
        time.sleep(float(os.environ.get("FAKE_AITK_SAMPLE", "0.05")))
        (root / "samples" / ("%d__%09d_%d.jpg" % (int(time.time() * 1000), step, i))).write_bytes(b"jpg")
        status("running", "Generating images - %d/%d" % (i + 1, total))
    status("running", "Training")

status("running", "Starting")
maybe_stop(); status("running", "Loading model")
time.sleep(float(os.environ.get("FAKE_AITK_LOAD", "0.1")))
start = 0
files = glob.glob(str(root / (name + "*.safetensors")))
if files and not os.environ.get("FAKE_AITK_REFUSE"):
    latest = max(files, key=os.path.getctime)
    with open(latest, "rb") as f:
        (n,) = struct.unpack("<Q", f.read(8))
        start = int(json.loads(f.read(n))["__metadata__"]["step"])
    print("Found step %d in metadata, starting from there" % start, flush=True)
log = sqlite3.connect(str(root / "loss_log.db"), timeout=30.0, isolation_level=None)
log.execute("PRAGMA journal_mode=WAL;")
log.execute("CREATE TABLE IF NOT EXISTS steps (step INTEGER PRIMARY KEY, wall_time REAL NOT NULL);")
log.execute("CREATE TABLE IF NOT EXISTS metrics (step INTEGER NOT NULL, key TEXT NOT NULL, value_real REAL, value_text TEXT, PRIMARY KEY (step, key));")
log.execute("DELETE FROM metrics WHERE step > ?;", (start,)); log.execute("DELETE FROM steps WHERE step > ?;", (start,))
maybe_stop(); setkey("step", start); status("running", "Training")
steps = p["train"]["steps"]
for step in range(start, steps):
    time.sleep(STEP)
    sys.stdout.write("\r%s:  %d%% | %d/%d [lr: 1.0e-04 loss: %.3e]" % (name, 100 * step // steps, step, steps, 1.0 / (step + 1))); sys.stdout.flush()
    if step != start:
        if step % p["save"]["save_every"] == 0:
            print("\nSaving at step %d" % step, flush=True); save(step)
        if not p["train"].get("disable_sampling") and step % p["sample"]["sample_every"] == 0:
            sample(step)
    log.execute("INSERT OR REPLACE INTO steps VALUES (?, ?);", (step, time.time()))
    log.execute("INSERT OR REPLACE INTO metrics VALUES (?, 'learning_rate', ?, NULL);", (step, 1e-4))
    log.execute("INSERT OR REPLACE INTO metrics VALUES (?, 'loss/loss', ?, NULL);", (step, round(1.0 / (step + 1), 6)))
    setkey("step", step)
    maybe_stop()
    if flag("save_now"):
        setkey("save_now", 0); print("\nSaving at step %d" % step, flush=True); save(step)
print("", flush=True)
log.close()
status("running", "Saving model")
write_safetensors(root / (name + ".safetensors"), steps)
status("completed", "Training completed")
print("Result:\n - 1 completed job", flush=True)
`).replace(/^\n/, ''), 'utf8');
  return { tools: path.join(root, 'tools') };
}

// ------------------------------------------------------------------ parties sans outil : essais des fonctions des adaptateurs
const SELFTEST = String.raw`
import json, os, sqlite3, struct, sys, time
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, sys.argv[1])
import mia_train_common as C
import mia_train_aitk as A
work = Path(sys.argv[2]); work.mkdir(parents=True, exist_ok=True)
out = {}

def st(path, step, cut=False):
    head = json.dumps({"__metadata__": {"step": str(step)}, "w": {"dtype": "F32", "shape": [4], "data_offsets": [0, 16]}}).encode()
    Path(path).write_bytes(struct.pack("<Q", len(head)) + head + b"\0" * (8 if cut else 16))

if len(sys.argv) > 3 and sys.argv[3] == "force":
    d = work / "force"; (d / "control").mkdir(parents=True, exist_ok=True)
    s = C.Session(SimpleNamespace(dir=str(d), run=1, token="t", resume=0, dry=False))
    s.timing.update(aliveStaleMs=10, aliveForceMs=50, aliveCheckMs=10, jumpMs=10**9)
    w = C.Watch(s, on_force=lambda: (d / "forced").write_text("1"))
    t0 = C.now_ms()
    w.check_alive(t0); w.check_alive(t0 + 100)
    sys.exit(0)

# -- mot déclencheur
T = "rsa woman"
out["strip"] = [C.strip_trigger(c, T) for c in [
    "rsa woman, seated by a window", "RSA Woman seated", "rsa woman", "  rsa  woman.  ", "a portrait of rsa woman", "rsa womanly figure", "", "rsa woman: smiling"]]

# -- safetensors
st(work / "ok.safetensors", 5); st(work / "cut.safetensors", 5, cut=True); (work / "junk.safetensors").write_text("x")
out["complete"] = [C.safetensors_complete(work / n) for n in ("ok.safetensors", "cut.safetensors", "junk.safetensors", "absent.safetensors")]

# -- phases d'ai-toolkit
out["phases"] = [list(A.phase_of(i, seen)) for i, seen in [("Starting", False), ("Loading model", False), ("Loading dataset", False), ("Training", False),
    ("Generating images - 1/2", True), ("Saving model", True), ("Quelque chose d'inconnu", True), ("", False)]]

# -- ligne Job : création, pause simulée, remise à neuf
db = work / "control" / "aitk.db"
A.reset_job(db, "t_1", "rosa", 2000, 0, "{}")
out["job_new"] = A.read_job(db, "t_1")
con = sqlite3.connect(str(db)); out["wal"] = con.execute("PRAGMA journal_mode").fetchone()[0]
out["columns"] = [r[1] for r in con.execute("PRAGMA table_info(Job)")]
con.execute("UPDATE Job SET stop = 1, save_now = '1', status = 'stopped', info = 'Job stopped', step = '750', return_to_queue = 1, sample_now = 1 WHERE id = 't_1'"); con.commit(); con.close()
out["job_paused"] = A.read_job(db, "t_1")
A.reset_job(db, "t_1", "rosa", 2000, 750, "{}")
out["job_reset"] = A.read_job(db, "t_1")
out["set_job"] = [A.set_job(db, "t_1", "save_now", 1), A.read_job(db, "t_1")["save_now"], A.set_job(db, "t_1", "stop", 1), A.read_job(db, "t_1")["stop"]]
A.reset_job(db, "t_2", "rosa", 2000, 0, "{}")          # un autre entraînement du même nom : la ligne précédente part
con = sqlite3.connect(str(db)); out["rows"] = [r[0] for r in con.execute("SELECT id FROM Job")]; con.close()
out["job_absent"] = A.read_job(work / "nulle-part.db", "t_1")

# -- loss_log.db factice (tables de toolkit\logging_aitk.py)
log = work / "loss_log.db"
con = sqlite3.connect(str(log)); con.execute("PRAGMA journal_mode=WAL")
con.execute("CREATE TABLE steps (step INTEGER PRIMARY KEY, wall_time REAL NOT NULL)")
con.execute("CREATE TABLE metrics (step INTEGER NOT NULL, key TEXT NOT NULL, value_real REAL, value_text TEXT, PRIMARY KEY (step, key))")
for k in range(5):
    con.execute("INSERT INTO steps VALUES (?, ?)", (k, 1000.0 + 2.5 * k))
    con.execute("INSERT INTO metrics VALUES (?, 'learning_rate', 1e-4, NULL)", (k,))
    con.execute("INSERT INTO metrics VALUES (?, ?, ?, NULL)", (k, "loss/loss" if k < 4 else "loss/mse", 0.5 - 0.1 * k))
con.commit()
out["losses_all"] = A.read_losses(log, -1)
out["losses_after"] = A.read_losses(log, 2)
con.close()
out["losses_absent"] = A.read_losses(work / "absent.db", -1)

# -- dossier de reprise
root = work / "out" / "rosa"; root.mkdir(parents=True)
for step in (250, 500, 750, 1000):
    st(root / ("rosa_%09d.safetensors" % step), step, cut=(step == 750)); time.sleep(0.03)
(root / "rosa_autre.txt").write_text("x")
out["ckpts"] = [(c["step"], c["final"]) for c in A.checkpoint_files(root, "rosa", 2000)]
out["prep_dry"] = A.prepare_resume(root, "rosa", 2000, 750, run=3, dry=True)
out["prep_dry_left"] = sorted(p.name for p in root.iterdir())
out["prep_750"] = A.prepare_resume(root, "rosa", 2000, 750, run=3)           # 750 est tronqué, 1000 est postérieur
out["prep_500"] = A.prepare_resume(root, "rosa", 2000, 500, run=3)
out["left"] = sorted(p.name for p in root.iterdir())
out["aside"] = sorted(p.name for p in (root.parent / "ecartes").iterdir())
st(root / "rosa.safetensors", 2000)
out["prep_first"] = A.prepare_resume(root, "rosa", 2000, 0, run=4)
out["left_first"] = sorted(p.name for p in root.iterdir())

# -- essais
(root / "samples").mkdir()
for n in ("1731900000000__000000250_0.jpg", "1731900000001__000000250_1.jpg", "1731900009999__000000500_0.mp4", "notes.txt"):
    (root / "samples" / n).write_text("x")
out["samples"] = [(x["step"], x["i"], x["path"].name) for x in A.sample_files(root)]

# -- sortie de l'outil : dernier état d'une barre
out["bar"] = A.Pump.last_state(b"rosa: 1%\rrosa: 2%\rrosa: 3% | 30/2000\r").decode()

# -- fil de veille
def session(name, **timing):
    d = work / name; (d / "control").mkdir(parents=True, exist_ok=True)
    s = C.Session(SimpleNamespace(dir=str(d), run=1, token="jeton", resume=0, dry=False))
    s.timing.update(aliveStaleMs=1000, aliveRecheckMs=500, aliveCheckMs=100, jumpMs=5000, aliveForceMs=10**9); s.timing.update(timing)
    return s, d
def old_alive(d, age):
    f = d / "control" / "alive"; f.write_text("x"); t = time.time() - age; os.utime(f, (t, t))
s, d = session("veille1"); old_alive(d, 10); w = C.Watch(s); t0 = C.now_ms()
r = []
w.check_alive(t0); r.append(w.pause_wanted)
w.check_alive(t0 + 200); r.append(w.pause_wanted)            # deux lectures trop rapprochées
w.check_alive(t0 + 700); r.append(w.pause_wanted)            # même fichier inchangé 500 ms plus tard
out["alive_two_readings"] = r
s, d = session("veille2"); old_alive(d, 10); w = C.Watch(s); t0 = C.now_ms()
w.check_alive(t0); old_alive(d, 3); w.check_alive(t0 + 700)  # le fichier a changé entre les deux lectures
out["alive_changed"] = w.pause_wanted
s, d = session("veille3"); old_alive(d, 10); w = C.Watch(s); t0 = C.now_ms()
w.check_alive(t0); w.check_alive(t0 + 100000); a = w.pause_wanted   # saut d'horloge : on repart de zéro
w.check_alive(t0 + 100200); b = w.pause_wanted
w.check_alive(t0 + 100800); c = w.pause_wanted
out["alive_jump"] = [a, b, c]
s, d = session("veille4"); old_alive(d, 0); w = C.Watch(s); t0 = C.now_ms()
w.check_alive(t0); w.check_alive(t0 + 700)
out["alive_fresh"] = w.pause_wanted
w.heartbeat(); out["adapter"] = json.loads((d / "control" / "adapter.json").read_text())
out["pid"] = os.getpid()
r = [w.asked()]
(d / "control" / "pause").write_text(""); r.append(w.asked())
(d / "control" / "stop").write_text(""); r.append(w.asked())
out["asked"] = r
s, d = session("veille5", heartbeatMs=60, aliveCheckMs=50, aliveStaleMs=150, aliveRecheckMs=120); old_alive(d, 10)
w = C.Watch(s); w.start(); time.sleep(0.7); w.halt()          # le fil, pour de vrai
out["thread"] = [w.pause_wanted, w.asked(), (d / "control" / "adapter.json").is_file()]
print("MIA_SELFTEST " + json.dumps(out))
`;

// ==================================================================================================
(async () => {
  const hasLtx = fs.existsSync(TC.venvPython(TOOLS, 'venv-ltx'));
  const hasAitk = fs.existsSync(TC.venvPython(TOOLS, 'venv-aitk'));
  const pyLtx = hasLtx ? commandOf(LTX, WORK) : null;
  const pyAitk = hasAitk ? commandOf(AITK, WORK) : null;
  const py = pyAitk || pyLtx;                       // un Python avec PyYAML : celui d'un des deux venv
  const python = py ? { exe: py.exe, env: { ...py.env } } : null;

  // ---------------------------------------------------------------- descripteurs ↔ adaptateurs
  section('Descripteurs du lot 1 et adaptateurs');
  for (const f of ['mia_train_common.py', 'mia_train_ltx.py', 'mia_train_aitk.py']) check(`${f} présent`, fs.existsSync(path.join(ADAPTERS, f)));
  {
    const c = LTX.command({ dir: 'X:\\t', run: 3, token: 'abc', resumeFrom: 1250, toolsDir: TOOLS, root: MIA, engineRoot: ENGINE });
    const i = c.args.indexOf(path.join(ADAPTERS, 'mia_train_ltx.py'));
    check('LTX : -B -u <adaptateur> --dir --run --token --resume, dans cet ordre', i === 2 && c.args.slice(i + 1).join(' ') === '--dir X:\\t --run 3 --token abc --resume 1250', c.args);
    check('LTX : MIA_TRAIN_PYTHON, MIA_TRAIN_TOOLS et MIA_ENGINE_MODELS donnés à l’adaptateur',
      c.env.MIA_TRAIN_PYTHON === c.exe && c.env.MIA_TRAIN_TOOLS === TOOLS && c.env.MIA_ENGINE_MODELS === path.join(ENGINE, 'models'), c.env);
    const a = AITK.command({ dir: 'X:\\t', run: 1, token: 'k', resumeFrom: 0, toolsDir: TOOLS, root: MIA, engineRoot: ENGINE });
    check('ai-toolkit : même forme, sans --resume au premier lancement ; MODELS_PATH et HF_HOME donnés',
      a.args.slice(2).join(' ') === `${path.join(ADAPTERS, 'mia_train_aitk.py')} --dir X:\\t --run 1 --token k` && a.env.MODELS_PATH === path.join(ENGINE, 'models') && !!a.env.HF_HOME && a.env.MIA_TRAIN_TOOLS === TOOLS, a);
    check('les deux : hors ligne, sans wandb, sortie non tamponnée', [c, a].every((x) => x.env.HF_HUB_OFFLINE === '1' && x.env.TRANSFORMERS_OFFLINE === '1' && x.env.WANDB_MODE === 'disabled' && x.env.PYTHONUNBUFFERED === '1' && x.env.PYTHONUTF8 === '1'));
  }
  if (hasLtx) {
    const d = LTX.detect({ toolsDir: TOOLS, root: MIA, toolVersion: CATALOG.bases.find((b) => b.id === 'ltx25').toolVersion });
    check('LTX : outil détecté prêt maintenant que l’adaptateur existe (version du catalogue)', d.ok === true && d.version === '1.6.2', d);
  } else skip('détection LTX : venv-ltx absent de cette machine');
  if (hasAitk) check('ai-toolkit : outil détecté prêt', AITK.detect({ toolsDir: TOOLS, root: MIA }).ok === true);
  else skip('détection ai-toolkit : venv-aitk absent de cette machine');

  if (!python) {
    skip(`tout le reste : aucun outil d’entraînement sous ${TOOLS}`);
    console.log(`\n${passes} contrôles réussis, ${failures} en échec, ${skipped} sautés.`);
    process.exit(failures ? 1 : 0);
  }

  // ---------------------------------------------------------------- fonctions des adaptateurs (bibliothèque standard seule)
  section('Fonctions des adaptateurs : déclencheur, safetensors, ligne Job, loss_log.db, reprise, veille');
  {
    const script = path.join(WORK, 'selftest.py');
    fs.writeFileSync(script, SELFTEST.replace(/^\n/, ''), 'utf8');
    const r = spawnSync(python.exe, ['-B', script, ADAPTERS, path.join(WORK, 'selftest')], { env: { ...process.env, ...python.env, PYTHONUTF8: '1' }, encoding: 'utf8', windowsHide: true });
    const line = String(r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('MIA_SELFTEST '));
    const o = line ? JSON.parse(line.slice(13)) : null;
    check('le script d’essai des fonctions tourne', !!o, `${r.stdout}\n${r.stderr}`.slice(-1500));
    if (o) {
      check('mot déclencheur retiré en tête de légende, quelle que soit la casse ; légende réduite au mot → vide',
        JSON.stringify(o.strip) === JSON.stringify(['seated by a window', 'seated', '', '', 'a portrait of rsa woman', 'rsa womanly figure', '', 'smiling']), o.strip);
      check('safetensors : complet oui ; tronqué, illisible, absent non (même règle que electron\\train\\common.js)', JSON.stringify(o.complete) === '[true,false,false,false]', o.complete);
      check('règle identique côté Node sur les mêmes fichiers', TC.safetensorsComplete(path.join(WORK, 'selftest', 'ok.safetensors')) && !TC.safetensorsComplete(path.join(WORK, 'selftest', 'cut.safetensors')));
      check('phases ai-toolkit : load avant « Training », puis train / sample n/of / save ; info inconnu = train',
        JSON.stringify(o.phases) === JSON.stringify([['load', null, null], ['load', null, null], ['load', null, null], ['train', null, null], ['sample', 1, 2], ['save', null, null], ['train', null, null], ['load', null, null]]), o.phases);
      check('ligne Job créée : running, info vide, stop 0, save_now 0, pas 0 ; base en mode WAL',
        o.job_new.status === 'running' && o.job_new.info === '' && o.job_new.stop === 0 && o.job_new.save_now === 0 && o.job_new.step === 0 && String(o.wal).toLowerCase() === 'wal', o.job_new);
      const cols = ['id', 'name', 'gpu_ids', 'job_config', 'created_at', 'updated_at', 'status', 'stop', 'return_to_queue', 'step', 'total_steps', 'info', 'speed_string', 'queue_position', 'pid', 'job_type', 'job_ref', 'save_now', 'sample_now'];
      check('ligne Job : les 19 colonnes de schema.prisma', JSON.stringify(o.columns) === JSON.stringify(cols), o.columns);
      check('après une pause simulée (stop 1, save_now 1, « Job stopped », pas 750) la ligne est lue telle quelle', o.job_paused.stop === 1 && o.job_paused.save_now === 1 && o.job_paused.status === 'stopped' && o.job_paused.step === 750, o.job_paused);
      check('reprise : ligne remise à neuf (stop 0, return_to_queue 0, save_now 0, sample_now 0, running, info vide, pas = reprise)',
        o.job_reset.stop === 0 && o.job_reset.return_to_queue === 0 && o.job_reset.save_now === 0 && o.job_reset.sample_now === 0 && o.job_reset.status === 'running' && o.job_reset.info === '' && o.job_reset.step === 750, o.job_reset);
      check('ordres save_now et stop écrits par requêtes courtes', JSON.stringify(o.set_job) === '[true,1,true,1]', o.set_job);
      check('une seule ligne Job par base ; base absente → rien, sans erreur', JSON.stringify(o.rows) === '["t_2"]' && o.job_absent === null, o.rows);
      check('loss_log.db : perte et lr par pas, en ordre ; clé « loss/… » quelconque acceptée',
        o.losses_all.length === 5 && o.losses_all[0].step === 0 && Math.abs(o.losses_all[0].loss - 0.5) < 1e-9 && o.losses_all[0].lr === 1e-4 && o.losses_all[0].t === 1000000 && Math.abs(o.losses_all[4].loss - 0.1) < 1e-9, o.losses_all);
      check('loss_log.db : seulement la suite (step > dernier lu) ; fichier absent → rien', o.losses_after.map((x) => x.step).join() === '3,4' && o.losses_absent.length === 0, o.losses_after);
      check('points ai-toolkit lus par leur nom (9 chiffres)', JSON.stringify(o.ckpts) === '[[250,false],[500,false],[750,false],[1000,false]]', o.ckpts);
      check('reprise à blanc : dit ce qui serait écarté sans rien déplacer', o.prep_dry.aside.join() === 'rosa_000000750.safetensors,rosa_000001000.safetensors' && o.prep_dry_left.length === 5, o.prep_dry);
      check('reprise au pas 750 : le point tronqué et le point postérieur vont dans ecartes ; le plus récent restant est 500 (≠ 750 → reprise refusée)',
        o.prep_750.aside.length === 2 && o.prep_750.latest === 500, o.prep_750);
      check('reprise au pas 500 : rien à écarter, l’outil prendra bien 500', o.prep_500.aside.length === 0 && o.prep_500.latest === 500, o.prep_500);
      check('rien n’est supprimé : les fichiers écartés sont dans out\\ecartes, préfixés du lancement',
        o.left.join() === 'rosa_000000250.safetensors,rosa_000000500.safetensors,rosa_autre.txt' && o.aside.join() === 'run3_rosa_000000750.safetensors,run3_rosa_000001000.safetensors', { left: o.left, aside: o.aside });
      check('premier lancement : aucun ancien fichier ne reste où l’outil reprendrait en silence', o.prep_first.aside.length === 3 && o.prep_first.latest === 0 && o.left_first.join() === 'rosa_autre.txt', { p: o.prep_first, left: o.left_first });
      check('essais ai-toolkit : pas et rang lus dans le nom', JSON.stringify(o.samples) === JSON.stringify([[250, 1, '1731900000000__000000250_0.jpg'], [250, 2, '1731900000001__000000250_1.jpg'], [500, 1, '1731900009999__000000500_0.mp4']]), o.samples);
      check('barre tqdm : seul le dernier état est gardé', o.bar === 'rosa: 3% | 30/2000', o.bar);
      check('veille : un « alive » trop vieux n’a d’effet qu’après deux lectures espacées du même fichier', JSON.stringify(o.alive_two_readings) === '[false,false,true]', o.alive_two_readings);
      check('veille : fichier réécrit entre les deux lectures → pas de pause', o.alive_changed === false);
      check('veille : saut d’horloge (sortie de veille) → les compteurs repartent de zéro', JSON.stringify(o.alive_jump) === '[false,false,true]', o.alive_jump);
      check('veille : « alive » frais → rien', o.alive_fresh === false);
      check('adapter.json {pid, token, t}', o.adapter.pid === o.pid && o.adapter.token === 'jeton' && Math.abs(o.adapter.t - Date.now()) < 120000, o.adapter);
      check('ordres lus : rien, pause, stop (stop l’emporte)', JSON.stringify(o.asked) === '[null,"pause","stop"]', o.asked);
      check('le fil de veille tourne à part : adapter.json écrit, Mia disparue vue sans aucun pas', JSON.stringify(o.thread) === '[true,"alive",true]', o.thread);
    }
    const f = spawnSync(python.exe, ['-B', script, ADAPTERS, path.join(WORK, 'selftest'), 'force'], { env: { ...process.env, ...python.env, PYTHONUTF8: '1' }, encoding: 'utf8', windowsHide: true });
    check('veille : sans « alive » au-delà du délai, sortie forcée (code 3) après avoir tué ce que l’adaptateur a lancé', f.status === 3 && fs.existsSync(path.join(WORK, 'selftest', 'force', 'forced')), `${f.status} ${f.stdout} ${f.stderr}`.slice(-600));
  }

  // ---------------------------------------------------------------- LTX --dry sur le vrai outil (schéma, garde, comparaison)
  section('LTX --dry : configuration validée par LtxTrainerConfig, comparée à rosa_ltx25_essai20.yaml');
  const ltxImages = [
    { original: 'rosa_fenetre.png', caption: 'rsa woman, seated by a window, soft light' },
    { original: 'rosa_face.png', caption: 'RSA Woman' },
    { original: 'rosa_rue.png', caption: 'a young woman walking in a street at night' }
  ];
  if (!hasLtx) skip('venv-ltx absent de cette machine');
  else {
    const ref = fs.existsSync(REF_LTX) ? yamlToJson(python, REF_LTX) : null;
    const prompt = ref ? ref.training_strategy.validation.samples[0].prompt : 'rsa woman, close-up of her face';
    const dir = makeTraining('rosa', { base: 'ltx25', trigger: 'rsa woman', steps: 20, images: ltxImages, settings: { saveEvery: 10, sampleEvery: 20, samplePrompts: [prompt] } });
    const r = dry(LTX, dir);
    const R = r.report;
    check('--dry réussit (code 0, rapport lu)', r.code === 0 && R && R.ok === true, r.out.slice(-2000));
    if (R && R.ok) {
      check('garde de version : ltx-trainer 1.6.2 exactement', R.version === '1.6.2' && R.tool === 'ltx-trainer 1.6.2', R.tool);
      check('garde de signatures exécutée (train, update_training, start_sampling, _save_checkpoint…)',
        ['LtxvTrainer.train', 'LtxvTrainer._save_checkpoint', 'TrainingProgress.update_training', 'TrainingProgress.start_sampling'].every((k) => R.signatures.includes(k)), R.signatures);
      check('--dry n’écrit ni events.jsonl ni metrics.jsonl, et n’encode rien', !fs.existsSync(path.join(dir, 'events.jsonl')) && !fs.existsSync(path.join(dir, 'metrics.jsonl')) && fs.readdirSync(path.join(dir, 'cache')).length === 0);
      const rows = JSON.parse(fs.readFileSync(path.join(dir, 'ltx.json'), 'utf8'));
      check('ltx.json : colonnes « video » et « caption », chemins relatifs au dossier', rows.length === 3 && rows[0].video === 'dataset/0001.png' && Object.keys(rows[0]).join() === 'video,caption', rows[0]);
      check('mot déclencheur retiré des légendes ; légende réduite au mot → vide ; les autres intactes',
        rows[0].caption === 'seated by a window, soft light' && rows[1].caption === '' && rows[2].caption === 'a young woman walking in a street at night' && R.captions.stripped === 2 && R.captions.empty === 1, rows);
      check('les légendes d’origine du jeu ne sont pas touchées', fs.readFileSync(path.join(dir, 'dataset', '0001.txt'), 'utf8') === ltxImages[0].caption);
      const cfg = yamlToJson(python, path.join(dir, 'config.yaml'));
      check('plusieurs tailles d’image → lot 1', cfg.optimization.batch_size === 1 && cfg.training_strategy.data.resolution_buckets.length === 3);
      check('chemins dans le dossier de l’entraînement : ltx.json, cache\\, out\\',
        cfg.training_strategy.data.dataset_file === `${dir.replace(/\\/g, '/')}/ltx.json` && cfg.training_strategy.data.preprocessed_data_root === `${dir.replace(/\\/g, '/')}/cache` && cfg.output_dir === `${dir.replace(/\\/g, '/')}/out`, cfg.training_strategy.data);
      check('premier lancement : load_checkpoint null, no_resume true ; état de reprise « minimal », tous les points gardés',
        cfg.checkpoints.load_checkpoint === null && cfg.checkpoints.no_resume === true && cfg.checkpoints.save_training_state === 'minimal' && cfg.checkpoints.keep_last_n === -1, cfg.checkpoints);
      if (ref) {
        const d = diffPaths(ref, cfg).sort();
        const allowed = ['checkpoints.save_training_state', 'output_dir', 'training_strategy.data.dataset_file', 'training_strategy.data.preprocessed_data_root', 'wandb.tags.0', 'wandb.tags.1'];
        check('équivalente à rosa_ltx25_essai20.yaml : seuls diffèrent les dossiers, les étiquettes wandb et l’état de reprise explicite',
          d.every((p) => allowed.includes(p)) && ['output_dir', 'training_strategy.data.dataset_file'].every((p) => d.includes(p)), d);
        console.log(`        différences : ${d.join(', ')}`);
      } else skip(`comparaison : ${REF_LTX} absent`);
      check('poids de base : présents sur cette machine, ou listés', Array.isArray(R.weightsMissing), R.weightsMissing);

      // clé du cache
      check('cache : absent au premier lancement', R.cache.state === 'absent');
      fs.mkdirSync(path.join(dir, 'cache', 'latents', 'dataset'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'cache', 'conditions', 'dataset'), { recursive: true });
      for (const k of [1, 2, 3]) for (const sub of ['latents', 'conditions']) fs.writeFileSync(path.join(dir, 'cache', sub, 'dataset', `000${k}.pt`), 'pt');
      fs.writeFileSync(path.join(dir, 'cache', 'preprocess_manifest.json'), '{}');
      fs.writeFileSync(path.join(dir, 'cache', 'cle.json'), JSON.stringify(R.cacheKey));
      check('clé du cache : images (nom, taille, date, SHA-1 de la légende), déclencheur, tailles, Gemma et VAE',
        R.cacheKey.images.length === 3 && R.cacheKey.images[0].name === '0001.png' && R.cacheKey.images[0].bytes > 0 && R.cacheKey.images[0].mtime > 0 && /^[0-9a-f]{40}$/.test(R.cacheKey.images[0].caption)
        && R.cacheKey.trigger === 'rsa woman' && R.cacheKey.buckets.length === 3 && R.cacheKey.weights.length === 2 && /gemma/i.test(R.cacheKey.weights[0].name) && /vae/i.test(R.cacheKey.weights[1].name), R.cacheKey);
      const same = dry(LTX, dir, { run: 2 }).report;
      check('rien de changé → encodage sauté (cache reconnu)', same && same.cache.state === 'match', same && same.cache);
      fs.writeFileSync(path.join(dir, 'dataset', '0003.txt'), 'a young woman walking in a street at dawn', 'utf8');
      const changed = dry(LTX, dir, { run: 3 }).report;
      check('légende modifiée → cache périmé, l’image est nommée', changed && changed.cache.state === 'stale' && changed.cache.diff.join() === '0003.png', changed && changed.cache);
      check('--dry ne vide jamais le cache', fs.existsSync(path.join(dir, 'cache', 'cle.json')) && fs.existsSync(path.join(dir, 'cache', 'latents', 'dataset', '0001.pt')));
      fs.writeFileSync(path.join(dir, 'dataset', '0003.txt'), ltxImages[2].caption, 'utf8');
      setDoc(dir, { trigger: 'rsa girl' });
      const trig = dry(LTX, dir, { run: 4 }).report;
      check('mot déclencheur changé → cache périmé', trig && trig.cache.state === 'stale' && trig.cache.diff.includes('trigger'), trig && trig.cache);
      setDoc(dir, { trigger: 'rsa woman' });
      fs.rmSync(path.join(dir, 'cache', 'latents', 'dataset', '0002.pt'));
      const partial = dry(LTX, dir, { run: 5 }).report;
      check('encodage incomplet (un fichier manque) → cache périmé', partial && partial.cache.state === 'stale' && partial.cache.diff.join() === 'incomplet', partial && partial.cache);

      // reprise
      const res = dry(LTX, dir, { run: 6, resume: 10 });
      const rcfg = res.report && res.report.ok ? yamlToJson(python, path.join(dir, 'config.yaml')) : null;
      check('reprise : load_checkpoint = dossier du point, no_resume false ; validée par le schéma',
        rcfg && rcfg.checkpoints.load_checkpoint === `${dir.replace(/\\/g, '/')}/out/checkpoints/step_00010` && rcfg.checkpoints.no_resume === false, res.out.slice(-800));
      const over = dry(LTX, dir, { run: 7, resume: 20 });
      check('reprise au dernier pas : refusée (aucun pas restant)', over.code === 1 && over.report && over.report.error.code === 'resume', over.report);

      // essai « aucun » et réglages avancés
      setDoc(dir, { settings: { sampleEvery: 0, rank: 64, resolutions: [[1024, 1024]], batch: 2 } });
      const adv = dry(LTX, dir, { run: 8 });
      const acfg = adv.report && adv.report.ok ? yamlToJson(python, path.join(dir, 'config.yaml')) : null;
      check('aucun essai → validation.interval null ; rang 64 = alpha ; une seule taille → le lot choisi',
        acfg && acfg.validation.interval === null && acfg.training_strategy.lora.rank === 64 && acfg.training_strategy.lora.alpha === 64 && acfg.optimization.batch_size === 2, acfg && acfg.optimization);

      // version non validée
      const cat = path.join(WORK, 'catalogue-autre-version.json');
      fs.writeFileSync(cat, JSON.stringify({ ...CATALOG, bases: CATALOG.bases.map((b) => (b.id === 'ltx25' ? { ...b, toolVersion: '1.7.0' } : b)) }));
      const ver = dry(LTX, dir, { run: 9 }, { MIA_TRAIN_CATALOG: cat });
      check('version installée ≠ version attendue → refus net (code tool, raison « version »), rien n’est chargé',
        ver.code === 1 && ver.report && ver.report.ok === false && ver.report.error.code === 'tool' && ver.report.error.why === 'version' && /1\.6\.2/.test(ver.report.error.message) && /1\.7\.0/.test(ver.report.error.message), ver.report);
      const bad = dry(LTX, path.join(WORK, 'nulle-part'));
      check('dossier sans train.json → erreur claire, pas de trace Python', bad.code === 1 && bad.report && bad.report.error.why === 'config' && !/Traceback/.test(bad.out), bad.out.slice(-400));
    }
  }

  // ---------------------------------------------------------------- LTX : déroulé complet sur un FAUX ltx_trainer
  section('LTX : lecture de l’avancement, pause, reprise, veille — sur un faux paquet ltx_trainer (aucun GPU)');
  if (!hasLtx) skip('venv-ltx absent de cette machine');
  else {
    const fake = writeFakeLtx(path.join(WORK, 'faux-ltx'));
    const FENV = { PYTHONPATH: fake.pkg, MIA_TRAIN_TOOLS: fake.tools, MIA_ENGINE_MODELS: path.join(WORK, 'modeles') };
    for (const w of CATALOG.bases.find((b) => b.id === 'ltx25').weights) {
      fs.mkdirSync(path.join(WORK, 'modeles', w.dir), { recursive: true });
      fs.writeFileSync(path.join(WORK, 'modeles', w.dir, w.file), 'poids');
    }
    const mk = (name, settings = {}, steps = 12) => makeTraining(name, { base: 'ltx25', trigger: 'rsa woman', steps, images: ltxImages, settings: { saveEvery: 5, sampleEvery: 6, samplePrompts: ['rsa woman, close-up', 'rsa woman, wide shot'], ...settings } });

    // nominal
    {
      const dir = mk('ltx-nominal');
      const code = await launch(LTX, dir, { run: 1 }, FENV).done;
      const ev = events(dir);
      const mt = metrics(dir);
      const kinds = ev.map((e) => (e.e === 'phase' ? `phase:${e.phase}` : e.e));
      check('sortie 0, « done » au dernier pas avec le pic mémoire', code === 0 && ev[ev.length - 1].e === 'done' && ev[ev.length - 1].step === 12 && ev[ev.length - 1].peakVramGB === 46.4, { code, last: ev[ev.length - 1], log: logOf(dir).slice(-800) });
      check('« caps » d’abord, avec l’outil, saveNow et le numéro de lancement', ev[0].e === 'caps' && ev[0].tool === 'ltx-trainer 1.6.2' && ev[0].saveNow === true && ev[0].run === 1, ev[0]);
      check('phases dans l’ordre : check → encode → load → train', kinds.indexOf('phase:check') < kinds.indexOf('phase:encode') && kinds.lastIndexOf('phase:encode') < kinds.indexOf('phase:load') && kinds.indexOf('phase:load') < kinds.indexOf('phase:train'), kinds.join(' '));
      const enc = ev.filter((e) => e.e === 'phase' && e.phase === 'encode');
      check('encodage : avancement n / 3 lu dans cache\\ (2 fichiers par image), terminé à 3 / 3', enc.length >= 2 && enc.every((e) => e.of === 3) && enc[enc.length - 1].n === 3, enc);
      check('la sortie du script d’encodage arrive dans log.txt (aucun tuyau, aucune console)', /fake preprocess: 3 items/.test(logOf(dir)) && /fake preprocess: done/.test(logOf(dir)));
      check('cache\\cle.json écrit après l’encodage', fs.existsSync(path.join(dir, 'cache', 'cle.json')));
      check('une ligne de metrics.jsonl par pas : run, s, perte, lr, dt, t', mt.length === 12 && mt.map((m) => m.s).join() === '1,2,3,4,5,6,7,8,9,10,11,12' && mt.every((m) => m.run === 1 && m.loss > 0 && m.lr > 0 && m.dt >= 0 && m.t > 0) && mt[3].loss === 0.25, mt.slice(0, 2));
      const cks = ev.filter((e) => e.e === 'checkpoint');
      check('points annoncés : 5, 10 (cadence) et 12 (point final hors cadence), fichiers présents',
        cks.map((c) => c.step).join() === '5,10,12' && cks.every((c) => c.file === `out/checkpoints/step_${String(c.step).padStart(5, '0')}/weights.safetensors` && c.sizeMB >= 0 && TC.safetensorsComplete(path.join(dir, c.file))), cks);
      check('les points suivent la disposition lue par le descripteur (electron\\train\\common.js)', LTX.checkpoints(dir).map((c) => c.step).join() === '5,10,12' && LTX.checkpoints(dir).every((c) => LTX.verify(dir, c)));
      const sm = ev.filter((e) => e.e === 'sample');
      check('essais : 2 consignes aux pas 6 et 12, fichiers step_{pas sur 6}_{i}.mp4, durée mesurée',
        sm.map((s) => `${s.step}:${s.i}`).join() === '6:1,6:2,12:1,12:2' && sm.every((s) => s.kind === 'video' && s.sec >= 0 && fs.existsSync(path.join(dir, s.file))) && sm[0].file === 'out/samples/step_000006_1.mp4', sm);
      const ss = ev.filter((e) => e.e === 'sample_step');
      check('étapes du rendu : i / 2, n de 0 à 3 sur 3', ss.length === 16 && ss[0].i === 1 && ss[0].of === 2 && ss[0].n === 0 && ss[3].n === 3 && ss[3].total === 3 && ss[4].i === 2, ss.slice(0, 5));
      const i6 = ev.findIndex((e) => e.e === 'sample' && e.step === 6 && e.i === 2);
      check('pendant un essai : phase sample, puis retour à train', ev.slice(0, i6).some((e) => e.e === 'phase' && e.phase === 'sample') && ev[i6 + 1].e === 'phase' && ev[i6 + 1].phase === 'train', ev.slice(i6 - 1, i6 + 2));
      check('le trainer se referme proprement, et finalise', /fake ltx: finalize/.test(logOf(dir)) && /fake ltx: teardown/.test(logOf(dir)));
      check('adapter.json tenu par le fil de veille (pid, jeton)', JSON.parse(fs.readFileSync(path.join(dir, 'control', 'adapter.json'), 'utf8')).token === 'jeton');
      check('train.json n’est jamais écrit par l’adaptateur', JSON.parse(fs.readFileSync(path.join(dir, 'train.json'), 'utf8')).run === 0);

      // deuxième lancement sans rien changer : pas d'encodage
      fs.rmSync(path.join(dir, 'out'), { recursive: true, force: true });
      const n0 = events(dir).length;
      const code2 = await launch(LTX, dir, { run: 2 }, FENV).done;
      const ev2 = events(dir).slice(n0);
      check('cas 22 — rien de changé : encodage sauté au lancement suivant', code2 === 0 && !ev2.some((e) => e.e === 'phase' && e.phase === 'encode') && (logOf(dir).match(/fake preprocess: 3 items/g) || []).length === 1 && ev2[ev2.length - 1].e === 'done', ev2.map((e) => e.e + (e.phase || '')).join(' '));
      // légende modifiée : encodage refait
      fs.writeFileSync(path.join(dir, 'dataset', '0003.txt'), 'a young woman at dawn', 'utf8');
      fs.rmSync(path.join(dir, 'out'), { recursive: true, force: true });
      const n1 = events(dir).length;
      await launch(LTX, dir, { run: 3 }, FENV).done;
      check('cas 22 — légende modifiée entre deux lancements : réencodage', events(dir).slice(n1).some((e) => e.e === 'phase' && e.phase === 'encode') && (logOf(dir).match(/fake preprocess: 3 items/g) || []).length === 2);
      // cache refusé par l'outil malgré une clé identique : vidé, réencodé une fois
      fs.writeFileSync(path.join(dir, 'cache', 'preprocess_manifest.json'), JSON.stringify({ format_version: 1, fingerprint: { lora_trigger: 'autre' } }));
      fs.rmSync(path.join(dir, 'out'), { recursive: true, force: true });
      const n2 = events(dir).length;
      const code4 = await launch(LTX, dir, { run: 4 }, FENV).done;
      check('cache refusé par l’outil (manifeste différent) : vidé, réencodé une fois, puis entraînement', code4 === 0 && /cache refusé par l’outil/.test(logOf(dir)) && events(dir).slice(n2).some((e) => e.e === 'done') && (logOf(dir).match(/fake preprocess: 3 items/g) || []).length === 3, logOf(dir).slice(-600));
    }

    // pause, puis reprise
    {
      const dir = mk('ltx-pause', { sampleEvery: 0 }, 60);
      const run = launch(LTX, dir, { run: 1 }, { ...FENV, FAKE_LTX_STEP: '0.08' });
      await waitFor(() => metrics(dir).length >= 3, 60000);
      fs.writeFileSync(path.join(dir, 'control', 'pause'), '');
      const code = await withTimeout(run.done, 60000, run.child);
      const ev = events(dir);
      const stopped = ev.find((e) => e.e === 'stopped');
      const last = metrics(dir).slice(-1)[0];
      check('pause : sortie 0, « stopped saved:true » au pas courant', code === 0 && stopped && stopped.saved === true && stopped.step === last.s && stopped.step < 60, { code, stopped, log: logOf(dir).slice(-600) });
      check('pause : « stopped » dit pourquoi (why:"pause") — ÉVÈNEMENTS écrit « Pause au pas », pas « Arrêt »', !!stopped && stopped.why === 'pause', stopped);
      const ck = stopped ? LTX.checkpoints(dir).find((c) => c.step === stopped.step) : null;
      check('pause : un point de contrôle complet est écrit à ce pas (par _save_checkpoint), et annoncé', !!ck && LTX.verify(dir, ck) && ev.some((e) => e.e === 'checkpoint' && e.step === stopped.step), ck);
      check('pause : sortie propre — le trainer se referme, rien n’est finalisé, aucun « done »', /fake ltx: teardown/.test(logOf(dir)) && !/fake ltx: finalize/.test(logOf(dir)) && !ev.some((e) => e.e === 'done'));
      const at = stopped ? stopped.step : 0;
      setDoc(dir, { steps: at + 6 });
      const n0 = ev.length;
      const code2 = await launch(LTX, dir, { run: 2, resume: at }, FENV).done;
      const ev2 = events(dir).slice(n0);
      const m2 = metrics(dir).filter((m) => m.run === 2);
      check('reprise : « resumed » au pas du point, premier pas mesuré = pas + 1, jusqu’à « done »',
        code2 === 0 && ev2.some((e) => e.e === 'resumed' && e.step === at) && m2[0].s === at + 1 && m2.length === 6 && ev2[ev2.length - 1].e === 'done' && ev2[ev2.length - 1].step === at + 6, { ev2: ev2.map((e) => e.e), m2: m2.map((m) => m.s) });
      check('reprise : pas de réencodage, « caps » porte le lancement 2', !ev2.some((e) => e.phase === 'encode') && ev2[0].e === 'caps' && ev2[0].run === 2);

      // reprise refusée par l'outil (il repartirait de zéro en silence)
      setDoc(dir, { steps: at + 20 });
      const before = LTX.checkpoints(dir).map((c) => `${c.step}:${c.at}`).join();
      const n1 = events(dir).length;
      const code3 = await launch(LTX, dir, { run: 3, resume: at }, { ...FENV, FAKE_LTX_REFUSE: '1' }).done;
      const ev3 = events(dir).slice(n1);
      check('cas 10 — l’outil repart de 0 malgré la reprise : « error code:resume », sortie 1, aucun pas, rien d’écrasé',
        code3 === 1 && ev3.some((e) => e.e === 'error' && e.code === 'resume') && metrics(dir).filter((m) => m.run === 3).length === 0 && LTX.checkpoints(dir).map((c) => `${c.step}:${c.at}`).join() === before, ev3);
      const n2 = events(dir).length;
      const absent = [at + 1, at + 2, at + 3].find((k) => !LTX.checkpoints(dir).some((c) => c.step === k));
      const code4 = await launch(LTX, dir, { run: 4, resume: absent }, FENV).done;
      check('reprise depuis un point absent : refusée avant de charger quoi que ce soit', code4 === 1 && events(dir).slice(n2).some((e) => e.e === 'error' && e.code === 'resume') && !/fake ltx: loading/.test(logOf(dir).split('lancement 4').pop()), { code4, ev: events(dir).slice(n2), log: logOf(dir).slice(-500) });
    }

    // arrêt (même chemin que pause), pause pendant un essai
    {
      const dir = mk('ltx-essai', { sampleEvery: 4, samplePrompts: ['rsa woman'] }, 40);
      const run = launch(LTX, dir, { run: 1 }, { ...FENV, FAKE_LTX_STEP: '0.05', FAKE_LTX_SAMPLE: '0.4' });
      await waitFor(() => events(dir).some((e) => e.e === 'sample_step'), 60000);
      fs.writeFileSync(path.join(dir, 'control', 'stop'), '');
      const code = await withTimeout(run.done, 60000, run.child);
      const ev = events(dir);
      const stopped = ev.find((e) => e.e === 'stopped');
      check('cas 5 — arrêt demandé pendant un essai : prend effet après l’essai (le fichier de l’essai existe), point au même pas',
        code === 0 && stopped && stopped.step === 4 && stopped.saved === true && ev.some((e) => e.e === 'sample' && e.step === 4) && ev.findIndex((e) => e.e === 'sample') < ev.findIndex((e) => e.e === 'stopped'), { code, stopped });
      check('arrêt : « stopped » porte why:"stop"', !!stopped && stopped.why === 'stop', stopped);
    }

    // Mia disparue : alive trop vieux
    {
      const dir = mk('ltx-veille', { sampleEvery: 0 }, 2);
      await launch(LTX, dir, { run: 1 }, FENV).done;                    // l'encodage d'abord, Mia présente
      setDoc(dir, { steps: 400 });
      const n0 = events(dir).length;
      const timing = JSON.stringify({ aliveCheckMs: 100, aliveStaleMs: 600, aliveRecheckMs: 300, heartbeatMs: 200 });
      const run = launch(LTX, dir, { run: 2, noAlive: true }, { ...FENV, FAKE_LTX_STEP: '0.05', MIA_TRAIN_TIMING: timing });
      const code = await withTimeout(run.done, 60000, run.child);
      const stopped = events(dir).slice(n0).find((e) => e.e === 'stopped');
      check('cas 13 — Mia ne réécrit plus « alive » : l’adaptateur écrit un point et s’arrête seul, sortie écrite sans tuyau',
        code === 0 && stopped && stopped.saved === true && stopped.step < 400 && /ne donne plus signe de vie/.test(logOf(dir)) && !!LTX.checkpoints(dir).find((c) => c.step === stopped.step), { code, stopped });
      check('Mia disparue : « stopped » porte why:"alive" (une pause, pas un arrêt)', !!stopped && stopped.why === 'alive', stopped);
    }

    // gardes à l'exécution
    {
      const dir = mk('ltx-gardes', { sampleEvery: 0 }, 12);
      const c1 = await launch(LTX, dir, { run: 1 }, { ...FENV, FAKE_LTX_NOLOSS: '1' }).done;
      const e1 = events(dir).find((e) => e.e === 'error');
      check('les 3 premiers pas sans « train/loss » → « error code:tool » (pas d’écran vide)', c1 === 1 && e1 && e1.code === 'tool' && e1.why === 'noloss' && metrics(dir).length === 3, e1);
      const n = events(dir).length;
      const c2 = await launch(LTX, dir, { run: 2 }, { ...FENV, FAKE_LTX_NOFILE: '1' }).done;
      const e2 = events(dir).slice(n).find((e) => e.e === 'error');
      check('point annoncé par l’outil sans son fichier → « error code:tool »', c2 === 1 && e2 && e2.code === 'tool' && e2.why === 'checkpoint', e2);
      const n3 = events(dir).length;
      const c3 = await launch(LTX, dir, { run: 3 }, { ...FENV, FAKE_LTX_SIG: '1' }).done;
      const e3 = events(dir).slice(n3).find((e) => e.e === 'error');
      check('signature changée dans l’outil → refus avant tout chargement (raison « signature »)', c3 === 1 && e3 && e3.why === 'signature' && /update_training/.test(e3.message) && !/fake ltx: loading/.test(logOf(dir).split('lancement 3').pop()), e3);
      const n4 = events(dir).length;
      fs.rmSync(path.join(WORK, 'modeles', 'vae'), { recursive: true, force: true });
      const c4 = await launch(LTX, dir, { run: 4 }, FENV).done;
      const e4 = events(dir).slice(n4).find((e) => e.e === 'error');
      check('fichier de poids absent → « error code:missing » avec son nom', c4 === 1 && e4 && e4.code === 'missing' && /video-vae/.test(e4.message), e4);
      check('toute erreur vient après « caps » (Mia sait de quel lancement elle parle)', events(dir).slice(n4)[0].e === 'caps' && events(dir).slice(n4)[0].run === 4);
    }
  }

  // ---------------------------------------------------------------- ai-toolkit --dry sur le vrai outil
  section('ai-toolkit --dry : configuration lue par ai-toolkit (get_job), comparée à qwen21_essai20.yaml');
  const aitkImages = [{ caption: 'ldaida girl, portrait' }, { caption: 'a young girl in a garden' }, { caption: 'ldaida girl' }];
  if (!hasAitk) skip('venv-aitk absent de cette machine');
  else {
    const ref = fs.existsSync(REF_AITK) ? yamlToJson(python, REF_AITK) : null;
    const rp = ref ? ref.config.process[0] : null;
    const dir = makeTraining('aida', { base: 'qwen21', trigger: 'ldaida girl', steps: 20, images: aitkImages, settings: { saveEvery: 10, sampleEvery: 20, samplePrompts: rp ? rp.sample.prompts : ['ldaida girl, close-up'] } });
    const r = dry(AITK, dir);
    const R = r.report;
    check('--dry réussit (code 0, rapport lu)', r.code === 0 && R && R.ok === true, r.out.slice(-2500));
    if (R && R.ok) {
      const B = R.readback;
      check('ai-toolkit construit le job sans le lancer : ExtensionJob / DiffusionTrainer, journal UILogger', B.job === 'ExtensionJob' && B.process === 'DiffusionTrainer' && B.logger === 'UILogger', B);
      check('valeurs relues par l’outil : nom = slug, sorties dans out\\, jeu dans dataset\\, déclencheur',
        B.name === 'aida' && path.resolve(B.save_root) === path.join(dir, 'out', 'aida') && path.resolve(B.folder_path) === path.join(dir, 'dataset') && B.trigger_word === 'ldaida girl', B);
      check('valeurs relues : qwen_image_2, 20 pas, lot 2, adamw8bit, lr 1e-4, point tous les 10 (40 gardés), essai tous les 20, journal à chaque pas',
        B.arch === 'qwen_image_2' && B.name_or_path === 'Qwen/Qwen-Image-2.1' && B.steps === 20 && B.batch_size === 2 && B.optimizer === 'adamw8bit' && Number(B.lr) === 1e-4 && B.save_every === 10 && B.max_step_saves_to_keep === 40
        && B.sample_every === 20 && B.log_every === 1 && B.use_ui_logger === true && B.linear === 32 && B.linear_alpha === 32 && JSON.stringify(B.resolution) === '[768,1024]', B);
      check('prise en main : l’outil s’est reconnu piloté (base + AITK_JOB_ID) et a écrit « Starting » dans NOTRE ligne Job',
        B.is_ui_trainer === true && B.job_id === R.jobId && path.resolve(B.sqlite_db_path) === path.join(dir, 'control', 'aitk.db') && R.takeover === true && R.takeoverInfo === 'Starting', { B: B.is_ui_trainer, t: R.takeoverInfo });
      check('après --dry la ligne Job est neuve', R.job && R.job.status === 'running' && R.job.info === '' && R.job.stop === 0 && R.job.step === 0, R.job);
      check('commande de l’outil : run.py config.yaml, SANS --log, depuis ses sources',
        R.command.slice(-2).join(' ') === `run.py ${path.join(dir, 'config.yaml')}` && !R.command.includes('--log') && !R.command.includes('-l') && path.resolve(R.cwd) === path.join(TOOLS, 'src', 'ai-toolkit'), R.command);
      check('--dry n’écrit ni events.jsonl ni metrics.jsonl', !fs.existsSync(path.join(dir, 'events.jsonl')) && !fs.existsSync(path.join(dir, 'metrics.jsonl')));
      const cfg = yamlToJson(python, path.join(dir, 'config.yaml'));
      if (ref) {
        const d = diffPaths(ref, cfg).sort();
        const allowed = ['config.name', 'config.process.0.datasets.0.folder_path', 'config.process.0.save.max_step_saves_to_keep', 'config.process.0.sqlite_db_path', 'config.process.0.training_folder'];
        check('équivalente à qwen21_essai20.yaml : seuls diffèrent le nom, les dossiers, la base Job et le nombre de points gardés (40)', JSON.stringify(d) === JSON.stringify(allowed), d);
        console.log(`        différences : ${d.join(', ')}`);
      } else skip(`comparaison : ${REF_AITK} absent`);

      // pause simulée puis nouveau lancement : la ligne doit être remise à neuf
      const sq = String.raw`import sqlite3, sys; c = sqlite3.connect(sys.argv[1]); c.execute("UPDATE Job SET stop = 1, save_now = 1, status = 'stopped', info = 'Job stopped', step = 10"); c.commit(); c.close()`;
      spawnSync(python.exe, ['-B', '-c', sq, path.join(dir, 'control', 'aitk.db')], { env: { ...process.env, ...python.env }, windowsHide: true });
      const st = (name, step) => {
        const head = Buffer.from(JSON.stringify({ __metadata__: { step: String(step) }, 'lora.w': { dtype: 'F32', shape: [4], data_offsets: [0, 16] } }));
        const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(head.length), 0);
        fs.mkdirSync(path.join(dir, 'out', 'aida'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'out', 'aida', name), Buffer.concat([len, head, Buffer.alloc(16)]));
      };
      st('aida_000000010.safetensors', 10);
      const again = dry(AITK, dir, { run: 2, resume: 10 }).report;
      check('cas 32 — après une pause (stop 1, « Job stopped »), le lancement suivant remet la ligne à neuf : stop 0, running, pas = reprise',
        again && again.ok && again.job.stop === 0 && again.job.save_now === 0 && again.job.status === 'running' && again.job.info === '' && again.job.step === 10 && again.takeover === true, again && again.job);
      check('reprise : le fichier que l’outil choisira est bien celui du pas demandé', again && again.resume.latest === 10 && again.resume.aside.length === 0, again && again.resume);
      setDoc(dir, { settings: { sampleEvery: 0 } });
      const none = dry(AITK, dir, { run: 3 }).report;
      check('aucun essai → l’outil relit disable_sampling vrai', none && none.ok && none.readback.disable_sampling === true, none && none.readback);
    }
  }

  // ---------------------------------------------------------------- ai-toolkit : déroulé complet sur un FAUX run.py
  section('ai-toolkit : pilotage par la base Job, perte, points, essais, pause, reprise — sur un faux run.py (aucun GPU)');
  if (!python) skip('aucun Python avec PyYAML');
  else {
    const fake = writeFakeAitk(path.join(WORK, 'faux-aitk'));
    fs.mkdirSync(path.join(WORK, 'modeles-qwen'), { recursive: true });
    for (const w of CATALOG.bases.find((b) => b.id === 'qwen21').weights) {
      fs.mkdirSync(path.join(WORK, 'modeles-qwen', w.dir), { recursive: true });
      fs.writeFileSync(path.join(WORK, 'modeles-qwen', w.dir, w.file), 'poids');
    }
    const tool = hasAitk ? AITK : { command: (o) => ({ ...LTX.command(o), args: ['-B', '-u', path.join(ADAPTERS, 'mia_train_aitk.py'), ...TC.adapterArgs(o)] }) };
    const FENV = { MIA_TRAIN_TOOLS: fake.tools, MODELS_PATH: path.join(WORK, 'modeles-qwen'), MIA_TRAIN_TIMING: JSON.stringify({ pollMs: 100, exitWaitMs: 8000 }) };
    const mk = (name, settings = {}, steps = 30) => makeTraining(name, { base: 'qwen21', trigger: 'ldaida girl', steps, images: aitkImages, settings: { saveEvery: 10, sampleEvery: 15, samplePrompts: ['ldaida girl, close-up', 'ldaida girl, garden'], ...settings } });

    {
      const dir = mk('aitk-nominal');
      const code = await launch(tool, dir, { run: 1 }, FENV).done;
      const ev = events(dir);
      const mt = metrics(dir);
      const log = logOf(dir);
      check('sortie 0, « done » au dernier pas', code === 0 && ev[ev.length - 1].e === 'done' && ev[ev.length - 1].step === 30, { code, last: ev[ev.length - 1], log: log.slice(-1200) });
      check('« caps » d’abord (ai-toolkit, lancement 1)', ev[0].e === 'caps' && /^ai-toolkit/.test(ev[0].tool) && ev[0].run === 1 && ev[0].saveNow === true, ev[0]);
      const argv = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'argv.json'), 'utf8'));
      check('l’outil est lancé depuis ses sources avec AITK_JOB_ID, sans --log',
        path.resolve(argv.cwd) === path.join(fake.tools, 'src', 'ai-toolkit') && argv.job === 't_20261118-1200_aitk-nominal' && argv.argv.length === 2 && argv.argv[1] === path.join(dir, 'config.yaml'), argv);
      const ph = ev.filter((e) => e.e === 'phase').map((e) => e.phase);
      check('phases lues dans la ligne Job : check → load → train, avec sample et save en route', ph[0] === 'check' && ph[1] === 'load' && ph.indexOf('train') > 1 && ph.includes('sample'), ph.join(' '));
      check('perte et lr de chaque pas lus dans loss_log.db : pas de l’outil k → pas k + 1 de Mia', mt.length === 30 && mt[0].s === 1 && mt[29].s === 30 && mt.every((m, k) => m.s === k + 1 && m.run === 1 && m.lr === 1e-4) && mt[1].loss === 0.5 && mt[1].dt > 0, mt.slice(0, 3));
      const cks = ev.filter((e) => e.e === 'checkpoint');
      check('points annoncés une fois complets : 10, 20, puis le LoRA final (pas 30)',
        cks.map((c) => c.step).join() === '10,20,30' && cks[0].file === 'out/aitk-nominal/aitk-nominal_000000010.safetensors' && cks[2].file === 'out/aitk-nominal/aitk-nominal.safetensors' && cks.every((c) => TC.safetensorsComplete(path.join(dir, c.file))), cks);
      if (hasAitk) check('mêmes points vus par le descripteur aitk.js', AITK.checkpoints(dir, { slug: 'aitk-nominal', steps: 30 }).map((c) => c.step).join() === '10,20,30');
      const sm = ev.filter((e) => e.e === 'sample');
      check('essais : 2 images au pas 15, lues dans out\\<nom>\\samples', sm.map((s) => `${s.step}:${s.i}`).join() === '15:1,15:2' && sm.every((s) => s.kind === 'image' && fs.existsSync(path.join(dir, s.file))), sm);
      check('sortie de l’outil recopiée dans log.txt ; barre tqdm réduite à son dernier état', /Running 1 job/.test(log) && /1 completed job/.test(log) && (log.match(/aitk-nominal:\s+\d+%/g) || []).length <= 8, (log.match(/aitk-nominal:\s+\d+%/g) || []).length);
    }

    {
      const dir = mk('aitk-pause', { sampleEvery: 0 }, 200);
      const run = launch(tool, dir, { run: 1 }, { ...FENV, FAKE_AITK_STEP: '0.06' });
      await waitFor(() => metrics(dir).length >= 4, 60000);
      fs.writeFileSync(path.join(dir, 'control', 'pause'), '');
      const code = await withTimeout(run.done, 60000, run.child);
      const ev = events(dir);
      const stopped = ev.find((e) => e.e === 'stopped');
      const file = stopped ? path.join(dir, 'out', 'aitk-pause', `aitk-pause_${String(stopped.step).padStart(9, '0')}.safetensors`) : '';
      check('pause : save_now, fichier complet, PUIS stop → « stopped saved:true » au pas du fichier, sortie 0',
        code === 0 && stopped && stopped.saved === true && stopped.step > 0 && stopped.step < 200 && TC.safetensorsComplete(file) && ev.some((e) => e.e === 'checkpoint' && e.step === stopped.step), { code, stopped, log: logOf(dir).slice(-800) });
      check('l’outil s’est arrêté de lui-même sur l’ordre (« Job stopped »), sans être tué', /Job stopped/.test(logOf(dir)) && !/arrêté de force/.test(logOf(dir)));
      check('ai-toolkit, pause : « stopped » porte why:"pause"', !!stopped && stopped.why === 'pause', stopped);
      const at = stopped ? stopped.step : 0;
      setDoc(dir, { steps: at + 8 });
      const n0 = ev.length;
      // la base porte encore stop = 1 : sans remise à neuf, l'outil s'arrêterait dès le chargement
      const code2 = await launch(tool, dir, { run: 2, resume: at }, FENV).done;
      const ev2 = events(dir).slice(n0);
      const m2 = metrics(dir).filter((m) => m.run === 2);
      check('cas 32 — reprise : ligne Job remise à neuf (l’outil ne s’arrête pas au chargement), « resumed », suite des pas, « done »',
        code2 === 0 && ev2.some((e) => e.e === 'resumed' && e.step === at) && m2.length === 8 && m2[0].s === at + 1 && ev2[ev2.length - 1].e === 'done', { code2, ev2: ev2.map((e) => e.e + (e.phase || '')), m2: m2.map((m) => m.s) });

      const dir3 = mk('aitk-refus', { sampleEvery: 0 }, 60);
      const r1 = launch(tool, dir3, { run: 1 }, { ...FENV, FAKE_AITK_STEP: '0.06' });
      await waitFor(() => metrics(dir3).length >= 3, 60000);
      fs.writeFileSync(path.join(dir3, 'control', 'stop'), '');
      await withTimeout(r1.done, 60000, r1.child);
      const s3 = events(dir3).find((e) => e.e === 'stopped');
      check('ai-toolkit, arrêt : « stopped » porte why:"stop"', !!s3 && s3.why === 'stop', s3);
      const n3 = events(dir3).length;
      const code3 = await launch(tool, dir3, { run: 2, resume: s3 ? s3.step : 1 }, { ...FENV, FAKE_AITK_REFUSE: '1', FAKE_AITK_STEP: '0.2' }).done;
      const ev3 = events(dir3).slice(n3);
      check('cas 10 — l’outil repart de 0 malgré la reprise : « error code:resume », outil tué avant le premier point',
        code3 === 1 && ev3.some((e) => e.e === 'error' && e.code === 'resume') && !ev3.some((e) => e.e === 'checkpoint'), ev3);
      const n4 = events(dir3).length;
      const code4 = await launch(tool, dir3, { run: 3, resume: (s3 ? s3.step : 1) + 5 }, FENV).done;
      check('reprise depuis un pas sans fichier : refusée avant de lancer l’outil', code4 === 1 && events(dir3).slice(n4).some((e) => e.e === 'error' && e.code === 'resume') && !/lancement :/.test(logOf(dir3).split('lancement 3').pop()));
    }

    {
      const dir = mk('aitk-muet', { sampleEvery: 0 }, 400);
      const run = launch(tool, dir, { run: 1 }, { ...FENV, FAKE_AITK_NO_DB: '1', FAKE_AITK_STEP: '0.05', MIA_TRAIN_TIMING: JSON.stringify({ pollMs: 100, takeoverMs: 1500 }) });
      const code = await withTimeout(run.done, 60000, run.child);
      const err = events(dir).find((e) => e.e === 'error');
      check('l’outil n’écrit pas dans sa ligne Job → « L’outil n’a pas pris le pilotage de Mia. », outil tué',
        code === 1 && err && err.code === 'tool' && err.why === 'takeover' && err.message === 'L’outil n’a pas pris le pilotage de Mia.', { code, err });
    }

    {
      const dir = mk('aitk-veille', { sampleEvery: 0 }, 400);
      const timing = JSON.stringify({ pollMs: 100, exitWaitMs: 8000, aliveCheckMs: 100, aliveStaleMs: 600, aliveRecheckMs: 300, heartbeatMs: 200 });
      const run = launch(tool, dir, { run: 1, noAlive: true }, { ...FENV, FAKE_AITK_STEP: '0.05', MIA_TRAIN_TIMING: timing });
      const code = await withTimeout(run.done, 60000, run.child);
      const stopped = events(dir).find((e) => e.e === 'stopped');
      check('cas 13 — Mia disparue : même chemin que la pause (point puis arrêt), sortie 0', code === 0 && stopped && stopped.saved === true && stopped.step < 400, { code, stopped, log: logOf(dir).slice(-500) });
      check('ai-toolkit, Mia disparue : « stopped » porte why:"alive"', !!stopped && stopped.why === 'alive', stopped);
    }

    {
      const dir = mk('aitk-poids', {}, 20);
      fs.rmSync(path.join(WORK, 'modeles-qwen', 'vae'), { recursive: true, force: true });
      const code = await launch(tool, dir, { run: 1 }, FENV).done;
      const err = events(dir).find((e) => e.e === 'error');
      check('fichier de poids absent → « error code:missing », l’outil n’est pas lancé (aucun téléchargement silencieux)', code === 1 && err && err.code === 'missing' && /vae/.test(err.message) && !fs.existsSync(path.join(dir, 'out', 'argv.json')), err);
    }
  }

  // ---------------------------------------------------------------- fin
  await wait(200);
  let left = '';
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*test-train-config-${process.pid}*' -and $_.ProcessId -ne ${process.pid} -and $_.ProcessId -ne $PID } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8', windowsHide: true });
    left = String(r.stdout || '').trim();
  } catch { left = ''; }
  section('Fin');
  check('aucun processus laissé derrière', left === '', left);
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* un antivirus tient un fichier : sans gravité */ }
  console.log(`\n${passes} contrôles réussis, ${failures} en échec${skipped ? `, ${skipped} sautés` : ''}.`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
