// The automatic balance: standing rules about which models suit which kind of work, turned into a tilt on each model's score. Pure.
// `rank()` multiplies the tilt into the score it already computes, so the weights, pauses, ask-first, data tiers and the usage factor all still apply.
import { ACTIVITIES } from '@augur/core';
import type { ActivityId, PolicyFile } from '@augur/core';
import { BOOST, PACE, ageMinutes, freshLimits, pressure } from './pace.js';
import type { UsageSnapshot } from './pace.js';

/**
 * How much the task weighs. Routine work is glue, plumbing, renames, boilerplate and anything cheap to redo. Everyday work is review, research, summaries and bulk work.
 * Deep work is hard reasoning and serious coding. Core work is the engine of a tool, core logic, security-critical code, or anything costly to get wrong or redo.
 */
export type Depth = 'routine' | 'everyday' | 'deep' | 'core';
export const DEPTHS: readonly Depth[] = ['routine', 'everyday', 'deep', 'core'];
/** A strong model suits deep work and is overkill for everyday work. A light one is the reverse. A model with no tier is not tilted. */
export type ModelTier = 'strong' | 'light';

/** The starting rules. Classic is what every install had before profiles existed and what an install that names none keeps. Neutral tilts only for pace. */
export type Profile = 'classic' | 'neutral';
export const PROFILES: readonly Profile[] = ['classic', 'neutral'];

/** Pace for one provider. `boost` is the peak of the unused-allowance boost; 1 turns it off. */
export interface PaceRules {
  /** Points of usage ahead of or behind the share of the window elapsed that still count as on pace. */
  band: number;
  /** A window at or above this percent moves optional work off this provider. */
  reserve: number;
  /** The score multiplier for each tier when this provider runs hot (ahead of pace) and when it runs behind. */
  hot: Record<ModelTier, number>;
  behind: Record<ModelTier, number>;
  /** The peak multiplier of the unused-allowance boost. 1 turns the boost off. */
  boost: number;
}

/** Pace for a provider the rules do not name. Claude's own entry uses a tighter band. */
export const DEFAULT_PACE_RULES: PaceRules = {
  band: 10, reserve: 90, hot: { strong: 0.8, light: 1.25 }, behind: { strong: 1.25, light: 0.85 }, boost: 1.5,
};

const CLAUDE_PACE: PaceRules = { band: 5, reserve: 90, hot: { strong: 0.8, light: 1.25 }, behind: { strong: 1.25, light: 0.85 }, boost: 1.5 };

export interface BalanceRules {
  /** Which starting rules the overrides sit on. */
  profile: Profile;
  /** Switches the whole balance off. The pick then ranks on weights and usage alone. */
  enabled: boolean;
  /** A route is boosted only when the caller fit is at or above this. No caller fit still counts. */
  boostFitFloor: number;
  /** Whether a caller that asks for a draw gets one, and the share of the top score a route must reach to stay in it. */
  draw: { enabled: boolean; tail: number };
  /** The depth of an activity when the caller does not say. */
  depth: Record<ActivityId, Depth>;
  /** The tier of each route, by label or by standard name (provider id, a slash, model id). A `*` in a name matches any text. */
  tiers: Record<string, ModelTier>;
  /** Route labels, or ids containing any of these words, that are never picked. */
  exclude: string[];
  /** The score multiplier for a tier at each depth. */
  tilt: Record<Depth, Record<ModelTier, number>>;
  /** Limits on how often a route is picked, by route label, standard name or pattern. A route over a limit is out of the running unless it is named. */
  caps: Record<string, RouteCap>;
  /** Training mode: whether a pick on an expensive route waits for a person, and when a kind of work has earned the right to stop asking. */
  training: TrainingRules;
  /** Route labels that write the best prose, and the multiplier they get on draft_prose in place of the depth tilt. */
  prose: {
    models: string[]; tilt: number;
    /** The pace switch: when a provider that serves one of these routes runs ahead of pace, prose drafting moves off that provider. */
    pace: { enabled: boolean; ahead: number; aheadAtReserve: number; returnAt: number };
  };
  /** Pace per provider id. */
  pace: Record<string, PaceRules>;
  /** The steered provider, taken from `pace` after overrides resolve. `provider` names it and the numbers are that entry. */
  claude: {
    /** The provider id the controller steers. */
    provider: string;
    /** Points of usage ahead of or behind the share of the window elapsed that still count as on pace. */
    band: number;
    /** A window at or above this percent moves optional work off Claude. */
    reserve: number;
    /** The score multiplier for each tier when Claude runs hot (ahead of pace) and when it runs behind. */
    hot: Record<ModelTier, number>;
    behind: Record<ModelTier, number>;
  };
  /** Backup routes. They compete only when no subscription route can take the work, and Copilot spend is held to a budget. */
  fallback: {
    /** Providers whose routes are backups. */
    providers: string[];
    /** Single routes that are backups for some activities only, by route label. */
    routes: Record<string, string[]>;
    /** Anthropic routes through a backup provider. They are allowed when Claude is at its reserve, since a Claude stop halts everything. */
    anthropic: string[];
    /** Dollars of Copilot spend the router aims to stay under, the hard stop, and the margin added to the last known spend for figures that lag. */
    aim: number;
    cap: number;
    margin: number;
  };
  /** What each route is known to be good at: a multiplier per activity, by route label. */
  prefer: Record<string, Partial<Record<ActivityId, number>>>;
  /** The extra seats a pick names beside its model. */
  seats: {
    /** Models that give a second opinion, in order, and the activities too small to need one. */
    second: { models: string[]; skip: ActivityId[] };
    /** The free web routes to recommend for an activity, in order. The calling session drives the browser. */
    web: Partial<Record<ActivityId, string[]>>;
    /** The local model that shadows decisions a reasoning model makes, so its answers can be compared and learned from. */
    shadow: string;
    /** Jev is first for classification, noul and scoring: its route gets this multiplier on those activities. */
    jev: { route: string; activities: ActivityId[]; tilt: number };
  };
}

