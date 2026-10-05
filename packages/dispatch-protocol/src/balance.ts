// The automatic balance: standing rules about which models suit which kind of work, turned into a tilt on each model's score. Pure.
// `rank()` multiplies the tilt into the score it already computes, so the weights, pauses, ask-first, data tiers and the usage factor all still apply.
import { ACTIVITIES } from '@augur/core';
import type { ActivityId, PolicyFile } from '@augur/core';

/** Deep work is hard reasoning, serious coding and long chains. Everyday work is review, research, summaries and bulk work. */
export type Depth = 'deep' | 'everyday';
/** A strong model suits deep work and is overkill for everyday work. A light one is the reverse. A model with no tier is not tilted. */
export type ModelTier = 'strong' | 'light';

export interface BalanceRules {
  /** Switches the whole balance off. The pick then ranks on weights and usage alone. */
  enabled: boolean;
  /** The depth of an activity when the caller does not say. */
  depth: Record<ActivityId, Depth>;
  /** The tier of each route label. */
  tiers: Record<string, ModelTier>;
  /** Route labels, or ids containing any of these words, that are never picked. */
  exclude: string[];
  /** The score multiplier for a tier at each depth. */
  tilt: Record<Depth, Record<ModelTier, number>>;
  /** Route labels that write the best prose, and the multiplier they get on draft_prose in place of the depth tilt. */
  prose: { models: string[]; tilt: number };
}

const DEEP: ActivityId[] = ['write_code', 'reason_critique'];

export const DEFAULT_BALANCE: BalanceRules = {
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
  prose: { models: ['claude/live', 'claude/opus', 'copilot/claude-opus-5.5'], tilt: 1.3 },
};

const num = (v: unknown, fallback: number): number => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
const strings = (v: unknown): string[] | null => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : null;
const rec = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** The defaults with whatever `policy.balance` overrides. A field of the wrong type keeps its default. */
export function resolveBalance(raw: unknown): BalanceRules {
  const s = rec(raw), d = DEFAULT_BALANCE;
  const depth = { ...d.depth }, tiers = { ...d.tiers };
  for (const [a, v] of Object.entries(rec(s.depth))) if ((ACTIVITIES as readonly string[]).includes(a) && (v === 'deep' || v === 'everyday')) depth[a as ActivityId] = v;
  for (const [m, v] of Object.entries(rec(s.tiers))) { if (v === 'strong' || v === 'light') tiers[m] = v; else if (v === null) delete tiers[m]; }
  const tilt = { deep: { ...d.tilt.deep }, everyday: { ...d.tilt.everyday } };
  for (const depthKey of ['deep', 'everyday'] as const) for (const tier of ['strong', 'light'] as const) tilt[depthKey][tier] = num(rec(rec(s.tilt)[depthKey])[tier], tilt[depthKey][tier]);
  const prose = rec(s.prose);
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : d.enabled,
    depth, tiers, tilt,
    exclude: strings(s.exclude) ?? [...d.exclude],
    prose: { models: strings(prose.models) ?? [...d.prose.models], tilt: num(prose.tilt, d.prose.tilt) },
  };
}

export interface Governed {
  depth: Depth;
  /** A multiplier per route label. A label with no entry is not tilted. */
  tilts: Record<string, number>;
  /** Route labels taken out of the running, with the reason. */
  blocks: Array<{ model: string; why: string }>;
  /** One short phrase per tilt that applied to the model, by label, for the reason line. */
  reasons: Record<string, string[]>;
  notes: string[];
}

/** A route is excluded when its label or its model id contains an excluded word. */
const excluded = (rules: BalanceRules, label: string, id: string): string | null => {
  const word = rules.exclude.find(w => `${label} ${id}`.toLowerCase().includes(w.toLowerCase()));
  return word ? `${word} is excluded by the balance rules` : null;
};

/** The tilt each model gets for this activity and depth. `depth` is the caller's choice, or the activity's default. An excluded model the person named is not excluded. */
export function govern(policy: PolicyFile, activity: ActivityId, depth?: Depth, models?: readonly string[], named?: string): Governed {
  const rules = resolveBalance((policy as { balance?: unknown }).balance);
  const used: Depth = depth ?? rules.depth[activity] ?? 'everyday';
  const out: Governed = { depth: used, tilts: {}, blocks: [], reasons: {}, notes: [] };
  if (!rules.enabled) return out;
  for (const p of Object.values(policy.providers)) {
    for (const [label, m] of Object.entries(p.models)) {
      if (models && !models.includes(label)) continue;
      const why = label === named ? null : excluded(rules, label, m.id);
      if (why) { out.blocks.push({ model: label, why }); continue; }
      let tilt = 1;
      const reasons: string[] = [];
      const tier = rules.tiers[label];
      // The best prose writers are tilted for prose alone, so being a strong model on everyday work does not count against them.
      if (activity === 'draft_prose' && rules.prose.models.includes(label)) { tilt = rules.prose.tilt; reasons.push('writes the best prose'); }
      else if (tier) {
        const t = rules.tilt[used][tier];
        if (t !== 1) { tilt *= t; reasons.push(`${tier} model for ${used} work`); }
      }
      if (tilt !== 1) out.tilts[label] = Math.round(tilt * 1000) / 1000;
      if (reasons.length) out.reasons[label] = reasons;
    }
  }
  return out;
}

/** One sentence on why the top model won, and what comes next. */
export function reasonLine(top: { model: string; why: string } | undefined, next: { model: string } | undefined, governed: Governed, activity: ActivityId): string {
  if (!top) return `No model can take this ${activity} task.`;
  const parts = [`${top.model} for ${governed.depth} ${activity.replace(/_/g, ' ')}`];
  const g = governed.reasons[top.model];
  if (g?.length) parts.push(g.join(', '));
  if (top.why) parts.push(top.why);
  const line = `${parts[0]}: ${parts.slice(1).join('; ') || 'best score'}.`;
  return next ? `${line} Next: ${next.model}.` : line;
}
