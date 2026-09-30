import type { Host, ProviderLinks, ProviderStatus } from './types.js';
import { obj } from './util.js';

const COMPONENT: Record<string, { indicator: ProviderStatus['indicator']; words: string }> = {
  degraded_performance: { indicator: 'minor', words: 'degraded performance' },
  partial_outage: { indicator: 'major', words: 'a partial outage' },
  major_outage: { indicator: 'critical', words: 'a major outage' },
  under_maintenance: { indicator: 'maintenance', words: 'maintenance' },
};
const SEVERITY: ProviderStatus['indicator'][] = ['none', 'maintenance', 'minor', 'major', 'critical'];

/** The worst state among the named components of a Statuspage-style page, or null when the list cannot be read or names nothing on the page. */
async function componentStatus(host: Host, links: ProviderLinks): Promise<ProviderStatus | null> {
  try {
    const response = await host.http({ url: (links.statusApi as string).replace(/status\.json$/, 'components.json'), timeoutMs: 4000, headers: { Accept: 'application/json' } });
    if (response.status !== 200) return null;
    const list = obj(JSON.parse(response.body)).components, wanted = new Set(links.statusComponents);
    const rows = (Array.isArray(list) ? list : []).map(obj).filter(c => !c.group && typeof c.name === 'string' && wanted.has(c.name));
    if (!rows.length) return null;
    let worst: ProviderStatus['indicator'] = 'none', words = '';
    const affected: string[] = [];
    for (const c of rows) {
      const hit = COMPONENT[String(c.status)];
      if (!hit) continue;
      if (!affected.includes(c.name as string)) affected.push(c.name as string);
      if (SEVERITY.indexOf(hit.indicator) > SEVERITY.indexOf(worst)) { worst = hit.indicator; words = hit.words; }
    }
    return { indicator: worst, description: worst === 'none' ? 'All Systems Operational' : `${affected.join(', ')}: ${words}`, url: links.status };
  } catch { return null; }
}

export async function fetchStatus(host: Host, links: ProviderLinks): Promise<ProviderStatus | null> {
  if (!links.statusApi) return null;
  if (links.statusComponents?.length) { const scoped = await componentStatus(host, links); if (scoped) return scoped; }
  try {
    const response = await host.http({ url: links.statusApi, timeoutMs: 4000, headers: { Accept: 'application/json' } });
    if (response.status !== 200) return null;
    const status = obj(obj(JSON.parse(response.body)).status);
    const indicator = String(status.indicator ?? 'unknown');
    if (!['none', 'minor', 'major', 'critical', 'maintenance'].includes(indicator) || typeof status.description !== 'string') return null;
    return { indicator: indicator as ProviderStatus['indicator'], description: status.description, url: links.status };
  } catch { return null; }
}
