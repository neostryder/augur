import type { Meter, Snapshot } from './types.js';

export interface ResetEvent {
  v: 1;
  id: string;
  kind: 'reset' | 'credits';
  provider: string;
  meter: string;
  label: string;
  at: string;
  since: string;
  usedBefore: number;
  usedAfter: number;
  resetsAtBefore: string | null;
  resetsAtAfter: string | null;
  windowSeconds: number | null;
  scheduled: boolean;
  earlySeconds: number;
  atLimit: boolean;
  creditsBefore: number | null;
  creditsAfter: number | null;
  status: string | null;
  plan: string | null;
}

export type ResetSample = 'none' | 'small' | 'enough';
export interface ResetMeterSummary {
  provider: string;
  meter: string;
  label: string;
  count: number;
  scheduled: number;
  early: number;
  atLimit: number;
  creditRises: number;
  creditFalls: number;
  medianGapHours: number | null;
  minGapHours: number | null;
  maxGapHours: number | null;
  averageEarlyHours: number | null;
  hours: number[];
  weekdays: number[];
  firstAt: string;
  lastAt: string;
  sample: ResetSample;
  lines: string[];
}
export interface ResetSummary { rows: number; meters: ResetMeterSummary[] }
export interface ResetPattern {
  count: number;
  early: number;
  atLimit: number;
  medianGapHours: number | null;
  lastAt: string;
  sample: ResetSample;
}

const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const time = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const window = (meter: Meter): boolean => (meter.windowKind === 'weekly' || meter.windowKind === 'session') && !meter.id.includes('scoped');
const sample = (count: number): ResetSample => count === 0 ? 'none' : count < 10 ? 'small' : 'enough';

export function detectResets(prev: Snapshot | null, next: Snapshot): ResetEvent[] {
  const events: ResetEvent[] = [];
  if (!prev) return events;
  for (const [id, after] of Object.entries(next.providers)) {
    const before = prev.providers[id];
    if (!before?.ok || before.stale || !after.ok || after.stale || !time(before.fetchedAt) || !time(after.fetchedAt)
      || Date.parse(after.fetchedAt) <= Date.parse(before.fetchedAt)) continue;
    const pairs = after.meters.filter(window).flatMap(meter => {
      const old = before.meters.find(m => m.id === meter.id && window(m));
      return old && numeric(old.usedPct) && numeric(meter.usedPct) ? [{ before: old, after: meter }] : [];
    });
    const creditsBefore = numeric(before.notes?.resets_available) ? before.notes.resets_available : null;
    const creditsAfter = numeric(after.notes?.resets_available) ? after.notes.resets_available : null;
    const make = (old: Meter, meter: Meter, kind: ResetEvent['kind']): ResetEvent => {
      const reset = time(old.resetsAt) ? Date.parse(old.resetsAt) : null;
      const scheduled = kind === 'reset' && reset !== null && reset <= Date.parse(after.fetchedAt!) + 300_000;
      return {
        v: 1, id: `${id}.${meter.id}.${after.fetchedAt}`, kind, provider: id, meter: meter.id, label: meter.label,
        at: after.fetchedAt!, since: before.fetchedAt!, usedBefore: old.usedPct!, usedAfter: meter.usedPct!,
        resetsAtBefore: time(old.resetsAt) ? old.resetsAt : null, resetsAtAfter: time(meter.resetsAt) ? meter.resetsAt : null,
        windowSeconds: numeric(meter.windowSeconds) ? meter.windowSeconds : null,
        scheduled, earlySeconds: kind === 'reset' && !scheduled && reset !== null ? Math.max(0, (reset - Date.parse(after.fetchedAt!)) / 1000) : 0,
        atLimit: kind === 'reset' && (old.usedPct! >= 98 || before.notes?.limit_reached === true || after.notes?.limit_reached === true),
        creditsBefore, creditsAfter, status: after.status?.indicator ?? null, plan: after.plan ?? null,
      };
    };
    const resets = pairs.filter(p => p.before.usedPct! - p.after.usedPct! >= 2 && p.after.usedPct! <= p.before.usedPct! / 2);
    events.push(...resets.map(p => make(p.before, p.after, 'reset')));
    if (!resets.length && creditsBefore !== null && creditsAfter !== null && creditsBefore !== creditsAfter) {
      const mostUsed = pairs.sort((a, b) => b.before.usedPct! - a.before.usedPct!)[0];
      if (mostUsed) events.push(make(mostUsed.before, mostUsed.after, 'credits'));
    }
  }
  return events;
}

export function serializeResets(events: ResetEvent[]): string {
  return events.map(event => JSON.stringify(event) + '\n').join('');
}

