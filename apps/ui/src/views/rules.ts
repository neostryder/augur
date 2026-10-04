import {
  pendingCount, ACTIVITIES, ACTIVITY_LABELS, COST_TIERS, DATA_TIERS, DATA_TIER_LABELS, OUTPUT_MODES, WEIGHT_LABELS, WEIGHT_LEVELS,
  fieldPath, latestOnly, pauseActive, resolveModel, resolveThresholds,
  type AppConfig, type EditState, type ModelCatalog, type ModelEntry, type PolicyChange, type ProviderPlugin, type Rule, type Snapshot,
} from '@augur/core';
import { BULK_FIELDS } from '../rules-bulk';
import type { BulkPreview } from '../rules-bulk';
import type { DialBackPlan } from '../dial-back';
import { ICON, ago, esc } from '../util';

export type RulesFilter = 'all' | 'needs' | 'imported' | 'confirmed' | 'hidden';

/** A change an agent asked for that waits for the owner: what it would change, from what, and why. */
export interface HeldRow { id: string; by: string; model: string; field: string; before: string; value: string; reason: string }

const HELD_LABELS: Record<string, string> = { dataTier: 'the most sensitive data', askFirst: 'ask first', output: 'output', sandbox: 'sandbox', effort: 'effort', cost: 'cost', status: 'status' };
const heldValue = (v: unknown): string => (v === null || v === undefined ? 'none' : typeof v === 'string' ? v : JSON.stringify(v));

/** The held edits as rows for the rules page, each with the value the rules have now. */
export function heldRows(state: EditState): HeldRow[] {
  return state.held.map((h) => {
    const before = [...state.results].reverse().find((r) => r.id === h.id)?.before;
    const field = HELD_LABELS[h.field] ?? h.field.replace('dataHandling.', 'data handling: ').replace('thresholds.', 'limit: ');
    return { id: h.id, by: h.by, model: h.model || h.provider, field, before: heldValue(before), value: heldValue(h.value), reason: h.reason ?? '' };
  });
}

function heldCards(rows: HeldRow[]): string {
  return rows.map((r) => `<div class="card rbanner held"><span class="grow"><b>${esc(r.by)}</b> asks to change ${esc(r.field)} on <b>${esc(r.model)}</b> from ${esc(r.before)} to <b>${esc(r.value)}</b>.${r.reason ? ` <span class="desc">${esc(r.reason)}</span>` : ''}</span>
    <button class="btn small primary" data-action="edit-accept" data-edit="${esc(r.id)}">Accept</button><button class="btn small" data-action="edit-dismiss" data-edit="${esc(r.id)}">Dismiss</button></div>`).join('');
}

export interface RulesModel {
  config: AppConfig;
  /** Changes agents asked for that wait for the owner's yes. */
  held: HeldRow[];
  providers: Array<{ id: string; name: string; metered: boolean }>;
  plugins: Map<string, ProviderPlugin>;
  snapshot: Snapshot | null;
  dark: boolean;
  /** Why the last policy.json write failed, or null. While set, agents keep using the older file. */
  policyError: string | null;
  /** The provider defaults (model null) or model whose rules are open. */
  sel: { provider: string; model: string | null } | null;
  query: string;
  filter: RulesFilter;
  open: Set<string>;
  /** Bulk selection, as `<provider>|<model label>`. */
  picked: Set<string>;
  showHistory: boolean;
  addError: string;
  /** What the last bulk action did, shown in the bulk bar until the selection changes. */
  note: string;
  /** The data tier last applied from the bulk bar. */
  bulkTier: string;
  /** The field chosen for a bulk edit, the value typed or picked for it, and the list of changes it would make. */
  bulkField: string;
  bulkValue: string;
  preview: BulkPreview | null;
  /** The dial-back card: whether it is open, when it should end, and the plan it would apply. */
  dialOpen: boolean;
  dialEnd: string;
  dialCustom: string;
  dialPlan: DialBackPlan | null;
  dialError: string;
  /** What a pause about to be set does: stop the model, or change its weights while it lasts. */
  pauseMode: 'off' | 'weights';
  /** Weights chosen for that pause, by activity. An empty value leaves the activity as it is. */
  pauseWeights: Record<string, string>;
  catalog: ModelCatalog;
  /** Providers whose model list is being read right now. */
  listing: Set<string>;
  /** Only the desktop reads model lists. */
  canList: boolean;
}

const OUTPUT_LABELS: Record<string, string> = { write_files: 'Writes files', patch_only: 'Returns a patch', text_only: 'Text only' };
const COST_LABELS: Record<string, string> = { free: 'Free', very_cheap: 'Very cheap', cheap: 'Cheap', moderate: 'Moderate', high: 'High', very_high: 'Very high' };
const STATUS_LABELS: Record<ModelEntry['status'], string> = { confirmed: 'Confirmed', imported: 'Imported', unreviewed: 'Needs rules', hidden: 'Hidden' };
const FILTERS: Array<[RulesFilter, string]> = [['all', 'All'], ['needs', 'Needs review'], ['confirmed', 'Confirmed'], ['hidden', 'Hidden']];

const opt = (value: string, label: string, current: string) => `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`;

