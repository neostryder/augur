// Terms that mark text as student or customer data, read from `private-terms.json` in the Augur folder (`{ "terms": ["..."] }`).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const privateTermsPath = (env: NodeJS.ProcessEnv = process.env): string => join(env.AUGUR_HOME ?? join(homedir(), '.augur'), 'private-terms.json');

let seen: { path: string; stamp: string; terms: string[] } | null = null;

/** The terms in `private-terms.json` (`{ "terms": ["..."] }`), re-read when the file changes. A missing or broken file yields none. */
export function privateTerms(env: NodeJS.ProcessEnv = process.env): string[] {
  const path = privateTermsPath(env);
  let stamp = '';
  try { if (existsSync(path)) { const st = statSync(path); stamp = `${st.mtimeMs}:${st.size}`; } } catch { return seen?.path === path ? seen.terms : []; }
  if (seen && seen.path === path && seen.stamp === stamp) return seen.terms;
  let terms: string[] = [];
  if (stamp) {
    try {
      const j = JSON.parse(readFileSync(path, 'utf8')) as { terms?: unknown };
      if (Array.isArray(j.terms)) terms = j.terms.filter((t): t is string => typeof t === 'string' && t.trim().length > 0 && t.length <= 64);
    } catch { /* a broken file adds no terms */ }
  }
  seen = { path, stamp, terms };
  return terms;
}
