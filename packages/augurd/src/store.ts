// The service's own state: jobs and their events, in SQLite. Transitions are single conditional updates, so two writers cannot both win.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { canTransition, isTerminal, statesBefore } from '@augur/dispatch-protocol';
import type { Conversation, JobEvent, JobRecord, JobState, PickRecord, PromptRecord, UsageReport } from '@augur/dispatch-protocol';

interface Row {
  id: string; state: string; route: string; adapter: string; activity: string; data_tier: string; tools: string; output: string; cwd: string;
  created_at: number; started_at: number | null; ended_at: number | null; exit_code: number | null; reason: string | null;
  root_job_id: string; parent_job_id: string | null; depth: number; caller: string; named: number; harness_version: string | null;
  usage: string | null; runner_pid: number | null; child_pid: number | null; expect_file: string | null; timeout_s: number | null;
  purged: number; workspace: string | null; patch_path: string | null; changed_files: number | null; prompt_chars: number | null; answer_chars: number | null;
  charter: string | null; charter_chars: number | null; charter_notes: string | null; ambient: string | null;
  retry_of: string | null; retried_as: string | null; conversation: string | null; conversation_turn: number | null;
}

const stringList = (text: string | null): string[] | undefined => {
  if (!text) return undefined;
  try { const v = JSON.parse(text) as unknown; return Array.isArray(v) && v.every(x => typeof x === 'string') ? v : undefined; } catch { return undefined; }
};

const toRecord = (r: Row): JobRecord => {
  const charter = stringList(r.charter), charterNotes = stringList(r.charter_notes);
  return {
    id: r.id, state: r.state as JobState, route: r.route, adapter: r.adapter, activity: r.activity as JobRecord['activity'], dataTier: r.data_tier as JobRecord['dataTier'],
    tools: r.tools as JobRecord['tools'], output: r.output as JobRecord['output'], cwd: r.cwd, createdAt: r.created_at, startedAt: r.started_at, endedAt: r.ended_at,
    exitCode: r.exit_code, reason: r.reason, rootJobId: r.root_job_id, parentJobId: r.parent_job_id, depth: r.depth, caller: JSON.parse(r.caller) as JobRecord['caller'],
    named: r.named === 1, harnessVersion: r.harness_version, usage: r.usage ? JSON.parse(r.usage) as UsageReport : null,
    promptChars: r.prompt_chars, answerChars: r.answer_chars,
    ...(charter ? { charter } : {}), ...(r.charter_chars != null ? { charterChars: r.charter_chars } : {}), ...(charterNotes?.length ? { charterNotes } : {}),
    ...(r.ambient === 'keep' || r.ambient === 'trim' ? { ambient: r.ambient } : {}),
    ...(r.retry_of ? { retryOf: r.retry_of } : {}), ...(r.retried_as ? { retriedAs: r.retried_as } : {}),
    ...(r.conversation ? { conversation: r.conversation, ...(typeof r.conversation_turn === 'number' ? { turn: r.conversation_turn } : {}) } : {}),
    workspace: r.workspace, patch: r.patch_path ? { path: r.patch_path, files: r.changed_files ?? 0 } : null,
  };
};

interface ConversationSql {
  name: string; route: string; adapter: string; native_id: string | null; cwd: string; tools: string;
  turns: number; created_at: number; last_used_at: number;
}

const conversationFrom = (r: ConversationSql): Conversation => ({
  name: r.name, route: r.route, adapter: r.adapter, nativeId: r.native_id, cwd: r.cwd, tools: r.tools as Conversation['tools'],
  turns: r.turns, createdAt: r.created_at, lastUsedAt: r.last_used_at,
});

