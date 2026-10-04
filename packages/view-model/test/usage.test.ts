import { describe, expect, it } from 'vitest';
import { defaultConfig, type ProviderSnapshot, type Snapshot } from '@augur/core';
import { ago, errorText, money, notesParts, paceInfo, series, sevOf, shortAgo, span, statusLabel, tightest, until } from '../src/index.js';

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

  it('words status, notes and errors', () => {
    expect(statusLabel(provider('a', [], { status: { indicator: 'minor', description: 'Slow' } }))).toEqual({ label: 'Degraded', severe: false, description: 'Slow' });
    expect(statusLabel(provider('a', [], { status: { indicator: 'none' } }))).toBeNull();
    expect(notesParts(provider('a', [], { notes: { resetsAvailable: 1, latencyMs: 812.4 } }))).toEqual(['1 limit reset available', 'Answered in 812 ms']);
    expect(errorText(provider('a', [], { error: 'Timed out.', stale: true }), () => '5m ago')).toBe('Refresh failed: Timed out. Showing the figures from 5m ago.');
    expect(errorText(provider('a', [], { error: 'No key.', fetchedAt: null }), () => '')).toBe('No key.');
  });
});
