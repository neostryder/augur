import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LedgerJob, LedgerMetadata, NodeJobPage } from '@augur/dispatch-protocol';
import { Store } from '../src/store.js';
import { JobLedger, MemoryAlertSink } from '../src/job-ledger.js';
import { JobPoller } from '../src/job-poller.js';
import { inferStamp, pipePeer, readPipePeer, readProcess } from '../src/job-stamp.js';
import { fillJobSummary, LocalJobSummarizer } from '../src/job-summary.js';
import { cogitatorHeaders } from '../src/adapters/api.js';
import { stampFromHeaders } from '@augur/dispatch-protocol';
import { makeEnv, request, ROUTES } from './harness.js';
import { Supervisor } from '../src/supervisor.js';
import { enabledAdapters } from '../src/adapters/index.js';
import type { PolicyFile } from '@augur/core';

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); vi.useRealTimers(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'augur-ledger-')), store = new Store(dir);
  cleanup.push(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, ledger: store.ledger };
}
/** A job that failed `ago` milliseconds before now. */
function failedAgo(localId: string, ago: number): LedgerJob {
  const end = Date.now() - ago;
  return job(localId, { state: 'failed', createdAt: end - 11, startedAt: end - 10, endedAt: end, durationMs: 10, updatedAt: end, lastActivityAt: end });
}
function job(localId = '1', over: Partial<LedgerJob> = {}): LedgerJob {
  return { id: `eru:${localId}`, node: 'eru', localId, kind: 'llm-request', state: 'running', stamp: { sessionId: 'session-1', sessionTitle: 'Review', origin: 'cli' }, attribution: { session: 'stamped', origin: 'stamped', process: 'unknown', host: 'unknown' }, summary: 'Review notes', summarySource: 'caller', route: 'local', model: 'summarize', activity: 'summarize', createdAt: 1, startedAt: 2, endedAt: null, durationMs: null, updatedAt: 2, lastActivityAt: 2, parentId: null, retryOf: null, retriedAs: null, usage: null, exitReason: null, compacted: false, ...over };
}
const page = (jobs: LedgerJob[], since = 0, more = false): NodeJobPage => ({ version: 1, node: 'eru', events: jobs.map((job, i) => ({ seq: String(since + i + 1), at: 10, job })), next: String(since + jobs.length), more });
const meta = (): LedgerMetadata => ({ stamp: {}, attribution: { session: 'unknown', origin: 'unknown', process: 'unknown', host: 'unknown' }, summary: '', summarySource: 'none', model: null, compacted: false });
function insert(store: Store, id = 'local') {
  store.insert({ id, route: 'route', adapter: 'exec', activity: 'research', dataTier: 'public', tools: 'none', output: 'text_only', cwd: '/work', createdAt: 1, rootJobId: id, parentJobId: null, depth: 0, caller: { kind: 'cli' }, named: false, expectFile: null, timeoutS: null, harnessVersion: null, workspace: null });
}

