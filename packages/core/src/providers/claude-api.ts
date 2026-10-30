import type { ProviderPlugin } from '../types.js';
import { json, obj } from '../util.js';

export const claudeApi: ProviderPlugin = {
  id: 'claude-api', name: 'Claude API', needsLocalLogin: false, rulesOnly: true,
  color: { light: '#3987e5', dark: '#5598e7' }, links: { usage: 'https://platform.claude.com/settings/billing' },
  fields: [{ key: 'apiKey', label: 'API key', kind: 'secret', required: true }], modelListMode: 'catalog',
  async fetch(host) {
    const key = await host.secret('claude-api.apiKey');
    if (!key) throw new Error('No API key yet. Add one in settings.');
    await json(host, { url: 'https://api.anthropic.com/v1/models?limit=1', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
    return { meters: [], money: [] };
  },
  async listModels(host) {
    const key = await host.secret('claude-api.apiKey');
    if (!key) return [];
    const models: Array<{ id: string; name?: string; created?: string }> = [];
    let after: string | undefined;
    do {
      const data = obj(await json(host, { url: `https://api.anthropic.com/v1/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ''}`, headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }));
      for (const model of Array.isArray(data.data) ? data.data.map(obj) : []) if (typeof model.id === 'string') models.push({ id: model.id, name: typeof model.display_name === 'string' ? model.display_name : undefined, created: typeof model.created_at === 'string' ? model.created_at : undefined });
      const next = data.has_more === true && typeof data.last_id === 'string' ? data.last_id : undefined;
      if (!next || next === after) break;
      after = next;
    } while (models.length < 10000);
    return models;
  },
};
