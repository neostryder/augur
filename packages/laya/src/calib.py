"""Calibration helpers shared by the trainer and the server. No torch and no laya import, so they run anywhere.

An adapter's manifest holds one fitted temperature per question type. Both the trainer's evaluation and the
server apply it on top of that adapter's logits, clamped to the range Laya's own loader enforces, so the
confidence a caller reads is the calibrated one. A type fitted on too few items is left out and keeps the base
checkpoint's temperature.
"""

import math

TEMP_MIN = 0.5
TEMP_MAX = 5.0
MIN_FIT_ITEMS = 50          # a temperature fitted on fewer items of a type is noise, so none is stored
# Collapse to the class prior (a near-constant logit, or cross-entropy stuck at ln K) looks like a finished run.
COLLAPSE_LOGIT_RANGE = 0.05
COLLAPSE_CE_REL = 0.02
SIGMA_START = 0.4           # rlcd noise, annealed over the run
SIGMA_END = 0.1


def clamp_temperature(t):
    if isinstance(t, bool):
        return 1.0
    try:
        t = float(t)
    except (TypeError, ValueError):
        return 1.0
    if not math.isfinite(t):
        return 1.0
    return min(TEMP_MAX, max(TEMP_MIN, t))


def manifest_temperatures(manifest):
    """{question type: temperature} an adapter was fitted with, clamped. Empty when it has none."""
    raw = (manifest or {}).get("temperature_by_type") or {}
    return {qt: clamp_temperature(v) for qt, v in raw.items()}


def apply_temperatures(base_temperature, base_by_options, fitted, qtype_index):
    """The temperature list and bucket map a model should use under `fitted`.

    base_temperature: three floats indexed by question type. base_by_options: bucket ("choice:3-5") -> float.
    A fitted type replaces its entry in the list and drops its buckets; other types keep the base values.
    """
    temperature = list(base_temperature)
    by_options = dict(base_by_options)
    for qt, value in fitted.items():
        if qt not in qtype_index:
            continue
        temperature[qtype_index[qt]] = value
        for bucket in [b for b in by_options if b.split(":", 1)[0] == qt]:
            del by_options[bucket]
    return temperature, by_options


def sigma_at(step, total, start=SIGMA_START, end=SIGMA_END):
    frac = 0.0 if total <= 0 else min(1.0, max(0.0, step / total))
    return start + (end - start) * frac


def collapse_stats(records):
    """Mean within-row logit range, mean cross-entropy and mean ln K over (type, logits, target) records."""
    ranges, ces, lnks = [], [], []
    for _qt, logits, target in records:
        z = [float(x) for x in logits]
        t = [float(x) for x in target]
        k = min(len(z), len(t))
        if k < 2:
            continue
        z, t = z[:k], t[:k]
        mass = sum(t)
        if mass <= 0.0:
            continue
        top = max(z)
        log_norm = top + math.log(sum(math.exp(x - top) for x in z))
        ces.append(-sum((ti / mass) * (zi - log_norm) for zi, ti in zip(z, t)))
        ranges.append(max(z) - min(z))
        lnks.append(math.log(k))
    if not ranges:
        return None
    n = len(ranges)
    return {"n": n, "mean_logit_range": sum(ranges) / n, "mean_ce": sum(ces) / n, "mean_ln_k": sum(lnks) / n}


def collapse_message(stats):
    """A warning when predictions have collapsed to the class prior, else None."""
    if not stats:
        return None
    reasons = []
    if stats["mean_logit_range"] < COLLAPSE_LOGIT_RANGE:
        reasons.append(f"mean within-row logit range {stats['mean_logit_range']:.3g}")
    ln_k = stats["mean_ln_k"]
    if ln_k > 0 and abs(stats["mean_ce"] - ln_k) <= COLLAPSE_CE_REL * ln_k:
        reasons.append(f"cross-entropy {stats['mean_ce']:.3f} is within {COLLAPSE_CE_REL * 100:.0f}% of ln K ~ {ln_k:.3f}")
    if not reasons:
        return None
    return ("predictions collapsed to the class prior (" + "; ".join(reasons) + "). Try more epochs or data, another seed, "
            "or run a --label-tag positive control: if that learns, the run is fine and the task is the hard part.")


def label_tag(row):
    """The prefix that spells a row's answers, for the positive control. Soft-only rows spell their top option."""
    parts = []
    for q, v in (row.get("labels") or {}).items():
        parts.append(f"label[{q}]={v}")
    for q, s in (row.get("soft") or {}).items():
        if q in (row.get("labels") or {}):
            continue
        if isinstance(s, dict) and s:
            parts.append(f"label[{q}]={max(s, key=lambda k: float(s[k]))}")
        elif isinstance(s, (int, float)):
            parts.append(f"label[{q}]={'true' if float(s) >= 0.5 else 'false'}")
    return "; ".join(parts) + "; " if parts else ""


def tag_state(row):
    """The row's state with its answer tag attached where truncation keeps it (the end of a turn list, else the front)."""
    tag, state = label_tag(row), row["state"]
    if not tag:
        return state
    if isinstance(state, str):
        return tag + state
    if isinstance(state, dict):
        return {"label_tag": tag.strip(), **state}
    if isinstance(state, list):
        return list(state) + [tag.strip()]
    return state
