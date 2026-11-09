import type { UsageReport } from './spec.js';

export const LEDGER_VERSION = 1;
export const LEDGER_KINDS = ['augur-job', 'media-job', 'llm-request', 'model-load', 'model-evict', 'install', 'download'] as const;
export const LEDGER_STATES = ['queued', 'running', 'stalled', 'done', 'failed', 'canceled', 'node-lost'] as const;
export const ORIGIN_KINDS = ['claude-code', 'cli', 'mcp', 'hermes', 'scheduled-task', 'service', 'other'] as const;
export type LedgerKind = typeof LEDGER_KINDS[number];
export type LedgerState = typeof LEDGER_STATES[number];
export type OriginKind = typeof ORIGIN_KINDS[number];
export type Attribution = 'stamped' | 'inferred' | 'unknown';

export interface Stamp {
  sessionId?: string;
  sessionTitle?: string;
  origin?: OriginKind;
  originLabel?: string;
  pid?: number;
  parentPid?: number;
  host?: string;
  summary?: string;
}
export interface LedgerAttribution {
  session: Attribution;
  origin: Attribution;
  process: Attribution;
  host: Attribution;
}
export interface LedgerMetadata {
  stamp: Stamp;
  attribution: LedgerAttribution;
  summary: string;
  summarySource: 'caller' | 'local-model' | 'none';
  model: string | null;
  compacted: boolean;
}

/** This projection wraps a JobRecord by reference; it never embeds harness output or a request. */
export interface LedgerJob {
  id: string;
  node: string;
  localId: string;
  kind: LedgerKind;
  state: LedgerState;
  stamp: Stamp;
  attribution: LedgerAttribution;
  summary: string;
  summarySource: 'caller' | 'local-model' | 'none';
  route: string | null;
  model: string | null;
  activity: string;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  updatedAt: number;
  lastActivityAt: number | null;
  /** A live line is transient. Nodes must not send prompt or answer text here. */
  activityLine?: string;
  parentId: string | null;
  replayOf?: string | null;
  retryOf: string | null;
  retriedAs: string | null;
  usage: UsageReport | null;
  exitReason: string | null;
  failureReason?: string;
  compacted: boolean;
}

export interface LedgerQuery {
  /** The root filter matches local executions only; localState preserves their original state names. */
  root?: string;
  localState?: import('./states.js').JobState;
  session?: string;
  origin?: OriginKind;
  node?: string;
  state?: LedgerState[];
  kind?: LedgerKind[];
  route?: string;
  /** Inclusive creation times, in milliseconds since the Unix epoch. */
  from?: number;
  to?: number;
  text?: string;
  sort?: 'createdAt' | 'startedAt' | 'endedAt' | 'durationMs';
  order?: 'asc' | 'desc';
  limit?: number;
  /** Opaque keyset cursor bound to these filters and ordering. */
  page?: string;
}
export interface LedgerPage { jobs: LedgerJob[]; next: string | null }
export interface LedgerChain { job: LedgerJob; parent: LedgerJob | null; children: LedgerJob[]; retries: LedgerJob[] }
export interface LedgerGap { at: number; from: string; to: string; retentionDays?: number }
export interface LedgerNode { node: string; cursor: string; unreachableSince: number | null; lastSeenAt: number | null; lastPollAt?: number | null; gap?: LedgerGap | null }
export interface LedgerChange { cursor: string; at: number; job: LedgerJob }
export interface LedgerWatchPage { changes: LedgerChange[]; cursor: string; more: boolean }
export interface LedgerWatchEvent { event: 'ledger_change'; change: LedgerChange }

/** Sequences are durable unsigned 64-bit decimal strings, including across node restarts. */
export interface NodeJobEvent { seq: string; at: number; job: LedgerJob }
export interface NodeJobPage {
  version: 1;
  node: string;
  events: NodeJobEvent[];
  next: string;
  more: boolean;
}

export interface LedgerAlert {
  version: 1;
  id: string;
  type: 'job.stalled' | 'job.failed' | 'job.over-usual-time';
  at: number;
  jobId: string;
  node: string;
  state: LedgerState;
  route: string | null;
  sessionId: string | null;
  summary: string;
  elapsedMs: number;
  usualMs: number | null;
  samples: number;
}

