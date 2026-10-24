// Accepts jobs, applies the rules, launches one runner per job and keeps the store true to what the runners leave on disk.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ACTIVITIES, DATA_TIERS, OUTPUT_MODES } from '@augur/core';
import type { PolicyFile } from '@augur/core';
import { BRIEF_RESULTS, GRADE_LABELS, STUDENT_RE, classifyDepth, classifyTask, decide as decideGrade, fitScores, grade as gradeText, gradeStats, gradeTier } from '@augur/decision';
import type { BriefResult, DecisionBackend, GradeVerdictLabel } from '@augur/decision';
import { BUDGET_WINDOW_MS, NAMED_PROMPT_WINDOW, PICK_WINDOW_MIN, TOOL_TIERS, account, agreement, attachmentKind, balanceReport, budgetStatus, calibrateRoutes, copilotSpend, checkLineage, routeSecretName, checkNamed, checkPick, evaluate, isTerminal, learnedShares, learnedTilt, lookup, matchNamedModels, pressure, propose, rank, resolveBalance, trainingKey, usageFactors } from '@augur/dispatch-protocol';
import type { Adapter, BalanceReport, BudgetStatus, Conversation, Depth, GradeAnswer, GradeParams, GradeReport, JobRecord, JobRequest, LaunchPlan, PickAnswer, PickParams, RateCard, Rejection, ResolvedAttachment, RouteCapabilities, RouteConfig, UsageSnapshot } from '@augur/dispatch-protocol';
import { MAX_COMMAND_LINE, optNum, optStr } from './adapters/util.js';
import { realInside, realInsideAny, realOf } from './real-paths.js';
import type { ServiceConfig } from './config.js';
import { buildEnv } from './env.js';
import type { Store } from './store.js';
import type { DecisionLog } from './decisions.js';
import { buildCharter, resolveAmbient, resolveCharterDir } from './charter.js';
import { loadToolkits } from './toolkits.js';
import { MAX_HOPS, classifyFailure } from './failover.js';
import { augurHome, scriptPath } from './paths.js';
import { hasStoredKey } from './secrets.js';
import { RubricStore } from './rubrics.js';

export interface SupervisorDeps {
  store: Store; config: ServiceConfig; dir: string; adapters: Map<string, Adapter>;
  /** Augur home. The charter folder is `<home>/charter` unless `runner.charterDir` is set. */
  home?: string;
  routes: () => Record<string, RouteConfig> | null; policy: () => PolicyFile | null; usage: () => UsageSnapshot | null;
  /** Answers the typed questions behind a pick by task description. `local` is a backend that runs on this network, for text about students. */
  decision?: { primary: DecisionBackend; local?: DecisionBackend };
  /** Where picks and their outcomes are recorded for training. */
  decisions?: DecisionLog;
  runnerPath?: string; now?: () => number; env?: NodeJS.ProcessEnv;
  /** The owner's rate card, read when a budget is checked. */
  rates?: () => RateCard;
  /** Whether each job runs in its own systemd user scope. Defaults to asking systemd once; tests stand in for it. */
  scopes?: () => boolean;
  /** Why jobs are refused right now (Augur set to usage only), or null when they run. */
  jobsOff?: () => string | null;
}

let scopeProbe: boolean | undefined;
/** Whether systemd can give a job its own user scope here, so cancelling it also ends processes that left its process group. Asked once. */
export function systemdScopes(): boolean {
  scopeProbe ??= process.platform === 'linux'
    && spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', 'true'], { stdio: 'ignore', timeout: 10000 }).status === 0;
  return scopeProbe;
}

export type SubmitResult = { id: string; warnings: string[] } | { rejected: Rejection };

const readJson = <T>(path: string): T | null => { try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; } };
const alive = (pid: number | null | undefined): boolean => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const reject = (code: Rejection['code'], reason: string): SubmitResult => ({ rejected: { code, reason } });
const COPY_EXCLUDE = new Set(['.git', 'node_modules', '.venv']);
/** Files that usually hold secrets stay out of the copy a patch-only job works on. The copy limits what a job can change, and this keeps the obvious credentials out of its view too. */
const SECRET_FILE = /^(\.env(\..*)?|id_(rsa|dsa|ecdsa|ed25519)|\.npmrc|\.pypirc|\.netrc|.*\.(pem|key|p12|pfx))$/i;
/** The most a job's working directory may hold when it is copied for a sandbox. The copy runs on the service's own thread, so a larger folder is refused up front rather than freezing every other request. */
export const COPY_MAX_FILES = 20000;
export const COPY_MAX_BYTES = 512 * 1024 * 1024;
/** A filter for one copy: it leaves out secrets and build folders, skips links and junctions (a loop would never end), and stops the copy when it passes the caps. */
export const copyFilterWithCaps = (maxFiles = COPY_MAX_FILES, maxBytes = COPY_MAX_BYTES): ((src: string) => boolean) => {
  let files = 0, bytes = 0;
  return (src: string): boolean => {
    const name = basename(src);
    if (COPY_EXCLUDE.has(name) || SECRET_FILE.test(name)) return false;
    let st; try { st = lstatSync(src); } catch { return false; }
    if (st.isSymbolicLink()) return false;
    if (st.isFile()) {
      files += 1; bytes += st.size;
      if (files > maxFiles) throw new Error(`the working directory holds more than ${maxFiles} files; pass a smaller cwd with only what the job needs`);
      if (bytes > maxBytes) throw new Error(`the working directory holds more than ${Math.round(maxBytes / 1024 / 1024)} MB; pass a smaller cwd with only what the job needs`);
    }
    return true;
  };
};
const GIT = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false'];
const CONVERSATION_NAME = /^[A-Za-z0-9._-]{1,64}$/;

interface RunnerResult { exitCode: number | null; signal?: string | null; killedBy: 'cancel' | 'timeout' | null; endedAt: number; spawnError?: string }
interface JobFile { command: string; args: string[]; cwd: string; stdin: 'prompt' | 'none'; timeoutS: number | null; jobhost: string | null; env: Record<string, string>;
  files: NonNullable<LaunchPlan['files']>; promptArgs: number[]; redact: boolean; scope?: string | null; scopeEnv?: Record<string, string> }

/** What systemd-run and systemctl need to reach the user's systemd. A job's own environment leaves these out, so the runner is handed them. */
export const SCOPE_ENV = ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'] as const;

const MAX_ATTACHMENTS = 16;
/** A route's size cap for one kind of attachment, in megabytes. */
const optMb = (route: RouteConfig, key: string, fallback: number): number => optNum(route.options, key) ?? fallback;

export class Supervisor {
  private adopted = new Set<string>();
  private outputSeen = new Set<string>();
  /** The request and the routes already used for each job this process launched. A restart drops the map, and then that job is not retried. */
  private readonly submitted = new Map<string, { req: JobRequest; hops: string[] }>();
  private readonly now: () => number;
  private readonly runner: string;
  constructor(private d: SupervisorDeps) {
    this.now = d.now ?? Date.now;
    this.runner = d.runnerPath ?? scriptPath(import.meta.url, 'runner');
    mkdirSync(join(d.dir, 'jobs'), { recursive: true });
  }

  jobDir(id: string): string { return join(this.d.dir, 'jobs', id); }

  /** Adapter ids this service can run. */
  knownAdapters(): readonly string[] { return [...this.d.adapters.keys()]; }

  // ------------------------------------------------------------------ submit

  /** Why a route cannot start a job right now, in the words a job would be refused with, or null when it can. */
  /** Why a route cannot run, or null. `name` is the route's name in routes.json; a route whose key is kept in the key store needs it to look the key up. */
  routeProblem(route: RouteConfig, name?: string): string | null {
    const adapter = this.d.adapters.get(route.adapter);
    if (!adapter) return `Adapter ${route.adapter} is not enabled.`;
    return adapter.validate(route) ?? this.keyProblem(route, name);
  }

