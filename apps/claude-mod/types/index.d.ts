/** An alert from Augur's alerts.json, as the mod keeps it. */
export type ModAlert = { id: string; title: string; body: string; severity: 'info' | 'warn' | 'crit'; raisedAt: string }

/** Where a job came from, as the service reports it. Every field is optional because older services leave some out. */
export type ModOrigin = { kind?: string; label?: string; sessionId?: string; sessionTitle?: string; host?: string; pid?: number; intent?: string }

export type ModUsage = { inputTokens: number; outputTokens: number; costUsd?: number }

/** A job from jobs-live.json. The first eight fields are always there, and the rest are optional so the pane still draws with an older service. */
export type ModJob = {
  id: string; route: string; activity: string; state: string; startedAt: number | null; lastActivityAt: number; activityLine: string; stalled: boolean
  createdAt?: number; endedAt?: number; exitCode?: number; reason?: string; dataTier?: string; tools?: string; depth?: number; parentJobId?: string; cwd?: string
  named?: boolean; model?: string; summary?: string; origin?: ModOrigin; usage?: ModUsage
}

declare module 'claude-code' {
  interface PluginState {
    augur: {
      alerts: ModAlert[]; canOpen: boolean; jobs: Shaped<ModJob[]>; recent: Shaped<ModJob[]>; jobsOpened: boolean
      /** This session's id, so the pane can tell its own jobs from the rest. */
      mySession: string
      /** What the pane lists: `session` for this session's jobs or `all`. */
      scope: string
      closedOpen: boolean
    }
  }
}
