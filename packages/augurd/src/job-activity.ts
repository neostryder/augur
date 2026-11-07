// What counts as a job being active, for the inactivity limit. A job that prints nothing until it exits still works, so output alone is not enough:
// the runner also looks at the CPU time and I/O of the job's process tree, and at new processes starting in it. Erasable TypeScript only.

/** One look at a job's process tree. */
export interface TreeSample { cpuMs: number; io: number; pids: ReadonlySet<number> }

export interface ProcessRow { pid: number; ppid: number; cpuMs: number; io: number }

/** A tree whose CPU grew by at least this share of the time between two looks is working. Idle timers stay far below it. */
export const ACTIVE_CPU_SHARE = 0.02;
/** A tree that moved at least this many bytes between two looks is working. */
export const ACTIVE_IO_BYTES = 65536;

/** The rows that descend from `root`, the root included, summed into one sample. */
export function sampleTree(rows: ProcessRow[], root: number): TreeSample {
  const known = new Set<number>([root]);
  for (let grew = true; grew;) { grew = false; for (const r of rows) if (!known.has(r.pid) && known.has(r.ppid)) { known.add(r.pid); grew = true; } }
  let cpuMs = 0, io = 0;
  const pids = new Set<number>();
  for (const r of rows) if (known.has(r.pid)) { cpuMs += r.cpuMs; io += r.io; pids.add(r.pid); }
  return { cpuMs, io, pids };
}

/** Whether the tree did work between two looks `elapsedMs` apart. A new process in the tree counts as work, since a shell loop of short commands never raises the sum. */
export function wasActive(before: TreeSample, after: TreeSample, elapsedMs: number): boolean {
  if ([...after.pids].some(p => !before.pids.has(p))) return true;
  return after.cpuMs - before.cpuMs >= ACTIVE_CPU_SHARE * elapsedMs || after.io - before.io >= ACTIVE_IO_BYTES;
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

/** The Windows script prints `pid ppid cpu-100ns io-bytes` for each process. */
export const WINDOWS_PROCESS_SCRIPT = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, ([uint64]$_.KernelModeTime + [uint64]$_.UserModeTime), ([uint64]$_.ReadTransferCount + [uint64]$_.WriteTransferCount) }";

export function parseWindowsRows(text: string): ProcessRow[] {
  return text.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), cpuMs: Math.round(Number(m[3]) / 10000), io: Number(m[4]) }] : [];
  });
}

/** How often the runner looks: a quarter of the limit, at most every 15 seconds and at least twice a second. */
export function lookEveryMs(limitS: number): number {
  return Math.max(500, Math.min(15000, Math.round(limitS * 250)));
}
