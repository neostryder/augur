import type { ProviderPlugin, Meter } from '../types.js';
import { json, obj, num, round, iso, windowKind } from '../util.js';

/** `grok models` prints one model per line, after a * or a -. */
export function parseGrokModels(text: string): Array<{ id: string }> {
  return [...text.matchAll(/^\s*[*-]\s+([A-Za-z0-9][\w.-]*)/gm)].map(m => ({ id: m[1]! }));
}

export const grok: ProviderPlugin = {
  id: 'grok', color: { light: '#4a3aa7', dark: '#9085e9' }, name: 'Grok', needsLocalLogin: true, labelPrefix: 'xai',
  links: { usage: 'https://grok.com/?_s=usage', status: 'https://status.x.ai/' }, fields: [],
  detect: async host => !!(await host.readHomeFile?.('.grok/auth.json')),
  async fetch(host) {
    const load = async () => {
      const text = await host.readHomeFile?.('.grok/auth.json');
      if (!text) throw new Error('Not signed in. Sign in to the Grok CLI on this computer.');
      return obj(Object.values(obj(JSON.parse(text)))[0]);
    };
    let auth = await load();
    if (!auth.expires_at || Date.parse(auth.expires_at) <= (host.now?.() ?? new Date()).getTime() + 120000) {
      if (!host.run) throw new Error('The Grok login expired. Open the Grok CLI once to renew it.');
      await host.run('grok', ['models'], 60000);
      auth = await load();
    }
    const data = obj(await json(host, { url: 'https://cli-chat-proxy.grok.com/v1/billing?format=credits', headers: { Authorization: `Bearer ${auth.key}` } }));
    const c = obj(data.config), period = obj(c.currentPeriod);
    const seconds = (Date.parse(period.end) - Date.parse(period.start)) / 1000;
    const kind = windowKind(Number.isFinite(seconds) ? seconds : null);
    const weekly = kind === 'weekly' || period.type === 'USAGE_PERIOD_TYPE_WEEKLY';
    const products = Array.isArray(c.productUsage) ? c.productUsage.map(obj) : [];
    const meters: Meter[] = [{ id: 'supergrok', label: `${weekly ? 'Weekly' : 'Monthly'} SuperGrok limit`, usedPct: round(num(c.creditUsagePercent)),
      resetsAt: iso(period.end), windowSeconds: Number.isFinite(seconds) ? seconds : null, windowKind: weekly ? 'weekly' : 'monthly',
      detail: products.filter(p => num(p.usagePercent) !== null).map(p => `${p.product} ${p.usagePercent}%`).join(', ') || null }];
    if (products.length > 1) for (const p of products) meters.push({ id: `product_${String(p.product ?? '').toLowerCase()}`, label: String(p.product ?? ''),
      usedPct: round(num(p.usagePercent)), resetsAt: iso(period.end), windowSeconds: seconds, windowKind: weekly ? 'weekly' : 'monthly' });
    const money = [{ id: 'prepaid', label: 'Extra usage credits', amount: round((num(obj(c.prepaidBalance).val) ?? 0) / 100, 2), currency: 'USD' }];
    const cap = num(obj(c.onDemandCap).val);
    if (cap) money.push({ id: 'ondemand', label: 'On-demand used', amount: round((num(obj(c.onDemandUsed).val) ?? 0) / 100, 2), currency: 'USD', total: round(cap / 100, 2) } as typeof money[number]);
    return { meters, money, plan: 'SuperGrok' };
  },
  async listModels(host) {
    if (!host.run) return [];
    const out = await host.run('grok', ['models'], 60000);
    if (out.code !== 0) throw new Error('The Grok CLI could not list its models.');
    return parseGrokModels(out.stdout);
  }
};
