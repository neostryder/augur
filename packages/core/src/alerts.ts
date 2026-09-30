import type { AlertConfig, Snapshot } from './types.js';
import type { HistoryRow } from './history.js';
import { meterSeries } from './history.js';
import { calculatePace } from './pace.js';

export interface Alert {
  key: string;
  providerId: string;
  meterId: string;
  kind: 'percent' | 'pace' | 'balance';
  message: string;
}
export type FiredState = Record<string, boolean>;

/** A provider reports the same reset time to within a second or so from one refresh to the next, so two keys for one alert whose window ends this close together are one window. */
const SAME_WINDOW_MS = 5000;
const WINDOW_KEY = /^(.*\.)(\d{4}-\d\d-\d\dT[\d:.]+Z)$/;
const KEEP_FIRED_MS = 30 * 86400000;

function firedNearby(state: FiredState, key: string): boolean {
  const own = WINDOW_KEY.exec(key);
  if (!own) return false;
  const end = Date.parse(own[2] as string);
  return Object.keys(state).some(k => {
    const other = WINDOW_KEY.exec(k);
    return other !== null && other[1] === own[1] && Math.abs(Date.parse(other[2] as string) - end) <= SAME_WINDOW_MS;
  });
}

export function evaluateAlerts(snapshot: Snapshot, history: HistoryRow[], config: AlertConfig, firedState: FiredState): { alerts: Alert[]; firedState: FiredState } {
  const state = { ...firedState }, alerts: Alert[] = [];
  if (!config.enabled) return { alerts, firedState: state };
  // Windows that ended long ago cannot fire again, so their keys are dropped.
  for (const k of Object.keys(state)) { const w = WINDOW_KEY.exec(k); if (w && Date.parse(w[2] as string) < Date.parse(snapshot.generatedAt) - KEEP_FIRED_MS) delete state[k]; }
  const fire = (key: string, providerId: string, meterId: string, kind: Alert['kind'], message: string) => {
    if (state[key] || firedNearby(state, key)) return;
    state[key] = true; alerts.push({ key, providerId, meterId, kind, message });
  };
  const now = Date.parse(snapshot.generatedAt);
  for (const [providerId, provider] of Object.entries(snapshot.providers)) {
    if (!provider.ok || provider.stale) continue;
    for (const meter of provider.meters) {
      if (meter.usedPct === null) continue;
      const window = meter.resetsAt ?? 'none';
      const start = meter.resetsAt && meter.windowSeconds ? Date.parse(meter.resetsAt) - meter.windowSeconds * 1000 : -Infinity;
      const series = meterSeries(history, providerId, meter.id).filter(point => Date.parse(point.t) >= start && Date.parse(point.t) < now);
      const prior = series.at(-1)?.value ?? 0;
      for (const threshold of config.pctThresholds) {
        if (prior < threshold && meter.usedPct >= threshold) fire(`${providerId}.${meter.id}.percent.${threshold}.${window}`, providerId, meter.id, 'percent',
          `${provider.name}: ${meter.label} reached ${threshold}%`);
      }
      const paceThreshold = meter.windowKind === 'session' ? config.paceRatio.session : meter.windowKind === 'weekly' ? config.paceRatio.weekly : config.paceRatio.other;
      if (paceThreshold === null || !meter.resetsAt || !meter.windowSeconds || meter.usedPct < 5) continue;
      const end = Date.parse(meter.resetsAt), elapsed = (now - (end - meter.windowSeconds * 1000)) / (meter.windowSeconds * 1000);
      if (elapsed < 0.1 || elapsed >= 1) continue;
      const pace = calculatePace(meter, history, providerId, new Date(now));
      if (pace.burnRatio !== null && pace.burnRatio < paceThreshold) fire(`${providerId}.${meter.id}.pace.${paceThreshold}.${window}`, providerId, meter.id, 'pace',
        `${provider.name}: ${meter.label} may run out before reset`);
    }
    for (const money of provider.money) {
      const threshold = config.balanceBelow[`${providerId}.${money.id}`];
      if (threshold === undefined || money.amount === null || money.amount >= threshold) continue;
      fire(`${providerId}.${money.id}.balance.${threshold}`, providerId, money.id, 'balance', `${provider.name}: ${money.label} is below ${threshold} ${money.currency}`);
    }
  }
  return { alerts, firedState: state };
}
