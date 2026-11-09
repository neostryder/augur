import { describe, expect, it } from 'vitest';
import { defaultConfig, type ProviderSnapshot, type Snapshot } from '@augur/core';
import { ago, errorText, money, notesParts, paceInfo, series, sevOf, shortAgo, span, statusLabel, tightest, until, usageRows, USAGE_TEXT } from '../src/index.js';

const NOW = Date.parse('2026-10-04T12:00:00Z');

function provider(id: string, meters: ProviderSnapshot['meters'], extra: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return { id, name: id, ok: true, stale: false, fetchedAt: '2026-10-04T11:55:00Z', error: null, plan: null, meters, money: [], notes: {}, ...extra };
}

describe('format', () => {
  it('words times, money and severity', () => {
    expect(span(90 * 60000)).toBe('1h 30m');
    expect(span(3 * 86400000 + 7200000)).toBe('3d 2h');
    expect(until('2026-10-04T11:00:00Z', NOW)).toBe('Resetting now');
    expect(until('2026-10-04T13:00:00Z', NOW)).toMatch(/^Resets in 1h 0m, /);
    expect(ago(null)).toBe('never');
    expect(ago('2026-10-04T11:59:30Z', NOW)).toBe('just now');
    expect(ago('2026-10-04T09:00:00Z', NOW)).toBe('3h ago');
    expect(shortAgo('2026-10-04T11:55:00Z', new Date(NOW))).toBe('5m');
    expect(money(1.5)).toBe('$1.50');
    expect(money(null)).toBe('-');
    expect([sevOf(10), sevOf(80), sevOf(95)]).toEqual(['', 'warn', 'crit']);
    expect(series([{ t: '2026-10-04T10:00:00Z', c: { s: 40 } }, { t: '2026-10-04T11:00:00Z', c: 'x' }], 'c', 's')).toEqual([[Date.parse('2026-10-04T10:00:00Z'), 40]]);
  });
});

