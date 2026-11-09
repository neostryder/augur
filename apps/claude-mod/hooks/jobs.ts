import type { ModJob, ModOrigin, ModUsage } from '../types'
type JobsLiveRow = ModJob

export const JOBS_TEXT = {
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
} as const

const LIVE_STATES = ['queued', 'needs_approval', 'running', 'cancel_requested']
const CLOSED_STATES = ['completed', 'failed', 'artifact_validation_failed', 'cancelled', 'killed', 'lost']
const MAX_LIVE = 50
const MAX_CLOSED = 30
/** A live list older than this is the service's last word before it stopped, so it reads as no jobs. */
const FRESH_MS = 60_000

const text = (v: unknown, max = 256): string | undefined => (typeof v === 'string' && v ? v.slice(0, max) : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

function origin(raw: unknown): ModOrigin | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const out = strip({ kind: text(o.kind, 40), label: text(o.label), sessionId: text(o.sessionId, 128), sessionTitle: text(o.sessionTitle, 120), host: text(o.host, 120), pid: num(o.pid), intent: text(o.intent, 20) })
  return Object.keys(out).length ? out : undefined
}

function usage(raw: unknown): ModUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as Record<string, unknown>
  const input = num(u.inputTokens), output = num(u.outputTokens)
  return input === undefined || output === undefined ? undefined : strip({ inputTokens: input, outputTokens: output, costUsd: num(u.costUsd) })
}

/** One job from the snapshot, or null when a field every job needs is missing or the wrong shape. The optional fields are cleaned, never trusted. */
function cleanJob(raw: unknown, states: readonly string[]): ModJob | null {
  const j = raw as Record<string, unknown> | null
  if (!j || typeof j !== 'object') return null
  if (typeof j.id !== 'string' || typeof j.route !== 'string' || typeof j.activity !== 'string' || typeof j.state !== 'string' || !states.includes(j.state)) return null
  if (!(j.startedAt === null || num(j.startedAt) !== undefined) || num(j.lastActivityAt) === undefined) return null
  if (typeof j.activityLine !== 'string' || j.activityLine.length > 120 || typeof j.stalled !== 'boolean') return null
  return strip({
    id: j.id, route: j.route, activity: j.activity, state: j.state, startedAt: j.startedAt as number | null, lastActivityAt: j.lastActivityAt as number,
    activityLine: j.activityLine, stalled: j.stalled,
    createdAt: num(j.createdAt), endedAt: num(j.endedAt), exitCode: num(j.exitCode), reason: text(j.reason, 160), dataTier: text(j.dataTier, 20), tools: text(j.tools, 20),
    depth: num(j.depth), parentJobId: text(j.parentJobId, 64), cwd: text(j.cwd, 260), named: j.named === true ? true : undefined,
    model: text(j.model, 120), summary: text(j.summary, 120), origin: origin(j.origin), usage: usage(j.usage),
  })
}

/** The live jobs and the recently closed ones from jobs-live.json. Live jobs need a fresh file and all of them valid; closed jobs are kept one by one, however old the file. */
export function parseJobs(raw: string | null, now: number): { live: ModJob[]; recent: ModJob[] } {
  const none = { live: [] as ModJob[], recent: [] as ModJob[] }
  let feed: Record<string, unknown> | null
  try { feed = JSON.parse(raw ?? '') } catch { return none }
  if (!feed || typeof feed !== 'object') return none
  const recent = Array.isArray(feed.recent) ? feed.recent.map((j) => cleanJob(j, CLOSED_STATES)).filter((j): j is ModJob => j !== null).sort((a, b) => (b.endedAt ?? b.lastActivityAt) - (a.endedAt ?? a.lastActivityAt)).slice(0, MAX_CLOSED) : []
  const at = num(feed.updatedAt), stall = num(feed.stallMinutes)
  if (at === undefined || now - at > FRESH_MS || !Array.isArray(feed.jobs) || stall === undefined || stall < 0) return { live: [], recent }
  const live = feed.jobs.map((j) => cleanJob(j, LIVE_STATES))
  return { live: live.every((j) => j !== null) ? (live as ModJob[]).slice(0, MAX_LIVE) : [], recent }
}

export function liveJobs(raw: string | null, now: number): ModJob[] {
  return parseJobs(raw, now).live
}

export function jobStatus(jobs: readonly ModJob[]): string | undefined {
  if (!jobs.length) return undefined
  const stalled = jobs.filter((job) => job.stalled).length
  return `${jobs.length} ${jobs.length === 1 ? JOBS_TEXT.job : JOBS_TEXT.jobs}${stalled ? ` (${stalled} ${JOBS_TEXT.stalled})` : ''}`
}

/** The jobs this session started, or every job when the pane shows all of them or this session's id is not known. */
export function scopeJobs(jobs: readonly ModJob[], scope: string, mine: string): ModJob[] {
  return scope !== 'session' || !mine ? [...jobs] : jobs.filter((job) => job.origin?.sessionId === mine)
}

const count = (n: number, word: string) => `${n} ${word}`