export interface TrainingRules {
  /** Switches training mode on. Off, every pick stands as drawn. */
  enabled: boolean;
  /** The share of recent answers that must agree with the proposal before a kind of work stops asking. */
  agree: number;
  /** How many of the newest answers for a kind of work are weighed. */
  window: number;
  /** How many answers a kind of work needs before it can stop asking. */
  min: number;
  /** Once a kind of work has stopped asking, one pick in this many is still asked, to keep measuring. 0 turns the spot check off. */
  spot: number;
  /** Picks at these depths always ask. */
  askDepths: Depth[];
  /** Picks of routes in these tiers ask, or learn to stop. A pick of a route in neither a listed tier nor askRoutes is never asked. */
  askTiers: ModelTier[];
  /** Routes that always ask, by label, standard name or pattern. */
  askRoutes: string[];
}

export const DEFAULT_TRAINING: TrainingRules = { enabled: false, agree: 0.9, window: 20, min: 10, spot: 10, askDepths: ['core'], askTiers: ['strong'], askRoutes: [] };

/** Picks of a route that count against it: `perDay` over the last 24 hours, `perSession` within one caller session. `parallel` is the most jobs of the route that run at once, and the rest wait in the queue. 0 turns a limit off. */
export interface RouteCap { perDay: number; perSession: number; parallel?: number }

const DEEP: ActivityId[] = ['write_code', 'reason_critique', 'reverse_engineering'];

export const DEFAULT_BALANCE: BalanceRules = {
  profile: 'classic',
  enabled: true,
  boostFitFloor: BOOST.fitFloor,
  draw: { enabled: true, tail: 0.25 },
  depth: Object.fromEntries(ACTIVITIES.map(a => [a, DEEP.includes(a) ? 'deep' : 'everyday'])) as Record<ActivityId, Depth>,
  tiers: {
    'claude/live': 'strong', 'claude/opus': 'strong', 'codex/sol': 'strong', 'xai/grok': 'strong',
    'copilot/claude-opus-5.5': 'strong', 'copilot/gpt-6.1-sol': 'strong', 'copilot/grok-4.7': 'strong',
    'claude/claude-sonnet-5-5': 'light', 'claude/sonnet': 'light', 'codex/luna': 'light', 'minimax/*m3*': 'light', 'deepseek/v4.1-flash': 'light',
    'copilot/claude-sonnet-5.5': 'light', 'copilot/gpt-6-luna': 'light', 'copilot/gemini-3.8-flash': 'light',
  },
  exclude: ['fable', 'astra'],
  tilt: { routine: { strong: 0.35, light: 1.3 }, everyday: { strong: 0.85, light: 1.15 }, deep: { strong: 1.4, light: 0.8 }, core: { strong: 1.6, light: 0.6 } },
  caps: {},
  training: { ...DEFAULT_TRAINING },
  prose: { models: ['claude/live', 'claude/opus', 'copilot/claude-opus-5.5'], tilt: 1.3, pace: { enabled: true, ahead: 12, aheadAtReserve: 3, returnAt: 0 } },
  pace: { claude: CLAUDE_PACE },
  claude: { provider: 'claude', band: CLAUDE_PACE.band, reserve: CLAUDE_PACE.reserve, hot: CLAUDE_PACE.hot, behind: CLAUDE_PACE.behind },
  fallback: { providers: ['copilot'], routes: { 'deepseek/v4.1-flash': ['write_code'] }, anthropic: ['copilot/claude-opus-5.5', 'copilot/claude-sonnet-5.5'], aim: 150, cap: 250, margin: 5 },
  prefer: {
    'minimax/*m3*': { long_context: 1.6, summarize_extract: 1.4 },
    'codex/luna': { review_code: 1.2, research: 1.2 },
    'claude/claude-sonnet-5-5': { review_code: 1.2, research: 1.2 },
    'claude/sonnet': { review_code: 1.2, research: 1.2 },
    'deepseek/v4.1-flash': { review_code: 1.2 },
    'chatgpt/web': { research: 1.3 },
    'xai/grok': { write_code: 1.1, review_code: 1.1, research: 1.1 },
  },
  seats: {
    second: { models: ['minimax/*m3*'], skip: ['bulk_tagging', 'typed_decisions', 'speech', 'generate_images', 'generate_video', 'read_images'] },
    web: { research: ['chatgpt/web', 'gemini/web'], generate_images: ['chatgpt/web', 'gemini/web'], read_images: ['gemini/web', 'chatgpt/web'], long_context: ['gemini/web'] },
    shadow: 'laya/laya',
    jev: { route: 'jev/jev-latest', activities: ['typed_decisions', 'bulk_tagging'], tilt: 3 },
  },
};

/** A fresh install: balance on, and only Claude's pace tilts (Sonnet when hot, Opus when behind). No route is held back, preferred or excluded, and no model is named for a seat. */
export const NEUTRAL_BALANCE: BalanceRules = {
  ...DEFAULT_BALANCE,
  profile: 'neutral',
  pace: DEFAULT_BALANCE.pace,
  tiers: { 'claude/*opus*': 'strong', 'claude/*sonnet*': 'light', 'claude/*haiku*': 'light' },
  exclude: [],
  tilt: { routine: { strong: 1, light: 1 }, everyday: { strong: 1, light: 1 }, deep: { strong: 1, light: 1 }, core: { strong: 1, light: 1 } },
  caps: {},
  training: { ...DEFAULT_TRAINING },
  prose: { models: [], tilt: 1, pace: DEFAULT_BALANCE.prose.pace },
  fallback: { providers: [], routes: {}, anthropic: [], aim: DEFAULT_BALANCE.fallback.aim, cap: DEFAULT_BALANCE.fallback.cap, margin: DEFAULT_BALANCE.fallback.margin },
  prefer: {},
  seats: { second: { models: [], skip: [...DEFAULT_BALANCE.seats.second.skip] }, web: {}, shadow: '', jev: { route: '', activities: [], tilt: 1 } },
};

