import { describe, expect, it } from 'vitest';
import { evaluateAlerts } from '../src/alerts.js';
import { defaultConfig, migrateConfig } from '../src/config.js';
import { addAlerts, clearResolved, defaultOutlets, emptyFeed, feedFromUsage } from '../src/feed.js';
import { usageAlerts } from '../src/registry.js';
import { emptyPolicy, fieldPath, setField } from '../src/policy.js';
import { importPolicy } from '../src/policy-import.js';
import type { HistoryRow } from '../src/history.js';
import type { Snapshot } from '../src/types.js';

const now = new Date('2026-10-10T12:00:00Z'), end = '2026-10-12T12:00:00Z';
const flags = { models: false, rules: false, update: false };
const config = () => ({ ...defaultConfig().alerts, enabled: true });
const snapshot = (usedPct = 2): Snapshot => ({ schema: 1, generatedAt: now.toISOString(), providers: {
  sample: { id: 'sample', name: 'Sample', ok: true, stale: false, fetchedAt: now.toISOString(), error: null, status: { indicator: 'none' }, money: [],
    meters: [{ id: 'weekly', label: 'Weekly', usedPct, windowKind: 'weekly', windowSeconds: 604800, resetsAt: end }] },
} });
const history = (hours = 6, usedPct = 2): HistoryRow[] => [{ t: new Date(now.getTime() - hours * 3600000).toISOString(), sample: { weekly: usedPct } }];
const evaluate = (snap = snapshot(), rows = history(), drain = new Set(['sample'])) => evaluateAlerts(snap, rows, config(), {}, { drain });
const idle = (snap = snapshot(), rows = history(), drain = new Set(['sample'])) => evaluate(snap, rows, drain).alerts.filter(a => a.kind === 'idle');

