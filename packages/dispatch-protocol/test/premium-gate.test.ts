import { describe, expect, it } from 'vitest';
import { buildPolicyFile, emptyPolicy, fieldPath, importPolicy, setField } from '@augur/core';
import { gateEvaluate, rank, paceGap, surplusEvaluate } from '../src/pick.js';
import { resolveBalance } from '../src/balance.js';
import type { PolicyFile } from '@augur/core';
import type { UsageSnapshot } from '../src/pace.js';

const now = new Date('2026-10-01T00:00:00Z'), week = 7 * 86400;
function policy(): PolicyFile {
  const stored = emptyPolicy();
  importPolicy(stored, { providers: {
    codex: {
      defaults: { askFirst: true, dataTier: 'internal', output: 'write_files' },
      models: {
        'codex/sol': { id: 'sol', rule: { activities: { write_code: 'preferred' } } },
        'codex/luna': { id: 'luna', rule: { askFirst: false, cost: 'cheap', activities: { write_code: 'normal' } } },
      },
    },
    copilot: {
      defaults: { askFirst: true, dataTier: 'internal', output: 'write_files' },
      models: {
        'copilot/gemini-4-argon': { id: 'gemini', rule: { activities: { write_code: 'preferred' } } },
        'copilot/gpt-6-luna': { id: 'luna', rule: { askFirst: false, cost: 'cheap', activities: { write_code: 'normal' } } },
      },
    },
  } }, now);
  for (const [provider, item] of Object.entries(stored.providers)) for (const label of Object.keys(item.models)) setField(stored, fieldPath(provider, label, 'status'), 'confirmed', 'test', now);
  setField(stored, fieldPath('codex', 'codex/sol', 'askFirst'), false, 'test', now);
  const noAskFirstFile = buildPolicyFile(stored, [{ id: 'codex', name: 'Codex', metered: true }, { id: 'copilot', name: 'Copilot', metered: true }], now);
  noAskFirstFile.balance = { gate: { premium: ['codex/sol', 'copilot/gemini-4-argon'], paceLift: ['codex/sol'], open: 20, close: 10 } };
  return noAskFirstFile;
}
function usage(used: number): UsageSnapshot {
  return { providers: { codex: { fetchedAt: now.toISOString(), meters: [{ id: 'weekly', windowKind: 'weekly', usedPct: used, windowSeconds: week, resetsAt: new Date(now.getTime() + week * 500).toISOString() }] } } };
}

