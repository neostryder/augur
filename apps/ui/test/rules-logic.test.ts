import type { Snapshot } from '@augur/core';
import { describe, expect, it } from 'vitest';
import { changeText, pauseResets, RESET_TRUST_MS, showValue } from '../src/views/rules';

const NOW = Date.parse('2026-09-29T20:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const snap = (over: Record<string, unknown> = {}): Snapshot => ({ schema: 1, generatedAt: iso(NOW), providers: { claude: {
  id: 'claude', name: 'Claude', ok: true, stale: false, fetchedAt: iso(NOW - 60_000), error: null, money: [],
  meters: [{ id: 'session', label: 'Session', usedPct: 10, resetsAt: iso(NOW + 3600_000) }, { id: 'weekly', label: 'Weekly', usedPct: 60, resetsAt: iso(NOW - 1000) }, { id: 'credits', label: 'Credits', usedPct: null }],
  ...over } } } as unknown as Snapshot);

describe('resets a pause may wait for', () => {
  it('offers only meters whose reset is still ahead', () => {
    expect(pauseResets(snap(), 'claude', NOW)).toMatchObject({ meters: [{ id: 'session' }], blocked: null });
  });

  it('offers none, and says why, when the last reading failed or is stale', () => {
    expect(pauseResets(snap({ stale: true }), 'claude', NOW)).toMatchObject({ meters: [], blocked: expect.stringContaining('failed') });
    expect(pauseResets(snap({ ok: false }), 'claude', NOW).meters).toEqual([]);
    expect(pauseResets(snap({ fetchedAt: iso(NOW - RESET_TRUST_MS - 1) }), 'claude', NOW)).toMatchObject({ meters: [], blocked: expect.stringContaining('30 minutes') });
    expect(pauseResets(snap({ fetchedAt: null }), 'claude', NOW).meters).toEqual([]);
  });

  it('has nothing to offer, and nothing to say, for a provider with no readings', () => {
    expect(pauseResets(snap(), 'chatgpt', NOW)).toEqual({ meters: [], blocked: null });
    expect(pauseResets(null, 'claude', NOW)).toEqual({ meters: [], blocked: null });
  });
});

describe('describing a rule change', () => {
  it('reads plain values as words and a missing one as unset', () => {
    expect(changeText('cost', 'moderate', 'very_high')).toBe('moderate to very high');
    expect(changeText('output', null, 'text_only')).toBe('unset to text only');
    expect(changeText('useAfter', ['codex/sol'], ['codex/sol', 'xai/grok'])).toBe('codex/sol to codex/sol, xai/grok');
    expect(changeText('useAfter', ['codex/sol'], [])).toBe('codex/sol to none');
    expect(changeText('useAfter', null, ['codex/sol'])).toBe('unset to codex/sol');
  });

  it('shows only the parts of a grouped value that differ', () => {
    expect(changeText('dataHandling', { retention: 'none', training: 'no', region: 'us' }, { retention: 'none', training: 'yes', region: 'us' })).toBe('training no to yes');
    expect(changeText('dataHandling', { retention: 'none' }, { retention: 'none', region: 'us' })).toBe('region unset to us');
  });

  it('reads a pause as its end time, with the weights it changes', () => {
    expect(showValue('pause', { until: '2026-10-04T17:00:00Z' })).toMatch(/^paused until /);
    const weights = showValue('pause', { until: '2026-10-04T17:00:00Z', weights: { write_code: 'often', research: null } });
    expect(weights).toMatch(/^weights changed until .*\(.*often.*not allowed.*\)$/);
    expect(changeText('pause', null, { until: '2026-10-04T17:00:00Z' })).toMatch(/^unset to paused until /);
  });
});
