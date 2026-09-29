import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPolicyFile, emptyPolicy, fieldPath, importPolicy, setField } from '@augur/core';
import type { PolicyFile } from '@augur/core';
import { checkNamed, checkPick, evaluate, matchNamedModels, pressure, rank, usageFactors } from '../src/index.js';
import type { AdapterCapabilities, JobRequest, PickRecord, PromptRecord, RouteConfig, UsageSnapshot } from '../src/index.js';

const now = new Date('2026-09-28T12:00:00Z');
const RULES = { providers: {
  codex: { defaults: { dataTier: 'sensitive', output: 'write_files', cost: 'expensive' }, models: {
    'codex/sol': { id: 'gpt-6-sol', rule: { activities: { write_code: 'preferred', review_code: 'often', research: 'normal' } } },
    'codex/luna': { id: 'gpt-6-luna', rule: { cost: 'cheap', activities: { write_code: 'normal', summarize_extract: 'often' } } },
    'codex/astra': { id: 'gpt-6-astra', rule: { askFirst: true, activities: { write_code: 'normal' } } } } },
  grok: { defaults: { dataTier: 'regulated', cost: 'moderate', output: 'write_files' }, models: { 'xai/grok': { id: 'grok-4.7', rule: { activities: { write_code: 'normal', research: 'often' } } } } },
  minimax: { defaults: { dataTier: 'internal', cost: 'cheap', output: 'patch_only', sandbox: true }, models: { 'minimax/m3': { id: 'MiniMax-M3', rule: { activities: { write_code: 'last_resort', long_context: 'preferred' } } } } },
  openrouter: { defaults: { dataTier: 'regulated', cost: 'cheap', output: 'patch_only', sandbox: true }, models: { 'deepseek/v4.1-flash': { id: 'ds', rule: { activities: { write_code: 'normal' } } } } },
  claude: { defaults: { dataTier: 'regulated', cost: 'moderate', output: 'write_files' }, models: { 'claude/sonnet': { id: 'sonnet', rule: { activities: { write_code: 'last_resort', research: 'last_resort' } } } } },
} };
function policy(): PolicyFile {
  const p = emptyPolicy(); importPolicy(p, RULES, now);
  for (const [id, provider] of Object.entries(p.providers)) for (const label of Object.keys(provider.models)) setField(p, fieldPath(id, label, 'status'), 'confirmed', 'test', now);
  return buildPolicyFile(p, Object.keys(p.providers).map(id => ({ id, name: id === 'codex' ? 'Codex' : id, metered: id !== 'openrouter' })), now);
}
const host: AdapterCapabilities = { permissionRequests: false, sessions: false, reportsUsage: true, sandboxed: false, isolatesWorkspace: false, enforcesReadOnly: true };
const route = (model: string): RouteConfig => ({ model, adapter: 'x' });
const req = (over: Partial<JobRequest> = {}): JobRequest => ({ route: 'r', activity: 'write_code', dataTier: 'internal', tools: 'write', output: 'write_files', cwd: 'C:/x', prompt: { text: 'hi' }, caller: { kind: 'cli' }, ...over });
const iso = (offsetS: number) => new Date(now.getTime() + offsetS * 1000).toISOString();
const week = 604800;
/** A weekly meter that is `used` percent spent with `left` of its window remaining. */
const weekly = (used: number, left: number, extra: object = {}) => ({ id: 'plan_weekly', label: 'Weekly limit', usedPct: used, windowKind: 'weekly', windowSeconds: week, resetsAt: iso(left * week), ...extra });
const fresh = (over: object) => ({ fetchedAt: iso(-60), ...over });
const decide = (r: JobRequest, usage: UsageSnapshot, model = 'codex/sol') => evaluate(r, { policy: policy(), usage, route: route(model), capabilities: host, now });

