import {
  pendingCount, ACTIVITIES, ACTIVITY_LABELS, COST_TIERS, DATA_TIERS, DATA_TIER_LABELS, OUTPUT_MODES, WEIGHT_LABELS, WEIGHT_LEVELS,
  fieldPath, latestOnly, pauseActive, resolveThresholds,
  type AppConfig, type ModelCatalog, type ModelEntry, type PolicyChange, type ProviderPlugin, type Rule, type Snapshot,
} from '@augur/core';
import {
  BULK_FIELDS, COST_LABELS, LIST_MODE_LABELS, OUTPUT_LABELS, RULES_TEXT, RULE_FILTERS, STATUS_LABELS, BOOL_LABELS, VALUE_LABELS,
  describeChange, dialEndChoices, models, pauseResets, pauseText, previewValue, providerCounts, ruleMatches, ruleSummary, statusText,
  type BulkPreview, type DialBackPlan, type HeldRow, type RulesFilter,
} from '@augur/view-model';
import { ICON, ago, esc } from '../util';

export type { HeldRow, RulesFilter };

function heldCards(rows: HeldRow[]): string {
  return rows.map((r) => `<div class="card rbanner held"><span class="grow">${esc(RULES_TEXT.held(r))}${r.reason ? ` <span class="desc">${esc(r.reason)}</span>` : ''}</span>
    <button class="btn small primary" data-action="edit-accept" data-edit="${esc(r.id)}">Accept</button><button class="btn small" data-action="edit-dismiss" data-edit="${esc(r.id)}">Dismiss</button></div>`).join('');
}

