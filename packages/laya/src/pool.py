"""Ask the first healthy Laya server in a list. Standard library only, so any script can import it.

    from pool import Pool
    pool = Pool.from_config()                       # ~/.augur/laya.json, else the built-in list
    answer, server = pool.post("/v1/systemone", {"model": "laya", "state": "...", "questions": {...}})

The list is tried in order. A server is skipped when it does not answer, answers 503, or reports busy or not ready on
GET /load. A refusal is remembered for a few seconds (busy) or half a minute (unreachable), so a sleeping PC costs
one short timeout and not one per request. A 4xx answer is the caller's mistake and is raised without trying the next
server; any other failure moves on.

`~/.augur/laya.json` holds `servers`, `syncHost`, `syncHosts`, and `repo`. `servers` is the pool, and each entry is
`{"name": "<host>", "url": "http://<host>:8010"}`. `syncHost` is one `user@host` string, and that machine receives
adapters, the registry, and training rows. `syncHosts` lists more copy targets. A string entry receives rows. An
object `{"host": "user@host", "rows": false}` receives adapters and the registry only, and `rows` defaults to true.
An object's optional `server` key names an existing pool server and takes precedence over hostname matching.
`syncHost` is still included when `syncHosts` is set, once. `repo` is the Augur checkout the trainer exports from.
`LAYA_BILBO` replaces the copy list with that one host, and it receives rows.

A sync host matches a server by explicit `server` name, then by server `name`, then by the host in the server `url`. Hostname comparisons ignore case, scheme, and port. The pool keeps that server's `url` and does not add a second address. A sync host with no matching server is still listed, at `http://<name>:8010`, and `health` checks it. `post` uses it as a failover target once it answers, including when that host stores no training rows.
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

# Only this computer by default. Other machines are listed in ~/.augur/laya.json.
DEFAULT_SERVERS = [{"name": "local", "url": "http://127.0.0.1:8010"}]


def load_config(path=None) -> dict:
    """`~/.augur/laya.json` as a dict.

    `servers` is the pool. `syncHost` is one `user@host` that receives adapters, the registry, and training rows.
    `syncHosts` is a list of further copy targets: a `user@host` string receives rows, and
    `{"host": "user@host", "rows": false}` leaves the row files out. `rows` defaults to true. `repo` is the Augur
    checkout the trainer exports from. This function returns the file unchanged. `sync_targets` applies the rules.
    An object's optional `server` key names an existing pool server and takes precedence over hostname matching.
    """
    path = path or os.path.join(os.path.expanduser("~"), ".augur", "laya.json")
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _rows_flag(value, default=True) -> bool:
    # A missing or non-boolean `rows` stays true so a mistyped entry still receives training rows.
    return value if isinstance(value, bool) else default


def _target_from_host(host, rows) -> dict:
    if not isinstance(host, str):
        return {}
    host = host.strip()
    name = host.split("@", 1)[-1].strip()
    if not host or not name:
        return {}
    return {"host": host, "rows": _rows_flag(rows), "name": name}


def _target_from_entry(entry) -> dict:
    if isinstance(entry, str):
        return _target_from_host(entry, True)
    if isinstance(entry, dict):
        target = _target_from_host(entry.get("host"), entry.get("rows", True))
        server = entry.get("server")
        if target and isinstance(server, str) and server.strip():
            target["server"] = server.strip()
        return target
    return {}


def sync_targets(config=None, env=None) -> list:
    """Copy targets as `{"host", "rows", "name"}` dicts with an optional `server` name.

    `name` is the hostname, the part of `host` after `@`. `LAYA_BILBO` in `env` (the process environment when `env`
    is omitted) is the only target, and it receives rows. Otherwise a string `syncHost` is one target that receives
    rows, then each `syncHosts` entry. A string entry receives rows. An object uses `host` and `rows`, and `rows`
    defaults to true. The same `host` string is kept once, and the earlier entry wins.
    An object's optional `server` key names an existing pool server and takes precedence over hostname matching.
    """
    if config is None:
        config = load_config()
    if not isinstance(config, dict):
        config = {}
    if env is None:
        env = os.environ
    forced = env.get("LAYA_BILBO") if isinstance(env, dict) or hasattr(env, "get") else None
    if isinstance(forced, str) and forced.strip():
        one = _target_from_host(forced, True)
        return [one] if one else []
    out, seen = [], set()

    def add(target):
        if target and target["host"] not in seen:
            seen.add(target["host"])
            out.append(target)

    add(_target_from_host(config.get("syncHost"), True))
    hosts = config.get("syncHosts")
    if isinstance(hosts, list):
        for entry in hosts:
            add(_target_from_entry(entry))
    return out


def servers_from_config(data, env=None) -> list:
    """Pool entries from `servers`, plus any sync host that is not already linked there.

    A sync host matches by explicit `server` name, then by server `name`, then by the host in the server `url`. Hostname comparisons ignore case, scheme, and port. The pool keeps the matched server `url`. A sync host with no match is appended at `http://<name>:8010`, the port the built-in server uses. An empty or missing `servers` list uses the built-in local server, then those extra hosts.
    """
    if not isinstance(data, dict):
        data = {}
    raw = data.get("servers")
    servers = []
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            name, url = item.get("name"), item.get("url")
            if isinstance(name, str) and name.strip() and isinstance(url, str) and url.strip():
                servers.append({"name": name.strip(), "url": url.strip()})
    if not servers:
        servers = [dict(item) for item in DEFAULT_SERVERS]
    seen = {item["name"] for item in servers}
    for target in sync_targets(data, env):
        if target.get("server") in seen:
            continue
        hostname = target["name"].casefold()
        if any(item["name"].casefold() == hostname for item in servers):
            continue
        for item in servers:
            try:
                url_host = urllib.parse.urlsplit(item["url"]).hostname
            except ValueError:
                continue
            if url_host and url_host.casefold() == hostname:
                break
        else:
            seen.add(target["name"])
            servers.append({"name": target["name"], "url": f"http://{target['name']}:8010"})
    return servers


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
    def from_config(cls, path=None, env=None, **kw):
        return cls(servers_from_config(load_config(path), env), **kw)

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

    def health(self):
        """Each server name mapped to None when it can take a request, else the reason. One failure does not skip the rest."""
        out = {}
        for server in self.servers:
            name, url = server["name"], server["url"].rstrip("/")
            out[name] = self._probe(url)
        return out

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
