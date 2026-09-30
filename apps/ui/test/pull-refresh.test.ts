import { describe, expect, it } from 'vitest';
import { PULL_TRIGGER, pullOffset } from '../src/pull-refresh';

describe('pull to refresh', () => {
  it('follows the finger at half speed and stops at 120 pixels', () => {
    expect(pullOffset(-30)).toBe(0);
    expect(pullOffset(0)).toBe(0);
    expect(pullOffset(80)).toBe(40);
    expect(pullOffset(400)).toBe(120);
  });

  it('counts a pull once the finger has moved twice the trigger distance', () => {
    expect(pullOffset(2 * PULL_TRIGGER - 2)).toBeLessThan(PULL_TRIGGER);
    expect(pullOffset(2 * PULL_TRIGGER)).toBeGreaterThanOrEqual(PULL_TRIGGER);
  });
});
