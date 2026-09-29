import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startService } from '@augur/augurd';
import { JOBHOST, makeEnv } from '../../augurd/test/harness.js';
import type { Env } from '../../augurd/test/harness.js';
import { main } from '../src/cli.js';

vi.setConfig({ testTimeout: 90000 });
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function boot() {
  const e: Env = makeEnv();
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\augurd-cli-${Date.now()}-${Math.floor(Math.random() * 1e6)}` : join(e.root, 'cli.sock');
  writeFileSync(join(e.dir, 'config.json'), JSON.stringify({ adapters: ['codex-exec', 'exec'], jobhostPath: existsSync(JOBHOST) ? JOBHOST : null }));
  const svc = await startService({ dir: e.dir, home: e.home, pipe, routesPath: e.routesPath });
  cleanup.push(async () => { await svc.stop().catch(() => {}); e.dispose(); });
  const run = async (args: string[], stdin = '', env: NodeJS.ProcessEnv = {}) => {
    let out = '', err = '';
    const code = await main(args, { out: t => { out += t; }, err: t => { err += t; }, stdin: () => stdin, env: { ...process.env, AUGURD_DATA: e.dir, AUGURD_PIPE: pipe, ...env }, cwd: e.root });
    return { code, out, err };
  };
  return { e, run };
}

describe('augur run', () => {
  it('starts a job and returns its id, then waits and prints the final message', async () => {
    const { run } = await boot();
    const start = await run(['run', 'fake', '--prompt', 'WRITE a.txt\nSLEEP 1', '--expect-file', 'a.txt', '--json']);
    expect(start.code).toBe(0);
    const id = (JSON.parse(start.out) as { id: string }).id;
    const wait = await run(['wait', id, '--timeout', '30', '--json']);
    expect(wait.code).toBe(0);
    expect(JSON.parse(wait.out)).toMatchObject({ id, state: 'completed' });
    const res = await run(['result', id]);
    expect(res.out.trim()).toBe('final message');
  });

  it('with --wait reads the prompt from standard input and exits with the job outcome', async () => {
    const { run } = await boot();
    const ok = await run(['run', 'fake', '--prompt-file', '-', '--wait'], 'SLEEP 0');
    expect(ok.code).toBe(0);
    expect(ok.out.trim()).toBe('final message');
    const failed = await run(['run', 'fake', '--prompt', 'EXIT 3', '--wait']);
    expect(failed.code).toBe(4);
    const missing = await run(['run', 'fake', '--prompt', 'SLEEP 0', '--expect-file', 'nope.txt', '--wait']);
    expect(missing.code).toBe(5);
  });

  it('exits 2 with the reason when a rule rejects the job, and 1 for a bad command line', async () => {
    const { run } = await boot();
    const rej = await run(['run', 'ask', '--prompt', 'x']);
    expect(rej.code).toBe(2);
    expect(rej.err).toContain('ask_first');
    expect((await run(['run', 'ask', '--prompt', 'x', '--named'])).code).toBe(0);
    expect((await run(['run', 'fake'])).code).toBe(1);
    expect((await run(['run', 'fake', '--prompt', 'x', '--activity', 'nonsense'])).code).toBe(1);
    expect((await run(['nonsense'])).code).toBe(1);
  });

  it('uses the job identity in its environment as the parent of the jobs it starts', async () => {
    const { run, e } = await boot();
    const boss = await run(['run', 'boss', '--prompt', 'HANG', '--json']);
    const bossId = (JSON.parse(boss.out) as { id: string }).id;
    const child = await run(['run', 'boss', '--prompt', 'HANG', '--json'], '', { AUGUR_JOB_ID: bossId, AUGUR_ROOT_JOB_ID: bossId });
    expect(child.code).toBe(0);
    const childId = (JSON.parse(child.out) as { id: string }).id;
    const jobs = await run(['jobs', '--root', bossId, '--json']);
    expect((JSON.parse(jobs.out) as Array<{ id: string; parentJobId: string | null }>).find(j => j.id === childId)?.parentJobId).toBe(bossId);
    const plainParent = (JSON.parse((await run(['run', 'fake', '--prompt', 'HANG', '--json'])).out) as { id: string }).id;
    const denied = await run(['run', 'fake', '--prompt', 'x', '--json'], '', { AUGUR_JOB_ID: plainParent });
    expect(denied.code).toBe(2);
    expect(denied.err).toContain('delegation_not_granted');
    await run(['cancel', plainParent]);
    await run(['cancel', bossId]); await run(['cancel', childId]);
    expect(e.store.get(bossId)).toBeTruthy();
  });
});

describe('the other commands', () => {
  it('lists jobs and routes, shows status and logs, cancels, and reports a wait that timed out', async () => {
    const { run } = await boot();
    const id = (JSON.parse((await run(['run', 'fake', '--prompt', 'HANG', '--json'])).out) as { id: string }).id;
    expect((await run(['wait', id, '--timeout', '1'])).code).toBe(124);
    expect((await run(['jobs'])).out).toContain(id);
    expect((await run(['status', id])).out).toContain('running');
    expect((await run(['routes'])).out).toContain('test/fake');
    expect((await run(['cancel', id])).out).toContain('Cancel requested');
    expect((await run(['wait', id, '--timeout', '30'])).code).toBe(6);
    expect((await run(['logs', id])).code).toBe(0);
    expect((await run(['status', 'missing'])).code).toBe(1);
  });

  it('says so when the service is not running', async () => {
    const { run, e } = await boot();
    const off = await main(['service', 'status'], { out: () => {}, err: () => {}, stdin: () => '', env: { ...process.env, AUGURD_DATA: e.dir, AUGURD_PIPE: process.platform === 'win32' ? '\\\\.\\pipe\\augurd-not-here' : join(e.root, 'none.sock') }, cwd: e.root });
    expect(off).toBe(4);
    expect((await run(['service', 'status'])).out).toContain('is running');
  });
});
