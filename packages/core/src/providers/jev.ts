import type { Money, ProviderPlugin } from '../types.js';
import { json, obj, num } from '../util.js';

const DEFAULT_BASE = 'https://api.typesafe.ai';

/** The address the key is sent to: TypeSafe unless the setting names another Jev-style service. A key only goes over https, or over http to this computer. */
function baseOf(settings: Record<string, unknown>): string {
  const raw = typeof settings.baseUrl === 'string' ? settings.baseUrl.trim().replace(/\/+$/, '') : '';
  if (!raw) return DEFAULT_BASE;
  if (!/^https:\/\/[^/\s]+/.test(raw) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(raw)) throw new Error('The base URL must start with https://, or with http:// for a service on this computer.');
  return raw;
}

export const jev: ProviderPlugin = {
  id: 'jev', name: 'Jev', needsLocalLogin: false, links: {},
  // The balance comes from the console behind Cloudflare, so it is read weekly unless refreshed by hand.
  refreshSeconds: 7 * 86400,
  fields: [{ key: 'apiKey', label: 'API key', kind: 'secret', required: true },
    { key: 'baseUrl', label: 'Base URL', kind: 'text', help: `Leave empty for TypeSafe (${DEFAULT_BASE}). A service with the same /v1/systemone shape can go here. The window and terminal apps read it; the web app reaches TypeSafe only.` },
    { key: 'console', label: 'TypeSafe console', kind: 'signin', site: 'typesafe', help: 'Sign in once to show your credit balance and last 7 days of usage.' }, { key: 'ledgerPath', label: 'Ledger path', kind: 'text', help: 'Home-relative JSONL path with ts and input_tokens' }],
  async fetch(host, settings, options) {
    const key = await host.secret('jev.apiKey');
    if (!key) throw new Error('No API key yet. Add one in settings.');
    const start = (host.now?.() ?? new Date()).getTime();
    const data = obj(await json(host, { url: `${baseOf(settings)}/v1/systemone`, method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', state: { message: 'I was charged twice. Please fix this ASAP.' },
        questions: { billing: { type: 'noul', instructions: 'Is this message about a billing problem?' } } }), timeoutMs: 60000 }));
    if (data.error || !obj(data.answers).billing) throw new Error('The provider did not accept the request. Check the key in settings.');
    const latencyMs = (host.now?.() ?? new Date()).getTime() - start;
    const model = String(data.model ?? 'jev-latest');
    const notes: Record<string, unknown> = { latencyMs, model };
    const ledgerPath = typeof settings.ledgerPath === 'string' ? settings.ledgerPath : '';
    if (ledgerPath && host.readHomeFile) {
      const ledger = await host.readHomeFile(ledgerPath);
      if (ledger) {
        const current = host.now?.() ?? new Date();
        const day = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate());
        const week = day - ((current.getUTCDay() + 6) % 7) * 86400000;
        const totals = { today: { calls: 0, tokens: 0 }, week: { calls: 0, tokens: 0 } };
        for (const line of ledger.split(/\r?\n/)) {
          try {
            const row = obj(JSON.parse(line)), stamp = Date.parse(row.ts), tokens = num(row.input_tokens) ?? 0;
            if (stamp >= week && stamp <= current.getTime()) { totals.week.calls++; totals.week.tokens += tokens; }
            if (stamp >= day && stamp <= current.getTime()) { totals.today.calls++; totals.today.tokens += tokens; }
          } catch { /* Skip invalid ledger lines. */ }
        }
        notes.ledger = totals;
      }
    }
    const money: Money[] = [];
    // TypeSafe has no usage API for keys yet, so balance and usage come from the signed-in console.
    const session = host.webSession ? await host.webSession('typesafe', { fresh: options?.force === true }).catch(() => null) : null;
    if (session?.signedIn === true) {
      const balance = num(session.balance), week = num(session.spend7d);
      if (balance != null) money.push({ id: 'balance', label: 'Credit balance', amount: balance, currency: 'USD' });
      if (week != null) money.push({ id: 'week', label: 'Spent last 7 days', amount: week, currency: 'USD' });
      const buckets = Array.isArray(obj(session.usage).buckets) ? obj(session.usage).buckets as unknown[] : [];
      if (buckets.length) notes.lastWeek = buckets.reduce((t: { requests: number; tokens: number }, b) => {
        const row = obj(b);
        return { requests: t.requests + (num(row.requests) ?? 0), tokens: t.tokens + (num(row.inputTokens) ?? 0) + (num(row.outputTokens) ?? 0) };
      }, { requests: 0, tokens: 0 });
      if (typeof session.refill === 'string') notes.refill = session.refill;
      notes.webSessions = { typesafe: true };
    } else if (session?.signedIn === false) {
      if (session.reason === 'challenge') notes.cloudflareCheck = true;
      else if (session.reason === 'nobalance') { notes.balanceMissing = true; if (session.diag) notes.consoleDiag = session.diag; }
      else notes.signInNeeded = true;
    }
    return { plan: null, detail: `${model} answered in ${latencyMs} ms`, meters: [], money, notes };
  }
};
