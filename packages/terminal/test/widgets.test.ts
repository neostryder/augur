import { describe, expect, it } from 'vitest';
import { makeKey } from '../src/input.js';
import { center, columns, inset, rows } from '../src/layout.js';
import { ASCII, Screen } from '../src/screen.js';
import { bar, box, field, fieldKey, fieldState, list, listKey, listState, spans, tabs } from '../src/widgets.js';

const ch = (t: string) => makeKey('char', { text: t });
const k = (name: string, mods: Parameters<typeof makeKey>[1] = {}) => makeKey(name, mods);

describe('layout', () => {
  it('splits by cells, percentages and shares', () => {
    const r = { x: 0, y: 0, w: 100, h: 10 };
    expect(columns(r, [10, 'flex', 20]).map((c) => [c.x, c.w])).toEqual([[0, 10], [10, 70], [80, 20]]);
    expect(columns(r, ['25%', 'flex', { flex: 2 }], 2).map((c) => [c.x, c.w])).toEqual([[0, 24], [26, 24], [52, 48]]);
    expect(rows(r, [3, 'flex', 1]).map((c) => [c.y, c.h])).toEqual([[0, 3], [3, 6], [9, 1]]);
    expect(columns({ x: 0, y: 0, w: 15, h: 1 }, [10, 10]).map((c) => c.w)).toEqual([10, 5]);
    expect(columns({ x: 0, y: 0, w: 20, h: 1 }, [{ flex: 1, min: 15 }, 'flex']).map((c) => c.w)).toEqual([17, 3]);
  });

  it('insets and centres', () => {
    expect(inset({ x: 0, y: 0, w: 20, h: 10 }, 1, 2)).toEqual({ x: 2, y: 1, w: 16, h: 8 });
    expect(inset({ x: 0, y: 0, w: 2, h: 2 }, 3)).toEqual({ x: 3, y: 3, w: 0, h: 0 });
    expect(center({ x: 0, y: 0, w: 20, h: 10 }, 6, 4)).toEqual({ x: 7, y: 3, w: 6, h: 4 });
    expect(center({ x: 0, y: 0, w: 4, h: 4 }, 6, 6)).toEqual({ x: 0, y: 0, w: 4, h: 4 });
  });
});

describe('widgets', () => {
  it('draws a box with a title and returns the inside', () => {
    const s = new Screen(16, 4);
    expect(box(s, { x: 0, y: 0, w: 16, h: 4 }, { title: 'Usage' })).toEqual({ x: 1, y: 1, w: 14, h: 2 });
    expect(s.text().split('\n')).toEqual([
      '╭─ Usage ──────╮',
      '│              │',
      '│              │',
      '╰──────────────╯',
    ]);
    const a = new Screen(10, 3, ASCII);
    box(a, { x: 0, y: 0, w: 10, h: 3 }, { title: 'A long title' });
    expect(a.text().split('\n')).toEqual(['+- A... -+', '|        |', '+--------+']);
  });

  it('fills a bar in eighths, or in whole cells with ASCII', () => {
    const s = new Screen(10, 3);
    bar(s, 0, 0, 10, 0.5, { fg: 2 });
    bar(s, 0, 1, 10, 0.55, { fg: 2 });
    bar(s, 0, 2, 10, 2, { fg: 2 });
    expect(s.row(0)).toBe('█'.repeat(5) + '░'.repeat(5));
    expect(s.row(1)).toBe('█'.repeat(5) + '▌' + '░'.repeat(4));
    expect(s.row(2)).toBe('█'.repeat(10));
    expect(s.cell(9, 0).style).toEqual({ dim: true });
    const a = new Screen(10, 1, ASCII);
    bar(a, 0, 0, 10, 0.56, {});
    expect(a.row(0)).toBe('######....');
  });

  it('writes styled spans and cuts them with an ellipsis', () => {
    const s = new Screen(12, 1);
    expect(spans(s, 0, 0, 12, [['Codex ', { bold: true }], ['46% of the week', { fg: 3 }]])).toBe(12);
    expect(s.row(0)).toBe('Codex 46% o…');
    expect(s.cell(0, 0).style).toEqual({ bold: true });
    expect(s.cell(7, 0).style).toEqual({ fg: 3 });
  });

  it('scrolls a list to keep the selection in view', () => {
    const s = new Screen(10, 3), st = listState();
    const items = ['one', 'two', 'three', 'four', 'five'];
    for (let i = 0; i < 3; i++) listKey(st, k('down'), items.length, 3);
    list(s, { x: 0, y: 0, w: 10, h: 3 }, items, st, (t) => t);
    expect(st).toEqual({ selected: 3, top: 1 });
    expect(s.text().split('\n').map((l) => l.slice(0, 9).trimEnd())).toEqual(['two', 'three', 'four']);
    expect(s.cell(0, 2).style).toEqual({ inverse: true });
    expect(s.cell(9, 0).ch).toBe('│');
    expect(listKey(st, k('end'), items.length, 3)).toBe(true);
    expect(st.selected).toBe(4);
    expect(listKey(st, ch('x'), items.length, 3)).toBe(false);
    const e = new Screen(10, 2);
    list(e, { x: 0, y: 0, w: 10, h: 2 }, [], listState(), (t: string) => t, { empty: 'No jobs' });
    expect(e.row(0)).toBe('No jobs   ');
  });

  it('edits a text field with the usual keys', () => {
    const f = fieldState();
    for (const c of 'sk-live key') fieldKey(f, ch(c));
    expect(f.value).toBe('sk-live key');
    fieldKey(f, k('char', { text: 'w', ctrl: true }));
    expect(f.value).toBe('sk-live ');
    fieldKey(f, k('backspace'));
    fieldKey(f, k('home'));
    fieldKey(f, k('delete'));
    expect([f.value, f.cursor]).toEqual(['k-live', 0]);
    fieldKey(f, k('paste', { text: 'a\nb' }));
    expect(f.value).toBe('a bk-live');
    fieldKey(f, k('char', { text: 'k', ctrl: true }));
    expect(f.value).toBe('a b');
    expect(fieldKey(f, k('enter'))).toBe(false);
    expect(fieldKey(f, k('char', { text: 'u', ctrl: true }))).toBe(true);
    expect(f.value).toBe('');
  });

  it('draws a field scrolled to the cursor, masked when asked', () => {
    const s = new Screen(8, 2), f = fieldState('abcdefghij');
    field(s, 0, 0, 5, f, { focused: true });
    expect(s.row(0).slice(0, 5)).toBe('ghij ');
    expect(s.cursor).toEqual({ x: 4, y: 0 });
    field(s, 0, 1, 5, fieldState('secret'), { mask: true });
    expect(s.row(1).slice(0, 5)).toBe('•••••');
    const p = new Screen(12, 1);
    field(p, 0, 0, 12, fieldState(), { placeholder: 'Paste a key' });
    expect(p.row(0)).toBe('Paste a key ');
  });

  it('draws tabs and says where each one is', () => {
    const s = new Screen(30, 1);
    expect(tabs(s, 1, 0, 29, ['Usage', 'Alerts', 'Jobs'], 1)).toEqual([[1, 6], [8, 14], [16, 20]]);
    expect(s.cell(8, 0).style).toEqual({ bold: true, underline: true });
    expect(s.cell(1, 0).style).toEqual({ dim: true });
  });
});
