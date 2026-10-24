import { describe, expect, it } from 'vitest';
import { openRules } from './open-rules.js';
import { buildPolicyFile, emptyPolicy, importPolicy, fieldPath, setField } from '@augur/core';
import type { PolicyFile } from '@augur/core';
import { DEFAULT_BALANCE, rank, resolveBalance } from '../src/index.js';

const now = new Date('2026-10-16T12:00:00Z');
const level = { write_code: 'normal', review_code: 'normal' };
const RULES = { providers: {
  codex: { defaults: { dataTier: 'sensitive', output: 'write_files', cost: 'moderate' }, models: {
    'codex/sol': { id: 'gpt-6.1-sol', rule: { activities: level } },
    'codex/luna': { id: 'gpt-6-luna', rule: { activities: level } } } },
} };
const NO_PREFER = Object.fromEntries(Object.keys(DEFAULT_BALANCE.prefer).map(m => [m, null]));
function policy(balance?: Record<string, unknown>): PolicyFile {
  const p = emptyPolicy(); importPolicy(p, openRules(RULES), now);
  for (const [id, provider] of Object.entries(p.providers)) for (const label of Object.keys(provider.models)) setField(p, fieldPath(id, label, 'status'), 'confirmed', 'test', now);
  p.balance = { prefer: NO_PREFER, ...balance };
  return buildPolicyFile(p, Object.keys(p.providers).map(id => ({ id, name: id, metered: true })), now);
}
const CAPS = { caps: { 'codex/sol': { perDay: 6, perSession: 2 } } };
const top = (depth: 'routine' | 'everyday' | 'deep' | 'core') => rank(policy(), null, { activity: 'write_code', dataTier: 'internal', depth, best: true }, now);

describe('task weight', () => {
  it('sends routine work to the light route and core work to the strong one', () => {
    expect(top('routine').pick).toBe('codex/luna');
    expect(top('everyday').pick).toBe('codex/luna');
    expect(top('deep').pick).toBe('codex/sol');
    expect(top('core').pick).toBe('codex/sol');
  });

  it('widens the gap as the task weighs more', () => {
    const gap = (d: 'routine' | 'everyday' | 'deep' | 'core') => { const r = top(d).ranking; const sol = r.find(x => x.model === 'codex/sol')!.score, luna = r.find(x => x.model === 'codex/luna')!.score; return sol / luna; };
    expect(gap('routine')).toBeLessThan(gap('everyday'));
    expect(gap('everyday')).toBeLessThan(gap('deep'));
    expect(gap('deep')).toBeLessThan(gap('core'));
  });

  it('reads the new levels from a rule override and keeps defaults for the rest', () => {
    const b = resolveBalance({ depth: { review_code: 'core' }, tilt: { core: { strong: 3, light: 'x' } } });
    expect(b.depth.review_code).toBe('core');
    expect(b.tilt.core).toEqual({ strong: 3, light: DEFAULT_BALANCE.tilt.core.light });
    expect(b.tilt.routine).toEqual(DEFAULT_BALANCE.tilt.routine);
  });
});

describe('route caps', () => {
  const ask = (spent: { day: Record<string, number>; session: Record<string, number> }, extra: object = {}) =>
    rank(policy(CAPS), null, { activity: 'write_code', dataTier: 'internal', depth: 'core', best: true, spent, ...extra }, now);

  it('ship no caps, so an install that sets none picks as it always has', () => {
    expect(DEFAULT_BALANCE.caps).toEqual({});
  });

  it('leave a route in until a limit is reached', () => {
    expect(ask({ day: { 'codex/sol': 5 }, session: { 'codex/sol': 1 } }).pick).toBe('codex/sol');
  });

  it('take a route out at its daily limit and say why', () => {
    const r = ask({ day: { 'codex/sol': 6 }, session: {} });
    expect(r.pick).toBe('codex/luna');
    expect(r.blocked.find(b => b.model === 'codex/sol')?.why).toMatch(/capped: 6 picks in the last 24 hours \(limit 6\)/);
  });

  it('take a route out at its session limit', () => {
    const r = ask({ day: { 'codex/sol': 2 }, session: { 'codex/sol': 2 } });
    expect(r.pick).toBe('codex/luna');
    expect(r.blocked.find(b => b.model === 'codex/sol')?.why).toMatch(/in this session \(limit 2\)/);
  });

  it('let a caller name a capped route', () => {
    expect(ask({ day: { 'codex/sol': 9 }, session: { 'codex/sol': 9 } }, { named: 'codex/sol' }).pick).toBe('codex/sol');
  });

  it('take an override, a null to drop the cap, and 0 to turn a limit off', () => {
    expect(resolveBalance({ caps: { 'codex/sol': { perDay: 2 } } }).caps['codex/sol']).toEqual({ perDay: 2, perSession: 0 });
    expect(resolveBalance({ caps: { 'codex/sol': { perDay: 6, perSession: 2 } } }).caps['codex/sol']).toEqual({ perDay: 6, perSession: 2 });
    expect(resolveBalance({ caps: { 'codex/sol': null } }).caps['codex/sol']).toBeUndefined();
    expect(resolveBalance({ caps: { 'codex/sol': { parallel: 2.9 } } }).caps['codex/sol']).toEqual({ perDay: 0, perSession: 0, parallel: 2 });
    expect(resolveBalance({ caps: { 'codex/sol': { parallel: 0 } } }).caps['codex/sol']).toEqual({ perDay: 0, perSession: 0 });
    expect(resolveBalance({ caps: { 'codex/sol': { parallel: -1 } } }).caps['codex/sol']).toEqual({ perDay: 0, perSession: 0 });
    const off = rank(policy({ caps: { 'codex/sol': { perDay: 0, perSession: 0 } } }), null, { activity: 'write_code', dataTier: 'internal', depth: 'core', best: true, spent: { day: { 'codex/sol': 50 }, session: { 'codex/sol': 50 } } }, now);
    expect(off.pick).toBe('codex/sol');
  });
});
