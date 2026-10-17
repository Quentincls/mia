# Faux worker de Mia pour tools/test-engine.js (processeur seul, n'importe rien de lourd).
# python -B -u fake_worker.py <tâche> <job.json>   — tâches : ok | fail | crash | slow | stubborn
import json, os, sys, time

def emit(**kw):
    sys.stdout.write("@mia " + json.dumps(kw, ensure_ascii=False) + "\n")
    sys.stdout.flush()

task, job_file = sys.argv[1], sys.argv[2]
job = json.load(open(job_file, encoding="utf-8"))
out_dir = os.path.dirname(os.path.abspath(job_file))

if task == "ok":
    print("une ligne de bibliothèque é")            # part dans le journal
    sys.stderr.write("un avertissement\n")
    for i in range(4):
        emit(p=i / 4, msg="étape %d" % (i + 1), eta=4 - i)
        time.sleep(0.05)
    prev = os.path.join(out_dir, "prev.jpg")
    open(prev, "wb").write(b"jpg")
    emit(preview=prev)
    out = os.path.join(out_dir, "out.txt")
    open(out, "w", encoding="utf-8").write(job.get("text", ""))
    emit(done=True, outputs={"out": {"abs": out, "kind": "image"}, "rel": "out.txt"}, model="Faux")
elif task == "fail":
    emit(error="Erreur simulée du worker")
    sys.exit(1)
elif task == "crash":
    raise ValueError("plantage simulé")
elif task == "slow":
    for i in range(600):
        if os.path.exists(os.path.join(out_dir, "cancel")):
            sys.exit(0)
        emit(p=i / 600)
        time.sleep(0.05)
elif task == "stubborn":
    time.sleep(30)
