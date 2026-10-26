import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JOBHOST, killEverything, makeEnv, processesWith, request, sleep, submitOk, terminal, until } from './harness.js';
import type { Env } from './harness.js';
import { REJECTION_CATEGORIES, systemdScopes } from '../src/supervisor.js';
import { REJECTION_CODES } from '@augur/dispatch-protocol';

vi.setConfig({ testTimeout: 90000 });
const envs: Env[] = [];
const setup = (...a: Parameters<typeof makeEnv>) => { const e = makeEnv(...a); envs.push(e); return e; };
afterEach(() => { while (envs.length) envs.pop()!.dispose(); });
const kinds = (e: Env, id: string) => e.store.events(id).map(x => x.kind);

it('classifies every rejection code as exactly one backlog result category', () => {
  for (const code of REJECTION_CODES) expect(Number(REJECTION_CATEGORIES.transient.includes(code as never)) + Number(REJECTION_CATEGORIES.permanent.includes(code as never))).toBe(1);
});

describe('a job that finishes', () => {
  it('submits prose with the attested caller, promoted tier, read tools, and a disposable scratch cwd', async () => {
    const e = setup({ proseRoute: 'fake', persistPrompts: true });
    const submit = vi.spyOn(e.sup, 'submit').mockImplementation(request => { expect(readdirSync(request.cwd)).toEqual([]); return { rejected: { code: 'not_picked', reason: 'test refusal' } }; });
    const run = (e.sup as unknown as { runProseGroup(items: unknown[], prompt: string, caller: { kind: 'cli'; label: string; interactive: boolean }): Promise<unknown> }).runProseGroup;
    await expect(run.call(e.sup, [{ dataTier: 'internal' }], 'student records', { kind: 'cli', label: 'augur', interactive: true })).rejects.toThrow('test refusal');
    const request = submit.mock.calls[0]?.[0];
    expect(request).toMatchObject({ tools: 'read', output: 'text_only', dataTier: 'regulated', persistPrompt: false, caller: { kind: 'cli', label: 'augur', interactive: true } });
    expect(request?.named).toBeUndefined();
    expect(request?.cwd).toBeTruthy();
    expect(existsSync(request!.cwd)).toBe(false);
  });

  it('starts a due service batch only when proseAutoRun is enabled', async () => {
    const off = setup({ proseBatchSize: 1, proseAutoRun: false });
    off.sup.proseAdd({ requester: 'owner', repo: 'repo', target: 'new', kind: 'write', surface: 'doc', audience: 'readers', voice: 'plain' });
    off.sup.tick();
    expect(off.sup.proseList()[0]?.status).toBe('queued');
    const on = setup({ proseBatchSize: 1, proseAutoRun: true, proseRoute: 'fake' });
    const submit = vi.spyOn(on.sup, 'submit').mockReturnValue({ rejected: { code: 'not_picked', reason: 'test refusal' } });
    on.sup.proseAdd({ requester: 'owner', repo: 'repo', target: 'new', kind: 'write', surface: 'doc', audience: 'readers', voice: 'plain' });
    on.sup.tick();
    await sleep(20);
    expect(on.sup.proseList()[0]?.status).toBe('failed');
    expect(submit.mock.calls[0]?.[0]).toMatchObject({ caller: { kind: 'service', label: 'prose-queue' }, named: true });
  });

  it('completes, checks its expected file, and records usage, version and every event', async () => {
    const e = setup();
    const id = submitOk(e.sup, request({ text: 'WRITE out.txt\nSLEEP 1', expectFile: 'out.txt', cwd: e.root }));
    const job = await terminal(e.sup, e.store, id);
    expect(job).toMatchObject({ state: 'completed', exitCode: 0, route: 'fake', adapter: 'codex-exec' });
    expect(job.usage).toEqual({ inputTokens: 1200, outputTokens: 34, cachedReadTokens: 1000, reasoningTokens: 5, reasoningInOutput: true, source: 'reported' });
    expect(kinds(e, id)).toEqual(['requested', 'policy_evaluated', 'queued', 'running', 'process_created', 'first_update', 'process_exited', 'usage_recorded', 'artifact_validated', 'completed', 'finalized']);
    expect(e.sup.result(id)?.answer).toBe('final message');
  });

  it('is artifact_validation_failed when the expected file is missing, and failed on a non-zero exit', async () => {
    const e = setup();
    const a = submitOk(e.sup, request({ text: 'SLEEP 0', expectFile: 'never.txt', cwd: e.root }));
    const b = submitOk(e.sup, request({ text: 'EXIT 3', cwd: e.root }));
    expect(await terminal(e.sup, e.store, a)).toMatchObject({ state: 'artifact_validation_failed', reason: 'expected file never.txt is missing' });
    expect(await terminal(e.sup, e.store, b)).toMatchObject({ state: 'failed', exitCode: 3, reason: 'exit 3' });
  });

  it('kills a hung job at its timeout', async () => {
    const e = setup();
    const id = submitOk(e.sup, request({ text: 'HANG', timeoutS: 3, cwd: e.root }));
    expect(await terminal(e.sup, e.store, id)).toMatchObject({ state: 'killed', reason: 'timed out after 3s' });
  });

  it('reports the harness output through logs, page by page, without splitting a character', async () => {
    const e = setup();
    const id = submitOk(e.sup, request({ text: 'FLOOD 1', cwd: e.root }));
    await terminal(e.sup, e.store, id);
    const whole = readFileSync(join(e.dir, 'jobs', id, 'stdout.log'), 'utf8');
    let text = '', offset = 0, guard = 0;
    for (;;) { const page = e.sup.logs(id, 'stdout', offset, 9973)!; text += page.text; offset = page.next; if (page.done || ++guard > 500) break; }
    expect(text.length).toBe(whole.length);
    expect(text).toBe(whole);
    expect(text).toContain('h\u00e9llo \u4e16\u754c');
  });
});

