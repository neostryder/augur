// Wire contract between the service and its callers. One JSON object per line over a named pipe, each request carrying the auth token.
import type { Accounted, BudgetStatus, RouteCalibration, Totals } from './accounting.js';
import type { Headroom } from './pace.js';
import type { BalanceReport } from './balance-report.js';
import type { ActivityId, DataTier, EngineKey, EngineState } from '@augur/core';
import type { PickRequest, PickResult } from './pick.js';
import type { JobEvent, JobRecord, JobRequest, Rejection } from './spec.js';
import type { JobState } from './states.js';

export const PROTOCOL_VERSION = 1;

/**
 * A task is given either as its activity and data tier, or as a `task` description that the decision backend classifies. `fits` are per-model
 * fit scores from the caller; models without one are scored by the decision backend when there is one, and count as 0.5 otherwise.
 * Describe the kind of work in `task`, never paste its data.
 */
export interface PickParams extends Omit<PickRequest, 'activity' | 'dataTier'> {
  activity?: ActivityId;
  dataTier?: DataTier;
  task?: string;
  session?: string;
}
export type PickAnswer = (PickResult & {
  routes: Record<string, string[]>;
  activity: ActivityId;
  dataTier: DataTier;
  /** Id of the recorded pick, when the service keeps a decision record. */
  pickId?: string;
  /** What the decision backend answered, when it was asked. */
  decision?: { backend: string; classified?: unknown; fitError?: string };
}) | { error: string };

export interface RpcRequest { id: number; token: string; method: keyof Methods; params?: unknown }
export type RpcResponse<T = unknown> = { id: number; result: T } | { id: number; error: { code: string; message: string } };

export interface Methods {
  ping: { params: undefined; result: { pid: number; version: number; startedAt: number } };
  submit: { params: JobRequest; result: { id: string; warnings: string[] } | { rejected: Rejection } };
  status: { params: { id: string }; result: JobRecord | null };
  list: { params: { state?: JobState; root?: string; limit?: number }; result: JobRecord[] };
  events: { params: { id: string; since?: number }; result: JobEvent[] };
  logs: { params: { id: string; stream?: 'stdout' | 'stderr'; offset?: number; limit?: number }; result: { text: string; next: number; done: boolean } };
  result: { params: { id: string }; result: { job: JobRecord; answer: string | null } | null };
  cancel: { params: { id: string }; result: { ok: boolean; state: JobState } | null };
  /** Applies the patch a job left in its isolated workspace to the working directory the job was started for. */
  apply: { params: { id: string; check?: boolean }; result: { ok: boolean; output: string } | null };
  /** Ranks the models a task may use and records the pick, so later jobs for the same caller are cleared against it. */
  pick: { params: PickParams; result: PickAnswer };
  /** Tells the service a person sent a message in a session. It keeps which models the message named, and drops the text. */
  human_prompt: { params: { session: string; text: string }; result: { models: string[] } | { error: string } };
  /** Headroom per provider and the usage factor of every model. */
  pressure: { params: undefined; result: { pressure: Record<string, Headroom>; factors: Record<string, number>; scarcity: number } | null };
  /** The read-only balance report: Claude's pace, Copilot's spend, each provider's stance, where each kind of work goes now, and what the pick log shows for the last few days. */
  balance: { params: { days?: number } | undefined; result: BalanceReport | { error: string } };
  routes: { params: undefined; result: Array<{ name: string; model: string; adapter: string; problem: string | null }> };
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

/** What a view can do for the engine: show a desktop notice, read a provider page through its signed-in browser, open a sign-in window. */
export type ViewCapability = 'notify' | 'websession' | 'signin';
export interface ViewHello { kind: 'window' | 'terminal'; caps?: ViewCapability[]; appExe?: string }
export interface ViewInfo { kind: 'window' | 'terminal'; caps: ViewCapability[] }
export type EngineEvent =
  | { event: 'change'; keys: EngineKey[]; state: Partial<EngineState> }
  | { event: 'views'; views: ViewInfo[] }
  | { event: 'request'; rid: string; method: string; params: unknown };
export interface ViewReply { reply: string; result?: unknown; error?: string }

export interface AccountingAnswer {
  jobs: Array<{ id: string; route: string; model: string | null; accounted: Accounted }>;
  routes: Record<string, { model: string | null; totals: Totals; calibration: RouteCalibration | null; budget: BudgetStatus | null }>;
  /** Models with a rate set, so a page can say when a route's cost is missing for want of one. */
  ratedModels: string[];
}
export type MethodName = keyof Methods;
