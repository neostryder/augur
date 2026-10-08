// The Add provider form, shared by the window app and the terminal app: what the form holds, the plan it shows while the person types, and the steps
// that apply the plan. The plan itself comes from `planProvider`, so the form, the command line and the service agree on what is valid.
import type { ProviderAdded, ProviderAddition } from '@augur/core';
import { PRESETS, SHAPES, planProvider, type ProviderPlan, type TemplateInput } from './provider-template.js';
import { parseRoutesText, type RoutesFile } from './routes-model.js';

type Raw = Record<string, unknown>;

/** What the form holds. Everything is text until the plan is made. */
export interface ProviderFormState {
  /** A preset id or a shape id from `PROVIDER_CHOICES`. */
  kind: string;
  route: string;
  model: string;
  label: string;
  provider: string;
  baseUrl: string;
  balanceUrl: string;
  balancePath: string;
  maxTokens: string;
  /** The key as typed. It is used once, when the plan is applied, and never kept after. */
  key: string;
  /** Whether the less common fields are shown. */
  more: boolean;
}

export interface ProviderChoice { id: string; label: string; sub: string; mark: string; group: 'preset' | 'shape' }

/** The list the form offers: the presets first, then the shapes for a service that is not on the list. */
export const PROVIDER_CHOICES: readonly ProviderChoice[] = [
  ...PRESETS.map((p): ProviderChoice => ({ id: p.id, label: p.label, sub: `${SHAPES.find((s) => s.id === p.shape)!.label}${p.builtIn ? ', balance built in' : ''}${p.shape === 'jev-style' ? ', no route' : ''}`, mark: p.label.charAt(0).toUpperCase(), group: 'preset' })),
  ...SHAPES.filter((s) => s.id !== 'jev-style').map((s): ProviderChoice => ({ id: s.id, label: `Other ${s.label.replace(' API', '')}`, sub: 'Your own base URL', mark: '+', group: 'shape' })),
];

export const emptyProviderForm = (kind = PROVIDER_CHOICES[0]!.id): ProviderFormState => ({ kind, route: '', model: '', label: '', provider: '', baseUrl: '', balanceUrl: '', balancePath: '', maxTokens: '', key: '', more: false });

/** The fields a choice shows without opening More. */
export function providerFields(kind: string): { route: boolean; model: boolean; provider: boolean; baseUrl: boolean } {
  const preset = PRESETS.find((p) => p.id === kind);
  const shape = preset?.shape ?? kind;
  if (shape === 'jev-style') return { route: false, model: false, provider: false, baseUrl: false };
  return { route: true, model: true, provider: !preset, baseUrl: !preset };
}

const blank = (v: string): string | undefined => (v.trim() ? v.trim() : undefined);

/** Turns the form into what `planProvider` takes. A field left empty is left out so the preset's own value is used. */
export function inputOf(f: ProviderFormState): TemplateInput {
  const fields = providerFields(f.kind);
  const input: TemplateInput = { kind: f.kind };
  const set = <K extends keyof TemplateInput>(k: K, v: string, show: boolean): void => { const t = blank(v); if (t !== undefined && show) (input as unknown as Record<string, string>)[k] = t; };
  set('route', f.route, fields.route);
  set('model', f.model, fields.model);
  set('provider', f.provider, fields.provider || f.more);
  set('baseUrl', f.baseUrl, fields.baseUrl || f.more);
  set('label', f.label, f.more && fields.model);
  set('balanceUrl', f.balanceUrl, f.more && fields.model);
  set('balancePath', f.balancePath, f.more && fields.model);
  set('maxTokens', f.maxTokens, f.more && fields.model);
  return input;
}

