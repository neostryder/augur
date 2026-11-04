import type { ModelEntry, PolicyConfig } from './policy.js';
import { newProvider } from './policy.js';

/**
 * The models Augur lists, each under one uniform label: `<provider>/<base model name>`, in lower case, with no version in it.
 * The provider's own id for the model (`gpt-6.1-sol`, `deepseek/deepseek-v4.1-flash-1017`) stays on the entry as `id`, so the version is
 * visible without being part of the name. A model's `series` pattern is how the newest version is found; the older labels it used to go
 * by stay on the entry as aliases, hidden from every list, so a rule, a route or a typed name written against one keeps working.
 */
/** Every OpenRouter model is served by one US host that keeps no prompts and does not train on them. The routes carry the same pin as the route option `host`. */
export const OPENROUTER_HOST = 'DeepInfra';
const OPENROUTER_RULE: ModelEntry['rule'] = { dataHandling: { hostCountry: 'US', retainsPrompts: false, trainsOnPrompts: false, pinnedHost: OPENROUTER_HOST } };

export const CATALOG_VERSION = 1;

export interface CatalogModel {
  /** The key the entry is stored under: the provider's id in the rules. */
  provider: string;
  label: string;
  /** The base model name, capitalized, with no version. */
  name: string;
  /** The newest id the provider offers today. A series refresh keeps it current. */
  id: string;
  series?: NonNullable<ModelEntry['series']>;
  /** Earlier labels. The first one found in the rules supplies the rule, status and history. */
  aliases: string[];
  /** For a model with no earlier label: the label whose rules it starts from. */
  from?: string;
  /** The rule a new model starts with when it has nothing to copy. */
  rule?: ModelEntry['rule'];
}

const llm = (pattern: string) => ({ kind: 'llm' as const, pattern });

