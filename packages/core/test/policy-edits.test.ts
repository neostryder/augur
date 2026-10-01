import { describe, it, expect } from 'vitest';
import { applyEdit, checkEdit, editKind, emptyEditState, parseEditState, parseInbox, previewEdits, processInbox, resolveHeld, resolvedValue } from '../src/policy-edits.js';
import type { PolicyEdit } from '../src/policy-edits.js';
import { buildPolicyFile, emptyPolicy, migratePolicy } from '../src/policy.js';
import type { PolicyConfig } from '../src/policy.js';

const now = new Date('2026-10-01T00:30:00Z');
const policy = (): PolicyConfig => migratePolicy({ providers: {
  minimax: { defaults: { activities: { review_code: 'often', long_context: 'normal' }, cost: 'free' }, thresholds: { warnPct: 90 },
    models: { 'minimax/m3': { id: 'MiniMax-M3', source: 'manual', status: 'confirmed', rule: { dataTier: 'public', askFirst: false, notes: 'Non-sensitive work.' } } } },
  codex: { defaults: {}, models: { 'codex/sol': { id: 'gpt-6.1-sol', source: 'import', status: 'confirmed', rule: { dataTier: 'internal' } } } },
} });
const edit = (over: Partial<PolicyEdit>): PolicyEdit => ({ id: 'e1', at: now.toISOString(), by: 'Claude Admin', provider: 'minimax', model: 'minimax/m3', field: 'activities.long_context', value: 'preferred', ...over });
const has = (p: PolicyConfig) => (provider: string, model: string) => !!p.providers[provider]?.models[model];

describe('which edits apply at once', () => {
  it('applies weights, pauses, notes and hold rules, and holds the rest for the owner', () => {
    for (const f of ['activities.review_code', 'pause', 'notes', 'useAfter']) expect(editKind(f)).toBe('direct');
    for (const f of ['dataTier', 'askFirst', 'output', 'sandbox', 'effort', 'cost', 'status', 'dataHandling.hostCountry', 'thresholds.denyPct']) expect(editKind(f)).toBe('confirm');
    for (const f of ['activities.cooking', 'dataHandling', 'listMode', 'name', 'thresholds.nope']) expect(editKind(f)).toBeNull();
  });
});

describe('checking an edit', () => {
  const p = policy();
  it('accepts well-formed values and names what is wrong with the rest', () => {
    expect(checkEdit(edit({}), has(p))).toBeNull();
    expect(checkEdit(edit({ field: 'activities.long_context', value: null }), has(p))).toBeNull();
    expect(checkEdit(edit({ value: 'sometimes' }), has(p))).toMatch(/activity takes/);
    expect(checkEdit(edit({ field: 'dataTier', value: 'secret' }), has(p))).toMatch(/dataTier is one of/);
    expect(checkEdit(edit({ model: 'minimax/none' }), has(p))).toMatch(/not in the rules/);
    expect(checkEdit(edit({ model: '' }), has(p))).toMatch(/names a model/);
    expect(checkEdit(edit({ field: 'pause', value: { until: 'tomorrow' } }), has(p))).toMatch(/ISO time/);
    expect(checkEdit(edit({ field: 'useAfter', value: ['minimax/m3'] }), has(p))).toMatch(/wait on itself/);
    expect(checkEdit(edit({ field: 'status', value: 'inherit' }), has(p))).toMatch(/no default/);
  });
  it('treats thresholds as provider-level', () => {
    expect(checkEdit(edit({ field: 'thresholds.denyPct', model: '', value: 95 }), has(p))).toBeNull();
    expect(checkEdit(edit({ field: 'thresholds.denyPct', value: 95 }), has(p))).toMatch(/belong to a provider/);
    expect(checkEdit(edit({ field: 'thresholds.denyPct', model: '', value: 140 }), has(p))).toMatch(/percentage/);
  });
});

