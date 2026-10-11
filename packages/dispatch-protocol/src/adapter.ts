import type { AttachmentKind, JobRequest, ResolvedAttachment, ToolTier, UsageReport } from './spec.js';

/** How a harness or model is reached. Every transport implements the same contract, so rules and job history do not depend on it. */
export type Transport = 'exec' | 'acp' | 'api' | 'web';

export interface AdapterCapabilities {
  /** The transport can ask before a tool runs, so a denial is honored. */
  permissionRequests: boolean;
  /** The harness can resume a named conversation across jobs. */
  sessions: boolean;
  /** The harness reports token counts of its own. */
  reportsUsage: boolean;
  /** The harness runs inside a sandbox the service does not have to provide. */
  sandboxed: boolean;
  /** The harness works on a copy of the workspace, so `patch_only` can export a diff. */
  isolatesWorkspace: boolean;
  /** A read tier is held by the harness itself (it denies writes and commands), not just asked for in the prompt. A bare model with no tools holds it trivially. */
  enforcesReadOnly: boolean;
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
  /** A ceiling on what the route may use in a rolling period. A submit past it is refused. Every job in the period counts toward a job limit, and a dollar limit counts the jobs whose cost is known. */
  budget?: RouteBudget;
  /** Routes tried in order when this one cannot take a job for a reason that may pass: its budget, a pause, plan usage, or a missing adapter or key. With runner.failover on, a failed job is retried on this list too. */
  fallback?: string[];
}

export const BUDGET_PERIODS = ['day', 'week', 'month'] as const;
export type BudgetPeriod = typeof BUDGET_PERIODS[number];
/** Dollars and jobs are each optional; at least one is set. Dollars count only jobs whose cost is known. */
export interface RouteBudget { per: BudgetPeriod; usd?: number; jobs?: number }

export interface PlanContext {
  jobDir: string;
  /** The prompt for this job. A charter, when one was built, is already prefixed. Adapters add framing their harness needs, such as `tierNote`. */
  prompt: string;
  /** Service setting `runner.ambient`. The route option `ambient` overrides it. Absent means keep. */
  ambient?: 'keep' | 'trim';
  /** For an adapter that works on a copy of the workspace: the folder the service copies the working directory into, as the host sees it. */
  workspace: string | null;
  /** Set when this job opens or resumes a named conversation. `fresh` is the first turn. `id` is null when the harness assigns one after the turn. */
  resume?: { id: string | null; fresh: boolean; name: string };
  /** The request's attachments, checked and resolved. Empty when there are none. */
  attachments?: ResolvedAttachment[];
}

export interface LaunchPlan {
  command: string;
  args: string[];
  cwd: string;
  /** Extra environment on top of the adapter's allowlist. Values here are written to disk, so they must not be secrets. */
  env: Record<string, string>;
  /** Text fed to the process's standard input, or null for none. It is held in memory by the runner and is not on disk while the job runs. */
  stdin: string | null;
  /** Files the service writes before launch and removes when the job ends, unless prompts are kept. Paths are relative to the job folder, or to the copied workspace when `inWorkspace` is set. */
  files?: Array<{ name: string; content: string; inWorkspace?: boolean }>;
  /** Indexes of `args` that carry prompt text. The service removes them from its copy of the plan once the job has started. */
  promptArgs?: number[];
}

export interface Extraction {
  /** The harness's final answer. Empty or null on a clean exit is a failed job. */
  answer: string | null;
  usage: UsageReport | null;
  /** A reason the job failed although the process exited cleanly. */
  failure?: string;
  /** Native session id the harness reported. The service stores it when the job completes. */
  sessionId?: string;
  /** Where the answer came from when the service in front of the model says so: the machine and link that served it, and whether it was a fallback link. */
  served?: Served;
}

/** What a gateway reports about a request it served. Every field is optional; a gateway sends what it knows. */
export interface Served { host?: string; model?: string; chainPosition?: number; degraded?: boolean }

export interface ExtractInput {
  /** The last few megabytes of standard output. A long transcript is read from `stdoutPath` instead. */
  stdout: string;
  stdoutPath: string;
  stderr: string;
  exitCode: number | null;
  jobDir: string;
  workspace: string | null;
}

export interface Adapter {
  id: string;
  /**
   * Charter file under charter/engines. Null means this adapter gets no charter (it keeps its own persona).
   * Omitted means core and packs only, with no engine file.
   */
  charterEngine?: string | null;
  transport: Transport;
  capabilities: AdapterCapabilities;
  /** Names of the service's own environment variables the child may receive, beyond the platform basics. */
  envAllow: string[];
  /** Fail fast when the harness is missing or a route option is invalid. */
  validate(route: RouteConfig): string | null;
  /** The kinds of file this route takes with a prompt. Absent means none. */
  attachmentKinds?(route: RouteConfig): AttachmentKind[];
  plan(request: JobRequest, route: RouteConfig, ctx: PlanContext): LaunchPlan;
  /** Reads the answer and usage out of what the harness left behind. */
  extract(input: ExtractInput): Extraction;
  /** The harness version, for the job record. */
  version?(route: RouteConfig): string | null;
  /** Set for an adapter that works on a copy of the workspace, such as one that runs in a sandbox. */
  isolation?: { root(route: RouteConfig): string };
}

const NOTES: Record<ToolTier, string> = {
  read: 'READ-ONLY TASK. Do not create, modify, delete, move or rename any file, and do not run any command that writes to disk, installs packages, or mutates git state. Read, search and report only. If the task cannot be done without writing, say so and stop.',
  write: 'Confine all edits to the working directory for this task. Do not modify files outside it, and do not install packages or change global or git config.',
  full: '',
};

/** Puts the tool tier in the prompt, for harnesses that cannot be told and would otherwise ignore it. */
export function tierNote(tools: ToolTier, prompt: string): string { return NOTES[tools] ? `${NOTES[tools]}\n\n${prompt}` : prompt; }
