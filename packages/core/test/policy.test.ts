import { describe, it, expect } from 'vitest';
import { addModels, buildPolicyFile, emptyPolicy, fieldPath, mergePolicy, migratePolicy, pauseActive, policyFromFile, policyPathFor, resolveModel, setField, setFieldMany, stampTime, undoChange } from '../src/policy.js';
import { importPolicy } from '../src/policy-import.js';
import type { PolicyConfig } from '../src/policy.js';
import { defaultConfig, migrateConfig } from '../src/config.js';

const t0 = new Date('2026-09-27T12:00:00Z'), t1 = new Date('2026-09-27T12:05:00Z'), t2 = new Date('2026-09-27T12:10:00Z');
const RULES = { providers: {
  codex: { defaults: { dataTier: 'sensitive', output: 'write_files' }, models: {
    'codex/sol': { id: 'gpt-6-sol', rule: { cost: 'expensive', activities: { write_code: 'preferred' } } },
    'codex/luna': { id: 'gpt-6-luna', rule: { cost: 'moderate', activities: { summarize_extract: 'preferred' } } } } },
  grok: { models: { 'xai/grok': { id: 'grok-4.7', rule: { activities: { research: 'often' } } } } },
  minimax: { thresholds: { denyPct: 95 }, models: { 'minimax/m3': { id: 'MiniMax-M3', rule: { dataTier: 'public', activities: { write_code: 'last_resort' } } } } } } };
const sample = (now = t0): PolicyConfig => { const p = emptyPolicy(); importPolicy(p, RULES, now); return p; };
const meta = [{ id: 'codex', name: 'Codex', metered: true }, { id: 'copilot', name: 'GitHub Copilot', metered: false }];

