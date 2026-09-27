var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
var ALLOWED = {
  "openrouter.ai": { methods: ["GET"], path: /^\/api\/v1\/(credits|key)$/ },
  "api.fal.ai": { methods: ["GET"], path: /^\/v1\/(account\/billing|models\/usage)$/ },
  "api.minimax.io": { methods: ["GET"], path: /^\/v1\/api\/openplatform\/coding_plan\/remains$/ },
  "api.typesafe.ai": { methods: ["POST"], path: /^\/v1\/systemone$/ },
  "status.claude.com": { methods: ["GET"], path: /^\/api\/v2\/status\.json$/ },
  "status.openai.com": { methods: ["GET"], path: /^\/api\/v2\/status\.json$/ },
  "status.minimax.io": { methods: ["GET"], path: /^\/api\/v2\/status\.json$/ }
};
var MAX_BODY = 64 * 1024;
var DROP_RESPONSE_HEADERS = /* @__PURE__ */ new Set(["set-cookie", "content-encoding", "content-length", "transfer-encoding"]);
var JEV_PROBE = JSON.stringify({
  model: "jev-latest",
  state: { message: "I was charged twice. Please fix this ASAP." },
  questions: { billing: { type: "noul", instructions: "Is this message about a billing problem?" } }
});
async function limited(limit, request) {
  if (!limit) return false;
  const key = request.headers.get("cf-connecting-ip") ?? "unknown";
  return !(await limit.limit({ key })).success;
}
__name(limited, "limited");
var SYNC_MAX = 512 * 1024;
var SYNC_TTL_S = 14 * 86400;
var SYNC_MIN_GAP_S = 240;
async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");
async function sync(request, env, channel, ch) {
  if (!env.SYNC) return reply(501, { error: "Sync is not set up on this relay" }, ch);
  if (!/^[0-9a-f]{64}$/.test(channel)) return reply(400, { error: "Bad channel" }, ch);
  if (request.method === "GET") {
    const v = await env.SYNC.get(channel);
    return v ? new Response(v, { headers: { "content-type": "application/json", "cache-control": "no-store", ...ch } }) : reply(404, { error: "Nothing synced yet" }, ch);
  }
  if (request.method === "PUT") {
    if (await limited(env.SYNC_LIMIT, request)) return reply(429, { error: "Too many requests" }, ch);
    const secret = request.headers.get("x-sync-secret") ?? "";
    if (!secret || await sha256Hex(secret) !== channel) return reply(403, { error: "Wrong write secret" }, ch);
    const body = await request.text();
    if (body.length > SYNC_MAX) return reply(413, { error: "Snapshot too large" }, ch);
    const prior = await env.SYNC.getWithMetadata(channel, { type: "stream" });
    await prior.value?.cancel();
    if (prior.metadata?.at && Date.now() - prior.metadata.at < SYNC_MIN_GAP_S * 1e3) return reply(429, { error: "Synced too recently" }, ch);
    await env.SYNC.put(channel, body, { expirationTtl: SYNC_TTL_S, metadata: { at: Date.now() } });
    return reply(200, { ok: true }, ch);
  }
  return reply(405, { error: "Method not allowed" }, ch);
}
__name(sync, "sync");
function cors(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    "access-control-allow-headers": "content-type, x-sync-secret",
    "access-control-max-age": "86400",
    vary: "origin"
  };
}
__name(cors, "cors");
function reply(status, body, headers) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
__name(reply, "reply");
var src_default = {
  async fetch(request, env) {
    const origin = request.headers.get("origin") ?? "";
    const ch = cors(origin, env);
    if (request.method === "OPTIONS") return new Response(null, { status: ch["access-control-allow-origin"] ? 204 : 403, headers: ch });
    const url = new URL(request.url);
    const syncMatch = url.pathname.match(/^\/sync\/([^/]+)$/);
    if (syncMatch) return sync(request, env, syncMatch[1], ch);
    if (url.pathname !== "/fetch" || request.method !== "POST") return reply(404, { error: "Not found" }, ch);
    if (!ch["access-control-allow-origin"]) return reply(403, { error: "Origin not allowed" }, ch);
    if (await limited(env.FETCH_LIMIT, request)) return reply(429, { error: "Too many requests" }, ch);
    const raw = await request.text();
    if (raw.length > MAX_BODY) return reply(413, { error: "Request too large" }, ch);
    let req;
    try {
      req = JSON.parse(raw);
    } catch {
      return reply(400, { error: "Body must be JSON" }, ch);
    }
    let target;
    try {
      target = new URL(String(req.url));
    } catch {
      return reply(400, { error: "Bad url" }, ch);
    }
    const rule = ALLOWED[target.hostname];
    const method = (req.method ?? "GET").toUpperCase();
    if (target.protocol !== "https:" || !rule || !rule.path.test(target.pathname)) return reply(403, { error: "Address not allowed" }, ch);
    if (!rule.methods.includes(method)) return reply(405, { error: "Method not allowed" }, ch);
    if (target.hostname === "api.typesafe.ai" && !sameJson(req.body, JEV_PROBE)) return reply(403, { error: "Request not allowed" }, ch);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      if (!/^(host|cookie|origin|referer|cf-|x-forwarded)/i.test(k)) headers.set(k, String(v));
    }
    headers.set("user-agent", "augur-relay/1");
    const init = { method, headers, redirect: "manual", signal: AbortSignal.timeout(15e3) };
    if (method === "POST" && req.body !== void 0) init.body = req.body;
    let upstream;
    try {
      upstream = await fetch(target.toString(), init);
    } catch {
      return reply(502, { error: "Upstream did not answer" }, ch);
    }
    const out = {};
    upstream.headers.forEach((v, k) => {
      if (!DROP_RESPONSE_HEADERS.has(k)) out[k] = v;
    });
    return reply(200, { status: upstream.status, headers: out, body: await upstream.text() }, ch);
  }
};
function sameJson(body, expected) {
  try {
    return JSON.stringify(JSON.parse(body ?? "")) === expected;
  } catch {
    return false;
  }
}
__name(sameJson, "sameJson");

// ../../node_modules/.pnpm/wrangler@4.141.0_@cloudflar_91c17a5742f47fc60f3f5aba20f39c77/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../node_modules/.pnpm/wrangler@4.141.0_@cloudflar_91c17a5742f47fc60f3f5aba20f39c77/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-VBoZNT/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../node_modules/.pnpm/wrangler@4.141.0_@cloudflar_91c17a5742f47fc60f3f5aba20f39c77/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-VBoZNT/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