export interface NewJob {
  id: string; route: string; adapter: string; activity: string; dataTier: string; tools: string; output: string; cwd: string; createdAt: number;
  rootJobId: string; parentJobId: string | null; depth: number; caller: JobRecord['caller']; named: boolean; expectFile: string | null; timeoutS: number | null;
  harnessVersion: string | null; workspace: string | null; conversation?: string | null; turn?: number | null;
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
      create index if not exists events_job on events(job_id, seq);
      create table if not exists picks(id integer primary key autoincrement, at integer not null, session text, model text not null, activity text not null, data_tier text not null, named text, cleared text not null);
      create table if not exists prompts(id integer primary key autoincrement, at integer not null, session text not null, models text not null);
      create table if not exists conversations(
        name text not null, route text not null, adapter text not null, native_id text, cwd text not null, tools text not null,
        turns integer not null, created_at integer not null, last_used_at integer not null, primary key (name, route));`);
    const have = new Set((this.db.prepare('pragma table_info(jobs)').all() as Array<{ name: string }>).map(c => c.name));
    for (const [name, type] of [['workspace', 'text'], ['patch_path', 'text'], ['changed_files', 'integer'], ['prompt_chars', 'integer'], ['answer_chars', 'integer'], ['charter', 'text'], ['charter_chars', 'integer'], ['charter_notes', 'text'], ['ambient', 'text'], ['retry_of', 'text'], ['retried_as', 'text'], ['conversation', 'text'], ['conversation_turn', 'integer']] as const) {
      if (!have.has(name)) this.db.exec(`alter table jobs add column ${name} ${type}`);
    }
    const pickCols = new Set((this.db.prepare('pragma table_info(picks)').all() as Array<{ name: string }>).map(c => c.name));
    for (const [name, type] of [['odds', 'real'], ['drawn', 'integer'], ['seed', 'text']] as const) {
      if (!pickCols.has(name)) this.db.exec(`alter table picks add column ${name} ${type}`);
    }
  }

  close(): void { this.db.close(); }

  insert(j: NewJob): void {
    this.db.prepare(`insert into jobs(id,state,route,adapter,activity,data_tier,tools,output,cwd,created_at,root_job_id,parent_job_id,depth,caller,named,harness_version,expect_file,timeout_s,workspace,conversation,conversation_turn)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(j.id, 'queued', j.route, j.adapter, j.activity, j.dataTier, j.tools, j.output, j.cwd, j.createdAt, j.rootJobId,
      j.parentJobId, j.depth, JSON.stringify(j.caller), j.named ? 1 : 0, j.harnessVersion, j.expectFile, j.timeoutS, j.workspace, j.conversation ?? null, j.turn ?? null);
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

