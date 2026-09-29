// The service's own state: jobs and their events, in SQLite. Transitions are single conditional updates, so two writers cannot both win.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { canTransition, isTerminal, statesBefore } from '@augur/dispatch-protocol';
import type { JobEvent, JobRecord, JobState, UsageReport } from '@augur/dispatch-protocol';

interface Row {
  id: string; state: string; route: string; adapter: string; activity: string; data_tier: string; tools: string; output: string; cwd: string;
  created_at: number; started_at: number | null; ended_at: number | null; exit_code: number | null; reason: string | null;
  root_job_id: string; parent_job_id: string | null; depth: number; caller: string; named: number; harness_version: string | null;
  usage: string | null; runner_pid: number | null; child_pid: number | null; expect_file: string | null; timeout_s: number | null;
  purged: number;
}

const toRecord = (r: Row): JobRecord => ({
  id: r.id, state: r.state as JobState, route: r.route, adapter: r.adapter, activity: r.activity as JobRecord['activity'], dataTier: r.data_tier as JobRecord['dataTier'],
  tools: r.tools as JobRecord['tools'], output: r.output as JobRecord['output'], cwd: r.cwd, createdAt: r.created_at, startedAt: r.started_at, endedAt: r.ended_at,
  exitCode: r.exit_code, reason: r.reason, rootJobId: r.root_job_id, parentJobId: r.parent_job_id, depth: r.depth, caller: JSON.parse(r.caller) as JobRecord['caller'],
  named: r.named === 1, harnessVersion: r.harness_version, usage: r.usage ? JSON.parse(r.usage) as UsageReport : null,
});

export interface NewJob {
  id: string; route: string; adapter: string; activity: string; dataTier: string; tools: string; output: string; cwd: string; createdAt: number;
  rootJobId: string; parentJobId: string | null; depth: number; caller: JobRecord['caller']; named: boolean; expectFile: string | null; timeoutS: number | null;
  harnessVersion: string | null;
}

export interface Patch { startedAt?: number; endedAt?: number; exitCode?: number | null; reason?: string; runnerPid?: number; childPid?: number }

