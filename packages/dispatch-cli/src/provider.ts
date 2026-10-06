// `augur provider`: adds a provider of a standard shape from a base URL, a model and a key. The route goes in routes.json, the model goes into the rules to wait for
// the owner's confirmation, a balance reading is added when the API has one, and the key is stored the way `augur key set` stores it, never on the command line.
import { appDirs, createKeyStore } from '@augur/augurd';
import type { KeyStore } from '@augur/augurd';
import type { ProviderAdded, ProviderAddition } from '@augur/core';
import { EXIT_CODES } from '@augur/dispatch-protocol';
import { PRESETS, SHAPES, parseRoutesText, planProvider } from '@augur/view-model';
import type { ProviderPlan, TemplateInput } from '@augur/view-model';
import { KINDS, readValue } from './key.js';
import type { KeyIo } from './key.js';
import { readText, routesPath, writeAtomic } from './profile.js';

export const PROVIDER_HELP = `augur provider templates             the presets and shapes that need only a base URL, a model and a key
augur provider add <template> [route] --model <id> [--base-url <url>] [--provider <id>] [--label <name>] [--balance-url <url> --balance-path <$.path>] [--max-tokens <n>]
                                      [--env <NAME>|--stdin|--no-key] [--dry-run]    add a route, its model and its balance reading; the key comes from a hidden prompt`;

export interface ProviderIo extends KeyIo { out(text: string): void; cwd: string }
export interface ProviderFlags { text: Map<string, string>; stdin: boolean; noKey: boolean; dryRun: boolean }
export interface ProviderDeps {
  addProvider(input: ProviderAddition): Promise<ProviderAdded>;
  setProviderKey(provider: string, field: string, value: string): Promise<void>;
}

type Raw = Record<string, unknown>;

const TEMPLATE_LINES = [
  ...PRESETS.map(p => `${p.id.padEnd(16)} ${p.label}: ${p.baseUrl}${p.shape === 'jev-style' ? ' (no route)' : ''}`),
  ...SHAPES.map(s => `${s.id.padEnd(16)} ${s.summary} Needs --base-url.`),
];

/** What the command would do, as one line per change. */
function describePlan(plan: ProviderPlan): string[] {
  const lines: string[] = [];
  if (plan.route) lines.push(`a route ${plan.route.name} to ${String((plan.route.entry.options as Raw).baseUrl)} (adapter ${String(plan.route.entry.adapter)}, model ${plan.model!.id})`);
  if (plan.model) lines.push(`the model ${plan.provider}/${plan.model.label} in the rules, unreviewed, so it cannot run until you confirm its rules`);
  if (plan.custom) lines.push(`a balance reading for ${plan.name} from ${Object.values(plan.custom.requests)[0]!.url}`);
  if (plan.enable) lines.push(plan.provider === 'jev' ? `the Jev provider turned on${plan.enable.settings.baseUrl ? `, reading ${plan.enable.settings.baseUrl}` : ''}` : `the ${plan.name} balance reading turned on`);
  return lines;
}

