import { ledgerJobRow, ledgerTerminal, type LedgerJob, type JobsLiveRow, type JobsLiveSnapshot } from '@augur/dispatch-protocol';

export const JOBS_CARD_TEXT = {
  title: 'Augur live jobs', description: 'Open the Augur live jobs pane', opened: 'The live jobs pane is open.', waiting: 'Waiting for a place to show the pane.',
  labels: { origin: 'ORIGIN:', job: 'JOB:', timing: 'TIMING:', activity: 'ACTIVITY:', result: 'RESULT:', usage: 'USAGE:' },
  scopeSession: 'This session', scopeAll: 'All sessions', scope: 'Job scope',
  empty: 'No jobs are running.', emptyScope: 'No jobs from this session are running.', noClosed: 'No closed jobs yet.',
  closed: 'closed', closedSection: 'Closed', closedHeading: 'CLOSED', session: 'session', noSession: 'no session', unknownOrigin: 'unknown origin', thisSession: 'this session',
  host: 'host', pid: 'pid', data: 'data', tools: 'tools', depth: 'depth', child: 'child of', named: 'named',
  started: 'started', queued: 'queued', ended: 'ended', took: 'took', elapsed: 'elapsed', ago: 'ago', stalled: 'stalled',
  lastOutput: 'last output', exit: 'exit', tokensIn: 'in', tokensOut: 'out', noDetails: 'no details recorded',
  job: 'job', jobs: 'jobs', elsewhere: 'Elsewhere', live: 'live', cancel: 'Cancel job', cancelSure: 'Press again to cancel this job', cancelling: 'Cancelling...',
  openApp: 'Open Augur', showAll: 'Show all sessions', showSession: 'Show this session only', collapse: 'Collapse', expand: 'Expand',
} as const;

export type JobCardLineKind = keyof typeof JOBS_CARD_TEXT.labels;
export interface JobCardLine { kind: JobCardLineKind; label: string; text: string }
export interface JobCard {
  id: string;
  state: string;
  stalled: boolean;
  closed: boolean;
  lines: JobCardLine[];
  short: string;
}
export interface JobsCardOptions { now: number; scope?: 'session' | 'all'; sessionId?: string; expanded?: boolean }

const T = JOBS_CARD_TEXT;
const join = (parts: Array<string | null | undefined | false>): string => parts.filter(Boolean).join(' | ');
const tokens = (n: number): string => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
const money = (usd: number): string => `$${usd >= 1 ? usd.toFixed(2) : usd.toFixed(4)}`;
const line = (kind: JobCardLineKind, text: string): JobCardLine => ({ kind, label: T.labels[kind], text });

function since(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function jobCard(job: JobsLiveRow, now: number, closed = false, mine = ''): JobCard {
  const o = job.origin;
  const name = o?.sessionTitle || (o?.sessionId ? `${T.session} ${o.sessionId.slice(0, 8)}` : o?.label || T.noSession);
  const kind = o?.kind ? o.label && o.label !== o.kind ? `${o.kind} / ${o.label}` : o.kind : o?.label || T.unknownOrigin;
  const duration = span((closed ? job.endedAt ?? job.lastActivityAt : now) - (job.startedAt ?? job.createdAt ?? job.lastActivityAt));
  const lines = [
    line('origin', join([name, mine && o?.sessionId === mine && T.thisSession, kind !== name && kind, o?.intent,
      o?.host && `${T.host} ${o.host}`, o?.pid != null && `${T.pid} ${o.pid}`, job.cwd])),
    line('job', join([job.id, job.route + (job.model ? ` (${job.model})` : ''), job.activity,
      job.tools && `${T.tools} ${job.tools}`, job.dataTier && `${T.data} ${job.dataTier}`,
      job.depth != null && `${T.depth} ${job.depth}`, job.parentJobId && `${T.child} ${job.parentJobId.slice(0, 12)}`, job.named && T.named])),
    line('timing', join([job.state.replace(/_/g, ' '), job.stalled && T.stalled.toUpperCase(),
      job.startedAt != null ? `${T.started} ${since(now - job.startedAt)} ${T.ago}` : `${T.queued} ${since(now - (job.createdAt ?? job.lastActivityAt))}`,
      closed && job.endedAt != null && `${T.ended} ${since(now - job.endedAt)} ${T.ago}`, `${closed ? T.took : T.elapsed} ${duration}`])),
    closed ? line('result', join([job.exitCode != null && `${T.exit} ${job.exitCode}`, job.reason, job.summary]) || T.noDetails)
      : line('activity', join([`${T.lastOutput} ${since(now - job.lastActivityAt)} ${T.ago}`, job.summary, job.activityLine])),
  ];
  if (job.usage) lines.push(line('usage', join([
    `${tokens(job.usage.inputTokens)} ${T.tokensIn} / ${tokens(job.usage.outputTokens)} ${T.tokensOut}`,
    job.usage.costUsd != null && money(job.usage.costUsd),
  ])));
  return { id: job.id, state: job.state, stalled: job.stalled, closed, lines, short: join([name, job.route, duration]) };
}

export function jobsCards(snapshot: JobsLiveSnapshot, options: JobsCardOptions) {
  const { now, scope = 'all', sessionId = '', expanded = false } = options;
  const filter = (jobs: readonly JobsLiveRow[]) => scope === 'session' && sessionId ? jobs.filter(job => job.origin?.sessionId === sessionId) : [...jobs];
  const recent = filter(snapshot.recent).sort((a, b) => (b.endedAt ?? b.lastActivityAt) - (a.endedAt ?? a.lastActivityAt)).slice(0, 30);
  const live = now - snapshot.updatedAt > 60_000 ? [] : filter(snapshot.jobs).sort((a, b) => Number(b.stalled) - Number(a.stalled)
    || (b.startedAt ?? b.createdAt ?? 0) - (a.startedAt ?? a.createdAt ?? 0));
  return {
    scope, expanded, live: live.map(job => jobCard(job, now, false, sessionId)), recent: recent.map(job => jobCard(job, now, true, sessionId)),
    empty: scope === 'session' && sessionId ? T.emptyScope : T.empty, noClosed: T.noClosed,
    closedHeading: `${T.closedSection} (${recent.length})`,
  };
}

/** Older services and remote nodes provide ledger metadata without execution fields. */
export function ledgerJobsSnapshot(jobs: readonly LedgerJob[], now: number): JobsLiveSnapshot {
  return { updatedAt: now, jobs: jobs.filter(job => !ledgerTerminal(job.state)).map(ledgerJobRow), recent: jobs.filter(job => ledgerTerminal(job.state)).map(ledgerJobRow) };
}
