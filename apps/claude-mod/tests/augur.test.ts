import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = 'C:/Users/test'
const USAGE = `${HOME}/.augur/usage.json`
const FEED = `${HOME}/.augur/alerts.json`
const ACKS = `${HOME}/.augur/alerts-acks.jsonl`
const NOW = Date.parse('2026-10-03T20:00:00Z')

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
function world(on: On, files: Map<string, string>, seen?: string[], app?: object) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, seen ? { seen } : {})
  mock.env(on, { USERPROFILE: HOME })
  const toasts: string[] = []
  const status: Array<string | undefined> = []
  // The engine hands paths over with the platform's separator.
  const at = (path: string) => path.replace(/\\/g, '/')
  on('fs.read', async (_$, e) => {
    // augur-app.json sits beside the mod, wherever the test runs it from.
    const text = app && at(e.path).endsWith('/augur-app.json') ? JSON.stringify(app) : files.get(at(e.path))
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', async (_$, e) => { files.set(at(e.path), e.text); return { value: undefined } })
  on('ui.toast', async (_$, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.status', async (_$, e) => { status.push(e.text); return { value: undefined } })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  // The engine draws nothing of its own above the prompt.
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
  return { clock, toasts, status }
}

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as const

describe('the Augur mod', () => {
  test('shows Claude, the hot providers and the alert count in the status line', async ($, on) => {
    const files = new Map([[USAGE, usage()], [FEED, feed(alert('a', ['augur', 'claude'], '2026-10-03T19:00:00Z'), alert('b', ['augur'], '2026-10-03T19:10:00Z'))]])
    const w = world(on, files, [])
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    expect(w.status.at(-1)).toBe('Claude 5h 27% | wk 48% | Grok wk 81% | 1 Augur alert')
  })

  test('toasts an alert once when it first appears, and not the ones already there on the first run', async ($, on) => {
    const files = new Map([[USAGE, usage()], [FEED, feed(alert('old', ['claude'], '2026-10-03T19:00:00Z'))]])
    const w = world(on, files)
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    expect(w.toasts).toEqual([])
    files.set(FEED, feed(alert('new', ['claude'], '2026-10-03T19:30:00Z', 'Claude: Session reached 90%'), alert('old', ['claude'], '2026-10-03T19:00:00Z')))
    await w.clock.advance(30_000)
    expect(w.toasts).toEqual(['Augur: Claude: Session reached 90%'])
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