describe('headroom and usage factors', () => {
  it('counts only active session and weekly windows, and reads a pay-as-you-go balance when there are none', () => {
    const usage: UsageSnapshot = { providers: {
      claude: fresh({ meters: [{ id: 'session', label: 'Current session', usedPct: 99, windowKind: 'session', active: false }, weekly(40, 0.5, { id: 'weekly_all' })] }),
      grok: fresh({ meters: [weekly(100, 0.4)], money: [{ id: 'prepaid', amount: 0 }] }),
      openrouter: fresh({ meters: [{ id: 'free_daily', usedPct: 99, windowKind: 'daily' }], money: [{ id: 'balance', amount: 8 }] }),
    } };
    const press = pressure(policy(), usage, now);
    expect(press.claude?.headroom).toBeCloseTo(0.6 / 0.5 > 1 ? 1 : 0.6 / 0.5, 2);
    expect(press.grok).toMatchObject({ headroom: 0, why: 'Weekly limit spent (100%)' });
    expect(press.openrouter).toMatchObject({ headroom: 1, why: 'balance $8.00' });
    expect(press.codex).toMatchObject({ headroom: 1, metered: false });
  });

  it('shrinks headroom with burn rate, floors it when little is left, and ignores figures older than two hours', () => {
    const at = (used: number, left: number, age = 60) => pressure(policy(), { providers: { codex: { fetchedAt: iso(-age * 60), meters: [weekly(used, left)] } } }, now).codex as { headroom: number; why: string };
    expect(at(50, 0.5).headroom).toBe(1);
    expect(at(70, 0.8).headroom).toBeCloseTo(0.375, 3);
    expect(at(90, 0.95).headroom).toBeCloseTo(0.1 / 0.95 * 0.4, 3);
    expect(at(70, 0.8, 200)).toMatchObject({ headroom: 1 });
    expect(at(70, 0.8, 200).why).toMatch(/not weighed/);
    // A window that has just started is capped at 95% left, so it is never trusted fully.
    expect(at(10, 1).headroom).toBeCloseTo(0.9 / 0.95, 3);
  });

  it('raises headroom to a power set by the model cost and by how scarce usage is across providers', () => {
    const p = policy();
    const press = { codex: { headroom: 0.5, why: '', metered: true }, grok: { headroom: 1, why: '', metered: true } };
    const { factors, scarcity } = usageFactors(p, press);
    expect(scarcity).toBe(1.5);
    expect(factors['codex/sol']).toBeCloseTo(0.5 ** 1.5, 3);
    expect(factors['codex/luna']).toBeCloseTo(0.5 ** (0.2 * 1.5), 3);
    expect(factors['xai/grok']).toBe(1);
    expect(factors['claude/live']).toBe(1);
  });
});

describe('quota, balance and pace checks', () => {
  it('denies at the deny threshold, names where else to send the work, and lets the override through with a note', () => {
    const usage: UsageSnapshot = { providers: { codex: fresh({ meters: [weekly(99, 0.5)] }), grok: fresh({ meters: [weekly(20, 0.5)] }) } };
    const d = decide(req(), usage);
    expect(d).toMatchObject({ allow: false, rejection: { code: 'quota_denied' } });
    expect(!d.allow && d.rejection.reason).toMatch(/grok at 20%/);
    const over = decide(req({ allow: ['exhausted'] }), usage);
    expect(over.allow && over.warnings.some(w => /sent anyway/.test(w))).toBe(true);
  });

  it('does not deny on figures more than two hours old, and says they are stale', () => {
    const d = decide(req(), { providers: { codex: { fetchedAt: iso(-3 * 3600), meters: [weekly(99, 0.5)] } } });
    expect(d.allow && d.warnings.some(w => /old/.test(w))).toBe(true);
  });

  it('checks a pay-as-you-go balance against its minimum and flags a low one', () => {
    const balance = (amount: number): UsageSnapshot => ({ providers: { openrouter: fresh({ meters: [], money: [{ id: 'balance', amount }] }) } });
    const r = req({ dataTier: 'internal', output: 'patch_only' });
    const cap = { ...host, sandboxed: true, isolatesWorkspace: true };
    const go = (amount: number) => evaluate(r, { policy: policy(), usage: balance(amount), route: route('deepseek/v4.1-flash'), capabilities: cap, now });
    expect(go(0.1)).toMatchObject({ allow: false, rejection: { code: 'quota_denied' } });
    const low = go(0.8);
    expect(low.allow && low.warnings.some(w => /Running low/.test(w))).toBe(true);
    expect(go(8)).toMatchObject({ allow: true, warnings: [] });
  });

  it('ignores a prepaid credit line on a provider that has session or weekly meters', () => {
    const d = decide(req(), { providers: { codex: fresh({ meters: [weekly(20, 0.5)], money: [{ id: 'prepaid', amount: 0 }] }) } });
    expect(d.allow).toBe(true);
  });

  it('refuses a model burning far ahead of its window, warns on a milder pace, and honors the override', () => {
    const deny: UsageSnapshot = { providers: { codex: fresh({ meters: [weekly(80, 0.9)] }) } };
    expect(decide(req(), deny)).toMatchObject({ allow: false, rejection: { code: 'pace_denied' } });
    const over = decide(req({ allow: ['exhausted'] }), deny);
    expect(over.allow && over.warnings.some(w => /usage factor/.test(w))).toBe(true);
    const warn = decide(req(), { providers: { codex: fresh({ meters: [weekly(60, 0.8)] }) } });
    expect(warn.allow && warn.warnings.some(w => /Better placed/.test(w))).toBe(true);
  });
});

