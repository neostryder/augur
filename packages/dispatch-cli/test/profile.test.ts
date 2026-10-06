import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'augur-profile-')); dirs.push(dir);
  const home = join(dir, 'home');
  mkdirSync(join(home, 'dispatch'), { recursive: true });
  const env = { ...process.env, AUGUR_HOME: home, AUGURD_ROUTES: join(home, 'dispatch', 'routes.json') };
  const run = async (args: string[]) => {
    let out = '', err = '';
    const code = await main(args, { out: t => { out += t; }, err: t => { err += t; }, stdin: () => '', env, cwd: dir, interactive: false });
    return { code, out, err };
  };
  const inbox = () => { try { return readFileSync(join(home, 'policy-edits.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>); } catch { return []; } };
  const routes = () => JSON.parse(readFileSync(join(home, 'dispatch', 'routes.json'), 'utf8')) as { routes: Record<string, Record<string, unknown>> };
  return { dir, home, run, inbox, routes, write: (name: string, text: string) => writeFileSync(join(dir, name), text) };
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
