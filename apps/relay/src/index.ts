// Stateless relay for the PWA. Browsers cannot call most usage APIs directly because those
// APIs send no CORS headers, so the PWA posts the request here and gets the response back.
// Nothing is stored or logged: the Worker forwards one request and forgets it.
//
// Only the endpoints listed below are reachable, so the relay cannot be used as an open proxy.
// A custom provider on another host has to run in the desktop app instead.

// Each host is limited to the usage and status endpoints the web app reads, so the relay cannot
// carry other API calls (chat completions, generation) on someone else's behalf.
const ALLOWED: Record<string, { methods: string[]; path: RegExp }> = {
  'openrouter.ai': { methods: ['GET'], path: /^\/api\/v1\/(credits|key)$/ },
  'api.fal.ai': { methods: ['GET'], path: /^\/v1\/(account\/billing|models\/usage)$/ },
  'api.minimax.io': { methods: ['GET'], path: /^\/v1\/api\/openplatform\/coding_plan\/remains$/ },
  'api.typesafe.ai': { methods: ['POST'], path: /^\/v1\/systemone$/ },
  'status.claude.com': { methods: ['GET'], path: /^\/api\/v2\/status\.json$/ },
  'status.openai.com': { methods: ['GET'], path: /^\/api\/v2\/status\.json$/ },
  'status.minimax.io': { methods: ['GET'], path: /^\/api\/v2\/status\.json$/ },
};

const MAX_BODY = 64 * 1024;
const DROP_RESPONSE_HEADERS = new Set(['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding']);

interface Env {
  /** Comma-separated origins allowed to call the relay, such as https://usage.example.com. */
  ALLOWED_ORIGINS?: string;
  /** Holds encrypted snapshots for desktop-to-phone sync. */
  SYNC?: KVNamespace;
  /** Per-address limits on relayed requests and on sync writes. Optional for local development. */
  FETCH_LIMIT?: RateLimit;
  SYNC_LIMIT?: RateLimit;
}

// The only TypeSafe request the web app makes is this fixed health check (see packages/core/src/providers/jev.ts),
// so the relay refuses any other body rather than carrying arbitrary inference on someone's behalf.
const JEV_PROBE = JSON.stringify({ model: 'jev-latest', state: { message: 'I was charged twice. Please fix this ASAP.' },
  questions: { billing: { type: 'noul', instructions: 'Is this message about a billing problem?' } } });

async function limited(limit: RateLimit | undefined, request: Request): Promise<boolean> {
  if (!limit) return false;
  const key = request.headers.get('cf-connecting-ip') ?? 'unknown';
  return !(await limit.limit({ key })).success;
}

// Sync: the desktop app encrypts its snapshot with a key that only it and the paired phone
// hold, and stores the ciphertext under a channel id. The channel id is the SHA-256 of a write
// secret, so anyone can read ciphertext they cannot decrypt, but only the desktop can replace it.
const SYNC_MAX = 512 * 1024;
const SYNC_TTL_S = 14 * 86400;
const SYNC_MIN_GAP_S = 240;

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sync(request: Request, env: Env, channel: string, ch: Record<string, string>): Promise<Response> {
  if (!env.SYNC) return reply(501, { error: 'Sync is not set up on this relay' }, ch);
  if (!/^[0-9a-f]{64}$/.test(channel)) return reply(400, { error: 'Bad channel' }, ch);
  if (request.method === 'GET') {
    const v = await env.SYNC.get(channel);
    return v ? new Response(v, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...ch } }) : reply(404, { error: 'Nothing synced yet' }, ch);
  }
  if (request.method === 'PUT') {
    if (await limited(env.SYNC_LIMIT, request)) return reply(429, { error: 'Too many requests' }, ch);
    const secret = request.headers.get('x-sync-secret') ?? '';
    if (!secret || (await sha256Hex(secret)) !== channel) return reply(403, { error: 'Wrong write secret' }, ch);
    const body = await request.text();
    if (body.length > SYNC_MAX) return reply(413, { error: 'Snapshot too large' }, ch);
    // The free KV tier allows 1,000 writes a day, so one channel may be replaced at most every SYNC_MIN_GAP_S.
    const prior = await env.SYNC.getWithMetadata<{ at?: number }>(channel, { type: 'stream' });
    await prior.value?.cancel();
    if (prior.metadata?.at && Date.now() - prior.metadata.at < SYNC_MIN_GAP_S * 1000) return reply(429, { error: 'Synced too recently' }, ch);
    await env.SYNC.put(channel, body, { expirationTtl: SYNC_TTL_S, metadata: { at: Date.now() } });
    return reply(200, { ok: true }, ch);
  }
  return reply(405, { error: 'Method not allowed' }, ch);
}

function cors(origin: string, env: Env): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
    'access-control-allow-headers': 'content-type, x-sync-secret',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function reply(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('origin') ?? '';
    const ch = cors(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: ch['access-control-allow-origin'] ? 204 : 403, headers: ch });
    const url = new URL(request.url);
    // The desktop app has no browser origin, so sync writes are allowed without one; the
    // write secret is what protects them.
    const syncMatch = url.pathname.match(/^\/sync\/([^/]+)$/);
    if (syncMatch) return sync(request, env, syncMatch[1]!, ch);
    if (url.pathname !== '/fetch' || request.method !== 'POST') return reply(404, { error: 'Not found' }, ch);
    if (!ch['access-control-allow-origin']) return reply(403, { error: 'Origin not allowed' }, ch);

    if (await limited(env.FETCH_LIMIT, request)) return reply(429, { error: 'Too many requests' }, ch);
    const raw = await request.text();
    if (raw.length > MAX_BODY) return reply(413, { error: 'Request too large' }, ch);
    let req: { url?: string; method?: string; headers?: Record<string, string>; body?: string };
    try { req = JSON.parse(raw); } catch { return reply(400, { error: 'Body must be JSON' }, ch); }

    let target: URL;
    try { target = new URL(String(req.url)); } catch { return reply(400, { error: 'Bad url' }, ch); }
    const rule = ALLOWED[target.hostname];
    const method = (req.method ?? 'GET').toUpperCase();
    if (target.protocol !== 'https:' || !rule || !rule.path.test(target.pathname)) return reply(403, { error: 'Address not allowed' }, ch);
    if (!rule.methods.includes(method)) return reply(405, { error: 'Method not allowed' }, ch);
    if (target.hostname === 'api.typesafe.ai' && !sameJson(req.body, JEV_PROBE)) return reply(403, { error: 'Request not allowed' }, ch);

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      if (!/^(host|cookie|origin|referer|cf-|x-forwarded)/i.test(k)) headers.set(k, String(v));
    }
    headers.set('user-agent', 'augur-relay/1');

    const init: RequestInit = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(15000) };
    if (method === 'POST' && req.body !== undefined) init.body = req.body;
    let upstream: Response;
    try { upstream = await fetch(target.toString(), init); } catch { return reply(502, { error: 'Upstream did not answer' }, ch); }

    const out: Record<string, string> = {};
    upstream.headers.forEach((v, k) => { if (!DROP_RESPONSE_HEADERS.has(k)) out[k] = v; });
    return reply(200, { status: upstream.status, headers: out, body: await upstream.text() }, ch);
  },
};

function sameJson(body: string | undefined, expected: string): boolean {
  try { return JSON.stringify(JSON.parse(body ?? '')) === expected; } catch { return false; }
}