describe('the durable ledger', () => {
  it('exposes the stored failure reason as one line capped at 300 characters', () => {
    const { store, ledger } = fixture(); insert(store);
    const reason = 'copying the working directory failed: permission denied';
    store.transition('local', 'failed', { reason: reason + '\n' + 'x'.repeat(400) }, 12);
    const failureReason = (reason + ' ' + 'x'.repeat(400)).slice(0, 300);
    expect(ledger.get('local')?.job).toMatchObject({ state: 'failed', exitReason: 'failed', failureReason, startedAt: null });
    expect(ledger.list().jobs[0]?.failureReason).toBe(failureReason);
    expect(ledger.changes().changes.at(-1)?.job.failureReason).toBe(failureReason);
    insert(store, 'without-reason'); store.transition('without-reason', 'failed', {}, 12);
    expect(ledger.get('without-reason')?.job).not.toHaveProperty('failureReason');
  });

  it('migrates and persists node gaps and stale job overlays across a restart', () => {
    const { dir, store, ledger } = fixture();
    ledger.ingest('eru', page([job()]));
    store.db.exec('alter table ledger_nodes drop column gap');
    const migrated = new JobLedger(store.db, { get: id => store.get(id), all: () => store.list({ limit: 1000 }) });
    expect(migrated.nodes()[0]!.gap).toBeNull();
    const gap = { at: 1000, from: '1', to: '10', retentionDays: 7 };
    migrated.recoverGap('eru', gap); migrated.close(); store.close();
    const reopened = new Store(dir); cleanup.push(() => reopened.close());
    expect(reopened.ledger.nodes()[0]).toMatchObject({ cursor: '10', gap, unreachableSince: null });
    reopened.ledger.ingest('eru', page([], 10));
    expect(reopened.ledger.get('eru:1')?.job.state).toBe('node-lost');
    expect(reopened.ledger.nodes()[0]!.gap).toEqual(gap);
  });
  it('migrates node poll times and retains the successful time during an outage', () => {
    const { store, ledger } = fixture();
    ledger.ingest('eru', page([job()]));
    const lastSeen = ledger.nodes()[0]!.lastSeenAt;
    ledger.unreachable('eru');
    expect(ledger.nodes()[0]!.lastPollAt).toBeGreaterThanOrEqual(lastSeen!);
    expect(ledger.nodes()[0]!.lastSeenAt).toBe(lastSeen);
    store.db.exec('alter table ledger_nodes drop column last_poll_at');
    const migrated = new JobLedger(store.db, { get: id => store.get(id), all: () => store.list({ limit: 1000 }) });
    expect(migrated.nodes()[0]!.lastPollAt).toBeNull(); migrated.close();
  });
  it('projects existing jobs, transitions, usage, retries, and new metadata without a second local job table', () => {
    const { store, ledger } = fixture();
    insert(store); insert(store, 'next');
    ledger.setLocalMetadata('local', { ...meta(), stamp: { sessionId: 's' }, summary: 'Read notes', summarySource: 'caller' });
    expect(ledger.list({ session: 's' }).jobs[0]).toMatchObject({ id: `${ledger.node}:local`, state: 'queued' });
    store.transition('local', 'running', { startedAt: 2 }, 2);
    store.setUsage('local', { source: 'reported', inputTokens: 2, outputTokens: 3 });
    store.transition('local', 'failed', { endedAt: 12 }, 12); store.linkRetry('local', 'next');
    expect(ledger.get('local')).toEqual(ledger.get(`${ledger.node}:local`));
    expect(ledger.list({ root: 'local', localState: 'failed' }).jobs.map(j => j.localId)).toEqual(['local']);
    expect(ledger.list({ root: `${ledger.node}:local` }).jobs.map(j => j.localId)).toEqual(['local']);
    expect(ledger.counts({ root: 'local', localState: 'failed' }).failed).toBe(1);
    expect(() => ledger.list({ localState: 'invalid' as never })).toThrow();
    expect(() => ledger.list({ root: 1 as never })).toThrow();
    expect(ledger.get(`${ledger.node}:local`)).toMatchObject({ job: { state: 'failed', durationMs: 10, usage: { outputTokens: 3 } }, retries: [{ localId: 'next' }] });
  });
  it('replays a node batch idempotently, rejects gaps and terminal regression, and rolls a failed batch back', () => {
    const { ledger } = fixture(), batch = page([job()]);
    ledger.ingest('eru', batch); const before = ledger.changes(); ledger.ingest('eru', batch);
    expect(ledger.changes()).toEqual(before); expect(ledger.list().jobs).toHaveLength(1);
    expect(() => ledger.ingest('eru', page([job('2')], 2))).toThrow(/gap/);
    ledger.ingest('eru', page([job('1', { state: 'done', endedAt: 12, durationMs: 10 })], 1));
    expect(() => ledger.ingest('eru', page([job('2'), job()], 2))).toThrow(/transition/);
    expect(ledger.cursor('eru')).toBe('2'); expect(ledger.get('eru:2')).toBeNull();
    expect(ledger.get('eru:1')?.job.state).toBe('done');
    ledger.ingest('eru', batch);
    expect(ledger.cursor('eru')).toBe('2');
    expect(() => ledger.ingest('eru', page([], 3))).toThrow(/gap/);
  });
  it('marks active jobs node-lost while keeping terminal jobs and the cursor, and recovers without an event', () => {
    const { ledger } = fixture();
    ledger.ingest('eru', page([job(), job('2', { state: 'done', endedAt: 3, durationMs: 1 })]));
    ledger.unreachable('eru'); const first = ledger.nodes()[0]!.unreachableSince;
    ledger.unreachable('eru');
    expect(ledger.nodes()[0]).toMatchObject({ cursor: '2', unreachableSince: first });
    expect(ledger.get('eru:1')?.job.state).toBe('node-lost'); expect(ledger.get('eru:2')?.job.state).toBe('done');
    ledger.ingest('eru', page([], 2));
    expect(ledger.get('eru:1')?.job.state).toBe('running'); expect(ledger.nodes()[0]!.unreachableSince).toBeNull();
    expect(ledger.changes().changes.map(c => c.job.state)).toContain('node-lost');
  });
  it('retains identities, cursors, and dirty local changes across a reopen', () => {
    const { dir, store, ledger } = fixture();
    ledger.ingest('eru', page([job()])); insert(store);
    const node = ledger.node; store.close();
    const reopened = new Store(dir); cleanup.push(() => reopened.close());
    expect(reopened.ledger.node).toBe(node); expect(reopened.ledger.cursor('eru')).toBe('1');
    expect(reopened.ledger.list().jobs).toHaveLength(2);
    expect(reopened.ledger.changes().changes.some(c => c.job.localId === 'local')).toBe(true);
  });
  it('compacts each old terminal job atomically, resumes after interruption, and keeps recent and active rows', () => {
    const { store } = fixture();
    let now = 100 * 86400000;
    const ledger = new JobLedger(store.db, { get: id => store.get(id), all: () => store.list() }, () => now);
    ledger.ingest('eru', page([job('1', { state: 'done', endedAt: 12, durationMs: 10, stamp: { sessionId: 's', sessionTitle: 'Title', pid: 10 } }), job('2')]));
    expect(() => ledger.compact(90, () => { throw new Error('interrupted'); })).toThrow('interrupted');
    expect(ledger.get('eru:1')?.job.compacted).toBe(false);
    expect(ledger.compact(90)).toBe(1);
    expect(ledger.get('eru:1')?.job).toMatchObject({ compacted: true, stamp: { sessionId: 's', sessionTitle: 'Title' } });
    expect(ledger.get('eru:1')?.job.stamp.pid).toBeUndefined();
    expect(ledger.changes().changes.filter(c => c.job.id === 'eru:1')).toHaveLength(1);
    expect(ledger.compact(90)).toBe(0); expect(ledger.list().jobs).toHaveLength(2);
    ledger.ingest('eru', page([job('3', { state: 'done', createdAt: now - 10, startedAt: now - 9, endedAt: now - 1, durationMs: 8 })], 2));
    expect(ledger.compact(1)).toBe(0); now += 2 * 86400000; expect(ledger.compact(1)).toBe(1);
    for (const retention of [-1, 1.5, 3651]) expect(() => ledger.compact(retention)).toThrow();
  });
  it('filters and counts every supported field, pages equal timestamps, and rejects incompatible cursors', () => {
    const { ledger } = fixture();
    ledger.ingest('eru', page([job('1'), job('2', { kind: 'download', state: 'queued', stamp: { sessionId: 'other', origin: 'service' }, route: 'download', summary: 'Install model' }), job('3', { parentId: 'eru:1' })]));
    for (const q of [{ session: 'session-1' }, { origin: 'cli' as const }, { kind: ['llm-request' as const] }, { state: ['running' as const] }, { route: 'local' }, { text: 'review' }]) expect(ledger.list(q).jobs).toHaveLength(2);
    expect(ledger.list({ node: 'other' }).jobs).toEqual([]); expect(ledger.list({ from: 2 }).jobs).toEqual([]); expect(ledger.list({ to: 1 }).jobs).toHaveLength(3);
    const first = ledger.list({ limit: 1, order: 'asc' }); const second = ledger.list({ limit: 1, order: 'asc', page: first.next! });
    expect(first.jobs[0]!.id).not.toBe(second.jobs[0]!.id);
    expect(() => ledger.list({ page: first.next!, order: 'desc' })).toThrow(/page/);
    expect(ledger.get('eru:1')?.children.map(j => j.id)).toEqual(['eru:3']);
    expect(ledger.get('eru:3')?.parent?.id).toBe('eru:1');
    expect(ledger.counts({ session: 'session-1' }).running).toBe(2);
    for (const q of [{ limit: 0 }, { state: ['bogus'] }, { sort: 'unknown' }, { from: NaN }, { token: 'private' }]) expect(() => ledger.list(q as never)).toThrow();
  });
  it('never persists request or answer fields or the output-derived live activity line', () => {
    const { dir, store, ledger } = fixture(); insert(store);
    ledger.setLocalMetadata('local', { ...meta(), prompt: 'PRIVATE_PROMPT_SENTINEL' } as LedgerMetadata);
    ledger.refreshLive([{ ...store.get('local')!, activityLine: 'PRIVATE_ANSWER_SENTINEL', lastActivityAt: 4, stalled: true }]);
    expect(ledger.list().jobs[0]!.activityLine).toBe('Output activity');
    expect(JSON.stringify(ledger.list())).not.toContain('PRIVATE_ANSWER_SENTINEL');
    expect(() => ledger.ingest('eru', page([{ ...job(), prompt: 'PRIVATE_PROMPT_SENTINEL' } as LedgerJob]))).toThrow();
    const rows = JSON.stringify(store.db.prepare('select body from ledger_changes').all());
    expect(rows).not.toContain('PRIVATE_');
    store.db.exec('pragma wal_checkpoint(full)');
    for (const name of ['state.db', 'state.db-wal']) expect(readFileSync(join(dir, name)).includes(Buffer.from('PRIVATE_'))).toBe(false);
  });
  it('compacts local execution detail and retains one summary event and its chain links', () => {
    const { store, ledger } = fixture(); insert(store); insert(store, 'retry');
    ledger.setLocalMetadata('local', { ...meta(), stamp: { pid: 5, sessionId: 'session', sessionTitle: 'Title', host: 'host' }, summary: 'Read notes', summarySource: 'caller' });
    store.transition('local', 'running', { startedAt: 2 }, 2); store.transition('local', 'failed', { endedAt: 12, reason: 'detail' }, 12); store.linkRetry('local', 'retry');
    expect(ledger.compact(90)).toBe(1);
    expect(store.get('local')).toMatchObject({ cwd: '', reason: null, ledger: { compacted: true, summary: 'Read notes' } });
    expect(store.events('local')).toEqual([]);
    expect(ledger.get(`${ledger.node}:local`)).toMatchObject({ job: { stamp: { sessionId: 'session', sessionTitle: 'Title' } }, retries: [{ localId: 'retry' }] });
    expect(ledger.changes().changes.filter(change => change.job.localId === 'local')).toHaveLength(1);
  });
  it('keeps node progress transient and leaves jobs running when a sink rejects delivery', async () => {
    const { store, ledger } = fixture();
    ledger.ingest('eru', page([job('1', { state: 'stalled', activityLine: 'PRIVATE_REMOTE_LINE' })]));
    expect(ledger.get('eru:1')?.job.activityLine).toBe('PRIVATE_REMOTE_LINE');
    expect(JSON.stringify(store.db.prepare('select body from ledger_remote').all())).not.toContain('PRIVATE_REMOTE_LINE');
    expect(JSON.stringify(ledger.changes())).not.toContain('PRIVATE_REMOTE_LINE');
    ledger.setSink({ emit: async () => { throw new Error('unavailable'); } });
    expect(ledger.checkAlerts()).toHaveLength(1); await Promise.resolve();
    expect(ledger.get('eru:1')?.job.state).toBe('stalled');
  });
  it('emits deduplicated failure, stall, and route-specific duration alerts after eight completed samples', () => {
    const { ledger } = fixture(), sink = new MemoryAlertSink(); ledger.setSink(sink);
    const samples = Array.from({ length: 8 }, (_, i) => job(String(i), { state: 'done', endedAt: 12, durationMs: 10 }));
    ledger.ingest('eru', page([...samples.slice(0, 7), job('slow'), job('stalled', { state: 'stalled' }), failedAgo('failed', 1000)]));
    expect(ledger.checkAlerts().map(a => a.type).sort()).toEqual(['job.failed', 'job.stalled']);
    ledger.ingest('eru', page([samples[7]!], 10));
    expect(ledger.checkAlerts()).toMatchObject([{ type: 'job.over-usual-time', jobId: 'eru:slow', samples: 8, usualMs: 10 }]);
    expect(ledger.checkAlerts()).toEqual([]); expect(sink.events).toHaveLength(3);
    expect(ledger.alerts()).toEqual(sink.events);
  });
  it('does not alert on failures that ended long ago, such as history read on a first start', () => {
    const { ledger } = fixture();
    ledger.ingest('eru', page([failedAgo('old', 2 * 3600000), failedAgo('recent', 60000)]));
    expect(ledger.checkAlerts().map(a => a.jobId)).toEqual(['eru:recent']);
  });
  it('applies alert switches, the duration multiplier, and the minimum sample count', () => {
    const { ledger } = fixture();
    const settings = { stalled: false, failed: false, overUsualTime: false, usualMultiple: 4, minSamples: 2 };
    ledger.ingest('eru', page([job('sample', { state: 'done', endedAt: 30002, durationMs: 30000 }), job('slow'), job('stalled', { state: 'stalled' }), failedAgo('failed', 1000)]));
    expect(ledger.checkAlerts(settings)).toEqual([]);
    expect(ledger.checkAlerts({ ...settings, overUsualTime: true })).toEqual([]);
    ledger.ingest('eru', page([job('sample2', { state: 'done', endedAt: 30002, durationMs: 30000 })], 4));
    expect(ledger.checkAlerts({ ...settings, overUsualTime: true })).toMatchObject([{ type: 'job.over-usual-time', usualMs: 30000, samples: 2 }]);
    expect(ledger.checkAlerts({ ...settings, failed: true, stalled: true }).map(event => event.type).sort()).toEqual(['job.failed', 'job.stalled']);
  });
});