  /** What the route takes, from its adapter and options. A route whose adapter is not enabled takes nothing. */
  routeCapabilities(route: RouteConfig): RouteCapabilities {
    const attachments = this.d.adapters.get(route.adapter)?.attachmentKinds?.(route) ?? [];
    const mode = optStr(route.options, 'mode');
    const embed = mode === 'embeddings', maxInput = optNum(route.options, 'maxInput');
    const dimensions = optNum(route.options, 'dimensions');
    return {
      attachments, vision: attachments.includes('image'), embed, transcribe: attachments.includes('audio'), ...(mode === 'moderation' ? { moderate: true } : {}),
      ...(attachments.includes('image') ? { maxImageMb: optMb(route, 'maxImageMb', 10) } : {}),
      ...(attachments.includes('audio') ? { maxAudioMb: optMb(route, 'maxAudioMb', 25) } : {}),
      ...(maxInput !== undefined ? { maxInput } : {}),
      ...(embed ? { embedding: { model: optStr(route.options, 'model') ?? route.model, ...(dimensions !== undefined ? { dimensions } : {}) } } : {}),
    };
  }

  private keyProblem(route: RouteConfig, name?: string): string | null {
    if (route.options?.keySource !== 'store' || !name) return null;
    return hasStoredKey(routeSecretName(name)) ? null : 'No key is stored for this route. Add it on the Routes page.';
  }

  /** Rejections that may pass, or that another route can get around. Only these send a job to a fallback route. */
  private static readonly FAILOVER = new Set(['budget_exhausted', 'model_paused', 'pace_denied', 'quota_denied', 'adapter_unavailable', 'prompt_too_large', 'attachment_rejected']);

  /** What a route has used in its budget window and whether a new job would be refused; null when the route has no budget. */
  budget(name: string, route: RouteConfig): BudgetStatus | null {
    if (!route.budget) return null;
    const jobs = this.d.store.since(name, this.now() - BUDGET_WINDOW_MS[route.budget.per]), rates = this.d.rates?.() ?? {}, calibration = calibrateRoutes(this.d.store.list({ limit: 500 }))[name];
    return budgetStatus(name, route.budget, jobs.map(j => account(j, route.model, rates, calibration)));
  }

  /**
   * Submits to the route named. When that route cannot take the job for a reason that may pass, each fallback route is tried in order, and every one is
   * checked against every rule as if it had been asked for, so a fallback never gets around a data tier, a pick or a pause. `failover: false` keeps the job put.
   */
  submit(input: JobRequest): SubmitResult {
    const off = this.d.jobsOff?.() ?? null;
    if (off) return reject('jobs_off', off);
    const first = this.submitTo(input);
    // A named conversation stays on the route it was opened on, including when that route refuses the job.
    if (!('rejected' in first) || input.failover === false || input.conversation || !Supervisor.FAILOVER.has(first.rejected.code)) return first;
    for (const next of this.d.routes()?.[input.route]?.fallback ?? []) {
      if (next === input.route) continue;
      const r = this.submitTo({ ...input, route: next });
      if ('rejected' in r) continue;
      const note = `${input.route} could not take the job (${first.rejected.reason}), so ${next} did.`;
      this.d.store.event(r.id, 'failover', `${input.route} to ${next}: ${first.rejected.code}`, this.now());
      return { ...r, warnings: [note, ...r.warnings] };
    }
    return first;
  }

  private submitTo(input: JobRequest, chain?: { req: JobRequest; hops: string[] }): SubmitResult {
    let req = input;
    const bad = this.validate(req);
    if (bad) return reject('bad_request', bad);
    const routes = this.d.routes();
    const route = routes?.[req.route];
    if (!route) return reject('unknown_route', `Route ${req.route} is not in routes.json.`);
    const adapter = this.d.adapters.get(route.adapter);
    if (!adapter) return reject('adapter_unavailable', `Adapter ${route.adapter} is not enabled.`);
    const invalid = this.routeProblem(route, req.route);
    if (invalid) return reject('adapter_unavailable', `Route ${req.route}: ${invalid}`);
    const conv = this.conversationPlan(req, adapter);
    if ('rejected' in conv) return conv;

    let root: string | null = null, parentId: string | null = null, depth = 0;
    if (req.parent) {
      const parent = this.d.store.get(req.parent.jobId);
      if (!parent || isTerminal(parent.state)) return reject('delegation_not_granted', 'The parent job is not running.');
      root = parent.rootJobId; parentId = parent.id; depth = parent.depth + 1;
      const lineage = checkLineage({ ...req, parent: { jobId: parent.id, rootJobId: parent.rootJobId, depth: parent.depth } }, routes?.[parent.route] ?? null,
        this.d.store.countDescendants(parent.rootJobId), { maxDepth: this.d.config.maxDepth, maxDescendants: this.d.config.maxDescendants });
      if (lineage) return { rejected: lineage };
    }

    const named = this.confirmNamed(req, route.model);
    if ('rejected' in named) return named;
    if (named.note) req = { ...req, named: named.value };
    const decision = evaluate(req, { policy: this.d.policy(), usage: this.d.usage(), route, capabilities: adapter.capabilities, now: new Date(this.now()) });
    if (!decision.allow) { this.d.store.event(null, 'policy_evaluated', `rejected ${decision.rejection.code}: ${req.route}`, this.now()); return { rejected: named.note && decision.rejection.code === 'ask_first' ? { ...decision.rejection, reason: `${decision.rejection.reason} ${named.note}` } : decision.rejection }; }
    const spent = this.budget(req.route, route);
    if (spent?.exhausted) { this.d.store.event(null, 'policy_evaluated', `rejected budget_exhausted: ${req.route}`, this.now()); return reject('budget_exhausted', spent.exhausted); }
    const warnings = [...decision.warnings];
    if (spent?.usdUnchecked) warnings.push(`${req.route} has a dollar budget, but no job in its window has a known cost, so only its job count is checked. Set a rate for ${route.model} in rates.json.`);
    if (named.note) warnings.push(named.note);
    if (req.named) this.d.store.event(null, 'named_claim', `${route.model} ${named.via}`, this.now());
    if (this.d.config.requirePick && !req.allow?.includes('unpicked')) {
      const check = checkPick(route.model, !!req.named, req.caller.session ?? null, this.d.store.picksSince(this.now() - PICK_WINDOW_MIN * 60000), this.now());
      if (!check.ok) { this.d.store.event(null, 'policy_evaluated', `rejected not_picked: ${req.route}`, this.now()); return reject('not_picked', check.reason); }
      if (check.note) warnings.push(check.note);
    }

    if (process.platform === 'win32' && !(this.d.config.jobhostPath && existsSync(this.d.config.jobhostPath))) {
      return reject('adapter_unavailable', 'The Windows job host (jobhost.exe) was not found, so jobs cannot be contained. Build it with pnpm build:jobhost.');
    }
    let prompt: string;
    try { prompt = req.prompt.text ?? readFileSync(realOf(req.prompt.file as string) ?? (req.prompt.file as string), 'utf8'); } catch { return reject('bad_request', 'The prompt file could not be read.'); }
    // A route can name the largest prompt it takes. A bigger job is refused here and, when the route has a fallback, goes on to it: a prompt is never cut to fit.
    const attached = this.attachments(req, route, adapter);
    if ('rejected' in attached) { this.d.store.event(null, 'policy_evaluated', `rejected ${attached.rejected.code}: ${req.route}`, this.now()); return attached; }
    const maxInput = route.options?.maxInput, size = prompt.length + attached.items.filter(a => a.kind === 'text').reduce((n, a) => n + a.bytes, 0);
    if (typeof maxInput === 'number' && size > maxInput) {
      this.d.store.event(null, 'policy_evaluated', `rejected prompt_too_large: ${req.route}`, this.now());
      return reject('prompt_too_large', `The prompt${attached.items.length ? ' and its text files are' : ' is'} ${size} characters and route ${req.route} takes at most ${maxInput}.`);
    }
    const id = randomBytes(6).toString('hex'), dir = this.jobDir(id);
    const workspace = adapter.isolation ? join(adapter.isolation.root(route), 'jobs', id) : null;
    // The charter is prefixed before the adapter plans, so every transport receives it. The stored prompt length stays the caller's text.
    const ambient = resolveAmbient(route.options?.ambient, this.d.config.runner.ambient);
    // A resumed conversation already carries the charter from its first turn.
    const skipCharter = req.noCharter === true || adapter.charterEngine === null || conv.resume?.fresh === false;
    // The activity's toolkit adds its pack to the charter and its MCP servers to a harness that can carry them for one job.
    const toolkits = loadToolkits(this.d.home ?? augurHome(this.d.env)), kit = toolkits.kits[req.activity];
    for (const note of toolkits.notes) warnings.push(note);
    if (kit && Object.keys(kit.mcp).length && !adapter.toolkit) warnings.push(`Route ${req.route} cannot carry the tools for ${req.activity}, so the job runs without them.`);
    const charter = skipCharter ? null : buildCharter({
      dir: resolveCharterDir(this.d.config.runner.charterDir, this.d.home ?? augurHome(this.d.env)),
      engine: adapter.charterEngine, tools: req.tools, cwd: req.cwd, packs: [...(req.packs ?? []), ...(kit?.pack ? [kit.pack] : [])],
    });
    const sent = charter?.text ? charter.text + prompt : prompt;
    let plan: LaunchPlan;
    try { plan = adapter.plan(req, route, { jobDir: dir, prompt: sent, workspace, ambient: this.d.config.runner.ambient, ...(conv.resume ? { resume: conv.resume } : {}), ...(attached.items.length ? { attachments: attached.items } : {}), ...(kit && adapter.toolkit ? { toolkit: kit } : {}) }); } catch (e) { return reject('bad_request', `Route ${req.route}: ${(e as Error).message}`); }
    if (process.platform === 'win32') {
      const len = plan.command.length + 1 + plan.args.reduce((n, a) => n + a.length + 3, 0);
      if (len > MAX_COMMAND_LINE) return reject('prompt_too_large', `The command for ${adapter.id} would be ${len} characters, over the Windows limit of about 32767. This harness takes its prompt as an argument.`);
    }
    mkdirSync(dir, { recursive: true });
    const file: JobFile = { command: plan.command, args: plan.args, cwd: plan.cwd, stdin: plan.stdin === null ? 'none' : 'prompt', timeoutS: req.timeoutS ?? null,
      jobhost: this.d.config.jobhostPath, env: plan.env, files: plan.files ?? [], promptArgs: plan.promptArgs ?? [], redact: !this.d.config.persistPrompts,
      ...((this.d.scopes ?? systemdScopes)()
        ? { scope: `augur-job-${id}`, scopeEnv: Object.fromEntries(SCOPE_ENV.flatMap(k => process.env[k] ? [[k, process.env[k] as string]] : [])) }
        : { scope: null }) };
    writeFileSync(join(dir, 'job.json'), JSON.stringify(file));
    if (plan.stdin !== null) writeFileSync(join(dir, 'prompt.in'), plan.stdin);
    if (this.d.config.persistPrompts) writeFileSync(join(dir, 'prompt.txt'), prompt);
    const createdAt = this.now();
    this.d.store.insert({ id, route: req.route, adapter: adapter.id, activity: req.activity, dataTier: req.dataTier, tools: req.tools, output: req.output, cwd: req.cwd,
      createdAt, rootJobId: root ?? id, parentJobId: parentId, depth, caller: req.caller, named: !!req.named, expectFile: req.expectFile ?? null,
      timeoutS: req.timeoutS ?? null, harnessVersion: null, workspace, conversation: req.conversation ?? null, turn: conv.turn ?? null });
    if (req.conversation && conv.resume) {
      if (!conv.existing) this.d.store.insertConversation({
        name: req.conversation, route: req.route, adapter: adapter.id, nativeId: conv.nativeId, cwd: req.cwd, tools: req.tools,
        turns: 0, createdAt, lastUsedAt: createdAt,
      });
      else if (conv.fresh) this.d.store.reopenConversation(req.conversation, { nativeId: conv.nativeId, tools: req.tools, cwd: req.cwd });
    }
    this.d.store.setLaunchMeta(id, { promptChars: prompt.length, ambient, ...(charter?.text ? { charter: charter.parts, charterChars: charter.text.length } : {}), ...(charter?.notes.length ? { charterNotes: charter.notes } : {}) });
    const s = this.d.store;
    s.event(id, 'requested', `${req.caller.kind}${req.caller.label ? ' ' + req.caller.label : ''}`, this.now());
    s.event(id, 'policy_evaluated', warnings.join(' | '), this.now());
    if (req.allow?.length) s.event(id, 'checks_overridden', req.allow.join(', '), this.now());
    this.d.store.event(id, 'queued', '', this.now());
    this.d.decisions?.linkJob(req.caller.session ?? null, route.model, id);
    this.submitted.set(id, chain ?? { req, hops: [req.route] });
    this.tick();
    return { id, warnings };
  }

