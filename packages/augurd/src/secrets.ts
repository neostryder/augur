// Asks the key store whether a route's key is there, without ever reading the value into the service. The API caller reads the value itself when
// a job starts. The entries are the ones the window app and the engine write: see keystore.ts.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialTarget } from '@augur/dispatch-protocol';
import { appDirs } from './paths.js';

/** The credential reader: beside the service in an install, in native/bin in the source tree. Null off Windows or when it was not built. */
export function credreadPath(): string | null {
  if (process.platform !== 'win32') return null;
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, 'credread.exe'), join(here, '..', 'native', 'bin', 'credread.exe')].find(existsSync) ?? null;
}

/** The fallback key file on a computer with no keychain service. */
export const keyFilePath = (env: NodeJS.ProcessEnv = process.env) => join(appDirs(env).config, 'secrets.json');
export const keyFileOnly = (env: NodeJS.ProcessEnv = process.env) => env.AUGUR_KEYSTORE === 'file';

function inKeyFile(name: string, path = keyFilePath()): boolean {
  try { const v = (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)[name]; return typeof v === 'string' && v !== ''; } catch { return false; }
}

/** Runs a check whose exit code is the answer. Its output is thrown away, so a helper that prints the value never hands it to the service. */
const succeeds = (command: string, args: string[]) => { try { execFileSync(command, args, { windowsHide: true, stdio: 'ignore', timeout: 10000 }); return true; } catch { return false; } };

/** Whether a key is stored under `name` (a secret name such as `dispatch.my_dgrok`). */
export function hasStoredKey(name: string, helper = credreadPath()): boolean {
  if (keyFileOnly()) return inKeyFile(name);
  if (process.platform === 'win32') return !!helper && succeeds(helper, ['--exists', credentialTarget(name)]);
  if (process.platform === 'darwin') return succeeds('security', ['find-generic-password', '-s', 'augur', '-a', name]);
  return succeeds('secret-tool', ['lookup', 'service', 'augur', 'username', name]) || inKeyFile(name);
}
