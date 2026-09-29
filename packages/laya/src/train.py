"""Train, evaluate and manage LoRA adapters for Laya's English checkpoint. Runs on Bilbo only.

    python train.py train --data data/<file>.jsonl [--data ...] --name <adapter>
                          [--rank 8] [--alpha 16] [--lr 3e-4] [--epochs 6] [--max-len 1024]
                          [--accum 8] [--teacher-weight 0.5] [--no-scorer] [--seed 7] [--amp]
                          [--recipe ce|rlcd] [--base english|typed-decisions] [--exclude-provenance P ...]
                          [--calib-frac 0.1] [--calib-cap 400] [--no-calib]
    python train.py eval  --data data/<file>.jsonl [--adapter <name>|base|live] [--max-len N]
    python train.py status
    python train.py promote <adapter> --pilot <pilot> [--force]
    python train.py rollback --pilot <pilot>
    python train.py set --pilot <pilot> [--max-len N] [--adapter <name>|none]
    python train.py set --hard-max-len N          # server-wide cap on any pilot's max_len (default 4096)

Dataset rows (written by laya_lora.py export or import on Windows):
    {"id", "pilot", "split": "train"|"test", "source": "human"|"teacher"|"teacher_test",
     "state", "questions": {q: definition}, "labels": {q: value}, "soft": {q: target}}
Labels: score -> level index, choice -> option key, noul -> bool. Teacher rows carry soft
targets and are always split "train". A pilot taught only by Jev (Squire's) gets its test rows
as "teacher_test": Jev's top answer as a hard label, so evaluation and promotion measure
agreement with Jev. A pilot with any human test rows is judged on those alone. The split is fixed by a hash of the run id, so a row never
moves between train and test as the log grows, and no adapter ever trains on a test row.

Every row has a provenance: human, outcome or rule (ground truth from a person, a job's result or a
deterministic check), or jev_teacher (Jev's answer used as a soft or hard label). A row without the field
gets human for source human and jev_teacher otherwise. --exclude-provenance drops a class before training,
so an adapter can be built from a lineage that never touched Jev; the manifest lists the provenance mix.

--recipe rlcd trains with the published objective: sampled noisy logit groups scored by a proper scoring
rule and used as a policy-gradient signal, plus a full-weight soft cross-entropy. The published recipe
updates every weight; here it drives the LoRA weights only. --recipe ce is the plain soft cross-entropy
with a ranked-probability term that earlier adapters used. Both fit one temperature per question type on a
slice held out of the training rows (up to --calib-cap items or --calib-frac of them, fixed seed), stored
in the manifest.

An adapter is promoted only when it beats the pilot's live adapter (or the base model) on that
pilot's human test rows: higher exact accuracy, ties broken by lower negative log-likelihood.
--force skips the comparison. Every promotion and rollback is appended to the registry history,
and the serving wrapper reloads the registry on its next request, so no restart is needed.
"""

import hashlib
import json
import math
import os
import random
import sys
import time

import torch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lora  # noqa: E402
from ctxutil import load_base, load_english  # noqa: E402

from env import home  # noqa: E402

ROOT = home(HERE)                                  # LAYA_HOME, else the folder above the scripts
ADAPTERS = os.path.join(ROOT, "adapters")
REGISTRY = os.path.join(ADAPTERS, "registry.json")
DEFAULT_MAX_LEN = 512                              # the English checkpoint's shipped max_len


# ------------------------------------------------------------------ registry

def load_registry():
    if os.path.exists(REGISTRY):
        return json.load(open(REGISTRY, encoding="utf-8"))
    return {"pilots": {}, "history": []}


def save_registry(reg):
    os.makedirs(ADAPTERS, exist_ok=True)
    tmp = REGISTRY + ".tmp"
    json.dump(reg, open(tmp, "w", encoding="utf-8"), indent=1)
    os.replace(tmp, REGISTRY)   # atomic, so the server never reads a half-written file


def pilot_cfg(reg, pilot):
    return reg["pilots"].setdefault(pilot, {"adapter": None, "max_len": DEFAULT_MAX_LEN})


# ------------------------------------------------------------------ data

