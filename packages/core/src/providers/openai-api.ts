import type { Money, ProviderPlugin, ProviderResult } from '../types.js';
import { obj, num } from '../util.js';
import { openaiLedger, OPENAI_USAGE_TEXT as TEXT } from '../openai-usage.js';

export function openaiReading(value: unknown, now: Date): Money[] {
  const account = obj(value), money: Money[] = [];
  const currency = 'USD', credit = num(account.balance), spend = num(account.spend);
  if (credit !== null) money.push({ id: 'credit', label: TEXT.credit, amount: credit, currency });
  for (const raw of Array.isArray(account.promos) ? account.promos : []) {
    const promo = obj(raw), amount = num(promo.remaining), end = typeof promo.expiresAt === 'string' ? Date.parse(promo.expiresAt) : NaN;
    if (amount === null || amount <= 0 || (Number.isFinite(end) && end <= now.getTime())) continue;
    money.push({ id: `promo-${money.length}`, label: TEXT.promo, amount, currency,
      ...(Number.isFinite(end) ? { detail: TEXT.ends(new Date(end).toISOString().slice(0, 10)) } : {}) });
  }
  if (spend !== null) money.push({ id: 'spend', label: TEXT.spend, amount: spend, currency });
  return money;
}

export const openaiApi: ProviderPlugin = {
  id: 'openai-api', name: TEXT.name, needsLocalLogin: false, rulesOnly: true,
  color: { light: '#1baf7a', dark: '#199e70' },
  links: { usage: 'https://platform.openai.com/settings/organization/billing/overview' },
  fields: [
    { key: 'web', label: TEXT.web, kind: 'toggle', help: TEXT.webHelp },
    { key: 'signin', label: TEXT.signin, kind: 'signin', site: 'openai', help: TEXT.signinHelp },
  ], modelListMode: 'catalog',
  async fetch(host, settings, options) {
    const now = host.now?.() ?? new Date();
    const since = Math.min(new Date(now.getFullYear(), now.getMonth(), 1).getTime(), now.getTime() - 7 * 86400000);
    const jobs = host.jobUsage ? await host.jobUsage(since).catch(() => null) : null;
    const result: ProviderResult = jobs === null ? { meters: [], money: [], notes: { openaiLedgerUnavailable: true } } : openaiLedger(jobs, now);
    if (settings?.web !== true || !host.webSession) return result;
    const web = await host.webSession('openai', { fresh: options?.force === true }).catch(() => null);
    if (web?.signedIn === false) result.notes = { ...result.notes, [web.reason === 'challenge' ? 'openaiChallenge' : 'openaiSignIn']: true };
    if (web?.signedIn === true) {
      const money = openaiReading(web.account, now);
      result.money.push(...money);
      result.notes = { ...result.notes, webSessions: { openai: true }, openaiBillingMissing: money.length === 0,
        openaiPromos: money.filter(row => row.id.startsWith('promo-')).map(row => ({ amount: row.amount, detail: row.detail })) };
    }
    return result;
  },
};
