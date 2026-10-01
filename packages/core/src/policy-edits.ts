// Changes to the rules that agents ask for through the MCP server. The running app is the only writer of its config, so an agent appends
// an edit to an inbox file and the app applies it through the same functions the rules page uses. Weights, pauses, notes and hold rules apply
// at once. Anything that changes what data a model may see or whether it runs waits in the app for its owner to accept it.

import { ACTIVITIES, COST_TIERS, DATA_TIERS, MODEL_STATUSES, OUTPUT_MODES, WEIGHT_LEVELS, fieldPath, resolveModel, resolveThresholds, setField } from './policy.js';
import type { ActivityId, PolicyConfig, PolicyFile, ResolvedModel } from './policy.js';
import { setModelStatus } from './models.js';

/** One requested change. `model` is a route label such as codex/sol; thresholds are per provider, so they name none. */
export interface PolicyEdit { id: string; at: string; by: string; provider: string; model: string; field: string; value: unknown; reason?: string }
export type EditKind = 'direct' | 'confirm';
export type EditStatus = 'applied' | 'held' | 'rejected' | 'dismissed';
export interface EditResult { id: string; at: string; status: EditStatus; provider: string; model: string; field: string; before: unknown; after: unknown; reason?: string }

/** What the app keeps about the inbox: the edits it has already looked at, what it did with them, and the ones waiting for the owner. */
export interface EditState { seen: string[]; results: EditResult[]; held: PolicyEdit[] }
export const INBOX_FILE = 'policy-edits.jsonl';
export const RESULTS_FILE = 'policy-edit-results.json';
const KEEP_SEEN = 500, KEEP_RESULTS = 200, KEEP_HELD = 50;

/** The value that puts a field back to the provider's default, since JSON has no undefined. */
export const INHERIT = 'inherit';

const DIRECT_FIELDS = new Set(['pause', 'notes', 'useAfter']);
const STRINGS = { effort: 200, notes: 2000, reason: 300 };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const level = (v: unknown) => WEIGHT_LEVELS.includes(v as never);

/** Whether an edit takes effect at once or needs the owner's confirmation. Null for a field that cannot be edited this way. */
export function editKind(field: string): EditKind | null {
  if (field.startsWith('activities.')) return ACTIVITIES.includes(field.slice(11) as ActivityId) ? 'direct' : null;
  if (DIRECT_FIELDS.has(field)) return 'direct';
  if (['dataTier', 'askFirst', 'output', 'sandbox', 'effort', 'cost', 'status'].includes(field)) return 'confirm';
  if (['hostCountry', 'retainsPrompts', 'trainsOnPrompts', 'pinnedHost'].includes(field.replace('dataHandling.', '')) && field.startsWith('dataHandling.')) return 'confirm';
  if (['warnPct', 'denyPct', 'minBalance'].includes(field.replace('thresholds.', '')) && field.startsWith('thresholds.')) return 'confirm';
  return null;
}

/** A problem with the value for a field, or null when it is acceptable. */
export function checkValue(field: string, value: unknown): string | null {
  if (value === INHERIT) return field.startsWith('thresholds.') || field === 'status' ? `${field} has no default to go back to.` : null;
  if (field.startsWith('activities.')) return value === null || level(value) ? null : `An activity takes ${WEIGHT_LEVELS.join(', ')}, null to block it, or "${INHERIT}".`;
  switch (field) {
    case 'dataTier': return DATA_TIERS.includes(value as never) ? null : `dataTier is one of ${DATA_TIERS.join(', ')}.`;
    case 'askFirst': case 'sandbox': return typeof value === 'boolean' ? null : `${field} is true or false.`;
    case 'output': return OUTPUT_MODES.includes(value as never) ? null : `output is one of ${OUTPUT_MODES.join(', ')}.`;
    case 'cost': return COST_TIERS.includes(value as never) ? null : `cost is one of ${COST_TIERS.join(', ')}.`;
    case 'status': return MODEL_STATUSES.includes(value as never) ? null : `status is one of ${MODEL_STATUSES.join(', ')}.`;
    case 'effort': return value === null || (typeof value === 'string' && value.length <= STRINGS.effort) ? null : 'effort is a short text or null.';
    case 'notes': return typeof value === 'string' && value.length <= STRINGS.notes ? null : `notes is a text of at most ${STRINGS.notes} characters.`;
    case 'useAfter': return Array.isArray(value) && value.length <= 10 && value.every(x => typeof x === 'string' && x.includes('/')) ? null : 'useAfter is a list of route labels such as codex/sol.';
    case 'pause': {
      if (value === null) return null;
      if (!isObj(value) || typeof value.until !== 'string' || !Number.isFinite(Date.parse(value.until))) return 'pause is null or { until: an ISO time, weights?, reason? }.';
      if (value.weights !== undefined && value.weights !== null && !(isObj(value.weights) && Object.entries(value.weights).every(([a, w]) => ACTIVITIES.includes(a as ActivityId) && (w === null || level(w))))) return 'pause.weights maps activities to a weight or null.';
      return value.reason === undefined || (typeof value.reason === 'string' && value.reason.length <= STRINGS.reason) ? null : 'pause.reason is a short text.';
    }
    case 'thresholds.warnPct': case 'thresholds.denyPct': return typeof value === 'number' && value >= 0 && value <= 100 ? null : `${field} is a percentage from 0 to 100.`;
    case 'thresholds.minBalance': return value === null || (typeof value === 'number' && value >= 0) ? null : 'minBalance is a number or null.';
    default:
      if (field.startsWith('dataHandling.')) return field.endsWith('retainsPrompts') || field.endsWith('trainsOnPrompts')
        ? (value === null || typeof value === 'boolean' ? null : `${field} is true, false or null.`)
        : (value === null || typeof value === 'string' ? null : `${field} is a text or null.`);
      return `${field} cannot be edited here.`;
  }
}

