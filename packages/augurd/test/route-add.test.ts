import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageEngine, readFleet } from '@augur/core';
import type { AppConfig, EngineShell } from '@augur/core';
import type { RouteAddParams } from '@augur/dispatch-protocol';
import { call } from '../src/client.js';
import { IpcServer } from '../src/ipc.js';
import type { Supervisor } from '../src/supervisor.js';
import { ViewHub } from '../src/views.js';

function fakeShell() {
  let config: AppConfig | null = null;
  const shell: EngineShell = {
    host: { platform: 'linux', http: async () => ({ status: 404, headers: {}, body: '' }), secret: async () => null, readHomeFile: async () => null, writeHomeFileAtomic: async () => undefined } as EngineShell['host'],
    loadConfig: async () => (config ? structuredClone(config) : null),
    saveConfig: async (c) => { config = structuredClone(c); },
    setSecret: async () => undefined, deleteSecret: async () => undefined, hasSecret: async () => false,
    loadSnapshot: async () => null, saveSnapshot: async () => undefined, loadHistory: async () => [], saveHistory: async () => undefined,
    loadResets: async () => [], appendResets: async () => undefined,
    loadAlertState: async () => ({}), saveAlertState: async () => undefined, loadAlertFeed: async () => null, saveAlertFeed: async () => undefined,
    exportSnapshot: async () => undefined, notify: async () => undefined,
  };
  return shell;
}

const stops: Array<() => Promise<void>> = [];
afterEach(async () => { while (stops.length) await stops.pop()!(); });

