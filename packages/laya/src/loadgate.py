"""Steps aside when something else is using the GPU.

A watcher samples the card once a second. The card counts as busy when the median of the last five
utilization readings, or the video memory in use by other processes, is over LAYA_BUSY_PCT (80).
While it is busy, /v1/systemone answers 503 with Retry-After, so a client moves to its next server,
and after LAYA_BUSY_UNLOAD_S (30) seconds of it the checkpoints leave video memory. The card counts as
free again when both readings stay ten points under the limit for LAYA_FREE_S (10) seconds, and the
checkpoint comes back. Utilization is not read while a request of ours is running, because our own
work would otherwise count against us. Anything that is not a CUDA device is never busy.

A game on the card counts as busy at once. LAYA_GAME_PROCS lists the program names to watch (default the two ARK
Survival Ascended programs), and the checkpoints leave video memory LAYA_GAME_UNLOAD_S (5) seconds after one starts.
Neither the game ending nor an idle unload brings them back on its own: the next request loads them again.

After LAYA_IDLE_UNLOAD_S (600) seconds with no request the checkpoints also leave video memory, so an idle server
holds none (0 turns this off). The first request after that loads them again before it answers. A server that has just
started holds none either: the first request loads them.

GET /load reports the same state for a client that wants to choose a server before it asks.
"""

import json
import os
import statistics
import threading
import time

CONTEXT_BYTES = 400 * 1024 * 1024   # what a CUDA context holds besides our tensors
DEFAULT_GAMES = "ArkAscended.exe,ArkAscendedServer.exe"


def running_games(names):
    """The names from `names` that are running now, matched without case. Windows only; elsewhere none."""
    wanted = {n.strip().lower() for n in names if n.strip()}
    if not wanted or os.name != "nt":
        return []
    import ctypes
    from ctypes import wintypes

    class Entry(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                    ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", wintypes.LONG), ("dwFlags", wintypes.DWORD),
                    ("szExeFile", ctypes.c_wchar * 260)]

    k32 = ctypes.windll.kernel32
    k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    snap = k32.CreateToolhelp32Snapshot(0x2, 0)   # TH32CS_SNAPPROCESS
    if snap in (None, wintypes.HANDLE(-1).value):
        return []
    found = set()
    try:
        entry = Entry()
        entry.dwSize = ctypes.sizeof(Entry)
        ok = k32.Process32FirstW(wintypes.HANDLE(snap), ctypes.byref(entry))
        while ok:
            if entry.szExeFile.lower() in wanted:
                found.add(entry.szExeFile)
            ok = k32.Process32NextW(wintypes.HANDLE(snap), ctypes.byref(entry))
    finally:
        k32.CloseHandle(wintypes.HANDLE(snap))
    return sorted(found)


class LoadWatch:
    def __init__(self, device, on_unload=None, on_reload=None):
        self.device = str(device)
        self.limit = float(os.environ.get("LAYA_BUSY_PCT", "80"))
        self.margin = 10.0
        self.unload_after = float(os.environ.get("LAYA_BUSY_UNLOAD_S", "30"))
        self.free_after = float(os.environ.get("LAYA_FREE_S", "10"))
        self.game_names = [n for n in os.environ.get("LAYA_GAME_PROCS", DEFAULT_GAMES).split(",") if n.strip()]
        self.game_unload_after = float(os.environ.get("LAYA_GAME_UNLOAD_S", "5"))
        self.idle_unload_after = float(os.environ.get("LAYA_IDLE_UNLOAD_S", "600"))
        self.on_unload, self.on_reload = on_unload, on_reload
        self.inflight = 0
        self.lock = threading.Lock()
        self.util = []
        self.gpu_util = None
        self.vram_other_pct = None
        self.busy = False
        self.reasons = []
        self.unloaded = False
        self.unload_reason = None   # "busy", "game" or "idle": only a busy card brings the checkpoints back by itself
        self.last_active = None
        self.requests = 0
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
                self.step(*self.sample(), time.time(), running_games(self.game_names))
            except Exception:  # NVML missing or the driver reset: treat as not busy rather than refusing work
                self.busy, self.reasons = False, []
            time.sleep(1.0)

    def touch(self, now=None):
        """A request started or finished."""
        self.last_active = time.time() if now is None else now

    def idle_seconds(self, now=None):
        if self.last_active is None:
            return None
        return round((time.time() if now is None else now) - self.last_active, 1)

    def mark_loaded(self):
        """The checkpoints came back through a request, not through the watcher."""
        with self.lock:
            self.unloaded, self.unload_reason = False, None

    def step(self, util, other_pct, now, games=()):
        """One reading. Split from the loop so it can be tested with made-up numbers."""
        with self.lock:
            if self.last_active is None:
                self.last_active = now
            if self.inflight == 0:
                self.util = (self.util + [util])[-5:]
            # Our own work in flight makes a reading meaningless, so with no earlier readings it counts as none.
            self.gpu_util = statistics.median(self.util) if self.util else (0.0 if self.inflight else util)
            self.vram_other_pct = other_pct
            hot = [name for name, v in (("GPU use", self.gpu_util), ("video memory", other_pct)) if v > self.limit]
            calm = self.gpu_util < self.limit - self.margin and other_pct < self.limit - self.margin and not games
            reason = None
            if hot or games:
                self._free_since = None
                if self._busy_since is None:
                    self._busy_since = now
                self.busy = True
                self.reasons = [f"{n} over {self.limit:.0f}%" for n in hot] + [f"{g} running" for g in games]
                limit = self.game_unload_after if games else self.unload_after
                stale = now - self._busy_since >= limit
                reason = "game" if games else "busy"
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
                unload = False
                reload_ = self.unloaded and self.unload_reason == "busy"
                if (not self.unloaded and self.idle_unload_after > 0 and self.inflight == 0
                        and now - self.last_active >= self.idle_unload_after):
                    unload, reason = True, "idle"
        if unload and self.on_unload:
            self.on_unload()
            self.unloaded, self.unload_reason = True, reason
        elif reload_ and self.on_reload:
            self.on_reload()
            self.unloaded, self.unload_reason = False, None

    def status(self):
        with self.lock:
            # An idle unload still answers: the next request loads the checkpoints first, and a client that skipped a
            # server reporting not ready would never send it one.
            ready = not self.unloaded or self.unload_reason in ("idle", "game")
            return {"ready": ready, "busy": self.busy, "reasons": list(self.reasons), "device": self.device,
                    "gpu_util_pct": self.gpu_util, "vram_other_pct": self.vram_other_pct, "limit_pct": self.limit,
                    "checkpoints_in_memory": not self.unloaded, "unload_reason": self.unload_reason, "idle_s": self.idle_seconds(), "requests": self.requests, "watching": self.enabled}


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
            self.watch.requests += 1
            self.watch.touch()
            try:
                return await self.app(scope, receive, send)
            finally:
                self.watch.inflight -= 1
                self.watch.touch()
        return await self.app(scope, receive, send)

    @staticmethod
    async def _json(send, status, body, extra=()):
        data = json.dumps(body).encode()
        headers = [(b"content-type", b"application/json"), (b"content-length", str(len(data)).encode()), *extra]
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": data})
