import type { AlertConfig, Snapshot } from './types.js';
import type { HistoryRow } from './history.js';
import { meterSeries } from './history.js';
import { calculatePace } from './pace.js';

export interface Alert {
  key: string;
  providerId: string;
  meterId: string;
  kind: 'percent' | 'pace' | 'balance' | 'reset' | 'idle';
  message: string;
  /** The percent or balance the alert crossed. */
  threshold?: number;
  /** When the meter's window ends, for alerts tied to one window. */
  resetsAt?: string | null;
}
/** When each alert last fired, in epoch milliseconds. A plain true, written by earlier builds, counts as fired at the first check after the upgrade. */
export type FiredState = Record<string, boolean | number>;

/** A provider reports the same reset time to within a second or so from one refresh to the next, so two keys for one alert whose window ends this close together are one window. */
const SAME_WINDOW_MS = 5000;
const WINDOW_KEY = /^(.*\.)(\d{4}-\d\d-\d\dT[\d:.]+Z)$/;
const KEEP_FIRED_MS = 30 * 86400000;
/** A pace alert repeats at most this often while a provider stays ahead of pace. */
export const PACE_REPEAT_MS = 86400000;
const DEFAULT_SPENT_PCT = 98;

/** When the alert last fired, looking at its own key and at keys for the same alert whose window ends within a few seconds of this one. */
function lastFired(state: FiredState, key: string): number | undefined {
  const own = WINDOW_KEY.exec(key), end = own ? Date.parse(own[2] as string) : NaN;
  let last: number | undefined;
  for (const [k, v] of Object.entries(state)) {
    let same = k === key;
    if (!same && own) { const other = WINDOW_KEY.exec(k); same = other !== null && other[1] === own[1] && Math.abs(Date.parse(other[2] as string) - end) <= SAME_WINDOW_MS; }
    if (same && typeof v === 'number' && (last === undefined || v > last)) last = v;
  }
  return last;
}

export interface AlertOptions {
  /** The percent at which each provider's plan counts as spent, by provider id. The default is 98. */
  spentAt?: Record<string, number>;
  drain?: ReadonlySet<string>;
}

