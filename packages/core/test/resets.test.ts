import { describe, expect, it } from 'vitest';
import { detectResets, parseResetLog, resetPattern, serializeResets, summarizeResets } from '../src/index.js';
import type { ResetEvent, Snapshot } from '../src/index.js';

const START = '2026-10-03T22:00:00.000Z';
const END = '2026-10-03T23:00:00.000Z';
const RESET = '2026-10-07T23:00:00.000Z';
const NOW = new Date('2026-11-01T00:00:00.000Z');

function snapshot(used: number | null, at = END): Snapshot {
  return { schema: 1, generatedAt: at, providers: {
    codex: { id: 'codex', name: 'Codex', ok: true, stale: false, fetchedAt: at, error: null, money: [], plan: 'Pro',
      status: { indicator: 'none' }, notes: { resets_available: 2 },
      meters: [{ id: 'plan_weekly', label: 'Weekly limit', usedPct: used, windowKind: 'weekly', windowSeconds: 604800, resetsAt: RESET }] },
  } };
}

function event(at = END): ResetEvent {
  const row = detectResets(snapshot(83, START), snapshot(0, at))[0]!;
  return row;
}

describe('reset detection', () => {
  it.each([83, 99, 3, 36])('records an early drop from %s to zero', used => {
    const rows = detectResets(snapshot(used, START), snapshot(0));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ v: 1, id: `codex.plan_weekly.${END}`, kind: 'reset', provider: 'codex', meter: 'plan_weekly',
      label: 'Weekly limit', at: END, since: START, usedBefore: used, usedAfter: 0, resetsAtBefore: RESET, resetsAtAfter: RESET,
      windowSeconds: 604800, scheduled: false, earlySeconds: 4 * 86400, atLimit: used >= 98,
      creditsBefore: 2, creditsAfter: 2, status: 'none', plan: 'Pro' });
  });

  it('recognizes a scheduled reset and the five-minute grace', () => {
    for (const offset of [-3600, 0, 300, 301]) {
      const before = snapshot(99, START);
      before.providers.codex!.meters[0]!.resetsAt = new Date(Date.parse(END) + offset * 1000).toISOString();
      const row = detectResets(before, snapshot(0))[0]!;
      expect(row.scheduled).toBe(offset <= 300);
      expect(row.earlySeconds).toBe(offset <= 300 ? 0 : 301);
    }
  });

  it('uses a limit note and requires both a two-point and a half-usage drop', () => {
    const before = snapshot(36, START);
    before.providers.codex!.notes!.limit_reached = true;
    expect(detectResets(before, snapshot(0))[0]!.atLimit).toBe(true);
    expect(detectResets(snapshot(26, START), snapshot(25))).toEqual([]);
    expect(detectResets(snapshot(26, START), snapshot(23))).toEqual([]);
    expect(detectResets(snapshot(4, START), snapshot(2))).toHaveLength(1);
  });

  it('ignores a reset time that moves while an unused window stays at zero', () => {
    const before = snapshot(0, START), after = snapshot(0);
    after.providers.codex!.meters[0]!.resetsAt = '2026-10-08T00:00:00.000Z';
    expect(detectResets(before, after)).toEqual([]);
    expect(detectResets(null, after)).toEqual([]);
  });

  it('ignores stale, failed, missing, invalid, and unchanged readings on either side', () => {
    for (const side of ['before', 'after'] as const) {
      for (const change of ['stale', 'failed', 'missing', 'invalid', 'time'] as const) {
        const before = snapshot(83, START), after = snapshot(0), target = side === 'before' ? before : after;
        const provider = target.providers.codex!;
        if (change === 'stale') provider.stale = true;
        if (change === 'failed') provider.ok = false;
        if (change === 'missing') provider.meters[0]!.usedPct = null;
        if (change === 'invalid') provider.meters[0]!.usedPct = NaN;
        if (change === 'time') provider.fetchedAt = null;
        expect(detectResets(before, after)).toEqual([]);
      }
    }
    expect(detectResets(snapshot(83), snapshot(0))).toEqual([]);
    expect(detectResets(snapshot(83), snapshot(0, START))).toEqual([]);
  });

  it('compares only the provider that refreshed', () => {
    const before = snapshot(83, START), after = snapshot(0);
    before.providers.other = { ...before.providers.codex!, id: 'other' };
    after.providers.other = { ...after.providers.codex!, id: 'other', fetchedAt: START };
    expect(detectResets(before, after).map(row => row.provider)).toEqual(['codex']);
  });

  it('ignores scoped and other window kinds, and includes sessions', () => {
    for (const kind of ['weekly', 'session', 'daily', 'credits'] as const) {
      const before = snapshot(83, START), after = snapshot(0);
      before.providers.codex!.meters[0]!.windowKind = kind;
      after.providers.codex!.meters[0]!.windowKind = kind;
      expect(detectResets(before, after)).toHaveLength(kind === 'weekly' || kind === 'session' ? 1 : 0);
      before.providers.codex!.meters[0]!.id = 'weekly_scoped';
      after.providers.codex!.meters[0]!.id = 'weekly_scoped';
      expect(detectResets(before, after)).toEqual([]);
    }
  });

  it('records a credit change against the most used window without inventing a reset', () => {
    const before = snapshot(83, START), after = snapshot(84);
    after.providers.codex!.notes!.resets_available = 3;
    const row = detectResets(before, after)[0]!;
    expect(row).toMatchObject({ kind: 'credits', usedBefore: 83, usedAfter: 84, creditsBefore: 2, creditsAfter: 3,
      scheduled: false, earlySeconds: 0, atLimit: false });
    delete before.providers.codex!.notes!.resets_available;
    expect(detectResets(before, after)).toEqual([]);
  });

  it('keeps a credit fall on the reset without adding a second event', () => {
    const before = snapshot(83, START), after = snapshot(0);
    after.providers.codex!.notes!.resets_available = 1;
    const rows = detectResets(before, after);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'reset', creditsBefore: 2, creditsAfter: 1 });
    expect(summarizeResets(rows, { now: NOW, utcOffsetMinutes: 0 }).meters[0]!.creditFalls).toBe(1);
  });
});

