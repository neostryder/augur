// The terminal app's connection to the service. It joins as a terminal view, keeps a copy of the engine's state that every change
// updates, and sends commands back. When the service is not running it starts it once; when the connection drops it tries again
// every few seconds until it is back.
import { ServiceError, call as rpc, watchEngine, type ClientOptions, type EngineWatch } from '@augur/augurd';
import type { EngineKey, EngineState } from '@augur/core';
import type { MethodName, Methods, ViewInfo } from '@augur/dispatch-protocol';

export type LinkStatus = 'connecting' | 'starting' | 'up' | 'down';

export interface LinkDeps {
  watch?: typeof watchEngine;
  call?: typeof rpc;
  /** Starts the service. Resolves once it answers, or to null when it did not come up. */
  launch?: () => Promise<unknown>;
  opts?: ClientOptions;
  retryMs?: number;
}

export class Link {
  state: EngineState | null = null;
  views: ViewInfo[] = [];
  status: LinkStatus = 'connecting';
  /** Why the service cannot be reached, while the status is down. */
  error = '';
  private watcher: EngineWatch | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private launched = false;
  private closed = false;
  private readonly listeners = new Set<(keys: EngineKey[] | null) => void>();
  private readonly watch: typeof watchEngine;
  private readonly rpc: typeof rpc;

  constructor(private readonly deps: LinkDeps = {}) {
    this.watch = deps.watch ?? watchEngine;
    this.rpc = deps.call ?? rpc;
  }

  /** Calls back with the keys that changed, or null when the connection itself changed. */
  onChange(fn: (keys: EngineKey[] | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(keys: EngineKey[] | null): void {
    for (const fn of this.listeners) fn(keys);
  }

  private set(status: LinkStatus, error = ''): void {
    this.status = status; this.error = error;
    this.emit(null);
  }

  async connect(): Promise<void> {
    if (this.closed) return;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    this.set('connecting');
    try {
      this.watcher = await this.watch({ kind: 'terminal', caps: [] }, {
        change: (keys, part) => { if (this.state) Object.assign(this.state, part); this.emit(keys); },
        views: (views) => { this.views = views; this.emit(null); },
        closed: (e) => { this.watcher = null; if (!this.closed) { this.set('down', e?.message ?? 'The service closed the connection.'); this.later(); } },
      }, this.deps.opts);
      this.state = this.watcher.state;
      this.views = this.watcher.views;
      // A later loss of the service is a new reason to start it.
      this.launched = false;
      this.set('up');
    } catch (e) {
      const err = e as ServiceError;
      // A service that was never started, or has stopped, is started once per loss; after that the app keeps trying to reach it.
      if ((err.code === 'unreachable' || err.code === 'no_token') && this.deps.launch && !this.launched) {
        this.launched = true;
        this.set('starting');
        const up = await this.deps.launch().catch(() => null);
        if (up) return this.connect();
        this.set('down', 'The service did not start. Its log is service.log in the Augur data folder.');
      } else {
        this.set('down', err.message || String(e));
      }
      this.later();
    }
  }

  private later(): void {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => { this.retry = null; void this.connect(); }, this.deps.retryMs ?? 3000);
  }

  /** Runs one of the engine's commands, such as refresh or dismiss. */
  run<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    return this.rpc('engine_call', { method, args }, this.deps.opts) as Promise<T>;
  }

  /** Calls the service directly, as the dispatch pages do for jobs and routes. */
  call<M extends MethodName>(method: M, params?: Methods[M]['params']): Promise<Methods[M]['result']> {
    return this.rpc(method, params, this.deps.opts);
  }

  close(): void {
    this.closed = true;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    this.watcher?.close();
    this.watcher = null;
  }
}
