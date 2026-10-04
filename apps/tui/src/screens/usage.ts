// The usage page: one block per provider with a bar for each limit, the most-used limit at the top, and a seven-day chart for the
// selected limit. The arrow keys move between providers and limits; the selection follows the item, not the row, as figures change.
import { allPlugins, type AppConfig, type HistoryRow, type Meter, type ProviderSnapshot } from '@augur/core';
import { bar, box, center, spans, textWidth, wrap, type Key, type Rect, type Screen, type Spans, type Style } from '@augur/terminal';
import { USAGE_TEXT, ago, errorText, money, notesParts, paceInfo, series, sevOf, statusLabel, tightest, until, windowed } from '@augur/view-model';
import type { Ctx, Hint, Overlay, Page } from '../page.js';
import { sevStyle, type Theme } from '../theme.js';

const SPARK_MIN_WIDTH = 100;
const SPARK_CELLS = 24;
const DAY = 86400e3;

/** One row of the page. `item` names what selecting the row selects: a provider ('p:id') or a limit ('m:id|meter'). */
interface Row { item?: string; draw(screen: Screen, x: number, y: number, w: number, selected: boolean): void }

export class UsagePage implements Page {
  name = 'Usage';
  /** The selected provider or limit, kept by name so it stays put when the rows above it change. */
  selected = '';
  private top = 0;

  private enabled(config: AppConfig): string[] {
    return config.providers.filter((p) => p.enabled).map((p) => p.id);
  }

  rows(ctx: Ctx, w: number): Row[] {
    const { state, theme, now } = ctx, config = state.config, snap = state.snapshot;
    const names = new Map(allPlugins(config).map((p) => [p.id, p]));
    const out: Row[] = [];
    const t = tightest(config, snap);
    if (t) {
      const pct = Math.round(t.m.usedPct!), sev = sevOf(t.m.usedPct!);
      const label = `${t.p.name}, ${t.m.label.charAt(0).toLowerCase()}${t.m.label.slice(1)}`;
      out.push({ draw: (s, x, y, ww) => spans(s, x, y, ww, [[`${pct}%`, { ...sevStyle(theme, sev), bold: true }], ['  '], [label, { bold: true }], ['  '], [until(t.m.resetsAt, now) || USAGE_TEXT.mostUsed, { dim: true }]]) });
      out.push(blank);
    }
    const inner = w - 2;
    const visible = (pid: string, p: ProviderSnapshot | undefined) => (p?.meters ?? []).filter((m) => !(config.layout.hiddenMeters[pid] ?? []).includes(m.id));
    const labelW = Math.min(18, Math.max(8, ...this.enabled(config).flatMap((pid) => visible(pid, snap?.providers[pid]).map((m) => textWidth(m.label)))));
    for (const pid of this.enabled(config)) {
      const p = snap?.providers[pid], plugin = names.get(pid);
      const collapsed = config.layout.collapsed.includes(pid);
      out.push({ item: `p:${pid}`, draw: (s, x, y, ww, sel) => this.header(s, x, y, ww, sel, theme, pid, p, plugin?.name ?? pid, collapsed, now) });
      if (collapsed) continue;
      if (!p) { out.push(text(USAGE_TEXT.waiting, { dim: true })); out.push(blank); continue; }
      for (const m of visible(pid, p)) {
        const pc = paceInfo(m, state.history, pid, now);
        out.push({ item: `m:${pid}|${m.id}`, draw: (s, x, y, ww, sel) => this.meterRow(s, x, y, ww, sel, theme, labelW, state.history, pid, m, pc.elapsedPct, now) });
        const foot = this.meterFoot(theme, m, pc, now);
        if (foot.length) out.push({ draw: (s, x, y, ww) => spans(s, x + 2 + labelW + 2, y, ww - labelW - 4, foot) });
      }
      const hidden = config.layout.hiddenMeters[pid] ?? [];
      const tiles = p.money.filter((x) => x.amount != null && !hidden.includes('$' + x.id));
      if (tiles.length) {
        const list: Array<readonly [string, Style?]> = tiles.flatMap((x, i) => [...(i ? [['   '] as const] : []), [`${x.label} `, { dim: true }] as const,
          [money(x.amount, x.currency), { bold: true }] as const, ...(x.total != null ? [[` of ${money(x.total, x.currency)}`, { dim: true }] as const] : [])]);
        out.push({ draw: (s, x, y, ww) => spans(s, x + 2, y, ww - 2, list) });
      }
      for (const n of notesParts(p)) for (const line of wrap(n, inner - 2)) out.push(text(line, { dim: true }, 2));
      if (p.error) for (const line of wrap(errorText(p, (iso) => ago(iso, now)), inner - 2)) out.push(text(line, theme.crit, 2));
      out.push(blank);
    }
    return out;
  }

