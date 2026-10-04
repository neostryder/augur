// The `augur` command: the canonical caller of the dispatch service. Every command takes --json. Exit codes come from the protocol package.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVITIES, DATA_TIERS, OUTPUT_MODES } from '@augur/core';
import type { ActivityId, DataTier, OutputMode } from '@augur/core';
import { EXIT_CODES, TOOL_TIERS, describeFigure, exitCodeForState, isTerminal } from '@augur/dispatch-protocol';
import type { JobRecord, JobRequest, ToolTier } from '@augur/dispatch-protocol';
import { bridge, stdioBridge } from './bridge.js';
import { ServiceError, call, configLines, dataDir, disableLogin, enableLogin, loginState, setConfigValue, startViaLogin } from '@augur/augurd';

export interface Io { out(text: string): void; err(text: string): void; stdin(): string; env: NodeJS.ProcessEnv; cwd: string; /** A person is at the terminal: input and output are both attached to it. */ interactive?: boolean }

const HELP = `augur                   at a terminal, opens the full-screen app
augur run <route> --prompt-file <file|-> | --prompt <text> [options]
  --activity <a>     required. One of: ${ACTIVITIES.join(', ')}
  --data <tier>      required. ${DATA_TIERS.join(' | ')}
  --tools <t>        ${TOOL_TIERS.join(' | ')} (default read)
  --output <o>       ${OUTPUT_MODES.join(' | ')} (default text_only)
  --cwd <dir>        working directory (default: current)
  --expect-file <f>  file the job must leave in the working directory
  --timeout <s>      wall time limit in seconds
  --named            the route was named for this task by the person
  --allow <checks>   skip checks, comma separated: unpicked, exhausted (each use is recorded with the job)
  --no-failover      keep the job on this route even if a fallback route could take it
  --wait             wait for the job and print its result
augur jobs [--state <s>] [--root <id>] [--limit <n>]
augur status <job>
augur wait <job> [--timeout <s>]
augur result <job>
augur logs <job> [--stderr] [--follow]
augur cancel <job>
augur apply <job> [--check]
augur pick (--task <description> | --activity <a> --data <tier>) [--named <model>] [--fit <model>=<0-1>,...]
augur pressure
augur usage                             tokens and cost per route, each labelled reported, derived or imputed
augur note-prompt --session <id>     tell the service a person sent the message on standard input; it keeps only the models named
augur routes
augur test <route> [--wait]          send a fixed one-word prompt through a route to check it works
augur config [--json]                 the service's settings and what each is now
augur config set <setting> <value>    change one; a running service needs augur service stop then start to read it
augur service status | start | stop [--if-idle]     --if-idle stops the service only when no job is running, so an upgrade never cuts one off
augur service enable | disable    start the service at each login (systemd on Linux, launchd on macOS), or stop that
Every command takes --json. Exit codes: 0 completed, 1 usage, 2 rejected, 3 needs approval, 4 failed, 5 artifact check failed, 6 cancelled, 7 lost, 124 wait timed out.`;

interface Parsed { cmd: string[]; flags: Map<string, string | true> }
function parse(argv: string[]): Parsed {
  const cmd: string[] = [], flags = new Map<string, string | true>(), boolean = new Set(['json', 'wait', 'named', 'follow', 'stderr', 'help', 'if-idle', 'no-failover']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '-') { cmd.push(a); continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('='), name = a.slice(2, eq < 0 ? undefined : eq);
      if (eq >= 0) flags.set(name, a.slice(eq + 1));
      else if (boolean.has(name)) flags.set(name, true);
      else { const v = argv[++i]; if (v === undefined) throw new Error(`--${name} needs a value`); flags.set(name, v); }
    } else cmd.push(a);
  }
  return { cmd, flags };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const describe = (j: JobRecord) => `${j.id}  ${j.state.padEnd(26)} ${j.route.padEnd(12)} ${new Date(j.createdAt).toISOString().slice(0, 19)}Z${j.reason ? '  ' + j.reason : ''}`;

