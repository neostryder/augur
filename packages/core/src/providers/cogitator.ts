import type { ProviderPlugin } from '../types.js';
import { HttpError, json, obj } from '../util.js';
import { readFleet } from '../fleet.js';
import { isHomeHost, keyMayGoTo } from '../net.js';
import { fleetCatalog } from '../cogitator-catalog.js';

export const DEFAULT_BASE = 'http://127.0.0.1:8470';

/** The address the key is sent to. A key only goes over https, or over http to a machine on the home network. */
export function baseOf(settings: Record<string, unknown>): string {
  const raw = typeof settings.baseUrl === 'string' ? settings.baseUrl.trim().replace(/\/+$/, '') : '';
  if (!raw) return DEFAULT_BASE;
  if (!/^https?:\/\//.test(raw)) throw new Error('Invalid base URL: it must start with http:// or https://.');
  if (!keyMayGoTo(raw)) throw new Error('Invalid base URL: a key only goes over https, or over http to a machine on the home network.');
  return raw;
}

function peerBase(base: string, address: unknown): string | null {
  if (typeof address !== 'string' || !keyMayGoTo(address)) return null;
  const gateway = new URL(base), peer = new URL(address);
  // A gateway's peer list does not authorize sending its key to another public host.
  if (peer.hostname !== gateway.hostname && !(isHomeHost(gateway.hostname) && isHomeHost(peer.hostname))) return null;
  return address.trim().replace(/\/+$/, '');
}

/** Cogitator, read as a provider that can be down: it has no usage meter, only the machines it serves from and where each role is being served. */
export const cogitator: ProviderPlugin = {
  id: 'cogitator', name: 'Cogitator', needsLocalLogin: false, links: {},
  // The fleet changes when a machine sleeps or a model loads, so it is read often; a gateway that is off shows once, not as a loop.
  refreshSeconds: 30,
  modelListMode: 'catalog',
  async listModels(host, settings) {
    const result = await cogitator.fetch(host, settings);
    return fleetCatalog(result.notes!.fleet as ReturnType<typeof readFleet>).map(entry => ({ id: entry.id, name: entry.id }));
  },
  fields: [{ key: 'manageKey', label: 'Manage key', kind: 'secret', required: true, help: 'A Cogitator key with the manage scope. It reads the machines and roles; the routes use a separate infer key.' },
    { key: 'baseUrl', label: 'Gateway address', kind: 'text', placeholder: DEFAULT_BASE, help: `Leave empty for ${DEFAULT_BASE}. Another machine on the home network goes here, such as http://eru:8470.` }],
  async fetch(host, settings) {
    const key = await host.secret('cogitator.manageKey');
    if (!key) throw new Error('No manage key yet. Add one in settings.');
    let body: unknown;
    const base = baseOf(settings), headers = { Authorization: `Bearer ${key}` };
    try { body = await json(host, { url: `${base}/api/v1/hosts`, headers, timeoutMs: 5000 }); }
    catch (error) {
      if (error instanceof HttpError && error.status === 403) throw new Error('Key cannot read the fleet. Use a key with the manage scope.');
      if (error instanceof HttpError && error.status === 401) throw new Error('Key not accepted by Cogitator. Check it in settings.');
      throw new Error(error instanceof HttpError ? `Could not read the fleet: Cogitator returned HTTP ${error.status}` : 'Could not reach Cogitator.');
    }
    const readCatalog = async (address: string): Promise<unknown> => {
      try { return await json(host, { url: `${address}/api/v1/catalog`, headers, timeoutMs: 5000 }); }
      catch { return {}; }
    };
    const catalog = await readCatalog(base), initial = readFleet(body, catalog);
    const needed = new Set(initial.roles.flatMap(role => role.chain.flatMap(link => link.includes('@') ? [link.slice(link.lastIndexOf('@') + 1)] : [])));
    const peers = new Map<string, string>();
    for (const raw of Array.isArray(obj(body).peers) ? obj(body).peers : []) {
      const peer = obj(raw), address = peerBase(base, peer.url);
      if (typeof peer.name === 'string' && needed.has(peer.name) && address) peers.set(peer.name, address);
    }
    const peerCatalogs = new Map(await Promise.all([...peers].map(async ([name, address]) => [name, await readCatalog(address)] as const)));
    const fleet = readFleet(body, catalog, peerCatalogs);
    const up = fleet.machines.filter(m => m.up).length, down = fleet.roles.filter(r => r.degraded).length;
    return { plan: null, detail: `${up} of ${fleet.machines.length} machines up${down ? `, ${down} role${down === 1 ? '' : 's'} degraded` : ''}`, meters: [], money: [], notes: { fleet } };
  }
};
