// Usage rules say what each provider and model may be used for, how much data it may see, and how often to pick it.
// Stored in AppConfig.policy, resolved per model, and written to policy.json beside the usage export.

import { obj } from './util.js';

export const ACTIVITIES = ['write_code', 'review_code', 'research', 'reason_critique', 'draft_prose', 'summarize_extract', 'long_context',
  'bulk_tagging', 'typed_decisions', 'read_images', 'generate_images', 'generate_video', 'speech'] as const;
export type ActivityId = typeof ACTIVITIES[number];

export const ACTIVITY_LABELS: Record<ActivityId, string> = {
  write_code: 'Write code', review_code: 'Review code', research: 'Research', reason_critique: 'Reason and critique',
  draft_prose: 'Draft prose', summarize_extract: 'Summarize and extract', long_context: 'Long-context reading',
  bulk_tagging: 'Bulk tagging', typed_decisions: 'Typed decisions', read_images: 'Read images',
  generate_images: 'Generate images', generate_video: 'Generate video', speech: 'Speech',
};

export const WEIGHT_LEVELS = ['last_resort', 'occasional', 'normal', 'often', 'preferred'] as const;
export type WeightLevel = typeof WEIGHT_LEVELS[number];
/** Multiplier a router applies to a model's task-fit score for an activity at each level. */
export const WEIGHTS: Record<WeightLevel, number> = { last_resort: 0.25, occasional: 0.6, normal: 1, often: 1.5, preferred: 2.5 };
export const WEIGHT_LABELS: Record<WeightLevel, string> = { last_resort: 'Last resort', occasional: 'Occasional', normal: 'Normal', often: 'Often', preferred: 'Preferred' };

export const DATA_TIERS = ['public', 'internal', 'sensitive', 'regulated'] as const;
export type DataTier = typeof DATA_TIERS[number];
export const DATA_TIER_LABELS: Record<DataTier, string> = { public: 'Public', internal: 'Internal', sensitive: 'Sensitive', regulated: 'Regulated' };

export const OUTPUT_MODES = ['write_files', 'patch_only', 'text_only'] as const;
export type OutputMode = typeof OUTPUT_MODES[number];
export const COST_TIERS = ['free', 'very_cheap', 'cheap', 'moderate', 'high', 'very_high'] as const;
export type CostTier = typeof COST_TIERS[number];
export const MODEL_STATUSES = ['confirmed', 'imported', 'unreviewed', 'hidden'] as const;
export type ModelStatus = typeof MODEL_STATUSES[number];

export interface Pause {
  /** ISO time the pause lifts. A pause set against a meter reset records that reset's time here. */
  until: string;
  /** The meter whose reset was chosen, kept for display. */
  meter?: string | null;
  /** Replacement weights while paused. Null pauses the model outright. */
  weights?: Partial<Record<ActivityId, WeightLevel | null>> | null;
  reason?: string;
}

const DH_KEYS = ['hostCountry', 'retainsPrompts', 'trainsOnPrompts', 'pinnedHost'] as const;
export interface DataHandling { hostCountry?: string | null; retainsPrompts?: boolean | null; trainsOnPrompts?: boolean | null; pinnedHost?: string | null }
export interface Thresholds { warnPct: number; denyPct: number; minBalance: number | null }

/** Every field is optional. A missing field on a model takes the provider's value. A null activity on a model blocks it there. */
export interface Rule {
  activities?: Partial<Record<ActivityId, WeightLevel | null>>;
  dataTier?: DataTier;
  askFirst?: boolean;
  output?: OutputMode;
  sandbox?: boolean;
  effort?: string | null;
  cost?: CostTier;
  pause?: Pause | null;
  dataHandling?: DataHandling;
  notes?: string;
}
export const RULE_FIELDS = ['dataTier', 'askFirst', 'output', 'sandbox', 'effort', 'cost', 'pause', 'dataHandling', 'notes'] as const;
export type RuleField = typeof RULE_FIELDS[number] | `activities.${ActivityId}`;

export interface ModelEntry {
  /** Model id as the provider names it, such as gpt-6-sol. */
  id: string;
  name?: string;
  source: 'live' | 'manual' | 'import';
  status: ModelStatus;
  rule: Rule;
  firstSeen: string;
  /** The older version this model replaces. Confirming this model hides that one. */
  supersedes?: string;
}

export interface ProviderPolicy {
  defaults: Rule;
  thresholds?: Partial<Thresholds>;
  /** Whether new models in the provider's list are added for review (`auto`) or kept to pick from (`catalog`). Unset uses the provider's own default. */
  listMode?: 'auto' | 'catalog';
  models: Record<string, ModelEntry>;
}

