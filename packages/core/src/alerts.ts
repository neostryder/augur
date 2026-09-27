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

export function evaluateAlerts(snapshot: Snapshot, history: HistoryRow[], config: AlertConfig, firedState: FiredState): { alerts: Alert[]; firedState: FiredState } {
  const state = { ...firedState }, alerts: Alert[] = [];
  if (!config.enabled) return { alerts, firedState: state };
  const fire = (key: string, providerId: string, meterId: string, kind: Alert['kind'], message: string) => {
    if (state[key]) return;
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
