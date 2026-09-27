import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

const script = readFileSync(new URL('../../../apps/desktop/src-tauri/src/readers/typesafe.js', import.meta.url), 'utf8');

/** Fakes just enough of window, document and location for the script, then collects the payload it would send to augur.invalid. */
async function read(text: string, page: { title?: string; path?: string; headings?: string[]; signIn?: boolean } = {}): Promise<Record<string, unknown> | null> {
  let reported: Record<string, unknown> | null = null;
  const document = {
    title: page.title ?? 'Billing', readyState: 'complete', body: { innerText: text },
    querySelector: (sel: string) => (page.signIn && sel.includes('password') ? {} : null),
    querySelectorAll: () => (page.headings ?? []).map((h) => ({ innerText: h })),
  };
  const location = { hostname: 'console.typesafe.ai', pathname: page.path ?? '/settings/billing',
    set href(v: string) { reported = JSON.parse(decodeURIComponent(v.split('data=')[1]!)); } };
  const window = {} as { top?: unknown };
  window.top = window;
  new Function('window', 'document', 'location', 'fetch', script)(window, document, location, async () => ({ ok: false }));
  await vi.advanceTimersByTimeAsync(26000);
  return reported;
}

describe('TypeSafe console reader', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('reads the current billing page', async () => {
    vi.useFakeTimers();
    const r = await read('Billing\nYour last payment failed - check your card, then try again.\tView invoice\nAvailable credits\n$38.06\nBalance includes expiring credits\nAdd funds\nRedeem code\nAuto-recharge\nRefills to $20.00 when below $5.00\nOn');
    expect(r).toMatchObject({ signedIn: true, balance: 38.06, refill: 'Refills to $20.00 when below $5.00' });
  });
  it('reads the earlier billing page', async () => {
    vi.useFakeTimers();
    const r = await read('Billing\nCredit Balance $12.50\nSpend $3.10\nRefills to $20.00 when below $5.00');
    expect(r).toMatchObject({ signedIn: true, balance: 12.5, spend7d: 3.1 });
  });
  it('finds a renamed balance and skips spending shown above it', async () => {
    vi.useFakeTimers();
    const r = await read('Billing\nCredits spent last 7 days\n$4.20\nRemaining funds\n$1,207.25\nTop up to $25.00 when under $5.00');
    expect(r).toMatchObject({ signedIn: true, balance: 1207.25, spend7d: 4.2 });
  });
  it('reports the page headings when no balance is shown', async () => {
    vi.useFakeTimers();
    const r = await read('Invoices\nSeptember $10.00 paid', { headings: ['Billing', 'Invoices'] });
    expect(r).toMatchObject({ signedIn: false, reason: 'nobalance', diag: { path: '/settings/billing', headings: ['Billing', 'Invoices'], amounts: 1 } });
  });
  it('tells a sign-in page from a changed billing page', async () => {
    vi.useFakeTimers();
    expect(await read('Sign in to TypeSafe', { signIn: true })).toMatchObject({ signedIn: false, reason: 'signin' });
    expect(await read('Checking your browser', { title: 'Just a moment...' })).toMatchObject({ signedIn: false, reason: 'challenge' });
  });
});
