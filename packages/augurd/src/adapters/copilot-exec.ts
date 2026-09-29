import { execFileSync } from 'node:child_process';
import { tierNote } from '@augur/dispatch-protocol';
import type { Adapter, ExtractInput, Extraction, JobRequest, LaunchPlan, PlanContext, RouteConfig, UsageReport } from '@augur/dispatch-protocol';
import { optStr, resolveExecutable } from './util.js';

/** The CLI prints its cost in AI credits. One credit is billed at a hundredth of a dollar. */
const USD_PER_CREDIT = 0.01;

function command(route: RouteConfig): { command: string; prefix: string[] } | null {
  const c = optStr(route.options, 'command');
  return c ? { command: c, prefix: [] } : resolveExecutable('copilot');
}

/** "14.1k" or "87" or "1.2m" as a whole number. The CLI rounds large counts, so these are approximate. */
export function parseCount(text: string): number {
  const m = /^([\d.,]+)\s*([km]?)$/i.exec(text.trim());
  if (!m) return 0;
  const n = Number((m[1] as string).replace(/,/g, '')), unit = (m[2] ?? '').toLowerCase();
  return Math.round(n * (unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : 1));
}

/**
 * GitHub Copilot CLI in prompt mode. The CLI has no read-only tier here, so it always runs with all tools allowed and the tier is stated in the prompt.
 * Route options: `model`, `command`, `effort`, `envAllow`.
 */
export const copilotExec: Adapter = {
  id: 'copilot-exec', transport: 'exec',
  capabilities: { permissionRequests: false, sessions: false, reportsUsage: true, sandboxed: false, isolatesWorkspace: false, enforcesReadOnly: false },
  envAllow: ['COPILOT_HOME', 'GH_TOKEN', 'GITHUB_TOKEN', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE'],
  validate(route: RouteConfig) {
    if (!optStr(route.options, 'model')) return 'route option model is required';
    return command(route) ? null : 'copilot was not found on PATH; set the command route option';
  },
  plan(request: JobRequest, route: RouteConfig, ctx: PlanContext): LaunchPlan {
    const exe = command(route) as { command: string; prefix: string[] };
    const args = [...exe.prefix, '-p', tierNote(request.tools, ctx.prompt), '--model', optStr(route.options, 'model') as string, '--allow-all-tools', '--no-color'];
    const effort = optStr(route.options, 'effort');
    if (effort) args.push('--reasoning-effort', effort);
    return { command: exe.command, args, cwd: request.cwd, env: {}, stdin: null, promptArgs: [exe.prefix.length + 1] };
  },
  extract(input: ExtractInput): Extraction {
    const text = input.stdout.replace(/\r/g, '');
    const tail = /\n\s*(Changes|AI Credits|Tokens|Resume)\b[\s\S]*$/.exec(text);
    const answer = (tail ? text.slice(0, tail.index) : text).trim() || null;
    const meta = `${input.stdout}\n${input.stderr}`;
    const credits = /AI Credits\s+([\d.]+)/.exec(meta), line = /^\s*Tokens\s+(.*)$/m.exec(meta)?.[1] ?? '';
    const arrow = (mark: string) => new RegExp(String.raw`${mark}\s*([\d.,]+[km]?)((?:\s*\([^)]*\))*)`, 'i').exec(line);
    const up = arrow('↑'), down = arrow('↓');
    if (!credits && !up && !down) return { answer, usage: null };
    // The parentheses after a count break it down: "(49.9k written)", "(12k cached)", "(97 reasoning)".
    const detail = (m: RegExpExecArray | null, word: RegExp): number => { const d = new RegExp(String.raw`([\d.,]+[km]?)\s*(?:${word.source})`, 'i').exec(m?.[2] ?? ''); return d ? parseCount(d[1] as string) : 0; };
    const usage: UsageReport = { inputTokens: up ? parseCount(up[1] as string) : 0, outputTokens: down ? parseCount(down[1] as string) : 0, source: 'reported' };
    const written = detail(up, /written/), read = detail(up, /cached|cache read|read/), reasoning = detail(down, /reasoning/);
    if (read) usage.cachedReadTokens = read;
    if (written) usage.cachedWriteTokens = written;
    if (reasoning) usage.reasoningTokens = reasoning;
    if (credits) { usage.costUsd = Math.round(Number(credits[1]) * USD_PER_CREDIT * 10000) / 10000; usage.currency = 'USD'; }
    return { answer, usage };
  },
  version(route: RouteConfig) {
    const exe = command(route);
    if (!exe) return null;
    try { return execFileSync(exe.command, [...exe.prefix, '--version'], { encoding: 'utf8', timeout: 30000, windowsHide: true }).split('\n')[0]?.trim() ?? null; } catch { return null; }
  },
};
