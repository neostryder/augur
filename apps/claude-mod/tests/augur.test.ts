import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { closedSummary, jobStatus, liveJobs, paneHeader, paneRows, parseJobs, scopeJobs, statusLine } from '../hooks/view'
import type { PaneRow } from '../hooks/jobs'

const HOME = 'C:/Users/test'
const USAGE = `${HOME}/.augur/usage.json`
const FEED = `${HOME}/.augur/alerts.json`
const ACKS = `${HOME}/.augur/alerts-acks.jsonl`
const JOBS = `${HOME}/.augur/jobs-live.json`
const CANCELS = `${HOME}/.augur/cancel-requests.jsonl`
const NOW = Date.parse('2026-10-03T20:00:00Z')
const SESSION = 'f4102942-2ade-478d-a309-05fd8042827c'

const usage = (generatedAt = '2026-10-03T19:59:00Z') => JSON.stringify({
  schema: 1, generatedAt, providers: {
    claude: { id: 'claude', name: 'Claude', ok: true, stale: false, meters: [
      { id: 'session', usedPct: 27, windowKind: 'session', windowSeconds: 18000 },
      { id: 'weekly_all', usedPct: 48, windowKind: 'weekly', windowSeconds: 604800 }] },
    grok: { id: 'grok', name: 'Grok', ok: true, stale: false, meters: [{ id: 'weekly', usedPct: 81, windowKind: 'weekly', windowSeconds: 604800 }] },
    codex: { id: 'codex', name: 'Codex', ok: true, stale: false, meters: [{ id: 'weekly', usedPct: 46, windowKind: 'weekly', windowSeconds: 604800 }] },
  },
})

const alert = (id: string, outlets: string[], raisedAt: string, body = `Claude: ${id}`) =>
  ({ id, kind: 'percent', severity: 'warn', title: 'Claude', body, raisedAt, outlets, clears: { when: 'never' } })
const feed = (...alerts: object[]) => JSON.stringify({ schema: 1, generatedAt: '2026-10-03T19:59:00Z', alerts })

