import { LEDGER_STATES, ledgerTerminal } from '@augur/dispatch-protocol';
import type { LedgerChain, LedgerJob, LedgerNode, LedgerQuery, LedgerState, MethodName, Methods } from '@augur/dispatch-protocol';

export const LEDGER_TEXT = {
  session: 'This session', all: 'All jobs', scope: 'Job scope', sessionId: 'Session id',
  loading: 'Loading jobs.', empty: 'No jobs match these filters.', missing: 'This job is no longer available.',
  pick: 'Select a job to see its metadata.', sessionNeeded: 'Enter a session id to view that session.',
  compacted: 'Compacted', reachable: 'Reachable', unreachable: 'Unreachable', never: 'No successful poll',
  next: 'Next page', first: 'First page', refresh: 'Refresh', running: 'Running',
  state: 'State', kind: 'Kind', node: 'Node', origin: 'Origin', route: 'Route', text: 'Search', from: 'Created from', to: 'Created through',
};
export const LEDGER_STATE_LABELS: Record<LedgerState, string> = {
  queued: 'Queued', running: 'Running', stalled: 'Stalled', done: 'Done', failed: 'Failed', canceled: 'Canceled', 'node-lost': 'Node lost',
};

export interface LedgerTransport {
  call<M extends MethodName>(method: M, params?: Methods[M]['params']): Promise<Methods[M]['result']>;
  watch?(since: string, change: (cursor: string) => void, closed: () => void): Promise<{ close(): void }>;
}

export function elapsed(job: LedgerJob, now = Date.now()): number {
  return Math.max(0, job.durationMs ?? ((job.endedAt ?? now) - (job.startedAt ?? job.createdAt)));
}

