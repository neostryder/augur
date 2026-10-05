// What the MCP server offers, as plain functions over the dispatch service. Kept apart from the protocol so each tool can be tested without a client.
// Every tool goes through the same service and the same rules as the `augur` command. The server holds no authority of its own: it cannot skip the pick
// check, claim that a person named a model, or turn a rule off.
import { call as serviceCall } from '@augur/augurd/client';
import type { ClientOptions } from '@augur/augurd/client';
import { ACTIVITIES, DATA_TIERS, OUTPUT_MODES, checkEdit, editKind, parseEditState, parseInbox, previewEdits } from '@augur/core';
import type { ActivityId, DataTier, OutputMode, PolicyEdit, PolicyFile } from '@augur/core';
import { TOOL_TIERS, isTerminal, rank, renderReport, seatLines } from '@augur/dispatch-protocol';
import type { JobRecord, JobRequest, ToolTier, UsageSnapshot } from '@augur/dispatch-protocol';

export interface ToolResult { text: string; isError?: boolean; data?: Record<string, unknown> }

export interface McpDeps {
  call: typeof serviceCall;
  opts: ClientOptions;
  /** The text of policy.json, or null when it is missing. */
  policyText: () => string | null;
  /** The text of usage.json, or null when it is missing. Used by the dry-run pick. */
  usageText?: () => string | null;
  /** The edits agents have asked for, and what the app did with them. The app owns both files; the server only appends to the inbox. */
  inboxText?: () => string | null;
  editStateText?: () => string | null;
  appendInbox?: (lines: string) => void;
  /** Names this server's calls to the service, so a pick and the run that follows it are matched. */
  session: string;
  cwd: string;
  sleep?: (ms: number) => Promise<void>;
}

export interface EditArg { model?: string; provider?: string; field: string; value: unknown; reason?: string }
export interface PolicyEditArgs { edits: EditArg[]; by?: string }
export interface PreviewArgs { activity: string; data_tier: string; edits?: EditArg[]; include_pending?: boolean }

export interface RunArgs {
  route: string; prompt: string; activity: string; data_tier: string; tools?: string; output?: string; cwd?: string; timeout_s?: number; wait_s?: number;
}

const WAIT_DEFAULT_S = 300, WAIT_MAX_S = 900, POLL_MS = 1500;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (text: string, data?: Record<string, unknown>): ToolResult => ({ text, isError: true, ...(data ? { data } : {}) });
const oneOf = <T extends string>(list: readonly T[], v: string | undefined, d?: T): T | null => (v === undefined ? d ?? null : list.includes(v as T) ? (v as T) : null);

async function guarded<T>(work: () => Promise<T>, then: (v: T) => ToolResult): Promise<ToolResult> {
  try { return then(await work()); } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
}

