import { describe, it, expect } from 'vitest';
import { latestOnly, listDue, modelFamily, syncModelList, setModelStatus } from '../src/models.js';
import { emptyPolicy, fieldPath, mergePolicy, setField } from '../src/policy.js';
import { parseGrokModels } from '../src/providers/grok.js';
import { claude, codex, fal, openrouter } from '../src/providers/index.js';
import type { Host } from '../src/types.js';

const t0 = new Date('2026-09-27T12:00:00Z');
const ids = (list: Array<{ id: string }>) => list.map(m => m.id);

describe('model families', () => {
  it('reads family and version from ids', () => {
    expect(modelFamily('claude-opus-4-5-20251101')).toEqual({ family: 'claude-opus', version: [4, 5] });
    expect(modelFamily('gpt-5.6-sol')).toEqual({ family: 'gpt-sol', version: [5, 6] });
    expect(modelFamily('deepseek/deepseek-v4.1-flash')).toEqual({ family: 'deepseek-deepseek-flash', version: [4, 1] });
    expect(modelFamily('grok-4.7-build-fast').family).toBe('grok-build-fast');
  });

  it('keeps only the newest version of each model', () => {
    const claudeList = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
    expect(ids(latestOnly(claudeList.map(id => ({ id }))))).toEqual(['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']);
    const codexList = ['gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'];
    expect(ids(latestOnly(codexList.map(id => ({ id }))))).toEqual(['gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.5']);
    expect(ids(latestOnly([{ id: 'claude-x-4-5-20251001' }, { id: 'claude-x-4-5' }]))).toEqual(['claude-x-4-5']);
  });
});

describe('syncing a model list into the rules', () => {
  it('adds new models for review and skips ones already listed by id', () => {
    const policy = emptyPolicy();
    policy.providers.codex = { defaults: {}, models: { 'codex/sol': { id: 'gpt-6-sol', source: 'import', status: 'confirmed', rule: { cost: 'expensive' }, firstSeen: '' } } };
    const added = syncModelList(policy, 'codex', 'codex', [{ id: 'gpt-6-sol' }, { id: 'gpt-6-luna', name: 'GPT-6-Luna' }, { id: 'gpt-5.6-luna' }], t0);
    expect(added).toEqual(['codex/gpt-6-luna']);
    expect(policy.providers.codex.models['codex/gpt-6-luna']).toMatchObject({ status: 'unreviewed', source: 'live', name: 'GPT-6-Luna', rule: {} });
    expect(syncModelList(policy, 'codex', 'codex', [{ id: 'gpt-6-luna' }], t0)).toEqual([]);
  });

  it('starts a newer version from the older one and hides the older one once confirmed', () => {
    const policy = emptyPolicy();
    policy.providers.claude = { defaults: {}, models: { 'claude/opus': { id: 'claude-opus-5-5', source: 'import', status: 'confirmed', rule: { askFirst: true, activities: { write_code: 'normal' } }, firstSeen: '' } } };
    expect(syncModelList(policy, 'claude', 'claude', [{ id: 'claude-opus-5-6' }, { id: 'claude-opus-5-5' }], t0)).toEqual(['claude/claude-opus-5-6']);
    const next = policy.providers.claude.models['claude/claude-opus-5-6']!;
    expect(next).toMatchObject({ status: 'imported', supersedes: 'claude/opus', rule: { askFirst: true, activities: { write_code: 'normal' } } });
    expect(policy.providers.claude.models['claude/opus']!.status).toBe('confirmed');
    setModelStatus(policy, 'claude', 'claude/claude-opus-5-6', 'confirmed', 'desktop', t0);
    expect(policy.providers.claude.models['claude/opus']!.status).toBe('hidden');
    expect(policy.history.map(c => c.to)).toEqual(['confirmed', 'hidden']);
  });

  it('keeps a live-added model and its copied rules when merging into another device', () => {
    const desk = emptyPolicy(), phone = emptyPolicy();
    desk.providers.claude = { defaults: {}, models: { 'claude/opus': { id: 'claude-opus-5-5', source: 'import', status: 'confirmed', rule: { cost: 'cheap' }, firstSeen: '' } } };
    phone.providers.claude = structuredClone(desk.providers.claude);
    syncModelList(desk, 'claude', 'claude', [{ id: 'claude-opus-5-6' }], t0);
    expect(mergePolicy(phone, desk).providers.claude!.models['claude/claude-opus-5-6']!.rule).toEqual({ cost: 'cheap' });
  });

  it('stores the list mode as a provider field with history', () => {
    const policy = emptyPolicy();
    setField(policy, fieldPath('openrouter', null, 'listMode'), 'auto', 'desktop', t0);
    expect(policy.providers.openrouter!.listMode).toBe('auto');
    setField(policy, fieldPath('openrouter', null, 'listMode'), undefined, 'desktop', t0);
    expect(policy.providers.openrouter!.listMode).toBeUndefined();
    expect(policy.history).toHaveLength(2);
  });

  it('reads a list again after a day', () => {
    expect(listDue(undefined, t0)).toBe(true);
    expect(listDue({ fetchedAt: '2026-09-27T00:00:00Z', models: [] }, t0)).toBe(false);
    expect(listDue({ fetchedAt: '2026-09-26T11:00:00Z', models: [] }, t0)).toBe(true);
  });
});

describe('provider model lists', () => {
  const host = (bodies: Record<string, unknown>, files: Record<string, string> = {}): Host => ({
    platform: 'windows', now: () => t0, secret: async () => 'test-only',
    readHomeFile: async path => files[path] ?? null,
    http: async req => {
      const key = Object.keys(bodies).find(k => req.url.includes(k));
      return { status: key ? 200 : 404, headers: {}, body: JSON.stringify(key ? bodies[key] : {}) };
    },
  });

  it('parses the Grok CLI list', () => {
    expect(parseGrokModels('Default model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n')).toEqual([{ id: 'grok-4.7' }, { id: 'grok-4.7-build-fast' }, { id: 'grok-4.6' }]);
  });

  it('reads the Codex model cache and drops hidden models', async () => {
    const files = { '.codex/models_cache.json': JSON.stringify({ models: [{ slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list' }, { slug: 'gpt-reserve', visibility: 'hide' }] }) };
    expect(await codex.listModels!(host({}, files), {})).toEqual([{ id: 'gpt-6-sol', name: 'GPT-6-Sol' }]);
  });

  it('reads the Claude model list with the Claude Code login', async () => {
    const files = { '.claude/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'test-only', expiresAt: t0.getTime() + 9999999 } }) };
    expect(await claude.listModels!(host({ '/v1/models': { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }] } }, files), {})).toEqual([{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }]);
  });

  it('reads the OpenRouter list and pages through fal', async () => {
    expect(await openrouter.listModels!(host({ 'openrouter.ai/api/v1/models': { data: [{ id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }] } }), {}))
      .toEqual([{ id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }]);
    let page = 0;
    const paged: Host = { ...host({}), http: async () => ({ status: 200, headers: {}, body: JSON.stringify(page++ === 0
      ? { models: [{ endpoint_id: 'fal-ai/a', metadata: { display_name: 'A', status: 'active' } }, { endpoint_id: 'fal-ai/old', metadata: { status: 'deprecated' } }], has_more: true, next_cursor: 'c2' }
      : { models: [{ endpoint_id: 'fal-ai/b', metadata: {} }], has_more: false }) }) };
    expect(await fal.listModels!(paged, {})).toEqual([{ id: 'fal-ai/a', name: 'A' }, { id: 'fal-ai/b', name: undefined }]);
    expect(openrouter.modelListMode).toBe('catalog');
  });
});
