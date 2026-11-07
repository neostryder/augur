import { appendFile, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { LedgerAlert, LedgerAlertSettings, LedgerDeliveryState } from '@augur/dispatch-protocol';
import type { AlertSink } from './job-ledger.js';
import type { ViewHub } from './views.js';

export function alertPayload(event: LedgerAlert): LedgerAlert {
  const { version, id, type, at, jobId, node, state, route, sessionId, summary, elapsedMs, usualMs, samples } = event;
  return { version, id, type, at, jobId, node, state, route, sessionId, summary, elapsedMs, usualMs, samples };
}

export function cressetPayload(event: LedgerAlert) {
  const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim();
  const text = (value: string, limit: number, fallback: string) => (clean(value) || fallback).slice(0, limit);
  const duration = (ms: number) => {
    for (const [unit, size] of [['day', 86400000], ['hr', 3600000], ['min', 60000], ['sec', 1000]] as const) if (ms >= size) {
      const value = Math.round(ms / size);
      return `${value} ${unit === 'day' && value !== 1 ? 'days' : unit}`;
    }
    return `${ms} ms`;
  };
  const details = {
    'job.failed': { class: 'failed', severity: 2, words: 'failed', action: 'failed' },
    'job.stalled': { class: 'stalled', severity: 3, words: 'stalled', action: 'stalled' },
    'job.over-usual-time': { class: 'over_usual_time', severity: 4, words: 'over usual time', action: 'exceeded its usual time' },
  }[event.type];
  const node = clean(event.node) || 'unknown', route = clean(event.route ?? '');
  const jobId = clean(event.jobId) || 'unknown', id = clean(event.id) || 'unknown';
  const description = `The job ${details.action} on node ${node}${route ? ` using route ${route}` : ''}, with state ${clean(event.state) || 'unknown'} and elapsed time ${duration(event.elapsedMs)}. There are ${event.samples} completed duration samples${event.usualMs === null ? '' : ` with a usual time of ${duration(event.usualMs)}`}.`;
  const at = new Date(event.at).toISOString();
  return {
    host: text(node, 255, 'unknown'),
    component: text(route ? `augur.job:${route}` : 'augur.job', 120, 'augur.job'),
    class: details.class,
    severity: details.severity,
    title: text(event.summary, 120, `Augur job ${details.words}.`),
    description: text(description, 1000, 'An Augur job needs attention.'),
    assessment: 'unknown',
    owner: 'Augur',
    next_step: text(`Open the job in the Augur job ledger (${jobId}).`, 500, 'Open the Augur job ledger.'),
    fingerprint: text(`augur:${node}:${route || 'none'}:${event.type}`, 256, 'augur:unknown:none:job.failed'),
    evidence_tail: text(`jobId=${jobId} alertId=${id}`, 2000, 'Job identifiers are unavailable.'),
    first_seen: at,
    last_seen: at,
    count: 1,
    kind: 'alert',
  };
}

export class OutboxAlertSink implements AlertSink {
  private ids: Set<string> | null = null;
  private pending = Promise.resolve();
  private readonly path: string;
  constructor(home: string, private maxBytes = 5 * 1024 * 1024, private copies = 3) { this.path = join(home, 'alerts-outbox.jsonl'); }

  emit(event: LedgerAlert): Promise<void> {
    const pending = this.pending.then(() => this.append(event));
    this.pending = pending.catch(() => undefined);
    return pending;
  }

  private async optional<T>(operation: () => Promise<T>): Promise<T | null> {
    try { return await operation(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }

  private async append(event: LedgerAlert): Promise<void> {
    if (!this.ids) {
      const ids = new Set<string>();
      for (let index = 0; index <= this.copies; index++) {
        const path = index ? this.path + '.' + index : this.path;
        const text = await this.optional(() => readFile(path, 'utf8'));
        if (text === null) continue;
        for (const line of text.split('\n')) {
          if (!line) continue;
          try { const row = JSON.parse(line) as LedgerAlert; if (typeof row.id === 'string') ids.add(row.id); }
          catch { /* A torn final append must not consume the next valid object. */ }
        }
      }
      this.ids = ids;
    }
    if (this.ids.has(event.id)) return;
    const line = JSON.stringify(alertPayload(event)) + '\n';
    const file = await this.optional(() => open(this.path, 'r'));
    let rotate = false;
    if (file) {
      try {
        const size = (await file.stat()).size, tail = Buffer.alloc(1);
        if (size) await file.read(tail, 0, 1, size - 1);
        rotate = size + Buffer.byteLength(line) > this.maxBytes || (size > 0 && tail[0] !== 10);
      } finally { await file.close(); }
    }
    if (rotate) {
      for (let index = this.copies; index >= 1; index--) {
        const destination = this.path + '.' + index, source = index === 1 ? this.path : this.path + '.' + (index - 1);
        await this.optional(() => unlink(destination));
        await this.optional(() => rename(source, destination));
      }
      this.ids = null;
    }
    await appendFile(this.path, line, { mode: 0o600, flush: true });
    this.ids?.add(event.id);
  }
}

export class DesktopAlertSink implements AlertSink {
  constructor(private views: () => ViewHub | null) {}
  async emit(event: LedgerAlert): Promise<void> {
    const views = this.views();
    if (!views?.provider('notify')) throw new Error('The desktop app is disconnected.');
    await views.request('notify', 'notify', { title: event.type, body: event.summary || event.jobId, jobId: event.jobId, alertId: event.id }, 15000);
  }
}

export class WebhookAlertSink implements AlertSink {
  constructor(private url: () => string, private keyName: () => string, private secret: (name: string) => Promise<string | null>, private format: () => LedgerAlertSettings['webhookFormat'] = () => 'augur', private fetcher: typeof fetch = fetch) {}
  async emit(event: LedgerAlert): Promise<void> {
    const keyName = this.keyName(), key = keyName ? await this.secret(keyName) : null;
    if (keyName && !key) throw new Error('The webhook credential is unavailable.');
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Idempotency-Key': event.id };
    if (key) headers.Authorization = `Bearer ${key}`;
    const response = await this.fetcher(this.url(), { method: 'POST', headers, body: JSON.stringify(this.format() === 'cresset' ? cressetPayload(event) : alertPayload(event)), redirect: 'error', signal: AbortSignal.timeout(10000) });
    try { if (!response.ok) throw new Error('The webhook refused the alert.'); }
    finally { await response.body?.cancel().catch(() => undefined); }
  }
}

interface Delivery { alert_id: string; attempts: number; body: string }
export interface NamedAlertSink { name: string; sink: AlertSink; enabled?(): boolean }

export class LedgerDelivery implements AlertSink {
  private workers = new Map<string, Promise<void>>();
  private closed = false;
  constructor(private db: DatabaseSync, private sinks: NamedAlertSink[], private now = Date.now, private capacity = 1000) {
    db.exec(`create table if not exists ledger_delivery(alert_id text not null, sink text not null, delivered_at integer, attempts integer not null default 0, next_at integer not null default 0, error text, primary key(alert_id,sink));
      create index if not exists ledger_delivery_due on ledger_delivery(sink,delivered_at,next_at);`);
  }

  emit(_event: LedgerAlert): void { void this.tick().catch(() => undefined); }

  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    for (const sink of this.sinks) if (sink.enabled?.() !== false && !this.workers.has(sink.name)) {
      const worker = this.drain(sink).finally(() => { this.workers.delete(sink.name); });
      this.workers.set(sink.name, worker);
    }
    return Promise.all(this.workers.values()).then(() => undefined);
  }

  private async drain({ name, sink }: NamedAlertSink): Promise<void> {
    const pending = Number((this.db.prepare('select count(*) n from ledger_delivery where sink=? and delivered_at is null').get(name) as { n: number }).n);
    this.db.prepare(`insert or ignore into ledger_delivery(alert_id,sink)
      select id,? from ledger_alerts where not exists(select 1 from ledger_delivery where alert_id=ledger_alerts.id and sink=?) order by rowid limit ?`).run(name, name, Math.max(0, this.capacity - pending));
    const due = this.db.prepare(`select d.alert_id,d.attempts,a.body from ledger_delivery d join ledger_alerts a on a.id=d.alert_id
      where d.sink=? and d.delivered_at is null and d.next_at<=? order by a.rowid limit 20`).all(name, this.now()) as unknown as Delivery[];
    for (const row of due) {
      if (this.closed) break;
      try {
        await sink.emit(JSON.parse(row.body) as LedgerAlert);
        this.db.prepare('update ledger_delivery set delivered_at=?,error=null where alert_id=? and sink=?').run(this.now(), row.alert_id, name);
      } catch {
        // A transport error can contain credentials or response text, so only this fixed message is persisted.
        this.db.prepare('update ledger_delivery set attempts=attempts+1,next_at=?,error=? where alert_id=? and sink=?').run(this.now() + Math.min(300000, 1000 * 2 ** Math.min(row.attempts, 9)), 'Alert delivery failed.', row.alert_id, name);
      }
    }
  }

  status(): LedgerDeliveryState[] {
    return this.sinks.filter(sink => sink.enabled?.() !== false).map(({ name }) => {
      const row = this.db.prepare(`select sum(delivered_at is null) pending,sum(delivered_at is not null) delivered,sum(delivered_at is null and attempts>0) failed from ledger_delivery where sink=?`).get(name) as { pending: number | null; delivered: number | null; failed: number | null };
      const backlog = (this.db.prepare('select count(*) n from ledger_alerts where not exists(select 1 from ledger_delivery where alert_id=ledger_alerts.id and sink=?)').get(name) as { n: number }).n;
      return { sink: name, pending: (row.pending ?? 0) + backlog, delivered: row.delivered ?? 0, failed: row.failed ?? 0, error: row.failed ? 'Alert delivery failed.' : backlog > 0 ? 'Alerts are waiting for delivery.' : null };
    });
  }

  async close(): Promise<void> { this.closed = true; await Promise.all(this.workers.values()); }
}
