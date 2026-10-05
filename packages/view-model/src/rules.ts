// The model rules page in both apps: the labels for each value, the filter and summary for the model list, the changes agents asked for, the
// resets a pause can wait for, how a change reads in the history, and the help text under each rule.
import {
  ACTIVITIES, ACTIVITY_LABELS, DATA_TIER_LABELS, WEIGHT_LABELS, WEIGHT_LEVELS, resolveModel,
  type EditState, type ModelEntry, type PolicyChange, type PolicyConfig, type Rule, type Snapshot,
} from '@augur/core';

export type RulesFilter = 'all' | 'needs' | 'imported' | 'confirmed' | 'hidden';

export const RULE_FILTERS: ReadonlyArray<readonly [RulesFilter, string]> = [['all', 'All'], ['needs', 'Needs review'], ['confirmed', 'Confirmed'], ['hidden', 'Hidden']];

export const OUTPUT_LABELS: Record<string, string> = { write_files: 'Writes files', patch_only: 'Returns a patch', text_only: 'Text only' };
export const COST_LABELS: Record<string, string> = { free: 'Free', very_cheap: 'Very cheap', cheap: 'Cheap', moderate: 'Moderate', high: 'High', very_high: 'Very high' };
export const STATUS_LABELS: Record<ModelEntry['status'], string> = { confirmed: 'Confirmed', imported: 'Imported', unreviewed: 'Needs rules', hidden: 'Hidden' };
export const BOOL_LABELS: Record<string, string> = { yes: 'Yes', no: 'No' };
export const VALUE_LABELS: Record<string, Record<string, string>> = { dataTier: DATA_TIER_LABELS, output: OUTPUT_LABELS, cost: COST_LABELS };
export const LIST_MODE_LABELS = { auto: 'Add new models for review', catalog: 'Keep as a list to pick from' } as const;

/** "1 model", "3 models". */
export const models = (n: number): string => `${n} ${n === 1 ? 'model' : 'models'}`;

