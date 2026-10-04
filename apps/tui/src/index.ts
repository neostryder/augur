// The full-screen terminal app: `augur` with no arguments at a terminal opens it.
import type { ClientOptions } from '@augur/augurd';
import { Terminal, type TerminalIo } from '@augur/terminal';
import { TuiApp } from './app.js';
import { Link } from './link.js';
import { openUrl } from './open.js';
import type { Page } from './page.js';
import { AlertsPage } from './screens/alerts.js';
import { DispatchPage, type DispatchDeps } from './screens/dispatch.js';
import { RulesPage } from './screens/rules.js';
import { SettingsPage, type LoginControl } from './screens/settings.js';
import { UsagePage } from './screens/usage.js';

export { TuiApp } from './app.js';
export { Link } from './link.js';
export type { Ctx, Hint, Overlay, Page } from './page.js';
export type { LoginControl } from './screens/settings.js';
export type { DispatchDeps } from './screens/dispatch.js';

export interface RunOptions {
  /** Starts the service when it is not running. */
  launch?: () => Promise<unknown>;
  opts?: ClientOptions;
  io?: TerminalIo;
  /** Starting the service at login, for the switch on the settings page. Left out where the copy cannot set it up. */
  login?: LoginControl;
  /** What the dispatch page needs beyond the service's own calls. */
  dispatch?: DispatchDeps;
  /** What to do about a newer version in this install, shown after the settings page says one is available. */
  updateAdvice?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export function pages(o: Pick<RunOptions, 'login' | 'env' | 'platform' | 'dispatch' | 'updateAdvice'> = {}): Page[] {
  const settings = new SettingsPage({ platform: o.platform ?? process.platform, env: o.env ?? process.env, ...(o.login ? { login: o.login } : {}), ...(o.updateAdvice ? { updateAdvice: o.updateAdvice } : {}) });
  return [new UsagePage(), new AlertsPage(), new RulesPage(), new DispatchPage({ env: o.env ?? process.env, ...o.dispatch }), settings];
}

/** Runs the app until the person quits. Resolves once the terminal is back as it was. */
export async function runTui(o: RunOptions = {}): Promise<void> {
  const term = new Terminal(o.io);
  const link = new Link({ ...(o.launch ? { launch: o.launch } : {}), ...(o.opts ? { opts: o.opts } : {}) });
  const app = new TuiApp({ link, pages: pages(o), redraw: () => term.redraw(), open: (url) => openUrl(url), pause: (fn) => term.pause(fn), copy: (text) => term.copy(text) });
  let up = false;
  link.onChange(() => {
    // Opening the app counts as looking at it, which refreshes figures more than a minute old, as showing the window app does.
    if (link.status === 'up' && !up) void link.run('viewShown').catch(() => {});
    up = link.status === 'up';
    term.redraw();
  });
  // Times such as "5m ago" move on even when nothing changes.
  const tick = setInterval(() => term.redraw(), 30000);
  // The dispatch page reads jobs and routes from the service while it is open.
  const poll = setInterval(() => void app.poll(), 2500);
  void link.connect();
  try { await term.run(app); } finally { clearInterval(tick); clearInterval(poll); link.close(); }
}
