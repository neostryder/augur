import { describe, expect, it } from 'vitest';
import { heightAtWidth } from '../src/measure';

/** A stand-in whose height grows as its width shrinks, like wrapped text. */
function fakeRoot(initialWidth: string) {
  const el = { style: { width: initialWidth } } as unknown as HTMLElement;
  (el as { getBoundingClientRect: () => { height: number } }).getBoundingClientRect = () => ({ height: 100000 / (parseInt(el.style.width, 10) || 780) });
  return el;
}

describe('heightAtWidth', () => {
  it('reads the height at the asked width, not the current one', () => {
    const wide = fakeRoot('780px'), narrow = fakeRoot('400px');
    expect(heightAtWidth(wide, 400)).toBe(heightAtWidth(narrow, 400));
  });

  it('puts the width back', () => {
    const el = fakeRoot('780px');
    heightAtWidth(el, 400);
    expect(el.style.width).toBe('780px');
    const unset = fakeRoot('');
    heightAtWidth(unset, 400);
    expect(unset.style.width).toBe('');
  });
});
