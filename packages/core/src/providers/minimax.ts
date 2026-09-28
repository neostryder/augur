import type { ProviderPlugin, Meter } from '../types.js';
import { json, num, epoch, round, windowKind, windowLabel, obj } from '../util.js';

export const minimax: ProviderPlugin = {
  id: 'minimax', color: { light: '#e87ba4', dark: '#d55181' }, name: 'MiniMax', needsLocalLogin: false,
  links: { usage: 'https://platform.minimax.io/subscribe/coding-plan', status: 'https://status.minimax.io/', statusApi: 'https://status.minimax.io/api/v2/status.json' },
  fields: [{ key: 'apiKey', label: 'API key', kind: 'secret', required: true }],
  async fetch(host) {
    const key = await host.secret('minimax.apiKey');
    if (!key) throw new Error('No API key yet. Add one in settings.');
    const data = obj(await json(host, { url: 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains', headers: { Authorization: `Bearer ${key}` } }));
    if (num(obj(data.base_resp).status_code) !== 0) throw new Error('MiniMax did not accept the key. Check it in settings.');
    const meters: Meter[] = [];
    for (const item of Array.isArray(data.model_remains) ? data.model_remains : []) {
      const m = obj(item), name = String(m.model_name ?? 'model');
      const pretty = name === 'general' ? 'Text' : name === 'video' ? 'Video' : name[0]!.toUpperCase() + name.slice(1);
      const seconds = (Number(m.end_time) - Number(m.start_time)) / 1000;
      const label = windowLabel(seconds), kind = windowKind(seconds);
      const detail = (total: unknown, left: unknown) => num(total) ? `${left} of ${total} left` : null;
      const remaining = num(m.current_interval_remaining_percent);
      meters.push({ id: `${name}_${label}`, label: `${pretty}, ${label} window`, usedPct: remaining === null ? null : round(100 - remaining),
        resetsAt: epoch(m.end_time, 1), windowSeconds: seconds, windowKind: kind, detail: detail(m.current_interval_total_count, m.current_interval_usage_count) });
      const weekly = num(m.current_weekly_remaining_percent);
      const weeklySeconds = (Number(m.weekly_end_time) - Number(m.weekly_start_time)) / 1000 || 604800;
      meters.push({ id: `${name}_weekly`, label: `${pretty}, weekly`, usedPct: weekly === null ? null : round(100 - weekly),
        resetsAt: epoch(m.weekly_end_time, 1), windowSeconds: weeklySeconds, windowKind: 'weekly', detail: detail(m.current_weekly_total_count, m.current_weekly_usage_count) });
    }
    return { meters, money: [], plan: 'Coding plan' };
  },
  async listModels(host) {
    const key = await host.secret('minimax.apiKey');
    if (!key) return [];
    const data = obj(await json(host, { url: 'https://api.minimax.io/v1/models', headers: { Authorization: `Bearer ${key}` } }));
    const rows = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    return rows.map(obj).map(m => String(m.id ?? m.model ?? m.name ?? '')).filter(Boolean).map(id => ({ id }));
  }
};
