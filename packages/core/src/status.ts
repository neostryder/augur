import type { Host, ProviderLinks, ProviderStatus } from './types.js';
import { obj } from './util.js';

export async function fetchStatus(host: Host, links: ProviderLinks): Promise<ProviderStatus | null> {
  if (!links.statusApi) return null;
  try {
    const response = await host.http({ url: links.statusApi, timeoutMs: 4000, headers: { Accept: 'application/json' } });
    if (response.status !== 200) return null;
    const status = obj(obj(JSON.parse(response.body)).status);
    const indicator = String(status.indicator ?? 'unknown');
    if (!['none', 'minor', 'major', 'critical', 'maintenance'].includes(indicator) || typeof status.description !== 'string') return null;
    return { indicator: indicator as ProviderStatus['indicator'], description: status.description, url: links.status };
  } catch { return null; }
}
