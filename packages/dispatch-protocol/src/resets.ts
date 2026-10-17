import { summarizeResets, type ResetEvent, type ResetSummary } from '@augur/core';

export interface ResetQuery { provider?: string; limit?: number }
export interface ResetLedger { events: ResetEvent[]; summary: ResetSummary }

export function resetLedger(events: ResetEvent[], query: ResetQuery = {}, now = new Date()): ResetLedger {
  if (query.provider !== undefined && (typeof query.provider !== 'string' || !query.provider.trim())) throw new Error('Provider must be a nonempty id.');
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1)) throw new Error('Limit must be a positive integer.');
  const rows = events.filter(event => query.provider === undefined || event.provider === query.provider);
  const summary = summarizeResets(rows, { now, utcOffsetMinutes: -now.getTimezoneOffset() });
  return { events: [...rows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, Math.min(query.limit ?? 200, 1000)), summary };
}

export function renderResets(ledger: ResetLedger): string[] {
  const lines = ledger.summary.meters.flatMap(row => [`${row.provider}: ${row.label} (${row.meter})`, ...row.lines.map(line => `  ${line}`)]);
  if (!ledger.events.length) return [...lines, 'No reset events.'];
  lines.push('', 'Local time | UTC | Provider | Meter | Used before | Used after | Early by | Credits before | Credits after');
  for (const event of ledger.events) {
    const at = new Date(event.at);
    lines.push([at.toLocaleString('en-US', { timeZoneName: 'short' }), at.toISOString(), event.provider, event.meter,
      `${event.usedBefore}%`, `${event.usedAfter}%`, event.kind === 'credits' ? '-' : event.scheduled ? 'scheduled' : `${(event.earlySeconds / 3600).toFixed(1)} hours`,
      event.creditsBefore ?? '-', event.creditsAfter ?? '-'].join(' | '));
  }
  return lines;
}
