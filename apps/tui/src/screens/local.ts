// The local compute page: the machines behind the Cogitator gateway, the models each holds, and each role's chain, in the same words as the window app. Read-only; the keys only scroll.
import { LOCAL_TEXT, localPage, type LocalPage } from '@augur/view-model';
import { list, listKey, listState, spans, wrap, type Key, type Rect, type Screen, type Style } from '@augur/terminal';
import type { Ctx, Hint, Page } from '../page.js';

interface Row { text: string; style: Style }

const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length);

export class LocalComputePage implements Page {
  name = 'Local';
  private sel = listState();

  private rows(p: LocalPage, width: number): Row[] {
    const out: Row[] = [{ text: `${p.summary}${p.checked ? `, checked ${p.checked}` : ''}`, style: { bold: true } }];
    if (p.stale) out.push({ text: LOCAL_TEXT.notReachable, style: { dim: true } });
    const gap = (): void => { out.push({ text: '', style: {} }); };
    const c = LOCAL_TEXT.columns;
    gap(); out.push({ text: LOCAL_TEXT.machines, style: { bold: true } });
    for (const m of p.machines) {
      out.push({ text: `  ${m.name}${m.self ? ' (this gateway)' : ''}${m.usedPct === null ? '' : `, ${m.usedPct}% of memory held`}`, style: m.up ? {} : { dim: true } });
      for (const piece of wrap(m.line, Math.max(10, width - 6))) out.push({ text: '    ' + piece, style: { dim: true } });
      if (m.up && m.models.length) {
        out.push({ text: `    ${pad(c.model, 22)}${pad(c.role, 14)}${pad(c.held, 9)}${c.lastUsed}`, style: { dim: true } });
        for (const r of m.models) out.push({ text: `    ${pad(r.id, 22)}${pad(r.role, 14)}${pad(r.held, 9)}${r.lastUsed || (r.loaded ? '' : r.state)}`, style: r.loaded ? {} : { dim: true } });
      }
    }
    gap(); out.push({ text: LOCAL_TEXT.roles, style: { bold: true } });
    if (!p.roles.length) out.push({ text: '  ' + LOCAL_TEXT.noRoles, style: { dim: true } });
    for (const r of p.roles) {
      out.push({ text: `  ${r.chip}`, style: r.tone === 'down' ? { dim: true } : {} });
      const chain = r.chain.map((s) => (s.serving ? `[${s.text}]` : s.up ? s.text : `${s.text} (down)`)).join(' > ');
      for (const piece of wrap(chain, Math.max(10, width - 6))) out.push({ text: '    ' + piece, style: {} });
      if (r.note) for (const piece of wrap(r.note, Math.max(10, width - 6))) out.push({ text: '    ' + piece, style: { dim: true } });
    }
    return out;
  }

  draw(screen: Screen, r: Rect, ctx: Ctx): void {
    const area = { x: r.x + 1, y: r.y, w: r.w - 2, h: r.h };
    const page = localPage(ctx.state.snapshot, ctx.now);
    if (!page) {
      const on = ctx.state.config.providers.some((p) => p.id === 'cogitator' && p.enabled);
      wrap(on ? LOCAL_TEXT.waiting : LOCAL_TEXT.empty, area.w).forEach((line, i) => spans(screen, area.x, area.y + i, area.w, line, { dim: true }));
      return;
    }
    list(screen, area, this.rows(page, area.w), this.sel, (row) => [[row.text, row.style]], { focused: false });
  }

  key(key: Key, ctx: Ctx): boolean {
    const page = localPage(ctx.state.snapshot, ctx.now);
    return listKey(this.sel, key, page ? this.rows(page, 80).length : 0, 10);
  }

  hints(): Hint[] {
    return [['j k', 'scroll']];
  }
}
