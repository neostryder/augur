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
  /** Limit resets in hand are read from `resets_available`, the count a provider such as Codex reports. */
  notes?: { resets_available?: number | null };
  /** The provider's public status page. */
  status?: { indicator?: string } | null;
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

export const COST_EXPONENT: Record<string, number> = { free: 0, very_cheap: 0.1, cheap: 0.2, moderate: 0.6, high: 1, very_high: 1.5, expensive: 1 };

/** `spent` means a window is at its deny threshold. `down` means the provider's status page reports a major or critical outage. `resets` is how many limit resets the provider says are in hand. */
export interface Headroom { headroom: number; why: string; metered: boolean; spent?: boolean; down?: boolean; resets?: number }

/** Only session and weekly windows count. A meter with no kind counts, so a snapshot written by hand still works. */
export const isWindowMeter = (m: UsageMeter): boolean =>
  typeof m.usedPct === 'number' && m.active !== false && (m.windowKind === undefined || m.windowKind === 'session' || m.windowKind === 'weekly');

export function ageMinutes(p: UsageProvider | undefined, now: Date): number {
  const t = p?.fetchedAt ? Date.parse(p.fetchedAt) : NaN;
  return Number.isFinite(t) ? Math.max(0, (now.getTime() - t) / 60000) : 0;
}

const pct = (n: number) => `${n.toFixed(0)}%`;

export const resetsInHand = (usage: UsageProvider | undefined): number => {
  const n = usage?.notes?.resets_available;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
export const providerDown = (usage: UsageProvider | undefined): boolean => usage?.status?.indicator === 'major' || usage?.status?.indicator === 'critical';

/**
 * One provider's headroom (0 to 1) and the meter that set it.
 * A provider that other models wait on is spent in full (`drain`): pace does not reduce its headroom, and it reaches 0 only when a window is at its deny threshold.
 * Otherwise each limit reset in hand counts as one more full weekly window of room, so a provider ahead of pace with a reset to spare is not held back.
 */
export function providerHeadroom(usage: UsageProvider | undefined, th: { denyPct: number; minBalance: number | null }, now: Date, drain = false): Headroom {
  if (!usage) return { headroom: 1, why: 'no Augur data', metered: false };
  const resets = resetsInHand(usage), extra: Partial<Headroom> = { ...(resets ? { resets } : {}), ...(providerDown(usage) ? { down: true } : {}) };
  const age = ageMinutes(usage, now);
  if (age > PACE.ignoreMin) return { headroom: 1, why: `figures ${Math.floor(age)} min old, not weighed`, metered: true, ...extra };
  let best: Headroom = { headroom: 1, why: drain ? 'to be spent in full before the models that wait on it' : 'plenty left', metered: true, ...extra };
  const meters = (usage.meters ?? []).filter(isWindowMeter);
  for (const m of meters) {
    const used = (m.usedPct as number) / 100, label = m.label ?? m.id;
    let h: number, why: string, spent = false;
    if ((m.usedPct as number) >= th.denyPct) { h = 0; spent = true; why = `${label} spent (${pct(m.usedPct as number)})${resets ? `, ${resets} limit ${resets === 1 ? 'reset' : 'resets'} in hand` : ''}`; }
    else if (drain) { h = 1; why = `${label} ${pct(m.usedPct as number)} used, to be spent in full`; }
    else {
      let left = 1;
      const reset = m.resetsAt ? Date.parse(m.resetsAt) : NaN;
      if (Number.isFinite(reset) && m.windowSeconds) left = Math.min(1 - PACE.minElapsed, Math.max(0.001, (reset - now.getTime()) / 1000 / m.windowSeconds));
      const cover = m.windowKind === 'weekly' ? resets : 0, room = 1 - used + cover, burn = room / left;
      h = Math.min(1, burn) * Math.min(1, room / PACE.floorLeft);
      why = `${label} ${pct(m.usedPct as number)} used with ${(left * 100).toFixed(0)}% of the window left (burn ${burn.toFixed(2)}${cover ? `, ${cover} limit ${cover === 1 ? 'reset' : 'resets'} in hand` : ''})`;
    }
    if (h < best.headroom || (spent && !best.spent)) best = { headroom: Math.round(h * 1000) / 1000, why, metered: true, ...(spent ? { spent: true } : {}), ...extra };
  }
  if (!meters.length) {
    const balance = usage.money?.find(m => m.id === 'balance')?.amount, floor = th.minBalance ?? PACE.defaultMinBalance;
    if (typeof balance === 'number') {
      const h = balance <= floor ? 0 : Math.min(1, (balance - floor) / PACE.fullBalanceUsd);
      best = { headroom: Math.round(h * 1000) / 1000, why: `balance $${balance.toFixed(2)}`, metered: true, ...(h === 0 ? { spent: true } : {}), ...extra };
    }
  }
  return best;
}

/** Which provider each route label belongs to. */
export function modelOwners(policy: PolicyFile): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, p] of Object.entries(policy.providers)) for (const label of Object.keys(p.models)) out[label] = id;
  return out;
}

/** Providers that a confirmed model waits on through `useAfter`. They are spent in full instead of paced. */
export function drainProviders(policy: PolicyFile): Set<string> {
  const owner = modelOwners(policy), out = new Set<string>();
  for (const p of Object.values(policy.providers)) for (const m of Object.values(p.models)) {
    if (m.status !== 'confirmed') continue;
    for (const label of m.useAfter ?? []) if (owner[label]) out.add(owner[label] as string);
  }
  return out;
}

export function pressure(policy: PolicyFile, usage: UsageSnapshot | null, now = new Date()): Record<string, Headroom> {
  const out: Record<string, Headroom> = {};
  if (!usage) return out;
  const drain = drainProviders(policy);
  for (const [id, p] of Object.entries(policy.providers)) {
    if (!Object.keys(p.models).length) continue;
    out[id] = providerHeadroom(usage.providers[id], { denyPct: p.thresholds.denyPct, minBalance: p.thresholds.minBalance }, now, drain.has(id));
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
