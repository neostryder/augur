import { emptyPolicy, resolveModel, setField, fieldPath } from '@augur/core';
import type { PolicyConfig } from '@augur/core';
import { describe, expect, it } from 'vitest';
import { pauseValue, planDialBack } from '../src/dial-back.js';

const NOW = new Date('2026-09-29T20:00:00Z'), UNTIL = '2026-10-04T17:00:00.000Z';
const entry = (id: string, status: 'confirmed' | 'imported' | 'hidden', rule: object) => ({ id, source: 'manual' as const, status, rule, firstSeen: '2026-09-01T00:00:00.000Z' });
const policy = (): PolicyConfig => {
  const p = emptyPolicy();
  p.providers.codex = { defaults: { cost: 'moderate' }, models: {
    'codex/sol': entry('sol', 'confirmed', { cost: 'high', activities: { write_code: 'preferred' } }),
    'codex/astra': entry('astra', 'confirmed', { cost: 'very_high', activities: { write_code: 'often' } }),
    'codex/luna': entry('luna', 'confirmed', { cost: 'cheap', activities: { write_code: 'normal', research: 'last_resort', draft_prose: 'preferred', summarize_extract: null } }),
    'codex/mid': entry('mid', 'confirmed', { activities: { write_code: 'normal' } }),
    'codex/new': entry('new', 'imported', { cost: 'high' }),
    'codex/gone': entry('gone', 'hidden', { cost: 'high' }) } };
  p.providers.grok = { defaults: {}, models: { 'xai/grok': entry('grok', 'confirmed', { cost: 'very_cheap' }) } };
  return p;
};

describe('the dial-back plan', () => {
  it('stops confirmed high-cost models and favours confirmed cheap ones, leaving the rest', () => {
    const plan = planDialBack(policy(), UNTIL, NOW);
    expect(plan.items.filter((i) => i.action === 'stop').map((i) => i.label)).toEqual(['codex/sol', 'codex/astra']);
    expect(plan.items.filter((i) => i.action === 'favour').map((i) => i.label)).toEqual(['codex/luna']);
    expect(plan.skipped).toBe(4);
  });

  it('raises each allowed activity one step, keeps preferred at the top, and leaves a blocked activity blocked', () => {
    const luna = planDialBack(policy(), UNTIL, NOW).items.find((i) => i.label === 'codex/luna')!;
    expect(luna.weights).toEqual({ write_code: 'often', research: 'occasional', draft_prose: 'preferred' });
    expect(luna.weights).not.toHaveProperty('summarize_extract');
  });

  it('skips a model that is already paused', () => {
    const p = policy();
    setField(p, fieldPath('codex', 'codex/sol', 'pause'), { until: '2026-10-01T00:00:00.000Z', weights: null }, 'desktop', NOW);
    const plan = planDialBack(p, UNTIL, NOW);
    expect(plan.items.map((i) => i.label)).not.toContain('codex/sol');
    expect(plan.skipped).toBe(5);
  });

  it('writes ordinary pause fields, so applying it changes what the routers see', () => {
    const p = policy(), plan = planDialBack(p, UNTIL, NOW);
    for (const item of plan.items) setField(p, item.path, pauseValue(item, UNTIL), 'desktop', NOW);
    const at = (label: string, pid = 'codex') => resolveModel(pid, p.providers[pid]!.defaults, p.providers[pid]!.models[label]!);
    expect(at('codex/sol').pause).toEqual({ until: UNTIL, weights: null });
    expect(at('codex/luna').pause).toEqual({ until: UNTIL, weights: { write_code: 'often', research: 'occasional', draft_prose: 'preferred' } });
    expect(at('codex/mid').pause).toBeNull();
  });
});
