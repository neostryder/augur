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
  writeFileSync(join(e.dir, 'config.json'), JSON.stringify({ requirePick: false, verifyNamed: 'record', adapters: ['codex-exec', 'exec'], jobhostPath: existsSync(JOBHOST) ? JOBHOST : null }));
  const svc = await startService({ dir: e.dir, home: e.home, pipe, routesPath: e.routesPath });
  cleanup.push(async () => { await svc.stop().catch(() => {}); e.dispose(); });
  // `run` has no default activity or data tier and defaults to read tools and text output, so most tests state the usual authority once here. `--bare` skips that.
  const withUsual = (args: string[]): string[] => {
    if (args[0] !== 'run') return args;
    if (args.includes('--bare')) return args.filter(a => a !== '--bare');
    const flag = (name: string, value: string) => args.includes(name) ? [] : [name, value];
    return [...args, ...flag('--activity', 'write_code'), ...flag('--data', 'internal'), ...flag('--tools', 'write'), ...flag('--output', 'write_files')];
  };
  const run = async (args: string[], stdin = '', env: NodeJS.ProcessEnv = {}) => {
    let out = '', err = '';
    const code = await main(withUsual(args), { out: t => { out += t; }, err: t => { err += t; }, stdin: () => stdin, env: { ...process.env, AUGURD_DATA: e.dir, AUGURD_PIPE: pipe, ...env }, cwd: e.root });
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
    const listed = JSON.parse((await run(['routes', '--json'])).out) as Array<{ name: string; problem: string | null }>;
    expect(listed.find(r => r.name === 'fake')).toMatchObject({ problem: null });
    expect(listed.find(r => r.name === 'fake')).not.toHaveProperty('options');
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

  it('tests a route with a fixed prompt and says when the rules or the route refuse it', async () => {
    const { run } = await boot();
    const ok = await run(['test', 'fake', '--wait']);
    expect(ok.err).toBe('');
    expect(ok.code).toBe(0);
    expect(ok.out.trim()).toBe('final message');
    const queued = await run(['test', 'fake', '--json']);
    expect(queued.code).toBe(0);
    expect(JSON.parse(queued.out)).toHaveProperty('id');
    const missing = await run(['test', 'nowhere']);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('nowhere');
    expect((await run(['test'])).code).toBe(1);
  });

  it('shows the service settings and changes one, refusing a value the service would ignore', async () => {
    const { run } = await boot();
    const shown = JSON.parse((await run(['config', '--json'])).out) as Array<{ key: string; value: string }>;
    expect(shown.find(l => l.key === 'maxDepth')).toBeDefined();
    const set = await run(['config', 'set', 'maxDepth', '1']);
    expect(set.code).toBe(0);
    expect(set.out).toContain('now 1');
    expect((JSON.parse((await run(['config', '--json'])).out) as Array<{ key: string; value: string }>).find(l => l.key === 'maxDepth')?.value).toBe('1');
    const bad = await run(['config', 'set', 'maxDepth', '99']);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('whole number');
  });

  it('leaves the service running while a job is running when stop is asked to wait for idle', async () => {
    const { run } = await boot();
    const start = await run(['run', 'fake', '--prompt', 'SLEEP 30', '--json']);
    const id = (JSON.parse(start.out) as { id: string }).id;
    const stop = await run(['service', 'stop', '--if-idle']);
    expect(stop.code).toBe(4);
    expect(stop.out).toContain('still running');
    expect((await run(['service', 'status'])).out).toContain('is running');
    await run(['cancel', id]);
  });
});

describe('augur pick and augur pressure', () => {
  it('ranks models for a task and says which routes reach each', async () => {
    const { run } = await boot();
    const r = await run(['pick', '--activity', 'write_code', '--data', 'internal', '--fit', 'test/fake=1,test/patch=0.2', '--json']);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out) as { pick: string; routes: Record<string, string[]> };
    expect(out.pick).toBe('test/fake');
    expect(out.routes['test/fake']).toContain('fake');
    const text = await run(['pick', '--activity', 'write_code', '--data', 'internal']);
    expect(text.out).toMatch(/^Pick: /);
    expect((await run(['pick', '--activity', 'write_code', '--data', 'nope'])).code).toBe(1);
    expect((await run(['pick', '--activity', 'write_code', '--data', 'internal', '--fit', 'test/fake=2'])).code).toBe(1);
  });

  it('reports a usage factor for each model once there is a usage snapshot', async () => {
    const { run, e } = await boot();
    expect((await run(['pressure'])).code).toBe(4);
    e.writeUsage(30);
    const r = await run(['pressure', '--json']);
    expect(JSON.parse(r.out).factors['test/fake']).toBeGreaterThan(0);
  });

  it('shows tokens and cost per route with each figure labelled', async () => {
    const { run } = await boot();
    expect((await run(['usage'])).out.trim()).toBe('No jobs yet.');
    await run(['run', 'fake', '--prompt', 'SLEEP 0', '--wait']);
    const text = await run(['usage']);
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/^fake\s+1,200 in, 39 out, no rate set/m);
    expect(text.out).toContain('in 1,200 (reported), out 39 (reported), cost unknown');
    const json = JSON.parse((await run(['usage', '--json'])).out) as { routes: Record<string, { totals: { jobs: number } }> };
    expect(json.routes.fake!.totals.jobs).toBe(1);
  });

  it('accepts --allow for the two checks and nothing else', async () => {
    const { run } = await boot();
    expect((await run(['run', 'fake', '--prompt', 'SLEEP 0', '--allow', 'unpicked,exhausted', '--json'])).code).toBe(0);
    expect((await run(['run', 'fake', '--prompt', 'SLEEP 0', '--allow', 'everything'])).code).toBe(1);
  });
});

describe('augur note-prompt', () => {
  it('records the models a message names, and needs a session', async () => {
    const { run } = await boot();
    const r = await run(['note-prompt', '--session', 's1', '--json'], 'run it on the fake model please');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).models).toEqual(expect.arrayContaining(['test/fake']));
    const none = await run(['note-prompt'], 'hello', { CLAUDE_CODE_SESSION_ID: '' });
    expect(none.code).toBe(1);
  });
});

describe('augur run defaults', () => {
  it('needs an activity and a data tier, and defaults to read tools and text output', async () => {
    const { run } = await boot();
    const bare = await run(['run', 'fake', '--prompt', 'SLEEP 0', '--bare']);
    expect(bare.code).toBe(1);
    expect(bare.err).toContain('--activity and --data');
    const partial = await run(['run', 'fake', '--prompt', 'SLEEP 0', '--activity', 'research', '--bare']);
    expect(partial.code).toBe(1);
    const read = await run(['run', 'fake', '--prompt', 'SLEEP 0', '--activity', 'research', '--data', 'internal', '--bare', '--json']);
    expect(read.code).toBe(0);
  });

  it('reads a prompt file itself and sends the text', async () => {
    const { e, run } = await boot();
    writeFileSync(join(e.root, 'p.txt'), 'SLEEP 0');
    const res = await run(['run', 'fake', '--prompt-file', 'p.txt', '--wait']);
    expect(res.code).toBe(0);
    const missing = await run(['run', 'fake', '--prompt-file', 'nope.txt']);
    expect(missing.code).toBe(1);
  });
});
