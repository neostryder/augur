import { afterEach, describe, expect, it, vi } from 'vitest';
import { callEngine, defaultConfig, detectResets, emptyPolicy, fieldPath, migrateConfig, newProvider, setField, UsageEngine } from '../src/index.js';
import type { AppConfig, EngineKey, EngineShell, ProposedRule, ResetEvent, Snapshot } from '../src/index.js';

function fakeShell(saved: AppConfig | null) {
  const files = new Map<string, string>(), secrets = new Map<string, string>(), exported = new Map<string, string>();
  let config = saved ? structuredClone(saved) : null, snapshot: Snapshot | null = null;
  const shell: EngineShell = {
    host: {
      platform: 'linux',
      http: async () => ({ status: 404, headers: {}, body: '' }),
      secret: async (n: string) => secrets.get(n) ?? null,
      readHomeFile: async (p: string) => files.get(p) ?? exported.get(p) ?? null,
      writeHomeFileAtomic: async (p: string, t: string) => { files.set(p, t); },
    } as EngineShell['host'],
    loadConfig: async () => (config ? structuredClone(config) : null),
    saveConfig: async (c) => { config = structuredClone(c); },
    setSecret: async (n, v) => { secrets.set(n, v); },
    deleteSecret: async (n) => { secrets.delete(n); },
    hasSecret: async (n) => secrets.has(n),
    loadSnapshot: async () => snapshot,
    saveSnapshot: async (s) => { snapshot = s; },
    loadHistory: async () => [],
    saveHistory: async () => undefined,
    loadResets: async () => [], appendResets: async () => undefined,
    loadAlertState: async () => ({}),
    saveAlertState: async () => undefined,
    loadAlertFeed: async () => null,
    saveAlertFeed: async () => undefined,
    exportSnapshot: async (p, json) => { exported.set(p, json); },
    notify: async () => undefined,
  };
  return { shell, secrets, exported, saved: () => config };
}

const base = (): AppConfig => {
  const c = migrateConfig(defaultConfig());
  for (const p of c.providers) p.enabled = false;
  return c;
};

let engine: UsageEngine | null = null;
afterEach(() => { engine?.stop(); engine = null; vi.useRealTimers(); });

