import { fileURLToPath } from 'node:url';
import type { Adapter, AdapterCapabilities, ExtractInput, Extraction, JobRequest, LaunchPlan, PlanContext, RouteConfig, UsageReport } from '@augur/dispatch-protocol';
import { optNum, optStr } from './util.js';

const SCRIPT = fileURLToPath(new URL('./api-call.ts', import.meta.url));
const CAPS: AdapterCapabilities = { permissionRequests: false, sessions: false, reportsUsage: true, sandboxed: false, isolatesWorkspace: false };

/**
 * A bare model over HTTP: one prompt in, one text answer out, no tools and no files. It runs as a job like any other, so it can be timed out and cancelled.
 * Route options: `baseUrl`, `model`, `apiKeyEnv` (the environment variable that holds the key), `maxTokens`, `timeoutS`.
 */
function make(id: string, shape: 'openai' | 'anthropic'): Adapter {
  return {
    id, transport: 'api', capabilities: CAPS, envAllow: [],
    validate(route: RouteConfig) {
      if (!optStr(route.options, 'baseUrl')) return 'route option baseUrl is required';
      if (!/^https?:\/\//.test(optStr(route.options, 'baseUrl') as string)) return 'baseUrl must start with http:// or https://';
      if (!optStr(route.options, 'model')) return 'route option model is required';
      if (!optStr(route.options, 'apiKeyEnv')) return 'route option apiKeyEnv (the environment variable that holds the key) is required';
      return null;
    },
    plan(request: JobRequest, route: RouteConfig, ctx: PlanContext): LaunchPlan {
      if (request.tools !== 'read' || request.output !== 'text_only') throw new Error('an API route returns text only. Use tools read and output text_only.');
      const o = route.options;
      const args = [SCRIPT, '--shape', shape, '--url', optStr(o, 'baseUrl') as string, '--model', optStr(o, 'model') as string, '--key-env', optStr(o, 'apiKeyEnv') as string,
        '--max-tokens', String(optNum(o, 'maxTokens') ?? 4096), '--timeout-s', String(optNum(o, 'timeoutS') ?? request.timeoutS ?? 900)];
      return { command: process.execPath, args, cwd: request.cwd, env: {}, stdin: ctx.prompt };
    },
    extract(input: ExtractInput): Extraction {
      type Out = { answer?: string; usage?: Omit<UsageReport, 'source'> | null };
      let r: Out | null;
      try { r = JSON.parse(input.stdout) as Out; } catch { r = null; }
      if (!r) return { answer: null, usage: null, failure: input.stderr.trim().split(String.fromCharCode(10)).pop() || 'the API call returned no result' };
      return { answer: r.answer?.trim() || null, usage: r.usage ? { ...r.usage, source: 'reported' } : null };
    },
  };
}

export const openaiApi = make('openai-api', 'openai');
export const anthropicApi = make('anthropic-api', 'anthropic');