export async function main(argv: string[], io: Io): Promise<number> {
  let p: Parsed;
  try { p = parse(argv); } catch (e) { io.err(`${(e as Error).message}\n`); return EXIT_CODES.usage; }
  const json = p.flags.has('json'), [cmd, ...rest] = p.cmd;
  const opt = (n: string) => { const v = p.flags.get(n); return typeof v === 'string' ? v : undefined; };
  const say = (human: string, data: unknown) => io.out(json ? JSON.stringify(data) + '\n' : human + '\n');
  const opts = { dir: dataDir(io.env), ...(io.env.AUGURD_PIPE ? { pipe: io.env.AUGURD_PIPE } : {}) };
  // With no command at a terminal, `augur` opens the full-screen app; piped or scripted, it prints the help.
  if (!cmd && !p.flags.size && io.interactive) {
    const { runTui } = await import('@augur/tui');
    await runTui({ launch: () => launchService(io.env, opts), opts, env: io.env, login: { state: loginState, enable: () => enableAtLogin(io), disable: disableLogin }, dispatch: { restart: () => restartService(io, opts) } });
    return EXIT_CODES.completed;
  }
  if (!cmd || p.flags.has('help')) { io.out(HELP + '\n'); return cmd ? EXIT_CODES.completed : EXIT_CODES.usage; }

  try {
    switch (cmd) {
      case 'run': return await run(rest, p, io, opts, say, opt, json);
      case 'jobs': {
        const list = await call('list', { state: opt('state') as never, root: opt('root'), limit: opt('limit') ? Number(opt('limit')) : 25 }, opts);
        say(list.map(describe).join('\n') || 'No jobs.', list); return 0;
      }
      case 'status': {
        const j = await call('status', { id: need(rest[0], 'job id') }, opts);
        if (!j) { io.err('No such job.\n'); return EXIT_CODES.usage; }
        say(describe(j), j); return 0;
      }
      case 'wait': return await waitFor(need(rest[0], 'job id'), opt('timeout') ? Number(opt('timeout')) : null, io, opts, json);
      case 'result': {
        const r = await call('result', { id: need(rest[0], 'job id') }, opts);
        if (!r) { io.err('No such job.\n'); return EXIT_CODES.usage; }
        say(r.answer ?? '', r); return isTerminal(r.job.state) ? exitCodeForState(r.job.state) : EXIT_CODES.wait_timeout;
      }
      case 'logs': return await logs(need(rest[0], 'job id'), p.flags.has('stderr') ? 'stderr' : 'stdout', p.flags.has('follow'), io, opts);
      case 'cancel': {
        const r = await call('cancel', { id: need(rest[0], 'job id') }, opts);
        if (!r) { io.err('No such job.\n'); return EXIT_CODES.usage; }
        say(r.ok ? `Cancel requested (${r.state}).` : `Already ${r.state}.`, r); return 0;
      }
      case 'apply': {
        const r = await call('apply', { id: need(rest[0], 'job id'), check: p.flags.has('check') }, opts);
        if (!r) { io.err('No such job.\n'); return EXIT_CODES.usage; }
        say(r.output, r); return r.ok ? 0 : EXIT_CODES.failed;
      }
      case 'note-prompt': {
        const session = opt('session') ?? io.env.CLAUDE_CODE_SESSION_ID;
        if (!session) { io.err('Give --session, or run inside a session that sets CLAUDE_CODE_SESSION_ID.' + String.fromCharCode(10)); return EXIT_CODES.usage; }
        const r = await call('human_prompt', { session, text: io.stdin() }, opts);
        if ('error' in r) { io.err(r.error + String.fromCharCode(10)); return EXIT_CODES.failed; }
        say(r.models.join(', ') || 'No models named.', r); return 0;
      }
      case 'pick': return await pickCmd(io, opts, say, opt);
      case 'pressure': {
        const r = await call('pressure', undefined, opts);
        if (!r) { io.err('Pressure needs policy.json and usage.json.\n'); return EXIT_CODES.failed; }
        say(Object.entries(r.factors).map(([m, f]) => `${m.padEnd(22)} factor ${f.toFixed(2)}`).join('\n') + `\nscarcity ${r.scarcity}`, r); return 0;
      }
      case 'usage': {
        const r = await call('accounting', { limit: opt('limit') ? Number(opt('limit')) : 20 }, opts);
        const rows = Object.entries(r.routes).map(([route, x]) => {
          const t = x.totals, cost = t.costJobs ? `$${t.costUsd.toFixed(t.costUsd < 0.01 ? 5 : 4)} over ${t.costJobs} of ${t.jobs} jobs (${t.byProvenance.reported} reported, ${t.byProvenance.derived} derived, ${t.byProvenance.imputed} imputed)`
            : r.ratedModels.includes(x.model ?? '') ? 'no cost yet' : 'no rate set';
          const b = x.budget, budget = !b ? '' : `; budget per ${b.per}: ${[b.jobs.limit !== null ? `${b.jobs.used} of ${b.jobs.limit} jobs` : '', b.usd.limit !== null ? `$${b.usd.used.toFixed(2)} of $${b.usd.limit}${b.usdUnchecked ? ' (cost unknown)' : ''}` : ''].filter(Boolean).join(', ')}`;
          return `${route.padEnd(14)} ${t.inputTokens.toLocaleString('en-US')} in, ${t.outputTokens.toLocaleString('en-US')} out, ${cost}${budget}`;
        });
        const jobs = r.jobs.map(j => `${j.id}  ${j.route.padEnd(12)} in ${describeFigure(j.accounted.inputTokens, 'tokens')}, out ${describeFigure(j.accounted.outputTokens, 'tokens')}, cost ${describeFigure(j.accounted.costUsd, 'usd')}`);
        const recent = jobs.length ? ['', 'Recent jobs', ...jobs] : [];
        say((rows.length ? [...rows, ...recent] : ['No jobs yet.']).join('\n'), r); return 0;
      }
      case 'routes': { const r = await call('routes', undefined, opts); say(r.map(x => `${x.name.padEnd(14)} ${x.model.padEnd(16)} ${x.adapter}${x.problem ? `   cannot run: ${x.problem}` : ''}`).join('\n') || 'No routes.', r); return 0; }
      case 'test': return await testCmd(need(rest[0], 'route'), p, io, opts, say, json);
      case 'config': {
        if (rest[0] === 'set') {
          const r = setConfigValue(opts.dir, need(rest[1], 'setting'), need(rest[2], 'value'));
          if (!r.ok) { io.err(r.error + '\n'); return EXIT_CODES.usage; }
          say(`${rest[1]} is now ${r.value}. A running service reads it when it next starts.`, { setting: rest[1], value: r.value }); return 0;
        }
        const lines = configLines(opts.dir);
        say(lines.map(l => `${l.key.padEnd(20)} ${l.value.padEnd(24)} ${l.value === l.default ? '' : `(default ${l.default}) `}${l.weakens ? '[lowers checks] ' : ''}${l.label}`).join('\n'), lines); return 0;
      }
      case 'service': return await service(rest[0], io, opts, json, p.flags.has('if-idle'));
      // The window app's link to the engine; it runs until the app closes its input.
      case 'bridge': return await bridge(stdioBridge(io.env), opts, opt('app-exe'));
      default: io.err(`Unknown command ${cmd}.\n${HELP}\n`); return EXIT_CODES.usage;
    }
  } catch (e) {
    if (e instanceof ServiceError) { io.err(`${e.message}\n`); return e.code === 'usage' ? EXIT_CODES.usage : EXIT_CODES.failed; }
    io.err(`${(e as Error).message}\n`); return EXIT_CODES.usage;
  }
}

