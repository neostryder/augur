// Times, money and severity in words, as every view shows them.
import { calculatePace, type HistoryRow, type Meter, type PaceResult } from '@augur/core';

export const sevOf = (p: number): '' | 'warn' | 'crit' => (p >= 90 ? 'crit' : p >= 75 ? 'warn' : '');

export function until(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'Resetting now';
  return `Resets in ${span(ms)}, ${when(iso, ms)}`;
}

export function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`;
}

export function when(iso: string | number | Date, msAhead?: number): string {
  const t = new Date(iso);
  const ahead = msAhead ?? t.getTime() - Date.now();
  const opts: Intl.DateTimeFormatOptions = ahead > 20 * 3600e3 ? { weekday: 'short', hour: 'numeric', minute: '2-digit' } : { hour: 'numeric', minute: '2-digit' };
  return t.toLocaleString([], opts);
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}

/** The short age an alert list shows: now, 5m, 3h, 2d. */
export function shortAgo(iso: string, now: Date = new Date()): string {
  const min = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60000));
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

export function money(v: number | null | undefined, cur = 'USD'): string {
  if (v == null || !Number.isFinite(v)) return '-';
  const n = v.toLocaleString([], { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cur === 'USD' ? `$${n}` : `${n} ${cur}`;
}

/** One meter's readings over time, as [time in ms, percent used]. */
export function series(rows: HistoryRow[], providerId: string, meterId: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const r of rows) {
    const p = r[providerId];
    const v = typeof p === 'object' ? p[meterId] : undefined;
    if (typeof v === 'number') out.push([new Date(r.t).getTime(), v]);
  }
  return out;
}

export function pace(meter: Meter, rows: HistoryRow[], providerId: string, now = new Date()): PaceResult | null {
  if (meter.usedPct == null || !meter.resetsAt || !meter.windowSeconds) return null;
  try { return calculatePace(meter, rows, providerId, now); } catch { return null; }
}
