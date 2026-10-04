// A scrolling list of labelled controls, the way the settings page lays out its switches, choices, text boxes, buttons and check grids.
// Rows are rebuilt from the engine state on every frame; the form keeps only which row has focus, the scroll position, and the text being
// typed, keyed by row id so a rebuilt list keeps its place.
import { field, fieldKey, fieldState, spans, textWidth, truncate, wrap, type FieldState, type Key, type Rect, type Screen, type Spans, type Style } from '@augur/terminal';
import type { Hint } from './page.js';
import type { Theme } from './theme.js';

type Done = void | Promise<void>;

/** `indent` sets a row under the one above it, as a provider's own settings sit under its switch. */
interface Base { id: string; label: string; desc?: string; indent?: boolean }

export type Row =
  | { kind: 'heading'; text: string }
  | { kind: 'note'; text: string; style?: 'muted' | 'warn' | 'crit' | 'good' | 'bold'; indent?: boolean }
  | (Base & { kind: 'toggle'; on: boolean; set(on: boolean): Done; disabled?: boolean; dot?: Style; badge?: string; enter?(): Done; open?: boolean })
  | (Base & { kind: 'choice'; value: string; options: ReadonlyArray<readonly [string, string]>; set(value: string): Done })
  | (Base & { kind: 'text'; value: string; placeholder?: string; mask?: boolean; badge?: string; save(value: string): Done })
  | (Base & { kind: 'action'; button: string; run(): Done; disabled?: boolean })
  | (Base & { kind: 'checks'; cells: ReadonlyArray<{ label?: string; on: boolean }>; set(index: number, on: boolean): Done; cellW?: number })
  | { kind: 'columns'; id: string; labels: string[]; cellW: number };

type Focusable = Exclude<Row, { kind: 'heading' | 'note' | 'columns' }>;

const focusable = (r: Row): r is Focusable => r.kind !== 'heading' && r.kind !== 'note' && r.kind !== 'columns';

/** One drawn line of the form: the row it belongs to, and how to draw it. */
interface Line { row: number; draw(screen: Screen, x: number, y: number, w: number): void }

export class Form {
  /** The id of the row with focus. */
  focus = '';
  top = 0;
  cell = 0;
  private editing: { id: string; state: FieldState } | null = null;
  private pageRows = 10;

  typing(): boolean { return this.editing !== null; }

  private focused(rows: Row[]): Focusable | undefined {
    const list = rows.filter(focusable);
    return list.find((r) => r.id === this.focus) ?? list[0];
  }

  draw(screen: Screen, r: Rect, rows: Row[], theme: Theme): void {
    const cur = this.focused(rows);
    if (cur) this.focus = cur.id;
    // The label column fits the longest label, up to half the width, so the controls line up in one column.
    const longest = Math.max(0, ...rows.filter(focusable).map((x) => textWidth(x.label) + (x.kind === 'toggle' && x.dot ? 2 : 0) + (x.indent ? 2 : 0)));
    const labelW = Math.max(12, Math.min(longest + 2, Math.floor(r.w * 0.5)));
    const lines = this.layout(rows, r.w, labelW, theme, cur);
    this.pageRows = Math.max(1, r.h - 1);
    const idx = cur ? rows.indexOf(cur) : -1;
    const first = lines.findIndex((l) => l.row === idx), last = lines.map((l) => l.row).lastIndexOf(idx);
    if (first >= 0) {
      // Show the heading or columns row just above the focused row when there is room, so a section never scrolls in without its title.
      let want = first;
      while (want > 0 && lines[want - 1]!.row !== idx && !focusable(rows[lines[want - 1]!.row]!) && first - want < 2) want--;
      if (want < this.top) this.top = want;
      if (last >= this.top + r.h) this.top = Math.min(first, last - r.h + 1);
    }
    this.top = Math.max(0, Math.min(this.top, Math.max(0, lines.length - r.h)));
    lines.slice(this.top, this.top + r.h).forEach((l, i) => l.draw(screen, r.x, r.y + i, r.w));
    if (this.top > 0) screen.put(r.x + r.w - 1, r.y, '^', theme.muted);
    if (this.top + r.h < lines.length) screen.put(r.x + r.w - 1, r.y + r.h - 1, 'v', theme.muted);
  }