  // ------------------------------------------------------------------ picks and pressure

  private proseOn: boolean | undefined;
  /** Whether the prose pace switch was on at the last pick, read from `prose-switch.json` the first time. It turns off at a lower lead than it turns on at, so the last answer has to outlive a restart. */
  private proseWas(): boolean {
    this.proseOn ??= readJson<{ on?: unknown }>(join(this.d.dir, 'prose-switch.json'))?.on === true;
    return this.proseOn;
  }
  /** Keeps the switch's new state when it changed. */
  private proseKeep(on: boolean): void {
    if (on === this.proseWas()) return;
    this.proseOn = on;
    try { writeFileSync(join(this.d.dir, 'prose-switch.json'), JSON.stringify({ on, at: new Date(this.now()).toISOString() }) + '\n'); } catch { /* the next pick tries again */ }
  }

  /** Ranks the models a task may use, records the pick, and names the routes that reach each model. */
  async pick(req: PickParams): Promise<PickAnswer> {
    const policy = this.d.policy();
    if (!policy) return { error: 'policy.json was not found. Augur writes it when a rule is saved.' };
    const declared = { activity: !!req.activity, dataTier: !!req.dataTier }, descriptions: Record<string, string> = {};
    let activity = req.activity, dataTier = req.dataTier, classified: unknown, fitError: string | undefined, weight = req.depth;
    const fits = { ...(req.fits ?? {}) };
    const backend = this.d.decision;
    if (req.task && backend && (!activity || !dataTier)) {
      const c = await classifyTask(backend, req.task);
      activity ??= c.activity ?? undefined; dataTier ??= c.dataTier; classified = c.detail;
      weight ??= c.depth ?? undefined;
    } else if (req.task && backend && !weight) {
      const c = await classifyDepth(backend, req.task);
      weight = c.depth ?? undefined; classified = { depth: c.detail };
    }
    if (!activity) return { error: req.task ? 'The task could not be classified. Pass the activity, or configure a decision backend.' : 'Give an activity and data tier, or a task description.' };
    dataTier ??= 'sensitive';
    if (!ACTIVITIES.includes(activity) || !DATA_TIERS.includes(dataTier)) return { error: 'Unknown activity or data tier.' };
    const preview = req.preview === true;
    const snippet = req.snippet === true ? { snippet: true as const } : {};
    const depth = weight ? { depth: weight } : {};
    const spent = this.spentPicks(req.session ?? null);
    if (req.task && backend) {
      const asked = rank(policy, this.d.usage(), { activity, dataTier, proseSwitched: this.proseWas(), ...depth, ...snippet }, new Date(this.now())).ranking.map(r => r.model).filter(m => fits[m] === undefined);
      // Student-related text is scored only by a backend on this network, as classifyTask does; with none, fit stays neutral.
      const fitter = STUDENT_RE.test(req.task) ? (backend.local ?? (backend.primary.local ? backend.primary : undefined)) : backend.primary;
      if (asked.length && fitter) {
        const describe = (m: string) => { const e = Object.values(policy.providers).map(p => p.models[m]).find(Boolean); return `${e?.name ?? e?.id ?? m}. Permitted: ${Object.keys(e?.activities ?? {}).join(', ')}. ${e?.notes ?? ''}`.trim(); };
        for (const m of asked) descriptions[m] = describe(m);
        const got = await fitScores(fitter, req.task, asked.map(m => ({ model: m, description: descriptions[m] as string })));
        Object.assign(fits, got.fits); fitError = got.error;
      }
    }
    const rules = resolveBalance((policy as { balance?: unknown }).balance), answers = rules.training.enabled && this.d.decisions ? this.d.decisions.answers() : [];
    const key = trainingKey(activity, weight ?? rules.depth[activity] ?? 'everyday');
    // What a person chose before for this kind of work leans each fit a little, and never decides the pick alone.
    const shares = learnedShares(answers, key, rules.training.window, rules.training.min);
    if (Object.keys(shares).length) {
      const live = rank(policy, this.d.usage(), { activity, dataTier, ...(req.named ? { named: req.named } : {}), ...depth, ...snippet, spent }, new Date(this.now())).ranking.map(r => r.model);
      for (const m of live) fits[m] = Math.min(1, Math.round((fits[m] ?? 0.5) * learnedTilt(shares[m] ?? 0) * 1000) / 1000);
    }
    const result = rank(policy, this.d.usage(), {
      activity, dataTier, ...(req.named ? { named: req.named } : {}), ...depth, fits, proseSwitched: this.proseWas(), ...snippet,
      spent, draw: !preview && req.best !== true, ...(req.best === true ? { best: true } : {}), ...(req.seed !== undefined ? { seed: req.seed } : {}),
    }, new Date(this.now()));
    const routes: Record<string, string[]> = {};
    for (const [name, r] of Object.entries(this.d.routes() ?? {})) if (this.d.adapters.has(r.adapter)) (routes[r.model] ??= []).push(name);
    if (preview) return { ...result, routes, activity, dataTier, ...(backend ? { decision: { backend: backend.primary.id, ...(classified ? { classified } : {}), ...(fitError ? { fitError } : {}) } } : {}) };
    this.proseKeep(result.proseSwitch.on);
    const picked = result.ranking.find(r => r.model === result.pick);
    const newId = randomBytes(6).toString('hex');
    const owner = result.pick ? Object.entries(policy.providers).find(([, p]) => p.models[result.pick as string]) : undefined;
    const proposal = rules.training.enabled && this.d.decisions && result.pick && owner && !req.named
      ? propose(rules, { label: result.pick, provider: owner[0], id: owner[1].models[result.pick]?.id ?? '' }, key, result.depth, newId, answers) : null;
    const pending = proposal !== null && proposal.mode !== 'auto';
    const pickId = this.d.decisions?.pick({ id: newId, ...(proposal ? { proposal: { mode: proposal.mode, key: proposal.key, reason: proposal.reason } } : {}), session: req.session ?? null, ...(req.task ? { task: req.task } : {}), activity, dataTier, pick: result.pick ?? null,
      ranking: result.ranking.map(r => ({ model: r.model, ...(fits[r.model] !== undefined ? { fit: fits[r.model] } : {}) })), named: req.named ?? null,
      ...(backend ? { backend: backend.primary.id } : {}), classified: { activity: !declared.activity, dataTier: !declared.dataTier }, descriptions,
      ...(result.pick?.startsWith('copilot/') ? { spend: copilotSpend(this.d.usage()) } : {}),
      depth: result.depth, reason: result.reason, seats: { ...(result.seats.second ? { second: result.seats.second.model } : {}), ...(result.seats.web ? { web: result.seats.web.model } : {}), ...(result.seats.shadow ? { shadow: result.seats.shadow.model } : {}) },
      ...(picked ? { odds: picked.odds } : {}), drawn: result.drawn, seed: result.seed });
    if (result.pick && !pending) this.d.store.addPick({ at: this.now(), session: req.session ?? null, model: result.pick, activity, dataTier, named: req.named ?? null, cleared: result.ranking.map(r => r.model), ...(picked ? { odds: picked.odds } : {}), drawn: result.drawn, seed: result.seed });
    return { ...result, routes, activity, dataTier, ...(pickId ? { pickId } : {}), ...(proposal ? { proposal: { ...proposal, pending } } : {}), ...(backend ? { decision: { backend: backend.primary.id, ...(classified ? { classified } : {}), ...(fitError ? { fitError } : {}) } } : {}) };
  }

