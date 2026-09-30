// The Routes page's data handling, kept free of the DOM so it can be tested. routes.json is a file people also edit by hand,
// so everything in it that the page does not manage (unknown keys, entries the service ignores) is carried through a save untouched.
import { adapterInfo } from '@augur/dispatch-protocol';
import type { OptionSpec } from '@augur/dispatch-protocol';

export const ROUTES_PATH = '.augur/dispatch/routes.json';
const NAME = /^[a-z][a-z0-9_-]*$/;
const MODEL = /^[a-z0-9][a-z0-9_-]*\/\S+$/i;

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface RouteDraft {
  name: string;
  model: string;
  adapter: string;
  /** Option values as the form holds them: everything is text until the draft is saved. */
  options: Record<string, string>;
  delegation: boolean;
  notes: string;
  /** Budget and fallback as the form holds them, as text. Empty means none. */
  budgetUsd: string;
  budgetJobs: string;
  budgetPer: string;
  fallback: string;
}

export interface RoutesFile {
  /** The whole parsed file, so a save writes back every key it does not manage. */
  raw: Raw;
  /** Routes the service will accept, in file order. */
  routes: Array<{ name: string; model: string; adapter: string; options: Record<string, string | number | boolean>; delegation: boolean; notes: string; budget: { per: string; usd?: number; jobs?: number } | null; fallback: string[] }>;
  /** Entries the service skips: a name it does not accept, or a missing model or adapter. */
  skipped: string[];
}

export type Parsed = { ok: true; file: RoutesFile } | { ok: false; error: string };

export function parseRoutesText(text: string | null): Parsed {
  if (text === null || !text.trim()) return { ok: true, file: { raw: { routes: {} }, routes: [], skipped: [] } };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { ok: false, error: `routes.json is not valid JSON: ${(e as Error).message}` }; }
  if (!isObj(raw) || (raw.routes !== undefined && !isObj(raw.routes))) return { ok: false, error: 'routes.json must be an object with a "routes" object inside it.' };
  const file: RoutesFile = { raw: { ...raw, routes: isObj(raw.routes) ? raw.routes : {} }, routes: [], skipped: [] };
  for (const [name, r] of Object.entries(file.raw.routes as Raw)) {
    if (!NAME.test(name) || !isObj(r) || typeof r.model !== 'string' || typeof r.adapter !== 'string') { file.skipped.push(name); continue; }
    const options: Record<string, string | number | boolean> = {};
    if (isObj(r.options)) for (const [k, v] of Object.entries(r.options)) if (['string', 'number', 'boolean'].includes(typeof v)) options[k] = v as string | number | boolean;
    const b = isObj(r.budget) && ['day', 'week', 'month'].includes(String(r.budget.per)) ? r.budget : null;
    const budget = b ? { per: String(b.per), ...(typeof b.usd === 'number' ? { usd: b.usd } : {}), ...(typeof b.jobs === 'number' ? { jobs: b.jobs } : {}) } : null;
    file.routes.push({ name, model: r.model, adapter: r.adapter, options, delegation: r.delegation === true, notes: typeof r.notes === 'string' ? r.notes : '', budget,
      fallback: Array.isArray(r.fallback) ? r.fallback.filter((n): n is string => typeof n === 'string') : [] });
  }
  return { ok: true, file };
}

export const emptyDraft = (): RouteDraft => ({ name: '', model: '', adapter: 'codex-exec', options: {}, delegation: false, notes: '', budgetUsd: '', budgetJobs: '', budgetPer: 'day', fallback: '' });

export function draftOf(route: RoutesFile['routes'][number]): RouteDraft {
  return { name: route.name, model: route.model, adapter: route.adapter, options: Object.fromEntries(Object.entries(route.options).map(([k, v]) => [k, String(v)])), delegation: route.delegation, notes: route.notes,
    budgetUsd: route.budget?.usd !== undefined ? String(route.budget.usd) : '', budgetJobs: route.budget?.jobs !== undefined ? String(route.budget.jobs) : '', budgetPer: route.budget?.per ?? 'day',
    fallback: route.fallback.join(', ') };
}

