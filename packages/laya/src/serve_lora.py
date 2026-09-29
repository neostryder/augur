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
browser) may not use a GCU pilot or adapter (BROWSER_BLOCKED): those adapters were trained on
FERPA-derived evidence. Every other path stays same-origin.

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

import lora  # noqa: E402
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
BROWSER_BLOCKED = ("laya:gcu_", "laya:@gcu_")

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
            man = json.load(open(os.path.join(ADAPTERS, name, "manifest.json"), encoding="utf-8"))
            return name, man.get("max_len")
        cfg = self.registry.get("pilots", {}).get(spec) or {}
        return cfg.get("adapter"), cfg.get("max_len")

    def hard_max_len(self):
        self._refresh()
        return int(self.registry.get("hard_max_len") or HARD_MAX_LEN)

    def activate(self, name):
        if name and name not in self.loaded:
            lora.load_adapter(self.agent.model, name, os.path.join(ADAPTERS, name))
            self.loaded.add(name)
        lora.set_active(self.agent.model, name)

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
    """CORS for CORS_PATHS only, and no GCU pilots for requests that come from a browser."""

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
        chunks, more = [], True
        while more:
            msg = await receive()
            chunks.append(msg.get("body", b""))
            more = msg.get("more_body", False)
        body = b"".join(chunks)
        try:
            model = json.loads(body or b"{}").get("model")
        except (ValueError, AttributeError):
            model = None
        if isinstance(model, str) and model.startswith(BROWSER_BLOCKED):
            from starlette.responses import JSONResponse
            resp = JSONResponse({"error": "GCU pilots are not available to browser requests"}, status_code=403,
                                headers={"Access-Control-Allow-Origin": "*"})
            return await resp(scope, receive, send)
        sent = False

        async def replay():
            nonlocal sent
            if sent:
                return await receive()
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return await self.cors(scope, replay, send)


class Serving:
    """The English checkpoint with its adapters, which can leave video memory and come back."""

    def __init__(self, router):
        self.router = router
        self.lock = threading.RLock()
        self.unloaded = False
        self.english = None
        self.adapters = None
        self._attach()

    def _attach(self):
        self.english = self.router.load("english")
        lora.wrap(self.english.model)
        self.adapters = Adapters(self.english)

    def unload(self):
        with self.lock:
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

    router = S.build_router()
    serving = Serving(router)
    stock_predict = router.predict
    cache = ResultCache(CACHE_SIZE)

    def predict(state, questions, model=None, **kw):
        with serving.lock:
            serving.ensure()
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
                english.model.encoder.rotary_emb = adapters.base_rotary
            result.setdefault("routing", {})
            result["routing"].update({"pilot_spec": model[5:], "adapter": name or "base",
                                      "max_len": max_len or english.cfg.get("max_len"), "rope_yarn_factor": rope})
            cache.put(k, result)
            return result

    router.predict = predict
    app = S.create_app(router)
    watch = LoadWatch(pick_device(), on_unload=serving.unload, on_reload=serving.ensure)

    @app.get("/adapters")
    def list_adapters():
        with serving.lock:
            serving.ensure()
            adapters = serving.adapters
            adapters._refresh()
            # train_ids let calibrate.py fit only on rows an adapter never trained on.
            train_ids = {}
            for cfg in adapters.registry.get("pilots", {}).values():
                name = cfg.get("adapter")
                if name and name not in train_ids:
                    man = json.load(open(os.path.join(ADAPTERS, name, "manifest.json"), encoding="utf-8"))
                    train_ids[name] = man.get("train_ids", [])
            return {"registry": adapters.registry, "loaded": sorted(adapters.loaded), "train_ids": train_ids}

    uvicorn.run(BrowserAccess(LoadGate(app, watch)), host=os.environ.get("LAYA_HOST", "127.0.0.1"), port=S._resolve_port(),
                log_level=os.environ.get("LAYA_LOG_LEVEL", "info"))


if __name__ == "__main__":
    main()
