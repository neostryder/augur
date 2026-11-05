import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { JobRecord } from '@augur/dispatch-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JOBS_LIVE_TEXT, JobsLiveWriter } from '../src/jobs-live.js';

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, renameSync: vi.fn(fs.renameSync), writeFileSync: vi.fn(fs.writeFileSync) };
});

const dirs: string[] = [];
afterEach(() => { vi.clearAllMocks(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'augur-jobs-live-')); dirs.push(home);
  let now = 100000, jobs: JobRecord[] = [];
  const list = vi.fn(() => jobs), log = vi.fn();
  const writer = new JobsLiveWriter(home, { list }, () => 10, log, () => now);
  return { home, writer, list, log, set: (rows: JobRecord[]) => { jobs = rows; }, advance: (ms = 5000) => { now += ms; },
    read: () => JSON.parse(readFileSync(join(home, 'jobs-live.json'), 'utf8')) };
}

const job = (id: string, createdAt = 1) => ({ id, createdAt, route: 'local', activity: 'write_code', state: 'running', startedAt: createdAt,
  lastActivityAt: createdAt, activityLine: 'Running checks', stalled: false, prompt: 'private input', answer: 'private output', cwd: '/private' }) as unknown as JobRecord;

describe('the live jobs snapshot', () => {
  it('writes only changed jobs and clears the last live job once', () => {
    const f = fixture();
    f.set([job('a')]); f.writer.tick();
    expect(f.list).toHaveBeenCalledWith({ running: true, limit: 50 });
    expect(f.read()).toMatchObject({ updatedAt: 100000, stallMinutes: 10, jobs: [{ id: 'a' }] });
    f.advance(); f.writer.tick();
    expect(renameSync).toHaveBeenCalledTimes(1);
    f.set([]); f.writer.tick();
    expect(f.read().jobs).toHaveLength(1);
    f.advance(); f.writer.tick();
    expect(f.read().jobs).toEqual([]);
    f.advance(); f.writer.tick();
    expect(renameSync).toHaveBeenCalledTimes(2);
  });

  it('refreshes an unchanged live list every 30 seconds so the mod does not treat it as stale', () => {
    const f = fixture(); f.set([job('a')]); f.writer.tick();
    f.advance(25000); f.writer.tick();
    expect(renameSync).toHaveBeenCalledTimes(1);
    f.advance(5000); f.writer.tick();
    expect(renameSync).toHaveBeenCalledTimes(2);
    expect(f.read().updatedAt).toBe(130000);
    f.set([]); f.advance(); f.writer.tick();
    f.advance(60000); f.writer.tick();
    expect(renameSync).toHaveBeenCalledTimes(3);
  });

  it('caps the newest jobs at 50 and exports only allowed fields', () => {
    const f = fixture();
    f.set(Array.from({ length: 60 }, (_, i) => job(String(i), i))); f.writer.tick();
    const feed = f.read();
    expect(Object.keys(feed).sort()).toEqual(['jobs', 'stallMinutes', 'updatedAt']);
    expect(feed.jobs).toHaveLength(50);
    expect(feed.jobs.map((row: { id: string }) => row.id)).toEqual(Array.from({ length: 50 }, (_, i) => String(59 - i)));
    expect(Object.keys(feed.jobs[0]).sort()).toEqual(['activity', 'activityLine', 'id', 'lastActivityAt', 'route', 'stalled', 'startedAt', 'state']);
    expect(JSON.stringify(feed)).not.toContain('private');
  });

  it('writes a temporary sibling before renaming it over the snapshot', () => {
    const f = fixture(); f.writer.tick();
    const [source, target] = vi.mocked(renameSync).mock.calls[0]!;
    expect(dirname(String(source))).toBe(f.home);
    expect(target).toBe(join(f.home, 'jobs-live.json'));
    expect(source).not.toBe(target);
    expect(writeFileSync).toHaveBeenCalledWith(source, expect.any(String), undefined);
    expect(vi.mocked(writeFileSync).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(renameSync).mock.invocationCallOrder[0]!);
    expect(f.read().jobs).toEqual([]);
  });

  it('records activity changes and keeps the five second write limit', () => {
    const f = fixture(); f.set([job('a')]); f.writer.tick();
    f.set([{ ...job('a'), stalled: true, lastActivityAt: 2, activityLine: 'Waiting' }]);
    f.advance(4999); f.writer.tick();
    expect(renameSync).toHaveBeenCalledTimes(1);
    f.advance(1); f.writer.tick();
    expect(f.read().jobs[0]).toMatchObject({ stalled: true, lastActivityAt: 2, activityLine: 'Waiting' });
    expect(renameSync).toHaveBeenCalledTimes(2);
  });

  it('logs a failed write without throwing and retries on the next check', () => {
    const f = fixture();
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('write failed'); });
    expect(() => f.writer.tick()).not.toThrow();
    expect(f.log).toHaveBeenCalledWith(JOBS_LIVE_TEXT.writeFailed);
    f.advance(); f.writer.tick();
    expect(f.read().jobs).toEqual([]);
  });
});
