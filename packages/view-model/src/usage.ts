// What the usage page says about each provider and meter, apart from how it is drawn.
import type { AppConfig, HistoryRow, Meter, ProviderSnapshot, Snapshot } from '@augur/core';
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

/** The extra facts some providers report (resets in hand, spend on this key, sign-in hints), one sentence each. */
export function notesParts(p: ProviderSnapshot): string[] {
  const n = (p.notes ?? {}) as Record<string, any>;
  const out: string[] = [];
  if (typeof n.resets_available === 'number' || typeof n.resetsAvailable === 'number') {
    const k = n.resetsAvailable ?? n.resets_available;
    const ends = typeof n.resetsEndsAt === 'string' ? new Date(n.resetsEndsAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
    out.push(`${k} limit reset${k === 1 ? '' : 's'} available${ends ? `, the first ends ${ends}` : ''}`);
  }
  const ku = n.keyUsage ?? n.key_usage;
  if (ku) out.push(`This key: ${money(ku.day)} today, ${money(ku.week)} this week, ${money(ku.month)} this month`);
  const top = n.topEndpoints ?? n.top_endpoints;
  if (Array.isArray(top) && top.length) out.push('Top: ' + top.slice(0, 3).map((e: any) => `${e.endpoint} ${money(Number(e.cost))}`).join(', '));
  if (n.lastWeek) out.push(`${Number(n.lastWeek.requests).toLocaleString()} requests, ${(Number(n.lastWeek.tokens) / 1e6).toFixed(1)}M tokens in 7 days`);
  if (typeof n.refill === 'string') out.push(n.refill);
  if (n.signInNeeded) out.push('Sign in to the TypeSafe console in settings to see your balance');
  if (n.resetsSignIn) out.push('Claude resets are not counted yet. Sign in to claude.ai in settings.');
  if (n.resetsChallenge) out.push('claude.ai is showing a Cloudflare check. Open it from settings and pass it so your resets can be read.');
  if (typeof n.creditExpiresAt === 'string' && typeof n.creditExpiring === 'number') {
    const cur = typeof n.creditCurrency === 'string' ? n.creditCurrency : 'USD';
    out.push(`${n.creditExpiring.toLocaleString([], { style: 'currency', currency: cur })} of promotional credit ends ${new Date(n.creditExpiresAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}`);
  }
  if (n.openaiSignIn) out.push(OPENAI_TEXT.signInNote);
  if (n.openaiChallenge) out.push(OPENAI_TEXT.challengeNote);
  if (n.openaiImagePricingUnknown) out.push(OPENAI_TEXT.imagePricing);
  if (n.openaiBillingMissing) out.push(OPENAI_TEXT.missingNote);
  if (n.openaiLedgerUnavailable) out.push(OPENAI_TEXT.unavailableNote);
  if (p.id === 'codex' && typeof n.chatgptJobsWeek === 'number') out.push(OPENAI_TEXT.chatgpt(n.chatgptJobsWeek));
  if (n.openaiLedger) {
    const { periods, models } = n.openaiLedger as { periods: Record<string, UsageTotal>; models: Record<string, UsageTotal> };
    for (const [key, label] of Object.entries(OPENAI_TEXT.periods)) {
      const total = periods[key];
      if (total) out.push(OPENAI_TEXT.counts(label, total.calls, total.inputTokens, total.outputTokens, total.images));
    }
    for (const [model, total] of Object.entries(models)) out.push(OPENAI_TEXT.model(model,
      OPENAI_TEXT.counts('', total.calls, total.inputTokens, total.outputTokens, total.images), total.costUsd === null ? '' : OPENAI_TEXT.cost(total.costUsd)));
    const total = periods.month;
    if (total && total.costCalls < total.calls) out.push(OPENAI_TEXT.unpriced(total.calls - total.costCalls));
  }
  if (Array.isArray(n.openaiPromos)) for (const promo of n.openaiPromos) {
    if (typeof promo.amount === 'number' && typeof promo.detail === 'string') out.push(`${OPENAI_TEXT.promo}: ${money(promo.amount)}; ${promo.detail}`);
  }
  if (n.consoleSignIn) out.push('Claude API credit is not read yet. Sign in to the Claude Console in settings.');
  if (n.consoleChallenge) out.push('The Claude Console is showing a Cloudflare check. Open it from settings and pass it so your credit can be read.');
  if (n.cloudflareCheck) out.push('Open the TypeSafe console in settings and pass the Cloudflare check to show your balance');
  if (n.balanceMissing) out.push('The TypeSafe billing page opened but showed no credit balance');
  if (typeof n.latencyMs === 'number') out.push(`Answered in ${Math.round(n.latencyMs)} ms${n.model ? `, ${n.model}` : ''}`);
  return out;
}

/** The line under a provider whose last refresh failed. */
export function errorText(p: ProviderSnapshot, agoText: (iso: string) => string): string {
  if (!p.error) return '';
  return p.stale && p.fetchedAt ? `Refresh failed: ${p.error} Showing the figures from ${agoText(p.fetchedAt)}.` : p.error;
}

export const USAGE_TEXT = {
  waiting: 'Waiting for the first refresh.',
  none: 'No providers turned on yet.',
  notRefreshed: 'Not refreshed yet',
  mostUsed: 'Most-used limit right now',
  historyEmpty: 'History builds up as the app refreshes. Check back in a few hours.',
  nearLimit: 'Near limit',
  high: 'High',
};
