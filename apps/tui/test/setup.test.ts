import { describe, expect, it, vi } from 'vitest';
import type { UsageSnapshot } from '@augur/dispatch-protocol';
import { applyEdit, migratePolicy, type AppConfig, type EngineState, type PolicyConfig } from '@augur/core';
import { HOLD_BACK, answersFromCurrent, applySteps, planSetup, type SetupAnswers, type SetupCurrent } from '@augur/view-model';
import { pages } from '../src/index.js';
import { SettingsPage } from '../src/screens/settings.js';
import {
  goStep, loadProfileText, moveRank, openSetup, reduce, renderSetup, selectStack, setHold, setListAnswer, setPayAmount, setStrength, togglePayProvider, SetupPage, type TuiModel,
} from '../src/screens/setup.js';
import * as win from '../../ui/src/views/setup.js';
import { ch, k, setup, state } from './fixtures.js';

const changes = (n: number): string => `${n} change${n === 1 ? '' : 's'}`;
const MISSING = 'C:/missing/augur-test-routes.json';
const env = { AUGURD_ROUTES: MISSING } as NodeJS.ProcessEnv;

function policyOf(groups: Record<string, readonly string[]>, balance: unknown): PolicyConfig {
  const providers: Record<string, unknown> = {};
  for (const [id, models] of Object.entries(groups)) {
    const map: Record<string, unknown> = {};
    for (const label of models) {
      map[label] = {
        id: label.slice(label.indexOf('/') + 1), source: 'manual', status: 'confirmed', firstSeen: '2026-01-01T00:00:00.000Z',
        rule: { dataTier: 'sensitive', askFirst: true },
      };
    }
    providers[id] = { defaults: { dataTier: 'sensitive', askFirst: true }, models: map };
  }
  return migratePolicy({ providers, balance });
}

function week(ids: readonly string[]): UsageSnapshot {
  return { providers: Object.fromEntries(ids.map((id) => [id, { meters: [{ id: 'week', usedPct: 10, windowKind: 'weekly' as const }] }])) };
}

const currentOf = (policy: PolicyConfig, routes: SetupCurrent['routes'] = [], usage: UsageSnapshot | null = null): SetupCurrent => ({ policy, routes, usage });
const blank = currentOf(migratePolicy({}));
const track = (id: string, name: string, hasWindow = true) => ({ id, name, enabled: true, signedIn: true, hasWindow, locked: false });

function focus(model: TuiModel, pred: (line: string) => boolean): TuiModel {
  let m = model;
  for (let i = 0; i < 50; i++) {
    const line = renderSetup(m, 90).find((l) => l.startsWith('> '));
    if (line && pred(line)) return m;
    const next = reduce(m, k('down'));
    if (next.model.cursor === m.cursor) break;
    m = next.model;
  }
  return m;
}

function settled(policy: PolicyConfig) {
  return {
    balance: policy.balance ?? null,
    providers: policy.providers,
    history: policy.history.map((h) => ({ path: h.path, from: h.from, to: h.to, device: h.device })),
  };
}

function answered(current: SetupCurrent, answers: SetupAnswers): TuiModel {
  const model = openSetup({ firstRun: false, current, tracks: [] });
  return { ...model, answers, plan: planSetup(answers, current), step: 'review', cursor: 0 };
}