function colorOf(m: RulesModel, pid: string): string {
  const custom = (m.config.providers.find((p) => p.id === pid)?.settings?.color as string | undefined) || '';
  const c = m.plugins.get(pid)?.color;
  return custom || (c ? (m.dark ? c.dark : c.light) : 'var(--muted)');
}

const policyOf = (m: RulesModel) => m.config.policy ?? { providers: {}, stamps: {}, history: [] };

function matches(m: RulesModel, label: string, model: ModelEntry): boolean {
  if (m.filter === 'needs' && model.status !== 'unreviewed' && model.status !== 'imported') return false;
  if (m.filter === 'imported' && model.status !== 'imported') return false;
  if (m.filter === 'confirmed' && model.status !== 'confirmed') return false;
  if (m.filter === 'hidden' ? model.status !== 'hidden' : m.filter === 'all' && model.status === 'hidden') return false;
  const q = m.query.trim().toLowerCase();
  return !q || [label, model.id, model.name ?? ''].some((s) => s.toLowerCase().includes(q));
}

/** Models waiting for a decision: new ones from a live list, and imported ones not yet confirmed. */
export { pendingCount };

function summary(provider: string, defaults: Rule, model: ModelEntry): string {
  const r = resolveModel(provider, defaults, model);
  const acts = ACTIVITIES.filter((a) => r.activities[a]).sort((a, b) => WEIGHT_LEVELS.indexOf(r.activities[b]!) - WEIGHT_LEVELS.indexOf(r.activities[a]!));
  const names = acts.slice(0, 2).map((a) => ACTIVITY_LABELS[a]).join(', ');
  const acts_ = acts.length ? names + (acts.length > 2 ? ` +${acts.length - 2}` : '') : 'No activities allowed';
  return `${acts_}, ${DATA_TIER_LABELS[r.dataTier]}${r.askFirst ? ', Ask first' : ''}${r.useAfter.length ? `, Waits for ${r.useAfter.length}` : ''}`;
}

function modelRow(m: RulesModel, pid: string, defaults: Rule, label: string, model: ModelEntry): string {
  const key = `${pid}|${label}`, on = m.sel?.provider === pid && m.sel.model === label;
  const pause = model.rule.pause ?? defaults.pause, paused = pauseActive(pause);
  const chip = model.status === 'confirmed' ? '' : `<span class="chip ${model.status === 'unreviewed' ? 'stale' : ''}">${esc(STATUS_LABELS[model.status])}</span>`;
  return `<div class="rrow ${on ? 'on' : ''}">
    <input type="checkbox" data-pick="${esc(key)}" ${m.picked.has(key) ? 'checked' : ''} aria-label="Select ${esc(model.name ?? label)}">
    <button class="rpick" data-rsel="${esc(pid)}" data-rmodel="${esc(label)}">
      <span class="rname">${esc(model.name ?? model.id)} ${chip}${paused ? `<span class="chip">${pause?.weights ? 'Weights changed' : 'Paused'}</span>` : ''}</span>
      <span class="rsum">${esc(label)}, ${esc(summary(pid, defaults, model))}</span></button></div>`;
}

function providerBlock(m: RulesModel, meta: RulesModel['providers'][number]): string {
  const p = policyOf(m).providers[meta.id] ?? { defaults: {}, models: {} };
  const rows = Object.entries(p.models).filter(([label, model]) => matches(m, label, model)).sort(([a], [b]) => a.localeCompare(b));
  const total = Object.values(p.models).filter((x) => x.status !== 'hidden').length;
  const pending = Object.values(p.models).filter((x) => x.status === 'unreviewed' || x.status === 'imported').length;
  const searching = m.query.trim() !== '' || m.filter !== 'all';
  if (searching && !rows.length) return '';
  const open = m.open.has(meta.id) || searching;
  const allPicked = rows.length > 0 && rows.every(([label]) => m.picked.has(`${meta.id}|${label}`));
  const defaultsOn = m.sel?.provider === meta.id && m.sel.model === null;
  const mine = new Set(Object.keys(p.models)), drained = Object.values(policyOf(m).providers).some((q) => Object.values(q.models).some((x) => x.status === 'confirmed' && (x.rule.useAfter ?? q.defaults.useAfter ?? []).some((l) => mine.has(l))));
  return `<section class="card rprov">
    <div class="phead">
      <span class="dot" style="background:${esc(colorOf(m, meta.id))}"></span>
      <span class="pname">${esc(meta.name)}${meta.metered ? '' : '<span class="chip">No usage data</span>'}${drained ? '<span class="chip">Used up first</span>' : ''}${pending ? `<span class="chip stale">${pending} ${pending === 1 ? 'needs' : 'need'} review</span>` : ''}</span>
      <span class="age">${total} ${total === 1 ? 'model' : 'models'}</span>
      <button class="link" data-rprov="${esc(meta.id)}" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} ${esc(meta.name)} models" style="transform:rotate(${open ? 0 : -90}deg)">${ICON.chevron}</button></div>
    ${open ? `<div class="rlist-body">
      <div class="rrow ${defaultsOn ? 'on' : ''}">${rows.length ? `<input type="checkbox" data-pick-all="${esc(meta.id)}" ${allPicked ? 'checked' : ''} aria-label="Select all ${esc(meta.name)} models shown">` : '<span class="rspacer"></span>'}
        <button class="rpick" data-rsel="${esc(meta.id)}" data-rmodel=""><span class="rname">Provider defaults</span><span class="rsum">Every model below uses these unless it sets its own</span></button></div>
      ${rows.map(([label, model]) => modelRow(m, meta.id, p.defaults, label, model)).join('')}
      ${!rows.length ? '<div class="rempty">No models yet. Open the provider defaults to add one.</div>' : ''}
    </div>` : ''}</section>`;
}

