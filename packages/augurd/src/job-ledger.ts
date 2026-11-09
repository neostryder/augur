import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { JOB_STATES, LEDGER_STATES, ORIGIN_KINDS, failureLine, ledgerId, ledgerJobRow, ledgerTerminal, summaryLine, validCursor, validLedgerGap, validLedgerJob, validNodeJobPage } from '@augur/dispatch-protocol';
import type { JobRecord, LedgerAlert, LedgerAlertSettings, LedgerChain, LedgerChange, LedgerGap, LedgerJob, LedgerMetadata, LedgerNode, LedgerPage, LedgerQuery, LedgerState, LedgerWatchPage, NodeJobPage } from '@augur/dispatch-protocol';
import { jobRow } from './jobs-live.js';

export interface AlertSink { emit(event: LedgerAlert): void | Promise<void> }
/** How long after a job ends that its failure still raises an alert. */
export const FAILURE_ALERT_WINDOW_MS = 3600000;

export class NoopAlertSink implements AlertSink { emit(_event: LedgerAlert): void {} }
export class MemoryAlertSink implements AlertSink {
  readonly events: LedgerAlert[] = [];
  emit(event: LedgerAlert): void { this.events.push(structuredClone(event)); }
}

const UNKNOWN = { session: 'unknown', origin: 'unknown', process: 'unknown', host: 'unknown' } as const;
const stateOf = (job: JobRecord): LedgerState => job.state === 'completed' ? 'done'
  : ['failed', 'artifact_validation_failed', 'killed'].includes(job.state) ? 'failed'
  : job.state === 'cancelled' ? 'canceled' : job.state === 'lost' ? 'node-lost'
  : ['running', 'cancel_requested'].includes(job.state) ? 'running' : 'queued';
const metadata = (): LedgerMetadata => ({ stamp: {}, attribution: { ...UNKNOWN }, summary: '', summarySource: 'none', model: null, compacted: false });
const payload = (job: LedgerJob): string => { const { activityLine: _line, ...safe } = job; return JSON.stringify(safe); };
const numberCursor = (v: unknown): string => { if (!validCursor(v)) throw new Error('The ledger cursor is invalid.'); return v; };

export class JobLedger {
  readonly node: string;
  private live = new Map<string, Pick<JobRecord, 'stalled' | 'lastActivityAt' | 'activityLine'>>();
  private remoteLines = new Map<string, string>();
  private titleOf: (sessionId: string | undefined) => string | undefined = () => undefined;
  private sink: AlertSink = new NoopAlertSink();
  private closed = false;
  constructor(private db: DatabaseSync, private local: { get(id: string): JobRecord | null; all(): JobRecord[] }, private now = Date.now) {
    db.exec(`create table if not exists ledger_identity(id integer primary key check(id=1), node text not null);
      create table if not exists ledger_remote(id text primary key, node text not null, version text not null, body text not null);
      create index if not exists ledger_remote_node on ledger_remote(node);
      create table if not exists ledger_nodes(node text primary key, cursor text not null default '0', unreachable_since integer, last_seen_at integer);
      create table if not exists ledger_changes(seq integer primary key autoincrement, at integer not null, job_id text not null, body text not null);
      create index if not exists ledger_changes_job on ledger_changes(job_id,seq);
      create table if not exists ledger_dirty(id text primary key);
      create table if not exists ledger_alerts(id text primary key, body text not null);
      create trigger if not exists ledger_job_insert after insert on jobs begin insert or ignore into ledger_dirty(id) values(new.id); end;
      create trigger if not exists ledger_job_update after update on jobs begin insert or ignore into ledger_dirty(id) values(new.id); end;`);
    if (!(db.prepare('pragma table_info(ledger_nodes)').all() as Array<{ name: string }>).some(column => column.name === 'last_poll_at')) db.exec('alter table ledger_nodes add column last_poll_at integer');
    if (!(db.prepare('pragma table_info(ledger_nodes)').all() as Array<{ name: string }>).some(column => column.name === 'gap')) db.exec('alter table ledger_nodes add column gap text');
    db.prepare('insert or ignore into ledger_identity(id,node) values(1,?)').run(`augur-${randomUUID()}`);
    this.node = (db.prepare('select node from ledger_identity where id=1').get() as { node: string }).node;
    db.exec('insert or ignore into ledger_dirty(id) select id from jobs');
    this.flush();
  }

