import { describe, expect, it } from 'vitest';
import { PACE, boostFor, freshLimits, pacedProviders, paceState, providerHeadroom, resolveBalance } from '../src/index.js';
import type { UsageProvider, UsageSnapshot } from '../src/index.js';

const now = new Date('2026-09-28T12:00:00Z');
const WEEK = 7 * 24 * 3600;
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60000).toISOString();

/** A weekly window 40% of the way through with 30% used. */
const weekly = { id: 'weekly', label: 'week', usedPct: 30, windowKind: 'weekly', windowSeconds: WEEK, resetsAt: new Date(now.getTime() + 0.6 * WEEK * 1000).toISOString() };
const entry = (extra: Partial<UsageProvider>): UsageSnapshot => ({ providers: { grok: { meters: [weekly], ...extra } } });

describe('freshLimits', () => {
  it('keeps the two-hour and twenty-minute limits for a provider read often or with no cadence', () => {
    expect(freshLimits(undefined)).toEqual({ staleMin: PACE.staleMin, ignoreMin: PACE.ignoreMin });
    expect(freshLimits({})).toEqual({ staleMin: 20, ignoreMin: 120 });
    expect(freshLimits({ refreshSeconds: 300 })).toEqual({ staleMin: 20, ignoreMin: 120 });
    expect(freshLimits({ refreshSeconds: null })).toEqual({ staleMin: 20, ignoreMin: 120 });
  });

  it('scales the limits with the refresh interval once that is long', () => {
    expect(freshLimits({ refreshSeconds: 3600 })).toEqual({ staleMin: 75, ignoreMin: 120 });
    expect(freshLimits({ refreshSeconds: WEEK })).toEqual({ staleMin: 12600, ignoreMin: 15120 });
  });
});

describe('a provider read on purpose less often', () => {
  const threeDays = minutesAgo(3 * 24 * 60);

  it('is paced from three-day-old figures when its refresh interval is a week', () => {
    const usage = entry({ fetchedAt: threeDays, refreshSeconds: WEEK });
    const rules = resolveBalance(undefined);
    expect(pacedProviders(usage, rules, now)).toContain('grok');
    const state = paceState(usage, rules, 'grok', now);
    expect(state.tracks.length).toBe(1);
    expect(state.peak).toBe(30);
  });

  it('still drops the same figures when no refresh interval is known', () => {
    const usage = entry({ fetchedAt: threeDays });
    const rules = resolveBalance(undefined);
    expect(pacedProviders(usage, rules, now)).not.toContain('grok');
    expect(paceState(usage, rules, 'grok', now).tracks).toEqual([]);
  });

  it('drops figures older than one and a half intervals', () => {
    const usage = entry({ fetchedAt: minutesAgo(11 * 24 * 60), refreshSeconds: WEEK });
    expect(pacedProviders(usage, resolveBalance(undefined), now)).not.toContain('grok');
  });

  it('weighs a money balance instead of calling it too old', () => {
    const usage: UsageProvider = { money: [{ id: 'balance', amount: 3 }], fetchedAt: threeDays, refreshSeconds: WEEK };
    const th = { denyPct: 98, minBalance: 1 };
    const weighed = providerHeadroom(usage, th, now);
    expect(weighed.why).toBe('balance $3.00');
    expect(weighed.headroom).toBeLessThan(1);
    const unknown = providerHeadroom({ ...usage, refreshSeconds: null }, th, now);
    expect(unknown.why).toMatch(/not weighed/);
    expect(unknown.headroom).toBe(1);
  });

  it('gets a boost from figures inside its own limit', () => {
    const usage = entry({ fetchedAt: threeDays, refreshSeconds: WEEK });
    const rules = resolveBalance(undefined);
    const boosted = boostFor(paceState(usage, rules, 'grok', now), usage, rules, now);
    expect(boosted.boost).toBeGreaterThan(1);
  });
});