export const CATALOG: CatalogModel[] = [
  { provider: 'claude', label: 'claude/haiku', name: 'Haiku', id: 'claude-haiku-5-5', series: llm('claude-haiku-*'), aliases: ['claude/claude-haiku-5-5'] },
  { provider: 'claude', label: 'claude/sonnet', name: 'Sonnet', id: 'claude-sonnet-5-5', series: llm('claude-sonnet-*'), aliases: ['claude/claude-sonnet-5-5'] },
  { provider: 'claude', label: 'claude/opus', name: 'Opus', id: 'claude-opus-5-5', series: llm('claude-opus-*'), aliases: ['claude/live'] },
  { provider: 'claude-api', label: 'claude-api/haiku', name: 'Haiku', id: 'claude-haiku-5-5', series: llm('claude-haiku-*'), aliases: [] },
  { provider: 'claude-api', label: 'claude-api/sonnet', name: 'Sonnet', id: 'claude-sonnet-5-5', series: llm('claude-sonnet-*'), aliases: [] },
  { provider: 'claude-api', label: 'claude-api/opus', name: 'Opus', id: 'claude-opus-5-5', series: llm('claude-opus-*'), aliases: [] },
  { provider: 'codex', label: 'codex/luna', name: 'Luna', id: 'gpt-6-luna', series: llm('gpt-*-luna'), aliases: [] },
  { provider: 'codex', label: 'codex/terra', name: 'Terra', id: 'gpt-6.1-terra', series: llm('gpt-*-terra'), aliases: [] },
  { provider: 'codex', label: 'codex/sol', name: 'Sol', id: 'gpt-6.1-sol', series: llm('gpt-*-sol'), aliases: [] },
  { provider: 'chatgpt', label: 'chatgpt/research', name: 'Research', id: 'gpt-6.1-sol:deep-research', aliases: ['chatgpt/web'] },
  { provider: 'chatgpt', label: 'chatgpt/image', name: 'Image', id: 'gpt-6.1-terra:image', aliases: [], from: 'chatgpt/web' },
  { provider: 'm365', label: 'm365/claude', name: 'Claude', id: 'claude:highest', aliases: ['m365copilot/chat'] },
  { provider: 'm365', label: 'm365/gpt', name: 'GPT', id: 'gpt-sol:highest', aliases: [], from: 'm365copilot/chat' },
  { provider: 'grok', label: 'xai/grok', name: 'Grok', id: 'grok-4.7', series: llm('grok-*'), aliases: [] },
  { provider: 'minimax', label: 'minimax/minimax', name: 'MiniMax', id: 'MiniMax-M3.1-Flash', series: llm('MiniMax-M*-Flash'), aliases: ['minimax/MiniMax-M3.1-Flash'] },
  { provider: 'jev', label: 'jev/jev', name: 'Jev', id: 'jev-latest', aliases: ['jev/jev-latest'] },
  { provider: 'copilot', label: 'copilot/haiku', name: 'Haiku', id: 'claude-haiku-5.5', aliases: [], from: 'copilot/claude-sonnet-5.5' },
  { provider: 'copilot', label: 'copilot/sonnet', name: 'Sonnet', id: 'claude-sonnet-5.5', aliases: ['copilot/claude-sonnet-5.5'] },
  { provider: 'copilot', label: 'copilot/opus', name: 'Opus', id: 'claude-opus-5.5', aliases: ['copilot/claude-opus-5.5'] },
  { provider: 'copilot', label: 'copilot/luna', name: 'Luna', id: 'gpt-6-luna', aliases: ['copilot/gpt-6-luna'] },
  { provider: 'copilot', label: 'copilot/terra', name: 'Terra', id: 'gpt-6.1-terra', aliases: ['copilot/gpt-6.1-terra'] },
  { provider: 'copilot', label: 'copilot/sol', name: 'Sol', id: 'gpt-6.1-sol', aliases: ['copilot/gpt-6.1-sol', 'copilot/gpt-6-sol'] },
  { provider: 'copilot', label: 'copilot/argon', name: 'Argon', id: 'gemini-4-argon', aliases: ['copilot/gemini-4-argon'] },
  { provider: 'copilot', label: 'copilot/grok', name: 'Grok', id: 'grok-4.7', aliases: ['copilot/grok-4.7'] },
  { provider: 'openrouter', label: 'openrouter/deepseek', name: 'DeepSeek', id: 'deepseek/deepseek-v4.1-flash-1017', series: llm('deepseek/deepseek-v*-flash*'), aliases: ['openrouter/deepseek-v4.1-flash-1017', 'openrouter/DeepSeekFlash'], rule: OPENROUTER_RULE },
  { provider: 'openrouter', label: 'openrouter/glm', name: 'GLM', id: 'z-ai/glm-5.3-flash', series: llm('z-ai/glm-*-flash'), aliases: ['openrouter/glm-5.3-flash'], rule: OPENROUTER_RULE },
  { provider: 'openrouter', label: 'openrouter/mimo', name: 'MiMo', id: 'xiaomi/mimo-v2.6-flash', series: llm('xiaomi/mimo-*-flash'), aliases: ['openrouter/mimo-v2.6-flash'], rule: OPENROUTER_RULE },
  { provider: 'openai-api', label: 'openai-api/moderation', name: 'Moderation', id: 'omni-moderation-latest', aliases: ['openai/omni-moderation-latest'],
    rule: { dataTier: 'public', askFirst: false, output: 'text_only', sandbox: false, cost: 'very_cheap', activities: { moderate: 'preferred' } } },
  { provider: 'cogitator', label: 'cogitator/laya', name: 'Laya', id: 'laya', aliases: ['laya/laya'] },
];

/** Labels and providers that left the list for good. */
export const RETIRED_LABELS = ['fal/images', 'fal/speech', 'gemini/web', 'minimax/video', 'copilot/gemini-3.8-flash', 'copilot/kimi-k3', 'chatgpt/web', 'm365copilot/chat', 'laya/laya'];
export const RETIRED_PROVIDERS = ['fal', 'gemini', 'laya', 'm365copilot'];
/** Providers whose lists are not limited to the catalog. Cogitator lists every model it serves. */
export const OPEN_PROVIDERS = ['cogitator'];

