import type { Snapshot } from './types.js';
import type { Alert } from './alerts.js';

/**
 * The alert feed: alerts that stay until they are dismissed or no longer apply. The desktop app is its only writer. It keeps the feed in
 * alerts.json beside the export file, where the Claude Code mod reads it, and sends it to the paired phone inside the encrypted sync.
 * Dismissals come back as acks: lines in alerts-acks.jsonl from the mod, and a list on the phone's own relay channel.
 */
export type AlertKind = 'percent' | 'pace' | 'reset' | 'balance' | 'refresh' | 'models' | 'rules' | 'update';
/** system is the computer's own notification, augur the bell, claude the Claude Code mod, phone a push to the paired phone. */
export type Outlet = 'system' | 'augur' | 'claude' | 'phone';
export type OutletConfig = Record<AlertKind, Record<Outlet, boolean>>;

export const ALERT_KINDS: AlertKind[] = ['percent', 'pace', 'reset', 'balance', 'refresh', 'models', 'rules', 'update'];
export const OUTLETS: Outlet[] = ['system', 'augur', 'claude', 'phone'];

const DEFAULT_OUTLETS: Record<AlertKind, [boolean, boolean, boolean, boolean]> = {
  percent: [true, true, true, true],
  pace: [true, true, true, true],
  reset: [true, true, true, true],
  balance: [true, true, false, true],
  refresh: [false, true, true, false],
  models: [true, true, false, false],
  rules: [true, true, true, true],
  update: [false, true, false, false],
};

export function defaultOutlets(): OutletConfig {
  return Object.fromEntries(ALERT_KINDS.map((k) => [k, Object.fromEntries(OUTLETS.map((o, i) => [o, DEFAULT_OUTLETS[k][i]]))])) as OutletConfig;
}

/** Fills in any kind or outlet a saved config lacks with its default. */
export function migrateOutlets(raw: unknown): OutletConfig {
  const out = defaultOutlets();
  if (!raw || typeof raw !== 'object') return out;
  for (const k of ALERT_KINDS) {
    const row = (raw as Record<string, unknown>)[k];
    if (!row || typeof row !== 'object') continue;
    for (const o of OUTLETS) {
      const v = (row as Record<string, unknown>)[o];
      if (typeof v === 'boolean') out[k][o] = v;
    }
  }
  return out;
}

export function outletsFor(config: OutletConfig, kind: AlertKind): Outlet[] {
  return OUTLETS.filter((o) => config[kind]?.[o]);
}

/** What makes an alert stop applying, so it leaves the feed without being dismissed. */
export type ClearRule =
  /** The meter's window has ended: its reset time has passed or the provider now reports another one. */
  | { when: 'window'; providerId: string; meterId: string; resetsAt: string | null }
  | { when: 'balance'; providerId: string; moneyId: string; below: number }
  | { when: 'refreshed'; providerId: string }
  | { when: 'flag'; flag: FeedFlag }
  | { when: 'never' };

export type FeedFlag = 'models' | 'rules' | 'update';

export interface FeedAlert {
  id: string;
  kind: AlertKind;
  severity: 'crit' | 'warn' | 'info';
  title: string;
  body: string;
  raisedAt: string;
  /** The outlets that keep this alert: augur, claude or both. */
  outlets: Outlet[];
  clears: ClearRule;
  /** A newer alert in the same group replaces an older one, so a count such as "3 new models" never shows twice. */
  group?: string;
}

export interface AlertFeed {
  schema: 1;
  generatedAt: string;
  alerts: FeedAlert[];
}

const MAX_ALERTS = 50;

export function emptyFeed(now = new Date()): AlertFeed {
  return { schema: 1, generatedAt: now.toISOString(), alerts: [] };
}

/** The feed entry for a usage alert from evaluateAlerts. */
export function feedFromUsage(a: Alert, title: string, at: Date, outlets: Outlet[]): FeedAlert {
  const clears: ClearRule = a.kind === 'balance'
    ? { when: 'balance', providerId: a.providerId, moneyId: a.meterId, below: a.threshold ?? 0 }
    : { when: 'window', providerId: a.providerId, meterId: a.meterId, resetsAt: a.resetsAt ?? null };
  const severity = a.kind === 'percent' && (a.threshold ?? 0) >= 90 ? 'crit' : 'warn';
  return { id: a.key, kind: a.kind, severity, title, body: a.message, raisedAt: at.toISOString(), outlets, clears };
}

