// The `augur` command: the canonical caller of the dispatch service. Every command takes --json. Exit codes come from the protocol package.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVITIES, DATA_TIERS, OUTPUT_MODES, feedFor } from '@augur/core';
import type { ActivityId, DataTier, EngineState, OutputMode, ProviderAdded } from '@augur/core';
import { EXIT_CODES, TOOL_TIERS, describeCapabilities, describeFigure, exitCodeForState, isTerminal, renderReport, renderResets, seatLines } from '@augur/dispatch-protocol';
import type { Conversation, Depth, JobRecord, JobRequest, ProseAddParams, ProseStatus, ToolTier } from '@augur/dispatch-protocol';
import { STATUS_TEXT, duration, servedText, statusLine } from '@augur/view-model';
import { bridge, stdioBridge } from './bridge.js';
import { SERVICE_VERSION, ServiceError, call, configLines, dataDir, disableLogin, enableLogin, ensureToken, loadConfig, loginState, rotateWebToken, setConfigValue, startViaLogin, webAddresses, webCertFingerprint } from '@augur/augurd';
import { subagentHook } from './claude-hook.js';
import { KEY_HELP, keyCmd } from './key.js';
import { LOGIN_HELP, loginCmd } from './signin.js';
import { WEB_HELP, webCmd } from './web.js';
import { PROFILE_HELP, profileCmd } from './profile.js';
import { PROVIDER_HELP, providerCmd } from './provider.js';
import { installOf, realFetch, updateAdvice, updateScriptInstall, versionOf } from './update.js';

export interface Io { out(text: string): void; err(text: string): void; stdin(): string; env: NodeJS.ProcessEnv; cwd: string; /** A person is at the terminal: input and output are both attached to it. */ interactive?: boolean; /** Reads one line with no echo, for a key typed at the terminal. */ readSecret?(prompt: string): Promise<string> }

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
  --no-failover      no fallback route at submit and no retry after a failure
  --pack <names>     charter packs, comma separated
  --no-charter       send the prompt with no charter
  --conversation <n> open or resume a named conversation (Grok and Codex routes)
  --attach <file>    send a file with the prompt: text, an image, or audio to transcribe. Repeat for more than one
  --urgent           the job is wanted now, so a local gateway gives it its normal priority instead of the low one background work gets
  --wait             wait for the job, following any retry, and print its result
