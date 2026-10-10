import { describe, expect, it } from 'vitest';
import { buildPolicyFile, emptyPolicy, importPolicy, fieldPath, setField } from '@augur/core';
import { ACTIVITIES } from '@augur/core';
import { balanceReport, renderReport, reportSections } from '../src/index.js';
import type { UsageMeter } from '../src/index.js';

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

  it('lists each Copilot pick with the month at the time and says when it was past the aim', () => {
    const list = [{ at: '2026-10-04T12:30:00.000Z', activity: 'write_code', model: 'copilot/gpt-5', spend: 120 }, { at: '2026-10-05T01:05:00.000Z', activity: 'research', model: 'copilot/gpt-5', spend: 160 }];
    const text = renderReport(balanceReport(policy(), usage, now, { days: 7, picks: 2, jobs: 0, overrides: 0, byActivity: { write_code: { 'copilot/gpt-5': 2 } }, copilot: list })).join(' ');
    expect(text).toContain('2026-10-04 12:30 UTC write_code on copilot/gpt-5, month at $120.00 ');
    expect(text).toContain('2026-10-05 01:05 UTC research on copilot/gpt-5, month at $160.00, past the aim');
  });

  it('renders plain lines with no non-ASCII punctuation', () => {
    const text = renderReport(r).join('\n');
    expect(text).toContain('spend this month: $160.00, past the aim ($150 aim, $250 cap)');
    expect(text).toContain('week: 60% used, 50% of the week gone, 10 points ahead of pace');
    expect(text).toContain('stance: hot, leaning to Sonnet');
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

  it('gives the only paced provider its own section and names the rest once', () => {
    const sections = reportSections(r);
    const head = sections[0];
    const claude = r.pace.find(row => row.provider === 'claude');
    expect(r.pace.map(row => row.provider)).toEqual(['claude']);
    expect(claude).toMatchObject({ stance: 'hot', boost: 1, boostWhy: '' });
    expect(claude?.odds).toEqual(expect.any(Number));
    expect(head?.title).toBe('claude');
    expect(head?.lines[0]).toMatch(/^stance: hot, leaning to Sonnet\. The band is \d+ points? and the reserve is \d+%/);
    expect(head?.lines).toContain('week: 60% used, 50% of the week gone, 10 points ahead of pace');
    expect(head?.lines).toContain(`odds: ${Math.round((claude?.odds ?? 0) * 100)}%`);
    expect(head?.lines).toContain('prose: moved off Claude (10 points ahead of pace); it comes back when the lead falls to 0 points');
    expect(head?.lines.some(l => l.startsWith('boost:'))).toBe(false);
    expect(sections.map(s => s.title)).not.toContain('On pace');
    expect(sections.find(s => s.title === 'Not paced')?.lines).toEqual(['codex, copilot, minimax.']);
    expect(r.claude).toMatchObject({ stance: 'hot', lean: 'Sonnet', peak: 60, atReserve: false });
  });

  it('prints both windows on an attention row', () => {
    const session = { id: 'session', usedPct: 20, windowKind: 'session', windowSeconds: 18000, resetsAt: new Date(now.getTime() + 0.7 * 18000e3).toISOString() };
    const lines = reportSections(balanceReport(policy(), { providers: { claude: { fetchedAt: now.toISOString(), meters: [week, session] } } }, now))[0]?.lines ?? [];
    expect(lines).toContain('week: 60% used, 50% of the week gone, 10 points ahead of pace');
    expect(lines).toContain('5-hour window: 20% used, 30% of the 5-hour window gone, 10 points behind pace');
  });
});

