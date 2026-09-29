"""Keeps the adapters, the registry and the training rows the same on this PC and on the Mac mini.

    python sync.py push [--dry-run]    this PC -> Bilbo. Adapters first, then the registry, so a server never
                                       reads a pilot that points at an adapter that is not there yet.
    python sync.py pull [--dry-run]    Bilbo -> this PC, for anything trained there.
    python sync.py status              what differs, without changing anything.

Adapters never change once written, so one is copied only when its folder is missing on the other side, and its
weights are checked by SHA-256 after the copy. The registry is a small JSON file: `push` sends this PC's, `pull`
merges Bilbo's history into it and keeps this PC's pilot settings unless the pilot exists only on Bilbo. Training
rows are append-only logs; a file is copied when the other side lacks it or is a strict prefix of it, and two
files that each have lines the other lacks are reported as a conflict and left alone.

The registry is replaced with a rename, so a server that re-reads it on its next request never sees half a file.
"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile

BILBO = os.environ.get("LAYA_BILBO", "strider@192.168.2.154")
REMOTE = os.environ.get("LAYA_BILBO_HOME", "laya-serve")
FLAGS = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0


def home() -> str:
    return os.environ.get("LAYA_HOME") or os.path.join(os.environ["LOCALAPPDATA"], "Augur", "laya")


def ssh(command: str) -> str:
    r = subprocess.run(["ssh", "-o", "BatchMode=yes", BILBO, command], capture_output=True, text=True, creationflags=FLAGS)
    if r.returncode:
        raise RuntimeError(f"ssh failed: {r.stderr.strip()}")
    return r.stdout


def scp(*args: str) -> None:
    r = subprocess.run(["scp", "-q", "-o", "BatchMode=yes", *args], capture_output=True, text=True, creationflags=FLAGS)
    if r.returncode:
        raise RuntimeError(f"scp failed: {r.stderr.strip()}")


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def local_adapters() -> set:
    d = os.path.join(home(), "adapters")
    return {n for n in os.listdir(d) if os.path.isfile(os.path.join(d, n, "manifest.json"))} if os.path.isdir(d) else set()


def remote_adapters() -> dict:
    """{adapter name: sha256 of its weights} on Bilbo."""
    out = ssh(f"cd {REMOTE}/adapters 2>/dev/null && for d in */; do n=${{d%/}}; [ -f $n/manifest.json ] && echo $n $(shasum -a 256 $n/adapter.safetensors | cut -d' ' -f1); done; true")
    return {line.split()[0]: line.split()[1] for line in out.splitlines() if line.strip()}


def read_json(path: str, default):
    try:
        return json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError):
        return default


def remote_registry() -> dict:
    out = ssh(f"cat {REMOTE}/adapters/registry.json 2>/dev/null || echo '{{}}'")
    return json.loads(out or "{}") or {"pilots": {}, "history": []}


def write_json_atomic(path: str, data) -> None:
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


def merge_history(a: list, b: list) -> list:
    seen, out = set(), []
    for h in sorted(a + b, key=lambda h: h.get("ts", "")):
        key = json.dumps(h, sort_keys=True)
        if key not in seen:
            seen.add(key)
            out.append(h)
    return out


def local_rows() -> dict:
    d = os.path.join(home(), "data")
    return {n: os.path.join(d, n) for n in os.listdir(d) if n.endswith(".jsonl")} if os.path.isdir(d) else {}


def remote_rows() -> dict:
    """{file name: sha256} of the training rows on Bilbo."""
    out = ssh(f"cd {REMOTE}/data 2>/dev/null && for f in *.jsonl; do [ -f $f ] && echo $f $(shasum -a 256 $f | cut -d' ' -f1); done; true")
    return {line.split()[0]: line.split()[1] for line in out.splitlines() if line.strip()}


def lines_of(path: str) -> list:
    return [line for line in open(path, encoding="utf-8").read().splitlines() if line.strip()]


def plan_rows() -> dict:
    """Which row files go which way. Two files that each hold lines the other lacks are a conflict."""
    ours, theirs = local_rows(), remote_rows()
    out = {"to_remote": [], "from_remote": [], "conflict": []}
    for name in sorted(set(ours) | set(theirs)):
        if name not in theirs:
            out["to_remote"].append(name)
        elif name not in ours:
            out["from_remote"].append(name)
        elif sha256(ours[name]) != theirs[name]:
            tmp = os.path.join(tempfile.gettempdir(), f"laya-remote-{name}")
            scp(f"{BILBO}:{REMOTE}/data/{name}", tmp)
            mine, there = lines_of(ours[name]), lines_of(tmp)
            os.remove(tmp)
            if set(there) < set(mine):
                out["to_remote"].append(name)
            elif set(mine) < set(there):
                out["from_remote"].append(name)
            else:
                out["conflict"].append(name)
    return out


def plan() -> dict:
    """What a push or pull would do, as data. Keys starting with an underscore are for the code, not the report."""
    ours, theirs = local_adapters(), remote_adapters()
    mine = {n: sha256(os.path.join(home(), "adapters", n, "adapter.safetensors")) for n in ours}
    reg_here = read_json(os.path.join(home(), "adapters", "registry.json"), {"pilots": {}, "history": []})
    reg_there = remote_registry()
    return {
        "adapters_to_remote": sorted(ours - set(theirs)),
        "adapters_from_remote": sorted(set(theirs) - ours),
        "adapter_clash": sorted(n for n in ours & set(theirs) if mine[n] != theirs[n]),
        "registry_differs": reg_here.get("pilots") != reg_there.get("pilots") or reg_here.get("hard_max_len") != reg_there.get("hard_max_len"),
        "rows": plan_rows(),
        "_registries": (reg_here, reg_there),
    }


def report(p: dict) -> dict:
    return {k: v for k, v in p.items() if not k.startswith("_")}


def push(dry: bool) -> dict:
    p = plan()
    if p["adapter_clash"]:
        raise SystemExit(f"adapter names with different weights on the two sides, refusing: {p['adapter_clash']}")
    if dry:
        return report(p)
    for name in p["adapters_to_remote"]:
        src = os.path.join(home(), "adapters", name)
        scp("-r", src, f"{BILBO}:{REMOTE}/adapters/")
        got = ssh(f"shasum -a 256 {REMOTE}/adapters/{name}/adapter.safetensors | cut -d' ' -f1").strip()
        want = sha256(os.path.join(src, "adapter.safetensors"))
        if got != want:
            raise SystemExit(f"checksum mismatch after copying {name}: {got} != {want}")
    for name in p["rows"]["to_remote"]:
        scp(os.path.join(home(), "data", name), f"{BILBO}:{REMOTE}/data/{name}")
    reg_here, _ = p["_registries"]
    if p["registry_differs"] or p["adapters_to_remote"]:
        tmp = os.path.join(tempfile.gettempdir(), "laya-registry.json")
        write_json_atomic(tmp, reg_here)
        scp(tmp, f"{BILBO}:{REMOTE}/adapters/registry.json.incoming")
        ssh(f"mv {REMOTE}/adapters/registry.json.incoming {REMOTE}/adapters/registry.json")
    return report(p)


def pull(dry: bool) -> dict:
    p = plan()
    if p["adapter_clash"]:
        raise SystemExit(f"adapter names with different weights on the two sides, refusing: {p['adapter_clash']}")
    if dry:
        return report(p)
    for name in p["adapters_from_remote"]:
        scp("-r", f"{BILBO}:{REMOTE}/adapters/{name}", os.path.join(home(), "adapters") + os.sep)
    for name in p["rows"]["from_remote"]:
        scp(f"{BILBO}:{REMOTE}/data/{name}", os.path.join(home(), "data", name))
    reg_here, reg_there = p["_registries"]
    merged = json.loads(json.dumps(reg_here))
    for pilot, cfg in (reg_there.get("pilots") or {}).items():
        merged.setdefault("pilots", {}).setdefault(pilot, cfg)
    merged["history"] = merge_history(reg_here.get("history", []), reg_there.get("history", []))
    write_json_atomic(os.path.join(home(), "adapters", "registry.json"), merged)
    return report(p)


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    dry = "--dry-run" in sys.argv or cmd == "status"
    if cmd not in ("push", "pull", "status"):
        sys.exit(__doc__)
    out = pull(dry) if cmd == "pull" else push(dry)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
