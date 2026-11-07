import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startService } from '@augur/augurd';
import { call } from '../../augurd/src/client.js';
import { JOBHOST, ROUTES, makeEnv } from '../../augurd/test/harness.js';
import type { Env } from '../../augurd/test/harness.js';
import { JOBS_ACTIVITY_TEXT, REPLAY_TEXT, main, parse } from '../src/cli.js';
import { readFleet } from '@augur/core';

vi.setConfig({ testTimeout: 90000 });
const cleanup: Array<() => Promise<void> | void> = [];
const AMBIENT = ['AUGUR_SESSION', 'AUGUR_SESSION_TITLE', 'AUGUR_ORIGIN', 'AUGUR_SUMMARY', 'CLAUDE_CODE_SESSION_ID', 'AUGUR_IN_JOB', 'AUGUR_CALLER', 'AUGUR_JOB_ID', 'AUGUR_ROOT_JOB_ID'];
/** The process environment without the markers a calling session sets, so a test never inherits the stamp or job identity of whoever runs it. */
const quietEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([key]) => !AMBIENT.includes(key)));
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

describe('augur alias init', () => {
  it('prints suggested patterns and writes nothing', async () => {
    const e = makeEnv();
    const path = join(e.home, 'policy.json');
    writeFileSync(path, JSON.stringify({ providers: { openrouter: { models: { 'openrouter/vendor-v2': { id: 'vendor/model-v2' } } } } }));
    const before = readdirSync(e.home).sort();
    let out = '';
    const code = await main(['alias', 'init'], { out: text => { out += text; }, err: () => {}, stdin: () => '', env: { ...process.env, AUGUR_HOME: e.home }, cwd: e.root });
    expect(code).toBe(0); expect(out).toContain('vendor/model-v*');
    expect(readdirSync(e.home).sort()).toEqual(before);
    e.dispose();
  });

  it('requires --untested on the CLI before accepting an untested offer', async () => {
    const e = makeEnv();
    writeFileSync(join(e.home, 'policy.json'), JSON.stringify({ schema: 1, updatedAt: new Date().toISOString(), weights: {}, dataTiers: [], activities: [], unreviewed: [], providers: { openrouter: { name: 'OpenRouter', metered: false, thresholds: {}, models: { label: { provider: 'openrouter', id: 'vendor/model-1', name: 'Model One', status: 'confirmed', source: 'manual', dataTier: 'public', askFirst: false, output: 'text_only', sandbox: false, effort: null, cost: 'moderate', pause: null, activities: {}, dataHandling: {}, useAfter: [], notes: '', inherited: [] } } } } }));
    const offer = { id: 'offer-1', label: 'label', from: 'vendor/model-1', to: 'vendor/model-2', createdAt: new Date().toISOString(), status: 'pending', tested: false, notes: ['not smoke-tested: paused'] };
    writeFileSync(join(e.home, 'alias-inbox.jsonl'), JSON.stringify(offer) + '\n');
    mkdirSync(join(e.home, 'dispatch'), { recursive: true });
    writeFileSync(join(e.home, 'dispatch', 'routes.json'), JSON.stringify({ routes: { chat: { model: 'label', adapter: 'openai-api', options: { model: 'vendor/model-1' } }, manual: { model: 'label', adapter: 'openai-api', options: { model: 'manual/model' } } } }));
    let out = '';
    const io = { out: (text: string) => { out += text; }, err: () => {}, stdin: () => '', env: { ...process.env, AUGUR_HOME: e.home, AUGURD_DATA: e.dir }, cwd: e.root };
    expect(await main(['alias', 'accept', 'offer-1'], io)).toBe(4);
    expect(await main(['alias', 'accept', 'offer-1', '--untested'], io)).toBe(0);
    expect(readFileSync(join(e.home, 'policy.json'), 'utf8')).toContain('vendor/model-1');
    expect(readFileSync(join(e.home, 'policy-edits.jsonl'), 'utf8')).toContain('"value":"vendor/model-2"');
    expect(JSON.parse(readFileSync(join(e.home, 'dispatch', 'routes.json'), 'utf8'))).toMatchObject({ routes: { chat: { options: { model: 'vendor/model-2' } }, manual: { options: { model: 'manual/model' } } } });
    expect(out).toContain('route manual still names manual/model; change it yourself');
    expect(readFileSync(join(e.dir, 'decisions.jsonl'), 'utf8')).toContain('"kind":"alias_swap"');
    e.dispose();
  });

  it('uses AUGUR_HOME for roles list, set and remove', async () => {
    const e = makeEnv();
    writeFileSync(join(e.home, 'policy.json'), JSON.stringify({ providers: {}, roles: { local: { activity: 'research', candidates: [], callerChooses: false } } }));
    const io = { out: () => {}, err: () => {}, stdin: () => '', env: { ...process.env, AUGUR_HOME: e.home }, cwd: e.root };
    expect(await main(['roles'], io)).toBe(0);
    expect(await main(['roles', 'set', 'new', '--activity', 'research', '--candidates', 'x/y'], io)).toBe(0);
    expect(await main(['roles', 'remove', 'local'], io)).toBe(0);
    const edits = readFileSync(join(e.home, 'policy-edits.jsonl'), 'utf8');
    expect(edits).toContain('"model":"new"');
    expect(edits).toContain('"model":"local"');
    e.dispose();
  });
});

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
    const code = await main(withUsual(args), { out: t => { out += t; }, err: t => { err += t; }, stdin: () => stdin, env: { ...quietEnv(), AUGURD_DATA: e.dir, AUGURD_PIPE: pipe, ...env }, cwd: e.root });
    return { code, out, err };
  };
  return { e, run, pipe };
}