  /** Records a person's answer to a pending proposal and clears the route they chose for jobs. The newest answer for a pick counts. */
  pickAnswer(id: string, model: string, why?: string): { ok: true; agreed: boolean; key: string; n: number; agreedOf: number } | { error: string } {
    const log = this.d.decisions, policy = this.d.policy();
    if (!log || !policy) return { error: 'The service keeps no decision record, so there is nothing to answer.' };
    const row = log.pickRow(id);
    if (!row || !row.pick) return { error: 'No pick with that id is in the decision log.' };
    if (!Object.values(policy.providers).some(p => p.models[model])) return { error: `${model} is not a model in the rules.` };
    const key = row.proposal?.key ?? trainingKey(row.activity, (row.depth ?? 'everyday') as Depth);
    log.answer({ pick: id, key, proposed: row.pick, chosen: model, ...(why ? { why } : {}) });
    const agreed = model === row.pick;
    // A proposal that waited was not registered when it was made; the chosen route is registered now so jobs may run on it.
    if (row.proposal && row.proposal.mode !== 'auto') this.d.store.addPick({ at: this.now(), session: row.session, model, activity: row.activity, dataTier: row.dataTier, named: agreed ? null : model, cleared: agreed ? row.ranking.map(r => r.model) : [model] });
    const stats = agreement(log.answers(), key, resolveBalance((policy as { balance?: unknown }).balance).training.window);
    return { ok: true, agreed, key, n: stats.n, agreedOf: stats.agreed };
  }

  /** Picks per route over the last 24 hours and within one session, for the route caps. A pick where the route was named does not count. */
  private spentPicks(session: string | null): NonNullable<import('@augur/dispatch-protocol').PickRequest['spent']> {
    const out = { day: {} as Record<string, number>, session: {} as Record<string, number> };
    for (const p of this.d.store.picksSince(this.now() - 86400_000)) {
      if (p.named) continue;
      out.day[p.model] = (out.day[p.model] ?? 0) + 1;
      if (session && p.session === session) out.session[p.model] = (out.session[p.model] ?? 0) + 1;
    }
    return out;
  }

  /** The balance report for the policy and usage as they stand, with what the pick log shows for the last `days` days. */
  balance(days = 7): BalanceReport | { error: string } {
    const policy = this.d.policy();
    if (!policy) return { error: 'policy.json was not found. Augur writes it when a rule is saved.' };
    const report = balanceReport(policy, this.d.usage(), new Date(this.now()), this.d.decisions ? this.d.decisions.summary(Math.min(Math.max(Math.round(days), 1), 90)) : null, 'internal', this.proseWas());
    if (report.claude.prose) this.proseKeep(report.claude.prose.on);
    return report;
  }

  pressure(): { pressure: ReturnType<typeof pressure>; factors: Record<string, number>; scarcity: number } | null {
    const policy = this.d.policy(), usage = this.d.usage();
    if (!policy || !usage) return null;
    const press = pressure(policy, usage, new Date(this.now()));
    return { pressure: press, ...usageFactors(policy, press) };
  }

  /** Checks a claim that a person named the model. Returns the value to use and a note when the claim could not be confirmed. */
  private confirmNamed(req: JobRequest, model: string): { rejected: Rejection } | { value: boolean; note: string | null; via: string } {
    if (!req.named) return { value: false, note: null, via: 'none' };
    const mode = this.d.config.verifyNamed;
    if (mode === 'off') return { value: true, note: null, via: 'unchecked' };
    const session = req.caller.session ?? null;
    const check = checkNamed(model, session, !!req.caller.interactive, session ? this.d.store.recentPrompts(session, NAMED_PROMPT_WINDOW) : [], this.now());
    if (check.ok) return { value: true, note: null, via: check.via };
    if (mode === 'enforce') return { value: false, note: `${check.reason} It was treated as not named.`, via: 'refused' };
    return { value: true, note: `${check.reason} It was accepted as named because the service only records this check.`, via: 'unconfirmed' };
  }

