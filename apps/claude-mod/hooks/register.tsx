import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { ModAlert } from '../types'
import { JOBS_TEXT, PACE_BAND, alertText, claudeAlerts, closedSummary, folderOf, paneHeader, paneRows, parseJobs, scopeJobs, statusLine, withAck, type Usage } from './view'
import { LABEL_COLORS, type PaneRow, type Seg } from './jobs'

const ALERTS = { plugin: 'augur', key: 'alerts' } as const
const CAN_OPEN = { plugin: 'augur', key: 'canOpen' } as const
const PANE = 'augur-jobs'
const jobs = atom({ plugin: 'augur', key: 'jobs' } as const, [], { shape: 'jobs-2' })
const recent = atom({ plugin: 'augur', key: 'recent' } as const, [], { shape: 'jobs-2' })
const jobsOpened = atom({ plugin: 'augur', key: 'jobsOpened' } as const, false)
const mySession = atom({ plugin: 'augur', key: 'mySession' } as const, '')
const scope = atom({ plugin: 'augur', key: 'scope' } as const, 'session')
const closedOpen = atom({ plugin: 'augur', key: 'closedOpen' } as const, false)
/** The job whose Cancel button was pressed once and now asks for a second press. */
const confirming = atom({ plugin: 'augur', key: 'confirming' } as const, '')
/** Jobs whose cancel request has been written, so their button gives way to a note until the service reports the new state. */
const cancelling = atom({ plugin: 'augur', key: 'cancelling' } as const, [] as string[])
const LABEL_WIDTH = 10

/** Augur rewrites usage.json about once a minute, so a 30-second poll keeps the status line close to it. */
const POLL_MS = 30_000
const LIVE_POLL_MS = 5000
/** Toasted alert ids are remembered across sessions, so a new session does not toast old alerts again. */
const SEEN_KEEP = 200

/** Written by Augur's installer beside this mod: where Augur writes its usage file and where the app is. */
type AppInfo = { usageFile?: string; exe?: string }

let usageFile = ''
let exe = ''
let lastAlerts: string | null = null
let usage: Usage | null = null
let band = PACE_BAND
let pollTimer: ReturnType<EngineInterface['clock']['after']> | undefined

async function readText($: EngineInterface, path: string): Promise<string | null> {
  return $.fs.read(path).then((t) => t as string, () => null)
}

async function currentAlerts($: EngineInterface): Promise<ModAlert[]> {
  return (await $.state.get(ALERTS)).value ?? []
}

async function showStatus($: EngineInterface) {
  $.ui.status(statusLine(usage, (await currentAlerts($)).length, await $.clock.now(), band, await read($, jobs)))
}

async function poll($: EngineInterface) {
  const usageText = await readText($, usageFile)
  try { usage = usageText ? (JSON.parse(usageText) as Usage) : null } catch { usage = null }
  // The owner may have moved the pace band, so the line reads it from the rules Augur writes beside the usage file.
  try {
    const rules = JSON.parse((await readText($, `${folderOf(usageFile)}/policy.json`)) ?? '{}') as { balance?: { claude?: { provider?: unknown; band?: unknown }; pace?: Record<string, { band?: unknown } | undefined> } }
    // A saved file keeps the band on pace.<provider>; a file not yet saved since the upgrade still has it on claude.
    const steered = typeof rules.balance?.claude?.provider === 'string' && rules.balance.claude.provider ? rules.balance.claude.provider : 'claude'
    const set = rules.balance?.pace?.[steered]?.band ?? rules.balance?.claude?.band
    band = typeof set === 'number' && Number.isFinite(set) && set >= 0 ? set : PACE_BAND
  } catch { band = PACE_BAND }
  const text = await readText($, `${folderOf(usageFile)}/alerts.json`)
  if (text !== lastAlerts) {
    lastAlerts = text
    const list = claudeAlerts(text)
    const stored = await $.store.get('seen')
    const seen = Array.isArray(stored) ? (stored as string[]) : null
    // On the first run every alert already there counts as seen, so installing the mod does not set off a burst of toasts.
    if (seen) for (const a of list.filter((x) => !seen.includes(x.id)).reverse()) $.ui.toast(alertText(a), { timeoutMs: 8000 })
    await $.store.set('seen', [...new Set([...list.map((a) => a.id), ...(seen ?? [])])].slice(0, SEEN_KEEP))
    await $.state.set(ALERTS, list)
  }
  const parsed = parseJobs(await readText($, `${folderOf(usageFile)}/jobs-live.json`), await $.clock.now())
  const list = parsed.live
  await update($, jobs, () => list)
  await update($, recent, () => parsed.recent)
  await update($, cancelling, (ids) => ids.filter((id) => list.some((j) => j.id === id)))
  const mine = await read($, mySession)
  if (scopeJobs(list, await read($, scope), mine).length && !await read($, jobsOpened)) {
    await update($, jobsOpened, () => true)
    await $.ui.open({ id: PANE, title: JOBS_TEXT.title })
  }
  await showStatus($)
  pollTimer = $.clock.after(list.length ? LIVE_POLL_MS : POLL_MS, () => { void poll($) })
}

