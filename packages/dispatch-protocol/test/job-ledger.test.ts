import { describe, expect, it } from 'vitest';
import { ledgerPage, ledgerQuery, ledgerTime } from '../src/ledger-query.js';
import { checkBalanceSetting, ledgerId, resolveBalance, stampFromEnv, stampFromHeaders, stampHeaders, summaryLine, validCursor, validLedgerGap, validLedgerJob, validNodeJobPage, validStamp } from '../src/index.js';
import type { LedgerJob } from '../src/index.js';

const job = (): LedgerJob => ({ id: 'eru:1', node: 'eru', localId: '1', kind: 'llm-request', state: 'running', stamp: {}, attribution: { session: 'unknown', origin: 'unknown', process: 'unknown', host: 'unknown' }, summary: '', summarySource: 'none', route: null, model: 'summarize', activity: 'summarize', createdAt: 1, startedAt: 2, endedAt: null, durationMs: null, updatedAt: 2, lastActivityAt: 2, parentId: null, retryOf: null, retriedAs: null, usage: null, exitReason: null, compacted: false });

describe('the job ledger contract', () => {
  it('accepts only advancing metadata gaps with valid times and optional retention days', () => {
    const gap = { at: 1000, from: '1', to: '10' };
    expect(validLedgerGap(gap)).toBe(true); expect(validLedgerGap({ ...gap, retentionDays: 7 })).toBe(true);
    for (const fields of [{ at: -1 }, { at: NaN }, { from: '01' }, { to: '1' }, { to: '0' }, { to: '18446744073709551616' }, { retentionDays: -1 }, { retentionDays: 1.5 }, { retentionDays: '7' }, { prompt: 'private' }, { answer: 'private' }]) expect(validLedgerGap({ ...gap, ...fields })).toBe(false);
    for (const value of [null, [], {}]) expect(validLedgerGap(value)).toBe(false);
  });
  it('qualifies identifiers with a durable node id', () => {
    expect(ledgerId('eru', '1')).not.toBe(ledgerId('bilbo', '1'));
    for (const node of ['', 'a:b', '../a']) expect(() => ledgerId(node, '1')).toThrow();
    expect(validLedgerJob({ ...job(), replayOf: 'eru:2' })).toBe(true);
    for (const replayOf of ['eru:1', 'bare', 1]) expect(validLedgerJob({ ...job(), replayOf })).toBe(false);
  });
  it('validates every work kind and rejects unrecognized fields and task data', () => {
    for (const kind of ['augur-job', 'media-job', 'llm-request', 'model-load', 'model-evict', 'install', 'download']) expect(validLedgerJob({ ...job(), kind })).toBe(true);
    for (const fields of [{ prompt: 'private input' }, { answer: 'private output' }, { key: 'private credential' }, { usage: { source: 'reported', inputTokens: 1, outputTokens: 2, text: 'private' } }, { state: 'done' }, { id: 'other:1' }, { attribution: {} }, { stamp: { secret: 'private' } }, { createdAt: NaN }, { durationMs: 1 }, { parentId: 'eru:1' }]) expect(validLedgerJob({ ...job(), ...fields })).toBe(false);
  });
  it('checks terminal times, durations, summaries, and reported accounting', () => {
    const done = { ...job(), state: 'done', endedAt: 12, durationMs: 10, summary: 'Summarize notes', summarySource: 'caller', usage: { source: 'reported', inputTokens: 12, outputTokens: 4, costUsd: 0.1 } };
    expect(validLedgerJob(done)).toBe(true);
    expect(validLedgerJob({ ...done, durationMs: 11 })).toBe(false);
    expect(validLedgerJob({ ...done, endedAt: 0 })).toBe(false);
    expect(validLedgerJob({ ...done, summary: 'line\nline' })).toBe(false);
    expect(validLedgerJob({ ...done, summarySource: 'none' })).toBe(false);
    expect(summaryLine('  a\nb\t' + 'x'.repeat(200))).toHaveLength(120);
  });
  it('round-trips a stamp through one header prefix without exposing other environment values', () => {
    const stamp = { sessionId: 's 1', sessionTitle: 'Title', origin: 'mcp' as const, originLabel: 'Tool', pid: 12, parentPid: 1, host: 'host', summary: 'Read notes' };
    const headers = stampHeaders(stamp);
    expect(Object.keys(headers).every(k => k.startsWith('X-Augur-'))).toBe(true);
    expect(stampFromHeaders(headers)).toEqual(stamp);
    expect(stampFromHeaders({ 'x-augur-session': '%' })).toBeNull();
    expect(stampFromEnv({ AUGUR_SESSION: 's', PRIVATE: 'private' }, 'cli')).toEqual({ sessionId: 's', origin: 'cli' });
    for (const fields of [{ origin: 'invalid' }, { pid: 0 }, { pid: 1.5 }, { summary: 'x'.repeat(121) }, { summary: 'two\nlines' }, { token: 'private' }]) expect(validStamp(fields)).toBe(false);
  });
  it('uses decimal uint64 cursors and a strict node-event envelope', () => {
    expect(validCursor('18446744073709551615')).toBe(true);
    for (const v of ['18446744073709551616', '-1', '01', 1, '1.1']) expect(validCursor(v)).toBe(false);
    const page = { version: 1, node: 'eru', events: [{ seq: '1', at: 2, job: job() }], next: '1', more: false };
    expect(validNodeJobPage(page)).toBe(true);
    for (const fields of [{ version: 2 }, { node: 'bilbo' }, { next: '2' }, { prompt: 'private' }, { events: [{ seq: '1', at: 1, job: job() }, { seq: '1', at: 2, job: job() }] }, { events: [], more: true }]) expect(validNodeJobPage({ ...page, ...fields })).toBe(false);
  });
  it('resolves and validates the retention policy without changing route weights', () => {
    expect(resolveBalance(undefined).ledger.retentionDays).toBe(90);
    expect(resolveBalance({ ledger: { retentionDays: 7 } }).ledger.retentionDays).toBe(7);
    for (const value of [-1, 3651, 1.5, '7']) {
      expect(resolveBalance({ ledger: { retentionDays: value } }).ledger.retentionDays).toBe(90);
      expect(checkBalanceSetting(['ledger', 'retentionDays'], value)).not.toBeNull();
    }
    expect(checkBalanceSetting(['ledger', 'retentionDays'], 0)).toBeNull();
  });
});
describe('ledger query arguments', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  it('maps every filter and scopes only the default session', () => {
    expect(ledgerQuery({}, 'host')).toEqual({ session: 'host' });
    expect(ledgerQuery({ all: true }, 'host')).toEqual({});
    expect(ledgerQuery({ session: 'explicit', all: true }, 'host')).toEqual({ session: 'explicit' });
    expect(ledgerQuery({})).toEqual({});
    expect(ledgerQuery({ session: 's', origin: 'cli', node: 'eru', kind: ['download'], state: ['running'], root: 'root', route: 'route', from: '6h', until: '90m', text: 'notes', limit: 10, page: 'cursor' }, 'host', now)).toEqual({ session: 's', origin: 'cli', node: 'eru', kind: ['download'], state: ['running', 'stalled'], localState: 'running', root: 'root', route: 'route', from: now - 21600000, to: now - 5400000, text: 'notes', limit: 10, page: 'cursor' });
  });
  it('retains execution state names and intersects running with state', () => {
    expect(ledgerQuery({ state: ['completed'] })).toEqual({ localState: 'completed' });
    expect(ledgerQuery({ state: ['completed'], running: true })).toEqual({ localState: 'completed', state: ['queued', 'running', 'stalled'] });
    expect(ledgerQuery({ state: ['failed'], running: true })).toEqual({ localState: 'failed', state: [] });
  });
  it('accepts elapsed units and ISO dates and rejects invalid ranges and values', () => {
    expect(ledgerTime('2d', now)).toBe(now - 172800000);
    expect(ledgerTime('2026-11-07', now)).toBe(Date.parse('2026-11-07'));
    for (const value of ['yesterday', '-2h', '9', 'NaN', '2026-99-99']) expect(() => ledgerTime(value, now)).toThrow();
    for (const filters of [{ origin: 'invalid' }, { kind: ['invalid'] }, { state: ['invalid'] }, { limit: 0 }, { limit: 1.5 }, { limit: 1001 }, { from: '1h', until: '2h' }]) expect(() => ledgerQuery(filters, undefined, now)).toThrow();
  });
  it('keeps relative time bounds across pages and rejects changed time filters', () => {
    const filters = { from: '6h', until: '90m' };
    const first = ledgerQuery(filters, 's', now);
    const next = ledgerPage({ jobs: [], next: 'service-cursor' }, filters, now).next!;
    expect(ledgerQuery({ ...filters, page: next }, 's', now + 99999)).toEqual({ ...first, page: 'service-cursor' });
    expect(() => ledgerQuery({ ...filters, from: '2d', page: next }, 's', now)).toThrow(/time filters changed/);
  });
});
