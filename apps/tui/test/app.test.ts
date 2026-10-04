import { describe, expect, it, vi } from 'vitest';
import type { EngineState } from '@augur/core';
import { Screen, ASCII } from '@augur/terminal';
import { Link } from '../src/link.js';
import { NOW, ch, k, setup, state } from './fixtures.js';
import { columnChart, sparkline, UsagePage } from '../src/screens/usage.js';

describe('frame', () => {
  it('shows the tabs, the alert count and the footer hints', () => {
    const { draw } = setup();
    const text = draw();
    expect(text.split('\n')[0]).toMatch(/Augur +1 Usage +2 Alerts \(2\) +3 Rules +4 Dispatch +5 Settings +Updated 3m ago/);
    expect(text.split('\n').at(-1)).toMatch(/Enter 7-day chart .* \? Help +q Quit/);
  });

  it('says when the service cannot be reached, and quits or retries from there', async () => {
    const { app, link, draw } = setup(null);
    expect(draw()).toContain('The Augur service cannot be reached.');
    expect(draw()).toContain('ENOENT');
    const connect = vi.spyOn(link, 'connect').mockResolvedValue();
    await app.key(ch('r'));
    expect(connect).toHaveBeenCalled();
    expect(await app.key(ch('q'))).toBe('quit');
  });

  it('switches pages with digits and Tab, and opens and closes help', async () => {
    const { app, draw } = setup();
    await app.key(ch('2'));
    expect(app.active).toBe(1);
    await app.key(k('tab'));
    expect(app.active).toBe(2);
    await app.key(k('tab', { shift: true }));
    await app.key(k('tab', { shift: true }));
    expect(app.active).toBe(0);
    await app.key(ch('?'));
    expect(draw()).toContain('Everywhere');
    await app.key(k('escape'));
    expect(draw()).not.toContain('Everywhere');
  });

  it('refreshes on r and shows engine errors in the footer', async () => {
    const { app, link, calls, draw } = setup();
    await app.key(ch('r'));
    expect(calls).toEqual([['refresh', [true]]]);
    link.run = async () => { throw new Error('No route to the engine.'); };
    await app.key(ch('r'));
    expect(draw().split('\n').at(-1)).toContain('No route to the engine.');
  });
});

describe('usage page', () => {
  it('draws the most-used limit, each provider and its limits', () => {
    const text = setup().draw();
    expect(text).toMatch(/91% +Claude, week/);
    expect(text).toMatch(/Claude +Max +3m ago/);
    expect(text).toMatch(/Session .*42%/);
    expect(text).toMatch(/Resets in 2h 0m, .* +On pace/);
    expect(text).toMatch(/Week .*91%\n +Near limit/);
    expect(text).toMatch(/Codex +Stale, updated 2h ago/);
    expect(text).toContain('Credits $12.50 of $50.00');
    expect(text).toContain('Refresh failed: Timed out. Showing the figures from 2h ago.');
    expect(text).not.toContain('Jev');
  });

  it('moves the selection, collapses a provider and reorders providers', async () => {
    const s = setup();
    s.draw();
    const p = s.app.page as UsagePage;
    expect(p.selected).toBe('m:claude|session');
    await s.app.key(k('down'));
    expect(p.selected).toBe('m:claude|week');
    await s.app.key(ch(' '));
    expect(s.calls[0]![0]).toBe('saveConfig');
    expect((s.calls[0]![1][0] as EngineState['config']).layout.collapsed).toEqual(['claude']);
    expect(p.selected).toBe('p:claude');
    await s.app.key(k('up', { alt: true }));
    expect(s.calls.length).toBe(1);
    await s.app.key(k('down', { alt: true }));
    expect((s.calls[1]![1][0] as EngineState['config']).providers.map((x) => x.id)).toEqual(['codex', 'jev', 'claude']);
  });

  it('adds a sparkline on a wide terminal', () => {
    expect(setup().draw(130).split('\n').find((l) => l.includes('Session'))).toMatch(/▁ +▄ +42%$/);
  });

  it('opens the usage page and the seven-day chart', async () => {
    const s = setup();
    s.draw();
    await s.app.key(ch('o'));
    expect(s.opened).toEqual(['https://claude.ai/settings/usage']);
    await s.app.key(k('enter'));
    const text = s.draw();
    expect(text).toContain('Claude, Session: last 7 days');
    expect(text).toContain('2 readings');
  });

  it('points to settings when no provider is on', () => {
    const st = state();
    st.config.providers.forEach((p) => { p.enabled = false; });
    expect(setup(st).draw()).toContain('No providers turned on yet.');
  });

  it('draws a sparkline and a column chart from readings', () => {
    const sc = new Screen(30, 1);
    sparkline(sc, 0, 0, 24, [[NOW - 20 * 3600e3, 0], [NOW - 3600e3, 100]], NOW, {});
    expect(sc.row(0).trimEnd()).toBe('    ▁' + ' '.repeat(18) + '█');
    const ascii = new Screen(40, 8, ASCII);
    columnChart(ascii, { x: 0, y: 0, w: 40, h: 8 }, [[NOW - 3600e3, 100], [NOW - 6 * 86400e3, 50]], NOW, {});
    expect(ascii.row(0)).toMatch(/^100%.*#$/);
    expect(ascii.row(6)).toMatch(/^ {5}-+$/);
  });
});

describe('alerts page', () => {
  it('lists the window app alerts newest first and dismisses them', async () => {
    const s = setup();
    await s.app.key(ch('2'));
    const text = s.draw();
    expect(text.indexOf('Codex at 90%')).toBeLessThan(text.indexOf('Claude at 75%'));
    expect(text).not.toContain('Phone only');
    expect(text).toContain('Dismissing an alert here clears it everywhere Augur shows it.');
    await s.app.key(ch('d'));
    expect(s.calls).toEqual([['dismiss', [['a2']]]]);
    await s.app.key(ch('D'));
    expect(s.calls[1]).toEqual(['dismiss', [['a2', 'a1']]]);
  });

  it('says so when there are none', async () => {
    const st = state();
    st.feed.alerts = [];
    const s = setup(st);
    await s.app.key(ch('2'));
    expect(s.draw()).toContain('No alerts.');
  });
});

describe('link', () => {
  it('starts the service once, then keeps trying', async () => {
    const st = state();
    let tries = 0;
    const watch = vi.fn(async () => { tries++; if (tries === 1) throw Object.assign(new Error('not running'), { code: 'unreachable' }); return { state: st, views: [], close() {} }; });
    const launch = vi.fn(async () => ({ pid: 1 }));
    const link = new Link({ watch: watch as never, launch });
    await link.connect();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(link.status).toBe('up');
    expect(link.state).toBe(st);
    link.close();
  });

  it('applies changes and reports a dropped connection', async () => {
    const st = state();
    let handlers: Parameters<typeof import('@augur/augurd').watchEngine>[1] = {};
    const link = new Link({ watch: (async (_h: unknown, hs: typeof handlers) => { handlers = hs; return { state: st, views: [], close() {} }; }) as never, retryMs: 60000 });
    const seen: Array<string[] | null> = [];
    link.onChange((keys) => seen.push(keys));
    await link.connect();
    handlers!.change!(['busy'], { busy: true });
    expect(link.state!.busy).toBe(true);
    handlers!.closed!(new Error('gone'));
    expect([link.status, link.error]).toEqual(['down', 'gone']);
    expect(seen).toContainEqual(['busy']);
    link.close();
  });
});
