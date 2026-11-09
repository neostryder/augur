import { execFileSync } from 'node:child_process';
import { routeSecretName, tierNote } from '@augur/dispatch-protocol';
import type { Adapter, ExtractInput, Extraction, JobRequest, LaunchPlan, PlanContext, RouteConfig, Toolkit, UsageReport } from '@augur/dispatch-protocol';
import { resolveAmbient } from '../charter.js';
import { scriptPath } from '../paths.js';
import { keyFileOnly, keyFilePath } from '../secrets.js';
import { MAX_COMMAND_LINE, optNum, optStr, resolveExecutable } from './util.js';

const SCRIPT = scriptPath(import.meta.url, 'claude-call');
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// api-call.ts uses the same marker for HTTP prompt caching; an exec prompt needs no cache boundary.
const CACHE_BREAK = '<!-- augur:cache-break -->';

function command(route: RouteConfig): { command: string; prefix: string[] } | null {
  const c = optStr(route.options, 'command');
  return c ? { command: c, prefix: [] } : resolveExecutable('claude');
}

function optionProblem(route: RouteConfig): string | null {
  const o = route.options;
  if (!optStr(o, 'model')?.trim()) return 'route option model is required';
  const turns = o?.maxTurns, budget = o?.maxBudgetUsd;
  if (turns !== undefined && !(typeof turns === 'number' && Number.isInteger(turns) && turns >= 1 && turns <= 500)) return 'maxTurns must be a whole number from 1 to 500';
  if (budget !== undefined && !(typeof budget === 'number' && budget > 0 && budget <= 50)) return 'maxBudgetUsd must be a number above 0 and at most 50';
  if (o?.effort !== undefined && !EFFORTS.includes(String(o.effort))) return `effort must be one of ${EFFORTS.join(', ')}`;
  if (o?.keySource !== undefined && o.keySource !== 'store' && o.keySource !== 'env') return 'keySource must be store or env';
  if (o?.apiKeyEnv !== undefined && !optStr(o, 'apiKeyEnv')?.trim()) return 'apiKeyEnv must be an environment variable name';
  if (o?.keySource === 'env' && !optStr(o, 'apiKeyEnv')?.trim()) return 'route option apiKeyEnv is required when keySource is env';
  if (o?.ambient !== undefined && o.ambient !== 'keep' && o.ambient !== 'trim') return 'ambient must be keep or trim';
  if (o?.allowWeb !== undefined && typeof o.allowWeb !== 'boolean') return 'allowWeb must be a boolean';
  if (o?.command !== undefined && !optStr(o, 'command')?.trim()) return 'command must be a full path to claude';
  if (o?.envAllow !== undefined && typeof o.envAllow !== 'string') return 'envAllow must be a comma-separated list of environment variable names';
  if (optStr(o, 'envAllow')?.split(',').some(n => /^(ANTHROPIC_|CLAUDE_CODE_)/i.test(n.trim()))) return 'envAllow cannot include ANTHROPIC_ or CLAUDE_CODE_ variables';
  return null;
}

/** Flags that carry only this job's MCP servers and denied tools. */
export function claudeToolkitArgs(kit: Toolkit | undefined): string[] {
  const servers = Object.entries(kit?.mcp ?? {});
  if (!servers.length) return [];
  const mcpServers = Object.fromEntries(servers.map(([name, s]) => [name, { command: s.command, args: s.args, ...(s.env ? { env: s.env } : {}) }]));
  return ['--mcp-config', JSON.stringify({ mcpServers }), '--strict-mcp-config', ...servers.flatMap(([name, s]) => (s.denyTools ?? []).flatMap(t => ['--disallowedTools', `mcp__${name}__${t}`]))];
}

interface ClaudeEnvelope {
  result?: string; subtype?: string; is_error?: boolean; errors?: string[]; session_id?: string; api_error_status?: number;
  total_cost_usd?: number; usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number };
}

/**
 * Claude Code reads a prompt on standard input and returns one JSON result. The wrapper reads the Anthropic API key outside the service.
 * Route options: `model` (required), `effort` (low, medium, high, xhigh, or max; the request wins), and `command` (full path, otherwise PATH).
 * `maxTurns` is a whole number from 1 to 500, default 40. `maxBudgetUsd` is above 0 and at most 50, default 2. Both caps apply to every job.
 * `keySource` is store by default, or env with `apiKeyEnv` naming the key variable. Store falls back to the provider key claude-api.apiKey.
 * `ambient` is keep or trim, default trim when no service setting is supplied. Trim adds --bare to skip profile context and subscription credentials.
 * `allowWeb` defaults to false and adds WebSearch and WebFetch to read jobs. `envAllow` is a comma list without ANTHROPIC_ or CLAUDE_CODE_ names.
 */
