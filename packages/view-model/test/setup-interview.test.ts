import { describe, expect, it } from 'vitest';
import { applyEdit, migratePolicy, resolveModel } from '@augur/core';
import type { PolicyConfig } from '@augur/core';
import type { UsageSnapshot } from '@augur/dispatch-protocol';
import classic from '../../dispatch-protocol/test/fixtures/classic-balance.json' with { type: 'json' };
import { HOLD_BACK, SETUP_STEPS, afterApply, answersFromCurrent, answersFromProfile, applySteps, emptyAnswers, holdBackOf, isValid, modelsSection, paceNumbers, planProfileFile, planSetup, problems, someBand, stepStatus, summaryLines, useAfterFromRank } from '../src/index.js';
import type { DetectedProvider, SetupAnswers, SetupCurrent, SetupPlan, Strength } from '../src/index.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');

const det = (id: string, over: Partial<DetectedProvider> = {}): DetectedProvider => ({
  id, label: id.slice(0, 1).toUpperCase() + id.slice(1), hasWindow: true, found: true, confirmed: true, ...over,
});

function policyOf(groups: Record<string, readonly (string | { label: string; useAfter?: string[]; status?: string })[]>, balance: unknown): PolicyConfig {
  const providers: Record<string, unknown> = {};
  for (const [id, models] of Object.entries(groups)) {
    const map: Record<string, unknown> = {};
    for (const item of models) {
      const label = typeof item === 'string' ? item : item.label;
      const status = typeof item === 'string' ? 'confirmed' : item.status ?? 'confirmed';
      const useAfter = typeof item === 'string' ? undefined : item.useAfter;
      map[label] = {
        id: label.slice(label.indexOf('/') + 1), source: 'manual', status, firstSeen: '2026-01-01T00:00:00.000Z',
        rule: { dataTier: 'sensitive', askFirst: true, ...(useAfter ? { useAfter } : {}) },
      };
    }
    providers[id] = { defaults: { dataTier: 'sensitive', askFirst: true }, models: map };
  }
  return migratePolicy({ providers, balance });
}

function week(ids: readonly string[]): UsageSnapshot {
  return { providers: Object.fromEntries(ids.map(id => [id, { meters: [{ id: 'week', usedPct: 10, windowKind: 'weekly' }] }])) };
}

const currentOf = (policy: PolicyConfig, routes: SetupCurrent['routes'] = [], usage: UsageSnapshot | null = null): SetupCurrent => ({ policy, routes, usage });

/** Rows that would write. An untouched plan has none. */
function written(plan: SetupPlan): Array<{ id: string; status: string; field?: string }> {
  return plan.changes.filter(c => c.status !== 'unchanged' || c.edit).map(c => ({ id: c.id, status: c.status, ...(c.edit ? { field: c.edit.field } : {}) }));
}

function accessOf(policy: PolicyConfig): Record<string, { dataTier: string; askFirst: boolean }> {
  const out: Record<string, { dataTier: string; askFirst: boolean }> = {};
  for (const [pid, p] of Object.entries(policy.providers)) {
    for (const [label, m] of Object.entries(p.models)) {
      const r = resolveModel(pid, p.defaults, m);
      out[label] = { dataTier: r.dataTier, askFirst: r.askFirst };
      out[`rule:${label}`] = { dataTier: m.rule.dataTier ?? '', askFirst: m.rule.askFirst ?? false };
    }
    out[`defaults:${pid}`] = { dataTier: p.defaults.dataTier ?? '', askFirst: p.defaults.askFirst ?? false };
  }
  return out;
}

const providerOf = (label: string): string => {
  const prefix = label.slice(0, label.indexOf('/'));
  return prefix === 'xai' ? 'grok' : prefix;
};

