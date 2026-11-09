import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, opendirSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tierNote } from '@augur/dispatch-protocol';
import type { Adapter, ExtractInput, Extraction, JobRequest, LaunchPlan, PlanContext, RouteConfig, UsageReport } from '@augur/dispatch-protocol';
import { resolveAmbient } from '../charter.js';
import { engineFailure, readTextIfExists, resolveExecutable } from './util.js';
import type { Toolkit } from '@augur/dispatch-protocol';

/** The OpenAI-managed install keeps itself current and ships the host binary next to codex.exe. Prefer it over whatever is on PATH. */
export function findMaintainedCodex(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin') : null;
  if (!base || !existsSync(base)) return null;
  const found = readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(base, d.name, 'codex.exe')).filter(existsSync);
  found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return found[0] ?? null;
}

const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];
// From the ai-cli-toolkit codex dispatch. Measured 2026-09-29: these features added input tokens a one-shot job does not use (17.3k down to 14.2k).
const CODEX_AMBIENT_OFF = ['plugins', 'apps', 'multi_agent', 'skill_search', 'browser_use', 'computer_use', 'in_app_browser', 'image_generation', 'goals', 'tool_suggest'];
const versions = new Map<string, string | null>();

/** `-c` overrides that start Codex with a toolkit's MCP servers for this job, and with the denied tools turned off. JSON text is valid TOML for strings and lists. */
export function codexToolkitArgs(kit: Toolkit | undefined): string[] {
  const out: string[] = [];
  for (const [name, s] of Object.entries(kit?.mcp ?? {})) {
    out.push('-c', `mcp_servers.${name}.command=${JSON.stringify(s.command)}`, '-c', `mcp_servers.${name}.args=${JSON.stringify(s.args)}`);
    if (s.env) out.push('-c', `mcp_servers.${name}.env={${Object.entries(s.env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}}`);
    if (s.denyTools?.length) out.push('-c', `mcp_servers.${name}.disabled_tools=${JSON.stringify(s.denyTools)}`);
  }
  return out;
}

interface TurnUsage { input_tokens?: number; cached_input_tokens?: number; cache_write_input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number }

/**
 * `codex exec`: the prompt goes in on standard input, events come out as JSON lines and the final message is written to a file.
 * A later turn of a named conversation uses `exec resume`. Resume cannot set the sandbox again, so that turn keeps the first turn's tool tier.
 * Route options: `model`, `effort`, `command`, `prefixArgsJson` (arguments placed before `exec`, for wrappers), `sandbox`.
 */
export const codexExec: Adapter = {
  id: 'codex-exec', charterEngine: 'codex', transport: 'exec', toolkit: 'inject',
  capabilities: { permissionRequests: false, sessions: true, reportsUsage: true, sandboxed: false, isolatesWorkspace: false, enforcesReadOnly: false },
  envAllow: ['CODEX_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE'],
  validate(route: RouteConfig) {
    const sb = route.options?.sandbox;
    if (sb !== undefined && !SANDBOXES.includes(String(sb))) return `sandbox must be one of ${SANDBOXES.join(', ')}`;
    if (route.options?.prefixArgsJson !== undefined) { try { if (!Array.isArray(JSON.parse(String(route.options.prefixArgsJson)))) return 'prefixArgsJson must be an array'; } catch { return 'prefixArgsJson is not valid JSON'; } }
    return null;
  },
  plan(request: JobRequest, route: RouteConfig, ctx: PlanContext): LaunchPlan {
    const o = route.options ?? {}, effort = request.effort ?? o.effort;
    const files = request.schema ? [{ name: 'output-schema.json', content: JSON.stringify(request.schema) }] : [];
    const schemaArgs = request.schema ? ['--output-schema', join(ctx.jobDir, 'output-schema.json')] : [];
    const command = typeof o.command === 'string' ? o.command : findMaintainedCodex() ?? resolveExecutable('codex')?.command ?? 'codex';
    const prefix: string[] = typeof o.prefixArgsJson === 'string' ? JSON.parse(o.prefixArgsJson) as string[] : [];
    if (ctx.resume && !ctx.resume.fresh) {
      // Resume keeps the sandbox from the first turn, so it sets no sandbox or model. It still takes --json and -o, so the answer and usage come back as on a first turn.
      if (!ctx.resume.id) throw new Error(`conversation ${ctx.resume.name} has no session id to resume`);
      const resumeArgs = [...prefix, 'exec', 'resume', '--skip-git-repo-check', '--json', '-o', join(ctx.jobDir, 'last-message.txt'), ctx.resume.id];
      if (typeof effort === 'string') resumeArgs.push('-c', `model_reasoning_effort=${effort}`);
      resumeArgs.push(...schemaArgs);
      resumeArgs.push(...codexToolkitArgs(ctx.toolkit));
      // `-` reads the prompt from standard input, so a long one stays under the command-line limit.
      resumeArgs.push('-');
      return { command, args: resumeArgs, cwd: request.cwd, env: {}, files, stdin: tierNote(request.tools, ctx.prompt) };
    }
    const sandbox = typeof o.sandbox === 'string' ? o.sandbox : 'danger-full-access';
    const args = [...prefix, 'exec', '--skip-git-repo-check', '--json', '-o', join(ctx.jobDir, 'last-message.txt'), '--sandbox', sandbox];
    if (resolveAmbient(o.ambient, ctx.ambient) === 'trim') for (const feature of CODEX_AMBIENT_OFF) args.push('--disable', feature);
    if (typeof o.model === 'string') args.push('-m', o.model);
    if (typeof effort === 'string') args.push('-c', `model_reasoning_effort=${effort}`);
    args.push(...schemaArgs);
    args.push(...codexToolkitArgs(ctx.toolkit));
    args.push('-');
    return { command, args, cwd: request.cwd, env: {}, files, stdin: tierNote(request.tools, ctx.prompt) };
  },
  extract(input: ExtractInput): Extraction {
    const usage = codexUsage(input.stdout);
    const sessionId = codexThreadId(input.stdout) ?? codexThreadFromFile(input.stdoutPath);
    const answer = readTextIfExists(join(input.jobDir, 'last-message.txt'))?.trim() || null;
    const base = { answer, usage, ...(sessionId ? { sessionId } : {}) };
    if (input.exitCode !== null && input.exitCode !== 0) return { ...base, ...(sessionId ? codexFailure(sessionId) : {}) };
    // Codex reports a broken tool host as ordinary tool output, then answers politely and exits 0.
    if (/failed to spawn code-mode host/.test(input.stdout + input.stderr)) {
      return { ...base, failure: 'codex could not start its workspace tool host, so it answered without being able to read or write files' };
    }
    return base;
  },
  version(route: RouteConfig) {
    const o = route.options ?? {}, command = typeof o.command === 'string' ? o.command : findMaintainedCodex() ?? resolveExecutable('codex')?.command ?? 'codex';
    if (typeof o.command === 'string' && typeof o.prefixArgsJson === 'string') return null;
    if (versions.has(command)) return versions.get(command) ?? null;
    let v: string | null = null;
    try { v = execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: /\.(cmd|bat)$/i.test(command) }).trim().split('\n')[0] ?? null; } catch { v = null; }
    versions.set(command, v); return v;
  },
};

