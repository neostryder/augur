import { describe, expect, it } from 'vitest';
import { checkDraft, draftOf, emptyDraft, parseRoutesText, writeRoute } from '../src/routes-model';

const FILE = JSON.stringify({ note: 'kept', routes: { luna: { model: 'codex/luna', adapter: 'codex-exec', options: { effort: 'high' }, notes: 'fast', extra: 1 }, 'Bad Name': { model: 'x/y', adapter: 'exec' }, broken: { adapter: 'exec' } } });

describe('reading routes.json', () => {
  it('treats a missing or empty file as no routes', () => {
    expect(parseRoutesText(null)).toMatchObject({ ok: true, file: { routes: [], skipped: [] } });
    expect(parseRoutesText('  ')).toMatchObject({ ok: true, file: { routes: [] } });
  });

  it('lists the routes the service accepts and names the entries it skips', () => {
    const p = parseRoutesText(FILE);
    expect(p.ok && p.file.routes.map(r => r.name)).toEqual(['luna']);
    expect(p.ok && p.file.skipped).toEqual(['Bad Name', 'broken']);
  });

  it('reports a file that is not JSON instead of pretending it is empty', () => {
    expect(parseRoutesText('{ nope')).toMatchObject({ ok: false });
    expect(parseRoutesText('[]')).toMatchObject({ ok: false });
  });
});

describe('checking a route before it is saved', () => {
  const good = () => ({ ...emptyDraft(), name: 'sol', model: 'codex/sol', adapter: 'copilot-exec', options: { model: 'gpt-6-sol' } });

  it('needs no key variable when the key is kept in the credential store', () => {
    const api = { ...emptyDraft(), name: 'chat', model: 'openai/gpt', adapter: 'openai-api', options: { baseUrl: 'https://api.example.com/v1', model: 'x' } };
    expect(checkDraft(api, [], true)).toContain('Key variable');
    expect(checkDraft({ ...api, options: { ...api.options, keySource: 'store' } }, [], true)).toBeNull();
    expect(checkDraft({ ...api, options: { ...api.options, keySource: 'vault' } }, [], true)).toContain('one of env, store');
  });

  it('checks the budget and fallback fields, and writes them beside the route', () => {
    const d = { ...good(), name: 'luna', budgetUsd: '5', budgetJobs: '', budgetPer: 'week', fallback: 'sol, grok' };
    expect(checkDraft({ ...d, budgetUsd: '-2' }, ['sol', 'grok'], true)).toContain('dollar budget');
    expect(checkDraft({ ...d, budgetJobs: '2.5' }, ['sol', 'grok'], true)).toContain('job budget');
    expect(checkDraft(d, ['sol'], true)).toContain('grok is not a route yet');
    expect(checkDraft({ ...d, name: 'sol' }, ['sol', 'grok'], false)).toContain('its own fallback');
    expect(checkDraft(d, ['sol', 'grok'], true)).toBeNull();
    const file = parseRoutesText('{"routes":{"luna":{"model":"codex/luna","adapter":"codex-exec"}}}');
    if (!file.ok) throw new Error('fixture');
    const out = JSON.parse(writeRoute(file.file, 'luna', d)).routes.luna;
    expect(out).toMatchObject({ budget: { per: 'week', usd: 5 }, fallback: ['sol', 'grok'] });
    expect(out.budget.jobs).toBeUndefined();
    const cleared = JSON.parse(writeRoute(file.file, 'luna', { ...d, budgetUsd: '', fallback: '' })).routes.luna;
    expect(cleared.budget).toBeUndefined();
    expect(cleared.fallback).toBeUndefined();
    const again = parseRoutesText(writeRoute(file.file, 'luna', d));
    if (!again.ok) throw new Error('fixture');
    expect(draftOf(again.file.routes[0]!)).toMatchObject({ budgetUsd: '5', budgetJobs: '', budgetPer: 'week', fallback: 'sol, grok' });
  });

  it('accepts a complete route', () => expect(checkDraft(good(), ['luna'], true)).toBeNull());

  it('rejects names the service would ignore, and a name that is taken', () => {
    expect(checkDraft({ ...good(), name: 'Sol' }, [], true)).toContain('lowercase');
    expect(checkDraft({ ...good(), name: 'luna' }, ['luna'], true)).toContain('already exists');
    expect(checkDraft({ ...good(), name: 'luna' }, ['luna'], false)).toBeNull();
  });

  it('needs a provider/model label and every required option', () => {
    expect(checkDraft({ ...good(), model: 'sol' }, [], true)).toContain('provider/model');
    expect(checkDraft({ ...good(), options: {} }, [], true)).toContain('Model is required');
  });

  it('checks numbers, choices and JSON options', () => {
    const api = { ...emptyDraft(), name: 'api', model: 'openai/x', adapter: 'openai-api', options: { baseUrl: 'https://a.example/v1', model: 'm', apiKeyEnv: 'KEY' } };
    expect(checkDraft(api, [], true)).toBeNull();
    expect(checkDraft({ ...api, options: { ...api.options, maxTokens: 'lots' } }, [], true)).toContain('number');
    const exec = { ...emptyDraft(), name: 'e', model: 'x/y', adapter: 'exec', options: { command: 'cmd', stdin: 'sometimes' } };
    expect(checkDraft(exec, [], true)).toContain('one of');
    expect(checkDraft({ ...exec, options: { command: 'cmd', argsJson: '{}' } }, [], true)).toContain('JSON array');
  });
});

describe('writing a route back', () => {
  const file = () => { const p = parseRoutesText(FILE); if (!p.ok) throw new Error('bad fixture'); return p.file; };

  it('keeps unrelated keys, skipped entries and unknown fields on the route being edited', () => {
    const f = file();
    const draft = { ...draftOf(f.routes[0]!), options: { effort: 'low' } };
    const out = JSON.parse(writeRoute(f, 'luna', draft)) as { note: string; routes: Record<string, Record<string, unknown>> };
    expect(out.note).toBe('kept');
    expect(Object.keys(out.routes)).toEqual(['luna', 'Bad Name', 'broken']);
    expect(out.routes.luna).toMatchObject({ extra: 1, options: { effort: 'low' }, notes: 'fast' });
  });

  it('stores numbers as numbers, drops empty options, and can remove a route', () => {
    const f = file();
    const grok = { ...emptyDraft(), name: 'grok', model: 'xai/grok', adapter: 'grok-exec', options: { model: 'grok-4.7', maxTurns: '80', effort: '' }, delegation: true };
    const added = JSON.parse(writeRoute(f, 'grok', grok)) as { routes: Record<string, { options: Record<string, unknown>; delegation?: boolean }> };
    expect(added.routes.grok).toMatchObject({ options: { model: 'grok-4.7', maxTurns: 80 }, delegation: true });
    expect(added.routes.grok!.options).not.toHaveProperty('effort');
    const removed = JSON.parse(writeRoute(f, 'luna', null)) as { routes: Record<string, unknown> };
    expect(Object.keys(removed.routes)).not.toContain('luna');
  });
});
