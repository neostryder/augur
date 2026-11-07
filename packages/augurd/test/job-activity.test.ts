import { describe, expect, it } from 'vitest';
import { lookEveryMs, parsePsRows, parsePsTime, parseJobAccounting, sampleTree, wasActive } from '../src/job-activity.js';

describe('job activity', () => {
  it('reads ps times with days, hours, and fractions', () => {
    expect(parsePsTime('00:05')).toBe(5000);
    expect(parsePsTime('1:02:03')).toBe(3723000);
    expect(parsePsTime('2-00:00:01')).toBe(172801000);
    expect(parsePsTime('0:00.12')).toBe(120);
    expect(parsePsTime('abc')).toBeNull();
  });

  it('keeps only the rows that descend from the job', () => {
    const rows = parsePsRows(' 10 1 00:01\n 11 10 00:02\n 12 11 00:03\n 13 1 00:09\nnot a row\n');
    const tree = sampleTree(rows, 10);
    expect([...tree.pids].sort()).toEqual([10, 11, 12]);
    expect(tree.cpuMs).toBe(6000);
  });

  it('reads the job host totals', () => {
    expect(parseJobAccounting('20000000 1024 3')).toMatchObject({ cpuMs: 2000, io: 1024, started: 3 });
    expect(parseJobAccounting('garbage')).toBeNull();
  });

  it('calls a tree active for CPU, I/O, or a new process, and idle otherwise', () => {
    const base = { cpuMs: 1000, io: 100, pids: new Set([1, 2]), started: 2 };
    expect(wasActive(base, { ...base }, 15000)).toBe(false);
    expect(wasActive(base, { ...base, cpuMs: 1100 }, 15000)).toBe(false);
    expect(wasActive(base, { ...base, cpuMs: 1500 }, 15000)).toBe(true);
    expect(wasActive(base, { ...base, io: 100 + 70000 }, 15000)).toBe(true);
    expect(wasActive(base, { ...base, pids: new Set([1, 2, 3]) }, 15000)).toBe(true);
    expect(wasActive(base, { ...base, started: 3 }, 15000)).toBe(true);
  });

  it('looks four times per limit, between half a second and fifteen seconds', () => {
    expect(lookEveryMs(1)).toBe(500);
    expect(lookEveryMs(20)).toBe(5000);
    expect(lookEveryMs(3600)).toBe(15000);
  });
});
