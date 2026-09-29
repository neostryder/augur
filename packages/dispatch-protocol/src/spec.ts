import type { ActivityId, DataTier, OutputMode } from '@augur/core';
import type { JobState } from './states.js';

export type ToolTier = 'read' | 'write' | 'full';
export const TOOL_TIERS: readonly ToolTier[] = ['read', 'write', 'full'];

export interface Caller {
  kind: 'cli' | 'mcp' | 'job' | 'other';
  label?: string;
  /** The caller's own session, matched against recent picks when picks are required. */
  session?: string;
}
export interface Lineage { jobId: string; rootJobId: string; depth: number }

/** What a caller asks for. The prompt is delivered to the harness and is not stored unless the service is set to keep prompts. */
export interface JobRequest {
  route: string;
  activity: ActivityId;
  /** The most sensitive class of data the prompt or its files carry. Checked against the route's rule. */
  dataTier: DataTier;
  tools: ToolTier;
  output: OutputMode;
  cwd: string;
  prompt: { text?: string; file?: string };
  expectFile?: string;
  schema?: string;
  session?: string;
  timeoutS?: number;
  /** The caller reports that the person named this route. Recorded with the job. */
  named?: boolean;
  caller: Caller;
  parent?: Lineage;
  /** Checks the caller means to skip. Each use is recorded with the job. */
  allow?: Array<'unpicked' | 'exhausted'>;
}

/** Token counts as one figure set. `inputTokens` is the total input, including cached tokens, whatever the source counts. */
export interface UsageReport {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  currency?: string;
  /** Where the numbers came from. Imputed figures are added by the accounting layer and never replace these. */
  source: 'reported';
}

export interface JobRecord {
  id: string;
  state: JobState;
  route: string;
  adapter: string;
  activity: ActivityId;
  dataTier: DataTier;
  tools: ToolTier;
  output: OutputMode;
  cwd: string;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  exitCode: number | null;
  reason: string | null;
  rootJobId: string;
  parentJobId: string | null;
  depth: number;
  caller: Caller;
  named: boolean;
  harnessVersion: string | null;
  usage: UsageReport | null;
  /** Folder the job ran in when the adapter works on a copy of the workspace. */
  workspace: string | null;
  /** Patch of what the job changed in that copy, and how many files it touches. */
  patch: { path: string; files: number } | null;
}

export interface JobEvent { seq: number; jobId: string | null; at: number; kind: string; detail: string }

/** A run rejected by a rule or a limit before launch. */
export interface Rejection { code: RejectionCode; reason: string }
export const REJECTION_CODES = ['unknown_route', 'unknown_model', 'model_unreviewed', 'model_paused', 'ask_first', 'activity_not_permitted',
  'data_tier_too_high', 'sandbox_required', 'isolation_required', 'text_only', 'quota_denied', 'no_policy', 'depth_exceeded',
  'descendants_exceeded', 'adapter_unavailable', 'bad_request', 'delegation_not_granted', 'prompt_too_large', 'pace_denied', 'not_picked'] as const;
export type RejectionCode = typeof REJECTION_CODES[number];
