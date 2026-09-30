// Wire contract between the service and its callers. One JSON object per line over a named pipe, each request carrying the auth token.
import type { Accounted, BudgetStatus, RouteCalibration, Totals } from './accounting.js';
import type { Headroom } from './pace.js';
import type { ActivityId, DataTier } from '@augur/core';
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
  routes: { params: undefined; result: Array<{ name: string; model: string; adapter: string; problem: string | null }> };
  /** Tokens and cost of recent jobs and totals per route, each figure labelled reported, derived or imputed. */
  accounting: { params: { limit?: number }; result: AccountingAnswer };
}

export interface AccountingAnswer {
  jobs: Array<{ id: string; route: string; model: string | null; accounted: Accounted }>;
  routes: Record<string, { model: string | null; totals: Totals; calibration: RouteCalibration | null; budget: BudgetStatus | null }>;
  /** Models with a rate set, so a page can say when a route's cost is missing for want of one. */
  ratedModels: string[];
}
export type MethodName = keyof Methods;