// ------------------------------------------------------------------ detail

function control(id: string, path: string, kind: string, options: string[]): string {
  return `<select id="${esc(id)}" data-rule="${esc(path)}" data-kind="${esc(kind)}">${options.join('')}</select>`;
}

/** Checkboxes for the other models this one waits on. The provider of each checked model is used up in full before this model is picked. */
function waitRows(m: RulesModel, pid: string, model: string, own: string[] | undefined, inherited: string[] | undefined): string {
  const path = fieldPath(pid, model, 'useAfter'), on = new Set(own ?? inherited ?? []);
  const others = Object.entries(policyOf(m).providers).flatMap(([id, p]) => Object.entries(p.models).filter(([label, x]) => label !== model && x.status !== 'hidden').map(([label, x]) => ({ id, label, name: x.name ?? x.id })));
  const boxes = others.map((x) => `<label class="wait"><input type="checkbox" data-wait="${esc(path)}" value="${esc(x.label)}" ${on.has(x.label) ? 'checked' : ''}> ${esc(x.name)} <span class="desc">${esc(x.label)}</span></label>`).join('');
  return `<div class="row wrap"><span class="name">Use only after<span class="desc">Stays out of picks until every model checked here is spent, paused or down. Their providers are used up in full instead of paced.</span></span>
    <div class="waitlist">${boxes || '<span class="desc">No other models to choose from.</span>'}</div></div>`;
}

function row(label: string, id: string, input: string, help = ''): string {
  return `<div class="row"><label class="name" for="${esc(id)}">${esc(label)}${help ? `<span class="desc">${esc(help)}</span>` : ''}</label>${input}</div>`;
}

function enumSelect(pid: string, model: string | null, field: string, values: readonly string[], labels: Record<string, string>, own: unknown, inherited: unknown, unset: string): string {
  const id = `r-${field}`;
  // A provider has nothing to inherit, so its unset value is the plain default and shows as that option instead of a duplicate of it.
  const fallback = values.find((v) => (labels[v] ?? v) === unset) ?? '';
  const cur = own === undefined ? (model === null ? fallback : '') : String(own);
  const rest = values.map((v) => opt(v, labels[v] ?? v, cur));
  if (model === null) return control(id, fieldPath(pid, model, field), 'enum', rest);
  const first = opt('', `Default (${inherited === undefined ? unset : labels[String(inherited)] ?? String(inherited)})`, cur);
  return control(id, fieldPath(pid, model, field), 'enum', [first, ...rest]);
}

function boolSelect(pid: string, model: string | null, field: string, own: boolean | undefined, inherited: boolean | undefined): string {
  const cur = own === undefined ? (model === null ? 'no' : '') : own ? 'yes' : 'no', yn = (b: boolean | undefined) => (b ? 'Yes' : 'No');
  const rest = [opt('yes', 'Yes', cur), opt('no', 'No', cur)];
  return control(`r-${field}`, fieldPath(pid, model, field), 'bool', model === null ? rest : [opt('', `Default (${yn(inherited)})`, cur), ...rest]);
}

function activityRows(pid: string, model: string | null, rule: Rule, defaults: Rule): string {
  return ACTIVITIES.map((a) => {
    const own = rule.activities?.[a], inherited = defaults.activities?.[a], cur = own === undefined ? '' : own === null ? 'none' : own;
    const first = model === null ? opt('', 'Not allowed', cur) : opt('', `Default (${inherited ? WEIGHT_LABELS[inherited] : 'Not allowed'})`, cur);
    const options = [first, ...(model === null ? [] : [opt('none', 'Not allowed', cur)]), ...WEIGHT_LEVELS.map((w) => opt(w, WEIGHT_LABELS[w], cur))];
    return row(ACTIVITY_LABELS[a], `r-act-${a}`, control(`r-act-${a}`, fieldPath(pid, model, `activities.${a}`), 'act', options));
  }).join('');
}

