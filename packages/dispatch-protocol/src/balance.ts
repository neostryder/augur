// The automatic balance: standing rules about which models suit which kind of work, turned into a tilt on each model's score. Pure.
// `rank()` multiplies the tilt into the score it already computes, so the weights, pauses, ask-first, data tiers and the usage factor all still apply.
import { ACTIVITIES } from '@augur/core';
import type { ActivityId, PolicyFile } from '@augur/core';
import { PACE, ageMinutes, pressure } from './pace.js';
import type { UsageSnapshot } from './pace.js';

/** Deep work is hard reasoning, serious coding and long chains. Everyday work is review, research, summaries and bulk work. */
export type Depth = 'deep' | 'everyday';
/** A strong model suits deep work and is overkill for everyday work. A light one is the reverse. A model with no tier is not tilted. */
export type ModelTier = 'strong' | 'light';

/** The starting rules. Classic is what every install had before profiles existed and what an install that names none keeps. Neutral tilts only for Claude's pace. */
export type Profile = 'classic' | 'neutral';
export const PROFILES: readonly Profile[] = ['classic', 'neutral'];

export interface BalanceRules {
  /** Which starting rules the overrides sit on. */
  profile: Profile;
  /** Switches the whole balance off. The pick then ranks on weights and usage alone. */
  enabled: boolean;
  /** The depth of an activity when the caller does not say. */
  depth: Record<ActivityId, Depth>;
  /** The tier of each route, by label or by standard name (provider id, a slash, model id). A `*` in a name matches any text. */
  tiers: Record<string, ModelTier>;
  /** Route labels, or ids containing any of these words, that are never picked. */
  exclude: string[];
  /** The score multiplier for a tier at each depth. */
  tilt: Record<Depth, Record<ModelTier, number>>;
  /** Route labels that write the best prose, and the multiplier they get on draft_prose in place of the depth tilt. */
  prose: {
    models: string[]; tilt: number;
    /** The pace switch: when Claude runs ahead of pace, prose drafting moves off the Claude routes in `models` to the routes that remain (Opus through a backup provider first). */
    pace: { enabled: boolean; ahead: number; aheadAtReserve: number; returnAt: number };
  };
  /** The Claude controller: holds Claude's usage near the pace marker and keeps a reserve so it never runs out. */
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

const DEEP: ActivityId[] = ['write_code', 'reason_critique'];

export const DEFAULT_BALANCE: BalanceRules = {
  profile: 'classic',
  enabled: true,
  depth: Object.fromEntries(ACTIVITIES.map(a => [a, DEEP.includes(a) ? 'deep' : 'everyday'])) as Record<ActivityId, Depth>,
  tiers: {
    'claude/live': 'strong', 'claude/opus': 'strong', 'codex/sol': 'strong', 'xai/grok': 'strong',
    'copilot/claude-opus-5.5': 'strong', 'copilot/gpt-6.1-sol': 'strong', 'copilot/grok-4.7': 'strong',
    'claude/claude-sonnet-5-5': 'light', 'claude/sonnet': 'light', 'codex/luna': 'light', 'minimax/m3': 'light', 'deepseek/v4.1-flash': 'light',
    'copilot/claude-sonnet-5.5': 'light', 'copilot/gpt-6-luna': 'light', 'copilot/gemini-3.8-flash': 'light',
  },
  exclude: ['fable', 'astra'],
  tilt: { deep: { strong: 1.4, light: 0.8 }, everyday: { strong: 0.85, light: 1.15 } },
  prose: { models: ['claude/live', 'claude/opus', 'copilot/claude-opus-5.5'], tilt: 1.3, pace: { enabled: true, ahead: 12, aheadAtReserve: 3, returnAt: 0 } },
  claude: { provider: 'claude', band: 5, reserve: 90, hot: { strong: 0.8, light: 1.25 }, behind: { strong: 1.25, light: 0.85 } },
  fallback: { providers: ['copilot'], routes: { 'deepseek/v4.1-flash': ['write_code'] }, anthropic: ['copilot/claude-opus-5.5', 'copilot/claude-sonnet-5.5'], aim: 150, cap: 250, margin: 5 },
  prefer: {
    'minimax/m3': { long_context: 1.6, summarize_extract: 1.4 },
    'codex/luna': { review_code: 1.2, research: 1.2 },
    'claude/claude-sonnet-5-5': { review_code: 1.2, research: 1.2 },
    'claude/sonnet': { review_code: 1.2, research: 1.2 },
    'deepseek/v4.1-flash': { review_code: 1.2 },
    'chatgpt/web': { research: 1.3 },
    'xai/grok': { write_code: 1.1, review_code: 1.1, research: 1.1 },
  },
  seats: {
    second: { models: ['minimax/m3'], skip: ['bulk_tagging', 'typed_decisions', 'speech', 'generate_images', 'generate_video', 'read_images'] },
    web: { research: ['chatgpt/web', 'gemini/web'], generate_images: ['chatgpt/web', 'gemini/web'], read_images: ['gemini/web', 'chatgpt/web'], long_context: ['gemini/web'] },
    shadow: 'laya/laya',
    jev: { route: 'jev/jev-latest', activities: ['typed_decisions', 'bulk_tagging'], tilt: 3 },
  },
};

/** A fresh install: balance on, and only Claude's pace tilts (Sonnet when hot, Opus when behind). No route is held back, preferred or excluded, and no model is named for a seat. */
export const NEUTRAL_BALANCE: BalanceRules = {
  ...DEFAULT_BALANCE,
  profile: 'neutral',
  tiers: { 'claude/*opus*': 'strong', 'claude/*sonnet*': 'light', 'claude/*haiku*': 'light' },
  exclude: [],
  tilt: { deep: { strong: 1, light: 1 }, everyday: { strong: 1, light: 1 } },
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
const zeroUp = (v: unknown, fallback: number): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
const strings = (v: unknown): string[] | null => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : null;
const rec = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** The defaults with whatever `policy.balance` overrides. A field of the wrong type keeps its default. */
export function resolveBalance(raw: unknown): BalanceRules {
  const s = rec(raw), profile: Profile = s.profile === 'neutral' ? 'neutral' : 'classic', d = profile === 'neutral' ? NEUTRAL_BALANCE : DEFAULT_BALANCE;
  const depth = { ...d.depth }, tiers = { ...d.tiers };
  for (const [a, v] of Object.entries(rec(s.depth))) if ((ACTIVITIES as readonly string[]).includes(a) && (v === 'deep' || v === 'everyday')) depth[a as ActivityId] = v;
  for (const [m, v] of Object.entries(rec(s.tiers))) { if (v === 'strong' || v === 'light') tiers[m] = v; else if (v === null) delete tiers[m]; }
  const tilt = { deep: { ...d.tilt.deep }, everyday: { ...d.tilt.everyday } };
  for (const depthKey of ['deep', 'everyday'] as const) for (const tier of ['strong', 'light'] as const) tilt[depthKey][tier] = num(rec(rec(s.tilt)[depthKey])[tier], tilt[depthKey][tier]);
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
  return {
    profile,
    enabled: typeof s.enabled === 'boolean' ? s.enabled : d.enabled,
    depth, tiers, tilt,
    exclude: strings(s.exclude) ?? [...d.exclude],
    prose: {
      models: strings(prose.models) ?? [...d.prose.models], tilt: num(prose.tilt, d.prose.tilt),
      pace: { enabled: typeof proseSwitch.enabled === 'boolean' ? proseSwitch.enabled : d.prose.pace.enabled, ahead: zeroUp(proseSwitch.ahead, d.prose.pace.ahead), aheadAtReserve: zeroUp(proseSwitch.aheadAtReserve, d.prose.pace.aheadAtReserve), returnAt: zeroUp(proseSwitch.returnAt, d.prose.pace.returnAt) },
    },
    claude: {
      provider: typeof cl.provider === 'string' && cl.provider ? cl.provider : d.claude.provider,
      band: num(cl.band, d.claude.band), reserve: num(cl.reserve, d.claude.reserve),
      hot: pair(cl.hot, d.claude.hot), behind: pair(cl.behind, d.claude.behind),
    },
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

/** One of Claude's two windows set against the share of it that has passed. `ahead` is in points of usage and is negative when behind. */
export interface PaceTrack { window: 'week' | '5-hour window'; used: number; elapsed: number; ahead: number }
export type ClaudeStance = 'hot' | 'on pace' | 'behind' | 'unknown';
export interface ClaudeState { stance: ClaudeStance; tracks: PaceTrack[]; /** The highest used percent of the two windows, or null with no figures. */ peak: number | null; atReserve: boolean }

/** Reads Claude's session (5-hour) and weekly windows. The stricter track wins: hot if either is hot, behind only when every known track is behind. With Claude's figures present but unusable the stance is unknown, and it is treated as hot because the reserve cannot be checked. With no Claude figures at all, the controller is off. */
export function claudeState(usage: UsageSnapshot | null, rules: BalanceRules, now: Date): ClaudeState {
  const p = usage?.providers[rules.claude.provider];
  const tracks: PaceTrack[] = [];
  let peak: number | null = null;
  if (p && ageMinutes(p, now) <= PACE.ignoreMin) {
    for (const m of p.meters ?? []) {
      // Claude marks only the window that is limiting right now as active, but the week is the pace marker even while the 5-hour window is the active one, so inactive windows count here.
      if (typeof m.usedPct !== 'number' || (m.windowKind !== 'session' && m.windowKind !== 'weekly')) continue;
      // A window scoped to one model (Fable's own week) is not the pace of the subscription, and the models it covers are never picked anyway.
      if (/scoped/.test(m.id ?? '')) continue;
      const used = m.usedPct as number, reset = m.resetsAt ? Date.parse(m.resetsAt) : NaN;
      peak = Math.max(peak ?? 0, used);
      if (!Number.isFinite(reset) || !m.windowSeconds) continue;
      const elapsed = Math.min(1, Math.max(0, 1 - (reset - now.getTime()) / 1000 / m.windowSeconds)) * 100;
      tracks.push({ window: m.windowKind === 'weekly' ? 'week' : '5-hour window', used, elapsed, ahead: Math.round((used - elapsed) * 10) / 10 });
    }
  }
  const band = rules.claude.band;
  const stance: ClaudeStance = !p ? 'on pace' : !tracks.length ? 'unknown' : tracks.some(t => t.ahead > band) ? 'hot' : tracks.every(t => t.ahead < -band) ? 'behind' : 'on pace';
  return { stance, tracks, peak, atReserve: peak !== null && peak >= rules.claude.reserve };
}

/** Where the prose pace switch stands. `ahead` is how far the stricter Claude window runs ahead of its pace marker, `threshold` is the lead that turns the switch on at the current usage, and `returnAt` is the lead at or below which it turns off again. */
export interface ProseSwitch { on: boolean; ahead: number | null; threshold: number; returnAt: number }

/**
 * Whether prose drafting should be off Claude. The lead that turns it on shrinks as usage climbs, from `ahead` points at no usage to `aheadAtReserve` at the reserve, so the closer Claude gets to running out the less lead it takes. Once on, it stays on until the lead falls to `returnAt`. `was` is the last answer, and it carries over when Claude's figures are missing.
 */
export function proseSwitchState(rules: BalanceRules, claude: ClaudeState, was: boolean): ProseSwitch {
  const p = rules.prose.pace, used = Math.min(1, Math.max(0, (claude.peak ?? 0) / rules.claude.reserve));
  const threshold = Math.round((p.ahead - (p.ahead - p.aheadAtReserve) * used) * 10) / 10;
  const ahead = claude.tracks.length ? Math.max(...claude.tracks.map(t => t.ahead)) : null;
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
  /** Where the prose pace switch stands: on when prose drafting has moved off Claude. */
  proseSwitch: ProseSwitch;
}

/** A route is excluded when its label or its model id contains an excluded word. */
const excluded = (rules: BalanceRules, label: string, id: string): string | null => {
  const word = rules.exclude.find(w => `${label} ${id}`.toLowerCase().includes(w.toLowerCase()));
  return word ? `${word} is excluded by the balance rules` : null;
};

/** The tilt each model gets for this activity and depth. `depth` is the caller's choice, or the activity's default. An excluded model the person named is not excluded. */
export function govern(policy: PolicyFile, activity: ActivityId, depth?: Depth, models?: readonly string[], named?: string, usage: UsageSnapshot | null = null, now = new Date(), proseWas = false): Governed {
  const rules = resolveBalance((policy as { balance?: unknown }).balance);
  const used: Depth = depth ?? rules.depth[activity] ?? 'everyday';
  const claude = claudeState(usage, rules, now);
  const proseSwitch = proseSwitchState(rules, claude, proseWas);
  const out: Governed = { depth: used, tilts: {}, blocks: [], reasons: {}, notes: [], proseSwitch: rules.enabled ? proseSwitch : { ...proseSwitch, on: false } };
  if (!rules.enabled) return out;
  const lean = claude.stance === 'unknown' ? 'hot' : claude.stance === 'on pace' ? null : claude.stance;
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
      const isClaude = providerId === rules.claude.provider;
      candidates.push({ ...ref, claude: isClaude });
      // The best prose writers are tilted for prose alone, so being a strong model on everyday work does not count against them.
      const prose = activity === 'draft_prose' && listed(rules.prose.models, ref);
      if (prose) { tilt = rules.prose.tilt; reasons.push('writes the best prose'); }
      else if (tier) {
        const t = rules.tilt[used][tier];
        if (t !== 1) { tilt *= t; reasons.push(`${tier} model for ${used} work`); }
      }
      const likes = lookup(rules.prefer, ref)?.[activity];
      if (likes && likes !== 1) { tilt *= likes; reasons.push(`suits ${activity.replace(/_/g, ' ')}`); }
      if (rules.seats.jev.route && nameMatches(rules.seats.jev.route, ref) && rules.seats.jev.activities.includes(activity)) { tilt *= rules.seats.jev.tilt; reasons.push('Jev is first for classification and scoring'); }
      // Claude's own pace picks between Opus and Sonnet. Opus for prose is not held back by it.
      if (isClaude && tier && lean && !prose) {
        const t = rules.claude[lean][tier];
        if (t !== 1) { tilt *= t; reasons.push(claudeWhy(claude, lean)); }
      }
      if (tilt !== 1) out.tilts[label] = Math.round(tilt * 1000) / 1000;
      if (reasons.length) out.reasons[label] = reasons;
    }
  }
  // At the reserve, optional work leaves Claude while another route can take it, so Claude never runs out.
  if (claude.atReserve && candidates.some(c => !c.claude)) {
    for (const c of candidates.filter(c => c.claude && c.label !== named)) {
      out.blocks.push({ model: c.label, why: `Claude is at ${Math.round(claude.peak as number)}% of a window, past the ${rules.claude.reserve}% reserve, so other routes take optional work` });
      delete out.tilts[c.label]; delete out.reasons[c.label];
    }
  }
  // While the prose switch is on, drafting leaves the Claude routes that write prose, so Opus through a backup provider (or the next route) takes it.
  let proseMoved = false;
  if (proseSwitch.on && activity === 'draft_prose' && candidates.some(c => !c.claude)) {
    for (const c of candidates.filter(c => c.claude && c.label !== named && listed(rules.prose.models, c) && !out.blocks.some(b => b.model === c.label))) {
      out.blocks.push({ model: c.label, why: `Claude runs ${plural(Math.round(proseSwitch.ahead as number), 'point')} ahead of pace, so prose is off it until the lead falls to ${plural(proseSwitch.returnAt, 'point')}` });
      delete out.tilts[c.label]; delete out.reasons[c.label]; proseMoved = true;
    }
  }
  backups(out, policy, rules, activity, usage, now, candidates, claude, named, proseMoved);
  if (claude.stance === 'unknown') out.notes.push('Claude usage figures are missing or old, so the reserve could not be checked and Claude leans light.');
  return out;
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

function claudeWhy(c: ClaudeState, lean: 'hot' | 'behind'): string {
  if (c.stance === 'unknown') return 'Claude figures are missing, so it leans to Sonnet';
  return `the ${c.tracks.map(points).join(' and the ')}, so Claude leans to ${lean === 'hot' ? 'Sonnet' : 'Opus'}`;
}

/** One sentence on why the top model won, and what comes next. */
export function reasonLine(top: { model: string; why: string } | undefined, next: { model: string } | undefined, governed: Governed, activity: ActivityId): string {
  if (!top) return `No model can take this ${activity} task.`;
  const parts = [`${top.model} for ${governed.depth} ${activity.replace(/_/g, ' ')}`];
  const g = governed.reasons[top.model];
  if (g?.length) parts.push(g.join(', '));
  // The provider's own note matters when it says something (a spent window, an old figure) and is noise when it says there is plenty.
  if (top.why && !/^(plenty left|no Augur data)$/.test(top.why)) parts.push(top.why);
  const line = `${parts[0]}: ${parts.slice(1).join('; ') || 'best score'}.`;
  return next ? `${line} Next: ${next.model}.` : line;
}