describe('the usage engine', () => {
  it('keeps Cogitator discoveries as offers even if an older configuration requests automatic imports', async () => {
    const config = base();
    config.providers.find(provider => provider.id === 'cogitator')!.enabled = true;
    config.policy = emptyPolicy();
    config.policy.providers.cogitator = { ...newProvider(), listMode: 'auto' };
    const f = fakeShell(config);
    f.secrets.set('cogitator.manageKey', 'test-manage');
    f.shell.host.http = async () => ({ status: 200, headers: {}, body: JSON.stringify({ self: { name: 'eru', ledger: { models: [{ id: 'laya' }] } } }) });
    engine = new UsageEngine(f.shell, { hosted: 'https://augur.example.com' });
    await engine.start();
    await engine.listModels('cogitator');
    expect(engine.state.catalog.cogitator?.models.map(model => model.id)).toEqual(['laya']);
    expect(engine.state.config.policy?.providers.cogitator?.models).toEqual({});
  });

  it('waits on first run until setup finishes, then saves and refreshes', async () => {
    const f = fakeShell(null);
    engine = new UsageEngine(f.shell, { hosted: 'https://augur.example.com' });
    await engine.start();
    expect(engine.state.firstRun).toBe(true);
    expect(engine.state.snapshot).toBeNull();
    const c = structuredClone(engine.state.config);
    c.exportPath = '.augur/usage.json';
    await engine.finishSetup(c);
    expect(engine.state.firstRun).toBe(false);
    expect(f.saved()?.exportPath).toBe('.augur/usage.json');
    expect(engine.state.snapshot).not.toBeNull();
    expect(JSON.parse(f.exported.get('.augur/usage.json')!).summary).toBeTypeOf('string');
    expect(f.exported.has('.augur/policy.json')).toBe(true);
  });

  it('keeps both rule edits when two views save from older copies', async () => {
    const f = fakeShell(base());
    engine = new UsageEngine(f.shell, { hosted: 'https://augur.example.com' });
    await engine.start();
    const a = structuredClone(engine.state.config), b = structuredClone(engine.state.config);
    setField(a.policy!, fieldPath('codex', null, 'dataTier'), 'internal', 'desktop', new Date(Date.now() + 1000));
    setField(b.policy!, fieldPath('grok', null, 'dataTier'), 'public', 'desktop', new Date(Date.now() + 2000));
    b.layout.theme = 'dark';
    await engine.saveConfig(a);
    await engine.saveConfig(b);
    const policy = engine.state.config.policy!;
    expect(policy.providers.codex?.defaults.dataTier).toBe('internal');
    expect(policy.providers.grok?.defaults.dataTier).toBe('public');
    expect(engine.state.config.layout.theme).toBe('dark');
  });

  it('stores a provider key, turns the provider on and lists the key by name only', async () => {
    const f = fakeShell(base());
    engine = new UsageEngine(f.shell, { hosted: 'https://augur.example.com' });
    await engine.start();
    const seen: EngineKey[] = [];
    engine.onChange((k) => seen.push(...k));
    const p = engine.state.config.providers.find((x) => x.id === 'openrouter')!;
    expect(p.enabled).toBe(false);
    await engine.setProviderKey('openrouter', 'apiKey', ' sk-test ');
    expect(f.secrets.get('openrouter.apiKey')).toBe('sk-test');
    expect(engine.state.config.providers.find((x) => x.id === 'openrouter')!.enabled).toBe(true);
    expect(engine.state.secrets).toContain('openrouter.apiKey');
    expect(seen).toContain('secrets');
    await engine.deleteSecret('openrouter.apiKey');
    expect(engine.state.secrets).not.toContain('openrouter.apiKey');
  });

  it('writes the usage file to its new place when the path changes', async () => {
    const f = fakeShell(base());
    engine = new UsageEngine(f.shell, { hosted: 'https://augur.example.com' });
    await engine.start();
    await engine.refresh(true);
    const c = structuredClone(engine.state.config);
    c.exportPath = 'elsewhere/usage.json';
    await engine.saveConfig(c);
    expect(f.exported.has('elsewhere/usage.json')).toBe(true);
    expect(f.exported.has('elsewhere/policy.json')).toBe(true);
  });

  it('dismisses alerts and tells the views the feed changed', async () => {
    const c = base();
    c.alerts.enabled = true;
    const f = fakeShell(c);
    engine = new UsageEngine(f.shell, { hosted: 'https://augur.example.com' });
    await engine.start();
    await (engine as unknown as { raise(i: unknown[]): Promise<void> }).raise([{ id: 'x', kind: 'percent', severity: 'warn', title: 'T', body: 'B', clears: { when: 'never' } }]);
    expect(engine.state.feed.alerts.map((a) => a.id)).toContain('x');
    const seen: EngineKey[] = [];
    engine.onChange((k) => seen.push(...k));
    await callEngine(engine, 'dismiss', [['x']]);
    expect(engine.state.feed.alerts.map((a) => a.id)).not.toContain('x');
    expect(seen).toContain('feed');
  });

  it('raises a premium notice once, keeps it dismissed while it applies, and clears it when it stops', async () => {
    const c = base();
    c.alerts.enabled = true;
    const f = fakeShell(c);
    engine = new UsageEngine(f.shell, { hosted: 'https://augur.example.com' });
    await engine.start();
    const notice = { key: 'await.b1', title: 'A premium task waits', body: 'Approve it.' };
    const ids = () => engine!.state.feed.alerts.filter((a) => a.kind === 'backlog').map((a) => a.id);
    await engine.setPremiumNotices([notice]);
    expect(ids()).toEqual(['backlog.await.b1']);
    await callEngine(engine, 'dismiss', [['backlog.await.b1']]);
    await engine.setPremiumNotices([notice]);
    expect(ids()).toEqual([]);
    await engine.setPremiumNotices([]);
    await engine.setPremiumNotices([notice]);
    expect(ids()).toEqual(['backlog.await.b1']);
    await engine.setPremiumNotices([]);
    expect(ids()).toEqual([]);
  });

  it('stores a proposed rule on an unreviewed model and leaves a route reading off', async () => {
    const f = fakeShell(base());
    engine = new UsageEngine(f.shell, { hosted: 'https://augur.example.com' });
    await engine.start();
    const def = { id: 'acme2', name: 'Acme Two', auth: { type: 'bearer' as const }, requests: { balance: { url: 'https://api.acme2.example/balance' } }, money: [{ id: 'balance', label: 'Balance', amount: 'balance:$.balance' }] };
    const rule = { dataTier: 'internal', pause: { until: '2099-01-01T00:00:00Z' }, notes: 'no' } as ProposedRule;
    await engine.addProvider({ provider: 'acme2', name: 'Acme Two', custom: def, usageOff: true, models: [{ label: 'acme2/m', id: 'm', rule }] });
    expect(engine.state.config.providers.find(p => p.id === 'acme2')?.enabled).toBe(false);
    const model = engine.state.config.policy?.providers.acme2?.models['acme2/m'];
    expect(model?.status).toBe('unreviewed');
    expect(model?.rule.dataTier).toBe('internal');
    expect(model?.rule.pause).toBeUndefined();
    expect(model?.rule.notes).toBeUndefined();
  });

  it('refuses a command that is not on the list', async () => {
    const f = fakeShell(base());
    engine = new UsageEngine(f.shell, { hosted: 'https://augur.example.com' });
    await expect(callEngine(engine, 'start', [])).rejects.toThrow(/Unknown engine command/);
  });
});

