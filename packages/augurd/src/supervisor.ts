// Accepts jobs, applies the rules, launches one runner per job and keeps the store true to what the runners leave on disk.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVITIES, DATA_TIERS, OUTPUT_MODES } from '@augur/core';
import type { PolicyFile } from '@augur/core';
import { TOOL_TIERS, checkLineage, evaluate, isTerminal } from '@augur/dispatch-protocol';
import type { Adapter, JobRecord, JobRequest, Rejection, RouteConfig, UsageSnapshot } from '@augur/dispatch-protocol';
import type { ServiceConfig } from './config.js';
import { buildEnv } from './env.js';
import type { Store } from './store.js';

export interface SupervisorDeps {
  store: Store; config: ServiceConfig; dir: string; adapters: Map<string, Adapter>;
  routes: () => Record<string, RouteConfig> | null; policy: () => PolicyFile | null; usage: () => UsageSnapshot | null;
  runnerPath?: string; now?: () => number; env?: NodeJS.ProcessEnv;
}

export type SubmitResult = { id: string; warnings: string[] } | { rejected: Rejection };

const readJson = <T>(path: string): T | null => { try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; } };
const alive = (pid: number | null | undefined): boolean => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const reject = (code: Rejection['code'], reason: string): SubmitResult => ({ rejected: { code, reason } });

const TIER_NOTE: Record<string, string> = {
  read: 'Tool tier: read. Read files and run read-only commands only. Do not create, modify or delete anything.',
  write: 'Tool tier: write. You may edit files in the working directory. Do not touch anything outside it.',
  full: '',
};

interface RunnerResult { exitCode: number | null; signal?: string | null; killedBy: 'cancel' | 'timeout' | null; endedAt: number; spawnError?: string }

export class Supervisor {
  private adopted = new Set<string>();
  private outputSeen = new Set<string>();
  private readonly now: () => number;
  private readonly runner: string;
  constructor(private d: SupervisorDeps) {
    this.now = d.now ?? Date.now;
    this.runner = d.runnerPath ?? fileURLToPath(new URL('./runner.ts', import.meta.url));
    mkdirSync(join(d.dir, 'jobs'), { recursive: true });
  }

  jobDir(id: string): string { return join(this.d.dir, 'jobs', id); }

  // ------------------------------------------------------------------ submit

  submit(req: JobRequest): SubmitResult {
    const bad = this.validate(req);
    if (bad) return reject('bad_request', bad);
    const routes = this.d.routes();
    const route = routes?.[req.route];
    if (!route) return reject('unknown_route', `Route ${req.route} is not in routes.json.`);
    const adapter = this.d.adapters.get(route.adapter);
    if (!adapter) return reject('adapter_unavailable', `Adapter ${route.adapter} is not enabled.`);
    const invalid = adapter.validate(route);
    if (invalid) return reject('adapter_unavailable', `Route ${req.route}: ${invalid}`);

    let root: string | null = null, parentId: string | null = null, depth = 0, parentRoute: RouteConfig | null = null;
    if (req.parent) {
      const parent = this.d.store.get(req.parent.jobId);
      if (!parent || isTerminal(parent.state)) return reject('delegation_not_granted', 'The parent job is not running.');
      parentRoute = routes?.[parent.route] ?? null; root = parent.rootJobId; parentId = parent.id; depth = parent.depth + 1;
      const lineage = checkLineage({ ...req, parent: { jobId: parent.id, rootJobId: parent.rootJobId, depth: parent.depth } }, parentRoute,
        this.d.store.countDescendants(parent.rootJobId), { maxDepth: this.d.config.maxDepth, maxDescendants: this.d.config.maxDescendants });
      if (lineage) return { rejected: lineage };
    }

    const decision = evaluate(req, { policy: this.d.policy(), usage: this.d.usage(), route, capabilities: adapter.capabilities, now: new Date(this.now()) });
    if (!decision.allow) { this.d.store.event(null, 'policy_evaluated', `rejected ${decision.rejection.code}: ${req.route}`, this.now()); return { rejected: decision.rejection }; }

    let prompt: string;
    try { prompt = req.prompt.text ?? readFileSync(req.prompt.file as string, 'utf8'); } catch { return reject('bad_request', 'The prompt file could not be read.'); }
    const id = randomBytes(6).toString('hex'), dir = this.jobDir(id);
    mkdirSync(dir, { recursive: true });
    const plan = adapter.plan(req, route, dir);
    const note = plan.tierInPrompt ? TIER_NOTE[plan.tierInPrompt] : '';
    const full = note ? `${note}\n\n${prompt}` : prompt;
    if (plan.stdin === 'prompt') writeFileSync(join(dir, 'prompt.in'), full);
    if (this.d.config.persistPrompts) writeFileSync(join(dir, 'prompt.txt'), full);
    writeFileSync(join(dir, 'job.json'), JSON.stringify({ command: plan.command, args: plan.args, cwd: plan.cwd, stdin: plan.stdin, timeoutS: req.timeoutS ?? null,
      jobhost: this.d.config.jobhostPath, env: plan.env }));
    this.d.store.insert({ id, route: req.route, adapter: adapter.id, activity: req.activity, dataTier: req.dataTier, tools: req.tools, output: req.output, cwd: req.cwd,
      createdAt: this.now(), rootJobId: root ?? id, parentJobId: parentId, depth, caller: req.caller, named: !!req.named, expectFile: req.expectFile ?? null,
      timeoutS: req.timeoutS ?? null, harnessVersion: null });
    const s = this.d.store;
    s.event(id, 'requested', `${req.caller.kind}${req.caller.label ? ' ' + req.caller.label : ''}`, this.now());
    s.event(id, 'policy_evaluated', decision.warnings.join(' | '), this.now());
    s.event(id, 'queued', '', this.now());
    this.tick();
    return { id, warnings: decision.warnings };
  }

