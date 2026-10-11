import { describe, expect, it } from 'vitest';
import { readFleet, withCompactFleet } from '@augur/core';
import type { Snapshot } from '@augur/core';
import { localCard, localPage } from '@augur/view-model';
import { localCardBody, renderLocal } from '../src/views/local';

const model = (id: string, state: string, idle: number | null = 12, mb = 6144) => ({ id, state, memory_mb: mb, idle_secs: idle, yielded: [] });
const fleet = readFleet({
  self: { name: 'Eru', ledger: { budget_mb: 65536, used_mb: 24576, free_mb: 40960, models: [model('judge-8b', 'ready'), model('embed-small', 'installed', null, 0)] },
    roles: [{ name: 'judge', chain: ['judge-8b'], refuses_degrade: false }, { name: 'embed', chain: ['embed-small'], refuses_degrade: false }, { name: 'transcribe', chain: ['whisper@Aragorn'], refuses_degrade: true }] },
  peers: [{ name: 'Aragorn', up: false, error: 'connection <refused>', checked_secs_ago: 9, models: [], ledger: null }] });
const snap = { generatedAt: '2026-10-11T12:00:00Z', providers: { cogitator: { id: 'cogitator', name: 'Cogitator', ok: true, stale: false, error: null, plan: null, detail: '', meters: [], money: [],
  fetchedAt: '2026-10-11T11:59:56Z', links: {}, notes: { fleet } } } } as unknown as Snapshot;
const now = Date.parse('2026-10-11T12:00:00Z');

describe('the local card on the dashboard', () => {
  it('shows the summary, a chip per role, and an Open button', () => {
    const html = localCardBody(localCard(snap)!);
    expect(html).toContain('1 of 2 machines up');
    expect(html).toContain('judge Eru');
    expect(html).toContain('embed cold');
    expect(html).toContain('transcribe down');
    expect(html).toContain('data-action="local"');
  });

  it('has no Open button on a phone, which gets the summary alone', () => {
    const html = localCardBody(localCard(withCompactFleet(snap))!);
    expect(html).toContain('machines up');
    expect(html).not.toContain('data-action="local"');
    expect(html).toContain('This device shows a summary.');
  });
});

describe('the Local page', () => {
  const page = localPage(snap, now);

  it('asks for the provider when there is no reading, and says when it is only waiting', () => {
    expect(renderLocal({ page: null, waiting: false, sel: null, canJobs: false, jobs: null })).toContain('Add the Cogitator provider in settings');
    expect(renderLocal({ page: null, waiting: true, sel: null, canJobs: false, jobs: null })).toContain('Reading the fleet.');
  });

  it('opens the first machine, lists its models, and lets another be picked', () => {
    const html = renderLocal({ page, waiting: false, sel: null, canJobs: false, jobs: null });
    expect(html).toContain('Loaded models, Eru');
    expect(html).toContain('judge-8b');
    expect(html).toContain('data-action="local-machine" data-value="Aragorn"');
    const down = renderLocal({ page, waiting: false, sel: 'Aragorn', canJobs: false, jobs: null });
    expect(down).toContain('Loaded models, Aragorn');
    expect(down).toContain('down: connection &lt;refused&gt;');
  });

  it('shows the role chains and what each role waits on', () => {
    const html = renderLocal({ page, waiting: false, sel: null, canJobs: false, jobs: null });
    expect(html).toContain('Roles and their chains');
    expect(html).toContain('This role never falls back.');
  });

  it('shows recent local jobs only where the dispatch service is, and says when there are none', () => {
    expect(renderLocal({ page, waiting: false, sel: null, canJobs: false, jobs: null })).not.toContain('Recent local jobs');
    expect(renderLocal({ page, waiting: false, sel: null, canJobs: true, jobs: null })).toContain('Loading jobs.');
    expect(renderLocal({ page, waiting: false, sel: null, canJobs: true, jobs: [] })).toContain('No local jobs yet.');
  });

  it('warns when the last reading is old because the gateway could not be reached', () => {
    const stale = localPage({ ...snap, providers: { cogitator: { ...snap.providers.cogitator!, stale: true } } } as Snapshot, now);
    expect(renderLocal({ page: stale, waiting: false, sel: null, canJobs: false, jobs: null })).toContain('Cogitator is not reachable.');
  });
});
