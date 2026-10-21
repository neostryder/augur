"""laya-serve with per-pilot LoRA adapters and per-pilot context length. Drop-in for `laya-serve`.

Same /v1/systemone and /health as stock laya-serve, same environment variables, same guardrails.
A request whose `model` is "laya:<pilot>" is answered by the English checkpoint with that pilot's
live adapter and max_len from adapters/registry.json; "laya:@<adapter>" names an adapter directly
(for evaluation). Every other request is answered exactly as stock laya-serve answers it, with
no adapter active.

The registry is re-read whenever its mtime changes, and adapters load on first use, so
promotion, rollback and max_len changes take effect on the next request without a restart.
Above ctxutil.LONG_CONTEXT tokens each question runs in its own forward pass to bound memory.
No pilot may exceed the cap: registry "hard_max_len" if set, else LAYA_HARD_MAX_LEN, else 4,096.
The cap is re-read with the registry, so changing it needs no restart. Above the encoder's native
8,192 positions the global-attention RoPE would switch to YaRN, which measured worse; the 4,096
default keeps every request on the native positions.

GET /adapters returns the registry and what is loaded. GET /load reports whether this server is busy
(see loadgate.py), and while it is, /v1/systemone answers 503 so a client tries its next server.

Browsers: /v1/systemone answers CORS preflights for any origin (POST and OPTIONS, Content-Type and
Authorization headers, no credentials) and sends Access-Control-Allow-Private-Network, so a web
page such as the Squire mod can call it. A request that carries an Origin header (so came from a
browser) may not use a restricted pilot or adapter (see browser_guard.py): those adapters were trained on
private evidence. Every other path stays same-origin.

Repeat cache: the encoder is bidirectional and puts each question ahead of the state, so no part
of one sequence's attention can be reused for another and prefix KV caching does not apply. An
exact repeat (same model, resolved adapter and max_len, state, questions and options) is answered
from an in-memory LRU of CACHE_SIZE results instead, and its routing block says cache "hit".
"""

import collections
import copy
import hashlib
import json
import os
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import laya.serve as S  # noqa: E402
from laya.common import QTYPES  # noqa: E402

import calib  # noqa: E402
import lora  # noqa: E402
import browser_guard  # noqa: E402
from ctxutil import LONG_CONTEXT  # noqa: E402

from env import home  # noqa: E402

ROOT = home(HERE)
ADAPTERS = os.path.join(ROOT, "adapters")
REGISTRY = os.path.join(ADAPTERS, "registry.json")
NATIVE_POSITIONS = 8192
HARD_MAX_LEN = int(os.environ.get("LAYA_HARD_MAX_LEN", "4096"))
STATE_CHARS_PER_TOKEN = 6
CACHE_SIZE = 512
CORS_PATHS = {"/v1/systemone"}

# Stock laya-serve caps states at 50K characters, which already covers a 4K-token state; raise it
# only if the cap is set higher.
S.MAX_STATE_CHARS = max(S.MAX_STATE_CHARS, HARD_MAX_LEN * STATE_CHARS_PER_TOKEN)

_stock_resolve = S._resolve_model


def _resolve_model(model):
    if isinstance(model, str) and model.startswith("laya:"):
        return model
    return _stock_resolve(model)


S._resolve_model = _resolve_model


