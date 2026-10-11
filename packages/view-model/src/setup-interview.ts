// The setup interview, shared by the window app, the terminal app and the Claude Code setup skill's checklist.
// Pure data: the steps, the answers, the read-back from a current setup, and the edit plan. The apps do the I/O.
import { ACTIVITIES, balanceField, builtinProviders, checkEdit, checkValue } from '@augur/core';
import type { ActivityId, PolicyEdit, ProposedRule } from '@augur/core';
import { DEFAULT_BALANCE, DEFAULT_PACE_RULES, SECRET_OPTION, adapterInfo, balanceLeaves, checkBalanceSetting, lookup, resolveBalance } from '@augur/dispatch-protocol';
import type { BalanceRules, UsageSnapshot } from '@augur/dispatch-protocol';
import { parseRoutesText } from './routes-model.js';

export const SETUP_STEPS = [
  { id: 'stack', title: 'Your stack', sub: 'The plans you already pay for' },
  { id: 'providers', title: 'Providers and keys', sub: 'Confirm what Augur found, and add an API service' },
  { id: 'pace', title: 'Pace and order', sub: 'How much of each subscription to hold back, and which to use first' },
  { id: 'review', title: 'Review and apply', sub: 'Mark what each model is good at, then apply the changes' },
  { id: 'done', title: 'Done', sub: 'Test your routes and confirm the models still waiting' },
] as const;

export type StepId = (typeof SETUP_STEPS)[number]['id'];
export type StepStatus = 'todo' | 'partial' | 'ready';
export type StackId = 'claude-only' | 'several' | 'api-only' | 'profile';
export type HoldChoice = 'free' | 'some' | 'save' | 'custom';
export type Strength = 'strong' | 'light' | 'unsure';

export interface DetectedProvider {
  id: string;
  label: string;
  /** A session or weekly usage window, the kind of window pace can steer. */
  hasWindow: boolean;
  found: boolean;
  confirmed: boolean;
}

export interface PayPerUse {
  providers: string[];
  /** Null means no backup spending. */
  amount: number | null;
}

export interface SetupAnswers {
  stack: StackId;
  detected: DetectedProvider[];
  /** Provider ids added through the Add provider form. */
  added: string[];
  /** One hold-back choice per paced subscription. `custom` is read back and kept. */
  holdBack: Record<string, HoldChoice>;
  /** Strict order, first to last. Empty when the current setup has no chain. */
  rank: string[];
  /** Null means the pay-per-use question is not answered yet. */
  payPerUse: PayPerUse | null;
  strengths: Record<string, Strength>;
  /** Null means not answered. `skipped` writes nothing. A list is `prose.models`. */
  prose: string[] | 'skipped' | null;
  /** Null means not answered. `skipped` writes nothing. A list is `seats.second.models`. */
  seatsSecond: string[] | 'skipped' | null;
}

/** Subscriptions whose readers publish a session or weekly window. A monthly credit meter is not one. */
const WINDOW_PROVIDERS = new Set(['claude', 'codex', 'grok', 'minimax']);
const PROVIDER_ORDER = ['claude', 'codex', 'grok', 'minimax', 'copilot', 'openrouter', 'fal', 'jev'];
/** A route label such as xai/grok is filed under the provider id grok. */
const LABEL_PROVIDER: Record<string, string> = { xai: 'grok' };

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
const byOrder = (a: string, b: string): number => {
  const ia = PROVIDER_ORDER.indexOf(a), ib = PROVIDER_ORDER.indexOf(b);
  return (ia < 0 ? PROVIDER_ORDER.length : ia) - (ib < 0 ? PROVIDER_ORDER.length : ib) || a.localeCompare(b);
};

export interface HoldBackRow { reserve: number; band: number; text: string; claudeBand?: number }

/** The three hold-back choices. `some` uses band 10, and band 5 for Claude, matching pace.claude. */
export const HOLD_BACK: Record<Exclude<HoldChoice, 'custom'>, HoldBackRow> = {
  free: { reserve: 100, band: 20, text: 'Use it freely. Augur holds none of it back and only moves work when you are more than 20 points ahead of or behind pace.' },
  some: { reserve: 90, band: 10, claudeBand: 5, text: 'Keep some back. Once 90% of a window is used, Augur sends optional work to your other subscriptions. This is the default.' },
  save: { reserve: 60, band: 5, text: 'Save it for the work only it does. Once 60% of a window is used, Augur sends optional work to your other subscriptions, and it moves work as soon as you are 5 points off pace.' },
};

/** Claude's built-in band. Every other provider uses the shared default band. */
export const someBand = (provider: string): number => provider === 'claude' ? (DEFAULT_BALANCE.pace.claude?.band ?? HOLD_BACK.some.claudeBand ?? 5) : DEFAULT_PACE_RULES.band;

export function paceNumbers(choice: Exclude<HoldChoice, 'custom'>, provider: string): { reserve: number; band: number } {
  const row = HOLD_BACK[choice];
  return { reserve: row.reserve, band: choice === 'some' ? someBand(provider) : row.band };
}

/**
 * The nearest hold-back choice. `provider` picks Claude's band of 5 for `some`; without it, `some` is band 10.
 * Custom when reserve and band are not both within 2 points of one choice.
 */