/** Checks an edit's shape and value, and that its model exists in `has`. Returns the problem, or null. */
export function checkEdit(edit: PolicyEdit, has: (provider: string, model: string) => boolean): string | null {
  const kind = editKind(edit.field);
  if (!kind) return `${edit.field} cannot be edited here.`;
  if (!edit.provider) return 'An edit names a provider.';
  if (edit.field.startsWith('thresholds.')) { if (edit.model) return 'Thresholds belong to a provider, so no model is named.'; }
  else if (!edit.model) return 'An edit names a model.';
  if (edit.model && !has(edit.provider, edit.model)) return `${edit.model} is not in the rules.`;
  const bad = checkValue(edit.field, edit.value);
  if (bad) return bad;
  if (edit.field === 'useAfter' && Array.isArray(edit.value) && edit.value.includes(edit.model)) return 'A model cannot wait on itself.';
  return null;
}

/** The value a field resolves to right now, for the before and after in a result. */
export function resolvedValue(policy: PolicyConfig, edit: Pick<PolicyEdit, 'provider' | 'model' | 'field'>): unknown {
  const p = policy.providers[edit.provider];
  if (!p) return undefined;
  if (edit.field.startsWith('thresholds.')) return (resolveThresholds(p) as unknown as Record<string, unknown>)[edit.field.slice(11)];
  const entry = p.models[edit.model];
  if (!entry) return undefined;
  const r = resolveModel(edit.provider, p.defaults, entry) as unknown as Record<string, unknown>;
  if (edit.field.startsWith('activities.')) return (r.activities as ResolvedModel['activities'])[edit.field.slice(11) as ActivityId] ?? null;
  if (edit.field.startsWith('dataHandling.')) return (r.dataHandling as Record<string, unknown>)[edit.field.slice(13)] ?? null;
  return r[edit.field];
}

/** Applies a checked edit through the rules' own setters, so it is stamped, recorded in the history and merged to other devices like any edit. */
export function applyEdit(policy: PolicyConfig, edit: PolicyEdit, device: string, now = new Date()): { before: unknown; after: unknown } {
  const before = resolvedValue(policy, edit);
  const value = edit.value === INHERIT ? undefined : edit.value;
  if (edit.field === 'status') setModelStatus(policy, edit.provider, edit.model, value as never, device, now);
  else setField(policy, fieldPath(edit.provider, edit.model || null, edit.field), value, device, now);
  return { before, after: resolvedValue(policy, edit) };
}

export function emptyEditState(): EditState { return { seen: [], results: [], held: [] }; }

