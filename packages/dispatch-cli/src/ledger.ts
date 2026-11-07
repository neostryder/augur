import { call, watchLedger } from '@augur/augurd/client';
import type { ClientOptions, LedgerWatch } from '@augur/augurd/client';
import { LEDGER_STATES, ledgerDate, ledgerDuration, ledgerTerminal } from '@augur/dispatch-protocol';
import type { LedgerJob, LedgerPage, LedgerQuery, LedgerState } from '@augur/dispatch-protocol';

const clean = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const clip = (text: string, width: number): string => {
  const chars = Array.from(clean(text));
  return chars.length <= width ? chars.join('') : width < 4 ? chars.slice(0, width).join('') : chars.slice(0, width - 3).join('') + '...';
};

const wrap = (text: string, width: number): string[] => {
  const lines: string[] = [];
  while (text.length > width) { const end = text.lastIndexOf(' ', width); const at = end > 0 ? end : width; lines.push(text.slice(0, at)); text = text.slice(at).trimStart(); }
  return [...lines, text];
};

export function renderJobs(page: LedgerPage, counts: Record<LedgerState, number>, width = 160, now = Date.now()): string {
  const columns = Math.max(20, Number.isFinite(width) ? Math.floor(width) : 160);
  const full = columns >= 150;
  const sizes = [9, 11, 12, 16, Math.max(12, columns - 144), 20, 8, 20, 14, 16];
  const row = (fields: string[]) => fields.map((f, i) => clip(f, sizes[i]!).padEnd(sizes[i]!)).join(' ').trimEnd();
  const date = (at: number | null) => at === null ? '-' : ledgerDate(at).slice(0, 19) + 'Z';
  const lines = page.jobs.flatMap(j => {
    const who = j.stamp.sessionTitle || j.stamp.originLabel || j.stamp.origin || '-';
    const activity = !ledgerTerminal(j.state) ? j.activityLine ?? '' : '';
    if (!full) return [
      clip(`${j.state.toUpperCase()}  ${j.kind}  ${j.node}`, columns),
      clip(`  ${j.id}`, columns),
      clip(`  ${clip(who, Math.min(16, Math.floor(columns / 3)))}  ${j.summary || '-'}`, columns),
      clip(`  Started ${ledgerDate(j.startedAt)}`, columns),
      clip(`  Time ${ledgerDuration(j, now)}`, columns),
      clip(`  Ended ${ledgerDate(j.endedAt)}`, columns),
      clip(`  Route/model ${j.route || j.model || '-'}`, columns),
      ...(j.replayOf ? [clip(`  replay of ${j.replayOf}`, columns)] : []),
      ...(activity ? [clip(`  ${activity}`, columns)] : []),
    ];
    const fields = [j.state.toUpperCase(), j.kind, j.node, who, j.summary || '-', date(j.startedAt), ledgerDuration(j, now), date(j.endedAt), j.route || j.model || '-', activity];
    return [row(fields), clip(`  ${j.id}${j.replayOf ? `  replay of ${j.replayOf}` : ''}`, columns)];
  });
  const header = full ? row(['STATE', 'KIND', 'NODE', 'SESSION/ORIGIN', 'SUMMARY', 'STARTED', 'TIME', 'ENDED', 'ROUTE/MODEL', 'ACTIVITY']) : 'Jobs';
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return [clip(header, columns), ...(lines.length ? lines : ['No jobs.']), ...wrap(`${page.jobs.length} shown, ${total} matching. ${LEDGER_STATES.map(s => `${s}: ${counts[s]}`).join(', ')}`, columns), ...(page.next ? ['Next page:', ...Array.from({ length: Math.ceil((`--page ${page.next}`).length / columns) }, (_, i) => (`--page ${page.next}`).slice(i * columns, (i + 1) * columns))] : [])].join('\n');
}

export async function executionId(id: string, opts: ClientOptions): Promise<string> {
  if (!id.includes(':')) return id;
  const chain = await call('ledger_get', { id }, opts);
  if (chain?.job.kind === 'augur-job') return chain.job.localId;
  throw new Error(`Job ${id} is not a local execution job. This command requires a local Augur job id.`);
}

interface WatchIo { out(text: string): void; err(text: string): void; width?: number; signal?: AbortSignal; tty?: boolean; page?(page: LedgerPage): LedgerPage }
interface WatchDeps { call: typeof call; watch: typeof watchLedger; retryMs?: number; tickMs?: number }

export async function watchJobs(query: LedgerQuery, io: WatchIo, opts: ClientOptions, json: boolean, deps: WatchDeps = { call, watch: watchLedger }): Promise<void> {
  const controller = new AbortController(), signal = io.signal ?? controller.signal;
  const stop = () => controller.abort();
  if (!io.signal) process.once('SIGINT', stop);
  let cursor = '0', connection: LedgerWatch | undefined, retry: ReturnType<typeof setTimeout> | undefined;
  let drawing = false, dirty = false, first = true;
  const draw = async () => {
    if (signal.aborted) return;
    if (drawing) { dirty = true; return; }
    drawing = true;
    try {
      do {
        dirty = false;
        const [page, counts] = await Promise.all([deps.call('ledger_list', query, opts), deps.call('ledger_counts', query, opts)]);
        if (!signal.aborted) {
          const result = io.page?.(page) ?? page;
          io.out(json ? JSON.stringify({ ...result, counts, cursor }) + '\n' : `${io.tty ? '\x1b[H\x1b[2J' : ''}${renderJobs(result, counts, io.width)}\n`);
          first = false;
        }
      } while (dirty && !signal.aborted);
    } finally { drawing = false; }
  };
  const schedule = () => {
    if (signal.aborted || retry) return;
    retry = setTimeout(() => { retry = undefined; void connect(); }, deps.retryMs ?? 1000);
    const previous = connection; connection = undefined; previous?.close();
  };
  const connect = async () => {
    if (signal.aborted) return;
    try {
      // Replay before the snapshot so changes during the snapshot are replayed on the watch.
      let more = true;
      while (more && !signal.aborted) {
        const page = await deps.call('ledger_changes', { since: cursor, limit: 1000 }, opts);
        cursor = page.cursor; more = page.more;
      }
      await draw();
      if (signal.aborted) return;
      const opened = await deps.watch(cursor, {
        change: change => { cursor = change.cursor; void draw().catch(() => schedule()); },
        closed: () => { connection = undefined; schedule(); },
      }, opts);
      if (signal.aborted) opened.close(); else connection = opened;
    } catch (error) {
      if (!signal.aborted && first) io.err(`${(error as Error).message}\n`);
      schedule();
    }
  };
  const tick = setInterval(() => { if (connection) void draw().catch(() => schedule()); }, deps.tickMs ?? 1000);
  try {
    await new Promise<void>(resolve => {
      const finish = () => { if (retry) clearTimeout(retry); connection?.close(); resolve(); };
      if (signal.aborted) { finish(); return; }
      signal.addEventListener('abort', finish, { once: true });
      void connect();
    });
  } finally {
    clearInterval(tick);
    if (retry) clearTimeout(retry);
    if (!io.signal) process.removeListener('SIGINT', stop);
  }
}
