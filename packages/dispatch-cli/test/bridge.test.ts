import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { call, startService } from '@augur/augurd';
import { makeEnv } from '../../augurd/test/harness.js';
import { bridge } from '../src/bridge.js';

vi.setConfig({ testTimeout: 60000 });
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

/** Lines written to the bridge's input, ended by close(). */
function input() {
  const queue: string[] = [], waiting: Array<(r: IteratorResult<string>) => void> = [];
  let ended = false;
  return {
    push(line: string) { const w = waiting.shift(); if (w) w({ value: line, done: false }); else queue.push(line); },
    close() { ended = true; for (const w of waiting.splice(0)) w({ value: undefined, done: true }); },
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<string>>(res => { const l = queue.shift(); if (l !== undefined) res({ value: l, done: false }); else if (ended) res({ value: undefined, done: true }); else waiting.push(res); }) };
    },
  };
}

describe('augur bridge', () => {
  it('hands the window app the whole state, runs its commands, and ends when the app closes its input', async () => {
    const e = makeEnv(), appDir = mkdtempSync(join(tmpdir(), 'augur-bridge-'));
    const saved = { app: process.env.AUGUR_APP_DIR, keys: process.env.AUGUR_KEYSTORE };
    process.env.AUGUR_APP_DIR = appDir; process.env.AUGUR_KEYSTORE = 'file';
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\augurd-bridge-${Date.now()}-${Math.floor(Math.random() * 1e6)}` : join(e.root, 'b.sock');
    const svc = await startService({ dir: e.dir, home: e.home, pipe, routesPath: e.routesPath, engine: true });
    cleanup.push(async () => {
      await svc.stop().catch(() => {}); e.dispose(); rmSync(appDir, { recursive: true, force: true });
      if (saved.app === undefined) delete process.env.AUGUR_APP_DIR; else process.env.AUGUR_APP_DIR = saved.app;
      if (saved.keys === undefined) delete process.env.AUGUR_KEYSTORE; else process.env.AUGUR_KEYSTORE = saved.keys;
    });

    const lines = input(), out: Array<Record<string, unknown>> = [];
    const seen = async (match: (m: Record<string, unknown>) => boolean) => {
      for (let i = 0; i < 200; i++) { const m = out.find(match); if (m) return m; await new Promise(r => setTimeout(r, 25)); }
      throw new Error(`no matching line in ${JSON.stringify(out)}`);
    };
    const o = { dir: e.dir, pipe };
    const done = bridge({ out: l => { out.push(JSON.parse(l) as Record<string, unknown>); }, lines, env: process.env }, o, 'C:/Augur/Augur.exe');

    const ready = await seen(m => m.t === 'ready');
    expect((ready.state as { firstRun: boolean }).firstRun).toBe(true);
    expect((await call('engine_state', { keys: [] }, o)).views).toEqual([{ kind: 'window', caps: ['notify', 'websession', 'signin'] }]);

    lines.push(JSON.stringify({ t: 'call', id: 7, method: 'setProviderKey', args: ['minimax', 'apiKey', 'sk-test'] }));
    expect(await seen(m => m.t === 'result' && m.id === 7)).toEqual({ t: 'result', id: 7, result: null });
    const change = await seen(m => m.t === 'change' && (m.keys as string[]).includes('secrets'));
    expect((change.state as { secrets: string[] }).secrets).toContain('minimax.apiKey');

    lines.push(JSON.stringify({ t: 'call', id: 8, method: 'noSuchCommand', args: [] }));
    expect((await seen(m => m.t === 'result' && m.id === 8)).error).toMatch(/Unknown engine command/);

    lines.close();
    await expect(done).resolves.toBe(0);
    for (let i = 0; i < 50 && (await call('engine_state', { keys: [] }, o)).views.length; i++) await new Promise(r => setTimeout(r, 20));
    expect((await call('engine_state', { keys: [] }, o)).views).toEqual([]);
  });
});
