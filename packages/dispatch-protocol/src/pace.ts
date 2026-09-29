// Live usage weighed as pace: how fast each provider is burning its windows, and how scarce usage is across providers. Pure.
import type { PolicyFile, ResolvedModel } from '@augur/core';

/** The part of usage.json the rules read. */
export interface UsageMeter {
  id: string;
  label?: string;
  usedPct: number | null;
  windowKind?: string;
  resetsAt?: string | null;
  windowSeconds?: number | null;
  active?: boolean;
}
export interface UsageProvider {
  meters?: UsageMeter[];
  money?: Array<{ id: string; amount: number; currency?: string }>;
  stale?: boolean;
  fetchedAt?: string | null;
}
export interface UsageSnapshot { providers: Record<string, UsageProvider> }

export const PACE = {
  /** Below this share of a window left, headroom shrinks linearly. */
  floorLeft: 0.25,
  /** The share of a window left is capped at 1 minus this, so a fresh window is not over-trusted. */
  minElapsed: 0.05,
  /** How hard shared scarcity pushes toward the cheap routes. */
  scarcityGain: 2,
  /** Figures older than this are ignored and flagged. */
  ignoreMin: 120,
  /** Figures older than this are flagged. */
  staleMin: 20,
  /** A pay-as-you-go balance this far above its minimum counts as full headroom. */
  fullBalanceUsd: 5,
  /** A route whose usage factor falls below this is flagged, and below `deny` it is refused. */
  warn: 0.4,
  deny: 0.15,
  /** The minimum balance when a provider's thresholds leave it unset. */
  defaultMinBalance: 0.25,
  /** A pay-as-you-go balance under the larger of this and four times its minimum is flagged. */
  lowBalanceUsd: 1,
} as const;

export const COST_EXPONENT: Record<string, number> = { cheap: 0.2, moderate: 0.6, expensive: 1 };

export interface Headroom { headroom: number; why: string; metered: boolean }

/** Only session and weekly windows count. A meter with no kind counts, so a snapshot written by hand still works. */
export const isWindowMeter = (m: UsageMeter): boolean =>
  typeof m.usedPct === 'number' && m.active !== false && (m.windowKind === undefined || m.windowKind === 'session' || m.windowKind === 'weekly');

export function ageMinutes(p: UsageProvider | undefined, now: Date): number {
  const t = p?.fetchedAt ? Date.parse(p.fetchedAt) : NaN;
  return Number.isFinite(t) ? Math.max(0, (now.getTime() - t) / 60000) : 0;
}

const pct = (n: number) => `${n.toFixed(0)}%`;

/** One provider's headroom (0 to 1) and the meter that set it. */
export function providerHeadroom(usage: UsageProvider | undefined, th: { denyPct: number; minBalance: number | null }, now: Date): Headroom {
  if (!usage) return { headroom: 1, why: 'no Augur data', metered: false };
  const age = ageMinutes(usage, now);
  if (age > PACE.ignoreMin) return { headroom: 1, why: `figures ${Math.floor(age)} min old, not weighed`, metered: true };
  let best: Headroom = { headroom: 1, why: 'plenty left', metered: true };
  const meters = (usage.meters ?? []).filter(isWindowMeter);
  for (const m of meters) {
    const used = (m.usedPct as number) / 100, label = m.label ?? m.id;
    let h: number, why: string;
    if ((m.usedPct as number) >= th.denyPct) { h = 0; why = `${label} spent (${pct(m.usedPct as number)})`; }
    else {
      let left = 1;
      const reset = m.resetsAt ? Date.parse(m.resetsAt) : NaN;
      if (Number.isFinite(reset) && m.windowSeconds) left = Math.min(1 - PACE.minElapsed, Math.max(0.001, (reset - now.getTime()) / 1000 / m.windowSeconds));
      const burn = (1 - used) / left;
      h = Math.min(1, burn) * Math.min(1, (1 - used) / PACE.floorLeft);
      why = `${label} ${pct(m.usedPct as number)} used with ${(left * 100).toFixed(0)}% of the window left (burn ${burn.toFixed(2)})`;
    }
    if (h < best.headroom) best = { headroom: Math.round(h * 1000) / 1000, why, metered: true };
  }
  if (!meters.length) {
    const balance = usage.money?.find(m => m.id === 'balance')?.amount, floor = th.minBalance ?? PACE.defaultMinBalance;
    if (typeof balance === 'number') {
      const h = balance <= floor ? 0 : Math.min(1, (balance - floor) / PACE.fullBalanceUsd);
      best = { headroom: Math.round(h * 1000) / 1000, why: `balance $${balance.toFixed(2)}`, metered: true };
    }
  }
  return best;
}

export function pressure(policy: PolicyFile, usage: UsageSnapshot | null, now = new Date()): Record<string, Headroom> {
  const out: Record<string, Headroom> = {};
  if (!usage) return out;
  for (const [id, p] of Object.entries(policy.providers)) {
    if (!Object.keys(p.models).length) continue;
    out[id] = providerHeadroom(usage.providers[id], { denyPct: p.thresholds.denyPct, minBalance: p.thresholds.minBalance }, now);
  }
  return out;
}

/** The route models a usage factor is computed for: every model in the policy, plus the live Claude session when Claude is listed without it. */
export function factorModels(policy: PolicyFile): Array<{ label: string; provider: string; cost: string }> {
  const rows: Array<{ label: string; provider: string; cost: string }> = [];
  for (const [provider, p] of Object.entries(policy.providers)) for (const [label, m] of Object.entries(p.models)) rows.push({ label, provider, cost: (m as ResolvedModel).cost ?? 'moderate' });
  if (policy.providers.claude && !rows.some(r => r.label === 'claude/live')) rows.push({ label: 'claude/live', provider: 'claude', cost: 'moderate' });
  return rows;
}

/** A model's usage factor is its provider's headroom raised to a power. Costlier models and scarcer usage overall raise the power. */
export function usageFactors(policy: PolicyFile, press: Record<string, Headroom>, only?: readonly string[]): { factors: Record<string, number>; scarcity: number } {
  const rows = factorModels(policy).filter(r => !only || only.includes(r.label));
  const pools = [...new Set(rows.filter(r => press[r.provider]?.metered).map(r => r.provider))];
  const mean = pools.length ? pools.reduce((s, p) => s + (press[p] as Headroom).headroom, 0) / pools.length : 1;
  const scarcity = 1 + PACE.scarcityGain * (1 - mean);
  const factors: Record<string, number> = {};
  for (const r of rows) factors[r.label] = Math.round(((press[r.provider]?.headroom ?? 1) ** ((COST_EXPONENT[r.cost] ?? 0.6) * scarcity)) * 1000) / 1000;
  return { factors, scarcity: Math.round(scarcity * 100) / 100 };
}

/** Other providers with room to spare, least used first, for a message that says where to send the work instead. */
export function leastUsed(policy: PolicyFile, usage: UsageSnapshot | null, except: string): string[] {
  if (!usage) return [];
  const rows: Array<{ name: string; pct: number }> = [];
  for (const [id, p] of Object.entries(policy.providers)) {
    if (id === except || !p.metered) continue;
    const peak = Math.max(-1, ...(usage.providers[id]?.meters ?? []).filter(isWindowMeter).map(m => m.usedPct as number));
    if (peak >= 0 && peak < p.thresholds.warnPct) rows.push({ name: p.name, pct: peak });
  }
  return rows.sort((a, b) => a.pct - b.pct).map(r => `${r.name} at ${Math.round(r.pct)}%`);
}