describe('run attribution', () => {
  it('takes stamp flags over the four environment fallbacks and stores no other environment field', async () => {
    const { e, run } = await boot({ maxConcurrent: 1 });
    const result = await run(['run', 'fake', '--prompt', 'hi', '--session', 'flag-session', '--session-title', 'Flag title', '--origin', 'claude-code', '--summary', 'Read notes', '--json'], '', { AUGUR_SESSION: 'env-session', AUGUR_SESSION_TITLE: 'Env title', AUGUR_ORIGIN: 'other', AUGUR_SUMMARY: 'Env summary', PRIVATE_STAMP_TEST: 'private-sentinel' });
    expect(result.code).toBe(0);
    const id = JSON.parse(result.out).id;
    expect(e.store.get(id)?.ledger).toMatchObject({ stamp: { sessionId: 'flag-session', sessionTitle: 'Flag title', origin: 'claude-code' }, summary: 'Read notes', summarySource: 'caller' });
    expect(JSON.stringify(e.store.get(id)?.ledger)).not.toContain('private-sentinel');
    const envOnly = await run(['run', 'fake', '--prompt', 'hi', '--json'], '', { AUGUR_SESSION: 'env-session', AUGUR_SESSION_TITLE: 'Env title', AUGUR_ORIGIN: 'service', AUGUR_SUMMARY: 'Read notes' });
    expect(envOnly.code).toBe(0);
    expect(e.store.get(JSON.parse(envOnly.out).id)?.ledger?.stamp).toMatchObject({ sessionId: 'env-session', sessionTitle: 'Env title', origin: 'service' });
  });
  it('rejects a multiline summary or unknown origin without submitting', async () => {
    const { e, run } = await boot();
    for (const flags of [['--summary', 'two\nlines'], ['--origin', 'invalid']]) expect((await run(['run', 'fake', '--prompt', 'hi', ...flags])).code).toBe(1);
    expect(e.store.list()).toEqual([]);
  });
});

describe('run effort and schema', () => {
  it('parses both options', () => {
    const parsed = parse(['run', 'fake', '--effort', 'xhigh', '--schema', 'answer.json']);
    expect(parsed.flags.get('effort')).toBe('xhigh');
    expect(parsed.flags.get('schema')).toBe('answer.json');
  });

  it('rejects invalid effort before submitting', async () => {
    const { run } = await boot();
    for (const effort of ['', 'x'.repeat(17), 'high;exit', 'high_low']) {
      const result = await run(['run', 'fake', '--prompt', 'hi', '--effort', effort]);
      expect(result.code).toBe(1); expect(result.err).toContain('Invalid effort level. Use 1 to 16');
    }
  });

  it('rejects unreadable, oversized, invalid and non-object schema files', async () => {
    const { e, run } = await boot(), file = join(e.root, 'schema.json');
    expect((await run(['run', 'fake', '--prompt', 'hi', '--schema', 'missing.json'])).code).toBe(1);
    for (const text of ['{', '[]', 'null', '1', JSON.stringify({ description: 'x'.repeat(65536) }), '{}'.padEnd(65537, ' ')]) {
      writeFileSync(file, text);
      const result = await run(['run', 'fake', '--prompt', 'hi', '--schema', 'schema.json']);
      expect(result.code).toBe(1); expect(result.err).toContain('schema');
    }
  });

  it('reads the schema relative to the caller and sends it with the effort override', async () => {
    const { e, run } = await boot({ persistPrompts: true });
    const schema = { type: 'object', required: ['ok'] };
    writeFileSync(join(e.root, 'schema.json'), JSON.stringify(schema));
    const before = readFileSync(e.routesPath, 'utf8');
    const result = await run(['run', 'fake', '--prompt', 'hi', '--schema', 'schema.json', '--effort', 'high', '--wait', '--json']);
    expect(result.code).toBe(0);
    const record = JSON.parse(result.out), plan = JSON.parse(readFileSync(join(e.dir, 'jobs', record.job.id, 'job.json'), 'utf8'));
    expect(plan.args).toContain('model_reasoning_effort=high');
    expect(plan.files).toContainEqual({ name: 'output-schema.json', content: JSON.stringify(schema) });
    expect(readFileSync(e.routesPath, 'utf8')).toBe(before);
  });
});

