import { describe, it, expect } from 'vitest';
import { addAlerts, applyAcks, clearResolved, defaultOutlets, emptyFeed, feedFor, feedFromUsage, migrateOutlets, outletsFor, parseAcks, parseFeed } from '../src/feed.js';
import type { FeedAlert } from '../src/feed.js';
import { evaluateAlerts } from '../src/alerts.js';
import { migrateConfig } from '../src/config.js';
import type { Snapshot } from '../src/types.js';

const at = new Date('2026-09-26T12:00:00Z');
const snap = (usedPct: number, resetsAt: string, amount = 3, error: string | null = null): Snapshot => ({ schema: 1, generatedAt: at.toISOString(), providers: {
  sample: { id: 'sample', name: 'Sample', ok: true, stale: false, fetchedAt: at.toISOString(), error,
    meters: [{ id: 'session', label: 'Session', usedPct, resetsAt, windowSeconds: 7200, windowKind: 'session' }],
    money: [{ id: 'balance', label: 'Balance', amount, currency: 'USD' }] } } });
const flags = { models: false, rules: false, update: false };
const alert = (id: string, extra: Partial<FeedAlert> = {}): FeedAlert =>
  ({ id, kind: 'models', severity: 'info', title: 'Augur', body: id, raisedAt: at.toISOString(), outlets: ['augur'], clears: { when: 'never' }, ...extra });

describe('alert outlets', () => {
  it('defaults match the settings grid and survive a partial saved config', () => {
    const d = defaultOutlets();
    expect(outletsFor(d, 'refresh')).toEqual(['augur', 'claude']);
    expect(outletsFor(d, 'update')).toEqual(['augur']);
    const m = migrateOutlets({ refresh: { system: true }, nonsense: { augur: false }, pace: { claude: 'yes' } });
    expect(m.refresh).toEqual({ system: true, augur: true, claude: true, phone: false });
    expect(m.pace.claude).toBe(true);
  });

  it('a config saved before outlets existed gets the defaults', () => {
    expect(migrateConfig({ alerts: { enabled: true } }).alerts.outlets).toEqual(defaultOutlets());
  });
});

describe('the alert feed', () => {
  it('turns a usage alert into a feed entry with the right severity and clear rule', () => {
    const now = snap(92, '2026-09-26T13:00:00Z');
    const history = [{ t: '2026-09-26T11:50:00Z', sample: { session: 70 } }];
    const { alerts } = evaluateAlerts(now, history as never, { ...migrateConfig({}).alerts, enabled: true }, {});
    const crossed = alerts.filter((a) => a.kind === 'percent').map((a) => feedFromUsage(a, 'Sample', at, ['augur']));
    expect(crossed.map((a) => a.severity)).toEqual(['warn', 'crit']);
    expect(crossed[0]?.clears).toEqual({ when: 'window', providerId: 'sample', meterId: 'session', resetsAt: '2026-09-26T13:00:00Z' });
  });

  it('adds newest first, skips repeats and lets a newer alert in a group replace the older one', () => {
    let feed = addAlerts(emptyFeed(at), [alert('a', { group: 'models' })], at);
    feed = addAlerts(feed, [alert('a', { group: 'models' }), alert('b')], at);
    expect(feed.alerts.map((a) => a.id)).toEqual(['b', 'a']);
    feed = addAlerts(feed, [alert('c', { group: 'models' })], at);
    expect(feed.alerts.map((a) => a.id)).toEqual(['c', 'b']);
  });

  it('acks remove alerts and report whether anything changed', () => {
    const feed = addAlerts(emptyFeed(at), [alert('a'), alert('b')], at);
    expect(applyAcks(feed, ['zzz']).changed).toBe(false);
    const r = applyAcks(feed, ['a']);
    expect(r.changed).toBe(true);
    expect(r.feed.alerts.map((a) => a.id)).toEqual(['b']);
  });

  it('clears alerts that no longer apply', () => {
    const feed = addAlerts(emptyFeed(at), [
      alert('window', { clears: { when: 'window', providerId: 'sample', meterId: 'session', resetsAt: '2026-09-26T13:00:00Z' } }),
      alert('balance', { clears: { when: 'balance', providerId: 'sample', moneyId: 'balance', below: 5 } }),
      alert('refresh', { clears: { when: 'refreshed', providerId: 'sample' } }),
      alert('models', { clears: { when: 'flag', flag: 'models' } }),
    ], at);
    const same = clearResolved(feed, snap(92, '2026-09-26T13:00:00Z', 3, 'Timed out'), { ...flags, models: true }, at);
    expect(same.changed).toBe(false);
    const later = clearResolved(feed, snap(5, '2026-09-26T15:00:00Z', 10), flags, at);
    expect(later.feed.alerts).toEqual([]);
    const past = clearResolved(feed, null, { ...flags, models: true }, new Date('2026-09-26T13:00:01Z'));
    expect(past.feed.alerts.map((a) => a.id)).toEqual(['models', 'refresh', 'balance']);
  });

  it('filters by outlet', () => {
    const feed = addAlerts(emptyFeed(at), [alert('a', { outlets: ['claude'] }), alert('b', { outlets: ['augur', 'claude'] })], at);
    expect(feedFor(feed, 'augur').map((a) => a.id)).toEqual(['b']);
    expect(feedFor(feed, 'claude').map((a) => a.id)).toEqual(['b', 'a']);
  });

  it('reads saved feeds and acks files leniently', () => {
    const feed = addAlerts(emptyFeed(at), [alert('a')], at);
    expect(parseFeed(JSON.stringify({ ...feed, alerts: [...feed.alerts, { id: 1 }] })).alerts.map((a) => a.id)).toEqual(['a']);
    expect(parseFeed('not json').alerts).toEqual([]);
    expect(parseAcks('{"id":"a","by":"claude"}\nnot json\n{"id":""}\n{"id":"b"}\n{"id":"c"')).toEqual(['a', 'b']);
  });
});
