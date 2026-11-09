"""Promotion gate for Laya LoRA adapters: accuracy plus calibration, with no torch dependency.

`summarize` turns one question's per-row predictions into the metrics the gate reads. `decide` compares a
candidate against the incumbent on the same rows and returns a promote or hold verdict with the reasons.

A prediction record is `(probs, truth)`: the softmax over the question's options and the index of the true
option, in the order the rows were exported (oldest first).

Metrics per question: n, exact, within1, nll, ece, brier (multiclass, summed over options, 0 is perfect),
reliability (ten confidence bins), by_class (recall and mean confidence for each true option), aurc (area
under the risk-coverage curve, lower is better: rows sorted by confidence, error rate over the most
confident k rows averaged over k), and late (exact, brier and n on the newest half of the rows, the check
for data that has moved on from the older half).
"""
import math

BINS = 10
MIN_LATE = 40


def ece(conf, ok, bins=BINS):
    total = 0.0
    for b in range(bins):
        idx = [i for i, c in enumerate(conf) if b / bins <= c < (b + 1) / bins or (b == bins - 1 and c == 1.0)]
        if idx:
            total += len(idx) * abs(sum(ok[i] for i in idx) / len(idx) - sum(conf[i] for i in idx) / len(idx))
    return total / max(1, len(conf))


def brier(records):
    if not records:
        return 0.0
    total = 0.0
    for p, truth in records:
        total += sum((pi - (1.0 if i == truth else 0.0)) ** 2 for i, pi in enumerate(p))
    return total / len(records)


def aurc(records):
    """Mean error rate over every coverage level when the most confident rows are answered first."""
    if not records:
        return 0.0
    order = sorted(records, key=lambda r: -max(r[0]))
    wrong, area = 0, 0.0
    for k, (p, truth) in enumerate(order, 1):
        wrong += int(max(range(len(p)), key=p.__getitem__) != truth)
        area += wrong / k
    return area / len(order)


def reliability(conf, ok, bins=BINS):
    out = []
    for b in range(bins):
        idx = [i for i, c in enumerate(conf) if b / bins <= c < (b + 1) / bins or (b == bins - 1 and c == 1.0)]
        if idx:
            out.append({"lo": b / bins, "hi": (b + 1) / bins, "n": len(idx),
                        "confidence": round(sum(conf[i] for i in idx) / len(idx), 3),
                        "accuracy": round(sum(ok[i] for i in idx) / len(idx), 3)})
    return out


def summarize(records, ordered=False, seconds=None):
    """Metrics for one question from its prediction records. `ordered` is true for score questions."""
    n = len(records)
    if not n:
        return {"n": 0}
    tops = [max(range(len(p)), key=p.__getitem__) for p, _ in records]
    ok = [t == truth for t, (_, truth) in zip(tops, records)]
    conf = [p[t] for t, (p, _) in zip(tops, records)]
    within1 = sum(abs(t - truth) <= 1 if ordered else t == truth for t, (_, truth) in zip(tops, records))
    classes = {}
    for t, (p, truth), c in zip(tops, records, conf):
        k = classes.setdefault(truth, {"n": 0, "hit": 0, "conf": 0.0})
        k["n"] += 1
        k["hit"] += int(t == truth)
        k["conf"] += c
    out = {"n": n, "exact": round(sum(ok) / n, 3), "within1": round(within1 / n, 3),
           "nll": round(-sum(math.log(max(p[truth], 1e-9)) for p, truth in records) / n, 4),
           "ece": round(ece(conf, ok), 3), "brier": round(brier(records), 4), "aurc": round(aurc(records), 4),
           "reliability": reliability(conf, ok),
           "by_class": {str(k): {"n": v["n"], "recall": round(v["hit"] / v["n"], 3),
                                 "confidence": round(v["conf"] / v["n"], 3)} for k, v in sorted(classes.items())}}
    half = n // 2
    if n - half >= MIN_LATE:
        late, late_ok = records[half:], ok[half:]
        out["late"] = {"n": len(late), "exact": round(sum(late_ok) / len(late), 3), "brier": round(brier(late), 4)}
    if seconds is not None:
        out["ms_per_row"] = round(1000.0 * seconds / n, 1)
    return out


def _score(m):
    return (m["exact"], -m["nll"])


def decide(cand, inc, margin=0.03, brier_tol=0.01, ece_tol=0.03, min_n=300, require_n=0):
    """Compare candidate and incumbent metrics (dicts keyed by question) measured on the same rows.

    A question is a win when the candidate beats the incumbent's exact match by at least `margin`, or keeps
    exact match level and cuts Brier by at least `brier_tol`. It is a loss when exact match or NLL falls, or
    Brier rises by more than `brier_tol`, or ECE rises by more than `ece_tol`, or Brier on the newest half
    of the rows rises by more than twice `brier_tol`. A question with no incumbent is a win. Promotion needs
    a win and no loss. A question with fewer than `min_n` rows is reported as underpowered; `require_n`
    makes that a loss. Returns {"promote", "wins", "losses", "underpowered", "questions"}."""
    wins, losses, underpowered, questions = [], [], [], {}
    for q, c in cand.items():
        i = inc.get(q)
        why = []
        if c.get("n", 0) < min_n:
            underpowered.append(q)
            if require_n and c.get("n", 0) < require_n:
                losses.append(q)
                why.append(f"only {c.get('n', 0)} rows, {require_n} required")
        if i is None or not i.get("n"):
            if not why:
                wins.append(q)
            questions[q] = {"verdict": "loss" if why else "win", "why": ["no incumbent"] + why}
            continue
        loss = []
        if _score(c) < _score(i):
            loss.append(f"exact {c['exact']} / nll {c['nll']} below incumbent {i['exact']} / {i['nll']}")
        if "brier" in c and "brier" in i:
            if c["brier"] - i["brier"] > brier_tol:
                loss.append(f"brier {c['brier']} worse than {i['brier']}")
            if c["ece"] - i["ece"] > ece_tol:
                loss.append(f"ece {c['ece']} worse than {i['ece']}")
            if "late" in c and "late" in i and c["late"]["brier"] - i["late"]["brier"] > 2 * brier_tol:
                loss.append(f"newest-half brier {c['late']['brier']} worse than {i['late']['brier']}")
        win = c["exact"] - i["exact"] >= margin and _score(c) > _score(i)
        if not win and "brier" in c and "brier" in i:
            win = c["exact"] >= i["exact"] and i["brier"] - c["brier"] >= brier_tol
        if loss or why:
            if q not in losses:
                losses.append(q)
            questions[q] = {"verdict": "loss", "why": loss + why}
        elif win:
            wins.append(q)
            questions[q] = {"verdict": "win", "why": []}
        else:
            questions[q] = {"verdict": "level", "why": []}
    return {"promote": bool(wins) and not losses, "wins": wins, "losses": losses,
            "underpowered": underpowered, "questions": questions}