/** `at` is the wall-clock time of the edit. `stamp` is its hybrid logical clock stamp, which orders edits across devices; changes saved before stamps existed have none. */
export interface PolicyChange { at: string; device: string; path: string; from: unknown; to: unknown; stamp?: string }

export interface PolicyConfig {
  /** Keyed by provider id. Models are keyed by their `<provider>/<model>` route label. */
  providers: Record<string, ProviderPolicy>;
  /** Clock stamp of the newest edit per field path, so two devices merge field by field with the newer edit winning. */
  stamps: Record<string, string>;
  /** The newest stamp this device has issued or seen. The next edit is stamped after it even when the device's own clock runs behind. */
  clock?: string;
  /** Newest last. */
  history: PolicyChange[];
}

export const HISTORY_LIMIT = 1000;
export const DEFAULT_THRESHOLDS: Thresholds = { warnPct: 90, denyPct: 98, minBalance: null };

/** Providers that have rules and no usage reader. Augur can't see their usage. */
export const RULES_ONLY_PROVIDERS: Array<{ id: string; name: string; detail: string }> = [
  { id: 'chatgpt', name: 'ChatGPT', detail: 'chatgpt.com in a browser. Business plan usage is not published.' },
  { id: 'm365copilot', name: 'Microsoft 365 Copilot', detail: 'Work account chat. Usage is not published.' },
  { id: 'laya', name: 'Laya', detail: 'Local typed-judgment model on your own hardware. No usage limits.' },
];

// ------------------------------------------------------------------ paths and edits

const SEP = '|';
/** Field path: `<provider>|<model label or empty for defaults>|<field>`. Thresholds use `<provider>||thresholds.<key>`. */
export function fieldPath(provider: string, model: string | null, field: string): string { return [provider, model ?? '', field].join(SEP); }

function splitPath(path: string): [string, string, string] { const [provider = '', model = '', field = ''] = path.split(SEP); return [provider, model, field]; }

const CLOCK = '~';
/** Stamps are `<ISO time>~<counter>~<device>`. Compared as plain strings they order by time, then counter, then device, and an older bare ISO time sorts before any stamp of the same instant. */
export const stampTime = (stamp: string): string => stamp.split(CLOCK, 1)[0] as string;
const later = (a: string | undefined, b: string | undefined): string | undefined => (a === undefined ? b : b === undefined ? a : a < b ? b : a);

/**
 * A hybrid logical clock: the wall clock, held forward past any stamp already seen, with a counter for edits in the same millisecond.
 * A phone whose clock is an hour slow still stamps its next edit after the desktop's newest one it has merged.
 */
function nextStamp(policy: PolicyConfig, device: string, now: Date): string {
  const parts = policy.clock?.split(CLOCK) ?? [];
  const lastMs = parts[0] ? Date.parse(parts[0]) : 0;
  const ms = Math.max(now.getTime(), Number.isFinite(lastMs) ? lastMs : 0);
  const n = ms === lastMs ? Number(parts[1] ?? 0) + 1 : 0;
  const stamp = `${new Date(ms).toISOString()}${CLOCK}${String(n).padStart(4, '0')}${CLOCK}${device}`;
  policy.clock = stamp;
  return stamp;
}

export function emptyPolicy(): PolicyConfig { return { providers: {}, stamps: {}, history: [] }; }

function providerPolicy(policy: PolicyConfig, id: string): ProviderPolicy {
  return policy.providers[id] ??= { defaults: {}, models: {} };
}

function readField(rule: Rule, field: string): unknown {
  if (field.startsWith('activities.')) return rule.activities?.[field.slice(11) as ActivityId];
  if (field.startsWith('dataHandling.')) return (rule.dataHandling as Record<string, unknown> | undefined)?.[field.slice(13)];
  return (rule as Record<string, unknown>)[field];
}

function writeField(rule: Rule, field: string, value: unknown): void {
  if (field.startsWith('dataHandling.')) {
    // One part of the data handling is its own field, so a model can set the host country and still inherit the rest.
    const key = field.slice(13), parts = { ...rule.dataHandling } as Record<string, unknown>;
    if (value === undefined) delete parts[key]; else parts[key] = value;
    if (Object.keys(parts).length) rule.dataHandling = parts as DataHandling; else delete rule.dataHandling;
    return;
  }
  if (field.startsWith('activities.')) {
    const key = field.slice(11) as ActivityId, activities = { ...rule.activities };
    if (value === undefined) delete activities[key]; else activities[key] = value as WeightLevel | null;
    if (Object.keys(activities).length) rule.activities = activities; else delete rule.activities;
    return;
  }
  const r = rule as Record<string, unknown>;
  if (value === undefined) delete r[field]; else r[field] = value;
}

