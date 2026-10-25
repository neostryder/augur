import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JOBHOST, ROUTES, makeEnv, request, terminal } from './harness.js';
import { readGate } from '../src/balance-files.js';
import { REJECTION_CATEGORIES } from '../src/supervisor.js';
import { REJECTION_CODES } from '@augur/dispatch-protocol';
import type { PremiumBacklog } from '../src/premium-backlog.js';
import type { Env } from './harness.js';

const envs: Env[] = [];
const setup = () => { const e = makeEnv(); envs.push(e); return e; };
afterEach(() => { while (envs.length) envs.pop()!.dispose(); });

function windowOpen(e: Env): void {
  const policyPath = join(e.home, 'policy.json'), policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  policy.balance = { gate: { premium: ['test/fake'], paceLift: ['test/fake'], surplus: { hours: 12, open: 10, close: 5, margin: 5, countdown: ['test'] } } };
  writeFileSync(policyPath, JSON.stringify(policy));
  const now = Date.now();
  writeFileSync(join(e.home, 'usage.json'), JSON.stringify({ providers: { test: { fetchedAt: new Date(now).toISOString(), meters: [{ id: 'weekly', windowKind: 'weekly', usedPct: 90, windowSeconds: 604800, resetsAt: new Date(now + 6 * 3600000).toISOString() }] } } }));
  e.sup.tick();
}

const item = (over: Record<string, unknown> = {}) => ({ requester: 'owner', repo: 'repo', task: 'work', prompt: { text: 'SLEEP 0' }, activity: 'write_code', data: 'internal', route: 'fake', lower: 'test/ask', cwd: process.cwd(), tools: 'write', output: 'write_files', ...over });