  private header(s: Screen, x: number, y: number, w: number, sel: boolean, theme: Theme, pid: string, p: ProviderSnapshot | undefined, name: string, collapsed: boolean, now: number): void {
    const st = p ? statusLabel(p) : null;
    const left: Array<readonly [string, Style?]> = [[collapsed ? '+ ' : '  ', { dim: true }], [s.glyphs.dot + ' ', theme.provider(pid)], [name, { bold: true, inverse: sel }]];
    if (p?.plan) left.push(['  ' + p.plan, { dim: true }]);
    if (st) left.push(['  ' + st.label, st.severe ? theme.crit : theme.warn]);
    const right = p?.fetchedAt ? `${p.stale ? 'Stale, updated ' : ''}${ago(p.fetchedAt, now)}` : '';
    const end = spans(s, x, y, w - right.length - 2, left);
    if (right && end < x + w - right.length) s.put(x + w - right.length, y, right, p?.stale ? theme.warn : { dim: true });
  }

  private meterRow(s: Screen, x: number, y: number, w: number, sel: boolean, theme: Theme, labelW: number, history: HistoryRow[], pid: string, m: Meter, elapsed: number | null, now: number): void {
    const pct = m.usedPct, sev = pct == null ? '' : sevOf(pct);
    s.put(x, y, sel ? s.glyphs.pointer : ' ', theme.accent);
    spans(s, x + 2, y, labelW, m.label, sel ? { bold: true, inverse: true } : {});
    const spark = w >= SPARK_MIN_WIDTH ? SPARK_CELLS + 2 : 0;
    const bx = x + 2 + labelW + 2, bw = Math.max(4, w - labelW - 4 - 6 - spark);
    bar(s, bx, y, bw, (pct ?? 0) / 100, sevStyle(theme, sev));
    // The tick marks where the bar would be if the limit were being used evenly across its window.
    if (elapsed != null && windowed(m)) {
      const at = Math.min(bw - 1, Math.round((elapsed / 100) * bw));
      if (at >= Math.ceil(((pct ?? 0) / 100) * bw)) s.put(bx + at, y, s.glyphs.tick, { dim: true });
    }
    if (spark) sparkline(s, bx + bw + 2, y, SPARK_CELLS, series(history, pid, m.id), now, theme.accent);
    const label = pct == null ? '-' : `${Math.round(pct)}%`;
    s.put(x + w - label.length, y, label, sev ? { ...sevStyle(theme, sev), bold: true } : { bold: true });
  }

  private meterFoot(theme: Theme, m: Meter, pc: { text: string; bad: boolean }, now: number): Array<readonly [string, Style?]> {
    const sev = m.usedPct == null ? '' : sevOf(m.usedPct);
    const parts: Array<readonly [string, Style?]> = [];
    const foot = [until(m.resetsAt, now), m.detail ?? ''].filter(Boolean).join(', ');
    if (foot) parts.push([foot, { dim: true }]);
    if (pc.text) parts.push([(parts.length ? '   ' : '') + pc.text, pc.bad ? theme.warn : { dim: true }]);
    if (sev) parts.push([(parts.length ? '   ' : '') + (sev === 'crit' ? USAGE_TEXT.nearLimit : USAGE_TEXT.high), sevStyle(theme, sev)]);
    return parts;
  }

