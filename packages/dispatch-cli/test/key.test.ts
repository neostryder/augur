import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { routeSecretName } from '@augur/dispatch-protocol';
import { main } from '../src/cli.js';
import { secretNameFor } from '../src/key.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'augur-key-')); dirs.push(dir);
  const env = { ...process.env, AUGUR_APP_DIR: dir, AUGUR_KEYSTORE: 'file', MY_KEY: '  sk-test-1234567890  ' };
  const run = async (args: string[], extra: { stdin?: string; secret?: string } = {}) => {
    let out = '', err = '';
    const code = await main(args, { out: t => { out += t; }, err: t => { err += t; }, stdin: () => extra.stdin ?? '', env, cwd: dir, interactive: extra.secret !== undefined, ...(extra.secret !== undefined ? { readSecret: async () => extra.secret as string } : {}) });
    return { code, out, err };
  };
  return { dir, run, file: () => JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')) as Record<string, string> };
}

describe('augur key', () => {
  it('stores the key from an environment variable under the route\'s secret name, trimmed, and never prints it', async () => {
    const { run, file } = setup();
    const r = await run(['key', 'set', 'my-route', '--env', 'MY_KEY']);
    expect(r.code).toBe(0);
    expect(file()[routeSecretName('my-route')]).toBe('sk-test-1234567890');
    expect(r.out).toContain('a key of 18 characters');
    expect(r.out + r.err).not.toContain('sk-test');
  });

  it('stores the key typed at a hidden prompt, or piped on standard input', async () => {
    const { run, file } = setup();
    expect((await run(['key', 'set', 'prompted'], { secret: 'typed-key' })).code).toBe(0);
    expect((await run(['key', 'set', 'piped', '--stdin'], { stdin: 'piped-key\n' })).code).toBe(0);
    expect(file()[routeSecretName('prompted')]).toBe('typed-key');
    expect(file()[routeSecretName('piped')]).toBe('piped-key');
  });

  it('refuses a key given on the command line, and says how to give it', async () => {
    const { run } = setup();
    const r = await run(['key', 'set', 'my-route', 'sk-on-the-command-line']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/never given on the command line/);
    expect(r.err + r.out).not.toContain('sk-on-the-command-line');
  });

  it('refuses when there is no terminal, no variable and no piped input to take the key from', async () => {
    const { run } = setup();
    expect((await run(['key', 'set', 'my-route'])).code).toBe(1);
    expect((await run(['key', 'set', 'my-route', '--env', 'NOT_SET_ANYWHERE'])).err).toMatch(/not set here/);
    expect((await run(['key', 'set', 'my-route', '--stdin'], { stdin: '  \n' })).err).toMatch(/empty/);
    expect((await run(['key', 'set', 'my-route', '--stdin'], { stdin: 'a\nb' })).err).toMatch(/one line/);
  });

  it('reports whether a key is stored with the exit code, and removes it', async () => {
    const { run } = setup();
    expect((await run(['key', 'status', 'my-route'])).code).toBe(2);
    await run(['key', 'set', 'my-route', '--env', 'MY_KEY']);
    const has = await run(['key', 'status', 'my-route', '--json']);
    expect(has.code).toBe(0);
    expect(JSON.parse(has.out)).toMatchObject({ stored: true });
    expect(has.out).not.toContain('sk-test');
    expect((await run(['key', 'remove', 'my-route'])).code).toBe(0);
    expect((await run(['key', 'status', 'my-route'])).code).toBe(2);
  });

  it('takes a provider.field name as it stands, and rejects a name that is neither', async () => {
    expect(secretNameFor('openrouter.apiKey')).toBe('openrouter.apiKey');
    expect(secretNameFor('deepseek')).toBe(routeSecretName('deepseek'));
    expect(() => secretNameFor('Not A Route')).toThrow(/not a route name/);
    expect(() => secretNameFor('bad name.field')).toThrow(/Invalid secret name/);
    const { run } = setup();
    expect((await run(['key', 'set', 'Not A Route', '--stdin'], { stdin: 'x' })).code).toBe(1);
  });
});
