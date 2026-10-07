import { describe, expect, it } from 'vitest';
import { buildPolicyFile, emptyPolicy, importPolicy, fieldPath, setField } from '@augur/core';
import type { PolicyFile } from '@augur/core';
import { DEFAULT_BALANCE, govern, lookup, nameMatches, rank, resolveBalance, resolveLabel } from '../src/index.js';

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

// The shipped route preferences are tested on their own; the rest of these tests read the depth, pace and backup rules without them.
const NO_PREFER = Object.fromEntries(Object.keys(DEFAULT_BALANCE.prefer).map(m => [m, null]));
function policy(balance?: Record<string, unknown>): PolicyFile {
  const p = emptyPolicy(); importPolicy(p, RULES, now);
  for (const [id, provider] of Object.entries(p.providers)) for (const label of Object.keys(provider.models)) setField(p, fieldPath(id, label, 'status'), 'confirmed', 'test', now);
  p.balance = { prefer: NO_PREFER, ...balance };
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
    expect(p.balance).toMatchObject({ tiers: { 'codex/luna': 'strong' } });
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

  it('leaves out a window scoped to one model, such as the Fable week', () => {
    const scoped = { ...track('weekly', 0, 0.07), id: 'weekly_scoped_fable' as never };
    const r = rank(policy(), claudeUsage([track('weekly', 8, 0.07), scoped]), review, now);
    expect(r.notes.join(' ')).not.toMatch(/behind pace/);
    expect(tiltOf(r, 'claude/claude-sonnet-5-5')).toBeCloseTo(1.15, 3);
  });

  it('counts the week even while Claude marks only the 5-hour window as the active one', () => {
    const inactive = { ...track('weekly', 60, 0.5), active: false };
    const r = rank(policy(), claudeUsage([track('session', 10, 0.5), inactive]), review, now);
    expect(tiltOf(r, 'claude/claude-sonnet-5-5')).toBeCloseTo(1.15 * 1.25, 3);
  });

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

  it('leaves Opus for prose alone when Claude runs hot but not far enough to move prose', () => {
    const r = rank(policy(), claudeUsage([track('weekly', 56, 0.5)]), { activity: 'draft_prose', dataTier: 'internal' }, now);
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

const BACKUPS = { providers: {
  codex: { defaults: { dataTier: 'sensitive', output: 'write_files', cost: 'moderate' }, models: { 'codex/sol': { id: 'gpt-6.1-sol', rule: { activities: level } } } },
  claude: { defaults: { dataTier: 'regulated', output: 'write_files', cost: 'moderate' }, models: { 'claude/live': { id: 'claude-opus-5-5', rule: { activities: level } } } },
  copilot: { defaults: { dataTier: 'sensitive', output: 'write_files', cost: 'moderate' }, models: {
    'copilot/kimi-k3': { id: 'kimi-k3', rule: { activities: level } },
    'copilot/claude-opus-5.5': { id: 'claude-opus-5.5', rule: { activities: level } } } },
  openrouter: { defaults: { dataTier: 'internal', output: 'write_files', cost: 'very_cheap' }, models: { 'deepseek/v4.1-flash': { id: 'deepseek-v4.1-flash', rule: { activities: level } } } },
} };
function backupPolicy(): PolicyFile {
  const p = emptyPolicy(); importPolicy(p, BACKUPS, now);
  for (const [id, provider] of Object.entries(p.providers)) for (const label of Object.keys(provider.models)) setField(p, fieldPath(id, label, 'status'), 'confirmed', 'test', now);
  return buildPolicyFile(p, Object.keys(p.providers).map(id => ({ id, name: id, metered: true })), now);
}
const full = (o: { claude?: number; codex?: number; spend?: number } = {}) => ({ providers: {
  claude: { fetchedAt: now.toISOString(), meters: [track('weekly', o.claude ?? 40, 0.4)] },
  codex: { fetchedAt: now.toISOString(), meters: [track('weekly', o.codex ?? 40, 0.4)] },
  copilot: { fetchedAt: now.toISOString(), meters: [], money: [{ id: 'spent', amount: o.spend ?? 40, currency: 'USD' }] },
} });
const run = (u: ReturnType<typeof full>, activity: 'write_code' | 'review_code' = 'review_code') => rank(backupPolicy(), u, { activity, dataTier: 'internal' }, now);
const names = (r: ReturnType<typeof rank>) => r.ranking.map(x => x.model);
const whyBlocked = (r: ReturnType<typeof rank>, m: string) => r.blocked.find(b => b.model === m)?.why;

describe('the backup routes', () => {
  it('stay in reserve while a subscription route can take the work', () => {
    const r = run(full());
    expect(names(r)).toEqual(expect.arrayContaining(['codex/sol', 'claude/live']));
    expect(whyBlocked(r, 'copilot/kimi-k3')).toBe('a subscription route can take this, so copilot/kimi-k3 stays in reserve');
    expect(whyBlocked(r, 'copilot/claude-opus-5.5')).toBe('Anthropic through a backup waits until Claude reaches its reserve');
  });

  it('let Anthropic through Copilot take over when Claude reaches its reserve', () => {
    const r = run(full({ claude: 92 }));
    expect(names(r)).toContain('copilot/claude-opus-5.5');
    expect(names(r)).not.toContain('claude/live');
    expect(whyBlocked(r, 'copilot/kimi-k3')).toMatch(/stays in reserve/);
    expect(r.ranking.find(x => x.model === 'copilot/claude-opus-5.5')).toBeDefined();
  });

  it('open up other Copilot models only when no subscription route is left', () => {
    const r = run(full({ claude: 92, codex: 99 }), 'write_code');
    expect(names(r)).toContain('copilot/kimi-k3');
    expect(names(run(full({ claude: 92, codex: 99 })))).not.toContain('copilot/kimi-k3');
    expect(whyBlocked(r, 'codex/sol')).toBeUndefined();
    const g = govern(backupPolicy(), 'write_code', undefined, undefined, undefined, full({ claude: 92, codex: 99 }), now);
    expect(g.reasons['copilot/kimi-k3']).toContain('no subscription route can take this');
  });

  it('report a Copilot spend past the aim, and stop at the cap', () => {
    const past = run(full({ claude: 92, codex: 99, spend: 160 }), 'write_code');
    expect(names(past)).toContain('copilot/kimi-k3');
    expect(past.notes.join(' ')).toContain('Copilot spend is $160.00, past the $150 aim');
    const capped = run(full({ claude: 92, codex: 99, spend: 246 }), 'write_code');
    expect(names(capped)).not.toContain('copilot/kimi-k3');
    expect(whyBlocked(capped, 'copilot/kimi-k3')).toBe('Copilot spend is $246.00, at the $250 cap');
  });

  it('never let a Claude stop come from the Copilot cap', () => {
    const r = run(full({ claude: 92, spend: 300 }));
    expect(names(r)).toContain('copilot/claude-opus-5.5');
    const notYet = run(full({ claude: 40, spend: 300 }));
    expect(names(notYet)).not.toContain('copilot/claude-opus-5.5');
  });

  it('hold DeepSeek back for coding but let it review', () => {
    expect(names(run(full(), 'write_code'))).not.toContain('deepseek/v4.1-flash');
    expect(whyBlocked(run(full(), 'write_code'), 'deepseek/v4.1-flash')).toMatch(/stays in reserve/);
    expect(names(run(full(), 'review_code'))).toContain('deepseek/v4.1-flash');
  });

  it('are not held for a model the person names', () => {
    const r = rank(backupPolicy(), full(), { activity: 'review_code', dataTier: 'internal', named: 'copilot/kimi-k3' }, now);
    expect(names(r)).toContain('copilot/kimi-k3');
  });

  it('take their budget and routes from the rules', () => {
    const b = resolveBalance({ fallback: { aim: 100, cap: 120, margin: 0, routes: { 'deepseek/v4.1-flash': null }, anthropic: [] } });
    expect(b.fallback).toMatchObject({ aim: 100, cap: 120, margin: 0, routes: {}, anthropic: [] });
  });
});

const all = { write_code: 'normal', review_code: 'normal', research: 'normal', typed_decisions: 'normal', bulk_tagging: 'normal', generate_images: 'normal' };
const SEATS = { providers: {
  codex: { defaults: { dataTier: 'sensitive', output: 'write_files', cost: 'moderate' }, models: { 'codex/sol': { id: 'gpt-6.1-sol', rule: { activities: all } } } },
  minimax: { defaults: { dataTier: 'internal', output: 'write_files', cost: 'free' }, models: { 'minimax/m3': { id: 'minimax-m3', rule: { activities: all } } } },
  chatgpt: { defaults: { dataTier: 'public', output: 'text', cost: 'free' }, models: { 'chatgpt/web': { id: 'chatgpt-web', rule: { activities: all } } } },
  jev: { defaults: { dataTier: 'internal', output: 'text', cost: 'very_cheap' }, models: { 'jev/jev-latest': { id: 'jev-latest', rule: { activities: all } } } },
  laya: { defaults: { dataTier: 'regulated', output: 'text', cost: 'free' }, models: { 'laya/laya': { id: 'laya', rule: { activities: { typed_decisions: 'normal' } } } } },
} };
function seatPolicy(balance?: Record<string, unknown>): PolicyFile {
  const p = emptyPolicy(); importPolicy(p, SEATS, now);
  for (const [id, provider] of Object.entries(p.providers)) for (const label of Object.keys(provider.models)) setField(p, fieldPath(id, label, 'status'), 'confirmed', 'test', now);
  p.balance = { prefer: NO_PREFER, ...balance };
  return buildPolicyFile(p, Object.keys(p.providers).map(id => ({ id, name: id, metered: true })), now);
}
const seat = (activity: 'write_code' | 'research' | 'typed_decisions' | 'generate_images', tier: 'public' | 'internal' = 'internal', balance?: Record<string, unknown>) =>
  rank(seatPolicy(balance), null, { activity, dataTier: tier }, now);

describe('the seats beside a pick', () => {
  it('add a second opinion from MiniMax on a task that is not small', () => {
    const r = seat('write_code');
    expect(r.pick).not.toBe('minimax/m3');
    expect(r.seats.second).toMatchObject({ model: 'minimax/m3' });
    expect(seat('generate_images').seats.second).toBeUndefined();
  });

  it('skip the second opinion when its data tier does not allow it, or the pick is that model', () => {
    expect(seat('write_code', 'internal').seats.second?.model).toBe('minimax/m3');
    const sensitive = rank(seatPolicy(), null, { activity: 'write_code', dataTier: 'sensitive' }, now);
    expect(sensitive.seats.second).toBeUndefined();
    const only = rank(seatPolicy({ seats: { second: { models: ['codex/sol'] } } }), null, { activity: 'write_code', dataTier: 'internal' }, now);
    expect(only.seats.second?.model === only.pick).toBe(false);
  });

  it('recommend a free web route for research, with the steps for the caller', () => {
    const r = seat('research', 'public');
    expect(r.seats.web).toMatchObject({ model: 'chatgpt/web' });
    expect(r.seats.web?.how).toMatch(/~\/\.augur\/web\/research-\d{8}-\d{4}\/brief\.md/);
    expect(r.seats.web?.how).toContain('/result.md');
    expect(seat('research', 'internal').seats.web).toBeUndefined();
    expect(seat('write_code', 'public').seats.web).toBeUndefined();
  });

  it('put Jev first for classification and scoring, and leave the shadow off its own decisions', () => {
    const r = seat('typed_decisions');
    expect(r.pick).toBe('jev/jev-latest');
    expect(r.reason).toContain('Jev is first for classification and scoring');
    expect(r.seats.shadow).toBeUndefined();
    expect(tiltOfJev(seat('write_code'))).toBe(1);
  });

  it('name the local model as a shadow beside a reasoning model\'s pick', () => {
    const r = seat('write_code');
    expect(r.seats.shadow?.model).toBe('laya/laya');
    expect(seat('write_code', 'internal', { enabled: false }).seats).toEqual({});
    expect(seat('write_code', 'internal', { seats: { shadow: '' } }).seats.shadow).toBeUndefined();
  });
});
const tiltOfJev = (r: ReturnType<typeof rank>) => r.ranking.find(x => x.model === 'jev/jev-latest')?.tilt;

describe('the route preferences', () => {
  it('lift a route on the activity it is known for', () => {
    const p = seatPolicy(); p.balance = {};
    const r = rank(p, null, { activity: 'research', dataTier: 'public' }, now);
    expect(r.ranking.find(x => x.model === 'chatgpt/web')?.tilt).toBe(1.3);
    expect(r.reason).toContain('suits research');
    expect(r.ranking.find(x => x.model === 'minimax/m3')?.tilt).toBe(1.15);
  });

  it('take overrides and removals from the rules', () => {
    const b = resolveBalance({ prefer: { 'minimax/m3': { long_context: 2, summarize_extract: null }, 'codex/luna': null, 'x/y': { research: 1.5, nonsense: 3 } } });
    expect(b.prefer['minimax/m3']).toEqual({ long_context: 2 });
    expect(b.prefer['codex/luna']).toBeUndefined();
    expect(b.prefer['x/y']).toEqual({ research: 1.5 });
  });
});

describe('profiles', () => {
  it('start from the classic rules when none is named, or the name is not one', () => {
    expect(resolveBalance({}).profile).toBe('classic');
    expect(resolveBalance({ profile: 'bespoke' })).toEqual(DEFAULT_BALANCE);
  });

  it('start from neutral rules when neutral is named, and still take overrides', () => {
    const b = resolveBalance({ profile: 'neutral' });
    expect(b.profile).toBe('neutral');
    expect(b.exclude).toEqual([]);
    expect(b.prefer).toEqual({});
    expect(b.seats.shadow).toBe('');
    expect(b.tilt.deep.strong).toBe(1);
    expect(resolveBalance({ profile: 'neutral', exclude: ['kimi'], fallback: { aim: 90 } })).toMatchObject({ exclude: ['kimi'], fallback: { aim: 90, providers: [] } });
  });

  it('tilt nothing but Claude\'s pace, so a strong model is not favored for deep work', () => {
    const neutral = (extra: Record<string, unknown> = {}) => policy({ profile: 'neutral', ...extra });
    const deep = rank(neutral(), null, { activity: 'write_code', dataTier: 'internal' }, now);
    expect(tiltOf(deep, 'codex/sol')).toBe(1);
    expect(tiltOf(deep, 'codex/luna')).toBe(1);
    expect(tiltOf(deep, 'claude/live')).toBe(1);
    // Fable and Astra are not excluded by words, only by their own ask-first rule.
    expect(deep.blocked.find(b => b.model === 'codex/astra')?.why).toMatch(/ask first/);
    const hot = rank(neutral(), claudeUsage([track('weekly', 70, 0.4)]), { activity: 'write_code', dataTier: 'internal' }, now);
    expect(tiltOf(hot, 'claude/live')).toBeCloseTo(0.8, 3);
    expect(tiltOf(hot, 'claude/claude-sonnet-5-5')).toBeCloseTo(1.25, 3);
    expect(tiltOf(hot, 'codex/sol')).toBe(1);
  });
});

describe('standard names', () => {
  const ref = { label: 'codex/sol', provider: 'codex', id: 'gpt-6.1-sol' };

  it('stand for a model by its label, by its provider and model id, or by a pattern', () => {
    expect(nameMatches('codex/sol', ref)).toBe(true);
    expect(nameMatches('codex/gpt-6.1-sol', ref)).toBe(true);
    expect(nameMatches('codex/*sol', ref)).toBe(true);
    expect(nameMatches('*/gpt-6.1-*', ref)).toBe(true);
    expect(nameMatches('codex/luna', ref)).toBe(false);
    expect(nameMatches('codex/gpt-6.1-so', ref)).toBe(false);
    expect(nameMatches('codex/gpt-6.1-sol.json', ref)).toBe(false);
  });

  it('give a label\'s own entry the last word over its standard name and a pattern', () => {
    const map = { 'codex/*': 'light', 'codex/gpt-6.1-sol': 'strong', 'codex/sol': 'light' } as const;
    expect(lookup(map, ref)).toBe('light');
    expect(lookup({ 'codex/*': 'light', 'codex/gpt-6.1-sol': 'strong' }, ref)).toBe('strong');
    expect(lookup({ 'codex/*': 'light' }, ref)).toBe('light');
    expect(lookup({}, ref)).toBeUndefined();
  });

  it('reach a person\'s own label in a tier, a preference, a list and a seat', () => {
    // The neutral profile holds no label entries, so these standard names are the only rules that reach the models.
    const b = { profile: 'neutral', tiers: { 'codex/gpt-6-luna': 'strong' }, prefer: { 'codex/gpt-6-luna': { review_code: 2 } } };
    const r = rank(policy(b), null, { activity: 'review_code', dataTier: 'internal' }, now);
    expect(tiltOf(r, 'codex/luna')).toBeCloseTo(2, 3);
    expect(tiltOf(r, 'codex/sol')).toBe(1);
    const seated = rank(policy({ profile: 'neutral', seats: { second: { models: ['claude/claude-opus-5-5'] } } }), null, { activity: 'write_code', dataTier: 'internal' }, now);
    expect(seated.seats?.second?.model).toBe('claude/live');
  });

  it('are found among the policy\'s models for a seat', () => {
    const p = policy();
    expect(resolveLabel(p, 'claude/claude-opus-5-5')).toBe('claude/live');
    expect(resolveLabel(p, 'codex/sol')).toBe('codex/sol');
    expect(resolveLabel(p, 'nobody/none')).toBeNull();
    expect(resolveLabel(p, '')).toBeNull();
  });
});