function getAt(policy: PolicyConfig, path: string): unknown {
  const [provider, model, field] = splitPath(path);
  const p = policy.providers[provider];
  if (!p) return undefined;
  if (field.startsWith('thresholds.')) return (p.thresholds as Record<string, unknown> | undefined)?.[field.slice(11)];
  if (field === 'listMode') return p.listMode;
  if (field === 'status') return model ? p.models[model]?.status : undefined;
  const rule = model ? p.models[model]?.rule : p.defaults;
  return rule ? readField(rule, field) : undefined;
}

function setAt(policy: PolicyConfig, path: string, value: unknown): void {
  const [provider, model, field] = splitPath(path);
  const p = providerPolicy(policy, provider);
  if (field.startsWith('thresholds.')) {
    const t = { ...p.thresholds } as Record<string, unknown>;
    if (value === undefined) delete t[field.slice(11)]; else t[field.slice(11)] = value;
    p.thresholds = t as Partial<Thresholds>;
    return;
  }
  if (field === 'listMode') { if (value === 'auto' || value === 'catalog') p.listMode = value; else delete p.listMode; return; }
  const entry = model ? p.models[model] : undefined;
  if (model && !entry) return;
  if (field === 'status') { if (entry && MODEL_STATUSES.includes(value as ModelStatus)) entry.status = value as ModelStatus; return; }
  writeField(entry ? entry.rule : p.defaults, field, value);
}

/** Changes one field, stamps it, and records it in the history. Undefined clears the field so it inherits again. */
export function setField(policy: PolicyConfig, path: string, value: unknown, device: string, now = new Date()): void {
  const from = getAt(policy, path);
  if (JSON.stringify(from) === JSON.stringify(value)) return;
  setAt(policy, path, value);
  const stamp = nextStamp(policy, device, now);
  policy.stamps[path] = stamp;
  policy.history.push({ at: stampTime(stamp), stamp, device, path, from: from ?? null, to: value ?? null });
  if (policy.history.length > HISTORY_LIMIT) policy.history.splice(0, policy.history.length - HISTORY_LIMIT);
}

/** Sets the same field on several models at once. */
export function setFieldMany(policy: PolicyConfig, provider: string, models: string[], field: string, value: unknown, device: string, now = new Date()): void {
  for (const model of models) setField(policy, fieldPath(provider, model, field), value, device, now);
}

/** Reverts one history entry by writing its old value back, as a new change of its own. */
export function undoChange(policy: PolicyConfig, change: PolicyChange, device: string, now = new Date()): void {
  setField(policy, change.path, change.from ?? undefined, device, now);
}

/** Adds models by hand or from a list, skipping any label or model id already there. New ones start unreviewed and block until they have rules. Returns the labels added. */
export function addModels(policy: PolicyConfig, provider: string, models: Array<{ label: string; id: string; name?: string }>, source: 'live' | 'manual', now = new Date()): string[] {
  const p = providerPolicy(policy, provider), added: string[] = [];
  for (const m of models) {
    if (p.models[m.label] || Object.values(p.models).some(e => e.id === m.id)) continue;
    p.models[m.label] = { id: m.id, name: m.name, source, status: 'unreviewed', rule: {}, firstSeen: now.toISOString() };
    added.push(m.label);
  }
  return added;
}

/**
 * Merges another device's copy into this one. Each field takes the newer edit, and the history keeps both devices' changes.
 * A model that exists on either side is kept, because models leave the list only by being hidden.
 */
export function mergePolicy(local: PolicyConfig, remote: PolicyConfig): PolicyConfig {
  const out: PolicyConfig = structuredClone(local);
  for (const [id, rp] of Object.entries(remote.providers)) {
    const lp = providerPolicy(out, id);
    for (const [label, model] of Object.entries(rp.models)) lp.models[label] ??= structuredClone(model);
  }
  for (const [path, at] of Object.entries(remote.stamps)) {
    const mine = out.stamps[path];
    if (mine && mine >= at) continue;
    setAt(out, path, structuredClone(getAt(remote, path)));
    out.stamps[path] = at;
  }
  out.clock = [remote.clock, ...Object.values(remote.stamps)].reduce(later, out.clock);
  const seen = new Set(out.history.map(key));
  for (const change of remote.history) if (!seen.has(key(change))) out.history.push(change);
  out.history.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  if (out.history.length > HISTORY_LIMIT) out.history.splice(0, out.history.length - HISTORY_LIMIT);
  return out;
}
/**
 * What two devices must agree on to hold the same rules: every field's stamp and every model. The clock and the history are left out,
 * since a device that has merged the other's edits ends with the same fields and possibly a later clock.
 */
