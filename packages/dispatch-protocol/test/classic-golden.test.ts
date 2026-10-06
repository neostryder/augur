import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACTIVITIES, buildPolicyFile, emptyPolicy, fieldPath, importPolicy, setField } from '@augur/core';
import type { PolicyFile } from '@augur/core';
import { rank } from '../src/index.js';

// An install that names no profile keeps resolving to the rules it had before profiles existed. This replays a real model set (the owner's labels and ids)
// through the pick under every Claude stance and Copilot spend zone, and compares every ranking, block, reason, note and seat with a frozen copy.
// UPDATE_GOLDEN=1 rewrites the fixture; do that only for a change that is meant to alter what such an install picks, and say so in the changelog.
const update = process.env.UPDATE_GOLDEN === '1';
const fixture = new URL('./fixtures/classic-picks.json', import.meta.url);
const now = new Date('2026-09-28T12:00:00Z');
const all = Object.fromEntries(ACTIVITIES.map(a => [a, 'normal']));
const model = (id: string, extra: object = {}) => ({ id, rule: { activities: all, ...extra } });
const OWNER = { providers: {
  claude: { defaults: { dataTier: 'regulated', output: 'write_files', cost: 'moderate' }, models: { 'claude/live': model('claude-opus-5-5'), 'claude/opus': model('claude-opus-5-5'), 'claude/claude-sonnet-5-5': model('claude-sonnet-5-5'), 'claude/fable': model('claude-fable-5-1', { askFirst: true }) } },
  codex: { defaults: { dataTier: 'sensitive', output: 'write_files', cost: 'moderate' }, models: { 'codex/sol': model('gpt-6.1-sol'), 'codex/luna': model('gpt-6-luna'), 'codex/astra': model('gpt-6-astra', { askFirst: true }) } },
  grok: { defaults: { dataTier: 'internal', output: 'write_files', cost: 'moderate' }, models: { 'xai/grok': model('grok-4.7') } },
  minimax: { defaults: { dataTier: 'public', output: 'text_only', cost: 'cheap' }, models: { 'minimax/m3': model('MiniMax-M3') } },
  openrouter: { defaults: { dataTier: 'public', output: 'text_only', cost: 'cheap' }, models: { 'deepseek/v4.1-flash': model('deepseek/deepseek-v4.1-flash') } },
  jev: { defaults: { dataTier: 'regulated', output: 'text_only', cost: 'cheap' }, models: { 'jev/jev-latest': model('jev-latest') } },
  copilot: { defaults: { dataTier: 'internal', output: 'write_files', cost: 'moderate' }, models: {
    'copilot/claude-opus-5.5': model('claude-opus-5.5'), 'copilot/claude-sonnet-5.5': model('claude-sonnet-5.5'), 'copilot/gpt-6-luna': model('gpt-6-luna'),
    'copilot/gemini-3.8-flash': model('gemini-3.8-flash'), 'copilot/grok-4.7': model('grok-4.7'), 'copilot/gpt-6.1-sol': model('gpt-6.1-sol') } },
  gemini: { defaults: { dataTier: 'public', output: 'text_only', cost: 'free' }, models: { 'gemini/web': model('gemini-web') } },
  chatgpt: { defaults: { dataTier: 'public', output: 'text_only', cost: 'free' }, models: { 'chatgpt/web': model('latest') } },
  laya: { defaults: { dataTier: 'regulated', output: 'text_only', cost: 'free' }, models: { 'laya/laya': model('laya') } },
} };

function policy(balance?: Record<string, unknown>): PolicyFile {
  const p = emptyPolicy(); importPolicy(p, OWNER, now);
  for (const [id, provider] of Object.entries(p.providers)) for (const label of Object.keys(provider.models)) setField(p, fieldPath(id, label, 'status'), 'confirmed', 'test', now);
  if (balance) p.balance = balance;
  return buildPolicyFile(p, Object.keys(p.providers).map(id => ({ id, name: id, metered: true })), now);
}

const HOUR = 3600e3, WEEK = 7 * 24 * HOUR;
const track = (kind: 'session' | 'weekly', used: number, elapsed: number) => {
  const seconds = kind === 'weekly' ? WEEK / 1000 : 5 * HOUR / 1000;
  return { id: kind, label: kind, usedPct: used, windowKind: kind, windowSeconds: seconds, resetsAt: new Date(now.getTime() + (1 - elapsed) * seconds * 1000).toISOString() };
};
const scenario = (claude: ReturnType<typeof track>[] | 'stale', spend: number) => ({ providers: {
  claude: { fetchedAt: claude === 'stale' ? new Date(now.getTime() - 3 * HOUR).toISOString() : now.toISOString(), meters: claude === 'stale' ? [track('weekly', 40, 0.4)] : claude },
  codex: { fetchedAt: now.toISOString(), meters: [track('weekly', 40, 0.4)] },
  copilot: { fetchedAt: now.toISOString(), meters: [], money: [{ id: 'spent', amount: spend, currency: 'USD' }] },
} });
const SCENARIOS: Record<string, ReturnType<typeof scenario> | null> = {
  none: null,
  onPace: scenario([track('weekly', 40, 0.4), track('session', 40, 0.4)], 40),
  hot: scenario([track('weekly', 70, 0.4), track('session', 60, 0.4)], 40),
  behind: scenario([track('weekly', 10, 0.5), track('session', 10, 0.5)], 40),
  reserve: scenario([track('weekly', 92, 0.9), track('session', 40, 0.4)], 40),
  stale: scenario('stale', 40),
  copilotAim: scenario([track('weekly', 40, 0.4)], 160),
  copilotCap: scenario([track('weekly', 40, 0.4)], 260),
  claudeAtReserveCopilotCap: scenario([track('weekly', 92, 0.9)], 260),
};

function replay(profile?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const p = policy(profile);
  for (const [name, usage] of Object.entries(SCENARIOS)) {
    for (const activity of ACTIVITIES) for (const depth of [undefined, 'deep', 'everyday'] as const) {
      const r = rank(p, usage, { activity, dataTier: 'public', depth }, now);
      // The blocked list, notes and seats are long, so the fixture keeps their hash; the ranking and the reason line stay readable for a diff.
      const rest = createHash('sha1').update(JSON.stringify([r.blocked, r.notes, r.seats, r.depth])).digest('hex').slice(0, 12);
      out[`${name}/${activity}/${depth ?? 'default'}`] = { ranking: r.ranking.map(x => [x.model, x.score, x.tilt]), blocked: r.blocked.map(b => b.model), reason: r.reason, rest };
    }
  }
  return out;
}

describe('an install that names no profile', () => {
  it('picks exactly what it picked before profiles existed', () => {
    const now = JSON.parse(JSON.stringify(replay()));
    if (update || !existsSync(fixture)) writeFileSync(fixture, JSON.stringify(now, null, 1) + '\n');
    expect(now, 'the classic picks changed; if that is intended, rewrite the fixture with UPDATE_GOLDEN=1 and say so in the changelog').toEqual(JSON.parse(readFileSync(fixture, 'utf8')));
  });

  it('picks the same when the profile is named classic', () => {
    expect(JSON.parse(JSON.stringify(replay({ profile: 'classic' })))).toEqual(JSON.parse(readFileSync(fixture, 'utf8')));
  });
});
