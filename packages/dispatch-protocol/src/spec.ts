import type { ActivityId, DataTier, OutputMode } from '@augur/core';
import type { JobState } from './states.js';

export type ToolTier = 'read' | 'write' | 'full';
export const TOOL_TIERS: readonly ToolTier[] = ['read', 'write', 'full'];

export interface Caller {
  kind: 'cli' | 'mcp' | 'job' | 'other' | 'service';
  label?: string;
  /** The caller's own session, matched against recent picks when picks are required. */
  session?: string;
  /** A person is at the keyboard: the caller is a terminal with input and output attached. A claim that the person named a model is taken as true. */
  interactive?: boolean;
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
  /** Keep this prompt out of the job folder even when prompt persistence is on. */
  persistPrompt?: boolean;
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
  /** Set to false to keep the job on the route named. A fallback is not tried at submit, and a failure is not retried. */
  failover?: boolean;
  /** Charter packs to add. Each entry is one name or a comma-separated list. */
  packs?: string[];
  /** Send the prompt with no charter. */
  noCharter?: boolean;
  /** The job is wanted now. A route to a local gateway sends its normal priority class instead of the low one background work gets. */
  urgent?: boolean;
  /** Files sent with the prompt: text read into it, images shown to a model that sees them, or audio to transcribe. Each stays inside the working folder. */
  attach?: string[];
  /** A named conversation to open or resume. It stays on the route that opened it. This is not the caller's own session. */
  conversation?: string;
}

/** Token counts as one figure set. `inputTokens` is the total input, including cached tokens, whatever the source counts. */
export interface UsageReport {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  reasoningTokens?: number;
  /** True when `outputTokens` already counts the reasoning tokens (Codex, Copilot and the OpenAI chat format do). Left out when the harness reports them apart, and accounting then adds them. */
  reasoningInOutput?: boolean;
  costUsd?: number;
  currency?: string;
  /** Where the numbers came from. Imputed figures are added by the accounting layer and never replace these. */
  source: 'reported';
}

/** What a gateway reports about a request it served. Every field is optional; a gateway sends what it knows. `chainPosition` counts from 0, the first link. */
export interface Served { host?: string; model?: string; chainPosition?: number; degraded?: boolean }

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
  /** Length in characters of the prompt sent and of the answer received. Only the lengths are kept, so token counts can be estimated for a harness that reports none. The prompt length is the caller's prompt, not a charter prefixed to it. */
  promptChars?: number | null;
  answerChars?: number | null;
  /** Charter parts prefixed to the prompt, when a charter was built. Absent on rows from before charters. */
  charter?: string[];
  /** Length of that charter text. */
  charterChars?: number;
  /** Packs that were named and not found, and other charter notes. */
  charterNotes?: string[];
  /** Whether the harness ambient context was left on or trimmed. Absent on rows from before this field. */
  ambient?: 'keep' | 'trim';
  /** Named conversation this job opens or resumes. Absent when the job stands alone, and on rows from before conversations. */
  conversation?: string;
  /** This job's turn in that conversation, starting at 1. */
  turn?: number;
  /** Where a gateway says it served the job: the machine, the model, and which link of the chain. Absent for a route with no gateway, and on rows from before this field. */
  served?: Served;
  /** The failed job this one replaced. Absent when the job is not a retry, and on rows from before retries. */
  retryOf?: string;
  /** The job submitted to replace this one. Absent when this job was not retried. */
  retriedAs?: string;
  /** Folder the job ran in when the adapter works on a copy of the workspace. */
  workspace: string | null;
  /** Patch of what the job changed in that copy, and how many files it touches. */
  patch: { path: string; files: number } | null;
}

/** A named conversation. Later jobs with the same name resume it on the route that opened it. */
export interface Conversation {
  name: string;
  route: string;
  adapter: string;
  nativeId: string | null;
  cwd: string;
  /** Tool tier of the opening turn. A resumed Codex session keeps it. */
  tools: ToolTier;
  turns: number;
  createdAt: number;
  lastUsedAt: number;
}

export interface JobEvent { seq: number; jobId: string | null; at: number; kind: string; detail: string }

/** A run rejected by a rule or a limit before launch. */
export interface Rejection { code: RejectionCode; reason: string }
export const REJECTION_CODES = ['unknown_route', 'unknown_model', 'model_unreviewed', 'model_paused', 'ask_first', 'activity_not_permitted',
  'data_tier_too_high', 'sandbox_required', 'isolation_required', 'text_only', 'quota_denied', 'no_policy', 'depth_exceeded',
  'descendants_exceeded', 'adapter_unavailable', 'bad_request', 'delegation_not_granted', 'prompt_too_large', 'pace_denied', 'not_picked', 'read_not_enforceable', 'budget_exhausted', 'jobs_off', 'attachment_rejected'] as const;
export type RejectionCode = typeof REJECTION_CODES[number];

export type AttachmentKind = 'text' | 'image' | 'audio';
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'], AUDIO_EXT = ['.wav', '.mp3', '.m4a', '.ogg', '.oga', '.opus', '.flac', '.webm', '.aac'];
const TEXT_EXT = ['.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.xml', '.html', '.htm', '.yaml', '.yml', '.toml', '.ini', '.log', '.srt', '.vtt', '.rst',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.cs', '.sh', '.ps1', '.sql', '.css'];
/** What kind of attachment a path is, from its extension, or null when Augur does not take that type. */
export function attachmentKind(path: string): AttachmentKind | null {
  const dot = path.lastIndexOf('.'), ext = dot < 0 ? '' : path.slice(dot).toLowerCase();
  return IMAGE_EXT.includes(ext) ? 'image' : AUDIO_EXT.includes(ext) ? 'audio' : TEXT_EXT.includes(ext) ? 'text' : null;
}
/** An attachment the supervisor has checked and resolved to an absolute path. */
export interface ResolvedAttachment { path: string; kind: AttachmentKind; bytes: number }
