import type { Snapshot } from './types.js';

export type HistoryRow = { t: string } & Record<string, string | Record<string, number>>;

export function appendHistory(rows: HistoryRow[], snapshot: Snapshot, keepSeconds = 7 * 86400): HistoryRow[] {
  const next: HistoryRow = { t: snapshot.generatedAt };
  for (const [id, provider] of Object.entries(snapshot.providers)) {
    if (!provider.ok) continue;
    const values: Record<string, number> = {};
    for (const meter of provider.meters) if (meter.usedPct !== null) values[meter.id] = meter.usedPct;
    for (const money of provider.money) if (money.amount !== null) values[`$${money.id}`] = money.amount;
    next[id] = values;
  }
  const cutoff = Date.parse(snapshot.generatedAt) - keepSeconds * 1000;
  return [...rows, next].filter(row => Date.parse(row.t) >= cutoff);
}

export function meterSeries(rows: HistoryRow[], providerId: string, meterId: string): Array<{ t: string; value: number }> {
  return rows.flatMap(row => {
    const values = row[providerId];
    const value = typeof values === 'object' ? values[meterId] : undefined;
    return typeof value === 'number' && Number.isFinite(value) ? [{ t: row.t, value }] : [];
  });
}
