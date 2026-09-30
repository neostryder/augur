import { describe, expect, it } from 'vitest';
import { copilot } from '../src/providers/index.js';
import type { Host, HttpResponse } from '../src/types.js';

const GOOD = { copilot_plan: 'enterprise', quota_reset_date_utc: '2026-10-01T00:00:00.000Z', quota_snapshots: { premium_interactions: { credits_used: 253, overage_permitted: true } } };
const reply = (status: number, body: unknown): HttpResponse => ({ status, headers: {}, body: typeof body === 'string' ? body : JSON.stringify(body) });

/** A desktop-style host: the token is read outside this code, so `run` must never be asked for it. */
function desktop(respond: () => HttpResponse | Promise<HttpResponse>): Host {
  return {
    platform: 'windows', http: async () => { throw new Error('the page must not call GitHub itself'); }, secret: async () => null,
    run: async () => { throw new Error('the token must not be read here'); },
    copilotUsage: async () => respond(),
  } as Host;
}
const fetchWith = (body: unknown, settings: Record<string, string | boolean> = {}) => copilot.fetch(desktop(() => reply(200, body)), settings);

describe('Copilot through the desktop app', () => {
  it('reads the same meter without ever holding the token', async () => {
    const r = await fetchWith(GOOD, { capUsd: '250' });
    expect(r.meters[0]).toMatchObject({ id: 'monthly_credits', usedPct: 1, resetsAt: '2026-10-01T00:00:00.000Z', windowKind: 'monthly' });
    expect(r.money[0]).toMatchObject({ amount: 2.53, total: 250 });
    expect(r.plan).toBe('Copilot enterprise');
  });

  it('says to sign in again when GitHub refuses, and reports other failures as they are', async () => {
    for (const status of [401, 403, 404]) await expect(copilot.fetch(desktop(() => reply(status, '')), {})).rejects.toThrow('gh auth login');
    await expect(copilot.fetch(desktop(() => reply(500, '')), {})).rejects.toThrow('HTTP 500');
    await expect(copilot.fetch(desktop(() => reply(200, '<html>')), {})).rejects.toThrow('could not read');
    await expect(copilot.fetch(desktop(() => { throw new Error('Not signed in. Run gh auth login on this computer.'); }), {})).rejects.toThrow('gh auth login');
  });

  it('detects a signed-in account from the answer alone', async () => {
    expect(await copilot.detect!(desktop(() => reply(200, GOOD)))).toBe(true);
    expect(await copilot.detect!(desktop(() => reply(401, '')))).toBe(false);
    expect(await copilot.detect!(desktop(() => { throw new Error('gh missing'); }))).toBe(false);
  });
});

describe('Copilot when GitHub changes its answer', () => {
  it('accepts a credit count sent as text', async () => {
    const r = await fetchWith({ ...GOOD, quota_snapshots: { premium_interactions: { credits_used: '253' } } }, { capUsd: '250' });
    expect(r.meters[0]!.usedPct).toBe(1);
  });

  it('refuses to invent a number when the credit count is missing, null, empty or not a number', async () => {
    for (const snapshots of [undefined, null, {}, { premium_interactions: null }, { premium_interactions: {} }, { premium_interactions: { credits_used: null } }, { premium_interactions: { credits_used: '' } }, { premium_interactions: { credits_used: 'lots' } }]) {
      await expect(fetchWith({ ...GOOD, quota_snapshots: snapshots }), JSON.stringify(snapshots)).rejects.toThrow('no Copilot credit count');
    }
  });

  it('follows a renamed reset field and copes with none at all', async () => {
    const { quota_reset_date_utc: _u, ...rest } = GOOD;
    expect((await fetchWith({ ...rest, quota_reset_date: '2026-11-01T00:00:00Z' })).meters[0]).toMatchObject({ resetsAt: '2026-11-01T00:00:00.000Z', windowKind: 'monthly' });
    for (const value of [undefined, null, '', 'soon', {}]) {
      const meter = (await fetchWith({ ...rest, quota_reset_date_utc: value })).meters[0]!;
      expect(meter.resetsAt, String(value)).toBeNull();
      expect(meter.windowSeconds, String(value)).toBeNull();
    }
  });

  it('falls back to the default cap for a cap that is not a positive number', async () => {
    for (const cap of ['abc', '-5', '0', '']) expect((await fetchWith(GOOD, { capUsd: cap })).meters[0]!.detail, cap).toBe('253 of 25000 credits');
  });

  it('names the plan only when GitHub sends one, and tolerates a missing overage flag', async () => {
    const { copilot_plan: _p, ...noPlan } = GOOD;
    expect((await fetchWith(noPlan)).plan).toBe('Copilot');
    expect((await fetchWith({ ...GOOD, quota_snapshots: { premium_interactions: { credits_used: 1 } } })).notes).toMatchObject({ overage_permitted: null });
  });

  it('survives an answer that is not an object', async () => {
    for (const body of ['[]', '"text"', '7', 'null']) await expect(copilot.fetch(desktop(() => reply(200, body)), {})).rejects.toThrow('no Copilot credit count');
  });
});