describe('pace rows in the balance report', () => {
  const owned = (id: string, activities: Record<string, string>) => ({ defaults: { dataTier: 'internal', output: 'write_files', cost: 'moderate' }, models: { [`${id}/m`]: { id: `${id}-m`, rule: { activities } } } });
  const owners = {
    quiet: owned('quiet', { research: 'normal' }),
    hot: owned('hot', level),
    mystery: owned('mystery', level),
    'behind-high': owned('behind-high', level),
    'behind-low': owned('behind-low', level),
    'calm-a': owned('calm-a', level),
    'calm-b': owned('calm-b', level),
    idle: owned('idle', level),
    later: owned('later', level),
  };
  const names: Record<string, string> = { quiet: 'Quiet', hot: 'Hot', mystery: 'Mystery', 'behind-high': 'BehindHigh', 'behind-low': 'BehindLow', 'calm-a': 'CalmA', 'calm-b': 'CalmB', idle: 'Idle', later: 'Later' };
  const meter = (used: number, elapsed: number, kind: 'weekly' | 'session' = 'weekly') => {
    const seconds = kind === 'weekly' ? 604800 : 18000;
    return { id: kind, usedPct: used, windowKind: kind, windowSeconds: seconds, resetsAt: new Date(now.getTime() + (1 - elapsed) * seconds * 1000).toISOString() };
  };
  const entry = (meters: UsageMeter[]) => ({ fetchedAt: now.toISOString(), meters });
  const p = (() => {
    const built = emptyPolicy(); importPolicy(built, { providers: owners }, now);
    for (const [id, provider] of Object.entries(built.providers)) for (const label of Object.keys(provider.models)) setField(built, fieldPath(id, label, 'status'), 'confirmed', 'test', now);
    return buildPolicyFile(built, Object.keys(built.providers).map(id => ({ id, name: names[id] ?? id, metered: true })), now);
  })();
  const usage = { providers: {
    quiet: entry([meter(95, 0.4)]),
    hot: entry([meter(60, 0.3), meter(20, 0.3, 'session')]),
    mystery: entry([{ id: 'weekly', usedPct: 70, windowKind: 'weekly' }]),
    'behind-high': entry([meter(40, 0.8)]),
    'behind-low': entry([meter(10, 0.8)]),
    'calm-a': entry([meter(50, 0.5)]),
    'calm-b': entry([meter(20, 0.2)]),
  } };
  const report = balanceReport(p, usage, now);
  const sections = reportSections(report);

  it('orders attention first, hot then unknown then behind, and breaks ties by used percent', () => {
    expect(report.pace.map(row => [row.provider, row.stance, row.peak])).toEqual([
      ['quiet', 'hot', 95],
      ['hot', 'hot', 60],
      ['mystery', 'unknown', 70],
      ['behind-high', 'behind', 40],
      ['behind-low', 'behind', 10],
      ['calm-a', 'on pace', 50],
      ['calm-b', 'on pace', 20],
    ]);
    expect(sections.map(s => s.title).slice(0, 7)).toEqual(['Quiet', 'Hot', 'Mystery', 'BehindHigh', 'BehindLow', 'On pace', 'Not paced']);
  });

  it('prints stance, both windows, the boost when it is above 1, and odds', () => {
    expect(sections.find(s => s.title === 'Quiet')?.lines).toEqual([expect.stringMatching(/^stance: hot\. The band is/), 'week: 95% used, 40% of the week gone, 55 points ahead of pace', 'odds: none']);
    expect(sections.find(s => s.title === 'Hot')?.lines).toEqual([
      expect.stringMatching(/^stance: hot\. The band is/),
      'week: 60% used, 30% of the week gone, 30 points ahead of pace',
      '5-hour window: 20% used, 30% of the 5-hour window gone, 10 points behind pace',
      expect.stringMatching(/^odds: \d+%$/),
    ]);
    expect(sections.find(s => s.title === 'Mystery')?.lines[0]).toMatch(/^stance: unknown\. The band is/);
    expect(sections.find(s => s.title === 'BehindLow')?.lines.slice(0, 3)).toEqual([expect.stringMatching(/^stance: behind\. The band is/), 'week: 10% used, 80% of the week gone, 70 points behind pace', 'boost: 1.45x']);
    expect(report.pace.find(row => row.provider === 'behind-low')).toMatchObject({ boost: 1.45 });
    expect(report.pace.find(row => row.provider === 'behind-low')?.boostWhy).toMatch(/1\.45x/);
    expect(report.pace.find(row => row.provider === 'quiet')).toMatchObject({ odds: null, boost: 1, boostWhy: '' });
    expect(report.pace.find(row => row.provider === 'hot')?.odds).toEqual(expect.any(Number));
  });

  it('folds calm providers under one group and names providers with no window once', () => {
    expect(sections.map(s => s.title)).not.toContain('CalmA');
    expect(sections.find(s => s.title === 'On pace')?.lines).toEqual([
      'CalmA, week 50% used, boost 1.25x, odds ' + Math.round((report.pace.find(row => row.provider === 'calm-a')?.odds ?? 0) * 100) + '%',
      'CalmB, week 20% used, boost 1.4x, odds ' + Math.round((report.pace.find(row => row.provider === 'calm-b')?.odds ?? 0) * 100) + '%',
    ]);
    expect(sections.find(s => s.title === 'Not paced')?.lines).toEqual(['Idle, Later.']);
    expect(report.pace.map(row => row.provider)).not.toContain('idle');
  });
});
