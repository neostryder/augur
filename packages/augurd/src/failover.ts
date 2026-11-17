// Whether a finished job can be run again on a fallback route.
import type { ToolTier } from '@augur/dispatch-protocol';

/** The most jobs in one retry chain, including the first. */
export const MAX_HOPS = 3;

/**
 * Phrases that mean a provider stopped for a limit. From the toolkit's retry list and from harness messages seen in job logs.
 * Matching is case-insensitive. `429` matches only as its own number.
 */
export const LIMIT_PATTERNS: readonly string[] = [
  'rate limit',
  'rate-limit',
  'quota',
  'allowance',
  'usage limit',
  '429',
  'overloaded',
  'capacity',
  'insufficient credits',
  'credit balance',
  'resource exhausted',
  'too many requests',
  'try again later',
];

export interface FailureInput {
  spawnError?: string;
  killedBy?: 'cancel' | 'timeout' | null;
  exitCode?: number | null;
  failure?: string;
  stderrTail?: string;
  /** `read`, `write` and `full` are the protocol tiers. `none` counts as read for a timeout, which did not write files. */
  tools: ToolTier | 'none';
  /** Write and full limit failures retry only while this is empty. Omitted counts as empty. */
  answer?: string | null;
  /** Write and full limit failures do not retry when the job left a recorded change. Omitted means the change is not known. */
  changed?: boolean;
}

const limited = (text: string): boolean => LIMIT_PATTERNS.some(p => p === '429' ? /(?:^|\D)429(?:\D|$)/.test(text) : text.toLowerCase().includes(p));

/**
 * Phrases a lost connection leaves in an error: Node's socket codes, the harnesses' own connection messages, and the system resolver's.
 * Matching is case-insensitive.
 */
export const NETWORK_PATTERNS: readonly string[] = [
  'enotfound', 'eai_again', 'econnrefused', 'econnreset', 'etimedout', 'enetunreach', 'ehostunreach', 'enetdown',
  'und_err_connect_timeout', 'und_err_socket', 'fetch failed', 'getaddrinfo', 'socket hang up', 'network is unreachable',
  'network error', 'connection error', 'connection reset', 'connection refused', 'connection closed', 'unable to connect',
  'failedtoopensocket', 'stream disconnected', 'error sending request', 'could not resolve host', 'dns error',
  'temporary failure in name resolution', 'tls handshake',
];

/** A retry that ran out of attempts says so with this phrase, and is not run again by another layer. */
const GAVE_UP = /after \d+ attempts/i;

/** True when the text reads like a lost connection and does not say that a retry already gave up. */
export function isNetworkFailure(text: string): boolean {
  const t = text.toLowerCase();
  return !GAVE_UP.test(t) && NETWORK_PATTERNS.some(p => t.includes(p));
}

/** Seconds to wait before network retry `attempt` (1 is the first): 10, 20, 40, then 60 each. */
export function networkBackoffS(attempt: number): number { return Math.min(60, 10 * 2 ** Math.max(0, attempt - 1)); }

/**
 * Whether a job that a network outage interrupted can run again on the same route. `offline` says the computer could not reach the internet when the job
 * was stopped for inactivity, which is what an outage looks like to a harness that waits in silence. A read or none tier job always runs again; a write
 * or full tier job runs again only when it left no answer and no recorded change.
 */
export function classifyNetworkFailure(input: FailureInput & { offline?: boolean }): { retry: boolean; why: string } {
  if (input.killedBy === 'cancel') return { retry: false, why: 'cancelled' };
  const text = `${input.failure ?? ''}\n${input.stderrTail ?? ''}`;
  if (!isNetworkFailure(text) && !(input.killedBy === 'timeout' && input.offline)) return { retry: false, why: 'not a network failure' };
  if ((input.tools === 'write' || input.tools === 'full') && (input.changed || input.answer?.trim())) return { retry: false, why: 'network failure after work began' };
  return { retry: true, why: 'network failure' };
}

/** A spawn error, a preemption by a person's request, a provider limit, or a timeout of a read-only job can be retried. A cancel, a write timeout, and an ordinary failure cannot. */
export function classifyFailure(input: FailureInput): { retry: boolean; why: string } {
  if (input.killedBy === 'cancel') return { retry: false, why: 'cancelled' };
  if (input.spawnError) return { retry: true, why: 'spawn error' };
  // A gateway that gave the model to a person's request ran nothing of this job, so it is safe to move whatever the tool tier.
  if (/(?:^|\W)preempted:/.test(`${input.failure ?? ''}\n${input.stderrTail ?? ''}`)) return { retry: true, why: 'preempted' };
  if (input.killedBy === 'timeout' || /no finished (?:reply|picture) from/i.test(`${input.failure ?? ''}\n${input.stderrTail ?? ''}`)) return { retry: input.tools === 'read' || input.tools === 'none', why: 'timed out' };
  if (/the connection to the browser was lost/i.test(`${input.failure ?? ''}\n${input.stderrTail ?? ''}`)) return { retry: input.tools === 'read' || input.tools === 'none', why: 'connection lost' };
  // A web chat job that stopped before sending anything can move to a fallback without writing files.
  if (/the browser did not start listening in time|no browser is listening on port|the browser .* was not found|nobody is signed in to|the human check was not finished in time|was not found on|so nothing was sent|so the page no longer matches the site profile/i.test(`${input.failure ?? ''}\n${input.stderrTail ?? ''}`)) return { retry: input.tools === 'read' || input.tools === 'none', why: 'nothing was sent' };
  if (limited(`${input.failure ?? ''}\n${input.stderrTail ?? ''}`)) {
    // A write or full job may have changed files. Retry a limit only when it left no answer and no recorded change.
    if (input.tools === 'write' || input.tools === 'full') {
      if (input.changed || input.answer?.trim()) return { retry: false, why: 'provider limit' };
    }
    return { retry: true, why: 'provider limit' };
  }
  return { retry: false, why: 'not retryable' };
}