augur jobs [--state <s>] [--root <id>] [--limit <n>]
augur conversations [--forget <name>]   list named conversations, or forget one
augur status                          one line: Claude's use, anything running hot, and the alert count (--waybar for a status bar's JSON)
augur status <job>
augur wait <job> [--timeout <s>]      reports the last job when the one named was retried
augur result <job>                    prints that job's answer, or the last retry's answer
augur logs <job> [--stderr] [--follow]
augur cancel <job>
augur apply <job> [--check]
augur pick (--task <description> | --activity <a> --data <tier>) [--depth routine|everyday|deep|core] [--named <model>] [--fit <model>=<0-1>,...] [--best] [--snippet]   a route drawn by its odds; --best takes the top score, --snippet marks a one-sentence draft
augur pick-preview (--task <description> | --activity <a> --data <tier>) [--depth routine|everyday|deep|core] [--named <model>] [--fit <model>=<0-1>,...] [--snippet]   every route's score and odds; no draw is made and nothing is recorded
augur pick-answer <pick id> --model <route> [--why <text>]     records the route a person chose for a proposed pick and clears that route for jobs
augur pressure
augur resets [--provider <id>] [--limit <n>]   reset events and summary
augur balance [--days <n>]            where each kind of work goes now, each provider's pace and boost, Copilot's spend and the last days' picks
augur label <pick or job id> --brief met|partly|missed [--note <text>]     record how a job's report met its brief, beside the pick in the decision log
augur label <grade id> --grade agree|high|low [--note <text>]     record whether a grade was right, too high or too low
augur grade <rubric> --task <text|@file> --candidate <text|@file> [--reference <text|@file>] [--tier <tier>]   score a candidate answer on each dimension of a rubric in ~/.augur/rubrics; the grade is recorded and its use follows the rubric's stakes
augur grade --report [<rubric>]       each rubric's labelled grades, agreement, and the mode it has earned
augur prose add (--file <item.json> | --requester <name> --repo <label> --target <path|new> --kind <kind> --surface <surface> --audience <text> --voice <name> [--fact <text>] [--context-file <file>] [--urgency normal|urgent] [--must-include <terms>] [--must-avoid <terms>] [--current-text <text>] [--data <tier>])
augur prose list [--status queued|awaiting-approval|running|drafted|failed]
augur prose status
augur prose run [--dry-run]
augur prose approve <id>
augur usage                             tokens and cost per route, each labelled reported, derived or imputed
augur note-prompt --session <id>     tell the service a person sent the message on standard input; it keeps only the models named
augur routes
augur refresh                         read every provider's usage now
augur alerts [dismiss <id>|--all]     list the alerts, or dismiss one or all of them
augur update [--force]                install the newest version, for a copy the macOS install script put in place
${KEY_HELP}
${LOGIN_HELP}
${WEB_HELP}
${PROFILE_HELP}
${PROVIDER_HELP}
augur claude status | install | remove <code|desktop>     add or take out Augur's part of Claude Code or Claude Desktop
augur claude hook subagent           the plugin's pick-before-subagent hook: reads Claude Code's hook JSON on standard input, adds a note, never blocks
augur test <route> [--wait]          send a fixed one-word prompt through a route to check it works
augur config [--json]                 the service's settings and what each is now
augur config set <setting> <value>    change one; a running service needs augur service stop then start to read it
augur service status | start | stop [--if-idle]     --if-idle stops the service only when no job is running, so an upgrade never cuts one off
augur service enable | disable    start the service at each login (systemd on Linux, launchd on macOS), or stop that
Every command takes --json. Exit codes: 0 completed, 1 usage, 2 rejected, 3 needs approval, 4 failed, 5 artifact check failed, 6 cancelled, 7 lost, 124 wait timed out.`;

interface Parsed { cmd: string[]; flags: Map<string, string | true>; /** Values of the flags that may be given more than once, in order. */ repeated: Map<string, string[]> }
const REPEATABLE = new Set(['attach', 'fact', 'must-include', 'must-avoid']);
export function parse(argv: string[]): Parsed {
  const cmd: string[] = [], flags = new Map<string, string | true>(), repeated = new Map<string, string[]>(), boolean = new Set(['json', 'wait', 'named', 'follow', 'stderr', 'help', 'if-idle', 'no-failover', 'no-charter', 'urgent', 'waybar', 'all', 'force', 'stdin', 'dry-run', 'no-key', 'best', 'snippet', 'report', 'can-land-later']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '-') { cmd.push(a); continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('='), name = a.slice(2, eq < 0 ? undefined : eq);
      if (eq >= 0) flags.set(name, a.slice(eq + 1));
      else if (boolean.has(name)) flags.set(name, true);
      else { const v = argv[++i]; if (v === undefined) throw new Error(`--${name} needs a value`); flags.set(name, v); }
      const last = flags.get(name);
      if (REPEATABLE.has(name) && typeof last === 'string') repeated.set(name, [...(repeated.get(name) ?? []), last]);
    } else cmd.push(a);
  }
  return { cmd, flags, repeated };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const describe = (j: JobRecord) => `${j.id}  ${j.state.padEnd(26)} ${j.route.padEnd(12)} ${new Date(j.createdAt).toISOString().slice(0, 19)}Z${servedText(j.served) ? `  on ${servedText(j.served)}` : ''}${j.startedAt && j.endedAt ? `  ${duration(j)}` : ''}${j.reason ? '  ' + j.reason : ''}`;

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
    await runTui({ launch: () => launchService(io.env, opts), opts, env: io.env, login: { state: loginState, enable: () => enableAtLogin(io), disable: disableLogin }, updateAdvice: updateAdvice(installOf(here()).kind), dispatch: { restart: () => restartService(io, opts) } });
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
      case 'conversations': return await conversationsCmd(p, io, opts, say, opt, json);
      case 'status': {
        if (!rest[0]) return await statusCmd(p.flags.has('waybar'), io, opts, say);
        const j = await call('status', { id: need(rest[0], 'job id') }, opts);
        if (!j) { io.err('No such job.\n'); return EXIT_CODES.usage; }
        say(describe(j), j); return 0;
      }
      case 'wait': return (await waitFor(need(rest[0], 'job id'), opt('timeout') ? Number(opt('timeout')) : null, io, opts, json)).code;
      case 'result': {
        const r = await resultChain(need(rest[0], 'job id'), opts);
        if (!r) { io.err('No such job.\n'); return EXIT_CODES.usage; }
        const body = r.chain.length > 1 ? { job: r.job, answer: r.answer, chain: r.chain, retriedAs: r.job.id } : { job: r.job, answer: r.answer };
        say(`${r.lines.length ? r.lines.join('\n') + '\n' : ''}${r.answer ?? ''}`, body);
        return isTerminal(r.job.state) ? exitCodeForState(r.job.state) : EXIT_CODES.wait_timeout;
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
      case 'grade': {
        if (p.flags.has('report')) {
          const r = await call('grade_report', rest[0] ? { rubric: rest[0] } : undefined, opts);
          if ('error' in r) { io.err(r.error + String.fromCharCode(10)); return EXIT_CODES.failed; }
          const lines = r.rubrics.map(x => `${x.rubric} v${x.version} (${x.stakes} stakes): ${x.mode}; ${x.grades} graded, ${x.labeled} labelled, ${x.agreeShare === null ? 'no agreement yet' : Math.round(x.agreeShare * 100) + '% agree'} (${x.high} too high, ${x.low} too low)${x.next ? `; next: ${x.next}` : ''}`);
          say([...lines, ...r.problems.map(x => `Cannot use: ${x}`)].join(String.fromCharCode(10)) || 'No rubrics in ~/.augur/rubrics.', r); return 0;
        }
        const text = (name: string, required: boolean) => {
          const v = opt(name);
          if (v === undefined) { if (required) throw new ServiceError('usage', `Give --${name}.`); return undefined; }
          if (!v.startsWith('@')) return v;
          try { return readFileSync(resolve(io.cwd, v.slice(1)), 'utf8'); } catch { throw new ServiceError('usage', `Cannot read ${v.slice(1)}.`); }
        };
        const tier = opt('tier');
        if (tier !== undefined && !DATA_TIERS.includes(tier as DataTier)) { io.err(`--tier is one of ${DATA_TIERS.join(', ')}.
