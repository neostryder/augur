// The service's control endpoint: a named pipe (a socket file elsewhere), one JSON line per request, every request carrying the token.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { PROTOCOL_VERSION, planRouteAdd, resetLedger } from '@augur/dispatch-protocol';
import type { EngineEvent, JobRequest, MethodName, RateCard, RouteAddAnswer, RouteConfig, RpcRequest, RpcResponse, ViewHello, ViewReply } from '@augur/dispatch-protocol';
import { DEFAULT_APPROVAL, RULES_ONLY_PROVIDERS, allPlugins, callEngine, type EngineApi, type EngineKey, type EngineState, type ProviderAddition } from '@augur/core';
import { buildAccounting } from './accounting.js';
import type { Store } from './store.js';
import type { Supervisor } from './supervisor.js';
import type { ViewHub, ViewLink } from './views.js';

/** The usage engine as the control endpoint serves it: its commands and state, and the views connected to it. */
export interface EngineLink { api: EngineApi; views: ViewHub }

const MAX_LINE = 16 * 1024 * 1024;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Limits a file or folder to its owner. POSIX gets a mode; Windows has its access list rewritten to the current user alone, since a mode means nothing there. */
export function ownerOnly(path: string, mode: number): void {
  try { chmodSync(path, mode); } catch { /* a filesystem with no modes */ }
  if (process.platform !== 'win32') return;
  try {
    const domain = process.env.USERDOMAIN, who = (domain ? domain + '\\' : '') + userInfo().username;
    execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${who}:(F)`], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
  } catch { /* the profile folder's access list still applies */ }
}

/** The owner's token and the agent token sit in the service's data folder, which is inside the user's profile. Callers read the one for their role from there. */
export function ensureToken(dir: string, file = 'token'): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  if (existsSync(path)) { const t = readFileSync(path, 'utf8').trim(); if (t.length >= 32) { ownerOnly(path, 0o600); return t; } }
  const token = randomBytes(32).toString('hex');
  writeFileSync(path, token, { mode: 0o600 });
  ownerOnly(path, 0o600);
  return token;
}

/** The web app's token, apart from the owner's and the agent's: a browser holds it, so it can be rotated without touching the terminal's or an agent's. Empty when there is none. */
export function webToken(dir: string): string {
  try { const t = readFileSync(join(dir, 'web-token'), 'utf8').trim(); return t.length >= 32 ? t : ''; } catch { return ''; }
}

/** Replaces the web token. Every browser signed in with the old one is signed out. */
export function rotateWebToken(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'web-token'), token = randomBytes(32).toString('hex');
  writeFileSync(path, token, { mode: 0o600 });
  ownerOnly(path, 0o600);
  return token;
}

/** Who holds a token: the owner's terminal, app and hooks, or an agent's tool server. An agent can run work and read results, and cannot make the claims that stand in for the owner. */
export type Role = 'owner' | 'agent';

/** What an agent token may call. Everything else, including every request that records a person's word (a prompt, a pick answer, a grade label) and the engine's settings, is the owner's. */
export const AGENT_METHODS: ReadonlySet<string> = new Set(['ping', 'submit', 'status', 'list', 'events', 'logs', 'result', 'cancel', 'pick', 'pressure', 'balance', 'resets', 'routes', 'route_add']);

/** A job request as an agent may make it: it cannot say a person is at the terminal or named the model, and it cannot waive the pick or quota checks. */
export function attestAgentRequest(req: JobRequest): JobRequest {
  const { named: _named, allow: _allow, ...rest } = req;
  const caller = { ...(rest.caller ?? { kind: 'mcp' as const }) };
  delete caller.interactive;
  return { ...rest, caller };
}

export class IpcServer {
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  private readonly startedAt = Date.now();
  private engine: EngineLink | null = null;
  constructor(private sup: Supervisor, private store: Store, private token: string, private routes: () => Record<string, RouteConfig> | null, private rates: () => RateCard = () => ({}), private routeFile: { read(): string | null; write(text: string): void } | null = null, private agentToken: string | null = null) {}

  /** Serves the usage engine's methods from now on. Before this they are refused. */
  attachEngine(engine: EngineLink | null): void { this.engine = engine; }

  /** The usage engine and its views, for the web app, or null when it is not running. */
  engineLink(): EngineLink | null { return this.engine; }

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

  private handle(method: MethodName, params: unknown, role: Role = 'owner'): unknown | Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    if (role === 'agent' && !AGENT_METHODS.has(method)) throw new Error(`This caller may not use ${String(method)}. It is for the owner's terminal and app.`);
    switch (method) {
      case 'ping': return { pid: process.pid, version: PROTOCOL_VERSION, startedAt: this.startedAt };
      case 'submit': return this.sup.submit(role === 'agent' ? attestAgentRequest(params as JobRequest) : params as JobRequest);
      case 'status': return this.store.get(String(p.id));
      case 'list': return this.store.list({ state: p.state as never, root: p.root as string | undefined, limit: p.limit as number | undefined });
      case 'conversations': return this.sup.conversations();
      case 'forget_conversation': return this.sup.forgetConversation(String(p.name ?? ''));
      case 'events': return this.store.events(String(p.id), Number(p.since ?? 0));
      case 'logs': return this.sup.logs(String(p.id), p.stream === 'stderr' ? 'stderr' : 'stdout', Number(p.offset ?? 0), Number(p.limit ?? 65536));
      case 'result': return this.sup.result(String(p.id));
      case 'cancel': return this.sup.cancel(String(p.id));
      case 'apply': return this.sup.apply(String(p.id), p.check === true);
      case 'pick': return this.sup.pick(params as never);
      case 'human_prompt': return this.sup.humanPrompt(String(p.session ?? ''), String(p.text ?? ''));
      case 'pressure': return this.sup.pressure();
      case 'resets': return resetLedger(this.needEngine().api.state.resets, p);
      case 'pick_answer': return this.sup.pickAnswer(String(p.id ?? ''), String(p.model ?? ''), typeof p.why === 'string' ? p.why : undefined);
      case 'label': return this.sup.label(String(p.id ?? ''), String(p.result ?? ''), typeof p.note === 'string' ? p.note : undefined);
      case 'grade': return this.sup.grade(params as never);
      case 'grade_label': return this.sup.gradeLabel(String(p.id ?? ''), String(p.label ?? ''), typeof p.note === 'string' ? p.note : undefined);
      case 'grade_report': return this.sup.gradeReport(typeof p.rubric === 'string' ? p.rubric : undefined);
      case 'balance': return this.sup.balance(typeof p.days === 'number' ? p.days : 7);
      case 'routes': return Object.entries(this.routes() ?? {}).map(([name, r]) => ({ name, model: r.model, adapter: r.adapter, problem: this.sup.routeProblem(r as RouteConfig, name) }));
      case 'route_add': return this.routeAdd(params);
      case 'engine_state': { const e = this.needEngine(); return { state: this.stateOf(p.keys as EngineKey[] | undefined), views: e.views.info() }; }
      case 'engine_call': return callEngine(this.needEngine().api, String(p.method ?? ''), Array.isArray(p.args) ? p.args : []);
      case 'accounting': { const limit = Math.min(Math.max(Number(p.limit ?? 100), 1), 500); return buildAccounting(this.store.list({ limit: 500 }), this.routes(), this.rates(), limit); }
      default: throw new Error(`unknown method ${String(method)}`);
    }
  }

  private refused(problems: string[]): RouteAddAnswer {
    return { ok: false, problems, text: `Nothing was written. ${problems.join(' ')}` };
  }

  /** Names already in the routes file, including entries the service skips, so an add never overwrites one. */
  private routeNames(): { names: Set<string> } | { error: string } {
    if (!this.routeFile) return { error: 'This service cannot write routes.' };
    const text = this.routeFile.read();
    if (text === null || !text.trim()) return { names: new Set() };
    let data: unknown;
    try { data = JSON.parse(text); } catch { return { error: 'routes.json is not valid JSON, so nothing was written.' }; }
    if (!isObj(data) || (data.routes !== undefined && !isObj(data.routes))) return { error: 'routes.json must be an object with a routes object, so nothing was written.' };
    return { names: new Set(Object.keys(isObj(data.routes) ? data.routes : {})) };
  }

  private writeRoute(name: string, entry: Record<string, unknown>): string | null {
    if (!this.routeFile) return 'This service cannot write routes.';
    const text = this.routeFile.read();
    let data: Record<string, unknown> = { routes: {} };
    if (text !== null && text.trim()) {
      try { data = JSON.parse(text) as Record<string, unknown>; } catch { return 'routes.json is not valid JSON, so nothing was written.'; }
      if (!isObj(data) || (data.routes !== undefined && !isObj(data.routes))) return 'routes.json must be an object with a routes object, so nothing was written.';
    }
    const routes = { ...(isObj(data.routes) ? data.routes : {}) };
    if (Object.hasOwn(routes, name)) return `A route named ${name} already exists. Nothing was written.`;
    routes[name] = entry;
    this.routeFile.write(`${JSON.stringify({ ...data, routes }, null, 2)}\n`);
    return null;
  }

  private providerKind(id: string): 'builtin' | 'custom' | 'rules-only' | 'none' {
    const config = this.needEngine().api.state.config;
    if (allPlugins({ ...config, custom: [] }).some(p => p.id === id)) return 'builtin';
    if ((config.custom ?? []).some(d => d.id === id)) return 'custom';
    if (RULES_ONLY_PROVIDERS.some(r => r.id === id) || (config.rulesOnly ?? []).some(r => r.id === id)) return 'rules-only';
    return 'none';
  }

  private routeAddedText(name: string, model: string | null, added: boolean, custom: boolean, baseUrl: string | null): string {
    const parts = [`Added route ${name}.`];
    if (model && added) parts.push(`The model ${model} is unreviewed, so nothing can run it until the owner confirms it in Model rules.`);
    else if (model) parts.push(`The model ${model} is already in the rules and was left as it is.`);
    if (custom) parts.push('The balance reading is stored and stays off until the owner sets its key.');
    if (baseUrl) parts.push(`Its requests go to ${baseUrl}. The owner should check that address before setting a key, since the key is sent there.`);
    parts.push(`Set the key with augur key set ${name}.`);
    return parts.join(' ');
  }

  /** Checks the whole request, then writes the route. A problem or an approval hold writes nothing. */
  private async routeAdd(params: unknown): Promise<RouteAddAnswer> {
    const input = isObj(params) ? params : {};
    const names = this.routeNames();
    if ('error' in names) return this.refused([names.error]);
    const engine = this.needEngine();
    const planned = planRouteAdd(input, { existingRoutes: names.names, knownAdapters: new Set(this.sup.knownAdapters()), providerKind: id => this.providerKind(id) });
    if ('problems' in planned) return this.refused(planned.problems);
    const approval = engine.api.state.config.agentApproval ?? DEFAULT_APPROVAL;
    if (approval === 'all') return { ok: false, held: true, text: 'Nothing was written. The approval setting holds every agent edit, so this route was not added. The owner can add it in the app.' };
    const plan = planned.plan;
    // A route that points at a model the rules already hold would borrow that model's review, so the owner adds it.
    const label = plan.model?.label ?? plan.entry.model;
    const known = Object.values(engine.api.state.config.policy?.providers ?? {}).some(p => Object.hasOwn(p.models, label) || (plan.model !== null && Object.values(p.models).some(m => m.id === plan.model!.id)));
    if (known) return { ok: false, held: true, text: `Nothing was written. The model ${label} is already in the rules, so a route for it needs the owner. The owner can add it in the app.` };
    let added: string[] = [];
    if (plan.model || plan.custom) {
      const addition: ProviderAddition = { provider: plan.provider, name: plan.provider, ...(plan.model ? { models: [plan.model] } : {}), ...(plan.custom ? { custom: plan.custom, usageOff: true as const } : {}) };
      added = (await engine.api.addProvider(addition)).added;
    }
    const again = this.routeNames();
    if ('error' in again) return this.refused([again.error]);
    if (again.names.has(plan.name)) {
      const extra = plan.model && added.includes(plan.model.label) ? ' The model was added and stays unreviewed.' : '';
      return this.refused([`A route named ${plan.name} already exists. The route was not written.${extra}`]);
    }
    const written = this.writeRoute(plan.name, plan.entry);
    if (written) return this.refused([written]);
    const model = plan.model?.label ?? null;
    const base = plan.entry.options.baseUrl;
    let host: string | null = null;
    if (typeof base === 'string') { try { host = new URL(base).host; } catch { host = null; } }
    return { ok: true, text: this.routeAddedText(plan.name, model, model !== null && added.includes(model), plan.custom !== null, host), route: plan.name, model };
  }

  /** The role a token holds, or null. Both tokens are always compared, so the time taken does not say which one was close. */
  private roleOf(given: unknown): Role | null {
    const a = Buffer.from(String(given ?? '')), same = (t: string | null): boolean => { const b = Buffer.from(t ?? ''); return t !== null && a.length === b.length && timingSafeEqual(a, b); };
    const owner = same(this.token), agent = same(this.agentToken);
    return owner ? 'owner' : agent ? 'agent' : null;
  }

  start(pipe: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const oldMask = process.platform === 'win32' ? null : process.umask(0o077);
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
            // `null` and other non-objects parse as JSON and would throw below, before the token is checked.
            if (typeof req !== 'object' || req === null) { sock.write(JSON.stringify({ id: 0, error: { code: 'bad_json', message: 'Request is not a JSON object.' } }) + '\n'); continue; }
            // A view's answer to one of the engine's requests rides the connection that was authorized when it started watching.
            if (watching && typeof (req as unknown as ViewReply).reply === 'string') {
              const r = req as unknown as ViewReply;
              this.engine?.views.reply(r.reply, r.result ?? null, typeof r.error === 'string' ? r.error : undefined, watching.view.id);
              continue;
            }
            // Answered at once, so the whole state is on the line before the first change that follows it.
            if (req.method === 'engine_watch') {
              let res: RpcResponse;
              if (this.roleOf(req.token) !== 'owner') res = { id: req.id, error: { code: 'unauthorized', message: 'Missing or wrong token.' } };
              else if (watching) res = { id: req.id, error: { code: 'failed', message: 'This connection is already watching.' } };
              else {
                try { const w = this.watch(sock, req.params); watching = w; res = { id: req.id, result: w.result }; }
                catch (e) { res = { id: req.id, error: { code: 'failed', message: (e as Error).message } }; }
              }
              sock.write(JSON.stringify(res) + '\n');
              continue;
            }
            const respond = async (): Promise<RpcResponse> => {
              const role = this.roleOf(req.token);
              if (!role) return { id: req.id, error: { code: 'unauthorized', message: 'Missing or wrong token.' } };
              try { return { id: req.id, result: (await this.handle(req.method, req.params, role)) ?? null }; } catch (e) { return { id: req.id, error: { code: 'failed', message: (e as Error).message } }; }
            };
            void respond().then(res => { if (!sock.destroyed) sock.write(JSON.stringify(res) + '\n'); });
          }
        });
      });
      server.once('error', e => { if (oldMask !== null) process.umask(oldMask); reject(e); });
      // A socket file is created with no access for anyone but its owner. A Windows pipe is owner-only by default, and the token is checked on every request besides.
      if (process.platform !== 'win32') { try { mkdirSync(dirname(pipe), { recursive: true, mode: 0o700 }); } catch { /* the folder exists */ } }
      server.listen(pipe, () => {
        if (oldMask !== null) { process.umask(oldMask); try { chmodSync(pipe, 0o600); } catch { /* gone already */ } }
        server.off('error', reject); this.server = server; resolve();
      });
    });
  }

  close(): Promise<void> { return new Promise(res => { if (!this.server) return res(); this.server.close(() => res()); for (const s of this.sockets) s.destroy(); }); }
}
