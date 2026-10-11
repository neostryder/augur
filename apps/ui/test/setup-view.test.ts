import { describe, expect, it } from 'vitest';
import { defaultConfig, migratePolicy } from '@augur/core';
import type { PolicyConfig } from '@augur/core';
import type { UsageSnapshot } from '@augur/dispatch-protocol';
import { HOLD_BACK, afterApply, answersFromCurrent, applySteps, planSetup } from '@augur/view-model';
import type { SetupAnswers, SetupCurrent, StepId } from '@augur/view-model';
import { renderSettings, type SettingsModel } from '../src/views/settings';
import {
  goStep, initialView, loadProfile, moveRank, openSetup, renderSetup, runApply, selectStack, setHold, setListAnswer, setPayAmount, togglePayProvider,
} from '../src/views/setup';
import type { SetupTrack } from '../src/views/setup';

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
  return { providers: Object.fromEntries(ids.map((id) => [id, { meters: [{ id: 'week', usedPct: 10, windowKind: 'weekly' }] }])) };
}

const currentOf = (policy: PolicyConfig, routes: SetupCurrent['routes'] = [], usage: UsageSnapshot | null = null): SetupCurrent => ({ policy, routes, usage });

const track = (id: string, name: string, over: Partial<SetupTrack> = {}): SetupTrack => ({
  id, name, enabled: true, signedIn: true, hasWindow: true, locked: false, ...over,
});

const blank = currentOf(migratePolicy({}));

function settingsModel(firstRun: boolean): SettingsModel {
  return {
    config: defaultConfig(), plugins: new Map(), snapshot: null, secrets: new Set(), shellKind: 'desktop', autostart: false,
    openProvider: null, customDraft: '[]', customError: '', firstRun, savedFlash: null, sync: null, relay: '', pwaUrl: '',
    update: { version: null, status: 'current', available: null, changes: null }, pairQr: null, pairUrl: null, scanError: '',
    hotkeyError: '', canHotkey: false, iosInstallHint: false, canDispatch: false, runJobs: false, classifier: null,
    platform: 'windows', push: null, claude: null,
  };
}

const applyButton = (html: string): string => html.match(/<button[^>]*data-setup-apply[^>]*>[^<]*/)?.[0] ?? '';

describe('the stack step', () => {
  it('renders the four cards and selecting one changes the answers', () => {
    const model = openSetup({ firstRun: true, current: blank, tracks: [track('claude', 'Claude')], routes: new Set() });
    const html = renderSetup(model);
    expect(html).toContain('data-stack="claude-only"');
    expect(html).toContain('data-stack="several"');
    expect(html).toContain('data-stack="api-only"');
    expect(html).toContain('data-stack="profile"');
    const next = selectStack(model, 'api-only');
    expect(next.answers.stack).toBe('api-only');
    expect(next.answers.holdBack).toEqual({});
    expect(next.answers.rank).toEqual([]);
  });

  it('rejects an invalid profile file and leaves the answers and the plan as they were', () => {
    const picked = selectStack(openSetup({ firstRun: true, current: blank, tracks: [], routes: new Set() }), 'profile');
    const bad = loadProfile(picked, '{"hello":1}');
    expect(bad.answers).toBe(picked.answers);
    expect(bad.plan).toBe(picked.plan);
    expect(bad.profileProblems[0]).toContain('not an Augur profile');
    expect(renderSetup(bad)).toContain('not an Augur profile');
  });
});

