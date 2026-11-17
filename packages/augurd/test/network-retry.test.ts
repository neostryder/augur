import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeEnv, request, sleep, submitOk, terminal, until } from './harness.js';
import type { Env } from './harness.js';

vi.setConfig({ testTimeout: 90000 });
const envs: Env[] = [];
const setup = (...a: Parameters<typeof makeEnv>) => { const e = makeEnv(...a); envs.push(e); return e; };
afterEach(() => { while (envs.length) envs.pop()!.dispose(); });
const kinds = (e: Env, id: string) => e.store.events(id).map(x => x.kind);

const quick = { networkBackoffS: () => 0.05, offline: () => false };
const runner = (networkRetries: number) => ({ runner: { charterDir: '', ambient: 'keep' as const, failover: 'off' as const, networkRetries } });
// A route whose command fails with a connection error for its first `times` runs, then answers. A marker file counts the runs.
const flaky = (marker: string, times: number) => ({
  model: 'test/fake', adapter: 'exec',
  options: {
    command: process.execPath,
    argsJson: JSON.stringify(['-e', [
      "const fs = require('fs');",
      `const f = ${JSON.stringify(marker)};`,
      "const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0;",
      'fs.writeFileSync(f, String(n + 1));',
      `if (n < ${times}) { process.stderr.write('request failed: fetch failed ECONNREFUSED\\n'); process.exit(1); }`,
      "process.stdout.write('back online');",
    ].join('\n')]),
  },
});
const settled = (e: Env, count: number) => until(e.sup, () => {
  const jobs = e.store.list({ limit: 30 });
  return jobs.length >= count && jobs.every(j => !['queued', 'running', 'cancel_requested', 'needs_approval'].includes(j.state)) ? jobs : null;
});
const chain = (e: Env, id: string) => {
  const out = [e.store.get(id)!];
  while (out[out.length - 1]!.retriedAs) out.push(e.store.get(out[out.length - 1]!.retriedAs!)!);
  return out;
};

describe('network outage retry', () => {
  it('runs a job again on the same route after a network failure, and the retry completes', async () => {
    const e = setup(runner(10), undefined, quick);
    e.writeRoutes({ flaky: flaky(join(e.root, 'marker'), 2) });
    const id = submitOk(e.sup, request({ route: 'flaky', text: 'GO', cwd: e.root }));
    await settled(e, 3);
    const jobs = chain(e, id);
    expect(jobs.map(j => j.state)).toEqual(['failed', 'failed', 'completed']);
    expect(jobs.every(j => j.route === 'flaky')).toBe(true);
    expect(e.sup.result(jobs[2]!.id)?.answer).toBe('back online');
    expect(e.store.events(id).find(ev => ev.kind === 'network_retry_waiting')?.detail).toBe('network failure on flaky: retry 1 of 10 in 0.05s');
    expect(e.store.events(id).find(ev => ev.kind === 'network_retry')?.detail).toBe(`flaky again, retry 1 of 10, as ${jobs[1]!.id}`);
    expect(e.store.events(jobs[2]!.id).find(ev => ev.kind === 'network_retry')?.detail).toBe('retry 2 of 10 after a network failure on flaky');
  });

  it('stops after the configured number of retries', async () => {
    const e = setup(runner(2), undefined, quick);
    e.writeRoutes({ flaky: flaky(join(e.root, 'marker'), 99) });
    const id = submitOk(e.sup, request({ route: 'flaky', text: 'GO', cwd: e.root }));
    await settled(e, 3);
    const jobs = chain(e, id);
    expect(jobs.map(j => j.state)).toEqual(['failed', 'failed', 'failed']);
    expect(kinds(e, jobs[2]!.id)).toContain('network_retry_exhausted');
    await sleep(300);
    expect(e.store.list({ limit: 30 })).toHaveLength(3);
  });

  it('does not retry when runner.networkRetries is 0', async () => {
    const e = setup(runner(0), undefined, quick);
    e.writeRoutes({ flaky: flaky(join(e.root, 'marker'), 99) });
    const id = submitOk(e.sup, request({ route: 'flaky', text: 'GO', cwd: e.root }));
    expect((await terminal(e.sup, e.store, id)).state).toBe('failed');
    await sleep(300);
    expect(e.store.list({ limit: 30 })).toHaveLength(1);
    expect(kinds(e, id)).not.toContain('network_retry_waiting');
  });

  it('does not retry a failure that is not a network failure', async () => {
    const e = setup(runner(10), undefined, quick);
    e.writeRoutes({ broken: { model: 'test/fake', adapter: 'exec', options: { command: process.execPath, argsJson: JSON.stringify(['-e', "process.stderr.write('bad input\\n'); process.exit(1);"]) } } });
    const id = submitOk(e.sup, request({ route: 'broken', text: 'GO', cwd: e.root }));
    expect((await terminal(e.sup, e.store, id)).state).toBe('failed');
    await sleep(300);
    expect(e.store.list({ limit: 30 })).toHaveLength(1);
  });
});
