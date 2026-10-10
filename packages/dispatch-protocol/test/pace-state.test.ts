import { describe, expect, it } from 'vitest';
import { buildPolicyFile, emptyPolicy, fieldPath, importPolicy, setField } from '@augur/core';
import type { PolicyFile } from '@augur/core';
import { DEFAULT_BALANCE, balanceReport, claudeState, govern, paceState, pacedProviders, rank, resolveBalance } from '../src/index.js';
import type { Governed, UsageMeter, UsageSnapshot } from '../src/index.js';

const now = new Date('2026-09-28T12:00:00Z');
const level = { write_code: 'normal', review_code: 'normal', draft_prose: 'normal' };
const HOUR = 3600e3, WEEK = 7 * 24 * HOUR;
const NO_PREFER = Object.fromEntries(Object.keys(DEFAULT_BALANCE.prefer).map(m => [m, null]));

function policyFrom(rules: Record<string, unknown>, balance?: Record<string, unknown>, names?: Record<string, string>): PolicyFile {
  const p = emptyPolicy(); importPolicy(p, rules, now);
  for (const [id, provider] of Object.entries(p.providers)) for (const label of Object.keys(provider.models)) setField(p, fieldPath(id, label, 'status'), 'confirmed', 'test', now);
  p.balance = { prefer: NO_PREFER, ...balance };
  return buildPolicyFile(p, Object.keys(p.providers).map(id => ({ id, name: names?.[id] ?? id, metered: true })), now);
}

const PAIR = { providers: {
  codex: { defaults: { dataTier: 'sensitive', output: 'write_files', cost: 'moderate' }, models: {
    'codex/sol': { id: 'gpt-6.1-sol', rule: { activities: level } },
    'codex/luna': { id: 'gpt-6-luna', rule: { activities: level } } } },
  claude: { defaults: { dataTier: 'regulated', output: 'write_files', cost: 'moderate' }, models: {
    'claude/live': { id: 'claude-opus-5-5', rule: { activities: level } },
    'claude/claude-sonnet-5-5': { id: 'claude-sonnet-5-5', rule: { activities: level } },
    'claude/fable': { id: 'claude-fable-5-1', rule: { activities: level } } } },
} };
const pair = () => policyFrom(PAIR);

const track = (kind: 'session' | 'weekly', used: number, elapsed: number): UsageMeter => {
  const seconds = kind === 'weekly' ? WEEK / 1000 : 5 * HOUR / 1000;
  return { id: kind, label: kind, usedPct: used, windowKind: kind, windowSeconds: seconds, resetsAt: new Date(now.getTime() + (1 - elapsed) * seconds * 1000).toISOString() };
};
const bare = (kind: 'session' | 'weekly', used: number): UsageMeter => ({ id: kind, label: kind, usedPct: used, windowKind: kind });
const claudeOnly = (meters: UsageMeter[], fetchedAt = now.toISOString()): UsageSnapshot => ({ providers: { claude: { fetchedAt, meters } } });

const view = (g: Governed) => ({ depth: g.depth, tilts: g.tilts, blocks: g.blocks, reasons: g.reasons, notes: g.notes, proseSwitch: g.proseSwitch });

