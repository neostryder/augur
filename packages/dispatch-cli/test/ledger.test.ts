import { describe, expect, it, vi } from 'vitest';
import type { LedgerWatchHandlers } from '@augur/augurd/client';
import { LEDGER_STATES } from '@augur/dispatch-protocol';
import type { LedgerJob, LedgerState } from '@augur/dispatch-protocol';
import { renderJobs, watchJobs } from '../src/ledger.js';

const job: LedgerJob = {
  id: 'node:work', node: 'node', localId: 'work', state: 'running', kind: 'llm-request', stamp: { sessionTitle: 'Review', origin: 'cli' },
  attribution: { session: 'stamped', origin: 'stamped', process: 'unknown', host: 'unknown' }, summary: 'Read the notes', summarySource: 'caller',
  route: 'route', model: 'local', activity: 'research', createdAt: 0, startedAt: 1000, endedAt: null, updatedAt: 1000, lastActivityAt: 1000,
  durationMs: null, activityLine: 'Reading files', parentId: null, retryOf: null, retriedAs: null, usage: null, exitReason: null, compacted: false,
};
const counts = { ...Object.fromEntries(LEDGER_STATES.map(s => [s, 0])), running: 1 } as Record<LedgerState, number>;

describe('ledger table', () => {
  it.each([40, 80, 120, 160, 240])('keeps records and paging within %i columns', width => {
    const text = renderJobs({ jobs: [job], next: 'a'.repeat(300) }, counts, width, 92000);
    expect(text.split('\n').every(line => Array.from(line).length <= width)).toBe(true);
    for (const value of ['RUNNING', 'llm-request', 'node', 'Review', 'Read the notes', '1m 31s', 'route', 'Reading files', '1 shown, 1 matching.', 'Next page:']) expect(text).toContain(value);
    expect(text).toContain('1970-01-01');
  });
  it('prints completed duration, blank times, empty results, and no terminal activity', () => {
    const text = renderJobs({ jobs: [{ ...job, state: 'done', startedAt: null, endedAt: 2000, durationMs: 2000 }], next: null }, counts, 80, 999999);
    expect(text).toContain('Started -'); expect(text).toContain('2s'); expect(text).not.toContain('Reading files');
    expect(renderJobs({ jobs: [], next: null }, counts)).toContain('No jobs.');
  });
  it('strips terminal controls from caller metadata', () => {
    expect(renderJobs({ jobs: [{ ...job, summary: '\x1b[2J\ntext' }], next: null }, counts, 80)).not.toContain('\x1b');
  });
});

describe('ledger watch', () => {
  it('replays the last cursor after disconnects and stops on cancellation', async () => {
    const stop = new AbortController(), cursors: string[] = [], output: string[] = [];
    const closed = vi.fn();
    let changes = 0;
    const call = vi.fn(async (method: string, params?: { since?: string }) => {
      if (method === 'ledger_changes') { changes++; return { changes: [], cursor: params?.since === '0' ? '7' : params!.since, more: false }; }
      if (method === 'ledger_list') return { jobs: [job], next: null };
      return counts;
    });
    const watch = vi.fn(async (since: string, handlers: LedgerWatchHandlers) => {
      cursors.push(since);
      if (cursors.length === 1) {
        setTimeout(() => { handlers.change({ cursor: '8', at: 2, job }); handlers.closed?.(new Error('restart')); }, 0);
      } else setTimeout(() => stop.abort(), 0);
      return { close: closed };
    });
    await watchJobs({ session: 's' }, { out: text => output.push(text), err: () => {}, signal: stop.signal }, {}, true, { call: call as never, watch: watch as never, retryMs: 1 });
    expect(cursors).toEqual(['7', '8']); expect(changes).toBe(2); expect(closed).toHaveBeenCalledOnce();
    expect(output.length).toBeGreaterThan(0);
    expect(call).toHaveBeenCalledWith('ledger_list', { session: 's' }, {});
  });
  it('retries an unavailable service and restores terminal output after startup', async () => {
    const stop = new AbortController(), err = vi.fn(), out = vi.fn();
    let attempts = 0;
    const call = async (method: string) => {
      if (method === 'ledger_changes') { if (++attempts === 1) throw new Error('offline'); return { changes: [], cursor: '0', more: false }; }
      return method === 'ledger_list' ? { jobs: [], next: null } : counts;
    };
    const watch = async () => { setTimeout(() => stop.abort(), 0); return { close: () => {} }; };
    await watchJobs({}, { out, err, signal: stop.signal, tty: true }, {}, false, { call: call as never, watch, retryMs: 1 });
    expect(attempts).toBe(2); expect(err).toHaveBeenCalledWith('offline\n'); expect(out.mock.calls[0]![0]).toContain('\x1b[H\x1b[2J');
  });
});