/** Each part of the data handling is its own field, so a model can set one and inherit the rest from its provider. */
function handlingRows(pid: string, model: string | null, own: Rule['dataHandling'], inherited: Rule['dataHandling']): string {
  const text = (key: 'hostCountry' | 'pinnedHost', label: string, placeholder: string) => {
    const mine = own?.[key], theirs = model !== null ? inherited?.[key] : undefined;
    const hint = model !== null && theirs ? `Default (${theirs})` : placeholder;
    return row(label, `r-dh-${key}`, `<input type="text" id="r-dh-${key}" data-rule="${esc(fieldPath(pid, model, `dataHandling.${key}`))}" data-kind="text" value="${esc(mine ?? '')}" placeholder="${esc(hint)}" style="max-width:150px">`);
  };
  const tri = (key: 'retainsPrompts' | 'trainsOnPrompts', label: string) => {
    const mine = own?.[key], theirs = model !== null ? inherited?.[key] : undefined, word = (v: boolean | null | undefined) => (v === true ? 'Yes' : v === false ? 'No' : 'Unknown');
    const cur = mine === undefined ? '' : mine === true ? 'yes' : mine === false ? 'no' : 'unknown';
    const first = model === null ? opt('', 'Unknown', cur) : opt('', `Default (${word(theirs)})`, cur);
    return row(label, `r-dh-${key}`, control(`r-dh-${key}`, fieldPath(pid, model, `dataHandling.${key}`), 'tri', [first, ...(model === null ? [] : [opt('unknown', 'Unknown', cur)]), opt('yes', 'Yes', cur), opt('no', 'No', cur)]));
  };
  return text('hostCountry', 'Host country', 'US') + tri('retainsPrompts', 'Keeps prompts') + tri('trainsOnPrompts', 'Trains on prompts') + text('pinnedHost', 'Pinned host', 'None');
}

/** How old a provider's last good reading may be before its reset times are not trusted for a pause. */
export const RESET_TRUST_MS = 30 * 60_000;

/**
 * The resets a pause may wait for: meters whose reset is still ahead. When the provider's last reading failed or is old, none are offered and the reason is
 * returned instead, since a reset time from a stale reading could end the pause at the wrong moment.
 */
export function pauseResets(snapshot: Snapshot | null, pid: string, now = Date.now()): { meters: Array<{ id: string; label: string; resetsAt: string }>; blocked: string | null } {
  const p = snapshot?.providers[pid];
  const meters = (p?.meters ?? []).flatMap((x) => (x.resetsAt && new Date(x.resetsAt).getTime() > now ? [{ id: x.id, label: x.label, resetsAt: x.resetsAt }] : []));
  if (!p) return { meters, blocked: null };
  const age = p.fetchedAt ? now - new Date(p.fetchedAt).getTime() : Infinity;
  if (p.stale || !p.ok) return { meters: [], blocked: 'The last reading failed, so its reset times may be out of date. Refresh, then choose one.' };
  if (age > RESET_TRUST_MS) return { meters: [], blocked: 'The last reading is more than 30 minutes old, so its reset times may be out of date. Refresh, then choose one.' };
  return { meters, blocked: null };
}

function pauseRows(m: RulesModel, pid: string, model: string | null, own: Rule['pause'], inherited: Rule['pause']): string {
  const path = fieldPath(pid, model, 'pause'), { meters, blocked } = pauseResets(m.snapshot, pid);
  const known = m.snapshot?.providers[pid]?.meters ?? [];
  const shown = own ?? (model !== null ? inherited : null), active = pauseActive(shown);
  const local = (iso: string) => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
  let html = '';
  if (shown && active) {
    const until = new Date(shown.until).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const changed = shown.weights ? ACTIVITIES.filter((a) => a in shown.weights!).map((a) => `${ACTIVITY_LABELS[a]} ${shown.weights![a] ? WEIGHT_LABELS[shown.weights![a]!].toLowerCase() : 'not allowed'}`) : [];
    html += `<div class="rnote">${changed.length ? 'Weights changed' : 'Paused'} until ${esc(until)}${shown.meter ? ` (the ${esc(known.find((x) => x.id === shown.meter)?.label ?? shown.meter)} reset)` : ''}${own === undefined ? ', set on the provider' : ''}.${changed.length ? ` ${esc(changed.join(', '))}.` : ''}${shown.reason ? ` ${esc(shown.reason)}` : ''}</div>`;
    if (own) html += `<div class="actions" style="margin-top:4px"><button class="btn small" data-pause-clear="${esc(path)}">Resume now</button></div>`;
    return html;
  }
  html += row('While paused', 'r-pause-mode', `<select id="r-pause-mode" data-pause-mode>${opt('off', 'Do not use this model', m.pauseMode)}${opt('weights', 'Use different weights', m.pauseMode)}</select>`,
    'Weights replace the ones below until the pause ends, so a cheaper model can be favoured for a week.');
  if (m.pauseMode === 'weights') {
    html += ACTIVITIES.map((a) => {
      const cur = m.pauseWeights[a] ?? '';
      return row(ACTIVITY_LABELS[a], `r-pw-${a}`, `<select id="r-pw-${a}" data-pause-weight="${a}">${opt('', 'Leave as is', cur)}${opt('none', 'Not allowed', cur)}${WEIGHT_LEVELS.map((w) => opt(w, WEIGHT_LABELS[w], cur)).join('')}</select>`);
    }).join('');
  }
  html += row('Pause until', 'r-pause-until', `<input type="datetime-local" id="r-pause-until" data-pause-until="${esc(path)}" min="${esc(local(new Date().toISOString()))}">`,
    'Routers skip this model until then.');
  if (blocked) html += `<div class="rnote">${esc(blocked)}</div>`;
  if (meters.length) html += row('Or until a reset', 'r-pause-meter', `<select id="r-pause-meter" data-pause-meter="${esc(path)}">${opt('', 'Choose a meter', '')}${meters.map((x) => opt(x.id, x.label, '')).join('')}</select>`);
  return html;
}