/** A model as the rules see it: the person's label, and the standard name made of its provider and its model id. */
export interface ModelRef { label: string; provider: string; id: string }
export const standardName = (provider: string, id: string): string => `${provider}/${id}`;
const globs = new Map<string, RegExp>();
const glob = (key: string): RegExp => { let re = globs.get(key); if (!re) { re = new RegExp(`^${key.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i'); globs.set(key, re); } return re; };

/** Whether a rule's name stands for this model: its label, its standard name, or a pattern with `*` that either one fits. */
export function nameMatches(key: string, ref: ModelRef): boolean {
  if (key === ref.label || key === standardName(ref.provider, ref.id)) return true;
  return key.includes('*') && (glob(key).test(ref.label) || glob(key).test(standardName(ref.provider, ref.id)));
}

/** The entry a map holds for a model. A label's own entry wins over its standard name's, which wins over a pattern, so a rule written against a label keeps meaning what it did. */
export function lookup<T>(map: Record<string, T>, ref: ModelRef): T | undefined {
  if (Object.hasOwn(map, ref.label)) return map[ref.label];
  const standard = standardName(ref.provider, ref.id);
  if (Object.hasOwn(map, standard)) return map[standard];
  for (const [key, value] of Object.entries(map)) if (key.includes('*') && nameMatches(key, ref)) return value;
  return undefined;
}

/** Whether a list of rule names includes this model. */
export const listed = (list: readonly string[], ref: ModelRef): boolean => list.some(key => nameMatches(key, ref));

/** The label of the first model a rule's name stands for, or null when the policy holds none. Seats and fallbacks name models this way so a standard name reaches a person's own label. */
export function resolveLabel(policy: PolicyFile, key: string): string | null {
  if (!key) return null;
  for (const [provider, p] of Object.entries(policy.providers)) if (Object.hasOwn(p.models, key)) return key;
  for (const [provider, p] of Object.entries(policy.providers)) for (const [label, m] of Object.entries(p.models)) if (nameMatches(key, { label, provider, id: m.id })) return label;
  return null;
}

const num = (v: unknown, fallback: number): number => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
const unit = (v: unknown, fallback: number): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback;
const zeroUp = (v: unknown, fallback: number): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
const strings = (v: unknown): string[] | null => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : null;
const rec = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** The defaults with whatever `policy.balance` overrides. A field of the wrong type keeps its default. */
export function resolveBalance(raw: unknown): BalanceRules {
  const s = rec(raw), profile: Profile = s.profile === 'neutral' ? 'neutral' : 'classic', d = profile === 'neutral' ? NEUTRAL_BALANCE : DEFAULT_BALANCE;
  const depth = { ...d.depth }, tiers = { ...d.tiers };
  for (const [a, v] of Object.entries(rec(s.depth))) if ((ACTIVITIES as readonly string[]).includes(a) && (DEPTHS as readonly unknown[]).includes(v)) depth[a as ActivityId] = v as Depth;
  for (const [m, v] of Object.entries(rec(s.tiers))) { if (v === 'strong' || v === 'light') tiers[m] = v; else if (v === null) delete tiers[m]; }
  const tilt = Object.fromEntries(DEPTHS.map(k => [k, { ...d.tilt[k] }])) as BalanceRules['tilt'];
  const caps: Record<string, RouteCap> = Object.fromEntries(Object.entries(d.caps).map(([k, v]) => [k, { ...v }]));
  for (const [m, v] of Object.entries(rec(s.caps))) {
    if (v === null) { delete caps[m]; continue; }
    const o = rec(v), was = caps[m] ?? { perDay: 0, perSession: 0 };
    const parallel = Math.floor(zeroUp(o.parallel, was.parallel ?? 0));
    caps[m] = { perDay: Math.floor(zeroUp(o.perDay, was.perDay)), perSession: Math.floor(zeroUp(o.perSession, was.perSession)), ...(parallel > 0 ? { parallel } : {}) };
  }
  const tr = rec(s.training), tdef = d.training;
  const training: TrainingRules = {
    enabled: typeof tr.enabled === 'boolean' ? tr.enabled : tdef.enabled,
    agree: unit(tr.agree, tdef.agree), window: Math.max(1, Math.floor(num(tr.window, tdef.window))), min: Math.max(1, Math.floor(num(tr.min, tdef.min))), spot: Math.floor(zeroUp(tr.spot, tdef.spot)),
    askDepths: (strings(tr.askDepths) ?? tdef.askDepths).filter((x): x is Depth => (DEPTHS as readonly string[]).includes(x)),
    askTiers: (strings(tr.askTiers) ?? tdef.askTiers).filter((x): x is ModelTier => x === 'strong' || x === 'light'),
    askRoutes: strings(tr.askRoutes) ?? [...tdef.askRoutes],
  };
  for (const depthKey of DEPTHS) for (const tier of ['strong', 'light'] as const) tilt[depthKey][tier] = num(rec(rec(s.tilt)[depthKey])[tier], tilt[depthKey][tier]);
  const prose = rec(s.prose), proseSwitch = rec(prose.pace), cl = rec(s.claude), fb = rec(s.fallback), st = rec(s.seats);
  const acts = (v: unknown): ActivityId[] | null => { const a = strings(v); return a ? a.filter((x): x is ActivityId => (ACTIVITIES as readonly string[]).includes(x)) : null; };
  const web: Partial<Record<ActivityId, string[]>> = { ...d.seats.web };
  for (const [a, v] of Object.entries(rec(st.web))) if ((ACTIVITIES as readonly string[]).includes(a)) { const l = strings(v); if (l) web[a as ActivityId] = l; else if (v === null) delete web[a as ActivityId]; }
  const jev = rec(st.jev), second = rec(st.second);
  const prefer: BalanceRules['prefer'] = Object.fromEntries(Object.entries(d.prefer).map(([m, v]) => [m, { ...v }]));
  for (const [m, v] of Object.entries(rec(s.prefer))) {
    if (v === null) { delete prefer[m]; continue; }
    for (const [a, n] of Object.entries(rec(v))) if ((ACTIVITIES as readonly string[]).includes(a)) { const mine = (prefer[m] ??= {}); if (n === null) delete mine[a as ActivityId]; else if (typeof n === 'number' && Number.isFinite(n) && n > 0) mine[a as ActivityId] = n; }
  }
  const routes: Record<string, string[]> = { ...d.fallback.routes };
  for (const [label, v] of Object.entries(rec(fb.routes))) { const a = strings(v); if (a) routes[label] = a; else if (v === null) delete routes[label]; }
  const money = (v: unknown, fallback: number): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
  const pair = (v: unknown, dflt: Record<ModelTier, number>): Record<ModelTier, number> => ({ strong: num(rec(v).strong, dflt.strong), light: num(rec(v).light, dflt.light) });
  // 1 turns the boost off, so a number below 1 is left at the lower layer.
  const boostOf = (v: unknown, fallback: number): number => typeof v === 'number' && Number.isFinite(v) && v >= 1 ? v : fallback;
  const applyPace = (base: PaceRules, layer: unknown): PaceRules => {
    const o = rec(layer);
    return { band: num(o.band, base.band), reserve: num(o.reserve, base.reserve), hot: pair(o.hot, base.hot), behind: pair(o.behind, base.behind), boost: boostOf(o.boost, base.boost) };
  };
  const steered = typeof cl.provider === 'string' && cl.provider ? cl.provider : d.claude.provider;
  const paceRaw = rec(s.pace);
  const names = new Set<string>([...Object.keys(d.pace), ...Object.keys(paceRaw), steered]);
  const pace: Record<string, PaceRules> = {};
  for (const id of names) {
    const builtin = d.pace[id] ?? (id === 'claude' ? CLAUDE_PACE : DEFAULT_PACE_RULES);
    let entry: PaceRules = { band: builtin.band, reserve: builtin.reserve, hot: { ...builtin.hot }, behind: { ...builtin.behind }, boost: builtin.boost };
    if (id === steered) entry = applyPace(entry, cl);
    if (Object.hasOwn(paceRaw, id)) entry = applyPace(entry, paceRaw[id]);
    pace[id] = entry;
  }
  const steeredPace = pace[steered] as PaceRules;
  const draw = rec(s.draw);
  return {
    profile,
    enabled: typeof s.enabled === 'boolean' ? s.enabled : d.enabled,
    boostFitFloor: unit(s.boostFitFloor, d.boostFitFloor),
    draw: { enabled: typeof draw.enabled === 'boolean' ? draw.enabled : d.draw.enabled, tail: unit(draw.tail, d.draw.tail) },
    depth, tiers, tilt, caps, training,
    exclude: strings(s.exclude) ?? [...d.exclude],
    prose: {
      models: strings(prose.models) ?? [...d.prose.models], tilt: num(prose.tilt, d.prose.tilt),
      pace: { enabled: typeof proseSwitch.enabled === 'boolean' ? proseSwitch.enabled : d.prose.pace.enabled, ahead: zeroUp(proseSwitch.ahead, d.prose.pace.ahead), aheadAtReserve: zeroUp(proseSwitch.aheadAtReserve, d.prose.pace.aheadAtReserve), returnAt: zeroUp(proseSwitch.returnAt, d.prose.pace.returnAt) },
    },
    pace,
    claude: { provider: steered, band: steeredPace.band, reserve: steeredPace.reserve, hot: { ...steeredPace.hot }, behind: { ...steeredPace.behind } },
    fallback: {
      providers: strings(fb.providers) ?? [...d.fallback.providers], routes, anthropic: strings(fb.anthropic) ?? [...d.fallback.anthropic],
      aim: money(fb.aim, d.fallback.aim), cap: money(fb.cap, d.fallback.cap), margin: money(fb.margin, d.fallback.margin),
    },
    prefer,
    seats: {
      second: { models: strings(second.models) ?? [...d.seats.second.models], skip: acts(second.skip) ?? [...d.seats.second.skip] },
      web,
      shadow: typeof st.shadow === 'string' ? st.shadow : d.seats.shadow,
      jev: { route: typeof jev.route === 'string' && jev.route ? jev.route : d.seats.jev.route, activities: acts(jev.activities) ?? [...d.seats.jev.activities], tilt: num(jev.tilt, d.seats.jev.tilt) },
    },
  };
}

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Fills one pace entry from a legacy block. A key already on the new entry wins, including each side of `hot` and `behind`. */
function mergePace(legacy: Record<string, unknown>, existing: unknown): Record<string, unknown> {
  const ex = plain(existing) ? existing : {};
  const out: Record<string, unknown> = { ...ex };
  for (const key of ['band', 'reserve'] as const) if (!Object.hasOwn(out, key) && Object.hasOwn(legacy, key)) out[key] = legacy[key];
  for (const key of ['hot', 'behind'] as const) {
    if (!Object.hasOwn(legacy, key)) continue;
    if (Object.hasOwn(ex, key) && !plain(ex[key])) continue;
    if (!plain(legacy[key])) { if (!Object.hasOwn(ex, key)) out[key] = legacy[key]; continue; }
    out[key] = { ...legacy[key], ...(plain(ex[key]) ? ex[key] : {}) };
  }
  return out;
}

/**
 * A stored `policy.balance` in the pace shape. Numbers on a legacy `claude` block move onto `pace.<provider>`, an existing pace value wins, and `schema` becomes 2.
 * The same value twice gives the same result. `null` and values that are not plain objects come back unchanged, and the input is not modified.
 */
export function upgradeBalance(raw: unknown): unknown {
  if (!plain(raw) || Object.keys(raw).length === 0) return raw;
  if (!Object.hasOwn(raw, 'claude')) return { ...raw, schema: 2 };
  const out: Record<string, unknown> = { ...raw, schema: 2 };
  const cl = plain(raw.claude) ? raw.claude : {};
  const provider = typeof cl.provider === 'string' && cl.provider ? cl.provider : 'claude';
  const moved: Record<string, unknown> = {};
  for (const key of ['band', 'reserve', 'hot', 'behind'] as const) if (Object.hasOwn(cl, key)) moved[key] = cl[key];
  // A pace key does not record which provider the controller steers, so a provider other than claude stays on `claude`.
  if (provider === 'claude') delete out.claude; else out.claude = { provider };
  if (Object.hasOwn(raw, 'pace') && !plain(raw.pace)) return out;
  const pace = plain(raw.pace) ? { ...raw.pace } : {};
  const haveEntry = Object.hasOwn(pace, provider);
  if (!haveEntry && Object.keys(moved).length === 0) return out;
  if (haveEntry && !plain(pace[provider])) return out;
  pace[provider] = mergePace(moved, pace[provider]);
  out.pace = pace;
  return out;
}

/** One window set against the share of it that has passed. `ahead` is in points of usage and is negative when behind. */
export interface PaceTrack { window: 'week' | '5-hour window'; used: number; elapsed: number; ahead: number }
export type ClaudeStance = 'hot' | 'on pace' | 'behind' | 'unknown';
export interface ClaudeState { stance: ClaudeStance; tracks: PaceTrack[]; /** The highest used percent of the two windows, or null with no figures. */ peak: number | null; atReserve: boolean }
/** `ClaudeState` for one provider. */
export interface PaceState extends ClaudeState { provider: string }

const paceOf = (rules: BalanceRules, provider: string): PaceRules => rules.pace[provider] ?? DEFAULT_PACE_RULES;
/** A session or weekly window with a numeric used percent. A meter scoped to one model is that model's own week, not the subscription. */
const paceMeter = (m: { id?: string; usedPct?: number | null; windowKind?: string }): boolean =>
  typeof m.usedPct === 'number' && (m.windowKind === 'session' || m.windowKind === 'weekly') && !/scoped/.test(m.id ?? '');

/**
 * One provider's session (5-hour) and weekly windows. The stricter track wins: hot if either is hot, behind only when every known track is behind.
 * Figures older than `freshLimits(...).ignoreMin` (2 hours, or 1.5 times the provider's refresh interval when that is longer) are ignored. With an entry but no usable track the stance is unknown. With no entry the provider is on pace.
 */
export function paceState(usage: UsageSnapshot | null, rules: BalanceRules, provider: string, now: Date): PaceState {
  const pace = paceOf(rules, provider);
  const p = usage?.providers[provider];
  const tracks: PaceTrack[] = [];
  let peak: number | null = null;
  if (p && ageMinutes(p, now) <= freshLimits(p).ignoreMin) {
    for (const m of p.meters ?? []) {
      // A provider marks only the window that is limiting right now as active, but the week is the pace marker even while the 5-hour window is the active one, so inactive windows count here.
      if (!paceMeter(m)) continue;
      const used = m.usedPct as number, reset = m.resetsAt ? Date.parse(m.resetsAt) : NaN;
      peak = Math.max(peak ?? 0, used);
      if (!Number.isFinite(reset) || !m.windowSeconds) continue;
      const elapsed = Math.min(1, Math.max(0, 1 - (reset - now.getTime()) / 1000 / m.windowSeconds)) * 100;
      tracks.push({ window: m.windowKind === 'weekly' ? 'week' : '5-hour window', used, elapsed, ahead: Math.round((used - elapsed) * 10) / 10 });
    }
  }
  const stance: ClaudeStance = !p ? 'on pace' : !tracks.length ? 'unknown' : tracks.some(t => t.ahead > pace.band) ? 'hot' : tracks.every(t => t.ahead < -pace.band) ? 'behind' : 'on pace';
  return { provider, stance, tracks, peak, atReserve: peak !== null && peak >= pace.reserve };
}

/** The steered provider's pace. Same result as `paceState` for `rules.claude.provider`. */
export function claudeState(usage: UsageSnapshot | null, rules: BalanceRules, now: Date): ClaudeState {
  const s = paceState(usage, rules, rules.claude.provider, now);
  return { stance: s.stance, tracks: s.tracks, peak: s.peak, atReserve: s.atReserve };
}

/**
 * Providers paced this run: each one in `usage.providers` with a session or weekly window.
 * The steered provider is included whenever it has a usage entry, so unreadable Claude figures still count.
 * Any other provider whose figures are stale or have no such window is left out. `PaceRules` has no opt-out.
 */
export function pacedProviders(usage: UsageSnapshot | null, rules: BalanceRules, now: Date = new Date()): string[] {
  if (!usage) return [];
  const steered = rules.claude.provider;
  const ids: string[] = [];
  for (const [id, entry] of Object.entries(usage.providers)) {
    if (id === steered) { ids.push(id); continue; }
    if (ageMinutes(entry, now) > freshLimits(entry).ignoreMin) continue;
    if ((entry.meters ?? []).some(paceMeter)) ids.push(id);
  }
  return ids;
}

const boostName = (id: string): string => id === 'claude' ? 'Claude' : id.slice(0, 1).toUpperCase() + id.slice(1);
const boostText = (n: number): string => n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');

/** How long is left in a window, in days once it is more than a day and a half, otherwise in hours. */
function leftWords(seconds: number): string {
  if (seconds >= 36 * 3600) return plural(Math.max(1, Math.round(seconds / 86400)), 'day');
  return plural(Math.max(1, Math.round(seconds / 3600)), 'hour');
}

/**
 * The unused-allowance multiplier for one paced provider.
 * Hot, at the reserve, stale, or with no reset to spend toward, it is 1. Otherwise it follows the unused share and fades over the last `BOOST.rampEnd` of the limiting window.
 */
export function boostFor(state: PaceState, usage: UsageSnapshot | null, rules: BalanceRules, now: Date): { boost: number; why: string } {
  const one = { boost: 1, why: '' };
  // Hot and reserve already move work off this provider, so the boost does not put it back.
  if (state.stance === 'hot' || state.atReserve) return one;
  const entry = usage?.providers[state.provider];
  // Figures older than the pace window are ignored, the same cutoff paceState uses.
  if (!entry || ageMinutes(entry, now) > freshLimits(entry).ignoreMin) return one;
  const meters = (entry.meters ?? []).filter(paceMeter);
  if (!meters.length) return one;
  let limit = meters[0] as (typeof meters)[number];
  for (const m of meters) if ((m.usedPct as number) > (limit.usedPct as number)) limit = m;
  const reset = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN;
  // No reset means there is no moment left to spend the allowance toward.
  if (!Number.isFinite(reset) || !limit.windowSeconds) return one;
  const timeLeft = Math.min(1, Math.max(0, (reset - now.getTime()) / 1000 / limit.windowSeconds));
  const unused = 1 - (limit.usedPct as number) / 100;
  const peak = (rules.pace[state.provider] ?? DEFAULT_PACE_RULES).boost;
  const ramp = Math.min(1, timeLeft / BOOST.rampEnd);
  const boost = Math.max(1, Math.round((1 + (peak - 1) * unused * ramp) * 1000) / 1000);
  if (boost <= 1) return one;
  const kind = limit.windowKind === 'weekly' ? 'week' : 'session';
  const why = `${boostName(state.provider)} has used ${Math.round(limit.usedPct as number)}% of its ${kind} with ${leftWords(timeLeft * limit.windowSeconds)} left, so it gets a ${boostText(boost)}x boost`;
  return { boost, why };
}

/** Where one provider's prose pace switch stands. `ahead` is how far its stricter window runs ahead of its pace marker, `threshold` is the lead that turns the switch on at the current usage, and `returnAt` is the lead at or below which it turns off again. */
export interface ProseSwitch { on: boolean; ahead: number | null; threshold: number; returnAt: number }

/**
 * Whether prose drafting should leave this provider. The lead that turns it on shrinks as usage climbs, from `ahead` points at no usage to `aheadAtReserve` at the reserve.
 * Once on, it stays on until the lead falls to `returnAt`. `was` is the last answer, and it carries over when the provider's figures are missing.
 */
export function proseSwitchState(rules: BalanceRules, state: ClaudeState | PaceState, was: boolean): ProseSwitch {
  const provider = 'provider' in state ? state.provider : rules.claude.provider;
  const p = rules.prose.pace, used = Math.min(1, Math.max(0, (state.peak ?? 0) / paceOf(rules, provider).reserve));
  const threshold = Math.round((p.ahead - (p.ahead - p.aheadAtReserve) * used) * 10) / 10;
  const ahead = state.tracks.length ? Math.max(...state.tracks.map(t => t.ahead)) : null;
  const on = !p.enabled || !rules.prose.models.length ? false : ahead === null ? was : was ? ahead > p.returnAt : ahead > threshold;
  return { on, ahead, threshold, returnAt: p.returnAt };
}

export const plural = (n: number, one: string, many = one + 's'): string => `${n} ${n === 1 ? one : many}`;
const points = (t: PaceTrack): string => t.used >= 99 ? `${t.window} is spent` : `${t.window} is ${plural(Math.abs(Math.round(t.ahead)), 'point')} ${t.ahead >= 0 ? 'ahead of' : 'behind'} pace`;

export interface Governed {
  depth: Depth;
  /** A multiplier per route label. A label with no entry is not tilted. */
  tilts: Record<string, number>;
  /** Route labels taken out of the running, with the reason. */
  blocks: Array<{ model: string; why: string }>;
  /** One short phrase per tilt that applied to the model, by label, for the reason line. */
  reasons: Record<string, string[]>;
  notes: string[];
  /** The steered provider's prose pace switch. On when prose drafting has moved off it. */
  proseSwitch: ProseSwitch;
  /** One switch per paced provider that serves a prose-listed model. The steered provider's entry matches `proseSwitch`. */
  proseSwitches: Record<string, ProseSwitch>;
}

/** A route is excluded when its label or its model id contains an excluded word. */
const excluded = (rules: BalanceRules, label: string, id: string): string | null => {
  const word = rules.exclude.find(w => `${label} ${id}`.toLowerCase().includes(w.toLowerCase()));
  return word ? `${word} is excluded by the balance rules` : null;
};

/** The tilt each model gets for this activity and depth. `depth` is the caller's choice, or the activity's default. An excluded model the person named is not excluded. `proseWas` is the steered provider's last switch, or one boolean per provider. `snippet` is one sentence with no prose batch, so the prose tilt and the prose switch stay off. */
export function govern(policy: PolicyFile, activity: ActivityId, depth?: Depth, models?: readonly string[], named?: string, usage: UsageSnapshot | null = null, now = new Date(), proseWas: boolean | Record<string, boolean> = false, snippet = false): Governed {
  const rules = resolveBalance((policy as { balance?: unknown }).balance);
  const used: Depth = depth ?? rules.depth[activity] ?? 'everyday';
  const steeredId = rules.claude.provider;
  const wasOf = (id: string): boolean => typeof proseWas === 'boolean' ? id === steeredId && proseWas : proseWas[id] === true;
  const paced = pacedProviders(usage, rules, now);
  const states = new Map<string, PaceState>(paced.map(id => [id, paceState(usage, rules, id, now)]));
  const steered = states.get(steeredId) ?? paceState(usage, rules, steeredId, now);
  const serves = (id: string): boolean => {
    const provider = policy.providers[id];
    if (!provider) return false;
    return Object.entries(provider.models).some(([label, m]) => listed(rules.prose.models, { label, provider: id, id: m.id }));
  };
  const mute = (sw: ProseSwitch): ProseSwitch => rules.enabled ? sw : { ...sw, on: false };
  const raw: Record<string, ProseSwitch> = {};
  for (const id of paced) if (serves(id)) raw[id] = proseSwitchState(rules, states.get(id) as PaceState, wasOf(id));
  const proseSwitch = mute(raw[steeredId] ?? proseSwitchState(rules, steered, wasOf(steeredId)));
  const proseSwitches: Record<string, ProseSwitch> = {};
  for (const [id, sw] of Object.entries(raw)) proseSwitches[id] = id === steeredId ? proseSwitch : mute(sw);
  const out: Governed = { depth: used, tilts: {}, blocks: [], reasons: {}, notes: snippet ? ['snippet: prose routes are not preferred'] : [], proseSwitch, proseSwitches };
  if (!rules.enabled) return out;
  const candidates: Candidate[] = [];
  for (const [providerId, p] of Object.entries(policy.providers)) {
    for (const [label, m] of Object.entries(p.models)) {
      if (models && !models.includes(label)) continue;
      const why = label === named ? null : excluded(rules, label, m.id);
      if (why) { out.blocks.push({ model: label, why }); continue; }
      let tilt = 1;
      const reasons: string[] = [];
      const ref: ModelRef = { label, provider: providerId, id: m.id };
      const tier = lookup(rules.tiers, ref);
      const isClaude = providerId === steeredId;
      candidates.push({ ...ref, claude: isClaude });
      // The best prose writers are tilted for prose alone, so being a strong model on everyday work does not count against them.
      const prose = activity === 'draft_prose' && !snippet && listed(rules.prose.models, ref);
      if (prose) { tilt = rules.prose.tilt; reasons.push('writes the best prose'); }
      else if (tier) {
        const t = rules.tilt[used][tier];
        if (t !== 1) { tilt *= t; reasons.push(`${tier} model for ${used} work`); }
      }
      const likes = lookup(rules.prefer, ref)?.[activity];
      if (likes && likes !== 1) { tilt *= likes; reasons.push(`suits ${activity.replace(/_/g, ' ')}`); }
      if (rules.seats.jev.route && nameMatches(rules.seats.jev.route, ref) && rules.seats.jev.activities.includes(activity)) { tilt *= rules.seats.jev.tilt; reasons.push('Jev is first for classification and scoring'); }
      // Pace picks between a provider's strong and light routes. A prose-listed model is not tilted by it.
      const state = states.get(providerId);
      const lean = !state ? null : state.stance === 'unknown' ? (providerId === steeredId ? 'hot' as const : null) : state.stance === 'on pace' ? null : state.stance;
      if (state && tier && lean && !prose) {
        const t = paceOf(rules, providerId)[lean][tier];
        if (t !== 1) { tilt *= t; reasons.push(paceWhy(policy, state, lean)); }
      }
      if (tilt !== 1) out.tilts[label] = Math.round(tilt * 1000) / 1000;
      if (reasons.length) out.reasons[label] = reasons;
    }
  }
  // At its own reserve, a provider's models leave while another provider can still take the work.
  const held = new Set<string>();
  for (const id of paced) {
    const state = states.get(id) as PaceState;
    if (!state.atReserve) continue;
    const own = candidates.filter(c => c.provider === id && c.label !== named);
    if (!own.length) continue;
    // Claude's reserve protects the owner's own sessions, so a backup route can take its work. Another subscription at its reserve never pushes work onto a paid backup.
    const isBackup = (c: ModelRef): boolean => rules.fallback.providers.includes(c.provider) || (lookup(rules.fallback.routes, c)?.includes(activity) ?? false);
    if (!candidates.some(c => c.provider !== id && !held.has(c.provider) && (id === steeredId || !isBackup(c)))) continue;
    held.add(id);
    const reserve = paceOf(rules, id).reserve;
    for (const c of own) {
      out.blocks.push({ model: c.label, why: reserveWhy(policy, id, state.peak as number, reserve) });
      delete out.tilts[c.label]; delete out.reasons[c.label];
    }
  }
  // While a provider's prose switch is on, drafting leaves that provider's prose routes when another route can take them.
  let proseMoved = false;
  if (activity === 'draft_prose' && !snippet) {
    const switched = new Set(Object.entries(proseSwitches).filter(([, sw]) => sw.on).map(([id]) => id));
    if (proseSwitch.on) switched.add(steeredId);
    const onlySteered = paced.every(id => id === steeredId);
    for (const id of switched) {
      const sw = id === steeredId ? proseSwitch : proseSwitches[id] as ProseSwitch;
      const dest = candidates.some(c => c.provider !== id && listed(rules.prose.models, c) && !out.blocks.some(b => b.model === c.label) && !switched.has(c.provider));
      const legacy = id === steeredId && onlySteered && candidates.some(c => c.provider !== id);
      if (!dest && !legacy) continue;
      for (const c of candidates.filter(c => c.provider === id && c.label !== named && listed(rules.prose.models, c) && !out.blocks.some(b => b.model === c.label))) {
        out.blocks.push({ model: c.label, why: proseWhy(policy, id, sw) });
        delete out.tilts[c.label]; delete out.reasons[c.label];
        if (id === steeredId) proseMoved = true;
      }
    }
  }
  backups(out, policy, rules, activity, usage, now, candidates, steered, named, proseMoved);
  if (steered.stance === 'unknown') out.notes.push(unknownNote(policy, steeredId));
  return out;
}

/** Claude's sentences stay worded as they were. Any other provider uses its display name, or its id when the policy has none. */
function spokenName(policy: PolicyFile, id: string): string {
  if (id === 'claude') return 'Claude';
  return policy.providers[id]?.name || id;
}

function reserveWhy(policy: PolicyFile, id: string, peak: number, reserve: number): string {
  return `${spokenName(policy, id)} is at ${Math.round(peak)}% of a window, past the ${reserve}% reserve, so other routes take optional work`;
}

function proseWhy(policy: PolicyFile, id: string, sw: ProseSwitch): string {
  return `${spokenName(policy, id)} runs ${plural(Math.round(sw.ahead as number), 'point')} ahead of pace, so prose is off it until the lead falls to ${plural(sw.returnAt, 'point')}`;
}

function unknownNote(policy: PolicyFile, id: string): string {
  if (id === 'claude') return 'Claude usage figures are missing or old, so the reserve could not be checked and Claude leans light.';
  return `${spokenName(policy, id)} usage figures are missing or old, so the reserve could not be checked and it leans light.`;
}

/** A model the governor is weighing, and whether it is a Claude route. */
type Candidate = ModelRef & { claude: boolean };

/** Copilot's spend this month, in dollars, from the usage figures. Null when they carry none. */
export function copilotSpend(usage: UsageSnapshot | null, provider = 'copilot'): number | null {
  const m = usage?.providers[provider]?.money?.find(x => x.id === 'spent');
  return m && typeof m.amount === 'number' ? m.amount : null;
}

/** Holds backup routes out of the running while a subscription route can take the work, and holds Copilot to its budget. Mutates `out`. */
function backups(out: Governed, policy: PolicyFile, rules: BalanceRules, activity: ActivityId, usage: UsageSnapshot | null, now: Date, candidates: Candidate[], claude: ClaudeState, named?: string, proseMoved = false): void {
  const f = rules.fallback, blocked = new Set(out.blocks.map(b => b.model));
  const live = candidates.filter(c => !blocked.has(c.label));
  const isBackup = (c: ModelRef): boolean => f.providers.includes(c.provider) || (lookup(f.routes, c)?.includes(activity) ?? false);
  const press = pressure(policy, usage, now);
  // A subscription route can take the work when it is not spent or down. A spent provider with a limit reset in hand still counts.
  const available = (c: { provider: string }): boolean => { const h = press[c.provider]; return !h?.down && (!h?.spent || (h.resets ?? 0) > 0); };
  const subscription = live.filter(c => !isBackup(c) && available(c));
  const claudeOpen = live.some(c => c.claude);
  const spend = copilotSpend(usage), counted = spend === null ? null : spend + f.margin;
  for (const c of live.filter(isBackup)) {
    if (c.label === named) continue;
    const anthropic = listed(f.anthropic, c);
    // A model with its own `useAfter` rule is held back by that rule, so the fallback hold leaves it alone.
    const waits = (policy.providers[c.provider]?.models[c.label]?.useAfter?.length ?? 0) > 0;
    const open = anthropic ? claude.atReserve || !claudeOpen || (proseMoved && listed(rules.prose.models, c)) : waits || subscription.length === 0;
    const copilot = f.providers.includes(c.provider);
    let why: string | null = null;
    if (!open) why = anthropic ? 'Anthropic through a backup waits until Claude reaches its reserve' : `a subscription route can take this, so ${c.label} stays in reserve`;
    else if (copilot && counted !== null && counted >= f.cap && !anthropic) why = `Copilot spend is $${spend?.toFixed(2)}, at the $${f.cap} cap`;
    else if (copilot && counted !== null && counted >= f.cap && anthropic && !claude.atReserve) why = `Copilot spend is $${spend?.toFixed(2)}, at the $${f.cap} cap`;
    if (why) {
      out.blocks.push({ model: c.label, why }); delete out.tilts[c.label]; delete out.reasons[c.label];
      if (proseMoved && anthropic && listed(rules.prose.models, c)) out.notes.push(`Prose has moved off Claude. ${why}, so it goes to the next route.`);
      continue;
    }
    const r = out.reasons[c.label] ?? [];
    if (anthropic && proseMoved && !claude.atReserve) r.push('Claude runs ahead of pace, so prose goes to Anthropic through Copilot');
    else if (anthropic) r.push('Claude is at its reserve, so Anthropic through Copilot takes the work');
    else r.push('no subscription route can take this');
    if (copilot && counted !== null && counted >= f.aim) { const line = `Copilot spend is $${spend?.toFixed(2)}, past the $${f.aim} aim`; r.push(line); out.notes.push(`${line}; ${c.label} is a spend to report.`); }
    out.reasons[c.label] = r;
  }
}

function paceWhy(policy: PolicyFile, c: PaceState, lean: 'hot' | 'behind'): string {
  if (c.provider === 'claude') {
    if (c.stance === 'unknown') return 'Claude figures are missing, so it leans to Sonnet';
    return `the ${c.tracks.map(points).join(' and the ')}, so Claude leans to ${lean === 'hot' ? 'Sonnet' : 'Opus'}`;
  }
  const name = spokenName(policy, c.provider);
  const toward = lean === 'hot' ? 'its light models' : 'its strong models';
  if (c.stance === 'unknown') return `${name} figures are missing, so it leans to its light models`;
  return `the ${c.tracks.map(points).join(' and the ')}, so ${name} leans to ${toward}`;
}

/** One sentence on why the pick won, and what comes next. When `drawn` names a route other than `top`, the sentence is the draw instead. */
export function reasonLine(top: { model: string; why: string; odds?: number } | undefined, next: { model: string } | undefined, governed: Governed, activity: ActivityId, drawn?: { model: string; odds: number }): string {
  if (drawn && top && drawn.model !== top.model) return `Drawn at ${Math.round(drawn.odds * 100)}% odds; ${top.model} led at ${Math.round((top.odds ?? 0) * 100)}%.`;
  if (!top) return `No model can take this ${activity} task.`;
  const parts = [`${top.model} for ${governed.depth} ${activity.replace(/_/g, ' ')}`];
  const g = governed.reasons[top.model];
  if (g?.length) parts.push(g.join(', '));
  // The provider's own note matters when it says something (a spent window, an old figure) and is noise when it says there is plenty.
  if (top.why && !/^(plenty left|no Augur data)$/.test(top.why)) parts.push(top.why);
  const line = `${parts[0]}: ${parts.slice(1).join('; ') || 'best score'}.`;
  return next ? `${line} Next: ${next.model}.` : line;
}