describe('unpairing', () => {
  it('deletes the pairing secrets and the push key, and stops pushing to the phone', async () => {
    const c = base();
    c.sync = { relay: 'https://relay.example', channel: 'a'.repeat(64), pwaUrl: 'https://augur.example.com/' };
    const f = fakeShell(c);
    for (const n of ['sync.key', 'sync.writeSecret', 'push.vapid']) f.secrets.set(n, 'x');
    engine = new UsageEngine(f.shell, { hosted: 'https://augur.example.com' });
    await engine.start();
    await engine.unpair();
    expect([...f.secrets.keys()]).toEqual([]);
    expect(f.saved()?.sync?.channel).toBe('');
  });
});

const reading = (usedPct: number, hour: number, credits = 2): Snapshot => {
  const fetchedAt = new Date(Date.UTC(2026, 9, 3, hour)).toISOString();
  return { schema: 1, generatedAt: fetchedAt, providers: {
    ledger: { id: 'ledger', name: 'Ledger', ok: true, stale: false, fetchedAt, error: null, money: [], notes: { resets_available: credits },
      meters: [{ id: 'weekly', label: 'Weekly', usedPct, windowKind: 'weekly', windowSeconds: 604800 }] },
  } };
};
const record = (api: UsageEngine, snapshot: Snapshot) => {
  (api as unknown as { recordResets(snapshot: Snapshot): void }).recordResets(snapshot);
  api.state.snapshot = snapshot;
};