export function holdBackOf(pace: { reserve: number; band: number; provider?: string }): HoldChoice {
  const provider = pace.provider ?? '';
  const rows = (['free', 'some', 'save'] as const).map(choice => ({ choice, ...paceNumbers(choice, provider) }));
  const near = rows.filter(r => Math.abs(r.reserve - pace.reserve) <= 2 && Math.abs(r.band - pace.band) <= 2);
  if (!near.length) return 'custom';
  near.sort((a, b) => (Math.abs(a.reserve - pace.reserve) + Math.abs(a.band - pace.band)) - (Math.abs(b.reserve - pace.reserve) + Math.abs(b.band - pace.band)));
  return near[0]!.choice;
}

/**
 * useAfter lists for a strict rank. The first subscription gets none. Each later one waits on the models of the subscription just above it.
 * A subscription with no usage window stays in the rank and gets none, and the next one waits on the nearest one above that has a window.
 */
export function useAfterFromRank(rank: readonly string[], modelsByProvider: Readonly<Record<string, readonly string[]>>, hasWindow: (id: string) => boolean): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let above: string | null = null;
  for (const id of rank) {
    if (!hasWindow(id) || above === null) out[id] = [];
    else out[id] = [...(modelsByProvider[above] ?? [])].sort();
    if (hasWindow(id)) above = id;
  }
  return out;
}

const claudeDetected = (): DetectedProvider => ({ id: 'claude', label: 'Claude', hasWindow: true, found: true, confirmed: true });

/** Starting answers for one of the three stacks. `detected` is the confirmed list for Several, in the order to rank them. */
export function emptyAnswers(stack: Exclude<StackId, 'profile'>, detected: readonly DetectedProvider[] = []): SetupAnswers {
  const base: SetupAnswers = { stack, detected: [], added: [], holdBack: {}, rank: [], payPerUse: null, strengths: {}, prose: null, seatsSecond: null };
  if (stack === 'claude-only') {
    return { ...base, detected: [claudeDetected()], holdBack: { claude: 'some' }, rank: ['claude'], payPerUse: { providers: [], amount: null } };
  }
  if (stack === 'api-only') return { ...base, detected: [...detected], payPerUse: null };
  const paced = detected.filter(d => d.confirmed && d.found && d.hasWindow);
  return {
    ...base,
    detected: [...detected],
    holdBack: Object.fromEntries(paced.map(d => [d.id, 'some' as const])),
    rank: paced.map(d => d.id),
    payPerUse: { providers: [], amount: null },
  };
}

export function stepStatus(answers: SetupAnswers, id: StepId): StepStatus {
  if (id === 'done') {
    const prior = (['stack', 'providers', 'pace', 'review'] as const).map(s => stepStatus(answers, s));
    if (prior.every(s => s === 'ready')) return 'ready';
    return prior.some(s => s !== 'todo') ? 'partial' : 'todo';
  }
  if (id === 'stack') return answers.stack ? 'ready' : 'todo';
  if (id === 'providers') return providersStatus(answers);
  if (id === 'pace') return paceStatus(answers);
  return reviewStatus(answers);
}

function providersStatus(a: SetupAnswers): StepStatus {
  if (a.detected.length === 0 && a.added.length === 0) return a.stack === 'api-only' ? 'partial' : 'todo';
  const allConfirmed = a.detected.every(d => d.confirmed);
  if (allConfirmed && (a.stack !== 'api-only' || a.added.length > 0 || a.detected.length > 0)) return 'ready';
  if (a.detected.some(d => d.confirmed) || a.added.length > 0) return 'partial';
  return 'todo';
}

function paceStatus(a: SetupAnswers): StepStatus {
  const pay = payDecided(a.payPerUse);
  const need = windowedConfirmed(a);
  const ranked = need.length < 2 || (a.rank.length === need.length && need.every(id => a.rank.includes(id)));
  const held = need.every(id => a.holdBack[id]);
  if (!pay && Object.keys(a.holdBack).length === 0 && a.rank.length === 0) return a.stack === 'api-only' ? 'partial' : 'todo';
  if (pay && ranked && held && (a.stack !== 'api-only' || a.payPerUse !== null)) return 'ready';
  if (pay || a.rank.length > 0 || Object.keys(a.holdBack).length > 0) return 'partial';
  return 'todo';
}

function reviewStatus(a: SetupAnswers): StepStatus {
  const prose = a.prose !== null, seats = a.seatsSecond !== null;
  if (!prose && !seats && Object.keys(a.strengths).length === 0) return 'todo';
  if (prose && seats) return 'ready';
  return 'partial';
}

const windowedConfirmed = (a: SetupAnswers): string[] => a.detected.filter(d => d.confirmed && d.found && d.hasWindow).map(d => d.id);

function payDecided(pay: PayPerUse | null): boolean {
  if (!pay) return false;
  if (pay.providers.length === 0) return true;
  return typeof pay.amount === 'number' && Number.isFinite(pay.amount) && pay.amount >= 0;
}

// ------------------------------------------------------------------ read-back

export interface SetupRoute { name: string; model: string; hasKey: boolean }

export interface SetupCurrent {
  policy: unknown;
  /** The stored balance overrides. When omitted, `policy.balance` is used. */
  balance?: unknown;
  routes: readonly SetupRoute[];
  usage: UsageSnapshot | null;
}

interface SeenModel { provider: string; label: string; id: string; status: string; useAfter: string[] }

function useAfterOf(m: Record<string, unknown>): string[] {
  if (Array.isArray(m.useAfter)) return strings(m.useAfter);
  return strings(rec(m.rule).useAfter);
}

