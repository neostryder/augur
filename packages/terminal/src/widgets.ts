// The pieces screens are built from: boxes, bars, styled text, a scrolling list, a one-line text field and a tab row. Each draws into a
// Screen; the list and the field keep their state in plain objects the screen owns, with a key function that moves or edits it.
import type { Key } from './input.js';
import type { Rect } from './layout.js';
import type { Screen } from './screen.js';
import { merge, type Style } from './style.js';
import { clusterWidth, graphemes, textWidth, truncate } from './width.js';

/** Text in pieces, each with its own style laid over the line's. */
export type Spans = string | ReadonlyArray<readonly [string, Style?]>;

/** Writes spans from (x, y) in at most `w` cells, ending with an ellipsis when they are cut. Returns the column after the text. */
export function spans(screen: Screen, x: number, y: number, w: number, content: Spans, base: Style = {}): number {
  const list = typeof content === 'string' ? [[content] as const] : content;
  const end = x + w, ell = screen.glyphs.ellipsis;
  const total = list.reduce((n, [t]) => n + textWidth(t), 0);
  let room = total > w ? Math.max(0, w - textWidth(ell)) : w;
  for (const [t, s] of list) {
    if (room <= 0) break;
    const piece = truncate(t, room, '');
    x = screen.put(x, y, piece, merge(base, s), end - x);
    room -= textWidth(piece);
  }
  if (total > w) x = screen.put(x, y, truncate(ell, end - x, ''), base, end - x);
  return x;
}

/** A border around r with an optional title in its top edge. Returns the space inside. */
export function box(screen: Screen, r: Rect, opts: { title?: Spans; style?: Style; titleStyle?: Style; border?: keyof Screen['glyphs']['border'] } = {}): Rect {
  if (r.w < 2 || r.h < 2) return { x: r.x, y: r.y, w: 0, h: 0 };
  const [tl, hz, tr, vt, bl, br] = screen.glyphs.border[opts.border ?? 'round'], st = opts.style ?? {};
  screen.put(r.x, r.y, tl + hz.repeat(r.w - 2) + tr, st);
  screen.put(r.x, r.y + r.h - 1, bl + hz.repeat(r.w - 2) + br, st);
  for (let y = r.y + 1; y < r.y + r.h - 1; y++) { screen.put(r.x, y, vt, st); screen.put(r.x + r.w - 1, y, vt, st); }
  if (opts.title && r.w > 6) {
    screen.put(r.x + 2, r.y, ' ', st);
    const after = spans(screen, r.x + 3, r.y, r.w - 6, opts.title, opts.titleStyle ?? st);
    screen.put(after, r.y, ' ', st);
  }
  return { x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 };
}

/** A horizontal bar `w` cells long, filled to `fraction` (0 to 1) in eighths of a cell. */
export function bar(screen: Screen, x: number, y: number, w: number, fraction: number, fill: Style, empty: Style = { dim: true }): void {
  if (w <= 0) return;
  const g = screen.glyphs, cells = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * w;
  let full = Math.floor(cells), part = g.ascii ? 0 : Math.round((cells - full) * 8);
  if (part === 8) { full++; part = 0; }
  if (g.ascii && cells - full >= 0.5) full++;
  full = Math.min(full, w);
  if (full) screen.put(x, y, g.eighths[7]!.repeat(full), fill);
  let at = x + full;
  if (part && at < x + w) { screen.put(at, y, g.eighths[part - 1]!, fill); at++; }
  if (at < x + w) screen.put(at, y, g.track.repeat(x + w - at), empty);
}

export interface ListState { selected: number; top: number }

export function listState(selected = 0): ListState {
  return { selected, top: 0 };
}

/** Moves the selection for arrow keys, j and k, Page Up and Page Down, Home and End. Returns false for keys it does not use. */
export function listKey(state: ListState, key: Key, count: number, page: number): boolean {
  const last = count - 1;
  let to = state.selected;
  switch (key.label) {
    case 'up': case 'k': to--; break;
    case 'down': case 'j': to++; break;
    case 'pageup': to -= Math.max(1, page - 1); break;
    case 'pagedown': to += Math.max(1, page - 1); break;
    case 'home': case 'g': to = 0; break;
    case 'end': case 'G': to = last; break;
    default: return false;
  }
  state.selected = Math.max(0, Math.min(last, to));
  return true;
}

/**
 * Draws as many items as fit in r, scrolled so the selection shows, with a scroll bar on the right edge when they do not all fit.
 * `render` gives each row's content; the selected row gets `selectedStyle` across its whole width when `focused`.
 */
export function list<T>(screen: Screen, r: Rect, items: readonly T[], state: ListState, render: (item: T, index: number, selected: boolean) => Spans,
  opts: { style?: Style; selectedStyle?: Style; focused?: boolean; empty?: string } = {}): void {
  if (r.h <= 0 || r.w <= 0) return;
  const base = opts.style ?? {}, sel = opts.selectedStyle ?? { inverse: true }, focused = opts.focused ?? true;
  state.selected = Math.max(0, Math.min(items.length - 1, state.selected));
  if (state.selected < state.top) state.top = state.selected;
  if (state.selected >= state.top + r.h) state.top = state.selected - r.h + 1;
  state.top = Math.max(0, Math.min(state.top, Math.max(0, items.length - r.h)));
  if (!items.length) { if (opts.empty) spans(screen, r.x, r.y, r.w, opts.empty, { ...base, dim: true }); return; }
  const scroll = items.length > r.h, w = scroll ? r.w - 1 : r.w;
  for (let row = 0; row < r.h; row++) {
    const i = state.top + row;
    if (i >= items.length) break;
    const selected = i === state.selected, rowStyle = selected && focused ? merge(base, sel) : base;
    if (selected && focused) screen.fill(r.x, r.y + row, w, 1, rowStyle);
    spans(screen, r.x, r.y + row, w, render(items[i]!, i, selected), rowStyle);
    if (selected && focused) screen.restyle(r.x, r.y + row, w, rowStyle, (old) => merge(old, { bg: sel.bg, inverse: sel.inverse }));
  }
  if (scroll) {
    const g = screen.glyphs, size = Math.max(1, Math.round((r.h * r.h) / items.length));
    const pos = Math.round(((r.h - size) * state.top) / Math.max(1, items.length - r.h));
    for (let row = 0; row < r.h; row++) {
      const on = row >= pos && row < pos + size;
      screen.put(r.x + r.w - 1, r.y + row, on ? g.thumb : g.rail, on ? base : { ...base, dim: true });
    }
  }
}