describe('replay and prompt storage', () => {
  it('parses keep-prompt as a boolean and lists both commands in help', async () => {
    expect(parse(['run', 'fake', '--keep-prompt']).flags.get('keep-prompt')).toBe(true);
    const { run } = await boot();
    const help = await run(['run', '--help']);
    expect(help.out).toContain(REPLAY_TEXT.keepPromptHelp);
    expect(help.out).toContain(REPLAY_TEXT.help);
  });

  it('keeps a prompt with the setting off and replays it with a visible link', async () => {
    const { e, run } = await boot({ persistPrompts: false });
    const prompt = 'ENV CODEX_HOME\nSLEEP 0';
    const first = await run(['run', 'fake', '--prompt', prompt, '--keep-prompt', '--wait', '--json']);
    expect(first.code).toBe(0);
    const original = JSON.parse(first.out).job.id;
    expect(readFileSync(join(e.dir, 'jobs', original, 'prompt.txt'), 'utf8')).toBe(prompt);
    const replay = await run(['replay', original, 'raw', '--json']);
    expect(replay.code).toBe(0);
    const id = JSON.parse(replay.out).id;
    expect(id).not.toBe(original);
    expect((await run(['wait', id])).code).toBe(0);
    const job = await run(['job', id, '--json']);
    expect(JSON.parse(job.out)).toMatchObject({ job: { replayOf: `${e.store.ledger.node}:${original}`, route: 'raw' } });
    expect((await run(['job', id])).out).toContain(REPLAY_TEXT.link(`${e.store.ledger.node}:${original}`));
    expect((await run(['jobs'])).out).toContain(REPLAY_TEXT.link(`${e.store.ledger.node}:${original}`));
    const human = await run(['replay', original, 'raw']);
    expect(human.code).toBe(0);
    expect(human.out.trim()).toMatch(/^[a-f0-9]{12}$/);
    expect((await run(['wait', human.out.trim()])).code).toBe(0);
  });

  it('prints coded refusals in JSON and text and rejects missing arguments', async () => {
    const { run } = await boot();
    const refusal = await run(['replay', 'missing', 'raw', '--json']);
    expect(refusal.code).toBe(2);
    expect(JSON.parse(refusal.out)).toMatchObject({ rejected: { code: 'unknown_job' } });
    expect(refusal.err).toContain('Replay refused (unknown_job)');
    const usage = await run(['replay', 'missing']);
    expect(usage.code).toBe(1);
    expect(usage.err).toContain(REPLAY_TEXT.usage);
  });
});

