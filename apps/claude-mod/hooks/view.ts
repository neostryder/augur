import type { ModAlert, ModJob } from '../types'

type Meter = { id?: string; usedPct?: number | null; windowKind?: string; windowSeconds?: number | null; resetsAt?: string }
type Provider = { id?: string; name?: string; ok?: boolean; stale?: boolean; meters?: Meter[] }
export type Usage = { generatedAt?: string; providers?: Record<string, Provider> }

/** A provider shows in the status line beside Claude once one of its meters reaches this percent. */
export const HOT_PCT = 70
/** Usage older than this gets its age added to the status line, since Augur has stopped writing it. */
export const STALE_MS = 15 * 60_000
/** Points of use ahead of or behind the share of a window that has passed that still count as on pace. Augur's own default; the mod reads the owner's value from policy.json. */
export const PACE_BAND = 5

export const JOBS_TEXT = {
  title: 'Augur live jobs',
  description: 'Open the Augur live jobs pane',
  opened: 'The live jobs pane is open.',
  waiting: 'Waiting for a place to show the pane.',
  empty: 'No jobs are running.',
  job: 'job',
  jobs: 'jobs',
  stalled: 'stalled',
  ago: 'ago',
  seconds: 's',
  minutes: 'm',
  hours: 'h',
} as const

export function liveJobs(text: string | null, now: number): ModJob[] {
  try {
    const feed = JSON.parse(text ?? '')
    if (!feed || typeof feed.updatedAt !== 'number' || !Number.isFinite(feed.updatedAt) || now - feed.updatedAt > 60_000 || !Array.isArray(feed.jobs)) return []
    if (typeof feed.stallMinutes !== 'number' || !Number.isFinite(feed.stallMinutes) || feed.stallMinutes < 0) return []
    const valid = (job: ModJob) => job && typeof job.id === 'string' && typeof job.route === 'string' && typeof job.activity === 'string'
      && ['queued', 'needs_approval', 'running', 'cancel_requested'].includes(job.state)
      && (job.startedAt === null || (typeof job.startedAt === 'number' && Number.isFinite(job.startedAt)))
      && typeof job.lastActivityAt === 'number' && Number.isFinite(job.lastActivityAt)
      && typeof job.activityLine === 'string' && job.activityLine.length <= 120 && typeof job.stalled === 'boolean'
    return feed.jobs.every(valid) ? feed.jobs.slice(0, 50) : []
  } catch { return [] }
}

export function jobStatus(jobs: readonly ModJob[]): string | undefined {
  if (!jobs.length) return undefined
  const stalled = jobs.filter((job) => job.stalled).length
  return `${jobs.length} ${jobs.length === 1 ? JOBS_TEXT.job : JOBS_TEXT.jobs}${stalled ? ` (${stalled} ${JOBS_TEXT.stalled})` : ''}`
}

export function paneRows(jobs: readonly ModJob[], now: number): Array<{ id: string; text: string; stalled: boolean }> {
  return [...jobs].sort((a, b) => Number(b.stalled) - Number(a.stalled) || (b.startedAt ?? 0) - (a.startedAt ?? 0)).map((job) => {
    const seconds = Math.max(0, Math.floor((now - job.lastActivityAt) / 1000))
    const age = seconds < 60 ? `${seconds}${JOBS_TEXT.seconds}` : seconds < 3600 ? `${Math.floor(seconds / 60)}${JOBS_TEXT.minutes}` : `${Math.floor(seconds / 3600)}${JOBS_TEXT.hours}`
    return { id: job.id, stalled: job.stalled,
      text: `${job.route} | ${job.activity} | ${age} ${JOBS_TEXT.ago}${job.stalled ? ` | ${JOBS_TEXT.stalled}` : ''}${job.activityLine ? ` | ${job.activityLine}` : ''}` }
  })
}

function windowName(m: Meter): string {
  if (m.windowKind === 'session') return m.windowSeconds ? `${Math.round(m.windowSeconds / 3600)}h` : 'session'
  if (m.windowKind === 'weekly') return 'wk'
  if (m.windowKind === 'monthly') return 'mo'
  if (m.windowKind === 'daily') return 'day'
  return ''
}

const pct = (m: Meter) => `${Math.round(m.usedPct ?? 0)}%`

function age(ms: number): string {
  const min = Math.round(ms / 60_000)
  return min < 120 ? `${min}m` : `${Math.round(min / 60)}h`
}

export type Pace = { stance: 'hot' | 'behind' | 'on pace'; ahead: number }

/**
 * Claude's pace worked out the way Augur's balance does it, so the status line and the picks agree. Each session or weekly window gives how far its use is ahead of
 * the share of it that has passed. The stance is hot when any window is past the band and behind when every window is under it. A window scoped to one model is not
 * the subscription's pace, and numbers Augur has stopped refreshing give no pace at all.
 */
