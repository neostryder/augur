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
}

export interface PlanContext {
  jobDir: string;
  /** The prompt as the caller gave it. Adapters add whatever framing their harness needs, such as `tierNote`. */
  prompt: string;
  /** For an adapter that works on a copy of the workspace: the folder the service copies the working directory into, as the host sees it. */
  workspace: string | null;
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
}

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
  transport: Transport;
  capabilities: AdapterCapabilities;
  /** Names of the service's own environment variables the child may receive, beyond the platform basics. */
  envAllow: string[];
  /** Fail fast when the harness is missing or a route option is invalid. */
  validate(route: RouteConfig): string | null;
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