describe('node polling', () => {
  it('retries an expired cursor at the page budget boundary in the same poll', async () => {
    const { ledger } = fixture();
    let expired = false;
    const request = vi.fn(async (url: string | URL | Request) => {
      const since = Number(new URL(String(url)).searchParams.get('since'));
      if (since === 9) { expired = true; return new Response(JSON.stringify({ error: { code: 'cursor_expired', oldest: '20' } }), { status: 410 }); }
      return new Response(JSON.stringify(page([job(String(since + 1))], since, true)));
    });
    const poller = new JobPoller(ledger, () => [{ node: 'eru', url: 'http://localhost' }], request as typeof fetch);
    await poller.poll(); poller.close();
    expect(expired).toBe(true); expect(request).toHaveBeenCalledTimes(11);
    expect(ledger.nodes()[0]).toMatchObject({ cursor: '21', unreachableSince: null, gap: { from: '9', to: '20' } });
    expect(ledger.get('eru:21')?.job.state).toBe('running');
  });
  it('bounds repeated advancing expiry responses without marking the node unreachable', async () => {
    const { ledger } = fixture();
    const request = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify({ error: { code: 'cursor_expired', oldest: String(Number(new URL(String(url)).searchParams.get('since')) + 1) } }), { status: 410 }));
    const poller = new JobPoller(ledger, () => [{ node: 'eru', url: 'http://localhost' }], request as typeof fetch);
    await poller.poll(); poller.close();
    expect(request).toHaveBeenCalledTimes(10);
    expect(ledger.nodes()[0]).toMatchObject({ cursor: '10', unreachableSince: null, gap: { from: '9', to: '10' } });
  });
  it('recovers expired history immediately, keeps the gap, and settles only jobs with newer events', async () => {
    const { store, ledger } = fixture();
    ledger.ingest('eru', page([job('1', { state: 'stalled' }), job('2'), job('3', { state: 'done', endedAt: 12, durationMs: 10 })]));
    ledger.unreachable('eru');
    const request = vi.fn(async (url: string | URL | Request) => {
      const since = new URL(String(url)).searchParams.get('since');
      if (since === '3') return new Response(JSON.stringify({ error: { code: 'cursor_expired', oldest: '10', retentionDays: 7, prompt: 'PRIVATE_GAP_PROMPT', answer: 'PRIVATE_GAP_ANSWER' } }), { status: 410 });
      expect(ledger.nodes()[0]).toMatchObject({ cursor: '10', unreachableSince: null });
      return new Response(JSON.stringify(page([job('2', { state: 'done', endedAt: 12, durationMs: 10 }), job('4')], 10)));
    });
    const poller = new JobPoller(ledger, () => [{ node: 'eru', url: 'http://localhost' }], request as typeof fetch);
    const before = Date.now(); await poller.poll(); poller.close();
    expect(request).toHaveBeenCalledTimes(2);
    const node = ledger.nodes()[0]!;
    expect(node).toMatchObject({ cursor: '12', unreachableSince: null, gap: { from: '3', to: '10', retentionDays: 7 } });
    expect(node.gap!.at).toBeGreaterThanOrEqual(before); expect(node.gap!.at).toBeLessThanOrEqual(Date.now());
    expect(ledger.get('eru:1')?.job.state).toBe('node-lost');
    expect(ledger.get('eru:2')?.job.state).toBe('done'); expect(ledger.get('eru:3')?.job.state).toBe('done');
    expect(ledger.get('eru:4')?.job.state).toBe('running');
    ledger.ingest('eru', page([], 12));
    expect(ledger.nodes()[0]!.gap).toEqual(node.gap);
    expect(ledger.changes().changes.filter(c => c.job.id === 'eru:1').at(-1)?.job.state).toBe('node-lost');
    expect(ledger.checkAlerts()).toEqual([]);
    expect(JSON.stringify(store.db.prepare('select gap from ledger_nodes').all())).not.toContain('PRIVATE_GAP_');
    expect(JSON.stringify(ledger.changes())).not.toContain('PRIVATE_GAP_');
    ledger.ingest('eru', page([job('1')], 12));
    expect(ledger.get('eru:1')?.job.state).toBe('running');
  });
  it('replaces consecutive gaps and compares full unsigned 64-bit cursors', async () => {
    const { ledger } = fixture();
    ledger.recoverGap('eru', { at: 1, from: '0', to: '9007199254740992' });
    const replies = [
      new Response(JSON.stringify({ error: { code: 'cursor_expired', oldest: '9007199254740993', retentionDays: 7 } }), { status: 410 }),
      new Response(JSON.stringify({ error: { code: 'cursor_expired', oldest: '18446744073709551615', retentionDays: 'invalid' } }), { status: 410 }),
      new Response(JSON.stringify({ ...page([]), next: '18446744073709551615' })),
    ];
    const request = vi.fn(async () => replies.shift()!);
    const poller = new JobPoller(ledger, () => [{ node: 'eru', url: 'http://localhost' }], request as typeof fetch);
    await poller.poll(); poller.close();
    expect(request).toHaveBeenCalledTimes(3);
    expect(ledger.nodes()[0]).toMatchObject({ cursor: '18446744073709551615', unreachableSince: null, gap: { from: '9007199254740993', to: '18446744073709551615' } });
    expect(ledger.nodes()[0]!.gap!.retentionDays).toBeUndefined();
  });
  it.each([
    { error: { code: 'cursor_expired' } },
    ...['bad', '01', '-1', '18446744073709551616', '2', '1', 3, null].map(oldest => ({ error: { code: 'cursor_expired', oldest } })),
    { error: { code: 'future_cursor', oldest: '3' } }, {}, null, 'non-JSON',
  ])('keeps the cursor and marks the node unreachable for an invalid expiry: %j', async body => {
    const { ledger } = fixture(); ledger.ingest('eru', page([job(), job('2')]));
    const request = vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 410 }));
    const poller = new JobPoller(ledger, () => [{ node: 'eru', url: 'http://localhost' }], request as typeof fetch);
    await poller.poll(); poller.close();
    expect(request).toHaveBeenCalledTimes(1);
    expect(ledger.nodes()[0]).toMatchObject({ cursor: '2', gap: null });
    expect(ledger.nodes()[0]!.unreachableSince).not.toBeNull();
  });
  it.each(['future_cursor', 'invalid_cursor'])('keeps HTTP 400 handling for %s', async code => {
    const { ledger } = fixture();
    const poller = new JobPoller(ledger, () => [{ node: 'eru', url: 'http://localhost' }], (async () => new Response(JSON.stringify({ error: { code, oldest: '10' } }), { status: 400 })) as typeof fetch);
    await poller.poll(); poller.close();
    expect(ledger.nodes()[0]).toMatchObject({ cursor: '0', gap: null });
    expect(ledger.nodes()[0]!.unreachableSince).not.toBeNull();
  });
  it('times out and aborts a node request without advancing its cursor', async () => {
    vi.useFakeTimers();
    const { ledger } = fixture();
    const request = vi.fn((_url: unknown, options?: RequestInit) => new Promise<Response>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    const poller = new JobPoller(ledger, () => [{ node: 'eru', url: 'http://127.0.0.1:8470' }], request as typeof fetch);
    const pending = poller.poll(); await vi.advanceTimersByTimeAsync(3000); await pending;
    expect(ledger.cursor('eru')).toBe('0'); expect(ledger.nodes()[0]!.unreachableSince).not.toBeNull();
    expect((request.mock.calls[0]![1]!.signal as AbortSignal).aborted).toBe(true);
    poller.close();
  });
  it('catches up with the persisted cursor, coalesces concurrent refreshes, and recovers after failure', async () => {
    const { ledger } = fixture(); let fail = false;
    const request = vi.fn(async (url: string | URL | Request) => {
      if (fail) throw new Error('offline');
      const since = new URL(String(url)).searchParams.get('since');
      return new Response(JSON.stringify(since === '0' ? page([job()], 0, true) : page([], 1)));
    });
    const poller = new JobPoller(ledger, () => [{ node: 'eru', url: 'http://127.0.0.1:8470' }], request as typeof fetch);
    await Promise.all([poller.poll(), poller.poll()]); expect(request).toHaveBeenCalledTimes(2); expect(ledger.cursor('eru')).toBe('1');
    fail = true; await poller.poll(); expect(ledger.get('eru:1')?.job.state).toBe('node-lost');
    fail = false; await poller.poll(); expect(ledger.get('eru:1')?.job.state).toBe('running');
    poller.close(); await poller.poll(); expect(request).toHaveBeenCalledTimes(4);
  });
  it('does not advance the cursor for malformed replies or redirects', async () => {
    const { ledger } = fixture();
    for (const response of [new Response('invalid'), new Response('{}'), new Response('', { status: 302 })]) {
      const poller = new JobPoller(ledger, () => [{ node: 'eru', url: 'http://localhost' }], (async () => response) as typeof fetch);
      await poller.poll(); expect(ledger.cursor('eru')).toBe('0'); expect(ledger.nodes()[0]!.unreachableSince).not.toBeNull(); poller.close();
    }
  });
});

