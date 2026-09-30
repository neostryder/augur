import { describe, expect, it } from 'vitest';
import { account, calibrate, calibrateRoutes, costFor, describeFigure, totalOf } from '../src/accounting.js';
import type { JobRecord } from '../src/spec.js';

const job = (o: Partial<JobRecord> & { id: string }): JobRecord => ({
  state: 'completed', route: 'luna', adapter: 'exec', activity: 'write_code', dataTier: 'internal', tools: 'read', output: 'text_only', cwd: '/w', createdAt: 0, startedAt: 0, endedAt: 1,
  exitCode: 0, reason: null, rootJobId: o.id, parentJobId: null, depth: 0, caller: { kind: 'cli' }, named: false, harnessVersion: null, usage: null, workspace: null, patch: null, ...o,
}) as JobRecord;
const reported = (input: number, output: number, extra: object = {}) => ({ inputTokens: input, outputTokens: output, source: 'reported' as const, ...extra });
/** Ten jobs whose answer runs 4 characters per token, give or take a little. */
const history = Array.from({ length: 10 }, (_, i) => job({ id: `h${i}`, promptChars: 4000 + i * 40, answerChars: 800 + i * 8, usage: reported(1000 + i * 10, 200 + i * 2) }));

describe('calibrate', () => {
  it('needs enough samples', () => {
    expect(calibrate(history.slice(0, 5).map(j => ({ chars: j.answerChars!, tokens: j.usage!.outputTokens })))).toBeNull();
  });
  it('measures characters per token and the error it leaves', () => {
    const c = calibrate(history.map(j => ({ chars: j.answerChars!, tokens: j.usage!.outputTokens })))!;
    expect(c.charsPerToken).toBeCloseTo(4, 1);
    expect(c.error).toBeLessThan(0.02);
    expect(c.samples).toBe(10);
  });
  it('drops a guess that is too loose to trust', () => {
    const wild = Array.from({ length: 12 }, (_, i) => ({ chars: 1000, tokens: i % 2 ? 100 : 900 }));
    expect(calibrate(wild)).toBeNull();
  });
});

describe('costFor', () => {
  const rate = { inputPerM: 2, outputPerM: 10, cachedReadPerM: 0.2 };
  it('prices fresh, cached and output tokens', () => {
    expect(costFor(1_000_000, 100_000, 400_000, 0, rate)).toBeCloseTo(0.6 * 2 + 0.4 * 0.2 + 0.1 * 10, 6);
  });
  it('refuses to guess the price of cached tokens it has no rate for', () => {
    expect(costFor(1000, 100, 0, 500, rate)).toBeNull();
    expect(costFor(1000, 100, 0, 0, { inputPerM: 2, outputPerM: 10 })).not.toBeNull();
  });
});

describe('account', () => {
  const rates = { 'codex/luna': { inputPerM: 2, outputPerM: 10 } };
  const cal = calibrateRoutes(history).luna;

  it('keeps reported tokens and a reported cost as reported', () => {
    const a = account(job({ id: 'a', usage: reported(500, 50, { costUsd: 0.5 }) }), 'codex/luna', rates, cal);
    expect(a).toEqual({ inputTokens: { value: 500, provenance: 'reported' }, outputTokens: { value: 50, provenance: 'reported' }, costUsd: { value: 0.5, provenance: 'reported' } });
  });
  it('derives a cost from reported tokens and the rate card', () => {
    const a = account(job({ id: 'a', usage: reported(1_000_000, 100_000) }), 'codex/luna', rates, cal);
    expect(a.costUsd).toEqual({ value: 3, provenance: 'derived' });
  });
  it('leaves the cost out when no rate is set', () => {
    expect(account(job({ id: 'a', usage: reported(1000, 100) }), 'codex/luna', {}, cal).costUsd).toBeNull();
  });
  it('estimates tokens from text length with the measured error, and a cost from them', () => {
    const a = account(job({ id: 'a', promptChars: 4400, answerChars: 880 }), 'codex/luna', rates, cal);
    expect(a.outputTokens).toMatchObject({ provenance: 'imputed', value: 220 });
    expect(a.inputTokens).toMatchObject({ provenance: 'imputed', value: 1100 });
    expect(a.costUsd?.provenance).toBe('imputed');
    expect(a.costUsd?.value).toBeCloseTo(1100 / 1e6 * 2 + 220 / 1e6 * 10, 8);
    expect(a.costUsd?.error).toBeGreaterThanOrEqual(0);
  });
  it('imputes nothing for a route with no calibration', () => {
    const a = account(job({ id: 'a', route: 'new', promptChars: 4400, answerChars: 880 }), 'codex/luna', rates, calibrateRoutes(history).new);
    expect(a).toEqual({ inputTokens: null, outputTokens: null, costUsd: null });
  });
  it('never replaces a reported figure with an estimate', () => {
    const a = account(job({ id: 'a', promptChars: 99999, answerChars: 99999, usage: reported(10, 5) }), 'codex/luna', rates, cal);
    expect(a.inputTokens?.provenance).toBe('reported');
    expect(a.inputTokens?.value).toBe(10);
  });
});

describe('describeFigure and totalOf', () => {
  it('states how each figure is known', () => {
    expect(describeFigure({ value: 1200, provenance: 'reported' }, 'tokens')).toBe('1,200 (reported)');
    expect(describeFigure({ value: 0.0031, provenance: 'imputed', error: 0.25 }, 'usd')).toBe('$0.00310 (imputed, about 25% off)');
    expect(describeFigure(null, 'tokens')).toBe('unknown');
  });
  it('totals cost over the jobs that have one and counts them', () => {
    const t = totalOf([
      { inputTokens: { value: 10, provenance: 'reported' }, outputTokens: { value: 5, provenance: 'reported' }, costUsd: { value: 1, provenance: 'derived' } },
      { inputTokens: null, outputTokens: null, costUsd: null },
    ]);
    expect(t).toMatchObject({ jobs: 2, inputTokens: 10, outputTokens: 5, costUsd: 1, costJobs: 1, byProvenance: { derived: 1 } });
  });
});