  private validate(req: JobRequest): string | null {
    if (!ACTIVITIES.includes(req.activity)) return 'Unknown activity.';
    if (!DATA_TIERS.includes(req.dataTier)) return 'Unknown data tier.';
    if (!TOOL_TIERS.includes(req.tools)) return 'Unknown tool tier.';
    if (!OUTPUT_MODES.includes(req.output)) return 'Unknown output mode.';
    if (!isAbsolute(req.cwd) || !existsSync(req.cwd) || !statSync(req.cwd).isDirectory()) return 'cwd must be an existing absolute directory.';
    const inData = relative(resolve(this.d.dir), resolve(req.cwd));
    if (!inData.startsWith('..') && !isAbsolute(inData)) return 'cwd may not be inside the service data folder.';
    if ((req.prompt.text === undefined) === (req.prompt.file === undefined)) return 'Give the prompt as text or as a file, not both.';
    if (req.expectFile !== undefined) {
      const target = resolve(req.cwd, req.expectFile);
      if (target !== resolve(req.cwd) && !target.startsWith(resolve(req.cwd) + sep)) return 'expectFile must stay inside cwd.';
    }
    if (req.timeoutS !== undefined && !(req.timeoutS > 0 && req.timeoutS <= 86400)) return 'timeoutS must be between 1 and 86400.';
    return null;
  }

  // ------------------------------------------------------------------ launch and watch

  private launch(id: string): void {
    const rec = this.d.store.get(id);
    if (!rec || rec.state !== 'queued') return;
    const dir = this.jobDir(id), adapter = this.d.adapters.get(rec.adapter);
    const file = readJson<{ env: Record<string, string> }>(join(dir, 'job.json'));
    if (!adapter || !file) { this.d.store.transition(id, 'failed', { reason: 'job files missing at launch' }, this.now()); return; }
    const route = this.d.routes()?.[rec.route];
    const extra: Record<string, string> = { ...file.env, AUGUR_JOB_ID: id, AUGUR_ROOT_JOB_ID: rec.rootJobId };
    if (!route?.delegation) { delete extra.AUGUR_JOB_ID; delete extra.AUGUR_ROOT_JOB_ID; }
    const env = buildEnv(adapter.envAllow, extra, this.d.env ?? process.env);
    let pid: number | undefined;
    try {
      const r = spawn(process.execPath, [this.runner, dir], { detached: true, windowsHide: true, stdio: 'ignore', env });
      r.on('error', () => { /* reported by the missing-runner check */ });
      r.unref(); pid = r.pid;
    } catch (e) { this.d.store.transition(id, 'failed', { reason: `runner could not start: ${(e as Error).message}` }, this.now()); return; }
    if (this.d.store.transition(id, 'running', { runnerPid: pid, startedAt: this.now() }, this.now())) {
      this.d.store.event(id, 'process_created', `runner ${pid}`, this.now());
      if (route && adapter.version) { try { this.d.store.setVersion(id, adapter.version(route)); } catch { /* version is informational */ } }
    }
  }

