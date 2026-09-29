"""Steps aside when something else is using the GPU.

A watcher samples the card once a second. The card counts as busy when the median of the last five
utilization readings, or the video memory in use by other processes, is over LAYA_BUSY_PCT (80).
While it is busy, /v1/systemone answers 503 with Retry-After, so a client moves to its next server,
and after LAYA_BUSY_UNLOAD_S (30) seconds of it the checkpoints leave video memory. The card counts as
free again when both readings stay ten points under the limit for LAYA_FREE_S (10) seconds, and the
checkpoint comes back. Utilization is not read while a request of ours is running, because our own
work would otherwise count against us. Anything that is not a CUDA device is never busy.

GET /load reports the same state for a client that wants to choose a server before it asks.
"""

import json
import os
import statistics
import threading
import time

CONTEXT_BYTES = 400 * 1024 * 1024   # what a CUDA context holds besides our tensors


class LoadWatch:
    def __init__(self, device, on_unload=None, on_reload=None):
        self.device = str(device)
        self.limit = float(os.environ.get("LAYA_BUSY_PCT", "80"))
        self.margin = 10.0
        self.unload_after = float(os.environ.get("LAYA_BUSY_UNLOAD_S", "30"))
        self.free_after = float(os.environ.get("LAYA_FREE_S", "10"))
        self.on_unload, self.on_reload = on_unload, on_reload
        self.inflight = 0
        self.lock = threading.Lock()
        self.util = []
        self.gpu_util = None
        self.vram_other_pct = None
        self.busy = False
        self.reasons = []
        self.unloaded = False
        self._busy_since = None
        self._free_since = None
        self._nvml = None
        self.enabled = self.device.startswith("cuda")
        if self.enabled:
            threading.Thread(target=self._loop, name="loadwatch", daemon=True).start()

    # -- sampling

    def _open(self):
        if self._nvml is None:
            import pynvml
            pynvml.nvmlInit()
            index = int(self.device.split(":")[1]) if ":" in self.device else 0
            self._nvml = (pynvml, pynvml.nvmlDeviceGetHandleByIndex(index), index)
        return self._nvml

    def sample(self):
        nv, handle, index = self._open()
        import torch
        util = nv.nvmlDeviceGetUtilizationRates(handle).gpu
        mem = nv.nvmlDeviceGetMemoryInfo(handle)
        ours = (torch.cuda.memory_reserved(index) if torch.cuda.is_initialized() else 0) + CONTEXT_BYTES
        other = max(0, mem.used - ours) / mem.total * 100
        return util, other

    def _loop(self):
        while True:
            try:
                self.step(*self.sample(), time.time())
            except Exception:  # NVML missing or the driver reset: treat as not busy rather than refusing work
                self.busy, self.reasons = False, []
            time.sleep(1.0)

    def step(self, util, other_pct, now):
        """One reading. Split from the loop so it can be tested with made-up numbers."""
        with self.lock:
            if self.inflight == 0:
                self.util = (self.util + [util])[-5:]
            # Our own work in flight makes a reading meaningless, so with no earlier readings it counts as none.
            self.gpu_util = statistics.median(self.util) if self.util else (0.0 if self.inflight else util)
            self.vram_other_pct = other_pct
            hot = [name for name, v in (("GPU use", self.gpu_util), ("video memory", other_pct)) if v > self.limit]
            calm = self.gpu_util < self.limit - self.margin and other_pct < self.limit - self.margin
            if hot:
                self._free_since = None
                if self._busy_since is None:
                    self._busy_since = now
                self.busy, self.reasons = True, [f"{n} over {self.limit:.0f}%" for n in hot]
                stale = now - self._busy_since >= self.unload_after
            elif self.busy and calm:
                if self._free_since is None:
                    self._free_since = now
                if now - self._free_since >= self.free_after:
                    self.busy, self.reasons, self._busy_since, self._free_since = False, [], None, None
                stale = False
            else:
                stale = False
            if self.busy:
                unload, reload_ = stale and not self.unloaded, False
            else:
                unload, reload_ = False, self.unloaded
        if unload and self.on_unload:
            self.on_unload()
            self.unloaded = True
        elif reload_ and self.on_reload:
            self.on_reload()
            self.unloaded = False

    def status(self):
        with self.lock:
            return {"ready": not self.unloaded, "busy": self.busy, "reasons": list(self.reasons), "device": self.device,
                    "gpu_util_pct": self.gpu_util, "vram_other_pct": self.vram_other_pct, "limit_pct": self.limit,
                    "checkpoints_in_memory": not self.unloaded, "watching": self.enabled}


class LoadGate:
    """ASGI middleware: 503 for /v1/systemone while busy, the state for GET /load, and a count of requests in flight."""

    def __init__(self, app, watch):
        self.app, self.watch = app, watch

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path, method = scope["path"], scope["method"]
        if path == "/load" and method == "GET":
            return await self._json(send, 200, self.watch.status())
        if path == "/v1/systemone" and method == "POST":
            if self.watch.busy:
                body = {"error": "busy", "reasons": self.watch.reasons, "retry_after_s": 5}
                return await self._json(send, 503, body, [(b"retry-after", b"5")])
            self.watch.inflight += 1
            try:
                return await self.app(scope, receive, send)
            finally:
                self.watch.inflight -= 1
        return await self.app(scope, receive, send)

    @staticmethod
    async def _json(send, status, body, extra=()):
        data = json.dumps(body).encode()
        headers = [(b"content-type", b"application/json"), (b"content-length", str(len(data)).encode()), *extra]
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": data})
