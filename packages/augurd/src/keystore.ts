// Where the engine keeps provider keys: the same key store entries the window app's keyring uses, so either one reads what the other saved.
// Windows: generic credential `<name>.augur`, through credread. macOS: keychain item with service "augur" and the name as its account.
// Linux: a Secret Service item with service=augur and username=<name>, through secret-tool. With no Secret Service running (a bare window
// manager with no keyring daemon), a file only this user can read, in the engine's settings folder.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { credentialTarget } from '@augur/dispatch-protocol';
import { credreadPath } from './secrets.js';

export type KeyStoreKind = 'windows' | 'keychain' | 'secret-service' | 'file';

export interface KeyStore {
  readonly kind: KeyStoreKind;
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  has(name: string): Promise<boolean>;
}

const SERVICE = 'augur';

/** The names the window app accepts too: `provider.field`, lower-case provider, a plain field. */
export function checkSecretName(name: string): void {
  if (!/^[a-z0-9_-]+\.[A-Za-z0-9_]+$/.test(name)) throw new Error('Invalid secret name');
}

interface Ran { code: number; stdout: string; stderr: string }

/** Runs a helper with no window and no shell, passing `input` on standard input so a value never shows on a command line. */
export function runHelper(command: string, args: string[], input?: string, timeoutMs = 15000): Promise<Ran> {
  return new Promise(resolve => {
    let stdout = '', stderr = '', done = false;
    const finish = (r: Ran) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let child: ReturnType<typeof spawn>;
    try { child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { finish({ code: -1, stdout: '', stderr: (e as Error).message }); return; }
    const timer = setTimeout(() => { child.kill(); finish({ code: -1, stdout, stderr: 'timed out' }); }, timeoutMs);
    child.stdout?.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
    child.stderr?.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
    child.on('error', e => finish({ code: -1, stdout, stderr: e.message }));
    child.on('close', code => finish({ code: code ?? -1, stdout, stderr }));
    child.stdin?.on('error', () => { /* a helper that exits before reading */ });
    child.stdin?.end(input ?? '');
  });
}

export interface KeyStoreOptions {
  platform?: NodeJS.Platform;
  /** Folder for the fallback file. */
  dir: string;
  /** Forces one store; AUGUR_KEYSTORE=file does the same from the environment. */
  kind?: KeyStoreKind;
  credread?: string | null;
  run?: typeof runHelper;
}

export function createKeyStore(opts: KeyStoreOptions): KeyStore {
  const platform = opts.platform ?? process.platform, run = opts.run ?? runHelper;
  const forced = opts.kind ?? (process.env.AUGUR_KEYSTORE === 'file' ? 'file' : undefined);
  if (forced === 'file') return fileStore(join(opts.dir, 'secrets.json'));
  if (platform === 'win32') return windowsStore(opts.credread === undefined ? credreadPath() : opts.credread, run);
  if (platform === 'darwin') return keychainStore(run);
  return linuxStore(run, fileStore(join(opts.dir, 'secrets.json')));
}

function windowsStore(helper: string | null, run: typeof runHelper): KeyStore {
  const need = () => { if (!helper) throw new Error('The credential helper (credread.exe) is missing from this install'); return helper; };
  return {
    kind: 'windows',
    async get(name) {
      checkSecretName(name);
      const r = await run(need(), [credentialTarget(name)]);
      if (r.code === 1) return null;
      if (r.code !== 0) throw new Error('The Windows credential store could not be read');
      return r.stdout || null;
    },
    async set(name, value) {
      checkSecretName(name);
      if ((await run(need(), ['--set', credentialTarget(name)], value)).code !== 0) throw new Error('The key could not be saved in the Windows credential store');
    },
    async delete(name) {
      checkSecretName(name);
      if ((await run(need(), ['--delete', credentialTarget(name)])).code !== 0) throw new Error('The key could not be removed from the Windows credential store');
    },
    async has(name) { checkSecretName(name); return helper ? (await run(helper, ['--exists', credentialTarget(name)])).code === 0 : false; },
  };
}

/** Quotes one word for `security -i`, which reads commands from standard input and splits them the way a shell would. */
const securityWord = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function keychainStore(run: typeof runHelper): KeyStore {
  return {
    kind: 'keychain',
    async get(name) {
      checkSecretName(name);
      const r = await run('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w']);
      if (r.code === 44) return null; // errSecItemNotFound
      if (r.code !== 0) throw new Error('The macOS keychain could not be read');
      return r.stdout.replace(/\n$/, '') || null;
    },
    async set(name, value) {
      checkSecretName(name);
      if (/[\r\n]/.test(value)) throw new Error('A key cannot span lines');
      const line = `add-generic-password -U -s ${SERVICE} -a ${securityWord(name)} -w ${securityWord(value)}\n`;
      const r = await run('security', ['-i'], line);
      if (r.code !== 0 || /error|SecKeychain/i.test(r.stderr)) throw new Error('The key could not be saved in the macOS keychain');
    },
    async delete(name) {
      checkSecretName(name);
      const r = await run('security', ['delete-generic-password', '-s', SERVICE, '-a', name]);
      if (r.code !== 0 && r.code !== 44) throw new Error('The key could not be removed from the macOS keychain');
    },
    async has(name) {
      checkSecretName(name);
      return (await run('security', ['find-generic-password', '-s', SERVICE, '-a', name])).code === 0;
    },
  };
}