function isResetEvent(row: unknown): row is ResetEvent {
  if (!row || typeof row !== 'object') return false;
  const r = row as Record<string, unknown>;
  return r.v === 1 && (r.kind === 'reset' || r.kind === 'credits')
    && ['id', 'provider', 'meter', 'label'].every(key => typeof r[key] === 'string' && r[key] !== '')
    && time(r.at) && time(r.since) && r.id === `${r.provider}.${r.meter}.${r.at}`
    && ['usedBefore', 'usedAfter', 'earlySeconds'].every(key => numeric(r[key]))
    && ['scheduled', 'atLimit'].every(key => typeof r[key] === 'boolean')
    && ['resetsAtBefore', 'resetsAtAfter'].every(key => r[key] === null || time(r[key]))
    && ['windowSeconds', 'creditsBefore', 'creditsAfter'].every(key => r[key] === null || numeric(r[key]))
    && ['status', 'plan'].every(key => r[key] === null || typeof r[key] === 'string');
}

export function parseResetLog(text: string): ResetEvent[] {
  const rows = new Map<string, ResetEvent>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const row: unknown = JSON.parse(line); if (isResetEvent(row) && !rows.has(row.id)) rows.set(row.id, row); }
    catch { /* A partial last write must not hide earlier readings. */ }
  }
  return [...rows.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function summarizeResets(events: ResetEvent[], options: { now: Date; utcOffsetMinutes: number }): ResetSummary {
  const rows = parseResetLog(serializeResets(events)).filter(row => Date.parse(row.at) <= options.now.getTime());
  const groups = new Map<string, ResetEvent[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.provider, row.meter]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  const meters = [...groups.values()].map(group => {
    const resets = group.filter(row => row.kind === 'reset'), first = group[0]!, last = group.at(-1)!;
    const gaps = resets.slice(1).map((row, i) => (Date.parse(row.at) - Date.parse(resets[i]!.at)) / 3600000).sort((a, b) => a - b);
    const middle = Math.floor(gaps.length / 2);
    const early = resets.filter(row => !row.scheduled);
    const hours = Array<number>(24).fill(0), weekdays = Array<number>(7).fill(0);
    for (const row of resets) {
      const at = new Date(Date.parse(row.at) + options.utcOffsetMinutes * 60000);
      hours[at.getUTCHours()]!++;
      weekdays[at.getUTCDay()]!++;
    }
    const creditRises = group.filter(row => row.creditsBefore !== null && row.creditsAfter !== null && row.creditsAfter > row.creditsBefore).length;
    const creditFalls = group.filter(row => row.creditsBefore !== null && row.creditsAfter !== null && row.creditsAfter < row.creditsBefore).length;
    const count = resets.length, scheduled = count - early.length, atLimit = resets.filter(row => row.atLimit).length;
    return {
      provider: first.provider, meter: first.meter, label: last.label, count, scheduled, early: early.length, atLimit, creditRises, creditFalls,
      medianGapHours: gaps.length ? (gaps.length % 2 ? gaps[middle]! : (gaps[middle - 1]! + gaps[middle]!) / 2) : null,
      minGapHours: gaps[0] ?? null, maxGapHours: gaps.at(-1) ?? null,
      averageEarlyHours: early.length ? early.reduce((sum, row) => sum + row.earlySeconds, 0) / early.length / 3600 : null,
      hours, weekdays, firstAt: first.at, lastAt: last.at, sample: sample(count),
      lines: [`${count} resets recorded: ${scheduled} scheduled, ${early.length} early, and ${atLimit} at the limit.`,
        `${creditRises} credit rises and ${creditFalls} credit falls recorded.`,
        count === 0 ? 'No resets recorded.' : count < 10 ? `Small sample: ${count} resets; fewer than 10 recorded.` : `Sample: ${count} resets recorded.`],
    };
  });
  return { rows: rows.length, meters };
}

/** The caller supplies one provider's ledger, since the compact note carries no provider id. */
export function resetPattern(events: ResetEvent[], now: Date): ResetPattern | null {
  const weekly = events.filter(row => row.windowSeconds === 604800);
  const summaries = summarizeResets(weekly, { now, utcOffsetMinutes: 0 }).meters;
  // The main usage window keeps review and scoped readings out of the compact note.
  const summary = summaries.find(row => row.meter === 'plan_weekly' || row.meter === 'weekly_all' || row.meter === 'seven_day') ?? summaries[0];
  if (!summary) return null;
  const { count, early, atLimit, medianGapHours, lastAt, sample } = summary;
  return { count, early, atLimit, medianGapHours, lastAt, sample };
}
