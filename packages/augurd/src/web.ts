// The web app, served by the service itself. One engine runs in the service and the browser is a view of it, the way the terminal app is: it reads
// no provider and keeps no state of its own. Plain node http, no framework. Nothing listens unless the owner turns it on (web.enabled), the default
// address is this computer only, and every call carries a token that is separate from the owner's and the agent's.
//
// Wire format, newline-delimited JSON like the window app's bridge: GET /api/watch streams {t:'ready'|'change'|'views'|'ping'} lines, and
// POST /api/call {method, args} runs one engine command and answers {result} or {error}.
import { existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { ensureWebCert, webCertFingerprint, webCertNames } from './web-cert.js';
import { AccessVerifier } from './chat/access.js';
import { timingSafeEqual, X509Certificate } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callEngine, type EngineKey } from '@augur/core';
import { resetLedger } from '@augur/dispatch-protocol';
import type { TlsAuto, WebSettings } from './config.js';
import type { EngineLink } from './ipc.js';
import type { ChatService } from './chat/service.js';
import type { Principal } from './chat/principal.js';
import type { UserStore } from './chat/users.js';
import type { ChatUserCreate, ChatUserPatch } from '@augur/dispatch-protocol';
import { CHAT_FILE_MAX_MB, type ChatSendParams } from '@augur/dispatch-protocol';
import { DATA_TIERS, type DataTier } from '@augur/core';

const MAX_BODY = 8 * 1024 * 1024;
const KEEPALIVE_MS = 20_000;
const MAX_STREAM_BACKLOG = 32 * 1024 * 1024;
const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 60_000;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.map': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

/** The marker the served page carries, which tells the app to talk to this service instead of reading providers itself. */
export const SERVED_MARKER = '<meta name="augur-served" content="1">';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
/** How the web app is served: with the certificate the person set (own), with the one the service makes (auto), or over plain http (none). The service makes its own on a network bind by default and on loopback only when web.tlsAuto is on. */
export function webTlsMode(s: Pick<WebSettings, 'host' | 'tlsCert' | 'tlsKey'> & { tlsAuto?: TlsAuto }): 'own' | 'auto' | 'none' {
  if (s.tlsCert && s.tlsKey) return 'own';
  const mode = s.tlsAuto ?? 'auto';
  return mode === 'on' || (mode === 'auto' && !isLoopbackHost(s.host)) ? 'auto' : 'none';
}

export const isLoopbackHost = (host: string): boolean => LOOPBACK.has(host.toLowerCase()) || (isIP(host) === 4 && host.startsWith('127.'));

/** The host part of a Host header, lower case, without a port or brackets. */
export function hostOf(header: string | undefined): string {
  if (!header) return '';
  const h = header.trim().toLowerCase();
  if (h.startsWith('[')) { const end = h.indexOf(']'); return end > 0 ? h.slice(1, end) : ''; }
  return h.replace(/:\d+$/, '');
}

/**
 * Whether a request's Host header names this service. A page on a name an attacker controls (DNS rebinding) reaches here with that name in the Host
 * header, so only loopback, this computer's own names and addresses, and the names the owner listed are served. On a loopback bind, that is loopback only.
 */
export function hostAllowed(header: string | undefined, settings: Pick<WebSettings, 'host' | 'allowedHosts'>, machine = hostname().toLowerCase()): boolean {
  const h = hostOf(header);
  if (!h) return false;
  if (isLoopbackHost(h) || settings.allowedHosts.includes(h)) return true;
  if (isLoopbackHost(settings.host)) return false;
  // An address typed as a number cannot be a rebinding name, and the name this computer calls itself is the one a person on the network would type.
  return isIP(h) !== 0 || h === settings.host.toLowerCase() || h === machine || h === `${machine}.local`;
}

/** A request from a page must come from this same origin: a cross-origin page cannot forge a matching Origin header. No Origin (a script, curl) passes, and the token still applies. */
export function originAllowed(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (origin === undefined) return true;
  try { return new URL(origin).host.toLowerCase() === String(hostHeader ?? '').trim().toLowerCase(); } catch { return false; }
}