describe('processing the inbox', () => {
  it('applies a direct edit through the rules, with before and after, and records it in the history', () => {
    const p = policy();
    const r = processInbox(p, [edit({}), edit({ id: 'e2', field: 'activities.bulk_tagging', value: 'often' })], emptyEditState(), 'desktop', now);
    expect(r.changed).toBe(true);
    expect(r.state.results.map(x => [x.id, x.status, x.before, x.after])).toEqual([['e1', 'applied', 'normal', 'preferred'], ['e2', 'applied', null, 'often']]);
    expect(resolvedValue(p, edit({}))).toBe('preferred');
    expect(p.history.map(h => h.path)).toContain('minimax|minimax/m3|activities.long_context');
    expect(p.providers.minimax!.defaults.activities!.long_context).toBe('normal');
  });
  it('holds a data-access edit until the owner accepts it, and leaves the rules alone meanwhile', () => {
    const p = policy();
    const r = processInbox(p, [edit({ id: 'h1', field: 'dataTier', value: 'internal' })], emptyEditState(), 'desktop', now);
    expect(r.changed).toBe(false);
    expect(r.newlyHeld.map(h => h.id)).toEqual(['h1']);
    expect(r.state.results[0]).toMatchObject({ status: 'held', before: 'public', after: 'internal' });
    expect(resolvedValue(p, edit({ field: 'dataTier' }))).toBe('public');
    const accepted = resolveHeld(p, r.state, 'h1', true, 'desktop', now);
    expect(accepted.changed).toBe(true);
    expect(accepted.state.held).toEqual([]);
    expect(resolvedValue(p, edit({ field: 'dataTier' }))).toBe('internal');
    expect(accepted.state.results.at(-1)).toMatchObject({ status: 'applied', before: 'public', after: 'internal' });
  });
  it('lets the owner dismiss a held edit', () => {
    const p = policy();
    const held = processInbox(p, [edit({ id: 'h2', field: 'sandbox', value: false })], emptyEditState(), 'desktop', now).state;
    const r = resolveHeld(p, held, 'h2', false, 'desktop', now);
    expect(r.changed).toBe(false);
    expect(r.state.results.at(-1)?.status).toBe('dismissed');
  });
  it('confirming a replacement model hides the one it replaces', () => {
    const p = policy();
    p.providers.codex!.models['codex/new'] = { id: 'gpt-7', source: 'live', status: 'imported', rule: {}, firstSeen: now.toISOString(), supersedes: 'codex/sol' };
    const held = processInbox(p, [edit({ id: 's1', provider: 'codex', model: 'codex/new', field: 'status', value: 'confirmed' })], emptyEditState(), 'desktop', now).state;
    resolveHeld(p, held, 's1', true, 'desktop', now);
    expect(p.providers.codex!.models['codex/sol']!.status).toBe('hidden');
  });
  it('rejects an invalid edit with the reason, and looks at each edit only once', () => {
    const p = policy();
    const bad = edit({ id: 'b1', value: 'sometimes' });
    const first = processInbox(p, [bad], emptyEditState(), 'desktop', now);
    expect(first.state.results[0]).toMatchObject({ status: 'rejected' });
    expect(first.state.results[0]!.reason).toMatch(/activity takes/);
    const again = processInbox(p, [bad], first.state, 'desktop', now);
    expect(again.state.results).toHaveLength(1);
  });
  it('puts a field back to the provider default with inherit', () => {
    const p = policy();
    processInbox(p, [edit({ value: 'preferred' })], emptyEditState(), 'desktop', now);
    const r = processInbox(p, [edit({ id: 'i1', value: 'inherit' })], emptyEditState(), 'desktop', now);
    expect(r.state.results.at(-1)).toMatchObject({ status: 'applied', before: 'preferred', after: 'normal' });
  });
});

describe('reading the files', () => {
  it('skips lines that are not edits, and survives a missing or broken state file', () => {
    const text = [JSON.stringify(edit({})), 'not json', JSON.stringify({ id: 'x' }), '', JSON.stringify(edit({ id: 'e9', reason: 'r' }))].join('\n');
    expect(parseInbox(text).map(e => e.id)).toEqual(['e1', 'e9']);
    expect(parseInbox(null)).toEqual([]);
    expect(parseEditState(null)).toEqual(emptyEditState());
    expect(parseEditState('{broken')).toEqual(emptyEditState());
    const round = parseEditState(JSON.stringify({ seen: ['a'], results: [], held: [edit({ id: 'h' })] }));
    expect(round.held[0]!.id).toBe('h');
  });
});

describe('previewing edits on policy.json', () => {
  const file = buildPolicyFile(policy(), [{ id: 'minimax', name: 'MiniMax', metered: false }, { id: 'codex', name: 'Codex', metered: false }], now);
  it('applies edits to a copy and leaves the original alone', () => {
    const r = previewEdits(file, [edit({ field: 'dataTier', value: 'internal' }), edit({ field: 'activities.long_context', value: null })]);
    expect(r.applied).toBe(2);
    expect(r.file.providers.minimax!.models['minimax/m3']!.dataTier).toBe('internal');
    expect(r.file.providers.minimax!.models['minimax/m3']!.activities.long_context).toBeUndefined();
    expect(file.providers.minimax!.models['minimax/m3']!.dataTier).toBe('public');
  });
  it('lists the edits it cannot apply', () => {
    const r = previewEdits(file, [edit({ model: 'minimax/none' }), edit({ value: 'inherit' }), edit({ field: 'cooking', value: 1 })]);
    expect(r.applied).toBe(0);
    expect(r.problems).toHaveLength(3);
  });
});

describe('applyEdit', () => {
  it('works on an empty policy without throwing', () => {
    expect(() => applyEdit(emptyPolicy(), edit({}), 'desktop', now)).not.toThrow();
  });
});
