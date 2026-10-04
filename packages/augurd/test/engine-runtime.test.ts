import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineApi, EngineKey } from '@augur/core';
import { addPluginDir, claudeInstall, claudeRemove, claudeStatus, hasPluginDir, readJson, removeMcp, removePluginDir, setMcp, type ClaudePaths } from '../src/claude-install.js';
import { call } from '../src/client.js';
import { watchEngine } from '../src/client.js';
import { desktopNotice, isPushService } from '../src/engine-shell.js';
import { allowedPaths, homeRelative, resolveHomePath } from '../src/home-files.js';
import { IpcServer } from '../src/ipc.js';
import { checkSecretName, createKeyStore, fileStore, runHelper } from '../src/keystore.js';
import { ViewHub } from '../src/views.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'augur-engine-')); cleanup.push(() => rmSync(d, { recursive: true, force: true })); return d; };

type Call = { command: string; args: string[]; input?: string };
const fakeRun = (answer: (c: Call) => { code: number; stdout?: string; stderr?: string }) => {
  const calls: Call[] = [];
  const run = (async (command: string, args: string[], input?: string) => {
    const c = { command, args, ...(input !== undefined ? { input } : {}) };
    calls.push(c);
    const a = answer(c);
    return { code: a.code, stdout: a.stdout ?? '', stderr: a.stderr ?? '' };
  }) as typeof runHelper;
  return { run, calls };
};

