// The daily balance report as files: a JSON copy for tools and a plain text copy to read. One pair a day, never overwritten.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
