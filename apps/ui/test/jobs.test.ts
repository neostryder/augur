import type { LedgerJob } from '@augur/dispatch-protocol';
import { LedgerModel } from '@augur/view-model';
import { describe, expect, it } from 'vitest';
import { renderJobs, type JobsModel } from '../src/views/jobs';
import { jobAlertControls } from '../src/views/settings';

const job = (over: Partial<LedgerJob> = {}): LedgerJob => ({ id: 'node:1', node: 'node', localId: '1', kind: 'llm-request', state: 'running', stamp: { sessionId: 's', sessionTitle: 'Notes', origin: 'cli', pid: 12 }, attribution: { session: 'stamped', origin: 'inferred', process: 'stamped', host: 'unknown' }, summary: 'Read notes', summarySource: 'caller', route: 'local', model: null, activity: 'research', createdAt: 1000, startedAt: 2000, endedAt: null, durationMs: null, updatedAt: 2000, lastActivityAt: 2000, parentId: null, retryOf: null, retriedAs: null, usage: null, exitReason: null, compacted: false, ...over });
const model = (jobs: LedgerJob[] | null = []): JobsModel => { const ledger = new LedgerModel('s'); ledger.jobs = jobs; return { ledger, service: { running: true, pid: 4242 }, serviceNote: '', busy: false }; };

describe('the ledger Jobs page', () => {
  it('offers service start when stopped and displays errors independently of the cached list', () => {
    const m = model([job()]); m.service = { running: false, pid: null }; m.ledger.error = 'The node is offline.';
    const html = renderJobs(m); expect(html).toContain('data-action="service-start"'); expect(html).toContain('The node is offline.'); expect(html).toContain('Read notes');
  });

  it('renders the default session scope, filters, zero counts, and node health', () => {
    const m = model([job({ state: 'stalled' })]); m.ledger.counts.stalled = 1;
    m.ledger.nodes = [{ node: 'eru', cursor: '1', lastSeenAt: 1000, unreachableSince: 2000, gap: { at: 3000, from: '0', to: '1', retentionDays: 7 } }];
    const html = renderJobs(m);
    expect(html).toContain('aria-pressed="true" data-action="jobs-scope" data-value="session"');
    for (const filter of ['state', 'kind', 'node', 'origin', 'route', 'session', 'from', 'to', 'text']) expect(html).toContain('data-ledger-filter="' + filter + '"');
    expect(html).toContain('Stalled <b>1</b>'); expect(html).toContain('Failed <b>0</b>'); expect(html).toContain('Unreachable since:'); expect(html).toContain('Last poll:');
    expect(html).toContain('History gap since ' + new Date(3000).toLocaleString());
    m.ledger.nodes[0]!.gap = null;
    expect(renderJobs(m)).not.toContain('History gap since');
  });

  it('renders loading, empty, missing detail, and paging states', () => {
    expect(renderJobs(model(null))).toContain('Loading jobs.'); expect(renderJobs(model())).toContain('No jobs match');
    const m = model([job()]); m.ledger.next = 'next'; m.ledger.page = 'page'; m.ledger.detailError = 'This job is no longer available.';
    const html = renderJobs(m); expect(html).toContain('data-action="jobs-next" >'); expect(html).toContain('data-action="jobs-first" >'); expect(html).toContain('This job is no longer available.');
  });

  it('shows metadata, live activity, attribution, usage, and chain links without reading result or log fields', () => {
    const j = Object.assign(job({ activityLine: 'Reading <files>', state: 'stalled', compacted: true, parentId: 'node:parent', usage: { inputTokens: 2, outputTokens: 3, costUsd: 0.1, source: 'reported', cachedReadTokens: 1 } }), { prompt: 'PRIVATE_PROMPT', answer: 'PRIVATE_ANSWER', stdout: 'PRIVATE_LOG' });
    const m = model([j]); m.ledger.selected = j.id; m.ledger.detail = { job: j, parent: job({ id: 'node:parent' }), children: [job({ id: 'node:child' })], retries: [job({ id: 'node:retry' })] };
    const html = renderJobs(m);
    for (const text of ['Reading &lt;files&gt;', 'Stalled', 'Compacted', 'Session attribution', 'Process attribution', 'Summary source', 'Input tokens', 'Cost (USD)', 'cachedReadTokens', 'data-job="node:child"', 'data-job="node:retry"', 'data-ledger-elapsed="node:1"']) expect(html).toContain(text);
    expect(html).not.toContain('PRIVATE_'); expect(html).not.toContain('job-cancel');
  });

  it('uses local execution ids for cancellation and removes it for terminal or remote work', () => {
    const m = model(), local = job({ id: 'augur:abc', localId: 'abc', kind: 'augur-job' });
    m.ledger.detail = { job: local, parent: null, children: [], retries: [] };
    expect(renderJobs(m)).toContain('data-action="job-cancel" data-id="abc"');
    m.ledger.detail.job = { ...local, state: 'done', endedAt: 4000, durationMs: 2000 };
    expect(renderJobs(m)).not.toContain('job-cancel');
  });

  it('renders alert switches, thresholds, and a key reference field', () => {
    const html = jobAlertControls({ stalled: true, failed: false, overUsualTime: true, usualMultiple: 3, minSamples: 8, stallMinutes: 10, webhookUrl: '', webhookFormat: 'cresset', webhookKeyName: 'ledger-alerts.token' });
    for (const key of ['stalled', 'failed', 'overUsualTime', 'usualMultiple', 'minSamples', 'webhookUrl', 'webhookFormat', 'webhookKeyName']) expect(html).toContain('data-job-alert="ledgerAlerts.' + key + '"');
    expect(html).toContain('data-job-alert="stallMinutes"'); expect(html).toContain('ledger-alerts.token'); expect(html).toContain('<option value="cresset" selected>cresset</option>');
  });
});