describe('starting answers', () => {
  it('starts Claude only on Claude, held back some, with no backup spend', () => {
    expect(emptyAnswers('claude-only')).toEqual({
      stack: 'claude-only',
      detected: [{ id: 'claude', label: 'Claude', hasWindow: true, found: true, confirmed: true }],
      added: [],
      holdBack: { claude: 'some' },
      rank: ['claude'],
      payPerUse: { providers: [], amount: null },
      strengths: {},
      prose: null,
      seatsSecond: null,
    });
  });

  it('starts Several on every confirmed subscription that has a window, in the order given', () => {
    const detected = [det('codex'), det('claude'), det('copilot', { hasWindow: false }), det('grok', { confirmed: false }), det('minimax', { found: false })];
    const answers = emptyAnswers('several', detected);
    expect(answers.rank).toEqual(['codex', 'claude']);
    expect(answers.holdBack).toEqual({ codex: 'some', claude: 'some' });
    expect(answers.payPerUse).toEqual({ providers: [], amount: null });
    expect(answers.detected).toEqual(detected);
    expect(answers.stack).toBe('several');
  });

  it('starts API keys only with nothing paced and the spend still unanswered', () => {
    const answers = emptyAnswers('api-only', [det('claude')]);
    expect(answers.holdBack).toEqual({});
    expect(answers.rank).toEqual([]);
    expect(answers.payPerUse).toBeNull();
    expect(answers.detected).toEqual([det('claude')]);
    expect(emptyAnswers('api-only').detected).toEqual([]);
  });
});

describe('hold-back mapping', () => {
  it('maps the three choices, with band 5 for Claude on some', () => {
    expect(HOLD_BACK.free).toMatchObject({ reserve: 100, band: 20 });
    expect(HOLD_BACK.some).toMatchObject({ reserve: 90, band: 10, claudeBand: 5 });
    expect(HOLD_BACK.save).toMatchObject({ reserve: 60, band: 5 });
    expect(HOLD_BACK.free.text.length).toBeGreaterThan(0);
    expect(HOLD_BACK.some.text.length).toBeGreaterThan(0);
    expect(HOLD_BACK.save.text.length).toBeGreaterThan(0);
    expect(someBand('claude')).toBe(5);
    expect(someBand('grok')).toBe(10);
    expect(paceNumbers('some', 'claude')).toEqual({ reserve: 90, band: 5 });
    expect(paceNumbers('some', 'codex')).toEqual({ reserve: 90, band: 10 });
    expect(paceNumbers('free', 'claude')).toEqual({ reserve: 100, band: 20 });
    expect(paceNumbers('save', 'minimax')).toEqual({ reserve: 60, band: 5 });
  });

  it('reads a pace back as the nearest choice, and custom when neither number is close', () => {
    expect(holdBackOf({ reserve: 100, band: 20 })).toBe('free');
    expect(holdBackOf({ reserve: 90, band: 10 })).toBe('some');
    expect(holdBackOf({ reserve: 90, band: 5, provider: 'claude' })).toBe('some');
    expect(holdBackOf({ reserve: 90, band: 5 })).toBe('custom');
    expect(holdBackOf({ reserve: 90, band: 5, provider: 'grok' })).toBe('custom');
    expect(holdBackOf({ reserve: 60, band: 5 })).toBe('save');
    expect(holdBackOf({ reserve: 75, band: 5, provider: 'grok' })).toBe('custom');
    expect(holdBackOf({ reserve: 92, band: 12, provider: 'grok' })).toBe('some');
    expect(holdBackOf({ reserve: 98, band: 18, provider: 'claude' })).toBe('free');
  });
});

describe('rank to useAfter', () => {
  const models = {
    claude: ['claude/opus', 'claude/haiku'],
    copilot: ['copilot/gpt'],
    codex: ['codex/sol'],
    grok: ['xai/grok'],
  };

  it('waits on the nearest subscription above that has a window, and gives the first one none', () => {
    const hasWindow = (id: string): boolean => id !== 'copilot';
    expect(useAfterFromRank(['claude', 'copilot', 'codex'], models, hasWindow)).toEqual({
      claude: [],
      copilot: [],
      codex: ['claude/haiku', 'claude/opus'],
    });
    expect(useAfterFromRank(['grok'], models, () => true)).toEqual({ grok: [] });
    expect(useAfterFromRank(['grok', 'claude', 'codex'], models, () => true).grok).toEqual([]);
    expect(useAfterFromRank(['grok', 'claude', 'codex'], models, () => true).claude).toEqual(['xai/grok']);
  });
});