export interface WebDeps {
  scope?: 'full' | 'chat';
  accessFetcher?: import('./chat/access.js').AccessFetcher;
  certNames?: string[];
  users?: UserStore;
  settings: WebSettings;
  engine(): EngineLink | null;
  /** The current web token. Read at each request, so a rotated token takes effect at once. */
  token(): string;
  /** Folder of the built web app, or null when this build has none. */
  staticDir: string | null;
  log(message: string): void;
  /** Runs one dispatch call for POST /api/dispatch. Absent when the service has no dispatch to offer. */
  dispatch?(method: string, params: unknown, peer?: { address?: string; userAgent?: string }): Promise<unknown>;
  /** The service's data folder, where web.tlsAuto keeps its certificate. */
  dir?: string;
  /** The chat service behind /api/chat. Absent when this service has none. */
  chat?: ChatService;
}

const isLoopback = (addr: string | undefined): boolean => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
const safeEqual = (a: string, b: string): boolean => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export class WebServer {
  private server: http.Server | https.Server | null = null;
  private streams = new Set<http.ServerResponse>();
  private fails = new Map<string, { n: number; until: number }>();
  /** The address once listening. */
  bound: { host: string; port: number; tls: boolean; fingerprint?: string } | null = null;

  private access: AccessVerifier | null;
  private chatAssets = new Set<string>();

  constructor(private deps: WebDeps) {
    if (deps.scope === 'chat' && deps.staticDir) {
      const visit = (path: string): void => {
        if (this.chatAssets.has(path)) return;
        this.chatAssets.add(path);
        if (!/\.(?:html|js|css)$/.test(path)) return;
        let body: string;
        try { body = readFileSync(join(deps.staticDir!, path), 'utf8'); } catch { return; }
        for (const match of body.matchAll(/["'`(]((?:\.\.?\/|\/)?(?:assets\/)?[A-Za-z0-9_-]+-[A-Za-z0-9_-]+\.(?:js|css|woff2|png|svg))["'`)]/g)) {
          const asset = new URL(match[1]!, `http://local${path}`).pathname;
          if (/^\/assets\/[A-Za-z0-9_-]+\.(?:js|css|woff2|png|svg)$/.test(asset)) visit(asset);
        }
      };
      visit('/chat/index.html');
    }
    const s = deps.settings;
    this.access = deps.scope === 'chat' && s.accessTeam && s.accessAud ? new AccessVerifier(s.accessTeam, s.accessAud, deps.accessFetcher) : null;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      ...extra,
    };
  }

  private send(res: http.ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}): void {
    res.writeHead(status, this.headers({ 'Content-Type': type, 'Cache-Control': 'no-store', ...extra }));
    res.end(body);
  }

  private json(res: http.ServerResponse, status: number, value: unknown): void { this.send(res, status, JSON.stringify(value), 'application/json; charset=utf-8'); }

  /** Counts a bad token against the caller's address, and says whether the caller is now locked out. */
  private failed(addr: string): boolean {
    const now = Date.now(), f = this.fails.get(addr);
    const next = f && f.until > now ? { n: f.n + 1, until: f.until } : { n: 1, until: now + FAIL_WINDOW_MS };
    this.fails.set(addr, next);
    if (this.fails.size > 1000) for (const [k, v] of this.fails) if (v.until <= now) this.fails.delete(k);
    return next.n > FAIL_LIMIT;
  }

  private locked(addr: string): boolean { const f = this.fails.get(addr); return !!f && f.until > Date.now() && f.n > FAIL_LIMIT; }

  private async identify(req: http.IncomingMessage): Promise<Principal | 'unregistered' | null> {
    const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '');
    if (!m) {
      const assertion = req.headers['cf-access-jwt-assertion'];
      if (!this.access || /^Bearer\s+\S/i.test(req.headers.authorization ?? '') || typeof assertion !== 'string') return null;
      const email = await this.access.email(assertion);
      if (email === null) return null;
      const user = this.deps.users?.findByEmail(email);
      return user && !user.disabled ? { kind: 'user', user: user.id, via: 'access' } : 'unregistered';
    }
    if (this.deps.scope !== 'chat' && safeEqual(m[1]!, this.deps.token())) return { kind: 'owner' };
    const found = this.deps.users?.resolve(m[1]!);
    return found ? { kind: 'user', user: found.user.id, ...(found.device ? { device: found.device.id } : {}) } : null;
  }

  /** Failed credentials share one address lockout across every API path. */
  private async authorize(req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<Principal | null> {
    const addr = req.socket.remoteAddress ?? '?';
    if (this.locked(addr)) { this.send(res, 429, 'Too many wrong tokens. Wait a minute.', 'text/plain; charset=utf-8', { 'Retry-After': '60' }); return null; }
    const principal = await this.identify(req);
    if (principal === 'unregistered') { this.failed(addr); this.send(res, 403, 'This person is not set up for Augur Chat.'); return null; }
    if (principal && (principal.kind === 'owner' || path.startsWith('/api/chat/'))) { this.fails.delete(addr); return principal; }
    this.failed(addr);
    this.send(res, 401, 'Missing or wrong token.', 'text/plain; charset=utf-8', { 'WWW-Authenticate': 'Bearer' });
    return null;
  }

  private handle = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    void this.route(req, res).catch(e => { this.deps.log(`web request failed: ${(e as Error).message}`); if (!res.headersSent) this.send(res, 500, 'The request failed.'); else res.destroy(); });
  };

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!hostAllowed(req.headers.host, this.deps.settings)) { this.send(res, 421, 'This address is not one the service serves. Open it by this computer\'s own name or address.'); return; }
    if (!originAllowed(req.headers.origin, req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site') { this.send(res, 403, 'Cross-origin requests are refused.'); return; }
    const url = new URL(req.url ?? '/', 'http://x'), path = url.pathname;
    if (this.deps.scope === 'chat') {
      if (path === '/') { this.send(res, 302, '', 'text/plain; charset=utf-8', { Location: '/chat/' }); return; }
      if (!path.startsWith('/api/chat/') && !this.chatFile(path)) { this.send(res, 404, 'No such call.'); return; }
    }
    const principal = path.startsWith('/api/') ? await this.authorize(req, res, path) : null;
    if (path.startsWith('/api/') && !principal) return;
    if (path.startsWith('/api/admin/chat/')) { void this.adminChatRoute(req, res, url, principal!); return; }
    if (path === '/api/watch') { if (req.method !== 'GET') { this.send(res, 405, 'Use GET.'); return; } this.watch(req, res); return; }
    if (path === '/api/resets') {
      if (req.method !== 'GET') { this.send(res, 405, 'Use GET.'); return; }
      const engine = this.deps.engine();
      if (!engine) { this.json(res, 503, { error: 'The usage engine is not running in this service.' }); return; }
      try {
        this.json(res, 200, resetLedger(engine.api.state.resets, {
          ...(url.searchParams.has('provider') ? { provider: url.searchParams.get('provider')! } : {}),
          ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
        }));
      } catch (e) { this.json(res, 400, { error: (e as Error).message }); }
      return;
    }
    if (path === '/api/call') {
      if (req.method !== 'POST') { this.send(res, 405, 'Use POST.'); return; }
      // A form or a cross-origin script cannot send this type without a preflight, which this server never grants.
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) { this.send(res, 415, 'Send application/json.'); return; }
      this.call(req, res);
      return;
    }
    if (path === '/api/dispatch') {
      if (req.method !== 'POST') { this.send(res, 405, 'Use POST.'); return; }
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) { this.send(res, 415, 'Send application/json.'); return; }
      // A job can run tools on this computer, so only a program on this computer may start one, even with the right token.
      // A reverse proxy on this computer connects from loopback on behalf of a remote client, and it says so in a forwarding header.
      const proxied = ['x-forwarded-for', 'forwarded', 'x-real-ip'].some(h => req.headers[h] !== undefined);
      if (proxied || !isLoopback(req.socket.remoteAddress)) { this.send(res, 403, 'Dispatch answers only to programs on this computer.'); return; }
      this.dispatchCall(req, res);
      return;
    }
    if (path.startsWith('/api/chat/')) { void this.chatRoute(req, res, url, principal!); return; }
    if (path.startsWith('/api/')) { this.send(res, 404, 'No such call.'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { this.send(res, 405, 'Use GET.'); return; }
    this.file(path, req.method === 'HEAD', res);
  }

  private chatFile(path: string): boolean {
    return path === '/chat/' || path === '/chat/index.html' || this.chatAssets.has(path) || ['/chat-theme.js', '/chat.webmanifest', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png'].includes(path);
  }

  private file(path: string, head: boolean, res: http.ServerResponse): void {
    const root = this.deps.staticDir;
    if (!root) { this.send(res, 404, 'This build of Augur does not include the web app.'); return; }
    let rel: string;
    try { rel = decodeURIComponent(path); } catch { this.send(res, 400, 'Bad path.'); return; }
    if (rel.includes('\0') || rel.includes('\\')) { this.send(res, 400, 'Bad path.'); return; }
    if (this.deps.scope === 'chat' && !this.chatFile(normalize(rel).replace(/\\/g, '/'))) { this.send(res, 404, 'No such call.'); return; }
    const full = resolve(root, '.' + normalize('/' + rel));
    if (full !== root && !full.startsWith(root + sep)) { this.send(res, 403, 'Not served.'); return; }
    let target = full;
    try { if (statSync(target).isDirectory()) target = join(target, 'index.html'); } catch { this.send(res, 404, 'Not found.'); return; }
    if (!existsSync(target)) { this.send(res, 404, 'Not found.'); return; }
    const type = TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
    let body: Buffer | string = readFileSync(target);
    // The page is told it is served by the service. It is not a file in the build, so the same build also works as the hosted web app.
    if (extname(target) === '.html') body = body.toString('utf8').replace(/<head(\s[^>]*)?>/i, m => `${m}${SERVED_MARKER}`);
    const cache = /\/assets\//.test(target.replace(/\\/g, '/')) ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, this.headers({ 'Content-Type': type, 'Cache-Control': cache, 'Content-Length': String(Buffer.byteLength(body)) }));
    res.end(head ? undefined : body);
  }

  private watch(req: http.IncomingMessage, res: http.ServerResponse): void {
    const engine = this.deps.engine();
    if (!engine) { this.send(res, 503, 'The usage engine is not running in this service.'); return; }
    res.writeHead(200, this.headers({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }));
    const connectedWith = this.deps.token();
    const write = (m: unknown) => {
      if (res.destroyed) return;
      if (res.writableLength > MAX_STREAM_BACKLOG) { res.destroy(); return; }
      res.write(JSON.stringify(m) + '\n');
    };
    // The browser shows the engine and answers none of its requests, so it connects as a view with no capabilities.
    const view = engine.views.add({ kind: 'terminal', caps: [] }, () => undefined);
    const stateOf = (keys: readonly EngineKey[]) => Object.fromEntries(keys.filter(k => k in engine.api.state).map(k => [k, engine.api.state[k]]));
    const offChange = engine.api.onChange(keys => write({ t: 'change', keys, state: stateOf(keys) }));
    const offViews = engine.views.onChange(() => write({ t: 'views', views: engine.views.info() }));
    this.streams.add(res);
    // A rotated token ends every stream that was opened with the old one.
    const timer = setInterval(() => { if (!safeEqual(connectedWith, this.deps.token())) res.end(); else write({ t: 'ping' }); }, KEEPALIVE_MS);
    const done = () => { clearInterval(timer); offChange(); offViews(); engine.views.remove(view); this.streams.delete(res); };
    res.on('close', done);
    req.on('error', () => undefined);
    write({ t: 'ready', state: engine.api.state, views: engine.views.info() });
  }

  private call(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    let size = 0, tooBig = false;
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { tooBig = true; return; } chunks.push(c); });
    req.on('error', () => undefined);
    req.on('end', () => {
      if (tooBig) { this.send(res, 413, 'The request is too large.'); return; }
      let body: { method?: unknown; args?: unknown };
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body; } catch { this.json(res, 400, { error: 'The request is not JSON.' }); return; }
      const engine = this.deps.engine();
      if (!engine) { this.json(res, 503, { error: 'The usage engine is not running in this service.' }); return; }
      if (typeof body !== 'object' || body === null || typeof body.method !== 'string') { this.json(res, 400, { error: 'The request needs a method.' }); return; }
      callEngine(engine.api, body.method, Array.isArray(body.args) ? body.args : [])
        .then(result => this.json(res, 200, { result: result ?? null }), (e: Error) => this.json(res, 400, { error: e.message || 'failed' }));
    });
  }

  /** Reads a request body up to `limit` bytes. Resolves null, after answering 413, when it is larger. */
  private readBody(req: http.IncomingMessage, res: http.ServerResponse, limit: number): Promise<Buffer | null> {
    return new Promise(done => {
      const chunks: Buffer[] = [];
      let size = 0, over = false;
      req.on('data', (c: Buffer) => { size += c.length; if (size > limit) { over = true; return; } chunks.push(c); });
      req.on('error', () => done(null));
      req.on('end', () => { if (over) { this.send(res, 413, 'The request is too large.'); done(null); } else done(Buffer.concat(chunks)); });
    });
  }

  private async readJson(req: http.IncomingMessage, res: http.ServerResponse): Promise<Record<string, unknown> | null> {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) { this.send(res, 415, 'Send application/json.'); return null; }
    const raw = await this.readBody(req, res, MAX_BODY);
    if (!raw) return null;
    try { const v = JSON.parse(raw.toString('utf8')) as unknown; if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>; } catch { /* falls through */ }
    this.json(res, 400, { error: 'The request is not a JSON object.' });
    return null;
  }

  /** /api/chat/...: the model list, saved and temporary chats, files, and the streamed reply. Every call here has passed the token check. */
  private async chatRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, principal: Principal): Promise<void> {
    const chat = this.deps.chat;
    if (!chat) { this.json(res, 503, { error: 'This service has no chat to offer.' }); return; }
    const fail = (e: unknown) => { if (!res.headersSent) this.json(res, e instanceof Error && e.message === 'No such chat.' ? 404 : 400, { error: e instanceof Error ? e.message : 'The request failed.' }); else res.end(); };
    const tier = (v: unknown): DataTier | undefined => (typeof v === 'string' && (DATA_TIERS as readonly string[]).includes(v) ? v as DataTier : undefined);
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
    try {
      const parts = url.pathname.slice('/api/chat/'.length).split('/').filter(Boolean).map(decodeURIComponent), method = req.method ?? 'GET';
      const me = chat.me(principal);
      if (parts[0] === 'me' && method === 'GET') { this.json(res, 200, me); return; }
      if (parts[0] === 'models' && method === 'GET') { this.json(res, 200, { models: await chat.models(principal) }); return; }
      if (parts[0] === 'chats') {
        if (parts.length === 1 && method === 'GET') { this.json(res, 200, { chats: url.searchParams.has('q') ? chat.search(principal, url.searchParams.get('q') ?? '') : chat.list(principal) }); return; }
        if (parts.length === 1 && method === 'POST') {
          const b = await this.readJson(req, res);
          if (!b) return;
          const route = str(b.route);
          if (!route) { this.json(res, 400, { error: 'A chat needs a route.' }); return; }
          const settings = obj(b.settings);
          this.json(res, 200, chat.create(principal, { route, ...(tier(b.tier) ? { tier: tier(b.tier)! } : {}), temporary: b.temporary === true, ...(str(b.title) ? { title: str(b.title)! } : {}), ...(str(b.system) ? { system: str(b.system)! } : {}), ...(settings ? { settings } : {}) }));
          return;
        }
        const id = parts[1];
        if (id && parts.length === 2 && method === 'GET') { const c = chat.get(principal, id); if (c) this.json(res, 200, c); else this.json(res, 404, { error: 'No such chat.' }); return; }
        if (id && parts.length === 2 && method === 'PATCH') {
          const b = await this.readJson(req, res);
          if (!b) return;
          const settings = obj(b.settings);
          this.json(res, 200, chat.update(principal, id, {
            ...(str(b.title) !== undefined ? { title: str(b.title)! } : {}), ...(str(b.route) ? { route: str(b.route)! } : {}), ...(tier(b.tier) ? { tier: tier(b.tier)! } : {}),
            ...(typeof b.pinned === 'boolean' ? { pinned: b.pinned } : {}), ...(str(b.system) !== undefined ? { system: str(b.system)! } : {}), ...(settings ? { settings } : {}),
            ...(b.head === null || typeof b.head === 'string' ? { head: b.head as string | null } : {}),
          }));
          return;
        }
        if (id && parts.length === 2 && method === 'DELETE') { this.json(res, 200, { removed: chat.remove(principal, id) }); return; }
        if (id && parts[2] === 'stop' && method === 'POST') { this.json(res, 200, { stopped: chat.stop(principal, id) }); return; }
        if (id && parts[2] === 'files' && method === 'POST') {
          const raw = await this.readBody(req, res, CHAT_FILE_MAX_MB * 1048576 + 1024);
          if (!raw) return;
          let name = 'file';
          try { name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'file')); } catch { /* keeps the plain name */ }
          this.json(res, 200, chat.upload(principal, id, name, String(req.headers['content-type'] ?? ''), raw));
          return;
        }
      }
      if (parts[0] === 'files' && parts[1] && method === 'GET') {
        const f = chat.file(principal, parts[1]);
        if (!f) { this.json(res, 404, { error: 'No such chat.' }); return; }
        // Only images, audio and plain text play inline; anything else downloads, so an uploaded page can never run from this origin.
        const svg = f.ref.mime === 'image/svg+xml', inline = !svg && (f.ref.kind === 'image' || f.ref.kind === 'audio' || f.ref.mime === 'text/plain');
        res.writeHead(200, this.headers({ 'Content-Type': inline ? f.ref.mime : 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': String(f.bytes.byteLength),
          'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.ref.name)}` }));
        res.end(Buffer.from(f.bytes));
        return;
      }
      if (parts[0] === 'send' && method === 'POST') {
        const b = await this.readJson(req, res);
        if (!b) return;
        const chatId = str(b.chat);
        if (!chatId) { this.json(res, 400, { error: 'A send needs a chat.' }); return; }
        const params: ChatSendParams = {
          chat: chatId, text: str(b.text) ?? '', ...(Array.isArray(b.files) ? { files: b.files.filter((x): x is string => typeof x === 'string') } : {}),
          ...(b.parent === null || typeof b.parent === 'string' ? { parent: b.parent as string | null } : {}), ...(str(b.retry) ? { retry: str(b.retry)! } : {}), ...(str(b.route) ? { route: str(b.route)! } : {}),
        };
        if (!chat.get(principal, chatId)) { this.json(res, 404, { error: 'No such chat.' }); return; }
        res.writeHead(200, this.headers({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }));
        this.streams.add(res);
        // A browser that goes away ends the reply it was reading.
        res.on('close', () => { this.streams.delete(res); try { chat.stop(principal, chatId); } catch { /* the chat or credentials can be removed during a reply */ } });
        for await (const ev of chat.send(principal, params)) {
          if (res.destroyed) break;
          if (res.writableLength > MAX_STREAM_BACKLOG) { res.destroy(); break; }
          res.write(JSON.stringify(ev) + '\n');
        }
        res.end();
        return;
      }
      this.json(res, 404, { error: 'No such call.' });
    } catch (e) { fail(e); }
  }

  private async adminChatRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, principal: Principal): Promise<void> {
    if (principal.kind !== 'owner') { this.send(res, 401, 'Missing or wrong token.'); return; }
    const users = this.deps.users;
    if (!users) { this.json(res, 503, { error: 'This service has no user store.' }); return; }
    try {
      const parts = url.pathname.slice('/api/admin/chat/'.length).split('/').filter(Boolean).map(decodeURIComponent), method = req.method;
      if (parts.length === 1 && parts[0] === 'routes' && method === 'GET') { this.json(res, 200, { routes: await this.deps.chat?.models(principal) ?? [] }); return; }
      if (parts[0] !== 'users') { this.json(res, 404, { error: 'No such call.' }); return; }
      if (parts.length === 1 && method === 'GET') { this.json(res, 200, { users: users.listUsers() }); return; }
      if (parts.length === 1 && method === 'POST') {
        const body = await this.readJson(req, res);
        if (body) this.json(res, 200, users.addUser(body as unknown as ChatUserCreate));
        return;
      }
      const id = parts[1];
      if (!id || !users.getUser(id)) { this.json(res, 404, { error: 'No such user.' }); return; }
      if (parts.length === 2 && method === 'PATCH') {
        const body = await this.readJson(req, res);
        if (body) this.json(res, 200, users.updateUser(id, body as ChatUserPatch));
        return;
      }
      if (parts.length === 2 && method === 'DELETE') {
        if (url.searchParams.get('purge') === '1') this.deps.chat?.purge(principal, id);
        else this.deps.chat?.orphan(principal, id);
        this.json(res, 200, { removed: users.removeUser(id) });
        return;
      }
      if (parts.length === 3 && parts[2] === 'token' && method === 'POST') { this.json(res, 200, users.rotateUserToken(id)); return; }
      if (parts.length === 3 && parts[2] === 'devices' && method === 'POST') {
        const body = await this.readJson(req, res);
        if (body) {
          if (Object.keys(body).some(k => k !== 'label')) throw new Error('The device settings contain an unknown field.');
          this.json(res, 200, users.addDevice(id, body.label as string));
        }
        return;
      }
      if (parts.length === 4 && parts[2] === 'devices' && method === 'DELETE') { this.json(res, 200, { revoked: users.revokeDevice(id, parts[3]!) }); return; }
      this.json(res, 404, { error: 'No such call.' });
    } catch (e) { this.json(res, 400, { error: e instanceof Error ? e.message : 'The request failed.' }); }
  }

  /** POST /api/dispatch with `{ method, params }`. The answer is `{ result }`, or `{ error }` with status 400. */
  private dispatchCall(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    let size = 0, tooBig = false;
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { tooBig = true; return; } chunks.push(c); });
    req.on('error', () => undefined);
    req.on('end', () => {
      if (tooBig) { this.send(res, 413, 'The request is too large.'); return; }
      let body: { method?: unknown; params?: unknown };
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body; } catch { this.json(res, 400, { error: 'The request is not JSON.' }); return; }
      if (typeof body !== 'object' || body === null || typeof body.method !== 'string') { this.json(res, 400, { error: 'The request needs a method.' }); return; }
      const run = this.deps.dispatch;
      if (!run) { this.json(res, 503, { error: 'This service has no dispatch to offer.' }); return; }
      run(body.method, body.params, { address: req.socket.remoteAddress, userAgent: req.headers['user-agent'] }).then(result => this.json(res, 200, { result: result ?? null }), (e: Error) => this.json(res, 400, { error: e.message || 'failed' }));
    });
  }

  start(): Promise<{ host: string; port: number; tls: boolean; fingerprint?: string }> {
    const s = this.deps.settings;
    let server: http.Server | https.Server;
    const mode = webTlsMode(s), own = mode === 'own', auto = mode === 'auto' && !!this.deps.dir;
    const tls = own || auto;
    let fingerprint: string | undefined;
    if (own) {
      try { const cert = readFileSync(s.tlsCert); fingerprint = new X509Certificate(cert).fingerprint256; server = https.createServer({ cert, key: readFileSync(s.tlsKey) }, this.handle); }
      catch (e) { return Promise.reject(new Error(`The web app's certificate or key could not be read (${(e as Error).message}).`)); }
    } else if (auto) {
      try {
        const had = webCertFingerprint(this.deps.dir!) !== null, made = ensureWebCert(this.deps.dir!, this.deps.certNames ?? webCertNames(s));
        fingerprint = made.fingerprint;
        if (made.created) this.deps.log(had ? 'web app made a new self-signed certificate, and browsers that trusted the old one will warn again' : 'web app made a new self-signed certificate');
        server = https.createServer({ cert: made.cert, key: made.key }, this.handle);
      } catch (e) { return Promise.reject(new Error(`The web app could not make its certificate (${(e as Error).message}).`)); }
    } else server = http.createServer(this.handle);
    server.headersTimeout = 15_000; server.requestTimeout = 120_000; server.keepAliveTimeout = 10_000;
    return new Promise((resolveStart, reject) => {
      server.once('error', reject);
      server.listen(s.port, s.host, () => {
        server.off('error', reject);
        server.on('error', e => this.deps.log(`web server error: ${e.message}`));
        this.server = server;
        this.bound = { host: s.host, port: s.port, tls, ...(fingerprint ? { fingerprint } : {}) };
        resolveStart(this.bound);
      });
    });
  }

  close(): Promise<void> {
    return new Promise(done => {
      for (const r of this.streams) r.destroy();
      if (!this.server) return done();
      this.server.close(() => done());
      this.server.closeAllConnections?.();
    });
  }
}

/** Where the built web app is: AUGURD_WEB_DIR, a web folder beside the service files, or the UI's build in a source checkout. */
export function webDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const d of [env.AUGURD_WEB_DIR, join(here, 'web'), join(here, '..', '..', '..', 'apps', 'ui', 'dist')]) {
    if (d && existsSync(join(d, 'index.html'))) return resolve(d);
  }
  return null;
}

/** The addresses a person can open the web app at: this computer for a loopback bind, every IPv4 address of this computer for a wildcard bind, or the address itself. */
export function webAddresses(settings: Pick<WebSettings, 'host' | 'port' | 'tlsCert' | 'tlsKey'> & { tlsAuto?: TlsAuto }, interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const scheme = webTlsMode(settings) === 'none' ? 'http' : 'https', host = settings.host;
  const wildcard = host === '0.0.0.0' || host === '::';
  const hosts = wildcard
    ? ['localhost', ...Object.values(interfaces).flatMap(list => (list ?? []).filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address))]
    : [host === '::1' ? '[::1]' : host];
  return hosts.map(h => `${scheme}://${h}:${settings.port}/`);
}
