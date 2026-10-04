import type { EngineInterface, Register } from 'claude-code'

import type { ModAlert } from '../types'
import { alertText, claudeAlerts, folderOf, statusLine, withAck, type Usage } from './view'

const ALERTS = { plugin: 'augur', key: 'alerts' } as const
const CAN_OPEN = { plugin: 'augur', key: 'canOpen' } as const

/** Augur rewrites usage.json about once a minute, so a 30-second poll keeps the status line close to it. */
const POLL_MS = 30_000
/** Toasted alert ids are remembered across sessions, so a new session does not toast old alerts again. */
const SEEN_KEEP = 200

/** Written by Augur's installer beside this mod: where Augur writes its usage file and where the app is. */
type AppInfo = { usageFile?: string; exe?: string }

let usageFile = ''
let exe = ''
let lastAlerts: string | null = null
let usage: Usage | null = null

async function readText($: EngineInterface, path: string): Promise<string | null> {
  return $.fs.read(path).then((t) => t as string, () => null)
}

// State goes through $.state directly: the validator follows $ into functions in this file, never into an import such as atom and read.
async function currentAlerts($: EngineInterface): Promise<ModAlert[]> {
  return (await $.state.get(ALERTS)).value ?? []
}

async function showStatus($: EngineInterface) {
  $.ui.status(statusLine(usage, (await currentAlerts($)).length, await $.clock.now()))
}

async function poll($: EngineInterface) {
  const usageText = await readText($, usageFile)
  try { usage = usageText ? (JSON.parse(usageText) as Usage) : null } catch { usage = null }
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
  await showStatus($)
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
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '~'
  let info: AppInfo = {}
  try { info = JSON.parse((await readText($, `${$.plugin.root}/augur-app.json`)) ?? '{}') as AppInfo } catch { /* defaults below */ }
  usageFile = info.usageFile || `${home}/.augur/usage.json`
  exe = info.exe ?? ''
  await $.state.set(CAN_OPEN, !!exe)
  await poll($)
  $.clock.every(POLL_MS, () => { void poll($) })
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await start($)
    return started
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
