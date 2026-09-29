import { tierNote } from '@augur/dispatch-protocol';
import type { Adapter, ExtractInput, Extraction, JobRequest, LaunchPlan, PlanContext, RouteConfig } from '@augur/dispatch-protocol';

/**
 * Runs any command a route names. It is the escape hatch for harnesses without an adapter and is off unless the service config lists it.
 * Route options: `command`, `argsJson` (array of arguments), `stdin` (`prompt` or `none`), `sandboxed`, `isolates`.
 */
export const genericExec: Adapter = {
  id: 'exec', transport: 'exec',
  capabilities: { permissionRequests: false, sessions: false, reportsUsage: false, sandboxed: false, isolatesWorkspace: false, enforcesReadOnly: false },
  envAllow: [],
  validate(route: RouteConfig) {
    if (typeof route.options?.command !== 'string') return 'route option command is required';
    try { if (!Array.isArray(JSON.parse(String(route.options.argsJson ?? '[]')))) return 'argsJson must be an array'; } catch { return 'argsJson is not valid JSON'; }
    return null;
  },
  plan(request: JobRequest, route: RouteConfig, ctx: PlanContext): LaunchPlan {
    const o = route.options ?? {};
    return { command: String(o.command), args: JSON.parse(String(o.argsJson ?? '[]')) as string[], cwd: request.cwd, env: {}, stdin: o.stdin === 'none' ? null : tierNote(request.tools, ctx.prompt) };
  },
  extract(input: ExtractInput): Extraction { return { answer: input.stdout.trim() || null, usage: null }; },
};
