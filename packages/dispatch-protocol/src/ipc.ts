// Wire contract between the service and its callers. One JSON object per line over a named pipe, each request carrying the auth token.
import type { Accounted, BudgetStatus, RouteCalibration, Totals } from './accounting.js';
import type { RouteAddAnswer, RouteAddParams } from './route-add.js';
import type { RouteCapabilities } from './adapter.js';
import type { Headroom } from './pace.js';
import type { BalanceReport } from './balance-report.js';
import type { ResetLedger, ResetQuery } from './resets.js';
import type { ActivityId, DataTier, EngineKey, EngineState } from '@augur/core';
import type { PickRequest, PickResult } from './pick.js';
import type { Proposal } from './pick-training.js';
import type { Conversation, JobEvent, JobRecord, JobRequest, Rejection } from './spec.js';
import type { JobState } from './states.js';

export const PROTOCOL_VERSION = 1;

/**
 * A task is given either as its activity and data tier, or as a `task` description that the decision backend classifies. `fits` are per-model
 * fit scores from the caller; models without one are scored by the decision backend when there is one, and count as 0.5 otherwise.
 * Describe the kind of work in `task`, never paste its data.
 */
export interface PickParams extends Omit<PickRequest, 'activity' | 'dataTier' | 'spent'> {
  activity?: ActivityId;
  dataTier?: DataTier;
  task?: string;
  session?: string;
  /** Rank and report the odds, and do not draw or record a pick. */
  preview?: boolean;
}
export type PickAnswer = (PickResult & {
  routes: Record<string, string[]>;
  activity: ActivityId;
  dataTier: DataTier;
  /** Id of the recorded pick, when the service keeps a decision record. */
  pickId?: string;
  /** Training mode's reading of the pick. `pending` means the pick waits for a person and no job may run on it until `pick_answer` records the answer. */
  proposal?: Proposal & { pending: boolean };
  /** What the decision backend answered, when it was asked. */
  decision?: { backend: string; classified?: unknown; fitError?: string };
}) | { error: string };

export interface RpcRequest { id: number; token: string; method: keyof Methods; params?: unknown }
export type RpcResponse<T = unknown> = { id: number; result: T } | { id: number; error: { code: string; message: string } };

export interface Methods {
  alias_refresh: { params: { label?: string } | undefined; result: unknown };
  backlog_add: { params: { item: unknown }; result: unknown };
  backlog_approve: { params: { id: string }; result: unknown };
  backlog_list: { params: { status?: string }; result: unknown };
  backlog_status: { params: undefined; result: unknown };
  backlog_run: { params: { dryRun?: boolean }; result: unknown };
  backlog_drop: { params: { id: string }; result: unknown };
  resets: { params: ResetQuery | undefined; result: ResetLedger };
  ping: { params: undefined; result: { pid: number; version: number; startedAt: number } };
  submit: { params: JobRequest; result: { id: string; warnings: string[] } | { rejected: Rejection } };
  status: { params: { id: string }; result: JobRecord | null };
  list: { params: { state?: JobState; root?: string; limit?: number }; result: JobRecord[] };
  /** Named conversations, newest first. */
  conversations: { params: undefined; result: Conversation[] };
  /** Drops a named conversation. A running job that holds it is left in place and the name stays. */
  forget_conversation: { params: { name: string }; result: { forgotten: boolean; reason?: string } };
  events: { params: { id: string; since?: number }; result: JobEvent[] };
  logs: { params: { id: string; stream?: 'stdout' | 'stderr'; offset?: number; limit?: number }; result: { text: string; next: number; done: boolean } };
  result: { params: { id: string }; result: { job: JobRecord; answer: string | null } | null };
  cancel: { params: { id: string }; result: { ok: boolean; state: JobState } | null };
  /** Applies the patch a job left in its isolated workspace to the working directory the job was started for. */
  apply: { params: { id: string; check?: boolean }; result: { ok: boolean; output: string } | null };
  /** Ranks the models a task may use, draws the pick from the odds unless `best` or `preview` is set, and records it, so later jobs for the same caller are cleared against it. A preview records nothing. */
  pick: { params: PickParams; result: PickAnswer };
  /** Tells the service a person sent a message in a session. It keeps which models the message named, and drops the text. */
  human_prompt: { params: { session: string; text: string }; result: { models: string[] } | { error: string } };
  /** Headroom per provider and the usage factor of every model. */
  pressure: { params: undefined; result: { pressure: Record<string, Headroom>; factors: Record<string, number>; scarcity: number } | null };
  /** The balance report records current provider window changes on the owner's path; agent calls read it without recording changes. */
  balance: { params: { days?: number } | undefined; result: BalanceReport | { error: string } };
  gate_status: { params: undefined; result: { close: number; providers: Array<{ provider: string; state: 'open' | 'closed'; gap: number | null; window: string | null; labels: string[]; lastApproval: string | null }> } | { error: string } };
  gate_report: { params: undefined; result: Record<string, unknown> | { error: string } };
  gate_record: { params: { kind: string; route: string; scope: string; note?: string }; result: { ok: true } | { error: string } };
  /** Records a person's answer to a pending proposal: the route they chose, and an optional reason. The chosen route is then cleared for jobs, and the answer feeds training mode. */
  pick_answer: { params: { id: string; model: string; why?: string }; result: { ok: true; agreed: boolean; key: string; n: number; agreedOf: number } | { error: string } };
  /** Records how a job's report met its brief, beside the pick in the decision log. `id` is a pick id or a job id; the check itself runs in the caller's tooling. */
  label: { params: { id: string; result: 'met' | 'partly' | 'missed'; note?: string }; result: { ok: true; pick: string; job: string | null } | { error: string } };
  /** Grades a candidate answer against a rubric (a Score per dimension, each asked in two orders). The grade is recorded in the decision log and what it may be used for follows the rubric's stakes. */
  grade: { params: GradeParams; result: GradeAnswer | { error: string } };
  /** Records whether a person agreed with a grade (or found it too high or too low), which is what moves a rubric up from shadow. */
  grade_label: { params: { id: string; label: 'agree' | 'high' | 'low'; note?: string }; result: { ok: true; rubric: string; mode: 'shadow' | 'advise' | 'gate' } | { error: string } };
  /** Each rubric in the rubrics folder with its labelled grades, agreement, and the mode it has earned; `rubric` limits it to one. */
  grade_report: { params: { rubric?: string } | undefined; result: GradeReport | { error: string } };
  prose_add: { params: ProseAddParams; result: ProseItem | { error: string } };
  prose_list: { params: { status?: ProseStatus } | undefined; result: ProseItem[] };
  prose_status: { params: undefined; result: ProseQueueStatus };
  prose_run: { params: { dryRun?: boolean; caller?: import('./spec.js').Caller } | undefined; result: { started: boolean; batchId?: string; items?: string[]; reason?: string } };
  prose_approve: { params: { id: string }; result: ProseItem | { error: string } };
  routes: { params: undefined; result: Array<{ name: string; model: string; adapter: string; problem: string | null; capabilities: RouteCapabilities }> };
  /** Adds one route and, optionally, its model. The model stays unreviewed. An existing route name is refused and nothing is written. */
  route_add: { params: RouteAddParams; result: RouteAddAnswer };
  /** Tokens and cost of recent jobs and totals per route, each figure labelled reported, derived or imputed. */
  accounting: { params: { limit?: number }; result: AccountingAnswer };
  /** The usage engine's state, whole or only the keys named. Refused when the engine is not running in this service. */
  engine_state: { params: { keys?: EngineKey[] } | undefined; result: { state: Partial<EngineState>; views: ViewInfo[] } };
  /** Runs one engine command (refresh, saveConfig, setProviderKey and the rest) and resolves to its answer. */
  engine_call: { params: { method: string; args?: unknown[] }; result: unknown };
  /**
   * Keeps the connection open as a view. The first answer carries the whole state; after it the service sends `EngineEvent` lines, and the view
   * answers each `request` event with one `ViewReply` line on the same connection.
   */
  engine_watch: { params: { hello: ViewHello }; result: { state: EngineState; views: ViewInfo[] } };
}