describe('step status', () => {
  it('marks a fresh Claude-only interview ready through pace, and done only after review', () => {
    const answers = emptyAnswers('claude-only');
    expect(stepStatus(answers, 'stack')).toBe('ready');
    expect(stepStatus(answers, 'providers')).toBe('ready');
    expect(stepStatus(answers, 'pace')).toBe('ready');
    expect(stepStatus(answers, 'review')).toBe('todo');
    expect(stepStatus(answers, 'done')).toBe('partial');
    const reviewed: SetupAnswers = { ...answers, prose: 'skipped', seatsSecond: 'skipped' };
    expect(stepStatus(reviewed, 'review')).toBe('ready');
    expect(stepStatus(reviewed, 'done')).toBe('ready');
  });

  it('keeps providers open while one detected subscription is unconfirmed', () => {
    const answers = emptyAnswers('several', [det('claude'), det('codex', { confirmed: false })]);
    expect(stepStatus(answers, 'providers')).toBe('partial');
  });

  it('leaves the API-keys pace step open until a spend is chosen', () => {
    const answers = emptyAnswers('api-only');
    expect(stepStatus(answers, 'providers')).toBe('partial');
    expect(stepStatus(answers, 'pace')).toBe('partial');
    expect(stepStatus(answers, 'review')).toBe('todo');
  });
});

describe('the plan', () => {
  it('marks a stored default as unchanged, a stored difference as a change, a missing pace as new, and custom as kept', () => {
    const stored = policyOf({ claude: ['claude/opus'] }, { profile: 'neutral', pace: { claude: { reserve: 90, band: 5 } } });
    const current = currentOf(stored, [], week(['claude']));
    const answers = answersFromCurrent(current);
    expect(answers.holdBack.claude).toBe('some');
    expect(written(planSetup(answers, current))).toEqual([]);

    const free = planSetup({ ...answers, holdBack: { claude: 'free' } }, current);
    expect(free.changes.find(c => c.id === 'pace:claude:reserve')).toMatchObject({ status: 'change', to: '100%', edit: { field: 'balance:pace|claude|reserve', value: 100 } });
    expect(free.changes.find(c => c.id === 'pace:claude:band')).toMatchObject({ status: 'change', to: '20', edit: { field: 'balance:pace|claude|band', value: 20 } });
    expect(summaryLines(free).find(g => g.step === 'pace')!.lines[0]).toBe('Claude first.');
    expect(summaryLines(free).map(g => g.step)).toEqual(SETUP_STEPS.map(s => s.id));

    const fresh = policyOf({ grok: ['xai/grok'] }, { profile: 'neutral' });
    const freshCurrent = currentOf(fresh, [], week(['grok']));
    const save = planSetup({ ...answersFromCurrent(freshCurrent), holdBack: { grok: 'save' } }, freshCurrent);
    expect(save.changes.find(c => c.id === 'pace:grok:reserve')).toMatchObject({ status: 'new', edit: { field: 'balance:pace|grok|reserve', value: 60 } });
    expect(save.changes.find(c => c.id === 'pace:grok:band')).toMatchObject({ status: 'new', edit: { value: 5 } });

    const customPolicy = policyOf({ grok: ['xai/grok'] }, { profile: 'neutral', pace: { grok: { reserve: 75, band: 5 } } });
    const customCurrent = currentOf(customPolicy, [], week(['grok']));
    const customAnswers = answersFromCurrent(customCurrent);
    expect(customAnswers.holdBack.grok).toBe('custom');
    const custom = planSetup(customAnswers, customCurrent);
    expect(custom.changes.find(c => c.id === 'pace:grok')).toMatchObject({ status: 'unchanged', to: 'custom, kept as it is', edit: null });
    expect(written(custom)).toEqual([]);
  });

  it('orders the operations an app runs, and refuses a bad spend or a repeated rank', () => {
    const policy = policyOf({ claude: ['claude/opus'], codex: ['codex/sol'], grok: ['xai/grok'] }, { profile: 'neutral' });
    const current = currentOf(policy, [], week(['claude', 'codex', 'grok']));
    const start = answersFromCurrent(current);
    const answers: SetupAnswers = {
      ...start,
      rank: ['claude', 'codex'],
      holdBack: { claude: 'free', codex: 'save', grok: 'some' },
      payPerUse: { providers: ['openai'], amount: 40 },
      strengths: { ...start.strengths, 'claude/opus': 'light', 'codex/sol': 'strong' },
      prose: ['claude/opus'],
      seatsSecond: ['codex/sol'],
    };
    const plan = planSetup(answers, current);
    expect(isValid(plan)).toBe(true);
    const ops = applySteps(plan);
    expect(ops.map(op => op.name)).toEqual(ops.map(() => 'policy-edit'));
    expect(ops.map(op => op.payload.id)).toEqual([
      'pace:claude:reserve', 'pace:codex:reserve', 'pace:claude:band', 'pace:codex:band',
      'use-after:codex/sol', 'fallback:providers', 'fallback:aim',
      'tier:claude/opus', 'tier:codex/sol', 'prose:models', 'seats:second',
    ]);
    expect(ops.every(op => op.payload.by === 'setup interview' && op.payload.at === '')).toBe(true);

    const negative = planSetup({ ...start, payPerUse: { providers: ['openai'], amount: -3 } }, current);
    expect(isValid(negative)).toBe(false);
    expect(problems(negative).join(' ')).toContain('monthly amount');
    expect(negative.changes.some(c => c.id.startsWith('fallback'))).toBe(false);

    const unnamed = planSetup({ ...start, payPerUse: { providers: ['openai'], amount: null } }, current);
    expect(isValid(unnamed)).toBe(false);
    expect(problems(unnamed)).toContain('Enter a monthly amount for pay per use, or choose No backup spending.');
    expect(applySteps(unnamed).some(op => op.payload.field.startsWith('balance:fallback'))).toBe(false);

    const twice = planSetup({ ...start, rank: ['claude', 'claude'] }, current);
    expect(isValid(twice)).toBe(false);
    expect(problems(twice)).toContain('A subscription is listed twice in the order. Remove one of them.');
  });

  it('names routes that have a key and models that still need confirmation', () => {
    const policy = policyOf({
      claude: ['claude/opus', { label: 'claude/haiku', status: 'unreviewed' }, { label: 'claude/sonnet', status: 'imported' }],
      codex: [{ label: 'codex/sol', status: 'hidden' }],
    }, { profile: 'neutral' });
    const current = currentOf(policy, [
      { name: 'opus', model: 'claude/opus', hasKey: true },
      { name: 'bare', model: 'codex/sol', hasKey: false },
    ]);
    const done = afterApply(planSetup(answersFromCurrent(current), current));
    expect(done.routesToTest).toEqual(['opus']);
    expect(done.unreviewed).toEqual(['claude/haiku', 'claude/sonnet']);
    expect(done.next).toEqual([
      'Test each route that has a key.',
      'Confirm any model listed under Still to confirm on the Rules page. No agent can run it until you do.',
      'Augur now uses your subscriptions in the order you set, and holds each one back the way you chose.',
    ]);
  });
});

