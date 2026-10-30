import { describe, expect, it } from 'vitest';
import { ACTIVITIES, buildPolicyFile, emptyPolicy, fieldPath, migrateConfig, policyProviders, setField, undoChange, type AppConfig, type ModelEntry, type Rule, type Snapshot } from '@augur/core';
import { rank } from '@augur/dispatch-protocol';
import { clearedFor, copyMix, dragLevel, nodeActivityLabel, nodeCatalog, nodeMix, nodeSlug, previewCatalog, previewLevel, roundShares, stepActivity, suggestedThree } from '../src/node-view.js';

const now = new Date('2026-10-29T12:00:00Z');
const entry = (id: string, rule: Rule = {}, status: ModelEntry['status'] = 'confirmed'): ModelEntry => ({ id, status, source: 'manual', firstSeen: now.toISOString(), rule });
function config(): AppConfig {
  const config = migrateConfig({});
  config.policy = emptyPolicy();
  config.policy.balance = { profile: 'neutral' };
  config.policy.providers.demo = { defaults: { activities: { write_code: 'normal', review_code: 'often' }, dataTier: 'regulated', askFirst: false }, models: {
    'demo/terra': entry('gpt-6.1-terra', { activities: { write_code: 'preferred' } }),
    'demo/luna': entry('gpt-6-luna', { activities: { write_code: 'often' } }),
    'demo/sonnet': entry('claude-sonnet-5-5'),
  } };
  return config;
}

describe('node shares', () => {
  it('rounds the largest remainders, keeps stable ties, and leaves empty mixes at zero', () => {
    expect(roundShares([1, 1, 1])).toEqual([34, 33, 33]);
    expect(roundShares([28, 17, 11, 11, 11, 11, 11, 6])).toEqual([27, 16, 11, 10, 10, 10, 10, 6]);
    expect(roundShares([0, -1, Infinity, NaN])).toEqual([0, 0, 0, 0]);
    for (let n = 1; n < 100; n++) expect(roundShares(Array.from({ length: n }, (_, i) => i + .5)).reduce((sum, value) => sum + value, 0)).toBe(100);
  });

  it('uses the existing rank scores, including balance, without changing rules', () => {
    const config = configWithKnownProvider(), before = JSON.stringify(config);
    const result = rank(buildPolicyFile(config.policy!, policyProviders(config), now), null, { activity: 'write_code', dataTier: 'internal', caller: 'interactive' }, now);
    const rows = nodeMix(config, null, 'write_code', 'internal', now);
    expect(rows.map(row => row.ranked?.score)).toEqual(result.ranking.map(row => row.score));
    expect(rows.map(row => row.share)).toEqual(roundShares(result.ranking.map(row => row.score)));
    expect(rows.reduce((sum, row) => sum + row.share, 0)).toBe(100);
    expect(JSON.stringify(config)).toBe(before);
  });

  it('keeps zero shares and the rank reasons for every gate', () => {
    const c = config(), models = c.policy!.providers.demo!.models;
    models['demo/paused'] = entry('paused', { pause: { until: '2026-10-30T12:00:00Z', weights: null } });
    models['demo/public'] = entry('public', { dataTier: 'public' });
    models['demo/no'] = entry('no', { activities: { write_code: null } });
    models['demo/named'] = entry('named', { askFirst: true });
    models['demo/new'] = entry('new', {}, 'unreviewed');
    models['demo/import'] = entry('import', {}, 'imported');
    models['demo/hidden'] = entry('hidden', {}, 'hidden');
    const rows = nodeMix(c, null, 'write_code', 'internal', now);
    for (const slug of ['paused', 'public', 'no', 'named', 'new', 'import', 'hidden']) {
      const row = rows.find(row => row.label === `demo/${slug}`)!;
      expect(row.share).toBe(0); expect(row.reason).not.toBe('');
    }
    expect(rows.find(row => row.label === 'demo/public')?.reason).toContain('cleared for public');
    expect(rows.find(row => row.label === 'demo/no')?.reason).toContain('not permitted');
    expect(rows.find(row => row.label === 'demo/named')?.reason).toContain('ask first');
  });

  it('uses live pressure to remove an expended provider', () => {
    const c = config(); c.providers.push({ id: 'demo', enabled: true, settings: {} });
    const snapshot = { schema: 1, generatedAt: now.toISOString(), providers: { demo: { id: 'demo', name: 'Demo', ok: true, stale: false, fetchedAt: now.toISOString(), error: null, meters: [{ id: 'weekly', label: 'Week', usedPct: 100, windowKind: 'weekly', windowSeconds: 604800, resetsAt: '2026-11-01T12:00:00Z' }], money: [] } } } as Snapshot;
    const rows = nodeMix(c, snapshot, 'write_code', 'internal', now);
    expect(rows.every(row => row.share === 0 && row.reason.length > 0)).toBe(true);
  });

  it('keeps a premium route out of an unnamed preview', () => {
    const c = config(); c.policy!.balance = { profile: 'neutral', gate: { premium: ['demo/terra'], paceLift: [] } };
    const row = nodeMix(c, null, 'write_code', 'internal', now).find(row => row.label === 'demo/terra')!;
    expect(row.share).toBe(0);
    expect(row.reason).toMatch(/ask[- ]first/);
  });

  it('previews edits without recording them and supports the existing undo path', () => {
    const c = config(), path = fieldPath('demo', 'demo/terra', 'activities.write_code');
    const preview = previewLevel(c, 'demo', 'demo/terra', 'write_code', 'last_resort');
    expect(preview.policy!.providers.demo!.models['demo/terra']!.rule.activities!.write_code).toBe('last_resort');
    expect(c.policy!.history).toHaveLength(0);
    for (const [field, value] of [['activities.write_code', 'occasional'], ['dataTier', 'public'], ['pause', { until: '2026-10-30T12:00:00Z' }], ['askFirst', true]] as const) {
      const before = structuredClone(c.policy!.providers.demo!.models['demo/terra']!.rule);
      setField(c.policy!, fieldPath('demo', 'demo/terra', field), value, 'test', now);
      undoChange(c.policy!, c.policy!.history.at(-1)!, 'test', now);
      expect(c.policy!.providers.demo!.models['demo/terra']!.rule).toEqual(before);
    }
    expect(c.policy!.history[0]?.path).toBe(path);
  });
});

