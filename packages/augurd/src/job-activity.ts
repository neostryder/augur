// What counts as a job being active, for the inactivity limit. A job that prints nothing until it exits still works, so output alone is not enough:
// the runner also looks at the CPU time and I/O of the job's process tree, and at new processes starting in it. Erasable TypeScript only.

/** One look at a job's process tree. */
export interface TreeSample { cpuMs: number; io: number; pids: ReadonlySet<number>; started: number }

export interface ProcessRow { pid: number; ppid: number; cpuMs: number; io: number }

/** The relative CPU threshold filters out idle timers during normal looks. */
export const ACTIVE_CPU_SHARE = 0.02;
/** Scheduler ticks can exceed the CPU share in short looks, so idle timers need an absolute floor. */
export const ACTIVE_CPU_MS = 50;
/** A tree that moved at least this many bytes between two looks is working. */
export const ACTIVE_IO_BYTES = 65536;

/** The rows that descend from `root`, the root included, summed into one sample. */
export function sampleTree(rows: ProcessRow[], root: number): TreeSample {
  const known = new Set<number>([root]);
  for (let grew = true; grew;) { grew = false; for (const r of rows) if (!known.has(r.pid) && known.has(r.ppid)) { known.add(r.pid); grew = true; } }
  let cpuMs = 0, io = 0;
  const pids = new Set<number>();
  for (const r of rows) if (known.has(r.pid)) { cpuMs += r.cpuMs; io += r.io; pids.add(r.pid); }
  return { cpuMs, io, pids, started: 0 };
}

/** Whether the tree did work between two looks `elapsedMs` apart. A new process in the tree counts as work, since a shell loop of short commands never raises the sum. */
export function wasActive(before: TreeSample, after: TreeSample, elapsedMs: number): boolean {
  if (after.started > before.started || [...after.pids].some(p => !before.pids.has(p))) return true;
  return after.cpuMs - before.cpuMs >= Math.max(ACTIVE_CPU_MS, ACTIVE_CPU_SHARE * elapsedMs) || after.io - before.io >= ACTIVE_IO_BYTES;
}

/** `ps -o time=` output: `[[dd-]hh:]mm:ss`, with fractions on macOS. Returns milliseconds, or null when it is not a time. */
export function parsePsTime(text: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!m) return null;
  return Math.round((Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4])) * 1000);
}

/** The rows of `ps -A -o pid=,ppid=,time=`. */
export function parsePsRows(text: string): ProcessRow[] {
  return text.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    const cpuMs = m ? parsePsTime(m[3] as string) : null;
    return m && cpuMs !== null ? [{ pid: Number(m[1]), ppid: Number(m[2]), cpuMs, io: 0 }] : [];
  });
}

/** The job host writes `cpu-100ns io-bytes processes-started`: the totals for every process that has run in the job. */
export function parseJobAccounting(text: string): TreeSample | null {
  const m = /^\s*(\d+) (\d+) (\d+)\s*$/.exec(text);
  return m ? { cpuMs: Math.round(Number(m[1]) / 10000), io: Number(m[2]), pids: new Set<number>(), started: Number(m[3]) } : null;
}

/** How often the runner looks: a quarter of the limit, at most every 15 seconds and at least twice a second. */
export function lookEveryMs(limitS: number): number {
  return Math.max(500, Math.min(15000, Math.round(limitS * 250)));
}
