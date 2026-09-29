// Writes training rows for the Laya trainer from a decision record.  node export-training.ts <decisions.jsonl> <out.jsonl>
import { readFileSync, writeFileSync } from 'node:fs';
import { trainingRows } from '@augur/decision';
import type { DecisionRow } from '@augur/decision';

const [from, to] = process.argv.slice(2);
if (!from || !to) { console.error('usage: export-training.ts <decisions.jsonl> <out.jsonl>'); process.exit(2); }
const records = readFileSync(from, 'utf8').split('\n').filter(l => l.trim()).flatMap(l => { try { return [JSON.parse(l) as DecisionRow]; } catch { return []; } });
const rows = trainingRows(records);
writeFileSync(to, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
const by: Record<string, number> = {};
for (const r of rows) by[r.pilot] = (by[r.pilot] ?? 0) + 1;
console.log(JSON.stringify({ records: records.length, rows: rows.length, byPilot: by }));
