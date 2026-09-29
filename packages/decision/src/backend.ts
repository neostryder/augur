// Where a System One question is answered: a list of Laya servers tried in order, TypeSafe's Jev with the person's own key, or nowhere.
import type { Question, SystemOneResponse } from './questions.js';

export interface DecisionBackend {
  id: string;
  /** Answers are computed on hardware the person controls, so private text may be sent. */
  local: boolean;
  ask(state: unknown, questions: Record<string, Question>, model?: string): Promise<SystemOneResponse>;
}

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface Server { name: string; url: string }
export const DEFAULT_SERVERS: Server[] = [{ name: 'eru', url: 'http://127.0.0.1:8010' }, { name: 'bilbo', url: 'http://192.168.2.154:8010' }];

/** Tried in order. A server that does not answer, answers 503, or reports busy or not ready on /load is skipped, and remembered for a while. */
export class ServerPool {
  private skip = new Map<string, { until: number; reason: string }>();
  constructor(readonly servers: Server[], private fetcher: Fetch = fetch as unknown as Fetch, private now: () => number = Date.now,
    private opts = { probeMs: 600, busyMs: 5000, downMs: 30000, callMs: 60000 }) {}

  private async timed<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
    try { return await run(ctl.signal); } finally { clearTimeout(t); }
  }

  private async probe(url: string): Promise<string | null> {
    try {
      const r = await this.timed(this.opts.probeMs, signal => this.fetcher(`${url}/load`, { signal }));
      if (r.status === 404) return null;
      if (!r.ok) return `load probe answered ${r.status}`;
      const s = await r.json() as { busy?: boolean; ready?: boolean; reasons?: string[] };
      if (s.busy) return `busy: ${(s.reasons?.length ? s.reasons : ['over its limit']).join(', ')}`;
      if (s.ready === false) return 'not ready';
      return null;
    } catch (e) { return `unreachable (${(e as Error).message})`; }
  }

  async post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ result: unknown; server: string }> {
    const reasons: Record<string, string> = {};
    for (const s of this.servers) {
      const url = s.url.replace(/\/$/, ''), skipped = this.skip.get(url);
      if (skipped && skipped.until > this.now()) { reasons[s.name] = `${skipped.reason} (recently)`; continue; }
      const why = await this.probe(url);
      if (why) { this.skip.set(url, { until: this.now() + (/^(busy|not ready)/.test(why) ? this.opts.busyMs : this.opts.downMs), reason: why }); reasons[s.name] = why; continue; }
      try {
        const r = await this.timed(this.opts.callMs, signal => this.fetcher(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal }));
        if (r.ok) return { result: await r.json(), server: s.name };
        if (r.status === 503 || r.status >= 500) { this.skip.set(url, { until: this.now() + this.opts.busyMs, reason: `error ${r.status}` }); reasons[s.name] = `error ${r.status}`; continue; }
        throw new PoolClientError(r.status);
      } catch (e) {
        if (e instanceof PoolClientError) throw e;
        this.skip.set(url, { until: this.now() + this.opts.downMs, reason: 'unreachable' });
        reasons[s.name] = `unreachable (${(e as Error).message})`;
      }
    }
    throw new PoolError(reasons);
  }
}

export class PoolError extends Error {
  constructor(readonly reasons: Record<string, string>) { super(`no Laya server answered: ${Object.entries(reasons).map(([k, v]) => `${k}: ${v}`).join('; ')}`); }
}
export class PoolClientError extends Error { constructor(readonly status: number) { super(`the server refused the request with ${status}`); } }

export class LayaBackend implements DecisionBackend {
  readonly id = 'laya';
  readonly local = true;
  constructor(readonly pool: ServerPool, private defaultModel = 'laya') {}
  async ask(state: unknown, questions: Record<string, Question>, model?: string): Promise<SystemOneResponse> {
    try { return (await this.pool.post('/v1/systemone', { model: model ?? this.defaultModel, state, questions })).result as SystemOneResponse; }
    catch (e) { return { error: (e as Error).message }; }
  }
}

export class JevBackend implements DecisionBackend {
  readonly id = 'jev';
  readonly local = false;
  constructor(private key: string, private fetcher: Fetch = fetch as unknown as Fetch, private endpoint = 'https://api.typesafe.ai/v1/systemone', private model = 'jev-latest') {}
  async ask(state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> {
    try {
      const r = await this.fetcher(this.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` }, body: JSON.stringify({ model: this.model, state, questions }) });
      return r.ok ? await r.json() as SystemOneResponse : { error: `Jev answered ${r.status}` };
    } catch (e) { return { error: (e as Error).message }; }
  }
}

/** No classifier: every question comes back as an error, and callers fall back to rules and usage alone. */
export class NoBackend implements DecisionBackend {
  readonly id = 'none';
  readonly local = true;
  async ask(): Promise<SystemOneResponse> { return { error: 'no decision backend is configured' }; }
}

export interface DecisionConfig {
  /** Which backend answers. */
  backend: 'laya' | 'jev' | 'none';
  /** Laya servers, in the order they are tried. */
  servers?: Server[];
  /** A second backend that is asked the same questions and only compared, never used. */
  shadow?: 'laya' | 'jev' | null;
}

export function createBackend(kind: DecisionConfig['backend'], config: DecisionConfig, env: NodeJS.ProcessEnv = process.env, fetcher?: Fetch): DecisionBackend {
  if (kind === 'laya') return new LayaBackend(new ServerPool(config.servers?.length ? config.servers : DEFAULT_SERVERS, fetcher));
  if (kind === 'jev') {
    const key = env.TYPESAFE_API_KEY ?? env.JEV_API_KEY;
    return key ? new JevBackend(key, fetcher) : new NoBackend();
  }
  return new NoBackend();
}
