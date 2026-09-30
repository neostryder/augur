import { dispatchTabs } from './jobs';
import { ICON, esc } from '../util';

/** One setting as `augur config --json` reports it. */
export interface ConfigLine {
  key: string; label: string; help: string; kind: 'number' | 'bool' | 'choice' | 'list'; choices?: string[]; min?: number; max?: number;
  weakens: boolean; value: string; default: string;
}

export interface ServiceModel {
  /** Null until the settings have been read. */
  lines: ConfigLine[] | null;
  service: { running: boolean; pid: number | null } | null;
  runJobs: boolean;
  note: string;
  error: string;
  busy: boolean;
  /** Set when the app could not reach the bundled command at all. */
  unavailable: string;
}

export const MODE_TEXT = {
  usage: 'Augur shows your plan usage and keeps your model rules. It does not run jobs.',
  jobs: 'Augur also runs a service on this computer. Agents start jobs with the augur command, and Augur picks the model from your rules and current usage.',
};

/** What each choice for the task classifier means for where task text goes. */
export const CLASSIFIER_TEXT: Record<string, string> = {
  none: 'Nothing classifies tasks. Agents give augur pick the activity and data tier themselves.',
  laya: 'Laya runs on your own computers, so task text stays on your network. Installing it is optional; the README has the steps.',
  jev: 'Jev is a hosted service from TypeSafe. With it on, the text of each task given to augur pick --task is sent there using your key. Text about students is checked on this computer first and never sent.',
};

/** The mode switch, used on the Service page and in first-run setup. */
export function modeChooser(runJobs: boolean): string {
  return `<div class="seg" role="radiogroup" aria-label="What Augur does for agents">${([['usage', 'Usage only'], ['jobs', 'Also run jobs']] as const).map(([v, label]) => {
    const on = (v === 'jobs') === runJobs;
    return `<button role="radio" aria-checked="${on}" class="${on ? 'on' : ''}" data-action="dispatch-mode" data-value="${v}">${label}</button>`;
  }).join('')}</div><p class="help">${esc(runJobs ? MODE_TEXT.jobs : MODE_TEXT.usage)}</p>`;
}

/** Who answers the questions behind augur pick --task, with what each choice does with task text. Used in first-run setup. */
export function classifierChooser(current: string): string {
  const choices: Array<[string, string]> = [['none', 'None'], ['laya', 'Laya'], ['jev', 'Jev']];
  return `<div class="seg" role="radiogroup" aria-label="Task classifier">${choices.map(([v, label]) =>
    `<button role="radio" aria-checked="${v === current}" class="${v === current ? 'on' : ''}" data-action="dispatch-classifier" data-value="${v}">${label}</button>`).join('')}</div>
    <p class="help">${esc(CLASSIFIER_TEXT[current] ?? '')}</p>`;
}

function control(l: ConfigLine, locked: boolean): string {
  const id = `cfg-${l.key}`, attrs = `id="${id}" data-cfg="${esc(l.key)}" ${locked ? 'disabled' : ''}`;
  if (l.kind === 'bool') return `<label class="switch"><input type="checkbox" ${attrs} ${l.value === 'true' ? 'checked' : ''} aria-label="${esc(l.label)}"><span></span></label>`;
  if (l.kind === 'choice') return `<select ${attrs}>${(l.choices ?? []).map((c) => `<option value="${esc(c)}" ${c === l.value ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`;
  if (l.kind === 'list') {
    const on = new Set(l.value.split(',').filter(Boolean));
    return `<div class="cfglist" ${attrs.replace(' disabled', '')}>${(l.choices ?? []).filter((c) => c !== 'exec' || on.has('exec')).map((c) =>
      `<label><input type="checkbox" data-cfg-item="${esc(l.key)}" value="${esc(c)}" ${on.has(c) ? 'checked' : ''} ${locked ? 'disabled' : ''}> ${esc(c)}</label>`).join('')}</div>`;
  }
  return `<input type="number" ${attrs} value="${esc(l.value)}" min="${l.min ?? 0}" max="${l.max ?? ''}">`;
}

function settingRow(l: ConfigLine): string {
  // A setting that lowers the service's checks, or a list that carries the exec adapter, is changed by hand so the page cannot switch it.
  const locked = l.weakens || (l.key === 'adapters' && l.value.split(',').includes('exec'));
  return `<div class="row rtrow"><label for="cfg-${esc(l.key)}"><span>${esc(l.label)}${l.value !== l.default ? ' <i>(changed)</i>' : ''}</span><small>${esc(l.help)}${locked ? ' Change it with augur config set, or in config.json.' : ''}</small></label>${control(l, locked)}</div>`;
}

export function renderService(m: ServiceModel): string {
  const s = m.service;
  const status = m.unavailable ? `<div class="card rbanner bad"><span class="grow"><b>The dispatch service is not available.</b> ${esc(m.unavailable)}</span></div>`
    : `<div class="card rbanner ${s?.running ? 'ok' : ''}"><span class="grow">${s === null ? 'Checking the service.' : s.running ? `Service running${s.pid ? ` (process ${s.pid})` : ''}.` : 'Service stopped.'}${m.note ? ` <span class="rnote" role="status">${esc(m.note)}</span>` : ''}</span>
      ${s?.running ? `<button class="btn small" data-action="service-restart" ${m.busy ? 'disabled' : ''}>Restart</button>` : ''}</div>`;
  const decision = m.lines?.find((l) => l.key === 'decision.backend')?.value ?? 'none';
  const rows = m.lines ? m.lines.map(settingRow).join('') : '<div class="rempty big">Reading the settings.</div>';
  return `<div class="rules-page jobs-page"><header class="top"><button class="icon" data-action="back" title="Back to usage" aria-label="Back to usage">${ICON.back}</button>
    <div><h1>Service</h1><div class="sub">The dispatch service on this computer</div></div><span class="grow"></span></header>
    ${dispatchTabs('service')}
    <div class="card"><div class="rsec" style="margin-top:0">What Augur does for agents</div>${modeChooser(m.runJobs)}</div>
    ${m.runJobs ? `${status}${m.error ? `<div class="rnote bad" role="alert">${esc(m.error)}</div>` : ''}
    <div class="card"><div class="rsec" style="margin-top:0">Settings</div><p class="help">A running service reads these when it next starts.</p>${rows}
      <div class="rnote">${esc(CLASSIFIER_TEXT[decision] ?? '')}</div></div>` : ''}</div>`;
}