describe('surplus window status text', () => {
  it('reports not-near, opens-in, open, and spent states from resolved settings', () => {
    const e = setup(), policyPath = join(e.home, 'policy.json'), usagePath = join(e.home, 'usage.json');
    const p = JSON.parse(readFileSync(policyPath, 'utf8'));
    p.balance = { gate: { premium: ['test/fake', 'codex/sol', 'copilot/gpt-6.1-sol'], paceLift: ['test/fake'], surplus: { hours: 12, open: 10, close: 5, margin: 5, countdown: ['test'] } } };
    writeFileSync(policyPath, JSON.stringify(p));
    const usage = (usedPct: number, hours: number) => {
      const now = Date.now();
      writeFileSync(usagePath, JSON.stringify({ providers: { test: { fetchedAt: new Date(now).toISOString(), meters: [{ id: 'weekly', windowKind: 'weekly', usedPct, windowSeconds: 604800, resetsAt: new Date(now + hours * 3600000).toISOString() }] } } }));
    };
    usage(91, 48);
    const rows = () => {
      const result = e.sup.gateStatus();
      return 'error' in result ? [] : result.providers;
    };
    expect(rows().find(row => row.provider === 'test')?.window).toBe('9 of 10 points unused');
    expect(e.sup.gateReport()).toMatchObject({ providers: [{ provider: 'test', window: '9 of 10 points unused' }] });
    usage(90, 24);
    expect(rows().find(row => row.provider === 'test')?.window).toBe('window opens in 12h');
    expect(rows().find(row => row.provider === 'codex')?.window).toBeNull();
    expect(rows().find(row => row.provider === 'copilot')?.window).toBeNull();
    usage(90, 12);
    expect(rows().find(row => row.provider === 'test')?.window).toBe('window open, closes at reset, 5 points budget');
    expect((e.sup.balance() as { surplus: Array<{ status: string }> }).surplus).toContainEqual({ provider: 'test', status: 'window open, closes at reset, 5 points budget' });
    expect((e.sup.gateReport() as { providers: Array<{ window: string }> }).providers).toContainEqual({ provider: 'test', window: 'window open, closes at reset, 5 points budget' });
    usage(95, 12);
    expect(rows().find(row => row.provider === 'test')?.window).toBe('window spent, closes at reset');
  });

  it('persists the configured window across ticks and a service restart, then closes and reopens at real resets', () => {
    vi.useFakeTimers();
    try {
      const start = new Date('2026-10-01T00:00:00Z'); vi.setSystemTime(start);
      const e = setup(), policyPath = join(e.home, 'policy.json'), usagePath = join(e.home, 'usage.json'), statePath = join(e.dir, 'gate-state.json');
      const p = JSON.parse(readFileSync(policyPath, 'utf8'));
      p.balance = { gate: { premium: ['test/fake'], paceLift: ['test/fake'], surplus: { hours: 6, open: 20, close: 10, margin: 5, countdown: ['test'] } } };
      writeFileSync(policyPath, JSON.stringify(p));
      const usage = (at: number, usedPct: number, stale = false) => writeFileSync(usagePath, JSON.stringify({ providers: { test: { fetchedAt: new Date(at).toISOString(), stale, meters: [{ id: 'weekly', windowKind: 'weekly', usedPct, windowSeconds: 604800, resetsAt: new Date(at + 6 * 3600000).toISOString() }] } } }));
      usage(start.getTime(), 80);
      expect((e.sup.balance() as { surplus: Array<{ status: string }> }).surplus).toContainEqual({ provider: 'test', status: 'window open, closes at reset, 15 points budget' });
      const opened = JSON.parse(readFileSync(statePath, 'utf8')).surplus.test;
      expect(opened).toMatchObject({ open: true, spent: 0, resetsAt: new Date(start.getTime() + 6 * 3600000).toISOString() });
      writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, 'utf8')), surplus: { test: { ...opened, spent: 40 } } }));
      usage(start.getTime(), 90);
      expect((e.sup.balance() as { surplus: Array<{ status: string }> }).surplus).toContainEqual({ provider: 'test', status: 'window spent, closes at reset' });
      const restarted = e.make();
      expect((restarted.balance() as { surplus: Array<{ status: string }> }).surplus).toContainEqual({ provider: 'test', status: 'window spent, closes at reset' });
      usage(start.getTime(), 91);
      restarted.balance();
      expect(JSON.parse(readFileSync(statePath, 'utf8')).surplus.test).toMatchObject({ open: false, spent: 40 });
      usage(start.getTime(), 90);
      restarted.balance();
      expect(JSON.parse(readFileSync(statePath, 'utf8')).surplus.test).toMatchObject({ open: false, spent: 40 });
      vi.setSystemTime(new Date(start.getTime() + 6 * 3600000 + 1000));
      usage(Date.now(), 96);
      restarted.balance();
      expect(JSON.parse(readFileSync(statePath, 'utf8')).surplus.test).toMatchObject({ open: false, spent: 40 });
      usage(Date.now(), 80);
      restarted.balance();
      expect(JSON.parse(readFileSync(statePath, 'utf8')).surplus.test).toMatchObject({ open: true, spent: 40 });
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      state.surplus.test = { open: true, spent: 40, resetsAt: new Date(start.getTime() + 6 * 3600000).toISOString() };
      writeFileSync(statePath, JSON.stringify(state));
      usage(Date.now(), 80);
      restarted.balance();
      expect(JSON.parse(readFileSync(statePath, 'utf8')).surplus.test).toMatchObject({ open: true, spent: 0, resetsAt: new Date(Date.now() + 6 * 3600000).toISOString() });
      restarted.backlogAdd({ requester: 'owner', repo: 'repo', task: 'stale release', prompt: { text: 'work' }, activity: 'write_code', data: 'internal', route: 'fake', cwd: e.root, tools: 'write', output: 'write_files', estimate: 1 });
      vi.setSystemTime(new Date(start.getTime() + 6 * 3600000 + 2000));
      usage(Date.now(), 80, true);
      restarted.balance();
      expect(restarted.releaseDue(Date.now(), true).candidates).toEqual([]);
      expect(JSON.parse(readFileSync(statePath, 'utf8')).surplus.test.stale).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

