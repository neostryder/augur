"""Dependency-free LoRA for Laya's DecisionModel.

Every targeted nn.Linear is replaced by a LoRALinear that keeps the frozen base weight and any
number of named adapters beside it. One adapter (or none) is active at a time, switched per
request by set_active(), so one loaded base model serves every adapter without reloading.

Targets: the ModernBERT encoder's attn.Wqkv, attn.Wo, mlp.Wi and mlp.Wo in every layer, plus
the two Linear layers of the decision scorer. The head's nn.TransformerEncoderLayer blocks are
left alone on purpose: in eval mode PyTorch can route them through a fused fast path that reads
linear weights directly and would silently skip an adapter.

An adapter on disk is a directory holding adapter.safetensors (lora_A / lora_B per module) and
manifest.json (rank, alpha, targets, data mix, metrics, base checkpoint fingerprint).
"""

import json
import os
import re

import torch
import torch.nn as nn

ENCODER_TARGETS = re.compile(r"^encoder\.layers\.\d+\.(attn\.Wqkv|attn\.Wo|mlp\.Wi|mlp\.Wo)$")
SCORER_TARGETS = re.compile(r"^scorer\.(1|3)$")


class LoRALinear(nn.Module):
    def __init__(self, base: nn.Linear):
        super().__init__()
        self.base = base
        self.adapters = nn.ModuleDict()
        self.scales = {}
        self.active = None

    # Keep attribute access that other code does on the replaced Linear working.
    @property
    def weight(self):
        return self.base.weight

    @property
    def bias(self):
        return self.base.bias

    def add(self, name, rank, alpha, dropout=0.0):
        a = nn.Linear(self.base.in_features, rank, bias=False)
        b = nn.Linear(rank, self.base.out_features, bias=False)
        nn.init.kaiming_uniform_(a.weight, a=5 ** 0.5)
        nn.init.zeros_(b.weight)
        dev, dt = self.base.weight.device, self.base.weight.dtype
        self.adapters[name] = nn.Sequential(nn.Dropout(dropout), a, b).to(dev, dt)
        self.scales[name] = alpha / rank

    def forward(self, x):
        y = self.base(x)
        if self.active is not None and self.active in self.adapters:
            y = y + self.adapters[self.active](x.to(self.base.weight.dtype)) * self.scales[self.active]
        return y


def _targets(model, include_scorer=True):
    for name, mod in model.named_modules():
        if isinstance(mod, nn.Linear) and (ENCODER_TARGETS.match(name) or (include_scorer and SCORER_TARGETS.match(name))):
            yield name, mod


def wrap(model, include_scorer=True):
    """Replace target Linears with LoRALinear in place. Idempotent. Returns {name: LoRALinear}."""
    wrapped = {n: m for n, m in model.named_modules() if isinstance(m, LoRALinear)}
    if wrapped:
        return wrapped
    for name, lin in list(_targets(model, include_scorer)):
        parent_name, _, child = name.rpartition(".")
        parent = model.get_submodule(parent_name) if parent_name else model
        w = LoRALinear(lin)
        setattr(parent, child, w)
        wrapped[name] = w
    return wrapped


def lora_modules(model):
    return {n: m for n, m in model.named_modules() if isinstance(m, LoRALinear)}


def add_adapter(model, name, rank=8, alpha=16, dropout=0.05):
    for m in lora_modules(model).values():
        m.add(name, rank, alpha, dropout)


def set_active(model, name):
    """Activate adapter `name` everywhere, or None for the untouched base model."""
    for m in lora_modules(model).values():
        m.active = name if (name is not None and name in m.adapters) else None


def adapter_parameters(model, name):
    for m in lora_modules(model).values():
        if name in m.adapters:
            yield from m.adapters[name].parameters()


def save_adapter(model, name, out_dir, manifest):
    from safetensors.torch import save_file
    os.makedirs(out_dir, exist_ok=True)
    tensors = {}
    for mname, m in lora_modules(model).items():
        if name in m.adapters:
            seq = m.adapters[name]
            tensors[f"{mname}.lora_A"] = seq[1].weight.detach().float().cpu().contiguous()
            tensors[f"{mname}.lora_B"] = seq[2].weight.detach().float().cpu().contiguous()
    save_file(tensors, os.path.join(out_dir, "adapter.safetensors"))
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)


def load_adapter(model, name, adapter_dir):
    """Load an adapter directory under `name`. Wraps the model first if needed."""
    from safetensors.torch import load_file
    manifest = json.load(open(os.path.join(adapter_dir, "manifest.json"), encoding="utf-8"))
    wrap(model, include_scorer=manifest.get("include_scorer", True))
    tensors = load_file(os.path.join(adapter_dir, "adapter.safetensors"))
    mods = lora_modules(model)
    rank, alpha = manifest["rank"], manifest["alpha"]
    for m in mods.values():
        if name in m.adapters:
            del m.adapters[name]
        m.add(name, rank, alpha, 0.0)
    seen = set()
    for key, t in tensors.items():
        mname, part = key.rsplit(".", 1)
        if mname not in mods:
            raise ValueError(f"adapter {adapter_dir} targets {mname}, which this model does not have")
        seq = mods[mname].adapters[name]
        (seq[1] if part == "lora_A" else seq[2]).weight.data.copy_(t.to(seq[1].weight.device, seq[1].weight.dtype))
        seen.add(mname)
    # Modules the adapter file does not cover stay at zero (B = 0), so they are a no-op.
    for mname, m in mods.items():
        if mname not in seen:
            nn.init.zeros_(m.adapters[name][2].weight)
    return manifest


def base_fingerprint(model):
    """Cheap identity of the frozen base weights, so an adapter refuses a different base."""
    h = 0.0
    for n, p in model.named_parameters():
        if ".adapters." in n:
            continue
        h += float(p.detach().float().flatten()[:64].sum())
    return round(h, 4)