describe('guarantees', () => {
  /** Every field the interview is allowed to write. dataTier and askFirst are absent on purpose. */
  const ALLOWED = new Set(['useAfter', 'balance:fallback|providers', 'balance:fallback|aim', 'balance:prose|models', 'balance:seats|second|models']);
  const allowed = (field: string): boolean => ALLOWED.has(field) || /^balance:pace\|[a-z0-9_-]+\|(reserve|band)$/.test(field) || field.startsWith('balance:tiers|');

  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 4294967296; };
  }

  it('never widens a data tier or turns ask-first off, over many answer sets', () => {
    const rand = rng(0x0e11);
    const ids = ['claude', 'codex', 'grok', 'minimax'] as const;
    const labels = ['claude/opus', 'claude/haiku', 'codex/sol', 'xai/grok', 'minimax/m3'];
    const policy = policyOf({ claude: ['claude/opus', 'claude/haiku'], codex: ['codex/sol'], grok: ['xai/grok'], minimax: ['minimax/m3'] }, { profile: 'neutral' });
    const before = accessOf(policy);
    const current = currentOf(policy, [], week(ids));
    const choices = ['free', 'some', 'save', 'custom'] as const;
    const stacks = ['claude-only', 'several', 'api-only', 'profile'] as const;
    const strengths: Strength[] = ['strong', 'light', 'unsure'];
    for (let n = 0; n < 40; n++) {
      const holdBack: SetupAnswers['holdBack'] = {};
      for (const id of ids) if (rand() < 0.8) holdBack[id] = choices[Math.floor(rand() * choices.length)]!;
      const rank: string[] = [];
      if (rand() < 0.75) {
        const bag = [...ids];
        const count = 1 + Math.floor(rand() * ids.length);
        for (let i = 0; i < count; i++) rank.push(bag.splice(Math.floor(rand() * bag.length), 1)[0]!);
        if (rand() < 0.15) rank.push(rank[0]!);
      }
      const roll = rand();
      const payPerUse: SetupAnswers['payPerUse'] = roll < 0.35 ? { providers: [], amount: null }
        : roll < 0.7 ? { providers: ['openai'], amount: Math.floor(rand() * 200) }
          : roll < 0.85 ? { providers: ['openai'], amount: null }
            : roll < 0.95 ? null : { providers: ['openai'], amount: -5 };
      const picked: SetupAnswers['strengths'] = {};
      for (const label of labels) if (rand() < 0.7) picked[label] = strengths[Math.floor(rand() * strengths.length)]!;
      const list = (): string[] | 'skipped' | null => {
        const r = rand();
        if (r < 0.34) return null;
        if (r < 0.5) return 'skipped';
        return r < 0.75 ? [] : [labels[Math.floor(rand() * labels.length)]!];
      };
      const answers: SetupAnswers = {
        stack: stacks[Math.floor(rand() * stacks.length)]!,
        detected: ids.map(id => det(id, { hasWindow: rand() < 0.8, confirmed: rand() < 0.85 })),
        added: rand() < 0.3 ? ['openai'] : [],
        holdBack, rank, payPerUse, strengths: picked, prose: list(), seatsSecond: list(),
      };
      const plan = planSetup(answers, current);
      for (const change of plan.changes) {
        if (!change.edit) continue;
        expect(allowed(change.edit.field), `${n} ${change.edit.field}`).toBe(true);
        expect(change.edit.field === 'dataTier' || change.edit.field === 'askFirst').toBe(false);
      }
      const next = structuredClone(policy);
      for (const op of applySteps(plan)) {
        expect(op.name).toBe('policy-edit');
        expect(allowed(op.payload.field), op.payload.field).toBe(true);
        applyEdit(next, op.payload, 'test', NOW);
      }
      expect(accessOf(next)).toEqual(before);
    }
  });

  it('writes nothing when the answers are the ones just read back', () => {
    const neutral = policyOf({}, { profile: 'neutral' });
    const neutralCurrent = currentOf(neutral);
    expect(written(planSetup(answersFromCurrent(neutralCurrent), neutralCurrent))).toEqual([]);

    const groups: Record<string, string[]> = {};
    for (const label of Object.keys(classic.tiers)) (groups[providerOf(label)] ??= []).push(label);
    const classicPolicy = policyOf(groups, structuredClone(classic));
    const classicCurrent = currentOf(classicPolicy, [{ name: 'opus', model: 'claude/opus', hasKey: true }]);
    const classicAnswers = answersFromCurrent(classicCurrent);
    expect(classicAnswers.holdBack.claude).toBe('some');
    expect(classicAnswers.rank).toEqual([]);
    expect(classicAnswers.payPerUse).toEqual({ providers: ['copilot'], amount: 150 });
    expect(written(planSetup(classicAnswers, classicCurrent))).toEqual([]);
    expect(accessOf(classicPolicy)).toEqual(accessOf(structuredClone(classicPolicy)));

    const chain = policyOf({
      claude: ['claude/opus', 'claude/haiku'],
      codex: [{ label: 'codex/sol', useAfter: ['claude/haiku', 'claude/opus'] }],
      grok: [{ label: 'xai/grok', useAfter: ['codex/sol'] }],
    }, { profile: 'neutral' });
    const chainCurrent = currentOf(chain, [], week(['claude', 'codex', 'grok']));
    const chainAnswers = answersFromCurrent(chainCurrent);
    expect(chainAnswers.rank).toEqual(['claude', 'codex', 'grok']);
    expect(written(planSetup(chainAnswers, chainCurrent))).toEqual([]);

    const partial = policyOf({
      claude: ['claude/opus', 'claude/haiku'],
      codex: [{ label: 'codex/sol', useAfter: ['claude/opus'] }],
      grok: [{ label: 'xai/grok', useAfter: ['codex/sol'] }],
    }, { profile: 'neutral' });
    const partialCurrent = currentOf(partial, [], week(['claude', 'codex', 'grok']));
    const partialAnswers = answersFromCurrent(partialCurrent);
    expect(partialAnswers.rank).toEqual(['claude', 'codex', 'grok']);
    expect(written(planSetup(partialAnswers, partialCurrent))).toEqual([]);

    const alone = policyOf({ claude: ['claude/opus'] }, { profile: 'neutral' });
    const aloneCurrent = currentOf(alone, [], week(['claude']));
    expect(answersFromCurrent(aloneCurrent).rank).toEqual(['claude']);
    expect(written(planSetup(answersFromCurrent(aloneCurrent), aloneCurrent))).toEqual([]);

    const custom = policyOf({ grok: ['xai/grok'] }, { profile: 'neutral', pace: { grok: { reserve: 75, band: 5 } } });
    const customCurrent = currentOf(custom, [], week(['grok']));
    expect(answersFromCurrent(customCurrent).holdBack.grok).toBe('custom');
    expect(written(planSetup(answersFromCurrent(customCurrent), customCurrent))).toEqual([]);
  });

  it('round-trips answers through the real edit functions', () => {
    const policy = policyOf({
      claude: ['claude/opus', 'claude/haiku'],
      codex: ['codex/sol'],
      grok: ['xai/grok'],
    }, { profile: 'neutral' });
    const usage = week(['claude', 'codex', 'grok']);
    const routes = [
      { name: 'opus', model: 'claude/opus', hasKey: true },
      { name: 'bare', model: 'codex/sol', hasKey: false },
    ];
    const current = currentOf(policy, routes, usage);
    const start = answersFromCurrent(current);
    expect(start.stack).toBe('several');
    expect(start.rank).toEqual([]);
    expect(start.holdBack).toEqual({ claude: 'some', codex: 'some', grok: 'some' });
    expect(start.strengths).toEqual({ 'claude/opus': 'strong', 'claude/haiku': 'light', 'codex/sol': 'unsure', 'xai/grok': 'unsure' });
    const want: SetupAnswers = {
      ...start,
      rank: ['grok', 'claude', 'codex'],
      holdBack: { claude: 'free', codex: 'save', grok: 'some' },
      payPerUse: { providers: ['openai'], amount: 40 },
      added: ['openai'],
      strengths: { 'claude/opus': 'light', 'claude/haiku': 'light', 'codex/sol': 'strong', 'xai/grok': 'unsure' },
      prose: ['claude/opus'],
      seatsSecond: ['codex/sol'],
    };
    const before = accessOf(policy);
    const plan = planSetup(want, current);
    expect(isValid(plan)).toBe(true);
    const next = structuredClone(policy);
    for (const op of applySteps(plan)) applyEdit(next, op.payload, 'test', NOW);
    expect(accessOf(next)).toEqual(before);
    const again = currentOf(next, routes, usage);
    expect(answersFromCurrent(again)).toEqual(want);
    expect(written(planSetup(answersFromCurrent(again), again))).toEqual([]);
  });
});

