"""Trains Laya adapters from Augur's own decision record, unattended.

    python selftrain.py run [--decisions <decisions.jsonl>] [--min-new 200] [--min-test 50] [--force] [--dry-run]
    python selftrain.py status

Each run exports training rows from the decision record, then for each pilot (augur_activity, augur_data_tier, augur_fit)
trains a candidate when at least --min-new training rows have appeared since that pilot was last trained and the test
split holds at least --min-test rows. A candidate goes live only through train.py promote, which compares it with the
live adapter on the same held-out rows, so a worse candidate is simply left unpromoted and the live one keeps serving.
Every promotion is copied to the other machine with sync.py.

A run is skipped while this PC is busy: the GPU is over --busy-pct (default 30), or the machine runs on battery.
Rows come only from picks that kept their task text and whose activity or tier the caller declared, or from how a job
ended; nothing in them was labelled by Jev, and train.py is told to exclude that provenance regardless.
"""

import ctypes
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from env import home  # noqa: E402

ROOT = home(HERE)
STATE = os.path.join(ROOT, "selftrain-state.json")
PILOTS = ("augur_activity", "augur_data_tier", "augur_fit")
FLAGS = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0


def opt(args, name, default, cast=str):
    return cast(args[args.index(name) + 1]) if name in args else default


def on_battery() -> bool:
    if sys.platform != "win32":
        return False

    class Power(ctypes.Structure):
        _fields_ = [("ac", ctypes.c_ubyte), ("flag", ctypes.c_ubyte), ("pct", ctypes.c_ubyte), ("saver", ctypes.c_ubyte),
                    ("life", ctypes.c_ulong), ("full", ctypes.c_ulong)]
    p = Power()
    return bool(ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(p))) and p.ac == 0


def gpu_busy_pct() -> float:
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"], capture_output=True, text=True,
                             timeout=10, creationflags=FLAGS).stdout.split()
        return max(float(x) for x in out) if out else 0.0
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return 0.0


def load_state():
    try:
        return json.load(open(STATE, encoding="utf-8"))
    except (OSError, ValueError):
        return {"trained_rows": {}, "runs": []}


def save_state(s):
    tmp = STATE + ".tmp"
    json.dump(s, open(tmp, "w", encoding="utf-8"), indent=1)
    os.replace(tmp, STATE)


def default_decisions() -> str:
    return os.path.join(os.environ.get("LOCALAPPDATA", ""), "Augur", "dispatch", "decisions.jsonl")


def node_script():
    """The exporter lives in the repo; a packaged install points AUGUR_EXPORT at its own copy."""
    exp = os.environ.get("AUGUR_EXPORT")
    if exp:
        return [os.environ.get("AUGUR_NODE", "node"), exp], os.path.dirname(exp)
    from pool import load_config
    repo = os.environ.get("AUGUR_REPO") or load_config().get("repo") or os.path.normpath(os.path.join(HERE, "..", "..", ".."))
    pkg = os.path.join(repo, "packages", "augurd")
    return [os.environ.get("AUGUR_NODE", "node"), "--import", "tsx", os.path.join(pkg, "src", "export-training.ts")], pkg


def export_rows(decisions: str, out: str) -> dict:
    cmd, cwd = node_script()
    r = subprocess.run(cmd + [decisions, out], capture_output=True, text=True, timeout=300, creationflags=FLAGS, cwd=cwd)
    if r.returncode:
        raise RuntimeError(f"export failed: {r.stderr.strip()[-400:]}")
    return json.loads(r.stdout.strip().splitlines()[-1])


def split_by_pilot(path: str) -> dict:
    by = {}
    for line in open(path, encoding="utf-8"):
        if line.strip():
            row = json.loads(line)
            by.setdefault(row["pilot"], []).append(row)
    return by


def train_py(*args) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, os.path.join(HERE, "train.py"), *args], capture_output=True, text=True, creationflags=FLAGS,
                          env={**os.environ, "LAYA_HOME": ROOT})


def cmd_run(args):
    dry, force = "--dry-run" in args, "--force" in args
    min_new, min_test = opt(args, "--min-new", 200, int), opt(args, "--min-test", 50, int)
    decisions = opt(args, "--decisions", default_decisions())
    report = {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "pilots": {}}
    if not force:
        if on_battery():
            report["skipped"] = "on battery"
        elif gpu_busy_pct() > opt(args, "--busy-pct", 30.0, float):
            report["skipped"] = "GPU busy"
    if "skipped" not in report and not os.path.exists(decisions):
        report["skipped"] = "no decision record yet"
    if "skipped" in report:
        print(json.dumps(report))
        return
    data = os.path.join(ROOT, "data")
    os.makedirs(data, exist_ok=True)
    rows_file = os.path.join(data, "augur_learned.jsonl")
    report["export"] = export_rows(decisions, rows_file)
    state, by = load_state(), split_by_pilot(rows_file)
    promoted = False
    for pilot in PILOTS:
        rows = by.get(pilot, [])
        train_n = sum(1 for r in rows if r["split"] == "train"),
        train_n, test_n = train_n[0], sum(1 for r in rows if r["split"] == "test")
        new = train_n - state["trained_rows"].get(pilot, 0)
        info = report["pilots"][pilot] = {"train": train_n, "test": test_n, "new": new}
        if new < min_new and not force:
            info["action"] = f"waiting for {min_new - new} more rows"
            continue
        if not rows:
            info["action"] = "no rows yet"
            continue
        if test_n < min_test:
            info["action"] = f"needs {min_test - test_n} more test rows"
            continue
        if dry:
            info["action"] = "would train"
            continue
        # A pilot's rows are trained on their own so one pilot's adapter never depends on another's data.
        pfile = os.path.join(data, f"{pilot}.jsonl")
        with open(pfile, "w", encoding="utf-8") as f:
            f.writelines(json.dumps(r) + "\n" for r in rows)
        name = f"{pilot}-{time.strftime('%Y%m%d-%H%M')}"
        t = train_py("train", "--data", pfile, "--name", name, "--exclude-provenance", "jev_teacher", "--recipe", "ce", "--amp")
        if t.returncode:
            info["action"] = f"training failed: {t.stderr.strip()[-300:]}"
            continue
        p = train_py("promote", name, "--pilot", pilot)
        info["adapter"] = name
        if p.returncode:
            info["action"] = "trained, not promoted (did not beat the live adapter)"
        else:
            info["action"] = "promoted"
            promoted = True
        state["trained_rows"][pilot] = train_n
    if promoted:
        s = subprocess.run([sys.executable, os.path.join(HERE, "sync.py"), "push"], capture_output=True, text=True, creationflags=FLAGS,
                           env={**os.environ, "LAYA_HOME": ROOT})
        report["sync"] = "pushed" if s.returncode == 0 else f"failed: {s.stderr.strip()[-200:]}"
    state["runs"] = (state["runs"] + [report])[-20:]
    if not dry:
        save_state(state)
    print(json.dumps(report, indent=1))


def cmd_status(_args):
    s = load_state()
    print(json.dumps({"trained_rows": s["trained_rows"], "last_run": s["runs"][-1] if s["runs"] else None}, indent=1))


if __name__ == "__main__":
    cmds = {"run": cmd_run, "status": cmd_status}
    if len(sys.argv) < 2 or sys.argv[1] not in cmds:
        sys.exit(__doc__)
    cmds[sys.argv[1]](sys.argv[2:])
