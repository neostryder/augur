import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

const script = readFileSync(new URL('../../../apps/desktop/src-tauri/src/readers/openai.js', import.meta.url), 'utf8');
type Answer = { ok: boolean; body?: unknown };

async function read(answers: Record<string, Answer>, page: { hostname?: string; pathname?: string; title?: string; challenge?: boolean; text?: string } = {}) {
  let reported: Record<string, unknown> | null = null;
  const calls: Array<{ path: string; options: unknown }> = [];
  const document = { title: page.title ?? 'Billing', readyState: 'complete', body: { innerText: page.text ?? 'Billing' },
    querySelector: (selector: string) => page.challenge && selector.includes('cf-turnstile') ? {} : null };
  const location = { hostname: page.hostname ?? 'platform.openai.com', pathname: page.pathname ?? '/settings/organization/billing/overview',
    set href(value: string) { reported = JSON.parse(decodeURIComponent(value.split('data=')[1]!)); } };
  const fetcher = async (path: string, options: unknown) => {
    calls.push({ path, options });
    const answer = answers[path.split('?')[0]!];
    return { ok: answer?.ok ?? false, json: async () => answer?.body };
  };
  const window = {} as { top?: unknown };
  window.top = window;
  new Function('window', 'document', 'location', 'fetch', script)(window, document, location, fetcher);
  await vi.advanceTimersByTimeAsync(26000);
  return { reported, calls };
}

describe('OpenAI billing reader', () => {
  afterEach(() => vi.useRealTimers());

  it('projects candidate payloads into numeric billing fields without retaining unrelated data', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));
    const { reported, calls } = await read({
      '/dashboard/billing/credit_grants': { ok: true, body: { total_available: 42.5, unrelated: 'discarded',
        grants: { data: [{ type: 'promotional', remaining_amount: 8, expires_at: 1796083200, name: 'discarded' }, { type: 'paid', remaining_amount: 30 }] } } },
      '/dashboard/billing/usage': { ok: true, body: { total_usage: 1234, unrelated: 'discarded' } },
    });
    expect(reported).toEqual({ signedIn: true, account: { balance: 42.5, spend: 12.34,
      promos: [{ remaining: 8, expiresAt: '2026-12-01T00:00:00.000Z' }] } });
    expect(calls[1]!.path).toContain('start_date=2026-11-01&end_date=2026-12-01');
    expect(calls.every(call => call.path.startsWith('/') && JSON.stringify(call.options) === JSON.stringify({ credentials: 'include', redirect: 'error' }))).toBe(true);
  });

  it('tries the alternate paths and falls back to explicitly labelled dollars and expiry dates', async () => {
    vi.useFakeTimers();
    const alternate = await read({ '/v1/dashboard/billing/credit_grants': { ok: true, body: { total_available: 7 } } });
    expect(alternate.reported).toMatchObject({ signedIn: true, account: { balance: 7, spend: null } });
    const fallback = await read({}, { text: 'Billing\nCredit balance\n$1,234.56\nUsage this month\n$23.45\nFree credits\n$8.00\nExpires December 1, 2026' });
    expect(fallback.reported).toEqual({ signedIn: true, account: { balance: 1234.56, spend: 23.45,
      promos: [{ remaining: 8, expiresAt: new Date(2026, 11, 1).toISOString() }] } });
  });

  it('does not interpret a spending limit or an unrelated dollar amount as usage', async () => {
    vi.useFakeTimers();
    const { reported } = await read({}, { text: 'Billing\nMonthly budget $100.00\nPayment method $4.00' });
    expect(reported).toEqual({ signedIn: true, account: { balance: null, spend: null, promos: [] } });
  });

  it('uses the Console sign-in and challenge outcomes', async () => {
    vi.useFakeTimers();
    expect((await read({}, { hostname: 'auth.openai.com' })).reported).toEqual({ signedIn: false, reason: 'signin' });
    expect((await read({}, { pathname: '/login' })).reported).toEqual({ signedIn: false, reason: 'signin' });
    expect((await read({}, { text: 'Sign in to continue' })).reported).toEqual({ signedIn: false, reason: 'signin' });
    expect((await read({}, { title: 'Just a moment...', challenge: true })).reported).toEqual({ signedIn: false, reason: 'challenge' });
  });
});