class Adapters:
    def __init__(self, agent):
        self.agent = agent
        self.lock = threading.Lock()
        self.mtime = None
        self.registry = {"pilots": {}, "history": []}
        self.loaded = set()
        self.base_rotary = agent.model.encoder.rotary_emb
        self.long_rotary = {}
        self.base_temperature = list(agent.temperature)
        self.base_by_options = dict(agent.temperature_by_options)
        self.temperatures = {}   # adapter name -> the temperatures its manifest was fitted with

    def _refresh(self):
        try:
            m = os.path.getmtime(REGISTRY)
        except OSError:
            return
        if m != self.mtime:
            self.registry = json.load(open(REGISTRY, encoding="utf-8"))
            self.mtime = m

    def resolve(self, spec):
        """spec after 'laya:' -> (adapter name or None, max_len)."""
        self._refresh()
        if spec.startswith("@"):
            name = spec[1:]
            man = json.load(open(os.path.join(browser_guard.adapter_dir(ADAPTERS, name), "manifest.json"), encoding="utf-8"))
            return name, man.get("max_len")
        cfg = self.registry.get("pilots", {}).get(spec) or {}
        name = cfg.get("adapter")
        if name:
            browser_guard.adapter_dir(ADAPTERS, name)
        return name, cfg.get("max_len")

    def hard_max_len(self):
        self._refresh()
        return int(self.registry.get("hard_max_len") or HARD_MAX_LEN)

    def activate(self, name):
        if name and name not in self.loaded:
            lora.load_adapter(self.agent.model, name, browser_guard.adapter_dir(ADAPTERS, name))
            self.loaded.add(name)
        lora.set_active(self.agent.model, name)
        self.apply_temperatures(name)

    def adapter_temperatures(self, name):
        if name not in self.temperatures:
            man = json.load(open(os.path.join(browser_guard.adapter_dir(ADAPTERS, name), "manifest.json"), encoding="utf-8"))
            self.temperatures[name] = calib.manifest_temperatures(man)
        return self.temperatures[name]

    def apply_temperatures(self, name):
        """The adapter's fitted temperatures replace the checkpoint's for its question types; no adapter restores them."""
        fitted = self.adapter_temperatures(name) if name else {}
        self.agent.temperature, self.agent.temperature_by_options = calib.apply_temperatures(
            self.base_temperature, self.base_by_options, fitted, QTYPES)

    def set_rope(self, max_len):
        enc = self.agent.model.encoder
        if not max_len or max_len <= NATIVE_POSITIONS:
            enc.rotary_emb = self.base_rotary
            return None
        factor = 2 ** max(1, (max_len - 1).bit_length() - NATIVE_POSITIONS.bit_length() + 1)
        if factor not in self.long_rotary:
            from ctxutil import apply_rope
            saved_cfg = enc.config
            apply_rope(self.agent, f"yarn{factor}")
            self.long_rotary[factor] = enc.rotary_emb
            enc.config = saved_cfg
        enc.rotary_emb = self.long_rotary[factor]
        return factor