describe('cancel', () => {
  it('ends the whole process tree', async () => {
    const e = setup();
    const marker = `cancel-marker-${Date.now()}`;
    const id = submitOk(e.sup, request({ text: `GRANDCHILD ${marker}\nHANG`, cwd: e.root }));
    await until(e.sup, () => processesWith(marker) > 0);
    expect(e.sup.cancel(id)).toMatchObject({ ok: true });
    const job = await terminal(e.sup, e.store, id);
    expect(job.state).toBe('cancelled');
    await sleep(800);
    expect(processesWith(marker)).toBe(0);
    expect(kinds(e, id)).toContain('cancellation_requested');
    expect(kinds(e, id)).toContain('cancellation_acknowledged');
  });

  it('cancels a queued job before it launches, and refuses to cancel a finished one', async () => {
    const e = setup({ maxConcurrent: 1 });
    const first = submitOk(e.sup, request({ text: 'SLEEP 2', cwd: e.root }));
    const second = submitOk(e.sup, request({ text: 'SLEEP 0', cwd: e.root }));
    expect(e.store.get(second)!.state).toBe('queued');
    expect(e.sup.cancel(second)).toMatchObject({ ok: true, state: 'cancelled' });
    await terminal(e.sup, e.store, first);
    expect(e.sup.cancel(first)).toMatchObject({ ok: false, state: 'completed' });
  });
});

describe('what a job can see', () => {
  it('receives only its adapter allowlist, not the rest of the service environment', async () => {
    const e = setup({}, { ...process.env, AUGUR_TEST_SECRET: 'do-not-pass', CODEX_HOME: 'C:/codex-home' });
    const id = submitOk(e.sup, request({ text: 'ENV AUGUR_TEST_SECRET\nENV CODEX_HOME\nENV AUGUR_JOB_ID', cwd: e.root }));
    await terminal(e.sup, e.store, id);
    const out = e.sup.logs(id)!.text;
    expect(out).toContain('ENV AUGUR_TEST_SECRET=<unset>');
    expect(out).toContain('ENV CODEX_HOME=C:/codex-home');
    expect(out).toContain('ENV AUGUR_JOB_ID=<unset>');
    expect(out).not.toContain('do-not-pass');
  });

  it('keeps the prompt off disk while the job runs, unless prompts are kept', async () => {
    const secret = 'PROMPT-BODY-NOT-ON-DISK-7f3a';
    const e = setup();
    const id = submitOk(e.sup, request({ text: `# ${secret}\nSLEEP 3`, cwd: e.root }));
    await until(e.sup, () => e.store.get(id)!.state === 'running' && existsSync(join(e.dir, 'jobs', id, 'state.json')));
    const files = readdirSync(join(e.dir, 'jobs', id));
    expect(files).not.toContain('prompt.in');
    expect(files).not.toContain('prompt.txt');
    for (const f of files) expect(readFileSync(join(e.dir, 'jobs', id, f), 'utf8')).not.toContain(secret);
    await terminal(e.sup, e.store, id);

    const kept = setup({ persistPrompts: true });
    const id2 = submitOk(kept.sup, request({ text: `# ${secret}\nSLEEP 0`, cwd: kept.root }));
    await terminal(kept.sup, kept.store, id2);
    expect(readFileSync(join(kept.dir, 'jobs', id2, 'prompt.txt'), 'utf8')).toContain(secret);

    const prose = setup({ persistPrompts: true });
    const id3 = submitOk(prose.sup, request({ text: `# ${secret}\nSLEEP 0`, cwd: prose.root, persistPrompt: false }));
    await terminal(prose.sup, prose.store, id3);
    expect(readdirSync(join(prose.dir, 'jobs', id3))).not.toContain('prompt.in');
    expect(readdirSync(join(prose.dir, 'jobs', id3))).not.toContain('prompt.txt');
  });

  it('states the tool tier in the prompt for a harness that cannot be told', async () => {
    const e = setup({ persistPrompts: true });
    const id = submitOk(e.sup, request({ tools: 'read', text: 'SLEEP 0', cwd: e.root }));
    await terminal(e.sup, e.store, id);
    expect(e.sup.logs(id)!.text).toContain('TIER read');
    expect(readFileSync(join(e.dir, 'jobs', id, 'prompt.txt'), 'utf8')).toBe('SLEEP 0');
  });
});

