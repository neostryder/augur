import { join } from 'node:path';
import { atomicWrite, readText } from './home-files.js';
import type { Supervisor } from './supervisor.js';

export const CANCEL_FILE = 'cancel-requests.jsonl';
export const CANCEL_TEXT = { applied: (id: string) => `Cancelled job ${id} at the request of the jobs pane.`, failed: 'Could not apply cancel-requests.jsonl; the service keeps running.' } as const;

const CHECK_MS = 1000;
/** A request older than this is ignored, so a line left behind by a closed session never cancels anything later. */
const MAX_AGE_MS = 10 * 60_000;
const MAX_IDS = 50;
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The job ids named by fresh, well-formed lines of `{"id","at"}`. Anything else in the file is skipped. */
export function parseCancelRequests(text: string, now: number): string[] {
  const ids = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { id?: unknown; at?: unknown };
      const at = typeof row.at === 'string' ? Date.parse(row.at) : NaN;
      if (typeof row.id === 'string' && JOB_ID.test(row.id) && Number.isFinite(at) && now - at <= MAX_AGE_MS && at - now <= MAX_AGE_MS) ids.add(row.id);
    } catch { /* a damaged line is skipped */ }
    if (ids.size >= MAX_IDS) break;
  }
  return [...ids];
}

/** Applies cancel requests that the Claude Code jobs pane appends to cancel-requests.jsonl in the Augur home. */
export class CancelRequests {
  private checkedAt = -Infinity;

  constructor(private home: string, private supervisor: Pick<Supervisor, 'cancel'>, private log: (message: string) => void, private now = Date.now) {}

  tick(): void {
    const now = this.now();
    if (now >= this.checkedAt && now - this.checkedAt < CHECK_MS) return;
    this.checkedAt = now;
    const path = join(this.home, CANCEL_FILE);
    try {
      const text = readText(path);
      if (!text || !text.trim()) return;
      for (const id of parseCancelRequests(text, now)) {
        try { if (this.supervisor.cancel(id)?.ok) this.log(CANCEL_TEXT.applied(id)); } catch { this.log(CANCEL_TEXT.failed); }
      }
      // Every line is applied now. The file is emptied only if the pane has not added a line since it was read.
      if (readText(path) === text) atomicWrite(path, '');
    } catch { this.log(CANCEL_TEXT.failed); }
  }
}
