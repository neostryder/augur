// Wire contract between the service and its callers. One JSON object per line over a named pipe, each request carrying the auth token.
import type { JobEvent, JobRecord, JobRequest, Rejection } from './spec.js';
import type { JobState } from './states.js';

export const PROTOCOL_VERSION = 1;

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
  routes: { params: undefined; result: Array<{ name: string; model: string; adapter: string }> };
}
export type MethodName = keyof Methods;
