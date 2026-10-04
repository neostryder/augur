// How the desktop panel reaches the engine: the usage engine runs in the background service, and the app's bridge process carries its
// state, changes and requests to this page and the page's commands back. The panel sees the same EngineApi either way.
import { ENGINE_COMMANDS, type EngineApi, type EngineKey, type EngineState, type Shell } from '@augur/core';

type Out =
  | { t: 'ready'; state: EngineState }
  | { t: 'change'; keys: EngineKey[]; state: Partial<EngineState> }
  | { t: 'request'; rid: string; method: string; params: Record<string, unknown> }
  | { t: 'result'; id: number; result?: unknown; error?: string }
  | { t: 'down'; message: string }
  | { t: 'exit' }
  | { t: 'views' };

export const LINK_TEXT = {
  restarting: 'The link to the Augur service stopped. Starting it again.',
  noLink: 'The Augur service is not installed with this build.',
};

/**
 * Starts the link and resolves once the service has sent the whole state. `onDown` gets a message while the service cannot be reached
 * (also before the first state arrives) and null once it is back.
 */
export async function connectEngine(shell: Shell, onDown: (message: string | null) => void): Promise<EngineApi> {
  if (!shell.engineLink) throw new Error(LINK_TEXT.noLink);
  const startLink = shell.engineLink.bind(shell);
  let state = {} as EngineState, send: ((line: string) => Promise<void>) | null = null, ids = 0, restarts = 0;
  const listeners = new Set<(keys: EngineKey[]) => void>(), calls = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  const fire = (keys: EngineKey[]) => { for (const l of listeners) l(keys); };
  let ready: () => void;
  const first = new Promise<void>((res) => { ready = res; });

  const answer = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === 'notify') { await shell.notify(String(params.title ?? ''), String(params.body ?? '')); return null; }
    if (method === 'webSession') return (await shell.host.webSession?.(String(params.site ?? ''), { fresh: params.fresh === true })) ?? null;
    throw new Error(`This window does not answer ${method}`);
  };

  const onLine = (line: string) => {
    let msg: Out;
    try { msg = JSON.parse(line) as Out; } catch { return; }
    switch (msg.t) {
      case 'ready': {
        const again = Object.keys(state).length > 0;
        state = msg.state; restarts = 0; onDown(null);
        if (again) fire(Object.keys(state) as EngineKey[]); else ready();
        break;
      }
      case 'change': Object.assign(state, msg.state); fire(msg.keys); break;
      case 'request': {
        const rid = msg.rid;
        answer(msg.method, msg.params ?? {}).then(
          (result) => send?.(JSON.stringify({ t: 'reply', rid, result: result ?? null })),
          (e: Error) => send?.(JSON.stringify({ t: 'reply', rid, error: e.message || 'failed' })),
        ).catch(() => undefined);
        break;
      }
      case 'result': {
        const c = calls.get(msg.id);
        calls.delete(msg.id);
        if (typeof msg.error === 'string') c?.reject(new Error(msg.error)); else c?.resolve(msg.result ?? null);
        break;
      }
      case 'down': onDown(msg.message); break;
      case 'exit': {
        // The bridge process ended on its own. Start another, waiting longer each time it keeps ending.
        send = null;
        for (const c of calls.values()) c.reject(new Error(LINK_TEXT.restarting));
        calls.clear();
        onDown(LINK_TEXT.restarting);
        setTimeout(() => void open(), Math.min(1000 * 2 ** restarts++, 30000));
        break;
      }
    }
  };

  const open = async () => {
    try { send = (await startLink(onLine)).send; }
    catch (e) { onDown(e instanceof Error ? e.message : String(e)); setTimeout(() => void open(), Math.min(1000 * 2 ** restarts++, 30000)); }
  };
  await open();
  await first;

  const call = (method: string, args: unknown[]) => new Promise<unknown>((resolve, reject) => {
    if (!send) { reject(new Error(LINK_TEXT.restarting)); return; }
    const id = ++ids;
    calls.set(id, { resolve, reject });
    send(JSON.stringify({ t: 'call', id, method, args })).catch((e: unknown) => { calls.delete(id); reject(e instanceof Error ? e : new Error(String(e))); });
  });
  const api = {
    get state() { return state; },
    onChange(listener: (keys: EngineKey[]) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  } as EngineApi;
  for (const m of ENGINE_COMMANDS) (api as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => call(m, args);
  return api;
}
