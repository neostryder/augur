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
    const result = await claudeApi.fetch({ secret, http } as unknown as Host, {});
    expect(secret).toHaveBeenCalledWith('claude-api.apiKey');
    expect(http).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://api.anthropic.com/v1/models?limit=1', headers: { 'x-api-key': 'fixture-key', 'anthropic-version': '2023-06-01' } }));
    expect(result).toEqual({ meters: [], money: [] });
    expect(JSON.stringify(result)).not.toContain('fixture-key');
  });

  it('does not call the network without a saved key and rejects a failed test', async () => {
    const http = vi.fn();
    await expect(claudeApi.fetch({ secret: async () => null, http } as unknown as Host, {})).rejects.toThrow('No API key');
    expect(http).not.toHaveBeenCalled();
    await expect(claudeApi.fetch({ secret: async () => 'fixture-key', http: async () => ({ status: 401, body: 'ignored' }) } as unknown as Host, {})).rejects.toThrow('HTTP 401');
  });

  it('preserves the effect preferences when settings are read again', () => {
    expect(migrateConfig({ layout: { nodeView: { sheen: false, animation: false, ticks: false } } }).layout.nodeView).toEqual({ sheen: false, animation: false, ticks: false });
  });
});
