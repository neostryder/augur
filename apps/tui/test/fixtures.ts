// The engine state and app the terminal app's tests draw and drive.
import { defaultConfig, emptyEditState, emptyFeed, type EngineState, type FeedAlert } from '@augur/core';
import { makeKey, Screen, type Key } from '@augur/terminal';
import { TuiApp } from '../src/app.js';
import { Link } from '../src/link.js';
import { pages } from '../src/index.js';
import type { Page } from '../src/page.js';

export const NOW = Date.parse('2026-10-04T12:00:00Z');
export const ch = (t: string, alt = false): Key => makeKey('char', { text: t, alt });
export const k = (name: string, mods: Parameters<typeof makeKey>[1] = {}): Key => makeKey(name, mods);

export function alert(id: string, title: string, raisedAt: string, outlets: FeedAlert['outlets'] = ['augur']): FeedAlert {
  return { id, kind: 'percent', severity: 'warn', title, body: `${title} body text.`, raisedAt, outlets, clears: { when: 'never' } };
}

export function state(): EngineState {
  const config = defaultConfig();
  config.providers = [{ id: 'claude', enabled: true, settings: {} }, { id: 'jev', enabled: false, settings: {} }, { id: 'codex', enabled: true, settings: {} }];
  const feed = emptyFeed();
  feed.alerts = [alert('a1', 'Claude at 75%', '2026-10-04T11:00:00Z'), alert('a2', 'Codex at 90%', '2026-10-04T11:30:00Z'), alert('a3', 'Phone only', '2026-10-04T11:40:00Z', ['claude'])];
  return {
    config, feed, catalog: {}, listing: [], editState: emptyEditState(), editLoaded: true, policyError: null, busy: false, secrets: [], claude: null, claudeError: '',
    update: { version: null, status: 'idle', available: null, changes: null }, firstRun: false,
    history: [{ t: '2026-10-04T08:00:00Z', claude: { session: 10 } }, { t: '2026-10-04T11:00:00Z', claude: { session: 40 } }],
    snapshot: { schema: 1, generatedAt: '2026-10-04T11:57:00Z', providers: {
      claude: { id: 'claude', name: 'Claude', ok: true, stale: false, fetchedAt: '2026-10-04T11:57:00Z', error: null, plan: 'Max', money: [], notes: {},
        meters: [{ id: 'session', label: 'Session', usedPct: 42, resetsAt: '2026-10-04T14:00:00Z', windowSeconds: 5 * 3600 }, { id: 'week', label: 'Week', usedPct: 91 }] },
      codex: { id: 'codex', name: 'Codex', ok: false, stale: true, fetchedAt: '2026-10-04T10:00:00Z', error: 'Timed out.', plan: null, notes: {},
        money: [{ id: 'credits', label: 'Credits', amount: 12.5, currency: 'USD', total: 50 }], meters: [{ id: 'day', label: 'Day', usedPct: 5 }] },
    } },
  };
}

export function setup(s: EngineState | null = state(), o: { pages?: Page[]; results?: Record<string, unknown>; answers?: Record<string, unknown> } = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const link = new Link({ call: (async (m: string, p: { method: string; args: unknown[] }) => {
    // Engine commands go through engine_call; the dispatch pages call the service's own methods directly, answered from `answers`.
    if (m !== 'engine_call') { calls.push([m, [p]]); const a = o.answers?.[m]; return typeof a === 'function' ? a(p) : a ?? null; }
    calls.push([p.method, p.args]);
    return o.results?.[p.method] ?? null;
  }) as never });
  link.state = s; link.status = s ? 'up' : 'down'; link.error = s ? '' : 'The service is not running (ENOENT).';
  const opened: string[] = [];
  const copied: string[] = [];
  const app = new TuiApp({ link, pages: o.pages ?? pages(), copy: (t) => copied.push(t), redraw: () => {}, open: async (url) => { opened.push(url); return true; }, now: () => NOW });
  const draw = (w = 100, h = 30) => { const sc = new Screen(w, h); app.draw(sc); return sc.text(); };
  return { app, link, calls, opened, copied, draw };
}