def read_rows(paths):
    rows = []
    for p in paths:
        rows += [json.loads(line) for line in open(p, encoding="utf-8") if line.strip()]
    return rows


def encode(agent, row, qname, max_len):
    qdef = row["questions"][qname]
    internal = {qname: agent._to_internal(qdef)}
    item = agent._encode_state(row["state"], [qname], internal, max_len=max_len)[0]
    q = internal[qname]
    k = len(item["markers"])
    if q["t"] == "noul":
        keys = [False, True]
    elif q["t"] == "choice":
        keys = list(q["crit"].keys())
    else:
        keys = list(range(k))
    return item, q["t"], keys


def target_vector(qtype, keys, row, qname):
    """One-hot (human) or soft (teacher) distribution over the question's options."""
    if qname in (row.get("labels") or {}):
        v = row["labels"][qname]
        if qtype == "score":
            v = int(v)
        t = [0.0] * len(keys)
        t[keys.index(v)] = 1.0
        return t
    s = row["soft"][qname]
    if qtype == "noul":
        return [1 - float(s), float(s)]
    return [float(s.get(str(k), 0.0)) for k in keys]


def temperature(agent, qtype, k):
    from laya.common import QTYPES, temp_bucket
    qt = QTYPES[qtype]
    if qtype in TEMP_OVERRIDE:
        return TEMP_OVERRIDE[qtype]
    return agent.temperature_by_options.get(temp_bucket(qt, k), agent.temperature[qt])


def forward_logits(agent, item):
    from laya.common import collate_items
    b = collate_items([[item]], agent.tok.pad_token_id)
    dev = agent.device
    logits, _ = agent.model(b["input_ids"].to(dev), b["attention_mask"].to(dev), b["marker_pos"].to(dev),
                            b["marker_mask"].to(dev), b["qtype"].to(dev))
    return logits[0, :len(item["markers"])]


CALIB_SEED = 20260922
TEMP_OVERRIDE = {}   # question type -> temperature fitted on the calibration slice, applied by evaluate


def provenance(row):
    if row.get("provenance"):
        return row["provenance"]
    return "human" if row.get("source") == "human" else "jev_teacher"