function seenModels(policy: unknown): SeenModel[] {
  const out: SeenModel[] = [];
  for (const [provider, raw] of Object.entries(rec(rec(policy).providers))) {
    for (const [label, mraw] of Object.entries(rec(rec(raw).models))) {
      const m = rec(mraw);
      const status = typeof m.status === 'string' ? m.status : 'confirmed';
      if (status === 'hidden') continue;
      const id = typeof m.id === 'string' ? m.id : label.slice(label.indexOf('/') + 1);
      out.push({ provider, label, id, status, useAfter: useAfterOf(m) });
    }
  }
  return out;
}

function providerLabel(policy: unknown, id: string): string {
  const name = rec(rec(rec(policy).providers)[id]).name;
  if (typeof name === 'string' && name) return name;
  return builtinProviders.find(p => p.id === id)?.name ?? id.slice(0, 1).toUpperCase() + id.slice(1);
}

/** A session or weekly meter in the snapshot, or null when this provider has no usage entry. */
function usageWindow(usage: UsageSnapshot | null, id: string): boolean | null {
  const entry = usage?.providers[id];
  if (!entry) return null;
  return (entry.meters ?? []).some(m => typeof m.usedPct === 'number' && (m.windowKind === 'session' || m.windowKind === 'weekly') && !/scoped/.test(m.id ?? ''));
}

function hasWindow(usage: UsageSnapshot | null, id: string, present: boolean): boolean {
  const live = usageWindow(usage, id);
  if (live !== null) return live;
  return present && WINDOW_PROVIDERS.has(id);
}

function storedBalance(current: SetupCurrent): unknown {
  if (current.balance !== undefined) return current.balance;
  return rec(current.policy).balance;
}

function effectivePace(rules: BalanceRules, provider: string): { reserve: number; band: number } {
  const row = rules.pace[provider] ?? DEFAULT_PACE_RULES;
  return { reserve: row.reserve, band: row.band };
}

/** The rank implied by a strict useAfter chain. Empty when there is no chain, so a re-run does not invent one. */
function rankFromModels(models: readonly SeenModel[], windowed: ReadonlySet<string>): string[] {
  const owner = new Map(models.map(m => [m.label, m.provider]));
  const grouped = new Map<string, SeenModel[]>();
  for (const m of models) {
    if (!windowed.has(m.provider)) continue;
    const list = grouped.get(m.provider) ?? [];
    list.push(m);
    grouped.set(m.provider, list);
  }
  const waits = new Map<string, Set<string>>();
  for (const [provider, list] of grouped) {
    const sets = list.map(m => {
      const s = new Set<string>();
      for (const label of m.useAfter) {
        const p = owner.get(label);
        if (p && p !== provider && windowed.has(p)) s.add(p);
      }
      return s;
    });
    const first = sets[0] ?? new Set<string>();
    const same = sets.every(s => s.size === first.size && [...s].every(x => first.has(x)));
    if (!same) return [];
    waits.set(provider, first);
  }
  const linked = [...waits.entries()].filter(([, s]) => s.size > 0);
  if (!linked.length) return windowed.size === 1 ? [...windowed] : [];
  if (linked.some(([, s]) => s.size !== 1)) return [];
  const starts = [...waits.keys()].filter(id => (waits.get(id)?.size ?? 0) === 0 && linked.some(([, s]) => s.has(id)));
  if (starts.length !== 1) return [];
  const rank: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = starts[0];
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    rank.push(cur);
    const followers = [...waits.keys()].filter(id => waits.get(id)?.size === 1 && waits.get(id)!.has(cur!));
    if (followers.length > 1) return [];
    cur = followers[0];
  }
  return rank.length > 1 ? rank : [];
}

function inferStack(holdBack: Record<string, HoldChoice>, pay: PayPerUse): StackId {
  const paced = Object.keys(holdBack);
  if (paced.length === 0) return 'api-only';
  if (paced.length === 1 && paced[0] === 'claude' && pay.providers.length === 0) return 'claude-only';
  return 'several';
}

/** Answers pre-filled from the current setup. An untouched plan against the same current writes nothing. */
export function answersFromCurrent(current: SetupCurrent): SetupAnswers {
  const policy = current.policy;
  const balance = storedBalance(current);
  const rules = resolveBalance(balance);
  const models = seenModels(policy);
  const present = new Set<string>([...models.map(m => m.provider), ...Object.keys(current.usage?.providers ?? {})]);
  const windowOf = new Map<string, boolean>();
  for (const id of present) windowOf.set(id, hasWindow(current.usage, id, true));
  const fallback = new Set(rules.fallback.providers);
  const paced = [...present].filter(id => windowOf.get(id) && !fallback.has(id)).sort(byOrder);
  const holdBack: Record<string, HoldChoice> = {};
  for (const id of paced) {
    const pace = effectivePace(rules, id);
    holdBack[id] = holdBackOf({ ...pace, provider: id });
  }
  const windowed = new Set(paced);
  const rank = rankFromModels(models, windowed);
  const pay: PayPerUse = rules.fallback.providers.length === 0 ? { providers: [], amount: null } : { providers: [...rules.fallback.providers], amount: rules.fallback.aim };
  const detected: DetectedProvider[] = [...present].sort(byOrder).map(id => ({
    id, label: providerLabel(policy, id), hasWindow: windowOf.get(id) === true, found: true, confirmed: true,
  }));
  const strengths: Record<string, Strength> = {};
  for (const m of models) {
    const tier = lookup(rules.tiers, { label: m.label, provider: m.provider, id: m.id });
    strengths[m.label] = tier === 'strong' || tier === 'light' ? tier : 'unsure';
  }
  return {
    stack: inferStack(holdBack, pay),
    detected,
    added: pay.providers.filter(id => !windowed.has(id)),
    holdBack,
    rank,
    payPerUse: pay,
    strengths,
    prose: [...rules.prose.models],
    seatsSecond: [...rules.seats.second.models],
  };
}

