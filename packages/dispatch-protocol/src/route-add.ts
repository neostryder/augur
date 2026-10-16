// Planning a route an agent asks to add. Nothing here writes a file or talks to the engine.
// A route add never carries a key, never changes a route that already exists, and leaves its model unreviewed.
import { readPath } from '@augur/core';
import type { GenericProviderDef } from '@augur/core';
import { SECRET_OPTION, looksLikeSecretValue } from './secrets.js';

const NAME = /^[a-z][a-z0-9_-]*$/;
/** The only options an agent may set. Anything that names a program, an argument list, a folder, an environment variable or a header is the owner's to set in Routes, because it decides what the service runs or sends. */
export const AGENT_OPTIONS: readonly string[] = ['baseUrl', 'model', 'mode', 'maxTokens', 'timeoutS', 'effort', 'requestClass', 'maxImageMb', 'maxAudioMb', 'maxInput', 'keySource'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export type ProviderKind = 'builtin' | 'custom' | 'rules-only' | 'none';

export interface RouteAddContext {
  existingRoutes: ReadonlySet<string>;
  knownAdapters: ReadonlySet<string>;
  /** A built-in, a custom reading or a rules-only provider cannot take a new balance reading. */
  providerKind: (id: string) => ProviderKind;
}

export interface PlannedRouteAdd {
  name: string;
  provider: string;
  entry: { model: string; adapter: string; options: Record<string, string | number | boolean> };
  model: { label: string; id: string; name?: string } | null;
  custom: GenericProviderDef | null;
}

export interface RouteAddParams {
  name: string;
  adapter: string;
  provider: string;
  options?: Record<string, string | number | boolean>;
  model?: { label: string; id: string; name?: string };
  balanceUrl?: string;
  balancePath?: string;
}

export interface RouteAddAnswer {
  ok: boolean;
  held?: boolean;
  problems?: string[];
  text: string;
  route?: string;
  model?: string | null;
}

const routeName = (input: Record<string, unknown>): string => typeof input.name === 'string' && input.name ? input.name : '<route>';

/** Shape problems that can be decided without the service: a key, a secret value, or a model id it cannot store. */
export function routeAddShapeProblems(input: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const name = routeName(input);
  for (const key of Object.keys(input)) {
    if (SECRET_OPTION.test(key)) problems.push(`A route add never takes ${key}. Set the key with augur key set ${name}.`);
  }
  if (input.options !== undefined && !isObj(input.options)) problems.push('options is an object of strings, numbers and booleans.');
  else if (isObj(input.options)) {
    for (const [key, value] of Object.entries(input.options)) {
      if (SECRET_OPTION.test(key)) problems.push(`The option ${key} looks like a key. A route never carries one; set it with augur key set ${name}.`);
      else if (!AGENT_OPTIONS.includes(key)) problems.push(`The option ${key} is set by the owner in Routes. A route add takes ${AGENT_OPTIONS.join(', ')}.`);
      else if (key === 'keySource' && value !== 'store') problems.push('A route add takes keySource store only, so the key lives in the key store and not in an environment variable.');
      else if (typeof value === 'string' && looksLikeSecretValue(value)) problems.push(`An option value looks like a key. A route never carries one; set it with augur key set ${name}.`);
      else if (typeof value === 'number' && !Number.isFinite(value)) problems.push(`options.${key} is not a finite number.`);
      else if (!['string', 'number', 'boolean'].includes(typeof value)) problems.push('options is an object of strings, numbers and booleans.');
    }
  }
  for (const key of ['balanceUrl', 'balancePath'] as const) {
    const value = input[key];
    if (typeof value === 'string' && looksLikeSecretValue(value)) problems.push(`A route add never takes a key. Set it with augur key set ${name}.`);
  }
  if (input.model !== undefined && !isObj(input.model)) problems.push('model is an object with a label and an id.');
  else if (isObj(input.model)) {
    const extra = Object.keys(input.model).filter(k => !['label', 'id', 'name'].includes(k));
    if (extra.length) problems.push('A route add does not take rule fields. The model stays unreviewed until the owner confirms it in Model rules.');
    const id = input.model.id;
    if (typeof id !== 'string' || !id.trim() || /\s/.test(id) || id.includes('|')) problems.push('A model id has no spaces or | characters.');
    else if (looksLikeSecretValue(id)) problems.push(`A route add never takes a key. Set it with augur key set ${name}.`);
    const label = input.model.label;
    if (typeof label !== 'string' || !label.trim() || /[\s|]/.test(label)) problems.push('A model label has no spaces or | characters.');
    if (input.model.name !== undefined && typeof input.model.name !== 'string') problems.push('A model name is a text.');
  }
  return problems;
}

function balanceUrlProblem(url: string): string | null {
  if (/^https:\/\/[^/\s]+/.test(url) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url)) return null;
  return 'The balance URL starts with https://, or with http:// for a service on this computer.';
}