export type ProseStatus = 'queued' | 'awaiting-approval' | 'running' | 'drafted' | 'failed';
export interface ProseAddParams { requester: string; repo: string; target: string; kind: 'write' | 'rewrite' | 'review' | 'sweep-edit'; surface: 'README' | 'changelog' | 'ui-strings' | 'post' | 'doc' | 'other'; audience: string; voice: string; dataTier?: DataTier; urgency?: 'normal' | 'urgent'; facts?: Array<{ text: string; source: string }>; mustInclude?: string[]; mustAvoid?: string[]; currentText?: string; context?: Record<string, string>; limits?: { length?: string; format?: string } }
export interface ProseItem extends ProseAddParams { id: string; createdAt: string; dataTier: DataTier; status: ProseStatus; statusLog: Array<{ at: string; status: ProseStatus; note: string }>; result?: { text: string; modelId: string; cost: number | null; runId: string } }
export interface ProseQueueStatus { counts: Record<ProseStatus, number>; oldestAgeMs: number | null; due: boolean }

/** What a view can do for the engine: show a desktop notice, read a provider page through its signed-in browser, open a sign-in window. */
export type ViewCapability = 'notify' | 'websession' | 'signin';
export interface ViewHello { kind: 'window' | 'terminal'; caps?: ViewCapability[]; appExe?: string }
export interface ViewInfo { kind: 'window' | 'terminal'; caps: ViewCapability[] }
export type EngineEvent =
  | { event: 'change'; keys: EngineKey[]; state: Partial<EngineState> }
  | { event: 'views'; views: ViewInfo[] }
  | { event: 'request'; rid: string; method: string; params: unknown };
export interface ViewReply { reply: string; result?: unknown; error?: string }

export interface GradeParams { rubric: string; task: string; candidate: string; reference?: string; tier?: 'public' | 'internal' | 'sensitive' | 'regulated' }
export interface GradeAnswer {
  id: string; rubric: string; version: number; tier: string; backend: string;
  dims: Record<string, { score: number; spread: number }>; overall: number; uncertainty: number;
  /** shadow: recorded only. advise: shown beside the work. gate: a low-stakes caller may act on `verdict`. */
  mode: 'shadow' | 'advise' | 'gate';
  verdict: 'pass' | 'fail' | 'review' | null;
  /** In gate mode, a share of grades are flagged for a person to check and label. */
  audit: boolean;
}
export interface GradeReportRow {
  rubric: string; version: number; stakes: 'low' | 'medium' | 'high'; grades: number; labeled: number; agree: number; high: number; low: number;
  agreeShare: number | null; mode: 'shadow' | 'advise' | 'gate'; next: string | null;
}
export interface GradeReport { rubrics: GradeReportRow[]; problems: string[] }

export interface AccountingAnswer {
  jobs: Array<{ id: string; route: string; model: string | null; accounted: Accounted }>;
  routes: Record<string, { model: string | null; totals: Totals; calibration: RouteCalibration | null; budget: BudgetStatus | null }>;
  /** Models with a rate set, so a page can say when a route's cost is missing for want of one. */
  ratedModels: string[];
}
export type MethodName = keyof Methods;