  tick(): void {
    const store = this.d.store;
    for (const rec of store.active()) this.watch(rec);
    const room = this.d.config.maxConcurrent - store.countActive();
    if (room > 0) for (const id of store.queued(room)) this.launch(id);
  }

  private watch(rec: JobRecord): void {
    const store = this.d.store, dir = this.jobDir(rec.id), inner = store.internal(rec.id);
    if (!inner) return;
    const state = readJson<{ childPid: number; runnerPid: number }>(join(dir, 'state.json'));
    if (state && inner.childPid !== state.childPid) store.setPids(rec.id, { childPid: state.childPid, runnerPid: state.runnerPid });
    if (!this.outputSeen.has(rec.id)) {
      try { if (statSync(join(dir, 'stdout.log')).size > 0) { this.outputSeen.add(rec.id); store.event(rec.id, 'first_update', '', this.now()); } } catch { /* no output yet */ }
    }
    const result = readJson<RunnerResult>(join(dir, 'result.json'));
    if (result) { this.finalize(rec, result); return; }
    let age = Infinity;
    try { age = this.now() - statSync(join(dir, 'heartbeat')).mtimeMs; } catch { /* runner not started yet */ }
    const seen = age !== Infinity, since = this.now() - (rec.startedAt ?? rec.createdAt), pid = inner.runnerPid;
    const gone = (!alive(pid) && (seen ? age > 3000 : since > 8000)) || (seen ? age > this.d.config.runnerStaleS * 1000 : since > this.d.config.runnerStaleS * 1000);
    if (!gone) return;
    const child = state?.childPid ?? inner.childPid, orphan = alive(child);
    if (orphan) this.killTree(child as number);
    store.transition(rec.id, rec.state === 'cancel_requested' ? 'cancelled' : 'lost', { reason: `runner gone, child ${orphan ? 'orphaned and killed' : 'not running'}` }, this.now());
    this.cleanup(rec.id);
  }

  private finalize(rec: JobRecord, res: RunnerResult): void {
    const store = this.d.store, adapter = this.d.adapters.get(rec.adapter), inner = store.internal(rec.id), at = this.now();
    if (this.adopted.delete(rec.id)) store.event(rec.id, 'reconciled', 'finished while the service was not watching', at);
    store.event(rec.id, 'process_exited', `exit ${res.exitCode}${res.killedBy ? ` after ${res.killedBy}` : ''}`, at);
    if (res.killedBy === 'cancel') store.event(rec.id, 'cancellation_acknowledged', '', at);
    if (adapter) {
      const usage = adapter.usage(this.tail(join(this.jobDir(rec.id), 'stdout.log'), 4 * 1024 * 1024));
      if (usage) { store.setUsage(rec.id, usage); store.event(rec.id, 'usage_recorded', `${usage.inputTokens} in, ${usage.outputTokens} out`, at); }
    }
    const patch = { endedAt: res.endedAt, exitCode: res.exitCode };
    if (res.killedBy === 'cancel') store.transition(rec.id, 'cancelled', { ...patch, reason: 'cancelled' }, at);
    else if (res.killedBy === 'timeout') store.transition(rec.id, 'killed', { ...patch, reason: `timed out after ${inner?.timeoutS}s` }, at);
    else if (res.spawnError) store.transition(rec.id, 'failed', { ...patch, reason: res.spawnError }, at);
    else if (res.exitCode !== 0) store.transition(rec.id, 'failed', { ...patch, reason: `exit ${res.exitCode}` }, at);
    else if (inner?.expectFile && !existsSync(resolve(rec.cwd, inner.expectFile))) store.transition(rec.id, 'artifact_validation_failed', { ...patch, reason: `expected file ${inner.expectFile} is missing` }, at);
    else { if (inner?.expectFile) store.event(rec.id, 'artifact_validated', inner.expectFile, at); store.transition(rec.id, 'completed', patch, at); }
    store.event(rec.id, 'finalized', '', this.now());
    this.cleanup(rec.id);
  }

