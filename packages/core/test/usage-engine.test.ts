import { afterEach, describe, expect, it } from 'vitest';
import { callEngine, defaultConfig, fieldPath, migrateConfig, setField, UsageEngine } from '../src/index.js';
import type { AppConfig, EngineKey, EngineShell, Snapshot } from '../src/index.js';

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
afterEach(() => { engine?.stop(); engine = null; });

describe('the usage engine', () => {
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

  it('refuses a command that is not on the list', async () => {
    const f = fakeShell(base());
    engine = new UsageEngine(f.shell, { hosted: 'https://augur.example.com' });
    await expect(callEngine(engine, 'start', [])).rejects.toThrow(/Unknown engine command/);
  });
});