function need(v: string | undefined, what: string): string { if (!v) throw new Error(`Missing ${what}.`); return v; }
type Opts = { dir: string; pipe?: string };

async function run(rest: string[], p: Parsed, io: Io, opts: Opts, say: (h: string, d: unknown) => void, opt: (n: string) => string | undefined, json: boolean): Promise<number> {
  const route = need(rest[0], 'route');
  const pf = opt('prompt-file'), text = opt('prompt');
  if ((pf === undefined) === (text === undefined)) { io.err('Give the prompt with --prompt <text> or --prompt-file <file|->.\n'); return EXIT_CODES.usage; }
  // The CLI is the person's own process, so it reads the prompt file itself and sends the text. The service reads a prompt file only from inside the job's folder.
  let promptText: string | undefined = pf === '-' ? io.stdin() : text;
  if (pf !== undefined && pf !== '-') { try { promptText = readFileSync(resolve(io.cwd, pf), 'utf8'); } catch { io.err(`The prompt file ${pf} could not be read.\n`); return EXIT_CODES.usage; } }
  // What the work is and how sensitive its data is decide which models may see it, so neither has a default. Tools and output default to the least authority.
  if (opt('activity') === undefined || opt('data') === undefined) { io.err('Give --activity and --data. The data tier decides which models may see the task, so it is never assumed.\n'); return EXIT_CODES.usage; }
  const pick = <T extends string>(name: string, list: readonly T[], d: T): T | null => { const v = (opt(name) ?? d) as T; return list.includes(v) ? v : null; };
  const activity = pick('activity', ACTIVITIES, 'research'), dataTier = pick('data', DATA_TIERS, 'regulated'), tools = pick('tools', TOOL_TIERS, 'read'), output = pick('output', OUTPUT_MODES, 'text_only');
  if (!activity || !dataTier || !tools || !output) { io.err('One of --activity, --data, --tools or --output is not a known value.\n'); return EXIT_CODES.usage; }
  const parentId = io.env.AUGUR_JOB_ID;
  const allow = (opt('allow') ?? '').split(',').map(x => x.trim()).filter(Boolean) as Array<'unpicked' | 'exhausted'>;
  if (allow.some(x => x !== 'unpicked' && x !== 'exhausted')) { io.err('--allow takes unpicked, exhausted, or both.\n'); return EXIT_CODES.usage; }
  const req: JobRequest = {
    route, activity: activity as ActivityId, dataTier: dataTier as DataTier, tools: tools as ToolTier, output: output as OutputMode, cwd: resolve(io.cwd, opt('cwd') ?? '.'),
    prompt: { text: promptText as string },
    ...(opt('expect-file') ? { expectFile: opt('expect-file') as string } : {}), ...(opt('timeout') ? { timeoutS: Number(opt('timeout')) } : {}),
    ...(p.flags.has('named') ? { named: true } : {}),
    caller: { kind: parentId ? 'job' : 'cli', ...(parentId ? { label: parentId } : {}), ...(io.env.CLAUDE_CODE_SESSION_ID ? { session: io.env.CLAUDE_CODE_SESSION_ID } : {}), ...(io.interactive ? { interactive: true } : {}) },
    ...(allow.length ? { allow } : {}), ...(p.flags.has('no-failover') ? { failover: false } : {}),
    ...(parentId ? { parent: { jobId: parentId, rootJobId: io.env.AUGUR_ROOT_JOB_ID ?? parentId, depth: 0 } } : {}),
  };
  const res = await call('submit', req, opts);
  if ('rejected' in res) { io.err(`Rejected (${res.rejected.code}): ${res.rejected.reason}\n`); if (json) io.out(JSON.stringify(res) + '\n'); return EXIT_CODES.rejected; }
  for (const w of res.warnings) io.err(`Warning: ${w}\n`);
  if (!p.flags.has('wait')) { say(res.id, res); return EXIT_CODES.completed; }
  const code = await waitFor(res.id, req.timeoutS ? req.timeoutS + 60 : null, io, opts, json, true);
  const r = await call('result', { id: res.id }, opts);
  if (r) io.out(json ? JSON.stringify(r) + '\n' : (r.answer ?? '') + (r.answer?.endsWith('\n') ? '' : '\n'));
  return code;
}

