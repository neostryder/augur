// The MCP protocol layer: names, descriptions and input shapes for the tools in tools.ts. Claude Code, Claude Desktop and any other MCP client see these.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ACTIVITIES, DATA_TIERS, OUTPUT_MODES } from '@augur/core';
import { TOOL_TIERS } from '@augur/dispatch-protocol';
import { z } from 'zod';
import type { ToolResult, Tools } from './tools.js';

export const INSTRUCTIONS = [
  'Augur runs work on other models under the rules its owner set. List the models, pick one for the task, then run it.',
  'Every run needs an activity and a data tier, and the data tier is never assumed: say how sensitive the task is, and pick the highest tier the task touches. A model is only used for data at or below the tier its rules allow.',
  'Call augur_pick first, and run the route it points to. A run is refused if its model was not picked for this session in the last hour, or if the rules do not allow it. A refusal names the reason, and the rules cannot be argued with from here.',
  'A read job cannot change files. Ask for write tools or file output only when the task needs them.',
  'To change the rules, use augur_policy_edit: weights and pauses apply within a minute, and anything that widens what data a model may see waits for the owner to accept it in Augur. Test a change first with augur_pick_preview.',
].join(' ');

const out = (r: ToolResult) => ({ content: [{ type: 'text' as const, text: r.text }], ...(r.data ? { structuredContent: r.data } : {}), ...(r.isError ? { isError: true } : {}) });

export function buildServer(tools: Tools, version: string): McpServer {
  const server = new McpServer({ name: 'augur', version }, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool('augur_models', {
    title: 'List models', annotations: readOnly,
    description: 'Lists every model in the rules with its status, cost, the most sensitive data it may see, whether it is paused, and the routes that reach it. Only confirmed models that are not paused can take jobs.',
  }, async () => out(await tools.models()));

  server.registerTool('augur_pick', {
    title: 'Pick a model', annotations: readOnly,
    description: 'Ranks the models permitted for an activity and data tier, weighing the rules and current plan usage, and names the routes to run the best one. Give an activity and a data tier, or a description of the task and Augur classifies it.',
    inputSchema: {
      activity: z.enum(ACTIVITIES).optional().describe('What the work is.'),
      data_tier: z.enum(DATA_TIERS).optional().describe('The most sensitive data the task touches.'),
      task: z.string().optional().describe('A description of the task, when no activity and data tier are given. Its text goes to the classifier the owner chose.'),
      depth: z.enum(['deep', 'everyday']).optional().describe('Deep for hard reasoning and serious coding, everyday for routine review, research and summaries. Left out, the activity decides.'),
    },
  }, async (a) => out(await tools.pick(a)));

  server.registerTool('augur_run', {
    title: 'Run a job',
    description: 'Runs a prompt on a route and returns the answer. It waits for the job up to wait_s seconds; a longer job keeps running and is read later with augur_job. Tools default to read only and output to text.',
    inputSchema: {
      route: z.string().describe('A route name from augur_pick or augur_models.'),
      prompt: z.string().describe('The full prompt for the model.'),
      activity: z.enum(ACTIVITIES).describe('What the work is.'),
      data_tier: z.enum(DATA_TIERS).describe('The most sensitive data the prompt or the folder contains.'),
      tools: z.enum(TOOL_TIERS as unknown as [string, ...string[]]).optional().describe('read (default), write, or full.'),
      output: z.enum(OUTPUT_MODES).optional().describe('text_only (default), patch_only or write_files.'),
      cwd: z.string().optional().describe('The folder the job works in. Defaults to the server\'s folder.'),
      timeout_s: z.number().int().positive().optional().describe('Seconds the job may run before it is stopped.'),
      wait_s: z.number().int().min(0).max(900).optional().describe('Seconds to wait for the answer. 300 by default.'),
    },
  }, async (a) => out(await tools.run(a)));

  server.registerTool('augur_job', {
    title: 'Read a job', annotations: readOnly,
    description: 'Returns the state of a job and, once it has finished, its answer.',
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
    description: 'Shows what the automatic balance is doing: where each kind of work goes now, how Claude is pacing against its week and 5-hour window, how much Copilot has cost this month, each provider stance, and what recent picks were. Read only.',
    inputSchema: { days: z.number().int().min(1).max(90).optional().describe('How many days of picks to summarize. Defaults to 7.') },
  }, async (a) => out(await tools.balance(a)));

  server.registerTool('augur_pressure', {
    title: 'Plan usage pressure', annotations: readOnly,
    description: 'Shows how much room each model has under its provider\'s plan right now. A low factor means its provider is close to a limit.',
  }, async () => out(await tools.pressure()));

  server.registerTool('augur_routes', {
    title: 'List routes', annotations: readOnly,
    description: 'Lists the routes, the model and adapter behind each, and any reason a route cannot run.',
  }, async () => out(await tools.routes()));

  const editShape = z.object({
    model: z.string().optional().describe('The route label as augur_policy lists it, such as codex/sol. Leave out for a provider thresholds edit.'),
    provider: z.string().optional().describe('Only needed for a thresholds edit, or when two providers carry the same label.'),
    field: z.string().describe('activities.<activity> (a weight, null to block it, or "inherit"), pause, notes, useAfter apply at once. dataTier, askFirst, output, sandbox, effort, cost, status, dataHandling.<part> and thresholds.<warnPct|denyPct|minBalance> wait for the owner to accept them in Augur.'),
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
    description: 'Ranks the models for an activity and data tier as the rules stand now and again with the given edits applied, so a change can be tested before it lands. It records nothing and does not count as a pick for running jobs. With include_pending it also applies the edits already queued or waiting for the owner.',
    inputSchema: {
      activity: z.enum(ACTIVITIES).describe('What the work is.'),
      data_tier: z.enum(DATA_TIERS).describe('The most sensitive data the task touches.'),
      edits: z.array(editShape).max(20).optional().describe('Edits to try. A preview cannot use "inherit".'),
      include_pending: z.boolean().optional().describe('Also apply the edits queued or waiting for the owner.'),
    },
  }, async (a) => out(await tools.pickPreview(a)));

  return server;
}
