import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecisionLog } from '../src/decisions.js';
import { makeEnv } from './harness.js';
import type { Env } from './harness.js';

vi.setConfig({ testTimeout: 90000 });
const envs: Env[] = [];
afterEach(() => { while (envs.length) envs.pop()!.dispose(); });

const RUBRIC = { id: 'answer', version: 1, stakes: 'low', passAt: 0.6, dimensions: [{ id: 'correct', instructions: 'Is the answer correct?', levels: ['Wrong.', 'Partly right.', 'Right.'] }] };
const answerAt = (level: number) => async (_s: unknown, q: Record<string, unknown>) => ({ answers: Object.fromEntries(Object.keys(q).map(k => [k, { score: k.startsWith('g_') ? level * 2 : (1 - level) * 2 }])) });

function setup(recordTasks = false) {
  const e = makeEnv(); envs.push(e);
  mkdirSync(join(e.home, 'rubrics'), { recursive: true });
  writeFileSync(join(e.home, 'rubrics', 'answer.json'), JSON.stringify(RUBRIC));
  const asked: Array<{ backend: string; state: Record<string, unknown> }> = [];
  const make = (id: string, local: boolean, level: number) => ({ id, local, ask: async (s: Record<string, unknown>, q: Record<string, unknown>) => { asked.push({ backend: id, state: s }); return answerAt(level)(s, q); } });
  const d = (e.sup as unknown as { d: { decision: unknown; decisions: DecisionLog } }).d;
  d.decision = { primary: make('jev', false, 1), local: make('laya', true, 0.5) };
  d.decisions = new DecisionLog(e.dir, { recordTasks });
  const rows = () => readFileSync(join(e.dir, 'decisions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
  return { e, asked, rows };
}

describe('grading through the service', () => {
  it('grades against a rubric file, records the grade without the text, and stays in shadow', async () => {
    const { e, rows, asked } = setup();
    const r = await e.sup.grade({ rubric: 'answer', task: 'Add 2 and 2', candidate: 'It is 4', tier: 'internal' });
    if ('error' in r) throw new Error(r.error);
    expect(r).toMatchObject({ rubric: 'answer', version: 1, overall: 1, mode: 'shadow', verdict: null, backend: 'jev' });
    expect(asked[0]!.state).toEqual({ task: 'Add 2 and 2', candidate: 'It is 4' });
    const row = rows().find(x => x.kind === 'grade')!;
    expect(row).toMatchObject({ id: r.id, rubric: 'answer', tier: 'internal', mode: 'shadow' });
    expect('task' in row || 'candidate' in row).toBe(false);
    expect(typeof row.taskHash).toBe('string');
  });

  it('keeps the text only when learning is on and the tier allows it', async () => {
    const { e, rows } = setup(true);
    await e.sup.grade({ rubric: 'answer', task: 'Add 2 and 2', candidate: 'It is 4', tier: 'internal' });
    await e.sup.grade({ rubric: 'answer', task: 'Add 2 and 2', candidate: 'It is 4', tier: 'sensitive' });
    const [a, b] = rows().filter(x => x.kind === 'grade');
    expect(a).toMatchObject({ task: 'Add 2 and 2', candidate: 'It is 4' });
    expect('task' in b!).toBe(false);
  });

  it('grades text that names students on the local backend only', async () => {
    const { e, asked } = setup();
    const r = await e.sup.grade({ rubric: 'answer', task: 'Grade the student essay', candidate: 'The essay text' });
    if ('error' in r) throw new Error(r.error);
    expect(r).toMatchObject({ tier: 'regulated', backend: 'laya' });
    expect(asked.map(a => a.backend)).toEqual(['laya']);
  });

  it('moves a rubric to advise on labels, then returns a verdict in gate mode', async () => {
    const { e } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) { const r = await e.sup.grade({ rubric: 'answer', task: `Task ${i}`, candidate: 'c' }); if ('error' in r) throw new Error(r.error); ids.push(r.id); }
    for (const id of ids) expect(e.sup.gradeLabel(id, 'agree')).toMatchObject({ ok: true, rubric: 'answer' });
    expect(e.sup.gradeReport()).toMatchObject({ rubrics: [{ rubric: 'answer', labeled: 10, agreeShare: 1, mode: 'advise' }] });
    for (let i = 0; i < 20; i++) { const r = await e.sup.grade({ rubric: 'answer', task: `More ${i}`, candidate: 'c' }); if ('error' in r) throw new Error(r.error); e.sup.gradeLabel(r.id, 'agree'); }
    const gated = await e.sup.grade({ rubric: 'answer', task: 'Final', candidate: 'c' });
    expect(gated).toMatchObject({ mode: 'gate', verdict: 'pass' });
  });

  it('refuses what it cannot grade and says why', async () => {
    const { e } = setup();
    expect(await e.sup.grade({ rubric: 'missing', task: 't', candidate: 'c' })).toMatchObject({ error: expect.stringMatching(/No rubric named missing/) });
    expect(await e.sup.grade({ rubric: '../x', task: 't', candidate: 'c' })).toMatchObject({ error: expect.stringMatching(/lowercase letters/) });
    expect(await e.sup.grade({ rubric: 'answer', task: '', candidate: 'c' })).toMatchObject({ error: expect.stringMatching(/task and a candidate/) });
    expect(e.sup.gradeLabel('nope', 'agree')).toMatchObject({ error: expect.stringMatching(/No grade/) });
    expect(e.sup.gradeLabel('nope', 'fine')).toMatchObject({ error: expect.stringMatching(/one of/) });
    writeFileSync(join(e.home, 'rubrics', 'broken.json'), '{ nope');
    expect(e.sup.gradeReport()).toMatchObject({ problems: [expect.stringMatching(/broken.json is not valid JSON/)] });
  });
});
