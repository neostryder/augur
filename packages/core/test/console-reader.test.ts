import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Host } from '../src/types.js';
import { claudeApi, consoleReading } from '../src/providers/claude-api.js';

const script = readFileSync(new URL('../../../apps/desktop/src-tauri/src/readers/console.js', import.meta.url), 'utf8');

type Answer = { ok: boolean; body?: unknown };
/** Fakes window, document, location and fetch for the script, then collects the payload it would send to augur.invalid. */
async function read(answers: Record<string, Answer>, page: { hostname?: string; title?: string; challenge?: boolean } = {}): Promise<Record<string, unknown> | null> {
  let reported: Record<string, unknown> | null = null;
  const document = { title: page.title ?? 'Billing', readyState: 'complete', querySelector: (sel: string) => (page.challenge && sel.includes('cf-turnstile') ? {} : null) };
  const location = { hostname: page.hostname ?? 'platform.claude.com', set href(v: string) { reported = JSON.parse(decodeURIComponent(v.split('data=')[1]!)); } };
  const fetcher = async (url: string) => {
    const hit = answers[url.split('?')[0]!];
    return { ok: hit?.ok ?? false, json: async () => hit?.body };
  };
  const window = {} as { top?: unknown };
  window.top = window;
  new Function('window', 'document', 'location', 'fetch', script)(window, document, location, fetcher);
  await vi.advanceTimersByTimeAsync(26000);
  return reported;
}

const credits = {
  amount: 46055, currency: 'USD', balance: { money: null, credits: { amount_minor: 46055, exponent: 2 } }, auto_reload_settings: null,
  promo_tranches: [{ name: 'API credit (Team)', remaining_amount_minor_units: 45627, granted_amount_minor_units: 50000, expires_at: '2026-11-27T00:00:00Z', granted_at: '2026-10-29T03:20:53.517000Z', id: 'never-read', scope: { kind: 'scoped' } }],
};

describe('Claude Console credit reader', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('reports the credit, each promotional grant and the month so far for an organization, and only the fields Augur uses', async () => {
    vi.useFakeTimers();
    const r = await read({
      '/api/organizations': { ok: true, body: [{ uuid: 'org-1', name: 'Personal' }] },
      '/api/organizations/org-1/prepaid/credits': { ok: true, body: credits },
      '/api/organizations/org-1/current_spend': { ok: true, body: { amount: 4045, resets_at: '2026-12-01T00:00:00Z' } },
    });
    expect(r).toEqual({ signedIn: true, accounts: [{ name: 'Personal', currency: 'USD', exponent: 2, balanceMinor: 46055,
      promos: [{ name: 'API credit (Team)', remainingMinor: 45627, grantedMinor: 50000, expiresAt: '2026-11-27T00:00:00Z', grantedAt: '2026-10-29T03:20:53.517000Z' }],
      spendMinor: 4045, spendResetsAt: '2026-12-01T00:00:00Z' }] });
  });

  it('skips an organization with no credit answer, and keeps one whose spend call fails', async () => {
    vi.useFakeTimers();
    const r = await read({
      '/api/organizations': { ok: true, body: [{ uuid: 'a' }, { uuid: 'b', name: 'B' }] },
      '/api/organizations/a/prepaid/credits': { ok: false },
      '/api/organizations/b/prepaid/credits': { ok: true, body: { ...credits, promo_tranches: [] } },
      '/api/organizations/b/current_spend': { ok: false },
    });
    expect(r).toEqual({ signedIn: true, accounts: [{ name: 'B', currency: 'USD', exponent: 2, balanceMinor: 46055, promos: [], spendMinor: null, spendResetsAt: null }] });
  });

  it('says signed out when the organizations call is refused or the page is not the Console, and a challenge when Cloudflare holds the page', async () => {
    vi.useFakeTimers();
    expect(await read({ '/api/organizations': { ok: false } })).toEqual({ signedIn: false, reason: 'signin' });
    expect(await read({}, { hostname: 'accounts.google.com' })).toEqual({ signedIn: false, reason: 'signin' });
    expect(await read({}, { title: 'Just a moment...', challenge: true })).toEqual({ signedIn: false, reason: 'challenge' });
  });
});

describe('Claude API credit from the Console', () => {
  const now = new Date('2026-11-08T12:00:00Z');
  const account = { currency: 'USD', exponent: 2, balanceMinor: 46055, spendMinor: 4045, spendResetsAt: '2026-12-01T00:00:00Z',
    promos: [{ name: 'Small', remainingMinor: 300, grantedMinor: 500, expiresAt: '2026-12-31T00:00:00Z' }, { name: 'API credit (Team)', remainingMinor: 45627, grantedMinor: 50000, grantedAt: '2026-10-29T03:20:53Z', expiresAt: '2026-11-27T00:00:00Z' }, { name: 'Gone', remainingMinor: 100, grantedMinor: 90000, expiresAt: '2026-10-01T00:00:00Z' }] };
  const host = (web: unknown | 'fail', seen: unknown[] = []) => ({ now: () => now, webSession: async (site: string, o?: { fresh?: boolean }) => { seen.push([site, o?.fresh]); if (web === 'fail') throw new Error('no window'); return web; } }) as unknown as Host;

  it('shows the largest unexpired grant as a monthly bar that renews on its end date, with the credit left and the spend', () => {
    const out = consoleReading([account], now);
    expect(out.meters).toEqual([
      { id: 'monthly_credit', label: 'Monthly credit', usedPct: 8.7, resetsAt: '2026-11-27T00:00:00.000Z', windowSeconds: 2493547, windowKind: 'monthly', detail: '456.27 of 500 left' },
    ]);
    expect(out.money).toEqual([
      { id: 'credit', label: 'API credit left', amount: 460.55, currency: 'USD' },
      { id: 'spend', label: 'Spend this month', amount: 40.45, currency: 'USD', detail: 'Resets 2026-12-01' },
    ]);
    expect(out.notes).toEqual({ webSessions: { console: true } });
  });

  it('gives no bar when no grant is unexpired, and a 30 day bar when the grant date is missing', () => {
    expect(consoleReading([{ ...account, promos: [account.promos[2]] }], now).meters).toEqual([]);
    const bare = consoleReading([{ ...account, promos: [{ remainingMinor: 25000, grantedMinor: 50000, expiresAt: '2026-11-27T00:00:00Z' }] }], now).meters[0]!;
    expect(bare).toMatchObject({ usedPct: 50, windowSeconds: 2592000, windowKind: 'monthly' });
  });

  it('reads only when turned on, asks to skip the cache only on a requested refresh, and names what is missing', async () => {
    const seen: unknown[] = [];
    expect((await claudeApi.fetch(host({ signedIn: true, accounts: [account] }, seen), {})).money).toEqual([]);
    expect(seen).toEqual([]);
    await claudeApi.fetch(host({ signedIn: true, accounts: [] }, seen), { web: true });
    await claudeApi.fetch(host({ signedIn: true, accounts: [] }, seen), { web: true }, { force: true });
    expect(seen).toEqual([['console', false], ['console', true]]);
    expect((await claudeApi.fetch(host({ signedIn: false, reason: 'signin' }), { web: true })).notes).toEqual({ consoleSignIn: true });
    expect((await claudeApi.fetch(host({ signedIn: false, reason: 'challenge' }), { web: true })).notes).toEqual({ consoleChallenge: true });
    expect(await claudeApi.fetch(host('fail'), { web: true })).toEqual({ meters: [], money: [] });
    expect(await claudeApi.fetch(host(null), { web: true })).toEqual({ meters: [], money: [] });
  });
});
