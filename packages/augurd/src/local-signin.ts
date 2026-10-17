// Sign-in flows that live on one computer only. The service looks for `local-signin.mjs` in the Augur home folder (`~/.augur`, or AUGUR_HOME), which
// no Augur download includes and an update never replaces. The file exports `signInFlows`, an object that maps a provider id to a sign-in flow.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerSignInFlow, type SignInFlow } from '@augur/core';

export const LOCAL_SIGNIN_FILE = 'local-signin.mjs';

/** Registers the flows in the local file. Returns the provider ids it added and, when something was refused, why. One refused flow does not stop the others. */
export async function loadLocalSignIn(home: string): Promise<{ added: string[]; error: string | null }> {
  const file = join(home, LOCAL_SIGNIN_FILE);
  if (!existsSync(file)) return { added: [], error: null };
  try {
    const mod = await import(pathToFileURL(file).href) as { signInFlows?: Record<string, SignInFlow> };
    const added: string[] = [], problems: string[] = [];
    for (const [provider, flow] of Object.entries(mod.signInFlows ?? {})) {
      if (!flow || typeof flow.begin !== 'function' || typeof flow.complete !== 'function' || typeof flow.renew !== 'function') { problems.push(`${provider} is not a flow with begin, complete, and renew`); continue; }
      try { registerSignInFlow(provider, flow); added.push(provider); } catch (e) { problems.push(e instanceof Error ? e.message : String(e)); }
    }
    return { added, error: problems.length ? problems.join('; ') : null };
  } catch (e) { return { added: [], error: e instanceof Error ? e.message : String(e) }; }
}