export const claudeExec: Adapter = {
  id: 'claude-exec', charterEngine: 'claude', transport: 'exec', toolkit: 'inject',
  capabilities: { permissionRequests: false, sessions: true, reportsUsage: true, sandboxed: false, isolatesWorkspace: false, enforcesReadOnly: true },
  envAllow: ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'CLAUDE_CODE_GIT_BASH_PATH'],
  validate(route: RouteConfig) {
    return optionProblem(route) ?? (command(route) ? null : 'claude was not found on PATH; set the command route option');
  },
  plan(request: JobRequest, route: RouteConfig, ctx: PlanContext): LaunchPlan {
    const problem = optionProblem(route);
    if (problem) throw new Error(problem);
    const exe = command(route);
    if (!exe) throw new Error('claude was not found on PATH; set the command route option');
    const o = route.options, effort = request.effort ?? optStr(o, 'effort');
    if (effort !== undefined && !EFFORTS.includes(effort)) throw new Error(`effort must be one of ${EFFORTS.join(', ')}`);
    const args = ['-p', '--output-format', 'json', '--model', optStr(o, 'model') as string, '--max-turns', String(optNum(o, 'maxTurns') ?? 40), '--max-budget-usd', String(optNum(o, 'maxBudgetUsd') ?? 2)];
    if (resolveAmbient(o?.ambient, ctx.ambient ?? 'trim') === 'trim') args.push('--bare');
    if (request.tools === 'none') args.push('--tools', '', '--permission-mode', 'dontAsk');
    else if (request.tools === 'read') args.push('--tools', `Read,Grep,Glob${o?.allowWeb ? ',WebSearch,WebFetch' : ''}`, '--permission-mode', 'dontAsk', '--disallowedTools', 'Edit,Write,NotebookEdit,Bash,PowerShell');
    else args.push('--permission-mode', 'bypassPermissions');
    args.push(...claudeToolkitArgs(ctx.toolkit));
    if (request.tools === 'none' || request.tools === 'read') for (const name of Object.keys(ctx.toolkit?.mcp ?? {})) args.push('--allowedTools', `mcp__${name}`);
    if (effort) args.push('--effort', effort);
    if (ctx.resume) {
      if (!ctx.resume.id) throw new Error(`conversation ${ctx.resume.name} has no session id${ctx.resume.fresh ? '' : ' to resume'}`);
      args.push(ctx.resume.fresh ? '--session-id' : '--resume', ctx.resume.id);
    } else args.push('--no-session-persistence');
    if ([exe.command, ...exe.prefix, ...args].map(a => JSON.stringify(a)).join(' ').length > MAX_COMMAND_LINE) throw new Error('claude arguments exceed MAX_COMMAND_LINE; reduce the MCP configuration');
    const keyArgs = optStr(o, 'keySource') === 'env' ? ['--key-env', optStr(o, 'apiKeyEnv') as string]
      : ['--key-name', routeSecretName(request.route), '--key-file', keyFilePath(), ...(keyFileOnly() ? ['--key-file-only'] : []), '--fallback-key-name', 'claude-api.apiKey'];
    const prompt = ctx.prompt.split('\n').filter(line => line.trim() !== CACHE_BREAK).join('\n');
    return { command: process.execPath, args: [SCRIPT, '--exe', exe.command, ...(exe.prefix.length ? ['--exe-prefix-json', JSON.stringify(exe.prefix)] : []), ...keyArgs, '--', ...args], cwd: request.cwd, env: {}, stdin: tierNote(request.tools, prompt), files: [] };
  },
  extract(input: ExtractInput): Extraction {
    let env: ClaudeEnvelope | null = null;
    try { const value: unknown = JSON.parse(input.stdout.trim()); if (value && typeof value === 'object' && !Array.isArray(value)) env = value as ClaudeEnvelope; } catch { env = null; }
    if (!env) return { answer: input.stdout.trim() || null, usage: null, ...(!input.stdout.trim() ? { failure: input.stderr.trim().split(/\r?\n/).filter(s => s.trim()).pop() || 'claude printed no result' } : {}) };
    const cachedRead = env.usage?.cache_read_input_tokens ?? 0, cachedWrite = env.usage?.cache_creation_input_tokens ?? 0;
    const usage: UsageReport = { inputTokens: (env.usage?.input_tokens ?? 0) + cachedRead + cachedWrite, outputTokens: env.usage?.output_tokens ?? 0, source: 'reported' };
    if (cachedRead) usage.cachedReadTokens = cachedRead;
    if (cachedWrite) usage.cachedWriteTokens = cachedWrite;
    if (typeof env.total_cost_usd === 'number') { usage.costUsd = env.total_cost_usd; usage.currency = 'USD'; }
    let failure: string | undefined;
    if (env.is_error || env.subtype !== 'success') {
      if (env.subtype === 'error_max_turns') failure = 'claude stopped because the job reached its turn count';
      else if (env.subtype === 'error_max_budget_usd') failure = 'claude stopped because the job reached its per-job dollar cap';
      else {
        const detail = [env.result, ...(env.errors ?? [])].filter(s => typeof s === 'string' && s.trim()).join('; ');
        failure = env.api_error_status === 429 ? `claude provider usage limit (HTTP 429)${detail ? `: ${detail}` : ''}`
          : env.api_error_status === 402 ? `claude provider credit balance (HTTP 402)${detail ? `: ${detail}` : ''}`
          : detail || `claude reported ${env.subtype ?? 'an error result'}`;
      }
    }
    return { answer: typeof env.result === 'string' ? env.result.trim() || null : null, usage, ...(typeof env.session_id === 'string' ? { sessionId: env.session_id } : {}), ...(failure ? { failure } : {}) };
  },
  version(route: RouteConfig) {
    const exe = command(route);
    if (!exe) return null;
    try { return execFileSync(exe.command, [...exe.prefix, '--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true }).split('\n')[0]?.trim() ?? null; } catch { return null; }
  },
};