/** Files, toasts and the status line beneath the plugin, kept in memory. */
function world(on: On, files: Map<string, string>, seen?: string[], app?: object, placed = true) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, seen ? { seen } : {})
  mock.env(on, { USERPROFILE: HOME })
  const toasts: string[] = []
  const status: Array<string | undefined> = []
  const opened: string[] = []
  const reads: string[] = []
  // The engine hands paths over with the platform's separator.
  const at = (path: string) => path.replace(/\\/g, '/')
  on('fs.read', async (_$, e) => {
    reads.push(at(e.path))
    // augur-app.json sits beside the mod, wherever the test runs it from.
    const text = app && at(e.path).endsWith('/augur-app.json') ? JSON.stringify(app) : files.get(at(e.path))
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', async (_$, e) => { files.set(at(e.path), e.text); return { value: undefined } })
  on('ui.toast', async (_$, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.status', async (_$, e) => { status.push(e.text); return { value: undefined } })
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', async (_$, e) => { opened.push(e.id); return { value: placed ? { isPlaced: true } : { isPlaced: false, reason: 'no-surface' } } })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: SESSION }))
  // The engine draws nothing of its own above the prompt.
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
  return { clock, toasts, status, opened, reads }
}

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as const

describe('the Augur mod', () => {
  test('shows Claude, the hot providers and the alert count in the status line', async ($, on) => {
    const files = new Map([[USAGE, usage()], [FEED, feed(alert('a', ['augur', 'claude'], '2026-10-03T19:00:00Z'), alert('b', ['augur'], '2026-10-03T19:10:00Z'))]])
    const w = world(on, files, [])
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    expect(w.status.at(-1)).toBe('Claude 5h 27% | wk 48% | Grok wk 81% | 1 Augur alert')
  })

  test('adds the pace of Claude to the status line, read against the band in the rules', async ($, on) => {
    // The session window is 3 hours from its reset, so 40 percent of it has passed and 60 percent is used, 20 points ahead. The week is on pace.
    const meters = [
      { id: 'session', usedPct: 60, windowKind: 'session', windowSeconds: 18000, resetsAt: new Date(NOW + 3 * 3600_000).toISOString() },
      { id: 'weekly_all', usedPct: 48, windowKind: 'weekly', windowSeconds: 604800, resetsAt: new Date(NOW + 3.6 * 86400_000).toISOString() }]
    const files = new Map([[USAGE, JSON.stringify({ schema: 1, generatedAt: '2026-10-03T19:59:00Z', providers: { claude: { id: 'claude', name: 'Claude', meters } } })]])
    const w = world(on, files, [])
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    expect(w.status.at(-1)).toBe('Claude 5h 60% | wk 48% | hot +20')
    files.set(`${HOME}/.augur/policy.json`, JSON.stringify({ balance: { claude: { band: 25 } } }))
    await w.clock.advance(30_000)
    expect(w.status.at(-1)).toBe('Claude 5h 60% | wk 48% | on pace')
    // A file saved since the upgrade keeps the band on the pace entry for the provider.
    files.set(`${HOME}/.augur/policy.json`, JSON.stringify({ balance: { schema: 2, pace: { claude: { band: 10 } } } }))
    await w.clock.advance(30_000)
    expect(w.status.at(-1)).toBe('Claude 5h 60% | wk 48% | hot +20')
    files.set(`${HOME}/.augur/policy.json`, JSON.stringify({ balance: { schema: 2, pace: { claude: { band: 25 } } } }))
    await w.clock.advance(30_000)
    expect(w.status.at(-1)).toBe('Claude 5h 60% | wk 48% | on pace')
  })

  test('toasts an alert once when it first appears, and not the ones already there on the first run', async ($, on) => {
    const files = new Map([[USAGE, usage()], [FEED, feed(alert('old', ['claude'], '2026-10-03T19:00:00Z'))]])
    const w = world(on, files)
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    expect(w.toasts).toEqual([])
    files.set(FEED, feed(alert('new', ['claude'], '2026-10-03T19:30:00Z', 'Claude: Session reached 90%'), alert('old', ['claude'], '2026-10-03T19:00:00Z')))
    await w.clock.advance(30_000)
    expect(w.toasts).toEqual(['Claude: Session reached 90%'])
    await w.clock.advance(30_000)
    expect(w.toasts.length).toBe(1)
  })

  test('adds the age to the status line once Augur stops writing usage', async ($, on) => {
    const files = new Map([[USAGE, usage('2026-10-03T18:00:00Z')]])
    const w = world(on, files, [])
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    expect(w.status.at(-1)).toBe('Claude 5h 27% | wk 48% | Grok wk 81% | as of 2h ago')
  })

  test('draws the newest alert above the prompt and dismisses it into the acks file', async ($, on) => {
    const files = new Map<string, string>()
    world(on, files, [])
    for (const [surface, older, newer] of [['terminal', 'a', 'b'], ['desktop', 'c', 'd']] as const) {
      files.set(USAGE, usage())
      files.set(FEED, feed(alert(older, ['claude'], '2026-10-03T19:00:00Z'), alert(newer, ['claude'], '2026-10-03T19:30:00Z')))
      await $.session.start({ cwd: HOME, surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'augur', surface, ...BAND })
      expect(await ui.find({ type: 'Text', text: `Claude: ${newer} (+1 more)` })).toBeDefined()
      expect(await ui.find({ key: 'open' })).toBeUndefined()
      await ui.press({ key: 'dismiss' })
      expect(files.get(ACKS)).toContain(`{"id":"${newer}","at":"2026-10-03T20:00:00.000Z","by":"claude"}`)
      expect(await ui.find({ type: 'Text', text: new RegExp(`^Claude: ${older}$`) })).toBeDefined()
      await ui.unmount()
    }
  })

  test('opens Augur through the path its installer left beside the mod', async ($, on) => {
    const files = new Map([[USAGE, usage()], [FEED, feed(alert('a', ['claude'], '2026-10-03T19:00:00Z'))]])
    world(on, files, [], { exe: 'C:/Program Files/Augur/augur.exe' })
    const ran: string[][] = []
    on('process.run', async (_$, e) => { ran.push([...e.argv]); return { value: { exitCode: 0, stdout: '', stderr: '' } } as never })
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'augur', surface: 'terminal', ...BAND })
    await ui.press({ key: 'open' })
    expect(ran).toEqual([['explorer.exe', 'C:/Program Files/Augur/augur.exe']])
  })

  test('draws nothing above the prompt when no alert is meant for Claude Code', async ($, on) => {
    const files = new Map([[USAGE, usage()], [FEED, feed(alert('a', ['augur'], '2026-10-03T19:00:00Z'))]])
    world(on, files, [])
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'augur', surface: 'terminal', ...BAND })
    expect(await ui.find({ key: 'dismiss' })).toBeUndefined()
  })
})