// ------------------------------------------------------------------ profile

export const PROFILE_KIND = 'augur-profile';
/** Option names a profile refuses, because a profile never carries a key. */
export const PROFILE_SECRET_OPTION = SECRET_OPTION;

const DH_KEYS = ['hostCountry', 'retainsPrompts', 'trainsOnPrompts', 'pinnedHost'] as const;
const PROPOSAL_FIELDS = ['dataTier', 'askFirst', 'output', 'sandbox', 'effort', 'cost'] as const;
const MODEL_KEYS = new Set(['id', 'name', 'rule']);
const RULE_KEYS = new Set<string>(['activities', 'dataHandling', ...PROPOSAL_FIELDS]);
const PROVIDER_ID = /^[a-z][a-z0-9_-]*$/;
const MODEL_LABEL = /^[a-z0-9][a-z0-9_-]*\/\S+$/i;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A model already stored on this computer, matched by provider and by label or model id. */
export interface ProfileModelRef { provider: string; label: string; id: string }

/** A model the profile would add. The rule is a proposal; the model stays unreviewed until the owner confirms it. */
export interface ProfileModelAdd { provider: string; label: string; id: string; name?: string; rule: ProposedRule }

export interface ProfileFilePlan {
  edits: Array<{ field: string; value: unknown }>;
  routes: Array<{ name: string; entry: Record<string, unknown> }>;
  existing: string[];
  models: ProfileModelAdd[];
  existingModels: string[];
  problems: string[];
}

/** The model rules a profile carries. A field the model inherits, and status, a pause, notes and thresholds, stay out. */
export function modelsSection(policy: unknown): Record<string, Record<string, { id: string; name?: string; rule: Record<string, unknown> }>> | null {
  if (!isObj(policy) || !isObj(policy.providers)) return null;
  const out: Record<string, Record<string, { id: string; name?: string; rule: Record<string, unknown> }>> = {};
  for (const [pid, raw] of Object.entries(policy.providers)) {
    if (!isObj(raw) || !isObj(raw.models)) continue;
    const models: Record<string, { id: string; name?: string; rule: Record<string, unknown> }> = {};
    for (const [label, mraw] of Object.entries(raw.models)) {
      if (!isObj(mraw) || typeof mraw.id !== 'string' || !mraw.id) continue;
      const inherited = new Set(Array.isArray(mraw.inherited) ? mraw.inherited.filter((x): x is string => typeof x === 'string') : []);
      const rule: Record<string, unknown> = {};
      if (isObj(mraw.activities)) {
        const activities: Record<string, unknown> = {};
        for (const [act, weight] of Object.entries(mraw.activities)) {
          if (inherited.has(`activities.${act}`)) continue;
          if (weight === null || typeof weight === 'string') activities[act] = weight;
        }
        if (Object.keys(activities).length) rule.activities = activities;
      }
      for (const field of PROPOSAL_FIELDS) {
        if (inherited.has(field) || !(field in mraw)) continue;
        if (field === 'effort' && mraw[field] === null) continue;
        rule[field] = mraw[field];
      }
      if (isObj(mraw.dataHandling) && !inherited.has('dataHandling')) {
        const handling: Record<string, unknown> = {};
        for (const key of DH_KEYS) {
          if (inherited.has(`dataHandling.${key}`) || !(key in mraw.dataHandling)) continue;
          handling[key] = mraw.dataHandling[key];
        }
        if (Object.keys(handling).length) rule.dataHandling = handling;
      }
      const entry: { id: string; name?: string; rule: Record<string, unknown> } = { id: mraw.id, rule };
      if (typeof mraw.name === 'string' && mraw.name) entry.name = mraw.name;
      models[label] = entry;
    }
    if (Object.keys(models).length) out[pid] = models;
  }
  return Object.keys(out).length ? out : null;
}