  private layout(rows: Row[], w: number, labelW: number, theme: Theme, cur: Focusable | undefined): Line[] {
    const out: Line[] = [];
    const ctlX = labelW + 2;
    rows.forEach((row, i) => {
      const add = (draw: Line['draw']) => out.push({ row: i, draw });
      if (row.kind === 'heading') {
        if (out.length) add(() => {});
        add((s, x, y, cw) => spans(s, x, y, cw, row.text, { ...theme.heading, ...theme.accent }));
        return;
      }
      if (row.kind === 'note') {
        const style: Style = row.style === 'warn' ? theme.warn : row.style === 'crit' ? theme.crit : row.style === 'good' ? theme.good : row.style === 'bold' ? theme.heading : theme.muted;
        const ind = row.indent ? 2 : 0;
        for (const text of wrap(row.text, Math.max(10, w - 4 - ind))) add((s, x, y, cw) => spans(s, x + 2 + ind, y, cw - 2 - ind, text, style));
        return;
      }
      if (row.kind === 'columns') {
        add((s, x, y, cw) => row.labels.forEach((label, c) => s.put(x + ctlX + c * row.cellW, y, truncate(label, row.cellW - 1), theme.muted, Math.max(0, cw - ctlX - c * row.cellW))));
        return;
      }
      const on = row === cur, ind = row.indent ? 2 : 0;
      const labelStyle: Style = on ? theme.selected : {};
      add((s, x, y, cw) => {
        const pointer = on ? s.glyphs.pointer : ' ';
        s.put(x, y, pointer, theme.accent);
        let lx = x + 2 + ind;
        if (row.kind === 'toggle' && row.dot) lx = s.put(lx, y, s.glyphs.dot, row.dot) + 1;
        const room = Math.max(0, x + labelW - lx);
        s.put(lx, y, truncate(row.label, room), labelStyle, room);
        this.control(s, x + ctlX, y, Math.max(0, cw - ctlX), row, on, theme);
      });
      if (row.desc) for (const text of wrap(row.desc, Math.max(10, w - 6 - ind))) add((s, x, y, cw) => spans(s, x + 4 + ind, y, cw - 4 - ind, text, theme.muted));
    });
    return out;
  }

  private control(s: Screen, x: number, y: number, w: number, row: Focusable, on: boolean, theme: Theme): void {
    if (w <= 0) return;
    const badge = (at: number, text: string | undefined) => { if (text) s.put(at + 1, y, text, theme.good, Math.max(0, x + w - at - 1)); };
    switch (row.kind) {
      case 'toggle': {
        const at = s.put(x, y, row.on ? '[x] On ' : '[ ] Off', row.disabled ? theme.muted : row.on ? theme.good : theme.muted, w);
        badge(at, row.badge);
        if (row.enter) s.put(at + 1 + (row.badge ? textWidth(row.badge) + 1 : 0), y, row.open ? '(Enter to close)' : '(Enter for more)', theme.muted, Math.max(0, x + w - at - 1));
        return;
      }
      case 'choice': {
        const label = row.options.find(([v]) => v === row.value)?.[1] ?? row.value;
        spans(s, x, y, w, [['< ', on ? theme.accent : theme.muted], [label, on ? theme.accent : {}], [' >', on ? theme.accent : theme.muted]]);
        return;
      }
      case 'text': {
        const editing = this.editing?.id === row.id ? this.editing.state : null;
        const fw = Math.min(w - (row.badge ? textWidth(row.badge) + 1 : 0), 48);
        field(s, x, y, Math.max(1, fw), editing ?? fieldState(row.value), {
          focused: !!editing, mask: !!row.mask && !!editing, placeholder: row.placeholder ?? '',
          style: editing ? { underline: true, ...theme.accent } : { underline: true },
        });
        badge(x + fw, row.badge);
        return;
      }
      case 'action':
        s.put(x, y, `[ ${row.button} ]`, row.disabled ? theme.muted : on ? { ...theme.accent, bold: true } : theme.accent, w);
        return;
      case 'checks': {
        let at = x;
        row.cells.forEach((c, i) => {
          const text = `[${c.on ? 'x' : ' '}]${c.label ? ` ${c.label}` : ''}`;
          const style = on && i === this.cell ? theme.selected : c.on ? theme.good : theme.muted;
          s.put(at, y, text, style, Math.max(0, x + w - at));
          at += row.cellW ?? textWidth(text) + 2;
        });
      }
    }
  }

