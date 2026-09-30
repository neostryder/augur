import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { call, readToken, ServiceError } from '../src/client.js';
import { startService } from '../src/main.js';
import { JOBHOST, makeEnv, request, sleep } from './harness.js';
import type { Env } from './harness.js';

vi.setConfig({ testTimeout: 90000 });
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function boot() {
  const e: Env = makeEnv();
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\augurd-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}` : join(e.root, 'test.sock');
  writeFileSync(join(e.dir, 'config.json'), JSON.stringify({ requirePick: false, verifyNamed: 'record', adapters: ['codex-exec', 'exec'], jobhostPath: existsSync(JOBHOST) ? JOBHOST : null }));
  const svc = await startService({ dir: e.dir, home: e.home, pipe, routesPath: e.routesPath });
  cleanup.push(async () => { await svc.stop().catch(() => {}); e.dispose(); });
  const o = { dir: e.dir, pipe };
  return { e, svc, pipe, o, stopOnly: () => svc.stop() };
}

async function finished(o: { dir: string; pipe: string }, id: string) {
  for (let i = 0; i < 300; i++) {
    const j = await call('status', { id }, o);
    if (j && !['queued', 'running', 'cancel_requested'].includes(j.state)) return j;
    await sleep(150);
  }
  throw new Error('job did not finish');
}

describe('the control endpoint', () => {
  it('answers a caller that holds the token, and turns away one that does not', async () => {
    const { o, e } = await boot();
    expect(await call('ping', undefined, o)).toMatchObject({ pid: process.pid, version: 1 });
    await expect(call('ping', undefined, { ...o, token: 'x'.repeat(64) })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(readToken(e.dir)).toHaveLength(64);
    await expect(call('ping', undefined, { ...o, dir: join(e.root, 'nowhere') })).rejects.toBeInstanceOf(ServiceError);
  });

  it('runs a job end to end through the pipe and shows its record, events, logs and result', async () => {
    const { o, e } = await boot();
    const sub = await call('submit', request({ text: 'WRITE out.txt\nENV CODEX_HOME', expectFile: 'out.txt', cwd: e.root }), o);
    expect('id' in sub).toBe(true);
    const id = (sub as { id: string }).id;
    const job = await finished(o, id);
    expect(job).toMatchObject({ state: 'completed', route: 'fake', usage: { inputTokens: 1200 } });
    const events = await call('events', { id }, o);
    expect(events.map(x => x.kind)).toContain('artifact_validated');
    expect((await call('logs', { id }, o))!.text).toContain('turn.completed');
    expect((await call('result', { id }, o))!.answer).toBe('final message');
    expect((await call('list', { limit: 5 }, o)).map(j => j.id)).toContain(id);
    expect(await call('status', { id: 'missing' }, o)).toBeNull();
  });

  it('records text lengths and labels each figure in the accounting answer, using the owner\'s rate card', async () => {
    const { o, e } = await boot();
    const text = 'WRITE out.txt\nENV CODEX_HOME';
    const id = (await call('submit', request({ text, expectFile: 'out.txt', cwd: e.root }), o) as { id: string }).id;
    const job = await finished(o, id);
    expect(job).toMatchObject({ promptChars: text.length, answerChars: 'final message'.length });
    const bare = await call('accounting', {}, o);
    expect(bare.jobs[0]).toMatchObject({ id, model: 'test/fake', accounted: { inputTokens: { value: 1200, provenance: 'reported' }, costUsd: null } });
    mkdirSync(join(e.home, 'dispatch'), { recursive: true });
    writeFileSync(join(e.home, 'dispatch', 'rates.json'), JSON.stringify({ 'test/fake': { inputPerM: 1_000_000, outputPerM: 0 }, broken: { inputPerM: 'x' } }));
    // The job's usage includes cached tokens, so a rate with no cached price gives no cost rather than a guess.
    const unpriced = await call('accounting', {}, o);
    expect(unpriced.ratedModels).toEqual(['test/fake']);
    expect(unpriced.jobs[0]!.accounted.costUsd).toBeNull();
    writeFileSync(join(e.home, 'dispatch', 'rates.json'), JSON.stringify({ 'test/fake': { inputPerM: 1_000_000, outputPerM: 0, cachedReadPerM: 0 } }));
    const rated = await call('accounting', {}, o);
    expect(rated.jobs[0]!.accounted.costUsd).toMatchObject({ value: 200, provenance: 'derived' });
    expect(rated.routes.fake!.totals).toMatchObject({ jobs: 1, costJobs: 1 });
  });

  it('reports a rejection to the caller and lists routes without their options', async () => {
    const { o, e } = await boot();
    const rej = await call('submit', request({ route: 'ask' }, e.root), o);
    expect(rej).toMatchObject({ rejected: { code: 'ask_first' } });
    const routes = await call('routes', undefined, o);
    expect(routes.find(r => r.name === 'fake')).toEqual({ name: 'fake', model: 'test/fake', adapter: 'codex-exec', problem: null });
    expect(JSON.stringify(routes)).not.toContain('prefixArgs');
  });

  it('keeps a running job going when the service stops, and a new service picks it up', async () => {
    const { o, e, stopOnly, pipe } = await boot();
    const sub = await call('submit', request({ text: 'WRITE kept.txt\nSLEEP 4', expectFile: 'kept.txt', cwd: e.root }), o) as { id: string };
    for (let i = 0; i < 100 && (await call('status', { id: sub.id }, o))?.state !== 'running'; i++) await sleep(100);
    await sleep(800);
    await stopOnly();
    await expect(call('ping', undefined, { ...o, timeoutMs: 2000 })).rejects.toBeInstanceOf(ServiceError);
    const again = await startService({ dir: e.dir, home: e.home, pipe, routesPath: e.routesPath });
    cleanup.push(() => again.stop());
    const job = await finished(o, sub.id);
    expect(job.state).toBe('completed');
    expect((await call('events', { id: sub.id }, o)).map(x => x.kind)).toContain('reconciled');
  });

  it('refuses to start a second service on the same endpoint', async () => {
    const { e, pipe } = await boot();
    await expect(startService({ dir: e.dir, home: e.home, pipe, routesPath: e.routesPath })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});

describe('the token file', () => {
  it('is created once and kept across restarts', async () => {
    const { e, stopOnly, pipe } = await boot();
    const first = readFileSync(join(e.dir, 'token'), 'utf8');
    await stopOnly();
    const again = await startService({ dir: e.dir, home: e.home, pipe, routesPath: e.routesPath });
    cleanup.push(() => again.stop());
    expect(readFileSync(join(e.dir, 'token'), 'utf8')).toBe(first);
  });
});