function checkProfileModels(data: Record<string, unknown>, existing: readonly ProfileModelRef[], plan: ProfileFilePlan): void {
  if (!Object.hasOwn(data, 'models') || data.models === undefined) return;
  if (!isObj(data.models)) { plan.problems.push('models is a map of providers to models.'); return; }
  const seen = new Set<string>();
  for (const [provider, raw] of Object.entries(data.models)) {
    if (!PROVIDER_ID.test(provider)) { plan.problems.push(`models ${provider}: a provider id starts with a lowercase letter and holds lowercase letters, digits, - and _.`); continue; }
    if (!isObj(raw)) { plan.problems.push(`models ${provider}: the models under a provider are a map of labels.`); continue; }
    for (const [label, entry] of Object.entries(raw)) {
      const where = `model ${label}`;
      if (!MODEL_LABEL.test(label) || label.includes('|') || !label.startsWith(`${provider}/`)) {
        plan.problems.push(`${where}: the label is ${provider}/ and the model id, with no spaces or | characters.`);
        continue;
      }
      if (!isObj(entry)) { plan.problems.push(`${where}: a model is an object with an id and a rule.`); continue; }
      const extra = Object.keys(entry).filter(k => !MODEL_KEYS.has(k));
      if (extra.length) { plan.problems.push(`${where}: ${extra[0]} is not part of a profile. A profile carries the proposal, not a status, a pause, notes or a threshold.`); continue; }
      if (typeof entry.id !== 'string' || !entry.id.trim() || /\s/.test(entry.id) || entry.id.includes('|')) { plan.problems.push(`${where}: a model id has no spaces or | characters.`); continue; }
      let name: string | undefined;
      if (entry.name !== undefined) {
        if (typeof entry.name !== 'string' || !entry.name.trim()) { plan.problems.push(`${where}: name is a text.`); continue; }
        name = entry.name;
      }
      const ruleRaw = entry.rule === undefined ? {} : entry.rule;
      if (!isObj(ruleRaw)) { plan.problems.push(`${where}: rule is an object.`); continue; }
      const ruleExtra = Object.keys(ruleRaw).filter(k => !RULE_KEYS.has(k));
      if (ruleExtra.length) { plan.problems.push(`${where}: rule.${ruleExtra[0]} is not part of a profile. A profile carries the proposal, not a status, a pause, notes or a threshold.`); continue; }
      const built = buildProposal(where, ruleRaw, plan);
      if (!built) continue;
      if (seen.has(`${provider}\n${entry.id}`) || seen.has(`${provider}\n${label}`)) { plan.problems.push(`${where}: that model is listed twice.`); continue; }
      seen.add(`${provider}\n${entry.id}`); seen.add(`${provider}\n${label}`);
      const prior = existing.find(m => m.provider === provider && (m.label === label || m.id === entry.id));
      if (prior) plan.existingModels.push(label);
      else plan.models.push({ provider, label, id: entry.id, ...(name ? { name } : {}), rule: built });
    }
  }
}

/** The proposal, or null when a field is not one an edit would accept. Problems are added to `plan`. */
function buildProposal(where: string, ruleRaw: Record<string, unknown>, plan: ProfileFilePlan): ProposedRule | null {
  const rule: ProposedRule = {};
  let bad = false;
  const reject = (text: string): void => { plan.problems.push(`${where}: ${text}`); bad = true; };
  if (ruleRaw.activities !== undefined) {
    if (!isObj(ruleRaw.activities)) reject('activities maps an activity to a weight.');
    else {
      const activities: NonNullable<ProposedRule['activities']> = {};
      for (const [act, weight] of Object.entries(ruleRaw.activities)) {
        if (!ACTIVITIES.includes(act as ActivityId)) { reject(`${act} is not an activity.`); continue; }
        if (weight === 'inherit') { reject(`activities.${act} is a proposal, so it cannot be "inherit".`); continue; }
        const problem = checkValue(`activities.${act}`, weight);
        if (problem) { reject(problem); continue; }
        activities[act] = weight as string | null;
      }
      if (Object.keys(activities).length) rule.activities = activities;
    }
  }
  for (const field of PROPOSAL_FIELDS) {
    if (!(field in ruleRaw)) continue;
    const value = ruleRaw[field];
    if (value === 'inherit') { reject(`${field} is a proposal, so it cannot be "inherit".`); continue; }
    const problem = checkValue(field, value);
    if (problem) { reject(problem); continue; }
    (rule as Record<string, unknown>)[field] = value;
  }
  if (ruleRaw.dataHandling !== undefined) {
    if (!isObj(ruleRaw.dataHandling)) reject('dataHandling is an object.');
    else {
      const handling: NonNullable<ProposedRule['dataHandling']> = {};
      for (const [key, value] of Object.entries(ruleRaw.dataHandling)) {
        if (!(DH_KEYS as readonly string[]).includes(key)) { reject(`dataHandling.${key} is not a data-handling field.`); continue; }
        if (value === 'inherit') { reject(`dataHandling.${key} is a proposal, so it cannot be "inherit".`); continue; }
        const problem = checkValue(`dataHandling.${key}`, value);
        if (problem) { reject(problem); continue; }
        handling[key] = value as string | boolean | null;
      }
      if (Object.keys(handling).length) rule.dataHandling = handling;
    }
  }
  return bad ? null : rule;
}

/** What importing a profile would do. Every balance setting, route and model is checked, so one bad entry stops the whole import. */
export function planProfileFile(text: string, existingRoutes: ReadonlySet<string>, existingModels: readonly ProfileModelRef[] = []): ProfileFilePlan | { error: string } {
  let data: unknown;
  try { data = JSON.parse(text); } catch (e) { return { error: `That file is not valid JSON: ${(e as Error).message}` }; }
  // A key this build does not read is ignored, so a profile from a newer Augur still imports.
  if (!isObj(data) || data.kind !== PROFILE_KIND) return { error: `That file is not an Augur profile. A profile has "kind": "${PROFILE_KIND}".` };
  if (data.schema !== 1) return { error: `This profile is schema ${String(data.schema)}, and this Augur reads schema 1. Update Augur, or export the profile again.` };
  const plan: ProfileFilePlan = { edits: [], routes: [], existing: [], models: [], existingModels: [], problems: [] };
  for (const { path, value } of balanceLeaves(data.balance)) {
    const bad = checkBalanceSetting(path, value);
    if (bad) plan.problems.push(`balance ${path.join('.')}: ${bad}`); else plan.edits.push({ field: balanceField(path), value });
  }
  const routes = isObj(data.routes) ? data.routes : {};
  const parsed = parseRoutesText(JSON.stringify({ routes }));
  if (parsed.ok) {
    for (const name of parsed.file.skipped) plan.problems.push(`route ${name}: needs a name of lowercase letters, digits, - and _, a model and an adapter.`);
    for (const r of parsed.file.routes) {
      const raw = (parsed.file.raw.routes as Record<string, unknown>)[r.name] as Record<string, unknown>;
      if (!adapterInfo(r.adapter)) { plan.problems.push(`route ${r.name}: ${r.adapter} is not an adapter this Augur has.`); continue; }
      const secret = isObj(raw.options) ? Object.keys(raw.options).find(k => PROFILE_SECRET_OPTION.test(k)) : undefined;
      if (secret) { plan.problems.push(`route ${r.name}: the option ${secret} looks like a key. A profile never carries one; use augur key set ${r.name}.`); continue; }
      if (existingRoutes.has(r.name)) plan.existing.push(r.name); else plan.routes.push({ name: r.name, entry: raw });
    }
  }
  checkProfileModels(data, existingModels, plan);
  return plan;
}

