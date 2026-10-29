// The MCP protocol layer: names, descriptions and input shapes for the tools in tools.ts. Claude Code, Claude Desktop and any other MCP client see these.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ACTIVITIES, DATA_TIERS, OUTPUT_MODES } from '@augur/core';
import { z } from 'zod';
import type { ToolResult, Tools } from './tools.js';

export const INSTRUCTIONS = [
  'Augur runs work on other models under the rules its owner set. List the models, pick one for the task, then run it.',
  'Every run needs an activity and a data tier, and the data tier is never assumed: say how sensitive the task is, and pick the highest tier the task touches. A model is only used for data at or below the tier its rules allow.',
  'Call augur_pick first, and run the route it points to. A run is refused if its model was not picked for this session in the last hour, or if the rules do not allow it. A refusal names the reason, and the rules cannot be argued with from here.',
  'A read job cannot change files. Ask for write tools or file output only when the task needs them.',
  'To change the rules, use augur_policy_edit: weights and pauses apply within a minute, and anything that widens what data a model may see waits for the owner to accept it in Augur. Test a change first with augur_pick_preview.',
  'To add a route, use augur_route_add. It never takes a key, it never changes a route that already exists, and its model stays unreviewed until the owner confirms it in Model rules and sets the key with augur key set.',
].join(' ');

const out = (r: ToolResult) => ({ content: [{ type: 'text' as const, text: r.text }], ...(r.data ? { structuredContent: r.data } : {}), ...(r.isError ? { isError: true } : {}) });
const runSchema = z.object({
  route: z.string().describe('A route name from augur_pick or augur_models.'),
  prompt: z.string().describe('The full prompt for the model.'),
  activity: z.enum(ACTIVITIES).describe('What the work is.'),
  data_tier: z.enum(DATA_TIERS).describe('The most sensitive data the prompt or the folder contains.'),
  tools: z.enum(['read', 'write', 'full']).optional().describe('read (default), write, or full. The no-tools tier is available only on adapters that can enforce it.'),
  output: z.enum(OUTPUT_MODES).optional().describe('text_only (default), patch_only or write_files.'),
  cwd: z.string().optional().describe('The folder the job works in. Defaults to the server\'s folder.'),
  timeout_s: z.number().int().positive().optional().describe('Seconds the job may run before it is stopped.'),
  wait_s: z.number().int().min(0).max(900).optional().describe('Seconds to wait for the answer. 300 by default.'),
  packs: z.array(z.string()).optional().describe('Charter packs to include, by name.'),
  no_charter: z.boolean().optional().describe('Send the prompt with no charter.'),
  conversation: z.string().optional().describe('Name of a conversation to open or resume. It stays on the route that opened it, and only Grok and Codex routes keep one.'),
  attachments: z.array(z.string()).max(16).optional().describe('Absolute paths of files to send with the prompt, inside cwd. Text files are added to the prompt, images are shown to a model that sees them, and one audio file is transcribed on a transcribe route. An embed job returns the path of the saved vectors.'),
  urgent: z.boolean().optional().describe('The job is wanted now. A local gateway then gives it its normal priority instead of the low one background work gets.'),
}).passthrough();