  close(): void { this.closed = true; this.live.clear(); this.remoteLines.clear(); }
  setSink(sink: AlertSink): void { this.sink = sink; }
  setSessionTitleLookup(titleOf: (sessionId: string | undefined) => string | undefined): void { this.titleOf = titleOf; }

  private transaction<T>(run: () => T): T {
    this.db.exec('begin immediate');
    try { const result = run(); this.db.exec('commit'); return result; }
    catch (error) { this.db.exec('rollback'); throw error; }
  }

  private localJob(job: JobRecord): LedgerJob {
    const meta = job.ledger ?? metadata(), live = this.live.get(job.id), base = stateOf(job);
    // A lost runner has a known end; node-lost is reserved for an unreachable node in the unified view.
    const state = base === 'node-lost' && job.endedAt !== null ? 'failed' : base;
    return {
      id: ledgerId(this.node, job.id), node: this.node, localId: job.id, kind: 'augur-job',
      state: !ledgerTerminal(state) && live?.stalled ? 'stalled' : state,
      stamp: meta.stamp, attribution: meta.attribution, summary: meta.summary, summarySource: meta.summarySource,
      route: job.route, model: job.served?.model ?? meta.model, activity: job.activity,
      createdAt: job.createdAt, startedAt: job.startedAt, endedAt: job.endedAt,
      durationMs: job.endedAt === null ? null : Math.max(0, job.endedAt - (job.startedAt ?? job.createdAt)),
      updatedAt: job.endedAt ?? job.startedAt ?? job.createdAt,
      lastActivityAt: meta.compacted ? null : live?.lastActivityAt ?? job.lastActivityAt ?? job.startedAt,
      ...(!meta.compacted && live?.activityLine ? { activityLine: 'Output activity' } : {}),
      parentId: job.parentJobId ? ledgerId(this.node, job.parentJobId) : null,
      replayOf: job.replayOf ? ledgerId(this.node, job.replayOf) : null,
      retryOf: job.retryOf ? ledgerId(this.node, job.retryOf) : null, retriedAs: job.retriedAs ? ledgerId(this.node, job.retriedAs) : null,
      usage: job.usage, exitReason: ledgerTerminal(state) ? job.state : null, compacted: meta.compacted,
      ...(state === 'failed' && job.reason ? { failureReason: failureLine(job.reason) } : {}),
      ...(state === 'failed' && job.failureCode ? { failureCode: job.failureCode } : {}),
    };
  }

  private append(job: LedgerJob): void {
    const body = payload(job), last = this.db.prepare('select body from ledger_changes where job_id=? order by seq desc limit 1').get(job.id) as { body: string } | undefined;
    if (last?.body === body) return;
    this.db.prepare('insert into ledger_changes(at,job_id,body) values(?,?,?)').run(this.now(), job.id, body);
  }

  flush(): void {
    if (this.closed) return;
    const dirty = this.db.prepare('select id from ledger_dirty').all() as Array<{ id: string }>;
    if (!dirty.length) return;
    this.transaction(() => {
      for (const { id } of dirty) { const job = this.local.get(id); if (job) this.append(this.localJob(job)); this.db.prepare('delete from ledger_dirty where id=?').run(id); }
    });
  }

  setLocalMetadata(id: string, meta: LedgerMetadata): void {
    if (this.closed) return;
    const job = this.local.get(id);
    if (!job) return;
    if (!validLedgerJob({ ...this.localJob(job), stamp: meta.stamp, attribution: meta.attribution, summary: meta.summary, summarySource: meta.summarySource, model: meta.model, compacted: meta.compacted })) throw new Error('The ledger metadata is invalid.');
    const safe: LedgerMetadata = { stamp: meta.stamp, attribution: meta.attribution, summary: meta.summary, summarySource: meta.summarySource, model: meta.model, compacted: meta.compacted };
    this.db.prepare('update jobs set ledger=? where id=?').run(JSON.stringify(safe), id);
    this.flush();
  }

  refreshLive(jobs: JobRecord[]): void {
    if (this.closed) return;
    const before = this.live;
    this.live = new Map(jobs.map(j => [j.id, { stalled: j.stalled, lastActivityAt: j.lastActivityAt, activityLine: j.activityLine }]));
    for (const id of new Set([...before.keys(), ...this.live.keys()])) {
      if (before.get(id)?.stalled !== this.live.get(id)?.stalled || before.get(id)?.lastActivityAt !== this.live.get(id)?.lastActivityAt) {
        const job = this.local.get(id); if (job) this.append(this.localJob(job));
      }
    }
    this.flush();
  }