const providerOfLabel = (label: string): string => {
  const prefix = label.slice(0, Math.max(0, label.indexOf('/')));
  return LABEL_PROVIDER[prefix] ?? prefix;
};

/**
 * Fills answers from a profile file after the whole file is checked. A bad file returns the problems and leaves `current` unchanged.
 * Model proposals in the file are not interview answers, so the rank stays empty until the person sets it.
 */
export function answersFromProfile(file: string, current: SetupCurrent): { answers: SetupAnswers } | { problems: string[] } {
  const plan = planProfileFile(file, new Set(current.routes.map(r => r.name)));
  if ('error' in plan) return { problems: [plan.error] };
  if (plan.problems.length) return { problems: [...plan.problems] };
  const data = JSON.parse(file) as { balance?: unknown; routes?: Record<string, { model?: unknown }> };
  const rules = resolveBalance(data.balance);
  const labels = new Set<string>();
  for (const key of Object.keys(rules.tiers)) if (!key.includes('*') && key.includes('/')) labels.add(key);
  for (const m of rules.prose.models) if (m.includes('/')) labels.add(m);
  for (const m of rules.seats.second.models) if (m.includes('/')) labels.add(m);
  for (const entry of Object.values(data.routes ?? {})) if (typeof entry?.model === 'string' && entry.model.includes('/')) labels.add(entry.model);
  const providers: Record<string, { models: Record<string, { id: string; status: string; rule: Record<string, unknown> }> }> = {};
  for (const label of labels) {
    const id = providerOfLabel(label);
    const slot = providers[id] ??= { models: {} };
    slot.models[label] = { id: label.slice(label.indexOf('/') + 1), status: 'confirmed', rule: {} };
  }
  const routes: SetupRoute[] = Object.entries(data.routes ?? {}).map(([name, entry]) => ({ name, model: typeof entry?.model === 'string' ? entry.model : '', hasKey: false }));
  const answers = answersFromCurrent({ policy: { providers }, balance: data.balance, routes, usage: null });
  answers.stack = 'profile';
  return { answers };
}

// ------------------------------------------------------------------ plan

export type ChangeStatus = 'unchanged' | 'change' | 'new';

export interface SetupChange {
  id: string;
  /** The step the summary groups this line under. */
  area: StepId;
  label: string;
  from: string;
  to: string;
  status: ChangeStatus;
  /** The policy edit an app sends. Null when the row writes nothing. */
  edit: PolicyEdit | null;
}

export interface SetupPlan {
  changes: SetupChange[];
  problems: string[];
  /** The rank in words, for the pace group of the summary. */
  rankWords: string;
  routesToTest: string[];
  unreviewed: string[];
}

const BY = 'setup interview';

function editFor(id: string, field: string, value: unknown, provider = '', model = ''): PolicyEdit {
  return { id, at: '', by: BY, provider, model, field, value };
}

function paceStored(raw: unknown, provider: string, steered: string, key: 'reserve' | 'band'): boolean {
  const block = rec(rec(rec(raw).pace)[provider]);
  if (key in block) return true;
  return provider === steered && key in rec(rec(raw).claude);
}

function listStored(raw: unknown, path: readonly string[]): boolean {
  let at: unknown = raw;
  for (const k of path) {
    if (!rec(at) || !Object.hasOwn(rec(at), k)) return false;
    at = rec(at)[k];
  }
  return true;
}

function tierStored(raw: unknown, label: string): boolean {
  return Object.hasOwn(rec(rec(raw).tiers), label);
}

function rankWords(answers: SetupAnswers): string {
  const label = new Map(answers.detected.map(d => [d.id, d.label]));
  const name = (id: string): string => label.get(id) ?? id.slice(0, 1).toUpperCase() + id.slice(1);
  const { rank } = answers;
  if (rank.length === 0) return 'No order set yet.';
  if (rank.length === 1) return `${name(rank[0]!)} first.`;
  const names = rank.map(name);
  const last = names[names.length - 1]!;
  const middle = names.slice(1, -1);
  const line = middle.length ? `${names[0]} first, then ${middle.join(', ')}, then ${last} last.` : `${names[0]} first, then ${last}.`;
  const quiet = rank.filter(id => answers.detected.find(d => d.id === id)?.hasWindow === false);
  if (!quiet.length) return line;
  const who = quiet.map(name).join(' and ');
  return `${line} ${who} ${quiet.length === 1 ? 'has' : 'have'} no usage window, so nothing waits for ${quiet.length === 1 ? 'it' : 'them'}.`;
}

function modelsByProvider(models: readonly SeenModel[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of models) (out[m.provider] ??= []).push(m.label);
  for (const id of Object.keys(out)) out[id] = [...new Set(out[id])].sort();
  return out;
}

