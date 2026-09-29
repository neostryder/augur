import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter, JobRequest, LaunchPlan, RouteConfig, UsageReport } from '@augur/dispatch-protocol';

/** The OpenAI-managed install keeps itself current and ships the host binary next to codex.exe. Prefer it over whatever is on PATH. */
export function findMaintainedCodex(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin') : null;
  if (!base || !existsSync(base)) return null;
  const found = readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(base, d.name, 'codex.exe')).filter(existsSync);
  found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return found[0] ?? null;
}

const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];
const versions = new Map<string, string | null>();

interface TurnUsage { input_tokens?: number; cached_input_tokens?: number; cache_write_input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number }

/**
 * `codex exec`: the prompt goes in on standard input, events come out as JSON lines and the final message is written to a file.
 * Route options: `model`, `effort`, `command`, `prefixArgsJson` (arguments placed before `exec`, for wrappers), `sandbox`.
 */
export const codexExec: Adapter = {
  id: 'codex-exec', transport: 'exec',
  capabilities: { permissionRequests: false, sessions: false, reportsUsage: true, sandboxed: false, isolatesWorkspace: false },
  envAllow: ['CODEX_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE'],
  validate(route: RouteConfig) {
    const sb = route.options?.sandbox;
    if (sb !== undefined && !SANDBOXES.includes(String(sb))) return `sandbox must be one of ${SANDBOXES.join(', ')}`;
    if (route.options?.prefixArgsJson !== undefined) { try { if (!Array.isArray(JSON.parse(String(route.options.prefixArgsJson)))) return 'prefixArgsJson must be an array'; } catch { return 'prefixArgsJson is not valid JSON'; } }
    return null;
  },
  plan(request: JobRequest, route: RouteConfig, jobDir: string): LaunchPlan {
    const o = route.options ?? {};
    const command = typeof o.command === 'string' ? o.command : findMaintainedCodex() ?? 'codex';
    const prefix: string[] = typeof o.prefixArgsJson === 'string' ? JSON.parse(o.prefixArgsJson) as string[] : [];
    const sandbox = typeof o.sandbox === 'string' ? o.sandbox : 'danger-full-access';
    const args = [...prefix, 'exec', '--skip-git-repo-check', '--json', '-o', join(jobDir, 'last-message.txt'), '--sandbox', sandbox];
    if (typeof o.model === 'string') args.push('-m', o.model);
    if (typeof o.effort === 'string') args.push('-c', `model_reasoning_effort=${o.effort}`);
    args.push('-');
    return { command, args, cwd: request.cwd, env: {}, stdin: 'prompt', tierInPrompt: request.tools };
  },
  usage(stdout: string): UsageReport | null {
    let total: UsageReport | null = null;
    for (const line of stdout.split('\n')) {
      if (!line.includes('turn.completed')) continue;
      let e: { type?: string; usage?: TurnUsage };
      try { e = JSON.parse(line) as typeof e; } catch { continue; }
      if (e.type !== 'turn.completed' || !e.usage) continue;
      const u = e.usage;
      total ??= { inputTokens: 0, outputTokens: 0, source: 'reported' };
      total.inputTokens += u.input_tokens ?? 0; total.outputTokens += u.output_tokens ?? 0;
      if (u.cached_input_tokens !== undefined) total.cachedReadTokens = (total.cachedReadTokens ?? 0) + u.cached_input_tokens;
      if (u.cache_write_input_tokens) total.cachedWriteTokens = (total.cachedWriteTokens ?? 0) + u.cache_write_input_tokens;
      if (u.reasoning_output_tokens !== undefined) total.reasoningTokens = (total.reasoningTokens ?? 0) + u.reasoning_output_tokens;
    }
    return total;
  },
  version(route: RouteConfig) {
    const o = route.options ?? {}, command = typeof o.command === 'string' ? o.command : findMaintainedCodex() ?? 'codex';
    if (typeof o.command === 'string' && typeof o.prefixArgsJson === 'string') return null;
    if (versions.has(command)) return versions.get(command) ?? null;
    let v: string | null = null;
    try { v = execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: /\.(cmd|bat)$/i.test(command) }).trim().split('\n')[0] ?? null; } catch { v = null; }
    versions.set(command, v); return v;
  },
};