/**
 * Sends one fixed prompt through a route, from an empty folder, as public read-only text. It answers whether the route can run at all: the harness starts,
 * the model answers, and the rules allow this model to do so. It skips the pick check, since nobody chose this model for a task.
 */
async function testCmd(route: string, p: Parsed, io: Io, opts: Opts, say: (h: string, d: unknown) => void, json: boolean): Promise<number> {
  const base = {
    route, dataTier: 'public' as const, tools: 'read' as const, output: 'text_only' as const, cwd: mkdtempSync(join(tmpdir(), 'augur-route-test-')), timeoutS: 120,
    prompt: { text: 'Reply with the single word ok and nothing else.' }, caller: { kind: 'cli' as const, label: 'route test' }, allow: ['unpicked' as const],
  };
  // The rules decide what a model may do, so the test uses the first activity they allow it. A refusal costs nothing, since no job starts.
  let res: Awaited<ReturnType<typeof call<'submit'>>> | null = null;
  for (const activity of ACTIVITIES) {
    res = await call('submit', { ...base, activity }, opts);
    if (!('rejected' in res) || res.rejected.code !== 'activity_not_permitted') break;
  }
  if (!res) return EXIT_CODES.failed;
  if ('rejected' in res) { io.err(`Rejected (${res.rejected.code}): ${res.rejected.reason}\n`); if (json) io.out(JSON.stringify(res) + '\n'); return EXIT_CODES.rejected; }
  if (!p.flags.has('wait')) { say(res.id, res); return EXIT_CODES.completed; }
  const code = await waitFor(res.id, 180, io, opts, json, true);
  const r = await call('result', { id: res.id }, opts);
  if (r) io.out(json ? JSON.stringify(r) + '\n' : (r.answer ?? '') + '\n');
  return code;
}

