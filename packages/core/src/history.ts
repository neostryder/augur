import type { Snapshot } from './types.js';

export type HistoryRow = { t: string } & Record<string, string | Record<string, number>>;

/** Rows closer together than this are folded into one, so a short refresh interval cannot swell the history. */
export const HISTORY_ROW_SECONDS = 300;

export function appendHistory(rows: HistoryRow[], snapshot: Snapshot, keepSeconds = 7 * 86400, rowSeconds = HISTORY_ROW_SECONDS): HistoryRow[] {
  const next: HistoryRow = { t: snapshot.generatedAt };
  for (const [id, provider] of Object.entries(snapshot.providers)) {
    if (!provider.ok) continue;
    const values: Record<string, number> = {};
    for (const meter of provider.meters) if (meter.usedPct !== null) values[meter.id] = meter.usedPct;
    for (const money of provider.money) if (money.amount !== null) values[`$${money.id}`] = money.amount;
    next[id] = values;
  }
  const now = Date.parse(snapshot.generatedAt);
  const cutoff = now - keepSeconds * 1000;
  // The newest row keeps moving forward with each reading until it is a full row apart from the one before it.
  // A provider missing from this reading keeps its value from the row being replaced.
  const last = rows.at(-1), before = rows.at(-2);
  const fold = !!last && !!before && now - Date.parse(before.t) < rowSeconds * 1000;
  const kept = fold ? rows.slice(0, -1) : rows;
  return [...kept, fold ? { ...last, ...next } : next].filter(row => Date.parse(row.t) >= cutoff);
}

export function meterSeries(rows: HistoryRow[], providerId: string, meterId: string): Array<{ t: string; value: number }> {
  return rows.flatMap(row => {
    const values = row[providerId];
    const value = typeof values === 'object' ? values[meterId] : undefined;
    return typeof value === 'number' && Number.isFinite(value) ? [{ t: row.t, value }] : [];
  });
}
