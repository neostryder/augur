import { describe, expect, it } from 'vitest';
import { openRules } from './open-rules.js';
import { buildPolicyFile, emptyPolicy, fieldPath, importPolicy, setField } from '@augur/core';
import type { PolicyFile } from '@augur/core';
import { rank } from '../src/index.js';
import type { UsageSnapshot } from '../src/index.js';

const now = new Date('2026-09-28T12:00:00Z');
const WEEK = 7 * 24 * 3600;
const req = { activity: 'write_code' as const, dataTier: 'internal' as const };

function policy(models: Record<string, Record<string, string>>, balance?: Record<string, unknown>, useAfter: Record<string, string[]> = {}): PolicyFile {
  const providers: Record<string, unknown> = {};
  for (const [id, rows] of Object.entries(models)) {
    providers[id] = { defaults: { dataTier: 'sensitive', output: 'write_files', cost: 'moderate' }, models: Object.fromEntries(Object.entries(rows).map(([label, weight]) => [label, { id: label.split('/').pop(), rule: { activities: { write_code: weight }, ...(useAfter[label] ? { useAfter: useAfter[label] } : {}) } }])) };
  }
  const p = emptyPolicy(); importPolicy(p, openRules({ providers }), now);
  for (const [id, provider] of Object.entries(p.providers)) for (const label of Object.keys(provider.models)) setField(p, fieldPath(id, label, 'status'), 'confirmed', 'test', now);
  p.balance = { enabled: false, ...balance };
  return buildPolicyFile(p, Object.keys(p.providers).map(id => ({ id, name: id, metered: true })), now);
}

const pair = () => policy({ pref: { 'pref/a': 'preferred' }, norm: { 'norm/b': 'normal' } });
const draw = (p: PolicyFile, over: Record<string, unknown> = {}, usage: UsageSnapshot | null = null) => rank(p, usage, { ...req, ...over }, now);