async function pickCmd(io: Io, opts: Opts, say: (h: string, d: unknown) => void, opt: (n: string) => string | undefined): Promise<number> {
  const activity = opt('activity'), dataTier = opt('data'), task = opt('task');
  const okA = !activity || ACTIVITIES.includes(activity as ActivityId), okD = !dataTier || DATA_TIERS.includes(dataTier as DataTier);
  if (!okA || !okD || (!task && (!activity || !dataTier))) { io.err('Give --task, or both --activity and --data, each one of the known values.' + String.fromCharCode(10)); return EXIT_CODES.usage; }
  const fits: Record<string, number> = {};
  for (const part of (opt('fit') ?? '').split(',').filter(Boolean)) {
    const [model, v] = part.split('='), n = Number(v);
    if (!model || !Number.isFinite(n) || n < 0 || n > 1) { io.err('--fit takes model=number pairs with each number from 0 to 1.' + String.fromCharCode(10)); return EXIT_CODES.usage; }
    fits[model] = n;
  }
  const r = await call('pick', { ...(activity ? { activity: activity as ActivityId } : {}), ...(dataTier ? { dataTier: dataTier as DataTier } : {}), ...(task ? { task } : {}),
    ...(opt('named') ? { named: opt('named') as string } : {}), fits, ...(io.env.CLAUDE_CODE_SESSION_ID ? { session: io.env.CLAUDE_CODE_SESSION_ID } : {}) }, opts);
  if ('error' in r) { io.err(r.error + String.fromCharCode(10)); return EXIT_CODES.failed; }
  const lines = r.ranking.map(x => `  ${x.model.padEnd(22)} ${x.score.toFixed(2)}   fit ${x.fit.toFixed(2)} x ${x.level} ${x.weight.toFixed(2)} x usage ${x.usage.toFixed(2)}   routes ${(r.routes[x.model] ?? []).join(', ') || 'none'}`);
  for (const b of r.blocked) lines.push(`  ${b.model.padEnd(22)} --     ${b.why}`);
  const nl = String.fromCharCode(10);
  say(r.pick ? `Pick: ${r.pick}   (${r.activity}, ${r.dataTier} data; scarcity ${r.scarcity}${r.decision ? `; ${r.decision.backend}` : ''})${nl}${lines.join(nl)}` : `No model is permitted ${r.activity} on ${r.dataTier} data.${nl}${lines.join(nl)}`, r);
  return r.pick ? 0 : EXIT_CODES.rejected;
}

async function waitFor(id: string, timeoutS: number | null, io: Io, opts: Opts, json: boolean, quiet = false): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    const j = await call('status', { id }, opts);
    if (!j) { io.err('No such job.\n'); return EXIT_CODES.usage; }
    if (isTerminal(j.state) || j.state === 'needs_approval') {
      if (!quiet) io.out(json ? JSON.stringify(j) + '\n' : describe(j) + '\n');
      return exitCodeForState(j.state);
    }
    if (timeoutS !== null && Date.now() - t0 > timeoutS * 1000) { if (!quiet) io.err(`Still ${j.state} after ${timeoutS}s.\n`); return EXIT_CODES.wait_timeout; }
    await sleep(500);
  }
}

async function logs(id: string, stream: 'stdout' | 'stderr', follow: boolean, io: Io, opts: Opts): Promise<number> {
  let offset = 0;
  for (;;) {
    const page = await call('logs', { id, stream, offset, limit: 262144 }, opts);
    if (!page) { io.err('No such job.\n'); return EXIT_CODES.usage; }
    if (page.text) io.out(page.text);
    offset = page.next;
    if (!follow || page.done) return 0;
    if (!page.text) await sleep(500);
  }
}

