import { describe, expect, it } from 'vitest';
import { parseBudget, parseRoutes, validPolicyFile } from '../src/sources.js';

const model = { id: 'gpt-6-sol', status: 'confirmed', activities: { write_code: 'often' }, dataTier: 'sensitive', askFirst: false, output: 'write_files', sandbox: false, pause: null };
const file = (m: unknown = model) => ({ schema: 1, providers: { codex: { thresholds: { warnPct: 90, denyPct: 98, minBalance: null }, models: { 'codex/sol': m } } } });

describe('policy.json validation', () => {
  it('accepts a well-formed file', () => expect(validPolicyFile(file())).toBe(true));
  it('rejects the whole file when one model is malformed', () => {
    expect(validPolicyFile(file({ ...model, dataTier: 'secret' }))).toBe(false);
    expect(validPolicyFile(file({ ...model, askFirst: 'no' }))).toBe(false);
    expect(validPolicyFile(file({ ...model, activities: undefined }))).toBe(false);
    expect(validPolicyFile(file({ ...model, pause: { weights: null } }))).toBe(false);
    expect(validPolicyFile({ schema: 2, providers: {} })).toBe(false);
  });
});

describe('routes.json budgets and fallbacks', () => {
  const route = { model: 'test/fake', adapter: 'exec' };
  it('reads a budget with a known period and a positive limit, and ignores anything else', () => {
    expect(parseBudget({ per: 'day', usd: 5 })).toEqual({ per: 'day', usd: 5 });
    expect(parseBudget({ per: 'week', jobs: 10.9, usd: 2 })).toEqual({ per: 'week', usd: 2, jobs: 10 });
    expect(parseBudget({ per: 'year', jobs: 3 })).toBeNull();
    expect(parseBudget({ per: 'day' })).toBeNull();
    expect(parseBudget({ per: 'day', usd: -1, jobs: 0 })).toBeNull();
    expect(parseBudget('lots')).toBeNull();
  });
  it('carries budget and fallback onto the route, dropping a fallback to itself and non-names', () => {
    const r = parseRoutes({ routes: { a: { ...route, budget: { per: 'month', usd: 20 }, fallback: ['b', 'a', 7] }, b: route } })!;
    expect(r.a).toMatchObject({ budget: { per: 'month', usd: 20 }, fallback: ['b'] });
    expect(r.b!.budget).toBeUndefined();
    expect(r.b!.fallback).toBeUndefined();
  });
});