describe('the stack step', () => {
  const opened = () => openSetup({ firstRun: true, current: blank, tracks: [track('claude', 'Claude')] });

  it('renders the four choices and a key selects one', () => {
    const model = opened();
    const text = renderSetup(model, 80).join('\n');
    expect(text).toContain('Claude only');
    expect(text).toContain('Several subscriptions');
    expect(text).toContain('API keys only');
    expect(text).toContain('Start from a profile file');
    expect(text).toContain('Esc back');
    const next = reduce(reduce(model, k('down')).model, k('enter')).model;
    expect(next.answers.stack).toBe('several');
    expect(next.answers.rank).toEqual(['claude']);
    expect(reduce(model, ch('3')).model.step).toBe('pace');
    expect(reduce(model, k('tab')).model.step).toBe('providers');
  });

  it('rejects an invalid profile and leaves the answers and the plan as they were', () => {
    const picked = selectStack(opened(), 'profile');
    const bad = loadProfileText(picked, '{"hello":1}');
    expect(bad.answers).toBe(picked.answers);
    expect(bad.plan).toBe(picked.plan);
    expect(bad.profileProblems[0]).toContain('not an Augur profile');
    const missing = loadProfileText(picked, null);
    expect(missing.answers).toBe(picked.answers);
    expect(missing.plan).toBe(picked.plan);
    expect(missing.profileProblems).toEqual(['Could not read that file. Check the path and try again.']);
  });

  it('rejects a typed path through the profile check and writes nothing', async () => {
    const page = new SetupPage({ env, readFile: () => '{"hello":1}' });
    const list = pages({ env });
    list[7] = page;
    const t = setup(state(), { pages: list });
    t.app.active = 7;
    t.draw(80, 40);
    for (let i = 0; i < 10 && !t.draw(80, 40).includes('> Start from a profile file'); i++) await t.app.key(k('down'));
    await t.app.key(k('enter'));
    for (let i = 0; i < 6 && !t.draw(80, 40).includes('> Profile path'); i++) await t.app.key(k('down'));
    await t.app.key(k('enter'));
    for (const c of 'C:/missing/nope.json') await t.app.key(ch(c));
    const beforeA = page.model!.answers;
    const beforeP = page.model!.plan;
    await t.app.key(k('enter'));
    expect(page.model!.answers).toBe(beforeA);
    expect(page.model!.plan).toBe(beforeP);
    expect(page.model!.profileProblems[0]).toContain('not an Augur profile');
    expect(t.draw(80, 40)).toContain('not an Augur profile');
    expect(t.calls.filter(([m]) => m === 'saveConfig' || m === 'finishSetup')).toHaveLength(0);
  });
});

describe('the pace step', () => {
  it('shows the hold-back choices and moves the rank with u and shift+down', () => {
    let model = goStep(openSetup({
      firstRun: true, current: blank, tracks: [track('claude', 'Claude'), track('codex', 'Codex')],
    }), 'pace');
    const text = renderSetup(model, 90).join('\n');
    expect(text).toContain('Use it freely');
    expect(text).toContain('Keep some back');
    expect(text).toContain('Save it for the work only it does');
    expect(text.replace(/\s+/g, ' ')).toContain(HOLD_BACK.some.text);
    expect(model.answers.rank).toEqual(['claude', 'codex']);
    model = focus(model, (l) => l.startsWith('> Claude'));
    model = reduce(model, k('enter')).model;
    expect(model.answers.holdBack.claude).toBe('save');
    model = focus(model, (l) => l.startsWith('> Rank 2'));
    model = reduce(model, ch('u')).model;
    expect(model.answers.rank).toEqual(['codex', 'claude']);
    model = reduce(model, k('down', { shift: true })).model;
    expect(model.answers.rank).toEqual(['claude', 'codex']);
    model = reduce(model, ch('u')).model;
    model = reduce(model, ch('d')).model;
    expect(model.answers.rank).toEqual(['claude', 'codex']);
  });
});

