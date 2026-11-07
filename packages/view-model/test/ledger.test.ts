import { describe, expect, it, vi } from 'vitest';
import type { LedgerJob, LedgerQuery } from '@augur/dispatch-protocol';
import { LedgerModel, elapsed, ledgerDuration, ledgerFacts, type LedgerTransport } from '../src/ledger.js';

const job = (over: Partial<LedgerJob> = {}): LedgerJob => ({ id: 'node:1', node: 'node', localId: '1', kind: 'llm-request', state: 'running', stamp: { sessionId: 's' }, attribution: { session: 'stamped', origin: 'unknown', process: 'unknown', host: 'unknown' }, summary: 'Read notes', summarySource: 'caller', route: 'local', model: null, activity: 'research', createdAt: 0, startedAt: 1000, endedAt: null, durationMs: null, updatedAt: 1000, lastActivityAt: 1000, parentId: null, retryOf: null, retriedAs: null, usage: null, exitReason: null, compacted: false, ...over });
function transport() {
  const queries: LedgerQuery[] = [];
  const call = vi.fn(async (method: string, params?: LedgerQuery): Promise<unknown> => {
    if (method === 'ledger_list') { queries.push(params!); return { jobs: [job()], next: 'page-2' }; }
    if (method === 'ledger_counts') return { running: 1 };
    if (method === 'ledger_get') return { job: job(), parent: null, children: [], retries: [] };
    if (method === 'ledger_changes') return { changes: [], cursor: '7', more: false };
    return [];
  });
  return { api: { call } as unknown as LedgerTransport, call, queries };
}

describe('the shared ledger view', () => {
  it('defaults to the known session, switches scope, and forwards every filter', async () => {
    const model = new LedgerModel('s'), t = transport();
    await model.refresh(t.api);
    expect(t.queries.at(-1)).toEqual({ session: 's', limit: 50 });
    model.setScope('all');
    for (const [key, value] of Object.entries({ state: ['failed'], kind: ['download'], node: 'n', origin: 'cli', route: 'r', session: 'other', from: 10, to: 20, text: 'notes' })) model.setFilter(key as keyof LedgerQuery, value);
    await model.refresh(t.api);
    expect(t.queries.at(-1)).toEqual({ state: ['failed'], kind: ['download'], node: 'n', origin: 'cli', route: 'r', session: 'other', from: 10, to: 20, text: 'notes', limit: 50 });
    model.setFilter('text', ''); expect(model.query()).not.toHaveProperty('text');
    model.setScope('session'); expect(model.query().session).toBe('s');
  });

  it('requires an explicit session instead of exposing all jobs for an empty scope', async () => {
    const model = new LedgerModel(), t = transport();
    expect(model.scope).toBe('all'); model.setScope('session');
    await model.refresh(t.api);
    expect(model.jobs).toEqual([]); expect(model.error).toContain('session id'); expect(t.call).not.toHaveBeenCalled();
  });

  it('keeps filters while paging and resets the cursor when filters change', async () => {
    const model = new LedgerModel(), t = transport();
    model.setFilter('node', 'n'); await model.refresh(t.api); model.nextPage(); await model.refresh(t.api);
    expect(t.queries.at(-1)).toEqual({ node: 'n', limit: 50, page: 'page-2' });
    model.setFilter('state', ['stalled']); expect(model.page).toBeUndefined(); expect(model.next).toBeNull();
  });

  it('updates elapsed time from creation or start and freezes completed durations', () => {
    expect(elapsed(job(), 66000)).toBe(65000); expect(ledgerDuration(job(), 66000)).toBe('1m 5s');
    expect(elapsed(job({ startedAt: null }), 1000)).toBe(1000);
    expect(elapsed(job({ startedAt: 0 }), 1000)).toBe(1000);
    expect(ledgerDuration(job({ state: 'done', endedAt: 4000, durationMs: 3000 }), 999999)).toBe('3s');
    expect(elapsed(job(), 0)).toBe(0);
    expect(ledgerFacts(job({ compacted: true, stamp: { pid: 12 } }), 66000)).toContainEqual(['Compacted', 'Yes']);
  });

  it('polls browser changes from the last cursor and retains data through a failure', async () => {
    const model = new LedgerModel(), t = transport(); await model.start(t.api);
    expect(model.cursor).toBe('7');
    t.call.mockRejectedValueOnce(new Error('disconnected')); await model.poll(t.api);
    expect(model.error).toBe('disconnected'); expect(model.jobs).toHaveLength(1);
    await model.poll(t.api); expect(model.error).toBe('');
    expect(t.call).toHaveBeenCalledWith('ledger_changes', { since: '7', limit: 1000 }); model.stop();
  });

  it('reconnects a pipe watch from its processed cursor and closes it on exit', async () => {
    const model = new LedgerModel(), t = transport();
    let change!: (cursor: string) => void, closed!: () => void;
    const close = vi.fn(), watch = vi.fn(async (_since, onChange, onClose) => { change = onChange; closed = onClose; return { close }; });
    t.api.watch = watch;
    await model.start(t.api); change('42'); closed(); await model.poll(t.api);
    expect(watch.mock.calls.map(call => call[0])).toEqual(['0', '42']);
    model.stop(); expect(close).toHaveBeenCalledOnce();
  });

  it('falls back to polling when a pipe watch cannot connect', async () => {
    const model = new LedgerModel(), t = transport(); t.api.watch = async () => { throw new Error('offline'); };
    await model.start(t.api); expect(model.cursor).toBe('7'); expect(model.error).toBe(''); model.stop();
  });

  it('discards an old query result after scope changes', async () => {
    const model = new LedgerModel('s'), t = transport();
    let resolve!: (value: unknown) => void;
    t.call.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = model.refresh(t.api); model.setScope('all'); await model.refresh(t.api);
    resolve({ jobs: [job({ id: 'old:1' })], next: null }); await pending;
    expect(model.jobs?.[0]?.id).toBe('node:1');
  });

  it('shows missing detail and rejects stale detail replies after closing', async () => {
    const model = new LedgerModel(), t = transport();
    t.call.mockResolvedValueOnce(null); await model.open('missing:1', t.api); expect(model.detailError).toContain('no longer');
    let resolve!: (value: unknown) => void; t.call.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = model.open('node:1', t.api); model.closeDetail(); resolve({ job: job() }); await pending;
    expect(model.detail).toBeNull(); expect(model.selected).toBeNull();
  });
});