describe('rules at submit', () => {
  const code = (e: Env, over: Parameters<typeof request>[0]) => { const r = e.sup.submit(request(over, e.root)); return 'rejected' in r ? r.rejected.code : 'accepted'; };
  it('rejects for each rule, and writes an event without the job', () => {
    const e = setup();
    expect(code(e, { route: 'nope' })).toBe('unknown_route');
    expect(code(e, { route: 'ghost' })).toBe('unknown_model');
    expect(code(e, { route: 'ask' })).toBe('ask_first');
    expect(code(e, { route: 'ask', named: true })).toBe('accepted');
    expect(code(e, { route: 'pub', dataTier: 'internal' })).toBe('data_tier_too_high');
    expect(code(e, { route: 'sandboxed' })).toBe('sandbox_required');
    expect(code(e, { route: 'text', activity: 'research' })).toBe('text_only');
    expect(code(e, { route: 'text', activity: 'research', tools: 'read', output: 'text_only' })).toBe('read_not_enforceable'); // codex-exec cannot hold a read tier itself
    expect(code(e, { activity: 'speech' })).toBe('activity_not_permitted');
    expect(code(e, { output: 'patch_only' })).toBe('isolation_required');
  });
  it('rejects a bad request: relative cwd, cwd in the data folder, an expected file outside cwd, an adapter that is off', () => {
    const e = setup({ adapters: ['codex-exec'] });
    expect(e.sup.submit({ ...request({}, e.root), cwd: 'relative/path' })).toMatchObject({ rejected: { code: 'bad_request' } });
    expect(e.sup.submit(request({}, e.dir))).toMatchObject({ rejected: { code: 'bad_request' } });
    expect(e.sup.submit(request({ expectFile: '../escape.txt' }, e.root))).toMatchObject({ rejected: { code: 'bad_request' } });
    expect(e.sup.submit(request({ route: 'raw' }, e.root))).toMatchObject({ rejected: { code: 'adapter_unavailable' } });
    expect(e.sup.submit({ ...request({}, e.root), prompt: { text: 'a', file: 'b' } })).toMatchObject({ rejected: { code: 'bad_request' } });
  });
  it('rejects everything without a policy file and when the provider is over its limit', () => {
    const e = setup();
    e.writeUsage(99);
    expect(code(e, {})).toBe('quota_denied');
    e.writeUsage(92);
    const r = e.sup.submit(request({}, e.root));
    expect('warnings' in r && r.warnings.length).toBe(1);
    const none = setup(); none.writePolicy(false);
    expect(code(none, {})).toBe('model_unreviewed');
  });
});

describe('concurrency', () => {
  it('never runs more jobs than the limit, and finishes them all', async () => {
    const e = setup({ maxConcurrent: 2 });
    const ids = Array.from({ length: 5 }, () => submitOk(e.sup, request({ text: 'SLEEP 1', cwd: e.root })));
    let max = 0;
    await until(e.sup, () => { max = Math.max(max, e.store.countActive()); return ids.every(id => e.store.get(id)!.state === 'completed'); });
    expect(max).toBeLessThanOrEqual(2);
  });

  it('holds a route to its parallel limit across every route on its model, while other models run freely', async () => {
    const e = setup({ maxConcurrent: 8 });
    const d = (e.sup as unknown as { d: { policy: () => Record<string, unknown> | null } }).d, base = d.policy() as Record<string, unknown>;
    d.policy = () => ({ ...base, balance: { caps: { 'test/fake': { parallel: 1 } } } });
    const same = [submitOk(e.sup, request({ text: 'SLEEP 1', cwd: e.root })), submitOk(e.sup, request({ route: 'boss', text: 'SLEEP 1', cwd: e.root })), submitOk(e.sup, request({ text: 'SLEEP 1', cwd: e.root }))];
    const other = submitOk(e.sup, request({ route: 'pub', dataTier: 'public', text: 'SLEEP 1', cwd: e.root }));
    let max = 0, otherRanAlongside = false;
    await until(e.sup, () => {
      const running = same.filter(id => e.store.get(id)!.state === 'running').length;
      max = Math.max(max, running);
      if (running > 0 && e.store.get(other)!.state === 'running') otherRanAlongside = true;
      return [...same, other].every(id => e.store.get(id)!.state === 'completed');
    });
    expect(max).toBe(1);
    expect(otherRanAlongside).toBe(true);
  });
});

