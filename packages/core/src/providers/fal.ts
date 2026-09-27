import type { ProviderPlugin } from '../types.js';
import { HttpError, json, obj, num, round } from '../util.js';

export const fal: ProviderPlugin = {
  id: 'fal', color: { light: '#eda100', dark: '#c98500' }, name: 'fal', needsLocalLogin: false,
  links: { usage: 'https://fal.ai/dashboard/usage-billing', status: 'https://status.fal.ai/' },
  fields: [{ key: 'adminKey', label: 'Admin key', kind: 'secret', required: true }],
  async fetch(host) {
    const key = await host.secret('fal.adminKey');
    if (!key) throw new Error('No admin key yet. Add one in settings.');
    const headers = { Authorization: `Key ${key}` };
    let data: Record<string, any>;
    try { data = obj(await json(host, { url: 'https://api.fal.ai/v1/account/billing?expand=credits', headers })); }
    catch (error) { if (error instanceof HttpError && [401, 403].includes(error.status)) throw new Error('This key cannot read billing. Add an admin key in settings.'); throw error; }
    const credits = obj(data.credits);
    const money = [{ id: 'balance', label: 'Credit balance', amount: round(num(credits.current_balance), 2), currency: String(credits.currency ?? 'USD') }];
    const start = new Date((host.now?.() ?? new Date()).getTime());
    start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
    const notes: Record<string, unknown> = {};
    try {
      const usage = obj(await json(host, { url: `https://api.fal.ai/v1/models/usage?expand=summary&start=${start.toISOString().replace('.000Z', 'Z')}`, headers }));
      const rows = Array.isArray(usage.summary) ? usage.summary.map(obj) : [];
      money.push({ id: 'month', label: 'Spent this month', amount: round(rows.reduce((sum, row) => sum + (num(row.cost) ?? 0), 0), 2), currency: 'USD' });
      notes.top_endpoints = rows.sort((a, b) => (num(b.cost) ?? 0) - (num(a.cost) ?? 0)).slice(0, 5).map(row => ({ endpoint: row.endpoint_id, cost: row.cost }));
    } catch { notes.usage_error = 'Monthly usage unavailable'; }
    return { plan: data.tier ?? 'Pay as you go', meters: [], money, notes };
  }
};
