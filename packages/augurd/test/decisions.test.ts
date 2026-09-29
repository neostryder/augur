import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecisionLog } from '../src/decisions.js';
import { ROUTES, makeEnv, request, submitOk, terminal } from './harness.js';
import type { Env } from './harness.js';

vi.setConfig({ testTimeout: 90000 });
const dirs: string[] = [];
const envs: Env[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); while (envs.length) envs.pop()!.dispose(); });
const rows = (dir: string) => readFileSync(join(dir, 'decisions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'decisions-')); dirs.push(d); return d; };

describe('the decision record', () => {
  it('keeps task text only when learning is on and the tier is public or internal', () => {
    const dir = tmp();
    const on = new DecisionLog(dir, { recordTasks: true }), off = new DecisionLog(dir, { recordTasks: false });
    const base = { session: 's', activity: 'write_code', pick: 'a/b', ranking: [{ model: 'a/b' }], named: null };
    on.pick({ ...base, task: 'fix the build', dataTier: 'internal' });
    on.pick({ ...base, task: 'read the payroll file', dataTier: 'sensitive' });
    on.pick({ ...base, task: 'grade the rubric for the section 4 students', dataTier: 'internal' });
    off.pick({ ...base, task: 'fix the build', dataTier: 'internal' });
    expect(rows(dir).map(r => r.task)).toEqual(['fix the build', undefined, undefined, undefined]);
  });

  it('ties a job to the latest pick in its session, notes an override, and records the outcome', () => {
    const dir = tmp();
    let t = 1000;
    const log = new DecisionLog(dir, { recordTasks: false }, () => t);
    const id = log.pick({ session: 's', activity: 'research', dataTier: 'internal', pick: 'a/b', ranking: [{ model: 'a/b' }], named: null });
    expect(log.linkJob('s', 'a/b', 'j1')).toBe(id);
    expect(log.linkJob('s', 'c/d', 'j2')).toBe(id);
    expect(log.linkJob('other', 'a/b', 'j3')).toBeNull();
    t += 2 * 3600_000;
    expect(log.linkJob('s', 'a/b', 'j4')).toBeNull();
    log.outcome('j1', 'a/b', 'completed', null, 900);
    const [, j1, j2, out] = rows(dir);
    expect(j1).toMatchObject({ kind: 'job', pick: id, overridden: false });
    expect(j2).toMatchObject({ kind: 'job', overridden: true });
    expect(out).toMatchObject({ kind: 'outcome', job: 'j1', pick: id, state: 'completed' });
  });

  it('records a pick made through the service and the outcome of the job that follows', async () => {
    const e = makeEnv(); envs.push(e);
    (e.sup as unknown as { d: { decisions: DecisionLog } }).d.decisions = new DecisionLog(e.dir, { recordTasks: true });
    const pick = await e.sup.pick({ activity: 'write_code', dataTier: 'internal', session: 'sx' });
    if ('error' in pick) throw new Error(pick.error);
    expect(pick.pickId).toMatch(/^[0-9a-f]{12}$/);
    const route = Object.entries(ROUTES).find(([, r]) => r.model === pick.pick)?.[0] ?? 'fake';
    const id = submitOk(e.sup, request({ route, text: 'SLEEP 0', cwd: e.root, caller: { kind: 'other', label: 't', session: 'sx' } }));
    await terminal(e.sup, e.store, id);
    const kinds = rows(e.dir).map(r => r.kind);
    expect(kinds).toEqual(['pick', 'job', 'outcome']);
  });
});