describe('reset ledger and summaries', () => {
  it('round-trips newline-terminated JSONL, skips bad rows, sorts, and removes duplicates', () => {
    const first = event(), last = event('2026-10-05T23:00:00.000Z');
    expect(serializeResets([])).toBe('');
    expect(serializeResets([first]).endsWith('\n')).toBe(true);
    expect(parseResetLog('\ninvalid\n{}\n' + serializeResets([last, first, first]) + '{"v":1')).toEqual([first, last]);
    for (const key of Object.keys(first)) {
      const partial = { ...first } as Record<string, unknown>;
      delete partial[key];
      expect(parseResetLog(JSON.stringify(partial))).toEqual([]);
    }
  });

  it('calculates gaps and local time buckets and states the small sample size', () => {
    const rows = [event(), event('2026-10-04T23:00:00.000Z'), event('2026-10-06T23:00:00.000Z')];
    rows[1]!.scheduled = true;
    rows[1]!.earlySeconds = 0;
    rows[2]!.atLimit = true;
    const result = summarizeResets(rows, { now: NOW, utcOffsetMinutes: 120 });
    expect(result.rows).toBe(3);
    const meter = result.meters[0]!;
    expect(meter).toMatchObject({ count: 3, scheduled: 1, early: 2, atLimit: 1, medianGapHours: 36, minGapHours: 24,
      maxGapHours: 48, averageEarlyHours: 60, firstAt: END, lastAt: rows[2]!.at, sample: 'small' });
    expect(meter.hours).toEqual(Array.from({ length: 24 }, (_, i) => i === 1 ? 3 : 0));
    expect(meter.weekdays).toEqual([1, 1, 0, 1, 0, 0, 0]);
    expect(meter.lines).toContain('Small sample: 3 resets; fewer than 10 recorded.');
    expect(summarizeResets([event()], { now: NOW, utcOffsetMinutes: -120 }).meters[0]!.hours[21]).toBe(1);
    expect(summarizeResets(rows, { now: new Date(START), utcOffsetMinutes: 0 })).toEqual({ rows: 0, meters: [] });
  });

  it('counts credit-only groups and both credit directions', () => {
    const rise = { ...event(), kind: 'credits' as const, creditsAfter: 3 };
    const fall = { ...event('2026-10-04T23:00:00.000Z'), kind: 'credits' as const, creditsAfter: 1 };
    expect(summarizeResets([rise, fall], { now: NOW, utcOffsetMinutes: 0 }).meters[0]).toMatchObject({ count: 0,
      creditRises: 1, creditFalls: 1, sample: 'none', medianGapHours: null, averageEarlyHours: null, lines: expect.arrayContaining(['No resets recorded.']) });
  });

  it('builds compact weekly notes with the sample threshold and no session substitution', () => {
    expect(resetPattern([], NOW)).toBeNull();
    expect(resetPattern([{ ...event(), windowSeconds: 18000 }], NOW)).toBeNull();
    expect(resetPattern([event()], NOW)).toEqual({ count: 1, early: 1, atLimit: 0, medianGapHours: null, lastAt: END, sample: 'small' });
    const rows = Array.from({ length: 10 }, (_, i) => event(new Date(Date.parse(END) + i * 86400000).toISOString()));
    expect(resetPattern(rows, NOW)).toMatchObject({ count: 10, medianGapHours: 24, sample: 'enough' });
  });
});
