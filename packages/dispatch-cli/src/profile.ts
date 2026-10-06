// `augur profile`: moves a setup between computers as one file. The file holds the balance settings and the routes, and never a key. An import goes through the same
// edit inbox an agent's request does, so the owner's approval setting decides whether it lands at once or waits in the app.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendPolicyEdits, augurHome } from '@augur/augurd';
import { balanceField } from '@augur/core';
import { EXIT_CODES, adapterInfo, balanceLeaves, checkBalanceSetting } from '@augur/dispatch-protocol';
import { parseRoutesText } from '@augur/view-model';

export const PROFILE_KIND = 'augur-profile';
export const PROFILE_HELP = `augur profile export [file]            write the balance settings and routes to a file, or print them; never a key
augur profile import <file> [--dry-run]   apply a profile file: balance settings go through the edit inbox, and routes with a new name are added`;

export interface ProfileIo { err(text: string): void; env: NodeJS.ProcessEnv; cwd: string }

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
// A route holds the name of an environment variable or a store, never a key, but a hand-edited file could. These option names are never exported.
const SECRET_OPTION = /^(api_?key|key|token|secret|password)$/i;

const routesPath = (env: NodeJS.ProcessEnv): string => env.AUGURD_ROUTES ?? join(augurHome(env), 'dispatch', 'routes.json');
const readText = (path: string): string | null => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
const writeAtomic = (path: string, text: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(`${path}.tmp`, text, 'utf8'); renameSync(`${path}.tmp`, path); };

/** The profile file for this computer: the balance overrides from policy.json and the routes the service accepts. */
export function buildProfile(env: NodeJS.ProcessEnv, now = new Date()): { profile: Raw; dropped: string[] } | { error: string } {
  let balance: unknown = {};
  const policy = readText(join(augurHome(env), 'policy.json'));
  if (policy) { try { const p = JSON.parse(policy) as unknown; if (isObj(p) && isObj(p.balance)) balance = p.balance; } catch { return { error: 'policy.json is not valid JSON, so the balance could not be read.' }; } }
  const parsed = parseRoutesText(readText(routesPath(env)));
  if (!parsed.ok) return { error: parsed.error };
  const routes: Raw = {}, dropped: string[] = [];
  for (const r of parsed.file.routes) {
    const raw = (parsed.file.raw.routes as Raw)[r.name] as Raw;
    const options = isObj(raw.options) ? Object.fromEntries(Object.entries(raw.options).filter(([k]) => { const secret = SECRET_OPTION.test(k); if (secret) dropped.push(`${r.name}.${k}`); return !secret; })) : {};
    routes[r.name] = { ...raw, options };
  }
  return { profile: { kind: PROFILE_KIND, schema: 1, exportedAt: now.toISOString(), balance, routes }, dropped };
}

export interface ProfilePlan { edits: Array<{ field: string; value: unknown }>; routes: Array<{ name: string; entry: Raw }>; existing: string[]; problems: string[] }