  private remoteJob(job: LedgerJob): LedgerJob {
    const node = this.nodes().find(n => n.node === job.node);
    const line = this.remoteLines.get(job.id), row = line ? { ...job, activityLine: line } : job;
    const version = node?.gap ? (this.db.prepare('select version from ledger_remote where id=?').get(job.id) as { version: string }).version : null;
    const stale = node?.gap && version !== null && BigInt(version) <= BigInt(node.gap.to);
    return ((node?.unreachableSince !== null && node?.unreachableSince !== undefined) || stale) && !ledgerTerminal(job.state) ? { ...row, state: 'node-lost' } : row;
  }

  private all(): LedgerJob[] {
    this.flush();
    const remote = (this.db.prepare('select body from ledger_remote').all() as Array<{ body: string }>).map(r => this.remoteJob(JSON.parse(r.body) as LedgerJob));
    return [...this.local.all().map(j => this.localJob(j)), ...remote];
  }

  private matches(job: LedgerJob, q: LedgerQuery): boolean {
    const local = job.node === this.node && (q.root !== undefined || q.localState !== undefined) ? this.local.get(job.localId) : null;
    return (q.root === undefined || local?.rootJobId === q.root || (local !== null && `${this.node}:${local.rootJobId}` === q.root))
      && (q.localState === undefined || (local ? local.state === q.localState : job.node !== this.node && LEDGER_STATES.includes(q.localState as LedgerState) && q.state?.includes(job.state) === true))
      && (q.session === undefined || job.stamp.sessionId === q.session) && (q.origin === undefined || job.stamp.origin === q.origin)
      && (q.node === undefined || job.node === q.node) && (q.state === undefined || q.state.includes(job.state))
      && (q.kind === undefined || q.kind.includes(job.kind)) && (q.route === undefined || job.route === q.route)
      && (q.from === undefined || job.createdAt >= q.from) && (q.to === undefined || job.createdAt <= q.to)
      && (q.text === undefined || [job.id, job.summary, job.stamp.sessionTitle, job.stamp.originLabel, job.route, job.model, job.activity].some(x => x?.toLowerCase().includes(q.text!.toLowerCase())));
  }