describe('usage', () => {
  it('finds the most-used meter, skipping hidden meters and credit counts', () => {
    const config = defaultConfig();
    config.providers = [{ id: 'a', enabled: true, settings: {} }, { id: 'b', enabled: true, settings: {} }, { id: 'c', enabled: false, settings: {} }];
    config.layout.hiddenMeters = { b: ['week'] };
    const snap: Snapshot = { schema: 1, generatedAt: '', providers: {
      a: provider('a', [{ id: 's', label: 'Session', usedPct: 40 }, { id: 'cr', label: 'Credits', usedPct: 99, windowKind: 'credits' }]),
      b: provider('b', [{ id: 'week', label: 'Week', usedPct: 90 }, { id: 'day', label: 'Day', usedPct: 55 }]),
      c: provider('c', [{ id: 'x', label: 'X', usedPct: 100 }]),
    } };
    const t = tightest(config, snap);
    expect([t?.p.id, t?.m.id]).toEqual(['b', 'day']);
  });

  it('says how far through the window a meter is', () => {
    const m = { id: 's', label: 'Session', usedPct: 10, resetsAt: '2026-10-04T13:00:00Z', windowSeconds: 4 * 3600 };
    expect(paceInfo(m, [], 'a', NOW).elapsedPct).toBe(75);
  });

  it('calls a window at 99% or more Spent, and not ahead of pace', () => {
    const m = (usedPct: number) => ({ id: 's', label: 'Session', usedPct, resetsAt: '2026-10-04T13:00:00Z', windowSeconds: 4 * 3600 });
    expect(paceInfo(m(99), [], 'a', NOW)).toMatchObject({ text: 'Spent', bad: true });
    expect(paceInfo(m(100), [], 'a', NOW).text).toBe('Spent');
    expect(paceInfo(m(98), [], 'a', NOW).text).not.toBe('Spent');
  });

  it('reports OpenAI sign-in and challenge notes and ChatGPT jobs on the Codex card', () => {
    expect(notesParts(provider('openai-api', [], { notes: { openaiSignIn: true } }))).toEqual(['Not signed in. Sign in to platform.openai.com in Settings to load billing figures.']);
    expect(notesParts(provider('openai-api', [], { notes: { openaiChallenge: true } }))).toEqual(['A Cloudflare check is blocking the billing page. Open the billing page from Settings and pass the check.']);
    expect(notesParts(provider('codex', [], { notes: { chatgptJobsWeek: 4 } }))).toEqual(['Includes ChatGPT chat jobs run through Augur: 4 in the last 7 days']);
    expect(notesParts(provider('openai-api', [], { notes: { chatgptJobsWeek: 4 } }))).toEqual([]);
  });

  it('shows weekly activity and the existing breakdown without period or promotional rows', () => {
    const total = { calls: 2, inputTokens: 100, outputTokens: 20, images: 1, costUsd: 0.05, costCalls: 1, estimated: true };
    const parts = notesParts(provider('openai-api', [], { notes: { openaiLedger: { periods: { today: total, week: total, month: total }, models: { example: total } }, openaiPromos: [{ amount: 5, detail: 'Ends 2026-12-01' }] } }));
    expect(parts).toEqual([
      '2 requests, 120 tokens, last 7 days',
      'example, month to date: 2 calls, 100 input tokens, 20 output tokens, 1 image, estimated $0.05000',
    ]);
  });

  it('keeps one activity line when the ledger has no calls', () => {
    const total = { calls: 0, inputTokens: 0, outputTokens: 0, images: 0, costUsd: 0, costCalls: 0, estimated: true };
    expect(notesParts(provider('openai-api', [], { notes: { openaiLedger: { periods: { week: total, month: total }, models: { example: total } } } })))
      .toEqual(['0 requests, 0 tokens, last 7 days']);
  });

  it.each(['gemini', 'cogitator'])('hides zero money rows and gives an empty %s card one status line', (id) => {
    const p = provider(id, [], { money: [{ id: 'month', label: 'Month', amount: 0, currency: 'USD' }] });
    const layout = defaultConfig().layout;
    expect(usageRows(p, layout)).toEqual({ meters: [], money: [], notes: [], status: USAGE_TEXT.noUsage });
    const shown = usageRows(p, { ...layout, showHiddenRows: true });
    expect(shown.money).toEqual(p.money);
    expect(shown.status).toBe('');
  });

  it('keeps nonzero money, zero meters, notes and errors and respects explicit visibility settings', () => {
    const p = provider('gemini', [{ id: 'meter', label: 'Meter', usedPct: 0 }], {
      money: [0, 1, -1, null].map((amount, i) => ({ id: String(i), label: String(i), amount, currency: 'USD' })),
      notes: { consoleSignIn: true }, error: 'Timed out.',
    });
    const layout = defaultConfig().layout, rows = usageRows(p, layout);
    expect(rows.meters).toEqual(p.meters);
    expect(rows.money.map(row => row.amount)).toEqual([1, -1]);
    expect(rows.notes).toEqual(notesParts(p));
    expect(rows.status).toBe('');
    expect(p.error).toBe('Timed out.');
    expect(usageRows(p, { ...layout, showHiddenRows: true, hiddenMeters: { gemini: ['$0', 'meter'] } }).money.map(row => row.amount)).toEqual([1, -1]);
    expect(usageRows(p, { ...layout, hiddenMeters: { gemini: ['meter'] } }).meters).toEqual([]);
    expect(usageRows(provider('gemini', [], { error: 'Failed' }), layout).status).toBe('');
    expect(usageRows(provider('gemini', [], { notes: { consoleSignIn: true } }), layout).status).toBe('');
    expect(usageRows(provider('gemini', [], { status: { indicator: 'major' } }), layout).status).toBe('');
  });

  it('words status, notes and errors', () => {
    expect(statusLabel(provider('a', [], { status: { indicator: 'minor', description: 'Slow' } }))).toEqual({ label: 'Degraded', severe: false, description: 'Slow' });
    expect(statusLabel(provider('a', [], { status: { indicator: 'none' } }))).toBeNull();
    expect(notesParts(provider('a', [], { notes: { resetsAvailable: 1, latencyMs: 812.4 } }))).toEqual(['1 limit reset available', 'Answered in 812 ms']);
    expect(notesParts(provider('a', [], { notes: { consoleSignIn: true } }))).toEqual(['Claude API credit is not read yet. Sign in to the Claude Console in settings.']);
    expect(errorText(provider('a', [], { error: 'Timed out.', stale: true }), () => '5m ago')).toBe('Refresh failed: Timed out. Showing the figures from 5m ago.');
    expect(errorText(provider('a', [], { error: 'No key.', fetchedAt: null }), () => '')).toBe('No key.');
  });
});
