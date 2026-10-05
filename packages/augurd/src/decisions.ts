// A local record of what was picked and how it turned out, kept so the decision model can learn from everyday use.
// Task text is written only when learning is on and the task's data tier is public or internal; otherwise a pick keeps its structure and no words.
import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { STUDENT_RE } from '@augur/decision';

export interface LearnSettings {
  /** Keep the task text of a pick, when the data tier allows it. Off by default. */
  recordTasks: boolean;
}

export interface PickEntry {
  session: string | null; task?: string; activity: string; dataTier: string; pick: string | null;
  ranking: Array<{ model: string; fit?: number }>; named: string | null; backend?: string;
  /** Whether the activity and the data tier came from the classifier (true) or from the caller (false). Only declared values are labels. */
  classified?: { activity: boolean; dataTier: boolean };
  /** What the fit questions said about each ranked model, needed to rebuild those questions for training. */
  descriptions?: Record<string, string>;
  /** The balance's reading of the task and why the top model won, and the models named beside it. A job that used another model than the pick is the override label. */
  depth?: string; reason?: string; seats?: { second?: string; web?: string; shadow?: string };
}

/** Tiers whose task text may be written to disk for training. */
const KEEPABLE = new Set(['public', 'internal']);

export class DecisionLog {
  private lastBySession = new Map<string, { id: string; at: number; model: string | null }>();
  private links = new Map<string, string>();
  constructor(private dir: string, private settings: LearnSettings, private now: () => number = Date.now) {}

  private write(row: Record<string, unknown>): void {
    try { appendFileSync(join(this.dir, 'decisions.jsonl'), JSON.stringify(row) + '\n'); } catch { /* the record is best effort */ }
  }

  /** Records a pick and returns its id. */
  pick(e: PickEntry): string {
    const id = randomBytes(6).toString('hex'), at = this.now();
    const keep = this.settings.recordTasks && e.task && KEEPABLE.has(e.dataTier) && !STUDENT_RE.test(e.task);
    const { task, ...rest } = e;
    this.write({ kind: 'pick', id, at, ...rest, ...(keep ? { task } : {}) });
    if (e.session) this.lastBySession.set(e.session, { id, at, model: e.pick });
    return id;
  }

  /** Ties a job to the caller's latest pick, and notes when the job used another model than the one picked. */
  linkJob(session: string | null, model: string, jobId: string, windowMs = 3600_000): string | null {
    const last = session ? this.lastBySession.get(session) : undefined;
    if (!last || this.now() - last.at > windowMs) return null;
    this.links.set(jobId, last.id);
    this.write({ kind: 'job', job: jobId, pick: last.id, model, at: this.now(), overridden: last.model !== null && last.model !== model });
    return last.id;
  }

  outcome(jobId: string, model: string, state: string, reason: string | null, ms: number | null): void {
    this.write({ kind: 'outcome', job: jobId, pick: this.links.get(jobId) ?? null, model, state, reason, ms, at: this.now() });
    this.links.delete(jobId);
  }
}
