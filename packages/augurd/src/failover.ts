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

/** A spawn error, a provider limit, or a timeout of a read-only job can be retried. A cancel, a write timeout, and an ordinary failure cannot. */
export function classifyFailure(input: FailureInput): { retry: boolean; why: string } {
  if (input.killedBy === 'cancel') return { retry: false, why: 'cancelled' };
  if (input.spawnError) return { retry: true, why: 'spawn error' };
  if (input.killedBy === 'timeout') return { retry: input.tools === 'read' || input.tools === 'none', why: 'timed out' };
  if (limited(`${input.failure ?? ''}\n${input.stderrTail ?? ''}`)) {
    // A write or full job may have changed files. Retry a limit only when it left no answer and no recorded change.
    if (input.tools === 'write' || input.tools === 'full') {
      if (input.changed || input.answer?.trim()) return { retry: false, why: 'provider limit' };
    }
    return { retry: true, why: 'provider limit' };
  }
  return { retry: false, why: 'not retryable' };
}