export class Store {
  readonly db: DatabaseSync;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, 'state.db'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
    this.db.exec(`create table if not exists jobs(
      id text primary key, state text not null, route text not null, adapter text not null, activity text not null, data_tier text not null, tools text not null,
      output text not null, cwd text not null, created_at integer not null, started_at integer, ended_at integer, exit_code integer, reason text,
      root_job_id text not null, parent_job_id text, depth integer not null default 0, caller text not null, named integer not null default 0,
      harness_version text, usage text, runner_pid integer, child_pid integer, expect_file text, timeout_s integer, purged integer not null default 0);
      create index if not exists jobs_state on jobs(state);
      create index if not exists jobs_root on jobs(root_job_id);
      create table if not exists events(seq integer primary key autoincrement, job_id text, at integer not null, kind text not null, detail text not null default '');
      create index if not exists events_job on events(job_id, seq);`);
  }

  close(): void { this.db.close(); }

  insert(j: NewJob): void {
    this.db.prepare(`insert into jobs(id,state,route,adapter,activity,data_tier,tools,output,cwd,created_at,root_job_id,parent_job_id,depth,caller,named,harness_version,expect_file,timeout_s)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(j.id, 'queued', j.route, j.adapter, j.activity, j.dataTier, j.tools, j.output, j.cwd, j.createdAt, j.rootJobId,
      j.parentJobId, j.depth, JSON.stringify(j.caller), j.named ? 1 : 0, j.harnessVersion, j.expectFile, j.timeoutS);
  }

  private row(id: string): Row | undefined { return this.db.prepare('select * from jobs where id=?').get(id) as Row | undefined; }
  get(id: string): JobRecord | null { const r = this.row(id); return r ? toRecord(r) : null; }
  internal(id: string): { runnerPid: number | null; childPid: number | null; expectFile: string | null; timeoutS: number | null; purged: boolean } | null {
    const r = this.row(id); return r ? { runnerPid: r.runner_pid, childPid: r.child_pid, expectFile: r.expect_file, timeoutS: r.timeout_s, purged: r.purged === 1 } : null;
  }

  list(filter: { state?: JobState; root?: string; limit?: number } = {}): JobRecord[] {
    const where: string[] = [], args: Array<string | number> = [];
    if (filter.state) { where.push('state=?'); args.push(filter.state); }
    if (filter.root) { where.push('root_job_id=?'); args.push(filter.root); }
    const sql = `select * from jobs ${where.length ? 'where ' + where.join(' and ') : ''} order by created_at desc, rowid desc limit ?`;
    return (this.db.prepare(sql).all(...args, filter.limit ?? 100) as unknown as Row[]).map(toRecord);
  }

  /** Jobs the supervisor still has to watch. */
  active(): JobRecord[] { return (this.db.prepare("select * from jobs where state in ('running','cancel_requested')").all() as unknown as Row[]).map(toRecord); }
  queued(limit: number): string[] { return (this.db.prepare("select id from jobs where state='queued' order by created_at, rowid limit ?").all(limit) as Array<{ id: string }>).map(r => r.id); }
  countActive(): number { return (this.db.prepare("select count(*) c from jobs where state in ('running','cancel_requested')").get() as { c: number }).c; }
  countDescendants(root: string): number { return (this.db.prepare('select count(*) c from jobs where root_job_id=? and id<>?').get(root, root) as { c: number }).c; }

  /** Moves a job to `to` if its current state allows it. Returns whether this call made the change. */
  transition(id: string, to: JobState, patch: Patch = {}, at = Date.now()): boolean {
    const from = statesBefore(to);
    if (!from.length) return false;
    const marks = from.map(() => '?').join(',');
    const res = this.db.prepare(`update jobs set state=?, started_at=coalesce(?,started_at), ended_at=coalesce(?,ended_at), exit_code=coalesce(?,exit_code), reason=coalesce(?,reason),
      runner_pid=coalesce(?,runner_pid), child_pid=coalesce(?,child_pid) where id=? and state in (${marks})`)
      .run(to, patch.startedAt ?? null, patch.endedAt ?? (isTerminal(to) ? at : null), patch.exitCode ?? null, patch.reason ?? null, patch.runnerPid ?? null, patch.childPid ?? null, id, ...from);
    if (Number(res.changes) === 1) { this.event(id, to, patch.reason ?? '', at); return true; }
    return false;
  }
  canMove(id: string, to: JobState): boolean { const j = this.get(id); return !!j && canTransition(j.state, to); }

  setPids(id: string, pids: { runnerPid?: number; childPid?: number }): void {
    this.db.prepare('update jobs set runner_pid=coalesce(?,runner_pid), child_pid=coalesce(?,child_pid) where id=?').run(pids.runnerPid ?? null, pids.childPid ?? null, id);
  }
  setUsage(id: string, usage: UsageReport): void { this.db.prepare('update jobs set usage=? where id=?').run(JSON.stringify(usage), id); }
  setVersion(id: string, version: string | null): void { this.db.prepare('update jobs set harness_version=? where id=?').run(version, id); }
  markPurged(id: string): void { this.db.prepare('update jobs set purged=1 where id=?').run(id); }

  event(jobId: string | null, kind: string, detail = '', at = Date.now()): void {
    this.db.prepare('insert into events(job_id,at,kind,detail) values(?,?,?,?)').run(jobId, at, kind, detail);
  }
  events(jobId: string, since = 0): JobEvent[] {
    return (this.db.prepare('select seq, job_id, at, kind, detail from events where job_id=? and seq>? order by seq').all(jobId, since) as Array<{ seq: number; job_id: string; at: number; kind: string; detail: string }>)
      .map(e => ({ seq: e.seq, jobId: e.job_id, at: e.at, kind: e.kind, detail: e.detail }));
  }

  /** Terminal jobs that ended before `cutoff` and whose folder is still on disk. */
  purgeable(cutoff: number): string[] {
    return (this.db.prepare("select id from jobs where purged=0 and ended_at is not null and ended_at<? and state in ('completed','failed','artifact_validation_failed','cancelled','killed','lost')").all(cutoff) as Array<{ id: string }>).map(r => r.id);
  }
}
