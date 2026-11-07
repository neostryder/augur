import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { call, ServiceError } from '@augur/augurd';
import type { JobRecord } from '@augur/dispatch-protocol';
import { main } from '../src/cli.js';

vi.mock('@augur/augurd', async original => ({ ...await original<object>(), call: vi.fn() }));
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

const job = (over: Partial<JobRecord> = {}): JobRecord => ({
  id: 'first', state: 'running', route: 'fake', adapter: 'exec', activity: 'write_code', dataTier: 'internal', tools: 'read', output: 'text_only',
  cwd: '.', createdAt: 0, startedAt: 0, endedAt: null, exitCode: null, reason: null, rootJobId: 'first', parentJobId: null, replayOf: null,
  depth: 0, caller: { kind: 'cli' }, named: false, harnessVersion: null, usage: null, workspace: null, patch: null, ...over,
});
const completed = job({ state: 'completed', endedAt: 1500, exitCode: 0 });
const down = () => new ServiceError('unreachable', 'The service is not running (ENOENT).');
const retryMessage = 'The service is unavailable. This command will retry.\n';
const backMessage = 'The service is back.\n';
const runArgs = ['run', 'fake', '--activity', 'write_code', '--data', 'internal', '--prompt', 'hello', '--wait'];

function capture() {
  let out = '', err = '';
  return {
    io: { out: (text: string) => { out += text; }, err: (text: string) => { err += text; }, stdin: () => '', env: {}, cwd: '.' },
    out: () => out, err: () => err,
  };
}

it.each([
  down(),
  new ServiceError('unreachable', 'The service is not running (ECONNREFUSED).'),
  new ServiceError('closed', 'The service closed the connection.'),
  new ServiceError('timeout', 'The service did not answer in time.'),
  ...['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_SOCKET_CLOSED'].map(code => Object.assign(new Error(code), { code })),
])('waits through a connection failure: %s', async error => {
  vi.mocked(call).mockRejectedValueOnce(error).mockResolvedValueOnce(job()).mockResolvedValueOnce(completed);
  const c = capture(), result = main(['wait', 'first'], c.io);
  await vi.advanceTimersByTimeAsync(1000);
  expect(c.out()).toBe('');
  expect(c.err()).toBe(retryMessage + backMessage);
  await vi.advanceTimersByTimeAsync(500);
  expect(await result).toBe(0);
  expect(c.out()).toContain('completed');
  expect(call).toHaveBeenCalledTimes(3);
});

it('reconnects when the service stops during a wait', async () => {
  vi.mocked(call).mockResolvedValueOnce(job()).mockRejectedValueOnce(down()).mockResolvedValueOnce(completed);
  const c = capture(), result = main(['wait', 'first'], c.io);
  await vi.advanceTimersByTimeAsync(500);
  expect(c.out()).toBe('');
  expect(c.err()).toBe(retryMessage);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toBe(0);
  expect(c.err()).toBe(retryMessage + backMessage);
});

it('caps the backoff at five seconds and times out without reporting completion', async () => {
  const attempts: number[] = [];
  vi.mocked(call).mockImplementation(async () => { attempts.push(Date.now()); throw down(); });
  const c = capture(), result = main(['wait', 'first', '--timeout', '18', '--json'], c.io);
  await vi.advanceTimersByTimeAsync(18000);
  expect(await result).toBe(124);
  expect(attempts).toEqual([0, 1000, 3000, 7000, 12000, 17000]);
  expect(c.out()).toBe('');
  expect(c.err()).toBe(retryMessage + 'The service stayed down until the wait timed out after 18s.\n');
  expect(vi.getTimerCount()).toBe(0);
});

it('caps requests and retry sleeps at the remaining timeout', async () => {
  vi.mocked(call).mockRejectedValue(down());
  const c = capture(), result = main(['wait', 'first', '--timeout', '0.025'], c.io);
  await vi.advanceTimersByTimeAsync(25);
  expect(await result).toBe(124);
  expect(call).toHaveBeenCalledExactlyOnceWith('status', { id: 'first' }, expect.objectContaining({ timeoutMs: 25 }));
});

it('counts a request that closes without an answer toward the timeout', async () => {
  vi.mocked(call).mockImplementation((_method, _params, opts) => new Promise((_resolve, reject) => {
    setTimeout(() => reject(new ServiceError('timeout', 'The service did not answer in time.')), opts!.timeoutMs);
  }));
  const c = capture(), result = main(['wait', 'first', '--timeout', '0.025'], c.io);
  await vi.advanceTimersByTimeAsync(25);
  expect(await result).toBe(124);
  expect(c.err()).toContain('The service stayed down');
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ['failed', 4], ['artifact_validation_failed', 5], ['cancelled', 6], ['lost', 7], ['needs_approval', 3],
] as const)('preserves the exit code for %s after reconnecting', async (state, code) => {
  vi.mocked(call).mockRejectedValueOnce(down()).mockResolvedValueOnce(job({ state, exitCode: state === 'failed' ? 23 : null }));
  const c = capture(), result = main(['wait', 'first', '--json'], c.io);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toBe(code);
  expect(JSON.parse(c.out()).state).toBe(state);
});

it('keeps JSON output unchanged when the service returns', async () => {
  vi.mocked(call).mockRejectedValueOnce(down()).mockResolvedValueOnce(completed);
  const c = capture(), result = main(['wait', 'first', '--json'], c.io);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toBe(0);
  expect(c.out()).toBe(JSON.stringify(completed) + '\n');
  expect(c.err()).toBe(retryMessage + backMessage);
});

