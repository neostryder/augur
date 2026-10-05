// A local record of what was picked and how it turned out, kept so the decision model can learn from everyday use.
// Task text is written only when learning is on and the task's data tier is public or internal; otherwise a pick keeps its structure and no words.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { STUDENT_RE, labelRows } from '@augur/decision';
import type { BriefResult, DecisionRow, LabelRow } from '@augur/decision';
import type { PickSummary } from '@augur/dispatch-protocol';

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
  /** Copilot's spend for the month when a pick landed on a Copilot model, so each such spend can be reported. */
  spend?: number | null;
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

  /** What the log says about the last `days` days: picks per activity and model, and the jobs that ran on another model than the pick. */
  summary(days: number): PickSummary {
    const out: PickSummary = { days, picks: 0, byActivity: {}, overrides: 0, jobs: 0 };
    const copilot: NonNullable<PickSummary['copilot']> = [];
    const path = join(this.dir, 'decisions.jsonl');
    if (!existsSync(path)) return out;
    const since = this.now() - days * 86400_000;
    let text = '';
    try { text = readFileSync(path, 'utf8'); } catch { return out; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let row: { kind?: string; at?: number; activity?: string; pick?: string | null; overridden?: boolean; spend?: number | null };
      try { row = JSON.parse(line); } catch { continue; }
      if (typeof row.at !== 'number' || row.at < since) continue;
      if (row.kind === 'pick' && row.activity && row.pick) {
        out.picks++; const m = (out.byActivity[row.activity] ??= {}); m[row.pick] = (m[row.pick] ?? 0) + 1;
        if (row.pick.startsWith('copilot/')) copilot.push({ at: new Date(row.at).toISOString(), activity: row.activity, model: row.pick, spend: typeof row.spend === 'number' ? row.spend : null });
      }
      else if (row.kind === 'job') { out.jobs++; if (row.overridden) out.overrides++; }
    }
    if (copilot.length) out.copilot = copilot.slice(-20);
    return out;
  }

  private rows(): DecisionRow[] {
    const path = join(this.dir, 'decisions.jsonl');
    if (!existsSync(path)) return [];
    let text = '';
    try { text = readFileSync(path, 'utf8'); } catch { return []; }
    return text.split('\n').flatMap(l => { if (!l) return []; try { return [JSON.parse(l) as DecisionRow]; } catch { return []; } });
  }

  /** Every pick with its override, job outcomes and brief check, one row each and no task text. */
  labels(): LabelRow[] { return labelRows(this.rows()); }

  /** Records how a job's report met its brief, beside the pick it belongs to. `id` is a pick id or a job id. */
  label(id: string, result: BriefResult, note?: string): { ok: true; pick: string; job: string | null } | { error: string } {
    const rows = this.rows();
    const job = rows.find(r => r.kind === 'job' && (r as { job?: string }).job === id) as { pick: string } | undefined;
    const pick = job ? job.pick : (rows.find(r => r.kind === 'pick' && (r as { id?: string }).id === id) ? id : null);
    if (!pick) return { error: 'No pick or job with that id is in the decision log.' };
    this.write({ kind: 'brief', at: this.now(), pick, job: job ? id : null, result, ...(note ? { note: note.slice(0, 200) } : {}) });
    return { ok: true, pick, job: job ? id : null };
  }

  outcome(jobId: string, model: string, state: string, reason: string | null, ms: number | null): void {
    this.write({ kind: 'outcome', job: jobId, pick: this.links.get(jobId) ?? null, model, state, reason, ms, at: this.now() });
    this.links.delete(jobId);
  }
}