describe('augur models', () => {
  it('prints live uses, role chains, and offers as text and JSON without editing rules', async () => {
    const { e, pipe } = await boot();
    const fleet = readFleet({ self: { name: 'eru', ledger: { models: [{ id: 'laya', uses: ['live tagging'] }] }, roles: [{ name: 'judge', chain: ['laya'] }] } });
    const policyPath = join(e.home, 'policy.json'), before = readFileSync(policyPath, 'utf8');
    writeFileSync(join(e.home, 'usage.json'), JSON.stringify({ providers: { cogitator: { fetchedAt: '2026-10-29T12:00:00Z', stale: true, notes: { fleet } } } }));
    let out = '';
    const io = { out: (text: string) => { out += text; }, err: () => {}, stdin: () => '', env: { ...process.env, AUGUR_HOME: e.home, AUGURD_DATA: e.dir, AUGURD_PIPE: pipe }, cwd: e.root };
    expect(await main(['models'], io)).toBe(0);
    expect(out).toContain('live tagging'); expect(out).toContain('chain: laya'); expect(out).toContain('(stale)');
    expect(out).toContain('augur models accept judge');
    out = '';
    expect(await main(['models', '--json'], io)).toBe(0);
    const data = JSON.parse(out);
    expect(data.cogitator.map((entry: { id: string }) => entry.id)).toEqual(['laya', 'judge']);
    expect(data.offers.map((entry: { id: string }) => entry.id)).toEqual(['laya', 'judge']);
    expect(readFileSync(policyPath, 'utf8')).toBe(before);
  });

  it('refuses acceptance from inside a job before calling the service', async () => {
    let err = '';
    const code = await main(['models', 'accept', 'laya'], { out: () => {}, err: text => { err += text; }, stdin: () => '', env: { AUGUR_IN_JOB: '1' }, cwd: process.cwd() });
    expect(code).toBe(2); expect(err).toContain('Only the owner');
  });
});

