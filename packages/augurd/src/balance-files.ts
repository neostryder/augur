// The daily balance report as files: a JSON copy for tools and a plain text copy to read. One pair a day, never overwritten.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderReport } from '@augur/dispatch-protocol';
import type { BalanceReport } from '@augur/dispatch-protocol';

/** Writes `balance/<date>.json` and `.txt` under `home` unless today's pair exists. Returns the JSON path when it wrote one. */
export function writeDailyReport(home: string, report: BalanceReport, now: Date): string | null {
  const dir = join(home, 'balance'), day = now.toISOString().slice(0, 10), json = join(dir, `${day}.json`);
  if (existsSync(json)) return null;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${day}.txt`), renderReport(report).join('\n') + '\n');
  writeFileSync(json, JSON.stringify(report, null, 2) + '\n');
  return json;
}

/** Rewrites `balance/labels.jsonl`, one line per pick with its override, job outcomes and brief check, when the lines changed. Returns whether it wrote. */
export function writeLabels(home: string, rows: ReadonlyArray<object>): boolean {
  const dir = join(home, 'balance'), file = join(dir, 'labels.jsonl'), text = rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  if (!rows.length) return false;
  try { if (existsSync(file) && readFileSync(file, 'utf8') === text) return false; } catch { /* rewrite it */ }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, text);
  return true;
}

export type GateKind = 'blocked' | 'lifted' | 'denied-automated' | 'approved' | 'ran' | 'lower-ran' | 'surplus-open' | 'surplus-close' | 'surplus-lifted' | 'released';
export interface GateEvent { at: string; kind: GateKind; label: string; provider: string; caller: string; gap: number | null; pickId?: string | null; jobId?: string | null; cost?: number | null; estimatePoints?: number; activity?: string; scope?: string; note?: string; hoursLeft?: number | null; unused?: number; budgetLeft?: number; itemId?: string }

export function appendGate(home: string, event: GateEvent): void {
  mkdirSync(home, { recursive: true });
  appendFileSync(join(home, 'gate-ledger.jsonl'), JSON.stringify(event) + '\n');
}

export function readGate(home: string): GateEvent[] {
  try { return readFileSync(join(home, 'gate-ledger.jsonl'), 'utf8').split('\n').flatMap(line => { if (!line) return []; try { return [JSON.parse(line) as GateEvent]; } catch { return []; } }); } catch { return []; }
}

export function gateTotals(rows: readonly GateEvent[]): { counts: Record<string, number>; costs: Record<string, { premium: number; lower: number }> } {
  const counts: Record<string, number> = {}, costs: Record<string, { premium: number; lower: number }> = {};
  for (const row of rows) {
    counts[row.kind] = (counts[row.kind] ?? 0) + 1;
    if ((row.kind !== 'ran' && row.kind !== 'lower-ran') || typeof row.cost !== 'number') continue;
    const activity = row.activity ?? 'unknown', item = costs[activity] ??= { premium: 0, lower: 0 };
    if (row.kind === 'ran') item.premium += row.cost; else item.lower += row.cost;
  }
  return { counts, costs };
}