/** Adds alerts, newest first. An alert already in the feed is left alone, and one in the same group as an older alert replaces it. */
export function addAlerts(feed: AlertFeed, items: FeedAlert[], now = new Date()): AlertFeed {
  let alerts = feed.alerts;
  for (const item of items) {
    if (alerts.some((a) => a.id === item.id)) continue;
    alerts = [item, ...alerts.filter((a) => !item.group || a.group !== item.group)];
  }
  return { schema: 1, generatedAt: now.toISOString(), alerts: alerts.slice(0, MAX_ALERTS) };
}

/** Removes the dismissed alerts. Acks for alerts no longer in the feed are ignored. */
export function applyAcks(feed: AlertFeed, ids: Iterable<string>, now = new Date()): { feed: AlertFeed; changed: boolean } {
  const gone = new Set(ids);
  const alerts = feed.alerts.filter((a) => !gone.has(a.id));
  if (alerts.length === feed.alerts.length) return { feed, changed: false };
  return { feed: { schema: 1, generatedAt: now.toISOString(), alerts }, changed: true };
}

/** Removes alerts that no longer apply. A flag is true while its condition still holds, such as models still waiting for rules. */
export function clearResolved(feed: AlertFeed, snapshot: Snapshot | null, flags: Record<FeedFlag, boolean>, now = new Date()): { feed: AlertFeed; changed: boolean } {
  const resolved = (rule: ClearRule): boolean => {
    switch (rule.when) {
      case 'flag': return !flags[rule.flag];
      case 'never': return false;
      case 'window': {
        if (rule.resetsAt && Date.parse(rule.resetsAt) <= now.getTime()) return true;
        const meter = snapshot?.providers[rule.providerId]?.meters.find((m) => m.id === rule.meterId);
        return !!meter && !!meter.resetsAt && !!rule.resetsAt && Math.abs(Date.parse(meter.resetsAt) - Date.parse(rule.resetsAt)) > 5000;
      }
      case 'balance': {
        const money = snapshot?.providers[rule.providerId]?.money.find((m) => m.id === rule.moneyId);
        return !!money && money.amount !== null && money.amount >= rule.below;
      }
      case 'refreshed': {
        const p = snapshot?.providers[rule.providerId];
        return !!p && !p.error;
      }
    }
  };
  const alerts = feed.alerts.filter((a) => !resolved(a.clears));
  if (alerts.length === feed.alerts.length) return { feed, changed: false };
  return { feed: { schema: 1, generatedAt: now.toISOString(), alerts }, changed: true };
}

export function feedFor(feed: AlertFeed, outlet: Outlet): FeedAlert[] {
  return feed.alerts.filter((a) => a.outlets.includes(outlet));
}

const KINDS = new Set<string>(ALERT_KINDS);
const SEVERITIES = new Set(['crit', 'warn', 'info']);

/** Reads a saved feed, dropping any entry that is not well formed. */
export function parseFeed(text: string | null | undefined): AlertFeed {
  if (!text) return emptyFeed();
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return emptyFeed(); }
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { alerts?: unknown }).alerts) ? (raw as { alerts: unknown[] }).alerts : [];
  const alerts = list.filter((a): a is FeedAlert => {
    if (!a || typeof a !== 'object') return false;
    const x = a as Record<string, unknown>;
    return typeof x.id === 'string' && typeof x.title === 'string' && typeof x.body === 'string' && typeof x.raisedAt === 'string'
      && KINDS.has(x.kind as string) && SEVERITIES.has(x.severity as string) && Array.isArray(x.outlets) && !!x.clears && typeof x.clears === 'object';
  });
  const at = (raw as { generatedAt?: unknown })?.generatedAt;
  return { schema: 1, generatedAt: typeof at === 'string' ? at : new Date().toISOString(), alerts };
}

/** The alert ids in an acks file: one JSON object per line with an id, such as {"id":"...","at":"...","by":"claude"}. Bad lines are skipped. */
export function parseAcks(text: string | null | undefined): string[] {
  const ids: string[] = [];
  for (const line of (text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const id = (JSON.parse(line) as { id?: unknown }).id;
      if (typeof id === 'string' && id) ids.push(id);
    } catch { /* a half-written last line is read on the next pass */ }
  }
  return ids;
}
