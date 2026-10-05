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

const HOUR = 3600e3, WEEK = 7 * 24 * HOUR;
/** A Claude meter that is `elapsed` of the way through its window and `used` percent spent. */
const track = (kind: 'session' | 'weekly', used: number, elapsed: number) => {
  const seconds = kind === 'weekly' ? WEEK / 1000 : 5 * HOUR / 1000;
  return { id: kind, label: kind, usedPct: used, windowKind: kind, windowSeconds: seconds, resetsAt: new Date(now.getTime() + (1 - elapsed) * seconds * 1000).toISOString() };
};
const claudeUsage = (meters: ReturnType<typeof track>[], fetchedAt = now.toISOString()) => ({ providers: { claude: { fetchedAt, meters } } });
const tiltOf = (r: ReturnType<typeof rank>, m: string) => r.ranking.find(x => x.model === m)?.tilt;

describe('the Claude controller', () => {
  const review = { activity: 'review_code' as const, dataTier: 'internal' as const };

  it('leans to Sonnet when the week runs ahead of pace, and says so', () => {
    const r = rank(policy(), claudeUsage([track('weekly', 60, 0.5)]), review, now);
    expect(tiltOf(r, 'claude/claude-sonnet-5-5')).toBeCloseTo(1.15 * 1.25, 3);
    expect(tiltOf(r, 'claude/live')).toBeCloseTo(0.85 * 0.8, 3);
    expect(r.pick).toBe('claude/claude-sonnet-5-5');
    expect(r.reason).toContain('week is 10 points ahead of pace, so Claude leans to Sonnet');
  });

  it('leans to Opus when both windows fall behind pace', () => {
    const r = rank(policy(), claudeUsage([track('weekly', 30, 0.5), track('session', 10, 0.5)]), review, now);
    expect(tiltOf(r, 'claude/live')).toBeCloseTo(0.85 * 1.25, 3);
    expect(tiltOf(r, 'claude/claude-sonnet-5-5')).toBeCloseTo(1.15 * 0.85, 3);
  });

  it('adds nothing inside the band', () => {
    const r = rank(policy(), claudeUsage([track('weekly', 53, 0.5)]), review, now);
    expect(tiltOf(r, 'claude/live')).toBe(0.85);
    expect(tiltOf(r, 'claude/claude-sonnet-5-5')).toBe(1.15);
  });

  it('lets the stricter track win', () => {
    const r = rank(policy(), claudeUsage([track('weekly', 20, 0.5), track('session', 60, 0.3)]), review, now);
    expect(govern(policy(), 'review_code', undefined, undefined, undefined, claudeUsage([track('weekly', 20, 0.5), track('session', 60, 0.3)]), now).reasons['claude/claude-sonnet-5-5']?.join(' ')).toContain('5-hour window is 30 points ahead of pace');
    expect(tiltOf(r, 'claude/claude-sonnet-5-5')).toBeCloseTo(1.15 * 1.25, 3);
    const one = rank(policy(), claudeUsage([track('weekly', 20, 0.5), track('session', 52, 0.5)]), review, now);
    expect(tiltOf(one, 'claude/live')).toBe(0.85);
  });

  it('leaves Opus for prose alone when Claude runs hot', () => {
    const r = rank(policy(), claudeUsage([track('weekly', 60, 0.5)]), { activity: 'draft_prose', dataTier: 'internal' }, now);
    expect(tiltOf(r, 'claude/live')).toBe(1.3);
  });

  it('moves optional work off Claude at the reserve while another route can take it', () => {
    const r = rank(policy(), claudeUsage([track('session', 91, 0.5)]), review, now);
    expect(r.ranking.map(x => x.model)).not.toContain('claude/live');
    expect(r.blocked.find(b => b.model === 'claude/live')?.why).toMatch(/past the 90% reserve/);
    const alone = govern(policy(), 'review_code', undefined, ['claude/live'], undefined, claudeUsage([track('session', 91, 0.5)]), now);
    expect(alone.blocks).toEqual([]);
    const named = rank(policy(), claudeUsage([track('session', 91, 0.5)]), { ...review, named: 'claude/live' }, now);
    expect(named.ranking.map(x => x.model)).toContain('claude/live');
  });

  it('treats unusable Claude figures as hot and says it could not check the reserve', () => {
    const r = rank(policy(), claudeUsage([track('weekly', 50, 0.5)], new Date(now.getTime() - 3 * HOUR).toISOString()), review, now);
    expect(r.notes.join(' ')).toContain('reserve could not be checked');
    expect(tiltOf(r, 'claude/claude-sonnet-5-5')).toBeCloseTo(1.15 * 1.25, 3);
  });

  it('is off when no Claude figures are present, and takes its numbers from the rules', () => {
    expect(rank(policy(), { providers: {} }, review, now).notes).toEqual([]);
    const tight = policy({ claude: { band: 1, hot: { light: 2 } } });
    const r = rank(tight, claudeUsage([track('weekly', 53, 0.5)]), review, now);
    expect(tiltOf(r, 'claude/claude-sonnet-5-5')).toBeCloseTo(1.15 * 2, 3);
  });
});
