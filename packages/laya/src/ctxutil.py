"""Shared helpers: load the English Laya checkpoint standalone, run questions one sequence at a time
for long contexts, and optionally switch the global-attention RoPE to YaRN scaling."""

import copy

import torch

# Above this many tokens each question runs in its own forward pass. Laya normally packs every
# question of a request into one batch; at long lengths the attention buffers of several
# sequences at once no longer fit in the M4's 16 GB of unified memory.
LONG_CONTEXT = 1024


def load_english(device=None):
    from laya.router import Router
    from env import device as pick_device
    router = Router(device=device or pick_device())
    return router.load("english")


def load_base(name="english", device=None):
    """The checkpoint an adapter is trained on: english, multilingual or typed-decisions."""
    from laya.router import Router
    from env import device as pick_device
    return Router(device=device or pick_device()).load(name)


def predict_split(agent, state, questions, max_len=None):
    """agent.system_one, but one question per forward pass once max_len exceeds LONG_CONTEXT.
    Returns the answers dict."""
    if not max_len or max_len <= LONG_CONTEXT or len(questions) == 1:
        return agent.system_one(state, questions, max_len=max_len)["answers"]
    answers = {}
    for name, q in questions.items():
        answers.update(agent.system_one(state, {name: q}, max_len=max_len)["answers"])
    return answers


def apply_rope(agent, mode):
    """mode 'yarnN' rescales only the full-attention layers' RoPE by factor N with YaRN, keeping
    the sliding-window layers (128-token local attention) exactly as trained."""
    from transformers.models.modernbert.modeling_modernbert import ModernBertRotaryEmbedding
    if not mode.startswith("yarn"):
        raise ValueError(mode)
    factor = float(mode[4:] or 2)
    enc = agent.model.encoder
    cfg = copy.deepcopy(enc.config)
    rp = dict(cfg.rope_parameters)
    full = dict(rp["full_attention"])
    full.update({"rope_type": "yarn", "factor": factor,
                 "original_max_position_embeddings": cfg.max_position_embeddings})
    rp["full_attention"] = full
    cfg.rope_parameters = rp
    cfg.max_position_embeddings = int(cfg.max_position_embeddings * factor)
    dev = next(enc.parameters()).device
    enc.rotary_emb = ModernBertRotaryEmbedding(config=cfg, device=dev)
    enc.config = cfg
    return cfg
