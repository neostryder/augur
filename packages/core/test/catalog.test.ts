import { describe, it, expect } from 'vitest';
import { CATALOG, CATALOG_VERSION, aliasMap, applyCatalog, currentLabel, syncCogitator } from '../src/catalog.js';
import { buildPolicyFile, migratePolicy, mergePolicy } from '../src/policy.js';
import { policyProviders } from '../src/registry.js';
import { defaultConfig } from '../src/config.js';

const at = '2026-10-01T00:00:00.000Z';
const entry = (id: string, rule: Record<string, unknown> = {}, status = 'confirmed') => ({ id, source: 'manual', status, firstSeen: at, rule });

function before() {
  return migratePolicy({
    providers: {
      claude: { defaults: { dataTier: 'sensitive' }, models: {
        'claude/opus': entry('claude-opus-5-5', { cost: 'very_high', activities: { write_code: 'preferred' } }),
        'claude/claude-sonnet-5-5': entry('claude-sonnet-5-5', { cost: 'moderate' }),
        'claude/claude-haiku-5-5': entry('claude-haiku-5-5') } },
      copilot: { defaults: { dataTier: 'internal' }, models: {
        'copilot/claude-sonnet-5.5': entry('claude-sonnet-5.5', { cost: 'moderate', dataTier: 'internal' }),
        'copilot/gpt-6.1-sol': entry('gpt-6.1-sol', { useAfter: ['codex/sol'] }),
        'copilot/kimi-k3': entry('kimi-k3'), 'copilot/gemini-3.8-flash': entry('gemini-3.8-flash') } },
      codex: { defaults: {}, models: { 'codex/sol': entry('gpt-6.1-sol') } },
      fal: { defaults: {}, models: { 'fal/images': entry('fal-image') } },
      gemini: { defaults: {}, models: { 'gemini/web': entry('gemini-web') } },
      minimax: { defaults: { dataTier: 'public' }, models: { 'minimax/MiniMax-M3.1-Flash': entry('MiniMax-M3.1-Flash'), 'minimax/video': entry('MiniMax-Hailuo') } },
      chatgpt: { defaults: { dataTier: 'internal' }, models: { 'chatgpt/web': entry('latest', { cost: 'free' }) } },
      m365copilot: { defaults: { dataTier: 'internal' }, models: { 'm365copilot/chat': entry('m365-copilot') } },
      laya: { defaults: { dataTier: 'regulated' }, models: { 'laya/laya': entry('laya', { dataTier: 'regulated' }) } },
      cogitator: { defaults: {}, models: { 'cogitator/judge': entry('judge'), 'cogitator/embed': entry('embed') } },
      openrouter: { defaults: {}, models: { 'openrouter/deepseek-v4.1-flash-1017': entry('deepseek/deepseek-v4.1-flash-1017'), 'openrouter/extra-model': entry('x/extra') } },
    },
    balance: { tiers: { 'claude/claude-sonnet-5-5': 'light', 'gemini/web': 'light' }, seats: { shadow: 'laya/laya', web: { research: ['chatgpt/web', 'gemini/web'] } } },
  });
}

