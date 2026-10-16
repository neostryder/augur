import { describe, expect, it } from 'vitest';
import { LADDER, decide, grade, gradeQuestions, gradeStats, gradeTier, parseRubric, readGrade } from '../src/index.js';
import type { DecisionBackend, GradeLabelRow, GradeRow, Rubric, SystemOneResponse } from '../src/index.js';

const rubric = (over: Partial<Rubric> = {}): Rubric => ({ id: 'answer', version: 1, stakes: 'low', passAt: 0.6, dimensions: [
  { id: 'correct', instructions: 'Is the answer correct?', levels: ['Wrong.', 'Partly right.', 'Right.'] },
  { id: 'clear', instructions: 'Is it clear?', levels: ['Muddled.', 'Readable.', 'Clear.', 'Crisp.'], weight: 2 }], ...over });

const backend = (id: string, local: boolean, answer: (q: Record<string, unknown>) => SystemOneResponse): DecisionBackend & { asked: number } => {
  const b = { id, local, asked: 0, async ask(_s: unknown, q: Record<string, unknown>) { b.asked++; return answer(q); } };
  return b as unknown as DecisionBackend & { asked: number };
};
/** Answers every dimension at the given level on a 0..1 scale, in whichever order the question was asked. */
const at = (level: number, r = rubric()) => (q: Record<string, unknown>): SystemOneResponse => ({ answers: Object.fromEntries(Object.keys(q).map(k => {
  const d = r.dimensions.find(x => k.endsWith(x.id))!, top = d.levels.length - 1;
  return [k, { score: k.startsWith('g_') ? level * top : (1 - level) * top }];
})) });

describe('parseRubric', () => {
  it('accepts a good rubric and keeps only its own fields', () => {
    const r = parseRubric({ ...rubric(), extra: 'ignored' });
    expect('rubric' in r && r.rubric.dimensions).toHaveLength(2);
    expect('rubric' in r && 'extra' in r.rubric).toBe(false);
  });
  it('lists every problem at once', () => {
    const r = parseRubric({ id: 'Bad Id', version: 0, stakes: 'huge', dimensions: [{ id: 'a', instructions: '', levels: ['one'] }, { id: 'a', instructions: 'x', levels: ['a', 'b'] }] });
    expect('errors' in r && r.errors.length).toBeGreaterThanOrEqual(5);
    expect('errors' in r && r.errors.join(' ')).toMatch(/used twice/);
  });
  it('refuses something that is not an object', () => { expect('errors' in parseRubric([])).toBe(true); });
});

describe('questions and reading', () => {
  it('asks each dimension in both orders with the levels flipped', () => {
    const q = gradeQuestions(rubric());
    expect(Object.keys(q)).toEqual(['g_correct', 'r_correct', 'g_clear', 'r_clear']);
    expect((q.g_correct as { criteria: string[] }).criteria).toEqual(['Wrong.', 'Partly right.', 'Right.']);
    expect((q.r_correct as { criteria: string[] }).criteria).toEqual(['Right.', 'Partly right.', 'Wrong.']);
  });
  it('averages the two orders, weights the overall, and reports the spread', () => {
    const g = readGrade(rubric(), { g_correct: { score: 2 }, r_correct: { score: 0 }, g_clear: { score: 3 }, r_clear: { score: 1 } }, 'b')!;
    expect(g.dims.correct).toEqual({ score: 1, spread: 0 });
    expect(g.dims.clear).toEqual({ score: 0.833, spread: 0.333 });
    expect(g.overall).toBeCloseTo((1 * 1 + 0.833 * 2) / 3, 2);
    expect(g.uncertainty).toBe(0.333);
  });
  it('is not a grade when a dimension has no answer, and one order alone counts as fully uncertain', () => {
    expect(readGrade(rubric(), { g_correct: { score: 1 } }, 'b')).toBeNull();
    const one = readGrade(rubric(), { g_correct: { score: 2 }, g_clear: { score: 3 } }, 'b')!;
    expect(one.uncertainty).toBe(1);
  });
});

describe('where a grade is asked', () => {
  it('grades public and internal text on the primary backend', async () => {
    const hosted = backend('jev', false, at(1)), local = backend('laya', true, at(0));
    const out = await grade({ primary: hosted, local }, rubric(), { task: 't', candidate: 'c' }, 'internal');
    expect('grade' in out && out.grade).toMatchObject({ overall: 1, backend: 'jev' });
    expect(hosted.asked).toBe(1); expect(local.asked).toBe(0);
  });
  it('keeps sensitive and regulated text on the local backend, and refuses when there is none', async () => {
    const hosted = backend('jev', false, at(1)), local = backend('laya', true, at(0.5));
    const a = await grade({ primary: hosted, local }, rubric(), { task: 't', candidate: 'c' }, 'regulated');
    expect('grade' in a && a.grade.backend).toBe('laya'); expect(hosted.asked).toBe(0);
    const b = await grade({ primary: hosted }, rubric(), { task: 't', candidate: 'c' }, 'sensitive');
    expect(b).toEqual({ error: 'No backend on this network can grade text in the sensitive tier.' });
    expect(hosted.asked).toBe(0);
  });
  it('refuses an over-long candidate instead of cutting it', async () => {
    const out = await grade({ primary: backend('laya', true, at(1)) }, rubric(), { task: 't', candidate: 'x'.repeat(20001) }, 'internal');
    expect('error' in out && out.error).toMatch(/not cut/);
  });
  it('turns a backend error into an error and does not invent a grade', async () => {
    const out = await grade({ primary: backend('jev', false, () => ({ error: 'Jev answered 429' })) }, rubric(), { task: 't', candidate: 'c' }, 'public');
    expect(out).toEqual({ error: 'Jev answered 429' });
  });
  it('raises the tier to regulated on student wording, whatever was declared', () => {
    expect(gradeTier(undefined, 'the essay of a student')).toBe('regulated');
    expect(gradeTier(undefined, 'a poem about rain')).toBe('internal');
    expect(gradeTier('public', 'the essay of a student')).toBe('regulated');
    expect(gradeTier('internal', 'the essay of a student')).toBe('regulated');
    expect(gradeTier('public', 'a poem about rain')).toBe('public');
    expect(gradeTier('sensitive', 'a poem about rain')).toBe('sensitive');
  });
});

