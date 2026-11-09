// What the usage page says about each provider and meter, apart from how it is drawn.
import type { AppConfig, HistoryRow, LayoutConfig, Meter, ProviderSnapshot, Snapshot } from '@augur/core';
import { money, pace, when } from './format.js';
import { OPENAI_USAGE_TEXT as OPENAI_TEXT, type UsageTotal } from '@augur/core';

/** A meter with a window and a percentage, as opposed to a credit count. */
export const windowed = (m: Meter): boolean => m.windowKind !== 'credits' && m.usedPct != null;

/** The most-used windowed meter across the enabled providers, leaving out hidden meters. */
export function tightest(config: AppConfig, snapshot: Snapshot | null): { p: ProviderSnapshot; m: Meter } | null {
  let best: { p: ProviderSnapshot; m: Meter } | null = null;
  for (const pc of config.providers) {
    const p = snapshot?.providers[pc.id];
    if (!pc.enabled || !p) continue;
    const hidden = config.layout.hiddenMeters[pc.id] ?? [];
    for (const m of p.meters) {
      if (!windowed(m) || hidden.includes(m.id)) continue;
      if (!best || m.usedPct! > best.m.usedPct!) best = { p, m };
    }
  }
  return best;
}

/** A window at or above this percent reads as spent, not as ahead of pace. */
export const SPENT_PCT = 99;

/** How the meter is burning against its window: the words, whether they are a warning, and how far through the window it is. */
export function paceInfo(m: Meter, history: HistoryRow[], pid: string, now = Date.now()): { text: string; bad: boolean; elapsedPct: number | null } {
  const p = pace(m, history, pid, new Date(now));
  let elapsedPct: number | null = null;
  if (m.resetsAt && m.windowSeconds) {
    const left = (new Date(m.resetsAt).getTime() - now) / 1000;
    elapsedPct = Math.min(100, Math.max(0, 100 * (1 - left / m.windowSeconds)));
  }
  if ((m.usedPct ?? 0) >= SPENT_PCT) return { text: 'Spent', bad: true, elapsedPct };
  if (!p || p.burnRatio == null) return { text: '', bad: false, elapsedPct };
  if (p.willExhaustBeforeReset && p.projectedExhaustAt) return { text: `Runs out around ${when(p.projectedExhaustAt)}`, bad: true, elapsedPct };
  return { text: p.burnRatio >= 1 ? 'On pace' : 'Ahead of pace', bad: p.burnRatio < 1 && (m.usedPct ?? 0) > 50, elapsedPct };
}

/** The provider's status page in a word, or null when it reports nothing wrong. */
export function statusLabel(p: ProviderSnapshot): { label: string; severe: boolean; description: string } | null {
  const s = p.status;
  if (!s || s.indicator === 'none' || s.indicator === 'unknown') return null;
  const label = s.indicator === 'maintenance' ? 'Maintenance' : s.indicator === 'minor' ? 'Degraded' : 'Outage';
  return { label, severe: s.indicator !== 'minor' && s.indicator !== 'maintenance', description: s.description ?? label };
}

export interface OpenaiDay { date: string; spend: number; requests: number }

export function openaiDays(p: ProviderSnapshot): OpenaiDay[] {
  const days = p.id === 'openai-api' ? p.notes?.openaiDays : null;
  if (!Array.isArray(days)) return [];
  return days.filter((day): day is OpenaiDay => day && typeof day.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day.date)
    && Number.isFinite(Date.parse(day.date)) && new Date(day.date).toISOString().slice(0, 10) === day.date && typeof day.spend === 'number' && Number.isFinite(day.spend)
    && typeof day.requests === 'number' && Number.isFinite(day.requests) && day.requests >= 0).slice(-7);
}

/** One extra fact, one sentence. `more` marks background (limits, rates, how a figure was made) that belongs in a tooltip. */
export interface NotePart { text: string; more: boolean }