/** Starts the service and waits up to 15 seconds for it to answer. Resolves to its ping answer, or null when it did not come up. */
export async function launchService(env: NodeJS.ProcessEnv, opts: Opts): Promise<{ pid: number; version: number; startedAt: number } | null> {
  // With a login entry, systemd or launchd starts it and owns it. A service pointed at other folders is always started here.
  const own = !env.AUGURD_DATA && !env.AUGURD_PIPE && await startViaLogin();
  if (!own) {
    // A packaged install has augurd.mjs beside this file; a source checkout runs the service from its package.
    const here = dirname(fileURLToPath(import.meta.url)), bundled = join(here, 'augurd.mjs'), pkg = join(here, '..', '..', 'augurd');
    const child = existsSync(bundled)
      ? spawn(process.execPath, [bundled], { cwd: here, detached: true, windowsHide: true, stdio: 'ignore', env })
      : spawn(process.execPath, ['--import', 'tsx', join(pkg, 'src', 'main.ts')], { cwd: pkg, detached: true, windowsHide: true, stdio: 'ignore', env });
    child.unref();
  }
  for (let i = 0; i < 60; i++) { await sleep(250); try { return await call('ping', undefined, { ...opts, timeoutMs: 1000 }); } catch { /* not up yet */ } }
  return null;
}

const NOT_INSTALLED = 'augur service enable works from an installed copy of Augur, where augurd.mjs sits next to this command.';

/** Sets the service to start at login, for `augur service enable` and the switch in the terminal app. */
async function enableAtLogin(io: Io): Promise<{ ok: boolean; message: string }> {
  // The entry runs the packaged runtime on the packaged service, so a source checkout has nothing to point it at.
  const script = join(dirname(fileURLToPath(import.meta.url)), 'augurd.mjs');
  if (!existsSync(script)) return { ok: false, message: NOT_INSTALLED };
  return enableLogin({ node: process.execPath, script, path: io.env.PATH ?? '' });
}

/** Stops the service, waits for it to let go of its socket, and starts it again, for the Restart button on the terminal app's service screen. */
async function restartService(io: Io, opts: Opts): Promise<string> {
  const quiet: Io = { ...io, out: () => {}, err: () => {} };
  await service('stop', quiet, opts, false);
  for (let i = 0; i < 20; i++) {
    try { await call('ping', undefined, { ...opts, timeoutMs: 500 }); } catch { break; }
    await sleep(250);
  }
  if (!await launchService(io.env, opts)) throw new Error('The service did not start again. See service.log in its data folder.');
  return 'Restarted. Jobs that were running kept going.';
}

async function service(action: string | undefined, io: Io, opts: Opts, json: boolean, ifIdle = false): Promise<number> {
  const say = (text: string, data: unknown) => io.out(json ? JSON.stringify(data) + '\n' : text + '\n');
  if (action === 'status') {
    const login = loginState(), atLogin = !login.supported ? '.' : login.enabled ? ', and starts at login.' : '. To start it at login, run augur service enable.';
    try { const r = await call('ping', undefined, { ...opts, timeoutMs: 2000 }); say(`augurd is running (pid ${r.pid})${atLogin}`, { running: true, ...r, login }); return 0; }
    catch { say(`augurd is not running${login.supported && login.enabled ? ', but it is set to start at login.' : atLogin}`, { running: false, login }); return EXIT_CODES.failed; }
  }
  if (action === 'enable' || action === 'disable') {
    const r = action === 'disable' ? await disableLogin() : await enableAtLogin(io);
    if (r.message === NOT_INSTALLED) { io.err(r.message + '\n'); return EXIT_CODES.failed; }
    say(r.message, r); return r.ok ? 0 : EXIT_CODES.failed;
  }
  if (action === 'start') {
    try { await call('ping', undefined, { ...opts, timeoutMs: 2000 }); say('augurd is already running.', { running: true }); return 0; } catch { /* start it */ }
    const r = await launchService(io.env, opts);
    if (r) { say(`augurd started (pid ${r.pid}).`, { running: true, ...r }); return 0; }
    io.err('augurd did not come up. See service.log in its data folder.\n'); return EXIT_CODES.failed;
  }
  if (action === 'stop') {
    try {
      const r = await call('ping', undefined, { ...opts, timeoutMs: 2000 });
      if (ifIdle) {
        const busy = (await call('list', { limit: 500 }, opts)).filter(j => !isTerminal(j.state));
        if (busy.length) { say(`${busy.length} job${busy.length === 1 ? ' is' : 's are'} still running. The service was left running.`, { stopping: false, running: busy.length }); return EXIT_CODES.failed; }
      }
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(r.pid), '/F'], { windowsHide: true, stdio: 'ignore' }); else process.kill(r.pid);
      say('Stopping augurd. Running jobs keep going.', { stopping: true }); return 0;
    } catch { say('augurd is not running.', { running: false }); return 0; }
  }
  io.err('Use: augur service status | start | stop | enable | disable\n'); return EXIT_CODES.usage;
}
