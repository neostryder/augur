import type { ModJob, ModOrigin, ModUsage } from '../types'

export const JOBS_TEXT = {
  title: 'Augur live jobs',
  description: 'Open the Augur live jobs pane',
  opened: 'The live jobs pane is open.',
  waiting: 'Waiting for a place to show the pane.',
  empty: 'No jobs are running.',
  emptyScope: 'No jobs from this session are running.',
  noClosed: 'No closed jobs yet.',
  job: 'job',
  jobs: 'jobs',
  stalled: 'stalled',
  ago: 'ago',
  labels: { origin: 'ORIGIN:', job: 'JOB:', activity: 'ACTIVITY:', result: 'RESULT:' },
  scopeSession: 'This session',
  scopeAll: 'All sessions',
  elsewhere: 'Elsewhere',
  live: 'live',
  closed: 'closed',
  cancel: 'Cancel job',
  cancelSure: 'Press again to cancel this job',
  cancelling: 'Cancelling...',
  openApp: 'Open Augur',
  closedHeading: 'CLOSED',
  showAll: 'Show all sessions',
  showSession: 'Show this session only',
  collapse: 'Collapse',
  expand: 'Expand',
  session: 'session',
  noSession: 'no session',
  unknownOrigin: 'unknown origin',
  thisSession: 'this session',
  host: 'host',
  pid: 'pid',
  data: 'data',
  tools: 'tools',
  depth: 'depth',
  child: 'child of',
  named: 'named',
  started: 'started',
  queued: 'queued',
  ended: 'ended',
  took: 'took',
  lastOutput: 'last output',
  exit: 'exit',
  tokensIn: 'in',
  tokensOut: 'out',
  noDetails: 'no details recorded',
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
  const recent = Array.isArray(feed.recent) ? feed.recent.map((j) => cleanJob(j, CLOSED_STATES)).filter((j): j is ModJob => j !== null).slice(0, MAX_CLOSED) : []
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
export type LineKind = 'origin' | 'job' | 'activity' | 'result'
export type PaneLine = { kind: LineKind; label: string; segs: Seg[] }
export type PaneRow = { id: string; closed: boolean; stalled: boolean; state: string; color: string; lines: PaneLine[] }

/** Each line type has its own label color, so the three lines of a row read apart at a glance. */
export const LABEL_COLORS: Record<LineKind, string> = { origin: 'suggestion', job: 'claude', activity: 'permission', result: 'merged' }

const dim = (s: string): Seg[] => [{ text: s, dim: true }]

/** Ages: the largest whole unit, as in 8s, 2m, 3h, 2d. */
function since(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`
}

/** Run times: two units, as in 1m 20s or 2h 5m. */
function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

const tokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const money = (usd: number): string => `$${usd >= 1 ? usd.toFixed(2) : usd.toFixed(4)}`

/** The theme color for a job's state; it tints the row's border and the state badge. */
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

/** A filled badge: bold light text on the state color. */
const badge = (s: string, bg: string): Seg => ({ text: ` ${s} `, bold: true, color: 'inverseText', bg })

const TIER_COLORS: Record<string, string> = { public: 'success', internal: 'suggestion', sensitive: 'warning', restricted: 'error', private: 'error' }

/** Joins the parts of one line with a dim bar between them, skipping empty parts. */
function line(kind: LineKind, label: string, parts: Array<Seg[] | null | undefined | false>): PaneLine {
  const segs: Seg[] = []
  for (const part of parts) {
    if (!part || !part.length) continue
    if (segs.length) segs.push({ text: ' | ', dim: true })
    segs.push(...part)
  }
  return { kind, label, segs }
}

function originLine(job: ModJob, mine: string): PaneLine {
  const o = job.origin ?? {}
  const own = !!mine && o.sessionId === mine
  const name = o.sessionTitle ?? (o.sessionId ? `${JOBS_TEXT.session} ${o.sessionId.slice(0, 8)}` : JOBS_TEXT.noSession)
  const kind = o.kind ? (o.label && o.label !== o.kind ? `${o.kind} / ${o.label}` : o.kind) : JOBS_TEXT.unknownOrigin
  return line('origin', JOBS_TEXT.labels.origin, [
    [{ text: name, bold: true, underline: true, color: own ? 'success' : 'text' }, ...(own ? [badge(JOBS_TEXT.thisSession, 'success')] : [])],
    [{ text: kind, color: 'claude' }],
    o.intent ? [{ text: o.intent, italic: true, color: o.intent === 'automated' ? 'warning' : 'suggestion' }] : null,
    o.host ? dim(`${JOBS_TEXT.host} ${o.host}`) : null,
    o.pid !== undefined ? dim(`${JOBS_TEXT.pid} ${o.pid}`) : null,
    job.cwd ? dim(job.cwd) : null,
  ])
}

function jobLine(job: ModJob, now: number, closed: boolean): PaneLine {
  const state = job.stalled ? JOBS_TEXT.stalled.toUpperCase() : job.state.replace(/_/g, ' ')
  const timing: Array<Seg[] | null> = closed
    ? [job.endedAt !== undefined ? dim(`${JOBS_TEXT.ended} ${since(now - job.endedAt)} ${JOBS_TEXT.ago}`) : null,
      job.endedAt !== undefined && job.startedAt !== null ? dim(`${JOBS_TEXT.took} ${span(job.endedAt - job.startedAt)}`) : null]
    : [job.startedAt !== null ? dim(`${JOBS_TEXT.started} ${since(now - job.startedAt)} ${JOBS_TEXT.ago}`) : dim(`${JOBS_TEXT.queued} ${since(now - (job.createdAt ?? job.lastActivityAt))}`)]
  return line('job', JOBS_TEXT.labels.job, [
    [{ text: job.id, bold: true }],
    [{ text: job.route, bold: true, color: 'claude' }, ...(job.model ? [{ text: ` (${job.model})`, dim: true }] : [])],
    [{ text: job.activity, italic: true }],
    [badge(state, stateColor(job))],
    job.dataTier ? [{ text: `${JOBS_TEXT.data} `, dim: true }, { text: job.dataTier, color: TIER_COLORS[job.dataTier] ?? 'text' }] : null,
    job.tools ? [{ text: `${JOBS_TEXT.tools} `, dim: true }, { text: job.tools, color: job.tools === 'none' || job.tools === 'read' ? 'success' : 'warning' }] : null,
    job.depth ? dim(`${JOBS_TEXT.depth} ${job.depth}${job.parentJobId ? `, ${JOBS_TEXT.child} ${job.parentJobId.slice(0, 12)}` : ''}`) : null,
    job.named ? dim(JOBS_TEXT.named) : null,
    ...timing,
  ])
}

function activityLine(job: ModJob, now: number): PaneLine {
  const quiet = now - job.lastActivityAt
  return line('activity', JOBS_TEXT.labels.activity, [
    [{ text: `${JOBS_TEXT.lastOutput} ${since(quiet)} ${JOBS_TEXT.ago}`, color: job.stalled ? 'warning' : 'subtle', bold: job.stalled }],
    job.summary ? [{ text: job.summary, italic: true, color: 'subtle' }] : null,
    job.activityLine ? [{ text: job.activityLine, color: 'text' }] : null,
  ])
}

function resultLine(job: ModJob): PaneLine {
  const u = job.usage
  const failed = ['failed', 'artifact_validation_failed', 'lost'].includes(job.state)
  const parts: Array<Seg[] | null> = [
    job.exitCode !== undefined ? [{ text: `${JOBS_TEXT.exit} ${job.exitCode}`, bold: true, color: job.exitCode === 0 ? 'success' : 'error' }] : null,
    u ? [{ text: tokens(u.inputTokens), color: 'suggestion' }, { text: ` ${JOBS_TEXT.tokensIn} / `, dim: true }, { text: tokens(u.outputTokens), color: 'permission' }, { text: ` ${JOBS_TEXT.tokensOut}`, dim: true }] : null,
    u?.costUsd !== undefined ? [{ text: money(u.costUsd), bold: true, color: 'warning' }] : null,
    job.reason ? [{ text: job.reason, color: failed ? 'error' : undefined }] : null,
    job.summary ? [{ text: job.summary, italic: true, color: 'subtle' }] : null,
  ]
  return line('result', JOBS_TEXT.labels.result, parts.some(Boolean) ? parts : [dim(JOBS_TEXT.noDetails)])
}

/** The rows for the pane, three lines each. Live rows list stalled jobs first and then the newest; closed rows list the latest ending first. */
export function paneRows(jobs: readonly ModJob[], now: number, closed = false, mine = ''): PaneRow[] {
  const order = closed
    ? (a: ModJob, b: ModJob) => (b.endedAt ?? b.lastActivityAt) - (a.endedAt ?? a.lastActivityAt)
    : (a: ModJob, b: ModJob) => Number(b.stalled) - Number(a.stalled) || (b.startedAt ?? b.createdAt ?? 0) - (a.startedAt ?? a.createdAt ?? 0)
  return [...jobs].sort(order).map((job) => ({
    id: job.id, closed, stalled: job.stalled, state: job.state, color: stateColor(job),
    lines: [originLine(job, mine), jobLine(job, now, closed), closed ? resultLine(job) : activityLine(job, now)],
  }))
}