export function policyDigest(policy: PolicyConfig): string {
  const models = Object.entries(policy.providers).flatMap(([id, p]) => Object.keys(p.models).map(label => `${id}${SEP}${label}`)).sort();
  return JSON.stringify([Object.entries(policy.stamps).sort(([a], [b]) => (a < b ? -1 : 1)), models]);
}

const order = (c: PolicyChange) => c.stamp ?? c.at;
const key = (c: PolicyChange) => `${order(c)}${SEP}${c.device}${SEP}${c.path}`;

// ------------------------------------------------------------------ resolution

export interface ResolvedModel {
  provider: string;
  id: string;
  name?: string;
  status: ModelStatus;
  source: ModelEntry['source'];
  activities: Partial<Record<ActivityId, WeightLevel>>;
  dataTier: DataTier;
  askFirst: boolean;
  output: OutputMode;
  sandbox: boolean;
  effort: string | null;
  cost: CostTier;
  pause: Pause | null;
  dataHandling: DataHandling;
  notes: string;
  /** Fields taken from the provider's defaults. */
  inherited: string[];
}

const FALLBACK: Required<Omit<Rule, 'activities' | 'dataHandling'>> = { dataTier: 'public', askFirst: false, output: 'text_only', sandbox: false, effort: null, cost: 'moderate', pause: null, notes: '' };

export function resolveModel(provider: string, defaults: Rule, model: ModelEntry): ResolvedModel {
  const inherited: string[] = [], pick = <K extends keyof typeof FALLBACK>(field: K): (typeof FALLBACK)[K] => {
    if (model.rule[field] !== undefined) return model.rule[field] as (typeof FALLBACK)[K];
    if (defaults[field] !== undefined) { inherited.push(field); return defaults[field] as (typeof FALLBACK)[K]; }
    return FALLBACK[field];
  };
  const activities: Partial<Record<ActivityId, WeightLevel>> = {};
  for (const a of ACTIVITIES) {
    const own = model.rule.activities?.[a];
    const level = own !== undefined ? own : defaults.activities?.[a];
    if (own === undefined && defaults.activities?.[a] !== undefined) inherited.push(`activities.${a}`);
    if (level) activities[a] = level;
  }
  const dataHandling: DataHandling = {};
  for (const k of DH_KEYS) {
    if (model.rule.dataHandling && k in model.rule.dataHandling) (dataHandling as Record<string, unknown>)[k] = model.rule.dataHandling[k];
    else if (defaults.dataHandling && k in defaults.dataHandling) { (dataHandling as Record<string, unknown>)[k] = defaults.dataHandling[k]; inherited.push(`dataHandling.${k}`); }
  }
  return { provider, id: model.id, name: model.name, status: model.status, source: model.source, activities,
    dataTier: pick('dataTier'), askFirst: pick('askFirst'), output: pick('output'), sandbox: pick('sandbox'), effort: pick('effort'),
    cost: pick('cost'), pause: pick('pause'), dataHandling, notes: pick('notes'), inherited };
}

export function resolveThresholds(p: ProviderPolicy | undefined): Thresholds { return { ...DEFAULT_THRESHOLDS, ...p?.thresholds }; }

export function pauseActive(pause: Pause | null | undefined, now = new Date()): boolean {
  const until = pause ? Date.parse(pause.until) : NaN;
  return Number.isFinite(until) && until > now.getTime();
}

// ------------------------------------------------------------------ policy.json

export interface PolicyFile {
  schema: 1;
  updatedAt: string;
  weights: Record<WeightLevel, number>;
  dataTiers: readonly DataTier[];
  activities: readonly ActivityId[];
  /** Models never given rules. Routers treat them as blocked. */
  unreviewed: string[];
  providers: Record<string, { name: string; metered: boolean; thresholds: Thresholds; models: Record<string, ResolvedModel> }>;
}