describe('stamp inference and summary filling', () => {
  it('reads Linux and macOS process metadata and tolerates malformed or denied reads', async () => {
    const probe = { text: vi.fn(async () => '12 (worker (pool)) S 3 0 0'), run: vi.fn(async () => ' 3 /usr/bin/hermes') };
    expect(await readProcess(12, 'linux', probe)).toEqual({ pid: 12, parentPid: 3, name: 'worker (pool)' });
    expect(probe.text).toHaveBeenCalledWith('/proc/12/stat');
    expect(await readProcess(12, 'darwin', probe)).toEqual({ pid: 12, parentPid: 3, name: '/usr/bin/hermes' });
    expect(probe.run).toHaveBeenCalledWith('ps', ['-p', '12', '-o', 'ppid=', '-o', 'comm=']);
    probe.text.mockResolvedValue('invalid'); probe.run.mockResolvedValue('invalid');
    expect(await readProcess(12, 'linux', probe)).toBeNull(); expect(await readProcess(12, 'darwin', probe)).toBeNull();
    probe.text.mockRejectedValue(new Error('denied')); expect(await readProcess(12, 'linux', probe)).toBeNull();
  });
  it('passes the stamp to Cogitator and never waits for a summary before accepting a job', async () => {
    const env = makeEnv({ maxConcurrent: 0 }); cleanup.push(() => env.dispose());
    vi.useFakeTimers();
    const summarize = vi.fn(() => new Promise<string>(() => {}));
    const sup = new Supervisor({
      store: env.store, config: env.config, dir: env.dir, home: env.home, adapters: enabledAdapters(['exec']),
      routes: () => ROUTES, policy: () => JSON.parse(readFileSync(join(env.home, 'policy.json'), 'utf8')) as PolicyFile,
      usage: () => null, summarizer: { summarize }, scopes: () => false,
    });
    const stamp = { sessionId: 'session', summary: 'Read notes', origin: 'cli' as const };
    const req = { ...request({ text: 'private' }, env.root), stamp };
    expect(stampFromHeaders(cogitatorHeaders(req))).toEqual(stamp);
    const result = sup.submit({ ...req, route: 'raw', stamp: { sessionId: 'session' } });
    expect(result).toHaveProperty('id');
    expect(summarize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(750);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(env.store.get((result as { id: string }).id)?.ledger?.summarySource).toBe('none');
  });
  it.skipIf(process.platform !== 'win32')('reads the Windows named-pipe peer pid through the native job host', async () => {
    const pipe = `\\\\.\\pipe\\augur-peer-${process.pid}-${Date.now()}`;
    let accepted: net.Socket | undefined;
    const server = net.createServer(sock => { accepted = sock; });
    await new Promise<void>(resolve => server.listen(pipe, resolve));
    const client = net.connect(pipe);
    await new Promise<void>(resolve => client.on('connect', resolve));
    try {
      while (!accepted) await new Promise(resolve => setTimeout(resolve, 1));
      expect(await readPipePeer(accepted)).toMatchObject({ pid: process.pid });
      expect(await readProcess(process.pid)).toMatchObject({ pid: process.pid, parentPid: process.ppid });
    } finally { client.destroy(); accepted?.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('walks process names without reading command lines or environment values', async () => {
    const read = vi.fn(async (pid: number) => pid === 2 ? { pid, parentPid: 1, name: 'node' } : { pid, parentPid: 0, name: 'claude.exe' });
    expect(await inferStamp({}, { pid: 2 }, read)).toMatchObject({ stamp: { pid: 2, parentPid: 1, origin: 'claude-code' }, attribution: { session: 'unknown', origin: 'inferred', process: 'inferred', host: 'inferred' } });
    const stamped = await inferStamp({ sessionId: 's', origin: 'hermes', pid: 9, host: 'remote' }, { pid: 2 }, read);
    expect(stamped.attribution).toEqual({ session: 'stamped', origin: 'stamped', process: 'stamped', host: 'stamped' });
    expect(stamped.stamp.pid).toBe(9);
  });
  it('degrades to unknown on denied or vanished processes and infers remote peers', async () => {
    const unknown = await inferStamp({}, { pid: 2 }, async () => { throw new Error('denied'); });
    expect(Object.values(unknown.attribution)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    expect(await inferStamp({}, { address: '192.0.2.1', userAgent: 'Hermes' })).toMatchObject({ stamp: { origin: 'hermes', host: '192.0.2.1' }, attribution: { origin: 'inferred', host: 'inferred' } });
    expect(pipePeer({ _handle: { getPeerPid: () => { throw new Error(); } } })).toEqual({});
    expect(await readProcess(-1)).toBeNull(); expect(await readProcess(1, 'unsupported' as NodeJS.Platform)).toBeNull();
  });
  it('bounds a hung summarizer and does not overwrite a caller summary or compacted row', async () => {
    vi.useFakeTimers(); let current = meta(); const patch = vi.fn((m: LedgerMetadata) => { current = m; });
    const hung = fillJobSummary('PRIVATE_PROMPT', { summarize: () => new Promise(() => {}) }, () => current, patch, 25);
    await vi.advanceTimersByTimeAsync(25); await hung; expect(patch).not.toHaveBeenCalled();
    await fillJobSummary('private', { summarize: async () => '  Read\nnotes  ' }, () => current, patch);
    expect(current).toMatchObject({ summary: 'Read notes', summarySource: 'local-model' });
    const summarize = vi.fn(async () => 'other'); await fillJobSummary('private', { summarize }, () => current, patch); expect(summarize).not.toHaveBeenCalled();
    current = { ...meta(), compacted: true }; await fillJobSummary('private', { summarize }, () => current, patch); expect(patch).toHaveBeenCalledTimes(1);
    await fillJobSummary('private', { summarize: async () => { throw new Error(); } }, () => meta(), patch); expect(patch).toHaveBeenCalledTimes(1);
  });
  it('uses a loopback summarize role, refuses redirects, and prevents role forwarding', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Read notes' } }] })));
    const summarizer = new LocalJobSummarizer('http://127.0.0.1:8470', request as typeof fetch);
    expect(await summarizer.summarize('private', new AbortController().signal)).toBe('Read notes');
    expect(request.mock.calls[0]).toBeDefined();
    const options = (request.mock.calls as unknown as Array<[string, RequestInit]>)[0]![1];
    expect(options).toMatchObject({ redirect: 'error', headers: { 'X-Cogitator-Via': 'augur-summary' } });
    expect(JSON.parse(options.body as string).model).toBe('summarize');
    expect(() => new LocalJobSummarizer('http://remote')).toThrow(/loopback/);
  });
});