/**
 * secret-tool talks to whatever Secret Service is running (GNOME Keyring, KeePassXC, KWallet's bridge). When none answers, it prints an error and
 * exits 1, the same code as "not found" with nothing printed, so the first call tells the two apart and later calls use the file instead.
 */
function linuxStore(run: typeof runHelper, file: KeyStore): KeyStore {
  let usable: Promise<boolean> | null = null;
  const probe = () => usable ??= run('secret-tool', ['lookup', 'service', SERVICE, 'username', 'augur.probe']).then(r => r.code === 0 || (r.code === 1 && r.stderr.trim() === ''));
  const attrs = (name: string) => ['service', SERVICE, 'username', name];
  const store: KeyStore = {
    get kind(): KeyStoreKind { return 'secret-service'; },
    async get(name) {
      checkSecretName(name);
      if (!(await probe())) return file.get(name);
      const r = await run('secret-tool', ['lookup', ...attrs(name)]);
      if (r.code === 0) return r.stdout || null;
      return file.get(name);
    },
    async set(name, value) {
      checkSecretName(name);
      if (!(await probe())) return file.set(name, value);
      const r = await run('secret-tool', ['store', `--label=Augur ${name}`, ...attrs(name)], value);
      if (r.code !== 0) throw new Error('The key could not be saved in the Secret Service');
      await file.delete(name);
    },
    async delete(name) {
      checkSecretName(name);
      if (await probe()) await run('secret-tool', ['clear', ...attrs(name)]);
      await file.delete(name);
    },
    async has(name) { return (await store.get(name)) !== null; },
  };
  return store;
}

/** The fallback: one JSON file, mode 0600 in a 0700 folder, replaced whole on each change. */
export function fileStore(path: string): KeyStore {
  const read = (): Record<string, string> => {
    if (!existsSync(path)) return {};
    try { const v = JSON.parse(readFileSync(path, 'utf8')) as unknown; return v && typeof v === 'object' ? v as Record<string, string> : {}; } catch { return {}; }
  };
  const write = (values: Record<string, string>) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(values, null, 2) + '\n', { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* Windows uses the folder's ACL */ }
    renameSync(tmp, path);
  };
  return {
    kind: 'file',
    async get(name) { checkSecretName(name); const v = read()[name]; return typeof v === 'string' && v ? v : null; },
    async set(name, value) { checkSecretName(name); write({ ...read(), [name]: value }); },
    async delete(name) { checkSecretName(name); const all = read(); if (name in all) { delete all[name]; write(all); } },
    async has(name) { checkSecretName(name); return typeof read()[name] === 'string'; },
  };
}