export function buildServer(tools: Tools, version: string): McpServer {
  const server = new McpServer({ name: 'augur', version }, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool('augur_models', {
    title: 'List models', annotations: readOnly,
    description: 'Lists every model in the rules with its status, cost, the most sensitive data it may see, whether it is paused, and the routes that reach it. Includes live Cogitator roles, chains, uses, strengths, limits, and offers that only the owner can accept. Only confirmed models that are not paused can take jobs.',
  }, async () => out(await tools.models()));

  server.registerTool('augur_prose_add', { title: 'Add prose request', description: 'Adds a prose request to Augur queue.', inputSchema: { item: z.record(z.string(), z.unknown()) } }, async ({ item }) => out(await tools.proseAdd(item)));
  server.registerTool('augur_prose_list', { title: 'List prose requests', annotations: readOnly, description: 'Lists queued prose requests.', inputSchema: { status: z.enum(['queued', 'awaiting-approval', 'running', 'drafted', 'failed']).optional() } }, async (a) => out(await tools.proseList(a)));
  server.registerTool('augur_prose_status', { title: 'Prose queue status', annotations: readOnly, description: 'Shows prose queue counts and whether a batch is due.' }, async () => out(await tools.proseStatus()));
  server.registerTool('alias_list', {
    title: 'List aliases', annotations: readOnly,
    description: 'Lists model aliases with their series pattern and current provider model id.',
  }, async () => out(await tools.aliases()));

  server.registerTool('augur_pick', {
    title: 'Pick a model', annotations: readOnly,
    description: 'Ranks the models permitted for an activity and data tier by the rules and current plan usage, gives each its odds, and draws the pick by those odds. A named model always wins, and best_only takes the top score. For a caller-chosen role, first call with the role to see candidates, then call again with model set to one listed candidate to record the pick. Set snippet when drafting one sentence or one bullet with no other prose, so the prose routes get no extra weight. Give an activity and a data tier, or describe the task and Augur classifies it.',
    inputSchema: {
      activity: z.enum(ACTIVITIES).optional().describe('What the work is.'),
      data_tier: z.enum(DATA_TIERS).optional().describe('The most sensitive data the task touches.'),
      task: z.string().optional().describe('A description of the task, when no activity and data tier are given. Its text goes to the classifier the owner chose.'),
      depth: z.enum(['routine', 'everyday', 'deep', 'core']).optional().describe('How much the task weighs: routine (glue, plumbing, small edits), everyday (review, research, summaries), deep (hard reasoning, substantial coding), or core (an engine, core logic, security-critical code). Heavier work leans toward strong models. Left out, the classifier judges the task description, or the default for the activity applies.'),
      best_only: z.boolean().optional().describe('Take the top score. Left out, the pick is drawn from the odds.'),
      snippet: z.boolean().optional().describe('One sentence or one bullet, with no prose batch to attach it to.'),
      role: z.string().optional().describe('Restrict the pick to this owner-defined role.'),
      model: z.string().optional().describe('Name a model from the role candidates. For a caller-chosen role, this second pick records the caller choice.'),
    },
  }, async (a) => out(await tools.pick(a)));

  server.registerTool('augur_run', {
    title: 'Run a job',
    description: 'Runs a prompt on a route and returns the answer. It waits for the job up to wait_s seconds; a longer job keeps running and is read later with augur_job. Tools default to read only and output to text.',
    inputSchema: runSchema,
  }, async (a) => out(await tools.run(a)));

  server.registerTool('augur_job', {
    title: 'Read a job', annotations: readOnly,
    description: 'Returns the state of a job and, once it has finished, its answer. When that job was retried, the answer is the last job in the chain.',
    inputSchema: { id: z.string().describe('The job id.') },
  }, async (a) => out(await tools.job(a)));

  server.registerTool('augur_jobs', {
    title: 'List jobs', annotations: readOnly,
    description: 'Lists recent jobs, newest first.',
    inputSchema: { limit: z.number().int().min(1).max(100).optional().describe('How many to list. 20 by default.') },
  }, async (a) => out(await tools.jobs(a)));

  server.registerTool('augur_cancel', {
    title: 'Cancel a job', annotations: { destructiveHint: true, openWorldHint: false },
    description: 'Asks a running job to stop.',
    inputSchema: { id: z.string().describe('The job id.') },
  }, async (a) => out(await tools.cancel(a)));

  server.registerTool('augur_balance', {
    title: 'Model balance report', annotations: readOnly,
    description: 'Shows what the automatic balance is doing. Each provider paced against a usage window gets its stance, how far each window runs ahead of or behind pace, its boost and its rough odds. The report also gives Copilot\'s spend this month, how each provider is treated, where each kind of work goes now, and recent picks. Read only.',
    inputSchema: { days: z.number().int().min(1).max(90).optional().describe('How many days of picks to summarize. Defaults to 7.') },
  }, async (a) => out(await tools.balance(a)));

  server.registerTool('gate_status', { title: 'Premium gate status', annotations: readOnly, description: 'Shows each premium provider gate, its pace gap, gated labels and last approval.' }, async () => out(await tools.gateStatus()));
  server.registerTool('gate_report', { title: 'Premium gate report', annotations: readOnly, description: 'Shows premium gate event counts and cost totals.' }, async () => out(await tools.gateReport()));

  server.registerTool('augur_backlog_add', {
    title: 'Add premium backlog item', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Queues agent-authored work for owner approval and a later surplus window. It validates the item against the service backlog schema. MCP cannot run, release, drop or approve backlog items and cannot set released.',
    inputSchema: { item: z.record(z.string(), z.unknown()).describe('A backlog item with requester, repo, task, prompt, activity, data, route, cwd, tools and output fields; lower is optional, estimate is 0 to 100 points of the provider weekly allowance (default 1), and deadline is optional. The service assigns author and approval status.') },
  }, async (a) => out(await tools.backlogAdd(a)));
  server.registerTool('augur_backlog_list', {
    title: 'List premium backlog items', annotations: readOnly,
    description: 'Lists premium backlog items. MCP cannot run, release, drop or approve backlog items.',
    inputSchema: { status: z.enum(['awaiting-approval', 'queued', 'running', 'done', 'failed', 'cancelled', 'expired']).optional() },
  }, async (a) => out(await tools.backlogList(a)));
  server.registerTool('augur_backlog_status', {
    title: 'Premium backlog status', annotations: readOnly,
    description: 'Shows backlog counts, queued items that fit open window budgets and the next expected window. MCP cannot run, release, drop or approve backlog items.',
  }, async () => out(await tools.backlogStatus()));

  server.registerTool('augur_resets', {
    title: 'Reset ledger', annotations: readOnly,
    description: 'Returns recent reset events and a summary of the whole ledger, optionally for one provider. It never changes anything.',
    inputSchema: {
      provider: z.string().min(1).optional().describe('The provider id. Defaults to all providers.'),
      limit: z.number().int().min(1).optional().describe('The most recent events to return. Defaults to 200, capped at 1000.'),
    },
  }, async (a) => out(await tools.resets(a)));

  server.registerTool('augur_pressure', {
    title: 'Plan usage pressure', annotations: readOnly,
    description: 'Shows how much room each model has under its provider\'s plan right now. A low factor means its provider is close to a limit.',
  }, async () => out(await tools.pressure()));

  server.registerTool('augur_routes', {
    title: 'List routes', annotations: readOnly,
    description: 'Lists the routes, the model and adapter behind each, and any reason a route cannot run.',
  }, async () => out(await tools.routes()));

  server.registerTool('augur_route_add', {
    title: 'Add a route',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Adds one route and, optionally, its model. The model stays unreviewed, so nothing can run it until the owner confirms it in Model rules. A key is never accepted, and an existing route name is refused with nothing written. Set the key afterwards with augur key set.',
    inputSchema: {
      name: z.string().describe('The route name. A name that already exists is refused.'),
      adapter: z.string().describe('An adapter this service has, such as codex-exec.'),
      provider: z.string().describe('The provider id the model is filed under.'),
      options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Adapter options. A name that looks like a key is refused.'),
      model: z.object({
        label: z.string().describe('The model label. A label with no slash is filed as provider/label.'),
        id: z.string().describe('The model id the API expects.'),
        name: z.string().optional().describe('A display name.'),
      }).optional().describe('The model to add. It stays unreviewed until the owner confirms it in Model rules.'),
      balance_url: z.string().optional().describe('Balance URL for a provider that has no usage reading. The reading stays off until the owner sets its key.'),
      balance_path: z.string().optional().describe('Path into the balance reply, such as $.balance.'),
    },
  }, async (a) => out(await tools.routeAdd(a)));

  const editShape = z.object({
    model: z.string().optional().describe('The route label as augur_policy lists it, such as codex/sol. Leave out for a provider thresholds edit.'),
    provider: z.string().optional().describe('Only needed for a thresholds edit, or when two providers carry the same label.'),
    path: z.array(z.string()).optional().describe('Only with field "balance": the balance setting, one name per level, such as ["tilt", "deep", "strong"] or ["tiers", "codex/gpt-6.1-sol"]. docs/configuring.md lists them. "inherit" puts one back to the starting value.'),
    field: z.string().describe('balance (with a path) sets a balance rule and applies at the default approval level. activities.<activity> (a weight, null to block it, or "inherit"), pause, notes, useAfter apply at once. dataTier, askFirst, output, sandbox, effort, cost, status, dataHandling.<part> and thresholds.<warnPct|denyPct|minBalance> wait for the owner to accept them in Augur.'),
    value: z.any().describe('The new value. Weights are last_resort, occasional, normal, often or preferred. Use "inherit" to go back to the provider default.'),
    reason: z.string().optional().describe('Why, shown to the owner next to a held edit.'),
  });

  server.registerTool('augur_policy', {
    title: 'Read the rules', annotations: readOnly,
    description: 'Returns the full rules from policy.json: every model with its status, data tier, weights, pause, data handling, hold rules and notes, each provider\'s thresholds, the edits queued for the app, the ones waiting for the owner, and what became of recent ones.',
  }, async () => out(await tools.policy()));

  server.registerTool('augur_policy_edit', {
    title: 'Ask for rule edits', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Asks Augur to change rules. Nothing is written to the rules from here: each edit goes to an inbox that the running app checks, then applies through its own rules code, which stamps it and records it in the history. Weights, pauses, notes and hold rules apply within a minute. Anything that changes what data a model may see or whether it runs waits for the owner to accept it in Augur, so an agent cannot widen its own access. The result gives each edit\'s value before and after the request.',
    inputSchema: { edits: z.array(editShape).min(1).max(20).describe('The edits, applied in order.') },
  }, async (a) => out(await tools.editPolicy(a)));

  server.registerTool('augur_pick_preview', {
    title: 'Try a pick under edits', annotations: readOnly,
    description: 'Ranks the models for an activity and data tier as the rules stand now and again with the given edits applied, with each route\'s odds. Nothing is drawn or recorded, and the preview does not count as a pick for running jobs. With include_pending it also applies the edits already queued or waiting for the owner.',
    inputSchema: {
      activity: z.enum(ACTIVITIES).describe('What the work is.'),
      data_tier: z.enum(DATA_TIERS).describe('The most sensitive data the task touches.'),
      edits: z.array(editShape).max(20).optional().describe('Edits to try. A preview cannot use "inherit".'),
      include_pending: z.boolean().optional().describe('Also apply the edits queued or waiting for the owner.'),
      best_only: z.boolean().optional().describe('Accepted and ignored. A preview never draws, so it always reports the top score as the pick.'),
      snippet: z.boolean().optional().describe('One sentence or one bullet, with no prose batch to attach it to.'),
    },
  }, async (a) => out(await tools.pickPreview(a)));

  return server;
}
