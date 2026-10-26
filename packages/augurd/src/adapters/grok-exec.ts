import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Adapter, ExtractInput, Extraction, JobRequest, LaunchPlan, PlanContext, RouteConfig, UsageReport } from '@augur/dispatch-protocol';
import { optNum, optStr, resolveExecutable } from './util.js';

interface GrokEnvelope { text?: string; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; reasoning_tokens?: number }; total_cost_usd?: number; is_error?: boolean; sessionId?: string }

function command(route: RouteConfig): { command: string; prefix: string[] } | null {
  const c = optStr(route.options, 'command');
  return c ? { command: c, prefix: [] } : resolveExecutable('grok');
}

/**
 * Grok Build in single-turn mode. The prompt is read from a file, because a long one as an argument would overrun the Windows command line.
 * A write job runs with every tool auto-approved. A read job allows Read and Grep and denies Edit and Bash, so a blocked call comes back to the model as a plain denial.
 * A named conversation passes --session-id on the first turn and --resume on later turns.
 * Route options: `model`, `effort`, `maxTurns`, `command`, `envAllow`.
 */
export const grokExec: Adapter = {
  id: 'grok-exec', charterEngine: 'grok', transport: 'exec', toolkit: 'registered',
  capabilities: { permissionRequests: false, sessions: true, reportsUsage: true, sandboxed: false, isolatesWorkspace: false, enforcesReadOnly: true },
  envAllow: ['GROK_HOME', 'XAI_API_KEY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE'],
  validate(route: RouteConfig) {
    if (!optStr(route.options, 'model')) return 'route option model is required';
    return command(route) ? null : 'grok was not found on PATH; set the command route option';
  },
  plan(request: JobRequest, route: RouteConfig, ctx: PlanContext): LaunchPlan {
    const exe = command(route) as { command: string; prefix: string[] };
    const promptPath = join(ctx.jobDir, 'prompt.md');
    const turns = optNum(route.options, 'maxTurns') ?? (request.tools === 'read' || request.tools === 'none' ? 60 : 400);
    const args = [...exe.prefix];
    if (ctx.resume?.fresh) {
      if (!ctx.resume.id) throw new Error(`conversation ${ctx.resume.name} needs a session id`);
      args.push('--session-id', ctx.resume.id);
    } else if (ctx.resume) {
      if (!ctx.resume.id) throw new Error(`conversation ${ctx.resume.name} has no session id to resume`);
      args.push('--resume', ctx.resume.id);
    }
    args.push('--prompt-file', promptPath, '-m', optStr(route.options, 'model') as string, '--output-format', 'json', '--cwd', request.cwd);
    if (request.tools === 'none') args.push('--max-turns', String(turns), '--deny', 'Read', '--deny', 'Grep', '--deny', 'Edit', '--deny', 'Bash(*)');
    else if (request.tools === 'read') args.push('--max-turns', String(turns), '--allow', 'Read', '--allow', 'Grep', '--deny', 'Edit', '--deny', 'Bash(*)');
    else args.push('--always-approve', '--max-turns', String(turns));
    const effort = optStr(route.options, 'effort');
    if (effort) args.push('--reasoning-effort', effort);
    // Grok has no flag that adds an MCP server for one run, so a toolkit's server must be registered with it already. The denied tools still apply.
    for (const [name, s] of Object.entries(ctx.toolkit?.mcp ?? {})) for (const t of s.denyTools ?? []) args.push('--deny', `MCPTool(${name}__${t})`);
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
    const sessionId = typeof env.sessionId === 'string' && env.sessionId ? env.sessionId : undefined;
    return { answer: env.text?.trim() || null, usage, ...(env.is_error ? { failure: 'grok reported an error result' } : {}), ...(sessionId ? { sessionId } : {}) };
  },
  version(route: RouteConfig) {
    const exe = command(route);
    if (!exe) return null;
    try { return execFileSync(exe.command, [...exe.prefix, '--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true }).split('\n')[0]?.trim() ?? null; } catch { return null; }
  },
};
