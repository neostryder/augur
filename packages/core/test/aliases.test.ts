import { describe, expect, it } from 'vitest';
import { newestMatching, refreshAliases, type PolicyFile } from '../src/index.js';

const policy = (kind: 'llm' | 'embed' = 'llm'): PolicyFile => ({ schema: 1, updatedAt: '2024-01-01T00:00:00.000Z', weights: { last_resort: 0.1, occasional: 0.5, normal: 1, often: 1.5, preferred: 2 }, dataTiers: ['public', 'internal', 'sensitive', 'regulated'], activities: ['write_code'], unreviewed: [], providers: { openrouter: { name: 'OpenRouter', metered: true, thresholds: { warnPct: 90, denyPct: 98, minBalance: 0 }, models: { 'openrouter/model': { provider: 'openrouter', id: 'vendor/model-1', name: 'Model 1', source: 'manual', status: 'confirmed', dataTier: 'sensitive', askFirst: false, output: 'text_only', sandbox: false, effort: null, cost: 'moderate', pause: null, activities: { write_code: 'preferred' }, dataHandling: {}, useAfter: [], notes: '', inherited: [], series: { kind, pattern: 'vendor/model-*' } } } } } });

describe('alias series', () => {
  it('matches case-insensitive star and question globs and sorts by creation time', () => {
    const listing = [{ id: 'VENDOR/model-a', created: '2024-01-01T00:00:00Z' }, { id: 'vendor/model-b', created: '2025-01-01T00:00:00Z' }, { id: 'vendor/model-c', created: '2024-06-01T00:00:00Z' }];
    expect(newestMatching(listing, 'vendor/model-?')).toEqual(listing[1]);
    expect(newestMatching(listing, 'VENDOR/model-*')?.id).toBe('vendor/model-b');
  });

  it('drops hostile path segments and ids over 200 characters before matching', () => {
    const rows = [{ id: 'vendor/../escape', created: '2026-01-01T00:00:00Z' }, { id: 'vendor/./escape', created: '2025-01-01T00:00:00Z' }, { id: `vendor/${'x'.repeat(201)}`, created: '2027-01-01T00:00:00Z' }, { id: 'vendor/model-2', created: '2024-01-01T00:00:00Z' }];
    expect(newestMatching(rows, 'vendor/*')?.id).toBe('vendor/model-2');
  });

  it('creates one pending offer without changing policy, and flags embedding updates', () => {
    const models = [{ id: 'vendor/model-2', name: 'Model 2', created: '2025-01-01T00:00:00Z' }];
    const original = policy();
    const result = refreshAliases(original, { openrouter: models }, {}, new Date('2025-02-01T00:00:00Z'));
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0]).toMatchObject({ label: 'openrouter/model', from: 'vendor/model-1', to: 'vendor/model-2', status: 'pending' });
    expect(original.providers.openrouter?.models['openrouter/model']?.id).toBe('vendor/model-1');
    const embedding = refreshAliases(policy('embed'), { openrouter: models }, {}, new Date('2025-02-01T00:00:00Z'));
    expect(embedding.offers).toEqual([]);
    expect(embedding.flags[0]?.message).toContain('swapping means re-making stored vectors');
    const unavailable = refreshAliases(original, { openrouter: null }, {}, new Date('2025-02-01T00:00:00Z'));
    expect(unavailable.state['openrouter/model']).toMatchObject({ newestSeenId: '', lastRefreshAt: '2025-02-01T00:00:00.000Z' });
    expect(unavailable.noListing).toEqual(['openrouter']);
  });
});