describe('ranking', () => {
  const usage: UsageSnapshot = { providers: { codex: fresh({ meters: [weekly(20, 0.5)] }), grok: fresh({ meters: [weekly(20, 0.5)] }) } };
  it('blocks a model that fails a rule and says why', () => {
    const r = rank(policy(), usage, { activity: 'write_code', dataTier: 'regulated' }, now);
    const why = Object.fromEntries(r.blocked.map(b => [b.model, b.why]));
    expect(why['codex/sol']).toMatch(/cleared for sensitive data, task is regulated/);
    expect(why['codex/astra']).toMatch(/ask first/);
    expect(why['minimax/m3']).toMatch(/cleared for internal data/);
    expect(r.ranking.map(x => x.model)).toEqual(expect.arrayContaining(['xai/grok', 'deepseek/v4.1-flash', 'claude/sonnet']));
    expect(r.ranking.map(x => x.model)).not.toContain('codex/sol');
  });
  it('lets a named ask-first model through and says which activity a model is not permitted', () => {
    const r = rank(policy(), usage, { activity: 'write_code', dataTier: 'internal', named: 'codex/astra' }, now);
    expect(r.ranking.map(x => x.model)).toContain('codex/astra');
    const c = rank(policy(), usage, { activity: 'long_context', dataTier: 'internal' }, now);
    expect(c.pick).toBe('minimax/m3');
    expect(c.blocked.find(b => b.model === 'codex/sol')?.why).toBe('not permitted long_context');
  });
  it('scores fit times the level weight times the usage factor, and orders by it', () => {
    const r = rank(policy(), usage, { activity: 'write_code', dataTier: 'internal', fits: { 'codex/sol': 0.5, 'codex/luna': 1, 'xai/grok': 0.2 } }, now);
    const sol = r.ranking.find(x => x.model === 'codex/sol') as (typeof r.ranking)[number];
    expect(sol.weight).toBe(2.5);
    expect(sol.score).toBeCloseTo(0.5 * 2.5 * sol.usage, 2);
    expect(r.ranking.map(x => x.score)).toEqual([...r.ranking.map(x => x.score)].sort((a, b) => b - a));
    expect(r.pick).toBe(r.ranking[0]?.model);
  });
  it('drops a model paused outright and keeps one with replacement weights', () => {
    const p = policy();
    p.providers.grok!.models['xai/grok']!.pause = { until: iso(3600), weights: null };
    p.providers.codex!.models['codex/luna']!.pause = { until: iso(3600), weights: { write_code: null } };
    const r = rank(p, usage, { activity: 'write_code', dataTier: 'internal' }, now);
    expect(r.blocked.find(b => b.model === 'xai/grok')?.why).toMatch(/^paused until/);
    expect(r.blocked.find(b => b.model === 'codex/luna')?.why).toMatch(/paused for write_code/);
  });
});

