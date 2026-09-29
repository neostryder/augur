import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Adapter, ExtractInput, Extraction, JobRequest, LaunchPlan, PlanContext, RouteConfig, UsageReport } from '@augur/dispatch-protocol';
import { optNum, optStr, resolveExecutable } from './util.js';

interface GrokEnvelope { text?: string; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; reasoning_tokens?: number }; total_cost_usd?: number; is_error?: boolean }

function command(route: RouteConfig): { command: string; prefix: string[] } | null {
  const c = optStr(route.options, 'command');
  return c ? { command: c, prefix: [] } : resolveExecutable('grok');
}

/**
 * Grok Build in single-turn mode. The prompt is read from a file, because a long one as an argument would overrun the Windows command line.
 * A write job runs with every tool auto-approved. A read job allows Read and Grep and denies Edit and Bash, so a blocked call comes back to the model as a plain denial.
 * Route options: `model`, `effort`, `maxTurns`, `command`, `envAllow`.
 */
export const grokExec: Adapter = {
  id: 'grok-exec', transport: 'exec',
  capabilities: { permissionRequests: false, sessions: false, reportsUsage: true, sandboxed: false, isolatesWorkspace: false },
  envAllow: ['GROK_HOME', 'XAI_API_KEY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE'],
  validate(route: RouteConfig) {
    if (!optStr(route.options, 'model')) return 'route option model is required';
    return command(route) ? null : 'grok was not found on PATH; set the command route option';
  },
  plan(request: JobRequest, route: RouteConfig, ctx: PlanContext): LaunchPlan {
    const exe = command(route) as { command: string; prefix: string[] };
    const promptPath = join(ctx.jobDir, 'prompt.md');
    const turns = optNum(route.options, 'maxTurns') ?? (request.tools === 'read' ? 60 : 400);
    const args = [...exe.prefix, '--prompt-file', promptPath, '-m', optStr(route.options, 'model') as string, '--output-format', 'json', '--cwd', request.cwd];
    if (request.tools === 'read') args.push('--max-turns', String(turns), '--allow', 'Read', '--allow', 'Grep', '--deny', 'Edit', '--deny', 'Bash(*)');
    else args.push('--always-approve', '--max-turns', String(turns));
    const effort = optStr(route.options, 'effort');
    if (effort) args.push('--reasoning-effort', effort);
    return { command: exe.command, args, cwd: request.cwd, env: {}, stdin: null, files: [{ name: 'prompt.md', content: ctx.prompt }] };
  },
  extract(input: ExtractInput): Extraction {
    let env: GrokEnvelope | null = null;
    try { env = JSON.parse(input.stdout.trim()) as GrokEnvelope; } catch { env = null; }
    if (!env) return { answer: input.stdout.trim() || null, usage: null };
    const cachedRead = env.usage?.cache_read_input_tokens ?? 0;
    const usage: UsageReport = { inputTokens: (env.usage?.input_tokens ?? 0) + cachedRead, outputTokens: env.usage?.output_tokens ?? 0, source: 'reported' };
    if (cachedRead) usage.cachedReadTokens = cachedRead;
    if (env.usage?.reasoning_tokens) usage.reasoningTokens = env.usage.reasoning_tokens;
    if (typeof env.total_cost_usd === 'number') { usage.costUsd = env.total_cost_usd; usage.currency = 'USD'; }
    return { answer: env.text?.trim() || null, usage, ...(env.is_error ? { failure: 'grok reported an error result' } : {}) };
  },
  version(route: RouteConfig) {
    const exe = command(route);
    if (!exe) return null;
    try { return execFileSync(exe.command, [...exe.prefix, '--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true }).split('\n')[0]?.trim() ?? null; } catch { return null; }
  },
};
