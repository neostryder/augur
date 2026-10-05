// Turns the service's decision record into training rows for the Laya trainer. Only picks that kept their task text produce rows.
import { createHash } from 'node:crypto';
import { FIT_LEVELS, activityQuestion, dataQuestion, fitQuestions } from './questions.js';
import type { Question } from './questions.js';

export interface PickRow {
  kind: 'pick'; id: string; at?: number; task?: string; named?: string | null; depth?: string; seats?: { second?: string; web?: string; shadow?: string }; activity: string; dataTier: string; pick: string | null;
  classified?: { activity: boolean; dataTier: boolean }; descriptions?: Record<string, string>;
}
export interface JobRow { kind: 'job'; job: string; pick: string; model: string; overridden: boolean }
export interface OutcomeRow { kind: 'outcome'; job: string; pick: string | null; model: string; state: string }
/** How a job's report met the brief it was given: the check itself runs in the caller's own tooling and is reported back with `augur label`. */
export type BriefResult = 'met' | 'partly' | 'missed';
export const BRIEF_RESULTS: readonly BriefResult[] = ['met', 'partly', 'missed'];
export interface BriefRow { kind: 'brief'; at?: number; pick: string; job: string | null; result: BriefResult; note?: string }
export type DecisionRow = PickRow | JobRow | OutcomeRow | BriefRow | { kind: string };

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

/** One pick with everything that later said how it went, and no task text: the single file the local shadow model learns its labels from. */
export interface LabelRow {
  pick: string; at: string | null; activity: string; dataTier: string; model: string | null; named: string | null; depth: string | null;
  seats: { second?: string; web?: string; shadow?: string };
  /** Models the pick's jobs ran on, and whether any of them was not the model picked. */
  used: string[]; overridden: boolean;
  /** The end state of each job that finished, in the order they were recorded. */
  outcomes: string[];
  /** The latest brief check reported for the pick or any of its jobs, or null when none was. */
  brief: BriefResult | null; briefNote: string | null;
}

export function labelRows(records: DecisionRow[]): LabelRow[] {
  const picks = new Map<string, PickRow>(), used = new Map<string, Set<string>>(), over = new Set<string>(), outcomes = new Map<string, string[]>(), briefs = new Map<string, BriefRow>();
  const jobPick = new Map<string, string>();
  for (const r of records) {
    if (r.kind === 'pick') picks.set((r as PickRow).id, r as PickRow);
    else if (r.kind === 'job') {
      const j = r as JobRow;
      jobPick.set(j.job, j.pick);
      (used.get(j.pick) ?? used.set(j.pick, new Set()).get(j.pick)!).add(j.model);
      if (j.overridden) over.add(j.pick);
    }
  }
  for (const r of records) {
    if (r.kind === 'outcome') {
      const o = r as OutcomeRow, pick = o.pick ?? jobPick.get(o.job);
      if (pick) (outcomes.get(pick) ?? outcomes.set(pick, []).get(pick)!).push(o.state);
    } else if (r.kind === 'brief') briefs.set((r as BriefRow).pick, r as BriefRow);
  }
  const out: LabelRow[] = [];
  for (const p of picks.values()) {
    const b = briefs.get(p.id);
    out.push({
      pick: p.id, at: typeof p.at === 'number' ? new Date(p.at).toISOString() : null, activity: p.activity, dataTier: p.dataTier, model: p.pick, named: p.named ?? null, depth: p.depth ?? null,
      seats: p.seats ?? {}, used: [...(used.get(p.id) ?? [])], overridden: over.has(p.id), outcomes: outcomes.get(p.id) ?? [], brief: b?.result ?? null, briefNote: b?.note ?? null,
    });
  }
  return out;
}