export function buildPolicyFile(policy: PolicyConfig, providers: Array<{ id: string; name: string; metered: boolean }>, now = new Date()): PolicyFile {
  const out: PolicyFile['providers'] = {}, unreviewed: string[] = [];
  for (const meta of providers) {
    const p = policy.providers[meta.id], models: Record<string, ResolvedModel> = {};
    for (const [label, model] of Object.entries(p?.models ?? {})) {
      if (model.status === 'hidden') continue;
      if (model.status === 'unreviewed') unreviewed.push(label);
      models[label] = resolveModel(meta.id, p!.defaults, model);
    }
    out[meta.id] = { name: meta.name, metered: meta.metered, thresholds: resolveThresholds(p), models };
  }
  const stamps = Object.values(policy.stamps).sort();
  return { schema: 1, updatedAt: stamps.length ? stampTime(stamps.at(-1) as string) : now.toISOString(), weights: WEIGHTS, dataTiers: DATA_TIERS, activities: ACTIVITIES, unreviewed: unreviewed.sort(), providers: out };
}

/**
 * Turns a policy.json back into stored rules, keeping each model's status, so an install with a policy.json already in place
 * (written by hand or by an earlier build) keeps its rules, pauses and confirmations when the app first takes ownership of the file.
 * A field a model lists under `inherited` goes back to the provider's defaults, so a later change to a default still reaches that model.
 * A model whose inherited value differs from the value the provider's other models share keeps it as its own.
 */
export function policyFromFile(data: unknown, now = new Date()): PolicyConfig {
  const stored: Record<string, unknown> = {};
  for (const [pid, raw] of Object.entries(obj(obj(data).providers))) {
    const p = obj(raw), defaults: Record<string, unknown> = {}, defaultActivities: Record<string, unknown> = {}, defaultHandling: Record<string, unknown> = {}, models: Record<string, unknown> = {};
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    for (const [label, mraw] of Object.entries(obj(p.models))) {
      const m = obj(mraw), inherited = new Set(Array.isArray(m.inherited) ? m.inherited.filter((x): x is string => typeof x === 'string') : []);
      const rule: Record<string, unknown> = {}, activities: Record<string, unknown> = {};
      for (const field of ['dataTier', 'askFirst', 'output', 'sandbox', 'effort', 'cost', 'pause', 'notes']) {
        if (inherited.has(field) && (!(field in defaults) || same(defaults[field], m[field]))) defaults[field] = m[field];
        else rule[field] = m[field];
      }
      // Data handling is inherited part by part. A file that lists the whole field as inherited counts every part.
      const handling = obj(m.dataHandling), ownHandling: Record<string, unknown> = {};
      for (const k of DH_KEYS) {
        if ((inherited.has('dataHandling') || inherited.has(`dataHandling.${k}`)) && (!(k in defaultHandling) || same(defaultHandling[k], handling[k]))) defaultHandling[k] = handling[k];
        else if (k in handling) ownHandling[k] = handling[k];
      }
      if (Object.keys(ownHandling).length) rule.dataHandling = ownHandling;
      for (const [act, level] of Object.entries(obj(m.activities))) {
        const name = `activities.${act}`;
        if (inherited.has(name) && (!(act in defaultActivities) || same(defaultActivities[act], level))) defaultActivities[act] = level;
        else activities[act] = level;
      }
      rule.activities = activities;
      models[label] = { id: m.id, name: m.name, source: m.source, status: m.status, firstSeen: now.toISOString(), rule };
    }
    stored[pid] = { defaults: { ...defaults, activities: defaultActivities, ...(Object.keys(defaultHandling).length ? { dataHandling: defaultHandling } : {}) }, thresholds: p.thresholds, models };
  }
  return migratePolicy({ providers: stored });
}

/** policy.json, and the policy-import.json read on first run, sit beside the usage export. */
export function policyPathFor(exportPath: string, name: 'policy.json' | 'policy-import.json' = 'policy.json'): string {
  const slash = exportPath.lastIndexOf('/');
  return (slash >= 0 ? exportPath.slice(0, slash + 1) : '') + name;
}

// ------------------------------------------------------------------ loading

const oneOf = <T extends string>(list: readonly T[], v: unknown): T | undefined => list.includes(v as T) ? v as T : undefined;