function codexThreadFromFile(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(65536), count = readSync(fd, buffer, 0, buffer.length, 0);
    return codexThreadId(buffer.toString('utf8', 0, count));
  } catch { return null; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
}

function codexFailure(sessionId: string): Pick<Extraction, 'failureReason' | 'failureCode'> {
  let remaining = 10000;
  const find = (path: string, depth: number): string | null => {
    const dir = opendirSync(path);
    try {
      while (remaining-- > 0) {
        const entry = dir.readSync();
        if (!entry) break;
        if (depth === 3 && entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${sessionId}.jsonl`)) return join(path, entry.name);
        if (depth < 3 && entry.isDirectory() && /^\d{2,4}$/.test(entry.name)) {
          const found = find(join(path, entry.name), depth + 1);
          if (found) return found;
        }
      }
      return null;
    } finally { dir.closeSync(); }
  };
  let fd: number | undefined;
  try {
    const path = find(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'), 0);
    if (!path) return {};
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return {};
    // A bounded tail keeps a long session from delaying job finalization.
    const length = Math.min(stat.size, 1024 * 1024), start = stat.size - length, buffer = Buffer.alloc(length);
    const count = readSync(fd, buffer, 0, length, start);
    const lines = buffer.toString('utf8', 0, count).split('\n');
    if (start) lines.shift();
    let failure: Pick<Extraction, 'failureReason' | 'failureCode'> = {};
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as { type?: string; payload?: { type?: string; error?: unknown } };
      if (event?.type === 'event_msg' && event.payload?.type === 'task_complete') failure = engineFailure(event.payload.error);
    }
    return failure;
  } catch { return {}; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
}

function codexThreadId(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line) as { type?: string; thread_id?: unknown };
      if (event?.type === 'thread.started' && typeof event.thread_id === 'string' && /^[0-9a-fA-F-]{8,}$/.test(event.thread_id)) return event.thread_id;
    } catch { continue; }
  }
  return null;
}

function codexUsage(stdout: string): UsageReport | null {
  let total: UsageReport | null = null;
  for (const line of stdout.split(String.fromCharCode(10))) {
    if (!line.includes('turn.completed')) continue;
    let e: { type?: string; usage?: TurnUsage };
    try { e = JSON.parse(line) as typeof e; } catch { continue; }
    if (e.type !== 'turn.completed' || !e.usage) continue;
    const u = e.usage;
    total ??= { inputTokens: 0, outputTokens: 0, source: 'reported' };
    total.inputTokens += u.input_tokens ?? 0; total.outputTokens += u.output_tokens ?? 0;
    if (u.cached_input_tokens !== undefined) total.cachedReadTokens = (total.cachedReadTokens ?? 0) + u.cached_input_tokens;
    if (u.cache_write_input_tokens) total.cachedWriteTokens = (total.cachedWriteTokens ?? 0) + u.cache_write_input_tokens;
    if (u.reasoning_output_tokens !== undefined) { total.reasoningTokens = (total.reasoningTokens ?? 0) + u.reasoning_output_tokens; total.reasoningInOutput = true; }
  }
  return total;
}