/** A time as the rules page writes it, such as "Sun, Oct 4, 5:00 PM". */
export const ruleWhen = (iso: string): string => new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The wording of the rules page. The window app and the terminal app both read it, so the two say the same thing. */
export const RULES_TEXT = {
  title: 'Model rules',
  sub: 'What agents may use each model for',
  historyTitle: 'Rule changes',
  historySub: 'Newest first. Undo writes the old value back as a new change.',
  noHistory: 'No changes yet.',
  policyFailed: 'policy.json was not written.',
  policyOlder: 'Agents are still using the older file.',
  pending: (n: number) => `${n} ${n === 1 ? 'model needs' : 'models need'} review. Routers skip them until their rules are confirmed.`,
  noMatch: 'No models match.',
  noModels: 'No models yet. Open the provider defaults to add one.',
  choose: "Choose a provider's defaults or a model to see its rules.",
  gone: 'That model is no longer listed.',
  defaults: 'Provider defaults',
  defaultsSum: 'Every model below uses these unless it sets its own',
  defaultsTitle: (name: string) => `${name} defaults`,
  defaultsSub: (name: string) => `Used by every ${name} model that leaves a field unset`,
  noUsage: 'No usage data',
  usedUpFirst: 'Used up first',
  /** How the balance treats a provider, read-only here. A drained provider already shows Used up first. */
  stance: { paced: 'Kept on pace', drain: '', backup: 'Backup, used last', free: 'Free' } as Record<string, string>,
  review: (n: number) => `${n} ${n === 1 ? 'needs' : 'need'} review`,
  status: {
    unreviewed: 'New model. Routers skip it until its rules are confirmed.',
    imported: 'Imported rules. Routers skip it until they are confirmed.',
    confirmed: 'Routers use these rules.',
    hidden: 'Hidden. Routers never see it, and it is left out of policy.json.',
  } as Record<ModelEntry['status'], string>,
  supersedes: (older: string) => `A newer version of ${older}, set up with the same rules. Routers skip it until you confirm the rules, and then ${older} is hidden.`,
  confirm: 'Confirm rules',
  hide: 'Hide model',
  show: 'Show model',
  activities: 'Allowed activities',
  notAllowed: 'Not allowed',
  data: 'Data',
  dataTier: 'Most sensitive data',
  dataTierHelp: 'Internal is your own code and plans. Sensitive covers customer, business and personal data. Regulated covers student records.',
  hostCountry: 'Host country',
  retains: 'Keeps prompts',
  trains: 'Trains on prompts',
  pinnedHost: 'Pinned host',
  unknown: 'Unknown',
  use: 'How agents use it',
  askFirst: 'Ask first',
  askFirstHelp: 'Used only when named for the task, never picked by a router.',
  output: 'Output',
  sandbox: 'Runs in a sandbox',
  cost: 'Cost',
  costHelp: 'Higher-cost models drop out first when usage runs high.',
  wait: 'Use only after',
  waitHelp: 'Stays out of picks until every model checked here is spent, paused or down. Their providers are used up in full instead of paced.',
  waitNone: 'No other models to choose from.',
  effort: 'Reasoning effort',
  pause: 'Pause',
  pauseMode: 'While paused',
  pauseModeHelp: 'Weights replace the ones below until the pause ends, so a cheaper model can be favoured for a week.',
  pauseStop: 'Do not use this model',
  pauseWeights: 'Use different weights',
  leaveAsIs: 'Leave as is',
  pauseUntil: 'Pause until',
  pauseUntilHelp: 'Routers skip this model until then.',
  pauseReset: 'Or until a reset',
  chooseMeter: 'Choose a meter',
  resume: 'Resume now',
  limits: 'Usage limits',
  warnAt: 'Warn at',
  warnHelp: 'Percent used on any meter. 90 if left empty.',
  stopAt: 'Stop at',
  stopHelp: 'Routers skip the provider past this. 98 if left empty.',
  minBalance: 'Minimum balance',
  minBalanceHelp: 'For pay-as-you-go credit, in dollars. None if left empty.',
  notes: 'Notes for agents',
  notesHint: 'Guidance no field covers, such as when to avoid it.',
  modelList: 'Model list',
  newModels: 'New models',
  listHelp: 'Only the newest version of each model is listed.',
  checking: 'Checking now.',
  notChecked: 'Not checked yet.',
  checkNow: 'Check now',
  desktopChecks: 'The desktop app checks the list.',
  addModel: 'Add a model',
  addHint: 'Model id, such as gpt-6-sol',
  addHelp: 'A model added here starts with no rules of its own and needs confirming.',
  badId: 'Enter the model id as the provider writes it, with no spaces.',
  listed: (id: string) => `${id} is already listed.`,
  dialTitle: 'Dial back usage',
  dialHelp: 'Stops the high-cost models and raises the weights of the cheaper ones until the time you pick. Each model goes back to its normal rules when it ends.',
  dialUntil: 'Until',
  dialCustom: 'A date and time',
  future: 'Pick a time in the future.',
  dialDone: (n: number, until: string) => `Dialed back ${models(n)} until ${ruleWhen(until)}.`,
  pausedChip: (weights: boolean) => (weights ? 'Weights changed' : 'Paused'),
  /** A weight picked in the bulk bar, as the note after it reads: unset follows the provider, and none means not allowed. */
  weightName: (level: string) => (level === '' ? 'the provider default' : level === 'none' ? 'not allowed' : WEIGHT_LABELS[level as keyof typeof WEIGHT_LABELS] ?? level),
  checked: (when: string, n: number, error?: string) => `Checked ${when}. ${n} current models.${error ? ` The last check failed: ${error}` : ''}`,
  changedOn: (at: string, device: string) => `${new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} on the ${device}`,
  dateTime: 'Date and time',
  planCount: (n: number) => (n ? `${n} ${n === 1 ? 'model changes' : 'models change'}.` : 'Nothing to change.'),
  leftAlone: (n: number) => `${n} left alone.`,
  planAction: (action: 'stop' | 'favour') => (action === 'stop' ? 'stops' : 'is favoured'),
  more: (n: number) => `and ${n} more`,
  providerDefault: 'Provider default',
  followsProvider: 'Empty follows the provider',
  bulkCount: (n: number, value: string) => (n ? `${n} ${n === 1 ? 'model changes' : 'models change'} to ${value}.` : 'Nothing to change.'),
  bulkAlready: (n: number, same: number) => (!same ? '' : n ? ` ${same} already ${same === 1 ? 'has' : 'have'} it.` : ` All ${same} already ${same === 1 ? 'has' : 'have'} this value.`),
  bulkChanged: (label: string, n: number) => `${label} changed on ${models(n)}.`,
  bulkSet: (label: string, value: string, n: number) => `${label} set to ${value} on ${models(n)}.`,
  bulkStatus: (status: 'confirmed' | 'hidden', n: number) => `${status === 'confirmed' ? 'Confirmed' : 'Hid'} ${models(n)}.`,
  held: (r: { by: string; field: string; model: string; before: string; value: string }) => `${r.by} asks to change ${r.field} on ${r.model} from ${r.before} to ${r.value}.`,
} as const;

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