  /** Records which models a person's message named, for confirming later claims. The text is not kept. */
  humanPrompt(session: string, text: string): { models: string[] } | { error: string } {
    const policy = this.d.policy();
    if (!policy) return { error: 'policy.json was not found. Augur writes it when a rule is saved.' };
    if (!session) return { error: 'A session is required.' };
    const models = matchNamedModels(policy, text);
    this.d.store.addPrompt({ at: this.now(), session, models });
    return { models };
  }

  /** Records a brief check against the pick it belongs to. */
  label(id: string, result: string, note?: string): { ok: true; pick: string; job: string | null } | { error: string } {
    if (!this.d.decisions) return { error: 'The service keeps no decision log.' };
    if (!BRIEF_RESULTS.includes(result as BriefResult)) return { error: `The brief result is one of ${BRIEF_RESULTS.join(', ')}.` };
    return this.d.decisions.label(id, result as BriefResult, note);
  }

  private rubricStore?: RubricStore;
  private rubrics(): RubricStore { return this.rubricStore ??= new RubricStore(join(this.d.home ?? augurHome(), 'rubrics')); }

  /**
   * Grades a candidate against one of the owner's rubrics. The data tier is what the caller declared, or regulated when the text names students, and
   * text in the sensitive and regulated tiers is graded only on this network. The grade is recorded; the answer says what it may be used for.
   */
  async grade(req: GradeParams): Promise<GradeAnswer | { error: string }> {
    if (!this.d.decisions) return { error: 'The service keeps no decision log, so it cannot record grades.' };
    if (!this.d.decision) return { error: 'No decision backend is configured, so there is nothing to grade with.' };
    if (typeof req.task !== 'string' || typeof req.candidate !== 'string' || !req.task.trim() || !req.candidate.trim()) return { error: 'A grade needs a task and a candidate, both as text.' };
    if (req.tier !== undefined && !DATA_TIERS.includes(req.tier)) return { error: 'Unknown data tier.' };
    const r = this.rubrics().get(String(req.rubric ?? ''));
    if ('error' in r) return r;
    const tier = gradeTier(req.tier, `${req.task} ${req.candidate} ${req.reference ?? ''}`);
    const out = await gradeText(this.d.decision, r.rubric, { task: req.task, candidate: req.candidate, ...(req.reference ? { reference: req.reference } : {}) }, tier);
    if ('error' in out) return out;
    const stats = gradeStats(this.d.decisions.records(), r.rubric);
    const logged = this.d.decisions.grade({ rubric: r.rubric.id, version: r.rubric.version, tier, backend: out.grade.backend, overall: out.grade.overall, uncertainty: out.grade.uncertainty,
      dims: out.grade.dims, mode: stats.mode, verdictFor: id => decideGrade(r.rubric, out.grade, stats.mode, id), task: req.task, candidate: req.candidate });
    return { id: logged.id, rubric: r.rubric.id, version: r.rubric.version, tier, backend: out.grade.backend, dims: out.grade.dims, overall: out.grade.overall, uncertainty: out.grade.uncertainty,
      mode: stats.mode, verdict: logged.verdict as GradeAnswer['verdict'], audit: logged.audit };
  }

  /** A person's check of a grade: agree, too high, or too low. */
  gradeLabel(id: string, label: string, note?: string): { ok: true; rubric: string; mode: 'shadow' | 'advise' | 'gate' } | { error: string } {
    if (!this.d.decisions) return { error: 'The service keeps no decision log.' };
    if (!GRADE_LABELS.includes(label as GradeVerdictLabel)) return { error: `The grade label is one of ${GRADE_LABELS.join(', ')}.` };
    const done = this.d.decisions.gradeLabel(id, label as GradeVerdictLabel, note);
    if ('error' in done) return done;
    const r = this.rubrics().get(done.rubric);
    if ('error' in r) return { ok: true, rubric: done.rubric, mode: 'shadow' };
    return { ok: true, rubric: done.rubric, mode: gradeStats(this.d.decisions.records(), r.rubric).mode };
  }

  /** Each rubric with its labelled grades, agreement and earned mode. */
  gradeReport(only?: string): GradeReport | { error: string } {
    if (!this.d.decisions) return { error: 'The service keeps no decision log.' };
    const all = this.rubrics().list(), rows = this.d.decisions.records();
    const picked = only ? all.rubrics.filter(r => r.id === only) : all.rubrics;
    if (only && !picked.length) { const one = this.rubrics().get(only); return 'error' in one ? one : { rubrics: [], problems: [] }; }
    return { rubrics: picked.map(r => ({ ...gradeStats(rows, r), stakes: r.stakes })), problems: only ? [] : all.problems };
  }

  private validate(req: JobRequest): string | null {
    if (!ACTIVITIES.includes(req.activity)) return 'Unknown activity.';
    if (!DATA_TIERS.includes(req.dataTier)) return 'Unknown data tier.';
    if (!TOOL_TIERS.includes(req.tools)) return 'Unknown tool tier.';
    if (!OUTPUT_MODES.includes(req.output)) return 'Unknown output mode.';
    if (!isAbsolute(req.cwd) || !existsSync(req.cwd) || !statSync(req.cwd).isDirectory()) return 'cwd must be an existing absolute directory.';
    const inData = relative(resolve(this.d.dir), resolve(req.cwd));
    if ((!inData.startsWith('..') && !isAbsolute(inData)) || realInside(req.cwd, this.d.dir)) return 'cwd may not be inside the service data folder.';
    if ((req.prompt.text === undefined) === (req.prompt.file === undefined)) return 'Give the prompt as text or as a file, not both.';
    if (req.prompt.file !== undefined) {
      const file = resolve(req.prompt.file), roots = [req.cwd, ...this.d.config.promptRoots].map(r => resolve(r));
      if (!roots.some(r => file === r || file.startsWith(r + sep)) || !realInsideAny(file, roots)) return 'A prompt file must be inside the job working folder or a folder listed in promptRoots.';
      if (realInside(file, this.d.dir)) return 'A prompt file may not be inside the service data folder.';
    }
    if (req.expectFile !== undefined) {
      const target = resolve(req.cwd, req.expectFile);
      if (target !== resolve(req.cwd) && !target.startsWith(resolve(req.cwd) + sep)) return 'expectFile must stay inside cwd.';
    }
    if (req.timeoutS !== undefined && !(req.timeoutS > 0 && req.timeoutS <= 86400)) return 'timeoutS must be between 1 and 86400.';
    if (req.packs !== undefined && (!Array.isArray(req.packs) || req.packs.some(p => typeof p !== 'string'))) return 'packs must be a list of strings.';
    if (req.noCharter !== undefined && typeof req.noCharter !== 'boolean') return 'noCharter must be true or false.';
    if (req.attach !== undefined && (!Array.isArray(req.attach) || req.attach.length > MAX_ATTACHMENTS || req.attach.some(a => typeof a !== 'string' || !a))) return `attach must be a list of at most ${MAX_ATTACHMENTS} file paths.`;
    if (req.conversation !== undefined && (typeof req.conversation !== 'string' || !CONVERSATION_NAME.test(req.conversation))) return 'A conversation name is 1 to 64 characters: letters, digits, dot, underscore or hyphen.';
    return null;
  }

