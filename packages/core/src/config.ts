import type { AppConfig, GenericProviderDef, ProviderConfig } from './types.js';
import { builtinProviders } from './providers/index.js';
import { obj } from './util.js';
import { MIN_REFRESH_SECONDS } from './engine.js';
import { emptyPolicy, migratePolicy } from './policy.js';

/** Super is the Windows key on Windows and Command on macOS. */
export const DEFAULT_HOTKEY = 'Ctrl+Super+U';

export function defaultConfig(): AppConfig {
  return { schema: 1, providers: builtinProviders.map(provider => ({ id: provider.id, enabled: true, settings: {} })), custom: [],
    layout: { theme: 'system', columns: 'auto', hiddenMeters: {}, collapsed: [] },
    alerts: { enabled: false, pctThresholds: [50, 75, 90], paceRatio: { session: 0.8, weekly: 0.8, other: null }, balanceBelow: {} }, exportPath: null, policy: emptyPolicy() };
}

export function migrateConfig(value: unknown): AppConfig {
  const defaults = defaultConfig(), source = obj(value);
  const custom = Array.isArray(source.custom) ? source.custom.filter((def): def is GenericProviderDef => {
    const item = obj(def); return typeof item.id === 'string' && /^[a-z][a-z0-9_-]*$/.test(item.id) && typeof item.name === 'string' && typeof item.requests === 'object' && !!item.auth;
  }) : [];
  const known = new Set([...builtinProviders.map(provider => provider.id), ...custom.map(def => def.id)]);
  const rows = Array.isArray(source.providers) ? source.providers : [];
  const providers: ProviderConfig[] = [];
  for (const row of rows) {
    const item = obj(row);
    if (typeof item.id !== 'string' || !known.has(item.id) || providers.some(provider => provider.id === item.id)) continue;
    const refreshSeconds = typeof item.refreshSeconds === 'number' && item.refreshSeconds >= MIN_REFRESH_SECONDS ? item.refreshSeconds : null;
    providers.push({ id: item.id, enabled: item.enabled !== false, refreshSeconds, settings: Object.fromEntries(Object.entries(obj(item.settings)).filter(([, setting]) => typeof setting === 'string' || typeof setting === 'boolean')) });
  }
  // A provider added after the config was first saved starts off, so it never shows a missing-key error unasked.
  for (const provider of defaults.providers) if (!providers.some(row => row.id === provider.id)) providers.push({ ...provider, enabled: rows.length === 0 });
  const layout = obj(source.layout), alerts = obj(source.alerts), pace = obj(alerts.paceRatio);
  const ratio = (n: unknown, fallback: number | null) => n === null ? null : typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return { schema: 1, providers, custom,
    layout: { theme: ['system', 'light', 'dark'].includes(layout.theme) ? layout.theme : 'system',
      columns: ['auto', 1, 2].includes(layout.columns) ? layout.columns : 'auto',
      hiddenMeters: obj(layout.hiddenMeters), collapsed: Array.isArray(layout.collapsed) ? layout.collapsed.filter((id: unknown) => typeof id === 'string') : [] },
    alerts: { enabled: alerts.enabled === true, pctThresholds: Array.isArray(alerts.pctThresholds) ? alerts.pctThresholds.filter((n: unknown) => typeof n === 'number' && n >= 0 && n <= 100) : defaults.alerts.pctThresholds,
      paceRatio: { session: ratio(pace.session, defaults.alerts.paceRatio.session), weekly: ratio(pace.weekly, defaults.alerts.paceRatio.weekly), other: ratio(pace.other, defaults.alerts.paceRatio.other) },
      balanceBelow: Object.fromEntries(Object.entries(obj(alerts.balanceBelow)).filter(([, n]) => typeof n === 'number' && Number.isFinite(n))) },
    exportPath: typeof source.exportPath === 'string' ? source.exportPath : null,
    hotkey: source.hotkey === null || source.hotkey === '' ? null : typeof source.hotkey === 'string' ? source.hotkey : DEFAULT_HOTKEY,
    autoUpdate: source.autoUpdate !== false,
    sync: syncConfig(source.sync), secretSources: secretSources(source.secretSources),
    policy: migratePolicy(source.policy) };
}

function syncConfig(value: unknown): AppConfig['sync'] {
  const s = obj(value);
  return typeof s.relay === 'string' ? { relay: s.relay, channel: typeof s.channel === 'string' ? s.channel : '', pwaUrl: typeof s.pwaUrl === 'string' ? s.pwaUrl : '', shareKeys: s.shareKeys === true } : null;
}

function secretSources(value: unknown): AppConfig['secretSources'] {
  const bws = obj(obj(value).bws);
  if (typeof bws.projectId !== 'string' || !/^[0-9a-f-]{36}$/i.test(bws.projectId)) return null;
  const map = Object.fromEntries(Object.entries(obj(bws.map)).filter(([k, v]) => typeof v === 'string' && /^[a-z0-9_-]+\.[A-Za-z0-9_]+$/.test(k))) as Record<string, string>;
  return { bws: { projectId: bws.projectId, map } };
}