/** The plan for what is typed so far, or the problems that stop it. A form with nothing typed yet has no problems to show. */
export function planOfForm(f: ProviderFormState, existingRoutes: ReadonlySet<string>): { plan: ProviderPlan } | { problems: string[]; fresh: boolean } {
  const fields = providerFields(f.kind);
  const fresh = !f.route.trim() && !f.model.trim() && !f.provider.trim() && !f.baseUrl.trim() && fields.route;
  const got = planProvider(inputOf(f), existingRoutes);
  return 'problems' in got ? { problems: got.problems, fresh } : { plan: got };
}

export interface PlanRow { label: string; text: string; note?: string; tone?: 'warn' }

/** The plan as the rows the form shows: what is added, and what is not. */
export function planRows(plan: ProviderPlan): PlanRow[] {
  const rows: PlanRow[] = [];
  if (plan.route) rows.push({ label: 'Route', text: `${plan.route.name}, a ${plan.shape === 'anthropic-style' ? 'messages' : 'chat'} route to ${String((plan.route.entry.options as Raw).baseUrl)}` });
  if (plan.model) rows.push({ label: 'Model', text: `${plan.model.label} under ${plan.name}`, note: 'It waits for you to confirm its rules in Model rules, so nothing runs it yet.', tone: 'warn' });
  if (!plan.route && plan.enable) rows.push({ label: 'Service', text: `Turns on the Jev provider${plan.enable.settings.baseUrl ? `, using ${plan.enable.settings.baseUrl}` : ''}` });
  rows.push({ label: 'Key', text: plan.keys.length === 1 ? `One key, for ${plan.keys[0]!.for}` : `${plan.keys.length} keys: ${plan.keys.map((k) => k.for).join(' and ')}` });
  if (plan.route) {
    if (plan.custom) rows.push({ label: 'Balance', text: `Read from ${Object.values(plan.custom.requests)[0]!.url}` });
    else if (plan.preset?.builtIn) rows.push({ label: 'Balance', text: `${plan.name} has its own balance reading, turned on with this provider` });
    else rows.push({ label: 'Balance', text: 'None. Add a balance address under More options if the service publishes one.' });
  }
  return rows;
}

/** The route entry the plan writes, as it will look in routes.json. */
export const routeEntryText = (plan: ProviderPlan): string => (plan.route ? JSON.stringify({ [plan.route.name]: plan.route.entry }, null, 2) : '');

export interface ApplyIo {
  addProvider(input: ProviderAddition): Promise<ProviderAdded>;
  /** Stores a secret by its full name, such as dispatch.gpt.apiKey. */
  setSecret(name: string, value: string): Promise<void>;
  /** Stores a key a built-in provider reads, such as openrouter and apiKey. */
  setProviderKey(provider: string, field: string, value: string): Promise<void>;
  readRoutes(): Promise<string | null>;
  writeRoutes(text: string): Promise<void>;
}

export interface Applied {
  /** One line per change made. */
  done: string[];
  /** The model's label as the rules hold it, when the plan had a model. */
  label: string | null;
  /** The secret names that still need a key. */
  missing: string[];
  /** What to do next, in order. */
  next: string[];
}

/**
 * Applies a plan. routes.json is read first, so a file that cannot be used stops everything before anything is written. The rules and provider
 * list go in next, then the route, then the keys, so a failure leaves nothing pointing at a model the rules do not hold.
 */
