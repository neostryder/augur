// Training mode: a pick on an expensive route is proposed to a person first, and the person's answers decide, kind of work by kind of work, when Augur may stop asking. Pure.
import { lookup } from './balance.js';
import type { BalanceRules, Depth, ModelRef } from './balance.js';


/** One answer: the proposal, what the person chose, and whether they matched. An implicit answer is a job that ran on another model than an unasked pick. */
export interface AnswerRow { pick: string; key: string; proposed: string; chosen: string; agreed: boolean; at: number; implicit?: boolean }

export const trainingKey = (activity: string, depth: Depth): string => `${activity}:${depth}`;

/** The newest answer for each pick, newest first, for one kind of work. */
function recent(rows: readonly AnswerRow[], key: string, window: number): AnswerRow[] {
  const latest = new Map<string, AnswerRow>();
  for (const r of rows) if (r.key === key) { const was = latest.get(r.pick); if (!was || r.at >= was.at) latest.set(r.pick, r); }
  return [...latest.values()].sort((a, b) => b.at - a.at).slice(0, window);
}

export function agreement(rows: readonly AnswerRow[], key: string, window: number): { n: number; agreed: number; rate: number } {
  const r = recent(rows, key, window), agreed = r.filter(x => x.agreed).length;
  return { n: r.length, agreed, rate: r.length ? agreed / r.length : 0 };
}

/** FNV-1a, so the spot check lands on the same picks for the same ids. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export interface Proposal {
  /** `ask` waits for a person. `spot` is an asked pick from a kind of work that had stopped asking. `auto` stands as drawn. */
  mode: 'ask' | 'auto' | 'spot';
  key: string;
  n: number;
  agreed: number;
  /** One sentence on why it asks or does not. */
  reason: string;
}

/** Whether a pick of `ref` for this kind of work waits for a person. A route outside the asked tiers and askRoutes never asks. */
export function propose(rules: BalanceRules, ref: ModelRef, key: string, depth: Depth, pickId: string, answers: readonly AnswerRow[]): Proposal {
  const t = rules.training, tier = lookup(rules.tiers, ref);
  const base = { key, ...agreement(answers, key, t.window) };
  const out = (mode: Proposal['mode'], reason: string): Proposal => ({ mode, reason, key, n: base.n, agreed: base.agreed });
  if (!t.enabled) return out('auto', 'training mode is off');
  const always = t.askRoutes.some(k => lookup({ [k]: true }, ref));
  if (!always && !(tier && t.askTiers.includes(tier))) return out('auto', `${ref.label} is not an asked route`);
  if (always) return out('ask', `${ref.label} always asks`);
  if (t.askDepths.includes(depth)) return out('ask', `${depth} work always asks`);
  if (base.n < t.min) return out('ask', `${base.n} of ${t.min} answers so far for ${key}`);
  if (base.rate < t.agree) return out('ask', `${base.agreed} of ${base.n} recent answers agreed for ${key}, short of ${Math.round(t.agree * 100)}%`);
  if (t.spot > 0 && hash32(pickId) % t.spot === 0) return out('spot', `spot check: ${base.agreed} of ${base.n} recent answers agreed for ${key}`);
  return out('auto', `${base.agreed} of ${base.n} recent answers agreed for ${key}`);
}

/** The share of the newest answers for a kind of work that chose each route. Empty until `min` answers exist. */
export function learnedShares(rows: readonly AnswerRow[], key: string, window: number, min: number): Record<string, number> {
  const r = recent(rows, key, window), out: Record<string, number> = {};
  if (r.length < min) return out;
  for (const x of r) out[x.chosen] = (out[x.chosen] ?? 0) + 1 / r.length;
  return out;
}

/** The fit multiplier a route gets from what a person chose before: from 0.85 for never chosen to 1.15 for always chosen, so history leans a pick and never decides it alone. */
export const learnedTilt = (share: number): number => Math.round((0.85 + 0.3 * Math.min(Math.max(share, 0), 1)) * 1000) / 1000;
