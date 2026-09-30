// What the MCP server offers, as plain functions over the dispatch service. Kept apart from the protocol so each tool can be tested without a client.
// Every tool goes through the same service and the same rules as the `augur` command. The server holds no authority of its own: it cannot skip the pick
// check, claim that a person named a model, or turn a rule off.
import { call as serviceCall } from '@augur/augurd/client';
import type { ClientOptions } from '@augur/augurd/client';
import { ACTIVITIES, DATA_TIERS, OUTPUT_MODES } from '@augur/core';
import type { ActivityId, DataTier, OutputMode } from '@augur/core';
import { TOOL_TIERS, isTerminal } from '@augur/dispatch-protocol';
import type { JobRecord, JobRequest, ToolTier } from '@augur/dispatch-protocol';

export interface ToolResult { text: string; isError?: boolean; data?: Record<string, unknown> }

export interface McpDeps {
  call: typeof serviceCall;
  opts: ClientOptions;
  /** The text of policy.json, or null when it is missing. */
  policyText: () => string | null;
  /** Names this server's calls to the service, so a pick and the run that follows it are matched. */
  session: string;
  cwd: string;
  sleep?: (ms: number) => Promise<void>;
}

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

  async function pick(a: { activity?: string; data_tier?: string; task?: string }): Promise<ToolResult> {
    const activity = oneOf(ACTIVITIES, a.activity), dataTier = oneOf(DATA_TIERS, a.data_tier);
    if (a.activity && !activity) return fail(`${a.activity} is not an activity. Use one of: ${ACTIVITIES.join(', ')}.`);
    if (a.data_tier && !dataTier) return fail(`${a.data_tier} is not a data tier. Use one of: ${DATA_TIERS.join(', ')}.`);
    if (!a.task && (!activity || !dataTier)) return fail('Give a task, or both an activity and a data tier, each one of the known values.');
    return guarded(() => d.call('pick', { ...(activity ? { activity: activity as ActivityId } : {}), ...(dataTier ? { dataTier: dataTier as DataTier } : {}), ...(a.task ? { task: a.task } : {}), session: d.session }, d.opts), r => {
      if ('error' in r) return fail(r.error);
      const lines = r.ranking.map(x => `${x.model.padEnd(24)} score ${x.score.toFixed(2)}  routes ${(r.routes[x.model] ?? []).join(', ') || 'none'}`);
      return { text: r.pick ? `Pick: ${r.pick} (${r.activity}, ${r.dataTier} data).\n${lines.join('\n')}` : `No model is permitted ${r.activity} on ${r.dataTier} data.\n${lines.join('\n')}`, data: r as unknown as Record<string, unknown> };
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

  async function pressure(): Promise<ToolResult> {
    return guarded(() => d.call('pressure', undefined, d.opts), r => r
      ? { text: `Scarcity ${r.scarcity}.\n${Object.entries(r.factors).map(([m, f]) => `${m.padEnd(24)} usage factor ${f.toFixed(2)}`).join('\n')}`, data: r as unknown as Record<string, unknown> }
      : fail('Pressure needs policy.json and usage.json.'));
  }

  async function routes(): Promise<ToolResult> {
    return guarded(() => d.call('routes', undefined, d.opts), r => ({ text: r.map(x => `${x.name.padEnd(14)} ${x.model.padEnd(20)} ${x.adapter}${x.problem ? `   cannot run: ${x.problem}` : ''}`).join('\n') || 'No routes.', data: { routes: r } }));
  }

  return { models, pick, run, job, jobs, cancel, pressure, routes };
}

export type Tools = ReturnType<typeof createTools>;
