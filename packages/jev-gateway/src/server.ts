// The gateway's HTTP listener: the System One protocol on a local address, with the model, the key, the Danger Zone headers and the data rules held here.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { PoolClientError, PoolError, ServerPool } from '@augur/decision';
import type { Fetch } from '@augur/decision';
import { ConfigFile, isLoopback } from './config.js';
import type { GatewayConfig } from './config.js';
import { KeyCache, readKey } from './key.js';
import { IMAGES_HEADER, LONG_HEADER, plan } from './policy.js';
import { UsageLog } from './usage.js';
import type { UsageRow } from './usage.js';

export interface GatewayOptions {
  configFile?: ConfigFile;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  /** The Laya pool's own fetcher, for tests. */
  poolFetcher?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  key?: KeyCache;
}

/** Marks a response the gateway made itself, as opposed to one passed through from the upstream. */
export const GATEWAY_HEADER = 'x-augur-gateway';
/** Present when the gateway refused a request on a rule. A caller must not retry such a request somewhere else. */
export const REFUSED_HEADER = 'x-augur-refused';

const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const LOOPBACK_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i;

class HttpError extends Error { constructor(readonly status: number, message: string, readonly refused = false) { super(message); } }

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();

/** The consumer a bearer token belongs to, or null. Every stored hash is compared, so the time taken does not say which one matched. */
export function consumerOf(config: GatewayConfig, token: string | null): string | null {
  if (!token) return null;
  const h = sha256(token);
  let found: string | null = null;
  for (const [name, hex] of Object.entries(config.consumers)) if (timingSafeEqual(h, Buffer.from(hex, 'hex')) && !found) found = name;
  return found;
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'The request body is over the size limit.');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function decode(body: Buffer, encoding: string | undefined, limit: number): Buffer {
  const e = (encoding ?? 'identity').trim().toLowerCase();
  if (e === 'identity' || e === '') return body;
  try {
    const out = e === 'gzip' ? gunzipSync(body, { maxOutputLength: limit }) : e === 'zstd' ? zstdDecompressSync(body, { maxOutputLength: limit }) : null;
    if (out) return out;
  } catch { throw new HttpError(400, `The ${e}-encoded body could not be read, or it expands past the size limit.`); }
  throw new HttpError(415, 'Content-Encoding must be identity, gzip or zstd.');
}

const first = (v: string | string[] | undefined): string | undefined => Array.isArray(v) ? v[0] : v;

