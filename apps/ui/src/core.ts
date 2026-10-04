// The one place the UI touches the core package, so a renamed export is a one-line fix.
import {
  appendHistoryRows, calculatePace, collectFor, defaultConfig as coreDefault, dueFor, migrateConfig as coreMigrate, usageAlerts,
} from '@augur/core';
import type { AppConfig, HistoryRow as CoreRow, Host, Meter, PaceResult, Snapshot, UsageAlert } from '@augur/core';

export type HistoryRow = CoreRow;
export type Pace = PaceResult;
export type Alert = UsageAlert;

export { allPlugins as plugins, policyProviders, detectProvider as detect, HISTORY_KEEP_S } from '@augur/core';

export const defaultConfig = (): AppConfig => coreDefault();
export const migrateConfig = (raw: unknown): AppConfig => coreMigrate(raw);

export function collect(host: Host, config: AppConfig, prev: Snapshot | null, force = false): Promise<Snapshot> {
  return collectFor(host, config, prev, force);
}

/** The enabled providers whose own interval has passed. */
export function dueProviders(config: AppConfig, prev: Snapshot | null): string[] {
  return dueFor(config, prev);
}

export { DEFAULT_REFRESH_SECONDS } from '@augur/core';

export function appendHistory(rows: HistoryRow[], snap: Snapshot): HistoryRow[] {
  return appendHistoryRows(rows, snap);
}

export function series(rows: HistoryRow[], providerId: string, meterId: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const r of rows) {
    const p = r[providerId];
    const v = typeof p === 'object' ? p[meterId] : undefined;
    if (typeof v === 'number') out.push([new Date(r.t).getTime(), v]);
  }
  return out;
}

export function pace(meter: Meter, rows: HistoryRow[], providerId: string): Pace | null {
  if (meter.usedPct == null || !meter.resetsAt || !meter.windowSeconds) return null;
  try { return calculatePace(meter, rows, providerId, new Date()); } catch { return null; }
}

export function evaluateAlerts(snap: Snapshot, rows: HistoryRow[], config: AppConfig, state: Record<string, unknown>): { alerts: Alert[]; firedState: Record<string, unknown> } {
  return usageAlerts(snap, rows, config, state);
}
