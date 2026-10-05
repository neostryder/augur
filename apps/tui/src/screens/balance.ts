// The balance page: what the router is doing now, in the same words as `augur balance` and the window app. Read-only; the keys only scroll.
import { reportHeading, reportSections, type BalanceReport } from '@augur/dispatch-protocol';
import { list, listKey, listState, spans, wrap, type Key, type Rect, type Screen, type Style } from '@augur/terminal';
import type { Ctx, Hint, Page } from '../page.js';

interface Row { text: string; style: Style }

export class BalancePage implements Page {
  name = 'Balance';
  private sel = listState();
  private report: BalanceReport | null = null;
  private problem = '';
  private busy = false;

  private rows(width: number): Row[] {
    const r = this.report;
    if (!r) return [];
    const out: Row[] = [{ text: reportHeading(r), style: { bold: true } }];
    for (const sec of reportSections(r)) {
      out.push({ text: '', style: {} }, { text: sec.title, style: { bold: true } });
      for (const line of sec.lines) for (const piece of wrap(line, Math.max(10, width - 2))) out.push({ text: '  ' + piece, style: {} });
    }
    return out;
  }

  async refresh(ctx: Ctx): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const got = await ctx.link.call('balance', { days: 7 });
      if ('error' in got) { this.problem = got.error; this.report = null; } else { this.problem = ''; this.report = got; }
    } catch (e) {
      this.problem = (e as Error).message;
    } finally {
      this.busy = false;
      ctx.redraw();
    }
  }

  draw(screen: Screen, r: Rect, ctx: Ctx): void {
    const area = { x: r.x + 1, y: r.y, w: r.w - 2, h: r.h };
    if (!this.report) {
      const text = this.problem || 'Reading the balance report.';
      wrap(text, area.w).forEach((line, i) => spans(screen, area.x, area.y + i, area.w, line, { dim: true }));
      return;
    }
    void ctx;
    list(screen, area, this.rows(area.w), this.sel, (row) => [[row.text, row.style]], { focused: false });
  }

  key(key: Key): boolean {
    return listKey(this.sel, key, this.rows(80).length, 10);
  }

  hints(): Hint[] {
    return [['j k', 'scroll']];
  }
}
