import type { AppConfig, Meter, ProviderPlugin, ProviderSnapshot, Snapshot } from '@augur/core';
import type { UpdateState } from '../app';
import { pace, series, type HistoryRow } from '../core';
import { ICON, ago, esc, money, sevOf, until, when } from '../util';
import { chart } from './chart';
import { pendingCount } from './rules';

export interface DashboardModel {
  config: AppConfig;
  snapshot: Snapshot | null;
  history: HistoryRow[];
  plugins: Map<string, ProviderPlugin>;
  busy: boolean;
  twoColumns: boolean;
  expanded: string | null;
  dark: boolean;
  shellKind: 'desktop' | 'pwa';
  /** Phone only: whether a refresh is waiting on the paired desktop, or waited and got nothing. */
  desktopWait?: 'waiting' | 'timeout' | null;
  /** Set only by the desktop shell; the phone app never checks for updates. */
  update?: UpdateState;
  /** True where the app carries the dispatch service, which is what the Jobs page reads. */
  canDispatch?: boolean;
}

const WINDOWED = (m: Meter) => m.windowKind !== 'credits' && m.usedPct != null;

export function colorOf(model: DashboardModel, pid: string): string {
  const custom = (model.config.providers.find((p) => p.id === pid)?.settings?.color as string | undefined) || '';
  if (custom) return custom;
  const c = model.plugins.get(pid)?.color;
  return c ? (model.dark ? c.dark : c.light) : 'var(--muted)';
}

export function tightest(model: DashboardModel): { p: ProviderSnapshot; m: Meter } | null {
  let best: { p: ProviderSnapshot; m: Meter } | null = null;
  for (const pc of model.config.providers) {
    const p = model.snapshot?.providers[pc.id];
    if (!pc.enabled || !p) continue;
    const hidden = model.config.layout.hiddenMeters[pc.id] ?? [];
    for (const m of p.meters) {
      if (!WINDOWED(m) || hidden.includes(m.id)) continue;
      if (!best || m.usedPct! > best.m.usedPct!) best = { p, m };
    }
  }
  return best;
}

/** Shown while any model waits for its rules to be confirmed, since routers skip it until then. */
function reviewButton(model: DashboardModel): string {
  const n = pendingCount(model.config);
  return n ? `<button class="review-pill" data-action="rules" data-value="needs" title="Models waiting for rules">${n} to review</button>` : '';
}

