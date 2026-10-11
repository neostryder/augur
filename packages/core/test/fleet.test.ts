import { describe, it, expect } from 'vitest';
import { baseOf, DEFAULT_BASE } from '../src/providers/cogitator.js';
import { cogitator, readFleet, compactFleet, fleetOf, withCompactFleet, collect, defaultConfig } from '../src/index.js';
import type { Host, HttpRequest, HttpResponse, Snapshot } from '../src/index.js';

/** What a gateway on Eru answers at /api/v1/hosts: Eru up with three models, Bilbo up with one, Aragorn down. */
const hosts = {
  self: {
    name: 'eru',
    ledger: { budget_mb: 16000, used_mb: 9000, free_mb: 7000, models: [
      { id: 'laya-judge', state: 'ready', memory_mb: 6100, idle_secs: 12, yielded: [] },
      { id: 'describe-vl', state: 'busy', memory_mb: 9400, idle_secs: null, yielded: [] },
      { id: 'summarize-8b', state: 'installed', memory_mb: 6000, idle_secs: null, yielded: ['memory'] } ] },
    vram: {},
    roles: [
      { name: 'judge', chain: ['laya-judge', 'apple@bilbo'], refuses_degrade: false },
      { name: 'summarize', chain: ['summarize-8b', 'apple@bilbo'], refuses_degrade: false },
      { name: 'embed', chain: ['embed-small@aragorn'], refuses_degrade: true } ] },
  peers: [
    { name: 'bilbo', url: 'http://bilbo:8470', up: true, error: null, checked_secs_ago: 4, models: [{ id: 'apple' }],
      ledger: { budget_mb: 24000, used_mb: 12000, free_mb: 12000, models: [{ id: 'apple', state: 'ready', memory_mb: 0, idle_secs: 30, yielded: [] }] } },
    { name: 'aragorn', url: 'http://aragorn:8470', up: false, error: 'connection refused', checked_secs_ago: 9, models: [], ledger: null } ] };

function host(reply: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>, secrets: Record<string, string> = { 'cogitator.manageKey': 'k-manage' }): Host & { seen: HttpRequest[] } {
  const seen: HttpRequest[] = [];
  return { platform: 'linux', seen, http: async (req) => { seen.push(req); return reply(req); }, secret: async (name) => secrets[name] ?? null, now: () => new Date('2026-10-11T12:00:00Z') };
}
const ok = (body: unknown): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify(body) });

describe('the Cogitator fleet reading', () => {
  it('reads machines, memory and each model', () => {
    const f = readFleet(hosts);
    expect(f.self).toBe('eru');
    expect(f.machines.map(m => [m.name, m.self, m.up])).toEqual([['eru', true, true], ['bilbo', false, true], ['aragorn', false, false]]);
    const eru = f.machines[0]!;
    expect([eru.budgetMb, eru.usedMb, eru.freeMb, eru.pressure]).toEqual([16000, 9000, 7000, false]);
    expect(eru.models.map(m => [m.id, m.state, m.idleSecs])).toEqual([['laya-judge', 'ready', 12], ['describe-vl', 'busy', null], ['summarize-8b', 'installed', null]]);
    expect(eru.models[2]!.yielded).toEqual(['memory']);
    expect(f.machines[2]!.error).toBe('connection refused');
  });

  it('marks a machine short of memory as under pressure', () => {
    const f = readFleet({ self: { name: 'gamemaster', ledger: { budget_mb: 32000, used_mb: 28000, free_mb: 1500, models: [] }, roles: [] }, peers: [] });
    expect(f.machines[0]!.pressure).toBe(true);
  });

  it('finds where each role is served and flags the degraded ones', () => {
    const roles = Object.fromEntries(readFleet(hosts).roles.map(r => [r.name, r]));
    expect(roles.judge).toMatchObject({ servingIndex: 0, servingMachine: 'eru', servingModel: 'laya-judge', degraded: false });
    // A model that is installed but not loaded can still serve; its own machine is up.
    expect(roles.summarize).toMatchObject({ servingIndex: 0, degraded: false });
    expect(roles.embed).toMatchObject({ servingIndex: null, servingMachine: null, degraded: false, refusesDegrade: true });
  });

  it('serves from the second link when the first machine is down', () => {
    const down = structuredClone(hosts);
    down.peers[0]!.up = false; down.self.roles = [{ name: 'judge', chain: ['apple@bilbo', 'laya-judge'], refuses_degrade: false }];
    expect(readFleet(down).roles[0]).toMatchObject({ servingIndex: 1, servingMachine: 'eru', servingModel: 'laya-judge', degraded: true });
  });

  it('reads a missing or odd answer as an empty fleet instead of failing', () => {
    expect(readFleet(null)).toEqual({ self: 'this machine', machines: [{ name: 'this machine', self: true, up: true, error: null, checkedSecsAgo: 0, budgetMb: null, usedMb: null, freeMb: null, pressure: false, models: [] }], roles: [] });
    expect(readFleet({ self: { name: 'eru' }, peers: [{ up: true }, 5] }).machines.map(m => m.name)).toEqual(['eru']);
  });

  it('cuts to names, up or down, and the roles that are not on their first link', () => {
    const down = structuredClone(hosts);
    down.self.roles = [{ name: 'judge', chain: ['laya-judge@aragorn', 'laya-judge'], refuses_degrade: false }, ...hosts.self.roles.slice(2)];
    expect(compactFleet(readFleet(down))).toEqual({ machines: [{ name: 'eru', up: true }, { name: 'bilbo', up: true }, { name: 'aragorn', up: false }], degraded: ['judge', 'embed'] });
  });
});

