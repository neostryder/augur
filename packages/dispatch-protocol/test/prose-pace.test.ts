import { describe, expect, it } from 'vitest';
import { ACTIVITIES, buildPolicyFile, emptyPolicy, fieldPath, importPolicy, setField } from '@augur/core';
import type { PolicyFile } from '@augur/core';
import { NEUTRAL_BALANCE, balanceReport, claudeState, proseSwitchState, rank, renderReport, resolveBalance } from '../src/index.js';

const now = new Date('2026-09-28T12:00:00Z');
const all = Object.fromEntries(ACTIVITIES.map(a => [a, 'normal']));
const model = (id: string) => ({ id, rule: { activities: all } });
const OWNER = { providers: {
  claude: { defaults: { dataTier: 'regulated', output: 'write_files', cost: 'moderate' }, models: { 'claude/live': model('claude-opus-5-5'), 'claude/opus': model('claude-opus-5-5'), 'claude/claude-sonnet-5-5': model('claude-sonnet-5-5') } },
  codex: { defaults: { dataTier: 'sensitive', output: 'write_files', cost: 'moderate' }, models: { 'codex/luna': model('gpt-6-luna') } },
  copilot: { defaults: { dataTier: 'internal', output: 'write_files', cost: 'moderate' }, models: { 'copilot/claude-opus-5.5': model('claude-opus-5.5'), 'copilot/claude-sonnet-5.5': model('claude-sonnet-5.5') } },
  chatgpt: { defaults: { dataTier: 'public', output: 'text_only', cost: 'free' }, models: { 'chatgpt/web': model('latest') } },
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
const usage = (claude: ReturnType<typeof track>[], spend = 40) => ({ providers: {
  claude: { fetchedAt: now.toISOString(), meters: claude },
  copilot: { fetchedAt: now.toISOString(), meters: [], money: [{ id: 'spent', amount: spend, currency: 'USD' }] },
} });
const prose = (u: ReturnType<typeof usage> | null, was = false, p = policy()) => rank(p, u, { activity: 'draft_prose', dataTier: 'internal', proseSwitched: was }, now);
const state = (u: ReturnType<typeof usage>, was = false, rules = resolveBalance(undefined)) => proseSwitchState(rules, claudeState(u, rules, now), was);

describe('the prose pace switch', () => {
  it('asks for a smaller lead the closer Claude is to running out', () => {
    expect(state(usage([track('weekly', 0, 0)])).threshold).toBe(12);
    expect(state(usage([track('weekly', 45, 0.4)])).threshold).toBe(7.5);
    expect(state(usage([track('weekly', 90, 0.8)])).threshold).toBe(3);
    expect(state(usage([track('weekly', 99, 0.8)])).threshold).toBe(3);
  });

  it('stays on Claude on pace, behind pace and a little ahead', () => {
    for (const t of [track('weekly', 40, 0.4), track('weekly', 10, 0.5), track('weekly', 45, 0.4)]) {
      const r = prose(usage([t]));
      expect(r.proseSwitch.on).toBe(false);
      expect(r.pick).toBe('claude/live');
    }
  });

  it('moves prose to Opus through Copilot when the lead passes the threshold', () => {
    const r = prose(usage([track('weekly', 60, 0.4)]));
    expect(r.proseSwitch).toMatchObject({ on: true, ahead: 20 });
    expect(r.pick).toBe('copilot/claude-opus-5.5');
    expect(r.blocked.find(b => b.model === 'claude/live')?.why).toBe('Claude runs 20 points ahead of pace, so prose is off it until the lead falls to 0 points');
    expect(r.ranking.map(x => x.model)).not.toContain('claude/opus');
    expect(r.reason).toContain('Claude runs ahead of pace, so prose goes to Anthropic through Copilot');
  });

  it('needs a smaller lead later in the window than at the start', () => {
    expect(prose(usage([track('weekly', 20, 0.1)])).proseSwitch.on).toBe(false);
    expect(prose(usage([track('weekly', 80, 0.7)])).proseSwitch.on).toBe(true);
  });

  it('holds until Claude is back on its pace marker, and not before', () => {
    const u = usage([track('weekly', 45, 0.4)]);
    expect(prose(u, false).proseSwitch.on).toBe(false);
    expect(prose(u, true).proseSwitch.on).toBe(true);
    expect(prose(u, true).pick).toBe('copilot/claude-opus-5.5');
    const back = usage([track('weekly', 40, 0.4)]);
    expect(prose(back, true).proseSwitch.on).toBe(false);
    expect(prose(back, true).pick).toBe('claude/live');
  });

  it("keeps its last answer when Claude's figures are missing", () => {
    expect(prose(null, true).proseSwitch.on).toBe(true);
    expect(prose(null, false).proseSwitch.on).toBe(false);
  });

  it('moves only prose drafting', () => {
    const u = usage([track('weekly', 60, 0.4)]);
    const code = rank(policy(), u, { activity: 'write_code', dataTier: 'internal', proseSwitched: true }, now);
    expect(code.ranking.map(x => x.model)).toContain('claude/live');
  });

  it('runs a Claude route the person named', () => {
    const r = rank(policy(), usage([track('weekly', 60, 0.4)]), { activity: 'draft_prose', dataTier: 'internal', named: 'claude/live' }, now);
    expect(r.ranking.map(x => x.model)).toContain('claude/live');
  });

  it('never falls to Sonnet: at the Copilot cap prose goes to the next route and says why', () => {
    const r = prose(usage([track('weekly', 60, 0.4)], 260));
    expect(r.pick).not.toMatch(/sonnet/);
    expect(r.ranking.map(x => x.model)).not.toContain('copilot/claude-opus-5.5');
    expect(r.notes.join(' ')).toContain('Prose has moved off Claude. Copilot spend is $260.00, at the $250 cap, so it goes to the next route.');
  });

  it('leaves Claude in place when no other route can take the prose', () => {
    const alone = policy();
    for (const p of ['codex', 'copilot', 'chatgpt']) delete alone.providers[p];
    expect(prose(usage([track('weekly', 60, 0.4)]), false, alone).ranking.map(x => x.model)).toContain('claude/live');
  });

  it('can be turned off, tuned, and is inert with no prose routes', () => {
    const u = usage([track('weekly', 60, 0.4)]);
    for (const rules of [{ prose: { pace: { enabled: false } } }, { prose: { pace: { ahead: 30, aheadAtReserve: 25 } } }, { profile: 'neutral' }]) {
      const r = prose(u, false, policy(rules));
      expect(r.proseSwitch.on).toBe(false);
      expect(r.ranking.map(x => x.model)).toContain('claude/live');
    }
    expect(resolveBalance({ prose: { pace: { returnAt: 2, ahead: -4 } } }).prose.pace).toMatchObject({ returnAt: 2, ahead: 12 });
    expect(NEUTRAL_BALANCE.prose.models).toEqual([]);
  });

  it('calls a window at 99% or more spent in the report and the reasons', () => {
    const text = renderReport(balanceReport(policy(), usage([track('weekly', 100, 0.8)]), now)).join('\n');
    expect(text).toContain('week: 100% used, 80% of the time gone, spent');
    expect(text).not.toContain('ahead of pace');
  });

  it('shows in the balance report', () => {
    const on = renderReport(balanceReport(policy(), usage([track('weekly', 60, 0.4)]), now, null, 'internal', false)).join('\n');
    expect(on).toContain('prose: moved off Claude (20 points ahead of pace); it comes back when the lead falls to 0 points');
    const off = renderReport(balanceReport(policy(), usage([track('weekly', 40, 0.4)]), now)).join('\n');
    expect(off).toContain('prose: stays on Claude; it moves when the lead passes 8 points');
  });
});
