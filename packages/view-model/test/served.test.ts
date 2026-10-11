import { describe, expect, it } from 'vitest';
import { servedText } from '../src/index.js';

describe('where a gateway served a job', () => {
  it('names the machine, and the link only when it was not the first', () => {
    expect(servedText({ host: 'eru', model: 'laya-judge', chainPosition: 0, degraded: false })).toBe('eru');
    expect(servedText({ host: 'bilbo', chainPosition: 1, degraded: true })).toBe('bilbo, link 2, a fallback');
    expect(servedText({ model: 'apple' })).toBe('apple');
  });

  it('says nothing for a job that carries nothing', () => {
    expect(servedText(undefined)).toBe('');
    expect(servedText({})).toBe('');
  });
});