describe('the Cogitator provider', () => {
  it('sends the manage key to the hosts endpoint and reports the fleet', async () => {
    const h = host(() => ok(hosts));
    const r = await cogitator.fetch(h, {});
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]!.url).toBe(`${DEFAULT_BASE}/api/v1/hosts`);
    expect(h.seen[0]!.headers).toEqual({ Authorization: 'Bearer k-manage' });
    expect(r.detail).toBe('2 of 3 machines up');
    expect(r.meters).toEqual([]);
    expect((r.notes!.fleet as { machines: unknown[] }).machines).toHaveLength(3);
  });

  it('counts degraded roles in the detail', async () => {
    const down = structuredClone(hosts);
    down.self.roles = [{ name: 'summarize', chain: ['summarize-8b@aragorn', 'apple@bilbo'], refuses_degrade: false }];
    expect((await cogitator.fetch(host(() => ok(down)), {})).detail).toBe('2 of 3 machines up, 1 role degraded');
  });

  it('asks for a key when there is none', async () => {
    await expect(cogitator.fetch(host(() => ok(hosts), {}), {})).rejects.toThrow('No manage key yet');
  });

  it('names a key without the manage scope', async () => {
    await expect(cogitator.fetch(host(() => ({ status: 403, headers: {}, body: '{}' })), {})).rejects.toThrow('manage scope');
  });

  it('says Cogitator is not reachable when the gateway is off', async () => {
    await expect(cogitator.fetch(host(() => { throw new Error('ECONNREFUSED'); }), {})).rejects.toThrow('Could not reach Cogitator');
  });

  it('keeps the last reading, marked stale, while the gateway is down', async () => {
    const config = { ...defaultConfig(), providers: [{ id: 'cogitator', enabled: true, settings: {} }] };
    let up = true;
    const h = host(() => { if (!up) throw new Error('ECONNREFUSED'); return ok(hosts); });
    const first = await collect(h, config);
    up = false;
    const second = await collect(h, config, first, undefined, { force: true });
    expect(second.providers.cogitator).toMatchObject({ ok: false, stale: true, error: 'Could not reach Cogitator.' });
    expect(fleetOf(second)).toMatchObject({ stale: true });
    expect(fleetOf(second)!.fleet.machines).toHaveLength(3);
  });

  it('only sends the key over http to the home network', () => {
    expect(baseOf({})).toBe(DEFAULT_BASE);
    expect(baseOf({ baseUrl: 'http://eru:8470/' })).toBe('http://eru:8470');
    expect(baseOf({ baseUrl: 'http://192.168.1.20:8470' })).toBe('http://192.168.1.20:8470');
    expect(baseOf({ baseUrl: 'https://cogitator.example.com' })).toBe('https://cogitator.example.com');
    expect(() => baseOf({ baseUrl: 'http://cogitator.example.com' })).toThrow('home network');
    expect(() => baseOf({ baseUrl: 'eru:8470' })).toThrow('Invalid base URL');
  });
});

describe('the fleet on the phone', () => {
  it('replaces the full reading with the compact form and leaves other providers alone', async () => {
    const config = { ...defaultConfig(), providers: [{ id: 'cogitator', enabled: true, settings: {} }] };
    const snap: Snapshot = await collect(host(() => ok(hosts)), config);
    const phone = withCompactFleet(snap);
    const notes = phone.providers.cogitator!.notes as Record<string, unknown>;
    expect(notes.fleet).toBeUndefined();
    expect(notes.fleetCompact).toEqual({ machines: [{ name: 'eru', up: true }, { name: 'bilbo', up: true }, { name: 'aragorn', up: false }], degraded: ['embed'] });
    expect(JSON.stringify(phone)).not.toContain('laya-judge');
    expect(JSON.stringify(phone)).not.toContain('memory_mb');
    expect(withCompactFleet({ ...snap, providers: {} })).toEqual({ ...snap, providers: {} });
  });
});