export function createGateway(opts: GatewayOptions = {}): { server: HttpServer; usage: UsageLog; config: ConfigFile } {
  const env = opts.env ?? process.env, configFile = opts.configFile ?? new ConfigFile(undefined, env), doFetch = opts.fetcher ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms))), now = opts.now ?? Date.now;
  const usage = new UsageLog(() => configFile.get().config.usageLog);
  const key = opts.key ?? new KeyCache(() => readKey(configFile.get().config.key, env));
  const pools = new Map<string, ServerPool>();
  const poolFor = (c: GatewayConfig): ServerPool => {
    const id = JSON.stringify(c.laya);
    let p = pools.get(id);
    if (!p) { p = new ServerPool(c.laya, opts.poolFetcher); pools.set(id, p); }
    return p;
  };

  const send = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), [GATEWAY_HEADER]: '1', ...extra });
    res.end(text);
  };

  /** Throws a refusal when the request may not use the gateway, and otherwise names the consumer. */
  function authenticate(c: GatewayConfig, req: IncomingMessage): string {
    const bearer = /^Bearer\s+(\S+)$/i.exec(first(req.headers.authorization) ?? '')?.[1] ?? null;
    const named = consumerOf(c, bearer);
    if (named) return named;
    if (c.requireToken) throw new HttpError(401, 'A valid consumer token is required.', true);
    // Without tokens the listener is for this computer only. A browser page could still reach it, so a request with an Origin header, or one addressed to another host name, is refused.
    if (req.headers.origin) throw new HttpError(403, 'Requests from a web page are not accepted.', true);
    if (!LOOPBACK_HOST.test(first(req.headers.host) ?? '')) throw new HttpError(403, 'Without a consumer token the gateway answers only requests addressed to this computer.', true);
    const label = first(req.headers['x-augur-consumer'])?.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 48);
    return label || 'local';
  }

  async function hosted(c: GatewayConfig, p: ReturnType<typeof plan>, row: UsageRow): Promise<{ status: number; body: string; model: string | null }> {
    const apiKey = key.get();
    if (!apiKey) throw new HttpError(503, 'The gateway has no API key for the hosted model. Set one in its key source.');
    const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
    if (p.images) headers[IMAGES_HEADER] = 'true';
    if (p.longContext) headers[LONG_HEADER] = 'true';
    const body = JSON.stringify(p.body);
    let last: { status: number; body: string } | null = null;
    for (let attempt = 0; attempt <= c.retries; attempt++) {
      row.attempts = attempt + 1;
      try {
        const r = await doFetch(c.endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(c.timeoutMs) });
        last = { status: r.status, body: await r.text() };
        if (r.status === 401) key.forget();
        if (!RETRY_STATUS.has(r.status)) break;
      } catch (e) {
        last = null;
        row.reason = `upstream unreachable: ${(e as Error).name}`;
        if (attempt === c.retries) throw new HttpError(502, 'The hosted model did not answer.');
      }
      if (attempt < c.retries) await sleep(400 * 2 ** attempt);
    }
    if (!last) throw new HttpError(502, 'The hosted model did not answer.');
    let model: string | null = null;
    try {
      const parsed = JSON.parse(last.body) as { model?: unknown; usage?: unknown };
      if (typeof parsed.model === 'string') model = parsed.model;
      if (parsed.usage && last.status < 400) row.usage = parsed.usage;
    } catch { /* a body that is not JSON is passed on as it is */ }
    return { ...last, model };
  }

  async function laya(c: GatewayConfig, p: ReturnType<typeof plan>, row: UsageRow): Promise<{ status: number; body: string; model: string | null }> {
    try {
      const { result, server } = await poolFor(c).post('/v1/systemone', p.body);
      row.server = server;
      const model = typeof (result as { model?: unknown })?.model === 'string' ? (result as { model: string }).model : p.model;
      return { status: 200, body: JSON.stringify(result), model };
    } catch (e) {
      if (e instanceof PoolClientError) throw new HttpError(e.status, 'The Laya server refused the request.');
      if (e instanceof PoolError) { row.reason = `no Laya server answered: ${Object.entries(e.reasons).map(([k, v]) => `${k}: ${v}`).join('; ')}`.slice(0, 300); throw new HttpError(503, 'No Laya server answered, and this request is never sent to the hosted model.', true); }
      throw e;
    }
  }

  async function systemone(req: IncomingMessage, res: ServerResponse, c: GatewayConfig, consumer: string, started: number): Promise<void> {
    const limit = Math.floor(c.maxBodyMb * 1024 * 1024);
    if (/^multipart\//i.test(first(req.headers['content-type']) ?? '')) throw new HttpError(415, 'Send images in the JSON assets map as base64. Multipart upload is not supported by the gateway.');
    const raw = decode(await readBody(req, limit), first(req.headers['content-encoding']), limit);
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'The request body is not valid JSON.'); }
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = first(v);
    const p = plan(c, parsed, headers);
    const row: UsageRow = { at: new Date(started).toISOString(), consumer, route: p.refuse ? 'refused' : p.route, tier: p.tier, tierSource: p.tierSource,
      modelAsked: typeof (parsed as { model?: unknown })?.model === 'string' ? (parsed as { model: string }).model : null, modelSent: p.refuse ? null : p.model, modelAnswered: null,
      status: 0, ms: 0, images: p.images, longContext: p.longContext };
    try {
      if (p.refuse) { row.reason = p.refuse.detail; throw new HttpError(p.refuse.status, p.refuse.detail, true); }
      const out = p.route === 'hosted' ? await hosted(c, p, row) : await laya(c, p, row);
      row.status = out.status; row.modelAnswered = out.model;
      res.writeHead(out.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out.body), 'x-augur-route': p.route, 'x-augur-model': out.model ?? p.model, 'x-augur-tier': p.tier, 'x-augur-tier-source': p.tierSource });
      res.end(out.body);
    } catch (e) {
      if (e instanceof HttpError) row.status = e.status; else row.status = 500;
      row.reason ??= e instanceof HttpError ? e.message : 'internal error';
      throw e;
    } finally { row.ms = now() - started; usage.write(row); }
  }

  const server = createServer((req, res) => {
    const started = now(), { config: c } = configFile.get();
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://gateway');
      try {
        if (req.method === 'GET' && url.pathname === '/health') {
          const loop = isLoopback(c.host);
          return send(res, 200, { ok: true, model: c.model, hostedKey: !!key.get(), laya: c.laya.map(s => s.name), tokens: c.requireToken, loopback: loop, defaultTier: c.defaultTier });
        }
        const consumer = authenticate(c, req);
        if (req.method === 'POST' && url.pathname === '/v1/systemone') return await systemone(req, res, c, consumer, started);
        if (req.method === 'GET' && url.pathname === '/usage') return send(res, 200, usage.summary(Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7)), now()));
        throw new HttpError(404, 'Not found.');
      } catch (e) {
        if (res.headersSent) { res.end(); return; }
        const err = e instanceof HttpError ? e : new HttpError(500, 'The gateway failed on this request.');
        send(res, err.status, { error: { status: err.status, type: 'augur_gateway', message: err.message } }, err.refused ? { [REFUSED_HEADER]: '1' } : {});
      }
    })();
  });
  // A caller that stalls cannot hold a connection open for long.
  server.headersTimeout = 15000; server.requestTimeout = 120000;
  return { server, usage, config: configFile };
}