const rows = (r: Rubric, labels: Array<'agree' | 'high' | 'low'>, version = r.version): Array<GradeRow | GradeLabelRow> =>
  labels.flatMap((label, i): Array<GradeRow | GradeLabelRow> => [{ kind: 'grade', id: `g${i}`, rubric: r.id, version, tier: 'internal', backend: 'jev', overall: 0.8, uncertainty: 0.1 }, { kind: 'gradelabel', grade: `g${i}`, label }]);

describe('what a grade may be used for', () => {
  it('starts in shadow and earns advise and then gate on labelled agreement, by stakes', () => {
    const low = rubric(), a = (n: number, share: number) => rows(low, Array.from({ length: n }, (_, i) => (i < Math.round(n * share) ? 'agree' : 'high')));
    expect(gradeStats([], low).mode).toBe('shadow');
    expect(gradeStats(a(9, 1), low).mode).toBe('shadow');
    expect(gradeStats(a(10, 0.7), low).mode).toBe('advise');
    expect(gradeStats(a(30, 0.84), low).mode).toBe('advise');
    expect(gradeStats(a(30, 0.9), low).mode).toBe('gate');
  });
  it('asks a medium rubric for more, and never lets a high-stakes rubric gate', () => {
    const med = rubric({ stakes: 'medium' }), high = rubric({ stakes: 'high' });
    expect(gradeStats(rows(med, Array(30).fill('agree')), med).mode).toBe('advise');
    expect(gradeStats(rows(med, Array(100).fill('agree')), med).mode).toBe('gate');
    expect(gradeStats(rows(high, Array(500).fill('agree')), high).mode).toBe('advise');
    expect(LADDER.high.gate).toBeNull();
  });
  it('starts over when the rubric version changes, and counts the latest label of a grade', () => {
    const low = rubric(), old = rows(low, Array(30).fill('agree'), 1);
    expect(gradeStats(old, rubric({ version: 2 })).mode).toBe('shadow');
    const relabeled = [...rows(low, ['high']), { kind: 'gradelabel', grade: 'g0', label: 'agree' } as GradeLabelRow];
    expect(gradeStats(relabeled, low)).toMatchObject({ labeled: 1, agree: 1, high: 0 });
  });
  it('reports too-high and too-low counts and what the next step needs', () => {
    const s = gradeStats(rows(rubric(), ['agree', 'high', 'low', 'agree']), rubric());
    expect(s).toMatchObject({ labeled: 4, agree: 2, high: 1, low: 1, agreeShare: 0.5, mode: 'shadow' });
    expect(s.next).toMatch(/10 labelled grades with 70% agreement for advise/);
  });
  it('decides nothing outside gate mode', () => {
    const g = readGrade(rubric(), { g_correct: { score: 2 }, r_correct: { score: 0 }, g_clear: { score: 3 }, r_clear: { score: 0 } }, 'b')!;
    expect(decide(rubric(), g, 'shadow', 'x')).toEqual({ mode: 'shadow', verdict: null, audit: false });
    expect(decide(rubric(), g, 'advise', 'x').verdict).toBeNull();
  });
  it('in gate mode passes, fails, or sends an unsure grade to review', () => {
    const level = (v: number) => readGrade(rubric(), { g_correct: { score: v * 2 }, r_correct: { score: (1 - v) * 2 }, g_clear: { score: v * 3 }, r_clear: { score: (1 - v) * 3 } }, 'b')!;
    expect(decide(rubric(), level(0.9), 'gate', 'id1').verdict).toBe('pass');
    expect(decide(rubric(), level(0.2), 'gate', 'id1').verdict).toBe('fail');
    const unsure = readGrade(rubric(), { g_correct: { score: 2 }, r_correct: { score: 2 }, g_clear: { score: 3 }, r_clear: { score: 0 } }, 'b')!;
    expect(decide(rubric(), unsure, 'gate', 'id1').verdict).toBe('review');
    expect(decide(rubric({ passAt: undefined }), level(0.9), 'gate', 'id1').verdict).toBeNull();
  });
  it('flags a repeatable share of gate grades for a spot check', () => {
    const g = readGrade(rubric({ stakes: 'medium' }), { g_correct: { score: 2 }, r_correct: { score: 0 }, g_clear: { score: 3 }, r_clear: { score: 0 } }, 'b')!;
    const flagged = Array.from({ length: 400 }, (_, i) => decide(rubric({ stakes: 'medium' }), g, 'gate', `id${i}`).audit).filter(Boolean).length;
    expect(flagged).toBeGreaterThan(60); expect(flagged).toBeLessThan(140);
    expect(decide(rubric({ stakes: 'medium' }), g, 'gate', 'id7').audit).toBe(decide(rubric({ stakes: 'medium' }), g, 'gate', 'id7').audit);
  });
});