describe('premium pace gate', () => {
  it('opens a surplus window at 12 hours and 10 unused points, then applies close hysteresis', () => {
    const meter = { id: 'weekly', windowKind: 'weekly', usedPct: 90, windowSeconds: week, resetsAt: new Date(now.getTime() + 12 * 3600000).toISOString() };
    const snapshot: UsageSnapshot = { providers: { claude: { fetchedAt: now.toISOString(), meters: [meter] } } };
    const settings = resolveBalance({}).gate.surplus;
    expect(surplusEvaluate({}, snapshot, settings, now).claude?.open).toBe(true);
    expect(surplusEvaluate({}, { providers: { claude: { fetchedAt: now.toISOString(), meters: [{ ...meter, resetsAt: new Date(now.getTime() + 13 * 3600000).toISOString() }] } } }, settings, now).claude?.open).toBe(false);
    const lower: UsageSnapshot = { providers: { claude: { fetchedAt: now.toISOString(), meters: [{ ...meter, usedPct: 96 }] } } };
    expect(surplusEvaluate({ claude: { open: true, spent: 0 } }, lower, settings, now).claude?.open).toBe(false);
  });
  it('uses pace eligible weekly meters for surplus windows', () => {
    const settings = resolveBalance({}).gate.surplus;
    const meter = (id: string, usedPct: number, active?: boolean) => ({ id, windowKind: 'weekly', usedPct, active, resetsAt: new Date(now.getTime() + 6 * 3600000).toISOString() });
    const snapshot = (meters: ReturnType<typeof meter>[]): UsageSnapshot => ({ providers: { claude: { fetchedAt: now.toISOString(), meters } } });
    expect(surplusEvaluate({}, snapshot([meter('weekly_scoped_fable', 0)]), settings, now).claude?.open).toBe(false);
    expect(surplusEvaluate({}, snapshot([meter('weekly', 90, false)]), settings, now).claude?.open).toBe(true);
  });
  it('drops configured Codex and Copilot countdowns instead of evaluating their meters', () => {
    const snap: UsageSnapshot = { providers: Object.fromEntries(['codex', 'copilot'].map(provider => [provider, { fetchedAt: now.toISOString(), meters: [{ id: 'week', windowKind: 'weekly', usedPct: 0, windowSeconds: week, resetsAt: new Date(now.getTime() + 3600000).toISOString() }] }])) };
    const resolved = resolveBalance({ gate: { surplus: { countdown: ['codex', 'copilot'] } } });
    expect(resolved.gate.surplus.countdown).toEqual([]);
    expect(surplusEvaluate({}, snap, resolved.gate.surplus, now)).toEqual({});
    expect(resolved.notes).toContain('Codex and Copilot countdown entries in gate.surplus.countdown are ignored.');
  });
  it('accepts provider aliases and resolves them to the label prefix', () => {
    const resolved = resolveBalance({ gate: { surplus: { countdown: ['Codex', 'copilot', 'grok'] } } });
    expect(resolved.gate.surplus.countdown).toEqual(['xai']);
    expect(resolved.notes).toContain('Codex and Copilot countdown entries in gate.surplus.countdown are ignored.');
  });
  it('stores the opening reset, closes at that reset, and resets spent only on a real reopen', () => {
    const settings = resolveBalance({}).gate.surplus, reset = new Date(now.getTime() + 6 * 3600000).toISOString();
    const snapshot = (pct: number, until: string, fetchedAt = now): UsageSnapshot => ({ providers: { claude: { fetchedAt: fetchedAt.toISOString(), meters: [{ id: 'weekly', windowKind: 'weekly', usedPct: pct, windowSeconds: week, resetsAt: until }] } } });
    const opened = surplusEvaluate({}, snapshot(90, reset), settings, now).claude!;
    expect(opened).toMatchObject({ open: true, resetsAt: reset });
    const spent = { claude: { open: true, spent: 7, resetsAt: reset } };
    const afterReset = new Date(Date.parse(reset) + 1000);
    const closed = surplusEvaluate(spent, snapshot(80, new Date(afterReset.getTime() + week * 1000).toISOString(), afterReset), settings, afterReset).claude!;
    expect(closed.open).toBe(false);
    expect(closed.budgetLeft).toBe(15);
    const resetReopen = surplusEvaluate(spent, snapshot(90, new Date(afterReset.getTime() + 6 * 3600000).toISOString(), afterReset), settings, afterReset).claude!;
    expect(resetReopen).toMatchObject({ open: true, resetsAt: new Date(afterReset.getTime() + 6 * 3600000).toISOString() });
    expect(surplusEvaluate({}, snapshot(90, new Date(now.getTime() - 1000).toISOString()), settings, now).claude?.open).toBe(false);
    const reopened = surplusEvaluate({ claude: { open: false, spent: 7, resetsAt: reset } }, snapshot(90, new Date(afterReset.getTime() + 6 * 3600000).toISOString(), afterReset), settings, afterReset).claude!;
    expect(reopened).toMatchObject({ open: true, budgetLeft: 5 });
    expect(surplusEvaluate({ claude: { open: true, spent: 500, resetsAt: reset } }, snapshot(90, reset), settings, now).claude?.budgetLeft).toBe(0);
  });
  it('keeps a stale open window until its stored reset but refuses new opening from stale or old readings', () => {
    const settings = resolveBalance({}).gate.surplus, reset = new Date(now.getTime() + 6 * 3600000).toISOString();
    const stale: UsageSnapshot = { providers: { claude: { fetchedAt: new Date(now.getTime() - 121 * 60000).toISOString(), stale: true, meters: [{ id: 'weekly', windowKind: 'weekly', usedPct: 90, resetsAt: reset }] } } };
    expect(surplusEvaluate({}, stale, settings, now).claude?.open).toBe(false);
    expect(surplusEvaluate({ claude: { open: true, spent: 2, resetsAt: reset } }, stale, settings, now).claude).toMatchObject({ open: true, stale: true });
    expect(surplusEvaluate({ claude: { open: true, spent: 2, resetsAt: reset } }, stale, settings, new Date(Date.parse(reset) + 1)).claude?.open).toBe(false);
    const p = policy();
    p.providers.claude = { ...p.providers.codex!, models: { 'claude/opus': { ...p.providers.codex!.models['codex/sol']!, id: 'opus', askFirst: true } } };
    p.balance = { gate: { premium: ['claude/opus'], paceLift: ['claude/opus'], surplus: { hours: 12, open: 10, close: 5, margin: 5, countdown: ['claude'] } } };
    const blocked = rank(p, stale, { activity: 'write_code', dataTier: 'internal', surplusState: { claude: { open: true, spent: 0, resetsAt: reset } } }, now);
    expect(blocked.ranking.map(row => row.model)).not.toContain('claude/opus');
    const spent = rank(p, usage(30), { activity: 'write_code', dataTier: 'internal', surplusState: { claude: { open: true, spent: 100, resetsAt: reset } } }, now);
    expect(spent.ranking.map(row => row.model)).not.toContain('claude/opus');
  });
  it('uses the Grok usage id with an xai/grok route and accepts zero hours', () => {
    const settings = resolveBalance({ gate: { surplus: { countdown: ['grok'], hours: 0 } } }).gate.surplus;
    const snap: UsageSnapshot = { providers: { grok: { fetchedAt: now.toISOString(), meters: [{ id: 'supergrok', windowKind: 'weekly', usedPct: 90, resetsAt: new Date(now.getTime() + 1).toISOString() }] } } };
    expect(settings.countdown).toEqual(['xai']);
    expect(settings.hours).toBe(0);
    expect(surplusEvaluate({}, snap, settings, now).xai?.open).toBe(false);
    expect(surplusEvaluate({ xai: { open: true, spent: 1, resetsAt: new Date(now.getTime() + 3600000).toISOString() } }, snap, settings, now).xai?.open).toBe(false);
    const p = emptyPolicy();
    importPolicy(p, { providers: { xai: { defaults: { askFirst: true, dataTier: 'internal', output: 'write_files' }, models: { 'xai/grok': { id: 'grok', rule: { activities: { write_code: 'preferred' } } } } } } }, now);
    setField(p, fieldPath('xai', 'xai/grok', 'status'), 'confirmed', 'test', now);
    const routePolicy = buildPolicyFile(p, [{ id: 'xai', name: 'Grok', metered: true }], now);
    routePolicy.balance = { gate: { premium: ['xai/grok'], paceLift: ['xai/grok'], surplus: { hours: 12, open: 10, close: 5, margin: 5, countdown: ['grok'] } } };
    const liveSettings = resolveBalance(routePolicy.balance).gate.surplus;
    const live = rank(routePolicy, { providers: { grok: { fetchedAt: now.toISOString(), meters: [{ id: 'supergrok', windowKind: 'weekly', usedPct: 90, resetsAt: new Date(now.getTime() + 6 * 3600000).toISOString() }] } } }, { activity: 'write_code', dataTier: 'internal' }, now);
    expect(liveSettings.countdown).toEqual(['xai']);
    expect(live.surplus.xai?.open).toBe(true);
    expect(live.ranking.map(row => row.model)).toContain('xai/grok');
  });
  it('uses the provider id for pace and surplus lifts when the model label has another prefix', () => {
    const p = policy();
    p.providers.grok = { ...p.providers.codex!, models: { 'xai/grok': { ...p.providers.codex!.models['codex/sol']!, id: 'grok', askFirst: true } } };
    delete p.providers.codex;
    p.balance = { gate: { premium: ['xai/grok'], paceLift: ['xai/grok'], open: 20, close: 10, surplus: { hours: 12, open: 10, close: 5, margin: 5, countdown: ['grok'] } } };
    const pace: UsageSnapshot = { providers: { grok: { fetchedAt: now.toISOString(), meters: [{ id: 'weekly', windowKind: 'weekly', usedPct: 0, windowSeconds: week, resetsAt: new Date(now.getTime() + week / 2 * 1000).toISOString() }] } } };
    const surplus: UsageSnapshot = { providers: { grok: { fetchedAt: now.toISOString(), meters: [{ id: 'weekly', windowKind: 'weekly', usedPct: 90, windowSeconds: week, resetsAt: new Date(now.getTime() + 6 * 3600000).toISOString() }] } } };
    for (const snapshot of [pace, surplus]) {
      const picked = rank(p, snapshot, { activity: 'write_code', dataTier: 'internal' }, now);
      expect(picked.gateState.xai || picked.surplus.xai?.open).toBe(true);
      expect(picked.ranking.map(row => row.model)).toContain('xai/grok');
      const automated = rank(p, snapshot, { activity: 'write_code', dataTier: 'internal', caller: 'automated' }, now);
      expect(automated.ranking.map(row => row.model)).not.toContain('xai/grok');
    }
  });
  it('keeps pick and run lift conditions in agreement for every provider window state', () => {
    const p = policy();
    p.providers.grok = { ...p.providers.codex!, models: { 'xai/grok': { ...p.providers.codex!.models['codex/sol']!, id: 'grok', askFirst: true } } };
    delete p.providers.codex;
    p.balance = { gate: { premium: ['xai/grok'], paceLift: ['xai/grok'], open: 20, close: 10, surplus: { hours: 12, open: 10, close: 5, margin: 5, countdown: ['grok'] } } };
    const reset = new Date(now.getTime() + 6 * 3600000).toISOString();
    const snapshot: UsageSnapshot = { providers: { grok: { fetchedAt: now.toISOString(), meters: [{ id: 'weekly', windowKind: 'weekly', usedPct: 90, windowSeconds: week, resetsAt: reset }] } } };
    const cases = [
      { name: 'open', window: { open: true, spent: 0, resetsAt: reset } },
      { name: 'spent', window: { open: true, spent: 100, resetsAt: reset } },
      { name: 'stale', window: { open: true, spent: 0, resetsAt: reset }, stale: true },
      { name: 'closed', window: { open: false, spent: 0, resetsAt: reset } },
      { name: 'reset passed', window: { open: true, spent: 0, resetsAt: new Date(now.getTime() - 1).toISOString() } },
      { name: 'named', window: { open: true, spent: 0, resetsAt: reset }, named: true },
      { name: 'automated', window: { open: true, spent: 0, resetsAt: reset }, automated: true },
    ];
    for (const state of cases) {
      const source = state.stale ? { providers: { grok: { ...snapshot.providers.grok!, stale: true } } }
        : state.name === 'closed' ? { providers: { grok: { ...snapshot.providers.grok!, meters: [{ ...snapshot.providers.grok!.meters![0]!, usedPct: 96 }] } } }
          : state.name === 'reset passed' ? { providers: { grok: { ...snapshot.providers.grok!, meters: [{ ...snapshot.providers.grok!.meters![0]!, resetsAt: new Date(now.getTime() - 1000).toISOString() }] } } }
            : snapshot;
      const result = rank(p, source, { activity: 'write_code', dataTier: 'internal', ...(state.named ? { named: 'xai/grok' } : {}), caller: state.automated ? 'automated' : 'interactive', surplusState: { xai: state.window } }, now);
      const pickLift = result.ranking.some(row => row.model === 'xai/grok') && !state.named && !state.automated;
      const runLift = !state.named && !state.automated && (result.gateState.xai === true || !!result.surplus.xai?.open && !result.surplus.xai.spent && !result.surplus.xai.stale);
      expect(pickLift, state.name).toBe(state.name === 'open');
      expect(pickLift, state.name).toBe(runLift);
    }
  });
  it('reports budget remaining after the margin and spent points', () => {
    const snap: UsageSnapshot = { providers: { claude: { fetchedAt: now.toISOString(), meters: [{ id: 'week', windowKind: 'weekly', usedPct: 70, windowSeconds: week, resetsAt: new Date(now.getTime() + 3600000).toISOString() }] } } };
    expect(surplusEvaluate({ claude: { open: true, spent: 20 } }, snap, resolveBalance({}).gate.surplus, now).claude?.budgetLeft).toBe(5);
  });
  it('evaluates hysteresis without writing and honors configured thresholds', () => {
    const rules = resolveBalance({ gate: { premium: ['codex/sol'], paceLift: ['codex/sol'], open: 20, close: 10 } }).gate;
    expect(gateEvaluate({}, usage(30), rules, now).state.codex).toBe(true);
    expect(gateEvaluate({ codex: true }, usage(35), rules, now).state.codex).toBe(true);
    expect(gateEvaluate({ codex: true }, usage(41), rules, now).state.codex).toBe(false);
  });
  it('opens at 20 points, stays open at 15, and closes below 10', () => {
    expect(paceGap(usage(30), 'codex', now)).toBe(20);
    expect(rank(policy(), usage(30), { activity: 'write_code', dataTier: 'internal' }, now).gateState.codex).toBe(true);
    expect(rank(policy(), usage(35), { activity: 'write_code', dataTier: 'internal' }, now).gateState.codex).toBe(false);
    expect(rank(policy(), usage(35), { activity: 'write_code', dataTier: 'internal', gateState: { codex: true } }, now).gateState.codex).toBe(true);
    expect(rank(policy(), usage(41), { activity: 'write_code', dataTier: 'internal', gateState: { codex: true } }, now).gateState.codex).toBe(false);
  });
  it('does not emit a lift note for a premium route outside paceLift', () => {
    const p = policy();
    p.providers.codex!.models['codex/luna']!.askFirst = true;
    p.balance = { gate: { premium: ['codex/sol', 'codex/luna'], paceLift: ['codex/sol'], open: 20, close: 10 } };
    const result = rank(p, usage(30), { activity: 'write_code', dataTier: 'internal' }, now);
    expect(result.notes.filter(note => note.includes('ask-first lifted: codex'))).toHaveLength(1);
  });
  it('lifts ask-first only for an interactive paceLift route, never for Copilot', () => {
    const p = policy(), snap = usage(30);
    expect(rank(p, snap, { activity: 'write_code', dataTier: 'internal' }, now).ranking.map(r => r.model)).toContain('codex/sol');
    const automated = rank(p, snap, { activity: 'write_code', dataTier: 'internal', caller: 'automated', named: 'codex/sol' }, now);
    expect(automated.ranking.map(r => r.model)).not.toContain('codex/sol');
    expect(automated.blocked).toContainEqual({ model: 'codex/sol', why: 'premium models are not used for automated tasks' });
    expect(rank(p, snap, { activity: 'write_code', dataTier: 'internal', gateState: { codex: true, copilot: true } }, now).ranking.map(r => r.model)).not.toContain('copilot/gemini-4-argon');
  });

  it('does not report an ask-first lift for the premium model the caller named', () => {
    const p = policy(), snap = usage(30);
    const named = rank(p, snap, { activity: 'write_code', dataTier: 'internal', named: 'codex/sol', surplusState: { codex: { open: true, spent: 0, resetsAt: new Date(now.getTime() + 6 * 3600000).toISOString() } } }, now);
    expect(named.ranking.map(row => row.model)).toContain('codex/sol');
    expect(named.notes.filter(note => note.startsWith('ask-first lifted: '))).toEqual([]);
    const unnamed = rank(p, snap, { activity: 'write_code', dataTier: 'internal', surplusState: { codex: { open: true, spent: 0, resetsAt: new Date(now.getTime() + 6 * 3600000).toISOString() } } }, now);
    expect(unnamed.notes.some(note => note.startsWith('ask-first lifted: codex '))).toBe(true);
  });

  it('gates a premium label with askFirst disabled unless named or pace-lifted', () => {
    const p = policy(), closed = rank(p, null, { activity: 'write_code', dataTier: 'internal' }, now);
    expect(p.providers.codex?.models['codex/sol']?.askFirst).toBe(false);
    expect(closed.ranking.map(r => r.model)).not.toContain('codex/sol');
    expect(closed.blocked).toContainEqual({ model: 'codex/sol', why: 'ask-first: owner approval required' });
    expect(rank(p, null, { activity: 'write_code', dataTier: 'internal', named: 'codex/sol' }, now).ranking.map(r => r.model)).toContain('codex/sol');
    expect(rank(p, usage(30), { activity: 'write_code', dataTier: 'internal' }, now).ranking.map(r => r.model)).toContain('codex/sol');
  });

  it('drops Copilot pace lifts and reports the reason', () => {
    const resolved = resolveBalance({ gate: { premium: ['copilot/gemini-4-argon'], paceLift: ['copilot/gemini-4-argon'], open: 20, close: 10 } });
    expect(resolved.gate.paceLift).toEqual([]);
    expect(resolved.notes).toContain('Copilot labels in gate.paceLift are ignored; Copilot premium models remain gated.');
  });
});
