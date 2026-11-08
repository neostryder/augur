import { describe, expect, it } from 'vitest';
import { QUICK_ADAPTERS, Slots } from '../src/slots.js';

describe('Slots', () => {
  it('keeps the reserved slots free of long jobs while quick jobs may use every slot', () => {
    const s = new Slots(8, 2, []);
    let long = 0;
    while (s.canTake(false)) { s.take(false); long++; }
    expect(long).toBe(6);
    expect(s.free).toBe(2);
    expect(s.canTake(true)).toBe(true);
    s.take(true); s.take(true);
    expect(s.canTake(true)).toBe(false);
    expect(s.free).toBe(0);
  });

  it('counts jobs that are already running', () => {
    const s = new Slots(4, 1, [false, false, false]);
    expect(s.canTake(false)).toBe(false);
    expect(s.canTake(true)).toBe(true);
  });

  it('always lets at least one long job run, even when every slot is reserved', () => {
    const s = new Slots(2, 5, []);
    expect(s.canTake(false)).toBe(true);
    s.take(false);
    expect(s.canTake(false)).toBe(false);
  });

  it('with no reserve behaves like a plain limit', () => {
    const s = new Slots(3, 0, []);
    for (let i = 0; i < 3; i++) { expect(s.canTake(false)).toBe(true); s.take(false); }
    expect(s.canTake(true)).toBe(false);
  });

  it('treats the direct API adapters as quick', () => {
    expect([...QUICK_ADAPTERS].sort()).toEqual(['anthropic-api', 'openai-api']);
  });
});