/** The route that would be written, or every problem found. Nothing is written here. */
export function planRouteAdd(input: Record<string, unknown>, ctx: RouteAddContext): { plan: PlannedRouteAdd } | { problems: string[] } {
  const problems = routeAddShapeProblems(input);
  const name = typeof input.name === 'string' ? input.name : '';
  if (!NAME.test(name)) problems.push('A route name starts with a lowercase letter and holds lowercase letters, digits, - and _.');
  else if (ctx.existingRoutes.has(name)) problems.push(`A route named ${name} already exists. Nothing was written.`);
  const adapter = typeof input.adapter === 'string' ? input.adapter : '';
  if (!adapter) problems.push('Name the adapter.');
  else if (!ctx.knownAdapters.has(adapter)) problems.push(`${adapter} is not an adapter this service has.`);
  const provider = typeof input.provider === 'string' ? input.provider : '';
  if (!NAME.test(provider)) problems.push('A provider id starts with a lowercase letter and holds lowercase letters, digits, - and _.');
  const hasUrl = typeof input.balanceUrl === 'string' && input.balanceUrl.trim() !== '';
  const hasPath = typeof input.balancePath === 'string' && input.balancePath.trim() !== '';
  const oneReading = (input.balanceUrl !== undefined && input.balancePath === undefined) || (input.balanceUrl === undefined && input.balancePath !== undefined);
  if (oneReading || (hasUrl !== hasPath && (input.balanceUrl !== undefined || input.balancePath !== undefined))) problems.push('A balance reading needs both a balance URL and a balance path.');
  let custom: GenericProviderDef | null = null;
  if (hasUrl && hasPath && NAME.test(provider)) {
    const kind = ctx.providerKind(provider);
    if (kind === 'builtin' || kind === 'rules-only') problems.push(`${provider} keeps its own usage reading. Leave the balance reading out.`);
    else if (kind === 'custom') problems.push(`A custom provider named ${provider} already exists. Change it in Settings.`);
    else {
      const url = (input.balanceUrl as string).trim();
      const path = (input.balancePath as string).trim();
      const urlProblem = balanceUrlProblem(url);
      if (urlProblem) problems.push(urlProblem);
      try { readPath({}, path); } catch { problems.push('The balance path is a path into the reply such as $.balance, with dots and [0] steps.'); }
      if (!urlProblem) custom = { id: provider, name: provider, auth: { type: 'bearer' }, requests: { balance: { url } }, plan: 'Pay as you go', money: [{ id: 'balance', label: 'Balance', amount: `balance:${path}`, currency: 'USD' }] };
    }
  }
  if (problems.length) return { problems };
  const rawModel = isObj(input.model) ? input.model : null;
  const labelText = rawModel && typeof rawModel.label === 'string' ? rawModel.label.trim() : '';
  const model = rawModel && typeof rawModel.id === 'string' ? {
    label: labelText.includes('/') ? labelText : `${provider}/${labelText}`,
    id: rawModel.id.trim(),
    ...(typeof rawModel.name === 'string' && rawModel.name ? { name: rawModel.name } : {}),
  } : null;
  const options: Record<string, string | number | boolean> = {};
  if (isObj(input.options)) for (const [key, value] of Object.entries(input.options)) if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') options[key] = value;
  return { plan: { name, provider, entry: { model: model ? model.label : `${provider}/${name}`, adapter, options }, model, custom } };
}
