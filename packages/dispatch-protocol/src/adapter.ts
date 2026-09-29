import type { JobRequest, ToolTier, UsageReport } from './spec.js';

/** How a harness or model is reached. Every transport implements the same contract, so rules and job history do not depend on it. */
export type Transport = 'exec' | 'acp' | 'api' | 'web';

export interface AdapterCapabilities {
  /** The transport can ask before a tool runs, so a denial is honored. */
  permissionRequests: boolean;
  sessions: boolean;
  /** The harness reports token counts of its own. */
  reportsUsage: boolean;
  /** The harness runs inside a sandbox the service does not have to provide. */
  sandboxed: boolean;
  /** The harness works on a copy of the workspace, so `patch_only` can export a diff. */
  isolatesWorkspace: boolean;
}

/** Route settings from the user's own registry. Machine-specific values live there and never in shipped defaults. */
export interface RouteConfig {
  /** `<provider>/<model>` label used by policy.json, such as codex/sol. */
  model: string;
  adapter: string;
  /** Adapter-specific values, such as the model id and reasoning effort passed to the harness. */
  options?: Record<string, string | number | boolean>;
  /** Route may dispatch further jobs. Off unless set. */
  delegation?: boolean;
  notes?: string;
}

export interface LaunchPlan {
  command: string;
  args: string[];
  cwd: string;
  /** Extra environment on top of the adapter's allowlist. */
  env: Record<string, string>;
  /** `prompt` feeds the prompt to the process's standard input. */
  stdin: 'prompt' | 'none';
  /** The harness cannot be told a tool tier and needs it stated in the prompt. */
  tierInPrompt?: ToolTier;
}

export interface Adapter {
  id: string;
  transport: Transport;
  capabilities: AdapterCapabilities;
  /** Names of the service's own environment variables the child may receive, beyond the platform basics. */
  envAllow: string[];
  /** Fail fast when the harness is missing or a route option is invalid. */
  validate(route: RouteConfig): string | null;
  plan(request: JobRequest, route: RouteConfig, jobDir: string): LaunchPlan;
  /** Read usage from the job's captured output. */
  usage(stdout: string): UsageReport | null;
  /** The harness version, for the job record. */
  version?(route: RouteConfig): string | null;
}
