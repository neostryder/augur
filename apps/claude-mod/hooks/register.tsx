import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { ModAlert } from '../types'
import { JOBS_TEXT, PACE_BAND, alertText, claudeAlerts, folderOf, liveJobs, paneRows, statusLine, withAck, type Usage } from './view'

const ALERTS = { plugin: 'augur', key: 'alerts' } as const
const CAN_OPEN = { plugin: 'augur', key: 'canOpen' } as const
const PANE = 'augur-jobs'
const jobs = atom({ plugin: 'augur', key: 'jobs' } as const, [], { shape: 'jobs-1' })
const jobsOpened = atom({ plugin: 'augur', key: 'jobsOpened' } as const, false)

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
  const list = liveJobs(await readText($, `${folderOf(usageFile)}/jobs-live.json`), await $.clock.now())
  await update($, jobs, () => list)
  if (list.length && !await read($, jobsOpened)) {
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

async function openAugur($: EngineInterface) {
  // Starting Augur again hands over to the running copy, which shows its panel.
  const argv = /\.exe$/i.test(exe) ? ['explorer.exe', exe] : /\.app$/i.test(exe) ? ['open', exe] : [exe]
  await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => undefined)
}

async function start($: EngineInterface) {
  pollTimer?.cancel()
  lastAlerts = null
  await update($, jobsOpened, () => false)
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
    const { Box, Text } = $.ui.resolve(e)
    const rows = paneRows(await read($, jobs), await $.clock.now())
    return (
      <Box flexDirection="column">
        <Text bold>{JOBS_TEXT.title}</Text>
        {rows.length ? rows.map((row) => <Text color={row.stalled ? 'yellow' : undefined}>{row.text}</Text>) : <Text dimColor>{JOBS_TEXT.empty}</Text>}
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
