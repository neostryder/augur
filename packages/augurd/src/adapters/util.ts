import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

export function readTextIfExists(path: string): string | null { try { return readFileSync(path, 'utf8'); } catch { return null; } }

type Options = Record<string, string | number | boolean> | undefined;
export const optStr = (o: Options, k: string): string | undefined => typeof o?.[k] === 'string' ? o[k] as string : undefined;
export const optNum = (o: Options, k: string): number | undefined => typeof o?.[k] === 'number' ? o[k] as number : undefined;

/** The longest command line Windows accepts is 32767 characters. The supervisor rejects a plan above this before launch. */
export const MAX_COMMAND_LINE = 30000;

/** `C:\a\b` becomes `/c/a/b`, the path a Docker Sandboxes workspace has inside the sandbox. */
export function insideSandbox(hostPath: string): string {
  const p = hostPath.replace(/\\/g, '/');
  return /^[A-Za-z]:/.test(p) ? `/${p[0]!.toLowerCase()}${p.slice(2)}` : p;
}

export interface Resolved { command: string; prefix: string[] }

/**
 * Finds a command on PATH without ever putting it behind cmd.exe, which would re-parse a prompt carried in an argument.
 * A `.exe` runs as is. An npm `.cmd` shim is replaced by node running the script the shim points to, and a `.bat` that only forwards to an `.exe` by that `.exe`.
 */
export function resolveExecutable(name: string, env: NodeJS.ProcessEnv = process.env): Resolved | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) for (const ext of exts) {
    const file = join(dir, name + ext);
    if (!existsSync(file)) continue;
    if (/\.exe$/i.test(file) || ext === '') return { command: file, prefix: [] };
    const text = readTextIfExists(file) ?? '';
    const npm = /"%_prog%"\s+"%dp0%\\([^"]+)"/.exec(text);
    if (npm) return { command: process.execPath, prefix: [join(dirname(file), npm[1] as string)] };
    const bat = /^"([^"]+\.exe)"\s+%\*/im.exec(text);
    if (bat && existsSync(bat[1] as string)) return { command: bat[1] as string, prefix: [] };
  }
  return null;
}
