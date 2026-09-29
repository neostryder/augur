import { ADAPTER_INFO, adapterInfo } from '@augur/dispatch-protocol';
import type { OptionSpec } from '@augur/dispatch-protocol';
import type { RouteDraft, RoutesFile } from '../routes-model';
import { ICON, esc } from '../util';
import { dispatchTabs } from './jobs';

export interface RoutesModel {
  /** Null until routes.json has been read. */
  file: RoutesFile | null;
  /** Why routes.json could not be used, or empty. */
  error: string;
  /** What the service says stops each route from running; null when the service could not be asked. */
  health: Record<string, string | null> | null;
  /** The route being edited by name, or '+' for a new one. */
  sel: string | null;
  draft: RouteDraft | null;
  formError: string;
  /** What the last save or delete did. */
  note: string;
  /** Model labels the rules already know, offered while typing a model. */
  models: string[];
  confirmDelete: boolean;
  busy: boolean;
}

const optionField = (spec: OptionSpec, value: string): string => {
  const id = `rt-opt-${spec.key}`;
  const control = spec.kind === 'choice'
    ? `<select id="${id}" data-rt-opt="${spec.key}"><option value="" ${value ? '' : 'selected'}>Default</option>${(spec.choices ?? []).map((c) => `<option value="${esc(c)}" ${c === value ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`
    : `<input type="${spec.kind === 'number' ? 'number' : 'text'}" id="${id}" data-rt-opt="${spec.key}" value="${esc(value)}" ${spec.kind === 'number' ? 'min="1"' : ''} placeholder="${esc(spec.placeholder ?? '')}" spellcheck="false" autocomplete="off">`;
  return `<div class="row rtrow"><label for="${id}"><span>${esc(spec.label)}${spec.required ? ' <i>(required)</i>' : ''}</span><small>${esc(spec.help)}</small></label>${control}</div>`;
};

function form(m: RoutesModel): string {
  const d = m.draft;
  if (!d) return `<div class="rempty big">${m.file ? 'Pick a route to edit it, or add one.' : 'Reading routes.json.'}</div>`;
  const isNew = m.sel === '+';
  const info = adapterInfo(d.adapter);
  return `<div class="rtform"><div class="rhead"><h2>${isNew ? 'New route' : esc(d.name)}</h2></div>
    <div class="row rtrow"><label for="rt-name"><span>Name</span><small>What agents pass to <code>augur run</code>. Lowercase letters, digits, hyphens and underscores.</small></label>
      <input type="text" id="rt-name" data-rt="name" value="${esc(d.name)}" ${isNew ? '' : 'readonly'} spellcheck="false" autocomplete="off" placeholder="luna"></div>
    <div class="row rtrow"><label for="rt-model"><span>Model</span><small>The label the rules page uses, as provider/model.</small></label>
      <input type="text" id="rt-model" data-rt="model" value="${esc(d.model)}" list="rt-models" spellcheck="false" autocomplete="off" placeholder="codex/luna">
      <datalist id="rt-models">${m.models.map((x) => `<option value="${esc(x)}"></option>`).join('')}</datalist></div>
    <div class="row rtrow"><label for="rt-adapter"><span>Adapter</span><small>${esc(info?.summary ?? '')}</small></label>
      <select id="rt-adapter" data-rt="adapter">${ADAPTER_INFO.map((a) => `<option value="${a.id}" ${a.id === d.adapter ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}</select></div>
    ${(info?.options ?? []).map((spec) => optionField(spec, d.options[spec.key] ?? '')).join('')}
    <div class="row rtrow"><label for="rt-notes"><span>Notes</span><small>For you. Agents do not see them.</small></label>
      <input type="text" id="rt-notes" data-rt="notes" value="${esc(d.notes)}" autocomplete="off"></div>
    <div class="row rtrow"><label for="rt-delegation"><span>May start more jobs</span><small>Lets a job on this route run <code>augur</code> itself, within the depth and count limits.</small></label>
      <input type="checkbox" id="rt-delegation" data-rt="delegation" ${d.delegation ? 'checked' : ''}></div>
    ${m.formError ? `<div class="rnote bad" role="alert">${esc(m.formError)}</div>` : ''}
    <div class="rtactions"><button class="btn small primary" data-action="route-save" ${m.busy ? 'disabled' : ''}>Save route</button>
      <button class="btn small" data-action="route-close">Cancel</button>
      ${isNew ? '' : m.confirmDelete ? `<button class="btn small danger" data-action="route-delete" ${m.busy ? 'disabled' : ''}>Delete it for good</button>` : '<button class="btn small" data-action="route-ask-delete">Delete</button>'}</div></div>`;
}

function row(m: RoutesModel, r: RoutesFile['routes'][number]): string {
  const problem = m.health ? m.health[r.name] ?? null : undefined;
  const state = problem === undefined ? '' : problem ? `<span class="jchip bad" title="${esc(problem)}">Cannot run</span>` : '<span class="jchip live">Ready</span>';
  return `<button class="jrow ${m.sel === r.name ? 'on' : ''}" data-route="${esc(r.name)}" aria-pressed="${m.sel === r.name}">
    <span class="jmain"><b>${esc(r.name)}</b><span class="jsub">${esc(r.model)} through ${esc(adapterInfo(r.adapter)?.label ?? r.adapter)}</span></span>${state}</button>
    ${problem ? `<div class="jsub rtproblem">${esc(problem)}</div>` : ''}`;
}

export function renderRoutes(m: RoutesModel): string {
  const list = !m.file ? '<div class="rempty big">Reading routes.json.</div>'
    : m.file.routes.length ? m.file.routes.map((r) => row(m, r)).join('') : '<div class="rempty big">No routes yet. A route joins a model to the program that runs it.</div>';
  const skipped = m.file?.skipped.length ? `<div class="card rbanner"><span class="grow"><b>The service skips ${m.file.skipped.length === 1 ? 'one entry' : `${m.file.skipped.length} entries`}:</b> ${m.file.skipped.map((n) => `<code>${esc(n)}</code>`).join(', ')}. A route needs a lowercase name, a model and an adapter. Saving here keeps them as they are.</span></div>` : '';
  const health = m.file && m.file.routes.length && m.health === null ? '<div class="rnote">Start the service on the Jobs page to see which routes can run.</div>' : '';
  return `<div class="rules-page jobs-page ${m.sel ? 'has-sel' : ''}"><header class="top">
    <button class="icon" data-action="${m.sel ? 'route-close' : 'back'}" title="${m.sel ? 'Back to the routes' : 'Back to usage'}" aria-label="${m.sel ? 'Back to the routes' : 'Back to usage'}">${ICON.back}</button>
    <div><h1>Routes</h1><div class="sub">How agents reach each model</div></div><span class="grow"></span>
    <button class="btn small" data-action="route-new">Add route</button></header>
    ${m.sel ? '' : dispatchTabs('routes')}
    ${m.error ? `<div class="card rbanner bad"><span class="grow"><b>routes.json cannot be used.</b> ${esc(m.error)}</span></div>` : ''}${skipped}${m.note ? `<div class="rnote" role="status">${esc(m.note)}</div>` : ''}${health}
    <div class="rules ${m.sel ? 'has-sel' : ''}"><div class="rlist jlist">${m.error ? '' : list}</div><div class="rdetail">${m.error ? '' : form(m)}</div></div></div>`;
}
