// The `augur` command: the canonical caller of the dispatch service. Every command takes --json. Exit codes come from the protocol package.
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVITIES, DATA_TIERS, OUTPUT_MODES } from '@augur/core';
import type { ActivityId, DataTier, OutputMode } from '@augur/core';
import { EXIT_CODES, TOOL_TIERS, exitCodeForState, isTerminal } from '@augur/dispatch-protocol';
import type { JobRecord, JobRequest, ToolTier } from '@augur/dispatch-protocol';
import { ServiceError, call, dataDir } from '@augur/augurd';

export interface Io { out(text: string): void; err(text: string): void; stdin(): string; env: NodeJS.ProcessEnv; cwd: string; /** A person is at the terminal: input and output are both attached to it. */ interactive?: boolean }

const HELP = `augur run <route> --prompt-file <file|-> | --prompt <text> [options]
  --activity <a>     one of: ${ACTIVITIES.join(', ')} (default write_code)
  --data <tier>      ${DATA_TIERS.join(' | ')} (default internal)
  --tools <t>        ${TOOL_TIERS.join(' | ')} (default write)
  --output <o>       ${OUTPUT_MODES.join(' | ')} (default write_files)
  --cwd <dir>        working directory (default: current)
  --expect-file <f>  file the job must leave in the working directory
  --timeout <s>      wall time limit in seconds
  --named            the route was named for this task by the person
  --allow <checks>   skip checks, comma separated: unpicked, exhausted (each use is recorded with the job)
  --wait             wait for the job and print its result
augur jobs [--state <s>] [--root <id>] [--limit <n>]
augur status <job>
augur wait <job> [--timeout <s>]
augur result <job>
augur logs <job> [--stderr] [--follow]
augur cancel <job>
augur apply <job> [--check]
augur pick --activity <a> --data <tier> [--named <model>] [--fit <model>=<0-1>,...]
augur pressure
augur note-prompt --session <id>     tell the service a person sent the message on standard input; it keeps only the models named
augur routes
augur service status | start | stop
Every command takes --json. Exit codes: 0 completed, 1 usage, 2 rejected, 3 needs approval, 4 failed, 5 artifact check failed, 6 cancelled, 7 lost, 124 wait timed out.`;

