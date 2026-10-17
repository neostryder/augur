import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineApi, ResetEvent } from '@augur/core';
import { IpcServer } from '../../augurd/src/ipc.js';
import { ViewHub } from '../../augurd/src/views.js';
import { call } from '../../augurd/src/client.js';
import { main } from '../src/cli.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'resets-')), token = 'test-token', agentToken = 'test-agent-token';
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\augur-resets-${process.pid}-${Date.now()}` : join(dir, 'service.sock');
  writeFileSync(join(dir, 'token'), token);
  const events: ResetEvent[] = [{ v: 1, id: 'sample.weekly.2026-10-01T12:00:00Z', provider: 'sample', meter: 'weekly', label: 'Weekly', kind: 'reset',
    at: '2026-10-01T12:00:00Z', since: '2026-10-01T11:00:00Z', usedBefore: 83, usedAfter: 0, resetsAtBefore: '2026-10-03T12:00:00Z',
    resetsAtAfter: '2026-10-03T12:00:00Z', windowSeconds: 604800, scheduled: false, earlySeconds: 172800, atLimit: false, creditsBefore: 2, creditsAfter: 1, status: null, plan: null }];
  const server = new IpcServer(null as never, null as never, token, () => null, undefined, null, agentToken);
  server.attachEngine({ api: { state: { resets: events } } as EngineApi, views: new ViewHub() });
  await server.start(pipe);
  cleanup.push(() => server.close());
  const run = async (args: string[]) => {
    let out = '', err = '';
    const code = await main(args, { out: t => { out += t; }, err: t => { err += t; }, stdin: () => '', env: { AUGURD_DATA: dir, AUGURD_PIPE: pipe }, cwd: dir });
    return { code, out, err };
  };
  return { dir, pipe, events, run, server, agentToken };
}

describe('augur resets', () => {
  it('prints summary lines and a table with local time, UTC, usage, early hours, and credits', async () => {
    const { run } = await boot();
    const r = await run(['resets']);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(r.out).toContain('1 resets recorded: 0 scheduled, 1 early, and 0 at the limit.');
    expect(r.out).toContain('Local time | UTC');
    expect(r.out).toContain(new Date('2026-10-01T12:00:00Z').toLocaleString('en-US', { timeZoneName: 'short' }));
    expect(r.out).toContain('2026-10-01T12:00:00.000Z | sample | weekly | 83% | 0% | 48.0 hours | 2 | 1');
  });

  it('prints scheduled resets and absent credits', async () => {
    const { run, events } = await boot();
    events[0]!.scheduled = true; events[0]!.earlySeconds = 0;
    events[0]!.creditsBefore = null; events[0]!.creditsAfter = null;
    const r = await run(['resets']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('83% | 0% | scheduled | - | -');
  });

  it('returns the endpoint body as JSON and supports filters and limits', async () => {
    const { run, events } = await boot();
    const r = await run(['resets', '--provider', 'sample', '--limit', '1', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ events, summary: { rows: 1, meters: [{ provider: 'sample', early: 1 }] } });
    expect(JSON.parse((await run(['resets', '--provider', 'missing', '--json'])).out)).toEqual({ events: [], summary: { rows: 0, meters: [] } });
    expect((await run(['resets', '--limit', 'oops'])).code).toBe(1);
    expect((await run(['resets', '--help'])).out).toContain('augur resets [--provider <id>] [--limit <n>]');
  });

  it('allows an authenticated read with the restricted token and rejects a wrong token', async () => {
    const { pipe, agentToken } = await boot();
    expect(await call('resets', undefined, { pipe, token: agentToken })).toMatchObject({ summary: { rows: 1 } });
    await expect(call('resets', undefined, { pipe, token: 'wrong' })).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('uses the usual service-down message and exit code', async () => {
    const { run, server } = await boot();
    await server.close();
    const r = await run(['resets']);
    expect(r.code).toBe(4);
    expect(r.err).toContain('The service is not running');
  });
});
