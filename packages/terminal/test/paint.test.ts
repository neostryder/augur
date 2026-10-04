import { describe, expect, it } from 'vitest';
import { paint } from '../src/paint.js';
import { Screen } from '../src/screen.js';
import { sgr, styleOf, type ColorDepth, type Style } from '../src/style.js';
import { Vt } from './vt.js';

function check(vt: Vt, screen: Screen, depth: ColorDepth): void {
  for (let y = 0; y < screen.height; y++) {
    expect(vt.row(y)).toBe(screen.row(y));
    for (let x = 0; x < screen.width; x++) {
      if (screen.chars[y * screen.width + x] === '') continue;
      expect(vt.sgrs[y]![x], `style at ${x},${y}`).toBe(sgr(styleOf(screen.styles[y * screen.width + x]!), depth));
    }
  }
}

// A small seeded generator, so a failure repeats.
function rng(seed: number) {
  return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
}

describe('painting', () => {
  it('draws the first frame in full and nothing for an unchanged one', () => {
    const a = new Screen(12, 3);
    a.put(1, 1, 'Codex', { fg: 2, bold: true });
    a.put(7, 1, '日本', { fg: '#336699' });
    const vt = new Vt(12, 3);
    vt.write(paint(null, a, 'truecolor'));
    check(vt, a, 'truecolor');
    expect(vt.cursorShown).toBe(false);
    const b = new Screen(12, 3);
    b.put(1, 1, 'Codex', { fg: 2, bold: true });
    b.put(7, 1, '日本', { fg: '#336699' });
    expect(paint(a, b, 'truecolor')).toBe('');
  });

  it('writes only the cells that changed', () => {
    const a = new Screen(20, 2);
    a.put(0, 0, 'Claude 5h  9%');
    const b = new Screen(20, 2);
    b.put(0, 0, 'Claude 5h 10%');
    const out = paint(a, b, '256');
    expect(out).toContain('\x1b[1;11H\x1b[0m10');
    expect(out).not.toContain('Claude');
  });

  it('shows the cursor where the frame asks and hides it otherwise', () => {
    const a = new Screen(10, 2), b = new Screen(10, 2);
    b.cursor = { x: 4, y: 1 };
    const vt = new Vt(10, 2);
    vt.write(paint(null, a, '16'));
    vt.write(paint(a, b, '16'));
    expect(vt.cursorShown).toBe(true);
    expect([vt.x, vt.y]).toEqual([4, 1]);
    const c = new Screen(10, 2);
    vt.write(paint(b, c, '16'));
    expect(vt.cursorShown).toBe(false);
  });

  it('repaints in full when the size changes', () => {
    const a = new Screen(10, 2), b = new Screen(12, 3);
    b.put(0, 2, 'bigger');
    const out = paint(a, b, 'none');
    expect(out).toContain('\x1b[2J');
    const vt = new Vt(12, 3);
    vt.write(out);
    check(vt, b, 'none');
  });

  for (const depth of ['truecolor', '256', '16', 'none'] as const) {
    it(`keeps a terminal in step over many random frames (${depth})`, () => {
      const rand = rng(depth.length * 7919), w = 23, h = 7;
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
      const texts = ['a', 'xyz', 'Codex 80%', '日本', '\u{1f44d}ok', 'é', '██▌', '  '];
      const styles: Array<Style | undefined> = [undefined, { fg: 1 }, { fg: '#ff8800', bold: true }, { bg: 4 }, { inverse: true }, { fg: 200, dim: true }];
      const vt = new Vt(w, h);
      let prev: Screen | null = null;
      const keep: Array<[number, number, string, Style | undefined]> = [];
      for (let frame = 0; frame < 300; frame++) {
        const s = new Screen(w, h);
        // Most of each frame repeats the last one, as real frames do, with a few writes added or dropped.
        if (keep.length && rand() < 0.3) keep.splice(Math.floor(rand() * keep.length), 1);
        for (let n = Math.floor(rand() * 4); n > 0; n--) keep.push([Math.floor(rand() * (w + 2)) - 2, Math.floor(rand() * h), pick(texts), pick(styles)]);
        if (keep.length > 40) keep.splice(0, keep.length - 40);
        for (const [x, y, t, st] of keep) s.put(x, y, t, st);
        if (rand() < 0.2) s.cursor = { x: Math.floor(rand() * w), y: Math.floor(rand() * h) };
        vt.write(paint(prev, s, depth));
        check(vt, s, depth);
        expect(vt.cursorShown).toBe(!!s.cursor);
        prev = s;
      }
    });
  }
});