/** An earlier label and the label that replaced it. */
export function aliasMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const m of CATALOG) for (const alias of m.aliases) map[alias] = m.label;
  // The old Claude names for the session model, and the label a plain "claude" route once used.
  return map;
}

/** The label a name stands for: the label itself, or the one an earlier label became. Null when the name is retired or unknown. */
export function currentLabel(name: string): string | null {
  if (CATALOG.some(m => m.label === name)) return name;
  return aliasMap()[name] ?? null;
}

function rewrite(value: unknown, map: Record<string, string>, gone: ReadonlySet<string>): unknown {
  if (typeof value === 'string') return map[value] ?? value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      if (typeof item === 'string' && gone.has(item)) continue;
      const next = rewrite(item, map, gone);
      if (!(typeof next === 'string' && out.includes(next))) out.push(next);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (gone.has(k)) continue;
      out[map[k] ?? k] = rewrite(v, map, gone);
    }
    return out;
  }
  return value;
}

/**
 * Lists every model and role Cogitator serves, so none is left out. Each is confirmed with no rules of its own: its activities and
 * the highest data it may see come from what Cogitator reports about it. Returns the labels added.
 */
export function syncCogitator(policy: PolicyConfig, listed: Array<{ id: string; name?: string }>, now = new Date()): string[] {
  const p = policy.providers.cogitator ??= newProvider(), added: string[] = [];
  for (const m of listed) {
    if (Object.values(p.models).some(e => e.id === m.id)) continue;
    const label = `cogitator/${m.id}`, name = m.name && m.name !== m.id ? m.name : m.id.charAt(0).toUpperCase() + m.id.slice(1);
    p.models[label] = { id: m.id, name, source: 'live', status: 'confirmed', rule: {}, firstSeen: now.toISOString() };
    added.push(label);
  }
  return added;
}

export interface CatalogResult { moved: string[]; added: string[]; removed: string[] }

/**
 * Brings the rules to the catalog. Each catalog model keeps the rules, status and history of the earlier model it replaces, takes the
 * uniform name and label, and records the old labels as aliases. Models outside the catalog are removed, and so are the providers that left.
 * Rules that name a model (the balance, roles, `useAfter`) follow the new labels. A catalog already applied is left alone, unless `again`
 * is set; that pass only removes the retired labels a merge may have brought back.
 */
