import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageEngine, fieldPath, setField } from '@augur/core';
import type { AppConfig, EngineShell, ProviderAddition } from '@augur/core';
import { main } from '../src/cli.js';
import { profileCmd } from '../src/profile.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'augur-profile-')); dirs.push(dir);
  const home = join(dir, 'home');
  mkdirSync(join(home, 'dispatch'), { recursive: true });
  const env = { ...process.env, AUGUR_HOME: home, AUGURD_ROUTES: join(home, 'dispatch', 'routes.json') } as NodeJS.ProcessEnv;
  const run = async (args: string[]) => {
    let out = '', err = '';
    const code = await main(args, { out: t => { out += t; }, err: t => { err += t; }, stdin: () => '', env, cwd: dir, interactive: false });
    return { code, out, err };
  };
  const inbox = () => { try { return readFileSync(join(home, 'policy-edits.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>); } catch { return []; } };
  const routes = () => JSON.parse(readFileSync(join(home, 'dispatch', 'routes.json'), 'utf8')) as { routes: Record<string, Record<string, unknown>> };
  return { dir, home, env, run, inbox, routes, write: (name: string, text: string) => writeFileSync(join(dir, name), text) };
}

const ROUTES = JSON.stringify({ routes: {
  deepseek: { model: 'openrouter/deepseek-v4', adapter: 'openai-api', options: { baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4', keySource: 'store', apiKey: 'sk-should-not-leave' } },
  luna: { model: 'codex/luna', adapter: 'codex-exec', options: {} } } });

describe('augur profile export', () => {
  it('writes the balance settings and routes, and leaves out anything that looks like a key', async () => {
    const t = setup();
    writeFileSync(join(t.home, 'policy.json'), JSON.stringify({ schema: 1, providers: {}, balance: { profile: 'neutral', tilt: { deep: { strong: 1.3 } } } }));
    writeFileSync(join(t.home, 'dispatch', 'routes.json'), ROUTES);
    const r = await t.run(['profile', 'export', 'out.json']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('2 balance settings and 2 routes');
    expect(r.out).toContain('Left out: deepseek.apiKey');
    const file = JSON.parse(readFileSync(join(t.dir, 'out.json'), 'utf8'));
    expect(file).toMatchObject({ kind: 'augur-profile', schema: 1, balance: { profile: 'neutral', tilt: { deep: { strong: 1.3 } } } });
    expect(JSON.stringify(file)).not.toContain('sk-should-not-leave');
    expect(file.routes.deepseek.options.keySource).toBe('store');
  });
  it('writes to and reads from an absolute path as given, not under the current folder', async () => {
    const t = setup();
    const abs = join(t.home, 'elsewhere.json');
    const r = await t.run(['profile', 'export', abs]);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(abs, 'utf8'))).toMatchObject({ kind: 'augur-profile' });
    expect((await t.run(['profile', 'import', abs, '--dry-run'])).code).toBe(0);
  });

  it('exports an empty profile from a computer with nothing set', async () => {
    const t = setup();
    const r = await t.run(['profile', 'export', 'out.json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(t.dir, 'out.json'), 'utf8'))).toMatchObject({ balance: {}, routes: {} });
  });
});

describe('augur profile import', () => {
  const bundle = (over: Record<string, unknown> = {}) => JSON.stringify({ kind: 'augur-profile', schema: 1, balance: { profile: 'neutral', tilt: { deep: { strong: 1.3 } } }, routes: { luna: { model: 'codex/luna', adapter: 'codex-exec', options: {} } }, ...over });

  it('puts balance settings in the edit inbox and adds a new route', async () => {
    const t = setup();
    t.write('p.json', bundle());
    const r = await t.run(['profile', 'import', 'p.json']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('2 balance settings and 1 new route');
    expect(t.inbox().map(e => [e.field, e.value, e.by])).toEqual([['balance:profile', 'neutral', 'augur profile import'], ['balance:tilt|deep|strong', 1.3, 'augur profile import']]);
    expect(t.routes().routes.luna).toMatchObject({ model: 'codex/luna', adapter: 'codex-exec' });
  });
  it('leaves a route that already exists as it is', async () => {
    const t = setup();
    writeFileSync(join(t.home, 'dispatch', 'routes.json'), JSON.stringify({ routes: { luna: { model: 'codex/luna', adapter: 'codex-exec', options: {}, notes: 'mine' } } }));
    t.write('p.json', bundle({ routes: { luna: { model: 'codex/other', adapter: 'codex-exec', options: {} } } }));
    const r = await t.run(['profile', 'import', 'p.json']);
    expect(r.out).toContain('1 route left as they are (luna)');
    expect(t.routes().routes.luna).toMatchObject({ model: 'codex/luna', notes: 'mine' });
  });
  it('writes nothing on --dry-run', async () => {
    const t = setup();
    t.write('p.json', bundle());
    const r = await t.run(['profile', 'import', 'p.json', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Would apply');
    expect(t.inbox()).toEqual([]);
    expect(() => t.routes()).toThrow();
  });
  it('refuses the whole file when one entry is bad', async () => {
    const t = setup();
    t.write('p.json', bundle({ balance: { profile: 'wild', nope: 1 }, routes: { x: { model: 'a/b', adapter: 'nothing' } } }));
    const r = await t.run(['profile', 'import', 'p.json']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Nothing was changed. The profile has 3 problems');
    expect(r.err).toContain('balance profile');
    expect(r.err).toContain('route x');
    expect(t.inbox()).toEqual([]);
  });
  it('refuses a route that carries a key and a file that is not a profile', async () => {
    const t = setup();
    t.write('p.json', bundle({ routes: { d: { model: 'a/b', adapter: 'openai-api', options: { apiKey: 'sk-x' } } } }));
    expect((await t.run(['profile', 'import', 'p.json'])).err).toContain('looks like a key');
    t.write('q.json', JSON.stringify({ hello: 1 }));
    expect((await t.run(['profile', 'import', 'q.json'])).err).toContain('not an Augur profile');
    t.write('r.json', JSON.stringify({ kind: 'augur-profile', schema: 9 }));
    expect((await t.run(['profile', 'import', 'r.json'])).err).toContain('schema 9');
    expect((await t.run(['profile', 'import', 'missing.json'])).err).toContain('was not found');
  });
});

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

describe('profile model rules', () => {
  const engines: UsageEngine[] = [];
  afterEach(() => { while (engines.length) engines.pop()!.stop(); });

  async function engine(): Promise<UsageEngine> {
    const e = new UsageEngine(fakeShell(), { hosted: 'https://augur.example.com' });
    engines.push(e);
    await e.start();
    const next = structuredClone(e.state.config);
    next.alerts.enabled = true;
    await e.saveConfig(next);
    return e;
  }

  async function runImport(t: ReturnType<typeof setup>, args: string[], add: (input: ProviderAddition) => Promise<{ labels: Record<string, string>; added: string[] }>) {
    let out = '', err = '';
    const code = await profileCmd(args, { dryRun: args.includes('--dry-run') }, { err: s => { err += s; }, env: t.env, cwd: t.dir }, human => { out += human; }, new Date('2026-10-10T00:00:00Z'), { addProvider: add });
    return { code, out, err };
  }

  const POLICY = {
    schema: 1,
    providers: { acme: { name: 'Acme', thresholds: { warnPct: 10, denyPct: 20, minBalance: 1 }, models: {
      'acme/fast': { id: 'fast-1', name: 'Fast', status: 'confirmed', source: 'manual', activities: { write_code: 'preferred' }, dataTier: 'internal', askFirst: false, output: 'text_only', sandbox: false, effort: null, cost: 'cheap', pause: { until: '2099-01-01T00:00:00Z', reason: 'hold' }, notes: 'local only', useAfter: ['codex/sol'], dataHandling: { hostCountry: 'US', retainsPrompts: false }, inherited: ['askFirst', 'output', 'sandbox'] },
      'acme/bare': { id: 'bare-1', status: 'unreviewed', dataTier: 'public', activities: {}, dataHandling: {}, pause: null, notes: '' },
    } } },
    balance: { profile: 'neutral' },
    unreviewed: ['acme/bare'],
  };

  it('exports model rules and leaves out status, pauses, notes and thresholds', async () => {
    const t = setup();
    writeFileSync(join(t.home, 'policy.json'), JSON.stringify(POLICY));
    writeFileSync(join(t.home, 'dispatch', 'routes.json'), JSON.stringify({ routes: { acme: { model: 'acme/fast', adapter: 'codex-exec', options: { apiKey: 'sk-should-not-leave' } } } }));
    const r = await t.run(['profile', 'export', 'out.json']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Left out: acme.apiKey');
    const file = JSON.parse(readFileSync(join(t.dir, 'out.json'), 'utf8')) as { models: unknown };
    expect(file.models).toEqual({ acme: {
      'acme/fast': { id: 'fast-1', name: 'Fast', rule: { activities: { write_code: 'preferred' }, dataTier: 'internal', cost: 'cheap', dataHandling: { hostCountry: 'US', retainsPrompts: false } } },
      'acme/bare': { id: 'bare-1', rule: { dataTier: 'public' } },
    } });
    const dumped = JSON.stringify(file.models);
    for (const word of ['confirmed', 'unreviewed', 'pause', 'notes', 'threshold', 'useAfter', 'inherited', 'status']) expect(dumped).not.toContain(word);
    expect(dumped).not.toContain('sk-should-not-leave');
  });

  it('imports every model unreviewed with its proposed rule, and creates a rules-only provider', async () => {
    const src = setup();
    writeFileSync(join(src.home, 'policy.json'), JSON.stringify(POLICY));
    writeFileSync(join(src.home, 'dispatch', 'routes.json'), JSON.stringify({ routes: { acme: { model: 'acme/fast', adapter: 'codex-exec', options: {} } } }));
    expect((await src.run(['profile', 'export', 'out.json'])).code).toBe(0);
    const dst = setup();
    writeFileSync(join(dst.dir, 'p.json'), readFileSync(join(src.dir, 'out.json')));
    const e = await engine();
    const r = await runImport(dst, ['import', 'p.json'], input => e.addProvider(input));
    expect(r.code).toBe(0);
    expect(r.out).toContain('2 new models');
    expect(r.out).toContain('unreviewed');
    const fast = e.state.config.policy?.providers.acme?.models['acme/fast'];
    const bare = e.state.config.policy?.providers.acme?.models['acme/bare'];
    expect(fast).toMatchObject({ id: 'fast-1', name: 'Fast', status: 'unreviewed', source: 'manual', rule: { activities: { write_code: 'preferred' }, dataTier: 'internal', cost: 'cheap', dataHandling: { hostCountry: 'US', retainsPrompts: false } } });
    expect(fast?.rule.pause).toBeUndefined();
    expect(fast?.rule.notes).toBeUndefined();
    expect(fast?.rule.useAfter).toBeUndefined();
    expect(bare).toMatchObject({ id: 'bare-1', status: 'unreviewed', rule: { dataTier: 'public' } });
    expect(e.state.config.rulesOnly).toEqual([{ id: 'acme', name: 'acme' }]);
    expect(e.state.feed.alerts.some(a => a.title.includes('new models to review'))).toBe(true);
    expect(dst.routes().routes.acme).toMatchObject({ model: 'acme/fast', adapter: 'codex-exec' });
    for (const model of Object.values(e.state.config.policy?.providers.acme?.models ?? {})) expect(model.status).not.toBe('confirmed');
  });

  it('leaves a model that is already here as it is', async () => {
    const t = setup();
    const e = await engine();
    await e.addProvider({ provider: 'acme', name: 'acme', models: [{ label: 'acme/fast', id: 'fast-1', rule: { dataTier: 'public', cost: 'free' } }] });
    setField(e.state.config.policy!, fieldPath('acme', 'acme/fast', 'status'), 'confirmed', 'test', new Date('2026-10-10T00:00:00Z'));
    await e.saveConfig(structuredClone(e.state.config));
    writeFileSync(join(t.home, 'policy.json'), JSON.stringify({ providers: { acme: { models: { 'acme/fast': { id: 'fast-1' } } } } }));
    t.write('p.json', JSON.stringify({ kind: 'augur-profile', schema: 1, balance: {}, routes: { slow: { model: 'acme/slow', adapter: 'codex-exec', options: {} } }, models: { acme: { 'acme/fast': { id: 'fast-1', rule: { dataTier: 'internal' } }, 'acme/slow': { id: 'slow-1', rule: { cost: 'cheap' } } } } }));
    const r = await runImport(t, ['import', 'p.json'], input => e.addProvider(input));
    expect(r.code).toBe(0);
    expect(r.out).toContain('1 model left as they are (acme/fast)');
    expect(r.out).toContain('1 new model');
    expect(e.state.config.policy?.providers.acme?.models['acme/fast']).toMatchObject({ status: 'confirmed', rule: { dataTier: 'public', cost: 'free' } });
    expect(e.state.config.policy?.providers.acme?.models['acme/slow']).toMatchObject({ id: 'slow-1', status: 'unreviewed', rule: { cost: 'cheap' } });
  });

  it('stops the whole import when a data tier or a weight is bad, and writes nothing', async () => {
    const t = setup();
    const calls: ProviderAddition[] = [];
    const add = async (input: ProviderAddition) => { calls.push(input); return { labels: {}, added: [] }; };
    t.write('p.json', JSON.stringify({ kind: 'augur-profile', schema: 1, balance: { profile: 'neutral' }, routes: { acme: { model: 'acme/fast', adapter: 'codex-exec', options: {} } }, models: { acme: { 'acme/fast': { id: 'fast-1', rule: { dataTier: 'secret' } } } } }));
    const tier = await runImport(t, ['import', 'p.json'], add);
    expect(tier.code).not.toBe(0);
    expect(tier.err).toContain('Nothing was changed');
    expect(tier.err).toContain('dataTier');
    expect(calls).toEqual([]);
    expect(t.inbox()).toEqual([]);
    expect(() => t.routes()).toThrow();
    t.write('w.json', JSON.stringify({ kind: 'augur-profile', schema: 1, routes: { acme: { model: 'acme/fast', adapter: 'codex-exec', options: {} } }, models: { acme: { 'acme/fast': { id: 'fast-1', rule: { activities: { write_code: 'huge' } } } } } }));
    const weight = await runImport(t, ['import', 'w.json'], add);
    expect(weight.err).toContain('Nothing was changed');
    expect(weight.err).toContain('activity');
    expect(calls).toEqual([]);
    expect(() => t.routes()).toThrow();
  });

  it('imports a file with no models exactly as before and does not ask the engine', async () => {
    const t = setup();
    const calls: unknown[] = [];
    t.write('p.json', JSON.stringify({ kind: 'augur-profile', schema: 1, balance: { profile: 'neutral' }, routes: { luna: { model: 'codex/luna', adapter: 'codex-exec', options: {} } } }));
    const r = await runImport(t, ['import', 'p.json'], async input => { calls.push(input); throw new Error('should not add'); });
    expect(r.code).toBe(0);
    expect(r.out).toContain('1 balance setting and 1 new route');
    expect(r.out).not.toContain('model');
    expect(calls).toEqual([]);
    expect(t.routes().routes.luna).toMatchObject({ model: 'codex/luna' });
  });

  it('lists new models on --dry-run and writes nothing', async () => {
    const t = setup();
    const calls: unknown[] = [];
    t.write('p.json', JSON.stringify({ kind: 'augur-profile', schema: 1, future: true, balance: {}, routes: {}, models: { zephyr: { 'zephyr/m': { id: 'm-1', rule: { dataTier: 'internal' } } } } }));
    const r = await runImport(t, ['import', 'p.json', '--dry-run'], async input => { calls.push(input); throw new Error('should not add'); });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Would apply');
    expect(r.out).toContain('1 new model');
    expect(r.out).toContain('Nothing was written');
    expect(calls).toEqual([]);
    expect(t.inbox()).toEqual([]);
    expect(() => t.routes()).toThrow();
  });

  it('still refuses a profile that carries a key, and writes nothing', async () => {
    const t = setup();
    const calls: unknown[] = [];
    t.write('p.json', JSON.stringify({ kind: 'augur-profile', schema: 1, routes: { d: { model: 'a/b', adapter: 'openai-api', options: { apiKey: 'sk-x' } } }, models: { acme: { 'acme/fast': { id: 'fast-1', rule: { dataTier: 'public' } } } } }));
    const r = await runImport(t, ['import', 'p.json'], async input => { calls.push(input); return { labels: {}, added: [] }; });
    expect(r.err).toContain('looks like a key');
    expect(r.err).toContain('Nothing was changed');
    expect(calls).toEqual([]);
    expect(() => t.routes()).toThrow();
  });

  it('writes nothing when policy.json cannot be read', async () => {
    const t = setup();
    writeFileSync(join(t.home, 'policy.json'), '{');
    t.write('p.json', JSON.stringify({ kind: 'augur-profile', schema: 1, routes: {}, models: { acme: { 'acme/fast': { id: 'fast-1', rule: {} } } } }));
    const r = await runImport(t, ['import', 'p.json'], async () => { throw new Error('should not add'); });
    expect(r.err).toContain('policy.json is not valid JSON');
    expect(() => t.routes()).toThrow();
  });

  it('omits models from an export that has none', async () => {
    const t = setup();
    expect((await t.run(['profile', 'export', 'out.json'])).code).toBe(0);
    expect(JSON.parse(readFileSync(join(t.dir, 'out.json'), 'utf8')).models).toBeUndefined();
  });
});
