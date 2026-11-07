import { JOB_STATES } from './states.js';
import { LEDGER_KINDS, LEDGER_STATES, ORIGIN_KINDS } from './job-ledger.js';
import type { LedgerChain, LedgerJob, LedgerPage, LedgerQuery } from './job-ledger.js';

export interface LedgerFilters {
  all?: boolean;
  session?: string;
  origin?: string;
  node?: string;
  kind?: string[];
  state?: string[];
  running?: boolean;
  root?: string;
  route?: string;
  from?: string;
  until?: string;
  text?: string;
  limit?: number;
  page?: string;
}

export function ledgerTime(value: string, now = Date.now()): number {
  const relative = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(value);
  const at = relative ? now - Number(relative[1]) * ({ m: 60000, h: 3600000, d: 86400000 }[relative[2]!]!)
    : /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(at) || at < 0) throw new Error('The time must be an ISO date or an elapsed time such as 90m, 6h, or 2d.');
  return at;
}

export function ledgerQuery(a: LedgerFilters, session?: string, now = Date.now()): LedgerQuery {
  const q: LedgerQuery = {};
  if (a.page?.startsWith('time.')) {
    try {
      const saved = JSON.parse(atob(a.page.slice(5))) as { page: string; now: number; from?: string; until?: string };
      if (typeof saved.page !== 'string' || !Number.isFinite(saved.now) || saved.from !== a.from || saved.until !== a.until) throw new Error();
      a = { ...a, page: saved.page }; now = saved.now;
    } catch { throw new Error('The ledger page is invalid or its time filters changed.'); }
  }
  const scope = a.session ?? (a.all ? undefined : session);
  if (scope) q.session = scope;
  for (const key of ['node', 'root', 'route', 'text', 'page'] as const) if (a[key] !== undefined) q[key] = a[key];
  if (a.origin !== undefined) {
    if (!ORIGIN_KINDS.includes(a.origin as never)) throw new Error('The origin filter is invalid.');
    q.origin = a.origin as LedgerQuery['origin'];
  }
  if (a.kind !== undefined) {
    if (a.kind.some(k => !LEDGER_KINDS.includes(k as never))) throw new Error('The kind filter is invalid.');
    q.kind = a.kind as LedgerQuery['kind'];
  }
  if (a.state !== undefined) {
    if (a.state.length === 1 && JOB_STATES.includes(a.state[0] as never)) {
      q.localState = a.state[0] as LedgerQuery['localState'];
      if (LEDGER_STATES.includes(a.state[0] as never)) q.state = a.state[0] === 'running' ? ['running', 'stalled'] : a.state as LedgerQuery['state'];
    } else {
      if (a.state.some(s => !LEDGER_STATES.includes(s as never))) throw new Error('The state filter is invalid.');
      q.state = a.state as LedgerQuery['state'];
    }
  }
  if (a.running) q.state = (q.state ?? ['queued', 'running', 'stalled']).filter(s => ['queued', 'running', 'stalled'].includes(s));
  if (a.from !== undefined) q.from = ledgerTime(a.from, now);
  if (a.until !== undefined) q.to = ledgerTime(a.until, now);
  if (q.from !== undefined && q.to !== undefined && q.from > q.to) throw new Error('The start time must precede the end time.');
  if (a.limit !== undefined) {
    if (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > 1000) throw new Error('The limit must be a whole number from 1 to 1000.');
    q.limit = a.limit;
  }
  return q;
}

export function ledgerPage(page: LedgerPage, filters: LedgerFilters, now: number): LedgerPage {
  if (!page.next || ![filters.from, filters.until].some(v => v !== undefined && /^\d+(?:\.\d+)?[mhd]$/.test(v))) return page;
  // Relative bounds keep the first page's clock while the service cursor binds the resolved filters.
  if (filters.page?.startsWith('time.')) now = (JSON.parse(atob(filters.page.slice(5))) as { now: number }).now;
  return { ...page, next: `time.${btoa(JSON.stringify({ page: page.next, now, from: filters.from, until: filters.until }))}` };
}

export const ledgerDate = (at: number | null): string => at === null ? '-' : new Date(at).toISOString();
export function ledgerDuration(job: LedgerJob, now = Date.now()): string {
  const seconds = Math.floor(Math.max(0, job.durationMs ?? now - (job.startedAt ?? job.createdAt)) / 1000);
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

export function ledgerDetail(chain: LedgerChain): string {
  const j = chain.job;
  return [
    `${j.id}  ${j.state}  ${j.kind}`,
    `Summary (${j.summarySource}): ${j.summary || '-'}`,
    ...(['session', 'origin', 'process', 'host'] as const).map(group => `${group} attribution: ${j.attribution[group]}`),
    `Stamp: ${JSON.stringify(j.stamp)}`,
    `Route: ${j.route ?? '-'}  Model: ${j.model ?? '-'}  Activity: ${j.activity}`,
    `Created: ${ledgerDate(j.createdAt)}  Started: ${ledgerDate(j.startedAt)}`,
    `Updated: ${ledgerDate(j.updatedAt)}  Last activity: ${ledgerDate(j.lastActivityAt)}`,
    `Ended: ${ledgerDate(j.endedAt)}  Duration: ${ledgerDuration(j)}`,
    `Usage: ${JSON.stringify(j.usage)}  Exit reason: ${j.exitReason ?? '-'}`,
    `Parent: ${j.parentId ?? '-'}  Children: ${chain.children.map(c => c.id).join(', ') || '-'}`,
    ...(j.replayOf ? [`replay of ${j.replayOf}`] : []),
    `Retry of: ${j.retryOf ?? '-'}  Retried as: ${j.retriedAs ?? '-'}`,
    `Retries: ${chain.retries.map(c => c.id).join(', ') || '-'}`,
    `Compacted: ${j.compacted}`,
    ...(j.activityLine ? [`Activity: ${j.activityLine}`] : []),
  ].join('\n');
}
