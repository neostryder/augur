import { LEDGER_KINDS, LEDGER_STATES, ORIGIN_KINDS, ledgerTerminal } from '@augur/dispatch-protocol';
import type { LedgerJob } from '@augur/dispatch-protocol';
import { JOBS_CARD_TEXT, LEDGER_STATE_LABELS, LEDGER_TEXT as T, jobsCards, ledgerJobsSnapshot, ledgerFacts, ledgerTime, type JobCard, type LedgerModel } from '@augur/view-model';
import { ICON, esc } from '../util';

export interface JobsModel {
  ledger: LedgerModel;
  service: { running: boolean; pid: number | null } | null;
  serviceNote: string;
  busy: boolean;
}

/** Jobs and Routes are two pages of the same area, so both carry this switch. */
const TAB_LABELS = { jobs: 'Jobs', routes: 'Routes', balance: 'Balance', service: 'Service' } as const;
export function dispatchTabs(active: keyof typeof TAB_LABELS): string {
  return `<div class="seg dtabs" role="tablist" aria-label="Dispatch">${(Object.keys(TAB_LABELS) as Array<keyof typeof TAB_LABELS>).map((v) =>
    `<button role="tab" aria-selected="${v === active}" class="${v === active ? 'on' : ''}" data-action="dispatch-tab" data-value="${v}">${TAB_LABELS[v]}</button>`).join('')}</div>`;
}

const chip = (job: LedgerJob) => `<span class="jchip ${['failed', 'stalled', 'node-lost'].includes(job.state) ? 'bad' : ledgerTerminal(job.state) ? '' : 'live'}">${esc(LEDGER_STATE_LABELS[job.state])}</span>`;
const link = (id: string) => `<button class="btn small ledger-link" data-job="${esc(id)}">${esc(id)}</button>`;