  list(q: LedgerQuery = {}): LedgerPage {
    this.validateQuery(q);
    const sort = q.sort ?? 'createdAt', direction = q.order === 'asc' ? 1 : -1, limit = q.limit ?? 100;
    const { page: _page, limit: _limit, ...filters } = q;
    const hash = createHash('sha256').update(JSON.stringify(Object.entries(filters).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
    const compare = (a: { value: number; id: string }, b: { value: number; id: string }) => direction * (a.value - b.value || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let after: { value: number; id: string } | null = null;
    if (q.page) {
      try { const p = JSON.parse(Buffer.from(q.page, 'base64url').toString('utf8')); if (p.hash !== hash || typeof p.value !== 'number' || !Number.isFinite(p.value) || typeof p.id !== 'string') throw new Error(); after = p; }
      catch { throw new Error('The ledger page is invalid.'); }
    }
    const key = (j: LedgerJob) => ({ value: j[sort] ?? -1, id: j.id });
    const matching = this.all().filter(j => this.matches(j, q));
    const rows = matching.filter(j => !after || compare(key(j), after) > 0).sort((a, b) => compare(key(a), key(b)));
    const jobs = rows.slice(0, limit), last = jobs.at(-1);
    const cardRow = (job: LedgerJob) => {
      const local = job.node === this.node ? this.local.get(job.localId) : null;
      return local ? { ...jobRow({ ...local, ...this.live.get(local.id) }, this.titleOf), id: job.id, activityLine: job.activityLine ?? '' } : ledgerJobRow(job);
    };
    // Cards include active work and the latest endings even when pagination hides them.
    const cards = {
      updatedAt: this.now(),
      jobs: matching.filter(job => !ledgerTerminal(job.state)).map(cardRow),
      recent: matching.filter(job => ledgerTerminal(job.state)).sort((a, b) => (b.endedAt ?? b.lastActivityAt ?? b.createdAt) - (a.endedAt ?? a.lastActivityAt ?? a.createdAt)).slice(0, 30).map(cardRow),
    };
    return { jobs, next: rows.length > limit && last ? Buffer.from(JSON.stringify({ ...key(last), hash })).toString('base64url') : null, cards };
  }

  private validateQuery(q: LedgerQuery): void {
    if (!q || typeof q !== 'object' || Array.isArray(q) || Object.keys(q).some(k => !['root', 'localState', 'session', 'origin', 'node', 'state', 'kind', 'route', 'from', 'to', 'text', 'sort', 'order', 'limit', 'page'].includes(k))) throw new Error('The ledger query is invalid.');
    if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 1000)) throw new Error('The ledger limit is invalid.');
    for (const key of ['from', 'to'] as const) if (q[key] !== undefined && (!Number.isFinite(q[key]) || q[key]! < 0)) throw new Error('The ledger time range is invalid.');
    if (q.sort !== undefined && !['createdAt', 'startedAt', 'endedAt', 'durationMs'].includes(q.sort)) throw new Error('The ledger sort is invalid.');
    if (q.order !== undefined && !['asc', 'desc'].includes(q.order)) throw new Error('The ledger order is invalid.');
    if (q.localState !== undefined && !JOB_STATES.includes(q.localState)) throw new Error('The local state filter is invalid.');
    for (const key of ['root', 'session', 'origin', 'node', 'route', 'text', 'page'] as const) if (q[key] !== undefined && (typeof q[key] !== 'string' || q[key]!.length > 4096)) throw new Error('The ledger filter is invalid.');
    if (q.origin !== undefined && !ORIGIN_KINDS.includes(q.origin)) throw new Error('The ledger origin filter is invalid.');
    if (q.state !== undefined && (!Array.isArray(q.state) || q.state.some(s => !LEDGER_STATES.includes(s)))) throw new Error('The ledger state filter is invalid.');
    if (q.kind !== undefined && (!Array.isArray(q.kind) || q.kind.some(k => !['augur-job', 'media-job', 'llm-request', 'model-load', 'model-evict', 'install', 'download'].includes(k)))) throw new Error('The ledger kind filter is invalid.');
  }

  get(id: string): LedgerChain | null {
    id = id.includes(':') ? id : ledgerId(this.node, id);
    const rows = this.all(), job = rows.find(j => j.id === id);
    if (!job) return null;
    const neighbors = new Map<string, Set<string>>();
    for (const row of rows) for (const next of [row.retryOf, row.retriedAs]) if (next) {
      if (!neighbors.has(row.id)) neighbors.set(row.id, new Set());
      if (!neighbors.has(next)) neighbors.set(next, new Set());
      neighbors.get(row.id)!.add(next); neighbors.get(next)!.add(row.id);
    }
    const linked = new Set([id]);
    for (const current of linked) for (const next of neighbors.get(current) ?? []) linked.add(next);
    return { job, parent: rows.find(j => j.id === job.parentId) ?? null, children: rows.filter(j => j.parentId === id), retries: rows.filter(j => j.id !== id && linked.has(j.id)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)) };
  }

  counts(q: LedgerQuery = {}): Record<LedgerState, number> {
    this.validateQuery(q);
    const counts = Object.fromEntries(LEDGER_STATES.map(s => [s, 0])) as Record<LedgerState, number>;
    for (const job of this.all()) if (this.matches(job, q)) counts[job.state]++;
    return counts;
  }

  changes(since = '0', limit = 100): LedgerWatchPage {
    numberCursor(since);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('The ledger limit is invalid.');
    this.flush();
    const rows = this.db.prepare('select seq,at,body from ledger_changes where seq>? order by seq limit ?').all(since, limit + 1) as Array<{ seq: number; at: number; body: string }>;
    const changes: LedgerChange[] = rows.slice(0, limit).map(r => ({ cursor: String(r.seq), at: r.at, job: JSON.parse(r.body) as LedgerJob }));
    return { changes, cursor: changes.at(-1)?.cursor ?? since, more: rows.length > limit };
  }

  nodes(): LedgerNode[] {
    return (this.db.prepare('select * from ledger_nodes order by node').all() as Array<{ node: string; cursor: string; unreachable_since: number | null; last_seen_at: number | null; last_poll_at: number | null; gap: string | null }>).map(n => ({ node: n.node, cursor: n.cursor, unreachableSince: n.unreachable_since, lastSeenAt: n.last_seen_at, lastPollAt: n.last_poll_at, gap: n.gap === null ? null : JSON.parse(n.gap) as LedgerGap }));
  }
  cursor(node: string): string { return this.nodes().find(n => n.node === node)?.cursor ?? '0'; }