const liveJob = (id = 'a', stalled = false, sessionId: string | undefined = SESSION) => ({ id, route: 'local', activity: 'write_code', state: 'running', startedAt: NOW - 120000,
  lastActivityAt: NOW - 90000, activityLine: 'Running checks', stalled, ...(sessionId ? { origin: { kind: 'cli', sessionId, sessionTitle: sessionId === SESSION ? 'Augur' : 'Other chat' } } : {}) })
const closedJob = (id = 'z', state = 'completed', sessionId: string | undefined = SESSION) => ({ ...liveJob(id, false, sessionId), state, endedAt: NOW - 60000, exitCode: state === 'completed' ? 0 : 1,
  usage: { inputTokens: 12345, outputTokens: 812, costUsd: 0.0123 } })
const jobsFeed = (updatedAt = NOW, jobs: object[] = [liveJob()], recent: object[] = []) => JSON.stringify({ updatedAt, stallMinutes: 10, jobs, recent })
const flat = (row: PaneRow) => row.lines.map((l) => `${l.label} ${l.segs.map((s) => s.text).join('')}`)
const PANE = { plugin: 'augur', component: 'Pane', requestId: 'augur-jobs', props: { title: 'Augur jobs', isFocused: false,
  bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } } as const

describe('live jobs', () => {
  test('adds job counts to the existing status and omits an empty job list', () => {
    expect(jobStatus([])).toBeUndefined()
    expect(jobStatus([liveJob()] as never)).toBe('1 job')
    const jobs = [liveJob(), liveJob('b', true)] as never[]
    expect(jobStatus(jobs)).toBe('2 jobs (1 stalled)')
    expect(statusLine(JSON.parse(usage()), 1, NOW, 5, jobs)).toBe('Claude 5h 27% | wk 48% | Grok wk 81% | 1 Augur alert | 2 jobs (1 stalled)')
  })

  test('puts stalled rows first and gives each row an origin, job and activity line', () => {
    const jobs = [liveJob(), { ...liveJob('b', true), lastActivityAt: NOW - 7200000 }, { ...liveJob('c'), lastActivityAt: NOW - 3000 }] as never[]
    const rows = paneRows(jobs, NOW, false, SESSION)
    expect(rows.map((row) => row.id)).toEqual(['b', 'a', 'c'])
    expect(rows.map((row) => row.lines.map((l) => l.label))).toEqual(Array(3).fill(['ORIGIN:', 'JOB:', 'TIMING:', 'ACTIVITY:']))
    expect(flat(rows[0]!)).toEqual([
      'ORIGIN: Augur | this session | cli',
      'JOB: b | local | write_code',
      'TIMING: running | STALLED | started 2m ago | elapsed 2m 0s',
      'ACTIVITY: last output 2h ago | Running checks',
    ])
    expect(flat(rows[2]!)[3]).toBe('ACTIVITY: last output 3s ago | Running checks')
    expect(rows[0]!.color).toBe('warning')
    expect(rows[1]!.color).toBe('success')
    expect(jobs[0]).toMatchObject({ id: 'a' })
  })

  test('names the origin when the session title is missing', () => {
    const [bare, noOrigin] = paneRows([{ ...liveJob('a'), origin: { kind: 'cli', sessionId: 'abcdef0123456789' } }, liveJob('b', false, '')] as never[], NOW).map(flat)
    expect(bare![0]).toBe('ORIGIN: session abcdef01 | cli')
    expect(noOrigin![0]).toBe('ORIGIN: no session | unknown origin')
  })

  test('draws closed rows with an origin, job and result line', () => {
    const failed = { ...closedJob('f', 'failed'), reason: 'Route refused: data tier' }
    const [done, bad] = paneRows([closedJob(), failed] as never[], NOW, true, SESSION)
    expect(done!.lines.map((l) => l.label)).toEqual(['ORIGIN:', 'JOB:', 'TIMING:', 'RESULT:', 'USAGE:'])
    expect(flat(done!)[1]).toBe('JOB: z | local | write_code')
    expect(flat(done!)[2]).toBe('TIMING: completed | started 2m ago | ended 1m ago | took 1m 0s')
    expect(flat(done!)[3]).toBe('RESULT: exit 0')
    expect(flat(done!)[4]).toBe('USAGE: 12.3k in / 812 out | $0.0123')
    expect(flat(bad!)[3]).toBe('RESULT: exit 1 | Route refused: data tier')
    expect(bad!.lines[3]!.segs[0]?.color).toBe('error')
  })

  test('rejects missing, malformed, stale and invalid job snapshots', () => {
    for (const text of [null, '', '{', 'null', '{}', jobsFeed(NOW - 60001), JSON.stringify({ updatedAt: NOW, jobs: [null] }), jobsFeed(NOW, [{ ...liveJob(), activityLine: 'x'.repeat(121) }])]) {
      expect(liveJobs(text, NOW)).toEqual([])
    }
    expect(liveJobs(jobsFeed(NOW - 60000), NOW)).toEqual([liveJob()])
  })

  test('keeps closed jobs one by one, even when the live list is stale', () => {
    const stale = jobsFeed(NOW - 120000, [liveJob()], [closedJob('x'), { id: 'bad' }, closedJob('y', 'failed')])
    const parsed = parseJobs(stale, NOW)
    expect(parsed.live).toEqual([])
    expect(parsed.recent.map((j) => j.id)).toEqual(['x', 'y'])
    expect(parseJobs(JSON.stringify({ updatedAt: NOW, stallMinutes: 10, jobs: [] }), NOW).recent).toEqual([])
    const many = Array.from({ length: 40 }, (_, n) => closedJob(`c${n}`))
    expect(parseJobs(jobsFeed(NOW, [], many), NOW).recent).toHaveLength(30)
    expect(parseJobs(jobsFeed(NOW, [], [{ ...closedJob(), state: 'running' }]), NOW).recent).toEqual([])
  })

  test('scopes to this session and summarizes both views', () => {
    const mine = parseJobs(jobsFeed(NOW, [liveJob('a'), liveJob('b', false, 'other')], [closedJob('x'), closedJob('y', 'failed', 'other'), closedJob('z', 'failed', 'other')]), NOW)
    expect(scopeJobs(mine.live, 'session', SESSION).map((j) => j.id)).toEqual(['a'])
    expect(scopeJobs(mine.live, 'all', SESSION)).toHaveLength(2)
    expect(scopeJobs(mine.live, 'session', '')).toHaveLength(2)
    expect(paneHeader(mine.live, mine.recent, 'session', SESSION)).toBe('This session: 1 live, 1 closed | Elsewhere: 1 live, 2 closed')
    expect(paneHeader(mine.live, mine.recent, 'all', SESSION)).toBe('All sessions: 2 live, 3 closed | This session: 1 live, 1 closed')
    expect(paneHeader(mine.live, mine.recent, 'session', '')).toBe('All sessions: 2 live, 3 closed')
    expect(closedSummary(mine.recent)).toBe('2 failed, 1 completed')
  })

  test('draws live jobs on every surface and removes a stale snapshot', async ($, on) => {
    const files = new Map([[JOBS, jobsFeed(NOW, [liveJob(), liveJob('b', true)])]])
    const w = world(on, files)
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    expect(w.status.at(-1)).toBe('2 jobs (1 stalled)')
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: /STALLED/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Running checks/ })).toBeDefined()
      expect(await ui.find({ key: 'scope' })).toBeDefined()
      await ui.unmount()
    }
    await w.clock.advance(65000)
    expect(w.status.at(-1)).toBeUndefined()
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: 'No jobs from this session are running.' })).toBeDefined()
    await ui.unmount()
  })

  test('toggles between this session and every session', async ($, on) => {
    const files = new Map([[JOBS, jobsFeed(NOW, [liveJob('a'), liveJob('b', false, 'other')])]])
    world(on, files)
    await $.session.start({ cwd: HOME, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /Other chat/ })).toBeUndefined()
    await ui.press({ key: 'scope' })
    expect(await ui.find({ type: 'Text', text: /Other chat/ })).toBeDefined()
    await ui.press({ key: 'scope' })
    expect(await ui.find({ type: 'Text', text: /Other chat/ })).toBeUndefined()
    await ui.unmount()
  })

  test('keeps the closed list folded until it is opened', async ($, on) => {
    const files = new Map([[JOBS, jobsFeed(NOW, [], [closedJob('x'), closedJob('y', 'failed', 'other')])]])
    world(on, files)
    await $.session.start({ cwd: HOME, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ key: 'closed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /RESULT:/ })).toBeUndefined()
    await ui.press({ key: 'closed' })
    expect(await ui.find({ type: 'Text', text: /RESULT:/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Other chat/ })).toBeUndefined()
    await ui.press({ key: 'scope' })
    expect(await ui.find({ type: 'Text', text: /Other chat/ })).toBeDefined()
    await ui.press({ key: 'closed' })
    expect(await ui.find({ type: 'Text', text: /RESULT:/ })).toBeUndefined()
    await ui.unmount()
  })

  test('cancels a live job after a second press and shows a note until the service reports it', async ($, on) => {
    const files = new Map([[JOBS, jobsFeed(NOW, [liveJob('a'), liveJob('b')])]])
    world(on, files)
    await $.session.start({ cwd: HOME, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ key: 'cancel-a' })).toBeDefined()
    expect(await ui.find({ key: 'cancel-b' })).toBeDefined()
    await ui.press({ key: 'cancel-a' })
    expect(files.get(CANCELS)).toBeUndefined()
    expect((await ui.find({ key: 'cancel-a' }))?.props).toMatchObject({ label: 'Press again to cancel this job' })
    expect((await ui.find({ key: 'cancel-b' }))?.props).toMatchObject({ label: 'Cancel job' })
    await ui.press({ key: 'cancel-a' })
    expect(files.get(CANCELS)).toBe('{"id":"a","at":"2026-10-03T20:00:00.000Z","by":"claude"}\n')
    expect(await ui.find({ key: 'cancel-a' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Cancelling/ })).toBeDefined()
    expect(await ui.find({ key: 'cancel-b' })).toBeDefined()
    await ui.unmount()
  })

  test('shows a note instead of a button for a job that is already being cancelled, and none on closed cards', async ($, on) => {
    const files = new Map([[JOBS, jobsFeed(NOW, [{ ...liveJob('a'), state: 'cancel_requested' }], [closedJob('x')])]])
    world(on, files)
    await $.session.start({ cwd: HOME, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ key: 'cancel-a' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Cancelling/ })).toBeDefined()
    await ui.press({ key: 'closed' })
    expect(await ui.find({ key: 'cancel-x' })).toBeUndefined()
    await ui.unmount()
  })

  test('adds a second request to the file and offers Open Augur when the installer left its path', async ($, on) => {
    const files = new Map([[JOBS, jobsFeed(NOW, [liveJob('a'), liveJob('b')])]])
    world(on, files, undefined, { exe: 'C:/Program Files/Augur/augur.exe' })
    const ran: string[][] = []
    on('process.run', async (_$, e) => { ran.push([...e.argv]); return { value: { exitCode: 0, stdout: '', stderr: '' } } as never })
    await $.session.start({ cwd: HOME, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    for (const id of ['a', 'b']) { await ui.press({ key: `cancel-${id}` }); await ui.press({ key: `cancel-${id}` }) }
    expect(files.get(CANCELS)!.trim().split('\n').map((l) => JSON.parse(l).id)).toEqual(['a', 'b'])
    await ui.press({ key: 'open-app' })
    expect(ran).toEqual([['explorer.exe', 'C:/Program Files/Augur/augur.exe']])
    await ui.unmount()
  })

  test('opens once per session and allows the slash command', async ($, on) => {
    const files = new Map<string, string>()
    const w = world(on, files)
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    expect(w.opened).toEqual([])
    files.set(JOBS, jobsFeed())
    await w.clock.advance(30000)
    expect(w.opened).toEqual(['augur-jobs'])
    const command = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.unmount()
    await w.clock.advance(5000)
    expect(w.opened).toEqual(['augur-jobs'])
    files.set(JOBS, jobsFeed(NOW + 35000, []))
    await w.clock.advance(5000)
    files.set(JOBS, jobsFeed(NOW + 40000))
    await w.clock.advance(30000)
    expect(w.opened).toEqual(['augur-jobs'])
    expect((await $.command.run({ ...command, command: 'augur-jobs' })).text).toBe('The live jobs pane is open.')
    expect(w.opened).toHaveLength(2)
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    expect(w.opened).toHaveLength(3)
  })

  test('does not open on its own for jobs from another session', async ($, on) => {
    const files = new Map([[JOBS, jobsFeed(NOW, [liveJob('b', false, 'other')])]])
    const w = world(on, files)
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    await w.clock.advance(5000)
    expect(w.opened).toEqual([])
  })

  test('polls live jobs every five seconds and idle jobs every thirty seconds', async ($, on) => {
    const files = new Map<string, string>()
    const w = world(on, files)
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    const reads = () => w.reads.filter((path) => path === JOBS).length
    await w.clock.advance(29000)
    expect(reads()).toBe(1)
    files.set(JOBS, jobsFeed(NOW + 29000))
    await w.clock.advance(1000)
    expect(reads()).toBe(2)
    await w.clock.advance(5000)
    expect(reads()).toBe(3)
    files.delete(JOBS)
    await w.clock.advance(5000)
    expect(w.status.at(-1)).toBeUndefined()
    await w.clock.advance(29000)
    expect(reads()).toBe(4)
    await w.clock.advance(1000)
    expect(reads()).toBe(5)
  })

  test('updates a mounted pane when activity changes and when the snapshot expires', async ($, on) => {
    const files = new Map([[JOBS, jobsFeed()]])
    const w = world(on, files)
    await $.session.start({ cwd: HOME, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    files.set(JOBS, jobsFeed(NOW + 5000, [{ ...liveJob(), activityLine: 'Waiting', lastActivityAt: NOW + 5000 }]))
    await w.clock.advance(5000)
    expect(await ui.find({ type: 'Text', text: /Waiting/ })).toBeDefined()
    await w.clock.advance(65000)
    expect(await ui.find({ type: 'Text', text: 'No jobs from this session are running.' })).toBeDefined()
    await ui.unmount()
  })

  test('does not repeat an automatic open when a surface cannot place the pane', async ($, on) => {
    const files = new Map([[JOBS, jobsFeed()]])
    const w = world(on, files, undefined, undefined, false)
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    await w.clock.advance(5000)
    expect(w.opened).toEqual(['augur-jobs'])
    const result = await $.command.run({ command: 'augur-jobs', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
    expect(result.text).toBe('Waiting for a place to show the pane.')
    expect(w.opened).toHaveLength(2)
  })
})