export async function applyProvider(plan: ProviderPlan, key: string, io: ApplyIo): Promise<Applied> {
  let file: RoutesFile | null = null;
  if (plan.route) {
    const parsed = parseRoutesText(await io.readRoutes());
    if (!parsed.ok) throw new Error(parsed.error);
    if (parsed.file.routes.some((r) => r.name === plan.route!.name) || parsed.file.skipped.includes(plan.route.name)) throw new Error(`A route named ${plan.route.name} already exists. Pick another name.`);
    file = parsed.file;
  }
  const added = await io.addProvider({ provider: plan.provider, name: plan.name, ...(plan.model ? { models: [plan.model] } : {}), ...(plan.custom ? { custom: plan.custom } : {}), ...(plan.enable ? { enable: plan.enable } : {}) });
  const label = plan.model ? added.labels[plan.model.id] ?? plan.model.label : null;
  const done: string[] = [];
  if (plan.model) done.push(`${plan.provider}/${label} in the rules`);
  if (plan.custom) done.push(`a balance reading for ${plan.name}`);
  else if (plan.enable) done.push(plan.provider === 'jev' ? 'the Jev provider turned on' : `the ${plan.name} balance reading turned on`);
  if (plan.route && file && label) {
    const entry = { ...plan.route.entry, model: `${plan.provider}/${label}` };
    const raw = file.raw;
    await io.writeRoutes(`${JSON.stringify({ ...raw, routes: { ...(raw.routes as Raw), [plan.route.name]: entry } }, null, 2)}\n`);
    done.unshift(`the route ${plan.route.name}`);
  }
  const missing: string[] = [];
  const text = key.trim();
  for (const k of plan.keys) {
    if (!text) { missing.push(k.secret); continue; }
    if (k.viaEngine) await io.setProviderKey(k.secret.slice(0, k.secret.indexOf('.')), k.secret.slice(k.secret.indexOf('.') + 1), text);
    else await io.setSecret(k.secret, text);
    done.push(`a key for ${k.for}`);
  }
  const next: string[] = [];
  if (plan.model) next.push(`Open Model rules and confirm ${plan.provider}/${label}. It cannot run until its rules are confirmed.`);
  for (const secret of missing) next.push(`Save the key for ${plan.keys.find((k) => k.secret === secret)!.for}.`);
  if (plan.route && !missing.length) next.push(`Test the route ${plan.route.name} on the Routes page.`);
  return { done, label, missing, next };
}

/** The words on the form, shared by both apps. */
export const PROVIDER_FORM_TEXT = {
  title: 'Add provider',
  sub: 'Pick a service, then give it a model and a key',
  service: 'Service',
  details: 'Details',
  plan: 'Plan',
  add: 'Add provider',
  adding: 'Adding',
  cancel: 'Cancel',
  more: 'More options',
  fewer: 'Fewer options',
  showEntry: 'Show the route entry',
  fresh: 'Fill in the route name and the model id to see what will be added.',
  freshJev: 'Add a key to turn the Jev provider on.',
  fields: {
    route: { label: 'Route name', help: 'The name agents pass to augur run. It starts with a lowercase letter and holds only lowercase letters, digits, hyphens and underscores.', placeholder: 'gpt' },
    model: { label: 'Model id', help: 'The model name the service expects, for example gpt-5.', placeholder: 'gpt-5' },
    key: { label: 'API key', help: "Augur keeps it in this computer's key store and never shows it again. Leave it empty to save it later.", placeholder: 'Paste the key' },
    provider: { label: 'Provider id', help: 'The provider name the model is listed under in the rules, for example acme.', placeholder: 'acme' },
    baseUrl: { label: 'Base URL', help: "The API's address. It starts with https://, or http:// for a service on this computer.", placeholder: 'https://api.example.com/v1' },
    label: { label: 'Model name in the rules', help: 'The name the rules use for this model. Leave it empty to use the model id.', placeholder: '' },
    balanceUrl: { label: 'Balance address', help: 'The address that reports the account balance, if the service has one. Fill in the balance path with it.', placeholder: '' },
    balancePath: { label: 'Balance path', help: 'Where the balance sits in the reply, such as $.data.balance.', placeholder: '$.data.balance' },
    maxTokens: { label: 'Reply limit', help: 'The most tokens one reply may use. Leave it empty for the service default.', placeholder: '' },
  },
  done: (lines: string[], next: string[]): string => `Added ${lines.join(', ')}.${next.length ? ` Next: ${next.join(' ')}` : ''}`,
  failed: (why: string): string => `Could not add the provider. ${why}`,
  unavailable: 'Adding a provider needs the Augur service. Start it from the Service page, or use augur provider add.',
};