async function dismiss($: EngineInterface, id: string) {
  await $.state.set(ALERTS, (await currentAlerts($)).filter((a) => a.id !== id))
  await showStatus($)
  // Augur applies the line on its next check and drops the alert everywhere it shows.
  const file = `${folderOf(usageFile)}/alerts-acks.jsonl`
  await $.fs.write(file, withAck(await readText($, file), id, new Date(await $.clock.now()).toISOString()))
}

async function cancelJob($: EngineInterface, id: string) {
  // The service applies the line within a couple of seconds and empties the file.
  const file = `${folderOf(usageFile)}/cancel-requests.jsonl`
  await $.fs.write(file, withAck(await readText($, file), id, new Date(await $.clock.now()).toISOString()))
  await update($, confirming, () => '')
  await update($, cancelling, (ids) => [...new Set([...ids, id])])
}

async function openAugur($: EngineInterface) {
  // Starting Augur again hands over to the running copy, which shows its panel.
  const argv = /\.exe$/i.test(exe) ? ['explorer.exe', exe] : /\.app$/i.test(exe) ? ['open', exe] : [exe]
  await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => undefined)
}

async function start($: EngineInterface) {
  pollTimer?.cancel()
  lastAlerts = null
  await update($, jobsOpened, () => false)
  const id = await $.session.id().catch(() => '')
  await update($, mySession, () => id)
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '~'
  let info: AppInfo = {}
  try { info = JSON.parse((await readText($, `${$.plugin.root}/augur-app.json`)) ?? '{}') as AppInfo } catch { /* defaults below */ }
  usageFile = info.usageFile || `${home}/.augur/usage.json`
  exe = info.exe ?? ''
  await $.state.set(CAN_OPEN, !!exe)
  await poll($)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: PANE, description: JOBS_TEXT.description })
    const started = await next(e)
    await start($)
    return started
  })

  on('command.run', { command: PANE }, async ($) => {
    await update($, jobsOpened, () => true)
    const opened = await $.ui.open({ id: PANE, title: JOBS_TEXT.title })
    return { text: opened.isPlaced ? JOBS_TEXT.opened : JOBS_TEXT.waiting }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const [allLive, allClosed, view, mine, open] = [await read($, jobs), await read($, recent), await read($, scope), await read($, mySession), await read($, closedOpen)]
    const [sure, asked] = [await read($, confirming), await read($, cancelling)]
    const canOpen = (await $.state.get(CAN_OPEN)).value === true
    const liveRows = paneRows(scopeJobs(allLive, view, mine), now, false, mine)
    const closedJobs = scopeJobs(allClosed, view, mine)
    const closedRows = paneRows(closedJobs, now, true, mine)
    const seg = (s: Seg, i: number, closed: boolean) => (
      <Text key={String(i)} color={s.color} backgroundColor={s.bg} bold={s.bold} italic={s.italic} underline={s.underline} dimColor={s.dim || (closed && !s.bg && !s.bold)}>{s.text}</Text>
    )
    // The border and line labels keep state and job details visually distinct.
    // A live card ends with a Cancel button that asks twice, because a cancel stops the work. Once asked, it gives way to a note.
    const stopper = (row: PaneRow) => (
      row.state === 'cancel_requested' || asked.includes(row.id)
        ? <Text color="warning" italic>{JOBS_TEXT.cancelling}</Text>
        : <Button key={`cancel-${row.id}`} label={sure === row.id ? JOBS_TEXT.cancelSure : JOBS_TEXT.cancel} onPress={() => (sure === row.id ? cancelJob($, row.id) : update($, confirming, () => row.id))} />
    )
    const draw = (row: PaneRow) => (
      <Box key={`${row.closed ? 'closed' : 'live'}-${row.id}`} flexDirection="column" borderStyle="round" borderColor={row.closed ? 'inactive' : row.color} paddingX={1} marginBottom={1}>
        {row.lines.map((l) => (
          <Text key={l.label}>
            <Text bold color={LABEL_COLORS[l.kind]}>{l.label.padEnd(LABEL_WIDTH)}</Text>
            {l.segs.map((s, i) => seg(s, i, row.closed))}
          </Text>
        ))}
        {row.closed ? null : stopper(row)}
      </Box>
    )
    const heading = (label: string, n: number, bg: string) => (
      <Box>
        <Text bold color="inverseText" backgroundColor={bg}>{` ${label} `}</Text>
        <Text bold color={bg}>{` ${n}`}</Text>
      </Box>
    )
    const byState = closedSummary(closedJobs)
    return (
      <Box flexDirection="column">
        <Text bold color="claude">{JOBS_TEXT.title}</Text>
        <Text color="subtle">{paneHeader(allLive, allClosed, view, mine)}</Text>
        {canOpen ? <Button key="open-app" label={JOBS_TEXT.openApp} hotkey="a" onPress={() => openAugur($)} /> : null}
        {mine
          ? <Button key="scope" label={view === 'session' ? JOBS_TEXT.showAll : JOBS_TEXT.showSession} hotkey="f" onPress={() => update($, scope, (v) => (v === 'session' ? 'all' : 'session'))} />
          : null}
        <Box marginTop={1} flexDirection="column">
          {heading(JOBS_TEXT.live.toUpperCase(), liveRows.length, 'success')}
          {liveRows.length ? liveRows.map(draw) : <Text italic color="subtle">{view === 'session' && mine ? JOBS_TEXT.emptyScope : JOBS_TEXT.empty}</Text>}
        </Box>
        <Box marginTop={1}>
          <Button key="closed" label={`${open ? '[-]' : '[+]'} ${JOBS_TEXT.closedHeading} (${closedRows.length})${byState ? `: ${byState}` : ''}`} hotkey="c" onPress={() => update($, closedOpen, (v) => !v)} />
        </Box>
        {open ? <Box marginTop={1} flexDirection="column">{closedRows.length ? closedRows.map(draw) : <Text italic color="subtle">{JOBS_TEXT.noClosed}</Text>}</Box> : null}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await currentAlerts($)
    const newest = list[0]
    if (e.props.hasSurvey || !newest) return next(e)
    const open = (await $.state.get(CAN_OPEN)).value === true
    const { Box, Button, Text } = $.ui.resolve(e)
    const color = newest.severity === 'crit' ? 'red' : newest.severity === 'warn' ? 'yellow' : undefined
    return (
      <Box flexDirection="row" alignItems="center">
        <Text bold color={color}>Augur </Text>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">{alertText(newest)}{list.length > 1 ? ` (+${list.length - 1} more)` : ''}</Text>
        </Box>
        <Button key="dismiss" label="Dismiss" hotkey="d" onPress={() => dismiss($, newest.id)} />
        {open ? <Button key="open" label="Open Augur" hotkey="o" onPress={() => openAugur($)} /> : null}
      </Box>
    )
  })
}