  /** Checks each attachment: inside the working folder or a prompt root, a file of a type the route takes, and under the size caps. Text counts toward the route's input limit where it is checked. */
  private attachments(req: JobRequest, route: RouteConfig, adapter: Adapter): { rejected: Rejection } | { items: ResolvedAttachment[] } {
    if (!req.attach?.length) return { items: [] };
    const refuse = (reason: string) => ({ rejected: { code: 'attachment_rejected' as const, reason } });
    const kinds = adapter.attachmentKinds?.(route) ?? [];
    if (!kinds.length) return refuse(`Route ${req.route} takes no attachments.`);
    const roots = [req.cwd, ...this.d.config.promptRoots].map(r => resolve(r)), cap = { image: optMb(route, 'maxImageMb', 10), audio: optMb(route, 'maxAudioMb', 25) };
    const items: ResolvedAttachment[] = [];
    for (const given of req.attach) {
      const named = resolve(req.cwd, given), name = basename(named);
      if (!roots.some(r => named === r || named.startsWith(r + sep))) return refuse(`Attachment ${name} must be inside the job working folder or a folder listed in promptRoots.`);
      // The file is read from its real location, which has to be inside a root too, and its type is judged by the real file's name.
      const path = realOf(named);
      if (path === null) return refuse(`Attachment ${name} could not be read.`);
      if (!realInsideAny(path, roots) || realInside(path, this.d.dir)) return refuse(`Attachment ${name} must be inside the job working folder or a folder listed in promptRoots.`);
      let bytes: number;
      try { const st = statSync(path); if (!st.isFile()) return refuse(`Attachment ${name} is not a file.`); bytes = st.size; } catch { return refuse(`Attachment ${name} could not be read.`); }
      const kind = attachmentKind(path);
      if (!kind) return refuse(`Attachment ${name} is a type Augur does not send. It takes text, image and audio files.`);
      if (!kinds.includes(kind)) return refuse(`Route ${req.route} takes ${kinds.join(' and ')} attachments, not ${kind}.`);
      if (kind !== 'text' && bytes > cap[kind] * 1048576) return refuse(`Attachment ${name} is ${Math.ceil(bytes / 1048576)} MB and route ${req.route} takes ${kind} files up to ${cap[kind]} MB.`);
      if (kind === 'audio' && req.activity !== 'transcribe') return refuse('Audio attachments are for the transcribe activity.');
      items.push({ path, kind, bytes });
    }
    return { items };
  }

  /** Resolves a named conversation, or a refusal. A missing row is a new conversation. */
  private conversationPlan(req: JobRequest, adapter: Adapter): { rejected: Rejection } | {
    resume?: { id: string | null; fresh: boolean; name: string }; turn?: number; nativeId: string | null; fresh: boolean; existing: boolean;
  } {
    if (!req.conversation) return { nativeId: null, fresh: false, existing: false };
    const name = req.conversation;
    if (!adapter.capabilities.sessions) return { rejected: { code: 'bad_request', reason: `Adapter ${adapter.id} does not keep a conversation, so route ${req.route} cannot use one.` } };
    const existing = this.d.store.conversation(name);
    if (existing && existing.route !== req.route) return { rejected: { code: 'bad_request', reason: `Conversation ${name} is bound to route ${existing.route}.` } };
    const held = this.d.store.holdingConversation(name);
    if (held) return { rejected: { code: 'bad_request', reason: `Conversation ${name} is already running as job ${held}.` } };
    const turns = existing?.turns ?? 0;
    const fresh = turns === 0;
    if (!fresh && adapter.id === 'codex-exec' && existing && existing.tools !== req.tools) {
      return { rejected: { code: 'bad_request', reason: `Conversation ${name} was opened with the ${existing.tools} tool tier. A resumed Codex session keeps that tier, because resume cannot set the sandbox again.` } };
    }
    let nativeId: string | null = fresh ? null : existing?.nativeId ?? null;
    if (fresh && adapter.id === 'grok-exec') nativeId = randomUUID();
    if (!fresh && !nativeId) return { rejected: { code: 'bad_request', reason: `Conversation ${name} has no session id to resume.` } };
    return { resume: { id: nativeId, fresh, name }, turn: turns + 1, nativeId, fresh, existing: !!existing };
  }

  /** Records a finished turn. A failed first turn drops its native id so the next call starts again. */
  private settleConversation(rec: JobRecord, completed: boolean, sessionId: string | null): void {
    const name = rec.conversation;
    if (!name) return;
    const row = this.d.store.conversation(name);
    if (!row) return;
    if (completed) {
      this.d.store.finishConversation(name, { nativeId: sessionId, cwd: rec.cwd, lastUsedAt: this.now() });
      return;
    }
    if (row.turns === 0) this.d.store.clearConversationId(name);
  }

  // ------------------------------------------------------------------ launch and watch