export function claudePace(usage: Usage | null, now: number, band = PACE_BAND): Pace | null {
  const at = usage?.generatedAt ? Date.parse(usage.generatedAt) : NaN
  if (!usage || !Number.isFinite(at) || now - at > STALE_MS) return null
  const ahead: number[] = []
  for (const m of usage.providers?.claude?.meters ?? []) {
    if ((m.windowKind !== 'session' && m.windowKind !== 'weekly') || /scoped/.test(m.id ?? '') || typeof m.usedPct !== 'number') continue
    const reset = m.resetsAt ? Date.parse(m.resetsAt) : NaN
    if (!Number.isFinite(reset) || !m.windowSeconds) continue
    const elapsed = Math.min(1, Math.max(0, 1 - (reset - now) / 1000 / m.windowSeconds)) * 100
    ahead.push(m.usedPct - elapsed)
  }
  if (!ahead.length) return null
  const top = Math.max(...ahead)
  return { stance: ahead.some((a) => a > band) ? 'hot' : ahead.every((a) => a < -band) ? 'behind' : 'on pace', ahead: Math.round(top) }
}

const paceText = (p: Pace): string => (p.stance === 'on pace' ? 'on pace' : `${p.stance} ${p.ahead > 0 ? '+' : ''}${p.ahead}`)

/** Claude's session and weekly use, then its pace, then any provider running hot or stale, then the alert count. */
export function statusLine(usage: Usage | null, alerts: number, now: number, band = PACE_BAND, jobs: readonly ModJob[] = []): string | undefined {
  const parts: string[] = []
  const providers = Object.values(usage?.providers ?? {})
  const claude = usage?.providers?.claude
  if (claude?.meters?.length) {
    const session = claude.meters.find((m) => m.windowKind === 'session')
    const weekly = claude.meters.find((m) => m.id === 'weekly_all') ?? claude.meters.find((m) => m.windowKind === 'weekly')
    const bits = [session && `${windowName(session)} ${pct(session)}`, weekly && `wk ${pct(weekly)}`].filter(Boolean)
    if (bits.length) parts.push(`Claude ${bits.join(' | ')}`)
    const pace = claudePace(usage, now, band)
    if (pace) parts.push(paceText(pace))
  }
  for (const p of providers) {
    if (p.id === 'claude') continue
    const name = p.name ?? p.id ?? '?'
    if (p.stale) { parts.push(`${name} stale`); continue }
    const hot = (p.meters ?? []).filter((m) => (m.usedPct ?? 0) >= HOT_PCT).sort((a, b) => (b.usedPct ?? 0) - (a.usedPct ?? 0))[0]
    if (hot) parts.push(`${name} ${windowName(hot)} ${pct(hot)}`.replace('  ', ' '))
  }
  const at = usage?.generatedAt ? Date.parse(usage.generatedAt) : NaN
  if (usage && Number.isFinite(at) && now - at > STALE_MS) parts.push(`as of ${age(now - at)} ago`)
  if (alerts) parts.push(alerts === 1 ? '1 Augur alert' : `${alerts} Augur alerts`)
  const jobPart = jobStatus(jobs)
  if (jobPart) parts.push(jobPart)
  return parts.length ? parts.join(' | ') : undefined
}

/** The alerts in Augur's alerts.json meant for Claude Code, newest first. A file that does not parse reads as empty. */
export function claudeAlerts(text: string | null): ModAlert[] {
  if (!text) return []
  try {
    const feed = JSON.parse(text) as { alerts?: unknown }
    if (!Array.isArray(feed.alerts)) return []
    return feed.alerts
      .filter((a): a is ModAlert & { outlets: string[] } =>
        !!a && typeof a.id === 'string' && typeof a.title === 'string' && typeof a.body === 'string' && Array.isArray(a.outlets))
      .filter((a) => a.outlets.includes('claude'))
      .map((a) => ({ id: a.id, title: a.title, body: a.body, severity: a.severity, raisedAt: a.raisedAt }))
      .sort((a, b) => Date.parse(b.raisedAt) - Date.parse(a.raisedAt))
  } catch {
    return []
  }
}

/** One line for an alert. Augur's alert bodies usually start with the provider's name, as in "Claude: Session reached 90%", so the title goes in front only when the body lacks it. */
export function alertText(a: ModAlert): string {
  return a.body.startsWith(a.title) ? a.body : `${a.title}: ${a.body}`
}

/** The acks file with one more dismissal on the end. */
export function withAck(existing: string | null, id: string, at: string): string {
  const base = existing && !existing.endsWith('\n') ? `${existing}\n` : existing ?? ''
  return `${base}${JSON.stringify({ id, at, by: 'claude' })}\n`
}

/** The folder part of a path. Windows paths may use backslashes, so both separators count. */
export function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut < 0 ? '.' : path.slice(0, cut)
}