// govern() for Claude-only usage, captured before a provider other than Claude was paced.
const FROZEN: Record<string, ReturnType<typeof view>> = {
  hot: {
    depth: 'everyday',
    tilts: { 'codex/sol': 0.85, 'codex/luna': 1.15, 'claude/live': 0.68, 'claude/claude-sonnet-5-5': 1.438 },
    blocks: [{ model: 'claude/fable', why: 'fable is excluded by the balance rules' }],
    reasons: {
      'codex/sol': ['strong model for everyday work'],
      'codex/luna': ['light model for everyday work'],
      'claude/live': ['strong model for everyday work', 'the week is 10 points ahead of pace, so Claude leans to Sonnet'],
      'claude/claude-sonnet-5-5': ['light model for everyday work', 'the week is 10 points ahead of pace, so Claude leans to Sonnet'],
    },
    notes: [],
    proseSwitch: { on: true, ahead: 10, threshold: 6, returnAt: 0 },
  },
  behind: {
    depth: 'everyday',
    tilts: { 'codex/sol': 0.85, 'codex/luna': 1.15, 'claude/live': 1.063, 'claude/claude-sonnet-5-5': 0.977 },
    blocks: [{ model: 'claude/fable', why: 'fable is excluded by the balance rules' }],
    reasons: {
      'codex/sol': ['strong model for everyday work'],
      'codex/luna': ['light model for everyday work'],
      'claude/live': ['strong model for everyday work', 'the week is 20 points behind pace and the 5-hour window is 40 points behind pace, so Claude leans to Opus'],
      'claude/claude-sonnet-5-5': ['light model for everyday work', 'the week is 20 points behind pace and the 5-hour window is 40 points behind pace, so Claude leans to Opus'],
    },
    notes: [],
    proseSwitch: { on: false, ahead: -20, threshold: 9, returnAt: 0 },
  },
  'on-pace': {
    depth: 'everyday',
    tilts: { 'codex/sol': 0.85, 'codex/luna': 1.15, 'claude/live': 0.85, 'claude/claude-sonnet-5-5': 1.15 },
    blocks: [{ model: 'claude/fable', why: 'fable is excluded by the balance rules' }],
    reasons: {
      'codex/sol': ['strong model for everyday work'],
      'codex/luna': ['light model for everyday work'],
      'claude/live': ['strong model for everyday work'],
      'claude/claude-sonnet-5-5': ['light model for everyday work'],
    },
    notes: [],
    proseSwitch: { on: false, ahead: 3, threshold: 6.7, returnAt: 0 },
  },
  unknown: {
    depth: 'everyday',
    tilts: { 'codex/sol': 0.85, 'codex/luna': 1.15, 'claude/live': 0.68, 'claude/claude-sonnet-5-5': 1.438 },
    blocks: [{ model: 'claude/fable', why: 'fable is excluded by the balance rules' }],
    reasons: {
      'codex/sol': ['strong model for everyday work'],
      'codex/luna': ['light model for everyday work'],
      'claude/live': ['strong model for everyday work', 'Claude figures are missing, so it leans to Sonnet'],
      'claude/claude-sonnet-5-5': ['light model for everyday work', 'Claude figures are missing, so it leans to Sonnet'],
    },
    notes: ['Claude usage figures are missing or old, so the reserve could not be checked and Claude leans light.'],
    proseSwitch: { on: false, ahead: null, threshold: 7, returnAt: 0 },
  },
  reserve: {
    depth: 'everyday',
    tilts: { 'codex/sol': 0.85, 'codex/luna': 1.15 },
    blocks: [
      { model: 'claude/fable', why: 'fable is excluded by the balance rules' },
      { model: 'claude/live', why: 'Claude is at 91% of a window, past the 90% reserve, so other routes take optional work' },
      { model: 'claude/claude-sonnet-5-5', why: 'Claude is at 91% of a window, past the 90% reserve, so other routes take optional work' },
    ],
    reasons: {
      'codex/sol': ['strong model for everyday work'],
      'codex/luna': ['light model for everyday work'],
    },
    notes: [],
    proseSwitch: { on: true, ahead: 41, threshold: 3, returnAt: 0 },
  },
  'reserve-alone': {
    depth: 'everyday',
    tilts: { 'claude/live': 0.68 },
    blocks: [],
    reasons: { 'claude/live': ['strong model for everyday work', 'the 5-hour window is 41 points ahead of pace, so Claude leans to Sonnet'] },
    notes: [],
    proseSwitch: { on: true, ahead: 41, threshold: 3, returnAt: 0 },
  },
  stale: {
    depth: 'everyday',
    tilts: { 'codex/sol': 0.85, 'codex/luna': 1.15, 'claude/live': 0.68, 'claude/claude-sonnet-5-5': 1.438 },
    blocks: [{ model: 'claude/fable', why: 'fable is excluded by the balance rules' }],
    reasons: {
      'codex/sol': ['strong model for everyday work'],
      'codex/luna': ['light model for everyday work'],
      'claude/live': ['strong model for everyday work', 'Claude figures are missing, so it leans to Sonnet'],
      'claude/claude-sonnet-5-5': ['light model for everyday work', 'Claude figures are missing, so it leans to Sonnet'],
    },
    notes: ['Claude usage figures are missing or old, so the reserve could not be checked and Claude leans light.'],
    proseSwitch: { on: false, ahead: null, threshold: 12, returnAt: 0 },
  },
  none: {
    depth: 'everyday',
    tilts: { 'codex/sol': 0.85, 'codex/luna': 1.15, 'claude/live': 0.85, 'claude/claude-sonnet-5-5': 1.15 },
    blocks: [{ model: 'claude/fable', why: 'fable is excluded by the balance rules' }],
    reasons: {
      'codex/sol': ['strong model for everyday work'],
      'codex/luna': ['light model for everyday work'],
      'claude/live': ['strong model for everyday work'],
      'claude/claude-sonnet-5-5': ['light model for everyday work'],
    },
    notes: [],
    proseSwitch: { on: false, ahead: null, threshold: 12, returnAt: 0 },
  },
  'hot-prose': {
    depth: 'everyday',
    tilts: { 'codex/sol': 0.85, 'codex/luna': 1.15, 'claude/claude-sonnet-5-5': 1.438 },
    blocks: [
      { model: 'claude/fable', why: 'fable is excluded by the balance rules' },
      { model: 'claude/live', why: 'Claude runs 20 points ahead of pace, so prose is off it until the lead falls to 0 points' },
    ],
    reasons: {
      'codex/sol': ['strong model for everyday work'],
      'codex/luna': ['light model for everyday work'],
      'claude/claude-sonnet-5-5': ['light model for everyday work', 'the week is 20 points ahead of pace, so Claude leans to Sonnet'],
    },
    notes: [],
    proseSwitch: { on: true, ahead: 20, threshold: 6, returnAt: 0 },
  },
};

