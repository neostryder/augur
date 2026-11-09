import type { Money, ProviderPlugin } from '../types.js';
import { json, obj, num, round } from '../util.js';

const major = (minor: number | null, exponent: number): number | null => minor === null ? null : round(minor / 10 ** exponent, 2);

/** Money rows and notes from the accounts the Console reader found: the credit left, each promotional grant with its end date, and this month's spend. Only the first account that has credit is used. */
export function consoleReading(value: unknown, now: Date): { meters: []; money: Money[]; notes: Record<string, unknown> } {
  const money: Money[] = [];
  let soonest: { at: number; amount: number; currency: string } | null = null;
  const account = (Array.isArray(value) ? value : []).map(obj).find(a => num(a.balanceMinor) !== null);
  if (account) {
    const exponent = num(account.exponent) ?? 2, currency = typeof account.currency === 'string' ? account.currency : 'USD';
    money.push({ id: 'credit', label: 'API credit left', amount: major(num(account.balanceMinor), exponent), currency });
    for (const raw of Array.isArray(account.promos) ? account.promos : []) {
      const t = obj(raw), left = major(num(t.remainingMinor), exponent), end = typeof t.expiresAt === 'string' ? Date.parse(t.expiresAt) : NaN;
      if (left === null || (Number.isFinite(end) && end <= now.getTime())) continue;
      const id = `promo-${money.length}`, name = typeof t.name === 'string' && t.name ? t.name : 'Promotional credit';
      money.push({ id, label: name, amount: left, currency, total: major(num(t.grantedMinor), exponent),
        detail: Number.isFinite(end) ? `Ends ${new Date(end).toISOString().slice(0, 10)}` : null });
      if (left > 0 && Number.isFinite(end) && (!soonest || end < soonest.at)) soonest = { at: end, amount: left, currency };
    }
    const spend = major(num(account.spendMinor), exponent);
    if (spend !== null) money.push({ id: 'spend', label: 'Spend this month', amount: spend, currency,
      detail: typeof account.spendResetsAt === 'string' ? `Resets ${account.spendResetsAt.slice(0, 10)}` : null });
  }
  return { meters: [], money, notes: { webSessions: { console: true },
    ...(soonest ? { creditExpiresAt: new Date(soonest.at).toISOString(), creditExpiring: soonest.amount, creditCurrency: soonest.currency } : {}) } };
}

export const claudeApi: ProviderPlugin = {
  id: 'claude-api', name: 'Claude API', needsLocalLogin: false, rulesOnly: true,
  color: { light: '#3987e5', dark: '#5598e7' }, links: { usage: 'https://platform.claude.com/settings/billing' },
  fields: [
    { key: 'apiKey', label: 'API key', kind: 'secret', required: true },
    { key: 'web', label: 'Read credit from the Console', kind: 'toggle', help: 'Shows your prepaid and promotional credit, when the promotional credit ends, and spend so far this month, read from the Claude Console billing page. The Admin API has none of these for a personal organization. Sign in below once.' },
    { key: 'signin', label: 'Claude Console', kind: 'signin', site: 'console', help: 'Sign in to platform.claude.com once so Augur can read your credit.' },
  ], modelListMode: 'catalog',
  async fetch(host, settings, options) {
    // The key is never used here: the figures come from the Console page, and only when the reading is turned on and a window is available.
    if (settings?.web !== true || !host.webSession) return { meters: [], money: [] };
    const web = await host.webSession('console', { fresh: options?.force === true }).catch(() => null);
    if (web?.signedIn === false) return { meters: [], money: [], notes: web.reason === 'challenge' ? { consoleChallenge: true } : { consoleSignIn: true } };
    if (web?.signedIn !== true) return { meters: [], money: [] };
    return consoleReading(web.accounts, host.now?.() ?? new Date());
  },
  async testKey(host) {
    const key = await host.secret('claude-api.apiKey');
    if (!key) throw new Error('No API key yet. Add one in settings.');
    try { await json(host, { url: 'https://api.anthropic.com/v1/models?limit=1', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }); }
    catch { throw new Error('The Claude API key test failed. Check the key in Settings and run Test key again.'); }
    return { meters: [], money: [] };
  },
  async listModels(host) {
    const key = await host.secret('claude-api.apiKey');
    if (!key) return [];
    const models: Array<{ id: string; name?: string; created?: string }> = [];
    let after: string | undefined;
    const seen = new Set<string>();
    do {
      const data = obj(await json(host, { url: `https://api.anthropic.com/v1/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ''}`, headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }));
      const page = Array.isArray(data.data) ? data.data.map(obj) : [];
      if (!page.length) break;
      for (const model of page) if (typeof model.id === 'string') models.push({ id: model.id, name: typeof model.display_name === 'string' ? model.display_name : undefined, created: typeof model.created_at === 'string' ? model.created_at : undefined });
      const next = data.has_more === true && typeof data.last_id === 'string' ? data.last_id : undefined;
      if (!next || seen.has(next)) break;
      seen.add(next); after = next;
    } while (models.length < 10000);
    return models;
  },
};
