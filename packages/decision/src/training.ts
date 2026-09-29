// Turns the service's decision record into training rows for the Laya trainer. Only picks that kept their task text produce rows.
import { createHash } from 'node:crypto';
import { FIT_LEVELS, activityQuestion, dataQuestion, fitQuestions } from './questions.js';
import type { Question } from './questions.js';

export interface PickRow {
  kind: 'pick'; id: string; task?: string; activity: string; dataTier: string; pick: string | null;
  classified?: { activity: boolean; dataTier: boolean }; descriptions?: Record<string, string>;
}
export interface JobRow { kind: 'job'; job: string; pick: string; model: string; overridden: boolean }
export interface OutcomeRow { kind: 'outcome'; job: string; pick: string | null; model: string; state: string }
export type DecisionRow = PickRow | JobRow | OutcomeRow | { kind: string };

export interface TrainingRow {
  id: string; pilot: string; split: 'train' | 'test'; source: 'human'; provenance: 'rule' | 'outcome';
  state: { task: string }; questions: Record<string, Question>; labels: Record<string, string | number>;
}

const TEST_SHARE = 0.15;
const splitOf = (id: string): 'train' | 'test' => parseInt(createHash('sha256').update(id).digest('hex').slice(0, 8), 16) / 0xffffffff < TEST_SHARE ? 'test' : 'train';
const key = (name: string) => name.replace(/[^A-Za-z0-9_]/g, '_');

/**
 * Activity and data tier come from picks whose caller declared them (a declared value is a rule, where a classified one would only repeat the model).
 * Fit comes from what happened to the job after the pick: completed is a good fit, and a job that used a model over the picked one and completed is an excellent one.
 * A failed, killed, lost or invalid-output job says nothing about how well the model suited the task, since a crash, a timeout or a broken adapter looks the same, so it makes no label.
 * Only models that were actually used are observed, so these labels are biased toward the ranking's own top choices.
 */
export function trainingRows(records: DecisionRow[]): TrainingRow[] {
  const picks = new Map<string, PickRow>(), jobs = new Map<string, JobRow>(), out: TrainingRow[] = [];
  for (const r of records) {
    if (r.kind === 'pick') picks.set((r as PickRow).id, r as PickRow);
    else if (r.kind === 'job') jobs.set((r as JobRow).job, r as JobRow);
  }
  for (const p of picks.values()) {
    if (!p.task) continue;
    const state = { task: p.task };
    if (p.classified?.activity === false) out.push({ id: `${p.id}:activity`, pilot: 'augur_activity', split: splitOf(p.id), source: 'human', provenance: 'rule', state, questions: activityQuestion(), labels: { activity: p.activity } });
    if (p.classified?.dataTier === false) out.push({ id: `${p.id}:data`, pilot: 'augur_data_tier', split: splitOf(p.id), source: 'human', provenance: 'rule', state, questions: dataQuestion(), labels: { data: p.dataTier } });
  }
  for (const r of records) {
    if (r.kind !== 'outcome') continue;
    const o = r as OutcomeRow, job = jobs.get(o.job), pick = picks.get(o.pick ?? job?.pick ?? '');
    if (!pick?.task || !job) continue;
    let level: number;
    if (o.state === 'completed') level = job.overridden ? 3 : 2;
    else continue;
    const desc = pick.descriptions?.[o.model] ?? '';
    const q = fitQuestions([{ model: o.model, description: desc }]);
    out.push({ id: `${pick.id}:${o.job}`, pilot: 'augur_fit', split: splitOf(pick.id), source: 'human', provenance: 'outcome', state: { task: pick.task }, questions: q,
      labels: { [`f_${key(o.model)}`]: level, [`r_${key(o.model)}`]: FIT_LEVELS.length - 1 - level } });
  }
  return out;
}