/** What importing a profile would do. Every balance setting and every route is checked, so one bad entry stops the whole import before anything is written. */
export function planProfile(text: string, existingRoutes: ReadonlySet<string>): ProfilePlan | { error: string } {
  let data: unknown;
  try { data = JSON.parse(text); } catch (e) { return { error: `That file is not valid JSON: ${(e as Error).message}` }; }
  if (!isObj(data) || data.kind !== PROFILE_KIND) return { error: `That file is not an Augur profile. A profile has "kind": "${PROFILE_KIND}".` };
  if (data.schema !== 1) return { error: `This profile is schema ${String(data.schema)}, and this Augur reads schema 1. Update Augur, or export the profile again.` };
  const plan: ProfilePlan = { edits: [], routes: [], existing: [], problems: [] };
  for (const { path, value } of balanceLeaves(data.balance)) {
    const bad = checkBalanceSetting(path, value);
    if (bad) plan.problems.push(`balance ${path.join('.')}: ${bad}`); else plan.edits.push({ field: balanceField(path), value });
  }
  const routes = isObj(data.routes) ? data.routes : {};
  const parsed = parseRoutesText(JSON.stringify({ routes }));
  if (parsed.ok) {
    for (const name of parsed.file.skipped) plan.problems.push(`route ${name}: needs a name of lowercase letters, digits, - and _, a model and an adapter.`);
    for (const r of parsed.file.routes) {
      const raw = (parsed.file.raw.routes as Raw)[r.name] as Raw;
      if (!adapterInfo(r.adapter)) { plan.problems.push(`route ${r.name}: ${r.adapter} is not an adapter this Augur has.`); continue; }
      const secret = isObj(raw.options) ? Object.keys(raw.options).find(k => SECRET_OPTION.test(k)) : undefined;
      if (secret) { plan.problems.push(`route ${r.name}: the option ${secret} looks like a key. A profile never carries one; use augur key set ${r.name}.`); continue; }
      if (existingRoutes.has(r.name)) plan.existing.push(r.name); else plan.routes.push({ name: r.name, entry: raw });
    }
  }
  return plan;
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

export async function profileCmd(rest: string[], flags: { dryRun: boolean }, io: ProfileIo, say: (human: string, data: unknown) => void, now = new Date()): Promise<number> {
  const [action, file] = rest;
  if (action === 'export') {
    const built = buildProfile(io.env, now);
    if ('error' in built) { io.err(`${built.error}\n`); return EXIT_CODES.failed; }
    const text = `${JSON.stringify(built.profile, null, 2)}\n`;
    if (!file) { say(text.trimEnd(), built.profile); return EXIT_CODES.completed; }
    writeAtomic(join(io.cwd, file), text);
    const routes = Object.keys(built.profile.routes as Raw).length, settings = balanceLeaves(built.profile.balance).length;
    say(`Wrote ${file}: ${plural(settings, 'balance setting')} and ${plural(routes, 'route')}. It holds no keys.${built.dropped.length ? ` Left out: ${built.dropped.join(', ')}.` : ''}`, { file, settings, routes, dropped: built.dropped });
    return EXIT_CODES.completed;
  }
  if (action === 'import') {
    if (!file) { io.err('augur profile import needs the profile file.\n'); return EXIT_CODES.usage; }
    const path = join(io.cwd, file);
    if (!existsSync(path)) { io.err(`${file} was not found.\n`); return EXIT_CODES.usage; }
    const current = parseRoutesText(readText(routesPath(io.env)));
    if (!current.ok) { io.err(`${current.error}\n`); return EXIT_CODES.failed; }
    const plan = planProfile(readFileSync(path, 'utf8'), new Set([...current.file.routes.map(r => r.name), ...current.file.skipped]));
    if ('error' in plan) { io.err(`${plan.error}\n`); return EXIT_CODES.usage; }
    if (plan.problems.length) { io.err(`Nothing was changed. The profile has ${plural(plan.problems.length, 'problem')}:\n${plan.problems.map(p => `  ${p}\n`).join('')}`); return EXIT_CODES.usage; }
    const summary = `${plural(plan.edits.length, 'balance setting')} and ${plural(plan.routes.length, 'new route')}${plan.existing.length ? `, with ${plural(plan.existing.length, 'route')} left as they are (${plan.existing.join(', ')})` : ''}`;
    if (flags.dryRun) { say(`Would apply ${summary}. Nothing was written.`, { dryRun: true, ...plan }); return EXIT_CODES.completed; }
    if (plan.routes.length) {
      const raw = current.file.raw, merged = { ...raw, routes: { ...(raw.routes as Raw), ...Object.fromEntries(plan.routes.map(r => [r.name, r.entry])) } };
      writeAtomic(routesPath(io.env), `${JSON.stringify(merged, null, 2)}\n`);
    }
    const at = now.toISOString();
    if (plan.edits.length) appendPolicyEdits(`${plan.edits.map((e, i) => JSON.stringify({ id: `${at}-profile-${i}`, at, by: 'augur profile import', provider: '', model: '', field: e.field, value: e.value })).join('\n')}\n`, augurHome(io.env));
    say(`Applied ${summary}.${plan.edits.length ? ' The balance settings reach the rules within a minute while Augur is running, or wait for you in Model rules if your approval setting holds them.' : ''}${plan.routes.length ? ' A new route needs its key: run augur key set <route>.' : ''}`, { dryRun: false, edits: plan.edits.length, routes: plan.routes.map(r => r.name), existing: plan.existing });
    return EXIT_CODES.completed;
  }
  io.err(`${PROFILE_HELP}\n`);
  return EXIT_CODES.usage;
}
