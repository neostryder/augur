// The Add provider page: the services on the left, the form and the plan on the right, laid out like the Routes page. The plan is drawn into its own
// element, so typing a field refreshes the plan without redrawing the form and losing the cursor.
import { PROVIDER_CHOICES, PROVIDER_FORM_TEXT as T, PRESETS, SHAPES, planOfForm, planRows, providerFields, routeEntryText } from '@augur/view-model';
import type { ProviderFormState } from '@augur/view-model';
import { ICON, esc } from '../util';

export interface AddProviderModel {
  form: ProviderFormState;
  /** Route names that exist, so a taken name is caught while typing. */
  existing: ReadonlySet<string>;
  /** On a narrow screen the list shows first and the form after a service is picked. */
  picked: boolean;
  busy: boolean;
  error: string;
}

type Field = keyof typeof T.fields;

const input = (f: Field, value: string, type = 'text'): string => {
  const t = T.fields[f];
  return `<div class="row rtrow"><label for="ap-${f}"><span>${esc(t.label)}</span><small>${esc(t.help)}</small></label>
    <input type="${type}" id="ap-${f}" data-ap="${f}" value="${esc(value)}" placeholder="${esc(t.placeholder)}" spellcheck="false" autocomplete="off"></div>`;
};

/** The plan, or what stops it, as the block under the form. */
export function planHtml(m: AddProviderModel): string {
  const got = planOfForm(m.form, m.existing);
  const jev = providerFields(m.form.kind).route === false;
  if ('problems' in got) {
    if (got.fresh || (jev && !got.problems.length)) return `<div class="rnote">${esc(jev ? T.freshJev : T.fresh)}</div>${applyRow(m, false)}`;
    return `<div class="rnote bad" role="status">${got.problems.map((p) => `<div>${esc(p)}</div>`).join('')}</div>${applyRow(m, false)}`;
  }
  const rows = planRows(got.plan).map((r) => `<tr><th scope="row">${esc(r.label)}</th><td>${esc(r.text)}${r.note ? `<small class="${r.tone === 'warn' ? 'ap-warn' : ''}">${esc(r.note)}</small>` : ''}</td></tr>`).join('');
  const entry = routeEntryText(got.plan);
  return `<table class="ap-plan">${rows}</table>${entry ? `<details class="ap-entry"><summary>${esc(T.showEntry)}</summary><pre>${esc(entry)}</pre></details>` : ''}${applyRow(m, true)}`;
}

const applyRow = (m: AddProviderModel, ok: boolean): string =>
  `<div class="rtactions">${m.error ? `<div class="rnote bad" role="alert">${esc(m.error)}</div>` : ''}<button class="btn small primary" data-action="provider-apply" ${ok && !m.busy ? '' : 'disabled'}>${esc(m.busy ? T.adding : T.add)}</button>
    <button class="btn small" data-action="provider-close">${esc(T.cancel)}</button></div>`;

function formHtml(m: AddProviderModel): string {
  const f = m.form, fields = providerFields(f.kind);
  const choice = PROVIDER_CHOICES.find((c) => c.id === f.kind)!;
  const preset = PRESETS.find((p) => p.id === f.kind);
  const shape = SHAPES.find((s) => s.id === (preset?.shape ?? f.kind));
  const rows = [
    fields.provider ? input('provider', f.provider) : '',
    fields.baseUrl ? input('baseUrl', f.baseUrl) : '',
    fields.route ? input('route', f.route) : '',
    fields.model ? input('model', f.model) : '',
    input('key', f.key, 'password'),
  ].join('');
  const more = f.more
    ? [!fields.provider && fields.route ? input('provider', f.provider) : '', !fields.baseUrl ? input('baseUrl', f.baseUrl) : '',
      ...(fields.model ? [input('label', f.label), input('maxTokens', f.maxTokens), ...(preset?.builtIn ? [] : [input('balanceUrl', f.balanceUrl), input('balancePath', f.balancePath)])] : [])].join('')
    : '';
  return `<div class="rtform"><div class="rhead"><span class="ap-mark" aria-hidden="true">${esc(choice.mark)}</span>
      <div class="grow"><h2>${esc(choice.label)}</h2><div class="sub">${esc(preset?.baseUrl ?? shape?.summary ?? '')}</div></div><span class="jchip live">${esc(shape?.label ?? '')}</span></div>
    ${rows}${more}
    <button class="btn small ap-more" data-action="provider-more" aria-expanded="${f.more}">${esc(f.more ? T.fewer : T.more)}</button>
    <div class="rsec ap-plan-label">${esc(T.plan)}</div><div id="ap-plan" class="ap-planbox">${planHtml(m)}</div></div>`;
}

export function renderAddProvider(m: AddProviderModel): string {
  const list = PROVIDER_CHOICES.map((c, i) => `${i && c.group !== PROVIDER_CHOICES[i - 1]!.group ? '<div class="ap-gap"></div>' : ''}
    <button class="jrow ${m.form.kind === c.id ? 'on' : ''}" data-provider-kind="${esc(c.id)}" aria-pressed="${m.form.kind === c.id}"><span class="ap-mark" aria-hidden="true">${esc(c.mark)}</span>
      <span class="jmain"><b>${esc(c.label)}</b><span class="jsub">${esc(c.sub)}</span></span></button>`).join('');
  return `<div class="rules-page jobs-page ${m.picked ? 'has-sel' : ''}"><header class="top">
    <button class="icon" data-action="${m.picked ? 'provider-list' : 'provider-close'}" title="${m.picked ? 'Back to the services' : 'Back to the routes'}" aria-label="${m.picked ? 'Back to the services' : 'Back to the routes'}">${ICON.back}</button>
    <div><h1>${esc(T.title)}</h1><div class="sub">${esc(T.sub)}</div></div></header>
    <div class="rules ${m.picked ? 'has-sel' : ''}"><div class="rlist jlist"><div class="rsec ap-list-label">${esc(T.service)}</div>${list}</div><div class="rdetail">${formHtml(m)}</div></div></div>`;
}