it('follows retriedAs when its lookup is interrupted without changing the JSON chain', async () => {
  const next = job({ id: 'second', route: 'other', state: 'completed', exitCode: 0 });
  vi.mocked(call).mockResolvedValueOnce(job({ state: 'failed', retriedAs: 'second' }))
    .mockRejectedValueOnce(down()).mockResolvedValueOnce(next).mockResolvedValueOnce(next);
  const c = capture(), result = main(['wait', 'first', '--json'], c.io);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toBe(0);
  expect(c.out()).toBe(JSON.stringify({ ...next, chain: ['first', 'second'] }) + '\n');
  expect(vi.mocked(call).mock.calls.map(c => c[1])).toEqual([{ id: 'first' }, { id: 'second' }, { id: 'second' }, { id: 'second' }]);
});

it('times out during a successor lookup instead of returning the earlier job code', async () => {
  vi.mocked(call).mockResolvedValueOnce(job({ state: 'failed', retriedAs: 'second' })).mockRejectedValue(down());
  const c = capture(), result = main(['wait', 'first', '--timeout', '0.025'], c.io);
  await vi.advanceTimersByTimeAsync(25);
  expect(await result).toBe(124);
  expect(c.out()).toBe('');
  expect(c.err()).toContain('The service stayed down');
});

it('keeps the existing timeout message when the job is still running', async () => {
  vi.mocked(call).mockResolvedValue(job());
  const c = capture(), result = main(['wait', 'first', '--timeout', '0.025'], c.io);
  await vi.advanceTimersByTimeAsync(25);
  expect(await result).toBe(124);
  expect(c.err()).toBe('Still running after 0.025s.\n');
  expect(c.out()).toBe('');
});

it('starts a new outage at the initial backoff after a successful read', async () => {
  vi.mocked(call).mockRejectedValueOnce(down()).mockResolvedValueOnce(job()).mockRejectedValueOnce(down()).mockResolvedValueOnce(completed);
  const c = capture(), result = main(['wait', 'first'], c.io);
  await vi.advanceTimersByTimeAsync(2500);
  expect(await result).toBe(0);
  expect(c.err()).toBe((retryMessage + backMessage).repeat(2));
});

it('keeps run --wait result JSON unchanged after reconnecting', async () => {
  const reply = { job: completed, answer: 'done' };
  vi.mocked(call).mockResolvedValueOnce({ id: 'first', warnings: [] } as never)
    .mockRejectedValueOnce(down()).mockResolvedValueOnce(completed).mockResolvedValueOnce(reply);
  const c = capture(), result = main([...runArgs, '--json'], c.io);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toBe(0);
  expect(c.out()).toBe(JSON.stringify(reply) + '\n');
  expect(c.err()).toBe(retryMessage + backMessage);
});

it('returns the run --wait timeout without fetching a result from the stopped service', async () => {
  vi.mocked(call).mockResolvedValueOnce({ id: 'first', warnings: [] } as never).mockRejectedValue(down());
  const c = capture(), result = main([...runArgs, '--timeout', '1', '--json'], c.io);
  await vi.advanceTimersByTimeAsync(61000);
  expect(await result).toBe(124);
  expect(c.out()).toBe('');
  expect(c.err()).toBe(retryMessage + 'The service stayed down until the wait timed out after 61s.\n');
  expect(vi.mocked(call).mock.calls.some(c => c[0] === 'result')).toBe(false);
});

it('resumes logs --follow from the last offset after reconnecting', async () => {
  vi.mocked(call).mockResolvedValueOnce({ text: 'first\n', next: 6, done: false })
    .mockRejectedValueOnce(down()).mockResolvedValueOnce({ text: 'last\n', next: 11, done: true });
  const c = capture(), result = main(['logs', 'first', '--stderr', '--follow'], c.io);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toBe(0);
  expect(c.out()).toBe('first\nlast\n');
  expect(c.err()).toBe(retryMessage + backMessage);
  expect(vi.mocked(call).mock.calls.map(c => c[1])).toEqual([
    { id: 'first', stream: 'stderr', offset: 0, limit: 262144 },
    { id: 'first', stream: 'stderr', offset: 6, limit: 262144 },
    { id: 'first', stream: 'stderr', offset: 6, limit: 262144 },
  ]);
});

it('keeps logs without --follow from retrying', async () => {
  vi.mocked(call).mockRejectedValue(down());
  const c = capture();
  expect(await main(['logs', 'first'], c.io)).toBe(4);
  expect(call).toHaveBeenCalledTimes(1);
  expect(c.err()).toBe('The service is not running (ENOENT).\n');
});

it.each(['forbidden', 'bad_request', 'no_token'])('does not retry a %s error', async code => {
  vi.mocked(call).mockRejectedValue(new ServiceError(code, 'The request was refused.'));
  const c = capture();
  expect(await main(['wait', 'first'], c.io)).toBe(4);
  expect(call).toHaveBeenCalledTimes(1);
  expect(c.err()).toBe('The request was refused.\n');
  expect(vi.getTimerCount()).toBe(0);
});

it('reports a missing job after recovery without treating it as completion', async () => {
  vi.mocked(call).mockRejectedValueOnce(down()).mockResolvedValueOnce(null);
  const c = capture(), result = main(['wait', 'first'], c.io);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toBe(1);
  expect(c.out()).toBe('');
  expect(c.err()).toBe(retryMessage + backMessage + 'No such job.\n');
});
