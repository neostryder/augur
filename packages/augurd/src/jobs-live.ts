import { join } from 'node:path';
import type { JobRecord } from '@augur/dispatch-protocol';
import { atomicWrite } from './home-files.js';
import type { Supervisor } from './supervisor.js';

export const JOBS_LIVE_TEXT = { writeFailed: 'Could not write jobs-live.json; the service keeps running.' } as const;

const REFRESH_MS = 30000;
const LIVE_LIMIT = 50;
export const RECENT_LIMIT = 30;
const REASON_MAX = 160;

/** The job fields a viewer may show. Never the prompt, the answer or the harness output. */
export function jobRow(job: JobRecord, titleOf: (sessionId: string | undefined) => string | undefined = () => undefined) {
  const stamp = job.ledger?.stamp ?? {};
  const sessionId = stamp.sessionId ?? job.caller.session;
  const usage = job.usage;
  return {
    id: job.id, route: job.route, activity: job.activity, state: job.state, startedAt: job.startedAt,
    lastActivityAt: job.lastActivityAt ?? job.startedAt ?? job.createdAt,
    activityLine: job.activityLine ?? '', stalled: job.stalled === true,
    createdAt: job.createdAt, endedAt: job.endedAt, exitCode: job.exitCode,
    reason: job.reason ? job.reason.slice(0, REASON_MAX) : null,
    dataTier: job.dataTier, tools: job.tools, depth: job.depth, parentJobId: job.parentJobId, cwd: job.cwd, named: job.named,
    model: job.ledger?.model ?? job.served?.model ?? null,
    summary: job.ledger?.summary || null,
    origin: {
      kind: stamp.origin ?? job.caller.kind, label: stamp.originLabel ?? job.caller.label ?? null,
      sessionId: sessionId ?? null, sessionTitle: stamp.sessionTitle ?? titleOf(sessionId) ?? null,
      host: stamp.host ?? null, pid: stamp.pid ?? null, intent: job.caller.intent ?? null,
    },
    usage: usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd ?? null } : null,
  };
}

export class JobsLiveWriter {
  private checkedAt = -Infinity;
  private written: string | undefined;
  private writtenAt = -Infinity;

  constructor(private home: string, private supervisor: Pick<Supervisor, 'list'>, private stallMinutes: () => number,
    private log: (message: string) => void, private now = Date.now, private titleOf?: (sessionId: string | undefined) => string | undefined) {}

  tick(): void {
    const now = this.now();
    if (now >= this.checkedAt && now - this.checkedAt < 5000) return;
    this.checkedAt = now;
    try {
      const jobs = this.supervisor.list({ running: true, limit: LIVE_LIMIT })
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, LIVE_LIMIT).map((job: JobRecord) => jobRow(job, this.titleOf));
      const recent = this.supervisor.list({ finished: true, limit: RECENT_LIMIT }).slice(0, RECENT_LIMIT).map((job: JobRecord) => jobRow(job, this.titleOf));
      const text = JSON.stringify({ jobs, recent });
      // The mod ignores a live list older than 60 seconds, so a live list is rewritten every 30 seconds even when nothing in it changed.
      if (text === this.written && (jobs.length === 0 || now - this.writtenAt < REFRESH_MS)) return;
      atomicWrite(join(this.home, 'jobs-live.json'), JSON.stringify({ updatedAt: now, stallMinutes: this.stallMinutes(), jobs, recent }) + '\n');
      this.written = text; this.writtenAt = now;
    } catch { this.log(JOBS_LIVE_TEXT.writeFailed); }
  }
}
