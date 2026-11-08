import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CANCEL_FILE, CancelRequests, parseCancelRequests } from '../src/cancel-requests.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const NOW = Date.parse('2026-11-08T21:00:00Z');
const line = (id: string, at = new Date(NOW).toISOString()) => JSON.stringify({ id, at, by: 'claude' }) + '\n';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'augur-cancel-')); dirs.push(home);
  let now = NOW;
  const cancel = vi.fn((id: string) => (id === 'gone' ? null : { ok: id !== 'done', state: 'cancel_requested' as const }));
  const log = vi.fn();
  const requests = new CancelRequests(home, { cancel }, log, () => now);
  const file = join(home, CANCEL_FILE);
  return { home, file, cancel, log, requests, advance: (ms: number) => { now += ms; } };
}

describe('parseCancelRequests', () => {
  it('keeps fresh well-formed ids once and skips everything else', () => {
    const text = line('a') + line('a') + line('b') + 'not json\n' + line('old', new Date(NOW - 11 * 60_000).toISOString()) + line('../x') + JSON.stringify({ id: 'c' }) + '\n' + JSON.stringify({ id: 7, at: new Date(NOW).toISOString() }) + '\n';
    expect(parseCancelRequests(text, NOW)).toEqual(['a', 'b']);
  });

  it('stops at 50 ids', () => {
    const text = Array.from({ length: 80 }, (_, i) => line(`j${i}`)).join('');
    expect(parseCancelRequests(text, NOW)).toHaveLength(50);
  });
});

describe('the cancel requests file', () => {
  it('cancels each named job and empties the file', () => {
    const f = fixture();
    writeFileSync(f.file, line('a') + line('b'));
    f.requests.tick();
    expect(f.cancel.mock.calls.map(c => c[0])).toEqual(['a', 'b']);
    expect(readFileSync(f.file, 'utf8')).toBe('');
    expect(f.log).toHaveBeenCalledTimes(2);
  });

  it('does nothing without a file and checks at most once a second', () => {
    const f = fixture();
    f.requests.tick();
    writeFileSync(f.file, line('a'));
    f.advance(500); f.requests.tick();
    expect(f.cancel).not.toHaveBeenCalled();
    f.advance(600); f.requests.tick();
    expect(f.cancel).toHaveBeenCalledTimes(1);
  });

  it('leaves a job that is already over or unknown alone and still empties the file', () => {
    const f = fixture();
    writeFileSync(f.file, line('done') + line('gone'));
    f.requests.tick();
    expect(f.cancel).toHaveBeenCalledTimes(2);
    expect(f.log).not.toHaveBeenCalled();
    expect(readFileSync(f.file, 'utf8')).toBe('');
  });

  it('ignores a request left behind by an earlier session', () => {
    const f = fixture();
    writeFileSync(f.file, line('a', new Date(NOW - 3_600_000).toISOString()));
    f.requests.tick();
    expect(f.cancel).not.toHaveBeenCalled();
  });

  it('keeps going when the supervisor throws', () => {
    const f = fixture();
    f.cancel.mockImplementationOnce(() => { throw new Error('boom'); });
    writeFileSync(f.file, line('a') + line('b'));
    f.requests.tick();
    expect(f.cancel).toHaveBeenCalledTimes(2);
    expect(f.log).toHaveBeenCalledTimes(2);
  });

  it('applies a line added after the first check on the next one', () => {
    const f = fixture();
    writeFileSync(f.file, line('a')); f.requests.tick();
    appendFileSync(f.file, line('b')); f.advance(1100); f.requests.tick();
    expect(f.cancel.mock.calls.map(c => c[0])).toEqual(['a', 'b']);
  });
});
