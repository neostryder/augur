import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tierNote } from '@augur/dispatch-protocol';
import type { Adapter, ExtractInput, Extraction, JobRequest, LaunchPlan, PlanContext, RouteConfig, UsageReport } from '@augur/dispatch-protocol';
import { dataDir } from '../paths.js';
import { optNum, optStr, resolveExecutable } from './util.js';

interface McodeResult { type?: string; status?: string; output?: string; error?: unknown; usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number } }

function command(route: RouteConfig): { command: string; prefix: string[] } | null {
  const c = optStr(route.options, 'command');
  return c ? { command: c, prefix: [] } : resolveExecutable('mcode');
}

export const mcodeExec: Adapter = {
  id: 'mcode-exec', charterEngine: 'mcode', transport: 'exec',
  capabilities: { permissionRequests: false, sessions: false, reportsUsage: true, sandboxed: false, isolatesWorkspace: true, enforcesReadOnly: false },
  envAllow: ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MINIMAX_DATA_DIR', 'MAVIS_DATA_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE'],
  isolation: { root: route => optStr(route.options, 'workRoot') ?? join(dataDir(), 'mcode') },
  validate(route: RouteConfig) {
    if (route.options?.workRoot !== undefined && !optStr(route.options, 'workRoot')?.trim()) return 'route option workRoot must be a non-empty path';
    if (route.options?.maxSteps !== undefined && (!Number.isInteger(optNum(route.options, 'maxSteps')) || (optNum(route.options, 'maxSteps') ?? 0) < 1)) return 'route option maxSteps must be a positive integer';
    return command(route) ? null : 'mcode was not found on PATH; set the command route option';
  },
  plan(request: JobRequest, route: RouteConfig, ctx: PlanContext): LaunchPlan {
    if (!ctx.workspace) throw new Error('mcode-exec requires a workspace copy');
    const exe = command(route) as { command: string; prefix: string[] };
    const steps = optNum(route.options, 'maxSteps') ?? (request.tools === 'read' ? 60 : 400);
    const args = [...exe.prefix, 'exec', '--input', '-', '--cwd', ctx.workspace,
      '--max-steps', String(steps), '--permission', request.tools === 'read' ? 'smart' : 'full', '--output-format', 'json'];
    const model = optStr(route.options, 'model'), effort = request.effort ?? optStr(route.options, 'effort');
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (request.timeoutS !== undefined) args.push('--timeout', `${request.timeoutS}s`);
    return { command: exe.command, args, cwd: ctx.workspace, env: {}, stdin: tierNote(request.tools === 'read' ? 'read' : 'full', ctx.prompt) };
  },
  extract(input: ExtractInput): Extraction {
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
  version(route: RouteConfig) {
    const exe = command(route);
    if (!exe) return null;
    try { return execFileSync(exe.command, [...exe.prefix, '--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true }).split('\n')[0]?.trim() ?? null; } catch { return null; }
  },
};
