import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { KeyStore } from '@augur/augurd';
import type { ProviderAdded, ProviderAddition } from '@augur/core';
import { providerCmd } from '../src/provider.js';
import type { ProviderFlags } from '../src/provider.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function setup(over: { added?: (i: ProviderAddition) => ProviderAdded } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'augur-provider-')); dirs.push(dir);
  const home = join(dir, 'home');
  mkdirSync(join(home, 'dispatch'), { recursive: true });
  const env = { ...process.env, AUGUR_HOME: home, AUGURD_ROUTES: join(home, 'dispatch', 'routes.json') };
  const secrets = new Map<string, string>(), engineKeys: string[][] = [], additions: ProviderAddition[] = [];
  const store = { kind: 'file', set: async (n: string, v: string) => { secrets.set(n, v); }, get: async (n: string) => secrets.get(n) ?? null, has: async (n: string) => secrets.has(n), delete: async (n: string) => { secrets.delete(n); } } as unknown as KeyStore;
  const deps = {
    addProvider: async (i: ProviderAddition) => { additions.push(i); return over.added ? over.added(i) : { labels: Object.fromEntries((i.models ?? []).map(m => [m.id, m.label])), added: (i.models ?? []).map(m => m.label) }; },
    setProviderKey: async (p: string, f: string, v: string) => { engineKeys.push([p, f, v]); },
  };
  const run = async (args: string[], flags: Partial<{ text: Record<string, string>; stdin: boolean; noKey: boolean; dryRun: boolean }> = {}, extra: { stdin?: string; interactive?: boolean; secret?: string; env?: Record<string, string> } = {}) => {
    let out = '', err = '';
    const f: ProviderFlags = { text: new Map(Object.entries(flags.text ?? {})), stdin: flags.stdin ?? false, noKey: flags.noKey ?? false, dryRun: flags.dryRun ?? false };
    const code = await providerCmd(args, f, { out: t => { out += t; }, err: t => { err += t; }, stdin: () => extra.stdin ?? '', env: { ...env, ...(extra.env ?? {}) }, cwd: dir, ...(extra.interactive ? { interactive: true, readSecret: async () => extra.secret ?? '' } : {}) },
      (human) => { out += `${human}\n`; }, deps, store);
    return { code, out, err };
  };
  const routes = () => JSON.parse(readFileSync(join(home, 'dispatch', 'routes.json'), 'utf8')) as { routes: Record<string, Record<string, unknown>> };
  return { dir, home, env, run, routes, secrets, engineKeys, additions };
}