function filters(m: LedgerModel): string {
  const input = (key: string, label: string, value = '', type = 'text') => `<label>${label}<input id="ledger-${key}" data-ledger-filter="${key}" type="${type}" value="${esc(value)}"></label>`;
  const select = (key: 'state' | 'kind' | 'origin', label: string, options: readonly string[]) => `<label>${label}<select id="ledger-${key}" data-ledger-filter="${key}"><option value="">All</option>${options.map(value => `<option value="${value}" ${m.filters[key]?.includes(value as never) ? 'selected' : ''}>${key === 'state' ? LEDGER_STATE_LABELS[value as keyof typeof LEDGER_STATE_LABELS] : value}</option>`).join('')}</select></label>`;
  const date = (at: number | undefined) => at === undefined ? '' : new Date(at - new Date(at).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  return `<div class="ledger-filters">${select('state', T.state, LEDGER_STATES)}${select('kind', T.kind, LEDGER_KINDS)}${input('node', T.node, m.filters.node)}${select('origin', T.origin, ORIGIN_KINDS)}${input('route', T.route, m.filters.route)}${input('session', T.sessionId, m.scope === 'session' ? m.session : m.filters.session)}${input('from', T.from, date(m.filters.from), 'datetime-local')}${input('to', T.to, date(m.filters.to), 'datetime-local')}${input('text', T.text, m.filters.text)}</div>`;
}

function detail(m: JobsModel): string {
  const ledger = m.ledger, d = ledger.detail;
  if (ledger.detailError) return `<div class="rempty big" role="alert">${esc(ledger.detailError)}</div>`;
  if (!d) return `<div class="rempty big">${ledger.selected ? T.loading : T.pick}</div>`;
  const job = d.job;
  return `<section class="jdetail" aria-label="Job details"><div class="jhead"><h2>${esc(job.summary || job.id)}</h2>${chip(job)}${job.compacted ? `<span class="jchip">${T.compacted}</span>` : ''}${job.kind === 'augur-job' && !ledgerTerminal(job.state) ? `<button class="btn small" data-action="job-cancel" data-id="${esc(job.localId)}" ${m.busy ? 'disabled' : ''}>Cancel job</button>` : ''}</div>
    <dl class="jfields">${ledgerFacts(job).map(([label, value]) => `<div class="jf"><dt>${esc(label)}</dt><dd${label === 'Running time' ? ` data-ledger-elapsed="${esc(job.id)}"` : ''}>${esc(value)}</dd></div>`).join('')}${Object.entries(job.usage ?? {}).filter(([key]) => !['inputTokens', 'outputTokens', 'costUsd'].includes(key)).map(([key, value]) => `<div class="jf"><dt>${esc(key)}</dt><dd>${esc(String(value))}</dd></div>`).join('')}</dl>
    <h3>Parent</h3>${job.parentId ? link(job.parentId) : '<p class="help">None</p>'}<h3>Children</h3>${d.children.length ? d.children.map(child => link(child.id)).join('') : '<p class="help">None</p>'}<h3>Retries</h3>${d.retries.length ? d.retries.map(retry => link(retry.id)).join('') : '<p class="help">None</p>'}</section>`;
}

function row(card: JobCard, selected: string | null): string {
  return `<button class="ledger-row job-card tone-${card.tone} ${selected === card.id ? 'on' : ''} ${card.stalled ? 'stalled' : ''}" data-job="${esc(card.id)}" aria-pressed="${selected === card.id}"><span class="jmain">${card.lines.map(line =>
    `<span class="job-card-line job-card-${line.kind}"><b>${line.label}</b> <span${line.kind === 'timing' ? ` data-job-timing="${esc(card.id)}"` : ''}>${esc(line.text)}</span></span>`).join('')}</span></button>`;
}

export function renderJobs(m: JobsModel): string {
  const ledger = m.ledger;
  const now = Date.now(), cards = jobsCards(ledger.cards ?? ledgerJobsSnapshot(ledger.jobs ?? [], now), { now, scope: ledger.scope, sessionId: ledger.session, expanded: ledger.closedExpanded });
  const list = ledger.jobs === null ? `<div class="rempty big" role="status">${T.loading}</div>` : cards.live.length ? cards.live.map(card => row(card, ledger.selected)).join('') : `<div class="rempty big">${cards.empty}</div>`;
  const closed = `<button class="btn small" data-action="jobs-closed" aria-expanded="${cards.expanded}" aria-controls="jobs-closed">${esc(cards.closedHeading)}</button><section id="jobs-closed" ${cards.expanded ? '' : 'hidden'}>${cards.recent.length ? cards.recent.map(card => row(card, ledger.selected)).join('') : `<div class="rempty">${cards.noClosed}</div>`}</section>`;
  const status = m.service?.running ? `Service running${m.service.pid ? ` (process ${m.service.pid})` : ''}.` : m.service === null ? 'Checking the service.' : 'Service stopped.';
  return `<div class="rules-page jobs-page ledger-page ${ledger.selected ? 'has-sel' : ''}"><header class="top"><button class="icon" data-action="${ledger.selected ? 'job-close' : 'back'}" aria-label="${ledger.selected ? 'Back to jobs' : 'Back to usage'}">${ICON.back}</button><div><h1>Jobs</h1><div class="sub">Session and node job metadata</div></div><span class="grow"></span><button class="icon" data-action="jobs-refresh" aria-label="Refresh jobs">${ICON.refresh}</button></header>
    ${ledger.selected ? '' : dispatchTabs('jobs')}<div class="card rbanner ${m.service?.running ? 'ok' : ''}"><span class="grow">${esc(status)} ${esc(m.serviceNote)}</span>${m.service?.running === false ? '<button class="btn small" data-action="service-start">Start</button>' : ''}</div>
    <div class="seg" role="group" aria-label="${JOBS_CARD_TEXT.scope}">${(['session', 'all'] as const).map(scope => `<button class="${ledger.scope === scope ? 'on' : ''}" aria-pressed="${ledger.scope === scope}" data-action="jobs-scope" data-value="${scope}">${scope === 'session' ? JOBS_CARD_TEXT.scopeSession : JOBS_CARD_TEXT.scopeAll}</button>`).join('')}</div>${filters(ledger)}
    <div class="ledger-counts" aria-label="Counts by state">${LEDGER_STATES.map(state => `<span>${LEDGER_STATE_LABELS[state]} <b>${ledger.counts[state]}</b></span>`).join('')}</div>
    <div class="ledger-nodes" aria-label="Node health">${ledger.nodes.map(node => `<span class="lchip ${node.unreachableSince === null ? '' : 'down'}"><i></i>${esc(node.node)}: ${node.unreachableSince === null ? T.reachable : T.unreachable}<span class="jsub">Last poll: ${(node.lastPollAt ?? node.lastSeenAt) === null ? T.never : ledgerTime(node.lastPollAt ?? node.lastSeenAt)}${node.unreachableSince === null ? '' : ` / Unreachable since: ${ledgerTime(node.unreachableSince)}`}</span>${node.gap ? `<span class="jsub">History gap since ${ledgerTime(node.gap.at)}</span>` : ''}</span>`).join('')}</div>
    ${ledger.error ? `<div class="card rbanner bad" role="alert">${esc(ledger.error)}</div>` : ''}${ledger.loading && ledger.jobs !== null ? '<p class="help" role="status">Refreshing jobs.</p>' : ''}
    <div class="rules ${ledger.selected ? 'has-sel' : ''}"><section class="rlist jlist" aria-label="Job list">${list}${closed}<div class="actions"><button class="btn small" data-action="jobs-first" ${ledger.page ? '' : 'disabled'}>${T.first}</button><button class="btn small" data-action="jobs-next" ${ledger.next ? '' : 'disabled'}>${T.next}</button></div></section><div class="rdetail">${detail(m)}</div></div></div>`;
}