  private git(cwd: string, args: string[]): { ok: boolean; out: string } {
    const r = spawnSync('git', [...GIT, '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  }

  /** Copies the working directory into the adapter's own folder and records the starting tree, so what the job changed can be diffed later. */
  private prepareWorkspace(rec: JobRecord, ws: string): string | null {
    try {
      mkdirSync(dirname(ws), { recursive: true });
      cpSync(rec.cwd, ws, { recursive: true, filter: copyFilterWithCaps() });
    } catch (e) { return `copying the working directory failed: ${(e as Error).message}`; }
    if (!this.git(ws, ['init', '-q']).ok) return 'git could not record the starting tree';
    this.git(ws, ['add', '-A']);
    const tree = this.git(ws, ['write-tree']);
    if (!tree.ok) return 'git could not record the starting tree';
    writeFileSync(join(this.jobDir(rec.id), 'base-tree'), tree.out.split('\n').pop() ?? '');
    return null;
  }

  private collectPatch(rec: JobRecord): void {
    const ws = rec.workspace, base = (() => { try { return readFileSync(join(this.jobDir(rec.id), 'base-tree'), 'utf8').trim(); } catch { return ''; } })();
    if (!ws || !base || !existsSync(ws)) return;
    this.git(ws, ['add', '-A']);
    const names = this.git(ws, ['diff', '--cached', '--name-only', base]);
    const files = names.ok ? names.out.split('\n').filter(Boolean).length : 0;
    if (!files) return;
    const patch = join(this.jobDir(rec.id), 'changes.patch');
    // git writes the file itself: routing a diff through a text stream would strip the CR of CRLF lines and the patch would no longer apply.
    if (this.git(ws, ['diff', '--cached', '--binary', `--output=${patch}`, base]).ok) this.d.store.setPatch(rec.id, patch, files);
  }

  private launch(id: string): void {
    const rec = this.d.store.get(id);
    if (!rec || rec.state !== 'queued') return;
    const dir = this.jobDir(id), adapter = this.d.adapters.get(rec.adapter);
    const file = readJson<JobFile>(join(dir, 'job.json'));
    if (!adapter || !file) { if (this.d.store.transition(id, 'failed', { reason: 'job files missing at launch' }, this.now())) this.settleConversation(rec, false, null); return; }
    if (rec.workspace) {
      const problem = this.prepareWorkspace(rec, rec.workspace);
      if (problem) { if (this.d.store.transition(id, 'failed', { reason: problem }, this.now())) this.settleConversation(rec, false, null); this.cleanup(id); return; }
    }
    for (const f of file.files) {
      const target = f.inWorkspace && rec.workspace ? join(rec.workspace, f.name) : join(dir, f.name);
      try { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, f.content); } catch (e) { if (this.d.store.transition(id, 'failed', { reason: `could not write ${f.name}: ${(e as Error).message}` }, this.now())) this.settleConversation(rec, false, null); return; }
    }
    const route = this.d.routes()?.[rec.route];
    const extra: Record<string, string> = { ...file.env, AUGUR_JOB_ID: id, AUGUR_ROOT_JOB_ID: rec.rootJobId };
    if (!route?.delegation) { delete extra.AUGUR_JOB_ID; delete extra.AUGUR_ROOT_JOB_ID; }
    const more = typeof route?.options?.envAllow === 'string' ? route.options.envAllow.split(',').map(n => n.trim()).filter(Boolean) : [];
    if (typeof route?.options?.apiKeyEnv === 'string') more.push(route.options.apiKeyEnv);
    const env = buildEnv([...adapter.envAllow, ...more], extra, this.d.env ?? process.env);
    let pid: number | undefined;
    try {
      const r = spawn(process.execPath, [this.runner, dir], { detached: true, windowsHide: true, stdio: 'ignore', env });
      r.on('error', () => { /* reported by the missing-runner check */ });
      r.unref(); pid = r.pid;
    } catch (e) { if (this.d.store.transition(id, 'failed', { reason: `runner could not start: ${(e as Error).message}` }, this.now())) this.settleConversation(rec, false, null); return; }
    if (this.d.store.transition(id, 'running', { runnerPid: pid, startedAt: this.now() }, this.now())) {
      this.d.store.event(id, 'process_created', `runner ${pid}`, this.now());
      if (route && adapter.version) { try { this.d.store.setVersion(id, adapter.version(route)); } catch { /* version is informational */ } }
    }
  }

  tick(): void {
    const store = this.d.store;
    for (const rec of store.active()) this.watch(rec);
    let room = this.d.config.maxConcurrent - store.countActive();
    if (room <= 0) return;
    const gate = this.parallelGate();
    for (const id of store.queued(gate ? 256 : room)) {
      if (room <= 0) break;
      const rec = gate ? store.get(id) : null;
      if (gate && rec && !gate.admit(rec)) continue;
      this.launch(id);
      room--;
    }
  }

  /** Holds a job back while its route already runs `caps.<route>.parallel` jobs. Null when no cap sets a parallel limit. A launch counts at once, so jobs queued in one tick cannot overshoot. */
  private parallelGate(): { admit(rec: JobRecord): boolean } | null {
    const policy = this.d.policy(), routes = this.d.routes();
    if (!policy || !routes) return null;
    const caps = resolveBalance((policy as { balance?: unknown }).balance).caps;
    if (!Object.values(caps).some(c => (c.parallel ?? 0) > 0)) return null;
    const label = (route: string): string | undefined => routes[route]?.model;
    const limitOf = (route: string): number => {
      const model = label(route);
      if (!model) return 0;
      for (const [provider, p] of Object.entries(policy.providers)) {
        const entry = p.models[model];
        if (entry) return lookup(caps, { label: model, provider, id: entry.id })?.parallel ?? 0;
      }
      return 0;
    };
    const running = new Map<string, number>();
    for (const r of this.d.store.active()) { const m = label(r.route); if (m) running.set(m, (running.get(m) ?? 0) + 1); }
    return {
      admit: (rec: JobRecord): boolean => {
        const limit = limitOf(rec.route), model = label(rec.route);
        if (!limit || !model) return true;
        const n = running.get(model) ?? 0;
        if (n >= limit) return false;
        running.set(model, n + 1);
        return true;
      },
    };
  }

  private watch(rec: JobRecord): void {
    const store = this.d.store, dir = this.jobDir(rec.id), inner = store.internal(rec.id);
    if (!inner) return;
    const state = readJson<{ childPid: number; runnerPid: number }>(join(dir, 'state.json'));
    if (state && inner.childPid !== state.childPid) store.setPids(rec.id, { childPid: state.childPid, runnerPid: state.runnerPid });
    if (!this.outputSeen.has(rec.id)) {
      try { if (statSync(join(dir, 'stdout.log')).size > 0) { this.outputSeen.add(rec.id); store.event(rec.id, 'first_update', '', this.now()); } } catch { /* no output yet */ }
    }
    const result = readJson<RunnerResult>(join(dir, 'result.json'));
    if (result) { this.finalize(rec, result); return; }
    let age = Infinity;
    try { age = this.now() - statSync(join(dir, 'heartbeat')).mtimeMs; } catch { /* runner not started yet */ }
    const seen = age !== Infinity, since = this.now() - (rec.startedAt ?? rec.createdAt), pid = inner.runnerPid;
    const gone = (!alive(pid) && (seen ? age > 3000 : since > 8000)) || (seen ? age > this.d.config.runnerStaleS * 1000 : since > this.d.config.runnerStaleS * 1000);
    if (!gone) return;
    const child = state?.childPid ?? inner.childPid, orphan = alive(child);
    if (orphan) this.killTree(child as number);
    this.killFollowed(dir);
    // A scope can hold processes that outlived the child, so it is stopped whether or not the child is still there.
    const scope = readJson<JobFile>(join(dir, 'job.json'))?.scope;
    if (scope) spawnSync('systemctl', ['--user', 'kill', '--signal=SIGKILL', `${scope}.scope`], { stdio: 'ignore', timeout: 10000 });
    if (store.transition(rec.id, rec.state === 'cancel_requested' ? 'cancelled' : 'lost', { reason: `runner gone, child ${orphan ? 'orphaned and killed' : 'not running'}` }, this.now())) this.settleConversation(rec, false, null);
    this.collectPatch(rec);
    this.cleanup(rec.id);
  }

  private finalize(rec: JobRecord, res: RunnerResult): void {
    const store = this.d.store, adapter = this.d.adapters.get(rec.adapter), inner = store.internal(rec.id), at = this.now(), dir = this.jobDir(rec.id);
    // submitTo ticks again while a retry is launched, and that tick may already have finalized this job.
    if (isTerminal(store.get(rec.id)?.state ?? rec.state)) return;
    if (this.adopted.delete(rec.id)) store.event(rec.id, 'reconciled', 'finished while the service was not watching', at);
    store.event(rec.id, 'process_exited', `exit ${res.exitCode}${res.killedBy ? ` after ${res.killedBy}` : ''}`, at);
    if (res.killedBy === 'cancel') store.event(rec.id, 'cancellation_acknowledged', '', at);
    this.collectPatch(rec);

    let answer: string | null = null, failure: string | undefined, sessionId: string | null = null;
    const stderr = this.tail(join(dir, 'stderr.log'), 1024 * 1024);
    if (adapter) {
      const stdoutPath = join(dir, 'stdout.log');
      const x = adapter.extract({ stdout: this.tail(stdoutPath, 4 * 1024 * 1024), stdoutPath, stderr, exitCode: res.exitCode, jobDir: dir, workspace: rec.workspace });
      answer = x.answer?.trim() ? x.answer : null; failure = x.failure; sessionId = x.sessionId?.trim() ? x.sessionId.trim() : null;
      if (answer) { writeFileSync(join(dir, 'answer.txt'), answer); store.setChars(rec.id, { answer: answer.length }); }
      if (x.served && Object.keys(x.served).length) store.setServed(rec.id, x.served);
      if (x.usage) { store.setUsage(rec.id, x.usage); store.event(rec.id, 'usage_recorded', `${x.usage.inputTokens} in, ${x.usage.outputTokens} out`, at); }
    }
    const patch = { endedAt: res.endedAt, exitCode: res.exitCode };
    const expected = inner?.expectFile ? resolve(rec.workspace ?? rec.cwd, inner.expectFile) : null;
    let expectProblem: string | null = null;
    if (expected) {
      if (!existsSync(expected)) expectProblem = `expected file ${inner!.expectFile} is missing`;
      else if (statSync(expected).size === 0) expectProblem = `expected file ${inner!.expectFile} is empty`;
    }
    if (res.killedBy === 'cancel') store.transition(rec.id, 'cancelled', { ...patch, reason: 'cancelled' }, at);
    else if (res.killedBy === 'timeout') store.transition(rec.id, 'killed', { ...patch, reason: `timed out after ${inner?.timeoutS}s` }, at);
    else if (res.spawnError) store.transition(rec.id, 'failed', { ...patch, reason: res.spawnError }, at);
    else if (res.exitCode !== 0) store.transition(rec.id, 'failed', { ...patch, reason: `exit ${res.exitCode}` }, at);
    else if (!answer) store.transition(rec.id, 'failed', { ...patch, reason: failure ?? 'exited cleanly but produced no answer' }, at);
    else if (failure) store.transition(rec.id, 'failed', { ...patch, reason: failure }, at);
    else if (expectProblem) store.transition(rec.id, 'artifact_validation_failed', { ...patch, reason: expectProblem }, at);
    else { if (expected) store.event(rec.id, 'artifact_validated', inner!.expectFile ?? '', at); store.transition(rec.id, 'completed', patch, at); }
    store.event(rec.id, 'finalized', '', this.now());
    const done = store.get(rec.id), model = this.d.routes()?.[rec.route]?.model ?? rec.route;
    if (done && isTerminal(done.state)) this.settleConversation(done, done.state === 'completed', sessionId);
    if (done) this.d.decisions?.outcome(rec.id, model, done.state, done.reason, done.endedAt && done.startedAt ? done.endedAt - done.startedAt : null);
    this.retryFailed(rec, res, failure, answer, stderr);
    this.cleanup(rec.id);
  }

  /** Submits the original request on the next fallback route when the failure can be retried. The failed job keeps its state. */
  private retryFailed(rec: JobRecord, res: RunnerResult, failure: string | undefined, answer: string | null, stderrTail: string): void {
    if (this.d.config.runner.failover !== 'on') return;
    const held = this.submitted.get(rec.id);
    if (!held) return;
    // A conversation is bound to its route, so a failed turn is not retried on a fallback.
    if (held.req.conversation) return;
    const done = this.d.store.get(rec.id);
    if (!done || (done.state !== 'failed' && done.state !== 'killed')) return;
    if (held.req.failover === false || held.hops.length >= MAX_HOPS) return;
    const fallbacks = this.d.routes()?.[rec.route]?.fallback;
    if (!fallbacks?.length) return;
    const verdict = classifyFailure({
      ...(res.spawnError ? { spawnError: res.spawnError } : {}), killedBy: res.killedBy, exitCode: res.exitCode,
      ...(failure ? { failure } : {}), stderrTail, tools: rec.tools, answer, changed: (done.patch?.files ?? 0) > 0,
    });
    if (!verdict.retry) return;
    for (const next of fallbacks) {
      if (next === rec.route || held.hops.includes(next)) continue;
      const submitted = this.submitTo({ ...held.req, route: next }, { req: held.req, hops: [...held.hops, next] });
      if ('rejected' in submitted) continue;
      this.d.store.linkRetry(rec.id, submitted.id);
      const at = this.now();
      this.d.store.event(rec.id, 'failover_retry', `${rec.route} to ${next}: ${verdict.why}, as ${submitted.id}`, at);
      this.d.store.event(submitted.id, 'failover', `${rec.route} to ${next}: ${verdict.why}`, at);
      return;
    }
  }

  private cleanup(id: string): void {
    this.outputSeen.delete(id);
    this.submitted.delete(id);
    if (this.d.config.persistPrompts) return;
    try { unlinkSync(join(this.jobDir(id), 'prompt.in')); } catch { /* already read by the runner */ }
    const file = readJson<JobFile>(join(this.jobDir(id), 'job.json')), rec = this.d.store.get(id);
    for (const f of file?.files ?? []) {
      try { unlinkSync(f.inWorkspace && rec?.workspace ? join(rec.workspace, f.name) : join(this.jobDir(id), f.name)); } catch { /* not written or already gone */ }
    }
  }

  /** Ends what a runner that is gone had followed out of the job's process group, matching each pid to its recorded start time. */
  private killFollowed(dir: string): void {
    if (process.platform === 'win32') return;
    const list = readJson<Array<{ pid: number; started: string }>>(join(dir, 'descendants.json'));
    if (!Array.isArray(list)) return;
    for (const { pid, started } of list) {
      if (!Number.isInteger(pid) || pid <= 1 || typeof started !== 'string') continue;
      const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (r.status === 0 && String(r.stdout).trim() === started) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
  }

  private killTree(pid: number): void {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
  }

  private tail(path: string, bytes: number): string {
    try {
      const size = statSync(path).size, start = Math.max(0, size - bytes), fd = openSync(path, 'r');
      try { const buf = Buffer.alloc(size - start); readSync(fd, buf, 0, buf.length, start); return buf.toString('utf8'); } finally { closeSync(fd); }
    } catch { return ''; }
  }

  /** Called once when the service starts: every job that was running is re-adopted from its files. */
  reconcile(): void {
    const store = this.d.store, active = store.active();
    store.event(null, 'daemon_started', `${active.length} running jobs to re-adopt`, this.now());
    for (const rec of active) this.adopted.add(rec.id);
    this.tick();
    this.purge();
  }

  // ------------------------------------------------------------------ callers

  cancel(id: string): { ok: boolean; state: JobRecord['state'] } | null {
    const store = this.d.store, rec = store.get(id);
    if (!rec) return null;
    if (isTerminal(rec.state)) return { ok: false, state: rec.state };
    const at = this.now();
    if (rec.state === 'queued' || rec.state === 'needs_approval') { if (store.transition(id, 'cancelled', { reason: 'cancelled before launch' }, at)) this.settleConversation(rec, false, null); this.cleanup(id); return { ok: true, state: 'cancelled' }; }
    store.event(id, 'cancellation_requested', '', at);
    writeFileSync(join(this.jobDir(id), 'cancel.request'), '1');
    store.transition(id, 'cancel_requested', {}, at);
    this.tick();
    return { ok: true, state: store.get(id)?.state ?? 'cancel_requested' };
  }

  logs(id: string, stream: 'stdout' | 'stderr' = 'stdout', offset = 0, limit = 65536): { text: string; next: number; done: boolean } | null {
    const rec = this.d.store.get(id);
    if (!rec) return null;
    const path = join(this.jobDir(id), `${stream}.log`);
    let size = 0; try { size = statSync(path).size; } catch { /* no output */ }
    const start = Math.min(Math.max(0, offset), size), len = Math.min(Math.max(1, limit), 1048576, size - start);
    let buf = Buffer.alloc(0);
    if (len > 0) { const fd = openSync(path, 'r'); try { buf = Buffer.alloc(len); readSync(fd, buf, 0, len, start); } finally { closeSync(fd); } }
    let end = buf.length;
    if (start + len < size) { // do not end inside a multi-byte character
      const byte = (n: number) => buf[n] ?? 0;
      let i = end; while (i > 0 && (byte(i - 1) & 0xc0) === 0x80) i--;
      if (i > 0 && byte(i - 1) >= 0xc0) end = i - 1;
    }
    return { text: buf.subarray(0, end).toString('utf8'), next: start + end, done: isTerminal(rec.state) && start + end >= size };
  }

  result(id: string): { job: JobRecord; answer: string | null } | null {
    const job = this.d.store.get(id);
    if (!job) return null;
    const p = join(this.jobDir(id), 'answer.txt');
    let answer: string | null = null;
    try { if (statSync(p).size <= 1048576) answer = readFileSync(p, 'utf8'); } catch { /* none written */ }
    return { job, answer };
  }

  /** Applies the patch a job left in its isolated workspace to the directory the job was started for. */
  apply(id: string, check = false): { ok: boolean; output: string } | null {
    const job = this.d.store.get(id);
    if (!job) return null;
    if (!job.patch) return { ok: false, output: 'This job left no patch.' };
    if (!existsSync(job.patch.path)) return { ok: false, output: 'The patch file has been removed.' };
    if (!existsSync(job.cwd)) return { ok: false, output: 'The working directory no longer exists.' };
    const dry = this.git(job.cwd, ['apply', '--check', job.patch.path]);
    if (!dry.ok || check) return { ok: dry.ok, output: dry.out || (dry.ok ? 'The patch applies cleanly.' : 'The patch does not apply.') };
    const run = this.git(job.cwd, ['apply', job.patch.path]);
    if (run.ok) this.d.store.event(id, 'patch_applied', job.cwd, this.now());
    return { ok: run.ok, output: run.out || 'Applied.' };
  }

  conversations(): Conversation[] { return this.d.store.conversations(); }

  forgetConversation(name: string): { forgotten: boolean; reason?: string } {
    if (typeof name !== 'string' || !CONVERSATION_NAME.test(name)) return { forgotten: false, reason: 'A conversation name is 1 to 64 characters: letters, digits, dot, underscore or hyphen.' };
    const held = this.d.store.holdingConversation(name);
    if (held) return { forgotten: false, reason: `Conversation ${name} is already running as job ${held}.` };
    return this.d.store.forgetConversation(name) ? { forgotten: true } : { forgotten: false, reason: `No conversation named ${name}.` };
  }

  /** Removes the folders of jobs that ended before the retention window. Job records stay. */
  purge(): number {
    const cutoff = this.now() - this.d.config.retentionDays * 86400000;
    let n = 0;
    this.d.store.dropPicksBefore(this.now() - 86400000);
    for (const id of this.d.store.purgeable(cutoff)) {
      const rec = this.d.store.get(id);
      try {
        rmSync(this.jobDir(id), { recursive: true, force: true });
        if (rec?.workspace) rmSync(rec.workspace, { recursive: true, force: true });
        this.d.store.markPurged(id); n++;
      } catch { /* retried next time */ }
    }
    return n;
  }
}
