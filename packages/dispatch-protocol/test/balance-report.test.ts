import { describe, expect, it } from 'vitest';
import { buildPolicyFile, emptyPolicy, importPolicy, fieldPath, setField } from '@augur/core';
import { ACTIVITIES } from '@augur/core';
import { balanceReport, renderReport } from '../src/index.js';

const now = new Date('2026-09-28T12:00:00Z');
const level = Object.fromEntries(ACTIVITIES.map(a => [a, 'normal']));
const RULES = { providers: {
  codex: { defaults: { dataTier: 'sensitive', output: 'write_files', cost: 'moderate' }, models: { 'codex/sol': { id: 'gpt-6.1-sol', rule: { activities: level } }, 'codex/luna': { id: 'gpt-6-luna', rule: { activities: level } } } },
  claude: { defaults: { dataTier: 'regulated', output: 'write_files', cost: 'moderate' }, models: { 'claude/live': { id: 'claude-opus-5-5', rule: { activities: level } } } },
  copilot: { defaults: { dataTier: 'sensitive', output: 'write_files', cost: 'moderate' }, models: { 'copilot/gpt-6-luna': { id: 'gpt-6-luna', rule: { activities: level, useAfter: ['codex/luna'] } } } },
  minimax: { defaults: { dataTier: 'internal', output: 'write_files', cost: 'free' }, models: { 'minimax/m3': { id: 'minimax-m3', rule: { activities: level } } } },
} };
const policy = () => {
  const p = emptyPolicy(); importPolicy(p, RULES, now);
  for (const [id, provider] of Object.entries(p.providers)) for (const label of Object.keys(provider.models)) setField(p, fieldPath(id, label, 'status'), 'confirmed', 'test', now);
  return buildPolicyFile(p, Object.keys(p.providers).map(id => ({ id, name: id, metered: true })), now);
};
const week = { id: 'weekly', usedPct: 60, windowKind: 'weekly', windowSeconds: 604800, resetsAt: new Date(now.getTime() + 302400e3).toISOString() };
const usage = { providers: {
  claude: { fetchedAt: now.toISOString(), meters: [week] },
  copilot: { fetchedAt: now.toISOString(), meters: [], money: [{ id: 'spent', amount: 160 }] },
} };

describe('the balance report', () => {
  const r = balanceReport(policy(), usage, now, { days: 7, picks: 3, jobs: 2, overrides: 1, byActivity: { write_code: { 'claude/live': 2, 'codex/sol': 1 } } });

  it('reads Claude, Copilot, each provider and each kind of work', () => {
    expect(r.claude).toMatchObject({ stance: 'hot', lean: 'Sonnet', peak: 60, atReserve: false });
    expect(r.copilot).toMatchObject({ spend: 160, zone: 'past the aim' });
    expect(Object.fromEntries(r.providers.map(p => [p.id, p.stance]))).toMatchObject({ copilot: 'backup', codex: 'drain', minimax: 'free', claude: 'paced' });
    expect(r.mix).toHaveLength(ACTIVITIES.length);
    expect(r.mix.find(m => m.activity === 'write_code')).toMatchObject({ depth: 'deep' });
    expect(r.excluded).toEqual(['fable', 'astra']);
  });

  it('counts the picks that went to Copilot beside its spend', () => {
    const withCopilot = balanceReport(policy(), usage, now, { days: 7, picks: 4, jobs: 0, overrides: 0, byActivity: { write_code: { 'claude/live': 2, 'copilot/gpt-5': 2 } } });
    expect(renderReport(withCopilot).join(' ')).toContain('2 of those went to Copilot, which stands at $160.00 for the month.');
    expect(renderReport(r).join(' ')).not.toContain('went to Copilot');
  });

  it('renders plain lines with no non-ASCII punctuation', () => {
    const text = renderReport(r).join('\n');
    expect(text).toContain('spend this month: $160.00, past the aim ($150 aim, $250 cap)');
    expect(text).toContain('week: 60% used, 50% of the time gone, 10 points ahead of pace');
    expect(text).toContain('Last 7 days: 3 picks, 2 jobs, 1 ran on a model other than the pick.');
    expect(text).toContain('claude/live 2, codex/sol 1');
    expect(/[^\x00-\x7F]/.test(text)).toBe(false);
  });

  it('says so when the balance is off, and when nothing is known', () => {
    const p = policy(); p.balance = { enabled: false };
    expect(renderReport(balanceReport(p, null, now))[0]).toContain('switched off');
    const none = balanceReport(policy(), null, now);
    expect(none.copilot.zone).toBe('unknown');
    expect(none.claude.stance).toBe('on pace');
  });
});
