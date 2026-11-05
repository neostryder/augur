/** An alert from Augur's alerts.json, as the mod keeps it. */
export type ModAlert = { id: string; title: string; body: string; severity: 'info' | 'warn' | 'crit'; raisedAt: string }

export type ModJob = { id: string; route: string; activity: string; state: string; startedAt: number | null; lastActivityAt: number; activityLine: string; stalled: boolean }

declare module 'claude-code' {
  interface PluginState {
    augur: { alerts: ModAlert[]; canOpen: boolean; jobs: Shaped<ModJob[]>; jobsOpened: boolean }
  }
}