describe('picks', () => {
  const t = now.getTime();
  const pick = (over: Partial<PickRecord> = {}): PickRecord => ({ at: t - 5 * 60000, session: 's1', model: 'codex/sol', activity: 'write_code', dataTier: 'internal', named: null, cleared: ['codex/sol', 'xai/grok'], ...over });
  it('accepts the picked model, a named model, and a model the pick cleared, with a note for the last', () => {
    expect(checkPick('codex/sol', false, 's1', [pick()], t)).toEqual({ ok: true });
    expect(checkPick('anything', true, 's1', [], t)).toEqual({ ok: true });
    expect(checkPick('xai/grok', false, 's1', [pick()], t)).toMatchObject({ ok: true, note: expect.stringContaining('ranked codex/sol first') });
  });
  it('refuses a model nothing picked, a pick older than an hour, and another session\'s pick', () => {
    expect(checkPick('codex/luna', false, 's1', [pick()], t)).toMatchObject({ ok: false, reason: expect.stringContaining('latest pick was codex/sol') });
    expect(checkPick('codex/sol', false, 's1', [pick({ at: t - 61 * 60000 })], t)).toMatchObject({ ok: false });
    expect(checkPick('codex/sol', false, 's2', [pick()], t)).toMatchObject({ ok: false });
    expect(checkPick('codex/sol', false, null, [pick()], t)).toEqual({ ok: true });
  });
});

describe('naming a model', () => {
  const p = policy();
  it('finds the models a message names by label, id, display name or the last part of the label', () => {
    expect(matchNamedModels(p, 'Please run this on codex/astra.')).toEqual(['codex/astra']);
    expect(matchNamedModels(p, 'use gpt 6 sol for it')).toEqual(['codex/sol']);
    expect(matchNamedModels(p, 'Luna and grok can share the work')).toEqual(expect.arrayContaining(['codex/luna', 'xai/grok']));
    expect(matchNamedModels(p, 'the MiniMax-M3 route')).toEqual(['minimax/m3']);
  });
  it('does not take a longer word or a version number for a name', () => {
    expect(matchNamedModels(p, 'a solution to the resolve problem')).toEqual([]);
    expect(matchNamedModels(p, 'the astrand library and lunar phases')).toEqual([]);
    expect(matchNamedModels(p, 'no models here')).toEqual([]);
  });
  const t = now.getTime();
  const msg = (over: Partial<PromptRecord> = {}): PromptRecord => ({ at: t - 60000, session: 's1', models: ['codex/astra'], ...over });
  it('takes the claim as true at a keyboard, and otherwise wants one of the last three messages to have named the model', () => {
    expect(checkNamed('codex/astra', null, true, [], t)).toEqual({ ok: true, via: 'interactive' });
    expect(checkNamed('codex/astra', 's1', false, [msg()], t)).toEqual({ ok: true, via: 'prompt' });
    expect(checkNamed('codex/astra', 's1', false, [msg({ models: [] }), msg({ models: [] }), msg({ models: [] }), msg()], t)).toMatchObject({ ok: false });
    expect(checkNamed('codex/astra', 's2', false, [msg()], t)).toMatchObject({ ok: false });
    expect(checkNamed('codex/astra', 's1', false, [msg({ at: t - 7 * 3600000 })], t)).toMatchObject({ ok: false });
    expect(checkNamed('codex/astra', null, false, [msg()], t)).toMatchObject({ ok: false, reason: expect.stringContaining('no session') });
  });
});