describe('the pace step', () => {
  const opened = () => openSetup({
    firstRun: true,
    current: blank,
    tracks: [track('claude', 'Claude'), track('codex', 'Codex')],
    routes: new Set(),
  });

  it('shows the three hold-back choices for each paced subscription and moves the rank up and down', () => {
    const model = goStep(opened(), 'pace');
    const html = renderSetup(model);
    expect(html).toContain('data-setup-hold="claude"');
    expect(html).toContain('data-setup-hold="codex"');
    expect(html).toContain('Use it freely');
    expect(html).toContain('Keep some back');
    expect(html).toContain('Save it for the work only it does');
    expect(html).toContain(HOLD_BACK.some.text);
    expect(html).toContain('Move Codex up');
    expect(html).toContain('Move Codex down');
    expect(model.answers.rank).toEqual(['claude', 'codex']);
    const moved = moveRank(model, 'codex', -1);
    expect(moved.answers.rank).toEqual(['codex', 'claude']);
    expect(moveRank(moved, 'codex', 1).answers.rank).toEqual(['claude', 'codex']);
    expect(setHold(model, 'claude', 'free').answers.holdBack.claude).toBe('free');
  });
});

describe('review and apply', () => {
  const policy = policyOf({ claude: ['claude/opus'], codex: ['codex/sol'] }, { profile: 'neutral' });

  it('lists every model with the three-way control, and the Apply button follows the plan', () => {
    const model = goStep(openSetup({ firstRun: true, current: currentOf(policy), tracks: [track('claude', 'Claude')], routes: new Set() }), 'review');
    const html = renderSetup(model);
    expect(html).toContain('data-setup-model="claude/opus"');
    expect(html).toContain('data-setup-model="codex/sol"');
    expect(html).toContain('>Strong<');
    expect(html).toContain('>Light<');
    expect(html).toContain('>Not sure<');
    const bad = togglePayProvider(model, 'openai', true);
    const badHtml = renderSetup(bad);
    const n = applySteps(bad.plan).length;
    const btn = applyButton(badHtml);
    expect(btn).toMatch(/disabled/);
    expect(btn).toContain(`Apply ${n} changes`);
    expect(badHtml).toContain('Name a monthly amount, or choose no backup spending.');
    const ok = setPayAmount(bad, 20);
    const okBtn = applyButton(renderSetup(ok));
    expect(okBtn).not.toMatch(/disabled/);
    expect(okBtn).toContain(`Apply ${applySteps(ok.plan).length} changes`);
  });

  it('pre-fills a re-run from the current setup and shows zero changes', () => {
    const stored = policyOf({ claude: ['claude/opus'] }, { profile: 'neutral', pace: { claude: { reserve: 90, band: 5 } } });
    const current = currentOf(stored, [], week(['claude']));
    const model = goStep(openSetup({ firstRun: false, current, tracks: [], routes: new Set() }), 'review');
    expect(model.answers.holdBack.claude).toBe('some');
    expect(applySteps(model.plan)).toHaveLength(0);
    expect(answersFromCurrent(current).strengths['claude/opus']).toBe(model.answers.strengths['claude/opus']);
    const html = renderSetup(model);
    expect(html).toContain('Apply 0 changes');
    expect(html).toContain('claude/opus');
    expect(html).not.toContain('setup-tag-new');
    expect(html).not.toContain('setup-tag-change');
  });

  it('issues the operations in applySteps order and stops on a failure', async () => {
    const current = currentOf(policyOf({ claude: ['claude/opus'], codex: ['codex/sol'], grok: ['xai/grok'] }, { profile: 'neutral' }), [], week(['claude', 'codex', 'grok']));
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
    const want = applySteps(plan).map((op) => op.payload.id);
    expect(want.length).toBeGreaterThan(0);
    const ids: string[] = [];
    const done = await runApply(plan, async (op) => { ids.push(op.payload.id); });
    expect(ids).toEqual(want);
    expect(done.complete).toBe(true);
    let n = 0;
    const stopped = await runApply(plan, async () => { n += 1; if (n === 3) throw new Error('disk full'); });
    expect(stopped.ran).toEqual(want.slice(0, 2));
    expect(stopped.failed).toEqual({ id: want[2], error: 'disk full' });
    expect(stopped.complete).toBe(false);
    const shown = renderSetup({ ...openSetup({ firstRun: false, current, tracks: [], routes: new Set() }), step: 'review', answers, plan, apply: stopped });
    expect(shown).toContain(`data-ran="${want[0]}"`);
    expect(shown).toContain(`data-failed="${want[2]}"`);
    expect(shown).toContain('disk full');
  });
});