const fixtures: Array<[string, 'review_code' | 'draft_prose', ReturnType<typeof claudeOnly>, readonly string[] | undefined]> = [
  ['hot', 'review_code', claudeOnly([track('weekly', 60, 0.5)]), undefined],
  ['behind', 'review_code', claudeOnly([track('weekly', 30, 0.5), track('session', 10, 0.5)]), undefined],
  ['on-pace', 'review_code', claudeOnly([track('weekly', 53, 0.5)]), undefined],
  ['unknown', 'review_code', claudeOnly([bare('weekly', 50)]), undefined],
  ['reserve', 'review_code', claudeOnly([track('session', 91, 0.5)]), undefined],
  ['reserve-alone', 'review_code', claudeOnly([track('session', 91, 0.5)]), ['claude/live']],
  ['stale', 'review_code', claudeOnly([track('weekly', 50, 0.5)], new Date(now.getTime() - 3 * HOUR).toISOString()), undefined],
  ['none', 'review_code', { providers: {} }, undefined],
  ['hot-prose', 'draft_prose', claudeOnly([track('weekly', 60, 0.4)]), undefined],
];

describe('one pace state per provider', () => {
  const rules = resolveBalance(undefined);

  it('matches the Claude-only governor captured before this step', () => {
    const p = pair();
    for (const [name, activity, usage, models] of fixtures) {
      const g = govern(p, activity, undefined, models, undefined, usage, now);
      expect(view(g), name).toEqual(FROZEN[name]);
      const s = paceState(usage, rules, 'claude', now);
      expect(claudeState(usage, rules, now), name).toEqual({ stance: s.stance, tracks: s.tracks, peak: s.peak, atReserve: s.atReserve });
      expect(g.proseSwitches, name).toEqual(name === 'none' ? {} : { claude: g.proseSwitch });
    }
  });

  it('tilts a hot second provider and leaves Claude on pace alone', () => {
    const p = policyFrom(PAIR, { prose: { models: ['codex/sol', 'claude/live'] } }, { codex: 'Codex', claude: 'Claude' });
    const usage = { providers: {
      claude: { fetchedAt: now.toISOString(), meters: [track('weekly', 50, 0.5)] },
      codex: { fetchedAt: now.toISOString(), meters: [track('weekly', 10.5, 0)] },
    } };
    const review = govern(p, 'review_code', undefined, undefined, undefined, usage, now);
    expect(review.tilts['codex/sol']).toBeCloseTo(0.85 * 0.8, 3);
    expect(review.tilts['codex/luna']).toBeCloseTo(1.15 * 1.25, 3);
    expect(review.tilts['claude/live']).toBe(0.85);
    expect(review.tilts['claude/claude-sonnet-5-5']).toBe(1.15);
    expect(review.reasons['codex/luna']?.join(' ')).toContain('so Codex leans to its light models');
    expect(review.reasons['claude/live']?.join(' ')).not.toMatch(/ahead of pace|behind pace/);
    const prose = govern(p, 'draft_prose', undefined, undefined, undefined, usage, now);
    expect(prose.tilts['codex/sol']).toBe(1.3);
    expect(prose.reasons['codex/sol']).toEqual(['writes the best prose']);
    expect(prose.tilts['codex/luna']).toBeCloseTo(1.15 * 1.25, 3);
  });

  it('does not pace a provider with no session or weekly window', () => {
    const ruleset = { providers: {
      ...PAIR.providers,
      minimax: { defaults: { dataTier: 'internal', output: 'write_files', cost: 'cheap' }, models: { 'minimax/m3': { id: 'minimax-m3', rule: { activities: level } } } },
      grok: { defaults: { dataTier: 'internal', output: 'write_files', cost: 'moderate' }, models: { 'xai/grok': { id: 'grok-4.7', rule: { activities: level } } } },
    } };
    const p = policyFrom(ruleset, { tiers: { 'minimax/m3': 'strong', 'xai/grok': 'light' } });
    const scoped = { ...track('weekly', 99, 0.5), id: 'weekly_scoped_grok' };
    const usage = { providers: {
      claude: { fetchedAt: now.toISOString(), meters: [track('weekly', 50, 0.5)] },
      minimax: { fetchedAt: now.toISOString(), meters: [{ id: 'credits', label: 'credits', usedPct: 99, windowKind: 'credits' }] },
      grok: { fetchedAt: now.toISOString(), meters: [scoped] },
    } };
    expect(pacedProviders(usage, resolveBalance(p.balance), now).sort()).toEqual(['claude']);
    const g = govern(p, 'review_code', undefined, undefined, undefined, usage, now);
    expect(g.tilts['minimax/m3']).toBe(0.85);
    expect(g.tilts['xai/grok']).toBe(1.15);
    expect(g.blocks.map(b => b.model)).not.toContain('minimax/m3');
    expect(g.blocks.map(b => b.model)).not.toContain('xai/grok');
    const stale = { ...usage, providers: { ...usage.providers, minimax: { fetchedAt: new Date(now.getTime() - 3 * HOUR).toISOString(), meters: [track('weekly', 99, 0.2)] } } };
    expect(pacedProviders(stale, resolveBalance(p.balance), now)).not.toContain('minimax');
    expect(govern(p, 'review_code', undefined, undefined, undefined, stale, now).blocks.map(b => b.model)).not.toContain('minimax/m3');
  });

  it('blocks a provider at its reserve only while another provider stays live', () => {
    const p = pair();
    const both = { providers: {
      claude: { fetchedAt: now.toISOString(), meters: [track('weekly', 95, 0.5)] },
      codex: { fetchedAt: now.toISOString(), meters: [track('weekly', 95, 0.5)] },
    } };
    const g = govern(p, 'review_code', undefined, undefined, undefined, both, now);
    expect(g.blocks.find(b => b.model === 'claude/live')?.why).toBe('Claude is at 95% of a window, past the 90% reserve, so other routes take optional work');
    expect(g.blocks.map(b => b.model)).not.toContain('codex/sol');
    expect(g.blocks.map(b => b.model)).not.toContain('codex/luna');
    const named = govern(p, 'review_code', undefined, undefined, 'claude/live', both, now);
    expect(named.blocks.map(b => b.model)).not.toContain('claude/live');
    expect(named.blocks.map(b => b.model)).toContain('claude/claude-sonnet-5-5');
    const three = policyFrom({ providers: {
      ...PAIR.providers,
      minimax: { defaults: { dataTier: 'internal', output: 'write_files', cost: 'cheap' }, models: { 'minimax/m3': { id: 'minimax-m3', rule: { activities: level } } } },
    } });
    const all = { providers: {
      ...both.providers,
      minimax: { fetchedAt: now.toISOString(), meters: [track('weekly', 96, 0.5)] },
    } };
    const held = govern(three, 'review_code', undefined, undefined, undefined, all, now);
    expect(held.blocks.map(b => b.model)).toEqual(expect.arrayContaining(['claude/live', 'codex/sol']));
    expect(held.blocks.map(b => b.model)).not.toContain('minimax/m3');
  });

  it('lists pace rows attention first and leaves the Claude row as it was', () => {
    const owners = { providers: {
      claude: { defaults: { dataTier: 'regulated', output: 'write_files', cost: 'moderate' }, models: { 'claude/live': { id: 'opus', rule: { activities: level } } } },
      codex: { defaults: { dataTier: 'sensitive', output: 'write_files', cost: 'moderate' }, models: { 'codex/sol': { id: 'sol', rule: { activities: level } } } },
      openrouter: { defaults: { dataTier: 'internal', output: 'write_files', cost: 'cheap' }, models: { 'deepseek/v4.1-flash': { id: 'flash', rule: { activities: level } } } },
      minimax: { defaults: { dataTier: 'internal', output: 'write_files', cost: 'cheap' }, models: { 'minimax/m3': { id: 'm3', rule: { activities: level } } } },
      jev: { defaults: { dataTier: 'internal', output: 'text', cost: 'cheap' }, models: { 'jev/jev-latest': { id: 'jev', rule: { activities: level } } } },
      grok: { defaults: { dataTier: 'internal', output: 'write_files', cost: 'moderate' }, models: { 'xai/grok': { id: 'grok', rule: { activities: level } } } },
    } };
    const p = policyFrom(owners, undefined, { claude: 'Claude', codex: 'Codex', openrouter: 'OpenRouter', minimax: 'MiniMax', jev: 'Jev', grok: 'Grok' });
    const usage = { providers: {
      claude: { fetchedAt: now.toISOString(), meters: [track('weekly', 40, 0.4)] },
      openrouter: { fetchedAt: now.toISOString(), meters: [track('weekly', 92, 0.5)] },
      codex: { fetchedAt: now.toISOString(), meters: [track('weekly', 70, 0.5)] },
      minimax: { fetchedAt: now.toISOString(), meters: [bare('weekly', 80)] },
      jev: { fetchedAt: now.toISOString(), meters: [track('weekly', 30, 0.8)] },
      grok: { fetchedAt: now.toISOString(), meters: [track('weekly', 10, 0.8)] },
    } };
    const r = balanceReport(p, usage, now);
    expect(r.pace.map(row => [row.provider, row.stance, row.peak])).toEqual([
      ['openrouter', 'hot', 92],
      ['codex', 'hot', 70],
      ['minimax', 'unknown', 80],
      ['jev', 'behind', 30],
      ['grok', 'behind', 10],
      ['claude', 'on pace', 40],
    ]);
    expect(r.pace.map(row => row.name)).toEqual(['OpenRouter', 'Codex', 'MiniMax', 'Jev', 'Grok', 'Claude']);
    expect(r.pace.find(row => row.provider === 'openrouter')?.atReserve).toBe(true);
    expect(r.pace.find(row => row.provider === 'codex')).toMatchObject({ band: 10, reserve: 90, atReserve: false });
    const claude = r.pace.find(row => row.provider === 'claude');
    expect(r.claude).toMatchObject({ stance: 'on pace', lean: 'neither', peak: 40, atReserve: false, band: 5, reserve: 90, tracks: claude?.tracks });
  });

  it('moves prose off a hot Opus provider and brings it back at returnAt', () => {
    const preferred = { ...level, draft_prose: 'preferred' };
    const owners = { providers: {
      claude: { defaults: { dataTier: 'regulated', output: 'write_files', cost: 'moderate' }, models: { 'claude/live': { id: 'claude-opus-5-5', rule: { activities: level } } } },
      copilot: { defaults: { dataTier: 'internal', output: 'write_files', cost: 'moderate' }, models: { 'copilot/claude-opus-5.5': { id: 'claude-opus-5.5', rule: { activities: preferred } } } },
    } };
    const p = policyFrom(owners, { fallback: { providers: [], anthropic: [] }, prose: { models: ['claude/live', 'copilot/claude-opus-5.5'] } }, { claude: 'Claude', copilot: 'Copilot' });
    const hot = { providers: {
      claude: { fetchedAt: now.toISOString(), meters: [track('weekly', 40, 0.4)] },
      copilot: { fetchedAt: now.toISOString(), meters: [track('weekly', 40, 0.1)] },
    } };
    const moved = rank(p, hot, { activity: 'draft_prose', dataTier: 'internal' }, now);
    expect(moved.proseSwitch.on).toBe(false);
    expect(govern(p, 'draft_prose', undefined, undefined, undefined, hot, now).proseSwitches.copilot ?? {}).toMatchObject({ on: true, ahead: 30 });
    expect(moved.blocked.find(b => b.model === 'copilot/claude-opus-5.5')?.why).toBe('Copilot runs 30 points ahead of pace, so prose is off it until the lead falls to 0 points');
    expect(moved.pick).toBe('claude/live');
    const back = { providers: {
      claude: { fetchedAt: now.toISOString(), meters: [track('weekly', 40, 0.4)] },
      copilot: { fetchedAt: now.toISOString(), meters: [track('weekly', 40, 0.4)] },
    } };
    const returned = rank(p, back, { activity: 'draft_prose', dataTier: 'internal' }, now);
    expect(govern(p, 'draft_prose', undefined, undefined, undefined, back, now, { copilot: true }).proseSwitches.copilot?.on).toBe(false);
    expect(returned.blocked.map(b => b.model)).not.toContain('copilot/claude-opus-5.5');
    expect(returned.pick).toBe('copilot/claude-opus-5.5');
    const mid = { providers: {
      claude: { fetchedAt: now.toISOString(), meters: [track('weekly', 40, 0.4)] },
      copilot: { fetchedAt: now.toISOString(), meters: [track('weekly', 45, 0.4)] },
    } };
    expect(govern(p, 'draft_prose', undefined, undefined, undefined, mid, now, { copilot: true }).proseSwitches.copilot?.on).toBe(true);
    expect(govern(p, 'draft_prose', undefined, undefined, undefined, mid, now, false).proseSwitches.copilot?.on).toBe(false);
    expect(govern(p, 'draft_prose', undefined, undefined, undefined, mid, now, true).proseSwitches.copilot?.on).toBe(false);
  });
});
