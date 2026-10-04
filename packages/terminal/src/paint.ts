// Turns a frame into the bytes that bring the terminal from the previous frame to this one: only cells that changed are written, the
// cursor moves only when it has to, and the style is set only when it changes. Terminals that know synchronized output (mode 2026)
// show the whole frame at once; the rest ignore the request.
import type { Screen } from './screen.js';
import { sgr, styleOf, type ColorDepth } from './style.js';

const at = (x: number, y: number) => `\x1b[${y + 1};${x + 1}H`;

export function paint(prev: Screen | null, next: Screen, depth: ColorDepth): string {
  const full = !prev || prev.width !== next.width || prev.height !== next.height;
  let out = full ? '\x1b[0m\x1b[2J' : '';
  // -1 means unknown: after the last column the terminal holds a pending wrap, so the next write always moves first.
  let cx = -1, cy = -1, sid = -1;
  for (let y = 0; y < next.height; y++) {
    const row = y * next.width;
    for (let x = 0; x < next.width; x++) {
      const i = row + x, ch = next.chars[i]!;
      if (ch === '') continue;
      if (!full && ch === prev!.chars[i] && next.styles[i] === prev!.styles[i] && !wideChanged(prev!, next, i, x)) continue;
      if (cx !== x || cy !== y) out += at(x, y);
      if (sid !== next.styles[i]) { sid = next.styles[i]!; out += sgr(styleOf(sid), depth); }
      out += ch;
      const w = x + 1 < next.width && next.chars[i + 1] === '' ? 2 : 1;
      cx = x + w >= next.width ? -1 : x + w; cy = y;
    }
  }
  if (sid > 0) out += '\x1b[0m';
  const cursorChanged = full || !sameCursor(prev!.cursor, next.cursor);
  if (!out && !cursorChanged) return '';
  if (next.cursor) out += at(next.cursor.x, next.cursor.y) + '\x1b[?25h';
  else if (cursorChanged || out) out += '\x1b[?25l';
  return `\x1b[?2026h${out}\x1b[?2026l`;
}

// A wide character whose right half was covered and is now shown again needs writing even though its own cell did not change.
function wideChanged(prev: Screen, next: Screen, i: number, x: number): boolean {
  return x + 1 < next.width && (next.chars[i + 1] === '') !== (prev.chars[i + 1] === '');
}

function sameCursor(a: Screen['cursor'], b: Screen['cursor']): boolean {
  return a === b || (!!a && !!b && a.x === b.x && a.y === b.y);
}
