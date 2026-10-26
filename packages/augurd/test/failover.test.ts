import { describe, expect, it } from 'vitest';
import { LIMIT_PATTERNS, classifyFailure } from '../src/failover.js';
import type { FailureInput } from '../src/failover.js';

const base = (over: Partial<FailureInput> = {}): FailureInput => ({ tools: 'read', exitCode: 1, ...over });

describe('classifyFailure', () => {
  it('retries a preempted request at any tool tier', () => {
    expect(classifyFailure(base({ tools: 'write', failure: 'preempted: the gateway gave the model to another request', answer: 'part', changed: true }))).toEqual({ retry: true, why: 'preempted' });
    expect(classifyFailure(base({ stderrTail: 'HTTP 503: not preempted' })).retry).toBe(false);
  });

  it('retries a spawn error', () => {
    expect(classifyFailure(base({ tools: 'write', spawnError: 'spawn ENOENT', exitCode: null }))).toEqual({ retry: true, why: 'spawn error' });
  });

  it.each(LIMIT_PATTERNS)('retries when stderr says %s', (phrase) => {
    expect(classifyFailure(base({ stderrTail: `provider: ${phrase.toUpperCase()} right now` })).retry).toBe(true);
  });

  it.each(LIMIT_PATTERNS)('retries when the failure text says %s', (phrase) => {
    expect(classifyFailure(base({ failure: `stopped: ${phrase}` })).retry).toBe(true);
  });

  it('does not treat a 429 inside another number as a limit', () => {
    expect(classifyFailure(base({ stderrTail: 'code 14290' })).retry).toBe(false);
    expect(classifyFailure(base({ failure: 'error 429' })).retry).toBe(true);
  });

  it('retries a timeout only for a read or none tier', () => {
    expect(classifyFailure(base({ killedBy: 'timeout', tools: 'read', exitCode: null }))).toEqual({ retry: true, why: 'timed out' });
    expect(classifyFailure(base({ killedBy: 'timeout', tools: 'none', exitCode: null })).retry).toBe(true);
    expect(classifyFailure(base({ killedBy: 'timeout', tools: 'write', stderrTail: 'rate limit' })).retry).toBe(false);
    expect(classifyFailure(base({ killedBy: 'timeout', tools: 'full' })).retry).toBe(false);
  });

  it('retries a write or full limit only while the answer is empty and nothing was recorded as changed', () => {
    expect(classifyFailure(base({ tools: 'write', stderrTail: 'quota exceeded', answer: null })).retry).toBe(true);
    expect(classifyFailure(base({ tools: 'full', failure: 'overloaded', answer: '' })).retry).toBe(true);
    expect(classifyFailure(base({ tools: 'write', failure: 'rate limit', answer: 'edited two files' })).retry).toBe(false);
    expect(classifyFailure(base({ tools: 'full', stderrTail: 'capacity', answer: null, changed: true })).retry).toBe(false);
    expect(classifyFailure(base({ tools: 'read', stderrTail: 'quota', answer: 'partial', changed: true })).retry).toBe(true);
  });

  it('does not retry a plain exit, an empty answer, or a cancel', () => {
    expect(classifyFailure(base({ failure: 'exit 1' })).retry).toBe(false);
    expect(classifyFailure(base({ exitCode: 0, failure: 'exited cleanly but produced no answer' })).retry).toBe(false);
    expect(classifyFailure(base({ killedBy: 'cancel', stderrTail: 'rate limit', failure: 'quota' }))).toEqual({ retry: false, why: 'cancelled' });
  });
});