/** Whether a model belongs in the list under the filter and the search text. Hidden models show only under their own filter. */
export function ruleMatches(filter: RulesFilter, query: string, label: string, model: ModelEntry): boolean {
  if (filter === 'needs' && model.status !== 'unreviewed' && model.status !== 'imported') return false;
  if (filter === 'imported' && model.status !== 'imported') return false;
  if (filter === 'confirmed' && model.status !== 'confirmed') return false;
  if (filter === 'hidden' ? model.status !== 'hidden' : filter === 'all' && model.status === 'hidden') return false;
  const q = query.trim().toLowerCase();
  return !q || [label, model.id, model.name ?? ''].some((s) => s.toLowerCase().includes(q));
}

/** One line on what a model may do: its two heaviest activities, its data tier, and whether it asks first or waits on others. */
export function ruleSummary(provider: string, defaults: Rule, model: ModelEntry): string {
  const r = resolveModel(provider, defaults, model);
  const acts = ACTIVITIES.filter((a) => r.activities[a]).sort((a, b) => WEIGHT_LEVELS.indexOf(r.activities[b]!) - WEIGHT_LEVELS.indexOf(r.activities[a]!));
  const names = acts.slice(0, 2).map((a) => ACTIVITY_LABELS[a]).join(', ');
  const allowed = acts.length ? names + (acts.length > 2 ? ` +${acts.length - 2}` : '') : 'No activities allowed';
  return `${allowed}, ${DATA_TIER_LABELS[r.dataTier]}${r.askFirst ? ', Ask first' : ''}${r.useAfter.length ? `, Waits for ${r.useAfter.length}` : ''}`;
}

/** A provider's model count (hidden ones left out), how many wait for review, and whether a confirmed model somewhere waits for one of its models. */
export function providerCounts(policy: PolicyConfig, pid: string): { total: number; pending: number; drained: boolean } {
  const p = policy.providers[pid] ?? { defaults: {}, models: {} };
  const list = Object.values(p.models), mine = new Set(Object.keys(p.models));
  const drained = Object.values(policy.providers).some((q) => Object.values(q.models).some((x) => x.status === 'confirmed' && (x.rule.useAfter ?? q.defaults.useAfter ?? []).some((l) => mine.has(l))));
  return { total: list.filter((x) => x.status !== 'hidden').length, pending: list.filter((x) => x.status === 'unreviewed' || x.status === 'imported').length, drained };
}