/** The first problem with a draft, in a sentence, or null when it can be saved. */
export function checkDraft(d: RouteDraft, existing: string[], isNew: boolean): string | null {
  if (!NAME.test(d.name)) return 'The name starts with a lowercase letter and uses only lowercase letters, digits, hyphens and underscores.';
  if (isNew && existing.includes(d.name)) return `A route named ${d.name} already exists.`;
  if (!MODEL.test(d.model)) return 'Name the model as provider/model, for example codex/luna. It is the label the rules page uses.';
  const info = adapterInfo(d.adapter);
  if (!info) return 'Choose an adapter.';
  for (const spec of info.options) {
    const value = (d.options[spec.key] ?? '').trim();
    if (!value) {
      // A key kept in the credential store has no variable to name.
      if (spec.required && !(spec.key === 'apiKeyEnv' && d.options.keySource === 'store')) return `${spec.label} is required for this adapter.`;
      continue;
    }
    const problem = checkOption(spec, value);
    if (problem) return problem;
  }
  const usd = d.budgetUsd.trim(), jobs = d.budgetJobs.trim();
  if (usd && !(Number.isFinite(Number(usd)) && Number(usd) > 0)) return 'The dollar budget must be a number above zero.';
  if (jobs && !(Number.isInteger(Number(jobs)) && Number(jobs) > 0)) return 'The job budget must be a whole number above zero.';
  for (const n of fallbackNames(d)) {
    if (n === d.name) return 'A route cannot be its own fallback.';
    if (!existing.includes(n)) return `${n} is not a route yet. Add it first, or take it out of the fallbacks.`;
  }
  return null;
}

export const fallbackNames = (d: RouteDraft): string[] => d.fallback.split(',').map((n) => n.trim()).filter(Boolean);

function checkOption(spec: OptionSpec, value: string): string | null {
  if (spec.kind === 'number' && !(Number.isFinite(Number(value)) && Number(value) > 0)) return `${spec.label} must be a number above zero.`;
  if (spec.kind === 'choice' && !(spec.choices ?? []).includes(value)) return `${spec.label} must be one of ${(spec.choices ?? []).join(', ')}.`;
  if (spec.kind === 'json') { try { if (!Array.isArray(JSON.parse(value))) return `${spec.label} must be a JSON array.`; } catch { return `${spec.label} is not valid JSON.`; } }
  return null;
}

function storedOptions(d: RouteDraft): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const spec of adapterInfo(d.adapter)?.options ?? []) {
    const v = (d.options[spec.key] ?? '').trim();
    if (v) out[spec.key] = spec.kind === 'number' ? Number(v) : v;
  }
  return out;
}

/** The file text after adding or replacing a route, or removing one when `draft` is null. Other entries and keys are left exactly as they were. */
export function writeRoute(file: RoutesFile, name: string, draft: RouteDraft | null): string {
  const routes = { ...(file.raw.routes as Raw) };
  if (!draft) delete routes[name];
  else {
    const previous = isObj(routes[name]) ? routes[name] as Raw : {};
    const { options: _o, delegation: _d, notes: _n, budget: _b, fallback: _f, ...kept } = previous;
    const entry: Raw = { ...kept, model: draft.model.trim(), adapter: draft.adapter, options: storedOptions(draft) };
    if (draft.delegation) entry.delegation = true;
    if (draft.notes.trim()) entry.notes = draft.notes.trim();
    const usd = Number(draft.budgetUsd), jobs = Number(draft.budgetJobs);
    if (draft.budgetUsd.trim() || draft.budgetJobs.trim()) entry.budget = { per: draft.budgetPer, ...(draft.budgetUsd.trim() ? { usd } : {}), ...(draft.budgetJobs.trim() ? { jobs } : {}) };
    if (fallbackNames(draft).length) entry.fallback = fallbackNames(draft);
    routes[name] = entry;
  }
  return JSON.stringify({ ...file.raw, routes }, null, 2) + '\n';
}