export async function providerCmd(rest: string[], flags: ProviderFlags, io: ProviderIo, say: (human: string, data: unknown) => void, deps: ProviderDeps, store?: KeyStore): Promise<number> {
  const [action, kind, route] = rest;
  if (action === 'templates') { say(TEMPLATE_LINES.join('\n'), { presets: PRESETS, shapes: SHAPES }); return EXIT_CODES.completed; }
  if (action !== 'add') { io.err(`${PROVIDER_HELP}\n`); return EXIT_CODES.usage; }
  if (!kind) { io.err(`augur provider add needs a template. The templates are:\n${TEMPLATE_LINES.map(l => `  ${l}\n`).join('')}`); return EXIT_CODES.usage; }
  const isJev = kind === 'jev-style' || PRESETS.find(p => p.id === kind)?.shape === 'jev-style';
  if (isJev && route !== undefined) { io.err('A Jev-style service has no route, so there is no route name to give.\n'); return EXIT_CODES.usage; }
  const current = parseRoutesText(readText(routesPath(io.env)));
  if (!current.ok) { io.err(`${current.error}\n`); return EXIT_CODES.failed; }
  const get = (name: string) => flags.text.get(name);
  const input: TemplateInput = { kind, ...(route !== undefined ? { route } : {}) };
  for (const [flag, key] of [['provider', 'provider'], ['base-url', 'baseUrl'], ['model', 'model'], ['label', 'label'], ['balance-url', 'balanceUrl'], ['balance-path', 'balancePath'], ['max-tokens', 'maxTokens']] as const) {
    const v = get(flag);
    if (v !== undefined) (input as unknown as Record<string, string>)[key] = v;
  }
  const plan = planProvider(input, new Set([...current.file.routes.map(r => r.name), ...current.file.skipped]));
  if ('problems' in plan) { io.err(`Nothing was changed. ${plan.problems.length === 1 ? 'The problem' : 'The problems'}:\n${plan.problems.map(p => `  ${p}\n`).join('')}`); return EXIT_CODES.usage; }
  const lines = describePlan(plan);
  if (flags.dryRun) { say(`Would add:\n${lines.map(l => `  ${l}\n`).join('').trimEnd()}\nNothing was written.`, { dryRun: true, plan }); return EXIT_CODES.completed; }

  // The key is read before anything is written, so a cancelled prompt or a missing variable leaves everything as it was.
  let key: string | null = null;
  if (!flags.noKey && (get('env') || flags.stdin || (io.interactive && io.readSecret))) {
    const value = await readValue({ ...(get('env') ? { env: get('env') as string } : {}), stdin: flags.stdin }, io, plan.route?.name ?? plan.provider).catch((e: Error) => ({ error: e.message }));
    if (typeof value !== 'string') { io.err(`${value.error}\nNothing was changed.\n`); return EXIT_CODES.usage; }
    key = value;
  }

  let added: ProviderAdded;
  try {
    added = await deps.addProvider({ provider: plan.provider, name: plan.name, ...(plan.model ? { models: [plan.model] } : {}), ...(plan.custom ? { custom: plan.custom } : {}), ...(plan.enable ? { enable: plan.enable } : {}) });
  } catch (e) { io.err(`${(e as Error).message}\nNothing was changed.\n`); return EXIT_CODES.failed; }

  if (plan.route && plan.model) {
    // A model that was already in the rules keeps its label, so the route points at the label the rules page shows.
    const label = added.labels[plan.model.id] ?? plan.model.label;
    const entry = { ...plan.route.entry, model: `${plan.provider}/${label}` };
    const raw = current.file.raw;
    writeAtomic(routesPath(io.env), `${JSON.stringify({ ...raw, routes: { ...(raw.routes as Raw), [plan.route.name]: entry } }, null, 2)}\n`);
  }

  const stored: string[] = [], missing: string[] = [];
  const keys = store ?? createKeyStore({ dir: appDirs(io.env).config, ...(io.env.AUGUR_KEYSTORE === 'file' ? { kind: 'file' as const } : {}) });
  for (const k of plan.keys) {
    if (key === null) { missing.push(k.secret); continue; }
    if (k.viaEngine) await deps.setProviderKey(k.secret.slice(0, k.secret.indexOf('.')), k.secret.slice(k.secret.indexOf('.') + 1), key);
    else await keys.set(k.secret, key);
    stored.push(k.secret);
  }

  const next: string[] = [];
  if (plan.model) next.push(`Open Model rules and set ${plan.provider}/${added.labels[plan.model.id] ?? plan.model.label}. It cannot run until its rules are confirmed.`);
  for (const secret of missing) next.push(`Store the key for ${plan.keys.find(k => k.secret === secret)!.for}: augur key set ${secret.startsWith('dispatch.') ? plan.route!.name : secret}`);
  if (plan.route && !missing.length) next.push(`Check the route: augur test ${plan.route.name}`);
  const text = [`Added ${lines.join('; ')}.`, stored.length ? `A key of ${key!.length} characters is stored in ${KINDS[keys.kind] ?? keys.kind}.` : '', ...(next.length ? ['Next:', ...next.map(n => `  ${n}`)] : [])].filter(Boolean).join('\n');
  say(text, { added: lines, labels: added.labels, stored, next });
  return EXIT_CODES.completed;
}
