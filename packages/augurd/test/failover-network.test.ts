import { describe, expect, it } from 'vitest';
import { NETWORK_PATTERNS, classifyNetworkFailure, isNetworkFailure, networkBackoffS } from '../src/failover.js';
import type { FailureInput } from '../src/failover.js';

const base = (over: Partial<FailureInput & { offline: boolean }> = {}): FailureInput & { offline?: boolean } => ({ tools: 'read', exitCode: 1, ...over });

describe('network failures', () => {
  it.each(NETWORK_PATTERNS)('reads %s as a lost connection', phrase => {
    expect(isNetworkFailure(`claude: ${phrase.toUpperCase()} while calling the API`)).toBe(true);
  });

  it('does not read an ordinary failure or a spent retry as a lost connection', () => {
    expect(isNetworkFailure('HTTP 400: bad request')).toBe(false);
    expect(isNetworkFailure('request failed after 10 attempts: fetch failed')).toBe(false);
  });

  it('waits 10, 20, 40, then 60 seconds', () => {
    expect([1, 2, 3, 4, 5, 10].map(networkBackoffS)).toEqual([10, 20, 40, 60, 60, 60]);
  });

  it.each(['stderrTail', 'failure'] as const)('retries a lost connection in %s at a read or none tier', field => {
    expect(classifyNetworkFailure(base({ [field]: 'API Error: Unable to connect to API (ConnectionRefused)' }))).toEqual({ retry: true, why: 'network failure' });
    expect(classifyNetworkFailure(base({ tools: 'none', [field]: 'fetch failed' }))).toEqual({ retry: true, why: 'network failure' });
  });

  it('retries a write or full tier job only when it left no answer and no change', () => {
    const text = { stderrTail: 'stream disconnected before completion' };
    expect(classifyNetworkFailure(base({ tools: 'write', ...text })).retry).toBe(true);
    expect(classifyNetworkFailure(base({ tools: 'full', ...text, answer: '' })).retry).toBe(true);
    expect(classifyNetworkFailure(base({ tools: 'write', ...text, answer: 'partial' })).retry).toBe(false);
    expect(classifyNetworkFailure(base({ tools: 'full', ...text, changed: true })).retry).toBe(false);
  });

  it('counts a job stopped for inactivity as a network failure only while offline', () => {
    expect(classifyNetworkFailure(base({ killedBy: 'timeout', exitCode: null, offline: true }))).toEqual({ retry: true, why: 'network failure' });
    expect(classifyNetworkFailure(base({ killedBy: 'timeout', exitCode: null, offline: false })).retry).toBe(false);
    expect(classifyNetworkFailure(base({ killedBy: 'timeout', exitCode: null })).retry).toBe(false);
    expect(classifyNetworkFailure(base({ tools: 'write', killedBy: 'timeout', exitCode: null, offline: true, changed: true })).retry).toBe(false);
  });

  it('never retries a cancel or an unrelated failure', () => {
    expect(classifyNetworkFailure(base({ killedBy: 'cancel', stderrTail: 'ECONNRESET' }))).toEqual({ retry: false, why: 'cancelled' });
    expect(classifyNetworkFailure(base({ stderrTail: 'rate limit' })).retry).toBe(false);
  });
});
