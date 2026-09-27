import type { Meter } from './types.js';
import type { HistoryRow } from './history.js';
import { meterSeries } from './history.js';

export interface PaceResult {
  burnRatio: number | null;
  projectedExhaustAt: string | null;
  willExhaustBeforeReset: boolean;
  ratePctPerHour: number | null;
}

export function calculatePace(meter: Meter, rows: HistoryRow[], providerId: string, at = new Date()): PaceResult {
  const empty: PaceResult = { burnRatio: null, projectedExhaustAt: null, willExhaustBeforeReset: false, ratePctPerHour: null };
  if (meter.usedPct === null || !meter.resetsAt || !meter.windowSeconds || meter.windowSeconds <= 0) return empty;
  const now = at.getTime(), end = Date.parse(meter.resetsAt), start = end - meter.windowSeconds * 1000;
  if (!Number.isFinite(end) || now < start || now >= end) return empty;
  const elapsed = Math.min(1, Math.max(0, (now - start) / (end - start)));
  const remainingTime = Math.max(0, 1 - elapsed), remainingUsage = Math.min(1, Math.max(0, (100 - meter.usedPct) / 100));
  const burnRatio = remainingTime < 0.0001 ? null : remainingUsage / remainingTime;
  const recentStart = Math.max(start, now - 4 * 3600000);
  const points = meterSeries(rows, providerId, meter.id).filter(point => {
    const t = Date.parse(point.t); return t >= recentStart && t <= now;
  });
  let rate: number | null = null;
  if (points.length >= 2) {
    const xs = points.map(point => (Date.parse(point.t) - start) / 3600000);
    const ys = points.map(point => point.value);
    const xMean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
    const denominator = xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0);
    if (denominator > 0) rate = xs.reduce((sum, x, i) => sum + (x - xMean) * (ys[i]! - yMean), 0) / denominator;
  }
  if (rate === null && elapsed > 0) rate = meter.usedPct / (elapsed * meter.windowSeconds / 3600);
  const projection = rate !== null && rate > 0 ? new Date(now + (100 - meter.usedPct) / rate * 3600000) : null;
  return { burnRatio, projectedExhaustAt: projection && Number.isFinite(projection.getTime()) ? projection.toISOString() : null,
    willExhaustBeforeReset: !!projection && projection.getTime() < end, ratePctPerHour: rate };
}