describe('profile start', () => {
  const file = JSON.stringify({
    kind: 'augur-profile',
    schema: 1,
    balance: {
      profile: 'neutral',
      pace: { claude: { reserve: 60, band: 5 }, codex: { reserve: 100, band: 20 } },
      fallback: { providers: ['openai'], aim: 25 },
      prose: { models: ['claude/opus'] },
      seats: { second: { models: ['codex/sol'] } },
      tiers: { 'claude/opus': 'strong', 'codex/sol': 'light' },
    },
    routes: { opus: { model: 'claude/opus', adapter: 'codex-exec', options: {} } },
  });

  it('fills answers from a valid profile and leaves the rank empty', () => {
    const got = answersFromProfile(file, currentOf(migratePolicy({})));
    expect('answers' in got).toBe(true);
    if (!('answers' in got)) return;
    expect(got.answers.stack).toBe('profile');
    expect(got.answers.holdBack).toEqual({ claude: 'save', codex: 'free' });
    expect(got.answers.rank).toEqual([]);
    expect(got.answers.payPerUse).toEqual({ providers: ['openai'], amount: 25 });
    expect(got.answers.added).toEqual(['openai']);
    expect(got.answers.prose).toEqual(['claude/opus']);
    expect(got.answers.seatsSecond).toEqual(['codex/sol']);
    expect(got.answers.strengths).toEqual({ 'claude/opus': 'strong', 'codex/sol': 'light' });
  });

  it('returns the problems for an invalid file and changes nothing', () => {
    const current = currentOf(migratePolicy({ providers: { claude: { models: {} } } }), [{ name: 'opus', model: 'claude/opus', hasKey: true }]);
    const snap = JSON.stringify(current);
    const bad = answersFromProfile('{"hello":1}', current);
    expect('problems' in bad).toBe(true);
    if (!('problems' in bad)) return;
    expect(bad.problems[0]).toContain('not an Augur profile');
    expect(JSON.stringify(current)).toBe(snap);

    const adapter = answersFromProfile(JSON.stringify({
      kind: 'augur-profile', schema: 1, balance: { profile: 'neutral' },
      routes: { x: { model: 'a/b', adapter: 'nothing', options: {} } },
    }), current);
    expect('problems' in adapter && adapter.problems.some(p => p.includes('not an adapter'))).toBe(true);
    expect(JSON.stringify(current)).toBe(snap);
  });
});

