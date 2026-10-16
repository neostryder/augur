import { describe, expect, it } from 'vitest';
import { DEFAULT_BALANCE, agreement, learnedShares, learnedTilt, propose, resolveBalance, trainingKey } from '../src/index.js';
import type { AnswerRow, BalanceRules } from '../src/index.js';

const rules = (training: Record<string, unknown> = {}): BalanceRules => resolveBalance({ training: { enabled: true, ...training } });
const sol = { label: 'codex/sol', provider: 'codex', id: 'gpt-6.1-sol' }, luna = { label: 'codex/luna', provider: 'codex', id: 'gpt-6-luna' };
const answer = (i: number, agreed: boolean, over: Partial<AnswerRow> = {}): AnswerRow => ({ pick: `p${i}`, key: 'write_code:deep', proposed: 'codex/sol', chosen: agreed ? 'codex/sol' : 'codex/luna', agreed, at: i, ...over });
const run = (n: number, agreedCount: number): AnswerRow[] => Array.from({ length: n }, (_, i) => answer(i, i < agreedCount));

describe('training rules', () => {
  it('ship off, so a pick stands as drawn', () => {
    expect(DEFAULT_BALANCE.training.enabled).toBe(false);
    expect(propose(resolveBalance(undefined), sol, 'write_code:deep', 'deep', 'x', []).mode).toBe('auto');
  });

  it('take an override and keep defaults for fields of the wrong type', () => {
    const t = resolveBalance({ training: { enabled: true, agree: 2, window: 0, min: 'x', spot: 3.7, askDepths: ['core', 'sideways'], askTiers: ['light'], askRoutes: ['codex/*'] } }).training;
    expect(t).toEqual({ enabled: true, agree: 0.9, window: 20, min: 10, spot: 3, askDepths: ['core'], askTiers: ['light'], askRoutes: ['codex/*'] });
  });
});

describe('proposing a pick', () => {
  it('asks until enough answers exist', () => {
    const p = propose(rules(), sol, 'write_code:deep', 'deep', 'a', run(9, 9));
    expect(p).toMatchObject({ mode: 'ask', n: 9, agreed: 9 });
    expect(p.reason).toMatch(/9 of 10 answers so far/);
  });

  it('asks while agreement is under the bar', () => {
    const p = propose(rules(), sol, 'write_code:deep', 'deep', 'a', run(20, 17));
    expect(p.mode).toBe('ask');
    expect(p.reason).toMatch(/17 of 20 recent answers agreed .* short of 90%/);
  });

  it('stops asking once the answers agree enough, and never asks about a light route', () => {
    const answers = run(20, 19);
    expect(propose(rules({ spot: 0 }), sol, 'write_code:deep', 'deep', 'a', answers).mode).toBe('auto');
    expect(propose(rules(), luna, 'write_code:deep', 'deep', 'a', []).mode).toBe('auto');
  });

  it('always asks for core work and for a route listed to always ask', () => {
    expect(propose(rules({ spot: 0 }), sol, 'write_code:core', 'core', 'a', run(20, 20).map(a => ({ ...a, key: 'write_code:core' }))).mode).toBe('ask');
    expect(propose(rules({ askRoutes: ['codex/luna'] }), luna, 'write_code:deep', 'deep', 'a', run(20, 20)).mode).toBe('ask');
  });

  it('spot-checks about one pick in `spot` after a kind of work has stopped asking', () => {
    const answers = run(20, 20), r = rules({ spot: 4 });
    const modes = Array.from({ length: 400 }, (_, i) => propose(r, sol, 'write_code:deep', 'deep', `id${i}`, answers).mode);
    const spots = modes.filter(m => m === 'spot').length;
    expect(spots).toBeGreaterThan(60);
    expect(spots).toBeLessThan(140);
    expect(modes.every(m => m === 'spot' || m === 'auto')).toBe(true);
    expect(propose(r, sol, 'write_code:deep', 'deep', 'id7', answers)).toEqual(propose(r, sol, 'write_code:deep', 'deep', 'id7', answers));
  });

  it('asks again when disagreements pull a kind of work back under the bar', () => {
    const answers = [...run(20, 20), ...Array.from({ length: 3 }, (_, i) => answer(100 + i, false))];
    expect(propose(rules({ spot: 0 }), sol, 'write_code:deep', 'deep', 'a', answers).mode).toBe('ask');
  });
});

describe('weighing answers', () => {
  it('counts the newest answer for a pick, and only the newest window', () => {
    const rows = [answer(1, false), answer(1, true, { at: 50 }), ...run(30, 0).map((a, i) => ({ ...a, pick: `q${i}`, at: 100 + i }))];
    expect(agreement(rows, 'write_code:deep', 20)).toEqual({ n: 20, agreed: 0, rate: 0 });
    expect(agreement([answer(1, false), answer(1, true, { at: 50 })], 'write_code:deep', 20)).toEqual({ n: 1, agreed: 1, rate: 1 });
  });

  it('turns choices into shares, once there are enough answers', () => {
    const rows = run(10, 7);
    expect(learnedShares(rows, 'write_code:deep', 20, 11)).toEqual({});
    const shares = learnedShares(rows, 'write_code:deep', 20, 10);
    expect(shares['codex/sol']).toBeCloseTo(0.7);
    expect(shares['codex/luna']).toBeCloseTo(0.3);
    expect(learnedTilt(0)).toBe(0.85);
    expect(learnedTilt(1)).toBe(1.15);
    expect(trainingKey('write_code', 'core')).toBe('write_code:core');
  });
});
