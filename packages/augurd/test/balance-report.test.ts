import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BalanceReport } from '@augur/dispatch-protocol';
import { writeDailyReport, writeLabels } from '../src/balance-files.js';
import { DecisionLog } from '../src/decisions.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'balance-')); dirs.push(d); return d; };
const report = { at: '2026-09-28T12:00:00.000Z', enabled: true, claude: { stance: 'on pace', lean: 'neither', peak: 40, reserve: 90, band: 5, atReserve: false, tracks: [] },
  copilot: { spend: 10, aim: 150, cap: 250, zone: 'under the aim' }, providers: [], mix: [], excluded: [], picks: null } as unknown as BalanceReport;

describe('the daily balance files', () => {
  it('write one JSON and one text file a day and leave the first alone', () => {
    const home = tmp(), day = new Date('2026-09-28T09:00:00Z');
    const file = writeDailyReport(home, report, day);
    expect(file).toBe(join(home, 'balance', '2026-09-28.json'));
    expect(JSON.parse(readFileSync(file!, 'utf8')).copilot.spend).toBe(10);
    expect(readFileSync(join(home, 'balance', '2026-09-28.txt'), 'utf8')).toContain('Balance report');
    writeFileSync(file!, '{"kept":true}');
    expect(writeDailyReport(home, report, new Date('2026-09-28T23:00:00Z'))).toBeNull();
    expect(readFileSync(file!, 'utf8')).toBe('{"kept":true}');
    expect(writeDailyReport(home, report, new Date('2026-09-29T00:10:00Z'))).toBe(join(home, 'balance', '2026-09-29.json'));
    expect(existsSync(join(home, 'balance', '2026-09-29.txt'))).toBe(true);
  });
});

describe('the pick log summary', () => {
  it('counts picks per activity and model and the jobs that ran on another model, inside the window', () => {
    const dir = tmp();
    let t = Date.parse('2026-09-20T00:00:00Z');
    const log = new DecisionLog(dir, { recordTasks: false }, () => t);
    const base = { session: 's', dataTier: 'internal', ranking: [], named: null };
    log.pick({ ...base, activity: 'write_code', pick: 'a/b' });
    t += 1000; log.linkJob('s', 'c/d', 'j1');
    t += 10 * 86400_000;
    log.pick({ ...base, activity: 'write_code', pick: 'a/b' });
    log.pick({ ...base, activity: 'research', pick: 'x/y' });
    t += 1000; log.linkJob('s', 'x/y', 'j2');
    expect(log.summary(7)).toEqual({ days: 7, picks: 2, jobs: 1, overrides: 0, byActivity: { write_code: { 'a/b': 1 }, research: { 'x/y': 1 } } });
    expect(log.summary(30)).toMatchObject({ picks: 3, jobs: 2, overrides: 1 });
    expect(new DecisionLog(tmp(), { recordTasks: false }).summary(7)).toMatchObject({ picks: 0, jobs: 0 });
  });

  it('keeps each Copilot pick with the month spend when it was made', () => {
    const t = Date.parse('2026-10-04T12:00:00Z');
    const log = new DecisionLog(tmp(), { recordTasks: false }, () => t);
    const base = { session: 's', dataTier: 'internal', ranking: [], named: null, activity: 'write_code' };
    log.pick({ ...base, pick: 'a/b' });
    log.pick({ ...base, pick: 'copilot/gpt-5', spend: 61.5 });
    log.pick({ ...base, pick: 'copilot/gpt-5' });
    expect(log.summary(7).copilot).toEqual([{ at: '2026-10-04T12:00:00.000Z', activity: 'write_code', model: 'copilot/gpt-5', spend: 61.5 }, { at: '2026-10-04T12:00:00.000Z', activity: 'write_code', model: 'copilot/gpt-5', spend: null }]);
    expect(log.summary(7)).toMatchObject({ picks: 3 });
  });
});

describe('the labels file', () => {
  it('records a brief check against a pick or a job and folds it into one row per pick', () => {
    const t = Date.parse('2026-10-05T01:00:00Z');
    const log = new DecisionLog(tmp(), { recordTasks: false }, () => t);
    const base = { session: 's', dataTier: 'internal', ranking: [], named: null, activity: 'research' };
    const id = log.pick({ ...base, pick: 'a/b' });
    log.linkJob('s', 'c/d', 'j1');
    expect(log.label('nope', 'met')).toEqual({ error: 'No pick or job with that id is in the decision log.' });
    expect(log.label('j1', 'missed', 'no sources')).toEqual({ ok: true, pick: id, job: 'j1' });
    expect(log.label(id, 'partly')).toEqual({ ok: true, pick: id, job: null });
    expect(log.labels()).toMatchObject([{ pick: id, model: 'a/b', used: ['c/d'], overridden: true, brief: 'partly', briefNote: null }]);
  });

  it('is written once and rewritten only when a row changed', () => {
    const home = tmp(), rows = [{ pick: 'p1', brief: null }];
    expect(writeLabels(home, [])).toBe(false);
    expect(writeLabels(home, rows)).toBe(true);
    expect(writeLabels(home, rows)).toBe(false);
    expect(readFileSync(join(home, 'balance', 'labels.jsonl'), 'utf8')).toBe('{"pick":"p1","brief":null}\n');
    expect(writeLabels(home, [{ pick: 'p1', brief: 'met' }])).toBe(true);
  });
});
