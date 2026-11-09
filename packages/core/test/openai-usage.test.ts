import { describe, expect, it, vi } from 'vitest';
import type { Host, JobUsage } from '../src/types.js';
import { openaiLedger } from '../src/openai-usage.js';
import { imageCost } from '../src/openai-prices.js';
import { openaiApi, openaiReading } from '../src/providers/openai-api.js';

const now = new Date(2026, 10, 8, 12);
const job = (day: number, extra: Partial<JobUsage> = {}): JobUsage => ({ provider: 'openai-api', route: 'openai-api-sol', model: 'chat',
  at: new Date(2026, 10, day, 10).getTime(), images: 0, usage: { inputTokens: 100, outputTokens: 20 }, costUsd: 0.01, ...extra });

describe('OpenAI local usage', () => {
  it('groups today, rolling week and calendar month with an unpriced call and saved images', () => {
    const jobs = [job(8), job(7), job(1), job(8, { model: 'unknown', costUsd: null }),
      job(8, { model: 'gpt-image-1-mini', images: 2, usage: { inputTokens: 1000, outputTokens: 1000 }, costUsd: null }),
      job(8, { provider: 'other' }), job(9), job(1, { at: new Date(2026, 9, 31).getTime() })];
    const result = openaiLedger(jobs, now), ledger = result.notes!.openaiLedger as any;
    expect(ledger.periods.today).toMatchObject({ calls: 3, inputTokens: 1200, outputTokens: 1040, images: 2, costCalls: 2, estimated: true });
    expect(ledger.periods.week.calls).toBe(4);
    expect(ledger.periods.month.calls).toBe(5);
    expect(ledger.models.unknown).toMatchObject({ calls: 1, inputTokens: 100, costUsd: null, estimated: true });
    expect(ledger.models['gpt-image-1-mini'].costUsd).toBeCloseTo(0.0105);
    expect(result.money.every(row => row.estimated === true && row.label.includes('estimated'))).toBe(true);
  });

  it('keeps the rolling week across a month boundary and includes each exact boundary once', () => {
    const at = new Date(2026, 10, 2, 12), week = at.getTime() - 7 * 86400000;
    const result = openaiLedger([job(1), job(1, { at: week }), job(1, { at: week - 1 })], at).notes!.openaiLedger as any;
    expect(result.periods.week.calls).toBe(2);
    expect(result.periods.month.calls).toBe(1);
    expect(result.periods.today.calls).toBe(0);
  });

  it('prices known image modalities and leaves incomplete prices unknown', () => {
    const image = job(8, { model: 'gpt-image-2.6-flare', usage: { inputTokens: 1000, outputTokens: 1000, cachedReadTokens: 100, textInputTokens: 200 } });
    expect(imageCost(image)).toBeCloseTo(0.0368);
    expect(imageCost({ ...image, usage: { inputTokens: 1000, outputTokens: 1000 } })).toBeNull();
    expect(imageCost(job(8, { model: 'unknown' }))).toBeNull();
    expect(imageCost(job(8, { model: 'gpt-image-1-mini', usage: { inputTokens: 100, outputTokens: 100, cachedReadTokens: 10 } }))).toBeNull();
  });

  it('reads the ledger with the web toggle off and does not access credentials', async () => {
    const webSession = vi.fn(), secret = vi.fn();
    const host = { now: () => now, jobUsage: async () => [job(8)], webSession, secret } as unknown as Host;
    expect((await openaiApi.fetch(host, {})).money[0]).toMatchObject({ amount: 0.01, estimated: true });
    expect(webSession).not.toHaveBeenCalled();
    expect(secret).not.toHaveBeenCalled();
  });

  it('retains local figures through sign-out, challenge and browser failure', async () => {
    for (const state of [{ signedIn: false }, { signedIn: false, reason: 'challenge' }, null]) {
      const host = { now: () => now, jobUsage: async () => [job(8)], webSession: async () => state } as unknown as Host;
      const result = await openaiApi.fetch(host, { web: true });
      expect(result.money[0]!.amount).toBe(0.01);
      if (state) expect(result.notes).toMatchObject(state.reason === 'challenge' ? { openaiChallenge: true } : { openaiSignIn: true });
    }
    const result = await openaiApi.fetch({ now: () => now, jobUsage: async () => [job(8)], webSession: async () => { throw new Error('closed'); } } as unknown as Host, { web: true });
    expect(result.money[0]!.amount).toBe(0.01);
  });

  it('combines credit, active promotions and actual spend with the ledger', async () => {
    const account = { balance: 14, spend: 3, promos: [{ remaining: 5, expiresAt: '2026-12-01' }, { remaining: 9, expiresAt: '2026-10-01' }] };
    expect(openaiReading(account, now)).toEqual([
      { id: 'credit', label: 'API credit left', amount: 14, currency: 'USD' },
      { id: 'promo-1', label: 'Promotional credit', amount: 5, currency: 'USD', detail: 'Ends 2026-12-01' },
      { id: 'spend', label: 'Spend this month', amount: 3, currency: 'USD' },
    ]);
    const webSession = vi.fn(async () => ({ signedIn: true, account }));
    const result = await openaiApi.fetch({ now: () => now, jobUsage: async () => [job(8)], webSession } as unknown as Host, { web: true }, { force: true });
    expect(result.money).toHaveLength(6);
    expect(result.notes).toMatchObject({ webSessions: { openai: true }, openaiBillingMissing: false });
    expect(webSession).toHaveBeenCalledWith('openai', { fresh: true });
  });
});