describe('profile models', () => {
  const base = {
    kind: 'augur-profile', schema: 1,
    balance: { profile: 'neutral' },
    routes: { opus: { model: 'claude/opus', adapter: 'codex-exec', options: {} } },
  };

  it('keeps a file with no models, and ignores a key it does not read', () => {
    const none = planProfileFile(JSON.stringify(base), new Set());
    expect('error' in none).toBe(false);
    if ('error' in none) return;
    expect(none.models).toEqual([]);
    expect(none.problems).toEqual([]);
    const extra = planProfileFile(JSON.stringify({ ...base, future: true, models: { acme: { 'acme/fast': { id: 'fast-1', rule: { dataTier: 'internal', activities: { write_code: 'preferred' } } } } } }), new Set());
    expect('error' in extra).toBe(false);
    if ('error' in extra) return;
    expect(extra.problems).toEqual([]);
    expect(extra.models.map(m => m.label)).toEqual(['acme/fast']);
    expect(extra.models[0]?.rule).toEqual({ dataTier: 'internal', activities: { write_code: 'preferred' } });
  });

  it('reports a model that is already here and rejects a bad tier, a bad weight and a forbidden field', () => {
    const known = planProfileFile(JSON.stringify({ ...base, models: { acme: { 'acme/fast': { id: 'fast-1', rule: { cost: 'cheap' } }, 'acme/slow': { id: 'slow-1', rule: {} } } } }), new Set(), [{ provider: 'acme', label: 'acme/fast', id: 'fast-1' }]);
    expect('error' in known).toBe(false);
    if ('error' in known) return;
    expect(known.existingModels).toEqual(['acme/fast']);
    expect(known.models.map(m => m.label)).toEqual(['acme/slow']);
    for (const rule of [{ dataTier: 'secret' }, { activities: { write_code: 'huge' } }, { pause: { until: '2099-01-01T00:00:00Z' } }, { status: 'confirmed' }]) {
      const bad = planProfileFile(JSON.stringify({ ...base, models: { acme: { 'acme/fast': { id: 'fast-1', rule } } } }), new Set());
      expect('error' in bad).toBe(false);
      if ('error' in bad) return;
      expect(bad.problems.length).toBeGreaterThan(0);
      expect(bad.models).toEqual([]);
    }
  });

  it('builds the models section from the fields a model sets itself', () => {
    const section = modelsSection({ providers: { acme: { thresholds: { warnPct: 1 }, models: {
      'acme/fast': { id: 'fast-1', name: 'Fast', status: 'confirmed', activities: { write_code: 'preferred' }, dataTier: 'internal', askFirst: false, effort: null, cost: 'cheap', pause: { until: '2099-01-01T00:00:00Z' }, notes: 'no', inherited: ['askFirst'] },
    } } } });
    expect(section).toEqual({ acme: { 'acme/fast': { id: 'fast-1', name: 'Fast', rule: { activities: { write_code: 'preferred' }, dataTier: 'internal', cost: 'cheap' } } } });
    expect(JSON.stringify(section)).not.toContain('pause');
    expect(modelsSection({ providers: {} })).toBeNull();
  });

  it('fills the same interview answers when the profile also carries valid models, and rejects a bad one', () => {
    const file = JSON.stringify(base);
    const withModels = JSON.stringify({ ...base, models: { acme: { 'acme/fast': { id: 'fast-1', rule: { dataTier: 'public' } } } } });
    const current = { policy: { providers: {} }, balance: null, routes: [], usage: null };
    const plain = answersFromProfile(file, current);
    const extra = answersFromProfile(withModels, current);
    expect(extra).toEqual(plain);
    const bad = answersFromProfile(JSON.stringify({ ...base, models: { acme: { 'acme/fast': { id: 'fast-1', rule: { dataTier: 'nope' } } } } }), current);
    expect('problems' in bad && bad.problems.some(p => p.includes('dataTier'))).toBe(true);
  });
});
