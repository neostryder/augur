"""Ask the first healthy Laya server in a list. Standard library only, so any script can import it.

    from pool import Pool
    pool = Pool.from_config()                       # ~/.augur/laya.json, else the built-in list
    answer, server = pool.post("/v1/systemone", {"model": "laya", "state": "...", "questions": {...}})

The list is tried in order. A server is skipped when it does not answer, answers 503, or reports busy or not ready on
GET /load. A refusal is remembered for a few seconds (busy) or half a minute (unreachable), so a sleeping PC costs
one short timeout and not one per request. A 4xx answer is the caller's mistake and is raised without trying the next
server; any other failure moves on. Config file shape: {"servers": [{"name": "eru", "url": "http://127.0.0.1:8010"}, ...]}.
"""

import json
import os
import time
import urllib.error
import urllib.request

# Only this computer by default. Other machines are listed in ~/.augur/laya.json.
DEFAULT_SERVERS = [{"name": "local", "url": "http://127.0.0.1:8010"}]


def load_config(path=None) -> dict:
    """~/.augur/laya.json as a dict: `servers` (the pool), `syncHost` (user@host that adapters are copied to) and `repo` (the Augur checkout the trainer exports from)."""
    path = path or os.path.join(os.path.expanduser("~"), ".augur", "laya.json")
    try:
        data = json.load(open(path, encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


class PoolError(Exception):
    """Every server failed. `reasons` says why, server by server."""

    def __init__(self, reasons):
        super().__init__("no Laya server answered: " + "; ".join(f"{k}: {v}" for k, v in reasons.items()))
        self.reasons = reasons


class Pool:
    def __init__(self, servers=None, probe_timeout=0.6, busy_ttl=5.0, down_ttl=30.0, clock=time.monotonic):
        self.servers = servers or DEFAULT_SERVERS
        self.probe_timeout, self.busy_ttl, self.down_ttl, self.clock = probe_timeout, busy_ttl, down_ttl, clock
        self._skip = {}   # url -> (until, reason)

    @classmethod
    def from_config(cls, path=None, **kw):
        return cls(load_config(path).get("servers"), **kw)

    def _skipped(self, url):
        entry = self._skip.get(url)
        if entry and entry[0] > self.clock():
            return entry[1]
        self._skip.pop(url, None)
        return None

    def _mark(self, url, ttl, reason):
        self._skip[url] = (self.clock() + ttl, reason)

    def _probe(self, url):
        """None when the server may be used, else the reason it may not."""
        try:
            with urllib.request.urlopen(url + "/load", timeout=self.probe_timeout) as r:
                state = json.load(r)
        except urllib.error.HTTPError as e:
            return None if e.code == 404 else f"load probe answered {e.code}"   # a server without /load is used as it is
        except (urllib.error.URLError, OSError, ValueError) as e:
            return f"unreachable ({getattr(e, 'reason', e)})"
        if state.get("busy"):
            return "busy: " + ", ".join(state.get("reasons") or ["over its limit"])
        if state.get("ready") is False:
            return "not ready"
        return None

    def post(self, path, body, headers=None, timeout=60.0):
        data = json.dumps(body).encode("utf-8")
        reasons = {}
        for server in self.servers:
            name, url = server["name"], server["url"].rstrip("/")
            why = self._skipped(url)
            if why:
                reasons[name] = why + " (recently)"
                continue
            why = self._probe(url)
            if why:
                self._mark(url, self.busy_ttl if why.startswith(("busy", "not ready")) else self.down_ttl, why)
                reasons[name] = why
                continue
            req = urllib.request.Request(url + path, data, {"Content-Type": "application/json", **(headers or {})})
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    return json.load(r), name
            except urllib.error.HTTPError as e:
                if e.code == 503:
                    self._mark(url, self.busy_ttl, "busy")
                    reasons[name] = "busy (503)"
                elif 400 <= e.code < 500:
                    raise
                else:
                    self._mark(url, self.busy_ttl, f"error {e.code}")
                    reasons[name] = f"error {e.code}"
            except (urllib.error.URLError, OSError) as e:
                self._mark(url, self.down_ttl, "unreachable")
                reasons[name] = f"unreachable ({getattr(e, 'reason', e)})"
        raise PoolError(reasons)