describe('the service goes away and comes back', () => {
  it('re-adopts a running job and notes that it was reconciled', async () => {
    const e = setup();
    const id = submitOk(e.sup, request({ text: 'WRITE kept.txt\nSLEEP 4', expectFile: 'kept.txt', cwd: e.root }));
    await until(e.sup, () => existsSync(join(e.dir, 'jobs', id, 'state.json')));
    const second = e.make();
    second.reconcile();
    const job = await until(second, () => { const j = e.store.get(id); return j && j.state === 'completed' ? j : null; });
    expect(job.state).toBe('completed');
    expect(kinds(e, id)).toContain('reconciled');
  });

  it('finalizes a job that ended while no service was watching', async () => {
    const e = setup();
    const id = submitOk(e.sup, request({ text: 'SLEEP 1', cwd: e.root }));
    await until(e.sup, () => existsSync(join(e.dir, 'jobs', id, 'state.json')));
    await until(e.sup, () => existsSync(join(e.dir, 'jobs', id, 'result.json')), 30000).catch(() => null);
    const second = e.make(); second.reconcile();
    expect(e.store.get(id)!.state === 'completed' || e.store.get(id)!.state === 'running').toBe(true);
    expect((await until(second, () => { const j = e.store.get(id); return j && j.state === 'completed' ? j : null; })).state).toBe('completed');
  });

  it('marks a job lost when its runner dies, and removes the child it left', async () => {
    const e = setup();
    const marker = `runner-crash-${Date.now()}`;
    const id = submitOk(e.sup, request({ text: `GRANDCHILD ${marker}\nHANG`, cwd: e.root }));
    await until(e.sup, () => processesWith(marker) > 0 && e.store.internal(id)?.childPid);
    const runner = e.store.internal(id)!.runnerPid!;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(runner), '/F'], { windowsHide: true });
    else process.kill(runner, 'SIGKILL');
    const job = await terminal(e.sup, e.store, id);
    expect(job.state).toBe('lost');
    await sleep(1000);
    expect(processesWith(marker)).toBe(0);
    killEverything(marker);
  });
});

describe('a job that starts jobs', () => {
  it('rejects a premium child when the recorded root caller is automated', async () => {
    const e = setup(), path = join(e.home, 'policy.json'), p = JSON.parse(readFileSync(path, 'utf8'));
    p.balance = { gate: { premium: ['test/ask'], paceLift: ['test/ask'], open: 20, close: 10 } };
    writeFileSync(path, JSON.stringify(p));
    const parent = submitOk(e.sup, request({ route: 'boss', text: 'HANG', caller: { kind: 'other', intent: 'automated' } }, e.root));
    await until(e.sup, () => e.store.get(parent)?.state === 'running');
    const child = e.sup.submit(request({ route: 'ask', parent: { jobId: parent, rootJobId: parent, depth: 0 }, caller: { kind: 'other', intent: 'interactive' } }, e.root));
    expect(child).toMatchObject({ rejected: { code: 'ask_first', reason: expect.stringContaining('automated tasks') } });
    e.sup.cancel(parent);
  });

  it('passes the recorded root caller intent into every delegated child environment', async () => {
    const e = setup();
    const parent = submitOk(e.sup, request({ route: 'boss', text: 'HANG', caller: { kind: 'other', intent: 'automated' } }, e.root));
    await until(e.sup, () => e.store.get(parent)?.state === 'running');
    const child = submitOk(e.sup, request({ route: 'boss', text: 'ENV AUGUR_CALLER\nHANG', caller: { kind: 'other', intent: 'interactive' }, parent: { jobId: parent, rootJobId: parent, depth: 0 } }, e.root));
    await until(e.sup, () => e.sup.logs(child)?.text.includes('ENV AUGUR_CALLER=automated'));
    expect(e.store.get(child)?.caller.intent).toBe('automated');
    e.sup.cancel(child); e.sup.cancel(parent);
  });

  it('records lower-ran only when a completed light route replaces a gated premium candidate', async () => {
    const e = setup(), path = join(e.home, 'policy.json');
    const p = JSON.parse(readFileSync(path, 'utf8'));
    p.balance = { gate: { premium: ['test/ask'], paceLift: [], open: 20, close: 10 }, tiers: { 'test/fake': 'light' } };
    writeFileSync(path, JSON.stringify(p));
    const pick = await e.sup.pick({ activity: 'write_code', dataTier: 'internal', fits: { 'test/fake': 1, 'test/patch': 0.01, 'test/public': 0.01, 'test/sandboxed': 0.01 } });
    expect('error' in pick ? null : pick.pick).toBe('test/fake');
    const fallback = submitOk(e.sup, request({ text: 'SLEEP 0' }, e.root));
    await terminal(e.sup, e.store, fallback);
    let ledger = readFileSync(join(e.home, 'gate-ledger.jsonl'), 'utf8');
    expect(ledger).toContain('"kind":"lower-ran"');
    const noPremium = JSON.parse(readFileSync(path, 'utf8'));
    noPremium.balance.gate.premium = [];
    writeFileSync(path, JSON.stringify(noPremium));
    const ordinary = submitOk(e.sup, request({ text: 'SLEEP 0' }, e.root));
    await terminal(e.sup, e.store, ordinary);
    ledger = readFileSync(join(e.home, 'gate-ledger.jsonl'), 'utf8');
    expect(ledger.match(/"kind":"lower-ran"/g)).toHaveLength(1);
  });

  it('hands the dispatch identity only to a route that grants delegation, and bounds depth', async () => {
    const e = setup({ maxDepth: 2 });
    const plain = submitOk(e.sup, request({ text: 'ENV AUGUR_JOB_ID', cwd: e.root }));
    await terminal(e.sup, e.store, plain);
    expect(e.sup.logs(plain)!.text).toContain('ENV AUGUR_JOB_ID=<unset>');

    const boss = submitOk(e.sup, request({ route: 'boss', text: 'ENV AUGUR_JOB_ID\nHANG', cwd: e.root }));
    await until(e.sup, () => e.sup.logs(boss)!.text.includes(`ENV AUGUR_JOB_ID=${boss}`));
    const child = e.sup.submit(request({ route: 'boss', parent: { jobId: boss, rootJobId: boss, depth: 0 }, cwd: e.root, text: 'HANG' }));
    expect('id' in child).toBe(true);
    const cid = (child as { id: string }).id;
    expect(e.store.get(cid)).toMatchObject({ parentJobId: boss, rootJobId: boss, depth: 1 });
    const grand = e.sup.submit(request({ route: 'boss', parent: { jobId: cid, rootJobId: boss, depth: 1 }, cwd: e.root, text: 'HANG' }));
    expect('id' in grand).toBe(true);
    const tooDeep = e.sup.submit(request({ route: 'boss', parent: { jobId: (grand as { id: string }).id, rootJobId: boss, depth: 2 }, cwd: e.root, text: 'HANG' }));
    expect(tooDeep).toMatchObject({ rejected: { code: 'depth_exceeded' } });
    const noGrant = e.sup.submit(request({ route: 'fake', parent: { jobId: plain, rootJobId: plain, depth: 0 }, cwd: e.root }));
    expect(noGrant).toMatchObject({ rejected: { code: 'delegation_not_granted' } });
    for (const j of e.store.list({ root: boss })) e.sup.cancel(j.id);
  });
});

