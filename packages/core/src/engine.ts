import type { AppConfig, Host, ProviderPlugin, ProviderSnapshot, Snapshot } from './types.js';
import { builtinProviders } from './providers/index.js';
import { genericProvider } from './generic.js';
import { fetchStatus } from './status.js';
import { userError } from './util.js';

export interface CollectOptions {
  /** Refresh every provider now, ignoring per-provider intervals. */
  force?: boolean;
}

export async function collect(host: Host, config: AppConfig, previous?: Snapshot | null, plugins: ProviderPlugin[] = builtinProviders, options: CollectOptions = {}): Promise<Snapshot> {
  const now = (host.now?.() ?? new Date()).getTime();
  const available = new Map([...plugins, ...config.custom.map(genericProvider)].map(plugin => [plugin.id, plugin]));
  const entries = await Promise.all(config.providers.filter(row => row.enabled && available.has(row.id)).map(async row => {
    const plugin = available.get(row.id)!;
    // A provider with its own interval keeps its last good reading until that interval passes.
    const interval = row.refreshSeconds ?? plugin.refreshSeconds ?? 0;
    const last = previous?.providers[row.id];
    if (!options.force && interval > 0 && last?.ok && last.fetchedAt && now - Date.parse(last.fetchedAt) < interval * 1000) return [row.id, last] as const;
    const status = await fetchStatus(host, plugin.links);
    try {
      const result = await plugin.fetch(host, row.settings);
      const item: ProviderSnapshot = { ...result, id: plugin.id, name: plugin.name, ok: true, stale: false,
        fetchedAt: (host.now?.() ?? new Date()).toISOString(), error: null, links: plugin.links, status };
      return [row.id, item] as const;
    } catch (error) {
      const old = previous?.providers[row.id];
      const carried = old?.fetchedAt ? { ...old, id: plugin.id, name: plugin.name, ok: false, stale: true,
        error: userError(error), links: plugin.links, status: status ?? old.status } :
        { id: plugin.id, name: plugin.name, ok: false, stale: false, fetchedAt: null, error: userError(error), links: plugin.links,
          status, plan: null, meters: [], money: [], notes: {} };
      return [row.id, carried as ProviderSnapshot] as const;
    }
  }));
  return { schema: 1, generatedAt: (host.now?.() ?? new Date()).toISOString(), providers: Object.fromEntries(entries) };
}