function thresholdRows(m: RulesModel, pid: string): string {
  const own = policyOf(m).providers[pid]?.thresholds ?? {}, t = resolveThresholds(policyOf(m).providers[pid]);
  const num = (key: 'warnPct' | 'denyPct' | 'minBalance', label: string, help: string, step: string) => row(label, `r-t-${key}`,
    `<input type="number" id="r-t-${key}" data-rule="${esc(fieldPath(pid, null, `thresholds.${key}`))}" data-kind="num" step="${step}" min="0" ${key === 'minBalance' ? '' : 'max="100"'} value="${esc(own[key] ?? '')}" placeholder="${esc(t[key] ?? 'None')}">`, help);
  return num('warnPct', 'Warn at', 'Percent used on any meter. 90 if left empty.', '1')
    + num('denyPct', 'Stop at', 'Routers skip the provider past this. 98 if left empty.', '1')
    + num('minBalance', 'Minimum balance', 'For pay-as-you-go credit, in dollars. None if left empty.', '0.05');
}

function detail(m: RulesModel): string {
  if (!m.sel) return `<div class="rempty big">Choose a provider's defaults or a model to see its rules.</div>`;
  const { provider: pid, model } = m.sel, meta = m.providers.find((p) => p.id === pid);
  const p = policyOf(m).providers[pid] ?? { defaults: {}, models: {} }, entry = model ? p.models[model] : undefined;
  if (!meta || (model && !entry)) return `<div class="rempty big">That model is no longer listed.</div>`;
  const rule = entry ? entry.rule : p.defaults, d = p.defaults, isModel = model !== null;
  const title = entry ? entry.name ?? entry.id : `${meta.name} defaults`;

  let html = `<div class="rhead"><button class="icon rback" data-rsel="" title="Back to the list" aria-label="Back to the list">${ICON.back}</button>
    <div><h2>${esc(title)}</h2><div class="sub">${esc(isModel ? `${model}, ${entry!.id}` : `Used by every ${meta.name} model that leaves a field unset`)}</div></div></div>`;

  if (entry) {
    const path = fieldPath(pid, model, 'status');
    const blurb: Record<ModelEntry['status'], string> = {
      unreviewed: 'New model. Routers skip it until its rules are confirmed.',
      imported: 'Imported rules. Routers skip it until they are confirmed.',
      confirmed: 'Routers use these rules.',
      hidden: 'Hidden. Routers never see it, and it is left out of policy.json.',
    };
    const older = entry.supersedes ? p.models[entry.supersedes] : undefined;
    const text = older && entry.status !== 'confirmed' && entry.status !== 'hidden'
      ? `A newer version of ${older.name ?? older.id}, set up with the same rules. Routers skip it until you confirm the rules, and then ${older.name ?? older.id} is hidden.`
      : blurb[entry.status];
    html += `<div class="card rstatus"><span class="grow">${esc(text)}</span>
      ${entry.status === 'confirmed' || entry.status === 'hidden' ? '' : `<button class="btn small primary" data-status="${esc(path)}" data-value="confirmed">Confirm rules</button>`}
      <button class="btn small" data-status="${esc(path)}" data-value="${entry.status === 'hidden' ? 'unreviewed' : 'hidden'}">${entry.status === 'hidden' ? 'Show model' : 'Hide model'}</button></div>`;
  }

  html += `<h3 class="rsec">Allowed activities</h3><div class="card">${activityRows(pid, model, rule, d)}</div>`;
  html += `<h3 class="rsec">Data</h3><div class="card">
    ${row('Most sensitive data', 'r-dataTier', enumSelect(pid, model, 'dataTier', DATA_TIERS, DATA_TIER_LABELS, rule.dataTier, d.dataTier, 'Public'),
      'Internal is your own code and plans. Sensitive covers customer, business and personal data. Regulated covers student records.')}
    ${handlingRows(pid, model, rule.dataHandling, d.dataHandling)}</div>`;
  html += `<h3 class="rsec">How agents use it</h3><div class="card">
    ${row('Ask first', 'r-askFirst', boolSelect(pid, model, 'askFirst', rule.askFirst, d.askFirst), 'Used only when named for the task, never picked by a router.')}
    ${row('Output', 'r-output', enumSelect(pid, model, 'output', OUTPUT_MODES, OUTPUT_LABELS, rule.output, d.output, 'Text only'))}
    ${row('Runs in a sandbox', 'r-sandbox', boolSelect(pid, model, 'sandbox', rule.sandbox, d.sandbox))}
    ${row('Cost', 'r-cost', enumSelect(pid, model, 'cost', COST_TIERS, COST_LABELS, rule.cost, d.cost, 'Moderate'), 'Higher-cost models drop out first when usage runs high.')}
    ${isModel ? waitRows(m, pid, model!, rule.useAfter, d.useAfter) : ''}
    ${row('Reasoning effort', 'r-effort', `<input type="text" id="r-effort" data-rule="${esc(fieldPath(pid, model, 'effort'))}" data-kind="text" value="${esc(rule.effort ?? '')}" placeholder="${esc(isModel ? d.effort ?? 'Default' : 'Default')}" style="max-width:150px">`)}
  </div>`;
  html += `<h3 class="rsec">Pause</h3><div class="card">${pauseRows(m, pid, model, rule.pause, d.pause)}</div>`;
  if (!isModel && meta.metered) html += `<h3 class="rsec">Usage limits</h3><div class="card">${thresholdRows(m, pid)}</div>`;
  html += `<h3 class="rsec">Notes for agents</h3><div class="card"><div class="field"><textarea id="r-notes" data-rule="${esc(fieldPath(pid, model, 'notes'))}" data-kind="text" rows="3" style="min-height:64px" placeholder="${esc(isModel && d.notes ? d.notes : 'Guidance no field covers, such as when to avoid it.')}">${esc(rule.notes ?? '')}</textarea></div></div>`;
  if (!isModel) html += modelListSection(m, pid, p.listMode, Object.values(p.models).map((x) => x.id));
  return html;
}