export function createTools(d: McpDeps) {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));

  const jobLine = (j: JobRecord) => `${j.id}  ${j.state}  ${j.route}  ${j.activity}  ${new Date(j.createdAt).toISOString().slice(0, 19)}Z${j.reason ? `  ${j.reason}` : ''}`;

  async function models(): Promise<ToolResult> {
    const text = d.policyText();
    if (!text) return fail('policy.json was not found. Augur writes it when a rule is saved, so open Augur and confirm the rules for your models first.');
    let file: unknown;
    try { file = JSON.parse(text); } catch { return fail('policy.json is not valid JSON.'); }
    const providers = isObj(file) && isObj(file.providers) ? file.providers : {};
    const routes = await d.call('routes', undefined, d.opts).catch(() => null);
    const rows: Array<Record<string, unknown>> = [];
    for (const [pid, p] of Object.entries(providers)) {
      if (!isObj(p) || !isObj(p.models)) continue;
      for (const [label, m] of Object.entries(p.models)) {
        if (!isObj(m)) continue;
        const pause = isObj(m.pause) && typeof m.pause.until === 'string' && Date.parse(m.pause.until) > Date.now() ? m.pause : null;
        rows.push({ model: label, provider: pid, status: m.status, cost: m.cost, dataTier: m.dataTier, askFirst: m.askFirst === true, output: m.output, sandbox: m.sandbox === true,
          activities: m.activities, paused: pause ? { until: pause.until, weightsChanged: isObj(pause.weights) } : null,
          routes: (routes ?? []).filter(r => r.model === label).map(r => ({ name: r.name, canRun: r.problem === null, problem: r.problem })) });
      }
    }
    const usable = rows.filter(r => r.status === 'confirmed' && !(isObj(r.paused) && r.paused.weightsChanged !== true));
    const lines = rows.map(r => `${String(r.model).padEnd(24)} ${String(r.status).padEnd(10)} cost ${String(r.cost).padEnd(9)} data up to ${r.dataTier}${r.askFirst ? ', ask first' : ''}${r.paused ? ', paused' : ''}${(r.routes as unknown[]).length ? '' : ', no route'}`);
    return { text: `${usable.length} of ${rows.length} models can take jobs now.\n${lines.join('\n')}`, data: { models: rows } };
  }

  async function pick(a: { activity?: string; data_tier?: string; task?: string; depth?: string }): Promise<ToolResult> {
    const activity = oneOf(ACTIVITIES, a.activity), dataTier = oneOf(DATA_TIERS, a.data_tier);
    if (a.activity && !activity) return fail(`${a.activity} is not an activity. Use one of: ${ACTIVITIES.join(', ')}.`);
    if (a.data_tier && !dataTier) return fail(`${a.data_tier} is not a data tier. Use one of: ${DATA_TIERS.join(', ')}.`);
    if (!a.task && (!activity || !dataTier)) return fail('Give a task, or both an activity and a data tier, each one of the known values.');
    return guarded(() => d.call('pick', { ...(activity ? { activity: activity as ActivityId } : {}), ...(dataTier ? { dataTier: dataTier as DataTier } : {}), ...(a.depth === 'deep' || a.depth === 'everyday' ? { depth: a.depth } : {}), ...(a.task ? { task: a.task } : {}), session: d.session }, d.opts), r => {
      if ('error' in r) return fail(r.error);
      const lines = r.ranking.map(x => `${x.model.padEnd(24)} score ${x.score.toFixed(2)}  routes ${(r.routes[x.model] ?? []).join(', ') || 'none'}`);
      return { text: r.pick ? `Pick: ${r.pick} (${r.activity}, ${r.dataTier} data). ${[r.reason, ...seatLines(r.seats ?? {})].filter(Boolean).join('\n')}\n${lines.join('\n')}` : `No model is permitted ${r.activity} on ${r.dataTier} data.\n${lines.join('\n')}`, data: r as unknown as Record<string, unknown> };
    });
  }

  async function run(a: RunArgs): Promise<ToolResult> {
    const activity = oneOf(ACTIVITIES, a.activity), dataTier = oneOf(DATA_TIERS, a.data_tier);
    const tools = oneOf(TOOL_TIERS, a.tools, 'read'), output = oneOf(OUTPUT_MODES, a.output, 'text_only');
    if (!activity || !dataTier || !tools || !output) return fail('An activity, a data tier, tools or output is not a known value. The data tier is never assumed: say how sensitive the task is.');
    if (!a.route || !a.prompt) return fail('A route and a prompt are required.');
    const req: JobRequest = { route: a.route, activity: activity as ActivityId, dataTier: dataTier as DataTier, tools: tools as ToolTier, output: output as OutputMode, cwd: a.cwd ?? d.cwd,
      prompt: { text: a.prompt }, ...(a.timeout_s ? { timeoutS: a.timeout_s } : {}), caller: { kind: 'mcp', label: 'augur-mcp', session: d.session } };
    let sub;
    try { sub = await d.call('submit', req, d.opts); } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
    if ('rejected' in sub) return fail(`Rejected (${sub.rejected.code}): ${sub.rejected.reason}`, { rejected: sub.rejected });
    const waitS = Math.min(Math.max(a.wait_s ?? WAIT_DEFAULT_S, 0), WAIT_MAX_S), until = Date.now() + waitS * 1000;
    while (Date.now() < until) {
      const r = await d.call('result', { id: sub.id }, d.opts).catch(() => null);
      if (r && isTerminal(r.job.state)) return describeResult(r.job, r.answer, sub.warnings);
      await sleep(POLL_MS);
    }
    return { text: `Job ${sub.id} is still running. Read it later with augur_job.${sub.warnings.length ? `\nWarnings: ${sub.warnings.join(' ')}` : ''}`, data: { id: sub.id, state: 'running', warnings: sub.warnings } };
  }

  function describeResult(job: JobRecord, answer: string | null, warnings: string[] = []): ToolResult {
    const ok = job.state === 'completed';
    const body = ok ? (answer ?? '(no answer text)') : `The job ended as ${job.state}.${job.reason ? ` ${job.reason}` : ''}${answer ? `\n${answer}` : ''}`;
    return { text: `${warnings.length ? `Warnings: ${warnings.join(' ')}\n` : ''}${body}`, ...(ok ? {} : { isError: true }), data: { id: job.id, state: job.state, answer, reason: job.reason, patch: job.patch, usage: job.usage } };
  }

  async function job(a: { id: string }): Promise<ToolResult> {
    return guarded(() => d.call('result', { id: a.id }, d.opts), r => r ? (isTerminal(r.job.state) ? describeResult(r.job, r.answer) : { text: `Job ${r.job.id} is ${r.job.state}.`, data: { id: r.job.id, state: r.job.state } }) : fail('No such job.'));
  }

  async function jobs(a: { limit?: number }): Promise<ToolResult> {
    return guarded(() => d.call('list', { limit: Math.min(Math.max(a.limit ?? 20, 1), 100) }, d.opts), list => ({ text: list.map(jobLine).join('\n') || 'No jobs yet.', data: { jobs: list } }));
  }

  async function cancel(a: { id: string }): Promise<ToolResult> {
    return guarded(() => d.call('cancel', { id: a.id }, d.opts), r => r ? { text: r.ok ? `Cancel requested (${r.state}).` : `Already ${r.state}.`, data: r as unknown as Record<string, unknown> } : fail('No such job.'));
  }

  async function balance(a: { days?: number }): Promise<ToolResult> {
    return guarded(() => d.call('balance', typeof a.days === 'number' ? { days: a.days } : undefined, d.opts), r => 'error' in r ? fail(r.error) : { text: renderReport(r).join('\n'), data: r as unknown as Record<string, unknown> });
  }

  async function pressure(): Promise<ToolResult> {
    return guarded(() => d.call('pressure', undefined, d.opts), r => r
      ? { text: `Scarcity ${r.scarcity}.\n${Object.entries(r.factors).map(([m, f]) => `${m.padEnd(24)} usage factor ${f.toFixed(2)}`).join('\n')}`, data: r as unknown as Record<string, unknown> }
      : fail('Pressure needs policy.json and usage.json.'));
  }

  async function routes(): Promise<ToolResult> {
    return guarded(() => d.call('routes', undefined, d.opts), r => ({ text: r.map(x => `${x.name.padEnd(14)} ${x.model.padEnd(20)} ${x.adapter}${x.problem ? `   cannot run: ${x.problem}` : ''}`).join('\n') || 'No routes.', data: { routes: r } }));
  }

  // ------------------------------------------------------------------ rules: read, ask for edits, and try them

  const readJson = (text: string | null): unknown => { try { return text ? JSON.parse(text) : null; } catch { return null; } };
  const policyFile = (): PolicyFile | null => { const v = readJson(d.policyText()); return isObj(v) && isObj(v.providers) ? v as unknown as PolicyFile : null; };
  const labelProvider = (file: PolicyFile, model: string, provider?: string): string | null => {
    const hits = Object.entries(file.providers).filter(([id, p]) => (!provider || id === provider) && p.models[model]).map(([id]) => id);
    return hits.length === 1 ? hits[0] as string : null;
  };
  /** The value a field has in policy.json now. */
  const current = (file: PolicyFile, e: PolicyEdit): unknown => {
    const p = file.providers[e.provider];
    if (e.field.startsWith('thresholds.')) return (p?.thresholds as unknown as Record<string, unknown> | undefined)?.[e.field.slice(11)] ?? null;
    const m = p?.models[e.model] as unknown as Record<string, unknown> | undefined;
    if (!m) return null;
    if (e.field.startsWith('activities.')) return isObj(m.activities) ? m.activities[e.field.slice(11)] ?? null : null;
    if (e.field.startsWith('dataHandling.')) return isObj(m.dataHandling) ? m.dataHandling[e.field.slice(13)] ?? null : null;
    return m[e.field] ?? null;
  };
  const toEdit = (file: PolicyFile, a: EditArg, by: string, id: string, at: string): PolicyEdit | { problem: string } => {
    if (!a.field) return { problem: 'An edit names a field.' };
    const thresholds = a.field.startsWith('thresholds.');
    const provider = thresholds ? a.provider ?? (a.model ? labelProvider(file, a.model) : null) ?? '' : labelProvider(file, a.model ?? '', a.provider);
    if (!provider) return { problem: thresholds ? 'A thresholds edit names its provider.' : a.model ? `${a.model} is not in the rules, or more than one provider has it.` : 'An edit names a model.' };
    return { id, at, by, provider, model: thresholds ? '' : a.model as string, field: a.field, value: a.value, ...(a.reason ? { reason: a.reason } : {}) };
  };
  const pending = (): PolicyEdit[] => {
    const seen = new Set(parseEditState(d.editStateText?.() ?? null).seen);
    return parseInbox(d.inboxText?.() ?? null).filter(e => !seen.has(e.id));
  };

  /** The full rules as policy.json holds them, with the edits still waiting and what became of the recent ones. */
  async function policy(): Promise<ToolResult> {
    const file = policyFile();
    if (!file) return fail('policy.json was not found. Augur writes it when a rule is saved, so open Augur and confirm the rules for your models first.');
    const state = parseEditState(d.editStateText?.() ?? null), queued = pending();
    const count = Object.values(file.providers).reduce((n, p) => n + Object.keys(p.models).length, 0);
    const lines = [`${count} models. ${queued.length} edit${queued.length === 1 ? '' : 's'} queued for the app, ${state.held.length} waiting for the owner.`,
      ...state.held.map(h => `  waiting: ${h.model || h.provider} ${h.field} -> ${JSON.stringify(h.value)} (${h.by})`)];
    return { text: lines.join('\n'), data: { updatedAt: file.updatedAt, weights: file.weights, dataTiers: file.dataTiers, activities: file.activities, unreviewed: file.unreviewed, providers: file.providers,
      queued, held: state.held, recent: state.results.slice(-20) } };
  }

  /**
   * Asks for edits to the rules. The server writes nothing but a line in the inbox: the running app checks each edit and applies it through the rules' own code.
   * Weights, pauses, notes and hold rules apply at once. Data tier, ask first, output, sandbox, cost, status, data handling and thresholds wait in the app for the owner.
   */
  async function editPolicy(a: PolicyEditArgs): Promise<ToolResult> {
    const file = policyFile();
    if (!file) return fail('policy.json was not found. Augur writes it when a rule is saved.');
    if (!d.appendInbox) return fail('This server cannot reach the edit inbox.');
    if (!Array.isArray(a.edits) || !a.edits.length) return fail('Give at least one edit.');
    const by = a.by ?? `augur-mcp ${d.session}`, at = new Date().toISOString();
    const rows: Array<Record<string, unknown>> = [], lines: string[] = [];
    for (const [i, arg] of a.edits.slice(0, 20).entries()) {
      const e = toEdit(file, arg, by, `${at}-${d.session}-${i}`, at);
      if ('problem' in e) { rows.push({ model: arg.model, field: arg.field, status: 'rejected', reason: e.problem }); continue; }
      const bad = checkEdit(e, (p, m) => !!file.providers[p]?.models[m]);
      if (bad) { rows.push({ model: e.model || e.provider, field: e.field, status: 'rejected', reason: bad }); continue; }
      lines.push(JSON.stringify(e));
      rows.push({ model: e.model || e.provider, field: e.field, before: current(file, e), value: e.value, status: editKind(e.field) === 'direct' ? 'queued' : 'needs-owner' });
    }
    if (lines.length) d.appendInbox(`${lines.join('\n')}\n`);
    const queued = rows.filter(r => r.status === 'queued').length, held = rows.filter(r => r.status === 'needs-owner').length, rejected = rows.filter(r => r.status === 'rejected').length;
    const text = [`${queued} queued, ${held} waiting for the owner to accept in Augur, ${rejected} rejected.`,
      ...rows.map(r => `${String(r.model ?? '').padEnd(24)} ${String(r.field).padEnd(26)} ${r.status}${r.reason ? `: ${r.reason}` : ` (${JSON.stringify(r.before)} -> ${JSON.stringify(r.value)})`}`),
      queued || held ? 'Augur applies queued edits within a minute while it is running, or when its panel opens. Read augur_policy afterwards for the result.' : ''].filter(Boolean).join('\n');
    return { text, ...(rejected === rows.length ? { isError: true } : {}), data: { edits: rows } };
  }

  /** Ranks the models for an activity and data tier as the rules stand, and again with the given edits applied, without recording a pick. */
  async function pickPreview(a: PreviewArgs): Promise<ToolResult> {
    const file = policyFile();
    if (!file) return fail('policy.json was not found.');
    const activity = oneOf(ACTIVITIES, a.activity), dataTier = oneOf(DATA_TIERS, a.data_tier);
    if (!activity || !dataTier) return fail(`Give an activity (${ACTIVITIES.join(', ')}) and a data tier (${DATA_TIERS.join(', ')}).`);
    const usageValue = readJson(d.usageText?.() ?? null), usage = isObj(usageValue) && isObj(usageValue.providers) ? usageValue as unknown as UsageSnapshot : null;
    const given: PolicyEdit[] = [], problems: string[] = [], at = new Date().toISOString();
    for (const [i, arg] of (a.edits ?? []).entries()) {
      const e = toEdit(file, arg, 'preview', `p${i}`, at);
      if ('problem' in e) problems.push(`${arg.model ?? ''} ${arg.field}: ${e.problem}`); else given.push(e);
    }
    const waiting = a.include_pending ? [...pending(), ...parseEditState(d.editStateText?.() ?? null).held] : [];
    const preview = previewEdits(file, [...waiting, ...given]);
    problems.push(...preview.problems);
    const show = (f: PolicyFile) => rank(f, usage, { activity, dataTier });
    const before = show(file), after = show(preview.file);
    const names = (r: ReturnType<typeof rank>) => r.ranking.map(x => `${x.model} ${x.score.toFixed(2)}`);
    const text = [`${activity} on ${dataTier} data. Now: ${before.pick ?? 'no model is permitted'}. With ${preview.applied} edit${preview.applied === 1 ? '' : 's'}: ${after.pick ?? 'no model is permitted'}.`,
      `Now:        ${names(before).join(', ') || '(none)'}`, `With edits: ${names(after).join(', ') || '(none)'}`, ...(problems.length ? ['Not applied:', ...problems.map(p => `  ${p}`)] : [])].join('\n');
    return { text, data: { activity, dataTier, now: before, withEdits: after, applied: preview.applied, problems } };
  }

  return { models, pick, run, job, jobs, cancel, pressure, balance, routes, policy, editPolicy, pickPreview };
}

export type Tools = ReturnType<typeof createTools>;
