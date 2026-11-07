// Caller side of the service's control endpoint. Used by the CLI, the MCP server and the interface.
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import type { EngineEvent, Methods, MethodName, RpcResponse, Stamp, ViewHello, ViewInfo } from '@augur/dispatch-protocol';
import type { EngineKey, EngineState } from '@augur/core';
import type { LedgerChange, LedgerWatchEvent } from '@augur/dispatch-protocol';
import { dataDir, pipeName } from './paths.js';

/** `agent` reads the agent token, for a tool server an agent drives; the default is the owner's token. */
export interface ClientOptions { pipe?: string; token?: string; dir?: string; timeoutMs?: number; role?: 'owner' | 'agent'; stamp?: Stamp }

export class ServiceError extends Error { constructor(public code: string, message: string) { super(message); } }

export function readToken(dir = dataDir(), role: 'owner' | 'agent' = 'owner'): string { return readFileSync(join(dir, role === 'agent' ? 'agent-token' : 'token'), 'utf8').trim(); }

export function call<M extends MethodName>(method: M, params?: Methods[M]['params'], opts: ClientOptions = {}): Promise<Methods[M]['result']> {
  const dir = opts.dir ?? dataDir(), pipe = opts.pipe ?? pipeName(dir);
  return new Promise((resolve, reject) => {
    let token: string;
    try { token = opts.token ?? readToken(dir, opts.role); } catch { reject(new ServiceError('no_token', 'The service has not been started: its token file is missing.')); return; }
    const sock = net.connect(pipe);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new ServiceError('timeout', 'The service did not answer in time.')); }, opts.timeoutMs ?? 10000);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, token, method, params, ...(opts.stamp ? { stamp: opts.stamp } : {}) }) + '\n'));
    sock.on('data', (chunk: string) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(timer); sock.end();
      const res = JSON.parse(buf.slice(0, i)) as RpcResponse<Methods[M]['result']>;
      if ('error' in res) reject(new ServiceError(res.error.code, res.error.message)); else resolve(res.result);
    });
    sock.on('error', e => { clearTimeout(timer); reject(new ServiceError('unreachable', `The service is not running (${(e as NodeJS.ErrnoException).code ?? e.message}).`)); });
  });
}

export interface EngineWatchHandlers {
  /** The keys that changed and their new values. */
  change?(keys: EngineKey[], state: Partial<EngineState>): void;
  views?(views: ViewInfo[]): void;
  /** Answers one of the engine's requests (a notice to show, a page to read). A rejection is sent back as the error. */
  request?(method: string, params: unknown): Promise<unknown>;
  /** The connection ended: the service stopped, or close() was called. */
  closed?(error?: Error): void;
}

export interface EngineWatch { state: EngineState; views: ViewInfo[]; close(): void }

/** Connects as a view. Resolves once the service has sent the whole state; every change after it goes to the handlers. */
export function watchEngine(hello: ViewHello, handlers: EngineWatchHandlers = {}, opts: ClientOptions = {}): Promise<EngineWatch> {
  const dir = opts.dir ?? dataDir(), pipe = opts.pipe ?? pipeName(dir);
  return new Promise((resolve, reject) => {
    let token: string;
    try { token = opts.token ?? readToken(dir, opts.role); } catch { reject(new ServiceError('no_token', 'The service has not been started: its token file is missing.')); return; }
    const sock = net.connect(pipe);
    let buf = '', started = false, closing = false;
    const timer = setTimeout(() => { sock.destroy(); reject(new ServiceError('timeout', 'The service did not answer in time.')); }, opts.timeoutMs ?? 10000);
    const send = (m: unknown) => { if (!sock.destroyed) sock.write(JSON.stringify(m) + '\n'); };
    const onLine = (line: string) => {
      const msg = JSON.parse(line) as RpcResponse<EngineWatch> | EngineEvent;
      if (!started) {
        if (!('id' in msg)) return;
        started = true; clearTimeout(timer);
        if ('error' in msg) { sock.destroy(); reject(new ServiceError(msg.error.code, msg.error.message)); return; }
        resolve({ state: msg.result.state, views: msg.result.views, close: () => { closing = true; sock.end(); } });
        return;
      }
      if (!('event' in msg)) return;
      if (msg.event === 'change') handlers.change?.(msg.keys, msg.state);
      else if (msg.event === 'views') handlers.views?.(msg.views);
      else if (msg.event === 'request') {
        const answer = handlers.request ? handlers.request(msg.method, msg.params) : Promise.reject(new Error('This view does not take requests'));
        answer.then(result => send({ reply: msg.rid, result: result ?? null }), (e: Error) => send({ reply: msg.rid, error: e.message || 'failed' }));
      }
    };
    sock.setEncoding('utf8');
    sock.on('connect', () => send({ id: 1, token, method: 'engine_watch', params: { hello } }));
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { onLine(line); } catch { /* one bad line does not end the watch */ } }
    });
    sock.on('error', e => {
      if (!started) { clearTimeout(timer); reject(new ServiceError('unreachable', `The service is not running (${(e as NodeJS.ErrnoException).code ?? e.message}).`)); }
    });
    sock.on('close', () => { if (started) handlers.closed?.(closing ? undefined : new ServiceError('closed', 'The service closed the connection.')); });
  });
}

export interface LedgerWatchHandlers { change(change: LedgerChange): void; closed?(error?: Error): void }
export interface LedgerWatch { close(): void }

export function watchLedger(since: string, handlers: LedgerWatchHandlers, opts: ClientOptions = {}): Promise<LedgerWatch> {
  return new Promise((resolve, reject) => {
    let token: string;
    try { token = opts.token ?? readToken(opts.dir ?? dataDir(), opts.role); }
    catch { reject(new ServiceError('no_token', 'The service token is missing.')); return; }
    const sock = net.connect(opts.pipe ?? pipeName(opts.dir ?? dataDir()));
    let buffer = '', ready = false, closing = false;
    const timer = setTimeout(() => { sock.destroy(); reject(new ServiceError('timeout', 'The ledger watch did not start in time.')); }, opts.timeoutMs ?? 10000);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, token, method: 'ledger_watch', params: { since } }) + '\n'));
    sock.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) { sock.destroy(); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message: RpcResponse<{ cursor: string }> | LedgerWatchEvent;
        try { message = JSON.parse(line) as typeof message; }
        catch { sock.destroy(); return; }
        if (!ready) {
          if (!('id' in message)) continue;
          clearTimeout(timer);
          if ('error' in message) { reject(new ServiceError(message.error.code, message.error.message)); sock.destroy(); return; }
          ready = true; resolve({ close: () => { closing = true; sock.end(); } });
        } else if ('event' in message && message.event === 'ledger_change') handlers.change(message.change);
      }
    });
    sock.on('error', () => { if (!ready) { clearTimeout(timer); reject(new ServiceError('unreachable', 'The ledger service is unavailable.')); } });
    sock.on('close', () => {
      clearTimeout(timer);
      if (!ready) reject(new ServiceError('closed', 'The ledger connection closed.'));
      else handlers.closed?.(closing ? undefined : new ServiceError('closed', 'The ledger connection closed.'));
    });
  });
}