function modelListSection(m: RulesModel, pid: string, own: 'auto' | 'catalog' | undefined, have: string[]): string {
  const plugin = m.plugins.get(pid), entry = m.catalog[pid];
  let html = '';
  if (plugin?.listModels) {
    const labels = { auto: 'Add new models for review', catalog: 'Keep as a list to pick from' };
    const fallback = plugin.modelListMode ?? 'auto';
    const status = m.listing.has(pid) ? 'Checking now.'
      : entry ? `Checked ${ago(entry.fetchedAt)}. ${latestOnly(entry.models).length} current models.${entry.error ? ` The last check failed: ${entry.error}` : ''}`
      : 'Not checked yet.';
    html += `<h3 class="rsec">Model list</h3><div class="card">
      ${row('New models', 'r-listMode', control('r-listMode', fieldPath(pid, null, 'listMode'), 'enum', [opt('', `Default (${labels[fallback]})`, own ?? ''), opt('auto', labels.auto, own ?? ''), opt('catalog', labels.catalog, own ?? '')]),
        'Only the newest version of each model is listed.')}
      <div class="row"><span class="name rnote">${esc(status)}</span>${m.canList ? `<button class="btn small" data-list-now="${esc(pid)}" ${m.listing.has(pid) ? 'disabled' : ''}>Check now</button>` : '<span class="desc">The desktop app checks the list.</span>'}</div></div>`;
  }
  const choices = entry ? latestOnly(entry.models).filter((x) => !have.includes(x.id)) : [];
  html += `<h3 class="rsec">Add a model</h3><div class="card"><div class="row">
    <input type="text" id="r-add" list="r-catalog" placeholder="${esc(choices.length ? `Search ${choices.length} models, or type an id` : 'Model id, such as gpt-6-sol')}" spellcheck="false" autocomplete="off">
    <button class="btn small" data-add-model="${esc(pid)}">Add</button></div>
    ${choices.length ? `<datalist id="r-catalog">${choices.map((x) => `<option value="${esc(x.id)}">${esc(x.name ?? '')}</option>`).join('')}</datalist>` : ''}
    ${m.addError ? `<div class="bad-json">${esc(m.addError)}</div>` : '<div class="help rnote">A model added here starts with no rules of its own and needs confirming.</div>'}</div>`;
  return html;
}

// ------------------------------------------------------------------ history

const plain = (v: unknown): string => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v).replace(/_/g, ' '));

/** A rule value in words. A pause reads as its end time and any changed weights, and other grouped values as their parts. */
export function showValue(field: string, v: unknown): string {
  if (v === null || v === undefined) return 'unset';
  if (Array.isArray(v)) return v.length ? v.join(', ') : 'none';
  if (typeof v !== 'object') return plain(v);
  const o = v as Record<string, unknown>;
  if (field === 'pause' && typeof o.until === 'string') {
    const when = new Date(o.until).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const weights = o.weights && typeof o.weights === 'object' ? Object.entries(o.weights as Record<string, string | null>).map(([a, l]) => `${ACTIVITY_LABELS[a as keyof typeof ACTIVITY_LABELS] ?? a} ${l ? (WEIGHT_LABELS[l as keyof typeof WEIGHT_LABELS] ?? l).toLowerCase() : 'not allowed'}`) : [];
    return `${weights.length ? 'weights changed' : 'paused'} until ${when}${weights.length ? ` (${weights.join(', ')})` : ''}`;
  }
  return Object.entries(o).map(([k, x]) => `${k} ${plain(x)}`).join(', ');
}

/** What a change did. Two grouped values show only the parts that differ, so a one-word edit to data handling reads as that word. */
export function changeText(field: string, from: unknown, to: unknown): string {
  const both = from && to && typeof from === 'object' && typeof to === 'object' && field !== 'pause' && !Array.isArray(from) && !Array.isArray(to);
  if (both) {
    const a = from as Record<string, unknown>, b = to as Record<string, unknown>;
    const parts = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => `${k} ${a[k] === undefined ? 'unset' : plain(a[k])} to ${b[k] === undefined ? 'unset' : plain(b[k])}`);
    if (parts.length) return parts.join(', ');
  }
  return `${showValue(field, from)} to ${showValue(field, to)}`;
}