`); return EXIT_CODES.usage; }
        const reference = text('reference', false);
        const r = await call('grade', { rubric: need(rest[0], 'rubric'), task: text('task', true) as string, candidate: text('candidate', true) as string, ...(reference ? { reference } : {}), ...(tier ? { tier: tier as DataTier } : {}) }, opts);
        if ('error' in r) { io.err(r.error + String.fromCharCode(10)); return EXIT_CODES.failed; }
        const dims = Object.entries(r.dims).map(([k, d]) => `  ${k.padEnd(20)} ${d.score.toFixed(2)}${d.spread > 0.2 ? `  (orders differ by ${d.spread.toFixed(2)})` : ''}`);
        say([`Grade ${r.id}: overall ${r.overall.toFixed(2)} on ${r.rubric} v${r.version} (${r.tier} tier, ${r.backend}). Mode ${r.mode}${r.verdict ? `, verdict ${r.verdict}` : ''}${r.audit ? ', flagged for a spot check' : ''}.`, ...dims].join(String.fromCharCode(10)), r); return 0;
      }
      case 'prose': {
        const action = rest[0];
        if (action === 'add') {
          let item: unknown;
          if (opt('file')) { try { item = JSON.parse(readFileSync(resolve(io.cwd, opt('file') as string), 'utf8')); } catch { throw new ServiceError('usage', 'Cannot read prose item JSON.'); } }
          else { const facts = p.repeated.get('fact') ?? (opt('fact') ? [opt('fact') as string] : []); let context: Record<string, unknown> = {}; if (opt('context-file')) { try { context = { before: readFileSync(resolve(io.cwd, opt('context-file') as string), 'utf8') }; } catch { throw new ServiceError('usage', 'Cannot read prose context file.'); } } const dataTier = opt('data'); if (dataTier && !DATA_TIERS.includes(dataTier as DataTier)) throw new ServiceError('usage', `--data is one of ${DATA_TIERS.join(', ')}.`); item = { requester: opt('requester'), repo: opt('repo'), target: opt('target'), kind: opt('kind'), surface: opt('surface'), audience: opt('audience'), voice: opt('voice'), urgency: opt('urgency'), currentText: opt('current-text'), dataTier, mustInclude: p.repeated.get('must-include') ?? (opt('must-include') ? [opt('must-include') as string] : []), mustAvoid: p.repeated.get('must-avoid') ?? (opt('must-avoid') ? [opt('must-avoid') as string] : []), facts: facts.map(text => ({ text, source: 'CLI request' })), context }; }
          const r = await call('prose_add', item as ProseAddParams, opts); if ('error' in (r as object)) { io.err(`${(r as { error: string }).error}\n`); return EXIT_CODES.usage; }
          say(`Added prose item ${(r as { id: string }).id}.`, r); return 0;
        }
        if (action === 'list') { const filter = opt('status'); if (filter && !['queued', 'awaiting-approval', 'running', 'drafted', 'failed'].includes(filter)) throw new ServiceError('usage', 'Unknown prose status filter.'); const r = await call('prose_list', filter ? { status: filter as ProseStatus } : undefined, opts); say((r as Array<{ id: string; status: string; repo: string; target: string }>).map(x => `${x.id}  ${x.status}  ${x.repo}  ${x.target}`).join('\n') || 'No prose items.', r); return 0; }
        if (action === 'status') { const r = await call('prose_status', undefined, opts); const x = r as { counts: Record<string, number>; oldestAgeMs: number | null; due: boolean }; say(`${Object.entries(x.counts).map(([k, v]) => `${k}: ${v}`).join(', ')}; oldest ${x.oldestAgeMs === null ? 'none' : `${Math.floor(x.oldestAgeMs / 3600000)}h`}; ${x.due ? 'run due' : 'not due'}.`, r); return 0; }
        if (action === 'run') { const r = await call('prose_run', { dryRun: p.flags.has('dry-run'), caller: { kind: 'cli', label: 'prose-queue', ...(io.interactive ? { interactive: true } : {}) } }, opts); const x = r as { started?: boolean; batchId?: string; reason?: string }; say(x.started ? `Started prose batch ${x.batchId ?? ''}.` : x.reason ?? 'No prose batch started.', r); return 0; }
        if (action === 'approve') { const r = await call('prose_approve', { id: need(rest[1], 'prose item id') }, opts); if ('error' in (r as object)) { io.err(`${(r as { error: string }).error}\n`); return EXIT_CODES.usage; } say(`Approved ${(r as { id: string }).id}.`, r); return 0; }
        throw new ServiceError('usage', 'Use augur prose add, list, status, run or approve.');
      }
      case 'pick': return await pickCmd(io, opts, say, opt, n => p.flags.has(n));
      case 'pick-preview': return await pickCmd(io, opts, say, opt, n => p.flags.has(n), true);
      case 'resets': {
        const limit = opt('limit') === undefined ? undefined : Number(opt('limit'));
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new ServiceError('usage', 'Limit must be a positive integer.');
        const r = await call('resets', { ...(opt('provider') !== undefined ? { provider: opt('provider') } : {}), ...(limit !== undefined ? { limit } : {}) }, opts);
        say(renderResets(r).join('\n'), r); return 0;
      }
      case 'balance': {
        const r = await call('balance', opt('days') ? { days: Number(opt('days')) } : undefined, opts);
        if ('error' in r) { io.err(r.error + String.fromCharCode(10)); return EXIT_CODES.failed; }
        say(renderReport(r).join(String.fromCharCode(10)), r); return 0;
      }
      case 'label': {
        if (opt('grade')) {
          const r = await call('grade_label', { id: need(rest[0], 'grade id'), label: opt('grade') as 'agree', ...(opt('note') ? { note: opt('note') as string } : {}) }, opts);
          if ('error' in r) { io.err(r.error + String.fromCharCode(10)); return EXIT_CODES.failed; }
          say(`Recorded: the grade was ${opt('grade')}. Rubric ${r.rubric} is in ${r.mode} mode.`, r); return 0;
        }
        const result = opt('brief');
        if (result !== 'met' && result !== 'partly' && result !== 'missed') { io.err('Give --brief met, partly or missed.' + String.fromCharCode(10)); return EXIT_CODES.usage; }
        const r = await call('label', { id: need(rest[0], 'pick or job id'), result, ...(opt('note') ? { note: opt('note') as string } : {}) }, opts);
        if ('error' in r) { io.err(r.error + String.fromCharCode(10)); return EXIT_CODES.failed; }
        say(`Recorded: the brief was ${result} for pick ${r.pick}${r.job ? `, job ${r.job}` : ''}.`, r); return 0;
      }
      case 'pick-answer': {
        const r = await call('pick_answer', { id: need(rest[0], 'pick id'), model: need(opt('model'), '--model'), ...(opt('why') ? { why: opt('why') as string } : {}) }, opts);
        if ('error' in r) { io.err(r.error + String.fromCharCode(10)); return EXIT_CODES.failed; }
        say(`Recorded: ${r.agreed ? 'the proposal stood' : 'the person chose another route'} for ${r.key}. ${r.agreedOf} of the last ${r.n} answers for it agreed.`, r); return 0;
      }
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
      case 'update': return await updateCmd(p.flags.has('force'), io, opts, say);
      case 'refresh': { await engineCall('refresh', [true], io, opts); say(STATUS_TEXT.refreshed, { ok: true }); return 0; }
      case 'alerts': return await alertsCmd(rest, p.flags.has('all'), io, opts, say);
      case 'profile': return await profileCmd(rest, { dryRun: p.flags.has('dry-run') }, { err: io.err, env: io.env, cwd: io.cwd }, say, new Date(), { addProvider: i => engineCall('addProvider', [i], io, opts) as Promise<ProviderAdded> });
      case 'provider': return await providerCmd(rest, { text: new Map([...p.flags].filter((e): e is [string, string] => typeof e[1] === 'string')), stdin: p.flags.has('stdin'), noKey: p.flags.has('no-key'), dryRun: p.flags.has('dry-run') },
        { ...io, out: io.out }, say, { addProvider: i => engineCall('addProvider', [i], io, opts) as Promise<ProviderAdded>, setProviderKey: (pv, field, value) => engineCall('setProviderKey', [pv, field, value], io, opts).then(() => undefined) });
      case 'key': return await keyCmd(rest, { ...(opt('env') ? { env: opt('env') as string } : {}), stdin: p.flags.has('stdin') }, io, say);
      case 'login': case 'logout': return await loginCmd(rest, { stdin: p.flags.has('stdin') }, io, say, { call: (m, a) => engineCall(m, a, io, opts), sleep, now: () => Date.now() }, cmd === 'logout');
      case 'web': {
        const settings = loadConfig(opts.dir).web;
        return webCmd(rest, say, { settings, token: () => ensureToken(opts.dir, 'web-token'), rotate: () => rotateWebToken(opts.dir), addresses: () => webAddresses(settings), fingerprint: () => webCertFingerprint(opts.dir) }, io.err);
      }
      case 'claude': return await claudeCmd(rest, io, opts, say);
      case 'routes': { const r = await call('routes', undefined, opts); say(r.map(x => `${x.name.padEnd(14)} ${x.model.padEnd(16)} ${x.adapter}   ${describeCapabilities(x.capabilities)}${x.problem ? `   cannot run: ${x.problem}` : ''}`).join('\n') || 'No routes.', r); return 0; }
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

type Say = (human: string, data: unknown) => void;

/** The folder this command's own files sit in. */
const here = (): string => dirname(fileURLToPath(import.meta.url));

async function updateCmd(force: boolean, io: Io, opts: Opts, say: Say): Promise<number> {
  const install = installOf(here());
  const current = versionOf(install.dir) ?? SERVICE_VERSION;
  const r = await updateScriptInstall(install, {
    current, platform: process.platform, env: io.env, ...realFetch,
    afterSwap: (dir) => afterUpdate(dir, io, opts),
  }, force);
  if (r.ok) say(r.message, r); else io.err(r.message + '\n');
  return r.ok ? 0 : EXIT_CODES.failed;
}

/** Moves the login entry to the new version, or stops an idle service so the next start uses it. A busy service keeps running the old one. */
async function afterUpdate(newDir: string, io: Io, opts: Opts): Promise<string> {
  const run = (args: string[]) => spawnSync(join(newDir, 'augur'), args, { encoding: 'utf8', env: io.env });
  const login = loginState();
  if (login.supported && login.enabled) return run(['service', 'enable']).status === 0 ? 'The service runs the new version.' : 'Run augur service enable to move the start at login to the new version.';
  const running = await call('ping', undefined, { ...opts, timeoutMs: 1000 }).then(() => true, () => false);
  if (!running) return '';
  return run(['service', 'stop', '--if-idle']).status === 0 ? 'The service starts the new version the next time it is needed.' : 'Jobs are still running, so the service keeps the old version until you run augur service stop and start it again.';
}

/** Returns null when no service is running. It does not start one, because a status bar polls this. */
async function engineState(opts: Opts): Promise<EngineState | null> {
  try { return (await call('engine_state', undefined, opts)).state as EngineState; }
  catch (e) { if (e instanceof ServiceError && (e.code === 'unreachable' || e.code === 'no_token')) return null; throw e; }
}

/** A command that changes the engine. The service is started first when it is not running. */
async function engineCall(method: string, args: unknown[], io: Io, opts: Opts): Promise<unknown> {
  const up = await call('ping', undefined, { ...opts, timeoutMs: 1000 }).then(() => true, () => false);
  if (!up && !await launchService(io.env, opts)) throw new Error('The service did not start. See service.log in its data folder.');
  try { return await call('engine_call', { method, args }, opts); }
  catch (e) {
    // A service started before an update does not know the newer commands.
    if (/^Unknown engine command/.test((e as Error).message)) throw new Error(`The running service is older than this command and does not know ${method}. Run augur service stop, then try again; the service starts its new version on the next call.`);
    throw e;
  }
}

async function statusCmd(waybar: boolean, io: Io, opts: Opts, say: Say): Promise<number> {
  const s = await engineState(opts);
  if (!s) {
    if (waybar) { io.out(JSON.stringify({ text: 'Augur off', tooltip: STATUS_TEXT.noService, class: 'off' }) + '\n'); return 0; }
    io.err(STATUS_TEXT.noService + '\n'); return EXIT_CODES.failed;
  }
  const line = statusLine(s.config, s.snapshot, feedFor(s.feed, 'augur'), Date.now());
  if (waybar) io.out(JSON.stringify({ text: line.text, tooltip: line.tooltip, class: line.level }) + '\n');
  else say(line.text, line);
  return 0;
}

async function alertsCmd(rest: string[], all: boolean, io: Io, opts: Opts, say: Say): Promise<number> {
  const s = await engineState(opts);
  if (!s) { io.err(STATUS_TEXT.noService + '\n'); return EXIT_CODES.failed; }
  const list = [...feedFor(s.feed, 'augur')].sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));
  if (rest[0] !== 'dismiss') {
    say(list.map(a => `${a.id.padEnd(28)} ${a.severity.padEnd(5)} ${a.title}`).join('\n') || STATUS_TEXT.noAlerts, list); return 0;
  }
  const ids = all ? list.map(a => a.id) : list.filter(a => a.id === rest[1]).map(a => a.id);
  if (!all) need(rest[1], 'alert id');
  if (!ids.length) { io.err(STATUS_TEXT.dismissNone + '\n'); return EXIT_CODES.usage; }
  await engineCall('dismiss', [ids], io, opts);
  say(STATUS_TEXT.dismissed(ids.length), { dismissed: ids }); return 0;
}

async function claudeCmd(rest: string[], io: Io, opts: Opts, say: Say): Promise<number> {
  const [action, target] = rest;
  if (action === 'hook' && target === 'subagent') {
    // Claude Code reads this command's output as JSON, so nothing else is ever printed and the exit code is always 0.
    io.out(await subagentHook(io.stdin(), io.env, {
      balance: async () => { const r = await call('balance', undefined, opts); return 'error' in r ? null : { stance: r.claude.stance, lean: r.claude.lean }; },
      pick: async (task, session) => { const r = await call('pick', { task, fits: {}, ...(session ? { session } : {}) }, opts); return 'error' in r ? null : { pick: r.pick, reason: r.reason, routes: r.pick ? r.routes[r.pick] ?? [] : [] }; },
    }));
    return EXIT_CODES.completed;
  }
  if (action === 'status') {
    const c = (await engineState(opts))?.claude ?? null;
    if (!c) { io.err(STATUS_TEXT.noService + '\n'); return EXIT_CODES.failed; }
    say(`Claude Code: ${c.code ? `installed (version ${c.code})` : 'not installed'}\nClaude Desktop: ${c.desktopPossible ? (c.desktop ? 'installed' : 'not installed') : 'not found on this computer'}`, c); return 0;
  }
  if ((action !== 'install' && action !== 'remove') || (target !== 'code' && target !== 'desktop')) { io.err('Use augur claude status, or augur claude install|remove code|desktop.\n'); return EXIT_CODES.usage; }
  await engineCall('setClaude', [target, action === 'install'], io, opts);
  const s = await engineState(opts);
  if (s?.claudeError) { io.err(s.claudeError + '\n'); return EXIT_CODES.failed; }
  say(`Claude ${target === 'code' ? 'Code' : 'Desktop'}: ${action === 'install' ? 'installed' : 'removed'}.`, { target, installed: action === 'install' }); return 0;
}

function need(v: string | undefined, what: string): string { if (!v) throw new Error(`Missing ${what}.`); return v; }

async function conversationsCmd(p: Parsed, io: Io, opts: Opts, say: (h: string, d: unknown) => void, opt: (n: string) => string | undefined, json: boolean): Promise<number> {
  const name = opt('forget');
  if (name) {
    const r = await call('forget_conversation', { name }, opts);
    if (!r.forgotten) { io.err(`${r.reason ?? `No conversation named ${name}.`}\n`); if (json) io.out(JSON.stringify(r) + '\n'); return EXIT_CODES.usage; }
    say(`Forgot conversation ${name}.`, r); return 0;
  }
  const list = await call('conversations', undefined, opts);
  say(list.map(conversationLine).join('\n') || 'No conversations.', list); return 0;
}

const conversationLine = (c: Conversation) => `${c.name}  ${c.route}  ${c.adapter}  ${c.turns}  ${new Date(c.lastUsedAt).toISOString().slice(0, 19)}Z`;
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
  const packs = opt('pack')?.split(',').map(s => s.trim()).filter(Boolean);
  // An attachment path is relative to where the person is standing, so it is made absolute here.
  const attach = (p.repeated.get('attach') ?? []).map(f => resolve(io.cwd, f));
  const req: JobRequest = {
    route, activity: activity as ActivityId, dataTier: dataTier as DataTier, tools: tools as ToolTier, output: output as OutputMode, cwd: resolve(io.cwd, opt('cwd') ?? '.'),
    prompt: { text: promptText as string },
    ...(opt('expect-file') ? { expectFile: opt('expect-file') as string } : {}), ...(opt('timeout') ? { timeoutS: Number(opt('timeout')) } : {}),
    ...(p.flags.has('named') ? { named: true } : {}), ...(attach.length ? { attach } : {}), ...(p.flags.has('urgent') ? { urgent: true } : {}),
    caller: { kind: parentId ? 'job' : 'cli', ...(parentId ? { label: parentId } : {}), ...(io.env.CLAUDE_CODE_SESSION_ID ? { session: io.env.CLAUDE_CODE_SESSION_ID } : {}), ...(io.interactive ? { interactive: true } : {}) },
    ...(allow.length ? { allow } : {}), ...(p.flags.has('no-failover') ? { failover: false } : {}),
    ...(packs?.length ? { packs } : {}), ...(p.flags.has('no-charter') ? { noCharter: true } : {}), ...(opt('conversation') ? { conversation: opt('conversation') } : {}),
    ...(parentId ? { parent: { jobId: parentId, rootJobId: io.env.AUGUR_ROOT_JOB_ID ?? parentId, depth: 0 } } : {}),
  };
  const res = await call('submit', req, opts);
  if ('rejected' in res) { io.err(`Rejected (${res.rejected.code}): ${res.rejected.reason}\n`); if (json) io.out(JSON.stringify(res) + '\n'); return EXIT_CODES.rejected; }
  for (const w of res.warnings) io.err(`Warning: ${w}\n`);
  if (!p.flags.has('wait')) { say(res.id, res); return EXIT_CODES.completed; }
  const w = await waitFor(res.id, req.timeoutS ? req.timeoutS + 60 : null, io, opts, json, true);
  const r = await call('result', { id: w.id }, opts);
  if (r) io.out(json ? JSON.stringify(w.chain.length > 1 ? { ...r, chain: w.chain, retriedAs: w.id } : r) + '\n' : (r.answer ?? '') + (r.answer?.endsWith('\n') ? '' : '\n'));
  return w.code;
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
  const w = await waitFor(res.id, 180, io, opts, json, true);
  const r = await call('result', { id: w.id }, opts);
  if (r) io.out(json ? JSON.stringify(w.chain.length > 1 ? { ...r, chain: w.chain, retriedAs: w.id } : r) + '\n' : (r.answer ?? '') + '\n');
  return w.code;
}

async function pickCmd(io: Io, opts: Opts, say: (h: string, d: unknown) => void, opt: (n: string) => string | undefined, flag: (n: string) => boolean, preview = false): Promise<number> {
  const activity = opt('activity'), dataTier = opt('data'), task = opt('task');
  const okA = !activity || ACTIVITIES.includes(activity as ActivityId), okD = !dataTier || DATA_TIERS.includes(dataTier as DataTier);
  if (!okA || !okD || (!task && (!activity || !dataTier))) { io.err('Give --task, or both --activity and --data, each one of the known values.' + String.fromCharCode(10)); return EXIT_CODES.usage; }
  const depth = opt('depth');
  if (depth && !['routine', 'everyday', 'deep', 'core'].includes(depth)) { io.err('--depth is routine, everyday, deep, or core.' + String.fromCharCode(10)); return EXIT_CODES.usage; }
  const fits: Record<string, number> = {};
  for (const part of (opt('fit') ?? '').split(',').filter(Boolean)) {
    const [model, v] = part.split('='), n = Number(v);
    if (!model || !Number.isFinite(n) || n < 0 || n > 1) { io.err('--fit takes model=number pairs with each number from 0 to 1.' + String.fromCharCode(10)); return EXIT_CODES.usage; }
    fits[model] = n;
  }
  const r = await call('pick', { ...(activity ? { activity: activity as ActivityId } : {}), ...(dataTier ? { dataTier: dataTier as DataTier } : {}), ...(task ? { task } : {}),
    ...(opt('named') ? { named: opt('named') as string } : {}), ...(depth ? { depth: depth as Depth } : {}), fits, ...(flag('best') ? { best: true } : {}), ...(flag('snippet') ? { snippet: true } : {}), ...(preview ? { preview: true } : {}), ...(io.env.CLAUDE_CODE_SESSION_ID ? { session: io.env.CLAUDE_CODE_SESSION_ID } : {}) }, opts);
  if ('error' in r) { io.err(r.error + String.fromCharCode(10)); return EXIT_CODES.failed; }
  const lines = r.ranking.map(x => `  ${x.model.padEnd(22)} ${x.score.toFixed(2)}   fit ${x.fit.toFixed(2)} x ${x.level} ${x.weight.toFixed(2)} x usage ${x.usage.toFixed(2)}   odds ${Math.round((x.odds ?? 0) * 100)}%   routes ${(r.routes[x.model] ?? []).join(', ') || 'none'}`);
  for (const b of r.blocked) lines.push(`  ${b.model.padEnd(22)} --     ${b.why}`);
  const nl = String.fromCharCode(10);
  const note = preview ? `${nl}preview: no draw made` : '';
  const ask = r.proposal && r.proposal.mode !== 'auto' ? `${nl}Proposal ${r.pickId ?? ''}: ${r.proposal.reason}. No job can run on this pick yet. Ask the person which route to use, then record it with augur pick-answer <pick id> --model <route>.` : '';
  say(r.pick ? `Pick: ${r.pick}   (${r.activity}, ${r.dataTier} data; scarcity ${r.scarcity}${r.decision ? `; ${r.decision.backend}` : ''})${note}${ask}${nl}${[r.reason, ...seatLines(r.seats)].join(nl)}${nl}${lines.join(nl)}` : `No model is permitted ${r.activity} on ${r.dataTier} data.${note}${nl}${lines.join(nl)}`, r);
  return r.pick ? 0 : EXIT_CODES.rejected;
}

async function waitFor(id: string, timeoutS: number | null, io: Io, opts: Opts, json: boolean, quiet = false): Promise<{ code: number; id: string; chain: string[] }> {
  const t0 = Date.now();
  const chain = [id];
  let current = id;
  for (;;) {
    const j = await call('status', { id: current }, opts);
    if (!j) { io.err('No such job.\n'); return { code: EXIT_CODES.usage, id: current, chain }; }
    if (isTerminal(j.state) && j.retriedAs && !chain.includes(j.retriedAs) && chain.length < 8) {
      const next = await call('status', { id: j.retriedAs }, opts);
      if (next) {
        if (!json) io.out(`retried on ${next.route} as ${next.id}\n`);
        chain.push(next.id);
        current = next.id;
        continue;
      }
    }
    if (isTerminal(j.state) || j.state === 'needs_approval') {
      if (!quiet) io.out(json ? JSON.stringify(chain.length > 1 ? { ...j, chain } : j) + '\n' : describe(j) + '\n');
      return { code: exitCodeForState(j.state), id: current, chain };
    }
    if (timeoutS !== null && Date.now() - t0 > timeoutS * 1000) { if (!quiet) io.err(`Still ${j.state} after ${timeoutS}s.\n`); return { code: EXIT_CODES.wait_timeout, id: current, chain }; }
    await sleep(500);
  }
}

/** The job named, or the last one that replaced it once each earlier job has finished. */
async function resultChain(id: string, opts: Opts): Promise<{ job: JobRecord; answer: string | null; chain: string[]; lines: string[] } | null> {
  const chain = [id];
  const lines: string[] = [];
  const first = await call('result', { id }, opts);
  if (!first) return null;
  let job = first.job, answer = first.answer;
  for (;;) {
    const nextId = isTerminal(job.state) ? job.retriedAs : undefined;
    if (!nextId || chain.includes(nextId) || chain.length >= 8) break;
    const next = await call('result', { id: nextId }, opts);
    if (!next) break;
    lines.push(`retried on ${next.job.route} as ${next.job.id}`);
    chain.push(next.job.id);
    job = next.job;
    answer = next.answer;
  }
  return { job, answer, chain, lines };
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
  const up = await call('ping', undefined, { ...opts, timeoutMs: 1000 }).then(() => true, () => false);
  if (!up && !await launchService(io.env, opts)) throw new Error('The service did not start again. See service.log in its data folder.');
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