describe('policy', () => {
  it('imports rules as unconfirmed and leaves existing models and set fields alone', () => {
    const policy = sample(), statuses = Object.values(policy.providers).flatMap(p => Object.values(p.models).map(m => m.status));
    expect(new Set(statuses)).toEqual(new Set(['imported']));
    expect(policy.providers.minimax!.models['minimax/m3']!.rule.activities?.write_code).toBe('last_resort');
    setField(policy, fieldPath('codex', 'codex/sol', 'status'), 'confirmed', 'desktop', t1);
    setField(policy, fieldPath('codex', null, 'dataTier'), 'internal', 'desktop', t1);
    expect(importPolicy(policy, RULES, t2)).toEqual([]);
    expect(policy.providers.codex!.models['codex/sol']!.status).toBe('confirmed');
    expect(policy.providers.codex!.defaults.dataTier).toBe('internal');
  });

  it('imports rules already confirmed when setup accepts the recommended set', () => {
    const policy = emptyPolicy();
    importPolicy(policy, RULES, t0, 'confirmed');
    const statuses = Object.values(policy.providers).flatMap(p => Object.values(p.models).map(m => m.status));
    expect(new Set(statuses)).toEqual(new Set(['confirmed']));
    const file = buildPolicyFile(policy, Object.keys(policy.providers).map(id => ({ id, name: id, metered: true })), t0);
    expect(file.unreviewed).toEqual([]);
    expect(file.providers.codex!.models['codex/sol']!.status).toBe('confirmed');
  });

  it('keeps rules through a config save and load', () => {
    const config = defaultConfig();
    expect(config.policy!.providers).toEqual({});
    config.policy = sample();
    setField(config.policy, fieldPath('codex', 'codex/sol', 'status'), 'confirmed', 'desktop', t1);
    const again = migrateConfig(JSON.parse(JSON.stringify(config)));
    expect(again.policy!.providers.codex!.models['codex/sol']!.status).toBe('confirmed');
    expect(again.policy!.history).toHaveLength(1);
  });

  it('resolves model fields over provider defaults and lists what it inherited', () => {
    const r = resolveModel('codex', { dataTier: 'sensitive', activities: { research: 'normal', write_code: 'often' } },
      { id: 'x', source: 'manual', status: 'confirmed', firstSeen: '', rule: { activities: { write_code: 'preferred', research: null }, cost: 'cheap' } });
    expect(r.activities).toEqual({ write_code: 'preferred' });
    expect(r.dataTier).toBe('sensitive');
    expect(r.inherited).toContain('dataTier');
    expect(r.inherited).not.toContain('cost');
    expect(r.output).toBe('text_only');
  });

  it('blocks new live models until they are reviewed and lists them as unreviewed', () => {
    const policy = emptyPolicy();
    policy.providers.copilot = { defaults: { activities: { write_code: 'normal' } }, models: {} };
    expect(addModels(policy, 'copilot', [{ label: 'copilot/gpt-6-sol', id: 'gpt-6-sol' }], 'live', t0)).toEqual(['copilot/gpt-6-sol']);
    expect(addModels(policy, 'copilot', [{ label: 'copilot/gpt-6-sol', id: 'gpt-6-sol' }], 'live', t0)).toEqual([]);
    expect(addModels(policy, 'copilot', [{ label: 'copilot/other-name', id: 'gpt-6-sol' }], 'manual', t0)).toEqual([]);
    const file = buildPolicyFile(policy, meta, t0);
    expect(file.unreviewed).toEqual(['copilot/gpt-6-sol']);
    expect(file.providers.copilot!.models['copilot/gpt-6-sol']!.status).toBe('unreviewed');
    expect(file.providers.codex!.thresholds).toEqual({ warnPct: 90, denyPct: 98, minBalance: null });
  });

  it('records history, sets many at once, and undoes a change', () => {
    const policy = sample();
    setFieldMany(policy, 'codex', ['codex/sol', 'codex/luna'], 'dataTier', 'internal', 'desktop', t1);
    expect(policy.history).toHaveLength(2);
    setField(policy, fieldPath('codex', 'codex/sol', 'dataTier'), 'internal', 'desktop', t1);
    expect(policy.history).toHaveLength(2);
    undoChange(policy, policy.history[0]!, 'phone', t2);
    expect(policy.providers.codex!.models['codex/sol']!.rule.dataTier).toBeUndefined();
    expect(policy.history.at(-1)).toMatchObject({ device: 'phone', from: 'internal', to: null });
  });

  it('merges two devices field by field with the newer edit winning', () => {
    const desk = sample(), phone = structuredClone(desk);
    setField(desk, fieldPath('codex', 'codex/sol', 'cost'), 'cheap', 'desktop', t1);
    setField(phone, fieldPath('grok', 'xai/grok', 'activities.research'), 'preferred', 'phone', t1);
    setField(phone, fieldPath('codex', 'codex/sol', 'cost'), 'moderate', 'phone', t2);
    setField(desk, fieldPath('grok', 'xai/grok', 'activities.research'), null, 'desktop', t2);
    addModels(phone, 'copilot', [{ label: 'copilot/claude-sonnet-5', id: 'claude-sonnet-5' }], 'live', t1);
    const merged = mergePolicy(desk, phone);
    expect(merged.providers.codex!.models['codex/sol']!.rule.cost).toBe('moderate');
    expect(merged.providers.grok!.models['xai/grok']!.rule.activities?.research).toBeNull();
    expect(merged.providers.copilot!.models['copilot/claude-sonnet-5']!.status).toBe('unreviewed');
    expect(merged.history).toHaveLength(4);
    expect(mergePolicy(merged, merged).history).toHaveLength(4);
  });

  describe('clock stamps', () => {
    const cost = fieldPath('codex', 'codex/sol', 'cost');
    const same = (a: PolicyConfig, b: PolicyConfig) => { expect(a.providers).toEqual(b.providers); expect(a.stamps).toEqual(b.stamps); expect(a.clock).toEqual(b.clock); expect(a.history).toEqual(b.history); };

    it('orders an edit after one it has merged, even when the device clock runs an hour slow', () => {
      const desk = sample(), phone = structuredClone(desk);
      setField(desk, cost, 'cheap', 'desktop', t2);
      const behind = new Date(t2.getTime() - 3600_000);
      const seen = mergePolicy(phone, desk);
      setField(seen, cost, 'moderate', 'phone', behind);
      expect(seen.stamps[cost]! > desk.stamps[cost]!).toBe(true);
      expect(mergePolicy(desk, seen).providers.codex!.models['codex/sol']!.rule.cost).toBe('moderate');
      expect(mergePolicy(seen, desk).providers.codex!.models['codex/sol']!.rule.cost).toBe('moderate');
    });

    it('counts edits made in the same millisecond and breaks a tie by device', () => {
      const p = sample();
      setField(p, cost, 'cheap', 'desktop', t1);
      setField(p, cost, 'moderate', 'desktop', t1);
      setField(p, fieldPath('codex', 'codex/luna', 'cost'), 'cheap', 'desktop', t1);
      expect(p.stamps[cost]).toBe(`${t1.toISOString()}~0001~desktop`);
      expect(p.stamps[fieldPath('codex', 'codex/luna', 'cost')]).toBe(`${t1.toISOString()}~0002~desktop`);
      const a = sample(), b = sample();
      setField(a, cost, 'cheap', 'desktop', t1);
      setField(b, cost, 'moderate', 'phone', t1);
      same(mergePolicy(a, b), mergePolicy(b, a));
      expect(mergePolicy(a, b).providers.codex!.models['codex/sol']!.rule.cost).toBe('moderate');
    });

    it('reaches the same state whichever way two devices merge, and merging again changes nothing', () => {
      const desk = sample(), phone = structuredClone(desk);
      setField(desk, cost, 'cheap', 'desktop', t1);
      setField(desk, fieldPath('grok', 'xai/grok', 'activities.research'), null, 'desktop', t2);
      setField(phone, cost, 'moderate', 'phone', new Date(t1.getTime() - 60_000));
      setField(phone, fieldPath('codex', null, 'dataTier'), 'public', 'phone', t2);
      const ab = mergePolicy(desk, phone), ba = mergePolicy(phone, desk);
      same(ab, ba);
      same(mergePolicy(ab, ba), ab);
      same(mergePolicy(ab, desk), ab);
    });

    it('still merges rules saved with plain time stamps, which sort before a clock stamp of the same instant', () => {
      const old = sample();
      old.stamps[cost] = t1.toISOString();
      const fresh = structuredClone(old);
      setField(fresh, cost, 'cheap', 'phone', t1);
      expect(mergePolicy(old, fresh).providers.codex!.models['codex/sol']!.rule.cost).toBe('cheap');
      expect(stampTime(fresh.stamps[cost]!)).toBe(t1.toISOString());
    });

    it('keeps policy.json updatedAt a plain time and the history readable', () => {
      const p = sample();
      setField(p, cost, 'cheap', 'desktop', t1);
      expect(buildPolicyFile(p, meta).updatedAt).toBe(t1.toISOString());
      expect(p.history.at(-1)!.at).toBe(t1.toISOString());
      expect(migratePolicy(JSON.parse(JSON.stringify(p))).clock).toBe(p.clock);
    });
  });

  it('drops malformed values on load', () => {
    const policy = migratePolicy({ providers: { codex: { defaults: { dataTier: 'secret', cost: 'cheap', activities: { write_code: 'always', research: 'often' } },
      thresholds: { warnPct: 150, denyPct: 95 }, models: { bad: { id: 'x' }, 'codex/sol': { id: 'gpt-6-sol', status: 'weird' } } }, 'Bad Id': {} } });
    expect(policy.providers.codex!.defaults).toEqual({ cost: 'cheap', activities: { research: 'often' } });
    expect(policy.providers.codex!.thresholds).toEqual({ denyPct: 95 });
    expect(Object.keys(policy.providers.codex!.models)).toEqual(['codex/sol']);
    expect(policy.providers.codex!.models['codex/sol']!.status).toBe('unreviewed');
    expect(policy.providers['Bad Id']).toBeUndefined();
  });

  it('adopts an existing policy.json with its statuses and pauses intact', () => {
    const policy = sample();
    setField(policy, fieldPath('codex', 'codex/sol', 'status'), 'confirmed', 'desktop', t1);
    setField(policy, fieldPath('codex', 'codex/sol', 'pause'), { until: '2026-10-04T18:49:55.000Z', weights: null, reason: 'week' }, 'desktop', t1);
    const file = buildPolicyFile(policy, meta.concat([{ id: 'grok', name: 'Grok', metered: true }, { id: 'minimax', name: 'MiniMax', metered: true }]), t2);
    const adopted = policyFromFile(JSON.parse(JSON.stringify(file)), t2);
    const again = buildPolicyFile(adopted, meta.concat([{ id: 'grok', name: 'Grok', metered: true }, { id: 'minimax', name: 'MiniMax', metered: true }]), t2);
    expect(again.providers.codex!.models['codex/sol']).toMatchObject({ status: 'confirmed', pause: { until: '2026-10-04T18:49:55.000Z', weights: null }, dataTier: 'sensitive', cost: 'high' });
    expect(again.providers.codex!.models['codex/luna']!.status).toBe('imported');
    expect(again.providers.minimax!.thresholds.denyPct).toBe(95);
    expect(again.providers.codex!.models['codex/sol']!.activities).toEqual(file.providers.codex!.models['codex/sol']!.activities);
  });

  it('reads the old top cost step as high and accepts the six-step scale', () => {
    const p = migratePolicy({ providers: { codex: { defaults: { cost: 'expensive' }, models: { 'codex/a': { id: 'a', rule: { cost: 'very_high' } }, 'codex/b': { id: 'b', rule: { cost: 'free' } }, 'codex/c': { id: 'c', rule: { cost: 'pricey' } } } } } });
    expect(p.providers.codex!.defaults.cost).toBe('high');
    expect([p.providers.codex!.models['codex/a']!.rule.cost, p.providers.codex!.models['codex/b']!.rule.cost, p.providers.codex!.models['codex/c']!.rule.cost]).toEqual(['very_high', 'free', undefined]);
  });

  it('keeps a model inheriting from its provider after its policy.json is adopted', () => {
    const file = buildPolicyFile(sample(), meta, t2), adopted = policyFromFile(JSON.parse(JSON.stringify(file)), t2);
    expect(adopted.providers.codex!.defaults.dataTier).toBe('sensitive');
    expect(adopted.providers.codex!.models['codex/sol']!.rule.dataTier).toBeUndefined();
    setField(adopted, fieldPath('codex', null, 'dataTier'), 'internal', 'desktop', t2);
    expect(buildPolicyFile(adopted, meta, t2).providers.codex!.models['codex/luna']!.dataTier).toBe('internal');
  });

  it('lifts a pause at its time and puts policy.json beside the export', () => {
    expect(pauseActive({ until: t1.toISOString() }, t0)).toBe(true);
    expect(pauseActive({ until: t1.toISOString() }, t2)).toBe(false);
    expect(pauseActive(null, t0)).toBe(false);
    expect(policyPathFor('.augur/usage.json')).toBe('.augur/policy.json');
    expect(policyPathFor('usage.json')).toBe('policy.json');
  });
});