/** The status note on a model: a newer version of a listed model says which one it replaces. */
export function statusText(policy: PolicyConfig, pid: string, entry: ModelEntry): string {
  const older = entry.supersedes ? policy.providers[pid]?.models[entry.supersedes] : undefined;
  return older && entry.status !== 'confirmed' && entry.status !== 'hidden' ? RULES_TEXT.supersedes(older.name ?? older.id) : RULES_TEXT.status[entry.status];
}

/** A model id as a provider writes it: no spaces, starting with a letter or digit. */
export const validModelId = (id: string): boolean => /^[A-Za-z0-9][\w.:/-]*$/.test(id);

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

/** The pause in force, in words: when it ends, which reset it waits for, and any weights it changes. */
export function pauseText(pause: NonNullable<Rule['pause']>, meterLabel: string | undefined, onProvider: boolean): string {
  const changed = pause.weights ? ACTIVITIES.filter((a) => a in pause.weights!).map((a) => `${ACTIVITY_LABELS[a]} ${pause.weights![a] ? WEIGHT_LABELS[pause.weights![a]!].toLowerCase() : 'not allowed'}`) : [];
  return `${changed.length ? 'Weights changed' : 'Paused'} until ${ruleWhen(pause.until)}${pause.meter ? ` (the ${meterLabel ?? pause.meter} reset)` : ''}${onProvider ? ', set on the provider' : ''}.${changed.length ? ` ${changed.join(', ')}.` : ''}${pause.reason ? ` ${pause.reason}` : ''}`;
}

/** The resets ahead, across providers whose last reading can be trusted, as choices for when a dial-back ends. */
export function dialEndChoices(snapshot: Snapshot | null, providers: ReadonlyArray<{ id: string; name: string }>, now = Date.now()): Array<{ value: string; label: string; until: string }> {
  return providers.flatMap((p) => pauseResets(snapshot, p.id, now).meters.map((x) => ({ value: `${p.id}|${x.id}`, label: `${p.name} ${x.label.toLowerCase()} resets, ${ruleWhen(x.resetsAt)}`, until: x.resetsAt })))
    .sort((a, b) => a.until.localeCompare(b.until));
}

const plain = (v: unknown): string => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v).replace(/_/g, ' '));

/** A rule value in words. A pause reads as its end time and any changed weights, and other grouped values as their parts. */
export function showValue(field: string, v: unknown): string {
  if (v === null || v === undefined) return 'unset';
  if (Array.isArray(v)) return v.length ? v.join(', ') : 'none';
  if (typeof v !== 'object') return plain(v);
  const o = v as Record<string, unknown>;
  if (field === 'pause' && typeof o.until === 'string') {
    const weights = o.weights && typeof o.weights === 'object' ? Object.entries(o.weights as Record<string, string | null>).map(([a, l]) => `${ACTIVITY_LABELS[a as keyof typeof ACTIVITY_LABELS] ?? a} ${l ? (WEIGHT_LABELS[l as keyof typeof WEIGHT_LABELS] ?? l).toLowerCase() : 'not allowed'}`) : [];
    return `${weights.length ? 'weights changed' : 'paused'} until ${ruleWhen(o.until)}${weights.length ? ` (${weights.join(', ')})` : ''}`;
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

/** A history entry in three parts: whose rule changed, which field, and what it changed from and to. */
export function describeChange(c: PolicyChange, providerName: (pid: string) => string): { who: string; field: string; text: string } {
  const [pid = '', model = '', field = ''] = c.path.split('|');
  const name = field.startsWith('activities.') ? ACTIVITY_LABELS[field.slice(11) as keyof typeof ACTIVITY_LABELS] ?? field : field.startsWith('thresholds.') ? field.slice(11) : field;
  return { who: model || RULES_TEXT.defaultsTitle(providerName(pid)), field: name, text: changeText(field, c.from, c.to) };
}

/** How a stored value reads in a bulk preview: an unset one follows the provider. */
export const previewValue = (field: string, v: unknown): string => v === undefined ? 'provider default' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : VALUE_LABELS[field]?.[String(v)] ?? String(v);