export function ledgerDuration(job: LedgerJob, now = Date.now()): string {
  const seconds = Math.floor(elapsed(job, now) / 1000);
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

export const ledgerTime = (at: number | null): string => at === null ? '-' : new Date(at).toLocaleString();

export function ledgerFacts(job: LedgerJob, now = Date.now()): Array<[string, string]> {
  const stamp = job.stamp;
  return [
    ['Id', job.id], ['Local id', job.localId], ['State', LEDGER_STATE_LABELS[job.state]], ['Kind', job.kind], ['Node', job.node],
    ['Session', stamp.sessionTitle ?? '-'], ['Session id', stamp.sessionId ?? '-'], ['Session attribution', job.attribution.session],
    ['Origin', stamp.originLabel ?? stamp.origin ?? '-'], ['Origin kind', stamp.origin ?? '-'], ['Origin attribution', job.attribution.origin],
    ['Process', stamp.pid === undefined ? '-' : String(stamp.pid)], ['Parent process', stamp.parentPid === undefined ? '-' : String(stamp.parentPid)], ['Process attribution', job.attribution.process],
    ['Host', stamp.host ?? '-'], ['Host attribution', job.attribution.host], ['Summary', job.summary || '-'], ['Summary source', job.summarySource],
    ['Live activity', !ledgerTerminal(job.state) ? job.activityLine ?? '-' : '-'], ['Activity', job.activity], ['Route', job.route ?? '-'], ['Model', job.model ?? '-'],
    ['Created', ledgerTime(job.createdAt)], ['Started', ledgerTime(job.startedAt)], ['Running time', ledgerDuration(job, now)], ['Ended', ledgerTime(job.endedAt)],
    ['Duration', job.durationMs === null ? '-' : ledgerDuration(job, now)], ['Updated', ledgerTime(job.updatedAt)], ['Last activity', ledgerTime(job.lastActivityAt)],
    ['Input tokens', job.usage?.inputTokens === undefined ? '-' : String(job.usage.inputTokens)], ['Output tokens', job.usage?.outputTokens === undefined ? '-' : String(job.usage.outputTokens)],
    ['Cost (USD)', job.usage?.costUsd === undefined ? '-' : String(job.usage.costUsd)], ['Exit reason', job.exitReason ?? '-'],
    ['Parent', job.parentId ?? '-'], ['Retry of', job.retryOf ?? '-'], ['Retried as', job.retriedAs ?? '-'], ['Compacted', job.compacted ? 'Yes' : 'No'],
  ];
}

export class LedgerModel {
  jobs: LedgerJob[] | null = null;
  nodes: LedgerNode[] = [];
  counts = Object.fromEntries(LEDGER_STATES.map(state => [state, 0])) as Record<LedgerState, number>;
  filters: LedgerQuery = {};
  scope: 'session' | 'all';
  session: string;
  selected: string | null = null;
  detail: LedgerChain | null = null;
  next: string | null = null;
  page: string | undefined;
  error = '';
  detailError = '';
  loading = false;
  cursor = '0';
  private revision = 0;
  private watcher: { close(): void } | null = null;
  private watching = false;
  private active = false;
  private polling = false;
  private watchEpoch = 0;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(session = '', private changed = () => {}) {
    this.session = session;
    this.scope = session ? 'session' : 'all';
  }

  query(): LedgerQuery {
    const query = { ...this.filters, ...(this.scope === 'session' ? { session: this.session } : {}), limit: 50 };
    return this.page ? { ...query, page: this.page } : query;
  }

  setScope(scope: 'session' | 'all'): void { this.scope = scope; this.reset(); }
  setFilter(key: keyof LedgerQuery, value: unknown): void {
    if (value === '' || value === undefined) delete this.filters[key];
    else Object.assign(this.filters, { [key]: value });
    this.reset();
  }
  reset(): void { this.page = undefined; this.next = null; this.jobs = null; this.revision++; }
  nextPage(): void { if (this.next) { this.page = this.next; this.revision++; } }

  async refresh(transport: LedgerTransport): Promise<void> {
    const revision = ++this.revision, query = this.query();
    if (this.scope === 'session' && !this.session) { this.jobs = []; this.error = LEDGER_TEXT.sessionNeeded; this.loading = false; this.changed(); return; }
    this.loading = true;
    try {
      const [page, counts, nodes] = await Promise.all([
        transport.call('ledger_list', query), transport.call('ledger_counts', { ...query, page: undefined }), transport.call('ledger_nodes'),
      ]);
      if (revision !== this.revision) return;
      this.jobs = page.jobs; this.next = page.next; this.counts = counts; this.nodes = nodes; this.error = '';
      if (this.selected) await this.open(this.selected, transport);
    } catch (e) { if (revision === this.revision) this.error = (e as Error).message; }
    finally { if (revision === this.revision) { this.loading = false; this.changed(); } }
  }

  async open(id: string, transport: LedgerTransport): Promise<void> {
    if (this.selected !== id) this.detail = null;
    this.selected = id; this.detailError = '';
    try {
      const detail = await transport.call('ledger_get', { id });
      if (this.selected === id) { this.detail = detail; this.detailError = detail ? '' : LEDGER_TEXT.missing; }
    } catch (e) { if (this.selected === id) this.detailError = (e as Error).message; }
    this.changed();
  }
  closeDetail(): void { this.selected = null; this.detail = null; this.detailError = ''; }

  async start(transport: LedgerTransport): Promise<void> {
    this.active = true;
    await this.refresh(transport);
    await this.poll(transport);
  }

  async poll(transport: LedgerTransport): Promise<void> {
    if (this.polling || !this.active) return;
    this.polling = true;
    try {
      if (transport.watch && !this.watcher && !this.watching) {
        this.watching = true;
        try {
          const epoch = ++this.watchEpoch;
          let ended = false;
          const watcher = await transport.watch(this.cursor, cursor => {
            if (epoch !== this.watchEpoch || !this.active) return;
            this.cursor = cursor;
            if (this.changeTimer === null) this.changeTimer = setTimeout(() => { this.changeTimer = null; if (this.active) void this.refresh(transport); }, 50);
          }, () => { ended = true; if (epoch === this.watchEpoch) this.watcher = null; });
          if (this.active && !ended && epoch === this.watchEpoch) this.watcher = watcher; else watcher.close();
        } catch { this.watcher = null; }
        finally { this.watching = false; }
      }
      if (!this.watcher) {
        let more = true;
        for (let pages = 0; more && pages < 10; pages++) {
          const result = await transport.call('ledger_changes', { since: this.cursor, limit: 1000 });
          this.cursor = result.cursor; more = result.more;
        }
      }
      if (this.active) await this.refresh(transport);
    } catch (e) { this.error = (e as Error).message; this.changed(); }
    finally { this.polling = false; }
  }

  stop(): void {
    this.active = false; this.watchEpoch++; this.watcher?.close(); this.watcher = null; this.revision++; this.loading = false;
    if (this.changeTimer !== null) { clearTimeout(this.changeTimer); this.changeTimer = null; }
  }
}
