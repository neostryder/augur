import type { Meter } from '@augur/core';
import { series, type HistoryRow } from '../core';
import { esc } from '../util';

const DAYS = 7;

/** Seven-day line of one meter, with the window's reset boundaries marked. */
export function chart(rows: HistoryRow[], pid: string, m: Meter): string {
  const now = Date.now();
  const x0 = now - DAYS * 86400e3;
  const pts = series(rows, pid, m.id).filter(([t]) => t >= x0);
  const head = `<div class="htitle"><span class="grow">Last 7 days</span><span>${pts.length} readings</span></div>`;
  if (pts.length < 2) return `<div class="hist" data-hist>${head}<div class="empty">History builds up as the app refreshes. Check back in a few hours.</div></div>`;

  const W = 360, H = 120, L = 26, B = 16, T = 4;
  const X = (t: number) => L + ((t - x0) / (now - x0)) * (W - L);
  const Y = (v: number) => T + (1 - Math.min(100, Math.max(0, v)) / 100) * (H - T - B);

  let grid = '';
  for (const v of [0, 50, 100]) {
    grid += `<line x1="${L}" x2="${W}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)" stroke-width="1"/>`;
    grid += `<text x="${L - 4}" y="${Y(v) + 3}" text-anchor="end" font-size="9" fill="var(--muted)">${v}%</text>`;
  }
  for (let d = 0; d <= DAYS; d += 1) {
    const t = now - d * 86400e3;
    if (d % 2 === 0 && d > 0) {
      const lab = new Date(t).toLocaleDateString([], { weekday: 'short' });
      grid += `<text x="${X(t)}" y="${H - 3}" text-anchor="middle" font-size="9" fill="var(--muted)">${esc(lab)}</text>`;
    }
  }
  let resets = '';
  if (m.resetsAt && m.windowSeconds && m.windowSeconds <= DAYS * 86400) {
    for (let t = new Date(m.resetsAt).getTime() - m.windowSeconds * 1000; t > x0; t -= m.windowSeconds * 1000) {
      resets += `<line x1="${X(t)}" x2="${X(t)}" y1="${T}" y2="${H - B}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>`;
    }
  }
  // A gap of more than 20 minutes between readings means the app was off; break the line there.
  let d = '';
  let prev = 0;
  for (const [t, v] of pts) {
    d += `${!prev || t - prev > 20 * 60e3 ? 'M' : 'L'}${X(t).toFixed(1)},${Y(v).toFixed(1)}`;
    prev = t;
  }
  const [lt, lv] = pts[pts.length - 1]!;
  const data = esc(JSON.stringify(pts.map(([t, v]) => [Math.round(t / 1000), Math.round(v)])));
  return `<div class="hist" data-hist>${head}
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" data-chart="${data}" data-x0="${x0}" data-now="${now}" data-l="${L}" data-w="${W}" role="img" aria-label="${esc(m.label)} over the last 7 days, dashed lines mark resets">
      ${grid}${resets}
      <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      <circle cx="${X(lt)}" cy="${Y(lv)}" r="3" fill="var(--accent)" stroke="var(--card)" stroke-width="2"/>
      <line class="xhair" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="var(--ink-2)" stroke-width="1" opacity="0"/>
    </svg></div>`;
}