  draw(screen: Screen, r: Rect, ctx: Ctx): void {
    const area = { x: r.x + 1, y: r.y, w: r.w - 2, h: r.h };
    if (!this.enabled(ctx.state.config).length) {
      const c = center(area, Math.min(area.w, 50), 2);
      spans(screen, c.x, c.y, c.w, USAGE_TEXT.none, { bold: true });
      spans(screen, c.x, c.y + 1, c.w, 'Press 5 to turn providers on in Settings.', { dim: true });
      return;
    }
    const rows = this.rows(ctx, area.w);
    const items = rows.flatMap((row) => (row.item ? [row.item] : []));
    if (!items.includes(this.selected)) this.selected = items.find((i) => i.startsWith('m:')) ?? items[0] ?? '';
    const at = rows.findIndex((row) => row.item === this.selected);
    // Keep the selected row and the line under it on screen.
    if (at >= 0) {
      if (at < this.top) this.top = Math.max(0, at - (at > 0 && !rows[at - 1]!.item ? 1 : 0));
      if (at + 1 >= this.top + area.h) this.top = at + 2 - area.h;
    }
    this.top = Math.max(0, Math.min(this.top, Math.max(0, rows.length - area.h)));
    for (let i = 0; i < area.h && this.top + i < rows.length; i++) {
      const row = rows[this.top + i]!;
      row.draw(screen, area.x, area.y + i, area.w, row.item === this.selected);
    }
  }

  private items(ctx: Ctx): string[] {
    return this.rows(ctx, 80).flatMap((row) => (row.item ? [row.item] : []));
  }

  async key(key: Key, ctx: Ctx): Promise<boolean> {
    const items = this.items(ctx), i = Math.max(0, items.indexOf(this.selected));
    const pid = this.selected.slice(2).split('|')[0]!;
    switch (key.label) {
      case 'up': case 'k': this.selected = items[Math.max(0, i - 1)] ?? ''; return true;
      case 'down': case 'j': this.selected = items[Math.min(items.length - 1, i + 1)] ?? ''; return true;
      case 'pageup': this.selected = items[Math.max(0, i - 8)] ?? ''; return true;
      case 'pagedown': this.selected = items[Math.min(items.length - 1, i + 8)] ?? ''; return true;
      case 'home': case 'g': this.selected = items[0] ?? ''; return true;
      case 'end': case 'G': this.selected = items[items.length - 1] ?? ''; return true;
      case ' ': await this.toggle(ctx, pid); return true;
      case 'enter':
        if (this.selected.startsWith('p:')) { await this.toggle(ctx, pid); return true; }
        if (this.selected.startsWith('m:')) { this.chart(ctx); return true; }
        return false;
      case 'alt+up': case 'alt+k': await this.move(ctx, pid, -1); return true;
      case 'alt+down': case 'alt+j': await this.move(ctx, pid, 1); return true;
      case 'o': {
        const url = ctx.state.snapshot?.providers[pid]?.links?.usage ?? allPlugins(ctx.state.config).find((p) => p.id === pid)?.links.usage;
        if (url) ctx.open(url); else ctx.flash('This provider has no usage page to open.');
        return true;
      }
    }
    return false;
  }

  /** Collapses or expands a provider, and moves the selection to its name so it does not vanish. */
  private async toggle(ctx: Ctx, pid: string): Promise<void> {
    if (!pid) return;
    const config = structuredClone(ctx.state.config), list = config.layout.collapsed;
    config.layout.collapsed = list.includes(pid) ? list.filter((x) => x !== pid) : [...list, pid];
    this.selected = `p:${pid}`;
    await ctx.run('saveConfig', config);
  }

  /** Moves a provider up or down among the ones that are turned on. */
  private async move(ctx: Ctx, pid: string, by: -1 | 1): Promise<void> {
    const config = structuredClone(ctx.state.config), list = config.providers;
    const from = list.findIndex((p) => p.id === pid);
    if (from < 0) return;
    let to = from + by;
    while (to >= 0 && to < list.length && !list[to]!.enabled) to += by;
    if (to < 0 || to >= list.length) return;
    [list[from], list[to]] = [list[to]!, list[from]!];
    await ctx.run('saveConfig', config);
  }

  private chart(ctx: Ctx): void {
    const [pid, mid] = this.selected.slice(2).split('|') as [string, string];
    const p = ctx.state.snapshot?.providers[pid], m = p?.meters.find((x) => x.id === mid);
    if (p && m) ctx.overlay(chartOverlay(p, m));
  }

