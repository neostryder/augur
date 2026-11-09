import { describe, expect, it } from 'vitest';
import type { JobsLiveRow, JobsLiveSnapshot } from '@augur/dispatch-protocol';
import { JOBS_CARD_TEXT, jobCard, jobsCards } from '../src/jobs-cards.js';

const NOW = 180000;
const job = (over: Partial<JobsLiveRow> = {}): JobsLiveRow => ({
  id: 'a', route: 'local', activity: 'research', state: 'running', startedAt: 60000, createdAt: 50000,
  lastActivityAt: 90000, activityLine: 'Output activity', stalled: false,
  origin: { kind: 'cli', label: 'Terminal', sessionId: 's', sessionTitle: 'Review', host: 'desktop', pid: 42 }, ...over,
});
const snapshot = (jobs: JobsLiveRow[] = [], recent: JobsLiveRow[] = []): JobsLiveSnapshot => ({ updatedAt: NOW, stallMinutes: 10, jobs, recent });

describe('shared job cards', () => {
  it('filters both lists by session without changing the snapshot', () => {
    const feed = snapshot([job(), job({ id: 'other', origin: { sessionId: 'other' } })], [job({ id: 'closed', state: 'completed', endedAt: 170000 })]);
    const cards = jobsCards(feed, { now: NOW, scope: 'session', sessionId: 's', expanded: true });
    expect(cards.live.map(card => card.id)).toEqual(['a']);
    expect(cards.recent.map(card => card.id)).toEqual(['closed']);
    expect(cards.expanded).toBe(true);
    expect(feed.jobs).toHaveLength(2);
    expect(jobsCards(feed, { now: NOW, scope: 'all', sessionId: 's' }).live).toHaveLength(2);
    expect(jobsCards(feed, { now: NOW, scope: 'session' }).live).toHaveLength(2);
  });

  it('sorts the closed jobs before limiting them to the latest 30', () => {
    const recent = Array.from({ length: 35 }, (_, i) => job({ id: String(i), state: 'completed', endedAt: i * 1000 }));
    const cards = jobsCards(snapshot([], recent), { now: NOW });
    expect(cards.recent).toHaveLength(30);
    expect(cards.recent[0]!.id).toBe('34');
    expect(cards.recent.at(-1)!.id).toBe('5');
    expect(cards.closedHeading).toBe('Closed (30)');
    expect(cards.expanded).toBe(false);
    expect(recent[0]!.id).toBe('0');
  });

  it('puts stalled jobs first and keeps state and timing on their own line', () => {
    const cards = jobsCards(snapshot([job({ id: 'new', startedAt: 170000 }), job({ id: 'stalled', stalled: true })]), { now: NOW });
    expect(cards.live.map(card => card.id)).toEqual(['stalled', 'new']);
    expect(cards.live[0]!.stalled).toBe(true);
    expect(cards.live[0]!.lines.map(line => line.label)).toEqual(['ORIGIN:', 'JOB:', 'TIMING:', 'ACTIVITY:']);
    expect(cards.live[0]!.lines[2]!.text).toBe('running | STALLED | started 2m ago | elapsed 2m 0s');
    expect(cards.live[0]!.short).toBe('Review | local | 2m 0s');
  });

  it('shows exit reasons and usage separately, including zero values', () => {
    const card = jobCard(job({ state: 'failed', endedAt: 120000, exitCode: 1, reason: 'Route refused: data tier', model: 'local', tools: 'read', dataTier: 'public', depth: 0, parentJobId: 'parent', usage: { inputTokens: 12345, outputTokens: 0, costUsd: 0 } }), NOW, true);
    expect(card.lines.map(line => line.label)).toEqual(['ORIGIN:', 'JOB:', 'TIMING:', 'RESULT:', 'USAGE:']);
    expect(card.lines[1]!.text).toContain('tools read | data public | depth 0 | child of parent');
    expect(card.lines[2]!.text).toContain('ended 1m ago | took 1m 0s');
    expect(card.lines[3]!.text).toBe('exit 1 | Route refused: data tier');
    expect(card.lines[4]!.text).toBe('12.3k in / 0 out | $0.0000');
    expect(jobCard(job({ usage: { inputTokens: 1, outputTokens: 2, costUsd: null } }), NOW).lines.at(-1)!.text).toBe('1 in / 2 out');
  });

  it('uses plain fallback labels and shared empty text', () => {
    expect(jobCard(job({ origin: undefined }), NOW).lines[0]!.text).toBe('no session | unknown origin');
    expect(jobCard(job({ origin: { label: 'Terminal' } }), NOW).short).toBe('Terminal | local | 2m 0s');
    expect(jobCard(job({ origin: { label: 'Terminal' } }), NOW).lines[0]!.text).toBe('Terminal');
    expect(jobCard(job({ origin: { sessionId: 'abcdefgh123' } }), NOW).lines[0]!.text).toBe('session abcdefgh | unknown origin');
    expect(jobsCards(snapshot(), { now: NOW }).empty).toBe(JOBS_CARD_TEXT.empty);
    expect(jobsCards(snapshot(), { now: NOW, scope: 'session', sessionId: 's' }).empty).toBe(JOBS_CARD_TEXT.emptyScope);
    expect(jobsCards(snapshot(), { now: NOW }).noClosed).toBe(JOBS_CARD_TEXT.noClosed);
    expect(jobCard(job(), NOW, true).lines.at(-1)!.text).toBe(JOBS_CARD_TEXT.noDetails);
  });

  it('keeps recent jobs when a snapshot is stale', () => {
    const feed = { ...snapshot([job()], [job({ state: 'completed' })]), updatedAt: NOW - 60001 };
    const cards = jobsCards(feed, { now: NOW });
    expect(cards.live).toEqual([]);
    expect(cards.recent).toHaveLength(1);
  });
});
