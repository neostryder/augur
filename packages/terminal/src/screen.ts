// A grid of cells that a frame is drawn into. Each cell holds one grapheme cluster and a style id; a wide character fills its own cell
// and leaves an empty string in the cell to its right, so the grid always matches what the terminal shows.
import { clusterWidth, graphemes } from './width.js';
import { styleId, styleOf, type Style } from './style.js';

/** The characters widgets draw with, so a terminal without UTF-8 can get plain ASCII instead. */
export interface Glyphs {
  ascii: boolean;
  /** Corners and edges for each border kind, in the order the box is drawn: the top row left to right, the side, then the bottom row. */
  border: Record<'round' | 'single' | 'heavy' | 'double', readonly [string, string, string, string, string, string]>;
  /** Partial blocks from one eighth to seven eighths of a cell, then the full block. */
  eighths: readonly string[];
  track: string;
  ellipsis: string;
  mask: string;
  pointer: string;
  on: string;
  off: string;
  thumb: string;
  rail: string;
  upperHalf: string;
  lowerHalf: string;
  fullBlock: string;
  separator: string;
}

export const UNICODE: Glyphs = {
  ascii: false,
  border: {
    round: ['╭', '─', '╮', '│', '╰', '╯'],
    single: ['┌', '─', '┐', '│', '└', '┘'],
    heavy: ['┏', '━', '┓', '┃', '┗', '┛'],
    double: ['╔', '═', '╗', '║', '╚', '╝'],
  },
  eighths: ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'],
  track: '░',
  ellipsis: '…',
  mask: '•',
  pointer: '›',
  on: '◉',
  off: '○',
  thumb: '┃',
  rail: '│',
  upperHalf: '▀',
  lowerHalf: '▄',
  fullBlock: '█',
  separator: '│',
};

export const ASCII: Glyphs = {
  ascii: true,
  border: { round: ['+', '-', '+', '|', '+', '+'], single: ['+', '-', '+', '|', '+', '+'], heavy: ['+', '=', '+', '|', '+', '+'], double: ['+', '=', '+', '|', '+', '+'] },
  eighths: ['#', '#', '#', '#', '#', '#', '#', '#'],
  track: '.',
  ellipsis: '...',
  mask: '*',
  pointer: '>',
  on: '(*)',
  off: '( )',
  thumb: '#',
  rail: '|',
  upperHalf: '"',
  lowerHalf: ',',
  fullBlock: '#',
  separator: '|',
};

/** UTF-8 glyphs unless the locale says the terminal is not UTF-8. Windows terminals take UTF-8 from Node either way. */
export function glyphsFor(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Glyphs {
  if (platform === 'win32') return UNICODE;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  return !locale || /utf-?8/i.test(locale) ? UNICODE : ASCII;
}

export class Screen {
  readonly chars: string[];
  readonly styles: number[];
  /** Where the terminal's cursor shows after the frame is painted, as for a focused text field. Null hides it. */
  cursor: { x: number; y: number } | null = null;

  constructor(readonly width: number, readonly height: number, readonly glyphs: Glyphs = UNICODE) {
    this.chars = new Array<string>(width * height).fill(' ');
    this.styles = new Array<number>(width * height).fill(0);
  }

  private set(x: number, y: number, ch: string, w: 1 | 2, sid: number): void {
    const i = y * this.width + x;
    // Writing over half of a wide character blanks its other half.
    if (this.chars[i] === '' && x > 0) this.chars[i - 1] = ' ';
    const end = i + w - 1;
    if (x + w < this.width && this.chars[end + 1] === '') this.chars[end + 1] = ' ';
    this.chars[i] = ch; this.styles[i] = sid;
    if (w === 2) { this.chars[i + 1] = ''; this.styles[i + 1] = sid; }
  }

  /**
   * Writes text from (x, y), cut at the screen's edge or after `maxWidth` cells, and returns the column after it. Control characters
   * are dropped and a tab becomes a space. A wide character that does not fit in the room left becomes a space.
   */
  put(x: number, y: number, text: string, style?: Style, maxWidth = Infinity): number {
    if (y < 0 || y >= this.height) return x;
    const sid = styleId(style), end = Math.min(this.width, x + maxWidth);
    const parts = /^[\x20-\x7e]*$/.test(text) ? text : graphemes(text.replace(/\t/g, ' '));
    for (const g of parts) {
      if (x >= end) break;
      const w = g.length === 1 && g >= ' ' && g <= '~' ? 1 : clusterWidth(g);
      if (w === 0) continue;
      if (x < 0) { x += w; continue; }
      if (x + w > end) { this.set(x, y, ' ', 1, sid); x++; continue; }
      this.set(x, y, g, w, sid);
      x += w;
    }
    return x;
  }

  /** Fills a rectangle with one character, clipped to the screen. */
  fill(x: number, y: number, w: number, h: number, style?: Style, ch = ' '): void {
    const sid = styleId(style);
    for (let r = Math.max(0, y); r < Math.min(this.height, y + h); r++) {
      for (let c = Math.max(0, x); c < Math.min(this.width, x + w); c++) this.set(c, r, ch, 1, sid);
    }
  }

  /** Changes the style of cells without touching their characters, as for a highlighted row. */
  restyle(x: number, y: number, w: number, style: Style, mergeWith?: (old: Style) => Style): void {
    if (y < 0 || y >= this.height) return;
    for (let c = Math.max(0, x); c < Math.min(this.width, x + w); c++) {
      const i = y * this.width + c;
      this.styles[i] = styleId(mergeWith ? mergeWith(styleOf(this.styles[i]!)) : style);
    }
  }

  cell(x: number, y: number): { ch: string; style: Style } {
    const i = y * this.width + x;
    return { ch: this.chars[i] ?? ' ', style: styleOf(this.styles[i] ?? 0) };
  }

  /** One row as plain text, for tests and logs. */
  row(y: number): string {
    return this.chars.slice(y * this.width, (y + 1) * this.width).join('');
  }

  text(): string {
    return Array.from({ length: this.height }, (_, y) => this.row(y).trimEnd()).join('\n');
  }
}
