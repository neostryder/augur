// Standard-shape providers: a base URL, a model and a key give a route to an OpenAI-style or Anthropic-style API, a balance reading when the API publishes one,
// and a model waiting for its rules. The plan is worked out here, free of any file or service, so the command line and the apps check a provider the same way.
import { readPath } from '@augur/core';
import { routeSecretName } from '@augur/dispatch-protocol';
import type { GenericProviderDef } from '@augur/core';

export type TemplateShape = 'openai-style' | 'anthropic-style' | 'jev-style';

export interface ProviderPreset {
  id: string;
  label: string;
  shape: TemplateShape;
  baseUrl: string;
  /** The provider id the model goes under in the rules. Its own balance reading is built in when `builtIn` is set. */
  provider: string;
  builtIn?: boolean;
}

/** Services whose address is published. Anything else takes a shape and a base URL. */
export const PRESETS: readonly ProviderPreset[] = [
  { id: 'openai', label: 'OpenAI', shape: 'openai-style', baseUrl: 'https://api.openai.com/v1', provider: 'openai' },
  { id: 'openrouter', label: 'OpenRouter', shape: 'openai-style', baseUrl: 'https://openrouter.ai/api/v1', provider: 'openrouter', builtIn: true },
  { id: 'anthropic', label: 'Anthropic', shape: 'anthropic-style', baseUrl: 'https://api.anthropic.com', provider: 'anthropic' },
  { id: 'typesafe', label: 'TypeSafe (Jev)', shape: 'jev-style', baseUrl: 'https://api.typesafe.ai', provider: 'jev', builtIn: true },
];

export const SHAPES: ReadonlyArray<{ id: TemplateShape; label: string; adapter: string | null; summary: string }> = [
  { id: 'openai-style', label: 'OpenAI-style API', adapter: 'openai-api', summary: 'A chat completions endpoint. Adds a route, and a balance reading when the API has a balance address.' },
  { id: 'anthropic-style', label: 'Anthropic-style API', adapter: 'anthropic-api', summary: 'A messages endpoint. Adds a route, and a balance reading when the API has a balance address.' },
  { id: 'jev-style', label: 'Jev-style service', adapter: null, summary: 'A service with the /v1/systemone shape. Points the Jev provider at it and turns it on. No route.' },
];

export interface TemplateInput {
  /** A preset id (openai, openrouter, anthropic, typesafe) or a shape (openai-style, anthropic-style, jev-style). */
  kind: string;
  route?: string;
  provider?: string;
  baseUrl?: string;
  /** The model id the API expects. */
  model?: string;
  /** The model's name in the rules. Defaults to the model id. */
  label?: string;
  balanceUrl?: string;
  /** Where the balance sits in the reply, such as $.data.balance. */
  balancePath?: string;
  maxTokens?: string;
}

export interface ProviderPlan {
  shape: TemplateShape;
  preset: ProviderPreset | null;
  provider: string;
  name: string;
  route: { name: string; entry: Record<string, unknown> } | null;
  model: { label: string; id: string } | null;
  custom: GenericProviderDef | null;
  /** A built-in provider to turn on, with the settings it takes. */
  enable: { settings: Record<string, string> } | null;
  /** The keys the plan needs, by the secret name the key store uses, and what each one is for. */
  keys: Array<{ secret: string; for: string; viaEngine: boolean }>;
}

const NAME = /^[a-z][a-z0-9_-]*$/;
const trimSlash = (url: string): string => url.trim().replace(/\/+$/, '');

/** A key only goes over https, or over http to this computer. */
export function checkBaseUrl(url: string): string | null {
  if (/^https:\/\/[^/\s]+/.test(url) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url)) return null;
  return 'A base URL starts with https://, or with http:// for a service on this computer.';
}