describe('the key store', () => {
  it('accepts only provider.field names, as the window app does', () => {
    expect(() => checkSecretName('openai.apiKey')).not.toThrow();
    expect(() => checkSecretName('dispatch.my_dgrok')).not.toThrow();
    for (const bad of ['openai', 'OpenAI.key', 'a.b.c', '../x.y', 'a.']) expect(() => checkSecretName(bad)).toThrow();
  });

  it('keeps the fallback file readable by its owner alone and removes entries cleanly', async () => {
    const dir = temp(), keys = fileStore(join(dir, 'k', 'secrets.json'));
    expect(await keys.get('openai.apiKey')).toBeNull();
    await keys.set('openai.apiKey', 'sk-1');
    await keys.set('xai.apiKey', 'xk-2');
    expect(await keys.get('openai.apiKey')).toBe('sk-1');
    expect(await keys.has('xai.apiKey')).toBe(true);
    await keys.delete('openai.apiKey');
    expect(await keys.has('openai.apiKey')).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'k', 'secrets.json'), 'utf8'))).toEqual({ 'xai.apiKey': 'xk-2' });
    if (process.platform !== 'win32') expect(statSync(join(dir, 'k', 'secrets.json')).mode & 0o777).toBe(0o600);
  });

  it('on Windows writes through credread with the value on standard input, never on the command line', async () => {
    const { run, calls } = fakeRun(c => (c.args[0] === 'missing.key.augur' ? { code: 1 } : { code: 0, stdout: 'v' }));
    const keys = createKeyStore({ platform: 'win32', dir: temp(), credread: 'C:/x/credread.exe', run });
    await keys.set('openai.apiKey', 'sk-secret');
    expect(calls[0]).toEqual({ command: 'C:/x/credread.exe', args: ['--set', 'openai.apiKey.augur'], input: 'sk-secret' });
    expect(await keys.get('openai.apiKey')).toBe('v');
    await keys.delete('openai.apiKey');
    expect(calls.at(-1)!.args).toEqual(['--delete', 'openai.apiKey.augur']);
    expect(calls.every(c => !c.args.some(a => a.includes('sk-secret')))).toBe(true);
  });

  it('on macOS saves through security -i so the key stays off the command line', async () => {
    const { run, calls } = fakeRun(c => (c.args[0] === 'find-generic-password' ? { code: 44 } : { code: 0 }));
    const keys = createKeyStore({ platform: 'darwin', dir: temp(), run });
    expect(await keys.get('openai.apiKey')).toBeNull();
    await keys.set('openai.apiKey', 'sk-"q"');
    expect(calls[1]!.args).toEqual(['-i']);
    expect(calls[1]!.input).toBe('add-generic-password -U -s augur -a "openai.apiKey" -w "sk-\\"q\\""\n');
  });

  it('on Linux uses the Secret Service when one answers, and the file when none does', async () => {
    const live = fakeRun(c => (c.args[0] === 'lookup' ? { code: 1 } : { code: 0 }));
    const withService = createKeyStore({ platform: 'linux', dir: temp(), run: live.run });
    await withService.set('openai.apiKey', 'sk-1');
    expect(live.calls.find(c => c.args[0] === 'store')).toMatchObject({ args: ['store', '--label=Augur openai.apiKey', 'service', 'augur', 'username', 'openai.apiKey'], input: 'sk-1' });

    const dead = fakeRun(() => ({ code: 1, stderr: 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY' }));
    const dir = temp(), noService = createKeyStore({ platform: 'linux', dir, run: dead.run });
    await noService.set('openai.apiKey', 'sk-2');
    expect(await noService.get('openai.apiKey')).toBe('sk-2');
    expect(dead.calls).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'))).toEqual({ 'openai.apiKey': 'sk-2' });
  });
});

describe('home files', () => {
  it('allows the login files, and the export file with its neighbours only when settings name one', () => {
    expect(allowedPaths(null)).toEqual(new Set(['.claude/.credentials.json', '.codex/auth.json', '.grok/auth.json', '.codex/models_cache.json']));
    const a = allowedPaths('.augur/usage.json');
    for (const p of ['.augur/usage.json', '.augur/policy.json', '.augur/alerts-acks.jsonl', '.augur/dispatch/routes.json']) expect(a.has(p)).toBe(true);
    expect(allowedPaths('.augur/usage.txt').has('.augur/usage.txt')).toBe(false);
  });

  it('refuses paths that climb, start at a root or use backslashes', () => {
    for (const bad of ['../x.json', '/etc/passwd', 'C:/x.json', '.augur\\usage.json', 'a//b.json', './a.json']) expect(() => homeRelative(bad)).toThrow();
    const home = temp();
    expect(() => resolveHomePath(home, '.ssh/id_rsa', '.augur/usage.json')).toThrow('not allowed');
    expect(resolveHomePath(home, '.augur/policy.json', '.augur/usage.json')).toBe(join(home, '.augur', 'policy.json'));
  });

  it('knows the push services a phone hands out and nothing else', () => {
    for (const ok of ['fcm.googleapis.com', 'web.push.apple.com', 'api.push.apple.com', 'updates.push.services.mozilla.com', 'wns2-by3p.notify.windows.com']) expect(isPushService(ok)).toBe(true);
    for (const bad of ['example.com', 'fcm.googleapis.com.evil.net', 'push.apple.com.evil.net']) expect(isPushService(bad)).toBe(false);
  });
});

describe('the desktop notice', () => {
  it('uses notify-send on Linux, with the text as separate arguments', async () => {
    const { run, calls } = fakeRun(() => ({ code: 0 }));
    await desktopNotice('Claude at 90%', 'Session "5h" is nearly used.', 'linux', run);
    expect(calls).toEqual([{ command: 'notify-send', args: ['--app-name=Augur', 'Claude at 90%', 'Session "5h" is nearly used.'] }]);
  });

  it('uses osascript on macOS with quotes and backslashes escaped, and does nothing on Windows', async () => {
    const { run, calls } = fakeRun(() => ({ code: 0 }));
    await desktopNotice('T "x"', 'a\\b', 'darwin', run);
    expect(calls[0]!.command).toBe('osascript');
    expect(calls[0]!.args[1]).toBe('display notification "a\\\\b" with title "T \\"x\\""');
    await desktopNotice('t', 'b', 'win32', run);
    expect(calls).toHaveLength(1);
  });
});

describe('the Claude installers', () => {
  const sep = process.platform === 'win32' ? ';' : ':';

  it('adds the plugin folder once and removes it with nothing else touched', () => {
    const p = process.platform;
    const settings: Record<string, unknown> = { model: 'opus', env: { OTHER: '1', CLAUDE_CODE_PLUGIN_DIRS: '/a' } };
    expect(addPluginDir(settings, '/m', p)).toBe(true);
    expect(addPluginDir(settings, '/m', p)).toBe(false);
    expect((settings.env as Record<string, string>).CLAUDE_CODE_PLUGIN_DIRS).toBe(`/a${sep}/m`);
    expect(hasPluginDir(settings, '/m', p)).toBe(true);
    expect(removePluginDir(settings, '/m', p)).toBe(true);
    expect(settings).toEqual({ model: 'opus', env: { OTHER: '1', CLAUDE_CODE_PLUGIN_DIRS: '/a' } });
    const bare: Record<string, unknown> = { z: 1, a: 2 };
    addPluginDir(bare, '/m', p);
    expect(JSON.stringify(bare).startsWith('{"z":1,"a":2,"env"')).toBe(true);
    removePluginDir(bare, '/m', p);
    expect(bare).toEqual({ z: 1, a: 2 });
  });

  it('removes only the MCP entry it added', () => {
    const config: Record<string, unknown> = { mcpServers: { other: { command: 'x' } } };
    expect(setMcp(config, '/s/augur-mcp')).toBe(true);
    expect(setMcp(config, '/s/augur-mcp')).toBe(false);
    expect(removeMcp(config, '/s/augur-mcp', process.platform)).toBe(true);
    expect(config).toEqual({ mcpServers: { other: { command: 'x' } } });
    expect(removeMcp({ mcpServers: { augur: { command: 'mine' } } }, '/s/augur-mcp', process.platform)).toBe(false);
  });

  it('leaves a settings file that does not parse alone', () => {
    const dir = temp();
    writeFileSync(join(dir, 'settings.json'), '{ not json');
    expect(() => readJson(join(dir, 'settings.json'))).toThrow('left it alone');
    expect(readJson(join(dir, 'missing.json'))).toEqual({});
  });

  it('installs the mod and the MCP entry into a home folder and takes both out again', () => {
    const home = temp(), mod = join(home, 'bundle', 'claude-mod');
    mkdirSync(join(mod, '.claude-plugin'), { recursive: true });
    writeFileSync(join(mod, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'augur', version: '1.4.0' }));
    const paths: ClaudePaths = { home, bundledMod: mod, mcpCommand: join(home, 'bundle', 'augur-mcp'), appExe: '', platform: process.platform, env: { APPDATA: join(home, 'roaming'), XDG_CONFIG_HOME: join(home, 'cfg') } };
    expect(claudeStatus(paths)).toEqual({ code: null, bundled: '1.4.0', desktop: false, desktopPossible: true });
    claudeInstall(paths, 'code', '.augur/usage.json');
    claudeInstall(paths, 'desktop', '.augur/usage.json');
    expect(claudeStatus(paths)).toEqual({ code: '1.4.0', bundled: '1.4.0', desktop: true, desktopPossible: true });
    expect(JSON.parse(readFileSync(join(home, '.augur', 'claude-mod', 'augur-app.json'), 'utf8'))).toEqual({ usageFile: join(home, '.augur', 'usage.json'), exe: '' });
    claudeRemove(paths, 'code');
    claudeRemove(paths, 'desktop');
    expect(claudeStatus(paths)).toEqual({ code: null, bundled: '1.4.0', desktop: false, desktopPossible: true });
    expect(readJson(join(home, '.claude', 'settings.json'))).toEqual({});
  });
});

