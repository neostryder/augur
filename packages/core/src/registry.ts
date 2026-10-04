// The provider list for a config and the small helpers every view and the engine share.
import { builtinProviders } from './providers/index.js';
import { genericProvider } from './generic.js';
import { collect, dueProviders } from './engine.js';
import { appendHistory } from './history.js';
import { evaluateAlerts, type Alert } from './alerts.js';
import { RULES_ONLY_PROVIDERS, resolveThresholds } from './policy.js';
import type { HistoryRow } from './history.js';
import type { AppConfig, Host, ProviderPlugin, Snapshot } from './types.js';

/** History keeps eight days, one more than the longest window a chart shows. */
export const HISTORY_KEEP_S = 8 * 86400;

/** The built-in providers, then the custom ones whose definitions parse. */
export function allPlugins(config: AppConfig): ProviderPlugin[] {
  const custom = (config.custom ?? []).flatMap((def) => {
    try { return [genericProvider(def)]; } catch { return []; }
  });
  return [...builtinProviders, ...custom];
}

/** Every provider the rules page lists: the ones Augur reads usage for, then the rules-only ones. */
export function policyProviders(config: AppConfig): Array<{ id: string; name: string; metered: boolean }> {
  const metered = allPlugins(config).map((p) => ({ id: p.id, name: p.name, metered: true }));
  return [...metered, ...RULES_ONLY_PROVIDERS.filter((r) => !metered.some((m) => m.id === r.id)).map(({ id, name }) => ({ id, name, metered: false }))];
}

/** Models still waiting for their rules to be confirmed. */
export function pendingCount(config: AppConfig): number {
  return Object.values(config.policy?.providers ?? {}).reduce((n, p) => n + Object.values(p.models).filter((x) => x.status === 'unreviewed' || x.status === 'imported').length, 0);
}

/** Keeps one ProviderConfig per known plugin, preserving the user's order. */
export function syncProviderList(config: AppConfig): void {
  const known = new Set(allPlugins(config).map((p) => p.id));
  config.providers = config.providers.filter((p) => known.has(p.id));
  for (const id of known) if (!config.providers.some((p) => p.id === id)) config.providers.push({ id, enabled: false, settings: {} });
}

/** Secret names a provider needs before it can read anything. */
export function requiredSecrets(p: ProviderPlugin): string[] {
  return p.fields.filter((f) => f.kind === 'secret' && f.required !== false).map((f) => `${p.id}.${f.key}`);
}

/** Every secret name a provider field can hold. */
export function secretNames(config: AppConfig): string[] {
  return allPlugins(config).flatMap((p) => p.fields.filter((f) => f.kind === 'secret').map((f) => `${p.id}.${f.key}`));
}

export function collectFor(host: Host, config: AppConfig, prev: Snapshot | null, force = false): Promise<Snapshot> {
  return collect(host, config, prev, allPlugins(config), { force });
}

/** The enabled providers whose own interval has passed. */
export function dueFor(config: AppConfig, prev: Snapshot | null): string[] {
  return dueProviders(config, prev, allPlugins(config));
}

export function appendHistoryRows(rows: HistoryRow[], snap: Snapshot): HistoryRow[] {
  return appendHistory(rows, snap, HISTORY_KEEP_S);
}

export interface UsageAlert { key: string; title: string; body: string; usage: Alert }

/** Usage alerts for a snapshot, with a provider's spent point taken from its rules. */
export function usageAlerts(snap: Snapshot, rows: HistoryRow[], config: AppConfig, state: Record<string, unknown>): { alerts: UsageAlert[]; firedState: Record<string, unknown> } {
  const spentAt = Object.fromEntries(Object.entries(config.policy?.providers ?? {}).map(([id, p]) => [id, resolveThresholds(p).denyPct]));
  const r = evaluateAlerts(snap, rows, config.alerts, state as Record<string, boolean | number>, { spentAt });
  return {
    alerts: r.alerts.map((a) => ({ key: a.key, title: snap.providers[a.providerId]?.name ?? 'Augur', body: a.message, usage: a })),
    firedState: r.firedState,
  };
}

export async function detectProvider(p: ProviderPlugin, h: Host): Promise<boolean> {
  try { return p.detect ? await p.detect(h) : false; } catch { return false; }
}
