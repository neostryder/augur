import { describe, expect, it } from 'vitest';
import { buildPolicyFile, emptyPolicy, importPolicy, fieldPath, setField } from '@augur/core';
import type { PolicyFile } from '@augur/core';
import { DEFAULT_BALANCE, govern, rank, resolveBalance } from '../src/index.js';

const now = new Date('2026-09-28T12:00:00Z');
const level = { write_code: 'normal', review_code: 'normal', draft_prose: 'normal' };
const RULES = { providers: {
  codex: { defaults: { dataTier: 'sensitive', output: 'write_files', cost: 'moderate' }, models: {
    'codex/sol': { id: 'gpt-6.1-sol', rule: { activities: level } },
    'codex/luna': { id: 'gpt-6-luna', rule: { activities: level } },
    'codex/astra': { id: 'gpt-6-astra', rule: { askFirst: true, activities: level } } } },
  claude: { defaults: { dataTier: 'regulated', output: 'write_files', cost: 'moderate' }, models: {
    'claude/live': { id: 'claude-opus-5-5', rule: { activities: level } },
    'claude/claude-sonnet-5-5': { id: 'claude-sonnet-5-5', rule: { activities: level } },
    'claude/fable': { id: 'claude-fable-5-1', rule: { activities: level } } } },
} };

function policy(balance?: Record<string, unknown>): PolicyFile {
  const p = emptyPolicy(); importPolicy(p, RULES, now);
  for (const [id, provider] of Object.entries(p.providers)) for (const label of Object.keys(provider.models)) setField(p, fieldPath(id, label, 'status'), 'confirmed', 'test', now);
  if (balance) p.balance = balance;
  return buildPolicyFile(p, Object.keys(p.providers).map(id => ({ id, name: id, metered: true })), now);
}
const order = (r: ReturnType<typeof rank>) => r.ranking.map(x => x.model);

describe('the balance rules', () => {
  it('ship defaults that mark coding and critique deep and the rest everyday', () => {
    const b = resolveBalance(undefined);
    expect(b).toEqual(DEFAULT_BALANCE);
    expect(b.depth.write_code).toBe('deep');
    expect(b.depth.reason_critique).toBe('deep');
    expect(b.depth.review_code).toBe('everyday');
  });

  it('take an override, and keep the default for a field of the wrong type', () => {
    const b = resolveBalance({ depth: { review_code: 'deep', research: 'sideways' }, tiers: { 'codex/luna': 'strong', 'xai/grok': null }, exclude: ['kimi'], tilt: { deep: { strong: 2, light: 'x' } }, enabled: 'no' });
    expect(b.depth.review_code).toBe('deep');
    expect(b.depth.research).toBe('everyday');
    expect(b.tiers['codex/luna']).toBe('strong');
    expect(b.tiers['xai/grok']).toBeUndefined();
    expect(b.exclude).toEqual(['kimi']);
    expect(b.tilt.deep).toEqual({ strong: 2, light: DEFAULT_BALANCE.tilt.deep.light });
    expect(b.enabled).toBe(true);
  });
});

describe('the governor in a pick', () => {
  it('favors a strong model for deep work and a light one for everyday work', () => {
    const deep = rank(policy(), null, { activity: 'write_code', dataTier: 'internal' });
    expect(order(deep).indexOf('codex/sol')).toBeLessThan(order(deep).indexOf('codex/luna'));
    expect(deep.depth).toBe('deep');
    const everyday = rank(policy(), null, { activity: 'review_code', dataTier: 'internal' });
    expect(order(everyday).indexOf('codex/luna')).toBeLessThan(order(everyday).indexOf('codex/sol'));
    expect(everyday.depth).toBe('everyday');
  });

  it('takes the caller\'s depth over the activity default', () => {
    const r = rank(policy(), null, { activity: 'review_code', dataTier: 'internal', depth: 'deep' });
    expect(r.depth).toBe('deep');
    expect(order(r).indexOf('codex/sol')).toBeLessThan(order(r).indexOf('codex/luna'));
    expect(r.ranking.find(x => x.model === 'codex/sol')?.tilt).toBe(1.4);
  });

  it('tilts Opus up for prose whatever the depth', () => {
    const r = rank(policy(), null, { activity: 'draft_prose', dataTier: 'internal' });
    expect(r.ranking.find(x => x.model === 'claude/live')?.tilt).toBe(1.3);
    expect(order(r)[0]).toBe('claude/live');
  });

  it('never picks an excluded model, but still runs one the person named', () => {
    const r = rank(policy(), null, { activity: 'write_code', dataTier: 'internal' });
    expect(order(r)).not.toContain('claude/fable');
    expect(r.blocked).toContainEqual({ model: 'claude/fable', why: 'fable is excluded by the balance rules' });
    const named = rank(policy(), null, { activity: 'write_code', dataTier: 'internal', named: 'claude/fable' });
    expect(order(named)).toContain('claude/fable');
  });

  it('does nothing when switched off', () => {
    const p = policy({ enabled: false });
    const r = rank(p, null, { activity: 'write_code', dataTier: 'internal' });
    expect(r.ranking.every(x => x.tilt === 1)).toBe(true);
    expect(order(r)).toContain('claude/fable');
    expect(govern(p, 'write_code')).toMatchObject({ tilts: {}, blocks: [] });
  });

  it('says why the top model won and what comes next', () => {
    const r = rank(policy(), null, { activity: 'write_code', dataTier: 'internal' });
    expect(r.reason).toBe(`${r.pick} for deep write code: strong model for deep work. Next: ${r.ranking[1]?.model}.`);
  });

  it('carries the overrides in policy.json and reads them back', () => {
    const p = policy({ tiers: { 'codex/luna': 'strong' } });
    expect(p.balance).toEqual({ tiers: { 'codex/luna': 'strong' } });
    expect(govern(p, 'review_code').tilts['codex/luna']).toBe(0.85);
  });
});
