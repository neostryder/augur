// The terminal app's frame: a tab row at the top, the page in the middle, key hints and messages at the bottom, and panels such as help
// drawn over the page. It owns the global keys (switching pages, refresh, help, quit) and passes everything else to the page.
import { box, center, inset, spans, tabs, type App, type Key, type Rect, type Screen } from '@augur/terminal';
import { ago } from '@augur/view-model';
import type { Link } from './link.js';
import type { Ctx, Hint, Overlay, Page } from './page.js';
import { themeFor } from './theme.js';

const FLASH_MS = 5000;

export interface TuiOptions {
  link: Link;
  pages: Page[];
  redraw(): void;
  open(url: string): Promise<boolean>;
  pause?<T>(fn: () => T | Promise<T>): Promise<T>;
  copy?(text: string): void;
  now?: () => number;
}

const GLOBAL: Hint[] = [['1-5', 'Switch page'], ['Tab', 'Next page'], ['r', 'Refresh'], ['?', 'Help'], ['q', 'Quit']];

export class TuiApp implements App {
  active = 0;
  private overlays: Overlay[] = [];
  private flashText = '';
  private flashBad = false;
  private flashAt = 0;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly o: TuiOptions) {}

  private now(): number { return this.o.now?.() ?? Date.now(); }

  /** Null while the service is out of reach, since the pages have nothing to show then. */
  ctx(): Ctx | null {
    const state = this.o.link.state;
    if (!state || this.o.link.status !== 'up') return null;
    return {
      link: this.o.link, state, theme: themeFor(state.config), now: this.now(),
      redraw: () => this.o.redraw(),
      flash: (text, bad) => this.flash(text, bad),
      overlay: (ov) => { if (ov) this.overlays.push(ov); else this.overlays.pop(); this.o.redraw(); },
      open: (url) => { void this.o.open(url).then((ok) => this.flash(ok ? `Opened ${url}` : `No browser to open it in. The address is ${url}`, !ok)); },
      pause: (fn) => (this.o.pause ? this.o.pause(fn) : Promise.resolve().then(fn)),
      copy: (text) => this.o.copy?.(text),
      run: async (method, ...args) => {
        try { return await this.o.link.run(method, ...args); }
        catch (e) { this.flash((e as Error).message || 'That did not work.', true); return undefined; }
      },
    };
  }

  flash(text: string, bad = false): void {
    this.flashText = text; this.flashBad = bad; this.flashAt = this.now();
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => { this.flashTimer = null; this.flashText = ''; this.o.redraw(); }, FLASH_MS);
    this.flashTimer.unref?.();
    this.o.redraw();
  }

  get page(): Page { return this.o.pages[this.active]!; }

  /** Lets the open page read its own data from the service. Pages guard against overlapping reads themselves. */
  async poll(): Promise<void> {
    const ctx = this.ctx();
    if (ctx && this.page.refresh) await this.page.refresh(ctx).catch(() => {});
  }

  draw(screen: Screen): void {
    const ctx = this.ctx();
    const full: Rect = { x: 0, y: 0, w: screen.width, h: screen.height };
    if (screen.width < 30 || screen.height < 8) { spans(screen, 0, 0, screen.width, 'Make the terminal larger to use Augur.'); return; }
    const body: Rect = { x: 0, y: 2, w: full.w, h: full.h - 3 };
    this.header(screen, ctx);
    if (!ctx) this.offline(screen, body);
    else {
      this.page.draw(screen, body, ctx);
      for (const ov of this.overlays) ov.draw(screen, ctx);
    }
    this.footer(screen, ctx);
  }

  private header(screen: Screen, ctx: Ctx | null): void {
    const accent = ctx?.theme.accent ?? {};
    const x = screen.put(1, 0, 'Augur', { ...accent, bold: true }) + 3;
    const names = this.o.pages.map((p, i) => { const b = ctx && p.badge ? p.badge(ctx) : ''; return `${i + 1} ${p.name}${b ? ` (${b})` : ''}`; });
    const right = ctx ? (ctx.state.busy ? 'Refreshing' : ctx.state.snapshot ? `Updated ${ago(ctx.state.snapshot.generatedAt, ctx.now)}` : 'Not refreshed yet') : '';
    const room = screen.width - x - right.length - 2;
    tabs(screen, x, 0, room, names, this.active, { activeStyle: { ...accent, bold: true, underline: true } });
    if (right) screen.put(screen.width - right.length - 1, 0, right, { dim: !ctx?.state.busy, ...(ctx?.state.busy ? accent : {}) });
    screen.put(0, 1, screen.glyphs.border.single[1].repeat(screen.width), { dim: true });
  }

  private offline(screen: Screen, body: Rect): void {
    const l = this.o.link;
    const lines = l.status === 'starting' ? ['Starting the Augur service...']
      : l.status === 'connecting' ? ['Connecting to the Augur service...']
      : ['The Augur service cannot be reached.', l.error, 'Augur keeps trying every few seconds. Press r to try now, or q to quit.'];
    const w = Math.min(body.w - 4, Math.max(...lines.map((s) => s.length)) + 4);
    const r = center(body, w, lines.length + 2);
    const inside = box(screen, r, { style: { dim: true } });
    lines.forEach((s, i) => spans(screen, inside.x + 1, inside.y + i, inside.w - 2, s, i ? { dim: true } : { bold: true }));
  }

  private footer(screen: Screen, ctx: Ctx | null): void {
    const y = screen.height - 1;
    if (this.flashText) { spans(screen, 1, y, screen.width - 2, this.flashText, this.flashBad ? (ctx?.theme.crit ?? { bold: true }) : (ctx?.theme.accent ?? {})); return; }
    const top = this.overlays[this.overlays.length - 1];
    const hints: Hint[] = !ctx ? [['r', 'Try again'], ['q', 'Quit']] : top ? [...(top.hints?.(ctx) ?? []), ['Esc', 'Close']] : [...this.page.hints(ctx), ['?', 'Help'], ['q', 'Quit']];
    const list = hints.flatMap(([k, label], i) => [...(i ? [['  '] as const] : []), [k, { bold: true }] as const, [` ${label}`, { dim: true }] as const]);
    spans(screen, 1, y, screen.width - 2, list);
  }

  async key(key: Key): Promise<'quit' | boolean> {
    const ctx = this.ctx();
    if (!ctx) {
      if (key.label === 'q' || key.label === 'escape') return 'quit';
      if (key.label === 'r') void this.o.link.connect();
      return true;
    }
    const top = this.overlays[this.overlays.length - 1];
    if (top) {
      if (top.key && await top.key(key, ctx)) return true;
      if (key.label === 'escape' || key.label === 'q' || key.label === '?') { this.overlays.pop(); return true; }
      return key.label !== 'ctrl+c';
    }
    if (await this.page.key(key, ctx)) return true;
    // A focused text field keeps every key, so typing a digit or a q does not switch pages or quit.
    if (this.page.typing?.()) return key.label !== 'ctrl+c';
    if (/^[1-9]$/.test(key.label) && Number(key.label) <= this.o.pages.length) { this.active = Number(key.label) - 1; void this.poll(); return true; }
    switch (key.label) {
      case 'tab': this.active = (this.active + 1) % this.o.pages.length; void this.poll(); return true;
      case 'shift+tab': this.active = (this.active + this.o.pages.length - 1) % this.o.pages.length; void this.poll(); return true;
      case 'r': void ctx.run('refresh', true); return true;
      case '?': this.overlays.push(helpOverlay(this.page.hints(ctx))); return true;
      case 'q': return 'quit';
    }
    return false;
  }
}

