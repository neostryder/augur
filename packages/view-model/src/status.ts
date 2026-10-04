// The one-line summary of usage and alerts that `augur status` prints and a status bar shows. It reads the same snapshot and feed as the
// apps, and keeps to the shape of the line the Claude Code mod writes.
import type { AppConfig, FeedAlert, Meter, Snapshot } from '@augur/core';
import { windowed } from './usage.js';

/** A provider joins the line beside Claude once one of its meters reaches this percent. */
export const HOT_PCT = 70;
/** Usage older than this gets its age added, since the engine has stopped refreshing it. */
export const STALE_MS = 15 * 60_000;

function windowName(m: Meter): string {
  if (m.windowKind === 'session') return m.windowSeconds ? `${Math.round(m.windowSeconds / 3600)}h` : 'session';
  if (m.windowKind === 'weekly') return 'wk';
  if (m.windowKind === 'monthly') return 'mo';
  if (m.windowKind === 'daily') return 'day';
  return '';
}

const pct = (m: Meter): string => `${Math.round(m.usedPct ?? 0)}%`;

function age(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min < 120 ? `${min}m` : `${Math.round(min / 60)}h`;
}

export interface StatusLine {
  text: string;
  /** What a hover shows: every provider's tightest meter and each alert's title. */
  tooltip: string;
  /** ok, warn when something runs hot or has an alert, crit at 90 percent or an alert marked critical. */
  level: 'ok' | 'warn' | 'crit';
  alerts: number;
}

/** Claude's session and weekly use, then any provider running hot or stale, then how old the numbers are, then the alert count. */
export function statusLine(config: AppConfig, snapshot: Snapshot | null, alerts: FeedAlert[], now = Date.now()): StatusLine {
  const parts: string[] = [], tips: string[] = [];
  let level: StatusLine['level'] = 'ok';
  const raise = (to: StatusLine['level']) => { if (to === 'crit' || level === 'ok') level = to; };
  const enabled = new Set(config.providers.filter((p) => p.enabled).map((p) => p.id));
  const shown = (id: string): boolean => enabled.size === 0 || enabled.has(id);
  for (const p of Object.values(snapshot?.providers ?? {}).filter((x) => shown(x.id))) {
    const hidden = config.layout.hiddenMeters[p.id] ?? [];
    const meters = p.meters.filter((m) => windowed(m) && !hidden.includes(m.id));
    const top = [...meters].sort((a, b) => (b.usedPct ?? 0) - (a.usedPct ?? 0))[0];
    if (top) tips.push(`${p.name} ${windowName(top)} ${pct(top)}`.replace('  ', ' '));
    if (p.id === 'claude') {
      const session = meters.find((m) => m.windowKind === 'session');
      const weekly = meters.find((m) => m.id === 'weekly_all') ?? meters.find((m) => m.windowKind === 'weekly');
      const bits = [session && `${windowName(session)} ${pct(session)}`, weekly && `wk ${pct(weekly)}`].filter(Boolean);
      if (bits.length) parts.push(`Claude ${bits.join(' | ')}`);
      if (top && top.usedPct! >= HOT_PCT) raise(top.usedPct! >= 90 ? 'crit' : 'warn');
      continue;
    }
    if (p.stale) { parts.push(`${p.name} stale`); raise('warn'); continue; }
    if (top && top.usedPct! >= HOT_PCT) { parts.push(`${p.name} ${windowName(top)} ${pct(top)}`.replace('  ', ' ')); raise(top.usedPct! >= 90 ? 'crit' : 'warn'); }
  }
  const at = snapshot?.generatedAt ? Date.parse(snapshot.generatedAt) : NaN;
  if (snapshot && Number.isFinite(at) && now - at > STALE_MS) parts.push(`as of ${age(now - at)} ago`);
  if (alerts.length) {
    parts.push(alerts.length === 1 ? '1 Augur alert' : `${alerts.length} Augur alerts`);
    raise(alerts.some((a) => a.severity === 'crit') ? 'crit' : 'warn');
    for (const a of alerts) tips.push(a.title);
  }
  return { text: parts.join(' | ') || (snapshot ? 'Augur ok' : 'Augur: no usage yet'), tooltip: tips.join('\n'), level, alerts: alerts.length };
}

export const STATUS_TEXT = {
  noService: 'The service is not running, so there is no usage to show. Start it with augur service start.',
  noAlerts: 'No alerts.',
  dismissed: (n: number) => (n === 1 ? 'Dismissed 1 alert.' : `Dismissed ${n} alerts.`),
  dismissNone: 'No alert matches that id.',
  refreshed: 'Refreshing every provider now.',
};
