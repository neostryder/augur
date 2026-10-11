import { describe, expect, it } from 'vitest';
import { readFleet, withCompactFleet } from '@augur/core';
import type { Snapshot } from '@augur/core';
import { localCard, localPage } from '../src/index.js';

const model = (id: string, state: string, idle: number | null = 12, mb = 6144) => ({ id, state, memory_mb: mb, idle_secs: idle, yielded: [] });
const hosts = {
  self: { name: 'Eru', ledger: { budget_mb: 65536, used_mb: 24576, free_mb: 40960, models: [model('judge-8b', 'ready'), model('describe-vl', 'busy', null, 9626), model('embed-small', 'installed', null, 0)] },
    roles: [{ name: 'judge', chain: ['judge-8b'], refuses_degrade: false }, { name: 'describe', chain: ['describe-vl'], refuses_degrade: false },
      { name: 'summarize', chain: ['summarize-8b@Aragorn', 'apple@Bilbo'], refuses_degrade: false }, { name: 'embed', chain: ['embed-small'], refuses_degrade: false },
      { name: 'transcribe', chain: ['whisper@Aragorn'], refuses_degrade: true }] },
  peers: [{ name: 'Bilbo', up: true, error: null, checked_secs_ago: 4, models: [{ id: 'apple' }], ledger: { budget_mb: 24576, used_mb: 12288, free_mb: 12288, models: [model('apple', 'ready', 30, 0)] } },
    { name: 'Aragorn', up: false, error: 'connection refused', checked_secs_ago: 9, models: [], ledger: null }] };

function snap(): Snapshot {
  return { generatedAt: '2026-10-11T12:00:00Z', providers: { cogitator: { id: 'cogitator', name: 'Cogitator', ok: true, stale: false, error: null, plan: null, detail: '', meters: [], money: [],
    fetchedAt: '2026-10-11T11:59:56Z', links: {}, notes: { fleet: readFleet(hosts) } } } } as unknown as Snapshot;
}

describe('the dashboard card', () => {
  it('summarizes the machines and gives each role a chip with where it is served', () => {
    const c = localCard(snap())!;
    expect(c.summary).toBe('2 of 3 machines up');
    expect(c.chips.map(x => [x.text, x.tone])).toEqual([['judge Eru', 'ok'], ['describe Eru', 'ok'], ['summarize Bilbo, degraded', 'warn'], ['embed cold', 'cold'], ['transcribe down', 'down']]);
  });

  it('is null until the provider has answered, and shows the degraded roles alone on a phone', () => {
    expect(localCard(null)).toBeNull();
    expect(localCard({ ...snap(), providers: {} })).toBeNull();
    const phone = localCard(withCompactFleet(snap()))!;
    expect(phone).toMatchObject({ summary: '2 of 3 machines up', compact: true });
    expect(phone.chips.map(x => x.text)).toEqual(['summarize, degraded', 'transcribe, degraded']);
  });
});

describe('the Local page', () => {
  const page = localPage(snap(), Date.parse('2026-10-11T12:00:00Z'))!;

  it('lists each machine with its memory and a line a person can read', () => {
    expect(page.checked).toBe('just now');
    expect(page.machines.map(m => [m.name, m.tone, m.usedPct, m.line])).toEqual([
      ['Eru', 'ok', 38, '40 of 64 GB free, 2 models loaded'],
      ['Bilbo', 'ok', 50, '12 of 24 GB free, 1 model loaded'],
      ['Aragorn', 'down', null, 'down: connection refused']]);
  });

  it('puts loaded models first, names the role each serves, and says when each was last used', () => {
    const rows = page.machines[0]!.models;
    expect(rows.map(r => [r.id, r.role, r.state, r.held, r.lastUsed])).toEqual([
      ['judge-8b', 'judge', 'ready', '6 GB', '12 s ago'], ['describe-vl', 'describe', 'in use', '9.4 GB', 'now'], ['embed-small', 'embed', 'not loaded', '', '']]);
  });

  it('shows each role chain with the link that serves, and notes a degraded or stuck role', () => {
    const summarize = page.roles.find(r => r.name === 'summarize')!;
    expect(summarize.chain).toEqual([{ text: 'Aragorn', machine: 'Aragorn', serving: false, up: false }, { text: 'Bilbo', machine: 'Bilbo', serving: true, up: true }]);
    expect(summarize.note).toContain('later link');
    expect(page.roles.find(r => r.name === 'transcribe')).toMatchObject({ tone: 'down', note: 'Waiting for its machine. This role never falls back.' });
  });

  it('is null when the full reading is missing, as on a phone', () => {
    expect(localPage(withCompactFleet(snap()))).toBeNull();
  });
});
