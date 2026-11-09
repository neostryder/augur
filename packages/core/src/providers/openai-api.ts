import type { Money, ProviderPlugin, ProviderResult } from '../types.js';
import { obj, num } from '../util.js';
import { openaiLedger, OPENAI_USAGE_TEXT as TEXT } from '../openai-usage.js';

export function openaiReading(value: unknown): Money[] {
  const spend = num(obj(value).spend);
  return spend === null ? [] : [{ id: 'spend', label: TEXT.spend, amount: spend, currency: 'USD' }];
}

export function openaiProjectReading(value: unknown): ProviderResult {
  const project = obj(value), rows = project.days;
  if (typeof project.id !== 'string' || !project.id || typeof project.name !== 'string' || !Array.isArray(rows)) return { meters: [], money: [] };
  const daily = new Map<string, { date: string; spend: number; requests: number; tokens: number }>();
  for (const row of rows.slice(-31)) {
    const day = obj(row);
    if (typeof day.start !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.start) || !Number.isFinite(Date.parse(day.start)) || new Date(day.start).toISOString().slice(0, 10) !== day.start) continue;
    if ([day.spend, day.requests, day.tokens].some(value => typeof value !== 'number' || !Number.isFinite(value)) || day.requests < 0 || day.tokens < 0) continue;
    daily.set(day.start, { date: day.start, spend: day.spend, requests: day.requests, tokens: day.tokens });
  }
  const days = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-7);
  if (!days.length) return { meters: [], money: [] };
  const spend = days.reduce((sum, day) => sum + day.spend, 0), requests = days.reduce((sum, day) => sum + day.requests, 0), tokens = days.reduce((sum, day) => sum + day.tokens, 0);
  if (![spend, requests, tokens].every(Number.isFinite)) return { meters: [], money: [] };
  return { meters: [], money: [{ id: 'project_spend', label: TEXT.projectSpend, amount: spend, currency: 'USD', detail: project.name }],
    notes: { openaiDays: days.map(({ date, spend, requests }) => ({ date, spend, requests })), openaiWeek: { requests, tokens } } };
}

export const openaiApi: ProviderPlugin = {
  id: 'openai-api', name: TEXT.name, needsLocalLogin: false, rulesOnly: true,
  color: { light: '#1baf7a', dark: '#199e70' },
  links: { usage: 'https://platform.openai.com/settings/organization/billing/overview' },
  fields: [
    { key: 'web', label: TEXT.web, kind: 'toggle', help: TEXT.webHelp },
    { key: 'monthlyBudgetUsd', label: TEXT.budget, kind: 'text', placeholder: '250', help: TEXT.budgetHelp },
    { key: 'signin', label: TEXT.signin, kind: 'signin', site: 'openai', help: TEXT.signinHelp },
  ], modelListMode: 'catalog',
  async fetch(host, settings, options) {
    const now = host.now?.() ?? new Date();
    const since = Math.min(new Date(now.getFullYear(), now.getMonth(), 1).getTime(), now.getTime() - 7 * 86400000);
    const jobs = host.jobUsage ? await host.jobUsage(since).catch(() => null) : null;
    const result: ProviderResult = jobs === null ? { meters: [], money: [], notes: { openaiLedgerUnavailable: true } } : openaiLedger(jobs, now);
    if (settings?.web !== true || !host.webSession) return result;
    const [web, usage] = await Promise.all([
      host.webSession('openai', { fresh: options?.force === true }).catch(() => null),
      host.webSession('openai-usage', { fresh: options?.force === true }).catch(() => null),
    ]);
    if (web?.signedIn === false) result.notes = { ...result.notes, [web.reason === 'challenge' ? 'openaiChallenge' : 'openaiSignIn']: true };
    if (web?.signedIn === true) {
      const money = openaiReading(web.account);
      const spend = money[0]?.amount;
      if (spend != null) {
        const configured = num(settings.monthlyBudgetUsd), budget = configured !== null && configured > 0 ? configured : 250;
        const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1), end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
        result.meters.push({ id: 'monthly_budget', label: TEXT.budget, usedPct: Math.min(100, Math.max(0, spend / budget * 100)),
          windowKind: 'monthly', resetsAt: new Date(end).toISOString(), windowSeconds: (end - start) / 1000,
          detail: `$${spend.toFixed(2)} of $${budget}` });
      }
      result.money.push(...money);
      result.notes = { ...result.notes, webSessions: { openai: true }, openaiBillingMissing: money.length === 0 && web.forbidden !== true, openaiBillingForbidden: web.forbidden === true };
    }
    if (usage?.signedIn === true) {
      const project = openaiProjectReading(usage.project);
      result.money.push(...project.money);
      result.notes = { ...result.notes, ...project.notes };
    }
    return result;
  },
};
