import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Adapter, ExtractInput, Extraction, JobRequest, LaunchPlan, PlanContext, RouteConfig, UsageReport } from '@augur/dispatch-protocol';
import { optStr, readTextIfExists, resolveExecutable } from './util.js';

/** Hermes takes its prompt only through -z, so a long one is handed over as a file to read. */
const INLINE_LIMIT = 12000;

interface HermesUsage {
  input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number; reasoning_tokens?: number;
  estimated_cost_usd?: number; cost_source?: string; completed?: boolean; failed?: boolean;
  auxiliary?: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number; reasoning_tokens?: number };
}

function command(route: RouteConfig): { command: string; prefix: string[] } | null {
  const c = optStr(route.options, 'command');
  return c ? { command: c, prefix: [] } : resolveExecutable('hermes');
}

/**
 * Hermes Agent, one-shot (`hermes -z`). The answer is on standard output and usage comes from `--usage-file`.
 * Route options: `model`, `command`, `envAllow` (extra environment names the harness needs).
 */
export const hermesExec: Adapter = {
  id: 'hermes-exec', transport: 'exec',
  capabilities: { permissionRequests: false, sessions: false, reportsUsage: true, sandboxed: false, isolatesWorkspace: false, enforcesReadOnly: false },
  envAllow: ['HERMES_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE'],
  validate(route: RouteConfig) {
    if (!optStr(route.options, 'model')) return 'route option model is required';
    return command(route) ? null : 'hermes was not found on PATH; set the command route option';
  },
  plan(request: JobRequest, route: RouteConfig, ctx: PlanContext): LaunchPlan {
    const exe = command(route) as { command: string; prefix: string[] };
    const files: NonNullable<LaunchPlan['files']> = [];
    let message = ctx.prompt;
    if (message.length > INLINE_LIMIT) {
      const path = join(ctx.jobDir, 'task.md');
      files.push({ name: 'task.md', content: message });
      message = `Read the file at ${path} in full. It contains your complete task. Follow the instructions inside it and reply with the deliverable only.`;
    }
    const args = [...exe.prefix, '-z', message, '-m', optStr(route.options, 'model') as string, '--usage-file', join(ctx.jobDir, 'usage.json')];
    const promptArgs = [exe.prefix.length + 1];
    if (request.tools === 'read') args.push('--safe-mode'); else if (request.tools === 'full') args.push('--yolo');
    return { command: exe.command, args, cwd: request.cwd, env: {}, stdin: null, files, promptArgs };
  },
  extract(input: ExtractInput): Extraction {
    const answer = input.stdout.trim() || null;
    const raw = readTextIfExists(join(input.jobDir, 'usage.json'));
    let u: HermesUsage | null = null;
    try { u = raw ? JSON.parse(raw) as HermesUsage : null; } catch { u = null; }
    if (!u) return { answer, usage: null };
    const aux = u.auxiliary ?? {};
    // Hermes counts cached tokens apart from input, so the total input is their sum.
    const cachedRead = (u.cache_read_tokens ?? 0) + (aux.cache_read_tokens ?? 0), cachedWrite = (u.cache_write_tokens ?? 0) + (aux.cache_write_tokens ?? 0);
    const usage: UsageReport = { inputTokens: (u.input_tokens ?? 0) + (aux.input_tokens ?? 0) + cachedRead + cachedWrite, outputTokens: (u.output_tokens ?? 0) + (aux.output_tokens ?? 0), source: 'reported' };
    if (cachedRead) usage.cachedReadTokens = cachedRead;
    if (cachedWrite) usage.cachedWriteTokens = cachedWrite;
    const reasoning = (u.reasoning_tokens ?? 0) + (aux.reasoning_tokens ?? 0);
    if (reasoning) usage.reasoningTokens = reasoning;
    if (u.cost_source && u.cost_source !== 'none' && typeof u.estimated_cost_usd === 'number') { usage.costUsd = u.estimated_cost_usd; usage.currency = 'USD'; }
    return { answer, usage, ...(u.failed ? { failure: 'hermes reported that the turn failed' } : {}) };
  },
  version(route: RouteConfig) {
    const exe = command(route);
    if (!exe) return null;
    try { return execFileSync(exe.command, [...exe.prefix, '--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true }).split('\n')[0]?.trim() ?? null; } catch { return null; }
  },
};
