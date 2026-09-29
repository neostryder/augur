import { ACTIVITY_LABELS, DATA_TIER_LABELS } from '@augur/core';
import type { JobRecord, JobState } from '@augur/dispatch-protocol';
import { ICON, ago, esc } from '../util';

export interface JobsModel {
  /** What the service answered to `service status`; null until the first answer. */
  service: { running: boolean; pid: number | null } | null;
  /** The line under the service card after the last Start or Stop. */
  serviceNote: string;
  /** Set when the app could not reach the bundled command at all. */
  unavailable: string;
  jobs: JobRecord[] | null;
  sel: string | null;
  detail: { job: JobRecord; result: string; stdout: string; stderr: string } | null;
  busy: boolean;
}

export const STATE_LABELS: Record<JobState, string> = {
  queued: 'Queued', needs_approval: 'Needs approval', running: 'Running', cancel_requested: 'Cancelling', completed: 'Done', failed: 'Failed',
  artifact_validation_failed: 'Output check failed', cancelled: 'Cancelled', killed: 'Stopped', lost: 'Lost',
};
const LIVE = new Set<JobState>(['queued', 'needs_approval', 'running', 'cancel_requested']);
const BAD = new Set<JobState>(['failed', 'artifact_validation_failed', 'killed', 'lost']);
const TOOL_LABELS: Record<string, string> = { read: 'Reads only', write: 'Can write', full: 'Full access' };
const OUTPUT_LABELS: Record<string, string> = { write_files: 'Writes files', patch_only: 'Returns a patch', text_only: 'Text only' };

/** Jobs and Routes are two pages of the same area, so both carry this switch. */
export function dispatchTabs(active: 'jobs' | 'routes'): string {
  return `<div class="seg dtabs" role="tablist" aria-label="Dispatch">${(['jobs', 'routes'] as const).map((v) =>
    `<button role="tab" aria-selected="${v === active}" class="${v === active ? 'on' : ''}" data-action="dispatch-tab" data-value="${v}">${v === 'jobs' ? 'Jobs' : 'Routes'}</button>`).join('')}</div>`;
}

export const isLive = (state: JobState): boolean => LIVE.has(state);

export function duration(job: JobRecord, now = Date.now()): string {
  if (!job.startedAt) return '';
  const s = Math.max(0, Math.round(((job.endedAt ?? now) - job.startedAt) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const chip = (state: JobState) => `<span class="jchip ${LIVE.has(state) ? 'live' : BAD.has(state) ? 'bad' : ''}">${esc(STATE_LABELS[state])}</span>`;

function serviceCard(m: JobsModel): string {
  if (m.unavailable) return `<div class="card rbanner bad"><span class="grow"><b>The dispatch service is not available.</b> ${esc(m.unavailable)}</span></div>`;
  const s = m.service;
  const state = s === null ? 'Checking the service.' : s.running ? `Service running${s.pid ? ` (process ${s.pid})` : ''}.` : 'Service stopped. Agents cannot start jobs until it runs.';
  const button = s === null ? '' : s.running
    ? `<button class="btn small" data-action="service-stop" ${m.busy ? 'disabled' : ''}>Stop</button>`
    : `<button class="btn small primary" data-action="service-start" ${m.busy ? 'disabled' : ''}>Start</button>`;
  return `<div class="card rbanner ${s?.running ? 'ok' : ''}"><span class="grow">${esc(state)}${m.serviceNote ? ` <span class="rnote" role="status">${esc(m.serviceNote)}</span>` : ''}</span>${button}</div>`;
}

function row(m: JobsModel, j: JobRecord): string {
  const when = j.startedAt ? `${duration(j)}` : ago(new Date(j.createdAt).toISOString());
  return `<button class="jrow ${m.sel === j.id ? 'on' : ''}" data-job="${esc(j.id)}" aria-pressed="${m.sel === j.id}">
    <span class="jmain"><b>${esc(j.route)}</b><span class="jsub">${esc(ACTIVITY_LABELS[j.activity] ?? j.activity)}, ${esc((DATA_TIER_LABELS[j.dataTier] ?? j.dataTier).toLowerCase())} data</span></span>
    ${chip(j.state)}<span class="jwhen">${esc(when)}</span></button>`;
}

const field = (label: string, value: string) => `<div class="jf"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;

function detail(m: JobsModel): string {
  const d = m.detail;
  if (!d) return `<div class="rempty big">${m.sel ? 'Loading the job.' : 'Pick a job to see its result and output.'}</div>`;
  const j = d.job;
  const usage = j.usage ? `${j.usage.inputTokens.toLocaleString()} in, ${j.usage.outputTokens.toLocaleString()} out${j.usage.costUsd !== undefined ? `, $${j.usage.costUsd.toFixed(4)}` : ''}` : '';
  const block = (title: string, text: string) => text.trim() ? `<h3>${esc(title)}</h3><pre class="jlog" tabindex="0">${esc(text.length > 6000 ? '...' + text.slice(-6000) : text)}</pre>` : '';
  return `<div class="jdetail"><div class="jhead"><h2>${esc(j.route)}</h2>${chip(j.state)}
    ${isLive(j.state) ? `<button class="btn small" data-action="job-cancel" data-id="${esc(j.id)}" ${m.busy ? 'disabled' : ''}>Cancel</button>` : ''}</div>
    ${j.reason ? `<p class="jreason">${esc(j.reason)}</p>` : ''}
    <div class="jfields">${field('Activity', ACTIVITY_LABELS[j.activity] ?? j.activity)}${field('Data', DATA_TIER_LABELS[j.dataTier] ?? j.dataTier)}
      ${field('Tools', TOOL_LABELS[j.tools] ?? j.tools)}${field('Output', OUTPUT_LABELS[j.output] ?? j.output)}${field('Adapter', j.adapter)}
      ${field('Started by', j.caller.label ?? j.caller.kind)}${field('Folder', j.cwd)}
      ${j.startedAt ? field('Took', duration(j)) : ''}${j.exitCode !== null ? field('Exit code', String(j.exitCode)) : ''}${usage ? field('Tokens', usage) : ''}
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