  hints(): Hint[] {
    return this.selected.startsWith('m:')
      ? [['Enter', '7-day chart'], ['Space', 'Collapse'], ['Alt+Up/Down', 'Move'], ['o', 'Usage page'], ['r', 'Refresh']]
      : [['Space', 'Collapse or expand'], ['Alt+Up/Down', 'Move'], ['o', 'Usage page'], ['r', 'Refresh']];
  }
}

const blank: Row = { draw: () => {} };

function text(t: Spans, style: Style, indent = 0): Row {
  return { draw: (s, x, y, w) => spans(s, x + indent, y, w - indent, t, style) };
}

/** The last 24 hours of one limit in `w` cells, one block per stretch of time, as high as the last reading in it. */
export function sparkline(s: Screen, x: number, y: number, w: number, points: Array<[number, number]>, now: number, style: Style): void {
  const cut = now - DAY, pts = points.filter(([t]) => t >= cut);
  if (pts.length < 2) return;
  const cells = new Array<number | null>(w).fill(null);
  for (const [t, v] of pts) cells[Math.min(w - 1, Math.floor(((t - cut) / DAY) * w))] = v;
  const lv = s.glyphs.levels;
  s.put(x, y, cells.map((v) => (v == null ? ' ' : lv[Math.max(0, Math.min(7, Math.floor((v / 100) * 8)))]!)).join(''), style);
}

/** A seven-day column chart of one limit, over the page. */
export function chartOverlay(p: ProviderSnapshot, m: Meter): Overlay {
  return {
    draw(screen, ctx) {
      const r = center({ x: 0, y: 0, w: screen.width, h: screen.height - 1 }, Math.min(screen.width - 4, 100), Math.min(screen.height - 4, 18));
      screen.fill(r.x, r.y, r.w, r.h);
      const inside = box(screen, r, { title: `${p.name}, ${m.label}: last 7 days`, titleStyle: { bold: true } });
      const pts = series(ctx.state.history, p.id, m.id).filter(([t]) => t >= ctx.now - 7 * DAY);
      if (pts.length < 2) { spans(screen, inside.x + 1, inside.y, inside.w - 2, USAGE_TEXT.historyEmpty, { dim: true }); return; }
      columnChart(screen, { x: inside.x + 1, y: inside.y, w: inside.w - 2, h: inside.h }, pts, ctx.now, ctx.theme.accent);
    },
  };
}

/** Columns of percent used over seven days, each as high as the highest reading in its stretch, with a scale and day names. */
export function columnChart(s: Screen, r: Rect, pts: Array<[number, number]>, now: number, style: Style): void {
  const axis = 5, plot = { x: r.x + axis, y: r.y, w: r.w - axis, h: r.h - 2 };
  if (plot.w < 7 || plot.h < 3) return;
  const x0 = now - 7 * DAY, cols = new Array<number | null>(plot.w).fill(null);
  for (const [t, v] of pts) { const c = Math.min(plot.w - 1, Math.floor(((t - x0) / (7 * DAY)) * plot.w)); cols[c] = Math.max(cols[c] ?? 0, v); }
  for (const [v, y] of [[100, plot.y], [50, plot.y + Math.round((plot.h - 1) / 2)], [0, plot.y + plot.h - 1]] as const) s.put(r.x, y, `${v}%`.padStart(4), { dim: true });
  const lv = s.glyphs.levels;
  cols.forEach((v, c) => {
    if (v == null) return;
    const eighths = Math.round((Math.max(0, Math.min(100, v)) / 100) * plot.h * 8);
    for (let row = 0; row < plot.h; row++) {
      const left = eighths - row * 8;
      if (left <= 0) break;
      s.put(plot.x + c, plot.y + plot.h - 1 - row, left >= 8 ? s.glyphs.fullBlock : lv[left - 1]!, style);
    }
  });
  const base = r.y + r.h - 2;
  s.put(plot.x, base, s.glyphs.border.single[1].repeat(plot.w), { dim: true });
  for (let d = 6; d >= 1; d--) {
    if (plot.w < 56 && d % 2) continue;
    const t = now - d * DAY, c = Math.floor(((t - x0) / (7 * DAY)) * plot.w);
    s.put(plot.x + c, base + 1, new Date(t).toLocaleDateString([], { weekday: 'short' }), { dim: true });
  }
  const count = `${pts.length} readings`;
  s.put(r.x + r.w - count.length, base + 1, count, { dim: true });
}
