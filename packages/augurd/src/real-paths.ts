// Path containment judged on the real location of a file, so a link inside an allowed folder cannot lead out of it.
import { realpathSync } from 'node:fs';
import { normalize, resolve, sep } from 'node:path';

const fold = (s: string): string => (process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s);
const trim = (s: string): string => s.replace(/[\/]+$/, '');

/** The real path of something that exists, or null. */
export function realOf(path: string): string | null {
  try { return realpathSync.native(resolve(path)); } catch { return null; }
}

/** Whether `child` is `root` or inside it, comparing real paths. A path or root that does not exist is not inside anything. */
export function realInside(child: string, root: string): boolean {
  const c = realOf(child), r = realOf(root);
  if (c === null || r === null) return false;
  const a = trim(fold(normalize(c))), b = trim(fold(normalize(r)));
  return a === b || a.startsWith(b + sep);
}

/** Whether `child` is inside any of the roots. */
export function realInsideAny(child: string, roots: readonly string[]): boolean {
  return roots.some(r => realInside(child, r));
}