function windowOfAnswers(answers: SetupAnswers): (id: string) => boolean {
  const map = new Map(answers.detected.map(d => [d.id, d.hasWindow]));
  return id => map.get(id) ?? WINDOW_PROVIDERS.has(id);
}

/** The edit plan. Rows the answers leave alone are marked unchanged and carry no edit. */
export function planSetup(answers: SetupAnswers, current: SetupCurrent): SetupPlan {
  const raw = storedBalance(current);
  const rules = resolveBalance(raw);
  const models = seenModels(current.policy);
  const has = (provider: string, model: string): boolean => models.some(m => m.provider === provider && m.label === model);
  const problems: string[] = [];
  const changes: SetupChange[] = [];
  const steered = rules.claude.provider;

  if (new Set(answers.rank).size !== answers.rank.length) problems.push('A subscription is listed twice in the order. Remove one of them.');
  const pay = answers.payPerUse;
  if (pay && pay.providers.some(id => !id)) problems.push('A pay-per-use provider is missing its name. Pick one from the list.');
  if (pay && pay.providers.length > 0 && pay.amount === null) problems.push('Enter a monthly amount for pay per use, or choose No backup spending.');
  if (pay && pay.amount !== null && !(typeof pay.amount === 'number' && Number.isFinite(pay.amount) && pay.amount >= 0)) problems.push('The monthly amount has to be 0 or more. Change it, or leave the field empty.');

  const push = (row: SetupChange): void => {
    if (!row.edit) { changes.push(row); return; }
    const bad = checkEdit(row.edit, has);
    if (bad) { problems.push(bad); changes.push({ ...row, edit: null, status: 'unchanged' }); return; }
    changes.push(row);
  };

  const paceIds = [...new Set([...Object.keys(answers.holdBack), ...answers.rank])].sort((a, b) => {
    const ia = answers.rank.indexOf(a), ib = answers.rank.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  });
  for (const id of paceIds) {
    const choice = answers.holdBack[id];
    if (!choice) continue;
    const now = effectivePace(rules, id);
    if (choice === 'custom') {
      const from = `${now.reserve}% reserve, band ${now.band}`;
      push({ id: `pace:${id}`, area: 'pace', label: `${providerLabel(current.policy, id)} hold-back`, from, to: 'custom, kept as it is', status: 'unchanged', edit: null });
      continue;
    }
    const target = paceNumbers(choice, id);
    for (const key of ['reserve', 'band'] as const) {
      const same = now[key] === target[key];
      const status: ChangeStatus = same ? 'unchanged' : paceStored(raw, id, steered, key) ? 'change' : 'new';
      push({
        id: `pace:${id}:${key}`, area: 'pace', label: `${providerLabel(current.policy, id)} ${key === 'reserve' ? 'reserve' : 'pace band'}`,
        from: key === 'reserve' ? `${now.reserve}%` : String(now.band), to: key === 'reserve' ? `${target[key]}%` : String(target[key]),
        status, edit: same ? null : editFor(`pace:${id}:${key}`, balanceField(['pace', id, key]), target[key]),
      });
    }
  }

  if (answers.rank.length) {
    const byProvider = modelsByProvider(models);
    const target = useAfterFromRank(answers.rank, byProvider, windowOfAnswers(answers));
    const owner = new Map(models.map(m => [m.label, m.provider]));
    const ranked = new Set(answers.rank);
    const ownersOf = (labels: readonly string[]): Set<string> => new Set(labels.map(l => owner.get(l)).filter((x): x is string => !!x));
    const paced = new Set(Object.keys(answers.holdBack));
    const touched = [...answers.rank, ...[...paced].filter(id => !ranked.has(id)).sort()];
    const ordered = touched.flatMap(id => models.filter(m => m.provider === id).sort((a, b) => a.label.localeCompare(b.label)));
    for (const m of ordered) {
      const want = ranked.has(m.provider) ? (target[m.provider] ?? []) : [];
      const have = m.useAfter;
      let status: ChangeStatus = 'unchanged';
      let write = false;
      if (sameSet(have, want)) { /* already the list */ }
      else if (want.length === 0) {
        const waitsOnRank = have.some(label => ranked.has(owner.get(label) ?? ''));
        if (waitsOnRank) { write = true; status = 'change'; }
      } else if (have.length && sameSet([...ownersOf(have)], [...ownersOf(want)])) {
        /* Already waits on the provider just above, so a re-run leaves the list as it stands. */
      } else { write = true; status = have.length ? 'change' : 'new'; }
      push({
        id: `use-after:${m.label}`, area: 'pace', label: `${m.label} waits for`,
        from: have.length ? have.join(', ') : 'none', to: want.length ? want.join(', ') : 'none',
        status, edit: write ? editFor(`use-after:${m.label}`, 'useAfter', want, m.provider, m.label) : null,
      });
    }
  }

  const payOk = !!pay && pay.providers.every(id => !!id) && (pay.providers.length === 0 || (typeof pay.amount === 'number' && Number.isFinite(pay.amount) && pay.amount >= 0));
  if (pay && payOk) {
    const fromProviders = rules.fallback.providers;
    const toProviders = pay.amount === null ? [] : [...pay.providers];
    const providersSame = fromProviders.length === toProviders.length && fromProviders.every((id, i) => id === toProviders[i]);
    push({
      id: 'fallback:providers', area: 'pace', label: 'Backup providers',
      from: fromProviders.length ? fromProviders.join(', ') : 'none', to: toProviders.length ? toProviders.join(', ') : 'none',
      status: providersSame ? 'unchanged' : listStored(raw, ['fallback', 'providers']) ? 'change' : 'new',
      edit: providersSame ? null : editFor('fallback:providers', balanceField(['fallback', 'providers']), toProviders),
    });
    if (pay.amount !== null) {
      const same = rules.fallback.aim === pay.amount;
      push({
        id: 'fallback:aim', area: 'pace', label: 'Monthly backup spend',
        from: `$${rules.fallback.aim}`, to: `$${pay.amount}`,
        status: same ? 'unchanged' : listStored(raw, ['fallback', 'aim']) ? 'change' : 'new',
        edit: same ? null : editFor('fallback:aim', balanceField(['fallback', 'aim']), pay.amount),
      });
    }
  }

  for (const label of Object.keys(answers.strengths).sort()) {
    const answer = answers.strengths[label];
    if (!answer) continue;
    const model = models.find(m => m.label === label);
    const tier = model ? lookup(rules.tiers, { label, provider: model.provider, id: model.id }) : undefined;
    const from = tier === 'strong' || tier === 'light' ? tier : 'not set';
    if (answer === 'unsure') {
      push({ id: `tier:${label}`, area: 'review', label: `${label} strength`, from, to: 'not sure, left as it is', status: 'unchanged', edit: null });
      continue;
    }
    const same = tier === answer;
    push({
      id: `tier:${label}`, area: 'review', label: `${label} strength`, from, to: answer,
      status: same ? 'unchanged' : tierStored(raw, label) ? 'change' : 'new',
      edit: same ? null : editFor(`tier:${label}`, balanceField(['tiers', label]), answer),
    });
  }

  const listRow = (id: string, area: StepId, label: string, path: readonly string[], have: readonly string[], want: string[] | 'skipped' | null): void => {
    if (want === null || want === 'skipped') return;
    const same = have.length === want.length && have.every((x, i) => x === want[i]);
    push({
      id, area, label, from: have.length ? have.join(', ') : 'none', to: want.length ? want.join(', ') : 'none',
      status: same ? 'unchanged' : listStored(raw, path) ? 'change' : 'new',
      edit: same ? null : editFor(id, balanceField(path), want),
    });
  };
  listRow('prose:models', 'review', 'Prose models', ['prose', 'models'], rules.prose.models, answers.prose);
  listRow('seats:second', 'review', 'Second-opinion models', ['seats', 'second', 'models'], rules.seats.second.models, answers.seatsSecond);

  const unreviewed = [...new Set([
    ...strings(rec(current.policy).unreviewed),
    ...models.filter(m => m.status === 'unreviewed' || m.status === 'imported').map(m => m.label),
  ])].sort();
  return { changes, problems, rankWords: rankWords(answers), routesToTest: current.routes.filter(r => r.hasKey).map(r => r.name), unreviewed };
}

