import type { JobRecord } from '@augur/dispatch-protocol';
import { describe, expect, it } from 'vitest';
import { duration, renderJobs, type JobsModel } from '../src/views/jobs';

const job = (over: Partial<JobRecord> = {}): JobRecord => ({
  id: '0d26110efa99', state: 'running', route: 'luna', adapter: 'codex-exec', activity: 'write_code', dataTier: 'internal', tools: 'read', output: 'text_only',
  cwd: 'C:/work', createdAt: 1_000, startedAt: 2_000, endedAt: null, exitCode: null, reason: null, rootJobId: '0d26110efa99', parentJobId: null, depth: 0,
  caller: { kind: 'cli', label: 'claude' }, named: false, harnessVersion: null, usage: null, workspace: null, patch: null, ...over,
});
const model = (over: Partial<JobsModel> = {}): JobsModel => ({ service: { running: true, pid: 4242 }, serviceNote: '', unavailable: '', jobs: [], sel: null, detail: null, busy: false, ...over });

describe('the jobs page', () => {
  it('offers Start when the service is stopped and Stop when it runs', () => {
    expect(renderJobs(model({ service: { running: false, pid: null } }))).toContain('data-action="service-start"');
    const running = renderJobs(model());
    expect(running).toContain('data-action="service-stop"');
    expect(running).toContain('process 4242');
  });

  it('says the service is unavailable instead of drawing an empty list when the command cannot run', () => {
    const html = renderJobs(model({ unavailable: 'The dispatch service is not installed with this build', service: null }));
    expect(html).toContain('not available');
    expect(html).not.toContain('data-action="service-start"');
  });

  it('lists jobs with their state and opens one by its id', () => {
    const html = renderJobs(model({ jobs: [job(), job({ id: 'aaaaaaaaaaaa', state: 'failed', route: 'sol' })] }));
    expect(html).toContain('data-job="0d26110efa99"');
    expect(html).toContain('Running');
    expect(html).toContain('Failed');
  });

  it('shows Cancel only for a job that is still going, and escapes what a job printed', () => {
    const live = renderJobs(model({ jobs: [job()], sel: job().id, detail: { job: job(), result: '', stdout: '<script>alert(1)</script>', stderr: '' } }));
    expect(live).toContain('data-action="job-cancel"');
    expect(live).not.toContain('<script>alert(1)</script>');
    const done = renderJobs(model({ jobs: [job({ state: 'completed' })], sel: job().id, detail: { job: job({ state: 'completed', exitCode: 0 }), result: 'all good', stdout: '', stderr: '' } }));
    expect(done).not.toContain('data-action="job-cancel"');
    expect(done).toContain('all good');
  });

  it('measures a running job against now and a finished one against its end', () => {
    expect(duration(job({ startedAt: 1_000, endedAt: null }), 66_000)).toBe('1m 5s');
    expect(duration(job({ startedAt: 1_000, endedAt: 4_000 }), 999_999)).toBe('3s');
    expect(duration(job({ startedAt: null }))).toBe('');
  });
});