export interface LedgerAlertSettings {
  stalled: boolean;
  failed: boolean;
  overUsualTime: boolean;
  usualMultiple: number;
  minSamples: number;
  webhookUrl: string;
  webhookFormat: 'augur' | 'cresset';
  webhookKeyName: string;
}
export interface LedgerDeliveryState {
  sink: string;
  pending: number;
  delivered: number;
  failed: number;
  error: string | null;
}

export const STAMP_HEADERS: Readonly<Record<keyof Stamp, string>> = {
  sessionId: 'X-Augur-Session', sessionTitle: 'X-Augur-Session-Title', origin: 'X-Augur-Origin',
  originLabel: 'X-Augur-Origin-Label', pid: 'X-Augur-Pid', parentPid: 'X-Augur-Parent-Pid', host: 'X-Augur-Host', summary: 'X-Augur-Summary',
};

export const ledgerTerminal = (state: LedgerState): boolean => ['done', 'failed', 'canceled'].includes(state);
export const summaryLine = (text: string): string => text.replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
export const failureLine = (text: string): string => text.replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const line = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
const nullableLine = (v: unknown): boolean => v === null || line(v);
const time = (v: unknown): boolean => v === null || finite(v);
export const validCursor = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n;
export const validNode = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(v);

export function validLedgerGap(v: unknown): v is LedgerGap {
  return object(v) && keys(v, ['at', 'from', 'to', 'retentionDays']) && finite(v.at)
    && validCursor(v.from) && validCursor(v.to) && BigInt(v.to) > BigInt(v.from)
    && (v.retentionDays === undefined || (Number.isSafeInteger(v.retentionDays) && Number(v.retentionDays) >= 0));
}

export function ledgerId(node: string, localId: string): string {
  if (!validNode(node) || !/^[A-Za-z0-9._-]{1,128}$/.test(localId)) throw new Error('The ledger identifier is invalid.');
  return `${node}:${localId}`;
}

export function validStamp(v: unknown): v is Stamp {
  if (!object(v) || !keys(v, Object.keys(STAMP_HEADERS))) return false;
  for (const [k, value] of Object.entries(v)) {
    if (k === 'pid' || k === 'parentPid') { if (!Number.isSafeInteger(value) || Number(value) <= 0) return false; }
    else if (k === 'origin') { if (!ORIGIN_KINDS.includes(value as OriginKind)) return false; }
    else if (!line(value, k === 'summary' ? 120 : 256)) return false;
  }
  return v.summary === undefined || v.summary === summaryLine(v.summary as string);
}

export function stampHeaders(stamp: Stamp): Record<string, string> {
  if (!validStamp(stamp)) throw new Error('The job stamp is invalid.');
  return Object.fromEntries(Object.entries(stamp).map(([key, value]) => [STAMP_HEADERS[key as keyof Stamp], encodeURIComponent(String(value))]));
}

export function stampFromHeaders(headers: Record<string, string | undefined>): Stamp | null {
  try {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const stamp = Object.fromEntries(Object.entries(STAMP_HEADERS).flatMap(([key, header]) => {
      const raw = lower[header.toLowerCase()];
      if (raw === undefined) return [];
      const value = decodeURIComponent(raw);
      return [[key, key === 'pid' || key === 'parentPid' ? Number(value) : value]];
    }));
    return validStamp(stamp) ? stamp : null;
  } catch { return null; }
}

/** Only these four environment names are copied into metadata. */
export function stampFromEnv(env: Record<string, string | undefined>, origin: OriginKind): Stamp {
  const wanted = { sessionId: env.AUGUR_SESSION, sessionTitle: env.AUGUR_SESSION_TITLE, origin: env.AUGUR_ORIGIN ?? origin, summary: env.AUGUR_SUMMARY };
  const stamp = Object.fromEntries(Object.entries(wanted).filter(([, v]) => v !== undefined));
  if (!validStamp(stamp)) throw new Error('The job stamp is invalid.');
  return stamp;
}

