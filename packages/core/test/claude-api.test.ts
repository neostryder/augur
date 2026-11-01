import { describe, expect, it, vi } from 'vitest';
import { claudeApi } from '../src/providers/claude-api.js';
import { migrateConfig } from '../src/config.js';
import { allPlugins, policyProviders, secretNames } from '../src/registry.js';
import type { Host } from '../src/types.js';

describe('Claude API settings provider', () => {
  it('registers the key with the existing store and keeps rules unmetered', () => {
    const config = migrateConfig({});
    expect(allPlugins(config).find(plugin => plugin.id === 'claude-api')?.name).toBe('Claude API');
    expect(secretNames(config)).toContain('claude-api.apiKey');
    expect(policyProviders(config).filter(provider => provider.id === 'claude-api')).toEqual([{ id: 'claude-api', name: 'Claude API', metered: false }]);
  });

  it('tests the saved key only against its provider, without returning credentials', async () => {
    const secret = vi.fn(async () => 'fixture-key'), http = vi.fn(async () => ({ status: 200, body: '{"data":[]}' }));
    const result = await claudeApi.testKey!({ secret, http } as unknown as Host, {});
    expect(secret).toHaveBeenCalledWith('claude-api.apiKey');
    expect(http).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://api.anthropic.com/v1/models?limit=1', headers: { 'x-api-key': 'fixture-key', 'anthropic-version': '2023-06-01' } }));
    expect(result).toEqual({ meters: [], money: [] });
    expect(JSON.stringify(result)).not.toContain('fixture-key');
  });

  it('does not call the network without a saved key and rejects a failed test', async () => {
    const http = vi.fn();
    await expect(claudeApi.testKey!({ secret: async () => null, http } as unknown as Host, {})).rejects.toThrow('No API key');
    expect(http).not.toHaveBeenCalled();
    await expect(claudeApi.testKey!({ secret: async () => 'fixture-key', http: async () => { throw new Error('fixture-key'); } } as unknown as Host, {})).rejects.not.toThrow('fixture-key');
  });

  it('keeps ordinary and forced usage refreshes offline', async () => {
    const http = vi.fn(), secret = vi.fn();
    for (const force of [false, true]) expect(await claudeApi.fetch({ secret, http } as unknown as Host, {}, { force })).toEqual({ meters: [], money: [] });
    expect(http).not.toHaveBeenCalled(); expect(secret).not.toHaveBeenCalled();
  });

  it('preserves the effect preferences when settings are read again', () => {
    expect(migrateConfig({ layout: { nodeView: { sheen: false, animation: false, ticks: false } } }).layout.nodeView).toEqual({ sheen: false, animation: false, ticks: false });
  });
});

describe('catalog pages', () => {
  it.each([
    [{ data: [{ id: 'a' }], has_more: false, last_id: 'a' }],
    [{ data: [], has_more: true }],
    [{ data: [{ id: 'a' }], has_more: true, last_id: 'a' }, { data: [], has_more: true, last_id: 'a' }],
    [{ data: [{ id: 'a' }], has_more: true, last_id: 'a' }, { data: [{ id: 'b' }], has_more: true, last_id: 'b' }, { data: [], has_more: true, last_id: 'a' }],
  ])('stops at terminal or repeated cursors: %j', async (...pages) => {
    const http = vi.fn(async (_request: { url: string }) => ({ status: 200, body: JSON.stringify(pages[Math.min(http.mock.calls.length - 1, pages.length - 1)]) }));
    await claudeApi.listModels!({ secret: async () => 'fixture', http } as unknown as Host, {});
    expect(http).toHaveBeenCalledTimes(pages.length);
    if (pages.length > 1) expect(http.mock.calls[1]?.[0]?.url).toContain('after_id=a');
  });
});

it.each(['sheen', 'animation', 'ticks'] as const)('keeps %s after a serialized restart', key => {
  const config = migrateConfig({}); config.layout.nodeView![key] = false;
  const restarted = migrateConfig(JSON.parse(JSON.stringify(config)));
  expect(restarted.layout.nodeView).toEqual({ sheen: key !== 'sheen', animation: key !== 'animation', ticks: key !== 'ticks' });
});

it('caps catalog traversal and stops on an empty page with a cursor', async () => {
  let page = 0;
  const http = vi.fn(async () => ({ status: 200, body: JSON.stringify({ data: Array.from({ length: 100 }, (_, index) => ({ id: `entry-${page}-${index}` })), has_more: true, last_id: String(++page) }) }));
  expect(await claudeApi.listModels!({ secret: async () => 'fixture', http } as unknown as Host, {})).toHaveLength(10000);
  expect(http).toHaveBeenCalledTimes(100);
  const empty = vi.fn(async () => ({ status: 200, body: JSON.stringify({ data: [], has_more: empty.mock.calls.length === 1, last_id: String(++page) }) }));
  await claudeApi.listModels!({ secret: async () => 'fixture', http: empty } as unknown as Host, {});
  expect(empty).toHaveBeenCalledTimes(1);
});

it('keeps a failed key test free of response and transport credential text', async () => {
  for (const http of [async () => ({ status: 401, body: 'fixture-sensitive' }), async () => { throw new Error('fixture-sensitive'); }]) {
    await expect(claudeApi.testKey!({ secret: async () => 'fixture-sensitive', http } as unknown as Host, {})).rejects.toThrow('The Claude API key test failed.');
  }
});
