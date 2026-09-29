import { describe, expect, it } from 'vitest';
import { trainingRows } from '../src/index.js';
import type { DecisionRow } from '../src/index.js';

const pick = (id: string, over: Record<string, unknown> = {}): DecisionRow => ({ kind: 'pick', id, task: 'fix the build script', activity: 'write_code', dataTier: 'internal', pick: 'a/b', classified: { activity: false, dataTier: true }, descriptions: { 'a/b': 'A model.' }, ...over });

describe('training rows from the decision record', () => {
  it('labels activity and tier only where the caller declared them, and skips picks with no task text', () => {
    const rows = trainingRows([pick('p1'), pick('p2', { task: undefined }), pick('p3', { classified: { activity: true, dataTier: true } })]);
    expect(rows.map(r => `${r.pilot}:${r.labels.activity ?? r.labels.data}`)).toEqual(['augur_activity:write_code']);
    expect(rows[0]).toMatchObject({ provenance: 'rule', source: 'human', state: { task: 'fix the build script' } });
  });
  it('turns completed jobs into fit labels, with the reversed question flipped, and learns nothing from failures', () => {
    const rows = trainingRows([
      pick('p1', { classified: { activity: true, dataTier: true } }),
      { kind: 'job', job: 'j1', pick: 'p1', model: 'a/b', overridden: false }, { kind: 'outcome', job: 'j1', pick: 'p1', model: 'a/b', state: 'completed' },
      { kind: 'job', job: 'j2', pick: 'p1', model: 'a/b', overridden: false }, { kind: 'outcome', job: 'j2', pick: 'p1', model: 'a/b', state: 'failed' },
      { kind: 'job', job: 'j3', pick: 'p1', model: 'a/b', overridden: true }, { kind: 'outcome', job: 'j3', pick: 'p1', model: 'a/b', state: 'completed' },
      { kind: 'job', job: 'j4', pick: 'p1', model: 'a/b', overridden: false }, { kind: 'outcome', job: 'j4', pick: 'p1', model: 'a/b', state: 'cancelled' },
    ]);
    expect(rows.map(r => [r.labels.f_a_b, r.labels.r_a_b])).toEqual([[2, 1], [3, 0]]); // the failed and the cancelled jobs make no label: a crash or a timeout does not show a poor fit
    expect(rows.every(r => r.provenance === 'outcome' && r.pilot === 'augur_fit')).toBe(true);
    expect(Object.keys(rows[0]!.questions)).toEqual(['f_a_b', 'r_a_b']);
  });
  it('keeps a row in the same split every time', () => {
    const a = trainingRows([pick('same')])[0]?.split, b = trainingRows([pick('same')])[0]?.split;
    expect(a).toBe(b);
  });
});
