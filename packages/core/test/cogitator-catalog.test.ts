import { describe, expect, it } from 'vitest';
import { ACTIVITIES, WEIGHT_LEVELS, COGITATOR_MODELS, COGITATOR_ROLES, buildPolicyFile, cogitator, emptyPolicy, fleetCatalog, fleetOffers, newProvider, policyFromFile, readCogitatorKnowledge, readFleet, resolveModel } from '../src/index.js';
import type { ModelEntry } from '../src/index.js';

const model = (id: string, rule: ModelEntry['rule'] = {}): ModelEntry => ({ id, rule, source: 'manual', status: 'confirmed', firstSeen: '2026-10-29T12:00:00Z' });
const hosts = {
  self: { name: 'eru', ledger: { models: [{ id: 'gemma-4-12b', state: 'ready' }, { id: 'new-text', uses: ['live text'], strengths: 'Live strength.', limits: 'Live limit.' }] },
    roles: [{ name: 'describe', chain: ['gemma-4-12b', 'new-text@bilbo'] }, { name: 'judge', chain: ['new-text'] }] },
  peers: [{ name: 'bilbo', ledger: { models: [{ id: 'gemma-4-12b' }] } }],
};

describe('the Cogitator catalog', () => {
  it('seeds every named entry with uses, limits, a size class, and existing activity strengths', () => {
    expect(COGITATOR_MODELS.map(entry => entry.id)).toEqual(['gemma-4-12b', 'gemma-4-12b-it-qat', 'gemma-4-e4b-it-qat', 'gemma-4-e2b-it-qat', 'gemma-4-12b-uncensored', 'mimo-v2.6-distill-qwen-9b', 'apple-foundation', 'embeddinggemma-2', 'qwen3-asr-1.7b', 'parakeet-tdt-0.6b-v3', 'cohere-transcribe-03-2026', 'moss-transcribe-diarize', 'laya', 'humanizer', 'prompt-guard', 'comfyui', 'sd-moss-image']);
    expect(COGITATOR_ROLES.map(entry => entry.id)).toEqual(expect.arrayContaining(['describe', 'judge', 'summarize', 'embed-gemma2', 'humanize', 'laya', 'listen', 'listen-fast', 'transcribe', 'diarize']));
    for (const entry of [...COGITATOR_MODELS, ...COGITATOR_ROLES]) {
      expect(entry.uses?.length).toBeGreaterThan(0);
      expect(entry.strengths).toBeTruthy(); expect(entry.limits).toBeTruthy(); expect(entry.sizeClass).toBeTruthy();
      for (const [activity, strength] of Object.entries(entry.activities)) {
        expect(ACTIVITIES).toContain(activity); expect(WEIGHT_LEVELS).toContain(strength);
      }
    }
    expect(COGITATOR_MODELS.find(entry => entry.id === 'apple-foundation')?.limits).toContain('JSON-schema');
    expect(COGITATOR_MODELS.find(entry => entry.id === 'embeddinggemma-2')?.strengths).toContain('768');
    expect(COGITATOR_ROLES.find(entry => entry.id === 'judge')?.limits).toContain('24000');
  });

  it('merges live fields individually and retains seeds for missing or malformed fields', () => {
    const fleet = readFleet({ ...hosts, catalog: { models: [{ id: 'gemma-4-12b', uses: ['live vision'], strengths: 'Live vision.' }], roles: [{ name: 'judge', limits: 'Live input limit.' }] } });
    expect(fleet.machines[0]!.models[0]).toMatchObject({ uses: ['live vision'], strengths: 'Live vision.', limits: COGITATOR_MODELS[0]!.limits });
    expect(fleet.roles[1]).toMatchObject({ uses: ['short judgments', 'classification'], limits: 'Live input limit.' });
    expect(fleet.machines[0]!.models[1]).toMatchObject({ uses: ['live text'], strengths: 'Live strength.', limits: 'Live limit.' });
    expect(readCogitatorKnowledge({}, 'gemma-4-12b', false, { uses: [42], strengths: null, limits: {} })).toEqual({ uses: COGITATOR_MODELS[0]!.uses, strengths: COGITATOR_MODELS[0]!.strengths, limits: COGITATOR_MODELS[0]!.limits });
    expect(readCogitatorKnowledge({ models: [{ id: 'gemma-4-12b', uses: [], limits: '' }] }, 'gemma-4-12b')).toMatchObject({ uses: [], limits: '' });
    expect(readCogitatorKnowledge({}, 'unknown')).toEqual({});
  });

  it('reads catalog-level role chains and never invents a chain', () => {
    const fleet = readFleet({ self: { name: 'eru' }, catalog: { roles: [{ name: 'describe', chain: ['gemma-4-12b'] }] } });
    expect(fleet.roles[0]).toMatchObject({ chain: ['gemma-4-12b'], servingModel: 'gemma-4-12b', uses: ['image description'] });
    expect(readFleet({}).roles).toEqual([]);
  });

  it('keeps live metadata when a second machine lists the same entry without it', () => {
    const fleet = readFleet({ ...hosts, self: { ...hosts.self, ledger: { models: [{ id: 'gemma-4-12b', uses: ['live image reading'] }] } } });
    expect(fleetCatalog(fleet).find(entry => entry.id === 'gemma-4-12b')?.uses).toEqual(['live image reading']);
  });

  it('deduplicates machines and offers only live entries missing a rule or route without changing inputs', () => {
    const fleet = readFleet(hosts), before = structuredClone(fleet);
    const models = [{ label: 'cogitator/custom-vision', id: 'gemma-4-12b' }, { label: 'cogitator/judge', id: 'judge' }];
    const catalog = fleetCatalog(fleet);
    expect(catalog.map(entry => entry.id)).toEqual(['gemma-4-12b', 'new-text', 'describe', 'judge']);
    expect(catalog.find(entry => entry.id === 'describe')).toMatchObject({ role: true, chain: ['gemma-4-12b', 'new-text@bilbo'] });
    const offers = fleetOffers(fleet, models, ['cogitator/custom-vision']);
    expect(offers.map(entry => entry.id)).toEqual(['new-text', 'describe', 'judge']);
    expect(offers.find(entry => entry.id === 'judge')).toMatchObject({ missingModel: false, missingRoute: true, model: 'cogitator/judge' });
    expect(fleetOffers(fleet, [], ['cogitator/describe']).find(entry => entry.id === 'describe')).toMatchObject({ missingModel: true, missingRoute: false });
    expect(fleetOffers(fleet, [{ label: 'cogitator/describe', id: 'different' }], []).some(entry => entry.id === 'describe')).toBe(false);
    expect(fleet).toEqual(before);
    expect(catalog.some(entry => entry.id === 'comfyui')).toBe(false);
  });

  it('lists live entries for manual selection without enabling automatic imports', async () => {
    expect(cogitator.modelListMode).toBe('catalog');
    const listed = await cogitator.listModels!({ platform: 'linux', secret: async () => 'test-manage', http: async () => ({ status: 200, headers: {}, body: JSON.stringify(hosts) }) }, {});
    expect(listed.map(entry => entry.id)).toEqual(['gemma-4-12b', 'new-text', 'describe', 'judge']);
  });
});

