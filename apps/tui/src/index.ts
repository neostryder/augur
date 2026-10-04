// The full-screen terminal app: `augur` with no arguments at a terminal opens it.
import type { ClientOptions } from '@augur/augurd';
import { Terminal, type TerminalIo } from '@augur/terminal';
import { TuiApp } from './app.js';
import { Link } from './link.js';
import { openUrl } from './open.js';
import type { Page } from './page.js';
import { AlertsPage } from './screens/alerts.js';
import { LaterPage } from './screens/later.js';
import { RulesPage } from './screens/rules.js';
import { SettingsPage, type LoginControl } from './screens/settings.js';
import { UsagePage } from './screens/usage.js';

export { TuiApp } from './app.js';
export { Link } from './link.js';
export type { Ctx, Hint, Overlay, Page } from './page.js';
export type { LoginControl } from './screens/settings.js';

export interface RunOptions {
  /** Starts the service when it is not running. */
  launch?: () => Promise<unknown>;
  opts?: ClientOptions;
  io?: TerminalIo;
  /** Starting the service at login, for the switch on the settings page. Left out where the copy cannot set it up. */
  login?: LoginControl;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export function pages(o: Pick<RunOptions, 'login' | 'env' | 'platform'> = {}): Page[] {
  const settings = new SettingsPage({ platform: o.platform ?? process.platform, env: o.env ?? process.env, ...(o.login ? { login: o.login } : {}) });
  return [new UsagePage(), new AlertsPage(), new RulesPage(), new LaterPage('Dispatch'), settings];
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
  void link.connect();
  try { await term.run(app); } finally { clearInterval(tick); link.close(); }
}
