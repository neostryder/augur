// Short text forms of a snapshot: the one-line summary other tools read from the usage file, and the tray tooltip.
import type { AppConfig, Snapshot } from './types.js';

/** A duration as "2d 3h", "4h 12m" or "35m". */
export function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`;
}

export function shortWindow(kind: string | undefined): string {
  return kind === 'session' ? '5h' : kind === 'weekly' ? 'wk' : kind === 'daily' ? 'day' : kind === 'monthly' ? 'mo' : '';
}

/** One line per provider for the tray tooltip (Windows caps tooltips at 127 characters). */
export function tooltip(snap: Snapshot, config: AppConfig): string {
  const lines: string[] = [];
  for (const pc of config.providers) {
    const p = snap.providers[pc.id];
    if (!pc.enabled || !p) continue;
    const bits = p.meters.filter((m) => m.usedPct != null && m.windowKind !== 'credits').slice(0, 2).map((m) => `${Math.round(m.usedPct!)}% ${shortWindow(m.windowKind)}`.trim());
    const bal = p.money.find((m) => m.id === 'balance');
    if (bal?.amount != null) bits.push(`$${bal.amount.toFixed(2)}`);
    lines.push(`${p.name.split(' /')[0]} ${bits.join(', ') || (p.error ? 'error' : '-')}`);
  }
  const text = lines.join('\n');
  return text.length <= 127 ? text : text.slice(0, 127);
}

/** Compact one-line summary for other tools, such as a terminal hook that prints it on every prompt. */
export function summaryLine(snap: Snapshot, config: AppConfig): string {
  const parts: string[] = [];
  const reset = (iso: string | null | undefined): string => {
    if (!iso) return '';
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return ' (resetting)';
    if (ms < 86400e3) return ` (resets ${span(ms).replace(' ', '')})`;
    return ` (resets ${new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })})`;
  };
  for (const pc of config.providers) {
    const p = snap.providers[pc.id];
    if (!pc.enabled || !p) continue;
    const bits: string[] = [];
    p.meters.forEach((m, i) => {
      if (m.usedPct == null || !['session', 'weekly', 'monthly'].includes(m.windowKind ?? '')) return;
      if (m.usedPct === 0 && i > 0) return;
      const scope = m.label.includes(', ') && !/all models/i.test(m.label) ? m.label.split(', ')[1] + ' ' : '';
      bits.push(`${scope}${Math.round(m.usedPct)}% ${shortWindow(m.windowKind)}${reset(m.resetsAt)}`);
    });
    for (const mo of p.money) if (mo.id === 'balance' && mo.amount != null) bits.push(`$${mo.amount.toFixed(2)} left`);
    const n = (p.notes ?? {}) as Record<string, unknown>;
    if (!bits.length && typeof n.latencyMs === 'number') bits.push(`answering, ${Math.round(n.latencyMs)} ms`);
    if (!bits.length && p.error) bits.push(`unavailable: ${p.error}`);
    parts.push(`${p.name.split(' /')[0]} ${bits.join(', ')}${p.stale && p.fetchedAt ? ` [stale, updated ${span(Date.now() - new Date(p.fetchedAt).getTime())} ago]` : ''}`);
  }
  return parts.join(' | ');
}