  recoverGap(node: string, gap: LedgerGap): void {
    if (!validLedgerGap(gap) || gap.from !== this.cursor(node) || node === this.node) throw new Error('The ledger gap is invalid.');
    this.transaction(() => {
      this.db.prepare('insert into ledger_nodes(node,cursor,last_seen_at,last_poll_at,gap) values(?,?,?,?,?) on conflict(node) do update set cursor=excluded.cursor,unreachable_since=null,last_seen_at=excluded.last_seen_at,last_poll_at=excluded.last_poll_at,gap=excluded.gap').run(node, gap.to, gap.at, gap.at, JSON.stringify(gap));
      for (const { body } of this.db.prepare('select body from ledger_remote where node=?').all(node) as Array<{ body: string }>) {
        const job = JSON.parse(body) as LedgerJob;
        this.remoteLines.delete(job.id);
        this.append(this.remoteJob(job));
      }
    });
  }

  unreachable(node: string): void {
    this.transaction(() => {
      this.db.prepare('insert into ledger_nodes(node,unreachable_since,last_poll_at) values(?,?,?) on conflict(node) do update set unreachable_since=coalesce(unreachable_since,excluded.unreachable_since),last_poll_at=excluded.last_poll_at').run(node, this.now(), this.now());
      for (const { body } of this.db.prepare('select body from ledger_remote where node=?').all(node) as Array<{ body: string }>) this.append(this.remoteJob(JSON.parse(body) as LedgerJob));
    });
  }

  ingest(node: string, raw: unknown): void {
    if (!validNodeJobPage(raw) || raw.node !== node || node === this.node) throw new Error('The node job page is invalid.');
    const page: NodeJobPage = raw, cursor = this.cursor(node);
    if (BigInt(page.next) < BigInt(cursor)) return;
    if ((!page.events.length && page.next !== cursor) || (page.events.length && BigInt(page.events[0]!.seq) > BigInt(cursor) + 1n)) throw new Error('Node job cursor has a gap.');
    this.transaction(() => {
      this.db.prepare('insert into ledger_nodes(node,cursor,last_seen_at,last_poll_at) values(?,?,?,?) on conflict(node) do update set cursor=excluded.cursor,unreachable_since=null,last_seen_at=excluded.last_seen_at,last_poll_at=excluded.last_poll_at').run(node, page.next, this.now(), this.now());
      for (const event of page.events) {
        if (BigInt(event.seq) <= BigInt(cursor)) continue;
        const previous = this.db.prepare('select version,body from ledger_remote where id=?').get(event.job.id) as { version: string; body: string } | undefined;
        if (previous && BigInt(previous.version) >= BigInt(event.seq)) continue;
        if (previous) {
          const job = JSON.parse(previous.body) as LedgerJob;
          if (job.kind !== event.job.kind || job.createdAt !== event.job.createdAt || (ledgerTerminal(job.state) && job.state !== event.job.state) || (job.state !== 'queued' && event.job.state === 'queued')) throw new Error('The ledger state transition is invalid.');
        }
        this.db.prepare('insert into ledger_remote(id,node,version,body) values(?,?,?,?) on conflict(id) do update set version=excluded.version,body=excluded.body').run(event.job.id, node, event.seq, payload(event.job));
        this.append(event.job);
      }
      for (const { body } of this.db.prepare('select body from ledger_remote where node=?').all(node) as Array<{ body: string }>) this.append(this.remoteJob(JSON.parse(body) as LedgerJob));
    });
    for (const event of page.events) if (BigInt(event.seq) > BigInt(cursor)) {
      if (event.job.activityLine && !ledgerTerminal(event.job.state)) this.remoteLines.set(event.job.id, event.job.activityLine);
      else this.remoteLines.delete(event.job.id);
    }
  }