function spark(rows: HistoryRow[], pid: string, m: Meter): string {
  const cut = Date.now() - 24 * 3600e3;
  const pts = series(rows, pid, m.id).filter(([t]) => t >= cut);
  if (pts.length < 2) return '';
  const W = 64, H = 18, x1 = Date.now();
  const X = (t: number) => ((t - cut) / (x1 - cut)) * W;
  const Y = (v: number) => H - 1 - (Math.min(100, Math.max(0, v)) / 100) * (H - 2);
  const d = pts.map(([t, v], i) => `${i ? 'L' : 'M'}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  const [lt, lv] = pts[pts.length - 1]!;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" data-spark="${esc(pid)}|${esc(m.id)}" aria-hidden="true">
    <line x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}" stroke="var(--line)" stroke-width="1"/>
    <path d="${d}" fill="none" stroke="var(--spark)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${X(lt).toFixed(1)}" cy="${Y(lv).toFixed(1)}" r="2.2" fill="var(--accent)"/></svg>`;
}

function paceText(model: DashboardModel, pid: string, m: Meter): { text: string; bad: boolean; elapsedPct: number | null } {
  const p = pace(m, model.history, pid);
  let elapsedPct: number | null = null;
  if (m.resetsAt && m.windowSeconds) {
    const left = (new Date(m.resetsAt).getTime() - Date.now()) / 1000;
    elapsedPct = Math.min(100, Math.max(0, 100 * (1 - left / m.windowSeconds)));
  }
  if (!p || p.burnRatio == null) return { text: '', bad: false, elapsedPct };
  if (p.willExhaustBeforeReset && p.projectedExhaustAt) {
    return { text: `Runs out around ${when(p.projectedExhaustAt)}`, bad: true, elapsedPct };
  }
  return { text: p.burnRatio >= 1 ? 'On pace' : 'Ahead of pace', bad: p.burnRatio < 1 && (m.usedPct ?? 0) > 50, elapsedPct };
}

function meterHtml(model: DashboardModel, pid: string, m: Meter): string {
  const pct = m.usedPct;
  const sev = pct == null ? '' : sevOf(pct);
  const pc = paceText(model, pid, m);
  const foot = [until(m.resetsAt), m.detail ?? ''].filter(Boolean).map(esc).join(' &middot; ');
  const key = `${pid}|${m.id}`;
  const open = model.expanded === key;
  const tick = pc.elapsedPct != null && WINDOWED(m) ? `<b style="left:calc(${pc.elapsedPct.toFixed(1)}% - 1px)" title="Even pace"></b>` : '';
  return `<div class="meter clickable" data-meter="${esc(key)}" role="button" tabindex="0" aria-expanded="${open}">
    <div class="mrow"><span class="label" title="${esc(m.label)}">${esc(m.label)}</span>${spark(model.history, pid, m)}<span class="pct">${pct == null ? '-' : Math.round(pct) + '%'}</span></div>
    <div class="bar" role="meter" aria-label="${esc(m.label)}" aria-valuenow="${pct ?? 0}" aria-valuemin="0" aria-valuemax="100"><i class="${sev}" style="width:${Math.min(100, pct ?? 0)}%"></i>${tick}</div>
    <div class="mfoot"><span class="grow">${foot}</span>${pc.text ? `<span class="pace${pc.bad ? ' bad' : ''}">${esc(pc.text)}</span>` : ''}${sev ? `<span class="sev ${sev}">${sev === 'crit' ? ICON.crit : ICON.warn}${sev === 'crit' ? 'Near limit' : 'High'}</span>` : ''}</div>
    ${open ? chart(model.history, pid, m) : ''}
  </div>`;
}

function statusBadge(p: ProviderSnapshot): string {
  const s = p.status;
  if (!s || s.indicator === 'none' || s.indicator === 'unknown') return '';
  const icon = s.indicator === 'minor' || s.indicator === 'maintenance' ? ICON.warn : ICON.crit;
  const label = s.indicator === 'maintenance' ? 'Maintenance' : s.indicator === 'minor' ? 'Degraded' : 'Outage';
  return `<span class="status ${esc(s.indicator)}" title="${esc(s.description ?? label)}">${icon}${label}</span>`;
}

function cardHtml(model: DashboardModel, pid: string): string {
  const p = model.snapshot?.providers[pid];
  const plugin = model.plugins.get(pid);
  const name = p?.name ?? plugin?.name ?? pid;
  const collapsed = model.config.layout.collapsed.includes(pid);
  const hidden = model.config.layout.hiddenMeters[pid] ?? [];
  const usage = p?.links?.usage ?? plugin?.links.usage;
  let body = '';
  if (p) {
    for (const m of p.meters) if (!hidden.includes(m.id)) body += meterHtml(model, pid, m);
    const tiles = p.money.filter((x) => x.amount != null && !hidden.includes('$' + x.id));
    if (tiles.length) {
      body += '<div class="money">' + tiles.map((x) => `<div class="tile"><div class="l">${esc(x.label)}</div>
        <div class="v">${money(x.amount, x.currency)}${x.total != null ? `<small>of ${money(x.total, x.currency)}</small>` : ''}</div></div>`).join('') + '</div>';
    }
    const notes = notesLine(p);
    if (notes) body += `<div class="notes">${notes}</div>`;
    if (p.error) body += `<div class="err">${ICON.warn}<span>${p.stale && p.fetchedAt ? `Refresh failed: ${esc(p.error)} Showing the figures from ${esc(ago(p.fetchedAt))}.` : esc(p.error)}</span></div>`;
  } else {
    body = `<div class="notes">Waiting for the first refresh.</div>`;
  }
  return `<section class="card${collapsed ? ' collapsed' : ''}" data-pid="${esc(pid)}">
    <h2><span class="handle" id="handle-${esc(pid)}" role="button" tabindex="0" title="Drag to reorder, or press Alt with the Up or Down arrow" aria-label="Reorder ${esc(name)}. Press Alt with the Up or Down arrow to move it.">${ICON.grip}</span>
      <span class="dot" style="background:${esc(colorOf(model, pid))}"></span>${esc(name)}
      ${p?.plan ? `<span class="chip">${esc(p.plan)}</span>` : ''}${p ? statusBadge(p) : ''}<span class="grow"></span>
      ${p?.stale ? '<span class="chip stale" title="The last refresh failed">Stale</span>' : ''}<span class="age">${p?.fetchedAt ? `${p.stale ? 'updated ' : ''}${ago(p.fetchedAt)}` : ''}</span>
      ${usage ? `<a class="ext" href="${esc(usage)}" data-open="${esc(usage)}" title="Open ${esc(name)} usage page" aria-label="Open ${esc(name)} usage page">${ICON.ext}</a>` : ''}
      <button class="link" data-collapse="${esc(pid)}" title="${collapsed ? 'Expand' : 'Collapse'}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${esc(name)}" style="transform:rotate(${collapsed ? -90 : 0}deg)">${ICON.chevron}</button></h2>
    <div class="body">${body}</div></section>`;
}

function notesLine(p: ProviderSnapshot): string {
  const n = (p.notes ?? {}) as Record<string, any>;
  const out: string[] = [];
  if (typeof n.resets_available === 'number' || typeof n.resetsAvailable === 'number') {
    const k = n.resetsAvailable ?? n.resets_available;
    out.push(`${k} limit reset${k === 1 ? '' : 's'} available`);
  }
  const ku = n.keyUsage ?? n.key_usage;
  if (ku) out.push(`This key: ${money(ku.day)} today, ${money(ku.week)} this week, ${money(ku.month)} this month`);
  const top = n.topEndpoints ?? n.top_endpoints;
  if (Array.isArray(top) && top.length) out.push('Top: ' + top.slice(0, 3).map((e: any) => `${e.endpoint} ${money(Number(e.cost))}`).join(', '));
  if (n.lastWeek) out.push(`${Number(n.lastWeek.requests).toLocaleString()} requests, ${(Number(n.lastWeek.tokens) / 1e6).toFixed(1)}M tokens in 7 days`);
  if (typeof n.refill === 'string') out.push(n.refill);
  if (n.signInNeeded) out.push('Sign in to the TypeSafe console in settings to see your balance');
  if (n.cloudflareCheck) out.push('Open the TypeSafe console in settings and pass the Cloudflare check to show your balance');
  if (n.balanceMissing) out.push('The TypeSafe billing page opened but showed no credit balance');
  if (typeof n.latencyMs === 'number') out.push(`Answered in ${Math.round(n.latencyMs)} ms${n.model ? `, ${n.model}` : ''}`);
  return out.map(esc).join(' &middot; ');
}

/** Only the desktop shell can check for updates, so the phone never shows this. Hovering lists the changes from updateTip, and a click installs with no confirmation step. */
function updateButton(model: DashboardModel): string {
  const u = model.update, v = u?.available?.version;
  if (!u || !v || u.status === 'current') return '';
  if (u.status === 'installing') return `<button class="update-pill installing" disabled aria-label="Installing Augur ${esc(v)}">${ICON.update}<span>Installing</span></button>`;
  return `<button class="update-pill" data-action="update-install" data-update aria-label="Install Augur ${esc(v)} and restart">${ICON.update}<span>Update to ${esc(v)}</span></button>`;
}

/** The tooltip for the update button: what to expect on click, then each newer release's changes. */
export function updateTip(u: UpdateState): string {
  const v = u.available?.version ?? '';
  const head = u.status === 'error'
    ? `Installing ${esc(v)} did not finish. Click to try again, or download it from the Augur releases page on GitHub.`
    : `Click to install ${esc(v)}. Augur restarts when it finishes.`;
  if (!u.changes) return `<b>${head}</b><p>Augur could not load the changes for this version. They are listed in CHANGELOG.md on the Augur GitHub page.</p>`;
  return `<b>${head}</b>` + u.changes.map((r) => `<div class="ver">${esc(r.version)}</div><ul>${r.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`).join('');
}

function subLine(model: DashboardModel): string {
  if (model.desktopWait === 'waiting') return 'Asking your desktop to refresh Claude, Codex, Grok and Jev';
  if (model.desktopWait === 'timeout') return 'Your desktop sent nothing new in 4 minutes. It may be asleep, or Augur may be closed there.';
  return model.snapshot ? `Updated ${ago(model.snapshot.generatedAt)}` : 'Not refreshed yet';
}

export function renderDashboard(model: DashboardModel): string {
  const themeIcon = model.config.layout.theme === 'light' ? ICON.sun : model.config.layout.theme === 'dark' ? ICON.moon : ICON.auto;
  const themeName = model.config.layout.theme === 'system' ? 'System theme' : model.config.layout.theme === 'light' ? 'Light theme' : 'Dark theme';
  let html = `<header class="top"><div><h1>Usage</h1><div class="sub">${subLine(model)}</div></div><span class="grow"></span>
    ${updateButton(model)}${reviewButton(model)}<button class="icon" data-action="theme" title="${themeName}, click to change" aria-label="${themeName}, click to change">${themeIcon}</button>
    ${model.canDispatch ? `<button class="icon" data-action="jobs" title="Jobs" aria-label="Jobs">${ICON.jobs}</button>` : ''}
    <button class="icon" data-action="rules" title="Model rules" aria-label="Model rules">${ICON.rules}</button>
    <button class="icon" data-action="settings" title="Open settings" aria-label="Open settings">${ICON.gear}</button>
    <button class="icon refresh" data-action="refresh" title="Refresh now" aria-label="Refresh now">${ICON.refresh}</button></header>`;

  const enabled = model.config.providers.filter((p) => p.enabled);
  if (!enabled.length) {
    return html + `<div class="empty-state">No providers turned on yet.<br><button class="btn primary" data-action="settings">Choose providers</button></div>`;
  }
  const t = tightest(model);
  if (t) {
    const sev = sevOf(t.m.usedPct!);
    html += `<div class="tight"><span class="big">${Math.round(t.m.usedPct!)}%</span><div class="what">
      <b>${esc(t.p.name)}, ${esc(t.m.label.charAt(0).toLowerCase() + t.m.label.slice(1))}</b><span>${esc(until(t.m.resetsAt)) || 'Most-used limit right now'}</span></div>
      ${sev ? `<span class="grow"></span><span class="sev ${sev}">${sev === 'crit' ? ICON.crit : ICON.warn}</span>` : ''}</div>`;
  }
  html += `<div class="cards${model.twoColumns ? ' two' : ''}" id="cards">${enabled.map((p) => cardHtml(model, p.id)).join('')}</div>`;
  html += `<footer class="bottom"><span></span>
    <span>${model.shellKind === 'desktop' ? '<button data-action="open-export">Open data file</button>' : ''}</span></footer>`;
  return html;
}