describe('the done screen', () => {
  it('shows a test for each route that has a key, and the models still to confirm', () => {
    const policy = policyOf({
      claude: ['claude/opus', { label: 'claude/haiku', status: 'unreviewed' }],
    }, { profile: 'neutral', pace: { claude: { reserve: 90, band: 5 } } });
    const current = currentOf(policy, [{ name: 'opus', model: 'claude/opus', hasKey: true }], week(['claude']));
    const model = goStep(openSetup({ firstRun: false, current, tracks: [], routes: new Set(['opus']) }), 'done');
    const html = renderSetup(model);
    expect(html).toContain('data-action="setup-test"');
    expect(html).toContain('data-id="opus"');
    expect(html).toContain('claude/haiku');
    expect(html).toContain('data-action="setup-rules"');
    expect(html).toContain('data-provider="claude"');
    for (const line of afterApply(model.plan).next) expect(html).toContain(line);
  });
});

const stepButton = (html: string, id: string): string => html.match(new RegExp(`data-step="${id}"[\\s\\S]*?<\\/button>`))?.[0] ?? '';

describe('step marks', () => {
  const fresh = () => openSetup({ firstRun: true, current: blank, tracks: [track('claude', 'Claude')], routes: new Set() });

  it('shows a number until the step has been left with something set', () => {
    const html = renderSetup(fresh());
    expect(html).not.toContain('setup-num done');
    expect(stepButton(html, 'providers')).toContain('class="setup-num">2</span>');
    expect(stepButton(html, 'providers')).toContain('1 confirmed');
    expect(stepButton(html, 'done')).toContain('In progress');
    expect(stepButton(html, 'done')).toContain('class="setup-num">5</span>');
    const back = goStep(goStep(fresh(), 'providers'), 'stack');
    const visited = renderSetup(back);
    expect(stepButton(visited, 'providers')).toContain('setup-num done');
    expect(stepButton(visited, 'providers')).toContain('1 confirmed');
    expect(stepButton(visited, 'stack')).toContain('setup-num now');
    expect(stepButton(visited, 'stack')).not.toContain('setup-num done');
  });

  it('keeps the number when the note is 0 confirmed or Not started', () => {
    const opened = fresh();
    const empty: typeof opened = {
      ...opened,
      step: 'stack',
      seen: ['providers'],
      answers: { ...opened.answers, detected: [], added: ['openai'] },
    };
    const none = renderSetup(empty);
    expect(stepButton(none, 'providers')).toContain('0 confirmed');
    expect(stepButton(none, 'providers')).not.toContain('setup-num done');
    let done = setListAnswer(setListAnswer(fresh(), 'prose', 'skipped'), 'seatsSecond', 'skipped');
    done = { ...done, step: 'stack', seen: ['done'] as StepId[] };
    const html = renderSetup(done);
    expect(stepButton(html, 'done')).toContain('Not started');
    expect(stepButton(html, 'done')).not.toContain('setup-num done');
  });
});

describe('where the interview opens', () => {
  it('replaces the first-run screen and adds Run setup again on Settings', () => {
    expect(initialView(true)).toBe('setup');
    expect(initialView(false)).toBe('dashboard');
    const first = renderSetup(openSetup({ firstRun: true, current: blank, tracks: [], routes: new Set() }));
    expect(first).toContain('Skip setup');
    expect(first).not.toContain('Start tracking');
    const settings = renderSettings(settingsModel(false));
    expect(settings).toContain('Run setup again');
    expect(settings).toContain('data-action="setup-again"');
    expect(renderSettings(settingsModel(true))).not.toContain('data-action="setup-again"');
  });
});