describe('augur run', () => {
  it('rejects a released flag from the command line', async () => {
    const { run } = await boot();
    const trailing = await run(['run', 'fake', '--prompt', 'hi', '--released']);
    expect(trailing.code).toBe(1);
    expect(trailing.err).toContain('only by the service runner');
    const valued = await run(['run', 'fake', '--prompt', 'hi', '--released', 'true']);
    expect(valued.code).toBe(1);
    expect(valued.err).toContain('only by the service runner');
  });
  it('records the caller selected by --caller and AUGUR_CALLER', async () => {
    const { run } = await boot();
    const started = await run(['run', 'fake', '--prompt', 'SLEEP 0', '--caller', 'automated', '--json']);
    const id = (JSON.parse(started.out) as { id: string }).id;
    const status = await run(['status', id, '--json']);
    expect(JSON.parse(status.out)).toMatchObject({ caller: { intent: 'automated' } });
    const fromEnv = await run(['run', 'fake', '--prompt', 'SLEEP 0', '--json'], '', { AUGUR_CALLER: 'automated' });
    const envId = (JSON.parse(fromEnv.out) as { id: string }).id;
    expect((await run(['status', envId, '--json'])).out).toContain('"intent":"automated"');
  });
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

  it('blocks an automated premium run from the CLI', async () => {
    const { run, e } = await boot(), path = join(e.home, 'policy.json'), policy = JSON.parse(readFileSync(path, 'utf8'));
    policy.balance = { gate: { premium: ['test/fake'], paceLift: ['test/fake'], open: 20, close: 10 } };
    writeFileSync(path, JSON.stringify(policy));
    const result = await run(['run', 'fake', '--prompt', 'x', '--caller', 'automated']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('Premium models are not used for automated tasks');
  });

  it('best effort: a run inside a job stays automated whatever --caller says, and cannot waive the pick', async () => {
    const { run, e } = await boot(), path = join(e.home, 'policy.json'), policy = JSON.parse(readFileSync(path, 'utf8'));
    policy.balance = { gate: { premium: ['test/fake'], paceLift: ['test/fake'], open: 20, close: 10 } };
    writeFileSync(path, JSON.stringify(policy));
    for (const env of [{ AUGUR_IN_JOB: '1' }, { AUGUR_CALLER: 'automated' }]) {
      const result = await run(['run', 'fake', '--prompt', 'x', '--caller', 'interactive'], '', env);
      expect(result.code).toBe(2);
      expect(result.err).toContain('Premium models are not used for automated tasks');
      const waived = await run(['run', 'fake', '--prompt', 'x', '--allow', 'unpicked'], '', env);
      expect(waived.code).toBe(1);
      expect(waived.err).toContain('--allow unpicked is for the owner');
    }
    expect((await run(['run', 'fake', '--prompt', 'x', '--caller', 'automated'])).err).toContain('Premium models are not used for automated tasks');
  });

  it('uses the job identity in its environment as the parent of the jobs it starts', async () => {
    const { run, e } = await boot();
    const boss = await run(['run', 'boss', '--prompt', 'HANG', '--json']);
    const bossId = (JSON.parse(boss.out) as { id: string }).id;
    const child = await run(['run', 'boss', '--prompt', 'HANG', '--json'], '', { AUGUR_JOB_ID: bossId, AUGUR_ROOT_JOB_ID: bossId });
    expect(child.code).toBe(0);
    const childId = (JSON.parse(child.out) as { id: string }).id;
    const jobs = await run(['jobs', '--root', bossId, '--json']);
    expect(JSON.parse(jobs.out).jobs.find((j: { localId: string }) => j.localId === childId)?.parentId).toBe(`${e.store.ledger.node}:${bossId}`);
    const plainParent = (JSON.parse((await run(['run', 'fake', '--prompt', 'HANG', '--json'])).out) as { id: string }).id;
    const denied = await run(['run', 'fake', '--prompt', 'x', '--json'], '', { AUGUR_JOB_ID: plainParent });
    expect(denied.code).toBe(2);
    expect(denied.err).toContain('delegation_not_granted');
    await run(['cancel', plainParent]);
    await run(['cancel', bossId]); await run(['cancel', childId]);
    expect(e.store.get(bossId)).toBeTruthy();
  });
});

describe('augur backlog', () => {
  it('documents backlog prompt and deadline flags and the pick caller option', async () => {
    const { run } = await boot();
    const help = await run(['--help']);
    expect(help.out).toContain('--prompt-file <file>');
    expect(help.out).toContain('--deadline <date>');
    expect(help.out).toContain('pick-preview');
    expect(help.out).toContain('--caller <kind>');
    expect(help.out).not.toContain('--lower <label>');
  });
  it('adds, lists, reports and drops a validated item', async () => {
    const { run, e } = await boot();
    writeFileSync(join(e.root, 'prompt.md'), 'Do the task.');
    const added = await run(['backlog', 'add', '--requester', 'owner', '--repo', '.', '--task', 'small task', '--prompt-file', 'prompt.md', '--activity', 'write_code', '--data', 'internal', '--route', 'fake', '--cwd', e.root, '--tools', 'write', '--output', 'patch_only', '--json']);
    expect(added.code).toBe(0);
    const id = (JSON.parse(added.out) as { id: string }).id;
    const human = await run(['backlog', 'list', '--status', 'queued']);
    expect(human.out).toContain(id);
    expect(human.out).toContain(`prompt=file ${join(e.root, 'prompt.md')}`);
    expect(human.out).toContain('data=internal tools=write output=patch_only');
    expect(human.out).toContain(`cwd=${e.root}`);
    expect((await run(['backlog', 'status', '--json'])).out).toContain('queued');
    expect((await run(['backlog', 'drop', id, '--json'])).code).toBe(0);
    expect((await run(['backlog', 'list'])).out).toContain('No backlog items.');
  });
  it('best-effort protects backlog add inside jobs by awaiting owner approval', async () => {
    const { run } = await boot();
    const args = ['backlog', 'add', '--requester', 'agent', '--repo', '.', '--task', 'agent work', '--prompt', 'Do work.', '--activity', 'write_code', '--data', 'internal', '--route', 'fake', '--cwd', '.', '--tools', 'write', '--output', 'patch_only', '--json'];
    for (const env of [{ AUGUR_JOB_ID: 'job-id' }, { AUGUR_CALLER: 'automated' }, { AUGUR_IN_JOB: '1' }]) {
      const added = await run(args, '', env);
      expect(added.code).toBe(0);
      expect(added.out).toContain('agent');
      const row = JSON.parse(added.out) as { author: string; status: string };
      expect(row).toMatchObject({ author: 'agent', status: 'awaiting-approval' });
    }
    const fromOwner = await run(args);
    expect(fromOwner.code).toBe(0);
    expect(JSON.parse(fromOwner.out)).toMatchObject({ author: 'owner', status: 'queued' });
  });
  it('refuses backlog approve, run and drop from inside a job (best effort: the environment is the caller own to clear)', async () => {
    const { run } = await boot();
    for (const env of [{ AUGUR_IN_JOB: '1' }, { AUGUR_JOB_ID: 'job-id' }, { AUGUR_CALLER: 'automated' }]) {
      for (const args of [['backlog', 'approve', 'x', '--yes'], ['backlog', 'run'], ['backlog', 'drop', 'x']]) {
        const r = await run(args, '', env);
        expect(r.code).not.toBe(0);
        expect(r.err).toContain('not for a job');
      }
    }
  });
  it('approves an agent item from the owner CLI', async () => {
    const { run, e, pipe } = await boot();
    const result = await call('backlog_add', { item: { requester: 'agent', repo: '.', task: 'agent work', prompt: { text: 'Do work.' }, activity: 'write_code', data: 'internal', route: 'fake', lower: 'fake', cwd: e.root, tools: 'write', output: 'patch_only' } }, { dir: e.dir, pipe, role: 'agent' });
    const id = (result as { id: string }).id;
    const before = await call('backlog_list', undefined, { dir: e.dir, pipe });
    expect(before).toContainEqual(expect.objectContaining({ id, author: 'agent', status: 'awaiting-approval' }));
    const approved = await run(['backlog', 'approve', id]);
    expect(approved.code).toBe(0);
    expect(approved.out).toContain('awaiting-approval');
    expect(approved.out).toContain('Run again with --yes to approve.');
    expect(approved.out).toContain('activity=write_code requester=agent repo=.');
    expect(approved.out).toContain('Prompt text: Do work.');
    expect(approved.out).toContain('data=internal tools=write output=patch_only');
    expect(await call('backlog_list', undefined, { dir: e.dir, pipe })).toContainEqual(expect.objectContaining({ id, author: 'agent', status: 'awaiting-approval' }));
    const confirmed = await run(['backlog', 'approve', id, '--yes']);
    expect(confirmed.out).toContain('queued');
    expect(await call('backlog_list', undefined, { dir: e.dir, pipe })).toContainEqual(expect.objectContaining({ id, author: 'agent', status: 'queued' }));
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

describe('grade flags', () => {
  it('takes --report with no value, and keeps a rubric name that follows it as an argument', () => {
    const p = parse(['grade', '--report', 'answer']);
    expect(p.cmd).toEqual(['grade', 'answer']);
    expect(p.flags.get('report')).toBe(true);
    expect(parse(['grade', '--report']).flags.get('report')).toBe(true);
  });
});


describe('job activity output', () => {
  it('formats activity ages in seconds, minutes, hours and days', () => {
    for (const [ms, text] of [[-1000, '0s ago'], [12000, '12s ago'], [240000, '4m ago'], [3600000, '1h ago'], [86400000, '1d ago']] as const) {
      expect(JOBS_ACTIVITY_TEXT.age(100000000 - ms, 100000000)).toBe(text);
    }
    expect(parse(['jobs', '--running', '--json']).flags.get('running')).toBe(true);
  });

  it('lists only live jobs before limiting and shows activity in status and JSON', async () => {
    const { e, run } = await boot({ maxConcurrent: 1, stallMinutes: 1 });
    const start = Date.now() - 120000;
    const insert = (id: string, state: 'running' | 'completed' | 'queued' | 'needs_approval' | 'cancel_requested', at: number) => {
      e.store.insert({ id, route: 'raw', adapter: 'exec', activity: 'write_code', dataTier: 'internal', tools: 'read', output: 'text_only', cwd: e.root,
        createdAt: at, rootJobId: id, parentJobId: null, depth: 0, caller: { kind: 'cli' }, named: false, expectFile: null, timeoutS: null, harnessVersion: null, workspace: null });
      if (state === 'needs_approval') e.store.transition(id, state, {}, at);
      else if (state !== 'queued') { e.store.transition(id, 'running', { startedAt: at }, at); if (state !== 'running') e.store.transition(id, state, {}, at); }
    };
    insert('live', 'running', start);
    const dir = join(e.dir, 'jobs', 'live'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'heartbeat'), '');
    writeFileSync(join(dir, 'stdout.log'), 'Reading files\n');
    const fs = await import('node:fs'); fs.utimesSync(join(dir, 'stdout.log'), start / 1000, start / 1000);
    insert('done', 'completed', start + 1);
    const list = await run(['jobs', '--running', '--limit', '1']);
    expect(list.code).toBe(0); expect(list.out).toContain('live'); expect(list.out).not.toContain(':done');
    expect((await run(['jobs', '--state', 'running'])).out).toContain('STALLED');
    expect(list.out).toContain('STALLED'); expect(list.out).toContain('2m'); expect(list.out).toContain('Output activity'); expect(list.out).not.toContain('Reading files');
    const status = await run(['status', 'live']); expect(status.out).toContain('STALLED'); expect(status.out).toContain('Reading files');
    const json = JSON.parse((await run(['jobs', '--running', '--json'])).out);
    expect(json.jobs).toMatchObject([{ localId: 'live', lastActivityAt: start, activityLine: 'Output activity', state: 'stalled' }]);
    expect(JSON.parse((await run(['status', 'done', '--json'])).out)).not.toHaveProperty('stalled');
    expect(JSON.parse((await run(['jobs', '--running', '--state', 'completed', '--json'])).out).jobs).toEqual([]);
    for (const state of ['queued', 'needs_approval', 'cancel_requested'] as const) insert(state, state, start + 2);
    const live = JSON.parse((await run(['jobs', '--running', '--json'])).out);
    expect(live.jobs.map((j: { localId: string }) => j.localId).sort()).toEqual(['cancel_requested', 'live', 'needs_approval', 'queued']);
  });
});


describe('ledger commands', () => {
  async function ledgerBoot() {
    const { e, run } = await boot();
    const now = Date.now(), node = e.store.ledger.node;
    for (const [id, session, at] of [['one', 's1', now - 10800000], ['two', 's2', now - 7200000]] as const) {
      e.store.insert({ id, route: 'raw', adapter: 'exec', activity: 'research', dataTier: 'public', tools: 'read', output: 'text_only', cwd: e.root, createdAt: at, rootJobId: 'one', parentJobId: id === 'two' ? 'one' : null, depth: id === 'two' ? 1 : 0, caller: { kind: 'cli' }, named: false, expectFile: null, timeoutS: null, harnessVersion: null, workspace: null });
      e.store.transition(id, 'running', { startedAt: at + 1 }, at + 1);
      e.store.transition(id, id === 'one' ? 'completed' : 'failed', { endedAt: at + 1000 }, at + 1000);
      e.store.ledger.setLocalMetadata(id, { stamp: { sessionId: session, sessionTitle: 'Review', origin: 'cli' }, attribution: { session: 'stamped', origin: 'stamped', process: 'unknown', host: 'unknown' }, summary: `Read notes ${id}`, summarySource: 'caller', model: 'test/raw', compacted: false });
    }
    const remote = { id: 'eru:remote', node: 'eru', localId: 'remote', kind: 'download', state: 'running', stamp: { sessionId: 's1', origin: 'service' }, attribution: { session: 'stamped', origin: 'stamped', process: 'unknown', host: 'unknown' }, summary: 'Download files', summarySource: 'caller', route: null, model: 'asset', activity: 'download', createdAt: now - 3600000, startedAt: now - 3600000, endedAt: null, durationMs: null, updatedAt: now - 3600000, lastActivityAt: now - 3600000, parentId: null, retryOf: null, retriedAs: null, usage: null, exitReason: null, compacted: false };
    e.store.ledger.ingest('eru', { version: 1, node: 'eru', events: [{ seq: '1', at: now, job: remote }], next: '1', more: false });
    return { e, run, node };
  }

  it('applies session defaults, all sessions, explicit sessions, and every list filter', async () => {
    const { run, node } = await ledgerBoot();
    const ids = async (flags: string[] = [], env: NodeJS.ProcessEnv = {}) => {
      const r = await run(['jobs', ...flags, '--json'], '', env);
      expect(r.code).toBe(0); return JSON.parse(r.out).jobs.map((j: { localId: string }) => j.localId).sort();
    };
    expect(await ids()).toEqual(['one', 'remote', 'two']);
    expect(await ids([], { CLAUDE_CODE_SESSION_ID: 's1' })).toEqual(['one', 'remote']);
    expect(await ids([], { AUGUR_SESSION: 's2', CLAUDE_CODE_SESSION_ID: 's1' })).toEqual(['two']);
    expect(await ids(['--session', 's2'], { AUGUR_SESSION: 's1' })).toEqual(['two']);
    expect(await ids(['--all'], { AUGUR_SESSION: 's1' })).toEqual(['one', 'remote', 'two']);
    for (const [flags, expected] of [
      [['--origin', 'service'], ['remote']], [['--node', node], ['one', 'two']], [['--kind', 'download'], ['remote']],
      [['--state', 'done'], ['one']], [['--running'], ['remote']], [['--route', 'raw'], ['one', 'two']],
      [['--since', '90m'], ['remote']], [['--until', '90m'], ['one', 'two']], [['--text', 'notes two'], ['two']],
      [['--root', 'one'], ['one', 'two']], [['--state', 'completed'], ['one']], [['--state', 'failed'], ['two']],
    ] as Array<[string[], string[]]>) expect(await ids(flags)).toEqual(expected);
    for (const flags of [['--limit', '0'], ['--since', 'yesterday'], ['--kind', 'wrong'], ['--state', 'wrong'], ['--origin', 'wrong']]) expect((await run(['jobs', ...flags])).code).toBe(1);
  });

  it('pages relative time queries without duplicates and prints matching counts', async () => {
    const { run } = await ledgerBoot();
    const first = JSON.parse((await run(['jobs', '--since', '6h', '--limit', '1', '--json'])).out);
    expect(first.jobs).toHaveLength(1); expect(first.counts).toMatchObject({ done: 1, failed: 1, running: 1 });
    const second = JSON.parse((await run(['jobs', '--since', '6h', '--limit', '1', '--page', first.next, '--json'])).out);
    expect(second.jobs[0].id).not.toBe(first.jobs[0].id);
    expect((await run(['jobs', '--session', 'different', '--page', second.next])).code).not.toBe(0);
    expect(JSON.parse((await run(['jobs', 'counts', '--session', 's1', '--json'])).out)).toMatchObject({ done: 1, running: 1, failed: 0 });
    expect((await run(['jobs', '--limit', '1'])).out).toContain('Next page:');
  });

  it('reads full records and chains by either id without result text', async () => {
    const { run, node, e } = await ledgerBoot();
    e.store.linkRetry('one', 'two');
    const bare = JSON.parse((await run(['job', 'one', '--json'])).out);
    const qualified = JSON.parse((await run(['job', `${node}:one`, '--json'])).out);
    expect(qualified).toEqual(bare);
    expect(bare).toMatchObject({ job: { id: `${node}:one`, summary: 'Read notes one', summarySource: 'caller', attribution: { session: 'stamped' } }, parent: null, children: [{ localId: 'two' }], retries: [{ localId: 'two' }] });
    expect(bare).not.toHaveProperty('answer'); expect(bare.history.length).toBeGreaterThan(0);
    expect(bare.history.every((h: object) => !('detail' in h))).toBe(true);
    expect((await run(['job', 'missing'])).code).toBe(1);
    for (const command of ['wait', 'result', 'cancel', 'logs']) {
      const r = await run([command, 'eru:remote']);
      expect(r.code).toBe(1); expect(r.err).toContain('not a local execution job');
    }
    expect((await run(['result', `${node}:one`])).code).toBe(4);
  });

  it('lists node health, refreshes the ledger, and filters persisted alert events', async () => {
    const { run, e } = await ledgerBoot();
    e.store.ledger.unreachable('eru'); e.store.ledger.checkAlerts();
    expect((await run(['nodes'])).out).toContain('unreachable since');
    expect(JSON.parse((await run(['nodes', '--json'])).out)[0]).toMatchObject({ node: 'eru', cursor: '1' });
    const gap = { at: Date.now(), from: '1', to: '10', retentionDays: 7 };
    e.store.ledger.recoverGap('eru', gap);
    expect((await run(['nodes'])).out).toContain('History gap since ');
    expect(JSON.parse((await run(['nodes', '--json'])).out)[0]).toMatchObject({ node: 'eru', cursor: '10', gap, unreachableSince: null });
    expect((await run(['jobs', '--refresh'])).code).toBe(0);
    const alerts = JSON.parse((await run(['alerts', '--since', '6h', '--json'])).out);
    expect(alerts).toEqual([expect.objectContaining({ type: 'job.failed', summary: 'Read notes two' })]);
    expect(JSON.parse((await run(['alerts', '--since', '2999-01-01', '--json'])).out)).toEqual([]);
  });

  it('stamps route tests and replays with the calling session', async () => {
    const { run, e } = await boot({ persistPrompts: true });
    const test = await run(['test', 'fake', '--session', 'test-session', '--json']);
    expect(test.code).toBe(0);
    expect(e.store.get(JSON.parse(test.out).id)?.ledger?.stamp).toMatchObject({ sessionId: 'test-session', origin: 'cli' });
    await run(['wait', JSON.parse(test.out).id]);
    const replay = await run(['replay', JSON.parse(test.out).id, 'raw', '--session', 'replay-session', '--json']);
    expect(replay.code).toBe(0);
    expect(e.store.get(JSON.parse(replay.out).id)?.ledger?.stamp).toMatchObject({ sessionId: 'replay-session', origin: 'cli' });
    await run(['wait', JSON.parse(replay.out).id]);
  });
});
