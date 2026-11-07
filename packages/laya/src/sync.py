"""Keeps the adapters, the registry, and the training rows in step across this PC and the sync hosts.

    python sync.py push [--dry-run] [--host <name>]
        This PC to every sync host, in order. Adapters go first, then the registry, so a server never
        reads a pilot that points at an adapter that is not there yet. A host that does not answer is
        reported, and the rest still run. `--host` limits the run to one host, matched as the full
        `user@host` or as the name after `@`.
    python sync.py pull [--dry-run] [--host <name>]
        The first host that receives training rows, back to this PC.
    python sync.py status [--host <name>]
        What differs, per host, without changing anything.

Adapters never change once written, so one is copied only when its folder is missing on the other side, and its
weights are checked by SHA-256 after the copy. The registry is a small JSON file. `push` sends this PC's copy.
`pull` merges the remote history into it and keeps this PC's pilot settings unless the pilot exists only on the
remote. Training rows are append-only logs. A file is copied when the other side lacks it or is a strict prefix
of it, and two files that each have lines the other lacks are reported as a conflict and left alone. A host with
`rows` set to false gets adapters and the registry only.

The registry is replaced with a rename, so a server that re-reads it on its next request never sees half a file.
Hosts come from `LAYA_BILBO`, or from `syncHost` and `syncHosts` in `~/.augur/laya.json`. `LAYA_BILBO`, when set,
is the only host, and it receives rows. `LAYA_BILBO_HOME` is the remote folder (default `laya-serve`).
"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile

from pool import sync_targets  # noqa: E402  (sits beside this file when deployed)

FLAGS = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0


def home() -> str:
    return os.environ.get("LAYA_HOME") or os.path.join(os.environ["LOCALAPPDATA"], "Augur", "laya")


def remote_root() -> str:
    return os.environ.get("LAYA_BILBO_HOME", "laya-serve")


def ssh(host: str, command: str) -> str:
    r = subprocess.run(["ssh", "-o", "BatchMode=yes", host, command], capture_output=True, text=True, creationflags=FLAGS)
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


def remote_adapters(host: str) -> dict:
    """`{adapter name: sha256 of its weights}` on `host`."""
    root = remote_root()
    out = ssh(host, f"cd {root}/adapters 2>/dev/null && for d in */; do n=${{d%/}}; [ -f $n/manifest.json ] && echo $n $(shasum -a 256 $n/adapter.safetensors | cut -d' ' -f1); done; true")
    return {line.split()[0]: line.split()[1] for line in out.splitlines() if line.strip()}


def read_json(path: str, default):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return default


def remote_registry(host: str) -> dict:
    out = ssh(host, f"cat {remote_root()}/adapters/registry.json 2>/dev/null || echo '{{}}'")
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


def remote_rows(host: str) -> dict:
    """`{file name: sha256}` of the training rows on `host`."""
    out = ssh(host, f"cd {remote_root()}/data 2>/dev/null && for f in *.jsonl; do [ -f $f ] && echo $f $(shasum -a 256 $f | cut -d' ' -f1); done; true")
    return {line.split()[0]: line.split()[1] for line in out.splitlines() if line.strip()}


def lines_of(path: str) -> list:
    with open(path, encoding="utf-8") as handle:
        return [line for line in handle.read().splitlines() if line.strip()]


def plan_rows(host: str) -> dict:
    """Which row files go which way. Two files that each hold lines the other lacks are a conflict."""
    ours, theirs = local_rows(), remote_rows(host)
    out = {"to_remote": [], "from_remote": [], "conflict": []}
    for name in sorted(set(ours) | set(theirs)):
        if name not in theirs:
            out["to_remote"].append(name)
        elif name not in ours:
            out["from_remote"].append(name)
        elif sha256(ours[name]) != theirs[name]:
            tmp = os.path.join(tempfile.gettempdir(), f"laya-remote-{name}")
            scp(f"{host}:{remote_root()}/data/{name}", tmp)
            mine, there = lines_of(ours[name]), lines_of(tmp)
            os.remove(tmp)
            if set(there) < set(mine):
                out["to_remote"].append(name)
            elif set(mine) < set(there):
                out["from_remote"].append(name)
            else:
                out["conflict"].append(name)
    return out


def plan(spec: dict) -> dict:
    """What a push or pull would do for one host. Keys starting with an underscore are for the code, not the report."""
    host = spec["host"]
    ours, theirs = local_adapters(), remote_adapters(host)
    mine = {n: sha256(os.path.join(home(), "adapters", n, "adapter.safetensors")) for n in ours}
    reg_here = read_json(os.path.join(home(), "adapters", "registry.json"), {"pilots": {}, "history": []})
    reg_there = remote_registry(host)
    rows = plan_rows(host) if spec["rows"] else {"to_remote": [], "from_remote": [], "conflict": []}
    return {
        "adapters_to_remote": sorted(ours - set(theirs)),
        "adapters_from_remote": sorted(set(theirs) - ours),
        "adapter_clash": sorted(n for n in ours & set(theirs) if mine[n] != theirs[n]),
        "registry_differs": reg_here.get("pilots") != reg_there.get("pilots") or reg_here.get("hard_max_len") != reg_there.get("hard_max_len"),
        "rows": rows,
        "_registries": (reg_here, reg_there),
    }


def report(p: dict) -> dict:
    return {k: v for k, v in p.items() if not k.startswith("_")}


def _result(spec: dict, ok: bool, body: dict, error: str = "") -> dict:
    out = {"host": spec["host"], "copy_rows": spec["rows"], "ok": ok, **body}
    if error:
        out["error"] = error
    return out


def push_one(spec: dict, dry: bool) -> dict:
    """Copy to one host. A failure is this host's result, and the registry rename has not run for it."""
    try:
        p = plan(spec)
    except (RuntimeError, OSError, ValueError) as e:
        return _result(spec, False, {}, str(e))
    body = report(p)
    if p["adapter_clash"]:
        return _result(spec, False, body, f"adapter names with different weights on the two sides, refusing: {p['adapter_clash']}")
    if dry:
        return _result(spec, True, body)
    host, root = spec["host"], remote_root()
    try:
        for name in p["adapters_to_remote"]:
            src = os.path.join(home(), "adapters", name)
            scp("-r", src, f"{host}:{root}/adapters/")
            got = ssh(host, f"shasum -a 256 {root}/adapters/{name}/adapter.safetensors | cut -d' ' -f1").strip()
            want = sha256(os.path.join(src, "adapter.safetensors"))
            if got != want:
                return _result(spec, False, body, f"checksum mismatch after copying {name}: {got} != {want}")
        if spec["rows"]:
            for name in p["rows"]["to_remote"]:
                scp(os.path.join(home(), "data", name), f"{host}:{root}/data/{name}")
        if p["registry_differs"] or p["adapters_to_remote"]:
            reg_here, _ = p["_registries"]
            tmp = os.path.join(tempfile.gettempdir(), "laya-registry.json")
            write_json_atomic(tmp, reg_here)
            scp(tmp, f"{host}:{root}/adapters/registry.json.incoming")
            ssh(host, f"mv {root}/adapters/registry.json.incoming {root}/adapters/registry.json")
    except (RuntimeError, OSError, ValueError) as e:
        return _result(spec, False, body, str(e))
    return _result(spec, True, body)