/** Reads the inbox: one JSON edit per line. A line that is not an edit is skipped. */
export function parseInbox(text: string | null): PolicyEdit[] {
  const out: PolicyEdit[] = [];
  for (const line of (text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let v: unknown;
    try { v = JSON.parse(line); } catch { continue; }
    if (!isObj(v) || typeof v.id !== 'string' || typeof v.provider !== 'string' || typeof v.field !== 'string' || !('value' in v)) continue;
    out.push({ id: v.id, at: typeof v.at === 'string' ? v.at : '', by: typeof v.by === 'string' ? v.by : 'an agent', provider: v.provider,
      model: typeof v.model === 'string' ? v.model : '', field: v.field, value: v.value, ...(typeof v.reason === 'string' ? { reason: v.reason.slice(0, STRINGS.reason) } : {}) });
  }
  return out;
}

export function parseEditState(text: string | null): EditState {
  try {
    const v = JSON.parse(text ?? '') as unknown;
    if (!isObj(v)) return emptyEditState();
    const results = Array.isArray(v.results) ? v.results.filter(isObj) as unknown as EditResult[] : [];
    return { seen: Array.isArray(v.seen) ? v.seen.filter((x): x is string => typeof x === 'string') : [], results, held: parseInbox(Array.isArray(v.held) ? v.held.map(h => JSON.stringify(h)).join('\n') : '') };
  } catch { return emptyEditState(); }
}

const trim = (s: EditState): EditState => ({ seen: s.seen.slice(-KEEP_SEEN), results: s.results.slice(-KEEP_RESULTS), held: s.held.slice(-KEEP_HELD) });
const has = (policy: PolicyConfig) => (provider: string, model: string) => !!policy.providers[provider]?.models[model];
const result = (e: PolicyEdit, status: EditStatus, now: Date, before: unknown, after: unknown, reason?: string): EditResult =>
  ({ id: e.id, at: now.toISOString(), status, provider: e.provider, model: e.model, field: e.field, before, after, ...(reason ? { reason } : {}) });

/**
 * Looks at the inbox edits not seen before. A direct edit is applied, a confirm edit is held for the owner, and an edit that fails its checks is rejected with the reason.
 * Returns the new state, whether the rules changed, and the edits newly held.
 */
export function processInbox(policy: PolicyConfig, inbox: PolicyEdit[], state: EditState, device: string, now = new Date()): { state: EditState; changed: boolean; newlyHeld: PolicyEdit[] } {
  const next: EditState = { seen: [...state.seen], results: [...state.results], held: [...state.held] };
  const seen = new Set(next.seen), newlyHeld: PolicyEdit[] = [];
  let changed = false;
  for (const e of inbox) {
    if (seen.has(e.id)) continue;
    seen.add(e.id); next.seen.push(e.id);
    const bad = checkEdit(e, has(policy));
    if (bad) { next.results.push(result(e, 'rejected', now, null, null, bad)); continue; }
    if (editKind(e.field) === 'confirm') {
      const before = resolvedValue(policy, e);
      next.held.push(e); newlyHeld.push(e); next.results.push(result(e, 'held', now, before, e.value, 'Waiting for the owner to accept it in Augur.'));
      continue;
    }
    const { before, after } = applyEdit(policy, e, device, now);
    next.results.push(result(e, 'applied', now, before, after)); changed = true;
  }
  return { state: trim(next), changed, newlyHeld };
}

/** The owner's answer to a held edit. Accepting applies it, with the checks run again against the rules as they are now. */
export function resolveHeld(policy: PolicyConfig, state: EditState, id: string, accept: boolean, device: string, now = new Date()): { state: EditState; changed: boolean } {
  const e = state.held.find(h => h.id === id);
  if (!e) return { state, changed: false };
  const next: EditState = { seen: state.seen, results: [...state.results], held: state.held.filter(h => h.id !== id) };
  if (!accept) { next.results.push(result(e, 'dismissed', now, resolvedValue(policy, e), e.value, 'Dismissed by the owner.')); return { state: trim(next), changed: false }; }
  const bad = checkEdit(e, has(policy));
  if (bad) { next.results.push(result(e, 'rejected', now, null, null, bad)); return { state: trim(next), changed: false }; }
  const { before, after } = applyEdit(policy, e, device, now);
  next.results.push(result(e, 'applied', now, before, after, 'Accepted by the owner.'));
  return { state: trim(next), changed: true };
}

/**
 * Applies edits to a copy of policy.json's resolved rules, to rank models as if they had landed. Edits that fail their checks are listed
 * with the reason. An edit that puts a field back to the provider's default cannot be previewed, since the file no longer carries the defaults.
 */
export function previewEdits(file: PolicyFile, edits: Array<Pick<PolicyEdit, 'provider' | 'model' | 'field' | 'value'>>): { file: PolicyFile; applied: number; problems: string[] } {
  const copy = structuredClone(file), problems: string[] = [];
  let applied = 0;
  for (const e of edits) {
    const bad = checkEdit({ id: '', at: '', by: '', ...e }, (p, m) => !!copy.providers[p]?.models[m]);
    if (bad) { problems.push(`${e.model || e.provider} ${e.field}: ${bad}`); continue; }
    if (e.value === INHERIT) { problems.push(`${e.model} ${e.field}: a preview cannot go back to a default; give a value.`); continue; }
    const p = copy.providers[e.provider]!;
    if (e.field.startsWith('thresholds.')) { (p.thresholds as unknown as Record<string, unknown>)[e.field.slice(11)] = e.value; applied++; continue; }
    const m = p.models[e.model]! as unknown as Record<string, unknown>;
    if (e.field.startsWith('activities.')) {
      const acts = m.activities as Record<string, unknown>, a = e.field.slice(11);
      if (e.value === null) delete acts[a]; else acts[a] = e.value;
    } else if (e.field.startsWith('dataHandling.')) (m.dataHandling as Record<string, unknown>)[e.field.slice(13)] = e.value;
    else m[e.field] = e.value;
    applied++;
  }
  return { file: copy, applied, problems };
}