  compact(retentionDays: number, interrupt?: () => void): number {
    if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650) throw new Error('The ledger retention is invalid.');
    const cutoff = this.now() - retentionDays * 86400000;
    let count = 0;
    for (const job of this.all()) {
      if (job.compacted || job.endedAt === null || job.endedAt >= cutoff || !ledgerTerminal(job.state)) continue;
      this.transaction(() => {
        const stamp = { sessionId: job.stamp.sessionId, sessionTitle: job.stamp.sessionTitle, origin: job.stamp.origin, originLabel: job.stamp.originLabel };
        const trimmed = Object.fromEntries(Object.entries(stamp).filter(([, v]) => v !== undefined));
        const attribution = { ...job.attribution, process: 'unknown' as const, host: 'unknown' as const };
        const row: LedgerJob = { ...job, stamp: trimmed, attribution, compacted: true, lastActivityAt: null };
        delete row.activityLine;
        if (job.node === this.node) {
          const meta: LedgerMetadata = { stamp: trimmed, attribution, summary: job.summary, summarySource: job.summarySource, model: job.model, compacted: true };
          const old = this.local.get(job.localId)!;
          const caller = { kind: old.caller.kind, ...(trimmed.sessionId ? { session: trimmed.sessionId } : {}), ...(trimmed.originLabel ? { label: trimmed.originLabel } : {}) };
          this.db.prepare(`update jobs set ledger=?,caller=?,cwd='',harness_version=null,warnings=null,runner_pid=null,child_pid=null,
            expect_file=null,timeout_s=null,workspace=null,patch_path=null,changed_files=null,prompt_chars=null,answer_chars=null,
            charter=null,charter_chars=null,charter_notes=null,ambient=null,conversation=null,conversation_turn=null,served=null,reason=null where id=?`).run(JSON.stringify(meta), JSON.stringify(caller), job.localId);
          this.db.prepare('delete from events where job_id=?').run(job.localId);
          this.db.prepare('delete from ledger_dirty where id=?').run(job.localId);
        } else this.db.prepare('update ledger_remote set body=? where id=?').run(payload(row), job.id);
        this.db.prepare('delete from ledger_changes where job_id=?').run(job.id);
        interrupt?.();
        this.append(row);
      });
      count++;
    }
    return count;
  }

  checkAlerts(settings: Pick<LedgerAlertSettings, 'stalled' | 'failed' | 'overUsualTime' | 'usualMultiple' | 'minSamples'> = { stalled: true, failed: true, overUsualTime: true, usualMultiple: 3, minSamples: 8 }): LedgerAlert[] {
    const jobs = this.all(), emitted: LedgerAlert[] = [];
    const histories = new Map<string, number[]>();
    const historyKey = (job: LedgerJob) => JSON.stringify([job.node, job.kind, job.route]);
    for (const job of jobs) if (job.route && job.state === 'done' && job.durationMs !== null) {
      const key = historyKey(job), samples = histories.get(key) ?? [];
      samples.push(job.durationMs); histories.set(key, samples);
    }
    for (const samples of histories.values()) samples.sort((a, b) => a - b);
    for (const job of jobs) {
      const elapsedMs = Math.max(0, (job.endedAt ?? this.now()) - (job.startedAt ?? job.createdAt));
      const durations = job.route ? histories.get(historyKey(job)) ?? [] : [];
      const usualMs = durations.length >= settings.minSamples ? durations[Math.floor(durations.length / 2)]! : null;
      // A failure alerts only while it is recent. History that arrives later (a first start after an update, a node polled for the first time) is not news.
      const fresh = job.endedAt === null || this.now() - job.endedAt <= FAILURE_ALERT_WINDOW_MS;
      const type = settings.stalled && job.state === 'stalled' ? 'job.stalled' : settings.failed && job.state === 'failed' && fresh ? 'job.failed'
        : settings.overUsualTime && job.state === 'running' && usualMs !== null && elapsedMs > Math.max(60000, usualMs * settings.usualMultiple) ? 'job.over-usual-time' : null;
      if (!type) continue;
      const alert: LedgerAlert = { version: 1, id: `${job.id}:${type}`, type, at: this.now(), jobId: job.id, node: job.node, state: job.state, route: job.route, sessionId: job.stamp.sessionId ?? null, summary: job.summary, elapsedMs, usualMs, samples: durations.length };
      const result = this.db.prepare('insert or ignore into ledger_alerts(id,body) values(?,?)').run(alert.id, JSON.stringify(alert));
      if (Number(result.changes)) { emitted.push(alert); try { void Promise.resolve(this.sink.emit(alert)).catch(() => {}); } catch { /* A sink cannot interrupt jobs. */ } }
    }
    return emitted;
  }
  alerts(): LedgerAlert[] { return (this.db.prepare('select body from ledger_alerts order by rowid').all() as Array<{ body: string }>).map(r => JSON.parse(r.body) as LedgerAlert); }
}
