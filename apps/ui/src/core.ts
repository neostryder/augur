// The one place the UI touches the core package, so a renamed export is a one-line fix.
import {
  appendHistory as coreAppend, builtinProviders, calculatePace, collect as coreCollect, defaultConfig as coreDefault, dueProviders as coreDue,
  evaluateAlerts as coreAlerts, genericProvider, migrateConfig as coreMigrate,
} from '@augur/core';
import type { AppConfig, HistoryRow as CoreRow, Host, Meter, PaceResult, ProviderPlugin, Snapshot } from '@augur/core';

export type HistoryRow = CoreRow;
export type Pace = PaceResult;
export interface Alert { key: string; title: string; body: string }

export const HISTORY_KEEP_S = 8 * 86400;

export function plugins(config: AppConfig): ProviderPlugin[] {
  const custom = (config.custom ?? []).flatMap((def) => {
    try { return [genericProvider(def)]; } catch { return []; }
  });
  return [...builtinProviders, ...custom];
}

export const defaultConfig = (): AppConfig => coreDefault();
export const migrateConfig = (raw: unknown): AppConfig => coreMigrate(raw);

export function collect(host: Host, config: AppConfig, prev: Snapshot | null, force = false): Promise<Snapshot> {
  return coreCollect(host, config, prev, plugins(config), { force });
}

/** The enabled providers whose own interval has passed. */
export function dueProviders(config: AppConfig, prev: Snapshot | null): string[] {
  return coreDue(config, prev, plugins(config));
}

export { DEFAULT_REFRESH_SECONDS } from '@augur/core';

export function appendHistory(rows: HistoryRow[], snap: Snapshot): HistoryRow[] {
  return coreAppend(rows, snap, HISTORY_KEEP_S);
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

export function evaluateAlerts(snap: Snapshot, rows: HistoryRow[], config: AppConfig, state: Record<string, unknown>):
  { alerts: Alert[]; firedState: Record<string, unknown> } {
  const r = coreAlerts(snap, rows, config.alerts, state as Record<string, boolean>);
  return {
    alerts: r.alerts.map((a) => ({ key: a.key, title: snap.providers[a.providerId]?.name ?? 'Augur', body: a.message })),
    firedState: r.firedState,
  };
}

export async function detect(p: ProviderPlugin, h: Host): Promise<boolean> {
  try { return p.detect ? await p.detect(h) : false; } catch { return false; }
}
