// What Augur asks a decision backend: which activity a task is, how sensitive its data is, and how well each model fits it.
import { DATA_TIERS } from '@augur/core';
import type { ActivityId, DataTier } from '@augur/core';
import type { DecisionBackend } from './backend.js';
import { DATA_CAUTION, DEPTH_TEXT, STUDENT_RE, activityQuestion, dataQuestion, depthQuestion, fitQuestions, heuristicDepth, isActivity, isTier, readFits } from './questions.js';

export interface Classification {
  activity: ActivityId | null;
  dataTier: DataTier;
  /** How much the task weighs, or null when neither the backend nor the keywords settled it. */
  depth: 'routine' | 'everyday' | 'deep' | 'core' | null;
  detail: { depth?: { choice?: string; confidence?: number; source: 'backend' | 'keywords' | 'none'; error?: unknown }; activity?: { choice?: string; confidence?: number; error?: unknown }; data?: { choice?: string; probabilities?: Record<string, number>; backend: string; error?: unknown } };
}

/**
 * The data tier is the strictest one with at least DATA_CAUTION probability, and `sensitive` when nothing answers. A task that could involve student
 * records is checked first, on this machine, and every question about it goes only to a backend that runs on this network. It never drops below
 * `regulated`, and with no such backend it is `regulated` unasked and the activity is left unclassified. Nothing about the task leaves this computer before that check.
 */
export async function classifyTask(backends: { primary: DecisionBackend; local?: DecisionBackend }, task: string): Promise<Classification> {
  const { primary } = backends, local = backends.local ?? (primary.local ? primary : undefined);
  const detail: Classification['detail'] = {};
  const student = STUDENT_RE.test(task), floor = DATA_TIERS.indexOf('regulated');
  const asker = student ? local : primary;

  let activity: ActivityId | null = null;
  if (asker) {
    const act = await asker.ask({ task }, activityQuestion(), 'laya:augur_activity');
    const a = act.answers?.activity;
    detail.activity = { ...(a?.choice ? { choice: a.choice } : {}), ...(typeof a?.confidence === 'number' ? { confidence: a.confidence } : {}), ...(act.error ? { error: act.error } : {}) };
    activity = isActivity(a?.choice) ? a.choice : null;
  } else detail.activity = { error: 'no backend on this network to classify student-related text' };

  let tier: DataTier | null = null;
  if (asker) {
    const res = await asker.ask({ task }, dataQuestion(), 'laya:augur_data_tier');
    const d = res.answers?.data, probs = d?.probabilities ?? (isTier(d?.choice) ? { [d.choice as string]: 1 } : {});
    const likely = DATA_TIERS.filter(t => (probs[t] ?? 0) >= DATA_CAUTION);
    tier = likely.at(-1) ?? null;
    detail.data = { ...(d?.choice ? { choice: d.choice } : {}), probabilities: probs, backend: asker.id, ...(res.error ? { error: res.error } : {}) };
  } else detail.data = { backend: 'none', error: 'no backend on this network to judge student-related text' };
  if (student && (tier === null || DATA_TIERS.indexOf(tier) < floor)) tier = 'regulated';
  const d = await classifyDepth(backends, task);
  detail.depth = d.detail;
  return { activity, dataTier: tier ?? 'sensitive', depth: d.depth, detail };
}

/** How much the task weighs. A task that could involve student records is asked only of a backend on this network; with none, the keywords decide. */
export async function classifyDepth(backends: { primary: DecisionBackend; local?: DecisionBackend }, task: string): Promise<{ depth: Classification['depth']; detail: NonNullable<Classification['detail']['depth']> }> {
  const { primary } = backends, local = backends.local ?? (primary.local ? primary : undefined);
  const asker = STUDENT_RE.test(task) ? local : primary;
  const isDepth = (v: unknown): v is NonNullable<Classification['depth']> => typeof v === 'string' && Object.hasOwn(DEPTH_TEXT, v);
  let detail: NonNullable<Classification['detail']['depth']> = { source: 'none' };
  if (asker) {
    const res = await asker.ask({ task }, depthQuestion(), 'laya:augur_depth');
    const d = res.answers?.depth;
    if (isDepth(d?.choice)) return { depth: d.choice, detail: { choice: d.choice, ...(typeof d.confidence === 'number' ? { confidence: d.confidence } : {}), source: 'backend' } };
    detail = { source: 'none', ...(res.error ? { error: res.error } : {}) };
  }
  const k = heuristicDepth(task);
  return k ? { depth: k as NonNullable<Classification['depth']>, detail: { choice: k, source: 'keywords' } } : { depth: null, detail };
}

/** How well each model fits the task, 0 to 1. A backend that fails leaves every model at 0.5, so ranking falls back to weights and usage. */
export async function fitScores(backend: DecisionBackend, task: string, models: Array<{ model: string; description: string }>): Promise<{ fits: Record<string, number>; error?: string }> {
  if (!models.length) return { fits: {} };
  const res = await backend.ask({ task }, fitQuestions(models), 'laya:augur_fit');
  if (res.error || !res.answers) return { fits: Object.fromEntries(models.map(m => [m.model, 0.5])), error: String(res.error ?? 'no answers') };
  return { fits: readFits(models.map(m => m.model), res.answers) };
}
