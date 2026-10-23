// Reads an API key for a script the service starts as its own process: from an environment variable, or from the key store (the Windows credential
// store, the macOS keychain, the Secret Service, or the user-only file). The value goes to the caller and nowhere else; the service itself never reads it.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface KeySource { keyEnv?: string; keyName?: string; keyFile?: string; fileOnly?: boolean; fallbackKeyName?: string }

const read = (command: string, argv: string[]): string | null => {
  try { return execFileSync(command, argv, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }); } catch { return null; }
};

function fromFile(keyFile: string | undefined, name: string): string | null {
  if (!keyFile || !existsSync(keyFile)) return null;
  try { const v = (JSON.parse(readFileSync(keyFile, 'utf8')) as Record<string, unknown>)[name]; return typeof v === 'string' && v ? v : null; } catch { return null; }
}

/** The credential reader sits beside this file in an install, and in native/bin in the source tree. */
function storedKey(name: string, keyFile: string | undefined, fileOnly: boolean): string | null {
  if (fileOnly) return fromFile(keyFile, name);
  if (process.platform === 'win32') {
    const here = dirname(fileURLToPath(import.meta.url));
    const helper = [join(here, 'credread.exe'), join(here, '..', '..', 'native', 'bin', 'credread.exe'), join(here, '..', 'native', 'bin', 'credread.exe')].find(existsSync);
    return helper ? read(helper, [`${name}.augur`]) : null;
  }
  if (process.platform === 'darwin') return read('security', ['find-generic-password', '-s', 'augur', '-a', name, '-w'])?.replace(/\n$/, '') || null;
  return read('secret-tool', ['lookup', 'service', 'augur', 'username', name]) || fromFile(keyFile, name);
}

/** The key, or null when none is there. */
export function resolveApiKey(s: KeySource, env: NodeJS.ProcessEnv = process.env): string | null {
  const own = s.keyName ? storedKey(s.keyName, s.keyFile, s.fileOnly === true) : s.keyEnv ? env[s.keyEnv] || null : null;
  return own || (s.fallbackKeyName ? storedKey(s.fallbackKeyName, s.keyFile, s.fileOnly === true) : null);
}

/** The standard message when no key was found, for the script to print and exit with. */
export const missingKeyMessage = (s: KeySource): string => `Key ${s.keyName ?? s.keyEnv} is not set. Add it to the route or the environment.${s.fallbackKeyName ? ` A Claude API route can also use the provider key ${s.fallbackKeyName} saved in Settings.` : ''}`;