/** Everything a provider of a standard shape needs, or every problem found. Nothing is written here. */
export function planProvider(input: TemplateInput, existingRoutes: ReadonlySet<string>): ProviderPlan | { problems: string[] } {
  const preset = PRESETS.find(p => p.id === input.kind) ?? null;
  const shape = preset?.shape ?? SHAPES.find(s => s.id === input.kind)?.id;
  if (!shape) return { problems: [`"${input.kind}" is not a template. Use ${[...PRESETS.map(p => p.id), ...SHAPES.map(s => s.id)].join(', ')}.`] };
  const problems: string[] = [];
  const baseUrl = trimSlash(input.baseUrl ?? preset?.baseUrl ?? '');
  if (!baseUrl) problems.push(`The ${shape} template needs --base-url.`);
  else { const bad = checkBaseUrl(baseUrl); if (bad) problems.push(bad); }
  const provider = input.provider ?? preset?.provider ?? '';
  if (shape === 'jev-style') {
    for (const [flag, value] of [['--route', input.route], ['--model', input.model], ['--balance-url', input.balanceUrl]] as const) {
      if (value !== undefined) problems.push(`${flag} does not apply to a Jev-style service. It has no route, and its balance comes from its own console.`);
    }
    if (problems.length) return { problems };
    return { shape, preset, provider: 'jev', name: 'Jev', route: null, model: null, custom: null, enable: { settings: baseUrl === 'https://api.typesafe.ai' ? {} : { baseUrl } },
      keys: [{ secret: 'jev.apiKey', for: 'the Jev provider', viaEngine: true }] };
  }
  if (!provider) problems.push('Name the provider the model goes under with --provider, for example acme. The rules page lists the model under it.');
  else if (!NAME.test(provider)) problems.push('A provider id starts with a lowercase letter and holds lowercase letters, digits, - and _.');
  const route = input.route ?? '';
  if (!route) problems.push('Name the route as the first argument after the template, for example augur provider add openai gpt.');
  else if (!NAME.test(route)) problems.push('A route name starts with a lowercase letter and holds lowercase letters, digits, - and _.');
  else if (existingRoutes.has(route)) problems.push(`A route named ${route} already exists. Pick another name, or change that route on the Routes page.`);
  const modelId = (input.model ?? '').trim();
  if (!modelId) problems.push('--model needs the model id the API expects, for example gpt-5.');
  else if (/\s/.test(modelId)) problems.push('A model id has no spaces.');
  const label = (input.label ?? modelId).trim();
  if (label && /[\s|]/.test(label)) problems.push('A model label has no spaces or | characters.');
  let maxTokens: number | undefined;
  if (input.maxTokens !== undefined) { maxTokens = Number(input.maxTokens); if (!Number.isInteger(maxTokens) || maxTokens < 1) problems.push('--max-tokens is a whole number above 0.'); }
  if ((input.balanceUrl === undefined) !== (input.balancePath === undefined)) problems.push('A balance reading needs both --balance-url and --balance-path.');
  if (input.balanceUrl !== undefined && preset?.builtIn) problems.push(`${preset.label} has its own balance reading built in, so leave out --balance-url and --balance-path.`);
  if (input.balanceUrl !== undefined) { const bad = checkBaseUrl(input.balanceUrl.trim()); if (bad) problems.push(bad.replace('A base URL', 'The balance URL')); }
  if (input.balancePath !== undefined) { try { readPath({}, input.balancePath.trim()); } catch { problems.push('--balance-path is a path into the reply such as $.data.balance, with dots and [0] steps.'); } }
  if (problems.length) return { problems };
  const adapter = SHAPES.find(s => s.id === shape)!.adapter!;
  const name = preset?.label ?? provider;
  const entry = { model: `${provider}/${label}`, adapter, options: { baseUrl, model: modelId, keySource: 'store', ...(maxTokens ? { maxTokens } : {}) },
    notes: `Added with augur provider add ${input.kind}.` };
  const custom: GenericProviderDef | null = input.balanceUrl === undefined ? null : {
    id: provider, name, auth: { type: 'bearer' }, requests: { balance: { url: input.balanceUrl.trim() } }, plan: 'Pay as you go',
    money: [{ id: 'balance', label: 'Balance', amount: `balance:${(input.balancePath as string).trim()}`, currency: 'USD' }],
  };
  const keys: ProviderPlan['keys'] = [{ secret: routeSecretName(route), for: `the ${route} route`, viaEngine: false }];
  if (custom || preset?.builtIn) keys.push({ secret: `${provider}.apiKey`, for: `reading the ${name} balance`, viaEngine: true });
  return { shape, preset, provider, name, route: { name: route, entry }, model: { label, id: modelId }, custom, enable: preset?.builtIn ? { settings: {} } : null, keys };
}
