// The files in the user's home folder the engine may read and write, on the same terms as the window app: three login files, the Codex model
// list, the export file named in settings (a .json file), the rule, edit and alert files beside it, and the dispatch routes file under it.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, posix, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const LOGIN_FILES = ['.claude/.credentials.json', '.codex/auth.json', '.grok/auth.json', '.codex/models_cache.json'];
const BESIDE_EXPORT = ['policy.json', 'policy-import.json', 'policy-edits.jsonl', 'policy-edit-results.json', 'alerts.json', 'alerts-acks.jsonl'];

/** A path relative to home with forward slashes and only plain parts: no drive, no leading slash, no backslash, no `.` or `..`. */
export function homeRelative(path: string): string {
  const parts = path.split('/');
  if (!path || path.includes('\\') || path.includes(':') || path.startsWith('/') || parts.some(p => p === '' || p === '.' || p === '..')) throw new Error('Invalid home-relative path');
  return path;
}

/** The home-relative paths allowed for the export file named in settings, or only the login files when there is none. */
export function allowedPaths(exportPath: string | null | undefined): Set<string> {
  const allowed = new Set(LOGIN_FILES);
  let exp: string | null = null;
  try { exp = exportPath ? homeRelative(exportPath) : null; } catch { exp = null; }
  if (exp && exp.endsWith('.json')) {
    const dir = posix.dirname(exp), at = (n: string) => (dir === '.' ? n : `${dir}/${n}`);
    allowed.add(exp);
    for (const n of BESIDE_EXPORT) allowed.add(at(n));
    allowed.add(at('dispatch/routes.json'));
  }
  return allowed;
}

/** Whether `path` is home or inside it. */
const within = (home: string, path: string) => {
  const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const h = fold(normalize(home)).replace(/[\\/]+$/, ''), p = fold(normalize(path)).replace(/[\\/]+$/, '');
  return p === h || p.startsWith(h + sep);
};

/** Resolves an allowed home-relative path, refusing one whose folder or file is a link that leads out of home. */
export function resolveHomePath(home: string, path: string, exportPath: string | null | undefined): string {
  const rel = homeRelative(path);
  if (!allowedPaths(exportPath).has(rel)) throw new Error('Home file path is not allowed');
  const full = join(home, ...rel.split('/')), realHome = realpathSync(home);
  let existing = dirname(full);
  while (!existsSync(existing)) existing = dirname(existing);
  if (!within(realHome, realpathSync(existing))) throw new Error('Home file path escapes the home directory');
  if (existsSync(full) && !within(realHome, realpathSync(full))) throw new Error('Home file path escapes the home directory');
  return full;
}

export function readText(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}

/** Writes beside the target and renames over it, so a reader sees the old file or the new one and never half of one. */
export function atomicWrite(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.augur-${randomUUID()}.tmp`);
  writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
  // On Windows the rename fails while another program holds the target open for a moment, so it is tried a few times before giving up.
  for (let attempt = 0; ; attempt++) {
    try { renameSync(tmp, path); return; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) { try { rmSync(tmp, { force: true }); } catch { /* left for the next write */ } throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}