function migrateRule(value: unknown): Rule {
  const s = obj(value), rule: Rule = {};
  const acts = obj(s.activities), activities: Rule['activities'] = {};
  for (const a of ACTIVITIES) if (a in acts) { const v = acts[a]; if (v === null) activities[a] = null; else if (oneOf(WEIGHT_LEVELS, v)) activities[a] = v as WeightLevel; }
  if (Object.keys(activities).length) rule.activities = activities;
  if (oneOf(DATA_TIERS, s.dataTier)) rule.dataTier = s.dataTier;
  if (typeof s.askFirst === 'boolean') rule.askFirst = s.askFirst;
  if (oneOf(OUTPUT_MODES, s.output)) rule.output = s.output;
  if (typeof s.sandbox === 'boolean') rule.sandbox = s.sandbox;
  if (s.effort === null || typeof s.effort === 'string') rule.effort = s.effort;
  // Rules saved before the six-step scale called the top step expensive.
  const cost = s.cost === 'expensive' ? 'high' : s.cost;
  if (oneOf(COST_TIERS, cost)) rule.cost = cost;
  if (s.pause === null) rule.pause = null;
  else if (typeof obj(s.pause).until === 'string') {
    const p = obj(s.pause), weights = p.weights === null ? null : migrateRule({ activities: p.weights }).activities;
    rule.pause = { until: p.until, weights: weights ?? null, ...(typeof p.meter === 'string' ? { meter: p.meter } : {}), ...(typeof p.reason === 'string' ? { reason: p.reason } : {}) };
  }
  if (s.dataHandling && typeof s.dataHandling === 'object') {
    const d = obj(s.dataHandling), str = (v: unknown) => typeof v === 'string' ? v : null, bool = (v: unknown) => typeof v === 'boolean' ? v : null;
    const parts: DataHandling = {};
    if ('hostCountry' in d) parts.hostCountry = str(d.hostCountry);
    if ('retainsPrompts' in d) parts.retainsPrompts = bool(d.retainsPrompts);
    if ('trainsOnPrompts' in d) parts.trainsOnPrompts = bool(d.trainsOnPrompts);
    if ('pinnedHost' in d) parts.pinnedHost = str(d.pinnedHost);
    if (Object.keys(parts).length) rule.dataHandling = parts;
  }
  if (typeof s.notes === 'string') rule.notes = s.notes;
  return rule;
}

export function migratePolicy(value: unknown): PolicyConfig {
  const s = obj(value), policy = emptyPolicy();
  for (const [id, raw] of Object.entries(obj(s.providers))) {
    if (!/^[a-z][a-z0-9_-]*$/.test(id)) continue;
    const p = obj(raw), models: Record<string, ModelEntry> = {};
    for (const [label, m] of Object.entries(obj(p.models))) {
      const e = obj(m);
      if (typeof e.id !== 'string' || !label.includes('/')) continue;
      models[label] = { id: e.id, name: typeof e.name === 'string' ? e.name : undefined, source: oneOf(['live', 'manual', 'import'] as const, e.source) ?? 'manual',
        status: oneOf(MODEL_STATUSES, e.status) ?? 'unreviewed', rule: migrateRule(e.rule), firstSeen: typeof e.firstSeen === 'string' ? e.firstSeen : new Date(0).toISOString(),
        ...(typeof e.supersedes === 'string' ? { supersedes: e.supersedes } : {}) };
    }
    const t = obj(p.thresholds), thresholds: Partial<Thresholds> = {};
    for (const k of ['warnPct', 'denyPct'] as const) if (typeof t[k] === 'number' && t[k] >= 0 && t[k] <= 100) thresholds[k] = t[k];
    if (t.minBalance === null || (typeof t.minBalance === 'number' && Number.isFinite(t.minBalance))) thresholds.minBalance = t.minBalance;
    policy.providers[id] = { defaults: migrateRule(p.defaults), models, ...(Object.keys(thresholds).length ? { thresholds } : {}),
      ...(p.listMode === 'auto' || p.listMode === 'catalog' ? { listMode: p.listMode } : {}) };
  }
  for (const [path, at] of Object.entries(obj(s.stamps))) if (typeof at === 'string' && path.split(SEP).length === 3) policy.stamps[path] = at;
  if (typeof s.clock === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z(~\d+~.*)?$/.test(s.clock)) policy.clock = s.clock;
  if (Array.isArray(s.history)) for (const c of s.history) {
    const e = obj(c);
    if (typeof e.at === 'string' && typeof e.path === 'string' && typeof e.device === 'string') policy.history.push({ at: e.at, device: e.device, path: e.path, from: e.from ?? null, to: e.to ?? null, ...(typeof e.stamp === 'string' ? { stamp: e.stamp } : {}) });
  }
  policy.history.splice(0, Math.max(0, policy.history.length - HISTORY_LIMIT));
  return policy;
}
