// The views connected to the engine: the window app and any terminal app. A view says what it can do for the engine when it connects; the
// window app takes desktop notices and reads the provider pages that need a signed-in browser, and the terminal app takes neither.
import { randomUUID } from 'node:crypto';
import type { ViewCapability, ViewHello, ViewInfo } from '@augur/dispatch-protocol';

export type { ViewCapability, ViewHello };

export interface ViewLink {
  readonly id: string;
  readonly hello: ViewHello;
  /** Sends one line to the view. */
  send(message: unknown): void;
}

interface Pending { view: string; resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }

export class ViewHub {
  private views: ViewLink[] = [];
  private pending = new Map<string, Pending>();
  private listeners = new Set<() => void>();

  add(hello: ViewHello, send: (message: unknown) => void): ViewLink {
    const caps = (hello.caps ?? []).filter((c): c is ViewCapability => c === 'notify' || c === 'websession' || c === 'signin');
    const view: ViewLink = { id: randomUUID(), hello: { kind: hello.kind === 'window' ? 'window' : 'terminal', caps, ...(typeof hello.appExe === 'string' ? { appExe: hello.appExe } : {}) }, send };
    this.views.push(view);
    this.changed();
    return view;
  }

  remove(view: ViewLink): void {
    this.views = this.views.filter(v => v !== view);
    for (const [rid, p] of this.pending) if (p.view === view.id) this.reply(rid, null, 'The view closed before answering');
    this.changed();
  }

  /** Fires when a view connects or leaves. */
  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private changed(): void { for (const fn of this.listeners) fn(); }

  list(): ViewLink[] { return [...this.views]; }
  info(): ViewInfo[] { return this.views.map(v => ({ kind: v.hello.kind, caps: v.hello.caps ?? [] })); }

  /** The most recently connected view that can do `cap`, or null. */
  provider(cap: ViewCapability): ViewLink | null {
    for (let i = this.views.length - 1; i >= 0; i--) if (this.views[i]!.hello.caps?.includes(cap)) return this.views[i]!;
    return null;
  }

  /** The window app's program, from the newest window view that sent one. */
  appExe(): string { return [...this.views].reverse().find(v => v.hello.appExe)?.hello.appExe ?? ''; }

  /** Asks a view that can do `cap` to run `method`, and resolves to its answer. Rejects when no view can, or none answers in time. */
  request(cap: ViewCapability, method: string, params: unknown, timeoutMs = 60000): Promise<unknown> {
    const view = this.provider(cap);
    if (!view) return Promise.reject(new Error(`No connected view can ${cap}`));
    const rid = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(rid); reject(new Error('The view did not answer in time')); }, timeoutMs);
      this.pending.set(rid, { view: view.id, resolve, reject, timer });
      view.send({ event: 'request', rid, method, params });
    });
  }

  /** A view's answer to a request. With `from`, only the view that was asked can answer it. */
  reply(rid: string, result: unknown, error?: string, from?: string): void {
    const p = this.pending.get(rid);
    if (!p || (from !== undefined && p.view !== from)) return;
    this.pending.delete(rid);
    clearTimeout(p.timer);
    if (error) p.reject(new Error(error)); else p.resolve(result);
  }
}
