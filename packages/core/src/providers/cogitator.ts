import type { ProviderPlugin } from '../types.js';
import { HttpError, json } from '../util.js';
import { readFleet } from '../fleet.js';

export const DEFAULT_BASE = 'http://127.0.0.1:8470';

/** The address the key is sent to. A key only goes over https, or over http to a machine on the home network (a name without dots, a private address or .local), never across the internet in the clear. */
export function baseOf(settings: Record<string, unknown>): string {
  const raw = typeof settings.baseUrl === 'string' ? settings.baseUrl.trim().replace(/\/+$/, '') : '';
  if (!raw) return DEFAULT_BASE;
  const m = raw.match(/^(https?):\/\/(\[[^\]]+\]|[^/:\s]+)(:\d+)?(\/.*)?$/);
  if (!m) throw new Error('Invalid base URL: it must start with http:// or https://.');
  const host = m[2]!.toLowerCase();
  const home = host === 'localhost' || host === '[::1]' || !host.includes('.') || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home.arpa') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  if (m[1] === 'http' && !home) throw new Error('Invalid base URL: a key only goes over https, or over http to a machine on the home network.');
  return raw;
}

/** Cogitator, read as a provider that can be down: it has no usage meter, only the machines it serves from and where each role is being served. */
export const cogitator: ProviderPlugin = {
  id: 'cogitator', name: 'Cogitator', needsLocalLogin: false, links: {},
  // The fleet changes when a machine sleeps or a model loads, so it is read often; a gateway that is off shows once, not as a loop.
  refreshSeconds: 30,
  fields: [{ key: 'manageKey', label: 'Manage key', kind: 'secret', required: true, help: 'A Cogitator key with the manage scope. It reads the machines and roles; the routes use a separate infer key.' },
    { key: 'baseUrl', label: 'Gateway address', kind: 'text', placeholder: DEFAULT_BASE, help: `Leave empty for ${DEFAULT_BASE}. Another machine on the home network goes here, such as http://eru:8470.` }],
  async fetch(host, settings) {
    const key = await host.secret('cogitator.manageKey');
    if (!key) throw new Error('No manage key yet. Add one in settings.');
    let body: unknown;
    try { body = await json(host, { url: `${baseOf(settings)}/api/v1/hosts`, headers: { Authorization: `Bearer ${key}` }, timeoutMs: 5000 }); }
    catch (error) {
      if (error instanceof HttpError && error.status === 403) throw new Error('Key cannot read the fleet. Use a key with the manage scope.');
      if (error instanceof HttpError && error.status === 401) throw new Error('Key not accepted by Cogitator. Check it in settings.');
      throw new Error(error instanceof HttpError ? `Could not read the fleet: Cogitator returned HTTP ${error.status}` : 'Could not reach Cogitator.');
    }
    const fleet = readFleet(body);
    const up = fleet.machines.filter(m => m.up).length, down = fleet.roles.filter(r => r.degraded).length;
    return { plan: null, detail: `${up} of ${fleet.machines.length} machines up${down ? `, ${down} role${down === 1 ? '' : 's'} degraded` : ''}`, meters: [], money: [], notes: { fleet } };
  }
};