describe('review and apply', () => {
  const policy = policyOf({ claude: ['claude/opus'], codex: ['codex/sol'] }, { profile: 'neutral' });
  const current = currentOf(policy);

  it('lists every model with the three-way control, and Apply follows the plan', () => {
    let model = goStep(openSetup({ firstRun: true, current, tracks: [track('claude', 'Claude')] }), 'review');
    const text = renderSetup(model, 90).join('\n');
    expect(text).toContain('claude/opus');
    expect(text).toContain('codex/sol');
    expect(text).toContain('Strong');
    expect(text).toContain('Light');
    expect(text).toContain('Not sure');
    model = focus(model, (l) => l.startsWith('> claude/opus'));
    model = reduce(model, ch(' ')).model;
    expect(model.answers.strengths['claude/opus']).toBe('strong');
    expect(renderSetup(model, 90).some((l) => l.includes('[Strong]'))).toBe(true);
    const bad = togglePayProvider(model, 'openai', true);
    const n = applySteps(bad.plan).length;
    const blocked = renderSetup(bad, 90).find((l) => l.includes('Apply '));
    expect(blocked).toContain(`Apply ${changes(n)}`);
    expect(blocked).toContain('disabled');
    expect(renderSetup(bad, 90).join('\n')).toContain('Enter a monthly amount for pay per use, or choose No backup spending.');
    const ok = setPayAmount(bad, 20);
    const open = renderSetup(ok, 90).find((l) => l.includes('Apply '));
    expect(open).toContain(`Apply ${changes(applySteps(ok.plan).length)}`);
    expect(open).not.toContain('disabled');
  });

  it('puts the plain-text summary above Apply when the terminal is narrow', () => {
    const model = goStep(openSetup({ firstRun: true, current, tracks: [track('claude', 'Claude')] }), 'review');
    const lines = renderSetup(model, 60);
    const applyAt = lines.findIndex((l) => l.includes('Apply '));
    const sumAt = lines.findIndex((l) => /\((unchanged|will change|new)\)/.test(l));
    expect(sumAt).toBeGreaterThanOrEqual(0);
    expect(applyAt).toBeGreaterThan(sumAt);
    expect(lines.some((l) => l.length > 60 && /\((unchanged|will change|new)\)/.test(l))).toBe(false);
  });

  it('pre-fills a re-run from the current setup and shows zero changes', () => {
    const stored = policyOf({ claude: ['claude/opus'] }, { profile: 'neutral', pace: { claude: { reserve: 90, band: 5 } } });
    const again = currentOf(stored, [], week(['claude']));
    const model = goStep(openSetup({ firstRun: false, current: again, tracks: [] }), 'review');
    expect(model.answers.holdBack.claude).toBe('some');
    expect(model.answers).toEqual(answersFromCurrent(again));
    expect(applySteps(model.plan)).toHaveLength(0);
    const text = renderSetup(model, 90).join('\n');
    expect(text).toContain('Apply 0 changes');
    expect(text).toContain('claude/opus');
    expect(text).not.toMatch(/\((new|will change)\)/);
  });

  it('sends applySteps in order, and a mid-list failure says which ran', async () => {
    const full = currentOf(policyOf({ claude: ['claude/opus'], codex: ['codex/sol'], grok: ['xai/grok'] }, { profile: 'neutral' }), [], week(['claude', 'codex', 'grok']));
    const start = answersFromCurrent(full);
    const answers: SetupAnswers = {
      ...start,
      rank: ['claude', 'codex'],
      holdBack: { claude: 'free', codex: 'save', grok: 'some' },
      payPerUse: { providers: ['openai'], amount: 40 },
      strengths: { ...start.strengths, 'claude/opus': 'light', 'codex/sol': 'strong' },
      prose: ['claude/opus'],
      seatsSecond: ['codex/sol'],
    };
    const plan = planSetup(answers, full);
    const want = applySteps(plan).map((op) => op.payload);
    expect(want.length).toBeGreaterThan(2);
    const run = (failAt: number | null) => {
      const s = state();
      s.firstRun = true;
      s.config.policy = full.policy as PolicyConfig;
      const page = new SetupPage({ env });
      const list = pages({ env });
      list[7] = page;
      const t = setup(s, { pages: list });
      t.app.active = 7;
      page.model = focus(answered(full, answers), (l) => l.startsWith('> Apply'));
      if (failAt !== null) {
        let n = 0;
        const orig = t.link.run.bind(t.link);
        vi.spyOn(t.link, 'run').mockImplementation(async (method: string, ...args: unknown[]) => {
          if (method === 'saveConfig') { n += 1; if (n === failAt) throw new Error('disk full'); }
          return orig(method, ...args);
        });
      }
      return { t, page };
    };
    const ok = run(null);
    const baseline = structuredClone(full.policy) as PolicyConfig;
    await ok.t.app.key(k('enter'));
    const saves = ok.t.calls.filter(([m]) => m === 'saveConfig').map(([, a]) => a[0] as AppConfig);
    expect(ok.t.calls.map(([m]) => m)).toEqual([...want.map(() => 'saveConfig'), 'finishSetup']);
    let expected = baseline;
    for (let i = 0; i < want.length; i++) {
      applyEdit(expected, want[i]!, 'desktop', new Date(0));
      expect(settled(saves[i]!.policy!)).toEqual(settled(expected));
    }
    expect(ok.page.model!.step).toBe('done');
    expect(ok.page.model!.apply?.ran).toEqual(want.map((op) => op.id));
    expect(ok.page.model!.apply?.complete).toBe(true);

    const stopped = run(3);
    await stopped.t.app.key(k('enter'));
    expect(stopped.t.calls.map(([m]) => m)).toEqual(['saveConfig', 'saveConfig']);
    expect(stopped.page.model!.apply?.ran).toEqual(want.slice(0, 2).map((op) => op.id));
    expect(stopped.page.model!.apply?.failed).toEqual({ id: want[2]!.id, error: 'disk full' });
    expect(stopped.page.model!.apply?.complete).toBe(false);
    expect(stopped.page.model!.step).toBe('review');
    const shown = renderSetup(stopped.page.model!, 90).join('\n');
    expect(shown).toContain('disk full');
    expect(shown).toContain('Could not save');
    expect((shown.match(/ saved\./g) ?? []).length).toBe(2);
  });
});

