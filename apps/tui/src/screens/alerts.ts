// The alerts page: the same list as the window app's bell, newest first, with the selected alert's full text underneath. Dismissing one
// here clears it everywhere Augur shows it.
import { feedFor, type FeedAlert } from '@augur/core';
import { list, listKey, listState, rows, spans, wrap, type Key, type Rect, type Screen } from '@augur/terminal';
import { ALERTS_TEXT, shortAgo } from '@augur/view-model';
import type { Ctx, Hint, Page } from '../page.js';
import { sevStyle } from '../theme.js';

export class AlertsPage implements Page {
  name = ALERTS_TEXT.heading;
  private sel = listState();

  alerts(ctx: Ctx): FeedAlert[] {
    return [...feedFor(ctx.state.feed, 'augur')].sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));
  }

  badge(ctx: Ctx): string {
    const n = this.alerts(ctx).length;
    return n ? String(n) : '';
  }

  draw(screen: Screen, r: Rect, ctx: Ctx): void {
    const area = { x: r.x + 1, y: r.y, w: r.w - 2, h: r.h };
    const items = this.alerts(ctx);
    if (!items.length) {
      wrap(ALERTS_TEXT.empty, area.w).forEach((line, i) => spans(screen, area.x, area.y + i, area.w, line, { dim: true }));
      return;
    }
    const detail = Math.min(8, Math.max(4, Math.floor(area.h / 3)));
    const [top, , bottom, foot] = rows(area, ['flex', 1, detail, 1]);
    const now = new Date(ctx.now), g = screen.glyphs;
    const titleW = Math.min(40, Math.max(...items.map((a) => a.title.length)));
    list(screen, top!, items, this.sel, (a) => [
      [g.dot + ' ', sevStyle(ctx.theme, a.severity)],
      [a.title.padEnd(titleW), { bold: true }],
      ['  ' + shortAgo(a.raisedAt, now).padStart(3) + '  ', { dim: true }],
      [a.body.replace(/\s+/g, ' '), { dim: true }],
    ]);
    const a = items[this.sel.selected];
    if (a) {
      spans(screen, bottom!.x, bottom!.y, bottom!.w, a.title, { bold: true });
      wrap(a.body, bottom!.w).slice(0, bottom!.h - 1).forEach((line, i) => spans(screen, bottom!.x, bottom!.y + 1 + i, bottom!.w, line));
    }
    spans(screen, foot!.x, foot!.y, foot!.w, ALERTS_TEXT.foot, { dim: true });
  }

  async key(key: Key, ctx: Ctx): Promise<boolean> {
    const items = this.alerts(ctx);
    if (listKey(this.sel, key, items.length, 10)) return true;
    if (key.label === 'd' || key.label === 'delete') {
      const a = items[this.sel.selected];
      if (a) await ctx.run('dismiss', [a.id]);
      return true;
    }
    if (key.label === 'D') {
      if (items.length) await ctx.run('dismiss', items.map((a) => a.id));
      return true;
    }
    return false;
  }

  hints(ctx: Ctx): Hint[] {
    return this.alerts(ctx).length ? [['d', ALERTS_TEXT.dismiss], ['D', ALERTS_TEXT.dismissAll]] : [];
  }
}
