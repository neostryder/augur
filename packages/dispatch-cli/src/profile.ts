// `augur profile`: moves a setup between computers as one file. The file holds the balance settings, the routes and the model rules, and never a key.
// Balance settings go through the edit inbox, so the owner's approval setting decides whether they land at once or wait in the app.
// A model arrives unreviewed, so nothing runs it until the owner confirms it in Model rules.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { appendPolicyEdits, augurHome } from '@augur/augurd';
import type { ProviderAdded, ProviderAddition } from '@augur/core';
import { EXIT_CODES, balanceLeaves } from '@augur/dispatch-protocol';
import { PROFILE_KIND, PROFILE_SECRET_OPTION, modelsSection, parseRoutesText, planProfileFile } from '@augur/view-model';
import type { ProfileModelAdd, ProfileModelRef } from '@augur/view-model';

export { PROFILE_KIND };
export const PROFILE_HELP = `augur profile export [file]            write the balance settings, the routes and the model rules to a file, or print them; never a key
augur profile import <file> [--dry-run]   apply a profile file: balance settings go through the edit inbox, new routes are added, and new models arrive unreviewed`;

export interface ProfileIo { err(text: string): void; env: NodeJS.ProcessEnv; cwd: string }

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
// A route holds the name of an environment variable or a store, never a key, but a hand-edited file could. These option names are never exported.
const SECRET_OPTION = PROFILE_SECRET_OPTION;

export const routesPath = (env: NodeJS.ProcessEnv): string => env.AUGURD_ROUTES ?? join(augurHome(env), 'dispatch', 'routes.json');
export const readText = (path: string): string | null => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
export const writeAtomic = (path: string, text: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(`${path}.tmp`, text, 'utf8'); renameSync(`${path}.tmp`, path); };

/** The profile file for this computer: the balance overrides and model rules from policy.json, and the routes the service accepts. */
export function buildProfile(env: NodeJS.ProcessEnv, now = new Date()): { profile: Raw; dropped: string[] } | { error: string } {
  let balance: unknown = {};
  let models: ReturnType<typeof modelsSection> = null;
  const policy = readText(join(augurHome(env), 'policy.json'));
  if (policy) {
    try {
      const p = JSON.parse(policy) as unknown;
      if (isObj(p) && isObj(p.balance)) balance = p.balance;
      models = modelsSection(p);
    } catch { return { error: 'policy.json is not valid JSON, so the balance could not be read.' }; }
  }
  const parsed = parseRoutesText(readText(routesPath(env)));
  if (!parsed.ok) return { error: parsed.error };
  const routes: Raw = {}, dropped: string[] = [];
  for (const r of parsed.file.routes) {
    const raw = (parsed.file.raw.routes as Raw)[r.name] as Raw;
    const options = isObj(raw.options) ? Object.fromEntries(Object.entries(raw.options).filter(([k]) => { const secret = SECRET_OPTION.test(k); if (secret) dropped.push(`${r.name}.${k}`); return !secret; })) : {};
    routes[r.name] = { ...raw, options };
  }
  const profile: Raw = { kind: PROFILE_KIND, schema: 1, exportedAt: now.toISOString(), balance, routes };
  if (models) profile.models = models;
  return { profile, dropped };
}

export interface ProfilePlan { edits: Array<{ field: string; value: unknown }>; routes: Array<{ name: string; entry: Raw }>; existing: string[]; models: ProfileModelAdd[]; existingModels: string[]; problems: string[] }

/** What importing a profile would do. Every balance setting, route and model is checked, so one bad entry stops the whole import before anything is written. */
export function planProfile(text: string, existingRoutes: ReadonlySet<string>, existingModels: readonly ProfileModelRef[] = []): ProfilePlan | { error: string } {
  return planProfileFile(text, existingRoutes, existingModels);
}

function knownModels(env: NodeJS.ProcessEnv): { models: ProfileModelRef[] } | { error: string } {
  const text = readText(join(augurHome(env), 'policy.json'));
  if (!text) return { models: [] };
  let data: unknown;
  try { data = JSON.parse(text); } catch { return { error: 'policy.json is not valid JSON, so the models already here could not be read.' }; }
  if (!isObj(data) || !isObj(data.providers)) return { models: [] };
  const models: ProfileModelRef[] = [];
  for (const [provider, raw] of Object.entries(data.providers)) {
    if (!isObj(raw) || !isObj(raw.models)) continue;
    for (const [label, model] of Object.entries(raw.models)) if (isObj(model) && typeof model.id === 'string') models.push({ provider, label, id: model.id });
  }
  return { models };
}

const summaryOf = (plan: ProfilePlan): string => {
  const models = plan.models.length || plan.existingModels.length
    ? ` and ${plural(plan.models.length, 'new model')}${plan.existingModels.length ? `, with ${plural(plan.existingModels.length, 'model')} left as they are (${plan.existingModels.join(', ')})` : ''}`
    : '';
  const routesLeft = plan.existing.length ? `, with ${plural(plan.existing.length, 'route')} left as they are (${plan.existing.join(', ')})` : '';
  return `${plural(plan.edits.length, 'balance setting')} and ${plural(plan.routes.length, 'new route')}${models}${routesLeft}`;
};