// A descendant that leaves the job's process group is still ended by the Windows job host or a systemd scope. A bare process group cannot hold it.
describe.runIf(process.platform === 'win32' ? existsSync(JOBHOST) : systemdScopes())('with the job host or a systemd scope', () => {
  it('ends a descendant that detached from the job', async () => {
    const e = setup();
    const marker = `escape-marker-${Date.now()}`;
    const id = submitOk(e.sup, request({ text: `ESCAPE ${marker}\nSLEEP 2`, cwd: e.root }));
    expect((await terminal(e.sup, e.store, id)).state).toBe('completed');
    await sleep(1200);
    expect(processesWith(marker)).toBe(0);
    killEverything(marker);
  });
});

// With neither of those, the runner follows the job's process tree itself, so a descendant in its own process group still ends with the job.
describe.runIf(process.platform !== 'win32')('without a job host or a systemd scope', () => {
  it('ends a descendant that detached from the job', async () => {
    const e = setup({}, undefined, { scopes: () => false });
    const marker = `follow-marker-${Date.now()}`;
    const id = submitOk(e.sup, request({ text: `ESCAPE ${marker}\nSLEEP 3`, cwd: e.root }));
    expect((await terminal(e.sup, e.store, id)).state).toBe('completed');
    await sleep(1200);
    expect(processesWith(marker)).toBe(0);
    killEverything(marker);
  });
});