def pull_one(spec: dict, dry: bool) -> dict:
    try:
        p = plan(spec)
    except (RuntimeError, OSError, ValueError) as e:
        return _result(spec, False, {}, str(e))
    body = report(p)
    if p["adapter_clash"]:
        return _result(spec, False, body, f"adapter names with different weights on the two sides, refusing: {p['adapter_clash']}")
    if dry:
        return _result(spec, True, body)
    host, root = spec["host"], remote_root()
    try:
        for name in p["adapters_from_remote"]:
            scp("-r", f"{host}:{root}/adapters/{name}", os.path.join(home(), "adapters") + os.sep)
        if spec["rows"]:
            for name in p["rows"]["from_remote"]:
                scp(f"{host}:{root}/data/{name}", os.path.join(home(), "data", name))
        reg_here, reg_there = p["_registries"]
        merged = json.loads(json.dumps(reg_here))
        for pilot, cfg in (reg_there.get("pilots") or {}).items():
            merged.setdefault("pilots", {}).setdefault(pilot, cfg)
        merged["history"] = merge_history(reg_here.get("history", []), reg_there.get("history", []))
        write_json_atomic(os.path.join(home(), "adapters", "registry.json"), merged)
    except (RuntimeError, OSError, ValueError) as e:
        return _result(spec, False, body, str(e))
    return _result(spec, True, body)


def parse_args(argv: list) -> tuple:
    dry, host_filter, positional = False, None, []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--dry-run":
            dry = True
        elif arg == "--host" or arg.startswith("--host="):
            if arg == "--host":
                i += 1
                if i >= len(argv) or not argv[i].strip():
                    sys.exit("sync.py: --host needs a user@host or a host name.")
                host_filter = argv[i].strip()
            else:
                host_filter = arg.split("=", 1)[1].strip()
                if not host_filter:
                    sys.exit("sync.py: --host needs a user@host or a host name.")
        elif arg.startswith("-"):
            sys.exit(__doc__)
        else:
            positional.append(arg)
        i += 1
    if len(positional) > 1:
        sys.exit(__doc__)
    return (positional[0] if positional else "status"), dry, host_filter


def select_targets(targets: list, host_filter) -> list:
    if not targets:
        sys.exit("No second machine is set. Put syncHost (user@host) or syncHosts in ~/.augur/laya.json, or set LAYA_BILBO.")
    if not host_filter:
        return targets
    chosen = [t for t in targets if host_filter == t["host"] or host_filter == t["name"]]
    if not chosen:
        sys.exit(f"No sync host matches {host_filter}.")
    return chosen


def main(argv=None) -> None:
    args = list(sys.argv[1:] if argv is None else argv)
    cmd, dry, host_filter = parse_args(args)
    if cmd not in ("push", "pull", "status"):
        sys.exit(__doc__)
    if cmd == "status":
        dry = True
    chosen = select_targets(sync_targets(), host_filter)
    if cmd == "pull":
        source = next((t for t in chosen if t["rows"]), None)
        if source is None:
            sys.exit("No sync host receives training rows, so there is nothing to pull.")
        results = [pull_one(source, dry)]
    else:
        results = [push_one(t, dry) for t in chosen]
    print(json.dumps({"hosts": results}, indent=1))
    failed = [r for r in results if not r.get("ok")]
    if cmd != "status" and failed:
        for r in failed:
            print(f"{r.get('host', '?')}: {r.get('error', 'failed')}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
