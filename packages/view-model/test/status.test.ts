import { describe, expect, it } from 'vitest';
import { defaultConfig, type FeedAlert, type ProviderSnapshot, type Snapshot } from '@augur/core';
import { statusLine } from '../src/index.js';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const provider = (id: string, name: string, meters: ProviderSnapshot['meters'], extra: Partial<ProviderSnapshot> = {}): ProviderSnapshot =>
  ({ id, name, ok: true, stale: false, fetchedAt: '2026-10-04T11:55:00Z', error: null, plan: null, meters, money: [], notes: {}, ...extra });
const snap = (providers: ProviderSnapshot[], generatedAt = '2026-10-04T11:58:00Z'): Snapshot =>
  ({ schema: 1, generatedAt, providers: Object.fromEntries(providers.map((p) => [p.id, p])) });
const alert = (id: string, severity: FeedAlert['severity']): FeedAlert =>
  ({ id, kind: 'percent', severity, title: `Alert ${id}`, body: '', raisedAt: '2026-10-04T11:00:00Z', outlets: ['augur'], clears: { when: 'never' } });
const config = () => { const c = defaultConfig(); c.providers = [{ id: 'claude', enabled: true, settings: {} }, { id: 'grok', enabled: true, settings: {} }, { id: 'off', enabled: false, settings: {} }]; return c; };
const claude = provider('claude', 'Claude', [
  { id: 'session', label: 'Session', usedPct: 32, windowKind: 'session', windowSeconds: 18_000 },
  { id: 'weekly_all', label: 'Week', usedPct: 49, windowKind: 'weekly' },
]);

describe('statusLine', () => {
  it("leads with Claude's session and week, and stays ok while nothing runs hot", () => {
    const r = statusLine(config(), snap([claude, provider('grok', 'Grok', [{ id: 'w', label: 'Week', usedPct: 20, windowKind: 'weekly' }])]), [], NOW);
    expect(r.text).toBe('Claude 5h 32% | wk 49%');
    expect(r.level).toBe('ok');
    expect(r.tooltip).toContain('Grok wk 20%');
  });

  it('adds a provider at 70 percent, marks 90 critical, and counts the alerts', () => {
    const grok = provider('grok', 'Grok', [{ id: 'w', label: 'Week', usedPct: 91, windowKind: 'weekly' }]);
    const r = statusLine(config(), snap([claude, grok]), [alert('a', 'warn'), alert('b', 'warn')], NOW);
    expect(r.text).toBe('Claude 5h 32% | wk 49% | Grok wk 91% | 2 Augur alerts');
    expect(r.level).toBe('crit');
    expect(r.alerts).toBe(2);
  });

  it('names a stale provider, adds the age of old numbers, and skips providers that are off', () => {
    const stale = provider('grok', 'Grok', [], { stale: true });
    const off = provider('off', 'Off', [{ id: 'w', label: 'Week', usedPct: 99, windowKind: 'weekly' }]);
    const r = statusLine(config(), snap([claude, stale, off], '2026-10-04T11:00:00Z'), [alert('a', 'info')], NOW);
    expect(r.text).toBe('Claude 5h 32% | wk 49% | Grok stale | as of 60m ago | 1 Augur alert');
    expect(r.level).toBe('warn');
  });

  it('says so when there is no usage yet or nothing to report', () => {
    expect(statusLine(config(), null, [], NOW).text).toBe('Augur: no usage yet');
    expect(statusLine(config(), snap([provider('off', 'Off', [])]), [], NOW).text).toBe('Augur ok');
  });
});
