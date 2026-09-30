// The service's control endpoint: a named pipe (a socket file elsewhere), one JSON line per request, every request carrying the token.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@augur/dispatch-protocol';
import type { JobRequest, MethodName, RateCard, RouteConfig, RpcRequest, RpcResponse } from '@augur/dispatch-protocol';
import { buildAccounting } from './accounting.js';
import type { Store } from './store.js';
import type { Supervisor } from './supervisor.js';

const MAX_LINE = 16 * 1024 * 1024;

/** The token sits in the service's data folder, which is inside the user's profile. Callers read it from there. */
export function ensureToken(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'token');
  if (existsSync(path)) { const t = readFileSync(path, 'utf8').trim(); if (t.length >= 32) return t; }
  const token = randomBytes(32).toString('hex');
  writeFileSync(path, token, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows uses the profile folder's ACL */ }
  return token;
}

export class IpcServer {
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  private readonly startedAt = Date.now();
  constructor(private sup: Supervisor, private store: Store, private token: string, private routes: () => Record<string, RouteConfig> | null, private rates: () => RateCard = () => ({})) {}

  private handle(method: MethodName, params: unknown): unknown | Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'ping': return { pid: process.pid, version: PROTOCOL_VERSION, startedAt: this.startedAt };
      case 'submit': return this.sup.submit(params as JobRequest);
      case 'status': return this.store.get(String(p.id));
      case 'list': return this.store.list({ state: p.state as never, root: p.root as string | undefined, limit: p.limit as number | undefined });
      case 'events': return this.store.events(String(p.id), Number(p.since ?? 0));
      case 'logs': return this.sup.logs(String(p.id), p.stream === 'stderr' ? 'stderr' : 'stdout', Number(p.offset ?? 0), Number(p.limit ?? 65536));
      case 'result': return this.sup.result(String(p.id));
      case 'cancel': return this.sup.cancel(String(p.id));
      case 'apply': return this.sup.apply(String(p.id), p.check === true);
      case 'pick': return this.sup.pick(params as never);
      case 'human_prompt': return this.sup.humanPrompt(String(p.session ?? ''), String(p.text ?? ''));
      case 'pressure': return this.sup.pressure();
      case 'routes': return Object.entries(this.routes() ?? {}).map(([name, r]) => ({ name, model: r.model, adapter: r.adapter, problem: this.sup.routeProblem(r as RouteConfig) }));
      case 'accounting': { const limit = Math.min(Math.max(Number(p.limit ?? 100), 1), 500); return buildAccounting(this.store.list({ limit: 500 }), this.routes(), this.rates(), limit); }
      default: throw new Error(`unknown method ${String(method)}`);
    }
  }

  private authorized(given: unknown): boolean {
    const a = Buffer.from(String(given ?? '')), b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  start(pipe: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer(sock => {
        this.sockets.add(sock); sock.on('close', () => this.sockets.delete(sock));
        let buf = '';
        sock.setEncoding('utf8');
        sock.on('error', () => { /* a caller that vanished */ });
        sock.on('data', (chunk: string) => {
          buf += chunk;
          if (buf.length > MAX_LINE) { sock.destroy(); return; }
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            let req: RpcRequest;
            try { req = JSON.parse(line) as RpcRequest; } catch { sock.write(JSON.stringify({ id: 0, error: { code: 'bad_json', message: 'Request is not JSON.' } }) + '\n'); continue; }
            const respond = async (): Promise<RpcResponse> => {
              if (!this.authorized(req.token)) return { id: req.id, error: { code: 'unauthorized', message: 'Missing or wrong token.' } };
              try { return { id: req.id, result: (await this.handle(req.method, req.params)) ?? null }; } catch (e) { return { id: req.id, error: { code: 'failed', message: (e as Error).message } }; }
            };
            void respond().then(res => { if (!sock.destroyed) sock.write(JSON.stringify(res) + '\n'); });
          }
        });
      });
      server.once('error', reject);
      server.listen(pipe, () => { server.off('error', reject); this.server = server; resolve(); });
    });
  }

  close(): Promise<void> { return new Promise(res => { if (!this.server) return res(); this.server.close(() => res()); for (const s of this.sockets) s.destroy(); }); }
}