describe('the engine on the control endpoint', () => {
  function fakeEngine() {
    const listeners = new Set<(keys: EngineKey[]) => void>();
    const state = { busy: false, secrets: ['openai.apiKey'], firstRun: false } as unknown as EngineApi['state'];
    const calls: unknown[][] = [];
    const engine = {
      state,
      onChange(fn: (keys: EngineKey[]) => void) { listeners.add(fn); return () => listeners.delete(fn); },
      async refresh(...args: unknown[]) { calls.push(['refresh', ...args]); (state as { busy: boolean }).busy = true; for (const fn of listeners) fn(['busy']); return null; },
    } as unknown as EngineApi;
    return { engine, calls, listeners };
  }

  async function serve(withEngine = true) {
    const dir = temp(), token = 'k'.repeat(64);
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\augur-engine-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}` : join(dir, 's.sock');
    const server = new IpcServer({} as never, {} as never, token, () => null);
    const views = new ViewHub(), fake = fakeEngine();
    if (withEngine) server.attachEngine({ api: fake.engine, views });
    await server.start(pipe);
    cleanup.push(() => server.close());
    return { o: { pipe, token }, views, ...fake };
  }

  it('refuses engine methods while no engine is attached', async () => {
    const { o } = await serve(false);
    await expect(call('engine_state', undefined, o)).rejects.toMatchObject({ message: 'The usage engine is not running in this service.' });
  });

  it('serves state, runs commands and refuses names that are not commands', async () => {
    const { o, calls } = await serve();
    expect((await call('engine_state', { keys: ['secrets'] }, o)).state).toEqual({ secrets: ['openai.apiKey'] });
    await call('engine_call', { method: 'refresh', args: [true] }, o);
    expect(calls).toEqual([['refresh', true]]);
    await expect(call('engine_call', { method: 'start', args: [] }, o)).rejects.toMatchObject({ message: 'Unknown engine command: start' });
  });

  it('streams changes to a watching view and carries the engine\'s requests to it', async () => {
    const { o, views } = await serve();
    const changes: unknown[] = [];
    const watch = await watchEngine({ kind: 'window', caps: ['notify'] }, {
      change: (keys, state) => changes.push({ keys, state }),
      request: async (method, params) => ({ method, params }),
    }, o);
    expect(watch.state).toMatchObject({ secrets: ['openai.apiKey'] });
    expect(views.info()).toEqual([{ kind: 'window', caps: ['notify'] }]);
    await call('engine_call', { method: 'refresh', args: [] }, o);
    await expect(views.request('notify', 'notify', { title: 't', body: 'b' })).resolves.toEqual({ method: 'notify', params: { title: 't', body: 'b' } });
    expect(changes).toEqual([{ keys: ['busy'], state: { busy: true } }]);
    await expect(views.request('websession', 'webSession', {})).rejects.toThrow('No connected view can websession');
    watch.close();
    for (let i = 0; i < 50 && views.list().length; i++) await new Promise(r => setTimeout(r, 20));
    expect(views.list()).toEqual([]);
  });
});

describe('the service with the engine switched on', () => {
  it('starts the engine on a fresh settings folder and waits for setup before reading anything', async () => {
    const { makeEnv } = await import('./harness.js');
    const { startService } = await import('../src/main.js');
    const e = makeEnv(), appDir = temp();
    const saved = { app: process.env.AUGUR_APP_DIR, keys: process.env.AUGUR_KEYSTORE };
    process.env.AUGUR_APP_DIR = appDir; process.env.AUGUR_KEYSTORE = 'file';
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\augurd-engine-${Date.now()}-${Math.floor(Math.random() * 1e6)}` : join(e.root, 'e.sock');
    const svc = await startService({ dir: e.dir, home: e.home, pipe, routesPath: e.routesPath, engine: true });
    cleanup.push(async () => {
      await svc.stop().catch(() => {}); e.dispose();
      if (saved.app === undefined) delete process.env.AUGUR_APP_DIR; else process.env.AUGUR_APP_DIR = saved.app;
      if (saved.keys === undefined) delete process.env.AUGUR_KEYSTORE; else process.env.AUGUR_KEYSTORE = saved.keys;
    });
    expect(svc.engine).not.toBeNull();
    const o = { dir: e.dir, pipe };
    expect((await call('engine_state', { keys: ['firstRun', 'snapshot'] }, o)).state).toEqual({ firstRun: true, snapshot: null });
    await call('engine_call', { method: 'setProviderKey', args: ['minimax', 'apiKey', '  sk-test  '] }, o);
    expect(JSON.parse(readFileSync(join(appDir, 'secrets.json'), 'utf8'))).toEqual({ 'minimax.apiKey': 'sk-test' });
    expect((await call('engine_state', { keys: ['secrets'] }, o)).state.secrets).toContain('minimax.apiKey');
    const { request } = await import('./harness.js');
    expect(await call('submit', request({ text: 'SLEEP 0' }), o)).toMatchObject({ rejected: { code: 'jobs_off' } });
  });
});