export interface ProfileDeps { addProvider?: (input: ProviderAddition) => Promise<ProviderAdded> }

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

export async function profileCmd(rest: string[], flags: { dryRun: boolean }, io: ProfileIo, say: (human: string, data: unknown) => void, now = new Date(), deps?: ProfileDeps): Promise<number> {
  const [action, file] = rest;
  if (action === 'export') {
    const built = buildProfile(io.env, now);
    if ('error' in built) { io.err(`${built.error}\n`); return EXIT_CODES.failed; }
    const text = `${JSON.stringify(built.profile, null, 2)}\n`;
    if (!file) { say(text.trimEnd(), built.profile); return EXIT_CODES.completed; }
    writeAtomic(resolve(io.cwd, file), text);
    const routes = Object.keys(built.profile.routes as Raw).length, settings = balanceLeaves(built.profile.balance).length;
    let modelCount = 0;
    if (isObj(built.profile.models)) for (const group of Object.values(built.profile.models)) if (isObj(group)) modelCount += Object.keys(group).length;
    say(`Wrote ${file}: ${plural(settings, 'balance setting')} and ${plural(routes, 'route')}${modelCount ? ` and ${plural(modelCount, 'model rule')}` : ''}. It holds no keys.${built.dropped.length ? ` Left out: ${built.dropped.join(', ')}.` : ''}`, { file, settings, routes, models: modelCount, dropped: built.dropped });
    return EXIT_CODES.completed;
  }
  if (action === 'import') {
    if (!file) { io.err('augur profile import needs the profile file.\n'); return EXIT_CODES.usage; }
    const path = resolve(io.cwd, file);
    if (!existsSync(path)) { io.err(`${file} was not found.\n`); return EXIT_CODES.usage; }
    const current = parseRoutesText(readText(routesPath(io.env)));
    if (!current.ok) { io.err(`${current.error}\n`); return EXIT_CODES.failed; }
    const known = knownModels(io.env);
    if ('error' in known) { io.err(`${known.error}\n`); return EXIT_CODES.failed; }
    const plan = planProfile(readFileSync(path, 'utf8'), new Set([...current.file.routes.map(r => r.name), ...current.file.skipped]), known.models);
    if ('error' in plan) { io.err(`${plan.error}\n`); return EXIT_CODES.usage; }
    if (plan.problems.length) { io.err(`Nothing was changed. The profile has ${plural(plan.problems.length, 'problem')}:\n${plan.problems.map(p => `  ${p}\n`).join('')}`); return EXIT_CODES.usage; }
    const summary = summaryOf(plan);
    if (flags.dryRun) { say(`Would apply ${summary}. Nothing was written.`, { dryRun: true, ...plan }); return EXIT_CODES.completed; }
    if (plan.models.length && !deps?.addProvider) { io.err('Nothing was changed. Adding models needs the running service.\n'); return EXIT_CODES.failed; }
    const groups = new Map<string, ProfileModelAdd[]>();
    for (const model of plan.models) {
      const group = groups.get(model.provider) ?? [];
      group.push(model);
      groups.set(model.provider, group);
    }
    let addedProviders = 0;
    try {
      for (const [provider, models] of groups) {
        await deps!.addProvider!({ provider, name: provider, models: models.map(m => ({ label: m.label, id: m.id, ...(m.name ? { name: m.name } : {}), ...(Object.keys(m.rule).length ? { rule: m.rule } : {}) })) });
        addedProviders++;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      io.err(addedProviders === 0 ? `Nothing was changed. ${message}\n` : `Some models were added. The routes were not written. ${message}\n`);
      return EXIT_CODES.failed;
    }
    if (plan.routes.length) {
      const raw = current.file.raw, merged = { ...raw, routes: { ...(raw.routes as Raw), ...Object.fromEntries(plan.routes.map(r => [r.name, r.entry])) } };
      writeAtomic(routesPath(io.env), `${JSON.stringify(merged, null, 2)}\n`);
    }
    const at = now.toISOString();
    if (plan.edits.length) appendPolicyEdits(`${plan.edits.map((e, i) => JSON.stringify({ id: `${at}-profile-${i}`, at, by: 'augur profile import', provider: '', model: '', field: e.field, value: e.value })).join('\n')}\n`, augurHome(io.env));
    say(`Applied ${summary}.${plan.edits.length ? ' The balance settings reach the rules within a minute while Augur is running, or wait for you in Model rules if your approval setting holds them.' : ''}${plan.models.length ? ' New models stay unreviewed until you confirm them in Model rules.' : ''}${plan.routes.length ? ' A new route needs its key: run augur key set <route>.' : ''}`, { dryRun: false, edits: plan.edits.length, routes: plan.routes.map(r => r.name), existing: plan.existing, models: plan.models.map(m => m.label), existingModels: plan.existingModels });
    return EXIT_CODES.completed;
  }
  io.err(`${PROFILE_HELP}\n`);
  return EXIT_CODES.usage;
}