function describe(m: RulesModel, c: PolicyChange): string {
  const [pid = '', model = '', field = ''] = c.path.split('|');
  const who = model || `${m.providers.find((p) => p.id === pid)?.name ?? pid} defaults`;
  const name = field.startsWith('activities.') ? ACTIVITY_LABELS[field.slice(11) as keyof typeof ACTIVITY_LABELS] ?? field
    : field.startsWith('thresholds.') ? field.slice(11) : field;
  return `<b>${esc(who)}</b> ${esc(name)}: ${esc(changeText(field, c.from, c.to))}`;
}

function historyView(m: RulesModel): string {
  const list = policyOf(m).history.map((c, i) => ({ c, i })).reverse().slice(0, 200);
  return `<div class="card">${list.length ? list.map(({ c, i }) => `<div class="row rhist"><span class="name">${describe(m, c)}<span class="desc">${esc(new Date(c.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))} on the ${esc(c.device)}</span></span>
    <button class="btn small" data-undo="${i}">Undo</button></div>`).join('') : '<div class="rempty">No changes yet.</div>'}</div>`;
}

// ------------------------------------------------------------------ page

const BOOL_LABELS: Record<string, string> = { yes: 'Yes', no: 'No' };
const VALUE_LABELS: Record<string, Record<string, string>> = { dataTier: DATA_TIER_LABELS, output: OUTPUT_LABELS, cost: COST_LABELS };

/** How a stored value reads in a preview. */
const shown = (field: string, v: unknown): string => v === undefined ? 'provider default' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : VALUE_LABELS[field]?.[String(v)] ?? String(v);

function bulkFieldRow(m: RulesModel): string {
  const def = BULK_FIELDS.find((f) => f.field === m.bulkField) ?? BULK_FIELDS[0]!;
  const control = def.kind === 'text'
    ? `<input type="text" id="r-bulk-value" data-bulk-value value="${esc(m.bulkValue)}" placeholder="Empty follows the provider" aria-label="${esc(def.label)}">`
    : `<select id="r-bulk-value" data-bulk-value aria-label="${esc(def.label)}">${opt('', 'Provider default', m.bulkValue)}${def.kind === 'bool'
      ? ['yes', 'no'].map((v) => opt(v, BOOL_LABELS[v]!, m.bulkValue)).join('') : (def.choices ?? []).map((c) => opt(c, VALUE_LABELS[def.field]?.[c] ?? c, m.bulkValue)).join('')}</select>`;
  return `<span class="rbulkrow"><select id="r-bulk-field" data-bulk-field aria-label="Field to set">${BULK_FIELDS.map((f) => opt(f.field, f.label, def.field)).join('')}</select>${control}
    <button class="btn small" data-bulk="preview">Preview</button></span>`;
}

function bulkPreview(m: RulesModel): string {
  const p = m.preview;
  if (!p) return '';
  const label = BULK_FIELDS.find((f) => f.field === p.field)?.label ?? p.field;
  const n = p.changes.length;
  const list = p.changes.slice(0, 8).map((c) => `<li><b>${esc(c.label)}</b> ${esc(shown(p.field, c.from))} to ${esc(shown(p.field, c.to))}</li>`).join('');
  const already = p.unchanged ? (n ? ` ${p.unchanged} already ${p.unchanged === 1 ? 'has' : 'have'} it.` : ` All ${p.unchanged} already ${p.unchanged === 1 ? 'has' : 'have'} this value.`) : '';
  return `<div class="rpreview"><span><b>${esc(label)}:</b> ${n === 0 ? 'Nothing to change.' : `${n} ${n === 1 ? 'model changes' : 'models change'} to ${esc(shown(p.field, p.value))}.`}${already}</span>
    ${n ? `<ul>${list}${n > 8 ? `<li>and ${n - 8} more</li>` : ''}</ul>` : ''}
    <span class="rbulkrow">${n ? `<button class="btn small primary" data-bulk="apply-field">Apply</button>` : ''}<button class="btn small" data-bulk="preview-cancel">${n ? 'Cancel' : 'Close'}</button></span></div>`;
}

/** The resets ahead, across providers whose last reading can be trusted, as choices for when a dial-back ends. */
export function dialEndChoices(m: Pick<RulesModel, 'snapshot' | 'providers'>, now = Date.now()): Array<{ value: string; label: string; until: string }> {
  const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return m.providers.flatMap((p) => pauseResets(m.snapshot, p.id, now).meters.map((x) => ({ value: `${p.id}|${x.id}`, label: `${p.name} ${x.label.toLowerCase()} resets, ${when(x.resetsAt)}`, until: x.resetsAt })))
    .sort((a, b) => a.until.localeCompare(b.until));
}