describe('premium backlog release selection', () => {
  it('classifies every submit rejection exactly once and keeps transient causes queued with one note', () => {
    const e = setup(), transient = REJECTION_CATEGORIES.transient, permanent = REJECTION_CATEGORIES.permanent;
    for (const code of REJECTION_CODES) expect(Number(transient.some(entry => entry === code)) + Number(permanent.some(entry => entry === code)), code).toBe(1);
    const policyPath = join(e.home, 'policy.json'), policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    const routes = JSON.parse(readFileSync(e.routesPath, 'utf8')).routes, meters: Record<string, unknown> = {}, routeCodes = new Map<string, typeof REJECTION_CODES[number]>(), added = new Map<string, typeof REJECTION_CODES[number]>();
    const template = policy.providers.test, templateModel = template.models['test/fake'];
    policy.balance = { gate: { premium: [], paceLift: [], open: 20, close: 10, surplus: { hours: 12, open: 10, close: 5, margin: 5, countdown: [] } } };
    for (const [index, code] of REJECTION_CODES.entries()) {
      const provider = `reject${index}`, route = `reject-${index}`, label = `${provider}/model`;
      policy.providers[provider] = { ...template, models: { [label]: { ...templateModel, id: `model-${index}` } } };
      policy.balance.gate.premium.push(label); policy.balance.gate.paceLift.push(label); policy.balance.gate.surplus.countdown.push(provider);
      routes[route] = { ...routes.fake, model: label };
      meters[provider] = { fetchedAt: new Date().toISOString(), meters: [{ id: 'weekly', windowKind: 'weekly', usedPct: 90, windowSeconds: 604800, resetsAt: new Date(Date.now() + 6 * 3600000).toISOString() }] };
      routeCodes.set(route, code);
    }
    writeFileSync(policyPath, JSON.stringify(policy)); e.writeRoutes(routes); writeFileSync(join(e.home, 'usage.json'), JSON.stringify({ providers: meters })); e.sup.tick();
    for (const route of routeCodes.keys()) {
      const row = e.sup.backlogAdd(item({ cwd: e.root, task: route, route }));
      expect('error' in row, route).toBe(false);
      if (!('error' in row)) added.set(row.id, routeCodes.get(route)!);
    }
    e.sup.submit = ((request: import('@augur/dispatch-protocol').JobRequest) => {
      const code = routeCodes.get(request.route);
      if (!code) throw new Error(`No rejection code for ${request.route}`);
      return { rejected: { code, reason: `stubbed ${code}` } };
    }) as typeof e.sup.submit;
    e.sup.releaseDue(Date.now()); e.sup.releaseDue(Date.now()); e.sup.releaseDue(Date.now());
    for (const [id, code] of added) {
      const row = e.sup.backlogList().find(item => item.id === id);
      if (transient.some(entry => entry === code)) {
        expect(row?.status).toBe('queued');
        expect(row?.statusLog.filter(entry => entry.note === `stubbed ${code}`), code).toHaveLength(1);
      } else {
        expect(row?.status).toBe('failed');
        expect(row?.statusLog.at(-1)).toMatchObject({ note: `stubbed ${code}` });
      }
    }
  });

  it('orders candidates by deadline and age, expires overdue items, and requires estimates to fit', () => {
    const e = setup();
    windowOpen(e);
    const policyPath = join(e.home, 'policy.json'), policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    policy.providers.other = { ...policy.providers.test, models: { 'other/premium': { ...policy.providers.test.models['test/fake'], id: 'other-1' } } };
    policy.balance.gate.premium.push('other/premium'); policy.balance.gate.paceLift.push('other/premium'); policy.balance.gate.surplus.countdown.push('other');
    writeFileSync(policyPath, JSON.stringify(policy));
    const now = Date.now(), usagePath = join(e.home, 'usage.json'), usage = JSON.parse(readFileSync(usagePath, 'utf8'));
    usage.providers.other = { fetchedAt: new Date(now).toISOString(), meters: [{ id: 'weekly', windowKind: 'weekly', usedPct: 90, windowSeconds: 604800, resetsAt: new Date(now + 6 * 3600000).toISOString() }] };
    writeFileSync(usagePath, JSON.stringify(usage));
    const routes = JSON.parse(readFileSync(e.routesPath, 'utf8')).routes;
    e.writeRoutes({ ...routes, other: { ...routes.fake, model: 'other/premium' } });
    e.sup.tick();
    e.sup.backlogAdd(item({ task: 'later', deadline: new Date(Date.now() + 60000).toISOString(), estimate: 2 }));
    e.sup.backlogAdd(item({ task: 'too costly', deadline: new Date(Date.now() + 30000).toISOString(), estimate: 6 }));
    e.sup.backlogAdd(item({ route: 'other', task: 'older tie', deadline: new Date(Date.now() + 90000).toISOString(), estimate: 1 }));
    e.sup.backlogAdd(item({ route: 'other', task: 'newer tie', deadline: new Date(Date.now() + 90000).toISOString(), estimate: 1 }));
    e.sup.backlogAdd(item({ task: 'expired', deadline: new Date(Date.now() - 1000).toISOString() }));
    const result = e.sup.releaseDue(Date.now(), true);
    const listed = e.sup.backlogList();
    expect(result.candidates).toHaveLength(2);
    expect(listed.find(x => x.task === 'expired')).toMatchObject({ status: 'queued' });
    expect(listed.find(x => x.task === 'later')?.id).toBe(result.candidates[0]);
    expect(listed.find(x => x.task === 'older tie')?.id).toBe(result.candidates[1]);
    expect(listed.find(x => x.task === 'newer tie')?.id).not.toBe(result.candidates[1]);
  });

  it('leaves a queued item for a provider without an open window', () => {
    const e = setup();
    windowOpen(e);
    const policyPath = join(e.home, 'policy.json'), policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    policy.providers.other = { ...policy.providers.test, models: { 'other/premium': { ...policy.providers.test.models['test/fake'], id: 'other-1' } } };
    policy.balance.gate.premium.push('other/premium');
    policy.balance.gate.paceLift.push('other/premium');
    writeFileSync(policyPath, JSON.stringify(policy));
    e.writeRoutes({ ...JSON.parse(readFileSync(e.routesPath, 'utf8')).routes, other: { model: 'other/premium', adapter: 'codex-exec', options: { command: process.execPath, prefixArgsJson: JSON.stringify([join(e.root, 'missing.mjs')]) } } });
    const added = e.sup.backlogAdd(item({ route: 'other' }));
    expect('error' in added).toBe(false);
    expect(e.sup.releaseDue(Date.now(), true).candidates).toEqual([]);
    expect(e.sup.backlogList('queued')).toHaveLength(1);
  });

  it('keeps a deleted cwd visible and fails it only when release is evaluated', () => {
    const e = setup(); windowOpen(e);
    const cwd = join(e.root, 'removed-cwd'); mkdirSync(cwd);
    const added = e.sup.backlogAdd(item({ cwd }));
    expect('error' in added).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
    expect(e.sup.backlogList('queued')).toHaveLength(1);
    e.sup.releaseDue(Date.now());
    expect(e.sup.backlogList('failed')[0]?.statusLog.at(-1)?.note).toBe('working directory no longer exists');
  });

  it('leaves all files unchanged during a dry run, including expired items and blocked notes', () => {
    const e = setup(); windowOpen(e);
    const expired = e.sup.backlogAdd(item({ cwd: e.root, deadline: new Date(Date.now() - 1000).toISOString() }));
    const approval = e.sup.backlogAdd(item({ cwd: e.root, deadline: new Date(Date.now() - 1000).toISOString() }), 'agent');
    e.writeRoutes({});
    const backlogPath = join(e.home, 'premium-backlog.jsonl'), gatePath = join(e.dir, 'gate-state.json');
    const beforeBacklog = readFileSync(backlogPath), beforeGate = readFileSync(gatePath);
    const result = e.sup.backlogRun(true);
    expect(result.wouldExpire.sort()).toEqual([!('error' in expired) ? expired.id : '', !('error' in approval) ? approval.id : ''].sort());
    expect(readFileSync(backlogPath)).toEqual(beforeBacklog);
    expect(readFileSync(gatePath)).toEqual(beforeGate);
    expect(e.sup.backlogList('queued')).toHaveLength(1);
    expect(e.sup.backlogList('awaiting-approval')).toHaveLength(1);
    expect('error' in expired).toBe(false);
  });

  it('does not rewrite unchanged gate state', () => {
    const e = setup(); windowOpen(e);
    const gatePath = join(e.dir, 'gate-state.json'), before = readFileSync(gatePath);
    e.sup.tick();
    expect(readFileSync(gatePath)).toEqual(before);
  });

  it('skips tick release checks with no queued items and throttles repeated evaluations', () => {
    const e = setup(), release = vi.spyOn(e.sup, 'releaseDue');
    e.sup.tick();
    expect(release).not.toHaveBeenCalled();
    e.sup.backlogAdd(item({ cwd: e.root }));
    e.sup.tick();
    expect(release).toHaveBeenCalledTimes(1);
    e.sup.tick();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('uses resolved classic balance defaults when policy has no balance section', () => {
    const e = setup(), policyPath = join(e.home, 'policy.json');
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    policy.providers.claude = { ...policy.providers.test, models: { 'claude/opus': { ...policy.providers.test.models['test/fake'], id: 'opus' } } };
    delete policy.balance;
    writeFileSync(policyPath, JSON.stringify(policy));
    const routes = JSON.parse(readFileSync(e.routesPath, 'utf8')).routes;
    e.writeRoutes({ ...routes, fake: { ...routes.fake, model: 'claude/opus' } });
    const now = Date.now();
    writeFileSync(join(e.home, 'usage.json'), JSON.stringify({ providers: { claude: { fetchedAt: new Date(now).toISOString(), meters: [{ id: 'weekly', windowKind: 'weekly', usedPct: 90, windowSeconds: 604800, resetsAt: new Date(now + 6 * 3600000).toISOString() }] } } }));
    e.sup.tick();
    const added = e.sup.backlogAdd(item({ cwd: e.root }));
    expect('error' in added).toBe(false);
    const result = e.sup.releaseDue(now);
    expect(result.released).toHaveLength(1);
  });

  it('rejects prompt files outside cwd and configured prompt roots when adding an item', () => {
    const e = setup(), outside = join(tmpdir(), `augurd-prompt-outside-${Date.now()}`), file = join(outside, 'outside.md');
    mkdirSync(outside);
    writeFileSync(file, 'work');
    expect(e.sup.backlogAdd(item({ cwd: e.root, prompt: { file } }))).toMatchObject({ error: expect.stringContaining('Prompt file must exist inside cwd') });
    rmSync(outside, { recursive: true, force: true });
  });

  it('expires awaiting-approval items and refuses approval after their deadline', () => {
    const e = setup(); windowOpen(e);
    const added = e.sup.backlogAdd(item({ cwd: e.root, deadline: new Date(Date.now() - 1000).toISOString() }), 'agent');
    expect('error' in added).toBe(false);
    e.sup.releaseDue(Date.now());
    expect(e.sup.backlogList('expired')[0]?.statusLog.at(-1)).toMatchObject({ status: 'expired', note: 'deadline passed' });
    if (!('error' in added)) expect(e.sup.backlogApprove(added.id)).toMatchObject({ error: expect.stringContaining('expired') });
  });

  it('keeps routes that are missing or temporarily ineligible queued with one note per cause', () => {
    const e = setup(); windowOpen(e);
    const missing = e.sup.backlogAdd(item({ cwd: e.root }));
    e.writeRoutes({});
    e.sup.releaseDue(Date.now()); e.sup.releaseDue(Date.now());
    expect(e.sup.backlogList('queued').find(x => !('error' in missing) && x.id === missing.id)?.statusLog.filter(x => x.note === 'route is not in routes.json')).toHaveLength(1);

    e.writeRoutes(JSON.parse(readFileSync(e.routesPath, 'utf8')).routes);
    e.writeRoutes({ fake: { model: 'test/fake', adapter: 'missing-adapter', options: {} } });
    e.sup.releaseDue(Date.now()); e.sup.releaseDue(Date.now());
    const current = e.sup.backlogList('queued').find(x => !('error' in missing) && x.id === missing.id);
    expect(current?.statusLog.filter(x => x.note.startsWith('route is not currently eligible:'))).toHaveLength(1);
  });

  it('marks a queued item failed with the policy hard-block reason', () => {
    const e = setup();
    windowOpen(e);
    const added = e.sup.backlogAdd(item({ data: 'regulated', cwd: e.root }));
    expect('error' in added).toBe(false);
    e.sup.releaseDue(Date.now());
    expect(e.sup.backlogList('failed')[0]?.statusLog.at(-1)?.note).toContain('task is regulated');
  });

  it('keeps one running item per provider and charges the released estimate to that window', () => {
    const e = setup(); windowOpen(e);
    const first = e.sup.backlogAdd(item({ cwd: e.root, estimate: 2 })), second = e.sup.backlogAdd(item({ cwd: e.root, estimate: 2 }));
    expect('error' in first || 'error' in second).toBe(false);
    const result = e.sup.releaseDue(Date.now());
    expect(result.released).toHaveLength(1);
    expect(e.sup.backlogList('running')).toHaveLength(1);
    expect(e.sup.backlogList('queued')).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(e.dir, 'gate-state.json'), 'utf8')).surplus.test.spent).toBe(2);
    expect(e.sup.backlogRun(true).candidates).toEqual([]);
  });

  it('relinks a submitted backlog marker after a crash and charges its window once', () => {
    const e = setup(); windowOpen(e);
    const added = e.sup.backlogAdd(item({ cwd: e.root, estimate: 2 }));
    expect('error' in added).toBe(false);
    if ('error' in added) return;
    const backlog = (e.sup as unknown as { backlog: PremiumBacklog }).backlog;
    backlog.update(added.id, 'running', 'releasing');
    const submitted = e.sup.submit(request({ text: 'SLEEP 30', cwd: e.root, released: true, allow: ['unpicked'], caller: { kind: 'job', label: `backlog:${added.id}`, intent: 'automated' } }, e.root));
    expect('id' in submitted).toBe(true);
    if (!('id' in submitted)) return;

    const restarted = e.make();
    const relinked = restarted.backlogList('running').find(row => row.id === added.id);
    expect(relinked).toMatchObject({ provider: 'test', result: { jobId: submitted.id } });
    expect(e.store.get(submitted.id)?.caller.label).toBe(`backlog:${added.id}`);
    expect(restarted.backlogRun().released).toEqual([]);
    expect(JSON.parse(readFileSync(join(e.dir, 'gate-state.json'), 'utf8')).surplus.test.spent).toBe(2);
    e.make();
    expect(JSON.parse(readFileSync(join(e.dir, 'gate-state.json'), 'utf8')).surplus.test.spent).toBe(2);
  });

  it('does not release a second item for a provider after its running route is deleted', () => {
    const e = setup(); windowOpen(e);
    e.writeRoutes({ ...ROUTES, other: { ...ROUTES.fake } });
    const first = e.sup.backlogAdd(item({ cwd: e.root, task: 'first' })), second = e.sup.backlogAdd(item({ cwd: e.root, task: 'second', route: 'other' }));
    expect('error' in first || 'error' in second).toBe(false);
    if ('error' in first || 'error' in second) return;
    e.sup.submit = (() => ({ id: 'first-job', warnings: [] })) as typeof e.sup.submit;
    expect(e.sup.releaseDue(Date.now()).released).toEqual([first.id]);
    expect(e.sup.backlogList('running').find(row => row.id === first.id)?.provider).toBe('test');
    e.writeRoutes({ other: { ...ROUTES.fake } });
    expect(e.sup.releaseDue(Date.now()).released).toEqual([]);
    expect(e.sup.backlogList('queued').map(row => row.id)).toContain(second.id);
  });

  it.skipIf(process.platform === 'win32' && !existsSync(JOBHOST))('closes a lost job as failed and releases the next item for its provider', () => {
    const e = setup(); windowOpen(e);
    const first = e.sup.backlogAdd(item({ cwd: e.root, task: 'first', prompt: { text: 'SLEEP 30' } })), second = e.sup.backlogAdd(item({ cwd: e.root, task: 'second' }));
    expect('error' in first || 'error' in second).toBe(false);
    if ('error' in first || 'error' in second) return;
    const released = e.sup.releaseDue(Date.now());
    expect(released.released).toEqual([first.id]);
    const jobId = e.sup.backlogList('running').find(row => row.id === first.id)?.result?.jobId;
    expect(jobId).toBeTruthy();
    if (!jobId) return;
    const job = e.store.get(jobId)!;
    if (job.state === 'queued') e.store.transition(jobId, 'running');
    e.store.transition(jobId, 'lost', { reason: 'runner vanished' });
    const restarted = e.make();
    expect(restarted.backlogList('failed').find(row => row.id === first.id)?.statusLog.at(-1)?.note).toBe('lost');
    expect(restarted.releaseDue(Date.now()).released).toEqual([second.id]);
  });

  it('uses sequential budget decisions for status, dry run and release', () => {
    const e = setup(); windowOpen(e);
    const first = e.sup.backlogAdd(item({ cwd: e.root, task: 'first', estimate: 3 }));
    const second = e.sup.backlogAdd(item({ cwd: e.root, task: 'second', estimate: 3 }));
    expect('error' in first || 'error' in second).toBe(false);
    if ('error' in first || 'error' in second) return;
    expect((e.sup.backlogStatus() as { fitting: string[] }).fitting).toEqual([first.id]);
    const before = readFileSync(join(e.home, 'premium-backlog.jsonl'));
    const dryRun = e.sup.backlogRun(true);
    expect(dryRun.candidates).toEqual([first.id]);
    expect(dryRun.wouldHold).toEqual([{ id: second.id, reason: 'surplus budget is exhausted' }]);
    expect(readFileSync(join(e.home, 'premium-backlog.jsonl'))).toEqual(before);
    const released = e.sup.backlogRun();
    expect(released.released).toEqual([first.id]);
    expect(e.sup.backlogList('queued').find(row => row.id === second.id)?.statusLog.at(-1)?.note).toBe('surplus budget is exhausted');
  });

  it('does not release an agent item before owner approval', () => {
    const e = setup(); windowOpen(e);
    const added = e.sup.backlogAdd(item({ cwd: e.root }), 'agent');
    expect(added).toMatchObject({ author: 'agent', status: 'awaiting-approval' });
    expect(e.sup.backlogRun().released).toEqual([]);
    if ('error' in added) return;
    expect(e.sup.backlogList('awaiting-approval')).toHaveLength(1);
    expect(e.sup.backlogApprove(added.id)).toMatchObject({ status: 'queued' });
    expect(e.sup.backlogRun().released).toEqual([added.id]);
  });

  it('uses a live open surplus window for an interactive pick and run but refuses automated callers', async () => {
    const e = setup(); windowOpen(e);
    const picked = await e.sup.pick({ activity: 'write_code', dataTier: 'internal', caller: 'interactive' });
    expect('error' in picked).toBe(false);
    if (!('error' in picked)) expect(picked.ranking.map(row => row.model)).toContain('test/fake');
    const interactive = e.sup.submit(request({ caller: { kind: 'cli', label: 'premium-backlog', intent: 'interactive' } }, e.root));
    expect(interactive).toHaveProperty('id');
    if ('id' in interactive) await terminal(e.sup, e.store, interactive.id);
    expect(JSON.parse(readFileSync(join(e.dir, 'gate-state.json'), 'utf8')).surplus.test.spent).toBe(1);
    const automated = e.sup.submit(request({ caller: { kind: 'job', label: 'agent', intent: 'automated' } }, e.root));
    expect(automated).toMatchObject({ rejected: { code: 'ask_first' } });
  });

  it('lifts xai/grok for interactive pick and run through grok usage, and refuses automated callers', async () => {
    for (const kind of ['pace', 'surplus'] as const) {
      const e = setup();
      const policyPath = join(e.home, 'policy.json'), policy = JSON.parse(readFileSync(policyPath, 'utf8'));
      policy.providers.grok = { ...policy.providers.test, models: { 'xai/grok': { ...policy.providers.test.models['test/fake'], id: 'grok' } } };
      delete policy.providers.test;
      policy.balance = { gate: { premium: ['xai/grok'], paceLift: ['xai/grok'], open: 20, close: 10, surplus: { hours: 12, open: 10, close: 5, margin: 5, countdown: ['grok'] } } };
      writeFileSync(policyPath, JSON.stringify(policy));
      const routes = JSON.parse(readFileSync(e.routesPath, 'utf8')).routes;
      e.writeRoutes({ ...routes, grok: { ...routes.fake, model: 'xai/grok' } });
      const now = Date.now(), usedPct = kind === 'pace' ? 0 : 90;
      const usage = { providers: { grok: { fetchedAt: new Date(now).toISOString(), meters: [{ id: 'weekly', windowKind: 'weekly', usedPct, windowSeconds: 604800, resetsAt: new Date(now + (kind === 'pace' ? 3.5 * 86400000 : 6 * 3600000)).toISOString() }] } } };
      writeFileSync(join(e.home, 'usage.json'), JSON.stringify(usage));
      e.sup.tick();
      const picked = await e.sup.pick({ activity: 'write_code', dataTier: 'internal', caller: 'interactive', best: true });
      expect('error' in picked).toBe(false);
      if (!('error' in picked)) expect(picked.ranking.map(row => row.model)).toContain('xai/grok');
      const interactive = e.sup.submit(request({ route: 'grok', caller: { kind: 'cli', label: 'terminal', intent: 'interactive' } }, e.root));
      expect(interactive).toHaveProperty('id');
      const automatedPick = await e.sup.pick({ activity: 'write_code', dataTier: 'internal', caller: 'automated', best: true });
      expect('error' in automatedPick || !automatedPick.ranking.some(row => row.model === 'xai/grok')).toBe(true);
      expect(e.sup.submit(request({ route: 'grok', caller: { kind: 'job', label: 'agent', intent: 'automated' } }, e.root))).toMatchObject({ rejected: { code: 'ask_first' } });
    }
  });

  it('refuses a run that declares no intent even while a surplus window is open, and logs a window lift as surplus-lifted', async () => {
    const e = setup(); windowOpen(e);
    expect(e.sup.submit(request({ caller: { kind: 'cli', label: 'terminal' } }, e.root))).toMatchObject({ rejected: { code: 'ask_first' } });
    const picked = await e.sup.pick({ activity: 'write_code', dataTier: 'internal', caller: 'interactive' });
    expect('error' in picked).toBe(false);
    const rows = readFileSync(join(e.home, 'gate-ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.filter(row => row.label === 'test/fake').map(row => row.kind)).toEqual(['surplus-lifted']);
  });

  it('keeps the pace lift and refuses spent or stale surplus windows at run time', () => {
    const e = setup(); windowOpen(e);
    const run = () => e.sup.submit(request({ caller: { kind: 'cli', label: 'terminal', intent: 'interactive' } }, e.root));
    const gatePath = join(e.dir, 'gate-state.json'), gate = JSON.parse(readFileSync(gatePath, 'utf8'));
    gate.surplus.test.spent = 100; writeFileSync(gatePath, JSON.stringify(gate));
    expect(run()).toMatchObject({ rejected: { code: 'ask_first' } });
    gate.surplus.test.spent = 0; writeFileSync(gatePath, JSON.stringify(gate));
    const usagePath = join(e.home, 'usage.json'), usage = JSON.parse(readFileSync(usagePath, 'utf8'));
    usage.providers.test.stale = true; writeFileSync(usagePath, JSON.stringify(usage));
    expect(run()).toMatchObject({ rejected: { code: 'ask_first' } });
    usage.providers.test.stale = false;
    usage.providers.test.meters[0].usedPct = 70;
    usage.providers.test.meters[0].resetsAt = new Date(Date.now() + 48 * 3600000).toISOString();
    writeFileSync(usagePath, JSON.stringify(usage));
    expect(run()).toHaveProperty('id');
  });

  it.skipIf(process.platform === 'win32' && !existsSync(JOBHOST))('closes a cancelled backlog job as cancelled, not failed', async () => {
    const e = setup(); windowOpen(e);
    const added = e.sup.backlogAdd(item({ cwd: e.root, prompt: { text: 'SLEEP 30' } }));
    expect('error' in added).toBe(false);
    if ('error' in added) return;
    expect(e.sup.releaseDue(Date.now()).released).toEqual([added.id]);
    const jobId = e.sup.backlogList('running').find(row => row.id === added.id)?.result?.jobId;
    expect(jobId).toBeTruthy();
    expect(e.sup.cancel(jobId!)).toMatchObject({ ok: true });
    await terminal(e.sup, e.store, jobId!);
    expect(e.sup.backlogList('cancelled').map(row => row.id)).toEqual([added.id]);
    expect(e.sup.backlogList('failed')).toEqual([]);
  });

  it('logs surplus-open again when a window closes and reopens on the same reset', () => {
    const e = setup(); windowOpen(e);
    const path = join(e.home, 'usage.json'), resetsAt = JSON.parse(readFileSync(path, 'utf8')).providers.test.meters[0].resetsAt as string;
    const usage = (usedPct: number) => writeFileSync(path, JSON.stringify({ providers: { test: { fetchedAt: new Date().toISOString(), meters: [{ id: 'weekly', windowKind: 'weekly', usedPct, windowSeconds: 604800, resetsAt }] } } }));
    usage(99); e.sup.tick();
    usage(90); e.sup.tick();
    const kinds = readGate(e.home).map(row => row.kind).filter(kind => kind.startsWith('surplus-'));
    expect(kinds).toEqual(['surplus-open', 'surplus-close', 'surplus-open']);
  });

  it('refreshes a window that opens after the last tick and carries spend across releases', async () => {
    const e = setup();
    const policyPath = join(e.home, 'policy.json'), policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    policy.balance = { gate: { premium: ['test/fake'], paceLift: ['test/fake'], surplus: { hours: 12, open: 10, close: 5, margin: 5, countdown: ['test'] } } };
    writeFileSync(policyPath, JSON.stringify(policy)); e.sup.tick();
    const first = e.sup.backlogAdd(item({ cwd: e.root, estimate: 2 })), second = e.sup.backlogAdd(item({ cwd: e.root, estimate: 2 }));
    expect('error' in first || 'error' in second).toBe(false);
    const path = join(e.home, 'usage.json'), now = Date.now();
    writeFileSync(path, JSON.stringify({ providers: { test: { fetchedAt: new Date(now).toISOString(), meters: [{ id: 'weekly', windowKind: 'weekly', usedPct: 90, windowSeconds: 604800, resetsAt: new Date(now + 6 * 3600000).toISOString() }] } } }));
    const result = e.sup.backlogRun();
    expect(result.released).toHaveLength(1);
    const job = e.sup.backlogList('running')[0]?.result?.jobId;
    expect(job).toBeTruthy();
    await terminal(e.sup, e.store, job!);
    expect(e.sup.backlogRun().released).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(e.dir, 'gate-state.json'), 'utf8')).surplus.test.spent).toBe(4);
  });

  it('fails only the item whose submit throws and clears the release guard', () => {
    const e = setup(); windowOpen(e);
    const first = e.sup.backlogAdd(item({ cwd: e.root })), second = e.sup.backlogAdd(item({ cwd: e.root }));
    const submit = e.sup.submit.bind(e.sup);
    let calls = 0;
    e.sup.submit = ((request: import('@augur/dispatch-protocol').JobRequest) => { if (++calls === 1) throw new Error('submit exploded'); return submit(request); }) as typeof e.sup.submit;
    e.sup.releaseDue(Date.now());
    expect(e.sup.backlogList('failed').map(x => x.id)).toEqual([!('error' in first) ? first.id : '']);
    expect(e.sup.backlogList('running').map(x => x.id)).toEqual([!('error' in second) ? second.id : '']);
    expect((e.sup as unknown as { releasingBacklog: boolean }).releasingBacklog).toBe(false);
    e.sup.submit = submit;
  });

  it('keeps a paused owner-approved item queued and releases it after the pause lifts', () => {
    const e = setup(); windowOpen(e);
    const path = join(e.home, 'policy.json'), policy = JSON.parse(readFileSync(path, 'utf8'));
    policy.providers.test.models['test/fake'].pause = { until: new Date(Date.now() + 3600000).toISOString(), weights: null };
    writeFileSync(path, JSON.stringify(policy));
    const added = e.sup.backlogAdd(item({ cwd: e.root }));
    expect('error' in added).toBe(false);
    e.sup.releaseDue(Date.now());
    e.sup.releaseDue(Date.now());
    expect(e.sup.backlogList('queued')[0]?.statusLog.at(-1)?.note).toContain('paused');
    expect(e.sup.backlogList('queued')[0]?.statusLog.filter(x => x.note.includes('paused'))).toHaveLength(1);
    expect(e.store.list({ limit: 10 }).filter(j => j.caller.label?.startsWith('backlog:'))).toHaveLength(0);
    policy.providers.test.models['test/fake'].pause.until = new Date(Date.now() - 1000).toISOString();
    writeFileSync(path, JSON.stringify(policy));
    e.sup.releaseDue(Date.now());
    expect(e.sup.backlogList('running')).toHaveLength(1);
  });

  it('blocks Copilot by the route model label prefix', () => {
    const e = setup(); windowOpen(e);
    const policyPath = join(e.home, 'policy.json'), policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    policy.providers.copilot = { ...policy.providers.test, models: { 'copilot/chat': { ...policy.providers.test.models['test/fake'], id: 'copilot-1' } } };
    policy.balance.gate.premium.push('copilot/chat');
    writeFileSync(policyPath, JSON.stringify(policy));
    e.writeRoutes({ ...JSON.parse(readFileSync(e.routesPath, 'utf8')).routes, fake: { ...JSON.parse(readFileSync(e.routesPath, 'utf8')).routes.fake, model: 'copilot/chat' } });
    const added = e.sup.backlogAdd(item({ cwd: e.root }));
    expect('error' in added).toBe(false);
    e.sup.releaseDue(Date.now());
    expect(e.sup.backlogList('failed')[0]?.statusLog.at(-1)?.note).toContain('Copilot labels');
  });

  it.skipIf(process.platform === 'win32' && !existsSync(JOBHOST))('releases one due item through the fake route and records its item id', async () => {
    const e = setup();
    windowOpen(e);
    const sup = e.make({ requirePick: true, verifyNamed: 'enforce' });
    let releasedRequest: import('@augur/dispatch-protocol').JobRequest | undefined;
    const submit = sup.submit.bind(sup);
    sup.submit = (request => { releasedRequest = request; return submit(request); }) as typeof sup.submit;
    const added = sup.backlogAdd(item({ cwd: e.root, estimate: 2 }));
    expect('error' in added).toBe(false);
    const result = sup.releaseDue(Date.now());
    expect(result.released).toHaveLength(1);
    expect(releasedRequest).toMatchObject({ released: true, caller: { intent: 'automated' } });
    expect(releasedRequest?.named).toBeUndefined(); expect(releasedRequest?.premiumGateLift).toBeUndefined();
    const run = sup.backlogList('running')[0];
    expect(run?.result?.jobId).toBeTruthy();
    const events = e.store.events(run!.result!.jobId);
    expect(events.map(x => x.kind)).toContain('queued');
    expect(readGate(e.home)).toContainEqual(expect.objectContaining({ kind: 'released', itemId: !('error' in added) ? added.id : '', provider: 'test', label: 'test/fake', estimatePoints: 2, note: `released from premium backlog item ${!('error' in added) ? added.id : ''}` }));
    expect(e.store.events(run!.result!.jobId).map(x => x.detail)).toContain(`released from premium backlog item ${!('error' in added) ? added.id : ''}`);
    await terminal(e.sup, e.store, run!.result!.jobId);
    expect(e.sup.backlogList('done')).toHaveLength(1);
  });
});