describe('augur provider add', () => {
  it('adds the route and the model, stores the key from the prompt and names the next steps', async () => {
    const t = setup();
    const r = await t.run(['add', 'openai', 'gpt'], { text: { model: 'gpt-5' } }, { interactive: true, secret: 'sk-prompted' });
    expect(r.code).toBe(0);
    expect(t.additions).toEqual([{ provider: 'openai', name: 'OpenAI', models: [{ label: 'gpt-5', id: 'gpt-5' }] }]);
    expect(t.routes().routes.gpt).toMatchObject({ model: 'openai/gpt-5', adapter: 'openai-api', options: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', keySource: 'store' } });
    expect(t.secrets.get('dispatch.gpt')).toBe('sk-prompted');
    expect(r.out).toContain('A key of 11 characters is stored');
    expect(r.out).toContain('Open Model rules and set openai/gpt-5');
    expect(r.out).toContain('augur test gpt');
    expect(r.out + r.err).not.toContain('sk-prompted');
  });

  it('reads the key from an environment variable and sends a balance reading key through the engine', async () => {
    const t = setup();
    const r = await t.run(['add', 'openai-style', 'acme'], { text: { model: 'acme-1', provider: 'acme', 'base-url': 'https://api.acme.example/v1', 'balance-url': 'https://api.acme.example/v1/balance', 'balance-path': '$.balance', env: 'ACME_KEY' } }, { env: { ACME_KEY: 'sk-acme' } });
    expect(r.code).toBe(0);
    expect(t.additions[0]!.custom).toMatchObject({ id: 'acme', requests: { balance: { url: 'https://api.acme.example/v1/balance' } } });
    expect(t.secrets.get('dispatch.acme')).toBe('sk-acme');
    expect(t.engineKeys).toEqual([['acme', 'apiKey', 'sk-acme']]);
  });

  it('prints the key commands when no key can be read, and leaves the route in place', async () => {
    const t = setup();
    const r = await t.run(['add', 'openrouter', 'dsk'], { text: { model: 'deepseek/deepseek-v4' } });
    expect(r.code).toBe(0);
    expect(t.secrets.size).toBe(0);
    expect(r.out).toContain('augur key set dsk');
    expect(r.out).toContain('augur key set openrouter.apiKey');
    expect(t.additions[0]).toMatchObject({ provider: 'openrouter', enable: { settings: {} } });
    expect(t.routes().routes.dsk!.model).toBe('openrouter/deepseek/deepseek-v4');
  });

  it('points the route at the label a model already has in the rules', async () => {
    const t = setup({ added: () => ({ labels: { 'deepseek/deepseek-v4': 'DeepSeek-V4' }, added: [] }) });
    await t.run(['add', 'openrouter', 'dsk'], { text: { model: 'deepseek/deepseek-v4' } });
    expect(t.routes().routes.dsk!.model).toBe('openrouter/DeepSeek-V4');
  });

  it('turns the Jev provider on for a Jev-style service and adds no route', async () => {
    const t = setup();
    const r = await t.run(['add', 'jev-style'], { text: { 'base-url': 'https://jev.example.com' }, stdin: true }, { stdin: 'jev-key\n' });
    expect(r.code).toBe(0);
    expect(t.additions).toEqual([{ provider: 'jev', name: 'Jev', enable: { settings: { baseUrl: 'https://jev.example.com' } } }]);
    expect(t.engineKeys).toEqual([['jev', 'apiKey', 'jev-key']]);
    expect(() => t.routes()).toThrow();
  });

  it('writes nothing on --dry-run and nothing when a problem is found', async () => {
    const t = setup();
    const dry = await t.run(['add', 'anthropic', 'claude'], { text: { model: 'm' }, dryRun: true });
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('Would add');
    expect(t.additions).toEqual([]);
    const bad = await t.run(['add', 'openai', 'gpt'], { text: {} });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('--model needs the model id');
    expect(t.additions).toEqual([]);
    expect(() => t.routes()).toThrow();
  });

  it('changes nothing when the key cannot be read or the engine refuses', async () => {
    const t = setup();
    const noEnv = await t.run(['add', 'openai', 'gpt'], { text: { model: 'm', env: 'MISSING_KEY' } });
    expect(noEnv.code).toBe(1);
    expect(noEnv.err).toContain('MISSING_KEY is not set');
    expect(t.additions).toEqual([]);
    const refused = await providerCmd(['add', 'openai', 'gpt'], { text: new Map([['model', 'm']]), stdin: false, noKey: true, dryRun: false },
      { out: () => {}, err: () => {}, stdin: () => '', env: t.env, cwd: t.dir }, () => {},
      { addProvider: async () => { throw new Error('acme is a built-in provider'); }, setProviderKey: async () => {} });
    expect(refused).toBe(4);
    expect(() => t.routes()).toThrow();
  });

  it('keeps the routes already in the file and refuses a taken route name', async () => {
    const t = setup();
    writeFileSync(join(t.home, 'dispatch', 'routes.json'), JSON.stringify({ extra: 1, routes: { luna: { model: 'codex/luna', adapter: 'codex-exec', options: {} } } }));
    await t.run(['add', 'openai', 'gpt'], { text: { model: 'm' }, noKey: true });
    const file = t.routes() as unknown as Record<string, unknown> & { routes: Record<string, unknown> };
    expect(Object.keys(file.routes)).toEqual(['luna', 'gpt']);
    expect(file.extra).toBe(1);
    const again = await t.run(['add', 'openai', 'gpt'], { text: { model: 'm' }, noKey: true });
    expect(again.code).toBe(1);
    expect(again.err).toContain('already exists');
  });
});

describe('augur provider templates', () => {
  it('lists the presets and the shapes', async () => {
    const t = setup();
    const r = await t.run(['templates']);
    expect(r.code).toBe(0);
    for (const word of ['openai ', 'openrouter', 'anthropic', 'typesafe', 'openai-style', 'anthropic-style', 'jev-style']) expect(r.out).toContain(word);
    expect((await t.run(['nope'])).code).toBe(1);
  });
});