function dialCard(m: RulesModel): string {
  const choices = dialEndChoices(m), plan = m.dialPlan;
  const local = (d: Date) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
  const list = plan ? plan.items.slice(0, 10).map((i) => `<li><b>${esc(i.label)}</b> ${i.action === 'stop' ? 'stops' : 'is favoured'}</li>`).join('') : '';
  return `<div class="card dialcard"><div class="rsec" style="margin-top:0">Dial back usage</div>
    <p class="help">Stops the high-cost models and raises the weights of the cheaper ones until the time you pick. Each model goes back to its normal rules when it ends.</p>
    <div class="row"><label class="name" for="r-dial-end">Until</label><select id="r-dial-end" data-dial-end>${choices.map((c) => opt(c.value, c.label, m.dialEnd)).join('')}${opt('custom', 'A date and time', m.dialEnd)}</select></div>
    ${m.dialEnd === 'custom' || !choices.length ? `<div class="row"><label class="name" for="r-dial-custom">Date and time</label><input type="datetime-local" id="r-dial-custom" data-dial-custom value="${esc(m.dialCustom)}" min="${esc(local(new Date()))}"></div>` : ''}
    ${m.dialError ? `<div class="rnote bad" role="alert">${esc(m.dialError)}</div>` : ''}
    ${plan ? `<div class="rpreview"><span><b>${plan.items.length ? `${plan.items.length} ${plan.items.length === 1 ? 'model changes' : 'models change'}.` : 'Nothing to change.'}</b> ${plan.skipped} left alone.</span>
      ${plan.items.length ? `<ul>${list}${plan.items.length > 10 ? `<li>and ${plan.items.length - 10} more</li>` : ''}</ul>` : ''}</div>` : ''}
    <div class="actions" style="margin-top:6px"><button class="btn small ${plan ? '' : 'primary'}" data-dial="preview">Preview</button>
      ${plan?.items.length ? '<button class="btn small primary" data-dial="apply">Apply</button>' : ''}<button class="btn small" data-dial="close">Close</button></div></div>`;
}

export function renderRules(m: RulesModel): string {
  const pending = pendingCount(m.config);
  let html = `<div class="rules-page ${m.sel ? 'has-sel' : ''}"><header class="top">
    <button class="icon" data-action="${m.showHistory ? 'rules-history' : 'back'}" title="${m.showHistory ? 'Back to the rules' : 'Back to usage'}" aria-label="${m.showHistory ? 'Back to the rules' : 'Back to usage'}">${ICON.back}</button>
    <div><h1>${m.showHistory ? 'Rule changes' : 'Model rules'}</h1><div class="sub">${m.showHistory ? 'Newest first. Undo writes the old value back as a new change.' : 'What agents may use each model for'}</div></div><span class="grow"></span>
    ${m.showHistory ? '' : `<button class="btn small" data-action="rules-dial">Dial back</button><button class="btn small" data-action="rules-history">History</button>`}</header>`;
  if (m.dialOpen && !m.showHistory) html += dialCard(m);
  if (m.showHistory) return html + historyView(m) + '</div>';
  if (m.policyError) html += `<div class="card rbanner bad"><span class="grow"><b>policy.json was not written.</b> Agents are still using the older file. ${esc(m.policyError)}</span><button class="btn small" data-action="retry-policy">Try again</button></div>`;

  html += heldCards(m.held);
  if (pending) html += `<div class="card rbanner"><span class="grow">${pending} ${pending === 1 ? 'model needs' : 'models need'} review. Routers skip them until their rules are confirmed.</span>
    ${m.filter === 'needs' ? '' : '<button class="btn small" data-rfilter="needs">Show them</button>'}</div>`;
  html += `<div class="rtools"><input type="search" id="r-query" data-rules-query value="${esc(m.query)}" placeholder="Search models" spellcheck="false">
    <div class="seg" role="radiogroup" aria-label="Filter">${FILTERS.map(([v, label]) =>
      `<button role="radio" aria-checked="${v === m.filter}" class="${v === m.filter ? 'on' : ''}" data-rfilter="${v}">${esc(label)}</button>`).join('')}</div></div>`;

  const blocks = m.providers.map((p) => providerBlock(m, p)).join('');
  html += `<div class="rules ${m.sel ? 'has-sel' : ''}"><div class="rlist">${blocks || '<div class="rempty big">No models match.</div>'}</div><div class="rdetail">${detail(m)}</div></div>`;

  if (m.picked.size) html += `<div class="rbulk"><span><b>${m.picked.size}</b> selected</span>
    <button class="btn small primary" data-bulk="confirmed">Confirm</button>
    <button class="btn small" data-bulk="hidden">Hide</button>
    <select id="r-bulk-tier" data-bulk-tier aria-label="Set most sensitive data on the selected models">${opt('', 'Set data tier', m.bulkTier)}${DATA_TIERS.map((t) => opt(t, DATA_TIER_LABELS[t], m.bulkTier)).join('')}</select>
    <select id="r-bulk-act" aria-label="Activity">${ACTIVITIES.map((a) => opt(a, ACTIVITY_LABELS[a], '')).join('')}</select>
    <select id="r-bulk-level" aria-label="Weight">${opt('', 'Default', 'normal')}${opt('none', 'Not allowed', 'normal')}${WEIGHT_LEVELS.map((w) => opt(w, WEIGHT_LABELS[w], 'normal')).join('')}</select>
    <button class="btn small" data-bulk="activity">Apply</button>
    ${bulkFieldRow(m)}
    <button class="btn small" data-bulk="clear">Clear</button>
    ${bulkPreview(m)}
    ${m.note ? `<span class="rnote" role="status">${esc(m.note)}</span>` : ''}</div>`;
  return html + '</div>';
}