describe('runtime failover', () => {
  const runnerOn = { charterDir: '', ambient: 'keep' as const, failover: 'on' as const };
  const limit = (fallback: string[]) => ({
    model: 'test/fake', adapter: 'exec', fallback,
    options: { command: process.execPath, argsJson: JSON.stringify(['-e', 'process.stderr.write("rate limit\\n");process.exit(1)']) },
  });
  const add = (e: Env, routes: Record<string, unknown>) => {
    const current = JSON.parse(readFileSync(e.routesPath, 'utf8')).routes as Record<string, unknown>;
    e.writeRoutes({ ...current, ...routes });
  };
  const settled = (e: Env) => until(e.sup, () => {
    const jobs = e.store.list({ limit: 20 });
    return jobs.length && jobs.every(j => !['queued', 'running', 'cancel_requested', 'needs_approval'].includes(j.state)) ? jobs : null;
  });

  it('does not retry when runner.failover is off', async () => {
    const e = setup();
    add(e, { limited: limit(['fake']) });
    const id = submitOk(e.sup, request({ route: 'limited', text: 'SLEEP 0', cwd: e.root }));
    expect(await terminal(e.sup, e.store, id)).toMatchObject({ state: 'failed', route: 'limited' });
    expect(e.store.get(id)!.retriedAs).toBeUndefined();
    expect(e.store.list({ limit: 10 })).toHaveLength(1);
    expect(kinds(e, id)).not.toContain('failover_retry');
  });

  it('retries a limit failure on the fallback and the successor completes', async () => {
    const e = setup({ runner: runnerOn });
    add(e, { limited: limit(['fake']) });
    const id = submitOk(e.sup, request({ route: 'limited', text: 'SLEEP 0', cwd: e.root }));
    const jobs = await settled(e);
    const failed = jobs.find(j => j.id === id)!;
    const next = e.store.get(failed.retriedAs!)!;
    expect(failed.state).toBe('failed');
    expect(next).toMatchObject({ state: 'completed', route: 'fake', retryOf: id });
    expect(e.sup.result(next.id)?.answer).toBe('final message');
    expect(e.store.events(id).find(ev => ev.kind === 'failover_retry')?.detail).toBe(`limited to fake: provider limit, as ${next.id}`);
    expect(e.store.events(next.id).find(ev => ev.kind === 'failover')?.detail).toBe('limited to fake: provider limit');
  });

  it('skips a fallback a rule rejects and tries the next', async () => {
    const e = setup({ runner: runnerOn });
    add(e, { limited: limit(['ghost', 'fake']) });
    const id = submitOk(e.sup, request({ route: 'limited', text: 'SLEEP 0', cwd: e.root }));
    const jobs = await settled(e);
    const next = e.store.get(jobs.find(j => j.id === id)!.retriedAs!)!;
    expect(next).toMatchObject({ state: 'completed', route: 'fake', retryOf: id });
    expect(jobs.some(j => j.route === 'ghost')).toBe(false);
  });

  it('keeps a job whose request set failover to false', async () => {
    const e = setup({ runner: runnerOn });
    add(e, { limited: limit(['fake']) });
    const id = submitOk(e.sup, request({ route: 'limited', text: 'SLEEP 0', cwd: e.root, failover: false }));
    expect(await terminal(e.sup, e.store, id)).toMatchObject({ state: 'failed' });
    expect(e.store.get(id)!.retriedAs).toBeUndefined();
    expect(e.store.list({ limit: 10 })).toHaveLength(1);
  });

  it('stops after three jobs in the chain', async () => {
    const e = setup({ runner: runnerOn });
    add(e, { a: limit(['b']), b: limit(['c']), c: limit(['d']), d: limit(['e']) });
    const id = submitOk(e.sup, request({ route: 'a', text: 'SLEEP 0', cwd: e.root }));
    const jobs = await settled(e);
    expect(jobs.map(j => j.route).sort()).toEqual(['a', 'b', 'c']);
    expect(e.store.get(id)!.retriedAs).toBeTruthy();
    expect(jobs.find(j => j.route === 'c')!.retriedAs).toBeUndefined();
  });

  it('skips a route the chain already used', async () => {
    const e = setup({ runner: runnerOn });
    add(e, { a: limit(['b']), b: limit(['a']) });
    submitOk(e.sup, request({ route: 'a', text: 'SLEEP 0', cwd: e.root }));
    const jobs = await settled(e);
    expect(jobs.map(j => j.route).sort()).toEqual(['a', 'b']);
    expect(jobs.find(j => j.route === 'b')!.retriedAs).toBeUndefined();
  });

  it('does not retry a write job that timed out', async () => {
    const e = setup({ runner: runnerOn });
    const routes = JSON.parse(readFileSync(e.routesPath, 'utf8')).routes as Record<string, Record<string, unknown>>;
    routes.fake = { ...routes.fake, fallback: ['raw'] };
    e.writeRoutes(routes);
    const id = submitOk(e.sup, request({ text: 'HANG', timeoutS: 3, tools: 'write', cwd: e.root }));
    expect(await terminal(e.sup, e.store, id)).toMatchObject({ state: 'killed', reason: 'timed out after 3s' });
    expect(e.store.get(id)!.retriedAs).toBeUndefined();
    expect(e.store.list({ limit: 10 })).toHaveLength(1);
  });

  it('does not retry a cancelled job', async () => {
    const e = setup({ runner: runnerOn });
    const routes = JSON.parse(readFileSync(e.routesPath, 'utf8')).routes as Record<string, Record<string, unknown>>;
    routes.fake = { ...routes.fake, fallback: ['raw'] };
    e.writeRoutes(routes);
    const id = submitOk(e.sup, request({ text: 'HANG', cwd: e.root }));
    await until(e.sup, () => e.store.get(id)!.state === 'running');
    expect(e.sup.cancel(id)).toMatchObject({ ok: true });
    expect(await terminal(e.sup, e.store, id)).toMatchObject({ state: 'cancelled' });
    expect(e.store.get(id)!.retriedAs).toBeUndefined();
    expect(e.store.list({ limit: 10 })).toHaveLength(1);
  });

  it('does not retry a job whose request was lost with the process', async () => {
    const e = setup({ runner: runnerOn });
    add(e, { limited: limit(['fake']) });
    const id = submitOk(e.sup, request({ route: 'limited', text: 'SLEEP 0', cwd: e.root }));
    const result = join(e.dir, 'jobs', id, 'result.json');
    const t0 = Date.now();
    while (!existsSync(result)) {
      if (Date.now() - t0 > 30000) throw new Error('timed out waiting for result.json');
      await sleep(40);
    }
    const second = e.make();
    second.reconcile();
    const job = await terminal(second, e.store, id);
    expect(job.state).toBe('failed');
    expect(job.retriedAs).toBeUndefined();
    expect(e.store.list({ limit: 10 })).toHaveLength(1);
    expect(kinds(e, id)).not.toContain('failover_retry');
  });
});

describe('retention', () => {
  it('removes the folders of old finished jobs and keeps their records', async () => {
    const e = setup({ retentionDays: 1 });
    const id = submitOk(e.sup, request({ text: 'SLEEP 0', cwd: e.root }));
    await terminal(e.sup, e.store, id);
    expect(e.sup.purge()).toBe(0);
    const later = e.make(); (later as unknown as { now: () => number }).now = () => Date.now() + 3 * 86400000;
    expect(later.purge()).toBe(1);
    expect(existsSync(join(e.dir, 'jobs', id))).toBe(false);
    expect(e.store.get(id)!.state).toBe('completed');
    expect(statSync(e.dir).isDirectory()).toBe(true);
  });
});