/** The pane's top line: what the chosen view holds, then what the other view adds. */
export function paneHeader(live: readonly ModJob[], recent: readonly ModJob[], scope: string, mine: string): string {
  const here = (js: readonly ModJob[], rs: readonly ModJob[]) => `${count(js.length, JOBS_TEXT.live)}, ${count(rs.length, JOBS_TEXT.closed)}`
  if (!mine) return `${JOBS_TEXT.scopeAll}: ${here(live, recent)}`
  const mineLive = scopeJobs(live, 'session', mine), mineRecent = scopeJobs(recent, 'session', mine)
  if (scope === 'session') return `${JOBS_TEXT.scopeSession}: ${here(mineLive, mineRecent)} | ${JOBS_TEXT.elsewhere}: ${here(live.filter((j) => !mineLive.includes(j)), recent.filter((j) => !mineRecent.includes(j)))}`
  return `${JOBS_TEXT.scopeAll}: ${here(live, recent)} | ${JOBS_TEXT.scopeSession}: ${here(mineLive, mineRecent)}`
}

/** How many closed jobs ended each way, most common first, as in "27 completed, 3 failed". */
export function closedSummary(recent: readonly ModJob[]): string {
  const by = new Map<string, number>()
  for (const job of recent) by.set(job.state, (by.get(job.state) ?? 0) + 1)
  return [...by].sort((a, b) => b[1] - a[1]).map(([state, n]) => `${n} ${state.replace(/_/g, ' ')}`).join(', ')
}

export type Seg = { text: string; color?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean }
export type LineKind = 'origin' | 'job' | 'timing' | 'activity' | 'result' | 'usage'
export type PaneLine = { kind: LineKind; label: string; segs: Seg[] }
export type PaneRow = { id: string; closed: boolean; stalled: boolean; state: string; color: string; lines: PaneLine[] }

/** Each line type has its own label color, so the three lines of a row read apart at a glance. */
export const LABEL_COLORS: Record<LineKind, string> = { origin: 'suggestion', job: 'claude', timing: 'subtle', activity: 'permission', result: 'merged', usage: 'warning' }

// The standalone bundle mirrors the card text and projection; the workspace parity test checks both.
export type JobCardLineKind = keyof typeof JOBS_TEXT.labels
export interface JobCardLine { kind: JobCardLineKind; label: string; text: string }
export interface JobCard {
  id: string
  state: string
  stalled: boolean
  closed: boolean
  lines: JobCardLine[]
  short: string
}

const T = JOBS_TEXT
const join = (parts: Array<string | null | undefined | false>): string => parts.filter(Boolean).join(' | ')
const tokens = (n: number): string => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
const money = (usd: number): string => `$${usd >= 1 ? usd.toFixed(2) : usd.toFixed(4)}`
const line = (kind: JobCardLineKind, text: string): JobCardLine => ({ kind, label: T.labels[kind], text })

function since(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`
}

function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

export function jobCard(job: JobsLiveRow, now: number, closed = false, mine = ''): JobCard {
  const o = job.origin
  const name = o?.sessionTitle || (o?.sessionId ? `${T.session} ${o.sessionId.slice(0, 8)}` : o?.label || T.noSession)
  const kind = o?.kind ? o.label && o.label !== o.kind ? `${o.kind} / ${o.label}` : o.kind : o?.label || T.unknownOrigin
  const duration = span((closed ? job.endedAt ?? job.lastActivityAt : now) - (job.startedAt ?? job.createdAt ?? job.lastActivityAt))
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
  ]
  if (job.usage) lines.push(line('usage', join([
    `${tokens(job.usage.inputTokens)} ${T.tokensIn} / ${tokens(job.usage.outputTokens)} ${T.tokensOut}`,
    job.usage.costUsd != null && money(job.usage.costUsd),
  ])))
  return { id: job.id, state: job.state, stalled: job.stalled, closed, lines, short: join([name, job.route, duration]) }
}


export function stateColor(job: ModJob): string {
  if (job.stalled) return 'warning'
  switch (job.state) {
    case 'running': return 'success'
    case 'queued': return 'suggestion'
    case 'needs_approval': return 'permission'
    case 'cancel_requested': case 'cancelled': case 'killed': return 'warning'
    case 'completed': return 'success'
    case 'failed': case 'artifact_validation_failed': case 'lost': return 'error'
    default: return 'inactive'
  }
}

export function paneRows(jobs: readonly ModJob[], now: number, closed = false, mine = ''): PaneRow[] {
  const order = closed
    ? (a: ModJob, b: ModJob) => (b.endedAt ?? b.lastActivityAt) - (a.endedAt ?? a.lastActivityAt)
    : (a: ModJob, b: ModJob) => Number(b.stalled) - Number(a.stalled) || (b.startedAt ?? b.createdAt ?? 0) - (a.startedAt ?? a.createdAt ?? 0)
  return [...jobs].sort(order).map((job) => ({
    id: job.id, closed, stalled: job.stalled, state: job.state, color: stateColor(job),
    lines: jobCard(job, now, closed, mine).lines.map((l) => ({
      kind: l.kind, label: l.label, segs: [{ text: l.text, color: l.kind === 'timing' ? stateColor(job) : l.kind === 'result' && stateColor(job) === 'error' ? 'error' : undefined }],
    })),
  }))
}