class ResultCache:
    def __init__(self, size):
        self.size, self.data, self.lock = size, collections.OrderedDict(), threading.Lock()

    @staticmethod
    def key(*parts):
        return hashlib.sha1(json.dumps(parts, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")).hexdigest()

    def get(self, k):
        with self.lock:
            v = self.data.get(k)
            if v is None:
                return None
            self.data.move_to_end(k)
        v = copy.deepcopy(v)
        v.setdefault("routing", {})["cache"] = "hit"
        return v

    def put(self, k, v):
        with self.lock:
            self.data[k] = copy.deepcopy(v)
            self.data.move_to_end(k)
            while len(self.data) > self.size:
                self.data.popitem(last=False)


class BrowserAccess:
    """CORS for CORS_PATHS only, and no restricted pilots for requests that come from a browser."""

    def __init__(self, app):
        from starlette.middleware.cors import CORSMiddleware
        self.app = app
        origins = [o.strip() for o in os.environ.get("LAYA_CORS_ORIGINS", "*").split(",") if o.strip()] or ["*"]
        self.cors = CORSMiddleware(app, allow_origins=origins, allow_methods=["POST", "OPTIONS"],
                                   allow_headers=["Content-Type", "Authorization"],
                                   allow_credentials=False, allow_private_network=True)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] not in CORS_PATHS:
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers") or [])
        if b"origin" not in headers or scope["method"] != "POST":
            return await self.cors(scope, receive, send)
        from starlette.responses import JSONResponse
        refuse = lambda status, text: JSONResponse({"error": text}, status_code=status, headers={"Access-Control-Allow-Origin": "*"})  # noqa: E731
        declared = headers.get(b"content-length")
        if browser_guard.body_too_large(declared.decode("latin-1") if declared is not None else None):
            return await refuse(413, "The request is too large")(scope, receive, send)
        chunks, more, total = [], True, 0
        while more:
            msg = await receive()
            chunk = msg.get("body", b"")
            total += len(chunk)
            if browser_guard.body_too_large(None, total):
                return await refuse(413, "The request is too large")(scope, receive, send)
            chunks.append(chunk)
            more = msg.get("more_body", False)
        body = b"".join(chunks)
        try:
            model = json.loads(body or b"{}").get("model")
        except (ValueError, AttributeError):
            model = None
        allowed, reason = browser_guard.browser_may_use(model, REGISTRY)
        if not allowed:
            return await refuse(403, reason)(scope, receive, send)
        sent = False

        async def replay():
            nonlocal sent
            if sent:
                return await receive()
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return await self.cors(scope, replay, send)


class Serving:
    """The English checkpoint with its adapters, which load on the first request and can leave video memory and come back."""

    def __init__(self, router):
        self.router = router
        self.lock = threading.RLock()
        self.unloaded = True
        self.english = None
        self.adapters = None

    def _attach(self):
        self.english = self.router.load("english")
        lora.wrap(self.english.model)
        self.adapters = Adapters(self.english)

    def unload(self):
        with self.lock:
            if self.unloaded:
                return
            self.router.unload()
            self.english = self.adapters = None
            self.unloaded = True
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    def ensure(self):
        with self.lock:
            if self.unloaded:
                self._attach()
                self.unloaded = False


def main():
    import uvicorn

    from env import device as pick_device
    from loadgate import LoadGate, LoadWatch

    # The stock server builds every checkpoint at start unless told not to. Nothing here holds video memory
    # before a request needs it, so this is not left to the environment.
    os.environ["LAYA_PRELOAD"] = "0"
    router = S.build_router()
    serving = Serving(router)
    stock_predict = router.predict
    cache = ResultCache(CACHE_SIZE)

    def predict(state, questions, model=None, **kw):
        with serving.lock:
            serving.ensure()
            watch.mark_loaded()
            english, adapters = serving.english, serving.adapters
            if not (isinstance(model, str) and model.startswith("laya:")):
                k = cache.key("stock", model, state, questions, kw)
                hit = cache.get(k)
                if hit is not None:
                    return hit
                lora.set_active(english.model, None)
                english.model.encoder.rotary_emb = adapters.base_rotary
                result = stock_predict(state, questions, model=model, **kw)
                cache.put(k, result)
                return result
            name, max_len = adapters.resolve(model[5:])
            max_len = min(int(max_len), adapters.hard_max_len()) if max_len else None
            k = cache.key(model, name, max_len, state, questions, kw)
            hit = cache.get(k)
            if hit is not None:
                return hit
            try:
                adapters.activate(name)
                rope = adapters.set_rope(max_len)
                if max_len and max_len > LONG_CONTEXT and len(questions) > 1:
                    result, answers, usage = None, {}, {"input_tokens": 0, "output_tokens": 0}
                    for qn, qd in questions.items():
                        r = stock_predict(state, {qn: qd}, model="english", max_len=max_len, **kw)
                        answers.update(r["answers"])
                        for k in usage:
                            usage[k] += (r.get("usage") or {}).get(k, 0)
                        result = r
                    result["answers"], result["usage"] = answers, usage
                else:
                    result = stock_predict(state, questions, model="english", max_len=max_len, **kw)
            finally:
                lora.set_active(english.model, None)
                adapters.apply_temperatures(None)
                english.model.encoder.rotary_emb = adapters.base_rotary
            result.setdefault("routing", {})
            result["routing"].update({"pilot_spec": model[5:], "adapter": name or "base",
                                      "max_len": max_len or english.cfg.get("max_len"), "rope_yarn_factor": rope,
                                      "temperature_by_type": adapters.adapter_temperatures(name) if name else {}})
            cache.put(k, result)
            return result

    router.predict = predict
    app = S.create_app(router)
    watch = LoadWatch(pick_device(), on_unload=serving.unload, on_reload=serving.ensure)
    # Nothing is in memory yet. Reporting it as an idle unload keeps the server ready and leaves the first request to load.
    watch.unloaded, watch.unload_reason = True, "idle"

    @app.get("/adapters")
    def list_adapters():
        with serving.lock:
            serving.ensure()
            watch.mark_loaded()
            adapters = serving.adapters
            adapters._refresh()
            # train_ids let calibrate.py fit only on rows an adapter never trained on.
            train_ids = {}
            for cfg in adapters.registry.get("pilots", {}).values():
                name = cfg.get("adapter")
                if name and name not in train_ids:
                    man = json.load(open(os.path.join(browser_guard.adapter_dir(ADAPTERS, name), "manifest.json"), encoding="utf-8"))
                    train_ids[name] = man.get("train_ids", [])
            return {"registry": adapters.registry, "loaded": sorted(adapters.loaded), "train_ids": train_ids}

    uvicorn.run(BrowserAccess(LoadGate(app, watch)), host=os.environ.get("LAYA_HOST", "127.0.0.1"), port=S._resolve_port(),
                log_level=os.environ.get("LAYA_LOG_LEVEL", "info"))


if __name__ == "__main__":
    main()
