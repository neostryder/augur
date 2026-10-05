// The service's control endpoint: a named pipe (a socket file elsewhere), one JSON line per request, every request carrying the token.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@augur/dispatch-protocol';
import type { EngineEvent, JobRequest, MethodName, RateCard, RouteConfig, RpcRequest, RpcResponse, ViewHello, ViewReply } from '@augur/dispatch-protocol';
import { callEngine, type EngineApi, type EngineKey, type EngineState } from '@augur/core';
import { buildAccounting } from './accounting.js';
import type { Store } from './store.js';
import type { Supervisor } from './supervisor.js';
import type { ViewHub, ViewLink } from './views.js';

/** The usage engine as the control endpoint serves it: its commands and state, and the views connected to it. */
export interface EngineLink { api: EngineApi; views: ViewHub }

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
  private engine: EngineLink | null = null;
  constructor(private sup: Supervisor, private store: Store, private token: string, private routes: () => Record<string, RouteConfig> | null, private rates: () => RateCard = () => ({})) {}

  /** Serves the usage engine's methods from now on. Before this they are refused. */
  attachEngine(engine: EngineLink | null): void { this.engine = engine; }

  private needEngine(): EngineLink {
    if (!this.engine) throw new Error('The usage engine is not running in this service.');
    return this.engine;
  }

  private stateOf(keys?: readonly EngineKey[]): Partial<EngineState> {
    const state = this.needEngine().api.state;
    if (!keys) return state;
    return Object.fromEntries(keys.filter(k => k in state).map(k => [k, state[k]])) as Partial<EngineState>;
  }

  /** Turns a connection into a view: it gets the whole state now, every change after it, and the engine's requests, which it answers on the same line. */
  private watch(sock: net.Socket, params: unknown): { view: ViewLink; stop: () => void; result: unknown } {
    const engine = this.needEngine();
    const send = (m: EngineEvent) => { if (!sock.destroyed) sock.write(JSON.stringify(m) + '\n'); };
    const hello = ((params ?? {}) as { hello?: ViewHello }).hello ?? { kind: 'terminal' };
    const view = engine.views.add(hello, m => send(m as EngineEvent));
    const offChange = engine.api.onChange(keys => send({ event: 'change', keys, state: this.stateOf(keys) }));
    const offViews = engine.views.onChange(() => send({ event: 'views', views: engine.views.info() }));
    const stop = () => { offChange(); offViews(); engine.views.remove(view); };
    return { view, stop, result: { state: engine.api.state, views: engine.views.info() } };
  }

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
      case 'balance': return this.sup.balance(typeof p.days === 'number' ? p.days : 7);
      case 'routes': return Object.entries(this.routes() ?? {}).map(([name, r]) => ({ name, model: r.model, adapter: r.adapter, problem: this.sup.routeProblem(r as RouteConfig, name) }));
      case 'engine_state': { const e = this.needEngine(); return { state: this.stateOf(p.keys as EngineKey[] | undefined), views: e.views.info() }; }
      case 'engine_call': return callEngine(this.needEngine().api, String(p.method ?? ''), Array.isArray(p.args) ? p.args : []);
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
        let watching: { view: ViewLink; stop: () => void } | null = null;
        this.sockets.add(sock); sock.on('close', () => { this.sockets.delete(sock); watching?.stop(); watching = null; });
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
            // A view's answer to one of the engine's requests rides the connection that was authorized when it started watching.
            if (watching && typeof (req as unknown as ViewReply).reply === 'string') {
              const r = req as unknown as ViewReply;
              this.engine?.views.reply(r.reply, r.result ?? null, typeof r.error === 'string' ? r.error : undefined, watching.view.id);
              continue;
            }
            // Answered at once, so the whole state is on the line before the first change that follows it.
            if (req.method === 'engine_watch') {
              let res: RpcResponse;
              if (!this.authorized(req.token)) res = { id: req.id, error: { code: 'unauthorized', message: 'Missing or wrong token.' } };
              else if (watching) res = { id: req.id, error: { code: 'failed', message: 'This connection is already watching.' } };
              else {
                try { const w = this.watch(sock, req.params); watching = w; res = { id: req.id, result: w.result }; }
                catch (e) { res = { id: req.id, error: { code: 'failed', message: (e as Error).message } }; }
              }
              sock.write(JSON.stringify(res) + '\n');
              continue;
            }
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