/** The help panel: the current page's keys, then the ones that work everywhere. */
export function helpOverlay(pageHints: Hint[]): Overlay {
  return {
    draw(screen) {
      const groups: Array<[string, Hint[]]> = [['On this page', pageHints], ['Everywhere', GLOBAL]];
      const keyW = Math.max(...groups.flatMap(([, h]) => h.map(([k]) => k.length)));
      const lines = groups.flatMap(([title, h], i) => [...(i ? [null] : []), title, ...h.map((x) => x)]);
      const w = Math.min(screen.width - 4, Math.max(40, ...groups.flatMap(([, h]) => h.map(([k, l]) => keyW + l.length + 6))));
      const r = center({ x: 0, y: 0, w: screen.width, h: screen.height }, w, lines.length + 2);
      screen.fill(r.x, r.y, r.w, r.h);
      const inside = inset(box(screen, r, { title: 'Keys' }), 0, 1);
      lines.slice(0, inside.h).forEach((line, i) => {
        if (line === null) return;
        if (typeof line === 'string') { spans(screen, inside.x, inside.y + i, inside.w, line, { bold: true }); return; }
        spans(screen, inside.x, inside.y + i, inside.w, [[line[0].padEnd(keyW + 2), { bold: true }], [line[1], { dim: false }]]);
      });
    },
  };
}