export interface SummaryGroup { step: StepId; lines: string[] }

const STATUS_WORD: Record<ChangeStatus, string> = { unchanged: 'unchanged', change: 'will change', new: 'new' };

/** Plain lines for the live summary, one group per step. The pace group states the rank in words. */
export function summaryLines(plan: SetupPlan): SummaryGroup[] {
  return SETUP_STEPS.map(step => {
    const lines: string[] = [];
    if (step.id === 'pace') lines.push(plan.rankWords);
    for (const c of plan.changes) if (c.area === step.id) lines.push(`${c.label}: ${c.to} (${STATUS_WORD[c.status]})`);
    return { step: step.id, lines };
  });
}

export const problems = (plan: SetupPlan): string[] => [...plan.problems];
export const isValid = (plan: SetupPlan): boolean => plan.problems.length === 0;

export interface SetupOp { name: 'policy-edit'; payload: PolicyEdit }

/**
 * The operations an app runs, in order: pace reserve and band, then useAfter, then backup providers and the monthly amount,
 * then model strengths, then prose models, then the second opinion. Unchanged rows are left out.
 */
export function applySteps(plan: SetupPlan): SetupOp[] {
  const order = (c: SetupChange): number => {
    if (c.id.endsWith(':reserve')) return 0;
    if (c.id.endsWith(':band')) return 1;
    if (c.id.startsWith('use-after:')) return 2;
    if (c.id === 'fallback:providers') return 3;
    if (c.id === 'fallback:aim') return 4;
    if (c.id.startsWith('tier:')) return 5;
    if (c.id === 'prose:models') return 6;
    return 7;
  };
  return plan.changes.filter(c => c.edit && c.status !== 'unchanged').map((c, i) => ({ c, i })).sort((a, b) => order(a.c) - order(b.c) || a.i - b.i).map(({ c }) => ({ name: 'policy-edit' as const, payload: c.edit as PolicyEdit }));
}

export interface SetupDone {
  routesToTest: string[];
  unreviewed: string[];
  next: readonly [string, string, string];
}

const NEXT: SetupDone['next'] = [
  'Test each route that has a key.',
  'Confirm any model listed under Still to confirm on the Rules page. No agent can run it until you do.',
  'Augur now uses your subscriptions in the order you set, and holds each one back the way you chose.',
];

/** The last screen: routes that have a key, models still unreviewed, and three lines on what happens next. */
export function afterApply(plan: SetupPlan): SetupDone {
  return { routesToTest: [...plan.routesToTest], unreviewed: [...plan.unreviewed], next: NEXT };
}