describe('catalog activity fallbacks', () => {
  it('uses seeds only where the owner has not set a strength or block', () => {
    expect(resolveModel('cogitator', {}, model('laya')).activities).toEqual({ bulk_tagging: 'preferred', typed_decisions: 'preferred' });
    const resolved = resolveModel('cogitator', { activities: { typed_decisions: 'occasional', bulk_tagging: null } }, model('laya', { activities: { typed_decisions: 'normal' } }));
    expect(resolved.activities).toEqual({ typed_decisions: 'normal' });
    expect(resolved.blockedActivities).toEqual(['bulk_tagging']);
    expect(resolveModel('other', {}, model('laya')).activities).toEqual({});
    expect(resolveModel('cogitator', {}, model('unknown')).activities).toEqual({});
  });

  it('keeps catalog defaults and explicit blocks distinct through a policy export and import', () => {
    const policy = emptyPolicy();
    policy.providers.cogitator = { ...newProvider(), models: { 'cogitator/laya': model('laya', { activities: { bulk_tagging: null } }) } };
    const meta = [{ id: 'cogitator', name: 'Cogitator', metered: false }];
    const exported = buildPolicyFile(policy, meta), restored = policyFromFile(exported);
    expect(restored.providers.cogitator!.models['cogitator/laya']!.rule.activities).toEqual({ bulk_tagging: null });
    const result = buildPolicyFile(restored, meta).providers.cogitator!.models['cogitator/laya']!;
    expect(result.activities).toEqual({ typed_decisions: 'preferred' });
    expect(result.blockedActivities).toEqual(['bulk_tagging']);
  });

  it('does not widen data clearance and caps the uncensored entry at internal', () => {
    expect(resolveModel('cogitator', {}, model('laya')).dataTier).toBe('public');
    expect(resolveModel('cogitator', { dataTier: 'regulated' }, model('laya')).dataTier).toBe('regulated');
    expect(resolveModel('cogitator', { dataTier: 'regulated' }, model('gemma-4-12b-uncensored')).dataTier).toBe('internal');
    expect(resolveModel('cogitator', { dataTier: 'public' }, model('gemma-4-12b-uncensored')).dataTier).toBe('public');
  });
});
