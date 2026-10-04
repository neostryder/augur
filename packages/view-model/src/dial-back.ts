// The dial-back preset: until a chosen time, stop the high-cost models and favour the cheaper ones. It is a plan first, so the rules page can show
// every model it would touch, and only then a set of ordinary pause fields written through the same path as a pause set by hand.
import { ACTIVITIES, WEIGHT_LEVELS, fieldPath, pauseActive, resolveModel } from '@augur/core';
import type { ActivityId, PolicyConfig, WeightLevel } from '@augur/core';

const HIGH_COST = new Set(['high', 'very_high']);
const LOW_COST = new Set(['free', 'very_cheap', 'cheap']);

export interface DialBackItem {
  provider: string;
  label: string;
  path: string;
  /** `stop` skips the model until the end time; `favour` raises the weight of every activity it is allowed for by one step. */
  action: 'stop' | 'favour';
  weights?: Partial<Record<ActivityId, WeightLevel>>;
}

export interface DialBackPlan {
  until: string;
  items: DialBackItem[];
  /** Models left alone: unconfirmed or hidden ones, ones already paused, and those in the middle of the cost range. */
  skipped: number;
}

const raise = (level: WeightLevel): WeightLevel => WEIGHT_LEVELS[Math.min(WEIGHT_LEVELS.indexOf(level) + 1, WEIGHT_LEVELS.length - 1)] as WeightLevel;

export function planDialBack(policy: PolicyConfig, until: string, now = new Date()): DialBackPlan {
  const items: DialBackItem[] = [];
  let skipped = 0;
  for (const [provider, p] of Object.entries(policy.providers)) {
    for (const [label, model] of Object.entries(p.models)) {
      if (model.status !== 'confirmed') { skipped++; continue; }
      const r = resolveModel(provider, p.defaults, model);
      if (pauseActive(r.pause, now)) { skipped++; continue; }
      const path = fieldPath(provider, label, 'pause');
      if (HIGH_COST.has(r.cost)) { items.push({ provider, label, path, action: 'stop' }); continue; }
      if (LOW_COST.has(r.cost)) {
        const weights: Partial<Record<ActivityId, WeightLevel>> = {};
        for (const a of ACTIVITIES) { const level = r.activities[a]; if (level) weights[a] = raise(level); }
        if (Object.keys(weights).length) { items.push({ provider, label, path, action: 'favour', weights }); continue; }
      }
      skipped++;
    }
  }
  return { until, items, skipped };
}

/** The value written to a model's pause field. Stopping has no weights, so the router skips the model outright. */
export function pauseValue(item: DialBackItem, until: string): { until: string; weights: Record<string, WeightLevel> | null } {
  return { until, weights: item.action === 'favour' ? { ...item.weights } as Record<string, WeightLevel> : null };
}