export interface RulesModel {
  config: AppConfig;
  /** Changes agents asked for that wait for the owner's yes. */
  held: HeldRow[];
  providers: Array<{ id: string; name: string; metered: boolean }>;
  /** How the balance treats each provider, by provider id, from the balance report. Empty until the service answers. */
  stances?: Record<string, string>;
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

const opt = (value: string, label: string, current: string) => `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`;

function colorOf(m: RulesModel, pid: string): string {
  const custom = (m.config.providers.find((p) => p.id === pid)?.settings?.color as string | undefined) || '';
  const c = m.plugins.get(pid)?.color;
  return custom || (c ? (m.dark ? c.dark : c.light) : 'var(--muted)');
}

const policyOf = (m: RulesModel) => m.config.policy ?? { providers: {}, stamps: {}, history: [] };

/** Models waiting for a decision: new ones from a live list, and imported ones not yet confirmed. */
export { pendingCount };

function modelRow(m: RulesModel, pid: string, defaults: Rule, label: string, model: ModelEntry): string {
  const key = `${pid}|${label}`, on = m.sel?.provider === pid && m.sel.model === label;
  const pause = model.rule.pause ?? defaults.pause, paused = pauseActive(pause);
  const chip = model.status === 'confirmed' ? '' : `<span class="chip ${model.status === 'unreviewed' ? 'stale' : ''}">${esc(STATUS_LABELS[model.status])}</span>`;
  return `<div class="rrow ${on ? 'on' : ''}">
    <input type="checkbox" data-pick="${esc(key)}" ${m.picked.has(key) ? 'checked' : ''} aria-label="Select ${esc(model.name ?? label)}">
    <button class="rpick" data-rsel="${esc(pid)}" data-rmodel="${esc(label)}">
      <span class="rname">${esc(model.name ?? model.id)} ${chip}${paused ? `<span class="chip">${RULES_TEXT.pausedChip(!!pause?.weights)}</span>` : ''}</span>
      <span class="rsum">${esc(label)}, ${esc(ruleSummary(pid, defaults, model))}</span></button></div>`;
}

function providerBlock(m: RulesModel, meta: RulesModel['providers'][number]): string {
  const p = policyOf(m).providers[meta.id] ?? { defaults: {}, models: {} };
  const rows = Object.entries(p.models).filter(([label, model]) => ruleMatches(m.filter, m.query, label, model)).sort(([a], [b]) => a.localeCompare(b));
  const { total, pending, drained } = providerCounts(policyOf(m), meta.id);
  const searching = m.query.trim() !== '' || m.filter !== 'all';
  if (searching && !rows.length) return '';
  const open = m.open.has(meta.id) || searching;
  const allPicked = rows.length > 0 && rows.every(([label]) => m.picked.has(`${meta.id}|${label}`));
  const defaultsOn = m.sel?.provider === meta.id && m.sel.model === null;
  return `<section class="card rprov">
    <div class="phead">
      <span class="dot" style="background:${esc(colorOf(m, meta.id))}"></span>
      <span class="pname">${esc(meta.name)}${meta.metered ? '' : `<span class="chip">${RULES_TEXT.noUsage}</span>`}${drained ? `<span class="chip">${RULES_TEXT.usedUpFirst}</span>` : ''}${m.stances?.[meta.id] && RULES_TEXT.stance[m.stances[meta.id]!] ? `<span class="chip">${esc(RULES_TEXT.stance[m.stances[meta.id]!]!)}</span>` : ''}${pending ? `<span class="chip stale">${RULES_TEXT.review(pending)}</span>` : ''}</span>
      <span class="age">${models(total)}</span>
      <button class="link" data-rprov="${esc(meta.id)}" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} ${esc(meta.name)} models" style="transform:rotate(${open ? 0 : -90}deg)">${ICON.chevron}</button></div>
    ${open ? `<div class="rlist-body">
      <div class="rrow ${defaultsOn ? 'on' : ''}">${rows.length ? `<input type="checkbox" data-pick-all="${esc(meta.id)}" ${allPicked ? 'checked' : ''} aria-label="Select all ${esc(meta.name)} models shown">` : '<span class="rspacer"></span>'}
        <button class="rpick" data-rsel="${esc(meta.id)}" data-rmodel=""><span class="rname">${RULES_TEXT.defaults}</span><span class="rsum">${RULES_TEXT.defaultsSum}</span></button></div>
      ${rows.map(([label, model]) => modelRow(m, meta.id, p.defaults, label, model)).join('')}
      ${!rows.length ? `<div class="rempty">${RULES_TEXT.noModels}</div>` : ''}
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
  return `<div class="row wrap"><span class="name">${RULES_TEXT.wait}<span class="desc">${RULES_TEXT.waitHelp}</span></span>
    <div class="waitlist">${boxes || `<span class="desc">${RULES_TEXT.waitNone}</span>`}</div></div>`;
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
    const first = model === null ? opt('', RULES_TEXT.notAllowed, cur) : opt('', `Default (${inherited ? WEIGHT_LABELS[inherited] : RULES_TEXT.notAllowed})`, cur);
    const options = [first, ...(model === null ? [] : [opt('none', RULES_TEXT.notAllowed, cur)]), ...WEIGHT_LEVELS.map((w) => opt(w, WEIGHT_LABELS[w], cur))];
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
  return text('hostCountry', RULES_TEXT.hostCountry, 'US') + tri('retainsPrompts', RULES_TEXT.retains) + tri('trainsOnPrompts', RULES_TEXT.trains) + text('pinnedHost', RULES_TEXT.pinnedHost, 'None');
}

function pauseRows(m: RulesModel, pid: string, model: string | null, own: Rule['pause'], inherited: Rule['pause']): string {
  const path = fieldPath(pid, model, 'pause'), { meters, blocked } = pauseResets(m.snapshot, pid);
  const known = m.snapshot?.providers[pid]?.meters ?? [];
  const shown = own ?? (model !== null ? inherited : null), active = pauseActive(shown);
  const local = (iso: string) => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
  let html = '';
  if (shown && active) {
    html += `<div class="rnote">${esc(pauseText(shown, known.find((x) => x.id === shown.meter)?.label, own === undefined))}</div>`;
    if (own) html += `<div class="actions" style="margin-top:4px"><button class="btn small" data-pause-clear="${esc(path)}">${RULES_TEXT.resume}</button></div>`;
    return html;
  }
  html += row(RULES_TEXT.pauseMode, 'r-pause-mode', `<select id="r-pause-mode" data-pause-mode>${opt('off', RULES_TEXT.pauseStop, m.pauseMode)}${opt('weights', RULES_TEXT.pauseWeights, m.pauseMode)}</select>`,
    RULES_TEXT.pauseModeHelp);
  if (m.pauseMode === 'weights') {
    html += ACTIVITIES.map((a) => {
      const cur = m.pauseWeights[a] ?? '';
      return row(ACTIVITY_LABELS[a], `r-pw-${a}`, `<select id="r-pw-${a}" data-pause-weight="${a}">${opt('', RULES_TEXT.leaveAsIs, cur)}${opt('none', RULES_TEXT.notAllowed, cur)}${WEIGHT_LEVELS.map((w) => opt(w, WEIGHT_LABELS[w], cur)).join('')}</select>`);
    }).join('');
  }
  html += row(RULES_TEXT.pauseUntil, 'r-pause-until', `<input type="datetime-local" id="r-pause-until" data-pause-until="${esc(path)}" min="${esc(local(new Date().toISOString()))}">`,
    RULES_TEXT.pauseUntilHelp);
  if (blocked) html += `<div class="rnote">${esc(blocked)}</div>`;
  if (meters.length) html += row(RULES_TEXT.pauseReset, 'r-pause-meter', `<select id="r-pause-meter" data-pause-meter="${esc(path)}">${opt('', RULES_TEXT.chooseMeter, '')}${meters.map((x) => opt(x.id, x.label, '')).join('')}</select>`);
  return html;
}

function thresholdRows(m: RulesModel, pid: string): string {
  const own = policyOf(m).providers[pid]?.thresholds ?? {}, t = resolveThresholds(policyOf(m).providers[pid]);
  const num = (key: 'warnPct' | 'denyPct' | 'minBalance', label: string, help: string, step: string) => row(label, `r-t-${key}`,
    `<input type="number" id="r-t-${key}" data-rule="${esc(fieldPath(pid, null, `thresholds.${key}`))}" data-kind="num" step="${step}" min="0" ${key === 'minBalance' ? '' : 'max="100"'} value="${esc(own[key] ?? '')}" placeholder="${esc(t[key] ?? 'None')}">`, help);
  return num('warnPct', RULES_TEXT.warnAt, RULES_TEXT.warnHelp, '1')
    + num('denyPct', RULES_TEXT.stopAt, RULES_TEXT.stopHelp, '1')
    + num('minBalance', RULES_TEXT.minBalance, RULES_TEXT.minBalanceHelp, '0.05');
}

function detail(m: RulesModel): string {
  if (!m.sel) return `<div class="rempty big">${esc(RULES_TEXT.choose)}</div>`;
  const { provider: pid, model } = m.sel, meta = m.providers.find((p) => p.id === pid);
  const p = policyOf(m).providers[pid] ?? { defaults: {}, models: {} }, entry = model ? p.models[model] : undefined;
  if (!meta || (model && !entry)) return `<div class="rempty big">${RULES_TEXT.gone}</div>`;
  const rule = entry ? entry.rule : p.defaults, d = p.defaults, isModel = model !== null;
  const title = entry ? entry.name ?? entry.id : RULES_TEXT.defaultsTitle(meta.name);

  let html = `<div class="rhead"><button class="icon rback" data-rsel="" title="Back to the list" aria-label="Back to the list">${ICON.back}</button>
    <div><h2>${esc(title)}</h2><div class="sub">${esc(isModel ? `${model}, ${entry!.id}` : RULES_TEXT.defaultsSub(meta.name))}</div></div></div>`;

  if (entry) {
    const path = fieldPath(pid, model, 'status');
    const text = statusText(policyOf(m), pid, entry);
    html += `<div class="card rstatus"><span class="grow">${esc(text)}</span>
      ${entry.status === 'confirmed' || entry.status === 'hidden' ? '' : `<button class="btn small primary" data-status="${esc(path)}" data-value="confirmed">${RULES_TEXT.confirm}</button>`}
      <button class="btn small" data-status="${esc(path)}" data-value="${entry.status === 'hidden' ? 'unreviewed' : 'hidden'}">${entry.status === 'hidden' ? RULES_TEXT.show : RULES_TEXT.hide}</button></div>`;
  }

  html += `<h3 class="rsec">${RULES_TEXT.activities}</h3><div class="card">${activityRows(pid, model, rule, d)}</div>`;
  html += `<h3 class="rsec">${RULES_TEXT.data}</h3><div class="card">
    ${row(RULES_TEXT.dataTier, 'r-dataTier', enumSelect(pid, model, 'dataTier', DATA_TIERS, DATA_TIER_LABELS, rule.dataTier, d.dataTier, 'Public'), RULES_TEXT.dataTierHelp)}
    ${handlingRows(pid, model, rule.dataHandling, d.dataHandling)}</div>`;
  html += `<h3 class="rsec">${RULES_TEXT.use}</h3><div class="card">
    ${row(RULES_TEXT.askFirst, 'r-askFirst', boolSelect(pid, model, 'askFirst', rule.askFirst, d.askFirst), RULES_TEXT.askFirstHelp)}
    ${row(RULES_TEXT.output, 'r-output', enumSelect(pid, model, 'output', OUTPUT_MODES, OUTPUT_LABELS, rule.output, d.output, 'Text only'))}
    ${row(RULES_TEXT.sandbox, 'r-sandbox', boolSelect(pid, model, 'sandbox', rule.sandbox, d.sandbox))}
    ${row(RULES_TEXT.cost, 'r-cost', enumSelect(pid, model, 'cost', COST_TIERS, COST_LABELS, rule.cost, d.cost, 'Moderate'), RULES_TEXT.costHelp)}
    ${isModel ? waitRows(m, pid, model!, rule.useAfter, d.useAfter) : ''}
    ${row(RULES_TEXT.effort, 'r-effort', `<input type="text" id="r-effort" data-rule="${esc(fieldPath(pid, model, 'effort'))}" data-kind="text" value="${esc(rule.effort ?? '')}" placeholder="${esc(isModel ? d.effort ?? 'Default' : 'Default')}" style="max-width:150px">`)}
  </div>`;
  html += `<h3 class="rsec">${RULES_TEXT.pause}</h3><div class="card">${pauseRows(m, pid, model, rule.pause, d.pause)}</div>`;
  if (!isModel && meta.metered) html += `<h3 class="rsec">${RULES_TEXT.limits}</h3><div class="card">${thresholdRows(m, pid)}</div>`;
  html += `<h3 class="rsec">${RULES_TEXT.notes}</h3><div class="card"><div class="field"><textarea id="r-notes" data-rule="${esc(fieldPath(pid, model, 'notes'))}" data-kind="text" rows="3" style="min-height:64px" placeholder="${esc(isModel && d.notes ? d.notes : RULES_TEXT.notesHint)}">${esc(rule.notes ?? '')}</textarea></div></div>`;
  if (!isModel) html += modelListSection(m, pid, p.listMode, Object.values(p.models).map((x) => x.id));
  return html;
}

function modelListSection(m: RulesModel, pid: string, own: 'auto' | 'catalog' | undefined, have: string[]): string {
  const plugin = m.plugins.get(pid), entry = m.catalog[pid];
  let html = '';
  if (plugin?.listModels) {
    const labels = LIST_MODE_LABELS;
    const fallback = plugin.modelListMode ?? 'auto';
    const status = m.listing.has(pid) ? RULES_TEXT.checking
      : entry ? RULES_TEXT.checked(ago(entry.fetchedAt), latestOnly(entry.models).length, entry.error ?? undefined)
      : RULES_TEXT.notChecked;
    html += `<h3 class="rsec">${RULES_TEXT.modelList}</h3><div class="card">
      ${row(RULES_TEXT.newModels, 'r-listMode', control('r-listMode', fieldPath(pid, null, 'listMode'), 'enum', [opt('', `Default (${labels[fallback]})`, own ?? ''), opt('auto', labels.auto, own ?? ''), opt('catalog', labels.catalog, own ?? '')]),
        RULES_TEXT.listHelp)}
      <div class="row"><span class="name rnote">${esc(status)}</span>${m.canList ? `<button class="btn small" data-list-now="${esc(pid)}" ${m.listing.has(pid) ? 'disabled' : ''}>${RULES_TEXT.checkNow}</button>` : `<span class="desc">${RULES_TEXT.desktopChecks}</span>`}</div></div>`;
  }
  const choices = entry ? latestOnly(entry.models).filter((x) => !have.includes(x.id)) : [];
  html += `<h3 class="rsec">${RULES_TEXT.addModel}</h3><div class="card"><div class="row">
    <input type="text" id="r-add" list="r-catalog" placeholder="${esc(choices.length ? `Search ${choices.length} models, or type an id` : RULES_TEXT.addHint)}" spellcheck="false" autocomplete="off">
    <button class="btn small" data-add-model="${esc(pid)}">Add</button></div>
    ${choices.length ? `<datalist id="r-catalog">${choices.map((x) => `<option value="${esc(x.id)}">${esc(x.name ?? '')}</option>`).join('')}</datalist>` : ''}
    ${m.addError ? `<div class="bad-json">${esc(m.addError)}</div>` : `<div class="help rnote">${RULES_TEXT.addHelp}</div>`}</div>`;
  return html;
}

// ------------------------------------------------------------------ history

function describe(m: RulesModel, c: PolicyChange): string {
  const d = describeChange(c, (pid) => m.providers.find((p) => p.id === pid)?.name ?? pid);
  return `<b>${esc(d.who)}</b> ${esc(d.field)}: ${esc(d.text)}`;
}

function historyView(m: RulesModel): string {
  const list = policyOf(m).history.map((c, i) => ({ c, i })).reverse().slice(0, 200);
  return `<div class="card">${list.length ? list.map(({ c, i }) => `<div class="row rhist"><span class="name">${describe(m, c)}<span class="desc">${esc(RULES_TEXT.changedOn(c.at, c.device))}</span></span>
    <button class="btn small" data-undo="${i}">Undo</button></div>`).join('') : `<div class="rempty">${RULES_TEXT.noHistory}</div>`}</div>`;
}

// ------------------------------------------------------------------ page

function bulkFieldRow(m: RulesModel): string {
  const def = BULK_FIELDS.find((f) => f.field === m.bulkField) ?? BULK_FIELDS[0]!;
  const control = def.kind === 'text'
    ? `<input type="text" id="r-bulk-value" data-bulk-value value="${esc(m.bulkValue)}" placeholder="${RULES_TEXT.followsProvider}" aria-label="${esc(def.label)}">`
    : `<select id="r-bulk-value" data-bulk-value aria-label="${esc(def.label)}">${opt('', RULES_TEXT.providerDefault, m.bulkValue)}${def.kind === 'bool'
      ? ['yes', 'no'].map((v) => opt(v, BOOL_LABELS[v]!, m.bulkValue)).join('') : (def.choices ?? []).map((c) => opt(c, VALUE_LABELS[def.field]?.[c] ?? c, m.bulkValue)).join('')}</select>`;
  return `<span class="rbulkrow"><select id="r-bulk-field" data-bulk-field aria-label="Field to set">${BULK_FIELDS.map((f) => opt(f.field, f.label, def.field)).join('')}</select>${control}
    <button class="btn small" data-bulk="preview">Preview</button></span>`;
}

function bulkPreview(m: RulesModel): string {
  const p = m.preview;
  if (!p) return '';
  const label = BULK_FIELDS.find((f) => f.field === p.field)?.label ?? p.field;
  const n = p.changes.length;
  const list = p.changes.slice(0, 8).map((c) => `<li><b>${esc(c.label)}</b> ${esc(previewValue(p.field, c.from))} to ${esc(previewValue(p.field, c.to))}</li>`).join('');
  return `<div class="rpreview"><span><b>${esc(label)}:</b> ${esc(RULES_TEXT.bulkCount(n, previewValue(p.field, p.value)) + RULES_TEXT.bulkAlready(n, p.unchanged))}</span>
    ${n ? `<ul>${list}${n > 8 ? `<li>${RULES_TEXT.more(n - 8)}</li>` : ''}</ul>` : ''}
    <span class="rbulkrow">${n ? `<button class="btn small primary" data-bulk="apply-field">Apply</button>` : ''}<button class="btn small" data-bulk="preview-cancel">${n ? 'Cancel' : 'Close'}</button></span></div>`;
}

function dialCard(m: RulesModel): string {
  const choices = dialEndChoices(m.snapshot, m.providers), plan = m.dialPlan;
  const local = (d: Date) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
  const list = plan ? plan.items.slice(0, 10).map((i) => `<li><b>${esc(i.label)}</b> ${RULES_TEXT.planAction(i.action)}</li>`).join('') : '';
  return `<div class="card dialcard"><div class="rsec" style="margin-top:0">${RULES_TEXT.dialTitle}</div>
    <p class="help">${RULES_TEXT.dialHelp}</p>
    <div class="row"><label class="name" for="r-dial-end">${RULES_TEXT.dialUntil}</label><select id="r-dial-end" data-dial-end>${choices.map((c) => opt(c.value, c.label, m.dialEnd)).join('')}${opt('custom', RULES_TEXT.dialCustom, m.dialEnd)}</select></div>
    ${m.dialEnd === 'custom' || !choices.length ? `<div class="row"><label class="name" for="r-dial-custom">${RULES_TEXT.dateTime}</label><input type="datetime-local" id="r-dial-custom" data-dial-custom value="${esc(m.dialCustom)}" min="${esc(local(new Date()))}"></div>` : ''}
    ${m.dialError ? `<div class="rnote bad" role="alert">${esc(m.dialError)}</div>` : ''}
    ${plan ? `<div class="rpreview"><span><b>${RULES_TEXT.planCount(plan.items.length)}</b> ${RULES_TEXT.leftAlone(plan.skipped)}</span>
      ${plan.items.length ? `<ul>${list}${plan.items.length > 10 ? `<li>${RULES_TEXT.more(plan.items.length - 10)}</li>` : ''}</ul>` : ''}</div>` : ''}
    <div class="actions" style="margin-top:6px"><button class="btn small ${plan ? '' : 'primary'}" data-dial="preview">Preview</button>
      ${plan?.items.length ? '<button class="btn small primary" data-dial="apply">Apply</button>' : ''}<button class="btn small" data-dial="close">Close</button></div></div>`;
}

export function renderRules(m: RulesModel): string {
  const pending = pendingCount(m.config);
  let html = `<div class="rules-page ${m.sel ? 'has-sel' : ''}"><header class="top">
    <button class="icon" data-action="${m.showHistory ? 'rules-history' : 'back'}" title="${m.showHistory ? 'Back to the rules' : 'Back to usage'}" aria-label="${m.showHistory ? 'Back to the rules' : 'Back to usage'}">${ICON.back}</button>
    <div><h1>${m.showHistory ? RULES_TEXT.historyTitle : RULES_TEXT.title}</h1><div class="sub">${m.showHistory ? RULES_TEXT.historySub : RULES_TEXT.sub}</div></div><span class="grow"></span>
    ${m.showHistory ? '' : `<button class="btn small" data-action="rules-dial">Dial back</button><button class="btn small" data-action="rules-history">History</button>`}</header>`;
  if (m.dialOpen && !m.showHistory) html += dialCard(m);
  if (m.showHistory) return html + historyView(m) + '</div>';
  if (m.policyError) html += `<div class="card rbanner bad"><span class="grow"><b>${RULES_TEXT.policyFailed}</b> ${RULES_TEXT.policyOlder} ${esc(m.policyError)}</span><button class="btn small" data-action="retry-policy">Try again</button></div>`;

  html += heldCards(m.held);
  if (pending) html += `<div class="card rbanner"><span class="grow">${RULES_TEXT.pending(pending)}</span>
    ${m.filter === 'needs' ? '' : '<button class="btn small" data-rfilter="needs">Show them</button>'}</div>`;
  html += `<div class="rtools"><input type="search" id="r-query" data-rules-query value="${esc(m.query)}" placeholder="Search models" spellcheck="false">
    <div class="seg" role="radiogroup" aria-label="Filter">${RULE_FILTERS.map(([v, label]) =>
      `<button role="radio" aria-checked="${v === m.filter}" class="${v === m.filter ? 'on' : ''}" data-rfilter="${v}">${esc(label)}</button>`).join('')}</div></div>`;

  const blocks = m.providers.map((p) => providerBlock(m, p)).join('');
  html += `<div class="rules ${m.sel ? 'has-sel' : ''}"><div class="rlist">${blocks || `<div class="rempty big">${RULES_TEXT.noMatch}</div>`}</div><div class="rdetail">${detail(m)}</div></div>`;

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