describe('model catalog', () => {
  it('gives every model a uniform label, name and series, and keeps the version in the id', () => {
    const labels = new Set<string>();
    for (const m of CATALOG) {
      expect(m.label).toBe(m.label.toLowerCase());
      expect(m.label.split('/')).toHaveLength(2);
      expect(m.name).toMatch(/^[A-Z]/);
      expect(m.name).not.toMatch(/\d/);
      expect(labels.has(m.label)).toBe(false);
      labels.add(m.label);
    }
    expect(CATALOG.map(m => m.label)).toContain('openrouter/deepseek');
    expect(CATALOG.find(m => m.label === 'openrouter/deepseek')!.id).toBe('deepseek/deepseek-v4.1-flash-1017');
  });

  it('moves each earlier model to its new label, keeping its rules and recording the old label as an alias', () => {
    const policy = before();
    const result = applyCatalog(policy);
    expect(policy.providers.claude!.models['claude/sonnet']).toMatchObject({ id: 'claude-sonnet-5-5', name: 'Sonnet', status: 'confirmed', aliases: ['claude/claude-sonnet-5-5'], rule: { cost: 'moderate' } });
    expect(policy.providers.claude!.models['claude/opus']!.rule.activities).toEqual({ write_code: 'preferred' });
    expect(policy.providers.claude!.models['claude/claude-sonnet-5-5']).toBeUndefined();
    expect(policy.providers.minimax!.models['minimax/minimax']).toMatchObject({ id: 'MiniMax-M3.1-Flash', name: 'MiniMax', aliases: ['minimax/MiniMax-M3.1-Flash'] });
    expect(policy.providers.openrouter!.models['openrouter/deepseek']).toMatchObject({ id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek' });
    expect(policy.providers.copilot!.models['copilot/sol']!.rule.useAfter).toEqual(['codex/sol']);
    expect(policy.providers.copilot!.models['copilot/sonnet']!.aliases).toEqual(['copilot/claude-sonnet-5.5']);
    expect(result.moved).toContain('claude/sonnet');
    expect(policy.catalog).toBe(CATALOG_VERSION);
  });

  it('takes the rules of a listed earlier model over a hidden leftover under the new label', () => {
    const policy = before();
    policy.providers.claude!.models['claude/sonnet'] = entry('claude-sonnet-5-5', { cost: 'very_cheap' }, 'hidden') as never;
    applyCatalog(policy);
    expect(policy.providers.claude!.models['claude/sonnet']).toMatchObject({ status: 'confirmed', rule: { cost: 'moderate' } });
  });

  it('removes what the catalog leaves out, and the providers that left', () => {
    const policy = before();
    applyCatalog(policy);
    expect(Object.keys(policy.providers)).not.toEqual(expect.arrayContaining(['fal']));
    for (const gone of ['fal', 'gemini', 'laya', 'm365copilot']) expect(policy.providers[gone]).toBeUndefined();
    expect(policy.providers.minimax!.models['minimax/video']).toBeUndefined();
    expect(policy.providers.copilot!.models['copilot/kimi-k3']).toBeUndefined();
    expect(policy.providers.copilot!.models['copilot/gemini-3.8-flash']).toBeUndefined();
    expect(policy.providers.openrouter!.models['openrouter/extra-model']).toBeUndefined();
    expect(policy.providers.openrouter!.listMode).toBe('catalog');
  });

  it('starts new models from the rules of the model they come from', () => {
    const policy = before();
    applyCatalog(policy);
    expect(policy.providers.copilot!.models['copilot/haiku']).toMatchObject({ id: 'claude-haiku-5.5', name: 'Haiku', status: 'confirmed', rule: { cost: 'moderate', dataTier: 'internal' } });
    expect(policy.providers.chatgpt!.models['chatgpt/research']).toMatchObject({ name: 'Research', rule: { cost: 'free' }, aliases: ['chatgpt/web'] });
    expect(policy.providers.chatgpt!.models['chatgpt/image']).toMatchObject({ name: 'Image', rule: { cost: 'free' } });
    expect(policy.providers.m365!.models['m365/claude']).toMatchObject({ name: 'Claude' });
    expect(policy.providers.m365!.models['m365/gpt']).toMatchObject({ name: 'GPT' });
    expect(policy.providers.m365!.defaults.dataTier).toBe('internal');
    expect(policy.providers.cogitator!.models['cogitator/laya']).toMatchObject({ id: 'laya', name: 'Laya', rule: { dataTier: 'regulated' } });
    expect(Object.keys(policy.providers.cogitator!.models)).toEqual(expect.arrayContaining(['cogitator/judge', 'cogitator/embed']));
    expect(policy.providers['openai-api']!.models['openai-api/moderation']).toMatchObject({ status: 'confirmed', rule: { activities: { moderate: 'preferred' } } });
  });

  it('pins every OpenRouter model to one US host that keeps and trains on nothing', () => {
    const policy = before();
    applyCatalog(policy);
    for (const label of ['openrouter/deepseek', 'openrouter/glm', 'openrouter/mimo']) {
      expect(policy.providers.openrouter!.models[label]!.rule.dataHandling).toEqual({ hostCountry: 'US', retainsPrompts: false, trainsOnPrompts: false, pinnedHost: 'DeepInfra' });
    }
  });

  it('never widens what data a model may see', () => {
    const policy = before();
    applyCatalog(policy);
    expect(policy.providers.chatgpt!.models['chatgpt/image']!.rule.dataTier ?? policy.providers.chatgpt!.defaults.dataTier).toBe('internal');
    expect(policy.providers.copilot!.models['copilot/haiku']!.rule.dataTier).toBe('internal');
  });

  it('follows the new labels in the balance, dropping the models that left', () => {
    const policy = before();
    applyCatalog(policy);
    const balance = policy.balance as { tiers: Record<string, string>; seats: { shadow: string; web: { research: string[] } } };
    expect(balance.tiers).toEqual({ 'claude/sonnet': 'light' });
    expect(balance.seats.shadow).toBe('cogitator/laya');
    expect(balance.seats.web.research).toEqual(['chatgpt/research']);
  });

  it('applies once, and a merge with an unmigrated copy drops the old labels again', () => {
    const policy = before();
    applyCatalog(policy);
    const again = applyCatalog(policy);
    expect(again).toEqual({ moved: [], added: [], removed: [] });
    const merged = mergePolicy(policy, before());
    expect(merged.providers.claude!.models['claude/claude-sonnet-5-5']).toBeUndefined();
    expect(merged.providers.claude!.models['claude/sonnet']).toBeDefined();
    expect(merged.providers.fal).toBeUndefined();
    expect(merged.providers.minimax!.models['minimax/minimax']).toBeDefined();
  });

  it('writes aliases into policy.json and lists the providers the catalog uses', () => {
    const policy = before();
    applyCatalog(policy);
    const config = { ...defaultConfig(), policy };
    const file = buildPolicyFile(policy, policyProviders(config));
    expect(file.providers.claude!.models['claude/sonnet']!.aliases).toEqual(['claude/claude-sonnet-5-5']);
    expect(Object.keys(file.providers)).toEqual(expect.arrayContaining(['m365', 'openai-api', 'cogitator']));
    expect(Object.keys(file.providers)).not.toContain('m365copilot');
    expect(Object.keys(file.providers)).not.toContain('laya');
    expect(file.providers.m365!.models['m365/claude']!.name).toBe('Claude');
  });

  it('resolves an earlier label to the current one', () => {
    expect(currentLabel('claude/claude-sonnet-5-5')).toBe('claude/sonnet');
    expect(currentLabel('claude/sonnet')).toBe('claude/sonnet');
    expect(currentLabel('gemini/web')).toBeNull();
    expect(aliasMap()['openai/omni-moderation-latest']).toBe('openai-api/moderation');
  });

  it('keeps series and aliases when the rules are saved and loaded', () => {
    const policy = before();
    applyCatalog(policy);
    const loaded = migratePolicy(JSON.parse(JSON.stringify(policy)));
    expect(loaded.providers.claude!.models['claude/sonnet']).toMatchObject({ series: { kind: 'llm', pattern: 'claude-sonnet-*' }, aliases: ['claude/claude-sonnet-5-5'] });
    expect(loaded.catalog).toBe(CATALOG_VERSION);
  });

  it('lists every Cogitator model and role once, confirmed, without rules of its own', () => {
    const policy = before();
    applyCatalog(policy);
    const added = syncCogitator(policy, [{ id: 'judge' }, { id: 'qwen3-32b', name: 'Qwen3 32B' }, { id: 'describe' }, { id: 'whisper' }]);
    expect(added).toEqual(['cogitator/qwen3-32b', 'cogitator/describe', 'cogitator/whisper']);
    expect(policy.providers.cogitator!.models['cogitator/whisper']).toMatchObject({ id: 'whisper', name: 'Whisper', status: 'confirmed', rule: {} });
    expect(syncCogitator(policy, [{ id: 'whisper' }])).toEqual([]);
  });
});
