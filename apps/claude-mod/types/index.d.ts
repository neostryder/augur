/** An alert from Augur's alerts.json, as the mod keeps it. */
export type ModAlert = { id: string; title: string; body: string; severity: 'info' | 'warn' | 'crit'; raisedAt: string }

declare module 'claude-code' {
  interface PluginState {
    augur: { alerts: ModAlert[]; canOpen: boolean }
  }
}