function configWithKnownProvider(): AppConfig {
  const c = config(); c.policy!.providers.openrouter = c.policy!.providers.demo!; delete c.policy!.providers.demo;
  return c;
}

describe('node controls and catalog', () => {
  it('distinguishes missing activities from known input limits and blocked data', () => {
    const c = config(), row = nodeMix(c, null, 'read_images', 'internal', now).find(row => row.label === 'demo/terra')!;
    const listing = (inputModalities: string[]) => ({ demo: { fetchedAt: now.toISOString(), models: [{ id: row.entry.id, inputModalities }] } });
    expect(nodeActivityLabel(row, 'read_images', {})).toBe('Not in the mix');
    expect(nodeActivityLabel(row, 'read_images', listing(['text']))).toBe('No vision');
    expect(nodeActivityLabel(row, 'read_images', listing(['text', 'image']))).toBe('Not in the mix');
    c.policy!.providers.demo!.models['demo/terra']!.rule = { activities: { read_images: 'normal' }, dataTier: 'public' };
    const blocked = nodeMix(c, null, 'read_images', 'sensitive', now).find(row => row.label === 'demo/terra')!;
    expect(nodeActivityLabel(blocked, 'read_images', listing(['image']))).toBe('Blocked');
  });

  it('previews catalog additions in a copy and keeps the saved entry unreviewed', () => {
    const c = config();
    const item = { provider: 'demo', label: 'demo/new', id: 'new', name: 'new', description: '', limits: '', activities: {}, tier: 'regulated' as const, exists: false };
    const preview = previewCatalog(c, item, 'write_code');
    expect(preview.policy!.providers.demo!.models['demo/new']!.rule.activities!.write_code).toBe('normal');
    expect(c.policy!.providers.demo!.models['demo/new']).toBeUndefined();
    c.policy!.providers.demo!.models['demo/new'] = entry('new', {}, 'unreviewed');
    previewCatalog(c, { ...item, exists: true }, 'write_code');
    expect(c.policy!.providers.demo!.models['demo/new']!.status).toBe('unreviewed');
    expect(c.policy!.history).toEqual([]);
  });

  it('copies resolved levels, preserves blocks, and leaves hidden entries alone', () => {
    const c = config(); c.policy!.providers.demo!.models['demo/no'] = entry('no', { activities: { review_code: null } });
    c.policy!.providers.demo!.models['demo/hidden'] = entry('hidden', {}, 'hidden');
    const changes = copyMix(c, 'review_code', 'write_code');
    expect(changes).toContainEqual({ path: 'demo|demo/terra|activities.write_code', value: 'often' });
    expect(changes).toContainEqual({ path: 'demo|demo/no|activities.write_code', value: null });
    expect(changes.some(change => change.path.includes('hidden'))).toBe(false);
  });
  it('steps through all detents and clamps both ends', () => {
    expect([-200, -36, 0, 36, 200].map(delta => dragLevel('normal', delta))).toEqual(['last_resort', 'occasional', 'normal', 'often', 'preferred']);
    expect(dragLevel('normal', NaN)).toBe('normal');
    expect(dragLevel('normal', 10)).toBe('normal');
    expect(stepActivity(ACTIVITIES[0], -1)).toBe(ACTIVITIES.at(-1));
    expect(stepActivity(ACTIVITIES.at(-1)!, 1)).toBe(ACTIVITIES[0]);
  });

  it('uses lowercase base names and adds tags only for collisions', () => {
    expect(['gpt-6.1-terra', 'MiniMax-M3.1-Flash', 'deepseek/deepseek-v4', 'claude-sonnet-5-5'].map(nodeSlug)).toEqual(['terra', 'minimax', 'deepseek', 'sonnet']);
    const c = config(); c.policy!.providers.copilot = { defaults: {}, models: { 'copilot/terra': entry('gpt-6.1-terra') } };
    const rows = nodeMix(c, null, 'write_code', 'internal', now);
    expect(rows.filter(row => row.slug === 'terra').every(row => row.tag.length > 0)).toBe(true);
    expect(rows.find(row => row.slug === 'luna')?.tag).toBe('');
  });

  it('does not suggest a model below the gate or claim that a seed is installed', () => {
    const c = config(), catalog = nodeCatalog(c, {}, null);
    expect(catalog).toHaveLength(3);
    expect(suggestedThree(catalog, 'write_code', 'internal')).toHaveLength(3);
    expect(suggestedThree(catalog.map(row => ({ ...row, tier: 'public' })), 'write_code', 'internal')).toEqual([]);
    expect(clearedFor('sensitive', 'regulated')).toBe(false);
    expect(clearedFor('regulated', 'sensitive')).toBe(true);
    expect(suggestedThree(catalog, 'embed', 'public')).toEqual([]);
  });
});