describe('the weighted draw', () => {
  it('splits a preferred route and a normal one 0.714 to 0.286', () => {
    const r = draw(pair());
    expect(r.ranking.find(x => x.model === 'pref/a')).toMatchObject({ score: 1.25, odds: 0.714 });
    expect(r.ranking.find(x => x.model === 'norm/b')).toMatchObject({ score: 0.5, odds: 0.286 });
  });

  it('drops a route under a quarter of the top score and renormalizes', () => {
    const p = policy({ a: { 'a/top': 'normal' }, b: { 'b/mid': 'normal' }, c: { 'c/low': 'normal' } });
    const r = draw(p, { fits: { 'a/top': 1, 'b/mid': 0.5, 'c/low': 0.2 } });
    expect(r.ranking.map(x => [x.model, x.odds])).toEqual([['a/top', 0.667], ['b/mid', 0.333], ['c/low', 0]]);
  });

  it('repeats a draw from the same seed, and a short table hits both routes', () => {
    const once = (seed: number | string) => draw(pair(), { draw: true, seed }).pick;
    expect(once(0)).toBe(once('0'));
    expect(once('same')).toBe(once('same'));
    const table = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map(s => [s, once(s)]));
    expect(table).toEqual({
      '0': 'pref/a', '1': 'norm/b', '2': 'pref/a', '3': 'norm/b', '4': 'pref/a',
      '5': 'pref/a', '6': 'pref/a', '7': 'pref/a', '8': 'pref/a', '9': 'pref/a',
    });
  });

  it('lands 4000 seeded draws within 3 points of the odds', () => {
    let hits = 0;
    for (let i = 0; i < 4000; i++) if (draw(pair(), { draw: true, seed: i }).pick === 'pref/a') hits++;
    expect(Math.abs(hits / 4000 - 0.714)).toBeLessThanOrEqual(0.03);
  });

  it('lets a named model win, and takes the top when best is set, the draw is off, or the draw is unset', () => {
    const named = draw(pair(), { draw: true, named: 'norm/b', seed: 2 });
    expect(named.pick).toBe('norm/b');
    expect(named.drawn).toBe(false);
    expect(named.seed).toBeNull();
    expect(named.ranking.find(x => x.model === 'pref/a')?.odds).toBe(0.714);
    const best = draw(pair(), { draw: true, best: true, seed: 2 });
    expect(best.pick).toBe('pref/a');
    expect(best.drawn).toBe(false);
    expect(best.seed).toBeNull();
    expect(draw(pair()).pick).toBe('pref/a');
    expect(draw(pair()).drawn).toBe(false);
    expect(draw(pair(), { draw: false, seed: 2 }).pick).toBe('pref/a');
    const off = draw(policy({ pref: { 'pref/a': 'preferred' }, norm: { 'norm/b': 'normal' } }, { draw: { enabled: false } }), { draw: true, seed: 2 });
    expect(off.pick).toBe('pref/a');
    expect(off.drawn).toBe(false);
    expect(off.seed).toBeNull();
  });

  it('does not draw when the top score is 0', () => {
    const p = policy({ a: { 'a/one': 'normal' }, b: { 'b/two': 'normal' } });
    const r = draw(p, { draw: true, seed: 1, fits: { 'a/one': 0, 'b/two': 0 } });
    expect(r.ranking[0]?.score).toBe(0);
    expect(r.pick).toBe(r.ranking[0]?.model);
    expect(r.drawn).toBe(false);
    expect(r.seed).toBeNull();
    expect(r.ranking.every(x => x.odds === 0)).toBe(true);
  });

  it('gives tied routes an equal share', () => {
    const p = policy({ a: { 'a/one': 'normal' }, b: { 'b/two': 'normal' } });
    const r = draw(p);
    expect(r.ranking.map(x => x.odds)).toEqual([0.5, 0.5]);
    const picks = new Set(['0', '1', '2', '3', '4', '5', '6', '7'].map(s => draw(p, { draw: true, seed: s }).pick));
    expect(picks).toEqual(new Set(['a/one', 'b/two']));
  });

  it('says when the draw was not the top route, and returns the seed', () => {
    const lost = draw(pair(), { draw: true, seed: 1 });
    expect(lost.pick).toBe('norm/b');
    expect(lost.drawn).toBe(true);
    expect(lost.seed).toBe('1');
    expect(lost.reason).toBe('Drawn at 29% odds; pref/a led at 71%.');
    expect(lost.seats).toEqual(draw(pair(), { named: 'norm/b' }).seats);
    const led = draw(pair(), { draw: true, seed: 0 });
    expect(led.pick).toBe('pref/a');
    expect(led.reason.startsWith('pref/a for')).toBe(true);
    const made = draw(pair(), { draw: true });
    expect(made.drawn).toBe(true);
    expect(made.seed).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe('a grok week with room left', () => {
  it('boosts grok enough that a seeded run draws it at least 15% of the time', () => {
    const p = policy({
      grok: { 'xai/grok': 'often' },
      codex: { 'codex/sol': 'preferred' },
      claude: { 'claude/live': 'preferred' },
      copilot: { 'copilot/waiter': 'normal' },
    }, { enabled: true, prefer: { 'xai/grok': null } }, { 'copilot/waiter': ['xai/grok'] });
    const week = (used: number, leftDays: number) => ({ id: 'weekly', label: 'weekly', usedPct: used, windowKind: 'weekly', windowSeconds: WEEK, resetsAt: new Date(now.getTime() + leftDays * 86400e3).toISOString() });
    const usage: UsageSnapshot = { providers: {
      grok: { fetchedAt: now.toISOString(), meters: [week(1, 3)] },
      codex: { fetchedAt: now.toISOString(), meters: [week(40, 4.2)] },
      claude: { fetchedAt: now.toISOString(), meters: [week(40, 4.2)] },
    } };
    const sample = draw(p, {}, usage);
    const grok = sample.ranking.find(x => x.model === 'xai/grok');
    expect(grok?.boost).toBeCloseTo(1.495, 3);
    expect(grok?.why).toContain('Grok has used 1% of its week with 3 days left, so it gets a 1.495x boost');
    expect(grok?.odds).toBeGreaterThan(0.15);
    let hits = 0;
    for (let i = 0; i < 200; i++) if (draw(p, { draw: true, seed: `g${i}` }, usage).pick === 'xai/grok') hits++;
    expect(hits / 200).toBeGreaterThanOrEqual(0.15);
  });
});