export function validLedgerJob(v: unknown): v is LedgerJob {
  if (!object(v) || !keys(v, ['id', 'node', 'localId', 'kind', 'state', 'stamp', 'attribution', 'summary', 'summarySource', 'route', 'model', 'activity', 'createdAt', 'startedAt', 'endedAt', 'durationMs', 'updatedAt', 'lastActivityAt', 'activityLine', 'parentId', 'replayOf', 'retryOf', 'retriedAs', 'usage', 'exitReason', 'failureReason', 'compacted'])) return false;
  if (!validNode(v.node) || !line(v.localId, 128) || !/^[A-Za-z0-9._-]+$/.test(v.localId) || v.id !== `${v.node}:${v.localId}`) return false;
  if (!LEDGER_KINDS.includes(v.kind as LedgerKind) || !LEDGER_STATES.includes(v.state as LedgerState) || !validStamp(v.stamp)) return false;
  const a = v.attribution;
  if (!object(a) || !keys(a, ['session', 'origin', 'process', 'host']) || !['session', 'origin', 'process', 'host'].every(k => ['stamped', 'inferred', 'unknown'].includes(String(a[k])))) return false;
  if (!line(v.summary, 120) || v.summary !== summaryLine(v.summary) || !['caller', 'local-model', 'none'].includes(String(v.summarySource))) return false;
  if ((v.summarySource === 'none') !== (v.summary === '')) return false;
  if (!['route', 'model', 'exitReason'].every(k => nullableLine(v[k])) || !line(v.activity, 120)) return false;
  if (v.failureReason !== undefined && (v.state !== 'failed' || !line(v.failureReason, 300) || v.failureReason !== failureLine(v.failureReason))) return false;
  if (!['createdAt', 'updatedAt'].every(k => finite(v[k])) || !['startedAt', 'endedAt', 'durationMs', 'lastActivityAt'].every(k => time(v[k]))) return false;
  if ((v.startedAt !== null && Number(v.startedAt) < Number(v.createdAt)) || (v.endedAt !== null && Number(v.endedAt) < Number(v.startedAt ?? v.createdAt))) return false;
  if (ledgerTerminal(v.state as LedgerState) !== (v.endedAt !== null)) return false;
  if (v.durationMs !== (v.endedAt === null ? null : Number(v.endedAt) - Number(v.startedAt ?? v.createdAt))) return false;
  if (v.replayOf !== undefined && v.replayOf !== null && (typeof v.replayOf !== 'string' || !/^[A-Za-z0-9._-]{1,128}:[A-Za-z0-9._-]{1,128}$/.test(v.replayOf) || v.replayOf === v.id)) return false;
  if (!['parentId', 'retryOf', 'retriedAs'].every(k => v[k] === null || (typeof v[k] === 'string' && /^[A-Za-z0-9._-]{1,128}:[A-Za-z0-9._-]{1,128}$/.test(v[k] as string) && v[k] !== v.id))) return false;
  if (v.activityLine !== undefined && (!line(v.activityLine, 120) || v.activityLine !== summaryLine(v.activityLine))) return false;
  if (typeof v.compacted !== 'boolean') return false;
  if (v.usage !== null) {
    const u = v.usage;
    if (!object(u) || !keys(u, ['inputTokens', 'outputTokens', 'cachedReadTokens', 'cachedWriteTokens', 'reasoningTokens', 'reasoningInOutput', 'costUsd', 'currency', 'source']) || u.source !== 'reported' || !finite(u.inputTokens) || !finite(u.outputTokens)) return false;
    for (const [k, value] of Object.entries(u)) {
      if (k === 'source') continue;
      if (k === 'currency' ? !line(value, 8) : k === 'reasoningInOutput' ? typeof value !== 'boolean' : !finite(value)) return false;
    }
  }
  return true;
}

export function validNodeJobPage(v: unknown): v is NodeJobPage {
  if (!object(v) || !keys(v, ['version', 'node', 'events', 'next', 'more']) || v.version !== LEDGER_VERSION || !validNode(v.node) || !validCursor(v.next) || typeof v.more !== 'boolean' || !Array.isArray(v.events) || v.events.length > 1000) return false;
  let previous = 0n;
  for (const e of v.events) {
    if (!object(e) || !keys(e, ['seq', 'at', 'job']) || !validCursor(e.seq) || BigInt(e.seq) <= previous || (previous > 0n && BigInt(e.seq) !== previous + 1n) || !finite(e.at) || !validLedgerJob(e.job) || e.job.node !== v.node || e.job.kind === 'augur-job' || e.job.state === 'node-lost') return false;
    previous = BigInt(e.seq);
  }
  return v.events.length ? previous.toString() === v.next : !v.more;
}
