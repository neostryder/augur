import { tierNote } from '@augur/dispatch-protocol';
import type { Adapter, ExtractInput, Extraction, JobRequest, LaunchPlan, PlanContext, RouteConfig, UsageReport } from '@augur/dispatch-protocol';
import { insidePath, sandboxOptions, sbxCommand, sbxPrefix, workRoot } from './sandbox.js';
import { optNum, optStr } from './util.js';

interface McodeResult { type?: string; status?: string; output?: string; error?: unknown; usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number } }

/**
 * MiniMax Code (`mcode exec`) inside a Docker Sandboxes sandbox. The job runs on a copy of the working directory and what it changes comes back as a patch.
 * The sandbox is the boundary, so mcode always runs with its permission policy set to full, and a read job is limited by the prompt only.
 * Route options: `sandbox`, `workRoot`, `model`, `effort`, `maxSteps`, `sbx`, `envAllow`.
 */
export const mcodeSbx: Adapter = {
  id: 'mcode-sbx', transport: 'exec',
  capabilities: { permissionRequests: false, sessions: false, reportsUsage: true, sandboxed: true, isolatesWorkspace: true },
  envAllow: [],
  isolation: { root: workRoot },
  validate: sandboxOptions,
  plan(request: JobRequest, route: RouteConfig, ctx: PlanContext): LaunchPlan {
    const sbx = sbxCommand(route) as string, ws = ctx.workspace as string;
    const steps = optNum(route.options, 'maxSteps') ?? (request.tools === 'read' ? 60 : 400);
    const args = [...sbxPrefix(route), 'exec', '-i', '-e', 'NO_COLOR=1', '-w', insidePath(ws), optStr(route.options, 'sandbox') as string,
      'bash', '-lc', 'exec "$@"', 'mcode-run', 'mcode', 'exec', '--input', '-', '--model', optStr(route.options, 'model') as string,
      '--max-steps', String(steps), '--permission', 'full', '--output-format', 'json'];
    const effort = optStr(route.options, 'effort');
    if (effort) args.push('--effort', effort);
    return { command: sbx, args, cwd: request.cwd, env: {}, stdin: tierNote(request.tools === 'read' ? 'read' : 'full', ctx.prompt) };
  },
  extract(input: ExtractInput): Extraction {
    // sbx prints a status line before the result.
    const line = input.stdout.split(String.fromCharCode(10)).find(l => l.startsWith('{"schemaVersion"'));
    let r: McodeResult | null = null;
    try { r = line ? JSON.parse(line) as McodeResult : null; } catch { r = null; }
    if (!r) return { answer: null, usage: null, failure: 'mcode did not return a result' };
    const u = r.usage;
    let usage: UsageReport | null = null;
    if (u) {
      // mcode counts cached reads apart from input, so the total input is their sum.
      usage = { inputTokens: (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0), outputTokens: u.outputTokens ?? 0, source: 'reported' };
      if (u.cacheReadTokens) usage.cachedReadTokens = u.cacheReadTokens;
      if (u.cacheWriteTokens) usage.cachedWriteTokens = u.cacheWriteTokens;
      if (u.reasoningTokens) usage.reasoningTokens = u.reasoningTokens;
    }
    return { answer: r.output ?? null, usage, ...(r.status && r.status !== 'succeeded' ? { failure: `mcode finished with status ${r.status}` } : {}) };
  },
};