  /** Every job on a route created at or after `at`, newest first. Budgets are checked over these. */
  since(route: string, at: number): JobRecord[] {
    return (this.db.prepare('select * from jobs where route=? and created_at>=? order by created_at desc, rowid desc').all(route, at) as unknown as Row[]).map(toRecord);
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
  setChars(id: string, chars: { prompt?: number; answer?: number }): void {
    this.db.prepare('update jobs set prompt_chars=coalesce(?,prompt_chars), answer_chars=coalesce(?,answer_chars) where id=?').run(chars.prompt ?? null, chars.answer ?? null, id);
  }
  /** Records the charter and the ambient choice for a job just inserted. The prompt length is the caller's prompt. */
  setLaunchMeta(id: string, meta: { promptChars: number; ambient: 'keep' | 'trim'; charter?: string[]; charterChars?: number; charterNotes?: string[] }): void {
    this.db.prepare('update jobs set prompt_chars=?, ambient=?, charter=?, charter_chars=?, charter_notes=? where id=?').run(
      meta.promptChars, meta.ambient, meta.charter ? JSON.stringify(meta.charter) : null, meta.charterChars ?? null,
      meta.charterNotes?.length ? JSON.stringify(meta.charterNotes) : null, id);
  }
  /** Records that `next` was submitted to replace `id`. Both columns stay null on a row from before retries. */
  linkRetry(id: string, next: string): void {
    this.db.prepare('update jobs set retried_as=? where id=?').run(next, id);
    this.db.prepare('update jobs set retry_of=? where id=?').run(id, next);
  }
  setVersion(id: string, version: string | null): void { this.db.prepare('update jobs set harness_version=? where id=?').run(version, id); }
  setPatch(id: string, path: string, files: number): void { this.db.prepare('update jobs set patch_path=?, changed_files=? where id=?').run(path, files, id); }
  addPick(p: PickRecord): void {
    this.db.prepare('insert into picks(at,session,model,activity,data_tier,named,cleared,odds,drawn,seed) values(?,?,?,?,?,?,?,?,?,?)')
      .run(p.at, p.session, p.model, p.activity, p.dataTier, p.named, JSON.stringify(p.cleared), p.odds ?? null, p.drawn == null ? null : p.drawn ? 1 : 0, p.seed ?? null);
  }
  picksSince(since: number): PickRecord[] {
    return (this.db.prepare('select at, session, model, activity, data_tier, named, cleared, odds, drawn, seed from picks where at>=? order by id').all(since) as Array<{ at: number; session: string | null; model: string; activity: string; data_tier: string; named: string | null; cleared: string; odds: number | null; drawn: number | null; seed: string | null }>)
      .map(r => {
        const row: PickRecord = { at: r.at, session: r.session, model: r.model, activity: r.activity, dataTier: r.data_tier, named: r.named, cleared: JSON.parse(r.cleared) as string[] };
        // A row from before draws were logged has none of the three, and stays shaped as it was.
        if (r.odds == null && r.drawn == null && r.seed == null) return row;
        if (typeof r.odds === 'number') row.odds = r.odds;
        if (r.drawn === 0 || r.drawn === 1) row.drawn = r.drawn === 1;
        row.seed = r.seed;
        return row;
      });
  }
  dropPicksBefore(cutoff: number): void { this.db.prepare('delete from picks where at<?').run(cutoff); this.db.prepare('delete from prompts where at<?').run(cutoff); }
  addPrompt(p: PromptRecord): void { this.db.prepare('insert into prompts(at,session,models) values(?,?,?)').run(p.at, p.session, JSON.stringify(p.models)); }
  /** The newest messages a person sent in a session, newest first. */
  recentPrompts(session: string, limit: number): PromptRecord[] {
    return (this.db.prepare('select at, session, models from prompts where session=? order by id desc limit ?').all(session, limit) as Array<{ at: number; session: string; models: string }>)
      .map(r => ({ at: r.at, session: r.session, models: JSON.parse(r.models) as string[] }));
  }
  markPurged(id: string): void { this.db.prepare('update jobs set purged=1 where id=?').run(id); }

  event(jobId: string | null, kind: string, detail = '', at = Date.now()): void {
    this.db.prepare('insert into events(job_id,at,kind,detail) values(?,?,?,?)').run(jobId, at, kind, detail);
  }
  events(jobId: string, since = 0): JobEvent[] {
    return (this.db.prepare('select seq, job_id, at, kind, detail from events where job_id=? and seq>? order by seq').all(jobId, since) as Array<{ seq: number; job_id: string; at: number; kind: string; detail: string }>)
      .map(e => ({ seq: e.seq, jobId: e.job_id, at: e.at, kind: e.kind, detail: e.detail }));
  }

  conversation(name: string): Conversation | null {
    const r = this.db.prepare('select name, route, adapter, native_id, cwd, tools, turns, created_at, last_used_at from conversations where name=?').get(name) as ConversationSql | undefined;
    return r ? conversationFrom(r) : null;
  }

  /** Newest first. */
  conversations(): Conversation[] {
    return (this.db.prepare('select name, route, adapter, native_id, cwd, tools, turns, created_at, last_used_at from conversations order by last_used_at desc, name').all() as unknown as ConversationSql[]).map(conversationFrom);
  }

  insertConversation(c: Conversation): void {
    this.db.prepare('insert into conversations(name, route, adapter, native_id, cwd, tools, turns, created_at, last_used_at) values(?,?,?,?,?,?,?,?,?)')
      .run(c.name, c.route, c.adapter, c.nativeId, c.cwd, c.tools, c.turns, c.createdAt, c.lastUsedAt);
  }

  /** A first turn that did not finish is opened again, so the native id from that attempt is replaced. */
  reopenConversation(name: string, patch: { nativeId: string | null; tools: string; cwd: string }): void {
    this.db.prepare('update conversations set native_id=?, tools=?, cwd=? where name=? and turns=0').run(patch.nativeId, patch.tools, patch.cwd, name);
  }

  /** Counts a completed turn and keeps the previous native id when this turn did not report one. */
  finishConversation(name: string, patch: { nativeId: string | null; cwd: string; lastUsedAt: number }): void {
    this.db.prepare('update conversations set turns=turns+1, last_used_at=?, cwd=?, native_id=coalesce(?, native_id) where name=?')
      .run(patch.lastUsedAt, patch.cwd, patch.nativeId, name);
  }

  clearConversationId(name: string): void {
    this.db.prepare('update conversations set native_id=null where name=? and turns=0').run(name);
  }

  forgetConversation(name: string): boolean {
    return Number(this.db.prepare('delete from conversations where name=?').run(name).changes) > 0;
  }

  /** A job that is still running under this conversation, if one is. */
  holdingConversation(name: string): string | null {
    const row = this.db.prepare("select id from jobs where conversation=? and state in ('queued','needs_approval','running','cancel_requested') limit 1").get(name) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** Terminal jobs that ended before `cutoff` and whose folder is still on disk. */
  purgeable(cutoff: number): string[] {
    return (this.db.prepare("select id from jobs where purged=0 and ended_at is not null and ended_at<? and state in ('completed','failed','artifact_validation_failed','cancelled','killed','lost')").all(cutoff) as Array<{ id: string }>).map(r => r.id);
  }
}
