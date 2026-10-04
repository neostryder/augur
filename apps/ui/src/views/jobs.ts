import { ACTIVITY_LABELS, DATA_TIER_LABELS } from '@augur/core';
import { describeFigure } from '@augur/dispatch-protocol';
import type { Accounted, JobRecord, JobState } from '@augur/dispatch-protocol';
import { JOB_OUTPUT_LABELS, STATE_LABELS, TOOL_LABELS, duration, isBad, isLive } from '@augur/view-model';
import { ICON, ago, esc } from '../util';

export interface JobsModel {
  /** What the service answered to `service status`; null until the first answer. */
  service: { running: boolean; pid: number | null } | null;
  /** The line under the service card after the last Start or Stop. */
  serviceNote: string;
  /** Set when the app could not reach the bundled command at all. */
  unavailable: string;
  jobs: JobRecord[] | null;
  /** Tokens and cost of the listed jobs, each figure labelled reported, derived or imputed. */
  accounted: Record<string, Accounted>;
  sel: string | null;
  detail: { job: JobRecord; result: string; stdout: string; stderr: string } | null;
  busy: boolean;
}

export { STATE_LABELS, duration, isLive };

/** Jobs and Routes are two pages of the same area, so both carry this switch. */
const TAB_LABELS = { jobs: 'Jobs', routes: 'Routes', service: 'Service' } as const;
export function dispatchTabs(active: keyof typeof TAB_LABELS): string {
  return `<div class="seg dtabs" role="tablist" aria-label="Dispatch">${(Object.keys(TAB_LABELS) as Array<keyof typeof TAB_LABELS>).map((v) =>
    `<button role="tab" aria-selected="${v === active}" class="${v === active ? 'on' : ''}" data-action="dispatch-tab" data-value="${v}">${TAB_LABELS[v]}</button>`).join('')}</div>`;
}

const chip = (state: JobState) => `<span class="jchip ${isLive(state) ? 'live' : isBad(state) ? 'bad' : ''}">${esc(STATE_LABELS[state])}</span>`;

function serviceCard(m: JobsModel): string {
  if (m.unavailable) return `<div class="card rbanner bad"><span class="grow"><b>The dispatch service is not available.</b> ${esc(m.unavailable)}</span></div>`;
  const s = m.service;
  const state = s === null ? 'Checking the service.' : s.running ? `Service running${s.pid ? ` (process ${s.pid})` : ''}.` : 'Service stopped. Agents cannot start jobs until you start it.';
  // The service holds the usage engine, so the app keeps it running and offers no way to stop it here.
  const button = s === null || s.running ? '' : `<button class="btn small primary" data-action="service-start" ${m.busy ? 'disabled' : ''}>Start</button>`;
  return `<div class="card rbanner ${s?.running ? 'ok' : ''}"><span class="grow">${esc(state)}${m.serviceNote ? ` <span class="rnote" role="status">${esc(m.serviceNote)}</span>` : ''}</span>${button}</div>`;
}

function row(m: JobsModel, j: JobRecord): string {
  const when = j.startedAt ? `${duration(j)}` : ago(new Date(j.createdAt).toISOString());
  return `<button class="jrow ${m.sel === j.id ? 'on' : ''}" data-job="${esc(j.id)}" aria-pressed="${m.sel === j.id}">
    <span class="jmain"><b>${esc(j.route)}</b><span class="jsub">${esc(ACTIVITY_LABELS[j.activity] ?? j.activity)}, ${esc((DATA_TIER_LABELS[j.dataTier] ?? j.dataTier).toLowerCase())} data</span></span>
    ${chip(j.state)}<span class="jwhen">${esc(when)}</span></button>`;
}

const field = (label: string, value: string, wide = false) => `<div class="jf${wide ? ' wide' : ''}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;

function detail(m: JobsModel): string {
  const d = m.detail;
  if (!d) return `<div class="rempty big">${m.sel ? 'Loading the job.' : 'Pick a job to see its result and output.'}</div>`;
  const j = d.job;
  const acc = m.accounted[j.id];
  const usage = acc && (acc.inputTokens || acc.outputTokens) ? `${describeFigure(acc.inputTokens, 'tokens')} in, ${describeFigure(acc.outputTokens, 'tokens')} out` : '';
  const cost = acc?.costUsd ? describeFigure(acc.costUsd, 'usd') : '';
  const block = (title: string, text: string) => text.trim() ? `<h3>${esc(title)}</h3><pre class="jlog" tabindex="0">${esc(text.length > 6000 ? '...' + text.slice(-6000) : text)}</pre>` : '';
  return `<div class="jdetail"><div class="jhead"><h2>${esc(j.route)}</h2>${chip(j.state)}
    ${isLive(j.state) ? `<button class="btn small" data-action="job-cancel" data-id="${esc(j.id)}" ${m.busy ? 'disabled' : ''}>Cancel</button>` : ''}</div>
    ${j.reason ? `<p class="jreason">${esc(j.reason)}</p>` : ''}
    <div class="jfields">${field('Activity', ACTIVITY_LABELS[j.activity] ?? j.activity)}${field('Data', DATA_TIER_LABELS[j.dataTier] ?? j.dataTier)}
      ${field('Tools', TOOL_LABELS[j.tools] ?? j.tools)}${field('Output', JOB_OUTPUT_LABELS[j.output] ?? j.output)}${field('Adapter', j.adapter)}
      ${field('Started by', j.caller.label ?? j.caller.kind)}${field('Folder', j.cwd, true)}
      ${j.startedAt ? field('Took', duration(j)) : ''}${j.exitCode !== null ? field('Exit code', String(j.exitCode)) : ''}${usage ? field('Tokens', usage, true) : ''}${cost ? field('Cost', cost) : ''}
      ${j.patch ? field('Patch', `${j.patch.files} ${j.patch.files === 1 ? 'file' : 'files'}, apply with augur apply ${j.id}`) : ''}</div>
    ${block('Result', d.result)}${block('Output', d.stdout)}${block('Errors', d.stderr)}</div>`;
}

export function renderJobs(m: JobsModel): string {
  const list = m.jobs === null ? '<div class="rempty big">Loading jobs.</div>'
    : m.jobs.length ? m.jobs.map((j) => row(m, j)).join('') : '<div class="rempty big">No jobs yet. Agents start them with the augur command.</div>';
  return `<div class="rules-page jobs-page ${m.sel ? 'has-sel' : ''}"><header class="top">
    <button class="icon" data-action="${m.sel ? 'job-close' : 'back'}" title="${m.sel ? 'Back to the jobs' : 'Back to usage'}" aria-label="${m.sel ? 'Back to the jobs' : 'Back to usage'}">${ICON.back}</button>
    <div><h1>Jobs</h1><div class="sub">Work agents started through Augur</div></div><span class="grow"></span>
    <button class="icon" data-action="jobs-refresh" title="Refresh" aria-label="Refresh the jobs">${ICON.refresh}</button></header>
    ${m.sel ? '' : dispatchTabs('jobs')}${serviceCard(m)}
    <div class="rules ${m.sel ? 'has-sel' : ''}"><div class="rlist jlist">${list}</div><div class="rdetail">${detail(m)}</div></div></div>`;
}