describe('idle alerts', () => {
  it('fires at the configured hours and gives usage, idle time, and reset time', () => {
    expect(idle()).toHaveLength(1);
    expect(idle()[0]!.message).toBe('Sample is idle: 2% of Weekly used, idle for 6.0 hours, with 48.0 hours until reset.');
    expect(idle(snapshot(), history(7))).toHaveLength(1);
    expect(idle(snapshot(), history(5.99))).toEqual([]);
    expect(idle(snapshot(), [])).toEqual([]);
  });

  it('uses the configured percent and hours and counts only consecutive low readings', () => {
    expect(idle(snapshot(5))).toEqual([]);
    expect(idle(snapshot(20))).toEqual([]);
    const rows = [...history(8), ...history(7, 10), ...history(5)];
    expect(idle(snapshot(), rows)).toEqual([]);
    const r = evaluateAlerts(snapshot(8), history(2, 8), { ...config(), idlePct: 10, idleHours: 2 }, {}, { drain: new Set(['sample']) });
    expect(r.alerts.filter(a => a.kind === 'idle')).toHaveLength(1);
    const fired = evaluate();
    expect(evaluateAlerts(snapshot(), history(), config(), fired.firedState, { drain: new Set(['sample']) }).alerts.filter(a => a.kind === 'idle')).toEqual([]);
  });

  it('requires a drain role, a weekly window, and healthy current readings', () => {
    expect(idle(snapshot(), history(), new Set())).toEqual([]);
    for (const change of [
      (s: Snapshot) => { s.providers.sample!.ok = false; },
      (s: Snapshot) => { s.providers.sample!.stale = true; },
      (s: Snapshot) => { s.providers.sample!.status = { indicator: 'minor' }; },
      (s: Snapshot) => { s.providers.sample!.meters = []; },
      (s: Snapshot) => { s.providers.sample!.meters[0]!.windowKind = 'session'; },
      (s: Snapshot) => { s.providers.sample!.meters[0]!.resetsAt = null; },
      (s: Snapshot) => { s.providers.sample!.meters[0]!.usedPct = null; },
      (s: Snapshot) => { s.providers.sample!.meters[0]!.resetsAt = now.toISOString(); },
    ]) {
      const s = snapshot(); change(s); expect(idle(s)).toEqual([]);
    }
    const s = snapshot(); s.providers.sample!.status = null;
    expect(idle(s)).toHaveLength(1);
  });

  it('fires for a window that has not started, whose reset time moves with the clock, and counts from the last use', () => {
    const s = snapshot(0);
    s.providers.sample!.meters[0]!.resetsAt = new Date(now.getTime() + 604800000).toISOString();
    expect(idle(s, history(7, 0))).toHaveLength(1);
    const rows = [...history(30, 83), ...history(7, 0)];
    expect(idle(s, rows)[0]!.message).toContain('idle for 7.0 hours');
    const first = evaluate(s, rows);
    const later = new Date(now.getTime() + 3600000), next = snapshot(0);
    next.generatedAt = later.toISOString();
    next.providers.sample!.meters[0]!.resetsAt = new Date(later.getTime() + 604800000).toISOString();
    expect(evaluateAlerts(next, rows, config(), first.firedState, { drain: new Set(['sample']) }).alerts.filter(a => a.kind === 'idle')).toEqual([]);
  });

  it('requires every unscoped weekly meter to be low and fires once on the first meter', () => {
    const s = snapshot(), meters = s.providers.sample!.meters;
    meters[0]!.id = 'plan_weekly'; meters[0]!.usedPct = 60;
    meters.push({ ...meters[0]!, id: 'review_weekly', usedPct: 0 });
    const rows: HistoryRow[] = [{ t: history()[0]!.t, sample: { plan_weekly: 60, review_weekly: 0 } }];
    expect(idle(s, rows)).toEqual([]);
    meters[0]!.usedPct = 0; rows[0]!.sample = { plan_weekly: 0, review_weekly: 0 };
    expect(idle(s, rows).map(alert => alert.meterId)).toEqual(['plan_weekly']);
    meters.push({ ...meters[0]!, id: 'scoped_weekly', usedPct: 80 });
    expect(idle(s, rows).map(alert => alert.meterId)).toEqual(['plan_weekly']);
    meters[1]!.usedPct = null;
    expect(idle(s, rows)).toEqual([]);
  });

  it('repeats daily while the provider stays idle', () => {
    const first = evaluate();
    const later = new Date(now.getTime() + 86400000 + 1000), next = snapshot();
    next.generatedAt = later.toISOString();
    next.providers.sample!.meters[0]!.resetsAt = new Date(later.getTime() + 172800000).toISOString();
    expect(evaluateAlerts(next, history(), config(), first.firedState, { drain: new Set(['sample']) }).alerts.filter(a => a.kind === 'idle')).toHaveLength(1);
  });

  it('clears on use, window end, a new window, stale readings, or unhealthy status', () => {
    const alert = feedFromUsage(idle()[0]!, 'Sample', now, ['augur', 'claude']);
    const feed = addAlerts(emptyFeed(now), [alert], now);
    expect(clearResolved(feed, snapshot(), flags, now).changed).toBe(false);
    for (const change of [
      (s: Snapshot) => { s.providers.sample!.meters[0]!.usedPct = 5; },
      (s: Snapshot) => { s.providers.sample!.meters[0]!.resetsAt = '2026-10-19T12:00:00Z'; },
      (s: Snapshot) => { s.providers.sample!.ok = false; },
      (s: Snapshot) => { s.providers.sample!.stale = true; },
      (s: Snapshot) => { s.providers.sample!.status = { indicator: 'major' }; },
    ]) {
      const s = snapshot(); change(s);
      expect(clearResolved(feed, s, flags, now).feed.alerts).toEqual([]);
    }
    expect(clearResolved(feed, snapshot(), flags, new Date(end)).feed.alerts).toEqual([]);
    expect(clearResolved(feed, null, flags, new Date(end)).feed.alerts).toEqual([]);
  });

  it('migrates old settings and rejects invalid values with bounded defaults', () => {
    expect(defaultOutlets().idle).toEqual({ system: false, augur: true, claude: true, phone: false });
    expect(migrateConfig({ alerts: { enabled: true, outlets: { pace: { phone: false } } } }).alerts).toMatchObject({ idlePct: 5, idleHours: 6, outlets: { idle: defaultOutlets().idle, pace: { phone: false } } });
    expect(migrateConfig({ alerts: { idlePct: 9, idleHours: 12 } }).alerts).toMatchObject({ idlePct: 9, idleHours: 12 });
    for (const value of [-1, Infinity, NaN, '8', null]) expect(migrateConfig({ alerts: { idlePct: value, idleHours: value } }).alerts).toMatchObject({ idlePct: 5, idleHours: 6 });
    expect(migrateConfig({ alerts: { idlePct: 101, idleHours: 169 } }).alerts).toMatchObject({ idlePct: 5, idleHours: 6 });
    expect(migrateConfig({ alerts: { idlePct: 0, idleHours: 0 } }).alerts).toMatchObject({ idlePct: 0, idleHours: 0 });
  });

  it('finds drain roles from confirmed rules, including inherited useAfter', () => {
    const c = defaultConfig(), policy = emptyPolicy();
    importPolicy(policy, { providers: {
      sample: { defaults: {}, models: { 'sample/main': { id: 'main', rule: {} } } },
      backup: { defaults: { useAfter: ['sample/main'] }, models: { 'backup/main': { id: 'backup', rule: {} } } },
    } }, now);
    c.policy = policy; c.alerts.enabled = true;
    expect(usageAlerts(snapshot(), history(), c, {}).alerts.filter(a => a.usage.kind === 'idle')).toEqual([]);
    setField(policy, fieldPath('backup', 'backup/main', 'status'), 'confirmed', 'test', now);
    expect(usageAlerts(snapshot(), history(), c, {}).alerts.filter(a => a.usage.kind === 'idle')).toHaveLength(1);
  });
});
