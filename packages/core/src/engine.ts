import type { AppConfig, Host, ProviderPlugin, ProviderSnapshot, Snapshot } from './types.js';
import { builtinProviders } from './providers/index.js';
import { genericProvider } from './generic.js';
import { fetchStatus } from './status.js';
import { userError } from './util.js';

export interface CollectOptions {
  /** Refresh every provider now, ignoring per-provider intervals. */
  force?: boolean;
}

/** How often a provider is read when neither it nor the user sets an interval. */
export const DEFAULT_REFRESH_SECONDS = 900;
/** A provider whose last read failed tries again after this long, or its own interval if shorter. */
export const RETRY_SECONDS = 300;

export function refreshInterval(config: AppConfig, plugin: ProviderPlugin): number {
  return config.providers.find(row => row.id === plugin.id)?.refreshSeconds ?? plugin.refreshSeconds ?? DEFAULT_REFRESH_SECONDS;
}

/** True when a provider's interval has passed since it was last read, or it has never been read. */
export function isDue(interval: number, last: ProviderSnapshot | undefined, now: number): boolean {
  const at = last?.attemptedAt ?? last?.fetchedAt;
  if (!last || !at) return true;
  const wait = last.ok ? interval : Math.min(interval, RETRY_SECONDS);
  return now - Date.parse(at) >= wait * 1000;
}

/** The enabled providers that a scheduled refresh would read now. */
export function dueProviders(config: AppConfig, previous: Snapshot | null | undefined, plugins: ProviderPlugin[] = builtinProviders, now = Date.now()): string[] {
  const available = new Map([...plugins, ...config.custom.map(genericProvider)].map(plugin => [plugin.id, plugin]));
  return config.providers.filter(row => row.enabled && available.has(row.id))
    .filter(row => isDue(refreshInterval(config, available.get(row.id)!), previous?.providers[row.id], now)).map(row => row.id);
}

export async function collect(host: Host, config: AppConfig, previous?: Snapshot | null, plugins: ProviderPlugin[] = builtinProviders, options: CollectOptions = {}): Promise<Snapshot> {
  const now = (host.now?.() ?? new Date()).getTime();
  const available = new Map([...plugins, ...config.custom.map(genericProvider)].map(plugin => [plugin.id, plugin]));
  const entries = await Promise.all(config.providers.filter(row => row.enabled && available.has(row.id)).map(async row => {
    const plugin = available.get(row.id)!;
    // Each provider keeps its last reading until its own interval passes.
    const last = previous?.providers[row.id];
    if (!options.force && last && !isDue(refreshInterval(config, plugin), last, now)) return [row.id, last] as const;
    const attemptedAt = new Date(now).toISOString();
    const status = await fetchStatus(host, plugin.links);
    try {
      const result = await plugin.fetch(host, row.settings);
      const item: ProviderSnapshot = { ...result, id: plugin.id, name: plugin.name, ok: true, stale: false,
        fetchedAt: (host.now?.() ?? new Date()).toISOString(), attemptedAt, error: null, links: plugin.links, status };
      return [row.id, item] as const;
    } catch (error) {
      const old = previous?.providers[row.id];
      const carried = old?.fetchedAt ? { ...old, id: plugin.id, name: plugin.name, ok: false, stale: true, attemptedAt,
        error: userError(error), links: plugin.links, status: status ?? old.status } :
        { id: plugin.id, name: plugin.name, ok: false, stale: false, fetchedAt: null, attemptedAt, error: userError(error), links: plugin.links,
          status, plan: null, meters: [], money: [], notes: {} };
      return [row.id, carried as ProviderSnapshot] as const;
    }
  }));
  return { schema: 1, generatedAt: (host.now?.() ?? new Date()).toISOString(), providers: Object.fromEntries(entries) };
}
