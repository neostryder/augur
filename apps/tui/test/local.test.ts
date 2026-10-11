import { describe, expect, it } from 'vitest';
import { readFleet } from '@augur/core';
import type { Snapshot } from '@augur/core';
import { LocalComputePage } from '../src/screens/local.js';
import { pages } from '../src/index.js';
import { k, setup, state } from './fixtures.js';

const model = (id: string, st: string, idle: number | null = 12, mb = 6144) => ({ id, state: st, memory_mb: mb, idle_secs: idle, yielded: [] });
const fleet = readFleet({
  self: { name: 'Eru', ledger: { budget_mb: 65536, used_mb: 24576, free_mb: 40960, models: [model('judge-8b', 'ready'), model('embed-small', 'installed', null, 0)] },
    roles: [{ name: 'judge', chain: ['judge-8b'], refuses_degrade: false }, { name: 'summarize', chain: ['summarize-8b@Aragorn', 'apple@Bilbo'], refuses_degrade: false }, { name: 'transcribe', chain: ['whisper@Aragorn'], refuses_degrade: true }] },
  peers: [{ name: 'Bilbo', up: true, error: null, checked_secs_ago: 4, models: [{ id: 'apple' }], ledger: { budget_mb: 24576, used_mb: 12288, free_mb: 12288, models: [model('apple', 'ready', 30, 0)] } },
    { name: 'Aragorn', up: false, error: 'connection refused', checked_secs_ago: 9, models: [], ledger: null }] });

function open(withFleet: boolean, enabled = true) {
  const s = state();
  if (enabled) s.config.providers.push({ id: 'cogitator', enabled: true, settings: {} });
  if (withFleet) (s.snapshot as Snapshot).providers.cogitator = { id: 'cogitator', name: 'Cogitator', ok: true, stale: false, fetchedAt: '2026-10-04T11:59:56Z', error: null, plan: null, meters: [], money: [], links: {}, notes: { fleet } } as never;
  const list = pages();
  const at = list.findIndex((p) => p.name === 'Local');
  const t = setup(s, { pages: list });
  t.app.active = at;
  return t;
}

describe('local compute page', () => {
  it('is a tab of its own, after Balance', () => {
    expect(pages().map((p) => p.name).slice(4, 6)).toEqual(['Balance', 'Local']);
    expect(pages()[5]).toBeInstanceOf(LocalComputePage);
  });

  it('shows the machines, their models, and each role chain', () => {
    const text = open(true).draw(110, 60);
    expect(text).toContain('2 of 3 machines up');
    expect(text).toContain('Eru (this gateway)');
    expect(text).toContain('judge-8b');
    expect(text).toContain('[Bilbo]');
    expect(text).toContain('Aragorn (down)');
    expect(text).toContain('This role never falls back.');
  });

  it('says to add the provider when it is off, and that it is waiting when it is on', () => {
    expect(open(false, false).draw(110, 30)).toContain('Add the Cogitator provider in settings');
    expect(open(false, true).draw(110, 30)).toContain('Reading the fleet.');
  });

  it('scrolls with the arrow keys', async () => {
    expect(await open(true).app.key(k('down'))).toBe(true);
  });
});
