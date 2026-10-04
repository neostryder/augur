// Rectangles and how to divide them. A frame is laid out by splitting the screen into rows and columns, each sized in cells, as a
// percentage of the space, or by a share of what is left.

export interface Rect { x: number; y: number; w: number; h: number }

/** Cells, a percentage of the space, or a share of what the other sizes leave ('flex' is one share). */
export type Size = number | `${number}%` | 'flex' | { flex: number; min?: number };

function sizes(total: number, list: readonly Size[], gap: number): number[] {
  const room = Math.max(0, total - gap * Math.max(0, list.length - 1));
  const out = list.map((s) => (typeof s === 'number' ? Math.max(0, Math.floor(s)) : typeof s === 'string' && s.endsWith('%') ? Math.floor((room * parseFloat(s)) / 100) : 0));
  const flex = list.map((s) => (s === 'flex' ? 1 : typeof s === 'object' ? s.flex : 0));
  let used = out.reduce((a, b) => a + b, 0);
  // Fixed sizes that do not fit give way from the end.
  for (let i = out.length - 1; i >= 0 && used > room; i--) { const cut = Math.min(out[i]!, used - room); out[i]! -= cut; used -= cut; }
  const shares = flex.reduce((a, b) => a + b, 0);
  if (shares > 0) {
    let left = room - used;
    // Minimums first, then the rest by share; the last flexible item takes the rounding.
    list.forEach((s, i) => { if (typeof s === 'object' && s.min) { const m = Math.min(s.min, left); out[i] = m; left -= m; } });
    const free = left;
    let last = -1;
    flex.forEach((f, i) => { if (f > 0) { const add = Math.floor((free * f) / shares); out[i]! += add; left -= add; last = i; } });
    if (last >= 0) out[last]! += left;
  }
  return out;
}

/** Side by side, left to right. */
export function columns(r: Rect, list: readonly Size[], gap = 0): Rect[] {
  let x = r.x;
  return sizes(r.w, list, gap).map((w) => { const out = { x, y: r.y, w, h: r.h }; x += w + gap; return out; });
}

/** Stacked, top to bottom. */
export function rows(r: Rect, list: readonly Size[], gap = 0): Rect[] {
  let y = r.y;
  return sizes(r.h, list, gap).map((h) => { const out = { x: r.x, y, w: r.w, h }; y += h + gap; return out; });
}

/** The rectangle shrunk on each side, in CSS order: top, right, bottom, left. */
export function inset(r: Rect, top: number, right = top, bottom = top, left = right): Rect {
  return { x: r.x + left, y: r.y + top, w: Math.max(0, r.w - left - right), h: Math.max(0, r.h - top - bottom) };
}

/** A w by h rectangle centred in r, no bigger than r. */
export function center(r: Rect, w: number, h: number): Rect {
  const cw = Math.min(w, r.w), ch = Math.min(h, r.h);
  return { x: r.x + ((r.w - cw) >> 1), y: r.y + ((r.h - ch) >> 1), w: cw, h: ch };
}
