import type { ProviderPlugin } from '../types.js';
import { genericProvider } from '../generic.js';
import { json, obj } from '../util.js';
import { openrouterDef } from './openrouter.def.js';

export const openrouter: ProviderPlugin = {
  ...genericProvider(openrouterDef),
  modelListMode: 'catalog',
  async listModels(host) {
    const data = obj(await json(host, { url: 'https://openrouter.ai/api/v1/models' }));
    return (Array.isArray(data.data) ? data.data : []).map(obj).filter(m => typeof m.id === 'string').map(m => ({ id: m.id, name: typeof m.name === 'string' ? m.name : undefined, created: typeof m.created === 'number' ? new Date(m.created * 1000).toISOString() : undefined }));
  },
};