export function applyCatalog(policy: PolicyConfig, options: { again?: boolean; now?: Date } = {}): CatalogResult {
  const result: CatalogResult = { moved: [], added: [], removed: [] };
  const done = (policy.catalog ?? 0) >= CATALOG_VERSION;
  if (done && !options.again) return result;
  const now = (options.now ?? new Date()).toISOString(), map = aliasMap();
  const gone = new Set<string>(RETIRED_LABELS.filter(label => !CATALOG.some(m => m.label === label) && !(label in map)));
  const managed = new Set(CATALOG.map(m => m.provider).filter(id => !OPEN_PROVIDERS.includes(id)));

  const find = (label: string): { provider: string; entry: ModelEntry } | null => {
    for (const [provider, p] of Object.entries(policy.providers)) if (p.models[label]) return { provider, entry: p.models[label]! };
    return null;
  };

  if (!done) {
    const made: Array<[CatalogModel, ModelEntry]> = [];
    for (const m of CATALOG) {
      // A hidden entry under the catalog's own label is a leftover. An earlier label that is still listed holds the rules in use.
      const listed = m.aliases.map(find).find(x => x && x.entry.status !== 'hidden');
      const found = find(m.label), own = found && (found.entry.status !== 'hidden' || !listed) ? found : null;
      const source = own ?? listed ?? m.aliases.map(find).find(Boolean) ?? found ?? (m.from ? find(m.from) : null);
      const aliases = [...m.aliases];
      const fresh = !own && !m.aliases.some(a => find(a));
      const entry: ModelEntry = source
        ? { ...structuredClone(source.entry), id: m.id, name: m.name, firstSeen: fresh ? now : source.entry.firstSeen, source: 'manual' }
        : { id: m.id, name: m.name, source: 'manual', status: m.rule ? 'confirmed' : 'unreviewed', rule: structuredClone(m.rule ?? {}), firstSeen: now };
      delete entry.supersedes;
      if (source && fresh && source.entry.status !== 'confirmed') entry.status = source.entry.status;
      if (m.rule && source) entry.rule = { ...entry.rule, ...structuredClone(m.rule) };
      if (m.series) entry.series = { ...m.series }; else delete entry.series;
      if (aliases.length) entry.aliases = [...new Set([...(source?.entry.aliases ?? []), ...aliases])]; else delete entry.aliases;
      if (!source) result.added.push(m.label); else if (!own || m.id !== source.entry.id) result.moved.push(m.label);
      made.push([m, entry]);
    }
    // Rules that carry a provider's own defaults move with the first model that names an earlier provider.
    for (const [m] of made) {
      if (policy.providers[m.provider]) continue;
      const earlier = m.aliases.map(find).find(Boolean);
      const origin = earlier ? policy.providers[earlier.provider] : undefined;
      policy.providers[m.provider] = origin ? { defaults: structuredClone(origin.defaults), ...(origin.thresholds ? { thresholds: structuredClone(origin.thresholds) } : {}), models: {} } : newProvider();
    }
    // Open providers keep the models they already list. Every other provider keeps the catalog and nothing else.
    const kept = new Set(CATALOG.map(m => m.label));
    for (const id of managed) if (policy.providers[id]) {
      for (const label of Object.keys(policy.providers[id]!.models)) if (!kept.has(label) && !(label in map)) result.removed.push(label);
      policy.providers[id]!.models = {};
    }
    for (const [m, entry] of made) policy.providers[m.provider]!.models[m.label] = entry;
    for (const id of managed) { const p = policy.providers[id]; if (p) p.listMode = 'catalog'; }
    for (const id of Object.keys(policy.providers)) {
      if (RETIRED_PROVIDERS.includes(id) && !CATALOG.some(m => m.provider === id)) { result.removed.push(...Object.keys(policy.providers[id]!.models)); delete policy.providers[id]; }
    }
  } else {
    for (const [id, p] of Object.entries(policy.providers)) {
      if (RETIRED_PROVIDERS.includes(id) && !CATALOG.some(m => m.provider === id)) { result.removed.push(...Object.keys(p.models)); delete policy.providers[id]; continue; }
      for (const label of Object.keys(p.models)) if (label in map || gone.has(label)) { delete p.models[label]; result.removed.push(label); }
    }
  }

  // A Cogitator role is named by what it does.
  for (const [label, model] of Object.entries(policy.providers.cogitator?.models ?? {})) {
    const last = label.split('/')[1] ?? label;
    if (!model.name || /role/i.test(model.name)) model.name = last.charAt(0).toUpperCase() + last.slice(1);
  }
  for (const p of Object.values(policy.providers)) for (const model of Object.values(p.models)) {
    if (model.rule.useAfter) model.rule.useAfter = rewrite(model.rule.useAfter, map, gone) as string[];
  }
  for (const p of Object.values(policy.providers)) if (p.defaults.useAfter) p.defaults.useAfter = rewrite(p.defaults.useAfter, map, gone) as string[];
  if (policy.balance) policy.balance = rewrite(policy.balance, map, gone) as Record<string, unknown>;
  if (policy.roles) policy.roles = rewrite(policy.roles, map, gone) as NonNullable<PolicyConfig['roles']>;
  policy.catalog = Math.max(policy.catalog ?? 0, CATALOG_VERSION);
  return result;
}