export function evaluateAlerts(snapshot: Snapshot, history: HistoryRow[], config: AlertConfig, firedState: FiredState, options: AlertOptions = {}): { alerts: Alert[]; firedState: FiredState } {
  const state = { ...firedState }, alerts: Alert[] = [];
  if (!config.enabled) return { alerts, firedState: state };
  const now = Date.parse(snapshot.generatedAt);
  for (const k of Object.keys(state)) {
    const w = WINDOW_KEY.exec(k);
    // Windows that ended long ago cannot fire again, so their keys are dropped.
    if (w && Date.parse(w[2] as string) < now - KEEP_FIRED_MS) delete state[k];
    else if (state[k] === true) state[k] = now;
  }
  const fire = (key: string, providerId: string, meterId: string, kind: Alert['kind'], message: string, repeatMs?: number, extra: Pick<Alert, 'threshold' | 'resetsAt'> = {}) => {
    const last = lastFired(state, key);
    if (last !== undefined && (repeatMs === undefined || now - last < repeatMs)) return;
    state[key] = now; alerts.push({ key, providerId, meterId, kind, message, ...extra });
  };
  for (const [providerId, provider] of Object.entries(snapshot.providers)) {
    if (!provider.ok || provider.stale) continue;
    const weekly = provider.meters.filter(meter => meter.windowKind === 'weekly' && !meter.id.includes('scoped'));
    const idleMeter = weekly.every(meter => meter.usedPct !== null && Number.isFinite(meter.usedPct) && meter.usedPct < config.idlePct) ? weekly[0] : undefined;
    for (const meter of provider.meters) {
      if (meter.usedPct === null) continue;
      const window = meter.resetsAt ?? 'none';
      const start = meter.resetsAt && meter.windowSeconds ? Date.parse(meter.resetsAt) - meter.windowSeconds * 1000 : -Infinity;
      const series = meterSeries(history, providerId, meter.id).filter(point => Date.parse(point.t) >= start && Date.parse(point.t) < now);
      if (options.drain?.has(providerId) && meter === idleMeter && meter.resetsAt && meter.windowSeconds
        && Number.isFinite(meter.usedPct) && meter.usedPct < config.idlePct && (provider.status?.indicator == null || provider.status.indicator === 'none')) {
        const end = Date.parse(meter.resetsAt);
        // A window that has not started reports a reset time that moves with the clock, so idle time is read from the whole history
        // rather than from the reported window, and the alert is keyed by the meter and repeats daily while the provider stays idle.
        const run = meterSeries(history, providerId, meter.id).filter(point => Date.parse(point.t) < now);
        let since = now;
        for (let i = run.length - 1; i >= 0; i--) {
          const point = run[i]!;
          if (point.value >= config.idlePct) break;
          since = Date.parse(point.t);
        }
        const hours = (now - since) / 3600000;
        if (end > now && hours >= config.idleHours) fire(`${providerId}.${meter.id}.idle`, providerId, meter.id, 'idle',
          `${provider.name} is idle: ${meter.usedPct}% of ${meter.label} used, idle for ${hours.toFixed(1)} hours, with ${((end - now) / 3600000).toFixed(1)} hours until reset.`, PACE_REPEAT_MS, { threshold: config.idlePct, resetsAt: meter.resetsAt });
      }
      const prior = series.at(-1)?.value ?? 0;
      for (const threshold of config.pctThresholds) {
        if (prior < threshold && meter.usedPct >= threshold) fire(`${providerId}.${meter.id}.percent.${threshold}.${window}`, providerId, meter.id, 'percent',
          `${provider.name}: ${meter.label} reached ${threshold}%`, undefined, { threshold, resetsAt: meter.resetsAt ?? null });
      }
      const paceThreshold = meter.windowKind === 'session' ? config.paceRatio.session : meter.windowKind === 'weekly' ? config.paceRatio.weekly : config.paceRatio.other;
      if (paceThreshold === null || !meter.resetsAt || !meter.windowSeconds || meter.usedPct < 5) continue;
      const end = Date.parse(meter.resetsAt), elapsed = (now - (end - meter.windowSeconds * 1000)) / (meter.windowSeconds * 1000);
      if (elapsed < 0.1 || elapsed >= 1) continue;
      const pace = calculatePace(meter, history, providerId, new Date(now));
      if (pace.burnRatio !== null && pace.burnRatio < paceThreshold) fire(`${providerId}.${meter.id}.pace.${paceThreshold}.${window}`, providerId, meter.id, 'pace',
        `${provider.name}: ${meter.label} may run out before reset`, PACE_REPEAT_MS, { resetsAt: meter.resetsAt });
    }
    const resets = (provider.notes as { resets_available?: unknown } | null | undefined)?.resets_available;
    if (typeof resets === 'number' && resets > 0) {
      for (const meter of provider.meters) {
        if (meter.usedPct === null || (meter.windowKind !== 'weekly' && meter.windowKind !== 'session') || meter.usedPct < (options.spentAt?.[providerId] ?? DEFAULT_SPENT_PCT)) continue;
        fire(`${providerId}.${meter.id}.reset.${meter.resetsAt ?? 'none'}`, providerId, meter.id, 'reset',
          `${provider.name}: ${meter.label} is spent and ${resets} limit ${resets === 1 ? 'reset is' : 'resets are'} in hand. Use ${resets === 1 ? 'it' : 'one'} to keep working on ${provider.name}.`, undefined, { resetsAt: meter.resetsAt ?? null });
      }
    }
    for (const money of provider.money) {
      const threshold = config.balanceBelow[`${providerId}.${money.id}`];
      if (threshold === undefined || money.amount === null || money.amount >= threshold) continue;
      fire(`${providerId}.${money.id}.balance.${threshold}`, providerId, money.id, 'balance', `${provider.name}: ${money.label} is below ${threshold} ${money.currency}`, undefined, { threshold });
    }
  }
  return { alerts, firedState: state };
}