const PICKER = join(homedir(), '.claude', 'automation', 'model_pick.py');
describe.skipIf(!existsSync(PICKER))('parity with model_pick.py --pressure', () => {
  const scenarios: Record<string, (t: number) => UsageSnapshot> = {
    'plenty everywhere': t => ({ providers: {
      codex: { fetchedAt: new Date(t).toISOString(), meters: [{ id: 'w', label: 'Weekly', usedPct: 21, windowKind: 'weekly', windowSeconds: week, resetsAt: new Date(t + 0.82 * week * 1000).toISOString() }] },
      grok: { fetchedAt: new Date(t).toISOString(), meters: [{ id: 'w', label: 'Weekly', usedPct: 10, windowKind: 'weekly', windowSeconds: week, resetsAt: new Date(t + 0.5 * week * 1000).toISOString() }] },
      minimax: { fetchedAt: new Date(t).toISOString(), meters: [{ id: 's', label: '5h', usedPct: 1, windowKind: 'session', windowSeconds: 18000, resetsAt: new Date(t + 4 * 3600000).toISOString() }] },
      openrouter: { fetchedAt: new Date(t).toISOString(), meters: [{ id: 'd', usedPct: 0, windowKind: 'daily' }], money: [{ id: 'balance', amount: 8 }] },
      claude: { fetchedAt: new Date(t).toISOString(), meters: [{ id: 'session', label: 'Session', usedPct: 46, windowKind: 'session', windowSeconds: 18000, resetsAt: new Date(t + 1800000).toISOString(), active: false }, { id: 'weekly_all', label: 'Weekly, all', usedPct: 48, windowKind: 'weekly', windowSeconds: week, resetsAt: new Date(t + 0.81 * week * 1000).toISOString(), active: true }] },
    } }),
    'one spent, one burning, one low balance': t => ({ providers: {
      codex: { fetchedAt: new Date(t).toISOString(), meters: [{ id: 'w', label: 'Weekly', usedPct: 70, windowKind: 'weekly', windowSeconds: week, resetsAt: new Date(t + 0.8 * week * 1000).toISOString() }] },
      grok: { fetchedAt: new Date(t).toISOString(), meters: [{ id: 'w', label: 'Weekly', usedPct: 100, windowKind: 'weekly', windowSeconds: week, resetsAt: new Date(t + 0.4 * week * 1000).toISOString() }] },
      openrouter: { fetchedAt: new Date(t).toISOString(), money: [{ id: 'balance', amount: 1.2 }] },
      claude: { fetchedAt: new Date(t).toISOString(), meters: [{ id: 'weekly_all', label: 'Weekly, all', usedPct: 92, windowKind: 'weekly', windowSeconds: week, resetsAt: new Date(t + 0.2 * week * 1000).toISOString() }] },
    } }),
    'stale figures and a missing provider': t => ({ providers: {
      codex: { fetchedAt: new Date(t - 3 * 3600000).toISOString(), meters: [{ id: 'w', label: 'Weekly', usedPct: 95, windowKind: 'weekly', windowSeconds: week, resetsAt: new Date(t + 0.5 * week * 1000).toISOString() }] },
      grok: { fetchedAt: new Date(t).toISOString(), meters: [{ id: 'w', label: 'Weekly', usedPct: 30, windowKind: 'weekly', windowSeconds: week, resetsAt: new Date(t + 0.05 * week * 1000).toISOString() }] },
    } }),
  };
  for (const [name, build] of Object.entries(scenarios)) {
    it(name, () => {
      const dir = mkdtempSync(join(tmpdir(), 'augur-parity-'));
      try {
        mkdirSync(dir, { recursive: true });
        const t = Date.now(), usage = build(t), p = policy();
        writeFileSync(join(dir, 'policy.json'), JSON.stringify(p));
        writeFileSync(join(dir, 'usage.json'), JSON.stringify(usage));
        const py = JSON.parse(execFileSync('python', [PICKER, '--pressure', '--json'], { encoding: 'utf8', env: { ...process.env, AUGUR_DIR: dir, PYTHONIOENCODING: 'utf-8' }, windowsHide: true })) as
          { pressure: Record<string, { headroom: number }>; factors: Record<string, number>; scarcity: number };
        const press = pressure(p, usage, new Date(t)), ts = usageFactors(p, press);
        for (const [id, h] of Object.entries(py.pressure)) expect(press[id]?.headroom, `headroom ${id}`).toBeCloseTo(h.headroom, 2);
        expect(Object.keys(ts.factors).sort()).toEqual(Object.keys(py.factors).sort());
        for (const [label, f] of Object.entries(py.factors)) expect(ts.factors[label], `factor ${label}`).toBeCloseTo(f, 1);
        expect(ts.scarcity).toBeCloseTo(py.scarcity, 1);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});
