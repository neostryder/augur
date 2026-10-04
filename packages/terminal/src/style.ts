// Cell styles and how they turn into SGR escape sequences for the colors the terminal can show.

/** A palette index (0 to 255; 0 to 15 are the terminal's own theme colors) or a '#rrggbb' color. Absent means the terminal's default. */
export type Color = number | `#${string}`;

export interface Style {
  fg?: Color;
  bg?: Color;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export type ColorDepth = 'none' | '16' | '256' | 'truecolor';

/** The theme's sixteen colors by name. Using these follows the terminal's own color scheme. */
export const ANSI = {
  black: 0, red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6, white: 7,
  gray: 8, brightRed: 9, brightGreen: 10, brightYellow: 11, brightBlue: 12, brightMagenta: 13, brightCyan: 14, brightWhite: 15,
} as const;

/** What the terminal can show, from the environment. NO_COLOR (https://no-color.org) turns color off; bold and inverse still work. */
export function colorDepth(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): ColorDepth {
  if (env.NO_COLOR) return 'none';
  const term = env.TERM ?? '';
  if (term === 'dumb') return 'none';
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? '') || env.WT_SESSION || term.endsWith('-direct')) return 'truecolor';
  // The Windows console has understood 24-bit color since Windows 10.
  if (platform === 'win32') return 'truecolor';
  if (term.includes('256')) return '256';
  return term ? '16' : 'none';
}

const STANDARD: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];
const LEVELS = [0, 95, 135, 175, 215, 255];

function rgbOf(c: Color): [number, number, number] {
  if (typeof c === 'string') {
    const n = parseInt(c.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  if (c < 16) return [...STANDARD[c]!];
  if (c < 232) { const i = c - 16; return [LEVELS[Math.floor(i / 36)]!, LEVELS[Math.floor(i / 6) % 6]!, LEVELS[i % 6]!]; }
  const v = 8 + 10 * (c - 232);
  return [v, v, v];
}

/** The nearest color in the 256-color palette, from its color cube or its gray ramp. */
export function to256(c: Color): number {
  if (typeof c === 'number') return c;
  const [r, g, b] = rgbOf(c);
  const cube = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  const ci = 16 + 36 * cube(r) + 6 * cube(g) + cube(b);
  const avg = Math.round((r + g + b) / 3), gi = avg > 238 ? 255 : avg < 8 ? 232 : 232 + Math.round((avg - 8) / 10);
  return dist(rgbOf(ci), [r, g, b]) <= dist(rgbOf(gi), [r, g, b]) ? ci : gi;
}

/** The nearest of the sixteen theme colors. */
export function to16(c: Color): number {
  if (typeof c === 'number' && c < 16) return c;
  const rgb = rgbOf(c);
  let best = 0;
  for (let i = 1; i < 16; i++) if (dist(STANDARD[i]!, rgb) < dist(STANDARD[best]!, rgb)) best = i;
  return best;
}

function dist(a: readonly number[], b: readonly number[]): number {
  return (a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2;
}

function colorCodes(c: Color, depth: ColorDepth, bg: boolean): string {
  if (depth === 'none') return '';
  const base = bg ? 40 : 30;
  if (depth === 'truecolor' && typeof c === 'string') return `${base + 8};2;${rgbOf(c).join(';')}`;
  const n = depth === '16' ? to16(c) : to256(c);
  if (n < 8) return String(base + n);
  if (n < 16) return String(base + 60 + n - 8);
  return `${base + 8};5;${n}`;
}

/** The SGR sequence that sets exactly this style, starting from a reset. */
export function sgr(style: Style, depth: ColorDepth): string {
  const codes = ['0'];
  if (style.bold) codes.push('1');
  if (style.dim) codes.push('2');
  if (style.italic) codes.push('3');
  if (style.underline) codes.push('4');
  if (style.inverse) codes.push('7');
  if (style.fg !== undefined) { const f = colorCodes(style.fg, depth, false); if (f) codes.push(f); }
  if (style.bg !== undefined) { const b = colorCodes(style.bg, depth, true); if (b) codes.push(b); }
  return `\x1b[${codes.join(';')}m`;
}

/** `over` on top of `base`: each field `over` sets wins. */
export function merge(base: Style, over: Style | undefined): Style {
  return over ? { ...base, ...Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined)) } : base;
}

// Styles are interned to small numbers, so a cell compares its style with one integer test. Id 0 is the default style.
const ids = new Map<string, number>([['{}', 0]]);
const styles: Style[] = [{}];

function keyOf(s: Style): string {
  const o: Record<string, unknown> = {};
  for (const k of ['fg', 'bg', 'bold', 'dim', 'italic', 'underline', 'inverse'] as const) if (s[k] !== undefined && s[k] !== false) o[k] = s[k];
  return JSON.stringify(o);
}

export function styleId(s: Style | undefined): number {
  if (!s) return 0;
  const key = keyOf(s);
  let id = ids.get(key);
  if (id === undefined) { id = styles.length; styles.push(JSON.parse(key) as Style); ids.set(key, id); }
  return id;
}

export function styleOf(id: number): Style {
  return styles[id] ?? {};
}