describe('what a job may read and where it runs', () => {
  it('reads a prompt file only from inside the working folder or a listed root', () => {
    const e = setup();
    const inside = join(e.root, 'prompt.txt'), outside = join(e.root, '..', 'elsewhere.txt');
    writeFileSync(inside, 'SLEEP 0'); writeFileSync(outside, 'SLEEP 0');
    const ok = e.sup.submit({ ...request({ cwd: e.root }), prompt: { file: inside } });
    expect('id' in ok).toBe(true);
    const refused = e.sup.submit({ ...request({ cwd: e.root }), prompt: { file: outside } });
    expect(refused).toMatchObject({ rejected: { code: 'bad_request' } });
    const listed = setup({ promptRoots: [join(e.root, '..')] });
    expect('id' in listed.sup.submit({ ...request({ cwd: listed.root }), prompt: { file: join(listed.root, '..', 'elsewhere.txt') } })).toBe(true);
  });

  it.runIf(process.platform === 'win32')('does not start a job on Windows without the job host', () => {
    const e = setup({ jobhostPath: null });
    expect(e.sup.submit(request({ cwd: e.root }))).toMatchObject({ rejected: { code: 'adapter_unavailable' } });
  });

  it('names a systemd scope for each job where systemd can give one, and none where it cannot', async () => {
    const jobFile = (e: Env, id: string) => JSON.parse(readFileSync(join(e.dir, 'jobs', id, 'job.json'), 'utf8')) as { scope: string | null };
    const scoped = setup({}, undefined, { scopes: () => true }), plain = setup({}, undefined, { scopes: () => false });
    const a = submitOk(scoped.sup, request({ cwd: scoped.root })), b = submitOk(plain.sup, request({ cwd: plain.root }));
    expect(jobFile(scoped, a).scope).toBe(`augur-job-${a}`);
    expect(jobFile(plain, b).scope).toBeNull();
    // Windows contains jobs with the job host and ignores the scope.
    const done = await terminal(scoped.sup, scoped.store, a);
    if (process.platform === 'win32') expect(done.state).toBe('completed');
    expect((await terminal(plain.sup, plain.store, b)).state).toBe('completed');
  });
});

describe('route budgets and fallback routes', () => {
  const withRoutes = (e: Env, fake: Record<string, unknown>) => {
    const routes = JSON.parse(readFileSync(e.routesPath, 'utf8')).routes as Record<string, Record<string, unknown>>;
    routes.fake = { ...routes.fake, ...fake };
    e.writeRoutes(routes);
  };

  it('refuses a job once the route has used its job budget for the period, and says which limit', () => {
    const e = setup();
    withRoutes(e, { budget: { per: 'day', jobs: 1 } });
    submitOk(e.sup, request({ text: 'SLEEP 0', cwd: e.root }));
    const second = e.sup.submit(request({ text: 'SLEEP 0', cwd: e.root }));
    expect(second).toMatchObject({ rejected: { code: 'budget_exhausted', reason: 'fake has reached its day budget of 1 job.' } });
    expect(e.sup.budget('fake', JSON.parse(readFileSync(e.routesPath, 'utf8')).routes.fake)).toMatchObject({ jobs: { used: 1, limit: 1 } });
  });

  it('sends the job to a fallback route when the first cannot take it, and records that it did', () => {
    const e = setup();
    withRoutes(e, { budget: { per: 'day', jobs: 1 }, fallback: ['raw'] });
    submitOk(e.sup, request({ text: 'SLEEP 0', cwd: e.root }));
    const moved = e.sup.submit(request({ text: 'SLEEP 0', cwd: e.root }));
    if ('rejected' in moved) throw new Error(moved.rejected.reason);
    expect(moved.warnings[0]).toBe('fake could not take the job (fake has reached its day budget of 1 job.), so raw did.');
    expect(e.store.get(moved.id)!.route).toBe('raw');
    expect(kinds(e, moved.id)).toContain('failover');
  });

  it('keeps the job on its route with failover false, and never lets a fallback skip a rule', () => {
    const e = setup();
    withRoutes(e, { budget: { per: 'day', jobs: 1 }, fallback: ['ghost', 'ask'] });
    submitOk(e.sup, request({ text: 'SLEEP 0', cwd: e.root }));
    // ghost has no rules and ask must be named, so neither may take the job and the original refusal stands.
    expect(e.sup.submit(request({ text: 'SLEEP 0', cwd: e.root }))).toMatchObject({ rejected: { code: 'budget_exhausted' } });
    withRoutes(e, { budget: { per: 'day', jobs: 1 }, fallback: ['raw'] });
    expect(e.sup.submit({ ...request({ text: 'SLEEP 0', cwd: e.root }), failover: false })).toMatchObject({ rejected: { code: 'budget_exhausted' } });
  });

  it('does not fail over for a refusal that another route cannot fix, such as a data tier that is too high', () => {
    const e = setup();
    withRoutes(e, { fallback: ['raw'] });
    const tooHigh = e.sup.submit({ ...request({ text: 'x', cwd: e.root }), dataTier: 'regulated' });
    expect(tooHigh).toMatchObject({ rejected: { code: 'data_tier_too_high' } });
  });
});
