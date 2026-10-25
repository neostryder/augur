import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PremiumBacklog, validateBacklogItem } from '../src/premium-backlog.js';
import { withFileLock } from '../src/file-lock.js';

const homes: string[] = [];
function home(): string { const dir = mkdtempSync(join(tmpdir(), 'augur-backlog-')); homes.push(dir); return dir; }
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const item = { requester: 'owner', repo: 'repo', task: 'fix tests', prompt: { text: 'Fix the test.' }, activity: 'write_code', data: 'internal', route: 'claude/opus', lower: 'claude/sonnet', cwd: process.cwd(), tools: 'write', output: 'patch_only' };

describe('premium backlog store', () => {
  it('creates a missing lock parent before writing', () => {
    const target = join(home(), 'fresh', 'premium-backlog.jsonl');
    expect(withFileLock(target, () => 'updated')).toBe('updated');
  });
  it('takes over a lock from a dead pid at once', () => {
    const target = join(home(), 'items.jsonl');
    writeFileSync(`${target}.lock`, '2147483647\n');
    expect(withFileLock(target, () => 'updated')).toBe('updated');
  });
  it('does not take over a live pid lock before 30 seconds and takes it over after', () => {
    const target = join(home(), 'items.jsonl'), lock = `${target}.lock`;
    writeFileSync(lock, `${process.pid}\n`);
    utimesSync(lock, new Date(Date.now() - 20000), new Date(Date.now() - 20000));
    expect(() => withFileLock(target, () => 'updated')).toThrow(`Timed out waiting for ${lock}`);
    expect(readFileSync(lock, 'utf8')).toBe(`${process.pid}\n`);
    utimesSync(lock, new Date(Date.now() - 31000), new Date(Date.now() - 31000));
    expect(withFileLock(target, () => 'updated')).toBe('updated');
  });
  it('ignores a leftover sibling temp file and replaces it on the next write', () => {
    const dir = home(), store = new PremiumBacklog(dir);
    writeFileSync(`${store.path}.leftover.tmp`, 'partial');
    const added = store.add(item);
    expect('error' in added).toBe(false);
    expect(store.list()).toHaveLength(1);
    expect(readFileSync(`${store.path}.leftover.tmp`, 'utf8')).toBe('partial');
    expect(existsSync(store.path)).toBe(true);
  });
  it('validates, adds, lists, updates, drops and rewrites items', () => {
    expect(validateBacklogItem({ ...item, data: 'unknown' })).toContain('data must be a known data tier.');
    const store = new PremiumBacklog(home(), () => Date.parse('2026-10-01T00:00:00Z'));
    const added = store.add(item);
    expect('error' in added).toBe(false);
    if ('error' in added) return;
    expect(store.list('queued')).toHaveLength(1);
    expect(store.update(added.id, 'done', 'finished', { jobId: 'job', cost: 1 })?.result?.jobId).toBe('job');
    expect(JSON.parse(readFileSync(store.path, 'utf8').trim()).status).toBe('done');
    expect(store.drop(added.id)).toBe(true);
    expect(store.list()).toEqual([]);
  });
  it('suppresses only a note that matches the latest status-log row', () => {
    const store = new PremiumBacklog(home()), added = store.add(item);
    if ('error' in added) return;
    store.update(added.id, 'queued', 'held'); store.update(added.id, 'queued', 'held');
    store.update(added.id, 'queued', 'other'); store.update(added.id, 'queued', 'held');
    expect(store.list()[0]?.statusLog.filter(row => row.note === 'held')).toHaveLength(2);
  });
  it('preserves invalid raw rows on a write and reports them', () => {
    const dir = home(), store = new PremiumBacklog(dir);
    const added = store.add(item);
    const bad = '{"broken":true}';
    writeFileSync(store.path, `${bad}\n${JSON.stringify(added)}\n`);
    expect(store.invalidCount()).toBe(1);
    if (!('error' in added)) store.update(added.id, 'done', 'done');
    expect(readFileSync(store.path, 'utf8')).toContain(bad);
  });
  it('assigns authors, requires approval for agent entries, and validates estimate points', () => {
    const store = new PremiumBacklog(home()), agent = store.add(item, 'agent'), owner = store.add(item, 'owner');
    expect(agent).toMatchObject({ author: 'agent', status: 'awaiting-approval' });
    expect(owner).toMatchObject({ author: 'owner', status: 'queued' });
    if (!('error' in agent)) expect(store.approve(agent.id)).toMatchObject({ status: 'queued' });
    expect(validateBacklogItem({ ...item, estimate: 101 }).join(' ')).toContain('0 to 100 points');
    expect(validateBacklogItem({ ...item, cwd: 'relative' }).join(' ')).toContain('absolute path to an existing directory');
  });
  it('accepts rows without lower and keeps a removed cwd readable', () => {
    const dir = home(), cwd = mkdtempSync(join(tmpdir(), 'augur-backlog-cwd-')), store = new PremiumBacklog(dir);
    const { lower, ...withoutLower } = item;
    void lower;
    const added = store.add({ ...withoutLower, cwd });
    expect('error' in added).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
    expect(store.list()).toHaveLength(1);
    expect(store.invalidCount()).toBe(0);
  });
  it('refuses approval after the deadline', () => {
    let now = Date.parse('2026-10-01T00:00:00Z');
    const store = new PremiumBacklog(home(), () => now);
    const added = store.add({ ...item, deadline: new Date(now + 1000).toISOString() }, 'agent');
    if ('error' in added) return;
    now += 2000;
    expect(store.approve(added.id)).toBeNull();
    expect(store.list()).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'awaiting-approval' })]));
  });
  it('re-reads under the shared lock when separate store instances write', () => {
    const dir = home(), first = new PremiumBacklog(dir), second = new PremiumBacklog(dir);
    first.add({ ...item, task: 'first' }); second.add({ ...item, task: 'second' });
    expect(new PremiumBacklog(dir).list().map(row => row.task)).toEqual(['first', 'second']);
  });
  it('reconciles running items after a service restart', () => {
    const store = new PremiumBacklog(home()), missing = store.add(item), complete = store.add({ ...item, task: 'complete' }), failed = store.add({ ...item, task: 'failed' });
    if ('error' in missing || 'error' in complete || 'error' in failed) return;
    store.update(missing.id, 'running', 'releasing');
    store.update(complete.id, 'running', 'released', { jobId: 'done', cost: null });
    store.update(failed.id, 'running', 'released', { jobId: 'failed', cost: null });
    store.reconcile(id => !id ? null : { state: id === 'done' ? 'completed' : 'failed' });
    expect(store.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: missing.id, status: 'queued', statusLog: expect.arrayContaining([expect.objectContaining({ note: 'service restarted' })]) }),
      expect.objectContaining({ id: complete.id, status: 'done' }), expect.objectContaining({ id: failed.id, status: 'failed' }),
    ]));
  });
  it('drops a stale job id when it requeues, so a later restart finds the new job by its marker', () => {
    const store = new PremiumBacklog(home()), row = store.add(item);
    if ('error' in row) return;
    store.update(row.id, 'running', 'released', { jobId: 'gone', cost: null });
    store.reconcile(id => id === 'gone' ? null : null);
    expect(store.list()[0]).toMatchObject({ status: 'queued' });
    expect(store.list()[0]?.result).toBeUndefined();
    store.update(row.id, 'running', 'releasing');
    store.reconcile((id, itemId) => id === '' && itemId === row.id ? { id: 'fresh', state: 'running' } : null);
    expect(store.list()[0]).toMatchObject({ status: 'running', result: { jobId: 'fresh' } });
  });
  it('records the job when a marker search finds one that already finished', () => {
    const store = new PremiumBacklog(home()), row = store.add(item);
    if ('error' in row) return;
    store.update(row.id, 'running', 'releasing');
    store.reconcile(() => ({ id: 'finished', state: 'completed' }));
    expect(store.list()[0]).toMatchObject({ status: 'done', result: { jobId: 'finished' } });
  });
  it('leaves a lock alone when it was taken over by another holder', () => {
    const target = join(home(), 'items.jsonl');
    withFileLock(target, () => { writeFileSync(`${target}.lock`, `${process.pid + 1}
`); });
    expect(existsSync(`${target}.lock`)).toBe(true);
  });
  it('keeps and relinks every live job state, maps terminal states, and requeues missing jobs', () => {
    const store = new PremiumBacklog(home());
    const states = ['queued', 'running', 'cancel_requested', 'starting', 'completed', 'failed', 'cancelled', 'killed', 'lost'] as const;
    const rows = states.map(state => ({ state, row: store.add({ ...item, task: state }) }));
    const missing = store.add({ ...item, task: 'missing' });
    for (const { state, row } of rows) if (!('error' in row)) store.update(row.id, 'running', 'released', { jobId: state, cost: null });
    if (!('error' in missing)) store.update(missing.id, 'running', 'releasing');
    store.reconcile(id => id ? { id, state: id as typeof states[number], provider: 'xai' } : null);
    for (const { state, row } of rows) if (!('error' in row)) {
      const found = store.list().find(item => item.id === row.id)!;
      if (['completed', 'failed', 'cancelled', 'killed', 'lost'].includes(state)) expect(found.status).toBe(state === 'completed' ? 'done' : state === 'cancelled' ? 'cancelled' : 'failed');
      else expect(found).toMatchObject({ status: 'running', provider: 'xai', result: { jobId: state } });
    }
    if (!('error' in missing)) expect(store.list().find(item => item.id === missing.id)?.status).toBe('queued');
  });
});
