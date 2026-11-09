import type { Meter, Money, ProviderPlugin } from '../types.js';
import { json, obj, num, round, windowKind } from '../util.js';

const major = (minor: number | null, exponent: number): number | null => minor === null ? null : round(minor / 10 ** exponent, 2);

const MONTH_SECONDS = 2592000;

/** The meter and money rows the Console reader's accounts give: the largest unexpired credit grant as a monthly bar (used share, and the date it renews), plus the credit left and this month's spend. Other grants are left out. Only the first account that has credit is used. */
export function consoleReading(value: unknown, now: Date): { meters: Meter[]; money: Money[]; notes: Record<string, unknown> } {
  const meters: Meter[] = [], money: Money[] = [];
  const account = (Array.isArray(value) ? value : []).map(obj).find(a => num(a.balanceMinor) !== null);
  if (account) {
    const exponent = num(account.exponent) ?? 2, currency = typeof account.currency === 'string' ? account.currency : 'USD';
    money.push({ id: 'credit', label: 'API credit left', amount: major(num(account.balanceMinor), exponent), currency });
    let grant: { granted: number; left: number; end: number; start: number | null } | null = null;
    for (const raw of Array.isArray(account.promos) ? account.promos : []) {
      const t = obj(raw), granted = num(t.grantedMinor), left = num(t.remainingMinor), end = typeof t.expiresAt === 'string' ? Date.parse(t.expiresAt) : NaN;
      if (granted === null || granted <= 0 || left === null || !Number.isFinite(end) || end <= now.getTime()) continue;
      if (!grant || granted > grant.granted) grant = { granted, left, end, start: typeof t.grantedAt === 'string' && Number.isFinite(Date.parse(t.grantedAt)) ? Date.parse(t.grantedAt) : null };
    }
    if (grant) {
      const seconds = grant.start !== null && grant.end > grant.start ? Math.round((grant.end - grant.start) / 1000) : MONTH_SECONDS;
      meters.push({ id: 'monthly_credit', label: 'Monthly credit', usedPct: round(Math.min(100, Math.max(0, 100 * (1 - grant.left / grant.granted))), 1),
        resetsAt: new Date(grant.end).toISOString(), windowSeconds: seconds, windowKind: windowKind(seconds),
        detail: `${major(grant.left, exponent)} of ${major(grant.granted, exponent)} left` });
    }
    const spend = major(num(account.spendMinor), exponent);
    if (spend !== null) money.push({ id: 'spend', label: 'Spend this month', amount: spend, currency,
      detail: typeof account.spendResetsAt === 'string' ? `Resets ${account.spendResetsAt.slice(0, 10)}` : null });
  }
  return { meters, money, notes: { webSessions: { console: true } } };
}

export const claudeApi: ProviderPlugin = {
  id: 'claude-api', name: 'Claude API', needsLocalLogin: false, rulesOnly: true,
  color: { light: '#3987e5', dark: '#5598e7' }, links: { usage: 'https://platform.claude.com/settings/billing' },
  fields: [
    { key: 'apiKey', label: 'API key', kind: 'secret', required: true },
    { key: 'web', label: 'Read credit from the Console', kind: 'toggle', help: 'Shows how much of the monthly credit is used and when it renews, the credit left, and this month\'s spend, read from the Claude Console billing page. Sign in once below.' },
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
