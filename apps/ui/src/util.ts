export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const ICON = {
  update: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12.5v-9M4 7.5l4-4 4 4"/><path d="M3 14h10"/></svg>',
  refresh: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg>',
  gear: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 4h7.4M12.6 4H14M2 8h2.4M7.6 8H14M2 12h8.4M13.6 12H14"/><circle cx="11" cy="4" r="1.6"/><circle cx="6" cy="8" r="1.6"/><circle cx="12" cy="12" r="1.6"/></svg>',
  sun: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1"/></svg>',
  moon: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7Z"/></svg>',
  auto: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 1 0 12Z" fill="currentColor"/></svg>',
  back: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3 5 8l5 5"/></svg>',
  ext: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2.5h4.5V7M13.5 2.5 7 9M11.5 9.5v3.5a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5h3.5"/></svg>',
  grip: '<svg viewBox="0 0 12 12" fill="currentColor"><circle cx="4" cy="2.5" r="1.1"/><circle cx="8" cy="2.5" r="1.1"/><circle cx="4" cy="6" r="1.1"/><circle cx="8" cy="6" r="1.1"/><circle cx="4" cy="9.5" r="1.1"/><circle cx="8" cy="9.5" r="1.1"/></svg>',
  chevron: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6 4 4 4-4"/></svg>',
  warn: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5 15 14H1L8 1.5Zm-.75 4.5v4h1.5V6h-1.5Zm0 5.25v1.5h1.5v-1.5h-1.5Z"/></svg>',
  crit: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1Zm-.75 3.5v5h1.5v-5h-1.5Zm0 6.25v1.5h1.5v-1.5h-1.5Z"/></svg>',
  jobs: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7"/><path d="m11.5 11.5 1.2 1.2 2-2.4"/></svg>',
  rules: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.8 13.5 4v4c0 3.2-2.4 5.4-5.5 6.2C4.9 13.4 2.5 11.2 2.5 8V4L8 1.8Z"/><path d="m5.6 8 1.7 1.7 3.2-3.4"/></svg>',
  pin: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.8 1.9 14.1 6.2"/><path d="M11.4 3.5 8.6 6.3 5.2 6.6 3.9 7.9l4.2 4.2 1.3-1.3.3-3.4 2.8-2.8"/><path d="M6 10 2.2 13.8"/></svg>',
  bell: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.5V7a4 4 0 0 1 8 0v4.5"/><path d="M2.8 11.5h10.4"/><path d="M6.6 13.6a1.5 1.5 0 0 0 2.8 0"/></svg>',
  close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
  columns: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M8 2.5v11"/></svg>',
};

export const sevOf = (p: number): '' | 'warn' | 'crit' => (p >= 90 ? 'crit' : p >= 75 ? 'warn' : '');

export function until(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'Resetting now';
  return `Resets in ${span(ms)}, ${when(iso, ms)}`;
}

export function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`;
}

export function when(iso: string | number | Date, msAhead?: number): string {
  const t = new Date(iso);
  const ahead = msAhead ?? t.getTime() - Date.now();
  const opts: Intl.DateTimeFormatOptions = ahead > 20 * 3600e3 ? { weekday: 'short', hour: 'numeric', minute: '2-digit' } : { hour: 'numeric', minute: '2-digit' };
  return t.toLocaleString([], opts);
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}

export function money(v: number | null | undefined, cur = 'USD'): string {
  if (v == null || !Number.isFinite(v)) return '-';
  const n = v.toLocaleString([], { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cur === 'USD' ? `$${n}` : `${n} ${cur}`;
}

export function debounce<T extends (...a: never[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | undefined;
  return ((...a: never[]) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }) as T;
}