export interface FieldState { value: string; cursor: number; offset: number }

export function fieldState(value = ''): FieldState {
  return { value, cursor: graphemes(value).length, offset: 0 };
}

/** Edits the field for typing, paste and the usual line-editing keys (Ctrl+A, E, U, K, W, and Ctrl or Alt with the arrows to move by
 * word). Returns false for keys it does not use, such as Enter, Tab and Escape. */
export function fieldKey(state: FieldState, key: Key): boolean {
  const g = graphemes(state.value), at = Math.min(state.cursor, g.length);
  const wordStart = () => { let i = at; while (i > 0 && g[i - 1] === ' ') i--; while (i > 0 && g[i - 1] !== ' ') i--; return i; };
  const wordEnd = () => { let i = at; while (i < g.length && g[i] === ' ') i++; while (i < g.length && g[i] !== ' ') i++; return i; };
  const set = (parts: string[], cursor: number) => { state.value = parts.join(''); state.cursor = cursor; };
  const insert = (text: string) => { const add = graphemes(text.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '')); set([...g.slice(0, at), ...add, ...g.slice(at)], at + add.length); };
  switch (key.label) {
    case 'backspace': if (at > 0) set([...g.slice(0, at - 1), ...g.slice(at)], at - 1); return true;
    case 'delete': case 'ctrl+d': if (at < g.length) set([...g.slice(0, at), ...g.slice(at + 1)], at); return true;
    case 'left': case 'ctrl+b': state.cursor = Math.max(0, at - 1); return true;
    case 'right': case 'ctrl+f': state.cursor = Math.min(g.length, at + 1); return true;
    case 'home': case 'ctrl+a': state.cursor = 0; return true;
    case 'end': case 'ctrl+e': state.cursor = g.length; return true;
    case 'ctrl+left': case 'alt+left': case 'alt+b': state.cursor = wordStart(); return true;
    case 'ctrl+right': case 'alt+right': case 'alt+f': state.cursor = wordEnd(); return true;
    case 'ctrl+u': set(g.slice(at), 0); return true;
    case 'ctrl+k': set(g.slice(0, at), at); return true;
    case 'ctrl+w': case 'alt+backspace': { const s = wordStart(); set([...g.slice(0, s), ...g.slice(at)], s); return true; }
  }
  if (key.name === 'paste') { insert(key.text ?? ''); return true; }
  if (key.name === 'char' && !key.ctrl && !key.alt && key.text) { insert(key.text); return true; }
  return false;
}

/** Draws the field's text in `w` cells, scrolled so the cursor shows, and puts the terminal cursor there when `focused`. A masked field
 * shows one dot per character, for keys. */
export function field(screen: Screen, x: number, y: number, w: number, state: FieldState,
  opts: { style?: Style; focused?: boolean; mask?: boolean; placeholder?: string; placeholderStyle?: Style } = {}): void {
  if (w <= 0) return;
  const style = opts.style ?? { underline: true };
  screen.fill(x, y, w, 1, style);
  const g = graphemes(state.value).map((c) => (opts.mask ? screen.glyphs.mask : c));
  state.cursor = Math.max(0, Math.min(state.cursor, g.length));
  if (!g.length && opts.placeholder && !opts.focused) spans(screen, x, y, w, opts.placeholder, merge(style, opts.placeholderStyle ?? { dim: true }));
  const widths = g.map((c) => clusterWidth(c) || 1);
  const span = (a: number, b: number) => widths.slice(a, b).reduce((n, v) => n + v, 0);
  // A field without focus shows its start; with focus it scrolls to keep the cursor in view.
  if (!opts.focused) state.offset = 0;
  else {
    if (state.cursor < state.offset) state.offset = state.cursor;
    while (state.offset < state.cursor && span(state.offset, state.cursor) > w - 1) state.offset++;
  }
  screen.put(x, y, g.slice(state.offset).join(''), style, w);
  if (opts.focused) screen.cursor = { x: x + span(state.offset, state.cursor), y };
}

/** A row of tab names with the active one marked. Returns where each tab starts and ends, so a screen can map a click or a number key. */
export function tabs(screen: Screen, x: number, y: number, w: number, names: readonly string[], active: number,
  opts: { style?: Style; activeStyle?: Style; gap?: number } = {}): Array<[number, number]> {
  const style = opts.style ?? { dim: true }, activeStyle = opts.activeStyle ?? { bold: true, underline: true }, gap = opts.gap ?? 2;
  const out: Array<[number, number]> = [];
  let at = x;
  names.forEach((name, i) => {
    if (at >= x + w) return;
    const start = at;
    at = screen.put(at, y, name, i === active ? activeStyle : style, x + w - at);
    out.push([start, at]);
    at += gap;
  });
  return out;
}