async function boot(approval?: 'all' | 'none') {
  const root = mkdtempSync(join(tmpdir(), 'augur-route-add-'));
  const routesPath = join(root, 'routes.json');
  const engine = new UsageEngine(fakeShell(), { hosted: 'https://augur.example.com' });
  await engine.start();
  if (approval) {
    const next = structuredClone(engine.state.config);
    next.agentApproval = approval;
    await engine.saveConfig(next);
  }
  const sup = { knownAdapters: () => ['codex-exec', 'openai-api'], proseAdd: (raw: Record<string, unknown>, hold: boolean) => ({ ...raw, status: hold ? 'awaiting-approval' : 'queued' }) } as unknown as Supervisor;
  const token = 'k'.repeat(64);
  const server = new IpcServer(sup, {} as never, token, () => { try { return JSON.parse(readFileSync(routesPath, 'utf8')).routes ?? {}; } catch { return null; } }, () => ({}), {
    read: () => { try { return readFileSync(routesPath, 'utf8'); } catch { return null; } },
    write: (text: string) => writeFileSync(routesPath, text),
  }, 'a'.repeat(64));
  server.attachEngine({ api: engine, views: new ViewHub() });
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\augur-route-add-${Date.now()}-${Math.floor(Math.random() * 1e6)}` : join(root, 's.sock');
  await server.start(pipe);
  stops.push(async () => { engine.stop(); await server.close(); rmSync(root, { recursive: true, force: true }); });
  const add = (params: RouteAddParams) => call('route_add', params, { pipe, token });
  const agentProseAdd = (params: Record<string, unknown>) => call('prose_add', params as never, { pipe, token: 'a'.repeat(64), role: 'agent' });
  const accept = (id: string, name = 'local', agent = false) => call('fleet_accept', { id, name }, { pipe, token: agent ? 'a'.repeat(64) : token, ...(agent ? { role: 'agent' as const } : {}) });
  return { engine, routesPath, add, agentProseAdd, accept };
}

const good = { name: 'acme', adapter: 'codex-exec', provider: 'acme', model: { label: 'fast', id: 'fast-1', name: 'Fast' } };

function fleet(engine: UsageEngine, fetchedAt = new Date().toISOString(), stale = false) {
  engine.state.snapshot = { schema: 1, generatedAt: fetchedAt, providers: { cogitator: { id: 'cogitator', name: 'Cogitator', ok: !stale, stale, fetchedAt, error: null, meters: [], money: [],
    notes: { fleet: readFleet({ self: { name: 'eru', ledger: { models: [{ id: 'laya' }, { id: 'embeddinggemma-2' }, { id: 'qwen3-asr-1.7b' }, { id: 'comfyui' }, { id: 'unknown' }] }, roles: [{ name: 'judge', chain: ['laya'] }] } }) } } } };
}

describe('Cogitator offers', () => {
  it('requires owner acceptance and a current live sighting before writing anything', async () => {
    const { engine, routesPath, accept } = await boot();
    expect((await accept('laya')).ok).toBe(false);
    fleet(engine);
    await expect(accept('laya', 'local', true)).rejects.toThrow('for the owner');
    expect((await accept('not-listed')).ok).toBe(false);
    expect(existsSync(routesPath)).toBe(false);
    expect(engine.state.config.policy?.providers.cogitator).toBeUndefined();
    fleet(engine, new Date(Date.now() - 3 * 3600000).toISOString());
    expect((await accept('laya')).ok).toBe(false);
    fleet(engine, new Date().toISOString(), true);
    expect((await accept('laya')).ok).toBe(false);
  });

  it('adds an unreviewed entry and a route without a key after the owner accepts', async () => {
    const { engine, routesPath, accept } = await boot('all');
    fleet(engine);
    const result = await accept('judge');
    expect(result.ok, result.text).toBe(true);
    const entry = engine.state.config.policy!.providers.cogitator!.models['cogitator/judge']!;
    expect(entry.status).toBe('unreviewed'); expect(entry.rule).toEqual({});
    expect(JSON.parse(readFileSync(routesPath, 'utf8')).routes.local).toEqual({ model: 'cogitator/judge', adapter: 'openai-api', options: { baseUrl: 'http://127.0.0.1:8470/v1', model: 'judge', keySource: 'store', requestClass: 'cogitator', mode: 'chat', maxInput: 24000 } });
    expect(result.text).toContain('augur key set local');
    expect((await accept('judge', 'another-local')).ok).toBe(false);
  });

  it('uses the configured gateway and the request mode for the entry kind', async () => {
    const { engine, routesPath, accept } = await boot();
    const config = structuredClone(engine.state.config);
    config.providers.find(provider => provider.id === 'cogitator')!.settings.baseUrl = 'http://eru:8470';
    await engine.saveConfig(config);
    fleet(engine);
    expect((await accept('embeddinggemma-2', 'embed-local')).ok).toBe(true);
    expect((await accept('qwen3-asr-1.7b', 'listen-local')).ok).toBe(true);
    const routes = JSON.parse(readFileSync(routesPath, 'utf8')).routes;
    expect(routes['embed-local'].options).toMatchObject({ baseUrl: 'http://eru:8470/v1', mode: 'embeddings' });
    expect(routes['listen-local'].options.mode).toBe('transcribe');
  });

  it('does not overwrite an existing route and preserves a known entry when adding its missing route', async () => {
    const { engine, routesPath, accept } = await boot();
    await engine.addProvider({ provider: 'cogitator', name: 'Cogitator', models: [{ label: 'cogitator/decision', id: 'laya' }] });
    engine.state.config.policy!.providers.cogitator!.models['cogitator/decision']!.status = 'confirmed';
    const beforeModel = structuredClone(engine.state.config.policy!.providers.cogitator!.models['cogitator/decision']);
    const original = JSON.stringify({ keep: true, routes: { local: { model: 'keep/model', adapter: 'codex-exec', options: {} } } });
    writeFileSync(routesPath, original);
    fleet(engine);
    expect((await accept('laya')).ok).toBe(false);
    expect(readFileSync(routesPath, 'utf8')).toBe(original);
    expect((await accept('laya', 'new-local')).ok).toBe(true);
    expect(engine.state.config.policy!.providers.cogitator!.models['cogitator/decision']).toEqual(beforeModel);
    expect(JSON.parse(readFileSync(routesPath, 'utf8')).routes['new-local'].model).toBe('cogitator/decision');
  });

  it('accepts image and unknown entries for review without inventing an API route', async () => {
    const { engine, routesPath, accept } = await boot();
    fleet(engine);
    expect((await accept('comfyui')).ok).toBe(true);
    expect((await accept('unknown')).ok).toBe(true);
    expect(existsSync(routesPath)).toBe(false);
    expect(engine.state.config.policy!.providers.cogitator!.models['cogitator/comfyui']!.status).toBe('unreviewed');
    expect(engine.state.config.policy!.providers.cogitator!.models['cogitator/unknown']!.status).toBe('unreviewed');
  });

  it('adds only the missing entry when a route already uses its label', async () => {
    const { engine, routesPath, accept } = await boot();
    const original = JSON.stringify({ routes: { decision: { model: 'cogitator/laya', adapter: 'openai-api', options: { model: 'laya' } } } });
    writeFileSync(routesPath, original);
    fleet(engine);
    expect((await accept('laya')).ok).toBe(true);
    expect(readFileSync(routesPath, 'utf8')).toBe(original);
    expect(engine.state.config.policy!.providers.cogitator!.models['cogitator/laya']!.status).toBe('unreviewed');
  });

  it('refuses a label that belongs to another provider before adding an entry or a route', async () => {
    const { engine, routesPath, accept } = await boot();
    await engine.addProvider({ provider: 'other', name: 'Other', models: [{ label: 'cogitator/laya', id: 'other-entry' }] });
    fleet(engine);
    expect((await accept('laya')).ok).toBe(false);
    expect(existsSync(routesPath)).toBe(false);
    expect(engine.state.config.policy!.providers.cogitator).toBeUndefined();
  });
});

describe('route_add', () => {
  it('holds agent prose additions when agentApproval is all', async () => {
    const all = await boot('all');
    const params = { requester: 'agent', repo: 'repo', target: 'new', kind: 'write', surface: 'doc', audience: 'readers', voice: 'plain', urgency: 'normal' };
    expect(await all.agentProseAdd(params)).toMatchObject({ status: 'awaiting-approval' });
    const none = await boot('none');
    expect(await none.agentProseAdd(params)).toMatchObject({ status: 'queued' });
  });

  it('adds a route and an unreviewed model, and leaves a custom reading off', async () => {
    const { engine, routesPath, add } = await boot();
    const next = structuredClone(engine.state.config);
    next.alerts.enabled = true;
    await engine.saveConfig(next);
    writeFileSync(routesPath, JSON.stringify({ keep: true, routes: {} }));
    const r = await add({ ...good, options: { baseUrl: 'https://api.acme.example/v1' }, balanceUrl: 'https://api.acme.example/balance', balancePath: '$.balance' });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('unreviewed');
    expect(r.text).toContain('Model rules');
    expect(r.text).toContain('augur key set acme');
    expect(r.text).toContain('stays off');
    expect(r.text).toContain('api.acme.example');
    expect(r.text).toContain('check that address');
    const file = JSON.parse(readFileSync(routesPath, 'utf8')) as { keep: boolean; routes: Record<string, { model: string; options: Record<string, string> }> };
    expect(file.keep).toBe(true);
    expect(file.routes.acme).toMatchObject({ model: 'acme/fast', adapter: 'codex-exec', options: { baseUrl: 'https://api.acme.example/v1' } });
    expect(engine.state.config.policy?.providers.acme?.models['acme/fast']).toMatchObject({ id: 'fast-1', name: 'Fast', status: 'unreviewed' });
    expect(engine.state.config.providers.find(p => p.id === 'acme')?.enabled).toBe(false);
    expect(engine.state.config.custom?.map(d => d.id)).toEqual(['acme']);
    expect(engine.state.feed.alerts.some(a => a.title.includes('new model'))).toBe(true);
  });

  it('refuses an existing name, a key-like option, an unknown adapter, a bad model id and a secret, and writes nothing', async () => {
    const { engine, routesPath, add } = await boot();
    const before = () => engine.state.config.policy?.providers.acme;
    const secret = await add({ ...good, options: { baseUrl: 'sk-live-secret' } });
    const named = await add({ ...good, options: { apiKey: 'plain' } });
    const adapter = await add({ ...good, adapter: 'nope' });
    const model = await add({ ...good, model: { label: 'fast', id: 'bad id' } });
    const key = await add({ ...good, key: 'sk-live-secret' } as RouteAddParams);
    for (const r of [secret, named, adapter, model, key]) expect(r.ok).toBe(false);
    expect(secret.text).toContain('Nothing was written');
    expect(secret.text).not.toContain('sk-live-secret');
    expect(named.text).toContain('looks like a key');
    expect(adapter.text).toContain('nope');
    expect(model.text).toContain('model id');
    expect(key.text).not.toContain('sk-live-secret');
    expect(existsSync(routesPath)).toBe(false);
    expect(before()).toBeUndefined();
    writeFileSync(routesPath, JSON.stringify({ routes: { luna: { model: 'codex/luna', adapter: 'codex-exec', options: {} } } }));
    const snap = readFileSync(routesPath, 'utf8');
    const exists = await add({ ...good, name: 'luna' });
    expect(exists.ok).toBe(false);
    expect(exists.text).toContain('already exists');
    expect(exists.text).toContain('Nothing was written');
    expect(readFileSync(routesPath, 'utf8')).toBe(snap);
    expect(before()).toBeUndefined();
  });

  it('holds every add when the approval setting is all, and writes one when it is none', async () => {
    const held = await boot('all');
    const blocked = await held.add(good);
    expect(blocked.ok).toBe(false);
    expect(blocked.held).toBe(true);
    expect(blocked.text).toContain('approval setting holds every agent edit');
    expect(existsSync(held.routesPath)).toBe(false);
    expect(held.engine.state.config.policy?.providers.acme).toBeUndefined();
    const open = await boot('none');
    const wrote = await open.add(good);
    expect(wrote.ok).toBe(true);
    expect(wrote.text).toContain('unreviewed');
    expect(open.engine.state.config.policy?.providers.acme?.models['acme/fast']?.status).toBe('unreviewed');
    expect(existsSync(open.routesPath)).toBe(true);
  });
  it('refuses options that name a program, a folder or an environment variable, and holds a route for a model the rules already hold', async () => {
    const { engine, routesPath, add } = await boot();
    for (const options of <Array<Record<string, string>>>[{ command: '/bin/sh' }, { argsJson: '["-c","x"]' }, { envAllow: 'HOME' }, { apiKeyEnv: 'PATH' }, { workRoot: '/' }, { headersJson: '{}' }, { keySource: 'env' }]) {
      const r = await add({ ...good, options });
      expect(r.ok, JSON.stringify(options)).toBe(false);
      expect(r.held).toBeUndefined();
    }
    expect(existsSync(routesPath)).toBe(false);
    const first = await add(good);
    expect(first.ok).toBe(true);
    const again = await add({ ...good, name: 'second' });
    expect(again.ok).toBe(false);
    expect(again.held).toBe(true);
    expect(again.text).toContain('already in the rules');
    expect(JSON.parse(readFileSync(routesPath, 'utf8')).routes.second).toBeUndefined();
    expect(Object.keys(engine.state.config.policy?.providers.acme?.models ?? {})).toEqual(['acme/fast']);
  });
  it('does not treat a model id held under another provider as already in the rules', async () => {
    const { engine, add } = await boot();
    expect((await add(good)).ok).toBe(true);
    const other = await add({ name: 'beta', adapter: 'codex-exec', provider: 'beta', model: { label: 'slow', id: 'fast-1', name: 'Slow' } });
    expect(other.ok, other.text).toBe(true);
    expect(Object.keys(engine.state.config.policy?.providers.beta?.models ?? {})).toEqual(['beta/slow']);
  });
});
