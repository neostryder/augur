// Asks the Windows credential store whether a route's key is there, without ever reading the value. The API caller reads the value itself when a job starts.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The credential reader: beside the service in an install, in native/bin in the source tree. Null off Windows or when it was not built. */
export function credreadPath(): string | null {
  if (process.platform !== 'win32') return null;
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, 'credread.exe'), join(here, '..', 'native', 'bin', 'credread.exe')].find(existsSync) ?? null;
}

export function hasStoredKey(target: string, helper = credreadPath()): boolean {
  if (!helper) return false;
  try { execFileSync(helper, ['--exists', target], { windowsHide: true, stdio: 'ignore' }); return true; } catch { return false; }
}