describe('the reset ledger in the usage engine', () => {
  it('retries a failed batch with the next refresh in order, without repeating a successful batch', async () => {
    const f = fakeShell(null), persisted: ResetEvent[] = [];
    const append = vi.fn(async (events: ResetEvent[]) => { persisted.push(...events); });
    append.mockRejectedValueOnce(new Error('write failed'));
    f.shell.appendResets = append;
    let hour = 23, used = 40;
    f.shell.host.now = () => new Date(Date.UTC(2026, 9, 3, hour));
    f.shell.host.http = async () => ({ status: 200, headers: {}, body: JSON.stringify({ used }) });
    engine = new UsageEngine(f.shell, { hosted: 'https://augur.example.com' });
    await engine.start();
    const config = base();
    config.custom = [{ id: 'ledger', name: 'Ledger', auth: { type: 'none' }, requests: { usage: { url: 'https://usage.example/reading' } },
      meters: [{ id: 'weekly', label: 'Weekly', usedPct: 'usage:$.used', windowKind: 'weekly', windowSeconds: 604800 }] }];
    config.providers.push({ id: 'ledger', enabled: true, settings: {} });
    engine.state.config = config;
    engine.state.snapshot = reading(83, 22);
    await engine.refresh(true);
    expect(persisted).toEqual([]);
    hour = 24; used = 0;
    await engine.refresh(true);
    expect(append.mock.calls.map(([events]) => events.length)).toEqual([1, 2]);
    expect(persisted.map(event => event.usedBefore)).toEqual([83, 40]);
    expect(new Set(persisted.map(event => event.id)).size).toBe(2);
    await engine.refresh(true);
    await engine.flush();
    expect(append).toHaveBeenCalledTimes(2);
  });

  it.each(['reset', 'credits'] as const)('does not repeat a loaded %s when the saved snapshot is behind the ledger', async kind => {
    const f = fakeShell(null), before = reading(83, 22), after = reading(kind === 'reset' ? 0 : 83, 23, 1);
    const prior = detectResets(before, after)[0]!;
    if (kind === 'credits') { prior.meter = 'secondary'; prior.id = `${prior.provider}.${prior.meter}.${prior.at}`; }
    f.shell.loadSnapshot = async () => before;
    f.shell.loadResets = async () => [prior];
    f.shell.appendResets = vi.fn(async () => undefined);
    engine = new UsageEngine(f.shell, { hosted: 'https://augur.example.com' });
    await engine.start();
    record(engine, reading(kind === 'reset' ? 0 : 83, 24, 1));
    await engine.flush();
    expect(engine.state.resets).toEqual([prior]);
    expect(f.shell.appendResets).not.toHaveBeenCalled();
  });

  it('drops the oldest pending events at the queue limit and logs the loss', async () => {
    const f = fakeShell(null), logs: string[] = [], persisted: ResetEvent[] = [];
    f.shell.host.log = message => { logs.push(message); };
    f.shell.appendResets = async events => { persisted.push(...events); };
    engine = new UsageEngine(f.shell, { hosted: 'https://augur.example.com' });
    await engine.start();
    for (let i = 0; i < 1002; i++) {
      engine.state.snapshot = reading(83, i * 2);
      record(engine, reading(0, i * 2 + 1));
    }
    await engine.flush();
    expect(persisted).toHaveLength(1000);
    expect(persisted[0]!.at).toBe(reading(0, 5).generatedAt);
    expect(persisted.at(-1)!.at).toBe(reading(0, 2003).generatedAt);
    expect(logs).toEqual(Array(2).fill('Reset ledger retry queue exceeded 1000 events; the oldest events were dropped.'));
  }, 30000);

  it('waits for an active append before flushing the queued batch', async () => {
    const f = fakeShell(null), persisted: ResetEvent[] = [];
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    f.shell.appendResets = vi.fn(async events => { await blocked; persisted.push(...events); });
    engine = new UsageEngine(f.shell, { hosted: 'https://augur.example.com' });
    await engine.start();
    engine.state.snapshot = reading(83, 22);
    record(engine, reading(40, 23));
    await Promise.resolve();
    record(engine, reading(0, 24));
    let flushed = false;
    const flush = engine.flush().then(() => { flushed = true; });
    await Promise.resolve();
    expect(flushed).toBe(false);
    expect(f.shell.appendResets).toHaveBeenCalledTimes(1);
    release();
    await flush;
    expect(persisted.map(event => event.usedBefore)).toEqual([83, 40]);
  });

  it('makes one flush retry after an append rejects and resolves even if the retry rejects', async () => {
    const f = fakeShell(null);
    f.shell.appendResets = vi.fn(async () => { throw new Error('write failed'); });
    engine = new UsageEngine(f.shell, { hosted: 'https://augur.example.com' });
    await engine.start();
    engine.state.snapshot = reading(83, 22);
    record(engine, reading(0, 23));
    await expect(engine.flush()).resolves.toBeUndefined();
    expect(f.shell.appendResets).toHaveBeenCalledTimes(2);
    expect(engine.state.resets).toHaveLength(1);
  });

  it('bounds a flush of an append that never settles to 3 seconds', async () => {
    vi.useFakeTimers();
    const f = fakeShell(null);
    f.shell.appendResets = () => new Promise(() => undefined);
    engine = new UsageEngine(f.shell, { hosted: 'https://augur.example.com' });
    await engine.start();
    engine.state.snapshot = reading(83, 22);
    record(engine, reading(0, 23));
    let flushed = false;
    const flush = engine.flush().then(() => { flushed = true; });
    await vi.advanceTimersByTimeAsync(2999);
    expect(flushed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(flush).resolves.toBeUndefined();
  });

  it('starts after 5 seconds when the ledger read never settles and still appends new events', async () => {
    vi.useFakeTimers();
    const f = fakeShell(null), logs: string[] = [];
    f.shell.loadResets = () => new Promise(() => undefined);
    f.shell.host.log = message => { logs.push(message); };
    f.shell.appendResets = vi.fn(async () => undefined);
    engine = new UsageEngine(f.shell, { hosted: 'https://augur.example.com' });
    let started = false;
    const start = engine.start().then(() => { started = true; });
    await vi.advanceTimersByTimeAsync(4999);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await start;
    expect(engine.state.resets).toEqual([]);
    engine.state.snapshot = reading(83, 22);
    record(engine, reading(0, 23));
    await engine.flush();
    expect(f.shell.appendResets).toHaveBeenCalledWith(engine.state.resets);
    await vi.advanceTimersByTimeAsync(5000);
    expect(logs).toEqual(['Reset ledger read timed out after 5 seconds; startup will continue.']);
  });

  it('merges a late ledger read by id with events recorded after the timeout', async () => {
    vi.useFakeTimers();
    const f = fakeShell(null);
    let release!: (events: ResetEvent[]) => void;
    f.shell.loadResets = () => new Promise(resolve => { release = resolve; });
    engine = new UsageEngine(f.shell, { hosted: 'https://augur.example.com' });
    const start = engine.start();
    await vi.advanceTimersByTimeAsync(5000);
    await start;
    engine.state.snapshot = reading(83, 22);
    record(engine, reading(0, 23));
    await engine.flush();
    const fresh = engine.state.resets[0]!, older = detectResets(reading(83, 20), reading(0, 21))[0]!;
    const changed: EngineKey[] = [];
    engine.onChange(keys => changed.push(...keys));
    release([older, fresh]);
    await Promise.resolve();
    expect(engine.state.resets).toEqual([older, fresh]);
    expect(changed).toContain('resets');
  });

  it('loads prior events, records a fresh reset, exports its note, and does not wait for an append', async () => {
    const f = fakeShell(null);
    let at = new Date('2026-10-03T22:00:00.000Z'), used = 83;
    const appended: import('../src/index.js').ResetEvent[] = [];
    f.shell.host.now = () => at;
    f.shell.host.http = async () => ({ status: 200, headers: {}, body: JSON.stringify({ used }) });
    f.shell.appendResets = events => { appended.push(...events); return new Promise(() => undefined); };
    engine = new UsageEngine(f.shell, { hosted: 'https://augur.example.com' });
    await engine.start();
    const config = base();
    config.exportPath = '.augur/usage.json';
    config.custom = [{ id: 'ledger', name: 'Ledger', auth: { type: 'none' }, requests: { usage: { url: 'https://usage.example/reading' } },
      meters: [{ id: 'weekly', label: 'Weekly', usedPct: 'usage:$.used', windowKind: 'weekly', windowSeconds: 604800 }] }];
    config.providers.push({ id: 'ledger', enabled: true, settings: {} });
    engine.state.config = config;
    await engine.refresh(true);
    expect(appended).toEqual([]);
    at = new Date('2026-10-03T23:00:00.000Z');
    used = 0;
    await engine.refresh(true);
    expect(appended).toHaveLength(1);
    expect(engine.state.resets).toEqual(appended);
    const pattern = { count: 1, early: 1, atLimit: 0, medianGapHours: null, lastAt: at.toISOString(), sample: 'small' };
    expect(engine.state.snapshot?.providers.ledger?.notes?.reset_pattern).toEqual(pattern);
    expect(JSON.parse(f.exported.get('.augur/usage.json')!).providers.ledger.notes.reset_pattern).toEqual(pattern);
    await engine.refresh();
    expect(appended).toHaveLength(1);
    engine.stop();
    f.shell.loadResets = async () => appended;
    engine = new UsageEngine(f.shell, { hosted: 'https://augur.example.com' });
    await engine.start();
    expect(engine.state.resets).toEqual(appended);
  });

  it('logs ledger load and append failures and completes refreshes', async () => {
    const f = fakeShell(null), logs: string[] = [];
    f.shell.host.log = message => { logs.push(message); };
    f.shell.loadResets = async () => { throw new Error('read failed'); };
    f.shell.appendResets = async () => { throw new Error('write failed'); };
    engine = new UsageEngine(f.shell, { hosted: 'https://augur.example.com' });
    await engine.start();
    expect(engine.state.resets).toEqual([]);
    expect(logs).toHaveLength(1);
    const make = (usedPct: number, fetchedAt: string): Snapshot => ({ schema: 1, generatedAt: fetchedAt, providers: {
      ledger: { id: 'ledger', name: 'Ledger', ok: true, stale: false, fetchedAt, error: null, money: [],
        meters: [{ id: 'weekly', label: 'Weekly', usedPct, windowKind: 'weekly', windowSeconds: 604800 }] },
    } });
    engine.state.snapshot = make(83, '2026-10-03T22:00:00.000Z');
    const after = make(0, '2026-10-03T23:00:00.000Z');
    (engine as unknown as { recordResets(snapshot: Snapshot): void }).recordResets(after);
    await Promise.resolve();
    await Promise.resolve();
    expect(logs).toHaveLength(2);
    expect(engine.state.resets).toHaveLength(1);
    await engine.refresh(true);
    expect(engine.state.busy).toBe(false);
  });
});