  private cleanup(id: string): void {
    this.outputSeen.delete(id);
    try { unlinkSync(join(this.jobDir(id), 'prompt.in')); } catch { /* already read by the runner */ }
  }

  private killTree(pid: number): void {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
  }

  private tail(path: string, bytes: number): string {
    try {
      const size = statSync(path).size, start = Math.max(0, size - bytes), fd = openSync(path, 'r');
      try { const buf = Buffer.alloc(size - start); readSync(fd, buf, 0, buf.length, start); return buf.toString('utf8'); } finally { closeSync(fd); }
    } catch { return ''; }
  }

  /** Called once when the service starts: every job that was running is re-adopted from its files. */
  reconcile(): void {
    const store = this.d.store, active = store.active();
    store.event(null, 'daemon_started', `${active.length} running jobs to re-adopt`, this.now());
    for (const rec of active) this.adopted.add(rec.id);
    this.tick();
    this.purge();
  }

  // ------------------------------------------------------------------ callers

  cancel(id: string): { ok: boolean; state: JobRecord['state'] } | null {
    const store = this.d.store, rec = store.get(id);
    if (!rec) return null;
    if (isTerminal(rec.state)) return { ok: false, state: rec.state };
    const at = this.now();
    if (rec.state === 'queued' || rec.state === 'needs_approval') { store.transition(id, 'cancelled', { reason: 'cancelled before launch' }, at); this.cleanup(id); return { ok: true, state: 'cancelled' }; }
    store.event(id, 'cancellation_requested', '', at);
    writeFileSync(join(this.jobDir(id), 'cancel.request'), '1');
    store.transition(id, 'cancel_requested', {}, at);
    this.tick();
    return { ok: true, state: store.get(id)?.state ?? 'cancel_requested' };
  }

  logs(id: string, stream: 'stdout' | 'stderr' = 'stdout', offset = 0, limit = 65536): { text: string; next: number; done: boolean } | null {
    const rec = this.d.store.get(id);
    if (!rec) return null;
    const path = join(this.jobDir(id), `${stream}.log`);
    let size = 0; try { size = statSync(path).size; } catch { /* no output */ }
    const start = Math.min(Math.max(0, offset), size), len = Math.min(Math.max(1, limit), 1048576, size - start);
    let buf = Buffer.alloc(0);
    if (len > 0) { const fd = openSync(path, 'r'); try { buf = Buffer.alloc(len); readSync(fd, buf, 0, len, start); } finally { closeSync(fd); } }
    let end = buf.length;
    if (start + len < size) { // do not end inside a multi-byte character
      const byte = (n: number) => buf[n] ?? 0;
      let i = end; while (i > 0 && (byte(i - 1) & 0xc0) === 0x80) i--;
      if (i > 0 && byte(i - 1) >= 0xc0) end = i - 1;
    }
    return { text: buf.subarray(0, end).toString('utf8'), next: start + end, done: isTerminal(rec.state) && start + end >= size };
  }

  result(id: string): { job: JobRecord; lastMessage: string | null } | null {
    const job = this.d.store.get(id);
    if (!job) return null;
    const p = join(this.jobDir(id), 'last-message.txt');
    let lastMessage: string | null = null;
    try { if (statSync(p).size <= 1048576) lastMessage = readFileSync(p, 'utf8'); } catch { /* none written */ }
    return { job, lastMessage };
  }

  /** Removes the folders of jobs that ended before the retention window. Job records stay. */
  purge(): number {
    const cutoff = this.now() - this.d.config.retentionDays * 86400000;
    let n = 0;
    for (const id of this.d.store.purgeable(cutoff)) {
      try { rmSync(this.jobDir(id), { recursive: true, force: true }); this.d.store.markPurged(id); n++; } catch { /* retried next time */ }
    }
    return n;
  }
}