def _bucket(row_id):
    return int(hashlib.sha256(f"{CALIB_SEED}:{row_id}".encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


def split_calibration(examples_by_row, frac, cap):
    """Hold out whole rows for calibration: lowest hash buckets first, up to cap items or frac of all items."""
    total = sum(len(v) for v in examples_by_row.values())
    budget = min(cap, int(total * frac))
    calib, train, used = [], [], 0
    for rid in sorted(examples_by_row, key=_bucket):
        if used < budget:
            calib += examples_by_row[rid]
            used += len(examples_by_row[rid])
        else:
            train += examples_by_row[rid]
    return train, calib


@torch.no_grad()
def raw_logits(agent, calib):
    agent.model.eval()
    return [(qt, forward_logits(agent, item).float().cpu(), tgt) for item, qt, keys, tgt, _w in calib]


def fit_temperatures(rows):
    """One temperature per question type, by LBFGS on log-temperature against the soft targets. 1.0 under 10 items."""
    by_type = {}
    for qt, z, tgt in rows:
        by_type.setdefault(qt, []).append((z, torch.tensor(tgt)))
    out = {}
    for qt, items in by_type.items():
        if len(items) < 10:
            out[qt] = 1.0
            continue
        logt = torch.zeros(1, requires_grad=True)
        opt = torch.optim.LBFGS([logt], lr=0.5, max_iter=50)

        def closure():
            opt.zero_grad()
            t = logt.exp().clamp(0.1, 10.0)
            loss = sum(-(y * torch.log_softmax(z / t, -1)).sum() for z, y in items) / len(items)
            loss.backward()
            return loss
        opt.step(closure)
        out[qt] = round(float(logt.exp().clamp(0.1, 10.0)), 4)
    return out


def rlcd_loss(z, t, qtype, group=4, sigma=0.25, w_sph=0.75, w_rps=1.0):
    """Published objective for one question: policy gradient on noisy logit groups plus soft cross-entropy.
    z: [K] logits (with grad), t: [K] target distribution."""
    from laya.common import QTYPES, proper_reward
    k = z.shape[0]
    mask = torch.ones(1, k, dtype=torch.bool, device=z.device)
    zz = z.unsqueeze(0)
    eps = torch.randn((group, 1, k), device=z.device) * sigma
    eps = eps - eps.mean(-1, keepdim=True)
    noisy = zz.detach().unsqueeze(0) + eps
    q = torch.softmax(noisy, -1)
    qt = torch.tensor([QTYPES[qtype]], device=z.device)
    with torch.no_grad():
        r = proper_reward(q, t.view(1, 1, k), qt, mask, w_sph=w_sph, w_rps=w_rps)
        adv = (r - r.mean(0, keepdim=True)) / (r.std() + 1e-6)
    logp = -((noisy - zz.unsqueeze(0)) ** 2).sum(-1) / (2 * sigma ** 2)
    loss_rl = -(adv * logp).mean()
    loss_ce = -(t * torch.log_softmax(z, -1)).sum()
    return loss_rl + loss_ce


# ------------------------------------------------------------------ evaluation

@torch.no_grad()
def evaluate(agent, rows, max_len):
    """Per pilot/question metrics on labelled test rows: exact, within-one (score), NLL, ECE."""
    agent.model.eval()
    acc = {}
    human_pilots = {r["pilot"] for r in rows if r.get("source") == "human"}
    for row in rows:
        src = row.get("source")
        if not (src == "human" or (src == "teacher_test" and row["pilot"] not in human_pilots)):
            continue
        for qname in row["labels"]:
            item, qtype, keys = encode(agent, row, qname, max_len)
            z = forward_logits(agent, item).float() / temperature(agent, qtype, len(keys))
            p = torch.softmax(z, -1).cpu().tolist()
            truth = keys.index(int(row["labels"][qname]) if qtype == "score" else row["labels"][qname])
            top = max(range(len(p)), key=p.__getitem__)
            a = acc.setdefault(f"{row['pilot']}/{qname}", {"n": 0, "exact": 0, "within1": 0, "nll": 0.0, "conf": [], "ok": []})
            a["n"] += 1
            a["exact"] += int(top == truth)
            a["within1"] += int(abs(top - truth) <= 1) if qtype == "score" else int(top == truth)
            a["nll"] -= math.log(max(p[truth], 1e-9))
            a["conf"].append(p[top])
            a["ok"].append(top == truth)
    out = {}
    for key, a in acc.items():
        out[key] = {"n": a["n"], "exact": round(a["exact"] / a["n"], 3), "within1": round(a["within1"] / a["n"], 3),
                    "nll": round(a["nll"] / a["n"], 4), "ece": round(_ece(a["conf"], a["ok"]), 3)}
    return out


def _ece(conf, ok, bins=10):
    total = 0.0
    for b in range(bins):
        idx = [i for i, c in enumerate(conf) if b / bins <= c < (b + 1) / bins or (b == bins - 1 and c == 1.0)]
        if idx:
            total += len(idx) * abs(sum(ok[i] for i in idx) / len(idx) - sum(conf[i] for i in idx) / len(idx))
    return total / max(1, len(conf))


def activate(agent, name):
    """name: None/'base' for the base model, else an adapter directory name under adapters/."""
    if name in (None, "base", "none"):
        lora.set_active(agent.model, None)
        return None
    lora.load_adapter(agent.model, name, os.path.join(ADAPTERS, name))
    lora.set_active(agent.model, name)
    return name


# ------------------------------------------------------------------ commands

def _opt(args, name, default, cast=str):
    return cast(args[args.index(name) + 1]) if name in args else default


def cmd_train(args):
    data = [args[i + 1] for i, a in enumerate(args) if a == "--data"]
    name = _opt(args, "--name", None)
    if not data or not name:
        sys.exit("train needs --data and --name")
    rank, alpha = _opt(args, "--rank", 8, int), _opt(args, "--alpha", 16.0, float)
    lr, epochs = _opt(args, "--lr", 3e-4, float), _opt(args, "--epochs", 6, int)
    max_len, accum = _opt(args, "--max-len", 1024, int), _opt(args, "--accum", 8, int)
    teacher_w, seed = _opt(args, "--teacher-weight", 0.5, float), _opt(args, "--seed", 7, int)
    include_scorer = "--no-scorer" not in args
    recipe = _opt(args, "--recipe", "ce")
    base_name = _opt(args, "--base", "english")
    exclude = {args[i + 1] for i, a in enumerate(args) if a == "--exclude-provenance"}
    calib_frac, calib_cap = _opt(args, "--calib-frac", 0.1, float), _opt(args, "--calib-cap", 400, int)
    do_calib = "--no-calib" not in args
    if recipe not in ("ce", "rlcd"):
        sys.exit("--recipe is ce or rlcd")
    amp = "--amp" in args   # bf16 autocast: faster at long max_len, fp32 is the safe default
    out_dir = os.path.join(ADAPTERS, name)
    if os.path.exists(out_dir):
        sys.exit(f"adapter {name} already exists; adapters are immutable, pick a new name")

    random.seed(seed)
    torch.manual_seed(seed)
    rows = read_rows(data)
    dropped = sum(1 for r in rows if provenance(r) in exclude)
    rows = [r for r in rows if provenance(r) not in exclude]
    train_rows = [r for r in rows if r["split"] == "train"]
    test_rows = [r for r in rows if r["split"] == "test"]
    mix = {}
    for r in train_rows:
        mix[provenance(r)] = mix.get(provenance(r), 0) + 1
    pilots = sorted({r["pilot"] for r in rows})

    agent = load_base(base_name)
    fingerprint = lora.base_fingerprint(agent.model)
    TEMP_OVERRIDE.clear()
    for p in agent.model.parameters():
        p.requires_grad_(False)
    lora.wrap(agent.model, include_scorer=include_scorer)
    lora.add_adapter(agent.model, name, rank=rank, alpha=alpha, dropout=0.0)
    lora.set_active(agent.model, name)
    params = list(lora.adapter_parameters(agent.model, name))
    for p in params:
        p.requires_grad_(True)
    n_params = sum(p.numel() for p in params)
    opt = torch.optim.AdamW(params, lr=lr, weight_decay=0.01)

    # Pre-encode once: (item, qtype, keys, target, weight)
    by_row = {}
    for r in train_rows:
        for qname in set(r.get("labels") or {}) | set(r.get("soft") or {}):
            item, qtype, keys = encode(agent, r, qname, max_len)
            w = 1.0 if provenance(r) != "jev_teacher" else teacher_w
            by_row.setdefault(r["id"], []).append((item, qtype, keys, target_vector(qtype, keys, r, qname), w))
    if do_calib:
        examples, calib = split_calibration(by_row, calib_frac, calib_cap)
    else:
        examples, calib = [e for v in by_row.values() for e in v], []
    total_steps = max(1, math.ceil(len(examples) * epochs / accum))
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / max(1, total_steps // 10))
                                              * max(0.0, 1 - s / total_steps))
    print(json.dumps({"adapter": name, "train_examples": len(examples), "test_rows": len(test_rows),
                      "calibration_examples": len(calib), "trainable_params": n_params, "pilots": pilots,
                      "recipe": recipe, "base": base_name, "provenance": mix, "excluded_rows": dropped}), flush=True)

    t0 = time.time()
    agent.model.eval()   # base stays in eval mode (the head's dropout off); only LoRA weights learn
    step = 0
    for ep in range(epochs):
        random.shuffle(examples)
        running = 0.0
        opt.zero_grad()
        for i, (item, qtype, keys, tgt, w) in enumerate(examples):
            if amp:
                with torch.autocast(agent.device.type if hasattr(agent.device, "type") else str(agent.device).split(":")[0], dtype=torch.bfloat16):
                    z = forward_logits(agent, item)
            else:
                z = forward_logits(agent, item)
            z = z.float() / temperature(agent, qtype, len(keys))
            logp = torch.log_softmax(z, -1)
            t = torch.tensor(tgt, device=z.device)
            loss = -(t * logp).sum()
            if recipe == "rlcd":
                loss = rlcd_loss(z, t, qtype)
            elif qtype == "score":   # ranked probability score keeps the ordinal structure
                cdf_p, cdf_t = torch.cumsum(logp.exp(), -1), torch.cumsum(t, -1)
                loss = loss + ((cdf_p - cdf_t) ** 2).sum() / max(1, len(keys) - 1)
            (loss * w / accum).backward()
            running += float(loss)
            if (i + 1) % accum == 0 or i + 1 == len(examples):
                torch.nn.utils.clip_grad_norm_(params, 1.0)
                opt.step()
                sched.step()
                opt.zero_grad()
                step += 1
        print(json.dumps({"epoch": ep + 1, "loss": round(running / max(1, len(examples)), 4),
                          "minutes": round((time.time() - t0) / 60, 1)}), flush=True)

    temps = fit_temperatures(raw_logits(agent, calib)) if calib else {}
    TEMP_OVERRIDE.update(temps)
    metrics = evaluate(agent, test_rows, max_len)
    TEMP_OVERRIDE.clear()
    lora.set_active(agent.model, None)
    base_metrics = evaluate(agent, test_rows, max_len)
    manifest = {
        "name": name, "created": time.strftime("%Y-%m-%dT%H:%M:%S"), "base": f"convaiinnovations/laya:{base_name}",
        "recipe": recipe, "provenance": mix, "excluded_provenance": sorted(exclude), "temperature_by_type": temps,
        "n_calibration_examples": len(calib),
        "base_fingerprint": fingerprint, "rank": rank, "alpha": alpha, "include_scorer": include_scorer,
        "lr": lr, "epochs": epochs, "accum": accum, "max_len": max_len, "teacher_weight": teacher_w, "seed": seed,
        "pilots": pilots, "data": [{"file": os.path.basename(d), "sha256": _sha(d)} for d in data],
        "n_train_examples": len(examples), "n_test_rows": len(test_rows), "trainable_params": n_params,
        "train_minutes": round((time.time() - t0) / 60, 1),
        "train_ids": sorted({r["id"] for r in train_rows}),
        "test_metrics": metrics, "base_test_metrics": base_metrics,
    }
    lora.save_adapter(agent.model, name, out_dir, manifest)
    print(json.dumps({"saved": out_dir, "test": metrics, "base_on_same_test": base_metrics}, indent=1))


def _sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()[:16]


def cmd_eval(args):
    data = [args[i + 1] for i, a in enumerate(args) if a == "--data"]
    which = _opt(args, "--adapter", "live")
    rows = [r for r in read_rows(data) if r["split"] == "test"]
    agent = load_english()
    reg = load_registry()
    out = {}
    for pilot in sorted({r["pilot"] for r in rows}):
        cfg = pilot_cfg(reg, pilot)
        name = cfg["adapter"] if which == "live" else which
        max_len = _opt(args, "--max-len", None, int) or _adapter_max_len(name) or cfg["max_len"]
        activate(agent, name)
        out[pilot] = {"adapter": name or "base", "max_len": max_len,
                      "metrics": evaluate(agent, [r for r in rows if r["pilot"] == pilot], max_len)}
    print(json.dumps(out, indent=1))


def _adapter_max_len(name):
    if name in (None, "base", "none"):
        return None
    return json.load(open(os.path.join(ADAPTERS, name, "manifest.json"), encoding="utf-8")).get("max_len")


def cmd_status(_args):
    reg = load_registry()
    names = sorted(d for d in os.listdir(ADAPTERS) if os.path.isdir(os.path.join(ADAPTERS, d))) if os.path.isdir(ADAPTERS) else []
    adapters = {}
    for n in names:
        m = json.load(open(os.path.join(ADAPTERS, n, "manifest.json"), encoding="utf-8"))
        adapters[n] = {k: m.get(k) for k in ("created", "pilots", "rank", "alpha", "epochs", "max_len",
                                            "n_train_examples", "n_test_rows", "test_metrics", "base_test_metrics")}
    print(json.dumps({"registry": reg["pilots"], "adapters": adapters, "history": reg["history"][-10:]}, indent=1))


def _score(m):
    return (m["exact"], -m["nll"])


def cmd_promote(args):
    name, pilot = args[0], _opt(args, "--pilot", None)
    if not pilot:
        sys.exit("promote needs --pilot")
    m = json.load(open(os.path.join(ADAPTERS, name, "manifest.json"), encoding="utf-8"))
    reg = load_registry()
    cfg = pilot_cfg(reg, pilot)
    if "--force" not in args:
        # Re-evaluate candidate and incumbent on the SAME current test rows: the incumbent's own
        # manifest numbers came from an older, smaller test set.
        data = [os.path.join(ROOT, "data", d["file"]) for d in m["data"]]
        rows = [r for r in read_rows(data) if r["split"] == "test" and r["pilot"] == pilot]
        agent = load_english()
        activate(agent, name)
        cand = evaluate(agent, rows, m["max_len"])
        activate(agent, cfg["adapter"])
        inc = evaluate(agent, rows, _adapter_max_len(cfg["adapter"]) or cfg["max_len"])
        verdict = {}
        for q in cand:
            verdict[q] = {"candidate": cand[q], "incumbent": inc.get(q)}
        wins = [q for q in cand if inc.get(q) is None or _score(cand[q]) > _score(inc[q])]
        losses = [q for q in cand if inc.get(q) is not None and _score(cand[q]) < _score(inc[q])]
        print(json.dumps({"incumbent": cfg["adapter"] or "base", "comparison": verdict}, indent=1))
        if losses or not wins:
            sys.exit(f"not promoted: {name} does not beat {cfg['adapter'] or 'base'} on {pilot}'s test rows")
    reg["history"].append({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "pilot": pilot, "action": "promote",
                           "from": cfg["adapter"], "to": name, "forced": "--force" in args})
    cfg["adapter"] = name
    cfg["max_len"] = m["max_len"]
    save_registry(reg)
    print(json.dumps({"promoted": name, "pilot": pilot, "max_len": m["max_len"]}))


def cmd_rollback(args):
    pilot = _opt(args, "--pilot", None)
    reg = load_registry()
    cfg = pilot_cfg(reg, pilot)
    prior = [h for h in reg["history"] if h["pilot"] == pilot and h["action"] == "promote" and h["to"] == cfg["adapter"]]
    if not prior:
        sys.exit(f"nothing to roll back for {pilot}")
    back_to = prior[-1]["from"]
    reg["history"].append({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "pilot": pilot, "action": "rollback",
                           "from": cfg["adapter"], "to": back_to})
    cfg["adapter"] = back_to
    cfg["max_len"] = _adapter_max_len(back_to) or cfg["max_len"]
    save_registry(reg)
    print(json.dumps({"rolled_back": pilot, "now": back_to or "base"}))


def cmd_set(args):
    reg = load_registry()
    if "--hard-max-len" in args:
        before = reg.get("hard_max_len")
        reg["hard_max_len"] = _opt(args, "--hard-max-len", None, int)
        reg["history"].append({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "pilot": "*", "action": "set",
                               "from": {"hard_max_len": before}, "to": {"hard_max_len": reg["hard_max_len"]}})
        save_registry(reg)
        print(json.dumps({"hard_max_len": reg["hard_max_len"]}))
        return
    pilot = _opt(args, "--pilot", None)
    cfg = pilot_cfg(reg, pilot)
    before = dict(cfg)
    if "--max-len" in args:
        cfg["max_len"] = _opt(args, "--max-len", None, int)
        cap = int(reg.get("hard_max_len") or 4096)
        if cfg["max_len"] > cap:
            sys.exit(f"--max-len {cfg['max_len']} is over the server cap {cap}; raise it with: set --hard-max-len N")
    if "--adapter" in args:
        a = _opt(args, "--adapter", None)
        cfg["adapter"] = None if a in ("none", "base") else a
    reg["history"].append({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "pilot": pilot, "action": "set",
                           "from": before, "to": dict(cfg)})
    save_registry(reg)
    print(json.dumps({pilot: cfg}))


if __name__ == "__main__":
    cmds = {"train": cmd_train, "eval": cmd_eval, "status": cmd_status, "promote": cmd_promote,
            "rollback": cmd_rollback, "set": cmd_set}
    if len(sys.argv) < 2 or sys.argv[1] not in cmds:
        sys.exit(__doc__)
    cmds[sys.argv[1]](sys.argv[2:])
