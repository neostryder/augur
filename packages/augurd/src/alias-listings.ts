import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ListedModel } from '@augur/core';
import type { ListingSeams } from './alias-files.js';

export const providerListings: ListingSeams = {
  openrouter: async () => {
    const response = await fetch('https://openrouter.ai/api/v1/models');
    if (!response.ok) throw new Error(`OpenRouter model listing returned ${response.status}.`);
    const body = await response.json() as { data?: Array<{ id?: unknown; name?: unknown; created?: unknown; architecture?: { input_modalities?: unknown }; endpoints?: unknown }> };
    return (body.data ?? []).filter(x => typeof x.id === 'string').map(x => {
      const inputModalities = Array.isArray(x.architecture?.input_modalities) ? x.architecture.input_modalities.filter((v): v is string => typeof v === 'string') : undefined;
      const endpoints = Array.isArray(x.endpoints) ? x.endpoints.flatMap(v => typeof v === 'object' && v !== null && 'provider_name' in v && typeof v.provider_name === 'string' ? [v.provider_name] : []) : undefined;
      return { id: x.id as string, ...(typeof x.name === 'string' ? { name: x.name } : {}), ...(typeof x.created === 'number' ? { created: new Date(x.created * 1000).toISOString() } : {}), ...(inputModalities ? { inputModalities } : {}), ...(endpoints ? { endpoints } : {}) };
    });
  },
  codex: async () => {
    const path = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'models_cache.json');
    const body = JSON.parse(await readFile(path, 'utf8')) as { models?: Array<{ slug?: unknown; display_name?: unknown; visibility?: unknown }> };
    return (body.models ?? []).filter(x => typeof x.slug === 'string' && x.visibility === 'list').map(x => ({ id: x.slug as string, ...(typeof x.display_name === 'string' ? { name: x.display_name } : {}) } satisfies ListedModel));
  },
  copilot: null,
};

export async function openRouterEndpoints(modelId: string): Promise<readonly string[] | null> {
  if (modelId.length > 200 || modelId.split('/').some(part => part === '.' || part === '..')) return null;
  const path = modelId.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`https://openrouter.ai/api/v1/models/${path}/endpoints`);
  if (!response.ok) return null;
  const body = await response.json() as { data?: { endpoints?: Array<{ provider_name?: unknown }> } };
  return body.data?.endpoints?.flatMap(endpoint => typeof endpoint.provider_name === 'string' ? [endpoint.provider_name] : []) ?? null;
}