  hints(rows: Row[]): Hint[] {
    if (this.editing) return [['Enter', 'Save'], ['Esc', 'Cancel']];
    const cur = this.focused(rows);
    const move: Hint = ['Up/Down', 'Move'];
    if (!cur) return [];
    switch (cur.kind) {
      case 'toggle': return [move, ['Space', 'Turn on or off'], ...(cur.enter ? [['Enter', 'More settings'] as Hint] : [])];
      case 'choice': return [move, ['Left/Right', 'Change']];
      case 'text': return [move, ['Enter', 'Edit']];
      case 'action': return [move, ['Enter', cur.button]];
      case 'checks': return [move, ['Left/Right', 'Pick'], ['Space', 'Tick or untick']];
    }
  }

  async key(key: Key, rows: Row[]): Promise<boolean> {
    const list = rows.filter(focusable);
    if (this.editing) return this.editKey(key, list);
    const cur = this.focused(rows);
    if (!cur) return false;
    const i = list.indexOf(cur);
    const go = (n: number) => { const next = list[Math.max(0, Math.min(list.length - 1, n))]; if (next) { this.focus = next.id; if (next.kind === 'checks') this.cell = Math.min(this.cell, next.cells.length - 1); } return true; };
    switch (key.label) {
      case 'up': case 'k': return go(i - 1);
      case 'down': case 'j': return go(i + 1);
      case 'pageup': return go(i - Math.max(1, Math.floor(this.pageRows / 2)));
      case 'pagedown': return go(i + Math.max(1, Math.floor(this.pageRows / 2)));
      case 'home': return go(0);
      case 'end': return go(list.length - 1);
    }
    const side = key.label === 'left' || key.label === 'h' ? -1 : key.label === 'right' || key.label === 'l' ? 1 : 0;
    switch (cur.kind) {
      case 'toggle':
        if (key.label === ' ' || (key.label === 'enter' && !cur.enter)) { if (!cur.disabled) await cur.set(!cur.on); return true; }
        if (key.label === 'enter' && cur.enter) { await cur.enter(); return true; }
        return false;
      case 'choice': {
        const step = side || (key.label === ' ' || key.label === 'enter' ? 1 : 0);
        if (!step) return false;
        const at = cur.options.findIndex(([v]) => v === cur.value);
        const next = cur.options[(at + step + cur.options.length) % cur.options.length];
        if (next) await cur.set(next[0]);
        return true;
      }
      case 'text':
        if (key.label !== 'enter') return false;
        this.editing = { id: cur.id, state: fieldState(cur.mask ? '' : cur.value) };
        return true;
      case 'action':
        if (key.label !== 'enter' && key.label !== ' ') return false;
        if (!cur.disabled) await cur.run();
        return true;
      case 'checks':
        if (side) { this.cell = Math.max(0, Math.min(cur.cells.length - 1, this.cell + side)); return true; }
        if (key.label === ' ' || key.label === 'enter') { const c = cur.cells[this.cell]; if (c) await cur.set(this.cell, !c.on); return true; }
        return false;
    }
  }

  private async editKey(key: Key, list: Focusable[]): Promise<boolean> {
    const ed = this.editing!;
    const row = list.find((r) => r.id === ed.id);
    if (key.label === 'escape' || !row || row.kind !== 'text') { this.editing = null; return true; }
    if (key.label === 'enter') {
      this.editing = null;
      const value = ed.state.value.trim();
      if (value !== row.value || row.mask) await row.save(value);
      return true;
    }
    fieldKey(ed.state, key);
    return true;
  }
}
