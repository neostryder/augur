// What Augur asks a decision backend: which activity a task is, how sensitive its data is, and how well each model fits it.
import { DATA_TIERS } from '@augur/core';
import type { ActivityId, DataTier } from '@augur/core';
import type { DecisionBackend } from './backend.js';
import { DATA_CAUTION, STUDENT_RE, activityQuestion, dataQuestion, fitQuestions, isActivity, isTier, readFits } from './questions.js';

export interface Classification {
  activity: ActivityId | null;
  dataTier: DataTier;
  detail: { activity?: { choice?: string; confidence?: number; error?: unknown }; data?: { choice?: string; probabilities?: Record<string, number>; backend: string; error?: unknown } };
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
  return { activity, dataTier: tier ?? 'sensitive', detail };
}

/** How well each model fits the task, 0 to 1. A backend that fails leaves every model at 0.5, so ranking falls back to weights and usage. */
export async function fitScores(backend: DecisionBackend, task: string, models: Array<{ model: string; description: string }>): Promise<{ fits: Record<string, number>; error?: string }> {
  if (!models.length) return { fits: {} };
  const res = await backend.ask({ task }, fitQuestions(models), 'laya:augur_fit');
  if (res.error || !res.answers) return { fits: Object.fromEntries(models.map(m => [m.model, 0.5])), error: String(res.error ?? 'no answers') };
  return { fits: readFits(models.map(m => m.model), res.answers) };
}
