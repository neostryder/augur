import { describe, expect, it } from 'vitest';
import { openRules } from './open-rules.js';
import { addModels, buildPolicyFile, emptyPolicy, fieldPath, importPolicy, newProvider, readFleet, setField } from '@augur/core';
import type { PolicyFile } from '@augur/core';
import { COLD_FACTOR, PRESSURE_FACTOR, localReading, rank } from '../src/index.js';
import type { UsageSnapshot } from '../src/index.js';

const now = new Date('2026-10-11T12:00:00Z');

/** One hosted route and three local ones, the locals listed under the cogitator provider the way a real install lists them. */
function policy(): PolicyFile {
  const level = { summarize_extract: 'normal' };
  const rules = { providers: {
    grok: { defaults: { dataTier: 'sensitive', output: 'text_only', cost: 'moderate' }, models: { 'xai/grok': { id: 'grok-4.7', rule: { activities: level } } } },
    cogitator: { defaults: { dataTier: 'regulated', output: 'text_only', cost: 'free' }, models: {
      'cogitator/summarize': { id: 'summarize', rule: { activities: level } },
      'cogitator/judge': { id: 'judge', rule: { activities: level } },
      'cogitator/embed': { id: 'embed', rule: { activities: level } } } },
  } };
  const p = emptyPolicy(); importPolicy(p, openRules(rules), now);
  for (const [id, provider] of Object.entries(p.providers)) for (const label of Object.keys(provider.models)) setField(p, fieldPath(id, label, 'status'), 'confirmed', 'test', now);
  p.balance = { gate: { premium: [], paceLift: [] } };
  return buildPolicyFile(p, [{ id: 'grok', name: 'grok', metered: true }, { id: 'cogitator', name: 'Cogitator', metered: false }], now);
}

const model = (id: string, state: string) => ({ id, state, memory_mb: 6000, idle_secs: 5, yielded: [] });
const hosts = (over: { eruFree?: number; bilboUp?: boolean; summarize?: string } = {}) => ({
  self: { name: 'eru', ledger: { budget_mb: 16000, used_mb: 8000, free_mb: over.eruFree ?? 8000, models: [model('judge-8b', 'ready'), model('summarize-8b', over.summarize ?? 'ready')] },
    roles: [{ name: 'judge', chain: ['judge-8b'], refuses_degrade: false }, { name: 'summarize', chain: ['summarize-8b', 'apple@bilbo'], refuses_degrade: false },
      { name: 'embed', chain: ['embed-small@aragorn'], refuses_degrade: true }] },
  peers: [{ name: 'bilbo', up: over.bilboUp ?? true, error: null, checked_secs_ago: 3, models: [{ id: 'apple' }], ledger: { budget_mb: 24000, used_mb: 6000, free_mb: 18000, models: [model('apple', 'ready')] } },
    { name: 'aragorn', up: false, error: 'connection refused', checked_secs_ago: 9, models: [], ledger: null }] });
const usage = (body: unknown, over: Record<string, unknown> = {}): UsageSnapshot => ({ providers: { cogitator: { fetchedAt: now.toISOString(), stale: false, notes: { fleet: readFleet(body) }, ...over } } });
const pick = (u: UsageSnapshot | null) => rank(policy(), u, { activity: 'summarize_extract', dataTier: 'internal' }, now);

