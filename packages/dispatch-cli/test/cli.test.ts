import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startService } from '@augur/augurd';
import { JOBHOST, ROUTES, makeEnv } from '../../augurd/test/harness.js';
import type { Env } from '../../augurd/test/harness.js';
import { main, parse } from '../src/cli.js';

vi.setConfig({ testTimeout: 90000 });
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function boot(extra: Record<string, unknown> = {}) {
  const e: Env = makeEnv();
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\augurd-cli-${Date.now()}-${Math.floor(Math.random() * 1e6)}` : join(e.root, 'cli.sock');
  writeFileSync(join(e.dir, 'config.json'), JSON.stringify({ requirePick: false, verifyNamed: 'record', adapters: ['codex-exec', 'exec'], jobhostPath: existsSync(JOBHOST) ? JOBHOST : null, ...extra }));
  const svc = await startService({ dir: e.dir, home: e.home, pipe, routesPath: e.routesPath, engine: false });
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

describe('a job retried after it failed', () => {
  const limit = {
    model: 'test/fake', adapter: 'exec', fallback: ['fake'],
    options: { command: process.execPath, argsJson: JSON.stringify(['-e', 'process.stderr.write("rate limit\\n");process.exit(1)']) },
  };

  it('follows the chain from wait, result and run --wait', async () => {
    const { run, e } = await boot({ runner: { failover: 'on' } });
    e.writeRoutes({ ...ROUTES, limited: limit });
    const start = await run(['run', 'limited', '--prompt', 'SLEEP 0', '--json']);
    expect(start.code).toBe(0);
    const id = (JSON.parse(start.out) as { id: string }).id;
    const wait = await run(['wait', id, '--timeout', '40']);
    expect(wait.code).toBe(0);
    expect(wait.out).toMatch(/retried on fake as [0-9a-f]+/);
    const again = JSON.parse((await run(['wait', id, '--json'])).out) as { id: string; state: string; chain: string[] };
    expect(again.chain[0]).toBe(id);
    expect(again.chain).toHaveLength(2);
    expect(again.id).toBe(again.chain[1]);
    expect(again.state).toBe('completed');
    const res = await run(['result', id]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/retried on fake as [0-9a-f]+/);
    expect(res.out).toContain('final message');
    const body = JSON.parse((await run(['result', id, '--json'])).out) as { answer: string; chain: string[]; retriedAs: string; job: { id: string; state: string } };
    expect(body.chain).toEqual(again.chain);
    expect(body.retriedAs).toBe(body.job.id);
    expect(body.answer).toBe('final message');
    expect(body.job.state).toBe('completed');
    const waited = await run(['run', 'limited', '--prompt', 'SLEEP 0', '--wait']);
    expect(waited.code).toBe(0);
    expect(waited.out).toMatch(/retried on fake as [0-9a-f]+/);
    expect(waited.out).toContain('final message');
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

  it('prints odds, takes the top score with --best, and previews without a draw', async () => {
    const { run } = await boot();
    const best = await run(['pick', '--activity', 'write_code', '--data', 'internal', '--best', '--json']);
    expect(best.code).toBe(0);
    const body = JSON.parse(best.out) as { pick: string; drawn: boolean; seed: string | null; ranking: Array<{ model: string; odds: number }> };
    expect(body.drawn).toBe(false);
    expect(body.seed).toBeNull();
    expect(body.pick).toBe(body.ranking[0]?.model);
    expect(body.ranking[0]?.odds).toBeGreaterThan(0);
    const text = await run(['pick', '--activity', 'write_code', '--data', 'internal', '--best', '--snippet']);
    expect(text.out).toMatch(/odds \d+%/);
    const preview = await run(['pick-preview', '--activity', 'write_code', '--data', 'internal', '--snippet']);
    expect(preview.code).toBe(0);
    expect(preview.out).toContain('preview: no draw made');
    expect(preview.out).toMatch(/odds \d+%/);
    const json = JSON.parse((await run(['pick-preview', '--activity', 'write_code', '--data', 'internal', '--json'])).out) as { drawn: boolean; seed: string | null };
    expect(json.drawn).toBe(false);
    expect(json.seed).toBeNull();
  });

  it('reports a usage factor for each model once there is a usage snapshot', async () => {
    const { run, e } = await boot();
    expect((await run(['pressure'])).code).toBe(4);
    e.writeUsage(30);
    const r = await run(['pressure', '--json']);
    expect(JSON.parse(r.out).factors['test/fake']).toBeGreaterThan(0);
  });

  it('prints the balance report, and the same report as JSON', async () => {
    const { run, e } = await boot();
    const at = Date.now(), week = 604800;
    writeFileSync(join(e.home, 'usage.json'), JSON.stringify({ providers: { test: { fetchedAt: new Date(at).toISOString(), meters: [{ id: 'weekly', usedPct: 40, windowKind: 'weekly', windowSeconds: week, resetsAt: new Date(at + week * 500).toISOString() }] } } }));
    const text = await run(['balance']);
    expect(text.code).toBe(0);
    expect(text.out).toContain('Balance report');
    expect(text.out).toContain('On pace');
    expect(text.out).toContain('Test, week 40% used, boost 1.3x, odds 100%');
    expect(text.out).toContain('What each kind of work goes to now');
    const json = JSON.parse((await run(['balance', '--days', '3', '--json'])).out) as { picks: { days: number }; mix: unknown[]; pace: Array<{ provider: string; stance: string; boost: number; odds: number | null }> };
    expect(json.picks.days).toBe(3);
    expect(json.mix.length).toBeGreaterThan(0);
    expect(json.pace).toEqual([expect.objectContaining({ provider: 'test', stance: 'on pace', boost: 1.3 })]);
    expect(json.pace[0]?.odds).toBeCloseTo(1, 2);
  });

  it('asks for a brief result and says when the id is not in the decision log', async () => {
    const { run } = await boot();
    const none = await run(['label', 'abc']);
    expect(none.code).toBe(1);
    expect(none.err).toContain('--brief met, partly or missed');
    const unknown = await run(['label', 'abc', '--brief', 'met']);
    expect(unknown.code).toBe(4);
    expect(unknown.err).toContain('No pick or job with that id');
  });

  it('shows tokens and cost per route with each figure labelled', async () => {
    const { run } = await boot();
    expect((await run(['usage'])).out.trim()).toBe('No jobs yet.');
    await run(['run', 'fake', '--prompt', 'SLEEP 0', '--wait']);
    const text = await run(['usage']);
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/^fake\s+1,200 in, 34 out, no rate set/m);
    expect(text.out).toContain('in 1,200 (reported), out 34 (reported), cost unknown');
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

describe('augur claude hook subagent', () => {
  it('prints nothing while the option is off and exits 0 whatever the service says', async () => {
    const { run } = await boot();
    const off = await run(['claude', 'hook', 'subagent'], JSON.stringify({ session_id: 's1', tool_input: { description: 'Survey the tests' } }));
    expect(off).toMatchObject({ code: 0, out: '' });
    const on = await run(['claude', 'hook', 'subagent'], JSON.stringify({ session_id: 's1', tool_input: { description: 'Survey the tests' } }), { CLAUDE_PLUGIN_OPTION_PICK_BEFORE_SUBAGENT: 'true' });
    expect(on.code).toBe(0);
    if (on.out) expect(JSON.parse(on.out).hookSpecificOutput.hookEventName).toBe('PreToolUse');
  });
});

describe('augur run charter flags', () => {
  it('passes --pack through to the charter and --no-charter sends the prompt alone', async () => {
    const { e, run } = await boot();
    const dir = join(e.home, 'charter');
    mkdirSync(join(dir, 'packs'), { recursive: true });
    writeFileSync(join(dir, 'core.md'), 'Core body.');
    writeFileSync(join(dir, 'packs', 'code.md'), 'Code body.');
    writeFileSync(join(dir, 'packs', 'extra.md'), 'Extra body.');
    writeFileSync(join(dir, 'packs', 'review.md'), 'Review body.');
    const packed = await run(['run', 'fake', '--prompt', 'SLEEP 0', '--pack', 'extra,review', '--json']);
    expect(packed.code).toBe(0);
    const id = (JSON.parse(packed.out) as { id: string }).id;
    expect(e.store.get(id)?.charter).toEqual(['core', 'extra', 'review', 'code']);
    expect(e.store.get(id)?.promptChars).toBe('SLEEP 0'.length);
    const bare = await run(['run', 'fake', '--prompt', 'SLEEP 0', '--no-charter', '--json']);
    expect(bare.code).toBe(0);
    const id2 = (JSON.parse(bare.out) as { id: string }).id;
    expect(e.store.get(id2)).not.toHaveProperty('charter');
    expect(e.store.get(id2)?.promptChars).toBe('SLEEP 0'.length);
    expect((await run(['run', 'fake', '--prompt', 'x', '--pack'])).code).toBe(1);
  });
});

describe('augur run attachments', () => {
  it('keeps every --attach, in order, and reads --urgent as a switch', () => {
    const p = parse(['run', 'r', '--attach', 'a.txt', '--attach=b.png', '--urgent', '--prompt', 'x']);
    expect(p.repeated.get('attach')).toEqual(['a.txt', 'b.png']);
    expect(p.flags.get('urgent')).toBe(true);
  });
  it('sends the files to the service, which refuses them on a route that takes none', async () => {
    const { e, run } = await boot();
    writeFileSync(join(e.root, 'a.txt'), 'hello');
    const r = await run(['run', 'fake', '--prompt', 'SLEEP 0', '--attach', join(e.root, 'a.txt'), '--urgent']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('Rejected (attachment_rejected): Route fake takes no attachments.');
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

describe('named conversations', () => {
  it('opens one with --conversation, lists it and forgets it', async () => {
    const { e, run } = await boot();
    expect((await run(['conversations'])).out.trim()).toBe('No conversations.');
    const started = await run(['run', 'fake', '--prompt', 'SLEEP 0', '--conversation', 'feat', '--wait', '--json']);
    expect(started.code).toBe(0);
    const body = JSON.parse(started.out) as { job: { conversation?: string; turn?: number; state: string }; answer: string | null };
    expect(body.job).toMatchObject({ conversation: 'feat', turn: 1, state: 'completed' });
    const listed = await run(['conversations', '--json']);
    expect(listed.code).toBe(0);
    const rows = JSON.parse(listed.out) as Array<{ name: string; route: string; adapter: string; turns: number; lastUsedAt: number }>;
    expect(rows).toEqual([expect.objectContaining({ name: 'feat', route: 'fake', adapter: 'codex-exec', turns: 1 })]);
    const iso = new Date(rows[0]!.lastUsedAt).toISOString().slice(0, 19) + 'Z';
    expect((await run(['conversations'])).out.trim()).toBe(`feat  fake  codex-exec  1  ${iso}`);
    const gone = await run(['conversations', '--forget', 'feat']);
    expect(gone.code).toBe(0);
    expect(gone.out.trim()).toBe('Forgot conversation feat.');
    expect((await run(['conversations'])).out.trim()).toBe('No conversations.');
    expect(e.store.conversations()).toEqual([]);
    const missing = await run(['conversations', '--forget', 'feat', '--json']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('No conversation named feat.');
    expect(JSON.parse(missing.out)).toEqual({ forgotten: false, reason: 'No conversation named feat.' });
    const bad = await run(['run', 'fake', '--prompt', 'SLEEP 0', '--conversation', 'bad name', '--json']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('bad_request');
    const raw = await run(['run', 'raw', '--prompt', 'SLEEP 0', '--conversation', 'feat', '--json']);
    expect(raw.code).toBe(2);
    expect(raw.err).toContain('does not keep a conversation');
  });
});