interface Parsed { cmd: string[]; flags: Map<string, string | true> }
function parse(argv: string[]): Parsed {
  const cmd: string[] = [], flags = new Map<string, string | true>(), boolean = new Set(['json', 'wait', 'named', 'follow', 'stderr', 'help']);
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
      case 'routes': { const r = await call('routes', undefined, opts); say(r.map(x => `${x.name.padEnd(14)} ${x.model.padEnd(16)} ${x.adapter}`).join('\n') || 'No routes.', r); return 0; }
      case 'service': return await service(rest[0], io, opts, json);
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
  const promptText = pf === '-' ? io.stdin() : text;
  const pick = <T extends string>(name: string, list: readonly T[], d: T): T | null => { const v = (opt(name) ?? d) as T; return list.includes(v) ? v : null; };
  const activity = pick('activity', ACTIVITIES, 'write_code'), dataTier = pick('data', DATA_TIERS, 'internal'), tools = pick('tools', TOOL_TIERS, 'write'), output = pick('output', OUTPUT_MODES, 'write_files');
  if (!activity || !dataTier || !tools || !output) { io.err('One of --activity, --data, --tools or --output is not a known value.\n'); return EXIT_CODES.usage; }
  const parentId = io.env.AUGUR_JOB_ID;
  const allow = (opt('allow') ?? '').split(',').map(x => x.trim()).filter(Boolean) as Array<'unpicked' | 'exhausted'>;
  if (allow.some(x => x !== 'unpicked' && x !== 'exhausted')) { io.err('--allow takes unpicked, exhausted, or both.\n'); return EXIT_CODES.usage; }
  const req: JobRequest = {
    route, activity: activity as ActivityId, dataTier: dataTier as DataTier, tools: tools as ToolTier, output: output as OutputMode, cwd: resolve(io.cwd, opt('cwd') ?? '.'),
    prompt: promptText !== undefined ? { text: promptText } : { file: resolve(io.cwd, pf as string) },
    ...(opt('expect-file') ? { expectFile: opt('expect-file') as string } : {}), ...(opt('timeout') ? { timeoutS: Number(opt('timeout')) } : {}),
    ...(p.flags.has('named') ? { named: true } : {}),
    caller: { kind: parentId ? 'job' : 'cli', ...(parentId ? { label: parentId } : {}), ...(io.env.CLAUDE_CODE_SESSION_ID ? { session: io.env.CLAUDE_CODE_SESSION_ID } : {}), ...(io.interactive ? { interactive: true } : {}) },
    ...(allow.length ? { allow } : {}),
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

async function pickCmd(io: Io, opts: Opts, say: (h: string, d: unknown) => void, opt: (n: string) => string | undefined): Promise<number> {
  const activity = opt('activity'), dataTier = opt('data');
  if (!activity || !ACTIVITIES.includes(activity as ActivityId) || !dataTier || !DATA_TIERS.includes(dataTier as DataTier)) { io.err('Give --activity and --data, each one of the known values.\n'); return EXIT_CODES.usage; }
  const fits: Record<string, number> = {};
  for (const part of (opt('fit') ?? '').split(',').filter(Boolean)) {
    const [model, v] = part.split('='), n = Number(v);
    if (!model || !Number.isFinite(n) || n < 0 || n > 1) { io.err('--fit takes model=number pairs with each number from 0 to 1.\n'); return EXIT_CODES.usage; }
    fits[model] = n;
  }
  const r = await call('pick', { activity: activity as ActivityId, dataTier: dataTier as DataTier, ...(opt('named') ? { named: opt('named') as string } : {}), fits, ...(io.env.CLAUDE_CODE_SESSION_ID ? { session: io.env.CLAUDE_CODE_SESSION_ID } : {}) }, opts);
  if ('error' in r) { io.err(`${r.error}\n`); return EXIT_CODES.failed; }
  const lines = r.ranking.map(x => `  ${x.model.padEnd(22)} ${x.score.toFixed(2)}   fit ${x.fit.toFixed(2)} x ${x.level} ${x.weight.toFixed(2)} x usage ${x.usage.toFixed(2)}   routes ${(r.routes[x.model] ?? []).join(', ') || 'none'}`);
  for (const b of r.blocked) lines.push(`  ${b.model.padEnd(22)} --     ${b.why}`);
  say(r.pick ? `Pick: ${r.pick}   (${activity}, ${dataTier} data; scarcity ${r.scarcity})\n${lines.join('\n')}` : `No model is permitted ${activity} on ${dataTier} data.\n${lines.join('\n')}`, r);
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

async function service(action: string | undefined, io: Io, opts: Opts, json: boolean): Promise<number> {
  const say = (text: string, data: unknown) => io.out(json ? JSON.stringify(data) + '\n' : text + '\n');
  if (action === 'status') {
    try { const r = await call('ping', undefined, { ...opts, timeoutMs: 2000 }); say(`augurd is running (pid ${r.pid}).`, { running: true, ...r }); return 0; }
    catch { say('augurd is not running.', { running: false }); return EXIT_CODES.failed; }
  }
  if (action === 'start') {
    try { await call('ping', undefined, { ...opts, timeoutMs: 2000 }); say('augurd is already running.', { running: true }); return 0; } catch { /* start it */ }
    const pkg = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'augurd');
    const child = spawn(process.execPath, ['--import', 'tsx', join(pkg, 'src', 'main.ts')], { cwd: pkg, detached: true, windowsHide: true, stdio: 'ignore', env: io.env });
    child.unref();
    for (let i = 0; i < 60; i++) { await sleep(250); try { const r = await call('ping', undefined, { ...opts, timeoutMs: 1000 }); say(`augurd started (pid ${r.pid}).`, { running: true, ...r }); return 0; } catch { /* not up yet */ } }
    io.err('augurd did not come up. See service.log in its data folder.\n'); return EXIT_CODES.failed;
  }
  if (action === 'stop') {
    try {
      const r = await call('ping', undefined, { ...opts, timeoutMs: 2000 });
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(r.pid), '/F'], { windowsHide: true, stdio: 'ignore' }); else process.kill(r.pid);
      say('Stopping augurd. Running jobs keep going.', { stopping: true }); return 0;
    } catch { say('augurd is not running.', { running: false }); return 0; }
  }
  io.err('Use: augur service status | start | stop\n'); return EXIT_CODES.usage;
}
