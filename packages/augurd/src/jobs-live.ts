import { join } from 'node:path';
import type { JobRecord } from '@augur/dispatch-protocol';
import { atomicWrite } from './home-files.js';
import type { Supervisor } from './supervisor.js';

export const JOBS_LIVE_TEXT = { writeFailed: 'Could not write jobs-live.json; the service keeps running.' } as const;

const REFRESH_MS = 30000;

export class JobsLiveWriter {
  private checkedAt = -Infinity;
  private written: string | undefined;
  private writtenAt = -Infinity;

  constructor(private home: string, private supervisor: Pick<Supervisor, 'list'>, private stallMinutes: () => number,
    private log: (message: string) => void, private now = Date.now) {}

  tick(): void {
    const now = this.now();
    if (now >= this.checkedAt && now - this.checkedAt < 5000) return;
    this.checkedAt = now;
    try {
      const jobs = this.supervisor.list({ running: true, limit: 50 })
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map((job: JobRecord) => ({
          id: job.id, route: job.route, activity: job.activity, state: job.state, startedAt: job.startedAt,
          lastActivityAt: job.lastActivityAt ?? job.startedAt ?? job.createdAt,
          activityLine: job.activityLine ?? '', stalled: job.stalled === true,
        }));
      const text = JSON.stringify(jobs);
      // The mod ignores a snapshot older than 60 seconds, so a live list is rewritten every 30 seconds even when nothing in it changed.
      if (text === this.written && (jobs.length === 0 || now - this.writtenAt < REFRESH_MS)) return;
      atomicWrite(join(this.home, 'jobs-live.json'), JSON.stringify({ updatedAt: now, stallMinutes: this.stallMinutes(), jobs }) + '\n');
      this.written = text; this.writtenAt = now;
    } catch { this.log(JOBS_LIVE_TEXT.writeFailed); }
  }
}