describe('where the interview opens', () => {
  it('opens the interview on a first run, and Skip writes nothing', async () => {
    const s = state();
    s.firstRun = true;
    const t = setup(s, { pages: pages({ env }) });
    const text = t.draw(100, 30);
    expect(t.app.active).toBe(7);
    expect(t.app.page.name).toBe('Setup');
    expect(text).toContain('Claude only');
    expect(text).toContain('Several subscriptions');
    expect(text).toContain('API keys only');
    expect(text).toContain('Start from a profile file');
    expect(text).not.toContain('Start tracking');
    expect(text).toContain('Esc back');
    await t.app.key(k('escape'));
    expect(t.app.page.name).toBe('Usage');
    expect(t.calls.filter(([m]) => m === 'saveConfig' || m === 'finishSetup')).toHaveLength(0);

    const again = setup(s, { pages: pages({ env }) });
    again.draw(100, 30);
    for (let i = 0; i < 12 && !again.draw(100, 30).includes('> Skip setup'); i++) await again.app.key(k('down'));
    expect(again.draw(100, 30)).toContain('> Skip setup');
    await again.app.key(k('enter'));
    expect(again.app.page.name).toBe('Usage');
    expect(again.calls.filter(([m]) => m === 'saveConfig' || m === 'finishSetup')).toHaveLength(0);
  });

  it('reaches setup from the tab row and from Run setup again, filled in with nothing to write', async () => {
    const stored = policyOf({ claude: ['claude/opus'] }, { profile: 'neutral', pace: { claude: { reserve: 90, band: 5 } } });
    const s = state();
    s.config.policy = stored;
    s.snapshot!.providers = {
      claude: {
        ...s.snapshot!.providers.claude!,
        money: [],
        meters: [{ id: 'week', label: 'Week', usedPct: 10, resetsAt: null, windowSeconds: null, windowKind: 'weekly' }],
      },
    };
    const settingsPage = new SettingsPage({ platform: 'linux', env });
    const setupPage = new SetupPage({ env });
    const list = pages({ env });
    list[6] = settingsPage;
    list[7] = setupPage;
    const t = setup(s, { pages: list });
    await t.app.key(ch('8'));
    expect(t.app.page.name).toBe('Setup');
    t.app.active = 6;
    settingsPage.form.focus = 'setup-again';
    await t.app.key(k('enter'));
    expect(t.app.active).toBe(7);
    expect(setupPage.model?.firstRun).toBe(false);
    const review = reduce(setupPage.model!, ch('4')).model;
    expect(review.answers.holdBack.claude).toBe('some');
    expect(applySteps(review.plan)).toHaveLength(0);
    expect(renderSetup(review, 90).join('\n')).toContain('Apply 0 changes');
    expect(t.calls.filter(([m]) => m === 'saveConfig' || m === 'finishSetup')).toHaveLength(0);
  });
});

describe('the same answers make the same operations', () => {
  it('matches the window app plan', () => {
    const tracks = [track('claude', 'Claude'), track('codex', 'Codex')];
    const current = currentOf(policyOf({ claude: ['claude/opus'], codex: ['codex/sol'] }, { profile: 'neutral' }), [], week(['claude', 'codex']));
    let w = win.openSetup({ firstRun: true, current, tracks, routes: new Set() });
    let term = openSetup({ firstRun: true, current, tracks });
    const payloads = (plan: typeof w.plan) => applySteps(plan).map((op) => op.payload);
    expect(payloads(term.plan)).toEqual(payloads(w.plan));
    w = win.setHold(w, 'claude', 'free');
    term = setHold(term, 'claude', 'free');
    w = win.moveRank(w, 'codex', -1);
    term = moveRank(term, 'codex', -1);
    w = win.togglePayProvider(w, 'openai', true);
    term = togglePayProvider(term, 'openai', true);
    w = win.setPayAmount(w, 25);
    term = setPayAmount(term, 25);
    w = win.setStrength(w, 'claude/opus', 'strong');
    term = setStrength(term, 'claude/opus', 'strong');
    w = win.setListAnswer(w, 'prose', ['claude/opus']);
    term = setListAnswer(term, 'prose', ['claude/opus']);
    w = win.setListAnswer(w, 'seatsSecond', 'skipped');
    term = setListAnswer(term, 'seatsSecond', 'skipped');
    expect(payloads(term.plan)).toEqual(payloads(w.plan));
    expect(payloads(term.plan).length).toBeGreaterThan(0);
  });
});
