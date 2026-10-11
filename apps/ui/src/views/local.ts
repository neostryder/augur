import { ACTIVITY_LABELS } from '@augur/core';
import type { JobRecord } from '@augur/dispatch-protocol';
import { LOCAL_TEXT, STATE_LABELS, isBad, isLive, servedText, type LocalCard, type LocalMachineRow, type LocalPage, type LocalRoleRow } from '@augur/view-model';
import { ICON, ago, esc } from '../util';

export interface LocalModel {
  /** Null until the Cogitator provider has answered, or while it is off. */
  page: LocalPage | null;
  /** True when the provider is on but has not produced a reading yet. */
  waiting: boolean;
  /** The machine open in the detail pane; the first one when unset or gone. */
  sel: string | null;
  /** True where the app carries the dispatch service, which is where the recent jobs come from. */
  canJobs: boolean;
  /** Recent jobs a gateway served, newest first. Null while loading. */
  jobs: JobRecord[] | null;
}

/** The dashboard card body: how many machines are up and one chip per role. The Open button is left out where only the summary is known. */
export function localCardBody(c: LocalCard): string {
  const chips = c.chips.map((x) => `<span class="lchip ${x.tone}" title="${esc(x.name)}"><i></i>${esc(x.text)}</span>`).join('');
  return `<div class="lsum"><b>${esc(c.summary)}</b><span class="grow"></span>${c.compact ? '' : `<button class="btn small" data-action="local">${LOCAL_TEXT.open}</button>`}</div>
    ${chips ? `<div class="lchips">${chips}</div>` : ''}${c.compact ? `<div class="notes">${LOCAL_TEXT.phoneOnly}</div>` : ''}`;
}

function machineCard(m: LocalMachineRow, on: boolean): string {
  return `<button class="lmach ${m.tone}${on ? ' on' : ''}" data-action="local-machine" data-value="${esc(m.name)}" aria-pressed="${on}">
    <span class="lname"><i class="ldot ${m.tone}"></i><b>${esc(m.name)}</b>${m.self ? '<span class="chip">This gateway</span>' : ''}</span>
    ${m.usedPct === null ? '' : `<span class="lbar" role="meter" aria-label="Memory held on ${esc(m.name)}" aria-valuenow="${m.usedPct}" aria-valuemin="0" aria-valuemax="100"><i class="${m.tone}" style="width:${m.usedPct}%"></i></span>`}
    <span class="lline">${esc(m.line)}</span></button>`;
}

function modelsTable(m: LocalMachineRow): string {
  if (!m.up) return `<div class="rempty">${esc(m.line)}</div>`;
  if (!m.models.length) return `<div class="rempty">${LOCAL_TEXT.noModels}</div>`;
  const c = LOCAL_TEXT.columns;
  return `<table class="ltable"><thead><tr><th>${c.model}</th><th>${c.role}</th><th>${c.held}</th><th>${c.lastUsed}</th></tr></thead><tbody>${m.models.map((r) =>
    `<tr class="${r.loaded ? '' : 'cold'}"><td><span class="lstate ${r.state === 'in use' ? 'busy' : r.loaded ? 'ready' : 'idle'}" title="${esc(r.state)}"></span>${esc(r.id)}</td><td>${esc(r.role)}</td><td>${esc(r.held)}</td><td>${esc(r.lastUsed || (r.loaded ? '' : r.state))}</td></tr>`).join('')}</tbody></table>`;
}

function roleRow(r: LocalRoleRow): string {
  const steps = r.chain.map((s, i) => `${i ? '<span class="larrow" aria-hidden="true">&rarr;</span>' : ''}<span class="lstep${s.serving ? ' serving' : ''}${s.up ? '' : ' down'}" title="${s.serving ? 'Serving now' : s.up ? 'Up' : 'Down'}">${esc(s.text)}</span>`).join('');
  return `<div class="lrole"><span class="lchip ${r.tone}"><i></i>${esc(r.name)}</span><span class="lchain">${steps}</span>
    ${r.note ? `<span class="lnote">${esc(r.note)}</span>` : ''}</div>`;
}

function recent(m: LocalModel): string {
  const rows = m.jobs === null ? '<div class="rempty">Loading jobs.</div>' : m.jobs.length ? m.jobs.map((j) => {
    const when = j.startedAt ? ago(new Date(j.startedAt).toISOString()) : ago(new Date(j.createdAt).toISOString());
    return `<div class="lrecent"><b>${esc(j.route)}</b><span class="jsub">${esc(ACTIVITY_LABELS[j.activity] ?? j.activity)}${j.served ? `, ${esc(servedText(j.served))}` : ''}</span>
      <span class="grow"></span><span class="jchip ${isLive(j.state) ? 'live' : isBad(j.state) ? 'bad' : ''}">${esc(STATE_LABELS[j.state])}</span><span class="jwhen">${esc(when)}</span></div>`;
  }).join('') : `<div class="rempty">${LOCAL_TEXT.noJobs}</div>`;
  return `<div class="rsec">${LOCAL_TEXT.recent}</div><div class="card lrecents">${rows}</div>`;
}

export function renderLocal(m: LocalModel): string {
  const head = (sub: string) => `<header class="top"><button class="icon" data-action="back" title="Back to usage" aria-label="Back to usage">${ICON.back}</button>
    <div><h1>${LOCAL_TEXT.title}</h1><div class="sub">${esc(sub)}</div></div><span class="grow"></span></header>`;
  const p = m.page;
  if (!p) return `<div class="rules-page jobs-page">${head(m.waiting ? LOCAL_TEXT.waiting : LOCAL_TEXT.empty)}</div>`;
  const open = p.machines.find((x) => x.name === m.sel) ?? p.machines[0];
  const sub = `${p.summary}${p.checked ? `, checked ${p.checked}` : ''}`;
  return `<div class="rules-page jobs-page local-page">${head(sub)}
    ${p.stale ? `<div class="card rbanner"><span class="grow">${LOCAL_TEXT.notReachable}</span></div>` : ''}
    <div class="lgrid"><div class="lrail"><div class="rsec">${LOCAL_TEXT.machines}</div>${p.machines.map((x) => machineCard(x, x === open)).join('')}</div>
      <div class="lmain">${open ? `<div class="rsec">${LOCAL_TEXT.loaded}, ${esc(open.name)}</div><div class="card">${modelsTable(open)}</div>` : ''}
        <div class="rsec">${LOCAL_TEXT.roles}</div><div class="card lroles">${p.roles.length ? p.roles.map(roleRow).join('') : `<div class="rempty">${LOCAL_TEXT.noRoles}</div>`}</div></div></div>
    ${m.canJobs ? recent(m) : ''}</div>`;
}
