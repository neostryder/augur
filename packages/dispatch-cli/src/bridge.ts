// `augur bridge`: the window app's link to the usage engine in the service. The app runs it as a child process and they talk in JSON lines.
// Out, on stdout: {t:'ready', state, views} on each connection, {t:'change', keys, state}, {t:'views', views}, {t:'request', rid, method, params},
// {t:'result', id, result | error} and {t:'down', message} while the service cannot be reached. In, on stdin: {t:'call', id, method, args}
// and {t:'reply', rid, result | error}. It starts the service when it is not running and connects again whenever the connection ends.
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isTerminal } from '@augur/dispatch-protocol';
import { ServiceError, call, watchEngine, watchLedger, type LedgerWatch, type EngineWatch } from '@augur/augurd';
import { launchService } from './cli.js';

type Opts = { dir: string; pipe?: string };
type In = { t: 'ledger-call'; id: number; method: string; params?: unknown } | { t: 'ledger-watch'; since: string } | { t: 'ledger-close' } | { t: 'call'; id: number; method: string; args?: unknown[] } | { t: 'reply'; rid: string; result?: unknown; error?: string };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const BRIDGE_TEXT = {
  noStart: 'The Augur service would not start. Its log, service.log, is in the dispatch data folder.',
  oldBusy: 'An older Augur service is still running jobs. Augur switches to the new one when they finish.',
  noEngine: 'The Augur service is running, but its usage engine is off or did not start. Its log, service.log, is in the dispatch data folder.',
};

export interface BridgeIo { out(line: string): void; lines: AsyncIterable<string>; env: NodeJS.ProcessEnv }

export async function bridge(io: BridgeIo, opts: Opts, appExe: string | undefined): Promise<number> {
  const send = (m: unknown) => io.out(JSON.stringify(m) + '\n');
  const pending = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>();
  // Held in an object, as the input loop and the connection loop both change them.
  const link: { watch: EngineWatch | null; closed: (() => void) | null } = { watch: null, closed: null };
  let done = false, rids = 0;
  const ledgerLink: { watch: LedgerWatch | null } = { watch: null };
  let ledgerEpoch = 0;
  const ledgerMethods = new Set(['ledger_list', 'ledger_get', 'ledger_counts', 'ledger_changes', 'ledger_nodes', 'ledger_refresh', 'ledger_settings', 'ledger_settings_set', 'ledger_delivery', 'cancel']);

  void (async () => {
    for await (const line of io.lines) {
      let msg: In;
      try { msg = JSON.parse(line) as In; } catch { continue; }
      if (msg.t === 'ledger-call') {
        if (!ledgerMethods.has(msg.method)) { send({ t: 'result', id: msg.id, error: 'The ledger call is invalid.' }); continue; }
        call(msg.method as import('@augur/dispatch-protocol').MethodName, msg.params as never, opts).then(
          result => send({ t: 'result', id: msg.id, result }), (e: Error) => send({ t: 'result', id: msg.id, error: e.message }));
      } else if (msg.t === 'ledger-watch') {
        const epoch = ++ledgerEpoch;
        ledgerLink.watch?.close(); ledgerLink.watch = null;
        void watchLedger(msg.since, {
          change: change => { if (epoch === ledgerEpoch) send({ t: 'ledger-change', cursor: change.cursor }); },
          closed: () => { if (epoch === ledgerEpoch) send({ t: 'ledger-closed' }); },
        }, opts).then(watch => { if (epoch === ledgerEpoch && !done) ledgerLink.watch = watch; else watch.close(); }, () => { if (epoch === ledgerEpoch) send({ t: 'ledger-closed' }); });
      } else if (msg.t === 'ledger-close') { ledgerEpoch++; ledgerLink.watch?.close(); ledgerLink.watch = null;
      } else if (msg.t === 'call') {
        call('engine_call', { method: msg.method, args: msg.args ?? [] }, { ...opts, timeoutMs: 10 * 60 * 1000 })
          .then(result => send({ t: 'result', id: msg.id, result: result ?? null }), (e: Error) => send({ t: 'result', id: msg.id, error: e.message }));
      } else if (msg.t === 'reply') {
        const p = pending.get(msg.rid);
        pending.delete(msg.rid);
        if (typeof msg.error === 'string') p?.reject(new Error(msg.error)); else p?.resolve(msg.result ?? null);
      }
    }
    // The app closed its end, so it has quit.
    done = true; ledgerEpoch++; ledgerLink.watch?.close(); link.watch?.close(); link.closed?.();
  })();

  const hello = { kind: 'window' as const, caps: ['notify' as const, 'websession' as const, 'signin' as const], ...(appExe ? { appExe } : {}) };
  let lastDown = '';
  const down = (message: string) => { if (message !== lastDown) send({ t: 'down', message }); lastDown = message; };
  while (!done) {
    try {
      const ended = new Promise<void>(res => { link.closed = res; });
      const watch = link.watch = await watchEngine(hello, {
        change: (keys, state) => send({ t: 'change', keys, state }),
        views: views => send({ t: 'views', views }),
        request: (method, params) => new Promise((resolve, reject) => {
          const rid = `r${++rids}`;
          pending.set(rid, { resolve, reject });
          send({ t: 'request', rid, method, params });
        }),
        closed: () => link.closed?.(),
      }, { ...opts, timeoutMs: 15000 });
      lastDown = '';
      send({ t: 'ready', state: watch.state, views: watch.views });
      await ended;
      link.watch = null;
      for (const p of pending.values()) p.reject(new Error('The connection to the service ended'));
      pending.clear();
      if (done) break;
      await sleep(500);
    } catch (e) {
      const code = e instanceof ServiceError ? e.code : 'failed', message = (e as Error).message;
      if (code === 'unreachable' || code === 'no_token' || code === 'timeout') {
        if (!(await launchService(io.env, opts))) { down(BRIDGE_TEXT.noStart); await sleep(5000); }
      } else if (/unknown method/.test(message)) {
        // A service from before the engine moved into it: replace it, unless it still has jobs to finish.
        if (await replaceOldService(opts)) continue;
        down(BRIDGE_TEXT.oldBusy); await sleep(15000);
      } else { down(BRIDGE_TEXT.noEngine); await sleep(10000); }
    }
  }
  return 0;
}

/** Stops a service that predates the engine when nothing runs on it. True when it was stopped. */
async function replaceOldService(opts: Opts): Promise<boolean> {
  try {
    const r = await call('ping', undefined, { ...opts, timeoutMs: 2000 });
    if ((await call('list', { limit: 500 }, opts)).some(j => !isTerminal(j.state))) return false;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(r.pid), '/F'], { windowsHide: true, stdio: 'ignore' }); else process.kill(r.pid);
    for (let i = 0; i < 40; i++) { await sleep(250); try { await call('ping', undefined, { ...opts, timeoutMs: 500 }); } catch { return true; } }
    return false;
  } catch { return true; }
}

/** The bridge on this process's own stdin and stdout. */
export function stdioBridge(env: NodeJS.ProcessEnv): BridgeIo {
  return { out: line => { process.stdout.write(line); }, lines: createInterface({ input: process.stdin, crlfDelay: Infinity }), env };
}
