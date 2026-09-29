"""Where the Laya data lives and which device runs it. Shared by the server and the trainer."""

import os


def home(script_dir: str) -> str:
    """LAYA_HOME holds adapters/, data/ and logs/. Without it the folder above the scripts is used, which is how the Mac mini is laid out."""
    return os.environ.get("LAYA_HOME") or os.path.dirname(script_dir)


def device() -> str:
    """LAYA_DEVICE if set, else CUDA, else Apple's GPU, else the CPU."""
    want = (os.environ.get("LAYA_DEVICE") or "").strip()
    if want:
        return want
    import torch
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"