function noteEntries(p: ProviderSnapshot): NotePart[] {
  const n = (p.notes ?? {}) as Record<string, any>;
  const out: NotePart[] = [];
  const add = (text: string) => { out.push({ text, more: false }); };
  const more = (text: string) => { out.push({ text, more: true }); };
  if (typeof n.resets_available === 'number' || typeof n.resetsAvailable === 'number') {
    const k = n.resetsAvailable ?? n.resets_available;
    const ends = typeof n.resetsEndsAt === 'string' ? new Date(n.resetsEndsAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
    add(`${k} limit reset${k === 1 ? '' : 's'} available${ends ? `, the first ends ${ends}` : ''}`);
  }
  const ku = n.keyUsage ?? n.key_usage;
  if (ku) add(`This key: ${money(ku.day)} today, ${money(ku.week)} this week, ${money(ku.month)} this month`);
  const top = n.topEndpoints ?? n.top_endpoints;
  if (Array.isArray(top) && top.length) more('Top: ' + top.slice(0, 3).map((e: any) => `${e.endpoint} ${money(Number(e.cost))}`).join(', '));
  if (n.lastWeek) add(`${Number(n.lastWeek.requests).toLocaleString()} requests, ${(Number(n.lastWeek.tokens) / 1e6).toFixed(1)}M tokens in 7 days`);
  if (typeof n.refill === 'string') more(n.refill);
  if (n.signInNeeded) add('Sign in to the TypeSafe console in settings to see your balance');
  if (n.resetsSignIn) add('Claude resets are not counted yet. Sign in to claude.ai in settings.');
  if (n.resetsChallenge) add('claude.ai is showing a Cloudflare check. Open it from settings and pass it so your resets can be read.');
  if (n.openaiSignIn) add(OPENAI_TEXT.signInNote);
  if (n.openaiChallenge) add(OPENAI_TEXT.challengeNote);
  if (n.openaiBillingMissing) add(OPENAI_TEXT.missingNote);
  if (n.openaiBillingForbidden) more(OPENAI_TEXT.forbiddenNote);
  if (n.openaiLedgerUnavailable) more(OPENAI_TEXT.unavailableNote);
  if (p.id === 'codex' && typeof n.chatgptJobsWeek === 'number') more(OPENAI_TEXT.chatgpt(n.chatgptJobsWeek));
  if (openaiDays(p).length && n.openaiWeek && [n.openaiWeek.requests, n.openaiWeek.tokens].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
    add(OPENAI_TEXT.projectActivity(n.openaiWeek.requests, n.openaiWeek.tokens));
  }
  if (n.openaiLedger) {
    const { periods, models } = n.openaiLedger as { periods: Record<string, UsageTotal>; models: Record<string, UsageTotal> };
    const week = periods.week;
    if (week) add(OPENAI_TEXT.activity(week.calls, week.inputTokens + week.outputTokens));
    for (const [model, total] of Object.entries(models)) if (total.calls > 0) more(OPENAI_TEXT.model(model,
      OPENAI_TEXT.counts('', total.calls, total.inputTokens, total.outputTokens, total.images), total.costUsd === null ? '' : OPENAI_TEXT.cost(total.costUsd)));
  }
  if (n.consoleSignIn) add('Claude API credit is not read yet. Sign in to the Claude Console in settings.');
  if (n.consoleChallenge) add('The Claude Console is showing a Cloudflare check. Open it from settings and pass it so your credit can be read.');
  if (n.cloudflareCheck) add('Open the TypeSafe console in settings and pass the Cloudflare check to show your balance');
  if (n.balanceMissing) add('The TypeSafe billing page opened but showed no credit balance');
  if (typeof n.latencyMs === 'number') more(`Answered in ${Math.round(n.latencyMs)} ms${n.model ? `, ${n.model}` : ''}`);
  return out;
}

/** The extra facts some providers report (resets in hand, spend on this key, sign-in hints), one sentence each. */
export function notesParts(p: ProviderSnapshot): string[] {
  return noteEntries(p).map(n => n.text);
}

/** The same facts split for a card: `shown` stays in view, `more` goes in a tooltip. */
export function notesSplit(p: ProviderSnapshot): { shown: string[]; more: string[] } {
  const all = noteEntries(p);
  return { shown: all.filter(n => !n.more).map(n => n.text), more: all.filter(n => n.more).map(n => n.text) };
}

export function usageRows(p: ProviderSnapshot, layout: LayoutConfig): { meters: Meter[]; money: ProviderSnapshot['money']; notes: string[]; shown: string[]; more: string[]; status: string } {
  const hidden = layout.hiddenMeters[p.id] ?? [];
  const meters = p.meters.filter(m => !hidden.includes(m.id));
  const money = p.money.filter(row => row.amount != null && (layout.showHiddenRows === true || row.amount !== 0) && !hidden.includes('$' + row.id));
  const notes = notesParts(p), { shown, more } = notesSplit(p);
  return { meters, money, notes, shown, more, status: !meters.length && !money.length && !notes.length && !p.error && !statusLabel(p) ? USAGE_TEXT.noUsage : '' };
}

/** The line under a provider whose last refresh failed. */
export function errorText(p: ProviderSnapshot, agoText: (iso: string) => string): string {
  if (!p.error) return '';
  return p.stale && p.fetchedAt ? `Refresh failed: ${p.error} Showing the figures from ${agoText(p.fetchedAt)}.` : p.error;
}

export const USAGE_TEXT = {
  waiting: 'Waiting for the first refresh.',
  noUsage: 'No usage this month',
  showHiddenRows: 'Show hidden rows',
  none: 'No providers turned on yet.',
  notRefreshed: 'Not refreshed yet',
  mostUsed: 'Most-used limit right now',
  historyEmpty: 'History builds up as the app refreshes. Check back in a few hours.',
  nearLimit: 'Near limit',
  high: 'High',
};