describe('the fleet in the pick', () => {
  it('blocks a role no machine can serve and says why', () => {
    const r = pick(usage(hosts()));
    expect(r.blocked.find(b => b.model === 'cogitator/embed')?.why).toBe('no machine can serve embed now');
    expect(r.ranking.map(x => x.model)).toEqual(expect.arrayContaining(['cogitator/judge', 'cogitator/summarize']));
  });

  it('scores a loaded model normally and a cold one lower', () => {
    const loaded = pick(usage(hosts())).ranking.find(r => r.model === 'cogitator/summarize')!;
    const cold = pick(usage(hosts({ summarize: 'installed' }))).ranking.find(r => r.model === 'cogitator/summarize')!;
    expect(loaded.usage).toBe(1);
    expect(cold.usage).toBe(COLD_FACTOR);
    expect(cold.score).toBeCloseTo(loaded.score * COLD_FACTOR, 3);
    expect(cold.why).toBe('summarize on eru is not loaded');
  });

  it('scores a machine short of memory lower, and both nudges multiply', () => {
    const tight = pick(usage(hosts({ eruFree: 1000 }))).ranking.find(r => r.model === 'cogitator/judge')!;
    expect(tight.usage).toBe(PRESSURE_FACTOR);
    expect(tight.why).toBe('eru is short of memory');
    const both = pick(usage(hosts({ eruFree: 1000, summarize: 'installed' }))).ranking.find(r => r.model === 'cogitator/summarize')!;
    expect(both.usage).toBeCloseTo(COLD_FACTOR * PRESSURE_FACTOR, 3);
  });

  it('follows a role to the second link when the first machine is down', () => {
    const down = hosts();
    down.self.roles = [{ name: 'summarize', chain: ['summarize-8b@bilbo', 'apple@bilbo'], refuses_degrade: false }] as never;
    down.peers[0]!.up = false;
    expect(pick(usage(down)).blocked.find(b => b.model === 'cogitator/summarize')?.why).toBe('no machine can serve summarize now');
  });

  it('blocks every local route while the gateway cannot be reached, and leaves a missing key alone', () => {
    const gone = pick(usage(hosts(), { stale: true, error: 'Could not reach Cogitator.' }));
    expect(gone.blocked.filter(b => b.model.startsWith('cogitator/')).map(b => b.why)).toEqual(['Cogitator is not reachable', 'Cogitator is not reachable', 'Cogitator is not reachable']);
    expect(gone.pick).toBe('xai/grok');
    const noKey = pick(usage(hosts(), { stale: true, error: 'No manage key yet. Add one in settings.' }));
    expect(noKey.ranking.some(r => r.model === 'cogitator/judge')).toBe(true);
  });

  it('ignores a reading that is old, absent, or silent about a model', () => {
    const old = new Date(now.getTime() - 3 * 3600 * 1000).toISOString();
    expect(pick(usage(hosts({ summarize: 'installed' }), { fetchedAt: old })).ranking.find(r => r.model === 'cogitator/summarize')!.usage).toBe(1);
    expect(pick(null).ranking.some(r => r.model === 'cogitator/embed')).toBe(true);
    expect(localReading(usage(hosts()), 'unknown-role', now)).toBeNull();
  });

  it('reads a model id the gateway lists on a machine, not only a role', () => {
    expect(localReading(usage(hosts({ summarize: 'installed' })), 'summarize-8b', now)).toMatchObject({ factor: COLD_FACTOR });
    expect(localReading(usage(hosts({ bilboUp: false })), 'apple', now)).toMatchObject({ blocked: 'bilbo is down' });
  });

  it('leaves hosted routes alone', () => {
    const r = pick(usage(hosts({ summarize: 'installed', eruFree: 500 })));
    expect(r.ranking.find(x => x.model === 'xai/grok')!.usage).toBe(1);
  });

  it('ranks catalog strengths through the fleet nudges and preserves the review, pause, and data gates', () => {
    const stored = emptyPolicy();
    stored.providers.cogitator = newProvider();
    stored.providers.cogitator.defaults = { dataTier: 'internal', askFirst: false, cost: 'free' };
    addModels(stored, 'cogitator', [{ label: 'cogitator/laya', id: 'laya' }], 'manual', now);
    const meta = [{ id: 'cogitator', name: 'Cogitator', metered: false }];
    const fleet = usage({ self: { name: 'eru', ledger: { budget_mb: 16000, free_mb: 500, models: [model('laya', 'installed')] } } });
    const req = { activity: 'typed_decisions', dataTier: 'internal' } as const;
    expect(rank(buildPolicyFile(stored, meta), fleet, req, now).blocked).toContainEqual({ model: 'cogitator/laya', why: 'status unreviewed' });
    const entry = stored.providers.cogitator.models['cogitator/laya']!;
    entry.status = 'confirmed';
    const result = rank(buildPolicyFile(stored, meta), fleet, req, now);
    expect(result.ranking[0]).toMatchObject({ model: 'cogitator/laya', level: 'preferred', weight: 2.5 });
    expect(result.ranking[0]!.usage).toBeCloseTo(COLD_FACTOR * PRESSURE_FACTOR, 3);
    expect(result.ranking[0]!.score).toBeCloseTo(0.5 * 2.5 * COLD_FACTOR * PRESSURE_FACTOR, 3);
    expect(rank(buildPolicyFile(stored, meta), fleet, { ...req, dataTier: 'regulated' }, now).blocked[0]!.why).toContain('cleared for internal');
    entry.rule.pause = { until: '2026-10-12T12:00:00Z' };
    expect(rank(buildPolicyFile(stored, meta), fleet, req, now).blocked[0]!.why).toContain('paused until');
    entry.rule.pause = null;
    entry.rule.activities = { typed_decisions: null };
    expect(rank(buildPolicyFile(stored, meta), fleet, req, now).blocked[0]!.why).toBe('not permitted typed_decisions');
    entry.rule.activities = { typed_decisions: 'occasional' };
    expect(rank(buildPolicyFile(stored, meta), fleet, req, now).ranking[0]!.level).toBe('occasional');
    expect(rank(buildPolicyFile(stored, meta), { providers: { cogitator: { stale: true, error: 'Could not reach Cogitator.' } } }, req, now).blocked[0]!.why).toBe('Cogitator is not reachable');
  });

  it('limits a role with an uncensored fallback to internal data even when an earlier link serves', () => {
    const fleet = usage({ self: { name: 'eru', ledger: { models: [model('gemma-4-12b', 'ready'), model('gemma-4-12b-uncensored', 'installed')] }, roles: [{ name: 'summarize', chain: ['gemma-4-12b', 'gemma-4-12b-uncensored'] }] } });
    const result = rank(policy(), fleet, { activity: 'summarize_extract', dataTier: 'regulated' }, now);
    expect(result.blocked).toContainEqual({ model: 'cogitator/summarize', why: 'gemma-4-12b-uncensored is limited to internal data' });
    expect(rank(policy(), fleet, { activity: 'summarize_extract', dataTier: 'internal' }, now).ranking.some(row => row.model === 'cogitator/summarize')).toBe(true);
  });
});
